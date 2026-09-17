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
 *
 * v4 变更（你画我猜）：
 *   - 房间多出一个「游戏模式」：房主开局后由服务端主持回合制对局
 *   - 答案只私发给画手（S2C.GAME_WORD），其他人永远收不到明文
 *   - 游戏模式下的聊天即「猜词」：服务端先比对答案，再决定广播什么
 *   - 回合进行中只有画手能落笔（服务端强制，不是前端禁用）
 *
 * v5 变更（你画我猜完善）：
 *   - 作画过半还没人猜出时，服务端自动「露一个字」当提示（走 GAME_STATE 的 hint 字段）
 *   - 画手在选词阶段可以「换一组」候选词（C2S.GAME_REPICK，每回合限次）
 *   - isNearGuess 不再把单字答案判成「很接近」——一个字的答案没有「接近」可言
 *
 * v6 变更（接龙模式 + 主题词库）：
 *   - 新增 game mode：'classic'（你画我猜，默认）/'chain'（接龙）。开局时由房主选
 *   - 接龙的每一步只把「上家的产物」发给当事者（看图猜词 / 给词作画），见 S2C.GAME_TASK
 *   - 接龙状态里有 chains（整条链的匿名化进度）与 replay（回放用），都由 snapshotFor 裁剪
 *   - 回放后投票（C2S.GAME_VOTE）决定「起词的人」拿不拿奖杯；奖杯累计 = 该玩家的分数
 *   - 词库分主题：默认 / 明日方舟 / 鸣潮 / 碧蓝档案（C2S.GAME_START 的 theme）
 *
 * v7 变更（更多主题 + 自定义词库 + 音效 + 投票动画）：
 *   - 主题扩到 15 套（原神 / 星铁 / 终末地 / 东方 / 赛马娘 / 绝区零 / 怪猎 / 美食 / 动物 / 物品）
 *   - 自定义词库支持用户在界面上自建（HTTP /api/themes，不是实时协议），
 *     增删改后服务端广播 S2C.GAME_THEMES 让所有人的下拉框立刻更新
 *   - 音效是纯前端的（WebAudio 合成，见 client/renderer/sfx.js），协议不变
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CHAPROTO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL_VERSION = 7;

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

    MEMBER_ROLE: 'member:role',     // { userId, readonly } —— 仅房主；只读观众只能看不能改
    LAYER_ADD: 'layer:add',         // { name, at?, id?, groupId? } id 由客户端指定（服务端校验格式与冲突）
    LAYER_DEL: 'layer:del',         // { layerId }
    LAYER_UPD: 'layer:upd',         // { layerId, patch }
    LAYER_MOVE: 'layer:move',       // { layerId, to } 在**自己所属的那一组范围内**移动
    LAYER_DUP: 'layer:dup',         // { layerId, png } 复制图层（像素由客户端渲染）
    LAYER_CLEAR: 'layer:clear',     // { layerId } 清除图层内容
    LAYER_PIXELS: 'layer:pixels',   // { layerId, png, upToSeq } 用客户端渲染好的像素整体替换图层
    LAYER_MERGE: 'layer:merge',     // { srcId, dstId, png } 向下合并（结果像素由客户端渲染）
    LAYER_FLATTEN: 'layer:flatten', // { png, name? } 合并可见图层为一层

    // ---- 图层组 ----
    // 组本身没有像素，它只是一条「怎么把子图层合到一起」的规则（不透明度 + 混合模式）。
    // 不变式：**同一组的图层在 room.layers 里永远连续**。组没有独立的位置，
    // 「组在哪」= 「它那一块在哪」。下面几条消息都负责维持这条不变式，
    // 页面/测试都可以拿它当断言用（见 tools/test-groups.js）。
    GROUP_ADD: 'group:add',         // { id, name, layerId? } 新建组；给了 layerId 就顺手把它放进去
    GROUP_UPD: 'group:upd',         // { groupId, patch } 改名 / 显隐 / 不透明度 / 混合模式 / 折叠
    GROUP_DEL: 'group:del',         // { groupId, withLayers? } 默认是**解散组**（图层留在原位）
    GROUP_MOVE: 'group:move',       // { groupId, dir: 1|-1 } 整组（连同组内所有图层）上移 / 下移一格
    LAYER_GROUP: 'layer:group',     // { layerId, groupId } 把图层挪进某组；groupId 为 null 表示移出组

    // ---- 工程文件（.chahu）装载：分片传，避开单条 12MB 的 ws 上限 ----
    // 三条一起构成一次原子替换：收齐之前房间内容不变，收不齐就整批丢弃。
    // 只允许房主，且只应该在刚建好的空房里用（会把现有图层和笔迹全部换掉）。
    PROJECT_BEGIN: 'project:begin', // { count } 开始装载，服务端开暂存区
    PROJECT_LAYER: 'project:layer', // { index, name, visible, opacity, locked, alphaLock, blend, png }
    PROJECT_END: 'project:end',     // {} 收齐后整体替换房间文档

    CHAT: 'chat',                   // { text, img? } —— 游戏中时 text 会被当成猜词
    CURSOR: 'cursor',               // { x, y, active, tool }
    RESYNC: 'resync',
    PING: 'ping',                   // { at }

    // ---- 你画我猜（mode='classic'）----
    GAME_START: 'game:start',       // { rounds?, mode?, theme? } 房主开局
    GAME_STOP: 'game:stop',         // 房主结束本局（回到自由绘画）
    GAME_PICK: 'game:pick',         // { index } 画手从候选词里挑一个
    GAME_REPICK: 'game:repick',     // 画手换一组候选词（每回合限次，见 GAME.REPICK_LIMIT）

    // ---- 接龙（mode='chain'）----
    // 一轮 = 每人各做一步（画或猜），链条逐步往前走。所有裁定都在服务端。
    GAME_SUBMIT: 'game:submit',     // { text, index? } 写词（带 index 表示选了第几个候选）/ 猜词
    GAME_ART: 'game:art',           // { png } 作画那一步的成品（客户端渲染好回传，服务端只存）
    GAME_VOTE: 'game:vote',         // { chainId, agree } 这条链首尾对得上吗（票匿名）
    GAME_NEXT: 'game:next'          // 房主提前推进：跳过没交的人 / 立刻结算投票
  };

  // 服务端 -> 客户端
  var S2C = {
    HELLO_OK: 'hello:ok',        // { you, serverVersion, rooms, limits, connId }
    OK: 'ok',                    // { ok, ... } 通用成功回执（删除房间 / 清理空房等）
    ERROR: 'error',              // { code, message }
    ROOM_LIST: 'room:list',      // { rooms: [{id,name,online,strokes,createdAt}] }

    ROOM_JOINED: 'room:joined',  // { room, layers, groups, members, chat, you, history }
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
    LAYERS: 'layers',                   // { layers, groups, baseImages? } 图层表与组表总是成对下发
    CHAT: 'chat',                       // { id, userId, name, color, text, img?, ts }
    CURSOR: 'cursor',                   // { userId, x, y, active }
    PONG: 'pong',                       // { t0 }

    // ---- 你画我猜 ----
    // 只有这三条是真正会发出去的。回合结算与最终排名都并进 GAME_STATE（靠 phase 变化触发），
    // 不另外开消息 —— 少一条消息就少一处「前端接了个永远不触发的 handler」。
    // GAME_STATE 是「按收件人裁剪过」的完整快照：猜手拿到的版本里没有 word 字段。
    GAME_STATE: 'game:state',           // { game }  含 phase / wordLen / deadline / roundResult / scores
    GAME_WORD: 'game:word',             // { word, choices? } 只发给画手
    GAME_CORRECT: 'game:correct',       // { userId, name, rank, points } 有人猜对了

    // ---- 接龙 ----
    // 接龙的快照同样按收件人裁剪：你在猜的时候只能看到「上家那幅画」，
    // 绝不能看到词；结束前也拿不到别人的图（否则把后面几步的答案都看完了）。
    GAME_TASK: 'game:task',             // { task } 只发给我：这一步要我做什么（词 / 别人的画）
    GAME_THEMES: 'game:themes'          // { themes } 主题菜单变了（有人建/改/删了自定义词库）
  };

  var HISTORY_CHUNK_SIZE = 400;

  var DEFAULTS = {
    width: 1600,
    height: 1000,
    background: '#ffffff',
    roomName: '无名茶绘室'
  };

  /**
   * 你画我猜的参数。**时长与计分全部以服务端为准** ——
   * 客户端只拿 deadline 做倒计时显示，不参与裁定。
   */
  var GAME = {
    MIN_PLAYERS: 2,          // 少于两人开不了局
    MAX_ROUNDS: 20,
    DEFAULT_ROUNDS: 6,       // 默认打 6 回合（每人当一次画手，人数多于回合数则轮流）
    CHOICES: 3,              // 选词时给画手几个候选
    PICK_MS: 20000,          // 选词时限
    ROUND_MS: 80000,         // 每回合作画时限
    ROUND_END_MS: 6000,      // 回合结算展示时长
    // 第 1、2、3… 个猜对的人分别得多少分（超出的按最后一档）
    GUESS_POINTS: [100, 80, 60, 50, 40],
    // 画手：每被猜出一个词得多少分（防止「故意画得没人猜得出」）
    DRAWER_POINT_PER_GUESS: 20,
    NEAR_DISTANCE: 1,        // 编辑距离 ≤ 这个值就提示「接近了」（不判定为对）
    MAX_GUESS_LEN: 40,       // 猜词长度上限（超过直接当普通聊天）
    // 作画过半还没人猜出时露一个字当提示。少于 HINT_MIN_LEN 个字的答案不给
    // —— 两个字露一个等于给一半，反而没意思了
    HINT_RATIO: 0.5,
    HINT_MIN_LEN: 3,
    REPICK_LIMIT: 1,         // 选词阶段画手可以「换一组」几次
    // 作画时长可以按房自定义（开局设置），单位秒 —— 环境变量压的是全局默认，
    // 这个是「这一局」的覆盖值。限个范围，免得 3 秒一回合或者挂机三小时
    DRAW_SECONDS_DEFAULT: 80,   // = ROUND_MS / 1000
    DRAW_SECONDS_MIN: 30,
    DRAW_SECONDS_MAX: 300,

    /* ---- 接龙模式（mode = 'chain'）----
     * 链条：每人起一个词 → 下一人照画猜词 → 再下一人照词作画…… 绕圈推进。
     * 一圈 = 每人都做过一步；走完 ROUNDS_PER_CHAIN 圈后进回放与投票。
     */
    CHAIN_MIN_PLAYERS: 4,    // 少于 4 人链条太短，玩不出「越传越离谱」的效果
    CHAIN_MAX_PLAYERS: 16,
    CHAIN_ROUNDS: 3,         // 每条链走几圈。3 圈 = 词→画→词，正好是一轮完整的「起词 / 作画 / 猜词」，
                             // 也是最能看出「越传越离谱」的最短长度（2 圈只有词→画，还没人猜过）
    CHAIN_MAX_ROUNDS: 6,
    CHAIN_PICK_CHOICES: 3,   // 开局给每个起词的人几个候选
    CHAIN_WRITE_MS: 60000,   // 起词 / 猜词一步的时限（打字不用那么久）
    CHAIN_DRAW_MS: 120000,   // 作画一步的时限（比经典模式宽松，因为只有一幅参考图）
    CHAIN_REPLAY_MS: 90000,  // 回放 + 投票的总时限
    CHAIN_MAX_GUESS_LEN: 20, // 单步猜词长度上限
    CHAIN_TROPHY_AGREE: 1    // 首尾「对得上」时，起词的人拿几个奖杯
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
    'line', 'rect', 'ellipse', 'picker',
    // 文字：作为一种笔迹走既有通道（同步 / 撤销 / 回放都是现成的）
    // 漏了这一行，newStroke 会把 tool 归一化成 brush，文字就画不出来了
    'text',
    'liquify'
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

  /**
   * 文字笔迹的字段。文字**不是**新的图层类型，而是一种特殊笔迹 ——
   * 这样它天然跟着笔迹历史走：能同步、能撤销、能回放，不用另造一套机制。
   * 三种字体族只放行常见的几个，避免有人塞一个别人机器上没有的字体，
   * 那会让两端渲染得不一样。
   */
  var TEXT_MAX = 2000;
  var FONT_FAMILIES = ['sans', 'serif', 'mono', 'kai', 'hei', 'song'];
  function normalizeText(v) {
    if (typeof v !== 'string') return '';
    // 去掉控制字符（换行留着）
    return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, TEXT_MAX);
  }
  function normalizeFontFamily(v) {
    return FONT_FAMILIES.indexOf(v) >= 0 ? v : 'sans';
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

  /**
   * 猜词归一化：比较答案之前先把「看起来不一样、其实是同一个词」的差异抹平。
   *
   * 处理：全角转半角、去空白、去常见标点、统一小写。
   * 不做同义词 / 繁简转换 —— 那需要词表，属于后期的事。
   */
  function normGuess(s) {
    if (typeof s !== 'string') return '';
    var t = s.trim().toLowerCase();
    // 全角 ASCII（！到～）转半角
    t = t.replace(/[\uff01-\uff5e]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
    t = t.replace(/\u3000/g, ' ');
    // 空白 + 中英文常见标点
    t = t.replace(/[\s.,!?;:'"`~^&*_\-+=<>|/\\()[\]{}·、。，！？；：""''《》〈〉【】（）…—]/g, '');
    return t;
  }

  /** Levenshtein 编辑距离（只用来提示「接近了」，不参与判定） */
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur = [i];
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** 猜得「很接近」但不对：给个提示，别让玩家干瞪眼 */
  function isNearGuess(guess, answer) {
    var g = normGuess(guess), w = normGuess(answer);
    if (!g || !w || g === w) return false;
    // 一个字的答案没有「接近」可言：任何一个字与它的编辑距离都是 1，
    // 不拦掉的话猜什么都会回一句「很接近了」，等于谎报兼泄题
    if (w.length < 2) return false;
    if (Math.abs(g.length - w.length) > GAME.NEAR_DISTANCE + 1) return false;
    return editDistance(g, w) <= GAME.NEAR_DISTANCE;
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    C2S: C2S,
    S2C: S2C,
    DEFAULTS: DEFAULTS,
    GAME: GAME,
    HISTORY_CHUNK_SIZE: HISTORY_CHUNK_SIZE,
    USER_COLORS: USER_COLORS,
    TOOLS: TOOLS,
    BLEND_MODES: BLEND_MODES,
    BLEND_LABELS: BLEND_LABELS,
    SYMMETRY_MODES: SYMMETRY_MODES,
    PAPERS: PAPERS,
    FX: FX,
    BRUSH_DEFAULTS: BRUSH_DEFAULTS,
    TEXT_MAX: TEXT_MAX,
    FONT_FAMILIES: FONT_FAMILIES,
    normalizeText: normalizeText,
    normalizeFontFamily: normalizeFontFamily,
    STICKER_MAX: STICKER_MAX,
    STICKER_RAW_MAX: STICKER_RAW_MAX,
    userColor: userColor,
    now: now,
    rid: rid,
    q: q,
    qp: qp,
    normalizeBrush: normalizeBrush,
    normalizeSticker: normalizeSticker,
    normGuess: normGuess,
    editDistance: editDistance,
    isNearGuess: isNearGuess,
    newSeed: newSeed
  };
});
