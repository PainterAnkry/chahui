/**
 * 临时：液态玻璃 UI 改版验收截图（浅色 + 深色双主题）。
 * 用法: node tools/shots-uiglass.js [http://localhost:8440]
 * 输出到 .tmp-uiglass/
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://localhost:8440';
const OUT = path.resolve(__dirname, '..', '.tmp-rooms-uiglass');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('shot', name);
  };

  // ---------- 入口弹窗（浅色） ----------
  await page.waitForSelector('#entryMask:not(.hidden)');
  await sleep(600);
  await shot('01-entry-light');

  // ---------- 建房进画布 ----------
  await page.fill('#nameInput', 'Ankry');
  await page.fill('#newRoomName', '周末茶绘');
  await page.selectOption('#newRoomSize', '1920x1080');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(1200);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);

  // ---------- 画几笔 ----------
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  async function stroke(pts, tool, size, color) {
    await page.click('#toolGrid .tool[data-item="' + tool + '"], #brushGrid .tool[data-item="' + tool + '"]');
    await sleep(200);
    await page.evaluate(([s, c]) => {
      const e = document.querySelector('#sizeRange');
      if (e) { e.value = s; e.dispatchEvent(new Event('input', { bubbles: true })); }
      const h = document.querySelector('#hexInput');
      if (h) { h.value = c; h.dispatchEvent(new Event('change', { bubbles: true })); }
    }, [size, color]);
    await sleep(180);
    const p0 = await mk(pts[0][0], pts[0][1]);
    await page.mouse.move(p0[0], p0[1]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) {
      const p = await mk(pts[i][0], pts[i][1]);
      await page.mouse.move(p[0], p[1]);
      await sleep(8);
    }
    await page.mouse.up();
    await sleep(120);
  }
  await stroke([[380, 320], [520, 480], [700, 360], [900, 520], [1100, 400]], 'pencil', 18, '#2f7de1');
  await stroke([[400, 700], [640, 620], [880, 720], [1150, 640]], 'marker', 34, '#d9534f');
  await stroke([[600, 250], [760, 300], [950, 240]], 'hardRound', 8, '#1f2228');
  await sleep(400);

  // ---------- 主界面（浅色，含快捷栏 / 图层面板 / 聊天） ----------
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="chat"]'); t && t.click(); });
  await page.evaluate(() => {
    const inp = document.querySelector('#chatInput');
    if (inp) {
      inp.value = '这块颜色再暖一点？';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.keyboard.press('Enter');
  await sleep(300);
  await shot('02-main-light');

  // ---------- 下拉菜单（浅色） ----------
  await page.click('.menu-title[data-menu="layer"]');
  await sleep(450);
  await shot('03-menu-light');
  await page.keyboard.press('Escape');
  await page.mouse.click(750, 900);
  await sleep(250);

  // ---------- 右键笔刷格子（浅色） ----------
  const brushCell = page.locator('#brushGrid .tool').first();
  if (await brushCell.count()) {
    await brushCell.click({ button: 'right' });
    await sleep(420);
    await shot('04-ctx-light');
    await page.mouse.click(750, 900);
    await sleep(250);
  }

  // ---------- 画布设置弹窗（浅色）----------
  // 注意：#btnCanvas 的「图像大小」复用 #confirmMask（app.js openCanvasDialog）
  await page.click('#btnCanvas');
  await sleep(600);
  await shot('05-canvasdlg-light');
  await page.evaluate(() => document.querySelector('#confirmMask').classList.add('hidden'));
  await sleep(250);

  // ---------- 深色主题 ----------
  await page.evaluate(() => window.ChaApp.setUiTheme('dark'));
  await sleep(500);
  await shot('02-main-dark');

  await page.click('.menu-title[data-menu="layer"]');
  await sleep(450);
  await shot('03-menu-dark');
  await page.mouse.click(750, 900);
  await sleep(250);

  if (await brushCell.count()) {
    await brushCell.click({ button: 'right' });
    await sleep(420);
    await shot('04-ctx-dark');
    await page.mouse.click(750, 900);
    await sleep(250);
  }

  await page.click('#btnCanvas');
  await sleep(600);
  await shot('05-canvasdlg-dark');

  // 入口弹窗深色：先关掉可能弹出的「放弃修改」确认，再点房间按钮重新打开
  await page.evaluate(() => {
    document.querySelector('#confirmMask').classList.add('hidden');
    document.querySelector('#csizeMask').classList.add('hidden');
  });
  await sleep(300);
  await page.click('#btnRooms');
  await sleep(700);
  await shot('01-entry-dark');

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
