/**
 * 茶绘 · 作画过程回放（真浏览器端到端）
 *
 * test-browser.js 里只验了「进入回放 / 退出回放 / 笔数 ≥ 3」，这里补上回放本身：
 *   - 时间轴按真实 ts/te 排布；能定位、能倒带；**末帧与成品逐像素级一致**
 *   - **笔内逐段生长**（不再是「整笔弹入」）—— 这是这个特性值不值钱的地方
 *   - 回放是只读模式：落笔一律不进共享文档
 *   - 切后台再回来不会一步跳到结尾
 *   - 作者标注、导出回放视频（录制源必须是回放画面，不是静止的成品）
 *   - **洋葱皮**：前后各几笔的残影、浓度档位、只染成品本来有墨迹的地方、
 *     只在回放里出现、偏好持久化（含开机读回）
 *
 * ⚠ 时长（`replayDuration()`）会随着**新画的笔**变化，别在第 2 节取一次就一路用到底：
 * 后面每画一笔，时间轴就往后长一截，拿旧的数定位会**播不到最后几笔**，
 * 于是「末帧 = 成品」这类比对必然对不上（看着像回放坏了，其实是测试拿错了数）。
 *
 * 用法: node tools/test-replay.js [http://127.0.0.1:8453]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://127.0.0.1:8453';
const OUT = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' \u2192 ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' \u2192 ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createRoom(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 10000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name + '的茶绘室');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined && a.engine.layers.length > 0;
  }, { timeout: 12000 });
  return page.evaluate(() => window.ChaApp.state.room.id);
}

/**
 * 落一笔，并**确认这一笔真的开始了**。返回是否真的落下。
 *
 * ⚠ 取点必须走**文档坐标**换算，不能按 `#view` 的比例直接取。
 * 文档被缩放到不满视口时会留边（实测：文档 1600×1000 在 878×796 的视口里只有
 * 784×490，scale 0.49、偏移 tx/ty = 48/154），文档的可见 y 带只有视口的 0.193~0.809。
 * 按视口比例取 y=0.18 就算到了文档上沿之外，而 app.js 里有一条
 * 「文档坐标越界就直接 return」的**静默**丢弃 —— 现象是「画了但什么都没发生」，
 * 既不报错也不抬手，看着特别像同步丢包。所有落笔测试都按 docToScreen 取点。
 *
 * ⚠ 另外：Playwright 的合成鼠标事件只送给当前活动页面，非活动页面收得到
 * pointerdown（坐标为真）但收不到后续 pointermove → 那一笔 0 个落点被当空笔取消。
 * 所以这里落笔后回读 `engine.pending`，没起来就 bringToFront 重试。
 */
async function drawStroke(page, o) {
  const opts = o || {};
  const tries = opts.retry === false ? 1 : 3;
  for (let attempt = 1; attempt <= tries; attempt++) {
    await page.bringToFront();
    await sleep(120);
    const pts = await page.evaluate(function (oo) {
      const e = window.ChaApp.engine;
      const rect = document.querySelector('#canvasWrap').getBoundingClientRect();
      const m = (fx, fy) => {
        const s = e.docToScreen(e.width * fx, e.height * fy);
        return { x: rect.left + s.x, y: rect.top + s.y };
      };
      return { a: m(oo.x0, oo.y0), b: m(oo.x1, oo.y1) };
    }, opts);
    const x0 = pts.a.x, y0 = pts.a.y, x1 = pts.b.x, y1 = pts.b.y;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const started = await page.evaluate(() => window.ChaApp.engine.pending.size > 0);
    if (started) {
      const steps = 26;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 3) * 22);
      }
      await page.mouse.up();
      await sleep(160);
      return true;
    }
    await page.mouse.up();
    await sleep(250);
  }
  return false;
}

/**
 * 页面里注入的取样工具。
 * 注意：回放画布**先铺满背景色**，所以墨迹只能按「与背景色的差」来数；
 * 早先按 alpha 数过一次，结果恒等于整块画布（背景不透明），白高兴一场。
 */
