/**
 * 「有概率看不到别人的某一图层」回归。
 *
 * 症状：多人协作时，某一方画的某一图层，在别人屏幕上就是不出来（或者只出来一部分）。
 * 「有概率」这个词本身就是线索 —— 它一定是**消息到达顺序**的问题。
 *
 * 三条独立的根因，这个测试逐条钉死：
 *
 *  ① 笔迹比图层先到（LAYER_ADD 和 STROKE_* 是两条独立广播，没有顺序保证）。
 *     以前 addCommitted 遇到认不出的 layerId 会兜底到「最后一层」，
 *     而作者端 newStroke 兜底的是「活动图层」、服务端又是「最后一层」——
 *     三个兜底目标各说各话，于是同一笔在三个人屏幕上落在不同图层。
 *     现在必须**挂起来等图层**，等到了再原样补落。
 *
 *  ② 正在画的那一笔（STROKE_BEGIN → POINTS → END）走的是另一条路
 *     （beginStroke / addPoints / endStroke），上面的坑它有一个完整副本。
 *
 *  ③ 基底合成缓存键漏了蒙版 / 剪贴状态：远端改这两样时图层数组没变化，
 *     缓存键一样 → 复用旧基底 → 屏幕上那一层看着根本没更新。
 *
 * 用法: node tools/test-layer-sync.js [http://localhost:8440]
 */
'use strict';
const { chromium } = require('./pw');

const URL = process.argv[2] || 'http://127.0.0.1:8440';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.log('  !! 页面报错:', String(e).split('\n')[0]));
  return p;
}

async function createRoom(page, nick, roomName) {
  await page.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await page.evaluate(() => { document.getElementById('entryMask').classList.add('hidden'); window.ChaApp.zoomFit(); });
  await sleep(400);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function join(page, room, nick) {
  await page.goto(URL + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await page.evaluate(() => { const m = document.getElementById('entryMask'); if (m) m.classList.add('hidden'); window.ChaApp.zoomFit(); });
  await sleep(500);
}

/** 该图层在「文档像素」里的墨量（非白程度），用来判断画面到底出来没有 */
const layerInk = (p, layerId) => p.evaluate((lid) => {
  const e = window.ChaApp.engine;
  const l = e.getLayer(lid);
  if (!l || !l.canvas) return null;
  const d = l.canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    sum += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]);
  }
  return Math.round(sum / 1000);
}, layerId);

