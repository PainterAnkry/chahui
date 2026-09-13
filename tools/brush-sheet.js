/**
 * 笔刷样张：把工具栏里每一支笔各画一条，逐条裁图，用来对照 SAI2 的手感。
 * 用法: node tools/_brush-sheet.js
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

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '笔刷样张');
  await page.fill('#newRoomName', '笔刷样张房');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => {
    document.querySelector('#entryMask').classList.add('hidden');
    // 画布放大到能看清笔触
    window.ChaApp.state.room.width = 1600;
    window.ChaApp.engine.setZoom(1);
  });
  await sleep(400);

  const items = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#toolGrid .tool')).map(b => ({ id: b.dataset.item, tool: b.dataset.tool })));
  console.log('工具栏条目:', items.map(i => i.id).join(', '));

  const box = await page.locator('#view').boundingBox();
  // 只画真正的「笔刷」：油漆桶一拖就把整张画布填黑，渐变/涂抹/模糊也不是「画一条线」的交互。
  // 选区笔会留下选区把后面每一笔裁掉，吸管不落笔。
  const usable = items.filter(i =>
    ['pencil', 'pencilSoft', 'airbrush', 'brush', 'watercolor', 'marker', 'eraser', 'effect', 'scatter'].indexOf(i.id) >= 0);
  const perPage = 13;                     // 13 × 58px = 754px，塞得进 866px 的画布区
  const batches = [];
  for (let i = 0; i < usable.length; i += perPage) batches.push(usable.slice(i, i + perPage));

  const info = [];
  for (let bi = 0; bi < batches.length; bi++) {
    if (bi > 0) {
      // 换一批：清空画布，从顶部重新画
      await page.evaluate(() => {
        const e = window.ChaApp.engine;
        e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; });
        e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
        e.selectAll(); e.clearSelection();
        e.invalidate();
      });
      await sleep(500);
    }
    let y = 80;
    for (const it of batches[bi]) {
      await page.click('#toolGrid .tool[data-item="' + it.id + '"]');
      await sleep(140);
      await page.evaluate(() => { if (window.ChaApp.engine.hasSelection()) window.ChaApp.engine.clearSelection(); });
      await page.evaluate(() => {
        const e = document.querySelector('#sizeRange');
        e.value = 22; e.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(120);
      const x0 = box.x + 90, x1 = box.x + 820;
      const yy = box.y + y;
      await page.mouse.move(x0, yy);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) await page.mouse.move(x0 + (x1 - x0) * i / 40, yy + Math.sin(i / 7) * 5);
      await page.mouse.up();
      await sleep(240);
      // 标个名字（用聊天框记录），方便对照
      info.push({ id: it.id, y: y, batch: bi });
      y += 58;
    }
    await page.screenshot({ path: path.join(OUT, 'brush-sheet-' + (bi + 1) + '.png') });
    console.log('已存 brush-sheet-' + (bi + 1) + '.png（' + batches[bi].map(i => i.id).join(', ') + '）');
  }

  const arginfo = await page.evaluate(() => {
    const out = {};
    (window.ChaBrushes ? window.ChaBrushes.ITEMS : []).forEach(function (i) { out[i.id] = i.params; });
    return out;
  });
  console.log('\n各笔刷参数:');
  Object.keys(arginfo).forEach(k => {
    const p = arginfo[k];
    console.log('  ' + k.padEnd(12) +
      ' size=' + String(p.size).padStart(3) +
      ' op=' + String(p.opacity).padStart(4) +
      ' hard=' + String(p.hardness).padStart(4) +
      ' min=' + String(p.minSize).padStart(4) +
      ' pS=' + String(p.pressSize).padStart(4) +
      ' pO=' + String(p.pressOpacity).padStart(4) +
      ' edge=' + String(p.edge).padStart(4) +
      ' scat=' + String(p.scatter).padStart(4) +
      ' grain=' + String(p.grain).padStart(4) +
      ' paper=' + p.paper);
  });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
