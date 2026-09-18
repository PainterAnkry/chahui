/**
 * 茶绘 · 公网隧道（cloudflared 快速隧道）
 *
 * 目的：让「外网的朋友也能进来」变成应用里点一下的事 ——
 * 用户既不用装 Node，也不用另外装穿透工具，更不用碰命令行。
 *
 * 做法：cloudflared 的「快速隧道」会在本机和 Cloudflare 边缘之间建一条出站长连接，
 * 不需要公网 IP、不需要路由器端口映射、不需要注册账号，几秒就能拿到一个
 * `https://xxxx.trycloudflare.com` 的临时域名。WebSocket 会被原样代理，
 * 所以协作绘图照常工作。
 *
 * 二进制不进安装包（那会白胖 54MB）：第一次开启时自动下到用户数据目录，
 * 之后一直复用。GitHub 直连不通时自动换 ghfast.top 镜像。
 *
 * **这个文件不 require electron**：它只做「起进程 / 收地址 / 关进程 / 写地址文件」，
 * 这样 tools/test-tunnel.js 能用假 cloudflared 把它整条路径跑一遍。
 * 面向界面的三件事（IPC、状态推送、退出清理）都在 main.js 里接。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';
const CF_NAME = IS_WIN ? 'cloudflared.exe' : 'cloudflared';

const CF_URL = IS_WIN
  ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  : (process.platform === 'darwin'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');

/** 快速隧道给出的地址长这样；ssh 备选通道是 lhr.life / localhost.run */
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.(?:trycloudflare\.com|lhr\.life|localhost\.run)/i;

/** 从一段输出里挑出公网地址（cloudflared 的日志是给人看的，格式会变，所以按正则捞） */
function parseTunnelUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0] : '';
}

/** 本机服务端在不在跑。隧道指到一个空端口上，用户只会看到 502，先在本地拦掉 */
function probeTarget(host, port, timeout) {
  return new Promise((resolve) => {
    const req = http.request({ host: host, port: port, path: '/health', method: 'GET', timeout: timeout || 3000 }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/** 候选路径：已经下好的 → 随包带的 → 开发时的仓库目录 */
function binaryCandidates(opts) {
  const out = [];
  if (opts.cacheDir) out.push(path.join(opts.cacheDir, CF_NAME));
  if (opts.resourcesDir) out.push(path.join(opts.resourcesDir, 'bin', CF_NAME));
  if (opts.repoDir) out.push(path.join(opts.repoDir, 'tools', 'bin', CF_NAME));
  return out;
}

function findBinary(opts) {
  const list = binaryCandidates(opts || {});
  for (let i = 0; i < list.length; i++) {
    try { if (fs.existsSync(list[i])) return list[i]; } catch (e) { /* ignore */ }
  }
  return '';
}

function downloadTo(url, dest, onProgress, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('重定向次数过多'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let got = 0, total = 0;
    httpGet(url, (res) => {
      total = Number(res.headers['content-length']) || 0;
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress(total ? Math.min(1, got / total) : 0, got, total);
      });
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', (e) => { reject(e); });
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
        resolve({ bytes: got });
      }));
      res.pipe(out);
    }, (err) => {
      if (depth < 6) return downloadTo(url, dest, onProgress, depth + 1).then(resolve, reject);
      reject(err);
    }, (status, location) => {
      if (location) return downloadTo(location, dest, onProgress, depth + 1).then(resolve, reject);
      reject(new Error('HTTP ' + status));
    });
  });
}

/** 一个会跟重定向的 GET，把「成功 / 重定向 / 失败」三件事分开报给调用方 */
function httpGet(url, onOk, onErr, onRedirect) {
  const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'chahui-tunnel' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      const loc = res.headers.location;
      return onRedirect(res.statusCode, loc ? new URL(loc, url).toString() : '');
    }
    if (res.statusCode !== 200) { res.resume(); return onErr(new Error('HTTP ' + res.statusCode)); }
    onOk(res);
  });
  req.on('error', onErr);
  req.on('timeout', () => req.destroy(new Error('下载超时')));
}

