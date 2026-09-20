'use strict';
/**
 * 服务端「每局可配的游戏设置」离线自测（纯 Node，不起服务端、不开浏览器）。
 *
 * 覆盖：
 *   [1] 经典 / 接龙 / 画皮 的 start(opts) 收下每局覆盖值，roundMs()/stepMs()/phaseMs() 与
 *       各处 deadline 用的就是覆盖后的值
 *   [2] 0 / 缺省 → **回落到 CFG**（而不是回落到硬编码常量）——做法是先把环境变量
 *       GAME_*_MS 摆成一组「谁都不是默认值」的数字，再断言回落到的正是这些数字
 *   [3] 每个字段的夹取边界（太小 / 太大 / 非法 / 负数）
 *   [4] repickLimit 真的影响 repick() 的可用次数（含 0 = 一次都不许换）
 *   [5] GAME_FAST=1：所有阶段时长默认值 1000ms，GRACE_MS / WITCH_GRACE_MS 不变
 *   [6] 开局白名单 pickStartOpts 把 14 个字段原样透传给 start()，乱字段丢掉；
 *       并核对 shared/protocol.js 的注释字段表与三处 start() 的实现一致
 *   [7] pendingGame 清洗：乱字段丢掉 / 越界夹住 / 非房主被拒 / 清空 / 换房主只换 by
 *   [8] index.js 的接线（/api/share 的 fast+setup+CHAIN_SCORE_MS、清空时机）——静态断言
 *
 * 用法：node tools/test-game-setup.js
 */
const fs = require('fs');
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);

/* ------------------------------------------------------------------ 环境变量先摆好
 * 三个玩法的 CFG 是**模块加载时**算出来的常量，所以「回落到 CFG」这件事必须在这之前
 * 就把 CFG 变成一组非默认值 —— 否则「回落到 CFG」和「回落到硬编码默认」在测试里长得一样。
 * 这些数字刻意都取成跟 protocol 默认值（80000 / 60000 …）完全不同的值。
 */
const ENV = {
  GAME_PICK_MS: '4321',
  GAME_ROUND_MS: '5555',
  GAME_ROUND_END_MS: '666',
  GAME_CHAIN_INIT_MS: '1666',
  GAME_CHAIN_WRITE_MS: '1111',
  GAME_CHAIN_DRAW_MS: '1555',
  GAME_CHAIN_GUESS_MS: '1222',
  GAME_CHAIN_REVEAL_MS: '1333',
  GAME_CHAIN_VOTE_MS: '1444',
  GAME_CHAIN_SCORE_MS: '1999',
  GAME_CHAIN_CHAIN_SCORE_MS: '1899',
  GAME_CHAIN_GRACE_MS: '1777',
  GAME_SKIN_NIGHT_MS: '2111',
  GAME_SKIN_DAWN_MS: '2222',
  GAME_SKIN_DRAW_MS: '2555',
  GAME_SKIN_TALK_MS: '2333',
  GAME_SKIN_VOTE_MS: '2444',
  GAME_SKIN_VOTE_END_MS: '2666',
  GAME_SKIN_WITCH_GRACE_MS: '1888'
};
delete process.env.GAME_FAST;
Object.assign(process.env, ENV);

const P = require(R('server/src/protocol'));
const PREFS = require(R('server/src/game-prefs'));
const GAME = require(R('server/src/game'));
const CHAIN = require(R('server/src/chain'));
const SKIN = require(R('server/src/skin'));
const { Game, PHASE, CFG: GCFG } = GAME;
const { ChainGame, CHAIN_PHASE, CFG: CCFG } = CHAIN;
const { SkinGame, SKIN_PHASE, CFG: SCFG } = SKIN;
const G = P.GAME;

/* ------------------------------------------------------------------ 测试脚手架 */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '   \u2190 ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function eqArr(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
/** 「deadline 是不是约等于 now + ms」——服务端用 Date.now()，给 1 秒余量 */
function deadlineNear(name, deadline, ms) {
  const d = deadline - Date.now();
  ok(name, d > ms - 1500 && d <= ms, 'deadline-now=' + d + ' want≈' + ms);
}
function makeRoom(n) {
  const members = new Map();
  for (let i = 1; i <= n; i++) {
    members.set('u' + i, { userId: 'u' + i, name: 'P' + i, color: '#000', readonly: false });
  }
  return {
    id: 'r-test', members, ownerId: 'u1', ownerName: 'P1',
    strokes: [], seq: 0, dirty: false, pendingGame: null
  };
}
function makeApi(room) {
  const chats = [];
  return {
    chats,
    syncs: 0,
    sync() { this.syncs++; },
    systemChat(t) { chats.push(t); },
    resetCanvas() { room.strokes = []; },
    revealAll() {}
  };
}

