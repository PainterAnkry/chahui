/**
 * 茶绘 · 笔刷导入（Photoshop `.abr` / Clip Studio Paint `.sut` / Procreate `.brush` `.brushset`）
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
 *     文件本体就是一个 SQLite 库（头 16 字节 "SQLite format 3\0"），笔尖图以 blob 藏在
 *     表里（MaterialFile.FileData 是个 tar 包，成员才是真正的图）。提取分两路：
 *       ① tar 成员：扫 "ustar" 魔数按成员边界取图，成员名还能当笔名
 *         （thumbnail/ 这种名字不当笔名，但图照样收——有的笔尖就存在那）；
 *       ② 兜底裸扫 PNG 签名 → IEND（覆盖图不在 tar 成员头上的情况）。
 *     两路合并、按内容去重、逐张解码成灰度笔尖。**解不出来就跳过**——
 *     宁可少给一支，也绝不交付没有笔尖的笔（png 只存不解码的教训：导出来的全是圆头空壳）。
 *     一张内嵌图都没有时明确报错：是 SQLite → 「配置型 .sut」（笔尖引外部素材）；
 *     不是 SQLite → 多半是 SAI 的笔刷形状（裸灰度位图）。这两种暂不支持。
 *
 *     ⚠⚠ 两条**必须**守住的规则（都踩过坑，症状都是「导入的笔刷画出来是半个圆、不连成线」）：
 *     1. **缩略图不是笔尖。** 每个 material 里都带 thumbnail/thumbnail.png，那是素材库
 *        列表里的预览图（尺寸是显示尺寸，内容常是纯白/纯色底板）。拿它当笔尖 →
 *        笔刷变成 300px 大白块，盖章间隔一拉就是一堆不相连的半圆。
 *        所以 thumbnail/preview/icon 一律只当「兜底候选」，且纯色图除非别无选择不用。
 *     2. **尺寸和间距要读库里的真值，不能硬编码、更不能拿图片像素尺寸顶。**
 *        Node.NodeVariantID → Variant.VariantID 那一行里的 BrushSize（笔刷直径 px）和
 *        BrushInterval（占直径的百分比）才是真参数。老代码 spacing 写死 0.1、
 *        diameter 用图片尺寸，于是 1000px 的素材图直接变成 1000px 的笔刷。
 *        见 sutBrushMeta()；读不到时保守退回老行为，不瞎猜。
 *
 *     这张「方头纯度上色.sut」就是典型：Node 1 行（笔名）、Variant 2 行（一行真参数
 *     BrushSize=10 / BrushInterval=10，一行全 NULL 是模板）、MaterialFile 1 个 tar，
 *     内含 catalog.zip / info.zip / data/material_0.layer / thumbnail/thumbnail.png /
 *     icedata/layerData.xml。layerData.xml 的 systemtag 写着 `BrushPattern` + `Resizable`，
 *     说明它是「自制笔刷图案」类素材，笔尖=那张 300×300 的方头图案。
 *     （CSP 自己的 .zip/.layer 用的是 89 'C2F' 私有容器 + 自研压缩，这里不解它——
 *      没必要，参数从 Variant 读、图从 tar 成员里直接拿 PNG 就够了。）
 *
 * 位图压缩：0 = 原样，1 = PackBits。
 *
 *   Procreate（.brush 单支 / .brushset 一套 / .prbr）
 *     文件本身就是个 ZIP：
 *       Brush.archive          Apple 二进制 plist（NSKeyedArchiver），笔刷参数都在这
 *       Shape.png              笔尖形状（256×256 灰度）
 *       Grain.png              颗粒纹理（这个我们不用，见下）
 *       QuickLook/Thumbnail.png 缩略图
 *
 *     .brushset 里每支笔住一个子目录，各有一套上面这几样，
 *     而且 **archive 里的 bundledShapePath 可能是像 `shape.jpg` 这样的字符串文件名**
 *     （指向同一目录下的另一张图），也可能是不指定（那时才用默认的 Shape.png）。
 *     所以取图要按「archive 里给的名字 → 该目录下 → 整个 zip 里按基名找」三级兜底。
 *
 *     Procreate 的参数（SilicaBrush 类的字段）与茶绘的对应关系见 mapProcreate()，
 *     里面逐条写了换算依据。**Grain 位图不导入**：茶绘的 grain 是内置程序化纸纹，
 *     和 Procreate 那张 grain 图不是一回事，硬塞进去只会得到第三种纹理；
 *     这里只保留「这笔有颗粒」这个意图，落到 grain 强度上。
 *
 *     这一步需要自己实现 raw DEFLATE 解压、ZIP 目录解析、二进制 plist 解析、
 *     PNG 灰度解码 —— 因为解析器要在 Node 里裸跑（tools/abr-corpus.js 就这么加载的），
 *     用不了浏览器专有的 DecompressionStream / canvas。
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
  /** Pascal 字符串：n 字节长度前缀 + 字符（n=1 时长度按字节，Photoshop 的 .abr 用这种） */
  Reader.prototype.pascal = function (n) {
    var len = n === 1 ? this.u8() : this.u16();
    if (len > this.buf.length) throw new RangeError('字符串长度不合理：' + len);
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(this.buf[this.pos++]);
    return s;
  };
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

    // ISBN 6/7/9/10 —— 这才是真正在用的格式（市面上绝大多数 .abr 都是这一类）
    //
    // 字段顺序是拿真实文件校准出来的，别凭印象改：
    //   samp 块里，每一条 =
    //     u32 条目长度（4 字节对齐）
    //     Pascal 字符串（1 字节长度前缀）—— 内容通常是 GUID
    //     **次版本 1 跳 10 字节，次版本 2 跳 264 字节**   ← 这一步漏了就会满盘皆错
    //     i32 y · i32 x · i32 (y+h) · i32 (x+w)
    //     u16 位深（8 或 16）· u8 压缩（0 原样 / 1 RLE）· 位图
    //
    // 我第一版参照的那份实现只跳了 8 字节、而且把字符串当 unicode 读，
    // 结果在 17 个真实文件上一个都过不去 —— 所以现在有 tools/abr-corpus.js 拿真文件回归。
    if (version !== 6 && version !== 7 && version !== 9 && version !== 10) {
      throw new Error('不支持的 .abr 版本 ' + version);
    }
    var minor = r.u16();
    if (minor !== 1 && minor !== 2) {
      throw new Error('不支持的 .abr 次版本 ' + minor + '（只认 1 和 2）');
    }

    var found = false;
    while (r.left() >= 12) {
      if (r.ascii(4) !== '8BIM') break;
      var key = r.ascii(4);
      var size = r.u32();
      if (size > r.left() + 4) break;
      var end = r.pos + size;

      if (key === 'samp') {
        found = true;
        while (r.pos < end) {
          var brushLength = r.u32();
          while (brushLength & 3) brushLength++;        // 条目本身按 4 字节对齐
          var brushEnd = r.pos + brushLength;
          try {
            var id = r.pascal(1);
            r.skip(minor === 1 ? 10 : 264);
            var top = r.i32(), left = r.i32();
            var h = r.i32() - top;
            var w = r.i32() - left;
            if (w <= 0 || h <= 0 || w * h > 40000000) throw new Error('笔尖边界不合法 ' + w + '×' + h);
            var depth = r.u16();
            var comp = r.u8();
            var gray = new Uint8Array(w * h);
            if (depth === 8) {
              if (comp === 0) gray.set(r.bytes(w * h));
              else if (comp === 1) {
                var lens = [];
                for (var yy = 0; yy < h; yy++) lens.push(r.u16());
                for (var y2 = 0; y2 < h; y2++) gray.set(packBits(r.bytes(lens[y2]), w), y2 * w);
              } else throw new Error('不支持的压缩方式 ' + comp);
            } else if (depth === 16) {
              if (comp !== 0) throw new Error('16 位 + RLE 暂不支持');
              for (var k2 = 0; k2 < gray.length; k2++) gray[k2] = r.u16() >> 8;
            } else throw new Error('不支持的位深 ' + depth);

            out.push({ name: id, w: w, h: h, gray: gray, spacing: 0.1 });
          } catch (e) { /* 这一支坏了就跳过，别让整个文件打不开 */ }
          r.seek(Math.min(brushEnd, buf.length));
          if (brushEnd <= 0) break;
        }
      }

      // 块整体按 4 字节对齐（对齐量按声明的长度算，不是按绝对偏移）
      r.seek(Math.min(end + ((4 - (size % 4)) % 4), buf.length));
    }

    if (!found) throw new Error('这个 .abr 里没有 samp 块（可能是纯「计算笔刷」文件）');
    if (!out.length) throw new Error('samp 块里没解析出可用的笔尖');
    return { version: version, minor: minor, brushes: out };
  }

  /* ============================================================ .sut */

  var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  function isPngAt(bytes, i) {
    if (i < 0 || i + 8 > bytes.length) return false;
    for (var k = 0; k < 8; k++) if (bytes[i + k] !== PNG_SIG[k]) return false;
    return true;
  }

  /** 裸扫：PNG 签名 → IEND，返回 [{start,end}] */
  function findPngRanges(bytes) {
    var found = [];
    var i = 0;
    while (i < bytes.length - 8) {
      if (!isPngAt(bytes, i)) { i++; continue; }
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
      found.push({ start: i, end: end });
      i = end;
    }
    return found;
  }

  /** 扫 tar 成员（ustar 魔数在 +257）。CSP 把笔尖图用 tar 包着塞进 SQLite 的 blob。 */
  function findTarMembers(bytes) {
    var out = [];
    var i = 0;
    while (i + 512 <= bytes.length) {
      if (asciiOf(bytes, i + 257, 5) !== 'ustar') { i++; continue; }
      var name = asciiOf(bytes, i, 100).replace(/\0[\s\S]*$/, '');
      var prefix = asciiOf(bytes, i + 345, 155).replace(/\0[\s\S]*$/, '');
      if (prefix && name) name = prefix + '/' + name;
      var size = parseInt(asciiOf(bytes, i + 124, 12), 8);
      if (!(size >= 0)) size = 0;
      var start = i + 512;
      if (start + size > bytes.length) break;   // 尺寸坏掉就别再按它往前跳
      out.push({ name: name, start: start, size: size });
      i = start + Math.ceil(size / 512) * 512;
    }
    return out;
  }

  /** 内容级去重：同张图在库里常出现多次（mipmap / 多处引用） */
  function quickHash(b) {
    var h = b.length;
    var step = Math.max(1, (b.length / 32) | 0);
    for (var i = 0; i < b.length; i += step) h = ((((h << 5) - h) + b[i]) & 0xffffffff) >>> 0;
    return h;
  }

  /** tar 成员名 → 笔名。thumbnail/preview 这种不算名字，返回空走默认编号 */
  function tipNameFromPath(p) {
    if (!p) return '';
    var base = String(p).split('/').pop() || '';
    base = base.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
    if (!base || /^(thumbnail|thumb|preview|image|img)$/i.test(base)) return '';
    return base.slice(0, 24);
  }

  function sutUnsupportedMsg(bytes, why) {
    if (why === 'blank-only') {
      // 文件里有图，但只有一张空白预览缩略图 —— 真正的笔尖图案在 CSP 私有容器里
      // （material_*.layer 用 89 'C2F' 自研格式 + 自研压缩，解不出来）。
      // 这种必须**明确拒绝**：拿空白缩略图当笔尖会导出一支画不出东西的笔，
      // 用户看到的却是「导入成功了」（曾经就是这样，画出来一团白）。
      return '这支 CSP 笔刷的笔尖图案存在它自己的私有容器里（material_*.layer），茶绘解不开，'
        + '文件里只找得到一张空白的预览缩略图，拿它当笔尖只会画出一团白。'
        + '建议在 CSP 里把这支笔刷的笔尖导出成 PNG，或用内嵌标准素材的笔刷（如 Procreate / PS 笔刷）导入';
    }
    if (bytes.length >= 15 && asciiOf(bytes, 0, 15) === 'SQLite format 3') {
      return '这是 CSP 的「配置型」.sut：笔刷参数在库里，但笔尖引用的是外部素材，文件里没有内嵌笔尖图，茶绘暂时导不了这种；可以在 CSP 里换一支内嵌笔尖的笔刷导出再试';
    }
    return '这个 .sut 里没找到可用的笔尖图片——可能是 SAI 的笔刷形状文件（裸灰度位图，茶绘暂不支持），或文件已损坏';
  }

  // 记录格式：header 长度 varint + serial types + 值。取 int / text / blob。
  // （模块级：sqliteTableBlobs 用它解每行，测试也能直接打到它）
  function recordValues(pl) {
    function vint(p) {
      var v = 0, i, b;
      for (i = 0; i < 8; i++) {
        b = pl[p + i];
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) return { val: v, next: p + i + 1 };
      }
      return { val: v * 256 + pl[p + 8], next: p + 9 };
    }
    var h = vint(0);
    var types = [], p = h.next, t;
    while (p < h.val) { t = vint(p); types.push(t.val); p = t.next; }
    var out = [], q = h.val, i, n, val, k, ty;
    for (i = 0; i < types.length; i++) {
      ty = types[i];
      val = null; n = 0;
      if (ty >= 12 && ty % 2 === 0) { n = (ty - 12) / 2; val = pl.subarray(q, q + n); }
      else if (ty >= 13) {
        n = (ty - 13) / 2; val = '';
        for (k = 0; k < n; k++) val += String.fromCharCode(pl[q + k]);
      } else if (ty >= 1 && ty <= 6) {
        n = (ty === 1 ? 1 : ty === 2 ? 2 : ty === 3 ? 3 : ty === 4 ? 4 : ty === 5 ? 6 : 8);
        val = 0;
        var neg = (pl[q] & 0x80) !== 0;
        for (k = 0; k < n; k++) val = val * 256 + pl[q + k];
        if (neg) val -= Math.pow(256, n);
      } else if (ty === 7 || ty === 8 || ty === 9) { n = ty === 7 ? 8 : 0; val = ty === 9 ? 1 : 0; }
      /* 0 / 10 / 11 → NULL，n=0 */
      out.push(val);
      q += n;
    }
    return out;
  }

  /* ---------- 最小 SQLite 读取（只为把 blob 完整拼回来） ----------
   * CSP 的 .sut 是个 SQLite 库，大 blob（笔尖 tar 包）会跨「溢出页」存储：
   * 每个溢出页开头有 4 字节「下一页号」，所以**裸字节里的 PNG 是被切碎的**，
   * 签名扫出来也解不开（deflate 提前结束）。这里实现刚好够用的读取：
   * 表 btree 遍历 + 记录解析 + 溢出链拼接。不做 SQL、不管索引/空闲页。
   */
  function sqliteTableBlobs(bytes, wantTable) {
    var pageSize = (bytes[16] << 8) | bytes[17];
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error('SQLite 页大小不对');
    var usable = pageSize - bytes[20];
    if (usable < 480) throw new Error('SQLite 可用页大小不对');

    function u32(p) { return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; }
    function u16(p) { return (bytes[p] << 8) | bytes[p + 1]; }
    function varint(p) {
      var v = 0, i, b;
      for (i = 0; i < 8; i++) {
        b = bytes[p + i];
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) return { val: v, next: p + i + 1 };
      }
      return { val: v * 256 + bytes[p + 8], next: p + 9 };
    }
    function pageBase(n) { return (n - 1) * pageSize; }

    // 读一个 cell 的 payload；超过本地阈值的部分沿溢出链拼回来
    function readPayload(off, total) {
      var X = usable - 35;
      if (total <= X) return bytes.subarray(off, off + total);
      var M = (((usable - 12) * 32) / 255 - 23) | 0;
      var K = M + ((total - M) % (usable - 4));
      var local = K <= X ? K : M;
      var parts = [bytes.subarray(off, off + local)];
      var left = total - local;
      var next = u32(off + local);
      var guard = 0;
      while (next > 0 && left > 0 && guard++ < 100000) {
        if (next * pageSize > bytes.length) throw new Error('溢出链指向页外');
        var pb = pageBase(next);
        var take = Math.min(left, usable - 4);
        parts.push(bytes.subarray(pb + 4, pb + 4 + take));
        left -= take;
        next = u32(pb);
      }
      if (left > 0) throw new Error('溢出链提前结束');
      return concatBytes(parts);
    }

    // 遍历一张表 btree，对每个叶子行 payload 调 cb；单行坏不拖垮整表
    function walkTable(pageNo, cb, depth) {
      if (depth > 30 || pageNo < 1 || pageNo * pageSize > bytes.length) return;
      var base = pageBase(pageNo);
      var hdr = base + (pageNo === 1 ? 100 : 0);
      var type = bytes[hdr];
      var ncells = u16(hdr + 3);
      var i, cellPtr, off;
      if (type === 5) {                           // 内部页：孩子指针 + 最右指针
        cellPtr = hdr + 12;
        for (i = 0; i < ncells; i++) {
          off = base + u16(cellPtr + i * 2);
          walkTable(u32(off), cb, depth + 1);
        }
        walkTable(u32(hdr + 8), cb, depth + 1);
      } else if (type === 13) {                   // 表叶子页
        cellPtr = hdr + 8;
        for (i = 0; i < ncells; i++) {
          off = base + u16(cellPtr + i * 2);
          var pLen = varint(off);
          var rid = varint(pLen.next);
          try { cb(readPayload(rid.next, pLen.val)); } catch (e) { /* 跳过坏行 */ }
        }
      }
    }

    // 记录解析用模块级的 recordValues()

    // sqlite_master：type, name, tbl_name, rootpage, sql —— 找目标表的根页
    var root = 0;
    walkTable(1, function (row) {
      var cols = recordValues(row);
      if (cols.length >= 4 && cols[1] === wantTable && typeof cols[3] === 'number') root = cols[3];
    }, 0);
    if (!root) throw new Error('库里没有 ' + wantTable + ' 表');
    var blobs = [];
    walkTable(root, function (row) {
      var cols = recordValues(row);
      cols.forEach(function (c) {
        if (c && typeof c === 'object' && c.length > 0) blobs.push(c);   // Uint8Array = blob
      });
    }, 0);
    return blobs;
  }

  /* ---------- CSP 表读取（带列名） ----------
   * sqliteTableBlobs 只把 blob 掏出来，够用来找图，但**读不了数值参数**——
   * 于是 BrushSize / BrushInterval 这些白摆在库里没人看（曾经的锅：
   * 尺寸只能拿「找到的那张图的像素尺寸」硬顶，笔刷一导入就是错的粗细）。
   * 这里在上面那套遍历基础上补一份「列名 → 值」的读取：列名从 sqlite_master
   * 里那行 DDL 的 CREATE TABLE(...) 抠出来。拿不到列名时返回空数组，调用方自然退化成老行为。
   */
  function sqliteTableRows(bytes, wantTable) {
    var pageSize = (bytes[16] << 8) | bytes[17];
    if (pageSize === 1) pageSize = 65536;
    // bytes[20] 是「保留区大小」，绝大多数库是 0。夹具（手搓库）经常忘了写这个字段，
    // 一旦它是垃圾值，usable 就会小得离谱 → 整个读取静默失败。
    var reserved = bytes[20] <= 32 ? bytes[20] : 0;
    var usable = pageSize - reserved;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || usable < 480) throw new Error('SQLite 页大小不对');

    function u32(p) { return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; }
    function u16(p) { return (bytes[p] << 8) | bytes[p + 1]; }
    function varint(p) {
      var v = 0, i, b;
      for (i = 0; i < 8; i++) {
        b = bytes[p + i];
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) return { val: v, next: p + i + 1 };
      }
      return { val: v * 256 + bytes[p + 8], next: p + 9 };
    }
    function pageBase(n) { return (n - 1) * pageSize; }
    function readPayload(off, total) {
      var X = usable - 35;
      if (total <= X) return bytes.subarray(off, off + total);
      var M = (((usable - 12) * 32) / 255 - 23) | 0;
      var K = M + ((total - M) % (usable - 4));
      var local = K <= X ? K : M;
      var parts = [bytes.subarray(off, off + local)];
      var left = total - local, next = u32(off + local), guard = 0;
      while (next > 0 && left > 0 && guard++ < 100000) {
        var pb = pageBase(next), take = Math.min(left, usable - 4);
        parts.push(bytes.subarray(pb + 4, pb + 4 + take));
        left -= take; next = u32(pb);
      }
      if (left > 0) throw new Error('溢出链提前结束');
      return concatBytes(parts);
    }
    function walkTable(pageNo, cb, depth) {
      if (depth > 30 || pageNo < 1 || pageNo * pageSize > bytes.length) return;
      var base = pageBase(pageNo);
      var hdr = base + (pageNo === 1 ? 100 : 0);
      var type = bytes[hdr], ncells = u16(hdr + 3), i, cellPtr, off;
      if (type === 5) {
        cellPtr = hdr + 12;
        for (i = 0; i < ncells; i++) {
          off = base + u16(cellPtr + i * 2);
          walkTable(u32(off), cb, depth + 1);
        }
        walkTable(u32(hdr + 8), cb, depth + 1);
      } else if (type === 13) {
        cellPtr = hdr + 8;
        for (i = 0; i < ncells; i++) {
          off = base + u16(cellPtr + i * 2);
          var pLen = varint(off), rid = varint(pLen.next);
          try { cb(readPayload(rid.next, pLen.val)); } catch (e) { /* 跳过坏行 */ }
        }
      }
    }

    var root = 0, ddl = '';
    walkTable(1, function (row) {
      var cols = recordValues(row);
      if (cols.length >= 4 && cols[1] === wantTable) {
        if (typeof cols[3] === 'number') root = cols[3];
        if (typeof cols[4] === 'string') ddl = cols[4];
      }
    }, 0);
    if (!root) throw new Error('库里没有 ' + wantTable + ' 表');

    var names = cspColumnNames(ddl);
    var rows = [];
    walkTable(root, function (row) {
      var vals = recordValues(row);
      var o = {};
      for (var i = 0; i < vals.length; i++) o[names[i] || ('c' + i)] = vals[i];
      rows.push(o);
    }, 0);
    return rows;
  }

  /** 从 `CREATE TABLE X(a INTEGER, b TEXT, ...)` 里抠列名 */
  function cspColumnNames(ddl) {
    if (!ddl) return [];
    var open = ddl.indexOf('(');
    if (open < 0) return [];
    var depth = 0, end = ddl.length, k;
    for (k = open; k < ddl.length; k++) {
      if (ddl[k] === '(') depth++;
      else if (ddl[k] === ')') { depth--; if (!depth) { end = k; break; } }
    }
    return ddl.slice(open + 1, end).split(',').map(function (x) {
      return x.trim().split(/\s+/)[0];
    }).filter(function (x) {
      return x && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(x);
    });
  }

  /** 列里是不是 UTF-8 文本（recordValues 把 TEXT 解成了 latin1 码点） */
  function utf8FromLatin1(s) {
    if (typeof s !== 'string' || !s) return '';
    var out = '', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i) & 0xff;
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xc0 && c < 0xe0 && i + 1 < s.length) {
        out += String.fromCharCode(((c & 0x1f) << 6) | (s.charCodeAt(++i) & 0x3f));
      } else if (c >= 0xe0 && c < 0xf0 && i + 2 < s.length) {
        out += String.fromCharCode(((c & 0x0f) << 12) | ((s.charCodeAt(++i) & 0x3f) << 6) | (s.charCodeAt(++i) & 0x3f));
      } else out += '?';
    }
    return out;
  }

  function parseSut(buf) {
    var bytes = asBytes(buf);
    var cands = [];

    // 分类：'tip' = 可能是笔尖素材的图，'thumb' = 预览/缩略图（只能兜底用）
    function offer(name, data, role) { cands.push({ name: name, data: data, role: role || 'tip' }); }

    // ① 正路：走 SQLite 把 MaterialFile 的 blob 按溢出链拼回来（blob 是 tar，成员名可当笔名）
    //
    //    ⚠ 这里必须区分「素材本体」和「缩略图」：
    //    CSP 的每个 material tar 里都带 thumbnail/thumbnail.png，那只是**素材列表里的预览图**，
    //    尺寸是 300×300 之类的显示尺寸，内容还常常是纯白/纯色底板。
    //    曾经不分青红皂白把所有图都当笔尖收，结果就是拿缩略图当笔尖 →
    //    导入的笔刷变成一个 300px 的大白方块，画出来「半个圆、不连成线」。
    //    所以 thumbnail / preview 一律降级为 thumb，只有在找不到任何真素材时才拿来兜底。
    try {
      sqliteTableBlobs(bytes, 'MaterialFile').forEach(function (blob) {
        findTarMembers(blob).forEach(function (m) {
          if (m.size > 0 && isPngAt(blob, m.start)) {
            offer(m.name, blob.subarray(m.start, m.start + m.size), roleOfTarPath(m.name));
          }
        });
        findPngRanges(blob).forEach(function (r) {
          offer('', blob.subarray(r.start, r.end), 'tip');
        });
      });
    } catch (e) { /* 不是 SQLite / 没有该表 → 走兜底 */ }

    // ② 兜底：整文件裸扫。跨页切碎的 PNG 解码会失败、自动跳过；
    //    整段放进一页的小图、图不在 MaterialFile 表里的场合，靠这条路吃到。
    //    裸扫分不清哪些是缩略图，但已知这类文件里 thumbnail/ 的路径名也扫得到，所以同样判定。
    findTarMembers(bytes).forEach(function (m) {
      if (m.size > 0 && isPngAt(bytes, m.start)) {
        offer(m.name, bytes.subarray(m.start, m.start + m.size), roleOfTarPath(m.name));
      }
    });
    findPngRanges(bytes).forEach(function (r) {
      offer('', bytes.subarray(r.start, r.end), 'tip');
    });

    // 先真素材、后缩略图——同一个 seen 表，先到先得，于是缩略图天然被真素材挤掉
    cands.sort(function (a, b) { return (a.role === 'thumb' ? 1 : 0) - (b.role === 'thumb' ? 1 : 0); });

    var seen = {};
    var brushes = [];
    var sawBlank = false;      // 见过图、但都是空白（→ 用专门的报错文案）
    var sawAnyImage = false;
    cands.forEach(function (c) {
      var key = c.data.length + ':' + quickHash(c.data);
      if (seen[key]) return;
      seen[key] = 1;
      var img;
      try { img = decodePngGray(c.data); } catch (e) { return; }   // 解不出就跳过
      sawAnyImage = true;
      if (img.w < 4 || img.h < 4) return;                          // 太小的不可能是笔尖
      // 空白/纯色图不是笔尖形状：CSP 的预览缩略图常是白底 + 极淡角标，
      // 收下它只会得到一支画不出东西的笔（见 isFlatImage 注释）。
      if (isFlatImage(img)) { sawBlank = true; return; }
      brushes.push({
        name: tipNameFromPath(c.name),
        spacing: 0.1,
        gray: img.gray, w: img.w, h: img.h,
        png: c.data
      });
    });
    if (!brushes.length) {
      throw new Error(sutUnsupportedMsg(bytes, (sawBlank && sawAnyImage) ? 'blank-only' : ''));
    }

    // ③ 读真实参数：CSP 把这些摆在 Variant 表里，以前完全不看。
    //    拿到就用来改尺寸/间距，拿不到就维持老行为（不冒险猜）。
    var meta = sutBrushMeta(bytes);
    brushes.forEach(function (b, i) {
      // 笔名优先级：库里的真笔名（Node.NodeName）> tar 成员名 > 兜底。
      // ⚠ 反过来就错了：tar 成员名是 CSP 的内部素材名（data/material_0.png 之类），
      //   那是**资源的文件名**，不是笔刷名；拿它当笔名会让用户看到一头雾水的
      //   「material_0」。只有库里读不出名字时才退到成员名。
      var realName = meta && meta.name;
      if (realName) b.name = realName;
      else if (!b.name) b.name = 'CSP 笔刷 ' + (i + 1);
      if (!meta) return;
      // BrushInterval 是「占笔刷直径的百分比」（CSP 里 10 = 10%），茶绘的 spacing 同义 → 直接除 100。
      // 下限 0.02：再密下去只是在同一像素上反复盖章，白费性能。
      if (isFinite(meta.interval) && meta.interval > 0) {
        b.spacing = Math.max(0.02, Math.min(1, meta.interval / 100));
      }
      // 笔尖位图导入后是按「笔尖像素 × 缩放」盖章的，所以这里给一个**建议直径**。
      // BrushSize 是 CSP 笔刷的显示尺寸（px），比「图片像素尺寸」靠谱得多：
      // 素材图常有 1000px+ 的，直接照搬会让笔刷大得没法用。
      if (isFinite(meta.size) && meta.size > 0) b.diameter = meta.size;
      if (isFinite(meta.hardness)) b.hardnessHint = meta.hardness / 100;
      // 带「方头」性质的（BrushThickness 满、无柔边）不用额外处理——
      // 形状本来就在笔尖位图里，这里只是把软硬程度透传出去。
    });
    return { version: 0, brushes: brushes };
  }

  /** tar 成员路径 → 角色。thumbnail/preview 这类只是素材预览图，不当笔尖首选 */
  function roleOfTarPath(p) {
    if (!p) return 'tip';
    return /(^|\/)(thumbnail|thumb|preview|icon)s?\//i.test(String(p)) ? 'thumb' : 'tip';
  }

  /** 整张图几乎只有一个值 → 不是笔尖形状（空白板 / 纯色缩略图）
   *
   *  ⚠ 判定不能用「极差」：CSP 的预览缩略图常是**白底 + 极淡的角标/水印**，
   *  实测「方头纯度上色.sut」的 thumbnail 是 90000 像素里 89700 个纯白，
   *  剩 300 个浅浅的灰（176..191），极差 65 —— 用极差早就被骗过去了。
   *  可靠的做法是看**主色占比**：≥97% 的像素挤在很小的色域里就是「空白图」。
   */
  function isFlatImage(img) {
    var g = img.gray, n = img.w * img.h;
    if (!n) return true;
    // 用 16 档直方图找主峰，主峰占比 ≥97% 即视为空白/纯色
    var hist = new Array(16).fill(0);
    for (var i = 0; i < n; i++) hist[Math.min(15, g[i] >> 4)]++;
    var top = 0;
    for (var k = 0; k < 16; k++) if (hist[k] > top) top = hist[k];
    return top / n >= 0.97;
  }

  /* ---------- 从库里读 CSP 笔刷的真实参数 ----------
   * 位置：Node 表一行（笔刷名 + NodeVariantID）→ Variant 表用 VariantID 对应的一行。
   * 这张 .sut 就是「一支笔」的素材：Node 1 行、Variant 1 行有效（另一行是全 NULL 的模板）。
   * 一个文件里可能有多支笔（Node 多行），那时按行序与图片一一对应并不可靠，
   * 所以这里只在「恰好一支有效笔」时启用参数，多支时保守返回 null（宁可保持老行为也不乱配）。
   */
  function sutBrushMeta(bytes) {
    var variants, nodes;
    try {
      variants = sqliteTableRows(bytes, 'Variant');
      nodes = sqliteTableRows(bytes, 'Node');
    } catch (e) { return null; }

    function hasNum(r, k) { return r && typeof r[k] === 'number'; }
    // 有效 Variant：BrushSize 是个正经数值的那种（全 NULL 的那行是模板，跳过）
    var valid = (variants || []).filter(function (r) { return hasNum(r, 'BrushSize'); });
    if (valid.length !== 1) return null;
    var v = valid[0];

    var name = '';
    // 优先 Node 里 name 与这张 Variant 对得上的那行
    (nodes || []).forEach(function (n) {
      if (n && n.NodeVariantID === v.VariantID) name = utf8FromLatin1(n.NodeName) || name;
    });
    if (!name) {
      (nodes || []).some(function (n) {
        var t = utf8FromLatin1(n && n.NodeName);
        if (t) { name = t; return true; }
        return false;
      });
    }

    return {
      name: String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 24),
      size: v.BrushSize,
      interval: v.BrushInterval,
      // BrushHardness 是 0-100 的百分比，CSP 里 100 = 硬边
      hardness: typeof v.BrushHardness === 'number' ? v.BrushHardness : NaN,
      usePattern: v.BrushUsePatternImage === 1
    };
  }

  /* ============================================================ Procreate 底层 */
  //
  // Procreate 的 .brush/.brushset 是个 ZIP，里面的 Brush.archive 是 Apple 二进制 plist，
  // 笔尖是 PNG。这三样在浏览器里都有现成 API，但**都不能用**：
  //   · DecompressionStream 是异步的，而 parse() 整条链路是同步的
  //   · canvas / Image 解 PNG 同样是异步，而且在 Node 里根本不存在
  // 解析器要在 Node 里裸跑（tools/abr-corpus.js 与 procreate-corpus.js 都这么加载它），
  // 所以下面四个东西全是手写的同步实现。

  /* ---------- raw DEFLATE（RFC 1951） ---------- */

  function BitReader(src) {
    this.src = src; this.pos = 0; this.buf = 0; this.cnt = 0;
  }
  BitReader.prototype.bits = function (n) {
    while (this.cnt < n) {
      if (this.pos >= this.src.length) throw new Error('deflate 数据提前结束');
      this.buf |= this.src[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    var v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  };
  BitReader.prototype.align = function () { this.buf = 0; this.cnt = 0; };

  /** 规范化 Huffman 表：只用码长，解的时候一位一位走（zlib 的 puff 就是这么干的） */
  function buildHuff(lengths) {
    var MAXBITS = 15;
    var count = new Array(MAXBITS + 1);
    for (var b = 0; b <= MAXBITS; b++) count[b] = 0;
    for (var i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    var offs = new Array(MAXBITS + 2);
    offs[1] = 0;
    for (var l = 1; l <= MAXBITS; l++) offs[l + 1] = offs[l] + count[l];
    var symbols = new Array(lengths.length);
    for (var s = 0; s < lengths.length; s++) {
      if (lengths[s]) symbols[offs[lengths[s]]++] = s;
    }
    return { count: count, symbols: symbols };
  }

  function decodeSym(br, huff) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= 15; len++) {
      code |= br.bits(1);
      var cnt = huff.count[len];
      if (code - first < cnt) return huff.symbols[index + (code - first)];
      index += cnt;
      first = (first + cnt) << 1;
      code <<= 1;
    }
    throw new Error('deflate 里出现非法 Huffman 码');
  }

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
    67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385,
    513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  var FIXED_LIT = null, FIXED_DIST = null;
  function fixedTables() {
    if (FIXED_LIT) return;
    var l = new Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildHuff(l);
    var d = new Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    FIXED_DIST = buildHuff(d);
  }

  /** 动态 Huffman 块的两张表 */
  function readDynamic(br) {
    var hlit = br.bits(5) + 257;
    var hdist = br.bits(5) + 1;
    var hclen = br.bits(4) + 4;
    var clLens = new Array(19);
    for (var z = 0; z < 19; z++) clLens[z] = 0;
    for (var i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = br.bits(3);
    var clHuff = buildHuff(clLens);

    var total = hlit + hdist;
    var lens = new Array(total);
    var n = 0;
    while (n < total) {
      var sym = decodeSym(br, clHuff);
      if (sym < 16) {
        lens[n++] = sym;
      } else if (sym === 16) {
        if (n === 0) throw new Error('deflate 码长重复但前面没有可复制的');
        var prev = lens[n - 1];
        var rep = 3 + br.bits(2);
        while (rep-- > 0 && n < total) lens[n++] = prev;
      } else if (sym === 17) {
        var r17 = 3 + br.bits(3);
        while (r17-- > 0 && n < total) lens[n++] = 0;
      } else {
        var r18 = 11 + br.bits(7);
        while (r18-- > 0 && n < total) lens[n++] = 0;
      }
    }
    var litLens = lens.slice(0, hlit);
    var distLens = lens.slice(hlit);
    var anyDist = false;
    for (var k = 0; k < distLens.length; k++) if (distLens[k]) { anyDist = true; break; }
    if (!anyDist) distLens = [1, 1];       // 全 0 的表没法建，补一个占位
    return { lit: buildHuff(litLens), dist: buildHuff(distLens) };
  }

  /**
   * 解 raw DEFLATE（没有 zlib 头的那种）。
   * @param {Uint8Array} src
   * @param {number} [expectedSize] 已知输出大小时预分配，省掉反复扩容
   */
  function inflateRaw(src, expectedSize) {
    fixedTables();
    var br = new BitReader(src);
    var out = new Uint8Array(expectedSize > 0 ? expectedSize : Math.max(4096, src.length * 4));
    var o = 0;
    function ensure(n) {
      if (o + n <= out.length) return;
      var cap = out.length || 4096;
      while (cap < o + n) cap *= 2;
      var next = new Uint8Array(cap);
      next.set(out.subarray(0, o));
      out = next;
    }
    var last = 0;
    do {
      last = br.bits(1);
      var type = br.bits(2);
      if (type === 0) {
        br.align();
        if (br.pos + 4 > src.length) throw new Error('deflate 存储块不完整');
        var len = src[br.pos] | (src[br.pos + 1] << 8);
        var nlen = src[br.pos + 2] | (src[br.pos + 3] << 8);
        br.pos += 4;
        if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error('deflate 存储块长度校验失败');
        if (br.pos + len > src.length) throw new Error('deflate 存储块数据越界');
        ensure(len);
        out.set(src.subarray(br.pos, br.pos + len), o);
        o += len; br.pos += len;
      } else if (type === 1 || type === 2) {
        var litH, distH;
        if (type === 1) { litH = FIXED_LIT; distH = FIXED_DIST; }
        else { var t = readDynamic(br); litH = t.lit; distH = t.dist; }
        for (;;) {
          var sym = decodeSym(br, litH);
          if (sym < 256) { ensure(1); out[o++] = sym; continue; }
          if (sym === 256) break;
          var li = sym - 257;
          if (li >= 29) throw new Error('deflate 长度码越界');
          var length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          var ds = decodeSym(br, distH);
          if (ds >= 30) throw new Error('deflate 距离码越界');
          var dist = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          if (dist > o) throw new Error('deflate 回溯距离越界');
          ensure(length);
          for (var q = 0; q < length; q++) { out[o] = out[o - dist]; o++; }
        }
      } else {
        throw new Error('deflate 块类型 3 非法');
      }
    } while (!last);
    return out.subarray(0, o);
  }

  /* ---------- ZIP（只读，认中央目录） ---------- */

  function u32le(b, p) {
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
  function uNbe(b, p, n) {
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + b[p + i];
    return v;
  }
  function asciiOf(b, p, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
    return s;
  }
  function utf8Of(b) {
    if (typeof TextDecoder === 'function') {
      try { return new TextDecoder('utf-8').decode(b); } catch (e) { /* 退到手工解 */ }
    }
    var s = '', i = 0;
    while (i < b.length) {
      var c = b[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
      else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
      else {
        var cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  /**
   * 读一个 ZIP 的条目清单（名字 + 解压后的字节）。
   * 走中央目录而不是顺序扫本地头 —— 本地头里遇到「数据描述符」时长度是 0，
   * 顺着扫会直接跑飞；中央目录里的长度一定是真的。
   */
  function readZip(bytes) {
    var eocd = -1;
    var back = Math.min(bytes.length, 66000);
    for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - back; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i; break;
      }
    }
    if (eocd < 0) throw new Error('不是 ZIP（找不到中央目录结尾）');
    var count = bytes[eocd + 10] | (bytes[eocd + 11] << 8);
    var cdOff = u32le(bytes, eocd + 16);
    if (cdOff >= bytes.length) throw new Error('ZIP 中央目录位置越界');

    var entries = [];
    var p = cdOff;
    for (var k = 0; k < count; k++) {
      if (p + 46 > bytes.length) break;
      if (!(bytes[p] === 0x50 && bytes[p + 1] === 0x4b && bytes[p + 2] === 0x01 && bytes[p + 3] === 0x02)) break;
      var method = bytes[p + 10] | (bytes[p + 11] << 8);
      var compSize = u32le(bytes, p + 20);
      var uncompSize = u32le(bytes, p + 24);
      var nameLen = bytes[p + 28] | (bytes[p + 29] << 8);
      var extraLen = bytes[p + 30] | (bytes[p + 31] << 8);
      var cmtLen = bytes[p + 32] | (bytes[p + 33] << 8);
      var localOff = u32le(bytes, p + 42);
      var name = utf8Of(bytes.subarray(p + 46, p + 46 + nameLen));

      if (localOff + 30 > bytes.length) throw new Error('ZIP 本地头越界：' + name);
      // 本地头里的 name/extra 长度**可能和中央目录不一样**，必须重新读一遍
      var lNameLen = bytes[localOff + 26] | (bytes[localOff + 27] << 8);
      var lExtraLen = bytes[localOff + 28] | (bytes[localOff + 29] << 8);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > bytes.length) throw new Error('ZIP 条目数据越界：' + name);
      var raw = bytes.subarray(dataStart, dataStart + compSize);

      var data;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRaw(raw, uncompSize);
      else throw new Error('ZIP 用了不支持的压缩方式 ' + method + '：' + name);
      if (!/\/$/.test(name)) entries.push({ name: name, data: data });

      p += 46 + nameLen + extraLen + cmtLen;
    }
    if (!entries.length) throw new Error('ZIP 里没有任何文件');
    return { entries: entries };
  }

  /* ---------- Apple 二进制 plist + NSKeyedArchiver ---------- */

  function readBplist(bytes) {
    if (asciiOf(bytes, 0, 8) !== 'bplist00') throw new Error('不是二进制 plist');
    var offSize = bytes[bytes.length - 26];
    var refSize = bytes[bytes.length - 25];
    var numObjects = uNbe(bytes, bytes.length - 24, 8);
    var topObject = uNbe(bytes, bytes.length - 16, 8);
    var tableOff = uNbe(bytes, bytes.length - 8, 8);
    if (numObjects <= 0 || numObjects > 1000000) throw new Error('plist 对象数不合理：' + numObjects);

    var offsets = new Array(numObjects);
    for (var k = 0; k < numObjects; k++) offsets[k] = uNbe(bytes, tableOff + k * offSize, offSize);

    var cache = new Array(numObjects);

    function readLen(p, info) {
      if (info !== 15) return { len: info, next: p };
      var m = bytes[p];
      if ((m >> 4) !== 1) throw new Error('plist 长度标记不是整数');
      var n = 1 << (m & 15);
      return { len: uNbe(bytes, p + 1, n), next: p + 1 + n };
    }

    function objAt(idx) {
      if (idx < 0 || idx >= numObjects) throw new Error('plist 对象下标越界：' + idx);
      if (cache[idx] !== undefined) return cache[idx];
      var off = offsets[idx];
      if (off >= bytes.length) throw new Error('plist 对象偏移越界');
      var marker = bytes[off];
      var type = marker >> 4, info = marker & 15;
      var p = off + 1;
      var v;

      if (type === 0x0) {
        v = info === 0x08 ? false : (info === 0x09 ? true : null);
      } else if (type === 0x1) {
        if (info > 4) throw new Error('plist 整数长度不支持：' + info);
        v = uNbe(bytes, p, 1 << info);
      } else if (type === 0x2) {
        var rn = 1 << info;
        if (rn === 4) {
          var dv = new DataView(bytes.buffer, bytes.byteOffset + p, 4);
          v = dv.getFloat32(0, false);
        } else if (rn === 8) {
          var dv8 = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
          v = dv8.getFloat64(0, false);
        } else v = 0;
      } else if (type === 0x3) {
        var dv3 = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
        v = dv3.getFloat64(0, false);
      } else if (type === 0x4) {
        var r4 = readLen(p, info);
        v = bytes.slice(r4.next, r4.next + r4.len);
      } else if (type === 0x5) {
        var r5 = readLen(p, info);
        v = asciiOf(bytes, r5.next, r5.len);
      } else if (type === 0x6) {
        var r6 = readLen(p, info);
        var s6 = '';
        for (var u = 0; u < r6.len; u++) s6 += String.fromCharCode((bytes[r6.next + u * 2] << 8) | bytes[r6.next + u * 2 + 1]);
        v = s6;
      } else if (type === 0x8) {
        v = { __uid: uNbe(bytes, p, info + 1) };
      } else if (type === 0xa || type === 0xc) {
        var rA = readLen(p, info);
        var arr = [];
        for (var a = 0; a < rA.len; a++) arr.push(objAt(uNbe(bytes, rA.next + a * refSize, refSize)));
        v = arr;
      } else if (type === 0xd) {
        var rD = readLen(p, info);
        var d = {};
        for (var q = 0; q < rD.len; q++) {
          var kRef = uNbe(bytes, rD.next + q * refSize, refSize);
          var vRef = uNbe(bytes, rD.next + (rD.len + q) * refSize, refSize);
          d[String(objAt(kRef))] = objAt(vRef);
        }
        v = d;
      } else {
        v = null;
      }
      cache[idx] = v;
      return v;
    }

    var root = objAt(topObject);
    if (!root || typeof root !== 'object') throw new Error('plist 根对象不是字典');
    var objects = root.$objects;
    if (!objects || !objects.length) throw new Error('plist 里没有 $objects');
    return { root: root, objects: objects };
  }

  /**
   * 把 NSKeyedArchiver 的图展开成普通对象：UID 就是 $objects 的下标。
   * 深度封顶，防住自引用（真文件里没见过，但不想为此卡死）。
   */
  function resolveArchive(root, objects) {
    function res(v, depth) {
      if (v && typeof v === 'object' && typeof v.__uid === 'number') {
        if (depth > 12) return null;
        var i = v.__uid;
        if (i < 0 || i >= objects.length) return null;
        return res(objects[i], depth + 1);
      }
      if (Array.isArray(v)) {
        var arr = [];
        for (var a = 0; a < v.length; a++) arr.push(res(v[a], depth + 1));
        return arr;
      }
      if (v && typeof v === 'object') {
        var o = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = res(v[k], depth + 1);
        return o;
      }
      return v;
    }
    var top = root.$top && root.$top.root;
    return res(top, 0);
  }

  /* ---------- PNG → 灰度 ---------- */

  var PNG_SIG8 = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  function isPng(b) {
    if (!b || b.length < 8) return false;
    for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG8[i]) return false;
    return true;
  }

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  /**
   * 把 PNG 解成灰度数组（0=透明/无墨，255=全墨）。
   * 只支持非隔行的 8/16 位；1/2/4 位与 Adam7 都是笔尖里见不到的东西，
   * 遇到就明确报错，不猜。
   */
  function decodePngGray(bytes) {
    if (!isPng(bytes)) throw new Error('不是 PNG 图片');
    var p = 8, ihdr = null, idat = [], plte = null, trns = null;
    while (p + 8 <= bytes.length) {
      // 注意：PNG 的长度是**大端**（ZIP 才是小端），这里别串了
      var len = uNbe(bytes, p, 4);
      var type = asciiOf(bytes, p + 4, 4);
      var d = bytes.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        ihdr = { w: uNbe(d, 0, 4), h: uNbe(d, 4, 4), depth: d[8], color: d[9], interlace: d[12] };
      } else if (type === 'IDAT') idat.push(d);
      else if (type === 'PLTE') plte = d;
      else if (type === 'tRNS') trns = d;
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    if (!ihdr) throw new Error('PNG 缺少 IHDR');
    if (!idat.length) throw new Error('PNG 缺少 IDAT');
    if (ihdr.interlace) throw new Error('暂不支持隔行（Adam7）PNG');
    var w = ihdr.w, h = ihdr.h, depth = ihdr.depth, color = ihdr.color;
    if (depth !== 8 && depth !== 16) throw new Error('暂不支持 ' + depth + ' 位的 PNG');
    var ch;
    if (color === 0) ch = 1; else if (color === 2) ch = 3; else if (color === 3) ch = 1;
    else if (color === 4) ch = 2; else if (color === 6) ch = 4;
    else throw new Error('不认识的 PNG 色彩类型 ' + color);
    if (color === 3 && depth !== 8) throw new Error('调色板 PNG 只支持 8 位');
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) throw new Error('PNG 尺寸不合理 ' + w + 'x' + h);

    var sampleBytes = ch * (depth / 8);
    var rowBytes = w * sampleBytes;
    // IDAT 拼起来是 **zlib 流**（2 字节头 + 裸 deflate + 4 字节 Adler-32），
    // 跟 ZIP 条目里的裸 deflate 不是一回事，头要去掉（尾部校验直接不管）。
    var zlib = concatBytes(idat);
    if (zlib.length < 2) throw new Error('PNG 的 IDAT 太短');
    if ((zlib[0] & 0x0f) !== 8) throw new Error('PNG 的 IDAT 不是 deflate 压缩');
    if (((zlib[0] << 8) | zlib[1]) % 31 !== 0) throw new Error('PNG 的 IDAT zlib 头校验失败');
    var zOff = (zlib[1] & 0x20) ? 6 : 2;          // FDICT 时后面还有 4 字节字典 id
    var raw = inflateRaw(zlib.subarray(zOff), (rowBytes + 1) * h);
    if (raw.length < (rowBytes + 1) * h) throw new Error('PNG 像素数据不完整');

    // 反滤波：逐行去掉 PNG 的 5 种滤波
    var img = new Uint8Array(rowBytes * h);
    for (var y = 0; y < h; y++) {
      var ft = raw[y * (rowBytes + 1)];
      var line = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
      var cur = img.subarray(y * rowBytes, (y + 1) * rowBytes);
      var prev = y > 0 ? img.subarray((y - 1) * rowBytes, y * rowBytes) : null;
      for (var x = 0; x < rowBytes; x++) {
        var a = x >= sampleBytes ? cur[x - sampleBytes] : 0;
        var bb = prev ? prev[x] : 0;
        var c = (prev && x >= sampleBytes) ? prev[x - sampleBytes] : 0;
        var val = line[x];
        if (ft === 1) val += a;
        else if (ft === 2) val += bb;
        else if (ft === 3) val += (a + bb) >> 1;
        else if (ft === 4) val += paeth(a, bb, c);
        else if (ft !== 0) throw new Error('PNG 滤波类型非法 ' + ft);
        cur[x] = val & 0xff;
      }
    }

    // 取灰度。16 位只取高字节。
    var step = depth === 16 ? 2 : 1;
    var gray = new Uint8Array(w * h);
    var alphaSeen = false;
    for (var i = 0; i < w * h; i++) {
      var base = i * sampleBytes;
      var g, al = 255;
      if (color === 0) {
        g = img[base];
      } else if (color === 4) {
        g = img[base]; al = img[base + step];
      } else if (color === 2) {
        g = (img[base] * 299 + img[base + step] * 587 + img[base + step * 2] * 114) / 1000;
      } else if (color === 6) {
        g = (img[base] * 299 + img[base + step] * 587 + img[base + step * 2] * 114) / 1000;
        al = img[base + step * 3];
      } else {                       // 调色板
        var pi = img[base] * 3;
        g = (plte[pi] * 299 + plte[pi + 1] * 587 + plte[pi + 2] * 114) / 1000;
        if (trns) al = img[base] < trns.length ? trns[img[base]] : 255;
      }
      if (al !== 255) alphaSeen = true;
      gray[i] = Math.max(0, Math.min(255, Math.round(g)));
      if (al !== 255) gray[i] = Math.round(gray[i] * al / 255);
    }

    // 笔尖图常见「形状画在 alpha 通道里、RGB 全白」。
    // 那种图按亮度取出来是一整块实心方砖，必须改用 alpha。
    if (alphaSeen && (color === 4 || color === 6)) {
      var lumRange = 0, mn = 255, mx = 0;
      for (var s = 0; s < gray.length; s++) { if (gray[s] < mn) mn = gray[s]; if (gray[s] > mx) mx = gray[s]; }
      lumRange = mx - mn;
      if (lumRange < 8) {
        for (var s2 = 0; s2 < w * h; s2++) {
          gray[s2] = color === 4 ? img[s2 * sampleBytes + step] : img[s2 * sampleBytes + step * 3];
        }
      }
    }
    return { w: w, h: h, gray: gray };
  }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  /* ============================================================ Procreate */

  /** archive 里的路径引用：真值是字符串文件名，'$null' / 空 表示没指定 */
  function refName(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s || s === '$null') return '';
    return s;
  }

  function baseName(p) {
    return String(p).replace(/\\/g, '/').replace(/^.*\//, '');
  }

  /** 在 zip 里找一张图：先按 archive 给的名字，再按同目录基名，最后按目录里的 shape */
  function findImageEntry(zip, dir, want, kindRe) {
    var entries = zip.entries, i;
    if (want) {
      var wantBase = baseName(want);
      for (i = 0; i < entries.length; i++) if (entries[i].name === dir + want) return entries[i];
      for (i = 0; i < entries.length; i++) if (baseName(entries[i].name) === wantBase) return entries[i];
      for (i = 0; i < entries.length; i++) if (baseName(entries[i].name).toLowerCase() === wantBase.toLowerCase()) return entries[i];
    }
    // 退到目录里第一个名字像 shape 的图（不要 grain / thumbnail）
    for (i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (dir && n.indexOf(dir) !== 0) continue;
      var b = baseName(n);
      if (!/\.(png|jpg|jpeg)$/i.test(b)) continue;
      if (/thumbnail/i.test(b)) continue;
      if (kindRe.test(b)) return entries[i];
    }
    return null;
  }

  /**
   * 一支 Procreate 笔的 archive → 茶绘笔刷参数。
   *
   * 逐条对应关系（左 = Procreate 的 SilicaBrush 字段，右 = 茶绘的笔刷参数）：
   *   plotSpacing          → spacing        两边都是「落点间隔 ÷ 直径」，直接搬
   *   minSize / maxSize    → minSize        笔压最轻时的直径比例
   *   dynamicsPressureSize → pressSize      压力→直径 的权重
   *   dynamicsPressureOpacity → pressOpacity 压力→浓度 的权重
   *   maxOpacity           → opacity        浓度上限
   *   plotJitter           → scatter        路径抖动，都是「随机偏离路径」
   *   dynamicsMix          → mix            湿混 → 混色
   *   textureScale         → grainScale     颗粒粗细（换算见下）
   *   是否有 grain 图      → grain          只搬「这笔有颗粒」的意图，不搬那张图
   *   paintSize            → size           只是个提示（见下）
   *
   * 搬不过来/故意不搬的：plotSmoothing（茶绘的手抖修正是全局设置，不是每支笔的）、
   * taper*（锥度）、shapeScatter/oriented（形状随机旋转/随方向）、blendMode
   * （Procreate 那套枚举值没有可靠对照表，宁可不猜）、以及三组 erase/smudge 参数
   * （那是橡皮/涂抹的，不是画笔的）。
   */
  function mapProcreate(rec, shape) {
    function num(k, d) {
      var v = rec[k];
      return (typeof v === 'number' && isFinite(v)) ? v : d;
    }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    var maxSize = clamp(num('maxSize', 1), 0.02, 1);
    var minSizeRaw = clamp(num('minSize', 0), 0, 1);
    var minSize = clamp(maxSize > 0 ? minSizeRaw / maxSize : minSizeRaw, 0.02, 1);
    var hasGrain = !!shape.grainFound;

    return {
      size: Math.round(clamp(10 + num('paintSize', 0.2) * 110, 6, 200)),
      opacity: clamp(num('maxOpacity', 1), 0.02, 1),
      hardness: shape.hardness,
      minSize: minSize,
      pressSize: clamp(num('dynamicsPressureSize', 0.5), 0, 1),
      pressOpacity: clamp(num('dynamicsPressureOpacity', 0), 0, 1),
      scatter: clamp(num('plotJitter', 0), 0, 1),
      mix: clamp(num('dynamicsMix', 0), 0, 1),
      // textureScale 越大颗粒越粗，和 grainScale 同向；系数是看着合理挑的
      grainScale: clamp(0.5 + num('textureScale', 0.3) * 1.6, 0.2, 4),
      // 茶绘的 grain 是内置程序化纸纹，与 Procreate 那张 grain 位图不是同一张图。
      // 给 0 的话铅笔会变成一支塑料笔；给满又太脏，取一个中等偏轻的量。
      grain: hasGrain ? 0.3 : 0,
      spacing: clamp(num('plotSpacing', 0.1), 0.02, 1)
    };
  }

  /**
   * 解析 .brush / .brushset / .prbr。
   * .brushset 里每支笔住一个子目录；.brush 只有一支、archive 就在根上。
   */
  function parseProcreate(buf) {
    var bytes = asBytes(buf);
    var zip = readZip(bytes);

    var archives = zip.entries.filter(function (e) { return /(^|\/)Brush\.archive$/i.test(e.name); });
    if (!archives.length) throw new Error('这个文件里没有 Brush.archive（可能不是 Procreate 笔刷）');

    var out = [];
    archives.forEach(function (a) {
      var dir = a.name.replace(/[^/]*$/, '');          // 含结尾斜杠，根目录时为空串
      var rec = null, why = '';
      try {
        var pl = readBplist(a.data);
        rec = resolveArchive(pl.root, pl.objects);
      } catch (e) {
        why = e.message;
      }
      // 目录名兜底当笔名：.brushset 里就是这样一圈套一圈的
      var fallbackName = baseName(dir.replace(/\/$/, '')) || 'Procreate 笔刷';

      var shapeEntry = findImageEntry(zip, dir, rec ? refName(rec.bundledShapePath) : '', /shape/i);
      if (!shapeEntry) throw new Error('找不到笔尖形状图（' + (why || 'archive 里没写，目录里也没有像 shape 的图') + '）');

      var img = decodePngGray(shapeEntry.data);
      var pack = packTip(img.gray, img.w, img.h);
      var shape = {
        tip: pack,
        hardness: hardnessOf(img.gray, img.w, img.h),
        grainFound: !!findImageEntry(zip, dir, rec ? refName(rec.bundledGrainPath) : '', /grain|texture/i)
      };

      var opts = mapProcreate(rec || {}, shape);
      out.push({
        name: (rec && typeof rec.name === 'string' && rec.name) ? rec.name : fallbackName,
        w: img.w, h: img.h,
        tip: shape.tip,
        hardness: shape.hardness,
        diameter: opts.size,
        spacing: opts.spacing,
        opts: opts
      });
    });

    if (!out.length) throw new Error('没能从这个文件里解析出笔刷');
    return { kind: 'procreate', version: 0, brushes: out };
  }

  /* ============================================================ 笔尖打包 */

  var TIP_SIZE = 48;      // 打包后的边长
  var TIP_BITS = 4;       // 每像素 4 位 → 48×48 是 1152 字节，base64 约 1536 字符；\n                          // 32×32 对树皮 / 皮肤这类纹理笔刷太糊了

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
   * 从笔尖估「边缘硬度」（0.05 极柔 … 1 硬边）。
   *
   * 要量的是**过渡带有多宽**，而不是「亮度掉到一半的位置」——后者对硬边圆盘
   * 和线性柔边会给出几乎一样的数（实测都是 0.63），等于没测。
   *
   * 但也不能按半径取环平均：Procreate 的马克笔笔尖是个 2:1 的**凿形椭圆**
   * （116×58），环平均会把斜方向的空白混进来，一条硬边被抹成缓坡，
   * 硬度直接掉到下限 0.05。方笔、凿形笔这些非圆笔尖在 .abr 里同样常见。
   *
   * 所以改用**面积等效半径**，和形状圆不圆无关：
   *   r50 = √(面积@50% / π)   r90 = √(面积@90% / π)
   *   soft = (r50 - r90) / r50        ← 过渡带占「等效半径」的比例
   *   hardness = 1 - soft × 5
   *
   * 拿合成图校准过（256×256 圆盘，羽化 = 边缘过渡像素数）：
   *   硬边(0.5) → soft 0.001   羽化 16 → 0.061   羽化 32 → 0.133
   * 椭圆 116×58 同羽化下的 soft 与圆盘一致，说明这个度量确实与形状无关。
   */
  function hardnessOf(gray, w, h) {
    var mx = 0;
    for (var i = 0; i < gray.length; i++) if (gray[i] > mx) mx = gray[i];
    if (mx <= 2) return 0.5;                       // 整张几乎是空的，说不清

    var a90 = 0, a50 = 0;
    for (var k = 0; k < gray.length; k++) {
      var v = gray[k];
      if (v >= mx * 0.9) a90++;
      else if (v >= mx * 0.5) a50++;
    }
    if (a90 + a50 === 0) return 1;                 // 只有零星像素够亮，当作硬点
    var r50 = Math.sqrt((a90 + a50) / Math.PI);
    var r90 = Math.sqrt(a90 / Math.PI);
    var soft = r50 > 0 ? (r50 - r90) / r50 : 0;
    return Math.max(0.05, Math.min(1, 1 - soft * 5));
  }

  /* ============================================================ 统一出口 */

  /**
   * 解析一个笔刷文件。
   * @returns {{kind:'abr'|'sut'|'procreate', version:number,
   *            brushes:[{name,w,h,gray?,png?,spacing,tip,hardness?,diameter?,opts?}]}}
   */
  function parse(fileName, buf) {
    var bytes = asBytes(buf);
    var name = String(fileName || '').toLowerCase();
    var res, kind;

    if (/\.(brush|brushset|prbr)$/.test(name)) {
      res = parseProcreate(bytes); kind = 'procreate';
    } else if (/\.abr$/.test(name)) {
      res = parseAbr(bytes); kind = 'abr';
    } else if (/\.sut$/.test(name)) {
      res = parseSut(bytes); kind = 'sut';
    } else {
      // 后缀不可信时按内容猜：
      //   'PK'      → ZIP，多半是 Procreate（.brushset 常常被人改名叫 .zip）
      //   0x00 + 版本号 → .abr
      //   其余      → 按 .sut 试（CSP 的库文件没有稳定签名）
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        res = parseProcreate(bytes); kind = 'procreate';
      } else if (bytes[0] === 0 && (bytes[1] === 1 || bytes[1] === 2 || bytes[1] === 6 || bytes[1] === 7 || bytes[1] === 10)) {
        res = parseAbr(bytes); kind = 'abr';
      } else {
        res = parseSut(bytes); kind = 'sut';
      }
    }

    res.brushes.forEach(function (b, i) {
      if (!b.name) b.name = '笔刷 ' + (i + 1);
      // Procreate 那条路已经自己算好 tip/hardness/diameter 了，只有 gray 才需要补算
      if (b.gray) {
        b.tip = packTip(b.gray, b.w, b.h);
        // ⚠ 顺序要紧：hardnessOf / 兜底 diameter 都要用**源图**尺寸，
        //   所以必须趁 w/h 还是源尺寸时先算完，最后再改成打包后的尺寸。
        //   （曾经把 w/h 改早了，hardnessOf 拿到 48×48 去采样 300×300 的 gray → 越界/错值。）
        if (typeof b.hardnessHint === 'number') {
          b.hardness = b.hardnessHint;      // .sut：CSP 的 BrushHardness 才是真值
          delete b.hardnessHint;
        } else {
          b.hardness = hardnessOf(b.gray, b.w, b.h);
        }
        // diameter：只有 CSP 没给 BrushSize 时才退回「用图片像素尺寸」
        if (!(typeof b.diameter === 'number' && b.diameter > 0)) {
          b.diameter = Math.max(b.w, b.h);
        }
        // ⚠ packTip 把任意尺寸的图**统一重采样成 TIP_SIZE×TIP_SIZE**，
        //   所以 w/h 最后要改成打包后的尺寸，否则记录里会有
        //   「w=300 h=300 但 tip 头写着 48x48x4」这种自相矛盾（曾真的这样）。
        //   消费端（app 的导入列表 / engine 的 tipCanvas）都按 w/h 还原。
        b.w = TIP_SIZE; b.h = TIP_SIZE;
      }
      delete b.gray;
      delete b.png;   // 原始 PNG 不许跟着记录走（体积太大，localStorage 会爆）
    });
    return { kind: kind, version: res.version, brushes: res.brushes };
  }

  global.ChaBrushImport = {
    parse: parse,
    parseAbr: function (buf) { return parseAbr(buf); },
    parseSut: function (buf) { return parseSut(buf); },
    parseProcreate: function (buf) { return parseProcreate(buf); },
    packTip: packTip,
    unpackTip: unpackTip,
    hardnessOf: hardnessOf,
    // 下面几个是给测试用的：单测底层实现，出问题时好定位是哪一层
    inflateRaw: inflateRaw,
    readZip: readZip,
    readBplist: readBplist,
    resolveArchive: resolveArchive,
    decodePngGray: decodePngGray,
    // CSP 库读取：夹具（手搓 SQLite）出错时，要能一眼看出是夹具写错了还是解析器错了
    sqliteTableRows: sqliteTableRows,
    sqliteTableBlobs: sqliteTableBlobs,
    sutBrushMeta: sutBrushMeta
  };
})(window);
