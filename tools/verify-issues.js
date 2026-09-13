/**
 * 一次性验收探针：逐条核对用户报的 6 项问题。
 * 用法: node tools/_verify.js [http://localhost:8437]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
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
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await sleep(800);

  /* ============ [1] 房间列表 + 清理 ============ */
  console.log('\n=== [1] 房间列表 / 清理空房 ===');
  const before = await page.evaluate(async () => (await fetch('/api/rooms').then(r => r.json())).rooms.length);
  const delBtns = await page.evaluate(() => document.querySelectorAll('#roomList .room-del').length);
  const purgeBtn = await page.evaluate(() => !!document.querySelector('#btnPurgeRooms'));
  const roomCount = await page.evaluate(() => document.querySelector('#roomCount').textContent);
  console.log('   列表房间数 =', before, '  每行删除按钮 =', delBtns, '  「清理空房」按钮 =', purgeBtn, '  计数徽标 =', roomCount);
  check('每行都有删除按钮', delBtns === before, `(${delBtns}/${before})`);
  check('有「清理空房」入口', purgeBtn);
  // 徽标形如「10」或「12（空 1）」，开头必须是真实房间总数
  check('标题显示房间数', new RegExp('^' + before + '(（空 \\d+）)?$').test(roomCount), roomCount);

  /* ============ 进房 ============ */
  await page.fill('#nameInput', '验收');
  await page.fill('#newRoomName', '验收房');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);
  const box = await page.locator('#view').boundingBox();
  const dark = () => page.evaluate(() => {
    const v = document.querySelector('#view');
    const d = v.getContext('2d').getImageData(0, 0, v.width, v.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > 8 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 190) n++;
    }
    return n;
  });

  /* ============ [6] 铅笔：连续实线，不是一串点 ============ */
  console.log('\n=== [6] SAI2 铅笔（应为连续实线） ===');
  await page.click('#toolGrid .tool[data-item="pencil"]');
  await sleep(250);
  // 用默认直径（2）在 100% 缩放下太细，调到 100% 视图保证可测
  await page.evaluate(() => document.querySelector('#btnZoom100').click());
  await sleep(400);
  const box2 = await page.locator('#view').boundingBox();
  const y0 = box2.y + box2.height / 2;
  const x0 = box2.x + 120, x1 = box2.x + 560;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(x0 + (x1 - x0) * i / 60, y0);
  await page.mouse.up();
  await sleep(600);
  const line = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const ctx = v.getContext('2d');
    const dpr = 1;
    const d = ctx.getImageData(0, 0, v.width, v.height).data;
    // 统计每一列有没有「墨」（亮度 < 190 且 alpha > 8）
    const cols = new Array(v.width).fill(0);
    for (let y = 0; y < v.height; y++) {
      for (let x = 0; x < v.width; x++) {
        const i = (y * v.width + x) * 4;
        if (d[i + 3] > 8 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 190) cols[x]++;
      }
    }
    let first = -1, last = -1;
    for (let x = 0; x < v.width; x++) { if (cols[x]) { if (first < 0) first = x; last = x; } }
    if (first < 0) return { span: 0, filled: 0, ratio: 0, gaps: 0, dpr };
    let filled = 0, gaps = 0, run = 0;
    for (let x = first; x <= last; x++) {
      if (cols[x]) { filled++; if (run > 2) gaps++; run = 0; } else run++;
    }
    return { span: last - first + 1, filled, ratio: filled / (last - first + 1), gaps, dpr };
  });
  console.log('   铅笔线：跨度 ' + line.span + 'px，着墨列 ' + line.filled + '，覆盖率 ' +
    (line.ratio * 100).toFixed(1) + '%，断口 ' + line.gaps);
  check('铅笔画出的是连续线（覆盖率 > 95%）', line.ratio > 0.95, (line.ratio * 100).toFixed(1) + '%');

  // 顺带对比一下「画笔」也应该是连续线
  const pencilInk = await dark();
  await page.screenshot({ path: path.join(OUT, 'v3-pencil.png') });
  console.log('   铅笔着墨像素 =', pencilInk);

  /* ============ [2] 小笔刷光标 ============ */
  console.log('\n=== [2] 画笔光标形状（默认「智能」） ===');
  const sizes = [1, 2, 4, 7, 12, 30, 90];
  for (const s of sizes) {
    await page.evaluate(v => {
      const el = document.querySelector('#sizeRange');
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, s);
    await page.mouse.move(box2.x + box2.width / 2 + 0.37, box2.y + box2.height / 2 + 0.61);
    await sleep(160);
    const info = await page.evaluate(() => {
      const el = document.querySelector('#brushCursor');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const dot = el.querySelector('.bc-dot').getBoundingClientRect();
      return {
        w: +r.width.toFixed(2), h: +r.height.toFixed(2),
        left: el.style.left, top: el.style.top,
        cls: el.className.replace('brush-cursor', '').trim(),
        radius: cs.borderRadius, border: cs.borderWidth,
        bg: cs.backgroundSize,
        dotW: +dot.width.toFixed(2)
      };
    });
    const scale = await page.evaluate(() => window.ChaApp.engine.scale);
    const expected = Math.round(s * scale);
    const isCross = /\bcross\b/.test(info.cls);
    console.log(`   size=${String(s).padStart(2)}  ${info.w}×${info.h}  left/top=${info.left}/${info.top}  ` +
      `r=${info.radius}  border=${info.border}  中心点=${info.dotW}px  ` +
      `${isCross ? '十字(' + info.bg + ')' : '圆环'}  ${info.cls ? '[' + info.cls + ']' : ''}`);
    check(`size=${s} 包围盒是正方形（几何上不可能变椭圆）`, Math.abs(info.w - info.h) < 0.6, `${info.w}×${info.h}`);
    check(`size=${s} 没有 border（border-box 会把环挤变形）`, info.border === '0px', info.border);
    check(`size=${s} 位置按整像素对齐（半像素抗锯齿正是「椭圆」的成因）`,
      /^-?\d+px$/.test(info.left) && /^-?\d+px$/.test(info.top), info.left + '/' + info.top);
    if (s * scale >= 9) {
      check(`size=${s} 画的是圆环、直径=笔刷大小×缩放`, !isCross && Math.abs(info.w - expected) <= 1,
        `w=${info.w} 期望≈${expected}`);
    }
  }
  // 切成「始终圆环」：小笔刷也必须还是正圆
  await page.evaluate(() => {
    const sel = document.querySelector('#cursorStyle');
    sel.value = 'ring'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => {
    const el = document.querySelector('#sizeRange');
    el.value = 2; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.mouse.move(box2.x + box2.width / 2 + 0.37, box2.y + box2.height / 2 + 0.61);
  await sleep(220);
  const ringSmall = await page.evaluate(() => {
    const el = document.querySelector('#brushCursor');
    const r = el.getBoundingClientRect();
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), cls: el.className, radius: getComputedStyle(el).borderRadius };
  });
  console.log('   「始终圆环」+ size=2 →', JSON.stringify(ringSmall));
  check('切成「始终圆环」后小笔刷也是正圆', Math.abs(ringSmall.w - ringSmall.h) < 0.6 && !/cross/.test(ringSmall.cls),
    `${ringSmall.w}×${ringSmall.h}`);

  await page.evaluate(() => {
    const sel = document.querySelector('#cursorStyle');
    sel.value = 'auto'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const el = document.querySelector('#sizeRange');
    el.value = 3; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.mouse.move(box2.x + box2.width / 2 + 0.37, box2.y + box2.height / 2 + 0.61);
  await sleep(250);
  const bc = await page.locator('#brushCursor').boundingBox();
  if (bc) await page.screenshot({
    path: path.join(OUT, 'v3-cursor-small.png'),
    clip: { x: Math.max(0, bc.x - 30), y: Math.max(0, bc.y - 30), width: 60, height: 60 }
  });

  /* ============ [3] 面板拖动排序（拖标题栏 / 自动滚动） ============ */
  console.log('\n=== [3] 面板拖动排序 ===');
  await page.evaluate(() => { document.querySelector('#leftPanelScroll').scrollTop = 0; });
  await sleep(250);
  const order0 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#leftPanelScroll [data-section]')).map(s => s.dataset.section));
  const heads = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#leftPanelScroll [data-section] > h4').forEach(h => {
      const r = h.getBoundingClientRect();
      out[h.closest('[data-section]').dataset.section] = { x: r.x + 40, y: r.y + r.height / 2 };
    });
    out.__scroll = document.querySelector('#leftPanelScroll').getBoundingClientRect().toJSON();
    return out;
  });
  console.log('   拖动前:', order0.join(' > '));
  // 拖「工具栏」标题到「导航器」标题上方
  await page.mouse.move(heads.tools.x, heads.tools.y);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.move(heads.nav.x, heads.nav.y + 3, { steps: 12 });
  await sleep(80);
  await page.mouse.up();
  await sleep(350);
  const order1 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#leftPanelScroll [data-section]')).map(s => s.dataset.section));
  console.log('   拖标题后:', order1.join(' > '));
  check('拖小节标题即可换序（不再只能抓 ⋮⋮）', order0.join() !== order1.join());
  check('顺序写进 localStorage', !!(await page.evaluate(() => localStorage.getItem('chahu.panelOrder'))));

  // 自动滚动：把「图层」标题拖到面板底部边缘，看列表是否自动往下滚
  const stBefore = await page.evaluate(() => document.querySelector('#leftPanelScroll').scrollTop);
  const layHead = await page.evaluate(() => {
    const h = document.querySelector('[data-section="layers"] > h4');
    h.scrollIntoView({ block: 'center' });
    const r = h.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  });
  await sleep(200);
  const sc = await page.evaluate(() => document.querySelector('#leftPanelScroll').getBoundingClientRect().toJSON());
  await page.mouse.move(layHead.x, layHead.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.move(layHead.x, sc.bottom - 4, { steps: 8 });
  await sleep(700);
  await page.mouse.up();
  await sleep(200);
  const stAfter = await page.evaluate(() => document.querySelector('#leftPanelScroll').scrollTop);
  console.log('   自动滚动: scrollTop ' + Math.round(stBefore) + ' → ' + Math.round(stAfter));
  await page.evaluate(() => document.querySelector('#btnPanelReset').click());
  await sleep(250);

  /* ============ [4] 图层清除 ============ */
  console.log('\n=== [4] 图层「清除」 ===');
  await page.click('#toolGrid .tool[data-item="brush"]');
  await sleep(200);
  await page.evaluate(() => {
    const el = document.querySelector('#sizeRange');
    el.value = 40; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.mouse.move(box2.x + 150, box2.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box2.x + 150 + i * 10, box2.y + 200 + i * 4);
  await page.mouse.up();
  await sleep(600);
  const inkBefore = await dark();
  const strokesBefore = await page.evaluate(() => window.ChaApp.engine.strokes.length);
  console.log('   画完后：着墨像素 =', inkBefore, ' 笔迹数 =', strokesBefore);
  check('画布上确实有墨', inkBefore > 500, String(inkBefore));

  await page.evaluate(() => document.querySelector('#btnLayerClear').click());
  await sleep(350);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#confirmMask').classList.contains('hidden'),
    text: document.querySelector('#confirmBody').textContent
  }));
  check('弹出确认框', dlg.open, JSON.stringify(dlg.text));
  await page.evaluate(() => document.querySelector('#confirmYes').click());
  await sleep(1200);
  const inkAfter = await dark();
  const strokesAfter = await page.evaluate(() => window.ChaApp.engine.strokes.length);
  const thumb = await page.evaluate(() => {
    const t = document.querySelector('#layerList .thumb');
    return t ? (t.style.backgroundImage || '').slice(0, 40) : '(no thumb)';
  });
  console.log('   清除后：着墨像素 =', inkAfter, ' 笔迹数 =', strokesAfter);
  check('清除后墨迹消失', inkAfter < Math.max(50, inkBefore * 0.02), `${inkBefore} → ${inkAfter}`);
  check('清除后笔迹列表也空了', strokesAfter === 0, String(strokesAfter));
  await page.screenshot({ path: path.join(OUT, 'v3-after-clear.png') });

  /* ============ [5] 画布分辨率 ============ */
  console.log('\n=== [5] 画布分辨率设置 ===');
  const topBtn = await page.evaluate(() => {
    const b = document.querySelector('#btnCanvas');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), w: r.width, h: r.height, title: b.title };
  });
  check('顶栏有「画布」入口', !!topBtn && topBtn.w > 0, JSON.stringify(topBtn));
  await page.evaluate(() => document.querySelector('#btnCanvas').click());
  await sleep(400);
  const cvOpen = await page.evaluate(() => ({
    open: !document.querySelector('#confirmMask').classList.contains('hidden'),
    title: document.querySelector('#confirmTitle').textContent,
    now: (document.querySelector('#cvNow') || {}).textContent,
    hasPreset: !!document.querySelector('#rsPreset'),
    hasW: !!document.querySelector('#rsW'),
    hasPaper: document.querySelectorAll('#cvPaper .cv-bg').length
  }));
  console.log('   弹窗:', JSON.stringify(cvOpen));
  // 第二轮按用户给的 SAI2 截图把它改成了「图像大小」对话框
  check('画布设置弹窗打开', cvOpen.open && (cvOpen.title === '图像大小' || cvOpen.title === '画布设置'), cvOpen.title);
  check('有预设下拉 + 宽高输入 + 底纸', cvOpen.hasPreset && cvOpen.hasW && cvOpen.hasPaper >= 3);

  const sizeBefore = await page.evaluate(() => document.querySelector('#canvasSize').textContent);
  await page.evaluate(() => {
    const sel = document.querySelector('#rsPreset');
    sel.value = '1280x1280';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(150);
  await page.evaluate(() => document.querySelector('#confirmYes').click());
  await page.waitForFunction(
    () => window.ChaApp.state.room && window.ChaApp.state.room.width === 1280,
    { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  const sizeAfter = await page.evaluate(() => document.querySelector('#canvasSize').textContent);
  const roomSize = await page.evaluate(() => window.ChaApp.state.room && [window.ChaApp.state.room.width, window.ChaApp.state.room.height]);
  console.log('   底栏尺寸: ' + sizeBefore + '  →  ' + sizeAfter + '  room=' + JSON.stringify(roomSize));
  check('分辨率真的改掉了', roomSize && roomSize[0] === 1280 && roomSize[1] === 1280, JSON.stringify(roomSize));
  const viewBoxAfter = await page.locator('#view').boundingBox();
  check('画布仍在正常范围内（不再出现 3300 万像素的巨型画布）',
    viewBoxAfter.height < 4000 && viewBoxAfter.width < 4000,
    `${Math.round(viewBoxAfter.width)}×${Math.round(viewBoxAfter.height)}`);

  /* ============ [1'] 一键清理空房 ============ */
  console.log('\n=== [1\'] 一键清理空房 ===');
  // 先用第二个浏览器上下文建一个「一笔没画」的房间，然后关掉它 —— 这正是「无用房间」的样子
  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#entryMask:not(.hidden)');
  await page2.fill('#nameInput', '空房制造机');
  await page2.fill('#newRoomName', '一个没用的空房');
  await page2.click('#btnCreateRoom');
  await page2.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(800);
  const blankId = await page2.evaluate(() => window.ChaApp.state.room.id);
  console.log('   造了个空房:', blankId);
  await ctx2.close();          // 关掉 → 没人在线 + 一笔没画
  await sleep(1200);

  const roomsNow = await page.evaluate(async () => (await fetch('/api/rooms').then(r => r.json())).rooms);
  const blanksBefore = roomsNow.filter(r => r.blank).length;
  console.log('   清理前：房间 ' + roomsNow.length + ' 个，其中空房 ' + blanksBefore + ' 个');
  check('空房被子标记出来', blanksBefore >= 1, String(blanksBefore));

  await page.evaluate(() => document.querySelector('#btnRooms').click());
  await sleep(300);
  const badge = await page.evaluate(() => document.querySelector('#roomCount').textContent);
  console.log('   列表计数徽标:', JSON.stringify(badge));
  check('列表计数带空房数', /空 \d+/.test(badge), badge);

  await page.evaluate(() => document.querySelector('#btnPurgeRooms').click());
  await sleep(300);
  const confirmTxt = await page.evaluate(() => document.querySelector('#confirmBody').textContent);
  console.log('   确认文案:', JSON.stringify(confirmTxt));
  check('确认文案给出准确的空房条数', confirmTxt.indexOf(String(blanksBefore)) >= 0, confirmTxt);
  await page.evaluate(() => document.querySelector('#confirmYes').click());
  await sleep(1800);
  const roomsAfter = await page.evaluate(async () => (await fetch('/api/rooms').then(r => r.json())).rooms);
  const blanksAfter = roomsAfter.filter(r => r.blank).length;
  console.log('   清理后：房间 ' + roomsAfter.length + ' 个，其中空房 ' + blanksAfter + ' 个');
  check('清理后空房归零', blanksAfter === 0, String(blanksAfter));
  check('那个空房被删掉了', !roomsAfter.some(r => r.id === blankId), blankId);
  check('有内容的房间没被误删', roomsAfter.length >= 1, String(roomsAfter.length));
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);

  /* ============ 收尾截图 ============ */
  await page.evaluate(() => {
    const el = document.querySelector('#sizeRange');
    el.value = 6; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#toolGrid .tool[data-item="pencil"]');
  await sleep(300);
  await page.mouse.move(box2.x + 100, box2.y + 150);
  await page.mouse.down();
  for (let i = 1; i <= 70; i++) {
    await page.mouse.move(box2.x + 100 + i * 6, box2.y + 150 + Math.sin(i / 8) * 40);
  }
  await page.mouse.up();
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'v3-final.png') });

  console.log('\n页面错误: ' + (errors.length ? errors.join(' | ') : '无'));
  check('运行期间无 JS 报错', errors.length === 0, errors.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
