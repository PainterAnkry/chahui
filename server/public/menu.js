/**
 * 茶绘 · 菜单栏与快捷键
 *
 * 设计要点：
 *   · 菜单是**数据驱动**的 —— MENUS 里写一条就是一个菜单项，
 *     渲染、快捷键、设置对话框全部读同一份数据，不会再出现「菜单里有但快捷键表里没有」。
 *   · 快捷键可以改：覆盖值存 localStorage，改了立刻生效，键位冲突会当场提示。
 *   · 真正干活的是 app.js 里的函数；这里只负责「叫什么名字、放哪个菜单、默认什么键」。
 */
(function (global) {
  'use strict';

  var LS_KEYS = 'chahu.keys';
  var overrides = {};
  var actions = [];        // 按声明顺序，也是设置对话框里的顺序
  var byId = {};

  function A() { return global.ChaApp || {}; }

  /** 声明一个动作。run 里通过 A() 惰性取 app 的函数，避免加载顺序问题。 */
  function def(menu, id, label, dflt, run, extra) {
    var a = {
      menu: menu, id: id, label: label, def: dflt || '',
      run: run, hint: (extra && extra.hint) || '',
      check: (extra && extra.check) || null     // 返回 true 就在菜单里打勾
    };
    actions.push(a);
    byId[id] = a;
    return a;
  }

  var SEP = { sep: true };

  /* ============================================================ 菜单结构 */

  var MENUS = [
    {
      id: 'file', name: '文件', items: [
        def('file', 'file.room', '房间…', '', function () { A().openEntry(true); }),
        SEP,
        def('file', 'file.export', '导出 PNG', 'Ctrl+S', function () { A().doExport(); }),
        def('file', 'file.record', '录制 / 停止', '', function () { A().toggleRecord(); },
          { check: function () { return !!(A().state && A().state.recording); } }),
        def('file', 'file.replay', '回放 / 停止', '', function () { A().toggleReplay(); }),
        SEP,
        def('file', 'file.importBrush', '导入笔刷（.abr / .sut）…', '', function () { A().openBrushImport(); }),
        def('file', 'file.leave', '离开房间', '', function () { A().leaveRoom(); })
      ]
    },
    {
      id: 'edit', name: '编辑', items: [
        def('edit', 'edit.undo', '撤销', 'Ctrl+Z', function () { A().undo(); }),
        def('edit', 'edit.redo', '重做', 'Ctrl+Y', function () { A().redo(); }),
        SEP,
        def('edit', 'edit.layerAdd', '新建图层', 'Ctrl+Shift+N', function () { A().addLayer(); }),
        def('edit', 'edit.layerUp', '图层上移', '', function () { A().moveLayer(-1); }),
        def('edit', 'edit.layerDown', '图层下移', '', function () { A().moveLayer(1); }),
        def('edit', 'edit.layerClear', '清空当前图层', '', function () { A().clearLayer(); }),
        SEP,
        def('edit', 'edit.keys', '快捷键设置…', '', function () { openKeyDialog(); })
      ]
    },
    {
      id: 'image', name: '图像', items: [
        def('image', 'image.size', '图像大小…', '', function () { A().openCanvasDialog(); }),
        SEP,
        def('image', 'image.flipH', '水平翻转图像', '', function () { A().flipImage('h'); }),
        def('image', 'image.flipV', '垂直翻转图像', '', function () { A().flipImage('v'); }),
        def('image', 'image.rot90cw', '顺时针旋转 90°', '', function () { A().rotateImage(1); }),
        def('image', 'image.rot90ccw', '逆时针旋转 90°', '', function () { A().rotateImage(-1); }),
        SEP,
        def('image', 'image.crop', '裁剪到选区', '', function () { A().cropToSelection(); }),
        def('image', 'image.bake', '固化当前图层', '', function () { A().bake(); })
      ]
    },
    {
      id: 'select', name: '选择', items: [
        def('select', 'select.all', '全选', 'Ctrl+A', function () { A().selectAll(); }),
        def('select', 'select.none', '取消选区', 'Ctrl+D', function () { A().selectNone(); }),
        def('select', 'select.invert', '反选', 'Ctrl+I', function () { A().selectInvert(); }),
        SEP,
        def('select', 'select.transform', '自由变换', 'Ctrl+T', function () { A().toggleTransform(); }),
        def('select', 'select.apply', '变换：确定', 'Enter', function () { A().commitTransform(); }),
        def('select', 'select.abort', '变换：中止', 'Escape', function () { A().cancelTransform(); }),
        SEP,
        def('select', 'select.fromLayer', '按图层不透明区域建立选区', '', function () { A().selectFromLayer(); })
      ]
    },
    {
      id: 'ruler', name: '尺子', items: [
        def('ruler', 'ruler.grid', '显示网格', '', function () { A().toggleGrid(); },
          { check: function () { var s = A().state; return !!(s && s.gridOn); } }),
        SEP,
        def('ruler', 'ruler.symNone', '对称：关闭', '', function () { A().setSymmetry('none'); }),
        def('ruler', 'ruler.symV', '对称：垂直镜像', '', function () { A().setSymmetry('v'); }),
        def('ruler', 'ruler.symH', '对称：水平镜像', '', function () { A().setSymmetry('h'); }),
        def('ruler', 'ruler.sym4', '对称：四向', '', function () { A().setSymmetry('quad'); }),
        SEP,
        def('ruler', 'ruler.steadierUp', '抖动修正 +', '', function () { A().nudgeSteadier(1); }),
        def('ruler', 'ruler.steadierDown', '抖动修正 −', '', function () { A().nudgeSteadier(-1); })
      ]
    },
    {
      id: 'filter', name: '滤镜', items: [
        def('filter', 'filter.blur', '模糊（工具）', 'U', function () { A().setTool('blur'); }),
        def('filter', 'filter.smudge', '涂抹（工具）', 'S', function () { A().setTool('smudge'); }),
        SEP,
        def('filter', 'filter.paperNone', '纸张质感：无', '', function () { A().setPaper('none'); }),
        def('filter', 'filter.paperFine', '纸张质感：细纹', '', function () { A().setPaper('fine'); }),
        def('filter', 'filter.paperCoarse', '纸张质感：粗纹', '', function () { A().setPaper('coarse'); }),
        def('filter', 'filter.paperCanvas', '纸张质感：画布', '', function () { A().setPaper('canvas'); }),
        SEP,
        def('filter', 'filter.fxWater', '特殊效果：水滴', '', function () { A().setFx('water'); }),
        def('filter', 'filter.fxNoise', '特殊效果：噪点', '', function () { A().setFx('noise'); }),
        def('filter', 'filter.fxNone', '特殊效果：关闭', '', function () { A().setFx('none'); })
      ]
    },
    {
      id: 'view', name: '视图', items: [
        def('view', 'view.zoomIn', '放大', '=', function () { A().zoomBy(1.25); }),
        def('view', 'view.zoomOut', '缩小', '-', function () { A().zoomBy(1 / 1.25); }),
        def('view', 'view.zoom100', '实际大小 100%', '1', function () { A().zoom100(); }),
        def('view', 'view.fit', '适应窗口', '0', function () { A().zoomFit(); }),
        SEP,
        def('view', 'view.flip', '水平翻转视图', 'H', function () { A().flipView(); }),
        def('view', 'view.rotL', '向左旋转 15°', ',', function () { A().rotateView(-15); }),
        def('view', 'view.rotR', '向右旋转 15°', '.', function () { A().rotateView(15); }),
        def('view', 'view.rotReset', '角度归零', '', function () { A().rotateView(0, true); }),
        SEP,
        def('view', 'view.nav', '导航器', 'Tab', function () { A().toggleNav(); },
          { check: function () { var s = A().state; return !!(s && s.navOpen); } })
      ]
    },
    {
      id: 'window', name: '窗口', items: [
        def('window', 'window.side', '聊天 / 成员侧栏', 'F4', function () { A().toggleSide(); }),
        SEP,
        def('window', 'window.secNav', '面板：导航器', '', function () { A().toggleSection('nav'); }),
        def('window', 'window.secTools', '面板：工具栏', '', function () { A().toggleSection('tools'); }),
        def('window', 'window.secBrushes', '面板：笔刷栏', '', function () { A().toggleSection('brushes'); }),
        def('window', 'window.secBrush', '面板：画笔参数', '', function () { A().toggleSection('brush'); }),
        def('window', 'window.secFx', '面板：效果', '', function () { A().toggleSection('fx'); }),
        def('window', 'window.secColor', '面板：颜色', '', function () { A().toggleSection('color'); }),
        def('window', 'window.secLayers', '面板：图层', '', function () { A().toggleSection('layers'); }),
        SEP,
        def('window', 'window.resetPanels', '恢复默认面板布局', '', function () { A().resetPanels(); })
      ]
    },
    {
      id: 'other', name: '其他', items: [
        def('other', 'other.info', '房间信息', '', function () { A().showRoomInfo(); }),
        def('other', 'other.share', '复制分享链接', '', function () { A().doShare(); }),
        def('other', 'other.steadier', '清空笔画历史', '', function () { A().clearHistory(); }),
        SEP,
        def('other', 'other.cursor', '切换光标样式', '', function () { A().cycleCursor(); }),
        def('other', 'other.access', '在线人数 / 连接状态', '', function () { A().showStatus(); }),
        SEP,
        def('other', 'other.keys', '快捷键设置…', '', function () { openKeyDialog(); }),
        def('other', 'other.about', '关于茶绘', '', function () { showAbout(); })
      ]
    }
  ];

  /* ============================================================ 快捷键 */

  function loadKeys() {
    try { overrides = JSON.parse(localStorage.getItem(LS_KEYS) || '{}') || {}; }
    catch (e) { overrides = {}; }
  }
  function saveKeys() {
    try { localStorage.setItem(LS_KEYS, JSON.stringify(overrides)); return true; }
    catch (e) { console.error('快捷键保存失败', e); return false; }
  }
  function keyOf(id) {
    var a = byId[id];
    if (!a) return '';
    return overrides[id] === undefined ? a.def : overrides[id];
  }
  /**
   * 设置快捷键。**冲突解决放在这里**，不放在对话框里 ——
   * 这样不管从哪条路径改键（对话框、控制台、将来的导入配置）都不会留下两个动作抢同一个键。
   * @returns 被挤掉的那个动作（没有则 null）
   */
  function setKey(id, key) {
    var cleared = null;
    if (key) {
      var clash = findConflict(id, key);
      if (clash) { overrides[clash.id] = ''; cleared = clash; }
    }
    overrides[id] = key;
    saveKeys();
    return cleared;
  }

  /** 把事件规范化成「Ctrl+Shift+N」这种串。左右 Shift 之类不区分。 */
  function normKey(e) {
    var k = e.key;
    if (k === ' ') k = 'Space';
    else if (k === 'Esc') k = 'Escape';
    else if (k && k.length === 1) {
      // 带上 Shift 之后 e.key 会变成别的字符，折回「基键」
      var shifted = { '{': '[', '}': ']', ':': ';', '"': "'", '<': ',', '>': '.',
        '?': '/', '+': '=', '_': '-', '~': '`', '|': '\\', '!': '1', '@': '2',
        '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
      if (shifted[k]) k = shifted[k];
      if (/[a-z]/.test(k)) k = k.toUpperCase();
    } else if (k && k.length > 1 && k.indexOf('Arrow') === 0) {
      k = k;                                   // ArrowUp 之类保持原样
    }
    return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') +
      (e.shiftKey ? 'Shift+' : '') + k;
  }

  function eventKey(e) { return normKey(e); }

  /** 这个事件命中了哪个动作？（没命中返回 null） */
  function matchEvent(e) {
    var want = eventKey(e);
    for (var i = 0; i < actions.length; i++) {
      var k = keyOf(actions[i].id);
      if (k && k.toLowerCase() === want.toLowerCase()) return actions[i];
    }
    return null;
  }

  function findConflict(id, key) {
    if (!key) return null;
    for (var i = 0; i < actions.length; i++) {
      if (actions[i].id === id) continue;
      if (keyOf(actions[i].id).toLowerCase() === key.toLowerCase()) return actions[i];
    }
    return null;
  }

  function resetKeys() {
    overrides = {};
    try { localStorage.removeItem(LS_KEYS); } catch (e) { /* ignore */ }
  }

  /* ============================================================ 渲染 */

  function buildMenuBar() {
    var bar = document.getElementById('menuBar');
    if (!bar) return;
    bar.innerHTML = '';
    MENUS.forEach(function (m) {
      var wrap = document.createElement('div');
      wrap.className = 'menu-item';
      var btn = document.createElement('button');
      btn.className = 'menu-title';
      btn.textContent = m.name;
      btn.dataset.menu = m.id;
      var drop = document.createElement('div');
      drop.className = 'menu-drop hidden';
      m.items.forEach(function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'menu-sep'; drop.appendChild(s); return; }
        var b = document.createElement('button');
        b.className = 'menu-row';
        b.dataset.action = it.id;
        b.innerHTML = '<span class="mrow-label">' + it.label + '</span>' +
          '<span class="mrow-key">' + esc(keyOf(it.id)) + '</span>';
        b.onclick = function (ev) {
          ev.stopPropagation();
          closeAll();
          try { it.run(); } catch (err) { console.error(err); }
        };
        drop.appendChild(b);
      });
      btn.onclick = function (ev) {
        ev.stopPropagation();
        var open = !drop.classList.contains('hidden');
        closeAll();
        if (!open) { drop.classList.remove('hidden'); btn.classList.add('active'); }
      };
      wrap.appendChild(btn);
      wrap.appendChild(drop);
      bar.appendChild(wrap);
    });
    document.addEventListener('click', closeAll);
  }

  function closeAll() {
    var bar = document.getElementById('menuBar');
    if (!bar) return;
    bar.querySelectorAll('.menu-drop').forEach(function (d) { d.classList.add('hidden'); });
    bar.querySelectorAll('.menu-title').forEach(function (b) { b.classList.remove('active'); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ============================================================ 快捷键设置对话框 */

  function openKeyDialog() {
    var mask = document.getElementById('keyMask');
    if (!mask) return;
    renderKeyTable();
    mask.classList.remove('hidden');
  }

  function renderKeyTable() {
    var body = document.getElementById('keyBody');
    if (!body) return;
    body.innerHTML = '';
    MENUS.forEach(function (m) {
      var list = m.items.filter(function (it) { return !it.sep; });
      if (!list.length) return;
      var h = document.createElement('div');
      h.className = 'key-group';
      h.textContent = m.name;
      body.appendChild(h);
      list.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'key-row';
        var cur = keyOf(it.id);
        var changed = overrides[it.id] !== undefined;
        row.innerHTML =
          '<span class="kname">' + esc(it.label) + '</span>' +
          '<input class="kinput" data-id="' + it.id + '" readonly value="' + esc(cur || '（未设置）') + '" ' +
          'placeholder="点这里再按键">' +
          '<button class="mini kgap" data-id="' + it.id + '" title="清空这个快捷键">清空</button>' +
          (changed ? '<button class="mini kgap" data-id="' + it.id + '" data-reset="1" title="恢复默认">默认</button>' : '<span class="kgap"></span>');
        body.appendChild(row);
      });
    });
    body.querySelectorAll('.kinput').forEach(function (inp) {
      inp.onkeydown = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { inp.blur(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { inp.value = '（未设置）'; inp.dataset.pending = ''; return; }
        // 只按下修饰键不算
        if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(e.key) >= 0) return;
        var k = normKey(e);
        inp.value = k;
        inp.dataset.pending = k;
      };
      inp.onblur = function () { commitKeyInput(inp); };
      inp.onclick = function () { inp.value = ''; inp.placeholder = '按下想要的组合键…'; inp.dataset.pending = ''; inp.focus(); };
    });
    body.querySelectorAll('button[data-id]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.id;
        if (b.dataset.reset) delete overrides[id]; else overrides[id] = '';
        saveKeys();
        renderKeyTable();
        buildMenuBar();
      };
    });
  }

  function commitKeyInput(inp) {
    var id = inp.dataset.id;
    if (inp.dataset.pending === undefined) return;
    var k = inp.dataset.pending;
    var cur = keyOf(id);
    if (k === cur) { renderKeyTable(); return; }
    var clash = setKey(id, k);          // 冲突由 setKey 统一处理
    if (clash && global.ChaApp && global.ChaApp.toast) {
      global.ChaApp.toast('「' + k + '」原先属于「' + clash.label + '」，已把它清空', 'err', 4200);
    }
    renderKeyTable();
    buildMenuBar();
  }

  function showAbout() {
    var app = A();
    var v = (global.chahuDesktop && global.chahuDesktop.isDesktop) ? '桌面版' : '网页版';
    if (app.showInfo) {
      app.showInfo('茶绘 · 多人实时协作绘画板\n' + v + '\n服务器：' + ((app.net && app.net.url) || '—') +
        '\n\n本项目以 MIT 许可开源。');
    }
  }

  /* ============================================================ 对外 */

  global.ChaMenu = {
    MENUS: MENUS,
    actions: function () { return actions; },
    keyOf: keyOf,
    setKey: setKey,
    resetKeys: resetKeys,
    matchEvent: matchEvent,
    eventKey: eventKey,
    buildMenuBar: buildMenuBar,
    openKeyDialog: openKeyDialog,
    closeAll: closeAll,
    ESC: esc
  };
})(window);
