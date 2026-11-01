/**
 * 茶绘 · 「附近服务器」扫描回归（2.3.0）
 *
 * 守三条线：
 *   1. 入口页有扫描入口，网段跟着当前服务器端口走（自建服务器常见改端口）；
 *   2. 填一个真网段能扫到同一网段里开着的茶绘服务器 —— 而且只认真的茶绘服务端
 *      （HTTP 探通之后还要过一次 WebSocket 握手，同端口上的别的服务不会误报）；
 *   3. 点结果就切过去 —— 用户不用去抄 IP。
 *
 * 用法: node tools/test-lan-scan.js [http://127.0.0.1:8437]
 *   BASE 必须是**真的在跑**的茶绘服务端，且监听 0.0.0.0（默认就是），
 *   否则本机的内网地址访问不到它，扫描自然扫不到。
 */
'use strict';
const os = require('os');
const { chromium } = require('./pw.js');

const BASE = (process.argv[2] || 'http://127.0.0.1:8437').replace(/\/+$/, '');
const PORT = (function () {
  const m = /:(\d+)\s*$/.exec(BASE);
  return m ? parseInt(m[1], 10) : 8437;
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 本机的私有网段地址（要扫的就是它们所在的那一段） */
function privateIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) {
    for (const a of nets[k] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

(async () => {
  console.log('茶绘 · 附近服务器扫描 回归\n');

  const ips = privateIps();
  if (!ips.length) {
    console.log('  SKIP: 这台机器没有私有网段地址（10/172.16-31/192.168），扫描没有可扫的目标');
    process.exit(0);
  }
  const target = ips[0];
  const prefix = target.split('.').slice(0, 3).join('.');
  console.log('  本机网段: ' + prefix + '.0/24（目标 ' + target + ':' + PORT + '）\n');

  // 无头 Chrome 会把「页面 → 内网地址」的请求当成本地网络访问拦掉，真机不拦
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 30000 });
  await sleep(800);

  /* ---- 1) 入口页有扫描入口 ---- */
  const ui = await page.evaluate(() => ({
    row: !!document.querySelector('#lanScanRow'),
    input: !!document.querySelector('#lanScanPrefix'),
    btn: !!document.querySelector('#btnLanScan'),
    state: !!document.querySelector('#lanScanState')
  }));
  ok('入口页有「附近服务器」一行', ui.row && ui.input && ui.btn && ui.state);

  // 端口要跟着当前服务器走：写死 8437 的话，自建服务器换个端口就全扫空了
  const portFollows = await page.evaluate(() => {
    const url = window.ChaApp.net.url;
    return { url, scanned: /:(\d+)/.exec(url) ? parseInt(/:(\d+)/.exec(url)[1], 10) : 0 };
  });
  ok('扫描端口跟随当前服务器', portFollows.scanned === PORT, portFollows.url + ' → ' + portFollows.scanned);

  /* ---- 2) 没有网段时提示手填，别默默扫空气 ---- */
  await page.fill('#lanScanPrefix', '');
  await page.click('#btnLanScan');
  await sleep(900);
  const emptyState = (await page.textContent('#lanScanState')) || '';
  ok('没有可用网段时提示手填', /填一段网段/.test(emptyState), emptyState.trim());

  /* ---- 3) 真扫一个网段 ---- */
  await page.fill('#lanScanPrefix', prefix);
  await page.click('#btnLanScan');
  // 扫描是分批的，一开始按钮就该锁住，避免连点堆出两轮扫描
  ok('扫描期间按钮置灰', await page.evaluate(() => document.querySelector('#btnLanScan').disabled) === true);

  let hits = [];
  try {
    await page.waitForSelector('#lanFound .lan-hit', { timeout: 90000 });
    hits = await page.evaluate(() =>
      [].map.call(document.querySelectorAll('#lanFound .lan-hit'), b => b.getAttribute('data-url') || ''));
  } catch (e) { /* 扫不到就是下面断言失败 */ }

  ok('扫到了本机这段网段里的茶绘服务器',
    hits.some(u => u.indexOf(target) >= 0),
    hits.length ? hits.join(' | ') : '（无结果）');

  ok('扫到的地址带着当前端口', hits.length > 0 && hits.every(u => u.indexOf(':' + PORT) > 0),
    hits[0] || '');

  const stateText = ((await page.textContent('#lanScanState')) || '').trim();
  ok('结束后状态是「找到 N 个」', /找到\s*\d+\s*个/.test(stateText), stateText);

  /* ---- 4) 点一下就连过去 ---- */
  if (hits.length) {
    await page.click('#lanFound .lan-hit');
    await sleep(500);
    const srv = await page.inputValue('#serverInput');
    ok('点结果会填进服务器地址', srv.indexOf(target) >= 0 || srv.indexOf(prefix) >= 0, srv);

    const connected = await page.waitForFunction(
      () => window.ChaApp.net.isOpen(), { timeout: 25000 }
    ).then(() => true).catch(() => false);
    ok('能连上扫到的服务器', connected);
  } else {
    ok('点结果会填进服务器地址', false, '没有结果可点');
    ok('能连上扫到的服务器', false, '没有结果可点');
  }

  ok('全程没有脚本报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（' + pass + ' 通过 / ' + fail + ' 失败）');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
