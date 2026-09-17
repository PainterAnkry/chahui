/**
 * 出图：各尺寸下的界面截图（人工过目用，不进仓库）。
 * 用法： node tools/shot-mobile.js http://127.0.0.1:8444 [输出目录]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, 'pw'));
const BASE = (process.argv[2] || 'http://127.0.0.1:8444').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(__dirname, '..', '.workbuddy', 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function enterRoom(page, name) {
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(600);
  await page.evaluate((n) => {
    document.querySelector('#nameInput').value = n;
    document.querySelector('#newRoomName').value = '窄屏预览';
    document.querySelector('#btnCreateRoom').click();
  }, name);
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 }).catch(() => {});
  await sleep(700);
  await page.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  await sleep(300);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
  const shots = [];

  const SIZES = [
    { name: 'desktop-1440', w: 1440, h: 900, touch: false },
    { name: 'tablet-1024', w: 1024, h: 768, touch: true },
    { name: 'tablet-820', w: 820, h: 1180, touch: true },
    { name: 'phone-390', w: 390, h: 844, touch: true, mobile: true }
  ];

  for (const s of SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: s.w, height: s.h },
      hasTouch: !!s.touch, isMobile: !!s.mobile, deviceScaleFactor: s.mobile ? 2 : 1
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await enterRoom(page, s.name);
    let f = path.join(OUT, s.name + '.png');
    await page.screenshot({ path: f });
    shots.push(f);

    if (s.w <= 1080) {
      // 打开左抽屉看一眼
      await page.click('#leftRail').catch(() => {});
      await sleep(450);
      f = path.join(OUT, s.name + '-left-drawer.png');
      await page.screenshot({ path: f });
      shots.push(f);
      await page.click('#drawerBack', { position: { x: s.w - 20, y: 300 } }).catch(() => {});
      await sleep(400);
      // 打开右抽屉
      await page.click('#sideRail').catch(() => {});
      await sleep(450);
      f = path.join(OUT, s.name + '-right-drawer.png');
      await page.screenshot({ path: f });
      shots.push(f);
    }
    await ctx.close();
  }

  await browser.close();
  shots.forEach(f => console.log(f));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