console.log('\n[1] 每局覆盖：三个玩法的 start(opts) 真的收下了');
{
  // ---- 经典 ----
  const room = makeRoom(2);
  const g = new Game(room, makeApi(room));
  const r = g.start({ rounds: 3, theme: '', drawSeconds: 45, repickLimit: 2, roundEndSeconds: 20 });
  eq('classic start ok', r.ok, true);
  eq('classic rounds = 3', g.rounds, 3);
  eq('classic roundMs() = 45s', g.roundMs(), 45000);
  eq('classic repickLimit = 2', g.repickLimit, 2);
  eq('classic 本回合 repickLeft 按新上限发', g.repickLeft, 2);
  eq('classic roundEndMsOf() = 20s', g.roundEndMsOf(), 20000);
  // 阶段 deadline 真的用上了覆盖值
  g.word = '猫';
  g.beginDraw();
  eq('classic beginDraw 后 phase=draw', g.phase, PHASE.DRAW);
  deadlineNear('classic 作画 deadline = 45s', g.deadline, 45000);
  g.endRound('timeout');
  eq('classic endRound 后 phase=round_end', g.phase, PHASE.ROUND_END);
  deadlineNear('classic 回合结算 deadline = 20s', g.deadline, 20000);

  // ---- 接龙 ----
  const room2 = makeRoom(4);
  const c = new ChainGame(room2, makeApi(room2));
  const r2 = c.start({
    theme: 'arknights', drawSeconds: 45, chainLength: 4,
    writeSeconds: 7, guessSeconds: 8, revealSeconds: 9, voteSeconds: 10, replaySpeed: 1
  });
  eq('chain start ok', r2.ok, true);
  eq('chain chainLength = 4', c.chainLength, 4);
  eq('chain writeMs = 7s', c.writeMs, 7000);
  eq('chain guessMs = 8s', c.guessMs, 8000);
  eq('chain revealMs = 9s', c.revealMs, 9000);
  eq('chain voteMs = 10s', c.voteMs, 10000);
  eq('chain drawMs = 45s（沿用 drawSeconds）', c.drawMs, 45000);
  c.enterStep(0);
  eq('chain 写词 phase', c.phase, CHAIN_PHASE.WRITE);
  deadlineNear('chain 写词 deadline = 7s', c.deadline, 7000);
  c.stepIndex = 1;
  c.phase = CHAIN_PHASE.DRAW;
  eq('chain stepMs(DRAW) = 45s', c.stepMs(), 45000);
  c.phase = CHAIN_PHASE.GUESS;
  eq('chain stepMs(GUESS) = 8s', c.stepMs(), 8000);
  c.enterReveal();
  eq('chain 回放 phase', c.phase, CHAIN_PHASE.REVEAL);
  // ★ v11：回放的 deadline 是**当前这一格**的，不是整段。
  // ★ v15：而且**每一格的时长不再一样** —— 起词格 / 猜词格只停短短一拍。
  // ★ v16：作画格改成**按笔数**算动画时长（用户实测：四笔的小图也播了八秒）。
  eq('★ 第 0 格是起词格 → 只停 CHAIN_REVEAL_WORD_MS', c.revealLegMs(0), P.GAME.CHAIN_REVEAL_WORD_MS);
  deadlineNear('chain 回放 deadline = 起词格那一拍', c.deadline, P.GAME.CHAIN_REVEAL_WORD_MS);
  eq('chain 回放总时长仍可查（stepMs 报的是整段）', c.stepMs(), 9000);
  eq('★ 猜词格停 CHAIN_REVEAL_GUESS_MS（v16 起 2 秒：词要看清再翻下一棒）',
    c.revealLegMs(2), P.GAME.CHAIN_REVEAL_GUESS_MS);
  eq('★ 这一格还没人交画 → 动画兜地板 1500 + 3 秒悬念尾',
    c.revealLegMs(1), P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_TEASE_MS);
  eq('★ 最后一格作画后面没有猜词 → 只留一小段定格（1500 + HOLD）',
    c.revealLegMs(3), P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_HOLD_MS);
  eq('★ 快照下发 legMs（这一条链每一格的时长表）',
    Array.isArray(c.snapshotFor('u1').legMs) && c.snapshotFor('u1').legMs.length === c.chainLength, true);
  // ★ v16：动画时长**按笔数**算 —— 用一条假链直接问 legMsAt（这台 fixture 没有真环，
  //   而公式只认「这一格有几笔」，与环无关）。
  const anim10 = P.GAME.CHAIN_REVEAL_DRAW_BASE_MS + 10 * P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS;
  const fakeChain = {
    steps: [
      { type: 'WORD', content: '词' },
      { type: 'DRAWING', content: new Array(10).fill(null).map(() => ({ points: [] })) },
      { type: 'GUESS', content: '猜' },
      { type: 'DRAWING', content: [] }
    ]
  };
  eq('★ 10 笔的作画格 = (900 + 10×240) = 3300 + 悬念尾（1x）',
    c.legMsAt(1, fakeChain), anim10 + P.GAME.CHAIN_REVEAL_TEASE_MS);
  // ★ v14：回放倍速（每局设置）。倍速是**除法**：笔迹按倍速播完更快。
  eq('★ 倍速 1x（上面那条就是 1x）', c.replaySpeed, 1);
  c.replaySpeed = 2;
  eq('★ 倍速 2x → 3300 / 2 = 1650 + 悬念尾',
    c.legMsAt(1, fakeChain), Math.round(anim10 / 2) + P.GAME.CHAIN_REVEAL_TEASE_MS);
  c.replaySpeed = 1.5;
  eq('★ 倍速 1.5x → 3300 / 1.5 = 2200 + 悬念尾',
    c.legMsAt(1, fakeChain), Math.round(anim10 / 1.5) + P.GAME.CHAIN_REVEAL_TEASE_MS);
  eq('★ 起词 / 猜词格不受倍速影响（本来就只有一拍）',
    [c.legMsAt(0, fakeChain), c.legMsAt(2, fakeChain)].join(','),
    [P.GAME.CHAIN_REVEAL_WORD_MS, P.GAME.CHAIN_REVEAL_GUESS_MS].join(','));
  c.replaySpeed = 1;
  c.enterVote();
  eq('chain 投票 phase', c.phase, CHAIN_PHASE.VOTE);
  eq('★ 投票时棒次钉在最后一格', c.revealStep, Math.max(0, c.chainLength - 1));
  deadlineNear('chain 投票 deadline = 10s', c.deadline, 10000);

  // ---- 画皮 ----
  const room3 = makeRoom(6);
  const s = new SkinGame(room3, makeApi(room3));
  const r3 = s.start({ rounds: 3, drawSeconds: 45, nightSeconds: 12, dawnSeconds: 13, talkSeconds: 14, voteSeconds: 15 });
  eq('skin start ok', r3.ok, true);
  eq('skin maxRounds = 3', s.maxRounds, 3);
  eq('skin nightMs = 12s', s.nightMs, 12000);
  eq('skin dawnMs = 13s', s.dawnMs, 13000);
  eq('skin talkMs = 14s', s.talkMs, 14000);
  eq('skin voteMs = 15s', s.voteMs, 15000);
  eq('skin phase（开局即入夜）', s.phase, SKIN_PHASE.NIGHT);
  deadlineNear('skin 夜里 deadline = 12s', s.deadline, 12000);
  s.resolveNight();
  eq('skin resolveNight 后 phase=dawn', s.phase, SKIN_PHASE.DAWN);
  deadlineNear('skin 天亮 deadline = 13s', s.deadline, 13000);
  s.beginDraw();
  eq('skin 作画 phase', s.phase, SKIN_PHASE.DAY_DRAW);
  deadlineNear('skin 作画 deadline = 45s', s.deadline, 45000);
  s.beginTalk();
  eq('skin 讨论 phase', s.phase, SKIN_PHASE.DAY_TALK);
  deadlineNear('skin 讨论 deadline = 14s', s.deadline, 14000);
  s.beginVote();
  eq('skin 投票 phase', s.phase, SKIN_PHASE.DAY_VOTE);
  deadlineNear('skin 投票 deadline = 15s', s.deadline, 15000);
  s.finishVote();
  eq('skin 票结 phase', s.phase, SKIN_PHASE.VOTE_END);
  deadlineNear('skin 票结 deadline = 环境变量值', s.deadline, SCFG.VOTE_END_MS);
  eq('skin phaseMs(VOTE_END) 用 CFG', s.phaseMs(), SCFG.VOTE_END_MS);
}

