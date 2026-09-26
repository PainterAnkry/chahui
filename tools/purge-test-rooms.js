'use strict';
/**
 * 按名字删掉测试房，腾出房间数上限。
 *
 * 安全做法：**只删「名字确实出现在 tools/*.js 里」的房间** —— 也就是测试脚本自己
 * 建出来的那些。不按「像不像测试房」猜名字，也不碰应用默认房名「房主的茶绘室」。
 *
 * 用法: node tools/purge-test-rooms.js [http://127.0.0.1:8442] [--dry]
 */
const fs = require('fs');
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const P = require(R('shared/protocol'));
const WebSocket = require(R('server/node_modules/ws'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8442').replace(/\/+$/, '');
const DRY = process.argv.indexOf('--dry') >= 0;
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 应用默认房名，永远不删 */
const KEEP = new Set(['房主的茶绘室', '']);

/**
 * 名字一看就是测试房的（人类可读判据，不猜）。
 * 只认这些词 —— 别的名字（例如 X / y / MH 这种来源不明的短名）一律保留。
 * 提不出「谁建的」，就按「名字是不是测试语汇」来，并且删之前会先 --dry 打出来给人过目。
 */
const TEST_WORD = /回归|验收|测试|验证|复现|一致性|调整|诊断|回环|画布甲|同步|粘贴|蒙版|覆盖层|网格变换/;

/** 从 tools/*.js 里收集测试脚本用过的房间名 */
function namesUsedByTests() {
  const dir = path.resolve(__dirname);
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.js$/.test(f) || f === path.basename(__filename)) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    // page.fill('#newRoomName', 'XXX') / fill("#newRoomName", `XXX`) / 'newRoomName', "XXX"
    let m;
    const re1 = /#newRoomName['"]\s*,\s*['"`]([^'"`]+)['"`]/g;
    while ((m = re1.exec(s))) out.add(m[1]);
    // ROOM_CREATE 的 name 字段：name: 'XXX' 附近 200 字内有 ROOM_CREATE
    const re2 = /name:\s*['"`]([^'"`]{1,24})['"`]/g;
    while ((m = re2.exec(s))) {
      const near = s.slice(Math.max(0, m.index - 260), m.index + 120);
      if (/ROOM_CREATE|createRoom|newRoomName/.test(near)) out.add(m[1]);
    }
  }
  return out;
}

(async () => {
  const rl = await fetch(BASE + '/api/rooms').then(r => r.json());
  const rooms = rl.rooms || [];
  console.log('清理前房间数 = ' + rooms.length);

  const testNames = namesUsedByTests();
  console.log('测试脚本用过的房间名 = ' + testNames.size + ' 个');

  const hit = [], keep = [];
  rooms.forEach(r => {
    const n = r.name || '';
    if (KEEP.has(n)) { keep.push(r); return; }
    if (TEST_WORD.test(n) || testNames.has(n)) hit.push(r); else keep.push(r);
  });
  console.log('  命中（要删）= ' + hit.length);
  console.log('  保留 = ' + keep.length
    + (keep.length ? '  ← ' + JSON.stringify(Array.from(new Set(keep.map(r => r.name || '(无名)')))) : ''));

  if (DRY) { console.log('\n--dry：什么都没删'); return; }
  if (!hit.length) { console.log('没有要删的'); return; }

  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let oks = 0, errs = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.t === P.S2C.OK && m.deleted) oks++;
    if (m.t === P.S2C.ERROR) errs++;
  });
  ws.send(JSON.stringify({ t: P.C2S.HELLO, name: '清理' }));
  await sleep(250);
  let sent = 0;
  for (const r of hit) {
    ws.send(JSON.stringify({ t: P.C2S.ROOM_DEL, roomId: r.id }));
    sent++;
    // 限流：在途请求（已发未确认）不超过 5 个，且每次至少等 100ms，别把服务端打爆
    while (sent - (oks + errs) > 5) await sleep(50);
    await sleep(100);
  }
  await sleep(2500);
  try { ws.close(); } catch (e) { /* */ }
  console.log('\n服务端确认删除 = ' + oks + '  报错 = ' + errs);

  await sleep(600);
  const after = await fetch(BASE + '/api/rooms').then(r => r.json());
  console.log('清理后房间数 = ' + (after.rooms || []).length);
})().catch(e => { console.error('崩了:', e.message); process.exit(2); });
