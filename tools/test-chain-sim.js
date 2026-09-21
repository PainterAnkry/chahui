'use strict';
/**
 * 接龙状态机离线推演（不碰 WebSocket）。
 *
 * 验证的是当前这一版（v12：大房间分组 + 每条链各投一次 ♥）的核心机制：
 *   - 大厅（全员准备自动开局）与人数 / 链长限制
 *   - N 人 = N 条并行链，环形一一映射（每一格每人恰好一格，绝不会被派两次）
 *   - **8 步传递模型**：链长 = 2 × 组人数，每人连续两格 ——
 *     起词 → 画 → 猜 → 画 → 猜 → 画 → 猜 → 画（猜完立刻画，画完才交棒）
 *   - v12 分组：4~6 人 1 组 / 7~10 人 2 组 / 11~12 人 3 组 / 13~16 人 4 组，
 *     组内传遍、多组共用一个全局 stepIndex 并行推进
 *   - 每一棒的「链条不断」自检（**按组**断言：组内每人恰好一个 cell）
 *   - 回放棒次由**服务端**持有：revealStep / revealLegs / legHoldMs
 *   - 信息隔离：快照零内容；题面只给当事者
 *   - 投票：按链串行 + **每条链各投一次 ♥**（跨链统计，fav 带 strokes）
 *   - 超时宽限 / 空格 / 中途离场
 *
 * ⚠ 4 人房（1 组）的行为必须与 v11 完全一致 —— [1]~[14] 那一批就是这条回归线。
 */
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const { ChainGame, CHAIN_PHASE, STEP, CFG, groupCountFor, groupSizesFor } = require(R('server/src/chain'));
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

/** 交当前一格：WRITE/DRAWING/GUESS 各按类型交（全员交齐自动收格）
 *  perStep = 作画格交几笔（★ v16：回放动画时长**按笔数**算，测试要能造出「多笔」的一格） */
function playGrid(g, room, mode, perStep) {
  const type = g.stepTypeOf(g.stepIndex);
  const k = g.stepIndex;
  const nStrokes = Math.max(1, perStep || 1);
  for (const uid of g.ring) {
    const ch = g.cellOf(uid, k);
    if (!ch) continue;                             // 组内已经走完一圈的人这一格没活
    if (type === STEP.WORD) {
      g.submit(uid, { text: mode === 'same' ? '长颈鹿' : ('词_' + ch.chainId) });
    } else if (type === STEP.DRAWING) {
      for (let s = 0; s < nStrokes; s++) {
        room.strokes.push({ userId: uid, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: '#112233', size: 5, ts: 1, te: 2 });
      }
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
  while (g.isPlaying() && g.stepIndex < k) {
    const before = g.stepIndex;
    playGrid(g, room, mode || 'free');
    if (g.stepIndex === before && g.isPlaying()) break;   // 防呆：没推进就别死循环
  }
}

/** 一 tick 一格地把回放放完（服务端棒次），停在 VOTE / 其它阶段 */
function playReveal(g, guard) {
  for (let i = 0; i < (guard || 60); i++) {
    if (g.phase !== CHAIN_PHASE.REVEAL) return g.phase;
    const dl = g.deadline;
    g.tick(dl > 0 ? dl : Date.now() + 9999999);
  }
  return g.phase;
}

/** 分组的名字表：n 个人（用甲乙丙丁…，超过 20 个就用编号） */
function namesFor(n) {
  const pool = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i] || ('玩家' + (i + 1)));
  return out;
}

/** 按人数开一局并全员就绪 → 冻结分组（停在 INIT 鼓点），返回 { g, room }
 *  ⚠ 分组与链长在 beginGame() 里就定死了，所以停在 INIT 就能验分组表。 */
function startGroups(n, opts) {
  const m = makeGame(namesFor(n), opts);
  for (const p of m.g.playerList()) m.g.toggleReady(p.userId, true);
  return m;
}

/** 某条链那一组的环（= 这条链的合法投票人） */
function membersOfChain(g, chainId) {
  const info = g.groupInfo(chainId);
  return info ? info.ring : null;
}

/**
 * 把「按链串行投票」整轮走完：链1 回放 → 所有人投票 → 结算 → 链2 回放 → … → 最终结算。
 * vote 回调在每条链进入 VOTE 时被调用一次（chainId, chain, i）。
 */
function runChainVotes(g, vote) {
  const order = [];
  for (let guard = 0; guard < 800; guard++) {
    if (g.phase === CHAIN_PHASE.SCORE && g.voteResult && !g.voteResult.partial) break;
    if (g.phase === CHAIN_PHASE.REVEAL) { g.next('u1'); continue; }
    if (g.phase === CHAIN_PHASE.VOTE) {
      const cur = g.currentVoteChain();
      order.push(cur.chainId);
      if (vote) vote(cur.chainId, cur, order.length);
      // ★ v14：全员投完时服务端会**自动**结算这条链（不用等满时长）——
      //   那时 phase 已经不在 VOTE 了，别再补一次 settleChain（会多结算一条链）。
      if (g.phase === CHAIN_PHASE.VOTE) g.settleChain();
      continue;
    }
    if (g.phase === CHAIN_PHASE.SCORE) { g.tick(g.deadline); continue; }
    break;
  }
  return { vr: g.voteResult, order };
}

console.log('\n[1] 大厅与人数限制');
{
  const a = makeGame(['甲', '乙', '丙']);              // 3 人 < 4
  ok('少于 4 人开不了局', a.r.ok === false && a.r.code === 'too_few', JSON.stringify(a.r));

  const b = makeGame(['甲', '乙', '丙', '丁']);
  ok('4 人可以开局（进大厅）', b.r.ok === true && b.g.phase === CHAIN_PHASE.LOBBY, b.g.phase);
  ok('还没开局：没有链', b.g.chains.length === 0);
  ok('★ 4 人房链长默认 = 2 × 人数 = 8（每人连续两格）', b.g.chainLength === 8, String(b.g.chainLength));

  const c = makeGame(['甲', '乙', '丙', '丁', '戊'], { chainLength: 3 });
  ok('5 人房链长可设 3', c.g.chainLength === 3, String(c.g.chainLength));
  const d = makeGame(['甲', '乙', '丙', '丁', '戊'], { chainLength: 99 });
  ok('链长 99 被夹到 2 × 人数 = 10', d.g.chainLength === 10, String(d.g.chainLength));
  const e = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 7 });
  ok('显式链长 7（奇数）照收 —— 只是最后一格不再成对', e.g.chainLength === 7, String(e.g.chainLength));

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
  ok('★ 4~6 人只有 1 组（就是 v11 的全场环）', g.groups.length === 1, String(g.groups.length));
  ok('★ 4 人 1 组时 ring 与 v11 一模一样（全场 4 人一个环）',
    g.ring.length === 4 && g.groups[0].ring.join(',') === g.ring.join(','),
    g.ring.join(','));
  ok('每条链记录 owner/steps/status/groupId',
    g.chains.every(c => c.chainId && c.ownerPlayerId && c.status === 'active' &&
      Array.isArray(c.steps) && c.groupId === 'g1'));

  // 推进过鼓点 → 第 0 格（写词）
  g.tick(Date.now() + 9999999);
  ok('鼓点结束进入写词格', g.phase === CHAIN_PHASE.WRITE, g.phase);
  ok('写词阶段全员锁笔', g.lockedFor('u1') === true);
  const t = g.taskFor('u1');
  ok('题面：WORD + 3 个候选词', t && t.step === STEP.WORD && (t.choices || []).length === 3, JSON.stringify(t && t.choices));
}

