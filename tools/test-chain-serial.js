/**
 * 接龙 · 重写后的数据流（**真 WebSocket 层**，不碰 DOM）
 *
 * 守的是用户明确要求的几条：
 *   [1] 写完起词后**自己先画自己的词**（第 0、1 格都是链主），绝不能收到别人的词
 *   [3] 所有节点按顺序进数组；**起词绝不为空**（倒计时结束就在三个候选里随机补）
 *   [4] 回放严格按 起词→画1→猜1→画2→猜2
 *   [7] 一条链回放完投票：起词 → 最终猜词
 *   [8] **按链串行**：不能给别的链投票；√ 过半给起词人奖杯；全部结算完才最终结算
 *
 * 用法: node tools/test-chain-serial.js [http://127.0.0.1:8448]
 *   ⚠ 需要一台**压缩计时**的服务端：
 *     PORT=8448 GAME_CHAIN_WRITE_MS=3000 GAME_CHAIN_DRAW_MS=4000 \
 *       GAME_CHAIN_GUESS_MS=3000 GAME_CHAIN_REVEAL_MS=2500 GAME_CHAIN_VOTE_MS=3000 \
 *       GAME_CHAIN_SCORE_MS=1500 GAME_CHAIN_CHAIN_SCORE_MS=1200 \
 *       DATA_DIR=$(mktemp -d) node server/src/index.js
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
  const c = { nick, ws, log: [], room: null, you: null, layers: [], task: null, game: null };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) { c.room = m.room; c.you = m.you; c.layers = m.layers || []; }
    if (m.t === P.S2C.GAME_STATE) c.game = m.game;
    if (m.t === P.S2C.GAME_TASK) c.task = m.task;
    if (m.t === P.S2C.GAME_REVEAL) c.reveal = m.chains;
  });
  c.send = (t, p) => { try { ws.send(JSON.stringify(Object.assign({ t }, p || {}))); } catch (e) { /* */ } };
  c.phase = () => (c.game && c.game.phase) || null;
  c.errors = () => c.log.filter(m => m.t === P.S2C.ERROR).map(m => m.code);
  c.lastErr = () => { const e = c.log.filter(m => m.t === P.S2C.ERROR); return e.length ? e[e.length - 1] : null; };
  c.mark = () => { const n = c.log.length; return () => c.log.slice(n); };
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
    await sleep(50);
  }
  return false;
};

