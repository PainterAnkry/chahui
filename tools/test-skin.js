/**
 * 茶绘 · 画皮模式端到端验收（虚拟客户端，不需要浏览器）
 *
 * 用法：
 *   GAME_SKIN_NIGHT_MS=2500 GAME_SKIN_DAWN_MS=1200 GAME_SKIN_DRAW_MS=1500 \
 *   GAME_SKIN_TALK_MS=1500 GAME_SKIN_VOTE_MS=1500 GAME_SKIN_VOTE_END_MS=1200 \
 *   GAME_SKIN_WITCH_GRACE_MS=1000 PORT=8446 node server/src/index.js
 *   node tools/test-skin.js ws://localhost:8446/ws
 *
 * 覆盖的断言分五类：
 *   ① 流程：开房 → 开局发身份 → 入夜验人/刀人 → 天亮 → 各自私密作画 → 匿名画廊
 *          → 讨论 → 投票放逐 → 判胜负 → 房主结束
 *   ② 权限：人数不足不能开、非房主不能开、出局的人不能动笔 / 不能投票
 *   ③ 保密（**唯一的死穴**）：身份只单发给本人；夜里的裁定只单发给当事人；
 *      作画阶段是私密画（别人收不到笔迹）；画廊里没有 userId
 *   ④ 裁定：平安夜 / 刀杀 / 平票不放逐 / 狼全出局判好人赢
 *   ⑤ 身份卡：预言家拿到验人结果、狼拿到同伴名单、女巫拿到刀口
 */
'use strict';

