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
    const resp = await route.fetch();
    const headers = Object.assign({}, resp.headers());
    delete headers['content-security-policy'];
    await route.fulfill({ response: resp, headers });
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

  // 真落一笔：鼠标在画布上拖一下，笔迹要真的穿过中继到房主那边
  const box = await guest.evaluate(() => {
    const c = document.querySelector('#canvasWrap') || document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await guest.mouse.move(box.x, box.y);
  await guest.mouse.down();
  await guest.mouse.move(box.x + 40, box.y + 30, { steps: 6 });
  await guest.mouse.move(box.x + 80, box.y + 10, { steps: 6 });
  await guest.mouse.up();
  await sleep(1200);

  const hostGotStroke = await host.waitForFunction(
    () => (window.ChaApp.engine.strokes || []).length > 0, { timeout: 15000 }
  ).then(() => true).catch(() => false);
  ok('房主收到了访客的笔迹（数据真的过了中继）', hostGotStroke,
    await host.evaluate(() => String((window.ChaApp.engine.strokes || []).length)));

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

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

  await guestCtx.close();
  await hostCtx.close();
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（' + pass + ' 通过 / ' + fail + ' 失败）');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
