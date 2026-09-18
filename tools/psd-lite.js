/**
 * 茶绘 · 极简 PSD 读取器（只够测试和排错用）
 *
 * 不是通用 PSD 解析器：只看 8BPS / RGB / 8 位 / RLE 这一种茶绘会写出来的东西。
 * 存在的意义是让测试能**逐字节**验自己写出去的 PSD ——
 * 二进制格式写错一个长度字段 Photoshop 就打不开，而「文件生成了、大小不为 0」
 * 这种断言对二进制格式等于没测。
 *
 * 用法:
 *   const psd = require('./psd-lite');
 *   const r = psd.parse(fs.readFileSync('x.psd'));
 *   r.layers[i].luni / .lsct / .blend / .opacity / .flags / .hidden
 *   psd.layerPx(r.layers[i], x, y)   // [R,G,B,A]
 *   psd.compPx(r, x, y)
 */
'use strict';

/** PackBits 解压。解出来的字节数必须正好等于行宽 —— 少了多了都说明编码有问题 */
function unpackbits(buf, off, len) {
  const out = [];
  let i = 0;
  while (i < len) {
    const n = buf.readInt8(off + i); i++;
    if (n >= 0) {                                    // 字面段：n+1 个字节
      const cnt = n + 1;
      for (let k = 0; k < cnt; k++) out.push(buf[off + i + k]);
      i += cnt;
    } else if (n !== -128) {                         // -128 按规范是空操作
      const cnt = 1 - n;
      const v = buf[off + i]; i++;
      for (let k = 0; k < cnt; k++) out.push(v);
    }
  }
  return out;
}

