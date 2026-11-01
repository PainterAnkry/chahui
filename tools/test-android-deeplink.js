/**
 * 茶绘 · 安卓应用链接（chahui://）进房回归 —— 2.1.9
 *
 * 用户的要求：「安卓端开房，其余端都能连接」。手机当服务器时，房主给出的分享
 * 有一条是 `chahui://join?room=…&server=webrtc://…`（没有页面托管时这是唯一一条）。
 * 桌面端 2.0.10 起就认这个协议，**安卓端却从来没注册过** ——
 * Manifest 里没有 intent-filter，android-shim 也没给 takeOpenLink / onOpenLink，
 * 于是渲染层 boot() 认为「没有链接」，手机上点别人发来的应用链接毫无反应。
 *
 * 这个脚本守三件事：
 *   1. 安卓壳的 chahuDesktop 暴露 takeOpenLink / onOpenLink（渲染层认这两个名字）；
 *   2. 冷启动带应用链接 → 自动连上房主、直接进同一间房；
 *   3. 热启动（appUrlOpen 事件）→ 退房后再点链接还能再进；
 *   4. 顺带守 2.1.9 的稳定信令 id：webrtc:// 地址由房间号派生，房间不变地址就不变。
 *
 * 用法: node tools/test-android-deeplink.js [页面基地址] [信令端口]
 *       默认 http://127.0.0.1:8437 + 9531；需要先起一台服务端托管页面。
 */
'use strict';
const { chromium } = require('./pw.js');

const BASE = (process.argv[2] || 'http://127.0.0.1:8437').replace(/\/+$/, '');
const SIG_PORT = Number(process.argv[3]) || 9531;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 安卓壳页面：本地资产没有服务端那条 CSP 头（真机如此），测试里剥掉，
 * 否则 local-core 的 new Function 会被 script-src 'self' 拦死。
 */
async function androidContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.route('**/*', async route => {
    const resp = await route.fetch();
    const headers = Object.assign({}, resp.headers());
    delete headers['content-security-policy'];
    await route.fulfill({ response: resp, headers });
  });
  return ctx;
}

async function bootPage(page) {
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });
  await sleep(700);
}