console.log('\n[3] 8 步模型：作者序列 A,A,B,B,C,C,D,D · 类型序列 词,画,猜,画,猜,画,猜,画');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁']);      // 默认链长 8
  toGrid(g, room, 0, 'free');
  const ring = g.ring;
  const names = ring.map(uid => g.names.get(uid));
  console.log('  环序 = ' + ring.map((uid, i) => names[i] + '(' + uid + ')').join(' → '));

  const wantTypes = ['WORD', 'DRAWING', 'GUESS', 'DRAWING', 'GUESS', 'DRAWING', 'GUESS', 'DRAWING'];
  playGrid(g, room, 'free');                    // 先走完第 0 格，让 steps[0] 落库
  const c0 = g.chains[0];
  const ownerIdx = ring.indexOf(c0.ownerPlayerId);
  const nRing = ring.length;
  const offOf = k => ((ring.indexOf(g.authorOf(c0, k)) - ownerIdx) % nRing + nRing) % nRing;
  const gotTypes = [];
  const gotOwnerOff = [];
  for (let k = 0; k < 8; k++) {
    gotTypes.push(g.stepTypeOf(k));
    gotOwnerOff.push(offOf(k));
  }
  ok('★ 类型序列 = WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING',
    gotTypes.join(',') === wantTypes.join(','), gotTypes.join(','));
  ok('★ 作者偏移序列 = 0,0,1,1,2,2,3,3（= 环序 A,A,B,B,C,C,D,D）',
    gotOwnerOff.join(',') === '0,0,1,1,2,2,3,3', gotOwnerOff.join(','));
  ok('★ 落库后的作者序列（按环序）= A,A,B,B,C,C,D,D',
    g.chains.every(c => c.steps.length === 1 && c.steps[0].playerId === c.ownerPlayerId),
    '第 1 格各写各的链');
  ok('★ authorOffset(k) = floor(k / 2)',
    [0, 1, 2, 3, 4, 5, 6, 7].every(k => g.authorOffset(k) === Math.floor(k / 2)),
    [0, 1, 2, 3, 4, 5, 6, 7].map(k => g.authorOffset(k)).join(','));

  // ★ 每一步「人人各有一格」的一一映射：8 格里每格恰好 n 个不重复的 cell
  for (let k = 0; k < 8; k++) {
    const seen = new Set();
    let nulls = 0;
    for (const uid of ring) {
      const cell = g.cellOf(uid, k);
      if (!cell) { nulls++; continue; }
      seen.add(cell.chainId);
    }
    ok('第 ' + (k + 1) + ' 格：每人一格、不重复、无 null（' + seen.size + '/' + ring.length + '）',
      nulls === 0 && seen.size === ring.length, 'null=' + nulls + ' seen=' + seen.size);
  }
  ok('第 1 格（起词）作者 = 链主本人', c0.steps[0].playerId === c0.ownerPlayerId, c0.steps[0].playerId);
}

console.log('\n[3b] 8 格全跑完：每格作者符合映射，且四人都出了两次');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁']);      // 链长 8
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('★ 8 格走完 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('★ 每条链都收满 8 格', g.chains.every(c => c.steps.length === 8 && c.steps.every(Boolean)),
    g.chains.map(c => c.steps.length).join(','));
  const c1 = g.chains[0];
  const allMatch = c1.steps.every((s, k) => s.playerId === g.authorOf(c1, k));
  ok('★ 每格作者都符合「链主 + authorOffset(k)」', allMatch, JSON.stringify(c1.steps.map(s => s.playerId)));
  const cnt = {};
  for (const s of c1.steps) cnt[s.playerId] = (cnt[s.playerId] || 0) + 1;
  ok('★ 4 人链长 8：每人恰好出 2 格（不多不少）',
    g.ring.every(uid => cnt[uid] === 2), JSON.stringify(cnt));
  let intact = true;
  for (let k = 0; k < 8; k++) if (!g.assertChainIntact(k).ok) intact = false;
  ok('★ assertChainIntact 在 8 格上全过（下一棒永远有人接）', intact,
    JSON.stringify(g.assertChainIntact(0).problems));
  ok('★ 类型序列落库后一致', c1.steps.map(s => s.type).join(',') ===
    'WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING', c1.steps.map(s => s.type).join(','));
}

console.log('\n[4] 画与猜交替：词→画→猜→画');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁']);      // 链长 8
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
  playGrid(g, room, 'free');                    // 猜词 → 又作画（k=3）
  ok('猜完 → 又回到作画（每人猜完立刻画）', g.phase === CHAIN_PHASE.DRAW, g.phase);
  ok('第 4 格的作者 = 第 3 格猜词的作者（同一人接着画）',
    g.authorOf(g.chains[0], 3) === g.authorOf(g.chains[0], 2),
    g.authorOf(g.chains[0], 3) + '/' + g.authorOf(g.chains[0], 2));
  ok('第 3 格的猜词已经落库', g.chains.every(c => c.steps[2] && c.steps[2].type === STEP.GUESS));
  playGrid(g, room, 'free');                    // 画完 → k=4
  const rows = g.chains.map(c => ({ chainId: c.chainId, word: c.steps[3].content, guess: c.steps[2].content }));
  ok('★ 第 4 格（画）的作者 = 第 3 格（猜）的作者（同一人接着画自己猜的词）',
    g.ring.every(uid => {
      const cell = g.cellOf(uid, 3);
      return cell && cell.steps[2] && cell.steps[3] && cell.steps[2].playerId === cell.steps[3].playerId;
    }), JSON.stringify(rows.map(r => r.chainId)));
  ok('落库的第 4 格是 DRAWING 且内容为笔迹',
    g.chains.every(c => c.steps[3].type === STEP.DRAWING && Array.isArray(c.steps[3].content)));
  const t3 = g.taskFor('u1');
  const myCell3 = g.cellOf('u1', g.stepIndex);
  ok('★ 第 5 格（猜）题面的笔迹 = 他刚画的那张（自己的链 / 上家传下来的链）',
    !t3 || JSON.stringify(t3.strokes) === JSON.stringify((myCell3.steps[3] || {}).content),
    t3 ? t3.step : 'none');
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
  ok('笔迹按作者摘取（那笔是环内玩家的）', st.content[0].size === 5 && st.content[0].points.length === 2,
    JSON.stringify(st.content[0]).slice(0, 100));
  ok('没有混进干扰项', !st.content.some(s => s.userId === 'u9'));
}

console.log('\n[6] 信息隔离：快照零内容 + 题面只给当事者');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 4 });
  toGrid(g, room, 0, 'free');
  let leaked = 0;
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/词_c\d/.test(s)) leaked++;
  }
  ok('写词阶段快照零内容', leaked === 0);
  playGrid(g, room, 'free');
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/词_c\d|长颈鹿/.test(s)) leaked++;
    const t = g.taskFor(uid);
    const myChain = g.cellOf(uid, g.stepIndex);
    if (!t || t.chainId !== myChain.chainId || t.word !== '词_' + myChain.chainId) leaked++;
  }
  ok('作画阶段：快照无词、题面只给自己那条', leaked === 0, 'leaked=' + leaked);
  playGrid(g, room, 'free');
  for (const uid of g.ring) {
    const s = JSON.stringify(g.snapshotFor(uid));
    if (/points|"DRAWING"/.test(s)) leaked++;
    const t = g.taskFor(uid);
    const myChain = g.cellOf(uid, g.stepIndex);
    const prev = myChain.steps[g.stepIndex - 1];
    if (!t || t.step !== STEP.GUESS || JSON.stringify(t.strokes) !== JSON.stringify(prev.content)) leaked++;
  }
  ok('猜词阶段：快照无笔迹、题面只给上家的画', leaked === 0, 'leaked=' + leaked);
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('四格走完 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  const s2 = JSON.stringify(g.snapshotFor('u1'));
  ok('回放阶段快照仍零内容（链条数据走 GAME_REVEAL）', !/points|词_c|猜_c/.test(s2), s2.slice(0, 120));
}

