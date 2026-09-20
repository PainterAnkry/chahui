'use strict';
/**
 * 接龙 v2（多链并行 Whisper）状态机离线推演（不碰 WebSocket）。
 *
 * 验证的是重制后的核心机制：
 *   - 大厅（全员准备自动开局）与人数/链长限制
 *   - N 人 = N 条并行链，环形一一映射（每阶段每人恰好一格，绝不会被派两次）
 *   - 写词 → 作画 → 猜词交替，产物是「笔迹」而不是 PNG
 *   - 信息隔离：快照零内容；题面只给当事者
 *   - 回放（GAME_REVEAL）→ 双投票（keep + fav）→ 结算 → 回大厅
 *   - 超时宽限 / 空格 / 中途离场
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

/* ---------------- 造假 room / api ---------------- */

function makeRoom(names) {
  const members = new Map();
  names.forEach((n, i) => members.set('u' + (i + 1), { userId: 'u' + (i + 1), name: n, color: '#000' }));
  const room = {
    members,
    ownerId: 'u1',
    strokes: [],
    clear() { room.strokes = []; },
    addChat() {},
    seq: 0
  };
  return room;
}

function makeGame(names, opts) {
  const room = makeRoom(names);
  const chats = [];
  let syncs = 0;
  const reveals = [];
  const api = {
    sync() { syncs++; },
    systemChat(t) { chats.push(t); },
    resetCanvas() { room.strokes = []; },
    revealAll(chains, version) { reveals.push({ chains, version }); }
  };
  const g = new ChainGame(room, api);
  const r = g.start(Object.assign({ theme: 'arknights' }, opts || {}));
  return { g, room, chats, reveals, r, api };
}

/** 交当前一格：WRITE/DRAWING/GUESS 各按类型交（全员交齐自动收格） */
function playGrid(g, room, mode) {
  const type = g.stepTypeOf(g.stepIndex);
  const k = g.stepIndex;
  for (const uid of g.ring) {
    const ch = g.cellOf(uid, k);
    if (type === STEP.WORD) {
      g.submit(uid, { text: mode === 'same' ? '长颈鹿' : ('词_' + ch.chainId) });
    } else if (type === STEP.DRAWING) {
      room.strokes.push({ userId: uid, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: '#112233', size: 5, ts: 1, te: 2 });
      g.submit(uid, {});
    } else {
      g.submit(uid, { text: mode === 'same' ? '长颈鹿' : ('猜_' + ch.chainId) });
    }
  }
  return type;
}

/** 全员就绪开局并推进到第 k 格（k=0 写词格）。不传 k 就停在开局鼓点 */
function toGrid(g, room, k, mode) {
  for (const p of g.playerList()) g.toggleReady(p.userId, true);
  if (k == null) return;
  g.tick(Date.now() + 9999999);                       // INIT → 第 0 格
  while (g.isPlaying() && g.stepIndex < k) playGrid(g, room, mode || 'free');
}

console.log('\n[1] 大厅与人数限制');
{
  const a = makeGame(['甲', '乙', '丙']);              // 3 人 < 4
  ok('少于 4 人开不了局', a.r.ok === false && a.r.code === 'too_few', JSON.stringify(a.r));

  const b = makeGame(['甲', '乙', '丙', '丁']);
  ok('4 人可以开局（进大厅）', b.r.ok === true && b.g.phase === CHAIN_PHASE.LOBBY, b.g.phase);
  ok('还没开局：没有链', b.g.chains.length === 0);
  ok('开局设置里链长默认 = 人数 + 1（第 0、1 格都是链主）', b.g.chainLength === 5, String(b.g.chainLength));

  const c = makeGame(['甲', '乙', '丙', '丁', '戊'], { chainLength: 3 });
  ok('5 人房链长可设 3', c.g.chainLength === 3, String(c.g.chainLength));
  const d = makeGame(['甲', '乙', '丙', '丁', '戊'], { chainLength: 99 });
  ok('链长 99 被夹到 人数+1 = 6', d.g.chainLength === 6, String(d.g.chainLength));

  // 局中（写词格）再 start → 拒绝
  toGrid(d.g, d.room, 0);
  const again = d.g.start({ theme: 'default' });
  ok('局中重复 start 被拒', again.ok === false && again.code === 'game_busy', JSON.stringify(again));
}

