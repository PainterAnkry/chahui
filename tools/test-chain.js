/**
 * 茶绘 · 接龙模式端到端验收（虚拟客户端，不需要浏览器）
 *
 * ⚠⚠ **这份已经过时，跑起来是红的，别再拿它当验收标准。**
 *   它写在 v9 之前，之后被打翻过三次：
 *     ① v9 加了「大厅」：GAME_START 只进大厅，要全员 GAME_READY 才开打；
 *        STEP 的值也从 `write/draw/guess` 改成了大写 `WORD/DRAWING/GUESS`
 *        （本文件里到处还是在比小写，所以一堆断言在空值上假红）。
 *     ② 2026-09 的接龙重写：**写完起词自己先画自己的词**（第 0、1 格都是链主）、
 *        鏈长改成「人数 + 1」、投票改成**按链串行**。
 *     ③ v11 的 8 步模型：链长 = **2 × 人数**（4 人房 8 格），authorOffset = floor(k/2)，
 *        回放棒次由服务端持有（revealStep）。本文件里「没有人画自己写的那条链」这条
 *        从 ② 起就**正好是反的**。
 *
 *   同一片覆盖现在由这三份负责（都在 `npm run test:all` 里）：
 *     · tools/test-chain-sim.js     —— 状态机离线仿真（152 项，秒级）
 *     · tools/test-chain-serial.js  —— 重写后的数据流（真 WebSocket，60 项）
 *     · tools/test-chain-private.js —— 私密作画（真 WebSocket，24 项）
 *   这一份留着只是因为里面还有些**没被搬走**的断言（任务字段结构白名单、
 *   权限拒绝文案、泄题扫描）。要复活它，先按上面三条把断言改到新模型。
 *
 * 用法（改好之后）：
 *   GAME_CHAIN_WRITE_MS=2500 GAME_CHAIN_DRAW_MS=3000 GAME_CHAIN_REPLAY_MS=4000 \
 *     CHAHU_WORDS='长颈鹿,珍珠奶茶,冰淇淋,向日葵,太空漫步' PORT=8444 \
 *     node server/src/index.js
 *   node tools/test-chain.js ws://localhost:8444/ws
 *
 * 覆盖的断言分四类：
 *   ① 流程：开房 → 开局 → 每人写词 → 词传下家作画 → 画传下家猜词 → 绕圈 → 回放 → 投票 → 结算
 *   ② 权限：人数不足不能开、非房主不能开、不是自己那一步不能交、不是作画的人落笔被拒
 *   ③ 保密（**唯一的死穴**）：任何人的快照 / 聊天里都不该出现别人的词或图；
 *      要猜的人只能拿到「上一幅画」，要画的人只能拿到「那个词」
 *   ④ 裁定：奖杯只发给「首尾对得上且没被多数人反对」的那条链
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
    failures.push(name + (extra ? ' → ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' → ' + extra : ''));
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
    gstate: null,     // 我收到的最新一份接龙快照（已按我裁剪）
    task: null,       // 我私收到的那一条 GAME_TASK（别人绝拿不到）
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
    if (m.t === P.S2C.GAME_TASK) c.task = m.task;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  c.phase = () => (c.gstate ? c.gstate.phase : '');
  c.step = () => (c.gstate ? c.gstate.myStep : '');
  c.close = () => ws.close();
  return c;
}

/** 这个客户端见过的所有消息的完整序列化 —— 用来查有没有答案漏给他 */
function allText(c) { return JSON.stringify(c.log); }

/**
 * 只扫「从某个时刻起」收到的消息。
 *
 * 为什么必须按时间切片：`c.log` 是整局的流水。等到测试跑到某一节时，
 * 里面早就混进了后面的消息（时间到了自动推进、别人的任务、甚至回放内容）——
 * 用整局流水去断言「此刻他不该看到 X」，必然假阳性。
 * 所以先记一个下标，再只扫这之后的部分。
 */
