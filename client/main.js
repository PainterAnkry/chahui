'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.CHAHU_DEV;
let win = null;

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
  config: readConfig()
}));

ipcMain.handle('chahu:set-server', (e, url) => writeConfig({ server: String(url || '') }));

ipcMain.handle('chahu:save', async (e, name, payload) => {
  const filters = [];
  const n = String(name || 'chahu');
  if (/\.png$/i.test(n)) filters.push({ name: 'PNG 图片', extensions: ['png'] });
  else if (/\.webm$/i.test(n)) filters.push({ name: 'WebM 视频', extensions: ['webm'] });
  else if (/\.json$/i.test(n)) filters.push({ name: 'JSON', extensions: ['json'] });
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

/* ---------------- 生命周期 ---------------- */

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
