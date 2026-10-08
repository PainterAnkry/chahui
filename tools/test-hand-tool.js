/**
 * 茶绘 · 抓手工具（拖动画布）验收（真浏览器）
 *
 * 用法：
 *   PORT=8444 node server/src/index.js
 *   node tools/test-hand-tool.js http://127.0.0.1:8444
 *
 * 覆盖：
 *   ① 工具栏里有「抓手」，点一下就选中，画布上不再画笔刷光标
 *   ② 鼠标左键拖动 = 平移视图（1:1 跟手），且**不留下任何笔迹**（不进撤销栈）
 *   ③ 抓手不影响原有两条路：空格 + 左键拖动、中键拖动
 *   ④ Alt 仍然是「临时吸管」，不会被抓手抢走（光标与实际行为一致）
 *   ⑤ 手机网页版（390 宽 + 触屏）：从抽屉里选抓手 → 单指拖画布 = 平移，不落笔
 *   ⑥ 换回画笔后，鼠标与单指都照旧能画（抓手没把落笔那条路弄坏）
 *   ⑦ 控制台干净
 */
'use strict';
const path = require('path');
const { chromium } = require(path.resolve(__dirname, 'pw'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8437').replace(/\/$/, '');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 进房：填名字 + 房名 → 建房 → 收起入口遮罩 */
async function enterRoom(page, name) {
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await page.evaluate((n) => {
    document.querySelector('#nameInput').value = n;
    document.querySelector('#newRoomName').value = '抓手验收房';
    document.querySelector('#btnCreateRoom').click();
  }, name);
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(500);
  await page.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  await sleep(200);
}

/** 画布可视区正中 */
const midOf = (page) => page.evaluate(() => {
  const r = document.querySelector('#stage').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

/** 视图状态 + 笔迹数（平移的判据就是这三个数） */
const viewState = (page) => page.evaluate(() => ({
  tx: window.ChaApp.engine.tx,
  ty: window.ChaApp.engine.ty,
  scale: window.ChaApp.engine.scale,
  undo: window.ChaApp.state.myUndo.length,
  tool: window.ChaApp.state.tool,
  strokeCount: window.ChaApp.engine.strokes ? window.ChaApp.engine.strokes.length : -1
}));

/** 选一支笔 / 一个工具（铅笔在笔刷栏、抓手在工具栏，两个网格都要找） */
const pickItem = (page, id) => page.evaluate((item) => {
  const b = document.querySelector('#toolGrid .tool[data-item="' + item + '"], #brushGrid .tool[data-item="' + item + '"]');
  if (b) { b.click(); return true; }
  return false;
}, id);

/** 视图回正（适应窗口）——拖动会平移视图，后面再落笔得先确保点在画布上。
 *  用 API 而不是点「适应」那颗按钮：手机上它在抽屉里，看不见点不着。 */
const fitView = async (page) => {
  await page.evaluate(() => {
    if (window.ChaApp && typeof window.ChaApp.zoomFit === 'function') window.ChaApp.zoomFit();
    else { const b = document.querySelector('#btnZoomFit'); if (b) b.click(); }
  });
  await sleep(400);
};

/** 鼠标拖一段（按下 → 分几步移动 → 松开） */
async function mouseDrag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(from.x + dx * i / 5, from.y + dy * i / 5);
    await sleep(20);
  }
  await page.mouse.up();
  await sleep(250);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const errs = [];
  const watch = (p) => {
    p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  };

  /* ==================== [1] 桌面：抓手工具 + 空格 / 中键 / Alt ==================== */
  console.log('\n[1] 桌面 1440×900：抓手拖动画面');
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const D = await dctx.newPage(); watch(D);
  await D.goto(BASE + '/');
  await enterRoom(D, '桌面抓手');

  const tile = await D.evaluate(() => {
    const b = document.querySelector('#toolGrid .tool[data-item="hand"]');
    if (!b) return null;
    return { text: b.textContent.trim(), title: b.title, svg: !!b.querySelector('svg') };
  });
  ok('工具栏里有「抓手」这一格（带图标）', !!tile && !!tile.svg && tile.text.indexOf('抓手') >= 0, tile);
  ok('提示里写清了两条拖动手势（空格 / 中键）',
    !!tile && /空格/.test(tile.title) && /中键/.test(tile.title), tile && tile.title);

  await D.click('#toolGrid .tool[data-item="hand"]');
  await sleep(300);
  const picked = await D.evaluate(() => ({
    tool: window.ChaApp.state.tool,
    active: !!document.querySelector('#toolGrid .tool[data-item="hand"].active'),
    handClass: document.querySelector('#stage').classList.contains('hand-tool'),
    drawingClass: document.querySelector('#stage').classList.contains('drawing'),
    ringHidden: document.querySelector('#brushCursor').classList.contains('hidden'),
    cursor: getComputedStyle(document.querySelector('.canvas-wrap')).cursor
  }));
  ok('点一下选中抓手', picked.tool === 'hand' && picked.active, picked);
  ok('抓手态不再画笔刷光标（.drawing 摘掉、圆环藏起来）',
    !picked.drawingClass && picked.ringHidden && picked.handClass, picked);
  ok('画布上换成「张开的手」光标', picked.cursor === 'grab', picked.cursor);

  const mid = await midOf(D);
  ok('画布正中没被别的层盖住',
    (await D.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.id || el.className) : 'none';
    }, [mid.x, mid.y])) === 'view');

  const beforeDrag = await viewState(D);
  await mouseDrag(D, mid, 140, -90);
  const afterDrag = await viewState(D);
  ok('左键拖动 → 视图 1:1 跟手平移',
    Math.abs((afterDrag.tx - beforeDrag.tx) - 140) < 4 && Math.abs((afterDrag.ty - beforeDrag.ty) + 90) < 4,
    'd=(' + (afterDrag.tx - beforeDrag.tx).toFixed(1) + ',' + (afterDrag.ty - beforeDrag.ty).toFixed(1) + ')');
  ok('拖动期间不缩放', Math.abs(afterDrag.scale - beforeDrag.scale) < 1e-6);
  ok('抓手拖动**不落笔**（撤销栈没多）', afterDrag.undo === beforeDrag.undo,
    beforeDrag.undo + ' → ' + afterDrag.undo);
  ok('抓手拖动没在文档上留笔迹', afterDrag.strokeCount === beforeDrag.strokeCount,
    beforeDrag.strokeCount + ' → ' + afterDrag.strokeCount);

  // 空格 + 左键：老手势不能被抓手弄坏
  const beforeSpace = await viewState(D);
  await pickItem(D, 'pencil');
  await sleep(250);
  await D.keyboard.down('Space');
  await mouseDrag(D, mid, 60, 40);
  await D.keyboard.up('Space');
  const afterSpace = await viewState(D);
  ok('空格 + 左键拖动照样平移',
    Math.abs((afterSpace.tx - beforeSpace.tx) - 60) < 4 && Math.abs((afterSpace.ty - beforeSpace.ty) - 40) < 4,
    'd=(' + (afterSpace.tx - beforeSpace.tx).toFixed(1) + ',' + (afterSpace.ty - beforeSpace.ty).toFixed(1) + ')');

  // 中键拖动
  const beforeMid = await viewState(D);
  await D.mouse.move(mid.x, mid.y);
  await D.mouse.down({ button: 'middle' });
  await D.mouse.move(mid.x - 50, mid.y - 30);
  await sleep(60);
  await D.mouse.up({ button: 'middle' });
  await sleep(250);
  const afterMid = await viewState(D);
  ok('中键拖动照样平移',
    Math.abs((afterMid.tx - beforeMid.tx) + 50) < 4 && Math.abs((afterMid.ty - beforeMid.ty) + 30) < 4,
    'd=(' + (afterMid.tx - beforeMid.tx).toFixed(1) + ',' + (afterMid.ty - beforeMid.ty).toFixed(1) + ')');

  // 换回画笔：鼠标要能画（先适应窗口，保证落点还在画布上 —— 前面把视图拖偏了）
  await fitView(D);
  const paintAt = await midOf(D);
  const beforePaint = await viewState(D);
  await mouseDrag(D, paintAt, 70, 55);
  const afterPaint = await viewState(D);
  ok('换回画笔后鼠标能落笔（抓手没弄坏落笔那条路）', afterPaint.undo > beforePaint.undo,
    beforePaint.undo + ' → ' + afterPaint.undo);

  // Alt 仍然是临时吸管：选中抓手也不该被抢走
  await pickItem(D, 'hand');
  await sleep(250);
  await D.keyboard.down('Alt');
  await sleep(200);
  const altCursor = await D.evaluate(() => ({
    eyedrop: document.querySelector('#stage').classList.contains('eyedropping'),
    ringClass: document.querySelector('#brushCursor').className
  }));
  await D.keyboard.up('Alt');
  await sleep(200);
  ok('抓住手时按住 Alt 仍然是「临时吸管」光标（不会被抓手吃掉）',
    altCursor.eyedrop && /eyedrop/.test(altCursor.ringClass), altCursor);
  await dctx.close();

  /* ==================== [2] 手机网页版（触屏 + 390 宽） ==================== */
  console.log('\n[2] 手机网页版 390×844（触屏）：单指拖画布');
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2
  });
  const M = await mctx.newPage(); watch(M);
  await M.goto(BASE + '/');
  await enterRoom(M, '手机抓手');

  // 窄屏：Krita 工具箱常驻左缘，「抓手」一格直接可点（不用再拉抽屉）
  await M.tap('#tbBrush');      // 顺带验证：笔刷 chip 仍能拉开抽屉找到工具栏
  await sleep(600);
  const tileVisible = await M.evaluate(() => {
    const b = document.querySelector('#toolGrid .tool[data-item="hand"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('手机抽屉里能摸到「抓手」这一格', !!tileVisible && tileVisible.w > 20 && tileVisible.h > 20, tileVisible);
  await M.tap('#drawerBack', { position: { x: 370, y: 400 } });   // 关抽屉（右侧露出画布的窄条），让工具箱露出来
  await sleep(450);
  await M.tap('#toolBox .tb-btn[data-tool="hand"]');
  await sleep(500);
  const mPicked = await M.evaluate(() => ({
    tool: window.ChaApp.state.tool,
    handClass: document.querySelector('#stage').classList.contains('hand-tool'),
    leftOpen: window.ChaApp.state.leftPanelOpen
  }));
  ok('手机上选中抓手（工具箱直达，抽屉不挡画布）',
    mPicked.tool === 'hand' && mPicked.handClass && !mPicked.leftOpen, mPicked);

  const cdp = await mctx.newCDPSession(M);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  const mBefore = await viewState(M);
  const mStart = { x: 195, y: 430 };
  await touch('touchStart', [{ x: mStart.x, y: mStart.y }]);
  await sleep(70);
  await touch('touchMove', [{ x: mStart.x + 40, y: mStart.y + 30 }]);
  await sleep(70);
  await touch('touchMove', [{ x: mStart.x + 90, y: mStart.y + 70 }]);
  await sleep(70);
  await touch('touchEnd', []);
  await sleep(400);
  const mAfter = await viewState(M);
  ok('单指拖画布 → 画布跟着手指平移',
    Math.abs((mAfter.tx - mBefore.tx) - 90) < 8 && Math.abs((mAfter.ty - mBefore.ty) - 70) < 8,
    'd=(' + (mAfter.tx - mBefore.tx).toFixed(1) + ',' + (mAfter.ty - mBefore.ty).toFixed(1) + ')');
  ok('手机上抓手拖动同样**不落笔**', mAfter.undo === mBefore.undo, mBefore.undo + ' → ' + mAfter.undo);

  // 换回画笔：手机上单指照旧能画（工具箱点「当前笔刷」拉出笔刷库再选铅笔）
  await M.tap('#tbBrush');
  await sleep(500);
  await M.tap('#brushGrid .tool[data-item="pencil"]');
  await sleep(450);
  await fitView(M);
  const pBefore = await viewState(M);
  await touch('touchStart', [{ x: 200, y: 420 }]);
  await sleep(70);
  await touch('touchMove', [{ x: 220, y: 440 }]);
  await sleep(70);
  await touch('touchEnd', []);
  await sleep(400);
  const pAfter = await viewState(M);
  ok('手机上换回画笔后单指仍能落笔', pAfter.undo > pBefore.undo, pBefore.undo + ' → ' + pAfter.undo);

  // 双指手势还在（抓手没抢掉它）
  const zBefore = await viewState(M);
  await touch('touchStart', [{ x: 150, y: 420 }, { x: 240, y: 420 }]);
  await sleep(80);
  await touch('touchMove', [{ x: 120, y: 430 }, { x: 290, y: 430 }]);
  await sleep(80);
  await touch('touchEnd', []);
  await sleep(300);
  const zAfter = await viewState(M);
  ok('双指张开仍然能放大（抓手不抢双指手势）', zAfter.scale > zBefore.scale * 1.15,
    zBefore.scale.toFixed(3) + ' → ' + zAfter.scale.toFixed(3));
  await mctx.close();

  /* ==================== [3] 控制台 ==================== */
  console.log('\n[3] 控制台干净');
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 4).join(' | '));

  await browser.close();
  console.log('\n──────────────────────────────');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
