/**
 * 第三轮验收：魔棒 / 框选 / 套索、框选后自动变换、撤销能撤变换与选区、垂直翻转不跑出选区。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'screenshots', 'probe');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '第三轮');
  await page.fill('#newRoomName', '第三轮验收');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  const st = () => page.evaluate(() => {
    const e = window.ChaApp.engine, s = window.ChaApp.state;
    return {
      sel: e.hasSelection(), bbox: e.selection && e.selection.bbox,
      transforming: !!e.transform, strokes: e.strokes.length, seq: e.seq,
      opUndo: s.opUndo.length, opRedo: s.opRedo.length,
      opKinds: s.opUndo.map(function (x) { return x.type; }).join(','),
      layerPx: (() => {
        const l = e.activeLayer();
        if (!l) return -1;
        const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      })()
    };
  });
  const selMaskPx = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    if (!e.selection) return -1;
    const d = e.selection.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });

  /* ============ [1] 工具栏里有魔棒 / 框选 / 套索 ============ */
  console.log('\n=== [1] 新选区工具 ===');
  const tools = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#toolGrid .tool')).map(b => b.dataset.item));
  console.log('  工具栏:', tools.join(', '));
  check('工具栏有「框选」', tools.indexOf('marquee') >= 0);
  check('工具栏有「套索」', tools.indexOf('lasso') >= 0);
  check('工具栏有「魔棒」', tools.indexOf('wand') >= 0);

  // 先画一块纯色，方便魔棒选
  await page.click('#toolGrid .tool[data-item="bucket"]');
  await sleep(200);
  await page.fill('#hexInput', '#3a86e0');
  await page.dispatchEvent('#hexInput', 'change');
  const p1 = await mk(300, 300);
  await page.mouse.move(p1[0], p1[1]);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(500);
  await page.click('#toolGrid .tool[data-item="brush"]');
  await sleep(200);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 30; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.fill('#hexInput', '#111111');
  await page.dispatchEvent('#hexInput', 'change');
  const l1 = await mk(600, 300), l2 = await mk(600, 700);
  await page.mouse.move(l1[0], l1[1]);
  await page.mouse.down();
  await page.mouse.move(l2[0], l2[1], { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  console.log('  铺好底色 + 一条黑线');

  /* ---- 框选 ---- */
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(250);
  await page.evaluate(() => { window.ChaApp.state.autoTransform = false; });
  const m1 = await mk(400, 350), m2 = await mk(900, 650);
  await page.mouse.move(m1[0], m1[1]);
  await page.mouse.down();
  await page.mouse.move(m2[0], m2[1], { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  let s = await st();
  console.log('  框选后:', JSON.stringify({ sel: s.sel, bbox: s.bbox, undo: s.opKinds }));
  check('框选建立了选区', s.sel === true);
  const expectW = 500, expectH = 300;
  check('框选范围正确', s.bbox && Math.abs(s.bbox.w - expectW) <= 2 && Math.abs(s.bbox.h - expectH) <= 2,
    JSON.stringify(s.bbox));
  const mask1 = await selMaskPx();
  check('框选蒙版是实心矩形', Math.abs(mask1 - expectW * expectH) / (expectW * expectH) < 0.05,
    mask1 + ' vs ' + (expectW * expectH));
  check('框选记了一条可撤销的选区操作', /selection/.test(s.opKinds), s.opKinds);

  /* ---- 魔棒 ---- */
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  await page.click('#toolGrid .tool[data-item="wand"]');
  await sleep(250);
  const w1 = await mk(300, 300);   // 点蓝色区域
  await page.mouse.move(w1[0], w1[1]);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(900);
  s = await st();
  const maskWand = await selMaskPx();
  console.log('  魔棒（点蓝色区）:', JSON.stringify({ sel: s.sel, bbox: s.bbox }), ' maskPx=' + maskWand);
  check('魔棒建立了选区', s.sel === true);
  check('魔棒选中的是一大片（跟框选量级相当）', maskWand > 200000, String(maskWand));
  await page.screenshot({ path: path.join(OUT, 'p5-wand.png') });

  /* ---- 套索 ---- */
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  await page.click('#toolGrid .tool[data-item="lasso"]');
  await sleep(250);
  const cx = 800, cy = 500;
  const start = await mk(cx + 150, cy);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    const a = i / 40 * Math.PI * 2;
    const p = await mk(cx + Math.cos(a) * 150, cy + Math.sin(a) * 150);
    await page.mouse.move(p[0], p[1]);
  }
  await page.mouse.up();
  await sleep(800);
  s = await st();
  const maskLasso = await selMaskPx();
  const circleArea = Math.PI * 150 * 150;
  console.log('  套索:', JSON.stringify({ sel: s.sel, bbox: s.bbox }), ' maskPx=' + maskLasso + '（≈' + Math.round(circleArea) + '）');
  check('套索建立了选区', s.sel === true);
  check('套索选的是圆形区域（面积接近 πr²）',
    Math.abs(maskLasso - circleArea) / circleArea < 0.12, maskLasso + ' vs ' + Math.round(circleArea));

  /* ============ [2] 框选后自动弹出变换 ============ */
  console.log('\n=== [2] 框选后自动弹出变换 ===');
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  await page.evaluate(() => { const c = document.querySelector('#tpAuto'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(250);
  const a1 = await mk(500, 400), a2 = await mk(1000, 700);
  await page.mouse.move(a1[0], a1[1]);
  await page.mouse.down();
  await page.mouse.move(a2[0], a2[1], { steps: 8 });
  await page.mouse.up();
  await sleep(1200);
  s = await st();
  const panelOn = await page.evaluate(() => !document.querySelector('#transformPanel').classList.contains('hidden'));
  console.log('  框选后: 变换面板=' + panelOn + ' transforming=' + s.transforming);
  check('框选后自动进入变换', panelOn && s.transforming === true);

  // 中止 → 选区还在
  await page.evaluate(() => document.querySelector('#tpCancel').click());
  await sleep(700);
  s = await st();
  console.log('  中止后:', JSON.stringify({ sel: s.sel, transforming: s.transforming }));
  check('中止变换后选区保留', s.sel === true && s.transforming === false);

  /* ============ [3] 撤销能撤变换和选区 ============ */
  console.log('\n=== [3] 撤销 / 重做 ===');
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  const px0 = (await st()).layerPx;

  // 变换一次并确定
  await page.evaluate(() => document.querySelector('#btnSelAll').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(600);
  const q = await page.evaluate(() => window.ChaApp.engine.transform.quad);
  const f = await mk(q[2].x, q[2].y), t = await mk(q[2].x - 260, q[2].y - 180);
  await page.mouse.move(f[0], f[1]);
  await page.mouse.down();
  await page.mouse.move(t[0], t[1], { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  await page.evaluate(() => document.querySelector('#tpApply').click());
  await sleep(1600);
  s = await st();
  const pxAfterTransform = s.layerPx;
  console.log('  变换确定后: layerPx=' + pxAfterTransform + '（变换前 ' + px0 + '） 栈=' + s.opKinds);
  check('变换记了一条可撤销的像素操作', /pixels/.test(s.opKinds), s.opKinds);

  await page.evaluate(() => document.querySelector('#btnUndo').click());
  await sleep(1600);
  s = await st();
  console.log('  撤销变换后: layerPx=' + s.layerPx + '  ' + JSON.stringify({ undo: s.opUndo, redo: s.opRedo }));
  check('撤销把变换的像素撤回去了',
    Math.abs(s.layerPx - px0) / Math.max(1, px0) < 0.05, `${pxAfterTransform} → ${s.layerPx}（原始 ${px0}）`);

  await page.evaluate(() => document.querySelector('#btnRedo').click());
  await sleep(1600);
  s = await st();
  console.log('  重做变换后: layerPx=' + s.layerPx);
  check('重做又把变换做回去了',
    Math.abs(s.layerPx - pxAfterTransform) / Math.max(1, pxAfterTransform) < 0.05,
    `${s.layerPx} vs ${pxAfterTransform}`);

  // 撤销选区：框选两次，撤销应回到上一个选区
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await page.evaluate(() => { const c = document.querySelector('#tpAuto'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  const b1 = await mk(300, 250), b2 = await mk(700, 500);
  await page.mouse.move(b1[0], b1[1]);
  await page.mouse.down();
  await page.mouse.move(b2[0], b2[1], { steps: 6 });
  await page.mouse.up();
  await sleep(700);
  const sel1 = (await st()).bbox;
  const b3 = await mk(900, 600), b4 = await mk(1300, 850);
  await page.mouse.move(b3[0], b3[1]);
  await page.mouse.down();
  await page.mouse.move(b4[0], b4[1], { steps: 6 });
  await page.mouse.up();
  await sleep(700);
  const sel2 = (await st()).bbox;
  console.log('  两次框选:', JSON.stringify(sel1), '→', JSON.stringify(sel2));
  await page.evaluate(() => document.querySelector('#btnUndo').click());
  await sleep(900);
  const sel3 = (await st()).bbox;
  console.log('  撤销一次后:', JSON.stringify(sel3));
  check('撤销能撤回上一步框选（回到上一个选区）',
    !!sel3 && !!sel1 && Math.abs(sel3.x - sel1.x) < 6 && Math.abs(sel3.w - sel1.w) < 6,
    JSON.stringify(sel3));
  await page.evaluate(() => document.querySelector('#btnUndo').click());
  await sleep(900);
  const sel4 = (await st()).bbox;
  console.log('  再撤销一次:', JSON.stringify(sel4));
  check('继续撤销能撤到「没有选区」', sel4 === null || sel4 === undefined, JSON.stringify(sel4));

  /* ============ [4] 垂直翻转不跑出选区 ============ */
  console.log('\n=== [4] 翻转 / 90° 旋转不越出选区 ===');
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  // 在左上角框一小块（远离文档中心），这样「绕文档中心翻」的错误一定会暴露
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(250);
  await page.evaluate(() => { const c = document.querySelector('#tpAuto'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  const c1 = await mk(200, 150), c2 = await mk(500, 380);
  await page.mouse.move(c1[0], c1[1]);
  await page.mouse.down();
  await page.mouse.move(c2[0], c2[1], { steps: 6 });
  await page.mouse.up();
  await sleep(900);
  s = await st();
  console.log('  选区:', JSON.stringify(s.bbox), ' transforming=' + s.transforming);
  check('框选后已进入变换（说明自动弹出仍生效）', s.transforming === true);

  const quadBefore = await page.evaluate(() => window.ChaApp.engine.transform.quad.map(p => [Math.round(p.x), Math.round(p.y)]));
  await page.evaluate(() => document.querySelector('#tpVFlip').click());
  await sleep(400);
  const quadAfter = await page.evaluate(() => window.ChaApp.engine.transform.quad.map(p => [Math.round(p.x), Math.round(p.y)]));
  const srcBox = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return { w: t.buf.width, h: t.buf.height, rect: t.rect };
  });
  console.log('  翻转前四边形:', JSON.stringify(quadBefore));
  console.log('  翻转后四边形:', JSON.stringify(quadAfter));
  console.log('  浮层尺寸:', JSON.stringify(srcBox));
  check('浮层尺寸 = 选区尺寸（不是整幅文档）',
    srcBox.w === (s.bbox.w | 0) && srcBox.h === (s.bbox.h | 0) || Math.abs(srcBox.w - s.bbox.w) <= 2,
    srcBox.w + '×' + srcBox.h + ' vs 选区 ' + s.bbox.w + '×' + s.bbox.h);

  // 四边形在垂直翻转前后应该只上下互换，外接框不变
  const bb = q => {
    const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
    return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs), y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys) };
  };
  const B0 = bb(quadBefore), B1 = bb(quadAfter);
  console.log('  翻转前后外接框:', JSON.stringify(B0), JSON.stringify(B1));
  check('垂直翻转后变换框仍停在原位置（没有跳脱选区）',
    Math.abs(B0.x0 - B1.x0) <= 2 && Math.abs(B0.x1 - B1.x1) <= 2 &&
    Math.abs(B0.y0 - B1.y0) <= 2 && Math.abs(B0.y1 - B1.y1) <= 2,
    JSON.stringify(B1));
  await page.screenshot({ path: path.join(OUT, 'p5-vflip.png') });

  // 90° 旋转同理
  await page.evaluate(() => document.querySelector('#tpRot90cw').click());
  await sleep(400);
  const quad90 = await page.evaluate(() => window.ChaApp.engine.transform.quad.map(p => [Math.round(p.x), Math.round(p.y)]));
  const B2 = bb(quad90);
  const w0 = B0.x1 - B0.x0, h0 = B0.y1 - B0.y0;
  const w90 = B2.x1 - B2.x0, h90 = B2.y1 - B2.y0;
  console.log('  90° 旋转后外接框:', JSON.stringify(B2), ' 宽高 ' + w90 + '×' + h90 + '（原 ' + w0 + '×' + h0 + '）');
  check('90° 旋转后宽高互换、中心不变',
    Math.abs(w90 - h0) <= 3 && Math.abs(h90 - w0) <= 3 &&
    Math.abs((B2.x0 + B2.x1) / 2 - (B0.x0 + B0.x1) / 2) <= 3,
    w90 + '×' + h90 + ' vs ' + h0 + '×' + w0);

  await page.evaluate(() => document.querySelector('#tpCancel').click());
  await sleep(500);

  console.log('\n页面错误:', errs.length ? errs.join(' | ') : '无');
  check('运行期间无 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
