// 静态检测：被调用但在本文件内未定义的函数（粗筛，供人工确认）
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'client', 'renderer', 'app.js');
const src = fs.readFileSync(file, 'utf8');

const clean = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

const defs = new Set();
const defRe = /(?:function\s+([A-Za-z_$][\w$]*))|(?:var\s+([A-Za-z_$][\w$]*)\s*=\s*function)|(?:([A-Za-z_$][\w$]*)\s*=\s*function)/g;
let m;
while ((m = defRe.exec(clean))) defs.add(m[1] || m[2] || m[3]);

const calls = new Map(); // name -> first index
const callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
let cm;
while ((cm = callRe.exec(clean))) {
  const name = cm[2];
  const idx = cm.index + cm[1].length;
  if (!calls.has(name)) calls.set(name, idx);
}

const builtins = new Set(('if for while switch catch function return typeof new void delete in of do else try case break continue ' +
  'var let const this super class throw yield await async Number String Boolean Array Object Math JSON Date parseInt parseFloat ' +
  'isNaN isFinite encodeURIComponent decodeURIComponent setTimeout setInterval clearTimeout clearInterval require alert confirm ' +
  'prompt Error Map Set Promise RegExp Symbol Uint8Array Uint8ClampedArray Float32Array Int32Array Blob File FileReader Image ' +
  'Audio document window console localStorage requestAnimationFrame cancelAnimationFrame getComputedStyle DOMMatrix Path2D fetch ' +
  'btoa atob URL FormData TextEncoder TextDecoder WebSocket CustomEvent Event Node Element HTMLElement ResizeObserver ' +
  'IntersectionObserver MutationObserver structuredClone queueMicrotask globalThis undefined NaN Infinity Proxy Reflect ' +
  'WeakMap WeakSet define export').split(/\s+/));

const missing = [];
for (const [name, idx] of calls) {
  if (defs.has(name) || builtins.has(name)) continue;
  const line = clean.slice(0, idx).split('\n').length;
  missing.push({ name, line });
}
missing.sort((a, b) => a.line - b.line);

console.log('文件: ' + file);
if (!missing.length) {
  console.log('  未发现可疑的未定义调用');
} else {
  console.log('  可疑未定义调用（' + missing.length + '）:');
  missing.forEach(o => console.log('    L' + o.line + '  ' + o.name));
}
