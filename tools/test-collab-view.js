/**
 * 协作视图回归：他人笔触淡化/隐藏 + 图层「只对我隐藏」。
 *
 * 这两件事都是**纯本机显示效果**，所以测试的重点全是「边界」：
 *   · 屏幕上淡了，但文档（layer.canvas）和导出必须一点没变
 *   · 不同步：另一端看到的还是原样
 *   · 破坏类笔迹（橡皮）不能因为「淡化」就失效
 *   · 只有还没固化的笔迹能按人淡化（固化之后就是整层像素了）
 *
 * 用法: node tools/test-collab-view.js [http://localhost:8440]
 */
'use strict';
const { chromium } = require('./pw');

const URL = process.argv[2] || 'http://127.0.0.1:8440';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
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

/** 在文档坐标上画一笔（模拟真实落笔，会走完整协议） */
async function draw(page, path, opts) {
  const o = opts || {};
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  const p0 = await mk(path[0][0], path[0][1]);
  await page.mouse.move(p0[0], p0[1]);
  await page.mouse.down();
  const steps = o.steps || 16;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const seg = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
    const lt = t * (path.length - 1) - seg;
    const a = path[seg], b = path[Math.min(path.length - 1, seg + 1)];
    const p = await mk(a[0] + (b[0] - a[0]) * lt, a[1] + (b[1] - a[1]) * lt);
    await page.mouse.move(p[0], p[1]);
    await sleep(18);
  }
  await page.mouse.up();
  await sleep(o.after != null ? o.after : 700);
}