console.log('\n[6.5] 写词的词条规则：中文 / 英文 / 数字都收，一个字也收');
{
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

console.log('\n[7b] ★ 回放棒次由服务端同步：revealStep / revealLegs / legHoldMs / legMs');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 8, revealSeconds: 16, replaySpeed: 1 });
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('走完 8 格 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('★ 回放一进来指针在第 0 格', g.revealStep === 0, String(g.revealStep));
  // ★ v15：**每一格的时长不再一样**（起词 / 猜词格干等太久，是用户实测报的）
  // ★ v16：作画格的动画时长改成**按笔数**算（起步 900 + 每笔 240，夹 [1500, 9000]，再除倍速）。
  //   这个 fixture 每一步只交 1 笔 → 900+240=1140 低于地板 → 兜 1500。
  ok('★ 起词格只停 CHAIN_REVEAL_WORD_MS（不再和作画格一样长）',
    g.revealLegMs(0) === P.GAME.CHAIN_REVEAL_WORD_MS, String(g.revealLegMs(0)));
  ok('★ 猜词格停 CHAIN_REVEAL_GUESS_MS（v16 起 2 秒：那个词要看清再翻下一棒）',
    g.revealLegMs(2) === P.GAME.CHAIN_REVEAL_GUESS_MS, String(g.revealLegMs(2)));
  ok('★ 1 笔的作画格兜动画地板 1500，下一格是猜词 → 再加 3 秒悬念尾 = 4500',
    g.revealLegMs(1) === P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_TEASE_MS,
    String(g.revealLegMs(1)));
  ok('★ 最后一格作画后面没有猜词 → 只留一小段定格（1500 + HOLD）',
    g.revealLegMs(7) === P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_HOLD_MS,
    String(g.revealLegMs(7)));
  const snap = g.snapshotFor('u1');
  ok('★ 快照下发 revealStep / revealLegs / legHoldMs / legMs（每格时长表）',
    snap.revealStep === 0 && snap.revealLegs === 8
      && snap.legHoldMs === P.GAME.CHAIN_REVEAL_WORD_MS
      && Array.isArray(snap.legMs) && snap.legMs.length === 8,
    JSON.stringify({ s: snap.revealStep, l: snap.revealLegs, h: snap.legHoldMs, m: snap.legMs }));
  ok('★ deadline = 当前这一格（起词格）的 deadline，不是整段一个',
    Math.abs(g.deadline - (Date.now() + P.GAME.CHAIN_REVEAL_WORD_MS)) < 200,
    String(g.deadline - Date.now()));

  const seen = [];
  for (let i = 0; i < 20 && g.phase === CHAIN_PHASE.REVEAL; i++) {
    const dl = g.deadline;
    g.tick(dl);
    seen.push(g.phase === CHAIN_PHASE.REVEAL ? g.revealStep : 'VOTE');
  }
  ok('★ tick 按每一格自己的时长逐格推进：0→1→2→…→7→VOTE',
    seen.join(',') === '1,2,3,4,5,6,7,VOTE', seen.join(','));
  ok('★ 放到最后一格就进投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  ok('★ 投票阶段 revealStep 钉在最后一格（chainLength - 1 = 7）',
    g.revealStep === 7, String(g.revealStep));
  ok('★ 投票快照里的 legHoldMs 仍是「当前这一格」的时长（最后一格作画 = 1500 + HOLD）',
    g.snapshotFor('u2').legHoldMs === P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_HOLD_MS,
    String(g.snapshotFor('u2').legHoldMs));
}

console.log('\n[7b2] ★ v14/v16 回放倍速（每局设置）：倍速越大 → 笔迹播得越快，只认 1 / 1.5 / 2');
{
  // ★ v16：动画时长按笔数算，所以要造「多笔的一格」才看得出倍速差
  //   （笔数太少会先撞上 1500ms 地板，倍速就被抹平了 —— 那是刻意的保护）。
  const mk = (opts, perStep) => {
    const { g, room } = makeGame(['甲', '乙', '丙', '丁'], Object.assign({ chainLength: 8, revealSeconds: 24 }, opts));
    toGrid(g, room, 0, 'free');
    while (g.isPlaying()) playGrid(g, room, 'free', perStep);
    return g;
  };
  const N = 12;                                   // 每格 12 笔：900 + 12×240 = 3780（高于地板，倍速说了算）
  const anim = 900 + N * P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS;
  const g1 = mk({ replaySpeed: 1 }, N);
  ok('★ 1x → 作画格 = 900 + 12×240 = 3780 + 3 秒悬念尾',
    g1.revealLegMs(1) === anim + P.GAME.CHAIN_REVEAL_TEASE_MS, String(g1.revealLegMs(1)));
  const g15 = mk({ replaySpeed: 1.5 }, N);
  ok('★ 1.5x → 3780 / 1.5 = 2520 + 悬念尾',
    g15.revealLegMs(1) === Math.round(anim / 1.5) + P.GAME.CHAIN_REVEAL_TEASE_MS,
    String(g15.revealLegMs(1)));
  const g2 = mk({ replaySpeed: 2 }, N);
  ok('★ 2x → 3780 / 2 = 1890 + 悬念尾',
    g2.revealLegMs(1) === Math.round(anim / 2) + P.GAME.CHAIN_REVEAL_TEASE_MS,
    String(g2.revealLegMs(1)));
  ok('★ 倍速越大 → 笔迹播得越快（用户要的「倍速越大越短」）',
    g2.revealLegMs(1) < g15.revealLegMs(1) && g15.revealLegMs(1) < g1.revealLegMs(1),
    [g2.revealLegMs(1), g15.revealLegMs(1), g1.revealLegMs(1)].join(' < '));
  ok('★ 起词 / 猜词格不受倍速影响（它们本来就只有一拍，快慢没意义）',
    g1.revealLegMs(0) === g2.revealLegMs(0) && g1.revealLegMs(2) === g2.revealLegMs(2),
    [g1.revealLegMs(0), g2.revealLegMs(0)].join(' / '));
  const gFew = mk({ replaySpeed: 2 }, 1);
  ok('★ 笔数太少（1 笔）时兜 CHAIN_REVEAL_DRAW_MIN_MS 地板，倍速不再往下压 + 悬念尾',
    gFew.revealLegMs(1) === P.GAME.CHAIN_REVEAL_DRAW_MIN_MS + P.GAME.CHAIN_REVEAL_TEASE_MS,
    String(gFew.revealLegMs(1)));
  const gMany = mk({ replaySpeed: 1 }, 80);
  ok('★ 笔特别多时封顶 CHAIN_REVEAL_DRAW_MAX_MS（不然一张细画要播一分钟）+ 悬念尾',
    gMany.revealLegMs(1) === P.GAME.CHAIN_REVEAL_DRAW_MAX_MS + P.GAME.CHAIN_REVEAL_TEASE_MS,
    String(gMany.revealLegMs(1)));
  const gDef = mk({}, N);
  ok('★ 缺省 = 默认 1.5x', gDef.replaySpeed === P.GAME.CHAIN_REPLAY_SPEED_DEFAULT,
    String(gDef.replaySpeed));
  const gBad = mk({ replaySpeed: 3 }, N);
  ok('★ 非法档位（3）夹回默认 1.5x', gBad.replaySpeed === P.GAME.CHAIN_REPLAY_SPEED_DEFAULT,
    String(gBad.replaySpeed));
  ok('★ 快照带 voteFreezeMs（进投票前的定格，3~5 秒）',
    g1.snapshotFor('u1').voteFreezeMs === 0 || g1.snapshotFor('u1').voteFreezeMs >= 3000,
    String(g1.snapshotFor('u1').voteFreezeMs));
}

console.log('\n[7c] ★ v14 回放「立刻推进」= 直接进投票（回放由服务端推，前端没有手动翻格）');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 8 });
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('进入回放', g.phase === CHAIN_PHASE.REVEAL && g.revealStep === 0);
  g.next('u1');
  ok('★ 房主「立刻推进」一次就进投票（不再一格一格翻）',
    g.phase === CHAIN_PHASE.VOTE, String(g.phase));
  ok('推到底（投票里再点 = 结算）→ 进结算（且指针停在最后一格）',
    (g.next('u1'), g.phase === CHAIN_PHASE.SCORE && g.revealStep === 7),
    g.phase + ' step=' + g.revealStep);
}

console.log('\n[7d] ★ 链条断裂自检：断了也强制推进，绝不停在原地');
{
  const { g, room, chats } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 8 });
  toGrid(g, room, 0, 'free');
  g.chains.pop();                               // 人为把链条弄断：有人拿不到链
  const bad = g.assertChainIntact(1);
  ok('★ 自检能看出「有人没有链」', bad.ok === false && bad.problems.length > 0, JSON.stringify(bad.problems));
  const forced = g.checkChainOrForce(1);
  ok('★ 断了 → checkChainOrForce 返回 true（已修复）', forced === true);
  ok('★ 修复后链数恢复 = 环上人数', g.chains.length === g.ring.length, String(g.chains.length));
  ok('★ 修复后自检通过（下一棒有人接）', g.assertChainIntact(1).ok === true);
  ok('★ 系统聊天播报了「已强制推进」',
    chats.some(t => /传递异常/.test(t) && /强制推进/.test(t)),
    JSON.stringify(chats.filter(t => /传递异常/.test(t))));
  const before = g.stepIndex;
  playGrid(g, room, 'free');
  ok('★ 断了也照样推进到下一格（没卡在原地）', g.stepIndex === before + 1, before + ' → ' + g.stepIndex);
}