console.log('\n[2] 0 / 缺省 → 回落到 CFG（不是回落到硬编码默认）');
{
  // 先证明这三个 CFG 确实不是协议默认值 —— 否则这一节等于没测
  ok('CFG 已被环境变量改过（否则本节的断言无意义）',
    GCFG.ROUND_MS === 5555 && CCFG.WRITE_MS === 1111 && SCFG.NIGHT_MS === 2111 &&
    GCFG.ROUND_MS !== G.ROUND_MS);

  const room = makeRoom(2);
  const g = new Game(room, makeApi(room));
  g.start({ rounds: 2, drawSeconds: 0, repickLimit: undefined, roundEndSeconds: 0 });
  eq('classic drawSeconds=0 → CFG.ROUND_MS', g.roundMs(), GCFG.ROUND_MS);
  eq('classic roundEndSeconds=0 → CFG.ROUND_END_MS', g.roundEndMsOf(), GCFG.ROUND_END_MS);
  eq('classic repickLimit 缺省 → 默认 1', g.repickLimit, G.REPICK_LIMIT);
  eq('classic rounds=2 仍然生效', g.rounds, 2);

  const g1 = new Game(makeRoom(2), makeApi(makeRoom(2)));
  g1.start();
  eq('classic 什么都不传 → roundMs()=CFG', g1.roundMs(), GCFG.ROUND_MS);
  eq('classic 什么都不传 → roundEndMsOf()=CFG', g1.roundEndMsOf(), GCFG.ROUND_END_MS);

  const room2 = makeRoom(4);
  const c = new ChainGame(room2, makeApi(room2));
  c.start({ theme: 'arknights' });
  c.phase = CHAIN_PHASE.INIT; eq('chain INIT 缺省 → CFG.INIT_MS', c.stepMs(), CCFG.INIT_MS);
  c.phase = CHAIN_PHASE.WRITE; eq('chain WRITE 缺省 → CFG.WRITE_MS', c.stepMs(), CCFG.WRITE_MS);
  c.phase = CHAIN_PHASE.DRAW; eq('chain DRAW 缺省 → CFG.DRAW_MS', c.stepMs(), CCFG.DRAW_MS);
  c.phase = CHAIN_PHASE.GUESS; eq('chain GUESS 缺省 → CFG.GUESS_MS', c.stepMs(), CCFG.GUESS_MS);
  c.phase = CHAIN_PHASE.REVEAL; eq('chain REVEAL 缺省 → CFG.REVEAL_MS', c.stepMs(), CCFG.REVEAL_MS);
  c.phase = CHAIN_PHASE.VOTE; eq('chain VOTE 缺省 → CFG.VOTE_MS', c.stepMs(), CCFG.VOTE_MS);
  c.chains = [{}, {}]; c.voteChainIndex = 0;
  c.phase = CHAIN_PHASE.SCORE;
  eq('chain 小结算缺省 → CFG.CHAIN_SCORE_MS', c.stepMs(), CCFG.CHAIN_SCORE_MS);
  c.voteChainIndex = 2;
  eq('chain 最终结算缺省 → CFG.SCORE_MS', c.stepMs(), CCFG.SCORE_MS);

  const room3 = makeRoom(6);
  const s = new SkinGame(room3, makeApi(room3));
  s.start({});
  s.phase = SKIN_PHASE.NIGHT; eq('skin NIGHT 缺省 → CFG.NIGHT_MS', s.phaseMs(), SCFG.NIGHT_MS);
  s.phase = SKIN_PHASE.DAWN; eq('skin DAWN 缺省 → CFG.DAWN_MS', s.phaseMs(), SCFG.DAWN_MS);
  s.phase = SKIN_PHASE.DAY_DRAW; eq('skin DRAW 缺省 → CFG.DRAW_MS', s.phaseMs(), SCFG.DRAW_MS);
  s.phase = SKIN_PHASE.DAY_TALK; eq('skin TALK 缺省 → CFG.TALK_MS', s.phaseMs(), SCFG.TALK_MS);
  s.phase = SKIN_PHASE.DAY_VOTE; eq('skin VOTE 缺省 → CFG.VOTE_MS', s.phaseMs(), SCFG.VOTE_MS);
  eq('skin 什么都不传 → maxRounds = SKIN_ROUNDS', s.maxRounds, G.SKIN_ROUNDS);
}

