'use strict';
/**
 * 接龙状态机的离线推演（不碰 WebSocket）—— 先把链条传递、阶段推进、投票计分
 * 这些纯逻辑跑通，再接进 index.js。跑完即删。
 */
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const { ChainGame, CHAIN_PHASE, STEP, CFG } = require(R('server/src/chain'));
const P = require(R('server/src/protocol'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 造一个假的 room + api */
function makeRoom(names) {
  const members = new Map();
  names.forEach((n, i) => members.set('u' + (i + 1), { userId: 'u' + (i + 1), name: n, color: '#000' }));
  return {
    members,
    ownerId: 'u1',
    layers: [],
    layerList() { return []; },
    clear() {},
    addChat() {},
    get strokes() { return []; },
    seq: 0
  };
}
function makeGame(names, rounds) {
  const room = makeRoom(names);
  const chats = [];
  let syncs = 0;
  const api = {
    sync() { syncs++; },
    systemChat(t) { chats.push(t); },
    resetCanvas() {},
  };
  const g = new ChainGame(room, api);
  const r = g.start({ rounds: rounds || 2, theme: 'arknights' });
  g.__chats = chats;
  g.__syncs = () => syncs;
  // start() 现在自己就把第一圈开起来了（round=1、assign 已排好、候选词已发）。
  // 下面的用例习惯「makeGame 之后自己再调一次 beginRound()」来开第一圈 ——
  // 为了不改 40 处调用点，这里把 round 退回 0，让那次 beginRound() 仍然落在第 1 圈。
  // （这不是在掩盖问题：真实调用方只会调 start()，不会补一次 beginRound。）
  if (g.round === 1) { g.round = 0; g.assign = new Map(); g.submitted = new Set(); }
  return { g, room, chats, r };
}

console.log('\n[1] 开局与人数限制');
{
  const a = makeGame(['甲', '乙', '丙']);          // 3 人 < 4
  ok('少于 4 人开不了局', a.r.ok === false && a.r.code === 'too_few', JSON.stringify(a.r));

  const b = makeGame(['甲', '乙', '丙', '丁']);
  ok('4 人可以开局', b.r.ok === true);
  ok('每人一条链', b.g.chains.length === 4);
  ok('传递顺序已固定', b.g.order.length === 4);
  ok('开局成功（start 返回 ok）', b.r.ok === true, JSON.stringify(b.r));
}

console.log('\n[2] 第一圈：所有人都在「写词」');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 2);
  g.beginRound();
  ok('阶段 = chain_write', g.phase === CHAIN_PHASE.WRITE, g.phase);
  ok('4 个人都有活', g.assign.size === 4, String(g.assign.size));
  const steps = Array.from(g.assign.values()).map(c => c.step);
  ok('这一步全是 write', steps.every(s => s === STEP.WRITE), steps.join(','));
  ok('每人都拿到了候选词', Array.from(g.assign.values()).every(c => c.choices && c.choices.length === 3));
  ok('写词阶段全员锁笔', g.lockedFor('u1') === true);
  ok('快照里带主题名', g.snapshotFor('u1').themeName === '明日方舟');
}

console.log('\n[3] 词 → 画：链条把词交给下家（不给本人）');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  // 每人给自己的链写一个词
  let i = 0;
  for (const uid of Array.from(g.assign.keys())) {
    g.submitWord(uid, '测试词' + (++i));
  }
  ok('写完全场 → 进入第二圈', g.round === 2, 'round=' + g.round);
  ok('阶段 = chain_draw', g.phase === CHAIN_PHASE.DRAW, g.phase);

  // 第二圈每人的活应该都是「照上家的词作画」，且不会轮到自己
  const rows = Array.from(g.assign.entries()).map(([uid, c]) => ({ uid, step: c.step, word: c.word }));
  ok('这一步全是 draw', rows.every(r => r.step === STEP.DRAW), rows.map(r => r.step).join(','));
  ok('都拿到了要画的词', rows.every(r => r.word), rows.map(r => r.word).join(','));
  // 关键：不会画自己起的词
  const selfDraw = rows.filter(r => g.chains.find(c => c.ownerId === r.uid && c.cells[0] && c.cells[0].word === r.word));
  ok('没人画自己起的那条链的词', selfDraw.length === 0, JSON.stringify(selfDraw.map(x => x.uid)));
  ok('作画阶段锁住非当事人', g.lockedFor('u1') === (g.assign.get('u1') ? false : true));
}

