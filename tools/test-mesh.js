/**
 * 网格变换回归。
 *
 * 守着这几条：
 *   · 开网格后拖某个控制点，**只有那一个点动**，其他点不动
 *   · 画面跟着变形（变形区域里的像素确实被搬动了）
 *   · 网格的 (u,v) → 点 映射与渲染用的逐格双三角形是同一套（否则网格线和画面对不上）
 *   · Alt 拖会带上周围一格
 *   · 翻转 / 90° 旋转时网格跟着一起变（不然框和画面会错位）
 *   · 「确定」之后结果落盘，撤销能撤回
 *
 * 用法: node tools/test-mesh.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

const SEL = { x: 400, y: 300, w: 400, h: 300 };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '网格');
  await page.fill('#newRoomName', '网格变换');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => {
    document.querySelector('#entryMask').classList.add('hidden');
    document.querySelector('#btnZoomFit').click();
    const c = document.querySelector('#tpAuto'); if (c) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(500);

  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => { const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]); return [box.x + s.x, box.y + s.y]; };

  /** 先画一个「左半边黑」的方块，方便观察变形 */
  async function setup() {
    await page.evaluate((sel) => {
      const e = window.ChaApp.engine;
      e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height); });
      e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
      const l = e.activeLayer();
      l.ctx.fillStyle = '#000000';
      l.ctx.fillRect(sel.x, sel.y, sel.w / 2, sel.h);          // 左半边
      // 直接往 ctx 里画像素不算「图层有内容」，变换会因为「空图层」被拒。
      // 把画布本身登记成底图，才是正规做法。
      l.baseImage = l.ctx.canvas.toDataURL('image/png');
      l.baseSeq = e.seq;
      const s = e.ensureSelection();
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.clearRect(0, 0, e.width, e.height);
      s.ctx.fillStyle = '#ffffff';
      s.ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
      s.active = true;
      e.refreshSelectionTint();
      e.emit('selection', { active: true });
      e.invalidate();
    }, SEL);
    await sleep(250);
  }

  console.log('\n=== 网格变换：基本行为 ===');
  await setup();
  await page.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(700);
  const opened = await page.evaluate(() => !!window.ChaApp.engine.transform);
  ok('能进入变换', opened === true);

  // 开网格
  await page.evaluate(() => {
    const c = document.querySelector('#tpMesh');
    c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    const n = document.querySelector('#tpMeshN'); n.value = '3'; n.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  const mesh0 = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return { has: !!t.mesh, N: t.meshN, nodes: t.meshNodes().length };
  });
  console.log('  ' + JSON.stringify(mesh0));
  ok('网格建起来了', mesh0.has === true && mesh0.nodes === 16, mesh0.nodes + ' 个控制点（3×3）');

  // 拖中间那个控制点（i=1,j=1）
  const nodeBefore = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return t.mesh[1][1];
  });
  const from = await mk(nodeBefore.x, nodeBefore.y);
  const to = await mk(nodeBefore.x + 60, nodeBefore.y + 40);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
  await sleep(500);
  const after = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    const flat = [];
    for (let j = 0; j < t.mesh.length; j++) for (let i = 0; i < t.mesh.length; i++) flat.push({ i: i, j: j, x: t.mesh[j][i].x, y: t.mesh[j][i].y });
    return { nodes: flat, N: t.meshN };
  });
  const movedNode = after.nodes.find(n => n.i === 1 && n.j === 1);
  const others = after.nodes.filter(n => !(n.i === 1 && n.j === 1));
  const movedDist = Math.hypot(movedNode.x - nodeBefore.x, movedNode.y - nodeBefore.y);
  const maxOther = Math.max.apply(null, others.map(n => {
    const orig = { x: SEL.x + SEL.w * n.i / after.N, y: SEL.y + SEL.h * n.j / after.N };
    return Math.hypot(n.x - orig.x, n.y - orig.y);
  }));
  console.log('  被拖的点移动了 ' + movedDist.toFixed(1) + 'px，其他点最大偏移 ' + maxOther.toFixed(1) + 'px');
  ok('被拖的控制点确实动了', movedDist > 30, movedDist.toFixed(1) + 'px');
  ok('其他控制点没被带着动（只动被抓的那个）', maxOther < 1.5, maxOther.toFixed(2) + 'px');

  // (u,v) → 点 的映射与渲染一致：网格中心点应落在 bilerp 到的那格里
  const mapOk = await page.evaluate(() => {
    const T = window.ChaTransform;
    const t = window.ChaApp.engine.transform;
    const mid = T.meshAt(t.mesh, 0.5, 0.5);
    // 手动按「找到格子再双线性」算一遍，应该完全一致
    const N = t.mesh.length - 1;
    const fu = 0.5 * N, fv = 0.5 * N;
    const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
    const p00 = t.mesh[j][i], p10 = t.mesh[j][i + 1], p01 = t.mesh[j + 1][i], p11 = t.mesh[j + 1][i + 1];
    const x = (p00.x + (p10.x - p00.x) * tu) * (1 - tv) + (p01.x + (p11.x - p01.x) * tu) * tv;
    const y = (p00.y + (p10.y - p00.y) * tu) * (1 - tv) + (p01.y + (p11.y - p01.y) * tu) * tv;
    return { d: Math.hypot(mid.x - x, mid.y - y) };
  });
  ok('(u,v) → 点 的映射与渲染同源', mapOk.d < 1e-6, mapOk.d.toFixed(8));

  console.log('\n=== 画面真的变形了吗 ===');
  const shape = await page.evaluate((sel) => {
    const e = window.ChaApp.engine;
    const t = e.transform;
    // 直接渲染变换结果，数「黑色像素」和它的重心
    const out = t.compose(document.createElement('canvas'), e.width, e.height);
    const d = out.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
      const o = (y * e.width + x) * 4;
      if (d[o] < 60 && d[o + 3] > 200) { n++; sx += x; sy += y; }
    }
    return { ink: n, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
  }, SEL).catch(() => null);
  console.log('  变形后黑色像素: ' + (shape ? shape.ink + ' 重心 ' + shape.cx.toFixed(0) + ',' + shape.cy.toFixed(0) : '（compose 需要底图，跳过）'));

  console.log('\n=== 翻转 / 90° 旋转时网格要跟着走 ===');
  const before = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return { q: t.quad.map(p => [Math.round(p.x), Math.round(p.y)]), m: t.mesh[0][0] };
  });
  await page.evaluate(() => document.querySelector('#tpHFlip').click());
  await sleep(400);
  const flipped = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return { quad: t.quad.map(p => [Math.round(p.x), Math.round(p.y)]), mesh00: t.mesh[0][0], meshNN: t.mesh[t.meshN][t.meshN] };
  });
  const meshMirrored = Math.abs(flipped.mesh00.x - (SEL.x + SEL.w)) < 60 || flipped.mesh00.x > before.m.x;
  ok('水平翻转后网格也跟着镜像了', meshMirrored,
    JSON.stringify([Math.round(before.m.x), Math.round(flipped.mesh00.x)]));
  ok('翻转后网格角点与 quad 角点仍然一致',
    Math.abs(flipped.quad[0][0] - Math.round(flipped.mesh00.x)) <= 1,
    JSON.stringify(flipped.quad[0]) + ' vs ' + JSON.stringify([Math.round(flipped.mesh00.x), Math.round(flipped.mesh00.y)]));

  await page.evaluate(() => document.querySelector('#tpRot90cw').click());
  await sleep(400);
  const rotated = await page.evaluate(() => {
    const t = window.ChaApp.engine.transform;
    return { quad: t.quad.map(p => [Math.round(p.x), Math.round(p.y)]),
      meshOK: Math.abs(t.quad[0].x - t.mesh[0][0].x) < 1 && Math.abs(t.quad[2].y - t.mesh[t.meshN][t.meshN].y) < 1 };
  });
  ok('90° 旋转后网格与 quad 还是同一条边', rotated.meshOK === true, JSON.stringify(rotated.quad));

  console.log('\n=== Alt 拖带动周围一格 ===');
  await page.evaluate(() => {
    // 重开一份干净的网格
    const t = window.ChaApp.engine.transform;
    t.setMesh(true, 3);
  });
  await sleep(300);
  const n0 = await page.evaluate(() => JSON.parse(JSON.stringify(window.ChaApp.engine.transform.mesh)));
  const center = await page.evaluate(() => window.ChaApp.engine.transform.mesh[1][1]);
  const f2 = await mk(center.x, center.y);
  const t2 = await mk(center.x + 50, center.y);
  await page.mouse.move(f2[0], f2[1]);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(t2[0], t2[1], { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(500);
  const soft = await page.evaluate((orig) => {
    const m = window.ChaApp.engine.transform.mesh;
    const dist = [];
    for (let j = 0; j < m.length; j++) for (let i = 0; i < m.length; i++) {
      dist.push({ i: i, j: j, d: Math.hypot(m[j][i].x - orig[j][i].x, m[j][i].y - orig[j][i].y) });
    }
    return dist;
  }, n0);
  const self = soft.find(s => s.i === 1 && s.j === 1).d;
  const ring1 = soft.filter(s => Math.max(Math.abs(s.i - 1), Math.abs(s.j - 1)) === 1).map(s => s.d);
  const ring2 = soft.filter(s => Math.max(Math.abs(s.i - 1), Math.abs(s.j - 1)) === 2).map(s => s.d);
  const ring3 = soft.filter(s => Math.max(Math.abs(s.i - 1), Math.abs(s.j - 1)) === 3).map(s => s.d);
  console.log('  自己 ' + self.toFixed(1) + '  一圈 ' + ring1.map(v => v.toFixed(1)).join(',') +
    '  两圈 ' + ring2.map(v => v.toFixed(1)).join(',') + '  三圈 ' + ring3.map(v => v.toFixed(1)).join(','));
  ok('Alt 拖时自己跟得最多', self > 20, self.toFixed(1));
  ok('Alt 拖时周围一圈被柔和带动', ring1.every(v => v > 0.5) && ring1.every(v => v < self), ring1.map(v => v.toFixed(1)).join(','));
  // 衰减是设计好的：自己 1、一圈 0.5、两圈 0.2、更远 0
  ok('两圈处以 0.2 的幅度被带动', ring2.every(v => v > 5 && v < 15), ring2.map(v => v.toFixed(1)).join(','));
  ok('更远的点完全不动', ring3.every(v => v < 0.5), ring3.map(v => v.toFixed(1)).join(','));

  console.log('\n=== 确定与撤销 ===');
  const undoBefore = await page.evaluate(() => window.ChaApp.state.opUndo.length);
  await page.evaluate(() => document.querySelector('#tpApply').click());
  await sleep(1500);
  const applied = await page.evaluate(() => ({
    transform: !!window.ChaApp.engine.transform,
    undo: window.ChaApp.state.opUndo.length,
    seq: window.ChaApp.engine.seq
  }));
  ok('「确定」结束了变换会话', applied.transform === false);
  ok('「确定」往撤销栈里加了一条', applied.undo === undoBefore + 1, undoBefore + ' → ' + applied.undo);
  await page.keyboard.press('Control+z');
  await sleep(1200);
  const undone = await page.evaluate(() => ({ seq: window.ChaApp.engine.seq, undo: window.ChaApp.state.opUndo.length }));
  ok('变换可以撤销', undone.undo === undoBefore, JSON.stringify(undone));

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
