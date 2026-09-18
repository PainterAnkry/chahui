/**
 * 茶绘 · PSD（Photoshop 8BPS）导入
 *
 * 把一份 .psd 读成**和 project.js 的 doc 同形**的结构，然后交给 openProjectDoc
 * 走「新建房间 + 装载工程」那条现成的路 —— 导入不需要另造一套装载机制。
 *
 * 能读回来的东西（和导出器恰好是一对）：
 *   画布尺寸 / 图层像素 / 图层名 / 不透明度 / 混合模式 / 可见性 / 锁定透明像素 /
 *   图层组（含组名、组的浓度与混合模式、收起状态）/ 图层蒙版 / 剪贴蒙版
 *
 * 读不回来的（明确跳过，并给用户一句话说明，绝不装作读到了）：
 *   矢量蒙版、图层样式、调整层与文字层的「可再编辑性」（会当普通像素层进来）、
 *   智能对象、16 位以上的动态范围、ZIP 压缩、CMYK / Lab / 索引色。
 *
 * 三条极容易写错的格式事实（都查过参照实现，别凭记忆改）：
 *
 *   1. **层记录在文件里是自下而上排的**（第 0 条 = 最底下的层），
 *      和茶绘 engine.layers 的顺序**天然一致**，不需要反转。
 *   2. 一个组由两条分隔记录夹住：
 *         [ lsct=3  边界分隔符 ]  ← 组的**开始**
 *         [ 组内各层，自下而上 ]
 *         [ lsct=1/2 张开/收起 ]  ← 组的**结束**，组的名字和浓度挂在这条上
 *      所以「先见 3 → 开组」「再见 1/2 → 闭组并取名字」。
 *   3. 每个通道的数据长度按**该层的矩形**算（通道自己没有矩形）——
 *      组的分隔符矩形是 0×0，要是拿画布尺寸去读它，会去找一整幅图的字节，
 *      而那里一个字节都没有，整份文件当场读崩。
 *
 * 蒙版语义：PSD 的蒙版通道是 8 位灰度，0 = 全遮、255 = 全露；
 * 茶绘的蒙版画布用 alpha 表示同一件事（不透明 = 全露）。
 * 于是「灰度 → alpha」是同一件事的两种写法，转过去就行，不用取反。
 */
