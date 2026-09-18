'use strict';

/**
 * 你画我猜 · 回合状态机（服务端权威）
 *
 * 设计要点：
 *   1. **一切裁定都在服务端**：谁当画手、什么词、还剩几秒、谁猜对了、得几分。
 *      客户端只拿 deadline 做倒计时显示，改前端改不出分。
 *   2. **答案只私发给画手**：所有广播出去的状态都经过 snapshotFor() 裁剪，
 *      非画手拿到的 snapshot 里 word 恒为空字符串。
 *   3. **聊天即猜词**：游戏进行中的 text 聊天由 index.js 先交给这里比对，
 *      猜对了广播「谁猜对了」，猜错了才当成普通聊天发出去。
 *   4. 游戏状态**不落盘**（不走 rooms.js 的 save），服务端重启就是一局结束，
 *      免得重启后冒出一个「半局游戏」。
 *
 * 时序（见 README）：大厅 → 选词 → 作画+猜 → 回合结算 → 下一回合 / 结束
 */

const P = require('./protocol');
const WORDS = require('./words');
const THEMES = require('./themes');

const PHASE = {
  OFF: 'off',              // 不在游戏模式，房间就是普通协作画布
  LOBBY: 'lobby',          // 游戏模式已开启，等房主点开始
  PICK: 'pick',            // 画手选词
  DRAW: 'draw',            // 作画 + 猜
  ROUND_END: 'round_end',  // 回合结算展示
  OVER: 'over'             // 本局结束，显示排名
};

const PHASE_LABEL = {
  off: '自由绘画',
  lobby: '等待开始',
  pick: '选词中',
  draw: '作画中',
  round_end: '回合结束',
  over: '本局结束'
};

function clampInt(v, d, a, b) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return d;
  return n < a ? a : n > b ? b : n;
}

function envMs(key, dflt) {
  const n = Math.floor(Number(process.env[key]));
  return isFinite(n) && n > 0 ? n : dflt;
}

/**
 * 时长可由环境变量覆盖 —— 自动化测试要靠它把一局压到几秒钟，
 * 否则每跑一次测试都得真等 80 秒。线上用协议里的默认值。
 */
