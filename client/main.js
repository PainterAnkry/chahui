'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const isDev = !!process.env.CHAHU_DEV;
let win = null;
// 内置服务器的运行信息（端口 / 局域网地址），渲染进程要拿去显示分享链接
let serverInfo = null;

/* ---------------- 服务端模块的环境变量（必须在这里、任何 require 之前） ----------------
 *
 * server/src/index.js 的 PORT / DATA_DIR / PUBLIC_DIR 都是**模块加载那一次**读 process.env，
 * 之后不再变。而离线模式和内置服务器（client/server-embed.js）用的是**同一个模块实例**
 * —— 谁先 require 谁就把这些值定死了。
 *
 * 以前这些变量只在 server-embed.start() 里设，于是「先点离线、再开服务器」会让房间存档
 * 落到 client/server/data/rooms（打包后是只读的 asar，根本写不进去）。
 * 所以统一提到最前面：离线、内置，两条路都用用户数据目录。
 */
process.env.CHAHU_EMBEDDED = '1';
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(app.getPath('userData'), 'rooms');
if (!process.env.PUBLIC_DIR) process.env.PUBLIC_DIR = path.join(__dirname, 'renderer');
// 端口同理：用户改过端口的话，第一次 require 就得是最终那个值，
// 否则「先离线（默认 8437 被锁死）、后开服务器（想用 9000）」会静默起在 8437。
if (!process.env.PORT) process.env.PORT = String(readConfig().port || 8437);

/* ---------------- 本地配置（服务器地址等） ---------------- */

function configPath() {
  return path.join(app.getPath('userData'), 'chahu-config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}

function writeConfig(patch) {
  const cur = readConfig();
  const next = Object.assign({}, cur, patch);
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  return next;
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const cfg = readConfig();
  const params = [];
  if (cfg.server) params.push('server=' + encodeURIComponent(cfg.server));
  // 内置服务器起来之后，把它的局域网地址告诉渲染进程 —— 分享链接要用它，
  // 用 localhost 分享出去朋友是打不开的。
  if (serverInfo && serverInfo.lan && serverInfo.lan.length) {
    params.push('lan=' + encodeURIComponent(serverInfo.lan[0]));
    params.push('port=' + serverInfo.port);
  }
  const qs = params.length ? '?' + params.join('&') : '';

  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f4f5f7',
    title: '茶绘',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());

  const file = path.join(__dirname, 'renderer', 'index.html');
  win.loadFile(file, { search: qs ? qs.slice(1) : '' });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('chahu:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  config: readConfig(),
  server: serverInfo
}));

ipcMain.handle('chahu:set-server', (e, url) => writeConfig({ server: String(url || '') }));

/** 开关内置服务器（下次启动生效） */
ipcMain.handle('chahu:set-embedded', (e, on) => writeConfig({ embeddedServer: !!on }));

/** 局域网地址 / 端口，分享链接要用 */
ipcMain.handle('chahu:server-info', () => serverInfo);

/* ---------------- 离线模式 ----------------
 *
 * 界面上的那颗按钮叫「离线模式」，它**不动服务器** —— 桌面端的服务器同时是
 * 这台机器的「房间存档 + 网页版入口」，停掉端口对单机画画没好处，还会把正画着的
 * 朋友一脚踢出去，并留下「端口刚释放没凉透」的重开时序（close 过的
 * WebSocketServer 是终态，得整个重建）。所以它只做一件事：在本进程里挂一个
 * 不走 socket 的客户端（client/local-host.js），消息照旧进同一个房间状态机 ——
 * 有网 / 没网共用同一份服务端逻辑，也就不存在「离线能画、在线的某些按钮没反应」。
 *
 * 真要把端口也停掉（独立部署 / 测试用），服务端那边有 stopListening()，
 * 见 tools/test-server-toggle.js 覆盖的那条路；桌面端刻意不暴露它。
 */
let localSession = null;

