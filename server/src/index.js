'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const P = require('./protocol');
const { RoomStore } = require('./rooms');

const PORT = parseInt(process.env.PORT || '8437', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data', 'rooms');
const IDLE_ROOM_TTL = parseInt(process.env.IDLE_ROOM_TTL || String(12 * 3600 * 1000), 10);
// 空房（没人在线且没有任何内容）的宽限期。以前是 30 分钟、而且扫描间隔 10 分钟，
// 于是随手建的探路房间会在列表里堆一大片。现在 5 分钟 + 30 秒扫一次。
const EMPTY_ROOM_TTL = parseInt(process.env.EMPTY_ROOM_TTL || String(5 * 60 * 1000), 10);
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '400', 10);
const MAX_MEMBERS_PER_ROOM = parseInt(process.env.MAX_MEMBERS || '40', 10);
const MAX_LAYERS = parseInt(process.env.MAX_LAYERS || '16', 10);

const store = new RoomStore(DATA_DIR);

/* ------------------------------------------------------------------ 静态站点 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self' http: https: ws: wss:"
      ].join('; ');
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: store.rooms.size, uptime: process.uptime() });
  if (url.pathname === '/api/rooms') return json(res, 200, { rooms: store.list() });
  if (!fs.existsSync(PUBLIC_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('茶绘服务端运行中（端口 ' + PORT + '）。桌面客户端可直接连接 /ws。');
  }
  serveStatic(req, res);
});

/* ------------------------------------------------------------------ WebSocket */

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 12 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } }
});

let connSeq = 0;
const colorCursor = { i: 0 };

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(Object.assign({ t: type }, payload || {})));
}

function roomBroadcast(room, type, payload, exceptId) {
  const raw = JSON.stringify(Object.assign({ t: type }, payload || {}));
  for (const m of room.members.values()) {
    if (m.connId === exceptId) continue;
    if (m.ws.readyState === m.ws.OPEN) m.ws.send(raw);
  }
}

function sanitizeName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return t || fallback;
}

function sanitizeText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}

function historyChunks(room) {
  const chunks = [];
  for (let i = 0; i < room.strokes.length; i += P.HISTORY_CHUNK_SIZE) {
    chunks.push(room.strokes.slice(i, i + P.HISTORY_CHUNK_SIZE));
  }
  return chunks;
}

/** 图层变更广播；baseImages 只在像素真的变了（复制/合并/固化）时才附带，避免无谓的大包 */
function broadcastLayers(room, baseImages) {
  const payload = { layers: room.layerList() };
  if (baseImages && Object.keys(baseImages).length) payload.baseImages = baseImages;
  roomBroadcast(room, P.S2C.LAYERS, payload);
}

/** 笔迹的公共字段（笔刷参数全部落库，保证所有客户端渲染结果一致） */
function buildStroke(msg, member, layer) {
  const br = P.normalizeBrush(msg);
  return {
    id: sanitizeText(msg.id, 40),
    layerId: layer.id,
    userId: member.userId,
    tool: P.TOOLS.indexOf(msg.tool) >= 0 ? msg.tool : 'brush',
    color: /^#[0-9a-fA-F]{3,8}$/.test(msg.color) ? msg.color : '#000000',
    size: Math.max(1, Math.min(400, Number(msg.size) || 6)),
    opacity: Math.max(0.02, Math.min(1, Number(msg.opacity) || 1)),
    hardness: br.hardness,
    minSize: br.minSize,
    pressSize: br.pressSize,
    pressOpacity: br.pressOpacity,
    edge: br.edge,
    scatter: br.scatter,
    grain: br.grain,
    grainScale: br.grainScale,
    paper: br.paper,
    fx: br.fx,
    strength: br.strength,
    tolerance: br.tolerance,
    expand: br.expand,
    blend: br.blend,
    sym: br.sym,
    brush: br.brush,
    filled: br.filled,
    seed: br.seed || P.newSeed(),
    points: [],
    ts: Date.now()
  };
}

