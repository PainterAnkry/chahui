/**
 * 选区工具回归测试：光标、各工具的选区结果、加选 / 减选 / 替换语义。
 *
 * 曾经踩过的坑（现在由这个测试守着）：
 *   · 选区笔 / 选区擦把 `endLocal` 搞得又发网络包又占撤销栈、还虚增 engine.seq
 *   · `newStroke` 只挑认识的字段，`add` / `subtract` 被静默丢掉 → Shift 加选退化成替换
 *   · Alt 被「临时吸管」抢走 → Alt 减选永远用不了
 *   · 框选 / 套索 / 魔棒也跟着画「笔刷大小圈」，看着像冒出一个椭圆
 *
 * 用法: node tools/test-selection.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(process.argv[2] || 'http://localhost:8437/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '选区测试');
  await page.fill('#newRoomName', '选区回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  // 用「适应窗口」：1:1 时文档比视口大，边缘的文档坐标其实落在左栏上，拖拽到不了画布
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  await page.evaluate(() => { const c = document.querySelector('#tpAuto'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });

  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    const px = box.x + s.x, py = box.y + s.y;
    if (px < box.x + 2 || px > box.x + box.width - 2 || py < box.y + 2 || py > box.y + box.height - 2) {
      throw new Error('探针错误：文档 (' + x + ',' + y + ') 落在画布区之外，拖拽到不了画布');
    }
    return [px, py];
  };
  const selInfo = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    if (!e.selection) return { active: false, px: 0, bbox: null };
    const d = e.selection.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return { active: e.hasSelection(), px: n, bbox: e.selection.bbox };
  });
  const clearSel = () => page.evaluate(() => window.ChaApp.engine.restoreSelection(null));

  async function drag(path_, mods) {
    const p0 = await mk(path_[0][0], path_[0][1]);
    await page.mouse.move(p0[0], p0[1]);
    if (mods === 'shift') await page.keyboard.down('Shift');
    if (mods === 'alt') await page.keyboard.down('Alt');
    await page.mouse.down();
    for (let i = 1; i < path_.length; i++) {
      const p = await mk(path_[i][0], path_[i][1]);
      await page.mouse.move(p[0], p[1]);
      await sleep(10);
    }
    await page.mouse.up();
    if (mods === 'shift') await page.keyboard.up('Shift');
    if (mods === 'alt') await page.keyboard.up('Alt');
    await sleep(650);
    return selInfo();
  }

  /* ---------- 光标 ---------- */
  console.log('\n=== 光标 ===');
  for (const t of ['select', 'selectErase', 'marquee', 'lasso', 'wand']) {
    await page.click('#toolGrid .tool[data-item="' + t + '"]');
    await sleep(200);
    await page.mouse.move(box.x + 500, box.y + 400);
    await sleep(200);
    const c = await page.evaluate(() => {
      const el = document.querySelector('#brushCursor');
      const r = el.getBoundingClientRect();
      return { cls: el.className, w: +r.width.toFixed(1), h: +r.height.toFixed(1), radius: getComputedStyle(el).borderRadius };
    });
    const isCross = /\bcross\b/.test(c.cls);
    console.log('  ' + t.padEnd(12) + ' ' + c.w + '×' + c.h + ' r=' + c.radius + ' ' + (isCross ? '十字' : '圆环'));
    check(t + ' 的光标是正圆或十字（不是椭圆）', Math.abs(c.w - c.h) < 0.6, c.w + '×' + c.h);
    if (['marquee', 'lasso', 'wand'].indexOf(t) >= 0) {
      check(t + ' 不跟着画「笔刷大小圈」（用十字准星）', isCross);
    }
  }

  /* ---------- 各工具的选区结果 ---------- */
  console.log('\n=== 各工具的选区结果（画布 1600×1000） ===');
  await page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
    const l = e.activeLayer();
    l.ctx.fillStyle = '#3a86e0'; l.ctx.fillRect(0, 0, e.width, e.height);
    l.ctx.fillStyle = '#111111'; l.ctx.fillRect(600, 0, 60, e.height);
  });
  await sleep(250);

  await page.click('#toolGrid .tool[data-item="select"]');
  await sleep(200);
  await page.evaluate(() => { const e = document.querySelector('#sizeRange'); e.value = 40; e.dispatchEvent(new Event('input', { bubbles: true })); });
  let r = await drag([[200, 400], [1000, 400]]);
  check('选区笔：涂出一条 40px 宽的带（≈32000 像素）', Math.abs(r.px - 32000) / 32000 < 0.15, r.px + ' 像素');

  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(200);
  r = await drag([[300, 300], [900, 700]]);
  check('框选：600×400 矩形，像素数精确', r.px === 240000, r.px + ' / 240000');

  await page.click('#toolGrid .tool[data-item="lasso"]');
  await sleep(200);
  r = await drag([[500, 300], [900, 400], [900, 600], [500, 700], [500, 300]]);
  check('套索：围出一块（约 120000）', r.px > 90000 && r.px < 150000, r.px + ' 像素');

  await page.click('#toolGrid .tool[data-item="wand"]');
  await sleep(200);
  const wp = await mk(200, 200);
  await page.mouse.move(wp[0], wp[1]);
  await page.mouse.down(); await page.mouse.up();
  await sleep(1200);
  r = await selInfo();
  check('魔棒：点蓝底只选中黑线左边那一半（600000，被黑线挡住）',
    Math.abs(r.px - 600000) / 600000 < 0.03, r.px + ' 像素');

  /* ---------- 加选 / 减选 / 替换 ---------- */
  console.log('\n=== 加选 / 减选 / 替换 ===');
  await clearSel();
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(200);
  const a = await drag([[200, 200], [600, 500]]);
  check('第一次框选 400×300 = 120000', a.px === 120000, String(a.px));
  const b = await drag([[800, 200], [1100, 500]]);
  check('第二次普通框选是「替换」而不是叠加', b.px === 90000, String(b.px));
  const c = await drag([[200, 200], [600, 500]], 'shift');
  check('Shift 加选：120000 + 90000 = 210000', c.px === 210000, String(c.px));
  const d = await drag([[300, 300], [500, 400]], 'alt');
  check('Alt 减选：210000 − 20000 = 190000', d.px === 190000, String(d.px));

  /* ---------- 全选 / 反选 / 取消 ---------- */
  console.log('\n=== 全选 / 反选 / 取消 ===');
  await page.evaluate(() => document.querySelector('#btnSelAll').click());
  await sleep(500);
  let s = await selInfo();
  check('全选 = 整张画布 1600000', s.px === 1600000, String(s.px));
  await page.evaluate(() => document.querySelector('#btnSelInvert').click());
  await sleep(500);
  s = await selInfo();
  check('反选之后变成空选区（刚才就是全选）', !s.active || s.px === 0, JSON.stringify(s));
  await page.evaluate(() => document.querySelector('#btnSelNone').click());
  await sleep(400);
  s = await selInfo();
  check('取消选区', s.active === false, JSON.stringify(s));

  /* ---------- 选区笔：多笔累积 + 选区擦 ---------- */
  // 曾经的 bug：selComposite 对选区笔也返回 'copy'（替换），而替换是拿**当前这一笔**的
  // scratch 覆盖整张蒙版 —— 涂第二笔就把第一笔抹掉，用户看到「选区断成一段一段」。
  console.log('\n=== 选区笔多笔累积 / 选区擦 ===');
  const setSize = (n) => page.evaluate((v) => {
    const e = document.querySelector('#sizeRange'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true }));
  }, n);
  const band = async (y) => {
    const a = await mk(300, y), b = await mk(700, y);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(a[0] + (b[0] - a[0]) * k / 12, a[1] + (b[1] - a[1]) * k / 12);
    await page.mouse.up();
    await sleep(600);
    return selInfo();
  };
  await clearSel();
  await page.click('#toolGrid .tool[data-item="select"], #brushGrid .tool[data-item="select"]');
  await sleep(250);
  await setSize(40);
  await clearSel();
  await sleep(250);
  const b1 = await band(300);
  const b2 = await band(500);
  const b3 = await band(700);
  console.log('  三笔分别涂完: ' + b1.px + ' → ' + b2.px + ' → ' + b3.px);
  check('选区笔：第一笔涂出一块', b1.px > 8000, String(b1.px));
  check('选区笔：第二笔是「加上去」而不是替换',
    Math.abs(b2.px - b1.px * 2) / (b1.px * 2) < 0.12, b1.px + ' → ' + b2.px);
  check('选区笔：第三笔继续累积（三块都还在）',
    Math.abs(b3.px - b1.px * 3) / (b1.px * 3) < 0.12, b1.px + '×3 vs ' + b3.px);

  // 选区擦要单独设一次大小：切工具会把大小重置回条目默认值（20）
  await page.click('#toolGrid .tool[data-item="selectErase"], #brushGrid .tool[data-item="selectErase"]');
  await sleep(250);
  await setSize(40);
  const eraseSize = await page.evaluate(() => window.ChaApp.state.brush.size);
  check('选区擦沿用设定的笔尖大小', eraseSize === 40, String(eraseSize));
  const b4 = await band(500);
  console.log('  擦掉中间那笔后: ' + b4.px + '（期望 ≈ ' + (b3.px - b1.px) + '）');
  check('选区擦：擦掉中间一笔，另外两笔不受影响',
    Math.abs(b4.px - (b3.px - b1.px)) / (b3.px - b1.px) < 0.12, String(b4.px));

  /* ---------- 选区笔不占撤销栈、不虚增 seq ---------- */
  console.log('\n=== 选区笔不污染撤销栈 / seq ===');
  const before = await page.evaluate(() => ({ seq: window.ChaApp.engine.seq, undo: window.ChaApp.state.opUndo.length }));
  await page.click('#toolGrid .tool[data-item="select"]');
  await sleep(200);
  await drag([[300, 300], [800, 600]]);
  const after = await page.evaluate(() => ({ seq: window.ChaApp.engine.seq, undo: window.ChaApp.state.opUndo.length }));
  check('选区笔不虚增 engine.seq（固化水位）', after.seq === before.seq, before.seq + ' → ' + after.seq);
  check('选区笔不占用撤销栈', after.undo === before.undo + 1, before.undo + ' → ' + after.undo + '（只该多一条选区操作）');

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
