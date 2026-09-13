'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./protocol');

const MAX_STROKES_PER_ROOM = 60000;
const MAX_CHAT = 300;
const MAX_ROOM_STROKE_BYTES = 24 * 1024 * 1024; // 房间历史（不含底图）序列化上限
const ROOM_SCHEMA = 3;                          // 存档结构版本：旧版本存档在启动时清理

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function isPng(s) { return typeof s === 'string' && s.startsWith('data:image/png;base64,'); }

/**
 * 递归删目录，失败要能重试、并且「真的删掉了」才算成功。
 *
 * 为什么不能只用 fs.rmSync：Windows 上目录里只要有一个文件被杀软 / 预览缩略图
 * 占着句柄，rmSync 就会整体放弃（抛 EBUSY/EPERM），而旧代码 `catch {}` 一吞了事 ——
 * 于是一个「已删除」的房间会永远留在 data/rooms 里，越积越多。
 */
function rmTree(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
    } catch (e) { /* 可能是占用，下面兜底 */ }
    if (!fs.existsSync(dir)) return true;
    // 兜底：逐个文件 unlink 再 rmdir（占用通常只发生在个别 png 上）
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) rmTree(q);
        else { try { fs.unlinkSync(q); } catch (err) { /* ignore */ } }
      }
      fs.rmdirSync(dir);
    } catch (e) { /* ignore */ }
    if (!fs.existsSync(dir)) return true;
    try { fs.chmodSync(dir, 0o777); } catch (e) { /* ignore */ }
  }
  return !fs.existsSync(dir);
}

function newLayer(meta) {
  return {
    id: meta.id || P.rid('L'),
    name: meta.name || '图层',
    visible: meta.visible !== false,
    opacity: typeof meta.opacity === 'number' ? clamp(meta.opacity, 0, 1) : 1,
    locked: !!meta.locked,
    alphaLock: !!meta.alphaLock,
    blend: P.BLEND_MODES.indexOf(meta.blend) >= 0 ? meta.blend : 'normal',
    baseImage: meta.baseImage || null,
    baseSeq: meta.baseSeq || 0
  };
}

class Room {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name || P.DEFAULTS.roomName;
    this.width = clamp(Math.round(meta.width || P.DEFAULTS.width), 320, 4096);
    this.height = clamp(Math.round(meta.height || P.DEFAULTS.height), 240, 4096);
    this.background = meta.background || P.DEFAULTS.background;
    this.ownerId = meta.ownerId || null;
    this.ownerName = meta.ownerName || '';
    this.password = meta.password || '';
    this.createdAt = meta.createdAt || Date.now();
    this.lastActiveAt = Date.now();

    this.seq = 0;
    this.layers = (meta.layers || [{
      id: P.rid('L'),
      name: '图层 1',
      visible: true,
      opacity: 1,
      locked: false,
      alphaLock: false,
      blend: 'normal',
      baseImage: null,
      baseSeq: 0
    }]).map(l => newLayer(l));

