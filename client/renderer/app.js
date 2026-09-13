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
    stickers: [],             // 自定义表情（dataURL）
    stickerManaging: false,
    pressure: lsGet('chahu.pressure', '1') === '1',
    stabilize: Number(lsGet('chahu.stabilize', '0')) || 0,
    sym: P.SYMMETRY_MODES.indexOf(lsGet('chahu.sym', 'none')) >= 0 ? lsGet('chahu.sym', 'none') : 'none',
    // 画笔光标样式：auto（大笔刷圆环 / 小笔刷十字）、ring（始终圆环）、cross（始终十字）
    cursorStyle: ['auto', 'ring', 'cross'].indexOf(lsGet('chahu.cursor', 'auto')) >= 0 ? lsGet('chahu.cursor', 'auto') : 'auto',
    recent: [],
    hue: 0, sv: { s: 1, v: 1 },
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

  var PANEL_DEFAULT_ORDER = ['nav', 'tools', 'brush', 'fx', 'color', 'layers'];

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

  function renderToolGrid() {
    var box = $('#toolGrid');
    box.innerHTML = '';
    box.classList.toggle('editing', S.toolEdit);
    visibleItems().forEach(function (it) {
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
      box.appendChild(b);
    });
    renderHiddenPool();
    var cur = Brushes.get(S.brushId);
    $('#brushFamily').textContent = Brushes.FAMILY[S.tool] || '画笔';
    $('#brushTip').textContent = cur ? cur.tip : '—';
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

  function moveItem(id, dir) {
    var order = S.toolPrefs.order;
    var i = itemIndex(id);
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    var t = order[i]; order[i] = order[j]; order[j] = t;
    saveToolPrefs();
    renderToolGrid();
  }

  function hideItem(id) {
    var vis = visibleItems();
    if (vis.length <= 1) { toast('至少保留一个工具', 'err'); return; }
    if (S.toolPrefs.hidden.indexOf(id) < 0) S.toolPrefs.hidden.push(id);
    if (S.brushId === id) {
      var next = visibleItems()[0] || Brushes.ITEMS[0];
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
    ctx.fillStyle = S.tool === 'eraser' ? '#c9ced8' : S.color;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var x = 12 + t * (w - 24);
      var y = h / 2 + Math.sin(t * Math.PI * 1.6) * 6 - 3;
      var rr = r * (1 - (1 - b.minSize) * Math.pow(1 - t, 2));
      var a = b.opacity * ((1 - b.pressOpacity) + b.pressOpacity * Math.pow(t, 0.7));
      ctx.globalAlpha = clamp(a, 0.03, 1);
      var blur = b.hardness < 0.995 ? b.size * (1 - b.hardness) * 0.5 : 0;
      ctx.filter = blur > 0.3 ? 'blur(' + Math.min(6, blur).toFixed(2) + 'px)' : 'none';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, rr), 0, Math.PI * 2);
      ctx.fill();
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
    var tr = r0 - 6;
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
      var img = ctx.createImageData(w, h);
      var d = img.data;
      var v0x = B[0] - A[0], v0y = B[1] - A[1];
      var v1x = C[0] - A[0], v1y = C[1] - A[1];
      var den = v0x * v1y - v1x * v0y;
      for (var j = 0; j < h; j++) {
        for (var i = 0; i < w; i++) {
          var px = minx + i, py = miny + j;
          var v2x = px - A[0], v2y = py - A[1];
          var u = ((v2x * v1y - v1x * v2y) / den);
          var vv = ((v0x * v2y - v2x * v0y) / den);
          var ww = 1 - u - vv;
          var o = (j * w + i) * 4;
          if (u < -0.004 || vv < -0.004 || ww < -0.004) { d[o + 3] = 0; continue; }
          u = clamp(u, 0, 1); vv = clamp(vv, 0, 1); ww = clamp(ww, 0, 1);
          var sum = u + vv + ww || 1;
          u /= sum; vv /= sum; ww /= sum;
          d[o] = Math.round(u * hue[0] + vv * 255 + ww * 0);
          d[o + 1] = Math.round(u * hue[1] + vv * 255 + ww * 0);
          d[o + 2] = Math.round(u * hue[2] + vv * 255 + ww * 0);
          d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, minx, miny);
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
    var s = S.sv.s, v = S.sv.v;
    var sx = u_weight(A, B, C, [1 - s, s * (1 - v), s * v])[0];
    var sy = u_weight(A, B, C, [1 - s, s * (1 - v), s * v])[1];
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
      drag = true;
      cv.setPointerCapture(e.pointerId);
      pick(e);
    });
    cv.addEventListener('pointermove', function (e) { if (drag) pick(e); });
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
    S.hue = hsv.h;
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
    var cross = style === 'cross' || (style === 'auto' && raw < 9);
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
      filled: !!b.filled
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
      /* ---- 变换模式：所有指针事件都交给变换框 ---- */
      if (engine.transform) {
        if (e.button !== 0) return;
        e.preventDefault();
        var tsp = stagePoint(e);
        var tdp = engine.screenToDoc(tsp.x, tsp.y);
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

      // Alt 临时吸管（SAI 习惯）
      if (S.tool === 'picker' || e.altKey) {
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
      if (engine.transform) {
        if (S.transformDragging) { engine.transform.dragEnd(); S.transformDragging = false; }
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

  /**
   * 分享链接的基地址。
   * 优先用局域网地址：桌面端内置服务器起来后，朋友要用你的内网 IP 才能打开，
   * 用 localhost 发出去对方点开只会连到他自己那台机器。
   */
  function shareBase() {
    var lan = Cfg.lanBase ? Cfg.lanBase() : '';
    if (lan) return lan;
    return Cfg.httpBaseOf(net.url);
  }

  function doShare() {
    if (!S.room) { toast('还没有进入房间'); return; }
    var base = shareBase();
    var text = base ? base + '/?room=' + S.room.id : S.room.id;
    if (S.room.hasPassword) text += '（房间有密码，请向房主索取）';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('分享链接已复制：' + text, 'ok', 3600);
      }, function () { showInfo(text); });
    } else {
      showInfo(text);
    }
  }

  function showInfo(text) {
    $('#infoTitle').textContent = '房间信息';
    var r = S.room || {};
    $('#infoBody').innerHTML =
      '<div class="kv"><label>房间名</label><div>' + esc(r.name || '-') + '</div></div>' +
      '<div class="kv"><label>房间号</label><div><code>' + esc(r.id || '-') + '</code></div></div>' +
      '<div class="kv"><label>画布</label><div><b>' + (r.width || 0) + ' × ' + (r.height || 0) + '</b> px · ' + (r.online || 0) + ' 人在线' +
        (S.me.isOwner ? ' <button class="btn tiny ghost" id="btnInfoResize">更改分辨率…</button>' : '') +
      '</div></div>' +
      '<div class="kv"><label>笔迹</label><div>' + engine.strokes.length + ' 笔（我可撤销 ' + S.myUndo.length + ' 笔）</div></div>' +
      '<div class="kv"><label>图层</label><div>' + engine.layers.length + ' 层</div></div>' +
      '<div class="kv"><label>服务器</label><div><code>' + esc(net.url) + '</code></div></div>' +
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
    engine.drawOverlay();
    engine.emit('selection', { active: true });
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

    $('#btnToolEdit').addEventListener('click', function () {
      S.toolEdit = !S.toolEdit;
      this.classList.toggle('active', S.toolEdit);
      renderToolGrid();
      toast(S.toolEdit ? '工具栏编辑中：◀ ▶ 调顺序，✕ 收起' : '已退出工具栏编辑');
    });
    $('#btnToolReset').addEventListener('click', resetToolPrefs);

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
      if (S.room) {
        var base = Cfg.httpBaseOf(net.url);
        showInfo(base ? base + '/?room=' + S.room.id : S.room.id);
      } else { openEntry(true); }
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
    loadToolPrefs();
    applyPanelOrder();
    bindUI();
    bindKeys();
    bindCanvas();
    bindViewBar();
    bindWheel();
    bindPanelDnD();
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

  global.ChaApp = { engine: engine, net: net, state: S, undo: undo, redo: redo, toast: toast };
})(window);
