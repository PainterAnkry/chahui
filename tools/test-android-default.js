/**
 * 安卓入口回归 · 默认服务器 / 「无需开启」按钮
 *
 * 守着这次的两条产品决定：
 *   1. 官方公共服务器下线：publicServer 空、老版本记住的 139.199.90.209 自动清掉，
 *      安卓缺省落在离线模式（local://），不再假装连一个连不上的地址。
 *   2. 连着公网服务器时，入口页不再摆一颗永远点不动的「无需开启」按钮，
 *      只留一句「房间本来就在公网上，直接分享」的说明；房间信息里也不出现
 *      「开启公网联机」按钮。
 *
 * 用法: node tools/test-android-default.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://127.0.0.1:8437';
const WS = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + '   ' + JSON.stringify(extra)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await ctx.addInitScript(function () {
    window.Capacitor = { isNativePlatform: function () { return true; } };
    // 模拟老版本用户：localStorage 里还记着已下线的官方服
    try { localStorage.setItem('chahu.server', 'ws://139.199.90.209:8437/ws'); } catch (e) { /* ignore */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await page.waitForFunction(() => window.ChaApp.isOffline(), { timeout: 15000 });

  const boot = await page.evaluate(() => ({
    url: window.ChaApp.net.url,
    local: window.ChaApp.isOffline(),
    publicServer: window.CHAHU_CONFIG.publicServer,
    stored: localStorage.getItem('chahu.server')
  }));
  ok('官方默认服务器已解除（CHAHU_CONFIG.publicServer 为空）', boot.publicServer === '', boot.publicServer);
  ok('老版本记住的官方地址被清掉', !boot.stored, boot.stored);
  ok('安卓缺省落在离线模式（local://）', boot.url === 'local://' && boot.local, boot.url);

  // 手动连到「公网服务器」（这里就用页面托管服务器代）
  await page.evaluate((ws) => {
    window.ChaApp.openEntry(true);
    const i = document.querySelector('#serverInput');
    i.value = ws;
    i.dispatchEvent(new Event('change'));
  }, WS);
  await page.waitForFunction(() => window.ChaApp.net.isOpen() && !window.ChaApp.isOffline(), { timeout: 15000 });
  await sleep(400);
  await page.evaluate(() => window.ChaApp.openEntry(true));

  const tun = await page.evaluate(() => {
    const b = document.querySelector('#btnTunnelToggle');
    const row = document.querySelector('#tunnelRow');
    return {
      rowVisible: !!(row && row.offsetParent),
      btnVisible: !!(b && b.offsetParent),
      btnText: b ? b.textContent.trim() : '',
      state: (document.querySelector('#tunnelState') || {}).textContent || ''
    };
  });
  ok('公网联机那一行还在（安卓能开本机房）', tun.rowVisible);
  ok('不再显示「无需开启」按钮', !tun.btnVisible && tun.btnText !== '无需开启',
    'visible=' + tun.btnVisible + ' text=' + tun.btnText);
  ok('保留一句「房间本来就在公网上」的说明', /房间本来就在公网上/.test(tun.state), tun.state);

  // 房间信息里的「公网入口」也不该出现「开启公网联机」按钮
  const info = await page.evaluate(() => {
    const S = window.ChaApp.state;
    S.room = { id: 'r_default_test', name: '默认服房', width: 800, height: 600, online: 1 };
    S.me.isOwner = true;
    window.ChaApp.showInfo();
    return {
      hasOn: !!document.querySelector('#btnTunnelOn'),
      hasOff: !!document.querySelector('#btnTunnelOff'),
      body: (document.querySelector('#infoBody') || {}).textContent || ''
    };
  });
  ok('房间信息里不再出现「开启公网联机」按钮', !info.hasOn);
  ok('房间信息里说明「房间本来就在公网上」', /房间本来就在公网上/.test(info.body));

  ok('全程没有 JS 报错', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