    this.strokes = meta.strokes || []; // 按 seq 升序
    this.chat = meta.chat || [];
    this.members = new Map(); // connId -> member
    this.dirty = false;
  }

  get online() { return this.members.size; }

  setSize(width, height) {
    const oldW = this.width, oldH = this.height;
    this.width = clamp(Math.round(width || this.width), 320, 4096);
    this.height = clamp(Math.round(height || this.height), 240, 4096);
    // 图层画布由客户端持有的 canvas 维护；服务端只更新尺寸元数据。
    // 客户端收到 ROOM_RESIZED 后会用新尺寸重建 engine，并以历史笔迹与 baseImages 重放。
    return oldW !== this.width || oldH !== this.height;
  }

  meta() {
    return {
      id: this.id,
      name: this.name,
      width: this.width,
      height: this.height,
      background: this.background,
      ownerId: this.ownerId,
      ownerName: this.ownerName,
      hasPassword: !!this.password,
      createdAt: this.createdAt,
      online: this.online,
      strokeCount: this.strokes.length,
      lastSeq: this.seq
    };
  }

  summary() {
    const m = this.meta();
    return {
      id: m.id, name: m.name, online: m.online,
      width: m.width, height: m.height,
      strokes: m.strokeCount, hasPassword: m.hasPassword,
      ownerName: m.ownerName, createdAt: m.createdAt,
      // 「空房」= 没人在线 + 一笔没画 + 没有底图。客户端用它来算「清理空房」的条数，
      // 免得按钮文案和服务端实际会删的东西对不上。
      blank: this.online === 0 && this.strokes.length === 0 &&
        !this.layers.some(l => l.baseImage)
    };
  }

  layerList() {
    return this.layers.map(l => ({
      id: l.id, name: l.name, visible: l.visible,
      opacity: l.opacity, locked: l.locked, alphaLock: l.alphaLock,
      blend: l.blend, baseSeq: l.baseSeq
    }));
  }

  /** 仅保留含底图的图层映射（合并 / 复制 / 固化后回传给客户端） */
  baseImageMap() {
    const o = {};
    for (const l of this.layers) if (l.baseImage) o[l.id] = l.baseImage;
    return o;
  }

  memberList() {
    return Array.from(this.members.values()).map(m => ({
      userId: m.userId, name: m.name, color: m.color,
      isOwner: m.userId === this.ownerId, drawing: !!m.drawing
    }));
  }

  // ---- 笔迹 ----
  addStroke(stroke) {
    stroke.seq = ++this.seq;
    this.strokes.push(stroke);
    this.lastActiveAt = Date.now();
    this.dirty = true;
    if (this.strokes.length > MAX_STROKES_PER_ROOM) this.trimOldest();
    return stroke;
  }

  /** 房间有任何活动时调用，避免被 GC 当作僵尸房间 */
  touch() { this.lastActiveAt = Date.now(); }

  // 重做：以新的 seq 重新插入末尾（视觉结果一致）
  redoStroke(stroke) {
    const s = Object.assign({}, stroke, { seq: ++this.seq });
    this.strokes.push(s);
    this.dirty = true;
    return s;
  }

  removeStrokes(ids) {
    const set = new Set(ids);
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(s => !set.has(s.id));
    if (this.strokes.length !== before) { this.dirty = true; return before - this.strokes.length; }
    return 0;
  }

  clear(scope, layerId) {
    const before = this.strokes.length;
    if (scope === 'all') this.strokes = [];
    else this.strokes = this.strokes.filter(s => s.layerId !== layerId);
    // 清空时底图一并清掉
    for (const l of this.layers) {
      if (scope === 'all' || l.id === layerId) { l.baseImage = null; l.baseSeq = 0; }
    }
    this.dirty = true;
    return before - this.strokes.length;
  }

  trimOldest() {
    const drop = this.strokes.length - MAX_STROKES_PER_ROOM;
    if (drop <= 0) return;
    this.strokes.splice(0, drop);
    this.dirty = true;
  }

  // ---- 图层 ----
  getLayer(id) { return this.layers.find(l => l.id === id); }

  addLayer(name, at) {
    const l = newLayer({
      name: name || ('图层 ' + (this.layers.length + 1))
    });
    const idx = (typeof at === 'number' && at >= 0 && at <= this.layers.length) ? at : this.layers.length;
    this.layers.splice(idx, 0, l);
    this.dirty = true;
    return l;
  }

  delLayer(id) {
    if (this.layers.length <= 1) return null;
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return null;
    const [l] = this.layers.splice(i, 1);
    this.strokes = this.strokes.filter(s => s.layerId !== id);
    this.dirty = true;
    return l;
  }

  moveLayer(id, to) {
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    to = clamp(to, 0, this.layers.length - 1);
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(to, 0, l);
    this.dirty = true;
    return true;
  }

  updateLayer(id, patch) {
    const l = this.getLayer(id);
    if (!l) return null;
    if (typeof patch.name === 'string') l.name = patch.name.slice(0, 24) || l.name;
    if (typeof patch.visible === 'boolean') l.visible = patch.visible;
    if (typeof patch.locked === 'boolean') l.locked = patch.locked;
    if (typeof patch.alphaLock === 'boolean') l.alphaLock = patch.alphaLock;
    if (typeof patch.opacity === 'number') l.opacity = clamp(patch.opacity, 0, 1);
    if (P.BLEND_MODES.indexOf(patch.blend) >= 0) l.blend = patch.blend;
    this.dirty = true;
    return l;
  }

  // ---- 图层的「像素级」操作：像素由客户端渲染后回传 PNG ----

  /** 复制图层（内容烘焙成底图，不复制笔迹） */
  dupLayer(id, png, upToSeq) {
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return null;
    const src = this.layers[i];
    const copy = newLayer({
      name: (src.name || '图层').slice(0, 16) + ' 副本',
      opacity: src.opacity,
      blend: src.blend,
      baseImage: isPng(png) ? png : null,
      baseSeq: upToSeq || this.seq
    });
    this.layers.splice(i + 1, 0, copy);
    this.dirty = true;
    return copy;
  }

  /** 清除图层内容（底图 + 笔迹） */
  clearLayer(id) {
    const l = this.getLayer(id);
    if (!l) return false;
    l.baseImage = null;
    l.baseSeq = 0;
    this.strokes = this.strokes.filter(s => s.layerId !== id);
    this.dirty = true;
    return true;
  }

  /**
   * 用客户端渲染好的像素整体替换图层内容（图像变换 / 缩放画面用）。
   * 该图层原有笔迹一并丢弃 —— 像素已经是它们渲染后的结果，再重放会画两遍。
   */
  setLayerPixels(id, png, upToSeq) {
    const l = this.getLayer(id);
    if (!l) return false;
    if (!isPng(png)) return false;
    l.baseImage = png;
    l.baseSeq = upToSeq || this.seq;
    this.strokes = this.strokes.filter(s => s.layerId !== id);
    this.dirty = true;
    return true;
  }

  /** 向下合并：src 的像素已由客户端合成进 png，写入 dst 后删除 src */
  mergeLayers(srcId, dstId, png, upToSeq) {
    const si = this.layers.findIndex(l => l.id === srcId);
    const dst = this.getLayer(dstId);
    if (si < 0 || !dst || srcId === dstId) return null;
    if (isPng(png)) dst.baseImage = png;
    dst.baseSeq = upToSeq || this.seq;
    this.layers.splice(si, 1);
    this.strokes = this.strokes.filter(s => s.layerId !== srcId && s.layerId !== dstId);
    this.dirty = true;
    return dst;
  }

  /** 合并可见图层：全部烘焙成一层 */
  flatten(png, name, upToSeq) {
    const first = this.layers[0];
    const keep = newLayer({
      id: first ? first.id : undefined,
      name: name || '合并图层',
      baseImage: isPng(png) ? png : null,
      baseSeq: upToSeq || this.seq
    });
    this.layers = [keep];
    this.strokes = [];
    this.dirty = true;
    return keep;
  }

  /** 该图层是否只包含此用户的成果（否则破坏性操作需要房主） */
  layerIsSolo(id, userId) {
    const l = this.getLayer(id);
    if (!l) return true;
    if (l.baseSeq > 0) return false;
    return !this.strokes.some(s => s.layerId === id && s.userId !== userId);
  }

  // 固化底图：把各图层已渲染结果作为底图存下，裁剪已固化笔迹
  compress(pngs, upToSeq) {
    let saved = 0;
    for (const l of this.layers) {
      const data = pngs && pngs[l.id];
      if (isPng(data)) {
        l.baseImage = data;
        l.baseSeq = upToSeq;
      }
    }
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(s => s.seq > upToSeq);
    saved = before - this.strokes.length;
    this.dirty = true;
    return saved;
  }

  addChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.dirty = true;
  }

  estimateHistoryBytes() {
    return this.strokes.reduce((n, s) => n + 18 + s.points.length * 16, 0);
  }
}

class RoomStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.rooms = new Map();
    this.saveTimers = new Map();
    fs.mkdirSync(dataDir, { recursive: true });
    this.loadAll();
  }

  roomDir(id) { return path.join(this.dataDir, id); }

  create(meta) {
    let id = meta.id;
    if (!id) {
      do { id = P.rid('r'); } while (this.rooms.has(id));
    }
    const room = new Room(Object.assign({}, meta, { id }));
    this.rooms.set(id, room);
    this.markDirty(room);
    return room;
  }

  get(id) { return this.rooms.get(id); }

  list() {
    return Array.from(this.rooms.values())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(r => r.summary());
  }

  drop(id) {
    const t = this.saveTimers.get(id);
    if (t) { clearTimeout(t); this.saveTimers.delete(id); }
    const room = this.rooms.get(id);
    if (room) room.dropped = true;
    this.rooms.delete(id);
    const dir = this.roomDir(id);
    if (!rmTree(dir)) console.error('[store] 目录删不掉，可能是文件被占用：' + dir);
  }

  /**
   * 回收「没人 + 太久没活动」的房间（按 lastActiveAt 判断）。
   * 注意：index.js 现在用的是更严格的 purgeBlankRooms（只有「空房」才提前回收，
   * 有内容的房间靠 IDLE_ROOM_TTL 兜底），这里保留给外部调用 / 测试用。
   */
  gcStale(emptyAgeMs) {
    const now = Date.now();
    const ids = [];
    for (const [id, room] of this.rooms) {
      if (room.online > 0) continue;
      if (now - (room.lastActiveAt || 0) > emptyAgeMs) {
        ids.push(id);
        this.drop(id);
      }
    }
    return ids;
  }

  markDirty(room) {
    room.dirty = true;
    if (this.saveTimers.has(room.id)) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(room.id);
      try { this.save(room); } catch (e) { console.error('[store] save failed', room.id, e.message); }
    }, 1500);
    t.unref && t.unref();
    this.saveTimers.set(room.id, t);
  }

  save(room) {
    if (!room.dirty || room.dropped || !this.rooms.has(room.id)) return;
    const dir = this.roomDir(room.id);
    fs.mkdirSync(dir, { recursive: true });

    const layers = room.layers.map(l => {
      const copy = Object.assign({}, l);
      if (l.baseImage) {
        try {
          const b64 = l.baseImage.split(',')[1] || '';
          fs.writeFileSync(path.join(dir, 'base_' + l.id + '.png'), Buffer.from(b64, 'base64'));
          copy.baseImageFile = 'base_' + l.id + '.png';
        } catch (e) { /* ignore */ }
      }
      delete copy.baseImage;
      return copy;
    });

    const payload = {
      version: P.PROTOCOL_VERSION,
      schema: ROOM_SCHEMA,
      id: room.id, name: room.name, width: room.width, height: room.height,
      background: room.background, ownerId: room.ownerId, ownerName: room.ownerName,
      password: room.password, createdAt: room.createdAt, lastActiveAt: room.lastActiveAt,
      seq: room.seq, layers, strokes: room.strokes,
      // 表情图不落盘（一张最多 300KB，会把 room.json 撑爆）；重启后退化成文字占位
      chat: room.chat.slice(-40).map(m => m.img
        ? { id: m.id, userId: m.userId, name: m.name, color: m.color, ts: m.ts, text: m.text || '［表情］' }
        : m)
    };
    const tmp = path.join(dir, 'room.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, path.join(dir, 'room.json'));
    room.dirty = false;
  }

  saveAll() {
    for (const room of this.rooms.values()) {
      try { this.save(room); } catch (e) { /* ignore */ }
    }
  }

  loadAll() {
    let entries = [];
    try { entries = fs.readdirSync(this.dataDir, { withFileTypes: true }); } catch (e) { return; }
    let orphans = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.dataDir, e.name);
      const file = path.join(dir, 'room.json');
      // 没有 room.json 的目录（写盘写了一半、手工删过文件…）永远不会被载入，
      // 也就永远不会被 GC 回收——顺手清掉，免得存档目录里越积越多僵尸目录。
      if (!fs.existsSync(file)) {
        if (rmTree(dir)) orphans++;
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.schema !== ROOM_SCHEMA) {
          // 旧结构存档：不载入并直接清掉，避免脏数据长期堆积
          rmTree(dir);
          continue;
        }
        const layers = (data.layers || []).map(l => {
          const copy = Object.assign({}, l);
          if (l.baseImageFile) {
            const f = path.join(dir, l.baseImageFile);
            if (fs.existsSync(f)) {
              copy.baseImage = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
            }
          }
          delete copy.baseImageFile;
          return copy;
        });
        const room = new Room(Object.assign({}, data, { id: e.name, layers, members: undefined }));
        room.members = new Map();
        room.dirty = false;
        this.rooms.set(room.id, room);
      } catch (err) {
        console.error('[store] load failed', e.name, err.message);
      }
    }
    if (orphans) console.log('[store] 清理了 ' + orphans + ' 个孤儿存档目录');
    if (this.rooms.size) console.log('[store] 已载入 ' + this.rooms.size + ' 个房间存档');
  }
}

module.exports = { Room, RoomStore, rmTree, MAX_STROKES_PER_ROOM, MAX_CHAT, MAX_ROOM_STROKE_BYTES, ROOM_SCHEMA };
