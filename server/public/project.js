/**
 * 茶绘 · 工程文件（`.chahu`）
 *
 * 一个自包含的 JSON：画布尺寸 / 背景 / 每层的元数据与**像素**。
 * 它对应的是「这份画现在的样子」，不是「这份画是怎么画出来的」——
 * 笔迹历史不进工程文件。三个理由：
 *
 *   1. 跨房间搬几千条笔迹要多传一个数量级的数据，搬 N 张 PNG 就够了；
 *   2. 撤销栈本来就不跨会话，恢复了也不能接着撤销；
 *   3. 茶绘的服务端是权威，工程文件只是**一份可带走的快照**。
 *
 * 代价是装载完的房间里 `history` 是空的（回放列表看不到这份内容）——
 * 这是设计取舍，不是 bug，README「工程文件」一节里写明了。
 *
 * 文件结构：
 *   {
 *     format: 'chahui-project', version: 1, app: '1.8.5', savedAt: 1758...,
 *     doc: {
 *       width, height, background,
 *       groups: [{ id, name, visible, opacity, blend, collapsed }],
 *       layers: [{ name, visible, opacity, locked, alphaLock, blend, groupId,
 *                  clip, maskEnabled, maskPng, png }]
 *     }
 *   }
 *
 * `png` 是 `data:image/png;base64,...`；**空图层存 null**（不是一张透明 PNG）——
 * 空白页叠 8 个空图层的话，8 张 PNG 白占几十 KB。判空靠比较「同尺寸空白画布的
 * toDataURL」，O(1) 且不依赖逐像素扫描。
 *
 * 图层组（`groupId` 指向 `groups` 里的某一条）是 1.9 才有的字段，**没有升 version**：
 * 老版本的茶绘打开新文件时读不懂 groups、会把它们当没分组 —— 画面照样对（组只是
 * 「子图层怎么合到一起」的规则），比直接拒收整份工程友好得多。
 *
 * `maskPng` / `maskEnabled` / `clip` 是 2.0.1 才加的，同样**没有升 version**：
 * 蒙版也是一层像素，不进工程文件就会「存一遍再打开，蒙版整张没了」。
 * `maskPng` 是一张同尺寸 PNG，**用 alpha 表示该处显示多少**（不透明 = 全显示），
 * 和 PSD 的蒙版语义是同一件事的两种写法；`maskEnabled` 为 false 表示蒙版被临时关掉
 * （蒙版留着，只是不参与合成）；`clip` = 剪贴蒙版（只显示在紧邻它下面那一层的不透明区域里）。
 *
 * IndexedDB 里的自动保存草稿用的是**同一个结构**，见文件末尾的 `draft`。
 */
