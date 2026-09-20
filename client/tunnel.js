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
 * 之后一直复用。
 *
 * 下载策略（2024 加固版，专治「卡在 0% 很久」）：
 *   · 镜像优先、GitHub 直连垫底 —— 国内直连是「连得上但几乎不动」，排第一等于干等；
 *   · 每个源先「抢第一口数据」（探测 + 就绪并发赛跑），10 秒不吐字节就判它慢；
 *   · 内层 60 秒无数据 = 彻底断流，掐掉换源；断点续传（.part + Range）照旧。
 * 进度字段（state / bus 上推给界面的那份）：
 *   percent       0~1；总大小拿不到时是 null（别当成 0 显示）
 *   indeterminate true 表示百分比不可信，界面该显示 bytes/speed/progressText
 *   bytes         已落盘字节；total 总大小（0 = 未知）；speed 字节/秒
 *   progressText  一句可以直接显示的进度文案
 *   cacheDir      二进制缓存目录的绝对路径（手动兜底要告诉用户放哪）
 *   hint          手动兜底提示（把 cloudflared 放到 cacheDir）
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

/* ---- 下载调参 ----
 * 「慢」和「死」是两回事：
 *   STARTUP_MS 管「连上了但一个字节都不吐」—— 这种源 10 秒就够判死刑，换下一个；
 *   IDLE_MS    管「下到一半不动了」—— 留 60 秒，别把慢速网络误杀。
 * 换源不是串行排队等超时：每组同时开 RACE_COUNT 个源抢第一口数据，谁先动就用谁。
 */
const STARTUP_MS = 10000;
const IDLE_MS = 60000;
const RACE_COUNT = 2;
/** 进度回调最小间隔（毫秒）：每收一个 chunk 都 set 一次会刷爆 IPC */
const PROGRESS_MIN_MS = 500;
/** 小于这个大小一律当坏文件（cloudflared 都是 50MB 上下） */
const MIN_BINARY_BYTES = 1024 * 1024;

/**
 * 国内可用的 GitHub 加速前缀。用法统一是「前缀 + 原始 GitHub URL」，
 * 所以这些字符串必须带结尾斜杠。
 * 2024 实测（下载 cloudflared-windows-amd64.exe，52.4MB，含 Range 206 续传）：
 *   ghfast.top ✓   gh-proxy.com ✓   ghproxy.net ✓   gh.ddlc.top ✓
 *   cdn.gh-proxy.com ✓   gh-proxy.org ✓
 * 实测不可用、故不收录：hub.gitmirror.com / gitmirror.com（DNS 解析不到）、
 *   gh.llkk.cc（12 秒不发一个字节）、ghproxy.cc（证书过期）、
 *   github.moeyy.xyz（超时）、ghp.ci / ghproxy.cfd（DNS）、
 *   gh-proxy.net / down.npee.cn（200 但零字节）、ghproxy.homeboyc.cn（403）。
 * main.js 里已经给了 3 个，这里再补几个当兜底 —— 多一条路总比干等强。
 */
const DEFAULT_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://gh.ddlc.top/',
  'https://cdn.gh-proxy.com/',
  'https://gh-proxy.org/'
];

/** 把字节数说成人话 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
  const v = Number(bps) || 0;
  if (v <= 0) return '速度未知';
  return fmtBytes(v) + '/s';
}

/** 一句给界面直接显示的进度文案（percent 可能是 null，别硬算百分比） */
function downloadText(got, total, speed, resumedFrom) {
  const done = fmtBytes(got) + (resumedFrom ? '（续传 ' + fmtBytes(resumedFrom) + '）' : '');
  if (total) {
    return '正在下载公网组件 ' + Math.round(Math.min(1, got / total) * 100) + '%（' +
      done + ' / ' + fmtBytes(total) + ' · ' + fmtSpeed(speed) + '）';
  }
  return '正在下载公网组件 ' + done + '（' + fmtSpeed(speed) + ' · 总大小未知）';
}

/** 一个极小的「取消令牌」：赛跑时用来掐掉输掉的那条连接，别留着烧流量 */
function makeCancel() {
  const fns = [];
  return {
    cancelled: false,
    on: function (fn) { if (this.cancelled) { try { fn(); } catch (e) { /* ignore */ } } else { fns.push(fn); } },
    cancel: function () {
      if (this.cancelled) return;
      this.cancelled = true;
      fns.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    }
  };
}

