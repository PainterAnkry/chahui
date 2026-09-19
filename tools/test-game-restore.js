/**
 * 游戏结束还原原画（「游戏模式覆盖原画面」的回归）
 *
 * 流程：
 *   A 建房 → A 画一笔(pre1) → B 进房（收到 pre1 的历史）
 *   → A 开局 → 画布被清（游戏用）→ 画手画 game1
 *   → 房主结束游戏 → 画布再清 + 历史重发：pre1 回来、game1 消失
 *   → 再开一局（rounds:1，压缩计时走完整局）→ 自然打完（finish 路径）→ pre1 再回来
 *
 * 用法：先用压缩计时起服务端，再跑本脚本
 *   GAME_PICK_MS=1200 GAME_ROUND_MS=2500 GAME_ROUND_END_MS=800 PORT=8441 node server/src/index.js
 *   node tools/test-game-restore.js http://127.0.0.1:8441
 */
'use strict';
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = (function () {
  const a = process.argv[2] || 'http://127.0.0.1:8441';
  const u = new URL(a);
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  if (!/\/ws$/.test(u.pathname)) u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws';
  return u.toString();
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 5000)) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(40);
  }
  if (label) console.log('    （超时：' + label + '）');
  return false;
}
function httpBase() { return URL_.replace(/^ws:/, 'http:').replace(/\/ws\/?$/, ''); }
function httpJson(pathname) {
  return new Promise((resolve) => {
    require('http').get(httpBase() + pathname, { timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function Client(name) {
  const ws = new WebSocket(URL_);
  const c = { name, ws, log: [], room: null, you: null, gstate: null, word: '', open: false };
  ws.on('open', () => { c.open = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) { c.room = m.room; c.you = m.you; if (m.game) c.gstate = m.game; }
    if (m.t === P.S2C.GAME_STATE) c.gstate = m.game;
    if (m.t === P.S2C.GAME_WORD) c.word = m.word;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  c.phase = () => (c.gstate ? c.gstate.phase : '');
  c.close = () => ws.close();
  /** 历史里某 id 的笔迹出现过几次（含重发） */
  c.histHits = (id) => c.msgs(P.S2C.HISTORY_CHUNK)
    .reduce((n, m) => n + (m.strokes || []).filter(s => s.id === id).length, 0);
  /** 收到过几次「全画布清空」 */
  c.clears = () => c.msgs(P.S2C.STROKE_REMOVED).filter(m => m.reason === 'clear' && (m.scope || 'all') === 'all');
  return c;
}

function strokeInfo(id, extra) {
  return Object.assign({ id, layerId: '', tool: 'brush', color: '#ff0000', size: 12, opacity: 1, seed: 7 }, extra || {});
}
async function drawStroke(c, id) {
  c.send(P.C2S.STROKE_BEGIN, strokeInfo(id));
  await sleep(80);
  c.send(P.C2S.STROKE_POINTS, { id, pts: [[100, 100, 0.5], [200, 180, 0.5]] });
  await sleep(80);
  c.send(P.C2S.STROKE_END, { id });
  await sleep(120);
}

(async () => {
  const roomId = 'grestore_' + Date.now().toString(36).slice(-6);
  console.log('游戏还原原画 · 验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  const info = await httpJson('/api/share');
  if (!info || !info.game) {
    console.log('读不到 /api/share，请先用压缩计时起服务端：');
    console.log('  GAME_PICK_MS=1200 GAME_ROUND_MS=2500 GAME_ROUND_END_MS=800 PORT=8441 node server/src/index.js');
    process.exit(1);
  }
  if (info.game.ROUND_MS >= 10000) {
    console.log('✗ 这台服务端是默认计时，不是压缩计时（可能挂着旧进程）。');
    process.exit(1);
  }

  const A = Client('房主');
  const B = Client('小红');
  await waitFor(() => A.open && B.open, 5000, '连接');

  /* [1] 建房 + 开局前画一笔 */
  console.log('[1] 建房与开局前内容');
  A.send(P.C2S.ROOM_CREATE, { id: roomId, name: '还原验收', user: '房主' });
  ok('房主建好房间', await waitFor(() => A.room && A.room.id === roomId, 4000, 'ROOM_JOINED'));
  await drawStroke(A, 'pre1');
  B.send(P.C2S.ROOM_JOIN, { roomId, user: '小红' });
  ok('B 进房', await waitFor(() => B.room && B.room.id === roomId, 4000, 'B JOIN'));
  ok('B 收到开局前的 pre1', B.histHits('pre1') === 1, 'hits=' + B.histHits('pre1'));

  /* [2] 开局：画布清空给游戏用 */
  console.log('\n[2] 开局清画布');
  A.send(P.C2S.GAME_START, { rounds: 1, drawSeconds: 60 });
  ok('开局成功', await waitFor(() => A.gstate && (A.phase() === 'pick' || A.phase() === 'draw'), 4000, '开局'));
  ok('双方都收到全画布清空', await waitFor(() => A.clears().length >= 1 && B.clears().length >= 1, 3000, 'clear 广播'));
  const drawer = [A, B].find(c => c.gstate && c.gstate.isDrawer);
  ok('有画手', !!drawer, 'drawer=' + (drawer && drawer.name));

  /* [3] 画手选词 + 画游戏的笔 */
  console.log('\n[3] 画手作画');
  if (drawer.phase() === 'pick') {
    drawer.send(P.C2S.GAME_PICK, { index: 0 });
    await waitFor(() => drawer.phase() === 'draw', 4000, '选词');
  }
  ok('画手进入作画', drawer.phase() === 'draw');
  await drawStroke(drawer, 'game1');
  ok('游戏笔迹被服务端接受', await waitFor(() => {
    const other = drawer === A ? B : A;
    return other.msgs(P.S2C.STROKE_BEGIN).some(m => m.stroke && m.stroke.id === 'game1');
  }, 4000, 'game1 广播'));

  /* [4] 房主结束游戏 → 原画还原 */
  console.log('\n[4] 结束游戏还原');
  const clearsBefore = A.clears().length;
  const aHits0 = A.histHits('pre1'), bHits0 = B.histHits('pre1');
  A.send(P.C2S.GAME_STOP, {});
  ok('结束游戏后再次清空画布', await waitFor(() => A.clears().length > clearsBefore && B.clears().length > clearsBefore, 4000, 'stop clear'));
  ok('pre1 被重发回来（A）', await waitFor(() => A.histHits('pre1') > aHits0, 4000, 'A pre1'),
    'hits=' + A.histHits('pre1') + ' base=' + aHits0);
  ok('pre1 被重发回来（B）', await waitFor(() => B.histHits('pre1') > bHits0, 4000, 'B pre1'),
    'hits=' + B.histHits('pre1') + ' base=' + bHits0);
  ok('游戏期的 game1 没有混进还原历史', A.histHits('game1') === 0 && B.histHits('game1') === 0,
    'A=' + A.histHits('game1') + ' B=' + B.histHits('game1'));
  ok('双方状态回到 off', await waitFor(() => A.phase() === 'off' && B.phase() === 'off', 3000, 'off'));

  /* [5] 再开一局，走自然打完（finish 路径）。不传 drawSeconds → 用服务端压缩计时 */
  console.log('\n[5] 自然打完也还原');
  A.send(P.C2S.GAME_START, { rounds: 1 });
  ok('第二局开局', await waitFor(() => A.gstate && (A.phase() === 'pick' || A.phase() === 'draw'), 4000, '二局'));
  const drawer2 = [A, B].find(c => c.gstate && c.gstate.isDrawer);
  if (drawer2 && drawer2.phase() === 'pick') {
    drawer2.send(P.C2S.GAME_PICK, { index: 0 });
    await waitFor(() => drawer2.phase() === 'draw', 4000, '选词2');
  }
  // 什么都不画，等压缩计时把回合和整局走完
  const pre1Before = A.histHits('pre1'), bBefore2 = B.histHits('pre1');
  const finished = await waitFor(() => A.phase() === 'over' || A.phase() === 'off', 30000, '自然打完');
  ok('整局自然结束', finished, 'phase=' + A.phase());
  ok('打完后 pre1 再次还原', await waitFor(() => A.histHits('pre1') > pre1Before, 6000, 'finish 还原'),
    'hits=' + A.histHits('pre1') + ' before=' + pre1Before);
  ok('B 也收到还原', await waitFor(() => B.histHits('pre1') > bBefore2, 4000, 'B finish 还原'),
    'hits=' + B.histHits('pre1') + ' before=' + bBefore2);

  A.send(P.C2S.GAME_STOP, {});
  await sleep(300);
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  A.close(); B.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
