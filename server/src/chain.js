'use strict';

/**
 * 接龙模式（chain / Whisper）—— 服务端权威状态机。【v2 重制版】
 *
 * 玩法一句话：**N 个玩家 = N 条并行的链**。每条链以「链主写的初始词」为起点，
 * 沿打乱过的玩家环一圈一圈传下去 —— 拿到词的人画，拿到画的人猜，
 * 拿到猜出的词再画…… 全部传完后一起看回放：一个词是怎么一步步跑偏的。
 *
 * 与 v1（旧 chain.js）的关键差异 —— 这一版是按 Draw & Guess 的 Whisper 玩法重写的：
 *   1. **链长 = 环上人数**（可设定 3 ~ 人数）。每条链恰好传遍全场，
 *      每个阶段每个人都恰好有自己的一格要做 —— 不再有「掉线顶替把格子派重复」的错乱。
 *   2. **产物是笔迹数据，不是 PNG**。DRAWING 格的 content = 作者的笔迹数组
 *      （points / color / size / tool……），猜词的人拿到笔迹在本地渲染，
 *      回放时也能按真实笔序重新演一遍。
 *   3. **信息隔离是死穴**：每人只拿自己这一格的输入 ——
 *      WORD 格拿候选词、DRAWING 格拿要画的词、GUESS 格拿上家的笔迹。
 *      完整链条只在服务端；进 REVEAL 阶段才一次性公开（走独立的 GAME_REVEAL 消息，
 *      绝不搭 GAME_STATE 的广播快照 —— 那条每秒都在重发，塞几 MB 笔迹进去会卡死公网房）。
 *   4. **流程**：大厅（全员准备）→ 开场 → 写词 → 画/猜交替 → 回放 → 投票 → 结算 → 回大厅。
 *      投票有两票：每条链「首尾是否还对得上」+ 全场「最喜欢的一张画」。
 *
 * 时间与计分全部在服务端裁定：客户端只拿 deadline 做倒计时显示。
 */

const P = require('./protocol');
const WORDS = require('./words');
const THEMES = require('./themes');

/** 接龙的阶段 */
const CHAIN_PHASE = {
  OFF: 'off',
  LOBBY: 'lobby',           // 大厅：玩家准备，全员就绪自动开局
  INIT: 'chain_init',       // 开场鼓点：链已排好，画布已清空，马上写词
  WRITE: 'chain_write',     // 每人给自己的链写初始词（type=WORD）
  DRAW: 'chain_draw',       // 并行作画（type=DRAWING）：拿到词，画出来
  GUESS: 'chain_guess',     // 并行猜词（type=GUESS）：拿到笔迹，猜词
  REVEAL: 'chain_reveal',   // 回放：完整链条公开，播放器逐条看
  VOTE: 'chain_vote',       // 投票：每条链「对得上吗」+ 全场「最喜欢的画」
  SCORE: 'chain_score'      // 结算：得分与榜单 → 回大厅（分数保留，可再来一局）
};

const CHAIN_PHASE_LABEL = {
  off: '自由绘画',
  lobby: '接龙大厅',
  chain_init: '马上开始',
  chain_write: '写初始词',
  chain_draw: '作画中',
  chain_guess: '猜词中',
  chain_reveal: '回放',
  chain_vote: '投票中',
  chain_score: '结算'
};

/** 每一格的类型（与协议约定一致）：初始词 / 画 / 猜词 */
const STEP = { WORD: 'WORD', DRAWING: 'DRAWING', GUESS: 'GUESS' };

/** 单幅画笔迹的硬上限（防恶意刷爆内存 / 回放包；正常绘画远够不到） */
const MAX_STROKES_PER_ART = 400;
const MAX_POINTS_PER_ART = 80000;

function clampInt(v, d, a, b) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return d;
  return n < a ? a : n > b ? b : n;
}

function envMs(key, dflt) {
  const n = Math.floor(Number(process.env[key]));
  return isFinite(n) && n > 0 ? n : dflt;
}

