/**
 * 茶绘 · 两台安卓跨网联机（2.3.0）
 *
 * 用户的原话：「一定要让不同的安卓端用户跨网能进行快速上手的简单联机」。
 *
 * 跨网时（两家不同的 WiFi、一方手机流量、公司网 / 校园网），只要有一端落在对称 NAT
 * 后面，WebRTC 打洞在协议层面就打不通 —— 这不是 bug。所以「能不能连上」这件事，
 * 真正靠的是回落通道。这个脚本把 P2P 故意打死（信令指向一个没人监听的端口），
 * 逼它走公共中继，然后验证整条链路：
 *
 *   1. P2P 起不来时，房主拿到的是 relay:// 入口（而不是干等 / 报错）；
 *   2. 另一台安卓拿 chahui:// 链接点开，能进同一间房；
 *   3. 房主那边真的看到 2 个人（不是「显示已连接但对面没进来」）；
 *   4. 访客画的笔，房主收得到（数据真的过了中继，不是本地画了个寂寞）。
 *
 * 用法: node tools/test-android-crossnet.js [页面基地址]
 *       默认 http://127.0.0.1:8437；需要先起一台服务端托管页面。
 *       会连真实公共 MQTT broker（EMQX / HiveMQ），要外网。
 */
'use strict';
const { chromium } = require('./pw.js');