/** 文档里某个点的像素（取小方块里「最深」的那个，避开抗锯齿边缘带来的抖动） */
const docPx = (p, x, y) => p.evaluate(([a, b]) => {
  const e = window.ChaApp.engine;
  const d = e.renderDocument({}).ctx.getImageData(Math.round(a) - 6, Math.round(b) - 6, 13, 13).data;
  let best = [255, 255, 255, 0], score = 1e9;
  for (let i = 0; i < d.length; i += 4) {
    const s = d[i] + d[i + 1] + d[i + 2];
    if (s < score) { score = s; best = [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
  }
  return best;
}, [x, y]);

/** 屏幕上（#view 那块画布）某个文档坐标对应的像素（同样取最深的一个） */
const viewPx = (p, x, y) => p.evaluate(([a, b]) => {
  const e = window.ChaApp.engine;
  const s = e.docToScreen(a, b);
  const ctx = document.getElementById('view').getContext('2d');
  const d = ctx.getImageData(Math.round(s.x * e.dpr) - 6, Math.round(s.y * e.dpr) - 6, 13, 13).data;
  let best = [255, 255, 255, 0], score = 1e9;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] + d[i + 1] + d[i + 2];
    if (v < score) { score = v; best = [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
  }
  return best;
}, [x, y]);

/** 一块区域里「非白像素」的多少，用来量「淡了多少」 */
const viewInk = (p, x, y, w, h) => p.evaluate(([a, b, ww, hh]) => {
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
  const room = await createRoom(A, '小茶', '协作视图回归');
  const B = await newPage(browser);
  await join(B, room, '阿墨');
  await sleep(600);

  /* ================= A. 他人笔触 ================= */
  console.log('\n=== 准备画面：A 画红、B 画蓝（两条分开的横线） ===');

  await A.evaluate(() => window.ChaApp.setTool('brush'));
  await A.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#cc2222'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await A.fill('#sizeRange', '40');
  await sleep(200);
  await draw(A, [[200, 300], [1400, 300]], { steps: 20 });

  await B.evaluate(() => window.ChaApp.setTool('brush'));
  await B.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#2244cc'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await B.fill('#sizeRange', '40');
  await sleep(200);
  await draw(B, [[200, 600], [1400, 600]], { steps: 20 });
  await sleep(900);

  const aDoc = { red: await docPx(A, 800, 300), blue: await docPx(A, 800, 600) };
  const bDoc = { red: await docPx(B, 800, 300), blue: await docPx(B, 800, 600) };
  console.log('  A 端文档: 红线', JSON.stringify(aDoc.red), ' 蓝线', JSON.stringify(aDoc.blue));
  ok('两条线都画上了', aDoc.red[0] > 100 && aDoc.blue[2] > 100, aDoc);
  ok('两端文档一致（同一份画）',
    JSON.stringify(aDoc) === JSON.stringify(bDoc), { aDoc, bDoc });

  console.log('\n=== 默认是「原样」：屏幕 = 文档 ===');
  let st = await A.evaluate(() => ({
    dimMode: window.ChaApp.state.dimMode,
    dimOn: window.ChaApp.engine.dimOn(),
    label: (document.getElementById('qbDimOthers') || {}).textContent
  }));
  ok('默认档位是 off', st.dimMode === 'off' && st.dimOn === false, st);
  ok('快捷条上的按钮显示「原样」', st.label === '原样', st);

  const ink0 = { red: await viewInk(A, 300, 260, 1000, 90), blue: await viewInk(A, 300, 560, 1000, 90) };
  console.log('  屏幕上：红线墨量', ink0.red, ' 蓝线墨量', ink0.blue);
  ok('自己的线和别人的线一样实', Math.abs(ink0.red - ink0.blue) / ink0.red < 0.1, ink0);

  console.log('\n=== 切到「淡」：别人的线变淡，自己的不动 ===');
  await A.evaluate(() => window.ChaApp.setDimMode('soft'));
  await sleep(600);
  let ink1 = { red: await viewInk(A, 300, 260, 1000, 90), blue: await viewInk(A, 300, 560, 1000, 90) };
  console.log('  屏幕上：红线墨量', ink1.red, ' 蓝线墨量', ink1.blue);
  ok('自己的红线没变', Math.abs(ink1.red - ink0.red) / ink0.red < 0.06, { before: ink0.red, after: ink1.red });
  ok('别人的蓝线明显淡了（大概只剩一半）',
    ink1.blue < ink0.blue * 0.65 && ink1.blue > ink0.blue * 0.25,
    { before: ink0.blue, after: ink1.blue });

  let doc1 = { red: await docPx(A, 800, 300), blue: await docPx(A, 800, 600) };
  ok('★ 文档一点没变（淡的只是屏幕）',
    JSON.stringify(doc1) === JSON.stringify(aDoc), { before: aDoc, after: doc1 });
  let exp = await A.evaluate(() => {
    const c = window.ChaApp.engine.exportPNG();
    return c.length;
  });
  ok('导出还在（能拿到 PNG）', exp > 1000, exp);
  // 这里必须和 docPx 用同一套采法（13×13 取最深）。
  // 曾经写的是「取 (800,600) 单个像素」，而 aDoc 取的是小方块里最深的一个 ——
  // 单像素是不是落在最深那条上全看亚像素栅格化，于是这条断言随机失败
  // （实测同一份代码 4 次能挂 2 次，报出来的蓝色值每次都不一样）。
  const blueInExport = await docPx(A, 800, 600);
  ok('★ 导出 / 固化用的还是满强度的别人的笔',
    blueInExport[2] > 100 && blueInExport[2] === aDoc.blue[2], blueInExport);

  console.log('\n=== 另一端不受影响 ===');
  const bInk = await viewInk(B, 300, 560, 1000, 90);
  ok('B 那边看到的蓝线还是原样（设置没有同步过去）',
    Math.abs(bInk - ink0.blue) / ink0.blue < 0.08, { b: bInk, 原始: ink0.blue });

  console.log('\n=== 「很淡」和「隐藏」 ===');
  await A.evaluate(() => window.ChaApp.setDimMode('faint'));
  await sleep(600);
  const inkFaint = await viewInk(A, 300, 560, 1000, 90);
  ok('很淡档：几乎看不见了', inkFaint < ink0.blue * 0.2, { 原样: ink0.blue, 很淡: inkFaint });

  await A.evaluate(() => window.ChaApp.setDimMode('hide'));
  await sleep(600);
  const inkHide = await viewInk(A, 300, 560, 1000, 90);
  const redHide = await viewInk(A, 300, 260, 1000, 90);
  console.log('  隐藏档：蓝线墨量', inkHide, ' 红线墨量', redHide);
  ok('隐藏档：别人的线彻底没了', inkHide < 0.6, inkHide);
  ok('隐藏档：自己的线照旧', Math.abs(redHide - ink0.red) / ink0.red < 0.06, redHide);

  console.log('\n=== 隐藏档下，别人的橡皮仍然要生效（不然「看到的」和「文档里的」会对不上） ===');
  await B.evaluate(() => window.ChaApp.setTool('eraser'));
  await B.fill('#sizeRange', '90');
  await sleep(200);
  await draw(B, [[700, 300], [900, 300]], { steps: 10 });
  await sleep(900);
  const redAfterErase = await docPx(A, 800, 300);
  const redViewAfterErase = await viewInk(A, 700, 260, 300, 90);
  const redViewElsewhere = await viewInk(A, 300, 260, 300, 90);
  console.log('  文档上被擦的位置', JSON.stringify(redAfterErase), ' 屏幕上该处墨量', redViewAfterErase, ' 别处', redViewElsewhere);
  ok('别人的橡皮在文档里擦掉了我的红线（露出白底）',
    redAfterErase[0] > 240 && redAfterErase[2] > 240, redAfterErase);
  ok('★ 屏幕上也被擦掉了（没有「文档空了但屏幕还在」）',
    redViewAfterErase < redViewElsewhere * 0.3, { 擦拭处: redViewAfterErase, 别处: redViewElsewhere });

  console.log('\n=== 切回「原样」：一切复原 ===');
  await A.evaluate(() => window.ChaApp.setDimMode('off'));
  await sleep(600);
  const blueBack = await viewInk(A, 300, 560, 1000, 90);
  const docBack = await docPx(A, 800, 600);
  ok('别人的线又实了', Math.abs(blueBack - ink0.blue) / ink0.blue < 0.06, { 原样: ink0.blue, 回来: blueBack });
  ok('文档依旧没变过', JSON.stringify(docBack) === JSON.stringify(aDoc.blue), docBack);

  console.log('\n=== 成员面板里单独设某个人 ===');
  const mem = await A.evaluate(() => {
    const btn = document.querySelector('#memberList .member .m-dim');
    if (!btn) return { has: false };
    const before = btn.textContent;
    btn.click();
    return { has: true, before, after: btn.textContent };
  });
  await sleep(700);
  console.log('  成员面板上的按钮:', JSON.stringify(mem));
  ok('成员面板里每个人都有一个「笔迹显示」按钮', mem.has === true, mem);
  const inkPer = await viewInk(A, 300, 560, 1000, 90);
  ok('点一下之后那个人的线变淡了（即使全局是「原样」）',
    inkPer < ink0.blue * 0.9, { 原样: ink0.blue, 单人设置后: inkPer });

  console.log('\n=== 设置记在本地 ===');
  await A.evaluate(() => window.ChaApp.setDimMode('soft'));
  await sleep(400);
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await sleep(600);
  const afterReload = await A.evaluate(() => ({
    dimMode: window.ChaApp.state.dimMode,
    engineMode: window.ChaApp.engine.dimMode,
    users: Object.keys(window.ChaApp.state.dimUsers).length
  }));
  ok('刷新之后档位还在', afterReload.dimMode === 'soft' && afterReload.engineMode === 'soft', afterReload);
  ok('按人设的那份也还在', afterReload.users === 1, afterReload);
  await A.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.setDimMode('off');
    window.ChaApp.state.dimUsers = {};
    window.ChaApp.setUserDim(Object.keys(window.ChaApp.state.dimUsers)[0], null);
  });
  await sleep(400);

  /* ================= B. 图层「只对我隐藏」 ================= */
  console.log('\n=== 图层「只对我隐藏」（第二只眼睛） ===');
  const eyeInfo = await A.evaluate(() => {
    const row = document.querySelector('#layerList .layer-item');
    if (!row) return { has: false };
    const eyes = row.querySelectorAll('button.eye');
    return { has: true, count: eyes.length, mine: !!row.querySelector('.eye.mine-eye') };
  });
  console.log('  ' + JSON.stringify(eyeInfo));
  ok('图层条上有两只眼睛（同步显示 / 只对我隐藏）', eyeInfo.has && eyeInfo.count === 2 && eyeInfo.mine, eyeInfo);

  const layerId = await A.evaluate(() => window.ChaApp.engine.activeLayerId);
  const beforeAll = { A: await viewInk(A, 300, 260, 1000, 90), B: await viewInk(B, 300, 260, 1000, 90) };

  const toggled = await A.evaluate(async () => {
    const row = document.querySelector('#layerList .layer-item');
    const mine = row.querySelector('.eye.mine-eye');
    const sent = [];
    const orig = window.ChaApp.net.send.bind(window.ChaApp.net);
    window.ChaApp.net.send = function (t, p) { sent.push(t); return orig(t, p); };
    mine.click();
    await new Promise(r => setTimeout(r, 500));
    window.ChaApp.net.send = orig;
    return {
      localHidden: window.ChaApp.engine.localHiddenCount(),
      rowClass: document.querySelector('#layerList .layer-item').className,
      visibleFlag: window.ChaApp.engine.activeLayer().visible,
      sentToServer: sent
    };
  });
  console.log('  ' + JSON.stringify(toggled));
  await sleep(600);
  const afterLocal = { A: await viewInk(A, 300, 260, 1000, 90), B: await viewInk(B, 300, 260, 1000, 90) };
  console.log('  隐藏前  A:', JSON.stringify(beforeAll), ' 隐藏后 A:', JSON.stringify(afterLocal));
  ok('A 屏幕上这一层没了', afterLocal.A < beforeAll.A * 0.15, { before: beforeAll.A, after: afterLocal.A });
  ok('★ 图层本身的 visible 没被改（不是「对所有人隐藏」）', toggled.visibleFlag === true, toggled);
  ok('★ 一个消息都没发给服务端（纯本地）', toggled.sentToServer.length === 0, toggled.sentToServer);
  ok('图层条上有「只我」的标记', /local-hidden-layer/.test(toggled.rowClass), toggled.rowClass);
  ok('★ 另一端完全不受影响', Math.abs(afterLocal.B - beforeAll.B) / beforeAll.B < 0.08,
    { before: beforeAll.B, after: afterLocal.B });

  console.log('\n=== 本地隐藏不影响导出 ===');
  const exportInk = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const doc = e.renderDocument({}).ctx.getImageData(800, 300, 1, 1).data;
    return [doc[0], doc[1], doc[2], doc[3]];
  });
  ok('导出 / 固化里这一层照样在', exportInk[0] > 100, exportInk);

  console.log('\n=== 再点一下恢复，菜单里也能清空 ===');
  await A.evaluate(() => {
    document.querySelector('#layerList .layer-item .eye.mine-eye').click();
  });
  await sleep(600);
  const backInk = await viewInk(A, 300, 260, 1000, 90);
  ok('再点一下恢复显示', Math.abs(backInk - beforeAll.A) / beforeAll.A < 0.08, { before: beforeAll.A, after: backInk });

  const menuClear = await A.evaluate(async () => {
    window.ChaApp.toggleLocalHideActive();
    await new Promise(r => setTimeout(r, 400));
    const hidden = window.ChaApp.engine.localHiddenCount();
    window.ChaApp.clearLocalHiddenUi();
    await new Promise(r => setTimeout(r, 400));
    return { hidden, after: window.ChaApp.engine.localHiddenCount() };
  });
  ok('菜单「只对我隐藏」能开', menuClear.hidden === 1, menuClear);
  ok('菜单「取消所有」能清', menuClear.after === 0, menuClear);

  console.log('\n=== 重放保真：渐变 / 涂抹撤销重做之后要还原得回来 ===');
  // 「他人笔触」是靠**重放笔迹**画出来的，所以重放本身必须和「刚画完」一致。
  // 以前 applyStrokeToLayer 漏了渐变和涂抹：撤销再重做，渐变会整个消失。
  const grad = await A.evaluate(async () => {
    const e = window.ChaApp.engine;
    window.ChaApp.addLayer();
    await new Promise(r => setTimeout(r, 900));
    const l = e.activeLayer();
    l.baseImage = null; l.baseSeq = 0; l.strokes = [];
    e.renderLayerFromHistory(l);
    e.setActiveLayer(l.id);
    return { layer: l.name };
  });
  await sleep(600);
  await A.evaluate(() => {
    const el = document.querySelector('#brushGrid .tool[data-item="gradient"], #toolGrid .tool[data-item="gradient"]');
    if (el) el.click();
  });
  await sleep(300);
  await A.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#2288ff'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const inkOfLayer = () => A.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 11) if (d[i] > 8) n++;
    return n;
  });
  await draw(A, [[300, 800], [1300, 900]], { steps: 12 });
  const g1 = await inkOfLayer();
  await A.keyboard.press('Control+z');
  await sleep(900);
  await A.keyboard.press('Control+y');
  await sleep(1400);
  const g2 = await inkOfLayer();
  console.log('  渐变：画完', g1, ' 撤销重做后', g2);
  ok('渐变撤销重做之后还在（重放保真）', g1 > 200 && g2 >= g1 * 0.9, { 画完: g1, 重做后: g2 });
  void grad;

  console.log('\n=== 同步的「显示 / 隐藏」没被搞坏 ===');
  const syncHide = await A.evaluate(async () => {
    // 点第一行的眼睛 —— 但要对**那一行对应的图层**断言（这轮已经有两层了，
    // 第一行不一定就是当前图层）
    const row = document.querySelector('#layerList .layer-item');
    const id = row.dataset.id;
    const before = window.ChaApp.engine.getLayer(id).visible;
    row.querySelector('.eye').click();
    await new Promise(r => setTimeout(r, 1000));
    return { id, before, after: window.ChaApp.engine.getLayer(id).visible };
  });
  await sleep(900);
  const bSync = await B.evaluate((id) => window.ChaApp.engine.getLayer(id).visible, syncHide.id);
  ok('同步隐藏仍然会改 visible', syncHide.before !== syncHide.after, syncHide);
  ok('同步隐藏仍然会同步到另一端', bSync === syncHide.after, { a: syncHide.after, b: bSync });
  // 收尾：还原，免得影响别的测试
  await A.evaluate((arg) => {
    const e = window.ChaApp.engine;
    const l = e.getLayer(arg[0]);
    if (l) l.visible = arg[1];
    e.baseDirty = true; e.baseKey = ''; e.invalidate();
  }, [syncHide.id, syncHide.before]);
  await sleep(400);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