(function (global) {
  'use strict';

  var MAX_LAYERS = 16;          // 和服务端保持一致（超了要明确告诉用户，不能默默丢）
  var MAX_SIDE = 4096;          // 同上
  var COLOR_MODE = { 0: '位图', 2: '索引色', 4: 'CMYK', 7: '多通道', 8: '双色调', 9: 'Lab' };
  /** 段长度越界 = 文件被截断。给用户看到的必须是这句话，不是一句 JS 原生报错 */
  var SHORT = '这份 PSD 的段长度对不上，文件像是被截断了（是不是没下完？）';

  /* 四字符混合模式代码 → 茶绘的混合模式名。
     必须和 psd.js 的 BLEND_KEY 互为逆映射：导出认得出、导入认不回，
     就会出现「存一遍再打开，模式偷偷变回正常」这种没人报得出的毛病。 */
  var BLEND_BY_KEY = {
    'norm': 'normal', 'mul ': 'multiply', 'scrn': 'screen', 'over': 'overlay',
    'dark': 'darken', 'lite': 'lighten', 'lddg': 'add', 'diff': 'difference',
    'smud': 'exclusion', 'hLit': 'hard-light', 'sLit': 'soft-light',
    'div ': 'color-dodge', 'idiv': 'color-burn',
    'hue ': 'hue', 'sat ': 'saturation', 'colr': 'color', 'lum ': 'luminosity'
  };

  function fail(msg) { throw new Error(msg); }

  /* ------------------------------------------------------------ 只读字节视图 */

  function Bytes(u8) { this.u = u8; }
  Bytes.prototype.u8 = function (o) { return this.u[o]; };
  Bytes.prototype.u16 = function (o) { return (this.u[o] << 8) | this.u[o + 1]; };
  Bytes.prototype.i16 = function (o) {
    var v = (this.u[o] << 8) | this.u[o + 1];
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  Bytes.prototype.u32 = function (o) {
    return ((this.u[o] << 24) | (this.u[o + 1] << 16) | (this.u[o + 2] << 8) | this.u[o + 3]) >>> 0;
  };
  Bytes.prototype.i32 = function (o) { return this.u32(o) | 0; };
  Bytes.prototype.str = function (o, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.u[o + i]);
    return s;
  };

  /** PackBits 解压。解出来必须正好填满 expect 字节 —— 短了长了都说明读错位了 */
  function unpackbits(b, off, len, expect) {
    var out = new Uint8Array(expect);
    var w = 0, i = 0;
    while (i < len) {
      var n = b.u8(off + i); i++;
      if (n < 128) {                                   // 字面段：n+1 个字节
        var cnt = n + 1;
        if (w + cnt > expect || i + cnt > len) fail('RLE 数据比预期长（文件坏了，或者我读错位了）');
        for (var k = 0; k < cnt; k++) out[w++] = b.u8(off + i + k);
        i += cnt;
      } else if (n !== 128) {                          // 128（= -128 的有符号）按规范是空操作
        var rep = 257 - n;
        if (w + rep > expect) fail('RLE 数据比预期长（文件坏了，或者我读错位了）');
        var v = b.u8(off + i); i++;
        for (var r = 0; r < rep; r++) out[w++] = v;
      }
    }
    if (w !== expect) fail('RLE 解出来 ' + w + ' 字节，应为 ' + expect);
    return out;
  }

  /* --------------------------------------------------------------- 画布辅助 */

  function mkCanvas(w, h) {
    var c = global.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * 一层像素（planar 各通道）→ 整幅画布的 ImageData。
   *
   * 层的矩形可能只盖住画布一角（PSD 里很常见：一层只有一小块内容），
   * 层矩形之外必须是**全透明**，不能是黑色 —— 否则整份画会被糊上一层黑。
   *
   * 注意 rows 里的每一行在 readChannels 里已经压成「一像素一字节」了，
   * 所以这里按 x 直接取，不用再乘采样位数。
   */
  function planesToImageData(L, gray, cw, ch) {
    var img = new ImageData(cw, ch);
    var d = img.data;
    var chans = L.planes;
    var grayRows = chans[0], alphaRows = chans[-1], rRows = chans[0], gRows = chans[1], bRows = chans[2];

    var y0 = Math.max(0, L.top), y1 = Math.min(ch, L.bottom);
    var x0 = Math.max(0, L.left), x1 = Math.min(cw, L.right);
    for (var y = y0; y < y1; y++) {
      var sy = y - L.top;
      var base = y * cw * 4;
      var gRow = grayRows && grayRows[sy];
      var grRow = rRows && rRows[sy], ggRow = gRows && gRows[sy], gbRow = bRows && bRows[sy];
      var aRow = alphaRows && alphaRows[sy];
      for (var x = x0; x < x1; x++) {
        var sx = x - L.left;
        var i = base + x * 4;
        if (gray) {
          var gv = gRow ? gRow[sx] : 0;
          d[i] = d[i + 1] = d[i + 2] = gv;
        } else {
          d[i] = grRow ? grRow[sx] : 0;
          d[i + 1] = ggRow ? ggRow[sx] : 0;
          d[i + 2] = gbRow ? gbRow[sx] : 0;
        }
        d[i + 3] = aRow ? aRow[sx] : 255;
      }
    }
    return img;
  }

  /** 一行原始字节 → 每像素取最高字节（16 位就取高 8 位：够用，且省一半时间） */
  function takeBytes(row, w, px) {
    if (px === 1) return row;
    var out = new Uint8Array(w);
    for (var i = 0; i < w; i++) out[i] = row[i * px];
    return out;
  }

  /* -------------------------------------------------------- 读一段通道数据 */

  /** 读完所有层的通道数据，写回 `L.planes[通道号] = 行数组`；返回读完后的位置 */
  function readChannels(b, layers, q, bytesPerSample, layerOffset) {
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var lw = L.right - L.left, lh = L.bottom - L.top;
      if (lw < 0) lw = 0;
      if (lh < 0) lh = 0;
      L.planes = {};
      for (var c = 0; c < L.chans.length; c++) {
        var ch = L.chans[c];
        var comp = b.u16(q); q += 2;
        if (comp !== 0 && comp !== 1) {
          fail('第 ' + (layerOffset + i + 1) + ' 层的通道用了 ' +
            (comp === 2 || comp === 3 ? 'ZIP' : '未知') + ' 压缩（' + comp +
            '），茶绘读不了。请在 Photoshop 里另存为「RLE / 未压缩」再试。');
        }
        var need = lw * bytesPerSample;
        var rows = [];
        if (lh && lw) {
          if (comp === 1) {
            var table = new Uint32Array(lh);
            for (var y = 0; y < lh; y++) { table[y] = b.u16(q); q += 2; }
            for (var y2 = 0; y2 < lh; y2++) {
              rows.push(takeBytes(unpackbits(b, q, table[y2], need), lw, bytesPerSample));
              q += table[y2];
            }
          } else {
            for (var y3 = 0; y3 < lh; y3++) {
              rows.push(takeBytes(b.u.subarray(q, q + need), lw, bytesPerSample));
              q += need;
            }
          }
        }
        L.planes[ch.id] = rows;
      }
    }
    return q;
  }

  /* ------------------------------------------------------------ 层记录解析 */

  /** 读层记录。返回 { layers, q }，q 是通道数据的起点 */
  function readLayerRecords(b, lmStart, lmLen, notes) {
    var end = lmStart + lmLen;
    var q = lmStart + 4;
    var count = b.i16(q); q += 2;
    if (count < 0) {
      count = -count;      // 负数表示「第一个 alpha 通道装的是合成透明」，层数取绝对值
      notes.push('这份 PSD 的层数用了很老的写法（首个 alpha 通道语义），已按绝对值读取');
    }
    if (count > 2000) fail('这份 PSD 声称有 ' + count + ' 层，看着不像真的，先不读了');
    var layers = [];
    for (var i = 0; i < count; i++) {
      var L = {
        top: b.i32(q), left: b.i32(q + 4), bottom: b.i32(q + 8), right: b.i32(q + 12)
      };
      q += 16;
      var nch = b.u16(q); q += 2;
      if (nch > 64) fail('第 ' + (i + 1) + ' 层声称有 ' + nch + ' 个通道，不像真的');
      L.chans = [];
      for (var c = 0; c < nch; c++) {
        L.chans.push({ id: b.i16(q), len: b.u32(q + 2) });
        q += 6;
      }
      var sig = b.str(q, 4); q += 4;
      if (sig !== '8BIM') fail('第 ' + (i + 1) + ' 层的混合模式签名不是 8BIM（是 ' + sig + '），读不下去了');
      L.blend = b.str(q, 4); q += 4;
      L.opacity = b.u8(q); q++;
      L.clipping = b.u8(q); q++;
      L.flags = b.u8(q); q++;
      q++;                                   // filler，固定 0
      var extraLen = b.u32(q); q += 4;
      var extraEnd = q + extraLen;
      if (extraEnd > end) fail('第 ' + (i + 1) + ' 层的附加数据越界了');

      // 图层蒙版数据：矩形(16) + 默认色(1) + 标志(1) = 18 字节起。
      // 矩形为空（0,0,0,0）就是「这层没有蒙版」。
      L.maskRect = null; L.maskFlags = 0;
      var maskLen = b.u32(q); q += 4;
      if (maskLen >= 18) {
        var mr = { top: b.i32(q), left: b.i32(q + 4), bottom: b.i32(q + 8), right: b.i32(q + 12) };
        if (mr.bottom > mr.top && mr.right > mr.left) {
          L.maskRect = mr;
          L.maskFlags = b.u8(q + 17);
        }
      }
      q += maskLen;
      var brLen = b.u32(q); q += 4 + brLen;          // 混合范围，用不上

      // 层名：Pascal 段是 MacRoman（中文一律被写成 '?'），真名在后面的 luni 里
      var nlen = b.u8(q); q += 1;
      L.pascalName = b.str(q, nlen);
      q += nlen + ((4 - ((1 + nlen) % 4)) % 4);

      L.luni = null; L.lsct = null;
      while (q + 12 <= extraEnd) {
        if (b.str(q, 4) !== '8BIM') break;
        var key = b.str(q + 4, 4);
        var len = b.u32(q + 8);
        if (key === 'luni') {
          var cnt = b.u32(q + 12);
          if (cnt > 0 && cnt < 256 && q + 16 + cnt * 2 <= extraEnd) {
            var s = '';
            for (var k = 0; k < cnt; k++) s += String.fromCharCode(b.u16(q + 16 + k * 2));
            L.luni = s;
          }
        } else if (key === 'lsct') {
          L.lsct = b.u32(q + 12);
        }
        // 其它标签（lclr 层颜色 / lnsr / lyid / lspf / TySh 文字 / 图层样式…）
        // 茶绘没有对应概念，靠长度字段跳过就好
        q += 12 + len + ((4 - (len % 4)) % 4);
      }
      q = extraEnd;
      L.name = L.luni || L.pascalName || ('图层 ' + (i + 1));
      L.hidden = !!(L.flags & 0x02);       // bit1：1 = 隐藏
      L.alphaLock = !!(L.flags & 0x01);    // bit0：1 = 保护透明像素
      layers.push(L);
    }
    return { layers: layers, q: q };
  }

  /* --------------------------------------------------------------- 合成图 */

  /** 没有图层信息（被拼合过的 PSD）时退而读合成图。返回 ImageData 或 null */
  function readComposite(b, lmStart, lmLen, cw, ch, bytesPerSample, channels, gray, notes) {
    // 通道数是最早能发现「文件被截断 / 没下完」的地方：RGB 至少 3 个、灰度至少 1 个。
    // 字节不够也一律返回 null —— 让调用方去说那句人话。
    // 不这么做的话，一个 undefined 会一路飘到 putImageData，
    // 用户看到的是 "Cannot read properties of undefined (reading '0')"。
    if (channels < (gray ? 1 : 3)) return null;
    var p = lmStart + lmLen;
    if (p + 2 > b.u.length) return null;
    var comp = b.u16(p); p += 2;
    if (comp !== 0 && comp !== 1) return null;
    var planes = [];
    var need = cw * bytesPerSample;
    if (comp === 1) {
      if (p + channels * ch * 2 > b.u.length) return null;      // 行长表都放不下
      var tables = [];
      for (var c = 0; c < channels; c++) {
        var t = new Uint32Array(ch);
        for (var y = 0; y < ch; y++) { t[y] = b.u16(p); p += 2; }
        tables.push(t);
      }
      for (var c2 = 0; c2 < channels; c2++) {
        var rows = [];
        for (var y2 = 0; y2 < ch; y2++) {
          rows.push(takeBytes(unpackbits(b, p, tables[c2][y2], need), cw, bytesPerSample));
          p += tables[c2][y2];
        }
        planes.push(rows);
      }
    } else {
      if (p + channels * cw * ch * bytesPerSample > b.u.length) return null;
      for (var c3 = 0; c3 < channels; c3++) {
        var rows2 = [];
        for (var y3 = 0; y3 < ch; y3++) {
          rows2.push(takeBytes(b.u.subarray(p, p + need), cw, bytesPerSample));
          p += need;
        }
        planes.push(rows2);
      }
    }
    if (planes.length < (gray ? 1 : 3) || !planes[0] || planes[0].length < ch) return null;
    var img = new ImageData(cw, ch);
    var d = img.data;
    for (var yy = 0; yy < ch; yy++) {
      for (var xx = 0; xx < cw; xx++) {
        var i = (yy * cw + xx) * 4;
        if (gray) {
          d[i] = d[i + 1] = d[i + 2] = planes[0][yy][xx];
        } else {
          d[i] = planes[0][yy][xx];
          d[i + 1] = planes[1][yy][xx];
          d[i + 2] = planes[2][yy][xx];
        }
        d[i + 3] = planes.length >= 4 ? planes[3][yy][xx] : 255;
      }
    }
    notes.push('这份 PSD 没有图层信息（应该是被拼合过），装进来是一张单层图');
    return img;
  }

  /* ---------------------------------------------------------------- 主流程 */

  /**
   * @param {Uint8Array|ArrayBuffer} input  .psd 的字节
   * @param {{maxLayers?:number, maxSide?:number}} [opts]
   * @returns {{format:string, doc:object, notes:string[]}} doc 与 project.js 的 doc 同形
   */
  function read(input, opts) {
    opts = opts || {};
    var maxLayers = opts.maxLayers || MAX_LAYERS;
    var maxSide = opts.maxSide || MAX_SIDE;
    if (!input) fail('没有拿到 PSD 数据');
    var u8 = (input instanceof Uint8Array) ? input : new Uint8Array(input);
    var b = new Bytes(u8);
    var notes = [];

    if (u8.length < 26) fail('这不是一份 PSD（连 26 字节的文件头都不够）');
    if (b.str(0, 4) !== '8BPS') fail('这不是 PSD 文件（开头不是 8BPS）');
    var version = b.u16(4);
    if (version === 2) fail('这是 PSB（大文档格式），茶绘读不了 —— 在 Photoshop 里另存为 PSD 再试');
    if (version !== 1) fail('不认识的 PSD 版本号 ' + version);

    var channels = b.u16(12);
    var height = b.u32(14);
    var width = b.u32(18);
    var depth = b.u16(22);
    var colorMode = b.u16(24);

    if (depth !== 8 && depth !== 16) {
      fail('这份 PSD 是 ' + depth + ' 位/通道的，茶绘只认 8 位和 16 位（可在 Photoshop 里转成 8 位再导）');
    }
    if (depth === 16) notes.push('16 位的画被降成 8 位（茶绘按 8 位工作）');
    var gray = colorMode === 1;
    if (colorMode !== 3 && colorMode !== 1) {
      fail('这份 PSD 的颜色模式是 ' + (COLOR_MODE[colorMode] || colorMode) +
        '，茶绘只认 RGB 和灰度（转一下再导）');
    }
    if (!(width >= 1 && height >= 1)) fail('这份 PSD 的尺寸写着 ' + width + '×' + height + '，读不了');
    if (!(channels >= 1 && channels <= 56)) {
      fail('这份 PSD 的文件头里写着 ' + channels + ' 个通道，不像一份完整的文件（是不是没下完？）');
    }
    if (width > maxSide || height > maxSide) {
      fail('这份 PSD 是 ' + width + '×' + height + '，超过茶绘的画布上限 ' + maxSide + '，请先缩小再导');
    }
    // 「就这么大点」的检查：截断的文件在这里就该被拦住。
    // 后面每个段都有自己的长度字段，一路读到越界只会换来一句 JS 原生报错。
    if (u8.length < 34) fail('这份 PSD 在文件头之后就断了（文件可能没下完）');

    var p = 26;
    var cmLen = b.u32(p); p += 4;
    if (p + cmLen > u8.length) fail(SHORT);
    p += cmLen;
    if (gray) notes.push('灰度 PSD，已按 RGB 三通道同值装进来');
    var irLen = b.u32(p); p += 4;
    if (p + irLen > u8.length) fail(SHORT);
    p += irLen;
    var lmLen = b.u32(p);
    var lmStart = p + 4;
    if (lmStart + lmLen > u8.length) fail(SHORT);
    var bytesPerSample = depth / 8;

    var rec = null;
    if (lmLen > 6 && lmStart + lmLen <= u8.length) {
      rec = readLayerRecords(b, lmStart, lmLen, notes);
    }

    if (!rec || !rec.layers.length) {
      var img = readComposite(b, lmStart, lmLen, width, height, bytesPerSample, channels, gray, notes);
      if (!img) fail('这份 PSD 里既没有图层，也没有能读的合成图（画面数据可能被裁掉了）');
      var c0 = mkCanvas(width, height);
      c0.getContext('2d').putImageData(img, 0, 0);
      return {
        format: 'chahui-psd',
        notes: notes,
        doc: {
          width: width, height: height, background: '#ffffff', groups: [],
          layers: [{
            name: '背景', visible: true, opacity: 1, locked: false, alphaLock: false,
            blend: 'normal', groupId: null, clip: false, maskEnabled: true,
            png: c0.toDataURL('image/png'), maskPng: null
          }]
        }
      };
    }

    // 通道数据紧跟在全部层记录之后
    readChannels(b, rec.layers, rec.q, bytesPerSample, 0);

    /* ---- 把扁平的层记录折成「组 + 组内层」 ---- */
    var groups = [];
    var outLayers = [];
    var stack = [];            // 当前打开的组（PSD 允许嵌套）

    for (var li = 0; li < rec.layers.length; li++) {
      var L = rec.layers[li];
      if (L.lsct === 3) {                                  // 组的开始
        var g = {
          id: 'G' + Math.random().toString(36).slice(2, 8),
          name: '组', visible: true, opacity: 1, blend: 'normal', collapsed: false
        };
        groups.push(g);
        stack.push(g);
        continue;
      }
      if (L.lsct === 1 || L.lsct === 2) {                   // 组的结束（名字挂在这条上）
        var cur = stack.pop();
        if (cur) {
          cur.name = L.name || '组';
          cur.visible = !L.hidden;
          cur.opacity = L.opacity / 255;
          cur.blend = BLEND_BY_KEY[L.blend] || 'normal';
          cur.collapsed = L.lsct === 2;
        }
        continue;
      }
      if (stack.length > 1) {
        notes.push('「' + L.name + '」在嵌套组里，茶绘没有嵌套组，已按最内层那一组处理');
      }
      var parent = stack.length ? stack[stack.length - 1] : null;

      /* ---- 像素 ---- */
      var cv = mkCanvas(width, height);
      cv.getContext('2d').putImageData(planesToImageData(L, gray, width, height), 0, 0);

      /* ---- 蒙版 ---- */
      var maskPng = null, maskEnabled = true;
      var mrows = L.planes[-2];
      if (mrows && mrows.length && L.maskRect) {
        // PSD 蒙版是灰度：0 = 全遮、255 = 全露。茶绘用 alpha 表示同一件事，
        // 所以「白 + alpha=灰度」就是同一张蒙版的另一种存法，不用取反。
        var mimg = new ImageData(width, height);
        var md = mimg.data;
        var mr = L.maskRect;
        for (var my = Math.max(0, mr.top); my < Math.min(height, mr.bottom); my++) {
          var mrow = mrows[my - L.top];
          if (!mrow) continue;
          for (var mx = Math.max(0, mr.left); mx < Math.min(width, mr.right); mx++) {
            var gv = mrow[mx - L.left];
            if (gv === undefined) continue;
            var mi = (my * width + mx) * 4;
            md[mi] = md[mi + 1] = md[mi + 2] = 255;
            md[mi + 3] = gv;
          }
        }
        var mc = mkCanvas(width, height);
        mc.getContext('2d').putImageData(mimg, 0, 0);
        maskPng = mc.toDataURL('image/png');
        maskEnabled = !(L.maskFlags & 0x02);        // bit1 = 蒙版被停用
        if (L.maskFlags & 0x04) notes.push('「' + L.name + '」的蒙版带「反相」标记，已按原样读入');
      } else if (mrows && mrows.length) {
        notes.push('「' + L.name + '」的蒙版矩形是空的，当没有蒙版处理');
      }

      var blend = BLEND_BY_KEY[L.blend];
      if (!blend) {
        if (L.blend !== 'norm') {
          notes.push('「' + L.name + '」的混合模式是 ' + L.blend + '，茶绘没有对应项，已按正常处理');
        }
        blend = 'normal';
      }

      outLayers.push({
        name: String(L.name || '').slice(0, 24) || ('图层 ' + (outLayers.length + 1)),
        visible: !L.hidden,
        opacity: L.opacity / 255,
        locked: false,
        alphaLock: L.alphaLock,
        blend: blend,
        // 剪贴位：0 = 普通层，1 = 剪贴到下面那一层（和茶绘的剪贴蒙版是同一个意思）
        clip: L.clipping === 1,
        groupId: parent ? parent.id : null,
        maskEnabled: maskEnabled,
        png: cv.toDataURL('image/png'),
        maskPng: maskPng
      });
    }
    if (stack.length) notes.push('这份 PSD 的组标记不完整（有组没闭合），后面的层已按普通层读入');

    /* ---- 茶绘的画布上限 ---- */
    if (outLayers.length > maxLayers) {
      notes.push('这份 PSD 有 ' + outLayers.length + ' 层，茶绘上限 ' + maxLayers +
        ' 层，只装进了最下面 ' + maxLayers + ' 层');
      outLayers = outLayers.slice(0, maxLayers);
    }
    // 一层都没装进来的组是个空壳，清掉 —— 否则图层表里会冒出一个点不开的空组
    var used = {};
    outLayers.forEach(function (l) { if (l.groupId) used[l.groupId] = 1; });
    var keptGroups = groups.filter(function (g) { return used[g.id]; });
    if (keptGroups.length !== groups.length) {
      notes.push('有 ' + (groups.length - keptGroups.length) + ' 个组里一层都没装进来，已丢弃这个空组');
    }

    return {
      format: 'chahui-psd',
      notes: notes,
      doc: {
        width: width, height: height, background: '#ffffff',
        // 组表按「由深到浅」排；组内成员在 outLayers 里本来就是连续的一段，
        // 正好满足服务端 normalizeGroups() 的硬要求
        groups: keptGroups.map(function (g) {
          return {
            id: g.id, name: g.name, visible: g.visible,
            opacity: g.opacity, blend: g.blend, collapsed: g.collapsed
          };
        }),
        layers: outLayers
      }
    };
  }

  /**
   * 直接给一份「伪工程」：openProjectDoc 只用到 name / doc，
   * 所以 PSD 读出来的东西包一层就能喂进去，装载链路一行都不用改。
   */
  function toProject(input, opts) {
    var r = read(input, opts);
    return {
      format: 'chahui-psd-import',
      version: 1,
      app: '',
      name: (opts && opts.name) || '',
      savedAt: Date.now(),
      doc: r.doc,
      notes: r.notes
    };
  }

  /** 一句话说明「读到了什么」，给提示用 */
  function describe(result) {
    var doc = result.doc;
    var withMask = doc.layers.filter(function (l) { return l.maskPng; }).length;
    var txt = doc.width + '×' + doc.height + ' · ' + doc.layers.length + ' 层';
    if (doc.groups.length) txt += ' · ' + doc.groups.length + ' 个组';
    if (withMask) txt += ' · ' + withMask + ' 张蒙版';
    return txt;
  }

  global.ChaPsdRead = {
    read: read,
    toProject: toProject,
    describe: describe,
    unpackbits: unpackbits,
    BLEND_BY_KEY: BLEND_BY_KEY,
    MAX_LAYERS: MAX_LAYERS,
    MAX_SIDE: MAX_SIDE
  };
})(window);
