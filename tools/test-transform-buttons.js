/**
 * 变换按钮的像素级验证。
 *
 * 判据：在选区左上角画一个记号，源图的 (u0,v0) 处。变换框把 (u,v) 映射到
 * bilerp(quad,u,v)，所以**记号的质心应该落在 bilerp(quad,u0,v0) 附近**。
 * 这样不用手工推每个按钮的期望位置，翻转/旋转/缩放都能用同一套判据。
 *
 * 用法: node tools/test-transform-buttons.js
 */
'use strict';
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

const SEL = { x: 400, y: 300, w: 400, h: 300 };
const MARK = { x: SEL.x + 50, y: SEL.y + 50 };      // 记号中心（文档坐标）
const U0 = (MARK.x - SEL.x) / SEL.w, V0 = (MARK.y - SEL.y) / SEL.h;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8437/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '变换');
  await page.fill('#newRoomName', '变换按钮验证');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoom100').click());
  await sleep(400);

  const setup = () => page.evaluate(([sel, mark]) => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0);
      l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
    e.pending.clear();
    const st = e.beginStroke({
      id: 'mark', layerId: e.activeLayerId, tool: 'brush', color: '#000000',
      size: 40, opacity: 1, hardness: 1, minSize: 1, pressSize: 0, pressOpacity: 0,
      seed: 1, brush: 'pencil', points: []
    });
    e.addPoints(st.id, [[mark.x, mark.y, 0.5], [mark.x + 1, mark.y + 1, 0.5]]);
    e.endStroke(st.id, e.seq + 1);
    // 选区直接写进蒙版，省得受选区工具影响
    const s = e.ensureSelection();
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, e.width, e.height);
    s.ctx.fillStyle = '#ffffff';
    s.ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
    s.active = true;
    e.refreshSelectionTint();
    e.emit('selection', { active: true });
    e.invalidate();
    const c = document.querySelector('#tpAuto');
    if (c) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }, [SEL, MARK]);

  /** 墨迹质心 */
  const centroid = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < e.height; y++) {
      for (let x = 0; x < e.width; x++) {
        if (d[(y * e.width + x) * 4 + 3] > 40) { sx += x; sy += y; n++; }
      }
    }
    return n ? { x: +(sx / n).toFixed(1), y: +(sy / n).toFixed(1), n: n } : null;
  });

  /** 变换框把 (u,v) 映射到哪 */
  const mapUV = (u, v) => page.evaluate(([u0, v0]) => {
    const q = window.ChaApp.engine.transform.effectiveQuad();
    function bilerp(u, v) {
      const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
      const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
      return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
    }
    return bilerp(u0, v0);
  }, [u, v]);

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  async function run(label, btn) {
    await setup();
    await sleep(250);
    const before = await centroid();
    await page.evaluate(() => document.querySelector('#btnTransform').click());
    await sleep(600);
    await page.evaluate((b) => document.querySelector(b).click(), btn);
    await sleep(350);
    const expect = await mapUV(U0, V0);
    const quad = await page.evaluate(() => window.ChaApp.engine.transform.effectiveQuad().map(function (p) { return [Math.round(p.x), Math.round(p.y)]; }));
    await page.evaluate(() => document.querySelector('#tpApply').click());
    await sleep(1300);
    const after = await centroid();
    const d = after ? dist(after, expect) : -1;
    console.log('  ' + label.padEnd(11) +
      ' 记号 ' + (before ? Math.round(before.x) + ',' + Math.round(before.y) : '-') +
      '  →  ' + (after ? Math.round(after.x) + ',' + Math.round(after.y) : '没了') +
      '   框期望 ' + Math.round(expect.x) + ',' + Math.round(expect.y) +
      '   偏差 ' + d.toFixed(1) + 'px   框=' + JSON.stringify(quad));
    return { before: before, after: after, expect: expect, d: d, quad: quad };
  }

  console.log('=== 变换按钮（记号在选区的 ' + (U0 * 100).toFixed(0) + '%, ' + (V0 * 100).toFixed(0) + '% 处） ===');

  let r = await run('水平翻转', '#tpHFlip');
  check('水平翻转：内容按变换框就地镜像', r.after && r.d < 45, '偏差 ' + r.d.toFixed(1) + 'px');
  check('水平翻转：框仍在原选区位置',
    Math.abs(Math.min.apply(null, r.quad.map(p => p[0])) - SEL.x) < 3, JSON.stringify(r.quad));

  r = await run('垂直翻转', '#tpVFlip');
  check('垂直翻转：内容按变换框就地镜像', r.after && r.d < 45, '偏差 ' + r.d.toFixed(1) + 'px');
  check('垂直翻转：框仍在原选区位置',
    Math.abs(Math.min.apply(null, r.quad.map(p => p[1])) - SEL.y) < 3, JSON.stringify(r.quad));

  r = await run('顺时针90°', '#tpRot90cw');
  check('顺时针 90°：内容真的转了 90°（质心落在期望位置）', r.after && r.d < 50, '偏差 ' + r.d.toFixed(1) + 'px');
  const wCW = Math.max.apply(null, r.quad.map(p => p[0])) - Math.min.apply(null, r.quad.map(p => p[0]));
  const hCW = Math.max.apply(null, r.quad.map(p => p[1])) - Math.min.apply(null, r.quad.map(p => p[1]));
  check('顺时针 90°：框宽高互换', Math.abs(wCW - SEL.h) < 3 && Math.abs(hCW - SEL.w) < 3, wCW + '×' + hCW);

  r = await run('逆时针90°', '#tpRot90ccw');
  check('逆时针 90°：内容真的转了 90°', r.after && r.d < 50, '偏差 ' + r.d.toFixed(1) + 'px');
  const wCCW = Math.max.apply(null, r.quad.map(p => p[0])) - Math.min.apply(null, r.quad.map(p => p[0]));
  const hCCW = Math.max.apply(null, r.quad.map(p => p[1])) - Math.min.apply(null, r.quad.map(p => p[1]));
  check('逆时针 90°：框宽高互换', Math.abs(wCCW - SEL.h) < 3 && Math.abs(hCCW - SEL.w) < 3, wCCW + '×' + hCCW);

  // 翻转之后还要能继续拖（镜像会反转四边形的绕向，命中测试必须认得）
  console.log('\n=== 翻转之后还能不能拖动 ===');
  await setup();
  await sleep(250);
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(600);
  await page.evaluate(() => document.querySelector('#tpHFlip').click());
  await sleep(300);
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => { const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]); return [box.x + s.x, box.y + s.y]; };
  const quadro = await page.evaluate(() => window.ChaApp.engine.transform.quad.map(function (p) { return [p.x, p.y]; }));
  const c0 = await mk((quadro[0][0] + quadro[2][0]) / 2, (quadro[0][1] + quadro[2][1]) / 2);
  const c1 = await mk((quadro[0][0] + quadro[2][0]) / 2 + 80, (quadro[0][1] + quadro[2][1]) / 2 + 40);
  await page.mouse.move(c0[0], c0[1]);
  await page.mouse.down();
  await page.mouse.move(c1[0], c1[1], { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const quadMoved = await page.evaluate(() => window.ChaApp.engine.transform.quad.map(function (p) { return [p.x, p.y]; }));
  const moved = Math.abs(quadMoved[0][0] - quadro[0][0]) > 20;
  check('水平翻转后仍可拖动变换框（绕向反转不影响命中）', moved,
    JSON.stringify(quadro[0]) + ' → ' + JSON.stringify(quadMoved[0]));

  console.log('\n页面错误:', errs.length ? errs.join(' | ') : '无');
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
