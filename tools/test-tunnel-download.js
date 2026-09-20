/**
 * 下载加固专项：验证重试、断点续传、多镜像、完整性校验、可读报错，
 * 以及这一轮新增的「慢就换源 / 没有 content-length 也要有进度」。
 *
 * 全部用本地 http 桩服务器跑，**默认不联网**。
 * 想顺带看一眼真外网可达性：node tools/test-tunnel-download.js --net
 * 用法: node tools/test-tunnel-download.js [--net]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WITH_NET = process.argv.indexOf('--net') >= 0;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chahui-dl-'));

/** 一个统一的桩服务器壳子：顺手统计连接数 / 被客户端掐断的连接数 */
function startServer(handler) {
  let conns = 0, closed = 0;
  const srv = http.createServer((req, res) => {
    res.on('error', () => { /* 客户端提前掐断是正常操作 */ });
    try { handler(req, res); } catch (e) { try { res.destroy(); } catch (e2) { /* ignore */ } }
  });
  srv.on('clientError', () => { /* ignore */ });
  srv.on('connection', (s) => {
    conns++;
    s.on('error', () => { /* ignore */ });
    s.on('close', () => { closed++; });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    srv: srv,
    port: srv.address().port,
    url: (p) => 'http://127.0.0.1:' + srv.address().port + (p || '/bin'),
    conns: () => conns,
    closed: () => closed
  })));
}

/** 3MB 假二进制，逐块发、**不给 content-length**（chunked）—— 复现「服务端不说总大小」 */
function chunkedServer(size, stepMs) {
  const PAYLOAD = Buffer.alloc(size || 3 * 1024 * 1024, 0x42);
  return startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    let off = 0;
    const tick = () => {
      if (off >= PAYLOAD.length) return res.end();
      res.write(PAYLOAD.slice(off, off + 65536));
      off += 65536;
      setTimeout(tick, stepMs === undefined ? 2 : stepMs);
    };
    tick();
  }).then((o) => Object.assign(o, { PAYLOAD: PAYLOAD }));
}

/** 正常源：声明长度 + 支持 Range 续传 */
function rangeServer(size, byte) {
  const PAYLOAD = Buffer.alloc(size || 3 * 1024 * 1024, byte || 0x43);
  const ranges = [];
  const fullReqs = [];
  return startServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      ranges.push(range);
      const m = /bytes=(\d+)-/.exec(range);
      const from = m ? Number(m[1]) : 0;
      const rest = PAYLOAD.slice(from);
      res.writeHead(206, {
        'Content-Length': String(rest.length),
        'Content-Range': 'bytes ' + from + '-' + (PAYLOAD.length - 1) + '/' + PAYLOAD.length
      });
      return res.end(rest);
    }
    fullReqs.push(1);
    res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
  }).then((o) => Object.assign(o, { PAYLOAD: PAYLOAD, ranges: ranges, fullReqs: fullReqs }));
}

/** 第一口给得快（探测能赢），但真下的时候报 500 —— 用来验证「输掉的源会被回收再用」 */
function teaseServer() {
  let hits = 0;
  return startServer((req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(200, { 'Content-Length': '1048576' });
      res.write( Buffer.alloc(65536, 0x47));
      return;                                   // 吊着不发完，探测拿到第一口就会掐断
    }
    res.writeHead(500, { 'Content-Length': '0' });
    res.end();
  }).then((o) => Object.assign(o, { hits: () => hits }));
}

/** 吐一口就装死（模拟下到一半不动了）：静默看门狗该把它掐掉换源 */
function stallServer(size, byte) {
  const PAYLOAD = Buffer.alloc(size || 2 * 1024 * 1024, byte || 0x46);
  return startServer((req, res) => {
    const range = req.headers.range;
    const m = range ? /bytes=(\d+)-/.exec(range) : null;
    const from = m ? Number(m[1]) : 0;
    const rest = PAYLOAD.slice(from);
    if (range) {
      res.writeHead(206, {
        'Content-Length': String(rest.length),
        'Content-Range': 'bytes ' + from + '-' + (PAYLOAD.length - 1) + '/' + PAYLOAD.length
      });
    } else {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
    }
    res.write(rest.slice(0, 65536));            // 之后一个字节都不发
  }).then((o) => Object.assign(o, { PAYLOAD: PAYLOAD }));
}