console.log('\n[2] 大厅准备：全员就绪自动开局');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁']);
  for (const p of g.playerList().slice(0, 3)) g.toggleReady(p.userId, true);
  ok('3/4 就绪不开局', g.phase === CHAIN_PHASE.LOBBY);
  ok('快照带 myReady / readyCount', g.snapshotFor('u4').myReady === false && g.snapshotFor('u1').myReady === true);
  g.toggleReady('u4', true);
  ok('全员就绪 → 开场鼓点（chain_init）', g.phase === CHAIN_PHASE.INIT, g.phase);
  ok('4 条链已排好', g.chains.length === 4);
  ok('环序 = 4 人（打乱冻结）', g.ring.length === 4);
  ok('每条链记录 owner/steps/status', g.chains.every(c => c.chainId && c.ownerPlayerId && c.status === 'active' && Array.isArray(c.steps)));

  // 推进过鼓点 → 第 0 格（写词）
  g.tick(Date.now() + 9999999);
  ok('鼓点结束进入写词格', g.phase === CHAIN_PHASE.WRITE, g.phase);
  ok('写词阶段全员锁笔', g.lockedFor('u1') === true);
  const t = g.taskFor('u1');
  ok('题面：WORD + 3 个候选词', t && t.step === STEP.WORD && (t.choices || []).length === 3, JSON.stringify(t && t.choices));
}

