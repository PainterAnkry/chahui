/**
 * 茶绘 · PSD（Photoshop 8BPS）导出
 *
 * 茶绘自己写的一个最小但**规范**的 PSD 编码器：8 位 / RGB / 4 通道（RGBA），
 * 保留图层、**图层组**、图层名、不透明度、混合模式、可见性、锁定透明像素。
 *
 * 为什么不用 canvas 编码：canvas 只给得出 png/jpeg/webp，PSD 得自己拼字节。
 *
 * 几个关键字节布局（都拿参照实现实测过，别凭记忆改）：
 *
 *   层记录在文件里的排列是**自下而上**（数组第 0 项 = 最底下的层）。
 *   一个组占 4 类记录，按这个顺序紧挨着排：
 *
 *       [ type=3 边界分隔符 ]         ← 组的下边界
 *       [ 组内各层，自下而上 ]
 *       [ type=1 张开 / 2 收起 分隔符 ] ← 组的上边界
 *
 *   也就是说「子层在中间，闭合标记在下、开启标记在上」。
 *
 *   层名要写两份：pascal 名（非 ASCII 一律写 '?'，因为 PSD 的 pascal 段是
 *   MacRoman，塞中文只会乱码）+ `luni` 里的 UTF-16BE 真名（Photoshop / SAI / CSP
 *   都认这个）。pascal 段要零填充到 4 字节对齐；luni 载荷要补到 4 的倍数。
 *
 *   通道数据长度**含那 2 个字节的压缩标志**。RLE 时，每个通道前面是
 *   「每行压缩后长度的表」（每行 2 字节大端），后面才是压缩数据；
 *   合成图那里更特殊：**先写完全部通道的表，再写全部通道的数据**。
 *
 * 像素来源：engine.renderLayerRaw()（图层自身像素，不套图层浓度 / 混合模式），
 * 这和 PSD 的语义正好对上 —— 浓度和混合模式是层记录上的字段，不能再烘进像素里。
 */
