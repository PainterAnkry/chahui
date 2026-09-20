/**
 * 接龙 · 数据流（**真 WebSocket 层**，不碰 DOM）
 *
 * 守的是当前这一版（v12）用户明确要求的几条：
 *   [1] **8 步传递模型**：链长 = 2 × 组人数，每人连续两格 ——
 *       4 人房（1 组）= k0 起词A · k1 画A · k2 猜B · k3 画B · k4 猜C · k5 画C · k6 猜D · k7 画D
 *       （**每人猜完立刻画自己猜出来的词，然后才传给下一个人**）
 *   [2] **起词绝不为空**：倒计时到点就在三个候选里随机补，并标 auto
 *   [3] 回放严格按 起词→画→猜→画…，作者序列 = A,A,B,B,C,C,D,D（按环序）
 *   [4] 回放棒次由**服务端**同步（revealStep / revealLegs / legHoldMs）
 *   [5] 一条链回放完投票：起词 → 最终猜词；**按链串行**（不能给别的链投票）
 *   [6] **v12 分组**：8 人 → 2 组各 4 人、链长 8（不是 16）、组内传遍、8 格跑满
 *
 * 用法: node tools/test-chain-serial.js [http://127.0.0.1:8448]
 *   ⚠ 需要一台**压缩计时**的服务端（推荐直接 GAME_FAST=1）：
 *     PORT=8448 GAME_FAST=1 DATA_DIR=<临时目录> node server/src/index.js
 *   或者逐项压（照 v10 的写法）：
 *     PORT=8448 GAME_CHAIN_WRITE_MS=3000 GAME_CHAIN_DRAW_MS=4000 \
 *       GAME_CHAIN_GUESS_MS=3000 GAME_CHAIN_REVEAL_MS=2500 GAME_CHAIN_VOTE_MS=3000 \
 *       GAME_CHAIN_SCORE_MS=1500 GAME_CHAIN_CHAIN_SCORE_MS=1200 \
 *       DATA_DIR=<临时目录> node server/src/index.js
 */
'use strict';
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const P = require(R('shared/protocol'));
const WebSocket = require(R('server/node_modules/ws'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8448').replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n + (x !== undefined ? '   ' + x : '')); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '   ' + JSON.stringify(x) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function Client(nick) {
  const ws = new WebSocket(WS_URL);
  const c = { nick, ws, log: [], room: null, you: null, layers: [], task: null, game: null, reveal: null };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) { c.room = m.room; c.you = m.you; c.layers = m.layers || []; if (m.game) c.game = m.game; }
    if (m.t === P.S2C.GAME_STATE) c.game = m.game;
    if (m.t === P.S2C.GAME_TASK) c.task = m.task;
    if (m.t === P.S2C.GAME_REVEAL) c.reveal = m.chains;
  });
  c.send = (t, p) => { try { ws.send(JSON.stringify(Object.assign({ t }, p || {}))); } catch (e) { /* */ } };
  c.phase = () => (c.game && c.game.phase) || null;
  c.step = () => (c.task && c.task.step) || '';
  c.errors = () => c.log.filter(m => m.t === P.S2C.ERROR).map(m => m.code);
  c.lastErr = () => { const e = c.log.filter(m => m.t === P.S2C.ERROR); return e.length ? e[e.length - 1] : null; };
  c.chats = () => c.log.filter(m => m.t === P.S2C.CHAT).map(m => m.text);
  c.waitFor = async (pred, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { if (pred(c)) return true; await sleep(50); }
    return false;
  };
  return c;
}
function connect(nick) {
  return new Promise((res, rej) => {
    const c = Client(nick);
    c.ws.on('open', () => res(c));
    c.ws.on('error', rej);
    setTimeout(() => rej(new Error('连接超时')), 8000);
  });
}
const waitAll = async (all, pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    if (all.every(c => pred(c))) return true;
    await sleep(40);
  }
  return false;
};

/** 8 步模型的类型序（0 起：写词 → 画 → 猜 → 画 → 猜 → 画 → 猜 → 画） */
const WANT_TYPES = ['WORD', 'DRAWING', 'GUESS', 'DRAWING', 'GUESS', 'DRAWING', 'GUESS', 'DRAWING'];