(async () => {
  console.log('茶绘 · 安卓应用链接（chahui://）进房回归\n');

  // 本地 PeerJS 信令：手机当服务器时数据直连，信令只负责介绍双方认识。
  // 生产用 PeerJS 免费云（0.peerjs.com），测试用本机，避免依赖外网。
  const { PeerServer } = require('peer');
  PeerServer({ port: SIG_PORT, debug: false });
  await sleep(800);
  const SIG = 'ws://127.0.0.1:' + SIG_PORT;
  console.log('本地信令服务器：' + SIG + '\n');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    // 无头 Chrome 会拦「页面 → 本机地址」的 WebSocket（LocalNetworkAccessChecks）
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });
  const errs = [];

  /* ---------------- 房主：安卓壳，离线 + 公网联机（手机当服务器） ---------------- */
  const hostCtx = await androidContext(browser);
  await hostCtx.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  });
  const host = await hostCtx.newPage();
  host.on('pageerror', e => errs.push('host: ' + String(e).slice(0, 140)));
  await host.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(host);

  await host.evaluate(() => {
    document.querySelector('#nameInput').value = '手机房主';
    document.querySelector('#newRoomName').value = '深链房' + (Date.now() % 9999);
    document.querySelector('#btnCreateRoom').click();
  });
  await host.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  const roomId = await host.evaluate(() => window.ChaApp.state.room.id);
  ok('安卓壳建房（本机当服务器）', !!roomId, roomId);

  const caps = await host.evaluate(() => ({
    take: typeof (window.chahuDesktop && window.chahuDesktop.takeOpenLink),
    on: typeof (window.chahuDesktop && window.chahuDesktop.onOpenLink)
  }));
  ok('安卓壳暴露 takeOpenLink（冷启动取链接）', caps.take === 'function', caps.take);
  ok('安卓壳暴露 onOpenLink（热启动推链接）', caps.on === 'function', caps.on);

  await host.evaluate((sig) => {
    window.CHAHU_CONFIG.signalServer = sig;
    document.querySelector('#btnTunnelToggle').click();
  }, SIG);
  let pub = '';
  try {
    await host.waitForFunction(() => /^webrtc:\/\//.test(window.ChaApp.state.publicUrl || ''), { timeout: 30000 });
    pub = await host.evaluate(() => window.ChaApp.state.publicUrl);
  } catch (e) {
    const st = await host.evaluate(() => window.ChaApp.state.tunnel);
    ok('公网入口开起来（P2P，零服务器）', false, JSON.stringify(st).slice(0, 160));
  }
  ok('公网入口开起来（P2P，零服务器）', /^webrtc:\/\//.test(pub), pub);

  // 2.1.9：信令 id 由房间号派生 —— 手机被系统回收后重开，旧链接依然有效
  const wantId = 'chahui-' + roomId.replace(/[^A-Za-z0-9]/g, '');
  ok('信令地址跟着房间号走（重开后旧链接不失效）', pub === 'webrtc://' + wantId, pub);

  const link = await host.evaluate(() => {
    window.ChaApp.showInfo();               // 分享文本在房间信息面板里
    return (document.querySelector('#shareLinkText') || {}).textContent.trim().split('\n').pop();
  });
  ok('分享面板给出 chahui:// 应用链接', /^chahui:\/\/join\?room=/.test(link), link.slice(0, 90));

  /* ---------------- 访客：安卓壳，冷启动就带这条链接（深链） ---------------- */
  const guestCtx = await androidContext(browser);
  await guestCtx.addInitScript(({ url, sig }) => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        // 原生侧注入的 App 插件：getLaunchUrl 返回本次启动的 intent URL，
        // addListener('appUrlOpen') 收后续 VIEW intent。这里按最小面复刻。
        App: {
          getLaunchUrl: () => Promise.resolve({ url }),
          addListener: (ev, cb) => {
            if (ev === 'appUrlOpen') window.__fireUrlOpen = (u) => cb({ url: u });
            return Promise.resolve({ remove: () => { window.__fireUrlOpen = null; } });
          }
        }
      }
    };
    window.__sig = sig;
  }, { url: link, sig: SIG });

  const guest = await guestCtx.newPage();
  guest.on('pageerror', e => errs.push('guest: ' + String(e).slice(0, 140)));
  // ?signal= 由 config.js 加载时读取（生产里是自建信令随分享链接带上）
  await guest.goto(BASE + '/?signal=' + encodeURIComponent(SIG), { waitUntil: 'domcontentloaded' });
  await bootPage(guest);

  const joinedRoom = await guest.waitForFunction(
    () => (window.ChaApp.state.joined ? window.ChaApp.state.room.id : false),
    { timeout: 40000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('冷启动带应用链接 → 自动进房', joinedRoom === roomId, String(joinedRoom));

  const hostSees = await host.evaluate(() => new Promise(resolve => {
    window.ChaApp.net.on('message', m => {
      if (m.t !== 'room:list') return;
      const r = (m.rooms || []).filter(x => x.id === window.ChaApp.state.room.id)[0];
      resolve(r ? r.online : -1);
    });
    window.ChaApp.net.send('room:list', {});
    setTimeout(() => resolve(-2), 3000);
  }));
  ok('房主看到 2 人在线（跨端真的连上了）', hostSees >= 2, String(hostSees));

  /* ---------------- 热启动：退房之后再点一次链接 ---------------- */
  await guest.evaluate(() => { window.ChaApp.net.send('room:leave', {}); });
  const left = await guest.waitForFunction(() => !window.ChaApp.state.joined, { timeout: 8000 })
    .then(() => true).catch(() => false);
  ok('访客退房', left === true);

  await guest.evaluate((url) => { window.__fireUrlOpen(url); }, link);
  const rejoined = await guest.waitForFunction(
    () => (window.ChaApp.state.joined ? window.ChaApp.state.room.id : false),
    { timeout: 30000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('热启动（appUrlOpen）→ 再点链接还能进', rejoined === roomId, String(rejoined));

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await guestCtx.close();
  await hostCtx.close();
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过  ' : '有失败  ') + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试崩了：', e && e.message);
  process.exit(1);
});
