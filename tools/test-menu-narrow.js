/**
 * 验证窄屏菜单下拉修复：下拉（fixed）必须真的可点，且子菜单可用。
 * 用法: node tools/test-menu-narrow.js http://127.0.0.1:8440
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

const SIZES = [
  { name: '手机 390×844', w: 390, h: 844 },
  { name: '窄窗 660（断点边界）', w: 660, h: 900 },
  { name: '小窗 480×800', w: 480, h: 800 },
  { name: '桌面 1280×900（回归）', w: 1280, h: 900 }
];

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8440';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const s of SIZES) {
    console.log('\n=== ' + s.name + ' ===');
    const ctx = await browser.newContext({
      viewport: { width: s.w, height: s.h },
      // 触屏模拟：390/480 两档走真 tap（pointerType=touch），复现安卓的合成事件路径
      hasTouch: s.w <= 500,
      isMobile: s.w <= 500
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 10000 });
    await page.fill('#nameInput', 'N');
    await page.fill('#newRoomName', '窄屏菜单');
    await page.click('#btnCreateRoom');
    await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
    await sleep(700);
    await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
    await sleep(300);

    // Krita 式收纳：窄屏菜单栏默认藏进 ≡，先点开菜单面板
    await page.evaluate(() => { const b = document.querySelector('#btnAppSheet'); if (b) b.click(); });
    await sleep(350);

    // 打开「文件」菜单
    const titleRect = await page.evaluate(() => {
      const t = document.querySelector('#menuBar .menu-title');
      const b = t.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.click(titleRect.x, titleRect.y);
    await sleep(200);

    // 关键断言①：下拉第一行必须真的可命中（修复前 hitInside=false）
    const rowHit = await page.evaluate(() => {
      const drop = document.querySelector('#menuBar .menu-item .menu-drop:not(.hidden)');
      if (!drop) return { open: false };
      const row = drop.querySelector('.menu-row');
      const rb = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rb.x + rb.width / 2, rb.y + rb.height / 2);
      return {
        open: true,
        pos: getComputedStyle(drop).position,
        rect: [Math.round(rb.x), Math.round(rb.y), Math.round(rb.width), Math.round(rb.height)],
        hitInside: row.contains(hit),
        hit: hit ? (hit.className || hit.tagName) : null
      };
    });
    ok('下拉能打开', rowHit.open);
    ok('下拉是 fixed 定位（逃出 overflow 裁剪）', rowHit.pos === 'fixed', rowHit.pos);
    ok('下拉第一行可命中', !!rowHit.hitInside, '命中 ' + rowHit.hit);

    // 关键断言②：真的点一下第一行，必须触发动作（选「新建」会弹确认框/新建文档）
    if (rowHit.open) {
      const rb = rowHit.rect;
      await page.mouse.click(rb[0] + rb[2] / 2, rb[1] + rb[3] / 2);
      await sleep(300);
      const after = await page.evaluate(() => ({
        dropOpen: !!document.querySelector('#menuBar .menu-item .menu-drop:not(.hidden)'),
        anyModal: !!document.querySelector('.modal-mask:not(.hidden), #confirmMask:not(.hidden)')
      }));
      ok('点击后菜单收起（说明 click 真送达了）', !after.dropOpen);
      // 「新建」会拉出入口弹窗（room-item 列表）—— 藏掉，别盖住后面两步的下拉
      await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
      await sleep(200);
    }

    // 关键断言③：下拉不出屏（左右上下都在视口内）
    const inView = await page.evaluate(() => {
      const items = document.querySelectorAll('#menuBar .menu-item');
      const last = items[items.length - 1];
      last.querySelector('.menu-title').click();
      const drop = last.querySelector('.menu-drop');
      const r = drop.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
               vw: window.innerWidth, vh: window.innerHeight };
    });
    ok('最后一个菜单的下拉不出屏',
      inView.left >= 0 && inView.right <= inView.vw + 1 && inView.top >= 0 && inView.bottom <= inView.vh + 1,
      '[' + inView.left.toFixed(0) + ',' + inView.right.toFixed(0) + '] vs vw=' + inView.vw);

    // 关键断言④：子菜单可点（「另存为」这类有子项的）
    // 先真实点击空白处把上一步的下拉/面板都关掉（真实 pointerdown 才会走关闭逻辑），
    // 再用真实点击重开 ≡ 面板和菜单 —— 与真人操作路径一致，避免残留浮层干扰。
    await page.mouse.click(Math.floor(s.w * 0.25), Math.floor(s.h * 0.75));
    await sleep(250);
    await page.evaluate(() => { const b = document.querySelector('#btnAppSheet'); if (b && !document.body.classList.contains('menu-sheet-open')) b.click(); });
    await sleep(300);
    const firstTitle = await page.evaluate(() => {
      const t = document.querySelector('#menuBar .menu-title');
      const b = t.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.click(firstTitle.x, firstTitle.y);
    await sleep(250);
    const subInfo = await page.evaluate(() => {
      const drop = document.querySelector('#menuBar .menu-item .menu-drop:not(.hidden)');
      const parent = drop.querySelector('.menu-row.has-sub');
      if (!parent) return { found: false };
      parent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const sub = parent.parentElement.querySelector('.menu-sub');
      const sr = sub.getBoundingClientRect();
      const row = sub.querySelector('.menu-row');
      const rr = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rr.x + rr.width / 2, rr.y + rr.height / 2);
      return {
        found: true,
        subPos: getComputedStyle(sub).position,
        subInView: sr.left >= 0 && sr.right <= window.innerWidth + 1,
        subHitInside: sub.contains(hit),
        hit: hit ? (hit.className || hit.tagName) : null
      };
    });
    if (subInfo.found) {
      ok('子菜单是 fixed', subInfo.subPos === 'fixed', subInfo.subPos);
      ok('子菜单在视口内', subInfo.subInView);
      ok('子菜单里的项可命中', !!subInfo.subHitInside, '命中 ' + subInfo.hit);
    } else {
      console.log('  (本档没找到带子菜单的项，跳过)');
    }

    /* ---- v2.1.5 修复回归：≡ 面板高度 + 触屏二级菜单 ---- */

    // v2.1.5 第二批：≡ 面板合并到右侧单块 —— 动作按钮组挪进面板、左边不露、可滚动
    if (s.w <= 660) {
      const layout = await page.evaluate(() => {
        const b = document.querySelector('#btnAppSheet');
        if (b && !document.body.classList.contains('menu-sheet-open')) b.click();
        const bar = document.getElementById('menuBar');
        const ta = document.querySelector('.topbar-actions');
        const rb = bar.getBoundingClientRect();
        return {
          taInside: bar.contains(ta),
          rect: [Math.round(rb.left), Math.round(rb.right), Math.round(rb.width)],
          vw: innerWidth,
          overflowY: getComputedStyle(bar).overflowY,
          scrollable: bar.scrollHeight >= bar.clientHeight - 4,
          titleCount: bar.querySelectorAll('.menu-title').length,
          btnCount: bar.querySelectorAll('.topbar-actions .btn').length
        };
      });
      await sleep(250);
      ok('动作按钮组挪进了面板', layout.taInside, '标题 ' + layout.titleCount + ' + 按钮 ' + layout.btnCount);
      ok('面板贴右缘（左边不再露出来）',
        layout.rect[1] >= layout.vw - 12 && layout.rect[0] >= layout.vw - layout.rect[2] - 12,
        '面板 x=' + layout.rect[0] + '…' + layout.rect[1] + ' vw=' + layout.vw);
      ok('面板可竖向滚动（overflow-y:auto）', layout.overflowY === 'auto', layout.overflowY);
      // 「功能都放进去」：面板里既有菜单标题也有动作按钮
      ok('菜单标题与动作按钮同面板可见', layout.titleCount >= 5 && layout.btnCount >= 5,
        layout.titleCount + '+' + layout.btnCount);
      // 点空白处收起面板，动作按钮组要被移回顶栏（DOM 还原，不影响宽屏）
      await page.mouse.click(Math.floor(s.w * 0.25), Math.floor(s.h * 0.75));
      await sleep(250);
      const restored = await page.evaluate(() => {
        const ta = document.querySelector('.topbar-actions');
        return { back: !!ta && !document.getElementById('menuBar').contains(ta),
                 closed: !document.body.classList.contains('menu-sheet-open') };
      });
      ok('收起后动作按钮组移回顶栏', restored.back && restored.closed);
    }

    // 修复①：≡ 面板打开时 menu-bar 必须是竖排高度（height:auto 覆盖 base 的 30px）——
    // 以前 9 个标题挤在 30px 的隐藏滚动盒里，「一大半菜单看不见也点不了」
    if (s.w <= 660) {
      const sheetH = await page.evaluate(() => {
        const b = document.querySelector('#btnAppSheet');
        if (b && !document.body.classList.contains('menu-sheet-open')) b.click();
        return Math.round(document.getElementById('menuBar').getBoundingClientRect().height);
      });
      await sleep(250);
      ok('≡ 菜单面板高度 > 150px（竖排完整展开）', sheetH > 150, '高度 ' + sheetH + 'px');
      // 点空白处收起面板，别干扰桌面档的回归断言
      await page.mouse.click(Math.floor(s.w * 0.25), Math.floor(s.h * 0.75));
      await sleep(250);
    }

    // 修复②：真触屏 tap 二级菜单父项 → 子菜单展开（合成 mouseenter/click 缺失的坑）
    if (s.w <= 500) {
      // 先画一笔：色调调整在空画布上会被守卫拒绝（toast「还没有内容」），断言就没了着落
      await page.evaluate(() => {
        const e = window.ChaApp.engine;
        const st = e.beginStroke({ id: 'guard1', layerId: e.activeLayerId, tool: 'brush',
          color: '#333333', size: 30, opacity: 1, sym: 'none', seed: 9 });
        e.addPoints(st.id, [[120, 200, 0.5], [260, 200, 0.5]]);
        e.endStroke(st.id, e.seq + 1);
        e.invalidate();
      });
      await page.evaluate(() => { const b = document.querySelector('#btnAppSheet'); if (b && !document.body.classList.contains('menu-sheet-open')) b.click(); });
      await sleep(300);
      const probe = await page.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('.menu-title'));
        const f = titles.find(t => /滤镜/.test(t.textContent)) || titles[0];
        const r = f.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.touchscreen.tap(probe.x, probe.y);
      await sleep(300);
      const subProbe = await page.evaluate(() => {
        const d = document.querySelector('.menu-drop:not(.hidden)');
        const wrap = d && d.querySelector('.menu-subwrap');
        if (!wrap) return null;
        const row = wrap.querySelector('.menu-row');
        const r = row.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (subProbe) {
        await page.touchscreen.tap(subProbe.x, subProbe.y);
        await sleep(400);
        const subOpen = await page.evaluate(() => {
          const sub = document.querySelector('.menu-sub:not(.hidden)');
          if (!sub) return { open: false };
          const r = sub.getBoundingClientRect();
          const row = sub.querySelector('.menu-row');
          const rr = row.getBoundingClientRect();
          return { open: true,
            inVp: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
            items: sub.querySelectorAll('button').length,
            firstRow: { x: rr.x + rr.width / 2, y: rr.y + rr.height / 2, label: row.textContent.trim() } };
        });
        ok('触屏 tap 二级菜单展开', subOpen.open && subOpen.inVp,
          subOpen.open ? (subOpen.items + ' 项，视口内=' + subOpen.inVp) : '没展开');

        // ★ 用户反馈：次级菜单点进去之后「功能正不正常」——真 tap 子项第一行
        //   （滤镜 → 色调调整 → 色相/饱和度），必须真的弹出色调对话框
        if (subOpen.open && subOpen.firstRow) {
          await page.touchscreen.tap(subOpen.firstRow.x, subOpen.firstRow.y);
          await sleep(450);
          const acted = await page.evaluate(() => ({
            toneOpen: !!document.querySelector('#toneMask:not(.hidden)'),
            toast: (document.querySelector('#toastWrap') || {}).textContent || ''
          }));
          ok('tap 子项「' + subOpen.firstRow.label + '」功能真的执行',
            acted.toneOpen, acted.toneOpen ? '色调对话框已打开' : ('toneMask 没开，toast="' + acted.toast.slice(0, 40) + '"'));
          // 关掉对话框，别影响后面的断言
          await page.evaluate(() => { const m = document.querySelector('#toneMask'); if (m) m.classList.add('hidden'); });
        }

        // 收起（tap 切换）
        await page.touchscreen.tap(subProbe.x, subProbe.y);
        await sleep(350);
        const closed = await page.evaluate(() => !document.querySelector('.menu-sub:not(.hidden)'));
        ok('再 tap 收起', closed);
      } else {
        console.log('  (第一个下拉里没有子菜单项，跳过触屏二级菜单断言)');
      }
      await page.mouse.click(Math.floor(s.w * 0.25), Math.floor(s.h * 0.75));
      await sleep(250);
    }

    ok('无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '  ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