console.log('\n[3] 夹取边界（太小 / 太大 / 非法 / 负数）');
{
  const room = makeRoom(2);
  const mk = () => { const r = makeRoom(2); return new Game(r, makeApi(r)); };
  // 秒数：新加的那些下限是 3，上限 600
  const a = mk(); a.start({ repickLimit: 1, roundEndSeconds: 1 });
  eq('roundEndSeconds=1 → 夹到 3s', a.roundEndMsOf(), 3000);
  const b = mk(); b.start({ roundEndSeconds: 99999 });
  eq('roundEndSeconds=99999 → 夹到 600s', b.roundEndMsOf(), 600000);
  const c2 = mk(); c2.start({ roundEndSeconds: -5 });
  eq('roundEndSeconds=-5 → 用默认（CFG）', c2.roundEndMsOf(), GCFG.ROUND_END_MS);
  const d = mk(); d.start({ roundEndSeconds: 'abc' });
  eq('roundEndSeconds=abc → 用默认（CFG）', d.roundEndMsOf(), GCFG.ROUND_END_MS);
  const e = mk(); e.start({ roundEndSeconds: null });
  eq('roundEndSeconds=null → 用默认（CFG）', e.roundEndMsOf(), GCFG.ROUND_END_MS);
  const f = mk(); f.start({ roundEndSeconds: 6.9 });
  eq('roundEndSeconds=6.9 → 取整 6s', f.roundEndMsOf(), 6000);

  // drawSeconds 的下限**保持 30**（房主侧最短 30 秒，v4 起就是这条规矩）
  const g1 = mk(); g1.start({ drawSeconds: 5 });
  eq('drawSeconds=5 → 夹到 30s（不是 3s）', g1.roundMs(), G.DRAW_SECONDS_MIN * 1000);
  const g2 = mk(); g2.start({ drawSeconds: 9999 });
  eq('drawSeconds=9999 → 夹到 300s', g2.roundMs(), G.DRAW_SECONDS_MAX * 1000);
  const g3 = mk(); g3.start({ drawSeconds: -1 });
  eq('drawSeconds=-1 → 用默认（CFG）', g3.roundMs(), GCFG.ROUND_MS);

  // repickLimit：[0, 5]，缺省 / 非法 → 1
  const r1 = mk(); r1.start({ repickLimit: 99 }); eq('repickLimit=99 → 5', r1.repickLimit, 5);
  const r2 = mk(); r2.start({ repickLimit: 0 }); eq('repickLimit=0 → 0（实义值，不是默认）', r2.repickLimit, 0);
  const r3 = mk(); r3.start({ repickLimit: -3 }); eq('repickLimit=-3 → 0', r3.repickLimit, 0);
  const r4 = mk(); r4.start({ repickLimit: 'abc' }); eq('repickLimit=abc → 1', r4.repickLimit, 1);
  const r5 = mk(); r5.start({ repickLimit: 2.9 }); eq('repickLimit=2.9 → 2', r5.repickLimit, 2);

  // 接龙的秒数
  const cs = (o) => { const r = makeRoom(4); const g = new ChainGame(r, makeApi(r)); g.start(o); return g; };
  eq('chain writeSeconds=1 → 3s', cs({ writeSeconds: 1 }).writeMs, 3000);
  eq('chain guessSeconds=99999 → 600s', cs({ guessSeconds: 99999 }).guessMs, 600000);
  eq('chain revealSeconds=-2 → CFG', cs({ revealSeconds: -2 }).revealMs, 0);
  eq('chain voteSeconds="x" → CFG', cs({ voteSeconds: 'x' }).voteMs, 0);

  // 画皮的秒数
  const ss = (o) => { const r = makeRoom(6); const g = new SkinGame(r, makeApi(r)); g.start(o); return g; };
  eq('skin nightSeconds=1 → 3s', ss({ nightSeconds: 1 }).nightMs, 3000);
  eq('skin dawnSeconds=1e9 → 600s', ss({ dawnSeconds: 1e9 }).dawnMs, 600000);
  eq('skin talkSeconds=-9 → CFG', ss({ talkSeconds: -9 }).talkMs, 0);
  eq('skin voteSeconds=true → CFG', ss({ voteSeconds: true }).voteMs, 0);

  // rounds / chainLength 沿用原有夹取
  const rr = mk(); rr.start({ rounds: 999 }); eq('classic rounds=999 → MAX_ROUNDS', rr.rounds, G.MAX_ROUNDS);
  const rr2 = mk(); rr2.start({ rounds: 0 }); eq('classic rounds=0 → 沿用原夹取（1）', rr2.rounds, 1);
  const sk = ss({ rounds: 999 }); eq('skin rounds=999 → SKIN_MAX_ROUNDS', sk.maxRounds, G.SKIN_MAX_ROUNDS);
  // ★ v11：链长默认 = 2 × 人数，上限 = 2 × min(人数, CHAIN_LENGTH_MAX)
  const cl = cs({ chainLength: 999 }); eq('chain chainLength=999 → 2 × min(人数, MAX) = 8', cl.chainLength, 2 * Math.min(4, G.CHAIN_LENGTH_MAX));
  const cl2 = cs({ chainLength: 1 }); eq('chain chainLength=1 → CHAIN_LENGTH_MIN', cl2.chainLength, G.CHAIN_LENGTH_MIN);
  const cl3 = cs({ chainLength: 0 }); eq('chain chainLength=0 → 默认（2 × 人数 = 8）', cl3.chainLength, 8);

  // 秒数字段的公共工具
  eq('secOrZero(0) = 0', PREFS.secOrZero(0), 0);
  eq('secOrZero(2) = 3', PREFS.secOrZero(2), 3);
  eq('secOrZero(601) = 600', PREFS.secOrZero(601), 600);
  eq('secOrZero(-1) = 0', PREFS.secOrZero(-1), 0);
  eq('secOrZero(NaN) = 0', PREFS.secOrZero(NaN), 0);
  eq('secOrZero(null) = 0', PREFS.secOrZero(null), 0);
  eq('secOrZero(true) = 0', PREFS.secOrZero(true), 0);
  eq('secOrZero("30") = 30', PREFS.secOrZero('30'), 30);
}

console.log('\n[4] repickLimit 真的影响 repick() 的可用次数');
{
  const r = makeRoom(2);
  const g = new Game(r, makeApi(r));
  g.start({ repickLimit: 2 });
  g.drawerId = 'u1';                       // 谁当画手是随机的，测试里定死
  const a = g.repick('u1');
  const b = g.repick('u1');
  const c = g.repick('u1');
  eq('第 1 次换词成功', a.ok, true);
  eq('第 2 次换词成功', b.ok, true);
  eq('第 3 次换词被拒', c.ok, false);
  eq('换完 repickLeft = 0', g.repickLeft, 0);
  eq('阶段没有被换词改掉（还停在选词）', g.phase, PHASE.PICK);

  const r2 = makeRoom(2);
  const g2 = new Game(r2, makeApi(r2));
  g2.start({ repickLimit: 0 });
  g2.drawerId = 'u1';
  const z = g2.repick('u1');
  eq('repickLimit=0 → 一次都不许换', z.ok, false);
  ok('repickLimit=0 的提示说清了原因', /关掉/.test(z.message || ''), z.message);

  const r3 = makeRoom(2);
  const g3 = new Game(r3, makeApi(r3));
  g3.start({});
  g3.drawerId = 'u1';
  eq('缺省时 repickLeft = 默认 1', g3.repickLeft, G.REPICK_LIMIT);
  eq('缺省时第 1 次换词成功', g3.repick('u1').ok, true);
  eq('缺省时第 2 次换词被拒', g3.repick('u1').ok, false);
}