const BASE = (process.argv[2] || 'http://127.0.0.1:8437').replace(/\/+$/, '');
// 一个确定没人监听的本地端口：PeerJS 会立刻 ECONNREFUSED，P2P 必然起不来
const DEAD_SIGNAL = 'ws://127.0.0.1:1/ws';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 安卓壳页面：本地资产没有服务端那条 CSP 头，剥掉才能在浏览器里跑 local-core */
async function androidContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.route('**/*', async route => {
    // 上下文关闭时可能还有在途请求，route 会被 dispose；
    // 那是收尾阶段的正常现象，不该把整个测试炸掉
    try {
      const resp = await route.fetch();
      const headers = Object.assign({}, resp.headers());
      delete headers['content-security-policy'];
      await route.fulfill({ response: resp, headers });
    } catch (e) {
      try { await route.abort(); } catch (e2) { /* 已关闭 */ }
    }
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

(async () => {
  console.log('茶绘 · 两台安卓跨网联机（P2P 打死 → 中继）\n');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });
  const errs = [];

  /* ---------------- 房主：安卓壳，P2P 起不来 ---------------- */
  const hostCtx = await androidContext(browser);
  const host = await hostCtx.newPage();
  host.on('pageerror', e => errs.push('host: ' + String(e).slice(0, 140)));
  await host.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(host);

  await host.evaluate(() => {
    document.querySelector('#nameInput').value = '手机房主';
    document.querySelector('#newRoomName').value = '跨网房' + (Date.now() % 9999);
    document.querySelector('#btnCreateRoom').click();
  });
  await host.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  const roomId = await host.evaluate(() => window.ChaApp.state.room.id);
  ok('安卓壳建房', !!roomId, roomId);

  // 把信令指向死端口再开公网联机 —— 模拟「打洞打不通」的真实处境
  await host.evaluate((sig) => {
    window.CHAHU_CONFIG.signalServer = sig;
    document.querySelector('#btnTunnelToggle').click();
  }, DEAD_SIGNAL);

  let pub = '';
  try {
    await host.waitForFunction(
      () => /^relay:\/\//.test(window.ChaApp.state.publicUrl || ''), { timeout: 60000 }
    );
    pub = await host.evaluate(() => window.ChaApp.state.publicUrl);
  } catch (e) {
    const st = await host.evaluate(() => ({ tunnel: window.ChaApp.state.tunnel, pub: window.ChaApp.state.publicUrl }));
    ok('P2P 不通时自动回落到公共中继', false, JSON.stringify(st).slice(0, 200));
  }
  ok('P2P 不通时自动回落到公共中继', /^relay:\/\//.test(pub), pub);

  const link = await host.evaluate(() => {
    window.ChaApp.showInfo();
    return (document.querySelector('#shareLinkText') || {}).textContent.trim().split('\n').pop();
  });
  ok('分享出去的链接带中继入口', /^chahui:\/\/join\?room=/.test(link) && /relay%3A%2F%2F/.test(link), link.slice(0, 110));

  /* ---------------- 访客：另一台安卓，点链接进房 ---------------- */
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await guestCtx.route('**/*', async route => {
    // 上下文关闭时可能还有在途请求，route 会被 dispose；
    // 那是收尾阶段的正常现象，不该把整个测试炸掉
    try {
      const resp = await route.fetch();
      const headers = Object.assign({}, resp.headers());
      delete headers['content-security-policy'];
      await route.fulfill({ response: resp, headers });
    } catch (e) {
      try { await route.abort(); } catch (e2) { /* 已关闭 */ }
    }
  });
  await guestCtx.addInitScript(({ url }) => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        App: {
          getLaunchUrl: () => Promise.resolve({ url }),
          addListener: (ev, cb) => {
            if (ev === 'appUrlOpen') window.__fireUrlOpen = (u) => cb({ url: u });
            return Promise.resolve({ remove: () => { window.__fireUrlOpen = null; } });
          }
        }
      }
    };
  }, { url: link });

  const guest = await guestCtx.newPage();
  guest.on('pageerror', e => errs.push('guest: ' + String(e).slice(0, 140)));
  await guest.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(guest);

  const joinedRoom = await guest.waitForFunction(
    () => (window.ChaApp.state.joined ? window.ChaApp.state.room.id : false),
    { timeout: 60000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('另一台安卓点链接进房（走中继）', joinedRoom === roomId, String(joinedRoom));

  ok('访客连的确实是中继通道',
    await guest.evaluate(() => /^relay:\/\//.test(window.ChaApp.net.url || '')),
    await guest.evaluate(() => window.ChaApp.net.url));

  /* ---------------- 真的连上了吗：人数 + 笔迹双向 ---------------- */
  const hostSees = await host.evaluate(() => new Promise(resolve => {
    window.ChaApp.net.on('message', m => {
      if (m.t !== 'room:list') return;
      const r = (m.rooms || []).filter(x => x.id === window.ChaApp.state.room.id)[0];
      resolve(r ? r.online : -1);
    });
    window.ChaApp.net.send('room:list', {});
    setTimeout(() => resolve(-2), 4000);
  }));
  ok('房主看到 2 人在房间', hostSees >= 2, String(hostSees));

  // 真落一笔：鼠标在画布上拖一下，笔迹要真的穿过中继到房主那边。
  //
  // 注意这里的两段式判定：先确认「访客自己落上笔了」，再看「房主收到没有」。
  // 一次曾经只断言后者，落笔点被浮层挡住（访客自己也没画成）时报成
  // 「中继丢笔迹」，把一个测试布局问题误判成产品 bug。分开报才不会冤枉人。
  async function drawOnce(ox, oy) {
    const box = await guest.evaluate(() => {
      const c = document.querySelector('#canvasWrap') || document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const x = box.x + Math.round(box.w * ox);
    const y = box.y + Math.round(box.h * oy);
    await guest.mouse.move(x, y);
    await guest.mouse.down();
    await guest.mouse.move(x + 40, y + 30, { steps: 6 });
    await guest.mouse.move(x + 80, y + 10, { steps: 6 });
    await guest.mouse.up();
    await sleep(1200);
    return guest.evaluate(() => (window.ChaApp.engine.strokes || []).length);
  }

  // 试几个落笔点，直到访客那边确实产生了一笔（避开居中工具栏/浮层）
  let guestStrokes = await drawOnce(0.5, 0.5);
  for (const [ox, oy] of [[0.3, 0.65], [0.5, 0.2], [0.7, 0.75]]) {
    if (guestStrokes > 0) break;
    guestStrokes = await drawOnce(ox, oy);
  }
  ok('访客在本机画笔确实落下（前提条件）', guestStrokes > 0, String(guestStrokes));

  const hostGotStroke = await host.waitForFunction(
    () => (window.ChaApp.engine.strokes || []).length > 0, { timeout: 20000 }
  ).then(() => true).catch(() => false);
  ok('房主收到了访客的笔迹（数据真的过了中继）', hostGotStroke,
    '房主笔迹数 ' + await host.evaluate(() => String((window.ChaApp.engine.strokes || []).length)));

  /* ---------------- 两边挑到不同的公共 broker，也得能遇上 ---------------- */
  // 分享出去的入口是 relay://<房间号>，里面**没有**「哪台 broker」这个信息，
  // 访客是按自己那份 broker 列表独立挑的（列表还受 localStorage 里
  // 「上次好用那台」影响）。两边挑歪 = 谁也见不到谁，而且不报错。
  // 房主端因此把其余几台也挂上（多台并听）。这里把访客钉在另一台上验证它。
  const ALT_BROKER = 'wss://broker-cn.emqx.io:8084/mqtt';
  const altCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await altCtx.route('**/*', async route => {
    // 上下文关闭时可能还有在途请求，route 会被 dispose；
    // 那是收尾阶段的正常现象，不该把整个测试炸掉
    try {
      const resp = await route.fetch();
      const headers = Object.assign({}, resp.headers());
      delete headers['content-security-policy'];
      await route.fulfill({ response: resp, headers });
    } catch (e) {
      try { await route.abort(); } catch (e2) { /* 已关闭 */ }
    }
  });
  await altCtx.addInitScript(({ url, broker }) => {
    // 让它优先连另一台 broker（列表会把「上次好用」提到最前）
    try { localStorage.setItem('chahu.broker', broker); } catch (e) { /* about:blank 上会抛 */ }
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        App: {
          getLaunchUrl: () => Promise.resolve({ url }),
          addListener: () => Promise.resolve({ remove: () => {} })
        }
      }
    };
  }, { url: link, broker: ALT_BROKER });

  const alt = await altCtx.newPage();
  alt.on('pageerror', e => errs.push('alt: ' + String(e).slice(0, 140)));
  await alt.goto(BASE + '/?autotunnel=0&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await bootPage(alt);

  const altJoined = await alt.waitForFunction(
    () => (window.ChaApp.state.joined ? window.ChaApp.state.room.id : false), { timeout: 70000 }
  ).then(h => h.jsonValue()).catch(() => '');
  const altBroker = await alt.evaluate(() => {
    try { return localStorage.getItem('chahu.broker') || ''; } catch (e) { return ''; }
  });
  const hostBroker = await host.evaluate(() => {
    try { return localStorage.getItem('chahu.broker') || ''; } catch (e) { return ''; }
  });
  ok('访客落在另一台 broker 上也能进同一间房', altJoined === roomId,
    altJoined + ' @ ' + altBroker.replace(/^wss:\/\//, '') +
    '  ←房主在 ' + hostBroker.replace(/^wss:\/\//, ''));

  await altCtx.close();

  /* ---------------- 自动开启：房主什么都不点 ---------------- */
  // 「快速上手」的核心：开完房就该能直接分享，不该让用户先搞懂「公网联机」是什么。
  const autoCtx = await androidContext(browser);
  const auto = await autoCtx.newPage();
  auto.on('pageerror', e => errs.push('auto: ' + String(e).slice(0, 140)));
  await auto.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded' });  // 不带 autotunnel=0
  await bootPage(auto);
  await auto.evaluate(() => {
    document.querySelector('#nameInput').value = '懒人房主';
    document.querySelector('#newRoomName').value = '自动房' + (Date.now() % 9999);
    document.querySelector('#btnCreateRoom').click();
  });
  await auto.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });

  const autoPub = await auto.waitForFunction(
    () => (/^(webrtc|relay):\/\//.test(window.ChaApp.state.publicUrl || '') ? window.ChaApp.state.publicUrl : false),
    { timeout: 70000 }
  ).then(h => h.jsonValue()).catch(() => '');
  ok('开完房什么都不点，公网入口自动备好', /^(webrtc|relay):\/\//.test(autoPub), autoPub);

  const autoBtn = await auto.evaluate(() => {
    const b = document.querySelector('#btnTunnelToggle');
    return { text: b ? b.textContent.trim() : '', state: (document.querySelector('#tunnelState') || {}).textContent || '' };
  });
  ok('界面明确显示「已开启」，不会让人以为还要再点一下',
    /关闭公网联机/.test(autoBtn.text), autoBtn.text + ' / ' + autoBtn.state.trim().slice(0, 40));

  await autoCtx.close();

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await guestCtx.close();
  await hostCtx.close();
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（' + pass + ' 通过 / ' + fail + ' 失败）');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
