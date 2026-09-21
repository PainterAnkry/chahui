'use strict';
/**
 * 把 SAI2 的 .saitdat（其实是文本：每行 `key=类型:值`）解析成对象。
 *
 * 格式（逆向出来的）：
 *   · 整个文件是若干行，行尾 0x0A
 *   · 每行 `key=类型:值`，类型三种：
 *       S: ASCII 串
 *       I: ASCII 十进制整数
 *       U: UTF-16LE 串（中文/日文笔刷名都在这儿）
 *   · 工具 id 在 tidstr（pencil / dotpen / selpen / boker / …），
 *     笔刷显示名在 name
 *
 * ⚠ 类型标记 `U:` 看着像 UTF-16，其实是 **UTF-8**（实测 e88d89 = 草）。
 *   按 UTF-16 解会得到一串乱码，然后你会在「按名字挑笔刷」这一步挑错。
 */
const fs = require('fs');

function parseSaitdat(file) {
  const buf = fs.readFileSync(file);
  const out = {};
  let p = 0;
  while (p < buf.length) {
    let e = buf.indexOf(0x0a, p);
    if (e < 0) e = buf.length;
    const line = buf.slice(p, e);
    p = e + 1;
    if (!line.length) continue;
    const eq = line.indexOf(0x3d);
    if (eq <= 0) continue;
    const key = line.slice(0, eq).toString('latin1');
    const type = String.fromCharCode(line[eq + 1]);
    const body = line.slice(eq + 3);          // 跳过 '=' 和 'X:'
    if (type === 'S') out[key] = body.toString('latin1');
    else if (type === 'I') out[key] = parseInt(body.toString('latin1'), 10);
    else if (type === 'U') out[key] = body.toString('utf8');
    else out[key] = body.toString('latin1');
  }
  return out;
}

/** .saitgrp：一行一个引用（`N=U:名字` 之类的键值），把组名与成员 id 都读出来 */
function parseSaitgrp(file) {
  const buf = fs.readFileSync(file);
  const rows = [];
  let p = 0;
  while (p < buf.length) {
    let e = buf.indexOf(0x0a, p);
    if (e < 0) e = buf.length;
    const line = buf.slice(p, e);
    p = e + 1;
    if (!line.length) continue;
    const s = line.toString('latin1');
    const m = /^([A-Za-z0-9_]+)=(S|I|U):(.*)$/.exec(s);
    if (m) {
      const body = line.slice(m[1].length + 3);
      if (m[2] === 'U') rows.push({ key: m[1], val: body.toString('utf8') });
      else rows.push({ key: m[1], val: body.toString('latin1') });
    } else {
      // 纯文本行（有的是直接列 id）
      rows.push({ key: '', val: s });
    }
  }
  return rows;
}

module.exports = { parseSaitdat, parseSaitgrp };
