/**
 * 真实 .abr 语料测试：把一批真实 Photoshop 笔刷文件挨个喂给解析器，
 * 报告每个文件解析出几支笔、失败的原因是什么。
 *
 * 用法:
 *   node tools/abr-corpus.js <目录或文件> [...]
 *   node tools/abr-corpus.js "D:\笔刷目录"
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

const args = process.argv.slice(2);
if (!args.length) { console.error('用法: node tools/abr-corpus.js <目录或文件> [...]'); process.exit(2); }

const files = [];
for (const a of args) {
  const st = fs.statSync(a);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(a)) {
      if (/\.abr$/i.test(f)) files.push(path.join(a, f));
    }
  } else files.push(a);
}
files.sort();

let ok = 0, bad = 0, totalBrushes = 0, skipped = 0;
const failures = [];
const t0 = Date.now();

for (const f of files) {
  const name = path.basename(f);
  const sizeMb = fs.statSync(f).size / 1024 / 1024;
  // 整份读进来。之前为了省事只读前 60MB，结果两个上百 MB 的文件正好把 samp 块砍掉了，
  // 误报成「没有 samp 块」—— 探针自己的锅。
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch (e) {
    console.log('  ✗ ' + name + '  读取失败: ' + e.message);
    bad++; failures.push({ name, why: '读取失败: ' + e.message }); continue;
  }
  const t = Date.now();
  try {
    const res = BI.parse(name, buf);
    const withTip = res.brushes.filter(b => b.tip && b.tip.length > 20);
    totalBrushes += withTip.length;
    const dims = withTip.map(b => b.diameter).filter(Boolean);
    const dimTxt = dims.length ? '笔尖 ' + Math.min.apply(null, dims) + '~' + Math.max.apply(null, dims) + 'px' : '';
    console.log('  ✓ ' + name.padEnd(46) + ' v' + res.version + '  ' +
      String(withTip.length).padStart(3) + ' 支  ' + dimTxt + '  (' + (Date.now() - t) + 'ms)');
    if (!withTip.length) { bad++; failures.push({ name, why: '解析出来但一支带笔尖的都没有' }); }
    else ok++;
  } catch (e) {
    console.log('  ✗ ' + name.padEnd(46) + ' ' + e.message);
    bad++; failures.push({ name, why: e.message });
  }
}

console.log('\n════════════════════════════════════════');
console.log('  文件 ' + files.length + ' 个：成功 ' + ok + ' / 失败 ' + bad);
console.log('  共解析出 ' + totalBrushes + ' 支带笔尖的笔刷');
console.log('  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
if (failures.length) {
  console.log('\n  失败清单：');
  failures.forEach(f => console.log('   - ' + f.name + '  →  ' + f.why));
}
console.log('════════════════════════════════════════');
process.exit(bad ? 1 : 0);