console.log('\n[5] GAME_FAST=1：所有阶段默认 1000ms，宽限不变');
{
  process.env.GAME_FAST = '1';
  for (const m of ['game', 'chain', 'skin']) {
    delete require.cache[require.resolve(R('server/src/' + m + '.js'))];
  }
  const F = {
    game: require(R('server/src/game.js')),
    chain: require(R('server/src/chain.js')),
    skin: require(R('server/src/skin.js'))
  };

  eq('game.PICK_MS = 1000', F.game.CFG.PICK_MS, 1000);
  eq('game.ROUND_MS = 1000', F.game.CFG.ROUND_MS, 1000);
  eq('game.ROUND_END_MS = 1000', F.game.CFG.ROUND_END_MS, 1000);
  for (const k of ['INIT_MS', 'WRITE_MS', 'DRAW_MS', 'GUESS_MS', 'REVEAL_MS', 'VOTE_MS', 'SCORE_MS', 'CHAIN_SCORE_MS']) {
    eq('chain.' + k + ' = 1000', F.chain.CFG[k], 1000);
  }
  eq('chain.GRACE_MS 不变（仍是环境变量值）', F.chain.CFG.GRACE_MS, 1777);
  ok('chain.GRACE_MS ≠ 1000', F.chain.CFG.GRACE_MS !== 1000);
  for (const k of ['NIGHT_MS', 'DAWN_MS', 'DRAW_MS', 'TALK_MS', 'VOTE_MS', 'VOTE_END_MS']) {
    eq('skin.' + k + ' = 1000', F.skin.CFG[k], 1000);
  }
  eq('skin.WITCH_GRACE_MS 不变（仍是环境变量值）', F.skin.CFG.WITCH_GRACE_MS, 1888);
  ok('skin.WITCH_GRACE_MS ≠ 1000', F.skin.CFG.WITCH_GRACE_MS !== 1000);

  // 实例侧：不设覆盖值时每个阶段都是 1 秒
  const r1 = makeRoom(2);
  const g1 = new F.game.Game(r1, makeApi(r1));
  g1.start({});
  eq('fast: classic roundMs() = 1000', g1.roundMs(), 1000);
  eq('fast: classic roundEndMsOf() = 1000', g1.roundEndMsOf(), 1000);
  g1.word = '猫'; g1.beginDraw();
  deadlineNear('fast: classic 作画 deadline = 1s', g1.deadline, 1000);

  const r2 = makeRoom(4);
  const g2 = new F.chain.ChainGame(r2, makeApi(r2));
  g2.start({});
  for (const [ph, name] of [[F.chain.CHAIN_PHASE.WRITE, 'WRITE'], [F.chain.CHAIN_PHASE.DRAW, 'DRAW'],
    [F.chain.CHAIN_PHASE.GUESS, 'GUESS'], [F.chain.CHAIN_PHASE.REVEAL, 'REVEAL'],
    [F.chain.CHAIN_PHASE.VOTE, 'VOTE']]) {
    g2.phase = ph;
    eq('fast: chain stepMs(' + name + ') = 1000', g2.stepMs(), 1000);
  }
  g2.enterStep(0);
  deadlineNear('fast: chain 写词 deadline = 1s', g2.deadline, 1000);

  const r3 = makeRoom(6);
  const g3 = new F.skin.SkinGame(r3, makeApi(r3));
  g3.start({});
  eq('fast: skin 开局入夜的 deadline = 1s', true, true);
  deadlineNear('fast: skin 夜里 deadline = 1s', g3.deadline, 1000);
  for (const [ph, name] of [[F.skin.SKIN_PHASE.NIGHT, 'NIGHT'], [F.skin.SKIN_PHASE.DAWN, 'DAWN'],
    [F.skin.SKIN_PHASE.DAY_DRAW, 'DAY_DRAW'], [F.skin.SKIN_PHASE.DAY_TALK, 'DAY_TALK'],
    [F.skin.SKIN_PHASE.DAY_VOTE, 'DAY_VOTE'], [F.skin.SKIN_PHASE.VOTE_END, 'VOTE_END']]) {
    g3.phase = ph;
    eq('fast: skin phaseMs(' + name + ') = 1000', g3.phaseMs(), 1000);
  }

  // 每局覆盖值仍然优先于 fast（否则「测试环境所有时间可配成 1 秒」会反过来吃掉房主的选择）
  const r4 = makeRoom(4);
  const g4 = new F.chain.ChainGame(r4, makeApi(r4));
  g4.start({ writeSeconds: 30, guessSeconds: 60, drawSeconds: 45 });
  g4.phase = F.chain.CHAIN_PHASE.WRITE;
  eq('fast: 显式 writeSeconds 仍然优先（30s）', g4.stepMs(), 30000);
  g4.phase = F.chain.CHAIN_PHASE.GUESS;
  eq('fast: 显式 guessSeconds 仍然优先（60s）', g4.stepMs(), 60000);
  g4.phase = F.chain.CHAIN_PHASE.DRAW;
  eq('fast: 显式 drawSeconds 仍然优先（45s）', g4.stepMs(), 45000);

  // '0' / 'false' 都算关
  process.env.GAME_FAST = '0';
  delete require.cache[require.resolve(R('server/src/game.js'))];
  const G0 = require(R('server/src/game.js'));
  eq("fast: GAME_FAST='0' 视为关", G0.CFG.PICK_MS, 4321);
  process.env.GAME_FAST = 'false';
  delete require.cache[require.resolve(R('server/src/game.js'))];
  const G1 = require(R('server/src/game.js'));
  eq("fast: GAME_FAST='false' 视为关", G1.CFG.PICK_MS, 4321);
  // 收尾：恢复「关」并把缓存清回非 fast 那一份
  delete process.env.GAME_FAST;
  for (const m of ['game', 'chain', 'skin']) {
    delete require.cache[require.resolve(R('server/src/' + m + '.js'))];
  }
  const back = require(R('server/src/game.js'));
  eq('fast: 清掉 GAME_FAST 后回到环境变量值', back.CFG.PICK_MS, 4321);
}

