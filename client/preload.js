'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function toBytes(payload) {
  if (typeof payload !== 'string') return payload;
  if (payload.startsWith('data:')) return payload;
  if (payload.startsWith('blob:')) {
    const res = await fetch(payload);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
  return payload;
}

contextBridge.exposeInMainWorld('chahuDesktop', {
  isDesktop: true,
  saveFile: async (name, payload) => {
    try {
      const data = await toBytes(payload);
      return await ipcRenderer.invoke('chahu:save', name, data);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  getInfo: () => ipcRenderer.invoke('chahu:get-info'),
  openFile: (kind) => ipcRenderer.invoke('chahu:open', kind),
  clipboardImage: () => ipcRenderer.invoke('chahu:clipboard-image'),
  // 更新包下载：主进程下（没有 CORS 限制），进度通过事件回推
  downloadUpdate: (url, name) => ipcRenderer.invoke('chahu:download-update', url, name),
  onUpdateProgress: (cb) => {
    const fn = (_e, p) => { try { cb(p); } catch (err) { /* ignore */ } };
    ipcRenderer.on('chahu:update-progress', fn);
    return () => ipcRenderer.removeListener('chahu:update-progress', fn);
  },
  setServer: (url) => ipcRenderer.invoke('chahu:set-server', url),
  setEmbeddedServer: (on) => ipcRenderer.invoke('chahu:set-embedded', on),
  getServerInfo: () => ipcRenderer.invoke('chahu:server-info'),

  /* 离线模式：本地画布不走 socket，消息直通主进程里那份服务端。
     房间状态机是同一份，所以「关掉服务器」之后照旧能建房间、画、撤销。 */
  localOpen: () => ipcRenderer.invoke('chahu:local-open'),
  localFeed: (raw) => ipcRenderer.invoke('chahu:local-feed', raw),
  localClose: () => ipcRenderer.invoke('chahu:local-close'),
  onLocalMessage: (cb) => {
    const fn = (_e, raw) => { try { cb(raw); } catch (err) { /* ignore */ } };
    ipcRenderer.on('chahu:local-msg', fn);
    return () => ipcRenderer.removeListener('chahu:local-msg', fn);
  },

  /* 开关服务器：真停（不再监听端口），不是断开连接 */
  serverStatus: () => ipcRenderer.invoke('chahu:server-status'),
  serverStart: () => ipcRenderer.invoke('chahu:server-start'),
  serverStop: () => ipcRenderer.invoke('chahu:server-stop'),
  onServerState: (cb) => {
    const fn = (_e, s) => { try { cb(s); } catch (err) { /* ignore */ } };
    ipcRenderer.on('chahu:server', fn);
    return () => ipcRenderer.removeListener('chahu:server', fn);
  },
  // 公网联机（一键 cloudflared 隧道）。状态从主进程推回来，进度就靠它显示。
  startTunnel: () => ipcRenderer.invoke('chahu:tunnel-start'),
  stopTunnel: () => ipcRenderer.invoke('chahu:tunnel-stop'),
  getTunnelStatus: () => ipcRenderer.invoke('chahu:tunnel-status'),
  onTunnelState: (cb) => {
    const fn = (_e, s) => { try { cb(s); } catch (err) { /* ignore */ } };
    ipcRenderer.on('chahu:tunnel', fn);
    return () => ipcRenderer.removeListener('chahu:tunnel', fn);
  }
});