/** 镜像前缀规整：只认 http(s)，补上结尾斜杠，其余一律丢掉（别把脏字符串拼进 URL） */
function normalizeMirror(m) {
  const s = String(m || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return '';
  return s.endsWith('/') ? s : s + '/';
}

/**
 * 组装候选下载源：**镜像全部排在 GitHub 直连前面**。
 * @param cfg.mirrors             调用方给的镜像前缀（main.js 里那份）
 * @param cfg.useDefaultMirrors   false 时不用内置那几条兜底镜像
 * @param cfg.sources             直接指定完整 URL 列表（测试用，给了就完全按它来）
 */
function buildSourceUrls(cfg) {
  cfg = cfg || {};
  if (cfg.sources && cfg.sources.length) return cfg.sources.slice();
  const raw = (cfg.mirrors || []).concat(cfg.useDefaultMirrors === false ? [] : DEFAULT_MIRRORS);
  const urls = [];
  const seen = Object.create(null);
  raw.forEach((m) => {
    const pre = normalizeMirror(m);
    if (!pre) return;
    const u = pre + CF_URL;
    if (!seen[u]) { seen[u] = 1; urls.push(u); }
  });
  // 直连 GitHub 垫底：镜像全挂了还能赌一把（国内基本很慢，但聊胜于无）
  if (!seen[CF_URL]) urls.push(CF_URL);
  return urls;
}

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
 * 探一个源「到底动不动」：发一个不带 Range 的 GET，跟完重定向，
 * **只要第一个字节回来就立刻掐掉连接**（连这个源是快是慢、总大小多少都一起问出来了）。
 *
 * 为什么不先试 HEAD：不少镜像 / 加速站对 HEAD 直接 405 或干脆不返回 content-length，
 * 而「GET 到第一口数据」是用户真正在意的那件事 —— 只有它才能证明这个源能用。
 *
 * @returns { ok, url, finalUrl, status, total, firstByte } | { ok:false, url, reason }
 */
function probeSource(url, opts) {
  const o = opts || {};
  const windowMs = o.startupMs || STARTUP_MS;
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) { try { req.destroy(); } catch (e) { /* ignore */ } }
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, url: url, reason: '启动太慢（' + Math.round(windowMs / 1000) + ' 秒没有数据）' });
    }, windowMs);
    // 被别人抢先了就把连接掐了，别留着白烧流量
    if (o.cancel) o.cancel.on(() => finish({ ok: false, url: url, reason: '已被更快的源取代' }));

    const follow = (u, depth) => {
      if (settled) return;
      if (depth > 8) return finish({ ok: false, url: url, reason: '重定向次数过多' });
      // httpGet 对畸形地址会同步抛，别让它把探测 promise 变成未捕获拒绝
      try {
        req = httpGet(u, (res) => {
          const total = Number(res.headers['content-length']) || 0;
          res.once('data', (chunk) => {
            finish({ ok: true, url: url, finalUrl: u, status: res.statusCode, total: total, firstByte: chunk.length });
          });
          // 连上了、头也回来了，但一个字节都没有 → 这个源等于不能用
          res.on('end', () => finish({ ok: false, url: url, reason: '源返回了空响应' }));
          res.on('error', (e) => finish({ ok: false, url: url, reason: e.message }));
        }, (e) => {
          finish({ ok: false, url: url, reason: (e && e.message) || String(e) });
        }, (status, location) => {
          if (location) return follow(location, depth + 1);
          finish({ ok: false, url: url, reason: 'HTTP ' + status });
        }, { timeout: windowMs });
      } catch (e) {
        finish({ ok: false, url: url, reason: (e && e.message) || String(e) });
      }
    };
    follow(url, 0);
  });
}

/**
 * 同时探一组源，**谁先送来数据就用谁**（这就是「慢就切」的关键：
 * 不是等第一个源超时，而是让第二个源跟它赛跑）。
 * @returns { ok:true, url, total, ... } | { ok:false, reasons:[{url, reason}] }
 */
function raceFirstOk(urls, opts) {
  return new Promise((resolve) => {
    if (!urls || !urls.length) return resolve({ ok: false, reasons: [] });
    let pending = urls.length;
    let done = false;
    const reasons = [];
    const tokens = urls.map(() => makeCancel());
    urls.forEach((u, i) => {
      probeSource(u, Object.assign({}, opts, { cancel: tokens[i] })).then((r) => {
        if (r.ok) {
          if (done) return;
          done = true;
          tokens.forEach((t, j) => { if (j !== i) t.cancel(); });   // 输的那条立刻断
          // 输的那些只是「没抢到第一口」，源本身可能没问题 —— 交回给上层备用
          r.others = urls.filter((x, j) => j !== i);
          return resolve(r);
        }
        reasons.push({ url: u, reason: r.reason });
        pending--;
        if (!done && pending === 0) { done = true; resolve({ ok: false, reasons: reasons }); }
      }, (e) => {
        // 探测自己出意外（比如地址非法）不能把整条下载拖塌
        reasons.push({ url: u, reason: (e && e.message) || String(e) });
        pending--;
        if (!done && pending === 0) { done = true; resolve({ ok: false, reasons: reasons }); }
      });
    });
  });
}

