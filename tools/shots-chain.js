/**
 * 拍接龙的展示图：开一局四人接龙，走到各个关键画面截下来。
 *
 * 和 test-chain-ui.js 的区别：那个是断言（对错），这个只出图。
 * 截图前一律过 tools/mask-page.js 脱敏。
 *
 * 用法：node tools/shots-chain.js [wsUrl]
 */
'use strict';

const { chromium } = require('./pw');
const path = require('path');
const fs = require('fs');
const http = require('http');
const MP = require('./mask-page');

const WS_URL = process.argv[2] || 'ws://127.0.0.1:8444/ws';
const BASE = (() => {
  const u = new URL(WS_URL);
  return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
})();
const OUT = path.resolve(__dirname, '..', 'docs');
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function installAutoConfirm(page) {
  await page.addInitScript(() => {
    function arm() {
      const mask = document.querySelector('#confirmMask');
      const yes = document.querySelector('#confirmYes');
      if (!mask || !yes) return;
      new MutationObserver(() => {
        if (mask.classList.contains('hidden')) return;
        setTimeout(() => { if (!mask.classList.contains('hidden')) yes.click(); }, 40);
      }).observe(mask, { attributes: true, attributeFilter: ['class'] });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
    else arm();
  });
}
async function seedName(page, name) {
  await page.addInitScript(n => {
    try { localStorage.setItem('chahu.name', n); } catch (e) { /* ignore */ }
  }, name);
}

async function shot(page, name) {
  await page.evaluate(MP.mask);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log('  → ' + path.relative(process.cwd(), file));
}

(async function main() {
  const info = await httpJson('/api/share');
  if (!info.chain) { console.error('对面服务端不认识 chain，先重启它'); process.exit(1); }
  console.log('拍接龙展示图 → ' + BASE);

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  const names = ['阿岚', '小满', '青禾', '白露'];
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const p = await ctx.newPage();
    await installAutoConfirm(p);
    await seedName(p, names[i]);
    pages.push(p);
  }
  const host = pages[0];

  // 建房
  await host.goto(BASE + '/');
  await host.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await host.fill('#nameInput', names[0]);
  await host.fill('#newRoomName', '接龙一局');
  await host.click('#btnCreateRoom');
  await host.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 15000 });
  const roomId = await host.evaluate(() => window.ChaApp.state.room.id);
  await host.evaluate(() => { const b = document.querySelector('#btnEntryClose'); if (b && b.offsetParent) b.click(); });

  for (let i = 1; i < 4; i++) {
    await pages[i].goto(BASE + '/?room=' + encodeURIComponent(roomId));
    await pages[i].waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 15000 });
    await pages[i].evaluate(() => { const b = document.querySelector('#btnEntryClose'); if (b && b.offsetParent) b.click(); });
  }
  await sleep(1200);

  // 开局面板（顺便展示主题词库里有什么）
  await host.click('#btnGame');
  await sleep(300);
  await host.click('#gmChain');
  await sleep(200);
  await host.click('#btnGameStart');
  await sleep(900);
  await host.selectOption('#chainTheme', 'bluearchive');
  await sleep(300);
  console.log('[1] 接龙开局面板');
  await shot(host, '06-chain-setup.png');

  // 开局 → 写词
  await host.click('#btnChainStart');
  await sleep(1600);
  console.log('[2] 写词面板');
  await shot(host, '07-chain-write.png');

  // 每人挑一个候选词
  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-choice'); if (b) b.click(); });
  }
  await sleep(2200);

  // 作画：每人画一笔再交
  console.log('[3] 作画中');
  for (const p of pages) {
    const box = await p.locator('#view').boundingBox();
    const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
    await p.mouse.move(cx - 110, cy - 60);
    await p.mouse.down();
    for (let k = 1; k <= 12; k++) {
      await p.mouse.move(cx - 110 + k * 19, cy - 60 + Math.sin(k / 1.7) * 34);
    }
    await p.mouse.up();
    await sleep(200);
  }
  await shot(host, '08-chain-draw.png');

  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-submit'); if (b) b.click(); });
    await sleep(250);
  }
  await sleep(2400);

  // 猜词（把图给大家看一眼）
  console.log('[4] 猜词面板');
  await shot(host, '09-chain-guess.png');

  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-guess'); if (b) b.click(); });
    await sleep(200);
    await p.evaluate(() => {
      const i = document.querySelector('#ciInput');
      if (i) { i.value = '猫'; i.dispatchEvent(new Event('input', { bubbles: true })); }
      const s = document.querySelector('#ciSubmit');
      if (s) s.click();
    });
    await sleep(250);
  }
  await sleep(2600);

  // 回放 / 投票
  console.log('[5] 回放 + 投票');
  await shot(host, '10-chain-replay.png');

  // 全部投「对得上」→ 结算
  await host.click('#rpVoteOk');
  await sleep(400);
  await host.click('#btnRpNext');
  await sleep(1500);
  console.log('[6] 奖杯结算');
  await shot(host, '11-chain-trophy.png');

  await host.evaluate(() => { try { window.ChaApp.net.send(window.ChaApp.P.C2S.ROOM_DESTROY, {}); } catch (e) {} });
  await sleep(400);
  await browser.close();
  console.log('\n完成，图在 docs/');
})().catch(e => { console.error('崩了：', e); process.exit(1); });