function parse(buf) {
  if (buf.toString('latin1', 0, 4) !== '8BPS') throw new Error('签名不是 8BPS');

  const r = {
    version: buf.readUInt16BE(4),
    channels: buf.readUInt16BE(12),
    height: buf.readUInt32BE(14),
    width: buf.readUInt32BE(18),
    depth: buf.readUInt16BE(22),
    colorMode: buf.readUInt16BE(24),
    layers: []
  };

  let p = 26;
  const cmLen = buf.readUInt32BE(p); p += 4 + cmLen;
  const irLen = buf.readUInt32BE(p); p += 4 + irLen;
  const lmLen = buf.readUInt32BE(p);
  const lmStart = p + 4;
  if (lmStart + lmLen > buf.length) throw new Error('「图层与蒙版信息」段的长度越界了');

  let q = lmStart + 4;
  const count = buf.readInt16BE(q); q += 2;
  r.layerCount = count;
  if (count < 0) throw new Error('层数写成负数了（首个 alpha 通道语义），本轮不该出现');

  for (let i = 0; i < count; i++) {
    const L = {
      index: i,
      top: buf.readInt32BE(q), left: buf.readInt32BE(q + 4),
      bottom: buf.readInt32BE(q + 8), right: buf.readInt32BE(q + 12)
    };
    q += 16;
    const nch = buf.readUInt16BE(q); q += 2;
    L.chans = [];
    for (let c = 0; c < nch; c++) {
      L.chans.push({ id: buf.readInt16BE(q), len: buf.readUInt32BE(q + 2) });
      q += 6;
    }
    const blendSig = buf.toString('latin1', q, q + 4); q += 4;
    if (blendSig !== '8BIM') throw new Error('第 ' + i + ' 层混合模式签名不是 8BIM，是 ' + blendSig);
    L.blend = buf.toString('latin1', q, q + 4); q += 4;
    L.opacity = buf[q++];
    L.clipping = buf[q++];
    L.flags = buf[q++];
    L.filler = buf[q++];
    const extraLen = buf.readUInt32BE(q); q += 4;
    const extraStart = q;

    let x = q;
    const maskLen = buf.readUInt32BE(x); x += 4 + maskLen;
    const brLen = buf.readUInt32BE(x); x += 4 + brLen;
    const nlen = buf[x]; x += 1;
    L.pascalName = buf.toString('latin1', x, x + nlen);
    x += nlen + (4 - ((1 + nlen) % 4)) % 4;
    L.luni = null; L.lsct = null;
    while (x + 12 <= extraStart + extraLen) {
      if (buf.toString('latin1', x, x + 4) !== '8BIM') break;
      const key = buf.toString('latin1', x + 4, x + 8);
      const len = buf.readUInt32BE(x + 8);
      if (key === 'luni') {
        const cnt = buf.readUInt32BE(x + 12);
        let s = '';
        for (let k = 0; k < cnt; k++) s += String.fromCharCode(buf.readUInt16BE(x + 16 + k * 2));
        L.luni = s;
      }
      if (key === 'lsct') L.lsct = buf.readUInt32BE(x + 12);
      x += 12 + len;
    }
    if (x !== extraStart + extraLen) {
      throw new Error('第 ' + i + ' 层额外数据没走满（解析错位：走到 ' + x + '，应为 ' + (extraStart + extraLen) + '）');
    }
    q = extraStart + extraLen;
    L.hidden = !!(L.flags & 0x02);
    r.layers.push(L);
  }

  // 通道数据。长度字段**含**那 2 个字节的压缩标志。
  // 几何一律按**层自己的矩形**算，不能按画布尺寸 —— 组分隔符的矩形是空的（0×0），
  // 拿画布尺寸去读它会去找 160 万字节，而那里一个字节都没有。
  for (let i = 0; i < count; i++) {
    const L = r.layers[i];
    const lw = L.right - L.left;
    const lh = L.bottom - L.top;
    L.pixels = {};
    for (const ch of L.chans) {
      const comp = buf.readUInt16BE(q); q += 2;
      if (comp === 1) {
        const table = [];
        for (let y = 0; y < lh; y++) { table.push(buf.readUInt16BE(q)); q += 2; }
        const rows = [];
        for (let y = 0; y < lh; y++) {
          const row = unpackbits(buf, q, table[y]);
          if (row.length !== lw) {
            throw new Error('第 ' + i + ' 层通道 ' + ch.id + ' 第 ' + y + ' 行解出 ' +
              row.length + ' 字节，应为 ' + lw);
          }
          rows.push(row); q += table[y];
        }
        L.pixels[ch.id] = rows;
      } else if (comp === 0) {
        const rows = [];
        for (let y = 0; y < lh; y++) {
          const row = [];
          for (let xx = 0; xx < lw; xx++) row.push(buf[q++]);
          rows.push(row);
        }
        L.pixels[ch.id] = rows;
      } else {
        throw new Error('未知的压缩方式 ' + comp);
      }
    }
  }

  // 合成图：先全部通道的行长度表，再全部通道的数据
  const cp0 = lmStart + lmLen;
  if (cp0 + 2 > buf.length) throw new Error('找不到合成图数据（段长度不对）');
  r.composite = { comp: buf.readUInt16BE(cp0) };
  let cp = cp0 + 2;
  if (r.composite.comp === 1) {
    const tables = [];
    for (let c = 0; c < r.channels; c++) {
      const t = [];
      for (let y = 0; y < r.height; y++) { t.push(buf.readUInt16BE(cp)); cp += 2; }
      tables.push(t);
    }
    r.composite.planes = [];
    for (let c = 0; c < r.channels; c++) {
      const rows = [];
      for (let y = 0; y < r.height; y++) {
        const row = unpackbits(buf, cp, tables[c][y]);
        if (row.length !== r.width) throw new Error('合成图通道 ' + c + ' 第 ' + y + ' 行宽度不对');
        rows.push(row); cp += tables[c][y];
      }
      r.composite.planes.push(rows);
    }
  }
  r.trailing = buf.length - cp;                    // 后面不该再有多余字节
  return r;
}

/** 取某层某点的 RGBA（通道 id：0=R 1=G 2=B -1=A）。x/y 是**画布坐标**，内部按层矩形换算 */
function layerPx(L, x, y) {
  const yy = y - L.top, xx = x - L.left;
  const g = (id) => {
    const rows = L.pixels[id];
    if (!rows || yy < 0 || yy >= rows.length) return 0;
    const row = rows[yy];
    return (xx >= 0 && xx < row.length) ? row[xx] : 0;
  };
  return [g(0), g(1), g(2), g(-1)];
}

function compPx(r, x, y) {
  const c = r.composite.planes;
  return [c[0][y][x], c[1][y][x], c[2][y][x], c[3][y][x]];
}

module.exports = { parse, unpackbits, layerPx, compPx };
