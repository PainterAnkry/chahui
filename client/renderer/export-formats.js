/**
 * 茶绘 · 导出格式
 *
 *   png   —— canvas 原生编码，保留 alpha
 *   jpg/jpeg —— canvas 原生，**没有 alpha**，所以先垫一层白底
 *   webp  —— canvas 原生（Chrome / Electron 都支持）
 *   bmp   —— 自己写：24 位、自下而上、每行按 4 字节补齐（浏览器不提供 BMP 编码）
 *   tga   —— 自己写：未压缩 32 位 BGRA、左上角原点（浏览器也不提供）
 *
 * 都返回 dataURL 字符串，这样能直接走既有的保存通路
 * （桌面端主进程会解析 `data:...;base64,` 把字节写进文件，网页端就是普通下载）。
 */
(function (global) {
  'use strict';

  var FORMATS = [
    { id: 'png', name: 'PNG（.png）', ext: 'png', mime: 'image/png', alpha: true, quality: false },
    { id: 'jpeg', name: 'JPEG（.jpg / .jpeg）', ext: 'jpg', mime: 'image/jpeg', alpha: false, quality: true },
    { id: 'webp', name: 'WebP（.webp）', ext: 'webp', mime: 'image/webp', alpha: true, quality: true },
    { id: 'bmp', name: 'BMP（.bmp，24 位）', ext: 'bmp', mime: 'image/bmp', alpha: false, quality: false },
    { id: 'tga', name: 'TGA（.tga，32 位）', ext: 'tga', mime: 'image/x-tga', alpha: true, quality: false }
  ];

  function byId(id) {
    for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].id === id) return FORMATS[i];
    return FORMATS[0];
  }

  function bytesToB64(bytes) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(out);
  }

  /** 把带 alpha 的画面垫到指定底色上（JPEG / BMP 用） */
  function flatten(canvas, bg) {
    var c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    var cx = c.getContext('2d');
    cx.fillStyle = bg || '#ffffff';
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(canvas, 0, 0);
    return c;
  }

  /** 24 位 BMP（自下而上，每行 4 字节对齐） */
  function encodeBMP(canvas, bg) {
    var src = flatten(canvas, bg);
    var w = src.width, h = src.height;
    var d = src.getContext('2d').getImageData(0, 0, w, h).data;
    var rowRaw = w * 3;
    var rowPad = (4 - (rowRaw % 4)) % 4;
    var rowSize = rowRaw + rowPad;
    var pixSize = rowSize * h;
    var off = 54;
    var buf = new Uint8Array(off + pixSize);
    var dv = new DataView(buf.buffer);
    buf[0] = 0x42; buf[1] = 0x4d;                        // 'BM'
    dv.setUint32(2, buf.length, true);
    dv.setUint32(10, off, true);
    dv.setUint32(14, 40, true);                          // BITMAPINFOHEADER
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);                            // 正数 = 自下而上
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, pixSize, true);
    dv.setInt32(38, 2835, true);                         // 72 DPI
    dv.setInt32(42, 2835, true);
    var p = off;
    for (var y = h - 1; y >= 0; y--) {
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        buf[p++] = d[o + 2]; buf[p++] = d[o + 1]; buf[p++] = d[o];
      }
      p += rowPad;
    }
    return 'data:image/bmp;base64,' + bytesToB64(buf);
  }

  /** 未压缩 32 位 TGA（BGRA，左上角原点） */
  function encodeTGA(canvas) {
    var w = canvas.width, h = canvas.height;
    var d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var buf = new Uint8Array(18 + w * h * 4);
    buf[2] = 2;                                          // 未压缩真彩色
    buf[12] = w & 0xff; buf[13] = (w >> 8) & 0xff;
    buf[14] = h & 0xff; buf[15] = (h >> 8) & 0xff;
    buf[16] = 32;                                        // 每像素 32 位
    buf[17] = 0x28;                                      // 左上角原点 + 8 位 alpha
    var p = 18;
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      buf[p++] = d[o + 2]; buf[p++] = d[o + 1]; buf[p++] = d[o]; buf[p++] = d[o + 3];
    }
    return 'data:image/x-tga;base64,' + bytesToB64(buf);
  }

  /**
   * @param canvas 要导出的画面
   * @param fmtId  FORMATS 里的 id
   * @param quality 0..1（只对 jpeg / webp 有效）
   * @returns dataURL
   */
  function encode(canvas, fmtId, quality) {
    var f = byId(fmtId);
    if (f.id === 'bmp') return encodeBMP(canvas);
    if (f.id === 'tga') return encodeTGA(canvas);
    var q = typeof quality === 'number' ? Math.max(0.1, Math.min(1, quality)) : 0.92;
    if (f.alpha) return canvas.toDataURL(f.mime, q);
    return flatten(canvas, '#ffffff').toDataURL(f.mime, q);
  }

  /**
   * 解码 BMP / TGA 回像素（只给测试与自检用，证明写出去的文件是能读回来的）。
   * @returns {w,h,data:Uint8ClampedArray}
   */
  function decodeBMP(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('不是 BMP');
    var off = dv.getUint32(10, true);
    var w = dv.getInt32(18, true);
    var h = dv.getInt32(22, true);
    var bpp = dv.getUint16(28, true);
    if (bpp !== 24) throw new Error('只支持 24 位 BMP，实际 ' + bpp);
    var bottomUp = h > 0;
    h = Math.abs(h);
    var rowSize = Math.floor((w * 3 + 3) / 4) * 4;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      var srcY = bottomUp ? h - 1 - y : y;
      var base = off + srcY * rowSize;
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        out[o] = bytes[base + x * 3 + 2];
        out[o + 1] = bytes[base + x * 3 + 1];
        out[o + 2] = bytes[base + x * 3];
        out[o + 3] = 255;
      }
    }
    return { w: w, h: h, data: out };
  }

  function b64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  global.ChaExport = {
    FORMATS: FORMATS,
    byId: byId,
    encode: encode,
    encodeBMP: encodeBMP,
    encodeTGA: encodeTGA,
    decodeBMP: function (bytes) { return decodeBMP(bytes instanceof Uint8Array ? bytes : b64ToBytes(bytes)); },
    b64ToBytes: b64ToBytes
  };
})(window);
