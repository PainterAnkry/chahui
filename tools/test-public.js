/**
 * 茶绘 · 公网（或任意远端）端到端验收
 *
 * 本地那套 test-browser.js 的等待窗口是按本机延迟调的（<100ms），
 * 打到隧道地址上会大面积假失败。这个脚本专治「隧道到底通不通」：
 * 用一个真实浏览器打开远端地址 → 等 WebSocket 连上 → 建房 → 画一笔 → 数墨迹像素。
 *
 * 用法：
 *   node tools/test-public.js https://xxxx.trycloudflare.com
 *   node tools/test-public.js http://192.168.1.20:8437      # 局域网验收
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const URL_ = process.argv[2];
if (!URL_) {
  console.error('用法: node tools/test-public.js <http(s)://地址>');
  process.exit(1);
}
const OUT = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}

/**
 * 截图前把真实的公网地址与本机内网 IP 换成占位符（实现见 tools/mask-page.js）。
 * 验收截图经常被拿去做展示，里面带着隧道域名 / 内网网段不合适。
 */
const MASK_PAGE = require('./mask-page').mask;

(async () => {
  console.log('茶绘公网端到端验收 @ ' + URL_ + '\n');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('[1] 打开远端页面');
  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
  const loadMs = Date.now() - t0;
  ok('页面加载完成', !!(await page.title()), await page.title() + '（' + loadMs + 'ms）');

  console.log('\n[2] WebSocket 握手');
  let online = true;
  try {
    await page.waitForFunction(() => window.ChaApp && window.ChaApp.net.status === 'online', { timeout: 40000 });
  } catch (e) { online = false; }
  const wsUrl = await page.evaluate(() => (window.ChaApp && window.ChaApp.net.url) || '');
  ok('WebSocket 已连上', online, wsUrl);
  ok('连的是远端地址（不是 localhost）',
    !!wsUrl && !/localhost|127\.0\.0\.1/.test(wsUrl), wsUrl);

  console.log('\n[3] 建房');
  await page.evaluate(() => document.querySelector('#btnOpenEntry').click());
  await sleep(600);
  await page.fill('#nameInput', '外网访客');
  await page.fill('#newRoomName', '公网验收');
  await page.evaluate(() => document.querySelector('#btnCreateRoom').click());
  let joined = true;
  try {
    await page.waitForFunction(
      () => window.ChaApp.state.joined && window.ChaApp.engine.layers.length > 0, { timeout: 40000 });
  } catch (e) { joined = false; }
  const roomId = await page.evaluate(() => (window.ChaApp.state.room || {}).id || '');
  ok('建房并进入房间', joined && !!roomId, roomId);

  // 入房面板是全屏遮罩，不关掉会把鼠标事件全吃掉（踩过一次）
  const maskOpen = await page.evaluate(() => !document.querySelector('#entryMask').classList.contains('hidden'));
  if (maskOpen) { await page.evaluate(() => document.querySelector('#btnEntryClose').click()); await sleep(300); }

  console.log('\n[4] 落笔');
  await page.evaluate(() => {
    const b = document.querySelector('#brushGrid .tool[data-item="brush"]') ||
      document.querySelector('#toolGrid .tool[data-item="brush"]');
    b.click();
  });
  await page.fill('#sizeRange', '26');
  await page.dispatchEvent('#sizeRange', 'input');
  await sleep(300);

  // 注意：画布在 stage 里是居中留白的，必须按 view 的比例取点，
  // 直接用 box.x+120 可能落在画布上方的空白处（也踩过）
  const box = await page.locator('#view').boundingBox();
  const X0 = box.x + 0.25 * box.width;
  const Y0 = box.y + 0.35 * box.height;
  await page.mouse.move(X0, Y0);
  await page.mouse.down();
  for (let i = 0; i < 26; i++) {
    await page.mouse.move(X0 + i * 12, Y0 + Math.sin(i / 3) * 40);
    await sleep(12);
  }
  await page.mouse.up();
  await sleep(1600);

  const stat = await page.evaluate(() => {
    const eng = window.ChaApp.engine;
    const d = eng.renderDocument({}).ctx.getImageData(0, 0, eng.width, eng.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) ink++;
    }
    return { strokes: eng.strokes.length, ink: ink, seq: eng.seq };
  });
  ok('笔迹已记录', stat.strokes >= 1, JSON.stringify(stat));
  ok('画布上确实有墨迹', stat.ink > 200, 'ink=' + stat.ink);
  ok('服务端已分配 seq（说明笔迹真的同步过去了）', stat.seq >= 1, 'seq=' + stat.seq);

  console.log('\n[5] 运行期报错');
  ok('页面无报错', errors.length === 0, errors.slice(0, 4).join(' || '));

  // 截图：先把真实地址洗掉，再拍。房间信息面板里写死了公网入口，单独留一张。
  console.log('\n[6] 截图（已脱敏）');
  await page.evaluate(() => { const c = document.querySelector('#roomChip'); if (c) c.click(); });
  await sleep(700);
  await page.evaluate(MASK_PAGE);
  await page.screenshot({ path: path.join(OUT, 'F-公网入口.png') });
  await page.evaluate(() => { const m = document.querySelector('#infoMask'); if (m) m.classList.add('hidden'); });
  await sleep(400);
  await page.evaluate(MASK_PAGE);
  await page.screenshot({ path: path.join(OUT, 'G-公网联机验收.png') });
  console.log('  截图: screenshots/F-公网入口.png, screenshots/G-公网联机验收.png');

  /* ---------- [7] 两个人经公网真的能一起画吗 ---------- */
  // 单客户端只能证明「隧道通」。「联机」必须有两个人才算数：
  // 第二个上下文走同一条公网入口加入房主那个房间，再确认笔迹真的过去了。
  console.log('\n[7] 两个人经公网同房协作');
  const guest = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const guestErrors = [];
  guest.on('pageerror', (e) => guestErrors.push(String(e)));
  await guest.goto(URL_, { waitUntil: 'load', timeout: 60000 });
  await guest.waitForSelector('#entryMask:not(.hidden)', { timeout: 30000 });
  await guest.fill('#nameInput', '客人');
  await guest.click('#btnRefreshRooms');
  await sleep(2000);
  const seen = await guest.evaluate(() => Array.from(document.querySelectorAll('#roomList .room-item'))
    .map((el) => ((el.querySelector('.rn b') || {}).textContent || '')));
  ok('客人经公网看到了房主的房间', seen.some((n) => n.indexOf('公网验收') >= 0), seen.join(' / '));

  await guest.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('#roomList .room-item'))
      .find((el) => ((el.querySelector('.rn b') || {}).textContent || '').indexOf('公网验收') >= 0);
    if (hit) hit.click();
  });
  await guest.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const g1 = await guest.evaluate(() => ({
    joined: window.ChaApp.state.joined,
    members: window.ChaApp.state.members.length,
    strokes: window.ChaApp.engine.strokes.length
  }));
  ok('客人经公网加入了房间', g1.joined === true, JSON.stringify(g1));
  ok('两端都看到 2 个成员', g1.members === 2, String(g1.members));
  ok('房主之前画的笔迹同步到了客人这边', g1.strokes >= 1, g1.strokes + ' 笔');

  // 房主再画一笔，客人这边应该跟得上
  const beforeN = g1.strokes;
  await page.mouse.move(X0 + 40, Y0 + 160);
  await page.mouse.down();
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(X0 + 40 + i * 11, Y0 + 160 + Math.cos(i / 3) * 32);
    await sleep(12);
  }
  await page.mouse.up();
  await sleep(3000);
  const g2 = await guest.evaluate(() => ({
    strokes: window.ChaApp.engine.strokes.length,
    ink: (function () {
      const e = window.ChaApp.engine;
      const d = e.renderDocument({}).ctx.getImageData(0, 0, e.width, e.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n;
    })()
  }));
  ok('房主新画的笔实时同步到客人（跨公网）', g2.strokes > beforeN, beforeN + ' → ' + g2.strokes);
  ok('客人端画布上确实出现了这些墨迹', g2.ink > 200, 'ink=' + g2.ink);
  ok('客人端页面无报错', guestErrors.length === 0, guestErrors.slice(0, 3).join(' || '));

  await browser.close();
  console.log('\n════════════════════════════════════════');
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) { console.log('  失败项：'); failures.forEach((f) => console.log('   - ' + f)); }
  console.log('════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
