'use strict';

/**
 * 每局可配的游戏设置 —— GAME_START 的 opts 与 GAME_PREFS 的「房主预设」共用这一份规则。
 *
 * 为什么要单独一个模块（而不是散在 index.js 里）：
 *   1. **白名单只有一份**。哪一条消息能带哪些字段、每个字段怎么夹取，全在这里；
 *      index.js 只负责「谁有权限发」「广播给谁」，三处 start() 只负责「怎么用」。
 *   2. 这里的函数**纯逻辑、不碰 WebSocket、不碰磁盘**，所以 tools/test-game-setup.js
 *      能离线把它们逐条断言（清洗 / 夹取 / 非房主被拒 / 开局的 cfg 白名单透传）。
 *
 * 取值约定（**0 = 用默认**，唯一例外是 repickLimit）：
 *   - 秒数字段：0 / 缺省 / 非法 / 负数 = 用默认（存 0）；否则夹到 [3, 600]。
 *     **drawSeconds 例外** —— 它从 v4 起最短就是 30 秒（房主侧最短 30 秒），仍是 [30, 300]。
 *   - rounds：0 / 缺省 / 非法 = 用默认（存各玩法的默认回合数）；否则夹到 [1, 该玩法上限]。
 *   - chainLength：0 / 缺省 / 非法 = 用默认（开局时 = **2 × 人数**，每人连续两格）；否则夹到 [3, 16]。
 *   - repickLimit：**0 是实义值**（这一局一次都不许「换一组」）；缺省 / 非法 = 默认 1；夹到 [0, 5]。
 *
 * ⚠ 与 start() 的分工：这里的值**只是预设 / 面板显示**，真正的裁定仍在三处 start() 里
 *   （它们各自再夹一次，老客户端不发新字段时行为与 v9 完全一致）。
 *   所以 pickStartOpts() 刻意**不夹取** —— 只做字段白名单，`undefined` 原样透传，
 *   让 start() 自己决定「缺省 = 什么」。
 */

const P = require('./protocol');
const THEMES = require('./themes');

const G = P.GAME;
const MODES = ['classic', 'chain', 'skin'];

function clampInt(v, d, a, b) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return d;
  return n < a ? a : n > b ? b : n;
}

/** 布尔 / null / 空串 都不该被 Number() 蒙成有意义的数字 */
function badNum(v) {
  return v === null || v === undefined || typeof v === 'boolean' ||
    (typeof v === 'string' && !v.trim());
}

/**
 * 秒 → 「0 或 [min, max]」。0 / 缺省 / 非法 / 负数一律回 0（= 用默认）。
 *
 * 与 clampInt 的区别就在 0 上：clampInt(0, d, 3, 600) 会得到 3（下限），
 * 而这里的 0 是「房主没设，用默认」这个**有意义的信号**，必须原样穿过去。
 */
function secOrZero(v, min, max) {
  if (badNum(v)) return 0;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return 0;
  const lo = min || G.SETUP_SECONDS_MIN;
  const hi = max || G.SETUP_SECONDS_MAX;
  return n < lo ? lo : n > hi ? hi : n;
}

/** 整数 → 「0 或 [min, max]」，0 / 缺省 / 非法回 0（= 用默认） */
function intOrZero(v, min, max) {
  if (badNum(v)) return 0;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return 0;
  return n < min ? min : n > max ? max : n;
}

/** 整数 → [min, max]，0 / 缺省 / 非法回**具体默认值**（用于面板上没有 0 档的字段，如 rounds） */
function intOrDefault(v, dflt, min, max) {
  if (badNum(v)) return dflt;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return dflt;
  return n < min ? min : n > max ? max : n;
}

/**
 * GAME_START / GAME_PREFS 认的全部字段（按 mode 取用）。
 * **顺序与形状就是这个顺序** —— pendingGame 的 14 个字段 + by/at 由 applyGamePrefs 补上。
 */
