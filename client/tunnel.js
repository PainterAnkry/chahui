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

/** 等 cloudflared 吐出公网地址的上限（首次启动含杀软扫描，不能太短） */
const WAIT_URL_MS = 180000;

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

/* ---------------- 下载（带重试 / 续传 / 完整性校验） ----------------
 * 这一段以前是「一把梭」：转三次失败就整个放弃、没有重试、下完不验大小。
 * 国内拉 GitHub 大文件经常中途被掐，一掐就整条失败，用户看到的就是
 * 「内置公网组件总是下载失败」。现在按「失败就换招、断了接着下」来做。
 */

/** 一个会跟重定向的 GET，把「成功 / 重定向 / 失败」三件事分开报给调用方 */
function httpGet(url, onOk, onErr, onRedirect, opts) {
  // 下载 54MB 的二进制，60 秒太紧（慢速网络一动就超）。默认放宽到 5 分钟，
  // 无数据流动的「静默超时」另算（见 downloadOnce 的 idle timer）。
  const o = opts || {};
  const timeout = o.timeout || 300000;
  const headers = Object.assign({ 'User-Agent': 'chahui-tunnel' }, o.headers || {});
  // 按地址本身的协议选请求器：https 走 https，http 走 http。
  // （写死 https.get 会让 http:// 的地址直接抛 "Protocol http: not supported"，
  //  本地伪服务器 / 内网自建下载源就全测不了、也用不了。）
  const mod = /^http:\/\//i.test(url) ? http : https;
  const req = mod.get(url, { timeout: timeout, headers: headers }, (res) => {
    // 3xx 一律交给调用方处理（GitHub → release-assets 会转两次）
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers.location;
      res.resume();
      return onRedirect(res.statusCode, loc ? new URL(loc, url).toString() : '');
    }
    // 200 = 整份；206 = 服务端接受了 Range，给的是「续传的那一段」（同样算成功）
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      return onRedirect(res.statusCode, '');
    }
    onOk(res);
  });
  req.on('error', (e) => onErr(e));
  req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  return req;
}

/** 判断一个错误值不值得重试（网络抖动 / 服务器抽风都值得，404、403 不值得） */
function worthRetrying(e) {
  const msg = String((e && e.message) || e || '');
  if (/4\d\d/.test(msg)) return false;          // 404 / 403 / 429 之外的重试意义不大
  if (/重定向次数过多/.test(msg)) return false;
  return true;                                   // 超时 / 断流 / 5xx / DNS 抖动 → 重试
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 下载一次（支持断点续传）。
 * @param url      最终可取的地址（已跟完重定向）
 * @param dest     目标文件
 * @param onProgress(loaded, total)
 */
function downloadOnce(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    // 已经有半截文件就带上 Range 接着下（服务端不支持就退回整份重下）
    let have = 0;
    try { if (fs.existsSync(tmp)) have = fs.statSync(tmp).size; } catch (e) { have = 0; }

    const headers = {};
    if (have > 0) headers.Range = 'bytes=' + have + '-';

    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const follow = (u, depth) => {
      if (depth > 8) return done(reject, new Error('重定向次数过多'));
      const req = httpGet(u, (res) => {
        // 服务端忽略了 Range（返回 200 整份）→ 从头写，别接在半截后面
        const resumed = have > 0 && res.statusCode === 206;
        if (have > 0 && !resumed) have = 0;

        const total = (Number(res.headers['content-length']) || 0) + have;
        let got = have;
        const out = fs.createWriteStream(tmp, resumed ? { flags: 'a' } : {});
        // 长时间没有数据流动就掐掉（连接僵死），交给上层重试
        let idle = null;
        const bumpIdle = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            req.destroy(new Error('下载停滞（超过 60 秒没有数据）'));
          }, 60000);
        };
        bumpIdle();

        res.on('data', (c) => {
          got += c.length;
          bumpIdle();
          if (onProgress) onProgress(got, total);
        });
        res.on('error', (e) => { if (idle) clearTimeout(idle); out.destroy(); done(reject, e); });
        out.on('error', (e) => { if (idle) clearTimeout(idle); done(reject, e); });
        out.on('finish', () => out.close(() => {
          if (idle) clearTimeout(idle);
          // 声明了总大小就核一下，短了说明断流，保留 .part 让下次续传
          if (total && got < total) {
            return done(reject, new Error('下载不完整（' + got + '/' + total + ' 字节）'));
          }
          try { fs.renameSync(tmp, dest); } catch (e) { return done(reject, e); }
          done(resolve, { bytes: got });
        }));
        res.pipe(out);
      }, (err) => {
        done(reject, err);
      }, (status, location) => {
        if (location) return follow(location, depth + 1);
        done(reject, new Error('HTTP ' + status));
      }, { headers: headers });
    };
    follow(url, 0);
  });
}

