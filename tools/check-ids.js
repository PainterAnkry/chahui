/**
 * 茶绘 · 元素 id 交叉检查
 *
 * 前端「唯一来源」是 client/renderer/。改动 UI 时最常见、也最隐蔽的事故是：
 *   app.js 里写 $('#foo') / getElementById('foo')，但 index.html 里根本没有 id="foo"。
 * 后果有两种，都不报错：
 *   - 加事件监听的那一行抛 TypeError，整个 init 半路中断（按钮全哑）
 *   - 只在某个流程里才取的元素取到 null，表现为「这个功能莫名其妙不生效」
 *
 * 静态检查器（check-css / check-defs）都覆盖不到这一类，所以单独做这个。
 *
 * 判定规则：
 *   引用集 = app.js 里的 getElementById('x') 与 $('#x')
 *   定义集 = index.html 里的 id="x"
 *          ∪ app.js 里动态创建的（模板串 id="x"、el.id = 'x'、{id:'x'}）
 *   引用集 - 定义集 = 可疑清单
 *
 * 用法：node tools/check-ids.js [前端目录]（默认 client/renderer）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join('client', 'renderer');
const appPath = path.join(dir, 'app.js');
const htmlPath = path.join(dir, 'index.html');

for (const p of [appPath, htmlPath]) {
  if (!fs.existsSync(p)) {
    console.error('找不到 ' + p + '，第一个参数应该是前端目录（默认 client/renderer）');
    process.exit(2);
  }
}

const app = fs.readFileSync(appPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

/** 把正则所有匹配收进一个集合 */
function collect(src, re, group) {
  const out = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) out.add(m[group || 1]);
  return out;
}

// ---- 引用 ----
const refs = new Set();
for (const x of collect(app, /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.add(x);
for (const x of collect(app, /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)) refs.add(x);

// ---- 定义 ----
const defs = new Set();
const ID_RE = [
  /\bid=["']([^"']+)["']/g,               // <div id="x">  以及模板串里的 id="x"
  /\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g, // el.id = 'x'
  /\bid\s*:\s*['"]([A-Za-z0-9_-]+)['"]/g  // { id: 'x' }
];
for (const re of ID_RE) {
  for (const x of collect(html, re)) defs.add(x);
  for (const x of collect(app, re)) defs.add(x);
}

const missing = [...refs].filter(x => !defs.has(x)).sort();

console.log('前端目录: ' + dir);
console.log('  引用 id ' + refs.size + ' 个 · 定义 id ' + defs.size + ' 个');

if (!missing.length) {
  console.log('  \u2713 没有引用了却不存在的 id');
  process.exit(0);
}

console.log('  \u2717 引用了却不存在的 id（' + missing.length + '）:');
for (const id of missing) {
  // 指出引用位置，方便直接跳过去看
  const lines = [];
  const walk = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(app))) {
      const upto = app.slice(0, m.index);
      lines.push(upto.split('\n').length);
    }
  };
  walk(new RegExp('getElementById\\(\\s*[\'"]' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\s*\\)', 'g'));
  walk(new RegExp('\\$\\(\\s*[\'"]#' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\s*\\)', 'g'));
  const uniq = [...new Set(lines)].sort((a, b) => a - b).slice(0, 4).join(', ');
  console.log('    ' + id + (uniq ? '  (app.js L' + uniq + ')' : ''));
}
console.log('');
console.log('  如果它本该由 app.js 动态创建，检查创建处的 id 拼写；');
console.log('  如果它确实不存在，把引用删掉（或者用 $(\'#x\') && ... 显式兜底）。');
process.exit(1);