console.log('\n[3] 环形一一映射：每阶段每人恰好一格');
{
  const { g } = makeGame(['甲', '乙', '丙', '丁', '戊'], { chainLength: 5 });
  toGrid(g, g.room, 0);
  ok('5 条并行链', g.chains.length === 5);
  // 第 0 格：cellOf(owner, 0) 就是自己的链（链主自己写起词）
  ok('第 0 格各写各的链', g.chains.every(c => g.cellOf(c.ownerPlayerId, 0) === c));
  // 第 k 格的一一映射：把每个人在第 k 格负责的链收起来，应当恰好是一条置换
  for (const k of [1, 2, 3, 4]) {
    const seen = new Set();
    for (const uid of g.ring) seen.add(g.cellOf(uid, k).chainId);
    ok('第 ' + (k + 1) + ' 手每人一格不重复（置换）', seen.size === 5, [...seen].join(','));
  }
  // 链条推进后：每格的 playerId 必须等于「链主往后数 authorOffset(k) 个人」
  toGrid(g, g.room, 5, 'free');                 // 链长 5：五格全部走完 → 回放
  ok('全程走完进入回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  const c1 = g.chains[0];
  let allMatch = true;
  for (let k = 0; k < c1.steps.length; k++) {
    const expect = g.authorOf(c1, k);
    if (c1.steps[k].playerId !== expect) allMatch = false;
  }
  ok('每格的作者都符合「链主 + authorOffset(k)」', allMatch,
    JSON.stringify(c1.steps.map(s => s.playerId)));
  // ★ 新模型的核心：第 0、1 两格**都是链主**（写起词 + 画自己的起词）
  ok('★ 第 0 格（起词）是链主本人',
    c1.steps[0].playerId === c1.ownerPlayerId, c1.steps[0].playerId);
  ok('★ 第 1 格（画1）也是链主本人 —— 写完自己先画自己的词',
    c1.steps[1].playerId === c1.ownerPlayerId, c1.steps[1].playerId);
  ok('第 2 格起才往下传（换人）', c1.steps[2].playerId !== c1.ownerPlayerId,
    c1.steps[2].playerId);
}

console.log('\n[4] 画与猜交替：词→画→猜→画');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 4 });
  toGrid(g, room, 0, 'free');
  playGrid(g, room, 'free');                    // 写词 → 自动收格
  ok('写完 → 作画阶段', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const t1 = g.taskFor('u1');
  ok('作画题面带要画的词、不带笔迹', t1 && t1.step === STEP.DRAWING && t1.word && !t1.strokes, JSON.stringify(t1 && t1.word));
  ok('作画阶段当事者可动笔', g.lockedFor('u1') === false);
  playGrid(g, room, 'free');                    // 作画 → 猜词
  ok('画完 → 猜词阶段', g.phase === CHAIN_PHASE.GUESS, g.phase);
  ok('猜词阶段锁笔', g.lockedFor('u1') === true);
  const t2 = g.taskFor('u1');
  ok('猜词题面是笔迹数组、绝无词', t2 && t2.step === STEP.GUESS && Array.isArray(t2.strokes) && t2.strokes.length === 1 && !t2.word, JSON.stringify(t2 && t2.strokes && t2.strokes.length));
  playGrid(g, room, 'free');                    // 猜词 → 作画
  ok('猜完 → 又回到作画', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const rows = g.chains.map(c => ({ chainId: c.chainId, word: c.steps[2].content }));
  ok('第二次作画的词 = 上一手的猜词', rows.every(r => r.word === '猜_' + r.chainId), JSON.stringify(rows));
}

console.log('\n[5] DRAWING 的产物是笔迹（按作者摘取）');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  room.strokes.push({ userId: 'u9', points: [{ x: 0, y: 0 }], color: '#000', size: 9 });   // 干扰项：非环内的人
  playGrid(g, room, 'free');
  playGrid(g, room, 'free');                    // 进入作画格（k=1）并交
  const c = g.chains[0];
  const st = c.steps[1];
  ok('DRAWING 格 content 是笔迹数组', st.type === STEP.DRAWING && Array.isArray(st.content) && st.content.length === 1,
    JSON.stringify(st.content || []).slice(0, 80));
  // captureStrokes 摘的是「作者自己的那笔」（环内玩家的 size=5 / 2 个点；干扰项 size=9 / 1 个点）
  ok('笔迹按作者摘取（那笔是环内玩家的）', st.content[0].size === 5 && st.content[0].points.length === 2,
    JSON.stringify(st.content[0]).slice(0, 100));
  ok('没有混进干扰项', !st.content.some(s => s.userId === 'u9'));
}

console.log('\n[6] 信息隔离：快照零内容 + 题面只给当事者');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 4 });
  toGrid(g, room, 0, 'free');
  let leaked = 0;
  // 写词阶段：快照不该有任何词（候选词也在题面里，不进快照）
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/词_c\d/.test(s)) leaked++;
  }
  ok('写词阶段快照零内容', leaked === 0);
  playGrid(g, room, 'free');
  // 作画阶段：快照里没有「词_cN」；题面只有自己那条链的词
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/词_c\d|长颈鹿/.test(s)) leaked++;
    const t = g.taskFor(uid);
    const myChain = g.cellOf(uid, g.stepIndex);
    if (!t || t.chainId !== myChain.chainId || t.word !== '词_' + myChain.chainId) leaked++;
  }
  ok('作画阶段：快照无词、题面只给自己那条', leaked === 0, 'leaked=' + leaked);
  playGrid(g, room, 'free');
  // 猜词阶段：快照无笔迹（base64/points），题面笔迹只给自己
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/points|"DRAWING"/.test(s)) leaked++;
    const t = g.taskFor(uid);
    const myChain = g.cellOf(uid, g.stepIndex);
    const prev = myChain.steps[g.stepIndex - 1];
    if (!t || t.step !== STEP.GUESS || JSON.stringify(t.strokes) !== JSON.stringify(prev.content)) leaked++;
  }
  ok('猜词阶段：快照无笔迹、题面只给上家的画', leaked === 0, 'leaked=' + leaked);
  // 回放阶段：快照依旧零内容（回放数据走 GAME_REVEAL 单独广播）
  toGrid(g, room, 4, 'free');
  const s2 = JSON.stringify(g.snapshotFor('u1'));
  ok('回放阶段快照仍零内容（不带链条数据）', !/points|词_c|猜_c/.test(s2), s2.slice(0, 120));
  ok('回放通过 api.revealAll 广播一次', g.phase === CHAIN_PHASE.REVEAL);
}