/**
 * @param cfg.cacheDir      二进制缓存目录（桌面端给 userData/bin）
 * @param cfg.resourcesDir  随包资源目录（进程里是 process.resourcesPath）
 * @param cfg.repoDir       开发时的仓库根
 * @param cfg.urlFile       把地址写到哪（服务端 /api/share 会读它）
 * @param cfg.logFile       cloudflared 的输出落到哪（排错用；不传就不记）
 * @param cfg.mirrors       下载镜像前缀数组，按顺序试
 * @param cfg.download      允许联网下载（测试里关掉，逼出「没有二进制」这条错误）
 * @param cfg.runnerArgs    在二进制前面插的参数（测试拿 node + 假脚本当 cloudflared 用）
 * @param cfg.probe         覆盖本机探活
 */
function createTunnel(cfg) {
  cfg = cfg || {};
  const bus = new EventEmitter();
  let child = null;
  let state = { phase: 'off', url: '', error: '', percent: 0 };

  function set(patch) {
    state = Object.assign({}, state, patch);
    bus.emit('state', Object.assign({}, state));
  }

  function writeUrlFile(url) {
    if (!cfg.urlFile) return;
    try {
      if (!url) { if (fs.existsSync(cfg.urlFile)) fs.unlinkSync(cfg.urlFile); return; }
      fs.mkdirSync(path.dirname(cfg.urlFile), { recursive: true });
      fs.writeFileSync(cfg.urlFile, url + '\n# 由茶绘桌面端的「公网联机」写入 ' + new Date().toISOString() + '\n');
    } catch (e) { /* 写不进去不影响隧道本身，分享链接会用 IPC 那份 */ }
  }

  async function ensureBinary() {
    // 显式指定就用它（用户想拿自己的 cloudflared 也用这条；测试拿假脚本走同一条路）
    if (cfg.binPath) {
      if (fs.existsSync(cfg.binPath)) return cfg.binPath;
      throw new Error('指定的公网组件不存在：' + cfg.binPath);
    }
    const hit = findBinary(cfg);
    if (hit) return hit;

    if (cfg.download === false) {
      throw new Error('没找到公网组件（cloudflared），而且当前不允许联网下载');
    }
    const dest = path.join(cfg.cacheDir || '.', CF_NAME);
    // macOS 的 release 是 .tgz，得先解出来；Windows / Linux 都是可直接执行的文件
    const isTgz = process.platform === 'darwin';
    const urls = [CF_URL].concat((cfg.mirrors || []).map((m) => m + CF_URL));

    set({ phase: 'downloading', percent: 0, error: '' });
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        if (isTgz) {
          const tgz = dest + '.tgz';
          await downloadTo(urls[i], tgz, (p) => set({ percent: p }));
          require('child_process').execSync('tar -xzf "' + tgz + '" -C "' + path.dirname(dest) + '"');
          try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
          if (!fs.existsSync(dest)) {
            const dir = path.dirname(dest);
            const cand = fs.readdirSync(dir).find((f) => f === 'cloudflared' || f.indexOf('cloudflared') === 0);
            if (cand) fs.renameSync(path.join(dir, cand), dest);
          }
        } else {
          await downloadTo(urls[i], dest, (p) => set({ percent: p }));
        }
        try { if (!IS_WIN) fs.chmodSync(dest, 0o755); } catch (e) { /* ignore */ }
        if (!fs.existsSync(dest)) throw new Error('下载完成但文件不在');
        set({ phase: 'starting', percent: 1 });
        return dest;
      } catch (e) {
        lastErr = e;
        set({ percent: 0 });
      }
    }
    throw new Error('公网组件下载失败（' + ((lastErr && lastErr.message) || '未知错误') + '）');
  }

  async function start(port, host) {
    if (child) return { ok: true, url: state.url, already: true };
    host = host || '127.0.0.1';
    const target = 'http://' + host + ':' + port;

    const probe = cfg.probe || probeTarget;
    const alive = await probe(host, port);
    if (!alive.ok) {
      const msg = '本机 ' + target + ' 上没有服务在跑，公网入口就没意义了' +
        (alive.error ? '（' + alive.error + '）' : '');
      set({ phase: 'off', url: '', error: msg });
      return { ok: false, error: msg };
    }

    let bin;
    try {
      bin = await ensureBinary();
    } catch (e) {
      set({ phase: 'off', url: '', error: e.message });
      return { ok: false, error: e.message };
    }

    set({ phase: 'starting', url: '', error: '', percent: 1 });

    const args = (cfg.runnerArgs || []).concat([
      'tunnel', '--url', target, '--no-autoupdate', '--edge-ip-version', 'auto'
    ]);
    let logStream = null;
    if (cfg.logFile) {
      try {
        fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
        logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' });
      } catch (e) { logStream = null; }
    }

    // 这里的失败（超时 / cloudflared 起不来 / 起来了又秒退）都必须变成
    // 「返回一个带人话的 ok:false」，不能把 reject 抛给调用方 ——
    // 界面上就变成一句没人处理的报错，用户什么也看不到。
    let url;
    try {
      url = await new Promise((resolve, reject) => {
        let c;
        try {
          c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) { return reject(e); }
      child = c;
      let settled = false;
      let tail = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('等了 90 秒还没拿到公网地址，隧道可能被网络挡了'));
      }, 90000);

      const onData = (buf) => {
        const s = buf.toString();
        if (logStream) logStream.write(s);
        tail = (tail + s).slice(-600);
        if (settled) return;
        const u = parseTunnelUrl(s);
        if (u) { settled = true; clearTimeout(timer); resolve(u); }
      };
      c.stdout.on('data', onData);
      c.stderr.on('data', onData);
      c.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error('启动 cloudflared 失败：' + e.message));
      });
      c.on('exit', (code) => {
        child = null;
        if (!settled) {
          settled = true; clearTimeout(timer);
          reject(new Error('cloudflared 提前退出（code ' + code + '）：' + tail.trim().split('\n').slice(-2).join(' ')));
          return;
        }
        // 起来之后再挂掉：把状态退回 off，别让界面一直显示一个已经失效的地址
        writeUrlFile('');
        set({ phase: 'off', url: '', error: '隧道已断开（code ' + code + '）' });
      });
      });
    } catch (e) {
      // 起来的过程失败：把可能已经拉起来的进程收掉，别留个孤儿挂在后台
      if (child) {
        try { child.removeAllListeners('exit'); child.kill(); } catch (e2) { /* ignore */ }
        child = null;
      }
      const msg = e && e.message ? e.message : String(e);
      set({ phase: 'off', url: '', error: msg, percent: 0 });
      return { ok: false, error: msg };
    }

    writeUrlFile(url);
    set({ phase: 'on', url: url, error: '', percent: 1 });
    return { ok: true, url: url };
  }

  function stop() {
    const had = !!child;
    if (child) {
      const c = child;
      child = null;
      try { c.removeAllListeners('exit'); c.kill(); } catch (e) { /* ignore */ }
      // Windows 上 kill 有时不彻底，隔一拍补一刀
      setTimeout(() => { try { if (!c.killed) c.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 400);
    }
    writeUrlFile('');
    set({ phase: 'off', url: '', error: '', percent: 0 });
    return { ok: true, stopped: had };
  }

  return {
    bus: bus,
    start: start,
    stop: stop,
    get state() { return state; },
    get running() { return !!child; }
  };
}

module.exports = {
  createTunnel: createTunnel,
  parseTunnelUrl: parseTunnelUrl,
  probeTarget: probeTarget,
  findBinary: findBinary,
  binaryCandidates: binaryCandidates,
  CF_URL: CF_URL,
  CF_NAME: CF_NAME
};
