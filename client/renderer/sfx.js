'use strict';

/**
 * 游戏音效 —— 全部用 WebAudio **现场合成**，不带任何音频文件。
 *
 * 为什么不用 mp3：
 *   ① 网页版与 Electron 共用这份前端，塞音频文件要多一套打包/托管/路径逻辑；
 *   ② 一点点提示音的体积，跟 exe 包体比不值一提，但「多一批二进制资源」这件事本身是负担；
 *   ③ 合成音可以按需要微调（比如倒计时越紧音越高），音频文件做不到参数化。
 *   代价是音色偏「电子提示音」—— 对一个协作画画的小游戏来说完全够用，也不难听。
 *
 * 浏览器自动播放策略（必须遵守，否则静音且不报错）：
 *   AudioContext 在「用户手势之前」创建会处于 suspended，play() 出来是一片死寂。
 *   所以这里**懒创建**：第一次真正出声时才 new AudioContext，并挂一次性的
 *   pointerdown/keydown 监听把它 resume 掉。
 *
 * 静音开关持久化到 localStorage，跨房间跨回合都记得。
 */

const STORAGE_KEY = 'chahu.sfx';
const VOL_KEY = 'chahu.sfx.vol';

/** 主音量的默认值。合成音很容易做过头，整体压低一档 */
const MASTER_DEFAULT = 0.22;

let ctx = null;
let enabled = true;
let unlocked = false;
/** 当前主音量（用户可在游戏 HUD 上调，0 = 静音但不关开关） */
let master = MASTER_DEFAULT;

/* ------------------------------------------------------------ 开关 */

(function readPref() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === '0') enabled = false;
    // ★ 必须先判空再解析：`Number(null)` 和 `Number('')` 都是 0，而 0 是一个
    // **合法的音量值**（用户真的可以把滑块拉到 0）。不判空的话，「从没存过音量」
    // 会被读成「用户已经把音量调到 0」—— 表现是图标显示 🔈、而且一点声音都没有，
    // 偏偏开关还是「开」的，排查起来极难。
    const raw = localStorage.getItem(VOL_KEY);
    if (raw !== null && raw !== '') {
      const vol = Number(raw);
      if (isFinite(vol) && vol >= 0 && vol <= 1) master = vol;
    }
  } catch (e) { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
})();

/** 主音量 0~1。0 不是「关掉音效」——开关是开关，音量是音量。 */
function setVolume(v) {
  const n = Number(v);
  master = isFinite(n) ? Math.max(0, Math.min(1, n)) : MASTER_DEFAULT;
  try { localStorage.setItem(VOL_KEY, String(master)); } catch (e) { /* 同上 */ }
  return master;
}
function getVolume() { return master; }

function setEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (e) { /* 同上 */ }
  return enabled;
}

function isEnabled() { return enabled; }

function toggle() { return setEnabled(!enabled); }

/* ------------------------------------------------------------ AudioContext */

function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch (e) {
    return null;
  }
  return ctx;
}

/**
 * 首次用户手势时把 AudioContext 唤醒。
 *
 * 不这么做的话：页面刚加载（用户还没点过任何东西）收到的第一条音效
 * 会静默丢掉 —— 而这恰好是「有人进房了」这类最该响的提示。
 * 所以这个「解锁」必须和真正播放的音效是同一套路径。
 */
function unlock() {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  unlocked = true;
}

(function installUnlockOnce() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  const once = function () {
    unlock();
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
    window.removeEventListener('touchstart', once, true);
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
  window.addEventListener('touchstart', once, true);
})();

/* ------------------------------------------------------------ 合成基元 */

/**
 * 一个「音符」：振荡器 + 包络，可选滑音。
 *
 *   freq  → 起始频率（Hz）
 *   to    → 终止频率（给了就滑音）
 *   dur   → 时长（秒）
 *   type  → 波形：sine 柔 / triangle 亮 / square 刺 / sawtooth 糙
 *   gain  → 相对音量（0~1，最终还会乘 MASTER）
 *   delay → 延后多久出声（用来排「哆来咪」这样的短句）
 *   attack/release → 包络曲线，不填按 dur 自动分配
 */