const PAGE_HELPERS = `
  function bgOf(eng) {
    var s = String(eng.background || '#ffffff').replace('#', '');
    if (s.length === 3) s = s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
    return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
  }
  function inkOfData(d, i, bg, tol) {
    var t = tol || 10;
    return Math.abs(d[i] - bg[0]) > t || Math.abs(d[i + 1] - bg[1]) > t || Math.abs(d[i + 2] - bg[2]) > t;
  }
  function replayInk(tol) {
    var eng = window.ChaApp.engine;
    if (!eng.replayCanvas) return -1;
    var bg = bgOf(eng), c = eng.replayCanvas;
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 0; i < d.length; i += 4 * 7) if (inkOfData(d, i, bg, tol)) n++;
    return n;
  }
  /**
   * 数「偏暖 / 偏冷」的像素 —— 用来验洋葱皮残影。
   *
   * 判据是**彩度**（最大通道 - 最小通道）而不是「红减蓝 > 40」那种绝对差：
   * 残影是叠在画面上的半透明色，叠在最白或最黑的地方只剩一点点偏色，
   * 用绝对差会漏掉 2、3 层那些更淡的残影，断言就变成「1 笔和 3 笔一样多」。
   * 底色与未染色的笔迹是灰的（三通道相等），彩度 0，不会误计。
   */
  function tintOfCanvas(c) {
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var warm = 0, cool = 0;
    for (var i = 0; i < d.length; i += 4 * 7) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      var chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma < 14) continue;
      if (r >= b) warm++; else cool++;
    }
    return { warm: warm, cool: cool };
  }
  function replayTint() {
    var eng = window.ChaApp.engine;
    if (!eng.replayCanvas) return { warm: -1, cool: -1 };
    return tintOfCanvas(eng.replayCanvas);
  }
  function viewTint() {
    var c = document.querySelector('#view');
    if (!c) return { warm: -1, cool: -1 };
    return tintOfCanvas(c);
  }
  /**
   * 残影有没有「漏到空白处」。
   * 拿末帧的回放画面去比成品文档：成品里是纯背景的地方，回放画面也必须还是纯背景 ——
   * 这才叫「只给已有墨迹上色」。用像素计数比「掩码一致率」稳：
   * 染色会把半透明的边缘像素在三通道上各推一点，任何阈值口径都会被推着走，
   * 而「空白处有没有东西」这件事与阈值无关。
   */
  function replayLeak() {
    var eng = window.ChaApp.engine;
    var bg = bgOf(eng), W = eng.width, H = eng.height;
    var R = eng.replayCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    var D = eng.renderDocument({}).ctx.getImageData(0, 0, W, H).data;
    var leak = 0, both = 0;
    for (var i = 0; i < R.length; i += 4 * 7) {
      var rInk = inkOfData(R, i, bg), dInk = inkOfData(D, i, bg);
      if (rInk && !dInk) leak++;
      if (rInk && dInk) both++;
    }
    return { leak: leak, both: both };
  }
`;

async function replayInk(page, tol) {
  return page.evaluate(new Function(PAGE_HELPERS + 'return replayInk(' + (tol || 10) + ');'));
}

async function replayLeak(page) {
  return page.evaluate(new Function(PAGE_HELPERS + 'return replayLeak();'));
}

async function replayTint(page) {
  return page.evaluate(new Function(PAGE_HELPERS + 'return replayTint();'));
}

async function viewTint(page) {
  return page.evaluate(new Function(PAGE_HELPERS + 'return viewTint();'));
}

/** 回放画布 vs 成品文档：墨迹掩码一致率 */
async function replayVsDoc(page) {
  return page.evaluate(new Function(PAGE_HELPERS + `
    var eng = window.ChaApp.engine;
    var W = eng.width, H = eng.height, bg = bgOf(eng);
    var A = eng.replayCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    var B = eng.renderDocument({}).ctx.getImageData(0, 0, W, H).data;
    var same = 0, tot = 0, aInk = 0, bInk = 0;
    for (var i = 0; i < A.length; i += 4 * 5) {
      var a = inkOfData(A, i, bg), b = inkOfData(B, i, bg);
      if (a) aInk++;
      if (b) bInk++;
      tot++;
      if (a === b) same++;
    }
    return { ratio: same / tot, aInk: aInk, bInk: bInk, tot: tot };
  `));
}

