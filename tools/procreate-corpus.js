/**
 * Procreate 笔刷语料回归：把真实的 .brush 文件喂给解析器，逐项核对结果。
 *
 * 不带参数 = 跑仓库自带的语料（tools/procreate-corpus/），并**严格断言**每一项期望值。
 * 带参数   = 拿你自己的 .brush / .brushset 试，只报告不判定。
 *
 *   node tools/procreate-corpus.js
 *   node tools/procreate-corpus.js "D:\笔刷包"  D:\某支.brush
 *
 * 为什么敢写死期望值：灰度校验和是拿一份**独立实现**（Python + zlib + 手写反滤波）
 * 对出来的，两边算出的 graySum 完全一致，所以它一旦变了就是解析链路真的坏了。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 解析器是浏览器模块，这里给它一个最小的 window / btoa / atob
global.window = global;
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.atob = s => Buffer.from(s, 'base64').toString('binary');
require(path.resolve(__dirname, '..', 'client', 'renderer', 'brush-import.js'));
const BI = global.ChaBrushImport;

/* ---------------- 语料期望值 ---------------- */
// graySum 覆盖「ZIP 解压 → PNG 反滤波」整条链路：任何一环错了这个数都会变。
const EXPECT = {
  'marker.brush': {
    zipBytes: 179410, entries: 4, pngBytes: 4345,
    w: 256, h: 256, colorType: 0, graySum: 5459199,
    name: 'Marker', tipLen: 1544, hardness: 0.651, diameter: 34, spacing: 0.06,
    // 凿形椭圆：硬度的面积法就该给出「偏硬」，环平均法会给 0.05（下限）
    hardnessAtLeast: 0.4
  },
  'pencil.brush': {
    zipBytes: 192276, entries: 4, pngBytes: 9438,
    w: 256, h: 256, colorType: 0, graySum: 10121860,
    name: 'Pencil', tipLen: 1544, hardness: 0.414, diameter: 27, spacing: 0.08,
    hardnessAtLeast: 0.25
  }
};

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------------- 自带语料（严格） ---------------- */

function runBuiltin() {
  const dir = path.join(__dirname, 'procreate-corpus');
  const files = fs.readdirSync(dir).filter(f => /\.(brush|brushset|prbr)$/i.test(f)).sort();
  console.log('Procreate 笔刷语料回归 @ tools/procreate-corpus/\n');
  if (!files.length) { console.log('  语料目录是空的！'); process.exit(1); }

  for (const f of files) {
    const exp = EXPECT[f];
    console.log('── ' + f);
    if (!exp) { console.log('   （没有期望值，跳过；新增语料请先补 EXPECT）'); continue; }

    const full = path.join(dir, f);
    const bytes = new Uint8Array(fs.readFileSync(full));
    check('文件大小没变', bytes.length === exp.zipBytes, bytes.length + ' 字节');

    // 1) ZIP 层
    let zip;
    try { zip = BI.readZip(bytes); } catch (e) { check('ZIP 能解开', false, e.message); continue; }
    check('ZIP 条目数', zip.entries.length === exp.entries, zip.entries.length + ' 个');

    const shapeEntry = zip.entries.find(e => /(^|\/)Shape\.png$/i.test(e.name));
    check('找得到 Shape.png', !!shapeEntry);
    if (!shapeEntry) continue;
    check('Shape.png 解压后大小', shapeEntry.data.length === exp.pngBytes, shapeEntry.data.length + ' 字节');

    // 2) PNG 层（含反滤波）
    let img;
    try { img = BI.decodePngGray(shapeEntry.data); } catch (e) { check('PNG 能解码', false, e.message); continue; }
    check('PNG 尺寸', img.w === exp.w && img.h === exp.h, img.w + '×' + img.h);
    let sum = 0;
    for (let i = 0; i < img.gray.length; i++) sum += img.gray[i];
    check('灰度校验和（覆盖 zip+inflate+反滤波整条链路）',
      sum === exp.graySum, sum + ' vs ' + exp.graySum);

    // 3) 解析层
    let res;
    try { res = BI.parse(f, bytes); } catch (e) { check('parse 成功', false, e.message); continue; }
    check('kind 判定', res.kind === 'procreate', res.kind);
    check('笔刷数', res.brushes.length === 1, res.brushes.length + ' 支');
    const b = res.brushes[0];
    if (!b) continue;
    check('笔名', b.name === exp.name, b.name);
    check('笔尖字符串长度', b.tip.length === exp.tipLen, b.tip.length + ' 字符');
    check('笔尖长度在协议上限内（≤1600）', b.tip.length <= 1600, b.tip.length + ' / 1600');
    check('笔尖能解包', !!BI.unpackTip(b.tip));
    check('硬度', near(b.hardness, exp.hardness, 0.02), b.hardness.toFixed(3));
    // 这条是专治「拿半径环平均去量凿形椭圆」的：那样会给出下限 0.05
    check('硬度没被非圆笔尖拖到下限', b.hardness >= exp.hardnessAtLeast, b.hardness.toFixed(3));
    check('直径', b.diameter === exp.diameter, b.diameter + 'px');
    check('间距', near(b.spacing, exp.spacing, 0.001), b.spacing);

    // 4) 映射出来的参数要全部落在协议允许的范围内，
    //    否则 normalizeBrush 会悄悄夹掉，用户看到的是另一支笔
    const o = b.opts || {};
    const RANGES = {
      size: [1, 400], opacity: [0.02, 1], hardness: [0, 1], minSize: [0.02, 1],
      pressSize: [0, 1], pressOpacity: [0, 1], scatter: [0, 1], mix: [0, 1],
      grainScale: [0.2, 4], grain: [0, 1], spacing: [0.02, 1]
    };
    let allIn = true, badKey = '';
    for (const k in RANGES) {
      const v = o[k];
      if (typeof v !== 'number' || !isFinite(v) || v < RANGES[k][0] || v > RANGES[k][1]) {
        allIn = false; badKey = k + '=' + v + '（应 ' + RANGES[k][0] + '~' + RANGES[k][1] + '）';
        break;
      }
    }
    check('映射出的参数全部在协议范围内（不会被 normalizeBrush 夹掉）', allIn, badIn(allIn, badKey, Object.keys(o).length));
  }
}

