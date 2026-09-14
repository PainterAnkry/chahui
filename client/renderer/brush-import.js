/**
 * 茶绘 · 笔刷导入（Photoshop `.abr` / Clip Studio Paint `.sut`）
 *
 * 目标不是「1:1 还原 Photoshop 的描边引擎」——那套东西搬不过来。能做到的是：
 * 把笔刷的**笔尖形状**取出来，配上间距、硬度这些能量化的参数，让它在茶绘里
 * 画起来「是那支笔」，而不是变成一支圆头笔。
 *
 * 两种文件的结构（大端）：
 *
 *   .abr v1/v2（旧格式，PS 6 之前）
 *     u16 版本(1|2) · u16 数量
 *     每支笔: u16 类型(2=采样) · u32 本块字节数 · 块内容
 *       块内容: [v2 才有] unicode 名 · u32 misc · u16 间距 · u8 抗锯齿 · 8 字节短边界
 *               i32 top/left/bottom/right · u16 位深 · u8 压缩 · 位图
 *
 *   .abr v6/v7/v10（新格式）
 *     u16 版本 · u16 次版本
 *     之后是一串 '8BIM' 块: 4 字节签名 · 4 字节 key · u32 长度 · 数据（4 字节对齐）
 *       'samp' 块里是若干条: u32 条目长度 · unicode 名 · 上面那串「边界+位深+压缩+位图」
 *       'desc' 块里是笔刷动态参数（这里不解析，形状和间距已经够用了）
 *
 *   .sut（CSP）
 *     文件里嵌了一个 SQLite 库，笔尖是 PNG，直接按 PNG 签名 → IEND 扫出来即可，
 *     不需要实现 SQLite。CSP 的数值参数（BrushSize/BrushInterval 等）存在 SQLite 表里，
 *     这里不去读，形状和尺寸从笔尖本身推。
 *
 * 位图压缩：0 = 原样，1 = PackBits。
 */
