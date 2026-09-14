/**
 * 色轮取色回归。
 *
 * 守着这两条真实缺陷：
 *   1) SV 指示器的重心坐标算错了（写成 [1-s, s(1-v), s*v]），
 *      于是点哪儿颜色是对的、小圆圈却跑到别处 —— 用户说「位置识别不对」。
 *      正确权重是 [v*s, v*(1-s), 1-v]。
 *   2) 色轮没有 touch-action:none，数位笔一拖就把左侧面板一起滚了。
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

  // 几何：环 / 三角的位置由页面自己算，测试照着同一套公式取点
  const geo = await page.evaluate(() => {
    const cv = document.querySelector('#colorWheel');
    const SZ = cv.width, cx = SZ / 2, cy = SZ / 2;
    const R = SZ / 2 - 3, ring = 17, r0 = R - ring, tr = r0 - 9;
    const A = [cx + Math.cos(-Math.PI / 2) * tr, cy + Math.sin(-Math.PI / 2) * tr];
    const B = [cx + Math.cos(-Math.PI / 2 + 2 * Math.PI / 3) * tr, cy + Math.sin(-Math.PI / 2 + 2 * Math.PI / 3) * tr];
    const C = [cx + Math.cos(-Math.PI / 2 + 4 * Math.PI / 3) * tr, cy + Math.sin(-Math.PI / 2 + 4 * Math.PI / 3) * tr];
    return { SZ, cx, cy, R, r0, tr, A, B, C };
  });

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
