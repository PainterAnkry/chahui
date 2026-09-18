'use strict';

/**
 * 接龙模式（chain / 绘画版「拷贝不走样」）—— 服务端权威状态机。
 *
 * 玩法一句话：**每人起一个词 → 传给下一个人照画 → 再传给下一个人照画猜词……**
 * 绕圈走几轮之后，把整条链从头到尾摊开看 —— 一个「爱丽丝」是怎么变成「怪物卡车」的。
 *
 * 与经典模式（你画我猜）的关键差异：
 *   1. **阶段不是「回合」而是「步」**。一轮（round）= 每人都做了恰好一步。
 *      所以 phase 描述的是「这一步让大家做什么」：写词 / 作画 / 猜词 / 回放 / 投票。
 *   2. **产物在链条上流转**。每个人做完自己的那一步，产物就交给下一个人。
 *      传递规则固定：写下的词 → 下家作图 → 再下家看不懂就猜个词 → 再下家照猜出来的词作图……
 *      所以「词的作者」和「画的人」交替出现，「看图猜词」和「看词作画」交替进行。
 *   3. **每一步的输入只能给当事者**。看图猜词的人只能看到上一幅画，绝看不到词；
 *      看词作画的人只能看到词本身，绝看不到再往前的画。
 *      这是这游戏唯一的死穴 —— 泄一次，后面几步全废。见 taskFor()。
 *
 * 时间与计分全部在服务端裁定：客户端只拿 deadline 做倒计时显示。
 */

const P = require('./protocol');
const WORDS = require('./words');
const THEMES = require('./themes');

/** 接龙的阶段（与经典模式共用 'off' / 'lobby' / 'over' 三个终态） */
const CHAIN_PHASE = {
  OFF: 'off',
  LOBBY: 'lobby',
  WRITE: 'chain_write',       // 第一步：每人给自己的链写一个主题词
  DRAW: 'chain_draw',         // 这一步：手上是词，把它画出来
  GUESS: 'chain_guess',       // 这一步：手上是画，猜它是什么
  REPLAY: 'chain_replay',     // 回放：整条链一条条摊开
  VOTE: 'chain_vote',         // 投票：这条链首尾对得上吗
  OVER: 'over'
};

const CHAIN_PHASE_LABEL = {
  off: '自由绘画',
  lobby: '等待开始',
  chain_write: '写词中',
  chain_draw: '作画中',
  chain_guess: '猜词中',
  chain_replay: '回放中',
  chain_vote: '投票中',
  over: '本局结束'
};

/** 每一步的类型：写词 / 画 / 猜 */
const STEP = { WRITE: 'write', DRAW: 'draw', GUESS: 'guess' };

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
  WRITE_MS: envMs('GAME_CHAIN_WRITE_MS', P.GAME.CHAIN_WRITE_MS),
  DRAW_MS: envMs('GAME_CHAIN_DRAW_MS', P.GAME.CHAIN_DRAW_MS),
  REPLAY_MS: envMs('GAME_CHAIN_REPLAY_MS', P.GAME.CHAIN_REPLAY_MS)
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

/**
 * 一个「格子」= 链条上的一个位置：链 idx、第几步。
 * 每个人在每一圈都恰好占一个格子，所以 总格子数 = 链数 × 圈数。
 */

