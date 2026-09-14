/**
 * 生成 README 用的展示图（输出到 docs/）。
 * 用法: node tools/shots-readme.js [http://localhost:8437]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'docs');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1.6 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'Ankry');
  await page.fill('#newRoomName', '周末茶绘');
  await page.selectOption('#newRoomSize', '1920x1080');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(1200);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  async function stroke(pts, tool, size, color) {
    await page.click('#toolGrid .tool[data-item="' + tool + '"], #brushGrid .tool[data-item="' + tool + '"]');
    await sleep(180);
    await page.evaluate(([s, c]) => {
      const e = document.querySelector('#sizeRange');
      e.value = s; e.dispatchEvent(new Event('input', { bubbles: true }));
      const h = document.querySelector('#hexInput');
      h.value = c; h.dispatchEvent(new Event('change', { bubbles: true }));
    }, [size, color]);
    await sleep(150);
    const p0 = await mk(pts[0][0], pts[0][1]);
    await page.mouse.move(p0[0], p0[1]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) {
      const p = await mk(pts[i][0], pts[i][1]);
      await page.mouse.move(p[0], p[1]);
      await sleep(10);
    }
    await page.mouse.up();
    await sleep(250);
  }

  // ── 1) 主界面：画点东西 ──
  const wave = [];
  for (let i = 0; i <= 40; i++) wave.push([180 + i * 34, 420 + Math.sin(i / 6) * 90]);
  await stroke(wave, 'pencil', 4, '#2b2b2b');
  const curve = [];
  for (let i = 0; i <= 30; i++) curve.push([300 + i * 40, 680 - Math.sin(i / 8) * 60]);
  await stroke(curve, 'watercolor', 46, '#3f8be8');
  await stroke([[1250, 300], [1420, 380], [1500, 520], [1380, 640], [1220, 560], [1180, 420], [1250, 300]], 'airbrush', 70, '#e8544f');
  await page.evaluate(() => { const s = document.querySelector('#sizeRange'); s.value = 26; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await sleep(200);
  const p = await mk(760, 880);
  await page.mouse.move(p[0], p[1]);
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '01-主界面.png') });
  console.log('已存 docs/01-主界面.png');

  // ── 2) 选区 + 变换 ──
  await page.click('#toolGrid .tool[data-item="marquee"], #brushGrid .tool[data-item="marquee"]');
  await sleep(250);
  const m1 = await mk(240, 300), m2 = await mk(1150, 640);
  await page.mouse.move(m1[0], m1[1]);
  await page.mouse.down();
  await page.mouse.move(m2[0], m2[1], { steps: 12 });
  await page.mouse.up();
  await sleep(1400);
  // 拖一个角做形变
  const q = await page.evaluate(() => window.ChaApp.engine.transform ? window.ChaApp.engine.transform.quad : null);
  if (q) {
    const f = await mk(q[2].x, q[2].y), t = await mk(q[2].x - 150, q[2].y - 90);
    await page.mouse.move(f[0], f[1]);
    await page.mouse.down();
    await page.mouse.move(t[0], t[1], { steps: 10 });
    await page.mouse.up();
    await sleep(400);
  }
  await page.screenshot({ path: path.join(OUT, '02-选区与变换.png') });
  console.log('已存 docs/02-选区与变换.png');
  await page.evaluate(() => { const b = document.querySelector('#tpCancel'); if (b) b.click(); });
  await sleep(500);

  // ── 3) 图像大小对话框 ──
  await page.evaluate(() => document.querySelector('#btnCanvas').click());
  await sleep(600);
  const cb = await page.locator('#confirmMask .modal').boundingBox();
  await page.screenshot({
    path: path.join(OUT, '03-图像大小.png'),
    clip: { x: Math.max(0, cb.x - 6), y: Math.max(0, cb.y - 6), width: cb.width + 12, height: cb.height + 12 }
  });
  console.log('已存 docs/03-图像大小.png');
  await page.evaluate(() => document.querySelector('#confirmNo').click());
  await sleep(400);

  // ── 4) 笔刷样张 ──
  // 另开一张干净的画布。以前是在上面那个房间里手工清 engine 内部状态，
  // 结果视图变换被搞坏：笔迹画不出来，逐支样张的裁剪坐标也错到左栏上去了。
  const bpage = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1.6 });
  await bpage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await bpage.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await bpage.fill('#nameInput', 'Ankry');
  await bpage.fill('#newRoomName', '笔刷样张');
  await bpage.selectOption('#newRoomSize', '1920x1080');
  await bpage.click('#btnCreateRoom');
  await bpage.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await bpage.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(500);
  await bpage.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(500);
  const bbox = await bpage.locator('#view').boundingBox();
  // 用文档坐标定位，不受 letterbox 留白影响（按视口比例布点会把首尾两条甩到画布外的灰底上）
  const bmk = async (x, y) => {
    const s = await bpage.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [bbox.x + s.x, bbox.y + s.y];
  };

  // 每支笔一条不同颜色的线，一眼能分清哪条是哪支；橡皮擦不在这里演示
  // （白底上擦不出可见痕迹，它出现在笔刷栏里就够了）。
  const tools = [
    ['pencil', '#2b2b2b'],
    ['pencilSoft', '#5c5c5c'],
    ['airbrush', '#e8544f'],
    ['brush', '#2b8ae8'],
    ['watercolor', '#37a8d8'],
    ['marker', '#f0a92c'],
    ['effect', '#8a5cf0'],
    ['scatter', '#1fa971']
  ];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i][0], color = tools[i][1];
    await bpage.click('#toolGrid .tool[data-item="' + t + '"], #brushGrid .tool[data-item="' + t + '"]');
    await sleep(160);
    await bpage.evaluate((c) => {
      const e = document.querySelector('#sizeRange'); e.value = 46; e.dispatchEvent(new Event('input', { bubbles: true }));
      const h = document.querySelector('#hexInput'); h.value = c; h.dispatchEvent(new Event('change', { bubbles: true }));
    }, color);
    await sleep(140);
    // 文档坐标：画布 1920×1080，八条线纵向均分在 150~990
    const y0 = 150 + i * 120;
    const a = await bmk(220, y0);
    const b = await bmk(1700, y0);
    await bpage.mouse.move(a[0], a[1]);
    await bpage.mouse.down();
    for (let k = 1; k <= 40; k++) {
      const s = k / 40;
      await bpage.mouse.move(a[0] + (b[0] - a[0]) * s, a[1] + Math.sin(s * Math.PI * 2) * 6);
    }
    await bpage.mouse.up();
    await sleep(220);
  }
  await bpage.screenshot({ path: path.join(OUT, '04-笔刷样张.png') });
  console.log('已存 docs/04-笔刷样张.png（每支笔一条线，颜色区分）');
  await bpage.close();

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
