/**
 * 你画我猜 · 主题词库的两条接线（真浏览器，无头）
 *
 * 守的是用户报的两个症状 —— 两个都是**前端接线**问题，服务端的词池逻辑本身是对的：
 *
 *   ① 「词库串主题」：结算页的「再来一局」以前自己手写 `{ rounds }`，
 *      **漏了 theme**。服务端 game.start() 于是把主题清成「通用」，
 *      而界面上的下拉框还停在刚才选的主题 —— 看起来就是「选了明日方舟，
 *      下一局冒出通用词库的词」。
 *   ② 「换一组没反应」：openPick() 以前拿 `dataset.round` 当重建判据，
 *      而换词时**回合号没变**，于是直接 return —— 界面上还挂着旧的那三个词，
 *      要等下一回合重开弹窗才「突然换了词」，那时早就进作画阶段了。
 *
 * 用法: node tools/test-game-theme.js [http://127.0.0.1:8446]
 *   ⚠ 需要一台**压缩计时**的服务端（选词窗口要留够点「换一组」的时间）：
 *     PORT=8446 GAME_PICK_MS=9000 GAME_ROUND_MS=3000 GAME_ROUND_END_MS=800 \
 *       DATA_DIR=$(mktemp -d) node server/src/index.js
 */
'use strict';
const { chromium } = require('./pw');
const P = require('../shared/protocol');

const URL = process.argv[2] || 'http://127.0.0.1:8446';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.log('  !! 页面报错:', String(e).split('\n')[0]));
  return p;
}

const phase = p => p.evaluate(() => (window.ChaApp.state.game || {}).phase);
const theme = p => p.evaluate(() => (window.ChaApp.state.game || {}).theme);
const waitPhase = async (p, want, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    if (await phase(p) === want) return true;
    await sleep(120);
  }
  return false;
};

