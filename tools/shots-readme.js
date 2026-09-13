/**
 * 生成 README 用的展示图（输出到 docs/）。
 * 用法: node tools/shots-readme.js [http://localhost:8437]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
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
  await page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
    e.pending.clear(); e.clearSelection(); e.invalidate();
    e.setZoom(1);
  });
  await sleep(600);
  const tools = ['pencil', 'pencilSoft', 'airbrush', 'brush', 'watercolor', 'marker', 'eraser', 'effect', 'scatter'];
  const names = { pencil: '铅笔', pencilSoft: '软铅笔', airbrush: '喷枪', brush: '画笔', watercolor: '水彩笔', marker: '马克笔', eraser: '橡皮擦', effect: '特效笔', scatter: '散布' };
  let y = 150;
  for (const t of tools) {
    await page.click('#toolGrid .tool[data-item="' + t + '"], #brushGrid .tool[data-item="' + t + '"]');
    await sleep(160);
    await page.evaluate(() => {
      const e = document.querySelector('#sizeRange'); e.value = 22; e.dispatchEvent(new Event('input', { bubbles: true }));
      const h = document.querySelector('#hexInput'); h.value = '#2b2b2b'; h.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(140);
    const a = await mk(120, y), b = await mk(1250, y + Math.sin(1) * 0);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(a[0] + (b[0] - a[0]) * i / 40, a[1] + Math.sin(i / 6) * 6);
    await page.mouse.up();
    await page.screenshot({ path: path.join(OUT, 'brush-' + t + '.png'), clip: { x: a[0] - 14, y: a[1] - 26, width: (b[0] - a[0]) + 28, height: 52 } });
    void names;
    await sleep(220);
    y += 100;
  }
  await page.screenshot({ path: path.join(OUT, '04-笔刷样张.png') });
  console.log('已存 docs/04-笔刷样张.png 与逐支样张 brush-*.png');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
