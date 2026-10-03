/**
 * 临时：验证 ① 子菜单紧贴父菜单（backdrop-filter 包含块回归）② 尺子 SAI2 化外观。
 * 用法: node tools/shots-ruler-menu.js [http://localhost:8440]
 * 输出到 .tmp-rooms-uiglass/
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
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('shot', name); };

  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'Ankry');
  await page.fill('#newRoomName', '尺子与子菜单');
  await page.selectOption('#newRoomSize', '1920x1080');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(1000);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);

  // ---------- ① 子菜单定位 ----------
  await page.click('.menu-title[data-menu="window"]');
  await sleep(420);
  // 悬停到「界面主题」触发子菜单
  const row = page.locator('.menu-row', { hasText: '界面主题' }).first();
  await row.hover();
  await sleep(450);
  await shot('10-submenu-fix');

  // 记录几何：子菜单应紧贴父菜单右缘
  const geo = await page.evaluate(() => {
    const open = document.querySelector('.menu-drop:not(.hidden)');
    const sub = document.querySelector('.menu-sub:not(.hidden)');
    if (!open || !sub) return null;
    const a = open.getBoundingClientRect(), b = sub.getBoundingClientRect();
    return { dropRight: Math.round(a.right), dropTop: Math.round(a.top), subLeft: Math.round(b.left), subTop: Math.round(b.top), gap: Math.round(b.left - a.right) };
  });
  console.log('submenu geometry', JSON.stringify(geo));
  await page.keyboard.press('Escape');
  await page.mouse.click(760, 880);
  await sleep(300);

  // ---------- ② 五种尺子 ----------
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  async function dragRuler(pts) {
    const p0 = await mk(pts[0][0], pts[0][1]);
    await page.mouse.move(p0[0], p0[1]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) {
      const p = await mk(pts[i][0], pts[i][1]);
      await page.mouse.move(p[0], p[1], 6);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(420);
  }
  async function arm(type) {
    await page.evaluate(t => window.ChaApp.armRuler(t), type);
    await sleep(250);
  }

  await arm('line');
  await dragRuler([[600, 500], [1350, 520]]);
  await shot('11-ruler-line');

  await arm('ellipse');
  await dragRuler([[700, 300], [1250, 700]]);
  await shot('12-ruler-ellipse');

  await arm('parallel');
  await dragRuler([[650, 480], [1300, 560]]);
  await shot('13-ruler-parallel');

  await arm('circle');
  await dragRuler([[960, 500], [1220, 500]]);
  await shot('14-ruler-circle');

  await arm('radial');
  await dragRuler([[960, 500], [1160, 380]]);
  await shot('15-ruler-radial');

  // ---------- ③ 尺子拖动（移动把手） ----------
  await arm('line');
  await dragRuler([[600, 500], [1350, 530]]);
  // 把手在拖拽中点附近，抓住它往下拖
  const h0 = await mk(975, 515);
  await page.mouse.move(h0[0], h0[1]);
  await sleep(120);
  const cur = await page.evaluate(() => document.querySelector('#view').style.cursor);
  console.log('hover cursor on handle =', JSON.stringify(cur));
  await page.mouse.down();
  const h1 = await mk(975, 700);
  await page.mouse.move(h1[0], h1[1], 8);
  await sleep(60);
  await page.mouse.up();
  await sleep(400);
  await shot('16-ruler-moved');
  const snapCheck = await page.evaluate(() => {
    const r = window.ChaApp.engine.ruler;
    return r ? { type: r.type, p0: r.p0, p1: r.p1 } : null;
  });
  console.log('after move', JSON.stringify(snapCheck));

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