const CFG = {
  PICK_MS: envMs('GAME_PICK_MS', P.GAME.PICK_MS),
  ROUND_MS: envMs('GAME_ROUND_MS', P.GAME.ROUND_MS),
  ROUND_END_MS: envMs('GAME_ROUND_END_MS', P.GAME.ROUND_END_MS)
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

class Game {
  /**
   * @param {Room} room
   * @param {{sync:Function, systemChat:Function, resetCanvas:Function}} api
   *        api 由 index.js 注入（game.js 不直接碰 WebSocket）
   */
  constructor(room, api) {
    this.room = room;
    this.api = api;
    this.mode = 'classic';       // 房间上可能挂着不同玩法的状态机，靠它区分（见 index.js 的 GAME_MODES）
    this.phase = PHASE.OFF;
    this.rounds = P.GAME.DEFAULT_ROUNDS;
    this.round = 0;
    this.drawerId = '';
    this.drawerName = '';
    this.word = '';
    this.choices = [];
    this.usedWords = [];
    this.scores = new Map();     // userId -> 累计分
    this.names = new Map();      // userId -> 昵称（人走了也要能显示榜单）
    this.guessed = new Map();    // userId -> 名次（1 起）
    this.guessOrder = [];        // 本回合猜对的顺序
    this.order = [];             // 出场顺序（开局时快照）
    this.orderIdx = -1;
    this.deadline = 0;           // 当前阶段的截止时刻（ms）
    this.roundResult = null;
    this.startedAt = 0;
    this.hint = null;            // 本回合的露字提示 { index, char }，没给提示时为 null
    this.repickLeft = 0;         // 本回合画手还能「换一组」几次
    this.theme = '';             // 本局用的主题词库（'' = 通用词库），开局时定下
    this.themeName = '';
    this.drawMs = 0;             // 本局的作画时长覆盖值（0 = 用全局默认 CFG.ROUND_MS）
    // 中途进房的人：本回合先在旁边看，下一回合转正（见 onJoin / promoteSpectators）。
    // 他们**不在** playerList 里 —— 那一个池子决定「谁当画手」和「还差几个人没猜出来」，
    // 把看客算进去的话每回合都要干等到超时。
    this.spectators = new Set();
  }

  /** 本局的作画时限。开局设置里自定义的优先，否则用环境变量 / 协议默认 */
  roundMs() { return this.drawMs || CFG.ROUND_MS; }

  /* ------------------------------------------------------------ 查询 */

  get active() { return this.phase !== PHASE.OFF; }

  /** 是否处于「回合进行中」（选词 / 作画） */
  isPlaying() { return this.phase === PHASE.PICK || this.phase === PHASE.DRAW; }

  /**
   * 该用户此刻能不能改画布。
   * 选词阶段谁都别画（画布刚清空）；作画阶段只有画手能画；
   * 结算展示阶段全员只读；大厅 / 结束 / 关闭时自由绘画。
   */
  lockedFor(userId) {
    if (this.phase === PHASE.PICK || this.phase === PHASE.ROUND_END) return true;
    if (this.phase === PHASE.DRAW) return userId !== this.drawerId;
    return false;
  }

  /** 这一局已经开了、还没完（大厅 / 整局结束之外都算「局中」） */
  midGame() {
    return this.phase === PHASE.PICK || this.phase === PHASE.DRAW || this.phase === PHASE.ROUND_END;
  }

  /**
   * 把旁听的看客转成正式玩家（新回合开始时调用）。
   * 还在房间里的人补进出场顺序 + 计分表；已经走掉的就直接丢掉。
   */
  promoteSpectators() {
    if (!this.spectators.size) return;
    for (const id of Array.from(this.spectators)) {
      this.spectators.delete(id);
      const m = this.memberOf(id);
      if (!m || m.readonly) continue;          // 人走了 / 变成了观众：不进来
      if (this.order.indexOf(id) < 0) this.order.push(id);
      if (!this.scores.has(id)) this.scores.set(id, 0);
    }
  }

  /**
   * 在线玩家（画手从这个池子里选，猜词也只认池子里的人）。
   *
   * **只读观众不在池子里** —— 他画不了，抽到他这回合就废了；
   * 也顺带意味着「只剩观众」时开局会因为人不够而被拒。
   * **本回合的看客也不在池子里**（同一个道理：他还没拿到题面，猜不出来）。
   */
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

  scoreList() {
    const rows = [];
    for (const [userId, score] of this.scores) {
      rows.push({
        userId,
        name: this.names.get(userId) || '某人',
        online: !!this.memberOf(userId),
        score
      });
    }
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /** 供 index.js 判断「该不该拦住这条写操作」 */
  blocksWrite(userId) { return this.lockedFor(userId); }

  addScore(userId, pts) {
    if (!userId || !pts) return;
    this.scores.set(userId, (this.scores.get(userId) || 0) + pts);
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 按收件人裁剪过的状态。
   * **这里是答案泄露的唯一防线** —— 任何新增字段都要先想清楚「猜手能不能看」。
   */
  snapshotFor(userId) {
    const isDrawer = !!userId && userId === this.drawerId;
    // 回合结束后答案本来就公开了（结算面板要显示）
    const revealed = this.phase === PHASE.ROUND_END || this.phase === PHASE.OVER;
    return {
      mode: 'classic',          // 前端靠它决定渲染哪一套 HUD（接龙是 'chain'）
      phase: this.phase,
      phaseLabel: PHASE_LABEL[this.phase] || this.phase,
      rounds: this.rounds,
      round: this.round,
      drawerId: this.drawerId,
      drawerName: this.drawerName,
      deadline: this.deadline,
      serverNow: Date.now(),
      // 本局的词库与作画时长（开局面板里选的），前端展示用
      theme: this.theme || null,
      themeName: this.themeName || null,
      drawSeconds: Math.round(this.roundMs() / 1000),
      // 主题菜单（只有 id + 名字，没有词）—— 和接龙快照同源，开局前前端
      // 拿不到快照时才靠 /api/share 的 themeList 垫底
      themes: THEMES.themeList(),
      // 词：只有画手本人（或结算之后）才拿得到明文
      word: (isDrawer || revealed) ? this.word : '',
      // 字数提示给所有人看 —— 这类游戏的常规做法（等于把答案显示成「□□□」），
      // 选词阶段 word 还是空的，所以不会提前泄露
      wordLen: this.word ? this.word.length : 0,
      // 候选词只有画手在选词阶段能看到（泄露候选 = 把答案范围缩到三个）
      choices: (isDrawer && this.phase === PHASE.PICK) ? this.choices : [],
      // 还能「换一组」几次，同上：只有选词阶段的画手关心
      repickLeft: (isDrawer && this.phase === PHASE.PICK) ? this.repickLeft : 0,
      // 露字提示：只带「第几位是什么字」，绝不带整个词。
      // 对画手无所谓（他本来就知道答案），但也没必要专门为他裁掉。
      hint: this.hint,
      locked: this.lockedFor(userId),
      isDrawer,
      // 中途进房、这一回合只能看：前端据此显示提示条，不然会以为画布坏了
      spectating: this.spectators.has(userId),
      canStart: this.phase === PHASE.LOBBY || this.phase === PHASE.OVER,
      scores: this.scoreList(),
      guessed: this.guessOrder.map((id, i) => ({
        userId: id, name: this.names.get(id) || '某人', rank: i + 1
      })),
      // 提示：给猜手看「还差几个人没猜出来」比看空面板友好
      guessersTotal: Math.max(0, this.playerList().length - (this.drawerId ? 1 : 0)),
      roundResult: revealed ? this.roundResult : null,
      minPlayers: P.GAME.MIN_PLAYERS
    };
  }

  /* ------------------------------------------------------------ 流程 */

  /** 房主开局 */
  /**
   * 开一局。
   * @param opts {number | {rounds, theme, drawSeconds}} 兼容旧的纯数字（=轮数）写法；
   *        theme 是 themes.js 里的词库 id（'' = 通用），drawSeconds 单位秒。
   */
  start(opts) {
    if (typeof opts === 'number') opts = { rounds: opts };
    opts = opts || {};
    this.spectators.clear();          // 开局了：房间里的人都算玩家，不再有看客
    const players = this.playerList();
    if (players.length < P.GAME.MIN_PLAYERS) {
      return { ok: false, code: 'too_few', message: '至少要有 ' + P.GAME.MIN_PLAYERS + ' 个人才能开局' };
    }
    this.rounds = clampInt(opts.rounds, P.GAME.DEFAULT_ROUNDS, 1, P.GAME.MAX_ROUNDS);
    this.theme = (opts.theme && THEMES.hasTheme(opts.theme)) ? opts.theme : '';
    this.themeName = this.theme ? THEMES.nameOf(this.theme) : '';
    const sec = Math.floor(Number(opts.drawSeconds));
    this.drawMs = (isFinite(sec) && sec > 0)
      ? clampInt(sec, P.GAME.DRAW_SECONDS_DEFAULT, P.GAME.DRAW_SECONDS_MIN, P.GAME.DRAW_SECONDS_MAX) * 1000
      : 0;
    this.round = 0;
    this.usedWords = [];
    this.roundResult = null;
    this.startedAt = Date.now();
    this.scores = new Map();
    players.forEach(p => this.scores.set(p.userId, 0));
    this.order = shuffle(players.map(p => p.userId));
    this.orderIdx = -1;
    this.phase = PHASE.LOBBY;
    this.beginRound();
    return { ok: true };
  }

  /** 开始一回合：选画手 → 发候选词 → 清空画布 */
  beginRound() {
    // 上一回合旁听的看客：新回合开始时转正（他们等的就是这个时刻）
    this.promoteSpectators();
    const online = this.playerList();
    if (online.length < P.GAME.MIN_PLAYERS) return this.toLobby('人数不足，已回到等待状态');

    this.round += 1;
    this.guessed = new Map();
    this.guessOrder = [];
    this.roundResult = null;
    this.hint = null;
    this.hintShown = false;
    this.repickLeft = P.GAME.REPICK_LIMIT;

    // 按开局时定下的顺序轮流出场；有人中途跑了就跳过（最多绕两圈，避免死循环）
    const onlineIds = online.map(p => p.userId);
    let pickId = '';
    if (!this.order.length) this.order = shuffle(onlineIds);
    for (let i = 0; i < this.order.length * 2 + 2; i++) {
      this.orderIdx = (this.orderIdx + 1) % this.order.length;
      const id = this.order[this.orderIdx];
      if (onlineIds.indexOf(id) >= 0) { pickId = id; break; }
    }
    if (!pickId) pickId = onlineIds[0];          // 兜底：一个都没匹配上就取第一个在线的

    this.drawerId = pickId;
    this.drawerName = this.names.get(pickId) || '某人';
    this.choices = WORDS.pickChoices(P.GAME.CHOICES, this.usedWords, WORDS.poolForTheme(this.theme));
    this.word = this.choices.length === 1 ? this.choices[0] : '';

    // 新回合一律从干净画布开始（服务端清空 + 广播，客户端跟着重建）
    this.api.resetCanvas();

    if (this.word) return this.beginDraw();      // 词库只剩一个候选，不用选

    this.phase = PHASE.PICK;
    this.deadline = Date.now() + CFG.PICK_MS;
    this.api.sync();
    this.api.systemChat('第 ' + this.round + ' 回合：' + this.drawerName + ' 来画，请在 '
      + Math.round(CFG.PICK_MS / 1000) + ' 秒内选一个词');
  }

  /** 进入作画阶段 */
  beginDraw() {
    if (!this.word) return this.toLobby('词库取词失败');
    this.phase = PHASE.DRAW;
    this.deadline = Date.now() + this.roundMs();
    this.guessed = new Map();
    this.guessOrder = [];
    if (this.usedWords.indexOf(this.word) < 0) this.usedWords.push(this.word);
    this.api.sync();
    this.api.systemChat('开始作画！' + this.drawerName + ' 画的是 ' + this.word.length
      + ' 个字（' + (this.themeName ? '词库：' + this.themeName + '，' : '通用词库，')
      + Math.round(this.roundMs() / 1000) + ' 秒），其他人请在聊天框里猜');
  }

  /** 选词超时：随便挑一个，别让全场干等 */
  autoPick() {
    if (this.phase !== PHASE.PICK) return;
    const w = this.choices[Math.floor(Math.random() * this.choices.length)];
    this.word = w || '';
    if (!this.word) return this.toLobby('选词超时');
    this.api.systemChat(this.drawerName + ' 没来得及选词，系统替他挑了一个');
    this.beginDraw();
  }

  /** 画手选词 */
  pick(userId, index) {
    if (this.phase !== PHASE.PICK) return { ok: false, message: '现在不是选词阶段' };
    if (userId !== this.drawerId) return { ok: false, message: '只有画手可以选词' };
    const w = this.choices[clampInt(index, -1, 0, this.choices.length - 1)];
    if (!w) return { ok: false, message: '没有这个候选词' };
    this.word = w;
    this.beginDraw();
    return { ok: true };
  }

  /**
   * 画手换一组候选词（选词阶段）。
   * 必须有次数上限 —— 不限次的话画手能一直刷到最容易画的词，
   * 其他人就在那儿干等。被换掉的那组也记进 usedWords，免得下一组又刷回来。
   */
  repick(userId) {
    if (this.phase !== PHASE.PICK) return { ok: false, message: '现在不是选词阶段' };
    if (userId !== this.drawerId) return { ok: false, message: '只有画手可以换词' };
    if (this.repickLeft <= 0) return { ok: false, message: '这一回合已经换过了' };
    this.repickLeft -= 1;
    this.choices.forEach(w => { if (this.usedWords.indexOf(w) < 0) this.usedWords.push(w); });
    // ⚠️ 第三个参数（主题词池）**必须带** —— 漏掉的话换出来的候选会掉回通用词库，
    // 表现就是「选了明日方舟，换一组之后冒出「长颈鹿」」。见 test-game 的「换一组不出题外词」。
    this.choices = WORDS.pickChoices(P.GAME.CHOICES, this.usedWords, WORDS.poolForTheme(this.theme));
    // 换完只剩一个候选就直接开画（和 beginRound 同一套兜底）
    this.word = this.choices.length === 1 ? this.choices[0] : '';
    if (this.word) { this.beginDraw(); return { ok: true }; }
    this.api.sync();
    return { ok: true };
  }

  /**
   * 露字提示：作画过半还没人猜出时，揭示答案里的一个字。
   *
   * 只带「第几位是什么字」，绝不带整个词；两字词不给（露一个等于给一半）。
   * hintShown 是「本回合已经判断过」的标记，避免每次 tick 都重算 ——
   * 也保证「不给提示」这个决定只做一次。
   */
  maybeHint(nowMs) {
    if (this.hintShown || this.phase !== PHASE.DRAW) return;
    const hintAt = this.deadline - Math.round(this.roundMs() * (1 - P.GAME.HINT_RATIO));
    if (nowMs < hintAt) return;
    this.hintShown = true;

    const guessers = Math.max(0, this.playerList().length - 1);
    if (guessers <= 0 || this.guessOrder.length >= guessers) return;   // 已经全猜完了
    if (!this.word || this.word.length < P.GAME.HINT_MIN_LEN) return;  // 太短，露字没意义

    const index = Math.floor(Math.random() * this.word.length);
    this.hint = { index, char: this.word.charAt(index) };
    this.api.systemChat('提示：答案的第 ' + (index + 1) + ' 个字是「'
      + this.hint.char + '」（' + this.hintMask() + '）');
    this.api.sync();
  }

  /** 拼「□猫□」这样的提示串（只露提示位，其余一律方块） */
  hintMask() {
    if (!this.word) return '';
    let out = '';
    for (let i = 0; i < this.word.length; i++) {
      out += (this.hint && this.hint.index === i) ? this.word.charAt(i) : '□';
    }
    return out;
  }

  /**
   * 处理一条「可能是猜词」的发言。
   * 返回：
   *   { kind:'correct', rank, points }  猜对了 —— 上层广播 GAME_CORRECT，原话不外发
   *   { kind:'near' }                   很接近 —— 上层私下告诉这个人
   *   { kind:'wrong' }                  猜错了 —— 上层当普通聊天广播
   *   null                              不算猜词（阶段不对 / 是画手 / 已经猜对过 / 太短）
   */
  handleGuess(member, text) {
    if (this.phase !== PHASE.DRAW) return null;
    if (!member) return null;
    if (member.userId === this.drawerId) return null;       // 画手的发言另作处理
    if (this.guessed.has(member.userId)) return null;       // 已经猜对的人不再计数
    const g = P.normGuess(text);
    if (!g) return null;
    if (g.length > P.GAME.MAX_GUESS_LEN) return null;       // 太长，当普通聊天
    if (g === P.normGuess(this.word)) {
      const rank = this.guessOrder.length + 1;
      this.guessOrder.push(member.userId);
      this.guessed.set(member.userId, rank);
      const pts = P.GAME.GUESS_POINTS[Math.min(rank - 1, P.GAME.GUESS_POINTS.length - 1)];
      this.addScore(member.userId, pts);
      this.addScore(this.drawerId, P.GAME.DRAWER_POINT_PER_GUESS);
      return { kind: 'correct', rank, points: pts };
    }
    if (P.isNearGuess(text, this.word)) return { kind: 'near' };
    return { kind: 'wrong' };
  }

  /**
   * 这条发言该不该被广播出去（游戏中的防剧透规则）。
   * 画手和**已经猜对的人**都可以发言（用户要求：能给提示 / 照常聊天），
   * 但话里不能带着答案 —— 「脖子长」可以，「长颈鹿」不行，
   * 连答案每个字都出现也不行（等于把词拼出来了）。
   * 带了答案的消息不外发，只给本人一条私密提醒。
   */
  chatLeaksAnswer(userId, text) {
    if (!this.isPlaying()) return false;
    const knows = userId === this.drawerId || this.guessed.has(userId);
    if (!knows) return false;
    return text ? this.messageContainsAnswer(text) : false;
  }

  /** 画手的提示消息有没有把答案带出去（整词命中，或答案的每个字都出现） */
  messageContainsAnswer(text) {
    if (!this.word) return false;
    const w = P.normGuess(this.word);
    const t = P.normGuess(text);
    if (!w || !t) return false;
    if (t.indexOf(w) >= 0) return true;
    if (w.length >= 2) {
      const chars = Array.from(w);
      if (chars.every(ch => t.indexOf(ch) >= 0)) return true;
    }
    return false;
  }

  /** 某人猜对了之后的收尾：全员猜出就直接结束这一回合 */
  afterCorrect() {
    const guessers = Math.max(0, this.playerList().length - 1);
    if (guessers > 0 && this.guessOrder.length >= guessers) this.endRound('all');
    else this.api.sync();
  }

  /** 结束本回合（timeout / all / drawer_left） */
  endRound(reason) {
    if (this.phase !== PHASE.DRAW) return;
    this.roundResult = {
      reason,
      word: this.word,
      drawerId: this.drawerId,
      drawerName: this.drawerName,
      round: this.round,
      guessed: this.guessOrder.map((id, i) => ({
        userId: id, name: this.names.get(id) || '某人', rank: i + 1
      })),
      missed: this.playerList()
        .filter(p => p.userId !== this.drawerId && !this.guessed.has(p.userId))
        .map(p => ({ userId: p.userId, name: p.name })),
      scores: this.scoreList()
    };
    this.phase = PHASE.ROUND_END;
    this.deadline = Date.now() + CFG.ROUND_END_MS;
    this.api.sync();
  }

  /** 结算展示结束 → 下一回合或整局结束 */
  nextRound() {
    if (this.round >= this.rounds) return this.finish();
    const online = this.playerList();
    if (online.length < P.GAME.MIN_PLAYERS) {
      // 中途有人走了：不硬撑，退回大厅，等够人再开
      this.phase = PHASE.LOBBY;
      this.deadline = 0;
      this.api.sync();
      this.api.systemChat('人数不足 ' + P.GAME.MIN_PLAYERS + ' 人，游戏已暂停。够人后房主可以再来一局');
      return;
    }
    this.beginRound();
  }

  finish() {
    this.spectators.clear();
    this.phase = PHASE.OVER;
    this.deadline = 0;
    this.word = '';
    this.api.sync();
    const top = this.scoreList()[0];
    this.api.systemChat('本局结束！' + (top ? '冠军是 ' + top.name + '（' + top.score + ' 分）' : ''));
  }

  /** 退回大厅（人不够 / 出错时的安全落点） */
  toLobby(reason) {
    // 已经不在局中了：旁听身份作废（重开一局时会按当时在场的人重新算）
    this.spectators.clear();
    this.phase = PHASE.LOBBY;
    this.deadline = 0;
    this.word = '';
    this.choices = [];
    this.drawerId = '';
    this.drawerName = '';
    this.roundResult = null;
    this.hint = null;
    this.hintShown = false;
    this.api.sync();
    if (reason) this.api.systemChat(reason);
  }

  /** 房主结束游戏，回到自由绘画 */
  stop() {
    this.spectators.clear();
    this.phase = PHASE.OFF;
    this.deadline = 0;
    this.word = '';
    this.choices = [];
    this.roundResult = null;
    this.drawerId = '';
    this.drawerName = '';
    this.guessed = new Map();
    this.guessOrder = [];
    this.hint = null;
    this.hintShown = false;
    this.repickLeft = 0;
    this.api.sync();
  }

  /**
   * 时钟推进（由 index.js 的全局 tick 调用）。
   * 只做「到点了就换阶段」这一件事，绝不做重活 —— 计时器里碰同步 IO
   * 会把整个房间的消息都堵在事件循环后面。
   */
  tick(nowMs) {
    if (!this.active || !this.deadline) return;
    // 露字提示要发生在「还没到点」的时候，所以必须排在下面那个 deadline 判断之前
    if (this.phase === PHASE.DRAW) this.maybeHint(nowMs);
    if (nowMs < this.deadline) return;
    if (this.phase === PHASE.PICK) return this.autoPick();
    if (this.phase === PHASE.DRAW) return this.endRound('timeout');
    if (this.phase === PHASE.ROUND_END) return this.nextRound();
  }

  /* ------------------------------------------------------------ 成员变动 */

  onJoin(member) {
    if (!this.active) return;
    this.names.set(member.userId, member.name);

    // 局中进房：**先当看客**。不进计分表、不算猜手（否则「大家都猜出来了」
    // 这个条件永远不成立，每回合都得等到超时），下一回合 beginRound 时转正。
    if (this.midGame()) {
      this.spectators.add(member.userId);
      this.api.systemChat(member.name + ' 加入了，本回合先观战，下一回合一起玩');
      this.api.sync();
      return;
    }

    // 大厅 / 整局结束：直接就是玩家（下次开局 order 会重建，自然带上他）
    if (!this.scores.has(member.userId)) this.scores.set(member.userId, 0);
    this.api.sync();
  }

  onLeave(member) {
    if (!this.active) return;
    // 走的是个看客：摘掉就完事，别去碰「还差几个猜手」那套判断
    if (this.spectators.has(member.userId)) {
      this.spectators.delete(member.userId);
      this.api.sync();
      return;
    }
    if (this.phase === PHASE.PICK && member.userId === this.drawerId) {
      // 还没开始画就走了：这一回合作废，停顿一下直接换人重开
      this.api.systemChat('画手 ' + member.name + ' 离开了，本回合作废，换人重来');
      this.word = '';
      this.choices = [];
      this.round -= 1;                  // 这一回合不算数
      this.roundResult = null;
      this.phase = PHASE.ROUND_END;     // 借用结算阶段做一次短暂停顿
      this.deadline = Date.now() + 1500;
      this.api.sync();
      return;
    }
    if (this.phase === PHASE.DRAW && member.userId === this.drawerId) {
      this.roundResult = {
        reason: 'drawer_left',
        word: this.word,
        drawerId: this.drawerId,
        drawerName: this.drawerName,
        round: this.round,
        guessed: this.guessOrder.map((id, i) => ({
          userId: id, name: this.names.get(id) || '某人', rank: i + 1
        })),
        missed: [],
        scores: this.scoreList()
      };
      this.phase = PHASE.ROUND_END;
      this.deadline = Date.now() + CFG.ROUND_END_MS;
      this.api.systemChat('画手 ' + member.name + ' 掉线了，本回合提前结束');
      this.api.sync();
      return;
    }
    // 猜手走了：可能正好满足「所有人都猜对了」
    if (this.phase === PHASE.DRAW) {
      const guessers = Math.max(0, this.playerList().length - 1);
      if (guessers > 0 && this.guessOrder.length >= guessers) return this.endRound('all');
    }
    if (this.playerList().length < P.GAME.MIN_PLAYERS) {
      if (this.phase === PHASE.LOBBY || this.phase === PHASE.OVER) return;
      this.toLobby('人数不足 ' + P.GAME.MIN_PLAYERS + ' 人，游戏已暂停');
      return;
    }
    this.api.sync();
  }
}

module.exports = { Game, PHASE, PHASE_LABEL, CFG };
