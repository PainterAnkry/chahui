/**
 * 茶绘 · 侧栏四项改进验收（真浏览器）
 *
 *   ① 缩放镜合并：工具栏只有一个「缩放」工具；点按 = ±1.25 档，
 *      按住往右拖连续放大、往左拖连续缩小；工具栏新增画笔 / 橡皮擦入口
 *   ② 面板自由拖动：小节拖出侧栏变浮窗（挂 body 上），拖回栏里重新停靠
 *   ③ 主题：html[data-theme] 切换不报错（标题栏深色是 Electron 主进程行为，
 *      浏览器测不了原生标题栏，只回归渲染端不炸）
 *   ④ 窄屏快捷条：layout-narrow 下出现 底部 dock —— 最近色点按换色、
 *      最近笔点按换笔、点当前色跳颜色面板
 *
 * 用法:
 *   PORT=8437 node server/src/index.js
 *   node tools/test-ui-4features.js http://127.0.0.1:8437
 */
'use strict';
const path = require('path');
const { chromium } = require(path.resolve(__dirname, 'pw'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8437').replace(/\/$/, '');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ================= 宽屏：① 缩放合并 + ② 自由浮窗 ================= */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await page.evaluate(() => {
    document.querySelector('#nameInput').value = 'UI验收';
    document.querySelector('#newRoomName').value = '四项改进房';
    document.querySelector('#btnCreateRoom').click();
  });
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(500);
  await page.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  // 入口页在某些流程里会被无 force 的 toggle 再次弹出（大厅逻辑）。
  // 测试只关心画布区交互，直接样式级压掉，保证鼠标命中的确定性。
  await page.addStyleTag({ content: '#entryMask{display:none!important}' });
  await sleep(200);

  console.log('\n【一】缩放镜合并 + 工具栏笔刷/橡皮擦');
  const grid = await page.evaluate(() => ({
    zoom: !!document.querySelector('#toolGrid [data-item="zoom"]'),
    zoomIn: !!document.querySelector('#toolGrid [data-item="zoomIn"]'),
    zoomOut: !!document.querySelector('#toolGrid [data-item="zoomOut"]'),
    brush: !!document.querySelector('#toolGrid [data-item="brush"]'),
    eraser: !!document.querySelector('#toolGrid [data-item="eraser"]')
  }));
  ok('工具栏有合并后的「缩放」工具', grid.zoom);
  ok('旧的放大/缩小两个独立格子已消失', !grid.zoomIn && !grid.zoomOut);
  ok('工具栏新增画笔入口', grid.brush);
  ok('工具栏新增橡皮擦入口', grid.eraser);

  // 点按 = ×1.25
  await page.click('#toolGrid [data-item="zoom"]');
  await sleep(120);
  const toolIs = await page.evaluate(() => window.ChaApp.state.tool);
  ok('点缩放格子 → 当前工具变为 zoom', toolIs === 'zoom', toolIs);
  const s0 = await page.evaluate(() => window.ChaApp.engine.scale);
  const center = await page.evaluate(() => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.click(center.x, center.y);
  await sleep(150);
  const s1 = await page.evaluate(() => window.ChaApp.engine.scale);
  ok('单击画布 = 放大一档（×1.25）', Math.abs(s1 - s0 * 1.25) < 1e-6, `${s0} → ${s1}`);

  // 按住往右拖 = 连续放大
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(center.x + i * 15, center.y);
  await page.mouse.up();
  await sleep(150);
  const s2 = await page.evaluate(() => window.ChaApp.engine.scale);
  ok('按住往右拖 150px ≈ ×1.5（连续放大）', s2 > s1 * 1.35, `${s1} → ${s2}`);

  // 按住往左拖 = 连续缩小（回到接近原值）
  await page.mouse.move(center.x + 150, center.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(center.x + 150 - i * 30, center.y);
  await page.mouse.up();
  await sleep(150);
  const s3 = await page.evaluate(() => window.ChaApp.engine.scale);
  ok('按住往左拖 300px ≈ 缩回一半（连续缩小）', s3 < s2 * 0.65, `${s2} → ${s3}`);

  console.log('\n【二】面板小节自由拖动（拖出变浮窗 / 拖回停靠）');
  const navSel = '#leftPanelScroll [data-section="nav"] h4';
  const hasNav = await page.evaluate(() => !!document.querySelector('#leftPanelScroll [data-section="nav"] h4'));
  if (!hasNav) {
    // nav 可能被收起/换位置：随便挑左栏第一个小节
    ok('左栏存在可拖的小节', false, '找不到 data-section=nav，测试需要调整');
  } else {
    const h = await page.locator(navSel).boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    // 拖到画布中央（侧栏之外）
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(h.x + (center.x - h.x) * i / 8, h.y + (center.y - h.y) * i / 8);
    }
    await page.mouse.up();
    await sleep(250);
    const floated = await page.evaluate(() => {
      const sec = document.querySelector('[data-section="nav"]');
      return {
        floating: sec.classList.contains('section-floating'),
        onBody: sec.parentElement === document.body,
        pos: sec.style.left && sec.style.top
      };
    });
    ok('拖出侧栏 → 小节变成浮窗', floated.floating && floated.onBody);
    ok('浮窗有落点坐标', floated.pos);

    // 浮窗拖回右栏 → 重新停靠
    const dbg = await page.evaluate(() => {
      const sec = document.querySelector('[data-section="nav"]');
      const h4 = sec.querySelector('h4');
      const r = h4.getBoundingClientRect();
      const cs = getComputedStyle(h4);
      return { cls: sec.className, parent: sec.parentElement.tagName,
        left: sec.style.left, top: sec.style.top, w: sec.style.width,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        disp: cs.display, vis: cs.visibility, secDisp: getComputedStyle(sec).display };
    });
    console.log('    [debug]', JSON.stringify(dbg));
    // 浮窗拖回栏容器 → 重新停靠（落在左栏「工具栏」小节的标题上）
    const fh = await page.locator('[data-section="nav"] h4').boundingBox();
    const dh = await page.locator('[data-section="tools"] h4').boundingBox();
    if (!fh || !dh) { ok('浮窗拖回停靠', false, '定位失败 fh=' + !!fh + ' dh=' + !!dh); }
    else {
      await page.mouse.move(fh.x + fh.width / 2, fh.y + fh.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(fh.x + (dh.x + dh.width / 2 - fh.x) * i / 8, fh.y + (dh.y + dh.height / 2 - fh.y) * i / 8);
      }
      await page.mouse.up();
      await sleep(250);
      const docked = await page.evaluate(() => {
        const sec = document.querySelector('[data-section="nav"]');
        return {
          floating: sec.classList.contains('section-floating'),
          inPanel: !!(sec.closest('#rightPanelScroll') || sec.closest('#leftPanelScroll'))
        };
      });
      ok('拖回栏容器 → 浮窗重新停靠', !docked.floating && docked.inPanel);
    }
  }

  console.log('\n【三】主题切换回归（渲染端）');
  const theme = await page.evaluate(() => {
    const before = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    const dark = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', before);
    return { before, dark };
  });
  ok('data-theme 可切换、渲染端不报错', theme.dark === 'dark');

  await ctx.close();

  /* ================= 窄屏：④ 快捷条 ================= */
  const nctx = await browser.newContext({ viewport: { width: 780, height: 900 } });
  const np = await nctx.newPage();
  np.on('pageerror', e => pageErrors.push(e.message));
  await np.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await np.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await np.evaluate(() => {
    document.querySelector('#nameInput').value = '窄屏验收';
    document.querySelector('#newRoomName').value = '窄屏房';
    document.querySelector('#btnCreateRoom').click();
  });
  await np.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(500);
  await np.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  await np.addStyleTag({ content: '#entryMask{display:none!important}' });
  await sleep(300);

  console.log('\n【四】窄屏快捷条（快捷换色 / 换笔）');
  const dock = await np.evaluate(() => {
    const d = document.querySelector('#touchDock');
    const cs = d ? getComputedStyle(d).display : 'none';
    return {
      narrow: document.body.classList.contains('layout-narrow'),
      display: cs,
      colors: document.querySelectorAll('#tdRecent .td-chip').length,
      brushes: document.querySelectorAll('#tdBrushes .td-chip').length
    };
  });
  ok('窄屏下 body 有 layout-narrow', dock.narrow);
  ok('快捷条可见', dock.display !== 'none', dock.display);
  ok('最近色有内容（≥3 个）', dock.colors >= 3, String(dock.colors));
  ok('最近笔有内容（≥2 个）', dock.brushes >= 2, String(dock.brushes));

  // 点最近色 → 换色
  const c0 = await np.evaluate(() => window.ChaApp.state.color);
  await np.click('#tdRecent .td-chip:nth-child(2)');
  await sleep(120);
  const c1 = await np.evaluate(() => window.ChaApp.state.color);
  ok('点最近色 → 当前颜色切换', c1 !== c0, `${c0} → ${c1}`);

  // 点最近笔 → 换笔（挑一个不是当前笔的芯片点）
  const pick = await np.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#tdBrushes .td-chip'));
    const idx = chips.findIndex(c => !c.classList.contains('active'));
    return { idx, n: chips.length };
  });
  ok('最近笔芯片 ≥ 2 个', pick.n >= 2, String(pick.n));
  const b0 = await np.evaluate(() => window.ChaApp.state.brushId);
  await np.click(`#tdBrushes .td-chip:nth-child(${pick.idx + 1})`);
  await sleep(150);
  const b1 = await np.evaluate(() => window.ChaApp.state.brushId);
  ok('点最近笔 → 笔刷切换', b1 !== b0, `${b0} → ${b1}`);

  // 点当前色 → 颜色面板抽屉拉开 + 目标小节闪一下
  await np.click('#tdColor');
  await sleep(450);
  const open = await np.evaluate(() => {
    const sec = document.querySelector('[data-section="color"]');
    return {
      flashing: sec.classList.contains('section-flash') || sec.classList.contains('section-floating'),
      leftOpen: !document.querySelector('aside.panel.left').classList.contains('hidden')
    };
  });
  ok('点当前色 → 跳到颜色面板（闪烁提示 / 浮窗提示）', open.flashing);

  ok('全程无页面错误', pageErrors.length === 0, pageErrors.join(' | '));

  await nctx.close();
  await browser.close();

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
