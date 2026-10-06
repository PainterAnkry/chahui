/**
 * 茶绘 · 隧道中继（服务端侧）
 *
 * 让「手机 / 任何 chahui 宿主」把自己本机的房间暴露到公网 —— 房间状态机跑在宿主
 * （安卓是 WebView 里的 local-core，见 android-shim.js），中继只做**帧管道**：
 *
 *   宿主：ws 升级到 /tunnel-host，发 {t:'TUNNEL_OPEN'}，回 {t:'TUNNEL_OPENED', id}；
 *         之后这条连接只说隧道帧（见下面的帧表），房间协议一个字节都不经过中继解析。
 *   访客：ws 升级到 /tunnel/<id> —— 直接成为一条透明管道，**不需要任何额外协议**，
 *         net.js / 网页版原样工作（帧原样转发给宿主，宿主回什么就转发回访客）。
 *
 * 帧表（宿主 ↔ 中继）：
 *   宿主→中继  {t:'TUNNEL_DATA', g:<访客号>, d:<原始JSON字符串>}
 *   中继→宿主  {t:'TUNNEL_GUEST_OPEN', g} | {t:'TUNNEL_GUEST_CLOSE', g}
 *             | {t:'TUNNEL_DATA', g, d}
 *   中继→宿主  {t:'TUNNEL_OPENED', id, guests}
 *   中继→访客  （未知/已关会话）{t:'TUNNEL_CLOSED', reason} 然后关闭
 *
 * 为什么不用桌面那套 cloudflared：它跑不了在安卓上；而中继就是一份普通的 chahui
 * 服务端（本文件随 server/src 一起部署），谁想要自己的中继就自己起一台 ——
 * 地址填进 App 即可，茶绘不绑定任何一台。
 *
 * 安全 / 配额：访客数上限、会话数上限、每连接消息速率闸（和主服务一个思路，防一个
 * 脚本打满）；中继不解析房间协议，最大帧 12MB 与主服务一致。
 */
'use strict';

const crypto = require('crypto');
const url = require('url');
const WebSocket = require('ws');

const MAX_PAYLOAD = 12 * 1024 * 1024;   // 与主服务 wss 一致
const MAX_GUESTS = 16;                  // 每条隧道的访客上限（手机带得动的量级）
const MAX_SESSIONS = 64;                // 整台中继的会话上限
const OPEN_TIMEOUT = 15000;             // 宿主连上后多久没发 TUNNEL_OPEN 就踢
const RATE_WINDOW = 10000;              // 速率闸窗口
const RATE_MAX = 400;                   // 窗口内最大帧数（绘画突发 ~25/秒，余量很大）

/** 随机会话 id：小写字母数字、无易混字符，8 位（62^8 对盗用足够） */
function newId() {
  return crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
}

