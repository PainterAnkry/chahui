/* 服务端健壮性：畸形 HTTP 请求不能把进程打挂。
 *
 * 背景（真实事故）：Node 的 HTTP 解析器接受 `GET // HTTP/1.1` 这种请求目标，
 * 但 `new URL('//', 'http://localhost')` 会抛 ERR_INVALID_URL；那个调用原本
 * 裸在请求处理器顶层、没有 try/catch，于是**一条 `//` 请求就让整个服务端退出**
 * （112 个房间一起断线）。修完后这条测试专门钉住它。
 *
 * 判据不是「有没有 200」而是「打完这串之后 /health 还活着 + pid 没变」——
 * 只断 HTTP 状态码的话，进程已经死了也可能收到连接层错误而看不出区别。
 *
 * 地址来源与别的测试一致：CLI 参数 > CHAHU_URL > 8440。
 * 注意：本测试直连 HTTP，收 http:// 前缀的地址。
 */
const http = require('http');
const net = require('net');

const BASE = (() => {
  const a = process.argv[2];
  const raw = (a && /^https?:\/\//.test(a)) ? a : (process.env.CHAHU_URL || 'http://127.0.0.1:8440/');
  return raw.replace(/\/?$/, '/');
})();
const HOST = (() => { try { return new URL(BASE).hostname; } catch (e) { return '127.0.0.1'; } })();
const PORT = (() => { try { return Number(new URL(BASE).port || 80); } catch (e) { return 8440; } })();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 4000 }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, body: null, raw: b.slice(0, 120) }); }
      });
    });
    req.on('error', e => resolve({ error: e.code || String(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
}

/** 往裸 TCP 上直接写一段原始 HTTP，收回响应开头（不解析，只看有没有东西/是否被拒） */
function rawRequest(payload) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST, () => sock.write(payload));
    let buf = '';
    sock.on('data', d => buf += d.toString('latin1'));
    sock.on('error', e => resolve({ error: e.code || String(e), buf }));
    sock.setTimeout(3000, () => { sock.destroy(); resolve({ buf, timeout: true }); });
    sock.on('close', () => resolve({ buf }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n【零】先确认服务端在（打之前）');
  const h0 = await health();
  ok('服务端可达 /health', h0.status === 200 && h0.body && h0.body.ok === true, h0);
  if (h0.status !== 200) {
    console.log('\n服务端不在，后面的用例没法跑。结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
  const pid0 = h0.body.pid;
  const up0 = h0.body.uptime;
  ok('/health 带 pid（用来判断进程有没有被换掉）', typeof pid0 === 'number', pid0);
  ok('/health 带协议版本（顺带核对身份信息齐全）', typeof h0.body.protocolVersion !== 'undefined', h0.body);

  /* 每个畸形请求打完都要复查：还活着 + pid 没变。
     pid 变了说明它其实崩过、只是被外面重新拉起 —— 那也算失败。 */
  const CASES = [
    { name: '请求目标为 `//`（曾把服务端打挂的那条）', raw: 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '请求目标为 `http://`（缺主机）', raw: 'GET http:// HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '请求目标含未编码空格', raw: 'GET /a b c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '请求目标为超长斜杠串', raw: 'GET ' + '/'.repeat(300) + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '请求行版本号异常', raw: 'GET / HTTP/9.9\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '请求头带畸形字段', raw: 'GET /x HTTP/1.1\r\nHost: x\r\nBad Header: \r\nConnection: close\r\n\r\n' },
    { name: '只有半截请求行', raw: 'GET' },
    { name: '完全不是 HTTP', raw: 'not-http-at-all\r\n\r\n' },
    { name: '请求目标为 `*`', raw: 'OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '路径里塞了空字节转义', raw: 'GET /%00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    { name: '超长单行请求头', raw: 'GET / HTTP/1.1\r\nHost: x\r\nX-Big: ' + 'a'.repeat(9000) + '\r\nConnection: close\r\n\r\n' },
    { name: 'CONNECT 方法', raw: 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n' }
  ];

  console.log('\n【一】逐条打畸形请求，每条打完都复查存活');
  for (const c of CASES) {
    await rawRequest(c.raw);
    await sleep(220);
    const h = await health();
    const alive = h.status === 200 && h.body && h.body.ok === true;
    ok('打完后仍存活：' + c.name, alive, h.error || h.status);
    if (alive) {
      ok('  ↳ pid 未变（没被重启顶掉）：' + c.name, h.body.pid === pid0, { before: pid0, after: h.body.pid });
    }
  }

  console.log('\n【二】连打（一次性灌一批畸形请求，看会不会攒出问题）');
  for (let i = 0; i < 40; i++) {
    rawRequest('GET ' + '/'.repeat(1 + (i % 5)) + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  }
  await sleep(1200);
  const h2 = await health();
  ok('40 条连打后仍存活', h2.status === 200 && h2.body && h2.body.ok === true, h2.error || h2.status);
  ok('pid 仍未变', h2.status === 200 && h2.body.pid === pid0, h2.status === 200 ? h2.body.pid : h2);
  ok('uptime 是增长的（证明确实是同一个活着的进程）',
    h2.status === 200 && h2.body.uptime > up0, { up0, up2: h2.status === 200 ? h2.body.uptime : null });

  console.log('\n【三】正常请求不受影响');
  const idx = await new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/', timeout: 4000 }, (res) => {
      let n = 0;
      res.on('data', d => n += d.length);
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    req.on('error', e => resolve({ error: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
  ok('GET / 正常返回页面', idx.status === 200 && idx.bytes > 500, idx);

  const rooms = await new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/rooms', timeout: 4000 }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode }); } });
    });
    req.on('error', e => resolve({ error: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
  ok('/api/rooms 正常返回 JSON', rooms.status === 200 && rooms.body && Array.isArray(rooms.body.rooms), rooms.status || rooms.error);

  console.log('\n【四】不存在的路径仍应 404（没有被「降级成根路径」掩盖）');
  const miss = await new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/definitely-not-here-' + Date.now(), timeout: 4000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', e => resolve({ error: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
  ok('普通 404 路径依然 404', miss.status === 404, miss);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
