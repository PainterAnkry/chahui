/**
 * 茶绘 · 接龙「私密作画」验收（虚拟客户端，不需要浏览器）
 *
 * 用法：
 *   GAME_CHAIN_WRITE_MS=2500 GAME_CHAIN_DRAW_MS=8000 GAME_CHAIN_REPLAY_MS=4000 \
 *     PORT=8444 node server/src/index.js
 *   node tools/test-chain-private.js ws://localhost:8444/ws
 *
 * 为什么要单独一个文件：接龙的「作画」这一步是**并行多条链**，一圈里可能有好几个人
 * 同时要画，而且画的还是不同的链。可房间只有一块画布 —— 一旦照常广播，两个后果都足以
 * 把玩法毁掉：
 *   ① 大家能实时看见别人正在画什么（下一位猜词的人等于提前拿到答案）
 *   ② 每个人的 exportPNG 导出的是所有人叠在一起的画面，交上去的作品全是同一张
 *
 * 覆盖的断言：
 *   ① 笔迹只回给作者：别人一条 STROKE_BEGIN / STROKE_POINTS 都收不到
 *   ② 中途进房 / 重连也拿不到别人的私密笔迹（HISTORY 按人裁剪）
 *   ③ 私密作画期间光标不广播（免得暗示「有人正在那张画上落笔」）
 *   ④ 清空画布只清自己那几笔，不会把别人正在画的抹掉
 *   ⑤ 私密化没有把玩法弄坏：作画结束后链条照常往下走
 */
'use strict';

const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = (function () {
  const a = process.argv[2] || 'ws://localhost:8444/ws';
  if (/^https?:\/\//i.test(a)) {
    const u = new URL(a);
    u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
    if (!/\/ws$/.test(u.pathname)) u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws';
    return u.toString();
  }
  return a;
})();

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    failures.push(name + (extra ? ' \u2192 ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' \u2192 ' + extra : ''));
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond, timeout, label) {
  const t0 = Date.now();
  const limit = timeout || 6000;
  while (Date.now() - t0 < limit) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(20);
  }
  if (label) console.log('    （超时：' + label + '）');
  return false;
}

function httpBase() {
  return URL_.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws\/?$/, '');
}

