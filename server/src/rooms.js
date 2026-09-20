'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const P = require('./protocol');

const MAX_STROKES_PER_ROOM = 60000;
const MAX_CHAT = 300;
const MAX_ROOM_STROKE_BYTES = 24 * 1024 * 1024; // 房间历史（不含底图）序列化上限
const ROOM_SCHEMA = 3;                          // 存档结构版本：旧版本存档在启动时清理

/**
 * 待删目录的中转站（rooms/.trash）。
 *
 * drop() 不能同步删目录：rmSync 在 Windows 上遇到被占用的文件会同步重试，
 * 实测单个房间能堵住事件循环近 1 秒，而 drop() 是在处理 WebSocket 消息时调用的
 * —— 一堵就是整个房间的笔迹 / 心跳 / 房间列表全部卡住。
 * 所以改成「先把目录 rename 进 .trash（只改目录项，毫秒级），再异步删」，
 * 这样即使进程当场被杀，房间也不会被 loadAll() 重新载回来。
 */
const TRASH_DIR = '.trash';

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

/**
 * 待删目录队列：串行 + 轻量删除。
 *
 * 为什么要串行、为什么不做多层兜底重试：
 * fs 操作和 zlib 压缩共用 libuv 线程池（默认 4 个线程）。一次 GC 可能产生
 * 十几个待删目录，如果并发 + 逐个反复重试，线程池会被占满，连 WebSocket
 * 消息的压缩都要排队 —— 客户端看到的就是「消息明显延迟」。
 *
 * 而 .trash 里的目录已经不在存档命名空间内了（loadAll 会跳过 `.` 开头的目录），
 * 删不掉也不会让房间复活，下次启动 purgeTrash 会再试。所以这里删一次就够了。
 */
const _rmQueue = [];
let _rmBusy = false;

function rmTreeQueued(dir, onDone) {
  _rmQueue.push({ dir, onDone });
  _pumpRmQueue();
}

function _pumpRmQueue() {
  if (_rmBusy) return;
  const job = _rmQueue.shift();
  if (!job) return;
  _rmBusy = true;
  fsp.rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 })
    .then(() => { if (job.onDone) job.onDone(true); })
    .catch(() => { if (job.onDone) job.onDone(false); })
    .then(() => {
      _rmBusy = false;
      _pumpRmQueue();
    });
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
    // 所属图层组（null = 不在任何组里）
    groupId: meta.groupId || null,
    baseImage: meta.baseImage || null,
    baseSeq: meta.baseSeq || 0,
    /**
     * 图层蒙版。null = 这一层没有蒙版。
     * 有蒙版时是一张与画布同尺寸的 PNG，**用它的 alpha 表示「该处显示多少」**
     * （不透明 = 全显示，透明 = 全隐藏）—— 正好对上 PSD 的蒙版语义，
     * 渲染时一句 destination-in 就能套上去。
     *
     * 平时在蒙版上涂抹是**笔迹**（带 target='mask'），跟着笔迹历史一起同步 / 撤销 / 回放；
     * maskImage 只在「蒙版不是画出来的」场合出现：工程文件装载、PSD 导入、房间固化。
     */
    hasMask: !!meta.hasMask || !!meta.maskImage,
    maskImage: meta.maskImage || null,
    maskSeq: meta.maskSeq || 0,
    // 有蒙版但临时关掉时不参与合成（蒙版本身留着，随时可以再打开）
    maskEnabled: meta.maskEnabled !== false,
    // 剪贴蒙版：只在「它下面那一层」的不透明区域里显示。最底下那层设了也没有东西可剪，等于普通层。
    clip: !!meta.clip
  };
}

