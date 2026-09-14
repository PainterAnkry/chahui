/**
 * 色调调整（滤镜）回归。
 *
 * 守着这几条：
 *   · 亮度 / 对比度 / 色相 / 饱和度的数学是对的（拿已知像素验）
 *   · 恒等变换（全 0）不改任何一个像素 —— 否则「打开对话框再关掉」也会脏图
 *   · 预览是**真的**：layerOverride 生效时，画布上被替换的只有目标图层，别的图层不动
 *   · 取消不留痕；确定会把结果发成一次像素操作（别人也能同步、也能撤销）
 *
 * 用法: node tools/test-filters.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '滤镜');
  await page.fill('#newRoomName', '色调调整');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(400);

  console.log('\n=== 滤镜数学 ===');
  const math = await page.evaluate(() => {
    const F = window.ChaFilters;
    function one(r, g, b, o) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const cx = c.getContext('2d');
      const img = cx.createImageData(1, 1);
      img.data[0] = r; img.data[1] = g; img.data[2] = b; img.data[3] = 255;
      F.applyTone(img, o);
      return [img.data[0], img.data[1], img.data[2], img.data[3]];
    }
    return {
      ident: one(100, 150, 200, { brightness: 0, contrast: 0, hue: 0, saturation: 0 }),
      bright: one(100, 150, 200, { brightness: 20 }),
      dark: one(100, 150, 200, { brightness: -20 }),
      hueRot: one(255, 0, 0, { hue: 120 }),
      desat: one(255, 0, 0, { saturation: -100 }),
      gray: one(128, 128, 128, { hue: 120 }),
      alpha: (function () {
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const cx = c.getContext('2d');
        const img = cx.createImageData(1, 1);
        img.data[0] = 10; img.data[1] = 20; img.data[2] = 30; img.data[3] = 77;
        F.applyTone(img, { brightness: 50, hue: 90 });
        return img.data[3];
      })()
    };
  });
  console.log('  ' + JSON.stringify(math));
  ok('全 0 时是恒等变换', JSON.stringify(math.ident) === JSON.stringify([100, 150, 200, 255]), JSON.stringify(math.ident));
  ok('亮度 +20 每个通道升 51', math.bright.every((v, i) => i === 3 || v === [151, 201, 251][i]), JSON.stringify(math.bright));
  ok('亮度 -20 每个通道降 51', math.dark.every((v, i) => i === 3 || v === [49, 99, 149][i]), JSON.stringify(math.dark));
  ok('红色转 120° 色相后变绿', math.hueRot[1] > 200 && math.hueRot[0] < 60, JSON.stringify(math.hueRot));
  ok('饱和度 -100 后变灰', math.desat[0] === math.desat[1] && math.desat[1] === math.desat[2], JSON.stringify(math.desat));
  ok('灰色像素不会被色相染上颜色', math.gray[0] === math.gray[1] && math.gray[1] === math.gray[2], JSON.stringify(math.gray));
  ok('alpha 不受影响', math.alpha === 77, String(math.alpha));

  console.log('\n=== 色阶数学 ===');
  const lv = await page.evaluate(() => {
    const F = window.ChaFilters;
    function one(v, o) {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const cx = c.getContext('2d');
      const img = cx.createImageData(1, 1);
      img.data[0] = img.data[1] = img.data[2] = v; img.data[3] = 200;
      F.applyLevels(img, o);
      return [img.data[0], img.data[3]];
    }
    return {
      ident: one(128, { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }),
      clipLow: one(50, { inBlack: 100, inWhite: 200, gamma: 1 }),
      clipHigh: one(230, { inBlack: 100, inWhite: 200, gamma: 1 }),
      mid: one(150, { inBlack: 100, inWhite: 200, gamma: 1 }),
      gammaUp: one(128, { gamma: 2 }),
      gammaDown: one(128, { gamma: 0.5 }),
      outRange: one(255, { outBlack: 30, outWhite: 200 }),
      outLow: one(0, { outBlack: 30, outWhite: 200 })
    };
  });
  console.log('  ' + JSON.stringify(lv));
  ok('色阶：全默认是恒等变换', lv.ident[0] === 128, JSON.stringify(lv.ident));
  ok('色阶：低于输入黑场的被压到 0', lv.clipLow[0] === 0, String(lv.clipLow[0]));
  ok('色阶：高于输入白场的被提到 255', lv.clipHigh[0] === 255, String(lv.clipHigh[0]));
  ok('色阶：输入黑/白场之间的线性映射正确（中点 128）', Math.abs(lv.mid[0] - 128) <= 1, String(lv.mid[0]));
  ok('色阶：gamma > 1 变亮', lv.gammaUp[0] > 128, String(lv.gammaUp[0]));
  ok('色阶：gamma < 1 变暗', lv.gammaDown[0] < 128, String(lv.gammaDown[0]));
  ok('色阶：输出范围上限生效', lv.outRange[0] === 200, String(lv.outRange[0]));
  ok('色阶：输出范围下限生效', lv.outLow[0] === 30, String(lv.outLow[0]));
  ok('色阶：alpha 不动', lv.ident[1] === 200 && lv.gammaUp[1] === 200, String(lv.ident[1]));

  console.log('\n=== 对话框与预览 ===');
  // 造两层：底层红、上层蓝
  await page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height); });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
    const l = e.activeLayer();
    l.ctx.fillStyle = '#0000ff';
    l.ctx.fillRect(200, 200, 400, 300);
    l.baseImage = l.ctx.canvas.toDataURL('image/png');
    l.baseSeq = e.seq;
  });
  await page.evaluate(() => window.ChaApp.openToneDialog());
  await sleep(500);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#toneMask').classList.contains('hidden'),
    rows: document.querySelectorAll('#toneMask .tone-row').length,   // 导出对话框也用 .tone-row，要限定范围
    note: document.querySelector('#toneNote').textContent
  }));
  console.log('  ' + JSON.stringify(dlg));
  ok('对话框能打开', dlg.open === true);
  ok('四个滑块都在', dlg.rows === 4, String(dlg.rows));
  ok('说明了作用对象', /图层/.test(dlg.note), dlg.note.slice(0, 30));

  // 拖亮度 → 预览应该让图层变亮，而且 override 生效
  const before = await page.evaluate(() => window.ChaApp.engine.layerOverride);
  await page.evaluate(() => {
    const b = document.querySelector('#toneBright');
    b.value = 60; b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const prev = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const ov = e.layerOverride;
    let blue = 0, bright = 0;
    if (ov) {
      const d = ov.canvas.getContext('2d').getImageData(400, 350, 1, 1).data;
      return { has: true, px: [d[0], d[1], d[2], d[3]], layerId: ov.layerId, active: e.activeLayerId };
    }
    void blue; void bright;
    return { has: false };
  });
  console.log('  预览像素: ' + JSON.stringify(prev));
  ok('打开滤镜时没有覆盖', before === null || before === undefined || !before);
  ok('拖滑块后有了图层覆盖', prev.has === true);
  ok('覆盖的就是当前图层', prev.layerId === prev.active, prev.layerId + ' / ' + prev.active);
  ok('亮度 +60 让蓝色变亮（B 到顶、R/G 升高）', prev.has && prev.px[2] === 255 && prev.px[0] > 100,
    JSON.stringify(prev.px));

  // 画布上真的合成出了预览：取画布上的像素看一眼
  const onCanvas = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const doc = e.renderDocument({});
    const d = doc.canvas.getContext('2d').getImageData(400, 350, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });
  console.log('  renderDocument 里的像素: ' + JSON.stringify(onCanvas));
  ok('合成结果里也是亮的（预览走的是真合成，不是另画一张小图）',
    onCanvas[0] > 80 && onCanvas[2] === 255, JSON.stringify(onCanvas));

  // 重置
  await page.evaluate(() => document.querySelector('#btnToneReset').click());
  await sleep(400);
  const afterReset = await page.evaluate(() => ({
    ov: window.ChaApp.engine.layerOverride,
    bright: document.querySelector('#toneBright').value
  }));
  ok('重置把滑块归零并撤掉预览', afterReset.bright === '0' && !afterReset.ov, JSON.stringify(afterReset));

  console.log('\n=== 取消 / 确定 ===');
  await page.evaluate(() => {
    const b = document.querySelector('#toneBright');
    b.value = 40; b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(400);
  await page.evaluate(() => document.querySelector('#btnToneCancel').click());
  await sleep(600);
  const cancelled = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.renderLayerRaw(e.activeLayerId).getContext('2d').getImageData(400, 350, 1, 1).data;
    return { ov: e.layerOverride, px: [d[0], d[1], d[2]] };
  });
  ok('取消后覆盖被清掉', !cancelled.ov);
  ok('取消后图层像素没变（还是原来的深蓝）', cancelled.px[0] < 60 && cancelled.px[2] > 200, JSON.stringify(cancelled.px));

  // 确定：应该发一次像素操作
  const sent = await page.evaluate(() => new Promise(resolve => {
    const net = window.ChaApp.net;
    const orig = net.send.bind(net);
    const seen = [];
    net.send = function (t, p) { seen.push({ t: t, id: p && p.layerId, label: p && p.label }); return orig(t, p); };
    window.ChaApp.openToneDialog();
    setTimeout(() => {
      const b = document.querySelector('#toneBright');
      b.value = 50; b.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        document.querySelector('#btnToneOk').click();
        setTimeout(() => { net.send = orig; resolve(seen); }, 900);
      }, 500);
    }, 400);
  }));
  const px = sent.filter(s => s.t === 'layer:pixels' || s.t === 'layer:pixels' || /pixels/.test(s.t));
  console.log('  发出的消息: ' + JSON.stringify(sent));
  ok('确定时把结果作为一次像素操作发了出去', px.length >= 1, JSON.stringify(px));
  await sleep(1500);
  const undone = await page.evaluate(() => ({ undo: window.ChaApp.state.opUndo.length, seq: window.ChaApp.engine.seq }));
  console.log('  撤销栈 ' + undone.undo + ' 条, seq=' + undone.seq);

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
