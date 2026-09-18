/**
 * 茶绘 · 你画我猜端到端验收（虚拟客户端，不需要浏览器）
 *
 * 用法：
 *   GAME_PICK_MS=1500 GAME_ROUND_MS=2500 GAME_ROUND_END_MS=800 \
 *     PORT=8444 node server/src/index.js          # 另起一个专用端口
 *   node tools/test-game.js ws://localhost:8444/ws
 *
 * 覆盖的断言分三类：
 *   ① 流程：开局 → 选词 → 作画+猜 → 回合结算 → 下一回合 / 结束
 *   ② 权限：非房主不能开局、非画手不能选词、非画手落笔被服务端拒绝
 *   ③ 保密：答案不出现在任何非画手收到的消息里（这是这类游戏唯一的死穴）
 */
'use strict';

const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = (function () {
  // 可以直接给 ws://…，也可以给 http://host:port（跑批里统一传的是 http 基址）
  const a = process.argv[2] || 'ws://localhost:8437/ws';
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
    failures.push(name + (extra ? ' → ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' → ' + extra : ''));
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 轮询等待：服务端挪目录 / 存盘 / 压消息都和游戏时钟在同一个事件循环里排队，
 *  固定 sleep 必然变成随机 flaky（这个项目已经栽过一次）。 */
async function waitFor(cond, timeout, label) {
  const t0 = Date.now();
  const limit = timeout || 5000;
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
    gstate: null,     // 我收到的最新一份游戏快照（已经按我裁剪过）
    word: '',         // 我作为画手收到的明文答案
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
    if (m.t === P.S2C.GAME_WORD) c.word = m.word;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  c.phase = () => (c.gstate ? c.gstate.phase : '');
  c.close = () => ws.close();
  return c;
}

/** 这个客户端见过的所有消息里的文字（用来查答案有没有漏出去） */
function allText(c) {
  return JSON.stringify(c.log);
}

function strokeInfo(id, over) {
  return Object.assign({
    id: id, layerId: '', tool: 'brush', color: '#ff0000', size: 12, opacity: 1, seed: 7
  }, over || {});
}

async function main() {
  const roomId = 'gtest_' + Date.now().toString(36).slice(-6);
  console.log('你画我猜 · 端到端验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  /* -------- 先问清楚「端口上这台服务端是谁」 --------
   * 这个脚本要的是「压缩计时 + 指定词库」的服务端。端口上如果还挂着上一次
   * 遗留的进程，新起的那个会 EADDRINUSE 秒退，而这个脚本照样跑得动 ——
   * 于是可能拿着别的词库跑出一片绿，纯属假绿。所以先验身份再开工。 */
  const info = await httpJson('/api/share');
  if (!info || !info.game) {
    console.log('无法从 ' + httpBase() + '/api/share 读到服务端信息，请先在该端口启动服务端：');
    console.log('  GAME_PICK_MS=1500 GAME_ROUND_MS=2500 GAME_ROUND_END_MS=800 PORT=8444 node server/src/index.js');
    process.exit(1);
  }
  console.log('服务端 pid=' + info.pid + '  计时 ' + info.game.PICK_MS + '/' + info.game.ROUND_MS
    + '/' + info.game.ROUND_END_MS + 'ms  词库 ' + info.words + ' 词\n');
  if (info.game.ROUND_MS >= 10000) {
    console.log('✗ 这台服务端用的是默认计时（ROUND_MS=' + info.game.ROUND_MS + ' ms，一局要等'
      + Math.round(info.game.ROUND_MS / 1000) + ' 秒），不是测试用的压缩计时。');
    console.log('  多半是端口上还挂着一个旧的服务端进程 —— 先把它停掉，再用上面的命令重开一个。');
    process.exit(1);
  }

  const A = Client('房主');
  const B = Client('小红');
  const C = Client('小明');

  if (!await waitFor(() => A.open && B.open && C.open, 5000, '连接建立')) {
    console.log('无法连接到 ' + URL_ + '，请先在目标端口启动服务端。');
    process.exit(1);
  }

  /* ---------------- 建房 ---------------- */
  console.log('[1] 房间与成员');
  A.send(P.C2S.ROOM_CREATE, { id: roomId, name: '游戏验收室', user: '房主' });
  ok('房主建好房间', await waitFor(() => A.room && A.room.id === roomId, 4000, 'ROOM_JOINED'));
  B.send(P.C2S.ROOM_JOIN, { roomId, user: '小红' });
  C.send(P.C2S.ROOM_JOIN, { roomId, user: '小明' });
  const all3 = await waitFor(() => {
    const m = A.last(P.S2C.MEMBERS);
    return m && m.members.length === 3;
  }, 5000, '3 人成员表');
  ok('三人都在房间里', all3);
  ok('房间默认不是游戏模式', !!A.gstate === false || A.gstate.phase === 'off',
    'gstate=' + JSON.stringify(A.gstate && A.gstate.phase));

  /* ---------------- 开局权限 ---------------- */
  console.log('\n[2] 开局权限');
  B.send(P.C2S.GAME_START, { rounds: 2 });
  const denied = await waitFor(() => {
    const e = B.last(P.S2C.ERROR);
    return e && e.code === 'not_owner';
  }, 3000, '非房主开局被拒');
  ok('非房主开局被拒绝', denied);
  ok('被拒后房间仍未开局', !B.gstate || B.gstate.phase === 'off');

  /* ---------------- 开局 ---------------- */
  console.log('\n[3] 开局与选词');
  A.send(P.C2S.GAME_START, { rounds: 2, drawSeconds: 60 });   // 作画时限放宽到 60s：后面的聊天/撤回断言不用跟 2.5s 的压缩回合抢时间
  const started = await waitFor(() => A.gstate && (A.phase() === 'pick' || A.phase() === 'draw'), 4000, '开局');
  ok('房主开局成功', started);

  const clients = [A, B, C];
  const drawer = clients.find(c => c.gstate && c.gstate.isDrawer);
  const others = clients.filter(c => c !== drawer);
  ok('恰好有一个画手', !!drawer && clients.filter(c => c.gstate && c.gstate.isDrawer).length === 1,
    'drawer=' + (drawer && drawer.name));
  ok('画手不是房主也没关系，但状态里标明了身份', !!drawer);

  // 每人都收到了快照
  ok('三个人都收到了游戏状态', clients.every(c => !!c.gstate));
  // 非画手拿不到候选词（候选词一旦泄露，答案范围就只剩三个）
  ok('非画手拿不到候选词',
    others.every(c => !c.gstate || !c.gstate.choices || c.gstate.choices.length === 0));

  // 非画手选词被拒
  others[0].send(P.C2S.GAME_PICK, { index: 0 });
  const pickDenied = await waitFor(() => {
    const e = others[0].last(P.S2C.ERROR);
    return e && /只有画手/.test(e.message || '');
  }, 3000, '非画手选词被拒');
  ok('非画手不能选词', pickDenied);

  // 画手选词（也可能是「候选只有一个词，直接开始」的情况）
  let word = '';
  if (drawer.gstate.phase === 'pick') {
    const choices = drawer.gstate.choices || [];
    ok('画手拿到了 ' + P.GAME.CHOICES + ' 个候选词', choices.length === P.GAME.CHOICES,
      'choices=' + choices.length);
    drawer.send(P.C2S.GAME_PICK, { index: 0 });
    word = choices[0] || '';
  } else {
    word = drawer.word;
    ok('候选唯一，已直接进入作画', true);
  }
  const drawing = await waitFor(() => drawer.phase() === 'draw' && drawer.word, 4000, '进入作画阶段');
  ok('进入作画阶段', drawing);
  word = drawer.word || word;
  ok('画手拿到了明文答案', !!word, 'word=' + JSON.stringify(word));

  /* ---------------- 保密 ---------------- */
  console.log('\n[4] 答案保密（这类游戏唯一的死穴）');
  ok('猜手的状态里 word 是空的',
    others.every(c => !c.gstate || c.gstate.word === ''),
    others.map(c => c.name + '=' + JSON.stringify(c.gstate && c.gstate.word)).join(' '));
  ok('猜手只知道字数',
    others.every(c => c.gstate && c.gstate.wordLen === word.length),
    others.map(c => c.name + '=' + (c.gstate && c.gstate.wordLen)).join(' '));
  ok('猜手从未收到过 game:word',
    others.every(c => c.msgs(P.S2C.GAME_WORD).length === 0));
  ok('画手的快照里带着明文（他自己当然看得见）',
    drawer.gstate.word === word);
  // 全量扫描：非画手收到的每一条消息里都不该出现这个答案
  const leaked = others.filter(c => allText(c).includes(word)).map(c => c.name);
  ok('答案没有出现在任何非画手收到的消息里', leaked.length === 0, '泄露给: ' + leaked.join(','));

  /* ---------------- 落笔权限 ---------------- */
  console.log('\n[5] 落笔权限（服务端强制，不是前端禁用）');
  const gid = 's-guest-1';
  others[0].send(P.C2S.STROKE_BEGIN, strokeInfo(gid));
  others[0].send(P.C2S.STROKE_POINTS, { id: gid, pts: [[10, 10, 0.5], [80, 80, 0.5]] });
  others[0].send(P.C2S.STROKE_END, { id: gid });
  await sleep(400);
  ok('猜手的落笔没有被广播出去',
    drawer.msgs(P.S2C.STROKE_BEGIN).length === 0 && others[1].msgs(P.S2C.STROKE_BEGIN).length === 0,
    'drawer收到 ' + drawer.msgs(P.S2C.STROKE_BEGIN).length + ' 条');
  others[0].send(P.C2S.LAYER_ADD, { name: '偷加的图层' });
  ok('猜手加图层被拒绝（game_locked）',
    await waitFor(() => {
      const e = others[0].last(P.S2C.ERROR);
      return e && e.code === 'game_locked';
    }, 3000, 'game_locked'));

  const did = 's-drawer-1';
  drawer.send(P.C2S.STROKE_BEGIN, strokeInfo(did));
  drawer.send(P.C2S.STROKE_POINTS, { id: did, pts: [[20, 20, 0.5], [120, 90, 0.5]] });
  drawer.send(P.C2S.STROKE_END, { id: did });
  ok('画手可以正常落笔', await waitFor(() => drawer.msgs(P.S2C.STROKE_END).length > 0, 4000, 'stroke:end'));
  ok('画手的笔迹同步给了其他人',
    await waitFor(() => others.every(c => c.msgs(P.S2C.STROKE_BEGIN).length > 0), 4000, '远端收到笔迹'));

  /* ---------------- 猜词 ---------------- */
  console.log('\n[6] 猜词与防剧透');
  const wrongText = '我猜是隔壁老王';
  others[0].send(P.C2S.CHAT, { text: wrongText });
  ok('猜错的发言照常公开（这是乐趣的一部分）',
    await waitFor(() => others[1].last(P.S2C.CHAT) && others[1].msgs(P.S2C.CHAT).some(m => m.text === wrongText), 4000));

  // 画手发言必须被拦下
  const drawerLeak = '我画的其实是' + word;
  drawer.send(P.C2S.CHAT, { text: drawerLeak });
  await sleep(400);
  ok('画手的发言不会广播出去',
    !others[0].msgs(P.S2C.CHAT).some(m => m.text === drawerLeak) &&
    !others[1].msgs(P.S2C.CHAT).some(m => m.text === drawerLeak));
  ok('画手本人收到了「不会发出去」的提示',
    drawer.msgs(P.S2C.CHAT).some(m => m.system && /不会发出去/.test(m.text || '')));

  // 猜对
  others[0].send(P.C2S.CHAT, { text: '  ' + word + '！ ' });   // 故意带空格和标点，考验归一化
  ok('猜对后广播 GAME_CORRECT',
    await waitFor(() => others[1].msgs(P.S2C.GAME_CORRECT).length > 0, 4000, 'GAME_CORRECT'));
  const corr = others[1].last(P.S2C.GAME_CORRECT) || {};
  ok('名次与得分为第一名 100 分', corr.rank === 1 && corr.points === P.GAME.GUESS_POINTS[0],
    'rank=' + corr.rank + ' points=' + corr.points);
  ok('答对的原文没有被广播（只广播「谁猜对了」）',
    !others[1].msgs(P.S2C.CHAT).some(m => m.text === word || m.text === '  ' + word + '！ '));

  const sc = await waitFor(() => {
    const s = others[1].gstate && others[1].gstate.scores || [];
    const me = s.find(x => x.userId === others[0].you.userId);
    return me && me.score === P.GAME.GUESS_POINTS[0];
  }, 4000, '计分');
  ok('计分板显示猜对者的分数', sc);
  const drawerScore = (others[1].gstate.scores || []).find(x => x.userId === drawer.you.userId);
  ok('画手按「被猜出」也拿到分',
    drawerScore && drawerScore.score === P.GAME.DRAWER_POINT_PER_GUESS,
    'drawerScore=' + (drawerScore && drawerScore.score));

  // 已经猜对的人再说话：不带答案照常公开（用户反馈：猜对的人也要能聊天）
  // （发消息之间要隔开 250ms 以上 —— 服务端对刷屏有限流，隔太近会被静默吞掉）
  await sleep(300);
  const guessedChat = '我也给个提示：它生活在草原上';
  others[0].send(P.C2S.CHAT, { text: guessedChat });
  ok('已猜对者不带答案的发言照常公开',
    await waitFor(() => others[1].msgs(P.S2C.CHAT).some(m => m.text === guessedChat), 4000, '广播'));

  // 带答案（整词）的发言仍然拦下 —— 画手和已猜对者一视同仁
  await sleep(300);
  const guessedLeak = '答案是' + word + '啦';
  others[0].send(P.C2S.CHAT, { text: guessedLeak });
  await sleep(400);
  ok('已猜对者带答案的发言被拦下',
    !others[1].msgs(P.S2C.CHAT).some(m => m.text === guessedLeak));

  // 把答案的每个字都拼进消息也算泄题（比如「长呀颈鹿」），整词没连着出现也要拦
  await sleep(300);
  const scattered = word.slice(0, 1) + '呀' + word.slice(1);
  drawer.send(P.C2S.CHAT, { text: scattered });
  await sleep(400);
  ok('答案的字全出现（没连着写）也被拦下',
    !others.some(c => c.msgs(P.S2C.CHAT).some(m => m.text === scattered)),
    'scattered=' + JSON.stringify(scattered));

  // 画手给普通提示：话里不带答案 → 正常广播（用户反馈：画手要能聊天给提示）
  const drawerHint = '画个提示：脖子上长着毛';
  drawer.send(P.C2S.CHAT, { text: drawerHint });
  ok('画手不带答案的提示会广播出去',
    await waitFor(() => others.every(c => c.msgs(P.S2C.CHAT).some(m => m.text === drawerHint)),
      4000, '提示广播'));

  /* ---------------- 回合结算 ---------------- */
  console.log('\n[7] 回合结算与下一回合');
  others[1].send(P.C2S.CHAT, { text: word });          // 最后一个人也猜对 → 本回合结束
  const ended = await waitFor(() => others[0].phase() === 'round_end', 5000, 'round_end');
  ok('全部猜对后立刻进入结算', ended);
  const rr = (others[0].gstate && others[0].gstate.roundResult) || {};
  ok('结算里公开了答案', rr.word === word, 'word=' + JSON.stringify(rr.word));
  ok('结算原因标记为 all', rr.reason === 'all', 'reason=' + rr.reason);
  ok('结算里列出了猜对的人', Array.isArray(rr.guessed) && rr.guessed.length === 2,
    'guessed=' + ((rr.guessed || []).length));

  // round_end 对所有人 lockedFor=true —— 但画手收拾自己刚画的笔迹必须放行（用户实测反馈）
  const lockedErrsBefore = drawer.msgs(P.S2C.ERROR).filter(e => e.code === 'game_locked').length;
  drawer.send(P.C2S.STROKE_UNDO, { ids: [did] });
  const undoOk = await waitFor(() =>
    others.some(c => c.msgs(P.S2C.STROKE_REMOVED).some(
      m => m.reason === 'undo' && (m.ids || []).indexOf(did) >= 0)), 4000, '结算阶段撤回');
  ok('结算阶段画手撤回自己的笔迹被放行', undoOk);
  ok('画手撤回没有收到 game_locked 错误',
    drawer.msgs(P.S2C.ERROR).filter(e => e.code === 'game_locked').length === lockedErrsBefore);

  const nextRound = await waitFor(() => (others[0].phase() === 'pick' || others[0].phase() === 'draw') &&
    others[0].gstate.round === 2, 8000, '第 2 回合');
  ok('自动进入第 2 回合', nextRound, 'phase=' + others[0].phase() + ' round=' + (others[0].gstate && others[0].gstate.round));
  ok('回合切换时画布被清空', await checkRoomStrokes(roomId, 0),
    '第 2 回合开始时房间笔迹应为 0');
  ok('第 2 回合重新分配了画手', !!clients.find(c => c.gstate && c.gstate.isDrawer));

  /* ---------------- 结束游戏 ---------------- */
  console.log('\n[8] 结束游戏与恢复自由绘画');
  A.send(P.C2S.GAME_STOP, {});
  const stopped = await waitFor(() => clients.every(c => c.phase() === 'off'), 5000, 'phase=off');
  ok('房主结束游戏后回到自由绘画', stopped);
  const fid = 's-after-game';
  others[0].send(P.C2S.STROKE_BEGIN, strokeInfo(fid));
  others[0].send(P.C2S.STROKE_POINTS, { id: fid, pts: [[30, 30, 0.5]] });
  others[0].send(P.C2S.STROKE_END, { id: fid });
  ok('游戏结束后所有人恢复落笔权限',
    await waitFor(() => others[1].msgs(P.S2C.STROKE_END).some(m => m.id === fid), 4000, '恢复落笔'));

  /* ---------------- 超时自动推进 ---------------- */
  console.log('\n[9] 超时自动推进（没人选词 / 没人猜对）');
  A.send(P.C2S.GAME_START, { rounds: 1 });
  const r2 = await waitFor(() => A.gstate && (A.phase() === 'pick' || A.phase() === 'draw'), 5000, '第 3 局开局');
  ok('重新开局成功', r2);
  // 谁都不选词 → 服务端应自动挑一个
  const auto = await waitFor(() => clients.some(c => c.phase() === 'draw'), 8000, '自动选词');
  ok('选词超时后服务端自动选词', auto, 'phase=' + A.phase());
  const drawer3 = clients.find(c => c.gstate && c.gstate.isDrawer);
  ok('自动选词后画手仍拿到明文', !!(drawer3 && drawer3.word), 'word=' + (drawer3 && drawer3.word));
  // 谁都不猜 → 作画超时
  ok('作画超时后进入结算',
    await waitFor(() => A.phase() === 'round_end', 12000, 'timeout 结算'));
  ok('超时结算的原因标记为 timeout',
    ((A.gstate && A.gstate.roundResult) || {}).reason === 'timeout',
    'reason=' + ((A.gstate && A.gstate.roundResult) || {}).reason);
  ok('1 回合打完后整局结束',
    await waitFor(() => A.phase() === 'over', 8000, 'phase=over'));
  ok('结束时给出排名',
    Array.isArray(A.gstate.scores) && A.gstate.scores.length === 3 &&
    A.gstate.scores.every(s => typeof s.rank === 'number'));

  /* ---------------- 露字提示 ---------------- */
  console.log('\n[10] 露字提示（过半还没人猜出，服务端自动露一个字）');
  {
    const all = [A, B, C];
    all.forEach(c => { c.word = ''; });     // 清掉上一局的明文，下面的 word 才是这一局的
    A.send(P.C2S.GAME_START, { rounds: 1 });
    // 谁都不选词 → 服务端自动挑；然后谁都不猜 → 等提示、等超时
    // ⚠️ 必须等三端都刷到「作画阶段」再判身份：只等「有人进 draw」的话，
    //    另外两端的 gstate 可能还是上一局的旧快照（旧快照里 isDrawer / word 都是过期的，
    //    会认错画手、把上一局的词当成这一局的词）
    const allDraw = await waitFor(() => all.every(c => c.phase() === 'draw'), 9000, '三端都进作画');
    ok('三端都进入作画阶段', allDraw);
    const drawers = all.filter(c => c.gstate && c.gstate.isDrawer);
    ok('恰好只有一个画手', drawers.length === 1, 'isDrawer 数=' + drawers.length);
    const drawer = drawers[0];
    const guesser = all.find(c => c !== drawer);
    ok('认出画手和猜手', !!drawer && !!guesser);

    // 保密要在「还在作画」的这一刻判 —— 等回合结算之后再看就没意义了
    // （结算时答案本来就公开，快照里当然有 word）
    ok('猜手在作画中看不到明文（只有字数）',
      !!guesser && guesser.gstate.phase === 'draw' && !guesser.gstate.word,
      'phase=' + (guesser && guesser.gstate.phase) + ' word=' + JSON.stringify(guesser && guesser.gstate.word));
    ok('画手自己拿得到明文', !!(drawer && drawer.word), 'word=' + (drawer && drawer.word));

    // 回合多长从快照里现算（deadline − serverNow），不依赖本测试进程的 env
    const roundMs = Math.max(600, (drawer.gstate.deadline || 0) - (drawer.gstate.serverNow || 0));
    const chatBefore = A.msgs(P.S2C.CHAT).length;
    // 提示在回合过半时给：等它出现，或者回合直接进结算
    await waitFor(() => {
      const gs = guesser.gstate;
      return !!(gs && gs.hint) || gs.phase === 'round_end';
    }, Math.round(roundMs * 0.8) + 1800, '等提示');

    const word = drawer.word || '';
    const hint = (guesser.gstate && guesser.gstate.hint) || null;
    // 只看这一回合新增的播报，别把之前的聊天捞进来
    const hintChat = A.msgs(P.S2C.CHAT).slice(chatBefore)
      .filter(m => m.system && String(m.text).indexOf('提示') >= 0).pop();

    if (word.length >= P.GAME.HINT_MIN_LEN) {
      ok('长词（≥' + P.GAME.HINT_MIN_LEN + ' 字）过半会露一个字', !!hint,
        'word=' + word + ' len=' + word.length);
      if (hint) {
        ok('露的那一位与真字对得上', hint.char === word[hint.index],
          'hint=' + JSON.stringify(hint) + ' word=' + word);
        ok('提示只带位置和单字，不带整个词',
          Object.keys(hint).sort().join(',') === 'char,index'
          && JSON.stringify(hint).indexOf(word) < 0, JSON.stringify(hint));
      }
      ok('提示有系统播报', !!hintChat, hintChat ? hintChat.text : '(没有)');
      if (hintChat && hint) {
        const blanks = (String(hintChat.text).match(/□/g) || []).length;
        ok('播报里的提示串只露一个字，其余仍是 □', blanks === word.length - 1,
          'text=' + hintChat.text + ' word=' + word + ' □数=' + blanks);
      }
    } else {
      // 两字词露一个等于给一半，服务端本来就不该给
      ok('短词不给露字提示', !hint, 'word=' + word + ' hint=' + JSON.stringify(hint));
      ok('短词也不会因此冒出「提示」播报', !hintChat, hintChat && hintChat.text);
    }

    ok('没人猜对，作画超时进结算',
      await waitFor(() => A.phase() === 'round_end' || A.phase() === 'over', 12000, 'timeout'));
    if (A.phase() === 'round_end') await waitFor(() => A.phase() === 'over', 8000, 'over');
  }

  /* ---------------- 换一组候选词 ---------------- */
  console.log('\n[11] 画手可以换一组候选词（每回合限次）');
  {
    const all = [A, B, C];
    all.forEach(c => { c.word = ''; });
    A.send(P.C2S.GAME_START, { rounds: 1 });
    // 等到「画手拿到了候选词、且另外那位的快照也已经刷到选词阶段」——
    // 只等单端会把上一局的旧快照当成这一局的（旧快照里 choices 恒为空，断言会假通过）
    const ready = await waitFor(() => {
      const dd = all.find(c => c.gstate && c.gstate.phase === 'pick' && (c.gstate.choices || []).length > 0);
      if (!dd) return false;
      const gg = all.find(c => c !== dd);
      return !!(gg.gstate && gg.gstate.phase === 'pick');
    }, 6000, '选词阶段就绪');
    ok('新的一局开起来了，画手拿到候选词', ready);

    const d = all.find(c => c.gstate && c.gstate.phase === 'pick' && (c.gstate.choices || []).length > 0);
    const g = all.find(c => c !== d);
    ok('画手拿到了 ' + P.GAME.CHOICES + ' 个候选词',
      !!(d && d.gstate.choices && d.gstate.choices.length === P.GAME.CHOICES),
      JSON.stringify(d && d.gstate.choices));
    ok('画手一开始有 ' + P.GAME.REPICK_LIMIT + ' 次换词机会',
      d.gstate.repickLeft === P.GAME.REPICK_LIMIT, 'repickLeft=' + d.gstate.repickLeft);
    ok('猜手既看不到候选词，也看不到换词次数',
      g.gstate.choices.length === 0 && !g.gstate.repickLeft,
      'choices=' + JSON.stringify(g.gstate.choices) + ' repickLeft=' + g.gstate.repickLeft);

    const errsBefore = g.msgs(P.S2C.ERROR).length;
    g.send(P.C2S.GAME_REPICK, {});
    ok('非画手换词被服务端拒绝', await waitFor(() =>
      g.msgs(P.S2C.ERROR).slice(errsBefore).some(e => e.code === 'game_repick')));
    ok('被拒之后画手的候选词没有被换掉',
      d.gstate.choices.length === P.GAME.CHOICES && d.gstate.repickLeft === P.GAME.REPICK_LIMIT);

    d.send(P.C2S.GAME_REPICK, {});
    ok('画手换一组成功（次数用掉，且仍在选词阶段）',
      await waitFor(() => d.gstate.phase === 'pick' && d.gstate.repickLeft === 0),
      'phase=' + d.gstate.phase + ' repickLeft=' + d.gstate.repickLeft);
    ok('换完还是 ' + P.GAME.CHOICES + ' 个候选词',
      d.gstate.phase === 'pick' && d.gstate.choices.length === P.GAME.CHOICES,
      'phase=' + d.gstate.phase + ' choices=' + JSON.stringify(d.gstate.choices));

    const errsBefore2 = d.msgs(P.S2C.ERROR).length;
    d.send(P.C2S.GAME_REPICK, {});
    ok('超过次数再换被拒绝', await waitFor(() =>
      d.msgs(P.S2C.ERROR).slice(errsBefore2).some(e => e.code === 'game_repick')));

    d.send(P.C2S.GAME_PICK, { index: 0 });
    ok('换完能正常选中、开始作画', await waitFor(() => A.phase() === 'draw', 5000, 'draw'));
    A.send(P.C2S.GAME_STOP, {});
    ok('结束这一局，回到自由绘画', await waitFor(() => A.phase() === 'off', 5000, 'off'));
  }

  /* ---------------- 开局设置：主题词库 + 自定义作画时长 ---------------- */
  console.log('\n[12] 开局设置（主题词库 + 作画时限）');
  {
    // 词池纯函数：给了池就必须从池里取
    const THEMES = require('../server/src/themes');
    const W = require('../server/src/words');
    const pool = THEMES.wordsOf('genshin');
    ok('主题词池非空（genshin）', Array.isArray(pool) && pool.length > 0, pool && pool.length);
    const picks = W.pickChoices(P.GAME.CHOICES, [], pool);
    ok('pickChoices 按池取词',
      picks.length === P.GAME.CHOICES && picks.every(w => pool.indexOf(w) >= 0),
      JSON.stringify(picks));

    // 线上：快照要带出本局的词库与作画时限
    A.send(P.C2S.GAME_START, { rounds: 1, theme: 'genshin', drawSeconds: 45 });
    const started = await waitFor(() => A.phase() === 'pick' || A.phase() === 'draw', 5000, '开局');
    ok('带设置开局成功', started);
    ok('快照带出主题 id 与名称',
      A.gstate.theme === 'genshin' && !!A.gstate.themeName,
      'theme=' + A.gstate.theme + ' name=' + A.gstate.themeName);
    ok('快照带出自定义作画时长（45 秒）',
      A.gstate.drawSeconds === 45, 'drawSeconds=' + A.gstate.drawSeconds);
    // 注意：CHAHU_WORDS 环境变量优先级高于主题词库（words.js 的约定，测试靠它固定答案），
    // 所以这里**不**断言答案真的来自 genshin —— 池子选择已被上面的纯函数断言覆盖
    A.send(P.C2S.GAME_STOP, {});
    ok('停局', await waitFor(() => A.phase() === 'off', 5000, 'off'));

    A.send(P.C2S.GAME_START, { rounds: 1, drawSeconds: 99999 });
    await waitFor(() => A.phase() === 'pick' || A.phase() === 'draw', 5000);
    ok('超上限的作画时长被收到 300 秒',
      A.gstate.drawSeconds === 300, 'drawSeconds=' + A.gstate.drawSeconds);
    A.send(P.C2S.GAME_STOP, {});
    await waitFor(() => A.phase() === 'off', 5000);

    A.send(P.C2S.GAME_START, { rounds: 1, drawSeconds: 3 });
    await waitFor(() => A.phase() === 'pick' || A.phase() === 'draw', 5000);
    ok('低于下限的作画时长被抬到 30 秒',
      A.gstate.drawSeconds === 30, 'drawSeconds=' + A.gstate.drawSeconds);
    A.send(P.C2S.GAME_STOP, {});
    ok('停局', await waitFor(() => A.phase() === 'off', 5000, 'off'));
  }

  /* ---------------- 单字答案不该被判「接近」 ---------------- */
  console.log('\n[13] 单字答案不再误报「很接近了」（纯协议函数）');
  // 单字答案的编辑距离恒为 1，以前猜任何字都会回一句「很接近了」——既谎报又泄题。
  // 词库里也不该再有单字词（words.js 启动时自检会拦）。
  ok('单字答案不再被判「接近」', P.isNearGuess('狗', '猫') === false,
    '狗 vs 猫 = ' + P.isNearGuess('狗', '猫'));
  ok('两字答案的正常近似仍然生效', P.isNearGuess('猫咪', '猫喵') === true,
    '猫咪 vs 猫喵 = ' + P.isNearGuess('猫咪', '猫喵'));
  ok('词库里没有单字词', require('../server/src/words.js').WORDS.every(w => w.length >= 2));

  /* ---------------- 「换一组」不许跳词库（#2 回归） ---------------- */
  console.log('\n[15] 换一组 · 候选词必须留在本局的主题词池里');
  // 曾经的 bug：repick() 调 WORDS.pickChoices 时漏了第 3 个参数（主题词池），
  // 于是「换一组」换出来的候选悄悄掉回通用词库 —— 不报错、流程照走，
  // 只有词变了，肉眼还以为是随机。这条用例专门把它钉死。
  {
    const THEMES = require('../server/src/themes');
    const pool = THEMES.wordsOf('genshin');
    if (info.words) {
      // CHAHU_WORDS 的优先级高于主题词库（words.js 的约定，别的用例靠它固定答案），
      // 这台服务端不是主题词库模式，线上词池断言不适用。
      console.log('    （服务端用 CHAHU_WORDS 覆盖了词库，线上词池断言不适用，跳过）');
    } else {
      const all = [A, B, C];
      all.forEach(c => { c.word = ''; });
      A.send(P.C2S.GAME_START, { rounds: 1, theme: 'genshin' });
      const pickReady = await waitFor(() => {
        const dd = all.find(c => c.gstate && c.gstate.phase === 'pick' && (c.gstate.choices || []).length > 0);
        return !!dd;
      }, 4000, '带主题的选词阶段');
      ok('带主题开局能进到选词阶段', pickReady);
      const d = all.find(c => c.gstate && c.gstate.phase === 'pick' && (c.gstate.choices || []).length > 0) || A;
      ok('快照里带的就是本局主题', !!d.gstate && d.gstate.theme === 'genshin',
        'theme=' + (d.gstate && d.gstate.theme));
      const before = (d.gstate.choices || []).slice();
      ok('开局候选词全部出自本局主题词池',
        before.length === P.GAME.CHOICES && before.every(w => pool.indexOf(w) >= 0),
        'pool=genshin(' + pool.length + ') got=' + JSON.stringify(before));
      ok('画手还有换词次数', d.gstate.repickLeft === P.GAME.REPICK_LIMIT,
        'repickLeft=' + d.gstate.repickLeft);

      d.send(P.C2S.GAME_REPICK, {});
      const repicked = await waitFor(() =>
        d.gstate.phase === 'pick' && d.gstate.repickLeft === 0
        && (d.gstate.choices || []).length === P.GAME.CHOICES, 4000, '换一组');
      ok('换一组成功', repicked, 'repickLeft=' + (d.gstate && d.gstate.repickLeft));
      const after = (d.gstate.choices || []).slice();
      ok('★ 换一组之后候选词仍未跳出主题词池（#2 回归）',
        after.length === P.GAME.CHOICES && after.every(w => pool.indexOf(w) >= 0),
        'pool=genshin(' + pool.length + ') got=' + JSON.stringify(after));
      ok('换一组确实换掉了词（不是原样返回）',
        after.length === P.GAME.CHOICES && after.some(w => before.indexOf(w) < 0),
        'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));

      A.send(P.C2S.GAME_STOP, {});
      ok('停局', await waitFor(() => A.phase() === 'off', 5000, 'off'));
    }
  }

  /* ---------------- 收尾 ---------------- */
  console.log('\n[16] 收尾');
  A.send(P.C2S.ROOM_DESTROY, {});
  ok('房间可以正常解散', await waitFor(() => clients.every(c => c.msgs(P.S2C.ROOM_DESTROYED).length > 0), 5000));
  clients.forEach(c => c.close());

  console.log('\n' + '─'.repeat(46));
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (fail) {
    console.log('  失败项：');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('─'.repeat(46));
  process.exit(fail ? 1 : 0);
}

/** 通过 REST 看服务端此刻到底存着几笔 —— 不依赖客户端本地状态，最客观 */
async function checkRoomStrokes(roomId, expect) {
  const data = await httpJson('/api/rooms');
  if (!data || !Array.isArray(data.rooms)) return false;
  const room = data.rooms.find(r => r.id === roomId);
  if (!room) return false;
  return room.strokes === expect;
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
