/**
 * 茶绘 · 左栏收起 + 窄屏（平板 / 手机）自适应 验收（真浏览器）
 *
 * 用法：
 *   PORT=8444 node server/src/index.js
 *   node tools/test-mobile.js http://127.0.0.1:8444
 *
 * 覆盖：
 *   ① 桌面：左栏「» 按钮 / 左边窄条 / Tab / 菜单项」四种方式收放 + 刷新记住
 *   ② 底栏不再被挤出屏幕（以前 .workspace 高度漏算 30px 菜单栏）
 *   ③ 平板 1024 / 820：两栏变抽屉、默认收起、无横向溢出、画布铺满
 *   ④ 手机 390：顶栏紧凑、快捷条默认收起、动作按钮可横滑够到、抽屉近全屏
 *   ⑤ 抽屉交互：遮罩点击关闭、选完笔刷自动收左抽屉
 *   ⑥ 触屏手势：单指落笔、双指平移 + 捏合缩放
 *   ⑦ 窗口从宽拉窄再拉宽：自动切抽屉 / 恢复桌面偏好
 *   ⑧ 控制台干净
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
async function waitForPage(page, fn, timeout, label) {
  try { await page.waitForFunction(fn, { timeout: timeout || 6000 }); return true; }
  catch (e) { if (label) console.log('    （超时：' + label + '）'); return false; }
}

/** 页面几何 / 状态自查：避免各处重复写一长串 evaluate */
const probe = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      bottom: Math.round(b.bottom), right: Math.round(b.right),
      hidden: cs.display === 'none'
    };
  };
  const S = window.ChaApp.state;
  return {
    win: [innerWidth, innerHeight],
    docW: document.documentElement.scrollWidth,
    bodyClass: document.body.className,
    narrow: S.narrow,
    leftOpen: S.leftPanelOpen,
    sideCollapsed: S.sideCollapsed,
    left: box('aside.panel.left'),
    right: box('#sidePanel'),
    leftRail: box('#leftRail'),
    rightRail: box('#sideRail'),
    back: box('#drawerBack'),
    stage: box('#stage'),
    topbar: box('.topbar'),
    status: box('.statusbar'),
    quickbar: box('#quickBar'),
    qbCollapsed: document.querySelector('#quickBar').classList.contains('collapsed'),
    leftPref: localStorage.getItem('chahu.leftOpen'),
    sidePref: localStorage.getItem('chahu.side'),
    scale: window.ChaApp.engine.scale,
    tx: window.ChaApp.engine.tx,
    ty: window.ChaApp.engine.ty
  };
});

/** 隐藏入口遮罩：新开的页面会弹「进入茶绘室」，挡着画布 */
const hideMask = (page) => page.evaluate(() => {
  const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden');
});