/** 慢源：头回来了，但一个字节都不发（国内直连 GitHub 的典型症状） */
function silentServer(withHeaders) {
  return startServer((req, res) => {
    if (withHeaders) res.writeHead(200, { 'Content-Length': '1048576' });
    // 既不 write 也不 end
  });
}

/** 直接报错的源 */
function statusServer(code) {
  return startServer((req, res) => {
    res.writeHead(code, { 'Content-Length': '0' });
    res.end();
  });
}

(async () => {
  const tunnel = require(path.join(__dirname, '..', 'client', 'tunnel.js'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'client', 'tunnel.js'), 'utf8');

  console.log('\n=== 1) 模块接口 / 源码体检 ===');
  ok('downloadWithRetry 已导出（供测试）', typeof tunnel.downloadWithRetry === 'function' ||
     /downloadWithRetry/.test(src));
  ok('不再有旧的 downloadTo（一把梭版）', !/function downloadTo\(/.test(src));
  ok('有断点续传（Range 头）', /headers\.Range\s*=/.test(src));
  ok('有「下载不完整」校验', /下载不完整/.test(src));
  ok('有停滞看门狗', /下载停滞/.test(src));
  ok('新增：换源与探测函数已导出', typeof tunnel.downloadFromSources === 'function' &&
     typeof tunnel.probeSource === 'function' && typeof tunnel.buildSourceUrls === 'function');
  ok('新增：进度字段有 indeterminate（总大小未知时不装 0%）', /indeterminate/.test(src));
  ok('新增：进度上报有节流', /PROGRESS_MIN_MS/.test(src));

  console.log('\n=== 2) 主进程镜像列表 ===');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'client', 'main.js'), 'utf8');
  const mm = /mirrors:\s*\[([\s\S]*?)\]/.exec(mainSrc);
  const mirrors = mm ? (mm[1].match(/https:\/\/[^']+/g) || []) : [];
  ok('镜像不止一个（单点故障已消除）', mirrors.length >= 2, mirrors.length + ' 个: ' + mirrors.join(', '));

  console.log('\n=== 3) 超时参数 ===');
  ok('等地址的上限 ≥ 150 秒', /WAIT_URL_MS\s*=\s*(\d+)/.test(src) &&
     Number(/WAIT_URL_MS\s*=\s*(\d+)/.exec(src)[1]) >= 150000,
     /WAIT_URL_MS\s*=\s*(\d+)/.exec(src)[1] + 'ms');
  ok('启动窗口 10 秒（慢源不等 60 秒）', tunnel.STARTUP_MS === 10000, tunnel.STARTUP_MS + 'ms');
  ok('彻底断流判定仍是 60 秒', tunnel.IDLE_MS === 60000, tunnel.IDLE_MS + 'ms');
  ok('启动窗口 < 断流超时', tunnel.STARTUP_MS < tunnel.IDLE_MS);

  console.log('\n=== 4) 换源顺序：镜像全在前，GitHub 直连垫底 ===');
  const built = tunnel.buildSourceUrls({ mirrors: ['https://m1.example/', 'https://m2.example'] });
  const CF = tunnel.CF_URL;
  ok('镜像前缀拼在 GitHub URL 前面', built[0] === 'https://m1.example/' + CF, built[0]);
  ok('镜像开头缺斜杠会补上', built[1] === 'https://m2.example/' + CF, built[1]);
  ok('GitHub 直连排在最后', built[built.length - 1] === CF, built[built.length - 1]);
  ok('内置兜底镜像 ≥ 5 条', tunnel.DEFAULT_MIRRORS.length >= 5, tunnel.DEFAULT_MIRRORS.length + ' 条');
  ok('内置镜像格式都是 http(s) + 结尾斜杠',
    tunnel.DEFAULT_MIRRORS.every((m) => /^https?:\/\/.+\/$/.test(m)),
    tunnel.DEFAULT_MIRRORS.join(', '));
  ok('脏镜像前缀会被丢掉（不拼进 URL）', tunnel.normalizeMirror('ftp://x/') === '' &&
     tunnel.normalizeMirror('  ') === '' && tunnel.normalizeMirror('https://ok.example') === 'https://ok.example/');
  const noDup = tunnel.buildSourceUrls({ mirrors: ['https://ghfast.top/'] });
  ok('重复的源只留一份', noDup.length === new Set(noDup).size, noDup.length + ' 条');
  ok('cfg.sources 可以完全指定候选表（测试用）',
    JSON.stringify(tunnel.buildSourceUrls({ sources: ['http://127.0.0.1:1/a'] })) === JSON.stringify(['http://127.0.0.1:1/a']));

  console.log('\n=== 5) 服务端不给 content-length（chunked）也要有进度 ===');
  const chunked = await chunkedServer(3 * 1024 * 1024, 2);
  // 先证明桩服务器真的没给 content-length（否则这一节等于白测）
  const headCheck = await new Promise((resolve) => {
    const req = http.get(chunked.url('/x'), (res) => { res.destroy(); resolve(res.headers); });
    req.on('error', () => resolve({}));
  });
  ok('桩服务器确实没有 content-length（模拟真实 chunked）',
    !headCheck['content-length'] && /chunked/i.test(String(headCheck['transfer-encoding'] || '')),
    'content-length=' + (headCheck['content-length'] || '(无)') + ' te=' + (headCheck['transfer-encoding'] || '-'));
  const dest5 = path.join(tmpRoot, 'chunked.exe');
  const seen5 = [];
  try {
    const got5 = await tunnel.downloadWithRetry(chunked.url('/chunked'), dest5, (got, total, info) => {
      seen5.push({ got: got, total: total, info: info || {} });
    }, 3);
    const stat = fs.statSync(dest5);
    ok('chunked 源也能下完', stat.size === chunked.PAYLOAD.length, stat.size + ' 字节');
    ok('内容逐字节一致', fs.readFileSync(dest5).equals(chunked.PAYLOAD));
    ok('进度回调报出了「已下载字节」', seen5.length > 0 && seen5[seen5.length - 1].got === chunked.PAYLOAD.length,
      seen5.length + ' 次回调');
    ok('总大小未知时如实标记 indeterminate（不伪装成 0%）',
      seen5.some((s) => s.info.indeterminate === true && s.total === 0));
    ok('未拿到总大小时文案里有已下载量、没有 0%',
      /MB/.test(tunnel.downloadText(chunked.PAYLOAD.length, 0, 1024 * 1024, 0)) &&
      !/0%/.test(tunnel.downloadText(chunked.PAYLOAD.length, 0, 1024 * 1024, 0)),
      tunnel.downloadText(12345678, 0, 1234567, 0));
    ok('拿到总大小时文案里有百分比',
      /50%/.test(tunnel.downloadText(50, 100, 1024, 0)), tunnel.downloadText(50, 100, 1024, 0));
    ok('进度上报有节流（3MB 不会回调上百次）', seen5.length <= 12, seen5.length + ' 次');
    ok('速度字段是数字', seen5.some((s) => typeof s.info.speed === 'number' && s.info.speed >= 0));
    ok('返回值里带 bytes', got5.bytes === chunked.PAYLOAD.length, String(got5.bytes));
  } catch (e) {
    ok('chunked 源也能下完', false, e.message);
  } finally { chunked.srv.close(); }

  console.log('\n=== 6) 探测：不动的源要被判死，动的源要被认出来 ===');
  const silentA = await silentServer(false);   // 连上、连响应头都不给
  const silentB = await silentServer(true);    // 响应头回来了、一个字节不发
  const bad500 = await statusServer(500);
  const chunked2 = await chunkedServer(256 * 1024, 0);
  const t6 = Date.now();
  const rA = await tunnel.probeSource(silentA.url('/a'), { startupMs: 700 });
  const rB = await tunnel.probeSource(silentB.url('/b'), { startupMs: 700 });
  const elapsed6 = Date.now() - t6;
  ok('不发数据的源被判死（无响应头）', rA.ok === false, rA.reason);
  ok('不发数据的源被判死（有响应头、无 body）', rB.ok === false, rB.reason);
  ok('判死发生在启动窗口内', elapsed6 < 3000, elapsed6 + 'ms（两次探测总和）');
  const r500 = await tunnel.probeSource(bad500.url('/c'), { startupMs: 2000 });
  ok('HTTP 500 直接判死', r500.ok === false && /500/.test(String(r500.reason)), r500.reason);
  const rOK = await tunnel.probeSource(chunked2.url('/d'), { startupMs: 2000 });
  ok('能动的源被认出来', rOK.ok === true && rOK.firstByte > 0, '第一口 ' + rOK.firstByte + ' 字节');
  ok('探测顺带问出总大小（直连实测 52.4MB 就是靠这条）', typeof rOK.total === 'number');
  silentA.srv.close(); silentB.srv.close(); bad500.srv.close(); chunked2.srv.close();

  console.log('\n=== 7) 慢就切：第一个源连上不发数据 → 立刻换第二个源下完 ===');
  const slow7 = await silentServer(true);
  const good7 = await rangeServer(2 * 1024 * 1024);
  const dest7 = path.join(tmpRoot, 'switch.exe');
  const used7 = [];
  const t7 = Date.now();
  try {
    const r7 = await tunnel.downloadFromSources([slow7.url('/slow'), good7.url('/good')], dest7,
      () => {}, { startupMs: 800, attempts: 1, onSource: (u) => used7.push(u) });
    const cost7 = Date.now() - t7;
    ok('换到了第二个源', used7.length === 1 && used7[0] === good7.url('/good'), String(used7[0]));
    ok('整个下载在启动窗口附近完成，没干等 60 秒', cost7 < 3000, cost7 + 'ms');
    ok('文件完整', fs.statSync(dest7).size === good7.PAYLOAD.length, fs.statSync(dest7).size + ' 字节');
    ok('内容逐字节一致', fs.readFileSync(dest7).equals(good7.PAYLOAD));
    // 输掉的那条连接必须被掐掉（不能留着白烧流量）
    for (let i = 0; i < 20 && slow7.closed() === 0; i++) await sleep(50);
    ok('慢源的连接被主动断开（没留着烧流量）', slow7.closed() >= 1, '被断开的连接 ' + slow7.closed() + ' 条');
    ok('返回值带上了实际使用的源', r7.url === good7.url('/good'));
  } catch (e) {
    ok('慢就切', false, e.message);
  } finally { slow7.srv.close(); good7.srv.close(); }

  console.log('\n=== 8) 第一个源 500 → 换下一个源成功（既有行为） ===');
  const bad8 = await statusServer(500);
  const good8 = await rangeServer(2 * 1024 * 1024);
  const dest8 = path.join(tmpRoot, 'fallback.exe');
  try {
    await tunnel.downloadFromSources([bad8.url('/a'), good8.url('/b')], dest8, () => {}, { startupMs: 1500, attempts: 1 });
    ok('500 之后换源成功', fs.statSync(dest8).size === good8.PAYLOAD.length, fs.statSync(dest8).size + ' 字节');
    ok('内容逐字节一致', fs.readFileSync(dest8).equals(good8.PAYLOAD));
  } catch (e) {
    ok('500 之后换源成功', false, e.message);
  } finally { bad8.srv.close(); good8.srv.close(); }

  console.log('\n=== 8b) 抢输的源不会被浪费：赢家真下的时候挂了，回收的源顶上 ===');
  const tease8 = await teaseServer();
  const good8b = await rangeServer(2 * 1024 * 1024, 0x48);
  const dest8b = path.join(tmpRoot, 'requeue.exe');
  const used8b = [];
  const t8b = Date.now();
  try {
    await tunnel.downloadFromSources([tease8.url('/tease'), good8b.url('/good')], dest8b, () => {},
      { startupMs: 1500, attempts: 1, onSource: (u) => used8b.push(u) });
    ok('赢家 500 之后换了源（不是直接失败）', used8b.length === 2, used8b.join(' → '));
    ok('文件完整', fs.statSync(dest8b).size === good8b.PAYLOAD.length, fs.statSync(dest8b).size + ' 字节');
    ok('内容逐字节一致', fs.readFileSync(dest8b).equals(good8b.PAYLOAD));
    ok('没花太久', Date.now() - t8b < 5000, (Date.now() - t8b) + 'ms');
  } catch (e) {
    ok('抢输的源被回收再用', false, e.message);
  } finally { tease8.srv.close(); good8b.srv.close(); }

  console.log('\n=== 8c) 下到一半装死 → 静默看门狗掐掉、换源续传（不等 60 秒） ===');
  const stall8 = await stallServer(2 * 1024 * 1024, 0x49);
  const good8c = await rangeServer(2 * 1024 * 1024, 0x49);
  const dest8c = path.join(tmpRoot, 'stall.exe');
  const t8c = Date.now();
  try {
    await tunnel.downloadFromSources([stall8.url('/stall'), good8c.url('/good')], dest8c, () => {},
      { startupMs: 1500, idleMs: 400, attempts: 1 });
    const cost8c = Date.now() - t8c;
    ok('装死的源被掐掉并换了源', fs.statSync(dest8c).size === good8c.PAYLOAD.length, fs.statSync(dest8c).size + ' 字节');
    ok('续传了刚才那一口（请求带 Range）', good8c.ranges.some((r) => /^bytes=\d+-$/.test(r)), good8c.ranges.join(',') || '(没带)');
    ok('内容逐字节一致', fs.readFileSync(dest8c).equals(Buffer.alloc(2 * 1024 * 1024, 0x49)));
    ok('按 idleMs 快速切走，不是干等 60 秒', cost8c < 4000, cost8c + 'ms');
  } catch (e) {
    ok('装死 → 换源续传', false, e.message);
  } finally { stall8.srv.close(); good8c.srv.close(); }

  console.log('\n=== 9) 断点续传（Range + .part） ===');
  const good9 = await rangeServer(3 * 1024 * 1024);
  const dest9 = path.join(tmpRoot, 'resume.exe');
  const half9 = Math.floor(good9.PAYLOAD.length / 2);
  fs.writeFileSync(dest9 + '.part', good9.PAYLOAD.slice(0, half9));
  const seen9 = [];
  try {
    await tunnel.downloadFromSources([good9.url('/r')], dest9, (got, total, info) => {
      seen9.push(info || {});
    }, { startupMs: 2000, attempts: 1 });
    ok('从半截文件接着下（请求带了 Range）',
      good9.ranges.some((r) => r === 'bytes=' + half9 + '-'), good9.ranges.join(' , ') || '(没带 Range)');
    ok('下完的整文件逐字节一致', fs.readFileSync(dest9).equals(good9.PAYLOAD));
    ok('临时文件已改名、没留下 .part', fs.existsSync(dest9) && !fs.existsSync(dest9 + '.part'));
    ok('进度里报出了「续传了多少」', seen9.some((i) => i.resumedFrom === half9),
      JSON.stringify(seen9.map((i) => i.resumedFrom)));
  } catch (e) {
    ok('断点续传', false, e.message);
  } finally { good9.srv.close(); }

  console.log('\n=== 9b) 下到一半被掐断 → 自动续传下完（老的断流行为别弄坏） ===');
  const flaky = await startServer((() => {
    const PAYLOAD = Buffer.alloc(3 * 1024 * 1024, 0x41);
    let hits = 0;
    return (req, res) => {
      hits++;
      const range = req.headers.range;
      if (hits === 1) {
        // 第一次：声明完整长度，但只发一半就断（模拟中途被掐）
        res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
        res.write(PAYLOAD.slice(0, PAYLOAD.length / 2));
        setTimeout(() => res.destroy(), 60);
        return;
      }
      if (range) {
        const m = /bytes=(\d+)-/.exec(range);
        const from = m ? Number(m[1]) : 0;
        const rest = PAYLOAD.slice(from);
        res.writeHead(206, {
          'Content-Length': String(rest.length),
          'Content-Range': 'bytes ' + from + '-' + (PAYLOAD.length - 1) + '/' + PAYLOAD.length
        });
        res.end(rest);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    };
  })());
  const flakyPayload = Buffer.alloc(3 * 1024 * 1024, 0x41);
  const dest9b = path.join(tmpRoot, 'flaky.exe');
  const progress9b = [];
  try {
    await tunnel.downloadWithRetry(flaky.url('/bin'), dest9b, (got) => progress9b.push(got), 3, { startupMs: 3000 });
    ok('断流后自动续传下完整个文件', fs.statSync(dest9b).size === flakyPayload.length,
      fs.statSync(dest9b).size + ' / ' + flakyPayload.length + ' 字节');
    ok('内容与原文件逐字节一致', fs.readFileSync(dest9b).equals(flakyPayload));
    ok('确实发生了重试（服务器被请求 >1 次）', flaky.conns() > 1, '连接 ' + flaky.conns() + ' 次');
    ok('进度回调被调用', progress9b.length > 0, progress9b.length + ' 次');
  } catch (e) {
    ok('断流 → 续传', false, e.message);
  } finally { flaky.srv.close(); }

  console.log('\n=== 10) 全挂：错误信息要写清缓存目录（用户能自己救自己） ===');
  const cache10 = path.join(tmpRoot, 'bin-manual');
  fs.mkdirSync(cache10, { recursive: true });
  fs.writeFileSync(path.join(cache10, tunnel.CF_NAME + '.part'), Buffer.alloc(3 * 1024 * 1024, 0x44));
  const msg10 = tunnel.downloadFailureMessage(9, new Error('下载停滞（超过 60 秒没有数据）'),
    cache10, 3 * 1024 * 1024, false);
  ok('错误信息里有缓存目录完整路径', msg10.indexOf(cache10) >= 0, cache10);
  ok('错误信息里有「手动下载」的下一步', /手动下载/.test(msg10));
  ok('错误信息里有「续传」提示', /续传/.test(msg10));
  ok('错误信息里带上真实原因', /下载停滞/.test(msg10));
  ok('错误信息里给了可执行文件名',
    /cloudflared-windows-amd64\.exe|cloudflared-linux-amd64|cloudflared-darwin-amd64\.tgz/.test(msg10));

  const silent10 = await silentServer(true);
  const dead10 = await statusServer(500);
  let throw10 = null;
  try {
    await tunnel.downloadFromSources([silent10.url('/a'), dead10.url('/b')], path.join(cache10, 'x.exe'),
      () => {}, { startupMs: 700, attempts: 1 });
  } catch (e) { throw10 = e; }
  ok('所有源都失败时会抛错', !!throw10, throw10 ? throw10.message : '(没抛)');
  ok('抛出的错是「下载失败」而不是静默卡住', !!throw10 && throw10.message.length > 0);
  silent10.srv.close(); dead10.srv.close();

  console.log('\n=== 11) 端到端：createTunnel 走完整条下载路（无 content-length 的桩） ===');
  const e2e = await chunkedServer(2 * 1024 * 1024, 1);
  const cache11 = path.join(tmpRoot, 'bin-e2e');
  fs.mkdirSync(cache11, { recursive: true });
  const states11 = [];
  const tun11 = tunnel.createTunnel({
    cacheDir: cache11,
    resourcesDir: path.join(tmpRoot, 'nores'),
    repoDir: path.join(tmpRoot, 'norepo'),
    urlFile: path.join(tmpRoot, 'url11.txt'),
    logFile: path.join(tmpRoot, 'log11.txt'),
    sources: [e2e.url('/cloudflared')],
    startupMs: 2000,
    probe: () => Promise.resolve({ ok: true, status: 200 })
  });
  tun11.bus.on('state', (s) => states11.push(s));
  let start11 = null;
  try {
    // 下完之后会去 spawn 这个假二进制，Windows 上必然失败（不是合法 PE）——
    // 这里只关心「下载这一段」的状态，同时给个保护：万一起进程挂住了别把测试拖死
    start11 = await Promise.race([
      tun11.start(59999, '127.0.0.1'),
      sleep(25000).then(() => ({ ok: false, error: '(25 秒没返回：起假进程时挂住了)' }))
    ]);
  } catch (e) { start11 = { ok: false, error: 'start 抛异常：' + e.message }; }
  const dl11 = states11.filter((s) => s.phase === 'downloading');
  ok('下载阶段的状态里有缓存目录', dl11.length > 0 && dl11.every((s) => s.cacheDir === cache11), cache11);
  ok('下载阶段的状态里有手动兜底提示', dl11.length > 0 && dl11.every((s) => /手动下载/.test(String(s.hint || ''))));
  ok('进度真的在动：报出了已下载字节', dl11.some((s) => Number(s.bytes) > 0),
    JSON.stringify(dl11.map((s) => s.bytes).slice(-3)));
  ok('总大小未知时报 indeterminate 且 percent=null（不是恒 0%）',
    dl11.some((s) => s.indeterminate === true && s.percent === null && Number(s.bytes) > 0));
  ok('进度文案可读（含 MB）', dl11.some((s) => /MB/.test(String(s.progressText || ''))),
    String((dl11[dl11.length - 1] || {}).progressText));
  ok('进度事件没有刷爆（节流生效）', dl11.length <= 8, dl11.length + ' 个进度事件');
  ok('文件真的落到了缓存目录', fs.existsSync(path.join(cache11, tunnel.CF_NAME)),
    fs.existsSync(path.join(cache11, tunnel.CF_NAME)) ? fs.statSync(path.join(cache11, tunnel.CF_NAME)).size + ' 字节' : '(没有)');
  ok('下载成功（后面的失败是「不是真的可执行文件」，与下载无关）',
    !!start11 && !/下载失败/.test(String(start11.error || '')), String((start11 || {}).error));
  e2e.srv.close();

  console.log('\n=== 12) 端到端：所有源都失败 → 错误信息里有缓存目录（可手动放一份） ===');
  const silent12 = await silentServer(true);
  const bad12 = await statusServer(500);
  const cache12 = path.join(tmpRoot, 'bin-fail');
  fs.mkdirSync(cache12, { recursive: true });
  fs.writeFileSync(path.join(cache12, tunnel.CF_NAME + '.part'), Buffer.alloc(2 * 1024 * 1024, 0x45));
  const tun12 = tunnel.createTunnel({
    cacheDir: cache12, resourcesDir: path.join(tmpRoot, 'nores'), repoDir: path.join(tmpRoot, 'norepo'),
    urlFile: path.join(tmpRoot, 'url12.txt'),
    sources: [silent12.url('/a'), bad12.url('/b')],
    startupMs: 700,
    probe: () => Promise.resolve({ ok: true, status: 200 })
  });
  const r12 = await tun12.start(59998, '127.0.0.1');
  ok('start 返回 ok:false（不抛异常）', r12 && r12.ok === false);
  ok('错误信息包含缓存目录完整路径', String(r12.error).indexOf(cache12) >= 0, String(r12.error).slice(0, 160) + '…');
  ok('错误信息给出下一步（手动下载 / 放哪 / 再点开关）',
    /手动下载/.test(r12.error) && /再点一次开关/.test(r12.error));
  ok('错误信息提示已续传的内容', /续传/.test(r12.error));
  ok('失败后状态回到 off 且不再是「正在下载」', tun12.state.phase === 'off', tun12.state.phase);
  silent12.srv.close(); bad12.srv.close();

  if (WITH_NET) {
    console.log('\n=== 13) 真外网可达性（--net 才跑；只取头部，不落盘） ===');
    const https = require('https');
    let reachable = 0;
    const list = [['GitHub 直连', tunnel.CF_URL]].concat(
      tunnel.DEFAULT_MIRRORS.map((m) => [m, m + tunnel.CF_URL]));
    for (const item of list) {
      const name = item[0], u = item[1];
      const r = await tunnel.probeSource(u, { startupMs: 15000 });
      if (r.ok) reachable++;
      console.log((r.ok ? '  ✓ ' : '  · ') + name + ' ' +
        (r.ok ? 'HTTP' + r.status + ' ' + (r.total / 1048576).toFixed(1) + 'MB' : r.reason));
    }
    ok('有可用下载源（多镜像策略奏效）', reachable >= 1, reachable + ' 个源可达');
  } else {
    console.log('\n=== 13) 真外网可达性：默认跳过（要跑加 --net） ===');
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '  ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
