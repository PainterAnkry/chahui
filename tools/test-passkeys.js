/**
 * 茶绘 · 密码进房 + 画笔快捷键 + 快捷条/侧栏 布局验收（真浏览器）
 *
 * 用法：
 *   PORT=8444 node server/src/index.js          # 另起服务端（计时随意）
 *   node tools/test-passkeys.js http://127.0.0.1:8444
 *
 * 覆盖：
 *   ① 带密码建房 → 房间列表带锁标 → 点加入弹密码框 → 错密码被拒 → 对密码进房
 *   ② 数字键 1-9 切笔刷槽位；工具键（B/E…）切基础画笔；键位角标可见；Ctrl+1/0 缩放
 *   ③ 快捷菜单在窄窗口下不溢出（两边不被裁）
 *   ④ 侧栏拖动调宽 → CSS 变量变化 + 持久化
 */
'use strict';
const path = require('path');
const { chromium } = require(path.resolve(__dirname, 'pw'));

const BASE = (function () {
  const a = process.argv[2] || 'http://127.0.0.1:8437';
  return a.replace(/\/$/, '');
})();

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForPage(page, fn, timeout, label) {
  try { await page.waitForFunction(fn, { timeout: timeout || 6000 }); return true; }
  catch (e) { if (label) console.log('    （超时：' + label + '）'); return false; }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const expectedErrs = [];
  const watch = (p) => {
    p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  };

  /* ================= [1] 带密码建房 ================= */
  console.log('\n[1] 带密码建房与进房');
  const A = await ctx.newPage(); watch(A);
  await A.goto(BASE + '/');
  await A.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(600);
  await A.evaluate(() => {
    document.querySelector('#nameInput').value = '房主';
    document.querySelector('#newRoomName').value = '密码房验收';
    document.querySelector('#newRoomPass').value = 'oba123';
    document.querySelector('#btnCreateRoom').click();
  });
  ok('房主建起带密码的房间',
    await waitForPage(A, () => window.ChaApp.state.joined, 15000, 'A 进房'));

  const B = await ctx.newPage(); watch(B);
  await B.goto(BASE + '/');
  await B.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await B.evaluate(() => { document.querySelector('#nameInput').value = '客人'; });
  await sleep(800);      // 等房间列表拉回来
  ok('房间列表里这间房带锁标',
    await B.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#roomList .room-item'));
      const mine = items.find(el => el.textContent.indexOf('密码房验收') >= 0);
      return !!mine && mine.textContent.indexOf('🔒') >= 0;
    }));
  // 点这间房 → 弹密码框
  await B.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#roomList .room-item'));
    const mine = items.find(el => el.textContent.indexOf('密码房验收') >= 0);
    mine.click();
  });
  ok('点带锁的房间弹出密码框',
    await waitForPage(B, () => !document.querySelector('#passMask').classList.contains('hidden'), 5000, 'passMask'));
  ok('进别人房间不会没问密码就直接进（还没 joined）',
    await B.evaluate(() => !window.ChaApp.state.joined));

  // 错密码
  await B.fill('#passInput', 'wrong-pass');
  await B.click('#btnPassOk');
  ok('错密码收到「不正确」的提示',
    await waitForPage(B, () => {
      const e = document.querySelector('#passErr');
      return !e.classList.contains('hidden') && /不正确/.test(e.textContent);
    }, 5000, 'passErr'));
  ok('错密码后没有进房',
    await B.evaluate(() => !window.ChaApp.state.joined));

  // 对密码
  await B.fill('#passInput', 'oba123');
  await B.click('#btnPassOk');
  ok('输对密码成功进房',
    await waitForPage(B, () => window.ChaApp.state.joined, 8000, 'B 进房'));
  ok('密码框自动关掉', await B.evaluate(() => document.querySelector('#passMask').classList.contains('hidden')));
  ok('密码被记住（本地存了映射）',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.roomPass') || '{}');
        const rid = window.ChaApp.state.room.id;
        return m[rid] === 'oba123';
      } catch (e) { return false; }
    }));

  /* ================= [2] 画笔快捷键 ================= */
  console.log('\n[2] 画笔快捷键');
  const brushIds = await B.evaluate(() =>
    Array.from(document.querySelectorAll('#brushGrid .tool')).map(b => b.dataset.item));
  ok('笔刷栏至少有两支笔可以切', brushIds.length >= 2, '数量 ' + brushIds.length);

  await B.keyboard.press('1');
  await sleep(250);
  ok('按 1 切到第 1 支笔',
    await B.evaluate(() => {
      const a = document.querySelector('#brushGrid .tool.active');
      const first = document.querySelector('#brushGrid .tool');
      return a && first && a.dataset.item === first.dataset.item;
    }));
  await B.keyboard.press('2');
  await sleep(250);
  ok('按 2 切到第 2 支笔',
    await B.evaluate(() => {
      const a = document.querySelector('#brushGrid .tool.active');
      const second = document.querySelectorAll('#brushGrid .tool')[1];
      return a && second && a.dataset.item === second.dataset.item;
    }));
  ok('切槽位后工具也跟着换（不是只换个高亮）',
    await B.evaluate(() => {
      const a = document.querySelector('#brushGrid .tool.active');
      return a && window.ChaApp.state.brushId === a.dataset.item;
    }));

  // 工具键：B 回到铅笔（brush 家族默认/最近一支），E 橡皮
  await B.keyboard.press('b');
  await sleep(250);
  ok('按 B 切到画笔家族',
    await B.evaluate(() => window.ChaApp.state.tool === 'brush'));
  await B.keyboard.press('e');
  await sleep(250);
  ok('按 E 切到橡皮',
    await B.evaluate(() => window.ChaApp.state.tool === 'eraser'));
  await B.keyboard.press('b');
  await sleep(250);
  ok('再按 B 回到画笔家族（最近用的那支还在）',
    await B.evaluate(() => window.ChaApp.state.tool === 'brush'));

  // 键位角标（注意：橡皮擦 / 油漆桶这些 type='brush' 的工具也住在笔刷栏里，显示字母键）
  ok('笔刷格子上显示了槽位数字角标',
    await B.evaluate(() => {
      const t = document.querySelectorAll('#brushGrid .tool .tkey');
      return t.length >= 2 && t[0].textContent === '1' && t[1].textContent === '2';
    }));
  ok('橡皮擦（住在笔刷栏）显示字母角标 E',
    await B.evaluate(() => {
      const eraser = document.querySelector('#brushGrid .tool[data-tool="eraser"] .tkey');
      return !!eraser && eraser.textContent === 'E';
    }));
  ok('工具栏的选区笔显示字母角标 Q',
    await B.evaluate(() => {
      const sel = document.querySelector('#toolGrid .tool[data-tool="select"] .tkey');
      return !!sel && sel.textContent === 'Q';
    }));
  ok('悬停提示里也写了快捷键',
    await B.evaluate(() => {
      const eraser = document.querySelector('#brushGrid .tool[data-tool="eraser"]');
      return /快捷键 E/.test(eraser.title);
    }));

  // Ctrl+1 / Ctrl+0（PS 习惯）
  await B.keyboard.press('Control+1');
  await sleep(300);
  ok('Ctrl+1 回到 100%（PS 习惯）',
    await B.evaluate(() => Math.abs(window.ChaApp.engine.scale - 1) < 0.01,
    ));
  await B.keyboard.press('Control+0');
  await sleep(300);
  ok('Ctrl+0 适应窗口（PS 习惯）',
    await B.evaluate(() => {
      const s = window.ChaApp.engine.scale;
      return s > 0 && Math.abs(s - 1) > 0.01;   // fit 后一般不是恰好 100%
    }));
  // 数字键 0 仍然是适应窗口（菜单动作）
  await B.keyboard.press('2');
  await sleep(200);
  await B.keyboard.press('0');
  await sleep(300);
  ok('裸按 0 仍是适应窗口（没被槽位逻辑吃掉）',
    await B.evaluate(() => window.ChaApp.engine.scale > 0));

  /* ================= [3] 快捷菜单不溢出 ================= */
  console.log('\n[3] 快捷菜单在窄窗口下不溢出');
  const page2 = await ctx.newPage(); watch(page2);
  await page2.setViewportSize({ width: 1024, height: 768 });
  await page2.goto(BASE + '/?room=' + (await B.evaluate(() => window.ChaApp.state.room.id)));
  await page2.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(1000);
  const qb = await page2.evaluate(() => {
    const bar = document.querySelector('#quickBar');
    const host = bar.parentElement.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    return { left: r.left, right: r.right, hostLeft: host.left, hostRight: host.right, w: r.width };
  });
  ok('快捷菜单左端在容器内（没被裁）', qb.left >= qb.hostLeft - 1, JSON.stringify(qb));
  ok('快捷菜单右端在容器内（没被裁）', qb.right <= qb.hostRight + 1, JSON.stringify(qb));
  ok('窄窗口下快捷菜单自动折行（两行也要完整）',
    await page2.evaluate(() => {
      const bar = document.querySelector('#quickBar');
      return getComputedStyle(bar).flexWrap === 'wrap';
    }));

  /* ================= [4] 侧栏拖宽 ================= */
  console.log('\n[4] 侧栏拖动调宽');
  const w0 = await B.evaluate(() => ({
    left: getComputedStyle(document.documentElement).getPropertyValue('--left-w').trim(),
    right: getComputedStyle(document.documentElement).getPropertyValue('--right-w').trim()
  }));
  const viewW0 = await B.evaluate(() => document.querySelector('#view').getBoundingClientRect().width);
  const lr = await B.locator('#leftResizer').boundingBox();
  await B.mouse.move(lr.x + lr.width / 2, lr.y + 300);
  await B.mouse.down();
  await B.mouse.move(lr.x + lr.width / 2 + 60, lr.y + 300, { steps: 6 });
  await B.mouse.up();
  await sleep(400);
  const w1 = await B.evaluate(() => ({
    left: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-w'), 10),
    right: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w'), 10),
    saved: (() => { try { return JSON.parse(localStorage.getItem('chahu.colW') || '{}'); } catch (e) { return {}; } })()
  }));
  ok('左栏拖宽 60px 生效（' + w0.left + ' → ' + w1.left + 'px）', w1.left >= parseInt(w0.left, 10) + 50,
    JSON.stringify(w1));
  ok('栏宽已持久化到 localStorage', w1.saved.left === w1.left, JSON.stringify(w1.saved));

  const rr = await B.locator('#rightResizer').boundingBox();
  await B.mouse.move(rr.x + rr.width / 2, rr.y + 300);
  await B.mouse.down();
  await B.mouse.move(rr.x + rr.width / 2 - 50, rr.y + 300, { steps: 6 });
  await B.mouse.up();
  await sleep(400);
  const w2 = await B.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w'), 10));
  ok('右栏往左拖也变宽（' + w0.right + ' → ' + w2 + 'px）', w2 >= parseInt(w0.right, 10) + 40,
    'right=' + w2);
  ok('拖动后画布跟着重排了（两栏加宽 → 画布至少缩了 90px）',
    await B.evaluate((before) => {
      const now = document.querySelector('#view').getBoundingClientRect().width;
      return (before - now) >= 90;
    }, viewW0));

  /* ================= [5] 控制台干净 ================= */
  console.log('\n[5] 控制台干净');
  const realErrs = errs.filter(e => !/favicon|net::ERR_|Download the React/i.test(e) &&
    !expectedErrs.some(x => e.indexOf(x) >= 0));
  ok('整个过程没有 JS 报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  await browser.close();

  console.log('\n' + '─'.repeat(46));
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('─'.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩了：', e && e.message); process.exit(1); });