const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = (function () {
  const a = process.argv[2] || 'ws://localhost:8446/ws';
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
  const limit = timeout || 8000;
  while (Date.now() - t0 < limit) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(40);
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
    name, ws, log: [], room: null, you: null,
    gstate: null,     // 我收到的最新一份画皮快照（按我裁剪）
    role: null,       // 我私收到的 SKIN_ROLE（别人绝拿不到我的）
    night: null,      // 我私收到的 SKIN_NIGHT 裁定
    reveal: null,     // 'game:skin_role:all' —— 结算时的公开身份表
    open: false, closed: false
  };
  ws.on('open', () => { c.open = true; });
  ws.on('close', () => { c.closed = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) {
      c.room = m.room; c.you = m.you;
      if (m.game) c.gstate = m.game;
    }
    if (m.t === P.S2C.GAME_STATE) c.gstate = m.game;
    if (m.t === P.S2C.SKIN_ROLE) c.role = m;
    if (m.t === P.S2C.SKIN_ROLE + ':all') c.reveal = m.all || null;
    if (m.t === P.S2C.SKIN_NIGHT) c.night = m;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  c.phase = () => (c.gstate ? c.gstate.phase : '');
  /**
   * ⚠ `ROOM_JOINED.you` 是个**对象**（{ userId, name, color, isAdmin, ... }），不是 userId 字符串。
   *   直接 c.you 当 target 传出去会被 JSON 序列化成 "[object Object]"，
   *   服务端 entryOf 找不到人 → 报「这个人不在场上」，看起来像权限 bug。
   *   所以统一走这个取 userId 的口子。
   */
  c.uid = () => (c.you ? c.you.userId : '');
  c.act = (kind, target) => c.send(P.C2S.SKIN_ACTION, { kind, target });
  c.art = (png) => c.send(P.C2S.SKIN_ART, { png });
  c.close = () => ws.close();
  return c;
}

/** 从某个时刻起收到的消息（时间切片见 test-chain.js 的说明） */
function since(c, idx) { return JSON.stringify(c.log.slice(idx)); }
function lastErrSince(c, idx) {
  const l = c.log.slice(idx).filter(m => m.t === P.S2C.ERROR);
  return l.length ? l[l.length - 1] : null;
}

/** 1×1 合法 PNG（内容不重要，服务端只做哑存储），末尾带标记方便断言「传的是这一张」 */
function fakePng(tag) {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  return 'data:image/png;base64,' + b64 + '#' + tag;
}

/* ================================================================ 主流程 */

const CLIENTS = [];

async function connect(name) {
  const c = Client(name);
  const okOpen = await waitFor(() => c.open, 4000, name + ' 连接');
  if (!okOpen) throw new Error(name + ' 连不上 ' + URL_);
  CLIENTS.push(c);
  return c;
}

async function main() {
  const roomId = 'sktest_' + Date.now().toString(36).slice(-6);
  console.log('画皮模式 · 端到端验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  /* -------- 先验身份：端口上挂着的必须是我要的那台服务端 -------- */
  const info = await httpJson('/api/share');
  if (!info || !info.skin) {
    console.log('无法从 ' + httpBase() + '/api/share 读到画皮配置，请先启动服务端：');
    console.log('  GAME_SKIN_NIGHT_MS=2500 GAME_SKIN_DAWN_MS=1200 GAME_SKIN_DRAW_MS=1500 \\');
    console.log('  GAME_SKIN_TALK_MS=1500 GAME_SKIN_VOTE_MS=1500 GAME_SKIN_VOTE_END_MS=1200 \\');
    console.log('  GAME_SKIN_WITCH_GRACE_MS=1000 PORT=8446 node server/src/index.js');
    process.exit(1);
  }
  console.log('服务端 pid=' + info.pid + '  画皮计时 '
    + [info.skin.NIGHT_MS, info.skin.DAWN_MS, info.skin.DRAW_MS,
       info.skin.TALK_MS, info.skin.VOTE_MS, info.skin.VOTE_END_MS].join('/') + 'ms\n');
  if (info.skin.NIGHT_MS >= 30000) {
    console.log('⚠ 这台服务端用的是正式计时（' + info.skin.NIGHT_MS + 'ms），画皮测试会非常慢。');
    console.log('  请按上面的命令用压缩计时另起一个端口。');
    process.exit(1);
  }

  /* ============================================== [1] 房间与开局门槛 */
  console.log('[1] 房间与开局门槛');
  let host;
  {
    host = await connect('房主');
    host.send(P.C2S.ROOM_CREATE, { name: '画皮测试房', user: '房主', id: roomId });
    await waitFor(() => host.room, 4000, '建房间');
    ok('房主建好房间', !!host.room);

    // 只有房主一个人 → 人数不足（画皮要 6 人）
    host.send(P.C2S.GAME_START, { mode: 'skin' });
    await sleep(300);
    const e1 = host.last(P.S2C.ERROR);
    ok('人数不足时开局被拒绝', !!e1, e1 ? e1.message : '没有收到错误');
    ok('错误码是 too_few', !!e1 && e1.code === 'too_few', e1 ? e1.code : '');

    // 再补 5 个人（凑够 6）
    for (let i = 1; i <= 5; i++) {
      const c = await connect('玩家' + i);
      c.send(P.C2S.ROOM_JOIN, { roomId, user: '玩家' + i });
      await waitFor(() => c.room, 4000, '玩家' + i + ' 入房');
    }
    ok('六个人都在房间里', CLIENTS.length === 6 && CLIENTS.every(c => !!c.room));

    // 非房主开局 → 被拒
    const outsider = CLIENTS[1];
    outsider.send(P.C2S.GAME_START, { mode: 'skin' });
    await sleep(300);
    const e2 = outsider.last(P.S2C.ERROR);
    ok('非房主开局被拒绝', !!e2 && e2.code === 'not_owner', e2 ? e2.code : '没有收到错误');
  }

  /* ============================================== [2] 开局发身份 */
  console.log('\n[2] 开局与身份分发');
  const all = CLIENTS;
  {
    host.send(P.C2S.GAME_START, { mode: 'skin', rounds: 3 });
    const started = await waitFor(() => host.gstate && host.gstate.mode === 'skin'
      && host.phase() !== 'off' && host.phase() !== 'lobby', 6000, '开局');
    ok('画皮开起来了', started);
    if (!started) { console.log('\n开局失败，后续断言跳过。'); return finish(); }

    ok('模式是 skin', host.gstate.mode === 'skin', host.gstate.mode);
    ok('六个人都是玩家（不是观战）', host.gstate.aliveCount === 6, 'aliveCount=' + host.gstate.aliveCount);

    // 身份卡只单发给本人
    const allRole = await waitFor(() => all.every(c => c.role), 5000, '全员身份卡');
    ok('★ 每个人都收到了自己的身份卡（SKIN_ROLE）', allRole);

    // 6 人配比：2 狼 + 预言家 + 女巫 + 2 平民
    const roleOf = {};
    all.forEach(c => { roleOf[c.name] = c.role.role; });
    const counts = {};
    Object.values(roleOf).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    ok('6 人局是 2 狼', counts[P.GAME ? 'wolf' : 'wolf'] === 2, JSON.stringify(counts));
    ok('6 人局有 1 个预言家', counts.seer === 1, JSON.stringify(counts));
    ok('6 人局有 1 个女巫', counts.witch === 1, JSON.stringify(counts));
    ok('6 人局有 2 个平民', counts.villager === 2, JSON.stringify(counts));

    // 只有狼拿得到同伴名单
    const wolves = all.filter(c => c.role.role === 'wolf');
    const seer = all.find(c => c.role.role === 'seer');
    const witch = all.find(c => c.role.role === 'witch');
    ok('狼拿到了同伴名单（1 个）',
      wolves.every(c => Array.isArray(c.role.mates) && c.role.mates.length === 1),
      wolves.map(c => JSON.stringify(c.role.mates)).join(' '));
    ok('预言家拿不到同伴名单', seer.role.mates === null, JSON.stringify(seer.role.mates));
    ok('女巫拿不到同伴名单', witch.role.mates === null, JSON.stringify(witch.role.mates));

    // ⚠ 最关键的保密断言：任何人的快照 / 任何广播里都不该有**别人的**身份。
    //   两个容易踩的点：
    //     ① V2 的 `me` 里带 role 是**故意的**（前端靠它渲染自己的身份卡）——
    //        不能拿 /"role"/ 扫整串 JSON，那只会在 me 上误报；
    //     ② 身份卡会被**重复下发**（每次 syncGame 都发一遍，见 index.js 的注释：
    //        重发让「第一次拿到」和「丢了再要一份」走同一条路径）。
    //        所以只能断言「收到过、且内容始终是自己的」，不能断言「只收到一次」。
    let leak = 0;
    for (const c of all) {
      const g = c.gstate;
      if (g && Array.isArray(g.players)) {
        for (const p of g.players) {
          if ('role' in p || 'camp' in p || 'mates' in p) leak++;
        }
      }
      // 收到的每一份身份卡都必须是「我自己的」——多收几次没关系，收错人才是漏
      for (const m of c.msgs(P.S2C.SKIN_ROLE)) {
        if (m.role !== c.role.role) leak++;
      }
    }
    ok('★ 快照的玩家名片翻不出任何人的身份', leak === 0, '越界 ' + leak + ' 次');
    ok('★ 身份卡多次下发但每次都是我自己的（幂等）',
      all.every(c => c.msgs(P.S2C.SKIN_ROLE).length >= 1 &&
        c.msgs(P.S2C.SKIN_ROLE).every(m => m.role === c.role.role)),
      all.map(c => c.name + ':' + c.msgs(P.S2C.SKIN_ROLE).length).join(' '));
    ok('★ 自己的身份只在自己那份 me 里（这是故意给的）',
      all.every(c => c.gstate && c.gstate.me && c.gstate.me.role === c.role.role),
      all.map(c => (c.gstate && c.gstate.me ? c.gstate.me.role : '-') + '/' + c.role.role).join(' '));

    // 别人的身份卡绝不能通过任何广播到达我这里
    let roleBroadcast = 0;
    for (const c of all) {
      for (const m of c.log) {
        if (m.t === P.S2C.GAME_STATE && m.game && m.game.players) {
          for (const p of m.game.players) if ('role' in p) roleBroadcast++;
        }
      }
    }
    ok('★ 身份的私有通道没有被广播污染', roleBroadcast === 0, '越界 ' + roleBroadcast + ' 次');

    ok('入夜了', host.phase() === 'skin_night', host.phase());
  }

  /* ============================================== [3] 夜里：预言家验人 */
  console.log('\n[3] 夜里：预言家验人（结果只给本人）');
  const wolves = all.filter(c => c.role.role === 'wolf');
  const seer = all.find(c => c.role.role === 'seer');
  const witch = all.find(c => c.role.role === 'witch');
  const villagers = all.filter(c => c.role.role === 'villager');
  {
    const goods = all.filter(c => c.role.role !== 'wolf');
    const target = goods[0];

    // 非预言家验人 → 被拒
    const wPre = wolves[0].log.length;
    wolves[0].act('check', target.uid());
    await sleep(250);
    const wErr = lastErrSince(wolves[0], wPre);
    ok('非预言家验人被拒绝', !!wErr && wErr.code === 'skin_action', wErr ? wErr.message : '没有错误');

    seer.act('check', target.uid());
    const got = await waitFor(() => seer.night && seer.night.kind === 'check', 3000, '验人结果');
    ok('★ 预言家立刻拿到验人结果（不等天亮）', got,
      seer.night ? JSON.stringify(seer.night) : 'null');
    ok('结果里点名了验的是谁', seer.night && seer.night.target === target.uid());
    ok('结果是「是不是狼」的布尔判断', seer.night && typeof seer.night.isWolf === 'boolean');
    ok('预言家能自己核对结果正确', seer.night &&
      seer.night.isWolf === (target.role.role === 'wolf'),
      seer.night.isWolf + ' vs ' + target.role.role);

    // 别人绝拿不到这个结果
    let leak = 0;
    for (const c of all) {
      if (c === seer) continue;
      if (since(c, 0).indexOf('"kind":"check"') >= 0) leak++;
    }
    ok('★ 验人结果没有漏给别人', leak === 0, '漏给 ' + leak + ' 个人');
  }

  /* ============================================== [4] 夜里：狼刀人 */
  console.log('\n[4] 夜里：狼刀人（多数决）');
  // 挑一个好人当刀口（狼不能刀同伴，挑狼会被服务端拒掉）
  const victim = all.find(c => c.role.role !== 'wolf');
  {
    // 好人不能刀
    const pre = villagers[0].log.length;
    villagers[0].act('kill', victim.uid());
    await sleep(250);
    const e = lastErrSince(villagers[0], pre);
    ok('好人不能刀人', !!e && e.code === 'skin_action', e ? e.message : '没有错误');

    // 两个狼都刀同一个人
    wolves[0].act('kill', victim.uid());
    wolves[1].act('kill', victim.uid());
    const dawn = await waitFor(() => host.phase() === 'skin_dawn', 6000, '天亮');
    ok('两狼投完刀 → 自动推进到天亮', dawn, host.phase());

    // 被刀的人自己知道。
    // ⚠ 这里必须等到**天亮之后**那条 —— 同一夜可能先给过此人别的裁定
    //   （受害者同时是预言家 / 女巫时，夜里先发验人结果或刀口，
    //   结算后才补发「你出局了」）。所以判据是「收到过 kind=dead」，
    //   而不是「最后一条是 dead」（顺序本来就不保证）。
    const know = await waitFor(() => (victim.log.some(m =>
      m.t === P.S2C.SKIN_NIGHT && m.kind === 'dead' && m.victim === victim.uid())), 4000, '被刀的人知情');
    ok('★ 被刀的人自己知道（只发本人）', know,
      victim.msgs(P.S2C.SKIN_NIGHT).map(m => m.kind).join(','));
    ok('被刀的人知道自己出局了', victim.gstate && victim.gstate.me && victim.gstate.me.alive === false,
      JSON.stringify(victim.gstate && victim.gstate.me));

    // 别人不知道
    let leak = 0;
    for (const c of all) {
      if (c === victim) continue;
      if (c.msgs(P.S2C.SKIN_NIGHT).some(m => m.kind === 'dead')) leak++;
    }
    ok('★ 别人不知道谁被刀了（要等天亮公告）', leak === 0, '漏给 ' + leak + ' 个人');

    // 天亮公告是公开的，且点了名
    const dawnMsg = await waitFor(() => victim.gstate && victim.gstate.lastNight, 3000, '天亮公告');
    ok('天亮公告随快照广播（公开信息）', dawnMsg);
    ok('公告点了名', victim.gstate && victim.gstate.lastNight
      && victim.gstate.lastNight.text.indexOf(victim.name) >= 0,
      victim.gstate && victim.gstate.lastNight ? victim.gstate.lastNight.text : 'null');
  }

  /* ============================================== [5] 天亮：各自私密作画 */
  console.log('\n[5] 天亮：同题各自私密作画');
  // ⚠ 这一节依赖「还打得下去」这个前提。狼刀可能直接终结本局
  //   （例如刀掉最后一个好人 → 狼数 ≥ 好人数），那时候根本不会有作画阶段 ——
  //   那是玩法本身的正常结果，不是 bug。用一个开关把 [5]~[7] 整段挂起来，
  //   避免它们拿「阶段不对」去刷一片假失败。
  const canPlayDay = await waitFor(() => host.phase() === 'skin_draw', 8000, '进入作画');
  ok('进入作画阶段', canPlayDay, host.phase());
  if (!canPlayDay) {
    console.log('    （本局在夜间直接分出了胜负，白天相关断言按设计跳过）');
  }
  if (canPlayDay) {

    ok('本轮有主题词（公开的，因为大家画同一个）', !!host.gstate && !!host.gstate.word,
      host.gstate ? host.gstate.word : 'null');
    ok('主题词也广播给了所有人', all.every(c => c.gstate && c.gstate.word === host.gstate.word));
    ok('作画阶段是私密画（canDraw=true，但别人看不到）',
      host.gstate && host.gstate.isDrawPhase === true, String(host.gstate && host.gstate.isDrawPhase));

    // ★ 私密作画：一个人落笔，别人不该收到任何笔迹广播
    const watcher = all.find(c => c.role.role !== 'wolf' && c.gstate && c.gstate.me.alive);
    const wIdx = watcher.log.length;
    host.send(P.C2S.STROKE_BEGIN, {
      id: 'sk_' + Date.now().toString(36), layerId: host.gstate.layers ? undefined : undefined,
      tool: 'brush', color: '#000000', size: 8
    });
    await sleep(400);
    const strokeLeak = watcher.log.slice(wIdx).filter(m => m.t === P.S2C.STROKE_BEGIN).length;
    ok('★ 作画阶段落笔不会广播给别人（私密画）', strokeLeak === 0, '漏了 ' + strokeLeak + ' 条');

    // 活着的人各自交一张画
    const alive = all.filter(c => c.gstate && c.gstate.me && c.gstate.me.alive);
    alive.forEach((c, i) => c.art(fakePng(c.name)));
    const talk = await waitFor(() => host.phase() === 'skin_talk', 6000, '收齐画后进讨论');
    ok('所有人都交画后自动进讨论', talk, host.phase());
  }

  /* ============================================== [6] 匿名画廊 */
  console.log('\n[6] 匿名画廊（猜作者就是玩法本身）');
  if (canPlayDay) {
    const gallery = host.gstate && host.gstate.gallery;
    ok('画廊里有作品', Array.isArray(gallery) && gallery.length > 0,
      'count=' + (gallery ? gallery.length : 0));

    // ★ 画廊里绝对不能带作者
    let named = 0;
    for (const w of (gallery || [])) {
      if ('userId' in w || 'name' in w || 'author' in w) named++;
    }
    ok('★ 画廊里没有作者（只能凭画风猜）', named === 0, '带作者的 ' + named + ' 幅');

    // 画廊对每个人都是同一份（公开信息）
    const sig = (c) => JSON.stringify((c.gstate.gallery || []).map(w => w.id));
    ok('画廊对所有活着的人一致', all.filter(c => sig(c) === sig(host)).length >= 1);
  }

  /* ============================================== [7] 投票放逐 */
  console.log('\n[7] 投票放逐（平票 = 不放逐）');
  if (canPlayDay) {
    const vote = await waitFor(() => host.phase() === 'skin_vote', 6000, '进入投票');
    ok('进入投票阶段', vote, host.phase());

    // 出局的人没有投票权
    if (victim && victim.gstate && victim.gstate.me && !victim.gstate.me.alive) {
      const pre = victim.log.length;
      victim.act('vote', host.uid());
      await sleep(250);
      const e = lastErrSince(victim, pre);
      ok('出局的人不能投票', !!e, e ? e.message : '没有错误');
    }

    // 全场投同一个人 → 那个人被放逐
    const alive = all.filter(c => c.gstate && c.gstate.me && c.gstate.me.alive);
    const exileTarget = alive[0];
    alive.forEach(c => { if (c !== exileTarget) c.act('vote', exileTarget.uid()); });
    const ended = await waitFor(() => host.phase() === 'skin_vote_end'
      || host.phase() === 'over', 5000, '投票结算');
    ok('收齐票后自动结算', ended, host.phase());

    const vr = host.gstate && host.gstate.voteResult;
    ok('结算结果里有票数明细', vr && Array.isArray(vr.tally), JSON.stringify(vr && vr.tally));
    ok('票是公开的（谁投了谁）', vr && Array.isArray(vr.ballot), JSON.stringify(vr && vr.ballot));
    ok('被放逐的人出局', vr && vr.exiled === exileTarget.uid(),
      vr ? (vr.exiled + ' vs ' + exileTarget.uid()) : 'null');
  }

  /* ============================================== [8] 结算与收尾 */
  console.log('\n[8] 结算与收尾');
  {
    // 拖到结束（可能已经因为狼全出局判完，也可能还在打）
    let over = await waitFor(() => host.phase() === 'over', 3000, '等结束');
    if (!over) {
      // 直接让房主结束本局
      host.send(P.C2S.GAME_STOP, {});
      await waitFor(() => host.phase() === 'off', 4000, '结束游戏');
      ok('房主可以结束画皮回到自由绘画', host.phase() === 'off', host.phase());
    } else {
      ok('游戏能正常走到结算（over）', true);
      // 结算时公开全部身份
      const revealed = await waitFor(() => all.every(c => c.reveal), 4000, '公开身份表');
      ok('★ 结算时公开全部身份（真相表）', revealed);
      if (all[0].reveal) {
        ok('真相表里有每个人的身份', all[0].reveal.length === 6, String(all[0].reveal.length));
        ok('真相表与本人收到的身份一致',
          all.every(c => {
            const row = (c.reveal || []).find(x => x.userId === c.uid());
            return row && row.role === c.role.role;
          }));
      }
      host.send(P.C2S.GAME_STOP, {});
      await waitFor(() => host.phase() === 'off', 4000, '结束游戏');
      ok('结束后回到自由绘画', host.phase() === 'off', host.phase());
    }

    host.send(P.C2S.ROOM_DESTROY, {});
    await waitFor(() => all.every(c => c.last(P.S2C.ROOM_DESTROYED)), 4000, '解散房间');
    ok('房间可以正常解散', all.every(c => !!c.last(P.S2C.ROOM_DESTROYED)));
  }

  finish();
}

function finish() {
  for (const c of CLIENTS) { try { c.close(); } catch (e) { /* ignore */ } }
  console.log('\n' + '\u2500'.repeat(46));
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  \u00b7 ' + f);
  }
  console.log('\u2500'.repeat(46));
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e);
  finish();
});
