/**
 * 色轮取色回归。
 *
 * 守着这两条真实缺陷：
 *   1) SV 指示器的重心坐标算错了（写成 [1-s, s(1-v), s*v]），
 *      于是点哪儿颜色是对的、小圆圈却跑到别处 —— 用户说「位置识别不对」。
 *      正确权重是 [v*s, v*(1-s), 1-v]。
 *   2) 色轮没有 touch-action:none，数位笔一拖就把左侧面板一起滚了。
 *   3) 取色区默认从三角形换成了**方形**（用户反馈：三角尖角附近一片颜色挤在
 *      一起，想选准得试好几次），三角形留作可切换的选项。
 *      所以这里**两种形状都验**：各自的「取色 = 像素」+「指示器落回点击处」。
 *
 * 用法: node tools/test-wheel.js [http://localhost:8437]
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
  await page.fill('#nameInput', '色轮');
  await page.fill('#newRoomName', '色轮回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(400);
  // 色轮在左侧面板里，要滚进视野才能用真实鼠标点
  await page.locator('#colorWheel').scrollIntoViewIfNeeded();
  await sleep(400);

  console.log('\n=== 基本设置 ===');
  const css = await page.evaluate(() => {
    const cv = document.querySelector('#colorWheel');
    const r = cv.getBoundingClientRect();
    return { ta: getComputedStyle(cv).touchAction, w: Math.round(r.width), h: Math.round(r.height), attr: cv.width };
  });
  console.log('  ' + JSON.stringify(css));
  ok('色轮设了 touch-action: none（数位笔不会带着面板滚）', css.ta === 'none', css.ta);

  // 几何：环 / 取色区的位置由页面自己算，测试照着同一套公式取点
  const geoOf = () => page.evaluate(() => {
    const cv = document.querySelector('#colorWheel');
    const SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
    const R = SZ / 2 - 3, ring = 17, r0 = R - ring;
    const tr = r0 - 11;                       // 必须和 app.js 的 TRI_GAP 一致
    const half = tr / Math.SQRT2;             // 方形：四个角正好落在三角顶点那个圆上
    const T3 = Math.sqrt(3) / 2;
    return {
      SZ, cx, cy, R, r0, tr, half,
      A: [cx, cy - tr], B: [cx + T3 * tr, cy + tr / 2], C: [cx - T3 * tr, cy + tr / 2],
      SQ: { x: cx - half, y: cy - half, w: half * 2, h: half * 2 }
    };
  });
  let geo = await geoOf();

  /** 用真实鼠标点色轮上的某个 canvas 坐标 */
  async function clickAt(x, y) {
    const pt = await page.evaluate(([gx, gy]) => {
      const cv = document.querySelector('#colorWheel');
      const r = cv.getBoundingClientRect();
      return [r.left + gx * r.width / cv.width, r.top + gy * r.height / cv.height];
    }, [x, y]);
    await page.mouse.move(pt[0], pt[1]);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
    await sleep(200);
    return page.evaluate(() => ({
      hue: window.ChaApp.state.hue, sv: window.ChaApp.state.sv, color: window.ChaApp.state.color
    }));
  }

  console.log('\n=== 环上取色（真实鼠标）===');
  let hueOk = 0;
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const p = await page.evaluate(([d, g]) => {
      const rad = d * Math.PI / 180;
      const rr = (g.r0 + g.R) / 2;
      return [g.cx + Math.cos(rad) * rr, g.cy + Math.sin(rad) * rr];
    }, [deg, geo]);
    const got = await clickAt(p[0], p[1]);
    const diff = Math.min(Math.abs(got.hue - deg), 360 - Math.abs(got.hue - deg));
    if (diff <= 4) hueOk++;
    console.log('  角度 ' + String(deg).padStart(3) + '° → hue=' + Math.round(got.hue) + (diff <= 4 ? '  ✓' : '  ✗ 偏 ' + diff.toFixed(0) + '°'));
  }
  ok('环上按角度取色准确（8 个方向）', hueOk === 8, hueOk + '/8');

  console.log('\n=== 默认取色区是方形（v20 起）===');
  ok('默认形状就是方形（不再是三角形）',
    (await page.evaluate(() => window.ChaApp.wheelShape())) === 'square',
    await page.evaluate(() => window.ChaApp.wheelShape()));
  ok('切换按钮显示的是 ▢',
    (await page.textContent('#btnWheelShape')).trim() === '▢',
    (await page.textContent('#btnWheelShape')).trim());

  console.log('\n=== 方形内取色 + 指示器位置 ===');
  // 方形：横轴 = 饱和度、纵轴 = 明度（上 1 → 下 0）。颜色要等于该像素，
  // 指示器也要落回同一个点 —— 和下面三角那一段验的是同一件事，只是形状不同。
  // ⚠ 取点避开 v→0 的极暗角：那里颜色是 8 位存的，一个 RGB 台阶就能让
  //   饱和度挪掉 0.05（浅色时同样的台阶只挪 0.004）——「颜色对不对」照样准，
  //   但「指示器偏差 ≤3px」会被这点量化误差顶出去。v 取 0.25 / 0.75 两头 + 正中。
  const sqCases = [[0.25, 0.75], [0.75, 0.75], [0.25, 0.25], [0.75, 0.25], [0.5, 0.5]];
  let sqColorOk = 0, sqMarkerOk = 0;
  for (const [s, v] of sqCases) {
    const target = await page.evaluate(([ss, vv, gg]) => {
      const cv = document.querySelector('#colorWheel');
      const x = gg.SQ.x + ss * gg.SQ.w, y = gg.SQ.y + (1 - vv) * gg.SQ.h;
      const d = cv.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return { x: Math.round(x), y: Math.round(y),
        hex: '#' + [d[0], d[1], d[2]].map(n => n.toString(16).padStart(2, '0')).join('') };
    }, [s, v, geo]);
    const got = await clickAt(target.x, target.y);
    const same = (got.color || '').toLowerCase() === target.hex.toLowerCase();
    if (same) sqColorOk++;
    // 指示器应该回到点击处：方形那套映射是直接线性反推的
    const marker = await page.evaluate(([sv, gg]) => [
      gg.SQ.x + sv.s * gg.SQ.w, gg.SQ.y + (1 - sv.v) * gg.SQ.h
    ], [got.sv, geo]);
    const dist = Math.hypot(marker[0] - target.x, marker[1] - target.y);
    if (dist <= 3) sqMarkerOk++;
    console.log('  s=' + s + ' v=' + v + ' 像素=' + target.hex + ' 取到=' + got.color + (same ? ' ✓' : ' ✗') +
      '  指示器 ' + JSON.stringify(marker.map(Math.round)) + ' 偏差 ' + dist.toFixed(1) + 'px' + (dist <= 3 ? ' ✓' : ' ✗'));
  }
  ok('方形内取到的颜色与该像素一致', sqColorOk === sqCases.length, sqColorOk + '/' + sqCases.length);
  ok('方形里指示器落回点击的位置（横轴饱和度 / 纵轴明度）',
    sqMarkerOk === sqCases.length, sqMarkerOk + '/' + sqCases.length);

  console.log('\n=== 切到三角形（保留下来的选项）===');
  await page.evaluate(() => window.ChaApp.setWheelShape('triangle'));
  await sleep(250);
  ok('切过去之后按钮变成 △',
    (await page.textContent('#btnWheelShape')).trim() === '△',
    (await page.textContent('#btnWheelShape')).trim());
  ok('选择记进了本地（关掉再开还是三角）',
    (await page.evaluate(() => { try { return localStorage.getItem('chahu.svshape'); } catch (e) { return null; } })) === 'triangle');

  console.log('\n=== 三角内取色 + 指示器位置 ===');
  // 在三角形里按重心坐标取若干点：颜色要等于该像素，指示器也要落回同一个点
  const cases = [[0.7, 0.15, 0.15], [0.15, 0.7, 0.15], [0.15, 0.15, 0.7], [0.34, 0.33, 0.33], [0.5, 0.4, 0.1]];
  let colorOk = 0, markerOk = 0;
  for (const w of cases) {
    const target = await page.evaluate(([ww, g]) => {
      const cv = document.querySelector('#colorWheel');
      const x = ww[0] * g.A[0] + ww[1] * g.B[0] + ww[2] * g.C[0];
      const y = ww[0] * g.A[1] + ww[1] * g.B[1] + ww[2] * g.C[1];
      const d = cv.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return { x: Math.round(x), y: Math.round(y),
        hex: '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('') };
    }, [w, geo]);
    const got = await clickAt(target.x, target.y);
    const same = (got.color || '').toLowerCase() === target.hex.toLowerCase();
    if (same) colorOk++;
    // 指示器应该回到点击处：用页面里同一套权重公式反推它的坐标
    const marker = await page.evaluate(([sv, g]) => {
      const wts = [sv.v * sv.s, sv.v * (1 - sv.s), 1 - sv.v];
      return [
        wts[0] * g.A[0] + wts[1] * g.B[0] + wts[2] * g.C[0],
        wts[0] * g.A[1] + wts[1] * g.B[1] + wts[2] * g.C[1]
      ];
    }, [got.sv, geo]);
    const dist = Math.hypot(marker[0] - target.x, marker[1] - target.y);
    if (dist <= 3) markerOk++;
    console.log('  点 ' + JSON.stringify([target.x, target.y]) + ' 像素=' + target.hex +
      ' 取到=' + got.color + (same ? ' ✓' : ' ✗') +
      '  指示器 ' + JSON.stringify(marker.map(Math.round)) + ' 偏差 ' + dist.toFixed(1) + 'px' + (dist <= 3 ? ' ✓' : ' ✗'));
  }
  ok('三角内取到的颜色与该像素一致', colorOk === cases.length, colorOk + '/' + cases.length);
  ok('指示器落回点击的位置（SV 权重算对了）', markerOk === cases.length, markerOk + '/' + cases.length);

  console.log('\n=== 拖动取色 ===');
  const drag = await page.evaluate(() => new Promise(resolve => {
    const cv = document.querySelector('#colorWheel');
    const r = cv.getBoundingClientRect();
    const toCli = (x, y) => [r.left + x * r.width / cv.width, r.top + y * r.height / cv.height];
    const a = toCli(50, 122), b = toCli(122, 50);
    const seen = [];
    cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: a[0], clientY: a[1], bubbles: true, pointerId: 9, pointerType: 'pen', isPrimary: true, buttons: 1, cancelable: true }));
    for (let k = 1; k <= 6; k++) {
      cv.dispatchEvent(new PointerEvent('pointermove', { clientX: a[0] + (b[0] - a[0]) * k / 6, clientY: a[1] + (b[1] - a[1]) * k / 6, bubbles: true, pointerId: 9, pointerType: 'pen', isPrimary: true, buttons: 1, cancelable: true }));
      seen.push(window.ChaApp.state.color);
    }
    cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    resolve(seen);
  }));
  console.log('  拖动中: ' + JSON.stringify(drag));
  ok('拖动过程中颜色跟着变', new Set(drag).size >= 3, new Set(drag).size + ' 种颜色');

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
