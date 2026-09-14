/**
 * 笔迹连续性回归测试。
 *
 * 背景：实时落笔如果「只补画新增的那一段」，每批点都是一条独立的 polyline，
 * 批次之间是平头（butt cap）对接 —— 抗锯齿在接缝处各留一半，屏幕上就是一圈淡竖缝；
 * 笔头转向时还会露出楔形缺口。松手时 endStroke 会整笔重画一次，缝随之消失，
 * 所以用户看到的是「笔画断断续续，过一会儿才连上」。
 * 现在实时预览改成整笔重画（paintToScratch），画中质量应当与画后一致。
 *
 * 用法: node tools/test-stroke.js
 */
'use strict';
const path = require('path');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '一致性');
  await page.fill('#newRoomName', '画中与画后一致性');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoom100').click());
  await sleep(400);

  // 取 #view 里那块区域的像素；纸是不透明的，所以用**亮度**判墨，不能用 alpha
  const analyze = () => page.evaluate(() => {
    const v = document.querySelector('#view');
    const ctx = v.getContext('2d');
    const dpr = window.ChaApp.engine.dpr;
    const W = v.width, H = v.height;
    const band = 40 * dpr;
    const y0 = Math.round(H / 2 - band / 2);
    const img = ctx.getImageData(0, y0, W, band).data;
    const colDark = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = 0; y < band; y++) {
        const i = (y * W + x) * 4;
        // 反相亮度：越黑值越大
        sum += 255 - (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114);
      }
      colDark[x] = sum / band;
    }
    let peak = 0;
    for (let x = 0; x < W; x++) if (colDark[x] > peak) peak = colDark[x];
    if (peak < 5) return { span: 0, dips: 0, worst: 0, med: 0 };   // 淡到测不出
    // 阈值跟着笔刷浓度走：喷枪只有 12% 浓度，用固定阈值会误判成「压根没画上」
    const thr = Math.max(2, peak * 0.2);
    let first = -1, last = -1;
    for (let x = 0; x < W; x++) if (colDark[x] > thr) { if (first < 0) first = x; last = x; }
    if (first < 0 || last - first < 20) return { span: 0, dips: 0, worst: 0, med: 0 };
    const mid = [];
    for (let x = first + 4; x <= last - 4; x++) mid.push(colDark[x]);
    const sorted = mid.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    let dips = 0, worst = 0;
    for (let x = first + 4; x <= last - 4; x++) {
      if (colDark[x] < med * 0.9) { dips++; worst = Math.max(worst, 1 - colDark[x] / med); }
    }
    return { span: last - first + 1, med: +med.toFixed(1), dips, worst: +(worst * 100).toFixed(1) };
  });

  const clear = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
    e.pending.clear();
  });

  const box = await page.locator('#view').boundingBox();
  const y = box.y + box.height / 2;
  const x0 = box.x + 120, x1 = box.x + 850;

  for (const tool of ['pencil', 'pencilSoft', 'brush', 'watercolor', 'marker', 'airbrush']) {
    await clear();
    await sleep(250);
    await page.click('#toolGrid .tool[data-item="' + tool + '"], #brushGrid .tool[data-item="' + tool + '"]');
    await sleep(220);
    await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 24; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(150);
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 40, y); await sleep(20); }
    await sleep(250);
    const during = await analyze();
    await page.mouse.up();
    await sleep(200);
    const after = await analyze();
    console.log('  ' + tool.padEnd(11) +
      '  画中: 跨距=' + during.span + ' 中位深度=' + during.med + ' 竖缝列=' + during.dips + ' 最深=' + during.worst + '%' +
      '  | 画后: 跨距=' + after.span + ' 竖缝列=' + after.dips);
    check(tool + ' 画中笔迹是连续的（竖缝数不超过画后的 3 倍 + 5）',
      during.span > 600 && during.dips <= after.dips * 3 + 5,
      '画中 ' + during.dips + ' vs 画后 ' + after.dips);
  }
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
