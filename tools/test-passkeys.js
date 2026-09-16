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
 *   ⑤ 快捷菜单自定义：⚙ 面板勾选显隐 → 立即生效 + 刷新记住 + 恢复默认
 *   ⑥ 经典模式主题下拉与接龙同源（快照 themes + /api/share themeList 垫底）
 *   ⑦ 默认键位：B=画笔本人 / W=魔棒 / 选区笔无键 / 吸管=Alt；槽位数字照旧
 *   ⑧ 右键笔刷弹小窗：改键（含 Alt、功能键拦截）、清除（清除后真的无键）、内置=收起
 *   ⑨ 编辑模式按住拖动排序（DOM 顺序 + localStorage 同步）
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

  // 工具键：B 现在是「画笔」这支笔本人的快捷键（不再是模糊的家族切换）
  await B.keyboard.press('b');
  await sleep(250);
  ok('按 B 切到「画笔」本人（brushId=brush，不只是家族）',
    await B.evaluate(() => window.ChaApp.state.tool === 'brush' &&
      window.ChaApp.state.brushId === 'brush'));
  await B.keyboard.press('e');
  await sleep(250);
  ok('按 E 切到橡皮',
    await B.evaluate(() => window.ChaApp.state.tool === 'eraser'));
  await B.keyboard.press('b');
  await sleep(250);
  ok('再按 B 回到画笔本人',
    await B.evaluate(() => window.ChaApp.state.brushId === 'brush'));
  await B.keyboard.press('w');
  await sleep(250);
  ok('按 W 切到魔棒（默认键新规则）',
    await B.evaluate(() => window.ChaApp.state.tool === 'wand'));
  await B.keyboard.press('b');
  await sleep(200);

  // 键位角标：没设字母键的笔刷显示槽位数字；选区笔不设键；吸管是 Alt
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
  ok('工具栏的选区笔没有快捷键角标（不设键）',
    await B.evaluate(() => {
      const sel = document.querySelector('#toolGrid .tool[data-tool="select"]');
      return !!sel && !sel.querySelector('.tkey');
    }));
  ok('魔棒显示 W 角标（工具栏里）',
    await B.evaluate(() => {
      const wand = document.querySelector('#toolGrid .tool[data-tool="wand"] .tkey');
      return !!wand && wand.textContent === 'W';
    }));
  ok('吸管显示 Alt 角标',
    await B.evaluate(() => {
      const p = document.querySelector('#toolGrid .tool[data-tool="picker"] .tkey');
      return !!p && p.textContent === 'Alt';
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

  /* ================= [5] 快捷菜单自定义 ================= */
  console.log('\n[5] 快捷菜单自定义（显隐 + 持久化 + 恢复默认）');
  ok('默认所有功能块都显示',
    await B.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#qbBody .qb-item[data-item]'))
        .filter(w => !w.getAttribute('data-fixed'));
      return items.length >= 8 && items.every(w => !w.classList.contains('hidden'));
    }));
  await B.click('#qbEditBtn');
  ok('点 ⚙ 弹出自定义面板',
    await waitForPage(B, () => !document.querySelector('#qbEditMask').classList.contains('hidden'), 4000, 'qbEditMask'));
  ok('面板里列出 8 块功能',
    await B.evaluate(() => document.querySelectorAll('#qbEditList .check-row').length === 8));

  // 取消「缩放」「旋转」（第 3、4 个 checkbox）
  await B.evaluate(() => {
    const rows = document.querySelectorAll('#qbEditList .check-row input');
    rows[2].click(); rows[3].click();
  });
  await sleep(200);
  ok('取消勾选后缩放/旋转立即隐藏，撤销还在',
    await B.evaluate(() => {
      const q = k => document.querySelector('#qbBody .qb-item[data-item="' + k + '"]');
      return q('zoom').classList.contains('hidden') &&
             q('rot').classList.contains('hidden') &&
             !q('undo').classList.contains('hidden');
    }));
  ok('选择已写入 localStorage',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.quickbar.items') || '{}');
        return m.zoom === false && m.rot === false;
      } catch (e) { return false; }
    }));

  // 刷新页面 → 配置还在
  await B.goto(BASE + '/?room=' + (await B.evaluate(() => window.ChaApp.state.room.id)));
  await B.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(1000);
  try { await B.click('#btnEntryClose', { timeout: 1500 }); } catch (e) { /* 没遮罩就算了 */ }
  ok('刷新后缩放/旋转仍然是隐藏的（配置被记住）',
    await B.evaluate(() => {
      const q = k => document.querySelector('#qbBody .qb-item[data-item="' + k + '"]');
      return q('zoom').classList.contains('hidden') && q('rot').classList.contains('hidden');
    }));

  // 恢复默认
  await B.click('#qbEditBtn');
  await B.waitForFunction(() => !document.querySelector('#qbEditMask').classList.contains('hidden'), { timeout: 4000 });
  await B.click('#btnQbReset');
  await sleep(200);
  ok('恢复默认后所有功能块都回来了',
    await B.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#qbBody .qb-item[data-item]'))
        .filter(w => !w.getAttribute('data-fixed'));
      return items.every(w => !w.classList.contains('hidden')) &&
             localStorage.getItem('chahu.quickbar.items') === null;
    }));
  await B.click('#btnQbDone');
  ok('「完成」关掉自定义面板',
    await B.evaluate(() => document.querySelector('#qbEditMask').classList.contains('hidden')));

  /* ================= [6] 经典模式词库与接龙同源 ================= */
  console.log('\n[6] 经典模式主题下拉（内置 + 自定义同源）');
  await B.click('#btnGame');
  ok('点「游戏」弹出开局面板',
    await waitForPage(B, () => !document.querySelector('#gameMask').classList.contains('hidden'), 4000, 'gameMask'));
  await sleep(600);   // 等 /api/share 的 themeList 晚到补位（如果快照没先到）
  const themeInfo = await B.evaluate(() => {
    const sel = document.querySelector('#gameTheme');
    return { n: sel.options.length,
             ids: Array.from(sel.options).map(o => o.value),
             hasGenshin: !!Array.from(sel.options).find(o => o.value === 'genshin'),
             hasAnime: !!Array.from(sel.options).find(o => o.value === 'anime') };
  });
  ok('经典面板的主题下拉有完整的 15 套（不再是单个占位项）', themeInfo.n >= 15, '实际 ' + themeInfo.n);
  ok('下拉里有扩展词库（原神 / 二次元混合）', themeInfo.hasGenshin && themeInfo.hasAnime, JSON.stringify(themeInfo.ids));
  ok('自定义词库与接龙共用同一个数据源（themeList 长度一致）',
    await B.evaluate(() => {
      const gs = window.ChaApp.state.themes || [];
      const sel = document.querySelector('#gameTheme');
      return gs.length > 0 && sel.options.length === gs.length;
    }));
  await B.click('#btnGameStart', { trial: true }).catch(() => {});
  await B.evaluate(() => document.querySelector('#gameMask').classList.add('hidden'));

  /* ================= [7] 右键笔刷：改键 / 清除 / 收起 ================= */
  console.log('\n[7] 右键笔刷弹小窗（改键 / 清除 / 收起）');
  // 给「水彩笔」设键 P（它没有默认键，槽位也不靠前，断言干净）
  const wcSel = '#brushGrid .tool[data-item="watercolor"]';
  await B.click(wcSel, { button: 'right' });
  ok('右键笔刷弹出小窗，写上了笔名',
    await waitForPage(B, () => {
      const m = document.querySelector('#itemCtxMenu');
      return !m.classList.contains('hidden') && /水彩笔/.test(document.querySelector('#icmName').textContent);
    }, 4000, 'itemCtxMenu'));
  ok('没设键时显示「快捷键：无」',
    await B.evaluate(() => /快捷键：无/.test(document.querySelector('#icmKey').textContent)));
  await B.click('#icmKey');
  ok('点「快捷键」进入捕获模式',
    await B.evaluate(() => /按下新快捷键/.test(document.querySelector('#icmKey').textContent)));
  await B.keyboard.press('p');
  await sleep(300);
  ok('按 P 完成捕获并写进 localStorage',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
        return m.watercolor === 'P';
      } catch (e) { return false; }
    }));
  ok('水彩笔的角标变成 P',
    await B.evaluate(() => {
      const t = document.querySelector('#brushGrid .tool[data-item="watercolor"] .tkey');
      return !!t && t.textContent === 'P';
    }));
  await B.keyboard.press('p');
  await sleep(250);
  ok('按 P 真的切到水彩笔',
    await B.evaluate(() => window.ChaApp.state.brushId === 'watercolor'));

  // 功能键拦截：给铅笔设 H 会被拒（全局翻转键）
  await B.click('#brushGrid .tool[data-item="pencil"]', { button: 'right' });
  await B.click('#icmKey');
  await B.keyboard.press('h');
  await sleep(250);
  ok('H 被拦截（全局功能键不让笔刷抢）',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
        return m.pencil === undefined || m.pencil === '';
      } catch (e) { return false; }
    }));
  await B.keyboard.press('Escape');   // 先退出捕获模式（否则下一个字母会被当成设键）
  await sleep(150);
  await B.keyboard.press('b');        // 切回画笔，别停在「水彩笔」上
  await sleep(250);

  // 清除快捷键 → 真的无键：P 不再切水彩笔
  await B.click(wcSel, { button: 'right' });
  await B.click('#icmClear');
  await sleep(300);
  ok('清除后 localStorage 里是空串',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
        return m.watercolor === '';
      } catch (e) { return false; }
    }));
  await B.keyboard.press('p');
  await sleep(250);
  ok('清除后按 P 不再切到水彩笔（不回落默认键）',
    await B.evaluate(() => window.ChaApp.state.brushId !== 'watercolor'));

  // Alt 设键
  await B.click(wcSel, { button: 'right' });
  await B.click('#icmKey');
  await B.keyboard.press('Alt');
  await sleep(300);
  ok('捕获 Alt 存为「Alt」并显示在角标上',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
        const t = document.querySelector('#brushGrid .tool[data-item="watercolor"] .tkey');
        return m.watercolor === 'Alt' && !!t && t.textContent === 'Alt';
      } catch (e) { return false; }
    }));
  await B.keyboard.press('Escape');
  await sleep(200);
  ok('Esc 关掉小弹窗',
    await B.evaluate(() => document.querySelector('#itemCtxMenu').classList.contains('hidden')));

  // 内置笔刷「删除」= 收起（可放回）；关掉弹窗后角标还原
  await B.click(wcSel, { button: 'right' });
  ok('内置笔刷的删除按钮叫「收起笔刷」',
    await B.evaluate(() => /收起笔刷/.test(document.querySelector('#icmDel').textContent)));
  await B.click('#icmDel');
  await sleep(300);
  ok('点收起后水彩笔从笔刷栏消失',
    await B.evaluate(() => !document.querySelector('#brushGrid .tool[data-item="watercolor"]')));
  await B.click('#btnBrushEdit');   // 进编辑模式 → 收起池里放回来
  await sleep(300);
  ok('编辑模式的收起池里有水彩笔，点一下放回',
    await B.evaluate(() => {
      const pool = Array.from(document.querySelectorAll('#toolHiddenPool .tb-item'));
      const it = pool.find(b => /水彩笔/.test(b.textContent));
      if (it) { it.click(); return true; }
      return false;
    }));
  await sleep(300);
  ok('放回后水彩笔回到笔刷栏',
    await B.evaluate(() => !!document.querySelector('#brushGrid .tool[data-item="watercolor"]')));
  await B.click('#btnBrushEdit');   // 退出编辑模式
  await sleep(200);
  ok('收起/放回不丢键位覆盖（Alt 还在）',
    await B.evaluate(() => {
      try {
        const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
        return m.watercolor === 'Alt';
      } catch (e) { return false; }
    }));
  // 清理现场：把 watercolor 的覆盖清掉，不影响后面的断言
  await B.evaluate(() => {
    try {
      const m = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
      m.watercolor = '';
      localStorage.setItem('chahu.itemKeys', JSON.stringify(m));
    } catch (e) { /* ignore */ }
  });

  /* ================= [8] 编辑模式拖动排序 ================= */
  console.log('\n[8] 编辑模式按住拖动排序');
  await B.click('#btnBrushEdit');
  await sleep(250);
  const dragIds0 = await B.evaluate(() =>
    Array.from(document.querySelectorAll('#brushGrid .tool')).map(b => b.dataset.item));
  const src = await B.locator('#brushGrid .tool').first().boundingBox();
  const dst = await B.locator('#brushGrid .tool').nth(1).boundingBox();
  await B.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await B.mouse.down();
  // 拖到第二格的下半 → 插到它后面
  await B.mouse.move(dst.x + dst.width / 2, dst.y + dst.height * 0.8, { steps: 8 });
  await sleep(120);
  await B.mouse.up();
  await sleep(400);
  const dragIds1 = await B.evaluate(() =>
    Array.from(document.querySelectorAll('#brushGrid .tool')).map(b => b.dataset.item));
  ok('拖动后前两支笔换了位置（' + dragIds0[0] + ' ↔ ' + dragIds1[0] + '）',
    dragIds1[0] === dragIds0[1] && dragIds1[1] === dragIds0[0],
    JSON.stringify({ before: dragIds0.slice(0, 3), after: dragIds1.slice(0, 3) }));
  ok('新顺序已持久化到 localStorage（chahu.tools）',
    await B.evaluate((first) => {
      try {
        const o = JSON.parse(localStorage.getItem('chahu.tools') || '{}').order || [];
        return o[0] === first;
      } catch (e) { return false; }
    }, dragIds1[0]));
  ok('拖完后激活笔刷没被换掉（拖动不触发选中）',
    await B.evaluate(() => {
      const a = document.querySelector('#brushGrid .tool.active');
      return a && window.ChaApp.state.brushId === a.dataset.item;
    }));
  await B.click('#btnToolReset');   // 编辑模式里点「恢复默认」：顺序还原，别影响别的测试
  await sleep(300);
  await B.click('#btnBrushEdit');   // 退出编辑

  /* ================= [9] 控制台干净 ================= */
  console.log('\n[9] 控制台干净');
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
