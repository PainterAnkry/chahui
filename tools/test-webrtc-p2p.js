/**
 * WebRTC P2P 公网直连 · 全链路测试
 *
 * 验证：安卓式房主（Capacitor 壳里的 local-core + webrtc-host）与普通访客
 * （net.js 的 webrtc:// 通道）能在**没有任何茶绘服务器参与联机**的前提下
 * 互相看到对方的房间与笔迹 —— 信令用本地起的 PeerJS Server，数据走 DataChannel。
 *
 * 用法：node tools/test-webrtc-p2p.js [页面基地址]（默认 http://127.0.0.1:8437，需先起服务端托管页面）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { chromium } = require('./pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8437';
const SIG_PORT = Number(process.argv[3]) || 9527;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // 本地信令服务器（生产用 PeerJS 免费云，测试用本地 —— 不依赖外网）。
  // ⚠ 必须把 port 交给 PeerServer 自己监听：不给 port 它就不会把 WebSocket
  //   upgrade 处理挂到我们的 server 上，握手会以「Unexpected response」失败。
  const { PeerServer } = require('peer');
  PeerServer({ port: SIG_PORT, debug: false });
  await sleep(800);
  const sigPort = SIG_PORT;
  console.log('本地信令服务器：ws://127.0.0.1:' + sigPort);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];

  /* ---------------- 房主端：Capacitor 壳环境（安卓同款路径） ---------------- */
  const ctxH = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const pageH = await ctxH.newPage();
  // 伪装 Capacitor → android-shim 激活（chahuDesktop + local-core 全套）
  await pageH.addInitScript(function () {
    window.Capacitor = { isNativePlatform: function () { return true; } };
  });
  pageH.on('pageerror', e => errors.push('host: ' + e.message));
  await pageH.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pageH.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });

  // 信令指到本地（signalOpts 在 start() 时读取，改配置即可）
  await pageH.evaluate((port) => {
    window.CHAHU_CONFIG.signalServer = 'ws://127.0.0.1:' + port;
    window.CHAHU_CONFIG.publicServer = ''; // 断开与默认公网服务器的关联（纯 P2P 环境）
  }, sigPort);

  // 官方公共服务器已下线：安卓（Capacitor）缺省就落在离线模式（local://）。
  // 老版本这里要手动点「切到离线」；现在先看默认值，只有不在离线时才点。
  await pageH.evaluate(() => {
    document.querySelector('#nameInput').value = 'H';
    if (!window.ChaApp.isOffline()) {
      const btn = document.querySelector('#btnServerToggle');
      if (btn) btn.click(); else window.ChaApp.toggleServer();
    }
  });
  await pageH.waitForFunction(() => window.ChaApp.isOffline(), { timeout: 15000 });
  ok('安卓（无官方服）默认 / 切到离线模式（local://）', true);

  // 建房（离线状态下走 local-core 状态机）
  await pageH.evaluate(() => {
    document.querySelector('#nameInput').value = 'H';
    document.querySelector('#newRoomName').value = 'P2P房';
    document.querySelector('#btnCreateRoom').click();
  });
  await pageH.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  const roomId = await pageH.evaluate(() => window.ChaApp.state.room.id);
  ok('房主在离线模式建房', !!roomId, 'room=' + roomId);

  // 开公网联机（安卓路径 → WebRTC 优先）
  await pageH.evaluate(() => { const b = document.querySelector('#btnTunnelToggle'); if (b && !b.disabled) b.click(); });
  let hostUrl = '';
  try {
    await pageH.waitForFunction(() => /^webrtc:\/\//.test(window.ChaApp.state.publicUrl || ''), { timeout: 30000 });
    hostUrl = await pageH.evaluate(() => window.ChaApp.state.publicUrl);
    ok('公网联机开启（WebRTC P2P）', true, hostUrl);
  } catch (e) {
    const st = await pageH.evaluate(() => window.ChaApp.state.tunnel);
    ok('公网联机开启（WebRTC P2P）', false, JSON.stringify(st).slice(0, 160));
  }

  /* ---------------- 分享链接：纯安卓（没有页面托管）也要能用 ---------------- */
  // 没有官方公网服 / 自建服务端时，shareBase() 推不出页面地址 —— 此时分享
  // 必须退回 chahui:// 应用链接，而不是把裸房间号复制出去（本次修的 bug）。
  const appShare = await pageH.evaluate(() => {
    window.ChaApp.showInfo();
    return (document.querySelector('#shareLinkText') || {}).textContent || '';
  });
  ok('无页面托管时分享 chahui:// 应用链接（不是裸房间号）',
    /^chahui:\/\/join\?room=/.test(appShare) && /server=webrtc%3A%2F%2F/.test(appShare), appShare);

  // 配了自建服务端（网页版页面托管）→ 生成完整 http 分享链接，页面 + P2P 入口都在里面
  await pageH.evaluate((base) => {
    window.CHAHU_CONFIG.publicServer = base.replace(/^http/, 'ws') + '/ws';
    window.ChaApp.showInfo();
  }, BASE);
  const shareAll = await pageH.evaluate(() => (document.querySelector('#shareLinkText') || {}).textContent || '');
  const share = shareAll.split('\n')[0].trim();
  ok('生成完整分享链接（页面地址 + ?room + ?server=webrtc://）',
    /^http:\/\/127\.0\.0\.1:\d+\/\?room=/.test(share) && /server=webrtc%3A%2F%2F/.test(share) &&
    /server=webrtc:\/\//.test(decodeURIComponent(share)),
    share);
  ok('房间信息里同时给出 chahui:// 应用链接', /\n茶绘应用链接：chahui:\/\/join\?room=/.test(shareAll), shareAll);

  /* ---------------- 访客端：普通浏览器，直接打开分享链接 ---------------- */
  if (hostUrl && /^https?:\/\//.test(share)) {
    const ctxG = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const pageG = await ctxG.newPage();
    pageG.on('pageerror', e => errors.push('guest: ' + e.message));
    // 不手工塞 localStorage —— 走用户真实路径：点开分享链接，
    // 由 ?server=webrtc://… 切到 P2P 通道，再由 ?room= 自动进房。
    // 信令服务器用 ?signal= 参数（config.js 加载时读取，与生产自建信令同一路径）。
    await pageG.goto(share + '&signal=' + encodeURIComponent('ws://127.0.0.1:' + SIG_PORT),
      { waitUntil: 'domcontentloaded' });
    await pageG.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });

    let joined = false;
    try {
      await pageG.waitForFunction(() => window.ChaApp.state.joined, { timeout: 40000 });
      joined = true;
    } catch (e) { /* join 超时 */ }
    ok('访客经 P2P 进入房间', joined);
    if (joined) {
      // 访客画一笔
      const m = await pageG.evaluate(() => {
        const r = document.querySelector('#stage').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await pageG.evaluate(() => { const mk = document.querySelector('#entryMask'); if (mk) mk.style.display = 'none'; });
      await pageG.mouse.move(m.x - 60, m.y - 40);
      await pageG.mouse.down();
      for (let i = 1; i <= 6; i++) await pageG.mouse.move(m.x - 60 + i * 14, m.y - 40 + i * 8);
      await pageG.mouse.up();
      await sleep(1200);
      // 房主应看到：成员 2 人 + 1 笔笔迹
      const seen = await pageH.evaluate(() => ({
        strokes: document.querySelector('#strokeCount') ? document.querySelector('#strokeCount').textContent : '',
        members: document.querySelector('#memberCount') ? document.querySelector('#memberCount').textContent : '',
        undoLen: window.ChaApp.state.opUndo ? window.ChaApp.state.opUndo.length : -1
      }));
      ok('房主收到访客笔迹', /([1-9]\d*)/.test(seen.strokes) && parseInt(seen.strokes, 10) >= 1,
        'strokes=' + seen.strokes + ' members=' + seen.members);
      ok('房主看到访客加入（2 人在线）', parseInt(seen.members, 10) === 2, 'members=' + seen.members);
    }
    await ctxG.close();
  }

  console.log('\n浏览器报错数（应为 0 个致命）: ' + errors.length);
  errors.slice(0, 5).forEach(e => console.log('  · ' + e.slice(0, 140)));

  await browser.close();
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