console.log('\n[6] GAME_START 的白名单（cfg 透传）与协议注释一致');
{
  const src = {
    protocol: fs.readFileSync(R('shared/protocol.js'), 'utf8'),
    index: fs.readFileSync(R('server/src/index.js'), 'utf8'),
    game: fs.readFileSync(R('server/src/game.js'), 'utf8'),
    chain: fs.readFileSync(R('server/src/chain.js'), 'utf8'),
    skin: fs.readFileSync(R('server/src/skin.js'), 'utf8'),
    rooms: fs.readFileSync(R('server/src/rooms.js'), 'utf8')
  };

  // (a) pickStartOpts 把 15 个字段原样透传（含 undefined —— 缺省必须留给 start() 自己决定）
  const full = {
    mode: 'chain', theme: 'arknights', drawSeconds: 45, rounds: 3, repickLimit: 2,
    roundEndSeconds: 20, chainLength: 4, writeSeconds: 7, guessSeconds: 8,
    revealSeconds: 9, voteSeconds: 10, replaySpeed: 1.5, nightSeconds: 12, dawnSeconds: 13, talkSeconds: 14
  };
  const picked = PREFS.pickStartOpts(full);
  const miss = PREFS.GAME_PREF_FIELDS.filter(k => !(k in picked));
  ok('pickStartOpts 一个字段都不漏（' + PREFS.GAME_PREF_FIELDS.length + ' 个）', miss.length === 0, '漏了: ' + miss.join(','));
  ok('pickStartOpts 原样透传（不夹取）', PREFS.pickStartOpts({ writeSeconds: 99999 }).writeSeconds === 99999);
  ok('pickStartOpts 不改 undefined', PREFS.pickStartOpts({ rounds: undefined }).rounds === undefined);
  const dirty = PREFS.pickStartOpts({ rounds: 2, evil: 1, by: 'u9', at: 1, __proto__: { hacked: 1 }, nested: { a: 1 } });
  eqArr('pickStartOpts 丢掉乱字段', Object.keys(dirty).sort(), ['rounds']);
  eq('pickStartOpts 丢掉 __proto__', Object.prototype.hasOwnProperty.call(dirty, 'hacked'), false);

  // (b) index.js 的 startGameOf 真的用了这个白名单（不是又抄了一份）
  ok('index.js 的 startGameOf 用 pickStartOpts', /const cfg = PREFS\.pickStartOpts\(opts\)/.test(src.index));

  // (c) 协议注释里的字段表 = 上面那张表（三处 start() 的字段名也对得上）
  const want = {
    classic: ['mode', 'theme', 'drawSeconds', 'rounds', 'repickLimit', 'roundEndSeconds'],
    chain: ['mode', 'theme', 'drawSeconds', 'chainLength', 'writeSeconds', 'guessSeconds', 'revealSeconds', 'voteSeconds', 'replaySpeed'],
    skin: ['mode', 'theme', 'drawSeconds', 'rounds', 'nightSeconds', 'dawnSeconds', 'talkSeconds', 'voteSeconds']
  };
  const seen = {};
  for (const line of src.protocol.split('\n')) {
    const m = /^\s*\/\/\s+(classic|chain|skin)\s+\{([^}]*)\}/.exec(line);
    if (!m) continue;
    seen[m[1]] = m[2].split(',').map(s => s.trim().replace(/\?$/, '')).filter(Boolean);
  }
  for (const mode of ['classic', 'chain', 'skin']) {
    eqArr('协议注释 ' + mode + ' 字段表', seen[mode], want[mode]);
  }
  const union = [];
  for (const mode of ['classic', 'chain', 'skin']) for (const f of want[mode]) if (union.indexOf(f) < 0) union.push(f);
  eqArr('三张表的并集 = GAME_PREF_FIELDS', union.slice().sort(), PREFS.GAME_PREF_FIELDS.slice().sort());

  // (d) 三处 start() 的实现里真的读了这些字段名（注释与实现不会各说各话）。
  //     mode 是例外：它不进 start()，由 index.js 的 GAME_START 分支用来选玩法（下面单测）。
  const readFields = (mode) => want[mode].filter(f => f !== 'mode');
  eqArr('game.js 读的字段', readFields('classic').filter(f => src.game.indexOf('opts.' + f) >= 0).sort(),
    readFields('classic').slice().sort());
  eqArr('chain.js 读的字段', readFields('chain').filter(f => src.chain.indexOf('opts.' + f) >= 0).sort(),
    readFields('chain').slice().sort());
  eqArr('skin.js 读的字段', readFields('skin').filter(f => src.skin.indexOf('opts.' + f) >= 0).sort(),
    readFields('skin').slice().sort());
  ok('index.js 的 GAME_START 用 msg.mode 选玩法',
    /GAME_MODES\[msg\.mode\] \? msg\.mode : 'classic'/.test(src.index));
}

