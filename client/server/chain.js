'use strict';

/**
 * 接龙模式（chain / Whisper）—— 服务端权威状态机。【v2 重制版】
 *
 * 玩法一句话：**N 个玩家 = N 条并行的链**。每条链以「链主写的初始词」为起点，
 * 沿打乱过的玩家环一圈一圈传下去 —— 拿到词的人画，拿到画的人猜，
 * 拿到猜出的词再画…… 全部传完后一起看回放：一个词是怎么一步步跑偏的。
 *
 * 与 v1（旧 chain.js）的关键差异 —— 这一版是按 Draw & Guess 的 Whisper 玩法重写的：
 *   1. **链长 = 2 × 人数**（可设定 3 ~ 2×人数）。每人占**连续两格**：
 *      先画自己刚拿到的（词或上家的画），再猜下一格 —— 猜完立刻画，画完才交棒。
 *      默认链长下每一格恰好 n 个 cell，每个人都恰好有自己的一格要做 ——
 *      不再有「掉线顶替把格子派重复」的错乱。4 人房的 8 步见 authorOffset()。
 *      ★ v12「大房间分组」：人多了就把玩家**均分成若干组**，每条链只在**组内**传一圈
 *        （组内链长 = 2 × 该组人数）—— 不让人等太久、链条也不拉太长。见 planGroups()。
 *        4~6 人 = 1 组（就是原来的全局环，行为一模一样）；7~10 人 = 2 组；
 *        11~12 人 = 3 组；13~16 人 = 4 组。多组用**同一个全局 stepIndex 并行推进**：
 *        第 k 格里每个组各自的成员同时做自己组的那一格。
 *   2. **产物是笔迹数据，不是 PNG**。DRAWING 格的 content = 作者的笔迹数组
 *      （points / color / size / tool……），猜词的人拿到笔迹在本地渲染，
 *      回放时也能按真实笔序重新演一遍。
 *   3. **信息隔离是死穴**：每人只拿自己这一格的输入 ——
 *      WORD 格拿候选词、DRAWING 格拿要画的词、GUESS 格拿上家的笔迹。
 *      完整链条只在服务端；进 REVEAL 阶段才一次性公开（走独立的 GAME_REVEAL 消息，
 *      绝不搭 GAME_STATE 的广播快照 —— 那条每秒都在重发，塞几 MB 笔迹进去会卡死公网房）。
 *   4. **流程**：大厅（全员准备）→ 开场 → 写词 → 画/猜交替 → 回放 → 投票 → 结算 → 回大厅。
 *      投票有两票：每条链「首尾是否还对得上」+ 全场「最喜欢的一张画」。
 *   5. **回放棒次（revealStep）由服务端持有**：每过 revealLegMs() 推进一格，
 *      快照下发 revealStep / revealLegs / legHoldMs —— 四个端看到的永远是同一格。
 *   6. **每一棒都自检「下一棒有人接」**：n 人必须拿到 n 个互不相同的 cell（v12 起是**按组**
 *      断言：组内每人恰好一个 cell），断了就 console.error + 系统播报 + 强制推进
 *      （见 assertChainIntact / checkChainOrForce）。
 *   7. **每条链各投一次 ♥**（v12）：votesFav 是 userId -> Map(chainId -> step)，
 *      投了下一条链的 ♥ 不会把上一条的票冲掉；最终「点赞最多的画」跨链统计，
 *      并把那一格的笔迹（strokes）一起给前端，省得前端再回查。
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

/**
 * ★ v17：接龙的两种玩法（每局设置 chainPlay，见协议 GAME.CHAIN_PLAYS）。
 *
 *   CLASSIC（接龙模式）：猜完**自己画**自己猜出来的词，再传给下家猜 ——
 *     4 人：起词A → 画A → 猜A → 画A → 猜A…（每人连着两格，链长 = 2 × 组人数）
 *   RELAY（传词接龙）：猜完**不画**，把猜出来的词直接交给**下家画**，画完再交给再下家猜 ——
 *     4 人 2 轮：起词A → 画A → 猜B → 画C → 猜D → 画A → 猜B → 画C → 猜D（链长 = 1 + 轮数×人数）
 *
 * 两种玩法**共用同一套数据结构与阶段机**（steps 都是「词 / 画 / 猜」的序列），
 * 差别只在「第 k 格是谁的活」（legOffsetIn）与链长（groupChainLen）。
 */
const CHAIN_PLAY = { CLASSIC: 'classic', RELAY: 'relay' };

/**
 * ★ v12 大房间分组的**人数 → 组数**表（用户明确要求）：
 *
 *   4~6 人   → 1 组（每人一条链，链传遍全场）—— 就是 v11 的行为，完全不变
 *   7~10 人  → 2 组
 *   11~12 人 → 3 组
 *   13~16 人 → 4 组
 *
 * 超过 4 组不再细分（16 人封顶 → 每组 4 人，组内链长 8 格，与 4 人房同量级）。
 * 组内传遍 = **不让一个人等太久、链条也不拉太长**：16 人若还是一条链传全场，
 * 一局要 32 格 × 每格几十秒，等一轮就散了。
 */
const GROUP_TABLE = [
  { min: 13, groups: 4 },
  { min: 11, groups: 3 },
  { min: 7, groups: 2 },
  { min: 4, groups: 1 }
];

/** 人数 → 组数（表外的人数为兜底：少于 4 人 1 组，多于 16 人也按 4 组） */
function groupCountFor(n) {
  for (const row of GROUP_TABLE) if (n >= row.min) return row.groups;
  return 1;
}

/**
 * 把 n 个人**尽量均分**成 groupCountFor(n) 组，返回每组的**人数**数组。
 *
 * 除法取整、余数摊给前面的组（16 → 4/4/4/4；13 → 4/3/3/3；10 → 5/5；7 → 4/3）。
 * 做成功 pure function 是为了让「分组表」本身可以被测试直接钉住
 * （见 tools/test-chain-sim.js 的 [15] 分组表）。
 */
function groupSizesFor(n) {
  const total = Math.max(0, Math.floor(Number(n)) || 0);
  const groups = Math.min(groupCountFor(total), Math.max(1, total));
  const base = Math.floor(total / groups);
  const rest = total % groups;
  const out = [];
  for (let i = 0; i < groups; i++) out.push(base + (i < rest ? 1 : 0));
  return out.filter(s => s > 0);
}

/** 单幅画笔迹的硬上限（防恶意刷爆内存 / 回放包；正常绘画远够不到） */
const MAX_STROKES_PER_ART = 400;
const MAX_POINTS_PER_ART = 80000;

function clampInt(v, d, a, b) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return d;
  return n < a ? a : n > b ? b : n;
}

function envMs(key, dflt) {
  if (gameFast()) return 1000;
  const n = Math.floor(Number(process.env[key]));
  return isFinite(n) && n > 0 ? n : dflt;
}

/** 宽限值专用：**不受 GAME_FAST 影响** —— 它压掉的是超时者的缓冲，等于给人开后门 */
function envGraceMs(key, dflt) {
  const n = Math.floor(Number(process.env[key]));
  return isFinite(n) && n > 0 ? n : dflt;
}

/**
 * GAME_FAST=1：把**所有阶段时长的默认值**压成 1 秒（自动化测试用，见 tools/test-game-setup.js）。
 *
 * ⚠ 只压「默认值」这一层：
 *   - 房主在开局设置里显式设定的每局覆盖值仍然优先（`this.drawMs || CFG.DRAW_MS`）；
 *   - 收格宽限 GRACE_MS **不压**（见 envGraceMs）—— 那是给「倒计时到点时还在路上的
 *     自动提交包」留的余量，压掉等于把超时的人直接判死，反而让测试看不出真问题。
 */
function gameFast() {
  const v = process.env.GAME_FAST;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
}

/**
 * 「每局覆盖」的秒数：0 / 缺省 / 非法 / 负数 = 用默认（返回 0），
 * 否则夹到 [SETUP_SECONDS_MIN, SETUP_SECONDS_MAX] 并换成毫秒。
 */
function optSec(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return 0;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return 0;
  return clampInt(n, 0, P.GAME.SETUP_SECONDS_MIN, P.GAME.SETUP_SECONDS_MAX) * 1000;
}

/**
 * ★ v14：回放倍速的**服务端默认值**（房主没在面板上挑时用它）。
 *
 * GAME_CHAIN_REPLAY_SPEED 压的是「默认档」，不是强制值 —— 与其它 GAME_CHAIN_* 同一个口径。
 * 只认协议里的三档，非法 / 没设 = P.GAME.CHAIN_REPLAY_SPEED_DEFAULT（1.5）。
 * 自动化测试用它起「1x 的慢服务端」和「2x 的快服务端」各跑一遍。
 */
function envReplaySpeed() {
  const v = process.env.GAME_CHAIN_REPLAY_SPEED;
  if (v === undefined || v === null || String(v).trim() === '') return P.GAME.CHAIN_REPLAY_SPEED_DEFAULT;
  const n = Number(String(v).trim());
  return P.GAME.CHAIN_REPLAY_SPEEDS.indexOf(n) >= 0 ? n : P.GAME.CHAIN_REPLAY_SPEED_DEFAULT;
}