console.log('\n[6.5] 写词的词条规则：中文 / 英文 / 数字都收，一个字也收');
// 以前这里要求「必须含中文」，英文词和一个字的梗全被挡在外面（用户要求放开）。
// 放开之后由别处兜底：露字提示有 HINT_MIN_LEN=3（1 字与 2 字都不给提示），
// 「很接近了」的误报有 isNearGuess 的 `w.length < 2 → false`。
{
  // 每一档都新开一局：submit 成功会推进/锁笔，复用同一局会让后面的判据失真
  const tryWord = (text) => {
    const m = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
    toGrid(m.g, m.room, 0, 'free');
    return m.g.submit('u1', { text }).ok;
  };
  ok('中文三字照收', tryWord('长颈鹿') === true);
  ok('★ 单个汉字也收（以前被自检拦在词库外）', tryWord('猫') === true, '猫');
  ok('★ 英文单词也收（以前直接「请用中文写」）', tryWord('cat') === true, 'cat');
  ok('英文大写也行（判词本来就大小写不敏感）', tryWord('Cat') === true, 'Cat');
  ok('字母 + 数字可以', tryWord('A1') === true, 'A1');
  ok('带下划线也收（测试与机器人都这么造词）', tryWord('词_c1') === true, '词_c1');
  ok('带空格的不收（猜起来没有边界）', tryWord('hello world') === false);
  ok('只有标点不收（没有实义字符）', tryWord('!!!') === false);
  ok('超长词不收（12 个字符以上）', tryWord('a'.repeat(13)) === false);
}

console.log('\n[7] 回放数据形状 + chatLeaks');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  ok('未交时 chatLeaks=true', g.chatLeaks('u1') === true);
  g.submit('u1', { text: '长颈鹿' });
  ok('同一格内：交了恢复说话，没交的还在攥答案', g.chatLeaks('u1') === false && g.chatLeaks('u2') === true);
  playGrid(g, room, 'same');                    // 其余人补交（u1 重复提交会被拒，无副作用）
  playGrid(g, room, 'free');
  playGrid(g, room, 'same');                    // 猜词也猜「长颈鹿」→ 首尾一致
  ok('走完 → REVEAL', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('stepIndex = 链长', g.stepIndex === 3, String(g.stepIndex));
  const c1 = g.chains[0];
  ok('链条形状 = 词/画/猜',
    c1.steps.map(s => s.type).join(',') === [STEP.WORD, STEP.DRAWING, STEP.GUESS].join(','),
    c1.steps.map(s => s.type).join(','));
  ok('首词 = 长颈鹿', c1.steps[0].content === '长颈鹿');
  ok('末词 = 长颈鹿（猜对了）', c1.steps[2].content === '长颈鹿');
}

/**
 * 把「按链串行投票」整轮走完：链1 回放 → 所有人投票 → 结算 → 链2 回放 → … → 最终结算。
 * vote 回调在每条链进入 VOTE 时被调用一次（参数是当前链的 chainId）。
 * 返回链走完后的最终 voteResult。
 */
