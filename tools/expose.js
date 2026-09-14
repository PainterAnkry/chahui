#!/usr/bin/env node
/**
 * 茶绘 · 公网穿透
 *
 * 把本机跑着的茶绘服务端（默认 8437）通过一条隧道暴露到公网，
 * 让外网的朋友也能用浏览器进来一起画 —— 不再局限于局域网。
 *
 * 用法：
 *   node tools/expose.js                  # 自动挑选隧道（优先后台无感）
 *   node tools/expose.js --port 8437
 *   node tools/expose.js --provider cloudflared
 *   node tools/expose.js --provider ssh    # 零下载备选（走 localhost.run）
 *
 * 原理：cloudflared 的「快速隧道」会在本机和 Cloudflare 边缘之间建一条出站长连接，
 * 不需要公网 IP、不需要路由器端口映射、也不需要注册账号，几秒就能拿到一个
 * https://xxxx.trycloudflare.com 的临时域名。WebSocket 会被原样代理，
 * 所以茶绘的协作绘图能照常工作。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(__dirname, 'bin');
const IS_WIN = process.platform === 'win32';
const CF_BIN = path.join(BIN_DIR, IS_WIN ? 'cloudflared.exe' : 'cloudflared');

const CF_RELEASE = IS_WIN
  ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  : (process.platform === 'darwin'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');

function parseArgs(argv) {
  const out = { port: 8437, provider: 'auto', host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = parseInt(argv[++i], 10) || out.port;
    else if (a === '--provider') out.provider = String(argv[++i] || 'auto');
    else if (a === '--host') out.host = String(argv[++i] || out.host);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log([
    '茶绘 · 公网穿透',
    '',
    '  node tools/expose.js [选项]',
    '',
    '  --port <n>        本机服务端端口（默认 8437）',
    '  --provider <p>    cloudflared | ssh | auto（默认 auto）',
    '  --host <h>        服务端监听主机（默认 127.0.0.1）',
    '',
    '用 cloudflared 时首次运行会自动下载一个单文件二进制到 tools/bin/。'
  ].join('\n'));
}

/* ------------------------------------------------------------ 小工具 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function head(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: timeoutMs || 8000 }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode, location: res.headers.location || '' });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/** 确认本机服务端在跑 */
async function probeLocal(host, port) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/', method: 'GET', timeout: 4000 }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

function download(url, dest, label) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let received = 0, total = 0, lastPct = -1;

    const get = (u, depth) => {
      if (depth > 6) return reject(new Error('重定向次数过多'));
      const req = https.get(u, { timeout: 60000, headers: { 'User-Agent': 'chahui-expose' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return get(next, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.floor(received / total * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              process.stdout.write('\r  ' + label + ' ' + pct + '%  (' +
                (received / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB)   ');
            }
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            process.stdout.write('\r  ' + label + ' 完成（' + (received / 1048576).toFixed(1) + ' MB）          \n');
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    };
    get(url, 0);
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN)) return CF_BIN;
  console.log('  未找到 cloudflared，正在下载……');
  if (!IS_WIN) {
    // macOS / Linux 的 release 是 .tgz，先下来再解
    const tgz = CF_BIN + '.tgz';
    await download(CF_RELEASE, tgz, 'cloudflared');
    const { execSync } = require('child_process');
    const dir = path.dirname(CF_BIN);
    execSync('tar -xzf "' + tgz + '" -C "' + dir + '"', { stdio: 'inherit' });
    if (!fs.existsSync(CF_BIN)) {
      const cand = fs.readdirSync(dir).find(f => f === 'cloudflared' || f.startsWith('cloudflared'));
      if (cand) fs.renameSync(path.join(dir, cand), CF_BIN);
    }
    try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
  } else {
    await download(CF_RELEASE, CF_BIN, 'cloudflared');
  }
  if (!IS_WIN) { try { fs.chmodSync(CF_BIN, 0o755); } catch (e) { /* ignore */ } }
  if (!fs.existsSync(CF_BIN)) throw new Error('cloudflared 下载后仍未就位');
  return CF_BIN;
}

/* ------------------------------------------------------------ 隧道实现 */

function tmpLog(name) {
  return path.join(os.tmpdir(), 'chahui-expose-' + name + '-' + process.pid + '.log');
}

/** cloudflared 快速隧道 */
function startCloudflared(bin, target) {
  const logPath = tmpLog('cf');
  const log = fs.createWriteStream(logPath);
  const child = spawn(bin, [
    'tunnel', '--url', target, '--no-autoupdate', '--edge-ip-version', 'auto'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const state = { child, url: '', logPath, errors: [] };

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('等待公网地址超时。日志：' + logPath));
    }, 90000);

    const onData = (buf) => {
      const s = buf.toString();
      log.write(s);
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !state.url) {
        state.url = m[0];
        if (!settled) { settled = true; clearTimeout(timer); resolve(state); }
      }
      if (/ERR |error|failed/i.test(s) && !/no error/i.test(s)) state.errors.push(s.trim().slice(0, 200));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('cloudflared 退出（code ' + code + '）。日志：' + logPath));
      }
    });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
  });
}