/** 广播笔迹头（含全部笔刷参数），不含 points */
function strokeHeader(stroke) {
  return {
    id: stroke.id, layerId: stroke.layerId, userId: stroke.userId,
    tool: stroke.tool, color: stroke.color, size: stroke.size, opacity: stroke.opacity,
    hardness: stroke.hardness, minSize: stroke.minSize,
    pressSize: stroke.pressSize, pressOpacity: stroke.pressOpacity,
    edge: stroke.edge, scatter: stroke.scatter, grain: stroke.grain,
    grainScale: stroke.grainScale, paper: stroke.paper, fx: stroke.fx,
    strength: stroke.strength, tolerance: stroke.tolerance, expand: stroke.expand,
    blend: stroke.blend, sym: stroke.sym, brush: stroke.brush,
    filled: stroke.filled, seed: stroke.seed
  };
}

function joinRoom(ws, room, name, avatar, asOwner) {
  colorCursor.i += 1;
  const member = {
    connId: ws._connId,
    userId: P.rid('u'),
    name,
    avatar: avatar || null,
    color: P.userColor(colorCursor.i),
    ws,
    joinedAt: Date.now(),
    drawing: false,
    lastChat: 0
  };
  room.members.set(ws._connId, member);
  ws._roomId = room.id;
  ws._userId = member.userId;
  if (asOwner && !room.ownerId) { room.ownerId = member.userId; room.ownerName = member.name; }
  room.touch();

  send(ws, P.S2C.ROOM_JOINED, {
    room: room.meta(),
    layers: room.layerList(),
    members: room.memberList(),
    chat: room.chat,
    you: { userId: member.userId, name: member.name, color: member.color, isOwner: member.userId === room.ownerId },
    history: {
      count: room.strokes.length,
      lastSeq: room.seq,
      baseImages: room.baseImageMap()
    }
  });

  const chunks = historyChunks(room);
  if (chunks.length === 0) send(ws, P.S2C.HISTORY_CHUNK, { strokes: [], done: true });
  else chunks.forEach((c, i) => send(ws, P.S2C.HISTORY_CHUNK, { strokes: c, done: i === chunks.length - 1 }));

  roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
  roomBroadcast(room, P.S2C.CHAT, {
    id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
    text: member.name + ' 进入了茶绘室', ts: Date.now(), system: true
  });
  store.markDirty(room);
  console.log('[room] ' + member.name + ' 加入 ' + room.id + '（在线 ' + room.online + '）');
}

function leaveRoom(ws, silent) {
  const room = store.get(ws._roomId);
  if (!room) return;
  const member = room.members.get(ws._connId);
  room.members.delete(ws._connId);
  ws._roomId = null;
  if (!member) return;
  roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
  if (!silent) {
    roomBroadcast(room, P.S2C.CHAT, {
      id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
      text: member.name + ' 离开了茶绘室', ts: Date.now(), system: true
    });
  }
  room.lastActiveAt = Date.now();
  store.markDirty(room);
}

wss.on('connection', (ws, req) => {
  ws._connId = 'c' + (++connSeq);
  ws._roomId = null;
  ws._userId = null;
  ws._alive = true;

  ws.on('pong', () => { ws._alive = true; });

  send(ws, P.S2C.HELLO_OK, {
    serverVersion: P.PROTOCOL_VERSION,
    connId: ws._connId,
    rooms: store.list(),
    limits: { maxMembers: MAX_MEMBERS_PER_ROOM }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); } catch (err) {
      console.error('[ws] handle error', msg.t, err);
      send(ws, P.S2C.ERROR, { code: 'internal', message: '服务端处理出错：' + err.message });
    }
  });

  ws.on('close', () => leaveRoom(ws, false));
  ws.on('error', () => {});
});

function currentRoom(ws) {
  const room = store.get(ws._roomId);
  if (!room) return null;
  return room.members.has(ws._connId) ? room : null;
}