function ensureLocalSession() {
  if (localSession) return { ok: true, connId: localSession.connId, reused: true };
  try {
    const host = require('./local-host');
    localSession = host.createSession({
      toClient: function (raw) {
        if (win && !win.isDestroyed()) win.webContents.send('chahu:local-msg', raw);
      }
    });
    console.log('[chahu] 离线模式：本机会话 ' + localSession.connId + '（不占端口）');
    return { ok: true, connId: localSession.connId, reused: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('chahu:local-open', () => ensureLocalSession());

ipcMain.handle('chahu:local-feed', (e, raw) => {
  if (!localSession) return false;
  try { localSession.feed(String(raw || '')); return true; } catch (err) {
    console.error('[chahu] 离线消息处理失败：' + err.message);
    return false;
  }
});

ipcMain.handle('chahu:local-close', () => {
  if (!localSession) return false;
  try { localSession.close(); } catch (e) { /* ignore */ }
  localSession = null;
  return true;
});

/** 服务器现状：开着吗、谁在跑。界面上的开关靠它显示 */
ipcMain.handle('chahu:server-status', () => ({
  on: !!serverInfo,
  port: (serverInfo && serverInfo.port) || Number(readConfig().port) || 8437,
  lan: (serverInfo && serverInfo.lan) || [],
  origin: (serverInfo && serverInfo.origin) || '',
  local: !!localSession
}));

/**
 * 开服务器：**现在就用得上**（不是「下次启动生效」）。
 * 只有「配置文件里关了内置服务器 / 上次起来失败」这两种情形才需要点它 ——
 * 「离线模式」那颗按钮用的是它，不是它的反面。
 */
ipcMain.handle('chahu:server-start', async () => {
  const cfg = readConfig();
  try {
    const embed = require('./server-embed');
    serverInfo = await embed.start({
      port: (serverInfo && serverInfo.port) || Number(cfg.port) || 8437,
      // 房间存档放用户数据目录，别塞进安装目录（那里通常没有写权限）
      dataDir: path.join(app.getPath('userData'), 'rooms'),
      // 内置服务器同时托管网页版，好让局域网的朋友直接用浏览器加入
      publicDir: path.join(__dirname, 'renderer')
    });
    writeConfig({ embeddedServer: true });
    if (win && !win.isDestroyed()) {
      win.webContents.send('chahu:server', { on: true, port: serverInfo.port, lan: serverInfo.lan });
    }
    return { ok: true, port: serverInfo.port, lan: serverInfo.lan, origin: serverInfo.origin, reused: serverInfo.reused };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 公网联机（一键 cloudflared 隧道） ----------------
 * 用户不用装任何东西：第一次点「开启公网联机」时把 cloudflared 下到用户数据目录，
 * 之后复用。隧道跑在主进程里，地址通过 IPC 推给界面。
 */

let tunnel = null;

function tunnelOptions() {
  const cfg = readConfig();
  return {
    port: (serverInfo && serverInfo.port) || Number(cfg.port) || 8437,
    cacheDir: path.join(app.getPath('userData'), 'bin'),
    resourcesDir: process.resourcesPath,
    repoDir: path.join(__dirname, '..'),
    // 服务端的 /api/share 读的就是这个文件，路径是 <DATA_DIR 的上一级>/public-url.txt。
    // 内置服务器把 DATA_DIR 设在 userData/rooms，所以这里正好落在 userData 下 ——
    // 写进去之后 App 里的分享链接会自动切到公网地址。
    urlFile: path.join(app.getPath('userData'), 'public-url.txt'),
    logFile: path.join(app.getPath('userData'), 'tunnel.log'),
    // 国内直连 GitHub 的下载经常不通：按顺序多试几个镜像，
    // 每个镜像内部还会自动重试 + 断点续传（见 tunnel.js downloadWithRetry）
    mirrors: [
      'https://ghfast.top/',
      'https://gh-proxy.com/',
      'https://ghproxy.net/'
    ]
  };
}

function ensureTunnel() {
  if (tunnel) return tunnel;
  const mod = require('./tunnel');
  tunnel = mod.createTunnel(tunnelOptions());
  tunnel.bus.on('state', (s) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('chahu:tunnel', s); } catch (e) { /* ignore */ }
  });
  return tunnel;
}

ipcMain.handle('chahu:tunnel-start', async () => {
  if (!serverInfo) {
    return { ok: false, error: '本机没有在跑服务端（内置服务器被关掉了，或者指向了别人的服务器），没有可以穿透的本机端口' };
  }
  return await ensureTunnel().start(tunnelOptions().port, '127.0.0.1');
});

ipcMain.handle('chahu:tunnel-stop', () => ensureTunnel().stop());

ipcMain.handle('chahu:tunnel-status', () => ensureTunnel().state);

ipcMain.handle('chahu:save', async (e, name, payload) => {
  const filters = [];
  const n = String(name || 'chahu');
  if (/\.png$/i.test(n)) filters.push({ name: 'PNG 图片', extensions: ['png'] });
  else if (/\.jpe?g$/i.test(n)) filters.push({ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] });
  else if (/\.webp$/i.test(n)) filters.push({ name: 'WebP 图片', extensions: ['webp'] });
  else if (/\.psd$/i.test(n)) filters.push({ name: 'Photoshop 文档', extensions: ['psd'] });
  else if (/\.bmp$/i.test(n)) filters.push({ name: 'BMP 图片', extensions: ['bmp'] });
  else if (/\.tga$/i.test(n)) filters.push({ name: 'TGA 图片', extensions: ['tga'] });
  else if (/\.webm$/i.test(n)) filters.push({ name: 'WebM 视频', extensions: ['webm'] });
  else if (/\.json$/i.test(n)) filters.push({ name: 'JSON', extensions: ['json'] });
  else if (/\.chahu$/i.test(n)) filters.push({ name: '茶绘工程', extensions: ['chahu'] });
  filters.push({ name: '全部文件', extensions: ['*'] });

  const dir = app.getPath('pictures');
  const res = await dialog.showSaveDialog(win, {
    title: '保存到…',
    defaultPath: path.join(dir, n),
    filters
  });
  if (res.canceled || !res.filePath) return { canceled: true };

  try {
    if (typeof payload === 'string') {
      const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(payload);
      if (!m) return { ok: false, error: '不支持的数据格式' };
      fs.writeFileSync(res.filePath, Buffer.from(m[2], 'base64'));
    } else if (payload instanceof Uint8Array) {
      fs.writeFileSync(res.filePath, Buffer.from(payload));
    } else if (payload && payload.type === 'Buffer') {
      fs.writeFileSync(res.filePath, Buffer.from(payload.data));
    } else {
      fs.writeFileSync(res.filePath, Buffer.from(payload));
    }
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 打开一份本地文件。工程文件返回**文本**，PSD 返回 **base64**。
 * 主进程**不解析内容** —— 是不是一份合法工程、是不是一份读得动的 PSD，
 * 都交给渲染层判断，报错语句才能是用户看得懂的那句
 * （见 project.js 的 parse / psd-read.js 的 read）。
 */
ipcMain.handle('chahu:open', async (e, kind) => {
  const isPsd = kind === 'psd';
  const filters = kind === 'project'
    ? [{ name: '茶绘工程', extensions: ['chahu'] }, { name: '全部文件', extensions: ['*'] }]
    : isPsd
      ? [{ name: 'Photoshop 文件', extensions: ['psd', 'psb'] }, { name: '全部文件', extensions: ['*'] }]
      : [{ name: '全部文件', extensions: ['*'] }];
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'project' ? '打开茶绘工程' : (isPsd ? '导入 PSD' : '打开文件'),
    properties: ['openFile'],
    filters
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
  const p = res.filePaths[0];
  try {
    const buf = fs.readFileSync(p);
    // 上限跟着 ws 的 maxPayload（12MB）来：比这大的工程本来也传不进房间，
    // 与其读完再失败，不如在这里就说清楚。
    if (buf.length > 24 * 1024 * 1024) return { ok: false, error: '这个文件太大了（超过 24MB）' };
    // PSD 是二进制：按 utf8 读成文本再转回去，字节就已经不是原来那些了
    if (isPsd) return { ok: true, path: p, name: path.basename(p), b64: buf.toString('base64') };
    return { ok: true, path: p, name: path.basename(p), text: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 读系统剪贴板里的位图（「编辑 → 粘贴」用）。
 *
 * 走主进程读是刻意的：渲染进程的 navigator.clipboard.read() 要授权、
 * 还可能被 Chromium 的 user-gesture 规则挡掉，而主进程这边没有任何门槛。
 * 返回 data URL；剪贴板里没有图片就是 null（调用方继续走它的下一级兜底）。
 */
ipcMain.handle('chahu:clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    return img.toDataURL();
  } catch (err) {
    return null;
  }
});

/**
 * 更新包下载（「关于 → 检查更新」点下载走这里）。
 *
 * 为什么放在主进程：渲染进程 fetch 跨域的 GitHub 资产会被 CORS 挡掉，
 * 而主进程一点限制都没有，还能顺手把下好的安装包交给系统去跑。
 *
 * 直连失败会自动换 ghfast.top 镜像再试一次 —— 国内直连 GitHub 的下载
 * 经常是几十 KB/s 甚至直接断，而仓库本身就是公开的，走镜像没有任何额外的暴露。
 * 用了镜像会在返回值里带 mirror=true，界面会明说一句，不偷偷换源。
 */
function httpDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'chahui-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpDownload(new URL(res.headers.location, url).toString(), dest, onProgress));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress(total ? got / total : 0);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve({ bytes: got })));
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
  });
}

ipcMain.handle('chahu:download-update', async (e, url, name) => {
  const raw = String(url || '');
  if (!/^https:\/\//i.test(raw)) return { ok: false, error: '下载地址不合法' };
  const safe = String(name || 'chahui-update.exe').replace(/[^\w.\-]+/g, '_').slice(0, 80);
  const dir = path.join(app.getPath('userData'), 'updates');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { /* ignore */ }
  const dest = path.join(dir, safe);

  const attempts = [raw];
  if (/^https:\/\/github\.com\//i.test(raw)) attempts.push('https://ghfast.top/' + raw);

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await httpDownload(attempts[i], dest, (p) => {
        try { e.sender.send('chahu:update-progress', { percent: p, mirror: i > 0 }); } catch (err) { /* ignore */ }
      });
      let launched = false;
      if (process.platform === 'win32' && /\.exe$/i.test(dest)) {
        // 交给系统跑安装程序（UAC 弹窗由安装包自己出）
        const err2 = await shell.openPath(dest);
        launched = !err2;
      } else {
        shell.showItemInFolder(dest);
      }
      return { ok: true, path: dest, bytes: r.bytes, launched: launched, mirror: i > 0 };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: (lastErr && lastErr.message) || '下载失败' };
});

/* ---------------- 生命周期 ---------------- */

Menu.setApplicationMenu(null);
app.whenReady().then(async () => {
  const cfg = readConfig();
  // 默认开内置服务器：双击 exe 就能自己开房联机，不需要另外装 Node / 起服务端。
  // 想在设置里指向公网服务端时把它关掉（config.embeddedServer = false）。
  if (cfg.embeddedServer !== false && !cfg.server) {
    try {
      const embed = require('./server-embed');
      serverInfo = await embed.start({
        port: Number(cfg.port) || 8437,
        // 房间存档放用户数据目录，别塞进安装目录（那里通常没有写权限）
        dataDir: path.join(app.getPath('userData'), 'rooms'),
        // 内置服务器同时托管网页版，好让局域网的朋友直接用浏览器加入
        publicDir: path.join(__dirname, 'renderer')
      });
      console.log('[chahu] 内置服务器 ' + (serverInfo.reused ? '复用已运行实例' : '已启动') +
        ' · 端口 ' + serverInfo.port +
        (serverInfo.lan.length ? ' · 局域网 ' + serverInfo.lan.map(function (ip) { return 'http://' + ip + ':' + serverInfo.port; }).join(' / ') : ' · 未检测到局域网地址'));
    } catch (e) {
      console.error('[chahu] 内置服务器启动失败：' + e.message);
    }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时务必把隧道进程带走，否则 cloudflared 会变成孤儿进程一直挂在后台。
// stop() 顺手会把 public-url.txt 删掉 —— 那个域名是临时的，留着只会让下次启动时
// 分享链接指向一个早就没了的地址。
app.on('before-quit', () => {
  try { if (tunnel) tunnel.stop(); } catch (e) { /* ignore */ }
});

// 只允许一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}