function httpJson(pathname) {
  return new Promise((resolve) => {
    const mod = /^https:/.test(httpBase()) ? require('https') : require('http');
    const req = mod.get(httpBase() + pathname, { timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function Client(name) {
  const ws = new WebSocket(URL_);
  const c = {
    name, ws, log: [], room: null, you: null, hist: null,
    gstate: null, task: null, open: false, closed: false
  };
  ws.on('open', () => { c.open = true; });
  ws.on('close', () => { c.closed = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) {
      // ⚠️ `history` 是 ROOM_JOINED 的**顶层**字段，不在 `room` 里。
      //    重连（RESYNC）回的还是 ROOM_JOINED，所以这里也顺手更新 —— 两处共用一份。
      c.room = m.room; c.you = m.you; c.hist = m.history || null;
      if (m.game) c.gstate = m.game;
    }
    if (m.t === P.S2C.GAME_STATE) c.gstate = m.game;
    if (m.t === P.S2C.GAME_TASK) c.task = m.task;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  c.phase = () => (c.gstate ? c.gstate.phase : '');
  c.close = () => ws.close();
  return c;
}

/** 从某个下标起收到的某类消息（避免把整局流水混进来） */
function tail(c, idx, t) { return c.log.slice(idx).filter(m => m.t === t); }
/** 从某个下标起的全部流水（查「某个 id 有没有出现过」用） */
function tailText(c, idx) { return JSON.stringify(c.log.slice(idx)); }

/** 造一张「画」：接龙只要求是个合法 dataURL PNG，服务端只做哑存储 */
function fakePng(tag) {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  return 'data:image/png;base64,' + b64 + '#' + tag;
}

const CLIENTS = [];
async function connect(name) {
  const c = Client(name);
  const up = await waitFor(() => c.open, 4000, name + ' 连接');
  if (!up) throw new Error(name + ' 连不上 ' + URL_);
  CLIENTS.push(c);
  return c;
}

/** 画一笔（笔迹 id 由调用方指定，便于断言「谁的笔跑到了谁那儿」） */
function drawStroke(c, id) {
  c.send(P.C2S.STROKE_BEGIN, {
    id, layerId: '', tool: 'brush', color: '#ff0000', size: 12, opacity: 1, seed: 1
  });
  c.send(P.C2S.STROKE_POINTS, { id, pts: [[100, 100, 0.5], [220, 260, 0.5], [360, 420, 0.5]] });
  c.send(P.C2S.STROKE_END, { id });
}

async function main() {
  const roomId = 'cpriv_' + Date.now().toString(36).slice(-6);
  console.log('接龙 · 私密作画验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  /* -------- 先验身份：端口上挂着的必须是我要的那台服务端 -------- */
  const info = await httpJson('/api/share');
  if (!info || !info.chain) {
    console.log('无法从 ' + httpBase() + '/api/share 读到接龙配置，请先启动服务端：');
    console.log('  GAME_CHAIN_WRITE_MS=2500 GAME_CHAIN_DRAW_MS=8000 GAME_CHAIN_REPLAY_MS=4000 \\');
    console.log('    PORT=8444 node server/src/index.js');
    process.exit(1);
  }
  console.log('服务端 pid=' + info.pid + '  接龙计时 ' + info.chain.WRITE_MS + '/' + info.chain.DRAW_MS
    + '/' + info.chain.REPLAY_MS + 'ms\n');
  // 作画窗口要留得下「画 4 笔 + 新拉一个连接 + 断言」这点活。窗口太短这条用例会变成随机绿。
  if (info.chain.DRAW_MS < 3500) {
    console.log('✗ 作画窗口只有 ' + info.chain.DRAW_MS + 'ms，太短：本节要在窗口内新拉一个连接，'
      + '窗口一过阶段就推进了，断言会假绿。');
    console.log('  请用 GAME_CHAIN_DRAW_MS=8000 另起一个端口再跑。');
    process.exit(1);
  }

  const A = await connect('房主');
  A.send(P.C2S.ROOM_CREATE, { id: roomId, name: '私密作画验收', user: '房主' });
  if (!await waitFor(() => A.room && A.room.id === roomId, 4000, 'ROOM_JOINED')) {
    console.log('房间没建起来'); process.exit(1);
  }
  const B = await connect('小红');
  const C = await connect('小明');
  const D = await connect('小刚');
  B.send(P.C2S.ROOM_JOIN, { roomId, user: '小红' });
  C.send(P.C2S.ROOM_JOIN, { roomId, user: '小明' });
  D.send(P.C2S.ROOM_JOIN, { roomId, user: '小刚' });
  const players = [A, B, C, D];
  // ⚠️ 必须等房间真的满 4 人再开局：四个连接是独立的，A 的 GAME_START 完全可能
  //    抢在别人 ROOM_JOIN 之前到达服务端 —— 那时人数不足，开局被静默拒绝，
  //    后面所有断言都在空数组上 .every() 假绿（这条用例第一版就是这么栽的）。
  const full = await waitFor(() => {
    const m = A.last(P.S2C.MEMBERS);
    return m && m.members.length === 4 && players.every(c => !!c.room);
  }, 6000, '房间满 4 人');
  if (!full) { console.log('房间没凑齐 4 人，无法继续'); process.exit(1); }

  /* ================= [1] 开局 → 写词 → 作画 ================= */
  console.log('[1] 走到「作画」这一步');
  A.send(P.C2S.GAME_START, { mode: 'chain', rounds: 3 });
  const inWrite = await waitFor(() => players.every(c => c.phase() === 'chain_write'), 6000, '写词阶段');
  ok('四个人都进入写词阶段', inWrite,
    'phase=' + players.map(c => c.phase()).join(',') + '  最后一条错误='
    + JSON.stringify(A.last(P.S2C.ERROR)));
  if (!inWrite) { console.log('开局没走起来，无法继续；先看上面那条错误'); process.exit(1); }
  ok('每个人这一格都有活（4/4）',
    players.every(c => c.gstate && c.gstate.stepTotal === 4),
    players.map(c => c.gstate && c.gstate.stepTotal).join(','));

  players.forEach(c => c.send(P.C2S.GAME_SUBMIT, { text: '长颈鹿' }));
  const inDraw = await waitFor(() => players.every(c => c.phase() === 'chain_draw'), 8000, '作画阶段');
  ok('全部交齐后进入作画阶段', inDraw, 'phase=' + players.map(c => c.phase()).join(','));
  const drawers = players.filter(c => c.task && c.task.step === 'draw');
  ok('这一圈每个人都在画（4 条链并行作画）', drawers.length === 4,
    '作画人数=' + drawers.length + '  phase=' + A.phase());
  // 下面一堆断言都是 .every() —— 空数组恒真。必须先确认「确实有 4 个画手」，
  // 否则一旦没走到作画阶段，这一整节会齐刷刷假绿。
  if (drawers.length !== 4) { console.log('没凑齐 4 个并行作画的人，无法继续'); process.exit(1); }

  /* ================= [2] 笔迹只回给作者 ================= */
  console.log('\n[2] 并行作画：谁的笔都不会跑到别人屏幕上');
  const ids = new Map(drawers.map((c, i) => [c, 'pst_' + i + '_' + Date.now().toString(36).slice(-4)]));
  const marks = new Map(drawers.map(c => [c, c.log.length]));
  drawers.forEach(c => drawStroke(c, ids.get(c)));
  // 等每一笔都在作者那儿落地（STROKE_END 的回执只发给发起者）
  const allEnded = await waitFor(() => drawers.every(c =>
    tail(c, marks.get(c), P.S2C.STROKE_END).some(m => m.id === ids.get(c))), 4000, '各自的 STROKE_END 回执');
  ok('每一笔都拿到了属于作者自己的 STROKE_END 回执', allEnded);

  const ownEnd = drawers.every(c => {
    const ends = tail(c, marks.get(c), P.S2C.STROKE_END);
    return ends.length === 1 && ends[0].id === ids.get(c);
  });
  ok('每人只收到自己那一条 STROKE_END（没有别人的）', ownEnd,
    drawers.map(c => c.name + ':' + JSON.stringify(tail(c, marks.get(c), P.S2C.STROKE_END).map(m => m.id)))
      .join('  '));

  const noBegin = drawers.every(c => tail(c, marks.get(c), P.S2C.STROKE_BEGIN).length === 0);
  ok('★ 私密作画期间 STROKE_BEGIN 一条都没广播出去（#4 回归）', noBegin,
    drawers.map(c => c.name + ':' + tail(c, marks.get(c), P.S2C.STROKE_BEGIN).length).join('  '));

  const noPoints = drawers.every(c => tail(c, marks.get(c), P.S2C.STROKE_POINTS).length === 0);
  ok('★ 私密作画期间 STROKE_POINTS 一条都没广播出去（#4 回归）', noPoints,
    drawers.map(c => c.name + ':' + tail(c, marks.get(c), P.S2C.STROKE_POINTS).length).join('  '));

  // 最狠的一条：把别人的笔迹 id 拿去全文搜 —— 只要出现过就是漏了
  const leaked = [];
  for (const c of drawers) {
    const txt = tailText(c, marks.get(c));
    for (const o of drawers) {
      if (o === c) continue;
      if (txt.indexOf(ids.get(o)) >= 0) leaked.push(c.name + ' 看见了 ' + o.name + ' 的笔迹');
    }
  }
  ok('★ 没有任何人的笔迹 id 出现在别人的消息流里（#4 回归）', leaked.length === 0, leaked.join('；'));

  /* ================= [3] 中途进房 / 重连也拿不到别人的私密笔迹 ================= */
  console.log('\n[3] 中途进房与重连：历史笔迹按人裁剪');
  const E = await connect('迟到者');
  E.send(P.C2S.ROOM_JOIN, { roomId, user: '迟到者' });
  const joined = await waitFor(() => E.room && E.room.id === roomId, 4000, '迟到者入房');
  ok('作画中进来的新人成功入房', joined);
  const eCount = E.hist ? E.hist.count : -1;
  ok('★ 新人入房时历史笔迹数是 0（看不到别人正在画的东西）（#4 回归）', eCount === 0,
    'history.count=' + eCount);
  ok('新人收到的 HISTORY_CHUNK 里也没有别人的笔迹',
    E.msgs(P.S2C.HISTORY_CHUNK).every(m => !Array.isArray(m.strokes) || m.strokes.length === 0),
    JSON.stringify(E.msgs(P.S2C.HISTORY_CHUNK).map(m => (m.strokes || []).length)));

  // 重连 / RESYNC 走的是另一条通路（index.js 里两处 strokesFor），得分别验
  const resyncMark = A.log.length;
  A.send(P.C2S.RESYNC, {});
  await waitFor(() => tail(A, resyncMark, P.S2C.ROOM_JOINED).length > 0, 4000, 'RESYNC 回执');
  const rj = tail(A, resyncMark, P.S2C.ROOM_JOINED).pop();
  ok('画手 RESYNC 后只拿回自己那 1 笔（不是全场 4 笔）',
    !!rj && !!rj.history && rj.history.count === 1,
    rj ? 'count=' + (rj.history || {}).count : '没有 ROOM_JOINED');
  const rs = tail(A, resyncMark, P.S2C.HISTORY_CHUNK)
    .reduce((n, m) => n + ((m.strokes || []).length), 0);
  ok('RESYNC 下来的笔迹也确实只有 1 笔', rs === 1, 'chunks 合计=' + rs);

  /* ================= [4] 光标不广播 ================= */
  console.log('\n[4] 私密作画期间光标不广播');
  const curMark = players.map(c => c.log.length);
  drawers.forEach((c, i) => c.send(P.C2S.CURSOR, { x: 100 + i * 10, y: 200, active: true, tool: 'brush' }));
  await sleep(350);
  const cursorLeak = players.filter((c, i) => tail(c, curMark[i], P.S2C.CURSOR).length > 0);
  ok('★ 作画期间没有人收到 CURSOR（免得暗示「有人正在那张画上落笔」）（#5 回归）',
    cursorLeak.length === 0,
    cursorLeak.map(c => c.name + ':' + tail(c, curMark[players.indexOf(c)], P.S2C.CURSOR).length).join('  '));

  /* ================= [5] 清空只清自己那几笔 ================= */
  console.log('\n[5] 「清空」只清自己正在画的那几笔');
  const clearMark = drawers.map(c => c.log.length);
  drawers[0].send(P.C2S.STROKE_CLEAR, { scope: 'all' });
  await sleep(350);
  const receipt = tail(drawers[0], clearMark[0], P.S2C.STROKE_REMOVED).pop();
  ok('发起者收到「已清掉」的回执', !!receipt && receipt.reason === 'clear',
    JSON.stringify(receipt && { reason: receipt.reason, removed: receipt.removed }));
  const othersHeard = drawers.slice(1)
    .filter((c, i) => tail(c, clearMark[i + 1], P.S2C.STROKE_REMOVED).length > 0);
  ok('别人完全不知道有人清过画（回执不外发）', othersHeard.length === 0,
    othersHeard.map(c => c.name).join('、'));

  // 别人那几笔必须还在：各自 RESYNC 一下数一数
  const probeMarks = drawers.map(c => c.log.length);
  drawers.forEach(c => c.send(P.C2S.RESYNC, {}));
  await waitFor(() => drawers.every((c, i) => tail(c, probeMarks[i], P.S2C.ROOM_JOINED).length > 0),
    4000, '各自 RESYNC');
  const counts = drawers.map((c, i) => {
    const m = tail(c, probeMarks[i], P.S2C.ROOM_JOINED).pop();
    return { name: c.name, n: m && m.history ? m.history.count : -1 };
  });
  ok('清空者自己的笔被清掉了', counts[0].n === 0, JSON.stringify(counts[0]));
  ok('其他三个人的笔一笔没少（没有被连坐抹掉）',
    counts.slice(1).every(x => x.n === 1), JSON.stringify(counts));

  /* ================= [6] 私密化没把玩法弄坏 ================= */
  console.log('\n[6] 作画这一步照常收尾、链条照常往下走');
  const prevRound = A.gstate.round;
  drawers.forEach((c, i) => c.send(P.C2S.GAME_ART, { png: fakePng('drawer' + i) }));
  const advanced = await waitFor(() => players.every(c => c.phase() !== 'chain_draw'), 8000, '离开作画阶段');
  ok('四个人都交作品后这一步就结束了', advanced,
    'phase=' + A.phase() + ' round=' + (A.gstate && A.gstate.round));
  ok('推进到了下一圈 / 下一阶段', (A.gstate && A.gstate.round) > prevRound || A.phase() === 'chain_guess',
    'round ' + prevRound + ' → ' + (A.gstate && A.gstate.round) + '  phase=' + A.phase());

  // 作画这一步首尾都会清画布 → 私密笔迹不会活到下一步
  const F = await connect('后来的人');
  F.send(P.C2S.ROOM_JOIN, { roomId, user: '后来的人' });
  await waitFor(() => F.room && F.room.id === roomId, 4000, '后来的人入房');
  const fCount = F.hist ? F.hist.count : -1;
  ok('下一步进来的人一笔都看不到（作画结束清了画布）', fCount === 0, 'history.count=' + fCount);

  /* ================= [7] 收尾 ================= */
  console.log('\n[7] 收尾');
  A.send(P.C2S.GAME_STOP, {});
  ok('房主结束游戏后回到自由绘画',
    await waitFor(() => players.every(c => c.phase() === 'off'), 6000, 'phase=off'));
  A.send(P.C2S.ROOM_DESTROY, {});
  ok('房间可以正常解散',
    await waitFor(() => CLIENTS.every(c => c.msgs(P.S2C.ROOM_DESTROYED).length > 0), 5000));
  CLIENTS.forEach(c => c.close());

  console.log('\n' + '─'.repeat(46));
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (fail) {
    console.log('  失败项：');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('─'.repeat(46));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