function handle(ws, msg) {
  const room = currentRoom(ws);
  const member = room ? room.members.get(ws._connId) : null;

  switch (msg.t) {
    /* ---------------- 基础 ---------------- */
    case P.C2S.PING: return send(ws, P.S2C.PONG, { t0: Number(msg.at) || Date.now() });
    case P.C2S.ROOM_LIST: return send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
    case P.C2S.RESYNC: {
      if (!room) return;
      send(ws, P.S2C.ROOM_JOINED, {
        room: room.meta(), layers: room.layerList(), members: room.memberList(),
        chat: room.chat,
        you: { userId: member.userId, name: member.name, color: member.color, isOwner: member.userId === room.ownerId },
        history: {
          count: room.strokes.length, lastSeq: room.seq,
          baseImages: room.baseImageMap()
        }
      });
      const chunks = historyChunks(room);
      if (!chunks.length) send(ws, P.S2C.HISTORY_CHUNK, { strokes: [], done: true });
      else chunks.forEach((c, i) => send(ws, P.S2C.HISTORY_CHUNK, { strokes: c, done: i === chunks.length - 1 }));
      return;
    }

    /* ---------------- 房间 ---------------- */
    case P.C2S.ROOM_CREATE: {
      if (ws._roomId) leaveRoom(ws, true);
      if (store.rooms.size >= MAX_ROOMS) {
        return send(ws, P.S2C.ERROR, { code: 'too_many_rooms', message: '房间数已达上限，请稍后再试' });
      }
      const name = sanitizeName(msg.name, P.DEFAULTS.roomName);
      const user = sanitizeName(msg.user, '茶友');
      const wanted = (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(msg.id)) ? msg.id : null;
      if (wanted && store.get(wanted)) {
        return send(ws, P.S2C.ERROR, { code: 'room_exists', message: '房间号「' + wanted + '」已被占用，换一个吧' });
      }
      const room = store.create({
        id: wanted || undefined,
        name, width: msg.width, height: msg.height,
        background: msg.background,
        ownerName: user,
        password: sanitizeText(msg.password, 32)
      });
      joinRoom(ws, room, user, msg.avatar, true);
      send(ws, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    case P.C2S.ROOM_JOIN: {
      const id = sanitizeText(msg.roomId, 64);
      const target = store.get(id);
      if (!target) return send(ws, P.S2C.ERROR, { code: 'no_room', message: '房间不存在或已关闭' });
      if (target.members.size >= MAX_MEMBERS_PER_ROOM) {
        return send(ws, P.S2C.ERROR, { code: 'room_full', message: '房间人数已满（' + MAX_MEMBERS_PER_ROOM + ' 人）' });
      }
      if (target.password && sanitizeText(msg.password, 32) !== target.password) {
        return send(ws, P.S2C.ERROR, { code: 'bad_password', message: '房间密码不正确' });
      }
      if (ws._roomId) leaveRoom(ws, true);
      joinRoom(ws, target, sanitizeName(msg.user, '茶友'), msg.avatar);
      return;
    }

    case P.C2S.ROOM_LEAVE:
      leaveRoom(ws, false);
      return send(ws, P.S2C.ROOM_LEFT, {});

    case P.C2S.ROOM_INFO: {
      if (!room) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以修改房间设置' });
      }
      if (typeof msg.name === 'string') room.name = sanitizeName(msg.name, room.name);
      if (typeof msg.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.background)) room.background = msg.background;
      store.markDirty(room);
      roomBroadcast(room, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      send(ws, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    case P.C2S.ROOM_RESIZE: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以调整画布分辨率' });
      }
      const w = Number(msg.width), h = Number(msg.height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || w > 4096 || h < 240 || h > 4096) {
        return send(ws, P.S2C.ERROR, { code: 'bad_size', message: '画布尺寸超出范围（320-4096 × 240-4096）' });
      }
      const changed = room.setSize(w, h);
      if (!changed) return;
      store.markDirty(room);
      // 重要：尺寸变了需要让客户端重建引擎，重新拉一次历史重放
      roomBroadcast(room, P.S2C.ROOM_RESIZED, { width: room.width, height: room.height });
      roomBroadcast(room, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    case P.C2S.ROOM_DEL: {
      const id = sanitizeText(msg.roomId, 64);
      const target = store.get(id);
      if (!target) return send(ws, P.S2C.OK, { ok: true }); // 房间已不存在也算成功
      const isOwner = member && member.userId === target.ownerId;
      const isEmpty = target.online === 0;
      if (!isOwner && !isEmpty) {
        return send(ws, P.S2C.ERROR, { code: 'room_busy', message: '房间内还有人，无法删除' });
      }
      // 先把还在线的成员请出（仅房主时会有）
      target.members.forEach(function (m) {
        try { send(m.ws, P.S2C.ROOM_DELETED, { id: id, by: member ? member.userId : null }); } catch (e) { /* ignore */ }
      });
      store.drop(id);
      console.log('[room] ' + id + ' 被 ' + (member ? member.name : 'GC') + ' 删除');
      send(ws, P.S2C.OK, { ok: true, deleted: id });
      send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
      return;
    }

    // 一键清理：把所有「没人在线 + 没有任何内容」的房间都回收掉
    case P.C2S.ROOM_GC: {
      const n = purgeBlankRooms(0);
      console.log('[room] ' + (member ? member.name : ws._connId) + ' 一键清理了 ' + n + ' 个空房间');
      send(ws, P.S2C.OK, { ok: true, purged: n });
      send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
      // 其他人列表里也刷新一下
      for (const c of wss.clients) {
        if (c !== ws && c.readyState === 1 && !c._roomId) {
          try { send(c, P.S2C.ROOM_LIST, { rooms: store.list() }); } catch (e) { /* ignore */ }
        }
      }
      return;
    }

    /* ---------------- 笔迹 ---------------- */
    case P.C2S.STROKE_BEGIN: {
      if (!room || !canDraw(room, member)) return;
      const layer = room.getLayer(msg.layerId) || room.layers[room.layers.length - 1];
      if (!member) return;
      if (ws._activeStroke) return;
      const stroke = buildStroke(msg, member, layer);
      if (!stroke.id) return;
      ws._activeStroke = stroke;
      member.drawing = true;
      roomBroadcast(room, P.S2C.STROKE_BEGIN, { stroke: strokeHeader(stroke) }, ws._connId);
      return;
    }

    case P.C2S.STROKE_POINTS: {
      const stroke = ws._activeStroke;
      if (!room || !stroke || !Array.isArray(msg.pts) || stroke.id !== msg.id) return;
      const pts = [];
      for (const p of msg.pts) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const x = Number(p[0]), y = Number(p[1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        pts.push(P.qp([x, y, isFinite(Number(p[2])) ? Number(p[2]) : 0.5]));
      }
      if (!pts.length) return;
      stroke.points.push(...pts);
      roomBroadcast(room, P.S2C.STROKE_POINTS, { id: stroke.id, pts }, ws._connId);
      return;
    }

    case P.C2S.STROKE_END: {
      const stroke = ws._activeStroke;
      ws._activeStroke = null;
      if (!room || !stroke) return;
      if (member) member.drawing = false;
      if (stroke.points.length === 0) {
        roomBroadcast(room, P.S2C.STROKE_CANCEL, { id: stroke.id }, ws._connId);
        return;
      }
      room.addStroke(stroke);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_END, { id: stroke.id, seq: stroke.seq }, ws._connId);
      send(ws, P.S2C.STROKE_END, { id: stroke.id, seq: stroke.seq });
      return;
    }

    case P.C2S.STROKE_CANCEL: {
      const stroke = ws._activeStroke;
      ws._activeStroke = null;
      if (!room || !stroke) return;
      if (member) member.drawing = false;
      roomBroadcast(room, P.S2C.STROKE_CANCEL, { id: stroke.id }, ws._connId);
      return;
    }

    case P.C2S.STROKE_UNDO: {
      if (!room || !member || !Array.isArray(msg.ids)) return;
      const ids = msg.ids.filter(id => room.strokes.some(s => s.id === id && s.userId === member.userId));
      if (!ids.length) return;
      room.removeStrokes(ids);
      store.markDirty(room);
      // 发起者已在本地乐观移除，不回显（否则其重做栈会被 pruneUndo 清空）
      roomBroadcast(room, P.S2C.STROKE_REMOVED, { ids, reason: 'undo', by: member.userId }, ws._connId);
      return;
    }

    case P.C2S.STROKE_REDO: {
      if (!room || !member || !msg.stroke || typeof msg.stroke !== 'object') return;
      const s = msg.stroke;
      if (!s.id || !Array.isArray(s.points) || !s.points.length) return;
      if (room.strokes.some(k => k.id === s.id)) return;
      const layer = room.getLayer(s.layerId) || room.layers[room.layers.length - 1];
      const stroke = buildStroke(s, member, layer);
      stroke.points = s.points.map(p => P.qp(p));
      const saved = room.redoStroke(stroke);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_ADDED, { stroke: saved });
      send(ws, P.S2C.STROKE_ADDED, { stroke: saved });
      return;
    }

    case P.C2S.STROKE_CLEAR: {
      if (!room || !member) return;
      const scope = msg.scope === 'all' ? 'all' : 'layer';
      if (scope === 'all' && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以清空整个画布' });
      }
      const removed = room.clear(scope, sanitizeText(msg.layerId, 40));
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_REMOVED, { ids: [], reason: 'clear', scope, layerId: msg.layerId, by: member.userId, removed });
      broadcastLayers(room, room.baseImageMap());
      return;
    }

    /* ---------------- 图层 ---------------- */
    case P.C2S.LAYER_ADD: {
      if (!room || !member) return;
      if (room.layers.length >= MAX_LAYERS) {
        return send(ws, P.S2C.ERROR, { code: 'layer_limit', message: '图层数量上限为 ' + MAX_LAYERS });
      }
      room.addLayer(sanitizeName(msg.name, ''), msg.at);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_DEL: {
      if (!room || !member) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以删除' });
      }
      const removed = room.delLayer(l.id);
      if (!removed) return send(ws, P.S2C.ERROR, { code: 'last_layer', message: '至少要保留一个图层' });
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_UPD: {
      if (!room || !member) return;
      room.updateLayer(sanitizeText(msg.layerId, 40), msg.patch || {});
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_MOVE: {
      if (!room || !member) return;
      room.moveLayer(sanitizeText(msg.layerId, 40), Number(msg.to) || 0);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_DUP: {
      if (!room || !member) return;
      if (room.layers.length >= MAX_LAYERS) {
        return send(ws, P.S2C.ERROR, { code: 'layer_limit', message: '图层数量上限为 ' + MAX_LAYERS });
      }
      const src = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!src) return;
      const copy = room.dupLayer(src.id, msg.png, Number(msg.upToSeq) || room.seq);
      if (!copy) return;
      store.markDirty(room);
      broadcastLayers(room, copy.baseImage ? { [copy.id]: copy.baseImage } : null);
      return;
    }

    case P.C2S.LAYER_CLEAR: {
      if (!room || !member) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以清空' });
      }
      room.clearLayer(l.id);
      store.markDirty(room);
      // 必须让客户端把本机这份图层的历史笔迹一起丢掉：
      // 只发 LAYERS 的话，客户端会拿自己的笔迹数组重放，看起来像「清除没生效」。
      // 与 STROKE_CLEAR 走同一条通知，客户端已有 clearScope 处理分支。
      roomBroadcast(room, P.S2C.STROKE_REMOVED, {
        ids: [], reason: 'clear', scope: 'layer', layerId: l.id, by: member.userId, removed: true
      });
      broadcastLayers(room);
      return;
    }

    /**
     * 用客户端渲染好的像素整体替换某个图层。
     * 图像变换（自由变换 / 缩放 / 旋转…）和「图像大小」缩放画面都用它 ——
     * 变换后的像素没法用笔迹重放表达，只能像复制/合并那样由客户端烘焙成 PNG 回传，
     * 服务端依旧只做哑存储。
     */
    case P.C2S.LAYER_PIXELS: {
      if (!room || !member) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以整体替换' });
      }
      const okPix = room.setLayerPixels(l.id, msg.png, Number(msg.upToSeq) || room.seq);
      if (!okPix) return send(ws, P.S2C.ERROR, { code: 'bad_pixels', message: '图层像素数据无效' });
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_REMOVED, {
        ids: [], reason: 'clear', scope: 'layer', layerId: l.id, by: member.userId, removed: true
      });
      broadcastLayers(room, { [l.id]: l.baseImage });
      return;
    }

    case P.C2S.LAYER_MERGE: {
      if (!room || !member) return;
      const srcId = sanitizeText(msg.srcId, 40);
      const dstId = sanitizeText(msg.dstId, 40);
      if (!room.layerIsSolo(srcId, member.userId) || !room.layerIsSolo(dstId, member.userId)) {
        if (member.userId !== room.ownerId) {
          return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '这两个图层里有别人的成果，只有房主可以合并' });
        }
      }
      const dst = room.mergeLayers(srcId, dstId, msg.png, Number(msg.upToSeq) || room.seq);
      if (!dst) return send(ws, P.S2C.ERROR, { code: 'merge_fail', message: '无法合并这两个图层' });
      store.markDirty(room);
      broadcastLayers(room, dst.baseImage ? { [dst.id]: dst.baseImage } : null);
      return;
    }

    case P.C2S.LAYER_FLATTEN: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以合并所有图层' });
      }
      const keep = room.flatten(msg.png, sanitizeName(msg.name, '合并图层'), Number(msg.upToSeq) || room.seq);
      store.markDirty(room);
      broadcastLayers(room, keep.baseImage ? { [keep.id]: keep.baseImage } : null);
      return;
    }

    /* ---------------- 固化底图 ---------------- */
    case P.C2S.ROOM_COMPRESS: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以固化底图' });
      }
      const saved = room.compress(msg.pngs || {}, Number(msg.upToSeq) || room.seq);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.ROOM_UPDATED, {
        patch: Object.assign(room.meta(), { baseImages: room.baseImageMap() })
      });
      send(ws, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房间已固化底图，压缩了 ' + saved + ' 条历史笔迹', ts: Date.now()
      });
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房主固化了底图，压缩了 ' + saved + ' 条历史笔迹', ts: Date.now()
      });
      return;
    }

    /* ---------------- 解散房间 ---------------- */
    case P.C2S.ROOM_DESTROY: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以解散房间' });
      }
      const name = room.name;
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房主解散了房间「' + name + '」', ts: Date.now()
      });
      for (const m of Array.from(room.members.values())) {
        if (m.ws.readyState === m.ws.OPEN) send(m.ws, P.S2C.ROOM_DESTROYED, { by: member.name });
      }
      room.members.clear();
      store.drop(room.id);
      console.log('[room] ' + name + '（' + room.id + '）已被房主解散');
      return;
    }

    /* ---------------- 聊天 / 光标 ---------------- */
    case P.C2S.CHAT: {
      if (!room || !member) return;
      const now = Date.now();
      if (now - member.lastChat < 250) return;
      member.lastChat = now;
      const text = sanitizeText(msg.text, 500).trim();
      const img = P.normalizeSticker(msg.img);
      if (!text && !img) return;
      const entry = { id: P.rid('m'), userId: member.userId, name: member.name, color: member.color, text, ts: now };
      if (img) entry.img = img;
      room.addChat(entry);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.CHAT, entry);
      send(ws, P.S2C.CHAT, entry);
      return;
    }

    case P.C2S.CURSOR: {
      if (!room || !member) return;
      if (member.cursorAt && Date.now() - member.cursorAt < 60) {
        member.pendingCursor = { x: Number(msg.x) || 0, y: Number(msg.y) || 0, active: !!msg.active };
        return;
      }
      member.cursorAt = Date.now();
      roomBroadcast(room, P.S2C.CURSOR, {
        userId: member.userId, name: member.name, color: member.color,
        x: Number(msg.x) || 0, y: Number(msg.y) || 0, active: !!msg.active,
        tool: msg.tool || 'brush'
      }, ws._connId);
      return;
    }

    default:
      return;
  }
}

