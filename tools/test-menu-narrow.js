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
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h } });
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
    }

    // 关键断言③：下拉不出屏（左右上下都在视口内）
    const inView = await page.evaluate(() => {
      const t = document.querySelectorAll('#menuBar .menu-title');
      const last = t[t.length - 1];
      last.click();
      const drop = document.querySelector('#menuBar .menu-item:last-child .menu-drop');
      const r = drop.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
               vw: window.innerWidth, vh: window.innerHeight };
    });
    ok('最后一个菜单的下拉不出屏',
      inView.left >= 0 && inView.right <= inView.vw + 1 && inView.top >= 0 && inView.bottom <= inView.vh + 1,
      '[' + inView.left.toFixed(0) + ',' + inView.right.toFixed(0) + '] vs vw=' + inView.vw);

    // 关键断言④：子菜单可点（「另存为」这类有子项的）
    await page.evaluate(() => document.body.click());
    await sleep(100);
    const subInfo = await page.evaluate(() => {
      // 打开「文件」再找带子菜单的父项
      document.querySelector('#menuBar .menu-title').click();
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
        rowHitInside: row.contains(hit),
        hit: hit ? (hit.className || hit.tagName) : null
      };
    });
    if (subInfo.found) {
      ok('子菜单是 fixed', subInfo.subPos === 'fixed', subInfo.subPos);
      ok('子菜单在视口内', subInfo.subInView);
      ok('子菜单里的项可命中', !!subInfo.rowHitInside, '命中 ' + subInfo.hit);
    } else {
      console.log('  (本档没找到带子菜单的项，跳过)');
    }

    ok('无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '  ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
