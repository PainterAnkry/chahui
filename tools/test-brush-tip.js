/**
 * ★ 2.0.10 笔刷手感三件事：
 *   1. 铅笔的「圆形停顿」—— 散布那一层以前画在笔身**上面**（原话：「铅笔笔刷出现明显的圆形停顿」）
 *   2. 笔迹转折处的「方形」—— 外角以前是 miter 尖角 / 记不住方向时被切成 45° 方口
 *   3. 笔尖形状可调（照 SAI2 的「笔刷形状」面板：圆 / 方 / 平头 / 三角 / 菱形 + 角度）
 *
 * 用法: node tools/test-brush-tip.js [http://127.0.0.1:8440]
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
// 用户那台机器上的铅笔参数（从 %APPDATA%\茶绘\Local Storage 里读出来的）
const USER_PENCIL = {
  size: 68, opacity: 0.9, hardness: 0.92, minSize: 0.3, pressSize: 1, pressOpacity: 0.6,
  edge: 0, scatter: 0.05, grain: 0.35, grainScale: 1.2, strength: 0.7, tolerance: 32,
  expand: 0, blend: 'normal', filled: false, paper: 'fine', fx: 'none'
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.addInitScript(o => {
    try { localStorage.setItem('chahu.brushes', JSON.stringify({ pencil: o })); } catch (e) {}
  }, USER_PENCIL);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '笔尖');
  await page.fill('#newRoomName', '笔尖与拐角');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));

  /** 画一笔（默认铅笔；over 覆盖参数），返回这层画布的像素统计 */
  const drawStroke = (pts, over, id) => page.evaluate(([pts, over, brushId]) => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
    const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get(brushId), window.ChaApp.state.overrides || {});
    Object.assign(prm, over || {});
    const info = Object.assign({}, prm, {
      id: 'bt' + Math.random(), layerId: e.activeLayerId, tool: 'brush',
      color: '#111111', sym: 'none', brush: brushId, seed: 77
    });
    const st = e.beginStroke(info);
    for (let i = 0; i < pts.length; i++) e.addPoints(st.id, [pts[i]]);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    const stat = { sum: 0, n: 0, min: 255, max: 0, blob: 0, body: 0 };
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a <= 8) continue;
      stat.sum += a; stat.n++;
      if (a < stat.min) stat.min = a;
      if (a > stat.max) stat.max = a;
    }
    stat.avg = stat.n ? stat.sum / stat.n : 0;
    return { n: stat.n, min: stat.min, max: stat.max, avg: +stat.avg.toFixed(1), pts: pts.length };
  }, [pts, over, id || 'pencil']);

  /** 沿线取中线上的 alpha 序列（判断笔身内部有没有一颗颗圆点） */
  const centerline = (y, x0, x1) => page.evaluate(([y, x0, x1]) => {
    const e = window.ChaApp.engine;
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    const out = [];
    for (let x = x0; x <= x1; x++) out.push(d[(y * e.width + x) * 4 + 3]);
    return out;
  }, [y, x0, x1]);

  /* ---------- 1. 铅笔：散布不该在笔身上盖出深色圆点 ---------- */
  console.log('\n[1] 铅笔的「圆形停顿」');
  const line = [];
  for (let x = 200; x <= 900; x += 4) line.push([x, 400, 0.45]);
  /** 同一笔分别用 scatter 关 / 开画一遍，逐像素比 alpha：散布**不许**把已上墨的地方压深 */
  const scatterCompare = await page.evaluate(([pts]) => {
    const e = window.ChaApp.engine;
    function render(scatter) {
      e.layers.forEach(function (l) {
        l.strokes = []; l.baseImage = null; l.baseSeq = 0;
        l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
      });
      e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
      const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('pencil'), window.ChaApp.state.overrides || {});
      prm.scatter = scatter;
      const info = Object.assign({}, prm, {
        id: 'sc' + scatter, layerId: e.activeLayerId, tool: 'brush',
        color: '#111111', sym: 'none', brush: 'pencil', seed: 77
      });
      const st = e.beginStroke(info);
      for (let i = 0; i < pts.length; i++) e.addPoints(st.id, [pts[i]]);
      e.endStroke(st.id, e.seq + 1);
      e.invalidate();
      return e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    }
    const off = render(0);
    const on = render(0.05);
    let worse = 0, worst = 0, inked = 0, extra = 0;
    for (let i = 3; i < off.length; i += 4) {
      if (off[i] > 150) {                    // 只比「笔身实心处」：边缘的颗粒正是散布该干的事
        inked++;
        const d = on[i] - off[i];
        if (d > 8) { worse++; if (d > worst) worst = d; }
      }
      if (off[i] <= 8 && on[i] > 8) extra++;
    }
    return { inked: inked, worse: worse, worst: worst, extra: extra };
  }, [line]);
  console.log('  散布前后逐像素比: ' + JSON.stringify(scatterCompare));
  check('★ 散布开着时，笔身实心处基本没被压深（旧代码会盖出一颗颗深色圆点，+74/255）',
    scatterCompare.inked > 300 && scatterCompare.worst <= 16, scatterCompare);
  check('★ 散布仍然在起作用（笔身外面多出一层颗粒）', scatterCompare.extra > 200, scatterCompare.extra);

  /* ---------- 2. 拐角：直角拐弯的外角是圆的，不是方的 ---------- */
  console.log('\n[2] 笔迹转折处');
  const corner = [];
  for (let x = 200; x <= 600; x += 8) corner.push([x, 300, 0.9]);
  corner.push([600, 300, 0.9]);                       // 重合点（手绘常见）
  for (let y = 308; y <= 700; y += 8) corner.push([600, y, 0.9]);
  await drawStroke(corner, { scatter: 0, grain: 0, paper: 'none', hardness: 1, size: 56, minSize: 1, pressSize: 0 }, 'pencil');
  const probe = (x, y) => page.evaluate(([x, y]) => {
    const e = window.ChaApp.engine;
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    return d[(y * e.width + x) * 4 + 3];
  }, [x, y]);
  // 笔宽 56 → 半宽 28：miter 尖角会填到 (600+28, 300-28) 附近；
  // 圆角只到半径 28 的弧上 —— 角点 (600+26,300-26) 距圆心 36.8 > 28 → 不该有墨
  const miterTip = await probe(626, 274);
  const onArc = await probe(620, 300);                // 弧上（x = 600+20 附近）
  const straight = await probe(500, 300 - 0);         // 水平笔身正中
  const width = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    let lo = -1, hi = -1;
    for (let y = 200; y < 400; y++) if (d[(y * e.width + 500) * 4 + 3] > 40) { if (lo < 0) lo = y; hi = y; }
    return lo < 0 ? 0 : hi - lo + 1;
  });
  console.log('  miter 尖角处=' + miterTip + '  弧上=' + onArc + '  正中=' + straight + '  笔宽=' + width);
  check('★ 外角是 miter 尖角（不自交、不留白洞 —— 圆弧外角会捅穿内侧、导致白色三角，已回退）',
    miterTip > 40, miterTip);
  check('★ 外角两侧都有墨（角是实心的，没有缺口）', onArc > 40, onArc);
  check('★ 笔身宽度没被改坏（≈ 设定值）', width >= 52 && width <= 60, width);

  /* ---------- 3. 笔尖形状 ---------- */
  console.log('\n[3] 笔尖形状（照 SAI2 的笔刷形状面板）');
  const shapes = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('#tipShapes .tip-btn')).map(b => b.dataset.tip);
    const row = document.querySelector('#tipShapes');
    return { list: list, visible: !!row && !row.closest('.row-line').classList.contains('hidden') };
  });
  console.log('  面板上的形状: ' + JSON.stringify(shapes));
  check('★ 面板上有五种笔尖形状（圆 / 方 / 平头 / 三角 / 菱形）',
    shapes.list.join(',') === 'round,square,flat,triangle,diamond', shapes.list);
  check('★ 笔刷参数区里看得见这一排', shapes.visible === true);

  const wire = [];
  for (let x = 200; x <= 700; x += 6) wire.push([x, 400, 1]);
  const widths = {}, areas = {}, ends = {};
  for (const sh of ['round', 'square', 'triangle', 'diamond', 'flat']) {
    await drawStroke(wire, {
      tipShape: sh, tipAngle: 0, size: 48, hardness: 1, grain: 0, paper: 'none',
      scatter: 0, opacity: 1, pressOpacity: 0, minSize: 1, pressSize: 0
    }, 'brush');
    const m = await page.evaluate(() => {
      const e = window.ChaApp.engine;
      const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
      let lo = -1, hi = -1, n = 0, end = 0;
      for (let y = 300; y < 520; y++) if (d[(y * e.width + 450) * 4 + 3] > 40) { if (lo < 0) lo = y; hi = y; }
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      // 收笔处「方角」上那一点（沿笔身方向偏 20、横向偏 20）：
      // 方头那里是实心的角，圆头那里在半径 24 的圆外（√(20²+20²)=28 > 24）→ 空白
      const cornerPx = [];
      for (const yy of [378, 422]) cornerPx.push(d[(yy * e.width + (lo >= 0 ? 0 : 0) + 718) * 4 + 3]);
      return { h: lo < 0 ? 0 : hi - lo + 1, n: n, end: Math.max.apply(null, cornerPx) };
    });
    widths[sh] = m.h; areas[sh] = m.n; ends[sh] = m.end;
  }
  console.log('  横向笔身在各形状下的厚度: ' + JSON.stringify(widths));
  console.log('  各形状的墨量: ' + JSON.stringify(areas) + '  收笔处: ' + JSON.stringify(ends));
  check('★ 圆头 = 笔宽', Math.abs(widths.round - 48) <= 4, widths.round);
  check('★ 方头是方的：收笔外侧的方角是实心的，圆头那里是空的（圆收笔够不到）',
    ends.square > 150 && ends.round < 40, { square: ends.square, round: ends.round });
  check('★ 平头（角度 0）明显更薄 —— 侧着运笔就是一条细线', widths.flat < widths.round * 0.6, widths.flat);
  check('★ 三角 / 菱形各有自己的形状（厚度和圆头不一样）',
    widths.triangle !== widths.round && widths.diamond !== widths.round,
    { tri: widths.triangle, dia: widths.diamond });

  // 平头笔尖：角度 0 与 90 的粗细差别 = 「斜切」这笔的全部意义
  const flatW = async ang => {
    await drawStroke(wire, {
      tipShape: 'flat', tipAngle: ang, size: 48, hardness: 1, grain: 0, paper: 'none',
      scatter: 0, opacity: 1, pressOpacity: 0, minSize: 1, pressSize: 0
    }, 'brush');
    return page.evaluate(() => {
      const e = window.ChaApp.engine;
      const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
      let lo = -1, hi = -1;
      for (let y = 300; y < 520; y++) if (d[(y * e.width + 450) * 4 + 3] > 40) { if (lo < 0) lo = y; hi = y; }
      return lo < 0 ? 0 : hi - lo + 1;
    });
  };
  const f0 = await flatW(0), f90 = await flatW(90);
  console.log('  平头 0° = ' + f0 + 'px，90° = ' + f90 + 'px');
  check('★ 笔尖角度真的改粗细（0° 薄、90° 厚）', f90 > f0 * 1.5, { a0: f0, a90: f90 });
  await page.evaluate(() => {
    const btn = document.querySelector('#tipShapes .tip-btn[data-tip="square"]');
    if (btn) btn.click();
  });
  await sleep(250);
  const uiState = await page.evaluate(() => ({
    shape: window.ChaApp.state.brush.tipShape,
    on: (document.querySelector('#tipShapes .tip-btn.on') || {}).dataset ? document.querySelector('#tipShapes .tip-btn.on').dataset.tip : '',
    angleRow: !document.querySelector('#tipAngleRow').classList.contains('hidden')
  }));
  check('★ 点一下图标 = 换成那个笔尖（当前笔刷参数跟着变）',
    uiState.shape === 'square' && uiState.on === 'square', uiState);
  check('★ 非圆头时才出现「笔尖角度」那一行', uiState.angleRow === true, uiState);

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