console.log('\n[8] 串行投票：一条链一条链投，√ 过半得奖杯');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  playGrid(g, room, 'same');                    // 起词 全部长颈鹿
  playGrid(g, room, 'free');                    // 作画
  playGrid(g, room, 'same');                    // 猜词 全部长颈鹿 → 首尾一致
  g.tick(Date.now() + 9999999);                 // REVEAL 第 0 → 1 格
  ok('回放第一格放完还在回放（棒次逐格推进）', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  playReveal(g);                                // 剩下的格子放完
  ok('回放到点进入投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  ok('投票阶段锁笔', g.lockedFor('u1') === true);

  const cur0 = g.currentVoteChain();
  ok('★ 服务端指定了「现在投哪条链」（不是让各端自己挑）',
    !!cur0 && g.voteChainIndex === 0, JSON.stringify({ i: g.voteChainIndex, id: cur0 && cur0.chainId }));
  const snap0 = g.snapshotFor('u1');
  ok('★ 快照带出 voteChainId / 已投人数 / 总人数',
    snap0.voteChainId === cur0.chainId && snap0.voteDone === 0 && snap0.voteTotal === 4,
    JSON.stringify({ id: snap0.voteChainId, done: snap0.voteDone, total: snap0.voteTotal }));

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
  ok('最终结算带 favRanking（票数降序）',
    Array.isArray(rest.vr.favRanking) && rest.vr.favRanking.every((r, i, a) => i === 0 || a[i - 1].votes >= r.votes));
  ok('快照在 SCORE 阶段才带 voteResult', !!g.snapshotFor('u1').voteResult);
  const favPid = g.chains[0].steps[1].playerId;
  ok('fav 独票作者 +' + P.GAME.CHAIN_FAV_POINTS,
    (g.scores.get(favPid) || 0) >= P.GAME.CHAIN_FAV_POINTS, String(g.scores.get(favPid)));

  const before = g.scores.get(favPid);
  g.tick(Date.now() + 9999999);
  ok('最终结算到点回大厅', g.phase === CHAIN_PHASE.LOBBY, g.phase);
  ok('分数保留', (g.scores.get(favPid) || 0) === before);
  ok('回放数据已清', g.revealData === null && g.chains.length === 0);
  ok('回放棒次也归零', g.revealStep === 0, String(g.revealStep));
  ok('ready 已清（下一局重新准备）', g.ready.size === 0);
  ok('分组信息也清掉', g.groups.length === 0, String(g.groups.length));
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
  ok('★ 没人交也不会留下空起词（随机补了候选词）',
    g.chains.every(c => typeof c.steps[0].content === 'string' && c.steps[0].content.length > 0),
    JSON.stringify(g.chains.map(c => c.steps[0].content)));
  g.next('u1');                                 // 作画空收 → 第 2 格（猜词）
  ok('推进到猜词格', g.phase === CHAIN_PHASE.GUESS, g.phase);
  g.next('u1');                                 // 猜词空收 → 3 格走完 → REVEAL
  ok('链长 3 走完进回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  playReveal(g);                                // 回放逐格放完
  ok('回放放完进投票', g.phase === CHAIN_PHASE.VOTE, g.phase);
  g.next('u1');                                 // VOTE → SCORE（小结算，后面还有链）
  ok('投票可被立刻结算', g.phase === CHAIN_PHASE.SCORE, g.phase);
  ok('★ 还有链没放 → 小结算（不是最终结算）',
    g.voteResult && g.voteResult.partial === true, JSON.stringify(g.voteResult && g.voteResult.partial));
  g.next('u1');                                 // SCORE → 下一条链的 REVEAL
  ok('★ 小结算推进 → 下一条链回放（不是直接回大厅）',
    g.phase === CHAIN_PHASE.REVEAL && g.voteChainIndex === 1,
    g.phase + ' idx=' + g.voteChainIndex);
  ok('★ 下一条链的回放棒次也从第 0 格开始', g.revealStep === 0, String(g.revealStep));
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
  g.submit('u1', {});
  ok('同一格不能交两次', g.submitted.size === 1 && g.submit('u1', {}).ok === false);
}

console.log('\n[12] 中途离场：按「没交」处理，不卡死全场');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  const m = room.members.get('u4');
  room.members.delete('u4');
  g.onLeave(m);
  ok('离场者被记为已交（空）', g.submitted.has('u4'));
  for (const uid of ['u1', 'u2', 'u3']) g.submit(uid, { text: '词_' + (g.cellOf(uid, 0) || {}).chainId });
  ok('3 人交齐即收格（不等 u4）', g.phase === CHAIN_PHASE.DRAW, g.phase);
  const gone = g.chains.filter(c => c.steps[0].playerId === 'u4');
  ok('u4 负责的格被标成 auto（不是他写的）', gone.length === 1 && gone[0].steps[0].auto === true,
    JSON.stringify(gone.map(c => ({ skip: c.steps[0].skipped, auto: c.steps[0].auto }))));
  ok('★ 离场者的起词也被补上了（不是空）',
    gone.length === 1 && typeof gone[0].steps[0].content === 'string'
      && gone[0].steps[0].content.length > 0,
    JSON.stringify(gone.map(c => c.steps[0].content)));
}

console.log('\n[12b] ★ v17：离场的人在**大厅名单**里必须消失（分数还留在计分板）');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainLength: 3 });
  toGrid(g, room, 0, 'free');
  const m = room.members.get('u4');
  room.members.delete('u4');
  g.onLeave(m);
  const states = g.playerStates();
  const ghost = states.filter(r => r.userId === 'u4');
  // 服务端的契约：**players 保留「已离场但榜上有分」的灰名**（计分板要它），
  // 而 playerList()（= 大厅准备 / 开局人数的来源）不含离场者。
  // 前端据此把大厅那份名单过滤成 online !== false —— 用户报的
  // 「准备面板上有房间里不存在的人」就是漏了这一步过滤。
  ok('★ 快照 players 里留着离场者（online=false，计分板用）',
    ghost.length === 1 && ghost[0].online === false, JSON.stringify(ghost));
  ok('★ playerList()（大厅 / 开局人数）里**没有**离场者',
    g.playerList().every(p => p.userId !== 'u4'), JSON.stringify(g.playerList().map(p => p.userId)));
  ok('★ 快照里 online=false 的行数 = 离场人数（前端就按这个过滤大厅名单）',
    states.filter(r => r.online === false).length === 1,
    JSON.stringify(states.map(r => [r.userId, r.online])));
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

console.log('\n[14] 日志与自检：每一棒都打一行 [chain]，8 格共 8 行');
{
  const { g, room } = makeGame(['甲', '乙', '丙', '丁']);      // 链长 8
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { const s = a.join(' '); if (s.indexOf('[chain]') === 0) lines.push(s); };
  try {
    toGrid(g, room, 0, 'free');
    while (g.isPlaying()) playGrid(g, room, 'free');
  } finally { console.log = orig; }
  ok('★ 每一棒恰好一行日志（8 格 = 8 行）', lines.length === 8, String(lines.length));
  ok('★ 日志形状：[chain] 第 k/N 格 · 阶段=X · 作者=名(id) · 交给=名(id) · 链数=n',
    lines.every(s => /^\[chain\] 第 \d+\/8 格 · 阶段=(WORD|DRAWING|GUESS) · 作者=.+\(u\d\) · 交给=(.+\(u\d\)|\(回放\)) · 链数=4$/.test(s)),
    lines[0]);
  ok('★ 最后一行「交给」是 (回放)', /交给=\(回放\)/.test(lines[7]), lines[7]);
  console.log('  样例：' + lines[0]);
  console.log('        ' + lines[1]);
}

