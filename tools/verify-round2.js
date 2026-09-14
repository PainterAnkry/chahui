/**
 * 第二轮验收：选区修复 / 导航器方框 / 图像大小 / 图像变换。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'screenshots', 'probe');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '验收2');
  await page.fill('#newRoomName', '第二轮验收');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  const eng = () => page.evaluate(() => {
    const e = window.ChaApp.engine, s = window.ChaApp.state;
    return {
      strokes: e.strokes.length, seq: e.seq, undo: s.myUndo.length,
      sel: e.hasSelection(), transforming: !!e.transform,
      w: e.width, h: e.height,
      layerPx: (() => {
        const l = e.activeLayer();
        const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      })()
    };
  });

  /* ============ [3] 导航器方框 ============ */
  console.log('\n=== [3] 导航器取景框 ===');
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  const navFit = await page.evaluate(() => {
    const r = document.querySelector('#navRect');
    const cv = document.querySelector('#navCanvas').getBoundingClientRect();
    return { display: getComputedStyle(r).display, cvW: Math.round(cv.width), cvH: Math.round(cv.height) };
  });
  console.log('  适应窗口时 navRect:', JSON.stringify(navFit));
  check('整幅画都可见时不画取景框', navFit.display === 'none', navFit.display);

  await page.evaluate(() => { const e = document.querySelector('#zoomRange'); e.value = 400; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  const navZoom = await page.evaluate(() => {
    const r = document.querySelector('#navRect');
    const rr = r.getBoundingClientRect();
    const cv = document.querySelector('#navCanvas').getBoundingClientRect();
    return {
      display: getComputedStyle(r).display,
      w: Math.round(rr.width), h: Math.round(rr.height),
      cvW: Math.round(cv.width), cvH: Math.round(cv.height),
      inside: rr.left >= cv.left - 1 && rr.right <= cv.right + 1 && rr.top >= cv.top - 1 && rr.bottom <= cv.bottom + 1
    };
  });
  console.log('  放大后 navRect:', JSON.stringify(navZoom));
  check('放大后取景框出现', navZoom.display !== 'none');
  check('取景框不超出缩略图范围', navZoom.inside && navZoom.w <= navZoom.cvW + 1 && navZoom.h <= navZoom.cvH + 1,
    navZoom.w + '×' + navZoom.h + ' vs 画布 ' + navZoom.cvW + '×' + navZoom.cvH);

  /* ============ [选区] ============ */
  console.log('\n=== [选区：选取笔 / 选取擦 / 撤销栈不被污染] ===');
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  await page.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await sleep(150);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 60; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const b1 = await mk(400, 300), b2 = await mk(1200, 700);
  await page.mouse.move(b1[0], b1[1]);
  await page.mouse.down();
  await page.mouse.move(b2[0], b2[1], { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  let s = await eng();
  console.log('  画一笔后: strokes=' + s.strokes + ' seq=' + s.seq + ' undo=' + s.undo);
  const seqBefore = s.seq, undoBefore = s.undo;

  await page.click('#toolGrid .tool[data-item="select"], #brushGrid .tool[data-item="select"]');
  await sleep(200);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 40; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const c1 = await mk(700, 400), c2 = await mk(1000, 600);
  await page.mouse.move(c1[0], c1[1]);
  await page.mouse.down();
  await page.mouse.move(c2[0], c2[1], { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  s = await eng();
  console.log('  框选后: sel=' + s.sel + ' strokes=' + s.strokes + ' seq=' + s.seq + ' undo=' + s.undo);
  check('选取笔画出了选区', s.sel === true);
  check('选区笔不占用撤销栈', s.undo === undoBefore, `${undoBefore} → ${s.undo}`);
  check('选区笔不虚增 engine.seq（固化水位）', s.seq === seqBefore, `${seqBefore} → ${s.seq}`);

  // 选区外落笔 → 应给出提示
  await page.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await sleep(200);
  const o1 = await mk(150, 150), o2 = await mk(260, 200);
  await page.evaluate(() => { document.querySelectorAll('#toastWrap .toast').forEach(t => t.remove()); });
  await page.mouse.move(o1[0], o1[1]);
  await page.mouse.down();
  await page.mouse.move(o2[0], o2[1], { steps: 5 });
  await page.mouse.up();
  await sleep(700);
  const toastTxt = await page.evaluate(() => Array.from(document.querySelectorAll('#toastWrap .toast')).map(t => t.textContent).join(' | '));
  console.log('  选区外落笔后的提示:', JSON.stringify(toastTxt));
  check('选区外落笔会明确提示（不是「画布坏了」）', /选区/.test(toastTxt), toastTxt);

  // 选区擦：擦掉一块，掩膜像素数必须变少（比对比包围盒可靠 —— 擦中间不动边界时 bbox 不变）
  await page.click('#toolGrid .tool[data-item="selectErase"], #brushGrid .tool[data-item="selectErase"]');
  await sleep(200);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 90; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const maskPx = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.selection.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  const beforeMask = await maskPx();
  const toolNow = await page.evaluate(() => ({ tool: window.ChaApp.state.tool, brushId: window.ChaApp.state.brushId, sel: window.ChaApp.engine.hasSelection() }));
  console.log('  擦之前: maskPx=' + beforeMask + ' ' + JSON.stringify(toolNow));
  // 蚂蚁线要在**还有选区的时候**看。
  // 以前这条检查放在「擦掉选区」之后，靠的是擦不干净留下的残影 —— 一旦擦干净了就会误报。
  const ants = await page.evaluate(() => !!window.ChaApp.engine._antsTimer);
  check('选区蚂蚁线动画在跑', ants === true, String(ants));
  // 沿着选区自己那条线擦 —— 保证一定压到掩膜上（斜着擦很容易擦到旁边空白处，
  // 那样掩膜当然不变，会误判成「选取擦没用」）
  const e1 = await mk(700, 400), e2 = await mk(1000, 600);
  await page.mouse.move(e1[0], e1[1]);
  await page.mouse.down();
  await page.mouse.move(e2[0], e2[1], { steps: 12 });
  await page.mouse.up();
  await sleep(700);
  const afterMask = await maskPx();
  console.log('  选区擦掩膜像素: ' + beforeMask + ' → ' + afterMask);
  check('选取擦真的擦掉了选区', afterMask < beforeMask * 0.9, `${beforeMask} → ${afterMask}`);

  // 蚂蚁线（上面已经查过了，这里只确认取消选区后停下）
  const antsAfterClear = await page.evaluate(() => !!window.ChaApp.engine._antsTimer);
  check('擦空选区后蚂蚁线停下', antsAfterClear === false, String(antsAfterClear));
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  console.log('  状态栏「有选区」点击可取消:', await page.evaluate(() => !!document.querySelector('#selHint')));

  /* ============ [2] 图像大小 ============ */
  console.log('\n=== [2] 图像大小弹窗 ===');
  await page.evaluate(() => document.querySelector('#btnCanvas').click());
  await sleep(400);
  const dlg = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    return {
      title: q('#confirmTitle').textContent,
      hasW: !!q('#rsW'), hasH: !!q('#rsH'), hasDpi: !!q('#rsDpi'),
      hasFilter: !!q('#rsFilter'), hasRatio: !!q('#rsRatio'), hasLock: !!q('#rsLockPx'),
      hasDisp: !!q('#rsUnitDisp'), hasDpiDisp: !!q('#rsDpiDisp'),
      beforePx: q('#rsBeforePx').textContent, beforePrint: q('#rsBeforePrint').textContent,
      afterPx: q('#rsAfterPx').textContent, afterPrint: q('#rsAfterPrint').textContent
    };
  });
  console.log('  ' + JSON.stringify(dlg, null, 0));
  check('弹窗标题是「图像大小」', dlg.title === '图像大小', dlg.title);
  check('控件齐全（宽/高/dpi/重新取样/约束比/锁定像素/显示单位）',
    dlg.hasW && dlg.hasH && dlg.hasDpi && dlg.hasFilter && dlg.hasRatio && dlg.hasLock && dlg.hasDisp && dlg.hasDpiDisp);
  check('「更改前」显示了像素与打印尺寸', /\d+ × \d+/.test(dlg.beforePx) && /mm/.test(dlg.beforePrint), dlg.beforePrint);

  // 改宽度 → 更改后实时刷新
  await page.evaluate(() => {
    const w = document.querySelector('#rsW');
    w.value = 2000; w.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  const afterEdit = await page.evaluate(() => document.querySelector('#rsAfterPx').textContent);
  console.log('  宽度改 2000 后「更改后」:', afterEdit);
  check('「更改后」实时跟随输入', /2000/.test(afterEdit), afterEdit);

  // 约束长宽比
  await page.evaluate(() => {
    const c = document.querySelector('#rsRatio');
    c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    const w = document.querySelector('#rsW');
    w.value = 3200; w.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  const ratioRes = await page.evaluate(() => ({ w: document.querySelector('#rsW').value, h: document.querySelector('#rsH').value }));
  console.log('  约束长宽比 3200 →', JSON.stringify(ratioRes));
  check('约束长宽比会联动高度', Number(ratioRes.h) > 0 && Math.abs(Number(ratioRes.w) / Number(ratioRes.h) - 1.6) < 0.15,
    ratioRes.w + ':' + ratioRes.h);

  // 应用「无（只改画布尺寸）」
  await page.evaluate(() => {
    const c = document.querySelector('#rsRatio'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
    const f = document.querySelector('#rsFilter'); f.value = 'none'; f.dispatchEvent(new Event('change', { bubbles: true }));
    const w = document.querySelector('#rsW'); w.value = 1280; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.querySelector('#rsH'); h.value = 800; h.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector('#confirmYes').click());
  await page.waitForFunction(() => window.ChaApp.state.room && window.ChaApp.state.room.width === 1280, { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  s = await eng();
  console.log('  应用后: 画布=' + s.w + '×' + s.h);
  check('画布尺寸已改为 1280×800', s.w === 1280 && s.h === 800, s.w + '×' + s.h);
  check('改尺寸后内容仍在（未缩放模式保留原像素）', s.layerPx > 100, 'layerPx=' + s.layerPx);

  /* ============ [6] 图像变换 ============ */
  console.log('\n=== [6] 图像变换 ===');
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  const box2 = await page.locator('#view').boundingBox();
  const mk2 = async (x, y) => {
    const p = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box2.x + p.x, box2.y + p.y];
  };
  // 全选，然后变换整层
  await page.evaluate(() => document.querySelector('#btnSelAll').click());
  await sleep(400);
  const pxBeforeTransform = (await eng()).layerPx;   // 变换前的像素数（变换中图层是被挖空的，不能那时取）
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(600);
  const tpOn = await page.evaluate(() => ({
    panel: !document.querySelector('#transformPanel').classList.contains('hidden'),
    active: !!window.ChaApp.engine.transform,
    quad: window.ChaApp.engine.transform && window.ChaApp.engine.transform.quad
  }));
  console.log('  变换已开始:', JSON.stringify({ panel: tpOn.panel, active: tpOn.active }));
  check('变换面板出现且会话已建立', tpOn.panel && tpOn.active);

  // 拖东北角往内缩
  const q = tpOn.quad;
  const from = await mk2(q[1].x, q[1].y);
  const to = await mk2(q[1].x - 200, q[1].y + 120);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const q2 = await page.evaluate(() => window.ChaApp.engine.transform.quad);
  console.log('  拖角前 NE=' + JSON.stringify(q[1]) + '  拖角后 NE=' + JSON.stringify(q2[1]));
  check('拖动角能改变变换框', Math.abs(q2[1].x - q[1].x) > 50, JSON.stringify(q2[1]));
  await page.screenshot({ path: path.join(OUT, 'p4-transform.png') });

  // 透视滑块
  await page.evaluate(() => {
    const r = document.querySelector('#tpPersp');
    r.value = 40; r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const persp = await page.evaluate(() => window.ChaApp.engine.transform.persp);
  check('透视滑块生效', persp === 40, String(persp));

  // 90° 旋转 + 翻转
  const quadBox = () => page.evaluate(() => {
    const q = window.ChaApp.engine.transform.quad;
    const xs = q.map(function (p) { return p.x; }), ys = q.map(function (p) { return p.y; });
    return {
      w: Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)),
      h: Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys)),
      cx: Math.round((Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2),
      cy: Math.round((Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2)
    };
  });
  const qb0 = await quadBox();
  await page.evaluate(() => document.querySelector('#tpRot90cw').click());
  await sleep(300);
  const qb1 = await quadBox();
  await page.evaluate(() => document.querySelector('#tpHFlip').click());
  await sleep(300);
  const qb2 = await quadBox();
  const srcSize = await page.evaluate(() => {
    // 浮层是「裁到选区大小」的 buf（以前是整幅文档的 src）。
    // 注意：翻转 / 90° 旋转**只动变换框**，不动 buf（两边都动会互相抵消 —— 那是之前的 bug）。
    const t = window.ChaApp.engine.transform;
    return { bufW: t.buf.width, bufH: t.buf.height };
  });
  console.log('  变换框: 旋转前 ' + qb0.w + '×' + qb0.h + ' → 旋转后 ' + qb1.w + '×' + qb1.h +
    ' → 翻转后 ' + qb2.w + '×' + qb2.h + '   浮层 ' + srcSize.bufW + '×' + srcSize.bufH);
  check('90° 旋转后变换框宽高互换（中心不变）',
    Math.abs(qb1.w - qb0.h) <= 3 && Math.abs(qb1.h - qb0.w) <= 3 && Math.abs(qb1.cx - qb0.cx) <= 4,
    qb0.w + '×' + qb0.h + ' → ' + qb1.w + '×' + qb1.h);
  check('水平翻转后变换框外接尺寸不变',
    Math.abs(qb2.w - qb1.w) <= 3 && Math.abs(qb2.h - qb1.h) <= 3,
    qb1.w + '×' + qb1.h + ' → ' + qb2.w + '×' + qb2.h);

  // 中止 → 画面还原
  const pxDuring = (await eng()).layerPx;    // 变换中：源像素被「拿起来」了，图层是空的
  await page.evaluate(() => document.querySelector('#tpCancel').click());
  await sleep(700);
  const pxAfterCancel = (await eng()).layerPx;
  console.log('  中止: 变换中 layerPx=' + pxDuring + ' → 中止后 ' + pxAfterCancel + '（变换前 ' + pxBeforeTransform + '）');
  check('中止后变换会话结束', (await page.evaluate(() => !!window.ChaApp.engine.transform)) === false);
  check('变换中源像素确实被拿起来了', pxDuring < pxBeforeTransform * 0.1, `${pxBeforeTransform} → ${pxDuring}`);
  check('中止后画面像素被完整还原', Math.abs(pxAfterCancel - pxBeforeTransform) / Math.max(1, pxBeforeTransform) < 0.05,
    `${pxBeforeTransform} → ${pxAfterCancel}`);

  // 再来一次，这次确定
  await page.evaluate(() => document.querySelector('#btnSelAll').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(600);
  const q3 = await page.evaluate(() => window.ChaApp.engine.transform.quad);
  const f3 = await mk2(q3[2].x, q3[2].y);
  const t3 = await mk2(q3[2].x - 240, q3[2].y - 160);
  await page.mouse.move(f3[0], f3[1]);
  await page.mouse.down();
  await page.mouse.move(t3[0], t3[1], { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const pxScale = (await eng()).layerPx;
  await page.evaluate(() => document.querySelector('#tpApply').click());
  await sleep(1500);
  const done = await eng();
  console.log('  确定后: transforming=' + done.transforming + ' layerPx=' + done.layerPx + ' undo=' + done.undo);
  check('确定后变换会话结束', done.transforming === false);
  check('确定后图层有变换后的像素', done.layerPx > 50, 'layerPx=' + done.layerPx);
  await page.screenshot({ path: path.join(OUT, 'p4-transform-done.png') });

  // 另一端能看到（像素级）—— 用 HTTP 拉一次房间状态确认服务端存了 baseImage
  await sleep(800);
  const srv = await page.evaluate(async () => {
    const r = await fetch('/api/rooms').then(x => x.json());
    const me = r.rooms.find(x => x.id === window.ChaApp.state.room.id);
    return me ? { strokes: me.strokes } : null;
  });
  console.log('  服务端房间状态:', JSON.stringify(srv));
  check('变换把该图层笔迹并入了像素（服务端笔迹数归零）', !!srv && srv.strokes === 0, JSON.stringify(srv));

  console.log('\n页面错误:', errs.length ? errs.join(' | ') : '无');
  check('运行期间无 JS 报错', errs.length === 0, errs.join(' | '));

  /* ============ [6'] 变换结果能否同步到另一端 ============ */
  console.log('\n=== [6\'] 变换结果的跨端同步 ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const pageB = await ctx2.newPage();
  const errsB = [];
  pageB.on('pageerror', e => errsB.push('B pageerror: ' + e.message));
  await pageB.goto(BASE + '/?room=' + (await page.evaluate(() => window.ChaApp.state.room.id)), { waitUntil: 'domcontentloaded' });
  await pageB.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 }).catch(() => {});
  await sleep(1500);

  const layerPxB = () => pageB.evaluate(() => {
    const e = window.ChaApp.engine;
    if (!e.layers.length) return -1;
    const l = e.layers[e.layers.length - 1];
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  const pxB0 = await layerPxB();
  console.log('  B 端变换前像素 =', pxB0);

  // A 端再做一次变换（选区 = 全选），确定
  await page.evaluate(() => document.querySelector('#btnSelAll').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(500);
  await page.evaluate(() => {
    const r = document.querySelector('#tpPersp');
    r.value = 60; r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await page.evaluate(() => document.querySelector('#tpApply').click());
  await sleep(2500);
  const pxA = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  const pxB1 = await layerPxB();
  console.log('  A 端变换后像素 =', pxA, '  B 端 =', pxB1);
  check('B 端收到了变换后的像素', pxB1 > 0 && Math.abs(pxB1 - pxA) / Math.max(1, pxA) < 0.06,
    `A=${pxA} B=${pxB1}`);
  check('B 端没有报错', errsB.length === 0, errsB.join(' | '));
  await ctx2.close();

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