/**
 * 下载：同一地址最多试 maxAttempts 次（第 2 次起走续传），
 * 全用完再交给上层换下一个镜像。
 */
async function downloadWithRetry(url, dest, onProgress, maxAttempts) {
  const tries = maxAttempts || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadOnce(url, dest, onProgress);
    } catch (e) {
      lastErr = e;
      if (!worthRetrying(e)) break;
      if (i < tries - 1) await sleep(600 * (i + 1));   // 退避一下再试
    }
  }
  throw lastErr || new Error('下载失败');
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
          await downloadWithRetry(urls[i], tgz, (got, total) => {
            set({ percent: total ? Math.min(1, got / total) : 0 });
          });
          require('child_process').execSync('tar -xzf "' + tgz + '" -C "' + path.dirname(dest) + '"');
          try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
          if (!fs.existsSync(dest)) {
            const dir = path.dirname(dest);
            const cand = fs.readdirSync(dir).find((f) => f === 'cloudflared' || f.indexOf('cloudflared') === 0);
            if (cand) fs.renameSync(path.join(dir, cand), dest);
          }
        } else {
          await downloadWithRetry(urls[i], dest, (got, total) => {
            set({ percent: total ? Math.min(1, got / total) : 0 });
          });
        }
        try { if (!IS_WIN) fs.chmodSync(dest, 0o755); } catch (e) { /* ignore */ }
        if (!fs.existsSync(dest)) throw new Error('下载完成但文件不在');
        // 下完了还是半截 / 0 字节，说明网络在骗我们 —— 删掉别留下坏二进制
        const sz = fs.statSync(dest).size;
        if (sz < 1024 * 1024) {
          try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
          throw new Error('下载到的文件不完整（只有 ' + sz + ' 字节）');
        }
        set({ phase: 'starting', percent: 1 });
        return dest;
      } catch (e) {
        lastErr = e;
        set({ percent: 0 });
      }
    }
    // 把所有镜像的真实原因都带上，用户报障时能一眼看出是网络还是别的
    throw new Error('公网组件下载失败（试了 ' + urls.length + ' 个下载源）' +
      ((lastErr && lastErr.message) ? '：' + lastErr.message : '') +
      '，请检查网络或代理设置');
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
        // 首次启动要等二进制落地（杀软扫描 54MB 的加壳 exe 慢到一两分钟不稀奇），
        // 90 秒太紧，曾经让「其实能通」的网络被误判成失败
        reject(new Error('等了 ' + Math.round(WAIT_URL_MS / 1000) + ' 秒还没拿到公网地址，隧道可能被网络挡了'));
      }, WAIT_URL_MS);

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
  // 下载相关的内部函数导出出来，是为了 tools/test-tunnel-download.js
  // 能用本地伪服务器把「断流 → 续传 → 完成」整条路真跑一遍
  downloadWithRetry: downloadWithRetry,
  downloadOnce: downloadOnce,
  worthRetrying: worthRetrying,
  CF_URL: CF_URL,
  CF_NAME: CF_NAME
};