console.log('\n[4] 画 → 猜：下一个人只拿到「画」，拿不到词');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  let i = 0;
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '原词' + (++i));
  // 作画
  for (const uid of Array.from(g.assign.keys())) {
    g.submitArt(uid, 'data:image/png;base64,AAAA');
  }
  ok('作画交齐 → 第三圈', g.round === 3, 'round=' + g.round);
  ok('阶段 = chain_guess', g.phase === CHAIN_PHASE.GUESS, g.phase);

  const rows = Array.from(g.assign.entries()).map(([uid, c]) => ({ uid, c }));
  ok('这一步全是 guess', rows.every(r => r.c.step === STEP.GUESS));
  // 每一步的题面：只有 image，绝没有 word
  let leaked = 0;
  for (const { c } of rows) {
    const t = g.taskFor(Array.from(g.assign.entries()).find(([, cc]) => cc === c)[0]);
    if (!t) { leaked++; continue; }
    if (t.word) leaked++;
    if (!t.image) leaked++;
  }
  ok('题面只有图、没有词', leaked === 0, 'leaked=' + leaked);
  ok('猜词阶段锁笔（画布上放着上家的画）', g.lockedFor('u1') === true);
}

console.log('\n[5] 猜错就继续传：猜出来的词成为下一圈的画题');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 4);
  g.beginRound();
  let i = 0;
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '起点' + (++i));
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  for (const uid of Array.from(g.assign.keys())) g.submitGuess(uid, '猜的' + (i++));
  ok('猜完 → 第四圈', g.round === 4, 'round=' + g.round);
  ok('第四圈又回到作画', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const words = Array.from(g.assign.values()).map(c => c.word);
  ok('这一圈的词来自「上一圈的猜词结果」', words.every(w => /^猜的/.test(w)), words.join(','));
}

console.log('\n[6] 走完所有圈 → 回放 + 投票');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 2);
  g.beginRound();
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '长颈鹿');
  // 第 2 圈是作画，也要交 —— 两圈都走完才进回放
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  ok('两圈走完进回放/投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  ok('回放有 4 条链', g.replay && g.replay.length === 4, String(g.replay && g.replay.length));
  const c0 = g.replay[0];
  ok('回放含首词', c0.firstWord === '长颈鹿', c0.firstWord);
  ok('第二格是画', c0.cells[1].step === STEP.DRAW, c0.cells.map(c => c.step).join(','));
  ok('回放阶段不下发「谁投了谁」', JSON.stringify(g.snapshotFor('u1').myVotes) === '[]');
}

console.log('\n[7] 三圈的真实接龙：词 → 画 → 猜（首尾对不上）');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '长颈鹿');
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  // 第 3 圈是猜词 —— 大家故意猜错
  for (const uid of Array.from(g.assign.keys())) g.submitGuess(uid, '怪物卡车');
  ok('三圈走完进回放', g.phase === CHAIN_PHASE.VOTE, g.phase);
  const c0 = g.replay[0];
  ok('链条形状 = 词/画/猜', c0.cells.map(x => x.step).join(',') === 'write,draw,guess',
    c0.cells.map(x => x.step).join(','));
  ok('首词 = 长颈鹿', c0.firstWord === '长颈鹿', c0.firstWord);
  ok('末词 = 怪物卡车', c0.lastWord === '怪物卡车', c0.lastWord);
  ok('首尾不一致 → matched=false', c0.matched === false);
  g.finishVoting();
  ok('对不上的链不发奖杯', g.voteResult.filter(r => r.won).length === 0);
}