function tone(opt) {
  const c = audio();
  if (!c) return;

  const t0 = c.currentTime + (opt.delay || 0);
  const dur = opt.dur || 0.1;
  const peak = (opt.gain == null ? 1 : opt.gain) * master;
  const atk = opt.attack == null ? Math.min(0.012, dur * 0.3) : opt.attack;
  const rel = opt.release == null ? Math.min(0.12, dur * 0.6) : opt.release;

  const osc = c.createOscillator();
  const g = c.createGain();

  osc.type = opt.type || 'sine';
  osc.frequency.setValueAtTime(opt.freq, t0);
  if (opt.to && opt.to !== opt.freq) {
    // 指数滑音更好听，但频率不能为 0（WebAudio 会抛）
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + dur);
  }

  // 音量包络：0 → peak（atk）→ 保持 → 0（rel）。两端必须精确到 0，
  // 否则截断处会有「啪」的爆音。
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + atk);
  g.gain.setValueAtTime(peak, t0 + Math.max(atk, dur - rel));
  g.gain.linearRampToValueAtTime(0, t0 + dur);

  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 噪声：用来做「刷」「沙」「爆」这类非乐音 */
function noise(opt) {
  const c = audio();
  if (!c) return;

  const t0 = c.currentTime + (opt.delay || 0);
  const dur = opt.dur || 0.12;
  const peak = (opt.gain == null ? 0.6 : opt.gain) * master;

  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buf;

  const filter = c.createBiquadFilter();
  filter.type = opt.filter || 'bandpass';
  filter.frequency.setValueAtTime(opt.freq || 1200, t0);
  if (opt.to) filter.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + dur);
  filter.Q.value = opt.q == null ? 1 : opt.q;

  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.01, dur * 0.2));
  g.gain.linearRampToValueAtTime(0, t0 + dur);

  src.connect(filter);
  filter.connect(g);
  g.connect(c.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/* ------------------------------------------------------------ 音效表
 *
 * 命名按「什么时候响」而不是「什么声音」—— 调用点读起来才像人话：
 *   SFX.play('roundStart')
 * 而不是
 *   SFX.play('twoToneUp')
 *
 * 每个音效自己负责「要不要响」「响成什么样」。参数全是拍脑袋调的，
 * 但都有个说法：倒计时用短促、猜对用上行、失败用下行、结算用琶音。
 */

const BANK = {
  /* ---- 通用 UI ---- */

  // 轻点：界面上的小确认
  tap() {
    tone({ freq: 880, dur: 0.05, type: 'triangle', gain: 0.35 });
  },

  // 切换 / 选中
  toggle() {
    tone({ freq: 660, to: 990, dur: 0.08, type: 'triangle', gain: 0.4 });
  },

  // 出错了（提交失败 / 操作被拒）
  error() {
    tone({ freq: 260, to: 170, dur: 0.18, type: 'square', gain: 0.35 });
  },

  /* ---- 房间与开局 ---- */

  // 有人进来
  join() {
    tone({ freq: 720, dur: 0.09, type: 'sine', gain: 0.5 });
    tone({ freq: 1080, dur: 0.12, type: 'sine', gain: 0.42, delay: 0.07 });
  },

  // 有人离开
  leave() {
    tone({ freq: 700, to: 420, dur: 0.18, type: 'sine', gain: 0.42 });
  },

  // 游戏开始：上行四音（哆-咪-嗦-哆），有「开场」感
  gameStart() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.55, delay: i * 0.085 });
    });
  },

  // 游戏结束
  gameOver() {
    const notes = [784, 659, 523, 392];
    notes.forEach((f, i) => {
      tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.5, delay: i * 0.11 });
    });
  },

  /* ---- 回合 / 步骤 ---- */

  // 轮到「你」做事：两声短促上行 —— 这个音必须是全场最容易被认出来的，
  // 因为它对应「该你了」，错过就要罚站一整步
  yourTurn() {
    tone({ freq: 880, dur: 0.11, type: 'triangle', gain: 0.7 });
    tone({ freq: 1320, dur: 0.16, type: 'triangle', gain: 0.6, delay: 0.1 });
  },

  // 进入新的一步（不是你的事，但节奏变了）
  stepStart() {
    tone({ freq: 587, dur: 0.09, type: 'sine', gain: 0.4 });
    tone({ freq: 784, dur: 0.11, type: 'sine', gain: 0.35, delay: 0.07 });
  },

  // 进入新的一圈
  roundStart() {
    tone({ freq: 523, dur: 0.1, type: 'sine', gain: 0.45 });
    tone({ freq: 659, dur: 0.1, type: 'sine', gain: 0.42, delay: 0.08 });
    tone({ freq: 880, dur: 0.16, type: 'sine', gain: 0.4, delay: 0.16 });
  },

  // 提交成功：干净的一声上行（「东西交出去了」）
  submit() {
    tone({ freq: 700, to: 1100, dur: 0.14, type: 'triangle', gain: 0.55 });
  },

  /* ---- 你画我猜 ---- */

  // 猜对了：明亮的上行三音 + 一点闪光
  correct() {
    [784, 988, 1319].forEach((f, i) => {
      tone({ freq: f, dur: 0.14, type: 'triangle', gain: 0.6, delay: i * 0.07 });
    });
    noise({ freq: 5200, to: 8000, dur: 0.22, gain: 0.22, q: 0.8, delay: 0.14 });
  },

  // 别人猜对了（自己没猜出来）—— 同一段但闷一点，别抢自己猜对的戏
  correctOther() {
    [784, 988].forEach((f, i) => {
      tone({ freq: f, dur: 0.13, type: 'sine', gain: 0.38, delay: i * 0.07 });
    });
  },

  // 交了个错的：下行短音（不刺耳，别让人不敢再猜）
  wrong() {
    tone({ freq: 420, to: 300, dur: 0.16, type: 'sine', gain: 0.42 });
  },

  // 「很接近了」：半音上下抖动，一听就知道差一点
  close() {
    tone({ freq: 740, dur: 0.1, type: 'sine', gain: 0.45 });
    tone({ freq: 784, dur: 0.14, type: 'sine', gain: 0.4, delay: 0.1 });
  },

  // 露字提示：清脆的「叮」
  hint() {
    tone({ freq: 1568, dur: 0.22, type: 'sine', gain: 0.4 });
    tone({ freq: 2093, dur: 0.18, type: 'sine', gain: 0.22, delay: 0.04 });
  },

  /* ---- 倒计时 ---- */

  // 剩 10 秒：一次警告
  tickWarn() {
    tone({ freq: 1046, dur: 0.09, type: 'square', gain: 0.3 });
  },

  // 剩 3 秒内：每 500ms 一声，越靠近越高
  tickUrgent(opt) {
    const n = Math.max(0, Math.min(5, (opt && opt.n) || 0));
    tone({ freq: 1180 + n * 90, dur: 0.07, type: 'square', gain: 0.32 });
  },

  // 超时（这一步没交）
  timeout() {
    tone({ freq: 320, to: 160, dur: 0.34, type: 'sawtooth', gain: 0.4 });
  },

  /* ---- 接龙：回放与投票 ---- */

  // 翻到下一条链：短促的「唰」
  flip() {
    noise({ freq: 2400, to: 900, dur: 0.13, gain: 0.3, q: 1.2 });
    tone({ freq: 520, to: 780, dur: 0.1, type: 'sine', gain: 0.3 });
  },

  // 回放里一格一格揭开：极短的点
  cellReveal() {
    tone({ freq: 1320, dur: 0.05, type: 'triangle', gain: 0.28 });
  },

  // 首尾对上了（回放判定）
  match() {
    [880, 1109, 1319].forEach((f, i) => {
      tone({ freq: f, dur: 0.13, type: 'triangle', gain: 0.5, delay: i * 0.06 });
    });
  },

  // 首尾对不上（回放判定）
  mismatch() {
    tone({ freq: 466, dur: 0.13, type: 'sawtooth', gain: 0.34 });
    tone({ freq: 349, dur: 0.2, type: 'sawtooth', gain: 0.3, delay: 0.11 });
  },

  // 投票「对得上」：明亮的确认音
  voteOk() {
    tone({ freq: 988, dur: 0.1, type: 'triangle', gain: 0.55 });
    tone({ freq: 1319, dur: 0.14, type: 'triangle', gain: 0.45, delay: 0.08 });
  },

  // 投票「对不上」：低一档的确认音（不是错误，只是另一种选择）
  voteBad() {
    tone({ freq: 622, dur: 0.1, type: 'triangle', gain: 0.5 });
    tone({ freq: 466, dur: 0.14, type: 'triangle', gain: 0.42, delay: 0.08 });
  },

  // 撤销投票（改回「对得上」/ 取消）
  voteUndo() {
    tone({ freq: 560, to: 700, dur: 0.1, type: 'sine', gain: 0.32 });
  },

  /* ---- 结算 ---- */

  // 拿奖杯：上行琶音 + 高频闪光，整局里最华丽的一个音
  trophy() {
    [659, 831, 988, 1319, 1661].forEach((f, i) => {
      tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.6, delay: i * 0.075 });
    });
    noise({ freq: 6000, to: 11000, dur: 0.5, gain: 0.16, q: 0.6, delay: 0.32 });
  },

  // 没拿到奖杯
  noTrophy() {
    tone({ freq: 494, dur: 0.14, type: 'sine', gain: 0.35 });
    tone({ freq: 392, dur: 0.24, type: 'sine', gain: 0.3, delay: 0.13 });
  },

  // 有人发言（仅房间聊天用，很轻）
  chat() {
    tone({ freq: 1150, dur: 0.045, type: 'sine', gain: 0.18 });
  },

  /* ---- 回合结算 ---- */

  // 一回合正常收尾（所有人都猜出来了）：中性的一声，别跟「拿奖杯」抢戏
  roundEnd() {
    tone({ freq: 659, dur: 0.12, type: 'sine', gain: 0.42 });
    tone({ freq: 523, dur: 0.18, type: 'sine', gain: 0.36, delay: 0.1 });
  }
};

