/**
 * 安卓端（窄屏）游戏模式显示 · 冒烟测试
 *
 * 守的是「游戏模式在手机上显示正不正常」：
 *  1) ≡ 菜单里能点「游戏」开局面板，面板在 390px 视口里完整可见
 *  2) 开局后进入选词阶段：画手的选词弹窗完整可见、能选词
 *  3) 游戏条 #gameHud 出现、有阶段倒计时，且不压工具箱 / 底部快捷条
 *  4) HUD 上的「计分」「结束游戏」在窄屏可点（计分板弹出 / 游戏退回自由画）
 *
 * 用法：node tools/test-narrow-game.js [基地址]（默认 http://127.0.0.1:8441）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { chromium } = require('./pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8441';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 元素矩形 + 视口内可见性 */
const rectOf = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    x: r.x, y: r.y, w: r.width, h: r.height,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
    inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
  };
}, sel);
const overlap = (a, b) => a && b &&
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* 手机端（房主，390×844 触屏 + 安卓壳桩）+ 桌面端（第二个玩家） */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2
  });
  const M = await mctx.newPage();
  const errors = [];
  M.on('pageerror', e => errors.push(e.message));
  // 注意：这里刻意不加 Capacitor 桩 —— 加了桩房主会把房间开到公网中继，
  // 本地服务端没有这间房，第二个玩家就进不来了。窄屏布局只由视口决定，不影响断言。
  await M.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await M.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await M.evaluate(() => {
    document.querySelector('#nameInput').value = '手机房主';
    document.querySelector('#newRoomName').value = '窄屏游戏房';
    document.querySelector('#btnCreateRoom').click();
  });
  await M.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(600);
  await M.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  const roomId = await M.evaluate(() => window.ChaApp.state.room.id);

  const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const D = await dctx.newPage();
  D.on('pageerror', e => errors.push(e.message));
  await D.goto(BASE + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'domcontentloaded' });
  await D.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await D.evaluate(() => { const m = document.getElementById('entryMask'); if (m) m.classList.add('hidden'); });
  ok('两人进房（手机房主 + 桌面玩家）',
    await M.evaluate(() => window.ChaApp.state.members.length) === 2);

  /* [1] ≡ 菜单 → 游戏 → 开局面板 */
  console.log('\n[1] ≡ 菜单开游戏面板');
  await M.tap('#btnAppSheet');
  await sleep(400);
  await M.evaluate(() => document.getElementById('btnGame').click());
  await sleep(500);
  const mask = await rectOf(M, '#gameMask .modal, #gameMask > div, #gameMask');
  const maskOpen = await M.evaluate(() =>
    !document.getElementById('gameMask').classList.contains('hidden'));
  ok('开局面板打开', maskOpen);
  ok('开局面板完整落在 390px 视口内', mask && mask.visible && mask.inViewport,
    mask ? JSON.stringify({ w: Math.round(mask.w), h: Math.round(mask.h), inVp: mask.inViewport }) : 'null');

  /* [2] 开局 → 选词阶段 */
  console.log('\n[2] 开局进选词');
  await M.evaluate(() => {
    const r = document.getElementById('gameRounds');
    if (r && Array.from(r.options).some(o => o.value === '1')) r.value = '1';
  });
  await M.evaluate(() => document.getElementById('btnGameStart').click());
  const phaseOf = p => p.evaluate(() => (window.ChaApp.state.game || {}).phase);
  let pickOk = false;
  for (let i = 0; i < 60; i++) { if (await phaseOf(M) === 'pick') { pickOk = true; break; } await sleep(200); }
  ok('进入选词阶段（pick）', pickOk, 'phase=' + await phaseOf(M));

  /* [3] 画手选词弹窗完整可见并能选词 */
  console.log('\n[3] 选词弹窗（画手视角）');
  let drawer = null;
  for (const p of [M, D]) {
    if (await p.evaluate(() => !!window.ChaApp.state.game.isDrawer)) drawer = p;
  }
  ok('能确定画手', !!drawer, 'drawer=' + (drawer === M ? '手机' : '桌面'));
  if (drawer) {
    const pick = await rectOf(drawer, '#pickMask');
    ok('选词弹窗显示', pick && pick.visible);
    ok('选词弹窗完整落在视口内（手机也不出屏）', pick && pick.inViewport,
      pick ? JSON.stringify({ w: Math.round(pick.w), inVp: pick.inViewport }) : 'null');
    // 选一个词（20s 选词窗口足够）
    const pickBtn = await drawer.evaluate(() => !!document.querySelector('#pickList .pick-btn'));
    ok('画手看到候选词按钮', pickBtn);
    if (pickBtn) {
      await drawer.evaluate(() => document.querySelector('#pickList .pick-btn').click());
      await sleep(800);
      ok('选词后进入作画阶段', (await phaseOf(drawer)) === 'draw', 'phase=' + await phaseOf(drawer));
    }
  }

  /* [4] 游戏条显示 + 不压工具箱 / 快捷条 */
  console.log('\n[4] 游戏条（#gameHud）显示与避让');
  const hudM = await rectOf(M, '#gameHud');
  ok('手机端游戏条出现', hudM && hudM.visible);
  const timer = await M.evaluate(() => ({
    phase: document.getElementById('ghTimerPhase').textContent,
    sec: document.getElementById('ghTimerSec').textContent
  }));
  ok('游戏条有阶段与倒计时数字', timer.sec !== '--' && timer.sec !== '', JSON.stringify(timer));
  const box = await rectOf(M, '#toolBox');
  const dock = await rectOf(M, '#touchDock');
  ok('游戏条不压左侧工具箱', !overlap(hudM, box));
  ok('游戏条不压底部快捷条', !overlap(hudM, dock));
  const hudActions = await M.evaluate(() => {
    const ids = ['ghScore', 'ghSound', 'ghStop'];
    return ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const r = el.getBoundingClientRect();
      return { id, visible: r.width > 0, inVp: r.right <= innerWidth && r.x >= 0 };
    });
  });
  ok('游戏条右侧按钮都在视口内（计分/音效/结束）',
    hudActions.every(a => a.missing || (a.visible && a.inVp)), JSON.stringify(hudActions));

  /* [5] HUD 按钮真的可点 */
  console.log('\n[5] HUD 按钮可点');
  await M.evaluate(() => document.getElementById('ghScore').click());
  await sleep(400);
  const score = await rectOf(M, '#gameScore');
  ok('点「计分」→ 计分板弹出（手机视口内）', score && score.visible && score.inViewport);
  await M.evaluate(() => { const b = document.getElementById('gsClose'); if (b) b.click(); });
  await sleep(300);
  await M.evaluate(() => document.getElementById('ghStop').click());
  await sleep(600);
  // 结束游戏走 confirmDialog（#confirmMask）—— 点「结束游戏」确认
  await M.evaluate(() => {
    const yes = document.getElementById('confirmYes');
    if (yes && !document.getElementById('confirmMask').classList.contains('hidden')) yes.click();
  });
  await sleep(800);
  const stopped = await M.evaluate(() => ({
    phase: (window.ChaApp.state.game || {}).phase,
    hudHidden: document.getElementById('gameHud').classList.contains('hidden')
  }));
  ok('点「结束游戏」→ 退出游戏模式（HUD 收起）',
    stopped.hudHidden || stopped.phase === 'off' || stopped.phase === undefined,
    JSON.stringify(stopped));

  console.log('\n页面报错数（应为 0）: ' + errors.length);
  errors.slice(0, 5).forEach(e => console.log('  · ' + e.slice(0, 140)));

  await browser.close();
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
