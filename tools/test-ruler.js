/**
 * 尺子（SAI2 的直线 / 椭圆 / 平行线 / 同心圆 / 集中线）回归。
 *
 * 守着这几条：
 *   · 五种尺子的吸附几何是对的（点在尺子上、连续、可复现）
 *   · 吸附发生在**取点时**：所以笔迹里存的点就是吸附后的点 ——
 *     别人原样重放即可，不会因为各自尺子不同而画出两样东西
 *   · **远端来的点绝不再吸附**（否则我换个尺子就把别人的线掰弯了）
 *   · 摆尺子那一次拖拽不画画；重置 / 隐藏都有效
 *
 * 用法: node tools/test-ruler.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '尺子');
  await page.fill('#newRoomName', '尺子回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => {
    document.querySelector('#entryMask').classList.add('hidden');
    document.querySelector('#btnZoomFit').click();
    const c = document.querySelector('#tpAuto'); if (c) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(400);

  console.log('\n=== 五种尺子的吸附几何 ===');
  const geo = await page.evaluate(() => {
    const R = window.ChaRuler;
    const out = {};
    // 直线尺：过 (400,300)-(800,300) 的水平线
    let r = R.make('line', { x: 400, y: 300 }, { x: 800, y: 300 });
    let p = R.snap(r, 600, 700);
    out.line = { y: p.y, x: p.x };
    // 再来一个斜的
    r = R.make('line', { x: 0, y: 0 }, { x: 100, y: 100 });
    p = R.snap(r, 100, 0);
    out.lineDiag = { x: p.x, y: p.y };
    // 椭圆尺
    r = R.make('ellipse', { x: 400, y: 300 }, { x: 800, y: 700 });
    p = R.snap(r, 1000, 500);            // 正右方 → 应落在椭圆右顶点
    out.ellipse = { x: p.x, y: p.y };
    p = R.snap(r, 600, 500);             // 正中心 → 有个确定的落点（不许 NaN）
    out.ellipseCenter = { x: p.x, y: p.y };
    // 平行线尺
    r = R.make('parallel', { x: 400, y: 300 }, { x: 800, y: 300 });
    out.parallelSpacing = r.spacing;
    p = R.snap(r, 600, 300 + r.spacing * 2 + 3);   // 离第 2 条线 3px
    out.parallel = { y: p.y };
    // 同心圆尺
    r = R.make('circle', { x: 600, y: 500 }, { x: 800, y: 500 });
    out.circleSpacing = r.spacing;
    p = R.snap(r, 600 + r.spacing * 3 + 4, 500);   // 角度保持、半径吸到第 3 圈
    out.circle = { r: Math.hypot(p.x - 600, p.y - 500), y: p.y };
    // 集中线尺：24 条
    r = R.make('radial', { x: 600, y: 500 }, { x: 800, y: 500 });
    const step = Math.PI * 2 / R.SPOKES;
    const near = step * 3 + step * 0.08;           // 稍微偏一点
    p = R.snap(r, 600 + Math.cos(near) * 200, 500 + Math.sin(near) * 200);
    out.radial = { ang: Math.atan2(p.y - 500, p.x - 600), k: Math.round(Math.atan2(p.y - 500, p.x - 600) / step), dist: Math.hypot(p.x - 600, p.y - 500) };
    return out;
  });
  console.log('  ' + JSON.stringify(geo));
  ok('直线尺：离开线的点被拉到线上', Math.abs(geo.line.y - 300) < 1e-6 && Math.abs(geo.line.x - 600) < 1e-6, JSON.stringify(geo.line));
  ok('直线尺：斜线也吸得对（(100,0) → 中线）', Math.abs(geo.lineDiag.x - 50) < 1e-6 && Math.abs(geo.lineDiag.y - 50) < 1e-6, JSON.stringify(geo.lineDiag));
  ok('椭圆尺：右侧的点落在椭圆右顶点', Math.abs(geo.ellipse.x - 800) < 1e-6 && Math.abs(geo.ellipse.y - 500) < 1e-6, JSON.stringify(geo.ellipse));
  ok('椭圆尺：圆心处也给得出确定落点（不是 NaN）',
    isFinite(geo.ellipseCenter.x) && isFinite(geo.ellipseCenter.y), JSON.stringify(geo.ellipseCenter));
  ok('平行线尺：吸附到最近的那一条', Math.abs(geo.parallel.y - (300 + geo.parallelSpacing * 2)) < 1e-6,
    'y=' + geo.parallel.y.toFixed(3) + ' 期望 ' + (300 + geo.parallelSpacing * 2).toFixed(3));
  ok('同心圆尺：半径吸到整数圈、角度不变',
    Math.abs(geo.circle.r - geo.circleSpacing * 3) < 1e-6 && Math.abs(geo.circle.y - 500) < 1e-6,
    'r=' + geo.circle.r.toFixed(2) + ' 期望 ' + (geo.circleSpacing * 3).toFixed(2));
  ok('集中线尺：角度吸到 24 条之一、距离不变',
    geo.radial.k === 3 && Math.abs(geo.radial.dist - 200) < 1e-6, JSON.stringify(geo.radial));

  console.log('\n=== 摆尺子那一次拖拽不画画 ===');
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => { const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]); return [box.x + s.x, box.y + s.y]; };
  await page.evaluate(() => window.ChaApp.armRuler('line'));
  await sleep(300);
  const armed = await page.evaluate(() => !!window.ChaApp.state.rulerArm && window.ChaApp.state.rulerArm.type);
  ok('选了直线尺后进入「摆尺子」状态', armed === 'line', String(armed));
  const a1 = await mk(400, 500), a2 = await mk(1000, 500);
  await page.mouse.move(a1[0], a1[1]);
  await page.mouse.down();
  await page.mouse.move(a2[0], a2[1], { steps: 10 });
  await page.mouse.up();
  await sleep(600);
  const placed = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    return {
      ruler: e.ruler && e.ruler.type,
      strokes: e.strokes.length,
      arm: !!window.ChaApp.state.rulerArm,
      // 注意用透明底：默认渲染会铺白色背景，整幅都有 alpha，数出来恒等于画布面积
      ink: (function () {
        const d = e.renderDocument({ transparentBackground: true }).canvas
          .getContext('2d').getImageData(0, 0, e.width, e.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
        return n;
      })()
    };
  });
  console.log('  ' + JSON.stringify(placed));
  ok('尺子摆上了', placed.ruler === 'line', String(placed.ruler));
  ok('摆尺子这一下没有画出任何笔迹', placed.strokes === 0 && placed.ink === 0, '笔迹 ' + placed.strokes + '，墨 ' + placed.ink);
  ok('摆完自动退出摆尺状态', placed.arm === false);

  console.log('\n=== 之后的笔画被吸附到尺子上 ===');
  // 画一条歪歪扭扭的线，应该全部落到 y=500 上
  await page.evaluate(() => {
    const b = document.querySelector('#brushGrid .tool[data-item="pencil"]') ||
      document.querySelector('#toolGrid .tool[data-item="pencil"]');
    b.click();
  });
  await sleep(300);
  const pts = [[420, 460], [520, 560], [620, 440], [720, 580], [820, 450], [920, 545]];
  const scr = [];
  for (const p of pts) scr.push(await mk(p[0], p[1]));
  await page.mouse.move(scr[0][0], scr[0][1]);
  await page.mouse.down();
  for (let i = 1; i < scr.length; i++) await page.mouse.move(scr[i][0], scr[i][1], { steps: 6 });
  await page.mouse.up();
  await sleep(900);
  const snapped = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const st = e.strokes[e.strokes.length - 1];
    if (!st) return { n: 0 };
    const ys = st.points.map(p => p[1]);
    const dev = Math.max.apply(null, ys.map(y => Math.abs(y - 500)));
    return { n: st.points.length, maxDev: dev, minY: Math.min.apply(null, ys), maxY: Math.max.apply(null, ys) };
  });
  console.log('  ' + JSON.stringify(snapped));
  ok('笔画确实画出来了', snapped.n > 3, snapped.n + ' 个点');
  ok('所有点都被吸到 y=500 这条线上', snapped.maxDev < 1e-6,
    '最大偏离 ' + (snapped.maxDev === undefined ? '?' : snapped.maxDev.toFixed(6)));

  console.log('\n=== 远端来的点不再吸附 ===');
  const remote = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    // 冒充一笔远端笔迹：local 为假
    const info = { id: 'remote1', layerId: e.activeLayerId, tool: 'brush', color: '#111111',
      size: 8, opacity: 1, hardness: 1, minSize: 1, pressSize: 0, pressOpacity: 0,
      seed: 7, sym: 'none', brush: 'pencil', points: [] };
    const st = e.beginStroke(info);
    e.addPoints(st.id, [[500, 300, 0.5], [900, 300, 0.5]]);
    e.endStroke(st.id, e.seq + 1);
    const r = e.strokes[e.strokes.length - 1];
    const ys = r.points.map(p => p[1]);
    return { maxDev: Math.max.apply(null, ys.map(y => Math.abs(y - 300))), local: !!r.local,
      distFromRuler: Math.abs(ys[0] - 500) };
  });
  console.log('  ' + JSON.stringify(remote));
  ok('远端笔迹的点没被本地尺子改过', remote.maxDev < 1e-6, '最大偏离 ' + remote.maxDev.toFixed(6));
  ok('它确实离本地尺子很远（说明没被吸过去）', remote.distFromRuler > 100, '距尺子 ' + remote.distFromRuler.toFixed(0) + 'px');

  console.log('\n=== 重置 / 隐藏 ===');
  const hidden = await page.evaluate(() => {
    window.ChaApp.toggleRulerVisible(false);
    const e = window.ChaApp.engine;
    return { show: e.showRuler, on: window.ChaApp.state.rulerOn };
  });
  ok('能隐藏尺子', hidden.show === false && hidden.on === false, JSON.stringify(hidden));
  await page.evaluate(() => window.ChaApp.clearRuler());
  await sleep(300);
  const cleared = await page.evaluate(() => ({
    ruler: window.ChaApp.engine.ruler,
    show: window.ChaApp.engine.showRuler
  }));
  ok('重置尺子后吸附不再生效（但显示开关不受影响）',
    cleared.ruler === null && typeof cleared.show === 'boolean', JSON.stringify(cleared));

  // 重置后再画一笔，应该恢复自由曲线
  await sleep(200);
  const freeDraw = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const info = { id: 'free1', layerId: e.activeLayerId, tool: 'brush', color: '#111111',
      size: 8, opacity: 1, hardness: 1, minSize: 1, pressSize: 0, pressOpacity: 0,
      seed: 8, sym: 'none', brush: 'pencil', points: [] };
    const st = e.beginStroke(info);
    e.addPoints(st.id, [[500, 300, 0.5]]);
    e.addPoints(st.id, [[600, 360, 0.5]]);
    e.endStroke(st.id, e.seq + 1);
    const r = e.strokes[e.strokes.length - 1];
    return { ys: r.points.map(p => p[1]) };
  });
  ok('重置后笔画恢复自由（不再被拉平）',
    Math.abs(freeDraw.ys[0] - 300) < 1e-6 && Math.abs(freeDraw.ys[1] - 360) < 1e-6,
    JSON.stringify(freeDraw.ys));

  console.log('\n=== 其余四种也能正常摆上 ===');
  for (const t of ['ellipse', 'parallel', 'circle', 'radial']) {
    const r = await page.evaluate((type) => {
      window.ChaApp.armRuler(type);
      window.ChaApp.commitRuler(type, { x: 400, y: 300 }, { x: 900, y: 700 });
      const e = window.ChaApp.engine;
      return { type: e.ruler && e.ruler.type, spacing: e.ruler && Math.round(e.ruler.spacing) };
    }, t);
    ok(t + ' 尺子摆得上', r.type === t && r.spacing > 0, JSON.stringify(r));
  }

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
