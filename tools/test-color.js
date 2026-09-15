/**
 * 颜色栏回归：色轮命中 / 指示器跟随 / 色板自定义 / 前景背景 / 滑块微调。
 *
 * 守着这几条：
 *   · 点三角就该是三角（SV 变、色相不变），点环才改色相 ——
 *     「想点三角结果点到环」是用户报过的问题，以前三角和内圈之间还有一圈死区
 *   · 拖 RGB / HSV 滑块、点色板、换前景背景之后，色轮上的指示器要跟着动
 *   · 色板能加自己的色、能删、能恢复默认，而且记得住
 *   · 数字框能用上下键 / 滚轮微调；十六进制框点进去是全选
 *
 * 用法: node tools/test-color.js [http://localhost:8440]
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

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 15000 });
  await page.waitForTimeout(500);
  // 入口蒙层铺满整个窗口，不关掉鼠标事件全被它吃掉
  await page.evaluate(() => { const m = document.getElementById('entryMask'); if (m) m.classList.add('hidden'); });

  // 颜色栏放到最上面并全部展开，省得反复滚动
  await page.evaluate(() => {
    document.querySelectorAll('#colorModes .cm-btn').forEach(b => { if (!b.classList.contains('on')) b.click(); });
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('[data-section="color"]').scrollIntoView({ block: 'start' }));
  await sleep(300);

  /* 在页面里装一套「点色轮」的工具函数（刷新之后要重装） */
  const installProbe = () => page.evaluate(() => {
    window.__colorProbe = {
      geom() {
        const cv = document.getElementById('colorWheel');
        const b = cv.getBoundingClientRect();
        const SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
        const R = SZ / 2 - 3, ring = 17, r0 = R - ring;
        const tr = r0 - 6; // 与 app.js 的 TRI_GAP 一致
        const T3 = Math.sqrt(3) / 2;
        return {
          cv, b, SZ, cx, cy, R, ring, r0, tr,
          A: [cx, cy - tr], B: [cx + T3 * tr, cy + tr / 2], C: [cx - T3 * tr, cy + tr / 2]
        };
      },
      snap() {
        const S = window.ChaApp.state;
        return { hue: S.hue, s: S.sv.s, v: S.sv.v, hex: document.getElementById('hexInput').value };
      },
      clickAt(px, py, opts) {
        const g = this.geom();
        const x = g.b.left + px * (g.b.width / g.SZ);
        const y = g.b.top + py * (g.b.height / g.SZ);
        g.cv.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: 0, pointerId: 1, isPrimary: true, shiftKey: !!(opts && opts.shift)
        }));
        g.cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
      },
      /** 点一下，用画布上的标记汇报「落在环上还是三角上」（不靠猜颜色） */
      probe(px, py, opts) {
        const g = this.geom();
        const a = this.snap();
        const want = g.cv.dataset.pick;
        this.clickAt(px, py, opts);
        const c = this.snap();
        return {
          hue: c.hue, hex: c.hex, kind: g.cv.dataset.pick, want,
          dHue: Math.abs(c.hue - a.hue),
          svChanged: Math.abs(a.s - c.s) > 0.004 || Math.abs(a.v - c.v) > 0.004
        };
      },
      /** 三角内某组重心坐标对应的画布坐标 */
      triPoint(f) {
        const g = this.geom();
        return [
          f[0] * g.A[0] + f[1] * g.B[0] + f[2] * g.C[0],
          f[0] * g.A[1] + f[1] * g.B[1] + f[2] * g.C[1]
        ];
      },
      setColorViaHex(hex) {
        const el = document.getElementById('hexInput');
        el.value = hex;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      /** 色轮画布上某点的像素（用来验「指示器真的重画了」） */
      wheelHash() {
        const cv = document.getElementById('colorWheel');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      }
    };
  });
  await installProbe();

  console.log('\n=== 色轮几何 ===');
  const geo = await page.evaluate(() => {
    const g = window.__colorProbe.geom();
    return { SZ: g.SZ, R: g.R, r0: g.r0, tr: g.tr, ring: g.ring };
  });
  console.log('  ' + JSON.stringify(geo));
  ok('三角比色环内沿小一圈（看得出是分开的）', geo.tr <= geo.r0 - 4, 'tr=' + geo.tr + ' r0=' + geo.r0);

  console.log('\n=== 点三角形：SV 要变，色相不能动 ===');
  await page.evaluate(() => window.__colorProbe.setColorViaHex('#00b0ff'));
  await sleep(200);
  const triCases = [
    ['纯色相顶点 A', [1, 0, 0]],
    ['白顶点 B', [0, 1, 0]],
    ['黑顶点 C', [0, 0, 1]],
    ['正中', [1 / 3, 1 / 3, 1 / 3]],
    ['AB 边中点', [0.5, 0.5, 0]],
    ['AC 边中点', [0.5, 0, 0.5]],
    ['BC 边中点', [0, 0.5, 0.5]],
    ['靠白顶点', [0.05, 0.9, 0.05]],
    ['靠黑顶点', [0.05, 0.05, 0.9]]
  ];
  const triResults = [];
  for (const [label, f] of triCases) {
    await page.evaluate(h => window.__colorProbe.setColorViaHex(h), '#00b0ff');
    await sleep(120);
    const r = await page.evaluate((ff) => {
      const p = window.__colorProbe;
      const pt = p.triPoint(ff);
      return p.probe(pt[0], pt[1]);
    }, f);
    triResults.push({ label, ...r });
  }
  triResults.forEach(r => console.log('  ' + r.label.padEnd(12) + ' → ' + r.kind.padEnd(5) + ' 色相改变 ' + r.dHue.toFixed(1) + '°  ' + r.hex));
  ok('三角上的点都判成三角（不是环）',
    triResults.every(r => r.kind === 'tri'),
    triResults.filter(r => r.kind !== 'tri').map(r => r.label + '=' + r.kind));
  ok('点三角不会改色相（环上的小圈不会乱跳）',
    triResults.every(r => r.dHue < 1),
    triResults.filter(r => r.dHue >= 1).map(r => r.label + ' Δ' + r.dHue.toFixed(1)));

  console.log('\n=== 三角顶点往外一点点，仍然算三角（以前这里要么没反应、要么跳到环） ===');
  const outResults = [];
  for (const [label, ang] of [['顶点 A 上方', -90], ['顶点 B 外侧', 30], ['顶点 C 外侧', 150]]) {
    const r = await page.evaluate((a) => {
      const p = window.__colorProbe;
      const g = p.geom();
      const rad = a * Math.PI / 180;
      const out = [];
      for (let extra = 1; extra <= 2; extra++) {
        p.setColorViaHex('#00b0ff');
        const d = g.tr + extra;
        out.push(p.probe(g.cx + Math.cos(rad) * d, g.cy + Math.sin(rad) * d).kind);
      }
      return out;
    }, ang);
    outResults.push({ label, r });
    console.log('  ' + label.padEnd(12) + ' +1/+2px → ' + r.join(', '));
  }
  ok('顶点外 1~2px 仍判成三角（不再是死区、也不会误判成环）',
    outResults.every(x => x.r.every(k => k === 'tri')),
    outResults.map(x => x.label + ':' + x.r.join('/')));

  console.log('\n=== 点色环：色相要跟着角度走 ===');
  const ringResults = [];
  for (const ang of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const r = await page.evaluate((a) => {
      const p = window.__colorProbe;
      const g = p.geom();
      const rad = a * Math.PI / 180;
      const d = (g.R + g.r0) / 2; // 环带中点
      return p.probe(g.cx + Math.cos(rad) * d, g.cy + Math.sin(rad) * d);
    }, ang);
    ringResults.push({ ang, ...r });
  }
  ringResults.forEach(r => console.log('  ' + String(r.ang).padStart(3) + '° → ' + r.kind + '  色相 ' + r.hue.toFixed(1)));
  ok('环上取色准确（角度 = 色相，误差 ≤ 1°）',
    ringResults.every(r => r.kind === 'ring' && Math.abs(((r.hue - r.ang + 540) % 360) - 180) < 1),
    ringResults.map(r => r.ang + '→' + r.hue.toFixed(1)));

  console.log('\n=== 环上按住 Shift：每 15° 吸一档 ===');
  const snapped = await page.evaluate(() => {
    const p = window.__colorProbe;
    const g = p.geom();
    const out = [];
    [7, 38, 82, 173, 251, 322].forEach(a => {
      const rad = a * Math.PI / 180;
      const d = (g.R + g.r0) / 2;
      out.push(p.probe(g.cx + Math.cos(rad) * d, g.cy + Math.sin(rad) * d, { shift: true }).hue);
    });
    return out;
  });
  console.log('  7°→' + snapped[0] + '  38°→' + snapped[1] + '  82°→' + snapped[2] +
    '  173°→' + snapped[3] + '  251°→' + snapped[4] + '  322°→' + snapped[5]);
  ok('Shift 取色都落在 15° 的整数倍上', snapped.every(h => Math.abs(h / 15 - Math.round(h / 15)) < 0.001), snapped);

  console.log('\n=== 整圈没有「点了没反应」的死区 ===');
  const dead = await page.evaluate(() => {
    const p = window.__colorProbe;
    const g = p.geom();
    const deadPts = [];
    let total = 0;
    for (let py = 2; py < g.SZ; py += 6) {
      for (let px = 2; px < g.SZ; px += 6) {
        const dist = Math.hypot(px - g.cx, py - g.cy);
        if (dist > g.R - 1) continue;   // 圆外本来就没画东西
        total++;
        // 每次先把颜色设成一个固定值，免得「点到的正好是当前色」被当成没反应
        p.setColorViaHex('#3377cc');
        const r = p.probe(px, py);
        if (r.kind === 'miss') deadPts.push([px, py]);
      }
    }
    return { total, dead: deadPts };
  });
  console.log('  圆内采样 ' + dead.total + ' 个点，没反应的 ' + dead.dead.length + ' 个');
  ok('圆内每个点都有反应（没有死区）', dead.dead.length === 0, dead.dead.slice(0, 8));

  console.log('\n=== 拖动滑块 / 换色时，色轮指示器要跟着动 ===');
  await page.evaluate(() => window.__colorProbe.setColorViaHex('#00b0ff'));
  await sleep(200);
  const h0 = await page.evaluate(() => window.__colorProbe.wheelHash());
  await page.evaluate(() => {
    const s = document.getElementById('slR');
    s.value = '255';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  const h1 = await page.evaluate(() => window.__colorProbe.wheelHash());
  ok('拖 RGB 滑块之后色轮重画了（指示器不再是原地不动）', h0 !== h1, h0 + ' → ' + h1);

  const before = await page.evaluate(() => ({ hue: window.ChaApp.state.hue }));
  await page.evaluate(() => {
    const s = document.getElementById('slH');
    s.value = '200';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  const after = await page.evaluate(() => ({ hue: window.ChaApp.state.hue, hash: window.__colorProbe.wheelHash() }));
  ok('拖 HSV 的 H 滑块会改色相且色轮重画',
    Math.abs(after.hue - 200) < 1 && after.hash !== h1, JSON.stringify(after));

  // 直接比对像素：指示环是白圈，找「最亮的那一块」落在哪个角度上
  // （用「最亮像素」而不是「接近白的像素」——白圈外面还描了一圈半透明黑，
  //   2px 的白被啃到只剩描边，纯粹按 RGB>230 去找是一个都找不到的）
  const markerOk = await page.evaluate(() => {
    const cv = document.getElementById('colorWheel');
    const ctx = cv.getContext('2d');
    const SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
    const R = SZ / 2 - 3, ring = 17;
    const BOX = 21;
    let best = -1, bestScore = -1;
    for (let a = 0; a < 360; a += 2) {
      const rad = a * Math.PI / 180;
      const x = Math.round(cx + Math.cos(rad) * (R - ring / 2));
      const y = Math.round(cy + Math.sin(rad) * (R - ring / 2));
      const d = ctx.getImageData(x - (BOX - 1) / 2, y - (BOX - 1) / 2, BOX, BOX).data;
      let mx = 0;
      for (let i = 0; i < d.length; i += 4) {
        const s = d[i] + d[i + 1] + d[i + 2];
        if (s > mx) mx = s;
      }
      if (mx > bestScore) { bestScore = mx; best = a; }
    }
    return { best, bestScore };
  });
  console.log('  ' + JSON.stringify(markerOk));
  ok('色相指示环画在了 200° 附近',
    markerOk.bestScore > 600 && Math.abs(((markerOk.best - 200 + 540) % 360) - 180) < 12,
    JSON.stringify(markerOk));

  console.log('\n=== 前景 / 背景两个色块 ===');
  let fgbg = await page.evaluate(() => ({
    fg: !!document.getElementById('colorPreview'),
    bg: !!document.getElementById('bgPreview'),
    bgInput: !!document.getElementById('bgColorInput'),
    fgBg: getComputedStyle(document.getElementById('colorPreview')).backgroundColor,
    bgBg: getComputedStyle(document.getElementById('bgPreview')).backgroundColor,
    swap: !!document.getElementById('btnSwap')
  }));
  ok('前景 / 背景两个方块都在（背景不再是看不见的状态）', fgbg.fg && fgbg.bg && fgbg.bgInput, fgbg);
  ok('两个方块颜色不一样（看得出是两个）', fgbg.fgBg !== fgbg.bgBg, [fgbg.fgBg, fgbg.bgBg]);

  await page.evaluate(() => window.__colorProbe.setColorViaHex('#112233'));
  await sleep(180);
  const swap = await page.evaluate(() => {
    const before = {
      hex: document.getElementById('hexInput').value,
      fg: getComputedStyle(document.getElementById('colorPreview')).backgroundColor,
      bg: getComputedStyle(document.getElementById('bgPreview')).backgroundColor
    };
    document.getElementById('btnSwap').click();
    return {
      before,
      after: {
        hex: document.getElementById('hexInput').value,
        fg: getComputedStyle(document.getElementById('colorPreview')).backgroundColor,
        bg: getComputedStyle(document.getElementById('bgPreview')).backgroundColor
      }
    };
  });
  await sleep(200);
  ok('互换之后前景变成原来的背景', swap.after.hex === swap.before.bg.replace(/[^\d,]/g, '').split(',').length === 3
    ? true : swap.after.fg === swap.before.bg, JSON.stringify(swap));
  ok('互换之后背景变成原来的前景', swap.after.bg === swap.before.fg, JSON.stringify(swap));

  // 直接改背景色的输入框
  const bgSet = await page.evaluate(() => {
    const el = document.getElementById('bgColorInput');
    el.value = '#ff8800';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return getComputedStyle(document.getElementById('bgPreview')).backgroundColor;
  });
  ok('背景色可以单独设（改完色块跟着变）', bgSet === 'rgb(255, 136, 0)', bgSet);

  console.log('\n=== 色板：加自己的色 / 删掉 / 恢复默认 ===');
  await page.evaluate(() => window.__colorProbe.setColorViaHex('#7f3fbf'));
  await sleep(180);
  const pal0 = await page.evaluate(() => ({
    cells: document.querySelectorAll('#palette i:not(.palette-sep)').length,
    hasAdd: !!document.getElementById('btnSwatchAdd'),
    hasReset: !!document.getElementById('btnSwatchReset'),
    selCount: document.querySelectorAll('#palette i.sel').length
  }));
  ok('有色板「加入」和「恢复默认」按钮', pal0.hasAdd && pal0.hasReset, pal0);
  ok('当前颜色在色板里会被描一圈（如果是内置色的话）', pal0.selCount <= 1, pal0.selCount);

  const added = await page.evaluate(async () => {
    document.getElementById('btnSwatchAdd').click();
    await new Promise(r => setTimeout(r, 150));
    return {
      cells: document.querySelectorAll('#palette i:not(.palette-sep)').length,
      custom: document.querySelectorAll('#palette i.custom').length,
      sep: document.querySelectorAll('#palette i.palette-sep').length,
      stored: localStorage.getItem('chahu.swatches'),
      selHex: (document.querySelector('#palette i.sel') || {}).dataset ? document.querySelector('#palette i.sel').dataset.hex : null
    };
  });
  ok('加入之后多了一个自加色格', added.custom === 1 && added.cells === pal0.cells + 1, added);
  ok('内置色板和自加色板之间有一条分隔', added.sep === 1, added.sep);
  ok('自加的颜色写进了 localStorage', /7f3fbf/.test(added.stored || ''), added.stored);
  ok('刚加的颜色被标成「选中」那一个', added.selHex === '#7f3fbf', added.selHex);

  const dup = await page.evaluate(async () => {
    document.getElementById('btnSwatchAdd').click();
    await new Promise(r => setTimeout(r, 150));
    return document.querySelectorAll('#palette i.custom').length;
  });
  ok('同一个颜色不会重复加进去', dup === 1, dup);

  const del = await page.evaluate(async () => {
    const cell = document.querySelector('#palette i.custom');
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 180));
    return {
      custom: document.querySelectorAll('#palette i.custom').length,
      stored: localStorage.getItem('chahu.swatches')
    };
  });
  ok('右键自加色格可以删掉', del.custom === 0, del);
  ok('删掉之后 localStorage 里也没了', del.stored === '[]', del.stored);

  const persisted = await page.evaluate(async () => {
    window.__colorProbe.setColorViaHex('#0a5c2e');
    document.getElementById('btnSwatchAdd').click();
    await new Promise(r => setTimeout(r, 150));
    window.__colorProbe.setColorViaHex('#c81e5a');
    document.getElementById('btnSwatchAdd').click();
    await new Promise(r => setTimeout(r, 150));
    return document.querySelectorAll('#palette i.custom').length;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 15000 });
  await page.waitForTimeout(500);
  await installProbe();
  const afterReload = await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    return {
      custom: document.querySelectorAll('#palette i.custom').length,
      hexes: [...document.querySelectorAll('#palette i.custom')].map(i => i.dataset.hex)
    };
  });
  ok('刷新之后自加的色还在', afterReload.custom === persisted && persisted === 2, JSON.stringify(afterReload));
  ok('顺序也没乱', JSON.stringify(afterReload.hexes) === JSON.stringify(['#0a5c2e', '#c81e5a']), afterReload.hexes);

  const reset = await page.evaluate(async () => {
    document.getElementById('btnSwatchReset').click();
    await new Promise(r => setTimeout(r, 180));
    return {
      custom: document.querySelectorAll('#palette i.custom').length,
      sep: document.querySelectorAll('#palette i.palette-sep').length,
      cells: document.querySelectorAll('#palette i:not(.palette-sep)').length
    };
  });
  ok('「恢复默认」把自加的色都清掉', reset.custom === 0 && reset.sep === 0, reset);
  const builtinCount = await page.evaluate(() => window.CanvasEngine.SWATCHES.length);
  ok('恢复后剩下的就是内置色板', reset.cells === builtinCount, reset.cells + ' vs ' + builtinCount);

  console.log('\n=== 数字框：方向键 / 滚轮微调 ===');
  await page.evaluate(() => {
    document.querySelectorAll('#colorModes .cm-btn').forEach(b => { if (!b.classList.contains('on')) b.click(); });
  });
  await sleep(200);
  await page.evaluate(() => window.__colorProbe.setColorViaHex('#404040'));
  await sleep(180);
  const arrow = await page.evaluate(() => {
    const n = document.getElementById('numR');
    const out = [];
    n.focus();
    n.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    out.push({ step: 'up', v: n.value, hex: document.getElementById('hexInput').value });
    n.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    out.push({ step: 'up+shift', v: n.value, hex: document.getElementById('hexInput').value });
    n.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    out.push({ step: 'down', v: n.value, hex: document.getElementById('hexInput').value });
    return out;
  });
  console.log('  ' + JSON.stringify(arrow));
  ok('↑ 让 R 加 1', arrow[0].v === '65' && arrow[0].hex === '#414040', arrow[0]);
  ok('Shift+↑ 让 R 加 10', arrow[1].v === '75', arrow[1]);
  ok('↓ 让 R 减 1', arrow[2].v === '74', arrow[2]);

  const wheelNudge = await page.evaluate(() => {
    const n = document.getElementById('numG');
    n.value = '10';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    const before = document.getElementById('hexInput').value;
    n.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    const up = document.getElementById('hexInput').value;
    n.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    const down = document.getElementById('hexInput').value;
    return { before, up, down, v: n.value };
  });
  console.log('  ' + JSON.stringify(wheelNudge));
  ok('滚轮向上 G 加 1', wheelNudge.up === '#4A0B40', wheelNudge);
  ok('滚轮向下又回到原值', wheelNudge.down === wheelNudge.before, wheelNudge);

  console.log('\n=== 十六进制输入框 ===');
  const hexSel = await page.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#123456';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    el.focus();
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, len: el.value.length };
  });
  ok('点进十六进制框是全选状态（直接输入就覆盖）',
    hexSel.start === 0 && hexSel.end === hexSel.len, hexSel);

  const shortHex = await page.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#abc';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const a = el.value;
    el.value = 'ff8800';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const b = el.value;
    el.value = '不是颜色';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { short: a, noHash: b, bad: el.value };
  });
  console.log('  ' + JSON.stringify(shortHex));
  ok('#abc 简写能展开成 #AABBCC', shortHex.short === '#AABBCC', shortHex);
  ok('不带 # 的 ff8800 也认', shortHex.noHash === '#FF8800', shortHex);
  ok('乱输入会退回当前颜色（不会写进去一个坏值）', /^#[0-9A-F]{6}$/.test(shortHex.bad), shortHex);

  console.log('\n=== 页面没报错 ===');
  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 4));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
