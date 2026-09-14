/**
 * 茶绘 · 菜单栏与快捷键
 *
 * 菜单结构**照着 SAI2 的真实菜单做**（文件/编辑/图像/图层/选择/尺子/滤镜/视图/窗口/其他），
 * 包括：
 *   · 每项带助记键，显示成「新建(N)」
 *   · ▸ 子菜单（导出 / 画布背景 / 显示操作面板 …）
 *   · ☑ / ☐ 勾选项
 *   · 茶绘还没有的功能**照样列出来但置灰**，而不是假装不存在 ——
 *     这样用户一眼能看出「哪些是我没找到、哪些是还没有」
 *
 * 设计要点：
 *   · 菜单是**数据驱动**的 —— MENUS 里写一条就是一个菜单项，
 *     渲染、快捷键、设置对话框全部读同一份数据，不会出现「菜单里有但快捷键表里没有」。
 *   · 快捷键可以改：覆盖值存 localStorage，改了立刻生效，键位冲突会当场提示。
 */
(function (global) {
  'use strict';

  var LS_KEYS = 'chahu.keys';
  var overrides = {};
  var actions = [];        // 只有「真能执行」的条目才进这里（设置对话框 / 快捷键表用它）
  var byId = {};

  function A() { return global.ChaApp || {}; }

  /**
   * 声明一个动作。
   * @param o { mnemonic, key, run, check, disabled, sub, sep }
   */
  function def(menu, id, label, o) {
    o = o || {};
    var a = {
      menu: menu, id: id, label: label,
      def: o.key || '',
      mnemonic: o.mnemonic || '',
      run: o.run || function () { },
      disabled: !!o.disabled,
      check: o.check || null,
      sub: o.sub || null
    };
    if (!a.disabled) { actions.push(a); byId[id] = a; }
    return a;
  }
  var SEP = { sep: true };

  /** 快捷方式：只写一条灰掉的项 */
  function off(menu, label, mnemonic, key) {
    return { menu: menu, id: '', label: label, mnemonic: mnemonic || '', def: key || '', disabled: true };
  }
  /** 子菜单项（同样可以是灰的） */
  function sub(menu, id, label, o) { return def(menu, id, label, o); }

  /* ============================================================ 菜单结构 */

  var MENUS = [
    {
      id: 'file', name: '文件', mnemonic: 'F', items: [
        def('file', 'file.new', '新建', { mnemonic: 'N', key: 'Ctrl+N', run: function () { A().openEntry(true); } }),
        def('file', 'file.open', '打开', { mnemonic: 'O', key: 'Ctrl+O', run: function () { A().openEntry(true); } }),
        off('file', '从剪贴板创建画布', 'B', 'Ctrl+B'),
        def('file', 'file.recent', '最近所用文件', {
          mnemonic: 'T', sub: [
            { label: '（暂无最近文件）', disabled: true }
          ]
        }),
        SEP,
        def('file', 'file.export', '保存', { mnemonic: 'S', key: 'Ctrl+S', run: function () { A().exportAs('png'); } }),
        def('file', 'file.saveAs', '另存为', { mnemonic: 'A', key: 'Ctrl+Shift+S', run: function () { A().openExportDialog(); } }),
        def('file', 'file.exportSub', '导出', {
          mnemonic: 'E', sub: [
            sub('file', 'file.export.png', 'PNG（.png，带透明）', { run: function () { A().exportAs('png'); } }),
            sub('file', 'file.export.jpg', 'JPEG（.jpg / .jpeg）', { run: function () { A().exportAs('jpeg'); } }),
            sub('file', 'file.export.webp', 'WebP（.webp）', { run: function () { A().exportAs('webp'); } }),
            sub('file', 'file.export.bmp', 'BMP（.bmp，24 位）', { run: function () { A().exportAs('bmp'); } }),
            sub('file', 'file.export.tga', 'TGA（.tga，32 位）', { run: function () { A().exportAs('tga'); } }),
            sub('file', 'file.export.more', '更多格式 / 画质…', { run: function () { A().openExportDialog(); } }),
            sub('file', 'file.export.webm', '导出录制视频（WebM）', { run: function () { A().toggleRecord(); } })
          ]
        }),
        SEP,
        def('file', 'file.viewerAlways', '总是使用文件查看器', {
          mnemonic: 'V', check: function () { return false; }, disabled: true
        }),
        off('file', '在文件查看器中打开', 'F'),
        off('file', '在文件查看器中保存', 'L'),
        SEP,
        off('file', '恢复文件', 'R'),
        SEP,
        def('file', 'file.leave', '关闭（离开房间）', { mnemonic: 'C', run: function () { A().leaveRoom(); } }),
        SEP,
        def('file', 'file.quit', '退出', { mnemonic: 'X', run: function () { A().quitApp(); } })
      ]
    },
    {
      id: 'edit', name: '编辑', mnemonic: 'E', items: [
        def('edit', 'edit.undo', '还原', { mnemonic: 'U', key: 'Ctrl+Z', run: function () { A().undo(); } }),
        def('edit', 'edit.redo', '重做', { mnemonic: 'R', key: 'Ctrl+Y', run: function () { A().redo(); } }),
        SEP,
        off('edit', '剪切', 'T', 'Ctrl+X'),
        def('edit', 'edit.copy', '拷贝', { mnemonic: 'C', key: 'Ctrl+C', run: function () { A().copySelection(); } }),
        off('edit', '粘贴', 'P', 'Ctrl+V'),
        SEP,
        def('edit', 'edit.copySel', '拷贝选区', { mnemonic: 'S', run: function () { A().copySelection(); } }),
        off('edit', '粘贴（不取消选区）', 'W'),
        SEP,
        def('edit', 'edit.selectAll', '全选', { mnemonic: 'A', key: 'Ctrl+A', run: function () { A().selectAll(); } }),
        SEP,
        def('edit', 'edit.keys', '快捷键设置', { mnemonic: 'K', run: function () { openKeyDialog(); } })
      ]
    },
    {
      id: 'image', name: '图像', mnemonic: 'C', items: [
        def('image', 'image.size', '图像大小', { mnemonic: 'R', run: function () { A().openCanvasDialog(); } }),
        def('image', 'image.canvasSize', '画布大小', { mnemonic: 'S', run: function () { A().openCanvasDialog(); } }),
        SEP,
        def('image', 'image.crop', '裁剪', { mnemonic: 'T', run: function () { A().cropToSelection(); } }),
        SEP,
        def('image', 'image.flipH', '水平翻转画布', { mnemonic: 'H', run: function () { A().flipImage('h'); } }),
        def('image', 'image.flipV', '垂直翻转画布', { mnemonic: 'V', run: function () { A().flipImage('v'); } }),
        def('image', 'image.rotCW', '逆时针旋转画布 90 度', { mnemonic: 'W', run: function () { A().rotateImage(-1); } }),
        def('image', 'image.rotCCW', '顺时针旋转画布 90 度', { mnemonic: 'G', run: function () { A().rotateImage(1); } }),
        SEP,
        def('image', 'image.bg', '画布背景', {
          mnemonic: 'B', sub: [
            sub('image', 'image.bg.white', '白色', { run: function () { A().setBackground('#ffffff'); } }),
            sub('image', 'image.bg.transparent', '透明', { run: function () { A().setBackground('transparent'); } }),
            sub('image', 'image.bg.paper', '纸色', { run: function () { A().setBackground('#fdfaf3'); } })
          ]
        }),
        def('image', 'image.fxcolor', '特殊效果的显色', {
          mnemonic: 'E', sub: [
            sub('image', 'image.fxcolor.water', '水滴', { run: function () { A().setFx('water'); } }),
            sub('image', 'image.fxcolor.noise', '噪点', { run: function () { A().setFx('noise'); } }),
            sub('image', 'image.fxcolor.none', '关闭', { run: function () { A().setFx('none'); } })
          ]
        })
      ]
    },
    {
      id: 'layer', name: '图层', mnemonic: 'L', items: [
        def('layer', 'layer.add', '新建图层', { mnemonic: 'N', key: 'Ctrl+Shift+N', run: function () { A().addLayer(); } }),
        def('layer', 'layer.dup', '复制图层', { mnemonic: 'D', run: function () { A().dupLayer(); } }),
        def('layer', 'layer.del', '删除图层', { mnemonic: 'E', run: function () { A().delLayer(); } }),
        SEP,
        def('layer', 'layer.up', '图层上移', { mnemonic: 'U', run: function () { A().moveLayer(1); } }),
        def('layer', 'layer.down', '图层下移', { mnemonic: 'O', run: function () { A().moveLayer(-1); } }),
        def('layer', 'layer.clear', '清空图层', { mnemonic: 'C', run: function () { A().clearLayer(); } }),
        SEP,
        def('layer', 'layer.mergeDown', '向下合并', { mnemonic: 'M', run: function () { A().mergeDown(); } }),
        def('layer', 'layer.mergeVisible', '合并可见图层', { mnemonic: 'V', run: function () { A().mergeVisible(); } }),
        def('layer', 'layer.bake', '固化当前图层', { mnemonic: 'F', run: function () { A().bake(); } }),
        SEP,
        off('layer', '图层属性', 'R')
      ]
    },
    {
      id: 'select', name: '选择', mnemonic: 'S', items: [
        def('select', 'select.none', '取消选择', { mnemonic: 'D', key: 'Ctrl+D', run: function () { A().selectNone(); } }),
        def('select', 'select.invert', '反选', { mnemonic: 'I', key: 'Ctrl+I', run: function () { A().selectInvert(); } }),
        SEP,
        def('select', 'select.marching', '显示选区边缘', {
          mnemonic: 'H', key: 'Ctrl+H',
          run: function () { A().toggleMarchingAnts(); },
          check: function () { var s = A().state; return !!(s && s.antsOn); }
        }),
        SEP,
        off('select', '扩展选区', 'L'),
        off('select', '收缩选区', 'O'),
        def('select', 'select.grow1', '扩展选区 1 像素', { mnemonic: 'A', run: function () { A().growSelection(1); } }),
        def('select', 'select.shrink1', '收缩选区 1 像素', { mnemonic: 'R', run: function () { A().shrinkSelection(1); } }),
        SEP,
        off('select', '选择选区内的锚点', 'P'),
        off('select', '选择与选区重叠的笔画', 'T'),
        SEP,
        off('select', '取消选择所有锚点', 'E'),
        SEP,
        def('select', 'select.all', '全选', { mnemonic: 'A', key: '', run: function () { A().selectAll(); } }),
        SEP,
        def('select', 'select.fromLayer', '按图层不透明区域建立选区', { mnemonic: 'F', run: function () { A().selectFromLayer(); } }),
        def('select', 'select.mesh', '网格变换', { mnemonic: 'M', run: function () { A().toggleMeshTransform(); } }),
        def('select', 'select.transform', '自由变换', { mnemonic: 'T', key: 'Ctrl+T', run: function () { A().toggleTransform(); } }),
        def('select', 'select.apply', '变换：确定', { key: 'Enter', run: function () { A().commitTransform(); } }),
        def('select', 'select.abort', '变换：中止', { key: 'Escape', run: function () { A().cancelTransform(); } })
      ]
    },
    {
      id: 'ruler', name: '尺子', mnemonic: 'R', items: [
        def('ruler', 'ruler.grid', '显示尺子（网格）', {
          mnemonic: 'H', key: 'Ctrl+R',
          run: function () { A().toggleGrid(); },
          check: function () { var s = A().state; return !!(s && s.gridOn); }
        }),
        SEP,
        def('ruler', 'ruler.line', '直线尺', { mnemonic: 'S', run: function () { A().armRuler('line'); } }),
        def('ruler', 'ruler.ellipse', '椭圆尺', { mnemonic: 'E', run: function () { A().armRuler('ellipse'); } }),
        def('ruler', 'ruler.parallel', '平行线尺', { mnemonic: 'P', run: function () { A().armRuler('parallel'); } }),
        def('ruler', 'ruler.circle', '同心圆尺', { mnemonic: 'C', run: function () { A().armRuler('circle'); } }),
        def('ruler', 'ruler.radial', '集中线尺', { mnemonic: 'V', run: function () { A().armRuler('radial'); } }),
        SEP,
        def('ruler', 'ruler.show', '显示尺子', {
          mnemonic: 'W',
          run: function () { A().toggleRulerVisible(); },
          check: function () { var s = A().state; return !!(s && s.rulerOn); }
        }),
        def('ruler', 'ruler.reset', '重置尺子', { mnemonic: 'R', run: function () { A().clearRuler(); } }),
        SEP,
        def('ruler', 'ruler.symmetry', '对称尺', {
          mnemonic: 'Y', sub: [
            sub('ruler', 'ruler.sym.none', '关闭', { run: function () { A().setSymmetry('none'); } }),
            sub('ruler', 'ruler.sym.v', '垂直镜像', { run: function () { A().setSymmetry('v'); } }),
            sub('ruler', 'ruler.sym.h', '水平镜像', { run: function () { A().setSymmetry('h'); } }),
            sub('ruler', 'ruler.sym.quad', '四向镜像', { run: function () { A().setSymmetry('quad'); } })
          ]
        }),
        SEP,
        def('ruler', 'ruler.steadierUp', '抖动修正 +', { run: function () { A().nudgeSteadier(1); } }),
        def('ruler', 'ruler.steadierDown', '抖动修正 −', { run: function () { A().nudgeSteadier(-1); } })
      ]
    },
    {
      id: 'filter', name: '滤镜', mnemonic: 'T', items: [
        def('filter', 'filter.tone', '色调调整', {
          mnemonic: 'A', sub: [
            sub('filter', 'filter.tone.hs', '色相 / 饱和度…', { run: function () { A().openToneDialog(); } }),
            sub('filter', 'filter.tone.bc', '亮度 / 对比度…', { run: function () { A().openToneDialog(); } }),
            { label: '色阶（暂未实现）', disabled: true }
          ]
        }),
        SEP,
        def('filter', 'filter.blurSub', '模糊', {
          mnemonic: 'B', sub: [
            sub('filter', 'filter.blurTool', '模糊工具', { key: 'U', run: function () { A().setTool('blur'); } }),
            sub('filter', 'filter.smudgeTool', '涂抹工具', { key: 'S', run: function () { A().setTool('smudge'); } }),
            { label: '高斯模糊（暂未实现）', disabled: true }
          ]
        }),
        SEP,
        def('filter', 'filter.paper', '纸张质感', {
          mnemonic: 'P', sub: [
            sub('filter', 'filter.paper.none', '无质感', { run: function () { A().setPaper('none'); } }),
            sub('filter', 'filter.paper.fine', '细纹', { run: function () { A().setPaper('fine'); } }),
            sub('filter', 'filter.paper.coarse', '粗纹', { run: function () { A().setPaper('coarse'); } }),
            sub('filter', 'filter.paper.canvas', '画布', { run: function () { A().setPaper('canvas'); } })
          ]
        })
      ]
    },
    {
      id: 'view', name: '视图', mnemonic: 'V', items: [
        def('view', 'view.newView', '新建视图', { mnemonic: 'N', disabled: true }),
        def('view', 'view.newFloat', '新建浮动视图', { mnemonic: 'L', disabled: true }),
        SEP,
        def('view', 'view.closeView', '关闭视图', { mnemonic: 'C', key: 'Ctrl+W', disabled: true }),
        def('view', 'view.closeAll', '关闭所有视图', { mnemonic: 'A', disabled: true }),
        SEP,
        def('view', 'view.zoomIn', '放大', { mnemonic: 'I', key: '=', run: function () { A().zoomBy(1.25); } }),
        def('view', 'view.zoomOut', '缩小', { mnemonic: 'O', key: '-', run: function () { A().zoomBy(1 / 1.25); } }),
        def('view', 'view.rotL', '逆时针旋转', { mnemonic: 'W', key: 'Shift+PageUp', run: function () { A().rotateView(-15); } }),
        def('view', 'view.rotR', '顺时针旋转', { mnemonic: 'R', key: 'Shift+PageDown', run: function () { A().rotateView(15); } }),
        def('view', 'view.flip', '水平翻转', {
          mnemonic: 'V', key: 'H',
          run: function () { A().flipView(); },
          check: function () { var e = A().engine; return !!(e && e.flipX); }
        }),
        SEP,
        def('view', 'view.zoom100', '100% 大小', { key: 'Ctrl+Alt+0', run: function () { A().zoom100(); } }),
        def('view', 'view.zoomFit', '按窗口大小缩放视图', { mnemonic: 'F', key: '0', run: function () { A().zoomFit(); } }),
        def('view', 'view.resetPos', '重置视图的显示位置', { mnemonic: 'H', key: 'Home', run: function () { A().zoomFit(); } }),
        def('view', 'view.resetAngle', '重置视图的显示角度', { mnemonic: 'G', key: 'Shift+Home', run: function () { A().rotateView(0, true); } }),
        SEP,
        def('view', 'view.nav', '导航器', {
          mnemonic: 'N', key: '',
          run: function () { A().toggleNav(); },
          check: function () { var s = A().state; return !!(s && s.navOpen); }
        })
      ]
    },
    {
      id: 'window', name: '窗口', mnemonic: 'W', items: [
        def('window', 'window.panels', '显示操作面板', {
          mnemonic: 'S', sub: [
            sub('window', 'window.secNav', '导航器', { run: function () { A().toggleSection('nav'); } }),
            sub('window', 'window.secTools', '工具栏', { run: function () { A().toggleSection('tools'); } }),
            sub('window', 'window.secBrushes', '笔刷栏', { run: function () { A().toggleSection('brushes'); } }),
            sub('window', 'window.secBrush', '画笔参数', { run: function () { A().toggleSection('brush'); } }),
            sub('window', 'window.secFx', '效果', { run: function () { A().toggleSection('fx'); } }),
            sub('window', 'window.secColor', '颜色', { run: function () { A().toggleSection('color'); } }),
            sub('window', 'window.secLayers', '图层', { run: function () { A().toggleSection('layers'); } })
          ]
        }),
        def('window', 'window.detach', '分离操作面板', {
          mnemonic: 'P', sub: [{ label: '（网页版不支持分离窗口）', disabled: true }]
        }),
        def('window', 'window.uiscale', '用户界面缩放', {
          mnemonic: 'A', sub: [
            sub('window', 'window.ui.reset', '恢复默认（100%）', { run: function () { A().setUiScale(1); } }),
            sub('window', 'window.ui.125', '放大到 125%', { run: function () { A().setUiScale(1.25); } }),
            sub('window', 'window.ui.150', '放大到 150%', { run: function () { A().setUiScale(1.5); } })
          ]
        }),
        SEP,
        def('window', 'window.cursorRing', '画笔工具显示画笔大小圆形', {
          mnemonic: 'Z',
          run: function () { A().setCursorMode('ring'); },
          check: function () { var s = A().state; return !!(s && s.cursorStyle === 'ring'); }
        }),
        def('window', 'window.cursorDot', '画笔工具使用圆点光标', {
          mnemonic: 'D',
          run: function () { A().setCursorMode('dot'); },
          check: function () { var s = A().state; return !!(s && s.cursorStyle === 'dot'); }
        }),
        off('window', '只用数值显示画笔大小列表的项目', 'N'),
        off('window', '在上面显示画笔大小列表', 'U'),
        SEP,
        def('window', 'window.allPanels', '显示所有的操作面板', {
          mnemonic: 'E', key: 'Tab',
          run: function () { A().toggleLeftPanel(); },
          check: function () { var s = A().state; return !!(s && s.leftPanelOpen); }
        }),
        def('window', 'window.fullscreen', '全屏模式', {
          mnemonic: 'F', key: 'F11',
          run: function () { A().toggleFullscreen(); },
          check: function () { return !!document.fullscreenElement; }
        }),
        SEP,
        off('window', '靠右显示导航器和图层的操作面板', 'L'),
        off('window', '靠右显示颜色和工具的面板', 'T'),
        SEP,
        off('window', 'HSV/HSL 模式', 'M'),
        off('window', '色板项目大小', 'W')
      ]
    },
    {
      id: 'other', name: '其他', mnemonic: 'O', items: [
        def('other', 'other.manager', '素材 / 工具管理器', { mnemonic: 'A', run: function () { A().openBrushImport(); } }),
        SEP,
        def('other', 'other.keys', '快捷键设置', { mnemonic: 'K', run: function () { openKeyDialog(); } }),
        def('other', 'other.settings', '设置', { mnemonic: 'O', run: function () { A().openSettings(); } }),
        SEP,
        def('other', 'other.info', '房间信息', { mnemonic: 'I', run: function () { A().showRoomInfo(); } }),
        def('other', 'other.share', '复制分享链接', { mnemonic: 'C', run: function () { A().doShare(); } }),
        SEP,
        def('other', 'other.about', '关于茶绘 / 用户准则 / 风险须知', { mnemonic: 'B', run: function () { A().openAbout(); } }),
        def('other', 'other.update', '检查更新', { mnemonic: 'U', run: function () { A().openAbout(); A().checkUpdate(); } }),
        def('other', 'other.sysid', '系统 ID', { mnemonic: 'S', disabled: true })
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

  /** 把事件规范化成「Ctrl+Shift+N」这种串。左右修饰键不区分。 */
  function normKey(e) {
    var k = e.key;
    if (k === ' ') k = 'Space';
    else if (k === 'Esc') k = 'Escape';
    else if (k === 'PageUp') k = 'PageUp';
    else if (k && k.length === 1) {
      var shifted = { '{': '[', '}': ']', ':': ';', '"': "'", '<': ',', '>': '.',
        '?': '/', '+': '=', '_': '-', '~': '`', '|': '\\', '!': '1', '@': '2',
        '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
      if (shifted[k]) k = shifted[k];
      if (/[a-z]/.test(k)) k = k.toUpperCase();
    }
    return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') +
      (e.shiftKey ? 'Shift+' : '') + k;
  }
  function eventKey(e) { return normKey(e); }

  /** 这个事件命中了哪个动作？（没命中返回 null）。子菜单里的动作也能命中。 */
  function matchEvent(e) {
    var want = eventKey(e).toLowerCase();
    for (var i = 0; i < actions.length; i++) {
      var k = keyOf(actions[i].id);
      if (k && k.toLowerCase() === want) return actions[i];
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

  /**
   * 设置快捷键。**冲突解决放在这里**，不放在对话框里 ——
   * 这样不管从哪条路径改键都不会留下两个动作抢同一个键。
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

  function resetKeys() {
    overrides = {};
    try { localStorage.removeItem(LS_KEYS); } catch (e) { /* ignore */ }
  }

  /* ============================================================ 渲染 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function labelHTML(it) {
    return esc(it.label) + (it.mnemonic ? '<span class="mrow-mn">(' + esc(it.mnemonic) + ')</span>' : '');
  }

  /** 画一项（可能是子菜单的父项） */
  function renderRow(it, inSub) {
    var b = document.createElement('button');
    var isSubParent = !!(it.sub && it.sub.length);
    b.className = 'menu-row' + (it.disabled ? ' disabled' : '') + (isSubParent ? ' has-sub' : '');
    if (it.id) b.dataset.action = it.id;
    var mark = '';
    if (it.check) mark = it.check() ? '✓' : '';
    b.innerHTML = '<span class="mrow-mark">' + mark + '</span>' +
      '<span class="mrow-label">' + labelHTML(it) + '</span>' +
      '<span class="mrow-key">' + esc(it.id && !it.disabled ? keyOf(it.id) : (it.def || '')) + '</span>' +
      (isSubParent ? '<span class="mrow-arrow">▸</span>' : '');
    if (isSubParent) {
      var subBox = document.createElement('div');
      subBox.className = 'menu-drop menu-sub hidden';
      it.sub.forEach(function (s) {
        if (s.sep) { var sp = document.createElement('div'); sp.className = 'menu-sep'; subBox.appendChild(sp); return; }
        subBox.appendChild(renderRow(s, true));
      });
      var wrap = document.createElement('div');
      wrap.className = 'menu-subwrap';
      wrap.appendChild(b);
      wrap.appendChild(subBox);
      b.onmouseenter = function () {
        subBox.classList.remove('hidden');
        b.classList.add('active');
      };
      wrap.onmouseleave = function () {
        subBox.classList.add('hidden');
        b.classList.remove('active');
      };
      return wrap;
    }
    if (!it.disabled) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        closeAll();
        try { it.run(); } catch (err) { console.error(err); }
      };
    }
    void inSub;
    return b;
  }

  function buildMenuBar() {
    var bar = document.getElementById('menuBar');
    if (!bar) return;
    bar.innerHTML = '';
    MENUS.forEach(function (m) {
      var wrap = document.createElement('div');
      wrap.className = 'menu-item';
      var btn = document.createElement('button');
      btn.className = 'menu-title';
      btn.dataset.menu = m.id;
      btn.innerHTML = esc(m.name) + (m.mnemonic ? '<span class="mrow-mn">(' + esc(m.mnemonic) + ')</span>' : '');
      var drop = document.createElement('div');
      drop.className = 'menu-drop hidden';
      m.items.forEach(function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'menu-sep'; drop.appendChild(s); return; }
        drop.appendChild(renderRow(it, false));
      });
      btn.onclick = function (ev) {
        ev.stopPropagation();
        var open = !drop.classList.contains('hidden');
        closeAll();
        if (!open) { drop.classList.remove('hidden'); btn.classList.add('active'); }
      };
      btn.onmouseenter = function () {
        // SAI2 那样：已经打开一个菜单时，滑过别的标题直接切换
        var anyOpen = bar.querySelector('.menu-drop:not(.hidden)');
        if (anyOpen && anyOpen !== drop) { closeAll(); drop.classList.remove('hidden'); btn.classList.add('active'); }
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
    bar.querySelectorAll('.menu-row').forEach(function (b) { b.classList.remove('active'); });
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
      var list = actions.filter(function (a) { return a.menu === m.id; });
      if (!list.length) return;
      var h = document.createElement('div');
      h.className = 'key-group';
      h.textContent = m.name;
      body.appendChild(h);
      list.forEach(function (a) {
        var row = document.createElement('div');
        row.className = 'key-row';
        var cur = keyOf(a.id);
        var changed = overrides[a.id] !== undefined;
        row.innerHTML =
          '<span class="kname">' + esc(a.label) + '</span>' +
          '<input class="kinput" data-id="' + a.id + '" readonly value="' + esc(cur || '（未设置）') + '">' +
          '<button class="mini kgap" data-id="' + a.id + '" title="清空这个快捷键">清空</button>' +
          (changed ? '<button class="mini kgap" data-id="' + a.id + '" data-reset="1" title="恢复默认">默认</button>'
            : '<span class="kgap"></span>');
        body.appendChild(row);
      });
    });
    body.querySelectorAll('.kinput').forEach(function (inp) {
      inp.onkeydown = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { inp.blur(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { inp.value = '（未设置）'; inp.dataset.pending = ''; return; }
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
    if (k === keyOf(id)) { renderKeyTable(); return; }
    var clash = setKey(id, k);
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
      app.showInfo('茶绘 · 多人实时协作绘画板\n' + v + '（菜单结构与 PaintTool SAI Ver.2 对齐）' +
        '\n服务器：' + ((app.net && app.net.url) || '—') + '\n\n本项目以 MIT 许可开源。');
    }
  }

  /* ============================================================ 对外 */

  loadKeys();

  global.ChaMenu = {
    MENUS: MENUS,
    actions: function () { return actions; },
    keyOf: keyOf,
    setKey: setKey,
    resetKeys: resetKeys,
    matchEvent: matchEvent,
    eventKey: eventKey,
    normKey: normKey,
    buildMenuBar: buildMenuBar,
    openKeyDialog: openKeyDialog,
    closeAll: closeAll,
    esc: esc
  };
})(window);