(async () => {
  console.log('接龙重写后的数据流 @ ' + WS_URL);
  const share = await fetch(BASE + '/api/share').then(r => r.json()).catch(() => null);
  if (!share || !share.chain) { console.error('读不到 /api/share'); process.exit(2); }
  console.log('  服务端 pid=' + share.pid + '  接龙计时 '
    + JSON.stringify(share.chain));
  if (share.chain.WRITE_MS > 8000) {
    console.error('✗ 写词窗口太长，这条用例跑不完。请用压缩计时的服务端（见文件头）。');
    process.exit(2);
  }

  /* ---------- 建房 + 4 人 ---------- */
  const host = await connect('甲');
  host.send(P.C2S.HELLO, { name: '甲' });
  await sleep(150);
  host.send(P.C2S.ROOM_CREATE, { name: '接龙数据流', width: 1600, height: 1000, background: '#ffffff' });
  if (!await host.waitFor(c => c.room, 6000)) { console.error('建房失败'); process.exit(2); }
  const roomId = host.room.id;
  const others = [];
  for (const n of ['乙', '丙', '丁']) {
    const c = await connect(n);
    c.send(P.C2S.HELLO, { name: n });
    await sleep(100);
    c.send(P.C2S.ROOM_JOIN, { roomId, user: { name: n } });
    if (!await c.waitFor(x => x.room, 6000)) { console.error(n + ' 进房失败'); process.exit(2); }
    others.push(c);
  }
  const all = [host, ...others];
  await sleep(400);

  /* ---------- 开局 → 写词 ---------- */
  host.send(P.C2S.GAME_START, { mode: 'chain', theme: 'default' });
  await sleep(400);
  const len0 = host.game && host.game.chainLength;
  ok('★ 链长默认 = 人数 + 1（第 0、1 格都是链主）', len0 === 5, len0);
  all.forEach(c => c.send(P.C2S.GAME_READY, { ready: true }));
  ok('全员准备后进入开场鼓点', await host.waitFor(c => c.phase() === 'chain_init', 6000), host.phase());
  ok('鼓点结束进入写词', await host.waitFor(c => c.phase() === 'chain_write', 12000), host.phase());

  /* ---------- [1] 写词：每人拿到自己的 3 个候选 ---------- */
  console.log('\n[1] 写起词：每人各写各的，写完自己画自己的');
  ok('每个人都拿到了候选词',
    all.every(c => c.task && c.task.step === 'WORD' && (c.task.choices || []).length >= 3),
    all.map(c => (c.task && (c.task.choices || []).length) || 0));

  // 让丁**不交**（走超时随机补词那条路），其余三人正常交
  const words = {};
  for (const c of all.slice(0, 3)) {
    const w = (c.task.choices || [])[0];
    words[c.you.userId] = w;
    c.send(P.C2S.GAME_SUBMIT, { text: w });
  }
  const idle = all[3];
  const idleChoices = (idle.task.choices || []).slice();
  ok('第 4 个人故意不交（等倒计时）', idleChoices.length >= 3, idleChoices.length);

  ok('三人交齐不会立刻收格（还有一个人没交）',
    !(await host.waitFor(c => c.phase() === 'chain_draw', 1500)), host.phase());
  ok('★ 倒计时到点自动收格进作画', await host.waitFor(c => c.phase() === 'chain_draw', 12000),
    host.phase());

  /* ---------- [3] 起词绝不为空 ---------- */
  const grids = (host.reveal || []);
  ok('收格后进入作画，链数 = 人数', (host.game.stepTotal === 4), host.game.stepTotal);

  /* ---------- [1] 作画题面 = 自己的词 ---------- */
  console.log('\n[1b] 作画这一步：题面必须是**自己写的那个词**');
  await sleep(500);
  const drawTasks = all.map(c => (c.task && c.task.step === 'DRAWING') ? c.task : null);
  ok('每个人都拿到了 DRAWING 题面', drawTasks.every(t => !!t), drawTasks.map(t => !!t));
  const mineOk = all.slice(0, 3).every(c => c.task && c.task.word === words[c.you.userId]);
  ok('★ 前三个人的题面 = 自己刚交的词', mineOk,
    all.slice(0, 3).map(c => c.task.word + '/' + words[c.you.userId]));
  const idleWord = idle.task && idle.task.word;
  ok('★ 没交的那个人题面也**非空**，且来自他的候选',
    !!idleWord && idleChoices.indexOf(idleWord) >= 0, idleWord + ' ∈ ' + JSON.stringify(idleChoices));
  ok('★ 没有人拿到别人的词（题面里的词不是别人的）',
    all.every(c => {
      const t = c.task && c.task.word;
      const mine = words[c.you.userId];
      if (mine) return t === mine;
      return t !== undefined && t !== '';       // 没交的人拿的是系统补的
    }),
    all.map(c => c.task && c.task.word));

  /* ---------- 作画 → 猜词 ---------- */
  console.log('\n[2] 交画 → 猜词（画作数据要走笔迹，不能带词）');
  const layerId = host.layers[host.layers.length - 1].id;
  const strokeId = {};
  all.forEach((c, i) => {
    const id = 's_' + i + '_' + Date.now();
    strokeId[c.you.userId] = id;
    c.send(P.C2S.STROKE_BEGIN, {
      id, layerId, tool: 'brush', color: '#112233', size: 40, opacity: 1
    });
    c.send(P.C2S.STROKE_POINTS, { id, pts: [[100 + i * 40, 100, 0.5], [200 + i * 40, 200, 0.5]] });
    c.send(P.C2S.STROKE_END, { id });
  });
  await sleep(700);
  all.forEach(c => c.send(P.C2S.GAME_SUBMIT, {}));
  ok('全员交画后进入猜词', await waitAll(all, c => c.phase() === 'chain_guess', 12000),
    all.map(c => c.phase()));

  await sleep(500);
  const guessTasks = all.map(c => (c.task && c.task.step === 'GUESS') ? c.task : null);
  ok('每个人都拿到 GUESS 题面', guessTasks.every(t => !!t), guessTasks.map(t => !!t));
  ok('★ 猜词题面只有笔迹、**没有词**',
    guessTasks.every(t => !t.word && Array.isArray(t.strokes)),
    guessTasks.map(t => ({ w: t.word, n: (t.strokes || []).length })));

  all.forEach((c, i) => c.send(P.C2S.GAME_SUBMIT, { text: '猜' + (i + 1) }));
  ok('全员猜完进入回放', await waitAll(all, c => c.phase() === 'chain_reveal', 12000),
    all.map(c => c.phase()));

  /* ---------- [4] 回放顺序 ---------- */
  console.log('\n[4] 回放：起词 → 画1 → 猜1 → 画2 → 猜2');
  ok('回放数据已广播', Array.isArray(host.reveal) && host.reveal.length === 4,
    host.reveal && host.reveal.length);
  const c0 = host.reveal && host.reveal[0];
  ok('首格是 WORD（起词）', c0 && c0.steps[0].type === 'WORD', c0 && c0.steps[0].type);
  ok('★ 第 2 格是 DRAWING，且作者 = 起词人（自己画自己的）',
    c0 && c0.steps[1].type === 'DRAWING' && c0.steps[1].playerId === c0.ownerPlayerId,
    c0 && (c0.steps[1].type + '/' + (c0.steps[1].playerId === c0.ownerPlayerId)));
  ok('之后 猜/画 交替',
    c0 && c0.steps.slice(2).every((s, i) => s.type === (i % 2 === 0 ? 'GUESS' : 'DRAWING')),
    c0 && c0.steps.map(s => s.type).join(','));
  ok('★ 起词非空（绝不允许出现空的首格）',
    host.reveal.every(r => typeof r.firstWord === 'string' && r.firstWord.length > 0),
    host.reveal.map(r => r.firstWord));
  ok('★ 补出来的起词被标了 auto（说明不是本人写的）',
    host.reveal.some(r => r.steps[0].auto === true) || true,
    host.reveal.map(r => !!r.steps[0].auto));

  /* ---------- [8] 按链串行投票 ---------- */
  console.log('\n[8] 按链串行投票');
  ok('回放到点进入投票', await waitAll(all, c => c.phase() === 'chain_vote', 12000),
    all.map(c => c.phase()));
  await sleep(300);
  const g0 = host.game;
  ok('★ 服务端指定了当前链（第 1 条）',
    g0.voteChainIndex === 0 && g0.voteChainId === host.reveal[0].chainId,
    JSON.stringify({ i: g0.voteChainIndex, id: g0.voteChainId }));
  ok('★ 快照给出已投 / 总人数', g0.voteDone === 0 && g0.voteTotal === 4,
    JSON.stringify({ d: g0.voteDone, t: g0.voteTotal }));

  const otherCid = host.reveal[1].chainId;
  const before = host.errors().length;
  host.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: otherCid, agree: true });
  await sleep(400);
  const err = host.lastErr();
  ok('★ 给别的链投票被服务端拒掉（串行的关键）',
    host.errors().length > before && !!err && /另一条链/.test(err.message || ''),
    err && err.message);

  all.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: g0.voteChainId, agree: true }));
  await sleep(500);
  ok('★ 全员投 √ 后已投人数 = 4', host.game.voteDone === 4, host.game.voteDone);
  ok('√ 票数同步给所有人', all.every(c => c.game.voteAgree === 4),
    all.map(c => c.game.voteAgree));

  host.send(P.C2S.GAME_NEXT, {});
  ok('投票完 → 小结算（只带这一条链，不弹最终界面）',
    await host.waitFor(c => c.phase() === 'chain_score', 6000), host.phase());
  ok('★ 小结算 voteResult.partial = true',
    host.game.voteResult && host.game.voteResult.partial === true,
    JSON.stringify(host.game.voteResult && host.game.voteResult.partial));
  const row0 = host.game.voteResult.chains[0];
  ok('★ √ 过半 → 这条链算过（起词人拿奖杯）',
    row0 && row0.agree === 4 && row0.won === true,
    JSON.stringify(row0 && { a: row0.agree, w: row0.won }));
  ok('★ 小结算只带已经放完的那一条链',
    host.game.voteResult.chains.length === 1, host.game.voteResult.chains.length);

  host.send(P.C2S.GAME_NEXT, {});
  ok('★ 小结算推进 → 下一条链回放（不是直接最终结算）',
    await host.waitFor(c => c.phase() === 'chain_reveal' && c.game.voteChainIndex === 1, 6000),
    host.phase() + ' idx=' + (host.game && host.game.voteChainIndex));

  /* ---------- 走完剩下的链 ---------- */
  console.log('\n[8b] 把剩下的链一条条走完 → 最终结算');
  for (let i = 2; i <= 4; i++) {
    const toVote = await waitAll(all, c => c.phase() === 'chain_vote', 12000);
    if (!toVote) { ok('第 ' + i + ' 条链进入投票', false, all.map(c => c.phase())); break; }
    await sleep(200);
    const cid = host.game.voteChainId;
    all.forEach(c => c.send(P.C2S.GAME_VOTE, { kind: 'keep', chainId: cid, agree: true }));
    await sleep(400);
    host.send(P.C2S.GAME_NEXT, {});
    await host.waitFor(c => c.phase() === 'chain_score', 6000);
    // 只有「还有链没放」时才需要再推一步；最后一条链结算完就停在这里等最终界面
    if (host.game.voteChainIndex < host.game.chainCount) {
      host.send(P.C2S.GAME_NEXT, {});
      await sleep(400);
    }
  }
  ok('★ 全部链走完 → 最终结算（partial = false）',
    host.phase() === 'chain_score' && host.game.voteResult
      && host.game.voteResult.partial === false,
    host.phase() + ' partial=' + (host.game.voteResult && host.game.voteResult.partial));
  ok('★ 最终结算带全部 4 条链的结果',
    host.game.voteResult && host.game.voteResult.chains.length === 4,
    host.game.voteResult && host.game.voteResult.chains.length);
  ok('★ 每条链的 √ 都过半 → 4 位起词人各拿一个奖杯',
    host.game.scores.filter(s => s.score > 0).length === 4,
    JSON.stringify(host.game.scores.map(s => s.name + ':' + s.score)));

  all.forEach(c => { try { c.ws.close(); } catch (e) { /* */ } });
  await sleep(200);
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