function since(c, idx) { return JSON.stringify(c.log.slice(idx)); }

/** 造一张「画」：接龙只要求是个合法 dataURL PNG，服务端只做哑存储 */
function fakePng(tag) {
  // 1×1 的合法 PNG（内容不重要，服务端不解析像素），末尾塞个标记方便断言「传的是这一张」
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  return 'data:image/png;base64,' + b64 + '#' + tag;
}

/** 从 idx 起收到的错误条数 */
function errsSince(c, idx) { return c.log.slice(idx).filter(m => m.t === P.S2C.ERROR).length; }

/** 从 idx 起收到的最后一条错误 */
function lastErrSince(c, idx) {
  const l = c.log.slice(idx).filter(m => m.t === P.S2C.ERROR);
  return l.length ? l[l.length - 1] : null;
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

function sendTo(c, t, p) { c.send(t, p); }

async function main() {
  const roomId = 'ctest_' + Date.now().toString(36).slice(-6);
  console.log('接龙模式 · 端到端验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  /* -------- 先验身份：端口上挂着的必须是我要的那台服务端 --------
   * 旧进程残留会 EADDRINUSE 顶替，新进程静默秒退，测试照样跑出一片假绿。 */
  const info = await httpJson('/api/share');
  if (!info || !info.chain) {
    console.log('无法从 ' + httpBase() + '/api/share 读到接龙配置，请先启动服务端：');
    console.log('  GAME_CHAIN_WRITE_MS=2500 GAME_CHAIN_DRAW_MS=3000 GAME_CHAIN_REPLAY_MS=4000 \\');
    console.log("    CHAHU_WORDS='长颈鹿,珍珠奶茶,冰淇淋,向日葵,太空漫步' PORT=8444 node server/src/index.js");
    process.exit(1);
  }
  console.log('服务端 pid=' + info.pid + '  接龙计时 ' + info.chain.WRITE_MS + '/' + info.chain.DRAW_MS
    + '/' + info.chain.REPLAY_MS + 'ms  主题 ' + (info.themes || []).join(',') + '\n');
  if (info.chain.WRITE_MS >= 30000) {
    console.log('⚠ 这台服务端用的是正式计时（' + info.chain.WRITE_MS + 'ms），接龙测试会非常慢。');
    console.log('  请按上面的命令用压缩计时另起一个端口。');
    process.exit(1);
  }

  /* ============================================== [1] 房间与开局门槛 */
  console.log('[1] 房间与开局门槛');
  {
    const host = await connect('房主');
    sendTo(host, P.C2S.ROOM_CREATE, { name: '接龙测试房', user: '房主', id: roomId });
    await waitFor(() => host.room, 4000, '建房间');
    ok('房主建好房间', !!host.room);
    ok('默认不是游戏模式', !host.gstate || host.gstate.phase === 'off' || host.gstate == null);

    // 只有房主一个人时开局 → 人数不足（接龙要 4 人）
    sendTo(host, P.C2S.GAME_START, { mode: 'chain' });
    await sleep(200);
    const e1 = host.last(P.S2C.ERROR);
    ok('人数不足时开局被拒绝', !!e1, e1 ? e1.message : '没有收到错误');
    ok('错误码是 too_few', !!e1 && e1.code === 'too_few', e1 ? e1.code : '');

    // 再补 3 个人（凑够 4）
    const g2 = await connect('猜手甲');
    sendTo(g2, P.C2S.ROOM_JOIN, { roomId, user: '猜手甲' });
    await waitFor(() => g2.room, 4000, '甲入房');
    const g3 = await connect('猜手乙');
    sendTo(g3, P.C2S.ROOM_JOIN, { roomId, user: '猜手乙' });
    await waitFor(() => g3.room, 4000, '乙入房');
    const g4 = await connect('猜手丙');
    sendTo(g4, P.C2S.ROOM_JOIN, { roomId, user: '猜手丙' });
    await waitFor(() => g4.room, 4000, '丙入房');

    ok('四个人都在房间里', !!(host.room && g2.room && g3.room && g4.room));

    // 非房主开局 → 被拒
    sendTo(g2, P.C2S.GAME_START, { mode: 'chain' });
    await sleep(200);
    const e2 = g2.last(P.S2C.ERROR);
    ok('非房主开局被拒绝', !!e2 && e2.code === 'not_owner', e2 ? e2.code : '没有收到错误');
  }

  /* ============================================== [2] 开局 */
  console.log('\n[2] 接龙开局');
  const [host, g2, g3, g4] = CLIENTS;
  const all = [host, g2, g3, g4];
  /** 每个人给自己那条链写的词（后续几节都要用它来判断「谁拿到了谁的东西」） */
  const words = {};
  {
    // rounds=3 在原模型里是「词→画→猜」；重写后链长 = 人数 + 1（第 0、1 格都是链主），
    // 默认就是「起词 → 画1 → 猜1 → 画2 → 猜2」，不再用 rounds 控制。
    sendTo(host, P.C2S.GAME_START, { mode: 'chain' });
    const started = await waitFor(() => host.gstate && host.gstate.mode === 'chain'
      && host.phase() !== 'off', 4000, '开局');
    ok('接龙开起来了', started);
    if (!started) { console.log('\n开局失败，后续断言跳过。'); return finish(); }

    ok('模式是 chain', host.gstate.mode === 'chain', host.gstate.mode);
    // ⚠ v9 起 GAME_START 只进**大厅**，要全员点「准备」才开打（这一条以前漏了，
    //    整份用例卡在 lobby 上，后面所有断言都在空数据上假红）
    const inLobby = await waitFor(() => all.every(c => c.phase() === 'chain_lobby'), 6000, '大厅');
    ok('全员落在大厅', inLobby, all.map(c => c.phase()).join(','));
    all.forEach(c => sendTo(c, P.C2S.GAME_READY, { ready: true }));
    ok('全员准备后进入开场鼓点', await waitFor(() => host.phase() === 'chain_init', 8000),
      host.phase());
    ok('四个人的链都建了（chainCount=4）', host.gstate.chainCount === 4, 'chainCount=' + host.gstate.chainCount);

    const allGot = await waitFor(() => all.every(c => c.gstate && c.gstate.mode === 'chain'), 4000, '全员状态');
    ok('四个人都收到了接龙状态', allGot);

    // 第一圈第一步：每个人都该在「写词」
    ok('进入写词阶段', host.phase() === 'chain_write', host.phase());
    const allWrite = await waitFor(() => all.every(c => c.step() === 'write'), 4000, '全员写词');
    ok('这一圈每个人都在写词（4/4）', allWrite,
      all.map(c => c.name + ':' + c.step()).join(' '));
    ok('这一步共有 4 件事要做', host.gstate.stepTotal === 4, 'stepTotal=' + host.gstate.stepTotal);

    // 候选词只给当事者，而且带 3 个
    const allTasks = await waitFor(() => all.every(c => c.task && c.task.step === 'write'), 4000, '全员任务');
    ok('每个人都私收到了「写词」任务（GAME_TASK）', allTasks);
    ok('每人拿到 3 个候选词', all.every(c => c.task && c.task.choices && c.task.choices.length === 3),
      all.map(c => (c.task ? c.task.choices.length : 'null')).join('/'));

    // 主题必须生效：CHAHU_WORDS 压过主题（测试要靠它把答案固定住）
    const choices = host.task.choices;
    ok('候选词来自被固定的自定义词库', choices.every(w => ['长颈鹿', '珍珠奶茶', '冰淇淋', '向日葵', '太空漫步'].indexOf(w) >= 0),
      JSON.stringify(choices));
  }

  /* ============================================== [3] 写词 → 传递 */
  console.log('\n[3] 写词 → 下家作画');
  {
    // 每人给自己那条链写一个**互不相同**的词，方便后面查「谁拿到了谁的东西」。
    // 用自写词而不是候选（候选池只有 5 个，四个人很容易撞词，撞了就分不清是谁的）。
    const pick = ['长颈鹿', '珍珠奶茶', '冰淇淋', '向日葵', '太空漫步'];
    const markWrite = all.map(c => c.log.length);   // 写词之前的流水长度（只看这之后的错误）
    all.forEach((c, i) => {
      words[c.name] = pick[i];
      sendTo(c, P.C2S.GAME_SUBMIT, { text: pick[i] });
    });
    await sleep(400);
    ok('四个人都能提交（本次没有新错误）',
      all.every((c, i) => errsSince(c, markWrite[i]) === 0),
      all.filter((c, i) => errsSince(c, markWrite[i]) !== 0)
        .map((c, i) => c.name + ':' + (lastErrSince(c, markWrite[i]) || {}).message).join('; '));

    // 交齐 → 自动推进到下一步
    const advanced = await waitFor(() => host.phase() && host.phase() !== 'chain_write', 4000, '推进');
    ok('全部交齐后自动进入下一步', advanced, host.phase());

    // 第二格：每条链都是「照这个词作画」。谁画谁由打乱过的顺序决定 —— 关键是「不是起词的人」
    const step2 = await waitFor(() => all.every(c => c.step() !== ''), 4000, '第二格安排');
    ok('第二格每个人都有活干（每人恰好一条链）', step2);
    ok('第二格全是作画', all.every(c => c.step() === 'draw'),
      all.map(c => c.name + ':' + c.step()).join(' '));
    ok('阶段切到作画', host.phase() === 'chain_draw', host.phase());

    // 作画的人拿到的是「词」，而且那是**别人写的**
    const markDraw = all.map(c => c.log.length);   // 下方的泄漏扫描只看这之后收到的消息
    const drawTasks = await waitFor(() => all.every(c => c.task && c.task.step === 'draw'), 4000, '作画任务');
    ok('作画的人私收到了要画的词', drawTasks);
    const pool = Object.values(words);
    ok('每个人要画的词都是本局某个人写的',
      all.every(c => pool.indexOf(c.task.word) >= 0),
      all.map(c => c.name + ':' + c.task.word).join(' '));
    ok('没有人画自己写的那条链（n≥4 保证）',
      all.every(c => c.task.word !== words[c.name]),
      all.filter(c => c.task.word === words[c.name]).map(c => c.name).join(',') || '无人自画');

    // ★ 保密检查（结构式，不做字符串扫描）。
    //
    // 为什么不能用「扫字符串」：候选词库只有 5 个词，A 的候选里天然就含
    // 别人后来选中的词 —— 那是他自己该看到的候选，不是泄漏。字符串扫描在这种
    // 共享词池下必然假阳性，所以改成查**结构**：
    //   ① 我的 draw 任务里只有「一个词」，不多给
    //   ② 我的快照里没有任何格子的内容（progress 只是进度骨架）
    //   ③ 我收到的每条 GAME_TASK 都只服务于「我这一步」的步骤类型
    let structBad = [];
    for (const c of all) {
      for (const m of c.msgs(P.S2C.GAME_TASK)) {
        const t = m.task || {};
        const keys = Object.keys(t).sort().join(',');
        if (t.step === 'draw' && keys !== 'deadline,step,word') structBad.push(c.name + ' draw 任务多带了字段: ' + keys);
        if (t.step === 'guess' && keys !== 'deadline,image,step,wordLen') structBad.push(c.name + ' guess 任务多带了字段: ' + keys);
        if (t.step === 'write' && keys !== 'choices,deadline,step') structBad.push(c.name + ' write 任务多带了字段: ' + keys);
        // guess 任务绝不能带词
        if (t.step === 'guess' && (t.word || t.choices)) structBad.push(c.name + ' guess 任务带了词');
        // draw 任务绝不能带图
        if (t.step === 'draw' && t.image) structBad.push(c.name + ' draw 任务带了图');
      }
      // 快照的 progress 只是进度骨架：只该有 id / owner / step / total，不含内容
      for (const m of c.msgs(P.S2C.GAME_STATE)) {
        const g = m.game;
        if (!g || !g.progress) continue;
        for (const p of g.progress) {
          const pk = Object.keys(p).sort().join(',');
          if (pk !== 'id,ownerId,ownerName,step,total') structBad.push(c.name + ' progress 多带了字段: ' + pk);
        }
      }
    }
    ok('每个任务的字段都是它该有的那几个（不多给）', structBad.length === 0, structBad.slice(0, 3).join('; '));

    // 作画阶段交词应该被拒（不是写词阶段了）
    const errsBefore = host.msgs(P.S2C.ERROR).length;
    sendTo(host, P.C2S.GAME_SUBMIT, { text: '我乱交一下' });
    const gotErr = await waitFor(() => host.msgs(P.S2C.ERROR).length > errsBefore, 2000, '错误回执');
    ok('作画阶段交词被拒（不是写词阶段）', gotErr, '没有收到错误');
  }

  /* ============================================== [4] 作画 → 传递 */
  console.log('\n[4] 作画 → 下家猜词');
  {
    // 每人交一张「画」。用的是假 PNG —— 服务端只做哑存储，不解析像素。
    // 先记下各自的错误数：上一节故意触发过一次「交词被拒」，不能拿历史错误当本次结果。
    const errBase = {};
    for (const c of all) errBase[c.name] = c.msgs(P.S2C.ERROR).length;

    const arts = {};
    for (const c of all) {
      arts[c.name] = fakePng(c.name);
      sendTo(c, P.C2S.GAME_ART, { png: arts[c.name] });
    }
    const advanced = await waitFor(() => host.phase() === 'chain_guess', 6000, '进猜词');
    ok('交齐后进入猜词阶段', advanced, host.phase());
    ok('四个人都能交作品（本次没有新错误）',
      all.every(c => c.msgs(P.S2C.ERROR).length === errBase[c.name]),
      all.filter(c => c.msgs(P.S2C.ERROR).length !== errBase[c.name])
        .map(c => c.name + ':' + c.last(P.S2C.ERROR).message).join('; '));

    /** 从这一刻起，下面的泄漏扫描只看新收到的消息 */
    const markGuess = all.map(c => c.log.length);

    const guessTasks = await waitFor(() => all.every(c => c.task && c.task.step === 'guess'), 6000, '猜词任务');
    ok('这一格每个人都拿到了要猜的图', guessTasks);
    ok('要猜的人只拿到图、拿不到词',
      all.every(c => c.task.image && !c.task.word && !c.task.choices),
      JSON.stringify(all[0].task).slice(0, 120));

    // ★ 最关键的保密断言：他手上的图必须是「本局某人画的那张」，不是凭空造出来的。
    ok('每个人拿到的那张画确实存在（是本局某人画的）',
      all.every(c => Object.values(arts).some(a => c.task.image === a)),
      all.map(c => c.name + ':' + (c.task.image || '').split('#')[1]).join(' '));
    ok('没有人拿到自己画的那张（链条不会自环）',
      all.every(c => c.task.image !== arts[c.name]),
      all.filter(c => c.task.image === arts[c.name]).map(c => c.name).join(',') || '无人自猜');

    // 猜词阶段的结构式保密检查：
    //   ① 我拿到的图必须**只是**上一格那一幅（不许多给几张）
    //   ② 猜词这一步绝不带词、不带候选
    //   ③ 每个人的 GAME_STATE 里都没有别人的格内容（replay 要到投票阶段才有）
    let guessBad = [];
    for (const c of all) {
      const t = c.task || {};
      if (t.step !== 'guess') { guessBad.push(c.name + ' 任务不是 guess'); continue; }
      if (t.word || t.choices) guessBad.push(c.name + ' 拿到了词/候选');
      if (typeof t.image !== 'string' || t.image.indexOf('data:image/') !== 0) {
        guessBad.push(c.name + ' 拿到的不是合法图');
      }
      // 这一阶段的快照里不该出现任何链条内容
      for (const m of c.msgs(P.S2C.GAME_STATE)) {
        if (m.game && m.game.phase === 'chain_guess' && m.game.replay) {
          guessBad.push(c.name + ' 猜词阶段的快照里带了 replay');
        }
      }
    }
    ok('猜词阶段每个人都只拿到一幅图（且不带词）', guessBad.length === 0, guessBad.slice(0, 3).join('; '));

    // 聊天防剧透：正在猜词的人发言不该发出去
    sendTo(all[0], P.C2S.CHAT, { text: '我随便说句话试试' });
    await sleep(250);
    const mine = all[0].msgs(P.S2C.CHAT).filter(m => m.userId === all[0].you.userId);
    ok('手里攥着答案的人发言被拦（不广播）', mine.length === 0,
      mine.map(m => m.text).join(' | '));
  }

  /* ============================================== [5] 猜词 → 回放 → 投票 */
  console.log('\n[5] 猜词 → 回放 → 投票 → 结算');
  {
    // 猜：故意让所有人都猜成同一个词，制造「首尾可能一致」的局面
    const markGuess5 = all.map(c => c.log.length);
    for (const c of all) sendTo(c, P.C2S.GAME_SUBMIT, { text: '长颈鹿' });
    await sleep(400);
    ok('四个人都能交猜词（本次没有新错误）',
      all.every((c, i) => errsSince(c, markGuess5[i]) === 0),
      all.filter((c, i) => errsSince(c, markGuess5[i]) !== 0)
        .map((c, i) => c.name + ':' + (lastErrSince(c, markGuess5[i]) || {}).message).join('; '));

    // rounds=3：写词 → 作画 → 猜词 走完就进回放（beginReplay 直接进投票阶段）
    const inVote = await waitFor(() => host.phase() === 'chain_vote', 15000, '进投票');
    ok('三圈（词→画→猜）走完后进入回放 / 投票阶段', inVote, host.phase());

    if (inVote) {
      ok('回放数据下发了', !!host.gstate.replay && host.gstate.replay.length === 4,
        'replay=' + (host.gstate.replay ? host.gstate.replay.length : 'null'));
      ok('回放里每条链带首词与末词',
        host.gstate.replay.every(r => r.firstWord !== undefined && r.lastWord !== undefined));
      ok('首尾是否一致有初判（matched 是布尔）',
        host.gstate.replay.every(r => typeof r.matched === 'boolean'));

      // 投票前，谁的票数都不该公开（votesFor 只回给本人）
      ok('看不到别人的投票', host.gstate.replay.every(r => r.against === undefined));
      ok('我的投票列表是空的（还没投）', Array.isArray(host.gstate.myVotes) && host.gstate.myVotes.length === 0);

      // 所有人投「对得上」（agree=true），把奖杯发出去
      for (const r of host.gstate.replay) {
        for (const c of all) sendTo(c, P.C2S.GAME_VOTE, { chainId: r.id, agree: true });
      }
      await sleep(300);

      // 非房主不能推进
      sendTo(g2, P.C2S.GAME_NEXT, {});
      await sleep(150);
      const eNext = g2.last(P.S2C.ERROR);
      ok('非房主不能推进结算', !!eNext && /房主/.test(eNext.message), eNext ? eNext.message : '');

      // 房主立刻结算
      sendTo(host, P.C2S.GAME_NEXT, {});
      const over = await waitFor(() => host.phase() === 'over', 6000, '结算');
      ok('房主推进后立刻结算', over, host.phase());
      ok('结算给出了每条链的结果', !!host.gstate.voteResult && host.gstate.voteResult.length === 4);
      ok('票数公开了（结算面板要显示）',
        host.gstate.voteResult.every(r => typeof r.against === 'number'));

      const winners = host.gstate.voteResult.filter(r => r.won);
      const allMatched = host.gstate.voteResult.every(r => r.matched);
      if (allMatched) {
        ok('首尾一致的链都拿到了奖杯', winners.length === 4, 'winners=' + winners.length);
        ok('拿奖杯的是起词的人', winners.every(w => !!w.ownerId && !!w.ownerName));
        const scored = host.gstate.scores.filter(s => s.score > 0);
        ok('奖杯计进了榜单', scored.length === 4, '有分的 ' + scored.length + ' 人');
      } else {
        // 有人没对上也合理（猜出来的词不一定等于首词），那就只查「won 的必然 matched」
        ok('只有首尾一致的链才可能拿奖杯', winners.every(w => w.matched),
          winners.filter(w => !w.matched).map(w => w.firstWord + '→' + w.lastWord).join(' '));
        ok('首尾不一致的链一律没有奖杯',
          host.gstate.voteResult.filter(r => !r.matched).every(r => !r.won));
      }
      ok('本局结束可以再开一局', host.gstate.canStart === true);
    }
  }

  /* ============================================== [6] 泄题总检查 */
  console.log('\n[6] 泄题总检查（整局的消息全量扫一遍）');
  {
    // 整局期间，任何人的词都不该出现在「该看到的时机之前」别人的消息里。
    // 这里做一个保守但明确的断言：回放开始前，「猜词」这一步的答案（别人猜出来的词）
    // 绝不该出现在没到那一步的人的消息流里。
    // 简化版判据：作画 / 猜词阶段收到的任何 GAME_STATE 里都不该有 replay 内容。
    let preReplayLeak = 0;
    for (const c of all) {
      for (const m of c.log) {
        if (m.t !== P.S2C.GAME_STATE) continue;
        const g = m.game;
        if (!g) continue;
        const playing = g.phase === 'chain_write' || g.phase === 'chain_draw' || g.phase === 'chain_guess';
        if (playing && g.replay) preReplayLeak++;
      }
    }
    ok('回放开始前，快照里从不带 replay 内容', preReplayLeak === 0, '出现 ' + preReplayLeak + ' 次');

    // GAME_TASK 是私密消息：每个人收到的条数应该只与自己被安排的步数一致，
    // 且内容里只有「自己的那一步」，不该带别人的格。
    let taskLeak = 0;
    for (const c of all) {
      for (const m of c.msgs(P.S2C.GAME_TASK)) {
        const t = m.task || {};
        if (t.step === 'guess' && (t.word || t.choices)) taskLeak++;
        if (t.step === 'draw' && (t.image || t.choices)) taskLeak++;
        if (t.step === 'write' && (t.image || t.word)) taskLeak++;
      }
    }
    ok('GAME_TASK 只带「这一步该看的东西」，不多给', taskLeak === 0, '越界 ' + taskLeak + ' 次');
  }

  /* ============================================== [7] 收尾 */
  console.log('\n[7] 收尾');
  {
    // 结束游戏 → 回到自由绘画
    sendTo(host, P.C2S.GAME_STOP, {});
    await waitFor(() => host.phase() === 'off', 4000, '结束游戏');
    ok('房主结束游戏后回到自由绘画', host.phase() === 'off', host.phase());

    sendTo(host, P.C2S.ROOM_DESTROY, {});
    await waitFor(() => all.every(c => c.last(P.S2C.ROOM_DESTROYED)), 4000, '解散房间');
    ok('房间可以正常解散', all.every(c => !!c.last(P.S2C.ROOM_DESTROYED)));
  }

  finish();
}

function finish() {
  for (const c of CLIENTS) { try { c.close(); } catch (e) { /* ignore */ } }
  console.log('\n' + '─'.repeat(46));
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('─'.repeat(46));
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e);
  finish();
});