/** 建一个房 + n 个客户端；返回 { host, all, roomId } */
async function makeRoom(nicks) {
  const host = await connect(nicks[0]);
  host.send(P.C2S.HELLO, { name: nicks[0] });
  await sleep(150);
  host.send(P.C2S.ROOM_CREATE, { name: '接龙数据流', width: 1600, height: 1000, background: '#ffffff' });
  if (!await host.waitFor(c => c.room, 6000)) throw new Error('建房失败');
  const roomId = host.room.id;
  const all = [host];
  for (const n of nicks.slice(1)) {
    const c = await connect(n);
    c.send(P.C2S.HELLO, { name: n });
    await sleep(100);
    c.send(P.C2S.ROOM_JOIN, { roomId, user: { name: n } });
    if (!await c.waitFor(x => x.room, 6000)) throw new Error(n + ' 进房失败');
    all.push(c);
  }
  await sleep(400);
  return { host, all, roomId };
}

/**
 * ★ 跑满一整局：每一格等全员拿到题面 → 按类型提交 → 等收格。
 * 返回 { stepLog, ok }
 */
async function playWholeGame(all, k0) {
  const host = all[0];
  const stepLog = [];
  let good = true;
  for (let k = k0 || 1; k < 8; k++) {
    if (!await waitAll(all, c => c.step() === WANT_TYPES[k], 12000)) {
      good = false;
      ok('第 ' + (k + 1) + ' 格（' + WANT_TYPES[k] + '）全员收到题面', false, all.map(c => c.phase() + '/' + c.step()));
      break;
    }
    stepLog.push({ k, type: WANT_TYPES[k], phase: host.phase() });
    if (WANT_TYPES[k] === 'DRAWING') {
      const layerId = host.layers[host.layers.length - 1].id;
      all.forEach((c, i) => {
        const id = 's' + k + '_' + i + '_' + Date.now().toString(36);
        c.send(P.C2S.STROKE_BEGIN, { id, layerId, tool: 'brush', color: '#112233', size: 20, opacity: 1 });
        c.send(P.C2S.STROKE_POINTS, { id, pts: [[100 + i * 30, 100, 0.5], [200 + i * 30, 200, 0.5]] });
        c.send(P.C2S.STROKE_END, { id });
      });
      await sleep(250);
      all.forEach(c => c.send(P.C2S.GAME_SUBMIT, {}));
    } else {
      all.forEach(c => c.send(P.C2S.GAME_SUBMIT, { text: '猜' + (k + 1) + '_' + c.nick }));
    }
    if (!await waitAll(all, c => c.step() !== WANT_TYPES[k] || c.phase() === 'chain_reveal', 12000)) {
      good = false;
      ok('第 ' + (k + 1) + ' 格收格后继续往下走', false, all.map(c => c.phase()));
      break;
    }
  }
  return { stepLog, good };
}

