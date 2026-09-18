/**
 * 茶绘 · PSD 导入回归（和导出做**回环**：导出的字节再读回来，画面必须一模一样）
 *
 * 为什么走回环：PSD 是二进制格式，光断言「文件有几十 KB」等于没测；
 * 而「导入」这件事唯一的验收标准是**画面回来了**。把导出器写出去的字节
 * 原样喂给导入器，再用 tools/psd-lite.js 在 Node 端把通道拆开看一遍，
 * 就把「写错长度字段」和「读错位置」这两类最隐蔽的毛病同时盖住了。
 *
 * 覆盖：
 *   1. 造一份有蒙版、有剪贴、有图层组的文档
 *   2. 导出：Node 端拆字节，确认蒙版通道（-2）与剪贴位真的写出去了
 *          —— 这两个正是以前恒写 0 / 完全不写的两个字段
 *   3. 读回：ChaPsdRead 把字节读成伪工程，逐项对结构（层序 / 名字 / 混合 / 浓度 /
 *          剪贴 / 蒙版 / 组）
 *   4. 装载：走真实的 openProjectDoc（新建房间承载），比对引擎里的状态，
 *          并把合成图**逐点**和导入前对
 *   5. 坏输入：非 PSD / 空文件 / 截断的字节，报错必须是人话
 *
 * 用法: node tools/test-psd-import.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const psdLite = require('./psd-lite');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8437';

/** 造文档：直接往图层的画布上填色（PSD 编码器读的就是 engine 里这份状态） */
const BUILD_DOC = `(() => {
  const e = window.ChaApp.engine;
  const W = e.width, H = e.height;
  e.layers.length = 0;
  e.setGroups([]);

  function mk(name, groupId) {
    const l = e.addLayerMeta({ id: 'P' + Math.random().toString(36).slice(2, 10), name: name });
    l.groupId = groupId || null;
    l.strokes = []; l.baseImage = null;
    l.opacity = 1; l.blend = 'normal'; l.visible = true;
    return l;
  }
  function fill(l, x0, y0, x1, y1, rgba) {
    const c = l.ctx;
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.filter = 'none';
    c.fillStyle = 'rgba(' + rgba.join(',') + ')';
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.restore();
    l.dirty = true;
  }

  // 1) 底图：左半边红，但**加一张蒙版挖掉中间一条**
  const A = mk('底 图', null);
  fill(A, 0, 0, Math.floor(W / 2), H, [230, 60, 60, 255]);
  A.hasMask = true;
  e.ensureMask(A);
  const mc = A.maskCtx;
  mc.setTransform(1, 0, 0, 1, 0, 0);
  mc.globalCompositeOperation = 'source-over';
  mc.fillStyle = '#ffffff'; mc.fillRect(0, 0, W, H);
  // 蒙版用 **alpha** 表示「显示多少」：遮住 = 把 alpha 抹掉，而不是涂一层黑色。
  // （在蒙版上落笔时「黑笔遮住」是笔迹通道替我们做的 destination-out；
  //   这里直接往蒙版画布上填，就得自己用对合成模式 —— 涂黑只会得到一张不透明的黑，
  //   而「不透明」在这个语义下正好等于「全显示」。）
  mc.globalCompositeOperation = 'destination-out';
  mc.fillRect(0, Math.floor(H * 0.4), W, Math.floor(H * 0.1));
  mc.globalCompositeOperation = 'source-over';

  // 2) 方块：完整一块绿，没有任何蒙版 —— 它是下面那张剪贴的「容器」
  const B = mk('方块', null);
  fill(B, Math.floor(W * 0.1), Math.floor(H * 0.2), Math.floor(W * 0.6), Math.floor(H * 0.6), [40, 170, 90, 255]);
  B.blend = 'multiply';

  // 3) 剪贴：一条很宽的蓝带，剪贴到「方块」上 —— 超出方块的部分不该显示
  const C = mk('剪贴', null);
  fill(C, 0, Math.floor(H * 0.25), W, Math.floor(H * 0.45), [40, 90, 220, 255]);
  C.clip = true;

  // 4) 一个组，里面两层。浓度用 k/255 这种**能被 8 位整数字段精确表示**的值，
  //    否则光是 0.5 -> 128 -> 0.50196 这一来一回就会让合成图有肉眼可见的差
  e.setGroups([{ id: 'grp', name: '我的组', visible: true, opacity: 1, blend: 'normal', collapsed: false }]);
  const D = mk('组内一', 'grp');
  fill(D, Math.floor(W * 0.55), Math.floor(H * 0.65), Math.floor(W * 0.95), Math.floor(H * 0.8), [250, 200, 40, 255]);
  D.opacity = 128 / 255;
  const E = mk('组内二', 'grp');
  fill(E, Math.floor(W * 0.15), Math.floor(H * 0.72), Math.floor(W * 0.5), Math.floor(H * 0.9), [200, 60, 190, 255]);
  E.blend = 'screen';

  e.activeLayerId = E.id;
  e.baseDirty = true; e.baseKey = '';
  e.rebuildBase(); e.invalidate();
  return {
    W: W, H: H,
    names: e.layers.map(l => l.name),
    units: e.renderUnits().length
  };
})()`;

