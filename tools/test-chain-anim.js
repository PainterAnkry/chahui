/**
 * ★ 2.0.9 接龙「逐笔回放」的节奏：**不能啪的一下跳到成图**。
 *
 * 用户的原话：「接龙回放还是存在一点问题，笔迹回放时间不够的时候，要自适应进行倍速播放，
 * 不能啪的一下就跳到成图了」。
 *
 * 病根：crDrawTo 里的帧预算写死 `frames = min(笔数, 18)`。一张 40 笔的图只切 18 个时间片，
 * 到点（animMs）时前 18 笔还在慢慢长，剩下 22 笔由 crFinishAnim **一次全补上** ——
 * 屏幕上就是「前面慢慢来，最后啪一下全出来」。
 * 现在帧预算跟着笔数走（每一笔都有自己的时间片），窗口紧就每拍多画几笔（= 倍速），
 * 到点还没画完时也有「加速尾巴」（每 60ms 至少补一笔，最多 320ms），绝不一次贴完。
 *
 * 这个测试不需要服务端计时（也不跑整局游戏）：直接喂一串假笔迹 + 一段时长，
 * 然后按 80~120ms 采样 `S.cr.anim.done`，看它是不是**一笔一笔**长上去的。
 *
 * 用法: node tools/test-chain-anim.js [http://127.0.0.1:8440]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '回放节奏');
  await page.fill('#newRoomName', '逐笔回放验收');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(200);

  const hooked = await page.evaluate(() => !!(window.ChaApp.chainAnimDebug && window.ChaApp.chainAnimDebug.start));
  check('（铺垫）拿到了逐笔回放的调试入口', hooked);
  if (!hooked) {
    console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
    await browser.close();
    process.exit(1);
  }

  /** 造 n 笔假笔迹（真笔迹对象：engine.newStroke 出来的，replayStampOne 认得） */
  const mkStrokes = n => page.evaluate(cnt => {
    const e = window.ChaApp.engine, l = e.activeLayer();
    const out = [];
    for (let i = 0; i < cnt; i++) {
      const s = e.newStroke({
        id: 'an' + i, layerId: l.id, tool: 'brush', color: '#111111',
        size: 8, opacity: 1, hardness: 1, local: true
      });
      s.points = [[60 + i * 7, 150, 0.5], [60 + i * 7, 650, 0.5]];
      s.seq = i + 1;
      out.push(s);
    }
    window.__anStrokes = out;
    return out.length;
  }, n);

  /** 跑一段逐笔回放并采样 done 的推进过程 */
  const runAnim = async (n, animMs, sampleMs) => {
    await mkStrokes(n);
    await page.evaluate(ms => window.ChaApp.chainAnimDebug.start(window.__anStrokes, ms), animMs);
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < animMs + 900) {
      const s = await page.evaluate(() => {
        const a = window.ChaApp.chainAnimDebug.state();
        return { done: a.done | 0, steps: a.steps | 0, fin: !!a.finished };
      });
      // ⚠ 收工时刻要按**外面这口钟**算：crFinishAnim 会把 a.startAt 重置成「画完这一刻」
      //   （定格时间从画完起算），拿 a.startAt 去量只能得到 0。
      s.el = Date.now() - t0;
      samples.push(s);
      if (s.fin) break;
      await sleep(sampleMs);
    }
    await page.evaluate(() => window.ChaApp.chainAnimDebug.stop());
    await sleep(120);
    return samples;
  };

  /** 采样序列里「一次最多长了几笔」——旧代码的尾巴一次性补完会在这里露出马脚 */
  const maxJump = samples => {
    let mx = 0, prev = 0;
    for (const s of samples) { mx = Math.max(mx, s.done - prev); prev = s.done; }
    return mx;
  };
  const finishAt = samples => {
    const f = samples.find(s => s.fin);
    return f ? f.el : Infinity;
  };

  /* ---------- 1. 40 笔 / 3 秒：一笔一笔长出来 ---------- */
  console.log('\n[1] 40 笔 · 3 秒（窗口够）');
  let s1 = await runAnim(40, 3000, 100);
  let jump1 = maxJump(s1);
  console.log('  done 采样: ' + s1.map(s => s.done).join(' → '));
  check('★ 40 笔全部画完', s1[s1.length - 1].done === 40, s1[s1.length - 1].done);
  check('★ 是「一笔一笔长出来」，不是最后一次性贴上去（两次采样之间最多 +6 笔）',
    jump1 <= 6, '最大一次 +' + jump1 + ' 笔');
  check('★ 长出来的次数够多（≥ 8 次推进，不是两三下就完了）',
    s1[s1.length - 1].steps >= 8, s1[s1.length - 1].steps + ' 次');
  check('★ 没有提前收工（定格时间 ≈ 窗口时长，不是几百毫秒就跳到成图）',
    finishAt(s1) >= 2400, finishAt(s1) + 'ms');

  /* ---------- 2. 40 笔 / 0.7 秒：窗口紧 → 倍速，但仍然是逐笔 ---------- */
  console.log('\n[2] 40 笔 · 0.7 秒（窗口紧，必须倍速）');
  let s2 = await runAnim(40, 700, 60);
  let jump2 = maxJump(s2);
  console.log('  done 采样: ' + s2.map(s => s.done).join(' → '));
  check('★ 窗口再紧也全画完（自适应倍速，不是画一半就定稿）', s2[s2.length - 1].done === 40, s2[s2.length - 1].done);
  check('★ 一次最多也只长 10 笔（旧代码在这里会一次补 22 笔）',
    jump2 <= 10, '最大一次 +' + jump2 + ' 笔');
  check('★ 至少分成 4 拍画完（不是一帧贴图）', s2[s2.length - 1].steps >= 4, s2[s2.length - 1].steps + ' 次');
  check('★ 倍速也把窗口用满了（不是提前几百毫秒就定稿）', finishAt(s2) >= 500, finishAt(s2) + 'ms');
  check('★ 收工时间贴着窗口（≤ 窗口 + 加速尾巴 320ms + 采样余量）',
    finishAt(s2) <= 700 + 320 + 400, finishAt(s2) + 'ms');

  /* ---------- 3. 6 笔 / 2.4 秒：慢放也得是一笔一笔 ---------- */
  console.log('\n[3] 6 笔 · 2.4 秒（窗口宽 → 慢放）');
  const s3 = await runAnim(6, 2400, 100);
  const jump3 = maxJump(s3);
  console.log('  done 采样: ' + s3.map(s => s.done).join(' → '));
  check('★ 6 笔全画完', s3[s3.length - 1].done === 6, s3[s3.length - 1].done);
  check('★ 慢放时也是一笔一笔（两次采样之间最多 +1 笔）', jump3 <= 1, '最大一次 +' + jump3 + ' 笔');
  check('★ 慢放用了整段窗口', finishAt(s3) >= 1900, finishAt(s3) + 'ms');

  /* ---------- 4. 100 笔 / 3 秒：比 18 帧多得多，节拍仍然均匀 ---------- */
  console.log('\n[4] 100 笔 · 3 秒（笔数远超旧的 18 帧上限）');
  const s4 = await runAnim(100, 3000, 100);
  const jump4 = maxJump(s4);
  const last = s4[s4.length - 1];
  console.log('  done 采样: ' + s4.map(s => s.done).join(' → '));
  check('★ 100 笔全部画完', last.done === 100, last.done);
  check('★ 最大的那一跳 ≤ 12 笔（旧代码：18 帧之后一次补 82 笔）', jump4 <= 12, '最大一次 +' + jump4 + ' 笔');
  check('★ 推进次数 ≥ 15 次', last.steps >= 15, last.steps + ' 次');

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
