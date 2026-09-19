'use strict';

/**
 * 画皮模式（skin）—— 把「发言」换成「限时作画」的狼人杀。
 *
 * 玩法一句话：**所有人都有身份；每轮天亮后画同一个主题，匿名摊开，看画猜人，
 * 讨论，投票放逐。狼人藏在里面，靠画风的破绽和言语的破绽被抓。**
 *
 * 与另外两个玩法最本质的差异：**信息不是「产物」，而是「身份」。**
 *   - 经典模式的秘密是「答案」（一个词），藏好它就赢了一半
 *   - 接龙的秘密是「传递中失真的产物」，话题是「怎么就变成这样了」
 *   - 画皮的秘密是**每个人自己是谁**。这一条决定了这里所有裁剪的写法：
 *     经典 / 接龙拿 GAME_STATE 广播流做裁剪就够（把 word / image 挖掉），
 *     画皮不行 —— 身份表一旦进了广播流，前端在控制台里就能把自己和别人的底牌全看光。
 *     所以身份**只走单发**（S2C.SKIN_ROLE），压根不进 snapshotFor 的返回值。
 *
 * 数据模型上刻意「不存可以推导出来的东西」：
 *   alivePlayers() 每次现算，不用 Set 维护 —— 少一份「集合与 member 名单不同步」的状态。
 *   唯一真正需要持久的是「谁出局了、为什么」，那写在 players 里。
 *
 * 时间全部由服务端裁定：客户端只拿 deadline 做倒计时显示。
 */

const P = require('./protocol');
const WORDS = require('./words');
const THEMES = require('./themes');

/** 阶段（与另两个玩法共用 'off' / 'lobby' / 'over' 三个终态） */
const SKIN_PHASE = {
  OFF: 'off',
  LOBBY: 'lobby',
  NIGHT: 'skin_night',           // 夜里做事：预言家验人 / 狼人刀人
  DAWN: 'skin_dawn',             // 天亮公告：昨晚谁走了、我验到了什么
  DAY_DRAW: 'skin_draw',         // 同题限时作画（各自私密画）
  DAY_TALK: 'skin_talk',         // 匿名看画 + 讨论
  DAY_VOTE: 'skin_vote',         // 放逐投票
  VOTE_END: 'skin_vote_end',     // 投票结算展示（谁被放逐了）
  OVER: 'over'                   // 某一方赢了
};

const SKIN_PHASE_LABEL = {
  off: '自由绘画',
  lobby: '等待开始',
  skin_night: '天黑请闭眼',
  skin_dawn: '天亮了',
  skin_draw: '作画中',
  skin_talk: '看画与讨论',
  skin_vote: '投票放逐',
  skin_vote_end: '投票结果',
  over: '本局结束'
};

/**
 * 阵营。狼人赢的判定与「谁和谁是一伙」都只看这个字段，
 * 所以它是裁定用的唯一依据；role 只影响「有没有夜间技能」。
 */
const CAMP = { GOOD: 'good', WOLF: 'wolf' };

/**
 * 身份表。
 *
 * 首版实现清单（刻意只做这些）：
 *   预言家  预言家 夜里验一个人，知道他是好人还是狼（不知道具体身份）
 *   女巫    只有一瓶解药，且**第一晚之后不能自救** —— 简化掉了「毒药」与「两瓶药」
 *   猎人    被放逐 / 被刀出局时能开枪带走一个人（毒死不能开枪 —— 首版没有毒药，
 *           保留这个规则是为了将来加毒药时不用改语义）
 *   平民画师 没有技能，靠看画和讨论推理 —— 也是所有超出配比的名额的去处
 *   伪装者  狼人。夜里和同伴一起商量刀谁
 */
const ROLE = {
  SEER: 'seer',       // 预言家
  WITCH: 'witch',     // 女巫
  HUNTER: 'hunter',   // 猎人
  VILLAGER: 'villager', // 平民画师
  WOLF: 'wolf'        // 伪装者（狼）
};

