/**
 * 验证「双击 exe → 局域网朋友用浏览器加入」这条链路。
 * 前提：已经启动了打包好的桌面端（它自己带着内置服务器）。
 *
 * 用法: node tools/test-lan.js [http://127.0.0.1:8437]
 */
'use strict';
const path = require('path');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://127.0.0.1:8437';
const OUT = path.resolve(__dirname, '..', 'docs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  /* ---------- 1) 桌面端注入 lan 参数时，入口要显示局域网地址 ---------- */
  console.log('\n=== [1] 桌面端入口的「已开好服务器」提示条 ===');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const desk = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1.5 });
  const errs = [];
  desk.on('pageerror', e => errs.push(e.message));
  // main.js 就是通过 ?lan=<ip>&port=<端口> 把局域网地址交给渲染进程的
  await desk.goto(BASE + '/?lan=192.168.168.79&port=8437', { waitUntil: 'domcontentloaded' });
  await desk.waitForSelector('#entryMask:not(.hidden)', { timeout: 8000 });
  await sleep(900);
  const bar = await desk.evaluate(() => {
    const b = document.querySelector('#lanBar');
    return {
      visible: b && !b.classList.contains('hidden'),
      addr: (document.querySelector('#lanAddr') || {}).textContent,
      text: b ? b.textContent.replace(/\s+/g, ' ').trim() : ''
    };
  });
  console.log('  提示条:', JSON.stringify(bar));
  check('入口显示「本机已开好服务器」提示条', bar.visible === true);
  check('写的是局域网地址而不是 localhost', bar.addr === 'http://192.168.168.79:8437', bar.addr);
  await desk.screenshot({ path: path.join(OUT, '05-双击即联机.png') });
  console.log('  已存 docs/05-双击即联机.png');

  /* ---------- 2) 朋友从「另一个客户端」用浏览器加入 ---------- */
  console.log('\n=== [2] 朋友用浏览器加入同一个房间 ===');
  const friend = await browser.newPage({ viewport: { width: 1300, height: 860 }, deviceScaleFactor: 1 });
  const errsF = [];
  friend.on('pageerror', e => errsF.push(e.message));
  await friend.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await friend.waitForSelector('#entryMask:not(.hidden)', { timeout: 8000 });
  await sleep(800);

  // 房主（第一个页面）建房
  await desk.fill('#nameInput', '房主');
  await desk.fill('#newRoomName', '双击即成房');
  await desk.click('#btnCreateRoom');
  await desk.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(900);
  const roomId = await desk.evaluate(() => window.ChaApp.state.room.id);
  console.log('  房主建房:', roomId);
  check('房主建房成功', !!roomId, roomId);

  // 朋友刷新房间列表并加入（点的是房主那个房间，不是列表里的任意一个）
  await friend.fill('#nameInput', '朋友');
  await friend.click('#btnRefreshRooms');
  await sleep(1000);
  const listed = await friend.evaluate(() => Array.from(document.querySelectorAll('#roomList .room-item'))
    .map(el => (el.querySelector('.rn b') || {}).textContent || ''));
  console.log('  朋友看到的房间:', JSON.stringify(listed));
  check('朋友能看到房主的房间', listed.some(n => /双击即成房/.test(n)), listed.join(' / '));

  await friend.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#roomList .room-item'));
    const hit = items.find(el => /双击即成房/.test((el.querySelector('.rn b') || {}).textContent || ''));
    if (hit) hit.click();
  });
  await friend.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const fState = await friend.evaluate(() => ({
    joined: window.ChaApp.state.joined,
    room: window.ChaApp.state.room && window.ChaApp.state.room.id,
    members: window.ChaApp.state.members.length
  }));
  console.log('  朋友端:', JSON.stringify(fState));
  check('朋友加入了房间', fState.joined && fState.room === roomId, JSON.stringify(fState));

  // 房主画一笔，朋友那边应该收到
  const box = await desk.locator('#view').boundingBox();
  await desk.click('#toolGrid .tool[data-item="pencil"], #brushGrid .tool[data-item="pencil"]');
  await sleep(250);
  await desk.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 30; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await desk.mouse.move(box.x + 200, box.y + 200);
  await desk.mouse.down();
  for (let i = 1; i <= 30; i++) await desk.mouse.move(box.x + 200 + i * 12, box.y + 200 + Math.sin(i / 4) * 40);
  await desk.mouse.up();
  await sleep(1200);
  const fStrokes = await friend.evaluate(() => window.ChaApp.engine.strokes.length);
  check('房主画的笔迹实时同步到朋友端', fStrokes >= 1, fStrokes + ' 笔');

  const deskMembers = await desk.evaluate(() => window.ChaApp.state.members.length);
  check('房主端看到两个成员', deskMembers === 2, deskMembers + ' 人');

  check('两端都没有 JS 报错', errs.length === 0 && errsF.length === 0,
    errs.concat(errsF).join(' | '));

  await browser.close();
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