/** 图层在「屏幕合成」里的墨量 —— 这个才是用户眼睛看到的 */
const viewInkAll = (p, x, y, w, h) => p.evaluate(([a, b, ww, hh]) => {
  const e = window.ChaApp.engine;
  const s = e.docToScreen(a, b);
  const s2 = e.docToScreen(a + ww, b + hh);
  const ctx = document.getElementById('view').getContext('2d');
  const X = Math.round(s.x * e.dpr), Y = Math.round(s.y * e.dpr);
  const W = Math.max(1, Math.round((s2.x - s.x) * e.dpr)), H = Math.max(1, Math.round((s2.y - s.y) * e.dpr));
  const d = ctx.getImageData(X, Y, W, H).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { sum += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]); n++; }
  return Math.round(sum / Math.max(1, n) * 100) / 100;
}, [x, y, w, h]);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const A = await newPage(browser);
  const room = await createRoom(A, '小茶', '图层同步回归');
  const B = await newPage(browser);
  await join(B, room, '阿墨');
  await sleep(700);

  const baseLayers = await A.evaluate(() => window.ChaApp.engine.layers.map(l => ({ id: l.id, name: l.name })));
  ok('开局有基础图层', baseLayers.length >= 1, baseLayers);

  /* ================================================================
   * ① 笔迹比图层先到：认不出的 layerId 必须挂起，不许兜底乱落
   * ================================================================ */
  console.log('\n=== ① 笔迹先于图层到达：必须挂起等待，不许落到别的图层 ===');
  const orphanId = 'L-test-newlayer-' + Date.now();
  const r1 = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    const before = e.layers.map(l => l.id + ':' + l.strokes.length);
    // 模拟：STROKE_ADDED 比 LAYER_ADD 先到
    e.addCommitted({
      id: 's-orphan-1', layerId: lid, userId: 'someone-else', tool: 'brush',
      color: '#cc2222', size: 40, opacity: 1, hardness: 1,
      points: [[300, 300, 0.5], [500, 300, 0.5], [700, 300, 0.5]], seq: 999999
    });
    return { orphans: e.orphanCount(), layersAfter: e.layers.map(l => l.id + ':' + l.strokes.length), before };
  }, orphanId);
  ok('★ 认不出的 layerId 被挂起（不是硬塞进某一层）', r1.orphans === 1, r1);
  ok('★ 没有任何图层被污染', JSON.stringify(r1.layersAfter) === JSON.stringify(r1.before), r1);

  // 图层来了 → 笔迹必须补落
  const r2 = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    e.addLayerMeta({ id: lid, name: '迟到的图层' });
    const flushed = e.flushOrphanStrokes();
    const l = e.getLayer(lid);
    return { flushed: flushed, orphans: e.orphanCount(), strokes: l ? l.strokes.length : -1, id: lid };
  }, orphanId);
  ok('★ 图层到了以后笔迹补落成功', r2.flushed === 1 && r2.strokes === 1, r2);
  ok('★ 挂起表清空了', r2.orphans === 0, r2);

  const inkOrphan = await layerInk(B, orphanId);
  ok('★ 这一笔真的画进了它自己的图层', inkOrphan > 0, { ink: inkOrphan });

  /* ================================================================
   * ② 正在画的那一笔（BEGIN→POINTS→END）同样不许兜底
   * ================================================================ */
  console.log('\n=== ② 实时笔迹（BEGIN→POINTS→END）的同一场景 ===');
  const liveId = 'L-test-live-' + Date.now();
  const r3 = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    // 模拟另一端的实时作画消息先到
    e.beginStroke({ id: 's-live-1', layerId: lid, userId: 'someone-else', tool: 'brush',
      color: '#2244cc', size: 40, opacity: 1, hardness: 1, local: false });
    e.addPoints('s-live-1', [[300, 500, 0.5], [700, 500, 0.5]]);
    e.endStroke('s-live-1', 999998);
    return { orphans: e.orphanCount(), pending: e.pending.size };
  }, liveId);
  ok('★ 实时笔迹也进了挂起表', r3.orphans === 1, r3);
  ok('★ 没有半截笔迹卡在 pending 里', r3.pending === 0, r3);

  const r4 = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    e.addLayerMeta({ id: lid, name: '迟到图层2' });
    e.flushOrphanStrokes();
    const l = e.getLayer(lid);
    return { orphans: e.orphanCount(), strokes: l ? l.strokes.length : -1 };
  }, liveId);
  ok('★ 图层到了以后整条实时笔迹补落（含点）', r4.strokes === 1, r4);

  const inkLive = await layerInk(B, liveId);
  ok('★ 补落的实时笔迹有像素', inkLive > 0, { ink: inkLive });

  /* ================================================================
   * ③ CANCEL 过的孤儿笔迹不许诈尸
   * ================================================================ */
  console.log('\n=== ③ 被取消的孤儿笔迹不许在图层到达后补画 ===');
  const cancelId = 'L-test-cancel-' + Date.now();
  const r5 = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    e.beginStroke({ id: 's-cancel-1', layerId: lid, userId: 'x', tool: 'brush',
      color: '#000000', size: 20, opacity: 1, hardness: 1, local: false });
    e.addPoints('s-cancel-1', [[100, 100, 0.5]]);
    const before = e.orphanCount();
    e.cancelStroke('s-cancel-1');
    e.addLayerMeta({ id: lid, name: '取消测试层' });
    e.flushOrphanStrokes();
    const l = e.getLayer(lid);
    return { before: before, after: e.orphanCount(), strokes: l ? l.strokes.length : -1 };
  }, cancelId);
  ok('取消后挂起表里也没了', r5.before === 1 && r5.after === 0, r5);
  ok('★ 图层到达后没有补画那一笔', r5.strokes === 0, r5);

  /* ================================================================
   * ④ 端到端：新建图层 + 立刻作画，另一端必须看得见
   * ================================================================ */
  console.log('\n=== ④ 端到端：A 新建图层并立刻画，B 必须看得见 ===');
  await A.evaluate(() => window.ChaApp.setTool('brush'));
  await A.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#118833'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await A.fill('#sizeRange', '48');
  await sleep(250);

  // 新建图层 + 立刻落笔（不给 LAYER_ADD 先到的机会）
  const newLayerInfo = await A.evaluate(async () => {
    const e = window.ChaApp.engine;
    document.getElementById('btnAddLayer').click();
    await new Promise(r => setTimeout(r, 30));   // 故意只等一丁点
    return { id: e.activeLayerId, count: e.layers.length };
  });
  console.log('  A 新建图层:', newLayerInfo.id, ' 共', newLayerInfo.count, '层');

  const box = await A.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await A.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  const p0 = await mk(300, 780);
  await A.mouse.move(p0[0], p0[1]);
  await A.mouse.down();
  for (let i = 1; i <= 18; i++) {
    const x = 300 + (900 * i / 18);
    const p = await mk(x, 780);
    await A.mouse.move(p[0], p[1]);
    await sleep(16);
  }
  await A.mouse.up();
  await sleep(1400);

  const bHas = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    const l = e.getLayer(lid);
    return { exists: !!l, strokes: l ? l.strokes.length : -1, orphans: e.orphanCount() };
  }, newLayerInfo.id);
  console.log('  B 端:', JSON.stringify(bHas));
  ok('★ B 端认得出这一层', bHas.exists === true, bHas);
  ok('★ B 端收到并落下了笔迹', bHas.strokes >= 1, bHas);
  ok('★ B 端没有残留挂起笔迹', bHas.orphans === 0, bHas);

  const bInk = await layerInk(B, newLayerInfo.id);
  ok('★ B 端这一层真的有像素', bInk > 0, { ink: bInk });

  // 屏幕上也要能看见（这是用户实际抱怨的观感）
  const aView = await viewInkAll(A, 320, 740, 860, 90);
  const bView = await viewInkAll(B, 320, 740, 860, 90);
  console.log('  屏幕上该区域墨量  A:', aView, ' B:', bView);
  ok('★ 两端屏幕上都看得见（不再是「看不见某一图层」）', bView > 0 && Math.abs(aView - bView) / Math.max(1, aView) < 0.3,
    { aView, bView });

  /* ================================================================
   * ⑤ 远端改蒙版 / 剪贴：基底缓存必须失效
   * ================================================================ */
  console.log('\n=== ⑤ 蒙版状态变化必须让合成缓存失效 ===');
  const cacheTest = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    e.baseDirty = false; e.baseKey = '';
    e.rebuildBase();
    const k1 = e.baseKey;
    const l = e.getLayer(lid);
    // 模拟远端 LAYER_UPD：给这一层套上蒙版
    l.hasMask = true;
    e.ensureMask(l);
    e.baseDirty = false;                    // 故意不置脏 —— 只靠缓存键发现变化
    e.rebuildBase();
    const k2 = e.baseKey;
    return { k1: k1, k2: k2, changed: k1 !== k2 };
  }, newLayerInfo.id);
  ok('★ 套上蒙版后缓存键变了（否则那一层看着不会更新）', cacheTest.changed === true, cacheTest);

  const clipTest = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    const l = e.getLayer(lid);
    e.baseDirty = false;
    e.rebuildBase();
    const k1 = e.baseKey;
    l.clip = true;
    e.baseDirty = false;
    e.rebuildBase();
    const k2 = e.baseKey;
    l.clip = false;
    return { changed: k1 !== k2 };
  }, newLayerInfo.id);
  ok('★ 改成剪贴蒙版后缓存键也变了', clipTest.changed === true, clipTest);

  /* ================================================================
   * ⑥ 协作视图开着时，别人的笔迹也要原样补进来
   * ================================================================ */
  console.log('\n=== ⑥ 协作视图开着时补落笔迹（不丢、不重复） ===');
  const dimCase = await B.evaluate(() => {
    const e = window.ChaApp.engine;
    e.setDimMode('off');
    e.setUserDim('someone-else', 0.35);     // 只对某个人淡化 → dimOn() 为真
    const lid = 'L-dim-' + Date.now();
    const okDim = e.dimOn();
    e.addCommitted({ id: 's-dim-1', layerId: lid, userId: 'someone-else', tool: 'brush',
      color: '#000000', size: 30, opacity: 1, hardness: 1, points: [[200, 200, 0.5], [800, 200, 0.5]] });
    const orphaned = e.orphanCount();
    e.addLayerMeta({ id: lid, name: '淡化测试层' });
    e.flushOrphanStrokes();
    const l = e.getLayer(lid);
    const hasView = !!(l && l.viewCanvas);
    const viewInk = l && l.viewCanvas
      ? (() => {
          const d = l.viewCanvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
          let s = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) s++;
          return s;
        })()
      : -1;
    e.setUserDim('someone-else', null);
    e.setDimMode('off');
    return { okDim, orphaned, strokes: l ? l.strokes.length : -1, hasView, viewInk };
  });
  ok('只对某人淡化时 dimOn() 为真', dimCase.okDim === true, dimCase);
  ok('★ 淡化开着时笔迹照样被挂起', dimCase.orphaned === 1, dimCase);
  ok('★ 补落后进了图层', dimCase.strokes === 1, dimCase);
  ok('★ 显示副本（viewCanvas）也跟着建好了', dimCase.hasView === true && dimCase.viewInk > 0, dimCase);

  /* ================================================================
   * ⑦ 协作视图关掉后不许留着陈年 viewCanvas
   * ================================================================ */
  console.log('\n=== ⑦ 关掉协作视图后不许残留显示副本 ===');
  const staleCase = await B.evaluate((lid) => {
    const e = window.ChaApp.engine;
    const l = e.getLayer(lid);
    return { viewBefore: !!(l && l.viewCanvas) };
  }, newLayerInfo.id);
  const staleAfter = await B.evaluate(() => {
    const e = window.ChaApp.engine;
    // 收一笔远端笔迹：mirrorToView 在 dimOn() 为假时会把 viewCanvas 丢掉
    const l = e.layers[e.layers.length - 1];
    const mkStroke = { id: 's-stale-' + Date.now(), layerId: l.id, userId: 'z', tool: 'brush',
      color: '#000000', size: 20, opacity: 1, hardness: 1, points: [[400, 400, 0.5], [600, 400, 0.5]] };
    e.addCommitted(mkStroke);
    return { viewAfter: !!l.viewCanvas, dimOn: e.dimOn() };
  });
  ok('协作视图关着时 displayCanvas 直接吃 layer.canvas', staleAfter.dimOn === false, staleAfter);
  ok('★ 补笔后也没有残留 viewCanvas（不会有陈旧画面）', staleAfter.viewAfter === false, staleAfter);

  console.log('\n' + '='.repeat(52));
  console.log('  通过 ' + pass + '  /  失败 ' + fail);
  console.log('='.repeat(52));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
