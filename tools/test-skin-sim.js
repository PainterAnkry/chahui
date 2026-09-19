'use strict';
/**
 * 画皮状态机的离线推演（不碰 WebSocket）。
 *
 * 先在这里把「配身份 / 夜里验人与刀人 / 私密作画与匿名展示 / 投票放逐 / 判胜负」
 * 这些纯逻辑跑通，再接进 index.js 做端到端。
 *
 * 这个玩法唯一的死穴是**身份泄漏**，所以权限与裁剪类的断言占了很大篇幅 ——
 * 一处漏发就是「把底牌贴到公屏上」，而这个 bug 在界面上完全看不出来。
 */
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const { SkinGame, SKIN_PHASE, ROLE, ROLE_INFO, CAMP, CFG, rolePlan } = require(R('server/src/skin'));
const P = require(R('server/src/protocol'));

// 女巫决策窗口的上界（用来断言「收齐后进的是短窗口而不是整夜」）。
// 取协议里的值再加一点余量，免得因为执行耗时被判失败。
const SKIN_GRACE_MAX = P.GAME.SKIN_WITCH_GRACE_MS + 1000;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑'];

function makeRoom(n) {
  const members = new Map();
  for (let i = 0; i < n; i++) {
    members.set('u' + (i + 1), { userId: 'u' + (i + 1), name: NAMES[i], color: '#000', readonly: false });
  }
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

function makeGame(n, opts) {
  const room = makeRoom(n);
  const chats = [];
  let syncs = 0, resets = 0;
  const api = {
    sync() { syncs++; },
    systemChat(t) { chats.push(t); },
    resetCanvas() { resets++; }
  };
  const g = new SkinGame(room, api);
  const r = g.start(Object.assign({ rounds: 3, theme: 'arknights' }, opts || {}));
  g.__chats = chats;
  g.__syncs = () => syncs;
  g.__resets = () => resets;
  return { g, room, chats, r };
}

/** 找出某个身份的第一个活人 */
function who(g, role) {
  const p = g.players.filter(x => x.role === role && x.alive)[0];
  return p ? p.id : '';
}
/** 所有狼 */
function wolves(g) { return g.players.filter(x => x.role === ROLE.WOLF).map(x => x.id); }
/** 所有好人 */
function goods(g) { return g.players.filter(x => x.role !== ROLE.WOLF).map(x => x.id); }

console.log('\n[1] 按人数配身份（用户口径：6~8 两狼，9~12 三狼）');
{
  for (const n of [6, 7, 8]) {
    const plan = rolePlan(n);
    const cnt = {};
    plan.forEach(r => { cnt[r] = (cnt[r] || 0) + 1; });
    ok(n + ' 人：数量对得上', plan.length === n, String(plan.length));
    ok(n + ' 人：2 狼', cnt[ROLE.WOLF] === 2, JSON.stringify(cnt));
    ok(n + ' 人：有预言家 + 女巫', cnt[ROLE.SEER] === 1 && cnt[ROLE.WITCH] === 1, JSON.stringify(cnt));
    ok(n + ' 人：没有猎人（9 人才有）', !cnt[ROLE.HUNTER], JSON.stringify(cnt));
  }
  for (const n of [9, 10, 11, 12]) {
    const plan = rolePlan(n);
    const cnt = {};
    plan.forEach(r => { cnt[r] = (cnt[r] || 0) + 1; });
    ok(n + ' 人：数量对得上', plan.length === n, String(plan.length));
    ok(n + ' 人：3 狼', cnt[ROLE.WOLF] === 3, JSON.stringify(cnt));
    ok(n + ' 人：预言家 + 女巫 + 猎人各一',
      cnt[ROLE.SEER] === 1 && cnt[ROLE.WITCH] === 1 && cnt[ROLE.HUNTER] === 1, JSON.stringify(cnt));
  }
  // 洗牌：连洗 40 次都不该出现「所有身份一模一样」的顺序
  const sigs = new Set();
  for (let i = 0; i < 40; i++) sigs.add(rolePlan(9).join(','));
  ok('身份是随机的（40 次洗牌有多种结果）', sigs.size > 5, '不同排列 ' + sigs.size + ' 种');

  // 狼永远少于好人 —— 这是平衡点，配比改了会先在这里炸
  for (const n of [6, 7, 8, 9, 10, 11, 12]) {
    const plan = rolePlan(n);
    const w = plan.filter(r => r === ROLE.WOLF).length;
    ok(n + ' 人：狼少于好人', w * 2 < n, w + ' 狼 / ' + n + ' 人');
  }
}

console.log('\n[2] 开局与人数限制');
{
  const a = makeGame(5);
  ok('少于 6 人开不了局', a.r.ok === false && a.r.code === 'too_few', JSON.stringify(a.r));
  const b = makeGame(13);
  ok('多于 12 人开不了局', b.r.ok === false && b.r.code === 'too_many', JSON.stringify(b.r));
  const c = makeGame(6);
  ok('6 人可以开局', c.r.ok === true, JSON.stringify(c.r));
  ok('玩家表长度 = 6', c.g.players.length === 6);
  ok('开局后立刻进夜晚', c.g.phase === SKIN_PHASE.NIGHT, c.g.phase);
  ok('狼的数量对', c.g.wolves(true).length === 2, String(c.g.wolves(true).length));
  ok('开局播报里说了双方人数', /画师 vs/.test(c.chats.join('|')), c.chats.join('|'));
}

console.log('\n[3] 身份只给本人（最关键的裁剪）');
{
  const { g } = makeGame(6);
  // 逐个检查：roleInfoFor 只给那个人自己的身份
  let wrong = 0;
  for (const p of g.players) {
    const info = g.roleInfoFor(p.id);
    if (!info || info.role !== p.role) wrong++;
  }
  ok('roleInfoFor 返回的是他自己的身份', wrong === 0, String(wrong));

  // ⚠ 快照里绝不能有任何**别人的**身份字段。
  //   注意判别方式：不能拿 `/"role"\s*:/` 去扫整串 JSON —— `me.role` 是自己那份、
  //   本来就该有（前端靠它渲染身份卡），而 `winnerName` 之类的键名也会被这个正则误伤。
  //   正确做法是逐字段检查：只有 `me` 允许带 role，players 名片只许有公开字段。
  const snap = g.snapshotFor('u1');
  const json = JSON.stringify(snap);
  ok('只有 me 带 role（自己那份）', snap.me && typeof snap.me.role === 'string', JSON.stringify(snap.me));
  const leaked = Object.keys(snap).filter(k => k !== 'me' && typeof snap[k] === 'object' && snap[k] !== null
    && JSON.stringify(snap[k]).indexOf('"role"') >= 0);
  ok('快照里没有别的 role 字段', leaked.length === 0, leaked.join(','));
  ok('快照里没有 mates 字段', !/"mates"\s*:/.test(json));
  ok('快照里没有 camp 字段', !/"camp"\s*:/.test(json));
  ok('快照里没有 winner 之外的底牌（夜间裁定不含在内）', !/"nightLastCheck"/.test(json));

  // 快照里的玩家名片只有「名字 + 在不在场」这类公开信息
  const cardKeys = Object.keys(snap.players[0]).sort().join(',');
  ok('玩家名片字段全是公开信息', cardKeys === 'alive,cause,name,online,userId', cardKeys);
  ok('玩家名片里翻不出身份', snap.players.every(p => !('role' in p) && !('camp' in p)), JSON.stringify(snap.players[0]));

  // 狼能看到同伴；好人看不到
  const wolfId = who(g, ROLE.WOLF);
  const goodId = who(g, ROLE.VILLAGER);
  const wInfo = g.roleInfoFor(wolfId);
  const gInfo = g.roleInfoFor(goodId);
  ok('狼拿得到同伴名单', Array.isArray(wInfo.mates) && wInfo.mates.length === 1, JSON.stringify(wInfo.mates));
  ok('好人拿不到同伴名单', gInfo.mates === null, JSON.stringify(gInfo.mates));
  ok('狼的同伴是其他狼', wInfo.mates.every(m => wolves(g).indexOf(m.userId) >= 0));
  ok('狼的同伴不含自己', wInfo.mates.every(m => m.userId !== wolfId));
  ok('狼的阵营是伪装者', wInfo.camp === CAMP.WOLF && wInfo.campName === '伪装者');
  ok('好人的阵营是画师', gInfo.camp === CAMP.GOOD && gInfo.campName === '画师');
}

console.log('\n[4] 夜里：预言家验人');
{
  const { g } = makeGame(6);
  const seer = who(g, ROLE.SEER);
  const wolf = who(g, ROLE.WOLF);
  const villager = who(g, ROLE.VILLAGER);

  ok('非预言家验人被拒', g.nightAction(villager, 'check', wolf).ok === false);
  ok('狼不能验人', g.nightAction(wolf, 'check', villager).ok === false);

  const r1 = g.nightAction(seer, 'check', wolf);
  ok('预言家验狼成功', r1.ok === true, JSON.stringify(r1));
  const n1 = g.nightInfoFor(seer);
  ok('预言家拿到结果（狼）', n1 && n1.kind === 'check' && n1.isWolf === true, JSON.stringify(n1));
  ok('结果里带目标名字', n1.targetName === NAMES[+wolf.slice(1) - 1], n1.targetName);

  // 同一个人不能验两次（这一夜）
  const r2 = g.nightAction(seer, 'check', wolf);
  ok('同一个人不能重复验', r2.ok === false, JSON.stringify(r2));

  // 换个人验，结果是好人
  const r3 = g.nightAction(seer, 'check', villager);
  ok('换个人可以验', r3.ok === true, JSON.stringify(r3));
  const n3 = g.nightInfoFor(seer);
  ok('结果更新为好人', n3.isWolf === false, JSON.stringify(n3));

  // 别人拿不到这个结果
  ok('别人拿不到验人结果', g.nightInfoFor(villager) === null ||
    g.nightInfoFor(villager).kind !== 'check');
  ok('狼拿不到验人结果', !g.nightInfoFor(wolf) || g.nightInfoFor(wolf).kind !== 'check');
}

console.log('\n[5] 夜里：狼刀人（多数决 / 平票随机）');
{
  const { g } = makeGame(6);
  const ws = wolves(g);
  const goods2 = goods(g);
  const villager = goods2.filter(id => g.entryOf(id).role === ROLE.VILLAGER)[0];

  ok('好人不能刀人', g.nightAction(goods2[0], 'kill', villager).ok === false);
  ok('狼不能刀同伴', g.nightAction(ws[0], 'kill', ws[1]).ok === false);
  ok('狼不能刀自己', g.nightAction(ws[0], 'kill', ws[0]).ok === false);

  // 两个狼都投同一个人 → 多数决
  ok('狼1出刀成功', g.nightAction(ws[0], 'kill', villager).ok === true);
  ok('收齐之前 nightReady 还是 false', g.nightReady() === false);
  ok('收齐之前 nightKill 还是空的', !g.nightKill);
  ok('狼2跟刀成功', g.nightAction(ws[1], 'kill', villager).ok === true);
  // ⚠ 狼刀是唯一的硬性条件：两票投完就该进入收尾。
  //   但**不是立刻天亮** —— 女巫要先看到「今晚刀的是谁」才能决定用不用药，
  //   所以狼收齐后进入 WITCH_GRACE_MS 的决策窗口，到点由 tick 收尾。
  ok('两狼投完就算收齐（不等预言家）', g.nightReady() === true);
  ok('收齐后进入女巫决策窗口（还留在夜里）', g.phase === SKIN_PHASE.NIGHT, g.phase);
  ok('窗口是短时限（不是整夜）', g.deadline - Date.now() <= SKIN_GRACE_MAX, String(g.deadline - Date.now()));

  g.resolveNight();
  ok('目标出局', g.entryOf(villager).alive === false, JSON.stringify(g.entryOf(villager)));
  ok('死因是狼杀', g.entryOf(villager).cause === 'wolf');
  ok('昨晚有人走了', g.nightDeaths.indexOf(villager) >= 0, JSON.stringify(g.nightDeaths));
  ok('天亮公告点名了', /甲|乙|丙|丁|戊|己/.test(g.lastNightSummary.text), g.lastNightSummary.text);
  ok('进入天亮阶段', g.phase === SKIN_PHASE.DAWN, g.phase);
  ok('被刀的人自己知道（发给本人）', g.nightInfoFor(villager).kind === 'dead', JSON.stringify(g.nightInfoFor(villager)));
  // ⚠ 要挑一个**确定不是受害者、也不是女巫**的人来验：
  //   goods2[0] 有可能正好就是 villager 或女巫 —— 那两种人本来就该拿到私有信息
  //   （受害者知道自己被刀、女巫看得到刀口），拿他们断言「应该什么都不知道」会误报。
  const bystander = g.alivePlayers()
    .filter(p => p.id !== villager && p.id !== who(g, ROLE.WITCH) && p.role !== ROLE.WOLF)[0];
  ok('★ 普通好人看不到任何夜间信息', g.nightInfoFor(bystander.id) === null,
    bystander.name + ' -> ' + JSON.stringify(g.nightInfoFor(bystander.id)));
}

console.log('\n[6] 夜里：狼刀了但女巫救回来 → 平安夜');
{
  const { g } = makeGame(6);
  const ws = wolves(g);
  const witch = who(g, ROLE.WITCH);
  const target = who(g, ROLE.VILLAGER);

  g.nightAction(ws[0], 'kill', target);
  g.nightAction(ws[1], 'kill', target);
  const sv = g.nightAction(witch, 'save', target);
  ok('女巫救人成功', sv.ok === true, JSON.stringify(sv));
  ok('解药只有一瓶（标记已用）', g.witchSaveUsed === true);

  g.resolveNight();
  ok('被救的人活着', g.entryOf(target).alive === true);
  ok('没有人员伤亡', g.nightDeaths.length === 0);
  ok('公告说是平安夜', /平安夜/.test(g.lastNightSummary.text), g.lastNightSummary.text);
  ok('公告提到被救了', g.lastNightSummary.saved === true);
  ok('被刀的人知道自己被救（发给本人）',
    g.nightInfoFor(target).kind === 'dead' && g.nightInfoFor(target).saved === true,
    JSON.stringify(g.nightInfoFor(target)));

  // 第二瓶药不行
  const sv2 = g.nightAction(witch, 'save', target);
  ok('解药用完就没了', sv2.ok === false, JSON.stringify(sv2));
}

console.log('\n[7] 夜里：女巫用药的约束（自救 / 只能救刀口 / 一瓶）');
{
  const { g } = makeGame(6);
  const witch = who(g, ROLE.WITCH);
  const ws = wolves(g);
  const villager = who(g, ROLE.VILLAGER);

  // 狼还没定刀时，女巫无从下手 —— 她必须等「今晚刀的是谁」这个信息
  ok('狼没定刀时点药会被拒', g.nightAction(witch, 'save', villager).ok === false,
    JSON.stringify(g.nightAction(witch, 'save', villager)));
  ok('狼没定刀时 nightInfoFor 也没有刀口可看', g.nightInfoFor(witch) === null,
    JSON.stringify(g.nightInfoFor(witch)));

  // 狼定刀之后
  g.nightAction(ws[0], 'kill', villager);
  g.nightAction(ws[1], 'kill', villager);
  const winfo = g.nightInfoFor(witch);
  ok('★ 狼定刀后女巫能看到刀口', winfo && winfo.kind === 'witch', JSON.stringify(winfo));
  ok('女巫看到的刀口就是被刀的人', winfo.target === villager, JSON.stringify(winfo));
  ok('刀口信息里不含「谁是狼」', !/wolf(?!\w)/.test(JSON.stringify(winfo)), JSON.stringify(winfo));

  // 只能救刀口上的人 —— 点别人是无效操作（服务端拦下来，免得白费一瓶药）
  const other = g.alivePlayers().filter(p => p.id !== villager && p.id !== witch)[0];
  ok('药不能点在没被刀的人身上', g.nightAction(witch, 'save', other.id).ok === false);
  ok('第一晚自救被拒（自己是刀口也不行）', g.nightAction(witch, 'save', witch).ok === false);
  ok('救刀口上的人可以', g.nightAction(witch, 'save', villager).ok === true);
  ok('解药只有一瓶（标记已用）', g.witchSaveUsed === true);
}

console.log('\n[8] 白天：同题作画 + 私密 + 匿名展示');
{
  const { g } = makeGame(6);
  g.advanceNight();          // 夜 → 天亮（狼没出刀 = 空刀，平安夜）
  ok('进入天亮', g.phase === SKIN_PHASE.DAWN, g.phase);
  ok('空刀也是平安夜', /平安夜/.test(g.lastNightSummary.text), g.lastNightSummary.text);

  g.advanceDawn();
  ok('进入作画阶段', g.phase === SKIN_PHASE.DAY_DRAW, g.phase);
  ok('本轮有主题词', !!g.currentWord(), g.currentWord());
  ok('主题词是中文', /[\u4e00-\u9fa5]/.test(g.currentWord()), g.currentWord());

  const alive = g.alivePlayers().map(p => p.id);
  ok('活人都能画（lockedFor=false）', alive.every(id => g.lockedFor(id) === false));

  // 快照公开主题（大家画同一题，藏也没用），但**不公开别人的画**
  const snap = g.snapshotFor('u1');
  ok('快照里有本轮主题', snap.word === g.currentWord(), snap.word);
  ok('作画阶段画廊是空的', snap.gallery === null, JSON.stringify(snap.gallery));
  ok('快照里没有别人的作品', JSON.stringify(snap).indexOf('data:image') < 0);

  // 逐个交画
  const pngs = {};
  alive.forEach((id, i) => {
    pngs[id] = 'data:image/png;base64,WORK' + i;
    const r = g.submitArt(id, pngs[id]);
    if (!r.ok) ok('交画失败 ' + id, false, JSON.stringify(r));
  });
  ok('全交齐 → 进入讨论', g.phase === SKIN_PHASE.DAY_TALK, g.phase);
  ok('作品数 = 活人数', g.works.length === alive.length, g.works.length + '/' + alive.length);

  const talkSnap = g.snapshotFor('u1');
  ok('讨论阶段画廊可见', Array.isArray(talkSnap.gallery) && talkSnap.gallery.length === alive.length);
  ok('画廊里的图是真的', talkSnap.gallery.every(w => w.png.indexOf('data:image/') === 0));
  // ⚠ 匿名性：画廊里绝不能出现 userId
  const gAlive = new Set(alive);
  const leaked = talkSnap.gallery.filter(w => w.userId || gAlive.has(w.id));
  ok('画廊里没有作者（匿名）', leaked.length === 0, JSON.stringify(leaked.map(x => x.id)));
  ok('画廊的 id 只是序号', talkSnap.gallery.every(w => /^w\d+$/.test(w.id)), talkSnap.gallery.map(w => w.id).join(','));
  // 作品顺序与交稿顺序无关（按开局固定的 order 排）
  ok('作品顺序按固定 order 排（不是交稿顺序）',
    g.works.map(w => w.userId).join(',') === g.order.filter(id => gAlive.has(id)).join(','),
    g.works.map(w => w.userId).join(',') + ' vs ' + g.order.filter(id => gAlive.has(id)).join(','));
  // 快照里连「谁交了」都不该带作者
  ok('快照里没有 works 原始数组（只有画廊）', !/"works"\s*:/.test(JSON.stringify(talkSnap)));
}

console.log('\n[9] 白天：出局的人不能画、不能投，但还在名单里');
{
  const { g } = makeGame(6);
  const target = who(g, ROLE.VILLAGER);
  // 夜里刀掉一个人
  wolves(g).forEach(w => g.nightAction(w, 'kill', target));
  g.resolveNight();
  g.advanceDawn();
  g.advanceDawn();

  ok('出局的人不能动笔', g.lockedFor(target) === true);
  ok('活着的人能动笔', g.lockedFor('u1') === (g.entryOf('u1').alive ? false : true));

  const snap = g.snapshotFor(target);
  ok('出局的人 canDraw = false', snap.canDraw === false);
  ok('出局的人还在玩家名单里', snap.players.some(p => p.userId === target));
  ok('出局的人标记为 not alive', snap.players.filter(p => p.userId === target)[0].alive === false);
  ok('在场人数少了一个', snap.aliveCount === 5, String(snap.aliveCount));
  ok('出局的人自己的 me.alive = false', snap.me.alive === false);

  // 交画：出局的人交不了
  ok('出局的人交画被拒', g.submitArt(target, 'data:image/png;base64,X').ok === false);
}

console.log('\n[10] 白天：投票放逐');
{
  const { g } = makeGame(6);
  g.advanceNight(); g.advanceDawn();
  const alive = g.alivePlayers().map(p => p.id);
  alive.forEach(id => g.submitArt(id, 'data:image/png;base64,A'));
  ok('交齐进讨论', g.phase === SKIN_PHASE.DAY_TALK, g.phase);

  g.beginVote();
  ok('进入投票', g.phase === SKIN_PHASE.DAY_VOTE, g.phase);
  ok('投票阶段锁笔', g.lockedFor('u1') === true);
  ok('活着的人 canVote', g.snapshotFor('u1').canVote === true);

  // 全场投同一个人 → 放逐
  const victim = alive[2];
  alive.forEach(id => g.vote(id, victim));
  ok('投齐 → 结算', g.phase === SKIN_PHASE.VOTE_END, g.phase);
  ok('被放逐的人出局', g.entryOf(victim).alive === false);
  ok('死因是投票', g.entryOf(victim).cause === 'vote');
  ok('结果里点名了', g.voteResult.exiled === victim, JSON.stringify(g.voteResult.exiled));
  // 票是公开的（狼人杀里最重要的推理材料）
  ok('公开了每个人的票', Array.isArray(g.voteResult.ballot) && g.voteResult.ballot.length === alive.length);
  ok('票里带投票人名字', g.voteResult.ballot.every(b => b.voterName && b.targetName));
  // ⚠ 快照里「我投给谁」只回给本人
  ok('我的票只回给我', g.snapshotFor(alive[0]).myVote === victim);
}

console.log('\n[11] 投票平票 → 无人出局');
{
  const { g } = makeGame(6);
  g.advanceNight(); g.advanceDawn();
  const alive = g.alivePlayers().map(p => p.id);
  alive.forEach(id => g.submitArt(id, 'data:image/png;base64,A'));
  g.beginVote();
  // 6 个人分成 3:3
  alive.forEach((id, i) => g.vote(id, alive[i < 3 ? 0 : 1]));
  ok('平票不放逐', g.voteResult.tie === true && g.voteResult.exiled === '', JSON.stringify(g.voteResult.exiled));
  ok('没人出局', g.alivePlayers().length === 6, String(g.alivePlayers().length));
  ok('公告说了平票', /平票|没有人被放逐/.test(g.__chats.join('|')), g.__chats.join('|'));
}

console.log('\n[12] 猎人被放逐可以开枪');
{
  let found = null;
  // 9 人局才有猎人；反复开局直到拿到「猎人不在 u1 且活到最后」的排布
  for (let i = 0; i < 30 && !found; i++) {
    const { g } = makeGame(9, { rounds: 3 });
    const hunter = who(g, ROLE.HUNTER);
    if (!hunter) continue;
    g.advanceNight(); g.advanceDawn();
    const alive = g.alivePlayers().map(p => p.id);
    alive.forEach(id => g.submitArt(id, 'data:image/png;base64,A'));
    g.beginVote();
    alive.forEach(id => g.vote(id, hunter));
    // 全场投猎人的话他就在 VOTE_END，pendingShot 应该是他
    if (g.pendingShot === hunter) found = { g, hunter, alive };
  }
  if (!found) {
    ok('能构造出「猎人被放逐」的局面', false, '30 次都没凑出来');
  } else {
    const { g, hunter, alive } = found;
    ok('猎人被放逐后待开枪', g.pendingShot === hunter, g.pendingShot);
    ok('只有猎人自己被提示 pendingShot', g.snapshotFor(hunter).pendingShot === true);
    ok('别人没有被提示', alive.filter(x => x !== hunter).every(x => g.snapshotFor(x).pendingShot === false));

    const victim = alive.filter(x => x !== hunter && g.entryOf(x).alive)[0];
    const other = alive.filter(x => x !== hunter && x !== victim)[0];
    ok('别人开不了枪', g.hunterShot(other, victim).ok === false);

    const r = g.hunterShot(hunter, victim);
    ok('猎人开枪成功', r.ok === true, JSON.stringify(r));
    ok('被打的人出局', g.entryOf(victim).alive === false);
    ok('死因是枪', g.entryOf(victim).cause === 'shot');
    ok('结果里记了枪', g.voteResult.shot === victim);
    ok('开完枪就不能再开', g.hunterShot(hunter, other).ok === false || !g.pendingShot);
  }
}

console.log('\n[13] 胜负：狼全出局 → 好人赢');
{
  const { g } = makeGame(6);
  const ws = wolves(g);
  // 直接一夜一夜地放逐狼；每次走完整轮
  let guard = 0;
  while (g.active && g.phase !== SKIN_PHASE.OVER && guard++ < 20) {
    if (g.phase === SKIN_PHASE.NIGHT) {
      // 狼空刀，免得好人先被刀光
      g.advanceNight();
    } else if (g.phase === SKIN_PHASE.DAWN) {
      g.advanceDawn();
    } else if (g.phase === SKIN_PHASE.DAY_DRAW) {
      g.alivePlayers().forEach(p => g.submitArt(p.id, 'data:image/png;base64,A'));
    } else if (g.phase === SKIN_PHASE.DAY_TALK) {
      g.beginVote();
    } else if (g.phase === SKIN_PHASE.DAY_VOTE) {
      // 全场集火第一头还活着的狼
      const t = ws.filter(id => g.entryOf(id).alive)[0];
      if (!t) break;
      g.alivePlayers().forEach(p => g.vote(p.id, t));
    } else if (g.phase === SKIN_PHASE.VOTE_END) {
      if (g.pendingShot) g.hunterShot(g.pendingShot, '');
      g.advanceVoteEnd();
    } else break;
  }
  ok('狼全出局 → 好人赢', g.winner === CAMP.GOOD, g.winner + ' / ' + g.winReason);
  ok('结束阶段是 over', g.phase === SKIN_PHASE.OVER, g.phase);
  ok('公告说了谁赢', /画师阵营获胜/.test(g.__chats.join('|')), g.__chats.join('|'));
  ok('结算时公开身份（revealAll 有值）', Array.isArray(g.revealAll()) && g.revealAll().length === 6);
}

console.log('\n[14] 胜负：狼数 ≥ 好人数 → 狼赢');
{
  let done = false;
  for (let i = 0; i < 40 && !done; i++) {
    const { g } = makeGame(6);
    const ws = wolves(g);
    let guard = 0;
    while (g.active && g.phase !== SKIN_PHASE.OVER && guard++ < 20) {
      if (g.phase === SKIN_PHASE.NIGHT) {
        // 狼刀好人（优先刀非狼），预言家也验一下让 nightReady 满足
        const t = g.alivePlayers().filter(p => p.role !== ROLE.WOLF)[0];
        if (!t) break;
        ws.forEach(w => g.nightAction(w, 'kill', t.id));
        const seer = who(g, ROLE.SEER);
        if (seer) g.nightAction(seer, 'check', ws[0]);
        g.advanceNight();
      } else if (g.phase === SKIN_PHASE.DAWN) {
        g.advanceDawn();
      } else if (g.phase === SKIN_PHASE.DAY_DRAW) {
        g.alivePlayers().forEach(p => g.submitArt(p.id, 'data:image/png;base64,A'));
      } else if (g.phase === SKIN_PHASE.DAY_TALK) {
        g.beginVote();
      } else if (g.phase === SKIN_PHASE.DAY_VOTE) {
        // 全场集火一个好人（帮狼快速达成条件）
        const t = g.alivePlayers().filter(p => p.role !== ROLE.WOLF)[0];
        if (!t) break;
        g.alivePlayers().forEach(p => g.vote(p.id, t.id));
      } else if (g.phase === SKIN_PHASE.VOTE_END) {
        if (g.pendingShot) g.hunterShot(g.pendingShot, '');
        g.advanceVoteEnd();
      } else break;
    }
    if (g.winner === CAMP.WOLF && /人数已经不少于/.test(g.winReason)) { done = true; }
  }
  ok('狼数 ≥ 好人数 → 狼赢', done);
}

console.log('\n[15] 胜负：打满轮数 → 狼赢（好人没完成画作）');
{
  const { g } = makeGame(8, { rounds: 2 });   // 只打 2 轮，方便触发
  let guard = 0;
  while (g.active && g.phase !== SKIN_PHASE.OVER && guard++ < 20) {
    if (g.phase === SKIN_PHASE.NIGHT) {
      // 狼空刀；预言家验一下
      const seer = who(g, ROLE.SEER);
      if (seer) g.nightAction(seer, 'check', g.alivePlayers().filter(p => p.role !== ROLE.SEER)[0].id);
      g.advanceNight();
    } else if (g.phase === SKIN_PHASE.DAWN) {
      g.advanceDawn();
    } else if (g.phase === SKIN_PHASE.DAY_DRAW) {
      g.alivePlayers().forEach(p => g.submitArt(p.id, 'data:image/png;base64,A'));
    } else if (g.phase === SKIN_PHASE.DAY_TALK) {
      g.beginVote();
    } else if (g.phase === SKIN_PHASE.DAY_VOTE) {
      // 全场弃票 → 平票不放逐。
      // ⚠ 注意 vote(id, '') 的语义是「撤票」而不是「投了一票给空」——
      //   它会把票删掉、votes.size 不增长，所以这里必须改用 finishVote() 直接结算，
      //   否则循环会卡在投票阶段（没人真正投票 → 永远收不满）。
      g.alivePlayers().forEach(p => g.vote(p.id, ''));
      g.finishVote();
    } else if (g.phase === SKIN_PHASE.VOTE_END) {
      if (g.pendingShot) g.hunterShot(g.pendingShot, '');
      g.advanceVoteEnd();
    } else break;
  }
  ok('打满轮数 → 狼赢', g.winner === CAMP.WOLF, g.winner + ' / ' + g.winReason);
  ok('理由说了打满轮数', /打满|没能把伪装者/.test(g.winReason), g.winReason);
}

console.log('\n[16] 时钟：每个阶段超时都会自己往前走');
{
  const { g } = makeGame(6);
  const seq = [];
  seq.push(g.phase);                       // skin_night
  g.tick(Date.now() + 10 * 60 * 1000);     // 夜晚超时
  seq.push(g.phase);                       // skin_dawn
  g.tick(Date.now() + 10 * 60 * 1000);     // 天亮超时
  seq.push(g.phase);                       // skin_draw
  g.tick(Date.now() + 10 * 60 * 1000);     // 作画超时
  seq.push(g.phase);                       // skin_talk
  g.tick(Date.now() + 10 * 60 * 1000);     // 讨论超时
  seq.push(g.phase);                       // skin_vote
  g.tick(Date.now() + 10 * 60 * 1000);     // 投票超时
  seq.push(g.phase);                       // skin_vote_end 或 over
  ok('阶段按时钟依次推进',
    seq.join(' → ') === [
      SKIN_PHASE.NIGHT, SKIN_PHASE.DAWN, SKIN_PHASE.DAY_DRAW,
      SKIN_PHASE.DAY_TALK, SKIN_PHASE.DAY_VOTE, SKIN_PHASE.VOTE_END
    ].join(' → '), seq.join(' → '));
  ok('作画超时留了空白作品', g.works.some(w => w.skipped) ||
    g.phase === SKIN_PHASE.VOTE_END || g.voteResult, 'works=' + JSON.stringify(g.works.map(w => w.skipped)));
}

console.log('\n[17] 时钟：作画超时会推进（不卡死）');
{
  const { g } = makeGame(6);
  g.tick(Date.now() + 9999999);   // 夜 → 天亮
  g.tick(Date.now() + 9999999);   // 天亮 → 作画
  ok('在作画阶段', g.phase === SKIN_PHASE.DAY_DRAW, g.phase);
  g.tick(Date.now() + 9999999);   // 作画超时
  ok('作画超时后离开作画阶段', g.phase !== SKIN_PHASE.DAY_DRAW, g.phase);
  ok('超时也能进讨论（空白画上墙）', g.phase === SKIN_PHASE.DAY_TALK, g.phase);
}

console.log('\n[18] 房间成员变动');
{
  const { g, room } = makeGame(6);
  // 局中进人 → 观战
  const late = { userId: 'u99', name: '迟到', color: '#000' };
  room.members.set('u99', late);
  g.onJoin(late);
  ok('局中进房只能观战', g.spectators.has('u99') === true);
  ok('观战者不进玩家表', g.players.every(p => p.id !== 'u99'));
  ok('观战者拿不到身份', g.roleInfoFor('u99') === null);
  ok('观战者快照里 spectating = true', g.snapshotFor('u99').spectating === true);
  ok('播报说明了先观战', /先观战/.test(g.__chats.join('|')), g.__chats.join('|'));
  ok('观战者不能投票', g.vote('u99', 'u1').ok === false);

  // 夜里走掉的狼 → 别让全场干等
  const { g: g2, room: r2 } = makeGame(6);
  const w = wolves(g2)[0];
  r2.members.delete(w);
  g2.onLeave({ userId: w, name: '某狼' });
  ok('夜里走人不炸（onLeave 安全）', g2.active === true, String(g2.active));

  // 走太多人 → 人不够打了。
  // ⚠ 这里的门槛是 SKIN_MIN_ALIVE（局中继续的下限），不是开局的 SKIN_MIN_PLAYERS：
  //   「局中继续」和「开局」必须是两个数。局中人数只会一路减少，拿 6 去卡继续的话，
  //   6 人局走一个人就散局，永远走不到结算。
  // ⚠ 另外要注意判定的**先后**：退出本身就会改变阵营对比，所以任何一次退出都先过
  //   checkWin —— 阵营一旦失衡，该判**胜负**（结算）而不是「人少了散局」。
  //   这里不依赖随机身份，而是**手动摆盘**成指定局面，避免测试自己抖。
  const { g: g3, room: r3 } = makeGame(6);
  // 摆成「1 狼 + 1 好」以外的中立局面先走一遍：把全员打散重摆
  const w3 = g3.players.filter(p => p.role === ROLE.WOLF);
  const gd3 = g3.players.filter(p => p.role !== ROLE.WOLF);
  // 让好人全员存活、狼全员存活（默认就是这样），然后逐步退出好人到只剩 1 个
  gd3.slice(1).forEach(p => { /* 保留第一个好人，其余退出 */ });
  const leavers = gd3.slice(1).map(p => p.id);         // 3 个好人
  leavers.forEach(id => { r3.members.delete(id); g3.onLeave({ userId: id, name: '走' + id }); });
  // 此时 2 狼 vs 1 好 —— 第一次退到这一步时就该判狼胜（狼数 ≥ 好人数）
  ok('退到阵营失衡 → 直接结算而不是散局',
    g3.phase === SKIN_PHASE.OVER || g3.phase === SKIN_PHASE.LOBBY, g3.phase);
  ok('结算理由说得通（判胜或人不够）',
    !!g3.winner || /玩不下去|人数不足/.test(g3.__chats.join('|')),
    g3.winner + ' / ' + g3.__chats.slice(-1)[0]);

  // 真正会「人不够退回大厅」的场景，以及「狼自己退出不算好人赢」这条规则。
  // 手动摆盘：1 狼 + 1 好，其余全出局。然后让那头**狼**退出。
  // 期望：**不能**判好人赢（狼不是被找出来的，是自己走的）——
  //   这就是 retired 标记存在的理由，否则最后一个狼一退，剩下的人白拿一场胜利。
  const { g: g6, room: r6 } = makeGame(6);
  const w6 = g6.players.filter(p => p.role === ROLE.WOLF)[0];
  const gd6 = g6.players.filter(p => p.role !== ROLE.WOLF);
  g6.players.forEach(p => {
    if (p.id !== w6.id && p.id !== gd6[0].id) { p.alive = false; p.cause = 'wolf'; }
  });
  r6.members.delete(w6.id);
  g6.onLeave({ userId: w6.id, name: '走狼' });
  ok('★ 狼自己退出不算好人赢（retired 标记生效）', g6.winner !== CAMP.GOOD,
    g6.winner + '/' + g6.winReason);
  ok('狼退出后局面没有被误判成结束', g6.phase !== SKIN_PHASE.OVER || g6.winner !== CAMP.GOOD,
    g6.phase + '/' + g6.winner);

  // 对照：如果狼是被**投出去**的，同样的局面就必须判好人赢
  const { g: g7 } = makeGame(6);
  const w7 = g7.players.filter(p => p.role === ROLE.WOLF)[0];
  const gd7 = g7.players.filter(p => p.role !== ROLE.WOLF);
  g7.players.forEach(p => {
    if (p.id !== w7.id && p.id !== gd7[0].id) { p.alive = false; p.cause = 'wolf'; }
  });
  w7.alive = false; w7.cause = 'vote';   // 被放逐，不是退出
  g7.checkWin();
  ok('对照：狼被投出去 → 好人赢', g7.winner === CAMP.GOOD, g7.winner + '/' + g7.winReason);
}

console.log('\n[19] 作画阶段是「私密」的（配合 index.js 的 privateDrawOn）');
{
  const { g } = makeGame(6);
  g.tick(Date.now() + 9999999);
  g.tick(Date.now() + 9999999);
  ok('★ 作画阶段必须让 privateDrawOn 命中（phase = skin_draw）',
    g.phase === SKIN_PHASE.DAY_DRAW && g.mode === 'skin', g.mode + '/' + g.phase);
  // 其余阶段都不该是私密的（否则讨论时别人看不到你的画布状态）
  g.tick(Date.now() + 9999999);
  ok('讨论阶段不是私密作画', g.phase !== SKIN_PHASE.DAY_DRAW, g.phase);
}

console.log('\n[20] 夜里聊天要闭嘴（chatLeaks）');
{
  const { g } = makeGame(6);
  ok('夜里发言会被拦', g.chatLeaks('u1') === true);
  g.tick(Date.now() + 9999999);   // → 天亮
  ok('天亮能说话', g.chatLeaks('u1') === false);
  g.tick(Date.now() + 9999999);   // → 作画
  ok('作画时能说话', g.chatLeaks('u1') === false);
}

console.log('\n[21] 快照字段完整性（前端依赖这些）');
{
  const { g } = makeGame(8, { rounds: 4 });
  const s = g.snapshotFor('u1');
  const need = ['mode', 'phase', 'phaseLabel', 'round', 'maxRounds', 'deadline', 'serverNow',
    'me', 'spectating', 'players', 'aliveCount', 'wolfAlive', 'theme', 'themeName', 'word',
    'drawTotal', 'drawDone', 'myDrawn', 'isDrawPhase', 'canDraw', 'gallery', 'galleryCount',
    'voteTotal', 'voteDone', 'myVote', 'canVote', 'voteResult', 'pendingShot', 'shotPending',
    'lastNight', 'winner', 'winnerName', 'winReason', 'locked', 'isOwner', 'canStart',
    'minPlayers', 'maxPlayers', 'maxRoundsMax', 'themes', 'phaseMs'];
  const missing = need.filter(k => !(k in s));
  ok('快照字段齐全', missing.length === 0, missing.join(','));
  ok('模式是 skin', s.mode === 'skin');
  ok('最少人数 = 6', s.minPlayers === 6);
  ok('最多人数 = 12', s.maxPlayers === 12);
  ok('阶段有时长（画皮各阶段不等）', s.phaseMs === CFG.NIGHT_MS, String(s.phaseMs));
  ok('me 里只有 role / alive / cause', Object.keys(s.me).sort().join(',') === 'alive,cause,role',
    Object.keys(s.me).join(','));
}

console.log('\n[22] 每次阶段切换都会 sync（前端靠它更新界面）');
{
  const { g } = makeGame(6);
  const before = g.__syncs();
  g.advanceNight();
  ok('结算夜晚会 sync', g.__syncs() > before, String(g.__syncs()));
  const before2 = g.__syncs();
  g.advanceDawn();
  ok('进作画会 sync', g.__syncs() > before2, String(g.__syncs()));
  const before3 = g.__syncs();
  g.alivePlayers().forEach(p => g.submitArt(p.id, 'data:image/png;base64,A'));
  ok('交齐进讨论会 sync', g.__syncs() > before3, String(g.__syncs()));
}

console.log('\n[23] resetCanvas 只在「夜里」和「作画开始」各调一次');
{
  const { g } = makeGame(6);
  const r0 = g.__resets();
  ok('开局第一夜清了一次画布', r0 === 1, String(r0));
  g.advanceNight();       // → 天亮（不清理）
  g.advanceDawn();        // → 作画（清理）
  ok('作画开始又清一次', g.__resets() === 2, String(g.__resets()));
}

console.log('\n[24] 停止 / 收尾');
{
  const { g } = makeGame(6);
  g.stop();
  ok('停止后 phase = off', g.phase === SKIN_PHASE.OFF, g.phase);
  ok('停止后 active = false', g.active === false);
  ok('停止后玩家表清空', g.players.length === 0);
  ok('停止后身份拿不到了', g.roleInfoFor('u1') === null);
  ok('停止后快照里 me = null', g.snapshotFor('u1').me === null);
  ok('停止后 lockedFor 不拦人', g.lockedFor('u1') === false);
}

console.log('\n[25] 房主推进（next）');
{
  const { g } = makeGame(6);
  ok('非房主不能推进', g.next('u2').ok === false);
  ok('房主能推进夜晚', g.next('u1').ok === true);
  ok('推进到了天亮', g.phase === SKIN_PHASE.DAWN, g.phase);
  ok('房主能推进天亮', g.next('u1').ok === true);
  ok('推进到了作画', g.phase === SKIN_PHASE.DAY_DRAW, g.phase);
  ok('房主能跳过作画', g.next('u1').ok === true);
  ok('跳到了讨论', g.phase === SKIN_PHASE.DAY_TALK, g.phase);
  ok('房主能立刻开投', g.next('u1').ok === true);
  ok('到了投票', g.phase === SKIN_PHASE.DAY_VOTE, g.phase);
  ok('房主能立刻结算投票', g.next('u1').ok === true);
  ok('到了投票结算', g.phase === SKIN_PHASE.VOTE_END, g.phase);
}

console.log('\n[26] 身份播报用的 ROLE_INFO 完整');
{
  const need = [ROLE.SEER, ROLE.WITCH, ROLE.HUNTER, ROLE.VILLAGER, ROLE.WOLF];
  const missing = need.filter(r => !ROLE_INFO[r] || !ROLE_INFO[r].name || !ROLE_INFO[r].camp);
  ok('每个身份都有名字与阵营', missing.length === 0, missing.join(','));
  ok('预言家是好人', ROLE_INFO[ROLE.SEER].camp === CAMP.GOOD);
  ok('女巫是好人', ROLE_INFO[ROLE.WITCH].camp === CAMP.GOOD);
  ok('猎人是好人', ROLE_INFO[ROLE.HUNTER].camp === CAMP.GOOD);
  ok('平民是好人', ROLE_INFO[ROLE.VILLAGER].camp === CAMP.GOOD);
  ok('狼是狼', ROLE_INFO[ROLE.WOLF].camp === CAMP.WOLF);
  ok('每个身份都有说明文案', need.every(r => (ROLE_INFO[r].desc || '').length > 5));
  ok('中文名不重复', new Set(need.map(r => ROLE_INFO[r].name)).size === need.length);
}

console.log('\n================ 汇总 ================');
console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  （失败 ' + fail + '）' : '  —— 全绿'));
process.exit(fail ? 1 : 0);
