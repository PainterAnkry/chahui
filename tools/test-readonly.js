/**
 * 只读观众回归 —— 房主把某人设成「只能看」。
 *
 * 这个功能的重点**不是**前端把工具置灰，那只是提示。真正的边界在服务端：
 * 观众发出去的写操作必须一条都不落地。所以第 4 组故意绕开前端，直接往
 * WebSocket 上抛原始消息 —— 只测前端的话，把服务端那道闸门删了测试照样全绿。
 *
 * 覆盖：
 *   1. 基线：设置之前两个人都能画（不然下面「画不上去」可能是别的原因）
 *   2. 只有房主能设观众：前端拦一道、服务端再拦一道（绕开前端直接发原始消息）
 *   3. 设成观众：本人知道 / 顶栏标签 / 两端成员列表徽章 / 画布下方说明
 *   4. 观众的写操作全不落地：落笔、加图层
 *   5. 观众还能看、还能聊（别把人锁死）
 *   6. 观众不进画手池：开局会因为「人数不足」被拒
 *   7. 取消观众后立刻能画
 *   8. 取消后能开局（反证第 6 组的拒因确实是人数），并且
 *      **正在作画的画手不能被当场设成观众**（否则整局干等到超时）
 *   9. 离开房间后观众身份清空
 *
 * 用法: node tools/test-readonly.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const P = require('../client/renderer/protocol.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8437';

/** 页面里的小工具：数笔迹、看提示、清提示、找成员那一行 */
const HELPERS = () => {
  window.__strokes = () => window.ChaApp.engine.strokes.length;
  window.__layers = () => window.ChaApp.engine.layers.length;
  window.__toasts = () => Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' ⏐ ');
  window.__clearToasts = () => { document.querySelectorAll('.toast').forEach(t => t.remove()); };
  window.__meRoleBadge = () => {
    const e = document.getElementById('meRole');
    return !!e && !e.classList.contains('hidden');
  };
  window.__lockTip = () => {
    const e = document.getElementById('gameLockTip');
    return e ? e.textContent : '';
  };
  /** 成员列表里找某一行的状态：不用 userId，行里只有昵称 */
  window.__row = (name) => {
    const rows = Array.from(document.querySelectorAll('#memberList .member'));
    for (const r of rows) {
      const b = r.querySelector('.info b');
      if (b && b.textContent.indexOf(name) === 0) {
        const role = r.querySelector('.m-role');
        return {
          guest: !!r.querySelector('.badge.guest'),
          sub: (r.querySelector('.info span') || {}).textContent || '',
          hasRoleBtn: !!role,
          roleText: role ? role.textContent : ''
        };
      }
    }
    return null;
  };
};

/** 直接在页面里发原始协议消息 —— 绕开前端所有「提示」 */
async function raw(page, type, payload) {
  return page.evaluate(([t, p]) => window.ChaApp.net.send(t, p), [type, payload]);
}

async function waitStrokes(page, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await page.evaluate(() => window.ChaApp.engine.strokes.length) >= want) return true;
    await sleep(120);
  }
  return false;
}