const CFG = {
  INIT_MS: envMs('GAME_CHAIN_INIT_MS', P.GAME.CHAIN_INIT_MS),
  WRITE_MS: envMs('GAME_CHAIN_WRITE_MS', P.GAME.CHAIN_WRITE_MS),
  DRAW_MS: envMs('GAME_CHAIN_DRAW_MS', P.GAME.CHAIN_DRAW_MS),
  GUESS_MS: envMs('GAME_CHAIN_GUESS_MS', P.GAME.CHAIN_GUESS_MS),
  REVEAL_MS: envMs('GAME_CHAIN_REVEAL_MS', P.GAME.CHAIN_REVEAL_MS),
  VOTE_MS: envMs('GAME_CHAIN_VOTE_MS', P.GAME.CHAIN_VOTE_MS),
  SCORE_MS: envMs('GAME_CHAIN_SCORE_MS', P.GAME.CHAIN_SCORE_MS),
  // 收格宽限：客户端倒计时到点后自动提交的包还在路上，多等这一小会儿再收格
  GRACE_MS: envMs('GAME_CHAIN_GRACE_MS', P.GAME.CHAIN_GRACE_MS)
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 洗词：从一个池子里不重复地取 n 个 */
function pickWords(pool, n, used) {
  const usedSet = new Set(used || []);
  let src = pool.filter(w => !usedSet.has(w));
  if (src.length < n) src = pool.slice();
  const out = [];
  const copy = src.slice();
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

class ChainGame {
  /**
   * @param {Room} room
   * @param {{sync:Function, systemChat:Function, resetCanvas:Function, revealAll:Function}} api
   *   - sync()        把（按人裁剪过的）快照推给全场
   *   - systemChat()  系统播报
   *   - resetCanvas() 清空画布（INIT 与作画阶段的首尾调用）
   *   - revealAll()   回放数据的一次性广播（GAME_REVEAL）
   *
   * ⚠ 作画的产物**不由服务端抓像素**：客户端照常在画布上落笔（笔迹走 STROKE_* 照旧
   *   进房间笔迹表，私密作画期间不广播），收格时服务端从笔迹表里把**作者的**笔迹
   *   原样摘出来存进链条 —— 像素渲染仍在客户端，服务端只存数据。
   */
  constructor(room, api) {
    this.room = room;
    this.api = api;
    this.mode = 'chain';
    this.phase = CHAIN_PHASE.OFF;

    this.roundNo = 0;          // 第几局（大厅→开局 算一局）
    this.theme = 'default';
    this.drawMs = 0;           // 作画一步的时长覆盖值（0 = 用全局默认）
    this.chainLength = 0;      // 每条链传几手（含初始词格）；开局时定死

    this.ring = [];            // 传递顺序（开局时打乱一次，一局内固定）
    this.chains = [];          // [{ chainId, ownerPlayerId, ownerName, currentStep, steps[], status }]
    this.names = new Map();    // userId -> name（人走了榜单也要显示）
    this.scores = new Map();   // userId -> 分数（跨局累计）
    // 局中进房的人：本局只能旁边看（链在开局那一刻冻结了）。
    // 下一局开局时清空 —— 那时他们就是正式玩家。
    this.spectators = new Set();

    // 大厅（LOBBY 阶段）
    this.ready = new Set();    // 已准备的玩家

    // 当前这一格的临时状态
    this.stepIndex = 0;        // 当前是每条链的第几格（0 起）
    this.submitted = new Set();// 本格已提交的人
    this.pendingText = new Map(); // userId -> 已提交的词（WORD/GUESS）
    this.stepChoices = new Map(); // userId -> 候选词（WORD 格）

    // 投票（VOTE 阶段）
    this.votesKeep = new Map();// userId -> Map(chainId -> bool) 每条链「对得上吗」
    this.votesFav = new Map(); // userId -> { chainId, step } 最喜欢的一张画

    // 回放（REVEAL 起）
    this.revealData = null;    // 完整链条（内容公开）
    this.revealVersion = 0;    // 每次重建 +1；index.js 靠它判断谁还没收到回放包
    this.taskVersion = 0;      // 每次换格 +1；GAME_TASK 只在换格后重发（笔迹包不小）
    this.voteResult = null;    // 结算快照（SCORE 阶段下发）

    this.deadline = 0;
    this.startedAt = 0;
  }

  /* ------------------------------------------------------------ 查询 */

  get active() { return this.phase !== CHAIN_PHASE.OFF; }

  /** 正在「做事」的阶段（写词 / 画 / 猜）——这几个阶段以外不该有人改画布 */
  isPlaying() {
    return this.phase === CHAIN_PHASE.WRITE ||
      this.phase === CHAIN_PHASE.DRAW ||
      this.phase === CHAIN_PHASE.GUESS;
  }

  isDrawingPhase() { return this.phase === CHAIN_PHASE.DRAW; }

  /** 一局已经开了、还没回到大厅吗 */
  midGame() {
    return this.phase !== CHAIN_PHASE.LOBBY && this.phase !== CHAIN_PHASE.OFF &&
      this.phase !== CHAIN_PHASE.SCORE;
  }

  /** 第 k 格（0 起）的类型：0=WORD，奇数=DRAWING，偶数(>0)=GUESS */
  stepTypeOf(k) {
    if (k === 0) return STEP.WORD;
    return (k % 2 === 1) ? STEP.DRAWING : STEP.GUESS;
  }

  /** 玩家名单：非只读、非看客的在场成员（大厅准备与开局人数都以它为准） */
  playerList() {
    const out = [];
    for (const m of this.room.members.values()) {
      if (m.readonly) continue;
      if (this.spectators.has(m.userId)) continue;
      out.push({ userId: m.userId, name: m.name, color: m.color });
      this.names.set(m.userId, m.name);
    }
    return out;
  }

  memberOf(userId) {
    for (const m of this.room.members.values()) if (m.userId === userId) return m;
    return null;
  }

  isOwner(userId) { return !!(this.room.ownerId && this.room.ownerId === userId); }

  /**
   * 第 k 格该谁做：链主往后数 k 个人（ring 是打乱过的玩家环）。
   * 链 ring[i] 的第 k 格由 ring[(i+k) % n] 做 —— 所以「我」在第 k 格负责的链
   * 就是 ring[(myIdx - k) mod n] 那个人开的链。人数=链长时这是个一一映射：
   * 同一阶段里每个人都恰好有一格，绝不会被派两次（v1 的覆盖错乱在这里根治）。
   */
  cellOf(userId, k) {
    const n = this.ring.length;
    if (!n) return null;
    const myIdx = this.ring.indexOf(userId);
    if (myIdx < 0) return null;              // 看客 / 不在本局的环里
    const ownerIdx = ((myIdx - k) % n + n) % n;
    const chain = this.chains.find(c => c.ownerPlayerId === this.ring[ownerIdx]);
    return chain || null;
  }

  /** 该用户此刻能不能改画布 */
  lockedFor(userId) {
    if (this.phase === CHAIN_PHASE.OFF || this.phase === CHAIN_PHASE.LOBBY) return false;
    if (this.phase === CHAIN_PHASE.DRAW) {
      // 作画：环里的人都能动笔（每人都有一格）；交过了就锁笔；看客锁笔
      const chain = this.cellOf(userId, this.stepIndex);
      if (!chain) return true;
      return this.submitted.has(userId);
    }
    return true;   // INIT / WRITE / GUESS / REVEAL / VOTE / SCORE 一律不动笔
  }

  blocksWrite(userId) { return this.lockedFor(userId); }

  /**
   * 这个人此刻手里攥着「别人还没看到的答案」吗？
   * 本格还没交的人一律闭嘴（写词的知道词、画画和猜的知道题面）；
   * 交了之后内容已经只传给下家，恢复说话。
   */
  chatLeaks(userId) {
    if (!this.isPlaying()) return false;
    if (!this.cellOf(userId, this.stepIndex)) return false;
    return !this.submitted.has(userId);
  }

  /** 这一步的时长（客户端只拿来显示倒计时） */
  stepMs() {
    if (this.phase === CHAIN_PHASE.INIT) return CFG.INIT_MS;
    if (this.phase === CHAIN_PHASE.WRITE) return CFG.WRITE_MS;
    if (this.phase === CHAIN_PHASE.DRAW) return this.drawMs || CFG.DRAW_MS;
    if (this.phase === CHAIN_PHASE.GUESS) return CFG.GUESS_MS;
    if (this.phase === CHAIN_PHASE.REVEAL) return CFG.REVEAL_MS;
    if (this.phase === CHAIN_PHASE.VOTE) return CFG.VOTE_MS;
    if (this.phase === CHAIN_PHASE.SCORE) return CFG.SCORE_MS;
    return 0;
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 按收件人裁剪的状态。**这是答案泄漏的唯一防线**。
   *
   * 这里**绝不携带任何链条内容**（词 / 笔迹）—— 内容只走两条私有通道：
   *   - GAME_TASK：当前格当事者的题面（换格时才重发）
   *   - GAME_REVEAL：回放数据（进 REVEAL 阶段才广播，此后由 index.js 补发迟到者）
   */
  snapshotFor(userId) {
    const me = userId || '';
    const cell = this.isPlaying() ? this.cellOf(me, this.stepIndex) : null;
    const myFav = this.votesFav.get(me) || null;
    const keepMap = this.votesKeep.get(me);
    const myKeep = {};
    if (keepMap) for (const [cid, agree] of keepMap) myKeep[cid] = !!agree;

    return {
      mode: 'chain',
      phase: this.phase,
      phaseLabel: CHAIN_PHASE_LABEL[this.phase] || this.phase,
      theme: this.theme,
      themeName: (THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '',
      serverNow: Date.now(),
      deadline: this.deadline,
      stepMs: this.stepMs(),

      round: this.roundNo,
      chainLength: this.chainLength,
      // 进度骨架：第几格、这条格一共几件事、交了几件 —— 不含任何内容
      stepIndex: this.isPlaying() || this.phase === CHAIN_PHASE.INIT ? this.stepIndex : 0,
      stepTotal: this.chains.length,
      stepDone: this.submitted.size,

      // 大厅 / 榜单（ready 只有大厅阶段有意义，其余阶段一律 false）
      players: this.playerStates(),
      myReady: this.ready.has(me),
      readyCount: this.ready.size,

      // 我这一格：'' = 这一步没我的事（看客）；WORD / DRAWING / GUESS
      myStep: cell ? cellStepType(this, this.stepIndex) : '',
      myDone: this.submitted.has(me),
      hasReveal: !!this.revealData,

      locked: this.lockedFor(me),
      canStart: this.phase === CHAIN_PHASE.LOBBY || this.phase === CHAIN_PHASE.SCORE,
      isOwner: this.isOwner(me),

      scores: this.scoreList(),

      // 我的投票（票是匿名的，只回给本人）
      myKeep: myKeep,
      myFav: myFav,
      favVotedCount: this.votesFav.size,

      // 结算只在 SCORE 阶段下发
      voteResult: this.phase === CHAIN_PHASE.SCORE ? this.voteResult : null,

      // 中途进房、本局只能看：前端据此显示提示条
      spectating: this.spectators.has(me),
      minPlayers: P.GAME.CHAIN_MIN_PLAYERS,
      maxPlayers: P.GAME.CHAIN_MAX_PLAYERS,
      maxLength: P.GAME.CHAIN_LENGTH_MAX,
      minLength: P.GAME.CHAIN_LENGTH_MIN,
      themes: THEMES.themeList()
    };
  }

  /** 大厅与榜单共用的玩家状态表（不含任何链条内容） */
  playerStates() {
    const rows = [];
    const seen = new Set();
    for (const m of this.room.members.values()) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      rows.push({
        userId: m.userId,
        name: m.name,
        color: m.color,
        online: true,
        spectating: this.spectators.has(m.userId),
        ready: this.ready.has(m.userId),
        score: this.scores.get(m.userId) || 0
      });
      this.names.set(m.userId, m.name);
    }
    // 已离场但还有分数的人：榜单上保留（灰名）
    for (const [uid, score] of this.scores) {
      if (seen.has(uid)) continue;
      rows.push({ userId: uid, name: this.names.get(uid) || '某人', color: '#9aa0a8', online: false, spectating: false, ready: false, score });
    }
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return rows;
  }

  /** 排行榜 */
  scoreList() {
    const rows = this.playerStates().map(r => ({
      userId: r.userId, name: r.name, online: r.online, score: r.score
    }));
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /**
   * 我这一格的「题面」——只能给自己看的那一份（GAME_TASK 私发）。
   *
   *   WORD    : 候选词（挑一个，或自己写）
   *   DRAWING : 要画的词（链主的初始词，或上家猜出来的词）
   *   GUESS   : 上家的笔迹（数组，客户端本地渲染成图）
   * 返回 null 表示这一步没我的事（看客）。
   */
  taskFor(userId) {
    if (!this.isPlaying()) return null;
    const chain = this.cellOf(userId, this.stepIndex);
    if (!chain) return null;
    const k = this.stepIndex;
    const type = this.stepTypeOf(k);

    if (type === STEP.WORD) {
      return { step: STEP.WORD, chainId: chain.chainId, choices: this.stepChoices.get(userId) || [], deadline: this.deadline };
    }
    if (type === STEP.DRAWING) {
      // ⚠️ 只给「上一格的词」。绝不带更早的任何东西。
      const prev = chain.steps[k - 1];
      return { step: STEP.DRAWING, chainId: chain.chainId, word: (prev && prev.content) || '', deadline: this.deadline };
    }
    // GUESS：只给「上一格的笔迹」。绝不带词、绝不带链上更早的任何东西。
    const prev = chain.steps[k - 1];
    const strokes = (prev && Array.isArray(prev.content)) ? prev.content : [];
    return { step: STEP.GUESS, chainId: chain.chainId, strokes, deadline: this.deadline };
  }

  /* ------------------------------------------------------------ 大厅 */

  /**
   * 房主开局（GAME_START）：**不直接开打**，先进大厅等人准备。
   * 已在大厅 / 结算阶段时允许改设置；局中（写词/画/猜/回放/投票）不允许。
   */
  start(opts) {
    if (this.isPlaying() || this.phase === CHAIN_PHASE.INIT ||
      this.phase === CHAIN_PHASE.REVEAL || this.phase === CHAIN_PHASE.VOTE) {
      return { ok: false, code: 'game_busy', message: '这一局还在进行中，先点「结束游戏」' };
    }
    const players = this.playerList();
    const min = P.GAME.CHAIN_MIN_PLAYERS;
    const max = P.GAME.CHAIN_MAX_PLAYERS;
    if (players.length < min) {
      return { ok: false, code: 'too_few', message: '接龙至少要 ' + min + ' 个人才能玩（链条太短没意思）' };
    }
    if (players.length > max) {
      return { ok: false, code: 'too_many', message: '接龙最多 ' + max + ' 个人' };
    }

    this.theme = (opts && THEMES.hasTheme(opts.theme)) ? opts.theme : 'default';
    const dsec = Math.floor(Number(opts && opts.drawSeconds));
    this.drawMs = (isFinite(dsec) && dsec > 0)
      ? clampInt(dsec, P.GAME.DRAW_SECONDS_DEFAULT, P.GAME.DRAW_SECONDS_MIN, P.GAME.DRAW_SECONDS_MAX) * 1000
      : 0;
    // 链长：默认 = 人数（每条链恰好传遍全场）；可设定，夹在 [3, 人数] 里
    const wantLen = Math.floor(Number(opts && opts.chainLength)) || players.length;
    this.chainLength = clampInt(wantLen, players.length,
      P.GAME.CHAIN_LENGTH_MIN, Math.min(players.length, P.GAME.CHAIN_LENGTH_MAX));

    this.chains = [];
    this.ring = [];
    this.stepIndex = 0;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.revealData = null;
    this.voteResult = null;
    this.ready.clear();
    this.phase = CHAIN_PHASE.LOBBY;
    this.deadline = 0;
    players.forEach(p => { if (!this.scores.has(p.userId)) this.scores.set(p.userId, 0); });
    this.api.sync();
    this.api.systemChat('接龙大厅已就绪（' + players.length + ' 人）—— 大家点「准备」，全员就绪自动开始');
    return { ok: true };
  }

  /** 大厅里 toggle 准备。全员就绪 → 自动开局 */
  toggleReady(userId, want) {
    if (this.phase !== CHAIN_PHASE.LOBBY) return { ok: false, message: '现在不在大厅' };
    if (this.spectators.has(userId)) return { ok: false, message: '你本局是观战，下一局再一起玩' };
    if (want === false) this.ready.delete(userId);
    else this.ready.add(userId);
    this.api.sync();
    this.checkAllReady();
    return { ok: true };
  }

  checkAllReady() {
    if (this.phase !== CHAIN_PHASE.LOBBY) return false;
    const players = this.playerList();
    if (players.length < P.GAME.CHAIN_MIN_PLAYERS) return false;
    const allReady = players.every(p => this.ready.has(p.userId));
    if (allReady) { this.beginGame(); return true; }
    return false;
  }

  /** 正式开局：冻结名单与环序 → 开场鼓点（INIT）→ 第 0 格（写词） */
  beginGame() {
    const players = this.playerList();
    const min = P.GAME.CHAIN_MIN_PLAYERS;
    if (players.length < min) {
      this.api.systemChat('人数不足 ' + min + ' 人，开不了局 —— 继续等待');
      return false;
    }
    // 链长跟着这一局的实际人数再夹一次（有人刚离开时设置值可能越界）
    this.chainLength = clampInt(this.chainLength || players.length, players.length,
      P.GAME.CHAIN_LENGTH_MIN, Math.min(players.length, P.GAME.CHAIN_LENGTH_MAX));

    this.spectators.clear();          // 开新局：房间里的人都算玩家
    this.roundNo += 1;
    this.ring = shuffle(players.map(p => p.userId));
    players.forEach(p => this.names.set(p.userId, p.name));
    players.forEach(p => { if (!this.scores.has(p.userId)) this.scores.set(p.userId, 0); });

    // 每人一条链。链的「主人」就是写初始词的人。
    this.chains = players.map((p, i) => ({
      chainId: 'c' + (i + 1),
      ownerPlayerId: p.userId,
      ownerName: p.name,
      currentStep: 0,
      steps: [],
      status: 'active'
    }));

    this.revealData = null;
    this.voteResult = null;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.startedAt = Date.now();
    this.stepIndex = 0;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();

    this.phase = CHAIN_PHASE.INIT;
    this.deadline = Date.now() + CFG.INIT_MS;
    this.api.resetCanvas();           // 游戏画布：从干净的一张开始
    this.api.sync();
    this.api.systemChat('第 ' + this.roundNo + ' 局开始！共 ' + this.chains.length + ' 条链，'
      + '每条传 ' + this.chainLength + ' 手 · 主题：'
      + ((THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '通用'));
    return true;
  }

  /* ------------------------------------------------------------ 格与阶段推进 */

  /** 进入「第 k 格」：全场的格型一致（0=写词，奇数=作画，偶数=猜词） */
  enterStep(k) {
    this.stepIndex = k;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    const type = this.stepTypeOf(k);
    this.phase = type === STEP.WORD ? CHAIN_PHASE.WRITE
      : type === STEP.DRAWING ? CHAIN_PHASE.DRAW : CHAIN_PHASE.GUESS;

    if (type === STEP.DRAWING) this.api.resetCanvas();   // 作画从空白开始

    // 写词格：给每人发一组候选词（本轮用过的词不再出现）
    if (type === STEP.WORD) {
      const pool = WORDS.poolForTheme(this.theme);
      const used = [];
      for (const c of this.chains) {
        const w = c.steps[0] && c.steps[0].content;
        if (typeof w === 'string' && w) used.push(w);
      }
      for (const p of this.playerList()) {
        this.stepChoices.set(p.userId, pickWords(pool, P.GAME.CHAIN_PICK_CHOICES, used));
      }
    }

    this.deadline = Date.now() + this.stepMs();
    this.taskVersion += 1;
    this.api.sync();
    this.announceStep();
  }

  announceStep() {
    const label = CHAIN_PHASE_LABEL[this.phase] || '';
    const secs = Math.round(this.stepMs() / 1000);
    const n = this.chains.length;
    const type = this.stepTypeOf(this.stepIndex);
    const what = type === STEP.WORD ? '写初始词' : type === STEP.DRAWING ? '照词作画' : '看画猜词';
    this.api.systemChat('第 ' + (this.stepIndex + 1) + ' / ' + this.chainLength
      + ' 手 · ' + what + '（' + n + ' 人并行，' + secs + ' 秒）—— ' + label);
  }

  /** 交格子。WORD/GUESS 带文本；DRAWING 只是「画好了」的信号（笔迹收格时从笔迹表抓） */
  submit(userId, payload) {
    if (!this.isPlaying()) return { ok: false, message: '现在没有要交的东西' };
    const chain = this.cellOf(userId, this.stepIndex);
    if (!chain) return { ok: false, message: '这一步没有你的事' };
    if (this.submitted.has(userId)) return { ok: false, message: '你已经提交过了' };
    const type = this.stepTypeOf(this.stepIndex);

    if (type === STEP.WORD || type === STEP.GUESS) {
      const word = String((payload && payload.text) || '').trim();
      const chk = validateWord(word, type === STEP.WORD ? 12 : P.GAME.CHAIN_MAX_GUESS_LEN,
        { strict: type === STEP.WORD });
      if (!chk.ok) return chk;
      this.pendingText.set(userId, word);
    } else {
      // DRAWING：笔迹已在房间里（STROKE_* 照常走），这里只记「这人交了」
      this.pendingText.delete(userId);
    }
    this.submitted.add(userId);
    this.api.sync();
    // 全场交齐 → 立刻收格（不等 deadline）
    if (this.submitted.size >= this.ring.length) this.finalizeStep();
    return { ok: true };
  }

  /**
   * 收格：把每条链的第 k 格写进去 → 进入下一格 / 回放。
   *
   * DRAWING 的 content = 作者此刻在房间笔迹表里的全部笔迹
   * （私密作画期间笔迹不广播但都进表；作画阶段画布是独占的，
   *   表里这阶段的笔迹只可能出自当格作者 —— 按作者过滤只是双保险）。
   */
  finalizeStep() {
    if (!this.isPlaying()) return;
    const k = this.stepIndex;
    const type = this.stepTypeOf(k);
    const now = Date.now();

    for (const chain of this.chains) {
      const n = this.ring.length;
      const ownerIdx = this.ring.indexOf(chain.ownerPlayerId);
      const who = ownerIdx >= 0 ? this.ring[(ownerIdx + k) % n] : '';
      const did = this.submitted.has(who);
      let content;
      if (type === STEP.DRAWING) content = did ? this.captureStrokes(who) : [];
      else content = this.pendingText.get(who) || '';
      // 「这一手没交成」= 没交，**或者交了但是空的** ——
      // 离场者会被 onLeave 标记成「已交」以放行收格，但内容是空的；
      // 画手点了交却一笔没画同理。回放与首尾判定都把空格当「没交」看。
      const empty = (type === STEP.DRAWING) ? !content.length : !content;
      chain.steps[k] = {
        playerId: who,
        type: type,
        content: content,
        timestamp: now,
        skipped: !did || empty
      };
      chain.currentStep = k + 1;
    }

    const skipped = [];
    for (const uid of this.ring) {
      if (!this.submitted.has(uid)) skipped.push(this.names.get(uid) || '某人');
    }
    if (skipped.length) {
      this.api.systemChat('超时：' + skipped.join('、') + ' 这一手没交，按空格处理');
    }

    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();

    // 作画结束：把画布清干净（笔迹已经收进链条，不再留在共享画布上）
    if (this.phase === CHAIN_PHASE.DRAW) this.api.resetCanvas();

    if (k + 1 >= this.chainLength) return this.enterReveal();
    this.enterStep(k + 1);
  }

  /** 从房间笔迹表里摘出某人的笔迹（带上限），作为 DRAWING 格的 content */
  captureStrokes(userId) {
    const src = (this.room.strokes || []).filter(s => s && s.userId === userId);
    const out = [];
    let pts = 0;
    for (const s of src) {
      if (out.length >= MAX_STROKES_PER_ART) break;
      const stroke = {
        id: s.id, layerId: s.layerId, tool: s.tool || 'brush',
        target: s.target === 'mask' ? 'mask' : 'layer',
        color: s.color || '#000000', size: s.size || 6,
        opacity: s.opacity == null ? 1 : s.opacity,
        hardness: s.hardness, minSize: s.minSize, pressSize: s.pressSize,
        pressOpacity: s.pressOpacity, edge: s.edge, scatter: s.scatter,
        grain: s.grain, grainScale: s.grainScale, paper: s.paper, fx: s.fx,
        points: (s.points || []).slice(),
        ts: s.ts || 0, te: s.te || 0
      };
      pts += stroke.points.length;
      if (pts > MAX_POINTS_PER_ART) {
        const allow = Math.max(0, MAX_POINTS_PER_ART - (pts - stroke.points.length));
        stroke.points = stroke.points.slice(0, allow);
        out.push(stroke);
        break;
      }
      out.push(stroke);
    }
    return out;
  }

  /* ------------------------------------------------------------ 回放与投票 */

  /** 全部格子收完 → 组装回放数据并广播（内容从此公开） */
  enterReveal() {
    this.stepIndex = this.chainLength;
    for (const c of this.chains) {
      c.status = 'complete';
      c.currentStep = c.steps.length;
    }
    this.revealData = this.chains.map(c => {
      const firstWord = (c.steps[0] && typeof c.steps[0].content === 'string') ? c.steps[0].content : '';
      let lastWord = '';
      for (let i = c.steps.length - 1; i >= 1; i--) {
        if (c.steps[i] && c.steps[i].type === STEP.GUESS) { lastWord = c.steps[i].content || ''; break; }
      }
      return {
        chainId: c.chainId,
        ownerPlayerId: c.ownerPlayerId,
        ownerName: this.names.get(c.ownerPlayerId) || c.ownerName,
        firstWord: firstWord,
        lastWord: lastWord,
        // 服务端先给一个初判（宽松匹配），最终由玩家投票裁定
        matched: answerMatch(firstWord, lastWord),
        steps: c.steps.map(s => ({
          playerId: s.playerId,
          playerName: this.names.get(s.playerId) || '某人',
          type: s.type,
          content: s.content,
          timestamp: s.timestamp,
          skipped: !!s.skipped
        }))
      };
    });
    this.revealVersion += 1;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.phase = CHAIN_PHASE.REVEAL;
    this.deadline = Date.now() + CFG.REVEAL_MS;
    this.api.sync();
    this.api.revealAll(this.revealData, this.revealVersion);
    this.api.systemChat('全部传完了！回放开始 —— 看看每条链是怎么跑偏的');
  }

  /** 投「这条链首尾还对得上吗」 */
  keepVote(userId, chainId, agree) {
    if (this.phase !== CHAIN_PHASE.VOTE) return { ok: false, message: '现在不是投票阶段' };
    const chain = this.chains.find(c => c.chainId === chainId);
    if (!chain) return { ok: false, message: '没有这条链' };
    let m = this.votesKeep.get(userId);
    if (!m) { m = new Map(); this.votesKeep.set(userId, m); }
    m.set(chainId, !!agree);
    this.api.sync();
    return { ok: true };
  }

  /** 投「最喜欢的一张画」（一人一票，可改） */
  favVote(userId, chainId, stepIdx) {
    if (this.phase !== CHAIN_PHASE.VOTE) return { ok: false, message: '现在不是投票阶段' };
    const chain = this.chains.find(c => c.chainId === chainId);
    if (!chain) return { ok: false, message: '没有这条链' };
    const k = Math.floor(Number(stepIdx));
    const st = chain.steps[k];
    if (!st || st.type !== STEP.DRAWING) return { ok: false, message: '那一格不是一幅画' };
    if (!Array.isArray(st.content) || !st.content.length) return { ok: false, message: '那是一张空画' };
    this.votesFav.set(userId, { chainId: chain.chainId, step: k });
    this.api.sync();
    return { ok: true };
  }

  /** 投票阶段结束 → 结算分数 */
  finishVote() {
    const players = this.playerList();
    // **只算本局环里的人投的票**：看客与离场者不进分母，也不该掀翻任何一条链
    const ringSet = new Set(this.ring);
    const totalPlayers = Math.max(1, this.ring.length);

    const chainRows = this.chains.map(c => {
      const firstWord = (c.steps[0] && typeof c.steps[0].content === 'string') ? c.steps[0].content : '';
      let lastWord = '';
      for (let i = c.steps.length - 1; i >= 1; i--) {
        if (c.steps[i] && c.steps[i].type === STEP.GUESS) { lastWord = c.steps[i].content || ''; break; }
      }
      let against = 0;
      for (const [uid, m] of this.votesKeep) {
        if (!ringSet.has(uid)) continue;
        if (m.get(c.chainId) === false) against += 1;
      }
      const matched = answerMatch(firstWord, lastWord);
      const ok = matched && against * 2 < totalPlayers;
      if (ok && c.ownerPlayerId) {
        const pts = P.GAME.CHAIN_TROPHY_AGREE;
        this.scores.set(c.ownerPlayerId, (this.scores.get(c.ownerPlayerId) || 0) + pts);
      }
      return {
        chainId: c.chainId,
        ownerPlayerId: c.ownerPlayerId,
        ownerName: this.names.get(c.ownerPlayerId) || c.ownerName,
        firstWord, lastWord, matched, against, won: ok
      };
    });

    // 最喜欢的一张画：票最高的 DRAWING 格（平票各拿安慰分）
    const tally = new Map(); // 'chainId:step' -> count
    for (const [uid, fav] of this.votesFav) {
      if (!ringSet.has(uid) || !fav) continue;
      const key = fav.chainId + ':' + fav.step;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    let top = 0;
    for (const n of tally.values()) if (n > top) top = n;
    const winners = [];
    if (top > 0) {
      for (const [key, n] of tally) {
        if (n !== top) continue;
        const ci = key.indexOf(':');
        const chainId = key.slice(0, ci), k = Number(key.slice(ci + 1));
        const chain = this.chains.find(c => c.chainId === chainId);
        const st = chain && chain.steps[k];
        if (!st || st.type !== STEP.DRAWING) continue;
        const name = this.names.get(st.playerId) || '某人';
        winners.push({ chainId, step: k, playerId: st.playerId, playerName: name, votes: n });
        this.scores.set(st.playerId,
          (this.scores.get(st.playerId) || 0) +
          (winners.length === 1 ? P.GAME.CHAIN_FAV_POINTS : P.GAME.CHAIN_FAV_TIE_POINTS));
      }
    }

    this.voteResult = { chains: chainRows, fav: winners, favTie: winners.length > 1 };
    this.phase = CHAIN_PHASE.SCORE;
    this.deadline = Date.now() + CFG.SCORE_MS;
    this.api.sync();

    const kept = chainRows.filter(r => r.won);
    if (kept.length) {
      this.api.systemChat('首尾对上的链有 ' + kept.length + ' 条：'
        + kept.map(w => w.ownerName + '（' + w.firstWord + '）').join('、'));
    } else {
      this.api.systemChat('这一局全军覆没 —— 没有一条链安全到达终点');
    }
    if (winners.length === 1) {
      this.api.systemChat('最受欢迎的画出自 ' + winners[0].playerName + '（'
        + winners[0].votes + ' 票）');
    } else if (winners.length > 1) {
      this.api.systemChat('最受欢迎的画平票：' + winners.map(w => w.playerName).join('、'));
    }
  }

  /** 回放阶段结束 → 进投票 */
  enterVote() {
    this.phase = CHAIN_PHASE.VOTE;
    this.deadline = Date.now() + CFG.VOTE_MS;
    this.api.sync();
    this.api.systemChat('投票开始：每条链「首尾还对得上吗」+ 选出你最喜欢的一张画');
  }

  /** 结算阶段结束 → 回大厅（分数保留，可再来一局） */
  toLobby() {
    this.phase = CHAIN_PHASE.LOBBY;
    this.deadline = 0;
    this.stepIndex = 0;
    this.chains = [];
    this.ring = [];
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.revealData = null;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.voteResult = null;
    this.ready.clear();
    this.api.sync();
    this.api.systemChat('回到接龙大厅 —— 点「准备」再来一局（分数保留）');
  }

  /**
   * 房主按「立刻推进」：
   *   大厅   —— 全员视为已准备，直接开局
   *   写/画/猜 —— 不等超时，把没交的按「空」处理并收格
   *   回放   —— 进入投票
   *   投票   —— 立刻结算
   *   结算   —— 回大厅
   * 返回 { ok, message }
   */
  next(userId) {
    if (!this.isOwner(userId)) return { ok: false, message: '只有房主可以推进' };
    if (this.phase === CHAIN_PHASE.LOBBY) {
      const players = this.playerList();
      if (players.length < P.GAME.CHAIN_MIN_PLAYERS) {
        return { ok: false, message: '人数不足，开不了局' };
      }
      players.forEach(p => this.ready.add(p.userId));
      this.beginGame();
      return { ok: true };
    }
    if (this.isPlaying()) { this.finalizeStep(); return { ok: true }; }
    if (this.phase === CHAIN_PHASE.INIT) {
      this.enterStep(0);
      return { ok: true };
    }
    if (this.phase === CHAIN_PHASE.REVEAL) { this.enterVote(); return { ok: true }; }
    if (this.phase === CHAIN_PHASE.VOTE) { this.finishVote(); return { ok: true }; }
    if (this.phase === CHAIN_PHASE.SCORE) { this.toLobby(); return { ok: true }; }
    return { ok: false, message: '现在没什么可推进的' };
  }

  /* ------------------------------------------------------------ 时钟与收尾 */

  tick(nowMs) {
    if (!this.active || !this.deadline) return;
    if (nowMs < this.deadline) return;
    // 写/画/猜：deadline 之后留一小段宽限再收格（客户端的自动提交还在路上）
    if (this.isPlaying()) {
      if (nowMs < this.deadline + CFG.GRACE_MS) return;
      return this.finalizeStep();
    }
    if (this.phase === CHAIN_PHASE.INIT) return this.enterStep(0);
    if (this.phase === CHAIN_PHASE.REVEAL) return this.enterVote();
    if (this.phase === CHAIN_PHASE.VOTE) return this.finishVote();
    if (this.phase === CHAIN_PHASE.SCORE) return this.toLobby();
  }

  stop() {
    this.spectators.clear();
    this.phase = CHAIN_PHASE.OFF;
    this.deadline = 0;
    this.ring = [];
    this.chains = [];
    this.stepIndex = 0;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.revealData = null;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.voteResult = null;
    this.ready.clear();
    this.api.sync();
  }

  /* ------------------------------------------------------------ 成员变动 */

  onJoin(member) {
    if (!this.active) return;
    if (!this.names.has(member.userId)) this.names.set(member.userId, member.name);
    if (!this.scores.has(member.userId)) this.scores.set(member.userId, 0);
    // 局中（含回放/投票）进房：本局只能旁边看 —— 链已经冻结，插人会弄拧每一格
    if (this.midGame()) {
      this.spectators.add(member.userId);
      this.api.systemChat(member.name + ' 加入了，本局接龙进行中，先观战 —— 下一局自动入伙');
      this.api.sync();
      return;
    }
    this.api.sync();
  }

  onLeave(member) {
    if (!this.active) return;
    if (this.spectators.has(member.userId)) {
      this.spectators.delete(member.userId);
      this.api.sync();
      return;
    }
    if (this.phase === CHAIN_PHASE.LOBBY) {
      this.ready.delete(member.userId);
      this.api.sync();
      // 他一走剩下的可能刚好全准备完了 → 自动开局
      this.checkAllReady();
      return;
    }
    if (this.isPlaying() || this.phase === CHAIN_PHASE.INIT) {
      // 走的人手里可能有活：按「没交」处理，收格时按空格写进链条
      if (!this.submitted.has(member.userId)) {
        this.submitted.add(member.userId);
        this.api.systemChat(this.names.get(member.userId) || member.name + ' 离开了，TA 这一格按空处理');
        if (this.ring.length && this.submitted.size >= this.ring.length) {
          this.finalizeStep();
          return;
        }
      }
    }
    this.api.sync();
  }
}

/** 当前格的类型（snapshotFor 用的小工具） */
function cellStepType(g, k) { return g.stepTypeOf(k); }

/** 词的基本校验（写词与猜词共用） */
function validateWord(word, maxLen, opts) {
  if (!word) return { ok: false, message: '得写点什么' };
  const limit = maxLen || 12;
  if (word.length > limit) return { ok: false, message: '太长了（最多 ' + limit + ' 个字）' };
  // 出题（写初始词）走「能玩的词」那套：中文 / 英文 / 数字都行，**一个字也行**
  //（以前这里要求必须含中文，英文词和一个字的梗全被挡在外面）。
  // 猜词是自由输入，不套这条 —— 别因为用户多打了一个标点就把人挡回去。
  if (opts && opts.strict && !P.isPlayableWord(word, limit)) {
    return { ok: false, message: '别带空格写，最多 ' + limit + ' 个字符' };
  }
  return { ok: true };
}

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * 回放里「首尾对得上吗」的**宽松判定**。
 *
 * 接龙的终点不是 OCR —— 最后那个词是另一个人看图猜出来的，指望它一字不差
 * 等于把奖杯交给运气。所以除了完全相同，以下都算「对上了」：
 *   - 一方包含另一方（「长颈鹿」vs「一只长颈鹿」）
 *   - 去掉常见量词 / 助词后相同（「一只猫」vs「小猫」→ 都归一成「猫」）
 *   - 编辑距离 ≤ 1 的短词（「奶茶」vs「奶菜」这种一字之差，不该判死刑）
 * 最终裁定权仍在玩家投票（见 finishVote）。
 */
const STOPWORDS = ['一只', '一个', '一条', '一头', '一匹', '一栋', '一辆', '一架', '一朵', '一棵',
  '的', '了', '个', '只', '条', '头', '匹', '辆', '架', '朵', '棵', '们', '是', '在'];

/**
 * 常见的「词尾修饰字」：小猫 / 猫咪 / 老猫 指的是同一只猫。
 * 归一化时逐个剥掉，让「猫咪」「小猫」「猫」都落回「猫」。
 * 只在**长度 ≥ 3** 时才敢剥，否则「小」这种单字词会被剥成空串。
 */
const MORPH = ['小', '大', '老', '子', '儿', '咪', '阿'];

/** 剥掉词首词尾的修饰字（一直剥到不能再剥） */
function stripMorph(s) {
  let t = s;
  for (;;) {
    if (t.length <= 1) break;
    const head = t.charAt(0), tail = t.charAt(t.length - 1);
    if (MORPH.indexOf(head) >= 0) { t = t.slice(1); continue; }
    if (MORPH.indexOf(tail) >= 0) { t = t.slice(0, -1); continue; }
    break;
  }
  return t;
}

function simplify(s) {
  let t = norm(s);
  if (!t) return '';
  for (const w of STOPWORDS) t = t.split(w).join('');
  return stripMorph(t);
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function answerMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
  const sx = simplify(a), sy = simplify(b);
  if (sx && sy) {
    if (sx === sy) return true;
    if (sx.indexOf(sy) >= 0 || sy.indexOf(sx) >= 0) return true;
    const minLen = Math.min(sx.length, sy.length);
    if (minLen >= 2 && minLen <= 4 && editDistance(sx, sy) <= 1) return true;
  }
  return false;
}

module.exports = {
  ChainGame,
  CHAIN_PHASE,
  CHAIN_PHASE_LABEL,
  STEP,
  CFG,
  answerMatch,   // 导出供自检脚本直接验证「首尾算不算对得上」
  simplify,      // 上面这条依赖的归一化（测试要看中间值）
  norm
};
