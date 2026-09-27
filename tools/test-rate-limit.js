/* 限流：服务端在「速率」上到底有没有闸门（CWE-770）。
 *
 * 为什么要有这条用例：服务端经常被 tools/expose.js 的隧道挂到公网，而它原本只有
 * 「容量」上限（MAX_ROOMS / MAX_MEMBERS / maxPayload），没有速率上限 —— 一个脚本
 * 就能把带宽和事件循环占满。这条用例自己起**两台配了不同环境变量**的服务端，钉住三件事：
 *
 *   ① HTTP 动态接口（/api/*、/health）与静态文件各有各的桶：超了回 429 + Retry-After，
 *      而且两档互不牵连（静态那档被刷爆不该连累接口），静一会儿还要能自己恢复；
 *   ② WS 的单 IP 并发连接数与单连接消息速率：到点回 rate_limited 并 1008 断开；
 *   ③ 回环豁免真的生效（本机测试 / purge 脚本 / 桌面端不被误伤），而**隧道流量照限**
 *      —— 隧道请求的对端也是回环，只有认了 CF-Connecting-IP / X-Forwarded-For
 *      才能把账记到真正的访客头上。这一条是整件事的命门：认错就全是白做。
 *
 * 两台服务端都用临时存档目录（.tmp-rooms-ratelimit/，已在 .gitignore 里），不碰真存档。
 * 子进程日志写文件而不是走管道：管道在受限环境（Windows 沙箱 / 无命名管道权限）下会
 * EPERM，run-all-tests.js 起服务端时也是这么写的。
 *
 * 用法: node tools/test-rate-limit.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws'));
const TMP = path.join(ROOT, '.tmp-rooms-ratelimit');
const LOG_A = path.join(os.tmpdir(), 'chahui-ratelimit-a.log');
const LOG_B = path.join(os.tmpdir(), 'chahui-ratelimit-b.log');

const A = 8473;   // 「连回环也限」那一台：阈值压到个位数，好断言
const B = 8474;   // 「默认阈值」那一台：验回环豁免与隧道记账

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, pathName, headers) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port, path: pathName, headers: headers || {}, timeout: 5000
    }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({
        status: res.statusCode, retryAfter: res.headers['retry-after'], body: b.slice(0, 140)
      }));
    });
    r.on('error', e => resolve({ error: e.code || String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'TIMEOUT' }); });
    r.end();
  });
}

/** 一口气发 n 条（并发的，就是要打成突发） */
function burst(port, pathName, n, headers) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(req(port, pathName, headers));
  return Promise.all(out);
}

function openWs(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: headers || {} });
    const got = { hello: false, err: null, code: null, reason: '' };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.t === 'hello:ok') got.hello = true;
      if (m.t === 'error') got.err = m;
    });
    ws.on('close', (code, reason) => { got.code = code; got.reason = String(reason || ''); resolve({ ws, got }); });
    ws.on('error', () => { /* close 会跟着来 */ });
    setTimeout(() => resolve({ ws, got }), 4000);
  });
}

function startServer(port, tag, env) {
  const dir = path.join(TMP, tag);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(tag === 'a' ? LOG_A : LOG_B, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir }, env),
    stdio: ['ignore', log, log]
  });
  return child;
}