/**
 * 下载一次（支持断点续传）。
 * @param url        最终可取的地址（已跟完重定向）
 * @param dest       目标文件
 * @param onProgress (loaded, total, info) —— info = { speed, indeterminate, resumedFrom }
 * @param opts.expectedTotal 探测阶段问到的总大小（响应头没给 content-length 时靠它算百分比）
 */
function downloadOnce(url, dest, onProgress, opts) {
  const o = opts || {};
  const startupMs = o.startupMs || STARTUP_MS;
  const idleMs = o.idleMs || IDLE_MS;
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    // 已经有半截文件就带上 Range 接着下（服务端不支持就退回整份重下）
    let have = 0;
    try { if (fs.existsSync(tmp)) have = fs.statSync(tmp).size; } catch (e) { have = 0; }

    const headers = {};
    if (have > 0) headers.Range = 'bytes=' + have + '-';

    let settled = false;
    // 任何出口都要把看门狗收掉，别留一个 60 秒的定时器拖着进程
    let clearTimers = () => {};
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { clearTimers(); } catch (e) { /* ignore */ }
      fn(arg);
    };

    const follow = (u, depth) => {
      if (depth > 8) return done(reject, new Error('重定向次数过多'));
      const req = httpGet(u, (res) => {
        // 服务端忽略了 Range（返回 200 整份）→ 从头写，别接在半截后面
        const resumed = have > 0 && res.statusCode === 206;
        if (have > 0 && !resumed) have = 0;

        const resumedFrom = resumed ? have : 0;
        // 总大小优先信响应头；chunked（没有 content-length）就退回探测时问到的那份，
        // 这样「服务端不给长度」也不会让百分比永远钉在 0
        const declared = Number(res.headers['content-length']) || 0;
        const total = (declared ? declared + have : 0) || (Number(o.expectedTotal) || 0);
        let got = have;
        const out = fs.createWriteStream(tmp, resumed ? { flags: 'a' } : {});
        // 两道看门狗：启动窗口（还没吐字节）→ 换源；静默超时（吐了一半不动）→ 重试
        let idle = null;
        const bumpIdle = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            req.destroy(new Error('下载停滞（超过 ' + Math.round(idleMs / 1000) + ' 秒没有数据）'));
          }, idleMs);
        };
        let started = false;
        const startup = setTimeout(() => {
          req.destroy(new Error('下载启动太慢（超过 ' + Math.round(startupMs / 1000) + ' 秒没有数据）'));
        }, startupMs);
        clearTimers = () => { clearTimeout(startup); if (idle) clearTimeout(idle); idle = null; };

        // 进度节流：每收一个 chunk 都 set 一次会把 IPC 刷爆，按 PROGRESS_MIN_MS 汇总上报
        let lastEmit = 0, lastBytes = got, lastTs = Date.now(), speed = 0;
        const emit = (force) => {
          if (!onProgress) return;
          const now = Date.now();
          if (!force && now - lastEmit < PROGRESS_MIN_MS) return;
          const dt = Math.max(1, now - lastTs) / 1000;
          const inst = Math.max(0, (got - lastBytes) / dt);
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastEmit = now; lastBytes = got; lastTs = now;
          onProgress(got, total, { speed: speed, indeterminate: !total, resumedFrom: resumedFrom });
        };

        res.on('data', (c) => {
          got += c.length;
          if (!started) { started = true; clearTimeout(startup); bumpIdle(); }
          emit(false);
        });
        const fail = (e) => { clearTimers(); try { out.destroy(); } catch (e2) { /* ignore */ } done(reject, e); };
        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => out.close(() => {
          clearTimers();
          // 已经被判失败（停滞 / 换源）就别再改名了，否则会把半截文件当成好的
          if (settled) return;
          emit(true);
          // 声明了总大小就核一下，短了说明断流，保留 .part 让下次续传
          if (total && got < total) {
            return done(reject, new Error('下载不完整（' + got + '/' + total + ' 字节）'));
          }
          try { fs.renameSync(tmp, dest); } catch (e) { return done(reject, e); }
          done(resolve, { bytes: got, total: total, resumedFrom: resumedFrom });
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
async function downloadWithRetry(url, dest, onProgress, maxAttempts, opts) {
  const tries = maxAttempts || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadOnce(url, dest, onProgress, opts);
    } catch (e) {
      lastErr = e;
      if (!worthRetrying(e)) break;
      if (i < tries - 1) await sleep(600 * (i + 1));   // 退避一下再试
    }
  }
  throw lastErr || new Error('下载失败');
}

