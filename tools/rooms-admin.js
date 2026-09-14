/**
 * 房间存档体检 / 清理工具。
 *
 *   node tools/rooms-admin.js                列出所有存档（含孤儿目录）
 *   node tools/rooms-admin.js --purge-blank  只删「没人在线 + 没有笔迹/底图/非系统聊天」的空房
 *   node tools/rooms-admin.js --purge-orphan 只删没有 room.json（或结构版本过旧）的孤儿目录
 *   node tools/rooms-admin.js --purge-trash  清空 .trash（待删暂存区，服务端会跳过它）
 *   node tools/rooms-admin.js --purge-all    全删（危险，要 --yes 确认）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { rmTree } = require('../server/src/rooms');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'server', 'data', 'rooms');
const ROOM_SCHEMA = 3;
const args = process.argv.slice(2);
const has = f => args.indexOf(f) >= 0;

function humanKB(n) { return (n / 1024).toFixed(0) + 'KB'; }

function dirSize(p) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      n += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
    }
  } catch (e) { /* ignore */ }
  return n;
}

// 跳过 `.` 开头的目录：那是 .trash（待删暂存区），不是房间存档
const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.charAt(0) !== '.');
const rows = [];
for (const e of entries) {
  const dir = path.join(DATA_DIR, e.name);
  const file = path.join(dir, 'room.json');
  const row = { id: e.name, dir, kind: 'ok', name: '', strokes: 0, layers: 0, hasBase: false, chat: 0, bytes: dirSize(dir) };
  if (!fs.existsSync(file)) {
    row.kind = 'orphan';
  } else {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.schema !== ROOM_SCHEMA) row.kind = 'oldschema';
      row.name = j.name || '';
      row.strokes = (j.strokes || []).length;
      row.layers = (j.layers || []).length;
      row.hasBase = (j.layers || []).some(l => l.baseImageFile);
      row.chat = (j.chat || []).filter(m => !m.system).length;
    } catch (err) {
      row.kind = 'broken';
    }
  }
  row.blank = row.kind === 'ok' && row.strokes === 0 && !row.hasBase && row.chat === 0;
  rows.push(row);
}

rows.sort((a, b) => b.strokes - a.strokes || b.bytes - a.bytes);

/**
 * rooms/.trash：房间被解散 / 回收时先把目录 rename 到这里，再由后台线程删。
 * 代码 loadAll() 会跳过它，所以它既不算房间、也不算孤儿，单独统计。
 */
const TRASH_DIR = path.join(DATA_DIR, '.trash');
const trashRows = [];
let trashBytes = 0;
try {
  for (const e of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(TRASH_DIR, e.name);
    const b = dirSize(dir);
    trashBytes += b;
    trashRows.push({ id: e.name, dir, kind: 'trash', name: '', strokes: 0, layers: 0, hasBase: false, chat: 0, bytes: b });
  }
} catch (e) { /* 没有 .trash 才是常态 */ }

console.log('存档目录:', DATA_DIR);
console.log('共 ' + rows.length + ' 个目录\n');
console.log('状态      笔迹  底图  聊天   大小     房间名 / 目录');
for (const r of rows) {
  console.log(
    (r.kind === 'ok' ? (r.blank ? '空房  ' : '有内容') : r.kind.padEnd(6)).padEnd(9) +
    String(r.strokes).padStart(4) + '  ' +
    (r.hasBase ? ' 有 ' : ' 无 ') + '  ' +
    String(r.chat).padStart(3) + '  ' +
    humanKB(r.bytes).padStart(7) + '  ' +
    (r.name || '-') + '  [' + r.id + ']'
  );
}

if (trashRows.length) {
  console.log('\n待删暂存 .trash：' + trashRows.length + ' 项，' + humanKB(trashBytes)
    + '（房间已从列表移除，只是目录还没删干净；--purge-trash 可立即清掉）');
}

function rm(row) {
  const gone = rmTree(row.dir);
  console.log('  ' + (gone ? '删除' : '删除失败（文件被占用？）') + ' ' + row.id + '（' + (row.name || row.kind) + '）');
}

let targets = [];
if (has('--purge-all')) {
  if (!has('--yes')) {
    console.log('\n--purge-all 需要再加 --yes 才会真的删。');
    process.exit(0);
  }
  targets = rows.concat(trashRows);
} else if (has('--purge-blank')) {
  targets = rows.filter(r => r.blank);
} else if (has('--purge-orphan')) {
  targets = rows.filter(r => r.kind === 'orphan' || r.kind === 'oldschema' || r.kind === 'broken');
} else if (has('--purge-trash')) {
  targets = trashRows;
}

if (targets.length) {
  console.log('\n清理 ' + targets.length + ' 个：');
  targets.forEach(rm);
  console.log('完成，剩余 ' + (rows.length + trashRows.length - targets.length) + ' 个。');
} else if (args.length) {
  console.log('\n没有匹配到需要清理的目录。');
}
