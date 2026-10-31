/**
 * 茶绘 · 公共中继（跨 WiFi）回归
 *
 * 守的是「不同 WiFi 联机」这条线：两端都在 NAT 后面，P2P 打洞失败时，
 * 房主开一条公共 MQTT 中继，访客自动/直接连上来。
 *
 * 验证四件事：
 *   1. 安卓开房时会把公共中继一起开起来（不需要任何服务器）；
 *   2. 网页端直接连 relay://<房间key> 能进房（这就是跨 WiFi 的那条路）；
 *   3. 走 relay:// 进房后人数正确、能落笔（不是只连上）；
 *   4. P2P 入口打不通时自动降级到 relay://（20 秒后）。
 *
 * 用法: node tools/test-relay.js [http://127.0.0.1:8443]
 * 需要外网（公共 broker 是真实服务）。第 4 项要等 20 秒超时，整体约 90 秒。
 */
'use strict';
const { chromium } = require('./pw.js');

const BASE = (process.argv[2] || 'http://127.0.0.1:8443').replace(/\/+$/, '');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 安卓壳页面是本地资产（没有服务端那条 CSP 头）；剥掉才能在浏览器里跑 local-core */
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

/** 和 mqtt-relay.js 的 roomKey 同一口径 */
const roomKey = id => String(id || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

(async () => {
  console.log('茶绘 · 公共中继（跨 WiFi 联机）回归\n');
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });

  const errs = [];
  const track = p => { p.on('pageerror', e => errs.push(String(e).slice(0, 160))); return p; };

  /* ---------------- 1) 安卓开房：公共中继跟着起来 ---------------- */
  const hostCtx = await androidContext(browser);
  const host = track(await hostCtx.newPage());
  await host.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(host);
  ok('中继组件已加载', await host.evaluate(() => !!(window.ChaRelay && window.ChaRelay.hasLib())));
  ok('安卓壳默认在离线模式', await host.evaluate(() => window.ChaApp.net.isLocal()));

  const roomId = await createRoom(host, '跨网房' + (Date.now() % 9999));
  const key = roomKey(roomId);
  ok('建房成功', !!roomId && key.length >= 4, roomId + ' → key=' + key);

  // 开公网联机（不配自建中继，纯靠公共 broker）
  const tun = await host.evaluate(async () => {
    document.querySelector('#btnTunnelToggle').click();
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const s = window.ChaApp.state.tunnel;
      if (s && s.phase === 'on') return { phase: 'on', url: s.url };
      if (s && s.phase === 'off' && s.error) return { phase: 'off', error: s.error };
      await new Promise(r => setTimeout(r, 250));
    }
    return { phase: 'timeout' };
  });
  ok('公网联机开起来了', tun.phase === 'on', JSON.stringify(tun));
  ok('入口要么是 P2P 要么是公共中继', /^(webrtc|relay):\/\//.test(tun.url || ''), tun.url);

  /* ---------------- 2) 网页端直接走 relay:// 进房 ---------------- */
  const guestCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const guest = track(await guestCtx.newPage());
  await guest.goto(BASE + '/?room=' + encodeURIComponent(roomId) +
    '&server=' + encodeURIComponent('relay://' + key), { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });

  const joined = await guest.waitForFunction(
    () => window.ChaApp.state.joined ? window.ChaApp.state.room.id : false,
    { timeout: 45000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('网页端经 public relay 进了同一间房', joined === roomId, String(joined));
  ok('网页端确实落在 relay 通道上', await guest.evaluate(() => /^relay:\/\//.test(window.ChaApp.net.url)));

  const online = await host.evaluate(() => new Promise(resolve => {
    window.ChaApp.net.on('message', m => {
      if (m.t !== 'room:list') return;
      const r = (m.rooms || []).filter(x => x.id === window.ChaApp.state.room.id)[0];
      resolve(r ? r.online : -1);
    });
    window.ChaApp.net.send('room:list', {});
    setTimeout(() => resolve(-2), 4000);
  }));
  ok('房主那边看到 2 个人在房间', online >= 2, String(online));

  // 监听要先挂上，再让访客画 —— 否则笔已经画完才开始等，永远等不到
  await host.evaluate(() => {
    window.__strokeSeen = false;
    window.ChaApp.net.on('message', m => { if (/^stroke:/.test(m.t)) window.__strokeSeen = true; });
  });

  // 用真实鼠标画一笔：engine.beginStroke 只是本地引擎，不发网络消息；
  // 真正把 stroke:begin 发出去的是 app.js 的指针处理。
  await guest.mouse.move(300, 300);
  await guest.mouse.down();
  for (let i = 1; i <= 6; i++) await guest.mouse.move(300 + i * 14, 300 + i * 9);
  await guest.mouse.up();
  const localDrawn = await guest.evaluate(() => !!(window.ChaApp.engine && window.ChaApp.engine.strokes && window.ChaApp.engine.strokes.length));
  ok('访客能经中继落笔', localDrawn === true, String(localDrawn));

  // 房主反向：笔画要真的到房主那边（不是本地画了个寂寞）
  const gotStroke = await host.waitForFunction(() => window.__strokeSeen === true, { timeout: 10000 })
    .then(() => true).catch(() => false);
  ok('房主收到了访客的笔画数据', gotStroke === true);

  await guestCtx.close();

  /* ---------------- 3) P2P 信令不通 → 自动降级到 relay ---------------- */
  // 把信令指到一个没人监听的端口 = 模拟「PeerJS 云被墙 / 单位网封了」。
  // 这条以前是直接报错误，现在应当立刻改走公共中继（不用干等 20 秒）。
  const guest2Ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const guest2 = track(await guest2Ctx.newPage());
  await guest2.goto(BASE + '/?room=' + encodeURIComponent(roomId) +
    '&server=' + encodeURIComponent('webrtc://chahui-' + key) +
    '&signal=' + encodeURIComponent('ws://127.0.0.1:1/peer'), { waitUntil: 'domcontentloaded' });
  await guest2.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });

  const joined2 = await guest2.waitForFunction(
    () => window.ChaApp.state.joined ? window.ChaApp.state.room.id : false,
    { timeout: 70000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('P2P 信令不通时自动降级并进房', joined2 === roomId, String(joined2));
  ok('降级走的是 relay 通道', await guest2.evaluate(() => /^relay:\/\//.test(window.ChaApp.net.url)));

  await guest2Ctx.close();
  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await hostCtx.close();
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过  ' : '有失败  ') + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试崩了：', e && e.message);
  process.exit(1);
});
