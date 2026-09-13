/**
 * 生成展示用截图：完整界面 + 图层混合模式列表 + 表情面板
 * 用法: node tools/shots.js [http://localhost:8437]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1.4 });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 8000 });
  await page.fill('#nameInput', '绘画小白');
  await page.fill('#newRoomName', 'SAI2 风格茶绘室');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(500);
  // 收起入口遮罩，让左栏完整可见
  await page.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  await sleep(300);

  // ── 1) 完整界面：选水彩笔并画几笔 ──
  await page.click('#toolGrid .tool[data-item="watercolor"]');
  await sleep(300);
  await page.evaluate(() => {
    const el = document.querySelector('#sizeRange');
    el.value = 34; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);

  const box = await page.locator('#view').boundingBox();
  async function stroke(fx0, fy0, fx1, fy1, wobble) {
    const x0 = box.x + fx0 * box.width, y0 = box.y + fy0 * box.height;
    const x1 = box.x + fx1 * box.width, y1 = box.y + fy1 * box.height;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      const t = i / 30;
      await page.mouse.move(x0 + (x1 - x0) * t,
        y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 2) * (wobble || 22));
    }
    await page.mouse.up();
    await sleep(220);
  }
  await stroke(0.16, 0.3, 0.5, 0.55, 26);
  await sleep(150);
  await page.click('#toolGrid .tool[data-item="airbrush"]');
  await sleep(250);
  await page.evaluate(() => {
    const el = document.querySelector('#sizeRange');
    el.value = 90; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await stroke(0.55, 0.72, 0.86, 0.35, 14);
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'A-完整界面.png') });
  console.log('已保存 A-完整界面.png');

  // ── 2) 图层混合模式下拉（展开列表）──
  await page.evaluate(() => {
    const sel = document.querySelector('#layerBlend');
    sel.size = Math.min(17, sel.options.length);
    sel.style.height = 'auto';
    sel.style.position = 'relative';
    sel.style.zIndex = '99';
    sel.style.background = '#fff';
    // 找到左栏的滚动容器，把下拉顶到容器最上方，保证 17 项全部落在可视区内
    let box = sel.parentElement;
    while (box && box !== document.body) {
      const oy = getComputedStyle(box).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight + 4) break;
      box = box.parentElement;
    }
    if (box && box !== document.body) {
      const delta = sel.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop = box.scrollTop + delta - 8;
    }
  });
  await sleep(400);
  const blendCount = await page.evaluate(() => document.querySelector('#layerBlend').options.length);
  console.log('图层混合模式条目数 =', blendCount);
  const lb = await page.locator('#layerBlend').boundingBox();
  await page.screenshot({ path: path.join(OUT, 'B-图层混合模式.png') });
  // 再补一张聚焦下拉本身的局部图
  if (lb) {
    const top = Math.max(0, lb.y - 10);
    await page.screenshot({
      path: path.join(OUT, 'B2-混合模式列表.png'),
      clip: {
        x: Math.max(0, lb.x - 14),
        y: top,
        width: Math.min(1500 - Math.max(0, lb.x - 14), lb.width + 28),
        height: Math.min(940 - top, lb.height + 20)
      }
    });
    console.log('已保存 B2-混合模式列表.png');
  }

  await page.evaluate(() => {
    const sel = document.querySelector('#layerBlend');
    sel.size = 0; sel.style.position = ''; sel.style.zIndex = ''; sel.style.height = ''; sel.style.background = '';
  });
  await sleep(200);

  // ── 3) 表情面板 ──
  await page.evaluate(() => document.querySelector('#btnSticker').click());
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'C-表情面板.png') });
  console.log('已保存 C-表情面板.png');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