(function (global) {
  'use strict';

  var FORMAT = 'chahui-project';
  var VERSION = 1;

  /* 和服务端保持一致：房间画布被 clamp 到 320~4096，图层上限 MAX_LAYERS=16。
     超出范围的工程宁可明确拒绝，也不要装载完发现被裁了一圈。 */
  var MIN_SIDE = 320, MAX_SIDE = 4096, MAX_LAYERS = 16;

  var PNG_PREFIX = 'data:image/png;base64,';

  function isStr(v) { return typeof v === 'string'; }
  /* 和服务端 index.js 里校验组 id 的那条正则**必须一致** ——
     两边不一致的话，parse 放过去的组会被服务端丢掉，
     图层就变成「落单」的，看着像组莫名其妙没了。 */
  function isGroupId(v) { return isStr(v) && /^[A-Za-z0-9_-]{4,32}$/.test(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function byteLength(s) {
    if (global.TextEncoder) return new global.TextEncoder().encode(s).length;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* ---------------------------------------------------------- 抓取 / 序列化 */

  /** 同尺寸空白图层的 dataURL，用来把「空图层」判成 null（缓存一份就够） */
  var blankCache = null, blankKey = '';
  function blankPng(w, h) {
    var key = w + 'x' + h;
    if (blankKey === key) return blankCache;
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      blankCache = c.toDataURL('image/png');
      blankKey = key;
    } catch (e) { blankCache = null; blankKey = ''; }
    return blankCache;
  }

  /**
   * 把当前文档抓成一份工程。
   * @param {CanvasEngine} engine
   * @param {{app?:string, name?:string}} meta
   */
  function capture(engine, meta) {
    meta = meta || {};
    if (!engine) throw new Error('没有可以保存的画布');
    var list = engine.layerList();
    if (!list.length) throw new Error('画布上没有任何图层');

    var blank = blankPng(engine.width, engine.height);
    var layers = [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i].id;
      var png = null;
      try {
        // rawLayer：只要图层自身的像素，不套图层浓度与混合模式
        // （那两样是元数据，跟着 name/opacity/blend 一起存）
        var out = engine.renderDocument({
          onlyLayer: id, transparentBackground: true, rawLayer: true
        });
        png = out.canvas.toDataURL('image/png');
      } catch (e) {
        throw new Error('导出「' + list[i].name + '」这一层时失败：' + e.message);
      }
      if (blank && png === blank) png = null;
      // 蒙版也要存 —— 蒙版是一层像素，不在工程文件里带上，
      // 「存一遍再打开，蒙版整张没了」就是必然的。它是张灰度 PNG，
      // 尺寸和图层一样，但没有 alpha 之外的通道，压完很小。
      var maskPng = null;
      if (list[i].hasMask && engine.renderMaskPNG) {
        try { maskPng = engine.renderMaskPNG(id); } catch (e) { maskPng = null; }
      }
      layers.push({
        name: list[i].name,
        visible: list[i].visible !== false,
        opacity: isNum(list[i].opacity) ? list[i].opacity : 1,
        locked: !!list[i].locked,
        alphaLock: !!list[i].alphaLock,
        blend: list[i].blend || 'normal',
        groupId: isGroupId(list[i].groupId) ? list[i].groupId : null,
        clip: !!list[i].clip,
        maskEnabled: list[i].maskEnabled !== false,
        maskPng: maskPng,
        png: png
      });
    }

    return {
      format: FORMAT,
      version: VERSION,
      app: meta.app || '',
      name: meta.name || '',
      savedAt: Date.now(),
      doc: {
        width: engine.width,
        height: engine.height,
        background: engine.background || '#ffffff',
        // 组表照抄引擎里的；组本身没有像素，所以这里没有开销
        groups: (engine.groupList ? engine.groupList() : []).map(function (g) {
          return {
            id: g.id, name: g.name, visible: g.visible !== false,
            opacity: isNum(g.opacity) ? g.opacity : 1,
            blend: g.blend || 'normal', collapsed: !!g.collapsed
          };
        }),
        layers: layers
      }
    };
  }

  function stringify(project) {
    return JSON.stringify(project);
  }

  /* ---------------------------------------------------------------- 校验 */

  function bad(why) { throw new Error(why); }

  /**
   * 解析并校验一份工程文件。
   * 读不懂就明确报错 —— 和笔刷导入一个脾气，不静默给出一份错的画。
   */
  function parse(text) {
    if (!isStr(text)) bad('工程文件读出来不是文本');
    var o;
    try {
      o = JSON.parse(text);
    } catch (e) {
      bad('这不是有效的工程文件（不是 JSON）');
    }
    if (!o || typeof o !== 'object') bad('工程文件是空的');
    if (o.format !== FORMAT) {
      bad('这不是茶绘的工程文件（缺少 ' + FORMAT + ' 标记）');
    }
    var v = Math.round(Number(o.version) || 0);
    if (v < 1) bad('工程文件没有版本号');
    if (v > VERSION) {
      bad('这份工程来自更新的茶绘（文件版本 ' + v + '，本机只认到 ' + VERSION + '），请升级后再打开');
    }
    var doc = o.doc;
    if (!doc || typeof doc !== 'object') bad('工程文件里没有画布内容');

    var w = Math.round(Number(doc.width) || 0);
    var h = Math.round(Number(doc.height) || 0);
    if (!(w >= MIN_SIDE && w <= MAX_SIDE) || !(h >= MIN_SIDE && h <= MAX_SIDE)) {
      bad('画布尺寸 ' + w + '×' + h + ' 超出茶绘的范围（' + MIN_SIDE + '~' + MAX_SIDE + '）');
    }
    if (!Array.isArray(doc.layers) || !doc.layers.length) bad('工程里一个图层都没有');
    if (doc.layers.length > MAX_LAYERS) {
      bad('这份工程有 ' + doc.layers.length + ' 个图层，超过上限 ' + MAX_LAYERS + ' 层');
    }

    // 组要先于图层读出来：图层的 groupId 得拿它来验，指向不存在的组一律清成 null
    var groups = [];
    if (Array.isArray(doc.groups)) {
      doc.groups.slice(0, MAX_LAYERS).forEach(function (g, i) {
        if (!g || typeof g !== 'object') return;
        if (!isGroupId(g.id)) return;
        if (groups.some(function (x) { return x.id === g.id; })) return;
        groups.push({
          id: g.id,
          name: (isStr(g.name) && g.name.trim()) ? g.name.trim() : ('组 ' + (i + 1)),
          visible: g.visible !== false,
          opacity: isNum(g.opacity) ? Math.max(0, Math.min(1, g.opacity)) : 1,
          blend: isStr(g.blend) ? g.blend : 'normal',
          collapsed: !!g.collapsed
        });
      });
    }

    var layers = doc.layers.map(function (l, i) {
      if (!l || typeof l !== 'object') bad('第 ' + (i + 1) + ' 层读不出来');
      var png = null;
      if (isStr(l.png) && l.png.indexOf(PNG_PREFIX) === 0 && l.png.length > PNG_PREFIX.length) {
        png = l.png;
      }
      var maskPng = null;
      if (isStr(l.maskPng) && l.maskPng.indexOf(PNG_PREFIX) === 0 && l.maskPng.length > PNG_PREFIX.length) {
        maskPng = l.maskPng;
      }
      return {
        name: (isStr(l.name) && l.name.trim()) ? l.name.trim() : ('图层 ' + (i + 1)),
        visible: l.visible !== false,
        opacity: isNum(l.opacity) ? Math.max(0, Math.min(1, l.opacity)) : 1,
        locked: !!l.locked,
        alphaLock: !!l.alphaLock,
        blend: isStr(l.blend) ? l.blend : 'normal',
        groupId: groups.some(function (g) { return g.id === l.groupId; }) ? l.groupId : null,
        clip: !!l.clip,
        maskEnabled: l.maskEnabled !== false,
        maskPng: maskPng,
        png: png
      };
    });

    return {
      format: FORMAT,
      version: v,
      app: isStr(o.app) ? o.app : '',
      name: isStr(o.name) ? o.name : '',
      savedAt: Math.round(Number(o.savedAt) || 0),
      doc: {
        width: w,
        height: h,
        background: isStr(doc.background) ? doc.background : '#ffffff',
        groups: groups,
        layers: layers
      }
    };
  }

  /** 一句话描述一份工程，给弹窗 / 提示用 */
  function describe(project) {
    var doc = project.doc;
    var painted = doc.layers.filter(function (l) { return !!l.png; }).length;
    var masked = doc.layers.filter(function (l) { return !!l.maskPng; }).length;
    var gn = (doc.groups || []).length;
    return doc.width + '×' + doc.height + ' · ' + doc.layers.length + ' 层（' +
      painted + ' 层有内容）' + (gn ? ' · ' + gn + ' 个图层组' : '') +
      (masked ? ' · ' + masked + ' 张蒙版' : '');
  }

  function toBlob(project) {
    return new global.Blob([stringify(project)], { type: 'application/json' });
  }

  /**
   * JSON 文本 → data URL。
   * 桌面端主进程是按 base64 落盘的（见 client/main.js 的 chahu:save），
   * 网页版则直接把这个 data URL 当下载链接用 —— 一条路同时满足两边。
   */
  function textToDataUrl(text) {
    var bytes;
    if (global.TextEncoder) {
      bytes = new global.TextEncoder().encode(text);
    } else {
      var arr = [];
      for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if (c < 0x80) arr.push(c);
        else if (c < 0x800) arr.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else arr.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      bytes = new Uint8Array(arr);
    }
    // 分块转二进制字符串：一份工程动辄上百万字节，
    // String.fromCharCode.apply 一把梭会把调用栈撑爆。
    var CH = 0x8000, s = '';
    for (var off = 0; off < bytes.length; off += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(off, off + CH));
    }
    return 'data:application/json;base64,' + global.btoa(s);
  }

  /** 文件名：茶绘-<房间名/工程名>-<YYYYMMDD-HHMM>.chahu */
  function fileName(project, fallback) {
    var base = (project && project.name) || fallback || '未命名';
    base = String(base).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 40) || '未命名';
    var d = new Date(project && project.savedAt ? project.savedAt : Date.now());
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return '茶绘-' + base + '-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.chahu';
  }

  /* ------------------------------------------------- 自动保存草稿（IndexedDB） */

  /* localStorage 放不下：一份工程的几层 PNG 很容易过 5MB，而 localStorage 超限是
     **同步抛异常**、不是慢慢变慢。IndexedDB 没这个问题，也没有实际的容量上限。 */

  var DB_NAME = 'chahui';
  var DB_STORE = 'drafts';
  var DRAFT_ID = 'latest';

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('这个环境没有 IndexedDB'));
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开本地草稿库')); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(DB_STORE, mode);
        var req = fn(t.objectStore(DB_STORE));
        t.oncomplete = function () { resolve(req && req.result); };
        t.onabort = t.onerror = function () {
          reject(t.error || new Error('本地草稿库读写失败'));
        };
      }).then(function (r) { db.close(); return r; });
    });
  }

  var draft = {
    ID: DRAFT_ID,

    /** 存一份草稿。结构里多一个 roomId / roomName，恢复时好告诉用户这是哪儿的画 */
    save: function (project, extra) {
      var rec = {
        project: project,
        roomId: (extra && extra.roomId) || '',
        roomName: (extra && extra.roomName) || '',
        strokeCount: (extra && extra.strokeCount) || 0,
        savedAt: Date.now()
      };
      return tx('readwrite', function (s) { return s.put(rec, DRAFT_ID); });
    },

    load: function () {
      return tx('readonly', function (s) { return s.get(DRAFT_ID); }).then(function (rec) {
        return rec || null;
      });
    },

    clear: function () {
      return tx('readwrite', function (s) { return s.delete(DRAFT_ID); });
    }
  };

  /* index.html 是普通 <script> 加载，没有模块系统 —— 挂到 window 上。 */
  global.ChahuProject = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MAX_LAYERS: MAX_LAYERS,
    MIN_SIDE: MIN_SIDE,
    MAX_SIDE: MAX_SIDE,
    capture: capture,
    stringify: stringify,
    parse: parse,
    describe: describe,
    toBlob: toBlob,
    textToDataUrl: textToDataUrl,
    fileName: fileName,
    byteLength: byteLength,
    draft: draft
  };
})(window);
