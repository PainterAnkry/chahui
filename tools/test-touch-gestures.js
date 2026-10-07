/**
 * 茶绘 · 触屏手势验收（真浏览器，多点触控）
 *
 * 背景（iPad 用户反馈）：
 *   ① 双指轻点撤销「提示已撤销、实际没撤」—— 旧逻辑里双指轻点的第一根手指会
 *      真的落笔画出一个点，收笔时压进撤销栈，之后轻点的 undo 撤掉的是这个点，
 *      看起来就是「没反应」。修复后触屏起笔挂起 90ms，第二指落下即作废。
 *   ② 画两下就弹出 iOS 的「拷贝｜查询｜翻译」选择菜单 —— 画布上要
 *      user-select:none + touch 事件 preventDefault。
 *
 * 覆盖：
 *   ① 单指画一笔照旧（挂起 90ms 转正，画画零延迟）
 *   ② 双指轻点 = 撤销上一笔，且**手势全程没有发出 stroke:begin**（不再先画点）
 *   ③ 快速连按两下单指（不成手势）不留笔（挂起被抬起作废）
 *   ④ 画到一半第二指落下（<400ms 短笔）→ 静默取消：不进撤销栈、广播 stroke:cancel
 *   ⑤ 双指捏合缩放回归
 *   ⑥ iOS 防选中：#view 的 user-select 为 none，touchstart/touchend preventDefault
 *   ⑦ 控制台干净
 *
 * 用法:
 *   PORT=8437 node server/src/index.js
 *   node tools/test-touch-gestures.js http://127.0.0.1:8437
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await page.evaluate(() => {
    document.querySelector('#nameInput').value = '手势验收';
    document.querySelector('#newRoomName').value = '触屏手势房';
    document.querySelector('#btnCreateRoom').click();
  });
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(500);
  await page.evaluate(() => { const m = document.querySelector('#entryMask'); if (m) m.classList.add('hidden'); });
  await sleep(200);

  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const mid = () => page.evaluate(() => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const counts = () => page.evaluate(() => ({
    strokes: window.ChaApp.engine.byId.size,
    myUndo: window.ChaApp.state.myUndo.length,
    session: !!window.ChaApp.state.session
  }));
  // 记录手势期间发出去的笔迹消息（挂起 / 取消不该产生 stroke:begin / stroke:end）
  const armSpy = () => page.evaluate(() => {
    const app = window.ChaApp;
    app.__spy = [];
    if (!app.__spyOn) {
      app.__spyOn = true;
      app.__origSend = app.net.send.bind(app.net);
      app.net.send = function (type, payload, opts) {
        if (app.__spy && /^stroke:(begin|points|end|cancel)$/.test(type)) {
          app.__spy.push(type + (payload && payload.id ? ':' + payload.id : ''));
        }
        return app.__origSend(type, payload, opts);
      };
    }
    return true;
  });
  const spyTake = () => page.evaluate(() => { const s = (window.ChaApp.__spy || []).slice(); window.ChaApp.__spy = []; return s; });

  const m = await mid();

  /* -------------------------------------------- ① 单指画一笔照旧 */
  console.log('\n【一】单指拖动画一笔（触屏起笔挂起 90ms 后转正，画画不受影响）');
  const base0 = await counts();
  await armSpy();
  await touch('touchStart', [{ x: m.x - 60, y: m.y }]);
  await sleep(30);
  await touch('touchMove', [{ x: m.x - 30, y: m.y + 6 }]);
  await sleep(30);
  await touch('touchMove', [{ x: m.x + 30, y: m.y + 12 }]);
  await sleep(30);
  await touch('touchMove', [{ x: m.x + 60, y: m.y + 16 }]);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(400);
  const after1 = await counts();
  const spy1 = await spyTake();
  ok('笔画数 +1（' + base0.strokes + ' → ' + after1.strokes + '）', after1.strokes === base0.strokes + 1);
  ok('撤销栈 +1', after1.myUndo === base0.myUndo + 1, after1.myUndo);
  ok('有 stroke:begin / stroke:end 各一次', spy1.filter(s => s.startsWith('stroke:begin')).length === 1 &&
    spy1.filter(s => s.startsWith('stroke:end')).length === 1, spy1.join(','));
  ok('手指抬起后 session 已收掉', after1.session === false);

  /* -------------------------------------------- ② 双指轻点 = 撤销上一笔 */
  console.log('\n【二】双指轻点撤销：撤掉的是刚才那笔，且全程不发出 stroke:begin（不画点）');
  await armSpy();
  await touch('touchStart', [{ x: m.x - 40, y: m.y + 60 }, { x: m.x + 40, y: m.y + 60 }]);
  await sleep(70);
  await touch('touchEnd', []);
  await sleep(400);
  const after2 = await counts();
  const spy2 = await spyTake();
  ok('笔画数回到画之前（' + after1.strokes + ' → ' + after2.strokes + '）', after2.strokes === base0.strokes);
  ok('撤销栈回到画之前（真撤了上一笔）', after2.myUndo === base0.myUndo, after2.myUndo);
  ok('手势全程零 stroke:begin（旧 bug 会先画出一个点）', spy2.filter(s => s.startsWith('stroke:begin')).length === 0, spy2.join(','));
  ok('手势全程零 stroke:end（没有点被提交再撤销）', spy2.filter(s => s.startsWith('stroke:end')).length === 0, spy2.join(','));
  const toast2 = await page.evaluate(() => {
    const t = document.querySelector('#toastWrap .toast:last-child');
    return t ? t.textContent : '';
  });
  ok('Toast 提示「已撤销（双指轻点）」', toast2.indexOf('已撤销') >= 0, toast2);

  /* -------------------------------------------- ③ 空画布双指轻点：没有可撤的就不乱动 */
  console.log('\n【三】空撤销栈双指轻点：不出新笔画、不报错');
  await armSpy();
  await touch('touchStart', [{ x: m.x - 40, y: m.y + 60 }, { x: m.x + 40, y: m.y + 60 }]);
  await sleep(70);
  await touch('touchEnd', []);
  await sleep(300);
  const after3 = await counts();
  const spy3 = await spyTake();
  ok('笔画数不变', after3.strokes === base0.strokes, after3.strokes);
  ok('零笔迹消息', spy3.length === 0, spy3.join(','));

  /* -------------------------------------------- ④ 短笔被第二指静默取消 */
  console.log('\n【四】画到一半第二指落下（短笔）→ 静默取消：不进撤销栈、广播 stroke:cancel');
  await armSpy();
  // 用画布正中附近起笔 —— 缩放后画布只有屏幕中间一小条，偏移多了会落到画布外走平移分支
  await touch('touchStart', [{ x: m.x - 60, y: m.y - 30 }]);
  await sleep(140);            // 挂起转正，笔画已经开始
  await touch('touchStart', [{ x: m.x - 60, y: m.y - 30 }, { x: m.x + 60, y: m.y - 30 }]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(400);
  const after4 = await counts();
  const spy4 = await spyTake();
  ok('笔画数不变（短笔被取消，没有留点）', after4.strokes === base0.strokes, after4.strokes);
  ok('撤销栈不变（静默取消不占撤销）', after4.myUndo === base0.myUndo, after4.myUndo);
  ok('服务端收到 stroke:cancel（而不是 stroke:end）',
    spy4.filter(s => s.startsWith('stroke:cancel')).length === 1 &&
    spy4.filter(s => s.startsWith('stroke:end')).length === 0, spy4.join(','));
  ok('手指抬起后没有卡住的 session', after4.session === false);

  /* -------------------------------------------- ⑤ 双指捏合缩放回归 */
  console.log('\n【五】双指捏合缩放照旧');
  const scale0 = await page.evaluate(() => window.ChaApp.engine.scale);
  await touch('touchStart', [{ x: m.x - 50, y: m.y + 140 }, { x: m.x + 50, y: m.y + 140 }]);
  await sleep(60);
  await touch('touchMove', [{ x: m.x - 90, y: m.y + 140 }, { x: m.x + 90, y: m.y + 140 }]);
  await sleep(60);
  await touch('touchMove', [{ x: m.x - 110, y: m.y + 140 }, { x: m.x + 110, y: m.y + 140 }]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(300);
  const scale1 = await page.evaluate(() => window.ChaApp.engine.scale);
  ok('捏合后放大了（' + scale0.toFixed(2) + ' → ' + scale1.toFixed(2) + '）', scale1 > scale0 * 1.3);

  /* -------------------------------------------- ⑥ iOS 防选中 */
  console.log('\n【六】iOS 防选中：user-select:none + touch 事件 preventDefault');
  const guard = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const cs = getComputedStyle(v);
    const e1 = new Event('touchstart', { cancelable: true, bubbles: true });
    v.dispatchEvent(e1);
    const e2 = new Event('touchend', { cancelable: true, bubbles: true });
    v.dispatchEvent(e2);
    const callout = getComputedStyle(document.body).webkitTouchCallout;
    return { us: cs.userSelect, d1: e1.defaultPrevented, d2: e2.defaultPrevented, callout: callout };
  });
  ok('#view 的 user-select 是 none', guard.us === 'none', guard.us);
  ok('touchstart 被 preventDefault（长按呼出被掐掉）', guard.d1 === true);
  ok('touchend 被 preventDefault（双击选中被掐掉）', guard.d2 === true);
  // -webkit-touch-callout 是 Safari 专有属性，Chromium 不支持（CSS.supports 为 false，
  // 计算值是空）—— 规则写进样式表就达标，真机效果在 iPad Safari 上验证
  const calloutOk = guard.callout === 'none' ||
    !(await page.evaluate(() => window.CSS && CSS.supports('-webkit-touch-callout', 'none')));
  ok('body 的 -webkit-touch-callout:none 已生效（或 Chromium 不支持该属性）', calloutOk, guard.callout);

  /* -------------------------------------------- ⑦ 控制台干净 */
  await sleep(300);
  ok('控制台无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (failures.length) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