/**
 * 从一组候选源里把文件下下来：**每组同时开 RACE_COUNT 个源抢第一口数据**，
 * 赢的那个负责正式下载（续传 + 重试），输了的下半场换下一组。
 * 这就是「慢就切」：不陪一个慢源干等，而是同时问下一个。
 * @param opts.onSource(url)   拿到当前使用的源时回调（界面/日志能显示换了哪家）
 * @param opts.validate(file)  下完再验一道（不合格当成这个源失败，继续换源）
 */
async function downloadFromSources(urls, dest, onProgress, opts) {
  const o = opts || {};
  const startupMs = o.startupMs || STARTUP_MS;
  const queue = (urls || []).slice();
  let lastErr = null;
  let reasons = [];
  while (queue.length) {
    const group = queue.splice(0, RACE_COUNT);
    const win = await raceFirstOk(group, { startupMs: startupMs });
    if (!win.ok) {
      reasons = reasons.concat(win.reasons || []);
      continue;
    }
    // 没抢到第一口的源可能只是慢一点，不是坏源：放回队尾，等赢家真失败时还能用
    (win.others || []).forEach((u) => queue.push(u));
    if (o.onSource) { try { o.onSource(win.url); } catch (e) { /* ignore */ } }
    try {
      const r = await downloadWithRetry(win.url, dest, onProgress, o.attempts || 2, {
        expectedTotal: win.total,
        startupMs: startupMs,
        idleMs: o.idleMs
      });
      if (o.validate) o.validate(dest);
      return { url: win.url, bytes: r.bytes, total: r.total, resumedFrom: r.resumedFrom };
    } catch (e) {
      lastErr = e;
    }
  }
  const why = reasons.map((r) => r.reason).filter(Boolean);
  const summary = (lastErr && lastErr.message) ? lastErr.message : (why[0] || '');
  const err = new Error(summary || '所有下载源都没成功');
  err.sourceReasons = reasons;
  throw err;
}