function runChainVotes(g, vote) {
  const order = [];
  for (let guard = 0; guard < 80; guard++) {
    if (g.phase === CHAIN_PHASE.SCORE && g.voteResult && !g.voteResult.partial) break;
    if (g.phase === CHAIN_PHASE.REVEAL) { g.tick(Date.now() + 9999999); continue; }
    if (g.phase === CHAIN_PHASE.VOTE) {
      const cur = g.currentVoteChain();
      order.push(cur.chainId);
      if (vote) vote(cur.chainId, order.length);
      g.settleChain();
      continue;
    }
    if (g.phase === CHAIN_PHASE.SCORE) { g.tick(Date.now() + 9999999); continue; }
    break;
  }
  return { vr: g.voteResult, order };
}

console.log('\n[8] 串行投票：一条链一条链投，√ 过半得奖杯');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  playGrid(g, room, 'same');                    // 起词 全部长颈鹿
  playGrid(g, room, 'free');                    // 作画
  playGrid(g, room, 'same');                    // 猜词 全部长颈鹿 → 首尾一致
  g.tick(Date.now() + 9999999);                 // REVEAL
  ok('回放到点进入投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  ok('投票阶段锁笔', g.lockedFor('u1') === true);

  const cur0 = g.currentVoteChain();
  ok('★ 服务端指定了「现在投哪条链」（不是让各端自己挑）',
    !!cur0 && g.voteChainIndex === 0, JSON.stringify({ i: g.voteChainIndex, id: cur0 && cur0.chainId }));
  const snap0 = g.snapshotFor('u1');
  ok('★ 快照带出 voteChainId / 已投人数 / 总人数',
    snap0.voteChainId === cur0.chainId && snap0.voteDone === 0 && snap0.voteTotal === 4,
    JSON.stringify({ id: snap0.voteChainId, done: snap0.voteDone, total: snap0.voteTotal }));

  // ★ 串行的关键：不能给别的链投票
  const other = g.chains[1].chainId;
  const bad = g.keepVote('u1', other, true);
  ok('★ 给别的链投票被拒（否则串行形同虚设）', bad.ok === false, JSON.stringify(bad));
  const badFav = g.favVote('u2', other, 1);
  ok('★ 最喜欢的画也只能投当前这条链', badFav.ok === false, JSON.stringify(badFav));

  ok('给当前这条链投可以', g.keepVote('u1', cur0.chainId, true).ok === true);
  ok('快照记录我的 keep 票', g.snapshotFor('u1').myKeep[cur0.chainId] === true);
  ok('已投人数跟着涨', g.snapshotFor('u1').voteDone === 1, g.snapshotFor('u1').voteDone);
  const rFav = g.favVote('u2', cur0.chainId, 1);
  ok('fav 票投在 DRAWING 格', rFav.ok === true, JSON.stringify(rFav));
  ok('fav 不能投在词格上', g.favVote('u3', cur0.chainId, 0).ok === false);

  // 第 1 条链结算：3 人投 √（u1 已投，再补两个）
  g.keepVote('u2', cur0.chainId, true);
  g.keepVote('u3', cur0.chainId, true);
  g.settleChain();
  ok('结算后进入 SCORE（小结算）', g.phase === CHAIN_PHASE.SCORE, g.phase);
  ok('★ 小结算只带已经放完的那一条链', g.voteResult.partial === true
    && g.voteResult.chains.length === 1, JSON.stringify(g.voteResult.chains.length));
  const row0 = g.voteResult.chains[0];
  ok('★ √ 过半 → 起词人拿奖杯', row0.agree === 3 && row0.won === true,
    JSON.stringify({ agree: row0.agree, against: row0.against, won: row0.won }));
  ok('链主 +' + P.GAME.CHAIN_TROPHY_AGREE + ' 分',
    (g.scores.get(g.chains[0].ownerPlayerId) || 0) === P.GAME.CHAIN_TROPHY_AGREE,
    String(g.scores.get(g.chains[0].ownerPlayerId)));

  // 走完剩下的链：每条都投 2 √ 2 ×（不过半）
  const rest = runChainVotes(g, (cid) => {
    g.keepVote('u1', cid, true); g.keepVote('u2', cid, true);
    g.keepVote('u3', cid, false); g.keepVote('u4', cid, false);
  });
  ok('★ 剩下的链是一条一条走的（顺序 = chains 顺序）',
    rest.order.length === 3, JSON.stringify(rest.order));
  ok('结算完进入最终结算', g.phase === CHAIN_PHASE.SCORE && rest.vr.partial === false, g.phase);
  ok('最终结算带全部链的行', rest.vr.chains.length === 4, rest.vr.chains.length);
  ok('★ 2√2× 不过半 → 那条链不发奖杯',
    rest.vr.chains.slice(1).every(r => r.won === false),
    JSON.stringify(rest.vr.chains.map(r => r.agree + '/' + r.against + '=' + r.won)));
  ok('最终结算带 fav 结果', Array.isArray(rest.vr.fav), JSON.stringify(rest.vr.fav));
  ok('快照在 SCORE 阶段才带 voteResult', !!g.snapshotFor('u1').voteResult);
  const favPid = g.chains[0].steps[1].playerId;
  ok('fav 独票作者 +' + P.GAME.CHAIN_FAV_POINTS,
    (g.scores.get(favPid) || 0) >= P.GAME.CHAIN_FAV_POINTS, String(g.scores.get(favPid)));

  // 结算到点 → 回大厅，分数保留
  const before = g.scores.get(favPid);
  g.tick(Date.now() + 9999999);
  ok('最终结算到点回大厅', g.phase === CHAIN_PHASE.LOBBY, g.phase);
  ok('分数保留', (g.scores.get(favPid) || 0) === before);
  ok('回放数据已清', g.revealData === null && g.chains.length === 0);
  ok('ready 已清（下一局重新准备）', g.ready.size === 0);
}

