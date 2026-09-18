/**
 * 茶绘 · 公网隧道专项测试
 *
 * `client/tunnel.js` 刻意不 require electron，就是为了能在这里整条路径跑一遍：
 * 用一个**假的 cloudflared**（临时写出来的 node 脚本，会打印一行像模像样的
 * trycloudflare 地址然后一直挂着）替掉真二进制，验证：
 *
 *   · 能从一堆噪音日志里捞出公网地址
 *   · 起之前先探本机服务端，空的端口直接拒绝（不然用户拿到的是一个 502）
 *   · 拿到地址后写 public-url.txt；stop() 会删掉它
 *   · stop() 真的把进程杀了（靠心跳文件停更来证明，不是只看 running 标志）
 *   · 隧道自己挂掉时状态退回 off 且清掉地址文件
 *   · 没有二进制、又不允许下载时给的是人话
 *
 * 真二进制 + 真网络那条路不放进回归：54MB + 依赖外网，必然 flaky。
 *
 * 用法: node tools/test-tunnel.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tunnelMod = require('../client/tunnel.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chahu-tunnel-test-'));

/** 假的 cloudflared：先喷一堆日志，再报出地址，然后一直挂着直到被杀 */
function writeFakeCf(name, opts) {
  opts = opts || {};
  const script = path.join(TMP, name + '.js');
  const beat = path.join(TMP, name + '.beat');
  fs.writeFileSync(script, [
    "'use strict';",
    "const fs = require('fs');",
    "const BEAT = " + JSON.stringify(beat) + ";",
    "function tick(){ try { fs.appendFileSync(BEAT, '.'); } catch(e){} }",
    "tick(); setInterval(tick, 100);",
    "process.stdout.write('2026-09-18T00:00:00Z INF Thank you for trying Cloudflare Tunnel.\\n');",
    "process.stderr.write('2026-09-18T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\\n');",
    opts.exitAtOnce
      ? "setTimeout(function(){ process.stderr.write('ERR edge unreachable\\n'); process.exit(7); }, 120);"
      : "setTimeout(function(){ process.stdout.write('2026-09-18T00:00:01Z INF |  https://fake-' + " +
        JSON.stringify(opts.slug || 'abc-123') + " + '.trycloudflare.com  |\\n'); }, 150);",
    opts.dieAfterMs
      ? "setTimeout(function(){ process.stderr.write('ERR connection lost\\n'); process.exit(9); }, " + opts.dieAfterMs + ");"
      : "setInterval(function(){}, 1000);"
  ].join('\n'), 'utf8');
  return { script: script, beat: beat };
}

function beatSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return -1; }
}

/** 一个只会对 /health 回 200 的假服务端 */
function startFakeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); return res.end('{"ok":true}'); }
      res.writeHead(404); res.end('');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv: srv, port: srv.address().port }));
  });
}