function createRelay({ log } = {}) {
  const log_ = log || function () {};
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const sessions = new Map();            // id → { id, host, guests: Map, nextG, openedAt }
  let stopped = false;

  function safeSend(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) { /* 连接正在死，无所谓 */ }
    }
  }

  function dropSession(id, reason) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    if (s.openTimer) clearTimeout(s.openTimer);
    s.guests.forEach((g) => {
      safeSend(g.ws, { t: 'TUNNEL_CLOSED', reason: reason || 'host-gone' });
      try { g.ws.close(4001, 'tunnel-closed'); } catch (e) { /* ignore */ }
    });
    if (s.host && s.host.readyState === WebSocket.OPEN) {
      safeSend(s.host, { t: 'TUNNEL_CLOSED', reason: reason || '' });
    }
    log_('隧道关闭', id, reason || '');
  }

  /* ---------------- 宿主端（/tunnel-host） ---------------- */
  function hostConnection(ws) {
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    // 一条连接只允许开一条隧道；OPEN 有超时，防止挂着不用的空连接
    let opened = false;
    const openTimer = setTimeout(() => {
      if (!opened) { safeSend(ws, { t: 'TUNNEL_CLOSED', reason: 'open-timeout' }); ws.close(); }
    }, OPEN_TIMEOUT);

    ws.on('message', (raw) => {
      if (opened && !ws._rateOk()) { return; }   // 速率闸：直接丢帧（宿主是被信任端，闸只是兜底）
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'TUNNEL_OPEN') {
        if (opened) { safeSend(ws, { t: 'TUNNEL_OPENED', id: ws._sessionId, guests: sessions.get(ws._sessionId).guests.size }); return; }
        if (sessions.size >= MAX_SESSIONS) { safeSend(ws, { t: 'TUNNEL_CLOSED', reason: 'relay-full' }); ws.close(); return; }
        opened = true;
        clearTimeout(openTimer);
        const id = newId();
        const s = { id, host: ws, guests: new Map(), nextG: 1, openedAt: Date.now() };
        sessions.set(id, s);
        ws._sessionId = id;
        ws._rateOk = rateGate();
        safeSend(ws, { t: 'TUNNEL_OPENED', id, guests: 0 });
        log_('隧道开启', id);
        return;
      }
      if (!opened || !ws._sessionId) return;     // 没开隧道之前只认 TUNNEL_OPEN

      const s = sessions.get(ws._sessionId);
      if (!s) return;
      if (msg.t === 'TUNNEL_DATA') {
        const g = s.guests.get(msg.g | 0);
        // ⚠ 访客帧必须**原样直发**：msg.d 本身就是原始协议 JSON 字符串，
        // 走 safeSend 会再 JSON.stringify 一遍，访客收到的是带引号的字符串（踩过）
        if (g && typeof msg.d === 'string' && g.ws.readyState === WebSocket.OPEN) {
          try { g.ws.send(msg.d); } catch (e) { /* 连接正在死 */ }
        }
        return;
      }
      if (msg.t === 'TUNNEL_GUEST_CLOSE') {
        const g = s.guests.get(msg.g | 0);
        if (g) { try { g.ws.close(4001, 'host-closed-guest'); } catch (e) { /* ignore */ } }
        return;
      }
      // 其余类型一律忽略：宿主连接上没有别的协议
    });

    ws.on('close', () => {
      clearTimeout(openTimer);
      if (ws._sessionId) dropSession(ws._sessionId, 'host-disconnect');
    });
    ws.on('error', () => { /* close 会跟着来 */ });
  }

  /* ---------------- 访客端（/tunnel/<id>） ---------------- */
  function guestConnection(ws, id) {
    const s = sessions.get(id);
    if (!s || s.host.readyState !== WebSocket.OPEN) {
      // 会话不存在（手机下线了 / id 打错了）：告诉一声就关，net.js 会自己重试
      ws.on('message', () => safeSend(ws, { t: 'TUNNEL_CLOSED', reason: 'gone' }));
      try { ws.close(4001, 'no-tunnel'); } catch (e) { /* ignore */ }
      return;
    }
    if (s.guests.size >= MAX_GUESTS) {
      try { ws.close(4002, 'too-many-guests'); } catch (e) { /* ignore */ }
      return;
    }
    const g = s.nextG++;
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    s.guests.set(g, { ws });
    ws._rateOk = rateGate();
    safeSend(s.host, { t: 'TUNNEL_GUEST_OPEN', g });
    log_('隧道访客', id, '#' + g);

    ws.on('message', (raw) => {
      if (!ws._rateOk()) return;
      safeSend(s.host, { t: 'TUNNEL_DATA', g, d: raw.toString() });
    });
    ws.on('close', () => {
      if (s.guests.delete(g)) safeSend(s.host, { t: 'TUNNEL_GUEST_CLOSE', g });
    });
    ws.on('error', () => { /* close 会跟着来 */ });
  }

  /** 每连接一个的轻量速率闸：窗口内超量直接丢帧 */
  function rateGate() {
    let n = 0;
    let winStart = Date.now();
    return function () {
      const now = Date.now();
      if (now - winStart >= RATE_WINDOW) { winStart = now; n = 0; }
      return ++n <= RATE_MAX;
    };
  }

  // ws 级心跳：两端各 30s 一 ping，两轮没 pong 就断（管道两端死连接要及时清）
  const hb = setInterval(() => {
    if (stopped) return;
    wss.clients.forEach((ws) => {
      if (ws._alive === false) { try { ws.terminate(); } catch (e) { /* ignore */ } return; }
      ws._alive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    });
    sessions.forEach((s, id) => {
      if (!s.host || s.host.readyState !== WebSocket.OPEN) dropSession(id, 'host-dead');
    });
  }, 30000);
  if (hb.unref) hb.unref();

  return {
    wss,
    sessions,
    handleHost: hostConnection,
    handleGuest: guestConnection,
    /** 供 /health 汇报 */
    stats: () => ({ sessions: sessions.size,
      guests: Array.from(sessions.values()).reduce((n, s) => n + s.guests.size, 0) }),
    stop: () => {
      stopped = true;
      clearInterval(hb);
      Array.from(sessions.keys()).forEach((id) => dropSession(id, 'relay-stop'));
      try { wss.close(); } catch (e) { /* ignore */ }
    }
  };
}

/**
 * 把隧道中继挂到 HTTP server 上：注册 /tunnel-host 与 /tunnel/<id> 两条升级路由。
 * ⚠ upgrade 事件的**所有**监听都会被调用，无法「只给我」—— 所以这里必须接管整个
 * upgrade 分发：非隧道路径交给 opts.fallbackUpgrade（主服务用它在 noServer 的
 * wss 上完成 /ws 升级）。如果只注册自己的路由，ws 主服务那个 {path:'/ws'} 监听
 * 会对非匹配路径销毁 socket，把刚完成的隧道握手一起打死（踩过）。
 */
function attach(httpServer, opts) {
  const relay = createRelay(opts);
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (url.parse(req.url || '/').pathname || '/');
    if (pathname === '/tunnel-host') {
      relay.wss.handleUpgrade(req, socket, head, (ws) => relay.handleHost(ws));
      return;
    }
    const m = /^\/tunnel\/([A-Za-z0-9_-]{4,64})$/.exec(pathname);
    if (m) {
      relay.wss.handleUpgrade(req, socket, head, (ws) => relay.handleGuest(ws, m[1]));
      return;
    }
    if (opts && typeof opts.fallbackUpgrade === 'function') {
      opts.fallbackUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
  return relay;
}

module.exports = { attach };