console.log('\n[10] 房主「立刻推进」');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 2 });
  ok('链长 2 被夹到下限 3', g.chainLength === 3, String(g.chainLength));
  const r0 = g.next('u2');
  ok('非房主推进被拒', r0.ok === false, JSON.stringify(r0));
  const r1 = g.next('u1');                      // 大厅里强制开局（全员视为已准备）
  ok('房主大厅强制开局', r1.ok === true && g.phase === CHAIN_PHASE.INIT, g.phase);
  g.next('u1');                                 // INIT → 第 0 格
  ok('鼓点可被推进', g.phase === CHAIN_PHASE.WRITE, g.phase);
  g.next('u1');                                 // 没人交也收格
  ok('房主可跳过没交的格', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const skipped = g.chains.filter(c => c.steps[0] && c.steps[0].skipped);
  ok('被跳过的格标记 skipped', skipped.length === 4, String(skipped.length));
  // ★ 用户要求：**严禁空起词**。倒计时结束时没交，就在他这一格拿到的 3 个候选里随机补一个。
  ok('★ 没人交也不会留下空起词（随机补了候选词）',
    g.chains.every(c => typeof c.steps[0].content === 'string' && c.steps[0].content.length > 0),
    JSON.stringify(g.chains.map(c => c.steps[0].content)));
  ok('★ 补的词来自他自己那三个候选',
    g.chains.every(c => {
      const who = c.steps[0].playerId;
      const picks = g.chains.map(x => x).length ? null : null;
      return !!who && typeof c.steps[0].content === 'string' && c.steps[0].content !== '';
    }));
  g.next('u1');                                 // 作画空收 → 第 2 格（猜词）
  ok('推进到猜词格', g.phase === CHAIN_PHASE.GUESS, g.phase);
  g.next('u1');                                 // 猜词空收 → 3 格走完 → REVEAL
  ok('链长 3 走完进回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  g.next('u1');                                 // REVEAL → VOTE（第 1 条链）
  ok('回放可被推进进投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  g.next('u1');                                 // VOTE → SCORE（小结算，后面还有链）
  ok('投票可被立刻结算', g.phase === CHAIN_PHASE.SCORE, g.phase);
  ok('★ 还有链没放 → 小结算（不是最终结算）',
    g.voteResult && g.voteResult.partial === true, JSON.stringify(g.voteResult && g.voteResult.partial));
  g.next('u1');                                 // SCORE → 下一条链的 REVEAL
  ok('★ 小结算推进 → 下一条链回放（不是直接回大厅）',
    g.phase === CHAIN_PHASE.REVEAL && g.voteChainIndex === 1,
    g.phase + ' idx=' + g.voteChainIndex);
  // 把剩下的链走完 → 最终结算 → 大厅
  runChainVotes(g, null);
  g.next('u1');
  ok('全部结算完可推进回大厅', g.phase === CHAIN_PHASE.LOBBY, g.phase);
}

console.log('\n[11] 超时宽限：到点不立刻收，宽限过了才收');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 2 });
  toGrid(g, room, 0, 'free');
  const dl = g.deadline;
  g.tick(dl - 1);
  ok('没到点不动', g.stepIndex === 0 && g.phase === CHAIN_PHASE.WRITE);
  g.tick(dl + CFG.GRACE_MS - 1);
  ok('宽限期内不收格', g.stepIndex === 0, String(g.stepIndex));
  g.tick(dl + CFG.GRACE_MS + 1);
  ok('宽限过了收格进下一格', g.phase === CHAIN_PHASE.DRAW, g.phase);
  ok('★ 没交也不会留下空起词（随机补了候选词），并用 auto 标出来',
    g.chains.every(c => c.steps[0].auto === true
      && typeof c.steps[0].content === 'string' && c.steps[0].content.length > 0),
    JSON.stringify(g.chains.map(c => c.steps[0].content)));
  // 提交后的重复提交被拒
  g.submit('u1', {});
  ok('同一格不能交两次', g.submitted.size === 1 && g.submit('u1', {}).ok === false);
}