(async () => {
  const share = await fetch(BASE + '/api/share').then(r => r.json()).catch(() => null);
  if (!share || !share.chain) { console.error('读不到 /api/share'); process.exit(2); }
  console.log('接龙数据流 @ ' + WS_URL + '   服务端 pid=' + share.pid + ' fast=' + share.fast);
  if (share.chain.WRITE_MS > 8000) {
    console.error('✗ 写词窗口太长，这条用例跑不完。请用压缩计时的服务端（见文件头）。');
    process.exit(2);
  }

  /* ================= A. 4 人房（1 组，v11 回归线） ================= */
  console.log('\n=== A. 4 人房：1 组 · 链长 8 · 8 步跑满 ===');
  const A = await makeRoom(['甲', '乙', '丙', '丁']);
  const host = A.host, all = A.all;
  host.send(P.C2S.GAME_START, { mode: 'chain', theme: 'default' });
  await sleep(400);
  ok('★ 4 人房链长默认 = 2 × 人数 = 8', host.game && host.game.chainLength === 8, host.game && host.game.chainLength);
  all.forEach(c => c.send(P.C2S.GAME_READY, { ready: true }));
  ok('全员准备后进入开场鼓点', await host.waitFor(c => c.phase() === 'chain_init', 6000), host.phase());
  ok('鼓点结束进入写词', await host.waitFor(c => c.phase() === 'chain_write', 12000), host.phase());

  console.log('\n[1] 写起词：每人各写各的，第 4 个人故意不交（走超时补词）');
  ok('每个人都拿到了候选词',
    all.every(c => c.task && c.task.step === 'WORD' && (c.task.choices || []).length >= 3),
    all.map(c => (c.task && (c.task.choices || []).length) || 0));
  const words = {};
  for (const c of all.slice(0, 3)) {
    const w = (c.task.choices || [])[0];
    words[c.you.userId] = w;
    c.send(P.C2S.GAME_SUBMIT, { text: w });
  }
  const idleChoices = (all[3].task.choices || []).slice();
  ok('第 4 个人故意不交（等倒计时随机补）', idleChoices.length >= 3, idleChoices.length);
  ok('三人交齐不会立刻收格（还有一个人没交）',
    !(await host.waitFor(c => c.phase() === 'chain_draw', 1200)), host.phase());
  ok('★ 倒计时到点自动收格进作画', await host.waitFor(c => c.phase() === 'chain_draw', 12000), host.phase());
  ok('收格后链数 = 人数（每步 4 格并行的 progress）',
    host.game && host.game.stepTotal === 4 && host.game.chainLength === 8,
    JSON.stringify({ total: host.game && host.game.stepTotal, len: host.game && host.game.chainLength }));

  console.log('\n[2] ★ 4 人房跑满 8 格');
  const p1 = await playWholeGame(all, 1);
  ok('★ 4 人房真的跑满了 8 格（每一步都推到了）', p1.good && p1.stepLog.length === 7,
    p1.stepLog.map(s => (s.k + 1) + ':' + s.type).join(' '));
  ok('★ 全员进回放', await waitAll(all, c => c.phase() === 'chain_reveal', 12000), all.map(c => c.phase()));

  console.log('\n[3] ★ 回放：类型序列 = 词,画,猜,画,猜,画,猜,画 · 作者序列 = A,A,B,B,C,C,D,D');
  ok('回放数据已广播（4 条链）', Array.isArray(host.reveal) && host.reveal.length === 4,
    host.reveal && host.reveal.length);
  const c0 = host.reveal && host.reveal[0];
  ok('★ 第 1 条链的 8 格类型序列 = WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING',
    c0 && c0.steps.map(s => s.type).join(',') === WANT_TYPES.join(','),
    c0 && c0.steps.map(s => s.type).join(','));
  ok('★ 每条链都收满 8 格（没有空洞）',
    host.reveal.every(r => r.steps.length === 8 && r.steps.every(Boolean)),
    host.reveal.map(r => r.steps.length));
  const ring = (host.game && host.game.ring) || null;
  if (ring && ring.length === 4) {
    const base = ring.indexOf(c0.ownerPlayerId);
    const offOk = host.reveal.every(r => {
      const b = ring.indexOf(r.ownerPlayerId);
      return r.steps.every((s, k) => s.playerId === ring[(b + Math.floor(k / 2)) % 4]);
    });
    const letter = {};
    [0, 1, 2, 3].forEach((j, i) => { letter[ring[(base + j) % 4]] = ['A', 'B', 'C', 'D'][i]; });
    const gotSeq = c0.steps.map(s => letter[s.playerId] || '?').join(',');
    console.log('  环序 = ' + [0, 1, 2, 3].map(j => letter[ring[(base + j) % 4]] + '(' + ring[(base + j) % 4] + ')').join(' → ')
      + ' → ' + gotSeq);
    ok('★ 第 1 条链的作者序列 = A,A,B,B,C,C,D,D（按环序）', gotSeq === 'A,A,B,B,C,C,D,D', gotSeq);
    ok('★ 4 条链都遵守 authorOffset(k) = floor(k/2)', offOk);
  } else {
    ok('★ 服务端快照带出了 ring（用来验作者序列）', false, JSON.stringify(ring));
  }
  ok('★ 起词非空（绝不允许出现空的首格）',
    host.reveal.every(r => typeof r.firstWord === 'string' && r.firstWord.length > 0),
    host.reveal.map(r => r.firstWord));
  ok('★ 补出来的起词被标了 auto（不是本人写的）',
    host.reveal.some(r => r.steps[0].auto === true), host.reveal.map(r => !!r.steps[0].auto));
  void words; void idleChoices;

  console.log('\n[4] ★ 回放棒次（revealStep / revealLegs / legHoldMs / legMs）由服务端推');
  ok('★ 快照带 revealLegs = 8（总格数 = 链长）', host.game.revealLegs === 8, host.game.revealLegs);
  ok('★ 快照带 legHoldMs ≥ 1400（当前这一格的时长，前端按它排动画）',
    typeof host.game.legHoldMs === 'number' && host.game.legHoldMs >= 1400, host.game.legHoldMs);
  // ★ v15：每一格的时长不再一样（起词 / 猜词格短、作画格长 + 下一格是猜词时带悬念尾）
  ok('★ 快照带 legMs：长度 = 格数，且**每一格不是同一个数**',
    Array.isArray(host.game.legMs) && host.game.legMs.length === host.game.revealLegs
      && Math.max.apply(null, host.game.legMs) > Math.min.apply(null, host.game.legMs),
    JSON.stringify(host.game.legMs));
  ok('★ 快照带 revealStep 且从 0 起', host.game.revealStep === 0, host.game.revealStep);
  // ★ v14：回放没有手动干预（前端那排播放 / 翻格 / 倍速控件已经删掉）——
  //   房主的「立刻推进」= 这条链不看了，直接进投票。
  host.send(P.C2S.GAME_NEXT, {});
  ok('★ 房主推进 → 直接进投票（回放本身由服务端推，没有手动翻格）',
    await host.waitFor(c => c.phase() === 'chain_vote', 5000),
    host.game.revealStep + '/' + host.phase());
  ok('★ 投票时棒次钉在最后一格（8 - 1 = 7）', host.game.revealStep === 7, host.game.revealStep);

  console.log('\n[5] ★ 按链串行投票 + 每条链各投一次 ♥');
  ok('回放到点进入投票', await waitAll(all, c => c.phase() === 'chain_vote', 12000), all.map(c => c.phase()));
  await sleep(300);
  const gv = host.game;
  ok('★ 服务端指定了当前链（第 1 条）',
    gv.voteChainIndex === 0 && gv.voteChainId === host.reveal[0].chainId,
    JSON.stringify({ i: gv.voteChainIndex, id: gv.voteChainId }));
  ok('★ 快照给出已投 / 总人数（1 组 = 全场 4 人）',
    gv.voteDone === 0 && gv.voteTotal === 4, JSON.stringify({ d: gv.voteDone, t: gv.voteTotal }));

  const otherCid = host.reveal[1].chainId;
  const before = host.errors().length;
  host.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: otherCid, agree: true });
  await sleep(400);
  const err = host.lastErr();
  ok('★ 给别的链投票被服务端拒掉（串行的关键）',
    host.errors().length > before && !!err && /另一条链/.test(err.message || ''), err && err.message);

  // ♥：链 1 全员投第 2 格；链 2 全员投第 2 格 —— 两条链的票必须都留着
  const firstChainId = gv.voteChainId;
  all.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'fav', chainId: gv.voteChainId, step: 1 }));
  ok('★ 链 1 的 ♥ 已记下（我投过 1 条链）',
    await waitAll(all, c => c.game && c.game.myFav && c.game.myFav.chainId === firstChainId &&
      c.game.myFav.step === 1, 5000),
    all.map(c => JSON.stringify(c.game && c.game.myFav)));

  // ★ v14：**全员投完服务端就立刻结算这条链**（不用等满投票时限）——
  //   所以「已投 4 / 4」这个中间态只能**边投边看**：投到最后一个人之前先验一次。
  for (let i = 0; i < all.length - 1; i++) {
    all[i].send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: gv.voteChainId, agree: true });
  }
  ok('★ 还没投满时已投人数按人涨（未投 = 不算）',
    await waitAll(all, c => c.game && c.game.voteDone === 3 && c.phase() === 'chain_vote', 5000),
    all.map(c => c.game && c.game.voteDone + '/' + c.phase()));
  all[all.length - 1].send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: gv.voteChainId, agree: true });
  ok('★ 全员投完 → **自动**结算这条链（进 chain_score，不用点任何按钮）',
    await host.waitFor(c => c.phase() === 'chain_score', 6000), host.phase());
  ok('★ 结算里 √ 数 = 4（全员投的就是 4 票）',
    host.game.voteResult && host.game.voteResult.chains[0]
      && host.game.voteResult.chains[0].agree === 4,
    JSON.stringify(host.game.voteResult && host.game.voteResult.chains[0]));
  ok('★ 小结算 voteResult.partial = true',
    host.game.voteResult && host.game.voteResult.partial === true,
    JSON.stringify(host.game.voteResult && host.game.voteResult.partial));
  const row0 = host.game.voteResult.chains[0];
  ok('★ √ 过半 → 这条链算过（起词人拿奖杯）',
    row0 && row0.agree === 4 && row0.won === true, JSON.stringify(row0 && { a: row0.agree, w: row0.won }));
  ok('★ 小结算只带已经放完的那一条链',
    host.game.voteResult.chains.length === 1, host.game.voteResult.chains.length);

  host.send(P.C2S.GAME_NEXT, {});
  ok('★ 小结算推进 → 下一条链回放（不是直接最终结算）',
    await host.waitFor(c => c.phase() === 'chain_reveal' && c.game.voteChainIndex === 1, 6000),
    host.phase() + ' idx=' + (host.game && host.game.voteChainIndex));

  console.log('\n[5b] 剩下的链一条条走完 → 最终结算');
  for (let i = 2; i <= 4; i++) {
    // 回放阶段：**节流地**请房主推进（v14 一按就直接进投票 —— 连点会把投票跳过去，
    // 所以每 2 秒最多点一次，等到真的进了 chain_vote 就停手）。
    let lastNudge = 0;
    for (let g = 0; g < 160; g++) {
      if (host.phase() === 'chain_vote') break;
      if (host.phase() === 'chain_reveal' && Date.now() - lastNudge > 2000) {
        host.send(P.C2S.GAME_NEXT, {});
        lastNudge = Date.now();
      }
      await sleep(200);
    }
    if (!await waitAll(all, c => c.phase() === 'chain_vote', 12000)) { ok('第 ' + i + ' 条链进入投票', false, all.map(c => c.phase())); break; }
    await sleep(200);
    const cid = host.game.voteChainId;
    if (i === 2) {
      // ★ 第二条链也投一次 ♥：两条链的票必须同时留着（不是只剩最后一条）
      //   ⚠ 必须**在 keep 之前**投：keep 一投满服务端就自动结算离开这条链了。
      all.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'fav', chainId: cid, step: 1 }));
      ok('★★ 每条链各投一次 ♥：链 1 与链 2 的票都还在（不再被覆盖）',
        await waitAll(all, c => c.game && c.game.myFav && c.game.myFav.chainId === cid &&
          c.game.myFavStep === 1 && c.game.favVotedCount === 2, 5000),
        all.map(c => JSON.stringify({ m: c.game && c.game.myFav, n: c.game && c.game.favVotedCount })));
    }
    // 全员投 √ → 服务端**自动**结算这条链（v14：不用等满时限，也不用房主点）
    all.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: cid, agree: true }));
    await host.waitFor(c => c.phase() === 'chain_score', 8000);
    if (host.game.voteChainIndex < host.game.chainCount) {
      host.send(P.C2S.GAME_NEXT, {});
      await sleep(400);
    }
  }
  ok('★ 全部链走完 → 最终结算（partial = false）',
    host.phase() === 'chain_score' && host.game.voteResult && host.game.voteResult.partial === false,
    host.phase() + ' partial=' + (host.game.voteResult && host.game.voteResult.partial));
  ok('★ 最终结算带全部 4 条链的结果',
    host.game.voteResult && host.game.voteResult.chains.length === 4,
    host.game.voteResult && host.game.voteResult.chains.length);
  ok('★ 每条链的 √ 都过半 → 4 位起词人各拿一个奖杯',
    host.game.scores.filter(s => s.score > 0).length === 4,
    JSON.stringify(host.game.scores.map(s => s.name + ':' + s.score)));
  const fav = host.game.voteResult.fav;
  ok('★ 最终结算 fav 带 strokes（跨链统计成功：链 1 / 链 2 各 4 票）',
    Array.isArray(fav) && fav.length >= 1 && fav.every(w => Array.isArray(w.strokes) && w.strokes.length > 0),
    JSON.stringify(fav.map(w => w.chainId + ':' + w.step + '=' + w.votes)));
  ok('★ favRanking 按票数降序、每一项都带 strokes 与 ownerName',
    Array.isArray(host.game.voteResult.favRanking) &&
    host.game.voteResult.favRanking.every((r, i, a) => i === 0 || a[i - 1].votes >= r.votes) &&
    host.game.voteResult.favRanking.every(r => Array.isArray(r.strokes) && r.strokes.length > 0 && !!r.ownerName),
    JSON.stringify(host.game.voteResult.favRanking.map(r => r.chainId + ':' + r.step + '=' + r.votes)));
  all.forEach(c => { try { c.ws.close(); } catch (e) { /* */ } });
  await sleep(300);

  /* ================= B. 8 人房（2 组，v12 新场景） ================= */
  console.log('\n=== B. 8 人房：2 组各 4 人 · 链长 8 · 组内传遍 · 8 格跑满 ===');
  const nicks = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  const B = await makeRoom(nicks);
  const host2 = B.host, all2 = B.all;
  host2.send(P.C2S.GAME_START, { mode: 'chain', theme: 'default' });
  await sleep(400);
  ok('★ 8 人房链长 = 2 × 组人数 = 8（不是 2 × 8 = 16）',
    host2.game && host2.game.chainLength === 8, host2.game && host2.game.chainLength);
  all2.forEach(c => c.send(P.C2S.GAME_READY, { ready: true }));
  await host2.waitFor(c => c.phase() === 'chain_init', 6000);
  const snap0 = host2.game;
  ok('★ 快照下发 groupCount = 2 / groupSize = 4',
    snap0.groupCount === 2 && snap0.groupSize === 4, JSON.stringify({ n: snap0.groupCount, s: snap0.groupSize }));
  ok('★ 快照 groups 里两组各 4 人、各 4 条链',
    Array.isArray(snap0.groups) && snap0.groups.length === 2 &&
    snap0.groups.every(g => g.members.length === 4 && g.chainIds.length === 4 && g.chainLength === 8),
    JSON.stringify(snap0.groups.map(g => g.id + ':' + g.ring.join('/'))));
  ok('★ 8 个人 8 条链，每条链都能查到归哪一组',
    !!snap0.chainCount && snap0.chainCount === 8, snap0.chainCount);

  // 分组是服务端冻结的：两个组互不重叠，且同一个组的人拿到的是同一批链
  const myG = {};
  snap0.groups.forEach(g => g.members.forEach(m => { myG[m.userId] = g.id; }));
  const byGroup = {};
  snap0.groups.forEach(g => { byGroup[g.id] = new Set(g.members.map(m => m.userId)); });
  ok('★ 每个人恰好属于一个组（两组不重叠、并集 = 8 人）',
    Object.keys(myG).length === 8 && new Set(Object.values(myG)).size === 2,
    JSON.stringify(myG));

  ok('全员就绪 → 写词阶段', await host2.waitFor(c => c.phase() === 'chain_write', 12000), host2.phase());
  const chainOf = {};                            // userId -> 他在写词格负责的 chainId
  all2.forEach(c => { chainOf[c.you.userId] = c.task && c.task.chainId; });
  const groupChainIds = {};
  snap0.groups.forEach(g => { groupChainIds[g.id] = new Set(g.chainIds); });
  ok('★★ 写词格：每个人拿到的链都属于自己那一组（绝不串组）',
    all2.every(c => groupChainIds[myG[c.you.userId]].has(chainOf[c.you.userId])),
    all2.map(c => c.nick + ':' + myG[c.you.userId] + '→' + chainOf[c.you.userId]));
  ok('★★ 组内每人一条不同的链（组内 4 人 → 4 条不同链）',
    snap0.groups.every(g => {
      const ids = g.members.map(m => chainOf[m.userId]);
      return new Set(ids).size === 4 && ids.every(id => groupChainIds[g.id].has(id));
    }));

  all2.forEach(c => c.send(P.C2S.GAME_SUBMIT, { text: '组' + myG[c.you.userId] + '_' + c.nick }));
  ok('★ 写词收格 → 作画', await host2.waitFor(c => c.phase() === 'chain_draw', 12000), host2.phase());

  console.log('\n[6] ★ 8 人 2 组跑满 8 格（每步 2 组并行、各 4 格）');
  let everyStepOk = true, stepsSeen = 0;
  for (let k = 1; k < 8; k++) {
    if (!await waitAll(all2, c => c.step() === WANT_TYPES[k], 12000)) {
      everyStepOk = false;
      ok('第 ' + (k + 1) + ' 格（' + WANT_TYPES[k] + '）全员收到题面', false, all2.map(c => c.phase() + '/' + c.step()));
      break;
    }
    stepsSeen += 1;
    // ★ 每格：人人的链都在自己组里；组内 4 条链互不相同（组内一一映射）
    const perGroup = {};
    let crossGroup = 0;
    all2.forEach(c => {
      const gid = myG[c.you.userId];
      (perGroup[gid] = perGroup[gid] || []).push(c.task.chainId);
      if (!groupChainIds[gid].has(c.task.chainId)) crossGroup += 1;
    });
    if (crossGroup !== 0 || !Object.values(perGroup).every(ids => new Set(ids).size === 4)) {
      everyStepOk = false;
      ok('第 ' + (k + 1) + ' 格：组内一人一格、不串组', false,
        JSON.stringify({ crossGroup, perGroup }));
      break;
    }
    if (WANT_TYPES[k] === 'DRAWING') {
      const layerId = host2.layers[host2.layers.length - 1].id;
      all2.forEach((c, i) => {
        const id = 'b' + k + '_' + i + '_' + Date.now().toString(36);
        c.send(P.C2S.STROKE_BEGIN, { id, layerId, tool: 'brush', color: '#334455', size: 18, opacity: 1 });
        c.send(P.C2S.STROKE_POINTS, { id, pts: [[120 + i * 20, 120, 0.5], [220 + i * 20, 220, 0.5]] });
        c.send(P.C2S.STROKE_END, { id });
      });
      await sleep(250);
      all2.forEach(c => c.send(P.C2S.GAME_SUBMIT, {}));
    } else {
      all2.forEach(c => c.send(P.C2S.GAME_SUBMIT, { text: '猜' + (k + 1) + '_' + myG[c.you.userId] }));
    }
    if (!await waitAll(all2, c => c.step() !== WANT_TYPES[k] || c.phase() === 'chain_reveal', 12000)) {
      everyStepOk = false;
      ok('第 ' + (k + 1) + ' 格收格后继续往下走', false, all2.map(c => c.phase()));
      break;
    }
  }
  ok('★ 8 人 2 组跑满 8 格（' + stepsSeen + '/7 步推进）', everyStepOk && stepsSeen === 7,
    'steps=' + stepsSeen);
  ok('★ 全员进回放', await waitAll(all2, c => c.phase() === 'chain_reveal', 12000), all2.map(c => c.phase()));

  console.log('\n[7] ★ 8 人 2 组：回放数据按组隔离');
  ok('★ 回放数据 8 条链、每条 8 格',
    Array.isArray(host2.reveal) && host2.reveal.length === 8 &&
    host2.reveal.every(r => r.steps.length === 8 && r.steps.every(Boolean)),
    host2.reveal && host2.reveal.map(r => r.steps.length));
  const revById = {};
  host2.reveal.forEach(r => { revById[r.chainId] = r; });
  ok('★★ 每条链的作者全部来自同一个组（链只在组内传）',
    snap0.groups.every(g => g.chainIds.every(cid =>
      revById[cid].steps.every(s => byGroup[g.id].has(s.playerId)))),
    JSON.stringify(snap0.groups.map(g => g.id + ':' + g.chainIds)));
  ok('★★ 每条链里，本组的 4 个人各出 2 格（组内传遍）',
    snap0.groups.every(g => g.chainIds.every(cid => g.members.every(m =>
      revById[cid].steps.filter(s => s.playerId === m.userId).length === 2))));
  ok('★ 组内传遍：链长 8 = 2 × 组人数（不是 16）',
    host2.game.chainLength === 8 && host2.game.revealLegs === 8,
    JSON.stringify({ len: host2.game.chainLength, legs: host2.game.revealLegs }));
  ok('★ 每条链的起词非空',
    host2.reveal.every(r => typeof r.firstWord === 'string' && r.firstWord.length > 0),
    host2.reveal.map(r => r.firstWord));

  console.log('\n[8] ★ 8 人 2 组：投票按链串行 · 跨组不投票');
  for (let i = 0; i < 16 && host2.phase() === 'chain_reveal'; i++) { host2.send(P.C2S.GAME_NEXT, {}); await sleep(120); }
  ok('★ 推到底 → 投票', host2.phase() === 'chain_vote', host2.phase());
  await sleep(300);
  const curChain = host2.game.voteChainId;
  const curGroup = snap0.groups.find(g => g.chainIds.indexOf(curChain) >= 0);
  ok('★ 当前这条链属于某一组，voteTotal = 该组人数（不是全场 8 人）',
    !!curGroup && host2.game.voteTotal === 4,
    JSON.stringify({ chain: curChain, group: curGroup && curGroup.id, total: host2.game.voteTotal }));
  ok('★ 快照带 voteGroupId（前端据此知道该谁投）',
    host2.game.voteGroupId === curGroup.id, host2.game.voteGroupId);

  // 别组的人投 keep：允许发，但不计入统计
  const outsider = all2.find(c => !byGroup[curGroup.id].has(c.you.userId));
  const inGroup = all2.filter(c => byGroup[curGroup.id].has(c.you.userId));
  outsider.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: curChain, agree: true });
  await sleep(400);
  ok('★ 别组的人投 √ 也不进统计（已投仍是 0）', host2.game.voteDone === 0, host2.game.voteDone);

  // 本组投 ♥：链 1 的第 2 格
  // ⚠ v14：keep 一投满服务端就自动结算离开这条链了 —— **先投 ♥ 再投 keep**。
  inGroup.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'fav', chainId: curChain, step: 1 }));
  ok('★ 本组的 ♥ 都记在「现在这条链」上',
    await waitAll(inGroup, c => c.game && c.game.myFav && c.game.myFav.chainId === curChain &&
      c.game.myFav.step === 1, 5000),
    inGroup.map(c => JSON.stringify(c.game && c.game.myFav)));
  inGroup.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: curChain, agree: true }));
  ok('★ 本组 4 人投 √ → 结算里 √ = 4 / 4（投满即自动结算）',
    await host2.waitFor(c => c.phase() === 'chain_score' && c.game.voteResult
      && c.game.voteResult.chains[0] && c.game.voteResult.chains[0].agree === 4, 8000),
    JSON.stringify({
      d: host2.game.voteDone, a: host2.game.voteAgree,
      row: host2.game.voteResult && host2.game.voteResult.chains[0]
    }));
  ok('★ 别组的人没有 ♥ 记录（各归各的组）',
    outsider.game && (!outsider.game.myFav),
    JSON.stringify(outsider.game && outsider.game.myFav));

  all2.forEach(c => { try { c.ws.close(); } catch (e) { /* */ } });
  await sleep(300);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