console.log('\n[15] ★ v12 分组表：人数 → 组数与各组人数');
{
  const want = { 4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 2, 11: 3, 12: 3, 13: 4, 14: 4, 15: 4, 16: 4 };
  const bad = [];
  for (const n of Object.keys(want)) {
    if (groupCountFor(Number(n)) !== want[n]) bad.push(n + '→' + groupCountFor(Number(n)));
  }
  ok('★ 组数表：4~6=1 组 · 7~10=2 组 · 11~12=3 组 · 13~16=4 组', bad.length === 0, bad.join(','));
  const sizes = { 4: '4', 7: '4,3', 8: '4,4', 10: '5,5', 11: '4,4,3', 12: '4,4,4', 13: '4,3,3,3', 16: '4,4,4,4' };
  const bad2 = [];
  for (const n of Object.keys(sizes)) {
    if (groupSizesFor(Number(n)).join(',') !== sizes[n]) bad2.push(n + '→' + groupSizesFor(Number(n)).join(','));
  }
  ok('★ 尽量均分：16→4/4/4/4 · 13→4/3/3/3 · 10→5/5 · 7→4/3', bad2.length === 0, bad2.join(' '));
  ok('组数不超过人数（4 人以下也不会分空组）', groupSizesFor(3).join(',') === '3', groupSizesFor(3).join(','));
}

console.log('\n[16] ★ 8 人 → 2 组各 4 人 · 链长 8（不是 16）· 8 格走完');
{
  const { g, room } = startGroups(8);
  ok('8 人分成 2 组', g.groups.length === 2, String(g.groups.length));
  ok('★ 两组各 4 人', g.groups.every(x => x.members.length === 4),
    g.groups.map(x => x.members.length).join(','));
  ok('★ 每组一个独立打乱的环（组内 4 人、互不重叠）',
    g.groups.every(x => x.ring.length === 4) &&
    new Set(g.groups.reduce((a, x) => a.concat(x.members), [])).size === 8,
    g.groups.map(x => x.ring.join('/')).join(' | '));
  ok('★ 链长 = 2 × 组人数 = 8（不是 2 × 8 = 16）', g.chainLength === 8, String(g.chainLength));
  ok('每组各自的链长（组内传遍）也是 8', g.groups.every(x => x.chainLength === 8),
    g.groups.map(x => x.chainLength).join(','));
  ok('★ 8 个人 8 条链、每条链带 groupId、链的条数 = 人数',
    g.chains.length === 8 && g.chains.every(c => c.groupId),
    JSON.stringify(g.chains.map(c => c.chainId + ':' + c.groupId)));
  ok('ring = 各组环首尾相接，且 chains[i] 的主人 = ring[i]（老的消费方式还能用）',
    g.chains.every((c, i) => c.ownerPlayerId === g.ring[i]) && g.ring.length === 8,
    g.chains.map(c => c.ownerPlayerId).join(',') + ' vs ' + g.ring.join(','));
  ok('★ 组内 chainIds 顺序 = 组内 ring 顺序',
    g.groups.every(x => x.chainIds.every((cid, i) => {
      const c = g.chains.find(y => y.chainId === cid);
      return c && c.ownerPlayerId === x.ring[i];
    })));
  const g1 = g.groups[0], g2 = g.groups[1];
  let cross = 0, dup = 0, own = true;
  for (let k = 0; k < 8; k++) {
    for (const pair of [[g1, g2], [g2, g1]]) {
      const x = pair[0], other = pair[1];
      const seen = new Set();
      for (const uid of x.members) {
        const cell = g.cellOf(uid, k);
        if (!cell) { own = false; continue; }
        if (other.chainIds.indexOf(cell.chainId) >= 0) cross += 1;
        if (seen.has(cell.chainId)) dup += 1;
        seen.add(cell.chainId);
      }
      if (seen.size !== x.members.length) own = false;
    }
  }
  ok('★ 每一格：组内每人恰好一个 cell、不重复、无 null', own && dup === 0, 'own=' + own + ' dup=' + dup);
  ok('★ 不同组之间绝不互相认领对方的链（8 格 × 2 组全扫）', cross === 0, 'cross=' + cross);
  ok('★ 某组的玩家拿到的 cell 永远在自己组的 chainIds 里',
    g.groups.every(x => x.members.every(uid => {
      for (let k = 0; k < 8; k++) {
        const cell = g.cellOf(uid, k);
        if (cell && x.chainIds.indexOf(cell.chainId) < 0) return false;
      }
      return true;
    })));
  ok('★ 按组自检在 8 格上全过（组内下一棒永远有人接）',
    Array.from({ length: 8 }, (_, k) => g.assertChainIntact(k).ok).every(Boolean),
    JSON.stringify(g.assertChainIntact(0).problems));
  const snap = g.snapshotFor(g.groups[0].members[0]);
  ok('★ 快照下发 groups / groupCount / myGroup / groupSize / groupLengths',
    Array.isArray(snap.groups) && snap.groups.length === 2 && snap.groupCount === 2 &&
    snap.myGroup === 'g1' && snap.groupSize === 4 && snap.stepTotal === 4 &&
    snap.groupLengths.g1 === 8 && snap.groupLengths.g2 === 8,
    JSON.stringify({ n: snap.groups.length, gc: snap.groupCount, mg: snap.myGroup, gs: snap.groupSize, st: snap.stepTotal }));
  ok('★ 快照 groups[].members 带 userId+name、chainIds 齐备',
    snap.groups.every(x => x.members.length === x.size && x.members.every(m => m.userId && m.name) &&
      x.chainIds.length === x.size),
    JSON.stringify(snap.groups[1].members));
  ok('快照的 ring 仍然是 8 人（兼容老的消费者）', snap.ring.length === 8, String(snap.ring.length));

  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('★ 8 人 2 组跑满 8 格 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('★ 每条链都收满 8 格（没有空洞）',
    g.chains.every(c => c.steps.length === 8 && c.steps.every(Boolean)),
    g.chains.map(c => c.steps.length).join(','));
  ok('★ 链只在组内传：每条链的作者全部来自同一组',
    g.groups.every(x => x.chainIds.every(cid => {
      const c = g.chains.find(y => y.chainId === cid);
      return c.steps.every(s => x.members.indexOf(s.playerId) >= 0);
    })));
  // ⚠ authorOffset(k)=floor(k/2) → 每人在这条链里**连续两格**（先画后猜），
  //   所以「链长 = 2 × 组人数」时每条链里每人恰好 2 格（一人一格 × 两圈）。
  ok('★ 组内每条链：每人恰好 2 格（先画自己拿到的、再猜下一格）',
    g.groups.every(x => x.chainIds.every(cid => {
      const c = g.chains.find(y => y.chainId === cid);
      return x.members.every(uid => c.steps.filter(s => s.playerId === uid).length === 2);
    })));
  ok('★ 组内统计：每条链的格子数 = 2 × 组人数，且作者集合 = 本组成员',
    g.groups.every(x => x.chainIds.every(cid => {
      const c = g.chains.find(y => y.chainId === cid);
      const set = new Set(c.steps.map(s => s.playerId));
      return c.steps.length === 2 * x.members.length && set.size === x.members.length &&
        x.members.every(u => set.has(u));
    })));
}

console.log('\n[17] ★ 10 人 → 2 组各 5 人 · 链长 10 · 10 格走完');
{
  const { g, room } = startGroups(10);
  ok('10 人分成 2 组各 5 人', g.groups.length === 2 && g.groups.every(x => x.members.length === 5),
    g.groups.map(x => x.members.length).join(','));
  ok('★ 链长 = 2 × 5 = 10', g.chainLength === 10, String(g.chainLength));
  ok('★ 每格组内每人恰好一个 cell（10 格 × 2 组）',
    Array.from({ length: 10 }, (_, k) => g.assertChainIntact(k).ok).every(Boolean));
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('★ 跑满 10 格 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('★ 每条链 10 格，且组内每人在这条链里恰好 2 格',
    g.chains.every(c => c.steps.length === 10) && g.groups.every(x => x.chainIds.every(cid => {
      const c = g.chains.find(y => y.chainId === cid);
      return x.members.every(uid => c.steps.filter(s => s.playerId === uid).length === 2);
    })), g.chains.map(c => c.steps.length).join(','));
}