class ChainGame {
  /**
   * @param {Room} room
   * @param {{sync:Function, systemChat:Function, resetCanvas:Function}} api
   *   - sync()         把（按人裁剪过的）状态推给全场
   *   - systemChat()   系统播报
   *   - resetCanvas()  清空画布（只由 DRAW 步的首尾调用）
   *
   * ⚠ 作画的产物**不由服务端抓**：客户端把画布导成 PNG，走 C2S.GAME_ART 回传，
   *   服务端只做哑存储（submitArt）。服务端从头到尾不碰像素 —— 这与图层像素同一套分工。
   *   早期版本这里还写着 captureStep / applyStepArt 两个回调，但实现里从没用过
   *   （画面靠 GAME_TASK 里的 image 字段下发，不落进画布），已删除以免误导。
   */
  constructor(room, api) {
    this.room = room;
    this.api = api;
    this.mode = 'chain';
    this.phase = CHAIN_PHASE.OFF;

    this.rounds = P.GAME.CHAIN_ROUNDS;   // 每条链走几圈
    this.round = 0;                      // 当前第几圈（1 起）
    this.theme = 'default';
    this.drawMs = 0;                     // 「照词作画」一步的时长覆盖值（0 = 用全局默认）

    this.chains = [];        // [{ id, ownerId, ownerName, cells: [cell...] }]
    this.order = [];         // 传递顺序（开局时打乱一次，整局固定）
    this.names = new Map();  // userId -> name（人走了榜单也要显示）
    this.scores = new Map(); // userId -> 奖杯数
    // 中途进房的人：**本局只能旁边看**。链和传递顺序在开局那一刻就冻结了，
    // 中途插人会改变「谁接谁的」，把已经走完的格子和还没走的全部弄拧，
    // 所以这里不做「下一圈转正」，只承诺「房主开下一局时入局」（start 里清空）。
    this.spectators = new Set();
    this.usedWords = [];

    this.deadline = 0;
    this.startedAt = 0;

    // 本步的临时状态
    this.assign = new Map(); // userId -> cell（这一步该谁做什么）
    this.submitted = new Set(); // 本步已提交的人
    this.replay = null;      // 回放数据（逐链逐一格）
    this.votes = new Map();  // userId -> Set(chainId)（投了「对不上」的）
    this.voted = new Map();  // userId -> Set(chainId)（投过的，不分方向）
    this.replayIndex = 0;    // 回放到第几条链
    this.voteResult = null;  // 投票结算快照
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

  /* ------------------------------------------------------------ 快照 */

  /**
   * 按收件人裁剪的状态。**这是答案泄漏的唯一防线**。
   *
   * 裁掉的：
   *   - 每一步的产物（词 / 画）在轮到它之前、以及回放开始之前，一律不下发
   *   - 回放数据只在 REPLAY / VOTE / OVER 阶段下发
   * 保留的：
   *   - 链条的「进度骨架」（第几条链走到了第几步、谁做过）——这只是进度条，不含内容
   */
  snapshotFor(userId) {
    const me = userId || '';
    const cell = this.assign.get(me) || null;
    const revealed = this.phase === CHAIN_PHASE.REPLAY ||
      this.phase === CHAIN_PHASE.VOTE ||
      this.phase === CHAIN_PHASE.OVER;

    return {
      mode: 'chain',
      phase: this.phase,
      phaseLabel: CHAIN_PHASE_LABEL[this.phase] || this.phase,
      theme: this.theme,
      themeName: (THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '',
      rounds: this.rounds,
      round: this.round,
      deadline: this.deadline,
      serverNow: Date.now(),

      // 我这一步要做什么（只有当事者拿得到实体）
      // 'write' / 'draw' / 'guess' / '' （这一步没我的事 → 我是观众）
      myStep: cell ? cell.step : '',
      myDone: this.submitted.has(me),
      // 观众视角：这一步一共有几件事在并行，做完了几件
      stepTotal: this.assign.size,
      stepDone: this.submitted.size,

      // 进度骨架：每条链走到第几步了。**不含内容**，只是「第 2 条链第 3 步」
      progress: this.chains.map(c => ({
        id: c.id,
        ownerId: c.ownerId,
        ownerName: c.ownerName,
        step: c.cells.length,          // 已填了几格
        total: this.rounds
      })),
      chainCount: this.chains.length,

      locked: this.lockedFor(me),
      canStart: this.phase === CHAIN_PHASE.LOBBY || this.phase === CHAIN_PHASE.OVER,
      isOwner: !!(this.room.ownerId && this.room.ownerId === me),

      // 奖杯榜
      scores: this.scoreList(),

      // 回放与投票
      replay: revealed ? this.replayFor(me) : null,
      replayCount: revealed && this.replay ? this.replay.length : 0,
      replayIndex: this.replayIndex,
      myVotes: revealed ? this.votesFor(me) : [],
      myVoted: revealed ? this.votedChainsFor(me) : [],
      voteResult: this.phase === CHAIN_PHASE.OVER ? this.voteResult : null,

      // 中途进房、本局只能看：前端据此显示提示条
      spectating: this.spectators.has(me),
      minPlayers: P.GAME.CHAIN_MIN_PLAYERS,
      maxPlayers: P.GAME.CHAIN_MAX_PLAYERS,
      maxRounds: P.GAME.CHAIN_MAX_ROUNDS,
      themes: THEMES.themeList(),
      stepMs: this.stepMs()
    };
  }

  /** 这一步的时长（按步骤类型给不同的值） */
  stepMs() {
    if (this.phase === CHAIN_PHASE.WRITE) return CFG.WRITE_MS;
    if (this.phase === CHAIN_PHASE.DRAW) return this.drawMs || CFG.DRAW_MS;
    if (this.phase === CHAIN_PHASE.GUESS) return CFG.WRITE_MS;
    if (this.phase === CHAIN_PHASE.REPLAY || this.phase === CHAIN_PHASE.VOTE) return CFG.REPLAY_MS;
    return 0;
  }

  /**
   * 我这一步的「题面」——只能给自己看的那一份。
   *
   *   write : 候选词（挑一个，或自己写）
   *   draw  : 要画的词（来自上家的猜词结果，或链条起点）
   *   guess : 上家那幅画（PNG）
   * 返回 null 表示这一步没我的事（观众）。
   */
  taskFor(userId) {
    if (!this.isPlaying()) return null;
    const cell = this.assign.get(userId);
    if (!cell) return null;
    const chain = this.chains[cell.chainIdx];
    if (!chain) return null;

    if (cell.step === STEP.WRITE) {
      return { step: 'write', choices: cell.choices || [], deadline: this.deadline };
    }
    if (cell.step === STEP.DRAW) {
      return { step: 'draw', word: cell.word || '', deadline: this.deadline };
    }
    if (cell.step === STEP.GUESS) {
      return {
        step: 'guess',
        // ⚠️ 只给「上一格的那幅画」。绝不带词、绝不带链上更早的任何东西。
        image: cell.prevImage || '',
        wordLen: 0,
        deadline: this.deadline
      };
    }
    return null;
  }

  /**
   * 回放数据（按收件人裁剪）。
   *
   * 回放开始后内容本来就全公开了（这是玩法的一部分 —— 大家要一起看「怎么跑偏的」），
   * 所以这里不再逐格裁剪。唯一的例外是**投票阶段前不显示最后一格**？
   * 不 —— 投票要判「首尾是否一致」，起词的人和最后那个词必须都看得见，否则没法投。
   * 因此回放一并全给，只把「谁投了哪一票」藏起来（那才是会影响别人的东西）。
   */
  replayFor(userId) {
    if (!this.replay) return null;
    return this.replay.map(chain => ({
      id: chain.id,
      ownerId: chain.ownerId,
      ownerName: chain.ownerName,
      firstWord: chain.firstWord,
      lastWord: chain.lastWord,
      matched: chain.matched,          // 首尾是否一致（服务端算的初判，投票可以推翻）
      cells: chain.cells.map(c => ({
        step: c.step,
        userId: c.userId,
        name: this.names.get(c.userId) || '某人',
        word: c.word || '',
        image: c.image || ''
      }))
    }));
  }

  /** 我投了「对不上」的那些链（票是匿名的，只回给本人） */
  votesFor(userId) {
    const s = this.votes.get(userId);
    return s ? Array.from(s) : [];
  }

  /**
   * 我「已经表过态」的链（不管投的是对得上还是对不上）。
   *
   * 为什么要单独一份：票的意思里「对得上」是默认值 —— vote() 里 agree=true 只是
   * 把这个人从「对不上」名单里摘掉，并不留痕。所以光看 votesFor() 分不出
   * 「我投了对得上」和「我还没投」，前端就没法把按钮标成「已投」。
   * 这份名单不回给任何人别人 —— 它只说明「谁投过了」，不含投的方向。
   */
  votedChainsFor(userId) {
    const s = this.voted.get(userId);
    return s ? Array.from(s) : [];
  }

  /** 排行榜：接龙里分数就是奖杯数 */
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

  /**
   * 只读观众不进池子 —— 跟 game.js 的 playerList 一个道理：
   * 他画不了，轮到他那一步整条链就卡住了。
   */
  /** 这一局已经开了、还没完吗（大厅 / 整局结束之外都算） */
  midGame() {
    return this.phase !== CHAIN_PHASE.LOBBY && this.phase !== CHAIN_PHASE.OVER &&
      this.phase !== CHAIN_PHASE.OFF;
  }

  playerList() {
    const out = [];
    for (const m of this.room.members.values()) {
      if (m.readonly) continue;
      // 本局的看客也不算玩家（投票法定人数、最少人数都由这个池子决定）
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

  /**
   * 该用户此刻能不能改画布。
   *   写词 / 猜词：谁都别画（画布上放着的是「上家的画」当参考，画上去会污染）
   *   作画：只有这一步轮到他画的人能动笔（而且画布是空的，从零开始画）
   *   回放 / 投票：**画布是空的**（每步作画结束都清了），让人乱画会污染回放背景 → 锁死
   *   大厅 / 结束：自由
   */
  lockedFor(userId) {
    if (this.phase === CHAIN_PHASE.WRITE || this.phase === CHAIN_PHASE.GUESS) return true;
    if (this.phase === CHAIN_PHASE.REPLAY || this.phase === CHAIN_PHASE.VOTE) return true;
    if (this.phase === CHAIN_PHASE.DRAW) {
      const cell = this.assign.get(userId);
      return !(cell && cell.step === STEP.DRAW);
    }
    return false;
  }

  blocksWrite(userId) { return this.lockedFor(userId); }

  /**
   * 这个人此刻手里攥着「别人还没看到的答案」吗？
   *
   * 经典模式里答案只有一个，泄漏它的人只有画手和已猜对的人；
   * 接龙是**并行多条链**，所以判定完全不同：
   *   - 正在看图猜词的人：他猜出来的词就是下一位要画的东西 → 说出来等于剧透
   *   - 正在照词作画的人：他手上那个词是上家的成果 → 说出来后面全废
   * 「写词」的人不用管 —— 那是他自己的链的起点，下一个人本来就会拿到。
   * 回放 / 投票阶段一切都公开了，不再拦。
   */
  chatLeaks(userId) {
    if (!this.isPlaying()) return false;
    const cell = this.assign.get(userId);
    if (!cell) return false;
    return cell.step === STEP.GUESS || cell.step === STEP.DRAW;
  }

  /** 榜单上标一下「这一步在做什么」 */
  stepOf(userId) {
    const c = this.assign.get(userId);
    return c ? c.step : '';
  }

  /* ------------------------------------------------------------ 开局 */

  start(opts) {
    const players = this.playerList();
    const min = P.GAME.CHAIN_MIN_PLAYERS;
    if (players.length < min) {
      return { ok: false, code: 'too_few', message: '接龙至少要 ' + min + ' 个人才能玩（链条太短没意思）' };
    }
    const max = P.GAME.CHAIN_MAX_PLAYERS;
    if (players.length > max) {
      return { ok: false, code: 'too_many', message: '接龙最多 ' + max + ' 个人' };
    }

    this.spectators.clear();          // 开新局：房间里的人都算玩家
    this.rounds = clampInt(opts && opts.rounds, P.GAME.CHAIN_ROUNDS, 1, P.GAME.CHAIN_MAX_ROUNDS);
    this.theme = (opts && THEMES.hasTheme(opts.theme)) ? opts.theme : 'default';
    const dsec = Math.floor(Number(opts && opts.drawSeconds));
    this.drawMs = (isFinite(dsec) && dsec > 0)
      ? clampInt(dsec, P.GAME.DRAW_SECONDS_DEFAULT, P.GAME.DRAW_SECONDS_MIN, P.GAME.DRAW_SECONDS_MAX) * 1000
      : 0;
    this.round = 0;
    this.usedWords = [];
    this.voteResult = null;
    this.replay = null;
    this.replayIndex = 0;
    this.votes = new Map();
    this.voted = new Map();
    this.startedAt = Date.now();
    this.scores = new Map();
    players.forEach(p => this.scores.set(p.userId, 0));

    // 每人起一条链。链的「主人」就是起词的人 —— 最后发奖杯也是发给他。
    this.chains = players.map((p, i) => ({
      id: 'c' + (i + 1),
      ownerId: p.userId,
      ownerName: p.name,
      cells: []
    }));
    // 传递顺序：开局时打乱一次，整局固定。
    // 它是「谁接下家」的唯一依据 —— 每次洗会让人搞不清自己该收到谁的画。
    this.order = shuffle(players.map(p => p.userId));

    this.phase = CHAIN_PHASE.LOBBY;
    // 开局后要立刻把状态推出去：前端靠 phase 从 'off' 变成 'lobby' 才知道「接龙开了」。
    // 不 sync 的话房主点完开局全场毫无反应。
    this.api.sync();
    this.api.systemChat('接龙开始了！共 ' + this.chains.length + ' 条链，每条走 ' + this.rounds + ' 圈'
      + '（主题：' + ((THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '通用') + '）');
    this.beginRound();
    return { ok: true };
  }

  /**
   * 开始第一圈的第 0 步：每个人都给自己的链写一个词。
   * 接龙的「起点」并不是公平的 —— 链条走下来每个人都会画、也会猜，
   * 所以不必像经典模式那样轮流当画手。
   */
  beginRound() {
    const online = this.playerList();
    const min = P.GAME.CHAIN_MIN_PLAYERS;
    if (online.length < min) return this.toLobby('人数不足 ' + min + ' 人，接龙已暂停');

    this.round += 1;
    this.submitted = new Set();
    this.assign = new Map();

    // 这一圈的安排：每条链把「该做的第 k 格」派出去，走的是 composeStep() 里
    // 「自己起词 → 下一个人接着做」的固定传递规则。
    const onlineIds = online.map(p => p.userId);
    for (const c of this.chains) {
      const idx = this.chains.indexOf(c);
      const step = this.composeStep(c);
      if (!step) continue;
      let who = step.userId;
      // 掉线补偿：轮到的那个人已经不在线（或者这一圈已经接了别的活），
      // 就顺着传递顺序往后找第一个「在线 + 这一圈还没安排」的人顶上。
      // 不补的话这一步压根没人做，全场干等到时限走完（60 ~ 120 秒）才跳过。
      if (onlineIds.indexOf(who) < 0 || this.assign.has(who)) {
        const standIn = this.pickStandIn(c, step.userId, onlineIds);
        if (standIn) who = standIn;
      }
      // 该用户这一步要做的事挂到他名下（一个用户在一圈里只会被安排一次）
      this.assign.set(who, Object.assign({ chainIdx: idx }, step));
    }

    if (this.assign.size === 0) return this.toLobby('没有可安排的步骤');

    // 有「写词」这一步的人要拿候选词
    const pool = WORDS.poolForTheme(this.theme);
    for (const cell of this.assign.values()) {
      if (cell.step !== STEP.WRITE) continue;
      cell.choices = pickWords(pool, P.GAME.CHAIN_PICK_CHOICES, this.usedWords);
    }

    this.enterPhaseForCurrentSteps();
  }

  /**
   * 给一格找顶替的人：从「名义上的那个人」沿传递顺序往后走，取第一个
   * **在线、且这一圈还没接到活、也不是这条链主人**的人。找不到返回 ''。
   *
   * 三个条件都不能少：
   *   - 在线     —— 不在线的人接不了活，接了就是全场等他超时
   *   - 没接过活 —— 一圈里每人只做一步（beginRound 的派法保证不会重复安排），
   *                 一个人接两步会让他在同一时刻收到两份互相冲突的题面
   *   - 不是主人 —— 与 composeStep 同一条规矩：谁都不该接到自己那条链
   */
  pickStandIn(chain, fromUserId, onlineIds) {
    const order = this.order || [];
    const n = order.length;
    if (!n) return '';
    const from = order.indexOf(fromUserId);
    if (from < 0) return '';
    for (let i = 1; i <= n; i++) {
      const id = order[(from + i) % n];
      if (id === chain.ownerId) continue;
      if (onlineIds.indexOf(id) < 0) continue;
      if (this.assign.has(id)) continue;
      return id;
    }
    return '';
  }

  /**
   * 算出「链 c 的第 round 步该谁做、做什么」。
   *
   * 传递规则（一条链上第 k 步）：
   *   k = 0            → 链主人自己写一个词
   *   k >= 1 且 k 奇数  → 链主人的「下家」照上一步的词作画（下一人 = 环上下一位）
   *   k >= 1 且 k 偶数  → 再下一位照上一步的画猜词
   *
   * 也就是说：词 → 画 → 词 → 画 …… 交替进行，每步换一个人，
   * 顺着开局时打乱过的玩家顺序往前推。这样任何一个人都不会接到自己的东西。
   */
  composeStep(chain) {
    const k = this.round - 1;                  // 本圈做这条链的第几格（0 起）
    if (k >= this.rounds) return null;

    const order = this.order || [];
    const n = order.length;
    if (!n) return null;
    const ownerIdx = order.indexOf(chain.ownerId);
    if (ownerIdx < 0) return null;             // 链主人退出了，这条链本圈跳过

    if (k === 0) return { step: STEP.WRITE, userId: chain.ownerId };

    const prev = chain.cells[k - 1];
    if (!prev) return null;                    // 上一格缺了（有人掉线），这一步没法安排

    // 第 k 格由「链主人往后数 k 个人」来做，**数的时候要跳过链主人自己**：
    // 直接 `(ownerIdx + k) % n` 在 k = n 时会绕回链主人身上 —— 而圈数可以选到 6、
    // 人数最少只有 4，那时他会接到自己那条链递下来的东西（自问自答）。
    // 按「除自己以外的那一圈」取，圈数再大也只是在别人之间循环。
    const others = [];
    for (let i = 1; i < n; i++) others.push(order[(ownerIdx + i) % n]);
    const who = others[(k - 1) % others.length];

    if (prev.step === STEP.WRITE || prev.step === STEP.GUESS) {
      // 上一步的产物是「词」→ 这一步作画
      return { step: STEP.DRAW, userId: who, word: prev.word };
    }
    // 上一步的产物是「画」→ 这一步猜词
    return { step: STEP.GUESS, userId: who, prevImage: prev.image, prevCellIdx: k - 1 };
  }

  /** 进入当前这些步骤对应的阶段（全是同一种步骤，否则就是设计错了） */
  enterPhaseForCurrentSteps() {
    const kinds = new Set();
    for (const cell of this.assign.values()) kinds.add(cell.step);
    // 极端情况：这一步既有作画又有猜词（前一步有人掉线导致链条错位）。
    // 不做花哨的分裂，统一按「先作画后猜词」处理 —— 猜词那批这一步先当观众。
    const hasDraw = kinds.has(STEP.DRAW);
    const hasWrite = kinds.has(STEP.WRITE);

    if (hasWrite) this.phase = CHAIN_PHASE.WRITE;
    else if (hasDraw) this.phase = CHAIN_PHASE.DRAW;
    else this.phase = CHAIN_PHASE.GUESS;

    if (!hasWrite && !hasDraw && kinds.has(STEP.GUESS)) this.phase = CHAIN_PHASE.GUESS;

    this.deadline = Date.now() + this.stepMs();

    // 作画这一步：把画布清空，让当事人从零开始画
    if (this.phase === CHAIN_PHASE.DRAW) this.api.resetCanvas();

    this.api.sync();
    this.announceStep();
  }

  announceStep() {
    const who = [];
    for (const [uid, cell] of this.assign) {
      if (cell.step !== this.phaseStep()) continue;
      who.push(this.names.get(uid) || '某人');
    }
    const label = CHAIN_PHASE_LABEL[this.phase] || '';
    const secs = Math.round(this.stepMs() / 1000);
    if (who.length) {
      this.api.systemChat('第 ' + this.round + ' / ' + this.rounds + ' 圈 · '
        + label + '：' + who.join('、') + '（' + secs + ' 秒）');
    } else {
      this.api.systemChat('第 ' + this.round + ' / ' + this.rounds + ' 圈 · 等待中');
    }
  }

  /** 当前阶段对应的 step 类型 */
  phaseStep() {
    if (this.phase === CHAIN_PHASE.WRITE) return STEP.WRITE;
    if (this.phase === CHAIN_PHASE.DRAW) return STEP.DRAW;
    if (this.phase === CHAIN_PHASE.GUESS) return STEP.GUESS;
    return '';
  }

  /* ------------------------------------------------------------ 提交 */

  /** 写词：挑一个候选，或自己写一个 */
  submitWord(userId, text, index) {
    if (this.phase !== CHAIN_PHASE.WRITE) return { ok: false, message: '现在不是写词阶段' };
    const cell = this.assign.get(userId);
    if (!cell || cell.step !== STEP.WRITE) return { ok: false, message: '这一步没有你要写的东西' };
    if (this.submitted.has(userId)) return { ok: false, message: '你已经提交过了' };

    let word = '';
    if (typeof index === 'number' && cell.choices && cell.choices[index]) {
      word = cell.choices[index];
    } else {
      word = String(text || '').trim();
    }
    const chk = this.validateWord(word);
    if (!chk.ok) return chk;

    cell.word = word;
    if (this.usedWords.indexOf(word) < 0) this.usedWords.push(word);
    this.finishStep(userId, cell, { word });
    return { ok: true };
  }

  /** 猜词：给他看的那幅画，他猜是什么 */
  submitGuess(userId, text) {
    if (this.phase !== CHAIN_PHASE.GUESS) return { ok: false, message: '现在不是猜词阶段' };
    const cell = this.assign.get(userId);
    if (!cell || cell.step !== STEP.GUESS) return { ok: false, message: '这一步没有你要猜的东西' };
    if (this.submitted.has(userId)) return { ok: false, message: '你已经提交过了' };

    const word = String(text || '').trim();
    const chk = this.validateWord(word, P.GAME.CHAIN_MAX_GUESS_LEN);
    if (!chk.ok) return chk;

    this.finishStep(userId, cell, { word });
    return { ok: true };
  }

  /**
   * 作画的产物。画是客户端画完后由 index.js 抓成 PNG 回传的
   * （服务端只做哑存储，和图层像素同一套分工）。
   */
  submitArt(userId, png) {
    if (this.phase !== CHAIN_PHASE.DRAW) return { ok: false, message: '现在不是作画阶段' };
    const cell = this.assign.get(userId);
    if (!cell || cell.step !== STEP.DRAW) return { ok: false, message: '这一步不是你在画' };
    if (this.submitted.has(userId)) return { ok: false, message: '你已经提交过了' };
    if (!png || typeof png !== 'string' || png.indexOf('data:image/') !== 0) {
      return { ok: false, message: '作品数据不对' };
    }

    this.finishStep(userId, cell, { image: png });
    return { ok: true };
  }

  /** 词的基本校验（写词与猜词共用） */
  validateWord(word, maxLen) {
    if (!word) return { ok: false, message: '得写点什么' };
    const limit = maxLen || 12;
    if (word.length > limit) return { ok: false, message: '太长了（最多 ' + limit + ' 个字）' };
    // 必须含中文 —— 接龙里全是中文词，混进一串字母会让下家无从下笔
    if (!/[\u4e00-\u9fa5]/.test(word)) return { ok: false, message: '请用中文写' };
    return { ok: true };
  }

  /**
   * 一次提交的收尾：把产物写进链上的格子 → 全场交齐就推进。
   *
   * 格子号就是「本圈做的是第几格」= round - 1。
   * 作画那一步的 PNG 由 submitArt 一起带进来（服务端只做哑存储）。
   */
  finishStep(userId, cell, patch) {
    this.submitted.add(userId);
    const chain = this.chains[cell.chainIdx];
    if (chain) {
      const k = this.round - 1;
      chain.cells[k] = Object.assign({
        step: cell.step,
        userId,
        word: '',
        image: ''
      }, patch);
    }
    this.api.sync();
    if (this.submitted.size >= this.assign.size) this.advance();
  }

  /* ------------------------------------------------------------ 阶段推进 */

  /** 本步全部交齐（或超时）→ 进入下一步 / 下一圈 / 回放 */
  advance() {
    // 清掉「本步作画」的画布，避免带进下一步
    if (this.phase === CHAIN_PHASE.DRAW) this.api.resetCanvas();

    if (this.round >= this.rounds) return this.beginReplay();
    this.beginRound();
  }

  /** 超时：没交的格子按「空」处理，别让全场干等 */
  timeoutStep() {
    if (!this.isPlaying()) return;
    const pending = [];
    for (const [uid, cell] of this.assign) {
      if (this.submitted.has(uid)) continue;
      pending.push(this.names.get(uid) || '某人');
      const k = this.round - 1;
      const chain = this.chains[cell.chainIdx];
      if (!chain || !chain.cells) continue;
      // 没交就填一个占位格：作画留空图，写词/猜词留空串。
      // 后续 composeStep 遇到空串仍然可以往下走（下家会看到一张空白 / 一个空格子）。
      if (cell.step === STEP.DRAW) {
        chain.cells[k] = { step: STEP.DRAW, userId: uid, word: '', image: '', skipped: true };
      } else {
        chain.cells[k] = { step: cell.step, userId: uid, word: '', image: '', skipped: true };
      }
    }
    if (pending.length) {
      this.api.systemChat('超时：' + pending.join('、') + ' 这一步没交，链条跳过');
    }
    this.advance();
  }

  /* ------------------------------------------------------------ 回放与投票 */

  beginReplay() {
    if (this.phase === CHAIN_PHASE.DRAW) this.api.resetCanvas();

    // 组装回放：每条链把格子摊平
    this.replay = this.chains.map(c => {
      const cells = c.cells.filter(Boolean);
      const first = cells.filter(x => x.step === STEP.WRITE)[0];
      const words = cells.filter(x => x.step === STEP.GUESS);
      const lastGuess = words[words.length - 1];
      const firstWord = first ? first.word : '';
      const lastWord = lastGuess ? lastGuess.word : (cells[cells.length - 1] || {}).word || '';
      return {
        id: c.id,
        ownerId: c.ownerId,
        ownerName: this.names.get(c.ownerId) || c.ownerName,
        firstWord,
        lastWord,
        // 服务端先给一个初判（宽松匹配，见 answerMatch），投票可以改这个结论
        matched: answerMatch(firstWord, lastWord),
        cells: cells.map(x => ({
          step: x.step,
          userId: x.userId,
          word: x.word || '',
          image: x.image || ''
        }))
      };
    });

    this.votes = new Map();
    this.voted = new Map();
    this.replayIndex = 0;
    this.phase = CHAIN_PHASE.VOTE;      // 直接进投票（回放本身是可翻页的，不需要单独一段等待）
    this.deadline = Date.now() + CFG.REPLAY_MS;
    this.api.sync();
    this.api.systemChat('全部传递完成！来看看这一局「跑偏」成了什么样 —— 每条链都可以投「对不上」');
  }

  /** 投票：这条链的首尾对得上吗 */
  vote(userId, chainId, agree) {
    if (this.phase !== CHAIN_PHASE.VOTE) return { ok: false, message: '现在不是投票阶段' };
    const chain = this.replay.filter(c => c.id === chainId)[0];
    if (!chain) return { ok: false, message: '没有这条链' };
    let set = this.votes.get(userId);
    if (!set) { set = new Set(); this.votes.set(userId, set); }
    if (agree) set.delete(chainId);      // 同意 = 不记票（默认就是「对得上」）
    else set.add(chainId);
    // 另记一份「投过了」—— agree 那条路径在上面的 set 里是不留痕的
    let voted = this.voted.get(userId);
    if (!voted) { voted = new Set(); this.voted.set(userId, voted); }
    voted.add(chainId);
    this.api.sync();
    return { ok: true };
  }

  /** 投票阶段结束 → 结算奖杯 */
  finishVoting() {
    const players = this.playerList();
    const totalPlayers = Math.max(1, players.length);
    // **只算现在还是玩家的人投的票**：中途进房的看客不算玩家（他不进分母），
    // 但他的票如果照样计进去，一两个看客就能把某条链掀翻 —— 分母和分子必须同一批人。
    const isPlayer = new Set(players.map(p => p.userId));
    const result = [];

    for (const chain of this.replay) {
      // 多少人认为「对不上」
      let against = 0;
      for (const [uid, set] of this.votes) {
        if (!isPlayer.has(uid)) continue;
        if (set.has(chain.id)) against += 1;
      }
      // 服务端初判「一致」+ 多数人不反对 → 起词的人拿奖杯
      const ok = chain.matched && against * 2 < totalPlayers;
      if (ok && chain.ownerId) {
        const pts = P.GAME.CHAIN_TROPHY_AGREE;
        this.scores.set(chain.ownerId, (this.scores.get(chain.ownerId) || 0) + pts);
      }
      result.push({
        id: chain.id,
        ownerId: chain.ownerId,
        ownerName: chain.ownerName,
        firstWord: chain.firstWord,
        lastWord: chain.lastWord,
        matched: chain.matched,
        against,
        won: ok
      });
    }

    this.voteResult = result;
    this.phase = CHAIN_PHASE.OVER;
    this.deadline = 0;
    this.api.sync();

    const winners = result.filter(r => r.won);
    if (winners.length) {
      this.api.systemChat('首尾对上的链有 ' + winners.length + ' 条：'
        + winners.map(w => w.ownerName + '（' + w.firstWord + '）').join('、'));
    } else {
      this.api.systemChat('这一局全军覆没 —— 没有一条链安全到达终点');
    }
    const top = this.scoreList()[0];
    if (top && top.score > 0) {
      this.api.systemChat('本局结束！奖杯最多的是 ' + top.name + '（' + top.score + ' 个）');
    } else {
      this.api.systemChat('本局结束！这一轮谁也没拿到奖杯');
    }
  }

  /**
   * 房主按「立刻结算」：
   *   写词 / 画 / 猜 —— 不等超时，把没交的按「跳过」处理并推进（替等待的人按下加速键）
   *   投票          —— 立刻结算奖杯
   * 返回 { ok, message }
   */
  next(userId) {
    if (!this.isOwner(userId)) return { ok: false, message: '只有房主可以推进' };
    if (this.isPlaying()) { this.timeoutStep(); return { ok: true }; }
    if (this.phase === CHAIN_PHASE.VOTE) { this.finishVoting(); return { ok: true }; }
    return { ok: false, message: '现在没什么可推进的' };
  }

  isOwner(userId) { return !!(this.room.ownerId && this.room.ownerId === userId); }

  /* ------------------------------------------------------------ 时钟与收尾 */

  tick(nowMs) {
    if (!this.active || !this.deadline) return;
    if (nowMs < this.deadline) return;
    if (this.isPlaying()) return this.timeoutStep();
    if (this.phase === CHAIN_PHASE.VOTE) return this.finishVoting();
  }

  toLobby(reason) {
    this.phase = CHAIN_PHASE.LOBBY;
    this.deadline = 0;
    this.assign = new Map();
    this.submitted = new Set();
    this.api.sync();
    if (reason) this.api.systemChat(reason);
  }

  stop() {
    this.spectators.clear();
    this.phase = CHAIN_PHASE.OFF;
    this.deadline = 0;
    this.chains = [];
    this.assign = new Map();
    this.submitted = new Set();
    this.replay = null;
    this.votes = new Map();
    this.voted = new Map();
    this.voteResult = null;
    this.api.sync();
  }

  /* ------------------------------------------------------------ 成员变动 */

  onJoin(member) {
    if (!this.active) return;
    if (!this.names.has(member.userId)) this.names.set(member.userId, member.name);
    // 局中进房：本局只能旁边看（链已经冻结），也不进奖杯榜、不算投票人数
    if (this.midGame()) {
      this.spectators.add(member.userId);
      this.api.systemChat(member.name + ' 加入了，本局接龙进行中，先观战 —— 房主开下一局就能一起玩');
      this.api.sync();
      return;
    }
    if (!this.scores.has(member.userId)) this.scores.set(member.userId, 0);
    this.api.sync();
  }

  onLeave(member) {
    if (!this.active) return;
    // 看客走了：摘掉即可，不影响链条与人数判断
    if (this.spectators.has(member.userId)) {
      this.spectators.delete(member.userId);
      this.api.sync();
      return;
    }
    // 走的是一条链的主人：composeStep 从此会一直跳过这条链（找不到主人了），
    // 得说一声 —— 不然大家只能看见「进度条上有一条链永远停在第一格」，完全不知道为什么。
    const owned = this.chains.filter(c => c.ownerId === member.userId);
    if (owned.length) {
      this.api.systemChat(member.name + ' 离开了，TA 起的那 ' + owned.length
        + ' 条链接不下去（主人不在就没人接），回放里会少掉');
    }
    const min = P.GAME.CHAIN_MIN_PLAYERS;
    if (this.playerList().length < min) {
      if (this.phase === CHAIN_PHASE.LOBBY || this.phase === CHAIN_PHASE.OVER) return;
      // 只剩不到 4 人就没法继续接龙了 —— 链条传递要求「不会轮到自己」
      this.toLobby(member.name + ' 离开了，接龙至少要 ' + min + ' 人，游戏已暂停');
      return;
    }
    if (this.isPlaying()) {
      // 走的人手里可能有活：直接把他这步当「没交」处理，别让全场卡住
      const cell = this.assign.get(member.userId);
      if (cell && !this.submitted.has(member.userId)) {
        this.api.systemChat(member.name + ' 离开了，这一步跳过');
        this.submitted.add(member.userId);
        const k = this.round - 1;
        const chain = this.chains[cell.chainIdx];
        if (chain && chain.cells) {
          chain.cells[k] = {
            step: cell.step, userId: member.userId, word: '', image: '', skipped: true
          };
        }
        if (this.submitted.size >= this.assign.size) return this.advance();
      }
    }
    this.api.sync();
  }
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
 * 最终裁定权仍在玩家投票（见 finishVoting）。
 */
const STOPWORDS = ['一只', '一个', '一条', '一头', '一匹', '一栋', '一辆', '一架', '一朵', '一棵',
  '的', '了', '个', '只', '条', '头', '匹', '辆', '架', '朵', '棵', '们', '是', '在'];

/**
 * 常见的「词尾修饰字」：小猫 / 猫咪 / 老猫 指的是同一只猫。
 * 归一化时逐个剥掉，让「猫咪」「小猫」「猫」都落回「猫」。
 *   小 / 大 / 老（大小老幼）· 子 / 儿 / 咪 / 阿 / 呀（口语词尾）· baby 的「宝」
 * 只在**长度 ≥ 3** 时才敢剥，否则「小」这种单字词会被剥成空串。
 */
const MORPH = ['小', '大', '老', '子', '儿', '咪', '阿'];

/** 剥掉词首词尾的修饰字（一直剥到不能再剥） */
function stripMorph(s) {
  let t = s;
  // 允许一直剥到只剩 1 个字：「猫咪」「小猫」都该落回「猫」。
  // 所以门槛是 t.length > 1 —— 剥到剩 1 个字就停（再剥就空了，没有意义）。
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
