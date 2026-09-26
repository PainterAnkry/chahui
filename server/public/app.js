/**
 * 茶绘 · 桌面端主逻辑
 * 负责：UI 渲染、指针交互、与服务端同步、回放 / 录制 / 导出
 *
 * v2：接入 SAI2 风格笔刷体系（预设 + 参数面板 + 色轮）、图层混合 / 保护不透明度 /
 *     复制 / 合并、画布旋转翻转、导航器、对称尺、网格。
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;
  var Cfg = global.ChaConfig;
  var Brushes = global.ChaBrushes;

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  var engine = new global.CanvasEngine();
  var net = new global.Net();
  // 游戏音效（WebAudio 合成，无音频文件）。sfx.js 没加载时退化成「什么都不响」，
  // 绝不能让整个 app 因为少一个脚本就崩掉。
  var SFX = global.ChaSFX || { play: function () {}, setEnabled: function () {}, isEnabled: function () { return false; }, toggle: function () {}, unlock: function () {} };

  /* ============================================================ 状态 */

  var S = {
    me: { userId: null, name: '', color: '#888', avatar: '', isOwner: false, readonly: false },
    // 图层面板里当前选中的「组」（null = 选中的是某个图层）。
    // 组和图层**共用**头顶栏（混合模式 / 不透明度）与那几个操作按钮，
    // 靠这个字段决定它们作用在谁身上 —— 见 selKind() / syncLayerHead()。
    selGroup: null,
    room: null,
    members: [],
    chat: [],
    myUndo: [],
    myRedo: [],
    joinCount: 0,
    // 正在进行的加入：带密码的房间输错时好把密码框弹回来
    pendingJoin: null,
    // 你画我猜：服务端推来的最新一份快照（已按我裁剪过 —— 猜手拿到的 word 恒为空）
    // skew 是「服务端时钟 - 本机时钟」，倒计时按它换算，免得各端显示不一致
    game: null,
    gameSkew: 0,
    gameRoundKey: '',     // 「第几回合 + 阶段」去重，用来判断要不要弹结算卡片
    gameWordShown: '',    // 已经提示过的词，避免每次状态同步都再弹一次
    hintKey: '',          // 已经响过提示音的「露字」去重键
    tickAt: -1,           // 倒计时音效已经响到第几秒（250ms 的定时器不能每次都响）
    // 接龙：这一步轮到我做什么（服务端 GAME_TASK 单发，只有我能收到）。
    // step 取值 'WORD' / 'DRAWING' / 'GUESS'（与协议一致的大写）。
    // 我拿到的是「答案」而不是「题面」时（作画/猜词那两步），聊天要闭嘴，免得剧透
    chainTask: null,
    // 接龙回放：S2C.GAME_REVEAL 广播一次（迟到者按 version 补发）。
    // 数据只在 REVEAL/VOTE/SCORE 阶段存在，播放器在这份数据上翻页。
    chainReveal: null,
    // 接龙回放播放器：当前第几条链 / 第几格、自动播放、速度、翻格定时器。
    // v9 起回放是「逐格播」而不是「一屏摊开」——所以客户端要一个自己的小状态机。
    // v10：chain 只跟着服务端的 voteChainIndex / voteChainId 走（一条链一条链串行），
    //      客户端不能自己翻到别的链上去 —— chainId 用来判断「服务端换链了没有」。
    cr: {
      chain: 0, chainId: '', item: 0, playing: false, speed: 1, timer: null,
      // 服务端回放游标（revealStep）：变了才切格 —— 「现在第几格」以服务端为准
      serverStep: null,
      // 逐笔动画状态：生成号 gen —— 换格时 +1，旧的帧回调 / 兜底定时器对不上就自己退出
      anim: {
        chain: -1, item: -1, gen: 1, raf: 0, tickTimer: 0, safety: 0, strokes: null, done: 0, frame: 0,
        startAt: 0, animMs: 0, dur: 0, finished: false, landedAt: 0, framesAll: 0, pics: [], steps: 0,
        // ★ v15：这一格画完之后要不要接「下一棒猜的是什么」的悬念倒计时（作画格 + 下一格是猜词）
        tease: false
      },
      // ★ v15：悬念倒计时的读数状态（2/1 秒各响一声，数到 1 就停在那儿等下一格）
      teaseTimer: 0, teaseLeft: 0, teaseName: '',
      // ★ v16：画面是不是被「接龙回放」接管了（接管时引擎的 replayCanvas = 逐笔帧画布，
      //   回放画在真画布上；canvasPrev 记着接管前引擎原本的回放状态，退出时还回去）
      canvasOwner: '', canvasPrev: null,
      // 投票那排标记的记账：已见到的票数（用来判断「多了一票」→ 响一声）、
      // 以及我自己刚投票的时刻（自己那一下已经响过 voteStamp，不再叠 voteLand）
      voteSeen: 0, myVoteAt: 0,
      // 猜词期画布上的那幅画是猜题流程摆的（回放别去动它的词条窄带）
      externalImg: false,
      // 用户回放前快捷条是不是展开的（回放期间自动收起来，结束要还原）
      qbWasOpen: null
    },
    chainInputSubmitted: false, // 输入框已提交（挡住重复提交 + 显示「已提交」）
    chainTaskToast: '',       // 「轮到你…」通知去重（同一圈同一步只弹一次）
    themes: null,             // 主题列表（{id,name}），从 /api/share 或快照拿
    // /api/share 的整份回包。开局面板的「默认（80 秒）」标签、可选档位、
    // 每个玩法的人数上下限都按它算 —— 服务端用 GAME_* 环境变量压过计时的话，
    // 光看 shared/protocol.js 的常量会标错。
    shareCfg: null,
    // 房主广播的开局预设（S2C.GAME_PREFS，服务端刚落地）。非房主用它**只读**显示
    // 面板：开局前就能看见「房主设置的当前配置」，不用在聊天里问。
    gamePrefs: null,
    // 画皮：我的身份（服务端 SKIN_ROLE 单发，只有我能收到）。
    // **绝不能从 S.game 里读身份** —— 那条是广播快照，里面压根没有这个字段。
    skinRole: null,
    // 画皮：夜里的裁定（SKIN_NIGHT 单发）。预言家拿到的是验人结果，
    // 被刀的人拿到的是「你走了」。天亮面板要显示它，所以缓存下来。
    skinNight: null,
    skinDrawnSubmitted: false, // 本轮画已交（挡住重复提交）
    skinRoleToast: '',        // 「你的身份是…」通知去重
    skinVotePick: '',         // 画廊里当前点选的投票对象
    skinPrevPhase: '',        // 上一帧的 phase（按阶段播报用）
    skinPrevRound: -1,
    skinTaskToast: '',        // 画皮的「该你动手」提示去重
    skinReveal: null,         // 结算时的真相表（服务端 <SKIN_ROLE>:all 广播）
    skinViewer: null,         // 点开的大图（元素引用）
    tool: 'brush',
    color: '#2b2b2b',
    bgColor: '#ffffff',
    brushId: 'pencil',
    brush: {},
    overrides: {},
    // 工具 → 最近使用的条目 id（切换工具时回到上次用的笔刷）
    lastOfFamily: { brush: 'pencil', eraser: 'eraser', blur: 'blur', smudge: 'smudge', fill: 'bucket', gradient: 'gradient', select: 'select', selectErase: 'selectErase', line: 'line', rect: 'rect', ellipse: 'ellipse', picker: 'picker' },
    toolPrefs: null,          // { order: [id], hidden: [id] }
    toolEdit: false,
    imported: [],             // 导入的笔刷（PS .abr / CSP .sut），存 localStorage
    // 协作视图：别人的笔迹在本机显示得多淡（纯本地，见「他人笔触」那一段）
    dimMode: 'off',           // 'off' | 'soft' | 'faint' | 'hide'
    dimUsers: {},             // userId -> 0..1，成员面板里单独设的
    antsOn: true,             // 是否显示选区蚂蚁线（菜单里可勾）
    text: { fontFamily: 'sans', fontSize: 48, lineHeight: 1.35 },   // 文字工具的上次设置
    textAt: null,             // 文字要放在画布的哪个位置
    leftPanelOpen: true,      // 左侧整列面板是否显示
    sideCollapsed: lsGet('chahu.side', '1') === '0',   // 右侧聊天 / 成员 / 笔迹栏是否收起
    narrow: false,            // 当前是不是窄屏布局（左右栏变抽屉，见 applyLayoutMode）
    pinch: null,              // 触屏双指手势的上一帧状态（{ midX, midY, dist }）
    touchPts: null,           // 触屏按下的指针集合（pointerId -> 坐标）
    gridOn: false,
    uiScale: 1,
    importPending: null,      // 导入对话框里待确认的笔刷
    stickers: [],             // 自定义表情（dataURL）
    stickerManaging: false,
    pressure: lsGet('chahu.pressure', '1') === '1',
    // 最近一次可信的笔压（起笔那一下 Chrome 常给占位值 0.5，用它兜底）
    lastPressure: 0.5,
    // 压感自检结果：null=还没测到 / 'pen'=正常 / 'guess'=被驱动报成鼠标但识别为笔 / 'none'=没有压感
    penDetect: null,
    stabilize: Number(lsGet('chahu.stabilize', '0')) || 0,
    sym: P.SYMMETRY_MODES.indexOf(lsGet('chahu.sym', 'none')) >= 0 ? lsGet('chahu.sym', 'none') : 'none',
    // 画笔光标样式：auto（大笔刷圆环 / 小笔刷十字）、ring（始终圆环）、cross（始终十字）
    cursorStyle: ['auto', 'ring', 'cross'].indexOf(lsGet('chahu.cursor', 'auto')) >= 0 ? lsGet('chahu.cursor', 'auto') : 'auto',
    recent: [],
    hue: 0, sv: { s: 1, v: 1 },
    // 色轮取色区形状（'square' 默认 / 'triangle'），记住上次的选择
    svShape: loadSvShape(),
    publicUrl: '',            // 服务端开了公网隧道时由 /api/share 带回
    // 桌面端「公网联机」的状态（主进程推过来）：off / downloading / starting / on
    tunnel: { phase: 'off', url: '', error: '', percent: 0 },
    lanUrls: [],
    session: null,
    pan: null,
    spaceDown: false,
    altDown: false,
    cursors: new Map(),
    historyQueue: [],
    historyTotal: 0,
    historyDraining: false,
    replay: { playing: false, t: 0, speed: 4, raf: null, last: 0 },
    // 回放洋葱皮：把前后各几笔染成残影。纯本机显示（不上传、不进文档），偏好跟着人走
    onionOn: lsGet('chahu.onion', '0') === '1',
    onionCount: Math.min(3, Math.max(1, parseInt(lsGet('chahu.onion.n', '1'), 10) || 1)),
    recording: null,
    joined: false,
    lastSent: 0,
    transformDragging: false,
    modShift: false,
    modAlt: false,
    // 框选 / 套索 / 魔棒画完之后自动弹出变换面板（用户反馈第 2 条）
    autoTransform: lsGet('chahu.autoTransform', '1') !== '0',
    // ★ 2.0.9 魔棒选项（照 SAI2 的魔棒面板）：取样模式 / 透明容差 / 防止溢出 / 取样来源 / 消除锯齿 / 忽略已选
    //   下面那一块（WAND_DEFAULTS + loadWandOpts）定义在 S 之后，所以这里先占位、随后再填。
    wand: null,
    // 统一撤销栈：笔迹 / 选区 / 变换等像素操作按发生顺序排在一起，
    // 这样「撤回」才能真正撤回上一步，而不是只认笔迹。
    opUndo: [],
    opRedo: [],
    // 选区快照的容量上限（dataURL 张数），太小会撤不回几步，太大吃内存
    maxSelSnapshots: 20,
    navOpen: true,
    navThumbAt: 0,
    pointer: { sx: 0, sy: 0, dx: 0, dy: 0, inside: false }
  };

  try {
    var raw = JSON.parse(lsGet('chahu.brushes', '{}'));
    if (raw && typeof raw === 'object') S.overrides = raw;
  } catch (e) { S.overrides = {}; }

  /* ---- ★ 2.0.9 魔棒选项（SAI2 那张「魔棒」面板，逐项都有实际作用） ----
   * 存在 localStorage 里跟着人走：取样模式 / 透明容差 / 防止溢出范围 /
   * 取样来源 / 消除锯齿 / 忽略已选择的区域。色差范围复用画笔的 tolerance 滑块。 */
  var WAND_DEFAULTS = {
    mode: 'wrap',       // wrap=被线条包围的透明区域 / diff=色差范围内的区域 / diffAll=色差范围内的全部像素
    transTol: 19,       // 透明容差范围（SAI2 出场值就是 19）
    bleed: 0,           // 防止溢出范围（px）
    source: 'layer',    // layer=当前图层 / sample=指定为选区样本的图层 / merged=拼合图像
    aa: true,           // 消除锯齿
    ignore: false       // 忽略已选择的区域
  };
  var WAND_MODES = ['wrap', 'diff', 'diffAll'];
  var WAND_SOURCES = ['layer', 'sample', 'merged'];
  var WAND_MODE_LABEL = {
    wrap: '被线条包围的透明区域', diff: '色差范围内的区域', diffAll: '色差范围内的全部像素'
  };
  function loadWandOpts() {
    var o = Object.assign({}, WAND_DEFAULTS);
    try {
      var raw = JSON.parse(lsGet('chahu.wand', '{}'));
      if (raw && typeof raw === 'object') {
        if (WAND_MODES.indexOf(raw.mode) >= 0) o.mode = raw.mode;
        if (WAND_SOURCES.indexOf(raw.source) >= 0) o.source = raw.source;
        if (typeof raw.transTol === 'number' && isFinite(raw.transTol)) o.transTol = clamp(Math.round(raw.transTol), 0, 255);
        if (typeof raw.bleed === 'number' && isFinite(raw.bleed)) o.bleed = clamp(Math.round(raw.bleed), 0, 20);
        if (typeof raw.aa === 'boolean') o.aa = raw.aa;
        if (typeof raw.ignore === 'boolean') o.ignore = raw.ignore;
      }
    } catch (e) { /* 坏了就用出场值 */ }
    return o;
  }
  function saveWandOpts() {
    lsSet('chahu.wand', JSON.stringify(S.wand));
  }
  S.wand = loadWandOpts();

  try {
    var st = JSON.parse(lsGet('chahu.stickers', '[]'));
    if (Array.isArray(st)) S.stickers = st.filter(function (s) { return typeof s === 'string'; }).slice(0, 60);
  } catch (e) { S.stickers = []; }

  /* ============================================================ 通用 UI */

  function toast(msg, kind, ms) {
    var wrap = $('#toastWrap');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 2600);
  }

  /**
   * 自定义确认对话框（替换 window.confirm，在 Electron 桌面端不可用时也能用）。
   * 之所以不能直接用 window.confirm：contextIsolation: true 的渲染进程里 confirm
   * 会被禁用，调用返回 undefined —— 直接早退，于是按钮看起来"没反应"。
   */
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mask = $('#confirmMask');
      var title = $('#confirmTitle');
      var body = $('#confirmBody');
      var yes = $('#confirmYes');
      var no = $('#confirmNo');
      if (!mask) { resolve(true); return; }
      title.textContent = opts.title || '请确认';
      body.textContent = message;
      yes.textContent = opts.yes || '确定';
      no.textContent = opts.no || '取消';
      yes.classList.toggle('danger', !!opts.danger);
      mask.classList.remove('hidden');
      function done(ok) {
        mask.classList.add('hidden');
        yes.removeEventListener('click', yesFn);
        no.removeEventListener('click', noFn);
        mask.removeEventListener('click', maskFn);
        document.removeEventListener('keydown', keyFn);
        resolve(ok);
      }
      var yesFn = function () { done(true); };
      var noFn = function () { done(false); };
      var maskFn = function (e) { if (e.target === mask) done(false); };
      var keyFn = function (e) {
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter') done(true);
      };
      yes.addEventListener('click', yesFn);
      no.addEventListener('click', noFn);
      mask.addEventListener('click', maskFn);
      document.addEventListener('keydown', keyFn);
      setTimeout(function () { yes.focus(); }, 30);
    });
  }

  function setStatus(text) { $('#statusText').textContent = text; }

  function download(name, dataUrl) {
    if (global.chahuDesktop && global.chahuDesktop.saveFile) {
      global.chahuDesktop.saveFile(name, dataUrl).then(function (r) {
        if (r && r.ok) toast('已保存到 ' + r.path, 'ok');
        else if (r && r.canceled) toast('已取消保存');
        else toast('保存失败：' + ((r && r.error) || '未知错误'), 'err');
      });
      return;
    }
    var a = document.createElement('a');
    a.href = dataUrl; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 100);
    toast('已开始下载 ' + name, 'ok');
  }

  function stampName() {
    var d = new Date();
    return '茶绘-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /* ============================================================ 笔刷 */

  function loadBrush(id) {
    var item = Brushes.get(id) || Brushes.ITEMS[0];
    S.brushId = item.id;
    S.brush = Brushes.resolveParams(item, S.overrides);
    S.brush.sym = S.sym;
    S.tool = item.tool;
    S.lastOfFamily[item.tool] = item.id;
    renderToolGrid();
    syncBrushUI();
    syncParamRows();
    setToolButtons();
    updateBrushLabel();
    drawBrushPreview();
    // 窄屏里左栏是盖在画布上的抽屉：选完这一笔就把抽屉收掉，别挡着刚腾出来的画布
    autoCloseLeftDrawer();
  }

  /* ---------------------------------------------------------- 工具栏（可自定义） */

  function loadToolPrefs() {
    var def = {
      order: Brushes.ITEMS.map(function (i) { return i.id; }),
      hidden: []
    };
    var raw = null;
    try { raw = JSON.parse(lsGet('chahu.tools', 'null')); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.order)) { S.toolPrefs = def; return; }
    var known = {};
    Brushes.ITEMS.forEach(function (i) { known[i.id] = true; });
    var order = raw.order.filter(function (id) { return known[id]; });
    // 新增的条目自动补到末尾
    def.order.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    var hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(function (id) { return known[id]; });
    S.toolPrefs = { order: order, hidden: hidden };
  }

  function saveToolPrefs() {
    lsSet('chahu.tools', JSON.stringify(S.toolPrefs));
  }

  /* ============================================================ 协作视图
   *
   * 两件事，都是**纯本机显示**，不同步、不改文档：
   *   1. 别人的笔迹淡一点 / 直接藏起来（画布上人多的时候，一眼分清哪笔是自己的）
   *   2. 图层「只对我隐藏」（看底稿用，别人那边不受影响，导出也照样包含）
   *
   * ⚠ 有个天然边界要跟用户讲清楚：笔迹一旦被「固化底图 / 合并可见图层 /
   * 变换 / 滤镜」处理过，那些像素就变成图层底图了，**再也分不出是谁画的**，
   * 只能整层隐藏。所以「他人笔触」只对还没固化的笔迹生效。
   */
  var DIM_KEY = 'chahu.dimOthers';
  var DIM_USERS_KEY = 'chahu.dimUsers';
  var DIM_STEPS = [
    { id: 'off', label: '原样', tip: '别人画的和自己画的一样清楚' },
    { id: 'soft', label: '淡', tip: '别人的笔迹 45% 透明度' },
    { id: 'faint', label: '很淡', tip: '别人的笔迹 14% 透明度，几乎只剩自己的' },
    { id: 'hide', label: '隐藏', tip: '只看自己的笔迹（对方还是看得见全部）' }
  ];

  function dimStep() {
    for (var i = 0; i < DIM_STEPS.length; i++) if (DIM_STEPS[i].id === S.dimMode) return DIM_STEPS[i];
    return DIM_STEPS[0];
  }

  function loadDimPrefs() {
    S.dimMode = lsGet(DIM_KEY, 'off');
    if (!DIM_STEPS.some(function (d) { return d.id === S.dimMode; })) S.dimMode = 'off';
    try {
      var raw = JSON.parse(lsGet(DIM_USERS_KEY, 'null'));
      S.dimUsers = (raw && typeof raw === 'object') ? raw : {};
    } catch (e) { S.dimUsers = {}; }
  }

  /** 把当前的协作视图设置推给引擎 */
  function applyDimView() {
    engine.dimUsers = {};
    Object.keys(S.dimUsers).forEach(function (k) { engine.dimUsers[k] = S.dimUsers[k]; });
    engine.setDimMode(S.dimMode);
    updateDimUi();
  }

  function setDimMode(mode) {
    S.dimMode = mode;
    lsSet(DIM_KEY, mode);
    applyDimView();
    var st = dimStep();
    toast(mode === 'off' ? '他人笔触：原样显示' : '他人笔触：' + st.label, 'ok');
  }

  function cycleDimMode() {
    var i = DIM_STEPS.findIndex(function (d) { return d.id === S.dimMode; });
    setDimMode(DIM_STEPS[(i + 1) % DIM_STEPS.length].id);
  }

  /** 单独设某个人的笔迹透明度；alpha = null 表示恢复成「跟随全局档位」 */
  function setUserDim(userId, alpha) {
    if (alpha == null) delete S.dimUsers[userId];
    else S.dimUsers[userId] = alpha;
    lsSet(DIM_USERS_KEY, JSON.stringify(S.dimUsers));
    applyDimView();
  }

  function updateDimUi() {
    var btn = $('#qbDimOthers');
    if (btn) {
      var st = dimStep();
      btn.textContent = st.label;
      btn.classList.toggle('active', S.dimMode !== 'off');
      btn.title = '别人的笔迹在本机显示得多清楚：' + st.tip
        + '（只影响你自己的屏幕 —— 不影响导出，也不会同步给别人）';
    }
    renderMembers();
  }

  /** 「只对我隐藏」：跟同步的显示/隐藏分开，别人那边不受影响。图层组也走它 */
  function toggleLocalHidden(id) {
    var on = engine.toggleLocalHidden(id);
    var l = engine.getLayer(id);
    var g = l ? null : engine.getGroup(id);
    var nm = l ? l.name : (g ? g.name : '图层');
    toast('「' + nm + '」' + (on ? '只对你隐藏了（别人还看得见）' : '对你重新显示'));
    renderLayers();
  }

  function clearLocalHidden() {
    if (!engine.localHiddenCount()) { toast('没有被「只对我隐藏」的图层'); return; }
    engine.clearLocalHidden();
    renderLayers();
    toast('已取消「只对我隐藏」', 'ok');
  }

  /** 菜单：把「当前图层」在「只对我隐藏 / 显示」之间切换 */
  function toggleLocalHideActive() {
    var l = engine.activeLayer();
    if (!l) { toast('还没有图层', 'err'); return; }
    toggleLocalHidden(l.id);
  }

  var PANEL_DEFAULT_ORDER = ['nav', 'tools', 'brushes', 'brush', 'fx', 'color', 'layers'];

  function loadPanelOrder() {
    var raw = null;
    try { raw = JSON.parse(lsGet('chahu.panelOrder', 'null')); } catch (e) { raw = null; }
    if (!Array.isArray(raw) || !raw.length) return PANEL_DEFAULT_ORDER.slice();
    var valid = raw.filter(function (id) { return PANEL_DEFAULT_ORDER.indexOf(id) >= 0; });
    PANEL_DEFAULT_ORDER.forEach(function (id) { if (valid.indexOf(id) < 0) valid.push(id); });
    return valid;
  }

  var PANEL_SIDES = { left: 'left', right: 'right' };

  /** 每个小节现在住在哪一边（左栏 / 右栏），存本地 */
  function loadPanelSides() {
    var raw = null;
    try { raw = JSON.parse(lsGet('chahu.panelSides', 'null')); } catch (e) { raw = null; }
    var out = {};
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        if (PANEL_DEFAULT_ORDER.indexOf(k) >= 0 && PANEL_SIDES[raw[k]]) out[k] = raw[k];
      });
    }
    return out;
  }

  function panelContainers() {
    return [$('#leftPanelScroll'), $('#rightPanelScroll')].filter(Boolean);
  }

  /** 右栏里那个装小节的容器：空着的时候就收起来，别白占地方 */
  function updateRightScroll() {
    var rs = $('#rightPanelScroll');
    if (!rs) return;
    var n = rs.querySelectorAll('[data-section]').length;
    rs.classList.toggle('empty', n === 0);
  }

  /**
   * 按记住的顺序与归属摆放小节。
   * 归属可以是左边也可以是右边 —— 这就是「把一个小节拖到另一边去」的实现基础。
   */
  function applyPanelOrder() {
    var left = $('#leftPanelScroll');
    var right = $('#rightPanelScroll');
    if (!left || !right) return;
    var order = loadPanelOrder();
    var sides = loadPanelSides();
    var fragL = document.createDocumentFragment();
    var fragR = document.createDocumentFragment();
    order.forEach(function (id) {
      var sec = document.querySelector('[data-section="' + id + '"]');
      if (!sec) return;
      (sides[id] === 'right' ? fragR : fragL).appendChild(sec);
    });
    left.appendChild(fragL);
    right.appendChild(fragR);
    updateRightScroll();
  }

  function savePanelOrder() {
    var left = $('#leftPanelScroll');
    var right = $('#rightPanelScroll');
    var ids = [];
    var sides = {};
    function take(box, side) {
      if (!box) return;
      Array.prototype.forEach.call(box.querySelectorAll('[data-section]'), function (s) {
        var id = s.getAttribute('data-section');
        ids.push(id);
        sides[id] = side;
      });
    }
    take(left, 'left');
    take(right, 'right');
    lsSet('chahu.panelOrder', JSON.stringify(ids));
    lsSet('chahu.panelSides', JSON.stringify(sides));
    updateRightScroll();
  }

  /**
   * 小节拖动排序 —— **可以在左右两栏之间拖**。
   *
   * 以前只认左栏那一个容器，所以小节只能在左栏里上下挪；现在两个容器都是投放目标，
   * 拖到右栏（包括空着的右栏）就能把它搬过去，松手时按落点决定插在哪一段前面 / 后面。
   */
  function bindPanelDnD() {
    var leftScroll = $('#leftPanelScroll');
    if (!leftScroll) return;
    var resetBtn = $('#btnPanelReset');
    // 和菜单里「窗口 → 恢复默认面板布局」走同一段逻辑，免得两处行为不一致
    if (resetBtn) resetBtn.onclick = function () { resetPanels(); };

    var dragging = null, pointerId = null, autoTimer = null, autoDir = 0, dropBox = null;

    function clearMarks() {
      panelContainers().forEach(function (box) {
        box.classList.remove('panel-drop-target');
        Array.prototype.forEach.call(box.querySelectorAll('[data-section]'), function (s) {
          s.classList.remove('section-drop-before', 'section-drop-after');
        });
      });
      dropBox = null;
    }
    function stopAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      autoDir = 0;
    }
    function nearestSection(target) {
      while (target && target.nodeType === 1) {
        if (target.getAttribute && target.getAttribute('data-section')) return target;
        target = target.parentNode;
      }
      return null;
    }
    /** 落点所在的容器（用于判断是不是拖到了另一栏） */
    function containerOf(el) {
      var boxes = panelContainers();
      while (el && el.nodeType === 1) {
        if (boxes.indexOf(el) >= 0) return el;
        el = el.parentNode;
      }
      return null;
    }
    function hitTest(x, y) {
      var el = document.elementFromPoint(x, y);
      var sec = nearestSection(el);
      return { section: sec, box: sec ? containerOf(sec) : containerOf(el) };
    }
    function runAuto() {
      if (!autoDir || !dropBox) { stopAuto(); return; }
      dropBox.scrollTop += autoDir * 14;
    }
    function updateAuto(y) {
      var box = dropBox || leftScroll;
      var r = box.getBoundingClientRect();
      var dir = 0;
      if (y < r.top + 28) dir = -1;
      else if (y > r.bottom - 28) dir = 1;
      if (dir === autoDir) return;
      autoDir = dir;
      stopAuto();
      if (dir) autoTimer = setInterval(runAuto, 16);
    }

    // 整个小节标题栏都是把手；标题里的按钮照常可点
    function onDown(e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, input, select, a, textarea')) return;
      var h4 = t && t.closest ? t.closest('h4') : null;
      var grip = t && t.closest ? t.closest('.section-grip') : null;
      if (!h4 && !grip) return;
      var sec = (grip || h4).closest('[data-section]');
      if (!sec) return;
      e.preventDefault();
      dragging = sec;
      pointerId = e.pointerId;
      sec.classList.add('section-dragging');
      // 指针捕获挂在 document 上：拖到另一栏的时候事件还得继续来
      try { document.documentElement.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      document.body.classList.add('panel-dragging');
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      var hit = hitTest(e.clientX, e.clientY);
      dropBox = hit.box || dropBox;
      updateAuto(e.clientY);
      clearMarksKeepBox();
      if (hit.section && hit.section !== dragging) {
        var r = hit.section.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        hit.section.classList.add(before ? 'section-drop-before' : 'section-drop-after');
        dropBox = containerOf(hit.section);
      } else if (hit.box && !hit.box.querySelector('[data-section]')) {
        // 空容器：整个容器亮起来，表示「放进来就行」
        hit.box.classList.add('panel-drop-target');
        dropBox = hit.box;
      }
    }

    function clearMarksKeepBox() {
      panelContainers().forEach(function (box) {
        box.classList.remove('panel-drop-target');
        Array.prototype.forEach.call(box.querySelectorAll('[data-section]'), function (s) {
          s.classList.remove('section-drop-before', 'section-drop-after');
        });
      });
    }

    function finish(e) {
      if (!dragging || (e && e.pointerId != null && e.pointerId !== pointerId)) return;
      var hit = e ? hitTest(e.clientX, e.clientY) : null;
      var moved = false;
      if (hit && hit.section && hit.section !== dragging) {
        var box = containerOf(hit.section);
        var r = hit.section.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        if (box) {
          if (before) box.insertBefore(dragging, hit.section);
          else box.insertBefore(dragging, hit.section.nextSibling);
          moved = true;
        }
      } else if (hit && hit.box && !hit.box.querySelector('[data-section]')) {
        // 丢进空容器
        hit.box.appendChild(dragging);
        moved = true;
      }
      if (moved) {
        var toRight = containerOf(dragging) === $('#rightPanelScroll');
        savePanelOrder();
        renderToolGrid && renderToolGrid();
        engine.resize();
        var name = { nav: '导航器', tools: '工具栏', brushes: '笔刷栏', brush: '画笔', fx: '效果', color: '颜色', layers: '图层' };
        var id = dragging.getAttribute('data-section');
        toast('「' + (name[id] || id) + '」已移到' + (toRight ? '右侧栏' : '左栏'));
      }
      dragging.classList.remove('section-dragging');
      clearMarks();
      stopAuto();
      dragging = null;
      document.body.classList.remove('panel-dragging');
    }

    // 两个容器都要能起手（右栏里的小节也要能再拖回去）
    panelContainers().forEach(function (box) {
      box.addEventListener('pointerdown', onDown);
    });
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    window.addEventListener('blur', function () { if (dragging) finish(null); });
  }

  function visibleItems() {
    var p = S.toolPrefs;
    return p.order.filter(function (id) { return p.hidden.indexOf(id) < 0; })
      .map(function (id) { return Brushes.get(id); })
      .filter(Boolean);
  }

  /* ---------------------------------------------------------- 侧栏宽度拖动 */

  var COL_MIN = 190, COL_MAX = 520;   // 拖太窄按钮挤成一团，拖太宽画布就没了

  /* 窄屏阈值：和 styles.css 里「响应式」段落的 1080 必须一致（改一处要改两处）。
     到这里左右栏都不再占位，而是变成浮在画布上的抽屉。 */
  var NARROW_MQ = global.matchMedia ? global.matchMedia('(max-width: 1080px)') : null;

  /** 恢复上次的栏宽（存在 localStorage 里；开机时调一次） */
  function loadColumnWidths() {
    var raw = null;
    try { raw = JSON.parse(lsGet('chahu.colW', 'null')); } catch (e) { raw = null; }
    if (!raw) return;
    if (raw.left) setColW('left', raw.left);
    if (raw.right) setColW('right', raw.right);
  }
  function setColW(side, w) {
    var clamped = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(w)));
    document.documentElement.style.setProperty(side === 'left' ? '--left-w' : '--right-w', clamped + 'px');
    return clamped;
  }

  /**
   * 左右栏贴画布一侧各有一条 7px 的拖动条：按住横向拖就能调栏宽。
   * 宽度落在 CSS 变量 --left-w / --right-w 上（面板的 width 直接引用它们），
   * 拖完存 localStorage；拖动过程里画布跟着重排。
   */
  function bindColumnResizers() {
    loadColumnWidths();
    var raf = 0;
    function bind(el, side) {
      if (!el) return;
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();          // 别把这次按下交给小节拖拽 / 画布
        var panel = el.closest('.panel');
        var startW = panel ? panel.getBoundingClientRect().width : 0;
        var startX = e.clientX;
        el.classList.add('dragging');
        document.body.classList.add('col-resizing');
        el.setPointerCapture(e.pointerId);

        function onMove(ev) {
          // 左栏在画布左边：往右拖变宽；右栏相反
          var dx = ev.clientX - startX;
          var w = side === 'left' ? startW + dx : startW - dx;
          if (raf) return;
          raf = requestAnimationFrame(function () {
            raf = 0;
            setColW(side, w);
            engine.resize();
          });
        }
        function finish() {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', finish);
          el.removeEventListener('pointercancel', finish);
          el.classList.remove('dragging');
          document.body.classList.remove('col-resizing');
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          var panel2 = el.closest('.panel');
          if (panel2) {
            var save = { left: null, right: null };
            try { save = JSON.parse(lsGet('chahu.colW', '{}')) || {}; } catch (err2) { save = {}; }
            save[side] = Math.round(panel2.getBoundingClientRect().width);
            lsSet('chahu.colW', JSON.stringify(save));
          }
          engine.resize();
        }
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', finish);
      });
    }
    bind($('#leftResizer'), 'left');
    bind($('#rightResizer'), 'right');
  }

  /** 「工具栏」放工具，「笔刷栏」放笔刷 —— 和 SAI2 一样分开两栏 */
  function isBrushItem(it) { return it.type === 'brush'; }

  /**
   * 每支笔/每个工具**自己的**快捷键（按 item id，不再按 tool 家族）。
   * 右键任意格子可改键 / 清除，覆盖值存 localStorage['chahu.itemKeys']
   * （注意别用 'chahu.keys' —— 那是菜单栏命令的键位表，menu.js 在用）。
   * 清除（''）= 真的没有快捷键，不会回落到默认键（槽位数字键 1-9 仍按面板顺序可用）。
   * 'Alt' = 按住 Alt 临时取色（SAI 习惯，画布按下时生效，见 view pointerdown）。
   */
  var ITEM_KEYS_DEFAULT = {
    brush: 'B', eraser: 'E', blur: 'U', smudge: 'S',
    bucket: 'G', gradient: 'N', line: 'L', rect: 'R', ellipse: 'O',
    wand: 'W', picker: 'Alt',
    select: '', selectErase: ''   // 选区类不占字母键：Alt 要留给「减选」
  };
  var ITEM_KEYS = null;
  var ITEM_KEYS_STORE = 'chahu.itemKeys';

  function loadKeymap() {
    ITEM_KEYS = {};
    for (var id in ITEM_KEYS_DEFAULT) ITEM_KEYS[id] = ITEM_KEYS_DEFAULT[id];
    var raw = null;
    try { raw = JSON.parse(lsGet(ITEM_KEYS_STORE, 'null')); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      for (var k in raw) {
        // 内置 id 直接覆盖默认；导入笔刷的 id 也能存（首次设键时才出现在表里）
        if (k in ITEM_KEYS || Brushes.get(k)) ITEM_KEYS[k] = String(raw[k] || '');
      }
    }
  }
  function itemKey(id) {
    if (!ITEM_KEYS) loadKeymap();
    var v = ITEM_KEYS[id];
    return v === undefined ? '' : v;
  }
  function saveKeymap() {
    lsSet(ITEM_KEYS_STORE, JSON.stringify(ITEM_KEYS));
    renderToolGrid();
  }
  /** 按键找笔刷：只认当前面板上看得见的（收起的笔不吃键，避免「隐形抢键」） */
  function findItemByKey(key) {
    if (!key) return null;
    var vis = visibleItems();
    for (var i = 0; i < vis.length; i++) {
      if (itemKey(vis[i].id).toUpperCase() === key.toUpperCase()) return vis[i].id;
    }
    return null;
  }
  /** 格子角上的键位角标：字母/Alt 优先，没设键的笔刷显示槽位号 1-9 */
  function itemKeyBadge(it, list, isBrushList) {
    var k = itemKey(it.id);
    if (k) return k;
    if (isBrushList) {
      var i = list.indexOf(it);
      return i >= 0 && i < 9 ? String(i + 1) : '';
    }
    return '';
  }

  /**
   * 渲染一格工具/笔刷按钮。
   * 工具栏和笔刷栏共用这套渲染，也共用同一份顺序/显隐偏好（S.toolPrefs），
   * 只是各自只挑自己那一半来画。
   */
  function renderItemGrid(box, list) {
    box.innerHTML = '';
    box.classList.toggle('editing', S.toolEdit);
    list.forEach(function (it) {
      var isBrushList = box.id === 'brushGrid';
      var keyBadge = itemKeyBadge(it, list, isBrushList);
      var b = document.createElement('button');
      b.className = 'tool' + (it.id === S.brushId ? ' active' : '');
      b.dataset.tool = it.tool;
      b.dataset.item = it.id;
      b.title = it.name + (keyBadge ? '（快捷键 ' + keyBadge + '）' : '') + '｜' + it.tip;
      b.innerHTML = Brushes.iconSvg(it.icon || it.id) + '<span>' + esc(it.name) + '</span>' +
        (keyBadge ? '<span class="tkey">' + esc(keyBadge) + '</span>' : '') +
        (S.toolEdit
          ? '<span class="tbadge">' +
            '<button data-act="left" title="前移">◀</button>' +
            '<button data-act="right" title="后移">▶</button>' +
            '<button data-act="hide" title="收起">✕</button>' +
            '</span>'
          : '');
      b.onclick = function (e) {
        if (S.toolEdit) {
          var act = e.target && e.target.dataset ? e.target.dataset.act : null;
          if (act === 'left') return moveItem(it.id, -1);
          if (act === 'right') return moveItem(it.id, 1);
          if (act === 'hide') return hideItem(it.id);
          return;
        }
        loadBrush(it.id);
      };
      // 右键任意格子 → 小弹窗：改快捷键 / 删除（内置笔刷=收起，导入笔刷=真删）
      b.oncontextmenu = function (e) {
        e.preventDefault();
        openItemCtx(it, e.clientX, e.clientY);
      };
      if (S.toolEdit) bindGridDrag(b, box);
      box.appendChild(b);
    });
  }

  function renderToolGrid() {
    var all = visibleItems();
    var tools = all.filter(function (it) { return !isBrushItem(it); });
    var brushes = all.filter(isBrushItem);
    var toolBox = $('#toolGrid');
    var brushBox = $('#brushGrid');

    if (toolBox) renderItemGrid(toolBox, tools);
    if (brushBox) renderItemGrid(brushBox, brushes);

    // 收起池挂在笔刷栏下面（那里空间更宽裕），但「放回来」是按各自归属归位的
    renderHiddenPool();
    var cur = Brushes.get(S.brushId);
    var fam = $('#brushFamily');
    if (fam) fam.textContent = Brushes.FAMILY[S.tool] || '画笔';
    var tip = $('#brushTip');
    if (tip) tip.textContent = cur ? cur.tip : '—';
  }

  function renderHiddenPool() {
    var pool = $('#toolHiddenPool');
    var bar = $('#toolEditBar');
    bar.classList.toggle('hidden', !S.toolEdit);
    var hidden = S.toolPrefs.hidden;
    pool.classList.toggle('hidden', !S.toolEdit || !hidden.length);
    pool.innerHTML = '';
    if (!S.toolEdit || !hidden.length) return;
    var lb = document.createElement('span');
    lb.className = 'hint-mini';
    lb.textContent = '已收起：';
    pool.appendChild(lb);
    hidden.forEach(function (id) {
      var it = Brushes.get(id);
      if (!it) return;
      var b = document.createElement('button');
      b.className = 'tb-item';
      b.textContent = '＋ ' + it.name;
      b.title = '点一下放回工具栏';
      b.onclick = function () { showItem(id); };
      pool.appendChild(b);
    });
  }

  function itemIndex(id) {
    var i = S.toolPrefs.order.indexOf(id);
    if (i >= 0) return i;
    S.toolPrefs.order.push(id);
    return S.toolPrefs.order.length - 1;
  }

  /**
   * 在当前这一栏里前后移动。
   * 顺序数组是两栏共用的，所以只能和**同类**的邻居换位 ——
   * 否则「工具栏里第一项往前移」会溜到笔刷栏去。
   */
  function moveItem(id, dir) {
    var order = S.toolPrefs.order;
    var it = Brushes.get(id);
    if (!it) return;
    var i = itemIndex(id);
    var j = i + dir;
    while (j >= 0 && j < order.length) {
      var nb = Brushes.get(order[j]);
      if (nb && isBrushItem(nb) === isBrushItem(it)) break;
      j += dir;
    }
    if (j < 0 || j >= order.length) return;
    var t = order[i]; order[i] = order[j]; order[j] = t;
    saveToolPrefs();
    renderToolGrid();
  }
  function hideItem(id) {
    var vis = visibleItems();
    var it = Brushes.get(id);
    // 「至少留一个」按各自那一栏算：工具和笔刷现在是两栏，互不兜底
    var sameKind = vis.filter(function (x) { return isBrushItem(x) === isBrushItem(it); });
    if (sameKind.length <= 1) {
      toast(isBrushItem(it) ? '笔刷栏至少要留一支笔' : '工具栏至少要留一个工具', 'err');
      return;
    }
    if (S.toolPrefs.hidden.indexOf(id) < 0) S.toolPrefs.hidden.push(id);
    if (S.brushId === id) {
      var next = sameKind.filter(function (x) { return x.id !== id; })[0] || Brushes.ITEMS[0];
      saveToolPrefs();
      loadBrush(next.id);
      return;
    }
    saveToolPrefs();
    renderToolGrid();
  }

  function showItem(id) {
    var i = S.toolPrefs.hidden.indexOf(id);
    if (i >= 0) S.toolPrefs.hidden.splice(i, 1);
    saveToolPrefs();
    renderToolGrid();
  }

  function resetToolPrefs() {
    S.toolPrefs = { order: Brushes.ITEMS.map(function (i) { return i.id; }), hidden: [] };
    saveToolPrefs();
    renderToolGrid();
    toast('工具栏已恢复默认');
  }

  /**
   * 编辑模式：按住格子直接拖到目标位置（替代/补充 ◀ ▶）。
   * 两栏共用一份 order 数组，所以只能在**同类**里换位 ——
   * 松手时从 DOM 实际顺序反推 order，其他栏 / 收起池的相对位置原样保留。
   */
  function bindGridDrag(el, box) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.tbadge')) return;  // ◀ ▶ ✕ 还是要能点
      var startX = e.clientX, startY = e.clientY, dragging = false;
      var pid = e.pointerId;

      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
          dragging = true;
          el.classList.add('drag-ghost');
          document.body.classList.add('tool-dragging');
          try { el.setPointerCapture(pid); } catch (err) { /* 老浏览器无所谓 */ }
        }
        // 指针压在哪个同类兄弟上，就把被拖的格子实时插到它前/后
        var kids = [].slice.call(box.children);
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid === el) continue;
          var r = kid.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom && ev.clientX >= r.left && ev.clientX <= r.right) {
            if (ev.clientY < r.top + r.height / 2) box.insertBefore(el, kid);
            else box.insertBefore(el, kid.nextSibling);
            break;
          }
        }
        ev.preventDefault();
      }
      function finish() {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', finish);
        el.removeEventListener('pointercancel', finish);
        el.classList.remove('drag-ghost');
        document.body.classList.remove('tool-dragging');
        if (!dragging) return;               // 没拖成 = 普通点击，交给 onclick
        var ids = [].slice.call(box.children).map(function (c) { return c.dataset.item; });
        var inGrid = {};
        ids.forEach(function (id) { inGrid[id] = 1; });
        var out = [], gi = 0;
        S.toolPrefs.order.forEach(function (id) {
          out.push(inGrid[id] ? ids[gi++] : id);
        });
        S.toolPrefs.order = out;
        saveToolPrefs();
        renderToolGrid();
      }
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
    });
  }

  /* ------------------------------------------------- 右键格子的小弹窗：改键 / 删除 */

  var ctxItem = null;        // 当前右键的 item
  var ctxCapturing = false;  // 正在等用户按新快捷键

  function openItemCtx(it, x, y) {
    ctxItem = it; ctxCapturing = false;
    var m = $('#itemCtxMenu');
    if (!m) return;
    $('#icmName').textContent = it.name + (it.imported ? '（导入）' : '');
    refreshIcmKey();
    $('#icmDel').textContent = it.imported ? '删除笔刷' : '收起笔刷（编辑模式可放回）';
    m.classList.remove('hidden');
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }
  function closeItemCtx() {
    ctxItem = null; ctxCapturing = false;
    var m = $('#itemCtxMenu');
    if (m) m.classList.add('hidden');
  }
  function refreshIcmKey() {
    if (!ctxItem) return;
    var k = itemKey(ctxItem.id);
    $('#icmKey').textContent = ctxCapturing
      ? '按下新快捷键…（Esc 取消）'
      : (k ? '快捷键：' + k + '（点击修改）' : '快捷键：无（点击设置）');
  }

  function updateBrushLabel() {
    var cur = Brushes.get(S.brushId);
    var t = toolName(S.tool);
    $('#brushNow').textContent = (cur ? cur.name : t) + ' · ' + S.brush.size + 'px · ' +
      Math.round(S.brush.opacity * 100) + '%';
  }

  /** 画笔预览：在一条弧线上按当前参数画一笔，直观看浓淡与边缘 */
  function drawBrushPreview() {
    var cv = $('#brushPreview');
    if (!cv) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 240, h = 46;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    var b = S.brush;
    var maxR = Math.min(h / 2 - 5, 16);
    var r = clamp(b.size / 2, 1.2, maxR);
    var steps = 34;
    var base = S.tool === 'eraser' ? '#c9ced8' : S.color;
    var blur = b.hardness < 0.995 ? Math.min(6, b.size * (1 - b.hardness) * 0.5) : 0;
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var x = 12 + t * (w - 24);
      var y = h / 2 + Math.sin(t * Math.PI * 1.6) * 6 - 3;
      var rr = r * (1 - (1 - b.minSize) * Math.pow(1 - t, 2));
      var a = b.opacity * ((1 - b.pressOpacity) + b.pressOpacity * Math.pow(t, 0.7));
      pts.push([x, y, Math.max(0.5, rr), clamp(a, 0.03, 1)]);
    }
    ctx.fillStyle = base;
    ctx.strokeStyle = base;
    if (b.scatter > 0) {
      // 散布类：本来就是一颗颗点，照实画成点
      for (var k = 0; k < pts.length; k++) {
        ctx.globalAlpha = pts[k][3];
        ctx.filter = blur > 0.3 ? 'blur(' + blur.toFixed(2) + 'px)' : 'none';
        ctx.beginPath();
        ctx.arc(pts[k][0], pts[k][1], pts[k][2], 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // 连续类：连成一条带粗细变化的线。
      // 以前每 6px 才点一个圆点，2px 的铅笔预览出来是一串虚线，看着像散布笔 —— 与实笔不符。
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (var j = 1; j < pts.length; j++) {
        var p0 = pts[j - 1], p1 = pts[j];
        ctx.globalAlpha = (p0[3] + p1[3]) / 2;
        ctx.filter = blur > 0.3 ? 'blur(' + blur.toFixed(2) + 'px)' : 'none';
        ctx.lineWidth = Math.max(0.7, (p0[2] + p1[2]));
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
      }
    }
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  }

  function saveOverrides() {
    var key = S.brushId;
    var keep = {};
    ['size', 'opacity', 'hardness', 'minSize', 'pressSize', 'pressOpacity',
      'edge', 'scatter', 'grain', 'grainScale', 'strength', 'tolerance', 'expand',
      'blend', 'filled', 'paper', 'fx', 'tipShape', 'tipAngle'].forEach(function (k) {
      if (S.brush[k] !== undefined) keep[k] = S.brush[k];
    });
    S.overrides[key] = keep;
    lsSet('chahu.brushes', JSON.stringify(S.overrides));
  }

  function bset(key, value) {
    S.brush[key] = value;
    S.brush.sym = S.sym;
    saveOverrides();
    updateBrushLabel();
    drawBrushPreview();
    updateBrushCursor();
  }

  function bindRow(id, key, fromSlider, toSlider) {
    var el = $('#' + id);
    var out = $('#' + id.replace('Range', 'Val'));
    if (!el) return;
    el.addEventListener('input', function () {
      var v = Number(this.value);
      bset(key, fromSlider(v));
      if (out) out.textContent = toSlider ? Math.round(toSlider(v)) : v;
    });
    el._sb = { out: out, fromSlider: fromSlider, toSlider: toSlider };
  }

  function pushToSlider() { /* 保留占位：参数刷新统一走 syncBrushUI */ }

  function syncBrushUI() {
    var b = S.brush;
    setSlider('sizeRange', b.size, function (n) { return n; });
    setSlider('opacityRange', b.opacity * 100, Math.round);
    setSlider('hardnessRange', b.hardness * 100, Math.round);
    setSlider('minSizeRange', b.minSize * 100, Math.round);
    setSlider('pressSizeRange', b.pressSize * 100, Math.round);
    setSlider('pressOpacityRange', b.pressOpacity * 100, Math.round);
    setSlider('strengthRange', b.strength * 100, Math.round);
    setSlider('toleranceRange', b.tolerance, Math.round);
    setSlider('expandRange', b.expand, Math.round);
    // ★ 2.0.10：笔尖形状（照 SAI2 的笔刷形状面板）：一排图标 + 一个角度滑块
    var tipNow = b.tipShape || 'round';
    $$('#tipShapes .tip-btn').forEach(function (btn) {
      btn.classList.toggle('on', btn.dataset.tip === tipNow);
    });
    setSlider('tipAngleRange', b.tipAngle || 0, function (v) { return Math.round(v) + '°'; });
    var tipRow = $('#tipShapes') && $('#tipShapes').closest('.row-line');
    var strokeish = STROKE_TOOLS.indexOf(S.tool) >= 0;
    if (tipRow) tipRow.classList.toggle('hidden', !strokeish);
    var angleRow = $('#tipAngleRow');
    if (angleRow) angleRow.classList.toggle('hidden', !strokeish || tipNow === 'round');
    $('#brushBlend').value = b.blend;
    $('#filledChk').checked = !!b.filled;
    $('#pressureChk').checked = S.pressure;
    renderPenHint();
    setSlider('stabilizeRange', S.stabilize, Math.round);
    syncEffectUI();
    markSizePresets();
    updateBrushLabel();
  }

  /* ---- 特殊效果面板：纸张质感 ↔ grain / grainScale，特效 ↔ edge / scatter ---- */

  function setFxWidth(v) { bset('edge', clamp(v, 0, 1)); }
  function setFxStrength(v) { bset('scatter', clamp(v, 0, 1)); }

  function syncEffectUI() {
    var b = S.brush;
    setSelect('paperSelect', b.paper, 'none');
    setSlider('paperStrength', b.grain * 100, Math.round);
    setSlider('paperScale', b.grainScale * 100, Math.round);
    setSelect('fxSelect', b.fx, 'none');
    setSlider('fxWidth', b.edge * 100, Math.round);
    setSlider('fxStrength', b.scatter * 100, Math.round);
  }

  function setSelect(id, value, fallback) {
    var el = $('#' + id);
    if (!el) return;
    var v = value || fallback;
    if (el.value !== v) el.value = v;
    if (el.selectedIndex < 0 && fallback) el.value = fallback;
  }

  function setSlider(id, value, fmt) {
    var el = $('#' + id);
    if (!el) return;
    el.value = Math.round(value);
    var out = $('#' + valIdOf(id));
    if (out) out.textContent = fmt ? fmt(value) : Math.round(value);
  }

  /** 滑块 → 数值标签：xxxRange → xxxVal，其余（paperStrength / fxWidth …）→ xxxVal */
  function valIdOf(id) {
    return (id.indexOf('Range') >= 0 ? id.replace('Range', 'Val') : id + 'Val');
  }

  var STROKE_TOOLS = ['brush', 'eraser', 'blur', 'smudge', 'line', 'rect', 'ellipse', 'select', 'selectErase', 'gradient'];

  var PARAM_TOOLS = {
    sizeRange: ['brush', 'eraser', 'blur', 'smudge', 'line', 'rect', 'ellipse', 'select', 'selectErase'],
    opacityRange: ['brush', 'eraser', 'blur', 'smudge', 'fill', 'gradient', 'line', 'rect', 'ellipse'],
    hardnessRange: STROKE_TOOLS,
    minSizeRange: STROKE_TOOLS,
    pressSizeRange: STROKE_TOOLS,
    pressOpacityRange: STROKE_TOOLS,
    brushBlend: ['brush', 'eraser', 'line', 'rect', 'ellipse', 'gradient'],
    stabilizeRange: ['brush', 'eraser', 'blur', 'smudge'],
    strengthRange: ['blur'],
    smudgeRange: ['smudge'],
    toleranceRange: ['fill', 'wand'],
    expandRange: ['fill'],
    filledChk: ['rect', 'ellipse', 'gradient'],
    paperSelect: ['brush', 'eraser', 'line', 'rect', 'ellipse'],
    paperStrength: ['brush', 'eraser', 'line', 'rect', 'ellipse'],
    paperScale: ['brush', 'eraser', 'line', 'rect', 'ellipse'],
    fxSelect: ['brush', 'eraser'],
    fxWidth: ['brush', 'eraser'],
    fxStrength: ['brush', 'eraser']
  };

  function syncParamRows() {
    Object.keys(PARAM_TOOLS).forEach(function (id) {
      var el = $('#' + id);
      if (!el) return;
      var row = el.closest('.row-line') || el.closest('.slider-row') ||
        el.closest('.check-row') || el.closest('.form-row');
      if (!row) return;
      row.classList.toggle('hidden', PARAM_TOOLS[id].indexOf(S.tool) < 0);
    });
    // 魔棒那一整块选项面板（照 SAI2 的魔棒面板）跟着工具显隐
    syncWandUI();
  }

  /**
   * ★ 2.0.9 魔棒选项面板：状态 ↔ S.wand，并按当前工具 / 取样模式决定显隐。
   * 「色差范围」那一行（就是画笔的 tolerance 滑块）只有两种色差模式才用得上 ——
   * 选「被线条包围的透明区域」时它没有任何作用，留着反而让人以为调了会有效果。
   */
  function syncWandUI() {
    var box = $('#wandOpts');
    if (!box) return;
    var w = S.wand;
    var isWand = S.tool === 'wand';
    box.classList.toggle('hidden', !isWand);
    var modeEl = $({ wrap: '#wandModeWrap', diff: '#wandModeDiff', diffAll: '#wandModeAll' }[w.mode] || '#wandModeWrap');
    if (modeEl) modeEl.checked = true;
    var srcEl = $({ layer: '#wandSrcLayer', sample: '#wandSrcSample', merged: '#wandSrcMerge' }[w.source] || '#wandSrcLayer');
    if (srcEl) srcEl.checked = true;
    setSlider('wandTolRange', w.transTol, Math.round);
    setSlider('wandBleedRange', w.bleed, function (v) { return Math.round(v) + ' px'; });
    var aa = $('#wandAAChk');
    if (aa) aa.checked = !!w.aa;
    var ig = $('#wandIgnoreChk');
    if (ig) ig.checked = !!w.ignore;
    // 「指定为选区样本的图层」还没人认领时把这一项标灰一点，别让人白点
    var srcSample = $('#wandSrcSample');
    if (srcSample) {
      var hasSample = engine.layers.some(function (l) { return l.selSample; });
      srcSample.parentElement.classList.toggle('off', !hasSample);
    }
    var tol = $('#toleranceRange');
    if (tol) {
      var row = tol.closest('.row-line');
      if (row) row.classList.toggle('hidden', !(S.tool === 'fill' || (isWand && w.mode !== 'wrap')));
    }
  }

  var PAPERS = [
    { id: '#ffffff', name: '白纸' },
    { id: '#fbf7ee', name: '米黄' },
    { id: '#f2f4f7', name: '浅灰' },
    { id: '#eaf3ff', name: '淡蓝' },
    { id: '#23262b', name: '深色' }
  ];

  function buildPaperPicker() {
    var box = $('#paperPicker');
    box.innerHTML = '';
    PAPERS.forEach(function (p, idx) {
      var b = document.createElement('button');
      b.style.background = p.id;
      b.title = p.name;
      b.dataset.paper = p.id;
      if (idx === 0) b.classList.add('active');
      b.onclick = function () {
        $$('#paperPicker button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      };
      box.appendChild(b);
    });
  }

  function currentPaper() {
    var el = $('#paperPicker button.active');
    return el ? el.dataset.paper : '#ffffff';
  }

  function buildBlendSelects() {
    ['#brushBlend', '#layerBlend'].forEach(function (sel) {
      var box = $(sel);
      box.innerHTML = '';
      P.BLEND_MODES.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        o.textContent = P.BLEND_LABELS[m] || m;
        box.appendChild(o);
      });
    });
  }

  function buildSizePresets() {
    var box = $('#sizePresets');
    box.innerHTML = '';
    global.CanvasEngine.SIZE_PRESETS.forEach(function (n) {
      var b = document.createElement('button');
      b.dataset.size = n;
      b.title = n + ' px';
      var dot = document.createElement('span');
      var d = clamp(n, 2, 18);
      dot.style.width = d + 'px'; dot.style.height = d + 'px';
      b.appendChild(dot);
      b.onclick = function () { setSize(n); };
      box.appendChild(b);
    });
  }

  function setSize(n) {
    bset('size', clamp(Math.round(n), 1, 300));
    setSlider('sizeRange', S.brush.size, function (v) { return v; });
    markSizePresets();
  }

  function markSizePresets() {
    $$('#sizePresets button').forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.size) === S.brush.size);
    });
  }

  function setTool(t) {
    var cur = Brushes.get(S.brushId);
    if (cur && cur.tool === t) {
      S.tool = t;
      setToolButtons();
      syncParamRows();
      updateBrushLabel();
      return;
    }
    var last = S.lastOfFamily[t] && Brushes.get(S.lastOfFamily[t]);
    if (last && last.tool === t) { loadBrush(last.id); return; }
    loadBrush(Brushes.itemForTool(t).id);
  }

  function setToolButtons() {
    $$('#toolGrid .tool').forEach(function (b) {
      b.classList.toggle('active', b.dataset.item === S.brushId);
    });
    $('#stage').classList.toggle('drawing', S.tool !== 'picker');
    document.body.style.cursor = '';
    updateBrushCursor();
  }

  /* ============================================================ 颜色 */

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h: h, s: mx ? d / mx : 0, v: mx };
  }

  function hexOf(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var s = clamp(v, 0, 255).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  var ringCache = null;
  var triCache = null;

  /* 取色区形状：'square'（默认）| 'triangle'
   *
   * 默认改成方形的原因（用户反馈）：三角形的尖角附近，一大片区域画出来的颜色
   * 都挤在一起 —— 想稳定地选到某个饱和度 / 明度得试好几次；方形的横轴是饱和度、
   * 纵轴是明度，同一个方向拖多远就是多少，和 PS / SAI 的取色方块一致，好瞄准。
   * 三角形不走（老习惯），做成可切换并记住选择。
   */
  var SV_SHAPE_KEY = 'chahu.svshape';

  function loadSvShape() {
    try { return lsGet(SV_SHAPE_KEY, '') === 'triangle' ? 'triangle' : 'square'; }
    catch (e) { return 'square'; }
  }
  function saveSvShape(v) { try { lsSet(SV_SHAPE_KEY, v); } catch (e) { /* 记不住就这次会话照用 */ } }
  /** 当前取色区形状（唯一的读口，绘制 / 命中 / 指示器都必须问它） */
  function svShape() { return S.svShape === 'triangle' ? 'triangle' : 'square'; }

  /** 切换取色区形状：存盘 + 刷新按钮外观 + 重画色轮 */
  function setSvShape(v) {
    S.svShape = (v === 'triangle') ? 'triangle' : 'square';
    saveSvShape(S.svShape);
    var btn = $('#btnWheelShape');
    if (btn) {
      btn.textContent = S.svShape === 'triangle' ? '△' : '▢';
      btn.title = S.svShape === 'triangle'
        ? '取色区：三角形（点一下换成方形）'
        : '取色区：方形（点一下换成三角形）';
      btn.setAttribute('aria-label', btn.title);
    }
    drawWheel();
    return S.svShape;
  }

  /* 取色区离色环内沿留多少空隙。
     留少了看着像连在一起（用户反馈「还是让三角形和环形间隔一段距离」），
     所以这里给到 11px —— 视觉上明确是两块。
     注意：命中判定不是按半径切的（见 hitRegion），空隙的一半会算给取色区，
     所以间距加大**不会**让它变难点，反而更容易。 */
  var TRI_GAP = 11;

  /**
   * 色轮的几何 —— **绘制和命中判定必须共用这一份**。
   * 以前 drawWheel 和 pick 各算一遍，改一处忘另一处的话，
   * 就会出现「看到的地方点不中、点中的地方没画东西」。
   */
  function wheelGeom(cv) {
    var SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
    var R = SZ / 2 - 3, ring = 17, r0 = R - ring;
    var tr = r0 - TRI_GAP;
    var T3 = Math.sqrt(3) / 2;
    // 方形取色区让**四个角正好落在三角顶点那个圆上**（half = tr/√2）。
    // 用同一个外接半径是有意的：切换形状时取色区不会忽大忽小，
    // 也不会出现「方形比三角更贴着色环」这种看着别扭的事。
    var half = tr / Math.SQRT2;
    return {
      SZ: SZ, cx: cx, cy: cy, R: R, ring: ring, r0: r0, tr: tr,
      // A = 纯色相（上）· B = 白（右下）· C = 黑（左下）
      A: [cx, cy - tr],
      B: [cx + T3 * tr, cy + tr / 2],
      C: [cx - T3 * tr, cy + tr / 2],
      SQ: { x: cx - half, y: cy - half, w: half * 2, h: half * 2 }
    };
  }

  /** 点到方形取色区的距离：在里面就是 0 */
  function distToSq(sq, px, py) {
    var dx = Math.max(sq.x - px, 0, px - (sq.x + sq.w));
    var dy = Math.max(sq.y - py, 0, py - (sq.y + sq.h));
    return Math.hypot(dx, dy);
  }

  /** 点在不在取色区里（按给定形状） */
  function inSv(g, shape, px, py) {
    return shape === 'triangle' ? (distToTri(g, px, py) <= 0) : (distToSq(g.SQ, px, py) <= 0);
  }

  /** 点到取色区边界的距离（里面为 0）—— 用来切「离色环近还是离取色区近」 */
  function distToSv(g, shape, px, py) {
    return shape === 'triangle' ? distToTri(g, px, py) : distToSq(g.SQ, px, py);
  }

  /** SV → 取色区里的画布坐标（画指示器用） */
  function svToPoint(g, shape, s, v) {
    if (shape === 'triangle') {
      // 三角形三个顶点 A=纯色相、B=白、C=黑，重心坐标是 [v*s, v*(1-s), 1-v]。
      // 推法：颜色 = a*hue + b*255 + c*0，取 max/min 得 V = a+b、S = 1 - b/(a+b)，
      // 于是 c = 1-V、b = V(1-S)、a = V*S。
      // 以前写的是 [1-s, s*(1-v), s*v] —— 权重和也是 1，但对应关系是错的：
      // s=1,v=1（纯色相）会算成 [0,0,1] 落到黑角上，s=0,v=1 时权重和还会变成 2。
      var wts = [v * s, v * (1 - s), 1 - v];
      return [
        wts[0] * g.A[0] + wts[1] * g.B[0] + wts[2] * g.C[0],
        wts[0] * g.A[1] + wts[1] * g.B[1] + wts[2] * g.C[1]
      ];
    }
    // 方形：横轴 = 饱和度，纵轴 = 明度（上 1 → 下 0）
    return [g.SQ.x + s * g.SQ.w, g.SQ.y + (1 - v) * g.SQ.h];
  }

  /** 取色区里的画布坐标 → SV（夹到 0~1）。给「拖动时被拖出边界」兜底 */
  function pointToSv(g, shape, px, py) {
    if (shape === 'triangle') {
      var w = triBary(g, px, py);
      var sum = (w[0] + w[1] + w[2]) || 1;
      var a = clamp(w[0] / sum, 0, 1);
      var c = clamp(w[2] / sum, 0, 1);
      var v = clamp(1 - c, 0, 1);
      return { s: v > 0.0001 ? clamp(a / v, 0, 1) : 0, v: v };
    }
    return {
      s: clamp((px - g.SQ.x) / g.SQ.w, 0, 1),
      v: clamp(1 - (py - g.SQ.y) / g.SQ.h, 0, 1)
    };
  }

  /** 点的重心坐标 [wA, wB, wC]（三个权重和恒为 1） */
  function triBary(g, px, py) {
    var A = g.A, B = g.B, C = g.C;
    var v0x = B[0] - A[0], v0y = B[1] - A[1];
    var v1x = C[0] - A[0], v1y = C[1] - A[1];
    var den = v0x * v1y - v1x * v0y;
    var v2x = px - A[0], v2y = py - A[1];
    var wB = (v2x * v1y - v2y * v1x) / den;
    var wC = (v0x * v2y - v2x * v0y) / den;
    return [1 - wB - wC, wB, wC];
  }

  /** 点到线段的距离（用来算「点离三角有多远」） */
  function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var L2 = dx * dx + dy * dy;
    var t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** 点在一条线段上的最近点 */
  function closestOnSeg(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L2 = dx * dx + dy * dy;
    var t = L2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / L2 : 0;
    t = clamp(t, 0, 1);
    return [a[0] + t * dx, a[1] + t * dy];
  }

  /** 点到三角的距离：在里面就是 0，在外面取三条边里最近的那条 */
  function distToTri(g, px, py) {
    var w = triBary(g, px, py);
    if (w[0] >= 0 && w[1] >= 0 && w[2] >= 0) return 0;
    var A = g.A, B = g.B, C = g.C;
    return Math.min(
      distToSeg(px, py, A[0], A[1], B[0], B[1]),
      distToSeg(px, py, B[0], B[1], C[0], C[1]),
      distToSeg(px, py, C[0], C[1], A[0], A[1])
    );
  }

  /**
   * 在色轮上取一个「取色区里的」像素（方形 / 三角形都用这一份）。
   * 直接读点到的那个像素是不够的：取色区和内圈之间有一圈空白，
   * 空白里读出来 alpha = 0，于是「点了没反应」。
   * 这里先把它吸到取色区边上，再朝中心挪进去一点（避开那 1px 描边），
   * 取到的色值和画出来的一模一样 —— 因为它读的就是画布本身。
   */
  function sampleSvPixel(ctx, g, shape, x, y) {
    var px = clamp(Math.round(x), 0, g.SZ - 1), py = clamp(Math.round(y), 0, g.SZ - 1);
    var d = ctx.getImageData(px, py, 1, 1).data;
    if (d[3] >= 200) return d;
    // 先找图形边界上离它最近的点（在图形里的话就是它自己）
    var q = [x, y];
    if (shape === 'triangle') {
      if (distToTri(g, x, y) > 0) {
        var cands = [
          closestOnSeg(x, y, g.A, g.B),
          closestOnSeg(x, y, g.B, g.C),
          closestOnSeg(x, y, g.C, g.A)
        ];
        var bd = Infinity;
        cands.forEach(function (c) {
          var dd = Math.hypot(c[0] - x, c[1] - y);
          if (dd < bd) { bd = dd; q = c; }
        });
      }
    } else {
      q = [clamp(x, g.SQ.x, g.SQ.x + g.SQ.w), clamp(y, g.SQ.y, g.SQ.y + g.SQ.h)];
    }
    var gx, gy;
    if (shape === 'triangle') {
      gx = (g.A[0] + g.B[0] + g.C[0]) / 3;
      gy = (g.A[1] + g.B[1] + g.C[1]) / 3;
    } else {
      gx = g.SQ.x + g.SQ.w / 2;
      gy = g.SQ.y + g.SQ.h / 2;
    }
    for (var i = 1; i <= 20; i++) {
      var t = i * 0.05;
      var ix = clamp(Math.round(q[0] + (gx - q[0]) * t), 0, g.SZ - 1);
      var iy = clamp(Math.round(q[1] + (gy - q[1]) * t), 0, g.SZ - 1);
      d = ctx.getImageData(ix, iy, 1, 1).data;
      if (d[3] >= 200) return d;
    }
    return d;
  }

  function buildRing(SZ, cx, cy, R, r0) {
    var c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    var ctx = c.getContext('2d');
    for (var a = 0; a < 360; a++) {
      var a0 = (a - 0.7) * Math.PI / 180;
      var a1 = (a + 0.7) * Math.PI / 180;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = hexOf.apply(null, hsvToRgb(a, 1, 1));
      ctx.fill();
    }
    return c;
  }

  function drawWheel() {
    var cv = $('#colorWheel');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var g = wheelGeom(cv);
    var SZ = g.SZ, cx = g.cx, cy = g.cy, R = g.R, ring = g.ring, r0 = g.r0;
    if (!ringCache) ringCache = buildRing(SZ, cx, cy, R, r0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, SZ, SZ);
    ctx.drawImage(ringCache, 0, 0);

    // SV 取色区：方形（默认）或三角形，两种都画在**同一张离屏画布**上
    var A = g.A, B = g.B, C = g.C, SQ = g.SQ;
    var isTri = svShape() === 'triangle';
    var hue = hsvToRgb(S.hue, 1, 1);

    var minx = Math.floor(isTri ? Math.min(A[0], B[0], C[0]) : SQ.x) - 1;
    var maxx = Math.ceil(isTri ? Math.max(A[0], B[0], C[0]) : SQ.x + SQ.w) + 1;
    var miny = Math.floor(isTri ? Math.min(A[1], B[1], C[1]) : SQ.y) - 1;
    var maxy = Math.ceil(isTri ? Math.max(A[1], B[1], C[1]) : SQ.y + SQ.h) + 1;
    var w = maxx - minx, h = maxy - miny;
    if (w > 0 && h > 0) {
      // 关键：取色区必须画在**离屏画布**上再 drawImage 合成。
      // 直接用 putImageData 到主画布会连同 alpha 一起覆写，
      // 于是包围盒四角落到圆环上的像素被「打孔」变透明 —— 看起来就是取色区把圆环切掉了一块。
      if (!triCache) { triCache = document.createElement('canvas'); }
      if (triCache.width !== SZ || triCache.height !== SZ) {
        triCache.width = SZ; triCache.height = SZ;
      }
      var tctx = triCache.getContext('2d');
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, SZ, SZ);
      var img = tctx.createImageData(w, h);
      var d = img.data;
      // 三角形要用的两条边向量（方形那条路用不到，算了也无害）
      var v0x = B[0] - A[0], v0y = B[1] - A[1];
      var v1x = C[0] - A[0], v1y = C[1] - A[1];
      var den = v0x * v1y - v1x * v0y;
      for (var j = 0; j < h; j++) {
        for (var i = 0; i < w; i++) {
          var px = minx + i, py = miny + j;
          var o = (j * w + i) * 4;
          if (isTri) {
            var v2x = px - A[0], v2y = py - A[1];
            // ⚠️ 变量名和顶点对不上，别按字面理解：
            //   cross((p-A), v1) 得到的是 **B 的权重**，cross(v0, (p-A)) 得到的是 **C 的权重**，
            //   1 减掉它们才是 **A 的权重**。
            // 之前直接把 `u` 当成 A 的权重去乘纯色相，结果整块三角被转了一圈 ——
            // 纯色相跑到右下角、顶部成了黑色，于是「在色轮上点哪儿，小圆圈都不在那儿」。
            var wB = ((v2x * v1y - v2y * v1x) / den);
            var wC = ((v0x * v2y - v2x * v0y) / den);
            var wA = 1 - wB - wC;
            if (wA < -0.004 || wB < -0.004 || wC < -0.004) { d[o + 3] = 0; continue; }
            wA = clamp(wA, 0, 1); wB = clamp(wB, 0, 1); wC = clamp(wC, 0, 1);
            var sum = wA + wB + wC || 1;
            wA /= sum; wB /= sum; wC /= sum;
            // A = 纯色相（上）· B = 白（右下）· C = 黑（左下）
            d[o] = Math.round(wA * hue[0] + wB * 255 + wC * 0);
            d[o + 1] = Math.round(wA * hue[1] + wB * 255 + wC * 0);
            d[o + 2] = Math.round(wA * hue[2] + wB * 255 + wC * 0);
            d[o + 3] = 255;
          } else {
            // 方形：横轴 = 饱和度（左 0 → 右 1），纵轴 = 明度（上 1 → 下 0）。
            // 于是左上角是白、右上角是纯色相、下边整条是黑 —— PS / SAI 取色方块同款。
            var ss = (px - SQ.x) / SQ.w, vv = 1 - (py - SQ.y) / SQ.h;
            if (ss < -0.004 || ss > 1.004 || vv < -0.004 || vv > 1.004) { d[o + 3] = 0; continue; }
            var rgb = hsvToRgb(S.hue, clamp(ss, 0, 1), clamp(vv, 0, 1));
            d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
          }
        }
      }
      tctx.putImageData(img, minx, miny);
      ctx.drawImage(triCache, 0, 0);
    }

    // 取色区描边
    ctx.beginPath();
    if (isTri) {
      ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]);
      ctx.closePath();
    } else {
      ctx.rect(SQ.x, SQ.y, SQ.w, SQ.h);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 色相指示器
    var ha = S.hue * Math.PI / 180;
    var hx = cx + Math.cos(ha) * (R - ring / 2), hy = cy + Math.sin(ha) * (R - ring / 2);
    ctx.beginPath();
    ctx.arc(hx, hy, ring / 2 - 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke();

    // SV 指示器：位置由 svToPoint 统一换算（方形的公式和三角完全不同，
    // 以前这里写死了重心坐标 —— 换成方形之后若不改，小圆圈会跑到画布外面去）
    var sip = svToPoint(g, svShape(), S.sv.s, S.sv.v);
    ctx.beginPath();
    ctx.arc(sip[0], sip[1], 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.stroke();
  }

  function u_weight(A, B, C, wts) {
    return [
      wts[0] * A[0] + wts[1] * B[0] + wts[2] * C[0],
      wts[0] * A[1] + wts[1] * B[1] + wts[2] * C[1]
    ];
  }

  function bindWheel() {
    var cv = $('#colorWheel');
    if (!cv) return;
    var drag = false;
    var dragRegion = null;       // 'ring' | 'sv'，按下那一刻定死

    function localXY(e) {
      var r = cv.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * cv.width / r.width,
        y: (e.clientY - r.top) * cv.height / r.height
      };
    }

    /**
     * 判定一点落在「色相环」「SV 取色区」还是「什么都不该响应」。
     *
     * 三层判据：
     *  1. **圆外一律不响应**（'miss'）。画布是方的、色轮是圆的，四个角那一块
     *     永远没有颜色。以前这里是 `dist >= r0` 就当作环，于是点在画布角落
     *     （离圆心比外半径 R 还远）也会把色相改掉 —— 用户报的「边缘取色误触」
     *     就是它：想点取色区边缘，手偏了一点落到角上，色相莫名其妙跳了。
     *  2. 环带（r0 ~ R）→ 色相环。
     *  3. 剩下的按「离谁近就算谁」切，圈内那圈空白一分为二，不留「点了没反应」
     *     的死区；取色区的实际可点范围也就顺势往外长了一圈。
     */
    function hitRegion(g, x, y) {
      var dist = Math.hypot(x - g.cx, y - g.cy);
      if (dist > g.R) return 'miss';
      if (dist >= g.r0) return 'ring';
      var shape = svShape();
      if (inSv(g, shape, x, y)) return 'sv';
      return (g.r0 - dist) < distToSv(g, shape, x, y) ? 'ring' : 'sv';
    }

    function applyRing(g, x, y, shift) {
      var deg = (Math.atan2(y - g.cy, x - g.cx) * 180 / Math.PI + 360) % 360;
      // 按住 Shift 每 15° 吸一档 —— 画对称图 / 想要标准色相时省事
      if (shift) deg = Math.round(deg / 15) * 15 % 360;
      S.hue = deg;
      applyHsv();
    }

    function applySv(g, x, y) {
      var shape = svShape();
      // 拖动中被拖到取色区外面 → 先夹回边上再取样。不夹的话会读到透明像素、
      // 于是「拖出去就粘住不动」，手感像坏了。
      if (shape === 'square') {
        x = clamp(x, g.SQ.x + 0.5, g.SQ.x + g.SQ.w - 0.5);
        y = clamp(y, g.SQ.y + 0.5, g.SQ.y + g.SQ.h - 0.5);
      }
      var d = sampleSvPixel(cv.getContext('2d'), g, shape, x, y);
      if (d[3] < 8) return;
      var hh = reliableHue(d[0], d[1], d[2]);
      // 取色区靠近白角 / 黑角的地方几乎没有彩度，色相是算不出来的（会回 0）。
      // 直接写 S.hue 会让色环上的小圈毫无理由地跳到红色去 —— 只在真的有色相时才更新。
      if (hh !== null) S.hue = hh;
      var hsv = rgbToHsv(d[0], d[1], d[2]);
      S.sv = { s: hsv.s, v: hsv.v };
      setColor(hexOf(d[0], d[1], d[2]), false);
    }

    function pick(e, region) {
      var p = localXY(e);
      var g = wheelGeom(cv);
      // 标记这次落在哪一边，测试靠它判定「到底点中了什么」（比猜颜色可靠）
      cv.dataset.pick = region;
      cv.dataset.svShape = svShape();
      if (region === 'ring') applyRing(g, p.x, p.y, e.shiftKey);
      else if (region === 'sv') applySv(g, p.x, p.y);
      else return;
      drawWheel();
    }

    cv.addEventListener('pointerdown', function (e) {
      // 数位笔 / 触摸拖色轮时，浏览器默认会把它当成「滚动手势」，
      // 结果整条左侧面板跟着一起滑 —— 必须两个一起做才压得住：
      //   · CSS 里给 canvas 设 touch-action: none
      //   · 事件里 preventDefault（并阻止后续的兼容鼠标事件）
      e.preventDefault();
      var p = localXY(e);
      var region = hitRegion(wheelGeom(cv), p.x, p.y);
      // 落在色轮圆外面（画布四角那块透明区）→ 不开始拖动、一个像素都不改。
      // 这是「边缘防误触」的关键：以前这里会当成环，手稍微偏一点色相就跳了。
      if (region === 'miss') {
        drag = false; dragRegion = null;
        cv.dataset.pick = 'miss';
        return;
      }
      drag = true;
      // ★ 按下时锁定区域：之后不管拖到哪里都只改这一个分量。
      //   不锁的话从取色区拖到环上会突然改成色相（反之亦然）—— 正是误触的来源。
      dragRegion = region;
      // 合成事件（脚本发出的）没有真实指针，setPointerCapture 会抛异常。
      // 以前没包 try，一抛就把整个 pointerdown 处理器打断，连 pick(e) 都执行不到。
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 没有真实指针就算了 */ }
      pick(e, region);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drag || !dragRegion) return;
      e.preventDefault();
      pick(e, dragRegion);
    });
    cv.addEventListener('pointerup', function () { drag = false; dragRegion = null; });
    cv.addEventListener('pointercancel', function () { drag = false; dragRegion = null; });

    // 取色区形状切换（色轮右上角那颗小按钮）
    var shapeBtn = $('#btnWheelShape');
    if (shapeBtn) {
      shapeBtn.addEventListener('click', function () {
        var next = setSvShape(svShape() === 'triangle' ? 'square' : 'triangle');
        toast(next === 'triangle' ? '取色区：三角形' : '取色区：方形（横轴饱和度 / 纵轴明度）');
      });
      var cur = svShape();
      shapeBtn.textContent = cur === 'triangle' ? '△' : '▢';
      shapeBtn.title = cur === 'triangle'
        ? '取色区：三角形（点一下换成方形）'
        : '取色区：方形（点一下换成三角形）';
    }
  }

  /**
   * 用当前的 H / S / V 合成颜色。
   *
   * ⚠ 合成出来的是 8 位 RGB，从它反推回 HSV 是有误差的 —— 暗色或低饱和时
   * 色相能差好几度（拖到 200° 显示成 199.7°，点环上 45° 变成 48°）。
   * 所以 setColor 之后把用户刚定的 H / S / V **原样放回去**：
   * 画布上用的是 RGB（有色深限制，没办法），但滑条和指示器显示的是你选的值，
   * 而且拖 H 滑条时不会每帧被量化一次、越拖越偏。
   */
  function applyHsv() {
    var h = S.hue, s = S.sv.s, v = S.sv.v;
    var rgb = hsvToRgb(h, s, v);
    setColor(hexOf(rgb[0], rgb[1], rgb[2]), false);
    S.hue = h;
    S.sv = { s: s, v: v };
    refreshColorSliders();
    drawWheel();
  }

  /* ── 色板 ──
     内置色板（引擎里那份）永远在最前面，后面接用户自己加的。
     自己加的记在 localStorage，右键点掉、或整块「恢复默认」。 */
  var SWATCH_KEY = 'chahu.swatches';

  function loadCustomSwatches() {
    var raw = null;
    try { raw = JSON.parse(lsGet(SWATCH_KEY, 'null')); } catch (e) { raw = null; }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(function (c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c); })
      .slice(0, 60);
  }

  function saveCustomSwatches(list) {
    S.customSwatches = list.slice(0, 60);
    lsSet(SWATCH_KEY, JSON.stringify(S.customSwatches));
  }

  function buildPalette() {
    var box = $('#palette');
    if (!box) return;
    box.innerHTML = '';
    var builtin = global.CanvasEngine.SWATCHES;
    var custom = S.customSwatches || loadCustomSwatches();
    S.customSwatches = custom;

    function cell(hex, isCustom, extraClass) {
      var i = document.createElement('i');
      i.style.background = hex;
      i.title = hex + (isCustom ? ' · 右键删除' : '');
      i.setAttribute('data-hex', hex.toLowerCase());
      if (isCustom) i.className = 'custom';
      if (extraClass) i.className += ' ' + extraClass;
      i.onclick = function (e) {
        // Alt / 中键点自己加的色格 = 删除，和右键一个意思（数位笔上按不出右键）
        if (isCustom && (e.altKey || e.button === 1)) { removeSwatch(hex); return; }
        setColor(hex);
      };
      if (isCustom) {
        i.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          removeSwatch(hex);
        });
      }
      box.appendChild(i);
      return i;
    }

    builtin.forEach(function (c) { cell(c, false); });
    if (custom.length) {
      cell('', false, 'palette-sep');
      custom.forEach(function (c) { cell(c, true); });
    }
    markPaletteSelection();
  }

  /** 当前颜色在色板里就描一圈，一眼看出选中的是哪个 */
  function markPaletteSelection() {
    var box = $('#palette');
    if (!box) return;
    var want = String(S.color || '').toLowerCase();
    Array.prototype.forEach.call(box.querySelectorAll('i'), function (i) {
      i.classList.toggle('sel', i.getAttribute('data-hex') === want);
    });
  }

  function addCurrentSwatch() {
    var hex = String(S.color || '').toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    var list = S.customSwatches || [];
    if (list.indexOf(hex) >= 0) { toast('这个颜色已经在色板里了'); return; }
    list.push(hex);
    saveCustomSwatches(list);
    buildPalette();
    toast('已加入色板 ' + hex.toUpperCase(), 'ok');
  }

  function removeSwatch(hex) {
    var list = (S.customSwatches || []).filter(function (c) { return c.toLowerCase() !== hex.toLowerCase(); });
    saveCustomSwatches(list);
    buildPalette();
    toast('已从色板移除 ' + hex.toUpperCase());
  }

  /* ── RGB / HSV 滑块 ──
     六根滑条 + 六个数字框都以 S.color 为唯一真相：
     拖滑条 / 输入数字 → setColor()；setColor() 反过来再刷新它们。
     用一个 syncing 标志挡住回环，避免拖动时死循环。

     ⚠ 灰阶的坑：黑 / 白 / 灰在 HSV 里推不出色相（S=0 时色相无意义），
     纯黑连饱和度也推不出来（V=0 时 S 也无意义）。所以 setColor 里对
     这两种情况**保留** S.hue / S.sv 里记住的值，滑条也照这份值显示 ——
     否则「V 拖到 0 变黑，再拖回来」会变成白色，颜色就丢了。 */
  var syncingColor = false;

  /**
   * 一个像素「算得出色相」吗？算得出就返回色相，算不出返回 null。
   *
   * 判断要严一点：色轮三角靠近白角 / 黑角的地方，8 位色深量化会让本来该是灰色的
   * 像素差出 1~2 级（#F4F5F5 就是这么来的），反推出来的色相纯粹是噪声 ——
   * 照单全收地写回 S.hue，环上的小圈就会毫无理由地跳走，
   * 这正是「点一下三角，色相自己变了」的来源。
   * 所以：通道极差 ≤ 2 的直接算灰；饱和度不到 1% 的也算灰。
   */
  function reliableHue(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn <= 2) return null;
    var hsv = rgbToHsv(r, g, b);
    return hsv.s > 0.01 ? hsv.h : null;
  }

  /** 从 RGB 推 HSV，推不出来的分量沿用 S 里记住的 */
  function hsvOfColor(hex) {
    var rg = global.CanvasEngine.hexToRgb(hex);
    var hsv = rgbToHsv(rg.r, rg.g, rg.b);
    var hh = reliableHue(rg.r, rg.g, rg.b);
    return {
      rgb: rg,
      h: hh !== null ? hh : S.hue,
      s: hsv.v > 0.0001 ? hsv.s : S.sv.s,
      v: hsv.v
    };
  }

  function refreshColorSliders() {
    var c = hsvOfColor(S.color);
    var vals = {
      r: c.rgb.r, g: c.rgb.g, b: c.rgb.b,
      h: Math.round(c.h), s: Math.round(c.s * 100), v: Math.round(c.v * 100)
    };
    syncingColor = true;
    Object.keys(vals).forEach(function (k) {
      var sl = $('#sl' + k.toUpperCase());
      var nm = $('#num' + k.toUpperCase());
      if (sl) sl.value = vals[k];
      if (nm) nm.value = vals[k];
    });
    syncingColor = false;
  }

  function bindColorSliders() {
    if (!$('#colorModes')) return;

    // 顶部这排开关：每块各自显示 / 隐藏，状态记在 localStorage 里。
    var CM_KEY = 'chahu.colorBlocks';
    var shown = null;
    try { shown = JSON.parse(lsGet(CM_KEY, 'null')); } catch (e) { shown = null; }
    if (!shown || typeof shown !== 'object') shown = { wheel: true, rgb: false, hsv: false, swatch: true };

    function applyBlocks() {
      document.querySelectorAll('.cm-block[data-cm-block]').forEach(function (b) {
        var k = b.getAttribute('data-cm-block');
        b.classList.toggle('off', !shown[k]);
      });
      document.querySelectorAll('#colorModes .cm-btn').forEach(function (b) {
        b.classList.toggle('on', !!shown[b.getAttribute('data-cm')]);
      });
    }
    document.querySelectorAll('#colorModes .cm-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-cm');
        shown[k] = !shown[k];
        lsSet(CM_KEY, JSON.stringify(shown));
        applyBlocks();
        // 面板高度变了，把两侧滚动区重新算一遍
        if (typeof updateRightScroll === 'function') updateRightScroll();
      });
    });
    applyBlocks();

    var CH = {
      r: { max: 255, at: 1 }, g: { max: 255, at: 1 }, b: { max: 255, at: 1 },
      h: { max: 360, at: 0 }, s: { max: 100, at: 0 }, v: { max: 100, at: 0 }
    };
    function onInput(k, raw) {
      if (syncingColor) return;
      var n = parseFloat(raw);
      if (!isFinite(n)) return;
      var cfg = CH[k];
      n = clamp(n, 0, cfg.max);
      if (cfg.at) {
        var c = hsvOfColor(S.color);
        var rgb = { r: c.rgb.r, g: c.rgb.g, b: c.rgb.b };
        rgb[k] = Math.round(n);
        setColor(hexOf(rgb.r, rgb.g, rgb.b), false);
        return;
      }
      // HSV 这一路：先把当前值（含「推不出来就沿用」的规则）取出来，再改被拖的那一个分量
      var cur = hsvOfColor(S.color);
      var h = cur.h, s = cur.s, v = cur.v;
      if (k === 'h') h = n;
      else if (k === 's') s = n / 100;
      else v = n / 100;
      S.hue = h;
      S.sv = { s: s, v: v };
      applyHsv();
      drawWheel();
    }
    ['r', 'g', 'b', 'h', 's', 'v'].forEach(function (k) {
      var sl = $('#sl' + k.toUpperCase());
      var nm = $('#num' + k.toUpperCase());
      if (sl) sl.addEventListener('input', function () { onInput(k, sl.value); });
      if (nm) {
        nm.addEventListener('input', function () { onInput(k, nm.value); });
        nm.addEventListener('change', function () { onInput(k, nm.value); });
        // 上下方向键 / 滚轮微调：整格整格拖太糙，调「差一点点」的色值时很有用
        // （Shift 一次 10）
        nm.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          var step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          var now = parseFloat(nm.value);
          if (!isFinite(now)) now = 0;
          nm.value = clamp(Math.round(now + step), 0, CH[k].max);
          onInput(k, nm.value);
        });
        nm.addEventListener('wheel', function (e) {
          e.preventDefault();
          var step = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1);
          var now = parseFloat(nm.value);
          if (!isFinite(now)) now = 0;
          nm.value = clamp(Math.round(now + step), 0, CH[k].max);
          onInput(k, nm.value);
        }, { passive: false });
      }
    });
    refreshColorSliders();
  }

  function setColor(hex, remember) {
    S.color = hex;
    $('#colorPreview').style.background = hex;
    $('#hexInput').value = hex.toUpperCase();
    try { $('#colorInput').value = hex; } catch (e) { /* ignore */ }    var rg = global.CanvasEngine.hexToRgb(hex);
    var hsv = rgbToHsv(rg.r, rg.g, rg.b);
    // 灰阶颜色（黑 / 白 / 灰）算不出色相，rgbToHsv 会回 0；纯黑连饱和度也推不出来。
    // 这两种情况**保留原来的色相 / 饱和度**，否则：
    //  · 在色轮上拖色相环 → applyHsv 用当前 S/V 合成 → 若当前 S=0 合成出来还是灰 →
    //    setColor 又把 hue 打回 0 —— 用户看到的就是「点环没用」；
    //  · 把 V 拖到 0 变黑再拖回来 → S 被打回 0 → 变成白色，原来的颜色就没了。
    var hh = reliableHue(rg.r, rg.g, rg.b);
    if (hh !== null) S.hue = hh;
    S.sv = { s: hsv.v > 0.0001 ? hsv.s : S.sv.s, v: hsv.v };
    refreshColorSliders();
    // 色轮上的两个指示器（环上的小圈 + 三角里的小圈）都是从 S.hue / S.sv 画的，
    // 所以颜色一变就得重画 —— 以前只有「点色轮」那条路会调 drawWheel，
    // 于是拖 RGB / HSV 滑块、点色板、吸管取色之后，色轮原地不动，看着像没生效。
    drawWheel();
    markPaletteSelection();
    if (remember !== false) pushRecent(hex);
  }

  /* 「最近使用」：换色快的时候全靠它。记在本地，重开还在。 */
  var RECENT_KEY = 'chahu.recent';

  function loadRecent() {
    var raw = null;
    try { raw = JSON.parse(lsGet(RECENT_KEY, 'null')); } catch (e) { raw = null; }
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c); }).slice(0, 12);
  }

  function renderRecent() {
    var box = $('#recentColors');
    if (!box) return;
    box.innerHTML = '';
    S.recent.forEach(function (c) {
      var i = document.createElement('i');
      i.style.background = c;
      i.title = c + '（点一下就用它）';
      i.onclick = function () { setColor(c, false); };
      box.appendChild(i);
    });
    var head = $('#recentHead');
    if (head) head.classList.toggle('hidden', S.recent.length === 0);
  }

  function pushRecent(hex) {
    S.recent = S.recent.filter(function (c) { return c.toLowerCase() !== hex.toLowerCase(); });
    S.recent.unshift(hex);
    if (S.recent.length > 12) S.recent.length = 12;
    lsSet(RECENT_KEY, JSON.stringify(S.recent));
    renderRecent();
  }

  /* ============================================================ 顶栏 */

  function renderRoomChip() {
    var r = S.room;
    $('#roomTitle').textContent = r ? r.name : '未加入房间';
    if (!r) { $('#roomMeta').textContent = '—'; $('#canvasSize').textContent = '—'; return; }
    $('#roomMeta').textContent = r.width + '×' + r.height + ' · 在线 ' + (r.online || 0) + ' 人';
    $('#canvasSize').textContent = r.width + ' × ' + r.height + ' · ' + engine.strokes.length + ' 笔';
    $('#stageEmpty').classList.toggle('hidden', S.joined);
  }

  function renderConn(status) {
    var dot = $('#connDot');
    dot.className = 'dot';
    if (status === 'online') dot.classList.add(net.isLocal() ? 'off' : 'on');
    else if (status === 'connecting') dot.classList.add('off');
    else if (status === 'offline') dot.classList.add('err');
    var label = { idle: '未连接', connecting: '连接中', online: net.isLocal() ? '离线模式' : '已连接', offline: '已断开' }[status] || status;
    if (status === 'online' && net.latency && !net.isLocal()) label += ' · ' + net.latency + 'ms';
    if (S.room) $('#roomMeta').textContent = S.room.width + '×' + S.room.height + ' · 在线 ' + (S.room.online || 0) + ' 人 · ' + label;
    if (status === 'offline') setStatus('连接断开，正在重连…');
    else if (status === 'online') setStatus(net.isLocal()
      ? ('离线模式 · 自己单机画' + (srvState.on ? '（服务器仍在后台跑）' : ''))
      : ('已连接 ' + net.url));
  }

  /* ============================================================ 图层 */

  var EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.5 5.4A9.9 9.9 0 0 1 12 5c6.4 0 10 6 10 6a17 17 0 0 1-3 3.4M6.3 7.2A17.5 17.5 0 0 0 2 11s3.6 6 10 6c1 0 1.9-.1 2.7-.4"/></svg>';

  /** 头顶栏和那几个操作按钮现在在改谁：'group' 还是 'layer' */
  function selKind() {
    return (S.selGroup && engine.getGroup(S.selGroup)) ? 'group' : 'layer';
  }
  function selectedGroup() {
    return S.selGroup ? engine.getGroup(S.selGroup) : null;
  }

  /** ★ v2.0.10：进 / 出蒙版编辑。提到模块级是因为**图层行里的那张蒙版缩略图**也要调它
   *  （以前它定义在 bindUI 里面，缩略图点一下会 ReferenceError: setMaskEdit is not defined）。 */
  function setMaskEdit(id) {
    var l = id ? engine.getLayer(id) : null;
    if (!l || !l.hasMask) id = null;
    S.maskEdit = id;
    if (id) toast('正在编辑「' + l.name + '」的蒙版 —— 黑笔遮住、白笔露出');
    syncMaskHead(engine.activeLayer());
    renderLayers();
  }

  function renderLayers() {
    var box = $('#layerList');
    box.innerHTML = '';
    // 面板自上而下 = 合成顺序（自下而上）倒过来。组行画在**它那一块的最上面**
    // （和 PS / SAI 一致），所以从顶往下扫，第一次碰到某组的成员时就在那里插组行。
    var list = engine.layers;
    var emitted = {};
    for (var i = list.length - 1; i >= 0; i--) {
      var l = list[i];
      var g = engine.groupOf(l);
      if (!g) { box.appendChild(layerRowEl(l, false)); continue; }
      if (!emitted[g.id]) {
        emitted[g.id] = 1;
        box.appendChild(groupRowEl(g));
      }
      // 折叠**只影响面板**：画布上照样在合成（PS 的折叠也是这个意思）
      if (!g.collapsed) box.appendChild(layerRowEl(l, true));
    }
    syncLayerHead();
  }

  /* ---------------- 图层面板：按住拖动排序 ---------------- */

  /**
   * 面板顺序（自上而下）的两份视图：
   *   ids  —— 每个图层一行，顺序 = 眼睛看到的顺序（折叠的组也照样把成员列进去）
   *   rows —— 真正画出来的行，一行一个；组行记它顶上那个成员的下标
   * 两者一一对应，所以「行与行之间的插入位 k」可以直接换算成 ids 的下标。
   */
  function layerRowsInfo() {
    var list = engine.layers, ids = [], rows = [], emitted = {};
    for (var i = list.length - 1; i >= 0; i--) {
      var l = list[i], g = engine.groupOf(l);
      ids.push(l.id);
      if (!g) { rows.push({ member: l.id, idsIdx: ids.length - 1, gid: null }); continue; }
      if (!emitted[g.id]) {
        emitted[g.id] = 1;
        rows.push({ member: null, idsIdx: ids.length - 1, gid: g.id });
      }
      if (!g.collapsed) rows.push({ member: l.id, idsIdx: ids.length - 1, gid: g.id });
    }
    return { ids: ids, rows: rows };
  }

  function layerRowEls() {
    var box = $('#layerList');
    if (!box) return [];
    return Array.prototype.filter.call(box.children, function (c) {
      return !c.classList.contains('layer-drop');
    });
  }

  /** 指针在纵坐标 y 上，应该插到「第几行的前面」（0 = 最上面，行数 = 最下面） */
  function layerDropK(y) {
    var els = layerRowEls();
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return els.length;
  }

  var dropLineEl = null;
  function showLayerDropLine(k) {
    var box = $('#layerList');
    if (!box) return;
    if (!dropLineEl) {
      dropLineEl = document.createElement('div');
      dropLineEl.className = 'layer-drop';
      box.appendChild(dropLineEl);
    }
    var els = layerRowEls();
    var y = 0;
    if (els.length) {
      if (k <= 0) y = els[0].offsetTop - 1;
      else if (k >= els.length) {
        var last = els[els.length - 1];
        y = last.offsetTop + last.offsetHeight - 1;
      } else y = els[k].offsetTop - 1;
    }
    dropLineEl.style.top = Math.max(0, y) + 'px';
  }

  function hideLayerDropLine() {
    if (dropLineEl && dropLineEl.parentNode) dropLineEl.parentNode.removeChild(dropLineEl);
    dropLineEl = null;
  }

  /**
   * 落定一次拖动。
   * @param {{kind:'layer'|'group', id:string}} drag 被拖的是单层还是整组
   * @param {number} k 「插到第几行的前面」，行数即最底部
   *
   * 一条 LAYER_ORDER 同时表达两件事：整套顺序、以及（拖单层时）它在落点处
   * 该不该属于某个组 —— 服务的规则是「同组必须连续」（rooms.reorderLayers）。
   */
  function commitLayerDrag(drag, k) {
    if (!S.joined || !drag) return;
    var info = layerRowsInfo();
    var ids = info.ids, rows = info.rows;
    if (k < 0) k = 0;
    if (k > rows.length) k = rows.length;
    var at = (k >= rows.length) ? ids.length : rows[k].idsIdx;

    var i;
    var block;
    if (drag.kind === 'group') {
      // 整组拖动 = 把它名下所有成员当成一个连续的块挪过去。
      // ⚠ 这里**绝不能**把组降级成单层拖动（曾经对「只有一个成员的组」这么干过）：
      // 单层那条路会带上 layerId，服务端就按 groupId 重写归属 —— 而整组拖动时
      // 落点下面那一行往往还是组内成员，算出来的 gid 却是 null，于是拖一次组
      // 反而把成员从组里踢了出去（组凭空解散）。只在 order 里挪位置、layerId 留空，
      // 服务端就只动顺序、完全不碰归属。
      block = ids.filter(function (id) {
        var l = engine.getLayer(id);
        var g = l ? engine.groupOf(l) : null;
        return g && g.id === drag.id;
      });
      if (!block.length) return;         // 空组没得拖
    } else {
      if (ids.indexOf(drag.id) < 0) return;
      block = [drag.id];
    }

    // 从 ids 里整块摘出来，再插到落点
    var first = Math.min.apply(null, block.map(function (id) { return ids.indexOf(id); }));
    var rest = ids.filter(function (id) { return block.indexOf(id) < 0; });
    var adj = at > first ? Math.max(first, at - block.length) : at;
    var next = rest.slice(0, adj).concat(block, rest.slice(adj));

    // 落点下面那一行如果是某个（展开的）组的成员，就归进那个组；否则脱离组
    var gid = null;
    if (drag.kind === 'layer') {
      var below = rows[k] || null;
      if (below && below.member) {
        var bl = engine.getLayer(below.member);
        var bg = bl ? engine.groupOf(bl) : null;
        if (bg && !bg.collapsed) gid = bg.id;
      }
    }
    // 面板顺序 → 合成顺序（引擎里是自下而上）
    var order = next.slice().reverse();
    net.send(P.C2S.LAYER_ORDER, {
      order: order,
      layerId: drag.kind === 'layer' ? drag.id : null,
      groupId: gid
    });
  }

  var dragCand = null, dragDocBound = false, dragSuppressClick = false;

  function onLayerRowDown(e) {
    if (e.button !== 0 || !S.joined) return;
    var el = e.currentTarget;
    // 眼睛 / 折叠 / 行内按钮 / 改名输入框上不启动拖动
    var t = e.target;
    if (t && t.closest && t.closest('button, input, select, textarea')) return;
    if (el.dataset.id) dragCand = { kind: 'layer', id: el.dataset.id, el: el, y: e.clientY, started: false };
    else if (el.dataset.groupId) dragCand = { kind: 'group', id: el.dataset.groupId, el: el, y: e.clientY, started: false };
    else return;
    if (!dragDocBound) {
      document.addEventListener('pointermove', onLayerRowMove, true);
      document.addEventListener('pointerup', onLayerRowUp, true);
      document.addEventListener('pointercancel', onLayerRowUp, true);
      dragDocBound = true;
    }
  }

  function onLayerRowMove(e) {
    if (!dragCand) return;
    if (!dragCand.started) {
      if (Math.abs(e.clientY - dragCand.y) < 4) return;
      dragCand.started = true;
      dragCand.el.classList.add('dragging');
      var box = $('#layerList');
      if (box) box.classList.add('dragging-list');
    }
    e.preventDefault();
    dragCand.k = layerDropK(e.clientY);
    showLayerDropLine(dragCand.k);
  }

  function onLayerRowUp(e) {
    if (!dragCand) return;
    var cand = dragCand;
    dragCand = null;
    var box = $('#layerList');
    if (box) box.classList.remove('dragging-list');
    cand.el.classList.remove('dragging');
    hideLayerDropLine();
    if (!cand.started) return;
    // 拖完别把这一下当成「点一下选中」
    dragSuppressClick = true;
    setTimeout(function () { dragSuppressClick = false; }, 0);
    var k = (typeof cand.k === 'number') ? cand.k : layerDropK(e.clientY);
    commitLayerDrag({ kind: cand.kind, id: cand.id }, k);
  }

  function layerDragBound() { return dragSuppressClick; }

  /** 行内改名（图层与组共用同一套） */
  function renameInline(box, current, commit) {
    var inp = document.createElement('input');
    inp.value = current;
    box.innerHTML = '';
    box.appendChild(inp);
    inp.focus(); inp.select();
    inp.onblur = function () { commit(inp.value.trim() || current); };
    inp.onkeydown = function (ev) {
      if (ev.key === 'Enter') inp.blur();
      if (ev.key === 'Escape') { inp.value = current; inp.blur(); }
      ev.stopPropagation();
    };
  }

  function layerRowEl(l, inGroup) {
    var row = document.createElement('div');
    row.className = 'layer-item' + (inGroup ? ' in-group' : '') +
      (l.id === engine.activeLayerId && selKind() === 'layer' ? ' active' : '') +
      (l.visible ? '' : ' hidden-layer') + (l.locked ? ' locked-layer' : '') +
      (engine.isLocallyHidden(l) ? ' local-hidden-layer' : '');
    row.dataset.id = l.id;

    var eye = document.createElement('button');
    eye.className = 'eye';
    eye.innerHTML = l.visible ? EYE_ON : EYE_OFF;
    eye.title = l.visible
      ? '对所有人隐藏这一层（会同步给别人）—— 只想自己看不到就点右边那只眼睛'
      : '对所有人显示这一层（会同步给别人）';
    eye.onclick = function (e) {
      e.stopPropagation();
      net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { visible: !l.visible } });
    };
    row.appendChild(eye);

    // 第二只眼睛：只对我隐藏（不同步、不影响导出）
    var mine = document.createElement('button');
    mine.className = 'eye mine-eye' + (engine.isLocallyHidden(l) ? ' local' : '');
    mine.innerHTML = EYE_ON;
    mine.title = engine.isLocallyHidden(l)
      ? '只对我隐藏（别人不受影响，导出也照样包含）—— 点一下恢复'
      : '只对我隐藏这一层：看底稿用，别人那边不受影响，导出也照样包含';
    mine.onclick = function (e) {
      e.stopPropagation();
      toggleLocalHidden(l.id);
    };
    row.appendChild(mine);

    var th = document.createElement('div');
    th.className = 'thumb';
    if (l.thumb) th.style.backgroundImage = 'url(' + l.thumb + ')';
    row.appendChild(th);

    // ★ v2.0.10：**蒙版缩略图**（SAI2 把它挂在图层缩略图右边，往里缩进、样式也不同）——
    //   点它就能进 / 出蒙版编辑（省得每次都去点下面那颗「编辑蒙版」按钮），
    //   Alt+点 = 临时关掉 / 打开这张蒙版（对应 SAI2 里蒙版缩略图上的那一下开关）。
    if (l.hasMask) {
      var mth = document.createElement('div');
      mth.className = 'thumb mask-thumb' +
        (S.maskEdit === l.id ? ' on' : '') + (l.maskEnabled === false ? ' off' : '');
      if (l.maskThumb) mth.style.backgroundImage = 'url(' + l.maskThumb + ')';
      mth.title = (S.maskEdit === l.id ? '正在编辑这张蒙版（点一下退出）' : '点一下进入蒙版编辑')
        + ' · Alt+点 = ' + (l.maskEnabled === false ? '启用' : '临时关掉') + '这张蒙版';
      mth.onclick = function (e) {
        e.stopPropagation();
        if (layerDragBound()) return;
        if (e.altKey) {
          net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { maskEnabled: l.maskEnabled === false } });
          return;
        }
        setMaskEdit(S.maskEdit === l.id ? null : l.id);
      };
      row.appendChild(mth);
    }

    var nm = document.createElement('div');
    nm.className = 'lname';
    nm.innerHTML = '<span>' + esc(l.name) + '</span>' +
      '<span class="lmeta">' + esc(P.BLEND_LABELS[l.blend] || l.blend) + ' · ' + Math.round(l.opacity * 100) + '%' +
      (l.locked ? ' · 全部锁' : '') +
      (l.drawLock ? ' · 锁画笔' : '') +
      (l.moveLock ? ' · 锁移动' : '') +
      (l.alphaLock ? ' · 锁透明' : '') +
      (l.selSample ? ' · 选区样本' : '') + '</span>';
    nm.title = '双击重命名';
    nm.ondblclick = function (e) {
      e.stopPropagation();
      renameInline(nm, l.name, function (v) {
        net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { name: v } });
      });
    };
    row.appendChild(nm);

    // 按住整行可以拖动排序（眼睛 / 名字双击改名 / 行内按钮都不受影响）
    row.addEventListener('pointerdown', onLayerRowDown);
    row.onclick = function () {
      if (layerDragBound()) return;
      S.selGroup = null;
      engine.setActiveLayer(l.id);      // 会触发 renderLayers
      syncLayerHead();
    };
    return row;
  }

  /**
   * 组行。折叠箭头 / 眼睛 / 名字 / 「N 层」，外加两个**后果差很远**的按钮：
   * 「解散」把图层留在原位，「✕」连组里的图层一起删 —— 所以分成两个，
   * 不合成一个「确定吗」的弹窗。
   */
  function groupRowEl(g) {
    var n = engine.layers.reduce(function (c, x) { return c + (x.groupId === g.id ? 1 : 0); }, 0);
    var row = document.createElement('div');
    row.className = 'layer-item group-row' +
      (selKind() === 'group' && S.selGroup === g.id ? ' active' : '') +
      (g.visible ? '' : ' hidden-layer') +
      (engine.isLocallyHidden(g.id) ? ' local-hidden-layer' : '');
    row.dataset.groupId = g.id;

    var fold = document.createElement('button');
    fold.className = 'fold';
    fold.textContent = g.collapsed ? '▸' : '▾';
    fold.title = g.collapsed ? '展开这个组' : '折叠这个组（只影响面板，画布上照样显示）';
    fold.onclick = function (e) {
      e.stopPropagation();
      net.send(P.C2S.GROUP_UPD, { groupId: g.id, patch: { collapsed: !g.collapsed } });
    };
    row.appendChild(fold);

    var eye = document.createElement('button');
    eye.className = 'eye';
    eye.innerHTML = g.visible ? EYE_ON : EYE_OFF;
    eye.title = g.visible
      ? '对所有人隐藏整个组（组里的图层都不显示）'
      : '对所有人显示整个组';
    eye.onclick = function (e) {
      e.stopPropagation();
      net.send(P.C2S.GROUP_UPD, { groupId: g.id, patch: { visible: !g.visible } });
    };
    row.appendChild(eye);

    var mine = document.createElement('button');
    mine.className = 'eye mine-eye' + (engine.isLocallyHidden(g.id) ? ' local' : '');
    mine.innerHTML = EYE_ON;
    mine.title = engine.isLocallyHidden(g.id)
      ? '只对我隐藏这个组（别人不受影响，导出也照样包含）—— 点一下恢复'
      : '只对我隐藏这个组：看底稿用，别人那边不受影响，导出也照样包含';
    mine.onclick = function (e) {
      e.stopPropagation();
      toggleLocalHidden(g.id);
    };
    row.appendChild(mine);

    var th = document.createElement('div');
    th.className = 'thumb group-thumb';
    row.appendChild(th);

    var nm = document.createElement('div');
    nm.className = 'lname';
    nm.innerHTML = '<span>' + esc(g.name) + '<i class="gbadge">组</i></span>' +
      '<span class="lmeta">' + esc(P.BLEND_LABELS[g.blend] || g.blend) + ' · ' +
      Math.round(g.opacity * 100) + '% · ' + n + ' 层</span>';
    nm.title = '双击重命名';
    nm.ondblclick = function (e) {
      e.stopPropagation();
      renameInline(nm, g.name, function (v) {
        net.send(P.C2S.GROUP_UPD, { groupId: g.id, patch: { name: v } });
      });
    };
    row.appendChild(nm);

    var un = document.createElement('button');
    un.className = 'rowbtn';
    un.textContent = '解散';
    un.title = '解散这个组，组里的图层留在原位（组的不透明度 / 混合模式会跟着消失）';
    un.onclick = function (e) { e.stopPropagation(); groupUngroup(g); };
    row.appendChild(un);

    var del = document.createElement('button');
    del.className = 'rowbtn danger';
    del.textContent = '✕';
    del.title = '删除这个组，连同组里的图层一起删掉';
    del.onclick = function (e) { e.stopPropagation(); groupDelWithLayers(g); };
    row.appendChild(del);

    // 组行同样可以整块拖着走（组里那几层会跟着一起挪）
    row.addEventListener('pointerdown', onLayerRowDown);
    row.onclick = function () {
      if (layerDragBound()) return;
      S.selGroup = g.id;
      renderLayers();
      syncLayerHead();
    };
    return row;
  }

  /** 图层工具条上那几个控件的状态（★ v2.0.10：剪贴是勾选框了，蒙版有独立缩略图） */
  function syncMaskHead(l) {
    var has = !!(l && l.hasMask);
    var clipEl = $('#clipChk');
    if (clipEl) {
      clipEl.checked = !!(l && l.clip);
      clipEl.disabled = !l;
    }
    var add = $('#btnMaskAdd'), ed = $('#btnMaskEdit'), del = $('#btnMaskDel');
    if (add) { add.classList.toggle('hidden', has); add.disabled = !l; }
    if (ed) {
      ed.classList.toggle('hidden', !has);
      // ★ 2.0.9：蒙版那三颗现在是**图标按钮**（和图层操作挤在同一排，照 SAI2 的版面），
      //   图标里没有放字的地方 —— 编辑中这个状态走 title + 「亮起来」，
      //   原来那句 ed.textContent = '退出蒙版' 会直接顶破这一排的版面。
      var editing = !!(l && S.maskEdit === l.id);
      ed.title = editing
        ? '退出蒙版编辑（回到图层像素）'
        : '进入蒙版编辑：之后画下去的都改蒙版（黑遮白露）';
      ed.classList.toggle('on', editing);
    }
    if (del) del.classList.toggle('hidden', !has);
  }

  function syncLayerHead() {
    $('#layerCount').textContent = engine.layers.length;
    var tag = $('#layerSelTag');
    var g = selectedGroup();
    if (tag) {
      tag.textContent = g ? ('正在编辑：' + g.name) : '';
      tag.classList.toggle('hidden', !g);
    }
    if (g) {
      $('#layerBlend').value = g.blend;
      $('#layerOpacity').value = Math.round(g.opacity * 100);
      $('#layerOpacityVal').textContent = Math.round(g.opacity * 100);
      // ★ v2.0.10：锁定那四颗都是**逐层**的东西，组一个都没有 —— 全禁用 + 清空勾选，
      //   免得点了没反应、看起来像坏了
      ['#lockChk', '#lockDrawChk', '#lockMoveChk', '#alphaLockChk', '#selSampleChk'].forEach(function (sel) {
        var el = $(sel);
        if (!el) return;
        el.checked = false;
        el.disabled = true;
      });
      syncMaskHead(null);
      return;
    }
    ['#lockChk', '#lockDrawChk', '#lockMoveChk', '#alphaLockChk', '#selSampleChk'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.disabled = false;
    });
    var l = engine.activeLayer();
    if (!l) return;
    $('#layerBlend').value = l.blend;
    $('#layerOpacity').value = Math.round(l.opacity * 100);
    $('#layerOpacityVal').textContent = Math.round(l.opacity * 100);
    $('#alphaLockChk').checked = !!l.alphaLock;
    $('#lockDrawChk').checked = !!l.drawLock;
    $('#lockMoveChk').checked = !!l.moveLock;
    $('#lockChk').checked = !!l.locked;
    // ★ 2.0.9「指定为选区样本」：整份文档只有一层是样本层，所以这里显示的是
    //   「当前这一层是不是那一层」（单选圆点，照 SAI2）。
    var ssChk = $('#selSampleChk');
    if (ssChk) ssChk.checked = !!l.selSample;
    syncMaskHead(l);
  }

  /** 头顶栏改了：作用在「当前选中的组」还是「当前图层」 */
  function patchActiveLayer(patch) {
    if (!S.joined) return;
    var g = selectedGroup();
    if (g) { net.send(P.C2S.GROUP_UPD, { groupId: g.id, patch: patch }); return; }
    var l = engine.activeLayer();
    if (!l) return;
    net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: patch });
  }

  /** 下面这几个只对单个图层有意义；选中组时按下了就明说，别默默作用到别的图层上 */
  function needLayer(what) {
    if (selKind() !== 'group') return false;
    toast('「' + what + '」只对单个图层有效，先在组里选一层', 'err', 2600);
    return true;
  }

  function layerDup() {
    if (needLayer('复制图层')) return;
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    var png = engine.renderLayerRaw(l.id).toDataURL('image/png');
    net.send(P.C2S.LAYER_DUP, { layerId: l.id, png: png, upToSeq: engine.seq });
  }

  async function layerClear() {
    if (needLayer('清除图层')) return;
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    if (!await confirmDialog('清除图层「' + l.name + '」上的所有内容？', { danger: true })) return;
    net.send(P.C2S.LAYER_CLEAR, { layerId: l.id });
  }

  async function layerDel() {
    // 选中的是组 → 「删除」就是「连组里的图层一起删」。解散走组行上那个「解散」按钮，
    // 两件事后果差得远，不共用一个按钮。
    var sel = selectedGroup();
    if (sel) { await groupDelWithLayers(sel); return; }
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    if (!await confirmDialog('删除图层「' + l.name + '」？', { danger: true })) return;
    net.send(P.C2S.LAYER_DEL, { layerId: l.id });
  }

  function groupSpanOf(l) {
    var i = engine.layers.indexOf(l);
    var lo = i, hi = i;
    for (var k = 0; k < engine.layers.length; k++) {
      if (engine.layers[k].groupId !== l.groupId) continue;
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    return [lo, hi];
  }

  function layerMove(dir) {
    if (!S.joined) return;
    // 选中组 → 整组（连同组里所有图层）挪一格
    var g0 = selectedGroup();
    if (g0) { net.send(P.C2S.GROUP_MOVE, { groupId: g0.id, dir: dir }); return; }
    var l = engine.activeLayer();
    if (!l) return;
    var i = engine.layers.indexOf(l);
    var to = i + dir;
    if (to < 0 || to >= engine.layers.length) { toast('已经到头了'); return; }
    // 组内图层只能在本组那一块里挪。到头了要明说 —— 不然按钮点了没动静，
    // 看起来像坏了（想离开这个组得用「进/出组」）。
    if (l.groupId && engine.groupOf(l)) {
      var span = groupSpanOf(l);
      if (to < span[0] || to > span[1]) {
        toast('已经在组的最' + (dir > 0 ? '上' : '下') + '面了，用「进/出组」才能离开这一组');
        return;
      }
    }
    net.send(P.C2S.LAYER_MOVE, { layerId: l.id, to: to });
  }

  function layerMerge() {
    if (needLayer('向下合并')) return;
    if (!S.joined) return;
    var i = engine.layers.findIndex(function (l) { return l.id === engine.activeLayerId; });
    if (i <= 0) { toast('最下面的图层没有可合并的对象', 'err'); return; }
    var src = engine.layers[i], dst = engine.layers[i - 1];
    var merged = document.createElement('canvas');
    merged.width = engine.width; merged.height = engine.height;
    var mc = merged.getContext('2d');
    mc.drawImage(engine.renderLayerRaw(dst.id), 0, 0);
    mc.globalAlpha = src.opacity;
    mc.globalCompositeOperation = global.CanvasEngine.blendOp(src.blend);
    mc.drawImage(engine.renderLayerRaw(src.id), 0, 0);
    mc.globalAlpha = 1;
    mc.globalCompositeOperation = 'source-over';
    net.send(P.C2S.LAYER_MERGE, {
      srcId: src.id, dstId: dst.id,
      png: merged.toDataURL('image/png'), upToSeq: engine.seq
    });
    toast('正在合并「' + src.name + '」到「' + dst.name + '」…');
  }

  /**
   * 「将该图层的内容转移到下层」。
   * 和「向下合并」只差一件事：**不施加本层的不透明度 / 混合模式**，
   * 原始像素照原样倒进下层，本层留下但被清空（SAI 里就是这么分的两个命令）。
   * 两条现成的消息就够：下层整体换像素 + 本层清空。
   */
  function layerMoveContentDown() {
    if (needLayer('将该图层内容转移到下层')) return;
    if (!S.joined) return;
    var i = engine.layers.findIndex(function (l) { return l.id === engine.activeLayerId; });
    if (i <= 0) { toast('最下面的图层没有下层可以接收', 'err'); return; }
    var src = engine.layers[i], dst = engine.layers[i - 1];
    if (!src || !dst) return;
    var merged = document.createElement('canvas');
    merged.width = engine.width; merged.height = engine.height;
    var mc = merged.getContext('2d');
    mc.drawImage(engine.renderLayerRaw(dst.id), 0, 0);
    mc.drawImage(engine.renderLayerRaw(src.id), 0, 0);
    net.send(P.C2S.LAYER_PIXELS, {
      layerId: dst.id, png: merged.toDataURL('image/png'), upToSeq: engine.seq
    });
    net.send(P.C2S.LAYER_CLEAR, { layerId: src.id });
    toast('「' + src.name + '」的内容已转移到「' + dst.name + '」', 'ok', 2400);
  }

  /* ---------------- 图层组的操作 ---------------- */

  /**
   * 组合：把当前图层装进一个新建的组。
   * 组 id 由**客户端**指定（和新建图层一个道理）：建完要立刻把它选中、
   * 好直接改名字和不透明度，不能等一个来回才知道它叫什么。
   */
  function groupAdd() {
    if (!S.joined) { toast('还没有进入房间'); return; }
    var bm = canvasBlockMsg();
    if (bm) { toast(bm, 'err', 1800); return; }
    if (S.selGroup && !engine.getGroup(S.selGroup)) S.selGroup = null;
    if (S.selGroup) { toast('当前选中的就是一个组，先选它里面的某一层', 'err', 2400); return; }
    var l = engine.activeLayer();
    if (!l) return;
    var id = P.rid('G');
    net.send(P.C2S.GROUP_ADD, { id: id, name: l.name || '组', layerId: l.id });
    S.selGroup = id;              // 建完直接选中，方便马上调组的浓度
    toast('已把「' + l.name + '」装进一个新组', 'ok', 2200);
  }

  /** 进/出组：不在组里就挪进「紧挨着它上面的那个组」，已经在组里就挪出来 */
  function groupToggle() {
    if (!S.joined) { toast('还没有进入房间'); return; }
    var bm = canvasBlockMsg();
    if (bm) { toast(bm, 'err', 1800); return; }
    if (selKind() === 'group') { toast('先选中组里的某一层', 'err', 2200); return; }
    var l = engine.activeLayer();
    if (!l) return;
    if (l.groupId && engine.groupOf(l)) {
      net.send(P.C2S.LAYER_GROUP, { layerId: l.id, groupId: null });
      toast('已把「' + l.name + '」移出组', 'ok', 2200);
      return;
    }
    // 「上面」= 合成顺序里索引更大的方向（面板上看到的是它在上面）
    var i = engine.layers.indexOf(l);
    var target = null;
    for (var k = i + 1; k < engine.layers.length; k++) {
      var g = engine.groupOf(engine.layers[k]);
      if (g) { target = g; break; }
    }
    if (!target) { toast('上面没有可以进的组，先用「组合」建一个'); return; }
    net.send(P.C2S.LAYER_GROUP, { layerId: l.id, groupId: target.id });
    toast('已把「' + l.name + '」移进「' + target.name + '」', 'ok', 2400);
  }

  /** 解散组：图层留在原位。组的不透明度/混合模式会跟着消失，画面是会变的 */
  function groupUngroup(g) {
    g = g || selectedGroup();
    if (!g) { toast('先选中一个组', 'err', 2000); return; }
    if (!S.joined) return;
    var bm = canvasBlockMsg();
    if (bm) { toast(bm, 'err', 1800); return; }
    net.send(P.C2S.GROUP_DEL, { groupId: g.id, withLayers: false });
    if (S.selGroup === g.id) S.selGroup = null;
    toast('已解散「' + g.name + '」，里面的图层留在原位');
  }

  /** 删除组及组内所有图层 */
  async function groupDelWithLayers(g) {
    g = g || selectedGroup();
    if (!g) { toast('先选中一个组', 'err', 2000); return; }
    if (!S.joined) return;
    var bm = canvasBlockMsg();
    if (bm) { toast(bm, 'err', 1800); return; }
    var n = engine.layers.reduce(function (c, x) { return c + (x.groupId === g.id ? 1 : 0); }, 0);
    if (!await confirmDialog('删除组「' + g.name + '」以及里面的 ' + n + ' 个图层？',
        { danger: true })) return;
    net.send(P.C2S.GROUP_DEL, { groupId: g.id, withLayers: true });
    if (S.selGroup === g.id) S.selGroup = null;
  }

  async function layerFlatten() {
    if (!S.joined) return;
    if (!await confirmDialog('把所有可见图层合并为一层？此操作会把当前画面固化为一张底图。', { danger: true })) return;
    var png = engine.renderDocument({ transparentBackground: true }).canvas.toDataURL('image/png');
    net.send(P.C2S.LAYER_FLATTEN, { png: png, upToSeq: engine.seq, name: '合并图层' });
  }

  /* ================================================================
   * 笔刷导入：Photoshop 的 .abr 与 Clip Studio Paint 的 .sut
   *
   * 导入的是**笔尖形状 + 能量化的参数**，不是把 PS 的描边引擎搬过来。
   * 笔尖打包成 32×32 的 4 位灰度小图跟着笔迹走，所以别人的屏幕上
   * 也能画出同样的笔触（跨端像素一致这条不能破）。
   * ================================================================ */

  var LS_IMPORTED = 'chahu.brushes.imported';
  var IMPORT_MAX = 160;          // 导入总量上限（要进 localStorage，还得跟着每一笔走）

  function loadImported() {
    var list = [];
    try {
      var raw = localStorage.getItem(LS_IMPORTED);
      if (raw) list = JSON.parse(raw) || [];
    } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = list.filter(function (it) { return it && it.id && it.params && it.params.tip; }).slice(0, IMPORT_MAX);
    Brushes.register(list);
    return list;
  }

  function saveImported() {
    try {
      localStorage.setItem(LS_IMPORTED, JSON.stringify(S.imported || []));
      return true;
    } catch (e) {
      toast('保存失败（本地存储写不下了）：' + e.message, 'err');
      return false;
    }
  }

  function simpleHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(36);
  }

  /** 把解析出来的笔尖变成一支可用的笔刷条目 */
  function importedItem(rec, idx) {
    var d = Math.max(4, Math.min(400, Math.round(rec.diameter || 40)));
    var params = {
      brush: 'custom',
      size: d,
      opacity: 1,
      hardness: rec.hardness == null ? 0.8 : rec.hardness,
      minSize: 0.4,
      pressSize: 0.8,
      pressOpacity: 0,
      // 导入的笔刷靠笔尖出形状，默认关掉颗粒与散布 ——
      // 那两样是给圆头笔加质感的，叠在笔尖上只会把形状糊掉
      grain: 0,
      scatter: 0,
      spacing: rec.spacing || 0.1,
      tip: rec.tip
    };
    // Procreate 那边能对应上的参数比 .abr / .sut 多（压力→尺寸/浓度、混色、
    // 颗粒粗细、最小直径…），解析器把映射结果放在 rec.opts 里。
    // tip 和 brush 是这支笔的身份，不接受覆盖。
    if (rec.opts) {
      for (var k in rec.opts) {
        if (!Object.prototype.hasOwnProperty.call(rec.opts, k)) continue;
        if (k === 'tip' || k === 'brush') continue;
        if (rec.opts[k] === undefined || rec.opts[k] === null) continue;
        params[k] = rec.opts[k];
      }
    }
    params.tip = rec.tip;
    params.brush = 'custom';
    return {
      id: 'imp_' + (rec.hash || 'x') + '_' + idx,
      name: rec.name || ('导入笔刷 ' + (idx + 1)),
      tool: 'brush',
      icon: 'imported',
      type: 'brush',
      tip: '导入的笔刷（' + (rec.sourceLabel || '') + '）｜笔尖 ' + d + 'px',
      imported: true,
      params: params
    };
  }

  function openBrushImport() {
    var input = $('#brushFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function handleBrushFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var slots = new Array(list.length);
    var pending = list.length;
    var failed = [];

    // 先把**所有**文件读进来再解析：SAI2 的笔尖形状（blotmap BMP）是独立的兄弟文件，
    // 解析 .saitdat 时要能顺手把它配起来（见 brush-import.js 的 parseSaitdat）。
    list.forEach(function (f, idx) {
      var fr = new FileReader();
      fr.onload = function () { slots[idx] = { name: f.name, bytes: new Uint8Array(fr.result) }; step(); };
      fr.onerror = function () { failed.push(f.name + '：读取失败'); step(); };
      fr.readAsArrayBuffer(f);
    });

    function step() { if (--pending > 0) return; finish(); }

    function finish() {
      var ok = slots.filter(Boolean);
      var collected = [];
      var skipped = 0;
      ok.forEach(function (f) {
        // 兄弟素材只是给 .saitdat 当参考，不单独当一支笔导入
        if (/\.(bmp|ini|saitlnk|png|jpe?g)$/i.test(f.name)) { skipped++; return; }
        try {
          var res = window.ChaBrushImport.parse(f.name, f.bytes, { siblings: ok });
          if (!res.brushes.length) throw new Error('里面没有可导入的笔刷');
          var KIND_LABEL = {
            abr: 'Photoshop', sut: 'CSP', procreate: 'Procreate',
            sai: 'SAI2', bru: '画世界Pro'
          };
          res.brushes.slice(0, IMPORT_MAX).forEach(function (b) {
            var kind = KIND_LABEL[res.kind] || res.kind;
            b.sourceLabel = f.name + '（' + kind + (b.note ? ' · ' + b.note : '') + '）';
            b.hash = simpleHash(f.name + '|' + (b.name || '') + '|' + String(b.tip || '').slice(0, 32));
            collected.push(b);
          });
        } catch (e) {
          failed.push(f.name + '：' + e.message);
        }
      });
      if (failed.length) toast('这些文件没能解析：' + failed.join('；'), 'err', 6000);
      if (!collected.length) {
        // 只选了素材（BMP 之类）时不能一声不响 —— 用户会以为导入坏了
        if (skipped && !failed.length) {
          toast('这些是笔刷的素材文件，要和笔刷定义（.saitdat）一起选才会被读进去', 'err', 5500);
        }
        return;
      }
      showImportDialog(collected, (S.imported || []).length);
    }
  }

  /** 笔尖预览：把打包的 4 位小图放大画出来（深色笔尖，浅底上看得清） */
  function tipThumb(tipStr, size) {
    var u = window.ChaBrushImport.unpackTip(tipStr);
    if (!u) return '';
    var c = document.createElement('canvas');
    c.width = u.w; c.height = u.h;
    var cx = c.getContext('2d');
    var img = cx.createImageData(u.w, u.h);
    for (var p = 0; p < u.w * u.h; p++) {
      img.data[p * 4] = 30;
      img.data[p * 4 + 1] = 34;
      img.data[p * 4 + 2] = 42;
      img.data[p * 4 + 3] = u.rgba[p * 4 + 3];
    }
    cx.putImageData(img, 0, 0);
    var out = document.createElement('canvas');
    out.width = out.height = size;
    var oc = out.getContext('2d');
    oc.imageSmoothingEnabled = true;
    var s = size - 6;
    oc.drawImage(c, 3, 3, s, s);
    return out.toDataURL('image/png');
  }

  function showImportDialog(found, existing) {
    var body = $('#importBody');
    var room = Math.max(0, IMPORT_MAX - existing);
    if (room <= 0) {
      toast('导入的笔刷已达上限 ' + IMPORT_MAX + ' 支，先删掉一些再导', 'err', 5000);
      return;
    }
    $('#importTitle').textContent = '导入笔刷（发现 ' + found.length + ' 支）';
    $('#importNote').textContent = found.length > room
      ? '本地已有 ' + existing + ' 支，最多还能导入 ' + room + ' 支 —— 只会取前 ' + room + ' 支。'
      : '本地已有 ' + existing + ' 支导入笔刷。勾选要加入「笔刷栏」的笔刷。';
    body.innerHTML = '';
    var pick = found.slice(0, room);
    S.importPending = pick;
    pick.forEach(function (b, i) {
      var row = document.createElement('label');
      row.className = 'imp-row';
      // 纯色笔尖（flat）：文件里只有一张「一片一个色」的图，可能是真·实心方头笔尖，
      // 也可能是素材库的空白预览图 —— 单看图分不出来，所以不替用户做主，只在预览旁边挂一句提醒。
      if (b.flat) row.className += ' imp-flat';
      var bits = [];
      if (b.diameter) bits.push(b.diameter + 'px');
      if (b.spacing) bits.push('间距 ' + Math.round(b.spacing * 100) + '%');
      if (b.hardness != null) bits.push('硬度 ' + b.hardness.toFixed(2));
      if (b.flat) bits.push('⚠ 纯色笔尖');
      var thumb = b.tip ? tipThumb(b.tip, 34) : '';
      row.innerHTML =
        '<input type="checkbox" checked data-i="' + i + '">' +
        (thumb ? '<img class="imp-tip" src="' + thumb + '" alt="">' : '<span class="imp-tip"></span>') +
        '<span class="imp-name">' + esc(b.name) + '</span>' +
        '<span class="imp-meta">' + esc(bits.join(' · ')) + '</span>';
      // 来源 + 备注（SAI2 的「笔尖形状取自 xx.bmp」这类）挂在 title 上 ——
      // 一行里塞不下，但用户悬停一下就能确认这支笔是从哪个文件、按什么规则读出来的。
      var tips = [];
      if (b.flat) {
        tips.push('这支笔的文件里只有一张纯色图（多半是「实心方头」这类笔尖，'
          + '也可能是素材库的空白预览图）。左边就是它的笔尖预览 —— 对不上就别勾。');
      }
      if (b.sourceLabel) tips.push('来源：' + b.sourceLabel);
      if (tips.length) row.title = tips.join('\n');
      body.appendChild(row);
    });
    $('#importMask').classList.remove('hidden');
    // 注意这里必须用 $$（querySelectorAll 的数组版），用 $ 拿到的是单个元素，
    // 没有 forEach —— 曾经三个按钮全是哑的，点了没反应也不报错到界面上。
    function boxes() { return $$('#importBody input[type=checkbox]'); }
    $('#btnImportAll').onclick = function () {
      boxes().forEach(function (c) { c.checked = true; });
    };
    $('#btnImportNone').onclick = function () {
      boxes().forEach(function (c) { c.checked = false; });
    };
    $('#btnImportCancel').onclick = function () { $('#importMask').classList.add('hidden'); };
    $('#btnImportOk').onclick = function () {
      var keep = [];
      boxes().forEach(function (c) {
        if (c.checked) keep.push(S.importPending[+c.dataset.i]);
      });
      $('#importMask').classList.add('hidden');
      applyImported(keep);
    };
  }

  function applyImported(list) {
    if (!list || !list.length) { toast('没有选中任何笔刷'); return; }
    var base = (S.imported || []).length;
    var items = [];
    list.forEach(function (rec, i) {
      var it = importedItem(rec, base + i);
      // 同一支笔重复导入时覆盖旧的，别堆成一串重名笔刷
      var dup = (S.imported || []).filter(function (x) {
        return x.name === it.name && String(x.tip || '').indexOf(rec.sourceLabel) >= 0;
      })[0];
      if (dup) it.id = dup.id;
      items.push(it);
    });
    Brushes.register(items);
    var ids = {};
    items.forEach(function (it) { ids[it.id] = 1; });
    S.imported = (S.imported || []).filter(function (x) { return !ids[x.id]; }).concat(items).slice(0, IMPORT_MAX);
    items.forEach(function (it) {
      if (S.toolPrefs.order.indexOf(it.id) < 0) S.toolPrefs.order.push(it.id);
    });
    saveImported();
    saveToolPrefs();
    renderToolGrid();
    loadBrush(items[items.length - 1].id);
    toast('已导入 ' + items.length + ' 支笔刷，排在「笔刷栏」最后', 'ok', 4200);
  }

  function removeImported(id) {
    var it = Brushes.get(id);
    if (!it || !it.imported) return;
    S.imported = (S.imported || []).filter(function (x) { return x.id !== id; });
    Brushes.unregister(id);
    var oi = S.toolPrefs.order.indexOf(id);
    if (oi >= 0) S.toolPrefs.order.splice(oi, 1);
    var hi = S.toolPrefs.hidden.indexOf(id);
    if (hi >= 0) S.toolPrefs.hidden.splice(hi, 1);
    saveImported();
    saveToolPrefs();
    if (S.brushId === id) {
      var next = Brushes.forTool('brush')[0] || Brushes.ITEMS[0];
      loadBrush(next.id);
    } else {
      renderToolGrid();
    }
    toast('已删除「' + it.name + '」');
  }

  /* ============================================================ 成员 / 聊天 / 笔迹 */

  function renderMembers() {
    var box = $('#memberList');
    $('#memberCount').textContent = S.members.length;
    // 顶栏那个「观众」标签跟着一起刷新 —— 保证「我能不能画」在界面上永远有出处
    renderMeRole();
    box.innerHTML = '';
    S.members.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'member';
      el.innerHTML =
        avaHtml(m.userId, m.name, m.color) +
        '<div class="info"><b>' + esc(m.name) +
        (m.isOwner ? '<span class="badge">房主</span>' : '') +
        (m.readonly ? '<span class="badge guest">观众</span>' : '') +
        (m.userId === S.me.userId ? '<span class="badge me">我</span>' : '') +
        '</b><span>' + (m.readonly ? '只能看'
          : (m.drawing ? '<span class="live">正在作画…</span>' : '在房间里')) + '</span></div>';

      // 房主的「设观众 / 恢复作画」开关。这是**房内权限**（一按所有人都会收到），
      // 和旁边只管自己屏幕的「笔迹淡化」是两回事，所以样式也分开。
      // 不排除自己：房主把自己设成观众是合法的（把画板让给别人、自己讲解），
      // 而且这条消息不走写操作闸门，随时能改回来。
      if (S.joined && S.me.isOwner) {
        var role = document.createElement('button');
        role.className = 'm-role' + (m.readonly ? ' on' : '');
        role.textContent = m.readonly ? '观众' : '可画';
        role.title = m.readonly
          ? '点一下恢复 ' + m.name + ' 的作画权限'
          : '点一下把 ' + m.name + ' 设为只读观众（能看、能聊，不能改画布）';
        role.onclick = function (e) {
          e.stopPropagation();
          setReadonly(m.userId, !m.readonly);
        };
        el.appendChild(role);
      }

      // 房主可以把身份转给别人（别人退房时本来就有自动移交，这是主动版）。
      // 只对别人显示：转给自己没有意义。
      if (S.joined && S.me.isOwner && m.userId !== S.me.userId) {
        var tr = document.createElement('button');
        tr.className = 'm-transfer';
        tr.textContent = '转让';
        tr.title = '把房主转给 ' + m.name + '（此后由他管理房间：观众 / 清空 / 解散 / 开局等）';
        tr.onclick = function (e) {
          e.stopPropagation();
          transferHost(m.userId, m.name);
        };
        el.appendChild(tr);
      }

      // 别人的笔迹显示得多清楚 —— 点一下循环：跟随全局 → 原样 → 淡 → 隐藏 → 跟随全局
      // （纯本地设置，只改我自己屏幕上看到的）
      if (m.userId !== S.me.userId) {
        var per = S.dimUsers[m.userId];
        var btn = document.createElement('button');
        btn.className = 'm-dim' + (per != null ? ' on' : '');
        btn.textContent = per == null ? '跟' : (per <= 0 ? '隐' : (per >= 1 ? '100' : Math.round(per * 100) + ''));
        btn.title = per == null
          ? '这个人的笔迹跟随全局「' + dimStep().label + '」—— 点一下单独设置（只影响你自己的屏幕）'
          : '这个人的笔迹显示 ' + Math.round(per * 100) + '% —— 点一下换下一档（只影响你自己的屏幕）';
        btn.onclick = function (e) {
          e.stopPropagation();
          // 顺序按「越来越看不见」排：跟着全局 → 淡 → 很淡 → 隐藏 → 原样 → 跟着全局。
          // 第一下点下去一定要有肉眼可见的变化，所以不把「原样」放在第二档
          // （全局本来就不淡的时候，跟着全局和原样看起来一模一样，用户会以为按钮坏了）。
          var opts = [null, 0.45, 0.15, 0, 1];
          var i = opts.findIndex(function (v) {
            return (v == null && per == null) || (v != null && per != null && Math.abs(v - per) < 0.001);
          });
          setUserDim(m.userId, opts[(i + 1) % opts.length]);
          toast(m.name + ' 的笔迹：' + (opts[(i + 1) % opts.length] == null ? '跟随全局'
            : (opts[(i + 1) % opts.length] === 1 ? '原样' : (opts[(i + 1) % opts.length] === 0 ? '不显示' : Math.round(opts[(i + 1) % opts.length] * 100) + '%'))));
        };
        el.appendChild(btn);
      }
      box.appendChild(el);
    });
  }

  function renderChatMsg(m, prepend) {
    var list = $('#chatList');
    var el = document.createElement('div');
    if (m.system) {
      el.className = 'msg system';
      el.innerHTML = '<div class="text">' + esc(m.text) + '</div>';
    } else {
      el.className = 'msg' + (m.userId === S.me.userId ? ' mine' : '');
      var pic = m.img ? P.normalizeSticker(m.img) : '';
      el.innerHTML =
        avaHtml(m.userId, m.name, m.color || '#999') +
        '<div class="body"><div class="head"><b>' + esc(m.name) + '</b><span>' + fmtTime(m.ts) + '</span></div>' +
        (pic ? '<img class="stick" src="' + pic + '" alt="表情" loading="lazy">' : '') +
        (m.text ? '<div class="text">' + esc(m.text) + '</div>' : '') +
        '</div>';
    }
    if (prepend) list.insertBefore(el, list.firstChild);
    else { list.appendChild(el); list.scrollTop = list.scrollHeight; }
  }

  function toolName(t) {
    return {
      brush: '画笔', eraser: '橡皮', blur: '模糊', smudge: '涂抹',
      line: '直线', rect: '矩形', ellipse: '椭圆', fill: '油漆桶',
      gradient: '渐变', select: '选区笔', selectErase: '选区擦', picker: '吸管'
    }[t] || t;
  }

  function renderHistory() {
    $('#strokeCount').textContent = engine.strokes.length;
    var box = $('#historyList');
    $('#historyInfo').textContent = '共 ' + engine.strokes.length + ' 笔 · 我的撤销栈 ' + S.myUndo.length;
    var html = '';
    engine.strokes.slice(-300).reverse().forEach(function (s) {
      var mem = S.members.find(function (m) { return m.userId === s.userId; });
      var who = mem ? mem.name : (s.userId === S.me.userId ? '我' : '某人');
      html += '<div class="hitem' + (s.userId === S.me.userId ? ' mine' : '') + '" data-id="' + esc(s.id) + '">' +
        '<i class="sw" style="background:' + esc(s.color) + '"></i>' +
        '<span class="who">' + esc(who) + ' · ' + esc(toolName(s.tool)) + ' ' + s.points.length + '点</span>' +
        '<span class="when">' + fmtTime(s.ts) + '</span></div>';
    });
    box.innerHTML = html || '<div class="room-empty">还没有笔迹</div>';
    $$('#historyList .hitem').forEach(function (el) {
      el.onclick = function () {
        var s = engine.byId.get(el.dataset.id);
        if (!s) return;
        toast('第 ' + (s.seq || '?') + ' 笔 · ' + toolName(s.tool) + ' · ' + s.points.length + ' 个采样点');
      };
    });
    $('#btnUndo').disabled = !S.opUndo.length;
    $('#btnRedo').disabled = !S.opRedo.length;
  }

  /* ============================================================ 房间面板 */

  function openEntry(show) {
    $('#entryMask').classList.toggle('hidden', !show);
    if (show) {
      $('#nameInput').value = S.me.name || Cfg.getName() || '';
      $('#serverInput').value = net.url || Cfg.resolve();
      renderAvaPreview();
      renderLanBar();
      renderServerToggle();
      refreshServerState();
      if (net.isOpen()) net.send(P.C2S.ROOM_LIST, {});
      else toast('尚未连接到服务器，房间列表可能为空');
      bindCreateSizeToggle();
    }
  }

  /** 桌面端内置服务器起来后，把局域网地址显眼地摆出来 —— 用户最需要的就是这条链接 */
  function renderLanBar() {
    var bar = $('#lanBar');
    if (!bar) return;
    var lan = Cfg.lanBase ? Cfg.lanBase() : '';
    bar.classList.toggle('hidden', !lan);
    if (!lan) return;
    $('#lanAddr').textContent = lan;
  }

  function copyLan() {
    var lan = Cfg.lanBase ? Cfg.lanBase() : '';
    if (!lan) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lan).then(function () {
        toast('局域网地址已复制：' + lan, 'ok', 3200);
      }, function () { toast(lan); });
    } else {
      toast(lan);
    }
  }

  /* ============================================== 本机服务器开关（桌面端） */

  /**
   * 桌面端才有「本机服务器」。网页版必须连别人的服务器，这一整行直接藏掉，
   * 免得摆一个点了永远没反应的按钮在那儿。
   */
  function desktopBridge() {
    var D = global.chahuDesktop;
    return (D && D.isDesktop && D.serverStart) ? D : null;
  }

  /**
   * 离线能力桥：桌面端（主进程里跑服务端）和安卓 shim（WebView 内嵌状态机）都有
   * localOpen。安卓没有「本机服务器」可开（desktopBridge 为 null），
   * 但离线画画这条路是通的 —— 服务器开关那一排 UI 靠它决定显不显。
   */
  function localBridge() {
    var D = global.chahuDesktop;
    return (D && D.localOpen) ? D : null;
  }

  /** 服务器现状：开着吗 / 端口 / 局域网地址。known = 还没问到过 */
  var srvState = { on: false, port: 0, lan: [], known: false };

  function srvLanText() {
    if (!srvState.on || !srvState.lan.length) return '';
    return 'http://' + srvState.lan[0] + (srvState.port ? ':' + srvState.port : '');
  }

  /**
   * 画那颗按钮。**动作**和**状态**刻意分开：按钮上永远写「你现在能做的事」，
   * 右边那行小字才写「现在是什么样」—— 两者混在一个按钮上，用户分不清
   * 「切到离线」到底是当前状态还是将要执行的动作。
   *
   * 三种情形，因为「服务器在不在跑」和「你在不在线」是两件事：
   *   · 服务器没跑          → 按钮「开启服务器」（起一个并连上）
   *   · 服务器在跑 + 你在离线 → 按钮「连回服务器」
   *   · 服务器在跑 + 你在在线 → 按钮「切到离线」（只断开你自己，服务器留着力气）
   */
  function renderServerToggle() {
    var row = $('#srvRow');
    if (!row) return;
    var desk = desktopBridge();
    var local = localBridge();
    if (!desk && !local) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');

    var btn = $('#btnServerToggle');
    var st = $('#srvState');
    var hint = $('#srvHint');

    // 安卓：没有「本机服务器」这回事（desktopBridge 为 null），
    // 按钮只有两态 —— 在线 →「切到离线」，离线 →「连回服务器」。
    if (!desk) {
      btn.disabled = false;
      if (net.isLocal()) {
        btn.textContent = '连回服务器';
        st.className = 'srv-state off';
        st.textContent = '离线模式（当前）';
        hint.textContent = '本机没跑服务器；点这里连回公网 / 局域网服务器。';
      } else {
        btn.textContent = '切到离线';
        st.className = 'srv-state on';
        st.textContent = '已连接 ' + (net.url || '—');
        hint.textContent = '断开网络自己单机画（本机内嵌房间状态机，不占端口不出网）。';
      }
      return;
    }

    if (!srvState.known) {
      btn.textContent = '检测中…';
      btn.disabled = true;
      st.className = 'srv-state';
      st.textContent = '正在读取服务器状态…';
      return;
    }
    btn.disabled = false;
    var offline = net.isLocal();
    var lan = srvLanText();

    if (!srvState.on) {
      btn.textContent = '开启服务器';
      st.className = 'srv-state off';
      st.textContent = offline ? '已关闭 · 离线模式（当前）' : '已关闭';
      hint.textContent = '这台机器还没开服务器 —— 开启后同一 WiFi 的朋友就能加入。';
      return;
    }

    if (offline) {
      btn.textContent = '连回服务器';
      st.className = 'srv-state off';
      st.textContent = '已开启（后台运行）· 当前离线' + (lan ? ' · ' + lan : '');
      hint.textContent = '服务器仍在后台跑，随时可以连回去；离线时自己单机画、不出网。';
      return;
    }

    btn.textContent = '切到离线';
    st.className = 'srv-state on';
    st.textContent = '已开启' + (lan ? ' · ' + lan : (srvState.port ? ' · 端口 ' + srvState.port : ''));
    // 在线，但连的不一定是本机这台（比如手动填了公网地址）—— 那就说清楚，别让人以为
    // 上面那个局域网地址是他现在用的地址。
    var ownWs = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(net.url || '');
    hint.textContent = '点这里只是自己断开、单机画；服务器照旧在后台跑，同一 WiFi 的朋友仍能加入。'
      + (ownWs ? '' : ' 你当前连的是 ' + (net.url || '—') + '。');
  }

  /** 主进程报来的服务器状态（开机问一次，之后它一有变化就会推） */
  function applyServerState(s) {
    if (!s) return;
    srvState.on = !!s.on;
    srvState.port = s.port || 0;
    srvState.lan = s.lan || [];
    srvState.known = true;
    // 局域网地址是「开窗口那一刻」通过 ?lan= 写死的，服务器后来才起来的话 query 已经改不了了，
    // 所以必须能后补。关掉服务器就清空 —— 入口页那条提示自然收起来。
    if (Cfg.setLan) Cfg.setLan(srvLanText());
    renderLanBar();
    renderServerToggle();
    refreshMenuChecks();
  }

  /** 菜单里「其他 → 本机服务器」前面有个 ✓，得跟着状态重画（菜单是启动时一次性渲染的） */
  function refreshMenuChecks() {
    if (global.ChaMenu && global.ChaMenu.buildMenuBar) global.ChaMenu.buildMenuBar();
  }

  function refreshServerState() {
    var D = desktopBridge();
    if (!D || !D.serverStatus) return;
    D.serverStatus().then(applyServerState, function () {
      srvState.known = true; renderServerToggle();
    });
  }

  /** 切服务器会退出当前房间 —— 画过东西就先问一句，别让人白画 */
  function confirmSrvSwitch() {
    if (!S.joined) return true;
    if (!engine.strokes.length) return true;
    var name = S.room ? S.room.name : '当前房间';
    return confirm('切换服务器会退出「' + name + '」。\n房间里的内容还留在原来那台服务器上，不会丢。\n\n确定继续吗？');
  }

  /**
   * 在线 ↔ 离线。**这颗按钮不动服务器**，只换客户端走哪条通道：
   *
   *   · 在线 = 连本机服务器（ws://localhost:<端口>/ws）—— 同一 WiFi 的朋友能加入
   *   · 离线 = 本机通道（local://）—— 消息照样进同一个房间状态机，不占端口、不出网
   *
   * **为什么「离线」不停服务器**：桌面端的服务器同时是这台机器的「房间存档 + 网页版入口」，
   * 停掉端口对单机画画没有任何好处，却会把正画着的朋友一脚踢出去，还要处理
   * 「端口刚释放没凉透」的重开时序（close 过的 WebSocketServer 是终态，得整个重建）。
   * 所以「离线」= **我这个人离线**，服务器继续在后台跑。
   *
   * 代价是有意接受的：此时你自己在离线档，但同一局域网的人仍能从那个地址进来。
   * 想要端口也一起停，那是独立运行服务端的场景（`node server/src/index.js`，
   * 真停见 tools/test-server-toggle.js 覆盖的 stopListening）。
   */
  function goOffline() {
    var D = localBridge();
    if (!D) { toast('网页版没有离线模式，填服务器地址连过去就行', 'err'); return; }
    if (net.isLocal()) { toast('现在就已经是离线模式了'); return; }
    if (!confirmSrvSwitch()) return;
    var btn = $('#btnServerToggle');
    if (btn) { btn.disabled = true; btn.textContent = '正在切换…'; }

    // 先退出当前房间，再换通道。注意这里**不用 applyServer()**：
    // 离线档是个会话级的选择，不该把「记住的服务器地址」覆盖成 local://，
    // 否则下次开应用会直接落在离线档，用户会以为连不上服务器。
    if (S.joined) resetRoomUi('');
    net.close();                          // 旧 socket 必须真的关掉（见下），离线通道不替你关
    net.connect(global.Net.LOCAL_URL);

    toast(desktopBridge()
      ? '已切到离线模式 —— 自己单机画；服务器还在后台跑，同一 WiFi 的人照样能进'
      : '已切到离线模式 —— 本机画布，不占端口不出网', 'ok', 4200);
    renderServerToggle();
    refreshMenuChecks();
  }

  /** 回到在线：服务器没在跑就顺手起一个，然后连上去 */
  function goOnline() {
    var D = localBridge();
    if (!D) { toast('网页版没有本机服务器，填服务器地址连过去就行', 'err'); return; }
    if (!confirmSrvSwitch()) return;
    var btn = $('#btnServerToggle');

    // 安卓：本机没有服务器可开，直接连「记住的 / 默认的」那台
    if (!desktopBridge()) {
      if (btn) { btn.disabled = true; btn.textContent = '正在连接…'; }
      var aUrl = (global.ChaConfig && global.ChaConfig.resolve) ? global.ChaConfig.resolve() : '';
      if (!aUrl) {
        if (btn) btn.disabled = false;
        renderServerToggle();
        toast('没有可用的服务器地址，先在设置里填一个', 'err');
        return;
      }
      if (S.joined) resetRoomUi('');
      net.close();
      net.connect(aUrl);
      toast('正在连接 ' + aUrl, 'ok');
      renderServerToggle();
      refreshMenuChecks();
      return;
    }

    var needStart = !srvState.on;
    if (btn) { btn.disabled = true; btn.textContent = needStart ? '正在开启…' : '正在连接…'; }

    var step = needStart ? D.serverStart() : null;
    var p = (step && step.then) ? step : Promise.resolve(step);

    p.then(function (r) {
      if (needStart && (!r || !r.ok)) {
        toast('服务器没起来：' + ((r && r.error) || '未知原因'), 'err', 4200);
        return;
      }
      var port = (r && r.port) || srvState.port || 8437;
      var url = 'ws://localhost:' + port + '/ws';
      // 先退房、先断，再连：这里的 url 有可能和当前那条一模一样，
      // 而「地址没变」的路径是不重连的 —— 不显式断一次就会卡在一个已关掉的 socket 上。
      if (S.joined) resetRoomUi('');
      net.close();
      Cfg.remember(url);
      net.connect(url);
      var lan = (r && r.lan && r.lan.length) ? (' · 同一 WiFi 打开 http://' + r.lan[0] + ':' + port + ' 就能加入') : '';
      toast('已回到在线模式' + lan, 'ok', 4200);
    }).catch(function (e) {
      toast('切换失败：' + ((e && e.message) || e), 'err', 4200);
    }).then(function () {
      refreshServerState();
      renderServerToggle();
      refreshMenuChecks();
    });
  }

  function setServerOn(on) { if (on) goOnline(); else goOffline(); }

  /**
   * 入口页那颗按钮的点击：**按钮上写什么就做什么**。
   * 三种状态各自对应一个动作（见 renderServerToggle），所以这里不能简单写成
   * 「离线就上线、在线就离线」—— 「服务器没起来但我正连着别的服务器」那一档，
   * 按钮写的是「开启服务器」，照着「在线就离线」的规则点下去会切到离线，
   * 跟按钮上那句话正好相反（这个坑是 test-server-button 第 5 组抓出来的）。
   */
  function serverButtonAction() {
    // 安卓两态：离线就连服务器，在线就切离线（没有「开启服务器」那一档）
    if (!desktopBridge() && localBridge()) {
      setServerOn(net.isLocal());
      return;
    }
    // 「开启服务器」和「连回服务器」都是往在线走，只有「切到离线」是往离线走
    var toOnline = !srvState.on || net.isLocal();
    setServerOn(toOnline);
  }

  /** 菜单里的「离线模式」：它是个勾选项，勾上/取消只跟「在不在离线档」有关 */
  function toggleOffline() { setServerOn(net.isLocal()); }

  /** 空房 = 没人在线 + 一笔没画 + 没有底图。服务端在 summary() 里给的就是这个口径。 */
  var lastRoomList = [];

  function renderRoomList(rooms) {
    var box = $('#roomList');
    var cnt = $('#roomCount');
    rooms = rooms || [];
    lastRoomList = rooms;
    var blanks = rooms.filter(function (r) { return r.blank; }).length;
    if (cnt) cnt.textContent = rooms.length ? (blanks ? rooms.length + '（空 ' + blanks + '）' : String(rooms.length)) : '';
    if (!rooms.length) {
      box.innerHTML = '<div class="room-empty">还没有公开房间<br>右侧创建一个吧</div>';
      return;
    }
    box.innerHTML = '';
    rooms.forEach(function (r) {
      var el = document.createElement('div');
      el.className = 'room-item' + (r.blank ? ' blank' : '');
      var gameOn = r.game && r.game !== 'off';
      var html = '<div class="rn"><b>' + esc(r.name) + (r.hasPassword ? ' 🔒' : '') +
        (r.blank ? ' <i class="tag-blank">空房</i>' : '') +
        (gameOn ? ' <i class="tag-game">游戏中</i>' : '') + '</b>' +
        '<span>' + r.width + '×' + r.height + ' · ' + r.strokes + ' 笔' +
        (r.ownerName ? ' · ' + esc(r.ownerName) + ' 创建' : '') + '</span></div>' +
        '<div class="cnt"><i></i>' + r.online + '</div>';
      // 空房（没人在线）显示一个删除按钮，一键清理
      if (r.online === 0) {
        html += '<button class="room-del" title="删除这个空房间" data-room="' + r.id + '">×</button>';
      }
      el.innerHTML = html;
      el.onclick = function () { doJoin(r.id); };
      var del = el.querySelector('.room-del');
      if (del) {
        del.onclick = async function (e) {
          e.stopPropagation();
          if (!await confirmDialog('删除房间「' + r.name + '」？房间里的内容会一并删除。', { danger: true })) return;
          net.send(P.C2S.ROOM_DEL, { roomId: r.id });
          // 服务端删完会回一条 ROOM_LIST；这里先乐观地把它划掉，免得等一个来回
          el.classList.add('gone');
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            var left = box.querySelectorAll('.room-item').length;
            if (cnt) cnt.textContent = left ? String(left) : '';
            if (!left) box.innerHTML = '<div class="room-empty">还没有公开房间<br>右侧创建一个吧</div>';
          }, 220);
        };
      }
      box.appendChild(el);
    });
  }

  /** 一键清理所有空房（没人在线 + 一笔没画） */
  function purgeRooms() {
    var blanks = lastRoomList.filter(function (r) { return r.blank; }).length;
    if (!blanks) { toast('当前没有空房（空房 = 没人在线 + 一笔没画）'); return; }
    confirmDialog('清理掉 ' + blanks + ' 个空房？\n（没人在线、一笔没画、也没有底图，删掉不会丢任何画）',
      { danger: true, yes: '清理' }).then(function (ok) {
      if (!ok) return;
      net.send(P.C2S.ROOM_GC, {});
      toast('正在清理空房…');
    });
  }

  function doJoin(roomId) {
    var name = ($('#nameInput').value || '').trim() || ('茶友' + Math.floor(Math.random() * 900 + 100));
    Cfg.setName(name);
    S.me.name = name;
    // 上锁的房间：先要密码（本地记住的密码直接用，错了会弹回来让你重输）
    var meta = lastRoomList.filter(function (x) { return x.id === roomId; })[0];
    if (meta && meta.hasPassword && !getRoomPass(roomId)) {
      askRoomPassword(roomId, meta.name, name);
      return;
    }
    joinRoom(roomId, name, getRoomPass(roomId));
  }

  /* ---------------- ★ 2.0.10：识别别人发来的房间链接 ----------------
   *
   * 用户的原话：「分享的房间链接要能在应用端能自动识别并加入」。
   * 分享出来的是 `http://<host>/?room=<房间号>`（网页端点开就能进），
   * 桌面端还额外认一条 `chahui://join?room=<房间号>&server=<ws://…>`（装的时候注册过协议，
   * 点一下直接拉起茶绘进房）。再加上「光粘一个房间号」——三种都从这一个函数过。
   *
   * 返回 { roomId, server }（认不出来时 roomId 为空串）。
   */
  function parseRoomLink(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { roomId: '', server: '' };
    var server = '';
    var room = '';
    var m = /^chahui:\/\//i.test(s);
    if (m || /^https?:\/\//i.test(s)) {
      var u = null;
      try { u = new URL(m ? s.replace(/^chahui:/i, 'http:') : s); } catch (e) { u = null; }
      if (u) {
        try {
          room = u.searchParams.get('room') || '';
          server = u.searchParams.get('server') || '';
        } catch (e2) { /* ignore */ }
        // 路径形式：chahui://room/<id>、/r/<id>、/join/<id>
        if (!room) {
          var seg = (u.pathname || '').split('/').filter(Boolean);
          if (seg.length >= 2 && /^(room|r|join|j)$/i.test(seg[0])) room = seg[1];
          else if (m && seg.length === 1 && /^(room|r|join|j)$/i.test(u.hostname)) room = seg[0];
        }
        if (m && !room && u.hostname && !/^(room|r|join|j)$/i.test(u.hostname)) room = u.hostname;
        // 网页链接没写 server 就按它的 host 推一个（https → wss）
        if (!server && !m && u.host) {
          server = (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + '/ws';
        }
      }
    } else {
      room = s;
    }
    room = String(room).trim();
    // 房间号只允许「像 id 的字符」；带空格的（有人把房间名当链接发过来）就当没认出来
    if (room && !/^[A-Za-z0-9_-]{2,64}$/.test(room)) room = '';
    return { roomId: room, server: server };
  }

  /**
   * 按链接进房：链接里带服务器地址就**先切服务器**，连上之后再发 ROOM_JOIN。
   * （这就是「应用端自动识别并加入」——不用用户自己去改服务器地址。）
   */
  function joinByLink(text, opts) {
    var p = parseRoomLink(text);
    if (!p.roomId) {
      if (!(opts && opts.silent)) toast('这串东西里没认出房间号：' + String(text || '').slice(0, 40), 'err', 3200);
      return false;
    }
    var name = ($('#nameInput').value || '').trim() || Cfg.getName() || ('茶友' + Math.floor(Math.random() * 900 + 100));
    S.me.name = name;
    Cfg.setName(name);
    var server = Cfg.normalize ? Cfg.normalize(p.server) : p.server;
    var needSwitch = server && server !== net.url;
    if (needSwitch) {
      Cfg.remember(server);
      var si = $('#serverInput');
      if (si) si.value = server;
      setStatus('正在连接 ' + server + ' …');
      net.connect(server);
    }
    toast('正在进入房间 ' + p.roomId + ' …');
    var t = setInterval(function () {
      if (net.isOpen()) {
        clearInterval(t);
        joinRoom(p.roomId, name, getRoomPass(p.roomId));
      }
    }, 200);
    setTimeout(function () { clearInterval(t); }, 12000);
    return true;
  }

  /** 入口页那一行：按钮 / 回车 / 粘贴都走这里 */
  function wireJoinLink() {
    var input = $('#joinLinkInput');
    if (!input) return;
    var btn = $('#btnJoinLink');
    if (btn) btn.addEventListener('click', function () { joinByLink(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); joinByLink(input.value); }
    });
    // 粘贴就自动进（粘进来的十有八九就是一条链接）
    input.addEventListener('paste', function () {
      var self = this;
      setTimeout(function () { joinByLink(self.value, { silent: true }); }, 0);
    });
  }

  /* ---- 房间密码：所有 ROOM_JOIN 都走这里，保证 pendingJoin / 记住密码一致 ---- */
  function joinRoom(roomId, name, password) {
    S.pendingJoin = { roomId: roomId, name: name };
    net.send(P.C2S.ROOM_JOIN, {
      roomId: roomId, user: name, password: password || '',
      // 头像跟昵称一起走：进房那一刻别人就该看到，而不是等我再改一次
      avatar: S.me.avatar || Cfg.getAvatar() || ''
    });
  }

  function passStore() {
    try { return JSON.parse(lsGet('chahu.roomPass', '{}')) || {}; } catch (e) { return {}; }
  }
  function getRoomPass(roomId) {
    var m = passStore();
    return (m[roomId] || '').trim();
  }
  function setRoomPass(roomId, pass) {
    var m = passStore();
    if (pass) m[roomId] = pass; else delete m[roomId];
    lsSet('chahu.roomPass', JSON.stringify(m));
  }

  /** 弹出密码框。roomName 只用来显示；serviceName 是发起加入时的用户名。 */
  function askRoomPassword(roomId, roomName, userName) {
    S.pendingJoin = { roomId: roomId, name: userName || S.me.name || '', roomName: roomName || '' };
    $('#passHint').textContent = roomName
      ? '「' + roomName + '」上了锁，输入密码进入。'
      : '这个房间上了锁，输入密码进入。';
    $('#passErr').classList.add('hidden');
    $('#passInput').value = '';
    $('#passMask').classList.remove('hidden');
    setTimeout(function () { $('#passInput').focus(); }, 60);
  }
  function closeRoomPassword() {
    $('#passMask').classList.add('hidden');
    S.pendingJoin = null;
  }
  function submitRoomPassword() {
    var pj = S.pendingJoin;
    if (!pj) { closeRoomPassword(); return; }
    var pass = ($('#passInput').value || '').trim();
    if (!pass) {
      $('#passErr').textContent = '密码不能为空。';
      $('#passErr').classList.remove('hidden');
      return;
    }
    setRoomPass(pj.roomId, pass);
    closeRoomPassword();
    joinRoom(pj.roomId, pj.name, pass);
  }

  function doCreate() {
    var name = ($('#nameInput').value || '').trim() || ('茶友' + Math.floor(Math.random() * 900 + 100));
    Cfg.setName(name);
    S.me.name = name;
    var sizeVal = ($('#newRoomSize').value || '1600x1000');
    var width, height;
    if (sizeVal === 'custom') {
      width = parseInt($('#newRoomW').value, 10);
      height = parseInt($('#newRoomH').value, 10);
      if (!width || !height || width < 100 || height < 100 || width > 8000 || height > 8000) {
        toast('请填入合法的画布尺寸（100-8000 px）', 'err');
        return;
      }
    } else {
      var size = sizeVal.split('x');
      width = parseInt(size[0], 10);
      height = parseInt(size[1], 10);
    }
    net.send(P.C2S.ROOM_CREATE, {
      name: ($('#newRoomName').value || '').trim() || (name + '的茶绘室'),
      user: name,
      avatar: S.me.avatar || Cfg.getAvatar() || '',
      width: width,
      height: height,
      background: currentPaper(),
      password: ($('#newRoomPass').value || '').trim()
    });
  }

  function bindCreateSizeToggle() {
    var sel = $('#newRoomSize');
    var row = $('#newRoomCustomRow');
    if (!sel || !row) return;
    sel.addEventListener('change', function () {
      row.classList.toggle('hidden', sel.value !== 'custom');
      if (sel.value === 'custom') {
        var preset = '1600x1000'.split('x');
        if (!$('#newRoomW').value) $('#newRoomW').value = preset[0];
        if (!$('#newRoomH').value) $('#newRoomH').value = preset[1];
      }
    });
  }

  /* ------------------------------------------------------------ 个人头像 */

  /** 界面上的小圆头像：有图用图，没图退回「颜色 + 名字首字」（一直是兜底，不会空着） */
  function avaOf(userId) {
    if (!userId) return '';
    if (userId === S.me.userId) return S.me.avatar || '';
    var m = (S.members || []).filter(function (x) { return x.userId === userId; })[0];
    return (m && m.avatar) || '';
  }

  function avaHtml(userId, name, color) {
    var src = avaOf(userId);
    if (src) return '<div class="ava has-img"><img src="' + esc(src) + '" alt=""></div>';
    return '<div class="ava" style="background:' + esc(color) + '">' + esc((name || '?').slice(0, 1)) + '</div>';
  }

  /**
   * 把选中的图压成头像。
   *
   * 96px 见方是**协议层的硬上限**（48KB）倒推出来的：头像会跟着每一次成员广播
   * 发给全房，40 人的房间要是每人一张 100KB 的图，一次广播就是 4MB。
   * 先试 PNG（带透明更好看），太大再退到 JPEG；JPEG 没有 alpha，所以先垫白底
   * —— 否则透明区域会变成黑块。
   */
  function pickAvatar() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || '')) { toast('请选一张图片文件', 'err'); return; }
      if (f.size > 12 * 1024 * 1024) { toast('这张图太大了（超过 12MB）', 'err'); return; }
      var fr = new FileReader();
      fr.onload = function () { openAvaCrop(String(fr.result)); };
      fr.onerror = function () { toast('这张图读不出来', 'err'); };
      fr.readAsDataURL(f);
    };
    inp.click();
  }

  /* ------------------------------------------------------------ 头像裁剪 */
  /* 选图后先框一块方形再上传：圆形视口就是头像的实际显示效果，
     拖动定位、滚轮 / 滑块缩放，确定后按框内区域出 96×96。
     （旧的 shrinkAvatar 是整图压成长边 96，不是方的，已随裁剪上线移除。） */

  var ac = null;   // { img, imgEl, view, scale, min, max, ox, oy }

  function acClamp() {
    var w = ac.img.naturalWidth * ac.scale, h = ac.img.naturalHeight * ac.scale;
    // 图片必须一直盖住视口，不许露出底色
    ac.ox = Math.min(0, Math.max(ac.view - w, ac.ox));
    ac.oy = Math.min(0, Math.max(ac.view - h, ac.oy));
  }

  function acRender() {
    ac.imgEl.style.transform = 'translate(' + ac.ox + 'px,' + ac.oy + 'px) scale(' + ac.scale + ')';
    var z = $('#acZoom');
    if (z) z.value = String(Math.round(1000 * (ac.scale - ac.min) / Math.max(1e-6, ac.max - ac.min)));
  }

  /** 缩放（围绕视口中心），ns 新的 scale 值，调用方负责 min/max 夹取 */
  function acZoomTo(ns) {
    var k = ns / ac.scale;
    var cv = ac.view / 2;
    ac.ox = cv - (cv - ac.ox) * k;
    ac.oy = cv - (cv - ac.oy) * k;
    ac.scale = ns;
    acClamp();
    acRender();
  }

  function openAvaCrop(url) {
    var img = new Image();
    img.onload = function () {
      var view = 264;
      var w = img.naturalWidth || 1, h = img.naturalHeight || 1;
      var min = Math.max(view / w, view / h);   // cover：刚好盖住视口
      ac = {
        img: img, imgEl: $('#acImg'), view: view,
        min: min, max: min * 8, scale: min, ox: 0, oy: 0
      };
      ac.imgEl.src = url;
      ac.ox = (view - w * min) / 2;
      ac.oy = (view - h * min) / 2;
      $('#avaCropMask').classList.remove('hidden');
      acRender();
    };
    img.onerror = function () { toast('这张图读不出来', 'err'); };
    img.src = url;
  }

  function closeAvaCrop() {
    $('#avaCropMask').classList.add('hidden');
    ac = null;
  }

  function acConfirm() {
    if (!ac) return;
    // 视口里看到的方形 → 映射回原图坐标 → 画成 96×96
    var side = ac.view / ac.scale;
    var sx = -ac.ox / ac.scale, sy = -ac.oy / ac.scale;
    var c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    var cx = c.getContext('2d');
    var data = '';
    try {
      cx.drawImage(ac.img, sx, sy, side, side, 0, 0, 96, 96);
      data = c.toDataURL('image/png');
      if (data.length > P.AVATAR_MAX) {
        // PNG 超限退白底 JPEG —— 不垫白底的话透明区域会变黑块
        var flat = document.createElement('canvas');
        flat.width = 96; flat.height = 96;
        var fx = flat.getContext('2d');
        fx.fillStyle = '#ffffff';
        fx.fillRect(0, 0, 96, 96);
        fx.drawImage(c, 0, 0);
        var qs = [0.9, 0.8, 0.7, 0.6, 0.5];
        for (var i = 0; i < qs.length; i++) {
          var u = flat.toDataURL('image/jpeg', qs[i]);
          if (u.length <= P.AVATAR_MAX) { data = u; break; }
        }
      }
    } catch (e) { data = ''; }
    if (!data) { toast('这张图裁不出来，换一张试试', 'err'); return; }
    setMyAvatar(data);
    closeAvaCrop();
  }

  function bindAvaCrop() {
    var view = $('#acView');
    var drag = null;
    view.addEventListener('pointerdown', function (e) {
      if (!ac) return;
      drag = { x: e.clientX, y: e.clientY, ox: ac.ox, oy: ac.oy };
      view.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    view.addEventListener('pointermove', function (e) {
      if (!ac || !drag) return;
      ac.ox = drag.ox + (e.clientX - drag.x);
      ac.oy = drag.oy + (e.clientY - drag.y);
      acClamp(); acRender();
    });
    view.addEventListener('pointerup', function () { drag = null; });
    view.addEventListener('pointercancel', function () { drag = null; });
    view.addEventListener('wheel', function (e) {
      if (!ac) return;
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      acZoomTo(Math.min(ac.max, Math.max(ac.min, ac.scale * f)));
    }, { passive: false });
    $('#acZoom').addEventListener('input', function () {
      if (!ac) return;
      var t = Number(this.value) / 1000;
      acZoomTo(ac.min + (ac.max - ac.min) * t);
    });
    $('#btnAvaCropClose').addEventListener('click', closeAvaCrop);
    $('#btnAvaCropCancel').addEventListener('click', closeAvaCrop);
    $('#btnAvaCropOk').addEventListener('click', acConfirm);
    $('#avaCropMask').addEventListener('click', function (e) {
      if (e.target === this) closeAvaCrop();
    });
  }

  /** 设 / 清自己的头像；已经进房的话顺手广播出去（不用重进房） */
  function setMyAvatar(data) {
    var next = P.normalizeAvatar(data || '');
    Cfg.setAvatar(next);
    S.me.avatar = next;
    renderAvaPreview();
    renderMembers();
    if (S.joined) net.send(P.C2S.MEMBER_AVATAR, { avatar: next });
    toast(next ? '头像已更新' : '已恢复默认头像（颜色 + 名字首字）', 'ok');
  }

  function renderAvaPreview() {
    var el = $('#avaPreview');
    if (!el) return;
    var a = S.me.avatar || '';
    el.innerHTML = a ? '<img src="' + esc(a) + '" alt="">' : '默认';
    var c = $('#btnClearAvatar');
    if (c) c.classList.toggle('hidden', !a);
  }

  function applyServer(url) {
    var u = Cfg.normalize(url);
    if (!u) return;
    Cfg.remember(u);
    if (net.url !== u) net.connect(u);
  }

  /* ============================================================ 指针绘制 */

  function stagePoint(e) {
    var rect = $('#canvasWrap').getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  var smooth = { x: 0, y: 0 };

  function isTwoPointTool(t) { return t === 'line' || t === 'rect' || t === 'ellipse' || t === 'gradient'; }
  function isSelectToolId(t) {
    return t === 'select' || t === 'selectErase' || t === 'marquee' || t === 'lasso' || t === 'wand';
  }
  /** 一次性选区工具：画完直接得到选区，可以自动进入变换 */
  function isRegionSelectId(t) { return t === 'marquee' || t === 'lasso' || t === 'wand'; }

  /* ============================================================ 圆形画笔光标 */

  function bcNode() {
    if (!bcEl) bcEl = $('#brushCursor');
    return bcEl;
  }
  var bcEl = null;

  function setPointerCursor(on) {
    var el = bcNode();
    if (!el) return;
    S.pointer.inside = !!on;
    updateBrushCursor();
  }

  // 光标样式：auto = 大笔刷圆环 / 小笔刷十字；ring = 始终圆环；cross = 始终十字
  var CURSOR_MIN = 5;       // 圆环最小直径，再小就只剩一个糊点
  var CROSS_BOX = 11;       // 十字准星的盒子边长（固定，保证整数像素对齐）
  var DROP_BOX = 22;        // 吸管光标的盒子边长（固定，见 styles.css 的 .eyedrop）
  // 吸管图标里「笔尖」落在 SVG 的哪个位置（24 视口里的 (4,20)）→ 换成 22px 盒子里的像素偏移。
  // 不这样对齐的话，笔尖和真正取色的那个像素差着几个像素，用户会觉得「吸偏了」。
  var DROP_TIP_X = DROP_BOX * 4 / 24;
  var DROP_TIP_Y = DROP_BOX * 20 / 24;

  /**
   * 现在这一刻「点下去是取色还是落笔」。
   * 判据必须和 pointerdown 里那条分支**完全一致**（app.js 的 Alt 临时吸管），
   * 否则光标显示的是吸管、点下去却在画（或者反过来）—— 那比不换光标还糟。
   * 选区工具下 Alt 是「减选」，不能被吸管抢走，所以这里也排除掉。
   */
  function altPicking() {
    return S.tool === 'picker' || (!!S.altDown && !isSelectToolId(S.tool));
  }

  function updateBrushCursor() {
    var el = bcNode();
    if (!el) return;
    // 变换模式下不显示画笔光标（那时指针在拖变换框）
    var hide = !S.pointer.inside || !!S.pan || !S.joined || !!engine.transform;
    var drop = !hide && altPicking();
    el.classList.toggle('hidden', hide);
    // 吸管状态下要把**系统光标**也藏掉，否则会跟吸管图标叠成两个指针。
    // （.stage.drawing 只覆盖画笔类工具，吸管工具本身不在那一条里）
    $('#stage').classList.toggle('eyedropping', drop);
    if (hide) { el.classList.remove('eyedrop'); return; }
    // Alt 临时吸管 / 吸管工具 → 换成吸管图标
    if (drop) {
      el.classList.add('eyedrop');
      el.classList.remove('cross');
      el.classList.remove('erase', 'smudge', 'select');
      el.style.width = DROP_BOX + 'px';
      el.style.height = DROP_BOX + 'px';
      el.style.left = Math.round(S.pointer.sx - DROP_TIP_X) + 'px';
      el.style.top = Math.round(S.pointer.sy - DROP_TIP_Y) + 'px';
      return;
    }
    el.classList.remove('eyedrop');
    // 直径严格对应笔刷实际落笔尺寸（× 视图缩放）
    var raw = (Number(S.brush.size) || 1) * (engine.scale || 1);
    var style = S.cursorStyle || 'auto';
    // 框选 / 套索 / 魔棒不吃笔刷大小，跟着画一个「笔刷大小圈」纯属干扰（用户反馈过
    // 「所有选区工具都会冒出一个圈」）。这三个一律用十字准星。
    var noSizeCursor = isRegionSelectId(S.tool);
    var cross = noSizeCursor || style === 'cross' || (style === 'auto' && raw < 9);
    var d = Math.max(CURSOR_MIN, Math.round(raw));
    var x, y;
    if (cross) {
      // 准星盒子固定 11px，中心对准指针所在的那个像素
      el.style.width = CROSS_BOX + 'px';
      el.style.height = CROSS_BOX + 'px';
      x = Math.round(S.pointer.sx) - (CROSS_BOX - 1) / 2;
      y = Math.round(S.pointer.sy) - (CROSS_BOX - 1) / 2;
    } else {
      el.style.width = d + 'px';
      el.style.height = d + 'px';
      // 关键：左上角取整。圆环落在半个像素上时抗锯齿会把 1px 的环画成一头粗一头细，
      // 小笔刷时看起来就是个椭圆 —— 这就是用户报的「指针是椭圆」。
      x = Math.round(S.pointer.sx - d / 2);
      y = Math.round(S.pointer.sy - d / 2);
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.classList.toggle('cross', cross);
    el.classList.toggle('erase', S.tool === 'eraser');
    el.classList.toggle('smudge', S.tool === 'smudge' || S.tool === 'blur');
    el.classList.toggle('select', isSelectToolId(S.tool));
  }

  /** 组装一笔的完整参数（笔刷 + 对称 + 压感），本地与远端完全一致 */
  function strokeInfo(id, layer, usePressure, extra) {
    var b = S.brush;
    var base = {
      id: id,
      layerId: layer.id,
      // 正在编辑这一层的蒙版时，落下的每一笔都改蒙版（黑遮白露），不改图层像素。
      // 服务端与别人按 target 分流，所以两边看到的是同一件事。
      target: (S.maskEdit && S.maskEdit === layer.id) ? 'mask' : 'layer',
      userId: S.me.userId,
      tool: S.tool,
      color: (S.tool === 'eraser' || S.tool === 'blur') ? '#000000' : S.color,
      size: b.size,
      opacity: b.opacity,
      hardness: b.hardness,
      minSize: b.minSize,
      pressSize: usePressure ? b.pressSize : 0,
      pressOpacity: usePressure ? b.pressOpacity : 0,
      edge: b.edge,
      scatter: b.scatter,
      grain: b.grain,
      grainScale: b.grainScale,
      paper: b.paper,
      fx: b.fx,
      strength: b.strength,
      tolerance: b.tolerance,
      expand: b.expand,
      blend: b.blend,
      sym: S.sym,
      brush: S.brushId,
      filled: !!b.filled,
      // 导入的 PS / CSP 笔刷的笔尖位图与落点间隔。
      // 这里是**第二道白名单**（第一道是 engine.newStroke / 服务端 buildStroke），
      // 三道里漏掉任何一道，笔尖就传不到别的客户端，别人看到的会是一支圆头笔。
      spacing: b.spacing,
      tip: b.tip,
      mix: b.mix,
      // ★ 2.0.10：笔尖形状 / 方向（照 SAI2 的笔刷形状面板）
      tipShape: b.tipShape,
      tipAngle: b.tipAngle,
      // 文字笔迹（这几项由 S.text 提供，见 placeText）
      text: P.normalizeText((extra && extra.text) || ''),
      fontFamily: P.normalizeFontFamily((extra && extra.fontFamily) || S.text.fontFamily),
      fontSize: Number((extra && extra.fontSize) || S.text.fontSize),
      bold: !!(extra && extra.bold),
      italic: !!(extra && extra.italic),
      align: (extra && extra.align) || 'left',
      lineHeight: Number((extra && extra.lineHeight) || S.text.lineHeight),
    };
    if (extra) Object.assign(base, extra);
    return base;
  }

  /* ============================================================ 笔压来源判定
   *
   * 为什么要这么绕：Chromium 只认两种来源能拿到数位板压力 ——
   * Windows Ink（WM_POINTER）和 wintab 桥。Wacom 驱动装完会自动注册，
   * 但绘王(Huion) / 高漫 / 部分 Parblo 的驱动默认走「鼠标模式」或没注册 Ink，
   * 于是浏览器把笔**当成鼠标**报上来：pointerType === 'mouse'、pressure 恒 0.5。
   * 旧代码只写了一句 `pointerType !== 'mouse'` 就丢弃压力 —— 对这些板子等于没压感，
   * 而且一点提示都没有，用户根本不知道是自己的驱动没配好。
   *
   * 现在分三档：
   *   'pen'   —— 浏览器明确说是笔，直接用它的压力
   *   'guess' —— 报成 mouse，但压力/接触面积在变化（真鼠标做不到），按笔处理
   *   'none'  —— 真鼠标（或压感关掉了），恒定 0.5
   */

  /** 每支指针最近几帧的压力 / 接触面积，用来判断「这玩意到底是不是笔」 */
  var penProbe = { id: null, vals: [], types: {} };

  /** 记一帧指针样本。指针变了（笔/鼠标切换）就重开一局 */
  function notePointerSample(e) {
    if (penProbe.id !== e.pointerId) {
      penProbe.id = e.pointerId;
      penProbe.vals = [];
      penProbe.types = {};
    }
    penProbe.types[e.pointerType] = true;
    penProbe.vals.push({ p: e.pressure, w: e.width || 0, h: e.height || 0 });
    if (penProbe.vals.length > 24) penProbe.vals.shift();
    // 手写笔活跃时间戳：防手掌误触用（安卓 / 触屏设备，笔在用时 touch 十有八九是手掌）
    if (e.pointerType === 'pen') lastPenAt = Date.now();
  }

  /** 最近一次「笔」事件的时间。0 = 从来没用过笔 */
  var lastPenAt = 0;

  /**
   * 手掌误触判定：笔刚活跃过（1.5s 内）又来了一根 touch —— 那不是手指，
   * 是握笔时搁在屏上的手掌。整只吞掉（不落笔、不进手势）。
   * 系统 palm rejection 挡掉的事件根本到不了这里，这条只兜漏网的。
   */
  function isPalmTouch(e) {
    return e.pointerType === 'touch' && lastPenAt && (Date.now() - lastPenAt) < 1500;
  }

  /**
   * 这块「鼠标」像不像数位板？
   * 依据：真鼠标的 pressure 永远是 0.5、width/height 永远是 1x1；
   * 只要出现别的取值，或者数值在动，就基本可以断定是板子（被驱动报成了鼠标）。
   */
  function looksLikePen() {
    if (penProbe.types.pen || penProbe.types.touch) return false;   // 已经明确有笔/触摸，不用猜
    if (!penProbe.types.mouse) return false;
    var v = penProbe.vals;
    if (v.length < 3) return false;
    var pMin = 1, pMax = 0, area = 0;
    for (var i = 0; i < v.length; i++) {
      pMin = Math.min(pMin, v[i].p);
      pMax = Math.max(pMax, v[i].p);
      if (v[i].w > 1.001 || v[i].h > 1.001) area = 1;
    }
    // 压力有了变化、或接触面积不是 1x1（鼠标的特征值）→ 是笔
    return (pMax - pMin) > 0.002 || area === 1;
  }

  /** 这一次落笔该不该用压力（真笔直接用；疑似笔要等样本攒够） */
  function pressureUsable(pointerType) {
    if (!S.pressure) return false;
    if (pointerType === 'pen') return true;
    if (pointerType === 'mouse') return looksLikePen();
    return false;   // touch / 其他：手机上画画本来就没有压感
  }

  /** 压力值本身也要擦干净：Chrome 在 pointerdown 常给 0.5 或 0（那是占位值，不是真压力） */
  function normPressure(e, fallback) {
    var p = e && e.pressure;
    if (typeof p !== 'number' || p <= 0 || p >= 1) {
      // 0 表示「没有压力信息」，1 通常来自不支持的设备；都退回上一次 / 默认
      return fallback == null ? 0.5 : fallback;
    }
    return p;
  }

  /**
   * 压感自检的结论 + 面板上那行提示。
   * 为什么要有这个：板子被驱动报成鼠标时，茶绘这边完全静默 ——
   * 用户只会觉得「这软件没压感」，而真正的原因在驱动设置里。
   * 这里把判断结果直接写出来，并附上该去哪儿改。
   */
  function updatePenDetect(type, e) {
    var next;
    if (type === 'pen') next = 'pen';
    else if (type === 'mouse') next = looksLikePen() ? 'guess' : 'none';
    else if (type === 'touch') next = 'none';
    else next = null;
    if (!next) return;
    // 一旦测到真笔就别被后来的鼠标悬停降级
    if (S.penDetect === 'pen' && next === 'none') return;
    if (S.penDetect === next) return;
    S.penDetect = next;
    renderPenHint(e);
  }

  function renderPenHint(e) {
    var el = $('#penHint');
    if (!el) return;
    if (!S.pressure || !S.penDetect || S.penDetect === 'pen') {
      el.className = 'pen-hint';
      el.innerHTML = '';
      return;
    }
    if (S.penDetect === 'guess') {
      // 识别到了压力变化，但浏览器仍把它当鼠标 —— 能用，只是提示一下更稳的做法
      el.className = 'pen-hint on good';
      el.innerHTML = '已识别到数位笔压力（驱动把笔报成了鼠标，茶绘已自动兼容）。' +
        '若压感忽有忽无，可在手绘板驱动里开启 <b>Windows Ink</b> 并关闭「鼠标模式」。';
      return;
    }
    // 'none'：有鼠标事件但完全没有压力信息 —— 基本可以断定驱动没把笔交给浏览器
    var extra = e && e.pointerType === 'mouse' ? '' : '';
    el.className = 'pen-hint on';
    el.innerHTML = '<b>没有检测到笔压。</b>如果你正在用数位板，多半是驱动的问题，' +
      '请打开手绘板驱动：① 开启「Windows Ink」；② 关闭「鼠标模式 / 相对坐标」；' +
      '③ 重启浏览器或茶绘后再试。' + extra;
  }

  function beginLocal(px, py, pressure, pointerType) {
    var layer = engine.activeLayer();
    if (!layer || !S.joined) return;
    // 你画我猜：非画手不许落笔。这里只是「别让人白画一笔」，真正的拦截在服务端。
    var _bm = canvasBlockMsg();
    if (_bm) { toast(_bm, 'err', 1600); return; }
    if (layer.locked) { toast('图层「' + layer.name + '」已锁定'); return; }
    // ★ v2.0.10：锁定画笔（SAI2 锁定行里那支铅笔）—— 这一层暂时画不上去，但还能移动 / 改属性
    if (layer.drawLock) { toast('图层「' + layer.name + '」锁定了画笔'); return; }

    var usePressure = pressureUsable(pointerType);
    updatePenDetect(pointerType, { pointerType: pointerType });
    // Chrome 在 pointerdown 那一下经常给 pressure = 0.5 —— 那是**占位值**，
    // 和「真的按到一半」没法从数值上区分。真实压力要等第一个 pointermove。
    // 所以起笔先按这个值画，并记住首点位置：等第一个可信的移动压力到了，
    // 把首点改写成「和后续压力同档」的值（见 moveLocal 里的 fixFirstPoint）。
    var startP = usePressure ? normPressure({ pressure: pressure }, S.lastPressure) : 0.5;
    if (usePressure && pressure > 0 && pressure < 1) S.lastPressure = pressure;
    var id = P.rid('s');

    if (S.tool === 'fill') {
      var info = strokeInfo(id, layer, false);
      var st = engine.beginStroke(info);
      if (!st) return;
      engine.addPoints(id, [[Math.round(px), Math.round(py), 0.5]]);
      engine.endStroke(id, ++engine.seq);
      net.send(P.C2S.STROKE_BEGIN, info);
      net.send(P.C2S.STROKE_POINTS, { id: id, pts: [[Math.round(px), Math.round(py), 0.5]] });
      net.send(P.C2S.STROKE_END, { id: id });
      S.myUndo.push(id);
      S.myRedo.length = 0;
      renderHistory();
      return;
    }

    // 魔棒：点一下就要结果，走的是「一次性选区工具」这条路，不上传也不进历史
    if (S.tool === 'wand') {
      var w = S.wand;
      if (w.source === 'sample' && !engine.layers.some(function (x) { return x.selSample; })) {
        toast('还没有「指定为选区样本」的图层 · 先在图层行上点那颗圆点', 'err', 3200);
      }
      beginSelSnapshot();
      // ★ 2.0.9：SAI2 那张魔棒面板上的六项**全都**跟着这一笔下去（选项字段见 engine.newStroke），
      //   色差范围复用画笔的 tolerance 滑块
      var winfo = strokeInfo(id, layer, false, {
        add: S.modShift, subtract: S.modAlt,
        selMode: w.mode, transTol: w.transTol, bleed: w.bleed,
        selSource: w.source, antiAlias: w.aa, ignoreSel: w.ignore
      });
      var hadSel = engine.hasSelection();
      var wst = engine.beginStroke(Object.assign({ local: true }, winfo));
      if (!wst) return;
      engine.addPoints(id, [[Math.round(px), Math.round(py), 0.5]]);
      engine.endStroke(id, 0);
      // 一点都没选中就明说一句：否则画面上什么都没发生，看着像魔棒坏了
      if (!hadSel && !engine.hasSelection()) {
        toast('这里没有可选的区域（取样模式：' + (WAND_MODE_LABEL[w.mode] || w.mode) + '）', 'err', 3000);
      }
      afterRegionSelect();
      return;
    }

    // 选区类工具（选区笔 / 选区擦 / 框选 / 套索）都要留一份旧蒙版，方便撤回
    if (isSelectToolId(S.tool)) beginSelSnapshot();

    var info2 = strokeInfo(id, layer, usePressure, { add: S.modShift, subtract: S.modAlt });
    var stroke = engine.beginStroke(Object.assign({ local: true }, info2));
    if (!stroke) return;
    S.session = {
      id: id, last: [px, py], pending: [], tool: S.tool, local: isSelectToolId(S.tool),
      // Chrome 的起笔占位压力**恰好就是 0.5**，数值上没法和「真按到一半」区分。
      // 保守起见：起笔压力正好落在 0.5 就当作可疑，等第一个真实移动压力到了再回改。
      // （若用户真的一直半压，回改后的值也还是 0.5，没有副作用。）
      firstUnreliable: usePressure && Math.abs(normPressure({ pressure: pressure }, -1) - 0.5) < 1e-6
    };
    smooth.x = px; smooth.y = py;

    // 选区是本机私有的状态，不进历史、不同步
    if (S.session.local) {
      var p0 = P.qp([px, py, usePressure ? startP : 0.5]);
      S.session.last = [p0[0], p0[1]];
      engine.addPoints(id, [p0]);
      return;
    }

    net.send(P.C2S.STROKE_BEGIN, info2);

    // 与协议一致地量化采样点：远端回放用的是量化后的坐标，
    // 本地若用原始浮点会出现亚像素差异（模糊 / 水彩边缘会把它放大）
    var p = P.qp([px, py, usePressure ? startP : 0.5]);
    S.session.last = [p[0], p[1]];
    engine.addPoints(id, [p]);
    S.session.pending.push(p);
    flushPoints(true);
  }

  /**
   * 把 getCoalescedEvents 里的中间帧喂进当前笔迹。
   * 参数是「裸的」PointerEvent，需要自己换算成画布坐标（走 stagePoint 的反向：
   * e.clientX/Y 是屏幕坐标，和主事件走同一套换算即可）。
   */
  function feedCoalesced(ce) {
    if (!S.session || S.session.local) return;   // 选区类工具的中间帧没意义
    var sp = stagePoint(ce);
    var dp = engine.screenToDoc(sp.x, sp.y);
    if (dp.x < -2 || dp.y < -2 || dp.x > engine.width + 2 || dp.y > engine.height + 2) return;
    moveLocal(dp.x, dp.y, ce.pressure, ce.pointerType || 'pen');
  }

  function moveLocal(px, py, pressure, pointerType) {
    if (!S.session) return;
    var usePressure = pressureUsable(pointerType);
    // 移动阶段压力是可信的（真鼠标这里恒定 0.5，会被 normPressure 退回默认值）
    var curP = usePressure ? normPressure({ pressure: pressure }, S.lastPressure) : 0.5;
    if (usePressure && pressure > 0 && pressure < 1) S.lastPressure = pressure;
    var x = px, y = py;
    if (S.stabilize > 0) {
      var k = 1 - Math.min(0.88, S.stabilize * 0.058);
      smooth.x = smooth.x + (px - smooth.x) * k;
      smooth.y = smooth.y + (py - smooth.y) * k;
      x = smooth.x; y = smooth.y;
    }
    var last = S.session.last;
    var d = Math.hypot(x - last[0], y - last[1]);
    var minStep = Math.max(0.7, S.brush.size * 0.07);
    if (d < minStep && S.session.pending.length > 0) return;

    // 起笔用的是不可信的占位压力 → 第一个真值到了就把它一起改掉，
    // 否则每笔起手都是「半压的小圆头」。只回改一次。
    if (S.session.firstUnreliable && usePressure && pressure > 0 && pressure < 1) {
      S.session.firstUnreliable = false;
      var fixed = engine.patchTailPressure(S.session.id, 12, curP);
      // 已经发给服务端的那部分没法回改，但还没发的（pending）可以同步改掉
      if (fixed && S.session.pending.length) {
        for (var pi = 0; pi < S.session.pending.length; pi++) S.session.pending[pi][2] = curP;
      }
    }

    var p = P.qp([x, y, curP]);
    S.session.last = [p[0], p[1]];
    engine.addPoints(S.session.id, [p]);
    S.session.pending.push(p);
    flushPoints(false);
  }

  function flushPoints(force) {
    if (!S.session) return;
    var now = performance.now();
    if (!force && now - S.lastSent < 45) return;
    if (!S.session.pending.length) return;
    S.lastSent = now;
    var pts = S.session.pending;
    S.session.pending = [];
    net.send(P.C2S.STROKE_POINTS, { id: S.session.id, pts: pts });
  }

  function endLocal() {
    if (!S.session) return;
    var id = S.session.id;
    var pending = S.session.pending;
    var local = S.session.local;
    var tool = S.session.tool;
    S.session = null;
    engine.clearOverlay();
    // 选区笔 / 选区擦是本机私有状态：既不上传，也不进历史，更不该占撤销栈。
    // 以前这里无条件走网络 + 压撤销栈，后果是
    //   1) 服务端收到没有 begin 的 stroke:end；
    //   2) myUndo 里堆了指向不存在笔迹的空 id —— 点「撤销」看起来没反应；
    //   3) engine.seq 被凭空加高，而 seq 是「固化底图」的裁剪水位。
    if (local) {
      engine.endStroke(id, 0);
      commitSelSnapshot();          // 选区变了 → 记一条可撤销的选区操作
      renderHistory();
      // 框选 / 套索 / 魔棒画完就自动弹出变换面板（可在面板里关掉）
      if (isRegionSelectId(tool)) afterRegionSelect();
      return;
    }
    if (pending.length) net.send(P.C2S.STROKE_POINTS, { id: id, pts: pending });
    net.send(P.C2S.STROKE_END, { id: id });
    var ended = engine.endStroke(id, ++engine.seq);
    // 有选区时画到选区外会被整笔裁掉，画面上「什么都没发生」，
    // 很容易被当成「画布有地方画不了」。明确说一句。
    if (ended && engine.strokeOutsideSelection(ended)) warnSelection();
    S.myUndo.push(id);
    S.myRedo.length = 0;
    pushOp({ type: 'stroke', id: id });
    renderHistory();
  }

  var lastSelWarn = 0;
  function warnSelection() {
    var now = performance.now();
    if (now - lastSelWarn < 4000) return;
    lastSelWarn = now;
    toast('这一笔落在选区之外，被裁掉了 · 按 Ctrl+D 取消选区', 'err', 3600);
  }

  /** 框选 / 套索 / 魔棒画完之后：记一笔选区撤销，并按设置自动进入变换 */
  function afterRegionSelect() {
    commitSelSnapshot();
    if (!engine.hasSelection()) { toast('没有选中任何内容', 'err'); return; }
    if (!S.autoTransform) return;
    if (engine.transform) return;
    // 等一拍，让选区蒙版/蚂蚁线先落到画面上，再开始变换
    setTimeout(function () {
      if (engine.hasSelection() && !engine.transform) startTransform();
    }, 70);
  }

  var lastCursorSent = 0;
  function sendCursor(dp, active) {
    var now = performance.now();
    if (now - lastCursorSent < 55) return;
    lastCursorSent = now;
    net.send(P.C2S.CURSOR,
      { x: Math.round(dp.x), y: Math.round(dp.y), active: active !== false, tool: S.tool },
      { dropIfClosed: true });
  }

  function bindCanvas() {
    var view = $('#view');

    view.addEventListener('pointerdown', function (e) {
      // 手掌误触（笔刚活跃过就来的 touch）：整只吞掉，不落笔也不进任何分支
      if (isPalmTouch(e)) { e.preventDefault(); return; }
      /* ---- 文字工具：点一下选位置 ---- */
      if (S.tool === 'text') {
        if (e.button !== 0) return;
        e.preventDefault();
        var txsp = stagePoint(e);
        placeTextAt(engine.screenToDoc(txsp.x, txsp.y));
        return;
      }
      /* ---- 尺子定义中：这一下拖拽用来摆尺子，不画画 ---- */
      if (S.rulerArm) {
        if (e.button !== 0) return;
        e.preventDefault();
        var rsp = stagePoint(e);
        var rdp = engine.screenToDoc(rsp.x, rsp.y);
        S.rulerArm.p0 = { x: rdp.x, y: rdp.y };
        S.rulerArm.p1 = { x: rdp.x, y: rdp.y };
        try { view.setPointerCapture(e.pointerId); } catch (err) { /* 没有真实指针就算了 */ }
        S.rulerDragging = true;
        return;
      }
      /* ---- 变换模式：所有指针事件都交给变换框 ---- */
      if (engine.transform) {
        if (e.button !== 0) return;
        e.preventDefault();
        var tsp = stagePoint(e);
        var tdp = engine.screenToDoc(tsp.x, tsp.y);
        global.__softMeshDrag = !!e.altKey;
      var hit = engine.transform.hitTest(tdp, 10);
        if (!hit) return;
        view.setPointerCapture(e.pointerId);
        engine.transform.dragStart(hit, tdp);
        S.transformDragging = true;
        return;
      }

      if (e.button === 1 || (e.button === 0 && (S.spaceDown || e.altKey && S.spaceDown))) {
        e.preventDefault();
        S.pan = { x: e.clientX, y: e.clientY };
        $('#stage').classList.add('panning');
        view.setPointerCapture(e.pointerId);
        return;
      }
      // 回放是「只看不画」。这里不挡的话，看着看着手一抖就会在**共享文档**上留下
      // 一笔（自己屏幕上还看不见，因为回放画布盖在上面），事后谁都不知道是谁画的。
      // 位置放在平移分支之后：回放里还能拖动/缩放画面凑近看细节。
      if (engine.replayMode) return;
      if (e.button !== 0) return;
      if (!S.joined) { openEntry(true); return; }
      var sp = stagePoint(e);
      S.pointer.sx = sp.x; S.pointer.sy = sp.y; S.pointer.inside = true;
      // 选区的加选 / 减选修饰键（框选、套索、魔棒、选区笔都用）
      S.modShift = !!e.shiftKey;
      S.modAlt = !!e.altKey;
      // 和 Alt 的 keydown 双保险：焦点在输入框里按的 Alt 会被 bindKeys 里
      // `if (typing) return` 吃掉，这里按真实事件补一次，免得光标和实际行为对不上
      if (S.altDown !== !!e.altKey) { S.altDown = !!e.altKey; updateBrushCursor(); }
      var dp = engine.screenToDoc(sp.x, sp.y);

      // Alt 临时吸管（SAI 习惯）。
      // 但选区工具下 Alt 是「减选」，不能被吸管抢走 —— 否则 Alt 减选永远用不了。
      if (S.tool === 'picker' || (e.altKey && !isSelectToolId(S.tool))) {
        e.preventDefault();
        var c = engine.pickColor(dp.x, dp.y);
        setColor(c);
        toast('取色 ' + c.toUpperCase());
        drawWheel();
        return;
      }
      if (dp.x < -2 || dp.y < -2 || dp.x > engine.width + 2 || dp.y > engine.height + 2) return;

      view.setPointerCapture(e.pointerId);
      e.preventDefault();
      notePointerSample(e);            // 攒一帧样本，供「这块鼠标是不是板子」判断
      beginLocal(dp.x, dp.y, e.pressure, e.pointerType);
    });

    view.addEventListener('pointerenter', function () { setPointerCursor(true); });

    view.addEventListener('pointermove', function (e) {
      var sp = stagePoint(e);
      S.pointer.sx = sp.x;
      S.pointer.sy = sp.y;
      S.pointer.inside = true;
      notePointerSample(e);            // 攒样本：判断「报成 mouse 的是不是数位板」
      // Alt 状态以指针事件为准（离屏 / 焦点丢失时 keyup 是收不到的）
      S.altDown = !!e.altKey;
      // 落笔途中把浏览器合并掉的中间帧也补进来 —— 板子的采样率远高于事件频率，
      // 不取 coalesced 的话快速运笔会丢压力变化（笔迹忽粗忽细、转折处发直）
      if (S.session) {
        var coins = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
        if (coins && coins.length > 1) {
          for (var ci = 1; ci < coins.length; ci++) feedCoalesced(coins[ci]);
        }
      }
      // 尺子定义中：拖出橡皮筋
      if (S.rulerArm && S.rulerDragging) {
        var rdp = engine.screenToDoc(sp.x, sp.y);
        S.rulerArm.p1 = { x: rdp.x, y: rdp.y };
        engine.rulerPreview = { type: S.rulerArm.type, p0: S.rulerArm.p0, p1: S.rulerArm.p1 };
        engine.drawOverlay();
        $('#cursorPos').textContent = Math.round(rdp.x) + ', ' + Math.round(rdp.y);
        return;
      }
      if (engine.transform) {
        var tdp = engine.screenToDoc(sp.x, sp.y);
        if (S.transformDragging) {
          engine.transform.dragMove(tdp, e.shiftKey);
          engine.drawOverlay();
        } else {
          // 悬停到把手上就换成可拖动的光标，不然用户不知道能拖哪儿
          var hit = engine.transform.hitTest(tdp, 10);
          view.style.cursor = hit ? (hit === 'move' ? 'move' : 'crosshair') : 'default';
        }
        updateBrushCursor();
        return;
      }
      if (S.pan) {
        engine.panBy(e.clientX - S.pan.x, e.clientY - S.pan.y);
        S.pan = { x: e.clientX, y: e.clientY };
        updateBrushCursor();
        return;
      }
      var dp = engine.screenToDoc(sp.x, sp.y);
      S.pointer.dx = dp.x; S.pointer.dy = dp.y;
      $('#cursorPos').textContent = Math.round(dp.x) + ', ' + Math.round(dp.y);
      updateBrushCursor();
      sendCursor(dp);
      if (S.session) {
        if (isTwoPointTool(S.session.tool)) {
          var tp = P.qp([dp.x, dp.y, e.pressure || 0.5]);
          engine.addPoints(S.session.id, [tp]);
          if (!S.session.pending.length) S.session.pending.push(tp);
          else S.session.pending[0] = tp;
        } else {
          moveLocal(dp.x, dp.y, e.pressure, e.pointerType);
        }
      }
    });

    function up() {
      // 尺子定义收尾：够长就摆上，太短就提示
      if (S.rulerDragging) {
        S.rulerDragging = false;
        engine.rulerPreview = null;
        var arm = S.rulerArm;
        var rp0 = arm && arm.p0, rp1 = arm && arm.p1;
        if (rp0 && rp1 && Math.hypot(rp1.x - rp0.x, rp1.y - rp0.y) > 2) {
          commitRuler(arm.type, rp0, rp1);
        } else {
          toast('拖得太短了，尺子没摆上（再拖长一点）', 'err');
          engine.drawOverlay();
        }
        return;
      }
      if (engine.transform) {
        if (S.transformDragging) { engine.transform.dragEnd(); S.transformDragging = false; }
    global.__softMeshDrag = false;
        return;
      }
      if (S.pan) {
        S.pan = null;
        $('#stage').classList.remove('panning');
        updateBrushCursor();
      }
      if (S.session) endLocal();
    }
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('pointerleave', function () {
      sendCursor({ x: 0, y: 0 }, false);
      setPointerCursor(false);
    });

    view.addEventListener('wheel', function (e) {
      e.preventDefault();
      var sp = stagePoint(e);
      var factor = Math.exp(-e.deltaY * 0.0016);
      engine.setZoom(engine.scale * factor, sp.x, sp.y);
      S.pointer.sx = sp.x; S.pointer.sy = sp.y;
      updateBrushCursor();
    }, { passive: false });

    view.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    bindTouchGestures();
  }

  /**
   * 触屏双指手势：平移（中点位移）+ 缩放（两指间距之比）。
   *
   * 桌面端靠滚轮缩放、空格 / 中键平移，手指上这些一概没有 ——
   * 不做手势的话手机连画布都挪不动。
   *
   * 监听挂在 #stage 的**捕获阶段**而不是 #view 上：同一个元素上的捕获监听
   * 不一定比后注册的冒泡监听先跑（规范里 at target 阶段按注册顺序来），
   * 只有挂在祖先的捕获阶段才能保证「第二根手指」被我们吃掉、不会去落笔。
   *
   * 第二根手指落下时，正在画的那一笔照常收尾（endLocal），不做本地丢弃：
   * 笔迹的 begin/points 早就发给服务端了，本地私自扔掉会让各端画面不一致 ——
   * 多出一个小点，比两个人看到的东西不一样轻得多。
   */
  function bindTouchGestures() {
    var stage = $('#stage');
    if (!stage || !global.PointerEvent) return;
    var pts = new Map();
    S.touchPts = pts;

    function snapshot() {
      var it = pts.values();
      var a = it.next().value, b = it.next().value;
      if (!a || !b) return null;
      return {
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        dist: Math.hypot(a.x - b.x, a.y - b.y)
      };
    }

    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      // 手掌误触：不进手势集合。捕获阶段吞掉，落笔那条路也走不到（双保险见 view 的 pointerdown）
      if (isPalmTouch(e)) { e.preventDefault(); e.stopPropagation(); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size < 2) return;          // 第一根手指照常画画（不拦）
      e.preventDefault();
      e.stopPropagation();               // 第二根手指不落笔
      if (S.session) endLocal();
      S.pan = null;
      S.pinch = snapshot();
      stage.classList.add('gesturing');
    }, true);

    stage.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size < 2 || !S.pinch) return;
      e.preventDefault();
      e.stopPropagation();
      var g = snapshot();
      if (!g) return;
      engine.panBy(g.midX - S.pinch.midX, g.midY - S.pinch.midY);
      // 两指离得太近时比值会抖成噪声，先平移稳一下再缩放
      if (S.pinch.dist > 24) engine.setZoom(engine.scale * (g.dist / S.pinch.dist), g.midX, g.midY);
      S.pinch = g;
      updateBrushCursor();     // setZoom 会 emit viewport，缩放输入框由那边刷新
    }, true);

    function release(e) {
      if (e.pointerType !== 'touch') return;
      pts.delete(e.pointerId);
      if (pts.size >= 2) return;
      if (S.pinch) { S.pinch = null; stage.classList.remove('gesturing'); }
    }
    stage.addEventListener('pointerup', release, true);
    stage.addEventListener('pointercancel', release, true);
  }

  /* ============================================================ 图像变换 */

  function startTransform() {
    if (engine.transform) return;
    if (!S.joined) { openEntry(true); return; }
    var _bm = canvasBlockMsg();
    if (_bm) { toast(_bm, 'err', 1800); return; }
    var layer = engine.activeLayer();
    if (!layer) return;
    if (layer.locked) { toast('图层「' + layer.name + '」已锁定', 'err'); return; }
    if (layer.moveLock) { toast('图层「' + layer.name + '」锁定了移动', 'err'); return; }
    // 空图层拿来变换没有意义，早点说清楚
    if (!layer.baseImage && !layer.strokes.length) {
      toast('「' + layer.name + '」上还没有内容', 'err');
      return;
    }
    // 变换会整体替换图层像素，先留一份原像素，撤回想撤得回来
    S.transformBefore = snapshotLayer(layer.id);
    var t = engine.beginTransform();
    if (!t) { S.transformBefore = null; return; }
    var mode = ($('#transformPanel').querySelector('input[name=tpMode]:checked') || {}).value || 'free';
    t.mode = mode;
    S.transformDragging = false;
    $('#transformPanel').classList.remove('hidden');
    $('#btnTransform').classList.add('active');
    setStatus('变换中 · 拖角 / 边调整 · Enter 确定 · Esc 中止');
    updateBrushCursor();
  }

  function endTransformUi() {
    $('#transformPanel').classList.add('hidden');
    $('#btnTransform').classList.remove('active');
    S.transformDragging = false;
    $('#view').style.cursor = '';
    updateBrushCursor();
  }

  function commitTransform() {
    if (!engine.transform) return;
    var before = S.transformBefore;
    var res = engine.endTransform(true);
    S.transformBefore = null;
    endTransformUi();
    if (res) {
      // 变换后的像素没法用笔迹重放表达 —— 跟复制 / 合并一样，客户端烘焙成 PNG 回传。
      // 不传 upToSeq：交给服务端用它自己的 room.seq 当水位，免得本地 seq 偏高把后续笔迹挡住。
      net.send(P.C2S.LAYER_PIXELS, { layerId: res.layerId, png: res.png });
      S.myUndo = S.myUndo.filter(function (id) { return engine.byId.has(id); });
      S.myRedo = S.myRedo.filter(function (s) { return engine.byId.has(s.id); });
      // 记一条可撤销的「像素操作」：Ctrl+Z 能把变换撤回去
      if (before) pushOp({ type: 'pixels', layerId: res.layerId, before: before, after: res.png, label: '变换' });
      renderLayers(); renderHistory(); refreshNav();
      setStatus('变换已应用 · 共 ' + engine.strokes.length + ' 笔');
      toast('变换已应用（Ctrl+Z 可撤回）', 'ok');
    }
  }

  function cancelTransform() {
    if (!engine.transform) return;
    engine.endTransform(false);
    S.transformBefore = null;
    endTransformUi();
    renderLayers();
    setStatus('已中止变换');
    toast('已中止变换');
  }

  function bindTransformPanel() {
    var panel = $('#transformPanel');
    if (!panel) return;
    $('#btnTransform').addEventListener('click', function () {
      if (engine.transform) commitTransform(); else startTransform();
    });
    Array.prototype.forEach.call(panel.querySelectorAll('input[name=tpMode]'), function (r) {
      r.addEventListener('change', function () {
        if (engine.transform) engine.transform.mode = this.value;
      });
    });
    $('#tpApply').addEventListener('click', commitTransform);
    $('#tpCancel').addEventListener('click', cancelTransform);
    $('#tpPersp').addEventListener('input', function () {
      if (!engine.transform) return;
      engine.transform.persp = Number(this.value);
      $('#tpPerspVal').textContent = this.value;
      engine.drawOverlay();
    });
    var tpAuto = $('#tpAuto');
    if (tpAuto) {
      tpAuto.checked = !!S.autoTransform;
      tpAuto.addEventListener('change', function () {
        S.autoTransform = this.checked;
        lsSet('chahu.autoTransform', S.autoTransform ? '1' : '0');
      });
    }
    $('#tpHFlip').addEventListener('click', function () {
      if (!engine.transform) return;
      engine.transform.flip('h'); engine.drawOverlay();
    });
    $('#tpVFlip').addEventListener('click', function () {
      if (!engine.transform) return;
      engine.transform.flip('v'); engine.drawOverlay();
    });
    $('#tpRot90ccw').addEventListener('click', function () {
      if (!engine.transform) return;
      engine.transform.rotate90(-1); engine.drawOverlay();
    });
    $('#tpRot90cw').addEventListener('click', function () {
      if (!engine.transform) return;
      engine.transform.rotate90(1); engine.drawOverlay();
    });
    // 变换中防误触：面板上的按键不要在画布上留下笔迹
    panel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  }

  /* ============================================================ 远端光标 */

  function updateCursor(m) {
    if (m.userId === S.me.userId) return;
    if (cursorsHiddenNow()) return;        // 自己正在画（经典画手 / 接龙作画）→ 别人的光标不显示
    var entry = S.cursors.get(m.userId);
    if (!entry) {
      var el = document.createElement('div');
      el.className = 'remote-cursor';
      var cAva = avaOf(m.userId);
      el.innerHTML = '<div class="pin" style="background:' + esc(m.color || '#888') + '"></div>' +
        '<div class="tag" style="background:' + esc(m.color || '#888') + '">' +
        (cAva ? '<img class="tag-ava" src="' + esc(cAva) + '" alt="">' : '') + esc(m.name || '') + '</div>';
      $('#cursors').appendChild(el);
      entry = { el: el, name: m.name, color: m.color, timer: null, x: 0, y: 0 };
      S.cursors.set(m.userId, entry);
    }
    entry.x = m.x; entry.y = m.y;
    var p = engine.docToScreen(m.x, m.y);
    entry.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    entry.el.classList.toggle('idle', m.active === false);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(function () { entry.el.classList.add('idle'); }, 4500);
  }

  function repositionCursors() {
    S.cursors.forEach(function (entry) {
      var p = engine.docToScreen(entry.x, entry.y);
      entry.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    });
  }

  function removeCursor(userId) {
    var e = S.cursors.get(userId);
    if (e) { e.el.remove(); S.cursors.delete(userId); }
  }

  function clearCursors() {
    S.cursors.forEach(function (e) { e.el.remove(); });
    S.cursors.clear();
  }

  /**
   * 该不该把**别人的**远端光标藏起来（#5）。
   *
   *   经典模式：我当画手时藏 —— 别人这回合被锁着笔，光标却还在画布上飘，
   *             画的人只会被那一堆标签挡住自己要落笔的地方。
   *   接龙：**作画这一步全员藏** —— 这一步每个人的笔迹本来就只回给自己
   *         （见服务端的私密作画），别人的画布上不会再出现新光标，
   *         留着那些停在原地的小旗子只会让人以为卡了。
   *
   * 纯本机显示，不改任何同步状态、不影响别人。
   */
  function cursorsHiddenNow() {
    var g = S.game;
    if (!g) return false;
    if (g.mode === 'chain') return g.phase === 'chain_draw';
    // 画皮：作画阶段大家都看不见别人的画，光标当然也一起藏 ——
    // 一条光标飘过去就等于告诉全场「那个人在画布好大一块」。
    if (g.mode === 'skin') return g.phase === 'skin_draw';
    return g.phase === 'draw' && !!g.isDrawer;
  }

  function syncCursorVisibility() {
    var box = $('#cursors');
    if (!box) return;
    var hide = cursorsHiddenNow();
    // 直接清掉而不是只 display:none —— 不然回来时那批元素还停在几分钟前的位置上
    if (hide && S.cursors.size) clearCursors();
  }

  /* ============================================================ 同步处理 */

  function handleMessage(msg) {
    // 画皮结算的「真相表」走的是 `<SKIN_ROLE>:all`（见 server/src/index.js 的 syncGame）。
    // 放在 switch 之前判掉：它不是一个独立的协议常量，没必要为一处用途去污染 S2C 表 ——
    // 协议表里每多一条「只有一处用」的消息，将来就多一处定义与实现对不上的风险。
    if (msg.t === P.S2C.SKIN_ROLE + ':all') {
      S.skinReveal = msg.all || null;
      renderSkinOver();
      return;
    }
    // 房主的开局预设（S2C.GAME_PREFS）：非房主拿它**只读**显示开局面板，
    // 开局前就能看见「房主设置的当前配置」。载荷是 { prefs: {...} }（见 server/src/index.js），
    // 但也容错认「整包就是字段」的老形状。
    // 判据写三个：协议常量（标准路径）、约定的名字（协议还没同步到时）、以及消息名里带 prefs
    // —— 服务端先上线、前端后合版本的话，这里静默丢掉就白做了一套。
    if (msg.t === P.S2C.GAME_PREFS || msg.t === GAME_PREFS_S2C
      || /prefs/i.test(String(msg.t || ''))) {
      var pf = (msg && msg.prefs && typeof msg.prefs === 'object') ? msg.prefs : msg;
      S.gamePrefs = (pf && typeof pf === 'object') ? pf : null;
      renderGameDialog();
      return;
    }
    switch (msg.t) {
      case P.S2C.HELLO_OK:
        renderConn('online');
        break;

      case P.S2C.ROOM_LIST:
        renderRoomList(msg.rooms);
        break;

      case P.S2C.ROOM_JOINED: {
        S.room = msg.room;
        S.me.userId = msg.you.userId;
        S.me.name = msg.you.name;
        S.me.color = msg.you.color;
        // 头像以服务端回执为准（它可能因为太大 / 格式不对被丢掉，那就说一声，别让人以为设上了）
        var wantAva = S.me.avatar || '';
        S.me.avatar = msg.you.avatar || '';
        if (wantAva && !S.me.avatar) toast('头像没被接受（图太大或格式不支持），已退回默认', 'warn', 3600);
        renderAvaPreview();
        S.me.isOwner = !!msg.you.isOwner;
        S.me.readonly = !!msg.you.readonly;
        S.joined = true;
        S.pendingJoin = null;
        // 「他人笔触」要靠这个判断哪些笔是自己的
        engine.setMeId(S.me.userId);
        S.myUndo = []; S.myRedo = [];
        clearCursors();
        // 换了房间：画皮的身份、夜里的裁定、结算真相表统统作废。
        // 不清的话会把上一个房间的底牌带进新房间 —— 那是真的能看出别人身份的程度。
        S.skinRole = null; S.skinNight = null; S.skinReveal = null;
        S.skinDrawnSubmitted = false; S.skinRoleToast = ''; S.skinTaskToast = '';
        S.skinPrevPhase = ''; S.skinPrevRound = -1; S.skinVotePick = '';

        engine.init({
          width: msg.room.width, height: msg.room.height,
          background: msg.room.background, layers: msg.layers,
          // 入房就要带上组表：房间可能本来就有组，漏了它新来的人看到的是「散开的图层」
          groups: msg.groups || []
        });
        S.joinCount = (S.joinCount || 0) + 1;
        // 服务端 seq 是权威水位（撤销/重做会让它领先于最大笔迹 seq）
        var lastSeq = (msg.history && msg.history.lastSeq) || 0;
        engine.seq = Math.max(engine.seq, lastSeq);
        var bases = (msg.history && msg.history.baseImages) || {};
        Object.keys(bases).forEach(function (lid) { engine.setBaseImage(lid, bases[lid]); });
        // 蒙版像素（只有导入 / 固化过的房间才有）。平时蒙版靠笔迹重放重建，这里是补漏。
        var masks = (msg.history && msg.history.maskImages) || {};
        Object.keys(masks).forEach(function (lid) { engine.setMaskImage(engine.getLayer(lid), masks[lid]); });

        S.members = msg.members || [];
        renderMembers();
        $('#chatList').innerHTML = '';
        (msg.chat || []).forEach(function (m) { renderChatMsg(m); });
        // 游戏状态随入房一起来：新进来的人立刻能看到 HUD（可能还要接着画）
        applyGameState(msg.game || null);

        S.historyQueue = [];
        S.historyTotal = (msg.history && msg.history.count) || 0;
        setStatus('正在同步画布（' + S.historyTotal + ' 笔）…');

        $('#entryMask').classList.add('hidden');
        renderRoomChip();
        renderLayers();
        renderHistory();
        setTimeout(function () { engine.fitView(); }, 60);
        setTimeout(refreshNav, 200);
        toast('已进入「' + msg.room.name + '」', 'ok');
        updateUrlForRoom(msg.room.id);
        break;
      }

      case P.S2C.HISTORY_CHUNK: {
        (msg.strokes || []).forEach(function (s) { if (s) S.historyQueue.push(s); });
        drainHistory();
        break;
      }

      case P.S2C.GAME_GUESS: {
        // 只说给我自己听的猜词回执：猜错 / 很接近。裁定在服务端，这里只管响。
        if (msg.kind === 'near') SFX.play('close');
        else if (msg.kind === 'wrong') SFX.play('wrong');
        break;
      }

      case P.S2C.MEMBERS: {
        var prevMembers = S.members || [];
        S.members = msg.members || [];
        var ids = S.members.map(function (m) { return m.userId; });
        S.cursors.forEach(function (v, k) { if (ids.indexOf(k) < 0) removeCursor(k); });
        // 房主可能已经转移（原房主退房了），每次成员变动都要重新对一次自己的身份
        refreshMyRole();
        renderMembers();
        renderRoomChip();
        // 有人进出就响一声 —— 但**只在游戏进行中**。
        // 平时画画时人进人出很频繁，每次都响会变成噪音。
        if (gameActive() && S.room) {
          var prevIds = prevMembers.map(function (m) { return m.userId; });
          var joined = ids.some(function (id) { return prevIds.indexOf(id) < 0; });
          var left = prevIds.some(function (id) { return ids.indexOf(id) < 0; });
          if (joined) SFX.play('join');
          else if (left) SFX.play('leave');
        }
        break;
      }

      case P.S2C.ROOM_UPDATED: {
        if (msg.patch) {
          if (msg.patch.id === (S.room && S.room.id)) {
            var bases = msg.patch.baseImages;
            var mmasks = msg.patch.maskImages;
            Object.assign(S.room, msg.patch);
            if (bases) Object.keys(bases).forEach(function (lid) { engine.setBaseImage(lid, bases[lid]); });
            if (mmasks) Object.keys(mmasks).forEach(function (lid) { engine.setMaskImage(engine.getLayer(lid), mmasks[lid]); });
            engine.background = S.room.background;
          }
          renderRoomChip();
        }
        break;
      }

      case P.S2C.ROOM_RESIZED: {
        // 服务端确认尺寸变更：把本地 S.room 同步上去，并请求重发完整状态
        // 走 RESYNC 而不是 HISTORY_REQ，是因为 client 的协议里没有单独的历史请求
        if (S.room) { S.room.width = msg.width; S.room.height = msg.height; }
        toast('画布分辨率已变更为 ' + msg.width + ' × ' + msg.height);
        net.send(P.C2S.RESYNC, {});
        break;
      }

      case P.S2C.LAYERS: {
        // 第三份是组表：**必须传**。少了它，engine 里永远没有组对象，
        // layerRowEl 就不缩进、合成也不按组走 —— 看起来像「组创建成功但一点效果都没有」。
        engine.setLayers(msg.layers || [], msg.baseImages || null, msg.groups || null, msg.maskImages || null);
        // 不变式：engine.seq 必须 ≥ 每一层的 baseSeq。
        // 新笔迹拿到的 seq 是 ++engine.seq，一旦它 ≤ 某个图层的 baseSeq，
        // renderLayerFromHistory 就会把这笔当「已固化的旧笔迹」跳过 ——
        // 症状是「画了一笔，一重绘就没了」。工程装载会把 baseSeq 直接推到 room.seq+1，
        // 而这条路径**不经过入房的 lastSeq**，所以这里得自己兜住。
        var seqFloor = 0;
        (msg.layers || []).forEach(function (l) {
          var b = l.baseSeq || 0;
          if (b > seqFloor) seqFloor = b;
        });
        if (seqFloor > engine.seq) engine.seq = seqFloor;
        pruneUndo();
        renderLayers();
        renderHistory();
        refreshNav();
        // 工程装载的收尾：服务端把图层表整体换掉之后才会走到这里
        if (S.projectLoad && S.projectLoad.ending) {
          var n = (msg.layers || []).length;
          S.projectLoad = null;
          toast('工程已装载：' + n + ' 个图层', 'ok', 5000);
          renderRoomChip();
        }
        break;
      }

      case P.S2C.STROKE_BEGIN: {
        var s = msg.stroke;
        if (s.userId === S.me.userId) break;
        engine.beginStroke(Object.assign({}, s, { local: false }));
        break;
      }

      case P.S2C.STROKE_POINTS:
        engine.addPoints(msg.id, msg.pts || []);
        break;

      case P.S2C.STROKE_END: {
        var ended = engine.endStroke(msg.id, msg.seq);
        if (msg.seq) engine.seq = Math.max(engine.seq, msg.seq);
        if (!ended && msg.seq) {
          var ex = engine.byId.get(msg.id);
          if (ex) ex.seq = msg.seq;
        }
        renderHistory();
        break;
      }

      case P.S2C.STROKE_CANCEL:
        engine.cancelStroke(msg.id);
        break;

      case P.S2C.STROKE_ADDED: {
        var st = msg.stroke;
        if (!st) break;
        // 重做会拿到一个全新的服务端 seq，这里同步本地水位，否则「固化底图」会漏裁一笔
        if (st.seq) engine.seq = Math.max(engine.seq, st.seq);
        var exist = engine.byId.get(st.id);
        if (exist) { exist.seq = st.seq; break; }
        engine.addCommitted(st);
        if (st.userId === S.me.userId) {
          S.myUndo.push(st.id);
          var ri = S.myRedo.findIndex(function (x) { return x.id === st.id; });
          if (ri >= 0) S.myRedo.splice(ri, 1);
          // 只有「重做」会把自己的笔迹送回来；本地作画时已经在 endLocal 里记过了
          if (!S.opUndo.some(function (e) { return e.type === 'stroke' && e.id === st.id; })) {
            pushOp({ type: 'stroke', id: st.id });
          }
        }
        renderHistory();
        break;
      }

      case P.S2C.STROKE_REMOVED: {
        if (msg.reason === 'clear') {
          engine.clearScope(msg.scope || 'layer', msg.layerId);
          // 游戏里的回合清空是服务端发起的，它会顺带推进 seq。
          // 这里必须把水位抬到服务端那一档，否则之后画的笔会被当成「已固化」跳过
          // （表现：画上去看不见，这是本项目最隐蔽的一类 bug）。
          if (msg.seq) engine.seq = Math.max(engine.seq, msg.seq);
          renderLayers();
          // 整片内容被清掉，撤销栈 / 重做栈里的笔迹都已失效
          pruneUndo();
        } else {
          // 他人撤销：只移除画面，不动我的重做栈（自己的撤销不走回显）
          engine.removeStrokes(msg.ids || []);
          (msg.ids || []).forEach(function (id) {
            var i = S.myUndo.indexOf(id);
            if (i >= 0) S.myUndo.splice(i, 1);
          });
        }
        renderHistory();
        refreshNav();
        break;
      }

      case P.S2C.CHAT:
        if (msg.system || (msg.userId && msg.userId !== 'system')) renderChatMsg(msg);
        break;

      case P.S2C.CURSOR:
        updateCursor(msg);
        break;

      /* ---- 你画我猜 / 接龙 ---- */
      case P.S2C.GAME_STATE:
        applyGameState(msg.game);
        break;

      /* 接龙专用：这一步的题面只发给我一个人（别人收到的 task 完全不同）。
         绝不能走广播 —— 那等于把答案贴到每个猜手脸上。 */
      case P.S2C.GAME_TASK:
        applyChainTask(msg.task);
        break;

      /* 接龙专用：回放数据（进 REVEAL 阶段广播一次，迟到者按 version 补发）。
         完整链条第一次公开 —— 之后客户端播放器就在这份数据上翻页，
         不再向服务端要任何东西。 */
      case P.S2C.GAME_REVEAL:
        applyChainReveal(msg.chains || []);
        break;

      case P.S2C.GAME_WORD:
        onGameWord(msg.word);
        break;

      /* 画皮：我的身份（只发给我）。全场唯一一份「我是谁」的来源 ——
         快照里没有它，所以重连 / 中途同步都会重发一份，这里覆盖即可。 */
      case P.S2C.SKIN_ROLE:
        applySkinRole(msg);
        break;

      /* 画皮：夜里的裁定（只发给我）。预言家的验人结果 / 我被刀了。 */
      case P.S2C.SKIN_NIGHT:
        S.skinNight = msg || null;
        renderSkinDawn();
        if (S.game && S.game.phase === 'skin_night') renderSkinNight();
        break;

      case P.S2C.GAME_CORRECT:
        onGameCorrect(msg);
        break;

      /* 主题菜单变了（有人建/改/删了自定义词库）—— 把新菜单缓存下来刷新下拉 */
      case P.S2C.GAME_THEMES:
        if (msg.themes && msg.themes.length) {
          S.themes = msg.themes;
          buildThemeSelect($('#gameTheme'));   // 经典模式的开局面板
          renderChainDialog();
          renderSkinDialog();                  // 画皮的开局面板
          if (TM.list) loadThemeList();       // 词库面板开着的话也顺手刷新
        }
        break;

      case P.S2C.ROOM_LEFT:
        resetRoomUi('');
        break;

      case P.S2C.ROOM_DESTROYED:
        resetRoomUi('房主解散了房间' + (msg.by ? '（' + msg.by + '）' : '') + '，你已被请出');
        break;

      // 房间被「从列表里删掉」时走这条（和解散是两件事：解散是在房间里点，删除是在列表里点）。
      // 服务端两条都会发给房内的人，前端就得两条都认 —— 只认一条的话，
      // 收到本条的人界面会停在那个已经不存在的房间里，之后画什么都没反应。
      case P.S2C.ROOM_DELETED:
        resetRoomUi('这个房间已被删除，你已被请出');
        break;

      case P.S2C.OK:
        if (typeof msg.purged === 'number') {
          toast(msg.purged ? '已清理 ' + msg.purged + ' 个空房间' : '没有可清理的空房间');
        } else if (msg.deleted) {
          toast('房间已删除');
        }
        break;

      case P.S2C.ERROR:
        // 密码错了：把密码框弹回来重输（记住的密码也不对就顺手清掉）
        if (msg.code === 'bad_password' && S.pendingJoin) {
          var pj = S.pendingJoin;
          setRoomPass(pj.roomId, '');
          askRoomPassword(pj.roomId, pj.roomName || ('房间 ' + pj.roomId), pj.name);
          $('#passErr').textContent = '密码不正确，再试一次。';
          $('#passErr').classList.remove('hidden');
          toast(msg.message || '房间密码不正确', 'err');
          break;
        }
        // 工程装载被服务端拒了（层数超限 / 顺序错乱 / 不是房主…）：
        // 别把一个半截的装载任务留在后台，用户会以为还在传
        if (S.projectLoad && /project/.test(String(msg.code || ''))) {
          S.projectLoad = null;
        }
        toast(msg.message || '出错了', 'err');
        setStatus('错误：' + (msg.message || msg.code));
        break;
    }
  }

  function pruneUndo() {
    S.myUndo = S.myUndo.filter(function (id) { return engine.byId.has(id); });
    S.myRedo = S.myRedo.filter(function (s) { return engine.byId.has(s.id); });
    // 统一栈里指向已消失笔迹的条目也要清掉，否则「撤回」会撤到一个不存在的笔迹上（表现为没反应）
    S.opUndo = S.opUndo.filter(function (e) {
      if (e.type !== 'stroke') return true;
      return engine.byId.has(e.id);
    });
    S.opRedo = S.opRedo.filter(function (e) {
      if (e.type !== 'stroke') return true;
      return engine.byId.has(e.id);
    });
  }

  /* ---------------------------------------------------------- 统一撤销栈
     笔迹、选区、变换（以及别的「客户端烘焙像素」操作）按发生顺序排在同一个栈里，
     撤回才是真的「撤回上一步」，而不是只认笔迹。
     像素/选区快照用 dataURL（PNG 压缩）：直接存 canvas 的话，
     一张 4096×4096 就是 67MB，存几步就把内存吃光了。 */

  var MAX_SNAPSHOT_STEPS = 24;

  function pushOp(entry) {
    S.opUndo.push(entry);
    if (S.opUndo.length > MAX_SNAPSHOT_STEPS) S.opUndo.shift();
    S.opRedo.length = 0;
    S.myRedo.length = 0;
  }

  /** 从重做栈里按 id 找那笔笔迹（撤销时 byId 里已经删掉了，只能靠这份对象） */
  function redoStrokeById(id) {
    for (var i = S.myRedo.length - 1; i >= 0; i--) if (S.myRedo[i].id === id) return S.myRedo[i];
    return null;
  }

  function snapshotSelection() {
    if (!engine.selection) return '';
    try { return engine.selection.canvas.toDataURL('image/png'); } catch (e) { return ''; }
  }
  function snapshotLayer(layerId) {
    var l = engine.getLayer(layerId);
    if (!l) return '';
    try { return l.canvas.toDataURL('image/png'); } catch (e) { return ''; }
  }
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /** 选区操作：先记下旧蒙版，操作完再合成一条撤销 */
  var selSnap = null;
  function beginSelSnapshot() {
    if (selSnap === null) selSnap = snapshotSelection();
  }
  function commitSelSnapshot() {
    if (selSnap === null) return;
    var before = selSnap;
    selSnap = null;
    var after = snapshotSelection();
    if (before === after) return;
    pushOp({ type: 'selection', before: before, after: after });
    renderHistory();
  }

  async function applySelectionSnapshot(dataUrl) {
    var img = await loadImage(dataUrl);
    engine.restoreSelection(img);            // null → 清空选区
    renderLayers();
    refreshNav();
  }

  async function applyLayerSnapshot(layerId, dataUrl) {
    var img = await loadImage(dataUrl);
    if (!img) return;
    engine.applyTransformResult(layerId, img);
    renderLayers(); renderHistory(); refreshNav();
    // 像素级操作没法用笔迹重放表达，照样得回传服务端，另一端才看得到
    net.send(P.C2S.LAYER_PIXELS, { layerId: layerId, png: dataUrl });
  }

  var undoing = false;

  function undo() {
    if (engine.transform) { toast('变换中：Enter 确定，Esc 中止'); return; }
    if (!S.opUndo.length) { toast('没有可撤回的操作'); return; }
    var e = S.opUndo.pop();
    S.opRedo.push(e);

    if (e.type === 'stroke') {
      var s = engine.byId.get(e.id);
      if (!s) { renderHistory(); return; }
      engine.removeStrokes([e.id], true);
      S.myRedo.push(s);
      var i = S.myUndo.lastIndexOf(e.id);
      if (i >= 0) S.myUndo.splice(i, 1);
      net.send(P.C2S.STROKE_UNDO, { ids: [e.id] });
      renderHistory(); renderLayers(); refreshNav();
      return;
    }
    if (e.type === 'selection') {
      undoing = true;
      applySelectionSnapshot(e.before).then(function () {
        undoing = false;
        renderHistory();
        toast('已撤回选区');
      });
      return;
    }
    if (e.type === 'pixels') {
      undoing = true;
      applyLayerSnapshot(e.layerId, e.before).then(function () {
        undoing = false;
        renderHistory();
        toast('已撤回' + (e.label || '像素操作'));
      });
      return;
    }
    renderHistory();
  }

  function redo() {
    if (engine.transform) { toast('变换中：Enter 确定，Esc 中止'); return; }
    if (!S.opRedo.length) { toast('没有可重做的操作'); return; }
    var e = S.opRedo.pop();
    S.opUndo.push(e);

    if (e.type === 'stroke') {
      // 撤销时把笔迹从 byId 里删掉了，重做只能从 myRedo 那份对象里拿
      var s = redoStrokeById(e.id) || engine.byId.get(e.id);
      if (!s) { renderHistory(); return; }
      engine.addCommitted(s);
      S.myUndo.push(s.id);
      var ri = S.myRedo.findIndex(function (x) { return x.id === e.id; });
      if (ri >= 0) S.myRedo.splice(ri, 1);
      net.send(P.C2S.STROKE_REDO, { stroke: s });
      renderHistory(); renderLayers(); refreshNav();
      return;
    }
    if (e.type === 'selection') {
      applySelectionSnapshot(e.after).then(function () { renderHistory(); toast('已重做选区'); });
      return;
    }
    if (e.type === 'pixels') {
      applyLayerSnapshot(e.layerId, e.after).then(function () { renderHistory(); toast('已重做像素操作'); });
      return;
    }
    renderHistory();
  }

  function updateUrlForRoom(roomId) {
    try {
      if (location.protocol === 'file:') return;
      var u = new URL(location.href);
      u.searchParams.set('room', roomId);
      history.replaceState(null, '', u.toString());
    } catch (e) { /* ignore */ }
  }

  function drainHistory() {
    if (S.historyDraining) return;
    S.historyDraining = true;
    var batch = 200;
    function step() {
      if (!S.historyQueue.length) {
        S.historyDraining = false;
        setStatus('画布同步完成 · 共 ' + engine.strokes.length + ' 笔');
        renderLayers(); renderHistory(); renderRoomChip();
        refreshNav();
        // 「图像大小」带缩放改尺寸：等新尺寸重新同步完，再把缩放好的图层像素回传
        flushPendingPixels();
        // 打开工程：房间内容和笔迹都落地了，才轮到往上灌工程的图层
        uploadProjectLayers();
        return;
      }
      var n = 0;
      while (S.historyQueue.length && n < batch) {
        engine.addCommitted(S.historyQueue.shift());
        n++;
      }
      setStatus('正在同步画布… 剩余 ' + S.historyQueue.length + ' 笔');
      setTimeout(step, 0);
    }
    step();
  }

  /* ============================================================ 撤销 / 重做 */
  /* undo() / redo() 见上面的「统一撤销栈」一节 */

  /* ============================================================ 视图 / 导航器 */

  function setText(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text;
  }

  function syncViewBar() {
    var pct = Math.round(engine.scale * 100);
    var deg = Math.round(engine.rot * 180 / Math.PI);
    var norm = ((deg % 360) + 540) % 360 - 180;   // 归一化到 -180 ~ 180
    var zr = $('#zoomRange');
    if (zr) {
      var v = clamp(pct, Number(zr.min), Number(zr.max));
      if (document.activeElement !== zr) zr.value = v;
      else zr.value = v;
    }
    setText('#zoomRangeVal', pct + '%');
    setText('#zoomVal', pct + '%');
    setText('#navZoom', pct + '%');
    var ar = $('#angleRange');
    if (ar) ar.value = norm;
    setText('#angleRangeVal', norm + '°' + (engine.flipX ? ' ⇄' : ''));
    setText('#viewRot', norm + '°');
    var g = $('#btnGrid');
    if (g) g.classList.toggle('active', engine.grid.on);
    var f = $('#btnFlipView');
    if (f) f.classList.toggle('active', engine.flipX);
    updateBrushCursor();
  }

  function refreshNav() {
    var cv = $('#navCanvas');
    var box = $('#navBox');
    if (!cv || !box) return;
    var maxW = Math.max(80, (box.clientWidth || 230) - 4);
    var maxH = 150;
    var k = Math.min(maxW / engine.width, maxH / engine.height);
    var w = Math.max(1, Math.round(engine.width * k));
    var h = Math.max(1, Math.round(engine.height * k));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    var thumb = engine.makeThumb(w, h);
    var ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(thumb, 0, 0);
    drawNavRect();
  }

  function drawNavRect() {
    var cv = $('#navCanvas');
    var box = $('#navRect');
    if (!cv || !box) return;
    var r0 = cv.getBoundingClientRect();
    var b0 = $('#navBox').getBoundingClientRect();
    if (!r0.width || !r0.height) { box.style.display = 'none'; return; }
    var r = engine.getVisibleRect();
    // 视口比整幅画还大时，「取景框」就是整幅画 —— 画出来只是一个大方块盖住缩略图，
    // 看着像个来路不明的方框。这种情况直接不画。
    var covers = r.x <= 1 && r.y <= 1 &&
      r.x + r.w >= engine.width - 1 && r.y + r.h >= engine.height - 1;
    if (covers) { box.style.display = 'none'; return; }
    // 取景框必须夹在缩略图范围内：超出去会溢出成一个占满整格的大方块
    var sx = r0.width / engine.width, sy = r0.height / engine.height;
    var x0 = Math.max(0, Math.min(engine.width, r.x));
    var y0 = Math.max(0, Math.min(engine.height, r.y));
    var x1 = Math.max(0, Math.min(engine.width, r.x + r.w));
    var y1 = Math.max(0, Math.min(engine.height, r.y + r.h));
    if (x1 - x0 < 1 || y1 - y0 < 1) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.style.left = Math.round(r0.left - b0.left + x0 * sx) + 'px';
    box.style.top = Math.round(r0.top - b0.top + y0 * sy) + 'px';
    box.style.width = Math.max(4, Math.round((x1 - x0) * sx)) + 'px';
    box.style.height = Math.max(4, Math.round((y1 - y0) * sy)) + 'px';
  }

  function bindNavigator() {
    var box = $('#navBox');
    var drag = false;
    function go(e) {
      var cv = $('#navCanvas');
      var r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var x = (e.clientX - r.left) / r.width * engine.width;
      var y = (e.clientY - r.top) / r.height * engine.height;
      engine.panTo(x, y);
      drawNavRect();
      updateBrushCursor();
    }
    box.addEventListener('pointerdown', function (e) {
      drag = true;
      box.setPointerCapture(e.pointerId);
      go(e);
    });
    box.addEventListener('pointermove', function (e) { if (drag) go(e); });
    box.addEventListener('pointerup', function () { drag = false; });
    box.addEventListener('pointercancel', function () { drag = false; });
  }

  function toggleNav(on) {
    S.navOpen = on == null ? !S.navOpen : !!on;
    var box = $('#navBox');
    if (box) box.style.display = S.navOpen ? '' : 'none';
    if (S.navOpen) refreshNav();
  }

  function bindViewBar() {
    $('#btnRotateCCW').addEventListener('click', function () { engine.rotateBy(-15); });
    $('#btnRotateCW').addEventListener('click', function () { engine.rotateBy(15); });
    $('#btnFlipView').addEventListener('click', function () { engine.flipView(); });
    $('#btnResetView').addEventListener('click', function () {
      engine.resetView();
      toast('视图已复位');
    });
    $('#btnGrid').addEventListener('click', function () {
      engine.grid.on = !engine.grid.on;
      engine.drawOverlay();
      syncViewBar();
    });
    $('#symSelect').addEventListener('change', function () {
      S.sym = this.value;
      lsSet('chahu.sym', S.sym);
      S.brush.sym = S.sym;
      toast('对称尺：' + this.options[this.selectedIndex].textContent);
    });
    $('#cursorStyle').addEventListener('change', function () {
      S.cursorStyle = this.value;
      lsSet('chahu.cursor', S.cursorStyle);
      updateBrushCursor();
      toast('画笔光标：' + this.options[this.selectedIndex].textContent);
    });
    $('#btnZoomIn').addEventListener('click', function () { engine.setZoom(engine.scale * 1.25); });
    $('#btnZoomOut').addEventListener('click', function () { engine.setZoom(engine.scale / 1.25); });
    $('#btnZoomFit').addEventListener('click', function () { engine.fitView(); });
    $('#btnZoom100').addEventListener('click', function () { engine.setZoom(1); });
    $('#zoomRange').addEventListener('input', function () { engine.setZoom(Number(this.value) / 100); });
    $('#angleRange').addEventListener('input', function () {
      engine.setRotation(Number(this.value) * Math.PI / 180);
    });
    bindNavigator();
  }

  /* ============================================================ 回放 */

  function startReplay() {
    if (!engine.strokes.length) { toast('还没有笔迹可以回放'); return; }
    engine.setReplayMode(true);
    $('#replayBar').classList.remove('hidden');
    $('#stage').classList.add('replaying');
    engine.replaySeek(0);
    S.replay.t = 0; S.replay.playing = true; S.replay.last = performance.now();
    $('#btnReplayToggle').textContent = '暂停';
    $('#replayRange').value = 0;
    syncOnionUi();
    updateReplayAuthor();
    loopReplay();
    toast('回放中 · ' + engine.replayStrokes.length + ' 笔', 'ok');
  }

  function loopReplay() {
    if (!S.replay.playing) return;
    var now = performance.now();
    // dt 必须夹住：切到别的标签页时 requestAnimationFrame 会停，回来那一帧的 dt
    // 是「你离开的整段时间」，不夹的话回放会一步跳到结尾。
    var dt = Math.min(250, now - S.replay.last);
    S.replay.last = now;
    var dur = engine.replayDuration();
    S.replay.t = Math.min(dur, S.replay.t + dt * S.replay.speed);
    engine.replaySeek(S.replay.t);
    updateReplayAuthor();
    // 导出回放视频时，录制画面跟时间轴同一拍推进（顺序不能颠倒：先 seek 再录）
    if (S.recording && S.recording.kind === 'replay' && S.recording.draw) S.recording.draw();
    $('#replayRange').value = Math.round(S.replay.t / dur * 1000);
    $('#replayTime').textContent = fmtClock(S.replay.t) + ' / ' + fmtClock(dur);
    if (S.replay.t >= dur) {
      S.replay.playing = false;
      $('#btnReplayToggle').textContent = '重播';
      // 导出回放视频：播完自动收工（再点一次「导出视频」也能提前结束）
      if (S.recording && S.recording.kind === 'replay') S.recording.rec.stop();
      return;
    }
    S.replay.raf = requestAnimationFrame(loopReplay);
  }

  function stopReplay() {
    S.replay.playing = false;
    cancelAnimationFrame(S.replay.raf);
    // 正在导出回放视频时退出回放 = 提前收工：把已经录到的部分存下来（别让录制器空转）
    if (S.recording && S.recording.kind === 'replay') S.recording.rec.stop();
    engine.setReplayMode(false);
    $('#replayBar').classList.add('hidden');
    $('#stage').classList.remove('replaying');
    var el = $('#replayAuthor');
    if (el) el.classList.add('hidden');
  }

  /** 回放条上标出「这一刻是谁在画」。落在两笔之间的停顿里就藏起来 —— 那段时间画面本来就不动。 */
  function updateReplayAuthor() {
    var el = $('#replayAuthor');
    if (!el) return;
    var cur = engine.replayMode ? engine.replayCurrent() : null;
    if (!cur) { el.classList.add('hidden'); return; }
    var mem = (S.members || []).filter(function (m) { return m.userId === cur.stroke.userId; })[0];
    el.textContent = mem ? mem.name : '茶友';
    el.style.setProperty('--author-color', (mem && mem.color) || '#9aa0a8');
    el.classList.remove('hidden');
  }

  /* ---------------- 洋葱皮（回放时看清前后几笔） ----------------
   *
   * 茶绘没有帧动画，「洋葱皮」只能落在唯一有时间轴的地方 —— 回放：
   * 把**刚画完的几笔**染成暖色（红）、**马上要画的几笔**染成冷色（青）叠在画面上，
   * 一眼看清运笔在往哪走、刚才那一笔落在哪儿。
   *
   * 三点是有意的：
   *   · 纯本机显示：不上传、不进文档，别人看不到 —— 和「参考图」「协作视图」同一类
   *   · 开关立刻生效：`setOnion` 内部会把当前这一帧重画一次，不用等下一次 seek
   *   · 导出回放视频会把残影一起录进去（录的就是当前画面），想干净就关掉再导
   */
  function syncOnionUi() {
    var st = engine.onionState();
    var btn = $('#btnReplayOnion');
    if (btn) btn.classList.toggle('active', st.on);
    var sel = $('#onionCount');
    if (sel) {
      sel.classList.toggle('hidden', !st.on);
      sel.value = String(st.before);
    }
    return st;
  }

  function applyOnion(on, n) {
    engine.setOnion({ on: !!on, before: n, after: n });
    S.onionOn = !!engine.onion.on;
    return syncOnionUi();
  }

  function toggleOnion() {
    var st = applyOnion(!engine.onion.on, S.onionCount);
    lsSet('chahu.onion', st.on ? '1' : '0');
    toast(st.on
      ? '洋葱皮：开 · 暖色=刚画完的几笔，冷色=马上要画的几笔'
      : '洋葱皮：关', st.on ? 'ok' : undefined, 3200);
    return st;
  }

  function setOnionCount(n) {
    var v = Math.min(3, Math.max(1, Math.round(Number(n)) || 1));
    S.onionCount = v;
    lsSet('chahu.onion.n', String(v));
    var st = applyOnion(engine.onion.on, v);
    if (st.on) toast('洋葱皮：前后各 ' + v + ' 笔');
    return st;
  }

  /**
   * 导出回放视频：按当前倍速从 0 播到底，全程录成一个 WebM。
   *
   * 录制源必须是**回放画布**（`engine.replayInto`）。现成的 `renderInto` 走的是
   * `renderDocument`，录出来只有一张静止的完成图 —— 那正是「录制」按钮在回放模式下的
   * 表现（看着像坏了，其实是录错了东西），所以这里不能复用它。
   */
  function exportReplayVideo() {
    if (S.recording) { toast('已经有一个录制在进行', 'err'); return; }
    if (typeof MediaRecorder === 'undefined') { toast('当前环境不支持录制', 'err'); return; }
    if (!engine.strokes.length) { toast('还没有笔迹可以回放'); return; }

    if (!engine.replayMode) {
      engine.setReplayMode(true);
      $('#replayBar').classList.remove('hidden');
      $('#stage').classList.add('replaying');
    }
    // 先摆到起点并停住，等录制器就绪再一起开跑（否则开头会漏掉一截）
    S.replay.playing = false;
    cancelAnimationFrame(S.replay.raf);
    engine.replaySeek(0);
    var dur = engine.replayDuration();
    S.replay.t = 0;
    S.replay.last = performance.now();
    $('#replayRange').value = 0;
    $('#replayTime').textContent = fmtClock(0) + ' / ' + fmtClock(dur);
    $('#btnReplayToggle').textContent = '暂停';
    updateReplayAuthor();

    var c = document.createElement('canvas');
    c.width = engine.width; c.height = engine.height;
    var rctx = c.getContext('2d');
    var stream = c.captureStream(30);
    var types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    var mime = '';
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) { mime = types[i]; break; }
    }
    var rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
    } catch (e) { toast('录制初始化失败：' + e.message, 'err'); return; }

    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      S.recording = null;
      var btn = $('#btnReplayExport');
      btn.classList.remove('active');
      btn.textContent = '导出视频';
      if (!chunks.length) { toast('没有录到内容', 'err'); return; }
      var blob = new Blob(chunks, { type: 'video/webm' });
      var url = URL.createObjectURL(blob);
      // stampName() = 茶绘-20260917-113045，这里插一个「回放」进去
      download(stampName().replace('茶绘-', '茶绘-回放-') + '.webm', url);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      toast('回放视频已导出 · ' + fmtBytes(blob.size), 'ok');
    };

    // 每帧由 loopReplay 驱动（跟时间轴同一拍），保证录到的第 N 帧就是回放的第 N 帧；
    // 另起一个 RAF 会跟回放的 RAF 抢执行顺序，偶尔录到上一帧的画面。
    S.recording = {
      rec: rec, kind: 'replay', raf: 0,
      draw: function () { engine.replayInto(rctx); }
    };
    rec.start(1000);
    $('#btnReplayExport').classList.add('active');
    $('#btnReplayExport').textContent = '录制中…';

    S.replay.playing = true;
    S.replay.last = performance.now();
    loopReplay();
    toast('正在导出回放视频（' + S.replay.speed + '×，' + fmtClock(dur) + '）…', 'ok', 4000);
  }

  /* ============================================================ 录制 */

  function toggleRecord() {
    if (S.recording) { S.recording.rec.stop(); return; }
    if (typeof MediaRecorder === 'undefined') { toast('当前环境不支持录制', 'err'); return; }
    var c = document.createElement('canvas');
    c.width = engine.width; c.height = engine.height;
    var ctx = c.getContext('2d');
    var stream = c.captureStream(30);
    var types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    var mime = '';
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) { mime = types[i]; break; }
    }
    var rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
    } catch (e) { toast('录制初始化失败：' + e.message, 'err'); return; }

    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      cancelAnimationFrame(S.recording.raf);
      S.recording = null;
      $('#btnRecord').classList.remove('active');
      $('#btnRecord').textContent = '录制';
      if (!chunks.length) { toast('没有录到内容', 'err'); return; }
      var blob = new Blob(chunks, { type: 'video/webm' });
      var url = URL.createObjectURL(blob);
      download(stampName() + '.webm', url);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      toast('录制完成 · ' + fmtBytes(blob.size), 'ok');
    };

    function frame() {
      if (!S.recording) return;
      engine.renderInto(ctx, {});
      S.recording.raf = requestAnimationFrame(frame);
    }

    S.recording = { rec: rec, raf: 0 };
    rec.start(1000);
    frame();
    $('#btnRecord').classList.add('active');
    $('#btnRecord').textContent = '停止';
    toast('开始录制作画过程（WebM）', 'ok');
  }

  /* ============================================================ 固化底图 */

  function bake() {
    if (!S.room) return;
    if (!S.me.isOwner) { toast('只有房主可以固化底图', 'err'); return; }
    if (readonlyMe()) { toast('你现在是观众，不能固化底图', 'err', 1800); return; }
    if (gameLocked()) { toast('游戏进行中不能固化底图', 'err', 1800); return; }
    if (!engine.strokes.length) { toast('没有需要固化的笔迹'); return; }
    var upToSeq = engine.seq;
    var pngs = {};
    engine.layers.forEach(function (l) { pngs[l.id] = engine.renderLayerPNG(l.id); });
    net.send(P.C2S.ROOM_COMPRESS, { pngs: pngs, upToSeq: upToSeq });
    engine.layers.forEach(function (l) {
      var img = new Image();
      img.onload = function () { l.baseImage = img; };
      img.src = pngs[l.id];
      l.baseSeq = upToSeq;
    });
    engine.pruneHistory(upToSeq);
    S.myUndo = [];
    S.myRedo = [];
    renderHistory();
    refreshNav();
    toast('已固化底图，压缩 ' + upToSeq + ' 条历史', 'ok');
  }

  /* ============================================================ 导出 / 分享 */

  function doExport() {
    if (!S.room) { toast('还没有进入房间'); return; }
    download(stampName() + '.png', engine.exportPNG());
  }

  /* ================================================================
   * 导出：png / jpg / jpeg / webp / psd / bmp / tga
   * 编码见 export-formats.js（PSD 在 psd.js）；这里只管选格式、问画质、把结果落盘。
   * ================================================================ */

  function buildExportFormats() {
    var sel = $('#exportFormat');
    if (!sel || sel.options.length) return;
    global.ChaExport.FORMATS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      sel.appendChild(o);
    });
    sel.value = 'png';
  }

  function syncExportNote() {
    buildExportFormats();
    var f = global.ChaExport.byId($('#exportFormat').value);
    $('#exportQualityRow').classList.toggle('hidden', !f.quality);
    $('#exportQualityVal').textContent = $('#exportQuality').value;
    $('#exportNote').textContent = f.alpha
      ? '带透明通道：没画到的地方导出后是透明的。'
      : '这个格式不支持透明：没画到的地方会被垫成白底。';
    if (f.id === 'bmp' || f.id === 'tga') {
      $('#exportNote').textContent = (f.alpha ? '带透明通道。' : '不支持透明，会垫白底。') +
        ' BMP / TGA 是茶绘自己写的编码器（浏览器不提供）。';
    }
    if (f.id === 'psd') {
      $('#exportNote').textContent =
        '保留图层、图层组、图层名、浓度、混合模式与可见性；藏起来的层也会存进去（在 Photoshop 里是关着的）。' +
        ' 茶绘自己写的 PSD 编码器。';
    }
  }

  function openExportDialog() {
    if (!S.room) { toast('还没有进入房间'); return; }
    buildExportFormats();
    syncExportNote();
    $('#exportMask').classList.remove('hidden');
  }

  /** 按当前选的格式导出；formatId 为空就用对话框里的选择 */
  function exportAs(formatId) {
    if (!S.room) { toast('还没有进入房间'); return; }
    var f = global.ChaExport.byId(formatId || $('#exportFormat').value);
    var q = Number($('#exportQuality').value) / 100;
    var data;
    try {
      // PSD 走分层那条路：要的是文档结构，一张拍平的画布给不出图层
      data = f.id === 'psd'
        ? global.ChaExport.encode(null, f.id, q, engine)
        : global.ChaExport.encode(engine.renderDocument({}).canvas, f.id, q);
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
      return;
    }
    download(stampName() + '.' + f.ext, data);
    toast('已导出 ' + f.ext.toUpperCase() + '（' + engine.width + ' × ' + engine.height + '）', 'ok', 3200);
  }

  /**
   * 分享链接的基地址。
   * 优先用局域网地址：桌面端内置服务器起来后，朋友要用你的内网 IP 才能打开，
   * 用 localhost 发出去对方点开只会连到他自己那台机器。
   */
  function shareBase() {
    // 公网隧道优先：外网朋友也能打开，局域网地址只对同一 WiFi 的人有效
    if (S.publicUrl) return S.publicUrl;
    var lan = Cfg.lanBase ? Cfg.lanBase() : '';
    if (lan) return lan;
    return Cfg.httpBaseOf(net.url);
  }

  /**
   * 问一下服务端有没有开公网隧道（tools/expose.js 会把地址写到 server/data/public-url.txt）。
   * 有的话分享链接就用公网地址，这样发出去的链接谁都能打开。
   */
  function probePublicUrl() {
    var base = Cfg.httpBaseOf(net.url);
    if (!base || typeof fetch !== 'function') return;
    fetch(base + '/api/share', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        // 整份回包留着：开局面板上的可选档位、「默认（N 秒）」标签、每个玩法的人数
        // 上下限都按它算（服务端用 GAME_* 压过计时的话，只有这份数据是对的）。
        S.shareCfg = j;
        // 顺手把「主题列表」缓存下来 —— 开局前 S.game 是 null，
        // 那时候面板拿不到快照里的 themes，只能靠这里先垫上
        if (j.themeList && j.themeList.length) S.themes = j.themeList;
        // 面板正开着的话立刻按服务端的值重画（占位项 / 默认秒数都要换掉）
        renderGameDialog();
        var next = (j.publicUrl || '').replace(/\/+$/, '');
        if (next === S.publicUrl) return;
        S.publicUrl = next;
        S.lanUrls = j.lanUrls || [];
        if (next) toast('检测到公网入口，分享链接已切换为 ' + next, 'ok', 4200);
        // 房间信息面板正开着的话，顺手刷新一下里面的链接
        var mask = $('#infoMask');
        if (mask && !mask.classList.contains('hidden') && S.room) showInfo();
      })
      .catch(function () { /* 没有就是没开隧道，忽略 */ });
  }

  /* ---------------- 桌面端「公网联机」 ----------------
   * 隧道跑在主进程（client/tunnel.js），这里只管三件事：
   *   1. 接线：订阅状态、开/关
   *   2. 把地址写进 S.publicUrl（这样分享链接、房间信息全都自动切到公网）
   *   3. 房间信息面板正开着的时候，把那一行刷成当前进度
   * 网页版没有这套 IPC，所以所有入口都先判 desktopTunnel()。
   */

  function desktopTunnel() {
    return (global.chahuDesktop && global.chahuDesktop.isDesktop &&
      global.chahuDesktop.startTunnel) ? global.chahuDesktop : null;
  }

  var tunnelWired = false;
  function setupTunnelBridge() {
    var d = desktopTunnel();
    if (!d || tunnelWired) return d;
    tunnelWired = true;
    d.onTunnelState(function (s) {
      if (!s) return;
      S.tunnel = s;
      // 只有「开着」的时候才认这个地址；隧道一断就必须把它清掉，
      // 否则分享出去的是一个已经失效的链接
      S.publicUrl = (s.phase === 'on' && s.url) ? s.url : '';
      refreshTunnelUi();
      if (s.phase === 'on' && s.url) toast('公网入口已就绪：' + s.url, 'ok', 5200);
      else if (s.phase === 'off' && s.error) toast('公网联机失败：' + s.error, 'err', 5200);
    });
    // 打开界面时先把已有状态捞一遍（比如隧道是上一次操作留下的、还活着）
    d.getTunnelStatus().then(function (s) {
      if (!s) return;
      S.tunnel = s;
      if (s.phase === 'on' && s.url) S.publicUrl = s.url;
      refreshTunnelUi();
    }, function () { /* 主进程还没这个能力就当没有 */ });
    return d;
  }

  /** 房间信息面板开着就整块重画一次 + 入口页那行跟着刷 —— 面板都很小，比精确改一行更不容易漏 */
  function refreshTunnelUi() {
    renderTunnelToggle();
    var mask = $('#infoMask');
    if (mask && !mask.classList.contains('hidden') && S.room) showInfo();
  }

  function tunnelStatusText() {
    var t = S.tunnel || {};
    if (t.phase === 'downloading') {
      // ⚠ 别再用 `percent || 0` —— 主进程拿不到总大小时会**故意**给 percent = null
      //   （标注 indeterminate），那时 `|| 0` 会把它显示成「0% 卡住」，
      //   而实际上字节正在流。主进程现在会直接给一句现成的文案（progressText）。
      if (t.progressText) return t.progressText;
      if (t.indeterminate || t.percent == null) {
        var mb = (Number(t.bytes) || 0) / 1048576;
        var sp = Number(t.speed) || 0;
        return '正在下载公网组件 ' + mb.toFixed(1) + ' MB'
          + (sp > 0 ? '（' + (sp / 1048576).toFixed(1) + ' MB/s）' : '')
          + '（只下一次，之后就不用等了）';
      }
      return '正在下载公网组件 ' + Math.round(t.percent * 100) + '%（只下一次，之后就不用等了）';
    }
    if (t.phase === 'starting') return '正在建立隧道…';
    if (t.phase === 'on') return '已开启';
    return '';
  }

  /** 下载太慢/失败时给用户的兜底提示：主进程会把「缓存目录完整路径」放在 t.hint 里 */
  function tunnelHintText() {
    var t = S.tunnel || {};
    if (t.phase === 'downloading' && t.hint) return t.hint;
    if (t.phase === 'error' && t.hint) return t.hint;
    return '';
  }

  function startTunnel() {
    var d = setupTunnelBridge();
    if (!d) { toast('公网联机只在桌面端有', 'err'); return; }
    if (S.tunnel && S.tunnel.phase !== 'off') return;      // 正在下 / 正在起，别重复点
    S.tunnel = { phase: 'starting', url: '', error: '', percent: 0 };
    refreshTunnelUi();
    toast('正在准备公网入口……第一次会先下载一个几十兆的组件', 'ok', 3600);
    d.startTunnel().then(function (r) {
      if (r && r.ok) return;
      if (r && r.error) {
        S.tunnel = { phase: 'off', url: '', error: r.error, percent: 0 };
        toast('公网联机失败：' + r.error, 'err', 5200);
        refreshTunnelUi();
      }
    }, function (e) {
      S.tunnel = { phase: 'off', url: '', error: (e && e.message) || '未知错误', percent: 0 };
      toast('公网联机失败：' + S.tunnel.error, 'err', 5200);
      refreshTunnelUi();
    });
  }

  function stopTunnel() {
    var d = desktopTunnel();
    if (!d) return;
    if (!S.tunnel) S.tunnel = {};
    S.tunnel.phase = 'starting';
    refreshTunnelUi();
    Promise.resolve(d.stopTunnel()).then(function () {
      toast('已关闭公网联机', 'ok', 2600);
    }, function () { /* ignore */ });
  }

  /**
   * 入口页那行「公网联机」。它和「房间信息」里的开关是同一份状态（S.tunnel），
   * 只是放在进门就能看见的地方 —— 跨网联机不该藏在二层弹窗里。
   *   · 开 = 给本机服务器加一条公网隧道，跨网的朋友点链接就能进
   *   · 关 = 断掉隧道、切回本地（同一 WiFi 仍能进，服务器不停）
   * 网页版没有起隧道的权限，整行收起来。
   */
  function renderTunnelToggle() {
    var row = $('#tunnelRow');
    if (!row) return;
    var d = setupTunnelBridge();
    if (!d) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    var btn = $('#btnTunnelToggle');
    var st = $('#tunnelState');
    var t = S.tunnel || { phase: 'off' };
    btn.disabled = false;
    if (S.publicUrl || t.phase === 'on') {
      btn.textContent = '关闭公网联机';
      st.className = 'srv-state on';
      st.textContent = '已开启' + (S.publicUrl ? ' · ' + S.publicUrl : '');
    } else if (t.phase === 'downloading' || t.phase === 'starting') {
      btn.disabled = true;
      btn.textContent = '请稍候…';
      st.className = 'srv-state';
      // 慢/卡时把「缓存目录在哪 / 可以手动放」一起给出来（有 hint 才追加）
      var hint = tunnelHintText();
      st.textContent = tunnelStatusText() + (hint ? ' · ' + hint : '');
    } else {
      btn.textContent = '开启公网联机';
      st.className = 'srv-state off';
      st.textContent = '已关闭';
    }
  }

  /** 入口页那颗开关：按当前相位决定开还是关（开着就关、关着就开） */
  function toggleTunnelAction() {
    var t = S.tunnel || { phase: 'off' };
    if (t.phase === 'on' || S.publicUrl) stopTunnel();
    else startTunnel();
  }

  /**
   * 房间信息里的「公网入口」那一行。
   * 网页版只给一句提示（它没有起隧道的权限），桌面端给一键开关。
   */
  function tunnelRowHtml() {
    setupTunnelBridge();                       // 幂等：保证订阅已经接上
    var t = S.tunnel || { phase: 'off' };
    var d = desktopTunnel();
    var inner;
    if (S.publicUrl) {
      inner = '<code>' + esc(S.publicUrl) + '</code>' +
        '<span class="hint">（外网的朋友打开这个地址就能加入）</span>' +
        (d ? ' <button class="btn tiny ghost" id="btnTunnelOff">关闭公网联机</button>' : '');
    } else if (t.phase === 'downloading' || t.phase === 'starting') {
      inner = '<span class="hint">' + esc(tunnelStatusText()) + '</span>'
        + (tunnelHintText() ? '<span class="hint">' + esc(tunnelHintText()) + '</span>' : '');
    } else if (d) {
      inner = '<button class="btn tiny primary" id="btnTunnelOn">开启公网联机</button>' +
        '<span class="hint">（一键穿透，不用装任何东西；外网的朋友点链接就能进来）</span>' +
        (t.error ? '<span class="hint">' + esc(t.error) + '</span>' : '');
    } else {
      inner = '<span class="hint">未开启 —— 在服务端机器上运行 npm run expose ' +
        '就能生成一个外网可访问的链接</span>';
    }
    return '<div class="kv"><label>公网入口</label><div>' + inner + '</div></div>';
  }

  function doShare() {
    if (!S.room) { toast('还没有进入房间'); return; }
    var base = shareBase();
    // ★ 2.0.10：给两条链接 ——
    //   ① http(s) 分享链接：网页端点开就能进，谁都能用；
    //   ② chahui:// 应用链接：装了茶绘的机器点一下直接拉起客户端进房
    //      （安装时注册了这个协议，见 client/package.json 的 build.protocols）。
    //   两条一起复制，粘给谁都能用；本应用自己的「房间链接」输入框两种都认。
    var text = base ? base + '/?room=' + S.room.id : S.room.id;
    if (base) text += '\n茶绘应用链接：' + appRoomLink();
    var note = text + (S.room.hasPassword ? '（房间有密码，请向房主索取）' : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(note).then(function () {
        toast('分享链接已复制：' + note, 'ok', 3600);
      }, function () { showInfo(text); });
    } else {
      showInfo(text);
    }
  }

  /** 应用内链接：chahui://join?room=<房间号>&server=<当前服务器> */
  function appRoomLink() {
    if (!S.room) return '';
    return 'chahui://join?room=' + encodeURIComponent(S.room.id) +
      '&server=' + encodeURIComponent(net.url || '');
  }

  function showInfo(text) {
    $('#infoTitle').textContent = '房间信息';
    var r = S.room || {};
    // 没显式传链接就自己算一条（会优先用公网地址）
    if (text === undefined || text === null) {
      var b0 = shareBase();
      text = b0 && r.id ? b0 + '/?room=' + r.id : (r.id || '');
    }
    $('#infoBody').innerHTML =
      '<div class="kv"><label>房间名</label><div>' + esc(r.name || '-') + '</div></div>' +
      '<div class="kv"><label>房间号</label><div><code>' + esc(r.id || '-') + '</code></div></div>' +
      '<div class="kv"><label>画布</label><div><b>' + (r.width || 0) + ' × ' + (r.height || 0) + '</b> px · ' + (r.online || 0) + ' 人在线' +
        (S.me.isOwner ? ' <button class="btn tiny ghost" id="btnInfoResize">更改分辨率…</button>' : '') +
      '</div></div>' +
      '<div class="kv"><label>笔迹</label><div>' + engine.strokes.length + ' 笔（我可撤销 ' + S.myUndo.length + ' 笔）</div></div>' +
      '<div class="kv"><label>图层</label><div>' + engine.layers.length + ' 层</div></div>' +
      '<div class="kv"><label>服务器</label><div><code>' + esc(net.url) + '</code></div></div>' +
      tunnelRowHtml() +
      (Cfg.lanBase && Cfg.lanBase()
        ? '<div class="kv"><label>局域网</label><div><code>' + esc(Cfg.lanBase()) + '</code>' +
          '<span class="hint">（同一 WiFi 下的朋友用浏览器打开这个地址就能加入）</span></div></div>'
        : '') +
      '<div class="kv"><label>分享链接</label><div><code id="shareLinkText">' + esc(text || '-') + '</code></div></div>' +
      '<div class="info-actions">' +
      '<button class="btn tiny" id="btnInfoCopy">复制链接</button>' +
      '<button class="btn tiny" id="btnInfoLeave">离开房间</button>' +
      '<button class="btn tiny" id="btnInfoClearAll"' + (S.me.isOwner ? '' : ' disabled') + ' title="清空整张画布（仅房主）">清空画布</button>' +
      '<button class="btn tiny danger" id="btnInfoDestroy"' + (S.me.isOwner ? '' : ' disabled') + ' title="解散房间（仅房主）">解散房间</button>' +
      '</div>';
    $('#infoMask').classList.remove('hidden');
    var copyBtn = $('#btnInfoCopy');
    if (copyBtn) copyBtn.onclick = function () { doShare(); };
    var tOn = $('#btnTunnelOn');
    if (tOn) tOn.onclick = function () { startTunnel(); };
    var tOff = $('#btnTunnelOff');
    if (tOff) tOff.onclick = function () { stopTunnel(); };
    var lv = $('#btnInfoLeave');
    if (lv) lv.onclick = function () {
      net.send(P.C2S.ROOM_LEAVE, {});
      setTimeout(function () { if (S.joined) resetRoomUi(''); openEntry(true); }, 300);
    };
    var clr = $('#btnInfoClearAll');
    if (clr) clr.onclick = async function () {
      if (!await confirmDialog('确定清空整张画布？此操作不可恢复。', { danger: true })) return;
      net.send(P.C2S.STROKE_CLEAR, { scope: 'all' });
    };
    var des = $('#btnInfoDestroy');
    if (des) des.onclick = async function () {
      if (!await confirmDialog('确定解散房间？房间内容会被永久删除，所有成员都会被请出。', { danger: true })) return;
      net.send(P.C2S.ROOM_DESTROY, {});
    };
    var rs = $('#btnInfoResize');
    if (rs) rs.onclick = function () {
      $('#infoMask').classList.add('hidden');
      openCanvasDialog();
    };
  }

  /* 画布设置：对照 SAI2 的「图像大小」对话框 —— 宽 / 高 / 打印分辨率 / 重新取样 /
     约束长宽比 / 锁定图像像素 + 「更改前 / 更改后」实时对照。
     以前只能从「房间信息」里点进一个仅房主可见的小按钮，等于藏起来了；
     现在顶栏有独立的「画布」按钮。 */
  var CANVAS_PRESETS = [
    ['1600x1000', '1600 × 1000（横）'],
    ['1920x1080', '1920 × 1080（16:9）'],
    ['1280x1280', '1280 × 1280（方）'],
    ['1080x1920', '1080 × 1920（竖）'],
    ['2400x1350', '2400 × 1350（大横）'],
    ['2048x1536', '2048 × 1536（4:3）'],
    ['800x1200', '800 × 1200（A4 竖 @100dpi）'],
    ['1024x768', '1024 × 768（小稿）']
  ];

  // 长度单位 → 每单位的像素数（按 dpi 换算；pixels 直接返回原值）
  var LEN_UNITS = [
    ['px', 'pixels'],
    ['percent', '百分比'],
    ['cm', '厘米'],
    ['mm', '毫米'],
    ['inch', '英寸']
  ];
  function unitToPx(v, unit, dpi) {
    if (unit === 'cm') return v / 2.54 * dpi;
    if (unit === 'mm') return v / 25.4 * dpi;
    if (unit === 'inch') return v * dpi;
    return v;   // px / percent 由调用方单独处理
  }
  function pxToUnit(px, unit, dpi) {
    if (unit === 'cm') return px / dpi * 2.54;
    if (unit === 'mm') return px / dpi * 25.4;
    if (unit === 'inch') return px / dpi;
    return px;
  }
  function round1(v) { return Math.round(v * 10) / 10; }

  function openCanvasDialog() {
    if (!S.joined || !S.room) { toast('先进房间再调画布', 'err'); openEntry(true); return; }
    var r = S.room;
    var isOwner = !!(S.me && S.me.isOwner);
    var body = $('#confirmBody');
    var mask = $('#confirmMask');
    var yes = $('#confirmYes');
    var no = $('#confirmNo');
    var title = $('#confirmTitle');
    title.textContent = '图像大小';
    yes.textContent = '确定';
    no.textContent = '取消';
    yes.classList.remove('danger');

    var dpi = Number(lsGet('chahu.dpi', '74')) || 74;
    var bgSwatches = ['#ffffff', '#f6f2e9', '#e9eef5', '#2b2b2b', '#101418'];
    var unitW = 'px', unitDpi = 'inch';
    var curW = r.width, curH = r.height;

    function unitOpts(cur) {
      return LEN_UNITS.map(function (u) {
        return '<option value="' + u[0] + '"' + (u[0] === cur ? ' selected' : '') + '>' + u[1] + '</option>';
      }).join('');
    }

    body.innerHTML =
      '<div class="canvas-form image-size">' +
      '<div class="form-row"><label>预设</label><select id="rsPreset" class="mini-select wide">' +
      '<option value="">— 选择预设 —</option>' +
      CANVAS_PRESETS.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-row"><label>宽度</label>' +
      '<input type="number" id="rsW" min="1" step="1" value="' + curW + '" />' +
      '<select id="rsUnitW" class="mini-select unit-sel">' + unitOpts('px') + '</select></div>' +
      '<div class="form-row"><label>高度</label>' +
      '<input type="number" id="rsH" min="1" step="1" value="' + curH + '" />' +
      '<select id="rsUnitH" class="mini-select unit-sel">' + unitOpts('px') + '</select></div>' +
      '<div class="form-row"><label>打印分辨率</label>' +
      '<input type="number" id="rsDpi" min="1" max="1200" step="1" value="' + dpi + '" />' +
      '<select id="rsDpiUnit" class="mini-select unit-sel"><option value="inch">pixels/inch</option>' +
      '<option value="cm">pixels/cm</option></select></div>' +
      '<div class="form-row"><label>重新取样</label>' +
      '<select id="rsFilter" class="mini-select wide">' +
      '<option value="high">两次立方（较平滑）</option>' +
      '<option value="cubic">两次立方</option>' +
      '<option value="bilinear">两次线性</option>' +
      '<option value="nearest">最邻近（硬边）</option>' +
      '<option value="none">无（只改画布尺寸，内容不缩放）</option>' +
      '</select></div>' +
      '<div class="check-row"><input type="checkbox" id="rsRatio" /><span>约束长宽比</span></div>' +
      '<div class="check-row"><input type="checkbox" id="rsLockPx" /><span>锁定图像像素（只改打印尺寸，不动画布）</span></div>' +
      '<div class="form-row"><label>宽高显示单位</label>' +
      '<select id="rsUnitDisp" class="mini-select unit-sel">' + unitOpts('px') + '</select></div>' +
      '<div class="form-row"><label>打印分辨率显示单位</label>' +
      '<select id="rsDpiDisp" class="mini-select unit-sel"><option value="inch">pixels/inch</option>' +
      '<option value="cm">pixels/cm</option></select></div>' +
      '<div class="is-preview">' +
      '<div class="is-block"><b>更改前</b>' +
      '<div>像素大小：<span id="rsBeforePx">' + curW + ' × ' + curH + '</span></div>' +
      '<div>打印尺寸：<span id="rsBeforePrint">—</span></div></div>' +
      '<div class="is-block"><b>更改后</b>' +
      '<div>像素大小：<span id="rsAfterPx">—</span></div>' +
      '<div>打印尺寸：<span id="rsAfterPrint">—</span></div></div>' +
      '</div>' +
      '<div class="form-row"><label>底纸</label><div class="paper-picker" id="cvPaper"></div></div>' +
      (isOwner ? '' : '<p class="hint warn">只有房主可以改画布尺寸；其他人只能看。</p>') +
      '<p class="hint" style="margin:2px 0 0">画布范围 320 – 4096 px。' +
      '选「无」以外的重新取样方式时，画面内容会跟着一起缩放。</p>' +
      '</div>';

    // 底纸取色
    var paperBox = $('#cvPaper');
    bgSwatches.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cv-bg' + (String(r.background).toLowerCase() === c ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.dataset.color = c;
      b.onclick = function () {
        Array.prototype.forEach.call(paperBox.children, function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      };
      paperBox.appendChild(b);
    });

    mask.classList.remove('hidden');

    var elW = $('#rsW'), elH = $('#rsH'), elDpi = $('#rsDpi');
    var elUnitW = $('#rsUnitW'), elUnitH = $('#rsUnitH');
    var elDpiUnit = $('#rsDpiUnit'), elDpiDisp = $('#rsDpiDisp'), elUnitDisp = $('#rsUnitDisp');
    var elRatio = $('#rsRatio'), elLock = $('#rsLockPx'), elFilter = $('#rsFilter');
    // 上一次用过的单位：切换单位时要用它把当前数值换算过去，否则「1920 像素」会变成「1920 厘米」
    var lastUnitW = 'px', lastUnitH = 'px';

    function effDpi() {
      var v = Number(elDpi.value) || 72;
      return elDpiUnit.value === 'cm' ? v * 2.54 : v;
    }
    /** 输入框的数值 → 像素（百分比相对当前画布尺寸） */
    function fieldToPx(el, unit, base) {
      var v = Number(el.value);
      if (!isFinite(v) || v <= 0) return 0;
      if (unit === 'percent') return Math.round(base * v / 100);
      return Math.round(unitToPx(v, unit, effDpi()));
    }
    function pxToField(px, unit, base) {
      if (unit === 'percent') return round1(base ? px / base * 100 : 100);
      return round1(pxToUnit(px, unit, effDpi()));
    }
    function wanted() {
      if (elLock.checked) return { w: curW, h: curH };   // 锁定图像像素：不动画布
      return {
        w: fieldToPx(elW, elUnitW.value, curW),
        h: fieldToPx(elH, elUnitH.value, curH)
      };
    }
    function mmOf(px, d) { return round1(px / d * 25.4); }
    function printText(w, h) {
      var d = effDpi();
      if (!w || !h || !d) return '—';
      if (elDpiDisp.value === 'cm') {
        return round1(w / d * 2.54) + 'cm × ' + round1(h / d * 2.54) + 'cm（' +
          round1(d / 2.54) + ' pixels/cm）';
      }
      return mmOf(w, d) + 'mm × ' + mmOf(h, d) + 'mm（' + Math.round(d) + ' pixels/inch）';
    }

    function refreshFields() {
      var d = effDpi();
      $('#rsBeforePx').textContent = curW + ' × ' + curH;
      $('#rsBeforePrint').textContent = mmOf(curW, d) + 'mm × ' + mmOf(curH, d) + 'mm（' +
        Math.round(d) + ' pixels/inch）';

      var w = wanted();
      var okW = w.w >= 320 && w.w <= 4096, okH = w.h >= 240 && w.h <= 4096;
      var afterPx = $('#rsAfterPx');
      afterPx.textContent = w.w + ' × ' + w.h + ((okW && okH) ? '' : '　✗ 超出 320-4096');
      afterPx.className = (okW && okH) ? '' : 'bad';
      $('#rsAfterPrint').textContent = elLock.checked
        ? '（锁定图像像素，画布尺寸不变）'
        : printText(w.w, w.h);

      elW.disabled = elH.disabled = elLock.checked;
      elUnitW.disabled = elUnitH.disabled = elLock.checked;
      yes.disabled = !isOwner;
      yes.title = isOwner ? '' : '只有房主可以改画布尺寸';
    }

    /** 切换某个宽高字段的单位，并把数值按旧单位换算过去 */
    function switchUnit(which, newUnit) {
      if (which === 'w') {
        var px = fieldToPx(elW, lastUnitW, curW) || curW;
        lastUnitW = newUnit;
        elW.value = pxToField(px, lastUnitW, curW);
      } else {
        var px2 = fieldToPx(elH, lastUnitH, curH) || curH;
        lastUnitH = newUnit;
        elH.value = pxToField(px2, lastUnitH, curH);
      }
      // 「宽高显示单位」跟着走：两边一致时才同步，避免它显示一个不存在的状态
      if (lastUnitW === lastUnitH) { elUnitDisp.value = lastUnitW; }
      refreshFields();
    }

    elW.addEventListener('input', function () {
      if (elRatio.checked) {
        if (elUnitH.value !== elUnitW.value) { elUnitH.value = elUnitW.value; lastUnitH = elUnitW.value; }
        elH.value = round1(Number(elW.value) * (curH / curW));
      }
      refreshFields();
    });
    elH.addEventListener('input', function () {
      if (elRatio.checked) {
        if (elUnitW.value !== elUnitH.value) { elUnitW.value = elUnitH.value; lastUnitW = elUnitH.value; }
        elW.value = round1(Number(elH.value) * (curW / curH));
      }
      refreshFields();
    });
    elUnitW.addEventListener('change', function () { switchUnit('w', elUnitW.value); });
    elUnitH.addEventListener('change', function () { switchUnit('h', elUnitH.value); });
    // 「宽高显示单位」是两栏单位的快捷开关（与 SAI2 一致：改它两栏一起变）
    elUnitDisp.addEventListener('change', function () {
      var u = elUnitDisp.value;
      elUnitW.value = u; elUnitH.value = u;
      lastUnitW = u; lastUnitH = u;
      elW.value = pxToField(curW, u, curW);
      elH.value = pxToField(curH, u, curH);
      var w = wanted();
      elW.value = pxToField(w.w || curW, u, curW);
      elH.value = pxToField(w.h || curH, u, curH);
      refreshFields();
    });
    elDpi.addEventListener('input', function () {
      lsSet('chahu.dpi', String(Number(elDpi.value) || 74));
      refreshFields();
    });
    elDpiUnit.addEventListener('change', refreshFields);
    elDpiDisp.addEventListener('change', refreshFields);
    elLock.addEventListener('change', refreshFields);
    elRatio.addEventListener('change', refreshFields);
    elFilter.addEventListener('change', refreshFields);

    function syncFromPreset() {
      var v = String($('#rsPreset').value || '').split('x');
      if (v.length !== 2) return;
      elUnitW.value = 'px'; elUnitH.value = 'px'; elUnitDisp.value = 'px';
      lastUnitW = 'px'; lastUnitH = 'px';
      elW.value = parseInt(v[0], 10);
      elH.value = parseInt(v[1], 10);
      refreshFields();
    }
    $('#rsPreset').addEventListener('change', syncFromPreset);

    refreshFields();

    function done(ok) {
      mask.classList.add('hidden');
      yes.removeEventListener('click', yesFn);
      no.removeEventListener('click', noFn);
      mask.removeEventListener('click', maskFn);
      if (ok) applyCanvas();
    }
    function applyCanvas() {
      if (!isOwner) { toast('只有房主可以调整画布设置', 'err'); return; }
      var active = paperBox.querySelector('.cv-bg.active');
      var bg = active ? active.dataset.color : null;
      if (bg && bg.toLowerCase() !== String(S.room.background).toLowerCase()) {
        net.send(P.C2S.ROOM_INFO, { background: bg });
      }
      if (elLock.checked) { toast(bg ? '底纸已更新' : '已锁定图像像素，画布尺寸未变'); return; }
      var w = wanted();
      if (!w.w || !w.h || w.w < 320 || w.w > 4096 || w.h < 240 || w.h > 4096) {
        toast('画布范围是 320-4096 × 240-4096', 'err');
        return;
      }
      var filter = elFilter.value;
      if (w.w === curW && w.h === curH) { toast(bg ? '底纸已更新' : '画布尺寸未变化'); return; }
      if (filter === 'none') {
        net.send(P.C2S.ROOM_RESIZE, { width: w.w, height: w.h });
        toast('画布已改为 ' + w.w + ' × ' + w.h + '（内容未缩放）');
      } else {
        scaleArtwork(w.w, w.h, filter);
      }
    }
    var yesFn = function () { done(true); };
    var noFn = function () { done(false); };
    var maskFn = function (e) { if (e.target === mask) done(false); };
    yes.addEventListener('click', yesFn);
    no.addEventListener('click', noFn);
    mask.addEventListener('click', maskFn);
    setTimeout(function () { yes.focus(); }, 30);
  }

  /**
   * 「图像大小」里带缩放的改尺寸：先把每个图层渲染出来按新尺寸重取样，
   * 等服务端确认新尺寸并重新同步完之后，再把缩放结果作为图层像素回传。
   * 变换后的像素没法用笔迹重放表达，所以走 LAYER_PIXELS（服务端依旧只存 PNG）。
   */
  var pendingLayerPixels = null;

  function scaleArtwork(w, h, filter) {
    if (!S.me.isOwner) { toast('只有房主可以改画布尺寸', 'err'); return; }
    var oldW = engine.width, oldH = engine.height;
    var smoothMap = { high: 'high', cubic: 'high', bilinear: 'medium', nearest: 'low' };
    var quality = smoothMap[filter] || 'high';
    var pngs = {};
    engine.layers.forEach(function (l) {
      var src = engine.renderLayerRaw(l.id);          // 旧尺寸的原始像素
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var cx = c.getContext('2d');
      cx.imageSmoothingEnabled = filter !== 'nearest';
      cx.imageSmoothingQuality = quality;
      cx.drawImage(src, 0, 0, oldW, oldH, 0, 0, w, h);
      pngs[l.id] = c.toDataURL('image/png');
    });
    pendingLayerPixels = { pngs: pngs, upToSeq: engine.seq };
    toast('正在把画面缩放到 ' + w + ' × ' + h + '…');
    net.send(P.C2S.ROOM_RESIZE, { width: w, height: h });
    // 兜底：万一没等到重新同步，也别把状态一直挂着
    setTimeout(flushPendingPixels, 6000);
  }

  function flushPendingPixels() {
    if (!pendingLayerPixels) return;
    var job = pendingLayerPixels;
    pendingLayerPixels = null;
    Object.keys(job.pngs).forEach(function (lid) {
      if (!engine.getLayer(lid)) return;
      net.send(P.C2S.LAYER_PIXELS, { layerId: lid, png: job.pngs[lid], upToSeq: job.upToSeq });
    });
  }

  // 兼容旧入口
  function openResizeDialog() { openCanvasDialog(); }

  /**
   * 改画布尺寸但**画面不缩放** —— 「画布大小」和「裁剪到选区」都走这一条路。
   *
   * 每个图层先在旧尺寸下取原始像素，按锚点（或给定偏移）画进新尺寸的画布：
   * 多出来的地方留透明，画到外面的部分自然被裁掉。
   * 然后等服务端确认新尺寸、重新同步完，再把这些像素作为图层内容回传
   * （裁剪过的像素没法用笔迹重放表达，只能走 LAYER_PIXELS）。
   *
   * ⚠ 别再拿 scaleArtwork 当裁剪用 —— 那是**缩放**（旧画面会被拉成新尺寸），
   * 以前的「裁剪」就是这么瞎的：裁完内容全被拉伸，看着完全不对。
   *
   * @param {number} w 新宽  @param {number} h 新高
   * @param {number} ax 水平锚点 0=贴左 0.5=居中 1=贴右
   * @param {number} ay 垂直锚点 0=贴上 0.5=居中 1=贴下
   */
  function resizeCanvasKeepContent(w, h, ax, ay) {
    if (!S.joined) { toast('先进入一个房间', 'err'); return false; }
    if (!S.me.isOwner) { toast('只有房主可以改画布尺寸', 'err'); return false; }
    if (engine.transform) commitTransform();
    w = Math.round(w); h = Math.round(h);
    if (!w || !h || w < 320 || w > 4096 || h < 240 || h > 4096) {
      toast('画布范围是 320-4096 × 240-4096', 'err');
      return false;
    }
    var oldW = engine.width, oldH = engine.height;
    if (w === oldW && h === oldH) { toast('画布尺寸没变化'); return false; }
    var dx = Math.round((w - oldW) * ax);
    var dy = Math.round((h - oldH) * ay);
    var pngs = {};
    engine.layers.forEach(function (l) {
      var src = engine.renderLayerRaw(l.id);          // 旧尺寸的原始像素
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var cx2 = c.getContext('2d');
      cx2.imageSmoothingEnabled = false;
      // 只平移，不缩放：src 按原大小画在 (dx,dy)，越界的部分自动被裁掉
      cx2.drawImage(src, dx, dy);
      pngs[l.id] = c.toDataURL('image/png');
    });
    pendingLayerPixels = { pngs: pngs, upToSeq: engine.seq };
    // 选区是旧坐标系的，画布一动就对不上了，直接清掉
    if (engine.hasSelection && engine.hasSelection()) {
      beginSelSnapshot();
      engine.clearSelection();
      commitSelSnapshot();
    }
    net.send(P.C2S.ROOM_RESIZE, { width: w, height: h });
    toast('画布已改为 ' + w + ' × ' + h + '（画面未缩放）', 'ok');
    // 兜底：万一没等到重新同步，也别把状态一直挂着
    setTimeout(flushPendingPixels, 6000);
    return true;
  }

  /* ---------------------------------------------------------- 画布大小对话框 */

  var csizeAnchor = { ax: 0.5, ay: 0.5 };

  /** 某一层「有内容」的范围（不含透明边），用来算「刚好装下内容」 */
  function layerContentBounds(id) {
    var src = engine.renderLayerRaw(id);
    var W = src.width, H = src.height;
    var d = src.getContext('2d').getImageData(0, 0, W, H).data;
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) {
      var row = y * W * 4;
      for (var x = 0; x < W; x++) {
        if (d[row + x * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function openCanvasSizeDialog() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var mask = $('#csizeMask');
    if (!mask) return;
    $('#csizeW').value = engine.width;
    $('#csizeH').value = engine.height;
    csizeAnchor = { ax: 0.5, ay: 0.5 };
    paintAnchor();
    csizePreview();
    mask.classList.remove('hidden');
    setTimeout(function () { $('#csizeW').focus(); $('#csizeW').select(); }, 30);
  }
  function closeCanvasSizeDialog() { var m = $('#csizeMask'); if (m) m.classList.add('hidden'); }

  function paintAnchor() {
    document.querySelectorAll('#csizeAnchor button').forEach(function (b) {
      b.classList.toggle('on',
        parseFloat(b.dataset.ax) === csizeAnchor.ax && parseFloat(b.dataset.ay) === csizeAnchor.ay);
    });
  }

  function csizePreview() {
    var el = $('#csizePreview');
    if (!el) return;
    var w = Math.round(parseFloat($('#csizeW').value) || 0);
    var h = Math.round(parseFloat($('#csizeH').value) || 0);
    var o = engine.width + ' × ' + engine.height;
    if (!w || !h) { el.textContent = '更改前 ' + o; return; }
    var d = (w - engine.width) + ' × ' + (h - engine.height);
    var what = (w > engine.width || h > engine.height) ? '（会多出透明边）' : '';
    if (w < engine.width || h < engine.height) what = '（超出的画面会被裁掉）';
    if (w === engine.width && h === engine.height) what = '（没变化）';
    el.textContent = '更改前 ' + o + '　→　更改后 ' + w + ' × ' + h
      + '　Δ ' + d + ' ' + what;
  }

  function bindCanvasSizeDialog() {
    if (!$('#csizeMask')) return;
    var mask = $('#csizeMask');
    $('#csizeW').addEventListener('input', csizePreview);
    $('#csizeH').addEventListener('input', csizePreview);
    document.querySelectorAll('#csizeAnchor button').forEach(function (b) {
      b.addEventListener('click', function () {
        csizeAnchor = { ax: parseFloat(b.dataset.ax), ay: parseFloat(b.dataset.ay) };
        paintAnchor();
      });
    });
    $('#btnCSizeSwap').addEventListener('click', function () {
      var w = $('#csizeW').value, h = $('#csizeH').value;
      $('#csizeW').value = h; $('#csizeH').value = w;
      csizePreview();
    });
    // 「刚好装下内容」：把画布扩到能放下所有图层内容，一点不裁
    $('#btnCSizeMax').addEventListener('click', function () {
      var bb = null;
      engine.layers.forEach(function (l) {
        var b = layerContentBounds(l.id);
        if (!b) return;
        if (!bb) bb = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
        else {
          bb.x0 = Math.min(bb.x0, b.x); bb.y0 = Math.min(bb.y0, b.y);
          bb.x1 = Math.max(bb.x1, b.x + b.w); bb.y1 = Math.max(bb.y1, b.y + b.h);
        }
      });
      if (!bb) { toast('还没有画任何东西'); return; }
      // 内容基本都在画布内，所以「装下内容」= 现在这么大；只有贴着边的才需要扩
      var w = clamp(Math.ceil(Math.max(bb.x1, engine.width)), 320, 4096);
      var h = clamp(Math.ceil(Math.max(bb.y1, engine.height)), 240, 4096);
      $('#csizeW').value = w;
      $('#csizeH').value = h;
      csizePreview();
      toast(w === engine.width && h === engine.height
        ? '内容已经装得下了，不用改'
        : '已填上刚好装得下的尺寸');
    });
    $('#btnCSizeOk').addEventListener('click', function () {
      var w = Math.round(parseFloat($('#csizeW').value) || 0);
      var h = Math.round(parseFloat($('#csizeH').value) || 0);
      if (resizeCanvasKeepContent(w, h, csizeAnchor.ax, csizeAnchor.ay)) closeCanvasSizeDialog();
    });
    $('#btnCSizeZero').addEventListener('click', closeCanvasSizeDialog);
    $('#btnCSizeCancel').addEventListener('click', closeCanvasSizeDialog);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeCanvasSizeDialog(); });
  }

  function resetRoomUi(reason) {
    // 掉线 / 换房时把没提交的变换丢掉，免得图层一直停在「被挖空」的状态
    if (engine.transform) { engine.endTransform(false); endTransformUi(); }
    closeGameUi();
    S.game = null;
    S.gamePrefs = null;       // 房主的预设跟着房间走，换房就作废
    prefsLastSent = '';
    if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
    S.gameRoundKey = '';
    S.gameWordShown = '';
    S.joined = false;
    S.me.isOwner = false;
    S.me.readonly = false;
    S.room = null;
    S.members = [];
    S.myUndo = [];
    S.myRedo = [];
    S.session = null;
    clearCursors();
    engine.init({ width: 1600, height: 1000, background: '#ffffff', layers: [{ id: 'L0', name: '图层 1' }] });
    $('#chatList').innerHTML = '';
    $('#memberCount').textContent = '0';
    $('#strokeCount').textContent = '0';
    $('#roomTitle').textContent = '未加入房间';
    $('#roomMeta').textContent = '—';
    $('#stageEmpty').classList.remove('hidden');
    $('#infoMask').classList.add('hidden');
    renderLayers();
    renderHistory();
    renderMembers();
    toggleNav(false);
    if (reason) toast(reason, 'err', 4200);
    else setStatus('已离开房间');
    try {
      if (location.protocol !== 'file:') {
        var u = new URL(location.href);
        u.searchParams.delete('room');
        history.replaceState(null, '', u.toString());
      }
    } catch (e) { /* ignore */ }
  }

  /* ============================================================ 键盘 */

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.code === 'Space') {
        if (!typing) { S.spaceDown = true; $('#stage').classList.add('panning'); e.preventDefault(); }
        return;
      }
      if (typing) return;
      // 右键弹窗的「捕获新快捷键」模式：把下一个字母 / Alt 吃下来，别的键都不响应
      if (ctxCapturing && ctxItem) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { ctxCapturing = false; refreshIcmKey(); return; }
        if (e.key === 'Alt') {
          ITEM_KEYS[ctxItem.id] = 'Alt';
        } else if (/^[a-zA-Z]$/.test(e.key)) {
          var up = e.key.toUpperCase();
          // X 互换色 / D 黑白 / H 翻转 是全局功能键（H 同时还在菜单里），不让笔刷抢
          if (up === 'X' || up === 'D' || up === 'H') {
            toast('X / D / H 是全局功能键，换一个吧', 'err');
            return;
          }
          ITEM_KEYS[ctxItem.id] = up;
        } else {
          return;  // Shift / F1 这类不理，继续等
        }
        saveKeymap();
        ctxCapturing = false;
        refreshIcmKey();
        return;
      }
      // 右键小弹窗开着时按 Esc 关掉它
      if (ctxItem && e.key === 'Escape') { closeItemCtx(); return; }
      // 菜单 / 快捷键先过一遍：键位是可以在「快捷键设置」里改的
      if (global.ChaMenu) {
        var hit = global.ChaMenu.matchEvent(e);
        // 但「不带修饰键的单键」不能抢交互控件的输入：
        // 焦点在按钮上时按 Enter / Space 是「按下这个按钮」，不是触发菜单里的「变换：确定」。
        var ctl = /^(BUTTON|A|SELECT|SUMMARY)$/.test(e.target.tagName || '');
        var bare = !/^(Ctrl|Alt)\+/.test(hit ? global.ChaMenu.keyOf(hit.id) : '');
        if (hit && !(ctl && bare)) {
          e.preventDefault();
          try { hit.run(); } catch (err) { console.error(err); }
          return;
        }
      }
      // 变换中：Enter 确定、Esc 中止，其余快捷键一律不响应，免得手滑把变换丢了
      if (engine.transform) {
        if (e.key === 'Enter') { e.preventDefault(); commitTransform(); return; }
        if (e.key === 'Escape') { e.preventDefault(); cancelTransform(); return; }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); return; }
        if (e.key === 's' || e.key === 'e') { e.preventDefault(); doExport(); return; }
        if (e.key === 'a') { e.preventDefault(); beginSelSnapshot(); engine.selectAll(); commitSelSnapshot(); toast('已全选'); return; }
        if (e.key === 'd') { e.preventDefault(); beginSelSnapshot(); engine.clearSelection(); commitSelSnapshot(); toast('已取消选区'); return; }
        if (e.key === 'i') { e.preventDefault(); beginSelSnapshot(); invertSelection(); commitSelSnapshot(); return; }
        if (e.key === 't') { e.preventDefault(); if (engine.transform) commitTransform(); else startTransform(); return; }
        // PS 习惯：Ctrl+0 适应窗口、Ctrl+1 100%（裸的 0/1 让给了适应窗口和笔刷槽位）
        if (e.key === '0') { e.preventDefault(); engine.fitView(); return; }
        if (e.key === '1') { e.preventDefault(); engine.setZoom(1); return; }
        if (e.key === 'n' && e.shiftKey) {
          e.preventDefault();
          if (S.joined) net.send(P.C2S.LAYER_ADD, { name: '图层 ' + (engine.layers.length + 1) });
          return;
        }
        return;
      }
      var k = e.key.toLowerCase();
      // 单字母 = 单笔快捷键（右键笔刷可自定义；比旧的「家族切换」更直观 ——
      // B 永远是「画笔」本人，W 是魔棒。收起的笔不吃键。）
      if (k.length === 1 && k >= 'a' && k <= 'z') {
        var hitItem = findItemByKey(k);
        if (hitItem) { loadBrush(hitItem); return; }
      }
      if (k === '[') { setSize(S.brush.size - Math.max(1, S.brush.size * 0.15)); return; }
      if (k === ']') { setSize(S.brush.size + Math.max(1, S.brush.size * 0.15)); return; }
      if (k === 'x') { swapColors(); return; }
      // D = 回到黑前景 / 白背景（和 PS / Krita 一样，X 互换的搭档键）
      if (k === 'd') {
        setColor('#000000', false);
        setBgColor('#ffffff');
        toast('前景黑 / 背景白');
        return;
      }
      if (k === 'h') { engine.flipView(); return; }
      if (k === ',') { engine.rotateBy(-15); return; }
      if (k === '.') { engine.rotateBy(15); return; }
      if (k === '0') { engine.fitView(); return; }
      // 数字键 1-9 = 笔刷栏第 1-9 支笔（按当前面板顺序 —— 把常用的排前面就行）
      if (k >= '1' && k <= '9') {
        var slot = visibleItems().filter(isBrushItem)[Number(k) - 1];
        if (slot) loadBrush(slot.id);
        return;
      }
      if (k === '=' || k === '+') { engine.setZoom(engine.scale * 1.25); return; }
      if (k === '-') { engine.setZoom(engine.scale / 1.25); return; }
      if (k === 'tab') { e.preventDefault(); toggleNav(); return; }
    });
    document.addEventListener('keyup', function (e) {
      if (e.code === 'Space') {
        S.spaceDown = false;
        if (!S.pan) $('#stage').classList.remove('panning');
      }
    });

    /* ---- Alt = 临时吸管，光标要跟着变成吸管 ----
     * 为什么单独盯 Alt（而不是在 pointermove 里顺手读 e.altKey）：按住 Alt 之后
     * **不移动鼠标**也得立刻换光标 —— 用户是在「先把 Alt 按下去、再准备点」，
     * 那一刻还没有任何指针事件，只靠 pointermove 会一直是圆环，看着像没生效。
     */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Alt' || S.altDown) return;
      S.altDown = true;
      updateBrushCursor();
    });
    document.addEventListener('keyup', function (e) {
      if (e.key !== 'Alt') return;
      S.altDown = false;
      updateBrushCursor();
    });
    // Alt+Tab 切出去时收不到 keyup，切回来光标会永远卡在吸管上
    window.addEventListener('blur', function () {
      if (!S.altDown) return;
      S.altDown = false;
      updateBrushCursor();
    });
  }

  function swapColors() {
    var c = S.color;
    setColor(S.bgColor, false);
    setBgColor(c);
    toast('前景 ' + S.color.toUpperCase() + ' / 背景 ' + S.bgColor.toUpperCase());
  }

  /** 背景色：只在自己和前景色互换时用得到，但得看得见 —— 不然「互换」点了像没反应 */
  function setBgColor(hex) {
    S.bgColor = hex;
    var el = $('#bgPreview');
    if (el) el.style.background = hex;
    try { $('#bgColorInput').value = hex; } catch (e) { /* ignore */ }
  }

  /* ============================================================ 选区 */

  function wipe(ctx, w, h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
  }

  /** 反选：全画布 - 当前选区 */
  function invertSelection() {
    var s = engine.ensureSelection();
    var W = engine.width, H = engine.height;
    var tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    var tc = tmp.getContext('2d');
    tc.fillStyle = '#ffffff';
    tc.fillRect(0, 0, W, H);
    tc.globalCompositeOperation = 'destination-out';
    tc.drawImage(s.canvas, 0, 0);
    tc.globalCompositeOperation = 'source-over';
    wipe(s.ctx, W, H);
    s.ctx.drawImage(tmp, 0, 0);
    s.active = true;
    engine.refreshSelectionTint();
    // 反选之后可能一个像素都不剩（比如原本就是全选）——那就等于没有选区，
    // 不要留下「有选区」的假状态，否则用户会发现画笔什么都画不上
    if (!s.bbox) { s.active = false; s.bbox = null; }
    engine.drawOverlay();
    engine.emit('selection', { active: engine.hasSelection() });
    engine.invalidate();
    toast('已反选');
  }

  /* ============================================================ 表情包 */

  var BUILTIN_EMOJI = [
    '😀', '😄', '😆', '😅', '😂', '🙂', '😉', '😊',
    '😍', '😘', '😜', '🤔', '😐', '😴', '😭', '😡',
    '😱', '🥺', '😳', '🤯', '👍', '👎', '👏', '🙏',
    '💪', '✌️', '🤝', '🎉', '✨', '🔥', '💧', '❤️',
    '💔', '⭐', '🍵', '🍰', '🐱', '🐶', '🌸', '🎨'
  ];

  function saveStickers() {
    try { lsSet('chahu.stickers', JSON.stringify(S.stickers)); }
    catch (e) { toast('本地存储已满，表情可能无法保存', 'err'); }
  }

  function toggleStickerPanel(on) {
    var el = $('#stickerPanel');
    var open = on == null ? el.classList.contains('hidden') : !!on;
    el.classList.toggle('hidden', !open);
    $('#btnSticker').classList.toggle('active', open);
    if (open) renderStickers();
  }

  function renderStickers() {
    var b = $('#stickerBuiltin');
    if (!b.dataset.built) {
      b.dataset.built = '1';
      BUILTIN_EMOJI.forEach(function (e) {
        var el = document.createElement('button');
        el.className = 'st emoji';
        el.textContent = e;
        el.title = '发送 ' + e;
        el.onclick = function () { sendSticker(e, null); };
        b.appendChild(el);
      });
    }
    var mine = $('#stickerMine');
    mine.classList.toggle('managing', S.stickerManaging);
    mine.innerHTML = '';
    S.stickers.forEach(function (url) {
      var el = document.createElement('button');
      el.className = 'st';
      el.title = '发送这张表情';
      var img = document.createElement('img');
      img.src = url;
      img.alt = '表情';
      el.appendChild(img);
      var del = document.createElement('button');
      del.className = 'st-del';
      del.textContent = '✕';
      del.title = '删除';
      del.onclick = function (ev) {
        ev.stopPropagation();
        S.stickers.splice(S.stickers.indexOf(url), 1);
        saveStickers();
        renderStickers();
        toast('已删除该表情');
      };
      el.appendChild(del);
      el.onclick = function () { sendSticker(null, url); };
      mine.appendChild(el);
    });
    $('#stickerMineCount').textContent = S.stickers.length ? '（' + S.stickers.length + '）' : '';
    $('#stickerMineEmpty').classList.toggle('hidden', S.stickers.length > 0);
    $('#btnStickerManage').classList.toggle('active', S.stickerManaging);
  }

  /** 压缩到 220px 以内再存，避免本地存储与房间存档被撑爆 */
  function shrinkImage(file, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 220;
        var k = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
        var w = Math.max(1, Math.round((img.width || max) * k));
        var h = Math.max(1, Math.round((img.height || max) * k));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var cx = c.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        var png = /png|gif|webp/.test(file.type || '');
        try { cb(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85)); }
        catch (e) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = String(fr.result);
    };
    fr.onerror = function () { cb(null); };
    fr.readAsDataURL(file);
  }

  function addStickerFiles(files) {
    var list = Array.prototype.slice.call(files || []).slice(0, 12);
    if (!list.length) return;
    var pending = list.length, added = 0;
    function done() {
      if (--pending > 0) return;
      if (added) {
        saveStickers();
        renderStickers();
        toast('已添加 ' + added + ' 张表情', 'ok');
      }
    }
    list.forEach(function (f) {
      if (!/^image\//.test(f.type || '')) { toast('「' + (f.name || '文件') + '」不是图片', 'err'); done(); return; }
      if (S.stickers.length + added >= 24) { toast('自定义表情最多 24 张', 'err'); done(); return; }
      var accept = function (url) {
        if (!url) { toast('「' + (f.name || '图片') + '」读取失败', 'err'); }
        else { S.stickers.push(url); added++; }
        done();
      };
      // 小图原样保留；GIF 无论大小都原样保留 —— canvas 重编码会把动画压成静态第一帧
      if (f.size <= 160 * 1024 || /gif/i.test(f.type || '')) {
        var fr = new FileReader();
        fr.onload = function () {
          var u = P.normalizeSticker(String(fr.result));
          if (!u && /gif/i.test(f.type || '')) {
            toast('「' + (f.name || 'GIF') + '」超过 220KB，加不进表情（太大的 GIF 保不住动画）', 'err');
          }
          accept(u);
        };
        fr.onerror = function () { accept(null); };
        fr.readAsDataURL(f);
      } else {
        shrinkImage(f, function (url) { accept(url ? P.normalizeSticker(url) : null); });
      }
    });
  }

  function sendSticker(emoji, url) {
    if (!S.joined) { toast('还没有进入房间'); return; }
    if (url) net.send(P.C2S.CHAT, { text: '', img: url });
    else net.send(P.C2S.CHAT, { text: emoji });
  }

  function bindStickers() {
    $('#btnSticker').addEventListener('click', function () { toggleStickerPanel(); });
    $('#btnStickerClose').addEventListener('click', function () { toggleStickerPanel(false); });
    $('#btnStickerAdd').addEventListener('click', function () { $('#stickerFile').click(); });
    $('#btnStickerManage').addEventListener('click', function () {
      S.stickerManaging = !S.stickerManaging;
      renderStickers();
    });
    $('#stickerFile').addEventListener('change', function () {
      addStickerFiles(this.files);
      this.value = '';
    });
    renderStickers();
  }

  /* ============================================================ 事件绑定 */

  function bindUI() {
    bindRow('sizeRange', 'size', function (v) { return clamp(Math.round(v), 1, 300); }, function (v) { return v; });
    bindRow('opacityRange', 'opacity', function (v) { return clamp(v / 100, 0.02, 1); }, function (v) { return v; });
    bindRow('hardnessRange', 'hardness', function (v) { return v / 100; }, function (v) { return v; });
    bindRow('minSizeRange', 'minSize', function (v) { return clamp(v / 100, 0.02, 1); }, function (v) { return v; });
    bindRow('pressSizeRange', 'pressSize', function (v) { return v / 100; }, function (v) { return v; });
    bindRow('pressOpacityRange', 'pressOpacity', function (v) { return v / 100; }, function (v) { return v; });
    bindRow('strengthRange', 'strength', function (v) { return clamp(v / 100, 0.05, 1); }, function (v) { return v; });
    bindRow('smudgeRange', 'strength', function (v) { return clamp(v / 100, 0.05, 1); }, function (v) { return v; });
    bindRow('toleranceRange', 'tolerance', function (v) { return clamp(Math.round(v), 1, 120); }, function (v) { return v; });
    bindRow('expandRange', 'expand', function (v) { return clamp(Math.round(v), 0, 8); }, function (v) { return v; });

    $('#sizeRange').addEventListener('input', markSizePresets);
    $('#brushBlend').addEventListener('change', function () { bset('blend', this.value); });

    /* ★ 2.0.10：笔尖形状 / 角度（照 SAI2 的笔刷形状面板） */
    $$('#tipShapes .tip-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        bset('tipShape', btn.dataset.tip || 'round');
        syncBrushUI();
      });
    });
    bindRow('tipAngleRange', 'tipAngle', function (v) { return clamp(Math.round(v), 0, 180); }, function (v) { return v; });
    $('#filledChk').addEventListener('change', function () { bset('filled', this.checked); });
    $('#pressureChk').addEventListener('change', function () {
      S.pressure = this.checked;
      lsSet('chahu.pressure', S.pressure ? '1' : '0');
      renderPenHint();          // 关掉压感时把提示也撤掉
    });
    $('#stabilizeRange').addEventListener('input', function () {
      S.stabilize = Number(this.value);
      $('#stabilizeVal').textContent = S.stabilize;
      lsSet('chahu.stabilize', String(S.stabilize));
    });
    $('#btnBrushReset').addEventListener('click', function () {
      delete S.overrides[S.brushId];
      lsSet('chahu.brushes', JSON.stringify(S.overrides));
      loadBrush(S.brushId);
      toast('已复位「' + (Brushes.get(S.brushId) || {}).name + '」');
    });

    /* ---- 特殊效果：纸张质感 + 特效 ---- */

    $('#paperSelect').addEventListener('change', function () {
      var id = this.value;
      var p = Brushes.PAPER_PRESETS[id] || { grain: 0, grainScale: 1 };
      S.brush.paper = id;
      S.brush.grain = p.grain;
      S.brush.grainScale = p.grainScale;
      saveOverrides();
      syncBrushUI();
      toast('纸张质感：' + this.options[this.selectedIndex].textContent);
    });
    $('#paperStrength').addEventListener('input', function () {
      var v = clamp(Number(this.value) / 100, 0, 1);
      if (v > 0 && S.brush.paper === 'none') {
        S.brush.paper = 'fine';
        $('#paperSelect').value = 'fine';
      }
      bset('grain', v);
      $('#paperStrengthVal').textContent = this.value;
    });
    $('#paperScale').addEventListener('input', function () {
      bset('grainScale', clamp(Number(this.value) / 100, 0.2, 4));
      $('#paperScaleVal').textContent = this.value + '%';
    });

    $('#fxSelect').addEventListener('change', function () {
      var id = this.value;
      S.brush.fx = id;
      var p = Brushes.FX_PRESETS[id] || {};
      Object.keys(p).forEach(function (k) { S.brush[k] = p[k]; });
      saveOverrides();
      syncBrushUI();
    });
    $('#fxWidth').addEventListener('input', function () {
      setFxWidth(Number(this.value) / 100);
      $('#fxWidthVal').textContent = this.value;
    });
    $('#fxStrength').addEventListener('input', function () {
      setFxStrength(Number(this.value) / 100);
      $('#fxStrengthVal').textContent = this.value;
    });

    /* ---- 选区 ---- */

    $('#btnSelAll').addEventListener('click', function () {
      beginSelSnapshot(); engine.selectAll(); commitSelSnapshot(); toast('已全选');
    });
    $('#btnSelInvert').addEventListener('click', function () {
      beginSelSnapshot(); invertSelection(); commitSelSnapshot();
    });
    $('#btnSelNone').addEventListener('click', function () {
      beginSelSnapshot(); engine.clearSelection(); commitSelSnapshot(); toast('已取消选区');
    });
    // 状态栏的「有选区」点一下就能取消 —— 卡在选区里画不出东西时最容易找到的出口
    var selHintEl = $('#selHint');
    if (selHintEl) selHintEl.addEventListener('click', function () {
      if (engine.hasSelection()) {
        beginSelSnapshot(); engine.clearSelection(); commitSelSnapshot(); toast('已取消选区');
      }
    });

    // ★ v2.0.10：锁定行四颗（透明像素 / 画笔 / 移动 / 全部）—— 都是逐层开关，改一下同步出去
    $('#lockChk').addEventListener('change', function () { patchActiveLayer({ locked: this.checked }); });
    $('#lockDrawChk').addEventListener('change', function () { patchActiveLayer({ drawLock: this.checked }); });
    $('#lockMoveChk').addEventListener('change', function () { patchActiveLayer({ moveLock: this.checked }); });

    // ★ 2.0.9「指定为选区样本」（SAI2 那颗圆点）：整份文档只认一层 ——
    //   客户端只管说「这一层要当样本」，互斥由服务端拍板（selSample 是文档级的状态，
    //   各端各清一遍会打架）。取消勾选是不可能的：要换就换到别的图层上点。
    //   注意挂的是 **click** 而不是 change：这颗圆点在「当前图层已经是样本层」时本来就是
    //   勾上的，这时候再点它 change 不会触发 —— 换层之后想重新指定就会「点了没反应」。
    (function () {
      var el = $('#selSampleChk');
      if (!el) return;
      el.addEventListener('click', function () {
        if (!this.checked) return;
        if (selKind() === 'group') { this.checked = false; toast('选区样本只能指定单个图层', 'err', 2400); return; }
        var l = engine.activeLayer();
        if (!l) { this.checked = false; return; }
        if (l.selSample) return;                  // 已经是这一层了，不用再发一遍
        patchActiveLayer({ selSample: true });
        toast('已把「' + l.name + '」指定为选区样本');
      });
    })();

    /* ---- ★ 2.0.9 魔棒选项（照 SAI2 的魔棒面板） ---- */
    function wandSet(key, value) {
      S.wand[key] = value;
      saveWandOpts();
      syncWandUI();
    }
    [['#wandModeWrap', 'wrap'], ['#wandModeDiff', 'diff'], ['#wandModeAll', 'diffAll']].forEach(function (r) {
      var el = $(r[0]);
      if (el) el.addEventListener('change', function () { if (this.checked) wandSet('mode', r[1]); });
    });
    [['#wandSrcLayer', 'layer'], ['#wandSrcSample', 'sample'], ['#wandSrcMerge', 'merged']].forEach(function (r) {
      var el = $(r[0]);
      if (el) el.addEventListener('change', function () { if (this.checked) wandSet('source', r[1]); });
    });
    (function () {
      var el = $('#wandTolRange');
      if (!el) return;
      el.addEventListener('input', function () {
        S.wand.transTol = clamp(Math.round(Number(this.value) || 0), 0, 255);
        $('#wandTolVal').textContent = S.wand.transTol;
        saveWandOpts();
      });
    })();
    (function () {
      var el = $('#wandBleedRange');
      if (!el) return;
      el.addEventListener('input', function () {
        S.wand.bleed = clamp(Math.round(Number(this.value) || 0), 0, 20);
        $('#wandBleedVal').textContent = S.wand.bleed + ' px';
        saveWandOpts();
      });
    })();
    (function () {
      var el = $('#wandAAChk');
      if (el) el.addEventListener('change', function () { wandSet('aa', !!this.checked); });
    })();
    (function () {
      var el = $('#wandIgnoreChk');
      if (el) el.addEventListener('change', function () { wandSet('ignore', !!this.checked); });
    })();

    /* ---- 图层蒙版 ----
     * 蒙版用 alpha 表示「该处显示多少」，画的时候**黑遮白露**（跟 Photoshop 一样）。
     * 在蒙版上涂抹走的是普通笔迹通道（笔迹带 target='mask'），所以
     * 同步 / 撤销 / 回放全是现成的，不用另造一套。
     */
    S.maskEdit = null;

    // ★ v2.0.10：「创建剪贴蒙版」回到锁定行下面那一行**勾选**（照 SAI2 的版面）——
    //   以前它混在下面那排图标按钮里，和「新建图层」并排，容易误点
    $('#clipChk').addEventListener('change', function () {
      if (selKind() === 'group') {
        toast('剪贴只对单个图层有效，先在组里选一层', 'err', 2400);
        this.checked = false;
        return;
      }
      var l = engine.activeLayer();
      if (!l) { this.checked = false; return; }
      patchActiveLayer({ clip: !!this.checked });
    });

    $('#btnMaskAdd').addEventListener('click', function () {
      var l = engine.activeLayer();
      if (!l || l.hasMask) return;
      net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { hasMask: true } });
      // 本地立刻建出来：服务端只记「有 / 没有」这个标记，像素是本地建的，
      // 不等回包才建否则点完要过一会儿才能画
      l.hasMask = true;
      engine.ensureMask(l);
      engine.baseDirty = true; engine.baseKey = ''; engine.invalidate();
      syncLayerHead();
      setMaskEdit(l.id);
    });

    $('#btnMaskEdit').addEventListener('click', function () {
      var l = engine.activeLayer();
      if (!l || !l.hasMask) return;
      setMaskEdit(S.maskEdit === l.id ? null : l.id);
    });

    $('#btnMaskDel').addEventListener('click', function () {
      var l = engine.activeLayer();
      if (!l || !l.hasMask) return;
      net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { hasMask: false } });
      engine.dropMask(l);
      if (S.maskEdit === l.id) S.maskEdit = null;
      // 涂这张蒙版的那几笔已随蒙版一起清掉，撤销栈里指向它们的条目也要清
      pruneUndo();
      syncLayerHead();
      renderHistory();
      toast('已丢掉这张蒙版（图层像素没动）');
    });

    /* ---- 表情包 ---- */

    bindStickers();

    $('#hexInput').addEventListener('change', function () {
      var v = this.value.trim();
      if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
        if (v[0] !== '#') v = '#' + v;
        setColor(v.length === 4 ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v);
        drawWheel();
      } else { this.value = S.color.toUpperCase(); }
    });
    $('#colorInput').addEventListener('input', function () {
      setColor(this.value);
    });
    $('#btnSwap').addEventListener('click', swapColors);
    var bgIn = $('#bgColorInput');
    if (bgIn) bgIn.addEventListener('input', function () { setBgColor(this.value); });
    var rc = $('#btnRecentClear');
    if (rc) rc.addEventListener('click', function () {
      if (!S.recent.length) return;
      S.recent = [];
      lsSet(RECENT_KEY, '[]');
      renderRecent();
      toast('已清空「最近使用」');
    });

    // 点进十六进制框就全选，直接覆盖输入最省事
    $('#hexInput').addEventListener('focus', function () { this.select(); });

    // 色板：加入当前色 / 恢复默认内置色板
    var addSw = $('#btnSwatchAdd');
    if (addSw) addSw.addEventListener('click', addCurrentSwatch);
    var resetSw = $('#btnSwatchReset');
    if (resetSw) resetSw.addEventListener('click', function () {
      if (!(S.customSwatches || []).length) { toast('色板里还没有你加的色'); return; }
      saveCustomSwatches([]);
      buildPalette();
      toast('色板已恢复为内置的 ' + (global.CanvasEngine.SWATCHES.length) + ' 个颜色');
    });

    // 工具栏和笔刷栏各有一个「编辑」按钮，但共用同一个编辑状态 —— 点哪个都是两栏一起进编辑
    function toggleToolEdit(btn) {
      S.toolEdit = !S.toolEdit;
      $$('#btnToolEdit, #btnBrushEdit').forEach(function (b) { b.classList.toggle('active', S.toolEdit); });
      renderToolGrid();
      toast(S.toolEdit ? '编辑中：直接拖动调顺序，✕ 收起，右键改快捷键' : '已退出编辑');
      void btn;
    }
    $('#btnToolEdit').addEventListener('click', function () { toggleToolEdit(this); });
    $('#btnBrushEdit').addEventListener('click', function () { toggleToolEdit(this); });
    $('#btnToolReset').addEventListener('click', resetToolPrefs);

    // 右键格子的小弹窗：改快捷键 / 清除 / 删除
    var icm = $('#itemCtxMenu');
    if (icm) {
      $('#icmKey').addEventListener('click', function () {
        if (!ctxItem) return;
        ctxCapturing = true;
        refreshIcmKey();
      });
      $('#icmClear').addEventListener('click', function () {
        if (!ctxItem) return;
        ITEM_KEYS[ctxItem.id] = '';
        saveKeymap();
        refreshIcmKey();   // 弹窗留着，方便接着设别的
        toast('「' + ctxItem.name + '」已无快捷键');
      });
      $('#icmDel').addEventListener('click', function () {
        if (!ctxItem) return;
        var it = ctxItem;
        closeItemCtx();
        if (it.imported) {
          if (confirm('删除导入的笔刷「' + it.name + '」？')) removeImported(it.id);
        } else {
          hideItem(it.id);  // 内置笔刷收进「已收起」池，编辑模式里能放回来
        }
      });
      // 点弹窗外面就关（右键格子时 e.preventDefault 已经挡住了默认菜单）
      document.addEventListener('pointerdown', function (e) {
        if (ctxItem && !icm.contains(e.target)) closeItemCtx();
      });
      icm.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    // 笔刷导入（PS .abr / CSP .sut）
    $('#btnBrushImport').addEventListener('click', function (e) { e.stopPropagation(); openBrushImport(); });
    $('#brushFileInput').addEventListener('change', function () { handleBrushFiles(this.files); });
    $('#btnImportCancelX').addEventListener('click', function () { $('#importMask').classList.add('hidden'); });

    // 网格变换开关 + 密度
    $('#tpMesh').addEventListener('change', function () {
      if (!engine.transform) return;
      engine.transform.setMesh(this.checked, Number($('#tpMeshN').value));
      engine.drawOverlay();
      toast(this.checked ? '网格变换：开（拖控制点做局部变形，Alt 带动周围）' : '网格变换：关');
    });
    // 色调调整
    ['#toneBright', '#toneContrast', '#toneHue', '#toneSat'].forEach(function (id) {
      $(id).addEventListener('input', function () { toneSyncLabels(); updateTonePreview(); });
    });
    $('#btnToneReset').addEventListener('click', function () {
      ['#toneBright', '#toneContrast', '#toneHue', '#toneSat'].forEach(function (id) { $(id).value = 0; });
      toneSyncLabels(); updateTonePreview();
    });
    $('#btnToneOk').addEventListener('click', function () { closeToneDialog(true); });

    // 文字
    buildTextFamilies();
    $('#btnTextOk').addEventListener('click', commitText);
    $('#btnTextCancel').addEventListener('click', function () { $('#textMask').classList.add('hidden'); });
    $('#btnTextZero').addEventListener('click', function () { $('#textMask').classList.add('hidden'); });

    // 色阶
    ['#lvInBlack', '#lvInWhite', '#lvGamma', '#lvOutBlack', '#lvOutWhite'].forEach(function (id) {
      $(id).addEventListener('input', function () { levelsSyncLabels(); updateTonePreview(); });
    });
    $('#btnLevelsAuto').addEventListener('click', levelsAuto);
    $('#btnLevelsReset').addEventListener('click', function () {
      $('#lvInBlack').value = 0; $('#lvInWhite').value = 255; $('#lvGamma').value = 100;
      $('#lvOutBlack').value = 0; $('#lvOutWhite').value = 255;
      levelsSyncLabels(); updateTonePreview();
    });
    $('#btnLevelsOk').addEventListener('click', function () { closeLevelsDialog(true); });
    $('#btnLevelsCancel').addEventListener('click', function () { closeLevelsDialog(false); });
    $('#btnLevelsZero').addEventListener('click', function () { closeLevelsDialog(false); });

    // 高斯模糊
    $('#blurRadius').addEventListener('input', function () {
      $('#blurRadiusVal').textContent = Number(this.value).toFixed(1);
      updateTonePreview();
    });
    $('#btnBlurReset').addEventListener('click', function () {
      $('#blurRadius').value = 6; $('#blurRadiusVal').textContent = '6.0'; updateTonePreview();
    });
    $('#btnBlurOk').addEventListener('click', function () { closeBlurDialog(true); });
    $('#btnBlurCancel').addEventListener('click', function () { closeBlurDialog(false); });
    $('#btnBlurZero').addEventListener('click', function () { closeBlurDialog(false); });

    // 画布大小
    bindCanvasSizeDialog();

    // 导出
    $('#exportFormat').addEventListener('change', syncExportNote);
    $('#exportQuality').addEventListener('input', function () { $('#exportQualityVal').textContent = this.value; });
    $('#btnExportOk').addEventListener('click', function () { $('#exportMask').classList.add('hidden'); exportAs(); });
    $('#btnExportCancel').addEventListener('click', function () { $('#exportMask').classList.add('hidden'); });
    $('#btnExportZero').addEventListener('click', function () { $('#exportMask').classList.add('hidden'); });
    $('#btnToneCancel').addEventListener('click', function () { closeToneDialog(false); });
    $('#btnToneZero').addEventListener('click', function () { closeToneDialog(false); });

    $('#tpMeshN').addEventListener('change', function () {
      if (engine.transform && $('#tpMesh').checked) {
        engine.transform.setMesh(true, Number(this.value));
        engine.drawOverlay();
      }
    });

    // 菜单栏 + 快捷键设置
    if (global.ChaMenu) {
      global.ChaMenu.buildMenuBar();
      $('#btnKeyClose').addEventListener('click', function () { $('#keyMask').classList.add('hidden'); });
      $('#btnKeyOk').addEventListener('click', function () { $('#keyMask').classList.add('hidden'); });
      $('#btnKeyReset').addEventListener('click', function () {
        global.ChaMenu.resetKeys();
        global.ChaMenu.buildMenuBar();
        global.ChaMenu.openKeyDialog();
        toast('快捷键已全部恢复默认', 'ok');
      });
    }

    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
        $$('.tab-body').forEach(function (b) { b.classList.toggle('hidden', b.dataset.body !== t.dataset.tab); });
      });
    });

    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);

    $('#btnRooms').addEventListener('click', function () { openEntry(true); });
    $('#btnOpenEntry').addEventListener('click', function () { openEntry(true); });
    $('#btnEntryClose').addEventListener('click', function () { $('#entryMask').classList.add('hidden'); });
    wireJoinLink();
    $('#btnInfoClose').addEventListener('click', function () { $('#infoMask').classList.add('hidden'); });
    $('#btnRefreshRooms').addEventListener('click', function () {
      applyServer($('#serverInput').value);
      setTimeout(function () { net.send(P.C2S.ROOM_LIST, {}); }, 350);
    });
    $('#btnCopyLan').addEventListener('click', copyLan);
    var btnSrv = $('#btnServerToggle');
    if (btnSrv) btnSrv.addEventListener('click', serverButtonAction);
    var btnTun = $('#btnTunnelToggle');
    if (btnTun) btnTun.addEventListener('click', toggleTunnelAction);
    renderTunnelToggle();   // 初始整行按「网页版 / 桌面端」收起或亮出
    var btnAva = $('#btnPickAvatar');
    if (btnAva) btnAva.addEventListener('click', pickAvatar);
    var btnAvaClr = $('#btnClearAvatar');
    if (btnAvaClr) btnAvaClr.addEventListener('click', function () { setMyAvatar(''); });
    bindAvaCrop();
    $('#btnPurgeRooms').addEventListener('click', purgeRooms);
    $('#serverInput').addEventListener('change', function () { applyServer(this.value); this.value = net.url; });
    $('#btnCreateRoom').addEventListener('click', doCreate);

    /* ---- 工程文件 ---- */
    var btnProjEntry = $('#btnOpenProjectEntry');
    if (btnProjEntry) btnProjEntry.addEventListener('click', pickProjectFile);
    var btnDraftRestore = $('#btnDraftRestore');
    if (btnDraftRestore) btnDraftRestore.addEventListener('click', restoreDraft);
    var btnDraftDrop = $('#btnDraftDrop');
    if (btnDraftDrop) btnDraftDrop.addEventListener('click', dropDraft);
    var projInput = $('#projectFileInput');
    if (projInput) {
      projInput.addEventListener('change', function () {
        var f = projInput.files && projInput.files[0];
        projInput.value = '';
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { loadProjectText(String(fr.result || ''), f.name); };
        fr.onerror = function () { toast('这个文件读不出来', 'err'); };
        fr.readAsText(f);
      });
    }
    // PSD 要按**字节**读（二进制），不能 readAsText —— 一旦当了文本，解回来的字节就已经不是原来那些了
    var psdInput = $('#psdFileInput');
    if (psdInput) {
      psdInput.addEventListener('change', function () {
        var f = psdInput.files && psdInput.files[0];
        psdInput.value = '';
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { importPsdBytes(new Uint8Array(fr.result || []), f.name); };
        fr.onerror = function () { toast('这个文件读不出来', 'err'); };
        fr.readAsArrayBuffer(f);
      });
    }
    // 关页面 / 刷新：同步记一笔「干净退出」，下次启动才知道要不要提示恢复草稿
    global.addEventListener('beforeunload', markCleanExit);
    global.addEventListener('pagehide', markCleanExit);
    setInterval(autosaveTick, AUTOSAVE_MS);

    $('#roomChip').addEventListener('click', function () {
      if (S.room) showInfo();
      else openEntry(true);
    });

    $('#btnExport').addEventListener('click', doExport);
    $('#btnShare').addEventListener('click', doShare);
    $('#btnBake').addEventListener('click', bake);
    $('#btnCanvas').addEventListener('click', openCanvasDialog);

    /* ---- 你画我猜 ---- */
    $('#btnGame').addEventListener('click', openGameDialog);
    $('#btnGameClose').addEventListener('click', function () { $('#gameMask').classList.add('hidden'); });
    $('#btnGameCancel').addEventListener('click', function () { $('#gameMask').classList.add('hidden'); });
    $('#btnGameStart').addEventListener('click', startGame);
    // 「结束游戏」：经典 / 接龙 / 画皮共用一个按钮（以前接龙和画皮各自在第二层
    // 面板里有一份 #btnChainStop / #btnSkinStop，随面板一起删了），
    // 游戏进行中另外还有 HUD 上那颗 #ghStop 能点。
    $('#btnGameStop').addEventListener('click', function () { askStopGame(); });
    $('#ghStop').addEventListener('click', function () { askStopGame(); });
    $('#ghScore').addEventListener('click', toggleScore);
    $('#gsClose').addEventListener('click', toggleScore);

    /* ---- 音效开关 ---- */
    $('#ghSound').addEventListener('click', function () {
      var on = SFX.toggle();
      renderSoundBtn();
      if (on) SFX.play('toggle');
    });
    // 音量：拖动即生效，松手时响一声让你知道现在多大声
    var volEl = $('#ghVol');
    if (volEl) {
      volEl.value = String(Math.round((SFX.getVolume ? SFX.getVolume() : 0.22) * 100));
      volEl.addEventListener('input', function () {
        SFX.setVolume(Number(this.value) / 100);
        renderSoundBtn();
      });
      volEl.addEventListener('change', function () { SFX.play('toggle'); });
    }
    renderSoundBtn();
    $('#btnRepick').addEventListener('click', function () {
      if (this.disabled) return;
      net.send(P.C2S.GAME_REPICK, {});
    });
    $('#btnOverClose').addEventListener('click', closeOver);
    $('#btnOverStop').addEventListener('click', function () { stopGame(); });
    $('#btnOverAgain').addEventListener('click', function () {
      closeOver();
      // 用和「开始」同一份参数 —— 只发 { rounds } 会把主题丢掉（见 classicStartPayload）
      net.send(P.C2S.GAME_START, classicStartPayload());
    });

    /* ---- 玩法切换（你画我猜 / 接龙 / 画皮）：只换下面那几行参数，不再弹第二层 ---- */
    $('#gmClassic').addEventListener('click', function () { setGameDialogMode('classic'); });
    $('#gmChain').addEventListener('click', function () { setGameDialogMode('chain'); });
    $('#gmSkin').addEventListener('click', function () { setGameDialogMode('skin'); });

    /* ---- 画皮：交稿 ---- */
    $('#sdbSubmit').addEventListener('click', submitSkinArt);

    /* ---- 画皮：身份卡折叠 ---- */
    $('#srCollapse').addEventListener('click', function () {
      var box = $('#skinRole');
      box.classList.toggle('collapsed');
      this.textContent = box.classList.contains('collapsed') ? '▸' : '–';
    });

    /* ---- 画皮：弃票 ---- */
    $('#sgVoteSkip').addEventListener('click', function () {
      sendSkinAction('vote', '');   // 空目标 = 撤票
    });

    /* ---- 画皮：结算面板 ---- */
    $('#btnSkinOverClose').addEventListener('click', function () { $('#skinOverMask').classList.add('hidden'); });
    $('#btnSkinOverStop').addEventListener('click', function () { stopGame(); closeSkinUi(); });
    $('#btnSkinOverAgain').addEventListener('click', function () {
      $('#skinOverMask').classList.add('hidden');
      openSkinDialog();
    });

    /* ---- 主题词库：现在只有 #gameTheme 一个下拉（三种玩法共用同一份选择） ---- */
    // 所有设置控件（含主题）改动都走 onSetupControlChange：它顺手给房主广播一次预设
    SETUP_CONTROL_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', onSetupControlChange);
    });
    $('#btnGameThemeManage').addEventListener('click', openThemeManager);

    /* ---- 房间密码框 ---- */
    $('#btnPassOk').addEventListener('click', submitRoomPassword);
    $('#btnPassCancel').addEventListener('click', closeRoomPassword);
    $('#passInput').addEventListener('keydown', function (e) {
      e.stopPropagation();                        // 别让画布快捷键（1-9 切笔等）抢走输入
      if (e.key === 'Enter') { e.preventDefault(); submitRoomPassword(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeRoomPassword(); }
    });

    /* ---- 自定义词库管理面板 ---- */
    $('#btnThemeClose').addEventListener('click', closeThemeManager);
    $('#btnThemeDone').addEventListener('click', closeThemeManager);
    $('#btnThemeNew').addEventListener('click', function () {
      TM.editing = null;
      fillThemeForm(null, '');
      renderThemeList();
      SFX.play('tap');
      var n = $('#tmName'); if (n) n.focus();
    });
    $('#btnThemeSave').addEventListener('click', saveTheme);
    $('#btnThemeDelete').addEventListener('click', deleteTheme);
    $('#tmWords').addEventListener('input', updateThemeStats);
    $('#tmWords').addEventListener('change', updateThemeStats);
    /* ---- 接龙题面面板 ---- */
    $('#ctCollapse').addEventListener('click', function () {
      var box = $('#chainTask');
      box.classList.toggle('collapsed');
      this.textContent = box.classList.contains('collapsed') ? '▸' : '▾';
    });

    /* ---- 接龙猜词输入 ---- */
    $('#ciSubmit').addEventListener('click', doChainGuessSubmit);
    $('#ciInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doChainGuessSubmit(); }
    });
    $('#ciInput').addEventListener('input', updateChainInputPreview);

    /* ---- 接龙大厅：准备 / 取消准备（全员就绪自动开局） ---- */
    $('#btnChainReady').addEventListener('click', function () {
      net.send(P.C2S.GAME_READY, { ready: !(S.game && S.game.myReady) });
      SFX.play('tap');
    });

    /* ---- 回放 + 投票 ----
     * 画面在主画布上（#chainCanvasLayer），操作在贴底的 #chainReplayBar 里。
     * 跨链由服务端说了算（voteChainId）—— 所以没有「上一条 / 下一条链」的按钮。
     * ★ v14：**全场看同一份服务端推进的回放** —— 播放 / 暂停 / 前后翻格 / 倍速
     *   这四颗控件连同 handler 一起删掉了（棒次跟服务端的 revealStep 走，
     *   快慢由开局面板上的「回放倍速」在服务端侧决定）。
     */
    $('#rpFold').addEventListener('click', function () {
      var bar = $('#chainReplayBar');
      if (!bar) return;
      var folded = bar.classList.toggle('folded');
      this.textContent = folded ? '▸' : '▾';
      this.title = folded ? '展开控制条' : '收起控制条（画面会变大）';
      syncChainCanvasPad();
    });
    $('#rpVoteBad').addEventListener('click', function () { voteKeep(false); });
    $('#rpVoteOk').addEventListener('click', function () { voteKeep(true); });
    $('#rpFavBtn').addEventListener('click', favCurrentItem);
    $('#btnRpNext').addEventListener('click', function () { net.send(P.C2S.GAME_NEXT, {}); });
    // ★ v14：格点（#rpPills）只当**进度指示**（服务端放到第几格），点它不再跳格 ——
    //   回放不许手动干预，所以这里没有 click handler。
    // ★ v14：键盘左右翻格也一并删掉（回放不许手动干预，棒次由服务端推）

    /* ---- 奖杯结算 ---- */
    // 「点赞最多的画」横条上那颗按钮：点了立刻进奖杯榜（不用等自动那一下）
    $('#favToTrophy').addEventListener('click', favToTrophy);
    $('#btnTrophyClose').addEventListener('click', closeTrophy);
    $('#btnTrophyStop').addEventListener('click', function () { endChainGame(); });
    $('#btnTrophyAgain').addEventListener('click', function () {
      closeTrophy();
      net.send(P.C2S.GAME_START, chainStartPayload());
    });

    /* ---- 顶栏「立刻推进」（接龙里房主用来跳过没交的人 / 提前结算投票） ---- */
    $('#ghNext').addEventListener('click', function () { net.send(P.C2S.GAME_NEXT, {}); });

    $('#btnRecord').addEventListener('click', toggleRecord);
    $('#btnReplay').addEventListener('click', function () {
      if (engine.replayMode) stopReplay(); else startReplay();
    });
    $('#btnReplayExit').addEventListener('click', stopReplay);
    $('#btnReplayToggle').addEventListener('click', function () {
      var dur = engine.replayDuration();
      if (S.replay.t >= dur) { S.replay.t = 0; engine.replaySeek(0); }
      S.replay.playing = !S.replay.playing;
      this.textContent = S.replay.playing ? '暂停' : '继续';
      S.replay.last = performance.now();
      if (S.replay.playing) loopReplay();
    });
    $('#replayRange').addEventListener('input', function () {
      var dur = engine.replayDuration();
      S.replay.t = Number(this.value) / 1000 * dur;
      engine.replaySeek(S.replay.t);
      $('#replayTime').textContent = fmtClock(S.replay.t) + ' / ' + fmtClock(dur);
      updateReplayAuthor();
    });
    $('#replaySpeed').addEventListener('change', function () { S.replay.speed = Number(this.value); });
    // 洋葱皮：前后各几笔染成残影（纯本机显示）。按钮开着的时候才显示「前后几笔」选择
    $('#btnReplayOnion').addEventListener('click', toggleOnion);
    $('#onionCount').addEventListener('change', function () { setOnionCount(this.value); });
    // 导出回放视频：录制中再点一次 = 提前收工（已经录到的部分照样存下来）
    $('#btnReplayExport').addEventListener('click', function () {
      if (S.recording && S.recording.kind === 'replay') { S.recording.rec.stop(); return; }
      exportReplayVideo();
    });

    $('#btnZoomIn').addEventListener('click', function () { engine.setZoom(engine.scale * 1.25); });
    $('#btnZoomOut').addEventListener('click', function () { engine.setZoom(engine.scale / 1.25); });
    $('#btnZoomFit').addEventListener('click', function () { engine.fitView(); });
    $('#btnZoom100').addEventListener('click', function () { engine.setZoom(1); });

    $('#btnAddLayer').addEventListener('click', function () {
      if (!S.joined) { toast('还没有进入房间'); return; }
      net.send(P.C2S.LAYER_ADD, { name: '图层 ' + (engine.layers.length + 1) });
    });
    $('#layerBlend').addEventListener('change', function () { patchActiveLayer({ blend: this.value }); });
    $('#layerOpacity').addEventListener('input', function () {
      $('#layerOpacityVal').textContent = this.value;
      patchActiveLayer({ opacity: Number(this.value) / 100 });
    });
    $('#alphaLockChk').addEventListener('change', function () { patchActiveLayer({ alphaLock: this.checked }); });
    $('#btnLayerDup').addEventListener('click', layerDup);
    $('#btnLayerMerge').addEventListener('click', layerMerge);
    $('#btnLayerDrop').addEventListener('click', layerMoveContentDown);
    $('#btnLayerClear').addEventListener('click', layerClear);
    $('#btnLayerDel').addEventListener('click', layerDel);
    $('#btnLayerFlatten').addEventListener('click', layerFlatten);
    $('#btnGroupAdd').addEventListener('click', groupAdd);
    $('#btnGroupToggle').addEventListener('click', groupToggle);

    $('#btnSend').addEventListener('click', sendChat);
    $('#chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
      e.stopPropagation();
    });
    $('#chatInput').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(90, this.scrollHeight) + 'px';
    });

    engine.on('layers', function () { renderLayers(); });
    engine.on('thumbs', function () { renderLayers(); });
    engine.on('viewport', function () {
      syncViewBar();
      repositionCursors();
      drawNavRect();
    });
    engine.on('strokeEnd', function () { renderLayers(); renderHistory(); navTick(); });
    engine.on('strokesRemoved', function () { renderLayers(); renderHistory(); navTick(); });
    engine.on('composed', function () { navTick(); });
    engine.on('transformError', function (e) {
      if (e && e.message) toast(e.message, 'err');
      endTransformUi();
    });
    // 引擎侧自己中止变换时（清选区 / 服务端回显清空图层触发的自愈），
    // 面板和按钮状态也要跟着收起来 —— endTransformUi 是幂等的，重复调无害。
    engine.on('transform', function (e) {
      if (e && e.active === false) {
        if (S.transformDragging) S.transformDragging = false;
        endTransformUi();
      }
    });
    engine.on('selection', function (e) {
      var hint = $('#selHint');
      var on = !!(e && e.active);
      if (hint) {
        hint.classList.toggle('hidden', !on);
        hint.textContent = on ? '有选区 · 点此取消' : '';
        hint.title = '有选区时只能在选区内绘制。点一下取消选区（Ctrl+D）';
        hint.style.cursor = on ? 'pointer' : '';
      }
      var tools = $$('#toolGrid .tool[data-item="select"], #toolGrid .tool[data-item="selectErase"]');
      tools.forEach(function (b) { b.classList.toggle('has-sel', on); });
      // 蚂蚁线动画只在有选区时跑
      engine.selectionAnimate(on);
      if (on) setStatus('已建立选区 · 画笔只会在选区内生效（Ctrl+D 取消）');
    });
  }

  function navTick() {
    if (!S.navOpen) return;
    var now = performance.now();
    if (now - S.navThumbAt > 700) {
      S.navThumbAt = now;
      refreshNav();
    } else {
      drawNavRect();
    }
  }

  function sendChat() {
    var el = $('#chatInput');
    var text = el.value.trim();
    if (!text) return;
    net.send(P.C2S.CHAT, { text: text });
    el.value = '';
    el.style.height = 'auto';
  }

  /* ============================================================ 你画我猜 */

  /**
   * 重新对一次「我是不是房主」。
   * 房主不是终身制：原房主退房时服务端会把房主交给另一个人（否则「结束游戏」这类
   * 仅房主的操作就永久锁死了），这里跟着更新，顺带提示本人一声。
   */
  function refreshMyRole() {
    var mine = S.members.filter(function (m) { return m.userId === S.me.userId; })[0];
    var was = !!S.me.isOwner;
    S.me.isOwner = !!(mine && mine.isOwner);
    if (S.joined && S.me.isOwner && !was) toast('你现在是房主了', 'ok', 3200);

    // 房主可能在成员列表里把我设成「只读观众」、也可能又放开 —— 跟着变。
    // 一定得当面说一声：不说的话，人只会觉得「我的笔怎么画不出来了」。
    var wasRO = !!S.me.readonly;
    S.me.readonly = !!(mine && mine.readonly);
    if (S.joined && S.me.readonly !== wasRO) {
      if (S.me.readonly) toast('房主把你设成了观众：能看、能聊，不能改画布', 'err', 4200);
      else toast('房主放开了作画权限，可以画了', 'ok', 3200);
    }

    renderMeRole();
    renderGameLockTip();
    updateGameDialog();
    renderGameHud();
  }

  var PHASE_TEXT = {
    off: '自由绘画', lobby: '等待开始', pick: '选词中',
    draw: '作画中', round_end: '回合结束', over: '本局结束'
  };

  function gameActive() { return !!(S.game && S.game.phase && S.game.phase !== 'off'); }

  /**
   * 我现在能不能改画布？
   * 注意这只是「别让交互误导人」——真正的权限在服务端（非画手的笔迹根本不会被广播）。
   */
  function gameLocked() { return !!(S.game && S.game.locked && S.joined); }

  /** 我是「只读观众」吗？（房主设的；真正的权限在服务端） */
  function readonlyMe() { return !!(S.joined && S.me.readonly); }

  /**
   * 现在改不了画布的话，返回该对用户说的那句话；能改就返回 ''。
   *
   * 「你是观众」和「这一回合不是画手」必须分开说 —— 提示语对不上，
   * 用户会对着画布一直试，找不到真正的原因。
   */
  function canvasBlockMsg() {
    if (readonlyMe()) return '你现在是观众，只能看着 —— 想画请让房主取消';
    if (gameLocked()) return '这一回合只有画手能画';
    return '';
  }

  /** 顶栏那个「观众」小标签 */
  function renderMeRole() {
    var el = $('#meRole');
    if (el) el.classList.toggle('hidden', !readonlyMe());
  }

  /** 房主给某人设 / 取消「只读观众」——发出去就完事，以服务端回来的 MEMBERS 为准 */
  function setReadonly(userId, readonly) {
    if (!S.joined || !userId) return;
    if (!S.me.isOwner) { toast('只有房主可以设观众', 'err'); return; }
    net.send(P.C2S.MEMBER_ROLE, { userId: userId, readonly: !!readonly });
  }

  /**
   * 房主转让：把房主身份转给某人。二次确认后发 HOST_TRANSFER，
   * 之后的界面状态全靠服务端广播的 MEMBERS 回来刷（和自动移交一条路）。
   */
  async function transferHost(userId, name) {
    if (!S.joined || !userId) return;
    if (!S.me.isOwner) { toast('只有房主可以转让房主', 'err'); return; }
    if (!await confirmDialog(
      '把房主转给 ' + (name || 'TA') + '？转让后你将变回普通成员，\n' +
      '观众管理 / 清空画布 / 解散房间 / 开局等房主操作都会交给 TA。', { danger: false })) return;
    net.send(P.C2S.HOST_TRANSFER, { userId: userId });
  }

  function gameImDrawer() { return !!(S.game && S.game.isDrawer); }

  function gameGuessedMe() {
    if (!S.game || !S.game.guessed) return false;
    return S.game.guessed.some(function (x) { return x.userId === S.me.userId; });
  }

  function applyGameState(g) {
    var prev = S.game;
    var prevPhase = prev ? prev.phase : 'off';
    var prevRound = prev ? prev.round : -1;
    if (g) S.gameSkew = (g.serverNow || Date.now()) - Date.now();
    S.game = g || null;
    var phase = S.game ? S.game.phase : 'off';
    // 阶段一变，「别人的光标该不该藏」的答案就跟着变（自己当画手 / 接龙作画步）
    syncCursorVisibility();

    renderGameHud();
    renderGameScore();
    renderGameLockTip();
    syncChatUi();
    updateGameDialog();
    updateRepickUi();

    // 局中进来的旁听者：明确说一句，别让人以为画布坏了
    if (S.game && S.game.spectating && !(prev && prev.spectating)) {
      toast(S.game.mode === 'chain'
        ? '本局接龙进行中 —— 你先观战，房主开下一局就能一起玩'
        : '本回合你在旁听 —— 下一回合一起玩', 'warn', 4200);
    }

    /* 接龙走另一套 UI（题面面板 / 回放投票 / 奖杯）。
     * 两套互斥：服务端一次只挂一种玩法，所以这里按 mode 分派，不会同时出现。 */
    if (S.game && S.game.mode === 'chain') {
      closePick();
      hideRoundCard();
      closeOver();
      closeSkinUi();
      applyChainState(S.game, prevPhase);
      return;
    }

    /* 画皮同理，第三套 UI：身份卡 / 匿名画廊 / 夜里的动作面板。 */
    if (S.game && S.game.mode === 'skin') {
      closePick();
      hideRoundCard();
      closeOver();
      closeChainUi();
      applySkinState(S.game, prevPhase);
      return;
    }
    // 从接龙 / 画皮切回自由绘画 / 经典：把它们的浮层收干净
    if (!S.game || S.game.mode !== 'chain') {
      if (prev && prev.mode === 'chain') closeChainUi();
      else {
        var tsk = $('#chainTask'); if (tsk) tsk.classList.add('hidden');
        var cp = $('#chainProgress'); if (cp) cp.classList.add('hidden');
      }
    }
    if (!S.game || S.game.mode !== 'skin') {
      if (prev && prev.mode === 'skin') closeSkinUi();
      else closeSkinUi();
    }

    // 选词弹窗：只有画手会拿到 choices，所以其他端天然打不开
    if (phase === 'pick' && gameImDrawer()) openPick(S.game.choices || []);
    else closePick();

    // 回合结算卡片只在「刚进入 round_end」时弹一次
    if (phase === 'round_end' && prevPhase !== 'round_end' && S.game.roundResult) {
      showRoundCard(S.game.roundResult);
    }
    if (phase !== 'round_end') hideRoundCard();

    if (phase === 'over' && prevPhase !== 'over') openOver(S.game.scores || []);
    if (phase !== 'over') closeOver();

    // 阶段变化时的提示
    if (phase !== prevPhase || (S.game && S.game.round !== prevRound)) {
      if (phase === 'lobby' && prevPhase === 'off') toast('已进入游戏模式，够 ' + S.game.minPlayers + ' 人就可以开局', 'ok', 3000);
      if (phase === 'pick') toast(gameImDrawer() ? '轮到你当画手，先选一个词' : gameName(S.game.drawerName) + ' 正在选词…', 'ok', 2600);
      if (phase === 'draw') {
        toast(gameImDrawer() ? '开始画吧！' : gameName(S.game.drawerName) + ' 开始作画，快猜', 'ok', 2600);
      }
      if (phase === 'off' && prevPhase !== 'off') toast('游戏结束，回到自由绘画', 'ok', 2600);

      // ---- 音效：经典模式的阶段变化 ----
      // 顺序讲究：开局的「开场音」要压过下面那些通用音，否则一开局连响三四声很吵
      if (prevPhase === 'off' && phase === 'lobby') SFX.play('gameStart');
      else if (phase === 'off' && prevPhase !== 'off') SFX.play('gameOver');
      else if (phase === 'over' && prevPhase !== 'over') SFX.play('gameOver');
      else if (phase === 'pick' && prevPhase !== 'pick') SFX.play('stepStart');
      else if (phase === 'draw' && prevPhase !== 'draw') {
        // 「轮到你」是全游戏最该被听见的一声
        SFX.play(gameImDrawer() ? 'yourTurn' : 'stepStart');
      } else if (S.game && S.game.round !== prevRound) SFX.play('roundStart');
    }

    // 露字提示：只在提示「刚出现 / 换了位」时响一声。
    // 状态快照 500ms 来一次，每次响的话会变成机关枪。
    if (phase === 'draw' && S.game.hint) {
      var hk = S.game.round + ':' + S.game.hint.index + ':' + S.game.hint.char;
      if (S.hintKey !== hk) { S.hintKey = hk; SFX.play('hint'); }
    }

    // 画手的词：只在「本回合第一次拿到」时提示，避免每次状态同步都弹一次
    if (phase === 'draw' && gameImDrawer() && S.game.word) {
      var key = S.game.round + ':' + S.game.word;
      if (S.gameWordShown !== key) {
        S.gameWordShown = key;
        toast('你要画的是「' + S.game.word + '」', 'ok', 4500);
      }
    }
  }

  function gameName(n) { return n || '某人'; }

  function renderGameHud() {
    var hud = $('#gameHud');
    if (!hud) return;
    if (!gameActive()) { hud.classList.add('hidden'); setChainStrip(); return; }
    hud.classList.remove('hidden');
    // 接龙：把 HUD 压成画布上沿的状态条（回放期间再收一次快捷条）——
    // 状态条 ↔ 画布层的留白由 syncChainCanvasPad 按实测底边算，所以这里先摆好再量。
    setChainStrip();
    var g = S.game;
    var chain = g.mode === 'chain';
    var skin = g.mode === 'skin';

    // 接龙按「手」数（每条链传几格），画皮按「轮」数，经典按「回合」数
    if (chain) {
      // ⚠ 接龙快照里没有 rounds（一局只传一条链），旧代码用 g.rounds 算出了
      //   「第 NaN/undefined 圈」。这里按快照真有的字段算：第几手 / 链长。
      var len = Math.max(1, g.chainLength || 1);
      var at = Math.min(Math.max(0, g.stepIndex | 0), len - 1);
      $('#ghRound').textContent = '第 ' + (at + 1) + ' / ' + len + ' 手'
        + (g.stepTotal ? '（' + (g.stepDone | 0) + '/' + g.stepTotal + ' 已完成）' : '');
    } else if (skin) {
      $('#ghRound').textContent = '第 ' + Math.max(1, Math.min(g.round, g.maxRounds)) + ' / ' + g.maxRounds + ' 轮';
    } else {
      $('#ghRound').textContent = '第 ' + Math.max(1, Math.min(g.round, g.rounds)) + ' / ' + g.rounds + ' 回合';
    }

    // 画皮多一段「还活着几个人」—— 这是全场最关心的数字，不该藏进面板里
    var skinState = $('#ghSkinState');
    if (skinState) {
      var showState = skin && g.players && g.players.length;
      skinState.classList.toggle('hidden', !showState);
      if (showState) {
        skinState.textContent = '在场 ' + g.aliveCount + ' 人';
      }
    }

    var wordEl = $('#ghWord');
    if (chain) {
      renderChainHudWord(wordEl, g);
    } else if (skin) {
      renderSkinHudWord(wordEl, g);
    } else if (g.phase === 'draw') {
      if (g.isDrawer) {
        wordEl.innerHTML = '你要画：<b>' + esc(g.word || '') + '</b>';
      } else {
        // 过半还没人猜出时服务端会给一个「露字」提示：把那一位从 □ 换成真字
        var hint = g.hint;
        var blanks = '';
        for (var i = 0; i < (g.wordLen || 0); i++) {
          blanks += (hint && hint.index === i) ? esc(hint.char) : '□';
        }
        wordEl.innerHTML = '答案：<b>' + blanks + '</b>（' + (g.guessed || []).length + '/' + g.guessersTotal + ' 已猜出）';
      }
    } else if (g.phase === 'pick') {
      wordEl.textContent = g.isDrawer ? '请挑一个词' : gameName(g.drawerName) + ' 正在选词…';
    } else if (g.phase === 'lobby') {
      wordEl.textContent = S.me.isOwner ? '点顶栏「游戏」开始' : '等房主开局';
    } else if (g.phase === 'round_end') {
      wordEl.textContent = '本回合结束';
    } else if (g.phase === 'over') {
      wordEl.textContent = '本局结束';
    } else {
      wordEl.textContent = '';
    }

    // 「立刻推进」：接龙 / 画皮共用，只有房主看得见。
    // 用途是「有人挂了 / 交不了，别干等」—— 写词/画/猜 跳过没交的人，投票直接结算。
    var next = $('#ghNext');
    if (next) {
      var canNext = false;
      if (chain) canNext = S.me.isOwner && (chainStepActive() || g.phase === 'chain_vote');
      else if (skin) canNext = S.me.isOwner && skinCanAdvance(g);
      next.classList.toggle('hidden', !canNext);
    }

    // 房主的「结束游戏」入口（三个玩法共用；接龙 / 画皮那套开局面板已经合并掉了，
    // 游戏进行中总得有个地方能点到它）
    var stop = $('#ghStop');
    if (stop) stop.classList.toggle('hidden', !(S.me.isOwner && gameActive()));

    updateGameTimer();
  }

  /** 画皮：房主现在能不能「立刻推进」（与 skin.js 的 next() 一一对应） */
  function skinCanAdvance(g) {
    if (!g) return false;
    return g.phase === 'skin_night' || g.phase === 'skin_dawn' ||
      g.phase === 'skin_draw' || g.phase === 'skin_talk' ||
      g.phase === 'skin_vote' || g.phase === 'skin_vote_end';
  }

  /** 画皮的 HUD 文案 */
  function renderSkinHudWord(el, g) {
    if (!el) return;
    if (g.phase === 'lobby') {
      el.textContent = S.me.isOwner ? '点「开始画皮」' : '等房主开局';
      return;
    }
    if (g.phase === 'skin_night') {
      el.textContent = '天黑请闭眼 —— 该动的人在动';
    } else if (g.phase === 'skin_dawn') {
      el.textContent = '天亮了，看看昨晚发生了什么';
    } else if (g.phase === 'skin_draw') {
      el.innerHTML = g.canDraw
        ? '本轮主题：<b>' + esc(g.word || '') + '</b>（' + g.drawDone + '/' + g.drawTotal + ' 已交）'
        : '本轮主题：<b>' + esc(g.word || '') + '</b>';
    } else if (g.phase === 'skin_talk') {
      el.textContent = '看画猜人 —— 谁在装？';
    } else if (g.phase === 'skin_vote') {
      el.textContent = '投票放逐（' + g.voteDone + '/' + g.voteTotal + ' 已投）';
    } else if (g.phase === 'skin_vote_end') {
      el.textContent = g.voteResult && g.voteResult.exiledName
        ? g.voteResult.exiledName + ' 被放逐了'
        : '投票平票 —— 无人出局';
    } else if (g.phase === 'over') {
      el.textContent = '本局结束 —— ' + (g.winnerName || '');
    } else {
      el.textContent = '';
    }
  }

  /** 接龙的 HUD 文案：这一步我在做什么 / 全场的进度（多链并行：每格每人都有一件事） */
  function renderChainHudWord(el, g) {
    if (!el) return;
    var t = S.chainTask;
    var mine = g ? (g.myStep || '') : '';
    if (g.phase === 'lobby') {
      el.textContent = g.canStart
        ? '都到齐了 —— 准备就绪开局（' + (g.readyCount || 0) + '/' + (g.players || []).length + '）'
        : '点「准备」，全员就绪自动开局';
      return;
    }
    if (g.phase === 'chain_init') {
      el.textContent = '链已排好，马上开始 —— 共 ' + (g.stepTotal || 0) + ' 条链并行';
    } else if (g.phase === 'chain_write') {
      el.textContent = mine === 'WORD' ? '给你的链写一个初始词' : '大家在写初始词…';
    } else if (g.phase === 'chain_draw') {
      el.textContent = mine === 'DRAWING'
        ? '轮到你作画：' + (t && t.word ? t.word : '')
        : '第 ' + ((g.stepIndex | 0) + 1) + ' 手 —— 其他人正在作画…';
    } else if (g.phase === 'chain_guess') {
      el.textContent = mine === 'GUESS' ? '轮到你猜词' : '第 ' + ((g.stepIndex | 0) + 1) + ' 手 —— 其他人正在猜词…';
    } else if (g.phase === 'chain_reveal') {
      el.textContent = '回放 —— 看看每条链怎么跑偏的';
    } else if (g.phase === 'chain_vote') {
      el.textContent = '投票：每条链对得上吗 + 你最喜欢的一张画';
    } else if (g.phase === 'chain_score') {
      el.textContent = '本局结束 —— 看结算';
    } else {
      el.textContent = '';
    }
  }

  /**
   * 倒计时用「服务端 deadline − 本机时间（经过时钟偏差校正）」算，各端显示才一致。
   *
   * 显示成「**投票中 12 秒**」——阶段名和秒数放在同一个控件里（#ghTimer）：
   * 只给一个裸数字的话，人不知道在等哪个阶段（接龙的写词步以前就是这样：
   * 整条 HUD 上只有 #ghTimer，没有任何专属控件）。
   * 三个玩法所有阶段共用这一处，所以每个阶段都有倒计时 + 阶段名。
   */
  function updateGameTimer() {
    var el = $('#ghTimer');
    if (!el) return;
    var phaseEl = $('#ghTimerPhase');
    var secEl = $('#ghTimerSec');
    var g = S.game;
    if (!gameActive() || !g || !g.deadline) {
      // 没有倒计时的阶段（大厅 / 结算停留）也要把阶段名留着，不能只剩一个「--」
      if (phaseEl) phaseEl.textContent = (gameActive() && g) ? (g.phaseLabel || PHASE_TEXT[g.phase] || '') : '';
      if (secEl) secEl.textContent = '--';
      el.classList.remove('warn');
      S.tickAt = -1;
      return;
    }
    var left = Math.max(0, Math.ceil((g.deadline - (Date.now() + S.gameSkew)) / 1000));
    var label = g.phaseLabel || PHASE_TEXT[g.phase] || '';
    if (phaseEl) phaseEl.textContent = label;
    // 秒数前面带一个空格：整块读起来是「投票中 12 秒」（不是「投票中12 秒」）
    if (secEl) secEl.textContent = ' ' + left + ' 秒';
    el.classList.toggle('warn', left <= 10 && left > 0);

    // 倒计时音效：按「秒数跨过阈值」响，不是按定时器次数 ——
    // 这个函数 250ms 跑一次，直接响会变成机关枪。
    // 10 秒一声提醒，最后 5 秒每秒一声、音高递增（tickUrgent 的 n 越大越高）。
    var counting = ['draw', 'pick', 'chain_init', 'chain_write', 'chain_guess', 'chain_draw',
      'chain_reveal', 'chain_vote', 'chain_score',
      'skin_night', 'skin_dawn', 'skin_draw', 'skin_talk', 'skin_vote', 'skin_vote_end']
      .indexOf(S.game.phase) >= 0;
    if (counting && left > 0) {
      if (left !== S.tickAt) {
        S.tickAt = left;
        if (left <= 5) SFX.play('tickUrgent', { n: 5 - left });
        else if (left === 10) SFX.play('tickWarn');
      }
    } else {
      S.tickAt = -1;
    }
    if (S.game.phase === 'pick') {
      var pt = $('#pickTimer');
      if (pt) pt.textContent = left;
    }
    // 接龙的倒计时同时喂给「猜词输入框」和「回放播放器」两个面板，顺带管自动提交
    if (S.game.mode === 'chain') {
      var ci = $('#ciTimer');
      if (ci) ci.textContent = left;
      var rp = $('#rpTimer');
      if (rp) rp.textContent = left;
      chainAutoSubmit(left);
    }
    // 画皮同理：夜里动作面板 / 天亮公告各有一个倒计时
    if (S.game.mode === 'skin') {
      var sn = $('#snTimer');
      if (sn) sn.textContent = left;
      var sd = $('#sdTimer');
      if (sd) sd.textContent = left;
    }
    var next = $('#rcNext');
    if (next) {
      next.textContent = (S.game.phase === 'round_end' && left > 0)
        ? left + ' 秒后继续' : '';
    }
  }

  /**
   * 倒计时到 0 的自动提交（接龙）：
   *   DRAWING —— 直接发交画信号（笔迹早已按 STROKE_* 入库，不交白不交）；
   *   GUESS   —— 输入框里有字就交，没字就算了（服务端收格时按「空」处理）；
   *   WORD    —— 不自动交：乱写一个词只会坑下家，宁可空格。
   * 服务端另有 GRACE_MS 宽限，这个包路上多花点时间也收得到。
   */
  function chainAutoSubmit(left) {
    var g = S.game, t = S.chainTask;
    if (!g || !t || left > 0 || S.chainInputSubmitted) return;
    if (!chainStepActive() || t.step !== g.myStep) return;
    if (t.step === 'DRAWING') {
      S.chainInputSubmitted = true;
      net.send(P.C2S.GAME_SUBMIT, {});
      renderChainTask();
      toast('时间到 —— 作品已自动交上去', 'ok', 2600);
    } else if (t.step === 'GUESS') {
      var inp = $('#ciInput');
      var v = inp ? inp.value.trim() : '';
      if (v) {
        S.chainInputSubmitted = true;
        net.send(P.C2S.GAME_SUBMIT, { text: v });
        renderChainTask();
        closeChainInput();
        toast('时间到 —— 猜词已自动交上去', 'ok', 2600);
      }
    }
  }

  function renderGameScore() {
    var box = $('#gameScore');
    if (!box) return;
    if (box.classList.contains('hidden')) return;   // 收起时不白算
    var list = $('#gsList');
    var g = S.game;
    if (!g || !g.scores || !g.scores.length) {
      list.innerHTML = '<div class="gs-row"><span class="gs-name">还没有分数</span></div>';
      return;
    }
    var html = '';
    g.scores.forEach(function (s) {
      var me = s.userId === S.me.userId;
      var mem = S.members.filter(function (m) { return m.userId === s.userId; })[0] || { color: '#9aa0a8' };
      var tags = '';
      if (g.phase === 'draw' && s.userId === g.drawerId) tags += '<span class="gs-tag">画手</span>';
      if ((g.guessed || []).some(function (x) { return x.userId === s.userId; })) tags += '<span class="gs-tag">已猜出</span>';
      html += '<div class="gs-row' + (me ? ' me' : '') + (s.online ? '' : ' offline') + '">' +
        '<span class="gs-rank">' + s.rank + '</span>' +
        '<span class="gs-name"><i class="dot" style="background:' + esc(mem.color) + '"></i>' +
        esc(s.name) + (me ? '（我）' : '') + '</span>' +
        (tags ? '<span>' + tags + '</span>' : '') +
        '<span class="gs-score">' + s.score + '</span></div>';
    });
    list.innerHTML = html;
  }

  /** 只能看着的时候，在画布下方给一个明确的说明，免得对着画布狂点还以为卡了 */
  function renderGameLockTip() {
    var el = $('#gameLockTip');
    var show = gameLocked() || readonlyMe();
    if (!show) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'gameLockTip';
      el.className = 'game-lock-tip';
      $('#stage').appendChild(el);
    }
    // 「观众」是身份，跟有没有在玩这局游戏无关：房主一设就是。
    // 放在最前面 —— 否则下面 `S.game` 为 null 时会直接抛异常。
    if (readonlyMe()) {
      el.textContent = '观众模式 —— 房主只给了你「看」的权限：能看、能聊天，不能改画布';
      return;
    }
    var g = S.game;
    if (g.mode === 'chain') {
      var mine = g.myStep || '';
      // ★ 接龙每一步的说明只有一个出处：
      //   写词 → 居中选词区；作画 → 题面卡片 + 状态条；猜词 → 输入条上方那一行。
      //   所以这里**接龙的动手阶段一律不出声** —— 以前这条贴底提示会再说一遍
      //   「猜词阶段 —— 要猜的画铺在画布上，输入条在下面」，正好压在画布下沿。
      //   房主 / 观众的身份说明在上面已经提前 return 了，不受影响。
      if (chainStepActive()) { if (el) el.remove(); return; }
      if (g.phase === 'chain_init') el.textContent = '马上开始 —— 链已排好，画布已清空';
      else if (g.phase === 'chain_guess') el.textContent = '猜词中 —— 输入条就在下面';
      else if (g.phase === 'chain_draw') el.textContent = mine === 'DRAWING' ? '轮到你作画' : '这一手不是你在画，先看着';
      else if (g.phase === 'chain_reveal') el.textContent = '回放中 —— 画布暂时不能动';
      else if (g.phase === 'chain_vote') el.textContent = '投票中 —— 画布暂时不能动';
      else if (g.phase === 'chain_score') el.textContent = '本局结算 —— 画布暂时不能动';
      else el.textContent = '接龙进行中';
      return;
    }
    if (g.mode === 'skin') {
      if (g.phase === 'skin_draw') {
        el.textContent = g.canDraw
          ? '轮到你作画 —— 别人看不到你的画，交稿后匿名摊开'
          : '这一轮你不能画（出局 / 观战中），等大家交稿';
      } else if (g.phase === 'skin_night') {
        el.textContent = '天黑请闭眼 —— 夜里不能画画';
      } else if (g.phase === 'skin_talk') {
        el.textContent = '看画与讨论中 —— 想指着自己的画解释，可以截图发群里';
      } else if (g.phase === 'skin_vote') {
        el.textContent = '投票放逐中 —— 画布暂时不能动';
      } else {
        el.textContent = '画皮进行中';
      }
      return;
    }
    if (g.phase === 'pick') el.textContent = '正在选词，稍等片刻';
    else if (g.phase === 'round_end') el.textContent = '本回合结束，看答案';
    else el.textContent = gameName(g.drawerName) + ' 正在作画 —— 这一回合你只能在聊天框里猜';
  }

  function syncChatUi() {
    var input = $('#chatInput');
    if (!input) return;
    var hint = '说点什么…（Enter 发送，Shift+Enter 换行）';
    if (gameActive() && S.game.mode === 'chain') {
      // 接龙的猜词走独立输入框（因为题目是「一幅画」），聊天就是普通聊天。
      // 但手里攥着答案的人发言会被服务端拦掉，这里先把话说清楚。
      if (chainStepActive() && S.chainTask && S.chainTask.step !== 'WORD') {
        hint = '你手上正拿着这一步的答案，这里说的话不会发出去';
      } else {
        hint = '说点什么…（接龙的猜词请用画布下面那条输入条）';
      }
    } else if (gameActive() && S.game.mode === 'skin') {
      // 画皮里聊天就是「发言」，是玩法本身 —— 只有夜里要闭嘴
      if (S.game.phase === 'skin_night') {
        hint = '天黑请闭眼 —— 夜里说的话发不出去';
      } else if (S.game.phase === 'skin_talk') {
        hint = '讨论：谁在装？双击画廊里自己的画能放大' ;
      } else {
        hint = '说点什么…（画皮里发言就是你的「嘴」，但别把身份喊出来）';
      }
    } else if (gameActive() && S.game.phase === 'draw') {
      if (gameImDrawer()) hint = '你是画手：可以聊天给提示，但别把答案说出来（带答案的话发不出去）';
      else if (gameGuessedMe()) hint = '你已经猜对了：可以照常聊天，但别把答案说出来（带答案的话发不出去）';
      else hint = '输入你的猜测…（Enter 发送）';
    }
    input.placeholder = hint;
  }

  function openPick(choices) {
    var mask = $('#pickMask');
    if (!mask) return;
    if (!choices || !choices.length) { mask.classList.add('hidden'); return; }
    // ⚠ 判据必须是「候选词**变了没有**」，不能只看回合号。
    //    以前这里判的是 `dataset.round === S.game.round`：点「换一组」之后，
    //    服务端会推一份**新的 choices** 过来，但回合号没变 —— 于是直接 return，
    //    界面上还挂着旧的那三个词。用户看到的正是「点了换一组没反应」，
    //    要等下一回合重新开这个弹窗才「突然换了词」（那时早就进作画阶段了）。
    var sig = String(S.game.round) + '|' + choices.join(',');
    if (!mask.classList.contains('hidden') && mask.dataset.sig === sig) {
      updateRepickUi();
      return;
    }
    var box = $('#pickList');
    box.innerHTML = '';
    choices.forEach(function (w, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-btn';
      b.innerHTML = '<span>' + esc(w) + '</span><span class="len">' + w.length + ' 字</span>';
      b.addEventListener('click', function () {
        net.send(P.C2S.GAME_PICK, { index: i });
        mask.classList.add('hidden');
        mask.dataset.sig = '';
      });
      box.appendChild(b);
    });
    mask.dataset.sig = sig;
    mask.classList.remove('hidden');
    updateRepickUi();
    updateGameTimer();
  }

  /** 「换一组」按钮的状态：不是选词阶段的画手就藏起来，换过就禁用 */
  function updateRepickUi() {
    var btn = $('#btnRepick');
    if (!btn) return;
    var hint = $('#repickHint');
    var g = S.game;
    var show = !!(g && g.phase === 'pick' && g.isDrawer);
    btn.classList.toggle('hidden', !show);
    if (hint) hint.classList.toggle('hidden', !show);
    if (!show) return;
    var n = g.repickLeft || 0;
    btn.disabled = n <= 0;
    btn.textContent = n > 0 ? '换一组' : '已换过';
    if (hint) {
      hint.textContent = n > 0
        ? '都不好画？可以换一组（还剩 ' + n + ' 次）'
        : '这一回合已经换过了';
    }
  }

  function closePick() {
    var mask = $('#pickMask');
    if (!mask) return;
    mask.classList.add('hidden');
    mask.dataset.sig = '';
  }

  function showRoundCard(rr) {
    var card = $('#roundCard');
    if (!card || !rr) return;
    // 结算音：超时用下坠的 timeout，正常收尾用中性的 roundEnd
    SFX.play(rr.reason === 'timeout' ? 'timeout' : 'roundEnd');
    var why = rr.reason === 'timeout' ? '（时间到）' : rr.reason === 'drawer_left' ? '（画手掉线）' : '';
    $('#rcTitle').textContent = '第 ' + rr.round + ' 回合结束' + why;
    $('#rcWord').textContent = rr.word ? '答案是「' + rr.word + '」' : '本回合作废';
    var html = '';
    (rr.guessed || []).forEach(function (x) {
      html += '<div class="yes">✓ ' + esc(x.name) + ' 猜对了（第 ' + x.rank + ' 名）</div>';
    });
    (rr.missed || []).forEach(function (x) {
      html += '<div>· ' + esc(x.name) + ' 没猜出来</div>';
    });
    $('#rcList').innerHTML = html || '<div>这一回合没人猜出来</div>';
    card.classList.remove('hidden');
    // 停留多久由服务端说了算（GAME.ROUND_END_MS），别在前端写死 ——
    // 写死的话改了服务端时长就会和下一回合的开场对不上
    clearTimeout(showRoundCard._t);
    var left = (S.game && S.game.deadline) ? S.game.deadline - (Date.now() + S.gameSkew) : 0;
    showRoundCard._t = setTimeout(hideRoundCard, Math.max(600, left + 200));
    updateGameTimer();
  }

  function hideRoundCard() {
    var card = $('#roundCard');
    if (card) card.classList.add('hidden');
  }

  function openOver(scores) {
    var mask = $('#overMask');
    if (!mask) return;
    var html = '';
    (scores || []).forEach(function (s, i) {
      html += '<div class="rank-row' + (i === 0 ? ' top' : '') + '">' +
        '<span class="rank-no">' + (s.rank || i + 1) + '</span>' +
        '<span class="rank-name">' + esc(s.name) + (s.userId === S.me.userId ? '（我）' : '') + '</span>' +
        '<span class="rank-score">' + s.score + ' 分</span></div>';
    });
    $('#rankList').innerHTML = html || '<p class="hint">这一局没有人得分</p>';
    $('#btnOverAgain').classList.toggle('hidden', !S.me.isOwner);
    $('#btnOverStop').classList.toggle('hidden', !S.me.isOwner);
    mask.classList.remove('hidden');
  }

  function closeOver() {
    var mask = $('#overMask');
    if (mask) mask.classList.add('hidden');
  }

  function onGameWord(word) {
    // 私有通道：词只发给画手一个人，不进广播流
    if (S.game && S.game.isDrawer && word) {
      S.game.word = word;
      renderGameHud();
    }
  }

  function onGameCorrect(msg) {
    if (!msg) return;
    if (msg.userId === S.me.userId) {
      // 自己猜对：最该被听见的那一声（服务端另外给我一条私聊回执说第几名）
      SFX.play('correct');
      return;
    }
    toast(msg.name + ' 猜对了（第 ' + msg.rank + ' 名）', 'ok', 2400);
    // 别人猜对：发一个「闷一点」的版本 —— 抢自己猜对的那一声会让人以为是自己猜的
    SFX.play('correctOther');
  }

  /* ============================================================ 开局设置（三合一面板）
   *
   * 合并前是「顶栏『游戏』→ #gameMask（你画我猜）→ 点『开始游戏』→ 再弹一层
   * #chainMask / #skinMask」：开一局接龙要点 3 次，而且「主题词库 / 作画时间」
   * 两个面板各有一份，得挑两次。
   *
   * 现在只有 #gameMask 这一层（index.html 里的 #chainMask / #skinMask 已经删掉，
   * 不是藏起来）：上方的「玩法」决定下面显示哪几行参数，点**一次**「开始」就进游戏。
   * 行 id ↔ 玩法见 index.html 那张注释表。
   */

  /** 面板里当前选中的玩法（面板内的状态；和房间真正在玩什么无关） */
  var gameDialogMode = 'classic';

  /* 房主预设广播（C2S.GAME_PREFS / S2C.GAME_PREFS）。
   * 协议表里这一条**是服务端刚加的**，前端这边按「有就用，没有就退回约定的名字」
   * 容错，免得两边合版本的一瞬间整块面板哑掉。 */
  var GAME_PREFS_C2S = (P.C2S && P.C2S.GAME_PREFS) || 'game:prefs';
  var GAME_PREFS_S2C = (P.S2C && P.S2C.GAME_PREFS) || 'game:prefs';

  /** /api/share 还没有 setup 块时的本地兜底档位（服务端落地后以服务端为准） */
  var SETUP_FALLBACK = {
    seconds: [0, 3, 5, 10, 20, 30, 60, 90, 120, 180, 300],
    repick: [0, 1, 2, 3],
    rounds: [1, 2, 3, 4, 6, 8, 12],
    players: { classic: [2, 8], chain: [4, 16], skin: [6, 12] }
  };

  /** 每种玩法在面板上要显示哪几行（顺序在 styles.css 的 #gameMask.mode-* 里） */
  var MODE_ROWS = {
    classic: ['rowTheme', 'rowDrawTime', 'rowClassicRounds', 'rowClassicRepick', 'rowClassicRoundEnd'],
    chain: ['rowTheme', 'rowDrawTime', 'rowChainPlay', 'rowChainLength', 'rowChainRelayRounds',
      'rowChainWrite', 'rowChainGuess', 'rowChainReveal', 'rowChainReplaySpeed', 'rowVote'],
    skin: ['rowTheme', 'rowDrawTime', 'rowSkinRounds', 'rowSkinNight', 'rowSkinDawn',
      'rowSkinTalk', 'rowVote']
  };
  var ALL_ROWS = ['rowTheme', 'rowDrawTime', 'rowClassicRounds', 'rowClassicRepick',
    'rowClassicRoundEnd', 'rowChainPlay', 'rowChainLength', 'rowChainRelayRounds',
    'rowChainWrite', 'rowChainGuess', 'rowChainReveal',
    'rowChainReplaySpeed',
    'rowSkinRounds', 'rowSkinNight', 'rowSkinDawn', 'rowSkinTalk', 'rowVote'];

  var MODE_LABEL = { classic: '你画我猜', chain: '接龙', skin: '画皮' };
  var MODE_START_TEXT = { classic: '开始游戏', chain: '开始接龙', skin: '开始画皮' };

  /* ★ v17：接龙的两种**玩法**（mode 仍是 'chain'，这是它下面的子选项）。
     classic = 接龙模式：猜完自己画自己猜出来的词，再传给下家猜；
     relay   = 传词接龙：猜完**不画**，把猜出来的词直接交给下家画。
     标签写死在前端（服务端只给 id 列表，避免 UI 文案跟协议耦合）。 */
  var CHAIN_PLAY_LABEL = {
    classic: '接龙（猜完自己画）',
    relay: '传词接龙（猜完交给下家画）'
  };
  var CHAIN_PLAY_RULE = {
    classic: '每个人先给自己的链写一个词，<b>自己照着它画</b>，沿打乱的顺序传给'
      + '下一个人<b>看着画猜词</b>；猜完<b>自己再画一遍</b>自己猜出来的词，再往下传 —— '
      + '一路传下去，互看不到别人的内容。传完一起看回放，再投票「首尾对得上吗」+「最喜欢的一张画」。',
    relay: '每个人先给自己的链写一个词并<b>自己画出来</b>，传给下家<b>看画猜词</b>；'
      + '猜出来的词<b>他自己不画</b>，直接交给<b>再下一个人画</b>，画完继续往下猜 —— '
      + '起词 → A画 → B猜 → C画 → D猜 → A画 → … 传遍全场若干轮。'
      + '传完一起看回放，再投票「起词 vs 最后猜出来的词对得上吗」。'
  };

  /** 面板里所有会写进 GAME_START / GAME_PREFS 的控件（改一个就广播一次，300ms 防抖） */
  var SETUP_CONTROL_IDS = ['gameTheme', 'gameDrawTime', 'gameRounds', 'gameRepickLimit',
    'gameRoundEndTime', 'chainLength', 'chainPlay', 'chainRelayRounds',
    'chainWriteTime', 'chainGuessTime', 'chainRevealTime',
    'chainReplaySpeed',
    'gameSkinRounds', 'gameNightTime', 'gameDawnTime', 'gameTalkTime', 'gameVoteTime'];

  /* ---- 档位 / 默认值的来源：优先 /api/share ---- */

  function shareSetup() {
    var st = S.shareCfg && S.shareCfg.setup;
    return (st && typeof st === 'object') ? st : {};
  }
  function hostShareBlock(key) {
    var b = S.shareCfg && S.shareCfg[key];
    return (b && typeof b === 'object') ? b : {};
  }
  /** 拿服务端下发的档位数组；没有就用本地兜底 */
  function setupList(key) {
    var v = shareSetup()[key];
    return (Array.isArray(v) && v.length) ? v.slice() : SETUP_FALLBACK[key].slice();
  }
  function secOf(ms, dflt) {
    var n = Math.round(Number(ms) / 1000);
    return (isFinite(n) && n > 0) ? n : dflt;
  }

  /**
   * 各阶段的「默认秒数」—— 用来把每个时间下拉的第一项标成「默认（80 秒）」。
   *
   * 来源按可靠性排序：/api/share 的 game / chain / skin 三个块（那是服务端真在用的值，
   * GAME_* 环境变量会压它们）→ shared/protocol.js 的常量。
   * 只按常量标的话，压缩计时的服务端上会写着一个根本不生效的秒数。
   */
  function defaultSeconds() {
    var g = hostShareBlock('game'), c = hostShareBlock('chain'), s = hostShareBlock('skin');
    return {
      drawClassic: secOf(g.ROUND_MS, Math.round(P.GAME.ROUND_MS / 1000)),
      roundEnd: secOf(g.ROUND_END_MS, Math.round(P.GAME.ROUND_END_MS / 1000)),
      drawChain: secOf(c.DRAW_MS, Math.round(P.GAME.CHAIN_DRAW_MS / 1000)),
      write: secOf(c.WRITE_MS, Math.round(P.GAME.CHAIN_WRITE_MS / 1000)),
      guess: secOf(c.GUESS_MS, Math.round(P.GAME.CHAIN_GUESS_MS / 1000)),
      reveal: secOf(c.REVEAL_MS, Math.round(P.GAME.CHAIN_REVEAL_MS / 1000)),
      voteChain: secOf(c.VOTE_MS, Math.round(P.GAME.CHAIN_VOTE_MS / 1000)),
      drawSkin: secOf(s.DRAW_MS, Math.round(P.GAME.SKIN_DRAW_MS / 1000)),
      night: secOf(s.NIGHT_MS, Math.round(P.GAME.SKIN_NIGHT_MS / 1000)),
      dawn: secOf(s.DAWN_MS, Math.round(P.GAME.SKIN_DAWN_MS / 1000)),
      talk: secOf(s.TALK_MS, Math.round(P.GAME.SKIN_TALK_MS / 1000)),
      voteSkin: secOf(s.VOTE_MS, Math.round(P.GAME.SKIN_VOTE_MS / 1000))
    };
  }

  /** 作画时间三个玩法共用一个下拉，但三个玩法的默认秒数不一样（80 / 90 / 60） */
  function drawDefaultSec(mode) {
    var d = defaultSeconds();
    return mode === 'chain' ? d.drawChain : mode === 'skin' ? d.drawSkin : d.drawClassic;
  }

  /** 某个玩法的人数上下限：优先 /api/share 的 setup.players，其次本地兜底 */
  function modePlayers(mode) {
    var v = shareSetup().players;
    var a = v && v[mode];
    if (Array.isArray(a) && a.length >= 2) {
      var mn = Math.floor(Number(a[0])), mx = Math.floor(Number(a[1]));
      if (isFinite(mn) && isFinite(mx) && mn > 0 && mx >= mn) return { min: mn, max: mx };
    }
    var f = SETUP_FALLBACK.players[mode] || SETUP_FALLBACK.players.classic;
    return { min: f[0], max: f[1] };
  }

  /** 能上场的玩家数（只读观众不算；服务端那边也是这么数的） */
  function onlinePlayers() {
    return (S.members || []).filter(function (m) { return !m.readonly; }).length;
  }

  /** 「默认（1 分半）」这类标签 */
  function secLabel(v) {
    v = Math.round(Number(v) || 0);
    if (v >= 60 && v % 60 === 0) return (v / 60) + ' 分钟';
    if (v === 90) return '1 分半';
    return v + ' 秒';
  }

  /** 读一个下拉的秒数：''（默认档）→ 0，服务端按 0/缺省 = 用它的默认 */
  function selNumTime(sel) {
    var el = $(sel);
    var v = el ? String(el.value == null ? '' : el.value).trim() : '';
    if (!v) return 0;
    var n = Math.floor(Number(v));
    return (isFinite(n) && n > 0) ? n : 0;
  }

  function setSelValue(sel, v) {
    var el = $(sel);
    if (!el) return;
    var s = String(v == null ? '' : v);
    if (s === '') { el.value = ''; return; }
    var has = Array.prototype.some.call(el.options, function (o) { return o.value === s; });
    if (has) el.value = s;
  }

  /**
   * 时间下拉：第一项是「默认（N 秒）」（值 ''，= 交给服务端的默认），后面是可选的档位。
   * 用户选过的值在重建时**保留**（切玩法回来不该被重置 —— 见 resetModeControls）。
   */
  function buildSecondSelect(sel, srvDef, minSec, maxSec) {
    if (!sel) return;
    var list = setupList('seconds').map(Number).filter(function (v) {
      return v > 0 && (minSec == null || v >= minSec) && (maxSec == null || v <= maxSec);
    }).sort(function (a, b) { return a - b; });
    var sig = 's' + srvDef + '|' + minSec + '|' + maxSec + '|' + list.join(',');
    var cur = String(sel.value || '');
    if (sel.dataset.sig !== sig) {
      // 第一项固定用「秒」写（用户要的是「默认（80 秒）」这种），后面的档位才用
      // 「1 分钟 / 1 分半」这类好读的说法
      var html = '<option value="">默认（' + Math.round(Number(srvDef) || 0) + ' 秒）</option>';
      list.forEach(function (v) { html += '<option value="' + v + '">' + secLabel(v) + '</option>'; });
      sel.innerHTML = html;
      sel.dataset.sig = sig;
      var has = Array.prototype.some.call(sel.options, function (o) { return o.value === cur; });
      sel.value = has ? cur : '';
    }
  }

  /** 回合数 / 轮数 / 换词次数这种「个数」下拉：默认那一档标出「（默认）」 */
  function buildNumberSelect(sel, list, dflt, unit, zeroLabel) {
    if (!sel) return;
    var arr = list.map(Number).filter(function (v) { return isFinite(v) && v >= 0; })
      .sort(function (a, b) { return a - b; });
    var sig = 'n' + dflt + '|' + unit + '|' + arr.join(',');
    var cur = String(sel.value || '');
    if (sel.dataset.sig !== sig) {
      var html = '';
      arr.forEach(function (v) {
        var txt = (zeroLabel && v === 0) ? zeroLabel : (v + ' ' + unit);
        if (v === dflt) txt += '（默认）';
        html += '<option value="' + v + '">' + txt + '</option>';
      });
      sel.innerHTML = html || ('<option value="' + dflt + '">' + dflt + '</option>');
      sel.dataset.sig = sig;
      var has = Array.prototype.some.call(sel.options, function (o) { return o.value === cur; });
      sel.value = has ? cur : String(dflt);
      if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
    }
  }

  /**
   * 接龙的链长上限（手）。
   *
   * ⚠ 现在是 **2 × 人数** —— 因为「每人猜完立刻画自己猜出来的词」那一版里，
   *   一个人要占两格（猜 + 画），链主占两格（起词 + 画），
   *   所以「人人轮到」正好是 `2N` 手，而不是旧的 `N + 1`。
   *   （4 人 = 8 手：A起词 → A画 → B猜 → B画 → C猜 → C画 → D猜 → D画）
   *   服务端还会再夹一次；这里先夹是为了让下拉框里看到的即所得。
   */
  function chainLengthCap() {
    var online = onlinePlayers();
    var perPlayer = (S.shareCfg && S.shareCfg.setup && S.shareCfg.setup.chainLength
      && S.shareCfg.setup.chainLength.perPlayer) || 2;
    return Math.max(P.GAME.CHAIN_LENGTH_MIN,
      Math.min(online * perPlayer, P.GAME.CHAIN_LENGTH_MAX * perPlayer));
  }

  /** 链长下拉：3 ~ 2×人数。人数变了要重填（见 chainLengthValue 的注释） */
  function buildChainLengthSelect() {
    var sel = $('#chainLength');
    if (!sel) return;
    var online = onlinePlayers();
    var cap = chainLengthCap();
    var full = online * 2;                       // 「人人轮到」那一档，标一下
    var sig = P.GAME.CHAIN_LENGTH_MIN + '-' + cap;
    var cur = Number(sel.value) || 0;
    if (sel.dataset.sig !== sig) {
      var html = '';
      for (var i = P.GAME.CHAIN_LENGTH_MIN; i <= cap; i++) {
        html += '<option value="' + i + '">' + i + ' 手'
          + (i === full ? '（人人轮到）' : '') + '</option>';
      }
      sel.innerHTML = html;
      sel.dataset.sig = sig;
      sel.value = (cur >= P.GAME.CHAIN_LENGTH_MIN && cur <= cap) ? String(cur) : String(cap);
    }
  }

  /**
   * 链长（夹到 [CHAIN_LENGTH_MIN, 2×人数]）。
   *
   * ⚠ 上限是**人数 × 2**：一个人要占两格（猜 + 画），链主占两格（起词 + 画），
   *   所以「人人轮到」正好是 2N 手，而不是旧的 N + 1。
   *   （4 人 = 8 手：A起词 → A画 → B猜 → B画 → C猜 → C画 → D猜 → D画）
   * 服务端还会再夹一次，这里先夹是为了让 UI 上看到的即所得。
   */
  function chainLengthValue() {
    var sel = $('#chainLength');
    var want = Number(sel && sel.value) || chainLengthCap();
    var cap = chainLengthCap();
    return Math.max(P.GAME.CHAIN_LENGTH_MIN, Math.min(want, cap));
  }

  /* ---- 回放倍速（v14：每局设置，接龙那组里的一行）----
   *
   * 档位与默认值**都从服务端来**（/api/share 的 setup.replaySpeed = { speeds, default }，
   * 由 game-prefs.js 的 setupOptions() 从协议常量推出来）—— 前端不再抄一份数字。
   * 语义：倍速越大 → 每一格定格越短（服务端 revealLegMs() 直接除以它）。
   */
  function replaySpeedList() {
    var v = shareSetup().replaySpeed;
    var arr = v && Array.isArray(v.speeds) ? v.speeds : null;
    if (!arr || !arr.length) arr = P.GAME.CHAIN_REPLAY_SPEEDS;
    return arr.map(function (x) { return Number(x); }).filter(function (x) { return isFinite(x) && x > 0; });
  }
  function replaySpeedDefault() {
    var v = shareSetup().replaySpeed;
    var d = v ? Number(v.default) : NaN;
    if (!isFinite(d) || d <= 0) d = P.GAME.CHAIN_REPLAY_SPEED_DEFAULT;
    return d;
  }
  /** 「1.5x」这样的标签（1 → 「1x」，1.5 → 「1.5x」） */
  function speedLabel(v) {
    var n = Number(v);
    return (isFinite(n) ? String(n) : '') + 'x';
  }
  /** 下拉当前值 → 倍速数值；空 / 非法 = 默认（服务端还会再夹一次） */
  function chainReplaySpeedValue() {
    var el = $('#chainReplaySpeed');
    var n = Number(el && el.value);
    if (!isFinite(n) || n <= 0) return replaySpeedDefault();
    return replaySpeedList().indexOf(n) >= 0 ? n : replaySpeedDefault();
  }
  /** 按服务端给的档位重建这一行（用户选过的值保留；没选过 = 默认档） */
  function buildReplaySpeedSelect() {
    var sel = $('#chainReplaySpeed');
    if (!sel) return;
    var list = replaySpeedList();
    var sig = list.join(',') + '@' + replaySpeedDefault();
    if (sel.dataset.sig === sig) return;
    var cur = Number(sel.value);
    if (!isFinite(cur) || cur <= 0) cur = replaySpeedDefault();
    var html = '';
    list.forEach(function (v) {
      html += '<option value="' + v + '">' + speedLabel(v)
        + (v === replaySpeedDefault() ? '（默认）' : '') + '</option>';
    });
    sel.innerHTML = html;
    sel.dataset.sig = sig;
    sel.value = String(list.indexOf(cur) >= 0 ? cur : replaySpeedDefault());
  }

  /* ---- ★ v17：接龙玩法（chainPlay）与传词接龙的轮数 ----
   *
   * 档位与默认值都从服务端来（/api/share 的 setup.chainPlay / setup.relayRounds，
   * 由 game-prefs.js 的 setupOptions() 从协议常量推出来）；标签写死在前端。
   * 玩法是**每局设置**：接龙模式走 chainLength 那一行，传词接龙走 relayRounds 那一行。
   */
  function chainPlayList() {
    var v = shareSetup().chainPlay;
    var arr = (v && Array.isArray(v.list) && v.list.length) ? v.list : P.GAME.CHAIN_PLAYS;
    var known = Object.keys(CHAIN_PLAY_LABEL);
    var out = arr.filter(function (id) { return known.indexOf(id) >= 0; });
    return out.length ? out : known;
  }
  function chainPlayDefault() {
    var v = shareSetup().chainPlay;
    var d = v && v.default;
    return chainPlayList().indexOf(d) >= 0 ? d : P.GAME.CHAIN_PLAY_DEFAULT;
  }
  /** 下拉当前值 → 玩法 id；空 / 非法 = 默认（服务端还会再夹一次） */
  function chainPlayValue() {
    var el = $('#chainPlay');
    var v = el && el.value;
    return chainPlayList().indexOf(v) >= 0 ? v : chainPlayDefault();
  }
  function buildChainPlaySelect() {
    var sel = $('#chainPlay');
    if (!sel) return;
    var list = chainPlayList();
    var sig = list.join(',') + '@' + chainPlayDefault();
    if (sel.dataset.sig === sig) return;
    var cur = sel.value;
    if (list.indexOf(cur) < 0) cur = chainPlayDefault();
    var html = '';
    list.forEach(function (id) {
      html += '<option value="' + id + '">' + esc(CHAIN_PLAY_LABEL[id] || id)
        + (id === chainPlayDefault() ? '（默认）' : '') + '</option>';
    });
    sel.innerHTML = html;
    sel.dataset.sig = sig;
    sel.value = cur;
  }

  function relayRoundsRange() {
    var v = shareSetup().relayRounds || {};
    var lo = Number(v.min), hi = Number(v.max);
    if (!isFinite(lo) || lo < 1) lo = P.GAME.CHAIN_RELAY_ROUNDS_MIN;
    if (!isFinite(hi) || hi < lo) hi = P.GAME.CHAIN_RELAY_ROUNDS_MAX;
    var dflt = Number(v.default);
    if (!isFinite(dflt) || dflt < lo || dflt > hi) dflt = P.GAME.CHAIN_RELAY_ROUNDS_DEFAULT;
    return { min: lo, max: hi, dflt: dflt };
  }
  function relayRoundsValue() {
    var r = relayRoundsRange();
    var el = $('#chainRelayRounds');
    var n = Math.floor(Number(el && el.value));
    if (!isFinite(n) || n <= 0) return r.dflt;
    return n < r.min ? r.min : n > r.max ? r.max : n;
  }
  function buildRelayRoundsSelect() {
    var sel = $('#chainRelayRounds');
    if (!sel) return;
    var r = relayRoundsRange();
    var sig = r.min + '-' + r.max + '@' + r.dflt;
    if (sel.dataset.sig === sig) return;
    var cur = Math.floor(Number(sel.value));
    if (!isFinite(cur) || cur < r.min || cur > r.max) cur = r.dflt;
    var html = '';
    for (var i = r.min; i <= r.max; i++) {
      html += '<option value="' + i + '">' + i + ' 轮' + (i === r.dflt ? '（默认）' : '') + '</option>';
    }
    sel.innerHTML = html;
    sel.dataset.sig = sig;
    sel.value = String(cur);
  }

  /** 按当前玩法切换「链长 / 传几轮」两行，并把提示文案换掉 */
  function syncChainPlayRows() {
    var play = chainPlayValue();
    var lenRow = document.getElementById('rowChainLength');
    var rrRow = document.getElementById('rowChainRelayRounds');
    var relay = (play === 'relay');
    if (lenRow) lenRow.classList.toggle('hidden', relay);
    if (rrRow) rrRow.classList.toggle('hidden', !relay);
    var hint = $('#chainPlayHint');
    if (hint) {
      hint.textContent = relay
        ? '传词接龙：猜完的词他自己不画，交给下家画（链长 = 1 + 轮数 × 人数）'
        : '接龙：猜完自己画自己猜的词（链长 = 2 × 人数）';
    }
    return play;
  }

  /* ---- 开局 payload（「开始」与结算页「再来一局」共用同一份） ---- */

  /**
   * 按当前玩法组装 GAME_START / GAME_PREFS 的字段 —— 契约见 shared/protocol.js：
   *   mode, theme, drawSeconds                       三个玩法共用
   *   rounds, repickLimit, roundEndSeconds           你画我猜
   *   chainLength, writeSeconds, guessSeconds, revealSeconds, replaySpeed, voteSeconds   接龙
   *   nightSeconds, dawnSeconds, talkSeconds         画皮（投票复用 voteSeconds）
   * 秒数一律 0 = 用服务端默认。
   */
  function gameSetupPayload(mode) {
    var m = (mode === 'chain' || mode === 'skin') ? mode : 'classic';
    var p = {
      mode: m,
      theme: ($('#gameTheme') && $('#gameTheme').value) || '',
      drawSeconds: selNumTime('#gameDrawTime')
    };
    if (m === 'classic') {
      p.rounds = Number($('#gameRounds') && $('#gameRounds').value) || P.GAME.DEFAULT_ROUNDS;
      p.repickLimit = selNumTime('#gameRepickLimit');
      p.roundEndSeconds = selNumTime('#gameRoundEndTime');
    } else if (m === 'chain') {
      // ★ v17：接龙玩法（classic / relay）。传词接龙下链长由轮数算（服务端决定），
      //   所以那边**只发 relayRounds**；两个字段都带上也不会出错（服务端按玩法取用）。
      p.chainPlay = chainPlayValue();
      p.relayRounds = relayRoundsValue();
      p.chainLength = chainLengthValue();
      p.writeSeconds = selNumTime('#chainWriteTime');
      p.guessSeconds = selNumTime('#chainGuessTime');
      p.revealSeconds = selNumTime('#chainRevealTime');
      p.replaySpeed = chainReplaySpeedValue();
      p.voteSeconds = selNumTime('#gameVoteTime');
    } else {
      p.rounds = Number($('#gameSkinRounds') && $('#gameSkinRounds').value) || P.GAME.SKIN_ROUNDS;
      p.nightSeconds = selNumTime('#gameNightTime');
      p.dawnSeconds = selNumTime('#gameDawnTime');
      p.talkSeconds = selNumTime('#gameTalkTime');
      p.voteSeconds = selNumTime('#gameVoteTime');
    }
    return p;
  }

  /**
   * 经典模式的开局参数 —— 对话框里的「开始」和结算页的「再来一局」**共用这一份**。
   *
   * ⚠ 以前「再来一局」是自己手写 `{ rounds }` 的，**漏了 theme**：
   *   服务端 game.start() 里 `this.theme = opts.theme && hasTheme(...) ? ... : ''`
   *   → 主题被清成「通用」，而界面上的下拉框还停在刚才选的主题。
   *   表现就是用户说的「词库串主题」；抽成一份之后，再加字段不会只补一处。
   */
  function classicStartPayload() { return gameSetupPayload('classic'); }

  /* ---- 房主预设广播 ---- */

  var prefsTimer = null;
  var prefsLastSent = '';

  /** 房主在面板上**改一项就发一次**（300ms 防抖：连着改几行只发最后一版） */
  function queueSendGamePrefs() {
    if (!S.joined || !S.me.isOwner) return;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(sendGamePrefs, 300);
  }

  function sendGamePrefs() {
    prefsTimer = null;
    if (!S.joined || !S.me.isOwner) return;
    var payload = gameSetupPayload(gameDialogMode);
    var sig = JSON.stringify(payload);
    if (sig === prefsLastSent) return;      // 同一份配置不用反复发
    prefsLastSent = sig;
    net.send(GAME_PREFS_C2S, payload);
  }

  /** 面板上任何一个设置控件变了都走这里 */
  function onSetupControlChange() {
    if (this && this.id === 'gameTheme') setThemeChoice(this.value);
    // ★ v17：换玩法（接龙 / 传词接龙）时把「链长 / 传几轮」两行换过来 + 更新说明
    if (this && (this.id === 'chainPlay' || this.id === 'chainRelayRounds')) {
      if (gameDialogMode === 'chain') {
        syncChainPlayRows();
        var rule = $('#gameRule');
        if (rule) rule.innerHTML = CHAIN_PLAY_RULE[chainPlayValue()] || CHAIN_PLAY_RULE.classic;
      }
    }
    queueSendGamePrefs();
  }

  /**
   * 把房主的预设刷进面板，非房主**锁成只读**。
   *
   * ⚠ 房主本人**不套用**这份回显：服务端会把预设原样广播给全房间（含发送者），
   *   照着回显刷一遍会把「切玩法时重置玩法特有参数」当场顶掉（回到你上次在那一档
   *   选过的值），也可能顶掉还没发出去的编辑。房主的值本来就在控件里。
   */
  function applyGamePrefs() {
    var ro = !S.me.isOwner;
    var prefs = (S.gamePrefs && typeof S.gamePrefs === 'object') ? S.gamePrefs : null;
    if (ro && prefs && (prefs.mode === gameDialogMode)) {
      setSelValue('#gameTheme', prefs.theme);
      setSelValue('#gameDrawTime', prefs.drawSeconds);
      setSelValue('#gameRounds', prefs.rounds);
      setSelValue('#gameRepickLimit', prefs.repickLimit);
      setSelValue('#gameRoundEndTime', prefs.roundEndSeconds);
      setSelValue('#chainLength', prefs.chainLength);
      setSelValue('#chainPlay', prefs.chainPlay);
      setSelValue('#chainRelayRounds', prefs.relayRounds);
      setSelValue('#chainWriteTime', prefs.writeSeconds);
      setSelValue('#chainGuessTime', prefs.guessSeconds);
      setSelValue('#chainRevealTime', prefs.revealSeconds);
      setSelValue('#chainReplaySpeed', prefs.replaySpeed);
      setSelValue('#gameSkinRounds', prefs.rounds);
      setSelValue('#gameNightTime', prefs.nightSeconds);
      setSelValue('#gameDawnTime', prefs.dawnSeconds);
      setSelValue('#gameTalkTime', prefs.talkSeconds);
      setSelValue('#gameVoteTime', prefs.voteSeconds);
    }
    var note = $('#gamePrefsNote');
    if (note) {
      note.classList.toggle('hidden', !ro);
      note.textContent = !ro ? ''
        : (prefs ? '房主设置的当前配置（只读）—— 想改就让房主改'
          : '只有房主能改这些设置，等房主同步配置…');
    }
    SETUP_CONTROL_IDS.concat(['btnGameThemeManage']).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = ro;
    });
  }

  /* ---- 渲染 ---- */

  /** 切玩法：换文案 / 换显示哪几行 / 重置玩法特有参数（通用参数保留） */
  function resetModeControls(mode) {
    if (mode === 'classic') {
      setSelValue('#gameRounds', String(P.GAME.DEFAULT_ROUNDS));
      setSelValue('#gameRepickLimit', String(P.GAME.REPICK_LIMIT));
      setSelValue('#gameRoundEndTime', '');
    } else if (mode === 'chain') {
      var online = onlinePlayers();
      // ★ v17：切回接龙先把玩法复位成默认（接龙模式），轮数也回默认档
      setSelValue('#chainPlay', String(chainPlayDefault()));
      setSelValue('#chainRelayRounds', String(relayRoundsRange().dflt));
      setSelValue('#chainLength', String(Math.max(P.GAME.CHAIN_LENGTH_MIN,
        Math.min(online, P.GAME.CHAIN_LENGTH_MAX) * 2)));
      setSelValue('#chainWriteTime', '');
      setSelValue('#chainGuessTime', '');
      setSelValue('#chainRevealTime', '');
      // 回放倍速回到默认档（不保留上次选的 —— 切玩法回来应当是「开箱即用」的 1.5x）
      setSelValue('#chainReplaySpeed', String(replaySpeedDefault()));
      setSelValue('#gameVoteTime', '');
    } else {
      setSelValue('#gameSkinRounds', String(P.GAME.SKIN_ROUNDS));
      setSelValue('#gameNightTime', '');
      setSelValue('#gameDawnTime', '');
      setSelValue('#gameTalkTime', '');
      setSelValue('#gameVoteTime', '');
    }
    // ⚠ #gameTheme / #gameDrawTime 不动：它们是三个玩法**共用**的通用参数，
    //   切玩法时用户刚才挑的词库和作画时间要留着。
  }

  function renderGameDialog() {
    // 非房主跟着房主的玩法走（房主切玩法会再广播一次 mode）
    if (!S.me.isOwner && S.gamePrefs && S.gamePrefs.mode && S.gamePrefs.mode !== gameDialogMode) {
      setGameDialogMode(S.gamePrefs.mode, { silent: true });
      return;                      // setGameDialogMode 里已经重新渲染过了
    }
    var mode = gameDialogMode;
    var mask = $('#gameMask');
    if (mask) {
      mask.classList.toggle('mode-classic', mode === 'classic');
      mask.classList.toggle('mode-chain', mode === 'chain');
      mask.classList.toggle('mode-skin', mode === 'skin');
    }
    var seg = $('#gameModeSeg');
    if (seg) {
      var btns = seg.querySelectorAll('.seg-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
      }
    }
    var title = $('#gameTitle');
    if (title) title.textContent = MODE_LABEL[mode] + ' · 开局设置';
    var rule = $('#gameRule');
    if (rule) {
      if (mode === 'chain') {
        rule.innerHTML = CHAIN_PLAY_RULE[chainPlayValue()] || CHAIN_PLAY_RULE.classic;
      } else if (mode === 'skin') {
        rule.innerHTML = '把「发言」换成<b>限时作画</b>的狼人杀：所有人都有身份，每轮天亮后'
          + '<b>画同一个主题</b>，画完<b>匿名摊开</b>，大家看画猜作者想表达什么，'
          + '讨论之后投票放逐。<b>伪装者</b>混在画师里靠画风和言语的破绽被抓。'
          + '好人赢 = 放逐所有伪装者；伪装者赢 = 人数不少于画师。';
      } else {
        rule.innerHTML = '轮流当画手：<b>画手</b>从三个词里挑一个，只能用画的；'
          + '其他人在<b>聊天框</b>里打字猜。猜得越快分越高，画手也会因为别人猜出来而得分。'
          + '回合之间画布会自动清空。';
      }
    }
    // 行显隐：本玩法要的行露出来，其余加回 hidden（重复的控件是真删了，不是藏起来）
    var want = {};
    MODE_ROWS[mode].forEach(function (id) { want[id] = true; });
    ALL_ROWS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !want[id]);
    });
    // 控件：选项列表可以随便重建，但**值要保留**（用户没改过就别动它）
    var d = defaultSeconds();
    buildThemeSelect($('#gameTheme'));
    buildSecondSelect($('#gameDrawTime'), drawDefaultSec(mode),
      P.GAME.DRAW_SECONDS_MIN, P.GAME.DRAW_SECONDS_MAX);
    buildSecondSelect($('#gameRoundEndTime'), d.roundEnd);
    buildSecondSelect($('#chainWriteTime'), d.write);
    buildSecondSelect($('#chainGuessTime'), d.guess);
    buildSecondSelect($('#chainRevealTime'), d.reveal);
    buildSecondSelect($('#gameNightTime'), d.night);
    buildSecondSelect($('#gameDawnTime'), d.dawn);
    buildSecondSelect($('#gameTalkTime'), d.talk);
    buildSecondSelect($('#gameVoteTime'), mode === 'skin' ? d.voteSkin : d.voteChain);
    buildNumberSelect($('#gameRounds'), setupList('rounds'), P.GAME.DEFAULT_ROUNDS, '回合');
    buildNumberSelect($('#gameSkinRounds'), setupList('rounds'), P.GAME.SKIN_ROUNDS, '轮');
    buildNumberSelect($('#gameRepickLimit'), setupList('repick'), P.GAME.REPICK_LIMIT, '次', '不能换');
    buildChainLengthSelect();
    buildReplaySpeedSelect();
    // ★ v17：接龙玩法 + 传词轮数（两行二选一显示，见 syncChainPlayRows）
    buildChainPlaySelect();
    buildRelayRoundsSelect();
    if (mode === 'chain') syncChainPlayRows();

    // 非房主：房主的预设（只读）
    applyGamePrefs();

    // 人数提示（合并前 #chainPlayers / #skinPlayers 各有一份，现在只有这一行）
    var lim = modePlayers(mode);
    var online = onlinePlayers();
    var pl = $('#gamePlayers');
    if (pl) {
      pl.textContent = '当前 ' + online + ' 人在线（' + MODE_LABEL[mode] + '需要 '
        + lim.min + ' ~ ' + lim.max + ' 人）';
      pl.style.color = (online < lim.min || online > lim.max) ? 'var(--danger)' : 'var(--text-dim)';
    }

    // 状态行（三种玩法共用一行，按玩法挑要显示的信息）
    var state = $('#gameState');
    if (state) {
      var g = S.game;
      if (gameActive() && g) {
        var label = g.phaseLabel || PHASE_TEXT[g.phase] || '';
        if (mode === 'classic') {
          state.innerHTML = '当前：<b>' + esc(label) + '</b>'
            + (g.drawerName ? '　画手：' + esc(g.drawerName) : '')
            + '　第 ' + Math.max(1, Math.min(g.round || 1, g.rounds || 1)) + ' / ' + (g.rounds || 0) + ' 回合';
        } else if (mode === 'chain') {
          state.innerHTML = '当前：<b>' + esc(label) + '</b>'
            + (g.chainLength ? '　链长：' + g.chainLength + ' 手' : '')
            + (g.players ? '　' + g.players.length + ' 人' : '');
        } else {
          state.innerHTML = '当前：<b>' + esc(label) + '</b>'
            + '　第 ' + Math.max(1, g.round || 1) + ' / ' + (g.maxRounds || 0) + ' 轮';
        }
      } else {
        state.textContent = '当前：自由绘画';
      }
    }

    // 按钮：开始 / 结束（非房主只看到「关闭」）
    var bs = $('#btnGameStart');
    if (bs) {
      bs.textContent = online < lim.min ? ('还差 ' + (lim.min - online) + ' 人')
        : online > lim.max ? ('超出 ' + (online - lim.max) + ' 人')
          : MODE_START_TEXT[mode];
      bs.classList.toggle('hidden', !S.me.isOwner || gameActive());
    }
    var stop = $('#btnGameStop');
    if (stop) stop.classList.toggle('hidden', !S.me.isOwner || !gameActive());
    var dh = $('#drawTimeHint');
    if (dh) {
      dh.textContent = mode === 'chain' ? '每一手「照词作画」的时限（写词 / 猜词另算）'
        : mode === 'skin' ? '每轮天亮后的作画时限' : '每回合画手的作画时限';
    }
  }

  /** 兼容旧调用点：面板渲染全走 renderGameDialog */
  function updateGameDialog() { renderGameDialog(); }

  /** 切玩法（面板内）：mode 变了自己会重置玩法特有参数，并给房主广播一次 */
  function setGameDialogMode(mode, opts) {
    var next = (mode === 'chain' || mode === 'skin') ? mode : 'classic';
    var changed = next !== gameDialogMode;
    gameDialogMode = next;
    if (changed) resetModeControls(next);
    renderGameDialog();
    if (!(opts && opts.silent)) queueSendGamePrefs();
  }

  function openGameDialog() {
    if (!S.joined) { toast('先进一个茶绘室再开局', 'err'); return; }
    // 房间正在玩某种玩法 → 面板直接切到那一种（一个房间同时只挂一种玩法；
    // 不再像以前那样「再弹一层属于那个玩法的面板」）
    setGameDialogMode(gameActive() && S.game && S.game.mode ? S.game.mode : gameDialogMode,
      { silent: true });
    renderGameDialog();
    // 每次都问一次 /api/share：面板上的档位、「默认（N 秒）」标签、人数上下限都按它算，
    // 开局前快照里的词库列表也靠它垫底
    probePublicUrl();
    $('#gameMask').classList.remove('hidden');
  }

  /**
   * 「开始」——**点一次就进游戏**：不再转出第二个设置页。
   * 人数不在当前玩法的上下限里就不发（点击时提示，按钮上写着「还差 X 人」）。
   */
  function startGame() {
    var mode = gameDialogMode;
    if (!S.me.isOwner) { toast('只有房主可以开局', 'err'); return; }
    var lim = modePlayers(mode);
    var online = onlinePlayers();
    if (online < lim.min || online > lim.max) {
      SFX.play('error');
      toast('需要 ' + lim.min + '~' + lim.max + ' 人（当前 ' + online + ' 人）', 'warn', 3600);
      return;
    }
    net.send(P.C2S.GAME_START, gameSetupPayload(mode));
    $('#gameMask').classList.add('hidden');
    if (mode === 'chain') toast('接龙大厅已开出 —— 大家点「准备」', 'ok', 2800);
  }

  /** 「结束游戏」的统一入口：经典走 GAME_STOP，接龙 / 画皮还要把那一套浮层收干净 */
  function stopCurrentGame() {
    if (gameActive() && S.game && S.game.mode !== 'classic') { endChainGame(); return; }
    stopGame();
  }

  /** 面板 / HUD 上那颗「结束游戏」共用的二次确认（文案按玩法不同） */
  function askStopGame() {
    if (!S.me.isOwner || !gameActive()) return;
    var mode = (S.game && S.game.mode) || 'classic';
    var ask = mode === 'chain' ? '结束这一局接龙？分数不会保留。'
      : mode === 'skin' ? '结束画皮？这一局的身份不会被保留。'
        : '结束这一局？分数不会保留，画布会留在当前画面。';
    confirmDialog(ask, { title: '结束游戏', yes: '结束游戏', danger: true })
      .then(function (yes) { if (yes) stopCurrentGame(); });
  }

  function stopGame() {
    net.send(P.C2S.GAME_STOP, {});
    $('#gameMask').classList.add('hidden');
    closeOver();
  }

  /**
   * 「结束游戏」——**本地立刻**销毁接龙这一套 UI 并回主菜单，不等服务端任何回执。
   *
   * 为什么不能只发 GAME_STOP：那一包是「房主请服务端停局」的请求，服务端不回执，
   * 慢网下要等下一次快照才生效。玩家点了「结束游戏」却还盯着接龙面板，
   * 会以为按钮坏了 —— 所以这里同一次点击里就把界面收干净、把入口页顶上来。
   */
  function endChainGame() {
    closeChainUi();       // 题面 / 大厅 / 进度 / 输入条 / 回放投票条 / 画布层
    closeGameUi();        // 顶栏 HUD、计分板、锁定提示、游戏弹窗
    // 告诉服务端一声（不等回执）。⚠ GAME_STOP 只有房主有权发：
    // 别人发了服务端会回一句 ERROR，那声提示反而会盖在入口页上，所以非房主不发。
    if (S.me && S.me.isOwner) {
      try { net.send(P.C2S.GAME_STOP, {}); } catch (e) { /* 断线了就算了，本来就不等回执 */ }
    }
    openEntry(true);      // 主菜单（入口页）
  }

  function toggleScore() {
    var box = $('#gameScore');
    box.classList.toggle('hidden');
    renderGameScore();
  }

  function closeGameUi() {
    closePick();
    hideRoundCard();
    closeOver();
    closeChainUi();
    closeSkinUi();
    $('#gameMask').classList.add('hidden');
    var hud = $('#gameHud');
    if (hud) hud.classList.add('hidden');
    var box = $('#gameScore');
    if (box) box.classList.add('hidden');
    var tip = $('#gameLockTip');
    if (tip) tip.remove();
    var input = $('#chatInput');
    if (input) input.placeholder = '说点什么…（Enter 发送，Shift+Enter 换行）';
  }

  /* ============================================================ 接龙（chain） */

  /**
   * 接龙模式下「我这一步」的题面 —— 由服务端通过私密消息 GAME_TASK 单发给我。
   *
   * 为什么不放进 GAME_STATE：那条是快照，房间里每个人都会收到一份。
   * 接龙的题面（要画的词 / 要猜的那幅画）一旦进了广播流就等于把答案摊在桌上 ——
   * 这是这个玩法唯一的死穴。所以题面走独立的一条私有消息，前端只留在这里。
   */
  function isChainMode() { return !!(S.game && S.game.mode === 'chain'); }

  /* ============================================================ ★ v14「提交后保留成图」
   *
   * 用户报的现象：交完作画 / 猜词，画布当场被清空 / 切走，看不到自己刚交的东西。
   *
   * 服务端在收格时会 `resetCanvas()`（每个作画格开始都清），**那条不许动** ——
   * 所以前端自己留一份「我刚交的那张图」，在**下一棒交接过来**（收到新题面
   * / 阶段切换）之前继续显示：
   *
   *   - 作画格交了 → 保留「我画的那张图」；猜词格交了 → 保留「我猜的那个词 + 当时看的画」。
   *   - 「下一棒」= applyChainTask 拿到**不同的**题面 key（chainId|step|word|choices）：
   *     那一刻 keep 作废，画面交给新题面（猜词的画 / 空画布）。
   *   - 拿不到新题面时（最后一步交完 → 进回放）由 renderChainReveal 接管；
   *     阶段一离开「写 / 画 / 猜」keep 也自动失效（chainKeepActive 里判）。
   *
   * 保留的画面来源：提交那一刻引擎里的笔迹（私密作画时服务端只把**我自己的**
   * 笔迹发回来，所以 engine.strokes 就是我这幅画）→ renderStrokesPNG 渲一张，
   * 喂给 #chainCanvasImg（object-fit: contain，和回放共用同一格，不裁切）。
   */
  var CHAIN_KEEP = { sig: '', img: '', text: '', word: '' };

  function resetChainKeep() {
    CHAIN_KEEP.sig = '';
    CHAIN_KEEP.img = '';
    CHAIN_KEEP.text = '';
    CHAIN_KEEP.word = '';
  }

  /** 当前这一棒的题面 key（与 applyChainTask 的去重键同一套口径） */
  function chainTaskKey() {
    var t = S.chainTask;
    if (!t) return '';
    return t.chainId + '|' + t.step + '|' + (t.word || '') + '|' + (t.choices || []).join(',');
  }

  /** 现在该不该继续显示「我刚交的那张」——
   *  还在写 / 画 / 猜里、已经交过、而且**题面还没换成下一棒**。 */
  function chainKeepActive() {
    if (!CHAIN_KEEP.img && !CHAIN_KEEP.text) return false;
    if (!isChainMode() || !chainStepActive()) return false;
    if (!S.chainInputSubmitted) return false;
    var t = S.chainTask;
    if (!t) return false;
    if (t.step !== 'DRAWING' && t.step !== 'GUESS') return false;   // 写词步不用画布
    return t.chainId + '|' + t.step === CHAIN_KEEP.sig;
  }

  /** 把「我现在画布上这一幅」渲成一张图。
   *  首选按笔迹渲（快、跟回放同一套渲染路径）；万一引擎的笔迹表还没追上
   *  （最后一笔的 STROKE_END 还在路上），退回整张画布导出 —— 宁可贵一点，
   *  也不能让「交完的成图」是空的。 */
  function chainKeepRenderOwnArt() {
    var url = '';
    try {
      var st = engine.strokes || [];
      if (st.length) url = engine.renderStrokesPNG(st, '#fff');
    } catch (e) { url = ''; }
    if (!url) {
      try { url = engine.exportPNG(); } catch (e2) { url = ''; }
    }
    return url || '';
  }

  /** 提交那一刻把「我这幅画」（/ 我猜的那个词）留下来 —— 渲失败就只留词，绝不显示半张 */
  function chainKeepCapture(t, word) {
    resetChainKeep();
    if (!t || (t.step !== 'DRAWING' && t.step !== 'GUESS')) return;
    var url = '';
    if (t.step === 'DRAWING') {
      url = chainKeepRenderOwnArt();
      CHAIN_KEEP.text = '你刚交的画';
    } else {
      // 猜词：当时看的那幅画就是题面里带的笔迹
      try {
        if (t.strokes && t.strokes.length) url = engine.renderStrokesPNG(t.strokes, '#fff');
        else url = chainTaskImage(t);
      } catch (e) { url = ''; }
      CHAIN_KEEP.text = '你猜的是';
      CHAIN_KEEP.word = asWord(word, '我猜的词');
    }
    CHAIN_KEEP.sig = t.chainId + '|' + t.step;
    CHAIN_KEEP.img = url || '';
  }

  /** 把留着的这张重新摆到画布层上（状态同步每秒都会走 renderChainTask，这里要幂等） */
  function chainKeepPaint() {
    var img = $('#chainCanvasImg');
    if (CHAIN_KEEP.img) {
      // ⚠ 别用 showChainCanvasImage：它最后会把说明挂到窄带上（猜词那条归猜题流程管）
      var layer = $('#chainCanvasLayer');
      if (layer) layer.classList.remove('hidden');
      if (img) {
        if (img.getAttribute('src') !== CHAIN_KEEP.img) img.src = CHAIN_KEEP.img;
        img.classList.remove('hidden');
      }
    } else if (img) {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
    var t = $('#cclTopText');
    if (t) {
      t.innerHTML = '<span class="ccl-note">' + esc(CHAIN_KEEP.text || '已提交') + '</span>'
        + (CHAIN_KEEP.word ? ' <b>' + esc(CHAIN_KEEP.word) + '</b>' : '');
    }
    var top = $('#cclTop');
    if (top) top.classList.remove('hidden');
    syncChainCanvasPad();
  }

  function applyChainTask(t) {
    var prev = S.chainTask;
    S.chainTask = t || null;
    // 去重键：chainId + step + 题面内容。服务端按 taskVersion 重发同一份题面
    // （重连 / RESYNC 补发），键没变就不重置「已提交」、不重响「轮到你」。
    var prevKey = prev ? prev.chainId + '|' + prev.step + '|' + (prev.word || '') + '|' + (prev.choices || []).join(',') : '';
    var nowKey = t ? t.chainId + '|' + t.step + '|' + (t.word || '') + '|' + (t.choices || []).join(',') : '';
    if (prevKey !== nowKey) {
      S.chainInputSubmitted = false;
      // ★ v14：题面换了 = **下一棒交接过来了** —— 这时候才把「我刚交的那张图」换掉。
      resetChainKeep();
      // 题面换了 = 轮到我了。这是接龙里最该被听见的一声：
      // 手里有活的人如果没注意到，这一步基本就废了（等超时才反应过来）。
      if (t && t.step) SFX.play('yourTurn');
    }
    renderChainTask();
    syncChainInput();
  }

  /** GUESS 题面的笔迹 → dataURL。只在题面到达时渲一次（把结果缓存在题面对象上） */
  function chainTaskImage(t) {
    if (!t || t.step !== 'GUESS') return '';
    if (t._img !== undefined) return t._img;
    var url = '';
    try {
      if (t.strokes && t.strokes.length) url = engine.renderStrokesPNG(t.strokes, '#fff');
    } catch (e) { url = ''; }
    // ⚠ 只有真渲出来了才缓存：这一拍引擎还没就绪的话，下一次状态同步还能补上，
    //   否则会把一次失败钉死成「上家没交」。
    if (url) t._img = url;
    return url;
  }

  /* ---- 主画布上的「这一格」层（#chainCanvasLayer） ----
   *
   * 用户的实测反馈：猜词时那幅画缩在左下角 232px 的小窗里，根本看不清；
   * 回放更糟 —— 全屏遮罩把画布整个盖住，等于「看回放的时候看不见画」。
   * 现在这一层铺在主画布上：画用 <img>（object-fit: contain），层本身 pointer-events:none。
   *
   * v11：层里是「上窄带 / 画 / 下窄带」三段 flex 列（见 index.html 注释）——
   * 词**不再用大字画在画布上**（用户问题 2），一律走上下两条 38px 的窄带。
   */

  /** 底部控制条的实际高度 → CSS 变量 --cb-h（其他贴底浮层靠它让位）。
   *  ⚠ 画布层自己**不用**再留 paddingBottom：上下窄带是 flex 列里的固定行，
   *    中间的画只吃剩下的高度，物理上不会被压住。
   *  ⚠ 上沿同理：快捷条折行 / HUD 变高时 --qb-h 会变，窄带顶部跟着 #gameHud
   *    的实际底边往下让（不然窗口一窄，上窄带就钻到 HUD 底下被盖住）。
   *  ⚠ 下沿：`.game-lock-tip`（"回放中 —— 画布暂时不能动"）是贴底居中悬浮的，
   *    它比横条还靠上，会压住画面下缘 —— 所以它露着的时候给它留出高度。 */
  function syncChainCanvasPad() {
    var h = 0;
    ['#chainInputMask', '#chainReplayBar', '#favBar'].forEach(function (sel) {
      var el = $(sel);
      if (!el || el.classList.contains('hidden')) return;
      var r = el.getBoundingClientRect();
      if (r.height > h) h = r.height;
    });
    var layer = $('#chainCanvasLayer');
    if (layer) {
      // 兜底留白：接龙状态条现在是画布上沿那条 34px 的细条（#stage.chain-strip），
      // 量不到它的实际底边时按「快捷条 + 一点余量」算，绝不让窄带/画面钻到状态条底下。
      var top = 52;
      var hud = $('#gameHud');
      if (hud && !hud.classList.contains('hidden')) {
        var hr = hud.getBoundingClientRect();
        if (hr.height > 0) top = Math.max(top, Math.round(hr.bottom + 8));
      }
      // .game-lock-tip 贴在 bottom:14px 处，所以它占掉的是「14 + 自身高度」那一条
      var tip = $('#gameLockTip');
      var bottom = 10;
      if (tip) {
        var th = tip.offsetHeight;
        var stageEl = $('#stage');
        var tipBottom = 14;
        if (stageEl) {
          var sr = stageEl.getBoundingClientRect();
          var tr = tip.getBoundingClientRect();
          if (tr.height > 0) tipBottom = Math.max(0, Math.round(sr.bottom - tr.bottom));
        }
        if (th > 0) bottom = Math.round(th + tipBottom + 8);
      }
      layer.style.paddingTop = top + 'px';
      layer.style.paddingBottom = bottom + 'px';
      // ★ v15：**不再**给 <img> 写 maxHeight —— 回放那一格现在是 flex:1 + 横向拉满
      //   （见 styles.css 的 .ccl-img），上/下窄带是列里的固定行，中间那幅画
      //   物理上吃不到它们的位置。以前那个 maxHeight 是「图片按原尺寸显示」时代的补丁，
      //   留着只会让画面比画布区矮一截、露出底下的棋盘格。
      var img = $('#chainCanvasImg');
      if (img) img.style.maxHeight = '';
    }
    // 顺手告诉 CSS：横条开着的时候，原本贴底的浮层（题面 / 进度 / 锁定提示）要抬起来
    var stage = $('#stage');
    if (stage) {
      var pad = (h > 0 ? Math.round(h) + 10 : 12) + 'px';
      stage.style.setProperty('--cb-h', pad);
      document.documentElement.style.setProperty('--cb-h', pad);
      stage.classList.toggle('chain-bar-on', h > 0);
      // ⚠ 提示气泡（#toastWrap）挂在 <body> 下，不是 #stage 的兄弟节点
      //   （老代码里那条 `#stage.replaying ~ .toast-wrap` 其实从来没生效过），
      //   所以这里在 body 上再挂一个同样的开关给它用。
      document.body.classList.toggle('chain-bar-on', h > 0);
    }
    // 改了 padding 之后 <img> 的可用高度变了，浏览器不一定会自己重排 —— 读一次强制回流
    var im = $('#chainCanvasImg');
    if (im && !im.classList.contains('hidden')) void im.getBoundingClientRect();
  }

  /** 上下两条窄带的文字（回放专用）。
   *  band==='' 表示「别动这一条」（GUESS 那条由猜题流程自己写）。 */
  function setChainCanvasBands(top, bottom) {
    var t = $('#cclTopText'), b = $('#cclBottomText');
    if (t && top !== null && top !== undefined) t.innerHTML = top;
    if (b && bottom !== null && bottom !== undefined) b.innerHTML = bottom;
    var topEl = $('#cclTop'), botEl = $('#cclBottom');
    if (topEl && top !== null && top !== undefined) topEl.classList.toggle('hidden', !top);
    if (botEl && bottom !== null && bottom !== undefined) botEl.classList.toggle('hidden', !bottom);
  }

  /** 窄带右侧那个倒计时：回放 / 投票时露出来，猜词时收掉（猜词条里自己有一个） */
  function setRpTimerVisible(on) {
    var el = $('#rpTimer');
    if (el) el.classList.toggle('hidden', !on);
  }

  /** 这一格是一幅画 */
  function showChainCanvasImage(url, tag) {
    var layer = $('#chainCanvasLayer');
    if (!layer) return;
    layer.classList.remove('hidden');
    setCclTag('');                       // 画布上不再挂任何标签
    var txt = $('#chainCanvasText');
    if (txt) { txt.textContent = ''; txt.classList.add('hidden'); }
    var img = $('#chainCanvasImg');
    if (!img) return;
    if (url) {
      img.src = url;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
      showChainCanvasText('（这一格是空的）', tag);
      return;
    }
    syncChainCanvasPad();
  }

  /** 这一格是一个词（起词 / 猜词）/ 一句说明。
   *  ⚠ v11 起**不再往画布上写大字** —— 词只出现在上下两条窄带里，
   *  这里只把说明挂到窄带上（用户问题 2：大字漂在画面上挡画）。 */
  function showChainCanvasText(text, tag) {
    var layer = $('#chainCanvasLayer');
    if (!layer) return;
    layer.classList.remove('hidden');
    setCclTag('');
    var img = $('#chainCanvasImg');
    if (img) { img.removeAttribute('src'); img.classList.add('hidden'); }
    var txt = $('#chainCanvasText');
    if (txt) { txt.textContent = ''; txt.classList.add('hidden'); }   // 画布上永远没有文字
    if (!S.cr.externalImg) setChainCanvasBands(esc(text || ''), null);
    syncChainCanvasPad();
  }

  function setCclTag(tag) {
    var el = $('#chainCanvasTag');
    if (!el) return;
    el.textContent = tag || '';
    el.classList.toggle('hidden', !tag);
  }

  function hideChainCanvas() {
    var layer = $('#chainCanvasLayer');
    // ★ v14：刚交了画 / 猜词的那张图要**继续显示到下一棒**（见 CHAIN_KEEP）——
    //   服务端收格时会 resetCanvas()，这里的隐藏动作必须让路，否则用户交完就看不到自己的图了。
    if (chainKeepActive()) return;
    // ⚠ 回放 / 投票阶段这一层归 renderChainReveal 管：状态同步每秒钟来好几次，
    //   每次都会走一遍 renderChainTask()（那一刻 chainStepActive() 是 false），
    //   以前这里会把回放正演到一半的逐笔动画直接掐掉 —— 实测就是「一格只画出 1 帧」的元凶。
    //   （先判后停：连 crStopAnim 都不能碰，否则定时器一被清掉动画就永远停在第一帧。）
    var bar = $('#chainReplayBar');
    if (bar && !bar.classList.contains('hidden')) return;
    // ★ 最终结算的「点赞最多的画」也占着这一层：状态同步每秒都会走一遍 renderChainTask()，
    //   不挡住的话，刚铺上去的那幅大图会被一秒清一次（表现为「闪一下就没了」）。
    if (FAV.active) return;
    crStopAnim();
    if (!layer || layer.classList.contains('hidden')) return;
    layer.classList.add('hidden');
    var img = $('#chainCanvasImg');
    if (img) { img.removeAttribute('src'); img.style.maxHeight = ''; }
    var txt = $('#chainCanvasText');
    if (txt) txt.textContent = '';
    setChainCanvasBands('', '');
    setRpTimerVisible(false);
    S.cr.externalImg = false;
    syncChainCanvasPad();
  }

  function renderChainTask() {
    var box = $('#chainTask');
    if (!box) return;
    syncChainWriteStep();     // 写词步的「画布腾出来 + 选词区居中」开关（其余阶段一律关）
    // ★ v17：**不在回放 / 投票阶段 → 投票纸片与那排圈一律收掉**。
    //   以前没人收：上一局投完的那张纸片一直挂在画布层里，新一局一开
    //   （画布层为了显示「我刚交的画」又被显示出来）那张纸片就跟着冒出来了 ——
    //   用户截图里「新开的一局游戏出现上局的投票窗口」就是这个。状态同步每次都走这里，
    //   所以放在 early return 之前，任何阶段都收得住。
    if (!S.game || (S.game.phase !== 'chain_reveal' && S.game.phase !== 'chain_vote')) crHideVotePaper();
    var t = S.chainTask;
    // 只有「做事」的阶段才有题面；大厅/回放/投票/结算都不显示这块
    if (!isChainMode() || !t || !chainStepActive()) {
      box.classList.add('hidden');
      hideChainCanvas();      // 题面一收，铺在画布上的那一格也跟着收
      return;
    }
    box.classList.remove('hidden');
    var body = $('#ctBody');
    var label = $('#ctStep');
    // 写词步：题面卡片居中（选词区），画布腾出来 —— 见 CSS 的 .chain-task.ct-centered
    box.classList.toggle('ct-centered', t.step === 'WORD');
    if (t.step === 'WORD') {
      // 「写起词」这句话在整页只出现这一处（卡片标题），下面的说明只说后果
      label.textContent = '写一个起词';
      hideChainCanvas();
      if (S.chainInputSubmitted) {
        body.innerHTML = '<div class="ct-done">✓ 已提交，等其他人</div>';
        return;
      }
      body.innerHTML = '<div class="ct-note">挑一个起词 —— <b>你自己要照它作画</b>：</div>' +
        '<div class="ct-choices"></div>';
      var list = body.querySelector('.ct-choices');
      (t.choices || []).forEach(function (w) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-choice';
        b.textContent = w;
        b.addEventListener('click', function () { submitChainWord({ text: w }); });
        list.appendChild(b);
      });
      var own = document.createElement('button');
      own.type = 'button';
      own.className = 'ct-choice';
      own.innerHTML = '<span style="color:var(--text-dim)">✎ 自己写一个…</span>';
      own.addEventListener('click', function () {
        var w = (prompt('写一个词') || '').trim();
        if (w) submitChainWord({ text: w });
      });
      list.appendChild(own);
      return;
    }
    if (t.step === 'DRAWING') {
      // 这一步的词永远来自 S.chainTask.word：画自己写的起词时它就是本人刚写下的那个词
      label.textContent = '照这个词作画';
      if (S.chainInputSubmitted) {
        // ★ v14：交了作品之后**画面继续留着**（下一棒交接 / 收格 resetCanvas 都不动它）
        body.innerHTML = '<div class="ct-done">✓ 已交作品</div><div class="ct-word">' + esc(t.word || '') + '</div>';
        if (chainKeepActive()) chainKeepPaint(); else hideChainCanvas();
        return;
      }
      hideChainCanvas();
      body.innerHTML = '<div class="ct-draw-head">照这个词画出来：</div>' +
        '<div class="ct-word">' + esc(t.word || '（空）') + '</div>' +
        '<div class="ct-note">直接在画布上画（别人看不到你的笔迹），画完点下面；倒计时到点会自动交。</div>' +
        '<button class="btn primary ct-submit">画好了，交上去</button>';
      body.querySelector('.ct-submit').addEventListener('click', submitChainArt);
      return;
    }
    if (t.step === 'GUESS') {
      label.textContent = '这幅画画的是什么？';
      if (S.chainInputSubmitted) {
        // ★ v14：交完猜词 → **把猜的那个词 + 当时看的那幅画继续留着**，直到下一棒。
        body.innerHTML = '<div class="ct-done">✓ 已提交，等其他人</div>';
        S.cr.externalImg = false;
        if (chainKeepActive()) chainKeepPaint(); else hideChainCanvas();
        return;
      }
      // 要猜的那幅画铺在主画布上（不再挤在这张小卡片里）；
      // 题面那一行也走画布**下沿的窄带**（不再往画面中间写大字），卡片只留操作。
      S.cr.externalImg = true;
      setRpTimerVisible(false);
      var img = chainTaskImage(t);
      var lay0 = $('#chainCanvasLayer');
      if (lay0) lay0.classList.remove('hidden');
      var im0 = $('#chainCanvasImg');
      if (img) {
        showChainCanvasImage(img, '');
      } else if (im0) {
        im0.removeAttribute('src');
        im0.classList.add('hidden');
      }
      setChainCanvasBands(img ? '看画猜词 · 上家画的这一幅' : '（上一格是空的 —— 上家没交）', '');
      syncChainCanvasPad();
      // ★ v15：**「这幅画画的是什么? + 回答」那张卡片删掉了**（用户实测：多一层点击、
      //   还占着画布下沿的一块地方）。猜词要的输入条本来就在画布下沿，
      //   直接让它出现 —— 题面「看图猜词：上面这幅画的是什么？」也只在它上面出现一次
      //   （见 syncChainInput），卡片再写一遍就是同一句话第四遍。
      //   ⚠ 只在这里收掉卡片（不隐藏整个 #chainTask 容器）：
      //     「✓ 已提交，等其他人」那条回执仍然走上面那个分支显示，交完不至于毫无反馈。
      box.classList.add('hidden');
      syncChainInput();
      return;
    }
    box.classList.add('hidden');
    hideChainCanvas();
  }

  /** 现在是不是「写词 / 画 / 猜」这三种要动手的阶段 */
  function chainStepActive() {
    var p = S.game ? S.game.phase : '';
    return p === 'chain_write' || p === 'chain_draw' || p === 'chain_guess';
  }

  /**
   * 写词步（chain_write）给 #stage 挂一个开关类 `.chain-task-write`。
   *
   * 为什么要有它：这一步**根本不用画**（选完词才进作画），但画布 + 浮动层原本还整块
   * 摊在中间，用户看到的是一张空画布中间挤着选词卡片 —— 空间全浪费了。
   * 挂上这个类之后 CSS 会把画布层收掉、并把选词卡片居中放大（见 styles.css）。
   * 其余阶段（作画 / 猜词 / 回放）一个字都不动，卡片照旧贴边。
   */
  function syncChainWriteStep() {
    var stage = $('#stage');
    if (!stage) return;
    var on = !!(isChainMode() && S.game && S.game.phase === 'chain_write');
    stage.classList.toggle('chain-task-write', on);
  }

  function submitChainWord(payload) {
    if (!payload || !payload.text) return;
    // ⚠ 顺序同 submitChainArt：先立旗再留成图（否则 renderChainTask 会当场收掉画布）
    S.chainInputSubmitted = true;
    // ★ v14：把「我猜的词 + 当时看的那幅画」留下来（交完继续显示到下一棒）
    chainKeepCapture(S.chainTask, payload.text);
    net.send(P.C2S.GAME_SUBMIT, payload);
    SFX.play('submit');
    renderChainTask();
    closeChainInput();
  }

  /**
   * 交作品（DRAWING 格）：发一个「画好了」的信号即可 ——
   * 笔迹早在下笔时就按 STROKE_* 进了房间笔迹表（私密作画期不广播但都入库），
   * 服务端收格时按作者从表里摘取。v9 起不再导 PNG 整图上交：
   * 回放能按真实笔序重演，也不再受「导出瞬间画布状态」的干扰。
   */
  function submitChainArt() {
    var t = S.chainTask;
    if (!t || t.step !== 'DRAWING') return;
    if (S.chainInputSubmitted) return;
    // ⚠ 顺序要紧：先立「已提交」这面旗，再留成图 —— chainKeepActive() 会看这面旗，
    //   反过来写的话 renderChainTask() 会以为「还没交」，当场把画布收掉。
    S.chainInputSubmitted = true;
    // ★ v14：把这张画渲下来留着（交完继续显示到下一棒交接）
    chainKeepCapture(t, '');
    net.send(P.C2S.GAME_SUBMIT, {});
    SFX.play('submit');
    renderChainTask();
    toast('作品已交给下一位', 'ok', 2600);
  }

  /* ---- 猜词的输入条（贴画布下沿，和画同时可见） ---- */

  function syncChainInput() {
    var bar = $('#chainInputMask');
    if (!bar) return;
    var t = S.chainTask;
    var show = !!(t && t.step === 'GUESS' && chainStepActive() && !S.chainInputSubmitted);
    bar.classList.toggle('hidden', !show);
    if (!show) {
      // 画布上那一格归 renderChainTask / renderChainReveal 管，这里只重算留白
      syncChainCanvasPad();
      return;
    }
    // ★ 「看图猜词：上面这幅画的是什么？」**只在这一个地方出现**（输入条上方）。
    //   以前它同时出现在：画布上沿窄带、题面卡片、输入条标题、页面底部锁定提示 —— 同一句话四遍。
    $('#ciTitle').textContent = '看图猜词：上面这幅画的是什么？';
    // 猜词不卡字数、不卡中英文 —— 只要能被下一个人看懂就够了
    $('#ciHint').textContent = '猜一个词（英文、单字都行，不用管字数）';
    var inp = $('#ciInput');
    if (document.activeElement !== inp) inp.focus();
    updateChainInputPreview();
    // 画在上面、输入条在下面：先量出横条实际高度，再给画布层留位
    syncChainCanvasPad();
    updateGameTimer();
  }

  function openChainGuess() {
    S.chainInputSubmitted = false;
    syncChainInput();
    var inp = $('#ciInput');
    if (inp) inp.focus();
  }

  function closeChainInput() {
    var bar = $('#chainInputMask');
    if (bar) bar.classList.add('hidden');
    syncChainCanvasPad();
  }

  function updateChainInputPreview() {
    var inp = $('#ciInput');
    var pv = $('#ciPreview');
    if (!inp || !pv) return;
    var v = inp.value.trim();
    if (!v) { pv.textContent = ''; return; }
    if (v.length > 20) { pv.innerHTML = '<span class="bad">太长了（最多 20 字）</span>'; return; }
    // 出题那一步才卡「能玩的词」；猜词是自由输入，别拦标点，也别提字数要求。
    // 规则和前端的词库自检 / 服务端是同一条（protocol.isPlayableWord）。
    // ⚠ 题面在 S.chainTask 里（S.game 那条广播快照没有 task 字段）——
    //   以前写成 S.game.task，这个分支从来没生效过。
    var isWrite = !!(S.chainTask && S.chainTask.step === 'WORD');
    if (isWrite && !P.isPlayableWord(v, 12)) {
      pv.innerHTML = '<span class="bad">别带空格写，1~12 个字符</span>';
      return;
    }
    pv.textContent = v.length + ' 个字';
  }

  function doChainGuessSubmit() {
    var inp = $('#ciInput');
    if (!inp) return;
    var v = inp.value.trim();
    if (!v) return;
    submitChainWord({ text: v });
    inp.value = '';
    updateChainInputPreview();
  }

  /* ---- 分组（v12）----
   *
   * 服务端的规矩（见 server/src/chain.js groupCountFor）：
   *   4~6 人 = 1 组（等于以前，什么分组都没有）；7~10 = 2 组；11~12 = 3 组；13~16 = 4 组；
   *   每组一个环、组内传遍，链长 = 2 × 该组人数。
   *
   * 前端只做两件事：
   *   ① 把「为什么你只跟这几个人互传」讲清楚（大厅 + 进度面板各一行）
   *   ② **1 组时一个字都不显示** —— 那是老玩法，多出来的文案只会是噪音
   *
   * 大厅阶段服务端还没分组（groups 是开局时才 planGroups 出来的），
   * 所以这里额外支持「按人数预告」：知道会分成几组、本组大概几人，
   * 但**不编造第几组**（分到哪一组是开局随机洗的，猜出来就是骗人）。
   */

  /** 人数 → 组数（与 server/src/chain.js 的 groupCountFor 同一张表，用于大厅预告） */
  function expectedGroupCount(n) {
    n = n | 0;
    if (n >= 13) return 4;
    if (n >= 11) return 3;
    if (n >= 7) return 2;
    return 1;
  }

  /**
   * 从快照里取「我这一组」的信息。**全字段容错**：拿不到就返回 null（= 不显示分组）。
   * @returns {null|{count:number,index:number,size:number,length:number,total:number,known:boolean}}
   */
  function chainGroupInfo(g) {
    if (!g) return null;
    var players = (g.players || []).filter(function (p) { return !p.spectating; });
    var total = players.length;
    var count = Number(g.groupCount);
    if (!isFinite(count) || count <= 0) count = 0;
    var groups = Array.isArray(g.groups) ? g.groups : [];
    if (!count && groups.length) count = groups.length;
    // 1 组 = 没有分组：一律不显示（这是用户明确要的「别出声」）
    if (count < 2) return null;
    if (!total) {
      total = groups.reduce(function (a, x) { return a + (Number(x && x.size) || 0); }, 0);
    }
    var idx = Number(g.myGroupIndex);
    if (!isFinite(idx) || idx < 0) idx = -1;
    var mine = idx >= 0 ? (groups[idx] || null) : null;
    var size = mine ? Number(mine.size) : Number(g.groupSize);
    if (!isFinite(size) || size <= 0) {
      size = total > 0 ? Math.max(1, Math.round(total / count)) : 0;
    }
    // 本组链长：优先看这一组自己的 chainLength，其次 groupLengths[idx]，最后退回 2 × 本组人数
    var len = mine ? Number(mine.chainLength) : NaN;
    if (!isFinite(len) || len <= 0) {
      var gl = Array.isArray(g.groupLengths) ? Number(g.groupLengths[idx]) : NaN;
      if (isFinite(gl) && gl > 0) len = gl;
    }
    if (!isFinite(len) || len <= 0) len = size > 0 ? size * 2 : 0;
    return {
      count: count,
      index: idx >= 0 ? idx + 1 : 0,      // 0 = 还不知道自己是第几组（大厅）
      known: idx >= 0,
      size: size,
      length: len,
      total: total
    };
  }

  /** 分组说明的两种措辞：大厅（可能还不知道第几组）与进度面板（一定知道） */
  function groupTextLobby(info) {
    if (!info) return '';
    var head = (info.total > 0 ? info.total + ' 人' : '全场') + '分成 <b>' + info.count +
      ' 组</b>，各自传各自的链';
    if (info.known) {
      return head + ' —— 你在<b>第 ' + info.index + ' / ' + info.count + ' 组</b>（本组 ' +
        info.size + ' 人 · 本组链长 ' + info.length + ' 手）';
    }
    // 大厅：分组是开局随机洗的，这里只说规模，不编第几组
    return head + ' —— 开局后才知道你在第几组（本组约 ' + info.size + ' 人 · 链长约 ' + info.length + ' 手）';
  }
  function groupTextHud(info) {
    if (!info) return '';
    if (info.known) {
      return '第 <b>' + info.index + ' / ' + info.count + ' 组</b> · 本组 ' + info.size +
        ' 人 · 本组链长 ' + info.length + ' 手';
    }
    return info.count + ' 组并行 · 本组约 ' + info.size + ' 人';
  }

  /** 把一行分组文案写进某个节点（info 为空 = 收起来 + 清空，绝不留半截文字） */
  function paintGroupLine(sel, html) {
    var el = $(sel);
    if (!el) return;
    if (html) {
      el.innerHTML = html;
      el.classList.remove('hidden');
    } else {
      el.innerHTML = '';
      el.classList.add('hidden');
    }
  }

  /* ---- 链条进度面板（多链并行：全场同一格，只报「第几手 / 交了几份」，不含内容） ---- */

  function renderChainProgress() {
    var box = $('#chainProgress');
    if (!box) return;
    var g = S.game;
    var playingPhase = g && (g.phase === 'chain_init' || g.phase === 'chain_write' ||
      g.phase === 'chain_draw' || g.phase === 'chain_guess');
    if (!isChainMode() || !playingPhase) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    // 分组说明（v12）：多组时告诉玩家「你只跟本组的人互传」，1 组时整行收掉
    paintGroupLine('#cpGroups', groupTextHud(chainGroupInfo(g)));
    var list = $('#cpList');
    var len = Math.max(1, g.chainLength || 1);
    var k = g.stepIndex | 0;
    var dots = '';
    for (var i = 0; i < len; i++) {
      // 用「步」的类型给点上色：写词蓝 / 作画绿 / 猜词黄（0 是写词，奇数作画、偶数猜词）
      var cls = 'cp-dot';
      if (i < k) cls += (i === 0) ? ' filled' : (i % 2 === 1 ? ' draw' : ' guess');
      if (i === k) cls += ' now';
      dots += '<i class="' + cls + '"></i>';
    }
    var stepName = g.phase === 'chain_write' ? '写初始词'
      : g.phase === 'chain_draw' ? '照词作画' : g.phase === 'chain_guess' ? '看画猜词' : '马上开始';
    // ★ v17：传词接龙时把玩法也写出来（免得玩家以为是接龙模式、等自己画）
    if (g.chainPlay === 'relay') stepName = '传词接龙 · ' + stepName;
    list.innerHTML =
      '<div class="cp-row mine">' +
      '<span class="cp-name">' + stepName + ' · 第 ' + Math.min(k + 1, len) + ' / ' + len + ' 手</span>' +
      '<span class="cp-dots">' + dots + '</span></div>' +
      '<div class="cp-row"><span class="cp-name">已交 ' + (g.stepDone | 0) + ' / ' + (g.stepTotal || 0) + ' 份</span>' +
      '<span class="cp-note">' + (g.myDone ? '你已交 ✓' : (g.myStep ? '等你交' : '这一格没有你的事')) + '</span></div>';
  }

  /* ---- 接龙大厅（lobby 阶段的小面板：名单 + 准备按钮） ---- */

  function renderChainLobby() {
    var box = $('#chainLobby');
    if (!box) return;
    var g = S.game;
    var show = !!(isChainMode() && g && g.phase === 'lobby');
    // ⚠ 分组那一行要跟着大厅一起收：大厅关着的时候它是死的
    if (!show) { paintGroupLine('#clGroups', ''); }
    box.classList.toggle('hidden', !show);
    if (!show) return;
    // ★ v17：**「准备」面板只列房间里真正在的人** ——
    //   服务端的 players 里除了在场成员，还会带「已离场但榜上有分」的灰名
    //   （那是给计分板用的，人走了分数还要在），以前这里照单全收，
    //   于是大厅上冒出几个房间里根本不存在的人（用户报的）。计分板照旧显示灰名。
    var players = (g.players || []).filter(function (p) { return p.online !== false; });
    var playing = players.filter(function (p) { return !p.spectating; });
    // ★ v17：大厅标题写明玩法（接龙 / 传词接龙），免得大家开局前不知道要不要自己画
    var head = box.querySelector('.cl-head');
    if (head && head.firstChild && head.firstChild.nodeType === 3) {
      head.firstChild.nodeValue = (g.chainPlay === 'relay' ? '传词接龙大厅 · ' : '接龙大厅 · ');
    }
    var cnt = $('#clCount');
    if (cnt) cnt.textContent = playing.length + ' 人（需 ≥ ' + (g.minPlayers || 4) + '）';
    // 分组说明：服务端分了组就报真的（「你在第 X / Y 组」）；
    // 大厅阶段还没分组，就按人数预告「会分成几组、本组大概几人」。
    var ginfo = chainGroupInfo(g);
    if (!ginfo) {
      var exp = expectedGroupCount(playing.length);
      if (exp >= 2) {
        var each = Math.max(1, Math.round(playing.length / exp));
        ginfo = { count: exp, index: 0, known: false, size: each, length: each * 2, total: playing.length };
      }
    }
    paintGroupLine('#clGroups', groupTextLobby(ginfo));
    var html = '';
    players.forEach(function (p) {
      html += '<span class="cl-player' + (p.spectating ? ' spec' : '') + (p.ready ? ' ready' : '') + '">' +
        '<i class="dot" style="background:' + esc(p.color || '#9aa0a8') + '"></i>' +
        esc(p.name) + (p.spectating ? '（观战）' : (p.ready ? ' ✓' : '')) + '</span>';
    });
    var list = $('#clPlayers');
    if (list) list.innerHTML = html || '<span class="cl-player">（还没有人）</span>';
    var btn = $('#btnChainReady');
    if (btn) {
      btn.textContent = g.myReady ? '取消准备' : '准备';
      btn.classList.toggle('primary', !g.myReady);
      btn.classList.toggle('ghost', !!g.myReady);
      btn.disabled = !!g.spectating;
    }
    var hint = $('#clHint');
    if (hint) {
      var left = Math.max(0, (g.minPlayers || 4) - playing.length);
      hint.textContent = g.spectating
        ? '你是这一局进来的 —— 先观战，下一局自动入伙'
        : left > 0 ? '还差 ' + left + ' 人才能开局'
        : '全员就绪自动开局；房主也能用「立刻推进」强制开局';
    }
  }

  /* ---- 回放播放器 + 投票 ----
   *
   * v9 的回放是「播放器」而不是「一屏摊开」：
   *   S.chainReveal —— 服务端 GAME_REVEAL 广播的完整链条（N 条 × 每链 len 格），
   *                    一次性收到后客户端自给自足，翻页/播放不再打扰服务端。
   *   S.cr          —— 播放器状态：第几条链 / 第几格 / 自动播放 / 速度 / 定时器。
   *
   * 每条链按格序演：词（起词）→ 画（整图淡入，笔迹在本地按需渲染）→ 猜词 → …
   * VOTE 阶段给两票：keep（这条链首尾对得上吗，对当前链）+ fav（最喜欢的一张画，
   * 画格上的 ♥ 按钮）。
   */

  /** 播放器的翻格定时器：换链 / 关面板时必须清掉，否则会翻新链的格子 */
  function crClearTimer() {
    if (S.cr.timer) { clearTimeout(S.cr.timer); S.cr.timer = null; }
  }

  /* ---- 回放：逐笔动画 ----
   *
   * 服务端给的 legHoldMs = 这一格的**总时长**（动画 + 定格），且**已经算进回放倍速**
   * （服务端 revealLegMs() = 总时长 / 格数 / 倍速）。这里把它拆开：
   *   动画占用 min(60% × 总时长, 8000ms)，剩下的时间用来定格看结果（最少 250ms）。
   * ★ v14：前端**不再**乘界面上的倍速（那个控件已经删掉）—— 时长完全对齐 legHoldMs。
   * 所以「服务端腿短 → 动画自动加速、腿长 → 慢放」，两端都有上下限，不会一帧画完或卡住。
   *
   * 逐笔的实现：**不用 renderStrokesPNG 那种「一次渲完整张」**，而是自己维护一张离屏
   * 小画布（最长边 760px —— toDataURL 是同步的，全尺寸每帧编码会卡），每帧只把这一批
   * 新笔迹用 engine.replayStampOne 叠上去（增量绘制，不重画前面的笔），再 toDataURL 喂给
   * #chainCanvasImg。所以帧与帧之间的画**一定不一样** —— 看得见一笔一笔长出来。
   */
  var CR_ANIM = {
    minTotal: 600, maxTotal: 20000, minAnim: 700, maxAnim: 9000, hold: 250,
    targetFrames: 18,
    // ★ 2.0.9：到点了还没画完时用的「加速尾巴」——剩下的笔按每笔 ≤60ms 补完，
    //   最多补 320ms。宁可稍微超一点时间，也不能「啪的一下」把剩下的笔一次贴上去。
    catchUpMs: 320,
    catchUpPerStroke: 60,
    // ★ v15：作画格后面紧跟猜词格时，尾巴上留给「下一棒猜的是什么」的悬念倒计时。
    //   与服务端 CFG.REVEAL_TEASE_MS 同一个数（服务端把这段加进那一格的时长里）。
    teaseMs: 3000,
    // ★ v16：没有悬念尾的作画格，成图之后定格的时长（与服务端 REVEAL_HOLD_MS 同档）
    tailHoldMs: 600
  };

  /** 服务端下发的回放游标（可能还没落地 —— 拿不到就返回 null，退回本地逐格播放） */
  function crServerStep() {
    var g = S.game;
    if (!g) return null;
    var v = g.revealStep;
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : null;
  }
  function crServerLegs() {
    var g = S.game;
    if (!g) return 0;
    var v = g.revealLegs;
    if (typeof v === 'number' && isFinite(v) && v > 0) return Math.floor(v);
    var n = Number(v);
    return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
  }
  /** 回放：**当前这一格**的总时长（毫秒）。带上下限。
   *
   *  ★ v15：每一格的时长**不再一样**了 —— 服务端随快照下发 legMs（每条链一张表：
   *  起词 / 猜词格只停 1.4 秒、作画格吃「回放总时长 / 格数 / 倍速」的预算，
   *  下一格是猜词的作画格再多 3 秒悬念尾）。这里优先按 S.cr.item 取表里的那一格，
   *  拿不到（老服务端 / 假快照）才退回单一的 legHoldMs。
   *  快慢仍然由服务端的倍速算进这两者里，前端不再乘任何本地倍速。 */
  function crLegTotalMs() {
    var g = S.game;
    var base = NaN;
    var arr = g && g.legMs;
    if (arr && typeof arr.length === 'number' && arr.length) {
      var v = Number(arr[Math.max(0, Math.min(S.cr.item | 0, arr.length - 1))]);
      if (isFinite(v) && v > 0) base = v;
    }
    if (!isFinite(base) || base <= 0) base = Number(g && g.legHoldMs);
    if (!isFinite(base) || base <= 0) base = 3600;
    return Math.max(CR_ANIM.minTotal, Math.min(CR_ANIM.maxTotal, Math.round(base)));
  }
  /** 这一格用来播逐笔动画的时间。
   *
   *  ★ v16：**动画吃满「这一格的总时长 − 尾巴」** —— 尾巴 = 下一格是猜词时的 3 秒悬念
   *  倒计时，否则只是一小段定格。总时长是服务端按**笔数 ÷ 倍速**算出来的（见
   *  P.chainRevealAnimMs），所以这里减掉尾巴就等于「按倍速把笔迹播完，播完即定稿」，
   *  不再有「小图也播八秒」那种按比例摊出来的空转。 */
  function crLegAnimMs(total, reserve) {
    var hold = Math.max(0, Number(reserve) || CR_ANIM.tailHoldMs);
    return Math.max(300, Math.min(CR_ANIM.maxAnim, total - hold));
  }
  function crStopAnim() {
    var a = S.cr.anim;
    if (a) {
      a.gen++;
      if (a.raf) cancelAnimationFrame(a.raf);
      if (a.tickTimer) clearInterval(a.tickTimer);
      if (a.safety) clearTimeout(a.safety);
      a.raf = 0;
      a.tickTimer = 0;
      a.safety = 0;
      a.tease = false;
    }
    // ★ v15：悬念倒计时是「这一格」的一部分，停动画就一起停
    crStopTease();
  }
  /** 一格切换时清掉上一格的画面缓存（逐笔是现画的，留着只会占内存） */
  function crDropLegCaches(item) {
    if (!item) return;
    try { delete item._png; delete item._frames; } catch (e) { /* 无所谓 */ }
  }
  /** 逐笔动画用的离屏画布 —— **两张**（★ v15 修的就是这里）。
   *
   *  a.raw = 引擎**原尺寸**画布：笔迹按 1:1 落上去，和作画时看到的一模一样。
   *  a.cv  = 显示用的缩略图（最长边 ≤ 900）：每帧把 raw 整幅 drawImage 缩下来再 toDataURL，
   *          这样「每帧同步编码」的开销还在小画布上。
   *
   *  ⚠ 以前只有 a.cv 一张缩小的画布，指望 `ctx.setTransform(scale…)` 把笔迹缩进去 ——
   *    但 engine.replayStampOne 内部的 paintOnto 头一件事就是 setTransform(1,0,0,1,0,0)
   *    （见 engine.js 的 paintOnto），缩放当场被抹掉：笔迹按 1:1 落进 900px 的小画布，
   *    于是回放画面成了「原图左上角的放大版」，右边 / 下边被裁掉 —— 用户报的截图
   *    「回放没有展示完全」就是这个。现在缩放只走 drawImage，绝不再依赖 transform。 */
  function crAnimCanvas() {
    var a = S.cr.anim;
    var W = (engine && engine.width) || 1280;
    var H = (engine && engine.height) || 800;
    var sc = Math.min(1, 900 / Math.max(W, H));
    var w = Math.max(64, Math.round(W * sc));
    var h = Math.max(64, Math.round(H * sc));
    if (a.cv && a.raw && a.w === w && a.h === h && a.raw.width === W && a.raw.height === H) {
      return a.cv;
    }
    var raw = document.createElement('canvas');
    raw.width = W; raw.height = H;
    a.raw = raw;
    a.rawCtx = raw.getContext('2d');
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    a.cv = cv; a.ctx = cv.getContext('2d');
    a.w = w; a.h = h;
    a.scale = sc;
    a.done = 0;          // 换了画布 = 之前落的笔都不在了，从头补
    return cv;
  }

  /** 把两张画布都抹成白底（= 这一格还没开始画的画面）并刷新显示。
   *  ★ v16：接管画布时显示走引擎（replayCanvas → 真画布），否则退回 <img>。 */
  function crResetAnimCanvas() {
    var a = S.cr.anim;
    if (!a.ctx || !a.rawCtx || !a.raw) crAnimCanvas();
    if (a.rawCtx) {
      a.rawCtx.setTransform(1, 0, 0, 1, 0, 0);
      a.rawCtx.fillStyle = '#fff';
      a.rawCtx.fillRect(0, 0, a.raw.width, a.raw.height);
    }
    if (a.ctx) {
      a.ctx.setTransform(1, 0, 0, 1, 0, 0);
      a.ctx.fillStyle = '#fff';
      a.ctx.fillRect(0, 0, a.w, a.h);
    }
    a.canvasBlank = true;
    if (crCanvasOwned()) engine.invalidate();
    else crShowImage(a.cv ? a.cv.toDataURL('image/png') : '');
  }

  /** 回放数据就位（GAME_REVEAL 到达 / 迟到补发）。开着的播放器保持当前页。 */
  function applyChainReveal(chains) {
    S.chainReveal = chains || [];
    if (S.cr.chain >= S.chainReveal.length) { S.cr.chain = 0; S.cr.item = 0; }
    renderChainReveal();
  }

  /** 播放器主体：REVEAL / VOTE 阶段打开并渲染当前格；其他阶段收起来。
   *
   *  v10：不再用 #replayMask 那个全屏遮罩 —— 当前格摊在 #chainCanvasLayer（主画布区），
   *  控制条 / 首尾对照 / 投票都收进贴底的 #chainReplayBar。
   *  另外：**只演服务端指定的那一条链**（voteChainId），跨链翻页整个去掉。
   *
   *  v11：格内是**逐笔动画**（见 crStartAnim）；「现在第几格」以服务端 revealStep 为准
   *  （拿不到就退回本地逐格播放）。上下两条窄带写「谁画了什么 / 谁猜的是什么」。
   */
  function renderChainReveal(skipChrome) {
    var g = S.game;
    var list = S.chainReveal;
    var show = !!(g && (g.phase === 'chain_reveal' || g.phase === 'chain_vote') && list && list.length);
    if (!show) { hideChainReplayBar(); return; }
    // ★ v14：回放 / 投票阶段由这一层接管画面 —— 「我刚交的那张」到此为止（不再往画布上贴）。
    //   没有这一句的话：最后一步交完 → hideChainCanvas() 因为 keep 生效而提前 return，
    //   画布层就横在回放画面上面（实测会把 #chainCanvasImg 整个挡掉）。
    resetChainKeep();
    // ★ v16：**画面画在真画布上**（用户：「就在现成的画布区域展示，别弄个独立窗口」）——
    //   接管引擎的回放显示位，把那块白面板 <img> 收掉。退出见 hideChainReplayBar。
    crCanvasTake();
    crHideImg();

    // 服务端说了现在是哪条链 —— 前端跟着走（voteChainIndex 是串行投票的游标）
    var ci = currentChainIndex();
    var chain = list[ci];
    var items = chain ? (chain.steps || []) : [];
    var switched = (S.cr.chain !== ci) || (S.cr.chainId !== chain.chainId);
    if (switched) {
      crClearTimer();
      crStopAnim();
      S.cr.chain = ci;
      S.cr.chainId = chain.chainId;
      // 回放：从头逐格演，自动播；投票：停在最后一格，让人盯着首尾做判断
      S.cr.playing = (g.phase === 'chain_reveal');
      S.cr.item = (g.phase === 'chain_vote') ? Math.max(0, items.length - 1) : 0;
      S.cr.serverStep = crServerStep();
      // ★ v14：换链 = 重新数「定格到几秒后弹投票纸片」（每条链各定格一次）
      resetVotePaper();
    }

    // 棒次跟着服务端走：revealStep 变了就切到那一格（并重新播动画）。
    // 服务端还没下这个字段时 crServerStep() 返回 null —— 这条整段跳过，用本地逐格播放。
    var srv = crServerStep();
    var srvLegs = crServerLegs();
    var stepChanged = false;
    if (srv !== null && srv !== S.cr.serverStep) {
      S.cr.serverStep = srv;
      if (srv !== S.cr.item) { S.cr.item = srv; stepChanged = true; }
    }
    if (srvLegs && g.phase === 'chain_reveal' && S.cr.item >= srvLegs - 1) S.cr.playing = false;

    S.cr.item = Math.max(0, Math.min(S.cr.item | 0, Math.max(0, items.length - 1)));

    var bar = $('#chainReplayBar');
    if (bar) bar.classList.remove('hidden');
    setChainStrip();
    if (!skipChrome) {
      setChainCtlVisible(true);
      $('#rpTitle').textContent = g.phase === 'chain_vote' ? '投票' : '回放';
      // 房主的「立刻推进」：REVEAL→进投票 / VOTE→结算（SCORE 时服务端自动回大厅，不给按钮）
      var nextBtn = $('#btnRpNext');
      if (nextBtn) {
        nextBtn.classList.toggle('hidden', !S.me.isOwner ||
          (g.phase !== 'chain_reveal' && g.phase !== 'chain_vote'));
        nextBtn.textContent = (g.phase === 'chain_vote') ? '立刻结算' : '进入投票';
      }

      // 头部：第几条链 / 起词人（跨链的小点去掉了 —— 看哪条链由服务端说了算）
      var n = list.length;
      $('#rpIndex').textContent = (ci + 1) + ' / ' + n;
      var head = $('#rpChainHead');
      head.innerHTML = '第 ' + (ci + 1) + ' 条链 · 起词人 <b>' +
        esc(safeName(chain.ownerName, '链主名字')) + '</b>' +
        (chain.ownerPlayerId === S.me.userId ? '<span class="rp-mine">我的</span>' : '');
      head.classList.remove('rp-in');
      void head.offsetWidth;          // 强制回流，动画才能重播
      renderRpPills(items);
    }

    // 首尾对照：REVEAL 阶段演到最后一格才揭晓（提前亮出来就剧透了）；
    // VOTE 阶段常驻 —— 投票时要盯着「起词 → 最后猜出来的词」判断对得上吗。
    if (!skipChrome) {
      renderRpVerdict(g, chain, items);
      renderChainVoteArea(chain);
    }

    // 这一格的内容（词条 / 逐笔动画）—— 换格 / 换链 / 改速度时都要重来一遍
    crMarkExternal(false);
    setRpTimerVisible(true);
    var a = S.cr.anim;
    var prevItem = a.item;
    var sameLeg = !switched && !stepChanged && a.chain === ci && a.item === S.cr.item;
    var el = sameLeg ? (Date.now() - a.startAt) : 0;
    crApplyLeg(ci, S.cr.item, items[S.cr.item] || null, el);

    if (!skipChrome) {
      syncChainCanvasPad();
      updateGameTimer();
    }
    // ⚠ 只有在**真的翻了一格**（含服务端推进 / 换链）时才重排节奏。
    //   以前这里是「每次状态同步都 crScheduleNext」—— 定时器被一路重置，
    //   本地播放永远等不到自己那一拍（服务端推得快时表现为「定格时间忽长忽短」）。
    if (S.cr.playing && g.phase === 'chain_reveal' &&
      (switched || stepChanged || prevItem !== S.cr.item)) crScheduleNext();
  }

  /** 控制条里的小点：每格一个，点小点跳格（链内翻格保留） */
  function renderRpPills(items) {
    var pills = '';
    for (var q = 0; q < items.length; q++) {
      pills += '<i class="rp-pill' + (q === S.cr.item ? ' on' : (q < S.cr.item ? ' past' : '')) +
        '" data-item="' + q + '"></i>';
    }
    var box = $('#rpPills');
    if (box) box.innerHTML = pills;
  }

  /** 走完最后一格 / 投票阶段才揭晓的首尾对照。
   *  ★ v14：问句与两个按钮搬进画布中央的「纸片」面板（#rpVote）了 —— 这里只留
   *  「起词 → 最终猜词」这条流水（下沿窄带里常驻，投票时也看得见）。 */
  function renderRpVerdict(g, chain, items) {
    var verdict = $('#rpVerdict');
    if (!verdict) return;
    var atEnd = S.cr.item >= items.length - 1;
    if (g.phase === 'chain_vote' || atEnd) {
      verdict.innerHTML =
        '<span class="rv-a">起词 <b>' + esc(safeWord(chain.firstWord, '首尾对照的起词')) + '</b></span>' +
        '<b class="rv-arrow">→</b>' +
        '<span class="rv-b">最终猜词 <b>' + esc(safeWord(chain.lastWord, '首尾对照的最终猜词')) + '</b></span>' +
        '<span class="rv-tag ' + (chain.matched ? 'ok">√ 对得上' : 'bad">× 对不上') + '</span>';
      verdict.classList.toggle('ok', !!chain.matched);
      verdict.classList.toggle('bad', !chain.matched);
    } else {
      verdict.innerHTML = '';
      verdict.classList.remove('ok', 'bad');
    }
  }

  /** 收起回放条（回放数据没了 / 阶段过去了 / 最终结算交给奖杯弹窗） */
  function hideChainReplayBar() {
    crClearTimer();
    crStopAnim();
    // ★ v16：把引擎的回放显示位还回去（回放结束 / 阶段过去了，画布该显示文档本身了）
    crCanvasRelease();
    resetVotePaper();
    // ★ v17：纸片 / 已投标记一并收掉（以前这里只收了标记，纸片会留到下一局）
    crHideVotePaper();
    S.cr.playing = false;
    var bar = $('#chainReplayBar');
    if (bar) bar.classList.add('hidden');
    renderChainVoteMarks(null);
    setChainStrip();
    syncChainCanvasPad();
  }

  /** 服务端指定「现在看/投的是哪条链」在 S.chainReveal 里的下标。
   *  按链串行是服务端的规矩（voteChainId 权威，voteChainIndex 兜底），
   *  前端只渲染这一条 —— 所以没有「翻到别的链」这条路。 */
  function currentChainIndex() {
    var g = S.game, list = S.chainReveal;
    if (!g || !list || !list.length) return 0;
    if (g.voteChainId) {
      for (var i = 0; i < list.length; i++) if (list[i].chainId === g.voteChainId) return i;
    }
    var k = Number(g.voteChainIndex);
    if (isFinite(k) && k >= 0 && k < list.length) return k;
    return Math.max(0, Math.min(S.cr.chain | 0, list.length - 1));
  }

  /* ---- 单格：上/下两条窄带的文案 ---- */

  /** 猜题流程摆的画（回放别去动它的词条窄带） */
  function crMarkExternal(on) { S.cr.externalImg = !!on; }

  /**
   * 把一格的内容安全地取成「词」。
   *
   * ⚠ 这里以前直接 `esc(prev.content)`，结果作画格的 content（**笔迹数组**）被塞进
   *   「猜的是：」那一行 → 界面上显示成
   *   `友友791 猜的是：[object Object],[object Object]`（用户报的 P0）。
   *   规矩：**只有字符串才当词**，其余一律当作「没有」并报一条错误日志 ——
   *   宁可显示「（空）」，也绝不把对象 toString 到界面上。
   */
  function asWord(v, where) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    console.error('[chain] 期望是词，拿到的是 ' + (Array.isArray(v) ? '数组' : typeof v)
      + '（' + where + '）—— 已按「空」处理，不渲染对象');
    return '';
  }

  /**
   * ★ v14：显示层的**兜底断言** —— 所有「要当词渲染」的字段都必须过这里。
   *
   * 与 asWord 的区别只有一个：**渲染**（这个返回「（空）」而不是空串），
   * 因为调用点大多是 `esc(x || '（空）')` 这种写法，把兜底收进来更不容易漏。
   * 非字符串一律 console.error 报出**字段名**，绝不把对象 toString 到界面上
   *（用户报过的 `[object Object]` 就是这么来的：笔迹数组被当成词）。
   */
  function safeWord(v, where) {
    var w = asWord(v, where || '未标注字段');
    return w || '（空）';
  }

  /** 人名 / 昵称的兜底（「某人」）。不是字符串一律 console.error 后回退 —— 同样的规矩。 */
  function safeName(v, where) {
    if (typeof v === 'string' && v) return v;
    if (v != null && typeof v !== 'string') {
      console.error('[chain] 期望是名字，拿到的是 ' + (Array.isArray(v) ? '数组' : typeof v)
        + '（' + (where || '未标注字段') + '）—— 已按「某人」处理');
    }
    return '某人';
  }

  function crLegLabels(items, k) {
    var it = items[k];
    var prev = k > 0 ? items[k - 1] : null;
    if (!it) return { top: '', bottom: '' };
    var who = esc(it.playerName || '某人');
    var top;
    if (it.type === 'WORD') {
      top = '<b>' + who + '</b> 起词：<span class="ccl-w">' + esc(asWord(it.content, 'WORD') || '（空）') + '</span>';
    } else if (it.type === 'DRAWING') {
      // 作画格「画了：X」里的 X = 他**拿到的题面**，也就是上一格的 content。
      // 上一格只可能是 WORD 或 GUESS（都是词），但照样过 asWord 兜一层。
      var w = prev ? asWord(prev.content, 'DRAWING 的题面') : '';
      top = '<b>' + who + '</b> 画了：<span class="ccl-w">' + esc(w || '（空）') + '</span>';
    } else {
      // ★ 猜词格「猜的是：X」里的 X = **他自己猜出来的词（本格 content）**。
      //   以前错写成上一格的 content，而上一格是作画格、content 是笔迹数组
      //   → 界面上就是 [object Object],[object Object]。
      var q = asWord(it.content, 'GUESS');
      top = '<b>' + who + '</b> 猜的是：<span class="ccl-w">' + esc(q || '（空）') + '</span>';
    }
    var nx = items[k + 1];
    var bottom = '';
    if (nx && nx.type === 'GUESS') {
      // ★ v15：用户要的顺序是「**笔迹回放完了**再显示『下一棒 X 猜的是：』+ 3 秒倒计时」——
      //   所以回放进行中这一行只说一句「回放中」，**既不报词也不报倒计时**；
      //   笔一画完，crStartTease() 会把它换成悬念倒计时（词仍然只在那一格的上窄带里揭晓）。
      //   窄带本身留着（不清空）是为了不让画面在换文案时弹一下高度。
      bottom = '<span class="ccl-note">笔迹回放中…</span>';
    } else if (nx) {
      // 下一格是作画（最后一格后面没有了也算）—— 这一行没有「猜」可报
      bottom = '<span class="ccl-note">下一个：<b>' + esc(nx.playerName || '某人') + '</b> ' +
        (nx.type === 'DRAWING' ? '照这个词作画' : '写起词') + '</span>';
    }
    return { top: top, bottom: bottom };
  }

  /* ---- ★ v15：作画格播完 →「下一棒猜的是什么」的悬念倒计时 ----
   *
   * 用户实测：以前每一格都占同样长的时间，起词格 / 猜词格没东西可看也干等，
   * 而「下一棒猜的是什么」又提前写在下窄带里，等于没悬念。
   * 现在服务端把这段尾留给作画格（legMsAt 里加的 REVEAL_TEASE_MS），前端在这段时间里：
   *   笔迹播完 → 响一声 tease()（抽气）→ 倒数 3 / 2 / 1（每声 countTick）→
   *   下一格（猜词格）开始放时响 reveal()（惊喜），词同时在上窄带里出现。
   * 倒计时只会读数字，**绝不**提前把词写出来 —— 词只有一个来源：那一格自己的上窄带。 */
  function crStopTease() {
    if (S.cr.teaseTimer) { clearInterval(S.cr.teaseTimer); S.cr.teaseTimer = 0; }
    S.cr.teaseLeft = 0;
    S.cr.teaseName = '';
  }
  /** 悬念那一行的文案：「下一棒 <人> 猜的是：<读数>」——**只有这一处**会写出这句话 */
  function crTeaseText(name, n) {
    return '<span class="ccl-note">下一棒</span> <b>' + esc(safeName(name, '下一棒的名字')) +
      '</b> 猜的是：<span class="ccl-cd" id="cclCount">' + (n > 0 ? String(n) : '？') + '</span>';
  }
  function crPaintCount(n) {
    setChainCanvasBands(null, crTeaseText(S.cr.teaseName, n));
    var el = $('#cclCount');
    if (!el) return;
    el.classList.remove('pulse');
    void el.offsetWidth;              // 强制回流，动画才会重播
    el.classList.add('pulse');
  }
  function crStartTease() {
    var a = S.cr.anim;
    if (!a || !a.tease) return;
    if (!S.game || S.game.phase !== 'chain_reveal') return;
    var items = (S.chainReveal && S.chainReveal[S.cr.chain] && S.chainReveal[S.cr.chain].steps) || [];
    var nx = items[S.cr.item + 1];
    // 剩多少时间 = 这一格的总时长 - 笔迹动画已经用掉的
    var used = Math.max(0, Date.now() - (a.startAt || Date.now()));
    var leftMs = Math.max(0, (a.dur || 0) - used);
    var left = Math.max(1, Math.min(3, Math.round(leftMs / 1000)));
    crStopTease();
    S.cr.teaseName = (nx && nx.playerName) || '某人';
    S.cr.teaseLeft = left;
    crPaintCount(left);
    SFX.play('tease');
    S.cr.teaseTimer = setInterval(function () {
      if (!S.game || S.game.phase !== 'chain_reveal') { crStopTease(); return; }
      S.cr.teaseLeft -= 1;
      if (S.cr.teaseLeft <= 1) {
        crPaintCount(1);
        if (S.cr.teaseTimer) { clearInterval(S.cr.teaseTimer); S.cr.teaseTimer = 0; }
        return;
      }
      crPaintCount(S.cr.teaseLeft);
      SFX.play('countTick', { n: S.cr.teaseLeft });
    }, 1000);
  }

  /* ---- 逐笔动画 ---- */

  /** 让第 (ci, k) 格成为「当前格」，并按已播时长 el 把它放到该有的进度上。
   *  同一格没播完就再进来（一次状态同步）→ 从 el 接着画，不重头来。 */
  function crApplyLeg(ci, k, item, el) {
    var a = S.cr.anim;
    var items = (S.chainReveal && S.chainReveal[ci] && S.chainReveal[ci].steps) || [];
    var lab = crLegLabels(items, k);
    var total = crLegTotalMs();
    // ★ v15：下一格是猜词 → 这一格的尾巴要留给悬念倒计时，动画只能占剩下的时间
    var nextIsGuess = !!(items[k + 1] && items[k + 1].type === 'GUESS');
    var animMs = crLegAnimMs(total, nextIsGuess ? CR_ANIM.teaseMs : CR_ANIM.tailHoldMs);
    var strokes = (item && item.type === 'DRAWING' && Array.isArray(item.content)) ? item.content : null;

    if (a.chain === ci && a.item === k && !a.finished) {
      a.dur = total; a.animMs = animMs;
      if (el >= animMs || !strokes || !strokes.length) { crFinishAnim(); return; }
      return;                                     // 动画正在跑，别打断
    }
    if (a.chain === ci && a.item === k && a.finished) {
      // 这一格刚才已经演完了（一次状态同步又进来）—— 只补词条，画面别动，
      // 否则每次状态同步都会把定格画面重画一遍。
      // ★ v15：如果这一格的悬念倒计时正走着，别把它覆盖掉（下窄带要留住读数）
      setChainCanvasBands(lab.top,
        (a.tease && S.cr.teaseLeft > 0) ? crTeaseText(S.cr.teaseName, S.cr.teaseLeft) : lab.bottom);
      // ★ v16：进投票那一刻，最后一格常常是**猜词格**（没画）—— 回放期间它是空白，
      //   这里补上「这一格往前最近的那幅画」，把最后一棒的成图留在画布上（用户要求）。
      if (crCanvasOwned()) {
        var isArt0 = !!(item && item.type === 'DRAWING' && Array.isArray(item.content) && item.content.length);
        if (!isArt0) crCanvasShowArt(items, k - 1);
      }
      return;
    }

    // 换格：停掉上一格，从头开始
    crStopAnim();
    crStopTease();
    a.gen++;
    crDropLegCaches(item);
    a.chain = ci; a.item = k;
    a.strokes = strokes;
    a.done = 0; a.frame = 0;
    a.pics = [];                  // 这一格逐笔画出来的每一帧（自测看这个）
    a.steps = 0;
    a.startAt = Date.now() - Math.max(0, el | 0);
    a.finished = false;
    a.dur = total;
    a.animMs = animMs;
    a.tease = nextIsGuess;
    setChainCanvasBands(lab.top, lab.bottom);
    // ★ v15：猜词格一开始放就**揭晓**（惊喜音）—— 上窄带里的「<人> 猜的是：<词>」
    //   正是刚刚数完倒计时的那个答案，音画同一下。
    if (item && item.type === 'GUESS' && el < 400) SFX.play('reveal');

    if (!item) { crCanvasShowArt(items, k - 1); a.finished = true; return; }

    // GUESS 格在回放里不铺大字（词在上窄带里）——
    // 画面留白，把注意力交给上一条窄带说的「他猜的是什么」。
    // ★ v16：画布这块**不留白**了 —— 用户要「投票阶段底下保留最后一棒成图，不必清除」，
    //   而且整场回放都画在真画布上（crCanvasTake），词格 / 猜词格就把**最近的那幅画**
    //   整幅留在画布上：一条链的最后一格常常是猜词格（5 步链就是），
    //   以前进投票时画布是空白，投票的人只能盯着纸片回忆刚才那幅画。
    if (item.type !== 'DRAWING') {
      crCanvasShowArt(items, k);
      a.finished = true; return;
    }

    if (!strokes || !strokes.length) {
      setChainCanvasBands(lab.top + ' <span class="ccl-note">（这一格没有交画）</span>', lab.bottom);
      crCanvasShowArt(items, k - 1);
      a.finished = true;
      return;
    }

    crResetAnimCanvas();                               // 白底先顶上，免得露出上一格
    if (el >= animMs) { crFinishAnim(); return; }      // 页面被切走又切回来：直接给定格画面
    crStartLoop();
    // 兜底：定时器万一被节流（后台标签页），也不能卡在「画了一半」。
    // ★ 2.0.9：留出加速尾巴那点时间（catchUpMs），别在补笔补到一半时抢先把剩下的笔一次贴完。
    a.safety = setTimeout(crFinishAnim, Math.max(60, animMs - el + CR_ANIM.catchUpMs + 200));
  }

  /** 每帧只把「这一帧该出现的新笔」叠上去（增量，不重画前面的）。
   *
   *  节奏按**时间**算，不按帧数算：这样服务端给的 legHoldMs 短 → 每笔之间的间隔自动变短，
   *  长 → 变慢，而「一笔一笔长出来」这件事始终成立。
   *
   *  ⚠ 两条踩过的坑：
   *  1) 不能写成「每帧至少推进一笔」—— rAF 一秒能跑 60 帧，那样 3 笔的画面会在 30ms
   *     内画完，看起来就是一次性贴上去。
   *  2) 不能只靠 requestAnimationFrame 驱动 —— 接龙回放里服务端每秒都会推 GAME_STATE，
   *     每次状态同步都可能 cancel 掉在飞的那一帧（实测：一格只画出 1 帧就没了）。
   *     所以用 40ms 的 **setInterval** 当主驱动，rAF 只是「顺手多画一帧」的补充。
   *  帧数上限 18：每帧一次 toDataURL 是同步的，笔特别多时按时间均分。 */
  function crStartLoop() {
    var a = S.cr.anim;
    if (a.tickTimer) return;
    a.tickTimer = setInterval(crAnimTick, 40);
    a.raf = requestAnimationFrame(crAnimTick);
  }

  function crStopLoop() {
    var a = S.cr.anim;
    if (a.raf) { cancelAnimationFrame(a.raf); a.raf = 0; }
    if (a.tickTimer) { clearInterval(a.tickTimer); a.tickTimer = 0; }
  }

  function crAnimTick() {
    var a = S.cr.anim;
    if (!a || !a.strokes) return;
    var el = Date.now() - a.startAt;
    crDrawTo(el);
    // ★ 2.0.9：收尾的时机
    //   · 正常情况：到点（animMs）且笔都画完了 → 定格。**不能提前收** ——
    //     「播完了」这件事还管着下一棒的悬念倒计时什么时候开始（见 crStartTease），
    //     早收 300ms 就等于倒计时早开始 300ms，和服务端那一格的节奏对不上。
    //   · 落后（窗口紧 / 掉过帧）：crDrawTo 会用加速尾巴一笔一笔补完，
    //     最多补 CR_ANIM.catchUpMs —— 补完就收，实在补不完也在尾巴末尾收，
    //     绝不把剩下的笔一次贴上去（用户：「不能啪的一下就跳到成图了」）。
    if (el >= a.animMs && (a.done >= a.strokes.length || el >= a.animMs + CR_ANIM.catchUpMs)) crFinishAnim();
  }

  /** 按「已经过了多少毫秒」决定现在该出现几笔 */
  function crDrawTo(el) {
    var a = S.cr.anim;
    if (!a || !a.strokes || !a.strokes.length) return;
    var n = a.strokes.length;
    // ★ 2.0.9：帧预算**跟着笔数走**，不再写死 18 帧。
    //
    //   以前 frames = min(笔数, 18)：一张 40 笔的图只切 18 个时间片，
    //   到点（animMs）时前 18 笔还在慢慢长，剩下 22 笔被 crFinishAnim **一次全补上** ——
    //   用户原话：「笔迹回放时间不够的时候，要自适应进行倍速播放，不能啪的一下就跳到成图了」。
    //   现在每一笔都有自己的时间片：窗口长就一笔一笔慢慢长（≈每笔 240ms），
    //   窗口紧就每拍多画几笔（就是倍速），**任何情况下都不会「前面慢慢来、最后一次性贴上去」**。
    //   ⚠ 只有退回 <img> 那条老路才保留 18 帧上限 —— 那条路每帧一次同步 toDataURL，很贵。
    var frames = crCanvasOwned() ? n : Math.min(n, CR_ANIM.targetFrames);
    var per = a.animMs / Math.max(1, frames);          // 每个时间片代表多久
    var want = Math.max(1, Math.ceil(el / per));       // 至少给 1 笔，第一帧别是纯白
    // ★ 2.0.9：到点了却还没画完（窗口紧 / 中间掉过帧）——这里是第二个「啪的一下」的来源：
    //   旧代码不管落后多少，都由 crFinishAnim 把剩下的笔一次性补上。
    //   现在改成**加速补完**：每 60ms 至少补一笔，最多补 320ms。
    if (el >= a.animMs && a.done < n) {
      var extra = Math.ceil((el - a.animMs) / CR_ANIM.catchUpPerStroke) + 1;
      want = Math.max(want, Math.min(n, a.done + extra));
    }
    want = Math.min(n, want);
    if (want > a.done) crDrawUpTo(want);
  }

  /** 收尾：把剩下的笔一次画完、定格（并把生成号推进，旧的帧回调自己退出） */
  function crFinishAnim() {
    var a = S.cr.anim;
    if (!a || a.finished) return;     // 已经是定格状态：别再推 gen / 改 startAt
    crStopLoop();
    if (a.strokes && a.strokes.length) crDrawUpTo(a.strokes.length);
    if (a.safety) { clearTimeout(a.safety); a.safety = 0; }
    a.finished = true;
    a.gen++;                      // 还在飞的 rAF / 兜底定时器下次进来就对不上 gen，自己退出
    a.startAt = Date.now();       // 重新计时 = 定格时间从「画完」这一刻算起
    a.landedAt = Date.now();      // 本地兜底节奏：这一格「最短定格」从这一刻起算
    a.framesAll = (a.framesAll | 0) + (a.frame | 0);   // 累计「逐笔画出过多少帧」（自测看这个）
    // ★ v19：这一格**播完了** —— 重画一次投票区。
    //   以前这里顺带把 ♥ 置灰（「过时不候」，还特意不等状态同步、要立刻灰掉，
    //   免得「刚放完」那一瞬间还点得动）；现在改成「每一棒展示期间都能投」，
    //   播完不再关这一格的门，♥ 的可用性只看 crLegFavOpen()：
    //   S.cr.item 还停在这一格，就照样点得动。
    if (S.game && S.game.phase === 'chain_reveal') {
      var chain = S.chainReveal && S.chainReveal[S.cr.chain];
      if (chain) renderChainVoteArea(chain);
      // ★ v15：画播完了 → 如果下一格是猜词，就在这里起悬念倒计时
      //   （「下一棒 X 猜的是：」+ 3 → 2 → 1，词等那一格开始放才揭晓）
      crStartTease();
    }
  }

  /* ★ 2.0.9：逐笔回放节奏的**调试入口**（给 tools/test-chain-anim.js 用）。
   *
   * 真流程里这一格是由「GAME_REVEAL 快照 + revealStep」驱动的，测试想验
   * 「回放时间不够的时候会不会啪的一下跳到成图」就得能直接喂一串笔迹 + 一段时长。
   * 这里只负责把 S.cr.anim 摆成「某一格刚开始」的样子，之后跑的完全是
   * crStartLoop / crAnimTick / crDrawTo 那套真代码 —— 没有第二份实现。
   */
  function chainAnimDebugStart(strokes, animMs) {
    var a = S.cr.anim;
    crStopAnim();
    crCanvasTake();
    a.gen++;
    a.chain = S.cr.chain | 0;
    a.item = S.cr.item | 0;
    a.strokes = strokes || [];
    a.done = 0; a.frame = 0; a.pics = []; a.steps = 0;
    a.startAt = Date.now();
    a.finished = false;
    a.dur = Math.max(1, Number(animMs) || 1000);
    a.animMs = Math.max(1, Number(animMs) || 1000);
    a.tease = false;
    crResetAnimCanvas();
    crStartLoop();
    a.safety = setTimeout(crFinishAnim, a.animMs + CR_ANIM.catchUpMs + 200);
    return true;
  }
  function chainAnimDebugStop() {
    crStopAnim();
    crCanvasRelease();
  }

  /** 把「总共 upTo 笔」画进**引擎尺寸的帧画布**（a.raw）。
   *  ★ v16：这块画布现在是**引擎自己的回放画布**（engine.replayCanvas）——
   *  用户的原话：「笔迹回放就在现成的画布区域展示得了呗，为啥非要弄个独立窗口出来呢」，
   *  所以不再走「缩成一张 PNG 喂给 <img>」，而是每画出一批笔就 engine.invalidate()，
   *  由引擎把这块画布**照常经过视口变换**画到真画布上 —— 和作画时同一块画布、同一个缩放，
   *  屏幕上不会再出现第二个「窗口」。
   *  ⚠ 笔迹只落在 a.raw（1:1，paintOnto 会把 transform 重置，缩放绝不能靠 transform —— 见 crAnimCanvas）。 */
  function crDrawUpTo(upTo) {
    var a = S.cr.anim;
    if (!a || !a.rawCtx || !a.raw || !a.strokes) return;
    var strokes = a.strokes;
    var upto = Math.max(a.done, Math.min(strokes.length, upTo | 0));
    a.rawCtx.setTransform(1, 0, 0, 1, 0, 0);
    for (var i = a.done; i < upto; i++) {
      var s = strokes[i];
      try { engine.replayStampOne(a.rawCtx, a.raw, s); } catch (e) { /* 单笔坏了别拖垮整幅 */ }
    }
    var grew = upto > a.done;
    a.done = upto;
    a.canvasBlank = false;
    a.frame++;
    // 「这一格又长出新笔」的次数（逐笔动画的硬指标，自测/探针都读它）
    if (grew) a.steps = (a.steps | 0) + 1;
    // 指纹：从帧画布里抽一小块像素算个 hash（比每帧 toDataURL 便宜得多，语义一样：
    // 画面变了它就变）。自测靠它断言「同一格里的画面确实一帧一帧在变」。
    var fp = '';
    try {
      var sc = a.rawCtx.getImageData(0, 0, Math.min(64, a.raw.width), Math.min(40, a.raw.height)).data;
      var hh = 0;
      for (var q = 0; q < sc.length; q += 17) hh = (hh * 31 + sc[q]) | 0;
      fp = hh + ':' + upto;
    } catch (e) { fp = ''; }
    if (fp) {
      if (!a.pics) a.pics = [];
      if (a.pics[a.pics.length - 1] !== fp) a.pics.push(fp);
    }
    // ★ v16：显示交给引擎 —— 它把 replayCanvas 画到真画布上（走当前视口变换）
    if (crCanvasOwned()) {
      engine.invalidate();
    } else {
      // 兜底：没接管画布时（老路径 / 假快照）还是缩一张 PNG 喂给 <img>
      if (!a.ctx) crAnimCanvas();
      a.ctx.setTransform(1, 0, 0, 1, 0, 0);
      a.ctx.fillStyle = '#fff';
      a.ctx.fillRect(0, 0, a.w, a.h);
      try { a.ctx.drawImage(a.raw, 0, 0, a.w, a.h); } catch (e) { /* 画布被回收 */ }
      var url = '';
      try { url = a.cv.toDataURL('image/png'); } catch (e) { url = ''; }
      if (url) crShowImage(url);
    }
  }

  /** 把一张图（或空）摆到画布层中间那一格。
   *  ★ v16：回放期间**不再走这里**（那时画面由引擎画在真画布上，见 crCanvasTake）——
   *  这条路只留给猜词步的「上家那幅画」、刚交完作品的成图、以及点赞最多的画。 */
  function crShowImage(url) {
    var layer = $('#chainCanvasLayer');
    if (layer) layer.classList.remove('hidden');
    var img = $('#chainCanvasImg');
    if (!img) return;
    if (url) {
      img.src = url;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
  }

  /** 回放期间把 <img> 收掉 —— 画面这时候在真画布上，不该再多一块白面板 */
  function crHideImg() {
    var img = $('#chainCanvasImg');
    if (!img) return;
    img.removeAttribute('src');
    img.classList.add('hidden');
  }

  /* ---- ★ v16：回放**画在真画布上**（用户：「就在现成的画布区域展示，别弄个独立窗口」）----
   *
   * 引擎本来就有这条路：`replayMode = true` 时，画布那一帧画的就是 `engine.replayCanvas`
   * （引擎尺寸的整幅图），而且**照常经过视口变换**（见 engine.js 的 render：
   * `if (this.replayMode && this.replayCanvas) ctx.drawImage(this.replayCanvas, 0, 0)`）。
   *
   * 于是：把逐笔帧画布直接交给引擎当 replayCanvas，每画出一批笔 invalidate 一次 ——
   * 回放画面就和作画时**同一块画布、同一个缩放**，屏幕上不会再出现第二个「窗口」，
   * 也不会被缩成小图（多大由用户当前的视图决定，他也随时能缩放/平移着看）。
   *
   * 用完把引擎原来的回放状态原样还回去（万一用户自己正开着「回放」看历史笔迹）。
   */
  function crCanvasOwned() { return S.cr.canvasOwner === 'chain'; }

  function crCanvasTake() {
    if (!engine || !engine.width) return null;
    var a = S.cr.anim;
    if (!crCanvasOwned()) {
      S.cr.canvasPrev = { mode: !!engine.replayMode, canvas: engine.replayCanvas || null };
      S.cr.canvasOwner = 'chain';
    }
    // 画面现在归引擎画了，但那一层里的**上下窄带 + 投票纸片**还得露出来
    // （以前是 crShowImage 顺手把层显示的，改成画在画布上之后要自己来）
    var layer = $('#chainCanvasLayer');
    if (layer) layer.classList.remove('hidden');
    crAnimCanvas();                       // 保证 a.raw 是引擎尺寸的帧画布
    engine.replayCanvas = a.raw;
    engine.replayMode = true;
    engine.invalidate();
    return a.raw;
  }

  function crCanvasRelease() {
    if (!crCanvasOwned()) return;
    var prev = S.cr.canvasPrev || {};
    engine.replayCanvas = prev.canvas || null;
    engine.replayMode = !!prev.mode;
    S.cr.canvasOwner = '';
    S.cr.canvasPrev = null;
    engine.invalidate();
  }

  /** 把「这条链到第 k 格为止最近的一幅画」整幅（不带动画）铺到帧画布上 ——
   *  词格 / 猜词格、以及投票阶段都靠它，免得画布空着（用户：「投票阶段底下保留最后一棒成图」）。 */
  function crCanvasShowArt(items, k) {
    var a = S.cr.anim;
    if (!crCanvasOwned() || !a.rawCtx) return false;
    var art = null;
    for (var i = Math.min(k | 0, (items || []).length - 1); i >= 0; i--) {
      var it = items[i];
      if (it && it.type === 'DRAWING' && Array.isArray(it.content) && it.content.length) { art = it; break; }
    }
    if (!art) { crResetAnimCanvas(); return false; }
    crResetAnimCanvas();
    a.strokes = art.content;
    a.done = 0;
    crDrawUpTo(art.content.length);
    a.finished = true;
    return true;
  }

  function isChainVote() { return !!(S.game && S.game.phase === 'chain_vote'); }

  /** 我在 VOTE 阶段把「最喜欢的一张」投在了这条链的这一格吗 */
  function isMyFav(ci, si) {
    var f = S.game && S.game.myFav;
    var chain = S.chainReveal && S.chainReveal[ci];
    return !!(f && chain && f.chainId === chain.chainId && f.step === si);
  }

  /** 我一共给几条链投过 ♥（v12 是「一人 × 每条链一票」）。
   *  服务端字段名是 favVotedCount；老名字 myFavCount 也认；都没有就从 myFavMap 数。 */
  function favVotedCountOf(g) {
    if (!g) return 0;
    var v = g.favVotedCount;
    if (typeof v !== 'number' || !isFinite(v)) v = g.myFavCount;
    if (typeof v === 'number' && isFinite(v)) return Math.max(0, v | 0);
    var m = g.myFavMap;
    if (m && typeof m === 'object') { try { return Object.keys(m).length; } catch (e) { return 0; } }
    return 0;
  }

  /** 这条链上我投过 ♥ 没有（只认服务端的 myFav，投过就高亮/标「已投」） */
  function chainFavMine(chain) {
    var f = S.game && S.game.myFav;
    return !!(f && chain && f.chainId === chain.chainId);
  }

  /**
   * 某一格画**正在展示**（回放播放 / 定格），♥ 就可以投。
   *
   * ★ v19：不再要求「动画还没播完」。
   * 以前是「那一格播完立刻置灰（过时不候）」，实际用起来是：手速跟不上回放，
   * 只有链首那几棒来得及点，后面的棒次根本投不上（用户反馈）。
   * 现在改成「**每一棒展示期间都能投**」——只要这一格还停在屏幕上就一直能 ♥，
   * 换到下一格（S.cr.item 走了）才关门。判据仍绑在动画对象上，
   * 所以「票投给的是不是屏幕上这一幅画」这件事没变。
   */
  function crLegFavOpen() {
    var g = S.game;
    if (!g || g.phase !== 'chain_reveal') return false;
    var chain = S.chainReveal && S.chainReveal[S.cr.chain];
    var item = chain && chain.steps && chain.steps[S.cr.item];
    if (!item || item.type !== 'DRAWING' || !Array.isArray(item.content) || !item.content.length) return false;
    var a = S.cr.anim;
    if (!a || a.chain !== S.cr.chain || a.item !== S.cr.item) return false;
    return true;
  }

  /** ★ v17：把投票纸片 + 那排投票圈整块收掉。
   *
   *  为什么单独立一个函数：以前「离开投票」这条路只收了下面的标记（renderChainVoteMarks(null)），
   *  **纸片（#rpVote）没人收** —— 它一直挂在画布层里，新一局开始、画布层为了显示
   *  「我刚交的画」又被显示出来时，上一局那张投票纸片就跟着冒出来了
   *  （用户报的「新开的一局游戏会出现上局的投票窗口」）。
   *  收的时候连着两个按钮一起隐藏 + 置灰，不留「灰着但还能点」的假象。 */
  function crHideVotePaper() {
    var box = $('#rpVote');
    if (box) box.classList.add('hidden');
    var bad = $('#rpVoteBad'), ok = $('#rpVoteOk');
    if (bad) { bad.classList.add('hidden'); bad.disabled = true; }
    if (ok) { ok.classList.add('hidden'); ok.disabled = true; }
    resetVotePaper();
    renderChainVoteMarks(null);
  }

  /* ---- 纸片投票面板的视觉零件（撕边 + 手绘圈） ----
   *
   * 用户给的参照图：一张**撕下来的纸**，边缘是不规则撕痕（不是圆角矩形），
   * 纸面有横向扫描线；按钮是**手绘圈**（✗ 红圈在左、✓ 绿圈在右），
   * 卡片下方再一排手绘圈表示「谁投了哪边」。
   *
   * 为什么用 CSS clip-path 的 polygon 而不是 SVG 撕纸边框：
   *   纸片的内容（起词 / 猜词 / 两个按钮）全在 HTML 里，用 clip-path 裁一下
   *   就能得到撕痕，**不用把内容塞进 <foreignObject>**（那样字号、点击、
   *   文本断言都会变脆）。手绘圈的圈本身才用内联 SVG —— 那是纯画。
   */

  /** 伪随机（固定种子）：同一台机器每次刷新撕痕形状一样，测试截图可复现 */
  function prand(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * 生成一条**撕痕**多边形的 clip-path（百分比坐标，跟随元素尺寸）。
   *
   * 做法：四条边各取若干采样点，沿边行走时让「沿边方向」和「垂直方向」都抖一点，
   * 抖动幅度 1.2%~2.6% —— 太小看不出撕痕、太大会啃掉纸上的字。四个角一定有顶点。
   */
  var TORN_CLIP = null;
  function tornPaperClip() {
    if (TORN_CLIP) return TORN_CLIP;
    var rnd = prand(20240414);
    var pts = [];
    var N = 13;                                  // 每条边的采样段数
    function jitter(base, amp) { return base + (rnd() * 2 - 1) * amp; }
    var i, t;
    for (i = 0; i < N; i++) {                    // 上边：左 → 右
      t = i / N;
      pts.push(jitter(t * 100, 1.4).toFixed(2) + '% ' + jitter(1.6, 1.6).toFixed(2) + '%');
    }
    for (i = 0; i < N; i++) {                    // 右边：上 → 下
      t = i / N;
      pts.push(jitter(98.4, 1.6).toFixed(2) + '% ' + jitter(t * 100, 1.4).toFixed(2) + '%');
    }
    for (i = 0; i < N; i++) {                    // 下边：右 → 左
      t = i / N;
      pts.push(jitter(100 - t * 100, 1.4).toFixed(2) + '% ' + jitter(98.4, 1.6).toFixed(2) + '%');
    }
    for (i = 0; i < N; i++) {                    // 左边：下 → 上
      t = i / N;
      pts.push(jitter(1.6, 1.6).toFixed(2) + '% ' + jitter(100 - t * 100, 1.4).toFixed(2) + '%');
    }
    TORN_CLIP = 'polygon(' + pts.join(',') + ')';
    return TORN_CLIP;
  }

  /** 给一张纸挂上撕痕（一次性，元素尺寸变了也不用重算 —— 百分比坐标） */
  function applyTornPaper(el) {
    if (!el || el.dataset.torn === '1') return;
    try {
      el.style.clipPath = tornPaperClip();
      el.style.webkitClipPath = tornPaperClip();
      el.dataset.torn = '1';
    } catch (e) { /* 老内核不支持 clip-path：退化成矩形纸，不算事故 */ }
  }

  /**
   * 手绘圈（内联 SVG）：不规则椭圆 + 圈里一个 ✓ / ✗，下面一行小字标签。
   * 圈是一条闭合三次贝塞尔，四个手柄故意不对称 —— 看着就是手画的；
   * dasharray 86/4 + 走一遍 dashoffset 的动画 = 「圈被随手画出来」的一下。
   * ⚠ 标签写在 SVG 里（而不是按钮的 textContent）是刻意的：
   *   按钮的 textContent 会因此自带「✓ √ 对得上」/「✗ × 跑偏了」，
   *   自动化断言（和屏幕阅读器）拿到的就是完整的一句话。
   */
  var SKETCH_CACHE = {};
  /** pending=true 时画一个**空圈**（浅灰虚线、不打勾不打叉）—— 「这个人还没投」。
   *  参照图里那一排圈是 ✓✓✓✗✗，但**开投时空着的位置也要占一个圈**，
   *  不然「谁还没投」只能靠人数猜（用户 v15 明确要求「显示全部玩家所投票」）。 */
  function sketchDisk(ok, size, label, pending) {
    var key = (pending ? 'wait' : (ok ? 'ok' : 'bad')) + '|' + size + '|' + (label || '');
    if (SKETCH_CACHE[key]) return SKETCH_CACHE[key];
    var s = size || 26;
    var c = pending ? '#9aa4b2' : (ok ? '#2f8f4e' : '#d6453c');
    var mark = pending ? '' : (ok
      // ✓：两笔，第二笔长一点、往下探，像随手打的对勾
      ? '<path d="M8.6 13.4 c 2.2 1.8 3.4 3.1 4.3 4.9 c 1.6 -4.4 4.1 -7.7 6.6 -10.1"'
        + ' fill="none" stroke="' + c + '" stroke-width="2.1" stroke-linecap="round"'
        + ' stroke-linejoin="round"/>'
      // ✗：两笔交叉，交点略微偏左下（手绘感的来源）
      : '<path d="M8.4 8.6 c 3 3.4 6.2 6.6 9.4 9.4 M17.8 8.4 c -3.3 3.6 -6.6 6.9 -9.6 9.6"'
        + ' fill="none" stroke="' + c + '" stroke-width="2.1" stroke-linecap="round"/>');
    var svg = '<svg class="sk-disk" width="' + s + '" height="' + s + '" viewBox="0 0 26 26"'
      + ' aria-hidden="true" focusable="false">'
      + '<path d="M13 2.2 C18.8 2.2 24 5.6 23.8 12.4 C23.6 19.4 18.6 23.8 12.6 23.7'
      + ' C6.6 23.6 2.3 19.2 2.3 13 C2.3 6.9 7.2 2.2 13 2.2 Z"'
      + ' fill="none" stroke="' + c + '" stroke-width="1.6" stroke-linecap="round"'
      + ' stroke-dasharray="' + (pending ? '5 5' : '86 4') + '" transform="rotate(-3 13 13)">'
      + (pending ? '' : '<animate attributeName="stroke-dashoffset" values="0;-90;0" dur="2.2s"'
        + ' repeatCount="indefinite"/>')
      + '</path>'
      + mark + '</svg>'
      + (label ? '<u class="pp-lab">' + esc(label) + '</u>' : '');
    SKETCH_CACHE[key] = svg;
    return svg;
  }

  /** 一个手绘圈按钮的状态：圈里的符号（✓/✗）、高亮、置灰、以及「已投」那半句。
   *  ⚠ 「已投」不能写进 textContent（会把圈抹掉），走 data-voted + CSS ::after。 */
  var VOTE_LABEL = { ok: '√ 对得上', bad: '× 跑偏了' };
  function setVoteBtn(btn, ok, voted) {
    if (!btn) return;
    var c = btn.querySelector('.pp-c');
    if (c) c.innerHTML = sketchDisk(ok, 26, VOTE_LABEL[ok ? 'ok' : 'bad']);
    btn.dataset.voted = voted ? '1' : '';
    btn.classList.toggle('voted', !!voted);
    btn.classList.toggle('primary', !!voted);
    btn.classList.toggle('ghost', !voted);
    btn.title = voted ? '你已经投了这一票（可以改投另一边）' : '';
    btn.setAttribute('aria-label', VOTE_LABEL[ok ? 'ok' : 'bad'] + (voted ? '（已投）' : ''));
  }

  /** 这条链的**全体投票人**（画布下方那排圈要给每个人都留一个位置）。
   *
   *  名单来源有两处，**优先用服务端的**：
   *    ① 快照里的 groups（每条链那一组的成员名单，voteGroupId 指的就是它）——
   *       这也是 voteTotal 的来源，两边一定对得上；
   *    ② 兜底：链条上的作者顺序（老服务端 / 假快照没有 groups 时）。
   *  服务端的 voteMarks 只报「已经投过的人」，光看它会不知道还有谁没投 —— 用户要的是
   *  「投票窗口下方显示**全部玩家**所投票」，所以名单必须独立于 marks。 */
  function chainRoster(g, chain) {
    var out = [], seen = {};
    var push = function (id, name) {
      if (!id || seen[id]) return;
      seen[id] = 1;
      out.push({ userId: id, name: safeName(name, '投票人名单') });
    };
    var gid = g && g.voteGroupId;
    var groups = (g && g.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      if (gid && groups[i].id !== gid) continue;
      ((groups[i] && groups[i].members) || []).forEach(function (m) {
        push(m && m.userId, m && m.name);
      });
      break;
    }
    if (!out.length) {
      ((chain && chain.steps) || []).forEach(function (s) { push(s && s.playerId, s && s.playerName); });
    }
    return out;
  }

  /** 画布纸片**下方**那排「全场玩家的投票」：每人一个手绘圈 —— 投过的是 ✓ / ✗，
   *  还没投的是一个浅灰虚线空圈（位置先占住，投了就当场变成 √ / ×）。
   *  最前面挂一句「已投 x / y」。 */
  function renderChainVoteMarks(g) {
    var box = $('#rpVoteMarks');
    if (!box) return;
    var paper = $('#rpVote');
    var paperOn = !!(paper && !paper.classList.contains('hidden'));
    // 只在投票阶段、且纸片已经弹出来之后才显示（定格那几秒画面上只有最后一格）
    var show = !!(g && g.phase === 'chain_vote' && paperOn);
    if (!show) {
      box.classList.add('hidden');
      box.innerHTML = '';
      box.style.top = '';
      // 收起期间票数照样在涨 —— 记下来，等弹出时不当成「刚有人投票」乱响
      S.cr.voteSeen = g ? (g.voteDone | 0) : 0;
      return;
    }
    var chain = S.chainReveal && S.chainReveal[S.cr.chain];
    var marks = Array.isArray(g.voteMarks) ? g.voteMarks : [];
    var byUid = {};
    marks.forEach(function (m) { if (m && m.userId) byUid[m.userId] = !!m.add; });
    var roster = chainRoster(g, chain);
    if (!roster.length) {
      // 假快照 / 老服务端：链条里没有 playerId，只能退回「服务端报了几个就画几个」
      roster = marks.map(function (m) {
        return { userId: m.userId, name: safeName(m && m.name, '投票人名字') };
      });
    }
    var html = '<span class="rm-done">已投 ' + (g.voteDone | 0) + ' / ' + (g.voteTotal | 0) + '</span>';
    roster.forEach(function (p) {
      var voted = Object.prototype.hasOwnProperty.call(byUid, p.userId);
      var add = !!byUid[p.userId];
      html += '<span class="rm' + (voted ? (add ? ' ok' : ' bad') : ' pending') + '" title="' + esc(p.name)
        + (voted ? (add ? ' 投了 √ 对得上' : ' 投了 × 跑偏了') : ' 还没投') + '">'
        + sketchDisk(add, 22, '', !voted) + '<i>' + esc(p.name) + '</i></span>';
    });
    box.innerHTML = html;
    box.classList.remove('hidden');
    // 位置：紧贴纸片下沿（纸片是绝对居中的，高度不定 → 渲染完量一次，别写死 CSS）
    var box2 = $('#rpVoteMarks');
    var layer = $('#chainCanvasLayer');
    if (box2 && layer) {
      var pr = paper.getBoundingClientRect(), br = box2.getBoundingClientRect();
      var lr = layer.getBoundingClientRect();
      if (pr.height > 0 && br.height > 0 && lr.height > 0) {
        var top = Math.round(pr.bottom - lr.top + 8);
        var maxTop = Math.round(lr.height - br.height - 6);
        box2.style.top = Math.max(0, Math.min(top, Math.max(0, maxTop))) + 'px';
      }
    }
    // ★ v15：投票音效 —— 别人投了一票（这排圈多了一个）时轻轻响一声；
    //   自己刚按下去的那一下已经响过 voteStamp 了，1.2 秒内不重复。
    var done = g.voteDone | 0;
    if (done > (S.cr.voteSeen | 0) && Date.now() - (S.cr.myVoteAt | 0) > 1200) SFX.play('voteLand');
    S.cr.voteSeen = done;
  }

  /**
   * ★ v14：画布**中央**的「纸片」投票面板（#rpVote，见 index.html / styles.css）。
   *
   * 用户要的：一条链**全部棒次回放完**之后才进投票；进投票后先**定格**几秒，
   * 再在画布中央弹出这张纸片，内容从上到下 ——
   *   起词：<词> → 最终猜词：<词> → 这个匹配吗？ → 【× 跑偏了】【√ 对得上】。
   * 下方的「已投 x / y + 每人一个 √ / ×」走 renderChainVoteMarks（在画布下方）。
   *
   * ⚠ 纸片是 #chainCanvasLayer 这个 flex 列里的一行（夹在上下窄带之间），
   *   只吃中间那块高度 —— 物理上压不到窄带，也不会盖住画布之外的东西。
   */
  function renderChainVoteArea(chain) {
    var g = S.game;
    var box = $('#rpVote');
    if (!box) return;
    // ★ 只有「整条链放完、轮到投票」才出现 —— 服务端用 voteChainId + phase=chain_vote
    //   保证「放完才投、每条链串行」，前端只跟着它显隐。
    var show = !!(g && g.phase === 'chain_vote');
    var bad = $('#rpVoteBad'), ok = $('#rpVoteOk');
    if (!show) {
      box.classList.add('hidden');
      resetVotePaper();
      // 收起时把两个按钮一起藏掉 + 置灰（不留「灰着但还能点」的假象）
      if (bad) { bad.classList.add('hidden'); bad.disabled = true; }
      if (ok) { ok.classList.add('hidden'); ok.disabled = true; }
      renderChainVoteMarks(null);
    } else {
      // 进投票后先定格 voteFreezeMs（服务端下发，3~5 秒），到点才弹纸片
      var ready = votePaperReady(g);
      box.classList.toggle('hidden', !ready);
      // 两个按钮的圈先渲好（隐藏时也渲，弹出那一刻不会闪一下空白）
      setVoteBtn(bad, false, false);
      setVoteBtn(ok, true, false);
      if (bad) { bad.disabled = !ready; bad.classList.toggle('hidden', !ready); }
      if (ok) { ok.disabled = !ready; ok.classList.toggle('hidden', !ready); }
      if (ready) {
        applyTornPaper(box);
        var first = $('#rpVoteFirst'), last = $('#rpVoteLast');
        // ★ 去 [object Object] 的兜底：这两个字段可能来自服务端 / 老壳 / 假快照，
        //   一律过 safeWord —— 非字符串 console.error + 渲染「（空）」。
        if (first) first.textContent = safeWord(chain && chain.firstWord, '纸片的起词');
        if (last) last.textContent = safeWord(chain && chain.lastWord, '纸片的最终猜词');
        var hint = $('#rpVoteHint');
        if (hint) hint.textContent = '这个匹配吗？';
        var myKeep = (g.myKeep || {})[chain.chainId];
        // 投过的那一侧高亮 + 标「已投」，另一侧退回未选中的样子。
        // ⚠ 圈是内联 SVG，不能整块 textContent 覆盖（会把圈抹掉）——
        //   所以「已投」那句走 ::after（见 styles.css 的 [data-voted]）。
        setVoteBtn(bad, false, myKeep === false);
        setVoteBtn(ok, true, myKeep === true);
        // 已投 x / y 直接读服务端算好的数 —— 各端显示才不会一个 2/4 一个 3/4
        var done = $('#rpVoteDone');
        if (done) {
          done.textContent = '已投 ' + (g.voteDone | 0) + ' / ' + (g.voteTotal | 0) +
            (myKeep === undefined ? '' : (myKeep ? ' · 你投了 √' : ' · 你投了 ×'));
        }
      }
    }
    // 画布**下方**那排标记（谁投了、投了哪边）
    renderChainVoteMarks(g);

    // 「最喜欢的一张画」：**单独一行**（#rpFavRow），和 √ / × 那一行分开 ——
    // 它投的是「这条链里我最喜欢的一幅画」，跟「首尾对得上吗」是两码事，
    // 服务端也分开统计（结算里各自给分），前端绝不混在一起。
    // ★ v12：♥ 是**按链**记的 —— 每条链各能投一次。
    // ★ v19：某一棒**还停在屏幕上**就能投（不再「播完立刻置灰」）—— 每一棒都有机会。
    var favBtn = $('#rpFavBtn');
    var item = chain.steps && chain.steps[S.cr.item];
    var isArt = !!(item && item.type === 'DRAWING' && Array.isArray(item.content) && item.content.length);
    var open = crLegFavOpen();
    var canFav = isArt && (open || isMyFav(S.cr.chain, S.cr.item));
    var favRow = $('#rpFavRow');
    if (favRow) favRow.classList.toggle('hidden', !canFav);
    if (favBtn) {
      favBtn.classList.toggle('hidden', !canFav);
      var mine = canFav && isMyFav(S.cr.chain, S.cr.item);
      var chainVoted = chainFavMine(chain);
      favBtn.textContent = mine ? '♥ 已投 · 这张' : '♡ 最喜欢这张';
      favBtn.classList.toggle('primary', !!mine);
      favBtn.classList.toggle('voted', !!mine);
      favBtn.disabled = !canFav || !open;
      favBtn.title = !open
        ? '这一格已经翻页了 —— ♥ 只在某一棒还停在屏幕上时能投'
        : chainVoted
          ? '这条链你已经投过 ♥ 了（每条链一次，可以再挑别的链）'
          : '把这张选为本条链里你最喜欢的画（每条链各一次，每一棒展示时都能投）';
    }

    // 我一共投过几条链（不是全场进度）—— 让人知道「还能投」。
    var favState = $('#rpFavState');
    if (favState) {
      var n = favVotedCountOf(g);
      var totalChains = Number(g.chainCount);
      if (!isFinite(totalChains) || totalChains <= 0) totalChains = (S.chainReveal || []).length;
      var txt = '你已给 ' + n + ' 条链投过 ♥' +
        (totalChains > 0 ? '（共 ' + totalChains + ' 条 · 每条链一次）' : '（每条链一次）');
      if (!open) txt += ' · ♥ 在某一棒回放 / 定格时能投（每一棒都有机会）';
      favState.textContent = txt;
    }
  }

  /* ---- 纸片出现的时机：进投票后先定格几秒（各端同时弹、同时能点） ---- */
  var VOTE_PAPER_FALLBACK_MS = 3500;    // 服务端没下发 voteFreezeMs 时的兜底（协议默认同一档）
  var voteReadyAt = 0;
  function resetVotePaper() { voteReadyAt = 0; }
  /** 进投票那一刻记下「到点」的时间（只记一次；换链 / 离开展开时重置） */
  function votePaperReady(g) {
    var freeze = Number(g && g.voteFreezeMs);
    if (!isFinite(freeze) || freeze < 0) freeze = VOTE_PAPER_FALLBACK_MS;
    if (!voteReadyAt) {
      voteReadyAt = Date.now() + freeze;
      // 到点那一刻**自己重渲染一次** —— 状态同步可能刚好在这几秒里没来，
      // 光等下一次 sync 会让「定格 3~5 秒」变成「定格到下一次同步」。
      S.cr.timer = setTimeout(function () { S.cr.timer = null; renderChainReveal(); },
        Math.max(0, freeze) + 40);
    }
    return Date.now() >= voteReadyAt;
  }

  /** keep 票：当前这条链「首尾对得上吗」。票可改（服务端按人记 Map）。 */
  function voteKeep(agree) {
    var g = S.game;
    var chain = S.chainReveal && S.chainReveal[S.cr.chain];
    if (!chain || !g || g.phase !== 'chain_vote') return;
    var my = (g.myKeep || {})[chain.chainId];
    // ★ v15：投票音效 = 纸片被拍在桌上（voteStamp）+ 原来那声倾向音（√ 亮 / × 低）
    S.cr.myVoteAt = Date.now();
    SFX.play('voteStamp');
    SFX.play(agree ? 'voteOk' : 'voteBad');
    net.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: chain.chainId, agree: !!agree });
    // 立刻给按钮一个「按下了」的反馈，别等服务端回快照 ——
    // 公网下这一来回有几百毫秒，不立刻反馈的话人会以为没点到，然后连点。
    var btn = agree ? $('#rpVoteOk') : $('#rpVoteBad');
    if (btn && my === undefined) {
      btn.classList.add('pulse');
      setTimeout(function () { btn.classList.remove('pulse'); }, 420);
    }
  }

  /** fav 票：本条链里我最喜欢的一张画（v12：**每条链各一票**，同一张再点 = 不变；
   *  同一链里换一张 = 改票，服务端按 (chainId → step) 覆盖）。
   *  ★ v19：只要这一棒**还停在屏幕上**就能投（crLegFavOpen），不再「播完就置灰」——
   *  服务端 favVote 也认 REVEAL 阶段，所以回放途中点下去就是生效的。 */
  function sendFavVote(ci, si) {
    var g = S.game;
    var chain = S.chainReveal && S.chainReveal[ci];
    if (!chain || !g) return;
    if (g.phase !== 'chain_vote' && g.phase !== 'chain_reveal') return;
    if (ci === S.cr.chain && si === S.cr.item && !crLegFavOpen() && !isMyFav(ci, si)) return;
    var item = chain.steps && chain.steps[si];
    if (!item || item.type !== 'DRAWING') return;
    if (isMyFav(ci, si)) { SFX.play('tap'); return; }   // 已经是这张了，别重投
    SFX.play('voteOk');
    net.send(P.C2S.GAME_VOTE, { kind: 'fav', chainId: chain.chainId, step: si });
  }

  /** 横条里那颗 ♥：投「当前显示的这一格画」为最喜欢的一张 */
  function favCurrentItem() {
    sendFavVote(S.cr.chain, S.cr.item);
  }

  /** 回放那一组「进度件」的显隐（v14 只剩格点进度 + 房主的「立刻推进」）。
   *  小结算时画布上放的是「这条链的结果」，格点 / 按钮留着会被误点。 */
  function setChainCtlVisible(on) {
    ['#rpPills'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.classList.toggle('hidden', !on);
    });
    if (!on) { var b = $('#btnRpNext'); if (b) b.classList.add('hidden'); }
  }

  /** 「一条链的小结算」（chain_score 且 voteResult.partial===true）：
   *  不弹奖杯 —— 把 √ / × 与过没过写进画布**下沿那条窄带**里
   *  （以前是浮在画布上的一行，现在不占画面了）。 */
  function renderChainScoreMini() {
    var g = S.game;
    var score = $('#cclScore');
    var bar = $('#chainReplayBar');
    if (!score || !bar) return;
    var settled = (g && g.settled) || [];
    var r = settled[settled.length - 1];
    if (!r) { score.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    setChainStrip();
    crStopAnim();
    crCanvasRelease();          // ★ v16：小结算把画布还给文档本身
    crMarkExternal(false);
    setChainCtlVisible(false);
    $('#rpTitle').textContent = '结算';
    $('#rpIndex').textContent = (Math.max(1, (g.voteChainIndex | 0))) + ' / ' + (g.chainCount | 0);
    $('#rpChainHead').innerHTML = '「' + esc(safeWord(r.firstWord, '小结算的起词')) + '」这条链已结算';
    renderRpPills([]);
    renderChainVoteMarks(null);      // 小结算没有投票标记（那条链已经投完了）
    var verdict = $('#rpVerdict');
    if (verdict) { verdict.innerHTML = ''; verdict.classList.remove('ok', 'bad'); }
    var vote = $('#rpVote');
    if (vote) vote.classList.add('hidden');
    var favBtn = $('#rpFavBtn');
    if (favBtn) favBtn.classList.add('hidden');
    // 画布中间那一格交给下一条链的回放（马上接上），这里只在窄带里报这一条的结果
    crShowImage('');
    setRpTimerVisible(false);
    score.innerHTML = '<b>√ ' + (r.agree | 0) + ' / × ' + (r.against | 0) + '</b> ' +
      '<span class="cs-flow">' + esc(r.firstWord || '（空）') + ' → ' + esc(r.lastWord || '（空）') + '</span> ' +
      (r.won
        ? '<span class="cs-won">对上了 —— 起词人 ' + esc(r.ownerName || '某人') + ' 拿一个奖杯 🏆</span>'
        : '<span class="cs-lost">没过半，这条不算</span>');
    score.classList.remove('hidden');
    setChainCanvasBands('<span class="ccl-note">第 ' + (g.voteChainIndex | 0) + ' 条链已结算</span>', null);
    syncChainCanvasPad();
  }

  /** 最终结算 / 离开小结算：那条结果收掉，交给奖杯弹窗 */
  function hideChainScoreMini() {
    var score = $('#cclScore');
    if (score) { score.classList.add('hidden'); score.innerHTML = ''; }
  }

  /* ★ v14：本地「自动播放」的节奏 —— 回放**不再有**手动翻格 / 播放 / 暂停
   * （crStepItem / crPlay / syncRpPlayBtn 三个函数连同 UI 一起删掉了）。
   * 服务端每过 revealLegMs 推进一格并下发 revealStep，前端跟着切；
   * 下面这个定时器只是**兜底**（万一某次状态同步丢了，本地也能按同一节奏继续往下走）。 */

  function crScheduleNext() {
    crClearTimer();
    if (!S.cr.playing) return;
    var a = S.cr.anim;
    // 服务端一般会先推进（此时这条本地定时器只是兜底）；万一服务端没跟上，
    // 也要保证「动画演完 + 定格」至少走满这一格的总时长再翻。
    var wait = crLegTotalMs();
    if (a && a.finished && a.landedAt) wait = Math.max(wait, a.landedAt + crLegTotalMs() - Date.now());
    S.cr.timer = setTimeout(function () {
      if (!S.cr.playing) return;
      var chain = S.chainReveal && S.chainReveal[S.cr.chain];
      var items = chain ? (chain.steps || []) : [];
      if (S.cr.item >= items.length - 1) { S.cr.playing = false; return; }
      S.cr.item += 1;
      // ★ v15：走到猜词格 = 悬念揭晓（和 crApplyLeg 里那一处同一个音）
      var nx = items[S.cr.item];
      SFX.play(nx && nx.type === 'GUESS' ? 'reveal' : 'cellReveal');
      renderChainReveal();
    }, crLegTotalMs());
  }

  /* ---- 最终结算第一步：「点赞最多的画」（v12） ----
   *
   * 用户明确要的**顺序**：全部链结算完（chain_score 且 voteResult.partial === false）
   *   → ① 先在主画布上把「点赞最多的画」铺出来（一行「<作者> 画的 · N 票」）
   *   → ② 再弹奖杯榜。
   *
   * 所以 ① 是个**能停住**的界面：
   *   - 画下面有一条横条（#favBar），上面是「看奖杯榜 →」按钮；
   *   - 同时 FAV_SHOW.autoMs 之后**自动**进奖杯榜 —— 两种路都要能用（用户特意强调的）。
   *   - 平票（favTie）时把并列的那几幅**轮播**：每 FAV_SHOW.tieMs 换一幅，横条上点出第几幅。
   *   - 一幅都没有（没人点 ♥）时给一句「这一局没人点 ♥」，几秒后照样进榜，绝不卡住。
   *
   * 渲染用的是现成能力：engine.renderStrokesPNG(strokes, '#fff') → 喂 #chainCanvasImg。
   * 展示用静态图（不是逐笔动画）—— 结算页要的是「看清楚这幅画」，不是再看一遍过程。
   *
   * ⚠ 容错：favRanking 缺了就看 fav；strokes 缺了就回查 S.chainReveal；两个都没有就画不出来，
   *   这时**跳过那一项**，不退化成「一直等在那儿」。
   */
  var FAV = { active: false, rows: [], idx: 0, tie: false, timer: 0, auto: 0, url: '' };
  var FAV_SHOW = { autoMs: 7000, tieMs: 3600, emptyMs: 2600 };

  /** 一项「点赞最多的画」的笔迹：优先用服务端随 fav 一起给的 strokes，
   *  老服务端 / 假快照没带的话回查回放数据里那一格的 content。 */
  function favRowStrokes(row) {
    if (!row) return null;
    if (Array.isArray(row.strokes) && row.strokes.length) return row.strokes;
    var list = S.chainReveal || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].chainId !== row.chainId) continue;
      var st = (list[i].steps || [])[row.step];
      if (st && Array.isArray(st.content) && st.content.length) return st.content;
    }
    return null;
  }

  /** 从 voteResult 里挑出「要展示的那几幅」：
   *  平票 = 并列最高票的全部；不平票 = 只有 favRanking[0]（= 用户说的那一幅）。
   *  返回的行都带可渲染的 strokes 与「作者 / 票数」。 */
  function favWinnerRows(vr) {
    if (!vr) return [];
    var rank = Array.isArray(vr.favRanking) ? vr.favRanking : [];
    var src = rank.length ? rank : (Array.isArray(vr.fav) ? vr.fav : []);
    var rows = [];
    src.forEach(function (r) {
      if (!r || (r.votes | 0) <= 0) return;
      var st = favRowStrokes(r);
      if (!st || !st.length) return;                    // 这一项读不到画：跳过，别摆空框
      rows.push({
        chainId: r.chainId, step: r.step,
        playerName: r.playerName || r.ownerName || '某人',
        votes: r.votes | 0, strokes: st, _png: r._png
      });
    });
    if (!rows.length) return rows;
    var top = rows[0].votes;                            // favRanking 是票数降序的
    var tied = rows.filter(function (r) { return r.votes === top; });
    // 平票（favTie 明确给 true，或降序表里确实并列）→ 并列的全要；否则只要第一幅
    return (vr.favTie === true || tied.length > 1) ? tied : [rows[0]];
  }

  /** 一行说明：「<作者> 画的 · N 票」（用户指定的措辞） */
  function favCaption(row) {
    if (!row) return '♥ 点赞最多的画';
    return '♥ 点赞最多的画 · <b>' + esc(row.playerName) + '</b> 画的 · <b>' + row.votes + ' 票</b>';
  }

  /** 把当前这一幅（FAV.idx）铺到主画布上，并把说明写进上下窄带 + 横条 */
  function paintFavRow() {
    if (!FAV.active || !FAV.rows.length) return;
    FAV.idx = Math.max(0, Math.min(FAV.idx | 0, FAV.rows.length - 1));
    var row = FAV.rows[FAV.idx];
    // 一幅画只渲一次：renderStrokesPNG 是同步全尺寸的，状态同步每秒都进来，别每帧重渲
    if (row._png === undefined) {
      var u = '';
      try { u = engine.renderStrokesPNG(row.strokes, '#fff'); } catch (e) { u = ''; }
      row._png = u || '';
    }
    if (row._png) {
      var img = $('#chainCanvasImg');
      // src 没变就别重设（重设会让 <img> 闪一下白）
      if (!img || img.classList.contains('hidden') || img.getAttribute('src') !== row._png) {
        crShowImage(row._png);
      }
    } else {
      crShowImage('');
    }
    FAV.url = row._png || '';
    var layer = $('#chainCanvasLayer');
    if (layer) layer.classList.remove('hidden');
    setChainCanvasBands(favCaption(row), FAV.rows.length > 1
      ? '<span class="ccl-note">平票 ' + FAV.rows.length + ' 幅并列 —— 轮播第 ' +
        (FAV.idx + 1) + ' / ' + FAV.rows.length + ' 幅</span>'
      : '<span class="ccl-note">全部链都已结算 —— 下面可以去看奖杯榜</span>');
    var title = $('#favTitle');
    if (title) title.innerHTML = favCaption(row);
    var note = $('#favNote');
    if (note) note.textContent = FAV.rows.length > 1 ? '平票 ' + FAV.rows.length + ' 幅（自动轮播）' : '';
    var dots = $('#favDots');
    if (dots) {
      var h = '';
      if (FAV.rows.length > 1) {
        for (var i = 0; i < FAV.rows.length; i++) h += '<i class="fb-dot' + (i === FAV.idx ? ' on' : '') + '"></i>';
      }
      dots.innerHTML = h;
    }
    syncChainCanvasPad();
  }

  function stopFavTimers() {
    if (FAV.timer) { clearInterval(FAV.timer); FAV.timer = 0; }
    if (FAV.auto) { clearTimeout(FAV.auto); FAV.auto = 0; }
  }

  /** 收起这条界面（不动画布）—— 定时器、横条、圆点一起收干净 */
  function closeFavShow() {
    stopFavTimers();
    FAV.active = false;
    FAV.rows = [];
    FAV.idx = 0;
    FAV.tie = false;
    FAV.url = '';
    var bar = $('#favBar');
    if (bar) bar.classList.add('hidden');
    var dots = $('#favDots');
    if (dots) dots.innerHTML = '';
    var note = $('#favNote');
    if (note) note.textContent = '';
  }

  /** 离开「最终结算」：连主画布上那幅画一起收掉。
   *  ⚠ 画布层本身只在「确实没别人用它」时才收 —— 小结算（renderChainScoreMini）
   *  还要借这一层摆结果行，先收掉的话那一行会闪一下。 */
  function exitFavShow() {
    if (!FAV.active) return;
    closeFavShow();
    var img = $('#chainCanvasImg');
    if (img) { img.removeAttribute('src'); img.classList.add('hidden'); img.style.maxHeight = ''; }
    setChainCanvasBands('', '');
    var bar = $('#chainReplayBar');
    if (!bar || bar.classList.contains('hidden')) {
      var layer = $('#chainCanvasLayer');
      if (layer) layer.classList.add('hidden');
    }
    syncChainCanvasPad();
  }

  /** 打开「点赞最多的画」。可以传一个假的 voteResult 进来（自测/控制台用），
   *  不传就读 S.game.voteResult。返回是否真的打开了。 */
  function openFavShow(vr) {
    var g = S.game;
    var res = vr || (g && g.voteResult);
    if (!res || res.partial === true) return false;
    closeFavShow();
    FAV.active = true;
    FAV.rows = favWinnerRows(res);
    FAV.idx = 0;
    FAV.tie = FAV.rows.length > 1;

    var bar = $('#favBar');
    if (bar) bar.classList.remove('hidden');
    // 上一条链投票时留在下窄带里的「起词 → 最终猜词」要清掉，否则和这里的说明挤在一起
    var verdict = $('#rpVerdict');
    if (verdict) { verdict.innerHTML = ''; verdict.classList.remove('ok', 'bad'); }
    hideChainScoreMini();
    var layer = $('#chainCanvasLayer');
    if (layer) layer.classList.remove('hidden');

    if (!FAV.rows.length) {
      // 没人点 ♥：一句话说清，然后**照样**进奖杯榜（用户要求「别卡住」）
      crShowImage('');
      setChainCanvasBands('<b>♥ 点赞最多的画</b> · <span class="ccl-note">这一局没人点 ♥</span>',
        '<span class="ccl-note">没有 ♥ —— 马上进奖杯榜</span>');
      var t = $('#favTitle');
      if (t) t.innerHTML = '<b>♥ 点赞最多的画</b> · 这一局没人点 ♥';
      var n = $('#favNote');
      if (n) n.textContent = '这一局没人点 ♥';
      var d = $('#favDots');
      if (d) d.innerHTML = '';
      syncChainCanvasPad();
      FAV.auto = setTimeout(function () {
        if (!FAV.active) return;
        stopFavTimers();
        openTrophy();
      }, FAV_SHOW.emptyMs);
      return true;
    }

    paintFavRow();
    if (FAV.tie) {
      FAV.timer = setInterval(function () {
        if (!FAV.active || FAV.rows.length < 2) return;
        FAV.idx = (FAV.idx + 1) % FAV.rows.length;
        paintFavRow();
      }, FAV_SHOW.tieMs);
    }
    FAV.auto = setTimeout(function () {
      if (!FAV.active) return;
      stopFavTimers();          // 自动跳之后就别再轮播了（奖杯榜已经盖在上面）
      openTrophy();
    }, FAV_SHOW.autoMs);
    return true;
  }

  /** 横条上那颗「看奖杯榜 →」（点了立刻进，不用等自动那一下） */
  function favToTrophy() {
    if (!FAV.active) return;
    stopFavTimers();
    SFX.play('tap');
    openTrophy();
  }

  /* ---- 奖杯结算 ---- */

  function openTrophy() {
    var mask = $('#trophyMask');
    if (!mask) return;
    var g = S.game;
    if (!g || !g.voteResult) return;
    mask.classList.remove('hidden');
    var vr = g.voteResult;
    var chains = vr.chains || [];
    var fav = vr.fav || [];

    var won = chains.filter(function (r) { return r.won; });
    // 我自己起词的链有没有拿到奖杯 —— 有就放华丽的那一声
    var iWon = won.some(function (r) { return r.ownerPlayerId === S.me.userId; });
    var iFav = fav.some(function (r) { return r.playerId === S.me.userId; });
    SFX.play((iWon || iFav) ? 'trophy' : (won.length ? 'match' : 'noTrophy'));

    var html =
      '<div class="tr-row' + (won.length ? ' won' : '') + '">' +
      '<b>' + (won.length ? '🎉 ' + won.length + ' 条链安全到达终点' : '这一局全军覆没') + '</b>' +
      '<span class="tr-flow">首尾一致且多数人不反对的链，起词的人拿一个奖杯</span></div>';

    // 「点赞最多的画」：独家最高票 +3，平票各 +1（分已在服务端算好，这里只展示）。
    // ★ v12：这一条要**自带作者 + 票数**，还顺手放一张缩略图 ——
    //   上面的「先亮画」那一步会被自动跳过去，奖杯榜里必须能重新看到它。
    var favThumb = function (r) {
      if (!r) return '';
      var u = r._png;
      if (u === undefined) {
        var st = favRowStrokes(r);
        u = '';
        if (st && st.length) { try { u = engine.renderStrokesPNG(st, '#fff'); } catch (e) { u = ''; } }
        r._png = u || '';
      }
      return u ? '<img class="tr-fav-thumb" src="' + u + '" alt="' + esc(r.playerName || '') + ' 的画">' : '';
    };
    if (fav.length === 1) {
      html += '<div class="tr-row won tr-fav">' + favThumb(fav[0]) +
        '<span class="tr-flow"><b>♥ 点赞最多的画</b> · <b>' + esc(fav[0].playerName || '某人') +
        '</b> 画的 · <b>' + (fav[0].votes | 0) + ' 票</b>（' + esc(favChainTitle(fav[0])) + '）· +3 分</span></div>';
    } else if (fav.length > 1) {
      html += '<div class="tr-row won tr-fav"><span class="tr-fav-thumbs">' +
        fav.map(favThumb).join('') + '</span>' +
        '<span class="tr-flow"><b>♥ 点赞最多的画（平票 ' + fav.length + ' 幅）</b> · ' +
        fav.map(function (r) {
          return '<b>' + esc(r.playerName || '某人') + '</b> 画的（' + (r.votes | 0) + ' 票）';
        }).join('、') + ' · 各 +1 分</span></div>';
    } else {
      // 没人点 ♥ 也要有这一条：让人知道「这个奖这一局没人拿」
      html += '<div class="tr-row"><b>♥ 点赞最多的画</b>' +
        '<span class="tr-flow">这一局没人点 ♥ —— 这个奖空着</span></div>';
    }

    var rows = '';
    chains.forEach(function (r) {
      rows += '<div class="tr-row ' + (r.won ? 'won' : 'lost') + '">' +
        '<span class="tr-owner">' + esc(r.ownerName) + '</span>' +
        '<span class="tr-flow"><b>' + esc(r.firstWord || '（空）') + '</b> → ' +
        esc(r.lastWord || '（空）') + (r.against ? '（' + r.against + ' 人投了「跑偏了」）' : '') + '</span>' +
        '<span class="tr-flag">' + (r.won ? '🏆' : '—') + '</span></div>';
    });
    html += rows;
    $('#trSummary').innerHTML = html;

    // 分数榜（奖杯与「最受欢迎」的分都累计在这里）
    var rank = '';
    (g.scores || []).forEach(function (s) {
      var me = s.userId === S.me.userId;
      var mem = S.members.filter(function (m) { return m.userId === s.userId; })[0] || { color: '#9aa0a8' };
      rank += '<div class="gs-row' + (me ? ' me' : '') + (s.online ? '' : ' offline') + '">' +
        '<span class="gs-rank">' + s.rank + '</span>' +
        '<span class="gs-name"><i class="dot" style="background:' + esc(mem.color) + '"></i>' +
        esc(s.name) + (me ? '（我）' : '') + '</span>' +
        '<span class="gs-score">' + s.score + ' 分</span></div>';
    });
    $('#trophyList').innerHTML = rank || '<div class="gs-row"><span class="gs-name">还没有分数</span></div>';
  }

  /** 「最喜欢的画」来自哪条链（用链主的起词标注） */
  function favChainTitle(favRow) {
    var chain = S.chainReveal && S.chainReveal.filter(function (c) {
      return c.chainId === favRow.chainId;
    })[0];
    if (chain && chain.firstWord) return '「' + chain.firstWord + '」那条链';
    return '某条链';
  }

  function closeTrophy() {
    var mask = $('#trophyMask');
    if (mask) mask.classList.add('hidden');
  }

  /* ============================================================ 自定义主题词库
   *
   * 词库存服务端（server/data/themes.json）。前端只做两件事：
   *   ① 把用户在 textarea 里粘的词原样发给服务端，由服务端裁决合格与否
   *   ② 把「被丢掉的词」如实回显 —— 静默吞词是最气人的交互
   *
   * 为什么判定不在前端做：前端的校验永远只是「体验优化」，真规矩得在服务端。
   * 否则一个改过的客户端就能往词库里塞单字词，把整个房间的接龙判定搞坏。
   */

  /** 词库管理面板的状态 */
  var TM = { list: [], editing: null, minWords: 3 };

  function openThemeManager() {
    var mask = $('#themeMask');
    if (!mask) return;
    mask.classList.remove('hidden');
    $('#themeMask').classList.remove('hidden');
    TM.editing = null;
    fillThemeForm(null, '');
    loadThemeList();
  }

  function closeThemeManager() {
    var mask = $('#themeMask');
    if (mask) mask.classList.add('hidden');
    // 关掉后刷新**两个**面板的主题下拉（可能刚建/改/删过）
    S.themes = null;
    var gt = $('#gameTheme');
    if (gt) gt.dataset.built = '';        // 清掉签名，逼它下一次按新菜单重建
    renderChainDialog();
    buildThemeSelect($('#gameTheme'));
    probePublicUrl();
  }

  /** 拉词库列表。同时也把内置主题的「不可删」信息带给面板 */
  function loadThemeList() {
    fetch(httpBase() + '/api/themes')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        TM.list = (j && j.custom) || [];
        TM.minWords = (j && j.minWords) || 3;
        var el = $('#tmMinWords');
        if (el) el.textContent = String(TM.minWords);
        renderThemeList();
        // 顺便把最新的主题菜单缓存下来（含内置），接龙下拉就能立刻看到新词库
        S.themes = (j && j.themes) || S.themes;
      })
      .catch(function () {
        toast('读不到词库列表（服务端没响应？）', 'err', 3000);
      });
  }

  function renderThemeList() {
    var box = $('#tmList');
    if (!box) return;
    if (!TM.list.length) {
      box.innerHTML = '<div class="tm-empty">还没有自定义词库。点下面「新建一套」开始。</div>';
      return;
    }
    box.innerHTML = '';
    TM.list.forEach(function (t) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'tm-item' + (TM.editing === t.id ? ' active' : '');
      row.innerHTML = '<span class="tm-item-name">' + esc(t.name) + '</span>' +
        '<span class="tm-item-count">' + t.count + ' 词</span>';
      row.addEventListener('click', function () { selectTheme(t.id); });
      box.appendChild(row);
    });
  }

  /** 选中一套进行编辑 —— 需要把词拉回来（列表接口不带词） */
  function selectTheme(id) {
    TM.editing = id;
    renderThemeList();
    fetch(httpBase() + '/api/themes/' + encodeURIComponent(id) + '/words')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('bad');
        fillThemeForm({ id: id, name: j.name }, (j.words || []).join('、'));
        updateThemeStats();
      })
      .catch(function () {
        // 服务端没提供单取词表的接口时，退化成「只知道名字」
        var meta = TM.list.filter(function (t) { return t.id === id; })[0] || {};
        fillThemeForm({ id: id, name: meta.name }, '');
        setThemeWarn('这套词库的词表读不出来，保存会把它覆盖成你下面填的内容 —— 小心。');
      });
  }

  function fillThemeForm(entry, wordsText) {
    var nameEl = $('#tmName'), wordsEl = $('#tmWords');
    if (nameEl) nameEl.value = entry ? entry.name : '';
    if (wordsEl) wordsEl.value = wordsText || '';
    var del = $('#btnThemeDelete');
    if (del) del.classList.toggle('hidden', !entry);
    setThemeWarn('');
    updateThemeStats();
  }

  function setThemeWarn(msg) {
    var el = $('#tmWarn');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  /** 本地先粗算一下有多少合格的词 —— 让用户在点保存之前就有数 */
  function updateThemeStats() {
    var el = $('#tmStats');
    if (!el) return;
    var raw = ($('#tmWords') && $('#tmWords').value) || '';
    var parts = raw.split(/[,，、;；\s\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var seen = {}, ok = 0, bad = [];
    parts.forEach(function (p) {
      if (!P.isPlayableWord(p)) { bad.push(p); return; }
      if (seen[p]) return;
      seen[p] = 1; ok += 1;
    });
    var txt = ok + ' 个合格的词（去重后）';
    if (bad.length) txt += '，' + bad.length + ' 个会被丢掉';
    el.textContent = txt;
    el.style.color = ok >= TM.minWords ? 'var(--text-dim)' : 'var(--danger)';
    // 和 protocol.isPlayableWord 同一套说法：中文 / 英文 / 数字都行，一个字也行，别带空格
    if (bad.length) setThemeWarn('这些会被丢掉（非空、不带空格、1~12 个字符，至少一个实义字符）：' + bad.join('、'));
    else setThemeWarn('');
  }

  function saveTheme() {
    var name = (($('#tmName') && $('#tmName').value) || '').trim();
    var words = ($('#tmWords') && $('#tmWords').value) || '';
    if (!name) { SFX.play('error'); return toast('给这套词库起个名字', 'warn', 2400); }

    var url = httpBase() + '/api/themes' + (TM.editing ? '/' + encodeURIComponent(TM.editing) : '');
    var method = TM.editing ? 'PUT' : 'POST';
    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, words: words })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        var j = res.j || {};
        if (!res.ok || !j.ok) {
          SFX.play('error');
          toast(j.message || '保存失败', 'err', 3200);
          if (j.rejected && j.rejected.length) {
            setThemeWarn('这些词不合格：' + j.rejected.join('、'));
          }
          return;
        }
        SFX.play('submit');
        var rejected = j.rejected || [];
        toast('已保存「' + j.name + '」（' + j.count + ' 个词）'
          + (rejected.length ? '，丢掉了 ' + rejected.length + ' 个不合格的' : ''), 'ok', 3600);
        TM.editing = j.id || TM.editing;
        // 建它就是为了用它：新建/改完之后直接把这份词库选上（两个面板一起切过去）
        if (j.id) setThemeChoice(j.id);
        loadThemeList();
        setTimeout(function () { renderThemeList(); }, 60);
      })
      .catch(function () {
        SFX.play('error');
        toast('保存失败，检查一下服务端', 'err', 3200);
      });
  }

  function deleteTheme() {
    if (!TM.editing) return;
    var meta = TM.list.filter(function (t) { return t.id === TM.editing; })[0] || {};
    confirmDialog('删掉词库「' + (meta.name || TM.editing) + '」？用它开过局的房间不受影响，但之后就选不到它了。', {
      title: '删除词库', yes: '删除', danger: true
    }).then(function (yes) {
      if (!yes) return;
      fetch(httpBase() + '/api/themes/' + encodeURIComponent(TM.editing), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) { SFX.play('error'); return toast((j && j.message) || '删除失败', 'err', 2800); }
          SFX.play('voteBad');
          toast('词库已删除', 'ok', 2400);
          TM.editing = null;
          fillThemeForm(null, '');
          loadThemeList();
        })
        .catch(function () { SFX.play('error'); toast('删除失败', 'err', 2800); });
    });
  }

  /** 更新 HUD 上那个喇叭图标 */
  function renderSoundBtn() {
    var b = $('#ghSound');
    if (!b) return;
    var on = SFX.isEnabled();
    var vol = SFX.getVolume ? SFX.getVolume() : 0.22;
    b.textContent = !on ? '🔇' : (vol <= 0 ? '🔈' : (vol < 0.5 ? '🔉' : '🔊'));
    b.classList.toggle('off', !on || vol <= 0);
    b.title = !on ? '游戏音效：关（点击开启）'
      : (vol <= 0 ? '游戏音效：开，但音量是 0（拖右边滑块调大）'
        : '游戏音效：开（音量 ' + Math.round(vol * 100) + '%）· 点一下静音');
  }

  /** 拼 HTTP 基址：优先公网，其次局域网，最后拿 ws 地址推 */
  function httpBase() {
    if (typeof shareBase === 'function') {
      var b = shareBase();
      if (b) return b.replace(/\/$/, '');
    }
    return Cfg.httpBaseOf(net.url).replace(/\/$/, '');
  }

  /* ---- 接龙开局对话框 ---- */

  /* ---- 主题词库：两个面板共用同一份选择 ----
   *
   * 「你画我猜」面板和接龙面板各有一个「主题词库」下拉。以前它们各存各的，
   * 于是用户在「你画我猜」里挑好「明日方舟」、切到接龙页签，接龙面板还是
   * 逼他再挑一次（而且默认是别的主题）—— 白挑。现在两份下拉听**同一个**偏好，
   * 存 localStorage，谁改都同步过去。 */
  var THEME_KEY = 'chahu.theme';

  /** 当前选中的主题（两个下拉共享；还没选过就是 default） */
  function themeChoice() {
    if (!S.themeChoice) S.themeChoice = lsGet(THEME_KEY, 'default') || 'default';
    return S.themeChoice;
  }

  /** 换主题：写进偏好 + 把两个下拉一起刷成新的 */
  function setThemeChoice(id) {
    if (!id || id === S.themeChoice) return;
    S.themeChoice = id;
    lsSet(THEME_KEY, id);
    syncThemeSelects();
  }

  /** 在一份已经填好的下拉里挑出「该选中的那一项」；共享项不在里面就退回第一项 */
  function pickThemeOption(sel) {
    var want = themeChoice();
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === want) return want;
    }
    // 共享的那一项这个下拉里没有（自定义词库被删了 / 换了服务器）—— 落到「通用」
    return sel.options.length ? sel.options[0].value : 'default';
  }

  /** 把共享的主题刷到**唯一**那个主题下拉上（#gameTheme）。**列表里还没有这一项就先不动它** ——
   *  （刚新建的词库要等下一次拉到菜单才出现，这时候硬把下拉扳回「通用」是白闪一下） */
  function syncThemeSelects() {
    var want = themeChoice();
    var el = $('#gameTheme');
    if (!el || !el.options.length) return;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].value === want) { el.value = want; return; }
    }
  }

  /**
   * 把服务端下发的主题列表填进任意一个词库下拉（经典面板 / 接龙面板共用）。
   * 列表随快照下发（服务端只给 id/name，绝不含词）。
   * 注意：快照里的 themes 只有「开局之后」才有 —— 开局前 g 是 null 或另一种模式的快照。
   * 所以这里不能一看「还没填过」就用兜底列表把下拉锁死（那会永远只有「通用」一项）；
   * 只有真的拿到服务端的列表才记 data-built。
   */
  function buildThemeSelect(sel) {
    if (!sel) return;
    var g = S.game;
    // 优先用快照里的（开局后一定有）；开局前用 probePublicUrl 顺手缓存的 S.themes 垫着
    var list = (g && g.themes && g.themes.length) ? g.themes : (S.themes || null);
    if (list && list.length) {
      var sig = list.map(function (t) { return t.id; }).join(',');
      if (sel.dataset.built !== sig) {
        sel.innerHTML = '';
        list.forEach(function (t) {
          var o = document.createElement('option');
          o.value = t.id; o.textContent = t.name;
          sel.appendChild(o);
        });
        sel.dataset.built = sig;
      }
      // 选中项**听共享的那一份**，而不是这个下拉自己上一次的值 —— 见 themeChoice 的说明
      sel.value = pickThemeOption(sel);
    } else if (!sel.options.length) {
      // 还没拿到真正的列表 —— 先摆一项占位，等服务端的数据到了再换掉
      sel.innerHTML = '<option value="default">通用（什么都能画）</option>';
    }
  }

  /** 接龙的开局参数（面板「开始」与结算页「再来一局」共用同一份，见 gameSetupPayload） */
  function chainStartPayload() { return gameSetupPayload('chain'); }

  /** 接龙面板已经并进 #gameMask：这里只负责把面板重画一遍（旧调用点还在） */
  function renderChainDialog() { renderGameDialog(); }

  function startChainGame() {
    setGameDialogMode('chain', { silent: true });
    startGame();
  }

  function openChainDialog() {
    setGameDialogMode('chain', { silent: true });
    openGameDialog();
  }

  /** 接龙相关的所有 UI 一起收起来（切模式 / 结束游戏时用） */
  function closeChainUi() {
    crClearTimer();           // 播放器的翻格定时器必须停，否则会在关掉的面板上乱翻
    closeFavShow();           // 先收「点赞最多的画」的状态，下面 hideChainCanvas() 才会真的清画布
    ['#chainInputMask', '#chainReplayBar', '#chainLobby', '#trophyMask',
      '#chainTask', '#chainProgress', '#favBar', '#chainCanvasLayer']
      .forEach(function (id) { var el = $(id); if (el) el.classList.add('hidden'); });
    paintGroupLine('#clGroups', '');
    paintGroupLine('#cpGroups', '');
    hideChainScoreMini();
    hideChainCanvas();
    S.chainTask = null;
    S.chainReveal = null;     // 回放数据随局清空（下一局会有新的 REVEAL 包）
    S.chainInputSubmitted = false;
    S.cr.playing = false;
    S.cr.chain = 0;
    S.cr.chainId = '';
    S.cr.item = 0;
    S.cr.serverStep = null;      // 下一局的回放游标从服务端重新拿
    crStopAnim();
  }

  /* ---- 接龙状态应用 ---- */

  function applyChainState(g, prevPhase) {
    var phase = g ? g.phase : 'off';
    renderChainLobby();
    renderChainTask();
    renderChainProgress();
    renderChainDialog();

    // 回大厅：上一局的回放数据作废（新一局会有新的 REVEAL 包），播放器归零
    if (phase === 'lobby') {
      S.chainReveal = null;
      S.cr.chain = 0;
      S.cr.chainId = '';
      S.cr.item = 0;
      S.cr.playing = false;
      S.cr.serverStep = null;
      hideChainReplayBar();
      hideChainScoreMini();
    }

    // 回放播放器（REVEAL / VOTE 两个阶段都开着）—— 只演服务端指定的那一条链
    if (phase === 'chain_reveal' || phase === 'chain_vote') {
      renderChainReveal();
      closeTrophy();
      if (phase === 'chain_reveal' && prevPhase !== 'chain_reveal') {
        toast('全部传完了！回放开始 —— 看看每条链怎么跑偏的', 'ok', 3600);
      }
    } else if (phase !== 'chain_score') {
      hideChainReplayBar();
    }

    // 结算（三条路：一条链的小结算就地在横条上说；全部结算完**先亮画**、再进奖杯榜）
    if (phase === 'chain_score') {
      var partial = !!(g.voteResult && g.voteResult.partial === true);
      if (partial) {
        // 小结算：只有这一条链的结果，别弹奖杯挡住下一条链的回放
        closeTrophy();
        exitFavShow();
        hideChainScoreMini();
        renderChainScoreMini();
      } else {
        hideChainReplayBar();     // 最终结算：主画布交给「点赞最多的画」
        hideChainScoreMini();
        // ★ 用户要的顺序：全部链结算完 → 先亮「点赞最多的画」→ 再弹奖杯榜。
        //   奖杯榜要等「看奖杯榜 →」（#favToTrophy）或 FAV_SHOW.autoMs 之后的自动跳 —— 两种都能用。
        if (!FAV.active) openFavShow(g.voteResult);
        else paintFavRow();       // 卡在结算里反复同步时，兜一下画面（不重开、不重置计时）
      }
    } else {
      closeTrophy();
      hideChainScoreMini();
      exitFavShow();
    }

    // 输入框只在猜词阶段开着
    syncChainInput();

    // 阶段播报 + 音效
    if (phase !== prevPhase) {
      if (phase === 'chain_write' && prevPhase === 'chain_init') toast('第一手：每人给自己那条链起个头（写完自己先照它画）', 'ok', 3000);
      else if (phase === 'lobby' && prevPhase === 'chain_score') toast('回到大厅 —— 点「准备」再来一局（分数保留）', 'ok', 2600);
      else if (phase === 'lobby') toast('接龙大厅已就绪', 'ok', 2400);
      else if (phase === 'off' && prevPhase !== 'off') toast('接龙结束，回到自由绘画', 'ok', 2600);

      // 「轮到我了」的那一声在 applyChainTask 里（题面到达时）——
      // 这里只负责阶段的整体节奏，两者不会撞在同一帧。
      if (prevPhase === 'off' && phase === 'lobby') SFX.play('gameStart');
      else if (phase === 'off') SFX.play('gameOver');
      else if (phase === 'chain_init') SFX.play('roundStart');
      else if (phase === 'chain_reveal' && prevPhase !== 'chain_reveal') SFX.play('roundStart');
      else if (phase === 'chain_vote' && prevPhase !== 'chain_vote') SFX.play('roundStart');
      else if (phase === 'chain_score' && prevPhase !== 'chain_score') SFX.play('gameOver');
    }

    // 轮到我动手时提醒一声（服务端已经用系统播报说了「谁在做什么」，这里只补一句自己的）
    if (chainStepActive() && S.chainTask && !S.chainInputSubmitted) {
      var key = g.round + ':' + g.stepIndex + ':' + S.chainTask.step + ':' + (S.chainTask.word || '');
      if (S.chainTaskToast !== key) {
        S.chainTaskToast = key;
        if (S.chainTask.step === 'DRAWING') toast('轮到你作画：' + (S.chainTask.word || '') + ' —— 在画布上直接画', 'ok', 4200);
        else if (S.chainTask.step === 'GUESS') toast('轮到你看图猜词 —— 画在画布上，输入条在下面', 'ok', 3600);
        else if (S.chainTask.step === 'WORD') toast('给你的链写一个起词 —— 你自己要照它作画', 'ok', 3600);
      }
    }
  }

  /* ============================================================ 画皮（skin） */

  function isSkinMode() { return !!(S.game && S.game.mode === 'skin'); }

  /**
   * 我的身份 —— 走 SKIN_ROLE 这条**单发**消息，绝不从 S.game 里读。
   *
   * 为什么不放进快照：GAME_STATE 是广播的，房间里每个人都会收到一份。
   * 把身份放进去，任何人在控制台里都能看到全场的底牌 —— 这个玩法就没了。
   * 服务端每次 sync 都会重发这一条，所以这里只管覆盖，不需要「只在第一次」之类的判断。
   */
  function applySkinRole(msg) {
    var prev = S.skinRole;
    S.skinRole = msg || null;
    var key = msg ? msg.role + '|' + (msg.mates || []).map(function (m) { return m.userId; }).join(',') : '';
    var prevKey = prev ? prev.role + '|' + (prev.mates || []).map(function (m) { return m.userId; }).join(',') : '';
    if (key !== prevKey && msg) {
      // 身份到手是最该被听见的一声 —— 整局就靠这一张底牌
      SFX.play(msg.camp === 'wolf' ? 'yourTurn' : 'stepStart');
      if (S.joinCount > 1) toast('你的身份：' + msg.roleName, 'ok', 4200);
    }
    renderSkinRole();
  }

  /** 身份卡 */
  function renderSkinRole() {
    var box = $('#skinRole');
    if (!box) return;
    var r = S.skinRole;
    var g = S.game;
    if (!r || !gameActive() || !isSkinMode()) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.classList.toggle('wolf', r.camp === 'wolf');
    box.classList.toggle('dead', !r.alive);

    $('#srBadge').textContent = r.roleName + (r.alive ? '' : '（已出局）');

    var body = $('#srBody');
    var html = '<div class="sr-line">阵营：<b>' + esc(r.campName) + '</b>'
      + '<span class="sr-dead-tag hidden" id="srDeadTag">出局</span></div>';
    if (r.desc) html += '<div class="sr-note">' + esc(r.desc) + '</div>';
    // 狼的同伴名单：只有狼拿得到（预言家只知道阵营，不该拿到整张狼名单）
    if (r.mates && r.mates.length) {
      html += '<div class="sr-mates"><div class="sr-line">同伴：</div>';
      r.mates.forEach(function (m) {
        html += '<span class="sr-mate">' + esc(m.name) + '</span>';
      });
      html += '</div>';
    } else if (r.camp === 'wolf') {
      html += '<div class="sr-mates"><div class="sr-note">没有其他同伴了 —— 只剩你一个。</div></div>';
    }
    // 当前轮次的主题（画师要知道画什么，狼要知道该假装画什么）
    if (g && g.word && (g.phase === 'skin_draw' || g.phase === 'skin_talk')) {
      html += '<div class="sr-mates"><div class="sr-line">本轮主题：<b>' + esc(g.word) + '</b></div></div>';
    }
    body.innerHTML = html;
    var dt = $('#srDeadTag');
    if (dt && !r.alive) dt.classList.remove('hidden');
  }

  /** 匿名画廊 */
  function renderSkinGallery() {
    var box = $('#skinGallery');
    if (!box) return;
    var g = S.game;
    // 只有展示 / 讨论 / 投票 / 结算阶段才摊开（作画阶段是私密的，绝不能显示）
    var show = isSkinMode() && g && g.gallery && g.gallery.length &&
      (g.phase === 'skin_talk' || g.phase === 'skin_vote' || g.phase === 'skin_vote_end' || g.phase === 'over');
    box.classList.toggle('hidden', !show);
    if (!show) {
      var vm0 = $('#skinViewer'); if (vm0) vm0.remove();
      return;
    }

    var title = $('#sgTitle');
    if (title) title.textContent = '第 ' + g.round + ' 轮 · 匿名画墙';
    var cnt = $('#sgCount');
    if (cnt) cnt.textContent = g.galleryCount + ' 幅';

    var grid = $('#sgGrid');
    var html = '';
    g.gallery.forEach(function (w, i) {
      // ⚠ **画廊里没有作者信息** —— 服务端只发了 id 与 png。
      // 前端也因此不可能「不小心」把作者露出来（比如按 userId 高亮自己的那张）。
      html += '<div class="sg-cell' + (w.skipped ? ' blank' : '') + '" data-w="' + esc(w.id) + '">'
        + '<span class="sg-no">' + (i + 1) + '</span>'
        + (w.png ? '<img src="' + w.png + '" alt="匿名作品 ' + (i + 1) + '">' : '')
        + '</div>';
    });
    grid.innerHTML = html;
    // 点开大图（讨论时要能指着说「你看这一笔」）
    Array.prototype.forEach.call(grid.querySelectorAll('.sg-cell'), function (cell) {
      cell.addEventListener('click', function () {
        var w = (S.game.gallery || []).filter(function (x) { return x.id === cell.getAttribute('data-w'); })[0];
        if (w && w.png) openSkinViewer(w.png);
      });
    });

    renderSkinVote();
  }

  function openSkinViewer(png) {
    closeSkinViewer();
    var el = document.createElement('div');
    el.className = 'skin-viewer';
    el.id = 'skinViewer';
    var img = document.createElement('img');
    img.src = png;
    el.appendChild(img);
    el.addEventListener('click', closeSkinViewer);
    document.body.appendChild(el);
    SFX.play('tap');
  }

  function closeSkinViewer() {
    var el = $('#skinViewer');
    if (el) el.remove();
  }

  /** 投票区（画廊底部） */
  function renderSkinVote() {
    var box = $('#sgVote');
    if (!box) return;
    var g = S.game;
    var show = isSkinMode() && g && g.phase === 'skin_vote';
    box.classList.toggle('hidden', !show);
    if (!show) return;

    var hint = $('#sgVoteHint');
    if (hint) {
      hint.textContent = g.canVote
        ? '投票放逐你认为是伪装者的人（' + g.voteDone + '/' + g.voteTotal + ' 已投，可改票）'
        : '你已经出局了，只能看着（' + g.voteDone + '/' + g.voteTotal + ' 已投）';
    }
    var list = $('#sgVoteList');
    var html = '';
    (g.players || []).forEach(function (p) {
      var on = g.myVote === p.userId;
      html += '<button class="sg-vote-btn' + (on ? ' on' : '') + (p.alive ? '' : ' dead') + '"'
        + ' data-u="' + esc(p.userId) + '"' + (p.alive && g.canVote ? '' : ' disabled') + '>'
        + esc(p.name) + (on ? ' ✓' : '') + '</button>';
    });
    list.innerHTML = html;
    Array.prototype.forEach.call(list.querySelectorAll('.sg-vote-btn'), function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        sendSkinAction('vote', b.getAttribute('data-u'));
      });
    });
    var skip = $('#sgVoteSkip');
    if (skip) {
      skip.disabled = !g.canVote;
      skip.textContent = g.myVote ? '撤销这一票' : '弃票';
    }
  }

  /** 夜里动作面板（预言家验人 / 狼人刀人 / 女巫用药） */
  function renderSkinNight() {
    var mask = $('#skinNightMask');
    if (!mask) return;
    var g = S.game;
    var r = S.skinRole;
    var show = isSkinMode() && g && g.phase === 'skin_night' && r && r.alive &&
      (r.role === 'seer' || r.role === 'wolf' || r.role === 'witch');
    mask.classList.toggle('hidden', !show);
    if (!show) return;

    var title = $('#snTitle');
    var hint = $('#snHint');
    var res = $('#snResult');
    if (res) { res.className = 'hint hidden'; res.textContent = ''; }

    // 已经做完的事就不要再催了：预言家验完 / 狼投完，面板改成「等别人」
    if (r.role === 'seer' && S.skinNight && S.skinNight.kind === 'check') {
      if (title) title.textContent = '预言家 · 已验人';
      if (hint) hint.textContent = '等其他人行动（天亮就会公布结果）';
      var list0 = $('#snList'); if (list0) list0.innerHTML = '';
      showSkinCheckResult();
      return;
    }

    if (title) title.textContent = r.role === 'seer' ? '预言家 · 验一个人'
      : r.role === 'wolf' ? '伪装者 · 今晚刀谁' : '女巫 · 要不要用药';

    // 女巫的面板与另外两个不一样：**她不能随便点人**，只能救今晚那个刀口
    //（服务端会拦「药只能用在今晚被刀的人身上」）。
    // 狼还没把刀定下来时她也没得选 —— 这时候只显示「等狼定刀」。
    if (r.role === 'witch') {
      renderSkinWitchPanel();
      return;
    }

    if (hint) {
      hint.textContent = r.role === 'seer'
        ? '你会知道他是不是伪装者（不知道具体身份）'
        : '和同伴商量，多数决；平票时服务端随机取一个';
    }

    var list = $('#snList');
    var html = '';
    (g.players || []).forEach(function (p) {
      if (!p.alive) return;
      // 狼不能刀同伴；预言家可以验任何人（验到好人也是信息）
      var dis = (r.role === 'wolf' && S.skinRole && (S.skinRole.mates || [])
        .some(function (m) { return m.userId === p.userId; }));
      var isMe = p.userId === S.me.userId;
      if (r.role === 'seer' && isMe) dis = true;    // 验自己没意义
      html += '<button class="sn-btn" data-u="' + esc(p.userId) + '"' + (dis ? ' disabled' : '') + '>'
        + esc(p.name) + (isMe ? '（我）' : '')
        + '<span class="sn-sub">' + (p.alive ? '' : '已出局') + '</span></button>';
    });
    list.innerHTML = html;
    Array.prototype.forEach.call(list.querySelectorAll('.sn-btn'), function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        var kind = r.role === 'seer' ? 'check' : 'kill';
        sendSkinAction(kind, b.getAttribute('data-u'));
      });
    });
  }

  /**
   * 女巫那一支：她看到的不是「所有人列表」，而是**今晚的刀口**。
   * 狼还没定刀 → 提示等待；定下来了 → 一个「用药救人」/「不用药」的二选一。
   * 已经用过药或已经救了 → 只显示结果，不再给按钮。
   */
  function renderSkinWitchPanel() {
    var title = $('#snTitle');
    var hint = $('#snHint');
    var list = $('#snList');
    var n = S.skinNight;
    var isWitchInfo = n && n.kind === 'witch' && !n.resolved;

    if (!isWitchInfo) {
      if (title) title.textContent = '女巫 · 等狼定刀';
      if (hint) hint.textContent = '今晚刀口还没定下来（伪装者正在选人），定下来你就能决定救不救';
      if (list) list.innerHTML = '';
      return;
    }
    if (title) title.textContent = '女巫 · 要不要救';
    if (n.saveUsed) {
      if (hint) hint.textContent = '你的解药已经用过了 —— 今晚只能看着';
      if (list) list.innerHTML = '<div class="sn-result good">' + esc(n.targetName) + ' 今晚有危险，但你已无药可用</div>';
      return;
    }
    if (n.alreadySaved) {
      if (hint) hint.textContent = '你已经把药用在他身上了';
      if (list) list.innerHTML = '<div class="sn-result good">已用药救下 ' + esc(n.targetName) + '</div>';
      return;
    }
    if (hint) hint.textContent = '今晚被刀的是下面这个人 —— 救他（解药只有一瓶）或者留着';
    if (list) {
      list.innerHTML = '<button class="sn-btn" data-u="' + esc(n.target) + '">'
        + '用药救 ' + esc(n.targetName) + '<span class="sn-sub">解药 · 只有一瓶</span></button>'
        + '<button class="sn-btn" data-u="">不用药<span class="sn-sub">留着以后用</span></button>';
      Array.prototype.forEach.call(list.querySelectorAll('.sn-btn'), function (b) {
        b.addEventListener('click', function () {
          var u = b.getAttribute('data-u');
          if (!u) { renderSkinNight(); return; }   // 「不用药」= 什么都不做，面板留在原地
          sendSkinAction('save', u);
        });
      });
    }
  }

  /** 预言家验完人之后，把结果就地显示出来（他不用等天亮） */
  function showSkinCheckResult() {
    var res = $('#snResult');
    if (!res) return;
    var n = S.skinNight;
    if (!n || n.kind !== 'check') return;
    res.className = 'sn-result ' + (n.isWolf ? 'wolf' : 'good');
    res.textContent = n.targetName + ' 是 ' + (n.isWolf ? '伪装者！' : '画师（好人）');
  }

  /** 天亮公告（公开信息 + 发给我的私有裁定） */
  function renderSkinDawn() {
    var mask = $('#skinDawnMask');
    if (!mask) return;
    var g = S.game;
    var show = isSkinMode() && g && (g.phase === 'skin_dawn' || g.phase === 'skin_talk') && g.lastNight;
    mask.classList.toggle('hidden', !show);
    if (!show) return;

    var t = $('#sdTitle');
    if (t) t.textContent = '第 ' + g.lastNight.round + ' 天 · 天亮了';
    var txt = $('#sdText');
    if (txt) txt.textContent = g.lastNight.text || '';

    // 私有裁定：预言家的验人结果 / 我是不是昨晚被刀的
    var pv = $('#sdPrivate');
    if (pv) {
      var n = S.skinNight;
      if (n && n.kind === 'check') {
        pv.className = 'sd-private ' + (n.isWolf ? 'wolf' : 'good');
        pv.textContent = '你的验人结果：' + n.targetName + ' 是 '
          + (n.isWolf ? '伪装者！' : '画师（好人）');
      } else if (n && n.kind === 'dead') {
        pv.className = 'sd-private wolf';
        pv.textContent = n.saved
          ? '昨晚你被刀了，但被女巫救了回来 —— 捡回一条命。'
          : '昨晚你被刀了，已经出局。虽然不能投票了，但还可以继续发言搅局。';
      } else if (n && n.kind === 'witch') {
        // 女巫：天亮后她要知道自己那瓶药到底用没用上。
        // 服务端在天亮时会把 nightInfoFor 换成 kind='dead'（如果她是刀口）或 null，
        // 所以这里能走到，说明她还活着 —— 那就只汇报用药结果。
        pv.className = 'sd-private';
        pv.textContent = n.saveUsed
          ? (n.alreadySaved ? '你昨晚用药救下了 ' + n.targetName + '。' : '你昨晚用掉了那瓶解药。')
          : '你昨晚没有用药，解药还留着。';
      } else {
        pv.className = 'sd-private hidden';
        pv.textContent = '';
      }
    }
  }

  /** 结算面板：公开全部身份 */
  function renderSkinOver() {
    var mask = $('#skinOverMask');
    if (!mask) return;
    var g = S.game;
    var show = isSkinMode() && g && g.phase === 'over';
    mask.classList.toggle('hidden', !show);
    if (!show) return;

    var sum = $('#soSummary');
    if (sum) {
      var goodWin = g.winner === 'good';
      sum.innerHTML = '<div class="rc-title" style="font-size:16px">' + (goodWin ? '画师阵营获胜' : '伪装者阵营获胜') + '</div>'
        + '<div class="hint">' + esc(g.winReason || '') + '</div>';
    }
    var list = $('#soList');
    if (list) {
      var html = '';
      (g.players || []).forEach(function (p) {
        var r = S.skinRole && p.userId === S.me.userId ? S.skinRole : null;
        var isWolf = p.cause === '' && false;   // 占位：真实阵营由服务端的真相表给（见 applySkinReveal）
        html += '<div class="so-row' + (p.alive ? '' : ' out') + '" data-u="' + esc(p.userId) + '">'
          + '<span class="so-name">' + esc(p.name) + (p.userId === S.me.userId ? '（我）' : '') + '</span>'
          + (p.alive ? '' : '<span class="so-out">已出局</span>')
          + '<span class="so-role" data-role="' + esc(p.userId) + '">…</span>'
          + '</div>';
      });
      list.innerHTML = html;
    }
    applySkinReveal();
  }

  /**
   * 结算时的「真相表」—— 由服务端 broadcast 一条 `<SKIN_ROLE>:all` 带过来。
   * 为什么不在 GAME_STATE 里：身份类信息统一走身份通道，
   * 免得「结算时能看到身份」这条规则被后人误当成「身份可以广播」而搬到快照里。
   */
  function applySkinReveal() {
    var all = S.skinReveal;
    if (!all || !all.length) return;
    all.forEach(function (r) {
      var el = document.querySelector('.so-role[data-role="' + r.userId + '"]');
      if (!el) return;
      el.textContent = r.roleName;
      var row = el.closest('.so-row');
      if (row && r.camp === 'wolf') row.classList.add('wolf');
    });
  }

  function sendSkinAction(kind, target) {
    if (!isSkinMode()) return;
    net.send(P.C2S.SKIN_ACTION, { kind: kind, target: target || '' });
    SFX.play('tap');
  }

  /** 交画：把画布导成 PNG 交给服务端（服务端只做哑存储） */
  function submitSkinArt() {
    var g = S.game;
    if (!isSkinMode() || !g || g.phase !== 'skin_draw') return;
    if (!g.canDraw) { toast('这一轮你不能画', 'warn', 2400); return; }
    if (S.skinDrawnSubmitted) return;
    var png;
    try { png = engine.exportPNG(); } catch (e) { png = ''; }
    if (!png) { SFX.play('error'); return toast('导出作品失败，再试一次', 'warn', 2600); }
    S.skinDrawnSubmitted = true;
    net.send(P.C2S.SKIN_ART, { png: png });
    SFX.play('submit');
    renderSkinDrawBar();
    toast('作品已交给画墙（匿名展示，没人知道是你）', 'ok', 2800);
  }

  /** 作画阶段悬浮的「交稿」条 */
  function renderSkinDrawBar() {
    var bar = $('#skinDrawBar');
    if (!bar) return;
    var g = S.game;
    var show = isSkinMode() && g && g.phase === 'skin_draw' && g.canDraw;
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    var b = $('#sdbSubmit');
    if (b) {
      b.disabled = S.skinDrawnSubmitted;
      b.textContent = S.skinDrawnSubmitted ? '已交稿' : '交稿';
    }
    var s = $('#sdbState');
    if (s) {
      s.textContent = S.skinDrawnSubmitted
        ? '等其他人交稿…（' + g.drawDone + '/' + g.drawTotal + '）'
        : '主题：' + (g.word || '') + ' —— 画完点「交稿」';
    }
  }

  /* ---- 画皮开局面板（已并进 #gameMask） ---- */

  /** 旧调用点还在：面板统一由 renderGameDialog 画 */
  function renderSkinDialog() { renderGameDialog(); }

  function startSkinGame() {
    setGameDialogMode('skin', { silent: true });
    startGame();
  }

  function openSkinDialog() {
    setGameDialogMode('skin', { silent: true });
    openGameDialog();
  }

  function closeSkinUi() {
    ['#skinNightMask', '#skinDawnMask', '#skinOverMask',
      '#skinRole', '#skinGallery', '#skinDrawBar'].forEach(function (id) {
      var el = $(id); if (el) el.classList.add('hidden');
    });
    closeSkinViewer();
    S.skinDrawnSubmitted = false;
    S.skinVotePick = '';
  }

  /* ---- 画皮状态应用 ---- */

  function applySkinState(g, prevPhase) {
    var phase = g ? g.phase : 'off';

    // 换了轮次 → 新一轮的画还没交（这个标记不能跨轮残留，否则第二轮交不了稿）
    if (!g || g.round !== S.skinPrevRound) {
      S.skinDrawnSubmitted = false;
      // 夜里结算的私有裁定也要清掉（不然昨天的验人结果会挂到今天）
      if (phase === 'skin_night') S.skinNight = null;
    }

    renderSkinRole();
    renderSkinGallery();
    renderSkinNight();
    renderSkinDawn();
    renderSkinOver();
    renderSkinDrawBar();
    renderSkinDialog();

    // 阶段播报 + 音效
    if (phase !== prevPhase) {
      if (phase === 'lobby' && prevPhase === 'off') toast('画皮已就绪 —— 够 ' + g.minPlayers + ' 人就能开局', 'ok', 3200);
      else if (phase === 'skin_night') toast('天黑请闭眼', 'ok', 2400);
      else if (phase === 'skin_dawn') toast('天亮了', 'ok', 2400);
      else if (phase === 'skin_draw') {
        toast('本轮主题：' + (g.word || '') + ' —— 各自画，' + Math.round((g.phaseMs || 60000) / 1000) + ' 秒',
          'ok', 4200);
      } else if (phase === 'skin_talk') toast('画都摊开了 —— 谁是伪装者？', 'ok', 3600);
      else if (phase === 'skin_vote') toast('投票放逐', 'ok', 2600);
      else if (phase === 'off' && prevPhase !== 'off') toast('画皮结束，回到自由绘画', 'ok', 2600);

      if (prevPhase === 'off' && phase === 'lobby') SFX.play('gameStart');
      else if (phase === 'off') SFX.play('gameOver');
      else if (phase === 'over' && prevPhase !== 'over') SFX.play('gameOver');
      else if (phase === 'skin_draw' && prevPhase !== 'skin_draw') SFX.play('roundStart');
      else if (phase === 'skin_vote' && prevPhase !== 'skin_vote') SFX.play('roundStart');
      else if (phase === 'skin_dawn' && prevPhase !== 'skin_dawn') SFX.play('stepStart');
    }
    S.skinPrevPhase = phase;
    S.skinPrevRound = g ? g.round : -1;

    // 轮到我了提醒一声（「该你验人 / 该你出刀」这种，比看 HUD 直观）
    if (phase === 'skin_draw' && g.canDraw && !S.skinDrawnSubmitted) {
      var k = 'draw:' + g.round;
      if (S.skinTaskToast !== k) { S.skinTaskToast = k; SFX.play('yourTurn'); }
    }
  }

  /* ============================================================ 启动 */

  function buildEffectSelects() {
    var ps = $('#paperSelect');
    ps.innerHTML = '';
    Brushes.PAPER_OPTIONS.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.id; el.textContent = o.name;
      ps.appendChild(el);
    });
    var fs = $('#fxSelect');
    fs.innerHTML = '';
    Brushes.FX_OPTIONS.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.id; el.textContent = o.name;
      fs.appendChild(el);
    });
  }

  function boot() {
    buildBlendSelects();
    buildPalette();
    buildSizePresets();
    buildPaperPicker();
    buildEffectSelects();
    // 导入的笔刷要先注册进 Brushes，loadToolPrefs 才能认出它们
    S.imported = loadImported();
    loadToolPrefs();
    applyPanelOrder();
    // 折叠状态要在 applyPanelOrder 之后落 —— 小节可能被拖到右栏，得先搬完再定折叠
    applySectionStates();
    bindUI();
    bindKeys();
    bindPaste();
    bindCanvas();
    bindViewBar();
    bindWheel();
    bindColorSliders();
    bindPanelDnD();
    bindColumnResizers();
    bindQuickBar();
    bindLayoutSettings();
    bindRefWindow();
    loadDimPrefs();
    applyDimView();
    loadUiScale();          // 恢复上次的界面缩放（以前只写不读，刷新必丢）
    // 侧栏收拉：把手 / 窄条 / F4（菜单里那项也走同一个函数）
    $('#btnSideCollapse').addEventListener('click', function () { setSideCollapsed(true); });
    $('#sideRail').addEventListener('click', function () { setSideCollapsed(false); });
    // 左栏同理：顶部 « 收起、左边窄条拉回（菜单项和 Tab 键也走这里）
    var blc = $('#btnLeftCollapse'); if (blc) blc.addEventListener('click', function () { setLeftCollapsed(true); });
    var lr = $('#leftRail'); if (lr) lr.addEventListener('click', function () { setLeftCollapsed(false); });
    // 窄屏抽屉：点暗色遮罩把抽屉都关掉
    var db = $('#drawerBack');
    if (db) db.addEventListener('click', function () {
      setLeftCollapsed(true, { persist: false });
      setSideCollapsed(true, { persist: false });
    });
    // 进出窄屏自动切换布局（窗口拉窄 / 手机横竖屏都会触发）
    if (NARROW_MQ) {
      var onMq = function () { applyLayoutMode(false); };
      if (NARROW_MQ.addEventListener) NARROW_MQ.addEventListener('change', onMq);
      else if (NARROW_MQ.addListener) NARROW_MQ.addListener(onMq);   // 老 Safari
    }
    applyLayoutMode(true);
    // iOS Safari 会自己接管双指捏合（整页缩放）—— 先拦掉，画布上的捏合才归我们
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
    });
    $('#btnAboutClose').addEventListener('click', function () { $('#aboutMask').classList.add('hidden'); });
    $('#btnCheckUpdate').addEventListener('click', checkUpdate);
    $$('.about-tabs .tab').forEach(function (t) { t.addEventListener('click', function () { showAboutTab(t.dataset.atab); }); });
    $('#refFileInput').addEventListener('change', function () { loadReferenceImage(this.files[0]); });
    bindTransformPanel();
    // 你画我猜的倒计时：本地每 250ms 按服务端 deadline 刷新一次，
    // 不靠服务端逐秒推送（那样每条消息都要过一遍压缩，纯属浪费）
    setInterval(updateGameTimer, 250);
    // 回放洋葱皮的偏好：开机就灌进引擎，免得到时候点开回放还得再开一次
    applyOnion(S.onionOn, S.onionCount);
    engine.attach($('#view'), $('#overlay'));

    loadBrush(S.brushId);
    setBgColor(S.bgColor);
    S.recent = loadRecent();
    renderRecent();
    setColor(S.color || '#2b2b2b', false);
    $('#symSelect').value = S.sym;
    $('#cursorStyle').value = S.cursorStyle;
    syncViewBar();
    refreshNav();

    net.on('status', function (e) {
      renderConn(e.status);
      // 网络层带话过来时以它为准：比如「离线模式只有桌面端有」这种，比一句
      // 笼统的「连接断开」有用得多
      if (e && e.message) setStatus(e.message);
      // 在线 / 离线是「那一行按钮 + 菜单里那个勾」的输入，两处都得跟着重画。
      // status 事件只在**真的换档**时才会发（setStatus 里同值会提前 return），所以不贵。
      renderServerToggle();
      refreshMenuChecks();
    });
    net.on('open', function () {
      if (S.room && S.room.id && S.me.name) {
        setStatus('已重连，正在回到「' + S.room.name + '」…');
        // 带密码的房间重连也要带密码 —— 本地记着上次输对的那个
        net.send(P.C2S.ROOM_JOIN, { roomId: S.room.id, user: S.me.name, password: getRoomPass(S.room.id) });
      }
      // 每次连上（含重连）都问一次：隧道可能是中途才开的
      probePublicUrl();
    });
    net.on('message', handleMessage);
    net.on('retry', function (e) { setStatus('连接中断，' + Math.round(e.delay / 1000) + 's 后重试…'); });

    // 头像和昵称一样是「我是谁」的一部分：本地存着，启动就带回来
    S.me.avatar = Cfg.getAvatar ? (Cfg.getAvatar() || '') : '';
    // 本机服务器开关：先问一次现状，之后主进程一有变化就会推过来（托盘 / 别处关了也能同步）
    if (desktopBridge()) {
      if (global.chahuDesktop.onServerState) global.chahuDesktop.onServerState(applyServerState);
      refreshServerState();
    } else {
      renderServerToggle();
    }
    var server = Cfg.resolve();
    $('#serverInput').value = server;
    net.connect(server);

    var autoRoom = Cfg.queryRoom();
    if (autoRoom) {
      var name = Cfg.getName() || ('茶友' + Math.floor(Math.random() * 900 + 100));
      S.me.name = name;
      Cfg.setName(name);
      setStatus('正在进入房间 ' + autoRoom + ' …');
      var t = setInterval(function () {
        if (net.isOpen()) {
          clearInterval(t);
          // 分享链接进带密码的房间：先试（记住过密码就直接进），错了会弹密码框
          joinRoom(autoRoom, name, getRoomPass(autoRoom));
        }
      }, 300);
      setTimeout(function () { clearInterval(t); }, 15000);
    } else if (global.chahuDesktop && global.chahuDesktop.takeOpenLink) {
      // ★ 2.0.10：桌面端**从链接拉起**（chahui://，或启动参数里的分享链接）
      //   主进程把链接存着，这里取一次；之后再来链接走 onOpenLink 的推送。
      global.chahuDesktop.takeOpenLink().then(function (url) {
        if (url) joinByLink(url, { silent: true });
        else setTimeout(function () { openEntry(true); }, 420);
      }, function () { setTimeout(function () { openEntry(true); }, 420); });
      if (global.chahuDesktop.onOpenLink) {
        global.chahuDesktop.onOpenLink(function (url) { joinByLink(url, { silent: true }); });
      }
    } else {
      setTimeout(function () { openEntry(true); }, 420);
    }

    setTimeout(function () { engine.fitView(); }, 120);
    // 入口页那条「上次没正常结束，要不要恢复」的提示条
    refreshDraftBar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ================================================================
   * 菜单栏动作：menu.js 里的每一条都落到这里。
   * 这里只写「薄包装」——真正干活的是上面已有的那些函数。
   * ================================================================ */

  function addLayer() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    net.send(P.C2S.LAYER_ADD, { name: '图层 ' + (engine.layers.length + 1) });
  }

  function moveLayer(dir) {
    if (!S.joined) return;
    var i = engine.layers.findIndex(function (l) { return l.id === engine.activeLayerId; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= engine.layers.length) { toast('已经到头了'); return; }
    net.send(P.C2S.LAYER_MOVE, { layerId: engine.activeLayerId, to: j });
  }

  function clearLayer() {
    if (!S.joined) return;
    if (!confirm('清空当前图层？这一步可以撤销。')) return;
    net.send(P.C2S.LAYER_CLEAR, { layerId: engine.activeLayerId });
  }

  function leaveRoom() {
    if (!S.joined) { toast('还没进房间'); return; }
    if (!confirm('离开当前房间？')) return;
    net.send(P.C2S.ROOM_LEAVE, {});
    S.joined = false;
    // 「观众」标签也得顺手摘掉 —— 它看的是 S.joined，不刷新就会一直挂在顶栏上
    renderMeRole();
    engine.strokes = [];
    engine.byId = new Map();
    engine.pending.clear();
    engine.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; });
    engine.invalidate();
    openEntry(true);
  }

  /**
   * 整幅图像翻转 / 旋转。
   * 实现方式：把整幅文档当成一次「全选 + 变换」，交给已经验证过的变换管线去做 ——
   * 这样跨端一致性和烘焙回传都直接复用，不用另写一套。
   */
  function flipImage(axis) {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    runWholeImageTransform(function () { engine.transform.flip(axis); },
      axis === 'h' ? '已水平翻转' : '已垂直翻转');
  }
  function rotateImage(dir) {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    runWholeImageTransform(function () { engine.transform.rotate90(dir); },
      dir > 0 ? '已顺时针旋转 90°' : '已逆时针旋转 90°');
  }

  /** 全选 → 开变换 → 做一件事 → 立刻确定。整幅画面作为一个整体被变换。 */
  function runWholeImageTransform(mutate, okMsg) {
    if (engine.transform) { toast('先按 Enter 确定（或 Esc 中止）当前的变换'); return; }
    beginSelSnapshot();
    engine.selectAll();
    commitSelSnapshot();
    startTransform();
    if (!engine.transform) { toast('无法开始变换', 'err'); return; }
    mutate();
    commitTransform();
    toast(okMsg, 'ok');
  }

  /**
   * 裁剪到选区：画布变成选区那么大，画面按选区左上角整体平移。
   *
   * 以前这里走的是 scaleArtwork —— 那是**缩放**，等于把整幅画面拉成选区尺寸，
   * 根本不是裁剪（探针实测：裁完内容被拉伸，位置全不对）。
   * 现在和「画布大小」共用 resizeCanvasKeepContent，只是锚点由选区决定：
   * 想让「选区的左上角」落在新画布的 (0,0)，锚点就得是 bb.x/(W-w)。
   */
  function cropToSelection() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    if (!S.me.isOwner) { toast('只有房主可以改画布尺寸', 'err'); return; }
    if (!engine.hasSelection()) { toast('先用选区工具圈一块出来', 'err'); return; }
    var bb = engine.selectionBBox();
    if (!bb) { toast('选区是空的', 'err'); return; }
    var w = clamp(Math.round(bb.w), 320, 4096);
    var h = clamp(Math.round(bb.h), 240, 4096);
    if (w !== Math.round(bb.w) || h !== Math.round(bb.h)) {
      toast('选区太小：画布最小 320 × 240，已按最小尺寸裁', 'err', 4200);
    }
    var W = engine.width, H = engine.height;
    // 新画布上 (0,0) 要对应原来的 (bb.x, bb.y)：dx = (w-W)*ax = -bb.x
    var ax = (W === w) ? 0 : clamp(-bb.x / (w - W), 0, 1);
    var ay = (H === h) ? 0 : clamp(-bb.y / (h - H), 0, 1);
    if (!confirm('裁剪到选区？画布会变成 ' + w + ' × ' + h + '，这一步可以撤销。')) return;
    resizeCanvasKeepContent(w, h, ax, ay);
  }

  function selectFromLayer() {
    var b = engine.activeLayer();
    if (!b) return;
    var d = b.ctx.getImageData(0, 0, engine.width, engine.height);
    beginSelSnapshot();
    var s = engine.ensureSelection();
    var sd = s.ctx.createImageData(engine.width, engine.height);
    for (var i = 0; i < d.data.length; i += 4) {
      sd.data[i] = 255; sd.data[i + 1] = 255; sd.data[i + 2] = 255;
      sd.data[i + 3] = d.data[i + 3];
    }
    s.ctx.putImageData(sd, 0, 0);
    s.active = true;
    engine.refreshSelectionTint();
    if (!s.bbox) s.active = false;
    commitSelSnapshot();
    toast(s.active ? '已按当前图层的不透明区域建立选区' : '这一层是空的', s.active ? 'ok' : 'err');
  }

  function selectNone() {
    beginSelSnapshot();
    engine.clearSelection();
    commitSelSnapshot();
    toast('已取消选区');
  }
  function selectInvert() {
    beginSelSnapshot();
    invertSelection();
    commitSelSnapshot();
  }
  function selectAll() {
    beginSelSnapshot();
    engine.selectAll();
    commitSelSnapshot();
    toast('已全选');
  }
  /** 菜单里的「网格变换」：进变换 + 打开网格；已经在网格里就关掉 */
  function toggleMeshTransform() {
    if (!engine.transform) {
      startTransform();
      if (!engine.transform) return;
      $('#tpMesh').checked = true;
      engine.transform.setMesh(true, Number($('#tpMeshN').value));
      engine.drawOverlay();
      toast('网格变换：拖控制点做局部变形（Alt 带动周围）', 'ok', 4200);
      return;
    }
    var on = !engine.transform.mesh;
    $('#tpMesh').checked = on;
    engine.transform.setMesh(on, Number($('#tpMeshN').value));
    engine.drawOverlay();
    toast(on ? '网格变换：开' : '网格变换：关');
  }

  function toggleTransform() {
    if (engine.transform) commitTransform(); else startTransform();
  }

  function toggleGrid() {
    engine.grid.on = !engine.grid.on;
    S.gridOn = engine.grid.on;
    try { localStorage.setItem('chahu.grid', engine.grid.on ? '1' : '0'); } catch (e) { /* ignore */ }
    engine.drawOverlay();
    toast(engine.grid.on ? '网格：开' : '网格：关');
  }

  function setSymmetry(mode) {
    S.sym = mode;
    engine.sym = mode;
    if (typeof bindSymButtons === 'function') bindSymButtons();
    var el = document.querySelector('#symSelect');
    if (el) el.value = mode;
    toast({ none: '对称尺：关闭', v: '对称尺：垂直镜像', h: '对称尺：水平镜像', quad: '对称尺：四向' }[mode] || mode);
  }

  function nudgeSteadier(d) {
    var cur = Number(S.brush.steadier || 0);
    var next = Math.max(0, Math.min(15, cur + d));
    S.brush.steadier = next;
    var el = document.querySelector('#steadierRange');
    if (el) { el.value = next; el.dispatchEvent(new Event('input', { bubbles: true })); }
    toast('抖动修正：' + next);
  }

  function setPaper(id) {
    S.brush.paper = id;
    var el = document.querySelector('#paperPicker');
    if (el) {
      var b = el.querySelector('[data-paper="' + id + '"]');
      if (b) b.click();
    }
    toast('纸张质感：' + id);
  }
  function setFx(id) {
    S.brush.fx = id;
    var el = document.querySelector('#fxSelect');
    if (el) { el.value = id; el.dispatchEvent(new Event('change', { bubbles: true })); }
    toast('特殊效果：' + id);
  }

  function zoomBy(f) { engine.setZoom(engine.scale * f); }
  function zoom100() { engine.setZoom(1); }
  function zoomFit() { engine.fitView(); }
  function flipView() { engine.flipView(); }
  function rotateView(deg, reset) { if (reset) engine.setRotation(0); else engine.rotateBy(deg); }


  // 小节现在可能被拖到右侧面板里，所以查找必须跨两个容器。
  function sectionEl(id) {
    return document.querySelector('#leftPanelScroll [data-section="' + id + '"]') ||
           document.querySelector('#rightPanelScroll [data-section="' + id + '"]');
  }

  var SECTION_KEY = 'chahu.sections';

  /** 读小节折叠状态（{id: 0|1}）。1=展开、0=收起 */
  function loadSectionStates() {
    var st = {};
    try { st = JSON.parse(localStorage.getItem(SECTION_KEY) || '{}') || {}; } catch (e) { st = {}; }
    return st;
  }

  /**
   * 把存下来的折叠状态落到 DOM 上。
   * 为什么需要这个：`toggleSection` 一直在写 `chahu.sections`，但**从来没人读它** ——
   * 于是用户收起的小节刷新一次全弹回来（观感像「设置不生效」）。
   * 必须在 `applyPanelOrder()` **之后**调：小节会被搬到另一栏，得搬完再定折叠。
   */
  function applySectionStates() {
    var st = loadSectionStates();
    // 跨两个容器查（小节可能被拖到右栏）
    document.querySelectorAll('#leftPanelScroll [data-section], #rightPanelScroll [data-section]')
      .forEach(function (el) {
        var id = el.getAttribute('data-section');
        if (!id || !Object.prototype.hasOwnProperty.call(st, id)) return;
        el.classList.toggle('hidden', !st[id]);
      });
  }

  function toggleSection(id) {
    var el = sectionEl(id);
    if (!el) return;
    var hidden = el.classList.toggle('hidden');
    var st = loadSectionStates();
    st[id] = hidden ? 0 : 1;
    try { localStorage.setItem(SECTION_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ }
    engine.resize();
  }

  /** 某个小节现在是不是收起的（给布局设置面板显示用） */
  function isSectionHidden(id) {
    var el = sectionEl(id);
    return el ? el.classList.contains('hidden') : false;
  }

  function resetPanels() {
    try {
      localStorage.removeItem(SECTION_KEY);
      localStorage.removeItem('chahu.panelOrder');
      localStorage.removeItem('chahu.panelSides');
      // 栏宽也一并还原 —— 以前不清，点了「恢复默认」栏宽还是歪的
      localStorage.removeItem('chahu.colW');
    } catch (e) { /* ignore */ }
    // 栏宽复位到 CSS 里的默认值（清掉 inline 覆盖即可）
    document.documentElement.style.removeProperty('--left-w');
    document.documentElement.style.removeProperty('--right-w');
    // 把所有小节搬回左栏（默认布局），再清掉隐藏状态。
    var left = $('#leftPanelScroll');
    if (left) {
      document.querySelectorAll('#rightPanelScroll [data-section]').forEach(function (s) {
        s.classList.remove('hidden');
        left.appendChild(s);
      });
      document.querySelectorAll('#leftPanelScroll [data-section]').forEach(function (s) {
        s.classList.remove('hidden');
      });
    }
    if (typeof updateRightScroll === 'function') updateRightScroll();
    if (typeof applyPanelOrder === 'function') applyPanelOrder();
    engine.resize();
    toast('面板布局已恢复默认', 'ok');
  }

  function showRoomInfo() {
    if (!S.room) { toast('还没进入房间'); return; }
    showInfo(shareLinkText());
  }

  function showStatus() {
    var s = net.status || 'unknown';
    toast('连接：' + s + '｜在线 ' + (S.members || []).length + ' 人｜笔迹 ' + engine.strokes.length + ' 笔');
  }

  function cycleCursor() {
    var order = ['auto', 'ring', 'cross'];
    var i = order.indexOf(S.cursorStyle);
    S.cursorStyle = order[(i + 1) % order.length];
    try { localStorage.setItem('chahu.cursor', S.cursorStyle); } catch (e) { /* ignore */ }
    var el = document.querySelector('#cursorSelect');
    if (el) el.value = S.cursorStyle;
    updateBrushCursor();
    toast('光标：' + { auto: '智能', ring: '始终圆环', cross: '始终十字准星' }[S.cursorStyle]);
  }

  function clearHistory() {
    if (!S.joined) return;
    if (!confirm('清空房间里所有人的笔画记录？画布上已画好的内容会保留（会先固化），这一步不可撤销。')) return;
    net.send(P.C2S.ROOM_COMPRESS, {});
    toast('已请求清空笔画历史', 'ok');
  }

  function shareLinkText() {
    var base = shareBase();
    return base && S.room ? base + '/?room=' + S.room.id : (S.room ? S.room.id : '');
  }

  /* ================================================================
   * 菜单栏里那些「茶绘原本没有入口」的动作。
   * 能复用已有函数的一律复用；确实没有的功能在 menu.js 里就置灰了，不会走到这里。
   * ================================================================ */

  function quitApp() {
    // 安卓壳：让原生层收掉 Activity（WebView 里 window.close() 是 no-op）
    if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.App) {
      global.Capacitor.Plugins.App.exitApp();
      return;
    }
    if (global.chahuDesktop && global.chahuDesktop.isDesktop) {
      // 桌面端：让主进程关窗口
      window.close();
      return;
    }
    toast('网页版直接关掉标签页就行');
  }

  /* ---------------- 编辑：剪贴板 ---------------- */

  /** 把选区内的画面拷到系统剪贴板（没有选区就整幅） */
  async function copySelection() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    if (engine.transform) { toast('先按 Enter 确定当前的变换'); return; }
    var src = engine.renderDocument({});
    var bb = engine.hasSelection() ? engine.selectionBBox() : null;
    if (!bb) bb = { x: 0, y: 0, w: engine.width, h: engine.height };
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(bb.w));
    out.height = Math.max(1, Math.round(bb.h));
    out.getContext('2d').drawImage(src.canvas, -Math.round(bb.x), -Math.round(bb.y));
    S.clip = { png: out.toDataURL('image/png'), w: out.width, h: out.height };
    try {
      if (navigator.clipboard && global.ClipboardItem) {
        var blob = await new Promise(function (r) { out.toBlob(r, 'image/png'); });
        await navigator.clipboard.write([new global.ClipboardItem({ 'image/png': blob })]);
        toast('已拷贝 ' + out.width + ' × ' + out.height + ' 到剪贴板', 'ok');
        return;
      }
    } catch (e) { /* 没权限就算了，S.clip 里还留着一份 */ }
    toast('已拷贝 ' + out.width + ' × ' + out.height + '（茶绘内部剪贴板）', 'ok');
  }

  /* ---------------- 编辑：粘贴 ---------------- */

  /**
   * 从剪贴板里取一张图片。三级兜底 —— 三种运行环境的限制完全不一样：
   *   ① 桌面端：走主进程的 clipboard.readImage()，没有权限弹窗，最稳；
   *   ② 网页版：navigator.clipboard.read()，要用户手势 + 授权，失败往下走；
   *   ③ 兜底：茶绘**内部**剪贴板 S.clip —— 「拷贝」在没拿到系统权限时也会留一份。
   */
  async function readClipboardImage() {
    if (global.chahuDesktop && global.chahuDesktop.clipboardImage) {
      try {
        var d = await global.chahuDesktop.clipboardImage();
        if (d) {
          var im = await loadImage(d);
          if (im && im.width) return im;
        }
      } catch (e) { /* 没读到就往下试 */ }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        var items = await navigator.clipboard.read();
        for (var i = 0; i < items.length; i++) {
          var types = items[i].types || [];
          var type = null;
          for (var j = 0; j < types.length; j++) if (/^image\//.test(types[j])) { type = types[j]; break; }
          if (!type) continue;
          var blob = await items[i].getType(type);
          var url = URL.createObjectURL(blob);
          var img = await loadImage(url);
          URL.revokeObjectURL(url);
          if (img && img.width) return img;
        }
      }
    } catch (e) { /* 没权限 / 剪贴板里没图，落到内部剪贴板 */ }
    if (S.clip && S.clip.png) {
      var own = await loadImage(S.clip.png);
      if (own && own.width) return own;
    }
    return null;
  }

  /** 粘贴的共同前置检查：不满足就提示并返回 false（菜单和右键两条路都走它） */
  function pasteAllowed() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return false; }
    if (engine.transform) { toast('先按 Enter 确定当前的变换'); return false; }
    var _bm = canvasBlockMsg();
    if (_bm) { toast(_bm, 'err', 1800); return false; }
    var max = global.ChaProject ? global.ChaProject.MAX_LAYERS : 16;
    if (engine.layers.length >= max) {
      toast('图层数已达上限 ' + max + '，先删掉一层再贴', 'err', 3600);
      return false;
    }
    return true;
  }

  /** 把图片摆成「整幅画布大小」的一张画布：居中；比画布大就等比缩到放得下 */
  function composeImageOnCanvas(img) {
    var W = engine.width, H = engine.height;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    // 必须是透明的：这张图会**整层替换**目标图层像素，不能带上底色
    ctx.clearRect(0, 0, W, H);
    var k = Math.min(1, W / img.width, H / img.height);
    var w = Math.max(1, Math.round(img.width * k));
    var h = Math.max(1, Math.round(img.height * k));
    ctx.drawImage(img, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
    return { canvas: c, w: w, h: h, scaled: k < 1 };
  }

  /** 轮询等某个图层在本地出现 —— 图层是服务端建的，广播回来才算数 */
  function waitForLayer(layerId, cb, tries) {
    var l = engine.getLayer(layerId);
    if (l) { cb(l); return; }
    if ((tries || 0) > 60) { toast('新建图层超时，请重试', 'err'); return; }   // 60 × 50ms ≈ 3s
    setTimeout(function () { waitForLayer(layerId, cb, (tries || 0) + 1); }, 50);
  }

  /**
   * 把一张图片贴成一个**新图层**，居中放好。
   *
   * 走的是和「变换 / 滤镜」同一条通道：像素没法用笔迹重放表达，所以客户端
   * 烘焙成 PNG 回传给服务端（LAYER_PIXELS），服务端依旧只当哑存储。
   *
   * 图层 id 由客户端**自己指定**（服务端会校验格式与冲突）。这一点是必须的：
   * 「先建层、再往里写像素」中间有一段时间差，而本地和服务端对「认不出的 layerId
   * 该兜底到哪一层」的规则并不一样（客户端兜底到活动图层、服务端兜底到最后一层），
   * 不自己指定就会两端分家 —— 「文字图层」此前就是这么错的。
   */
  function placeImageOnNewLayer(img, name) {
    var id = P.rid('L');
    var view = composeImageOnCanvas(img);
    var png = view.canvas.toDataURL('image/png');
    net.send(P.C2S.LAYER_ADD, { name: name, id: id });
    waitForLayer(id, function () {
      var before = snapshotLayer(id);                  // 新层，这份就是一张透明图
      engine.applyTransformResult(id, view.canvas);    // 本地立刻可见
      net.send(P.C2S.LAYER_PIXELS, { layerId: id, png: png });
      // 撤销 = 把这一层清回透明（图层的壳留着，想删再自己删）
      pushOp({ type: 'pixels', layerId: id, before: before, after: png, label: name });
      engine.setActiveLayer(id);
      renderLayers(); renderHistory(); refreshNav();
      toast(name + '完成' + (view.scaled
        ? '（图比画布大，已等比缩到 ' + view.w + ' × ' + view.h + '）' : '') +
        '　Ctrl+Z 可撤回', 'ok', 3600);
    });
  }

  /** 编辑 → 粘贴：把剪贴板里的图片贴成一个新图层 */
  async function pasteImage() {
    if (!pasteAllowed()) return;
    var img = await readClipboardImage();
    if (!img) { toast('剪贴板里没有图片（复制一张图或截个屏再试）', 'err', 3600); return; }
    placeImageOnNewLayer(img, '粘贴');
  }

  /**
   * 真·粘贴事件（右键 → 粘贴 / 浏览器原生粘贴）。
   * 快捷键 Ctrl+V 走的是菜单那套，两条路都汇到 placeImageOnNewLayer。
   * 焦点在输入框里时**一律不抢** —— 聊天框和文字对话框要能正常粘文字。
   */
  function bindPaste() {
    document.addEventListener('paste', function (e) {
      var t = e.target || {};
      var tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t.isContentEditable) return;
      var dt = e.clipboardData;
      if (!dt || !dt.items) return;
      var file = null;
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) { file = it.getAsFile(); break; }
      }
      if (!file) return;                       // 不是图片就放行，不拦
      e.preventDefault();
      if (!pasteAllowed()) return;
      var url = URL.createObjectURL(file);
      loadImage(url).then(function (img) {
        URL.revokeObjectURL(url);
        if (img && img.width) placeImageOnNewLayer(img, '粘贴');
      });
    });
  }

  /* ---------------- 图层 ---------------- */

  function dupLayer() { layerDup(); }
  function delLayer() { layerDel(); }
  function moveLayerTo(dir) {
    // 图层面板上「上移」= 往数组后面走
    layerMove(dir);
  }
  function mergeDown() { layerMerge(); }
  function mergeVisible() { layerFlatten(); }

  /* ---------------- 图像 ---------------- */

  function setBackground(what) {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var color = what === 'transparent' ? null : what;
    engine.background = color;
    S.bg = what;
    try { localStorage.setItem('chahu.bg', what); } catch (e) { /* ignore */ }
    engine.invalidate();
    toast('画布背景：' + (what === 'transparent' ? '透明' : what));
  }

  /* ---------------- 选择 ---------------- */

  function toggleMarchingAnts() {
    S.antsOn = S.antsOn === false;
    engine.selectionAnimate(S.antsOn);
    engine.drawOverlay();
    toast(S.antsOn ? '显示选区边缘' : '隐藏选区边缘');
  }

  /** 把选区往外 / 往里推 n 像素（用现有蒙版做一次形态学近似） */
  function growSelection(n) { return shrinkGrow(Math.abs(n)); }
  function shrinkSelection(n) { return shrinkGrow(-Math.abs(n)); }

  function shrinkGrow(px) {
    if (!engine.hasSelection()) { toast('先用选区工具圈一块', 'err'); return; }
    var s = engine.ensureSelection();
    var tmp = document.createElement('canvas');
    tmp.width = engine.width; tmp.height = engine.height;
    var tc = tmp.getContext('2d');
    // 用多次 1px 的描边/擦除近似膨胀与腐蚀（够用，且两端跑出来一样）
    tc.drawImage(s.canvas, 0, 0);
    for (var i = 0; i < Math.abs(px); i++) {
      var one = document.createElement('canvas');
      one.width = engine.width; one.height = engine.height;
      var oc = one.getContext('2d');
      oc.drawImage(tmp, 0, 0);
      tc.globalCompositeOperation = px > 0 ? 'source-over' : 'destination-out';
      // 八个方向各画一次，等效于 3×3 的膨胀/腐蚀核
      var dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
      var off = document.createElement('canvas');
      off.width = engine.width; off.height = engine.height;
      var ofc = off.getContext('2d');
      ofc.drawImage(one, 0, 0);
      for (var d = 0; d < dirs.length; d++) tc.drawImage(off, dirs[d][0], dirs[d][1]);
      tc.globalCompositeOperation = 'source-over';
    }
    beginSelSnapshot();
    var sc = s.ctx;
    sc.save();
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'copy';
    sc.drawImage(tmp, 0, 0);
    sc.globalCompositeOperation = 'source-over';
    sc.restore();
    s.active = true;
    engine.refreshSelectionTint();
    if (!s.bbox) s.active = false;
    commitSelSnapshot();
    toast(px > 0 ? '选区已向外扩展 ' + px + ' 像素' : '选区已向内收缩 ' + Math.abs(px) + ' 像素');
  }

  /* ---------------- 窗口 ---------------- */

  /**
   * 界面缩放。用 `zoom` 作用在**两侧面板**的滚动容器上（顶栏/菜单栏/画布不缩，
   * 否则画面会被非整数缩放糊掉、画布坐标换算也要跟着改）。
   *
   * 以前只 zoom 了左栏，而且 `chahu.uiscale` 只写不读 —— 刷新就回 100%，
   * 观感像「缩放不生效」。现在两侧都缩，并且启动时由 `applyUiScale()` 恢复。
   */
  function applyUiScale(f) {
    var z = Math.abs(f - 1) < 1e-6 ? '' : String(f);
    ['#leftPanelScroll', '#rightPanelScroll'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.style.zoom = z;
    });
  }

  function setUiScale(f, opts) {
    S.uiScale = f;
    document.documentElement.style.setProperty('--ui-scale', String(f));
    if (!(opts && opts.silent)) {
      try { localStorage.setItem('chahu.uiscale', String(f)); } catch (e) { /* ignore */ }
    }
    applyUiScale(f);
    engine.resize();
    if (!(opts && opts.silent)) toast('界面缩放：' + Math.round(f * 100) + '%');
  }

  /** 开机恢复界面缩放（存在 chahu.uiscale 里） */
  function loadUiScale() {
    var raw = lsGet('chahu.uiscale', '');
    var f = parseFloat(raw);
    if (!isFinite(f) || f <= 0) return;
    setUiScale(Math.max(0.5, Math.min(2, f)), { silent: true });
  }

  function setCursorMode(mode) {
    S.cursorStyle = mode === 'dot' ? 'cross' : (mode === 'ring' ? 'ring' : 'auto');
    try { localStorage.setItem('chahu.cursor', S.cursorStyle); } catch (e) { /* ignore */ }
    updateBrushCursor();
    toast('画笔光标：' + (S.cursorStyle === 'ring' ? '大小圆形' : S.cursorStyle === 'cross' ? '圆点' : '智能'));
  }

  /* ---------------- 左右栏的收拉 ----------------
   * 两侧对称：收起来后在屏幕边上留一条窄条，点窄条拉回来。
   * 左栏以前只有菜单项和 Tab 键能收，界面上没有入口，等于「收不进去」；
   * 现在左栏顶部有 « 按钮、收起后左边有 » 窄条，和右栏一致。
   *
   * opts.persist === false → 只改这一次的状态，不写 localStorage
   * （窄屏自动收起 / 回到宽屏恢复偏好时用，别把自动行为记成用户偏好）。
   */
  function setLeftCollapsed(collapsed, opts) {
    var el = document.querySelector('aside.panel.left');
    var rail = $('#leftRail');
    if (!el) return;
    var on = !!collapsed;
    el.classList.toggle('hidden', on);
    if (rail) rail.classList.toggle('hidden', !on);
    S.leftPanelOpen = !on;
    if (!opts || opts.persist !== false) {
      try { localStorage.setItem('chahu.leftOpen', on ? '0' : '1'); } catch (e) { /* ignore */ }
    }
    syncDrawerBack();
    engine.resize();
  }

  function toggleLeftPanel(opts) {
    setLeftCollapsed(S.leftPanelOpen, opts);   // 现在开着 → 收；关着 → 开
    if (!opts || !opts.silent) toast(S.leftPanelOpen ? '已展开操作面板' : '已收起操作面板');
  }

  /** 窄屏下两栏是浮在画布上的抽屉，中间垫一层暗色遮罩；点它就关抽屉 */
  function syncDrawerBack() {
    var back = $('#drawerBack');
    if (!back) return;
    var anyOpen = !!(S.narrow && (S.leftPanelOpen || !S.sideCollapsed));
    back.classList.toggle('hidden', !anyOpen);
  }

  /** 窄屏里选完笔刷 / 工具就把左抽屉收掉，别挡着刚腾出来的画布 */
  function autoCloseLeftDrawer() {
    if (S.narrow && S.leftPanelOpen) setLeftCollapsed(true, { persist: false });
  }

  /** 窄屏 = 左右栏变成抽屉：进出都自动切一下，用户的桌面偏好留着不被污染 */
  function applyLayoutMode(force) {
    var narrow = NARROW_MQ.matches;
    if (!force && narrow === S.narrow) return;
    S.narrow = narrow;
    document.body.classList.toggle('layout-narrow', narrow);
    if (narrow) {
      setLeftCollapsed(true, { persist: false });
      setSideCollapsed(true, { persist: false });
      setQuickBarCollapsed(true, false);
    } else {
      setLeftCollapsed(lsGet('chahu.leftOpen', '1') === '0', { persist: false });
      setSideCollapsed(lsGet('chahu.side', '1') === '0', { persist: false });
    }
    syncDrawerBack();
    engine.resize();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () { });
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { toast('浏览器不允许全屏', 'err'); });
    }
  }

  /**
   * 「设置」。以前这里直接 openKeyDialog() —— 于是「设置」打开的是快捷键对话框，
   * 布局相关的开关反倒散在「窗口」菜单各处。现在设置打开布局设置面板；
   * 快捷键对话框仍有自己的入口（编辑 → 快捷键设置 / 其他 → 快捷键设置）。
   */
  function openSettings() {
    openLayoutSettings();
  }

  /* ================================================================
   * 画布上沿的快捷小菜单（照 SAI2 顶部那一条）
   * ================================================================ */

  var QB_COLLAPSED = 'chahu.quickbar.collapsed';

  /* ---- 快捷菜单自定义：每块功能（.qb-item[data-item]）可单独显隐，localStorage 记住 ---- */
  var QB_ITEMS_KEY = 'chahu.quickbar.items';
  var QB_ITEMS = [
    { key: 'undo',     label: '撤销 / 重做' },
    { key: 'view',     label: '视图方式（正常 / 灰度 / 翻转）' },
    { key: 'zoom',     label: '缩放' },
    { key: 'rot',      label: '旋转' },
    { key: 'steadier', label: '手抖修正' },
    { key: 'dim',      label: '他人笔触淡化' },
    { key: 'ruler',    label: '对称尺' },
    { key: 'ref',      label: '参考图' }
  ];

  function loadQbItems() {
    var m = {};
    try { m = JSON.parse(localStorage.getItem(QB_ITEMS_KEY) || '{}') || {}; } catch (e) { m = {}; }
    var out = {};
    QB_ITEMS.forEach(function (it) {
      out[it.key] = m[it.key] !== false;    // 没配置过的默认显示
    });
    return out;
  }

  function applyQbItems() {
    var m = loadQbItems();
    var list = document.querySelectorAll('#qbBody .qb-item[data-item]');
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.getAttribute('data-fixed')) continue;   // ⚙ 自定义入口永远显示
      w.classList.toggle('hidden', !m[w.getAttribute('data-item')]);
    }
  }

  function renderQbEditList() {
    var m = loadQbItems();
    var box = $('#qbEditList');
    if (!box) return;
    box.innerHTML = '';
    QB_ITEMS.forEach(function (it) {
      var row = document.createElement('label');
      row.className = 'check-row';
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = m[it.key];
      chk.addEventListener('change', function () {
        var cur = loadQbItems();
        cur[it.key] = chk.checked;
        try { localStorage.setItem(QB_ITEMS_KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ }
        applyQbItems();
      });
      var span = document.createElement('span');
      span.textContent = it.label;
      row.appendChild(chk);
      row.appendChild(span);
      box.appendChild(row);
    });
  }

  function openQbEdit() { renderQbEditList(); var m = $('#qbEditMask'); if (m) m.classList.remove('hidden'); }
  function closeQbEdit() { var m = $('#qbEditMask'); if (m) m.classList.add('hidden'); }

  /** 菜单里那项「手抖修正」：把快捷条拉出来并高亮一下，告诉用户去哪儿调 */
  function toggleQuickBarSteadier() {
    var bar = $('#quickBar');
    if (bar && bar.classList.contains('collapsed')) {
      bar.classList.remove('collapsed');
      $('#qbToggle').textContent = '▾';
      try { localStorage.setItem('chahu.quickbar.collapsed', '0'); } catch (e) { /* ignore */ }
    }
    var el = $('#qbSteadierText');
    if (el) {
      el.classList.add('attention');
      setTimeout(function () { el.classList.remove('attention'); }, 1200);
    }
    toast('手抖修正在画布上沿的快捷条里：− 0 ＋');
  }

  /** 快捷条折行 / 收起 / 自定义显隐都会变高 —— HUD 和回合卡挂在它下面，得跟着挪 */
  /**
   * 接龙阶段的「上沿状态条」开关 + 回放期间再省一点地方。
   *
   * v13 起，接龙的**每一个阶段**（写词 / 作画 / 猜词 / 回放 / 投票 / 小结算）都走这一套：
   *   · #stage.chain-strip → CSS 把 #gameHud 从「居中大白框」压成画布上沿那条 ≤40px 的
   *     半透明状态条（只留 阶段+倒计时 · 第 X/Y 手 · 已完成，右侧是房主那几颗按钮）。
   *     以前只有回放期间才收窄，写词 / 猜词时那个宽 460 高 139 的白面板就钉在画布正中。
   *   · #stage.replay-chrome → 回放 / 投票 / 小结算期间把快捷条收成一个小箭头，
   *     省下的高度全给中间那一格画面；用户自己的快捷条展开状态记在 S.cr.qbWasOpen 里，
   *     离开这些阶段就恢复原样。
   */
  function setChainStrip() {
    var stage = $('#stage');
    var g = S.game;
    var chain = isChainMode() && !!g && g.phase !== 'off';
    // 回放 / 投票 / 小结算：中间那一格画面最需要高度
    var compact = !!(chain && (g.phase === 'chain_reveal' || g.phase === 'chain_vote' ||
      g.phase === 'chain_score'));
    if (stage) {
      stage.classList.toggle('chain-strip', chain);
      stage.classList.toggle('replay-chrome', compact);
    }

    var open = false;
    var bar = $('#quickBar');
    if (bar) open = !bar.classList.contains('collapsed');
    if (compact) {
      if (S.cr.qbWasOpen === null || S.cr.qbWasOpen === undefined) S.cr.qbWasOpen = open;
      if (open) setQuickBarCollapsed(true, false);
    } else if (S.cr.qbWasOpen !== null && S.cr.qbWasOpen !== undefined) {
      if (S.cr.qbWasOpen && bar && bar.classList.contains('collapsed')) setQuickBarCollapsed(false, false);
      S.cr.qbWasOpen = null;
    }
    syncQbH();
  }

  function syncQbH() {
    var bar = $('#quickBar');
    if (!bar) return;
    document.documentElement.style.setProperty('--qb-h', bar.offsetHeight + 'px');
  }

  /**
   * 快捷条收起 / 拉开。提到模块级是因为布局模式切换时也要用
   * （窄屏默认收起，手机上一整排按钮会变成挡住画布的高塔）。
   * persist === false → 只是这次布局自动收的，别覆盖用户自己的选择。
   */
  function setQuickBarCollapsed(on, persist) {
    var bar = $('#quickBar');
    if (!bar) return;
    bar.classList.toggle('collapsed', !!on);
    var tg = $('#qbToggle');
    if (tg) {
      tg.textContent = on ? '▸' : '▾';
      tg.title = on ? '拉开快捷菜单' : '收起快捷菜单';
    }
    if (persist !== false) {
      try { localStorage.setItem(QB_COLLAPSED, on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    syncQbH();
  }

  function bindQuickBar() {
    var bar = $('#quickBar');
    if (!bar) return;

    function setCollapsed(on) { setQuickBarCollapsed(on, true); }
    setCollapsed(lsGet(QB_COLLAPSED, '0') === '1');
    $('#qbToggle').addEventListener('click', function () {
      setCollapsed(!bar.classList.contains('collapsed'));
    });

    var on = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    on('#qbUndo', function () { undo(); });
    on('#qbRedo', function () { redo(); });
    on('#qbZoomIn', function () { engine.setZoom(engine.scale * 1.25); });
    on('#qbZoomOut', function () { engine.setZoom(engine.scale / 1.25); });
    on('#qbZoomFit', function () { engine.fitView(); });
    on('#qbZoom100', function () { engine.setZoom(1); });
    on('#qbRotL', function () { engine.rotateBy(-15); });
    on('#qbRotR', function () { engine.rotateBy(15); });
    on('#qbRotReset', function () { engine.setRotation(0); updateQuickBar(); });
    on('#qbFlip', function () { engine.flipView(); });
    on('#qbSteadierUp', function () { nudgeSteadier(1); });
    on('#qbSteadierDown', function () { nudgeSteadier(-1); });
    on('#qbRuler', function () {
      var order = ['none', 'v', 'h', 'quad'];
      var next = order[(order.indexOf(S.sym) + 1) % order.length];
      setSymmetry(next);
    });
    on('#qbRef', function () { pickReferenceImage(); });
    on('#qbDimOthers', cycleDimMode);

    // 自定义显隐：进场先应用记住的配置，⚙ 打开编辑弹窗
    applyQbItems();
    on('#qbEditBtn', openQbEdit);
    on('#btnQbDone', closeQbEdit);
    on('#btnQbReset', function () {
      try { localStorage.removeItem(QB_ITEMS_KEY); } catch (e) { /* ignore */ }
      applyQbItems();
      renderQbEditList();
    });
    var qem = $('#qbEditMask');
    if (qem) qem.addEventListener('click', function (e) { if (e.target === qem) closeQbEdit(); });

    // 快捷条折行/收起/自定义显隐都会变高 —— HUD 和回合卡挂在它下面，跟着挪
    syncQbH();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(syncQbH).observe(bar);
    } else {
      window.addEventListener('resize', syncQbH);
    }

    // 缩放 / 旋转可以直接输入：回车或失焦生效
    function commitZoom() {
      var raw = String($('#qbZoomText').value).replace(/[^0-9.\-]/g, '');
      var pct = parseFloat(raw);
      if (!isFinite(pct) || pct <= 0) { updateQuickBar(); return; }
      engine.setZoom(Math.max(0.02, Math.min(32, pct / 100)));
      updateQuickBar();
    }
    function commitRot() {
      var raw = String($('#qbRotText').value).replace(/[^0-9.\-]/g, '');
      var deg = parseFloat(raw);
      if (!isFinite(deg)) { updateQuickBar(); return; }
      // 归一化到 -180..180，免得输入 720 之后数字越来越长
      deg = ((deg + 180) % 360 + 360) % 360 - 180;
      engine.setRotation(deg * Math.PI / 180);
      updateQuickBar();
    }
    $('#qbZoomText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitZoom(); this.blur(); }
      if (e.key === 'Escape') { updateQuickBar(); this.blur(); }
      e.stopPropagation();                    // 别让画布快捷键抢走输入
    });
    $('#qbZoomText').addEventListener('blur', commitZoom);
    $('#qbRotText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitRot(); this.blur(); }
      if (e.key === 'Escape') { updateQuickBar(); this.blur(); }
      e.stopPropagation();
    });
    $('#qbRotText').addEventListener('blur', commitRot);

    var vm = $('#qbViewMode');
    if (vm) {
      vm.addEventListener('change', function () {
        var v = vm.value;
        var wantFlip = (v === 'flipH');
        if (!!engine.flipX !== wantFlip) engine.flipView();
        engine.viewGray = (v === 'gray');
        engine.invalidate();
        updateQuickBar();
        toast({ normal: '视图：正常', gray: '视图：灰度预览', flipH: '视图：水平翻转' }[v] || v);
      });
    }
    engine.on('viewport', function () { updateQuickBar(); });
    updateQuickBar();
  }

  /** 快捷条上那些数字要跟着视图变 */
  function updateQuickBar() {
    var z = $('#qbZoomText');
    // 正在输入的时候不要覆盖用户敲的字
    if (z && document.activeElement !== z) z.value = Math.round((engine.scale || 1) * 100) + '%';
    var r = $('#qbRotText');
    if (r && document.activeElement !== r) r.value = ((engine.rot || 0) * 180 / Math.PI).toFixed(1) + '°';
    var f = $('#qbFlip');
    if (f) f.classList.toggle('active', !!engine.flipX);
    var vm = $('#qbViewMode');
    if (vm && !vm.dataset.busy) vm.value = engine.flipX ? 'flipH' : 'normal';
    var s = $('#qbSteadierText');
    if (s) s.textContent = String(Math.round(Number(S.brush.steadier) || 0));
  }

  /* ================================================================
   * 布局设置面板
   *
   * 为什么要有这个：布局相关的开关原先散在四处 ——
   *   面板显隐在「窗口 → 显示操作面板」的子菜单里、界面缩放在「窗口」另一项、
   *   栏宽只能靠拖那条 7px 的窄边、区块归属更是只能靠拖小节标题。
   * 结果就是「想调布局得先知道去哪儿调」。这里把它们集中成一张表，
   * 每项都实时生效 + 自动记住。
   *
   * 全部存 localStorage（仅本机）—— 布局是「这块屏幕」的事，
   * 同步到房间会和「各人屏幕尺寸不同」直接冲突，所以不碰协议。
   * ================================================================ */

  var UI_SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.5];

  function openLayoutSettings() {
    renderLayoutSettings();
    var m = $('#layoutMask');
    if (m) m.classList.remove('hidden');
  }
  function closeLayoutSettings() {
    var m = $('#layoutMask');
    if (m) m.classList.add('hidden');
  }

  /** 面板里的一行：左边标题 + 说明，右边塞控件 */
  function lsRow(title, desc, ctrl, isSub) {
    var row = document.createElement('div');
    row.className = 'ls-row' + (isSub ? ' sub' : '');
    var left = document.createElement('div');
    left.className = 'ls-text';
    var t = document.createElement('div');
    t.className = 'ls-title';
    t.textContent = title;
    left.appendChild(t);
    if (desc) {
      var d = document.createElement('div');
      d.className = 'ls-desc';
      d.textContent = desc;
      left.appendChild(d);
    }
    row.appendChild(left);
    if (ctrl) {
      var box = document.createElement('div');
      box.className = 'ls-ctrl';
      box.appendChild(ctrl);
      row.appendChild(box);
    }
    return row;
  }

  function lsGroup(title) {
    var g = document.createElement('div');
    g.className = 'ls-group';
    var h = document.createElement('div');
    h.className = 'ls-group-h';
    h.textContent = title;
    g.appendChild(h);
    return g;
  }

  function lsCheck(checked, onChange) {
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!checked;
    chk.addEventListener('change', function () { onChange(chk.checked); });
    return chk;
  }

  /** 栏宽滑块：拖动实时改，松手才写 localStorage（写盘别放进 input 里） */
  function lsWidthSlider(side) {
    var wrap = document.createElement('div');
    wrap.className = 'ls-slider';
    var rng = document.createElement('input');
    rng.type = 'range';
    rng.min = String(COL_MIN);
    rng.max = String(COL_MAX);
    rng.step = '2';
    var cur = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue(side === 'left' ? '--left-w' : '--right-w'), 10);
    if (!isFinite(cur) || cur <= 0) cur = side === 'left' ? 262 : 300;
    rng.value = String(Math.max(COL_MIN, Math.min(COL_MAX, cur)));
    var out = document.createElement('span');
    out.className = 'ls-num';
    out.textContent = rng.value + 'px';
    rng.addEventListener('input', function () {
      var w = setColW(side, Number(rng.value));
      out.textContent = w + 'px';
      engine.resize();
    });
    rng.addEventListener('change', function () {
      // 松手才落盘：和拖动条 finish() 用同一个 key、同一套结构
      var save = {};
      try { save = JSON.parse(lsGet('chahu.colW', '{}')) || {}; } catch (e) { save = {}; }
      save[side] = Number(rng.value);
      lsSet('chahu.colW', JSON.stringify(save));
    });
    wrap.appendChild(rng);
    wrap.appendChild(out);
    return wrap;
  }

  /** 把小节搬到指定栏（复用拖拽那套「改真实 DOM」的做法，再存偏好） */
  function moveSectionTo(id, side) {
    var el = sectionEl(id);
    if (!el) return;
    var target = side === 'right' ? $('#rightPanelScroll') : $('#leftPanelScroll');
    if (!target || el.parentNode === target) return;
    target.appendChild(el);
    if (side === 'right') el.classList.remove('hidden');   // 拖过去的小节别是收起的
    if (typeof updateRightScroll === 'function') updateRightScroll();
    savePanelOrder();
    engine.resize();
  }

  function renderLayoutSettings() {
    var box = $('#layoutSetBody');
    if (!box) return;
    box.innerHTML = '';

    /* ---- 1. 整栏显隐 ---- */
    var g1 = lsGroup('面板显隐');
    g1.appendChild(lsRow('左侧面板', '工具栏 / 笔刷 / 图层那一列', lsCheck(S.leftPanelOpen, function (v) {
      setLeftCollapsed(!v);
    })));
    g1.appendChild(lsRow('右侧面板', '右侧那一列（成员 / 聊天 / 拖过去的小节）', lsCheck(!S.sideCollapsed, function (v) {
      setSideCollapsed(!v);
    })));
    g1.appendChild(lsRow('快捷栏', '画布上沿那一条', lsCheck(!isQuickBarCollapsed(), function (v) {
      setQuickBarCollapsed(!v);
    })));
    box.appendChild(g1);

    /* ---- 2. 栏宽 ---- */
    var g2 = lsGroup('栏宽');
    g2.appendChild(lsRow('左栏宽度', '也可以直接拖面板边缘那条窄边', lsWidthSlider('left')));
    g2.appendChild(lsRow('右栏宽度', '', lsWidthSlider('right')));
    box.appendChild(g2);

    /* ---- 3. 界面缩放 ---- */
    var g3 = lsGroup('界面缩放');
    var sel = document.createElement('select');
    UI_SCALE_STEPS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = String(f);
      o.textContent = Math.round(f * 100) + '%' + (Math.abs(f - 1) < 1e-6 ? '（默认）' : '');
      sel.appendChild(o);
    });
    sel.value = String(S.uiScale || 1);
    sel.addEventListener('change', function () { setUiScale(Number(sel.value)); });
    // 菜单里的固定三档可能存进来别的值 —— 补一个动态项，免得 select 显示空白
    if (!UI_SCALE_STEPS.some(function (f) { return Math.abs(f - Number(sel.value)) < 1e-6; })) {
      var o2 = document.createElement('option');
      o2.value = sel.value;
      o2.textContent = Math.round(Number(sel.value) * 100) + '%';
      sel.appendChild(o2);
      sel.value = String(S.uiScale || 1);
    }
    g3.appendChild(lsRow('缩放比例', '只缩放两侧面板，画布与顶栏不动（免得画面被糊掉）', sel));
    box.appendChild(g3);

    /* ---- 4. 区块顺序与归属 ---- */
    var g4 = lsGroup('区块（可拖标题跨栏，也可在这里指定）');
    PANEL_DEFAULT_ORDER.forEach(function (id) {
      var meta = SECTION_META[id] || {};
      var el = sectionEl(id);
      var side = el && el.parentNode === $('#rightPanelScroll') ? 'right' : 'left';

      var ctrl = document.createElement('div');
      ctrl.className = 'ls-inline';

      // 归属：左 / 右
      var sw = document.createElement('select');
      [['left', '左侧'], ['right', '右侧']].forEach(function (p) {
        var o = document.createElement('option');
        o.value = p[0]; o.textContent = p[1];
        sw.appendChild(o);
      });
      sw.value = side;
      sw.addEventListener('change', function () { moveSectionTo(id, sw.value); });
      ctrl.appendChild(sw);

      // 显隐
      var lbl = document.createElement('label');
      lbl.className = 'ls-mini';
      var chk = lsCheck(!isSectionHidden(id), function (v) {
        var cur = isSectionHidden(id);
        if (cur === !v) return;
        toggleSection(id);          // 只在真的要变时点，免得把状态写反
      });
      lbl.appendChild(chk);
      var sp = document.createElement('span');
      sp.textContent = '显示';
      lbl.appendChild(sp);
      ctrl.appendChild(lbl);

      g4.appendChild(lsRow(meta.name || id, meta.desc || '', ctrl, true));
    });
    box.appendChild(g4);
  }

  /** 区块的中文名与说明（菜单里那套名字，这里复用同一批词） */
  var SECTION_META = {
    nav:      { name: '导航器',   desc: '缩略图 + 视口取景框' },
    tools:    { name: '工具栏',   desc: '选择 / 画笔 / 橡皮这些' },
    brushes:  { name: '笔刷栏',   desc: '笔刷预设列表' },
    brush:    { name: '画笔参数', desc: '大小 / 硬度 / 手抖修正等' },
    fx:       { name: '效果',     desc: '纸张质感与特效' },
    color:    { name: '颜色',     desc: '色轮 / 色板' },
    layers:   { name: '图层',     desc: '图层列表与混合模式' }
  };

  /** 快捷栏现在是不是收起的（读 DOM class，和 setQuickBarCollapsed 一处为准） */
  function isQuickBarCollapsed() {
    var bar = $('#quickBar');
    return !!(bar && bar.classList.contains('collapsed'));
  }

  function bindLayoutSettings() {
    bindClick('#btnLayoutClose', closeLayoutSettings);
    bindClick('#btnLayoutOk', closeLayoutSettings);
    var m = $('#layoutMask');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) closeLayoutSettings(); });

    // 只重置栏宽（不影响区块顺序）
    bindClick('#btnLayoutResetWidth', function () {
      try { localStorage.removeItem('chahu.colW'); } catch (e) { /* ignore */ }
      document.documentElement.style.removeProperty('--left-w');
      document.documentElement.style.removeProperty('--right-w');
      engine.resize();
      renderLayoutSettings();
      toast('栏宽已重置', 'ok');
    });
    // 恢复默认布局 = 原有的 resetPanels（现已一并清栏宽）+ 缩放与折叠
    bindClick('#btnLayoutReset', function () {
      resetPanels();
      setUiScale(1);
      PANEL_DEFAULT_ORDER.forEach(function (id) {
        var el = sectionEl(id);
        if (el && el.classList.contains('hidden')) toggleSection(id);
      });
      renderLayoutSettings();
    });
  }

  /** 极简的「有才绑」—— 这些按钮在 index.html 里都在，缺了也不该炸 */
  function bindClick(sel, fn) {
    var el = $(sel);
    if (el) el.addEventListener('click', fn);
  }

  /* ================================================================
   * 关于：用户准则 / 风险须知 / 更新检测
   * ================================================================ */

  var REPO = 'PainterAnkry/chahui';
  var ABOUT_TABS = {
    terms: [
      '<h4>一句话</h4>',
      '<p>茶绘是给你和朋友一起画画用的工具。别拿它做会让别人难受的事。</p>',
      '<h4>你可以</h4>',
      '<ul>',
      '<li>自己开房间、随便画、把链接发给朋友一起画。</li>',
      '<li>画任何你有权画的内容，商用与否由你自己负责。</li>',
      '<li>把茶绘的源码拿去改、拿去分发（MIT 许可，见「致谢与许可」）。</li>',
      '</ul>',
      '<h4>请不要</h4>',
      '<ul>',
      '<li><span class="warn">上传或绘制违法违规内容</span>，包括但不限于未成年人相关、暴力恐怖、侵犯他人隐私的内容。</li>',
      '<li>在没拿到授权的情况下，把别人的画作、照片、素材传进房间一起改。</li>',
      '<li>拿它当图床、当网盘，或者塞入与绘画无关的大量数据。</li>',
      '<li>对服务端做压力测试、扫描、入侵，或者想办法绕过房间密码。</li>',
      '</ul>',
      '<h4>房间是你自己开的</h4>',
      '<p>房主有责任管理自己房间里的人和内容。公开房间所有人都能进，重要内容请用密码房间。</p>'
    ].join(''),
    risk: [
      '<h4>请先读完这一页</h4>',
      '<p>茶绘是一个小项目，<span class="warn">请把它当成「和熟人一起画画的便利工具」，而不是可靠的存储服务</span>。</p>',
      '<h4>你画的画可能会丢</h4>',
      '<ul>',
      '<li>房间数据存在服务端，<span class="warn">没有云端备份</span>。服务端崩了、磁盘坏了、房间太久没人管被自动回收了，内容就没了。</li>',
      '<li>空房间（没人在线 + 一笔没画）会被自动清理；有内容的房间闲置太久也会被回收。</li>',
      '<li><b>重要的画请随时「导出 PNG」存到你自己电脑上。</b></li>',
      '</ul>',
      '<h4>联机不是加密的</h4>',
      '<ul>',
      '<li>默认走明文 <code>ws://</code> / <code>http://</code>。同一网络里的其他人、或者中间的路由，理论上能看到你在画什么、聊什么。</li>',
      '<li>房间密码只是「进房门槛」，<span class="warn">不是加密</span>，别用它保护敏感内容。</li>',
      '<li>用 <code>npm run expose</code> 把服务端穿到公网时，任何拿到链接的人都能访问 —— 不画了就把它关掉。</li>',
      '</ul>',
      '<h4>协作是「所有人一起改」</h4>',
      '<ul>',
      '<li>同一个房间里，任何人都能改任何图层。没有权限分级，也没有「锁定别人的图层」。</li>',
      '<li>别人可以撤销自己画的，也可以清空图层；房主可以把整个房间解散。</li>',
      '<li>要一起画一幅正式作品，建议先说好分工，或者各自开房间。</li>',
      '</ul>',
      '<h4>导入的笔刷与字体</h4>',
      '<ul>',
      '<li>导入的 <code>.abr</code> / <code>.sut</code> 笔刷版权归原作者，请确认你有权使用；茶绘不会、也无法帮你判断。</li>',
      '<li>导入只读取笔尖形状与间距，不会修改原文件。</li>',
      '</ul>',
      '<h4>免责</h4>',
      '<p>本项目以 MIT 许可开源，<b>按「现状」提供，不附带任何担保</b>。因使用它造成的作品丢失、数据泄露或其他损失，作者不承担责任。</p>'
    ].join(''),
    credits: [
      '<h4>许可</h4>',
      '<p>本项目以 <b>MIT 许可</b> 开源：可以自由使用、修改、分发，保留版权声明即可。完整文本见仓库里的 <code>LICENSE</code>。</p>',
      '<h4>参考与致谢</h4>',
      '<ul>',
      '<li>界面与笔刷体系参照 <b>PaintTool SAI Ver.2</b> 的公开操作习惯 —— 只是「用着像」，与 SAI 官方无任何关系。</li>',
      '<li><code>.abr</code> 的二进制布局参考了 <a href="https://github.com/Agamnentzar/ag-psd">ag-psd</a> 的实现，并用一批真实笔刷文件校准过。</li>',
      '<li><code>.sut</code>（CSP）的「内嵌 PNG 笔尖」思路参考了 <a href="https://github.com/Leon-Schoenbrunn/CSP2PC">CSP2PC</a>。</li>',
      '<li>公网穿透用 <a href="https://github.com/cloudflare/cloudflared">cloudflared</a> 的快速隧道。</li>',
      '</ul>',
      '<h4>第三方</h4>',
      '<ul>',
      '<li>Electron（桌面端外壳）、ws（WebSocket 服务端）—— 各自遵循其原许可。</li>',
      '</ul>'
    ].join('')
  };

  function openAbout() {
    var mask = $('#aboutMask');
    if (!mask) return;
    var v = (global.chahuDesktop && global.chahuDesktop.isDesktop && global.chahuDesktop.getInfo)
      ? null : null;
    $('#aboutVer').textContent = global.CHAHU_CONFIG && global.CHAHU_CONFIG.appVersion
      ? global.CHAHU_CONFIG.appVersion : '—';
    showAboutTab('terms');
    mask.classList.remove('hidden');
    void v;
    checkUpdate();
  }

  function showAboutTab(name) {
    $$('.about-tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.atab === name);
    });
    $('#aboutBody').innerHTML = ABOUT_TABS[name] || '';
  }

  /**
   * 更新检测：读 GitHub 的最新 release 和当前版本比。
   * 只为「提示有新版」，不自动下载、不自动安装。
   */
  /** 这台机器是什么平台、是不是桌面端 —— 决定挑哪个安装包、怎么下 */
  var updateInfo = { platform: '', desktop: false };
  /** 本次检查出来的可下载资产（null = 没有 / 还没检查） */
  var updateReady = null;

  /**
   * 现在该按哪个平台挑包。
   * 桌面端问主进程（它当然知道自己在哪个系统上跑）；网页版只能按 UA 猜。
   */
  function detectPlatform() {
    var ua = String((global.navigator && global.navigator.userAgent) || '');
    var guess = /Mac/i.test(ua) ? 'darwin'
      : (/Linux/i.test(ua) && !/Android/i.test(ua)) ? 'linux' : 'win32';
    if (global.chahuDesktop && global.chahuDesktop.getInfo) {
      updateInfo.desktop = true;
      return global.chahuDesktop.getInfo().then(function (i) {
        updateInfo.platform = (i && i.platform) || guess;
        return updateInfo.platform;
      }).catch(function () { updateInfo.platform = guess; return guess; });
    }
    updateInfo.desktop = false;
    updateInfo.platform = guess;
    return Promise.resolve(guess);
  }

  /**
   * 从 release 的资产列表里挑出「这台机器该下的那一个」。
   *
   * **纯函数**：不碰 DOM、不碰网络，所以能直接拿假数据测（见 tools/test-update.js）。
   * 认不出平台、或者这个 release 里根本没有像样的包（比如只发了源码 zip）时返回 null，
   * 调用方退回「去 Releases 页面」那条路。
   *
   * Windows 上**安装包优先于便携版**：安装包带卸载器和开始菜单项，
   * 是给「本来就在用的人」升级的那条路；便携版是自己解压用的。
   */
  function pickUpdateAsset(rel, platform) {
    var list = ((rel && rel.assets) || []).filter(function (a) {
      return a && a.name && a.browser_download_url;
    });
    if (!list.length) return null;
    var plat = String(platform || '').toLowerCase();
    // 安卓：release 里没有 APK 资产，挑什么都是错的 —— 返回 null 走「去 Releases 页」
    if (plat === 'android') return null;
    var want;
    if (plat === 'darwin' || plat === 'mac' || plat === 'macos') {
      want = [/\.dmg$/i, /\.zip$/i];
    } else if (plat === 'linux') {
      want = [/\.AppImage$/i, /\.tar\.gz$/i, /\.deb$/i];
    } else {
      want = [/^chahui-setup-.*\.exe$/i, /-setup-.*\.exe$/i, /^chahui-portable-.*\.exe$/i, /\.exe$/i];
    }
    for (var i = 0; i < want.length; i++) {
      for (var j = 0; j < list.length; j++) {
        if (want[i].test(list[j].name)) return list[j];
      }
    }
    return null;
  }

  /**
   * 真正把包拿下来。
   * 桌面端交给主进程 —— 渲染进程 fetch 跨域的 GitHub 资产会被 CORS 挡掉，
   * 主进程没有这个限制，还能顺手把下好的安装包交给系统跑。
   * 网页版先试「抓成 blob 再存」（页面不跳转）；GitHub 的资产下载是跨域的、
   * 拿不到 CORS 头时 fetch 会直接失败，那就退回一个隐藏的 <a download>：
   * 响应本身是 attachment，浏览器会直接下载，同样不会把人带去 GitHub 页面。
   */
  async function downloadUpdate(url, name) {
    if (updateInfo.desktop && global.chahuDesktop.downloadUpdate) {
      return await global.chahuDesktop.downloadUpdate(url, name);
    }
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = global.URL.createObjectURL(blob);
      a.download = name || 'chahui-update';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { global.URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return { ok: true, via: 'blob' };
    } catch (e) {
      var link = document.createElement('a');
      link.href = url;
      link.download = name || '';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(function () { link.remove(); }, 5000);
      return { ok: true, via: 'link' };
    }
  }

  /** 点「下载更新」之后的事：进度、结果、出错提示 */
  async function runUpdateDownload(btn) {
    if (!updateReady) return;
    var msg = $('#aboutUpdateMsg');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在下载…';
    msg.textContent = '正在准备下载 ' + updateReady.name + '…';
    var off = null;
    if (global.chahuDesktop && global.chahuDesktop.onUpdateProgress) {
      off = global.chahuDesktop.onUpdateProgress(function (p) {
        if (p && typeof p.percent === 'number') {
          msg.textContent = '正在下载 ' + updateReady.name + '… ' + Math.round(p.percent * 100) + '%';
        }
      });
    }
    try {
      var res = await downloadUpdate(updateReady.url, updateReady.name);
      if (res && res.mirror) toast('直连 GitHub 没成功，已改用镜像下载', 'ok', 3600);
      if (!res || !res.ok) throw new Error((res && res.error) || '下载失败');
      if (res.launched) {
        msg.textContent = '安装包已下载，正在启动安装程序…';
        toast('正在启动安装程序', 'ok', 3200);
      } else if (res.path) {
        msg.textContent = '已下载到 ' + res.path + '（打开它就能安装）';
        $('#aboutUpdateMsg').title = res.path;
        toast('更新已下载', 'ok', 3200);
      } else {
        msg.textContent = '已开始下载 ' + updateReady.name;
      }
    } catch (e) {
      msg.textContent = '下载失败（' + ((e && e.message) || e) +
        '）。可以点上面的链接去 Releases 页面手动下载。';
      toast('更新下载失败', 'err', 3600);
    }
    if (off) off();
    btn.disabled = false;
    btn.textContent = label;
  }

  /**
   * 更新检测：读 GitHub 的最新 release，和当前版本比。
   * 有新版本时**直接把该下的那个包找出来并提供下载**，
   * 不用跳去 Releases 页面自己找文件名 —— 那一步正是最容易下错的地方。
   */
  function checkUpdate() {
    var box = $('#aboutUpdate');
    var msg = $('#aboutUpdateMsg');
    var btn = $('#btnDoUpdate');
    var cur = (global.CHAHU_CONFIG && global.CHAHU_CONFIG.appVersion) || '0.0.0';
    box.classList.remove('has-new');
    updateReady = null;
    if (btn) { btn.classList.add('hidden'); btn.onclick = null; btn.disabled = false; btn.textContent = '下载更新'; }
    msg.removeAttribute('title');
    msg.textContent = '正在检查更新…';
    var ac = global.AbortController ? new global.AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, 8000);
    return detectPlatform().then(function () {
      return fetch('https://api.github.com/repos/' + REPO + '/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' }, signal: ac ? ac.signal : undefined });
    })
      .then(function (r) { clearTimeout(timer);
        if (!r.ok) throw new Error('GitHub 返回 ' + r.status);
        return r.json();
      })
      .then(function (rel) {
        var tag = String(rel.tag_name || '').replace(/^v/, '');
        if (!tag) throw new Error('没有读到版本号');
        if (cmpVer(tag, cur) <= 0) {
          msg.textContent = '已经是最新版（v' + cur + '）';
          return;
        }
        var asset = pickUpdateAsset(rel, updateInfo.platform);
        if (!asset) {
          // 这个 release 里没有认得出的安装包 → 老实给个入口，别假装能一键下
          msg.innerHTML = '有新版本 <b>v' + esc(tag) + '</b> 可用（当前 v' + esc(cur) +
            '），但这个版本里没有认得出的安装包 <a href="' + esc(rel.html_url || '') +
            '" target="_blank" rel="noreferrer">去 Releases 页面看看</a>';
          return;
        }
        updateReady = { url: asset.browser_download_url, name: asset.name };
        box.classList.add('has-new');
        msg.innerHTML = '有新版本 <b>v' + esc(tag) + '</b> 可用（当前 v' + esc(cur) + '）' +
          '<br><span class="hint">将下载 ' + esc(asset.name) +
          (asset.size ? '（' + fmtBytes(asset.size) + '）' : '') + '</span>';
        if (btn) {
          btn.classList.remove('hidden');
          btn.textContent = updateInfo.desktop ? '下载并安装' : '直接下载';
          btn.onclick = function () { runUpdateDownload(btn); };
        }
      })
      .catch(function (e) {
        clearTimeout(timer);
        msg.textContent = '检查更新失败（' + (e && e.name === 'AbortError' ? '超时' : (e && e.message)) +
          '）—— 可能没联网，或访问 GitHub 受限。也可以直接去 ' +
          '<a href="https://github.com/' + REPO + '/releases" target="_blank" rel="noreferrer">Releases 页面</a> 看。';
      });
  }

  function cmpVer(a, b) {
    var pa = String(a).split('.').map(Number);
    var pb = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /* ================================================================
   * 色调调整（滤镜）
   *
   * 预览走的是 engine.layerOverride：把当前图层换成「滤镜后」的那份像素，
   * 其余图层照常合成 —— 所以**画布上看到的就是最终结果**，不是另画一张小图糊弄。
   * 确定时才把结果作为一次像素操作发给服务端（和别人同步、也能撤销）。
   * ================================================================ */

  function toneOpts() {
    return {
      brightness: Number($('#toneBright').value),
      contrast: Number($('#toneContrast').value),
      hue: Number($('#toneHue').value),
      saturation: Number($('#toneSat').value)
    };
  }

  function toneSyncLabels() {
    var o = toneOpts();
    $('#toneBrightVal').textContent = o.brightness;
    $('#toneContrastVal').textContent = o.contrast;
    $('#toneHueVal').textContent = o.hue;
    $('#toneSatVal').textContent = o.saturation;
  }

  /* ---------------- 色阶 ---------------- */

  function levelsOpts() {
    return {
      inBlack: Number($('#lvInBlack').value),
      inWhite: Number($('#lvInWhite').value),
      gamma: Number($('#lvGamma').value) / 100,
      outBlack: Number($('#lvOutBlack').value),
      outWhite: Number($('#lvOutWhite').value)
    };
  }

  function levelsSyncLabels() {
    var o = levelsOpts();
    $('#lvInBlackVal').textContent = o.inBlack;
    $('#lvInWhiteVal').textContent = o.inWhite;
    $('#lvGammaVal').textContent = o.gamma.toFixed(2);
    $('#lvOutBlackVal').textContent = o.outBlack;
    $('#lvOutWhiteVal').textContent = o.outWhite;
  }

  function openLevelsDialog() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var layer = engine.activeLayer();
    if (!layer) return;
    if (engine.transform) { toast('先按 Enter 确定当前的变换'); return; }
    if (!layer.baseImage && !layer.strokes.length) { toast('「' + layer.name + '」上还没有内容', 'err'); return; }
    S.filterMode = 'levels';
    S.toneLayerId = layer.id;
    ['#lvInBlack', '#lvInWhite', '#lvOutBlack', '#lvOutWhite'].forEach(function (id, i) {
      $(id).value = i % 2 === 0 ? 0 : 255;
    });
    $('#lvGamma').value = 100;
    levelsSyncLabels();
    $('#levelsNote').textContent = '作用于图层「' + layer.name + '」。画布上就是最终效果。';
    updateTonePreview();
    $('#levelsMask').classList.remove('hidden');
  }

  /** 自动色阶：按当前图层的亮度直方图掐掉两头 0.5% */
  function levelsAuto() {
    var id = S.toneLayerId || (engine.activeLayer() || {}).id;
    if (!id) return;
    var raw = engine.renderLayerRaw(id);
    var d = raw.getContext('2d').getImageData(0, 0, raw.width, raw.height).data;
    var hist = new Uint32Array(256);
    var total = 0;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      var lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      hist[lum]++;
      total++;
    }
    if (!total) { toast('这一层是空的', 'err'); return; }
    var cut = Math.max(1, Math.floor(total * 0.005));
    var lo = 0, hi = 255, acc = 0, k;
    for (k = 0; k < 256; k++) { acc += hist[k]; if (acc >= cut) { lo = k; break; } }
    acc = 0;
    for (k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= cut) { hi = k; break; } }
    if (hi <= lo) hi = Math.min(255, lo + 1);
    $('#lvInBlack').value = lo;
    $('#lvInWhite').value = hi;
    $('#lvGamma').value = 100;
    levelsSyncLabels();
    updateTonePreview();
    toast('自动色阶：输入 ' + lo + ' ~ ' + hi, 'ok');
  }

  function closeLevelsDialog(apply) {
    var id = S.toneLayerId;
    S.toneLayerId = null;
    engine.layerOverride = null;
    engine.invalidate();
    $('#levelsMask').classList.add('hidden');
    if (!apply || !id) return;
    var o = levelsOpts();
    if (global.ChaFilters.isLevelsIdentity(o)) { toast('没有改动'); return; }
    var filtered = global.ChaFilters.levelsCanvas(engine.renderLayerRaw(id), o);
    net.send(P.C2S.LAYER_PIXELS, {
      layerId: id, png: filtered.toDataURL('image/png'), upToSeq: engine.seq, label: '色阶'
    });
    pushOp({ type: 'pixels', layerId: id, label: '色阶', before: null, after: null });
    toast('已应用色阶：输入 ' + o.inBlack + '~' + o.inWhite + '　中间调 ' + o.gamma.toFixed(2) +
      '　输出 ' + o.outBlack + '~' + o.outWhite, 'ok', 3800);
  }

  /* ---------------- 高斯模糊 ---------------- */

  function blurRadius() { return Number($('#blurRadius').value); }

  function openBlurDialog() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var layer = engine.activeLayer();
    if (!layer) return;
    if (engine.transform) { toast('先按 Enter 确定当前的变换'); return; }
    if (!layer.baseImage && !layer.strokes.length) { toast('「' + layer.name + '」上还没有内容', 'err'); return; }
    S.filterMode = 'blur';
    S.toneLayerId = layer.id;
    $('#blurNote').textContent = '作用于图层「' + layer.name + '」。画布上就是最终效果。';
    $('#blurRadiusVal').textContent = blurRadius().toFixed(1);
    updateTonePreview();
    $('#blurMask').classList.remove('hidden');
  }

  function closeBlurDialog(apply) {
    var id = S.toneLayerId;
    S.toneLayerId = null;
    engine.layerOverride = null;
    engine.invalidate();
    $('#blurMask').classList.add('hidden');
    if (!apply || !id) return;
    var r = blurRadius();
    if (r < 0.05) { toast('半径为 0，没有改动'); return; }
    var filtered = global.ChaFilters.blurCanvas(engine.renderLayerRaw(id), r).canvas;
    net.send(P.C2S.LAYER_PIXELS, {
      layerId: id, png: filtered.toDataURL('image/png'), upToSeq: engine.seq, label: '高斯模糊'
    });
    pushOp({ type: 'pixels', layerId: id, label: '高斯模糊', before: null, after: null });
    toast('已应用高斯模糊：半径 ' + r.toFixed(1) + 'px', 'ok', 3400);
  }

  function openToneDialog() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var layer = engine.activeLayer();
    if (!layer) return;
    if (engine.transform) { toast('先按 Enter 确定当前的变换'); return; }
    if (!layer.baseImage && !layer.strokes.length) { toast('「' + layer.name + '」上还没有内容', 'err'); return; }
    S.filterMode = 'tone';
    S.toneLayerId = layer.id;
    ['#toneBright', '#toneContrast', '#toneHue', '#toneSat'].forEach(function (id) { $(id).value = 0; });
    toneSyncLabels();
    $('#toneNote').textContent = '作用于图层「' + layer.name + '」。画布上就是最终效果，直接拖滑块看。';
    updateTonePreview();
    $('#toneMask').classList.remove('hidden');
  }

  /** 把当前滑块的结果做成图层覆盖，交给引擎去合成 */
  function updateTonePreview() {
    if (!S.toneLayerId) return;
    var layer = engine.getLayer(S.toneLayerId);
    if (!layer) return;
    var raw = engine.renderLayerRaw(S.toneLayerId);        // 该图层现在的样子（含未提交笔迹）
    if (S.filterMode === 'blur') {
      var br = blurRadius();
      engine.layerOverride = br < 0.05 ? null
        : { layerId: S.toneLayerId, canvas: global.ChaFilters.blurCanvas(raw, br).canvas };
    } else if (S.filterMode === 'levels') {
      var lo = levelsOpts();
      engine.layerOverride = global.ChaFilters.isLevelsIdentity(lo)
        ? null
        : { layerId: S.toneLayerId, canvas: global.ChaFilters.levelsCanvas(raw, lo) };
    } else {
      var o = toneOpts();
      engine.layerOverride = global.ChaFilters.isIdentity(o)
        ? null
        : { layerId: S.toneLayerId, canvas: global.ChaFilters.toneCanvas(raw, o) };
    }
    engine.invalidate();
  }

  function closeToneDialog(apply) {
    var id = S.toneLayerId;
    S.toneLayerId = null;
    engine.layerOverride = null;
    engine.invalidate();
    $('#toneMask').classList.add('hidden');
    if (!apply || !id) return;
    var o = toneOpts();
    if (global.ChaFilters.isIdentity(o)) { toast('没有改动'); return; }
    var layer = engine.getLayer(id);
    if (!layer) return;
    // 重新算一遍（预览那份是同一套代码，但这里要的是「确定时」的滑块值）
    var filtered = global.ChaFilters.toneCanvas(engine.renderLayerRaw(id), o);
    net.send(P.C2S.LAYER_PIXELS, {
      layerId: id,
      png: filtered.toDataURL('image/png'),
      upToSeq: engine.seq,
      label: '色调调整'
    });
    pushOp({
      type: 'pixels', layerId: id,
      label: '色调调整',
      before: null, after: null
    });
    toast('已应用：亮度 ' + o.brightness + '｜对比度 ' + o.contrast +
      '｜色相 ' + o.hue + '｜饱和度 ' + o.saturation, 'ok', 3800);
  }

  /* ================================================================
   * 尺子（SAI2 的直线 / 椭圆 / 平行线 / 同心圆 / 集中线）
   *
   * 交互：从「尺子」菜单选一种 → 在画布上拖一下定义尺子 → 之后的笔画自动吸附。
   * 定义尺子的那一次拖拽不会画东西（状态栏会提示），定义完自动回到画笔。
   * ================================================================ */

  /** 尺子相关的状态栏提示（不覆盖已有的 setStatus） */
  function updateRulerStatus() {
    if (engine.ruler && engine.ruler.type) {
      var info = global.ChaRuler.typeOf(engine.ruler.type);
      setStatus('尺子：' + info.name + '（间隔 ' + Math.round(engine.ruler.spacing) + 'px）');
    } else {
      setStatus('就绪');
    }
  }

  function armRuler(type) {
    var info = global.ChaRuler.typeOf(type);
    if (!info) return;
    S.rulerArm = { type: type, p0: null };
    $('#view').style.cursor = 'crosshair';
    setStatus('尺子·' + info.name + '：' + info.hint + '（Esc 取消）');
    toast(info.name + '：在画布上拖一下定义尺子', 'ok', 3600);
  }

  function cancelRulerArm() {
    if (!S.rulerArm) return;
    S.rulerArm = null;
    $('#view').style.cursor = '';
    updateRulerStatus();
  }

  /** 定义完成 */
  function commitRuler(type, a, b) {
    engine.ruler = global.ChaRuler.make(type, a, b);
    engine.showRuler = true;
    S.rulerArm = null;
    S.rulerOn = true;
    try {
      localStorage.setItem('chahu.ruler.on', '1');
    } catch (e) { /* ignore */ }
    $('#view').style.cursor = '';
    engine.drawOverlay();
    updateRulerStatus();
    var info = global.ChaRuler.typeOf(type);
    toast(info.name + ' 已就位，之后的笔画会自动吸附（尺子菜单里可重置）', 'ok', 4200);
  }

  function clearRuler() {
    engine.ruler = null;
    S.rulerArm = null;
    S.rulerOn = false;
    try { localStorage.setItem('chahu.ruler.on', '0'); } catch (e) { /* ignore */ }
    engine.drawOverlay();
    updateRulerStatus();
    toast('已重置尺子');
  }

  function toggleRulerVisible(on) {
    engine.showRuler = (on === undefined) ? (engine.showRuler === false) : !!on;
    S.rulerOn = engine.showRuler;
    try { localStorage.setItem('chahu.ruler.on', engine.showRuler ? '1' : '0'); } catch (e) { /* ignore */ }
    engine.drawOverlay();
    toast(engine.showRuler ? '显示尺子' : '隐藏尺子');
  }

  /** 尺子定义中：把拖拽的两个端点变成尺子 */
  function rulerDragMove(dp) {
    if (!S.rulerArm) return;
    if (!S.rulerArm.p0) return;
    // 实时画一条橡皮筋，让用户知道自己在拖什么
    engine.rulerPreview = {
      type: S.rulerArm.type,
      p0: S.rulerArm.p0,
      p1: { x: dp.x, y: dp.y }
    };
    engine.drawOverlay();
    void dp;
  }


  /* ================================================================
   * 文字工具 / 文字图层
   *
   * 文字不是新的图层类型，而是**一种特殊笔迹**（tool: 'text'）——
   * 这样它天然跟着笔迹历史走：能同步、能撤销、能回放，不用另造一套机制。
   * 放文字时自动新建一个图层（图层名就是文字内容），也就是「文字图层」。
   * ================================================================ */

  function buildTextFamilies() {
    var sel = $('#textFamily');
    if (!sel || sel.options.length) return;
    [['sans', '黑体 / 无衬线'], ['serif', '衬线'], ['mono', '等宽'],
      ['hei', '微软雅黑'], ['song', '宋体'], ['kai', '楷体']].forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0];
      o.textContent = p[1];
      sel.appendChild(o);
    });
    sel.value = 'sans';
  }

  function textOpts() {
    return {
      text: P.normalizeText($('#textInput').value),
      fontFamily: $('#textFamily').value,
      fontSize: Number($('#textSize').value) || 48,
      bold: $('#textBold').checked,
      italic: $('#textItalic').checked,
      align: $('#textAlign').value,
      lineHeight: 1.35
    };
  }

  /** 点画布上的位置 → 记下来，等用户在对话框里点「放到画布上」 */
  function placeTextAt(dp) {
    var _bm = canvasBlockMsg();
    if (_bm) { toast(_bm, 'err', 1600); return; }
    S.textAt = { x: dp.x, y: dp.y };
    buildTextFamilies();
    $('#textMask').classList.remove('hidden');
    setTimeout(function () { $('#textInput').focus(); }, 60);
    var el = document.querySelector('#textMask .hint');
    if (el) {
      el.textContent = '将放在 (' + Math.round(dp.x) + ', ' + Math.round(dp.y) + ')。' +
        '文字会新建一个图层，并作为一种笔迹同步 —— 别人也看得到、也能一起撤。';
    }
  }

  /**
   * 真正落笔：新建一个图层，然后把文字作为一条 text 笔迹发出去。
   * 走的是普通笔迹通道，所以跨端一致 / 撤销 / 回放全都是现成的。
   */
  function commitText() {
    var o = textOpts();
    if (!o.text.trim()) { toast('还没有输入文字', 'err'); return; }
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    var at = S.textAt || { x: engine.width / 2, y: engine.height / 2 };
    $('#textMask').classList.add('hidden');

    // 每次都建新图层 —— 用户要的就是「文字图层」：一个文件里放几段文字，
    // 每段各自一层，挪动 / 隐藏 / 删掉互不影响。
    var cur = engine.activeLayer();
    var needLayer = true;
    var layerId = cur ? cur.id : null;
    if (needLayer) {
      layerId = 'L_' + Math.random().toString(36).slice(2, 12);
      net.send(P.C2S.LAYER_ADD, { name: o.text.split('\n')[0].slice(0, 12) || '文字', id: layerId });
    }

    var doIt = function () {
      var info = strokeInfo('t_' + Date.now(), { id: layerId }, false, {
        text: o.text, fontFamily: o.fontFamily, fontSize: o.fontSize,
        bold: o.bold, italic: o.italic, align: o.align, lineHeight: o.lineHeight
      });
      info.tool = 'text';
      info.size = o.fontSize;
      var st = engine.beginStroke(info);
      // 注意：newStroke 里 points 是写死的 []，info.points 会被丢掉 ——
      // 锚点必须用 addPoints 摆进去，否则这一笔没有点、文字画不出来。
      engine.addPoints(st.id, [[Math.round(at.x), Math.round(at.y), 1]]);
      engine.endStroke(st.id, ++engine.seq);
      net.send(P.C2S.STROKE_BEGIN, info);
      net.send(P.C2S.STROKE_END, { id: st.id });
      // 走的是普通笔迹通道，所以撤销栈这里也要照 normal 那样记一条 ——
      // 漏了它，文字就成了「画上去撤不掉」的东西。
      S.myUndo.push(st.id);
      S.myRedo.length = 0;
      pushOp({ type: 'stroke', id: st.id });
      renderHistory();
      toast('文字已放到画布上', 'ok', 3000);
    };
    if (needLayer) waitForLayer(layerId, doIt);   // 等图层真的到位，别拿固定 sleep 赌
    else doIt();
  }

  function openTextDialog() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    buildTextFamilies();
    S.textAt = null;
    $('#textMask').classList.remove('hidden');
    var el = document.querySelector('#textMask .hint');
    if (el) el.textContent = '点画布上的位置决定它出现在哪；不点就放在画布正中。点「放到画布上」即可。';
    setTimeout(function () { $('#textInput').focus(); }, 60);
  }

  /* ================================================================
   * 参考图（独立浮窗）
   *
   * 以前是直接盖在画布上的一层，会挡着画画；现在做成**独立浮窗**——
   * 像 PS 里另开一张图那样：可以拖着走、拖角缩放、随时关掉。
   * 仍然是**本机私有**的：不写进笔迹、不写进图层、不上传。
   * ================================================================ */

  var REF_LS = 'chahu.refWindow';

  function refWindowEl() { return $('#refWindow'); }

  function saveRefRect() {
    var w = refWindowEl();
    if (!w || w.classList.contains('hidden')) return;
    try {
      localStorage.setItem(REF_LS, JSON.stringify({
        left: w.offsetLeft, top: w.offsetTop,
        width: w.offsetWidth, height: w.offsetHeight
      }));
    } catch (e) { /* ignore */ }
  }

  function restoreRefRect() {
    var w = refWindowEl();
    if (!w) return;
    var st = null;
    try { st = JSON.parse(localStorage.getItem(REF_LS) || 'null'); } catch (e) { st = null; }
    if (!st) return;
    var stage = $('#stage').getBoundingClientRect();
    // 别把窗口恢复到看不见的地方
    if (st.width >= 160) w.style.width = st.width + 'px';
    if (st.height >= 120) w.style.height = st.height + 'px';
    if (typeof st.left === 'number' && st.left > -20 && st.left < stage.width - 40) w.style.left = st.left + 'px';
    if (typeof st.top === 'number' && st.top > -10 && st.top < stage.height - 40) w.style.top = st.top + 'px';
    w.style.right = 'auto';
  }

  function bindRefWindow() {
    var w = refWindowEl();
    if (!w) return;

    // 拖标题栏移动
    var drag = null;
    $('#refHead').addEventListener('pointerdown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      var r = w.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      $('#refHead').setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    $('#refHead').addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var stage = $('#stage').getBoundingClientRect();
      var x = Math.max(-w.offsetWidth + 60, Math.min(stage.width - 60, e.clientX - stage.left - drag.dx));
      var y = Math.max(0, Math.min(stage.height - 30, e.clientY - stage.top - drag.dy));
      w.style.left = x + 'px';
      w.style.top = y + 'px';
      w.style.right = 'auto';
    });
    $('#refHead').addEventListener('pointerup', function (e) {
      if (!drag) return;
      drag = null;
      void e;
      saveRefRect();
    });

    $('#refAlphaDown').addEventListener('click', function () { setRefAlpha(-0.1); });
    $('#refAlphaUp').addEventListener('click', function () { setRefAlpha(0.1); });
    $('#refFit').addEventListener('click', function () {
      w.style.width = '320px';
      w.style.height = '260px';
      saveRefRect();
    });
    $('#refClose').addEventListener('click', clearReferenceImage);
    // 缩放（CSS resize）之后记一下尺寸
    if (global.ResizeObserver) {
      new global.ResizeObserver(function () { saveRefRect(); }).observe(w);
    }
  }

  function pickReferenceImage() {
    if (S.ref && S.ref.dataUrl) {
      var act = confirm('已经有一张参考图了。\n\n确定 = 换一张\n取消 = 保持原样');
      if (!act) return;
    }
    var input = $('#refFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function clearReferenceImage() {
    var w = refWindowEl();
    if (w) w.classList.add('hidden');
    S.ref = null;
    var img = $('#refImg');
    if (img) img.removeAttribute('src');
    toast('已关闭参考图');
  }

  /** 打开一张参考图（独立浮窗，只有自己看得见） */
  function loadReferenceImage(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      var url = fr.result;
      var img = $('#refImg');
      if (!img) return;
      img.onload = function () {
        var w = refWindowEl();
        w.classList.remove('hidden');
        restoreRefRect();
        $('#refName').textContent = file.name;
        img.style.opacity = String(S.refAlpha || 1);
        // 按图片比例给个合适的初始尺寸（只在第一次或换图时调）
        var st = null;
        try { st = JSON.parse(localStorage.getItem(REF_LS) || 'null'); } catch (e) { st = null; }
        if (!st && img.naturalWidth && img.naturalHeight) {
          var k = Math.min(320 / img.naturalWidth, 260 / img.naturalHeight, 1);
          w.style.width = Math.max(160, Math.round(img.naturalWidth * k) + 16) + 'px';
          w.style.height = Math.max(140, Math.round(img.naturalHeight * k) + 62) + 'px';
        }
        S.ref = { name: file.name, dataUrl: url };
        toast('参考图已打开（独立浮窗，不会同步给别人）', 'ok', 4000);
      };
      img.onerror = function () { toast('这张图读不出来', 'err'); };
      img.src = url;
    };
    fr.readAsDataURL(file);
  }

  function setRefAlpha(d) {
    S.refAlpha = Math.max(0.1, Math.min(1, (S.refAlpha || 1) + d));
    var img = $('#refImg');
    if (img) img.style.opacity = String(S.refAlpha);
    toast('参考图不透明度 ' + Math.round(S.refAlpha * 100) + '%');
  }

  /* ================================================================
   * 侧栏收拉（聊天 / 成员 / 笔迹）
   * ================================================================ */

  function setSideCollapsed(collapsed, opts) {
    var el = $('#sidePanel');
    var rail = $('#sideRail');
    if (!el) return;
    var on = !!collapsed;
    el.classList.toggle('hidden', on);
    if (rail) rail.classList.toggle('hidden', !on);
    S.sideCollapsed = on;
    if (!opts || opts.persist !== false) {
      try { localStorage.setItem('chahu.side', on ? '0' : '1'); } catch (e) { /* ignore */ }
    }
    syncDrawerBack();
    engine.resize();
  }

  function toggleSide() {
    setSideCollapsed(!S.sideCollapsed);
  }

  /* ================================================================
   * 工程文件（.chahu）：保存 / 打开 / 自动保存草稿
   *
   * 语义先说清楚：茶绘的画布归**房间**所有、服务端是权威，所以
   * 「打开工程」= 新建一个房间来承载它，而不是往当前房间里灌
   * （灌进当前房间会覆盖别人的画）。文件结构和取舍见 project.js 顶部注释。
   * ================================================================ */

  var PJ = global.ChahuProject;
  var LS_EXIT_AT = 'chahu.exitAt';   // 上次「干净退出」的时刻，只有正常刷新/关页面才写
  var AUTOSAVE_MS = 25000;           // 自动保存节流：最快 25 秒一份
  var autosaveSig = '';              // 上次自动保存时的文档指纹
  var autosaveBusy = false;

  /**
   * 文档指纹：任何会改变画面的东西动了，指纹就变。自动保存靠它判断
   * 「值不值得花几十毫秒抓一遍图」，不用真去抓。
   * 光看笔数不够 —— 变换 / 滤镜 / 清除是像素级操作，不进 strokes，
   * 只能靠图层表的 baseSeq 变化体现出来。
   */
  function docSignature() {
    var ls = engine.layerList();
    var acc = [engine.width, engine.height, engine.seq, engine.strokes.length];
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      acc.push(l.id, l.name, l.visible ? 1 : 0, l.opacity, l.blend,
        l.locked ? 1 : 0, l.alphaLock ? 1 : 0, l.baseSeq || 0);
    }
    return acc.join(',');
  }

  function appVersion() {
    return (global.CHAHU_CONFIG && global.CHAHU_CONFIG.appVersion) ||
      (Cfg && Cfg.appVersion) || '';
  }

  function captureProject() {
    return PJ.capture(engine, {
      app: appVersion(),
      name: (S.room && S.room.name) || ''
    });
  }

  /* ------------------------------------------------ 保存工程 */

  function saveProject() {
    if (!S.joined) { toast('先进入一个房间再保存工程', 'err'); return; }
    var pj;
    try { pj = captureProject(); }
    catch (e) { toast('保存失败：' + e.message, 'err', 7000); return; }
    var text = PJ.stringify(pj);
    download(PJ.fileName(pj, (S.room && S.room.name) || '未命名'), PJ.textToDataUrl(text));
    // 刚存过一遍，别让自动保存马上又抓一次同样的内容
    autosaveSig = docSignature();
  }

  /* ------------------------------------------------ 打开工程 */

  function pickProjectFile() {
    if (global.chahuDesktop && global.chahuDesktop.openFile) {
      global.chahuDesktop.openFile('project').then(function (r) {
        if (!r || r.canceled) return;
        if (!r.ok) { toast('打开失败：' + (r.error || '未知错误'), 'err', 7000); return; }
        loadProjectText(r.text, r.name);
      });
      return;
    }
    var input = $('#projectFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function loadProjectText(text, fileName) {
    var pj;
    try { pj = PJ.parse(text); }
    catch (e) { toast('打不开这份工程：' + e.message, 'err', 9000); return; }
    if (!pj.name && fileName) pj.name = String(fileName).replace(/\.chahu$/i, '');
    openProjectDoc(pj);
  }

  /* ------------------------------------------------ 导入 PSD */

  function b64ToBytes(b64) {
    var s = global.atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /**
   * 把一份 PSD 的字节读成「伪工程」再装载。
   * 伪工程和 project.js 的 doc 同形，于是 openProjectDoc 那条「新建房间 + 分片上传」
   * 的路一个字都不用改就能复用 —— 导入不需要第二套装载机制。
   */
  function importPsdBytes(bytes, name) {
    var RD = global.ChaPsdRead;
    if (!RD) { toast('PSD 读取器没加载上来（psd-read.js 没进来）', 'err', 8000); return false; }
    if (!bytes || !bytes.length) { toast('这个文件是空的', 'err'); return false; }
    var pj;
    try {
      pj = RD.toProject(bytes, { name: String(name || '').replace(/\.ps[bd]$/i, '') });
    } catch (e) {
      // 读不动的理由要说人话：是位深不对、颜色模式不对、还是压缩方式不支持，
      // 用户得知道下一步该在 Photoshop 里改什么
      toast('读不了这份 PSD：' + e.message, 'err', 12000);
      return false;
    }
    // 「跳过了什么」必须讲出来 —— 默默少东西是最难查的那类毛病
    (pj.notes || []).slice(0, 4).forEach(function (n, i) {
      setTimeout(function () { toast(n, 'warn', 7000); }, 350 + i * 260);
    });
    toast('PSD 已读入：' + RD.describe(pj), 'ok', 5000);
    openProjectDoc(pj);
    return true;
  }

  function pickPsdFile() {
    if (global.chahuDesktop && global.chahuDesktop.openFile) {
      global.chahuDesktop.openFile('psd').then(function (r) {
        if (!r || r.canceled) return;
        if (!r.ok) { toast('打开失败：' + (r.error || '未知错误'), 'err', 7000); return; }
        if (!r.b64) { toast('这个文件读出来是空的', 'err'); return; }
        importPsdBytes(b64ToBytes(r.b64), r.name);
      });
      return;
    }
    var input = $('#psdFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function openProjectDoc(pj, opts) {
    opts = opts || {};
    if (!net.isOpen()) { toast('还没连上服务器', 'err'); return; }
    if (S.joined && !opts.noConfirm) {
      if (!confirm('打开工程会新建一个房间来承载它，并离开当前房间' +
        (S.room ? '「' + S.room.name + '」' : '') +
        '。\n\n当前房间的内容在服务器上，不会丢。继续？')) return;
    }
    S.projectLoad = { doc: pj.doc, sent: 0, ending: false };
    net.send(P.C2S.ROOM_CREATE, {
      name: String(pj.name || '打开的画').slice(0, 20),
      user: S.me.name,
      width: pj.doc.width,
      height: pj.doc.height,
      background: pj.doc.background
    });
    setStatus('正在准备装载工程…');
  }

  /**
   * 入房同步完成后，把工程的图层分片传上去。
   * 分片是为了绕开 ws 单条 12MB 的上限 —— 一层一条，多大的画都不会顶到。
   * 钩子在 drainHistory 收尾处，所以「入房同步完」这件事只在此刻成立一次。
   */
  function uploadProjectLayers() {
    var job = S.projectLoad;
    if (!job || job.sent) return;
    if (!S.joined) return;
    job.sent = 1;

    var layers = job.doc.layers;
    if (layers.length > PJ.MAX_LAYERS) {
      toast('这份工程有 ' + layers.length + ' 层，超过上限 ' + PJ.MAX_LAYERS + '，只装载最下面 ' +
        PJ.MAX_LAYERS + ' 层（上面的没进来）', 'err', 9000);
      layers = layers.slice(0, PJ.MAX_LAYERS);
    }
    // 组表跟着 BEGIN 走：它很小（没有像素），而且必须比第一个图层先到，
    // 服务端要拿它判断各层的 groupId 有效不有效
    net.send(P.C2S.PROJECT_BEGIN, { count: layers.length, groups: job.doc.groups || [] });

    var i = 0;
    function step() {
      if (i >= layers.length) {
        job.ending = true;
        net.send(P.C2S.PROJECT_END, {});
        setStatus('工程已上传，正在重建画布…');
        return;
      }
      var l = layers[i];
      net.send(P.C2S.PROJECT_LAYER, {
        index: i,
        name: l.name, visible: l.visible, opacity: l.opacity,
        locked: l.locked, alphaLock: l.alphaLock, blend: l.blend,
        // 剪贴蒙版与图层蒙版都得跟着上车，否则「导入 PSD 之后剪贴没了、蒙版没了」——
        // 它们在 PSD 里是最常见的两种结构，丢了就是导入得不对
        clip: !!l.clip,
        maskEnabled: l.maskEnabled !== false,
        maskPng: (typeof l.maskPng === 'string' && l.maskPng) ? l.maskPng : null,
        groupId: l.groupId || null,
        png: l.png
      });
      i++;
      setStatus('正在装载工程… ' + i + '/' + layers.length + ' 层');
      setTimeout(step, 0);
    }
    step();
  }

  /** 装载失败 / 房间没了：别留着一个半截的装载任务在后台 */
  function dropProjectLoad(why) {
    if (!S.projectLoad) return;
    S.projectLoad = null;
    if (why) toast(why, 'err', 7000);
  }

  /* ------------------------------------------------ 自动保存草稿 */

  /**
   * 草稿写进 IndexedDB（不是 localStorage：一份工程几层 PNG 很容易过 5MB，
   * 而 localStorage 超限是同步抛异常）。
   * 只有「文档确实变了、且距上次至少 25 秒」才真去抓图，平时这个循环几乎不花时间。
   */
  function autosaveTick() {
    if (!S.joined || !S.room || autosaveBusy || !PJ.draft) return;
    var sig = docSignature();
    if (sig === autosaveSig) return;
    autosaveBusy = true;
    var pj;
    try { pj = captureProject(); }
    catch (e) { autosaveBusy = false; return; }
    PJ.draft.save(pj, {
      roomId: S.room.id,
      roomName: S.room.name,
      strokeCount: engine.strokes.length
    }).then(function () {
      autosaveSig = sig;
      autosaveBusy = false;
    }).catch(function () {
      // 存不下就算了（隐私模式 / 配额满），不影响画画这件正事
      autosaveBusy = false;
    });
  }

  /**
   * 启动时决定要不要提示恢复草稿。
   *
   * 判据：草稿的写入时刻 vs 上次「干净退出」的时刻。
   *   - 崩了 / 被强杀 → beforeunload 没跑 → exitAt 是上一次会话的旧值，
   *     草稿比它新 → 提示；
   *   - 正常刷新 / 关页面 → exitAt 刚写过，比草稿新 → 不提示
   *     （内容本来就在服务器上，提示只会变成噪音）。
   */
  function refreshDraftBar() {
    var bar = $('#draftBar');
    if (!bar || !PJ || !PJ.draft) return;
    bar.classList.add('hidden');
    PJ.draft.load().then(function (rec) {
      if (!rec || !rec.project) return;
      var exitAt = 0;
      try { exitAt = parseInt(localStorage.getItem(LS_EXIT_AT) || '0', 10) || 0; } catch (e) { exitAt = 0; }
      if (rec.savedAt <= exitAt) return;
      S.draftRecord = rec;
      var info = $('#draftInfo');
      if (info) {
        var t = new Date(rec.savedAt);
        info.textContent = (rec.roomName ? '「' + rec.roomName + '」· ' : '') +
          PJ.describe(rec.project) + ' · 自动保存于 ' +
          pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' +
          pad2(t.getHours()) + ':' + pad2(t.getMinutes());
      }
      bar.classList.remove('hidden');
    }).catch(function () { /* 没有 IndexedDB 的环境直接跳过 */ });
  }

  function restoreDraft() {
    var rec = S.draftRecord;
    if (!rec || !rec.project) return;
    $('#draftBar').classList.add('hidden');
    openProjectDoc(rec.project, { noConfirm: !S.joined });
  }

  function dropDraft() {
    S.draftRecord = null;
    $('#draftBar').classList.add('hidden');
    if (PJ && PJ.draft) PJ.draft.clear().catch(function () { /* ignore */ });
    toast('已丢弃本地草稿');
  }

  /* 退出时同步记一笔「我是干净退出的」。必须在 beforeunload / pagehide 里同步做完，
     IndexedDB 的异步写在这个时机不保证能提交，localStorage 可以。 */
  function markCleanExit() {
    try { localStorage.setItem(LS_EXIT_AT, String(Date.now())); } catch (e) { /* ignore */ }
  }

  global.ChaApp = {
    engine: engine, net: net, state: S, undo: undo, redo: redo, toast: toast,
    // 笔刷导入（给测试用，也让控制台里能手动导一支试试）
    openBrushImport: openBrushImport,
    handleBrushFiles: handleBrushFiles,
    applyImported: applyImported,
    removeImported: removeImported,
    tipThumb: tipThumb,
    // 色轮取色区形状（'square' / 'triangle'）：测试要靠它把形状切到被测的那一种，
    // 不然「三角形那套几何」的用例在新默认（方形）下会点到形状外面去。
    setWheelShape: setSvShape,
    wheelShape: svShape,
    // 工程文件（.chahu）。openProject 走「选文件」那条路，测试里可以直接
    // 调 loadProjectText 灌一段 JSON 进来，不用真的去开文件对话框。
    saveProject: saveProject,
    openProject: pickProjectFile,
    loadProjectText: loadProjectText,
    openProjectDoc: openProjectDoc,
    // PSD 导入。测试里可以直接灌字节进来（importPsdBytes），不用真去选文件
    importPsd: pickPsdFile,
    importPsdBytes: importPsdBytes,
    dropDraft: dropDraft,
    // 自动保存本来是 25 秒一次的定时器；测试里等不起，直接给个「现在就存一遍」的入口
    autosaveNow: autosaveTick,
    refreshDraftBar: refreshDraftBar,

    /* ---- 菜单栏 / 快捷键要用到的动作（菜单结构见 menu.js） ---- */
    openEntry: openEntry, doExport: doExport, doShare: doShare, showInfo: showInfo,
    // 离线模式（桌面端）：入口页那颗按钮（serverButtonAction，按按钮文案行事）
    // + 菜单里的「其他 → 离线模式」（toggleOffline，只管离线档的开关）。
    // 它**不停服务器**，只换客户端通道，所以「在不在线」看 isOffline，不看 serverOn
    toggleServer: toggleOffline,
    setServerOn: setServerOn,
    serverOn: function () { return !!srvState.on; },
    isOffline: function () { return net.isLocal(); },
    serverState: function () { return srvState; },
    refreshServerState: refreshServerState,
    toggleRecord: toggleRecord,
    toggleReplay: function () { if (engine.replayMode) stopReplay(); else startReplay(); },
    exportReplayVideo: exportReplayVideo,
    toggleOnion: toggleOnion, setOnionCount: setOnionCount, onionState: syncOnionUi,
    leaveRoom: leaveRoom,
    // 图层组（给测试用，也让控制台里能手动试）
    groupAdd: groupAdd,
    groupToggle: groupToggle,
    groupUngroup: groupUngroup,
    groupDelWithLayers: groupDelWithLayers,
    selKind: selKind,
    // 更新检测（纯函数，给测试直接喂假 release 数据）
    pickUpdateAsset: pickUpdateAsset,
    checkUpdate: checkUpdate,
    addLayer: addLayer, moveLayer: moveLayer, clearLayer: clearLayer,
    openCanvasDialog: openCanvasDialog, openCanvasSizeDialog: openCanvasSizeDialog, bake: bake,
    flipImage: flipImage, rotateImage: rotateImage, cropToSelection: cropToSelection,
    selectAll: selectAll, selectNone: selectNone, selectInvert: selectInvert,
    selectFromLayer: selectFromLayer, toggleTransform: toggleTransform, toggleMeshTransform: toggleMeshTransform,
    commitTransform: commitTransform, cancelTransform: cancelTransform,
    toggleGrid: toggleGrid, setSymmetry: setSymmetry, nudgeSteadier: nudgeSteadier,
    setPaper: setPaper, setFx: setFx,
    zoomBy: zoomBy, zoom100: zoom100, zoomFit: zoomFit,
    flipView: flipView, rotateView: rotateView,
    toggleNav: toggleNav, toggleSide: toggleSide, toggleSection: toggleSection, resetPanels: resetPanels,
    showRoomInfo: showRoomInfo, showStatus: showStatus,
    clearHistory: clearHistory, cycleCursor: cycleCursor,
    setTool: setTool,

    /* ---- 照 SAI2 菜单结构补齐的动作 ---- */
    quitApp: quitApp,
    copySelection: copySelection,
    pasteImage: pasteImage,
    // 只读观众：给别人设 / 取消（只有房主说了算），以及「我是不是观众」
    setReadonly: setReadonly,
    myReadonly: readonlyMe,
    dupLayer: dupLayer, delLayer: delLayer, mergeDown: mergeDown, mergeVisible: mergeVisible,
    // 图层面板：内容转移到下层 + 拖动排序（给测试留的手柄，省得非要去合成鼠标事件）
    dropContentDown: layerMoveContentDown,
    dragLayerTo: function (drag, k) { commitLayerDrag(drag, k); },
    layerPanelOrder: function () { return layerRowsInfo().ids; },
    setBackground: setBackground,
    toggleMarchingAnts: toggleMarchingAnts,
    // ★ 2.0.10：房间链接的识别与进房（测试直接喂各种链接字符串）
    parseRoomLink: parseRoomLink,
    joinByLink: joinByLink,
    appRoomLink: appRoomLink,
    // ★ 2.0.9：接龙「逐笔回放」的节奏（测试直接喂笔迹 + 时长，验「不会啪的一下跳到成图」）
    chainAnimDebug: {
      start: chainAnimDebugStart,
      stop: chainAnimDebugStop,
      state: function () { return S.cr.anim; }
    },
    growSelection: growSelection, shrinkSelection: shrinkSelection,
    setUiScale: setUiScale, setCursorMode: setCursorMode,
    toggleLeftPanel: toggleLeftPanel, toggleFullscreen: toggleFullscreen,
    setLeftCollapsed: setLeftCollapsed, setSideCollapsed: setSideCollapsed,
    applyLayoutMode: applyLayoutMode, setQuickBarCollapsed: setQuickBarCollapsed,
    openSettings: openSettings,
    openAbout: openAbout, checkUpdate: checkUpdate, cmpVer: cmpVer,
    openToneDialog: openToneDialog, updateTonePreview: updateTonePreview, closeToneDialog: closeToneDialog,
    openLevelsDialog: openLevelsDialog, closeLevelsDialog: closeLevelsDialog, levelsOpts: levelsOpts, levelsAuto: levelsAuto,
    openBlurDialog: openBlurDialog, closeBlurDialog: closeBlurDialog, blurRadius: blurRadius,
    openExportDialog: openExportDialog, exportAs: exportAs, syncExportNote: syncExportNote,
    armRuler: armRuler, clearRuler: clearRuler, toggleRulerVisible: toggleRulerVisible, commitRuler: commitRuler,
    toggleQuickBarSteadier: toggleQuickBarSteadier,
    setDimMode: setDimMode, cycleDimMode: cycleDimMode, setUserDim: setUserDim,
    toggleLocalHideActive: toggleLocalHideActive, clearLocalHiddenUi: clearLocalHidden,
    openTextDialog: openTextDialog, commitText: commitText, placeTextAt: placeTextAt, textOpts: textOpts,
    bindQuickBar: bindQuickBar, updateQuickBar: updateQuickBar,
    loadReferenceImage: loadReferenceImage, clearReferenceImage: clearReferenceImage,

    /* ---- 接龙（chain）：给测试和控制台留的手柄 ---- */
    startChainGame: startChainGame, openChainDialog: openChainDialog,
    submitChainWord: submitChainWord, submitChainArt: submitChainArt,
    doChainGuessSubmit: doChainGuessSubmit, voteKeep: voteKeep, sendFavVote: sendFavVote,
    // v14：回放没有手动翻格 / 播放（crPlay / crStepItem 已删），只留「这一格能不能点 ♥」
    crLegFavOpen: crLegFavOpen,
    favCurrentItem: favCurrentItem, endChainGame: endChainGame,
    openTrophy: openTrophy, closeTrophy: closeTrophy,
    // 最终结算第一步「点赞最多的画」：给测试/控制台喂假 voteResult 的入口
    openFavShow: openFavShow, closeFavShow: closeFavShow, paintFavRow: paintFavRow,
    favWinnerRows: favWinnerRows, favToTrophy: favToTrophy, favState: function () { return FAV; },
    // 分组（v12）：纯函数 + 两个渲染入口，测试可以直接喂假快照
    chainGroupInfo: chainGroupInfo, expectedGroupCount: expectedGroupCount,
    groupTextLobby: groupTextLobby, groupTextHud: groupTextHud,
    favVotedCountOf: favVotedCountOf,
    renderChainLobby: renderChainLobby, renderChainProgress: renderChainProgress,
    setGameDialogMode: setGameDialogMode,
    // 三合一开局面板：渲染 / 组装 payload / 结束本局（测试与控制台用）
    renderGameDialog: renderGameDialog, gameSetupPayload: gameSetupPayload,
    stopCurrentGame: stopCurrentGame,

    /* ---- 画皮（skin）：同样给测试和控制台留手柄 ----
     * 特意把「夜里动作」和「投票」拆成两个入口（而不是直接暴露一个 sendSkinAction）：
     * 测试要断言的是「点了验人按钮之后服务端收到了什么」，按语义命名更好读，
     * 也免得以后改消息结构时要改一堆测试。 */
    startSkinGame: startSkinGame, openSkinDialog: openSkinDialog,
    submitSkinArt: submitSkinArt,
    skinCheck: function (uid) { sendSkinAction('check', uid); },
    skinKill: function (uid) { sendSkinAction('kill', uid); },
    skinSave: function (uid) { sendSkinAction('save', uid); },
    skinVote: function (uid) { sendSkinAction('vote', uid); },
    skinShot: function (uid) { sendSkinAction('shot', uid); },
    skinNext: function () { sendSkinAction('next', ''); },
    isSkinMode: isSkinMode,
    renderSkinRole: renderSkinRole, renderSkinGallery: renderSkinGallery,
    renderSkinNight: renderSkinNight, renderSkinOver: renderSkinOver,
    closeSkinViewer: closeSkinViewer,

    /* ---- 压感自检（给测试用：把「上一支指针」的采样清掉，模拟换个设备重新插） ---- */
    resetPenProbe: function () {
      penProbe.id = null; penProbe.vals = []; penProbe.types = {};
      S.penDetect = null;
      renderPenHint();
    },

    /* ---- 布局设置面板（给测试与控制台留的手柄） ---- */
    openLayoutSettings: openLayoutSettings,
    closeLayoutSettings: closeLayoutSettings,
    renderLayoutSettings: renderLayoutSettings,
    applySectionStates: applySectionStates,
    moveSectionTo: moveSectionTo,
    isSectionHidden: isSectionHidden,
    isQuickBarCollapsed: isQuickBarCollapsed,

    /* ---- 音效与自定义词库 ---- */
    sfx: SFX,
    openThemeManager: openThemeManager, closeThemeManager: closeThemeManager,
    loadThemeList: loadThemeList, saveTheme: saveTheme, deleteTheme: deleteTheme,
    selectTheme: selectTheme, httpBase: httpBase
  };
})(window);
