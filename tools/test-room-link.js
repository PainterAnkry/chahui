/**
 * ★ 2.0.10 房间链接：分享出去的链接，应用端要能**认出来并直接进房**。
 *
 * 三种形态都要认：http(s) 分享链接、chahui:// 应用链接、光一个房间号。
 * 用法: node tools/test-room-link.js [http://127.0.0.1:8440]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '链接');
  await page.fill('#newRoomName', '链接房');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  const roomId = await page.evaluate(() => window.ChaApp.state.room.id);

  console.log('\n[1] 链接解析');
  const cases = await page.evaluate(([rid]) => {
    const f = window.ChaApp.parseRoomLink;
    return {
      http: f('http://139.199.90.209/?room=' + rid),
      https: f('https://example.com/?room=' + rid),
      app: f('chahui://join?room=' + rid + '&server=ws%3A%2F%2F1.2.3.4%3A8437%2Fws'),
      bare: f(rid),
      name: f('周末茶绘'),
      junk: f('看看这个 https://example.com/'),
      empty: f('')
    };
  }, [roomId]);
  console.log('  ' + JSON.stringify(cases));
  check('★ http 分享链接 → 房间号 + 同源 ws 服务器',
    cases.http.roomId === roomId && /^ws:\/\/139\.199\.90\.209\/ws$/.test(cases.http.server), cases.http);
  check('★ https 链接 → wss', /^wss:\/\//.test(cases.https.server), cases.https.server);
  check('★ chahui:// 应用链接 → 房间号 + 链接里带的服务器',
    cases.app.roomId === roomId && cases.app.server === 'ws://1.2.3.4:8437/ws', cases.app);
  check('★ 光一个房间号也认', cases.bare.roomId === roomId, cases.bare);
  check('★ 房间名（带空格的中文）不会被当成房间号', cases.name.roomId === '', cases.name);
  check('★ 没有 room 参数的网页链接认不出来（不瞎猜）', cases.junk.roomId === '', cases.junk);
  check('★ 空串安全', cases.empty.roomId === '', cases.empty);

  console.log('\n[2] 分享出来的是什么');
  const share = await page.evaluate(() => ({
    app: window.ChaApp.appRoomLink(),
    inputVisible: !!document.querySelector('#joinLinkInput')
  }));
  console.log('  应用链接: ' + share.app);
  check('★ 分享里带 chahui:// 应用链接（房间号 + 当前服务器）',
    /^chahui:\/\/join\?room=/.test(share.app) && /server=ws/.test(share.app), share.app);
  check('★ 入口页有「房间链接」输入框', share.inputVisible === true);

  console.log('\n[3] 真的用链接进房');
  // 先离开房间回到入口页，再粘一条链接进去
  await page.evaluate(() => window.ChaApp.leaveRoom());
  await sleep(600);
  await page.evaluate(() => window.ChaApp.openEntry(true));
  await page.waitForSelector('#joinLinkInput');
  await page.fill('#joinLinkInput', 'http://127.0.0.1:8440/?room=' + roomId);
  await page.click('#btnJoinLink');
  let joined = false;
  for (let i = 0; i < 30; i++) {
    joined = await page.evaluate(id => {
      const s = window.ChaApp.state;
      return !!(s.joined && s.room && s.room.id === id);
    }, roomId);
    if (joined) break;
    await sleep(250);
  }
  check('★ 粘一条 http 分享链接 → 自动进房', joined === true, joined);
  await sleep(600);
  const stillEntry = await page.evaluate(() => !document.querySelector('#entryMask').classList.contains('hidden'));
  check('★ 进房之后入口页收起来了', stillEntry === false, stillEntry);

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