async function waitUp(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req(port, '/health');
    if (r.status === 200) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  console.log('\n【零】起两台自己的服务端（A 连回环也限 / B 默认豁免回环）');
  fs.mkdirSync(TMP, { recursive: true });
  const a = startServer(A, 'a', {
    RATE_LIMIT_LOOPBACK: '1',
    HTTP_API_RATE: '2', HTTP_API_BURST: '3',
    HTTP_STATIC_RATE: '2', HTTP_STATIC_BURST: '3',
    WS_CONN_PER_IP: '3', WS_CONN_RATE: '100', WS_CONN_BURST: '100', WS_CONN_MAX: '1000',
    WS_MSG_RATE: '5', WS_MSG_BURST: '5'
  });
  const b = startServer(B, 'b', {
    WS_CONN_PER_IP: '2'      // 其余全默认（HTTP API 40/秒、突发 80）
  });
  const upA = await waitUp(A, 20000);
  const upB = await waitUp(B, 20000);
  ok('A 台起来了（看 ' + LOG_A + '）', upA);
  ok('B 台起来了（看 ' + LOG_B + '）', upB);
  if (!upA || !upB) {
    try { a.kill(); b.kill(); } catch (e) { /* */ }
    console.log('\n服务端没起来，后面没法跑。结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
  const healthA = await req(A, '/health');
  ok('A 台 /health 报 pid（确实是新起的那个进程）', healthA.status === 200, healthA);

  try {
    /* ---------------------------------------------------------- HTTP 两档 */
    console.log('\n【一】HTTP：动态接口与静态文件各有各的桶');
    await sleep(2500);                      // 等启动探测用掉的那点令牌回满（2/秒）

    const s1 = await req(A, '/index.html');
    ok('静态文件第 1 条通过', s1.status === 200, s1);
    const s2 = await req(A, '/index.html');
    const s3 = await req(A, '/index.html');
    ok('静态文件继续放行（突发 3）', s2.status === 200 && s3.status === 200, [s2.status, s3.status]);
    const s4 = await req(A, '/index.html');
    ok('静态文件第 4 条被 429', s4.status === 429, s4);
    ok('429 带 Retry-After', /^\d+$/.test(String(s4.retryAfter)), s4.retryAfter);
    ok('429 是 JSON（客户端能读懂，不是白页）', /rate_limited/.test(s4.body || ''), s4.body);

    const apiAfterStatic = await req(A, '/api/rooms');
    ok('静态那档被刷爆不影响接口那档（各记各的账）', apiAfterStatic.status === 200, apiAfterStatic);

    const a2 = await req(A, '/api/rooms');
    const a3 = await req(A, '/api/rooms');
    ok('/api/* 与 /health 同一档：前 3 条放行', a2.status === 200 && a3.status === 200, [a2.status, a3.status]);
    const a4 = await req(A, '/api/rooms');
    ok('/api/* 第 4 条被 429', a4.status === 429, a4);
    const aH = await req(A, '/health');
    ok('/health 与 /api/* 同一档（第 5 条也 429）', aH.status === 429, aH);

    await sleep(2500);
    const recovered = await req(A, '/health');
    ok('静一会儿令牌回补，恢复正常（不是一拒到底）', recovered.status === 200, recovered);

    /* ------------------------------------------------------------ WS */
    console.log('\n【二】WS：单 IP 并发连接数 / 单连接消息速率');
    await sleep(2500);                      // 让上面那档 HTTP 的令牌不干扰下面的判断
    const c1 = await openWs(A);
    ok('正常客户端握手到 hello:ok', c1.got.hello === true, c1.got);
    const c2 = await openWs(A);
    const c3 = await openWs(A);
    ok('第 2、3 条连接正常', c2.got.hello === true && c3.got.hello === true,
      [c2.got.hello, c3.got.hello]);
    const c4 = await openWs(A);
    ok('第 4 条被拒（单 IP 上限 3）',
      !c4.got.hello && (c4.got.code === 1008 || (c4.got.err && c4.got.err.code === 'rate_limited')),
      c4.got);
    ok('被拒时先回 rate_limited，客户端知道为什么',
      !!(c4.got.err && c4.got.err.code === 'rate_limited'), c4.got.err);

    try { c1.ws.close(); } catch (e) { /* */ }
    try { c2.ws.close(); } catch (e) { /* */ }
    try { c3.ws.close(); } catch (e) { /* */ }
    await sleep(400);                       // 等 close 把连接数还回去

    const flood = await openWs(A);
    ok('断开后还能再连上（连接数是还回去的，不是只增不减）', flood.got.hello === true, flood.got);
    let closed = false;
    flood.ws.on('close', () => { closed = true; });
    for (let i = 0; i < 60 && !closed; i++) {
      try { flood.ws.send(JSON.stringify({ t: 'ping', at: Date.now() })); } catch (e) { break; }
    }
    await sleep(600);
    ok('连发 60 条消息被 1008 掐掉（单连接消息速率）', closed || flood.ws.readyState === WebSocket.CLOSED,
      { readyState: flood.ws.readyState, closed: closed });
    try { flood.ws.close(); } catch (e) { /* */ }

    /* -------------------------------------------------- 回环豁免 / 隧道记账 */
    console.log('\n【三】默认阈值那台：回环豁免，但隧道流量照限');
    const plain = await burst(B, '/api/rooms', 150);
    ok('回环（本机工具 / 测试 / 桌面端）150 连发全部放行 —— 不误伤自己人',
      plain.every(r => r.status === 200),
      { n200: plain.filter(r => r.status === 200).length, n429: plain.filter(r => r.status === 429).length });

    const viaTunnel = await burst(B, '/api/rooms', 200, { 'CF-Connecting-IP': '203.0.113.7' });
    const t200 = viaTunnel.filter(r => r.status === 200).length;
    const t429 = viaTunnel.filter(r => r.status === 429).length;
    ok('带 CF-Connecting-IP 的请求被限（隧道访客记的是真 IP，不是回环）',
      t429 > 0 && t200 > 0, { n200: t200, n429: t429 });

    const xff = await burst(B, '/api/rooms', 200, { 'X-Forwarded-For': '198.51.100.9, 10.0.0.1' });
    ok('只带 X-Forwarded-For 的请求同样被限（别的隧道也认）',
      xff.some(r => r.status === 429), { n429: xff.filter(r => r.status === 429).length });

    const w1 = await openWs(B, { 'CF-Connecting-IP': '203.0.113.7' });
    const w2 = await openWs(B, { 'CF-Connecting-IP': '203.0.113.7' });
    const w3 = await openWs(B, { 'CF-Connecting-IP': '203.0.113.7' });
    ok('隧道访客的第 1、2 条 WS 正常（上限 2）', w1.got.hello === true && w2.got.hello === true,
      [w1.got.hello, w2.got.hello]);
    ok('同一隧道访客的第 3 条 WS 被拒',
      !w3.got.hello && (w3.got.code === 1008 || (w3.got.err && w3.got.err.code === 'rate_limited')),
      w3.got);
    try { w1.ws.close(); } catch (e) { /* */ }
    try { w2.ws.close(); } catch (e) { /* */ }

    const localWsB = await openWs(B);
    ok('本机（回环）WS 不受单 IP 上限影响', localWsB.got.hello === true, localWsB.got);
    try { localWsB.ws.close(); } catch (e) { /* */ }
  } finally {
    try { a.kill(); } catch (e) { /* */ }
    try { b.kill(); } catch (e) { /* */ }
    await sleep(200);
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('崩了: ' + (e && e.stack || e));
  process.exit(2);
});