const ROLE_INFO = {
  seer: { name: '预言家', camp: CAMP.GOOD, campName: '画师', desc: '每晚可以验一个人，你会知道他是不是伪装者。' },
  witch: { name: '女巫', camp: CAMP.GOOD, campName: '画师', desc: '你有一瓶解药，能在天亮前救回被刀的人（只有一瓶，且不能救自己）。' },
  hunter: { name: '猎人', camp: CAMP.GOOD, campName: '画师', desc: '你被投票放逐时可以开枪带走一个人。' },
  villager: { name: '平民画师', camp: CAMP.GOOD, campName: '画师', desc: '你没有技能。看画、听话、把伪装者投出去。' },
  wolf: { name: '伪装者', camp: CAMP.WOLF, campName: '伪装者', desc: '你和同伴每晚可以刀掉一个人。装成画师，活到最后。' }
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

const CFG = {
  NIGHT_MS: envMs('GAME_SKIN_NIGHT_MS', P.GAME.SKIN_NIGHT_MS),
  DAWN_MS: envMs('GAME_SKIN_DAWN_MS', P.GAME.SKIN_DAWN_MS),
  DRAW_MS: envMs('GAME_SKIN_DRAW_MS', P.GAME.SKIN_DRAW_MS),
  TALK_MS: envMs('GAME_SKIN_TALK_MS', P.GAME.SKIN_TALK_MS),
  VOTE_MS: envMs('GAME_SKIN_VOTE_MS', P.GAME.SKIN_VOTE_MS),
  VOTE_END_MS: envMs('GAME_SKIN_VOTE_END_MS', P.GAME.SKIN_VOTE_END_MS),
  WITCH_GRACE_MS: envMs('GAME_SKIN_WITCH_GRACE_MS', P.GAME.SKIN_WITCH_GRACE_MS)
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 按人数配身份。
 *
 * 用户拍板的口径（「按人数自动配比」）：
 *   6 ~ 8 人：预言家 + 女巫 + 2 狼 + 其余平民
 *   9 ~ 12 人：预言家 + 女巫 + 猎人 + 3 狼 + 其余平民
 *
 * 两个关键平衡点，改之前先想清楚：
 *   ① **狼比好人少一大截**：6 人局 2 狼 4 好，9 人局 3 狼 6 好。
 *      接近 1:1 时好人第一轮投错就直接崩（狼数 ≥ 好人数即狼胜），
 *      而画皮一晚上只走一个人，节奏比标准狼人杀慢得多，容错必须留够。
 *   ② **神职不超过 3 个**：神职多了平民就没人当，而「所有人都在装神职」
 *      会让狼人的伪装成本骤降（谁都能说自己在验人）。
 *
 * @returns {string[]} 长度等于人数、已洗牌的身份数组
 */
function rolePlan(n) {
  const wolves = n >= 9 ? 3 : 2;
  const roles = [ROLE.SEER, ROLE.WITCH];
  if (n >= 9) roles.push(ROLE.HUNTER);
  while (roles.length < n - wolves) roles.push(ROLE.VILLAGER);
  return shuffle(roles.concat(new Array(wolves).fill(ROLE.WOLF)));
}

/** 洗主题词：从一个池子里不重复地取 n 个 */
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

class SkinGame {
  /**
   * @param {Room} room
   * @param {{sync:Function, systemChat:Function, resetCanvas:Function}} api
   *   - sync()         把（按人裁剪过的）状态推给全场，并顺手补发私有消息
   *                    （身份 / 夜里的裁定 —— 见 index.js 的 syncGame）
   *   - systemChat()   系统播报
   *   - resetCanvas()  清空画布（作画阶段的首尾各一次）
   *
   * ⚠ 作品像素**不由服务端抓**：客户端把画布导成 PNG，走 C2S.SKIN_ART 回传，
   *   服务端只做哑存储。与接龙的 submitArt 同一套分工，服务端从头到尾不碰像素。
   */
  constructor(room, api) {
    this.room = room;
    this.api = api;
    this.mode = 'skin';
    this.phase = SKIN_PHASE.OFF;

    this.round = 0;              // 第几天（1 起）
    this.maxRounds = P.GAME.SKIN_ROUNDS;
    this.theme = 'default';
    this.drawMs = 0;             // 作画时长的本局覆盖值（0 = 用全局默认）

    /**
     * 玩家表。开局的瞬间冻结，局中不动 —— 与接龙同一个理由：
     * 中途进房的人要是一起玩，「昨晚验了谁」这类记忆在两边就对不上了。
     * 局中进房的人只能围观（spectators）。
     */
    this.players = [];           // [{ id, name, role, alive, diedAt, cause }]
    this.spectators = new Set(); // 本局只能观的 userId
    this.names = new Map();      // userId -> name（人走了结算里也要显示）
    this.order = [];             // 发言 / 展示顺序（开局打乱一次，整局固定）

    this.themeWords = [];        // 本局用到的主题词（不重复）
    this.usedWords = [];

    // 夜里的裁定
    this.nightNo = 0;            // 第几夜（与 round 同号）
    this.nightKill = '';         // 狼刀的目标 userId
    this.nightWolfVotes = new Map(); // wolfId -> targetId（同伴协商的过程）
    this.nightChecks = new Map();    // seerId -> Set(targetId)（验过谁，防重复验）
    this.nightLastCheck = null;      // { by, target, camp } 本夜预言家的结果
    this.witchSaveUsed = false;
    this.witchSaved = '';        // 本夜被救的人（公告里「昨晚是平安夜」的依据）
    this.nightDeaths = [];       // 本夜出局的人（天亮时公告）

    // 白天的产物
    this.works = [];             // [{ id, userId, png, skipped }] 本轮交上来的画
    this.submitted = new Set();  // 本轮已交画的人

    // 放逐
    this.votes = new Map();      // voterId -> targetId
    this.voteResult = null;      // { top, votes, tie, exiled, shot }
    this.pendingShot = '';       // 猎人待开枪（投票结算后要等他操作）

    this.winner = '';            // '' | 'good' | 'wolf'
    this.winReason = '';

    this.deadline = 0;
    this.startedAt = 0;
  }

  /* ------------------------------------------------------------ 查询 */

  get active() { return this.phase !== SKIN_PHASE.OFF; }

  /** 已经开了、还没完吗（大厅 / 结束之外都算） */
  midGame() {
    return this.phase !== SKIN_PHASE.LOBBY &&
      this.phase !== SKIN_PHASE.OVER &&
      this.phase !== SKIN_PHASE.OFF;
  }

  isOwner(userId) { return !!(this.room.ownerId && this.room.ownerId === userId); }

  memberOf(userId) {
    for (const m of this.room.members.values()) if (m.userId === userId) return m;
    return null;
  }

  entryOf(userId) {
    for (const p of this.players) if (p.id === userId) return p;
    return null;
  }

  /**
   * 还在场上的人。**每次现算** —— 不维护 aliveSet，
   * 少一份需要跟着 players 一起改的状态。玩家最多 12 个，遍历成本可以忽略。
   */
  alivePlayers() {
    return this.players.filter(p => p.alive);
  }

  /**
   * 本局的玩家池 = 在线 + 不是只读观众 + 不是本局看客。
   *
   * 只读观众不进池子：他画不了、也点不了投票，把他算进「最少人数」里
   * 会让房主在 5 个真人 + 1 个观众时以为能开局。
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

  /** 狼人（含已出局的 —— 判「还剩几狼」时才过滤） */
  wolves(aliveOnly) {
    return this.players.filter(p => p.role === ROLE.WOLF && (!aliveOnly || p.alive));
  }

  /**
   * 局中还能不能继续打。
   *
   * ⚠ 这里**必须**用 SKIN_MIN_ALIVE（=2）而不是 SKIN_MIN_PLAYERS（=6）。
   *   开局要 6 人才配得出阵营；局中人数只会一路减少，拿 6 去卡「继续」的话，
   *   6 人局里被刀 / 被放逐一个人之后阶段推进就直接散局 —— 永远走不到结算。
   *   局中真正的终止条件在 checkWin()：「狼全灭」或「狼数 ≥ 好人数」。
   *   这个地板只拦一种情况：人少到连「投票放逐」都失去意义。
   *
   * @param {Array} [alive] 已经算好的活人列表（省一次重算）
   */
  enoughToPlay(alive) {
    const n = (alive || this.alivePlayers()).length;
    return n >= P.GAME.SKIN_MIN_ALIVE;
  }

  /** 同伴名单：只给狼看的（预言家只知道阵营，不该拿到整张狼名单） */
  matesOf(userId) {
    return this.wolves(true)
      .filter(w => w.id !== userId)
      .map(w => ({ userId: w.id, name: this.names.get(w.id) || w.name }));
  }

  /**
   * 我该拿到的身份信息。
   *
   * `word` 只对平民 / 狼有意义：狼要假装画师，得知道「画师这一轮画什么」
   * 否则它连假装都比别人慢半拍（这是玩法上的公平性，不是施舍）。
   */
  roleInfoFor(userId) {
    const p = this.entryOf(userId);
    if (!p) return null;
    const info = ROLE_INFO[p.role] || ROLE_INFO[ROLE.VILLAGER];
    const out = {
      role: p.role,
      roleName: info.name,
      camp: info.camp,
      campName: info.campName,
      desc: info.desc,
      alive: p.alive,
      mates: p.role === ROLE.WOLF ? this.matesOf(userId) : null
    };
    return out;
  }

  /**
   * 夜里的裁定（只发给当事者）。
   *
   * 两种：
   *   { kind:'check', target, targetName, camp, campName }  预言家验人的结果
   *   { kind:'dead',  victim, victimName, saved }           我被刀了（/ 被救了）
   *
   * 为什么「我被刀了」也要单发：狼人刀完人，天亮公告里会写「昨晚 XXX 走了」，
   * 但**死者自己在公告之前就该知道**（他要准备遗言式的发言），
   * 而且女巫救人的时候也要知道救的是谁 —— 这些都不能走广播流。
   */
  nightInfoFor(userId) {
    // ⚠ 顺序有讲究：**「我是不是被刀了」必须排在最前面**。
    //   一个人可能同时是「预言家且被刀」或者「女巫且被刀」—— 如果先返回验人结果，
    //   这个倒霉人整局都不会收到「你出局了」这条（他还会以为自己能继续投票）。
    //   出局信息是**生存相关的**，优先于其它一切夜间信息。

    // 被刀的人：告诉他「你走了」（即使被女巫救回来也要说 —— 不然他不知道该感谢谁）
    const killed = this.nightKill;
    if (killed && killed === userId) {
      return {
        kind: 'dead',
        victim: killed,
        victimName: this.names.get(killed) || '某人',
        saved: this.witchSaved === killed
      };
    }

    // 预言家：本夜验人的结果
    const chk = this.nightLastCheck;
    if (chk && chk.by === userId) {
      const t = this.entryOf(chk.target);
      const info = t ? (ROLE_INFO[t.role] || {}) : {};
      return {
        kind: 'check',
        target: chk.target,
        targetName: this.names.get(chk.target) || '某人',
        camp: info.camp || '',
        campName: info.campName || '',
        isWolf: (info.camp === CAMP.WOLF)
      };
    }
    // 女巫：她得知道「今晚刀口对着谁」才有得选 —— 这是她这个角色的全部情报来源。
    // 只告诉她「谁有危险」，**不告诉她**狼是谁。
    // 夜里给的是「还没定 / 定下来了」的实时状态；天亮后仍然给她一份，
    // 让她知道自己那瓶药到底用没用上（否则她花了一瓶药却看不到任何反馈）。
    const me2 = this.entryOf(userId);
    if (me2 && me2.role === ROLE.WITCH && me2.alive) {
      if (this.phase === SKIN_PHASE.NIGHT) {
        const t = this.pendingKillTarget();
        if (!t) return null;    // 狼还没定刀 —— 没得选，前端显示「等狼定刀」
        return {
          kind: 'witch',
          target: t,
          targetName: this.names.get(t) || '某人',
          saveUsed: this.witchSaveUsed,
          alreadySaved: this.witchSaved === t,
          resolved: false
        };
      }
      // 天亮之后：汇报用药结果（她自己还活着才会走到这里）
      if (this.phase === SKIN_PHASE.DAWN || this.phase === SKIN_PHASE.DAY_TALK) {
        const used = this.witchSaveUsed;
        const savedSomeone = !!this.witchSaved && this.witchSaved === this.nightKill;
        return {
          kind: 'witch',
          target: used ? this.witchSaved : '',
          targetName: used ? (this.names.get(this.witchSaved) || '某人') : '',
          saveUsed: used,
          alreadySaved: savedSomeone,
          resolved: true
        };
      }
    }
    return null;
  }

  /**
   * 今晚的刀口（多数决，与 resolveNight 用同一套算法）。
   * 狼还没投齐时返回空串 —— 没定下来就不该让女巫看到。
   * 平票**不**在这里随机定（否则每次调用结果都可能变、女巫看到的和最终结算的不是同一个人），
   * 而是取票数最高的那一个作为预览，真正的随机留在 resolveNight。
   */
  pendingKillTarget() {
    if (!this.nightReady()) return '';
    const tally = new Map();
    for (const t of this.nightWolfVotes.values()) {
      if (!t) continue;
      tally.set(t, (tally.get(t) || 0) + 1);
    }
    if (!tally.size) return '';
    let best = -1;
    let top = '';
    for (const [t, n] of tally) {
      if (n > best) { best = n; top = t; }
    }
    return top;
  }

  /** 本局所有可公开的玩家名片（**不带身份** —— 身份永远不走广播流） */
  playerCards() {
    return this.players.map(p => ({
      userId: p.id,
      name: this.names.get(p.id) || p.name,
      alive: p.alive,
      cause: p.cause || '',
      // 「验过这个人吗」这件事本身也是信息：预言家公开跳出来时会说，
      // 但服务端不替他说 —— 这里只给「他还在不在」这种谁都看得见的东西。
      online: !!this.memberOf(p.id)
    }));
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 按收件人裁剪的状态。
   *
   * ⚠ **这里绝对不能出现 role / mates / nightLastCheck 这类字段。**
   * 这条消息是广播的（每个人都会收到），一旦夹带身份，把前端控制台打开
   * 就能看到全场的底牌 —— 这个玩法就没了。身份走 S2C.SKIN_ROLE 单发。
   *
   * 允许出现在这里的信息，判定标准是「**把所有人都换成同一份快照，
   * 会不会有人因此知道了自己不该知道的事**」：
   *   - 谁出局了、什么原因  → 公开的（公告里本来就会讲）
   *   - 谁交了画、交了几张  → 只是进度条，不含内容与作者
   *   - 票投完了没有        → 同理（投给谁另外算，见 myVote）
   *   - 我投给谁            → 只回给我（否则别人能照着抄，或者反过来施压）
   */
  snapshotFor(userId) {
    const me = userId || '';
    const p = this.entryOf(me);
    const phase = this.phase;
    const showGallery = phase === SKIN_PHASE.DAY_TALK ||
      phase === SKIN_PHASE.DAY_VOTE ||
      phase === SKIN_PHASE.VOTE_END ||
      phase === SKIN_PHASE.OVER;

    return {
      mode: 'skin',
      phase: phase,
      phaseLabel: SKIN_PHASE_LABEL[phase] || phase,
      round: this.round,
      maxRounds: this.maxRounds,
      deadline: this.deadline,
      serverNow: Date.now(),

      // 我自己的底牌（只有我自己这一份快照里有）。角色名 / 阵营都在这儿，
      // 前端不用再去解 SKIN_ROLE —— 那条消息只负责「第一次拿到手」。
      me: p ? {
        role: p.role,
        alive: p.alive,
        cause: p.cause || ''
      } : null,
      // 我是不是本局的看客（局中进房的）
      spectating: this.spectators.has(me),
      joinedThisGame: !!p,

      // 公开的玩家名片（无身份）
      players: this.playerCards(),
      aliveCount: this.alivePlayers().length,
      wolfAlive: this.wolves(true).length,

      // 本轮主题：**作画阶段开始就公开**（大家画的是同一题，藏也没用 ——
      // 而且前端要靠它显示「本轮画什么」）。词本身不是秘密，谁画的才是。
      theme: this.theme,
      themeName: (THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '',
      word: this.currentWord(),

      // 作画进度（不含内容、不含作者）
      drawTotal: this.alivePlayers().length,
      drawDone: this.submitted.size,
      myDrawn: this.submitted.has(me),
      isDrawPhase: phase === SKIN_PHASE.DAY_DRAW,
      canDraw: phase === SKIN_PHASE.DAY_DRAW && !!p && p.alive,

      // 展示 + 讨论：匿名作品（id 只是本轮内的序号，不是 userId）
      gallery: showGallery ? this.works.map(w => ({
        id: w.id,
        png: w.skipped ? '' : w.png,
        skipped: !!w.skipped
      })) : null,
      galleryCount: this.works.length,

      // 投票
      voteTotal: this.alivePlayers().length,
      voteDone: this.votes.size,
      myVote: this.votes.get(me) || '',
      canVote: phase === SKIN_PHASE.DAY_VOTE && !!p && p.alive,
      voteResult: this.voteResult,

      // 猎人待开枪
      pendingShot: this.pendingShot === me,
      shotPending: !!this.pendingShot,

      // 昨晚的公告（天亮之后到本局结束一直可见 —— 大家要能回头看）
      lastNight: (phase === SKIN_PHASE.DAWN || showGallery || phase === SKIN_PHASE.OVER)
        ? (this.lastNightSummary || null) : null,

      // 胜负
      winner: this.winner,
      winnerName: this.winner === CAMP.GOOD ? '画师阵营' : this.winner === CAMP.WOLF ? '伪装者阵营' : '',
      winReason: this.winReason,

      locked: this.lockedFor(me),
      isOwner: this.isOwner(me),
      canStart: phase === SKIN_PHASE.LOBBY || phase === SKIN_PHASE.OVER,
      minPlayers: P.GAME.SKIN_MIN_PLAYERS,
      maxPlayers: P.GAME.SKIN_MAX_PLAYERS,
      maxRoundsMax: P.GAME.SKIN_MAX_ROUNDS,
      themes: THEMES.themeList(),
      phaseMs: this.phaseMs()
    };
  }

  /** 本阶段的时长 */
  phaseMs() {
    switch (this.phase) {
      case SKIN_PHASE.NIGHT: return CFG.NIGHT_MS;
      case SKIN_PHASE.DAWN: return CFG.DAWN_MS;
      case SKIN_PHASE.DAY_DRAW: return this.drawMs || CFG.DRAW_MS;
      case SKIN_PHASE.DAY_TALK: return CFG.TALK_MS;
      case SKIN_PHASE.DAY_VOTE: return CFG.VOTE_MS;
      case SKIN_PHASE.VOTE_END: return CFG.VOTE_END_MS;
      default: return 0;
    }
  }

  /** 本轮的主题词 */
  currentWord() {
    if (!this.round) return '';
    return this.themeWords[this.round - 1] || '';
  }

  /**
   * 我这一步要做什么 —— 接口兼容用的（接龙有 taskFor，这里给一个语义等价的）。
   * 画皮没有「题面」这种只有当事者能看的东西（主题是公开的），
   * 所以返回 null；私有信息全走 SKIN_ROLE / SKIN_NIGHT 单发。
   */
  taskFor() { return null; }

  /**
   * 该用户此刻能不能改画布。
   *
   * 只有作画阶段、且活着的人能动笔 —— 而且**画布是私密的**（见 index.js 的 privateDrawOn），
   * 每个人画的只有自己看得见，交稿后才匿名摊开。
   *
   * 出局的人：**不能画，但能看能说**。这跟狼人杀里死人有遗言、能围观是一个道理，
   * 也是这个玩法的乐趣之一（死了还要搅局）。所以这里只拦画笔，不拦聊天 / 投票界面
   * （投票在 vote() 里另外按 alive 拦）。
   */
  lockedFor(userId) {
    if (this.phase === SKIN_PHASE.DAY_DRAW) {
      const p = this.entryOf(userId);
      return !(p && p.alive);
    }
    if (this.phase === SKIN_PHASE.NIGHT || this.phase === SKIN_PHASE.DAWN) return true;
    if (this.phase === SKIN_PHASE.DAY_TALK || this.phase === SKIN_PHASE.DAY_VOTE ||
      this.phase === SKIN_PHASE.VOTE_END) return true;
    return false;
  }

  blocksWrite(userId) { return this.lockedFor(userId); }

  /**
   * 这个人此刻说的话会不会泄露「别人不该知道的东西」。
   *
   * 画皮里**全场都该说话**（这就是讨论环节），所以默认不拦。
   * 唯一的例外是夜里 —— 天黑的时候聊天等于把「谁在动」广播出去
   * （「我验了 3 号，是狼」直接发在公屏上，游戏就结束了）。
   */
  chatLeaks(userId) {
    if (this.phase === SKIN_PHASE.NIGHT) return true;
    return false;
  }

  /* ------------------------------------------------------------ 开局 */

  start(opts) {
    const players = this.playerList();
    const min = P.GAME.SKIN_MIN_PLAYERS;
    if (players.length < min) {
      return { ok: false, code: 'too_few', message: '画皮至少要 ' + min + ' 个人（6 人以下凑不出狼与神职）' };
    }
    const max = P.GAME.SKIN_MAX_PLAYERS;
    if (players.length > max) {
      return { ok: false, code: 'too_many', message: '画皮最多 ' + max + ' 个人' };
    }

    this.spectators.clear();
    this.maxRounds = clampInt(opts && opts.rounds, P.GAME.SKIN_ROUNDS, 1, P.GAME.SKIN_MAX_ROUNDS);
    this.theme = (opts && THEMES.hasTheme(opts.theme)) ? opts.theme : 'default';
    const dsec = Math.floor(Number(opts && opts.drawSeconds));
    this.drawMs = (isFinite(dsec) && dsec > 0)
      ? clampInt(dsec, 60, P.GAME.DRAW_SECONDS_MIN, P.GAME.DRAW_SECONDS_MAX) * 1000
      : 0;

    // 配身份：先把身份洗好，再按打乱的顺序发下去 ——
    // 分两步是为了让「谁是狼」既不与「谁先加进来的」相关、也不与「谁在列表里靠前」相关。
    const roles = rolePlan(players.length);
    const sorted = shuffle(players);
    this.players = sorted.map((pl, i) => ({
      id: pl.userId,
      name: pl.name,
      role: roles[i],
      alive: true,
      diedAt: 0,
      cause: '',
      // 中途退场（不是被杀 / 被投）—— 判胜负时要与「出局」区分开，
      // 见 checkWin() 里那段关于「狼自己退出不算好人赢」的说明
      retired: false
    }));
    this.names = new Map();
    for (const pl of players) this.names.set(pl.userId, pl.name);
    for (const p of this.players) this.names.set(p.id, p.name);

    // 展示 / 讨论的顺序：开局打乱一次，整局固定（免得每轮重新洗，看着乱）
    this.order = this.players.map(p => p.id);

    // 主题词：本局一共要画 maxRounds 张，一次取够，不重复
    const pool = WORDS.poolForTheme(this.theme);
    this.usedWords = [];
    this.themeWords = pickWords(pool, this.maxRounds, []);
    for (const w of this.themeWords) this.usedWords.push(w);

    this.round = 0;
    this.nightNo = 0;
    this.nightKill = '';
    this.nightWolfVotes = new Map();
    this.nightChecks = new Map();
    this.nightLastCheck = null;
    this.witchSaveUsed = false;
    this.witchSaved = '';
    this.nightDeaths = [];
    this.lastNightSummary = null;
    this.works = [];
    this.submitted = new Set();
    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';
    this.winner = '';
    this.winReason = '';
    this.startedAt = Date.now();

    this.phase = SKIN_PHASE.LOBBY;
    this.api.sync();

    const w = this.wolves(false).length;
    this.api.systemChat('画皮开始了！' + this.players.length + ' 人局：'
      + (this.players.length - w) + ' 位画师 vs ' + w + ' 位伪装者。'
      + '共 ' + this.maxRounds + ' 轮（主题：'
      + ((THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '通用') + '）');

    this.beginNight();
    return { ok: true };
  }

  /* ------------------------------------------------------------ 夜 */

  /**
   * 入夜。夜里要收齐三种动作：
   *   狼人刀人（每个狼投一票，结算时取多数 —— 平票就随机，见 resolveNight）
   *   预言家验人（当夜就出结果，写进 nightLastCheck，单发给他）
   *   女巫用解药（只有一瓶）
   *
   * 女巫救人**不需要等服务端告诉他谁被刀**：客户端拿到 SKIN_NIGHT 里的
   * 「被刀的是谁」就地显示了（见 nightInfoFor）。服务端不等他的确认 ——
   * 他不操作就是不用药。
   */
  beginNight() {
    const alive = this.alivePlayers();
    if (!this.enoughToPlay(alive)) return this.toLobby('人数不足，游戏已暂停');

    this.round += 1;
    this.nightNo = this.round;
    if (this.round > this.maxRounds) {
      // 打到轮数上限还没分胜负 → 好人没能完成指定的画作，判狼胜
      return this.finish(CAMP.WOLF, '一直没能把伪装者投出去（打满 ' + this.maxRounds + ' 轮）');
    }

    this.nightKill = '';
    this.nightWolfVotes = new Map();
    this.nightLastCheck = null;
    this.witchSaved = '';
    this.nightDeaths = [];
    this.works = [];
    this.submitted = new Set();
    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';

    this.phase = SKIN_PHASE.NIGHT;
    this.deadline = Date.now() + CFG.NIGHT_MS;
    // 夜里把画布清干净 —— 上一轮讨论时画布上可能还留着东西
    this.api.resetCanvas();
    this.api.sync();
    this.api.systemChat('第 ' + this.round + ' 夜 · 天黑请闭眼。预言家验人，伪装者决定今晚的猎物（'
      + Math.round(CFG.NIGHT_MS / 1000) + ' 秒）');
  }

  /**
   * 夜里的动作。
   *
   * ⚠ 所有裁定都在这里做完，客户端传来的东西只当**意图**：
   * 目标必须真的活着、必须是你有资格动的（预测不能验自己人？可以验 —— 验到好人也是信息；
   * 但狼不能刀自己）。
   */
  nightAction(userId, kind, target) {
    if (this.phase !== SKIN_PHASE.NIGHT) return { ok: false, message: '现在不是夜晚' };
    const me = this.entryOf(userId);
    if (!me || !me.alive) return { ok: false, message: '你已经出局了' };
    const t = this.entryOf(target);
    if (!t || !t.alive) return { ok: false, message: '这个人不在场上' };

    if (kind === 'kill') {
      if (me.role !== ROLE.WOLF) return { ok: false, message: '只有伪装者能在夜里动手' };
      if (t.role === ROLE.WOLF) return { ok: false, message: '不能对同伴下手' };
      this.nightWolfVotes.set(userId, target);
      this.api.sync();
      // 狼全投完 → 账目清楚了，但**不立刻**结算：
      // 女巫还没来得及看「今晚刀的是谁」（她等狼定了才知道该不该用药）。
      // 给她一个短窗口（WITCH_GRACE_MS），到点由 tick 收尾；房主也可以直接按推进。
      // 这一手是必要的时序：狼先定刀、女巫后决定，顺序反了女巫就无从判断。
      if (this.nightReady()) this.armNightGrace();
      return { ok: true };
    }

    if (kind === 'check') {
      if (me.role !== ROLE.SEER) return { ok: false, message: '只有预言家能验人' };
      let set = this.nightChecks.get(userId);
      if (!set) { set = new Set(); this.nightChecks.set(userId, set); }
      if (set.has(target)) return { ok: false, message: '你已经验过这个人了' };
      set.add(target);
      const info = ROLE_INFO[t.role] || {};
      this.nightLastCheck = { by: userId, target: target, camp: info.camp || '' };
      // 结果立刻单发给预言家自己（他不该等到天亮才知道）
      this.api.sync();
      return { ok: true };
    }

    if (kind === 'save') {
      if (me.role !== ROLE.WITCH) return { ok: false, message: '只有女巫能用药' };
      if (this.witchSaveUsed) return { ok: false, message: '解药已经用掉了' };
      if (this.round === 1 && target === userId) return { ok: false, message: '第一晚不能自救' };
      // 只能救「今晚真的被刀的那个人」。
      // 不校验的话，女巫可以随手点任何人、把解药浪费在没危险的人身上 ——
      // 更糟的是 resolveNight 拿 witchSaved === kill 去比，点了别人等于白点，
      // 玩家会以为「我救了但没救到」，其实是服务端该拦。
      const killTarget = this.pendingKillTarget();
      if (!killTarget) return { ok: false, message: '今晚还没有人被刀（等伪装者定下来）' };
      if (target !== killTarget) return { ok: false, message: '药只能用在今晚被刀的人身上' };
      this.witchSaveUsed = true;
      this.witchSaved = target;
      this.api.sync();
      return { ok: true };
    }

    return { ok: false, message: '夜里做不了这件事' };
  }

  /**
   * 夜里的动作都收齐了吗。
   *
   * 只有**狼刀**是硬性条件：狼全投完就能结算。
   *
   * 预言家 / 女巫都是**可选**的，不等他们 —— 理由是这三种动作的性质不同：
   *   - 狼不投 → 今晚就没有尸体，等于白送好人一夜，不能替狼决定，所以要等
   *   - 预言家不验 → 只是他自己放弃一次情报，与别人无关，没有等他的道理
   *   - 女巫不用药 → 同上
   * 早先的版本把「预言家验过」也当硬性条件，结果是：预言家掉线、或者单纯忘了点，
   * 全场就得干等到 NIGHT_MS 超时，房主按「推进」也推不动 —— 一个人卡一整晚。
   */
  nightReady() {
    const aliveWolves = this.wolves(true);
    if (aliveWolves.some(w => !this.nightWolfVotes.has(w.id))) return false;
    return true;
  }

  /**
   * 狼定完刀之后，给女巫留的决策窗口。
   *
   * 为什么需要这一手：女巫该不该用解药，完全取决于「今晚刀的是谁」——
   * 那是狼决定的。如果狼一投完就结算，女巫永远赶不上（她连刀口是谁都不知道）。
   * 所以狼收齐后把 deadline 提前到「现在 + WITCH_GRACE_MS」，
   * 让她的操作来得及落进 resolveNight 的 `this.witchSaved === kill` 比较里。
   *
   * 已经用过药的局不必再等（女巫无药可用），直接结算。
   */
  armNightGrace() {
    if (this.phase !== SKIN_PHASE.NIGHT) return;
    // 女巫还活着且还有药 → 等窗口；否则没人要看，直接天亮
    const witch = this.alivePlayers().filter(p => p.role === ROLE.WITCH)[0];
    if (!witch || this.witchSaveUsed) { this.deadline = 0; this.resolveNight(); return; }
    this.deadline = Date.now() + CFG.WITCH_GRACE_MS;
    this.api.sync();
  }

  /** 这一夜还有谁没动（仅用于给前端提示「在等谁」，不参与结算判定） */
  nightPending() {
    const out = [];
    for (const w of this.wolves(true)) {
      if (!this.nightWolfVotes.has(w.id)) out.push({ userId: w.id, kind: 'kill' });
    }
    const seer = this.alivePlayers().filter(p => p.role === ROLE.SEER)[0];
    if (seer && !this.nightLastCheck) out.push({ userId: seer.id, kind: 'check' });
    const witch = this.alivePlayers().filter(p => p.role === ROLE.WITCH)[0];
    if (witch && !this.witchSaveUsed) out.push({ userId: witch.id, kind: 'save' });
    return out;
  }

  /**
   * 结算夜晚 → 天亮。
   *
   * 刀人的多数决：每个活狼一票，票数最多的那个挨刀；**平票时随机取一个** ——
   * 让狼内部有分歧时也有个确定结果，不然就得再等一轮协商（狼是队友，
   * 让服务端替他们做决定比逼他们必须达成一致要顺手）。
   */
  resolveNight() {
    if (this.phase !== SKIN_PHASE.NIGHT) return;

    const tally = new Map();
    for (const target of this.nightWolfVotes.values()) {
      // 空串 = 弃刀 / 退场者的占位，不计入票数（见 nightAction 与 onLeave）
      if (!target) continue;
      tally.set(target, (tally.get(target) || 0) + 1);
    }
    let kill = '';
    if (tally.size) {
      let best = -1;
      const top = [];
      for (const [t, n] of tally) {
        if (n > best) { best = n; top.length = 0; top.push(t); }
        else if (n === best) top.push(t);
      }
      kill = top.length === 1 ? top[0] : top[Math.floor(Math.random() * top.length)];
    }
    // 女巫的解药：保住这条命（但 kill 仍然记下来 —— 被刀的人要知道自己差点没了）
    let saved = false;
    if (kill && this.witchSaved === kill) saved = true;

    this.nightKill = kill;
    this.nightDeaths = [];
    if (kill && !saved) {
      const p = this.entryOf(kill);
      if (p) {
        p.alive = false;
        p.diedAt = Date.now();
        p.cause = 'wolf';
        this.nightDeaths.push(kill);
      }
    }

    // 天亮的公告：**只说有没有人走、走的是谁**，不解释「谁干的」（那本来就是明的）
    const deadNames = this.nightDeaths.map(id => this.names.get(id) || '某人');
    if (!this.round) { /* 不可能发生，防御一下 */ }
    if (deadNames.length) {
      this.lastNightSummary = {
        round: this.round,
        deaths: this.nightDeaths.slice(),
        deathNames: deadNames,
        saved: false,
        text: '昨晚 ' + deadNames.join('、') + ' 走了'
      };
    } else if (saved) {
      this.lastNightSummary = {
        round: this.round, deaths: [], deathNames: [], saved: true,
        text: '昨晚是平安夜 —— 有人被刀，但被救了回来'
      };
    } else {
      this.lastNightSummary = {
        round: this.round, deaths: [], deathNames: [], saved: false,
        text: '昨晚是平安夜'
      };
    }

    this.phase = SKIN_PHASE.DAWN;
    this.deadline = Date.now() + CFG.DAWN_MS;
    this.api.sync();
    this.api.systemChat('第 ' + this.round + ' 天天亮了：' + this.lastNightSummary.text);

    // 死了人要先判胜负（狼数 ≥ 好人数就当场结束，不用再画一轮）
    const r = this.checkWin();
    if (r) return;
  }

  /* ------------------------------------------------------------ 白天：作画 */

  beginDraw() {
    if (this.phase !== SKIN_PHASE.DAWN && this.phase !== SKIN_PHASE.VOTE_END) {
      if (this.phase !== SKIN_PHASE.NIGHT) return;
    }
    const alive = this.alivePlayers();
    if (!this.enoughToPlay(alive)) return this.toLobby('人数不足，游戏已暂停');

    // 新一轮 = 新一轮作画：把上一轮的产物清掉（不然大家看的是旧画）
    this.works = [];
    this.submitted = new Set();
    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';
    this.nightKill = '';
    this.nightLastCheck = null;
    this.witchSaved = '';
    this.nightWolfVotes = new Map();

    this.phase = SKIN_PHASE.DAY_DRAW;
    this.deadline = Date.now() + (this.drawMs || CFG.DRAW_MS);
    // 作画阶段：**私密画**（privateDrawOn 在 index.js 里按这个 phase 打开）。
    // 清画布放在这里而不是入夜 —— 夜里清过一次了，但讨论阶段可能有人手贱画了两笔，
    // 这一笔会跟着私密画布一起交上去，所以这里再清一次最保险。
    this.api.resetCanvas();
    this.api.sync();

    const secs = Math.round((this.drawMs || CFG.DRAW_MS) / 1000);
    this.api.systemChat('第 ' + this.round + ' 轮作画 · 主题「' + this.currentWord() + '」'
      + '（' + secs + ' 秒，各自画，看不见别人 —— 交稿后匿名摊开）');
  }

  /**
   * 交画。像素由客户端渲染后回传，服务端只做哑存储。
   *
   * ⚠ 交上来的图**不带作者**（works 里存了 userId，但 snapshotFor 里只发 id + png）。
   *   这是这个玩法的核心：猜作者就是玩法本身。
   */
  submitArt(userId, png) {
    if (this.phase !== SKIN_PHASE.DAY_DRAW) return { ok: false, message: '现在不是作画阶段' };
    const p = this.entryOf(userId);
    if (!p || !p.alive) return { ok: false, message: '你已经出局了，只能看着' };
    if (this.submitted.has(userId)) return { ok: false, message: '你已经交过了' };
    if (!png || typeof png !== 'string' || png.indexOf('data:image/') !== 0) {
      return { ok: false, message: '作品数据不对' };
    }
    if (png.length > P.GAME.SKIN_ART_MAX) return { ok: false, message: '这幅画太大了' };

    this.submitted.add(userId);
    this.works.push({ id: 'w' + (this.works.length + 1), userId: userId, png: png, skipped: false });
    this.api.sync();
    if (this.submitted.size >= this.alivePlayers().length) this.beginTalk();
    return { ok: true };
  }

  /**
   * 跳过自己的作画（弃权）。
   * 门槛很高（要交满 2/3 的活人放弃才跳过），否则一个人点一下就能把全场推进 ——
   * 那不是「少数服从多数」，是「手快的人说了算」。
   */
  skipDraw() {
    if (this.phase !== SKIN_PHASE.DAY_DRAW) return { ok: false, message: '现在不是作画阶段' };
    this.beginTalk();
    return { ok: true };
  }

  /** 作画超时：没交的人留一张空画（**不记名字**，展示阶段它就是「一张空白」） */
  timeoutDraw() {
    if (this.phase !== SKIN_PHASE.DAY_DRAW) return;
    const pending = [];
    for (const p of this.alivePlayers()) {
      if (this.submitted.has(p.id)) continue;
      pending.push(this.names.get(p.id) || p.name);
      this.submitted.add(p.id);
      this.works.push({ id: 'w' + (this.works.length + 1), userId: p.id, png: '', skipped: true });
    }
    if (pending.length) {
      this.api.systemChat('超时：' + pending.join('、') + ' 这次没交画，展示里是空白');
    }
    this.beginTalk();
  }

  /* ------------------------------------------------------------ 白天：看画与讨论 */

  /**
   * 进展示 / 讨论阶段。
   *
   * 顺序上有个取舍：**作品不按交稿顺序排**，而是开局打乱过的固定顺序（this.order）。
   * 按交稿顺序排的话，「最后一个交的」就成了可观察的信息 ——
   * 谁要是每次都拖到最后交，几轮下来就能拿这个当身份线索。
   */
  beginTalk() {
    if (this.phase !== SKIN_PHASE.DAY_DRAW) return;
    // 按固定顺序排（只在本人还活着 / 这一轮交过画的人里排）
    const byUser = new Map();
    for (const w of this.works) byUser.set(w.userId, w);
    const ordered = [];
    for (const id of this.order) {
      const w = byUser.get(id);
      if (w) { ordered.push(w); byUser.delete(id); }
    }
    // 中途冒出来的（理论上不该有，防御性写法）：按原顺序补在后面
    for (const w of byUser.values()) ordered.push(w);
    // 重新编 id：编号只表示「第几个」，与交稿顺序脱钩
    ordered.forEach((w, i) => { w.id = 'w' + (i + 1); });
    this.works = ordered;

    this.phase = SKIN_PHASE.DAY_TALK;
    this.deadline = Date.now() + CFG.TALK_MS;
    this.api.sync();
    this.api.systemChat('画都在墙上了 —— 匿名看一看，谁在装、谁是真画师。'
      + '讨论 ' + Math.round(CFG.TALK_MS / 1000) + ' 秒后投票放逐');
  }

  /* ------------------------------------------------------------ 白天：投票 */

  beginVote() {
    if (this.phase === SKIN_PHASE.DAY_TALK || this.phase === SKIN_PHASE.VOTE_END) {
      // 正常推进
    } else if (this.phase !== SKIN_PHASE.DAWN) {
      return;
    }
    const alive = this.alivePlayers();
    if (!this.enoughToPlay(alive)) return this.toLobby('人数不足，游戏已暂停');

    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';
    this.phase = SKIN_PHASE.DAY_VOTE;
    this.deadline = Date.now() + CFG.VOTE_MS;
    this.api.sync();
    this.api.systemChat('投票放逐 —— 选出你觉得是伪装者的人（'
      + Math.round(CFG.VOTE_MS / 1000) + ' 秒，票是公开的）');
  }

  /**
   * 放逐投票。
   *
   * 票**公开**（谁投了谁在结算里写出来）。狼人杀里的匿名票会让「谁跟票」
   * 这条最重要的线索消失，而画皮本来信息就比标准狼人杀更少（没有发言的语速语气）。
   * 公开投票也让狼必须考虑「我这一票投出去会不会暴露」—— 玩法更厚。
   *
   * 可以改票；可以投自己（弃权 / 自证思路，也是常见的玩法）。
   */
  vote(userId, target) {
    if (this.phase !== SKIN_PHASE.DAY_VOTE) return { ok: false, message: '现在不是投票阶段' };
    const me = this.entryOf(userId);
    if (!me || !me.alive) return { ok: false, message: '你已经出局了，没有投票权' };
    if (target === 'skip' || target === '') {
      this.votes.delete(userId);
      this.api.sync();
      return { ok: true };
    }
    const t = this.entryOf(target);
    if (!t || !t.alive) return { ok: false, message: '这个人不在场上' };
    this.votes.set(userId, target);
    this.api.sync();
    if (this.votes.size >= this.alivePlayers().length) this.finishVote();
    return { ok: true };
  }

  /**
   * 结算放逐。
   *
   * 平票怎么办：**不放逐**（平安日）。另一种常见做法是「平票再投一轮」，
   * 但那要多一个阶段、多一个界面，首版不值得 —— 而且平票不追责本身
   * 也是一种玩法信息（说明好人分裂了，狼可以继续混）。
   */
  finishVote() {
    if (this.phase !== SKIN_PHASE.DAY_VOTE) return;
    const alive = this.alivePlayers();
    const tally = new Map();
    for (const t of this.votes.values()) tally.set(t, (tally.get(t) || 0) + 1);

    let best = 0;
    const top = [];
    for (const [t, n] of tally) {
      if (n > best) { best = n; top.length = 0; top.push(t); }
      else if (n === best) top.push(t);
    }
    const tie = top.length > 1 || best === 0;
    const exiled = (!tie && top.length === 1) ? top[0] : '';

    let shot = '';
    if (exiled) {
      const p = this.entryOf(exiled);
      if (p) {
        p.alive = false;
        p.diedAt = Date.now();
        p.cause = 'vote';
      }
      // 猎人的枪：被**放逐**时才能开（首版没有毒药，先留这条语义给将来）
      if (p && p.role === ROLE.HUNTER) this.pendingShot = exiled;
    }

    this.voteResult = {
      round: this.round,
      tally: Array.from(tally.entries()).map(([t, n]) => ({
        userId: t,
        name: this.names.get(t) || '某人',
        votes: n
      })).sort((a, b) => b.votes - a.votes),
      // 公开票：谁投了谁（狼人杀里这是最重要的推理材料，不能匿）
      ballot: Array.from(this.votes.entries()).map(([v, t]) => ({
        voter: v,
        voterName: this.names.get(v) || '某人',
        target: t,
        targetName: this.names.get(t) || '某人'
      })),
      tie: tie,
      exiled: exiled,
      exiledName: exiled ? (this.names.get(exiled) || '某人') : '',
      shot: shot,
      shotName: ''
    };

    this.phase = SKIN_PHASE.VOTE_END;
    this.deadline = Date.now() + CFG.VOTE_END_MS;
    this.api.sync();

    if (exiled) {
      this.api.systemChat('投票结果：' + this.voteResult.exiledName + ' 被放逐了'
        + (this.pendingShot ? '（TA 是猎人，可以开枪带走一个人）' : ''));
    } else {
      this.api.systemChat('投票平票 —— 今天没有人被放逐');
    }

    const r = this.checkWin();
    if (r) return;
  }

  /**
   * 猎人开枪。
   *
   * 只在「被放逐 + 自己是猎人 + 还没开过枪」时有效。
   * 开完枪立刻判胜负（一枪可能直接带走最后一头狼）。
   */
  hunterShot(userId, target) {
    if (!this.pendingShot) return { ok: false, message: '现在不是开枪的时候' };
    if (this.pendingShot !== userId) return { ok: false, message: '不是你开枪' };
    if (target === 'skip' || target === '') {
      // 放弃开枪
      this.pendingShot = '';
      if (this.voteResult) this.voteResult.shotName = '';
      this.api.sync();
      this.checkWin();
      return { ok: true };
    }
    const t = this.entryOf(target);
    if (!t || !t.alive) return { ok: false, message: '这个人不在场上' };
    t.alive = false;
    t.diedAt = Date.now();
    t.cause = 'shot';
    this.pendingShot = '';
    if (this.voteResult) {
      this.voteResult.shot = target;
      this.voteResult.shotName = this.names.get(target) || '某人';
    }
    this.api.sync();
    this.api.systemChat('猎人开枪带走了 ' + (this.names.get(target) || '某人'));
    this.checkWin();
    return { ok: true };
  }

  /* ------------------------------------------------------------ 胜负 */

  /**
   * 判胜负。
   *
   * 用户定的两条：
   *   好人赢 = 放逐所有狼人 **或** 完成指定数量的主题画作
   *   狼人赢 = 狼数 ≥ 好人数 **或** 连续几轮让好人无法完成画作
   *
   * 首版的落地方式（与用户口径的对应关系）：
   *   - 「放逐所有狼人」→ 狼全出局
   *   - 「完成指定数量的主题画作」→ 打满 maxRounds 且狼还有剩，就是**没完成**。
   *     也就是说这条不是一条独立的胜利条件，而是「拖到轮数上限就算好人失败」——
   *     因为「完成 n 幅画」在首版里没有任何判定难点（每个人交一张就是完成一张），
   *     只有把它当成**时限**才有意义。
   *   - 「狼数 ≥ 好人数」→ 标准判定
   *   - 「连续几轮让好人无法完成画作」→ 首版没有「破坏作画」的机制（狼的
   *     「做手脚」被推迟了），所以这条自然退化成「打满轮数」那一档。
   *
   * @returns {boolean} 是否已经结束本局
   */
  checkWin() {
    if (!this.active) return true;
    if (this.winner) return true;

    const wolfAlive = this.wolves(true).length;
    const aliveCount = this.alivePlayers().length;
    const goodAlive = aliveCount - wolfAlive;

    // 「狼全出局 → 好人赢」只在**真的把狼投出去 / 刀掉**时成立。
    // 狼自己退出不能算好人赢 —— 那不是「找出来了」，是「人不在了」。
    // 如果这里不区分，最后一个狼一退出，剩下的好人就白拿一场胜利。
    const anyRetired = this.players.some(p => p.retired);

    if (wolfAlive === 0 && !anyRetired) {
      this.finish(CAMP.GOOD, '所有伪装者都被找出来了');
      return true;
    }
    if (wolfAlive >= goodAlive) {
      this.finish(CAMP.WOLF, '伪装者的人数已经不少于画师（' + wolfAlive + ' vs ' + goodAlive + '）');
      return true;
    }
    return false;
  }

  finish(winner, reason) {
    this.winner = winner;
    this.winReason = reason || '';
    this.phase = SKIN_PHASE.OVER;
    this.deadline = 0;
    // 结算时公开所有身份 —— 这是符合玩家预期的（这局打完了，该知道谁是谁）
    this.api.sync();
    this.api.systemChat('本局结束：' + (winner === CAMP.GOOD ? '画师阵营' : '伪装者阵营')
      + '获胜（' + (reason || '') + '）');
    this.api.systemChat('身份公开 —— ' + this.players.map(p =>
      (this.names.get(p.id) || p.name) + '：' + (ROLE_INFO[p.role] || {}).name
      + (p.alive ? '' : '（已出局）')).join('　'));
  }

  /** 结算阶段要公开全部身份（前端拉一张「真相表」） */
  revealAll() {
    if (this.phase !== SKIN_PHASE.OVER) return null;
    return this.players.map(p => ({
      userId: p.id,
      name: this.names.get(p.id) || p.name,
      role: p.role,
      roleName: (ROLE_INFO[p.role] || {}).name || p.role,
      camp: (ROLE_INFO[p.role] || {}).camp || '',
      campName: (ROLE_INFO[p.role] || {}).campName || '',
      alive: p.alive,
      cause: p.cause || ''
    }));
  }

  /* ------------------------------------------------------------ 推进与时钟 */

  /**
   * 房主按「推进」：不等超时，把当前阶段该收的收了、直接进下一阶段。
   * 与接龙的 next() 同一个用意 —— 替等得不耐烦的人按下加速键。
   */
  next(userId) {
    if (!this.isOwner(userId)) return { ok: false, message: '只有房主可以推进' };
    switch (this.phase) {
      case SKIN_PHASE.NIGHT: return this.advanceNight();
      case SKIN_PHASE.DAWN: return this.advanceDawn();
      case SKIN_PHASE.DAY_DRAW: this.timeoutDraw(); return { ok: true };
      case SKIN_PHASE.DAY_TALK: this.beginVote(); return { ok: true };
      case SKIN_PHASE.DAY_VOTE: this.finishVote(); return { ok: true };
      case SKIN_PHASE.VOTE_END:
        // 猎人还没开枪时，房主推进 = 猎人放弃开枪
        if (this.pendingShot) { this.hunterShot(this.pendingShot, ''); return { ok: true }; }
        return { ok: false, message: '现在没什么可推进的' };
      default:
        return { ok: false, message: '现在没什么可推进的' };
    }
  }

  /** 夜 → 天亮（把没收齐的动作按「没动作」处理） */
  advanceNight() {
    if (this.phase !== SKIN_PHASE.NIGHT) return { ok: false, message: '现在不是夜晚' };
    // 没投的狼不投了 —— 不替他们随机，因为「弃刀」本身是一种选择
    // （首版没有「空刀」的收益，但也不该由服务端强行补一票）
    this.resolveNight();
    return { ok: true };
  }

  /** 天亮公告 → 作画 */
  advanceDawn() {
    if (this.phase !== SKIN_PHASE.DAWN) return { ok: false, message: '现在不是天亮阶段' };
    this.beginDraw();
    return { ok: true };
  }

  /** 投票结算 → 下一夜（猎人没开枪就先等着） */
  advanceVoteEnd() {
    if (this.phase !== SKIN_PHASE.VOTE_END) return;
    if (this.pendingShot) return;   // 等猎人操作（有时限，见 tick）
    const r = this.checkWin();
    if (r) return;
    this.beginNight();
  }

  tick(nowMs) {
    if (!this.active || !this.deadline) return;
    if (nowMs < this.deadline) return;
    switch (this.phase) {
      case SKIN_PHASE.NIGHT: return this.advanceNight();
      case SKIN_PHASE.DAWN: return this.advanceDawn();
      case SKIN_PHASE.DAY_DRAW: return this.timeoutDraw();
      case SKIN_PHASE.DAY_TALK: return this.beginVote();
      case SKIN_PHASE.DAY_VOTE: return this.finishVote();
      case SKIN_PHASE.VOTE_END:
        // 猎人放弃开枪（超时等于弃枪），然后进下一夜
        if (this.pendingShot) { this.hunterShot(this.pendingShot, ''); }
        this.deadline = 0;
        return this.advanceVoteEnd();
      default: return;
    }
  }

  toLobby(reason) {
    this.phase = SKIN_PHASE.LOBBY;
    this.deadline = 0;
    this.works = [];
    this.submitted = new Set();
    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';
    this.api.sync();
    if (reason) this.api.systemChat(reason);
  }

  stop() {
    this.spectators.clear();
    this.phase = SKIN_PHASE.OFF;
    this.deadline = 0;
    this.players = [];
    this.works = [];
    this.submitted = new Set();
    this.votes = new Map();
    this.voteResult = null;
    this.pendingShot = '';
    this.nightWolfVotes = new Map();
    this.nightChecks = new Map();
    this.nightLastCheck = null;
    this.winner = '';
    this.winReason = '';
    this.api.sync();
  }

  /* ------------------------------------------------------------ 成员变动 */

  onJoin(member) {
    if (!this.active) return;
    if (!this.names.has(member.userId)) this.names.set(member.userId, member.name);
    // 局中进房：本局只能看（身份已经发完了，这时候插进来等于白送一个身份）。
    // 注意**不能**把他塞进 players —— 那会让「昨晚验了谁」的记忆在两边对不上。
    if (this.midGame()) {
      this.spectators.add(member.userId);
      this.api.systemChat(member.name + ' 加入了，本局画皮正在进行，先观战 —— 房主开下一局就能一起玩');
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
    const p = this.entryOf(member.userId);
    if (!p) { this.api.sync(); return; }

    // 走的人从场上抹掉。
    // ⚠ 这一步是必须的：不给 p.alive 置 false 的话，他仍然算在「活着的人」里，
    //   aliveCount 虚高、狼数/好人数算错，而且作画和投票会永远等一个不在的人。
    //   退出与「被刀 / 被放逐」在后续判定里应当完全等价 —— 都是「这个人不在了」。
    const wasAlive = p.alive;
    p.alive = false;
    p.cause = 'left';
    p.retired = true;

    // 退出本身就可能直接改变胜负（走了最后一个好人 / 走了最后一头狼），
    // 所以任何阶段都要先过一遍 —— 放后面的话会被「阶段专门处理」提前 return 掉。
    if (wasAlive && this.phase !== SKIN_PHASE.LOBBY && this.phase !== SKIN_PHASE.OVER) {
      if (this.checkWin()) return;
    }

    // 走的是夜里该做事的人 → 别让全场干等，把他的动作当「没动作」处理。
    // 狼的动作按「弃刀」算：nightReady() 只看活着的狼是不是都投过票，
    // 所以这个人的投票占位必须补上（不补的话狼队永远收不齐，全场等到超时）。
    if (this.phase === SKIN_PHASE.NIGHT) {
      if (p.role === ROLE.WOLF && !this.nightWolfVotes.has(p.id)) {
        this.nightWolfVotes.set(p.id, '');   // 空刀占位（resolveNight 里空串会被跳过）
      }
      if (this.nightReady()) this.armNightGrace();
      this.api.sync();
      return;
    }

    // 走的是作画阶段还没交画的人 → 立即按「没交」处理，免得剩下的人等他到超时
    if (this.phase === SKIN_PHASE.DAY_DRAW && !this.submitted.has(p.id)) {
      this.submitted.add(p.id);
      this.works.push({ id: 'w' + (this.works.length + 1), userId: p.id, png: '', skipped: true });
      if (this.submitted.size >= this.alivePlayers().length) { this.beginTalk(); return; }
    }

    // 走的是投票阶段还没投的人 → 同理
    if (this.phase === SKIN_PHASE.DAY_VOTE) {
      if (this.votes.size >= this.alivePlayers().length) { this.finishVote(); return; }
    }

    // 走的是待开枪的猎人 → 弃枪
    if (this.pendingShot === member.userId) {
      this.pendingShot = '';
      this.advanceVoteEnd();
      return;
    }

    // 活人少到打不下去 → 回大厅（胜负已经在上面判过了）
    if (this.phase !== SKIN_PHASE.LOBBY && this.phase !== SKIN_PHASE.OVER &&
      !this.enoughToPlay()) {
      this.toLobby(member.name + ' 离开了，场上只剩 '
        + this.alivePlayers().length + ' 个人，玩不下去了，游戏已暂停');
      return;
    }

    this.api.sync();
  }
}

module.exports = {
  SkinGame,
  SKIN_PHASE,
  SKIN_PHASE_LABEL,
  ROLE,
  ROLE_INFO,
  CAMP,
  CFG,
  rolePlan   // 导出供自检脚本直接验证「按人数配比」
};