async function seek(page, t) {
  return page.evaluate(function (tt) { return window.ChaApp.engine.replaySeek(tt); }, t);
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await ctx.newPage();
  const B = await ctx.newPage();
  const errs = [];
  A.on('pageerror', e => errs.push('[A] ' + e.message));
  B.on('pageerror', e => errs.push('[B] ' + e.message));
  A.on('console', m => { if (m.type() === 'error') errs.push('[A:c] ' + m.text()); });
  B.on('console', m => { if (m.type() === 'error') errs.push('[B:c] ' + m.text()); });

  // B 必须有**自己的名字**：同一个 browserContext 共享 localStorage，
  // 不设的话 B 会读到 A 存进去的名字（`chahu.name`），两边同名 ——
  // 作者标注那条断言就变成恒真了。
  await B.addInitScript(() => { try { localStorage.setItem('chahu.name', '茶友乙'); } catch (e) { /* ignore */ } });

  await A.goto(BASE, { waitUntil: 'domcontentloaded' });
  await B.goto(BASE, { waitUntil: 'domcontentloaded' });
  const room = await createRoom(A, '回放测试');
  await B.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'load' });
  await B.waitForFunction(() => window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(700);

  console.log('\n[1] 准备：A 画 3 笔 + B 画 1 笔（笔间留真实间隔）');
  const d1 = await drawStroke(A, { x0: 0.12, y0: 0.18, x1: 0.78, y1: 0.24 });
  await sleep(600);
  const d2 = await drawStroke(A, { x0: 0.12, y0: 0.38, x1: 0.78, y1: 0.44 });
  await sleep(600);
  const d3 = await drawStroke(B, { x0: 0.16, y0: 0.72, x1: 0.82, y1: 0.84 });
  await sleep(600);
  const d4 = await drawStroke(A, { x0: 0.12, y0: 0.58, x1: 0.78, y1: 0.64 });
  await sleep(800);
  ok('四次落笔都真的落下了', d1 && d2 && d3 && d4, [d1, d2, d3, d4].join(','));

  const meta = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const byUser = {};
    e.strokes.forEach(s => { byUser[s.userId] = (byUser[s.userId] || 0) + 1; });
    return {
      n: e.strokes.length, meId: e.meId, byUser: byUser,
      allHaveTs: e.strokes.every(s => s.ts > 0),
      allHaveTe: e.strokes.every(s => s.te > s.ts)
    };
  });
  const metaB = await B.evaluate(() => {
    const e = window.ChaApp.engine;
    const byUser = {};
    e.strokes.forEach(s => { byUser[s.userId] = (byUser[s.userId] || 0) + 1; });
    return { n: e.strokes.length, meId: e.meId, byUser: byUser };
  });
  console.log('     A 端: ' + JSON.stringify(meta.byUser) + '   B 端: ' + JSON.stringify(metaB.byUser));
  ok('A 端共 4 笔', meta.n === 4, 'n=' + meta.n);
  ok('B 端共 4 笔', metaB.n === 4, 'n=' + metaB.n);
  ok('A 端自己名下有 3 笔', (meta.byUser[meta.meId] || 0) === 3, JSON.stringify(meta.byUser));
  ok('B 端自己名下有 1 笔', (metaB.byUser[metaB.meId] || 0) === 1, JSON.stringify(metaB.byUser));
  ok('每笔都有起始时刻 ts', meta.allHaveTs === true);
  ok('每笔都有结束时刻 te（回放靠它算「一笔画了多久」）', meta.allHaveTe === true);

  console.log('\n[2] 进入回放：时间轴元数据');
  await A.bringToFront();
  await A.click('#btnReplay');
  await sleep(250);
  await A.click('#btnReplayToggle');   // 立刻暂停，后面由脚本手动定位
  await sleep(150);
  const ent = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    return {
      mode: e.replayMode,
      bar: !document.querySelector('#replayBar').classList.contains('hidden'),
      n: e.replayStrokes.length,
      dur: e.replayDuration(),
      total: e.replayTotal,
      playing: window.ChaApp.state.replay.playing,
      offs: e.replayStrokes.map(s => s._roff),
      durs: e.replayStrokes.map(s => s._rdur)
    };
  });
  ok('进入回放模式', ent.mode === true);
  ok('回放条显示', ent.bar === true);
  ok('回放笔迹数 = 4', ent.n === 4, 'n=' + ent.n);
  ok('总时长 > 1.5s', ent.dur > 1500, 'dur=' + Math.round(ent.dur));
  ok('已暂停（脚本手动定位）', ent.playing === false);
  let offMonotone = true;
  for (let i = 1; i < ent.offs.length; i++) if (ent.offs[i] < ent.offs[i - 1]) offMonotone = false;
  ok('各笔起跑点单调不减', offMonotone, ent.offs.map(Math.round).join(','));
  ok('每笔时长都夹在 [120, 2600]', ent.durs.every(d => d >= 120 && d <= 2600),
    ent.durs.map(Math.round).join(','));
  // 时间轴总长 ≥ 各笔时长之和：作者真停下来的空档是**故意保留**的
  // （回放要能看出「这里他想了 10 秒」），所以总长恒等于末笔起跑点 + 末笔时长。
  const sumDur = ent.durs.reduce((a, b) => a + b, 0);
  ok('时间轴总长 ≥ 各笔时长之和（真实停顿被保留）', ent.total >= sumDur - 1,
    ent.total + ' vs ' + sumDur);
  ok('时间轴总长 = 末笔起跑点 + 末笔时长',
    Math.abs(ent.total - (ent.offs[ent.offs.length - 1] + ent.durs[ent.durs.length - 1])) < 1,
    ent.total + ' vs ' + (ent.offs[ent.offs.length - 1] + ent.durs[ent.durs.length - 1]));

  console.log('\n[3] 笔内逐段生长（这一项以前是「整笔弹入」）');
  const s0 = await A.evaluate(() => {
    const s = window.ChaApp.engine.replayStrokes[0];
    return { off: s._roff, dur: s._rdur, pts: s.points.length };
  });
  const inside = [];
  for (const f of [0, 0.15, 0.3, 0.5, 0.7, 0.9]) {
    await seek(A, s0.off + s0.dur * f);
    await sleep(90);
    inside.push(await replayInk(A));
  }
  console.log('     第一笔窗内采样: ' + inside.join('  ') + '  （落点 ' + s0.pts + ' 个）');
  let inMono = true;
  for (let i = 1; i < inside.length; i++) if (inside[i] < inside[i - 1]) inMono = false;
  ok('笔内墨迹单调不减', inMono);
  const grown = inside.filter((v, i) => i && v > inside[i - 1]).length;
  ok('笔内出现多次增长（点级动画生效，不是整笔弹入）', grown >= 2, '增长段数=' + grown);
  ok('窗初明显少于窗末', inside[0] < inside[inside.length - 1],
    inside[0] + ' \u2192 ' + inside[inside.length - 1]);

  console.log('\n[4] 时间轴端到端扫掠');
  const dur = ent.dur;
  const samples = [];
  for (let k = 0; k <= 8; k++) {
    await seek(A, dur * k / 8 + 1);
    await sleep(90);
    samples.push(await replayInk(A));
  }
  console.log('     采样: ' + samples.join('  '));
  let mono = true;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1]) mono = false;
  ok('全程墨迹单调不减', mono);
  ok('t=0 处墨迹远少于末帧（不是一进去就满）', samples[0] < samples[samples.length - 1] * 0.5,
    samples[0] + ' vs ' + samples[samples.length - 1]);
  ok('末帧确有内容', samples[samples.length - 1] > 200, 'ink=' + samples[samples.length - 1]);

  console.log('\n[5] 末帧 = 成品');
  await seek(A, dur + 5000);
  await sleep(180);
  const cmp = await replayVsDoc(A);
  console.log('     墨迹掩码一致率 ' + (cmp.ratio * 100).toFixed(1) + '%（replay ' + cmp.aInk + ' / doc ' + cmp.bInk + '）');
  ok('末帧与成品墨迹掩码高度一致 (>92%)', cmp.ratio > 0.92, (cmp.ratio * 100).toFixed(1) + '%');

  console.log('\n[6] 倒带');
  await seek(A, 0);
  await sleep(180);
  const back = await replayInk(A);
  ok('倒回 t=0 后墨迹回到起点水平', back < samples[samples.length - 1] * 0.5,
    back + ' vs 末帧 ' + samples[samples.length - 1]);
  await seek(A, dur + 5000);
  await sleep(180);
  const again = await replayInk(A);
  ok('倒带后再前进能恢复', Math.abs(again - samples[samples.length - 1]) < samples[samples.length - 1] * 0.1,
    again + ' vs ' + samples[samples.length - 1]);

  console.log('\n[7] 播放 / 暂停 / 切后台');
  await A.selectOption('#replaySpeed', '1');
  ok('倍速切到 1x', (await A.evaluate(() => window.ChaApp.state.replay.speed)) === 1);
  await A.evaluate(() => { window.ChaApp.state.replay.t = 0; window.ChaApp.engine.replaySeek(0); });
  await A.click('#btnReplayToggle');            // 继续播放
  await sleep(500);
  const t1 = await A.evaluate(() => window.ChaApp.state.replay.t);
  await sleep(500);
  const t2 = await A.evaluate(() => window.ChaApp.state.replay.t);
  ok('播放中时间轴在推进', t2 > t1 && t1 > 0, t1.toFixed(0) + ' \u2192 ' + t2.toFixed(0));
  ok('1x 时这 0.5s 只推进了约 0.5s 时间轴（倍速真的在起作用）', (t2 - t1) < 1200,
    'Δ=' + (t2 - t1).toFixed(0));
  await A.click('#btnReplayToggle');            // 暂停
  await sleep(400);
  const t3 = await A.evaluate(() => window.ChaApp.state.replay.t);
  await sleep(400);
  const t4 = await A.evaluate(() => window.ChaApp.state.replay.t);
  ok('暂停后时间轴不动', Math.abs(t4 - t3) < 1, t3.toFixed(0) + ' \u2192 ' + t4.toFixed(0));

  // 模拟「切走标签页很久再回来」：把上一帧时刻拨回 5 秒前
  await A.click('#btnReplayToggle');            // 继续播放
  await A.evaluate(() => { window.ChaApp.state.replay.last = performance.now() - 5000; });
  await sleep(300);
  const tJump = await A.evaluate(() => window.ChaApp.state.replay.t);
  ok('切后台再回来不会一步跳到结尾（dt 已夹取）', tJump < dur * 0.6,
    't=' + Math.round(tJump) + ' / dur=' + Math.round(dur));
  await A.click('#btnReplayToggle');            // 暂停

  console.log('\n[8] 倍速');
  await A.selectOption('#replaySpeed', '12');
  ok('倍速切到 12x', (await A.evaluate(() => window.ChaApp.state.replay.speed)) === 12);
  await A.evaluate(() => { window.ChaApp.state.replay.t = 0; window.ChaApp.engine.replaySeek(0); });
  await A.click('#btnReplayToggle');
  await sleep(700);
  const adv = await A.evaluate(() => window.ChaApp.state.replay.t);
  // 时间轴总共只有几秒，12x 下 0.7s 足够跑完 —— 跑到末尾（t = dur）就算通过
  ok('12x 下 0.7s 内跑完整条时间轴', adv >= dur * 0.9,
    't=' + Math.round(adv) + ' / dur=' + Math.round(dur));
  const btnText = await A.evaluate(() => document.querySelector('#btnReplayToggle').textContent);
  ok('跑完后按钮变成「重播」', btnText === '重播', 'btn=' + btnText);

  console.log('\n[9] 回放是只读模式');
  const before = await A.evaluate(() => window.ChaApp.engine.strokes.length);
  const blocked = await drawStroke(A, { x0: 0.25, y0: 0.30, x1: 0.60, y1: 0.78, retry: false });
  const after = await A.evaluate(() => window.ChaApp.engine.strokes.length);
  ok('回放期落笔起不了笔（引擎里没有待定笔迹）', blocked === false);
  ok('回放期落笔不会进共享文档', after === before, before + ' \u2192 ' + after);
  ok('回放模式未被落笔打断', (await A.evaluate(() => window.ChaApp.engine.replayMode)) === true);
  const bStrokes = await B.evaluate(() => window.ChaApp.engine.strokes.length);
  ok('另一端也没多出笔迹', bStrokes === 4, 'B strokes=' + bStrokes);

  console.log('\n[10] 退出回放');
  await A.screenshot({ path: path.join(OUT, '20-作画过程回放.png') });
  await A.click('#btnReplayExit');
  await sleep(350);
  const ex = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const bg = [255, 255, 255];
    const d = e.renderDocument({}).ctx.getImageData(0, 0, e.width, e.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      if (Math.abs(d[i]-bg[0]) > 10 || Math.abs(d[i+1]-bg[1]) > 10 || Math.abs(d[i+2]-bg[2]) > 10) ink++;
    }
    return {
      mode: e.replayMode,
      barHidden: document.querySelector('#replayBar').classList.contains('hidden'),
      cls: document.querySelector('#stage').classList.contains('replaying'),
      strokes: e.strokes.length,
      ink: ink
    };
  });
  ok('退出后 replayMode = false', ex.mode === false);
  ok('回放条已隐藏', ex.barHidden === true);
  ok('replaying 类已摘掉', ex.cls === false);
  ok('笔迹数未变（没被回放吃掉也没多出来）', ex.strokes === 4, 'strokes=' + ex.strokes);
  ok('真实画面仍有内容', ex.ink > 200, 'ink=' + ex.ink);

  console.log('\n[11] 退出后照常能画');
  const d5 = await drawStroke(A, { x0: 0.30, y0: 0.20, x1: 0.70, y1: 0.30 });
  await sleep(600);
  const afterExit = await A.evaluate(() => window.ChaApp.engine.strokes.length);
  ok('退出后新笔迹正常记录', d5 && afterExit === 5, 'strokes=' + afterExit);
  const bGot = await B.evaluate(() => window.ChaApp.engine.strokes.length);
  ok('B 端也收到了（回放不影响同步）', bGot === 5, 'B strokes=' + bGot);

  console.log('\n[12] 作者标注（回放里看得出是谁在画）');
  await A.bringToFront();
  await A.click('#btnReplay');
  await sleep(250);
  await A.click('#btnReplayToggle');   // 暂停，改由进度条定位
  await sleep(150);
  // 走**真实路径**：拖进度条（触发 #replayRange 的 input），而不是直接调引擎 ——
  // 作者标注是挂在那个回调上的，绕过它就等于没测。
  const auth = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const el = document.querySelector('#replayAuthor');
    const nameOf = function (uid) {
      const m = (window.ChaApp.state.members || []).filter(function (x) { return x.userId === uid; })[0];
      return m ? m.name : null;
    };
    const dur = e.replayDuration();
    const seekTo = function (t) {
      const r = document.querySelector('#replayRange');
      r.value = String(Math.round(t / dur * 1000));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        shown: !el.classList.contains('hidden'),
        text: el.textContent,
        color: el.style.getPropertyValue('--author-color')
      };
    };
    const rs = e.replayStrokes;
    const out = { n: rs.length, meId: e.meId, dur: dur };
    const s0 = rs[0];
    out.first = Object.assign({ want: nameOf(s0.userId) }, seekTo(s0._roff + s0._rdur * 0.5));
    const iOther = rs.findIndex(function (s) { return s.userId !== e.meId; });
    if (iOther >= 0) {
      out.other = Object.assign({ want: nameOf(rs[iOther].userId) },
        seekTo(rs[iOther]._roff + rs[iOther]._rdur * 0.5));
    }
    // 挑最宽的一段「两笔之间」的停顿
    let bg = 0, gapT = -1;
    for (let i = 0; i + 1 < rs.length; i++) {
      const a = rs[i]._roff + rs[i]._rdur, b = rs[i + 1]._roff;
      if (b - a > bg) { bg = b - a; gapT = (a + b) / 2; }
    }
    if (gapT >= 0) out.gap = Object.assign({ width: Math.round(bg) }, seekTo(gapT));
    return out;
  });
  ok('第一笔的作者名标出来了', auth.first.shown && auth.first.text === auth.first.want,
    JSON.stringify(auth.first));
  ok('圆点带上了作者色（--author-color）', /#|rgb/.test(auth.first.color || ''),
    'color=' + auth.first.color);
  if (auth.other) {
    ok('定位到别人的笔会切成别人的名字',
      auth.other.shown && auth.other.text === auth.other.want && auth.other.text !== auth.first.text,
      JSON.stringify(auth.other));
  } else {
    ok('存在别人画的笔（用来验证切换）', false, '没找到非本人笔迹');
  }
  ok('落在两笔之间的停顿时不标作者', auth.gap && auth.gap.shown === false,
    JSON.stringify(auth.gap));

  // 截图给 README 用：挑「中点最接近全片 45%」的那一笔定位进去 ——
  // 保证画面里已经长出好几笔、而且作者标注一定在显示（随机取时间可能落在停顿里，标注是藏的）。
  await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const r = document.querySelector('#replayRange');
    const dur = e.replayDuration();
    let best = e.replayStrokes[0];
    const mid = (s) => s._roff + s._rdur / 2;
    for (const s of e.replayStrokes) {
      if (Math.abs(mid(s) - dur * 0.45) < Math.abs(mid(best) - dur * 0.45)) best = s;
    }
    const t = best._roff + best._rdur * 0.6;
    r.value = String(Math.round(t / dur * 1000));
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(220);
  await A.screenshot({ path: path.join(OUT, '20-作画过程回放.png') });

  console.log('\n[13] 导出回放视频');
  const expApi = await A.evaluate(() => ({
    fn: typeof window.ChaApp.exportReplayVideo,
    btn: !!document.querySelector('#btnReplayExport')
  }));
  ok('导出回放视频的接口已暴露（文件菜单里那一项也走它）', expApi.fn === 'function', expApi.fn);
  ok('回放条上有「导出视频」按钮', expApi.btn === true);

  // 关键不变量：录的是**回放画布**（随时间变），不是静止的成品。
  // 现成的 renderInto 走 renderDocument —— 用它录出来只有一张完成图，这个断言就是防这个。
  await A.click('#btnReplayExit');
  await sleep(250);
  const src = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    e.setReplayMode(true);
    e.prepareReplay();
    const c = document.createElement('canvas');
    c.width = e.width; c.height = e.height;
    const ctx = c.getContext('2d');
    const bgHex = String(e.background || '#ffffff').replace('#', '');
    const bg = [parseInt(bgHex.slice(0, 2), 16), parseInt(bgHex.slice(2, 4), 16), parseInt(bgHex.slice(4, 6), 16)];
    const ink = () => {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        if (Math.abs(d[i] - bg[0]) > 10 || Math.abs(d[i + 1] - bg[1]) > 10 || Math.abs(d[i + 2] - bg[2]) > 10) n++;
      }
      return n;
    };
    const dur = e.replayDuration();
    e.replaySeek(0); e.replayInto(ctx); const at0 = ink();
    e.replaySeek(dur + 5000); e.replayInto(ctx); const atEnd = ink();
    const d = e.renderDocument({}).ctx.getImageData(0, 0, e.width, e.height).data;
    let docInk = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      if (Math.abs(d[i] - bg[0]) > 10 || Math.abs(d[i + 1] - bg[1]) > 10 || Math.abs(d[i + 2] - bg[2]) > 10) docInk++;
    }
    e.setReplayMode(false);
    return { at0: at0, atEnd: atEnd, docInk: docInk };
  });
  ok('回放画面能画到离屏画布（录制源可用）', src.atEnd > 0, JSON.stringify(src));
  ok('t=0 的录制帧远少于末帧（录的是过程，不是一张成品）',
    src.at0 < src.atEnd * 0.5, JSON.stringify(src));
  ok('末帧的墨迹量与成品一致（录到底不会缺内容）',
    Math.abs(src.atEnd - src.docInk) <= Math.max(3, src.docInk * 0.05), JSON.stringify(src));

  // 真点按钮：应自动进回放、开始录制，播完自动收工。
  // 注意「导出视频」按钮**长在回放条上**，条不显示就点不到 —— 所以先进回放。
  // 不去回放直接导出的入口是文件菜单 → 导出 → 导出回放视频（那条走同一个函数）。
  await A.bringToFront();
  await A.click('#btnReplay');
  await sleep(250);
  await A.click('#btnReplayToggle');            // 先暂停
  await A.selectOption('#replaySpeed', '4');
  await A.click('#btnReplayExport');
  await sleep(400);
  const rec = await A.evaluate(() => {
    const r = window.ChaApp.state.recording;
    return {
      has: !!r, kind: r && r.kind,
      mode: window.ChaApp.engine.replayMode,
      btn: document.querySelector('#btnReplayExport').textContent
    };
  });
  ok('点「导出视频」自动进入回放并开始录制',
    rec.has === true && rec.kind === 'replay' && rec.mode === true, JSON.stringify(rec));
  ok('按钮变成「录制中…」', rec.btn === '录制中…', rec.btn);
  const expDur = await A.evaluate(() => window.ChaApp.engine.replayDuration());
  await sleep(Math.ceil(expDur / 4) + 2500);
  const recDone = await A.evaluate(() => ({
    rec: !!window.ChaApp.state.recording,
    btn: document.querySelector('#btnReplayExport').textContent,
    t: window.ChaApp.state.replay.t,
    dur: window.ChaApp.engine.replayDuration()
  }));
  ok('播完后自动停止录制', recDone.rec === false, JSON.stringify(recDone));
  ok('播到了末尾', recDone.t >= recDone.dur - 1, JSON.stringify(recDone));
  ok('按钮恢复成「导出视频」', recDone.btn === '导出视频', recDone.btn);

  console.log('\n[14] 洋葱皮：回放时把前后几笔染成残影');
  const onionApi = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const sel = document.querySelector('#onionCount');
    return {
      btn: !!document.querySelector('#btnReplayOnion'),
      sel: !!sel,
      selHidden: !!sel && sel.classList.contains('hidden'),
      on: e.onion.on,
      api: typeof window.ChaApp.toggleOnion,
      inMenu: window.ChaMenu.actions().some(a => a.id === 'view.onion'),
      key: window.ChaMenu.keyOf('view.onion')
    };
  });
  ok('回放条上有「洋葱皮」开关与「前后几笔」选择', onionApi.btn === true && onionApi.sel === true);
  ok('默认关着（不打扰普通回放）', onionApi.on === false && onionApi.selHidden === true, JSON.stringify(onionApi));
  ok('接口已暴露（菜单那一项走同一个函数）', onionApi.api === 'function', String(onionApi.api));
  ok('菜单「视图」里有这一项、并带快捷键', onionApi.inMenu === true && !!onionApi.key, 'key=' + onionApi.key);

  // 定位到第 3 笔中点：此刻「前影」和「后影」都有笔，两边都能验
  const onionT = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const r = document.querySelector('#replayRange');
    const dur = e.replayDuration();
    const s = e.replayStrokes[2];
    const t = s._roff + s._rdur * 0.5;
    r.value = String(Math.round(t / dur * 1000));
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return { t: t, n: e.replayStrokes.length };
  });
  ok('这一路攒下的 5 笔全在回放时间轴上', onionT.n === 5, 'n=' + onionT.n);
  const pos0 = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    return {
      base: e.replayCursor, playing: !!e.replayCurrent(), n: e.replayStrokes.length,
      offs: e.replayStrokes.map(s => Math.round(s._roff))
    };
  });
  console.log('     定位: ' + JSON.stringify(pos0));
  ok('定位在「正在画第 3 笔」的中间（前影后影都有笔）',
    pos0.base === 2 && pos0.playing === true, JSON.stringify(pos0));

  const off1 = await replayTint(A);
  console.log('     洋葱皮关：暖 ' + off1.warm + ' · 冷 ' + off1.cool);

  await A.bringToFront();
  await A.click('#btnReplayOnion');
  await sleep(250);
  const on1 = await A.evaluate(() => ({
    on: window.ChaApp.engine.onion.on,
    active: document.querySelector('#btnReplayOnion').classList.contains('active'),
    shown: !document.querySelector('#onionCount').classList.contains('hidden'),
    pref: localStorage.getItem('chahu.onion')
  }));
  const onTint = await replayTint(A);
  console.log('     洋葱皮开：暖 ' + onTint.warm + ' · 冷 ' + onTint.cool);
  ok('点开关后引擎里洋葱皮 = 开', on1.on === true);
  ok('按钮高亮、并露出「前后几笔」', on1.active === true && on1.shown === true, JSON.stringify(on1));
  ok('开关状态记进偏好（chahu.onion=1）', on1.pref === '1', String(on1.pref));
  ok('出现暖色残影（刚画完的那几笔）', onTint.warm > off1.warm + 200, off1.warm + ' → ' + onTint.warm);
  ok('出现冷色残影（马上要画的笔）', onTint.cool > off1.cool + 200, off1.cool + ' → ' + onTint.cool);

  // 菜单里配了 Ctrl+Shift+K，这条路也走一遍（光有按钮不算接线完整）
  await A.keyboard.press('Control+Shift+K');
  await sleep(250);
  ok('Ctrl+Shift+K 能关掉洋葱皮', (await A.evaluate(() => window.ChaApp.engine.onion.on)) === false);
  await A.keyboard.press('Control+Shift+K');
  await sleep(250);
  ok('再按一次又开回来', (await A.evaluate(() => window.ChaApp.engine.onion.on)) === true);

  console.log('\n[15] 「前后几笔」真的在起作用');
  await A.selectOption('#onionCount', '1');
  await sleep(250);
  const c1 = await replayTint(A);
  await A.selectOption('#onionCount', '3');
  await sleep(250);
  const c3 = await replayTint(A);
  console.log('     前后 1 笔: ' + JSON.stringify(c1) + '\n     前后 3 笔: ' + JSON.stringify(c3));
  ok('3 笔的暖色残影面积大于 1 笔', c3.warm > c1.warm, c1.warm + ' → ' + c3.warm);
  ok('3 笔的冷色残影面积大于 1 笔', c3.cool > c1.cool, c1.cool + ' → ' + c3.cool);
  ok('「前后几笔」记进偏好', (await A.evaluate(() => localStorage.getItem('chahu.onion.n'))) === '3');
  // 留一张带洋葱皮的图，方便人眼复核「暖=刚画完、冷=将画」是不是这么回事
  await A.screenshot({ path: path.join(OUT, '21-回放洋葱皮.png') });

  console.log('\n[16] 残影只是上色，不往画面里加内容');
  // ⚠ 这里必须**重新取一次时长**：第 2 节那个 dur 是只有 4 笔时算的，
  // 而第 11 节又画了一笔，新笔的起跑点在 11s 之后 —— 拿旧 dur 定位根本播不到它，
  // 末帧就「少了最后一笔」，比对成品必然对不上。
  const endT = await A.evaluate(() => window.ChaApp.engine.replayDuration()) + 5000;
  await seek(A, endT);
  await sleep(200);
  const leak = await replayLeak(A);
  const tintEnd = await replayTint(A);
  ok('末帧开着洋葱皮时确实带残影', tintEnd.warm > 0, JSON.stringify(tintEnd));
  ok('末帧已经播到最后一笔（残影之外的内容和成品同量级）',
    leak.both > 1200, JSON.stringify(leak));
  // 会有十几像素级的「漏」：笔迹最外圈抗锯齿边缘覆盖率不到 4%，在成品里几乎等于背景，
  // 被残影染一下就把 g/b 拉低到越过「与背景的差 > 10」这条线 —— 这是判据的边界效应。
  // 真「残影画到空白处」是成百上千像素级的量级，所以按比例设阈。
  ok('残影只染在成品本来有墨迹的地方（漏到空白处的在 1% 以内）',
    leak.leak <= Math.max(20, leak.both * 0.01), JSON.stringify(leak));

  await A.click('#btnReplayOnion');            // 关
  await sleep(250);
  const tintEnd2 = await replayTint(A);
  const cmpPlain = await replayVsDoc(A);
  ok('关掉后残影完全消失', tintEnd2.warm < 5 && tintEnd2.cool < 5, JSON.stringify(tintEnd2));
  ok('关着时末帧仍然等于成品', cmpPlain.ratio > 0.92, (cmpPlain.ratio * 100).toFixed(1) + '%');
  ok('关掉后偏好记为 0', (await A.evaluate(() => localStorage.getItem('chahu.onion'))) === '0');

  console.log('\n[17] 残影只在回放里出现');
  await A.click('#btnReplayOnion');            // 再开着，回到回放中段
  await sleep(200);
  await seek(A, onionT.t);
  await sleep(250);
  const vIn = await viewTint(A);
  ok('回放中视图上能看到残影（回放画面就是视图的来源）', vIn.warm + vIn.cool > 0, JSON.stringify(vIn));
  await A.click('#btnReplayExit');
  await sleep(400);
  const vOut = await viewTint(A);
  console.log('     退出回放前后: ' + JSON.stringify(vIn) + ' → ' + JSON.stringify(vOut));
  ok('退出回放后画布上一点都不剩',
    vOut.warm + vOut.cool < Math.max(20, (vIn.warm + vIn.cool) * 0.1), JSON.stringify(vOut));
  ok('开关偏好留着（没被退出回放清掉）',
    (await A.evaluate(() => localStorage.getItem('chahu.onion'))) === '1');

  // 再进一次回放：洋葱皮应该还是开着的（进出回放不该把引擎里的状态重置掉）
  await A.click('#btnReplay');
  await sleep(300);
  await A.click('#btnReplayToggle');
  await sleep(150);
  const reOn = await A.evaluate(() => ({
    on: window.ChaApp.engine.onion.on,
    active: document.querySelector('#btnReplayOnion').classList.contains('active'),
    shown: !document.querySelector('#onionCount').classList.contains('hidden')
  }));
  ok('再进回放洋葱皮还是开着的', reOn.on === true && reOn.active === true && reOn.shown === true,
    JSON.stringify(reOn));

  // 新开一个页面（同一个浏览器上下文 = 同一份 localStorage）：偏好要在**开机时**被读回来。
  // 这条专门守 boot() 里那句 applyOnion —— 只测 localStorage 的话，那句删了也照样过。
  const C = await ctx.newPage();
  await C.goto(BASE, { waitUntil: 'domcontentloaded' });
  await C.waitForFunction(() => window.ChaApp && window.ChaApp.engine, { timeout: 12000 });
  const bootPref = await C.evaluate(() => ({
    on: window.ChaApp.engine.onion.on,
    count: window.ChaApp.engine.onion.before,
    active: document.querySelector('#btnReplayOnion').classList.contains('active')
  }));
  await C.close();
  ok('新开的页面开机就把偏好读回来了（洋葱皮=开，前后 3 笔）',
    bootPref.on === true && bootPref.count === 3 && bootPref.active === true, JSON.stringify(bootPref));

  console.log('\n[18] 运行期报错');
  ok('无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) console.log('  失败: \n    - ' + failures.join('\n    - '));
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