async function main() {
  console.log('茶绘 公网隧道专项测试\n');

  console.log('[1] 从日志里捞地址（纯函数）');
  ok('能捞出 trycloudflare 地址',
    tunnelMod.parseTunnelUrl('INF | https://calm-river-42.trycloudflare.com |') === 'https://calm-river-42.trycloudflare.com',
    tunnelMod.parseTunnelUrl('INF | https://calm-river-42.trycloudflare.com |'));
  ok('能捞出 lhr.life 地址',
    tunnelMod.parseTunnelUrl('abc https://xx-yy.lhr.life def') === 'https://xx-yy.lhr.life');
  ok('噪音里没有地址就返回空串', tunnelMod.parseTunnelUrl('INF no url here') === '');
  ok('不会把别的站点当隧道地址', tunnelMod.parseTunnelUrl('see https://github.com/cloudflare') === '');
  ok('地址后面跟端口/路径时只取主机部分',
    tunnelMod.parseTunnelUrl('https://abc-def-9.trycloudflare.com:443/ws') === 'https://abc-def-9.trycloudflare.com');
  ok('大写域名也认（大小写不敏感）',
    tunnelMod.parseTunnelUrl('https://CALM-River-42.TRYCLOUDFLARE.COM') === 'https://CALM-River-42.TRYCLOUDFLARE.COM');

  console.log('\n[2] 二进制查找顺序');
  const cacheDir = path.join(TMP, 'cache');
  const resDir = path.join(TMP, 'resources');
  const repoDir = path.join(TMP, 'repo');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.join(resDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'tools', 'bin'), { recursive: true });
  const name = tunnelMod.CF_NAME;
  const cands = tunnelMod.binaryCandidates({ cacheDir: cacheDir, resourcesDir: resDir, repoDir: repoDir });
  ok('候选顺序：缓存 → 随包 → 仓库',
    JSON.stringify(cands) === JSON.stringify([
      path.join(cacheDir, name), path.join(resDir, 'bin', name), path.join(repoDir, 'tools', 'bin', name)
    ]), JSON.stringify(cands));
  ok('都不存在时返回空串', tunnelMod.findBinary({ cacheDir: cacheDir, resourcesDir: resDir, repoDir: repoDir }) === '');
  fs.writeFileSync(path.join(repoDir, 'tools', 'bin', name), 'x');
  ok('只有仓库里有就用仓库的',
    tunnelMod.findBinary({ cacheDir: cacheDir, resourcesDir: resDir, repoDir: repoDir }) === path.join(repoDir, 'tools', 'bin', name));
  fs.writeFileSync(path.join(resDir, 'bin', name), 'x');
  ok('随包的优先于仓库的',
    tunnelMod.findBinary({ cacheDir: cacheDir, resourcesDir: resDir, repoDir: repoDir }) === path.join(resDir, 'bin', name));
  fs.writeFileSync(path.join(cacheDir, name), 'x');
  ok('缓存的最优先',
    tunnelMod.findBinary({ cacheDir: cacheDir, resourcesDir: resDir, repoDir: repoDir }) === path.join(cacheDir, name));

  console.log('\n[3] 正常开启 → 关闭');
  const srv = await startFakeServer();
  const fake = writeFakeCf('cf-ok', { slug: 'calm-river-42' });
  const urlFile = path.join(TMP, 'data', 'public-url.txt');
  const t = tunnelMod.createTunnel({
    binPath: process.execPath,
    runnerArgs: [fake.script],
    urlFile: urlFile,
    logFile: path.join(TMP, 'log', 'tunnel.log'),
    cacheDir: path.join(TMP, 'cache2'),
    download: false
  });
  const states = [];
  t.bus.on('state', (s) => states.push(s.phase));

  const r1 = await t.start(srv.port, '127.0.0.1');
  ok('start 成功', r1.ok === true && !!r1.url, JSON.stringify(r1));
  ok('地址正确', r1.url === 'https://fake-calm-river-42.trycloudflare.com', r1.url);
  ok('状态变成 on', t.state.phase === 'on' && t.state.url === r1.url, JSON.stringify(t.state));
  ok('状态序列里有 starting', states.indexOf('starting') >= 0, states.join(','));
  ok('public-url.txt 写好了', fs.existsSync(urlFile) && fs.readFileSync(urlFile, 'utf8').split('\n')[0].trim() === r1.url,
    fs.existsSync(urlFile) ? JSON.stringify(fs.readFileSync(urlFile, 'utf8').split('\n')[0]) : '文件不存在');
  ok('日志落盘了', fs.existsSync(path.join(TMP, 'log', 'tunnel.log')));
  ok('running = true', t.running === true);

  const b1 = beatSize(fake.beat);
  await sleep(300);
  ok('假隧道确实在跑（心跳在长）', beatSize(fake.beat) > b1, b1 + ' → ' + beatSize(fake.beat));

  t.stop();
  ok('关闭后状态回到 off', t.state.phase === 'off' && t.state.url === '', JSON.stringify(t.state));
  ok('关闭后 running = false', t.running === false);
  ok('关闭后 public-url.txt 被删掉', !fs.existsSync(urlFile));
  await sleep(200);
  const b2 = beatSize(fake.beat);
  await sleep(400);
  ok('进程真的死了（心跳不再增长）', beatSize(fake.beat) === b2, b2 + ' → ' + beatSize(fake.beat));
  srv.srv.close();

  console.log('\n[4] 隧道自己挂掉');
  const srv2 = await startFakeServer();
  const fake2 = writeFakeCf('cf-die', { dieAfterMs: 600 });
  const urlFile2 = path.join(TMP, 'data2', 'public-url.txt');
  const t2 = tunnelMod.createTunnel({
    binPath: process.execPath, runnerArgs: [fake2.script], urlFile: urlFile2, download: false
  });
  const r2 = await t2.start(srv2.port, '127.0.0.1');
  ok('先成功拿到地址', r2.ok === true);
  ok('地址文件已写', fs.existsSync(urlFile2));
  await sleep(1200);
  ok('挂掉后状态退回 off', t2.state.phase === 'off', JSON.stringify(t2.state));
  ok('挂掉后给了断开原因', /断开/.test(t2.state.error || ''), t2.state.error);
  ok('挂掉后地址文件被清掉', !fs.existsSync(urlFile2));
  srv2.srv.close();

  console.log('\n[5] 失败路径都得说人话');
  // 先要一个「确实没人监听」的端口：开一个再关掉，拿它的号
  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

  const t3 = tunnelMod.createTunnel({ urlFile: path.join(TMP, 'x.txt') });
  const r3 = await t3.start(freePort, '127.0.0.1');
  ok('端口上没服务时立刻拒绝（不白等 90 秒）', r3.ok === false && /没有服务在跑/.test(r3.error), r3.error);
  ok('拒绝时状态是 off', t3.state.phase === 'off');
  ok('拒绝时不会启动进程', t3.running === false);

  const srv3 = await startFakeServer();
  const fake3 = writeFakeCf('cf-exit', { exitAtOnce: true });
  const t4 = tunnelMod.createTunnel({
    binPath: process.execPath, runnerArgs: [fake3.script], urlFile: path.join(TMP, 'y.txt'), download: false
  });
  const r4 = await t4.start(srv3.port, '127.0.0.1');
  ok('假 cloudflared 提前退出 → 报错而不是干等', r4.ok === false && /提前退出/.test(r4.error), r4.error);

  const t5 = tunnelMod.createTunnel({
    cacheDir: path.join(TMP, 'empty-cache'), repoDir: path.join(TMP, 'nope'),
    urlFile: path.join(TMP, 'z.txt'), download: false
  });
  const r5 = await t5.start(srv3.port, '127.0.0.1');
  ok('没有二进制且不许下载 → 明确说找不到公网组件',
    r5.ok === false && /公网组件/.test(r5.error), r5.error);

  const t6 = tunnelMod.createTunnel({ binPath: path.join(TMP, 'nope.exe'), urlFile: path.join(TMP, 'w.txt') });
  const r6 = await t6.start(srv3.port, '127.0.0.1');
  ok('指定了不存在的二进制 → 说清是哪个路径',
    r6.ok === false && r6.error.indexOf(path.join(TMP, 'nope.exe')) > 0, r6.error);
  srv3.srv.close();

  console.log('\n[6] 重复调用');
  const srv4 = await startFakeServer();
  const fake4 = writeFakeCf('cf-twice', {});
  const t7 = tunnelMod.createTunnel({
    binPath: process.execPath, runnerArgs: [fake4.script], urlFile: path.join(TMP, 'v.txt'), download: false
  });
  const a = await t7.start(srv4.port, '127.0.0.1');
  const b = await t7.start(srv4.port, '127.0.0.1');
  ok('已经在跑时再 start 直接返回同一个地址', a.url === b.url && b.already === true, JSON.stringify(b));
  t7.stop();
  const c = t7.stop();
  ok('重复 stop 不炸', c.ok === true && c.stopped === false, JSON.stringify(c));
  srv4.srv.close();

  await sleep(150);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) { console.log('\n失败清单：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩了: ' + (e && e.stack || e)); process.exit(1); });