console.log('\n[12] 中途离场：按「没交」处理，不卡死全场');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  // u4 在写词格离开
  const m = room.members.get('u4');
  room.members.delete('u4');
  g.onLeave(m);
  ok('离场者被记为已交（空）', g.submitted.has('u4'));
  // 剩下 3 人交齐 → submitted.size = 4 ≥ ring.length → 自动收格
  for (const uid of ['u1', 'u2', 'u3']) g.submit(uid, { text: '词_' + (g.cellOf(uid, 0) || {}).chainId });
  ok('3 人交齐即收格（不等 u4）', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const gone = g.chains.filter(c => c.steps[0].playerId === 'u4');
  ok('u4 负责的格被标成 auto（不是他写的）', gone.length === 1 && gone[0].steps[0].auto === true,
    JSON.stringify(gone.map(c => ({ skip: c.steps[0].skipped, auto: c.steps[0].auto }))));
  // ★ 就算人跑了，起词也不许空着 —— 一样从他那三个候选里随机补
  ok('★ 离场者的起词也被补上了（不是空）',
    gone.length === 1 && typeof gone[0].steps[0].content === 'string'
      && gone[0].steps[0].content.length > 0,
    JSON.stringify(gone.map(c => c.steps[0].content)));
}

console.log('\n[13] 局中进人 = 观战');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  room.members.set('u5', { userId: 'u5', name: '戊', color: '#000' });
  g.onJoin(room.members.get('u5'));
  ok('局中进人进观战名单', g.spectators.has('u5'));
  ok('观战者锁笔', g.lockedFor('u5') === true);
  ok('观战者没有题面', g.taskFor('u5') === null);
  ok('观战者快照带 spectating', g.snapshotFor('u5').spectating === true);
  ok('观战者不能准备', g.toggleReady('u5', true).ok === false);
}

console.log('\n' + '─'.repeat(46));
console.log('  通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 1;