/** 纯 SSH 备选通道（localhost.run），不需要额外下载 */
function startSshTunnel(port) {
  const logPath = tmpLog('ssh');
  const log = fs.createWriteStream(logPath);
  const child = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=' + path.join(os.tmpdir(), 'chahui-kh'),
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', '80:127.0.0.1:' + port,
    'nokey@localhost.run'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const state = { child, url: '', logPath, errors: [] };

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('等待公网地址超时（ssh）。日志：' + logPath));
    }, 60000);

    const onData = (buf) => {
      const s = buf.toString();
      log.write(s);
      const m = s.match(/https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i);
      if (m && !state.url) {
        state.url = m[0];
        if (!settled) { settled = true; clearTimeout(timer); resolve(state); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error('ssh 通道退出（code ' + code + '）。日志：' + logPath));
      }
    });
    child.on('error', (e) => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error('无法启动 ssh：' + e.message));
      }
    });
  });
}

/* ------------------------------------------------------------ 主流程 */

function banner(url, port) {
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  茶绘 · 公网入口已就绪');
  console.log(line);
  console.log('  本机       http://localhost:' + port);
  console.log('  外网入口   ' + url);
  console.log('');
  console.log('  把这个链接发给朋友，他们用浏览器打开就能进来：');
  console.log('    ' + url);
  console.log('');
  console.log('  进房后点左上角房间名 →「复制链接」，拿到的就是这条公网链接（会自动带上 room 参数）。');
  console.log('  服务端也把地址记到了 server/data/public-url.txt，所以 App 里的分享链接会自动切到公网。');
  console.log('  这条隧道是临时的：关掉本窗口 / 按下 Ctrl+C 就会失效，下次运行会换一个新域名。');
  console.log(line + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const target = 'http://' + args.host + ':' + args.port;

  console.log('\n茶绘 · 公网穿透');
  console.log('  目标服务 ' + target);

  const alive = await probeLocal(args.host, args.port);
  if (!alive.ok) {
    console.log('\n  ✗ 本机 ' + target + ' 上没有服务在跑（' + (alive.error || 'no response') + '）');
    console.log('    先在另一个窗口启动服务端：  node server/src/index.js');
    console.log('    桌面端自带服务器的可以跳过这步（双击 exe 就会起 8437）。\n');
    process.exit(1);
  }
  console.log('  ✓ 本机服务端在线（HTTP ' + alive.status + '）');

  let provider = args.provider;
  if (provider === 'auto') provider = 'cloudflared';

  let state = null;
  try {
    if (provider === 'cloudflared') {
      const bin = await ensureCloudflared();
      console.log('  启动 cloudflared 隧道……');
      state = await startCloudflared(bin, target);
    } else if (provider === 'ssh') {
      console.log('  启动 ssh 隧道（localhost.run）……');
      state = await startSshTunnel(args.port);
    } else {
      throw new Error('未知 provider：' + provider);
    }
  } catch (err) {
    console.log('\n  ✗ ' + err.message);
    if (provider === 'cloudflared') {
      console.log('\n  正在退回 ssh 备选通道……');
      try {
        state = await startSshTunnel(args.port);
      } catch (e2) {
        console.log('  ✗ ssh 通道也失败了：' + e2.message);
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }

  banner(state.url, args.port);

  // 记一份，方便服务端 / 桌面端读取（/api/share 会把它带给前端当分享链接）
  const urlFile = path.join(ROOT, 'server', 'data', 'public-url.txt');
  try {
    fs.mkdirSync(path.dirname(urlFile), { recursive: true });
    fs.writeFileSync(urlFile,
      state.url + '\n# 生成于 ' + new Date().toISOString() + '\n');
  } catch (e) { /* ignore */ }

  const bye = () => {
    try { fs.unlinkSync(urlFile); } catch (e) { /* ignore */ }
    try { state.child.kill(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  state.child.on('exit', () => {
    try { fs.unlinkSync(urlFile); } catch (e) { /* ignore */ }
    console.log('\n  隧道已关闭。');
    process.exit(0);
  });

  // 保活
  await sleep(1 << 30);
}

main().catch((e) => {
  console.error('\n  ✗ ' + (e && e.message ? e.message : e));
  process.exit(1);
});