(function (global) {
  'use strict';

  /* ============================================================ 二进制读取 */

  function Reader(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  Reader.prototype.left = function () { return this.buf.length - this.pos; };
  Reader.prototype.u8 = function () { return this.view.getUint8(this.pos++); };
  Reader.prototype.i16 = function () { var v = this.view.getInt16(this.pos); this.pos += 2; return v; };
  Reader.prototype.u16 = function () { var v = this.view.getUint16(this.pos); this.pos += 2; return v; };
  Reader.prototype.i32 = function () { var v = this.view.getInt32(this.pos); this.pos += 4; return v; };
  Reader.prototype.u32 = function () { var v = this.view.getUint32(this.pos); this.pos += 4; return v; };
  Reader.prototype.bytes = function (n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new RangeError('越界读取 ' + n);
    var b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  };
  Reader.prototype.ascii = function (n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.pos++]);
    return s;
  };
  Reader.prototype.skip = function (n) { this.bytes(n); };
  Reader.prototype.seek = function (p) { this.pos = p; };
  /** Photoshop 的 unicode 字符串：u32 长度（UTF-16 码元数）+ UTF-16BE，末尾 NUL 丢掉 */
  Reader.prototype.unicode = function () {
    var len = this.u32();
    if (len * 2 > this.buf.length) throw new RangeError('unicode 长度不合理：' + len);
    var s = '';
    for (var i = 0; i < len; i++) {
      var c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  };

  /** PackBits（TIFF/PS 通用的行程压缩） */
  function packBits(src, expect) {
    var out = new Uint8Array(expect);
    var o = 0, i = 0;
    while (i < src.length && o < expect) {
      var n = (src[i++] << 24) >> 24;          // 有符号
      if (n >= 0) {
        var cnt = n + 1;
        for (var k = 0; k < cnt && i < src.length && o < expect; k++) out[o++] = src[i++];
      } else if (n !== -128) {
        var rep = 1 - n;
        var b = i < src.length ? src[i++] : 0;
        for (var j = 0; j < rep && o < expect; j++) out[o++] = b;
      }
    }
    return out;
  }

  /* ============================================================ .abr */

  function readSampledTail(r) {
    r.i32(); r.i32(); r.i32(); r.i32();        // top/left/bottom/right
    var depth = r.u16();
    var compression = r.u8();
    var b = r.bytes(0);                        // 占位，下面按需要读
    void b;
    return { depth: depth, compression: compression };
  }

  /**
   * 采样笔刷的尾巴：边界 + 位深 + 压缩 + 位图。
   * 边界被后面的 r.seek(块末尾) 兜底，所以这里读错也不会失控。
   */
  function readSampled(r) {
    var top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    var depth = r.u16();
    var compression = r.u8();
    var w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0 || w * h > 40000000) throw new Error('笔尖尺寸不合理 ' + w + 'x' + h);
    if (depth !== 8) throw new Error('只支持 8 位笔尖（实际 ' + depth + ' 位）');
    var gray;
    if (compression === 0) {
      gray = r.bytes(w * h).slice();
    } else if (compression === 1) {
      var lens = [];
      for (var y = 0; y < h; y++) lens.push(r.u16());
      gray = new Uint8Array(w * h);
      for (var yy = 0; yy < h; yy++) {
        gray.set(packBits(r.bytes(lens[yy]), w), yy * w);
      }
    } else {
      throw new Error('不支持的压缩方式 ' + compression);
    }
    return { w: w, h: h, gray: gray };
  }

  /** 入口统一成 Uint8Array —— FileReader 给的是 ArrayBuffer，测试里也可能直接给数组 */
  function asBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (buf && buf.buffer instanceof ArrayBuffer) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    throw new Error('不是能识别的二进制数据');
  }

  function parseAbr(buf) {
    buf = asBytes(buf);
    var r = new Reader(buf);
    var version = r.u16();
    var out = [];

    if (version === 1 || version === 2) {
      var count = r.u16();
      for (var i = 0; i < count; i++) {
        var type = r.u16();
        var size = r.u32();
        var end = r.pos + size;
        if (type === 2) {
          try {
            var name = version === 2 ? r.unicode() : '';
            r.u32();                    // misc
            var spacing = r.u16();
            r.u8();                     // 抗锯齿
            r.skip(8);                  // 短边界（下面还有一套长边界，以长边界为准）
            var s = readSampled(r);
            s.name = name;
            s.spacing = spacing / 100;
            out.push(s);
          } catch (e) { /* 这一支坏了就跳过，别让整个文件打不开 */ }
        }
        if (end > r.buf.length) break;
        r.seek(end);
      }
      return { version: version, brushes: out };
    }

    if (version !== 6 && version !== 7 && version !== 10) {
      throw new Error('不支持的 .abr 版本 ' + version);
    }

    r.u16();                             // 次版本
    var samp = null;
    while (r.left() >= 12) {
      if (r.ascii(4) !== '8BIM') break;
      var key = r.ascii(4);
      var len = r.u32();
      if (len > r.left()) break;
      var start = r.pos;
      if (key === 'samp') samp = buf.subarray(start, start + len);
      r.seek(start + len + ((4 - (len % 4)) % 4));   // 4 字节对齐
    }
    if (!samp) throw new Error('这个 .abr 里没有采样笔尖（可能是纯「计算笔刷」文件）');

    var sr = new Reader(samp);
    while (sr.left() >= 4) {
      var entryLen = sr.u32();
      if (entryLen === 0 || entryLen > sr.left()) break;
      var eEnd = sr.pos + entryLen;
      try {
        var nm = sr.unicode();
        var b2 = readSampled(sr);
        b2.name = nm;
        b2.spacing = 0.1;
        out.push(b2);
      } catch (e) { /* 跳过坏的条目 */ }
      var pad = (4 - (eEnd % 4)) % 4;
      sr.seek(Math.min(eEnd + pad, samp.length));
    }
    if (!out.length) throw new Error('sample 块里没解析出可用的笔尖');
    return { version: version, brushes: out };
  }

  /* ============================================================ .sut */

  var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  function findPngs(bytes) {
    var found = [];
    var i = 0;
    while (i < bytes.length - 8) {
      var hit = true;
      for (var k = 0; k < 8; k++) if (bytes[i + k] !== PNG_SIG[k]) { hit = false; break; }
      if (!hit) { i++; continue; }
      // 从签名往后找 IEND，取整个 PNG
      var j = i + 8, end = -1;
      while (j < bytes.length - 8) {
        if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4e && bytes[j + 3] === 0x44) {
          end = j + 8;                        // IEND + CRC
          break;
        }
        j++;
      }
      if (end < 0) break;
      found.push(bytes.slice(i, end));
      i = end;
    }
    return found;
  }

  function parseSut(buf) {
    var bytes = asBytes(buf);
    var pngs = findPngs(bytes);
    if (!pngs.length) throw new Error('这个 .sut 里没找到笔尖图片（可能不是 CSP 笔刷文件）');
    return { version: 0, brushes: pngs.map(function (b, i) {
      return { png: b, name: 'CSP 笔刷 ' + (i + 1), spacing: 0.1 };
    }) };
  }

  /* ============================================================ 笔尖打包 */

  var TIP_SIZE = 32;      // 打包后的边长
  var TIP_BITS = 4;       // 每像素 4 位 → 32×32 只要 512 字节，base64 约 683 字符

  /** 把任意尺寸的灰度笔尖按面积平均缩到 TIP_SIZE×TIP_SIZE，再量化成 4 位 */
  function packTip(gray, w, h) {
    var N = TIP_SIZE, acc = new Float64Array(N * N), cnt = new Float64Array(N * N);
    for (var y = 0; y < h; y++) {
      var ty = Math.min(N - 1, Math.floor(y * N / h));
      for (var x = 0; x < w; x++) {
        var tx = Math.min(N - 1, Math.floor(x * N / w));
        var i = ty * N + tx;
        acc[i] += gray[y * w + x];
        cnt[i] += 1;
      }
    }
    var packed = new Uint8Array(N * N / 2);
    for (var p = 0; p < N * N; p++) {
      var v = cnt[p] ? acc[p] / cnt[p] : 0;
      var q = Math.max(0, Math.min(15, Math.round(v / 255 * 15)));
      if (p % 2 === 0) packed[p >> 1] = q << 4;
      else packed[p >> 1] |= q;
    }
    return N + 'x' + N + 'x' + TIP_BITS + ':' + bytesToB64(packed);
  }

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** 同步解包：返回可直接 putImageData 的 RGBA */
  function unpackTip(str) {
    var m = /^(\d+)x(\d+)x(\d+):([\s\S]+)$/.exec(String(str || ''));
    if (!m) return null;
    var w = +m[1], h = +m[2], bits = +m[3];
    if (bits !== 4 || w < 2 || h < 2 || w > 128 || h > 128) return null;
    var bytes;
    try { bytes = b64ToBytes(m[4]); } catch (e) { return null; }
    if (bytes.length < w * h / 2) return null;
    var rgba = new Uint8ClampedArray(w * h * 4);
    for (var p = 0; p < w * h; p++) {
      var q = (p % 2 === 0) ? (bytes[p >> 1] >> 4) : (bytes[p >> 1] & 15);
      var a = Math.round(q / 15 * 255);
      var o = p * 4;
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = a;
    }
    return { w: w, h: h, rgba: rgba };
  }

  /**
   * 从笔尖估一个「边缘硬度」（0.05 极柔 … 1 硬边）。
   *
   * 关键是要量**过渡带有多宽**，而不是「亮度掉到一半的位置」——
   * 后者对硬边圆盘和线性柔边会给出几乎一样的数（实测都是 0.63），等于没测。
   * 做法：沿半径取平均亮度曲线，找从 90% 掉到 10% 的那一段占半径的比例。
   */
  function hardnessOf(gray, w, h) {
    var cx = (w - 1) / 2, cy = (h - 1) / 2;
    var maxR = Math.min(cx, cy) || 1;
    var N = 24;
    var sum = new Float64Array(N), cnt = new Float64Array(N);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var d = Math.hypot(x - cx, y - cy) / maxR;
        var b = Math.min(N - 1, Math.floor(d * N));
        sum[b] += gray[y * w + x];
        cnt[b] += 1;
      }
    }
    var prof = [];
    for (var i = 0; i < N; i++) prof.push(cnt[i] ? sum[i] / cnt[i] : 0);
    var peak = 0;
    for (var k = 0; k < N; k++) if (prof[k] > peak) peak = prof[k];
    if (peak <= 2) return 0.5;                     // 整张几乎是空的，说不清
    var rHi = 0, rLo = 0;
    for (var a = 0; a < N; a++) {
      if (prof[a] >= peak * 0.9) rHi = a + 1;
      if (prof[a] >= peak * 0.1) rLo = a + 1;
    }
    var band = Math.max(0, (rLo - rHi) / N);       // 过渡带占半径的比例
    return Math.max(0.05, Math.min(1, 1 - band * 2.4));
  }

  /* ============================================================ 统一出口 */

  /**
   * 解析一个笔刷文件。
   * @returns {{kind:'abr'|'sut', brushes:[{name,w,h,gray?,png?,spacing,tip}]}}
   */
  function parse(fileName, buf) {
    var name = String(fileName || '').toLowerCase();
    var res;
    if (/\.abr$/.test(name)) res = parseAbr(buf);
    else if (/\.sut$/.test(name)) res = parseSut(buf);
    else {
      // 后缀不可信时按内容猜
      var head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength || buf.length));
      if (head[0] === 0 && (head[1] === 1 || head[1] === 2 || head[1] === 6 || head[1] === 7 || head[1] === 10)) {
        res = parseAbr(buf);
      } else {
        res = parseSut(buf);
      }
    }
    var kind = res.version ? 'abr' : 'sut';
    res.brushes.forEach(function (b, i) {
      if (!b.name) b.name = '笔刷 ' + (i + 1);
      if (b.gray) {
        b.tip = packTip(b.gray, b.w, b.h);
        b.hardness = hardnessOf(b.gray, b.w, b.h);
        b.diameter = Math.max(b.w, b.h);
      }
      delete b.gray;
    });
    return { kind: kind, version: res.version, brushes: res.brushes };
  }

  global.ChaBrushImport = {
    parse: parse,
    parseAbr: function (buf) { return parseAbr(buf); },
    parseSut: function (buf) { return parseSut(buf); },
    packTip: packTip,
    unpackTip: unpackTip,
    hardnessOf: hardnessOf
  };
})(window);
