/**
 * 茶绘 · 安卓建房 → Web / Windows 桌面端跨端联机验收
 *
 * 一条真实的跨端链路：
 *   · 安卓房主（Capacitor 壳 + local-core + WebRTC P2P）在离线模式建房、开公网联机
 *   · 分享链接由 App 自己生成（页面地址 + ?room + ?server=webrtc://）
 *   · Web 访客：普通浏览器点开分享链接 → P2P 进房 → 画一笔
 *   · Windows 桌面访客：真 Electron 客户端（client/main.js）粘同一条分享链接进房 → 画一笔
 *   · 房主端看到 3 人在线 + 两笔笔迹
 *
 * 用法: node tools/test-webrtc-desktop.js
 * 依赖：本机 Chrome、client/node_modules 里的 ws、根目录 node_modules/peer、
 *       以及 .tmp-electron（从 electron 缓存解出来的运行时；没有就用 dist/win-unpacked）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium, _electron } = require('./pw');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8446';
const PAGE_PORT = 8446;
const SIG_PORT = 9528;
const DESK_PORT = 8450;
const DATA_DIR = path.join(os.tmpdir(), 'chahui-cross-' + Date.now());

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function electronExe() {
  const local = path.join(ROOT, '.tmp-electron', 'electron.exe');
  if (fs.existsSync(local)) return local;
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked', '茶绘.exe');
  if (fs.existsSync(unpacked)) return unpacked;
  return '';
}

(async () => {
  /* ---------- 0) 页面托管服务器（网页版入口）+ PeerJS 信令 ---------- */
  const srv = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PAGE_PORT),
      DATA_DIR: path.join(DATA_DIR, 'page'),
      // 安卓房主在浏览器里跑 local-core 需要 new Function；真机 WebView 不受网页 CSP 限制
      CHAHU_ALLOW_EVAL: '1'
    }),
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (e) { await sleep(250); }
  }
  ok('页面托管服务器（网页版入口）起来了', up, BASE);

  const { PeerServer } = require('peer');
  const peer = PeerServer({ port: SIG_PORT, debug: false });
  await sleep(600);
  ok('PeerJS 信令起来了', true, 'ws://127.0.0.1:' + SIG_PORT);

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const errors = [];

  /* ---------- 1) 安卓房主：离线建房 + 开公网联机 ---------- */
  const ctxH = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageH = await ctxH.newPage();
  pageH.on('pageerror', e => errors.push('host: ' + e.message));
  await pageH.addInitScript(function () {
    window.Capacitor = { isNativePlatform: function () { return true; } };
  });
  await pageH.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pageH.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await pageH.evaluate((port) => {
    window.CHAHU_CONFIG.signalServer = 'ws://127.0.0.1:' + port;
    window.CHAHU_CONFIG.publicServer = '';
  }, SIG_PORT);

  // 官方公共服务器下线后，安卓默认应该直接落在离线模式（不需要再点「切到离线」）
  await pageH.waitForFunction(() => window.ChaApp.isOffline(), { timeout: 15000 });
  ok('安卓（无官方服）默认落在离线模式', true);

  await pageH.evaluate(() => {
    document.querySelector('#nameInput').value = '安卓房主';
    document.querySelector('#newRoomName').value = '跨端房';
    document.querySelector('#btnCreateRoom').click();
  });
  await pageH.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  const roomId = await pageH.evaluate(() => window.ChaApp.state.room.id);
  ok('安卓房主在离线模式建房', !!roomId, 'room=' + roomId);

  await pageH.evaluate(() => { const b = document.querySelector('#btnTunnelToggle'); if (b && !b.disabled) b.click(); });
  let hostUrl = '';
  try {
    await pageH.waitForFunction(() => /^webrtc:\/\//.test(window.ChaApp.state.publicUrl || ''), { timeout: 30000 });
    hostUrl = await pageH.evaluate(() => window.ChaApp.state.publicUrl);
    ok('公网联机开启（WebRTC P2P）', true, hostUrl);
  } catch (e) {
    ok('公网联机开启（WebRTC P2P）', false, JSON.stringify(await pageH.evaluate(() => window.ChaApp.state.tunnel)));
  }

  /* ---------- 2) 分享链接由 App 生成 ---------- */
  await pageH.evaluate((base) => {
    window.CHAHU_CONFIG.publicServer = base.replace(/^http/, 'ws') + '/ws';
    window.ChaApp.showInfo();
  }, BASE);
  const shareAll = await pageH.evaluate(() => (document.querySelector('#shareLinkText') || {}).textContent || '');
  const share = shareAll.split('\n')[0].trim();
  ok('分享链接 = 页面地址 + 房间号 + P2P 入口',
    /^http:\/\/127\.0\.0\.1:\d+\/\?room=/.test(share) && /server=webrtc%3A%2F%2F/.test(share),
    share);
  ok('房间信息里同时给出 chahui:// 应用链接', /\n茶绘应用链接：chahui:\/\/join\?room=/.test(shareAll), shareAll);

  /* ---------- 3) Web 访客：打开分享链接进房 ---------- */
  let webJoined = false;
  if (share) {
    const ctxW = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const pageW = await ctxW.newPage();
    pageW.on('pageerror', e => errors.push('web: ' + e.message));
    await pageW.goto(share + '&signal=' + encodeURIComponent('ws://127.0.0.1:' + SIG_PORT),
      { waitUntil: 'domcontentloaded' });
    try {
      await pageW.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 40000 });
      webJoined = true;
    } catch (e) { /* 超时 */ }
    ok('Web 访客经分享链接进入 P2P 房间', webJoined);
    if (webJoined) {
      await pageW.evaluate(() => { const mk = document.querySelector('#entryMask'); if (mk) mk.style.display = 'none'; });
      const r = await pageW.evaluate(() => {
        const b = document.querySelector('#stage').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await pageW.mouse.move(r.x - 40, r.y - 30);
      await pageW.mouse.down();
      for (let i = 1; i <= 5; i++) await pageW.mouse.move(r.x - 40 + i * 16, r.y - 30 + i * 8);
      await pageW.mouse.up();
      await sleep(900);
    }
    await ctxW.close();
  }

  /* ---------- 4) Windows 桌面访客 ----------
   * 默认用 Chrome 代跑**同一份桌面渲染层**（window.chahuDesktop 假桥）：
   * 进房走的是 net.js / parseRoomLink / appRoomLink，和 Electron 里完全同一套代码。
   * 本会话没有交互式桌面，Electron 进程会 0xC0000005 崩掉（环境限制），
   * 真机验收时设 CHAHU_ELECTRON=1 就会走真 Electron（client/main.js）。
   */
  let deskJoined = false;
  let deskMode = 'renderer';
  const ud = path.join(DATA_DIR, 'desk-userdata');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'chahu-config.json'),
    JSON.stringify({ server: 'ws://localhost:' + DESK_PORT + '/ws' }, null, 2), 'utf8');
  let electronApp = null;

  async function joinFromDesktopLike(pageD, label) {
    pageD.on('pageerror', e => errors.push(label + ': ' + e.message));
    await pageD.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });
    await pageD.evaluate((port) => { window.CHAHU_CONFIG.signalServer = 'ws://127.0.0.1:' + port; }, SIG_PORT);
    await pageD.evaluate(() => window.ChaApp.openEntry(true));
    await pageD.fill('#joinLinkInput', share);
    await pageD.click('#btnJoinLink');
    try {
      await pageD.waitForFunction(id => {
        const s = window.ChaApp && window.ChaApp.state;
        return !!(s && s.joined && s.room && s.room.id === id);
      }, roomId, { timeout: 40000 });
      deskJoined = true;
    } catch (e) { /* 超时 */ }
    ok(label + '经同一条分享链接进入 P2P 房间', deskJoined);
    if (deskJoined) {
      await pageD.evaluate(() => { const mk = document.querySelector('#entryMask'); if (mk) mk.style.display = 'none'; });
      const r = await pageD.evaluate(() => {
        const b = document.querySelector('#stage').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await pageD.mouse.move(r.x + 40, r.y + 30);
      await pageD.mouse.down();
      for (let i = 1; i <= 5; i++) await pageD.mouse.move(r.x + 40 - i * 16, r.y + 30 - i * 8);
      await pageD.mouse.up();
      await sleep(1000);
    }
  }

  if (process.env.CHAHU_ELECTRON === '1') {
    const exe = electronExe();
    if (!exe) {
      ok('找到 Electron 运行时', false, '没有 .tmp-electron/electron.exe 或 dist/win-unpacked');
    } else {
      try {
        const env = Object.assign({}, process.env, {
          CHAHU_USER_DATA: ud,
          PORT: String(DESK_PORT)
        });
        // 有些终端 / IDE 会带这个变量（Electron 会退化成 Node 跑，主进程直接报错）
        delete env.ELECTRON_RUN_AS_NODE;
        electronApp = await _electron.launch({
          executablePath: exe,
          args: [path.join(ROOT, 'client')],
          env: env
        });
        const pageD = await electronApp.firstWindow();
        await pageD.waitForSelector('#entryMask:not(.hidden)', { timeout: 15000 }).catch(() => {});
        ok('Windows 桌面客户端启动（Electron）', true, path.basename(exe));
        deskMode = 'electron';
        await joinFromDesktopLike(pageD, 'Windows 桌面端（Electron）');
      } catch (e) {
        ok('Windows 桌面客户端启动（Electron）', false, String(e && e.message || e).slice(0, 200));
      }
    }
  }

  if (!deskJoined && !electronApp) {
    deskMode = 'renderer';
    const ctxD = await browser.newContext({ viewport: { width: 1000, height: 760 } });
    await ctxD.addInitScript(function () {
      // 桌面渲染层的识别位：不提供 startTunnel/localOpen，隧道和离线行自动收起，
      // 但 net / 链接解析 / 进房逻辑与真 Electron 完全同一份。
      window.chahuDesktop = { isDesktop: true, isAndroid: false };
    });
    const pageD = await ctxD.newPage();
    await pageD.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await joinFromDesktopLike(pageD, 'Windows 桌面渲染层（Chrome 代跑）');
  }

  /* ---------- 5) 房主端验收：3 人 + 两笔 ---------- */
  await sleep(800);
  const seen = await pageH.evaluate(() => ({
    members: (document.querySelector('#memberCount') || {}).textContent || '',
    strokes: (document.querySelector('#strokeCount') || {}).textContent || ''
  }));
  ok('房主看到 3 人在线（房主 + Web + 桌面）', parseInt(seen.members, 10) === 3, 'members=' + seen.members);
  ok('房主收到两端笔迹（≥2 笔）', parseInt(seen.strokes, 10) >= 2, 'strokes=' + seen.strokes);
  console.log('  桌面访客验证方式：' + (deskMode === 'electron' ? '真 Electron' : 'Chrome 代跑桌面渲染层（本会话 Electron 不可用）'));

  console.log('\n浏览器 / 客户端报错数: ' + errors.length);
  errors.slice(0, 8).forEach(e => console.log('  · ' + e.slice(0, 160)));
  ok('全程没有致命 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  try { if (electronApp) await electronApp.close(); } catch (e) { /* ignore */ }
  await browser.close();
  try { peer.close(); } catch (e) { /* ignore */ }
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('崩了:', e);
  process.exit(2);
});