async function waitPhase(page, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    if (await page.evaluate(w => {
      const g = window.ChaApp.state.game;
      return !!(g && g.phase === w);
    }, want)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * 画一笔。要点有三（都是踩过的坑）：
 *   ① 合成的鼠标事件只送给**活动页**，所以先 bringToFront，否则这一笔 0 个落点被当空笔丢掉；
 *   ② 取点必须走 engine.docToScreen —— 画布缩得比视口小时，按容器比例算出来的点会落在画外，
 *      app.js 的边界检查会静默 return，看起来就是「画了没反应」；
 *   ③ 落了笔才算数（读 engine.pending），没落上就重试。
 */
async function drawStroke(page, o) {
  const opts = o || {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.bringToFront();
    await sleep(120);
    const pts = await page.evaluate(function (oo) {
      const e = window.ChaApp.engine;
      const rect = document.querySelector('#canvasWrap').getBoundingClientRect();
      const m = (fx, fy) => {
        const s = e.docToScreen(e.width * fx, e.height * fy);
        return { x: rect.left + s.x, y: rect.top + s.y };
      };
      return { a: m(oo.x0, oo.y0), b: m(oo.x1, oo.y1) };
    }, opts);
    const x0 = pts.a.x, y0 = pts.a.y, x1 = pts.b.x, y1 = pts.b.y;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    if (await page.evaluate(() => window.ChaApp.engine.pending.size > 0)) {
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      }
      await page.mouse.up();
      await sleep(180);
      return true;
    }
    await page.mouse.up();
    await sleep(250);
  }
  return false;
}

async function createRoom(page, nick, roomName, w, h) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.evaluate(([a, b]) => {
    const s = document.querySelector('#newRoomSize');
    if (s) {
      let hit = false;
      for (const o of s.options) if (o.value === a + 'x' + b) hit = true;
      if (!hit) { const o = document.createElement('option'); o.value = a + 'x' + b; o.textContent = a + '×' + b; s.appendChild(o); }
      s.value = a + 'x' + b;
    }
  }, [w, h]);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(400);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

/**
 * 用 ?room= 直接进房。注意必须**先把昵称塞进 localStorage**：
 * 这条自动进房路径读的是 `Cfg.getName()`，读不到就随机成「茶友123」——
 * 而下面所有断言都靠昵称找成员那一行，名字对不上会全查不到。
 * （`browser.newPage()` 每次都会新开一个 context，localStorage 并不共享，
 *   所以两个页面的昵称各设各的，不会互相串。）
 */
async function join(page, room, nick) {
  await page.addInitScript(n => {
    try { localStorage.setItem('chahu.name', n); } catch (e) { /* ignore */ }
  }, nick);
  await page.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(500);
  const got = await page.evaluate(() => window.ChaApp.state.me.name);
  if (got !== nick) throw new Error('进房昵称没生效：期望 ' + nick + '，实际 ' + got);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const mkPage = async () => {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    return p;
  };
  const A = await mkPage();
  const B = await mkPage();

  const room = await createRoom(A, '甲', '观众回归', 800, 1200);
  await join(B, room, '乙');
  const aUid = await A.evaluate(() => window.ChaApp.state.me.userId);
  const bUid = await B.evaluate(() => window.ChaApp.state.me.userId);
  console.log('\n房间 ' + room + '（画布 800×1200）已就绪：甲=房主，乙=普通成员');

  /* ================= 1) 基线 ================= */
  console.log('\n=== 1) 基线：还没设观众，两个人都能画 ===');
  let n = await A.evaluate(() => window.__strokes());
  const drew = await drawStroke(B, { x0: 0.15, y0: 0.15, x1: 0.45, y1: 0.35 });
  ok('乙能落笔', drew);
  ok('甲实时收到乙的笔迹', await waitStrokes(A, n + 1), '甲=' + (await A.evaluate(() => window.__strokes())));
  ok('初始状态两个人都不是观众', !(await A.evaluate(() => window.ChaApp.myReadonly()))
    && !(await B.evaluate(() => window.ChaApp.myReadonly())));

  /* ================= 2) 只有房主能设观众 ================= */
  console.log('\n=== 2) 只有房主能设观众 ===');
  await B.evaluate(() => window.__clearToasts());
  // ① 前端这一层
  await B.evaluate(u => window.ChaApp.setReadonly(u, true), aUid);
  await sleep(400);
  ok('乙点「设观众」：前端当场拦下',
    /只有房主可以设观众/.test(await B.evaluate(() => window.__toasts())));
  ok('甲没有被设成观众（前端拦得对）', !(await A.evaluate(() => window.ChaApp.myReadonly())));
  // ② 服务端这一层（绕开前端）
  await B.evaluate(() => window.__clearToasts());
  await raw(B, P.C2S.MEMBER_ROLE, { userId: aUid, readonly: true });
  await sleep(800);
  ok('绕开前端直接发原始消息：服务端照样拒（not_owner）',
    /只有房主可以设观众/.test(await B.evaluate(() => window.__toasts())));
  ok('甲仍然不是观众（服务端拦得住）', !(await A.evaluate(() => window.ChaApp.myReadonly())));

  /* ================= 3) 设成观众 ================= */
  console.log('\n=== 3) 房主把乙设成观众 ===');
  await B.evaluate(() => window.__clearToasts());
  await A.evaluate(u => window.ChaApp.setReadonly(u, true), bUid);
  await sleep(900);

  ok('乙自己知道自己是观众了', await B.evaluate(() => window.ChaApp.myReadonly()));
  ok('乙收到「被设成观众」的提示（不能悄悄生效）',
    /观众/.test(await B.evaluate(() => window.__toasts())));
  ok('乙顶栏出现「观众」标签', await B.evaluate(() => window.__meRoleBadge()));
  ok('甲自己不显示观众标签（他不是）', !(await A.evaluate(() => window.__meRoleBadge())));

  const rowA = await A.evaluate(() => window.__row('乙'));
  ok('甲看到的乙那行挂了「观众」徽章', !!(rowA && rowA.guest), rowA);
  ok('甲的成员列表里有「可画 / 观众」开关', !!(rowA && rowA.hasRoleBtn), rowA && rowA.roleText);
  const rowB = await B.evaluate(() => window.__row('乙'));
  ok('乙自己那行也挂着「观众」徽章（两端一致）', !!(rowB && rowB.guest), rowB);
  ok('乙看不到那个开关（只有房主有）', !!(rowB && !rowB.hasRoleBtn));
  ok('乙的画布下方有「观众模式」说明',
    /观众/.test(await B.evaluate(() => window.__lockTip())),
    await B.evaluate(() => window.__lockTip()));

  /* ================= 4) 观众的写操作全不落地 ================= */
  console.log('\n=== 4) 观众的写操作全不落地（绕开前端发原始消息）===');
  const n4a = await A.evaluate(() => window.__strokes());
  const n4b = await B.evaluate(() => window.__strokes());
  await B.evaluate(t => {
    const l = window.ChaApp.engine.activeLayer();
    window.ChaApp.net.send(t.begin, {
      id: 's_guestprobe', layerId: l.id, tool: 'brush', color: '#ff0000',
      size: 24, opacity: 1, seed: 1
    });
    window.ChaApp.net.send(t.points, {
      id: 's_guestprobe',
      pts: [[80, 80, 0.5], [300, 400, 0.5], [600, 900, 0.5]]
    });
    window.ChaApp.net.send(t.end, { id: 's_guestprobe' });
  }, { begin: P.C2S.STROKE_BEGIN, points: P.C2S.STROKE_POINTS, end: P.C2S.STROKE_END });
  await sleep(900);
  ok('观众直接发原始笔迹消息：服务端不认，两端都没多出来',
    (await A.evaluate(() => window.__strokes())) === n4a
    && (await B.evaluate(() => window.__strokes())) === n4b,
    '甲=' + (await A.evaluate(() => window.__strokes())) + '/' + n4a +
    ' 乙=' + (await B.evaluate(() => window.__strokes())) + '/' + n4b);

  const l4 = await A.evaluate(() => window.__layers());
  await B.evaluate(() => window.ChaApp.addLayer());
  await sleep(800);
  ok('观众加图层也被挡（挡的不只是落笔）',
    (await A.evaluate(() => window.__layers())) === l4,
    '图层数 ' + (await A.evaluate(() => window.__layers())) + '/' + l4);

  /* ================= 5) 观众还能看、还能聊 ================= */
  console.log('\n=== 5) 观众还能看、还能聊 ===');
  const n5 = await A.evaluate(() => window.__strokes());
  const drewA = await drawStroke(A, { x0: 0.6, y0: 0.62, x1: 0.86, y1: 0.82 });
  ok('甲能画（房主不受影响）', drewA);
  ok('观众照样实时收到别人画的笔迹', await waitStrokes(B, n5 + 1),
    '乙=' + (await B.evaluate(() => window.__strokes())));

  await B.evaluate(() => window.__clearToasts());
  await B.fill('#chatInput', '我是观众，但我能说话');
  await B.press('#chatInput', 'Enter');
  await sleep(700);
  const chatA = await A.evaluate(() =>
    Array.from(document.querySelectorAll('#chatList .msg .text')).map(e => e.textContent).join('|'));
  ok('观众发言能正常发出去（没被锁嘴）', chatA.indexOf('我是观众，但我能说话') >= 0);
  ok('观众发言没有被当成错误', !/观众/.test(await B.evaluate(() => window.__toasts())));

  /* ================= 6) 观众不进画手池 ================= */
  console.log('\n=== 6) 观众不进画手池 ===');
  await A.evaluate(() => window.__clearToasts());
  await raw(A, P.C2S.GAME_START, { mode: 'classic', rounds: 2 });
  await sleep(900);
  const t6 = await A.evaluate(() => window.__toasts());
  ok('房间只剩 1 个「能画的人」时开不了局（观众不算人数）',
    /至少要有 2 个人/.test(t6), t6.slice(0, 120));
  ok('并且没有真的开起来',
    await A.evaluate(() => !(window.ChaApp.state.game && window.ChaApp.state.game.phase
      && window.ChaApp.state.game.phase !== 'off')));

  /* ================= 7) 取消观众后立刻能画 ================= */
  console.log('\n=== 7) 取消观众 ===');
  await B.evaluate(() => window.__clearToasts());
  await A.evaluate(u => window.ChaApp.setReadonly(u, false), bUid);
  await sleep(900);
  ok('乙不再是观众', !(await B.evaluate(() => window.ChaApp.myReadonly())));
  ok('乙收到「可以画了」的提示',
    /可以画了|放开/.test(await B.evaluate(() => window.__toasts())),
    await B.evaluate(() => window.__toasts()));
  ok('乙顶栏观众标签消失', !(await B.evaluate(() => window.__meRoleBadge())));
  ok('乙那行的观众徽章也没了',
    !(await A.evaluate(() => { const r = window.__row('乙'); return !!(r && r.guest); })));
  ok('画布下方的观众说明也撤了',
    !/观众/.test(await B.evaluate(() => window.__lockTip())));

  const n7 = await A.evaluate(() => window.__strokes());
  const drew7 = await drawStroke(B, { x0: 0.25, y0: 0.5, x1: 0.55, y1: 0.72 });
  ok('乙能重新落笔', drew7);
  ok('甲收到了这一笔', await waitStrokes(A, n7 + 1));

  /* ================= 8) 开局 + 画手不能当场变观众 ================= */
  console.log('\n=== 8) 开局后：正在作画的画手不能被当场设成观众 ===');
  await A.evaluate(() => window.__clearToasts());
  await raw(A, P.C2S.GAME_START, { mode: 'classic', rounds: 2, drawSeconds: 120 });
  const picked = await waitPhase(A, 'pick', 12000);
  ok('取消观众后能开局（反证第 6 组的拒因是人数）', picked,
    picked ? '' : (await A.evaluate(() => window.__toasts())));
  if (picked) {
    const drawerIsA = await A.evaluate(() => !!(window.ChaApp.state.game && window.ChaApp.state.game.isDrawer));
    const D = drawerIsA ? A : B;
    await D.bringToFront();
    await D.waitForSelector('#pickList .pick-btn', { timeout: 8000 });
    await D.click('#pickList .pick-btn');
    const drawing = await waitPhase(A, 'draw', 12000);
    ok('进入作画阶段', drawing);

    if (drawing) {
      const dUid = await D.evaluate(() => window.ChaApp.state.me.userId);
      const dName = drawerIsA ? '甲' : '乙';
      await A.evaluate(() => window.__clearToasts());
      await A.evaluate(u => window.ChaApp.setReadonly(u, true), dUid);
      await sleep(900);
      ok('把正在作画的 ' + dName + ' 设成观众：被拒（否则整局干等到超时）',
        /正在作画/.test(await A.evaluate(() => window.__toasts())),
        await A.evaluate(() => window.__toasts()));
      ok(dName + ' 没有被设成观众',
        !(await D.evaluate(() => window.ChaApp.myReadonly())));
    }
    await raw(A, P.C2S.GAME_STOP, {});
    await sleep(500);
  }

  /* ================= 9) 离开房间后身份清空 ================= */
  console.log('\n=== 9) 离开房间后身份清空 ===');
  await A.evaluate(u => window.ChaApp.setReadonly(u, true), bUid);
  await sleep(800);
  ok('乙（重新）成了观众', await B.evaluate(() => window.ChaApp.myReadonly()));
  // 「离开房间」会弹一个 confirm —— headless 里默认是**自动取消**，不接就什么都不发生
  B.once('dialog', d => d.accept());
  await B.evaluate(() => window.ChaApp.leaveRoom());
  await sleep(1200);
  ok('离开后观众身份清空', !(await B.evaluate(() => window.ChaApp.myReadonly())));
  ok('离开后顶栏观众标签也没了', !(await B.evaluate(() => window.__meRoleBadge())));

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' ⏐ '));

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' / ' + fail);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('崩了：', e); process.exit(2); });