function badIn(ok, badKey, n) { return ok ? n + ' 项' : badKey; }

/* ---------------- 外部文件（只报告） ---------------- */

function runExternal(paths) {
  const files = [];
  for (const a of paths) {
    let st;
    try { st = fs.statSync(a); } catch (e) { console.log('  ✗ 找不到 ' + a); fail++; continue; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(a)) {
        if (/\.(brush|brushset|prbr)$/i.test(f)) files.push(path.join(a, f));
      }
    } else files.push(a);
  }
  files.sort();
  if (!files.length) { console.log('这些路径里没有 .brush / .brushset / .prbr'); process.exit(2); }

  let ok = 0, bad = 0, total = 0;
  const failures = [];
  const t0 = Date.now();
  for (const f of files) {
    const name = path.basename(f);
    const t = Date.now();
    try {
      const bytes = new Uint8Array(fs.readFileSync(f));
      const res = BI.parse(name, bytes);
      const good = res.brushes.filter(b => b.tip && b.tip.length > 20);
      total += good.length;
      console.log('  ✓ ' + name.padEnd(44) + ' ' + String(good.length).padStart(3) + ' 支  ' +
        good.map(b => b.name).slice(0, 4).join(' / ').slice(0, 60) +
        '  (' + (Date.now() - t) + 'ms)');
      if (good.length) ok++; else { bad++; failures.push({ name, why: '解析出来但一支带笔尖的都没有' }); }
    } catch (e) {
      console.log('  ✗ ' + name.padEnd(44) + ' ' + e.message);
      bad++; failures.push({ name, why: e.message });
    }
  }
  console.log('\n════════════════════════════════════════');
  console.log('  文件 ' + files.length + ' 个：成功 ' + ok + ' / 失败 ' + bad);
  console.log('  共解析出 ' + total + ' 支带笔尖的笔刷');
  console.log('  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  if (failures.length) {
    console.log('\n  失败清单（把这个发给我就能查）：');
    failures.forEach(x => console.log('   - ' + x.name + '  →  ' + x.why));
  }
  console.log('════════════════════════════════════════');
}

/* ---------------- 入口 ---------------- */

const args = process.argv.slice(2);
if (args.length) {
  console.log('Procreate 笔刷外部文件解析\n');
  runExternal(args);
} else {
  runBuiltin();
}
console.log('\n  ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