const CFG = {
  INIT_MS: envMs('GAME_CHAIN_INIT_MS', P.GAME.CHAIN_INIT_MS),
  WRITE_MS: envMs('GAME_CHAIN_WRITE_MS', P.GAME.CHAIN_WRITE_MS),
  DRAW_MS: envMs('GAME_CHAIN_DRAW_MS', P.GAME.CHAIN_DRAW_MS),
  GUESS_MS: envMs('GAME_CHAIN_GUESS_MS', P.GAME.CHAIN_GUESS_MS),
  REVEAL_MS: envMs('GAME_CHAIN_REVEAL_MS', P.GAME.CHAIN_REVEAL_MS),
  VOTE_MS: envMs('GAME_CHAIN_VOTE_MS', P.GAME.CHAIN_VOTE_MS),
  SCORE_MS: envMs('GAME_CHAIN_SCORE_MS', P.GAME.CHAIN_SCORE_MS),
  // 按链串行时，每条链投票完先亮一下这条链的结果再放下一條 —— 比最终结算短得多
  CHAIN_SCORE_MS: envMs('GAME_CHAIN_CHAIN_SCORE_MS', P.GAME.CHAIN_CHAIN_SCORE_MS),
  // 收格宽限：客户端倒计时到点后自动提交的包还在路上，多等这一小会儿再收格。
  // **GAME_FAST 不压它**（理由见 envGraceMs）
  GRACE_MS: envGraceMs('GAME_CHAIN_GRACE_MS', P.GAME.CHAIN_GRACE_MS),
  // ★ v14 用户要求：整条链最后一棒放完 → 先**定格**这一小会儿，再在画布中央弹出投票纸片。
  //   3~5 秒里画面上只有最后一格，不弹任何面板（让人看清最后那张画）。
  VOTE_FREEZE_MS: envMs('GAME_CHAIN_VOTE_FREEZE_MS', 3500),
  // ★ v14：回放倍速的服务端默认档（房主没挑时用它；GAME_CHAIN_REPLAY_SPEED 压这个默认）
  REPLAY_SPEED: envReplaySpeed(),
  // ★ v15 回放节奏：起词 / 猜词格不再吃整份「每格预算」，各给短短一拍；
  //   作画格后面紧跟猜词格时，尾巴上再留一段悬念倒计时（先亮人、数完才揭词）。
  REVEAL_WORD_MS: envMs('GAME_CHAIN_REVEAL_WORD_MS', P.GAME.CHAIN_REVEAL_WORD_MS),
  REVEAL_GUESS_MS: envMs('GAME_CHAIN_REVEAL_GUESS_MS', P.GAME.CHAIN_REVEAL_GUESS_MS),
  REVEAL_TEASE_MS: envMs('GAME_CHAIN_REVEAL_TEASE_MS', P.GAME.CHAIN_REVEAL_TEASE_MS),
  // ★ v16：作画格的动画时长**按笔数**算（用户实测：四笔的小图也被摊成八秒）
  REVEAL_HOLD_MS: envMs('GAME_CHAIN_REVEAL_HOLD_MS', P.GAME.CHAIN_REVEAL_HOLD_MS),
  REVEAL_DRAW_BASE_MS: envMs('GAME_CHAIN_REVEAL_DRAW_BASE_MS', P.GAME.CHAIN_REVEAL_DRAW_BASE_MS),
  REVEAL_DRAW_PER_STROKE_MS: envMs('GAME_CHAIN_REVEAL_DRAW_PER_STROKE_MS', P.GAME.CHAIN_REVEAL_DRAW_PER_STROKE_MS),
  REVEAL_DRAW_MIN_MS: envMs('GAME_CHAIN_REVEAL_DRAW_MIN_MS', P.GAME.CHAIN_REVEAL_DRAW_MIN_MS),
  REVEAL_DRAW_MAX_MS: envMs('GAME_CHAIN_REVEAL_DRAW_MAX_MS', P.GAME.CHAIN_REVEAL_DRAW_MAX_MS)
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
    // v10：本局的阶段时长覆盖值（0 = 用全局默认 / 环境变量）。秒数在 start() 里夹成毫秒。
    this.writeMs = 0;          // 写初始词
    this.guessMs = 0;          // 猜词一步
    this.revealMs = 0;         // 回放阶段
    this.voteMs = 0;           // 投票阶段
    // ★ v14：回放倍速（每局设置，只允许 P.GAME.CHAIN_REPLAY_SPEEDS）。倍速越大 → 每格越短。
    this.replaySpeed = P.GAME.CHAIN_REPLAY_SPEED_DEFAULT;
    this.chainLength = 0;      // 每条链传几手（含初始词格）；开局时定死
    // ★ v17：接龙玩法（'classic' 猜完自己画 / 'relay' 传词接龙：猜完交给下家画）
    //   与传词玩法的「传几轮」（链长 = 1 + 轮数 × 组人数）。开局时定死，一局内不变。
    this.chainPlay = CHAIN_PLAY.CLASSIC;
    this.relayRounds = P.GAME.CHAIN_RELAY_ROUNDS_DEFAULT;

    this.ring = [];            // 传递顺序（开局时打乱一次，一局内固定）
    // ★ v12：分组。每组一个**独立的环**，链只在组内传（见 planGroups）。
    //   [{ id:'g1', index:0, ring:[userId...], members:[userId...], chainIds:[...], chainLength:2*size }]
    //   4~6 人房只有一组，ring 就是全场环 —— 与 v11 完全等价（回归靠这一点）。
    this.groups = [];
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
    // ★ v12：userId -> Map(chainId -> step) —— **每条链各投一次 ♥**。
    //   以前是 userId -> { chainId, step }，一人只有一票，投了下一条链就把上一条冲掉，
    //   「点赞最多的画」于是永远只数得到最后一条链的票。改成两层 Map 后跨链累积。
    this.votesFav = new Map();

    // 回放（REVEAL 起）
    this.revealData = null;    // 完整链条（内容公开）
    // ★ 回放的「棒次」由**服务端**持有并在快照里下发（v11）：
    //   前端不再自己按定时器逐格翻 —— 各端时钟一抖，四个人看到的就不是同一格。
    //   revealStep = 当前回放到第几格（0 起，全局一格一格推进，每格停 revealLegMs()）。
    this.revealStep = 0;
    // ★ v14：进投票后「定格」多久才在画布中央弹投票纸片（= CFG.VOTE_FREEZE_MS）。
    //   快照里下发 voteFreezeMs，前端按它推迟那张纸片 —— 各端同时弹、同时能点。
    this.voteFreezeMs = 0;
    // ⚠ 按链串行投票：现在轮到第几条链、已经结算了哪几条（见 settleChain）
    this.voteChainIndex = 0;
    this.chainSettled = [];
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

  /** 第 k 格（0 起）的类型。
   *
   *  0 = 写起词；奇数格 = **画**；偶数格（>0）= **猜**。
   *  这是「每人猜完立刻画自己猜出来的词，然后才传给下一个人」那一版：
   *    链长这样：起词 → 画1 → 猜1 → 画2 → 猜2 → 画3 → 猜3 → 画4 …
   *  与旧版的区别只在「第 2 格归谁」—— 见 authorOffset。
   */
  stepTypeOf(k) {
    if (k === 0) return STEP.WORD;
    if (k === 1) return STEP.DRAWING;
    return (k % 2 === 1) ? STEP.DRAWING : STEP.GUESS;
  }

  /** 第 k 格由「链主往后数第几个人」做 —— 每人连续两格（画自己拿到的、再猜下一格）。
   *
   *  floor(k / 2)：k = 0,1 → 0；k = 2,3 → 1；k = 4,5 → 2；k = 6,7 → 3 …
   *  即「链主先写起词并画它（第 0、1 格），传给下家；下家看画猜词并画自己猜的词
   *  （第 2、3 格），再往下传」—— 每人拿到一格立刻就画，画完才交棒。
   *
   *  ⚠ 链长默认 = **2 × 人数**（见 start()）就是为了让这套映射刚好整圈走完：
   *    4 人 [A,B,C,D]，链长 8 —— 这是用户点名的 8 步：
   *      k=0 起词 A   k=1 画 A   k=2 猜 B   k=3 画 B
   *      k=4 猜 C     k=5 画 C   k=6 猜 D   k=7 画 D
   *    作者偏移 = [0,0,1,1,2,2,3,3]，作者序列 = A,A,B,B,C,C,D,D；
   *    类型序列   = WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING。
   *    8 格正好把 4 个人各排到 2 格，于是「同一步里人人恰好一格」的一一映射成立
   *    （链长 = 2×人数，且偶数，所以每一格都是恰好 n 个 cell，不多不少）。
   *
   *  ⚠ 认领（cellOf）和收格（finalizeStep）**必须**共用这一份映射。
   *    以前两边各写一遍 `(ownerIdx + k) % n`，只要改一处漏一处，就会出现
   *    「我照 A 的链写词、服务端把词记到 B 的链上」这种鬼故事。
   *
   *  ★ v17：**传词接龙**（chainPlay = 'relay'）用另一套偏移（见 legOffsetIn）：
   *    每格换一个人 —— 起词 A → 画 A → 猜 B → 画 C → 猜 D → 画 A → …
   *    这里保留的是 classic（接龙模式）的偏移，测试与老调用方仍然认它。
   */
  authorOffset(k) { return Math.floor(k / 2); }

  /**
   * ★ v17：第 k 格在**某个组**里的环上偏移；返回 null = 这一格对这个组来说是「没有活」的空格。
   *
   * classic（接龙模式）：每人连续两格 —— 偏移 = floor(k/2)，超过组人数就没人有活了。
   * relay（传词接龙）：**每格换一个人** ——
   *   k = 0             → 0        （链主写起词，第 1 格也是他画自己的词）
   *   k ≥ 1             → (k-1) % size，且 k ≥ 1 + 轮数 × size 之后就没有活了。
   *   4 人 2 轮 → 偏移 = [0,0,1,2,3,0,1,2,3]，类型 = WORD,DRAW,G,DRAW,G,DRAW,G,DRAW,G
   *   （作者序列 A,A,B,C,D,A,B,C,D —— 与用户给的验收例子逐字一致）。
   *
   * ⚠ 认领（cellOf）与收格（finalizeStep）**必须**共用这一份映射：
   *   传词模式的偏移是取模的，不能再拿 `off >= size` 当「传完了」的判据 ——
   *   判据是**这一格的绝对编号**有没有超过这个组自己的链长（1 + 轮数 × 组人数）。
   */
  legOffsetIn(group, k) {
    const size = (group && group.members && group.members.length) || 0;
    if (!size) return null;
    if (this.chainPlay === CHAIN_PLAY.RELAY) {
      if (k === 0) return 0;
      if (k >= 1 + this.relayRounds * size) return null;   // 这个组传够了 → 空格
      return (k - 1) % size;
    }
    const off = Math.floor(k / 2);
    return off >= size ? null : off;
  }

  /** 这一组自己的链长（组内传遍）：classic = 2×人数；relay = 1 + 轮数 × 人数 */
  groupChainLen(size) {
    return this.chainPlay === CHAIN_PLAY.RELAY
      ? 1 + this.relayRounds * size
      : 2 * size;
  }

  /** 第 k 格的作者 userId（chain 是链主那条链）—— **在链主自己那一组里**数。
   *
   *  v12：链只在组内传。链主的组里，第 k 格的作者 = 组环上 (链主位置 + 这一格的偏移)；
   *  一旦这一格对本组来说是空的（legOffsetIn 返回 null），返回 '' ——
   *  那一格对这个组来说是「空」，由 finalizeStep 落一个 skipped 空壳，
   *  这样「每条链的 steps 长度统一 = chainLength」这条不变式不会被破坏。
   */
  authorOf(chain, k) {
    const g = this.groupOfChain(chain);
    if (!g || !g.ring.length) return '';
    const ownerIdx = g.ring.indexOf(chain.ownerPlayerId);
    if (ownerIdx < 0) return '';
    const off = this.legOffsetIn(g, k);
    if (off === null) return '';                   // 组内已经传完 → 空格
    return g.ring[(ownerIdx + off) % g.ring.length];
  }

  /** 这一条链归哪一组（链主所在组）；找不到就 null */
  groupOfChain(chain) {
    if (!chain) return null;
    if (chain.groupId) {
      const byId = this.groups.find(g => g.id === chain.groupId);
      if (byId) return byId;
    }
    for (const g of this.groups) if (g.ring.indexOf(chain.ownerPlayerId) >= 0) return g;
    return null;
  }

  /** 这个人在哪一组（看客 / 不在本局 → null） */
  groupOf(userId) {
    if (!userId) return null;
    for (const g of this.groups) if (g.members.indexOf(userId) >= 0) return g;
    return null;
  }

  /** 全场最大的组多大 —— 统一链长 = 2 × 它（见 start()） */
  maxGroupSize() {
    let m = 0;
    for (const g of this.groups) if (g.members.length > m) m = g.members.length;
    return m;
  }

  /** 各组链长表（组内传遍）—— 快照下发，前端要知道每个组跑几格 */
  groupLengths() {
    const out = {};
    for (const g of this.groups) out[g.id] = this.groupChainLen(g.members.length);
    return out;
  }

  /** 第 k 格里**有活干的人**（组内偏移还没走完的人）。
   *  组里已经传完的成员在剩下的格子里就是空的 —— 不派活、不提交、也不摊空格。 */
  activeUsers(k) {
    const out = new Set();
    if (!this.groups.length) { for (const uid of this.ring) out.add(uid); return out; }
    for (const g of this.groups) {
      if (this.legOffsetIn(g, k) === null) continue;
      for (const uid of g.members) out.add(uid);
    }
    return out;
  }

  /** 我在第 k 格里负责的那条链 —— 只在我自己那一组的环里找 */
  myCellChainId(userId, k) {
    const g = this.groupOf(userId);
    if (!g || !g.ring.length) return null;
    const myIdx = g.ring.indexOf(userId);
    if (myIdx < 0) return null;
    const off = this.legOffsetIn(g, k);
    if (off === null) return null;                 // 组内传完了 → 这一格没我的事
    const ownerIdx = ((myIdx - off) % g.ring.length + g.ring.length) % g.ring.length;
    return g.chainIds[ownerIdx] || null;
  }

  /**
   * 第 k 格该谁做：在**玩家自己那一组**的环上，从链主往后数 authorOffset(k) 个人。
   *
   * ⚠ 4~6 人房只有一组，ring 就是全场环 —— 与 v11 的 (myIdx - off) mod n 完全等价。
   *   分组之后「某组的玩家不可能拿到别组的 cell」这条靠的就是这里只查本组。
   */
  cellOf(userId, k) {
    const cid = this.myCellChainId(userId, k);
    if (!cid) return null;
    return this.chains.find(c => c.chainId === cid) || null;
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
   * 备注：v11 那版「在全局环上算第 k 格」的 cellOf 已被上面的版本取代 ——
   * 分组之后一律在**我那一组**的环里算（见 myCellChainId）。组内链长 = 2 × 该组人数时，
   * 每一格都是组内恰好 size 个 cell 的一一映射，同一格绝不会被派两次、也不会有人没活干。
   */

  blocksWrite(userId) { return this.lockedFor(userId); }

  /**
   * 这条链是哪一组的（快照 / 测试用的小工具）：返回 { id, index, size, ring, chainIds }
   * 的精简视图；没有分组信息时回 null。
   */
  groupInfo(chainId) {
    const c = this.chains.find(x => x.chainId === chainId);
    const g = c ? this.groupOfChain(c) : null;
    if (!g) return null;
    return { id: g.id, index: g.index, size: g.members.length, ring: g.ring.slice(), chainIds: g.chainIds.slice() };
  }

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

  /** 这一步的时长（客户端只拿来显示倒计时）。
   *  房主在开局设置里定的每局覆盖值优先，否则用环境变量 / 协议默认。
   *
   *  ⚠ REVEAL 这一格特殊（v11）：这里返回的是**整条链放完的总时长**（房主配的「回放时间」），
   *    而 phase 的 deadline 是**每一格**的（= revealLegMs()，见 enterReveal / tick）。
   *    前端排回放动画应该用快照里的 legHoldMs / revealLegs，别拿 stepMs 当每格时长。 */
  stepMs() {
    if (this.phase === CHAIN_PHASE.INIT) return CFG.INIT_MS;
    if (this.phase === CHAIN_PHASE.WRITE) return this.writeMs || CFG.WRITE_MS;
    if (this.phase === CHAIN_PHASE.DRAW) return this.drawMs || CFG.DRAW_MS;
    if (this.phase === CHAIN_PHASE.GUESS) return this.guessMs || CFG.GUESS_MS;
    if (this.phase === CHAIN_PHASE.REVEAL) return this.revealMs || CFG.REVEAL_MS;
    if (this.phase === CHAIN_PHASE.VOTE) return this.voteMs || CFG.VOTE_MS;
    if (this.phase === CHAIN_PHASE.SCORE) {
      // 还有链没放 = 这是「一条链的小结算」，用短时长
      return (this.voteChainIndex < this.chains.length) ? CFG.CHAIN_SCORE_MS : CFG.SCORE_MS;
    }
    return 0;
  }

  /**
   * 回放时**每一格**定格多久（服务端说了算，快照里下发给前端排动画用）。
   *
   * 房主配的「回放时间」（revealSeconds）指的是**整条链放完**的总时长，
   * 所以每格 = 总时长 / 格数，再兜一个 1500ms 的地板 ——
   * 格数最多 32（16 人房），总时长最短 3 秒，不兜底就会「每格 90ms」闪成一片。
   *
   * 这就是用户说的「倍速处理」的服务端侧：倍速 = 总时长 / 格数，由服务端算好，
   * 客户端只管拿 legHoldMs 排动画，不用自己推。
   *
   * ★ v14：房主还能在开局面板挑「回放倍速」（1 / 1.5 / 2，默认 1.5）——
   *   倍速越大 → 每格越短（这里直接除以它）。前端不再有倍速 / 翻格 / 播放控件。
   *
   * ★ v15：**按格类型分别给时长**（用户实测：起词格 / 猜词格干等太久）。
   *   起词格只有一行词、猜词格只揭晓一个词 —— 各给 CFG.REVEAL_WORD_MS / GUESS_MS；
   *   作画格才吃「总时长 / 格数 / 倍速」那份预算（兜 1500ms 地板），
   *   若它的下一格是猜词格，再在尾巴上加一段 CFG.REVEAL_TEASE_MS 的悬念倒计时
   *   （前端在这段时间里显示「下一棒 X 猜的是：」+ 3 → 2 → 1，数完那一格才开始放）。
   *
   * ★ v16：作画格的时长**改成按这一格的笔数算**（不再拿「回放总时长 × 比例」摊）——
   *   用户实测报「笔迹回放时间太长了」，而正确的语义是「按倍速把笔迹播完，播完即定稿」。
   *   公式见 P.chainRevealAnimMs：起步 + 每笔固定时长，夹上下限，再除以倍速；
   *   后面再按需要加悬念尾（下一格是猜词）或一小段定格（否则）。
   */
  legMsAt(k, chain) {
    const idx = Math.max(0, Math.floor(Number(k) || 0));
    const type = this.stepTypeOf(idx);
    const c = chain || this.currentVoteChain() || this.chains[0] || null;
    const steps = (c && c.steps) || null;
    const n = Math.max(1, (steps && steps.length) || this.chainLength || 1);
    // ★ v14 起的「回放倍速」（1 / 1.5 / 2，start() 里已夹取）——作画格的动画直接除以它
    const speed = this.replaySpeed > 0 ? this.replaySpeed : 1;
    if (type === STEP.WORD) return Math.max(600, CFG.REVEAL_WORD_MS);
    if (type === STEP.GUESS) return Math.max(600, CFG.REVEAL_GUESS_MS);
    const step = steps ? steps[idx] : null;
    const strokes = (step && Array.isArray(step.content)) ? step.content.length : 0;
    let ms = Math.max(CFG.REVEAL_DRAW_MIN_MS,
      Math.min(CFG.REVEAL_DRAW_MAX_MS,
        Math.round((CFG.REVEAL_DRAW_BASE_MS + strokes * CFG.REVEAL_DRAW_PER_STROKE_MS) / speed)));
    const nextIsGuess = (idx + 1) < n && this.stepTypeOf(idx + 1) === STEP.GUESS;
    ms += nextIsGuess ? Math.max(0, CFG.REVEAL_TEASE_MS) : Math.max(0, CFG.REVEAL_HOLD_MS);
    return ms;
  }

  /** 这一格（默认 = 现在放到的这一格）要停多久。chain 不给就取现在这条链。 */
  revealLegMs(k, chain) {
    return this.legMsAt(typeof k === 'number' && isFinite(k) ? k : this.revealStep, chain);
  }

  /** 某条链**每一格**的时长表 —— 随快照下发，前端按它排动画 / 悬念倒计时。
   *  ⚠ 用这条链**自己**的格数（分组时各组链长可能不同），别用 this.chainLength。 */
  legMsOf(c) {
    const n = (c && c.steps && c.steps.length) ? c.steps.length : Math.max(1, this.chainLength);
    const out = [];
    for (let k = 0; k < n; k++) out.push(this.legMsAt(k, c));
    return out;
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
    const keepMap = this.votesKeep.get(me);
    const myKeep = {};
    if (keepMap) for (const [cid, agree] of keepMap) myKeep[cid] = !!agree;
    // 按链串行：现在投票/回放的是哪一条（REVEAL 与 VOTE 之外为 null）
    const cur = (this.phase === CHAIN_PHASE.REVEAL || this.phase === CHAIN_PHASE.VOTE)
      ? this.currentVoteChain() : null;
    const tally = this.chainVoteTally(cur ? cur.chainId : null);
    // ★ v12：我的 ♥ 是**按链**记的 —— 快照要能回答「我在现在这条链上投过没有」，
    //   所以带出 myFav（当前这条链的）+ myFavStep 一并给出，前端不用自己猜是哪个字段。
    const favHere = this.myFav(me, cur ? cur.chainId : null);
    const myGroup = this.groupOf(me);
    const myGroupSize = myGroup ? myGroup.members.length : 0;
    // 有活干的人数（组里已经走完一圈的成员不算）—— 进度显示用
    const activeNow = this.activeUsers(this.stepIndex);
    let stepDone = 0;
    for (const uid of this.submitted) if (activeNow.has(uid)) stepDone += 1;

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
      // 传递顺序（打乱过、一局内冻结）。**不是秘密**：它只是「谁接着谁」，
      // 前端回放时要按这个顺序把 A→B→C→D 标出来；测试也拿它验作者序列。
      // 内容（词 / 笔迹）一个字节都不在这里。
      // v12：多组时这里是**各组环首尾相接**的扁平表（兼容老的消费者）；
      //      真正的分组看 groups / myGroup 两个字段。
      ring: this.ring.slice(),
      // ★ v12 分组：每组一个环、链只在组内传。members 带名字，chainIds 是该组的链
      //   （顺序 = 该组 ring 的顺序）；chainLength = 2 × 该组人数（组内传遍）。
      //   这是纯骨架信息（谁和谁一组、哪几条链），一个字的词 / 一笔画都没有。
      groups: this.groups.map(g => ({
        id: g.id,
        index: g.index,
        size: g.members.length,
        chainLength: 2 * g.members.length,
        ring: g.ring.slice(),
        members: g.members.map(uid => ({ userId: uid, name: this.names.get(uid) || '某人' })),
        chainIds: g.chainIds.slice()
      })),
      groupCount: this.groups.length,
      myGroup: myGroup ? myGroup.id : '',
      myGroupIndex: myGroup ? myGroup.index : -1,
      groupSize: myGroupSize,
      groupLengths: this.groupLengths(),
      maxGroupSize: this.maxGroupSize(),
      // ---- 回放棒次（服务端权威）----
      // revealStep：整条链现在放到第几格（0 起）。REVEAL 期间每 revealLegMs() 加一；
      //   VOTE 期间钉在最后一格（chainLength - 1）—— 投票时要看最终画面；
      //   非回放/投票阶段暴露的是上一次的值（前端只在 REVEAL/VOTE 用它）。
      // revealLegs：总格数 = chainLength，前端拿它排进度点 / 算总时长。
      // legHoldMs ：每格定格时长（= revealLegMs()），前端按它排翻页动画。
      revealStep: this.revealStep,
      revealLegs: this.chainLength,
      legHoldMs: this.revealLegMs(),
      // ★ v15：当前这条链**每一格**的时长表（起词 / 猜词格短、作画格长 + 悬念尾）。
      //   前端按它排「逐笔动画 + 3 秒倒计时」，换链 / 换局都会跟着变。
      legMs: this.legMsOf(cur),
      // 进度骨架：第几格、这一格全场**同时**有几件事、交了几件 —— 不含任何内容。
      // v12：多组并行时同时进行的是「每个组各一条链」，所以 stepTotal = 最大的组多大
      // （4 人 1 组 = 4，8 人 2 组 × 4 = 4，不是 8 —— 同一步里不会出现 8 条链）。
      // ★ v17：接龙玩法随快照下发（前端要显示「接龙 / 传词接龙」与传几轮）。
      chainPlay: this.chainPlay,
      relayRounds: this.relayRounds,
      stepIndex: this.isPlaying() || this.phase === CHAIN_PHASE.INIT ? this.stepIndex : 0,
      stepTotal: this.maxGroupSize() || this.chains.length,
      stepDone: stepDone,

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
      // ★ v12：myFav 是**当前这条链**上我投的那一格（{ chainId, step }），没投 = null；
      //   myFavStep 是同一件事的裸值（前端画 ♥ 时少解一层）。
      //   favVotedCount 是**我自己**投过 ♥ 的条数（不再是全场人数之和）——
      //   一人一条链一票，那个数字拿来当进度条会随链数膨胀。
      myFav: favHere,
      myFavStep: favHere ? favHere.step : -1,
      myFavMap: this.myFavMap(me),
      favVotedCount: this.myFavCount(me),

      // 结算只在 SCORE 阶段下发
      voteResult: this.phase === CHAIN_PHASE.SCORE ? this.voteResult : null,

      // ---- 按链串行投票：全场跟着服务端看同一条链 ----
      // 前端只渲染 voteChainId 这一条；已投人数 / 总人数直接给出来，
      // 免得每个客户端各自去数（数法一不一致就会「我这儿显示 2/4、你那儿 3/4」）。
      // v12：总人数 = **这条链那一组**的人数（跨组投票不参与统计，见 chainVoteTally）。
      voteChainIndex: this.voteChainIndex,
      voteChainId: cur ? cur.chainId : '',
      voteGroupId: cur ? (this.groupOfChain(cur) || {}).id || '' : '',
      voteTotal: tally.total,
      voteDone: tally.voted,
      voteAgree: tally.agree,
      // ★ v14：谁投了哪边（画布下方那排 √ / × 小标记）。只列**已投**的人。
      voteMarks: this.chainVoteMarks(cur ? cur.chainId : null),
      // ★ v14：进投票后先定格这么久再弹投票纸片（毫秒）。非投票阶段为 0。
      voteFreezeMs: this.phase === CHAIN_PHASE.VOTE ? CFG.VOTE_FREEZE_MS : 0,
      chainCount: this.chains.length,
      settled: (this.chainSettled || []).map(r => ({
        chainId: r.chainId, ownerName: r.ownerName, firstWord: r.firstWord,
        lastWord: r.lastWord, agree: r.agree, against: r.against, won: r.won
      })),

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
    // v10：本局的各项阶段时长（写词 / 猜词 / 回放 / 投票）。0 / 缺省 = 用默认，
    // 否则夹到 [SETUP_SECONDS_MIN, SETUP_SECONDS_MAX]。作画时长沿用上面的 drawSeconds（下限仍是 30 秒）。
    this.writeMs = optSec(opts && opts.writeSeconds);
    this.guessMs = optSec(opts && opts.guessSeconds);
    this.revealMs = optSec(opts && opts.revealSeconds);
    this.voteMs = optSec(opts && opts.voteSeconds);
    // ★ v14：回放倍速 —— 只收 [1, 1.5, 2]，其余（含缺省 / 非法 / 0）一律回**服务端默认档**
    //   （CFG.REPLAY_SPEED = 1.5，可被 GAME_CHAIN_REPLAY_SPEED 压）。与秒数字段的
    //   「0 = 用默认」一样：0 不是合法倍速，不会被夹成下限 1。
    this.replaySpeed = P.GAME.CHAIN_REPLAY_SPEEDS.indexOf(Number(opts && opts.replaySpeed)) >= 0
      ? Number(opts.replaySpeed) : CFG.REPLAY_SPEED;
    // 链长：默认 = **2 × 该组人数**（组内传遍）。每人占连续两格（画自己拿到的 + 猜下一格），
    // 所以组内整圈走完正好 2×组人数 格 —— 4 人房就是用户点名的 8 步：
    //   k=0 起词A k=1 画A k=2 猜B k=3 画B k=4 猜C k=5 画C k=6 猜D k=7 画D
    // ★ v12：分组之后用**统一链长 = 2 × 最大的组**（用户倾向的简单口径）：
    //   各组的「有效格数」仍然是各自的 2×组人数（组内传遍），人少的组走到自己的圈尾就没人有活，
    //   尾巴上多出来的格子由 finalizeStep 落成 skipped 的空壳（steps 长度统一 = chainLength，
    //   回放 / 投票 / 结算都不用为「这条链只有 6 格」再分支）。
    //   16 人 → 4×4 组，链长 8；13 人 → 4/3/3/3，链长 8（3 人组第 7、8 格空）；
    //   10 人 → 5/5，链长 10；7 人 → 4/3，链长 8。4~6 人 1 组时与 v11 完全一致。
    // 夹在 [3, 2 × min(最大的组, CHAIN_LENGTH_MAX)] 里（CHAIN_LENGTH_MAX=16 → 组内最多 32 格）。
    // ★ v17：接龙玩法（classic / relay）+ 传词玩法的「传几轮」。
    //   ⚠ relay 下**不用面板上的 chainLength**：链长由轮数决定（1 + 轮数 × 组人数），
    //     这样「传遍全场 N 轮」这条规则不会被一个越界的链长数值破坏。
    this.chainPlay = (P.GAME.CHAIN_PLAYS.indexOf(opts && opts.chainPlay) >= 0)
      ? opts.chainPlay : P.GAME.CHAIN_PLAY_DEFAULT;
    // 轮数与其它数值字段同一个口径：**0 / 缺省 / 非法 = 用默认**（不能把 0 夹成下限 1），
    // 正数才夹到 [1, 4]。
    const rr = Math.floor(Number(opts && opts.relayRounds));
    this.relayRounds = (isFinite(rr) && rr > 0)
      ? clampInt(rr, P.GAME.CHAIN_RELAY_ROUNDS_DEFAULT,
        P.GAME.CHAIN_RELAY_ROUNDS_MIN, P.GAME.CHAIN_RELAY_ROUNDS_MAX)
      : P.GAME.CHAIN_RELAY_ROUNDS_DEFAULT;
    const maxGroup = Math.max(1, ...groupSizesFor(players.length));
    // 链长：classic = **2 × 该组人数**（组内传遍，每人连续两格）；relay = 1 + 轮数 × 组人数。
    // 统一取**最大的组**那份（人少的组在自己的圈尾之后由 finalizeStep 落 skipped 空壳）。
    const maxLen = this.groupChainLen(Math.min(maxGroup, P.GAME.CHAIN_LENGTH_MAX));
    const wantLen = Math.floor(Number(opts && opts.chainLength)) || this.groupChainLen(maxGroup);
    this.chainLength = this.chainPlay === CHAIN_PLAY.RELAY
      ? this.groupChainLen(maxGroup)                 // relay：链长 = 1 + 轮数 × 最大的组
      : clampInt(wantLen, 2 * maxGroup,
        P.GAME.CHAIN_LENGTH_MIN, Math.max(P.GAME.CHAIN_LENGTH_MIN, maxLen));

    this.chains = [];
    this.ring = [];
    this.groups = [];
    this.stepIndex = 0;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.revealData = null;
    this.revealStep = 0;              // 回放棒次指针也归零（新一局从第 0 格放）
    this.voteResult = null;
    this.voteChainIndex = 0;          // 按链串行投票：从第一条链开始
    this.chainSettled = [];
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
    // 链长跟着这一局的实际人数再夹一次（有人刚离开时设置值可能越界）。
    // ★ v17：relay 下链长恒等于「1 + 轮数 × 最大的组」（不看房主设的 chainLength）。
    const maxGroup = Math.max(1, ...groupSizesFor(players.length));
    this.chainLength = this.chainPlay === CHAIN_PLAY.RELAY
      ? this.groupChainLen(maxGroup)
      : clampInt(this.chainLength || (2 * maxGroup), 2 * maxGroup,
        P.GAME.CHAIN_LENGTH_MIN,
        Math.max(P.GAME.CHAIN_LENGTH_MIN, 2 * Math.min(maxGroup, P.GAME.CHAIN_LENGTH_MAX)));

    this.spectators.clear();          // 开新局：房间里的人都算玩家
    this.roundNo += 1;
    players.forEach(p => this.names.set(p.userId, p.name));
    players.forEach(p => { if (!this.scores.has(p.userId)) this.scores.set(p.userId, 0); });

    // ★ v12：分组 —— 按人数表均分，每组一个**独立打乱**的环。
    //   链的编号仍然是全局连续的 'c1'…'cN'（投票是全局串行的，编号连续最好读）；
    //   组内的 chainIds 数组 = 该组环序上每个成员的链，cellOf 只在这个数组里找。
    //   this.ring = 各组环首尾相接的扁平表（兼容老消费者 + 断言用）。
    this.planGroups(players);

    this.revealData = null;
    this.revealStep = 0;              // 回放棒次指针归零
    this.voteResult = null;
    this.voteChainIndex = 0;          // 按链串行投票：从第一条链开始
    this.chainSettled = [];
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
      + '每条传 ' + this.chainLength + ' 手 · '
      + (this.chainPlay === CHAIN_PLAY.RELAY
        ? '玩法：传词接龙（传 ' + this.relayRounds + ' 轮）· ' : '玩法：接龙 · ')
      + '主题：'
      + ((THEMES.THEMES[this.theme] && THEMES.THEMES[this.theme].name) || '通用'));
    return true;
  }

  /* ------------------------------------------------------------ 分组 */

  /**
   * ★ v12：把这一局的玩家分成若干组，每组一个**独立打乱的环**，并给每人开一条链。
   *
   * 算法（与用户给的分组表一致，见 groupSizesFor）：
   *   1. players 按 playerList() 的顺序（房间成员顺序）取 userId；
   *   2. 按人数表算出每组几人：从前到后**尽量均分**、余数摊给前面的组
   *      （16 → 4/4/4/4；13 → 4/3/3/3；10 → 5/5；7 → 4/3）；
   *   3. **每组各自 shuffle** 出组内环（不同组之间没有任何关系）；
   *   4. 每人一条链（链主 = 他自己），chainId 全局连续编号；组内 chainIds 按组环顺序排。
   *
   * 组内传遍 = 链长 2 × 该组人数：8 人 2 组时链长是 8 而不是 16（墙体时长只跟组大小走）。
   * this.ring 仍然维护成各组环首尾相接的扁平表 —— 4~6 人 1 组时它就等于原来的全局环。
   */
  planGroups(players) {
    const ids = shuffle(players.map(p => p.userId));
    const sizes = groupSizesFor(ids.length);
    const groups = [];
    let cursor = 0;
    for (let i = 0; i < sizes.length; i++) {
      const members = ids.slice(cursor, cursor + sizes[i]);
      cursor += sizes[i];
      groups.push({
        id: 'g' + (i + 1),
        index: i,
        members: members,
        ring: shuffle(members),         // 组内环：只在组内传（洗一次就够）
        chainIds: [],
        chainLength: this.groupChainLen(members.length)  // 这个组的实际格数（组内传遍）
      });
    }
    // 每人一条链；链编号全局连续，组内 chainIds 跟着组环顺序走
    const chains = [];
    let n = 0;
    for (const g of groups) {
      for (const uid of g.ring) {
        n += 1;
        const cid = 'c' + n;
        chains.push({
          chainId: cid,
          groupId: g.id,
          ownerPlayerId: uid,
          ownerName: this.names.get(uid) || '某人',
          currentStep: 0,
          steps: [],
          status: 'active'
        });
        g.chainIds.push(cid);
      }
    }
    this.groups = groups;
    this.chains = chains;
    this.ring = groups.reduce((acc, g) => acc.concat(g.ring), []);
    return this.groups;
  }

  /* ------------------------------------------------------------ 格与阶段推进 */

  /** 第 k 格的「交给」= 下一格（k+1）的作者；k 已是最后一格时回 '' */
  nextAuthorOf(chain, k) {
    if (k + 1 >= this.chainLength) return '';
    return this.authorOf(chain, k + 1);
  }

  /** 日志里显示成「名字(id)」 —— 名字可能缺（人走了榜单还留着 id） */
  whoLabel(userId) {
    if (!userId) return '(无)';
    return (this.names.get(userId) || '某人') + '(' + userId + ')';
  }

  /**
   * ★ 链条完整性自检 —— 每推进一棒都跑一次（用户明确要求「加链条不断的断言」）。
   *
   * ★ v12 改成**按组**断言：
   *   ① **组内人人各有一格**：每组里，这一格还有活的人（组内偏移 < 组人数）必须每人拿到
   *      一条链，而且组内 size 个人拿到的是 size 条**不同**的链（不能有 null、不能重复）。
   *      有重复 = 两个人的产物会写进同一条链；有 null = 有人这一棒没活干。
   *   ② **作者落在本组的环里**：每条第 k 格的作者（还在组内圈里时）必须是**这一组**的人。
   *   ③ 链的主人必须在他自己那一组的环上（链不能挂到别组去）。
   *
   * 返回 { ok, k, problems: [] }；不抛异常 —— 调用方**打完日志照样强制推进**，
   * 绝不停在原地（停住等于整局死在这里，比传错更糟）。
   */
  assertChainIntact(k) {
    const problems = [];
    const n = this.ring.length;
    if (!n || !this.chains.length) return { ok: true, k, problems };
    if (!this.groups.length) {              // 没有分组信息（老快照 / 单测造的壳）→ 只查最小不变式
      const owners = new Set(this.chains.map(c => c.ownerPlayerId));
      const lack = this.ring.filter(uid => !owners.has(uid));
      if (lack.length) problems.push('环上 ' + lack.length + ' 人没有链：' + lack.join(','));
      return { ok: problems.length === 0, k, problems };
    }
    for (const g of this.groups) {
      const size = g.members.length;
      const active = this.legOffsetIn(g, k) !== null;   // 这个组在这一格还有活吗
      // ③ 链主必须在**本组**环上
      for (const cid of g.chainIds) {
        const c = this.chains.find(x => x.chainId === cid);
        if (!c) { problems.push('组 ' + g.id + ' 的链 ' + cid + ' 不见了'); continue; }
        if (g.ring.indexOf(c.ownerPlayerId) < 0) {
          problems.push('链 ' + cid + ' 的主人不在组 ' + g.id + ' 的环里');
        }
      }
      // ① 组内人人各有一格（只在「这一格这个组还有活」时要求）
      if (active) {
        const seen = new Set();
        for (const uid of g.ring) {
          const cell = this.cellOf(uid, k);
          if (!cell) { problems.push('组 ' + g.id + ' 第 ' + (k + 1) + ' 格 ' + uid + ' 没有链（链条断裂）'); continue; }
          if (g.chainIds.indexOf(cell.chainId) < 0) {
            problems.push('组 ' + g.id + ' 第 ' + (k + 1) + ' 格拿到了别组的链 ' + cell.chainId);
            continue;
          }
          if (seen.has(cell.chainId)) {
            problems.push('组 ' + g.id + ' 第 ' + (k + 1) + ' 格链 ' + cell.chainId + ' 被派给了多个人');
            continue;
          }
          seen.add(cell.chainId);
        }
        if (seen.size !== size) {
          problems.push('组 ' + g.id + ' 第 ' + (k + 1) + ' 格只覆盖了 ' + seen.size + '/' + size + ' 条链');
        }
        // ② 作者必须是本组的人
        for (const cid of g.chainIds) {
          const c = this.chains.find(x => x.chainId === cid);
          if (!c) continue;
          const who = this.authorOf(c, k);
          if (!who || g.ring.indexOf(who) < 0) {
            problems.push('链 ' + cid + '（组 ' + g.id + '）第 ' + (k + 1) + ' 格的作者不在本组环里（' + (who || '空') + '）');
          }
        }
      }
    }
    return { ok: problems.length === 0, k, problems };
  }

  /** 自检没过的兜底修复：按**各组环**重排链条表（chainId 与组内 chainIds 一起重新编号），
   *  让它重新满足「一人一链、链主人人不同、链只挂在自己组里」。
   *
   *  ⚠ 必须重编号：旧的 chainId 是按**上一次的顺序**发的，
   *    只按主人复用旧对象的话，「组内 chainIds[i] ↔ 组环[i]」这条约定就断了，
   *    cellOf 会把两条链算成同一条（本文件的自检就是抓这个的）。
   *  正常路径下**永远走不到**这里 —— 它的存在只是保证「就算断了也不会把整局卡死」。 */
  repairChains() {
    if (!this.groups.length) {              // 没分组信息：退回 v11 的全局环重建
      const byOwner = new Map(this.chains.map(c => [c.ownerPlayerId, c]));
      this.chains = this.ring.map((uid, i) => {
        const old = byOwner.get(uid);
        if (old) { old.chainId = 'c' + (i + 1); return old; }
        return {
          chainId: 'c' + (i + 1), ownerPlayerId: uid, ownerName: this.names.get(uid) || '某人',
          currentStep: 0, steps: [], status: 'active'
        };
      });
      return;
    }
    const byOwner = new Map(this.chains.map(c => [c.ownerPlayerId, c]));
    const out = [];
    let n = 0;
    for (const g of this.groups) {
      g.chainIds = [];
      for (const uid of g.ring) {
        n += 1;
        const cid = 'c' + n;
        const old = byOwner.get(uid);
        const c = old || {
          ownerPlayerId: uid, ownerName: this.names.get(uid) || '某人',
          currentStep: 0, steps: [], status: 'active'
        };
        c.chainId = cid;
        c.groupId = g.id;
        out.push(c);
        g.chainIds.push(cid);
      }
    }
    this.chains = out;
    this.ring = this.groups.reduce((acc, g) => acc.concat(g.ring), []);
  }

  /**
   * ★ 自检 + 兜底 + 播报。返回 true 表示**链条断了但已经强制推进**。
   *
   * 用户要求：「任何一条不满足：打日志 + 强制推进，绝不停在原地，
   * 并在系统聊天里播一条『检测到传递异常，已强制推进』」。
   */
  checkChainOrForce(k) {
    const r = this.assertChainIntact(k);
    if (r.ok) return false;
    console.error('[chain] 链条断裂 · 第 ' + (k + 1) + '/' + this.chainLength + ' 格 · '
      + r.problems.join(' | '));
    this.repairChains();
    this.api.systemChat('检测到传递异常，已强制推进（第 ' + (k + 1) + ' 格）');
    return true;
  }

  /** 进入「第 k 格」：全场的格型一致（0=写词，奇数=作画，偶数=猜词） */
  enterStep(k) {
    this.stepIndex = k;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();

    // ★ 进格之前先自检：断了就打日志 + 修复 + 播报，然后**照样往下走**。
    this.checkChainOrForce(k);

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
    this.logStep();
    this.announceStep();
  }

  /**
   * ★ 每一棒的日志（用户要的）——只在 enterStep() 里打一次，绝不在 tick 里刷屏。
   *
   * 1 组（4~6 人）时的形状与 v11 一字不差（回归靠它）：
   *   [chain] 第 3/8 格 · 阶段=DRAWING · 作者=乙(u2) · 交给=丙(u3) · 链数=4
   * ★ v12 多组时在末尾追加**每一组各自**的这一棒（用户点名要的形状）：
   *   [chain] 第 3/8 格 · 阶段=DRAWING · 作者=乙(u2) · 交给=丙(u3) · 链数=8 · 组1: 作者=乙(u2)→交给=丙(u3) · 组2: 作者=己(u6)→交给=庚(u7)
   *   组里已经走完一圈的成员在这一格没活：那一组显示「(本组已完成)」。
   */
  logStep() {
    const k = this.stepIndex;
    const c0 = this.chains[0];
    const who = c0 ? this.authorOf(c0, k) : '';
    const nxt = c0 ? this.nextAuthorOf(c0, k) : '';
    let line = '[chain] 第 ' + (k + 1) + '/' + this.chainLength + ' 格 · 阶段='
      + this.stepTypeOf(k) + ' · 作者=' + this.whoLabel(who)
      + ' · 交给=' + (nxt ? this.whoLabel(nxt) : '(回放)')
      + ' · 链数=' + this.chains.length;
    if (this.groups.length > 1) {
      for (const g of this.groups) {
        // 每组取这一组的链里「现在轮到的」那一条（组环第一位的链主就是这一格的作者，
        // 与 authorOf 的偏移一一对应；组内走完一圈后 authorOf 回 ''）
        const first = this.chains.find(c => c.groupId === g.id);
        const gw = first ? this.authorOf(first, k) : '';
        if (!gw) { line += ' · 组' + (g.index + 1) + ': (本组已完成)'; continue; }
        const gn = this.nextAuthorOf(first, k);
        line += ' · 组' + (g.index + 1) + ': 作者=' + this.whoLabel(gw)
          + '→交给=' + (gn ? this.whoLabel(gn) : '(回放)');
      }
    }
    console.log(line);
  }

  announceStep() {
    const label = CHAIN_PHASE_LABEL[this.phase] || '';
    const secs = Math.round(this.stepMs() / 1000);
    // v12：同一步里同时进行的是「每个组各一条链」—— 并行人数 = 最大的组多大
    const n = this.maxGroupSize() || this.chains.length;
    const type = this.stepTypeOf(this.stepIndex);
    const what = type === STEP.WORD ? '写初始词' : type === STEP.DRAWING ? '照词作画' : '看画猜词';
    const gs = this.groups.length > 1 ? ('（' + this.groups.length + ' 组并行）') : '';
    this.api.systemChat('第 ' + (this.stepIndex + 1) + ' / ' + this.chainLength
      + ' 手 · ' + what + '（' + n + ' 人并行' + gs + '，' + secs + ' 秒）—— ' + label);
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
    // 全场交齐 → 立刻收格（不等 deadline）。
    // ★ v12：只等**这一格有活的人**（组内已经走完一圈的成员在这一格没活，
    //   他们不提交也不该把收格卡住）。
    if (this.submitted.size >= this.activeUsers(this.stepIndex).size) this.finalizeStep();
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
      const who = this.authorOf(chain, k);
      // ★ v12：人少的组在统一链长的尾巴上没有活（authorOf 回 '')——那一格落一个
      //   skipped 的空壳，保持「每条链 steps.length 都等于 chainLength」这条不变式，
      //   回放 / 投票 / 结算就不必为「这条链只有 6 格」再分支。
      if (!who) {
        chain.steps[k] = {
          playerId: '', type: type, content: (type === STEP.DRAWING) ? [] : '',
          auto: false, timestamp: now, skipped: true
        };
        chain.currentStep = k + 1;
        continue;
      }
      const did = this.submitted.has(who);
      let content;
      let auto = false;
      if (type === STEP.DRAWING) content = did ? this.captureStrokes(who) : [];
      else content = this.pendingText.get(who) || '';
      // ★ 起词**绝不允许为空**。用户明确要求：倒计时结束时如果这个人没交，
      //   就在他这一格拿到的 3 个候选词里随机挑一个补上 —— 不能写空。
      //   空起词会让下一棒拿不到题目（题面 word:''，界面显示「(空)」），
      //   整条链从第一步就废了。补词用的是**他自己那三个候选**，
      //   所以仍是「这一格该出现的东西」，不是凭空造的。
      if (type === STEP.WORD && !content) {
        const picks = this.stepChoices.get(who) || [];
        if (picks.length) {
          content = picks[Math.floor(Math.random() * picks.length)];
          auto = true;
          this.api.systemChat('「' + (this.names.get(who) || '某人') + '」没写，'
            + '替他随机抽了一个：「' + content + '」');
        }
      }
      // 「这一手没交成」= 没交，**或者交了但是空的** ——
      // 离场者会被 onLeave 标记成「已交」以放行收格，但内容是空的；
      // 画手点了交却一笔没画同理。回放与首尾判定都把空格当「没交」看。
      // 注意 auto 的格子 content 是**非空**的（系统补的），所以 skipped=false：
      // 它内容有效，只是不是本人写的 —— 这一点由 auto 单独标出来给回放界面看。
      const empty = (type === STEP.DRAWING) ? !content.length : !content;
      chain.steps[k] = {
        playerId: who,
        type: type,
        content: content,
        auto: auto,
        timestamp: now,
        skipped: !did || empty
      };
      chain.currentStep = k + 1;
    }

    // 超时播报：只报「这一格真的有活、但没交」的人（组内已经走完一圈的人不算超时，
    // 否则 13 人 4/3/3/3 这种局面会在最后两格刷一屏假的「超时」）。
    const activeNow = this.activeUsers(k);
    const skipped = [];
    for (const uid of this.ring) {
      if (!activeNow.has(uid)) continue;
      if (!this.submitted.has(uid)) skipped.push(this.names.get(uid) || '某人');
    }
    if (skipped.length && type !== STEP.WORD) {
      this.api.systemChat('超时：' + skipped.join('、') + ' 这一手没交，按空格处理');
    }

    // ★ 写完起词这一步，**断言每条链的起词都非空**才允许进作画。
    //   候选词也没了（理论上不会：每格开局都会发 3 个）就宁可停在原地重来，
    //   也不带着空题目往下走 —— 那会让整条链作废，而且用户看得出来是坏的。
    if (type === STEP.WORD) {
      const bad = this.chains.filter(c => !(c.steps[0] && c.steps[0].content));
      if (bad.length) {
        this.api.systemChat('有人这一格没拿到候选词，重发一次…');
        this.submitted = new Set();
        this.pendingText = new Map();
        this.stepChoices = new Map();
        for (const chain of this.chains) delete chain.steps[0];
        return this.enterStep(0);            // 重开写词格，不放行到作画
      }
    }

    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();

    // 作画结束：把画布清干净（笔迹已经收进链条，不再留在共享画布上）
    if (this.phase === CHAIN_PHASE.DRAW) this.api.resetCanvas();

    // ★★ 每一棒收完 → 推进到下一格之前，断言「下一棒有人接」。
    //    判据 = 下一格里环上每个人都能拿到一条链（n 人 → n 个不重复的 cell），
    //    且下一格的作者都落在环里。断了就打日志 + 修复 + 播报，然后**照样推进**
    //    —— 用户明确要求绝不停在原地。（enterStep 里还会再自检一次，
    //    所以就算这里放过去了，下一格开局也会兜住。）
    if (k + 1 < this.chainLength) this.checkChainOrForce(k + 1);

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
        // 笔尖形状（★ 2.0.10）：回放里也要还原成同一支笔
        tipShape: s.tipShape, tipAngle: s.tipAngle, brush: s.brush,
        spacing: s.spacing, tip: s.tip, mix: s.mix, blend: s.blend, sym: s.sym,
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

  /* ------------------------------------------------------------ 回放与投票
   *
   * ⚠ 这一段是**按链串行**的：链 1 回放 → 所有人投票 → 结算 → 链 2 回放 → …
   *   绝对不允许「把 N 条链一次性摊开、各自随便投」——那样没人知道别人在看哪条，
   *   投票也没有共同的上下文。所以：
   *     · this.voteChainIndex 指向「现在这条链」，**服务端**说了算，全场同步；
   *     · keepVote / favVote 只接受当前这条链的票；
   *     · 一条链结算完才轮到下一条；全部结算完才进最终奖杯界面。
   */

  /** 组装一条链的公开数据（回放 / 投票 / 结算三处共用同一份） */
  chainRevealRow(c) {
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
      // 服务端先给一个初判（宽松匹配），真正的裁定看 √ 票
      matched: answerMatch(firstWord, lastWord),
      agree: 0,
      against: 0,
      won: false,
      steps: c.steps.map(s => ({
        playerId: s.playerId,
        playerName: this.names.get(s.playerId) || '某人',
        type: s.type,
        content: s.content,
        timestamp: s.timestamp,
        skipped: !!s.skipped,
        // 起词是系统替他随机抽的（本人超时没写）——回放界面据此标一句，
        // 免得大家以为那个人故意写了个莫名其妙的词
        auto: !!s.auto
      }))
    };
  }

  /** 当前正在回放 / 投票的那条链 */
  currentVoteChain() {
    return this.chains[this.voteChainIndex] || null;
  }

  /**
   * 全部格子收完 → 组装回放数据并广播（内容从此公开）。
   * 每条链重入一次：第一次建数据，后面几次只是把镜头挪到下一条。
   *
   * ★ v11：回放棒次由**服务端**持有（this.revealStep）。进这里时把指针拨回第 0 格，
   *   deadline = 当前这一格的 deadline；之后 tick() 每过 revealLegMs() 推进一格。
   *   前端只拿 snapshotFor() 里的 revealStep / revealLegs / legHoldMs 排动画。
   */
  enterReveal() {
    this.stepIndex = this.chainLength;
    if (!(this.voteChainIndex >= 0)) { this.voteChainIndex = 0; this.chainSettled = []; }
    for (const c of this.chains) {
      c.status = 'complete';
      c.currentStep = c.steps.length;
    }
    if (!this.revealData) {
      this.revealData = this.chains.map(c => this.chainRevealRow(c));
      // ★ v12：最喜欢的一张画 = **每条链各投一次**（votesFav 是两层 Map），
      //   整局累积、跨链统计。以前那一票会被下一条链覆盖，是这次修掉的 bug。
      this.votesFav = new Map();
    }
    this.revealVersion += 1;
    this.revealStep = 0;                  // ★ 从第一格开始放
    this.phase = CHAIN_PHASE.REVEAL;
    this.deadline = Date.now() + this.revealLegMs();
    this.api.sync();
    this.api.revealAll(this.revealData, this.revealVersion);
    const n = this.chains.length;
    this.api.systemChat('第 ' + (this.voteChainIndex + 1) + ' / ' + n + ' 条链回放 —— '
      + '共 ' + this.chainLength + ' 格，每格 ' + Math.round(this.revealLegMs() / 100) / 10 + ' 秒'
      + '（棒次由服务端同步，看完就轮到大家投票）');
  }

  /** 投「这条链首尾还对得上吗」——只收**当前那条链**的票 */
  keepVote(userId, chainId, agree) {
    if (this.phase !== CHAIN_PHASE.VOTE) return { ok: false, message: '现在不是投票阶段' };
    const cur = this.currentVoteChain();
    if (!cur) return { ok: false, message: '现在没有在投票的链' };
    if (chainId && chainId !== cur.chainId) {
      return { ok: false, message: '现在投的是另一条链，等轮到它' };
    }
    let m = this.votesKeep.get(userId);
    if (!m) { m = new Map(); this.votesKeep.set(userId, m); }
    m.set(cur.chainId, !!agree);
    // ★ v14 用户要求：**全员投完就立刻进下一条链**，不用干等到投票时限。
    //   未投的一律视为弃权（统计时按「没投 = 削弱 √ 方」算，见 chainVoteTally / settleChain）。
    //   注意 fav（♥）不参与这个判定 —— 它跟「匹配吗」是两码事。
    const t = this.chainVoteTally(cur.chainId);
    if (t.total > 0 && t.voted >= t.total) {
      this.api.sync();
      this.settleChain();
      return { ok: true, auto: true };
    }
    this.api.sync();
    return { ok: true };
  }

  /**
   * 投「最喜欢的一张画」—— **每条链各投一次**（同一人可改自己在这一条链上的那一票）。
   *
   * ⚠ v12 修的 bug：以前 votesFav 是 userId -> { chainId, step }，一人只有一票，
   *   串行投票走到下一条链时上一条链的 ♥ 就被覆盖掉了 —— 「点赞最多的画」于是
   *   只统计得到最后一条链。现在按链存（userId -> Map(chainId -> step)），跨链累积。
   * 仍然只限**当前正在看的那条链**（串行的前提：全场看的是同一条）。
   */
  favVote(userId, chainId, stepIdx) {
    if (this.phase !== CHAIN_PHASE.VOTE && this.phase !== CHAIN_PHASE.REVEAL) {
      return { ok: false, message: '现在不是看画的时候' };
    }
    const cur = this.currentVoteChain();
    if (!cur) return { ok: false, message: '现在没有在看的链' };
    if (chainId && chainId !== cur.chainId) return { ok: false, message: '现在看的是另一条链' };
    const k = Math.floor(Number(stepIdx));
    const st = cur.steps[k];
    if (!st || st.type !== STEP.DRAWING) return { ok: false, message: '那一格不是一幅画' };
    if (!Array.isArray(st.content) || !st.content.length) return { ok: false, message: '那是一张空画' };
    let m = this.votesFav.get(userId);
    if (!m) { m = new Map(); this.votesFav.set(userId, m); }
    m.set(cur.chainId, k);                    // ★ 只写当前这条链那一格，别的链的票留着
    this.api.sync();
    return { ok: true };
  }

  /** 我在某条链（chainId 为空 = 当前这条）上投的 ♥ = { chainId, step } / null */
  myFav(userId, chainId) {
    const m = this.votesFav.get(userId);
    if (!m) return null;
    let cid = chainId || '';
    if (!cid) { const cur = this.currentVoteChain(); cid = cur ? cur.chainId : ''; }
    if (!cid || !m.has(cid)) return null;
    return { chainId: cid, step: m.get(cid) };
  }

  /** 我投过 ♥ 的**所有**链：{ chainId: step }（快照给前端画小 ♥ 用） */
  myFavMap(userId) {
    const out = {};
    const m = this.votesFav.get(userId);
    if (m) for (const [cid, step] of m) out[cid] = step;
    return out;
  }

  /** 我投过 ♥ 的条数（进度显示用；不是全场票数之和） */
  myFavCount(userId) {
    const m = this.votesFav.get(userId);
    return m ? m.size : 0;
  }

  /**
   * 这一条链的**合法投票人**（v12 按组收紧）。
   *
   * 分组之后「这条链首尾对不对得上」只跟**它那一组**的成员有关：别的组既没参与
   * 这条链的传递，也没看过中间过程 —— 让他们投是噪声（而且各组按链轮流看，
   * 轮到 A 组的链时 B 组本来也没在屏幕上看）。所以票只统计同组的人。
   * 找不到分组信息（老的壳 / 单测造的假链）就退回「全场」——4~6 人 1 组时两者等价。
   */
  votersFor(chainId) {
    const c = this.chains.find(x => x.chainId === chainId);
    const g = c ? this.groupOfChain(c) : null;
    if (g && g.members.length) return new Set(g.members);
    return new Set(this.ring);
  }

  /** 当前这条链的实时票数（前端显示「已投 x / y」用） */
  chainVoteTally(chainId) {
    const voters = this.votersFor(chainId);
    let agree = 0, against = 0, voted = 0;
    for (const [uid, m] of this.votesKeep) {
      if (!voters.has(uid)) continue;
      const v = m.get(chainId);
      if (v === undefined) continue;
      voted += 1;
      if (v) agree += 1; else against += 1;
    }
    return { agree, against, voted, total: voters.size };
  }

  /**
   * ★ v14：当前这条链**已经投过的人**（画布下方那排 √ / × 小标记）。
   *
   * 只列投过的、按投票人名单的顺序（= 分组环序），没投的不出现 ——
   * 前端拿它 + voteDone / voteTotal 就能画出「已投 x / y」和每个人投了哪边。
   * 名字走 this.names（人走了也还显示得出来），只给这条链的合法投票人。
   */
  chainVoteMarks(chainId) {
    const voters = this.votersFor(chainId);
    const rows = [];
    if (!chainId) return rows;
    for (const uid of voters) {
      const m = this.votesKeep.get(uid);
      const v = m ? m.get(chainId) : undefined;
      if (v === undefined) continue;
      rows.push({ userId: uid, name: this.names.get(uid) || '某人', add: !!v });
    }
    return rows;
  }

  /** 当前这条链投完 → 结算它，然后把镜头交给下一条链（或最终结算） */
  settleChain() {
    const cur = this.currentVoteChain();
    if (!cur) return this.enterScore();
    const row = (this.revealData || []).find(r => r.chainId === cur.chainId)
      || this.chainRevealRow(cur);
    const t = this.chainVoteTally(cur.chainId);
    row.agree = t.agree;
    row.against = t.against;
    row.voted = t.voted;
    row.total = t.total;
    // ★ 用户的规矩：**√ 过半就给起词人一个奖杯**（文本匹配只作为画面上的参考信息，
    //   最终裁定权在玩家手里，这样「虽然跑偏了但大家觉得很妙」也能得奖）
    row.won = t.agree * 2 > Math.max(1, t.total);
    if (row.won && cur.ownerPlayerId) {
      this.scores.set(cur.ownerPlayerId,
        (this.scores.get(cur.ownerPlayerId) || 0) + P.GAME.CHAIN_TROPHY_AGREE);
    }
    this.chainSettled = (this.chainSettled || []).filter(r => r.chainId !== row.chainId).concat([row]);
    this.api.systemChat('「' + row.ownerName + '」这条链：√ ' + row.agree + ' / × ' + row.against
      + ' —— ' + (row.won ? '对上了，起词人拿一个奖杯 🏆' : '没过半，这条不算'));

    this.voteChainIndex += 1;
    const more = this.voteChainIndex < this.chains.length;
    this.phase = CHAIN_PHASE.SCORE;
    this.deadline = Date.now() + (more ? CFG.CHAIN_SCORE_MS : CFG.SCORE_MS);
    this.voteResult = more
      ? { partial: true, chains: this.chainSettled.slice(), fav: [], favTie: false, favRanking: [] }
      : this.finalVoteResult();
    this.api.sync();
    return { ok: true };
  }

  /** 全部链结算完 → 最终奖杯界面（含「最喜欢的一张画」） */
  enterScore() {
    this.phase = CHAIN_PHASE.SCORE;
    this.voteChainIndex = this.chains.length;
    this.voteResult = this.finalVoteResult();
    this.deadline = Date.now() + CFG.SCORE_MS;
    this.api.sync();
    return { ok: true };
  }

  /** 最终结算：各链结果 + 「最喜欢的一张画」（跨链计票，独赢 3 / 平票各 1） */
  /**
   * 最终结算：各链结果 + 「点赞最多的画」（跨链统计，独赢 3 / 平票各 1）。
   *
   * ★ v12 的两件事：
   *   ① votesFav 现在是「一人 × 每条链一票」，所以要**两层遍历**把跨链的票全部数进来
   *      （以前只数得到最后一条链 —— 就是这次修掉的 bug）。跨组的票不计（见 votersFor）。
   *   ② `fav` 里除了名次还给**那一格的笔迹**（strokes）与链主名（ownerName），
   *      前端直接把 strokes 铺在主画布上渲染大图，不用再回查回放数据。
   *      平票时 `fav` 返回多条并置 `favTie: true`，另外给一个按票数降序的 `favRanking`
   *      （每一项都带 strokes，前端想画「第 2、第 3 名」也不用二次请求）。
   */
  finalVoteResult() {
    const tally = new Map(); // 'chainId:step' -> votes
    for (const [uid, favMap] of this.votesFav) {
      if (!favMap || !favMap.size) continue;
      for (const [chainId, step] of favMap) {
        const voters = this.votersFor(chainId);
        if (!voters.has(uid)) continue;                 // 跨组的票不算
        const c = this.chains.find(x => x.chainId === chainId);
        const st = c && c.steps[step];
        if (!st || st.type !== STEP.DRAWING) continue;  // 那一格不是画（或早被清掉）
        if (!Array.isArray(st.content) || !st.content.length) continue;
        const key = chainId + ':' + step;
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
    // 名次表：票数降序（同票按链序、再按格序，保证各端看到的名次一样）
    const chainIndex = new Map(this.chains.map((c, i) => [c.chainId, i]));
    const ranked = [];
    for (const [key, votes] of tally) {
      const ci = key.indexOf(':');
      const chainId = key.slice(0, ci), k = Number(key.slice(ci + 1));
      const c = this.chains.find(x => x.chainId === chainId);
      const st = c && c.steps[k];
      if (!c || !st) continue;
      ranked.push({
        chainId,
        chainIndex: chainIndex.has(chainId) ? chainIndex.get(chainId) : -1,
        step: k,
        playerId: st.playerId,
        playerName: this.names.get(st.playerId) || '某人',
        votes,
        strokes: st.content,                            // ★ 那一格的笔迹，前端直接铺主画布
        ownerName: this.names.get(c.ownerPlayerId) || c.ownerName
      });
    }
    ranked.sort((a, b) => b.votes - a.votes || a.chainIndex - b.chainIndex || a.step - b.step);

    const top = ranked.length ? ranked[0].votes : 0;
    const winners = top > 0 ? ranked.filter(r => r.votes === top) : [];
    winners.forEach(w => {
      this.scores.set(w.playerId, (this.scores.get(w.playerId) || 0)
        + (winners.length === 1 ? P.GAME.CHAIN_FAV_POINTS : P.GAME.CHAIN_FAV_TIE_POINTS));
    });
    const rows = this.chainSettled && this.chainSettled.length
      ? this.chainSettled.slice()
      : (this.revealData || []).slice();
    if (winners.length === 1) {
      this.api.systemChat('最受欢迎的画出自 ' + winners[0].playerName + '（' + winners[0].votes + ' 票）');
    } else if (winners.length > 1) {
      this.api.systemChat('最受欢迎的画平票：' + winners.map(w => w.playerName).join('、'));
    }
    const kept = rows.filter(r => r.won);
    this.api.systemChat(kept.length
      ? '这一局有 ' + kept.length + ' 条链首尾对上了：' + kept.map(w => w.ownerName).join('、')
      : '这一局全军覆没 —— 没有一条链安全到达终点');
    return {
      partial: false,
      chains: rows,
      fav: winners,
      favTie: winners.length > 1,
      favRanking: ranked
    };
  }

  /** 当前这条链看完了 → 进投票。每条链都走一遍这里（服务端说了算，全场看同一条）。 */
  enterVote() {
    this.phase = CHAIN_PHASE.VOTE;
    // ★ 投票时棒次钉在**最后一格**：大家要看着最终画面决定「对得上吗」，
    //   不能让各端自己停在半路上。
    this.revealStep = Math.max(0, this.chainLength - 1);
    this.deadline = Date.now() + this.stepMs();
    this.api.sync();
    const n = this.chains.length;
    this.api.systemChat('投票：这条链的「起词 → 最后猜出来的词」对得上吗？（'
      + (this.voteChainIndex + 1) + ' / ' + n + '）'
      + '—— 顺便点一下你最喜欢的那张画');
  }

  /** 结算阶段结束 → 回大厅（分数保留，可再来一局） */
  toLobby() {
    this.phase = CHAIN_PHASE.LOBBY;
    this.deadline = 0;
    this.stepIndex = 0;
    this.chains = [];
    this.ring = [];
    this.groups = [];
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.revealData = null;
    this.revealStep = 0;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.voteResult = null;
    this.voteChainIndex = 0;          // 按链串行投票：从第一条链开始
    this.chainSettled = [];
    this.ready.clear();
    this.api.sync();
    this.api.systemChat('回到接龙大厅 —— 点「准备」再来一局（分数保留）');
  }

  /**
   * 房主按「立刻推进」：
   *   大厅   —— 全员视为已准备，直接开局
   *   写/画/猜 —— 不等超时，把没交的按「空」处理并收格
   *   回放   —— 进投票（v14：回放本身由服务端推，没有手动翻格）
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
    if (this.phase === CHAIN_PHASE.REVEAL) {
      // ★ v14：回放没有手动干预（前端那一排播放 / 翻格 / 倍速控件已经删掉），
      //   房主的「立刻推进」= 这条链不看了，直接进投票（以前是推进一格）。
      this.enterVote();
      return { ok: true };
    }
    if (this.phase === CHAIN_PHASE.VOTE) { return this.settleChain(); }
    if (this.phase === CHAIN_PHASE.SCORE) {
      // 还有链没放 → 回放下一条；全放完了 → 回大厅
      if (this.voteChainIndex < this.chains.length) this.enterReveal();
      else this.toLobby();
      return { ok: true };
    }
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
    // ★ 回放：deadline = **当前这一格**的 deadline。每过 revealLegMs() 推进一格；
    //   到最后一格、并且它那一格的定格时间也过去了 → 进投票。
    //   （这条 if 会随着 deadline 被不断往后推而反复进来，不再是「整段一个 deadline」。）
    if (this.phase === CHAIN_PHASE.REVEAL) {
      if (this.revealStep + 1 >= this.chainLength) return this.enterVote();
      this.revealStep += 1;
      // ★ v15：下一格停多久**由那一格自己决定**（起词 / 猜词格短、作画格长）
      this.deadline = nowMs + this.revealLegMs(this.revealStep);
      this.api.sync();
      return;
    }
    if (this.phase === CHAIN_PHASE.VOTE) return this.settleChain();
    // SCORE 有两种：一条链的小结算（后面还有链 → 回放下一條）、以及最终结算（→ 回大厅）
    if (this.phase === CHAIN_PHASE.SCORE) {
      return (this.voteChainIndex < this.chains.length) ? this.enterReveal() : this.toLobby();
    }
  }

  stop() {
    this.spectators.clear();
    this.phase = CHAIN_PHASE.OFF;
    this.deadline = 0;
    this.ring = [];
    this.groups = [];
    this.chains = [];
    this.stepIndex = 0;
    this.submitted = new Set();
    this.pendingText = new Map();
    this.stepChoices = new Map();
    this.revealData = null;
    this.revealStep = 0;
    this.votesKeep = new Map();
    this.votesFav = new Map();
    this.voteResult = null;
    this.voteChainIndex = 0;          // 按链串行投票：从第一条链开始
    this.chainSettled = [];
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
        // v12：只等「这一格有活的人」（组内已走完一圈的成员不占位）
        if (this.ring.length && this.submitted.size >= this.activeUsers(this.stepIndex).size) {
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
  groupCountFor, // v12 分组表：人数 → 组数（测试直接钉它）
  groupSizesFor, // v12 分组表：人数 → 各组人数（尽量均分）
  answerMatch,   // 导出供自检脚本直接验证「首尾算不算对得上」
  simplify,      // 上面这条依赖的归一化（测试要看中间值）
  norm
};