function canDraw(room, member) {
  if (!member) return false;
  if (member.readonly) return false;
  return true;
}

/* ------------------------------------------------------------------ 心跳 & 清理 */

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws._alive === false) return ws.terminate();
    ws._alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 30000);
heartbeat.unref && heartbeat.unref();

/**
 * 房间是否「空的」：没人在线，且没有任何绘画内容（笔迹 / 底图）。
 *
 * 聊天不算内容 —— 这是绘画软件，一个连一笔都没画过的房间就是探路房，
 * 只因为一句「大家好」就留 12 小时，正是房间列表越堆越乱的原因。
 * 删掉这种房间不会丢任何人的画。
 */
function isBlankRoom(room) {
  if (room.online > 0) return false;
  if (room.strokes.length) return false;
  if (room.layers.some(l => l.baseImage)) return false;
  return true;
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(store.rooms.values())) {
    if (room.online > 0) continue;
    const idle = now - room.lastActiveAt;
    if (isBlankRoom(room) && idle > EMPTY_ROOM_TTL) { store.drop(room.id); continue; }
    if (idle > IDLE_ROOM_TTL) { store.drop(room.id); }
  }
}, 30 * 1000);
sweeper.unref && sweeper.unref();

function shutdown() {
  console.log('\n[server] 正在保存房间并退出…');
  clearInterval(heartbeat);
  clearInterval(sweeper);
  store.saveAll();
  try { wss.close(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── 空房 GC：回收「没人在线 + 没有任何内容」的房间，避免房间列表堆积
const ROOM_GC_INTERVAL_MS = parseInt(process.env.ROOM_GC_INTERVAL_MS || '30000', 10);       // 30 秒一次
const ROOM_EMPTY_TTL_MS   = parseInt(process.env.ROOM_EMPTY_TTL_MS   || String(EMPTY_ROOM_TTL), 10);

/** 清掉所有空白房间（没人在线、没有笔迹 / 底图 / 聊天），返回被清掉的数量 */
function purgeBlankRooms(maxAgeMs) {
  const now = Date.now();
  const grace = maxAgeMs == null ? ROOM_EMPTY_TTL_MS : maxAgeMs;
  let n = 0;
  for (const room of Array.from(store.rooms.values())) {
    if (!isBlankRoom(room)) continue;
    if (grace > 0 && now - (room.lastActiveAt || 0) <= grace) continue;
    store.drop(room.id);
    n++;
  }
  return n;
}

const gcTimer = setInterval(function () {
  try {
    const n = purgeBlankRooms();
    if (n) console.log('[gc] 回收 ' + n + ' 个空白房间');
  } catch (e) {
    console.error('[gc] 失败', e.message);
  }
}, ROOM_GC_INTERVAL_MS);
gcTimer.unref && gcTimer.unref();

server.listen(PORT, HOST, () => {
  // 启动时先扫一遍：上次退出后遗留的探路空房不会一直挂在房间列表里
  try {
    const n = purgeBlankRooms(0);
    if (n) console.log('[gc] 启动清理了 ' + n + ' 个空白房间');
  } catch (e) { /* ignore */ }
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('════════════════════════════════════════');
  console.log('  茶绘服务端已启动');
  console.log('  本机:   http://localhost:' + PORT);
  ips.forEach(ip => console.log('  局域网: http://' + ip + ':' + PORT));
  console.log('  房间数: ' + store.rooms.size + '（存档目录 ' + DATA_DIR + '）');
  console.log('════════════════════════════════════════');
});