function newGroup(meta) {
  meta = meta || {};
  return {
    id: meta.id || P.rid('G'),
    name: meta.name || '组',
    visible: meta.visible !== false,
    opacity: typeof meta.opacity === 'number' ? clamp(meta.opacity, 0, 1) : 1,
    blend: P.BLEND_MODES.indexOf(meta.blend) >= 0 ? meta.blend : 'normal',
    collapsed: !!meta.collapsed
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

    /**
     * 图层组。组**没有像素**，它只是一条「子图层怎么合到一起」的规则
     * （组自己的不透明度 + 混合模式），所以它不占 layers 里的位置。
     *
     * **不变式：同一组的图层在 this.layers 里永远连续。**
     * 「组在哪」= 「它那一块在哪」。所有结构变更收尾都跑一次 normalizeGroups()
     * 来维持这条 —— 页面和测试都可以拿它当断言用。
     */
    this.groups = (meta.groups || []).map(g => newGroup(g));
    this.normalizeGroups();

    this.strokes = meta.strokes || []; // 按 seq 升序
    this.chat = meta.chat || [];
    this.members = new Map(); // connId -> member
    this.dirty = false;
    /**
     * 你画我猜的状态机（见 game.js），**刻意不落盘**。
     * save() 是显式拼 payload 的，所以这里挂了也不会被写进 room.json ——
     * 服务端一重启就是一局结束，不会出现「半局游戏」这种脏状态。
     */
    this.game = null;
    /**
     * 工程文件装载的暂存区（PROJECT_BEGIN / PROJECT_LAYER / PROJECT_END）。
     * 同样**刻意不落盘**：服务端重启时装载本来就是中断的，留着半份图层表只会更脏。
     */
    this.projectLoad = null;
    /**
     * 房主的「本局游戏预设」（C2S.GAME_PREFS 清洗后的那一份，见 game-prefs.js）。
     * 与 projectLoad 同一个规矩：**挂在房间上、不落盘、不进 meta()/summary()**。
     * 房间列表页不需要它（那是给房间内的设置面板看的），所以 summary() 也不带。
     * 时机：房主改设置就更新；GAME_START 成功 / GAME_STOP 清空；换房主只换 by。
     */
    this.pendingGame = null;
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

  /**
   * 工程文件装载：把房间文档整体换成传进来的图层表（原子的一步，由 PROJECT_END 调用）。
   *
   * 每层的像素直接当作它的底图，笔迹历史清空 —— 工程文件里存的是**固化成像素的成品**，
   * 不是可重放的笔迹，所以装载完的房间里 history 是空的。这是**有意的**：
   * 跨房间搬几千条笔迹既慢又没意义（撤销栈本来就不跨会话），搬 N 张 PNG 快得多。
   *
   * @param {Array} layers 每个元素 { name, visible, opacity, locked, alphaLock, blend, groupId, png }
   * @param {number} seq 装载后房间的 seq 水位，同时作为各层 baseSeq（必须 > 0，见 layerIsSolo）
   * @param {Array} [groups] 图层组表；引用了不存在的组会被这里清掉（组表缺失时不会留下半个悬空引用）
   */
  loadProject(layers, seq, groups) {
    this.seq = seq;
    this.strokes = [];
    this.groups = (groups || []).map(g => newGroup(g));
    this.layers = layers.map(l => newLayer({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      locked: l.locked,
      alphaLock: l.alphaLock,
      blend: l.blend,
      groupId: l.groupId,
      baseImage: isPng(l.png) ? l.png : null,
      baseSeq: seq,
      // 蒙版与剪贴也会跟着工程文件 / PSD 导入一起过来。
      // maskImage 是「不是画出来的」那张蒙版的像素，maskSeq 记下它是哪一档水位 ——
      // 否则客户端重放历史时会把 baseSeq 之前的蒙版笔迹又涂一遍。
      hasMask: isPng(l.maskPng),
      maskImage: isPng(l.maskPng) ? l.maskPng : null,
      maskSeq: seq,
      maskEnabled: l.maskEnabled !== false,
      clip: !!l.clip
    }));
    this.normalizeGroups();
    this.lastActiveAt = Date.now();
    return this.layers.length;
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
      // 房间列表上标一个「游戏中」的小标签，别让人一头雾水地闯进别人的对局
      game: this.game && this.game.active ? this.game.phase : 'off',
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
      blend: l.blend, groupId: l.groupId, baseSeq: l.baseSeq,
      // 蒙版状态。**必须逐个列出** —— 这份白名单是 LAYERS 广播的唯一出口，
      // 漏一个字段就是「服务端存下了、客户端永远收不到」。
      hasMask: !!l.hasMask, maskSeq: l.maskSeq || 0,
      maskEnabled: l.maskEnabled !== false, clip: !!l.clip
    }));
  }

  groupList() {
    return this.groups.map(g => ({
      id: g.id, name: g.name, visible: g.visible, opacity: g.opacity,
      blend: g.blend, collapsed: g.collapsed,
      count: this.layers.reduce((n, l) => n + (l.groupId === g.id ? 1 : 0), 0)
    }));
  }

  /** 仅保留含底图的图层映射（合并 / 复制 / 固化后回传给客户端） */
  baseImageMap() {
    const o = {};
    for (const l of this.layers) if (l.baseImage) o[l.id] = l.baseImage;
    return o;
  }

  /** 同上，蒙版那一份。大多数房间这里是空的（蒙版平时靠笔迹重建），只有导入/固化后才有 */
  maskImageMap() {
    const o = {};
    for (const l of this.layers) if (l.maskImage) o[l.id] = l.maskImage;
    return o;
  }

  memberList() {
    return Array.from(this.members.values()).map(m => ({
      userId: m.userId, name: m.name, color: m.color,
      // 头像（内联小图，可能是空串）。**必须在这里列出** —— 这份白名单是
      // MEMBERS 广播的唯一出口，漏一个字段就是「客户端发得出去、别人永远收不到」。
      avatar: m.avatar || '',
      isOwner: m.userId === this.ownerId, drawing: !!m.drawing,
      // 只读观众（房主设置）：能看、能聊，但不能改画布上的任何东西
      readonly: !!m.readonly
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

  /**
   * 新建图层。
   * @param {string} [name]
   * @param {number} [at]   插入位置，默认追加到末尾
   * @param {string} [id]   客户端指定的图层 id（调用方须先校验格式与冲突）。
   *   「文字图层」和「粘贴」都要「先建层、再往里写像素 / 笔迹」，
   *   客户端必须提前知道 id 才能一次到位 —— 见 index.js 的 LAYER_ADD。
   * @param {string} [groupId] 直接建在某个组里（放在该组最顶上）
   */
  addLayer(name, at, id, groupId) {
    const g = groupId ? this.getGroup(groupId) : null;
    const l = newLayer({
      id,
      name: name || ('图层 ' + (this.layers.length + 1)),
      groupId: g ? g.id : null
    });
    const idx = (typeof at === 'number' && at >= 0 && at <= this.layers.length) ? at : this.layers.length;
    this.layers.splice(idx, 0, l);
    // 建在组里的层要落到那一块里，光靠 splice 的位置不一定连续
    if (g) this.normalizeGroups();
    this.dirty = true;
    return l;
  }

  delLayer(id) {
    if (this.layers.length <= 1) return null;
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return null;
    const [l] = this.layers.splice(i, 1);
    this.strokes = this.strokes.filter(s => s.layerId !== id);
    // 删掉组里最后一个图层时，那个组也就没地方待了（normalizeGroups 会收掉它）
    this.normalizeGroups();
    this.dirty = true;
    return l;
  }

  moveLayer(id, to) {
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    let lo = 0, hi = this.layers.length - 1;
    // 组内图层只能在本组那一块里上下挪，要出组请走 LAYER_GROUP。
    // 少了这道夹取，「上移」一下就能把一块组打成两段 ——
    // 合成时同一组会被当成两个单元，组的不透明度就叠了两遍。
    const l0 = this.layers[i];
    if (l0.groupId && this.getGroup(l0.groupId)) {
      const span = this.groupSpan(l0.groupId);
      if (span) { lo = span[0]; hi = span[1]; }
    }
    to = clamp(to, lo, hi);
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
    if (typeof patch.hasMask === 'boolean') l.hasMask = patch.hasMask;
    if (typeof patch.maskEnabled === 'boolean') l.maskEnabled = patch.maskEnabled;
    if (typeof patch.clip === 'boolean') l.clip = patch.clip;
    this.dirty = true;
    return l;
  }

  // ---- 图层组 ----

  getGroup(id) { return this.groups.find(g => g.id === id); }

  /** 某组在 this.layers 里的连续区间 [起, 止]；不在表里或没有成员时返回 null */
  groupSpan(id) {
    const i = this.layers.findIndex(l => l.groupId === id);
    if (i < 0) return null;
    let j = i;
    while (j + 1 < this.layers.length && this.layers[j + 1].groupId === id) j++;
    return [i, j];
  }

  /**
   * 把 this.layers 重排成「单元序列」：普通图层各自一个单元，同一组的图层合成一个单元。
   * 单元内部、单元之间的相对顺序都不变 —— 对本来就合法的数据是**恒等变换**，
   * 对不合法的数据（组被打散、groupId 悬空）则顺手修正。所有结构变更收尾都跑它。
   */
  normalizeGroups() {
    const known = new Set(this.groups.map(g => g.id));
    const out = [], done = new Set();
    for (const l of this.layers) {
      const gid = l.groupId;
      if (gid && known.has(gid)) {
        if (done.has(gid)) continue;
        done.add(gid);
        for (const m of this.layers) if (m.groupId === gid) out.push(m);
      } else {
        l.groupId = null;
        out.push(l);
      }
    }
    this.layers = out;
    // 一个成员都没有的组没有容身之处（它没有位置可言），收掉
    const before = this.groups.length;
    this.groups = this.groups.filter(g => this.layers.some(l => l.groupId === g.id));
    if (this.groups.length !== before) this.dirty = true;
    return this;
  }

  /**
   * 新建图层组。
   * @param {object} meta { id, name } —— id 由客户端指定（同 LAYER_ADD，调用方先校验格式与冲突）
   * @param {string} [layerId] 顺手放进组的图层；组必须有成员，所以通常都要给
   */
  addGroup(meta, layerId) {
    const g = newGroup(meta);
    this.groups.push(g);
    const l = layerId ? this.getLayer(layerId) : null;
    if (l) l.groupId = g.id;
    this.normalizeGroups();
    this.dirty = true;
    return g;
  }

  updGroup(id, patch) {
    const g = this.getGroup(id);
    if (!g) return null;
    if (typeof patch.name === 'string') g.name = patch.name.slice(0, 24) || g.name;
    if (typeof patch.visible === 'boolean') g.visible = patch.visible;
    if (typeof patch.collapsed === 'boolean') g.collapsed = patch.collapsed;
    if (typeof patch.opacity === 'number') g.opacity = clamp(patch.opacity, 0, 1);
    if (P.BLEND_MODES.indexOf(patch.blend) >= 0) g.blend = patch.blend;
    this.dirty = true;
    return g;
  }

  /**
   * 解散组（图层留在原位）或连组内图层一起删掉。
   * 解散不只是「拆开分组」：组不透明度 / 混合模式的那层效果会一起消失，
   * 画面是会变的 —— 所以调用方对它和对删除一视同仁（组里有别人的成果就得房主）。
   */
  delGroup(id, withLayers) {
    const g = this.getGroup(id);
    if (!g) return null;
    const members = this.layers.filter(l => l.groupId === id);
    if (withLayers && this.layers.length - members.length < 1) {
      return { error: 'last_layer', message: '至少要保留一个图层' };
    }
    if (withLayers) {
      const ids = new Set(members.map(l => l.id));
      this.layers = this.layers.filter(l => !ids.has(l.id));
      this.strokes = this.strokes.filter(s => !ids.has(s.layerId));
    } else {
      for (const m of members) m.groupId = null;
    }
    this.groups = this.groups.filter(x => x.id !== id);
    this.normalizeGroups();
    this.dirty = true;
    return { group: g, removed: withLayers ? members.map(l => l.id) : [] };
  }

  /** 整组（连同组内所有图层）上移 / 下移一格：和自己相邻的那个「单元」换个位置 */
  moveGroup(id, dir) {
    const span = this.groupSpan(id);
    if (!span) return false;
    const [i, j] = span;
    const len = j - i + 1;
    if (dir > 0) {
      if (j + 1 >= this.layers.length) return false;
      const above = this.layers[j + 1];
      const aboveSpan = (above.groupId && above.groupId !== id)
        ? this.groupSpan(above.groupId) : [j + 1, j + 1];
      const block = this.layers.splice(i, len);
      this.layers.splice(aboveSpan[1] - len + 1, 0, ...block);
    } else {
      if (i - 1 < 0) return false;
      const below = this.layers[i - 1];
      const belowSpan = (below.groupId && below.groupId !== id)
        ? this.groupSpan(below.groupId) : [i - 1, i - 1];
      const block = this.layers.splice(i, len);
      this.layers.splice(belowSpan[0], 0, ...block);
    }
    this.normalizeGroups();
    this.dirty = true;
    return true;
  }

  /**
   * 把图层挪进某组（落在该组最顶上）；groupId 为 null 或无效则移出组。
   * 移出后停在原组那一块的上方 —— 「刚才把它拖出来」最符合直觉的落点。
   */
  setLayerGroup(layerId, groupId) {
    const l = this.getLayer(layerId);
    if (!l) return false;
    const g = groupId ? this.getGroup(groupId) : null;
    if (groupId && !g) return false;
    const i = this.layers.indexOf(l);
    if (i < 0) return false;
    // 先摘出来再算落点：留着它自己会把它那一块的位置算歪
    this.layers.splice(i, 1);
    const oldGid = l.groupId;
    l.groupId = g ? g.id : null;
    const span = g ? this.groupSpan(g.id) : (oldGid ? this.groupSpan(oldGid) : null);
    const at = span ? span[1] + 1 : Math.min(i, this.layers.length);
    this.layers.splice(at, 0, l);
    this.normalizeGroups();
    this.dirty = true;
    return true;
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
      // 组里复制的副本留在同一个组里 —— 否则副本会掉到组外面，
      // 一会儿被组的不透明度带着变淡、一会儿又不受影响，看着像随机
      groupId: src.groupId,
      baseImage: isPng(png) ? png : null,
      baseSeq: upToSeq || this.seq,
      // 蒙版和剪贴跟着副本一起走。复制的像素（png）里本来就已经套过蒙版了，
      // 但**蒙版本身**是独立的一层数据：不给副本的话，用户拿蒙版一改，
      // 原图会变、副本不会变 —— 看着像「复制出来的图层不听话」。
      // visible / locked 不复制：副本默认可见、不锁，这是复制图层的惯例。
      hasMask: !!src.hasMask,
      maskImage: src.maskImage || null,
      maskSeq: upToSeq || this.seq,
      maskEnabled: src.maskEnabled !== false,
      clip: !!src.clip
    });
    this.layers.splice(i + 1, 0, copy);
    if (src.groupId) this.normalizeGroups();
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
    this.normalizeGroups();
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
    // 合并成一层的世界里没有组可言
    this.groups = [];
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

  /** 该组是否只包含此用户的成果（解散 / 删除组的破坏性判定用） */
  groupIsSolo(id, userId) {
    const members = this.layers.filter(l => l.groupId === id);
    if (!members.length) return true;
    return members.every(l => this.layerIsSolo(l.id, userId));
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
    const trashed = this.purgeTrash();
    if (trashed) console.log('[store] 清理了 ' + trashed + ' 个待删存档目录');
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
    this.rooms.delete(id);   // 内存里立刻消失：房间列表、广播马上就是最新状态

    // 磁盘目录：rename 进 .trash（毫秒级，不阻塞），再交给异步删除收拾。
    // rename 失败（目录不存在 / 被占用）就退化成直接在原地异步删。
    const dir = this.roomDir(id);
    const trashRoot = path.join(this.dataDir, TRASH_DIR);
    const trash = path.join(trashRoot, id + '_' + Date.now().toString(36));
    let target = dir;
    try {
      fs.mkdirSync(trashRoot, { recursive: true });
      fs.renameSync(dir, trash);
      target = trash;
    } catch (e) { /* 目录本来就不存在，或句柄被占用：原地异步删 */ }

    setImmediate(() => {
      rmTreeQueued(target, (gone) => {
        if (!gone) console.error('[store] 目录删不掉，可能是文件被占用（已移出存档目录）：' + target);
      });
    });
  }

  /** 清掉上次退出时残留在 .trash 里的目录（启动时后台做，不阻塞；删不掉就留着下次再试） */
  purgeTrash() {
    const trashRoot = path.join(this.dataDir, TRASH_DIR);
    let entries = [];
    try { entries = fs.readdirSync(trashRoot, { withFileTypes: true }); } catch (e) { return 0; }
    let n = 0;
    for (const e of entries) {
      n++;
      rmTreeQueued(path.join(trashRoot, e.name));
    }
    return n;
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
      // 蒙版跟底图一样拆出来单独存文件 —— 塞进 room.json 会把那个文件撑到几十 MB
      if (l.maskImage) {
        try {
          const mb64 = l.maskImage.split(',')[1] || '';
          fs.writeFileSync(path.join(dir, 'mask_' + l.id + '.png'), Buffer.from(mb64, 'base64'));
          copy.maskImageFile = 'mask_' + l.id + '.png';
        } catch (e) { /* ignore */ }
      }
      delete copy.maskImage;
      return copy;
    });

    const payload = {
      version: P.PROTOCOL_VERSION,
      schema: ROOM_SCHEMA,
      id: room.id, name: room.name, width: room.width, height: room.height,
      background: room.background, ownerId: room.ownerId, ownerName: room.ownerName,
      password: room.password, createdAt: room.createdAt, lastActiveAt: room.lastActiveAt,
      seq: room.seq, layers, groups: room.groups, strokes: room.strokes,
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
      if (!e.isDirectory() || e.name.charAt(0) === '.') continue;
      const dir = path.join(this.dataDir, e.name);
      const file = path.join(dir, 'room.json');
      // 没有 room.json 的目录（写盘写了一半、手工删过文件…）永远不会被载入，
      // 也就永远不会被 GC 回收——顺手清掉，免得存档目录里越积越多僵尸目录。
      // 注意用异步删除：启动时同步 rmSync 十几个目录能把服务端卡住十几秒。
      if (!fs.existsSync(file)) {
        orphans++;
        rmTreeQueued(dir);
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.schema !== ROOM_SCHEMA) {
          // 旧结构存档：不载入并直接清掉，避免脏数据长期堆积
          rmTreeQueued(dir);
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
          if (l.maskImageFile) {
            const mf = path.join(dir, l.maskImageFile);
            if (fs.existsSync(mf)) {
              copy.maskImage = 'data:image/png;base64,' + fs.readFileSync(mf).toString('base64');
            }
          }
          delete copy.baseImageFile;
          delete copy.maskImageFile;
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

module.exports = { Room, RoomStore, rmTree, rmTreeQueued, MAX_STROKES_PER_ROOM, MAX_CHAT, MAX_ROOM_STROKE_BYTES, ROOM_SCHEMA };