(function (global) {
  'use strict';

  var MAX_SIDE = 30000;                  // PSD 单边上限（PSB 才放宽到 300000）
  var MAX_LAYERS = 32000;
  var EMPTY = new Uint8Array(0);

  /* Photoshop 的四字符混合模式代码。茶绘的 BLEND_MODES 与它一一对应。
     'add' = 线性减淡（linear dodge），别写成 'add '。 */
  var BLEND_KEY = {
    'normal': 'norm', 'multiply': 'mul ', 'screen': 'scrn', 'overlay': 'over',
    'darken': 'dark', 'lighten': 'lite', 'add': 'lddg', 'difference': 'diff',
    'exclusion': 'smud', 'hard-light': 'hLit', 'soft-light': 'sLit',
    'color-dodge': 'div ', 'color-burn': 'idiv',
    'hue': 'hue ', 'saturation': 'sat ', 'color': 'colr', 'luminosity': 'lum '
  };

  function blendKey(name) { return BLEND_KEY[name] || 'norm'; }

  function clamp01(v) {
    v = typeof v === 'number' && isFinite(v) ? v : 1;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* ---------------- 字节写入器（可增长 + 回填长度） ---------------- */

  function W() {
    this.a = new Uint8Array(1 << 16);
    this.n = 0;
  }
  W.prototype._fit = function (k) {
    if (this.n + k <= this.a.length) return;
    var cap = this.a.length;
    while (cap < this.n + k) cap *= 2;
    var b = new Uint8Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  };
  W.prototype.u8 = function (v) { this._fit(1); this.a[this.n++] = v & 255; };
  W.prototype.u16 = function (v) {
    this._fit(2);
    this.a[this.n++] = (v >>> 8) & 255; this.a[this.n++] = v & 255;
  };
  W.prototype.i16 = function (v) { this.u16(v < 0 ? v + 65536 : v); };
  W.prototype.u32 = function (v) {
    this._fit(4);
    this.a[this.n++] = (v >>> 24) & 255; this.a[this.n++] = (v >>> 16) & 255;
    this.a[this.n++] = (v >>> 8) & 255; this.a[this.n++] = v & 255;
  };
  W.prototype.i32 = function (v) { this.u32(v < 0 ? v + 4294967296 : v); };
  W.prototype.raw = function (bytes) { this._fit(bytes.length); this.a.set(bytes, this.n); this.n += bytes.length; };
  W.prototype.zeros = function (k) { this._fit(k); this.n += k; };
  W.prototype.sig = function (s) { for (var i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); };
  W.prototype.patchU32 = function (off, v) {
    this.a[off] = (v >>> 24) & 255; this.a[off + 1] = (v >>> 16) & 255;
    this.a[off + 2] = (v >>> 8) & 255; this.a[off + 3] = v & 255;
  };
  W.prototype.bytes = function () { return this.a.subarray(0, this.n); };

  /* ---------------- PackBits（PSD 的 RLE） ---------------- */

  /** 最坏情况：全是字面量时 128 字节膨胀成 129 */
  function rleCap(len) { return len + ((len + 127) >> 7) + 8; }

  /**
   * 把 src[off .. off+len) 压成 PackBits，写进 out，返回写了多少字节。
   *
   * 两个头字节的算法都极易写错，记住口径：
   *   重复段：头字节 = 1 - n（有符号），n 是重复次数，2~128。
   *           转成无符号就是 257 - n —— **不是 256 - n**。
   *           差这一个 1 会让「重复 2 次」被读成「重复 3 次」，
   *           整行长度全错。只抽查几个像素是发现不了的（前后段颜色一样），
   *           必须验「解出来正好等于行宽」。1 - 128 = -127，正好躲开 -128
   *           （-128 在规范里是空操作，拿它当 128 次重复会被整段跳过）。
   *   字面段：头字节 = n - 1，n 是字节数，1~128（127 封顶）。
   */
  function packbits(src, off, len, out) {
    var i = 0, w = 0;
    while (i < len) {
      var v = src[off + i];
      var run = 1;
      while (i + run < len && run < 128 && src[off + i + run] === v) run++;
      if (run >= 2) {
        out[w++] = (257 - run) & 255;
        out[w++] = v;
        i += run;
        continue;
      }
      // 字面段：一直收到「下一个三连重复」为止（最多 128）
      var start = i, end = i;
      while (end < len && (end - start) < 128) {
        if (end + 2 < len && src[off + end] === src[off + end + 1] && src[off + end] === src[off + end + 2]) break;
        end++;
      }
      if (end === start) end = start + 1;   // run>=2 已排除，这里是个保险
      var nl = end - start;
      out[w++] = nl - 1;
      for (var k = 0; k < nl; k++) out[w++] = src[off + start + k];
      i = end;
    }
    return w;
  }

  /**
   * 一个通道的 RLE 数据 = 行长度表 + 各行压缩数据。
   * @param d    RGBA 交错像素（ImageData.data）
   * @param ci   取哪个通道（0=R 1=G 2=B 3=A）
   * @param row  w 长的复用缓冲（避免每行都新建）
   */
  function channelRLE(d, w, h, ci, row, tmp) {
    var lens = new Uint32Array(h);
    var body = new W();
    for (var y = 0; y < h; y++) {
      var base = y * w * 4 + ci;
      for (var x = 0; x < w; x++) row[x] = d[base + x * 4];
      var n = packbits(row, 0, w, tmp);
      lens[y] = n;
      body.raw(tmp.subarray(0, n));
    }
    var out = new Uint8Array(h * 2 + body.n);
    var p = 0;
    for (var i = 0; i < h; i++) { out[p++] = (lens[i] >>> 8) & 255; out[p++] = lens[i] & 255; }
    out.set(body.bytes(), p);
    return out;
  }

  /* ---------------- 层名 ---------------- */

  /** PSD 的 pascal 段是 MacRoman，塞不进中文 → 非 ASCII 写 '?'（真名在 luni 里） */
  function asciiName(name) {
    var s = String(name == null ? '' : name);
    if (s.length > 255) s = s.slice(0, 255);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c < 128 && c >= 32) ? s.charAt(i) : '?';
    }
    return out;
  }

  function writePascalName(w, name) {
    var s = asciiName(name);
    w.u8(s.length);
    for (var i = 0; i < s.length; i++) w.u8(s.charCodeAt(i));
    var pad = (4 - ((1 + s.length) % 4)) % 4;
    for (var k = 0; k < pad; k++) w.u8(0);
  }

  function writeLuni(w, name) {
    var s = String(name == null ? '' : name);
    var payload = 4 + s.length * 2;
    var pad = (4 - (payload % 4)) % 4;
    w.sig('8BIM'); w.sig('luni');
    w.u32(payload + pad);
    w.u32(s.length);
    for (var i = 0; i < s.length; i++) w.u16(s.charCodeAt(i));
    for (var k = 0; k < pad; k++) w.u8(0);
  }

  /**
   * 组分隔符。type: 1 张开 / 2 收起 / 3 边界。
   * 非边界的那种后面还跟「混合模式签名 + 混合模式 + 子类型」，共 16 字节载荷；
   * 边界那种只有 4 字节（就一个 type），别写多了。
   */
  function writeLsct(w, type, group) {
    w.sig('8BIM'); w.sig('lsct');
    if (type === 3) { w.u32(4); w.u32(3); return; }
    w.u32(16);
    w.u32(type);
    w.sig('8BIM');
    w.sig(blendKey(group ? group.blend : 'normal'));
    w.u32(0);
  }

  /* ---------------- 展平成 PSD 的层列表 ---------------- */

  function collect(engine) {
    var units = engine.renderUnits();
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u.group) {
        out.push({ kind: 'layer', layer: u.layers[0] });
        continue;
      }
      out.push({ kind: 'divider', type: 3, group: null, name: '</Layer group>' });
      for (var j = 0; j < u.layers.length; j++) out.push({ kind: 'layer', layer: u.layers[j] });
      out.push({
        kind: 'divider', type: (u.group.collapsed ? 2 : 1),
        group: u.group, name: u.group.name || '组'
      });
    }
    return out;
  }

  /** 把一张画布读成 ImageData（主画布禁 putImageData，但这里只读，没有那个坑） */
  function pixelsOf(canvas, w, h) {
    return canvas.getContext('2d').getImageData(0, 0, w, h).data;
  }

  /* ---------------- 主流程 ---------------- */

  /**
   * @param engine CanvasEngine
   * @param opts   { compositeAlpha:boolean }  合成图是否保留透明（默认 true）
   * @returns Uint8Array
   */
  function encodeBytes(engine, opts) {
    opts = opts || {};
    if (!engine || !engine.layers) throw new Error('没有可导出的文档');
    var w = engine.width | 0, h = engine.height | 0;
    if (!w || !h) throw new Error('画布尺寸无效');
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error('尺寸超出 PSD 上限（' + MAX_SIDE + 'px）');

    var entries = collect(engine);
    if (!entries.length) throw new Error('没有图层可以导出');
    if (entries.length > MAX_LAYERS) throw new Error('图层太多，超出 PSD 上限');

    var row = new Uint8Array(w);
    var tmp = new Uint8Array(rleCap(w));

    /* 先把每层的通道数据算出来 —— 层记录里要写通道长度，所以必须先有数据 */
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.kind === 'divider') {
        // 分隔符没有像素：4 个通道，每个通道只有 2 字节的压缩标志（= 长度 2）
        e.chans = [];
        var ids = [-1, 0, 1, 2];
        for (var c = 0; c < ids.length; c++) e.chans.push({ id: ids[c], comp: 0, data: EMPTY });
        continue;
      }
      var l = e.layer;
      var cv = engine.renderLayerRaw ? engine.renderLayerRaw(l.id) : null;
      if (!cv) throw new Error('图层「' + (l.name || l.id) + '」读不到像素');
      var d = pixelsOf(cv, w, h);
      e.chans = [
        { id: 0, comp: 1, data: channelRLE(d, w, h, 0, row, tmp) },
        { id: 1, comp: 1, data: channelRLE(d, w, h, 1, row, tmp) },
        { id: 2, comp: 1, data: channelRLE(d, w, h, 2, row, tmp) },
        { id: -1, comp: 1, data: channelRLE(d, w, h, 3, row, tmp) }
      ];
      d = null;
    }

    var out = new W();

    /* ---- 1. 文件头（26 字节） ---- */
    out.sig('8BPS');
    out.u16(1);                       // 版本
    out.zeros(6);                     // 保留
    out.u16(4);                       // 通道数（R G B A）
    out.u32(h);
    out.u32(w);
    out.u16(8);                       // 每通道位深
    out.u16(3);                       // 颜色模式 3 = RGB

    /* ---- 2. 颜色模式数据（RGB 为空） ---- */
    out.u32(0);

    /* ---- 3. 图像资源（留空：Photoshop 完全接受没有资源块的 PSD） ---- */
    out.u32(0);

    /* ---- 4. 图层与蒙版信息 ---- */
    var lmPos = out.n; out.u32(0);
    var lmStart = out.n;

    var liPos = out.n; out.u32(0);
    var liStart = out.n;

    out.i16(entries.length);          // 正数：不把「首个 alpha 通道 = 合成透明」写进去

    /* 4a. 全部层记录 */
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var isDiv = e.kind === 'divider';
      var src = isDiv ? (e.group || null) : e.layer;
      // 分隔符没有像素，矩形必须是空的（0,0,0,0）。
      // 要是给它也写整幅文档的矩形，读的人会按 1000×1600 去找 160 万字节像素 ——
      // 而后面一个字节都没有，整份文件当场读崩。
      out.i32(0); out.i32(0); out.i32(isDiv ? 0 : h); out.i32(isDiv ? 0 : w);
      out.u16(e.chans.length);
      for (var ci = 0; ci < e.chans.length; ci++) {
        out.i16(e.chans[ci].id);
        out.u32(2 + e.chans[ci].data.length);               // 长度**含**压缩标志那 2 字节
      }
      out.sig('8BIM');
      out.sig(blendKey(src ? src.blend : 'normal'));
      out.u8(Math.round(clamp01(src ? src.opacity : 1) * 255));
      out.u8(0);                                            // 剪贴板（clipping）
      var flags = isDiv ? 0x18 : 0x08;                      // 0x10 = 这层的像素不参与成图
      if (src && src.visible === false) flags |= 0x02;      // bit1：1 = 隐藏
      if (!isDiv && e.layer && e.layer.alphaLock) flags |= 0x01;  // 锁定透明像素
      out.u8(flags);
      out.u8(0);                                            // filler

      var extra = new W();
      extra.u32(0);                                         // 图层蒙版数据：无
      extra.u32(0);                                         // 混合范围：无
      writePascalName(extra, isDiv ? e.name : (e.layer.name || ''));
      writeLuni(extra, isDiv ? e.name : (e.layer.name || ''));
      if (isDiv) writeLsct(extra, e.type, e.group);
      out.u32(extra.n);
      out.raw(extra.bytes());
    }

    /* 4b. 全部通道数据 */
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      for (var cj = 0; cj < e.chans.length; cj++) {
        out.u16(e.chans[cj].comp);
        if (e.chans[cj].data.length) out.raw(e.chans[cj].data);
      }
      e.chans = null;                                       // 及时松手，大文档省内存
    }

    /* 图层信息段补到偶数长度（规范要求） */
    if ((out.n - liStart) % 2) out.u8(0);
    out.patchU32(liPos, out.n - liStart);

    /* 全局图层蒙版信息：无 */
    out.u32(0);

    if ((out.n - lmStart) % 2) out.u8(0);
    out.patchU32(lmPos, out.n - lmStart);

    /* ---- 5. 合成图像数据（打开 PSD 时先看到的那张） ---- */
    var flat = engine.renderDocument({ transparentBackground: opts.compositeAlpha !== false });
    var fd = pixelsOf(flat.canvas, w, h);
    var planes = [];
    for (var pc = 0; pc < 4; pc++) planes.push(channelRLE(fd, w, h, pc, row, tmp));
    out.u16(1);                                             // RLE
    for (var t = 0; t < 4; t++) {                           // 先全部通道的行长度表
      for (var y2 = 0; y2 < h; y2++) {
        var off = y2 * 2;
        out.u16((planes[t][off] << 8) | planes[t][off + 1]);
      }
    }
    for (var dt = 0; dt < 4; dt++) {                        // 再全部通道的数据
      out.raw(planes[dt].subarray(h * 2));
    }

    return out.bytes().slice();
  }

  function b64(bytes) {
    var CH = 0x8000, s = '';
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /** 和别的格式一样返回 dataURL —— 桌面端主进程会解析 base64 写文件，网页端就是普通下载 */
  function encode(engine, opts) {
    var bytes = encodeBytes(engine, opts);
    return 'data:image/vnd.adobe.photoshop;base64,' + b64(bytes);
  }

  global.ChaPsd = {
    encode: encode,
    encodeBytes: encodeBytes,
    blendKey: blendKey,
    packbits: packbits,
    asciiName: asciiName,
    MAX_SIDE: MAX_SIDE
  };
})(window);
