/**
 * 茶绘 · 协议接线检查
 *
 * 协议是单一来源（shared/protocol.js），但它描述的是「两端之间的约定」——
 * 定义了常量 ≠ 真的接上了。最常见的两类静默故障：
 *
 *   ① 服务端发了某条 S2C，前端没有对应分支 → 消息被 default 丢掉，
 *      表现是「服务端明明处理了，客户端没反应」（这个项目栽过一次，见 node-ws-message-latency）
 *   ② 协议里定义了某条消息，但两端都没用 → 死协议面。别人照着它写 handler
 *      永远不触发，白查半天
 *
 * 检查三件事：
 *   - 每条 S2C：服务端有没有发 ／ 前端有没有收
 *   - 每条 C2S：前端有没有发 ／ 服务端有没有收
 *   - 两边都找不到的 → 标为「死协议面」
 *
 * 用法：node tools/check-proto.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'shared', 'protocol.js'));

/** 读一串文件拼成一个大字符串 */
function readAll(files) {
  return files
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

/** 目录下所有 .js（一层，够用；本项目的收发都在这几个文件里）。
 *  必须排除 protocol.js —— 它是协议自己的同步副本，常量定义就写在那里，
 *  扫进去会让「有没有人发过这条消息」永远为真。 */
function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.js') && n !== 'protocol.js')
    .map(n => path.join(dir, n));
}

const serverSrc = readAll(jsFiles(path.join(ROOT, 'server', 'src')));
const clientSrc = readAll(jsFiles(path.join(ROOT, 'client', 'renderer')));

// 前端用 `case P.S2C.XXX:` 收，服务端用 `case P.C2S.XXX:` 收；
// 发送侧则是 `P.S2C.XXX` / `C2S.XXX` 出现在普通表达式里。
// 接收侧还有两种非 switch 的写法（net.js 的心跳就是），要一起认：
//   `msg.t === P.S2C.PONG` / `msg.t !== P.C2S.X`
function hasRecv(src, ns, key) {
  const k = ns + '\\.' + key + '\\b';
  return new RegExp('case\\s+P?\\.?' + k).test(src)
      || new RegExp('[=!]==\\s*P?\\.?' + k).test(src);
}
function hasAny(src, ns, key) {
  return new RegExp('\\b' + ns + '\\.' + key + '\\b').test(src);
}

let errors = 0, warns = 0;

function report(title, rows) {
  const bad = rows.filter(r => r.level === 'error');
  const dead = rows.filter(r => r.level === 'dead');
  errors += bad.length;
  warns += dead.length;
  return { title, rows, bad, dead };
}

// ---- S2C：服务端 → 客户端 ----
const s2cRows = [];
for (const key of Object.keys(P.S2C)) {
  const sent = hasAny(serverSrc, 'S2C', key);
  const recv = hasRecv(clientSrc, 'S2C', key);
  let level = 'ok';
  if (!sent && !recv) level = 'dead';
  else if (sent && !recv) level = 'error';
  else if (!sent && recv) level = 'dead';   // 前端接了但没人发，等于死
  s2cRows.push({ key, val: P.S2C[key], sent, recv, level });
}

// ---- C2S：客户端 → 服务端 ----
const c2sRows = [];
for (const key of Object.keys(P.C2S)) {
  const sent = hasAny(clientSrc, 'C2S', key);
  const recv = hasRecv(serverSrc, 'C2S', key);
  let level = 'ok';
  if (!sent && !recv) level = 'dead';
  else if (sent && !recv) level = 'error';
  else if (!sent && recv) level = 'dead';
  c2sRows.push({ key, val: P.C2S[key], sent, recv, level });
}

function print(title, rows) {
  console.log('\n' + title);
  for (const r of rows) {
    const mark = r.level === 'ok' ? '\u2713' : (r.level === 'error' ? '\u2717' : '!');
    const note =
      r.level === 'ok' ? ''
      : r.level === 'error'
        ? (r.sent && !r.recv ? '  发送方发了，接收方没有分支 —— 会被静默丢弃' : '')
        : '  协议里定义了但两端都没用（死协议面）';
    console.log('  ' + mark + ' ' + r.key.padEnd(16) + r.val.padEnd(24) + '发=' + (r.sent ? 'Y' : '-') + ' 收=' + (r.recv ? 'Y' : '-') + note);
  }
}

console.log('协议接线检查（协议版本 v' + P.PROTOCOL_VERSION + '）');
console.log('  服务端源码: server/src/*.js   ·   前端源码: client/renderer/*.js');
print('S2C（服务端 → 客户端）', s2cRows);
print('C2S（客户端 → 服务端）', c2sRows);

console.log('');
if (!errors && !warns) {
  console.log('\u2713 每条消息两端都接上了');
  process.exit(0);
}
if (errors) console.log('\u2717 ' + errors + ' 条消息「发了没人收」—— 请补上接收分支，或从协议里删掉');
if (warns) console.log('! ' + warns + ' 条死协议面 —— 建议从 shared/protocol.js 删掉，免得有人照着它写不触发的代码');
console.log('');
console.log('  只定义、没使用的常量会随协议同步到三份副本，是长期的认知负担。');
process.exit(errors ? 1 : 0);
