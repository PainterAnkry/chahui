/**
 * 茶绘 · 通信协议（服务端 / 客户端共用，单一来源）
 * 由 tools/sync-protocol.js 复制到 server/src/ 与 client/renderer/
 *
 * v2 变更（对照 SAI2 的笔刷 / 图层能力）：
 *   - 笔迹携带完整笔刷参数（硬度、最小直径、笔压映射、水彩边缘、散布、颗粒、混合模式、seed、对称）
 *   - 图层支持混合模式与「保护不透明度」
 *   - 新增图层复制 / 清除 / 向下合并 / 合并可见
 *
 * v3 变更（对照 SAI2 基本笔刷与面板）：
 *   - 工具集补齐 SAI2 基本笔刷：选区笔 / 选区擦 / 渐变 / 涂抹
 *   - 笔刷新增「纸纹比例 grainScale」与「纸张质感 paper / 特殊效果 fx」
 *   - 图层混合模式扩充到 SAI2 的完整列表
 *   - 聊天支持表情图（img，dataURL）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CHAPROTO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL_VERSION = 3;

  // 客户端 -> 服务端
  var C2S = {
    HELLO: 'hello',              // { name, avatar, roomId? }
    ROOM_LIST: 'room:list',
    ROOM_CREATE: 'room:create',  // { name, width, height, background }
    ROOM_JOIN: 'room:join',      // { roomId, user, password }
    ROOM_LEAVE: 'room:leave',
    ROOM_INFO: 'room:info',      // { name?, background? } 房主可改
    ROOM_COMPRESS: 'room:compress', // { pngs, upToSeq } 固化底图，裁剪历史
    ROOM_DESTROY: 'room:destroy',   // 房主解散房间
    ROOM_RESIZE: 'room:resize',    // { width, height } 房主调整画布分辨率
    ROOM_DEL: 'room:del',         // { roomId } 删除空房（房主可删自己的，任何人可删空房）
    ROOM_GC: 'room:gc',           // 一次性清掉所有「没人在线」的空房，回 ROOM_LIST

    STROKE_BEGIN: 'stroke:begin',   // { id, layerId, tool, color, size, opacity, seed, ...brush }
    STROKE_POINTS: 'stroke:points', // { id, pts: [[x,y,p], ...] }
    STROKE_END: 'stroke:end',       // { id }
    STROKE_CANCEL: 'stroke:cancel', // { id }
    STROKE_UNDO: 'stroke:undo',     // { ids: [] }
    STROKE_REDO: 'stroke:redo',     // { stroke }
    STROKE_CLEAR: 'stroke:clear',   // { scope: 'layer'|'all', layerId? }

    LAYER_ADD: 'layer:add',         // { name, at? }
    LAYER_DEL: 'layer:del',         // { layerId }
    LAYER_UPD: 'layer:upd',         // { layerId, patch }
    LAYER_MOVE: 'layer:move',       // { layerId, to }
    LAYER_DUP: 'layer:dup',         // { layerId, png } 复制图层（像素由客户端渲染）
    LAYER_CLEAR: 'layer:clear',     // { layerId } 清除图层内容
    LAYER_PIXELS: 'layer:pixels',   // { layerId, png, upToSeq } 用客户端渲染好的像素整体替换图层
    LAYER_MERGE: 'layer:merge',     // { srcId, dstId, png } 向下合并（结果像素由客户端渲染）
    LAYER_FLATTEN: 'layer:flatten', // { png, name? } 合并可见图层为一层

    CHAT: 'chat',                   // { text, img? }
    CURSOR: 'cursor',               // { x, y, active, tool }
    RESYNC: 'resync',
    PING: 'ping'                    // { at }
  };

  // 服务端 -> 客户端
  var S2C = {
    HELLO_OK: 'hello:ok',        // { you, serverVersion, rooms, limits, connId }
    OK: 'ok',                    // { ok, ... } 通用成功回执（删除房间 / 清理空房等）
    ERROR: 'error',              // { code, message }
    ROOM_LIST: 'room:list',      // { rooms: [{id,name,online,strokes,createdAt}] }

    ROOM_JOINED: 'room:joined',  // { room, layers, members, chat, you, history }
    ROOM_LEFT: 'room:left',
    ROOM_DESTROYED: 'room:destroyed', // { by }
    ROOM_DELETED: 'room:deleted',   // { id, by } 房间被删除（房主/GC）
    ROOM_UPDATED: 'room:updated',// { patch }
    ROOM_RESIZED: 'room:resized', // { width, height } 画布尺寸变更，所有客户端重建引擎
    MEMBERS: 'members',          // { members: [...] }
    HISTORY_META: 'history:meta',// { baseImage, baseSeq, count, lastSeq }
    HISTORY_CHUNK: 'history:chunk', // { strokes, done }

    STROKE_BEGIN: 'stroke:begin',   // { stroke }
    STROKE_POINTS: 'stroke:points', // { id, pts }
    STROKE_END: 'stroke:end',       // { id, seq }
    STROKE_CANCEL: 'stroke:cancel', // { id }
    STROKE_REMOVED: 'stroke:removed',   // { ids, reason, scope?, layerId? }
    STROKE_ADDED: 'stroke:added',       // { stroke }
    LAYERS: 'layers',                   // { layers, baseImages? }
    CHAT: 'chat',                       // { id, userId, name, color, text, img?, ts }
    CURSOR: 'cursor',                   // { userId, x, y, active }
    PONG: 'pong'                        // { t0 }
  };

  var HISTORY_CHUNK_SIZE = 400;

  var DEFAULTS = {
    width: 1600,
    height: 1000,
    background: '#ffffff',
    roomName: '无名茶绘室'
  };

  // 用户配色（新成员按顺序取色）
  var USER_COLORS = [
    '#e8544f', '#f2994a', '#f2c94c', '#5fbf6a', '#4aa3c7',
    '#5b6ee1', '#9b51e0', '#e0568f', '#3fbfa8', '#8c6a4f'
  ];

  function userColor(i) { return USER_COLORS[i % USER_COLORS.length]; }

  function now() { return Date.now(); }

  function rid(prefix) {
    var s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    return (prefix ? prefix + '_' : '') + s;
  }

  // 点序列量化：保留 0.1 精度，压缩体积
  function q(v) { return Math.round(v * 10) / 10; }
  function qp(p) { return [q(p[0]), q(p[1]), Math.round((p[2] || 0) * 100) / 100]; }

  /**
   * 绘制工具：决定笔迹如何栅格化
   *   brush       普通笔刷（铅笔 / 喷枪 / 画笔 / 水彩笔 / 马克笔 / 特效笔 / 散布）
   *   eraser      橡皮
   *   blur        模糊
   *   smudge      涂抹（拖动像素）
   *   fill        油漆桶
   *   gradient    渐变
   *   select      选区笔（加选）
   *   selectErase 选区擦（减选）
   *   marquee     矩形框选
   *   lasso       套索（自由框选）
   *   wand        魔棒（按色差选连通区域）
   *   line/rect/ellipse  形状
   *   picker      吸管
   */
  var TOOLS = [
    'brush', 'eraser', 'blur', 'smudge', 'fill', 'gradient',
    'select', 'selectErase', 'marquee', 'lasso', 'wand',
    'line', 'rect', 'ellipse', 'picker'
  ];

  // 图层 / 画笔混合模式（画布端映射见 engine.js 的 BLEND_OPS）
  var BLEND_MODES = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'add', 'difference', 'exclusion', 'hard-light', 'soft-light',
    'color-dodge', 'color-burn', 'hue', 'saturation', 'color', 'luminosity'
  ];

  var BLEND_LABELS = {
    normal: '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加',
    darken: '变暗', lighten: '变亮', add: '加法',
    difference: '差值', exclusion: '排除', 'hard-light': '强光', 'soft-light': '柔光',
    'color-dodge': '颜色减淡', 'color-burn': '颜色加深',
    hue: '色相', saturation: '饱和度', color: '颜色', luminosity: '明度'
  };

  // 对称尺模式（以画布中心为轴）
  var SYMMETRY_MODES = ['none', 'x', 'y', 'xy'];

  // 纸张质感（颗粒纹理形态）
  var PAPERS = ['none', 'fine', 'coarse', 'canvas'];

  // 特殊效果（特效笔）
  var FX = ['none', 'waterdrop', 'noise', 'scatter'];

  // 笔刷参数默认值（服务端做范围约束，客户端做渲染）
  /**
   * 笔刷默认值。
   *
   * ⚠️ normalizeBrush 只输出这里出现过的字段 —— 往笔刷里加参数时**必须**在这里加一行，
   * 否则参数会被静默丢掉（选区加选用的 add/subtract 就在 newStroke 的白名单上丢过一次，
   * 表现是 Shift 加选退化成「替换」，页面不报错、很难查）。
   */
  var BRUSH_DEFAULTS = {
    size: 12,          // 笔尖直径（像素）
    opacity: 1,        // 笔迹浓度
    hardness: 0.9,     // 0 = 极柔边，1 = 硬边
    minSize: 0.2,      // 笔压最轻时的直径比例
    pressSize: 1,      // 笔压 -> 直径 的权重
    pressOpacity: 0,   // 笔压 -> 浓度 的权重
    edge: 0,           // 水彩边缘强度
    scatter: 0,        // 散布（点状抖散，噪点笔用）
    grain: 0,          // 颗粒（纸纹，铅笔用）
    grainScale: 1,     // 纸纹比例（0.2 = 细，4 = 粗）
    strength: 0.7,     // 模糊 / 涂抹强度
    tolerance: 32,     // 油漆桶色差范围
    expand: 0,         // 油漆桶扩大像素
    spacing: 0.1,      // 笔尖位图的落点间隔（占直径的比例），导入的 PS/CSP 笔刷用
    mix: 0,            // 混色：笔迹与「下面的颜色」融合的程度（SAI2 水彩笔的核心手感）
    tip: ''            // 笔尖位图（打包成 32x32x4:base64 的 4 位灰度小图）
  };

  // 笔尖位图字符串的形状与长度上限：32x32x4 打包后 base64 约 683 字符，
  // 留一倍余量。它会被逐笔写进房间历史，所以必须卡死。
  var TIP_RE = /^(\d{1,3})x(\d{1,3})x(\d{1,2}):([A-Za-z0-9+/]+={0,2})$/;
  var TIP_MAX_CHARS = 1600;
  function normalizeTip(v) {
    if (typeof v !== 'string' || !v || v.length > TIP_MAX_CHARS) return '';
    var m = TIP_RE.exec(v);
    if (!m) return '';
    var w = +m[1], h = +m[2], bits = +m[3];
    if (w < 2 || h < 2 || w > 128 || h > 128 || bits !== 4) return '';
    return v;
  }

  // 把任意来源的笔刷参数收敛到合法范围
  function clampNum(v, d, a, b) {
    var n = Number(v);
    if (!isFinite(n)) return d;
    if (n < a) return a;
    if (n > b) return b;
    return n;
  }

  function pickOne(list, v, d) {
    return list.indexOf(v) >= 0 ? v : d;
  }

  function normalizeBrush(src) {
    src = src || {};
    var out = {};
    out.size = Math.round(clampNum(src.size, BRUSH_DEFAULTS.size, 1, 400));
    out.opacity = clampNum(src.opacity, BRUSH_DEFAULTS.opacity, 0.02, 1);
    out.hardness = clampNum(src.hardness, BRUSH_DEFAULTS.hardness, 0, 1);
    out.minSize = clampNum(src.minSize, BRUSH_DEFAULTS.minSize, 0.02, 1);
    out.pressSize = clampNum(src.pressSize, BRUSH_DEFAULTS.pressSize, 0, 1);
    out.pressOpacity = clampNum(src.pressOpacity, BRUSH_DEFAULTS.pressOpacity, 0, 1);
    out.edge = clampNum(src.edge, BRUSH_DEFAULTS.edge, 0, 1);
    out.scatter = clampNum(src.scatter, BRUSH_DEFAULTS.scatter, 0, 1);
    out.grain = clampNum(src.grain, BRUSH_DEFAULTS.grain, 0, 1);
    out.grainScale = clampNum(src.grainScale, BRUSH_DEFAULTS.grainScale, 0.2, 4);
    out.strength = clampNum(src.strength, BRUSH_DEFAULTS.strength, 0.05, 1);
    out.tolerance = Math.round(clampNum(src.tolerance, BRUSH_DEFAULTS.tolerance, 1, 120));
    out.expand = Math.round(clampNum(src.expand, BRUSH_DEFAULTS.expand, 0, 12));
    out.paper = pickOne(PAPERS, src.paper, 'none');
    out.fx = pickOne(FX, src.fx, 'none');
    out.blend = pickOne(BLEND_MODES, src.blend, 'normal');
    out.sym = pickOne(SYMMETRY_MODES, src.sym, 'none');
    out.brush = typeof src.brush === 'string' ? src.brush.slice(0, 24) : '';
    out.filled = !!src.filled;
    out.spacing = clampNum(src.spacing, BRUSH_DEFAULTS.spacing, 0.02, 1);
    out.mix = clampNum(src.mix, BRUSH_DEFAULTS.mix, 0, 1);
    out.tip = normalizeTip(src.tip);
    out.seed = Math.floor(clampNum(src.seed, 0, 0, 2147483646));
    return out;
  }

  // 随机种子：散布 / 颗粒等需要「所有客户端结果一致」的随机性由它驱动
  function newSeed() { return Math.floor(Math.random() * 2147483646); }

  // 表情图（聊天用）：只接受内联图片，且限制体积
  var STICKER_MAX = 320 * 1024;      // 单张上限（base64 前）
  var STICKER_RAW_MAX = 220 * 1024;  // 解码后字节上限
  // 只放行位图（svg 不在此列：虽然 <img> 里的 svg 不会执行脚本，但没必要开这个口子）
  var STICKER_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

  function normalizeSticker(img) {
    if (typeof img !== 'string') return '';
    if (img.length > STICKER_MAX) return '';
    if (!STICKER_RE.test(img)) return '';
    var b64 = img.slice(img.indexOf(',') + 1);
    var pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    var bytes = Math.floor(b64.length * 3 / 4) - pad;
    if (bytes > STICKER_RAW_MAX) return '';
    return img;
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    C2S: C2S,
    S2C: S2C,
    DEFAULTS: DEFAULTS,
    HISTORY_CHUNK_SIZE: HISTORY_CHUNK_SIZE,
    USER_COLORS: USER_COLORS,
    TOOLS: TOOLS,
    BLEND_MODES: BLEND_MODES,
    BLEND_LABELS: BLEND_LABELS,
    SYMMETRY_MODES: SYMMETRY_MODES,
    PAPERS: PAPERS,
    FX: FX,
    BRUSH_DEFAULTS: BRUSH_DEFAULTS,
    STICKER_MAX: STICKER_MAX,
    STICKER_RAW_MAX: STICKER_RAW_MAX,
    userColor: userColor,
    now: now,
    rid: rid,
    q: q,
    qp: qp,
    normalizeBrush: normalizeBrush,
    normalizeSticker: normalizeSticker,
    newSeed: newSeed
  };
});