console.log('\n[18] ★ 13 人 → 4 组（4/3/3/3）· 统一链长 8 · 3 人组的尾巴落空壳');
{
  const { g, room } = startGroups(13);
  ok('★ 13 人分成 4 组', g.groups.length === 4, String(g.groups.length));
  ok('★ 组大小 = 4/3/3/3（尽量均分，余数摊给前面的组）',
    g.groups.map(x => x.members.length).join(',') === '4,3,3,3',
    g.groups.map(x => x.members.length).join(','));
  ok('★ 统一链长 = 2 × 最大组 = 8', g.chainLength === 8, String(g.chainLength));
  ok('★ 各组自身格数：4 人组 8 格、3 人组 6 格',
    g.groupLengths().g1 === 8 && g.groupLengths().g2 === 6 && g.groupLengths().g3 === 6 && g.groupLengths().g4 === 6,
    JSON.stringify(g.groupLengths()));
  ok('★ 3 人组在第 7、8 格没有活（activeUsers 只剩大组的人）',
    g.activeUsers(0).size === 13 && g.activeUsers(6).size === 4 && g.activeUsers(7).size === 4,
    g.activeUsers(6).size + '/' + g.activeUsers(7).size);
  ok('★ 按组自检在 8 格上全过（3 人组后两格不要求人人有格）',
    Array.from({ length: 8 }, (_, k) => g.assertChainIntact(k).ok).every(Boolean),
    JSON.stringify(g.assertChainIntact(6).problems));
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('★ 13 人 4 组跑满 8 格 → 回放', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  const big = g.chains.filter(c => c.groupId === 'g1');
  const small = g.chains.filter(c => c.groupId === 'g2');
  ok('★ 4 人组的链 8 格全实心（没有 skipped）',
    big.every(c => c.steps.length === 8 && c.steps.every(s => s.playerId && s.skipped === false)),
    big.map(c => c.steps.filter(s => s.skipped).length).join(','));
  ok('★ 3 人组的链 8 格，最后 2 格是空壳（playerId 空 + skipped）',
    small.every(c => c.steps.length === 8 &&
      c.steps.slice(0, 6).every(s => s.playerId && !s.skipped) &&
      c.steps.slice(6).every(s => !s.playerId && s.skipped === true)),
    JSON.stringify(small[0].steps.map(s => s.playerId || '空')));
  ok('★ 组内传遍：3 人组的链作者只来自那 3 个人',
    small.every(c => c.steps.filter(s => s.playerId)
      .every(s => g.groups[1].ring.indexOf(s.playerId) >= 0) &&
      new Set(c.steps.filter(s => s.playerId).map(s => s.playerId)).size === 3));
  // 3 人组只跑 6 格、4 人组跑 8 格（统一链长的尾巴是空壳）；每条链里每人恰好 2 格
  ok('★ 13 人全部有活：每条链里本组每人恰好 2 格（3 人组实心 6 格 / 4 人组实心 8 格）',
    g.groups.every(x => x.chainIds.every(cid => {
      const c = g.chains.find(y => y.chainId === cid);
      return c.steps.filter(s => s.playerId).length === 2 * x.members.length &&
        x.members.every(uid => c.steps.filter(s => s.playerId === uid).length === 2);
    })));
}

console.log('\n[19] ★ 多组日志：每一组各带一段「作者→交给」');
{
  const { g, room } = startGroups(8);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { const s = a.join(' '); if (s.indexOf('[chain]') === 0) lines.push(s); };
  try { toGrid(g, room, 0, 'free'); } finally { console.log = orig; }
  ok('★ 8 人 2 组：日志带 组1 / 组2 各自的作者与交给',
    /组1: 作者=.+\(u\d+\)→交给=.+\(u\d+\)/.test(lines[0]) &&
    /组2: 作者=.+\(u\d+\)→交给=.+\(u\d+\)/.test(lines[0]),
    lines[0]);
  ok('★ 日志仍然保留老形状（阶段 / 作者 / 交给 / 链数）',
    /^\[chain\] 第 1\/8 格 · 阶段=WORD · 作者=.+\(u\d+\) · 交给=.+\(u\d+\) · 链数=8 · 组1:/.test(lines[0]),
    lines[0]);
  console.log('  样例：' + lines[0]);
}

console.log('\n[20] ★ 每条链各投一次 ♥（不再被下一条链覆盖）');
{
  const { g, room } = startGroups(8);
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  // 取**两个不同组**的各一条链 —— 只有跨组才谈得上「各归各的链、互不覆盖」
  const A = g.groups[0].chainIds[0], B = g.groups[1].chainIds[0];
  const aMembers = membersOfChain(g, A), bMembers = membersOfChain(g, B);
  // 每人只投一次（一人一条链一票，写两次是覆盖不是两票）：
  // 链 A：最后一个人投第 4 格、其余投第 2 格；链 B：全员投第 2 格
  const planA = {};
  aMembers.forEach((u, i) => { planA[u] = (i === aMembers.length - 1) ? 3 : 1; });
  const wantA1 = aMembers.filter(u => planA[u] === 1).length;
  const wantA3 = aMembers.filter(u => planA[u] === 3).length;

  const seen = [];
  const vr = runChainVotes(g, (cid) => {
    seen.push(cid);
    if (cid === A) { for (const u of aMembers) g.favVote(u, cid, planA[u]); }
    else if (cid === B) { for (const u of bMembers) g.favVote(u, cid, 1); }
  }).vr;
  ok('★ 8 条链一条条投完', seen.length === 8, seen.join(','));
  ok('★ 一人一条链一票：A 组每人的 myFavMap 恰好只有链 A（每人 1 条）',
    aMembers.every(u => g.myFavCount(u) === 1 && g.myFavMap(u)[A] === planA[u]),
    JSON.stringify(aMembers.map(u => u + ':' + JSON.stringify(g.myFavMap(u)))));
  ok('★ 投过别组的链 B 之后，A 组的票还在（仍记着链 A、且没有链 B）',
    aMembers.every(u => g.myFavMap(u)[A] === planA[u] && g.myFavMap(u)[B] === undefined));
  ok('★ B 组的 ♥ 各归各的链（每人只在 B 上有票）',
    bMembers.every(u => g.myFavCount(u) === 1 && g.myFavMap(u)[B] === 1));
  const favA1 = vr.favRanking.find(r => r.chainId === A && r.step === 1);
  const favA3 = vr.favRanking.find(r => r.chainId === A && r.step === 3);
  const favB1 = vr.favRanking.find(r => r.chainId === B && r.step === 1);
  ok('★ 跨链统计成功：链 A 两格 + 链 B 的票数都对得上（' + wantA1 + '/' + wantA3 + '/' + bMembers.length + '）',
    !!favA1 && !!favA3 && !!favB1 &&
    favA1.votes === wantA1 && favA3.votes === wantA3 && favB1.votes === bMembers.length,
    JSON.stringify(vr.favRanking.map(r => r.chainId + ':' + r.step + '=' + r.votes)));
  ok('★ 链 B 第 2 格票最多 → 唯一最高票',
    vr.favTie === false && vr.fav.length === 1 && vr.fav[0].chainId === B &&
    vr.fav[0].votes === bMembers.length,
    JSON.stringify(vr.fav.map(w => w.chainId + ':' + w.votes)));

  // 投票结束后「当前链」已经不存在，所以按链显式查
  const voter = aMembers[0];
  ok('★ 我在链 A 上的 ♥ 还在（myFav 显式按链查得到）',
    JSON.stringify(g.myFav(voter, A)) === JSON.stringify({ chainId: A, step: planA[voter] }),
    JSON.stringify(g.myFav(voter, A)));
  ok('★ 快照 myFavMap 列出我投过的每一条链（链 B 上没有我的票）',
    Object.keys(g.myFavMap(voter)).length === 1 && g.myFavMap(voter)[A] === planA[voter],
    JSON.stringify(g.myFavMap(voter)));

  const { g: g2, room: room2 } = startGroups(8);
  toGrid(g2, room2, 0, 'free');
  while (g2.isPlaying()) playGrid(g2, room2, 'free');
  for (let i = 0; i < 40 && g2.phase === CHAIN_PHASE.REVEAL; i++) g2.next('u1');
  const cur2 = g2.currentVoteChain();
  const mem2 = membersOfChain(g2, cur2.chainId);
  g2.favVote(mem2[0], cur2.chainId, 1);
  const snapCur = g2.snapshotFor(mem2[0]);
  ok('★ 投票阶段快照 myFav 指的就是「当前这条链」那一格',
    snapCur.myFav && snapCur.myFav.chainId === cur2.chainId && snapCur.myFav.step === 1 &&
    snapCur.myFavStep === 1 && snapCur.favVotedCount === 1,
    JSON.stringify(snapCur.myFav));
}

console.log('\n[21] ★ 点赞最多的画：fav 带 strokes、按票数降序');
{
  const { g, room } = startGroups(8);
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  const A = g.groups[0].chainIds[0], B = g.groups[1].chainIds[0];
  const aMembers = membersOfChain(g, A), bMembers = membersOfChain(g, B);
  const stepsA1 = g.chains.find(c => c.chainId === A).steps[1];
  const stepsB1 = g.chains.find(c => c.chainId === B).steps[1];
  // 链 A：多数投第 2 格、1 人投第 4 格；链 B：全员投第 2 格 → B 独家最高票
  const planA = {};
  aMembers.forEach((u, i) => { planA[u] = (i === aMembers.length - 1) ? 3 : 1; });
  const wantA1 = aMembers.filter(u => planA[u] === 1).length;
  const wantA3 = aMembers.filter(u => planA[u] === 3).length;

  const vr = runChainVotes(g, (cid) => {
    if (cid === A) { for (const u of aMembers) g.favVote(u, cid, planA[u]); }
    else if (cid === B) { for (const u of bMembers) g.favVote(u, cid, 1); }
  }).vr;
  const w0 = vr.fav[0];
  ok('★ 独家最高票 → fav 只有一条（链 B 第 2 格，' + bMembers.length + ' 票）',
    vr.fav.length === 1 && w0.chainId === B && w0.step === 1 && w0.votes === bMembers.length,
    JSON.stringify(vr.fav.map(w => w.chainId + ':' + w.step + '=' + w.votes)));
  ok('★ 另一个候选（链 A 两格）也在 favRanking 里、票数正确（' + wantA1 + '/' + wantA3 + '）',
    !!vr.favRanking.find(r => r.chainId === A && r.step === 1 && r.votes === wantA1) &&
    !!vr.favRanking.find(r => r.chainId === A && r.step === 3 && r.votes === wantA3),
    JSON.stringify(vr.favRanking.map(r => r.chainId + ':' + r.step + '=' + r.votes)));
  ok('★ fav[0] 带 strokes（就是那一格的笔迹，前端拿来铺主画布）',
    Array.isArray(w0.strokes) && w0.strokes.length > 0 &&
    JSON.stringify(w0.strokes) === JSON.stringify(stepsB1.content),
    JSON.stringify(w0.strokes && w0.strokes.length));
  ok('★ fav[0] 带 chainId / chainIndex / step / playerId / playerName / votes / ownerName',
    w0.chainId === B && w0.chainIndex === g.chains.findIndex(c => c.chainId === B) &&
    w0.step === 1 && w0.playerId === stepsB1.playerId &&
    !!w0.playerName && w0.votes === bMembers.length && !!w0.ownerName,
    JSON.stringify({ c: w0.chainId, i: w0.chainIndex, s: w0.step, p: w0.playerId, v: w0.votes, o: w0.ownerName }));
  ok('★ favRanking 按票数降序、每一项都带 strokes 与 ownerName（前几名都能直接渲染）',
    vr.favRanking.every((r, i, a) => i === 0 || a[i - 1].votes >= r.votes) &&
    vr.favRanking.length >= 3 &&
    vr.favRanking.every(r => Array.isArray(r.strokes) && r.strokes.length > 0 && r.ownerName && r.chainIndex >= 0),
    JSON.stringify(vr.favRanking.map(r => r.chainId + ':' + r.step + '=' + r.votes)));
  ok('★ fav 里的 strokes 与回放数据里那一格完全一致（前端不用回查）',
    JSON.stringify(vr.favRanking.find(r => r.chainId === A && r.step === 1).strokes) ===
    JSON.stringify(stepsA1.content));
  ok('★ 独赢 = 3 分', (g.scores.get(w0.playerId) || 0) === P.GAME.CHAIN_FAV_POINTS,
    String(g.scores.get(w0.playerId)));
  ok('★ 非平票时 favTie = false', vr.favTie === false, String(vr.favTie));
}

console.log('\n[21b] ★ 平票：fav 返回多条 + favRanking 降序');
{
  const { g, room } = startGroups(8);
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  const A = g.groups[0].chainIds[0], B = g.groups[1].chainIds[0];
  const aMembers = membersOfChain(g, A), bMembers = membersOfChain(g, B);
  const vr = runChainVotes(g, (cid) => {
    if (cid === A) g.favVote(aMembers[0], cid, 1);
    else if (cid === B) g.favVote(bMembers[0], cid, 1);
  }).vr;
  ok('★ 两条链各 1 票 → 平票返回多条',
    vr.favTie === true && vr.fav.length === 2 && vr.fav.every(w => w.votes === 1),
    JSON.stringify(vr.fav.map(w => w.chainId + ':' + w.votes)));
  ok('★ 平票时每条 fav 也带 strokes',
    vr.fav.every(w => Array.isArray(w.strokes) && w.strokes.length > 0));
  ok('★ favRanking 前两名就是这两条（都是 1 票）',
    vr.favRanking.length === 2 && vr.favRanking.every(r => r.votes === 1),
    JSON.stringify(vr.favRanking.map(r => r.chainId)));
  ok('★ 平票各 +1 分',
    vr.fav.every(w => (g.scores.get(w.playerId) || 0) === P.GAME.CHAIN_FAV_TIE_POINTS),
    JSON.stringify(vr.fav.map(w => w.playerId + ':' + (g.scores.get(w.playerId) || 0))));
}

console.log('\n[22] ★ 跨组投票不计入统计：别组的票不算');
{
  const { g, room } = startGroups(8);
  toGrid(g, room, 0, 'free');
  while (g.isPlaying()) playGrid(g, room, 'free');
  const A = g.groups[0].chainIds[0];
  const aMembers = membersOfChain(g, A);
  const outsider = g.groups[1].ring[0];          // 别组的人
  for (let i = 0; i < 60 && g.phase !== CHAIN_PHASE.VOTE; i++) {
    if (g.phase === CHAIN_PHASE.REVEAL) g.next('u1'); else break;
  }
  ok('当前投的是第 1 条链（g1）', g.currentVoteChain().chainId === A, g.currentVoteChain().chainId);
  ok('★ 别组的人投 keep 也不进统计（只数同组）',
    g.keepVote(outsider, A, true).ok === true &&
    g.chainVoteTally(A).total === aMembers.length &&
    g.chainVoteTally(A).voted === 0,
    JSON.stringify(g.chainVoteTally(A)));
  ok('★ 同组的人投了才算',
    g.keepVote(aMembers[0], A, true).ok === true &&
    g.chainVoteTally(A).voted === 1 && g.chainVoteTally(A).agree === 1,
    JSON.stringify(g.chainVoteTally(A)));
  ok('★ 快照 voteTotal = 本组人数（不是全场人数）',
    g.snapshotFor(aMembers[0]).voteTotal === aMembers.length,
    String(g.snapshotFor(aMembers[0]).voteTotal));
  ok('★ 快照带 voteGroupId（这条链归哪一组）',
    g.snapshotFor(aMembers[0]).voteGroupId === 'g1',
    g.snapshotFor(aMembers[0]).voteGroupId);
}

console.log('\n[24] ★ v17 传词接龙（chainPlay = relay）：猜完不画，把词传给下家画');
{
  // 4 人 2 轮（默认）→ 链长 = 1 + 2×4 = 9 格
  const { g, room } = makeGame(['甲', '乙', '丙', '丁'], { chainPlay: 'relay' });
  ok('★ 传词模式默认 2 轮 → 链长 = 1 + 2 × 4 = 9 格', g.chainLength === 9, String(g.chainLength));
  ok('★ 快照带 chainPlay / relayRounds（前端要显示玩法与轮数）',
    g.snapshotFor('u1').chainPlay === 'relay' && g.snapshotFor('u1').relayRounds === 2,
    JSON.stringify({ p: g.snapshotFor('u1').chainPlay, r: g.snapshotFor('u1').relayRounds }));

  toGrid(g, room, 0, 'free');
  ok('★ 组链长也按玩法算（relay：1 + 轮数 × 组人数）', g.groupLengths().g1 === 9, JSON.stringify(g.groupLengths()));
  const ring = g.groups[0].ring;                    // 组内环序（开局打乱过，按它来断言）
  const C = g.groups[0].chainIds[0];                // 环首那人的链
  const chain = g.chains.find(c => c.chainId === C);
  const owner = chain.ownerPlayerId;
  const oi = ring.indexOf(owner);
  const types = [];
  const authors = [];
  for (let k = 0; k < 9; k++) {
    types.push(g.stepTypeOf(k));
    const who = g.authorOf(chain, k);
    authors.push(ring.indexOf(who));               // 记偏移，顺着环读更直观
  }
  console.log('  类型: ' + JSON.stringify(types));
  console.log('  作者偏移: ' + JSON.stringify(authors) + '（环序 ' + ring.join('→') + '，链主 ' + owner + '）');
  ok('★ 类型序列 = 词,画,猜,画,猜,画,猜,画,猜（起词 + 4 画 + 4 猜）',
    types.join(',') === 'WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS', types.join(','));
  // 用户给的验收例子：A起词→A画→B猜→C画→D猜→A画→B猜→C画→D猜
  //   → 相对链主的偏移 [0,0,1,2,3,0,1,2,3]
  ok('★ 作者偏移 = [0,0,1,2,3,0,1,2,3]（正是验收例子：A起词→A画→B猜→C画→D猜→A画→B猜→C画→D猜）',
    authors.join(',') === '0,0,1,2,3,0,1,2,3', authors.join(','));
  ok('★ 猜的人**不画**：第 3 格（猜）的作者与第 4 格（画）的作者不是同一个人',
    g.authorOf(chain, 2) !== g.authorOf(chain, 3),
    g.authorOf(chain, 2) + ' / ' + g.authorOf(chain, 3));
  ok('★ 第 4 格（画）的作者 = 第 3 格（猜）的下家',
    g.authorOf(chain, 3) === ring[(oi + 2) % 4] && g.authorOf(chain, 2) === ring[(oi + 1) % 4],
    JSON.stringify({ guess: g.authorOf(chain, 2), draw: g.authorOf(chain, 3) }));

  // 每一格都是「组内人人恰好一格」的一一映射（与 classic 同一条不变式）
  let bijection = true;
  for (let k = 0; k < 9; k++) {
    const seen = new Set();
    for (const uid of ring) {
      const cell = g.cellOf(uid, k);
      if (!cell || seen.has(cell.chainId)) { bijection = false; break; }
      seen.add(cell.chainId);
    }
    if (seen.size !== ring.length) bijection = false;
  }
  ok('★★ 每一格组内 4 人各拿到一条不同的链（不重不漏，9 格全查）', bijection);
  let intact = true;
  for (let k = 0; k < 9; k++) if (!g.assertChainIntact(k).ok) intact = false;
  ok('★★ 9 格逐格自检链条不断（assertChainIntact 全过）', intact);

  // 内容流：猜完的词交给下家画
  for (let k = 0; k < 9; k++) {
    const t = g.taskFor(ring[0], k);
    void t;
    playGrid(g, room, 'free');
  }
  ok('★ 传完 9 格 → 进回放（不会无限传下去）', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  const steps = chain.steps;
  ok('★ 每条链 9 格都落齐（steps.length = chainLength）', steps.length === 9, String(steps.length));
  ok('★ 第 0 格是起词（词，非空）',
    steps[0].type === 'WORD' && typeof steps[0].content === 'string' && steps[0].content.length > 0,
    JSON.stringify(steps[0].content));
  ok('★ 第 3 格（猜）的作者，正是验收里「B猜」那个人；他后面那一格由别人画',
    steps[2].playerId === ring[(oi + 1) % 4] && steps[3].playerId === ring[(oi + 2) % 4],
    JSON.stringify([steps[2].playerId, steps[3].playerId]));
  ok('★ 首尾判定看的是「起词 vs 最后一手猜词」',
    g.chainRevealRow(chain).firstWord === steps[0].content
      && g.chainRevealRow(chain).lastWord === steps[8].content,
    JSON.stringify([g.chainRevealRow(chain).firstWord, g.chainRevealRow(chain).lastWord]));
  void types;
}

console.log('\n[25] ★ v17 传词接龙的轮数夹取 + 分组（8 人 2 组）');
{
  const mk = (opts, names) => makeGame(names || ['甲', '乙', '丙', '丁'], opts);
  ok('★ 1 轮 → 链长 = 1 + 1 × 4 = 5', mk({ chainPlay: 'relay', relayRounds: 1 }).g.chainLength === 5,
    String(mk({ chainPlay: 'relay', relayRounds: 1 }).g.chainLength));
  ok('★ 3 轮 → 链长 = 1 + 3 × 4 = 13', mk({ chainPlay: 'relay', relayRounds: 3 }).g.chainLength === 13,
    String(mk({ chainPlay: 'relay', relayRounds: 3 }).g.chainLength));
  ok('★ 轮数夹到 [1, 4]：99 轮 → 4 轮（链长 17，不会无限传）',
    mk({ chainPlay: 'relay', relayRounds: 99 }).g.relayRounds === P.GAME.CHAIN_RELAY_ROUNDS_MAX
      && mk({ chainPlay: 'relay', relayRounds: 99 }).g.chainLength === 17,
    JSON.stringify({ r: mk({ chainPlay: 'relay', relayRounds: 99 }).g.relayRounds,
      len: mk({ chainPlay: 'relay', relayRounds: 99 }).g.chainLength }));
  ok('★ 非法轮数（0）→ 默认 2 轮',
    mk({ chainPlay: 'relay', relayRounds: 0 }).g.relayRounds === P.GAME.CHAIN_RELAY_ROUNDS_DEFAULT);
  ok('★ 非法玩法 → 默认 classic（老客户端不发这个字段时行为不变）',
    mk({ chainPlay: 'nope' }).g.chainPlay === 'classic' && mk({}).g.chainLength === 8,
    JSON.stringify({ p: mk({ chainPlay: 'nope' }).g.chainPlay, len: mk({}).g.chainLength }));
  ok('★ relay 下**忽略**面板上的 chainLength（链长只由轮数决定）',
    mk({ chainPlay: 'relay', chainLength: 6 }).g.chainLength === 9,
    String(mk({ chainPlay: 'relay', chainLength: 6 }).g.chainLength));

  // 8 人 2 组：每组 4 人 → 链长 = 1 + 2×4 = 9
  const { g, room } = mk({ chainPlay: 'relay' }, ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']);
  ok('★ 8 人 2 组：链长 = 1 + 2 × 4 = 9（不是 1 + 2×8 = 17）', g.chainLength === 9, String(g.chainLength));
  toGrid(g, room, 0, 'free');
  let crossGroup = 0, dupCell = 0;
  for (let k = 0; k < 9; k++) {
    for (const grp of g.groups) {
      const seen = new Set();
      for (const uid of grp.ring) {
        const cell = g.cellOf(uid, k);
        if (!cell) { dupCell++; continue; }
        if (grp.chainIds.indexOf(cell.chainId) < 0) crossGroup++;
        if (seen.has(cell.chainId)) dupCell++;
        seen.add(cell.chainId);
      }
    }
  }
  ok('★★ 传词模式也不串组、不派重复（9 格 × 2 组全查）',
    crossGroup === 0 && dupCell === 0, JSON.stringify({ crossGroup, dupCell }));
  while (g.isPlaying()) playGrid(g, room, 'free');
  ok('★ 8 人 2 组传词也能跑到回放（9 格 × 2 组并行）', g.phase === CHAIN_PHASE.REVEAL, g.phase);
  ok('★ 每条链的作者全在本组（链只在组内传）',
    g.chains.every(c => {
      const grp = g.groupOfChain(c);
      return c.steps.every(s => !s.playerId || grp.ring.indexOf(s.playerId) >= 0);
    }));
}

console.log('\n' + '─'.repeat(46));
console.log('  通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 1;
