/**
 * CSS 结构体检：找出「漏了一个 }」这类会让后面规则被错误恢复吞掉的缺陷。
 *
 * 为什么需要它：styles.css 里 `.section-grip {` 曾经漏了收尾的 `}`，
 * 浏览器按 CSS 错误恢复把它后面的一大批规则（包括 .stage / .canvas-wrap 的定位）
 * 一起吞了 —— 页面不报错、控制台干净，但画布区整体失控：
 * 画布被撑成 3300 万像素高、小笔刷光标糊成椭圆、面板把手跑到屏幕外没法拖。
 * 这种「静默失效」只有靠结构检查才抓得到，浏览器和 ESLint 都不会告诉你。
 *
 * 用法: node tools/check-css.js [file.css ...]
 *       不带参数时检查 client/renderer/styles.css
 */
'use strict';
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, '..', 'client', 'renderer', 'styles.css'));

let bad = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  const stack = [];      // { kind: 'at' | 'rule', line, sel }
  let buf = '';
  let line = 1;
  let i = 0;

  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const seg = src.slice(i, end < 0 ? src.length : end + 2);
      line += (seg.match(/\n/g) || []).length;
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') line++; j++; }
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ');
      const isAt = sel.charAt(0) === '@';
      // 普通规则的内部再出现 `{`，说明这一层根本没关上 —— 就是漏了一个 }
      if (stack.length && stack[stack.length - 1].kind === 'rule') {
        const outer = stack[stack.length - 1];
        if (!outer.reported) {
          outer.reported = true;
          problems.push(`行 ${outer.line} 的规则没有收尾（缺 }）：${outer.sel.slice(0, 60)}`);
        }
      }
      stack.push({ kind: isAt ? 'at' : 'rule', line, sel });
      buf = '';
      i++;
      continue;
    }
    if (c === '}') {
      if (!stack.length) problems.push(`行 ${line} 多出一个 }`);
      else stack.pop();
      buf = '';
      i++;
      continue;
    }
    if (c === ';') { buf = ''; i++; continue; }
    buf += c;
    i++;
  }

  for (const f of stack) {
    problems.push(`行 ${f.line} 的${f.kind === 'at' ? '@ 规则' : '规则'}没有收尾（缺 }）：${f.sel.slice(0, 60)}`);
  }

  const rel = path.relative(path.join(__dirname, '..'), file);
  if (problems.length) {
    bad++;
    console.log('✗ ' + rel);
    problems.forEach(p => console.log('    ' + p));
  } else {
    console.log('✓ ' + rel + '（括号配对正常，' + (src.match(/\n/g) || []).length + ' 行）');
  }
}

process.exit(bad ? 1 : 0);
