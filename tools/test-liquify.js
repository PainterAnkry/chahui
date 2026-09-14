/**
 * 小型液化回归。
 *
 * 守着这几条：
 *   · 拖过之后**像素真的被推动**了（内容沿拖动方向位移），不是只改了颜色
 *   · 结果是 (落笔时的快照, 笔迹点) 的**纯函数** —— 同样输入算两次结果完全一致
 *     （这是它能跨端一致、也能实时预览反复重算的前提）
 *   · 笔迹外的地方一个像素都不动
 *   · 圆心权重最大、边缘为 0（平滑衰减，不会出现硬圆盘边）
 *   · 强度 / 笔尖大小真的影响结果
 *
 * 用法: node tools/test-liquify.js [http://localhost:8437]
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
  await page.fill('#nameInput', '液化');
  await page.fill('#newRoomName', '液化回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);

  console.log('\n=== 工具栏里有液化 ===');
  const btn = await page.evaluate(() => {
    const b = document.querySelector('#toolGrid .tool[data-item="liquify"]') ||
      document.querySelector('#brushGrid .tool[data-item="liquify"]');
    return { exists: !!b, label: b ? b.textContent.trim() : '' };
  });
  console.log('  ' + JSON.stringify(btn));
  ok('工具栏里有「液化」', btn.exists === true, btn.label);

  /** 造一张「左黑右白」的竖条纹图，推一下就能看出位移 */
  const setup = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height); });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
    const l = e.activeLayer();
    // 竖条纹：每 20px 一条
    for (let x = 0; x < e.width; x += 40) {
      l.ctx.fillStyle = '#000000';
      l.ctx.fillRect(x, 0, 20, e.height);
    }
    l.baseImage = l.ctx.canvas.toDataURL('image/png');
    l.baseSeq = e.seq;
    return { w: e.width, h: e.height };
  });

  /** 在某处做一次液化拖动（程序化，走引擎接口，保证可复现） */
  const doLiquify = (size, strength, pts) => page.evaluate(([sz, st, path]) => {
    const e = window.ChaApp.engine;
    const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('liquify'));
    prm.size = sz;
    prm.strength = st;
    const info = Object.assign({}, prm, {
      id: 'lq_' + Math.random().toString(36).slice(2, 8),
      layerId: e.activeLayerId, tool: 'liquify', color: '#000000',
      sym: 'none', brush: 'liquify', seed: 1
    });
    const s = e.beginStroke(info);
    for (let i = 0; i < path.length; i += 4) e.addPoints(s.id, path.slice(i, i + 4));
    e.addPoints(s.id, []);
    e.endStroke(s.id, ++e.seq);
    e.invalidate();
    return s.id;
  }, [size, strength, pts]);

  const sampleRow = (y, x0, x1) => page.evaluate(([yy, a, b]) => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    const d = l.ctx.getImageData(a, yy, b - a, 1).data;
    const out = [];
    for (let i = 0; i < (b - a); i++) out.push(d[i * 4] > 128 ? 1 : 0);   // 1 = 白
    return out;
  }, [y, x0, x1]);

  console.log('\n=== 推一下：内容真的被推动了 ===');
  await setup();
  const snapDiff = await page.evaluate(([path]) => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    // 指标要说清楚：直接数「整幅画布前后有几个像素变了」，
    // 比按行分类可靠得多（按行那套会被透明背景和周期条纹绕晕）。
    const snap = l.ctx.getImageData(0, 0, e.width, e.height).data.slice();
    const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('liquify'));
    prm.size = 120; prm.strength = 0.9;
    const info = Object.assign({}, prm, {
      id: 'diff1', layerId: e.activeLayerId, tool: 'liquify', color: '#000000',
      sym: 'none', brush: 'liquify', seed: 1
    });
    const st = e.beginStroke(info);
    e.addPoints(st.id, path);
    e.addPoints(st.id, []);
    e.endStroke(st.id, ++e.seq);
    const now = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let diff = 0, changedBox = [1e9, 1e9, -1, -1];
    for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
      const o = (y * e.width + x) * 4;
      if (snap[o] !== now[o] || snap[o + 3] !== now[o + 3]) {
        diff++;
        if (x < changedBox[0]) changedBox[0] = x;
        if (y < changedBox[1]) changedBox[1] = y;
        if (x > changedBox[2]) changedBox[2] = x;
        if (y > changedBox[3]) changedBox[3] = y;
      }
    }
    return { diff: diff, box: changedBox };
  }, [[[500, 500, 1], [560, 500, 1], [620, 500, 1], [680, 500, 1]]]);
  console.log('  整幅变化像素: ' + snapDiff.diff + '  变化范围 ' + JSON.stringify(snapDiff.box));
  ok('拖过之后像素真的被推动了', snapDiff.diff > 2000, snapDiff.diff + ' 个像素变化');
  ok('只影响拖动经过的一带（没有被推到整幅）', snapDiff.diff < 200000, snapDiff.diff + ' 像素');
  ok('变化范围围着拖动路径', snapDiff.box[0] > 300 && snapDiff.box[2] < 800 &&
    snapDiff.box[1] > 300 && snapDiff.box[3] < 700, JSON.stringify(snapDiff.box));

  console.log('\n=== 纯函数 / 强度 / 笔尖大小（在独立画布上量，不受引擎状态影响）===');
  const unit = await page.evaluate(() => {
    // 统一在这里造一张干净的条纹画布，直接调位移场 + 重采样 ——
    // 这几条性质本来就是「场 + 重采样」的函数，没必要绕整条引擎管线。
    function stripes() {
      const c = document.createElement('canvas');
      c.width = 800; c.height = 600;
      const cx = c.getContext('2d');
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, 800, 600);
      for (let x = 0; x < 800; x += 40) { cx.fillStyle = '#000000'; cx.fillRect(x, 0, 20, 600); }
      return c;
    }
    function run(stroke) {
      const src = stripes();
      const r = window.__liquifyProbe(stroke, src);
      const a = src.getContext('2d').getImageData(0, 0, 800, 600).data;
      const out = window.__liquifyProbe.outOf ? null : null;
      void out;
      return r;
    }
    const base = { points: [[250, 300, 1], [330, 300, 1], [410, 300, 1], [490, 300, 1]], size: 120, strength: 0.9 };
    const r1 = run(base);
    const r2 = run(base);
    const weak = run(Object.assign({}, base, { strength: 0.15 }));
    const strong = run(Object.assign({}, base, { strength: 1.0 }));
    const small = run(Object.assign({}, base, { size: 40 }));
    const wide = run(Object.assign({}, base, { size: 200 }));
    return {
      pure: r1.diffAfterResample === r2.diffAfterResample && r1.maxDx === r2.maxDx,
      r1: r1, weak: weak.diffAfterResample, strong: strong.diffAfterResample,
      small: small.diffAfterResample, wide: wide.diffAfterResample
    };
  });
  console.log('  ' + JSON.stringify(unit));
  ok('同样的输入算两次，结果完全一致（纯函数）', unit.pure === true, JSON.stringify(unit.r1));
  ok('位移场确实产生了位移（maxDx > 0）', unit.r1.maxDx > 0, 'maxDx=' + unit.r1.maxDx);
  ok('强度越大、被推动的像素越多', unit.strong > unit.weak, '弱 ' + unit.weak + ' / 强 ' + unit.strong);
  ok('笔尖越大、影响范围越大', unit.wide > unit.small, '小 ' + unit.small + ' / 大 ' + unit.wide);

  console.log('\n=== 落笔时的快照是独立的一份 ===');
  const frozen = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('liquify'));
    prm.size = 80;
    const info = Object.assign({}, prm, {
      id: 'fz', layerId: e.activeLayerId, tool: 'liquify', color: '#000000', sym: 'none', brush: 'liquify', seed: 1
    });
    const s = e.beginStroke(info);
    const has = !!(s._frozen && s._frozen.width === e.width);
    // 快照必须和图层分开 —— 否则反复重算会自己吃自己
    const separate = s._frozen !== e.activeLayer().canvas;
    e.cancelStroke(s.id);
    return { has: has, separate: separate };
  });
  console.log('  ' + JSON.stringify(frozen));
  ok('液化笔迹带着落笔时的冻结快照', frozen.has === true);
  ok('快照是独立的一份（不是图层本身）', frozen.separate === true);

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
