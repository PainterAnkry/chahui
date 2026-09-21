/**
 * 覆盖层回归：画布上不该有多余的框和椭圆。
 *
 * 两个曾经的真实缺陷：
 *   1) 选区预览和「形状 / 渐变预览」共用 previewStroke，于是框选 / 套索的实时框
 *      被当成形状来画 —— shapePath 的 else 分支是椭圆，画布上冒出一个大椭圆。
 *   2) overlay 每帧都沿画布边界描一圈 strokeRect，白纸上多一个碍眼的方框。
 *
 * 用法: node tools/test-overlay.js
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(process.argv[2] || 'http://localhost:8437/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '覆盖层');
  await page.fill('#newRoomName', '覆盖层回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  await page.evaluate(() => { const c = document.querySelector('#tpAuto'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });

  /** overlay 上的墨迹统计（overlay 是透明的，用 alpha 判） */
  const overlayInk = () => page.evaluate(() => {
    const v = document.querySelector('#overlay');
    const d = v.getContext('2d').getImageData(0, 0, v.width, v.height).data;
    let n = 0;
    const rows = new Set();
    for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
    return { ink: n, w: v.width, h: v.height, rows: rows.size };
  });

  /** overlay 上某个屏幕坐标附近有没有墨 */
  const inkAt = (sx, sy, r) => page.evaluate(([cx, cy, rr]) => {
    const v = document.querySelector('#overlay');
    const box = v.getBoundingClientRect();
    const d = window.ChaApp.engine.dpr;
    const x0 = Math.max(0, Math.round((cx - box.left) * d) - rr);
    const y0 = Math.max(0, Math.round((cy - box.top) * d) - rr);
    const w = Math.min(v.width - x0, rr * 2 + 1), h = Math.min(v.height - y0, rr * 2 + 1);
    const px = v.getContext('2d').getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 30) n++;
    return n;
  }, [sx, sy, r]);

  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => { const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]); return [box.x + s.x, box.y + s.y]; };

  /* ---------- 1) 空闲时 overlay 应该是空的 ---------- */
  console.log('\n=== 空闲状态 ===');
  await page.mouse.move(box.x + 40, box.y + 40);
  await sleep(400);
  const idle = await overlayInk();
  console.log('  overlay 墨迹 =', idle.ink, '（' + idle.w + '×' + idle.h + '）');
  check('空闲时画布上没有多余的框（画布边界已去掉）', idle.ink < 60, idle.ink + ' 像素');

  /* ---------- 2) 框选拖动中：只有虚线框，没有椭圆 ---------- */
  console.log('\n=== 框选拖动中 ===');
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(220);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 40; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const A1 = await mk(300, 300), A2 = await mk(900, 700);
  await page.mouse.move(A1[0], A1[1]);
  await page.mouse.down();
  await page.mouse.move(A2[0], A2[1], { steps: 10 });
  await sleep(500);
  const during = await overlayInk();
  // 内接椭圆的 45° 点：偏心的那个位置，虚线框绝不会经过那里
  const ec = await mk(300 + 300 + 300 * Math.cos(Math.PI / 4), 300 + 200 + 200 * Math.sin(Math.PI / 4));
  const onEllipse = await inkAt(ec[0], ec[1], 6);
  const onEdge = await inkAt((A1[0] + A2[0]) / 2, A1[1], 6);   // 上边中点，虚线框必经
  console.log('  拖动中 overlay 墨迹 =', during.ink, ' 内接椭圆 45° 处墨迹 =', onEllipse, ' 上边中点墨迹 =', onEdge);
  check('框选拖动中只有虚线框（墨迹量很小）', during.ink > 0 && during.ink < 12000, during.ink + ' 像素');
  check('虚线框画出来了（上边中点有墨）', onEdge > 0, String(onEdge));
  check('没有椭圆（内接椭圆位置无墨）', onEllipse === 0, String(onEllipse));

  await page.mouse.up();
  await sleep(700);

  /* ---------- 3) 套索拖动中同理 ---------- */
  console.log('\n=== 套索拖动中 ===');
  await page.evaluate(() => window.ChaApp.engine.restoreSelection(null));
  await page.click('#toolGrid .tool[data-item="lasso"]');
  await sleep(220);
  const L1 = await mk(400, 300);
  await page.mouse.move(L1[0], L1[1]);
  await page.mouse.down();
  for (const p of [[700, 350], [900, 500], [700, 700], [400, 650]]) {
    const q = await mk(p[0], p[1]);
    await page.mouse.move(q[0], q[1]);
    await sleep(20);
  }
  await sleep(500);
  const lassoInk = await overlayInk();
  console.log('  套索拖动中 overlay 墨迹 =', lassoInk.ink);
  check('套索拖动中也只有路径（没有椭圆）', lassoInk.ink > 0 && lassoInk.ink < 12000, lassoInk.ink + ' 像素');
  // ★ 2.0.9：拖拽中那条线**不能收口** —— 和 PS 一样，松手才闭合成圈。
  //   收口那条是 (400,650) → (400,300) 的竖线，取它中点（离已画的那几段都很远）：
  //   闭着的话这里一定有墨，开口的话一点都没有。
  const chord = await mk(400, 500);
  const onLine = await mk(800, 425);          // 已画的那条斜边的中点，对照组
  const chordInk = await inkAt(chord[0], chord[1], 6);
  const lineInk = await inkAt(onLine[0], onLine[1], 6);
  console.log('  收口竖线中点墨迹 =', chordInk, ' 已画斜边中点墨迹 =', lineInk);
  check('★ 套索拖拽中路径是**开口**的（收口那条线还没画）', chordInk === 0, String(chordInk));
  check('★ 对照组：已经拖过的那几段是有墨的（不是整条都没画）', lineInk > 0, String(lineInk));
  await page.mouse.up();
  await sleep(700);

  /* ---------- 3b. ★ 2.0.9：选区轮廓跟着形状走，不是包围盒方框 ---------- */
  console.log('\n=== 选区轮廓（蚂蚁线）沿真实形状 ===');
  /** 某个屏幕点附近的 overlay 墨迹：分「轮廓线（白/近黑）」和「选区蓝蒙层」两种 */
  const outlineAt = (sx, sy, r) => page.evaluate(([cx, cy, rr]) => {
    const v = document.querySelector('#overlay');
    const bx = v.getBoundingClientRect();
    const d = window.ChaApp.engine.dpr;
    const x0 = Math.max(0, Math.round((cx - bx.left) * d) - rr);
    const y0 = Math.max(0, Math.round((cy - bx.top) * d) - rr);
    const w = Math.min(v.width - x0, rr * 2 + 1), h = Math.min(v.height - y0, rr * 2 + 1);
    const px = v.getContext('2d').getImageData(x0, y0, w, h).data;
    let any = 0, line = 0, tint = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= 30) continue;
      any++;
      const r0 = px[i], g0 = px[i + 1], b0 = px[i + 2];
      // 蚂蚁线是白底 / 近黑的条纹（三个通道挨得近）；选区蒙层是蓝的（蓝远大于红）
      if (Math.max(r0, g0, b0) - Math.min(r0, g0, b0) < 40) line++;
      else if (b0 - r0 > 40) tint++;
    }
    return { any: any, line: line, tint: tint };
  }, [sx, sy, r]);
  const bb = await page.evaluate(() => window.ChaApp.engine.selection.bbox);
  console.log('  选区 bbox = ' + JSON.stringify(bb));
  const at = async (x, y) => { const p = await mk(x, y); return outlineAt(p[0], p[1], 5); };
  // 这个套索的 bbox = (400,300)-(900,700)，但右下角 / 左下角都落在多边形**外面**
  const c1 = await at(895, 695);
  const c2 = await at(405, 695);
  const edgeClose = await at(400, 500);   // 收口那条边（x=400）
  const edgeDiag = await at(800, 425);    // 斜边中点
  const inner = await at(600, 500);       // 选区内部
  console.log('  包围盒角: ' + JSON.stringify(c1) + ' / ' + JSON.stringify(c2) +
    ' 收口边: ' + JSON.stringify(edgeClose) + ' 斜边: ' + JSON.stringify(edgeDiag) +
    ' 内部: ' + JSON.stringify(inner));
  check('★ 包围盒的角上**没有**虚线（不再是「虚线方框」）', c1.any === 0 && c2.any === 0,
    JSON.stringify({ c1: c1, c2: c2 }));
  check('★ 沿着套索真实形状的虚线画出来了（收口那条边上）', edgeClose.line > 0, JSON.stringify(edgeClose));
  check('★ 斜边上也有（跟着形状拐弯）', edgeDiag.line > 0, JSON.stringify(edgeDiag));
  check('★ 选区内部只有蓝色蒙层、没有边界线（轮廓是「边」不是「框」）',
    inner.line === 0 && inner.tint > 0, JSON.stringify(inner));

  /* ---------- 4) 形状工具自己仍然有预览 ---------- */
  console.log('\n=== 形状工具预览没被误伤 ===');
  await page.evaluate(() => window.ChaApp.engine.restoreSelection(null));
  await page.click('#toolGrid .tool[data-item="ellipse"]');
  await sleep(220);
  const E1 = await mk(300, 300), E2 = await mk(700, 600);
  await page.mouse.move(E1[0], E1[1]);
  await page.mouse.down();
  await page.mouse.move(E2[0], E2[1], { steps: 8 });
  await sleep(450);
  const ellipseInk = await overlayInk();
  console.log('  椭圆工具拖动中 overlay 墨迹 =', ellipseInk.ink);
  check('椭圆工具自己的预览还在', ellipseInk.ink > 500, ellipseInk.ink + ' 像素');
  await page.mouse.up();
  await sleep(500);

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
