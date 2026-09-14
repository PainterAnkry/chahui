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

  /* ============================================================ 状态 */

  var S = {
    me: { userId: null, name: '', color: '#888', isOwner: false },
    room: null,
    members: [],
    chat: [],
    myUndo: [],
    myRedo: [],
    joinCount: 0,
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
    antsOn: true,             // 是否显示选区蚂蚁线（菜单里可勾）
    text: { fontFamily: 'sans', fontSize: 48, lineHeight: 1.35 },   // 文字工具的上次设置
    textAt: null,             // 文字要放在画布的哪个位置
    leftPanelOpen: true,      // 左侧整列面板是否显示
    gridOn: false,
    uiScale: 1,
    importPending: null,      // 导入对话框里待确认的笔刷
    stickers: [],             // 自定义表情（dataURL）
    stickerManaging: false,
    pressure: lsGet('chahu.pressure', '1') === '1',
    stabilize: Number(lsGet('chahu.stabilize', '0')) || 0,
    sym: P.SYMMETRY_MODES.indexOf(lsGet('chahu.sym', 'none')) >= 0 ? lsGet('chahu.sym', 'none') : 'none',
    // 画笔光标样式：auto（大笔刷圆环 / 小笔刷十字）、ring（始终圆环）、cross（始终十字）
    cursorStyle: ['auto', 'ring', 'cross'].indexOf(lsGet('chahu.cursor', 'auto')) >= 0 ? lsGet('chahu.cursor', 'auto') : 'auto',
    recent: [],
    hue: 0, sv: { s: 1, v: 1 },
    publicUrl: '',            // 服务端开了公网隧道时由 /api/share 带回
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
    recording: null,
    joined: false,
    lastSent: 0,
    transformDragging: false,
    modShift: false,
    modAlt: false,
    // 框选 / 套索 / 魔棒画完之后自动弹出变换面板（用户反馈第 2 条）
    autoTransform: lsGet('chahu.autoTransform', '1') !== '0',
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

  /* ---------------------------------------------------------- 左栏面板排序（可拖拽） */

  var PANEL_DEFAULT_ORDER = ['nav', 'tools', 'brushes', 'brush', 'fx', 'color', 'layers'];

  function loadPanelOrder() {
    var raw = null;
    try { raw = JSON.parse(lsGet('chahu.panelOrder', 'null')); } catch (e) { raw = null; }
    if (!Array.isArray(raw) || !raw.length) return PANEL_DEFAULT_ORDER.slice();
    var valid = raw.filter(function (id) { return PANEL_DEFAULT_ORDER.indexOf(id) >= 0; });
    PANEL_DEFAULT_ORDER.forEach(function (id) { if (valid.indexOf(id) < 0) valid.push(id); });
    return valid;
  }

  function applyPanelOrder() {
    var scroll = $('#leftPanelScroll');
    if (!scroll) return;
    var order = loadPanelOrder();
    var frag = document.createDocumentFragment();
    order.forEach(function (id) {
      var sec = scroll.querySelector('[data-section="' + id + '"]');
      if (sec) frag.appendChild(sec);
    });
    scroll.appendChild(frag);
  }

  function savePanelOrder() {
    var scroll = $('#leftPanelScroll');
    if (!scroll) return;
    var ids = Array.prototype.slice.call(scroll.querySelectorAll('[data-section]'))
      .map(function (s) { return s.getAttribute('data-section'); });
    lsSet('chahu.panelOrder', JSON.stringify(ids));
  }

  function bindPanelDnD() {
    var scroll = $('#leftPanelScroll');
    if (!scroll) return;
    var resetBtn = $('#btnPanelReset');
    if (resetBtn) resetBtn.onclick = function () {
      lsSet('chahu.panelOrder', JSON.stringify(PANEL_DEFAULT_ORDER));
      applyPanelOrder();
      toast('已恢复默认顺序');
    };

    var dragging = null, pointerId = null, autoTimer = null, autoDir = 0;

    function clearMarks() {
      Array.prototype.forEach.call(scroll.querySelectorAll('[data-section]'), function (s) {
        s.classList.remove('section-drop-before', 'section-drop-after');
      });
    }
    function stopAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      autoDir = 0;
    }
    function nearest(target) {
      while (target && target !== scroll) {
        if (target.getAttribute && target.getAttribute('data-section')) return target;
        target = target.parentNode;
      }
      return null;
    }
    function hitTest(x, y) {
      var el = document.elementFromPoint(x, y);
      return nearest(el);
    }
    function runAuto() {
      if (!autoDir) { stopAuto(); return; }
      scroll.scrollTop += autoDir * 14;
    }
    // 拖到面板上下边缘时自动滚动，长列表也能一路拖到底
    function updateAuto(y) {
      var r = scroll.getBoundingClientRect();
      var dir = 0;
      if (y < r.top + 28) dir = -1;
      else if (y > r.bottom - 28) dir = 1;
      if (dir === autoDir) return;
      autoDir = dir;
      stopAuto();
      if (dir) autoTimer = setInterval(runAuto, 16);
    }

    // 整个小节标题栏都是把手（不再只有那个小小的 ⋮⋮），
    // 但标题里的按钮（＋新建 / 编辑）仍然照常点击。
    scroll.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, input, select, a')) return;
      var h4 = t && t.closest ? t.closest('h4') : null;
      var grip = t && t.closest ? t.closest('.section-grip') : null;
      if (!h4 && !grip) return;
      var sec = (grip || h4).closest('[data-section]');
      if (!sec) return;
      e.preventDefault();
      dragging = sec;
      pointerId = e.pointerId;
      sec.classList.add('section-dragging');
      try { scroll.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      document.body.style.cursor = 'grabbing';
    });

    scroll.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pointerId) return;
      updateAuto(e.clientY);
      var target = hitTest(e.clientX, e.clientY);
      clearMarks();
      if (!target || target === dragging) return;
      var r = target.getBoundingClientRect();
      var before = (e.clientY - r.top) < r.height / 2;
      target.classList.add(before ? 'section-drop-before' : 'section-drop-after');
    });

    function finish(e) {
      if (!dragging || (e && e.pointerId != null && e.pointerId !== pointerId)) return;
      var target = e ? hitTest(e.clientX, e.clientY) : null;
      if (target && target !== dragging) {
        var r = target.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        if (before) scroll.insertBefore(dragging, target);
        else scroll.insertBefore(dragging, target.nextSibling);
        savePanelOrder();
      }
      dragging.classList.remove('section-dragging');
      clearMarks();
      stopAuto();
      dragging = null;
      document.body.style.cursor = '';
    }
    scroll.addEventListener('pointerup', finish);
    scroll.addEventListener('pointercancel', finish);
    // 指针跑出面板外松手也要收尾，否则会一直黏着
    document.addEventListener('pointerup', function (e) {
      if (dragging) finish(e);
    });
    window.addEventListener('blur', function () { if (dragging) finish(null); });
  }

  function visibleItems() {
    var p = S.toolPrefs;
    return p.order.filter(function (id) { return p.hidden.indexOf(id) < 0; })
      .map(function (id) { return Brushes.get(id); })
      .filter(Boolean);
  }

  /** 「工具栏」放工具，「笔刷栏」放笔刷 —— 和 SAI2 一样分开两栏 */
  function isBrushItem(it) { return it.type === 'brush'; }

  /**
   * 渲染一格工具/笔刷按钮。
   * 工具栏和笔刷栏共用这套渲染，也共用同一份顺序/显隐偏好（S.toolPrefs），
   * 只是各自只挑自己那一半来画。
   */
  function renderItemGrid(box, list) {
    box.innerHTML = '';
    box.classList.toggle('editing', S.toolEdit);
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'tool' + (it.id === S.brushId ? ' active' : '');
      b.dataset.tool = it.tool;
      b.dataset.item = it.id;
      b.title = it.name + '｜' + it.tip;
      b.innerHTML = Brushes.iconSvg(it.icon || it.id) + '<span>' + esc(it.name) + '</span>' +
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
      // 导入的笔刷：右键删掉它（自带的笔刷不给删）
      if (it.imported) {
        b.oncontextmenu = function (e) {
          e.preventDefault();
          if (confirm('删除导入的笔刷「' + it.name + '」？')) removeImported(it.id);
        };
      }
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
      'blend', 'filled', 'paper', 'fx'].forEach(function (k) {
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
    $('#brushBlend').value = b.blend;
    $('#filledChk').checked = !!b.filled;
    $('#pressureChk').checked = S.pressure;
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
    toleranceRange: ['fill'],
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
    var SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
    var R = SZ / 2 - 3, ring = 17, r0 = R - ring;
    if (!ringCache) ringCache = buildRing(SZ, cx, cy, R, r0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, SZ, SZ);
    ctx.drawImage(ringCache, 0, 0);

    // SV 三角：顶点 = 纯色相，右下 = 白，左下 = 黑
    // 留出 9px 空隙，避免三角顶点贴住圆环内沿
    var tr = r0 - 9;
    var A = [cx + Math.cos(-Math.PI / 2) * tr, cy + Math.sin(-Math.PI / 2) * tr];
    var B = [cx + Math.cos(-Math.PI / 2 + 2 * Math.PI / 3) * tr, cy + Math.sin(-Math.PI / 2 + 2 * Math.PI / 3) * tr];
    var C = [cx + Math.cos(-Math.PI / 2 + 4 * Math.PI / 3) * tr, cy + Math.sin(-Math.PI / 2 + 4 * Math.PI / 3) * tr];
    var hue = hsvToRgb(S.hue, 1, 1);

    var minx = Math.floor(Math.min(A[0], B[0], C[0])) - 1;
    var maxx = Math.ceil(Math.max(A[0], B[0], C[0])) + 1;
    var miny = Math.floor(Math.min(A[1], B[1], C[1])) - 1;
    var maxy = Math.ceil(Math.max(A[1], B[1], C[1])) + 1;
    var w = maxx - minx, h = maxy - miny;
    if (w > 0 && h > 0) {
      // 关键：三角必须画在**离屏画布**上再 drawImage 合成。
      // 直接用 putImageData 到主画布会连同 alpha 一起覆写，
      // 于是包围盒四角落到圆环上的像素被「打孔」变透明 —— 看起来就是三角把圆环切掉了一块。
      if (!triCache) { triCache = document.createElement('canvas'); }
      if (triCache.width !== SZ || triCache.height !== SZ) {
        triCache.width = SZ; triCache.height = SZ;
      }
      var tctx = triCache.getContext('2d');
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, SZ, SZ);
      var img = tctx.createImageData(w, h);
      var d = img.data;
      var v0x = B[0] - A[0], v0y = B[1] - A[1];
      var v1x = C[0] - A[0], v1y = C[1] - A[1];
      var den = v0x * v1y - v1x * v0y;
      for (var j = 0; j < h; j++) {
        for (var i = 0; i < w; i++) {
          var px = minx + i, py = miny + j;
          var v2x = px - A[0], v2y = py - A[1];
          // ⚠️ 变量名和顶点对不上，别按字面理解：
          //   cross((p-A), v1) 得到的是 **B 的权重**，cross(v0, (p-A)) 得到的是 **C 的权重**，
          //   1 减掉它们才是 **A 的权重**。
          // 之前直接把 `u` 当成 A 的权重去乘纯色相，结果整块三角被转了一圈 ——
          // 纯色相跑到右下角、顶部成了黑色，于是「在色轮上点哪儿，小圆圈都不在那儿」。
          var wB = ((v2x * v1y - v2y * v1x) / den);
          var wC = ((v0x * v2y - v2x * v0y) / den);
          var wA = 1 - wB - wC;
          var o = (j * w + i) * 4;
          if (wA < -0.004 || wB < -0.004 || wC < -0.004) { d[o + 3] = 0; continue; }
          wA = clamp(wA, 0, 1); wB = clamp(wB, 0, 1); wC = clamp(wC, 0, 1);
          var sum = wA + wB + wC || 1;
          wA /= sum; wB /= sum; wC /= sum;
          // A = 纯色相（上）· B = 白（右下）· C = 黑（左下）
          d[o] = Math.round(wA * hue[0] + wB * 255 + wC * 0);
          d[o + 1] = Math.round(wA * hue[1] + wB * 255 + wC * 0);
          d[o + 2] = Math.round(wA * hue[2] + wB * 255 + wC * 0);
          d[o + 3] = 255;
        }
      }
      tctx.putImageData(img, minx, miny);
      ctx.drawImage(triCache, 0, 0);
    }

    // 三角描边
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]);
    ctx.closePath();
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

    // SV 指示器
    //
    // 三角形的三个顶点分别是 A=纯色相、B=白、C=黑，所以点的重心坐标应该是
    //     [A 的权重, B 的权重, C 的权重] = [v*s, v*(1-s), 1-v]
    // 推法：颜色 = a*hue + b*255 + c*0，取 max/min 得 V = a+b、S = 1 - b/(a+b)，
    // 于是 c = 1-V、b = V(1-S)、a = V*S。
    //
    // 这里以前写的是 [1-s, s*(1-v), s*v] —— 权重和确实也是 1，但对应关系是错的：
    // 比如 s=1,v=1（纯色相）会算成 [0,0,1] 直接落到黑角上，
    // 而且 s=0,v=1 时算出 [1,1,0] 权重和是 2，点会跑到三角形外面去。
    // 用户看到的「在色轮上取色时位置识别不对」就是这个。
    var s = S.sv.s, v = S.sv.v;
    var sw = [v * s, v * (1 - s), 1 - v];
    var sx = u_weight(A, B, C, sw)[0];
    var sy = u_weight(A, B, C, sw)[1];
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
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
    function pick(e) {
      var r = cv.getBoundingClientRect();
      var x = (e.clientX - r.left) * cv.width / r.width;
      var y = (e.clientY - r.top) * cv.height / r.height;
      var cx = cv.width / 2, cy = cv.height / 2;
      var dist = Math.hypot(x - cx, y - cy);
      var R = cv.width / 2 - 3, ring = 17, r0 = R - ring;
      if (dist >= r0) {
        S.hue = (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360;
        drawWheel();
        applyHsv();
        return;
      }
      var ctx = cv.getContext('2d');
      var d = ctx.getImageData(clamp(Math.round(x), 0, cv.width - 1), clamp(Math.round(y), 0, cv.height - 1), 1, 1).data;
      if (d[3] < 8) return;
      var hsv = rgbToHsv(d[0], d[1], d[2]);
      S.hue = hsv.h;
      S.sv = { s: hsv.s, v: hsv.v };
      setColor(hexOf(d[0], d[1], d[2]), false);
      drawWheel();
    }
    cv.addEventListener('pointerdown', function (e) {
      // 数位笔 / 触摸拖色轮时，浏览器默认会把它当成「滚动手势」，
      // 结果整条左侧面板跟着一起滑 —— 必须两个一起做才压得住：
      //   · CSS 里给 canvas 设 touch-action: none
      //   · 事件里 preventDefault（并阻止后续的兼容鼠标事件）
      e.preventDefault();
      drag = true;
      // 合成事件（脚本发出的）没有真实指针，setPointerCapture 会抛异常。
      // 以前没包 try，一抛就把整个 pointerdown 处理器打断，连 pick(e) 都执行不到。
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 没有真实指针就算了 */ }
      pick(e);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drag) return;
      e.preventDefault();
      pick(e);
    });
    cv.addEventListener('pointerup', function () { drag = false; });
    cv.addEventListener('pointercancel', function () { drag = false; });
  }

  function applyHsv() {
    var rgb = hsvToRgb(S.hue, S.sv.s, S.sv.v);
    setColor(hexOf(rgb[0], rgb[1], rgb[2]), false);
  }

  function buildPalette() {
    var box = $('#palette');
    box.innerHTML = '';
    global.CanvasEngine.SWATCHES.forEach(function (c) {
      var i = document.createElement('i');
      i.style.background = c;
      i.title = c;
      i.onclick = function () { setColor(c); };
      box.appendChild(i);
    });
  }

  function setColor(hex, remember) {
    S.color = hex;
    $('#colorPreview').style.background = hex;
    $('#hexInput').value = hex.toUpperCase();
    try { $('#colorInput').value = hex; } catch (e) { /* ignore */ }
    var rg = global.CanvasEngine.hexToRgb(hex);
    var hsv = rgbToHsv(rg.r, rg.g, rg.b);
    // 灰阶颜色（黑 / 白 / 灰）算不出色相，rgbToHsv 会回 0。
    // 这时候**保留原来的色相**，否则在色轮上拖色相环会「没有任何反应」：
    // 环上选色 → applyHsv 用当前 S/V 合成 → 若当前 S=0 合成出来还是灰 →
    // setColor 又把 hue 打回 0 —— 用户看到的就是「点环没用 / 位置识别不对」。
    if (hsv.s > 0.0001) S.hue = hsv.h;
    S.sv = { s: hsv.s, v: hsv.v };
    if (remember !== false) pushRecent(hex);
  }

  function pushRecent(hex) {
    S.recent = S.recent.filter(function (c) { return c.toLowerCase() !== hex.toLowerCase(); });
    S.recent.unshift(hex);
    if (S.recent.length > 12) S.recent.length = 12;
    var box = $('#recentColors');
    box.innerHTML = '';
    S.recent.forEach(function (c) {
      var i = document.createElement('i');
      i.style.background = c;
      i.title = c;
      i.onclick = function () { setColor(c, false); };
      box.appendChild(i);
    });
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
    if (status === 'online') dot.classList.add('on');
    else if (status === 'connecting') dot.classList.add('off');
    else if (status === 'offline') dot.classList.add('err');
    var label = { idle: '未连接', connecting: '连接中', online: '已连接', offline: '已断开' }[status] || status;
    if (status === 'online' && net.latency) label += ' · ' + net.latency + 'ms';
    if (S.room) $('#roomMeta').textContent = S.room.width + '×' + S.room.height + ' · 在线 ' + (S.room.online || 0) + ' 人 · ' + label;
    if (status === 'offline') setStatus('连接断开，正在重连…');
    else if (status === 'online') setStatus('已连接 ' + net.url);
  }

  /* ============================================================ 图层 */

  function renderLayers() {
    var box = $('#layerList');
    box.innerHTML = '';
    var list = engine.layers.slice().reverse();
    list.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'layer-item' + (l.id === engine.activeLayerId ? ' active' : '') +
        (l.visible ? '' : ' hidden-layer') + (l.locked ? ' locked-layer' : '');
      row.dataset.id = l.id;

      var eye = document.createElement('button');
      eye.className = 'eye';
      eye.innerHTML = l.visible
        ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.5 5.4A9.9 9.9 0 0 1 12 5c6.4 0 10 6 10 6a17 17 0 0 1-3 3.4M6.3 7.2A17.5 17.5 0 0 0 2 11s3.6 6 10 6c1 0 1.9-.1 2.7-.4"/></svg>';
      eye.onclick = function (e) {
        e.stopPropagation();
        net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { visible: !l.visible } });
      };
      row.appendChild(eye);

      var th = document.createElement('div');
      th.className = 'thumb';
      if (l.thumb) th.style.backgroundImage = 'url(' + l.thumb + ')';
      row.appendChild(th);

      var nm = document.createElement('div');
      nm.className = 'lname';
      nm.innerHTML = '<span>' + esc(l.name) + '</span>' +
        '<span class="lmeta">' + esc(P.BLEND_LABELS[l.blend] || l.blend) + ' · ' + Math.round(l.opacity * 100) + '%' +
        (l.alphaLock ? ' · 锁' : '') + '</span>';
      nm.title = '双击重命名';
      nm.ondblclick = function (e) {
        e.stopPropagation();
        var inp = document.createElement('input');
        inp.value = l.name;
        nm.innerHTML = '';
        nm.appendChild(inp);
        inp.focus(); inp.select();
        var commit = function () {
          var v = inp.value.trim() || l.name;
          net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: { name: v } });
        };
        inp.onblur = commit;
        inp.onkeydown = function (ev) {
          if (ev.key === 'Enter') inp.blur();
          if (ev.key === 'Escape') { inp.value = l.name; inp.blur(); }
          ev.stopPropagation();
        };
      };
      row.appendChild(nm);

      row.onclick = function () { engine.setActiveLayer(l.id); };
      box.appendChild(row);
    });
    syncLayerHead();
  }

  function syncLayerHead() {
    var l = engine.activeLayer();
    $('#layerCount').textContent = engine.layers.length;
    if (!l) return;
    $('#layerBlend').value = l.blend;
    $('#layerOpacity').value = Math.round(l.opacity * 100);
    $('#layerOpacityVal').textContent = Math.round(l.opacity * 100);
    $('#alphaLockChk').checked = !!l.alphaLock;
    $('#lockChk').checked = !!l.locked;
  }

  function patchActiveLayer(patch) {
    if (!S.joined) return;
    var l = engine.activeLayer();
    if (!l) return;
    net.send(P.C2S.LAYER_UPD, { layerId: l.id, patch: patch });
  }

  function layerDup() {
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    var png = engine.renderLayerRaw(l.id).toDataURL('image/png');
    net.send(P.C2S.LAYER_DUP, { layerId: l.id, png: png, upToSeq: engine.seq });
  }

  async function layerClear() {
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    if (!await confirmDialog('清除图层「' + l.name + '」上的所有内容？', { danger: true })) return;
    net.send(P.C2S.LAYER_CLEAR, { layerId: l.id });
  }

  async function layerDel() {
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    if (!await confirmDialog('删除图层「' + l.name + '」？', { danger: true })) return;
    net.send(P.C2S.LAYER_DEL, { layerId: l.id });
  }

  function layerMove(dir) {
    var l = engine.activeLayer();
    if (!l || !S.joined) return;
    var i = engine.layers.indexOf(l);
    var to = i + dir;
    if (to < 0 || to >= engine.layers.length) { toast('已经到头了'); return; }
    net.send(P.C2S.LAYER_MOVE, { layerId: l.id, to: to });
  }

  function layerMerge() {
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
    return {
      id: 'imp_' + (rec.hash || 'x') + '_' + idx,
      name: rec.name || ('导入笔刷 ' + (idx + 1)),
      tool: 'brush',
      icon: 'imported',
      type: 'brush',
      tip: '导入的笔刷（' + (rec.sourceLabel || '') + '）｜笔尖 ' + d + 'px',
      imported: true,
      params: {
        brush: 'custom',
        size: d,
        opacity: 1,
        hardness: rec.hardness == null ? 0.8 : rec.hardness,
        minSize: 0.4,
        pressSize: 0.8,
        pressOpacity: 0,
        // 导入的笔刷靠笔尖出形状，关掉颗粒与散布 ——
        // 那两样是给圆头笔加质感的，叠在笔尖上只会把形状糊掉
        grain: 0,
        scatter: 0,
        spacing: rec.spacing || 0.1,
        tip: rec.tip
      }
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
    var pending = list.length;
    var collected = [];
    var failed = [];

    list.forEach(function (f) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var res = window.ChaBrushImport.parse(f.name, new Uint8Array(fr.result));
          if (!res.brushes.length) throw new Error('里面没有可导入的笔刷');
          res.brushes.slice(0, IMPORT_MAX).forEach(function (b) {
            b.sourceLabel = f.name + (res.kind === 'abr' ? '（Photoshop）' : '（CSP）');
            b.hash = simpleHash(f.name + '|' + (b.name || '') + '|' + String(b.tip || '').slice(0, 32));
            collected.push(b);
          });
        } catch (e) {
          failed.push(f.name + '：' + e.message);
        }
        if (--pending === 0) finish();
      };
      fr.onerror = function () {
        failed.push(f.name + '：读取失败');
        if (--pending === 0) finish();
      };
      fr.readAsArrayBuffer(f);
    });

    function finish() {
      if (failed.length) toast('这些文件没能解析：' + failed.join('；'), 'err', 6000);
      if (!collected.length) return;
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
      var bits = [];
      if (b.diameter) bits.push(b.diameter + 'px');
      if (b.spacing) bits.push('间距 ' + Math.round(b.spacing * 100) + '%');
      if (b.hardness != null) bits.push('硬度 ' + b.hardness.toFixed(2));
      var thumb = b.tip ? tipThumb(b.tip, 34) : '';
      row.innerHTML =
        '<input type="checkbox" checked data-i="' + i + '">' +
        (thumb ? '<img class="imp-tip" src="' + thumb + '" alt="">' : '<span class="imp-tip"></span>') +
        '<span class="imp-name">' + esc(b.name) + '</span>' +
        '<span class="imp-meta">' + esc(bits.join(' · ')) + '</span>';
      body.appendChild(row);
    });
    $('#importMask').classList.remove('hidden');
    $('#btnImportAll').onclick = function () {
      $('#importBody input[type=checkbox]').forEach(function (c) { c.checked = true; });
    };
    $('#btnImportNone').onclick = function () {
      $('#importBody input[type=checkbox]').forEach(function (c) { c.checked = false; });
    };
    $('#btnImportCancel').onclick = function () { $('#importMask').classList.add('hidden'); };
    $('#btnImportOk').onclick = function () {
      var keep = [];
      $('#importBody input[type=checkbox]').forEach(function (c) {
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
    box.innerHTML = '';
    S.members.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'member';
      el.innerHTML =
        '<div class="ava" style="background:' + esc(m.color) + '">' + esc((m.name || '?').slice(0, 1)) + '</div>' +
        '<div class="info"><b>' + esc(m.name) +
        (m.isOwner ? '<span class="badge">房主</span>' : '') +
        (m.userId === S.me.userId ? '<span class="badge me">我</span>' : '') +
        '</b><span>' + (m.drawing ? '<span class="live">正在作画…</span>' : '在房间里') + '</span></div>';
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
        '<div class="ava" style="background:' + esc(m.color || '#999') + '">' + esc((m.name || '?').slice(0, 1)) + '</div>' +
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
      renderLanBar();
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
      var html = '<div class="rn"><b>' + esc(r.name) + (r.hasPassword ? ' 🔒' : '') +
        (r.blank ? ' <i class="tag-blank">空房</i>' : '') + '</b>' +
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
    net.send(P.C2S.ROOM_JOIN, { roomId: roomId, user: name, password: '' });
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

  function updateBrushCursor() {
    var el = bcNode();
    if (!el) return;
    // 变换模式下不显示画笔光标（那时指针在拖变换框）
    var hide = !S.pointer.inside || S.tool === 'picker' || !!S.pan || !S.joined || !!engine.transform;
    el.classList.toggle('hidden', hide);
    if (hide) return;
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

  function beginLocal(px, py, pressure, pointerType) {
    var layer = engine.activeLayer();
    if (!layer || !S.joined) return;
    if (layer.locked) { toast('图层「' + layer.name + '」已锁定'); return; }

    var usePressure = S.pressure && pointerType && pointerType !== 'mouse';
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
      beginSelSnapshot();
      var winfo = strokeInfo(id, layer, false, { add: S.modShift, subtract: S.modAlt });
      var wst = engine.beginStroke(Object.assign({ local: true }, winfo));
      if (!wst) return;
      engine.addPoints(id, [[Math.round(px), Math.round(py), 0.5]]);
      engine.endStroke(id, 0);
      afterRegionSelect();
      return;
    }

    // 选区类工具（选区笔 / 选区擦 / 框选 / 套索）都要留一份旧蒙版，方便撤回
    if (isSelectToolId(S.tool)) beginSelSnapshot();

    var info2 = strokeInfo(id, layer, usePressure, { add: S.modShift, subtract: S.modAlt });
    var stroke = engine.beginStroke(Object.assign({ local: true }, info2));
    if (!stroke) return;
    S.session = { id: id, last: [px, py], pending: [], tool: S.tool, local: isSelectToolId(S.tool) };
    smooth.x = px; smooth.y = py;

    // 选区是本机私有的状态，不进历史、不同步
    if (S.session.local) {
      var p0 = P.qp([px, py, usePressure ? pressure : 0.5]);
      S.session.last = [p0[0], p0[1]];
      engine.addPoints(id, [p0]);
      return;
    }

    net.send(P.C2S.STROKE_BEGIN, info2);

    // 与协议一致地量化采样点：远端回放用的是量化后的坐标，
    // 本地若用原始浮点会出现亚像素差异（模糊 / 水彩边缘会把它放大）
    var p = P.qp([px, py, usePressure ? pressure : 0.5]);
    S.session.last = [p[0], p[1]];
    engine.addPoints(id, [p]);
    S.session.pending.push(p);
    flushPoints(true);
  }

  function moveLocal(px, py, pressure, pointerType) {
    if (!S.session) return;
    var usePressure = S.pressure && pointerType && pointerType !== 'mouse';
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

    var p = P.qp([x, y, usePressure ? pressure : 0.5]);
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
      if (e.button !== 0) return;
      if (!S.joined) { openEntry(true); return; }
      var sp = stagePoint(e);
      S.pointer.sx = sp.x; S.pointer.sy = sp.y; S.pointer.inside = true;
      // 选区的加选 / 减选修饰键（框选、套索、魔棒、选区笔都用）
      S.modShift = !!e.shiftKey;
      S.modAlt = !!e.altKey;
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
      beginLocal(dp.x, dp.y, e.pressure, e.pointerType);
    });

    view.addEventListener('pointerenter', function () { setPointerCursor(true); });

    view.addEventListener('pointermove', function (e) {
      var sp = stagePoint(e);
      S.pointer.sx = sp.x;
      S.pointer.sy = sp.y;
      S.pointer.inside = true;
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
  }

  /* ============================================================ 图像变换 */

  function startTransform() {
    if (engine.transform) return;
    if (!S.joined) { openEntry(true); return; }
    var layer = engine.activeLayer();
    if (!layer) return;
    if (layer.locked) { toast('图层「' + layer.name + '」已锁定', 'err'); return; }
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
    var entry = S.cursors.get(m.userId);
    if (!entry) {
      var el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = '<div class="pin" style="background:' + esc(m.color || '#888') + '"></div>' +
        '<div class="tag" style="background:' + esc(m.color || '#888') + '">' + esc(m.name || '') + '</div>';
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

  /* ============================================================ 同步处理 */

  function handleMessage(msg) {
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
        S.me.isOwner = !!msg.you.isOwner;
        S.joined = true;
        S.myUndo = []; S.myRedo = [];
        clearCursors();

        engine.init({
          width: msg.room.width, height: msg.room.height,
          background: msg.room.background, layers: msg.layers
        });
        S.joinCount = (S.joinCount || 0) + 1;
        // 服务端 seq 是权威水位（撤销/重做会让它领先于最大笔迹 seq）
        var lastSeq = (msg.history && msg.history.lastSeq) || 0;
        engine.seq = Math.max(engine.seq, lastSeq);
        var bases = (msg.history && msg.history.baseImages) || {};
        Object.keys(bases).forEach(function (lid) { engine.setBaseImage(lid, bases[lid]); });

        S.members = msg.members || [];
        renderMembers();
        $('#chatList').innerHTML = '';
        (msg.chat || []).forEach(function (m) { renderChatMsg(m); });

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

      case P.S2C.MEMBERS: {
        S.members = msg.members || [];
        var ids = S.members.map(function (m) { return m.userId; });
        S.cursors.forEach(function (v, k) { if (ids.indexOf(k) < 0) removeCursor(k); });
        renderMembers();
        renderRoomChip();
        break;
      }

      case P.S2C.ROOM_UPDATED: {
        if (msg.patch) {
          if (msg.patch.id === (S.room && S.room.id)) {
            var bases = msg.patch.baseImages;
            Object.assign(S.room, msg.patch);
            if (bases) Object.keys(bases).forEach(function (lid) { engine.setBaseImage(lid, bases[lid]); });
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
        engine.setLayers(msg.layers || [], msg.baseImages || null);
        pruneUndo();
        renderLayers();
        renderHistory();
        refreshNav();
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

      case P.S2C.ROOM_LEFT:
        resetRoomUi('');
        break;

      case P.S2C.ROOM_DESTROYED:
        resetRoomUi('房主解散了房间' + (msg.by ? '（' + msg.by + '）' : '') + '，你已被请出');
        break;

      case P.S2C.OK:
        if (typeof msg.purged === 'number') {
          toast(msg.purged ? '已清理 ' + msg.purged + ' 个空房间' : '没有可清理的空房间');
        } else if (msg.deleted) {
          toast('房间已删除');
        }
        break;

      case P.S2C.ERROR:
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
    loopReplay();
    toast('回放中 · ' + engine.replayStrokes.length + ' 笔', 'ok');
  }

  function loopReplay() {
    if (!S.replay.playing) return;
    var now = performance.now();
    var dt = now - S.replay.last;
    S.replay.last = now;
    var dur = engine.replayDuration();
    S.replay.t = Math.min(dur, S.replay.t + dt * S.replay.speed);
    engine.replaySeek(S.replay.t);
    $('#replayRange').value = Math.round(S.replay.t / dur * 1000);
    $('#replayTime').textContent = fmtClock(S.replay.t) + ' / ' + fmtClock(dur);
    if (S.replay.t >= dur) {
      S.replay.playing = false;
      $('#btnReplayToggle').textContent = '重播';
      return;
    }
    S.replay.raf = requestAnimationFrame(loopReplay);
  }

  function stopReplay() {
    S.replay.playing = false;
    cancelAnimationFrame(S.replay.raf);
    engine.setReplayMode(false);
    $('#replayBar').classList.add('hidden');
    $('#stage').classList.remove('replaying');
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
   * 导出：png / jpg / jpeg / webp / bmp / tga
   * 编码见 export-formats.js；这里只管选格式、问画质、把结果落盘。
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
    var canvas = engine.renderDocument({}).canvas;
    var data;
    try {
      data = global.ChaExport.encode(canvas, f.id, q);
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
      return;
    }
    download(stampName() + '.' + f.ext, data);
    toast('已导出 ' + f.ext.toUpperCase() + '（' + canvas.width + ' × ' + canvas.height + '）', 'ok', 3200);
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

  function doShare() {
    if (!S.room) { toast('还没有进入房间'); return; }
    var base = shareBase();
    var text = base ? base + '/?room=' + S.room.id : S.room.id;
    var note = text + (S.room.hasPassword ? '（房间有密码，请向房主索取）' : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(note).then(function () {
        toast('分享链接已复制：' + note, 'ok', 3600);
      }, function () { showInfo(text); });
    } else {
      showInfo(text);
    }
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
      (S.publicUrl
        ? '<div class="kv"><label>公网入口</label><div><code>' + esc(S.publicUrl) + '</code>' +
          '<span class="hint">（外网的朋友打开这个地址就能加入）</span></div></div>'
        : '<div class="kv"><label>公网入口</label><div><span class="hint">未开启 —— 在服务端机器上运行 ' +
          'npm run expose 就能生成一个外网可访问的链接</span></div></div>') +
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

  function resetRoomUi(reason) {
    // 掉线 / 换房时把没提交的变换丢掉，免得图层一直停在「被挖空」的状态
    if (engine.transform) { engine.endTransform(false); endTransformUi(); }
    S.joined = false;
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
        if (e.key === 'n' && e.shiftKey) {
          e.preventDefault();
          if (S.joined) net.send(P.C2S.LAYER_ADD, { name: '图层 ' + (engine.layers.length + 1) });
          return;
        }
        return;
      }
      var k = e.key.toLowerCase();
      var map = {
        b: 'brush', e: 'eraser', u: 'blur', s: 'smudge', l: 'line',
        r: 'rect', o: 'ellipse', g: 'fill', n: 'gradient',
        q: 'select', w: 'selectErase', i: 'picker'
      };
      if (map[k]) { setTool(map[k]); return; }
      if (k === '[') { setSize(S.brush.size - Math.max(1, S.brush.size * 0.15)); return; }
      if (k === ']') { setSize(S.brush.size + Math.max(1, S.brush.size * 0.15)); return; }
      if (k === 'x') { swapColors(); return; }
      if (k === 'h') { engine.flipView(); return; }
      if (k === ',') { engine.rotateBy(-15); return; }
      if (k === '.') { engine.rotateBy(15); return; }
      if (k === '0') { engine.fitView(); return; }
      if (k === '1') {
        engine.setZoom(1);
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
  }

  function swapColors() {
    var c = S.color;
    setColor(S.bgColor, false);
    S.bgColor = c;
    drawWheel();
    toast('前景 ' + S.color.toUpperCase() + ' / 背景 ' + S.bgColor.toUpperCase());
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
      // 小图（含动图）原样保留，大图压到 220px
      if (f.size <= 160 * 1024) {
        var fr = new FileReader();
        fr.onload = function () { accept(P.normalizeSticker(String(fr.result))); };
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
    $('#filledChk').addEventListener('change', function () { bset('filled', this.checked); });
    $('#pressureChk').addEventListener('change', function () {
      S.pressure = this.checked;
      lsSet('chahu.pressure', S.pressure ? '1' : '0');
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

    $('#lockChk').addEventListener('change', function () { patchActiveLayer({ locked: this.checked }); });

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
      drawWheel();
    });
    $('#btnSwap').addEventListener('click', swapColors);

    // 工具栏和笔刷栏各有一个「编辑」按钮，但共用同一个编辑状态 —— 点哪个都是两栏一起进编辑
    function toggleToolEdit(btn) {
      S.toolEdit = !S.toolEdit;
      $$('#btnToolEdit, #btnBrushEdit').forEach(function (b) { b.classList.toggle('active', S.toolEdit); });
      renderToolGrid();
      toast(S.toolEdit ? '编辑中：◀ ▶ 调顺序，✕ 收起' : '已退出编辑');
      void btn;
    }
    $('#btnToolEdit').addEventListener('click', function () { toggleToolEdit(this); });
    $('#btnBrushEdit').addEventListener('click', function () { toggleToolEdit(this); });
    $('#btnToolReset').addEventListener('click', resetToolPrefs);

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
    $('#btnInfoClose').addEventListener('click', function () { $('#infoMask').classList.add('hidden'); });
    $('#btnRefreshRooms').addEventListener('click', function () {
      applyServer($('#serverInput').value);
      setTimeout(function () { net.send(P.C2S.ROOM_LIST, {}); }, 350);
    });
    $('#btnCopyLan').addEventListener('click', copyLan);
    $('#btnPurgeRooms').addEventListener('click', purgeRooms);
    $('#serverInput').addEventListener('change', function () { applyServer(this.value); this.value = net.url; });
    $('#btnCreateRoom').addEventListener('click', doCreate);

    $('#roomChip').addEventListener('click', function () {
      if (S.room) showInfo();
      else openEntry(true);
    });

    $('#btnExport').addEventListener('click', doExport);
    $('#btnShare').addEventListener('click', doShare);
    $('#btnBake').addEventListener('click', bake);
    $('#btnCanvas').addEventListener('click', openCanvasDialog);
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
    });
    $('#replaySpeed').addEventListener('change', function () { S.replay.speed = Number(this.value); });

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
    $('#btnLayerUp').addEventListener('click', function () { layerMove(1); });
    $('#btnLayerDown').addEventListener('click', function () { layerMove(-1); });
    $('#btnLayerMerge').addEventListener('click', layerMerge);
    $('#btnLayerClear').addEventListener('click', layerClear);
    $('#btnLayerDel').addEventListener('click', layerDel);
    $('#btnLayerFlatten').addEventListener('click', layerFlatten);

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
    bindUI();
    bindKeys();
    bindCanvas();
    bindViewBar();
    bindWheel();
    bindPanelDnD();
    bindQuickBar();
    bindRefWindow();
    // 侧栏收拉：把手 / 窄条 / F4（菜单里那项也走同一个函数）
    $('#btnSideCollapse').addEventListener('click', function () { setSideCollapsed(true); });
    $('#sideRail').addEventListener('click', function () { setSideCollapsed(false); });
    setSideCollapsed(lsGet('chahu.side', '1') === '0');
    $('#btnAboutClose').addEventListener('click', function () { $('#aboutMask').classList.add('hidden'); });
    $('#btnCheckUpdate').addEventListener('click', checkUpdate);
    $$('.about-tabs .tab').forEach(function (t) { t.addEventListener('click', function () { showAboutTab(t.dataset.atab); }); });
    $('#refFileInput').addEventListener('change', function () { loadReferenceImage(this.files[0]); });
    bindTransformPanel();
    engine.attach($('#view'), $('#overlay'));

    loadBrush(S.brushId);
    setColor('#2b2b2b', false);
    drawWheel();
    $('#symSelect').value = S.sym;
    $('#cursorStyle').value = S.cursorStyle;
    syncViewBar();
    refreshNav();

    net.on('status', function (e) { renderConn(e.status); });
    net.on('open', function () {
      if (S.room && S.room.id && S.me.name) {
        setStatus('已重连，正在回到「' + S.room.name + '」…');
        net.send(P.C2S.ROOM_JOIN, { roomId: S.room.id, user: S.me.name });
      }
      // 每次连上（含重连）都问一次：隧道可能是中途才开的
      probePublicUrl();
    });
    net.on('message', handleMessage);
    net.on('retry', function (e) { setStatus('连接中断，' + Math.round(e.delay / 1000) + 's 后重试…'); });

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
          net.send(P.C2S.ROOM_JOIN, { roomId: autoRoom, user: name });
        }
      }, 300);
      setTimeout(function () { clearInterval(t); }, 15000);
    } else {
      setTimeout(function () { openEntry(true); }, 420);
    }

    setTimeout(function () { engine.fitView(); }, 120);
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

  function cropToSelection() {
    if (!S.joined) { toast('先进入一个房间', 'err'); return; }
    if (!engine.hasSelection()) { toast('先用选区工具圈一块出来', 'err'); return; }
    var bb = engine.selectionBBox();
    if (!bb) { toast('选区是空的', 'err'); return; }
    if (!confirm('裁剪到选区？画布会变成 ' + Math.round(bb.w) + ' × ' + Math.round(bb.h) + '，这一步可以撤销。')) return;
    if (engine.transform) commitTransform();
    // 先把整幅画面按选区偏移搬一次，再改画布尺寸
    var W = engine.width, H = engine.height;
    var tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    var tc = tmp.getContext('2d');
    engine.renderDocument({}).ctx = null;   // 只是取一下渲染管线，不用它的 ctx
    var doc = engine.renderDocument({});
    tc.drawImage(doc.canvas, 0, 0);
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(bb.w));
    out.height = Math.max(1, Math.round(bb.h));
    out.getContext('2d').drawImage(tmp, -Math.round(bb.x), -Math.round(bb.y));
    applyCropped(out);
  }

  /** 把裁剪结果作为新的底图铺回去，然后改画布尺寸 */
  function applyCropped(canvas) {
    var b = engine.activeLayer();
    var png = canvas.toDataURL('image/png');
    // 走既有的「图像大小」那条路：改尺寸 + 缩放画面，服务端照单全收
    scaleArtwork(canvas.width, canvas.height, function () {
      b.baseImage = png;
      b.baseSeq = engine.seq;
      b.strokes = [];
    });
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


  function sectionEl(id) { return document.querySelector('#leftPanelScroll [data-section="' + id + '"]'); }

  function toggleSection(id) {
    var el = sectionEl(id);
    if (!el) return;
    var hidden = el.classList.toggle('hidden');
    var st = {};
    try { st = JSON.parse(localStorage.getItem('chahu.sections') || '{}') || {}; } catch (e) { st = {}; }
    st[id] = hidden ? 0 : 1;
    try { localStorage.setItem('chahu.sections', JSON.stringify(st)); } catch (e) { /* ignore */ }
    engine.resize();
  }

  function resetPanels() {
    try {
      localStorage.removeItem('chahu.sections');
      localStorage.removeItem('chahu.panels');
    } catch (e) { /* ignore */ }
    $('#leftPanelScroll [data-section]').forEach(function (s) { s.classList.remove('hidden'); });
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

  function setUiScale(f) {
    S.uiScale = f;
    document.documentElement.style.setProperty('--ui-scale', String(f));
    try { localStorage.setItem('chahu.uiscale', String(f)); } catch (e) { /* ignore */ }
    var l = document.querySelector('#leftPanelScroll');
    if (l) l.style.zoom = f === 1 ? '' : String(f);
    engine.resize();
    toast('界面缩放：' + Math.round(f * 100) + '%');
  }

  function setCursorMode(mode) {
    S.cursorStyle = mode === 'dot' ? 'cross' : (mode === 'ring' ? 'ring' : 'auto');
    try { localStorage.setItem('chahu.cursor', S.cursorStyle); } catch (e) { /* ignore */ }
    updateBrushCursor();
    toast('画笔光标：' + (S.cursorStyle === 'ring' ? '大小圆形' : S.cursorStyle === 'cross' ? '圆点' : '智能'));
  }

  function toggleLeftPanel() {
    var el = document.querySelector('aside.panel.left');
    if (!el) return;
    var hidden = el.classList.toggle('hidden');
    S.leftPanelOpen = !hidden;
    engine.resize();
    toast(hidden ? '已隐藏全部操作面板' : '已显示全部操作面板');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () { });
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { toast('浏览器不允许全屏', 'err'); });
    }
  }

  function openSettings() {
    global.ChaMenu.openKeyDialog();
  }

  /* ================================================================
   * 画布上沿的快捷小菜单（照 SAI2 顶部那一条）
   * ================================================================ */

  var QB_COLLAPSED = 'chahu.quickbar.collapsed';

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

  function bindQuickBar() {
    var bar = $('#quickBar');
    if (!bar) return;

    function setCollapsed(on) {
      bar.classList.toggle('collapsed', !!on);
      $('#qbToggle').textContent = on ? '▸' : '▾';
      $('#qbToggle').title = on ? '拉开快捷菜单' : '收起快捷菜单';
      try { localStorage.setItem(QB_COLLAPSED, on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
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
  function checkUpdate() {
    var box = $('#aboutUpdate');
    var msg = $('#aboutUpdateMsg');
    var cur = (global.CHAHU_CONFIG && global.CHAHU_CONFIG.appVersion) || '0.0.0';
    box.classList.remove('has-new');
    msg.textContent = '正在检查更新…';
    var ac = global.AbortController ? new global.AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, 8000);
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' }, signal: ac ? ac.signal : undefined })
      .then(function (r) { clearTimeout(timer);
        if (!r.ok) throw new Error('GitHub 返回 ' + r.status);
        return r.json();
      })
      .then(function (rel) {
        var tag = String(rel.tag_name || '').replace(/^v/, '');
        if (!tag) throw new Error('没有读到版本号');
        if (cmpVer(tag, cur) > 0) {
          box.classList.add('has-new');
          msg.innerHTML = '有新版本 <b>v' + esc(tag) + '</b> 可用（当前 v' + esc(cur) + '）' +
            ' <a href="' + esc(rel.html_url || '') + '" target="_blank" rel="noreferrer">去下载</a>';
        } else {
          msg.textContent = '已经是最新版（v' + cur + '）';
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
    S.textAt = { x: dp.x, y: dp.y };
    buildTextFamilies();
    $('#textNote') && ($('#textNote').textContent = '');
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
    if (needLayer) setTimeout(doIt, 260);      // 等图层建好
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

  function setSideCollapsed(collapsed) {
    var el = $('#sidePanel');
    var rail = $('#sideRail');
    if (!el) return;
    el.classList.toggle('hidden', !!collapsed);
    if (rail) rail.classList.toggle('hidden', !collapsed);
    S.sideCollapsed = !!collapsed;
    try { localStorage.setItem('chahu.side', collapsed ? '0' : '1'); } catch (e) { /* ignore */ }
    engine.resize();
  }

  function toggleSide() {
    setSideCollapsed(!S.sideCollapsed);
  }

  global.ChaApp = {
    engine: engine, net: net, state: S, undo: undo, redo: redo, toast: toast,
    // 笔刷导入（给测试用，也让控制台里能手动导一支试试）
    openBrushImport: openBrushImport,
    handleBrushFiles: handleBrushFiles,
    applyImported: applyImported,
    removeImported: removeImported,
    tipThumb: tipThumb,

    /* ---- 菜单栏 / 快捷键要用到的动作（菜单结构见 menu.js） ---- */
    openEntry: openEntry, doExport: doExport, doShare: doShare, showInfo: showInfo,
    toggleRecord: toggleRecord,
    toggleReplay: function () { if (engine.replayMode) stopReplay(); else startReplay(); },
    leaveRoom: leaveRoom,
    addLayer: addLayer, moveLayer: moveLayer, clearLayer: clearLayer,
    openCanvasDialog: openCanvasDialog, bake: bake,
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
    dupLayer: dupLayer, delLayer: delLayer, mergeDown: mergeDown, mergeVisible: mergeVisible,
    setBackground: setBackground,
    toggleMarchingAnts: toggleMarchingAnts,
    growSelection: growSelection, shrinkSelection: shrinkSelection,
    setUiScale: setUiScale, setCursorMode: setCursorMode,
    toggleLeftPanel: toggleLeftPanel, toggleFullscreen: toggleFullscreen,
    openSettings: openSettings,
    openAbout: openAbout, checkUpdate: checkUpdate, cmpVer: cmpVer,
    openToneDialog: openToneDialog, updateTonePreview: updateTonePreview, closeToneDialog: closeToneDialog,
    openLevelsDialog: openLevelsDialog, closeLevelsDialog: closeLevelsDialog, levelsOpts: levelsOpts, levelsAuto: levelsAuto,
    openBlurDialog: openBlurDialog, closeBlurDialog: closeBlurDialog, blurRadius: blurRadius,
    openExportDialog: openExportDialog, exportAs: exportAs, syncExportNote: syncExportNote,
    armRuler: armRuler, clearRuler: clearRuler, toggleRulerVisible: toggleRulerVisible, commitRuler: commitRuler,
    toggleQuickBarSteadier: toggleQuickBarSteadier,
    openTextDialog: openTextDialog, commitText: commitText, placeTextAt: placeTextAt, textOpts: textOpts,
    bindQuickBar: bindQuickBar, updateQuickBar: updateQuickBar,
    loadReferenceImage: loadReferenceImage, clearReferenceImage: clearReferenceImage
  };
})(window);
