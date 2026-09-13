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
  setServer: (url) => ipcRenderer.invoke('chahu:set-server', url),
  setEmbeddedServer: (on) => ipcRenderer.invoke('chahu:set-embedded', on),
  getServerInfo: () => ipcRenderer.invoke('chahu:server-info')
});