console.log('\n[7] pendingGame：清洗 / 夹取 / 权限 / 清空 / 换房主');
{
  // (a) 形状固定：无论发什么，存下来的一定是那 14 个字段
  const cleaned = PREFS.normalizeGamePrefs({
    mode: 'skin', theme: 'genshin', rounds: 4, drawSeconds: 60, repickLimit: 3,
    roundEndSeconds: 30, chainLength: 6, writeSeconds: 20, guessSeconds: 21, revealSeconds: 22,
    voteSeconds: 23, nightSeconds: 24, dawnSeconds: 25, talkSeconds: 26,
    by: 'hacker', at: 1, evil: 'x', __proto__: { hacked: 1 }
  });
  eqArr('清洗后的字段表固定', Object.keys(cleaned).sort(), PREFS.GAME_PREF_FIELDS.slice().sort());
  eq('mode 收下 skin', cleaned.mode, 'skin');
  eq('theme 收下 genshin', cleaned.theme, 'genshin');
  eq('rounds = 4', cleaned.rounds, 4);
  eq('nightSeconds = 24', cleaned.nightSeconds, 24);

  // (b) 越界被夹住
  const clamp = PREFS.normalizeGamePrefs({
    rounds: 999, drawSeconds: 99999, repickLimit: 99, roundEndSeconds: 1, chainLength: 999,
    writeSeconds: 1, guessSeconds: 99999, revealSeconds: -3, voteSeconds: 'x',
    nightSeconds: 2, dawnSeconds: 0, talkSeconds: 601
  });
  eq('rounds 999 → classic 上限 20', clamp.rounds, G.MAX_ROUNDS);
  eq('drawSeconds 99999 → 300', clamp.drawSeconds, G.DRAW_SECONDS_MAX);
  eq('repickLimit 99 → 5', clamp.repickLimit, 5);
  eq('roundEndSeconds 1 → 3', clamp.roundEndSeconds, 3);
  eq('chainLength 999 → CHAIN_LENGTH_MAX', clamp.chainLength, G.CHAIN_LENGTH_MAX);
  eq('writeSeconds 1 → 3', clamp.writeSeconds, 3);
  eq('guessSeconds 99999 → 600', clamp.guessSeconds, 600);
  eq('revealSeconds -3 → 0（用默认）', clamp.revealSeconds, 0);
  eq('voteSeconds "x" → 0（用默认）', clamp.voteSeconds, 0);
  eq('nightSeconds 2 → 3', clamp.nightSeconds, 3);
  eq('dawnSeconds 0 → 0（用默认）', clamp.dawnSeconds, 0);
  eq('talkSeconds 601 → 600', clamp.talkSeconds, 600);
  eq('mode 乱值 → classic', PREFS.normalizeGamePrefs({ mode: 'nope' }).mode, 'classic');
  eq('theme 乱值 → 空串（用默认词库）', PREFS.normalizeGamePrefs({ theme: '不存在的词库' }).theme, '');
  eq('skin 的 rounds 上限是 SKIN_MAX_ROUNDS',
    PREFS.normalizeGamePrefs({ mode: 'skin', rounds: 999 }).rounds, G.SKIN_MAX_ROUNDS);
  eq('rounds 缺省 → 具体默认回合数（面板没有 0 档）',
    PREFS.normalizeGamePrefs({}).rounds, G.DEFAULT_ROUNDS);
  eq('repickLimit 0 → 0（实义值）', PREFS.normalizeGamePrefs({ repickLimit: 0 }).repickLimit, 0);
  eq('repickLimit 缺省 → 默认 1', PREFS.normalizeGamePrefs({}).repickLimit, G.REPICK_LIMIT);
  eq('chainLength 缺省 → 0（= 开局按人数算）', PREFS.normalizeGamePrefs({}).chainLength, 0);

  // (c) 权限：非房主被拒，且房间状态一个字节都没动
  const room = makeRoom(3);
  const bad = PREFS.applyGamePrefs(room, { userId: 'u2', name: 'P2' }, { rounds: 3 });
  eq('非房主被拒', bad.ok, false);
  eq('非房主的错误码', bad.code, 'not_owner');
  eq('非房主没有写房间', room.pendingGame, null);
  eq('没有房间也被拒', PREFS.applyGamePrefs(null, { userId: 'u1' }, {}).ok, false);
  eq('没有成员也被拒', PREFS.applyGamePrefs(room, null, {}).ok, false);

  // (d) 房主发了才落盘 + 广播载荷
  const good = PREFS.applyGamePrefs(room, { userId: 'u1', name: 'P1' }, { mode: 'classic', theme: 'genshin', rounds: 4, repickLimit: 2 });
  eq('房主可以预设', good.ok, true);
  ok('返回的 prefs 就是 room.pendingGame', good.prefs === room.pendingGame);
  eq('by = 发送者', room.pendingGame.by, 'u1');
  ok('at 是时间戳', typeof room.pendingGame.at === 'number' && room.pendingGame.at > 0);
  eqArr('广播载荷字段表 = 14 + by/at', Object.keys(room.pendingGame).sort(), PREFS.GAME_PREF_FIELDS.concat(['by', 'at']).sort());
  const again = PREFS.applyGamePrefs(room, { userId: 'u1' }, { mode: 'classic', rounds: 2 });
  eq('再改一次就覆盖（不是追加）', again.prefs.rounds, 2);
  eq('覆盖后仍然是同一份对象', room.pendingGame, again.prefs);

  // (e) 清空 / 换房主
  PREFS.retargetGamePrefs(room, 'u2');
  eq('换房主只换 by', room.pendingGame.by, 'u2');
  eq('换房主保留了设置', room.pendingGame.rounds, 2);
  PREFS.clearGamePrefs(room);
  eq('GAME_START / GAME_STOP 后清空', room.pendingGame, null);
  PREFS.clearGamePrefs(null);   // 不该抛
  ok('clearGamePrefs(null) 不抛', true);

  // (f) 静态接线：index.js 在正确的时机调了这些函数
  const idx = fs.readFileSync(R('server/src/index.js'), 'utf8');
  ok('index.js 收了 C2S.GAME_PREFS', /case P\.C2S\.GAME_PREFS:/.test(idx));
  ok('GAME_PREFS 分支里清洗 + 广播', /PREFS\.applyGamePrefs\(room, member, msg\)/.test(idx) &&
    /roomBroadcast\(room, P\.S2C\.GAME_PREFS, \{ prefs: r\.prefs \}\)/.test(idx));
  const clears = (idx.match(/PREFS\.clearGamePrefs\(room\)/g) || []).length;
  ok('GAME_START 成功 + GAME_STOP 两处都清空（实际 ' + clears + ' 处）', clears >= 2);
  const retargets = (idx.match(/PREFS\.retargetGamePrefs\(/g) || []).length;
  ok('HOST_TRANSFER 与自动移交都换 by（实际 ' + retargets + ' 处）', retargets >= 2);

  // (g) 房间列表不带 pendingGame（列表页不需要）
  const summaryBody = /summary\(\)\s*\{([\s\S]*?)\n  \}/.exec(fs.readFileSync(R('server/src/rooms.js'), 'utf8'));
  ok('rooms.js 的 summary() 夹出来了', !!summaryBody);
  ok('summary() 不带 pendingGame', !!summaryBody && summaryBody[1].indexOf('pendingGame') < 0);
  ok('rooms.js 上挂了 pendingGame（照 projectLoad 的先例）',
    /this\.pendingGame = null;/.test(fs.readFileSync(R('server/src/rooms.js'), 'utf8')));
  ok('pendingGame 不落盘（save() 里没有它）',
    fs.readFileSync(R('server/src/rooms.js'), 'utf8').indexOf('pendingGame') >= 0 &&
    !/payload\s*=\s*\{[\s\S]*pendingGame/.test(fs.readFileSync(R('server/src/rooms.js'), 'utf8')));
}

console.log('\n[8] /api/share 的新增内容 + setup 档位');
{
  const idx = fs.readFileSync(R('server/src/index.js'), 'utf8');
  ok('/api/share 报 fast 字段', /fast: PREFS\.isGameFast\(\)/.test(idx));
  ok('/api/share 报 setup 块', /setup: PREFS\.setupOptions\(\)/.test(idx));
  ok('/api/share 的 chain 块补了 CHAIN_SCORE_MS', /CHAIN_SCORE_MS: CHAIN_CFG\.CHAIN_SCORE_MS/.test(idx));

  const setup = PREFS.setupOptions();
  eqArr('setup.seconds', setup.seconds, [0, 3, 5, 10, 20, 30, 60, 90, 120, 180, 300]);
  eqArr('setup.players.classic', setup.players.classic, [2, 8]);
  eqArr('setup.players.chain', setup.players.chain, [4, 16]);
  eqArr('setup.players.skin', setup.players.skin, [6, 12]);
  eqArr('setup.repick', setup.repick, [0, 1, 2, 3]);
  eqArr('setup.rounds', setup.rounds, [1, 2, 3, 4, 6, 8, 12]);
  eq('classic 下限取自 P.GAME.MIN_PLAYERS', setup.players.classic[0], G.MIN_PLAYERS);
  eq('classic 上限取自 P.GAME.MAX_PLAYERS', setup.players.classic[1], G.MAX_PLAYERS);
  eq('chain 上限取自 P.GAME.CHAIN_MAX_PLAYERS', setup.players.chain[1], G.CHAIN_MAX_PLAYERS);
  eq('skin 上限取自 P.GAME.SKIN_MAX_PLAYERS', setup.players.skin[1], G.SKIN_MAX_PLAYERS);
  // ★ v11：链长档位也一并下发（默认 / 上限都是 perPlayer × 人数）
  eq('setup.chainLength.min = CHAIN_LENGTH_MIN', setup.chainLength.min, G.CHAIN_LENGTH_MIN);
  eq('setup.chainLength.max = CHAIN_LENGTH_MAX', setup.chainLength.max, G.CHAIN_LENGTH_MAX);
  eq('setup.chainLength.perPlayer = 2（链长 = 2 × 人数）', setup.chainLength.perPlayer, 2);
  ok('★ 4 人房默认链长 = 2 × 4 = 8', setup.chainLength.perPlayer * 4 === 8);
  ok('秒数档位都在 [3, 600] 或 0 之内（除 0 外没有一个越界）',
    setup.seconds.every(v => v === 0 || (v >= G.SETUP_SECONDS_MIN && v <= G.SETUP_SECONDS_MAX)));

  // 协议里确实有这两条消息（前端据此对接）
  eq('C2S.GAME_PREFS = game:prefs', P.C2S.GAME_PREFS, 'game:prefs');
  eq('S2C.GAME_PREFS = game:prefs', P.S2C.GAME_PREFS, 'game:prefs');
  eq('★ 协议版本已推进到 v16（逐格时长 + 按笔数播动画 + 猜词定格 2 秒）',
    P.PROTOCOL_VERSION, 16);
  ok('★ v16：每一格的时长不再一样 —— 起词 / 猜词格一拍，作画格按笔数 + 悬念尾',
    P.GAME.CHAIN_REVEAL_WORD_MS > 0 && P.GAME.CHAIN_REVEAL_GUESS_MS >= 2000
      && P.GAME.CHAIN_REVEAL_TEASE_MS >= 2000
      && P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS > 0
      && P.GAME.CHAIN_REVEAL_DRAW_MIN_MS > 0 && P.GAME.CHAIN_REVEAL_DRAW_MAX_MS > P.GAME.CHAIN_REVEAL_DRAW_MIN_MS,
    { word: P.GAME.CHAIN_REVEAL_WORD_MS, guess: P.GAME.CHAIN_REVEAL_GUESS_MS,
      tease: P.GAME.CHAIN_REVEAL_TEASE_MS, per: P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS,
      min: P.GAME.CHAIN_REVEAL_DRAW_MIN_MS, max: P.GAME.CHAIN_REVEAL_DRAW_MAX_MS });
  eq('★ v16：chainRevealAnimMs 是两端共用的那条公式（起步 + 每笔，夹上下限，再除倍速）',
    [P.chainRevealAnimMs(0, 1), P.chainRevealAnimMs(12, 2), P.chainRevealAnimMs(999, 1)].join(','),
    [P.GAME.CHAIN_REVEAL_DRAW_MIN_MS,
      Math.round((P.GAME.CHAIN_REVEAL_DRAW_BASE_MS + 12 * P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS) / 2),
      P.GAME.CHAIN_REVEAL_DRAW_MAX_MS].join(','));
  eq('isGameFast() 默认 false', PREFS.isGameFast(), false);
  process.env.GAME_FAST = '1';
  eq("isGameFast('1') = true", PREFS.isGameFast(), true);
  process.env.GAME_FAST = '0';
  eq("isGameFast('0') = false", PREFS.isGameFast(), false);
  delete process.env.GAME_FAST;
}

console.log('\n——————————————————————————————');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('');
if (fail) {
  console.log('\u2717 有失败项 —— 见上面标 \u2717 的行');
  process.exitCode = 1;
} else {
  console.log('\u2713 服务端「每局可配的游戏设置」自测全通过');
}