console.log('\n[8] 传到最后能对上 → 拿奖杯');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '长颈鹿');
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  // 这次大家都猜对了 —— 首尾一致
  for (const uid of Array.from(g.assign.keys())) g.submitGuess(uid, '长颈鹿');
  ok('首尾一致 → matched=true', g.replay[0].matched === true, g.replay[0].firstWord + '/' + g.replay[0].lastWord);
  // 全员同意（不投反对）
  g.finishVoting();
  ok('阶段 = over', g.phase === CHAIN_PHASE.OVER);
  ok('4 条链全部算「对得上」', g.voteResult.filter(r => r.won).length === 4,
    JSON.stringify(g.voteResult.map(r => r.won)));
  const total = g.scoreList().reduce((s, r) => s + r.score, 0);
  ok('每个起词的人都拿到奖杯（共 4 个）', total === 4 * P.GAME.CHAIN_TROPHY_AGREE, String(total));
  ok('榜单有 4 个人', g.scoreList().length === 4);
}

console.log("\n[9] 多数人反对 → 不给奖杯");
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '长颈鹿');
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  for (const uid of Array.from(g.assign.keys())) g.submitGuess(uid, '长颈鹿');
  const target = g.replay[0].id;
  // 3 / 4 人投「对不上」—— 就算首尾真的一致，多数人反对也不发奖杯
  g.vote('u1', target, false);
  g.vote('u2', target, false);
  g.vote('u3', target, false);
  g.vote('u4', target, true);
  g.finishVoting();
  const r0 = g.voteResult.filter(r => r.id === target)[0];
  ok('被多数反对的链不发奖杯（哪怕首尾一致）', r0.won === false && r0.against === 3 && r0.matched === true,
    JSON.stringify(r0));
  ok('其他 3 条不受影响', g.voteResult.filter(r => r.won).length === 3);
}

console.log("\n[9b] 少数反对不影响发奖");
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '长颈鹿');
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  for (const uid of Array.from(g.assign.keys())) g.submitGuess(uid, '长颈鹿');
  const target = g.replay[0].id;
  g.vote('u1', target, false);   // 只有 1 / 4 反对
  g.finishVoting();
  const r0 = g.voteResult.filter(r => r.id === target)[0];
  ok('1 票反对不推翻结论', r0.won === true && r0.against === 1, JSON.stringify(r0));
}

console.log("\n[10] 超时推进（不让人卡住）");
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 2);
  g.beginRound();
  const before = g.round;
  g.deadline = Date.now() - 1;      // 假装到点了
  g.tick(Date.now());
  ok('超时后进入下一圈（没人交也往前走）', g.round === before + 1, 'round=' + g.round);
  const empty = g.chains.filter(c => c.cells[0] && c.cells[0].skipped);
  ok('没交的格子被标记 skipped', empty.length === 4, String(empty.length));
}

console.log("\n[11] 故意泄题检查：任何快照都不该带别人的词");
{
  const { g } = makeGame(['甲', '乙', '丙', '丁'], 3);
  g.beginRound();
  let i = 0;
  for (const uid of Array.from(g.assign.keys())) g.submitWord(uid, '秘密词' + (++i));
  // 现在在作画阶段 —— 快照里不该有任何「别人的词」
  const snap = g.snapshotFor('u1');
  const s = JSON.stringify(snap);
  ok('作画阶段快照不含其他链的词', s.indexOf('秘密词') < 0, s.slice(0, 120));
  // 这一步在猜词的人，他的快照也不该包含词
  for (const uid of Array.from(g.assign.keys())) g.submitArt(uid, 'data:image/png;base64,QQ==');
  const snap2 = JSON.stringify(g.snapshotFor('u1'));
  ok('猜词阶段快照不含词', snap2.indexOf('秘密词') < 0, snap2.slice(0, 140));
  ok('猜词阶段快照不含任何人的图（只走 GAME_TASK 单发）', snap2.indexOf('base64') < 0);
}

console.log('\n' + '─'.repeat(46));
console.log('  通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 1;