/* ------------------------------------------------------------ 对外的 play */

/**
 * 播放一个音效。
 *
 * 静音时**直接返回**，连 AudioContext 都不创建 —— 静音用户不该被拉起一个
 * 音频线程。反过来，只要开着音效，第一次 play 就会顺手把 ctx 建出来并解锁。
 *
 * @param {string} name BANK 里的键
 * @param {object} [opt]  少数音效接受的参数（如 tickUrgent 的 n）
 * @returns {boolean} 是否真的播了
 */
function play(name, opt) {
  if (!enabled) return false;
  const fn = BANK[name];
  if (!fn) return false;

  // 还没解锁（用户没做过任何手势）→ 先 resume，本次仍尝试播。
  // 浏览器通常会在同一个 tick 里放行，赌一把比静默丢失好。
  if (!unlocked) unlock();

  try {
    fn(opt || {});
  } catch (e) {
    // 音频出问题绝不能让游戏崩：静默吞掉
    return false;
  }
  return true;
}

const SFX = {
  play,
  setEnabled,
  isEnabled,
  toggle,
  setVolume,
  getVolume,
  unlock,
  BANK,
  // 测试用：音效名字清单（UI 上的「试听」按钮也靠它遍历）
  names() { return Object.keys(BANK); },
  /**
   * 诊断用：AudioContext 的现状（没建过就是 null）。
   * 「静音时不该建 context」「手势后该解锁」这类性质只能从这里验 ——
   * 光数「新建了几个」会被执行顺序骗到（context 是单例、建过就复用）。
   */
  ctxState() { return ctx ? ctx.state : null; },
  hasCtx() { return !!ctx; }
};

if (typeof window !== 'undefined') window.ChaSFX = SFX;
if (typeof module === 'object' && module.exports) module.exports = SFX;