(async () => {
  console.log('你画我猜 · 主题词库接线 @ ' + URL);

  /* 先确认这台服务端是压缩计时的（否则选词 60 秒，这条用例跑不完） */
  const share = await fetch(URL + '/api/share').then(r => r.json()).catch(() => null);
  if (!share || !share.game) { console.error('读不到 /api/share'); process.exit(2); }
  console.log('  服务端 pid=' + share.pid + '  PICK_MS=' + share.game.PICK_MS
    + ' ROUND_MS=' + share.game.ROUND_MS);
  if (share.game.PICK_MS < 4000) {
    console.error('✗ 选词窗口太短（' + share.game.PICK_MS + 'ms），来不及点「换一组」。');
    console.error('  请用 GAME_PICK_MS=9000 GAME_ROUND_MS=3000 GAME_ROUND_END_MS=800 另起一台。');
    process.exit(2);
  }
  if (share.words) {
    console.log('  ⚠ 这台服务端用 CHAHU_WORDS 覆盖了词库；「答案来自主题池」那条断言会被跳过');
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const A = await newPage(browser);
  await A.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await A.waitForSelector('#entryMask:not(.hidden)');
  await A.fill('#nameInput', '甲');
  await A.fill('#newRoomName', '主题接线回归');
  await A.click('#btnCreateRoom');
  await A.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(700);
  const roomId = await A.evaluate(() => window.ChaApp.state.room.id);

  const B = await newPage(browser);
  await B.goto(URL + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'domcontentloaded' });
  await B.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  for (const p of [A, B]) {
    await p.evaluate(() => {
      const m = document.getElementById('entryMask');
      if (m) m.classList.add('hidden');
    });
  }
  await sleep(400);
  ok('两个人都在房间里', await A.evaluate(() => window.ChaApp.state.members.length) === 2);

  /* ---------------- [1] 用主题开局 ---------------- */
  console.log('\n[1] 选「原神」开局');
  await A.click('#btnGame');
  await sleep(400);
  const hasTheme = await A.evaluate(() => !!document.querySelector('#gameTheme'));
  ok('经典开局面板里有主题下拉', hasTheme);
  if (!hasTheme) { await browser.close(); process.exit(1); }
  await A.selectOption('#gameTheme', 'genshin');
  // rounds 选 1，让这一局赶快打完（才能测「再来一局」）
  await A.evaluate(() => {
    const r = document.getElementById('gameRounds');
    if (r && Array.from(r.options).some(o => o.value === '1')) r.value = '1';
  });
  await A.click('#btnGameStart');
  ok('进入选词阶段', await waitPhase(A, 'pick', 8000), await phase(A));
  ok('服务端收下了主题 genshin', await theme(A) === 'genshin', await theme(A));

  /* ---------------- [2] 「换一组」必须立刻刷新候选词 ---------------- */
  console.log('\n[2] 「换一组」要立刻换掉界面上那三个词');
  // 找出谁是画手
  let drawerPage = null;
  for (const p of [A, B]) {
    if (await p.evaluate(() => !!window.ChaApp.state.game.isDrawer)) drawerPage = p;
  }
  if (!drawerPage) {
    // 选词阶段很短的话可能已经过了；这里不强求，直接报一条
    ok('能确定谁是画手', false, 'phase=' + await phase(A));
  } else {
    const before = await drawerPage.evaluate(() =>
      Array.from(document.querySelectorAll('#pickList .pick-btn span:first-child')).map(s => s.textContent));
    const poolWords = share.words ? null : await drawerPage.evaluate(() =>
      (window.ChaApp.state.game.choices || []).slice());
    ok('画手看到了 3 个候选词', before.length === P.GAME.CHOICES, JSON.stringify(before));

    const visibleBefore = await drawerPage.evaluate(() =>
      !document.getElementById('pickMask').classList.contains('hidden'));
    ok('选词弹窗是开着的', visibleBefore);

    await drawerPage.click('#btnRepick');
    // 「立刻」= 一小会儿之内（不等回合结束、不等下一次同步）
    await sleep(1200);
    const after = await drawerPage.evaluate(() =>
      Array.from(document.querySelectorAll('#pickList .pick-btn span:first-child')).map(s => s.textContent));
    const stillPick = await phase(drawerPage);
    console.log('  换词前 ' + JSON.stringify(before) + ' → 换词后 ' + JSON.stringify(after)
      + '  phase=' + stillPick);
    ok('★ 点完「换一组」界面上立刻就是新词（不用等下一回合）',
      JSON.stringify(after) !== JSON.stringify(before), { before, after });
    ok('换完仍然是 3 个候选词', after.length === P.GAME.CHOICES, after.length);
    ok('换完还在选词阶段（没有跳阶段）', stillPick === 'pick', stillPick);
    ok('换词次数用掉了', await drawerPage.evaluate(() =>
      (window.ChaApp.state.game.repickLeft || 0) === 0));

    // 新词也必须还在本局的主题池里 —— 这条只能在没有 CHAHU_WORDS 覆盖时验
    if (!share.words) {
      const THEMES = require('../server/src/themes');
      const pool = THEMES.wordsOf('genshin') || [];
      const inPool = after.every(w => pool.indexOf(w) >= 0);
      ok('★ 换出来的新词仍然来自「原神」词池（没有掉回通用库）', inPool,
        after.filter(w => pool.indexOf(w) < 0).join('、') || ('全部在池里，共 ' + pool.length + ' 个词'));
    }
    void poolWords;
  }

  /* ---------------- [3] 结算页「再来一局」不能丢主题 ---------------- */
  console.log('\n[3] 结算页「再来一局」之后主题还在');
  // 没人猜 → 倒计时走完 → round_end → over
  const toOver = await (async () => {
    for (const p of [A, B]) {
      if (await waitPhase(p, 'over', 40000)) return true;
    }
    return false;
  })();
  ok('这一局走到结算（over）', toOver, await phase(A));
  if (!toOver) { await browser.close(); process.exit(1); }

  const againVisible = await A.evaluate(() => {
    const b = document.getElementById('btnOverAgain');
    return !!b && !b.closest('.modal-mask').classList.contains('hidden');
  });
  ok('结算页有「再来一局」按钮', againVisible);

  // 记下「再来一局」究竟发了什么（这是这条 bug 的根）
  await A.evaluate(() => {
    window.__sentStart = null;
    const net = window.ChaApp.net;
    if (!net.__spyInstalled) {
      const orig = net.send.bind(net);
      net.send = function (t, p) {
        if (t === window.CHAPROTO.C2S.GAME_START) window.__sentStart = p;
        return orig(t, p);
      };
      net.__spyInstalled = true;
    }
  });
  await A.click('#btnOverAgain');
  await sleep(900);
  const sent = await A.evaluate(() => window.__sentStart);
  console.log('  再来一局发出的参数: ' + JSON.stringify(sent));
  ok('★ 「再来一局」把主题一起发了（不是只发 rounds）',
    !!(sent && sent.theme === 'genshin'), sent);
  ok('★ 新一局的快照里主题仍然是 genshin',
    await waitPhase(A, 'pick', 8000) && (await theme(A)) === 'genshin',
    'phase=' + await phase(A) + ' theme=' + await theme(A));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