/** 合成图的指纹：像素数 + 校验和。用于「导入前后画面必须一样」 */
const SIG = `(() => {
  const e = window.ChaApp.engine;
  const c = e.renderDocument({ transparentBackground: true });
  const d = c.ctx.getImageData(0, 0, e.width, e.height).data;
  let n = 0, s = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) { n++; s = (s * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 2147483647; }
  }
  return { n: n, sig: s };
})()`;

async function waitFor(page, fn, arg, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(150);
  }
  return false;
}

(async () => {
  console.log('茶绘 PSD 导入回环测试 @ ' + BASE + '\n');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });
  page.on('dialog', d => d.accept());

  /* ---------------- 1) 建房间 + 造文档 ---------------- */
  console.log('=== 1) 建房间、造一份带蒙版 / 剪贴 / 图层组的文档 ===');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 20000 });
  await page.fill('#nameInput', 'PSD导入');
  await page.fill('#newRoomName', 'PSD 导入回环');
  await page.evaluate(() => {
    const s = document.querySelector('#newRoomSize');
    let hit = false;
    for (const o of s.options) if (o.value === '800x1200') hit = true;
    if (!hit) { const o = document.createElement('option'); o.value = '800x1200'; o.textContent = '800×1200'; s.appendChild(o); }
    s.value = '800x1200';
  });
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, null, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(400);

  const doc = await page.evaluate(BUILD_DOC);
  ok('文档已就绪（5 层 + 1 个组）',
    doc.names.length === 5 && doc.units === 4, doc.names.join(' / ') + ' · ' + doc.units + ' 个渲染单元');
  const beforeSig = await page.evaluate(SIG);
  ok('导入前的合成图有内容', beforeSig.n > 5000, JSON.stringify(beforeSig));

  /* ---------------- 2) 导出字节，Node 端拆开看 ---------------- */
  console.log('\n=== 2) 导出 PSD，用 psd-lite 拆字节 ===');
  const b64 = await page.evaluate(() => {
    const url = window.ChaPsd.encode(window.ChaApp.engine, {});
    return String(url).split(',')[1] || '';
  });
  const bytes = Buffer.from(b64, 'base64');
  ok('导出的 PSD 有正常大小', bytes.length > 2048, (bytes.length / 1024).toFixed(1) + ' KB');

  let r = null;
  try { r = psdLite.parse(bytes); } catch (e) { ok('PSD 能被解析', false, e.message); }
  if (r) {
    ok('PSD 能被解析', true, r.width + '×' + r.height + ' · ' + r.layerCount + ' 条层记录');
    ok('尾部没有多余字节', r.trailing === 0, String(r.trailing));
    const names = r.layers.map(L => L.luni);
    ok('层记录顺序自下而上（底图在最前，组的闭合标记在最后）',
      names[0] === '底 图' && names[names.length - 1] === '我的组' &&
      names[names.length - 2] === '组内二', JSON.stringify(names));

    // 蒙版：以前这条通道根本不写，所以「蒙版在 PSD 里整张消失」
    const maskLayer = r.layers[0];
    const maskChan = maskLayer.chans.find(c => c.id === -2);
    ok('带蒙版的图层写出了 -2 通道', !!maskChan, JSON.stringify(maskLayer.chans.map(c => c.id)));
    ok('蒙版数据块里的矩形是满的（空矩形 = Photoshop 认为没有蒙版）',
      !!maskLayer.maskRect && maskLayer.maskRect.bottom === r.height, JSON.stringify(maskLayer.maskRect));
    const mstripe = maskLayer.pixels[-2][Math.floor(r.height * 0.45)][10];
    const mtop = maskLayer.pixels[-2][Math.floor(r.height * 0.1)][10];
    ok('蒙版像素：挖掉的那条是 0，别处是 255', mstripe === 0 && mtop === 255, 'stripe=' + mstripe + ' top=' + mtop);
    ok('没蒙版的图层没有 -2 通道', !r.layers[1].chans.some(c => c.id === -2));

    // 剪贴：以前恒写 0
    ok('剪贴层写出了 clipping=1', r.layers[2].clipping === 1, String(r.layers[2].clipping));
    ok('普通层的 clipping 是 0', r.layers[0].clipping === 0 && r.layers[1].clipping === 0);

    // 组与混合 / 浓度
    const lsct = r.layers.map(L => L.lsct);
    ok('组分隔符位置正确（[3] 在下、[1] 在上）',
      JSON.stringify(lsct) === JSON.stringify([null, null, null, 3, null, null, 1]),
      JSON.stringify(lsct));
    ok('混合模式写对了', r.layers[0].blend === 'norm' && r.layers[1].blend === 'mul ' &&
      r.layers[5].blend === 'scrn', r.layers.map(L => L.blend).join(','));
    ok('浓度写对了（128/255 那层）', r.layers[4].opacity === 128, String(r.layers[4].opacity));
  }

  /* ---------------- 3) 页面里把字节读回成伪工程 ---------------- */
  console.log('\n=== 3) 把刚导出的字节读回来（页面内） ===');
  const back = await page.evaluate(() => {
    const b = window.ChaPsd.encodeBytes(window.ChaApp.engine, {});
    const pj = window.ChaPsdRead.toProject(b, { name: '回环' });
    window.__pj = pj;
    return {
      notes: pj.notes,
      width: pj.doc.width, height: pj.doc.height,
      layers: pj.doc.layers.map(l => ({
        name: l.name, blend: l.blend, opacity: Math.round(l.opacity * 1000) / 1000,
        clip: l.clip, hasMask: !!l.maskPng, visible: l.visible,
        hasPng: !!l.png
      })),
      groups: pj.doc.groups.map(g => ({ name: g.name, collapsed: g.collapsed }))
    };
  });
  const L = back.layers;
  ok('尺寸读回来了', back.width === 800 && back.height === 1200, back.width + '×' + back.height);
  ok('5 层都读回来了', L.length === 5, JSON.stringify(L.map(x => x.name)));
  ok('层序没反（最底下的还是「底 图」）', L[0].name === '底 图' && L[4].name === '组内二',
    JSON.stringify(L.map(x => x.name)));
  ok('每层都带着像素', L.every(x => x.hasPng));
  ok('混合模式读回来了', L[1].blend === 'multiply' && L[4].blend === 'screen',
    L.map(x => x.blend).join(','));
  ok('浓度读回来了（128/255，误差在 1/255 内）', Math.abs(L[3].opacity - 128 / 255) < 0.002,
    String(L[3].opacity));
  ok('剪贴标记读回来了，且只有那一层有', L[2].clip === true && L[0].clip === false && L[4].clip === false);
  ok('★ 蒙版读回来了（只有底图那一层有）',
    L[0].hasMask === true && L[1].hasMask === false && L[4].hasMask === false,
    JSON.stringify(L.map(x => x.hasMask)));
  ok('图层组读回来了', back.groups.length === 1 && back.groups[0].name === '我的组',
    JSON.stringify(back.groups));

  // 读回来时的「跳过清单」不该乱报：这份文件里的东西全都是茶绘自己写的
  ok('没有抱怨读不懂的地方', (back.notes || []).length === 0, JSON.stringify(back.notes));

  /* ---------------- 4) 装进新房间，比对画面 ---------------- */
  console.log('\n=== 4) 装进新房间（走真实的 openProjectDoc），比对合成图 ===');
  const oldRoom = await page.evaluate(() => window.ChaApp.state.room.id);
  await page.evaluate(() => window.ChaApp.openProjectDoc(window.__pj, { noConfirm: true }));
  const loaded = await waitFor(page, (old) => {
    const A = window.ChaApp;
    if (!A || !A.state.room || A.state.room.id === old) return false;
    const ls = A.engine.layers;
    return ls.length === 5 && ls.every(l => !!l.baseImage);
  }, oldRoom, 25000);
  ok('新房间装好了 5 层', loaded);

  if (loaded) {
    await sleep(900);
    const newMeta = await page.evaluate(() => window.ChaApp.engine.layers.map(l => ({
      name: l.name, blend: l.blend, clip: !!l.clip, hasMask: !!l.hasMask,
      maskOn: l.maskEnabled !== false, visible: l.visible,
      opacity: Math.round(l.opacity * 255)
    })));
    ok('图层带着蒙版标记进来了', newMeta[0].hasMask === true && newMeta[1].hasMask === false,
      JSON.stringify(newMeta.map(m => m.hasMask)));
    ok('剪贴标记跟着进来了', newMeta[2].clip === true && newMeta[0].clip === false);
    ok('浓度没在途中被改掉', newMeta[3].opacity === 128, String(newMeta[3].opacity));
    ok('混合模式没在途中被改掉', newMeta[1].blend === 'multiply' && newMeta[4].blend === 'screen',
      newMeta.map(m => m.blend).join(','));
    ok('图层组也进来了', (await page.evaluate(() => window.ChaApp.engine.groupList().length)) === 1);

    // 蒙版像素真的落地了（不是只有一个 true 标记）
    const maskHoles = await page.evaluate(() => {
      const e = window.ChaApp.engine, l = e.layers[0];
      if (!l.maskCanvas) return -1;
      const d = l.maskCanvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 128) n++;
      return n;
    });
    ok('蒙版像素真的传过来了（挖掉的那条在）', maskHoles > 8000,
      'holes=' + maskHoles + '（800×120 的那条约 96000）');

    const afterSig = await page.evaluate(SIG);
    ok('★ 导入后的合成图和导入前逐点一致', afterSig.sig === beforeSig.sig && afterSig.n === beforeSig.n,
      '前 ' + JSON.stringify(beforeSig) + ' 后 ' + JSON.stringify(afterSig));
  }

  /* ---------------- 5) 坏输入要说人话 ---------------- */
  console.log('\n=== 5) 坏输入：报错必须是人话 ===');
  const msgs = await page.evaluate(() => {
    const out = {};
    function tryIt(key, bytes) {
      try { window.ChaPsdRead.read(bytes); out[key] = ''; }
      catch (e) { out[key] = e.message; }
    }
    tryIt('empty', new Uint8Array(0));
    tryIt('text', new Uint8Array([104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33, 33, 33,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    tryIt('psb', (function () {
      const b = new Uint8Array(40);
      b[0] = 56; b[1] = 66; b[2] = 80; b[3] = 83;   // 8BPS
      b[5] = 2;                                     // 版本 2 = PSB
      return b;
    })());
    tryIt('depth32', (function () {
      const b = new Uint8Array(40);
      b[0] = 56; b[1] = 66; b[2] = 80; b[3] = 83;
      b[5] = 1;
      b[23] = 32;                                   // 位深 32（u16 在 22，低位在 23）
      b[25] = 3;                                    // 颜色模式 RGB（u16 在 24）
      return b;
    })());
    tryIt('cmyk', (function () {
      const b = new Uint8Array(0x2000);
      b[0] = 56; b[1] = 66; b[2] = 80; b[3] = 83;
      b[5] = 1; b[23] = 8; b[25] = 4;               // 8 位 / CMYK
      return b;
    })());
    tryIt('truncated', (function () {
      const b = new Uint8Array(0x2000);
      b[0] = 56; b[1] = 66; b[2] = 80; b[3] = 83;
      b[5] = 1; b[23] = 8; b[25] = 3;
      b[20] = 3; b[21] = 32;                        // 宽 800（u32 在 18）
      b[16] = 4; b[17] = 176;                       // 高 1200（u32 在 14）
      return b;
    })());
    return out;
  });
  ok('空文件：说人话', /PSD/.test(msgs.empty) && msgs.empty.length > 6, msgs.empty);
  ok('不是 PSD：说「开头不是 8BPS」', /8BPS/.test(msgs.text), msgs.text);
  ok('PSB：明确说读不了 PSB', /PSB/.test(msgs.psb), msgs.psb);
  ok('32 位：明确说是位深问题', /32 位/.test(msgs.depth32), msgs.depth32);
  ok('CMYK：明确说是颜色模式问题', /CMYK/.test(msgs.cmyk), msgs.cmyk);
  ok('截断的文件：报的是人话，不是 JS 原生报错',
    /PSD/.test(msgs.truncated) && !/undefined|null is not/.test(msgs.truncated), msgs.truncated);

  console.log('\n=== 全程无 JS 报错 ===');
  ok('没有未捕获的异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试崩了:', e); process.exit(2); });