/** 鼠标事件真的会落在画布上吗（弹窗 / 遮罩最容易偷偷盖住画布） */
const hitAt = (page, x, y) => page.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px, py);
  return el ? (el.id || el.className) : 'none';
}, [x, y]);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const errs = [];
  const watch = (p) => {
    p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  };

  /* ================= [1] 桌面：左栏收放 + 底栏不被挤出屏幕 ================= */
  console.log('\n[1] 桌面 1440×900：左栏收放');
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const D = await dctx.newPage(); watch(D);
  await D.goto(BASE + '/');
  await D.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(600);
  await hideMask(D);

  let p = await probe(D);
  ok('默认左栏是展开的', !p.left.hidden && p.left.w > 100, JSON.stringify(p.left));
  ok('底栏在视口内（不再被 30px 菜单栏挤出去）', p.status.bottom <= p.win[1] && p.status.bottom > p.win[1] - 40,
    'status.bottom=' + p.status.bottom + ' winH=' + p.win[1]);
  ok('页面没有纵向溢出', p.docW <= p.win[0], 'docW=' + p.docW);
  ok('左栏顶部有「收起」入口', await D.evaluate(() => !!document.querySelector('#btnLeftCollapse')));

  await D.click('#btnLeftCollapse');
  await sleep(350);
  p = await probe(D);
  ok('点「收起」后左栏隐藏', p.left.hidden && p.leftOpen === false);
  ok('收起后左边出现窄条', !p.leftRail.hidden && p.leftRail.w > 8 && p.leftRail.x === 0,
    JSON.stringify(p.leftRail));
  ok('收起状态写进 localStorage', p.leftPref === '0', 'chahu.leftOpen=' + p.leftPref);
  ok('画布跟着变宽（左栏让出的位置被吃掉）', p.stage.x === p.leftRail.w && p.stage.w > 900,
    'stage.x=' + p.stage.x + ' w=' + p.stage.w);

  await D.click('#leftRail');
  await sleep(350);
  p = await probe(D);
  ok('点左边窄条能拉回左栏', !p.left.hidden && p.leftOpen === true);
  ok('拉回后状态也记住了', p.leftPref === '1');

  // Tab 是菜单里「显示所有的操作面板」的快捷键
  await D.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await D.keyboard.press('Tab');
  await sleep(300);
  p = await probe(D);
  ok('Tab 键收起左栏（菜单键位仍然有效）', p.left.hidden && p.leftOpen === false);
  await D.keyboard.press('Tab');
  await sleep(300);
  p = await probe(D);
  ok('再按 Tab 展开', !p.left.hidden && p.leftOpen === true);

  await D.click('#btnLeftCollapse');
  await sleep(250);
  await D.reload();
  await D.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(600);
  await hideMask(D);
  p = await probe(D);
  ok('刷新后记住「已收起」', p.left.hidden && p.leftPref === '0');
  await D.click('#leftRail');
  await sleep(300);

  /* ================= [2] 窗口拉窄 → 自动切抽屉 ================= */
  console.log('\n[2] 窗口从 1440 拉窄到 1024：自动切抽屉');
  await D.setViewportSize({ width: 1024, height: 768 });
  await sleep(500);
  p = await probe(D);
  ok('进入窄屏布局', p.narrow === true && p.bodyClass.indexOf('layout-narrow') >= 0, p.bodyClass);
  ok('窄屏默认把左右栏都收起（给画布让路）', p.left.hidden && p.right.hidden);
  ok('左右两条窄条都在', !p.leftRail.hidden && !p.rightRail.hidden);
  ok('画布铺满整宽（只让开两条窄条）',
    p.stage.w >= p.win[0] - (p.leftRail.w + p.rightRail.w) - 2,
    'stage.w=' + p.stage.w + ' win=' + p.win[0]);
  ok('底栏仍在视口内', p.status.bottom <= p.win[1]);
  ok('没有横向溢出', p.docW <= p.win[0]);
  ok('自动切换不污染桌面偏好（chahu.leftOpen 仍是 1）', p.leftPref === '1', '=' + p.leftPref);

  await D.setViewportSize({ width: 1440, height: 900 });
  await sleep(500);
  p = await probe(D);
  ok('拉回宽屏后恢复桌面偏好（左栏重新展开）',
    p.narrow === false && !p.left.hidden && !p.right.hidden,
    'narrow=' + p.narrow + ' left.hidden=' + p.left.hidden + ' right.hidden=' + p.right.hidden);

  // 660~1080 这一段（平板竖屏 / 小窗口）：顶栏按钮挤不下时应该内部横滑，
  // 而不是把后面的按钮顶出屏幕外
  await D.setViewportSize({ width: 700, height: 900 });
  await sleep(500);
  p = await probe(D);
  ok('700px 宽下没有横向溢出', p.docW <= p.win[0], 'docW=' + p.docW + ' win=' + p.win[0]);
  const tb = await D.evaluate(() => {
    const bar = document.querySelector('.topbar-actions');
    bar.scrollLeft = bar.scrollWidth;
    const b = document.querySelector('#btnShare').getBoundingClientRect();
    const scrollable = bar.scrollWidth > bar.clientWidth;
    bar.scrollLeft = 0;
    return { right: Math.round(b.right), win: innerWidth, scrollable };
  });
  ok('700px 下最后一个顶栏按钮能滚进视野', tb.right <= tb.win + 1 && tb.right > 0, JSON.stringify(tb));
  await dctx.close();

  /* ================= [3] 平板：抽屉交互 ================= */
  console.log('\n[3] 平板 820×1180：抽屉交互');
  const tctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const T = await tctx.newPage(); watch(T);
  await T.goto(BASE + '/');
  await T.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(600);
  await hideMask(T);

  p = await probe(T);
  ok('平板也是抽屉布局', p.narrow === true && p.left.hidden && p.right.hidden);
  ok('遮罩默认不显示', p.back.hidden);

  await T.tap('#leftRail');
  await sleep(400);
  p = await probe(T);
  ok('点左边窄条弹出左抽屉', !p.left.hidden && p.left.w > 200 && p.left.h >= p.stage.h - 2,
    JSON.stringify(p.left));
  ok('抽屉弹出时画布上有暗色遮罩', !p.back.hidden);
  ok('抽屉盖不住底栏（高度不超过工作区）', p.left.bottom <= p.status.y + 1, 'left.bottom=' + p.left.bottom);

  await T.tap('#drawerBack', { position: { x: 780, y: 400 } });
  await sleep(400);
  p = await probe(T);
  ok('点遮罩关闭左抽屉', p.left.hidden && p.back.hidden);

  // 抽屉开着时，右边的画布应该确实被暗色遮罩盖住（层级没被浮层压掉）
  await T.tap('#leftRail');
  await sleep(400);
  const topAt = await T.evaluate(() => {
    const el = document.elementFromPoint(520, 300);
    return el ? (el.id || el.className) : 'none';
  });
  ok('抽屉右侧的画布被遮罩盖住', topAt === 'drawerBack', 'elementFromPoint=' + topAt);
  await T.tap('#drawerBack', { position: { x: 780, y: 400 } });
  await sleep(400);

  await T.tap('#sideRail');
  await sleep(400);
  p = await probe(T);
  ok('点右边窄条弹出右抽屉（聊天 / 成员 / 笔迹）', !p.right.hidden && p.right.w > 200);
  ok('右抽屉贴着右边', p.right.right >= p.win[0] - 2, 'right.right=' + p.right.right);
  await T.tap('#drawerBack', { position: { x: 40, y: 400 } });
  await sleep(400);
  p = await probe(T);
  ok('点遮罩关闭右抽屉', p.right.hidden);

  // 选笔刷 → 左抽屉自动收起（不然选完笔还被面板挡着画布）
  await T.tap('#leftRail');
  await sleep(400);
  ok('左抽屉已打开，能点到笔刷', await T.isVisible('#brushGrid .tool'), '');
  await T.tap('#brushGrid .tool');
  await sleep(400);
  p = await probe(T);
  ok('选完笔刷后左抽屉自动收起', p.left.hidden);
  await tctx.close();

  /* ================= [4] 手机：紧凑布局 + 触屏手势 ================= */
  console.log('\n[4] 手机 390×844：紧凑布局与手势');
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true
  });
  const M = await mctx.newPage(); watch(M);
  await M.goto(BASE + '/');
  await M.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(700);
  // 先进一间房：没进房时画布上盖着「还没有加入房间」的空状态层，
  // 那样量到的「画布能不能点到」根本没意义
  await M.evaluate(() => {
    document.querySelector('#nameInput').value = '手机端';
    document.querySelector('#newRoomName').value = '窄屏验收房';
    document.querySelector('#btnCreateRoom').click();
  });
  await waitForPage(M, () => window.ChaApp.state.joined, 15000, '手机端进房');
  await sleep(500);
  await hideMask(M);
  await sleep(200);
  /** 画布可视区正中（进房后就是能落笔的地方） */
  const midOf = () => M.evaluate(() => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });

  p = await probe(M);
  ok('手机顶栏变矮（48 → 44）', p.topbar.h <= 46, 'topbar.h=' + p.topbar.h);
  ok('手机快捷条默认收起（不挡画布）', p.qbCollapsed && p.quickbar.h < 40, JSON.stringify(p.quickbar));
  ok('底栏还在（只留关键信息）', p.status.bottom <= p.win[1] && p.status.bottom > p.win[1] - 30);
  ok('没有横向溢出', p.docW <= p.win[0], 'docW=' + p.docW);
  ok('画布可用宽度占了大头', p.stage.w >= p.win[0] * 0.82, 'stage.w=' + p.stage.w);

  // 顶栏动作按钮横向可滚：最后一个按钮要能滚到视野里
  const shareReach = await M.evaluate(async () => {
    const bar = document.querySelector('.topbar-actions');
    bar.scrollLeft = bar.scrollWidth;
    await new Promise(r => setTimeout(r, 150));
    const b = document.querySelector('#btnShare').getBoundingClientRect();
    return { x: Math.round(b.x), right: Math.round(b.right), win: innerWidth, scrollable: bar.scrollWidth > bar.clientWidth };
  });
  ok('顶栏动作按钮能横滑够到（分享按钮滚得出来）',
    shareReach.right <= shareReach.win + 1 && shareReach.right > 0, JSON.stringify(shareReach));
  ok('动作条确实发生了内部滚动', shareReach.scrollable);
  await M.evaluate(() => { document.querySelector('.topbar-actions').scrollLeft = 0; });

  const mid = await midOf();
  ok('画布上这一点没被别的层盖住',
    (await hitAt(M, mid.x, mid.y)) === 'view', await hitAt(M, mid.x, mid.y));

  // ---- 触屏手势：CDP 直接发多点触摸 ----
  const cdp = await mctx.newCDPSession(M);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  // 单指轻点：应该真的落下一笔（myUndo 多一条）
  const undoBefore = await M.evaluate(() => window.ChaApp.state.myUndo.length);
  await touch('touchStart', [{ x: mid.x, y: mid.y }]);
  await sleep(60);
  await touch('touchMove', [{ x: mid.x + 24, y: mid.y + 18 }]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(400);
  const undoAfter = await M.evaluate(() => window.ChaApp.state.myUndo.length);
  ok('单指触屏能落笔（笔迹进了撤销栈）', undoAfter > undoBefore,
    undoBefore + ' → ' + undoAfter);

  const before = await probe(M);

  // 双指：捏合放大 + 中点平移
  await touch('touchStart', [{ x: 150, y: 400 }, { x: 250, y: 400 }]);
  await sleep(80);
  await touch('touchMove', [{ x: 120, y: 420 }, { x: 300, y: 420 }]);
  await sleep(80);
  await touch('touchMove', [{ x: 100, y: 440 }, { x: 340, y: 440 }]);
  await sleep(80);
  await touch('touchEnd', []);
  await sleep(300);
  const after = await probe(M);
  ok('双指张开 → 画布被放大', after.scale > before.scale * 1.2,
    before.scale.toFixed(3) + ' → ' + after.scale.toFixed(3));
  ok('双指中点移动 → 画布跟着平移',
    Math.abs(after.tx - before.tx) + Math.abs(after.ty - before.ty) > 5,
    'd=(' + (after.tx - before.tx).toFixed(1) + ',' + (after.ty - before.ty).toFixed(1) + ')');

  // 双指收拢 → 缩小
  const before2 = await probe(M);
  await touch('touchStart', [{ x: 100, y: 440 }, { x: 340, y: 440 }]);
  await sleep(80);
  await touch('touchMove', [{ x: 180, y: 440 }, { x: 260, y: 440 }]);
  await sleep(80);
  await touch('touchEnd', []);
  await sleep(300);
  const after2 = await probe(M);
  ok('双指收拢 → 画布缩小', after2.scale < before2.scale * 0.85,
    before2.scale.toFixed(3) + ' → ' + after2.scale.toFixed(3));

  // 手势结束后画布仍然能被单指点到（没被手势状态卡死）
  ok('手势结束后画布依然可点', (await hitAt(M, mid.x, mid.y)) === 'view');

  // 画布浮层（快捷条 / 游戏 HUD / 回合卡）的层级必须低于抽屉，
  // 否则抽屉一开就被它们戳穿（手机上抽屉几乎占满屏，最容易撞上）
  const zi = await M.evaluate(() => {
    const g = (s) => {
      const el = document.querySelector(s);
      return el ? parseInt(getComputedStyle(el).zIndex, 10) : NaN;
    };
    return {
      quickbar: g('#quickBar'), hud: g('#gameHud'), score: g('#gameScore'), round: g('#roundCard'),
      back: g('#drawerBack'),
      drawer: parseInt(getComputedStyle(document.querySelector('aside.panel.left')).zIndex, 10)
    };
  });
  ok('窄屏下画布浮层的层级低于遮罩与抽屉',
    zi.quickbar < zi.back && zi.quickbar < zi.drawer &&
    zi.hud < zi.back && zi.score < zi.round + 999 && zi.score < zi.back,
    JSON.stringify(zi));

  await M.tap('#leftRail');
  await sleep(450);
  const pierced = await M.evaluate(() => {
    const r = document.querySelector('aside.panel.left').getBoundingClientRect();
    const pts = [
      [r.left + 40, r.top + 8],
      [r.left + r.width - 40, r.top + 8],
      [r.left + r.width / 2, r.top + 30]
    ];
    return pts.map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return (el && el.closest('aside.panel.left')) ? 'ok' : ((el && (el.id || el.className)) || 'none');
    });
  });
  ok('抽屉顶部没有被画布浮层戳穿（快捷条不再盖住抽屉）',
    pierced.every(s => s === 'ok'), JSON.stringify(pierced));
  await M.tap('#drawerBack', { position: { x: 386, y: 400 } }).catch(() => {});
  await sleep(300);
  await mctx.close();

  /* ================= [5] 控制台干净 ================= */
  console.log('\n[5] 控制台干净');
  errs.filter(e => !/favicon|WebSocket|ws:\/\//i.test(e)).forEach(e => console.log('    ! ' + e));
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();

  console.log('\n──────────────────────────────');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