const GAME_PREF_FIELDS = [
  'mode', 'theme', 'drawSeconds',
  // classic
  'rounds', 'repickLimit', 'roundEndSeconds',
  // chain
  'chainLength', 'writeSeconds', 'guessSeconds', 'revealSeconds', 'voteSeconds',
  // skin
  'nightSeconds', 'dawnSeconds', 'talkSeconds'
];

/** 一条消息里允许出现的字段（= 上面那张表 + mode 之外没有别的） */
function pickStartOpts(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of GAME_PREF_FIELDS) {
    // hasOwnProperty：`{"__proto__": {...}}` 这种不进白名单，也不会被当成自有字段
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

/**
 * 把任意来源的「本局设置」清洗成固定形状。
 *
 * **逐个字段列全**，绝不整包存下来 —— 前端发什么字段都行，存下来的只有这一份。
 * 越界一律夹住，非法一律回默认，多出来的字段直接丢（包括 by / at：那是服务端加的）。
 */
function normalizeGamePrefs(src) {
  src = (src && typeof src === 'object') ? src : {};
  const mode = MODES.indexOf(src.mode) >= 0 ? src.mode : 'classic';
  // 主题必须是服务端认识的 id（自定义词库也算）——否则退回 '' = 通用词库
  const theme = (typeof src.theme === 'string' && src.theme && THEMES.hasTheme(src.theme))
    ? src.theme : '';
  const maxRounds = mode === 'skin' ? G.SKIN_MAX_ROUNDS : G.MAX_ROUNDS;
  const dfltRounds = mode === 'skin' ? G.SKIN_ROUNDS : G.DEFAULT_ROUNDS;

  return {
    mode: mode,
    theme: theme,
    // rounds 在面板上没有 0 档（档位是 1,2,3,4,6,8,12），所以 0 / 缺省都给**具体的默认回合数**，
    // 前端可以直接把它喂回 GAME_START 而不会踩到「0 被 start() 夹成 1 回合」那个坑。
    rounds: intOrDefault(src.rounds, dfltRounds, 1, maxRounds),
    drawSeconds: secOrZero(src.drawSeconds, G.DRAW_SECONDS_MIN, G.DRAW_SECONDS_MAX),
    // ⚠ 0 在这里是实义值：0 = 这一局不允许「换一组」
    repickLimit: clampInt(src.repickLimit, G.REPICK_LIMIT, 0, 5),
    roundEndSeconds: secOrZero(src.roundEndSeconds),
    // 0 = 默认（开局时 = **2 × 人数**；chain.start 本来就认 0 为「没设」）
    // 注意 [3, 16] 只是**面板档位**的上限：真正的链长上限是 2 × min(人数, CHAIN_LENGTH_MAX)，
    // 由 chain.start()/beginGame() 按当时的人数再夹一次（链比 2×人数 长就会绕第二圈）。
    chainLength: intOrZero(src.chainLength, G.CHAIN_LENGTH_MIN, G.CHAIN_LENGTH_MAX),
    writeSeconds: secOrZero(src.writeSeconds),
    guessSeconds: secOrZero(src.guessSeconds),
    revealSeconds: secOrZero(src.revealSeconds),
    voteSeconds: secOrZero(src.voteSeconds),
    nightSeconds: secOrZero(src.nightSeconds),
    dawnSeconds: secOrZero(src.dawnSeconds),
    talkSeconds: secOrZero(src.talkSeconds)
  };
}

/**
 * 处理一条 C2S.GAME_PREFS：权限 → 清洗 → 挂到房间上。
 *
 * 返回 { ok:true, prefs } 时调用方把 prefs 广播给全房间（含发送者）；
 * 返回 { ok:false, code, message } 时房间状态**一个字节都没动**。
 *
 * room.pendingGame 照 room.projectLoad 的先例：挂在房间上、不落盘、不进 meta()/summary()。
 */
function applyGamePrefs(room, member, msg) {
  if (!room) return { ok: false, code: 'no_room', message: '还没进房间' };
  if (!member) return { ok: false, code: 'no_member', message: '还没进房间' };
  if (member.userId !== room.ownerId) {
    return { ok: false, code: 'not_owner', message: '只有房主可以预设游戏设置' };
  }
  const prefs = normalizeGamePrefs(msg);
  prefs.by = member.userId;
  prefs.at = Date.now();
  room.pendingGame = prefs;
  return { ok: true, prefs: prefs };
}

/** 清掉本局预设（GAME_START 成功 / GAME_STOP 之后调用） */
function clearGamePrefs(room) {
  if (room) room.pendingGame = null;
}

/**
 * 房主转让：预设**保留**，但 by 换成新房主 ——
 * 否则别人看到的是「上一个房主留的设置」，而能改它的已经换人了。
 */
function retargetGamePrefs(room, ownerId) {
  if (room && room.pendingGame) room.pendingGame.by = ownerId || '';
}

/**
 * /api/share 的 setup 块：给前端渲染下拉框用。
 *
 * 玩家上下限与回合档位**全部从 protocol 的常量推**，不在客户端再抄一份数字。
 * 回合档位 = SETUP_ROUNDS_STEPS ∪ {DEFAULT_ROUNDS, SKIN_MAX_ROUNDS}，
 * 再按两个玩法的上限截断（一个列表要同时能喂给 classic 和 skin）→ [1,2,3,4,6,8,12]。
 */
function setupOptions() {
  const roundMax = Math.min(G.MAX_ROUNDS, G.SKIN_MAX_ROUNDS);
  const rounds = G.SETUP_ROUNDS_STEPS
    .concat([G.DEFAULT_ROUNDS, G.SKIN_MAX_ROUNDS])
    .filter(v => v >= 1 && v <= roundMax)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);

  return {
    seconds: G.SETUP_SECONDS.slice(),   // 0 = 默认
    players: {
      classic: [G.MIN_PLAYERS, G.MAX_PLAYERS],
      chain: [G.CHAIN_MIN_PLAYERS, G.CHAIN_MAX_PLAYERS],
      skin: [G.SKIN_MIN_PLAYERS, G.SKIN_MAX_PLAYERS]
    },
    // 接龙链长的档位（v11）：前端**不要写死**，链长的一切都以这两个数为准 ——
    //   默认 = 2 × 在线人数（每人连续两格：画自己拿到的 + 猜下一格）；
    //   上限 = 2 × min(人数, CHAIN_LENGTH_MAX)，再往下限 3 兜底。
    // 前端算档位：min 到 max(3, 2*min(在线人数, chainMax))，默认取 2*在线人数。
    chainLength: {
      min: G.CHAIN_LENGTH_MIN,
      max: G.CHAIN_LENGTH_MAX,        // 是**人数**的封顶（真实链长上限 = 它的 2 倍）
      perPlayer: 2                    // 默认 / 上限的倍数：链长 = perPlayer × 人数
    },
    repick: G.SETUP_REPICK.slice(),
    rounds: rounds
  };
}

/**
 * GAME_FAST 的真值判断：'1' / 'true' / 'yes' 之类都算开，
 * '0' / 'false' / '' / 没设 = 关。三个玩法的 envMs 里各有一份同样的实现
 * （本来就是各写各的），这里这一份给 /api/share 报 fast 字段用。
 */
function isGameFast() {
  const v = process.env.GAME_FAST;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
}

module.exports = {
  GAME_PREF_FIELDS,
  pickStartOpts,
  normalizeGamePrefs,
  applyGamePrefs,
  clearGamePrefs,
  retargetGamePrefs,
  setupOptions,
  isGameFast,
  secOrZero,
  intOrZero,
  intOrDefault,
  clampInt
};