/** 全挂了之后那句「你还能怎么办」——缓存目录必须写清楚，用户能自己救自己 */
function downloadFailureMessage(urlCount, lastErr, cacheDir, partBytes, isTgz) {
  const manual = IS_WIN ? 'cloudflared-windows-amd64.exe' : (isTgz ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-linux-amd64');
  const how = isTgz ? '解出来的 cloudflared 重命名为 ' + CF_NAME : '重命名为 ' + CF_NAME;
  return '公网组件下载失败（试了 ' + urlCount + ' 个下载源）' +
    ((lastErr && lastErr.message) ? '：' + lastErr.message : '') +
    '。你可以手动下载 ' + manual + ' 放到 ' + cacheDir + '（' + how + '），再点一次开关。' +
    (partBytes > 0 ? '（已下载的半截文件保持在 ' + fmtBytes(partBytes) + '，下次会自动续传）' : '') +
    '也可以检查代理 / 换网络后重试。';
}

/**
 * @param cfg.cacheDir      二进制缓存目录（桌面端给 userData/bin）
 * @param cfg.resourcesDir  随包资源目录（进程里是 process.resourcesPath）
 * @param cfg.repoDir       开发时的仓库根
 * @param cfg.urlFile       把地址写到哪（服务端 /api/share 会读它）
 * @param cfg.logFile       cloudflared 的输出落到哪（排错用；不传就不记）
 * @param cfg.mirrors       下载镜像前缀数组（镜像优先，GitHub 直连垫底）
 * @param cfg.sources       直接指定候选 URL 全表（测试用，给了就完全按它来）
 * @param cfg.startupMs     启动窗口（毫秒）：这么多时间没吐字节就换源，默认 10000
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
    const cacheDir = path.dirname(dest);
    // macOS 的 release 是 .tgz，得先解出来；Windows / Linux 都是可直接执行的文件
    const isTgz = process.platform === 'darwin';
    // 半截文件跟着真正的下载目标走（downloadOnce 内部记的就是 dest + '.part'）
    const part = (isTgz ? dest + '.tgz' : dest) + '.part';
    // 镜像在前、GitHub 直连垫底：国内直连「连得上但几乎不动」，排第一就是干等
    const urls = buildSourceUrls(cfg);
    const startupMs = cfg.startupMs || STARTUP_MS;
    const partBytes = () => { try { return fs.existsSync(part) ? fs.statSync(part).size : 0; } catch (e) { return 0; } };
    const manualHint = () => {
      const name = IS_WIN ? 'cloudflared-windows-amd64.exe'
        : (isTgz ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-linux-amd64');
      const how = isTgz ? '解出来的 cloudflared 重命名为 ' + CF_NAME : '重命名为 ' + CF_NAME;
      const part = partBytes();
      return '也可以手动下载 ' + name + ' 放到 ' + cacheDir + '（' + how + '），再点一次开关' +
        (part > 0 ? '；缓存目录里已有 ' + fmtBytes(part) + ' 半截文件，会自动续传' : '');
    };
    const partialText = () => {
      const part = partBytes();
      return part > 0 ? '（已续传 ' + fmtBytes(part) + '）' : '';
    };

    set({
      phase: 'downloading', error: '', percent: 0, indeterminate: false,
      bytes: 0, total: 0, speed: 0, resumedFrom: 0, source: '',
      cacheDir: cacheDir, hint: manualHint(),
      progressText: '正在下载公网组件…' + partialText()
    });

    // 进度上报：拿不到总大小就报「已下载 + 速度」，别把百分比钉死在 0
    const report = (got, total, info) => {
      const speed = Math.round((info && info.speed) || 0);
      const resumedFrom = (info && info.resumedFrom) || 0;
      set({
        phase: 'downloading',
        percent: total ? Math.min(1, got / total) : null,
        indeterminate: !total,
        bytes: got,
        total: total || 0,
        speed: speed,
        resumedFrom: resumedFrom,
        progressText: downloadText(got, total, speed, resumedFrom)
      });
    };
    // 下完再验一道：仍然只认官方发布、坏文件（< 1MB）不留
    const validate = (file) => {
      if (!fs.existsSync(file)) throw new Error('下载完成但文件不在');
      const sz = fs.statSync(file).size;
      if (sz < MIN_BINARY_BYTES) {
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
        throw new Error('下载到的文件不完整（只有 ' + sz + ' 字节）');
      }
    };

    try {
      if (isTgz) {
        const tgz = dest + '.tgz';
        await downloadFromSources(urls, tgz, report, {
          startupMs: startupMs, validate: validate,
          onSource: (u) => set({ source: u })
        });
        require('child_process').execSync('tar -xzf "' + tgz + '" -C "' + path.dirname(dest) + '"');
        try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
        if (!fs.existsSync(dest)) {
          const dir = path.dirname(dest);
          const cand = fs.readdirSync(dir).find((f) => f === 'cloudflared' || f.indexOf('cloudflared') === 0);
          if (cand) fs.renameSync(path.join(dir, cand), dest);
        }
      } else {
        await downloadFromSources(urls, dest, report, {
          startupMs: startupMs, validate: validate,
          onSource: (u) => set({ source: u })
        });
      }
      try { if (!IS_WIN) fs.chmodSync(dest, 0o755); } catch (e) { /* ignore */ }
      if (!fs.existsSync(dest)) throw new Error('下载完成但文件不在');
      const sz = fs.statSync(dest).size;
      if (sz < MIN_BINARY_BYTES) throw new Error('下载到的文件不完整（只有 ' + sz + ' 字节）');
      set({ phase: 'starting', percent: 1, indeterminate: false, speed: 0 });
      return dest;
    } catch (e) {
      // 把所有源的真实原因都带上，用户报障时能一眼看出是网络还是别的；
      // 缓存目录务必写清楚 —— 用户手动放一份进去就能绕过整个下载
      set({ percent: 0, indeterminate: false, speed: 0, bytes: partBytes() });
      throw new Error(downloadFailureMessage(urls.length, e, cacheDir, partBytes(), isTgz));
    }
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

    set({ phase: 'starting', url: '', error: '', percent: 1, indeterminate: false });

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
  // 能用本地伪服务器把「断流 → 续传 → 完成」「慢源 → 换源」整条路真跑一遍
  downloadWithRetry: downloadWithRetry,
  downloadOnce: downloadOnce,
  downloadFromSources: downloadFromSources,
  probeSource: probeSource,
  raceFirstOk: raceFirstOk,
  buildSourceUrls: buildSourceUrls,
  normalizeMirror: normalizeMirror,
  downloadText: downloadText,
  downloadFailureMessage: downloadFailureMessage,
  fmtBytes: fmtBytes,
  worthRetrying: worthRetrying,
  DEFAULT_MIRRORS: DEFAULT_MIRRORS,
  STARTUP_MS: STARTUP_MS,
  IDLE_MS: IDLE_MS,
  RACE_COUNT: RACE_COUNT,
  CF_URL: CF_URL,
  CF_NAME: CF_NAME
};
