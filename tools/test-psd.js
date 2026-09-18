/**
 * 茶绘 · PSD 导出专项测试
 *
 * 走真实路径：建房间 → 造一份带图层组的文档 → 打开「导出」对话框选 PSD → 点导出
 * → 接住下载回来的 .psd → 用 tools/psd-lite.js 把字节拆开逐项断言。
 *
 * 为什么连字节都要断言：PSD 是二进制格式，写错一个长度字段 Photoshop 直接打不开，
 * 而「文件生成了、大小不为 0」这种断言对二进制格式等于没测。
 * 解析器顺带把 RLE 解回来，所以像素也是逐点验的。
 *
 * 用法: node tools/test-psd.js [http://localhost:8437]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('./pw');
const psdLite = require('./psd-lite');
const parsePsd = psdLite.parse;
const layerPx = psdLite.layerPx;
const compPx = psdLite.compPx;

const BASE = process.argv[2] || 'http://localhost:8437';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('茶绘 PSD 导出专项测试 @ ' + BASE + '\n');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  console.log('[1] 建房间');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 8000 });
  await page.fill('#nameInput', 'PSD 测试');
  await page.fill('#newRoomName', 'PSD 测试室');
  await page.click('#btnCreateRoom');
  // 注意：waitForFunction 的第二个位置参数是「传给页面的实参」，不是 options，
  // 写 {timeout} 进去会被当参数吞掉（静默退回默认 30s）。要限时就传第三个参数。
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined && a.engine.layers.length > 0;
  }, undefined, { timeout: 15000 });
  ok('房间已建立', true);
  ok('加载期没有页面报错', errors.length === 0, errors.join(' | '));

  console.log('\n[2] 造一份带图层组的文档');
  const doc = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const W = e.width, H = e.height;

    // 从零开始，自己造层（PSD 编码器读的就是 engine 里这份状态）
    e.layers.length = 0;
    e.setGroups([]);

    function mk(id, name, groupId) {
      const l = e.addLayerMeta({ id: id, name: name });
      l.groupId = groupId || null;
      l.strokes = [];
      l.baseImage = null;
      return l;
    }
    function fill(l, x0, y0, x1, y1, rgba) {
      const c = l.ctx;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, W, H);
      c.fillStyle = 'rgba(' + rgba.join(',') + ')';
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
      c.restore();
      l.dirty = true;
    }

    // 底：左半边红
    const A = mk('LA', '底 图', null);
    fill(A, 0, 0, Math.floor(W / 2), H, [255, 0, 0, 255]);
    A.opacity = 1; A.blend = 'normal'; A.visible = true;

    // 组内一：上半条绿，半透明 + 正片叠底
    const B = mk('LB', '组内一', 'grp');
    fill(B, 0, 0, W, Math.floor(H / 2), [0, 200, 0, 255]);
    B.opacity = 0.5; B.blend = 'multiply'; B.visible = true;

    // 组内二：整张蓝，但是藏起来的
    const C = mk('LC', '组内二', 'grp');
    fill(C, 0, 0, W, H, [0, 0, 255, 255]);
    C.opacity = 0.75; C.blend = 'screen'; C.visible = false;

    // 顶：右下角一小块黄
    const D = mk('LD', '顶 层', null);
    fill(D, Math.floor(W / 2), Math.floor(H / 2), W, H, [255, 255, 0, 255]);
    D.opacity = 1; D.blend = 'add'; D.visible = true;

    e.setGroups([{
      id: 'grp', name: '我的组', visible: true,
      opacity: 0.8, blend: 'overlay', collapsed: false
    }]);
    e.activeLayerId = D.id;
    e.baseDirty = true; e.baseKey = '';
    e.rebuildBase(); e.invalidate();

    return { W: W, H: H };
  });
  ok('文档已就绪 ' + doc.W + '×' + doc.H, doc.W > 0 && doc.H > 0);

  const units = await page.evaluate(() => window.ChaApp.engine.renderUnits().map((u) => ({
    group: u.group ? u.group.name : null, layers: u.layers.map((l) => l.name)
  })));
  console.log('    渲染单元: ' + JSON.stringify(units));
  ok('组只出一个渲染单元，且成员连续', units.length === 3 && (units[1].layers || []).length === 2,
    JSON.stringify(units));

  console.log('\n[3] 走真实导出对话框');
  await page.evaluate(() => window.ChaApp.openExportDialog());
  await page.waitForSelector('#exportMask:not(.hidden)', { timeout: 5000 });
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#exportFormat option')).map((o) => o.value));
  ok('格式下拉里有 psd', opts.indexOf('psd') >= 0, opts.join(','));
  await page.selectOption('#exportFormat', 'psd');
  const note = await page.textContent('#exportNote');
  ok('PSD 的说明文案会讲图层组', /图层组/.test(note || ''), note);
  const qHidden = await page.evaluate(() => document.querySelector('#exportQualityRow').classList.contains('hidden'));
  ok('PSD 不显示画质滑杆', qHidden === true);

  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btnExportOk')
  ]).then((r) => r[0]);

  const fname = dl.suggestedFilename();
  ok('下载文件名是 .psd', /\.psd$/i.test(fname), fname);
  const tmp = path.join(os.tmpdir(), 'chahu-psd-test-' + Date.now() + '.psd');
  await dl.saveAs(tmp);
  const bytes = fs.readFileSync(tmp);
  const sizeKB = (bytes.length / 1024).toFixed(1);
  ok('PSD 字节数合理（> 2KB）', bytes.length > 2048, sizeKB + ' KB');
  console.log('    文件: ' + fname + '  ' + sizeKB + ' KB');

  console.log('\n[4] 解析字节并断言');
  let r;
  try { r = parsePsd(bytes); } catch (e) { ok('PSD 能被解析', false, e.message); return finish(browser, errors); }
  ok('PSD 能被解析', true);

  ok('版本 1', r.version === 1, String(r.version));
  ok('通道数 4（RGBA）', r.channels === 4, String(r.channels));
  ok('位深 8', r.depth === 8, String(r.depth));
  ok('颜色模式 3（RGB）', r.colorMode === 3, String(r.colorMode));
  ok('尺寸与文档一致', r.width === doc.W && r.height === doc.H, r.width + '×' + r.height);
  ok('尾部没有多余字节', r.trailing === 0, String(r.trailing));

  // 记录顺序（自下而上）：底图, [3], 组内一, 组内二, [1], 顶 层
  ok('层记录数 6（4 层 + 2 个组分隔符）', r.layerCount === 6, String(r.layerCount));
  const names = r.layers.map((L) => L.luni);
  ok('层名与顺序正确', JSON.stringify(names) === JSON.stringify(
    ['底 图', '</Layer group>', '组内一', '组内二', '我的组', '顶 层']), JSON.stringify(names));
  ok('pascal 名把中文降级成 ?（真名在 luni）', r.layers[0].pascalName === '? ?',
    JSON.stringify(r.layers[0].pascalName));

  const lsct = r.layers.map((L) => L.lsct);
  ok('分隔符位置：[3] 在组下方、[1] 在组上方', JSON.stringify(lsct) === JSON.stringify([null, 3, null, null, 1, null]),
    JSON.stringify(lsct));
  ok('边界分隔符矩形为空', r.layers[1].top === 0 && r.layers[1].bottom === 0 &&
    r.layers[1].left === 0 && r.layers[1].right === 0,
    [r.layers[1].top, r.layers[1].left, r.layers[1].bottom, r.layers[1].right].join(','));
  ok('普通层矩形铺满文档', r.layers[0].bottom === doc.H && r.layers[0].right === doc.W,
    [r.layers[0].top, r.layers[0].left, r.layers[0].bottom, r.layers[0].right].join(','));

  const blends = r.layers.map((L) => L.blend);
  ok('混合模式映射正确', JSON.stringify(blends) === JSON.stringify(['norm', 'norm', 'mul ', 'scrn', 'over', 'lddg']),
    JSON.stringify(blends));
  const ops = r.layers.map((L) => L.opacity);
  ok('浓度映射正确', JSON.stringify(ops) === JSON.stringify([255, 255, 128, 191, 204, 255]), JSON.stringify(ops));
  ok('隐藏层写上了 0x02', r.layers[3].hidden === true && r.layers[2].hidden === false);
  ok('分隔符带 0x10（像素不参与成图）', (r.layers[1].flags & 0x10) !== 0 && (r.layers[4].flags & 0x10) !== 0);
  ok('普通层不带 0x10', (r.layers[0].flags & 0x10) === 0);
  ok('分隔符是 4 通道、长度为 2（只有压缩标志）',
    r.layers[1].chans.length === 4 && r.layers[1].chans.every((c) => c.len === 2),
    JSON.stringify(r.layers[1].chans));

  // 像素
  const xL = Math.floor(doc.W / 4), xR = Math.floor(doc.W * 3 / 4);
  const yT = Math.floor(doc.H / 4), yB = Math.floor(doc.H * 3 / 4);
  const eq4 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('底图左半边 = 红且不透明', eq4(layerPx(r.layers[0], xL, yT), [255, 0, 0, 255]),
    JSON.stringify(layerPx(r.layers[0], xL, yT)));
  ok('底图右半边 = 全透明', eq4(layerPx(r.layers[0], xR, yT), [0, 0, 0, 0]),
    JSON.stringify(layerPx(r.layers[0], xR, yT)));
  ok('组内一上半 = 绿', eq4(layerPx(r.layers[2], xL, yT), [0, 200, 0, 255]));
  ok('组内一下半 = 透明', eq4(layerPx(r.layers[2], xL, yB), [0, 0, 0, 0]));
  ok('隐藏层像素照样存进去了', eq4(layerPx(r.layers[3], xL, yB), [0, 0, 255, 255]),
    JSON.stringify(layerPx(r.layers[3], xL, yB)));
  ok('顶层右下 = 黄', eq4(layerPx(r.layers[5], xR, yB), [255, 255, 0, 255]));
  ok('顶层左上 = 透明', eq4(layerPx(r.layers[5], xL, yT), [0, 0, 0, 0]));

  // 合成图：和 renderDocument({transparentBackground:true}) 逐点对
  const expect = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.renderDocument({ transparentBackground: true }).ctx.getImageData(0, 0, e.width, e.height).data;
    const W = e.width, H = e.height, out = [];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const x = Math.floor(gx * (W - 1) / 7), y = Math.floor(gy * (H - 1) / 4);
        const i = (y * W + x) * 4;
        out.push(d[i], d[i + 1], d[i + 2], d[i + 3]);
      }
    }
    return out;
  });
  let bad = 0, firstBad = '';
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const idx = (gy * 8 + gx) * 4;
      const x = Math.floor(gx * (doc.W - 1) / 7), y = Math.floor(gy * (doc.H - 1) / 4);
      const got = compPx(r, x, y);
      const want = expect.slice(idx, idx + 4);
      if (got.some((v, i2) => Math.abs(v - want[i2]) > 1)) {
        bad++;
        if (!firstBad) firstBad = '(' + x + ',' + y + ') 得到 ' + got.join(',') + ' 期望 ' + want.join(',');
      }
    }
  }
  ok('合成图像素与画布一致（40 个采样点）', bad === 0, bad + ' 个不一致 ' + firstBad);

  console.log('\n[5] 错误处理');
  const errs = await page.evaluate(() => {
    const out = {};
    try { window.ChaExport.encode(null, 'psd', 1); out.noEngine = ''; }
    catch (e) { out.noEngine = e.message; }
    try {
      window.ChaPsd.encodeBytes({ width: 40000, height: 10, layers: [{}], renderUnits: () => [] });
      out.tooBig = '';
    } catch (e) { out.tooBig = e.message; }
    try {
      window.ChaPsd.encodeBytes({ width: 100, height: 10, layers: [{}], renderUnits: () => [] });
      out.noLayers = '';
    } catch (e) { out.noLayers = e.message; }
    return out;
  });
  ok('没给 engine 时给的是人话', /PSD 需要文档的图层信息/.test(errs.noEngine), errs.noEngine);
  ok('超大尺寸被拦住', /PSD 上限/.test(errs.tooBig), errs.tooBig);
  ok('没有图层时被拦住', /没有图层/.test(errs.noLayers), errs.noLayers);

  return finish(browser, errors);
}

async function finish(browser, errors) {
  ok('全程没有页面报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) { console.log('\n失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩了: ' + (e && e.stack || e)); process.exit(1); });
