/**
 * 茶绘 · 安卓开房 → 其它端进房（2.1.9 回归）
 *
 * 守三条 2.1.9 修过的线（都是「安卓公网联机加不进去」的真实成因）：
 *   1. 安卓（离线 + 公网联机）开房，网页端用链接能进来 —— 走中继，不依赖 PeerJS 外网；
 *   2. 换服务器不会留下「幽灵房间」：界面看着还在房里，分享出去却是死链接；
 *   3. 建完房立刻重启（WebView 重载）房间还在 —— 以前有 1~3 秒的丢档窗口。
 *
 * 用法: node tools/test-android-p2p.js [http://127.0.0.1:8443]
 * 需要先起一台服务端（中继就是它：2.1.1+ 自带 /tunnel-host）。
 */
'use strict';
const { chromium } = require('./pw.js');

const BASE = (process.argv[2] || 'http://127.0.0.1:8443').replace(/\/+$/, '');
const RELAY = BASE.replace(/^http/i, 'ws') + '/ws';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 安卓壳的页面是本地资产（没有服务端那条 CSP 头）；剥掉才能在浏览器里跑 local-core */
async function androidContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.route('**/*', async route => {
    const resp = await route.fetch();
    const headers = Object.assign({}, resp.headers());
    delete headers['content-security-policy'];
    await route.fulfill({ response: resp, headers });
  });
  await ctx.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  });
  return ctx;
}

async function bootPage(page) {
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });
  await sleep(700);
}

async function createRoom(page, roomName) {
  await page.evaluate((n) => {
    document.querySelector('#nameInput').value = '房主';
    document.querySelector('#newRoomName').value = n;
    document.querySelector('#btnCreateRoom').click();
  }, roomName);
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  return page.evaluate(() => window.ChaApp.state.room.id);
}

(async () => {
  console.log('茶绘 · 安卓开房 / 中继进房 回归\n');
  // 无头 Chrome 会把「页面 → 本机/内网地址」的 WebSocket 当成本地网络访问拦掉
  // （LocalNetworkAccessChecks）。真机安卓 WebView 连公网中继不受这条限制；
  // 测试里连的是 127.0.0.1 的中继，得把这个检查关掉。
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });

  /* ---------------- 1) 安卓开房（中继）→ 网页进来 ---------------- */
  const hostCtx = await androidContext(browser);
  const host = await hostCtx.newPage();
  const hostErrs = [];
  host.on('pageerror', e => hostErrs.push(String(e).slice(0, 160)));
  await host.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(host);
  ok('安卓壳进的是离线模式（本机房间）', await host.evaluate(() => window.ChaApp.net.isLocal()));

  const roomId = await createRoom(host, '中继房' + (Date.now() % 9999));
  ok('建房成功', !!roomId, roomId);

  // 指定中继（真机上由 config.js 的 relayServer 提供；这里从外部注入，避免依赖外网信令）
  const tun = await host.evaluate(async (relay) => {
    window.CHAHU_CONFIG.relayServer = relay;
    document.querySelector('#btnTunnelToggle').click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = window.ChaApp.state.tunnel;
      if (s && s.phase === 'on') return { phase: s.phase, url: s.url, pub: window.ChaApp.state.publicUrl };
      if (s && s.phase === 'off' && s.error) return { phase: 'off', error: s.error };
      await new Promise(r => setTimeout(r, 200));
    }
    return { phase: 'timeout' };
  }, RELAY);
  ok('公网联机开在中继上（不是 P2P）', tun.phase === 'on' && /^wss?:\/\//.test(tun.url || ''), JSON.stringify(tun));

  const guestCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const guest = await guestCtx.newPage();
  const guestErrs = [];
  guest.on('pageerror', e => guestErrs.push(String(e).slice(0, 160)));
  await guest.goto(BASE + '/?room=' + encodeURIComponent(roomId) + '&server=' + encodeURIComponent(tun.pub || ''), { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });

  const joined = await guest.waitForFunction(
    () => window.ChaApp.state.joined ? window.ChaApp.state.room.id : false,
    { timeout: 30000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('网页端通过中继进了同一间房', joined === roomId, String(joined));

  const online = await host.evaluate(() => new Promise(resolve => {
    window.ChaApp.net.on('message', m => {
      if (m.t !== 'room:list') return;
      const r = (m.rooms || []).filter(x => x.id === window.ChaApp.state.room.id)[0];
      resolve(r ? r.online : -1);
    });
    window.ChaApp.net.send('room:list', {});
    setTimeout(() => resolve(-2), 3000);
  }));
  ok('房主那边看到 2 个人在房间', online >= 2, String(online));

  // 房主能从网页进来的那一刻起照常收笔（跨端不是只连上就算了）
  const strokeOk = await guest.evaluate(() => {
    try {
      window.ChaApp.engine.beginStroke({ x: 50, y: 50, p: 0.6 }, {});
      window.ChaApp.engine.endStroke();
      return true;
    } catch (e) { return String(e.message); }
  });
  ok('访客能在房主的房间上落笔', strokeOk === true, String(strokeOk));

  await guestCtx.close();

  /* ---------------- 2) 换服务器：不再留幽灵房间 ---------------- */
  const ghost = await host.evaluate(async (server) => {
    const input = document.querySelector('#serverInput');
    input.value = server;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    return {
      joined: window.ChaApp.state.joined,
      room: window.ChaApp.state.room && window.ChaApp.state.room.id,
      link: window.ChaApp.appRoomLink(),
      entryShown: !document.querySelector('#entryMask').classList.contains('hidden')
    };
  }, RELAY);
  ok('换服务器后退出原房间（不再显示幽灵房间）', ghost.joined === false && !ghost.room, JSON.stringify(ghost));
  ok('换服务器后不会再拼出一条死链接', !ghost.link, ghost.link);
  ok('换服务器后回到入口页', ghost.entryShown === true);

  await hostCtx.close();

  /* ---------------- 3) 建完房立刻重启，房间还在 ---------------- */
  const ctx3 = await androidContext(browser);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(p3);
  const persisted = await createRoom(p3, '重启房' + (Date.now() % 9999));
  await p3.reload({ waitUntil: 'domcontentloaded' });     // 立刻重载，不给防抖留时间
  await bootPage(p3);
  const after = await p3.evaluate(async (id) => {
    const list = await new Promise(resolve => {
      window.ChaApp.net.on('message', m => { if (m.t === 'room:list') resolve(m.rooms.map(r => r.id)); });
      window.ChaApp.net.send('room:list', {});
      setTimeout(() => resolve(null), 4000);
    });
    const join = await new Promise(resolve => {
      window.ChaApp.net.on('message', m => {
        if (m.t === 'room:joined') resolve(true);
        if (m.t === 'error') resolve(false);
      });
      window.ChaApp.net.send('room:join', { roomId: id, user: '房主' });
      setTimeout(() => resolve(null), 5000);
    });
    return { list, join };
  }, persisted);
  ok('重启后房间还在列表里', Array.isArray(after.list) && after.list.indexOf(persisted) >= 0, JSON.stringify(after.list));
  ok('重启后还能进这间房（不再「房间不存在」）', after.join === true, String(after.join));

  const errs = hostErrs.concat(guestErrs);
  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await ctx3.close();
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过  ' : '有失败  ') + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试崩了：', e && e.message);
  process.exit(1);
});
