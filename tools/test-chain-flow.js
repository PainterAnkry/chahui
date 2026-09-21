/**
 * 接龙重写后的 **UI 全流程**（真浏览器，4 个页面）
 *
 * 这份取代 tools/test-chain-ui.js —— 那个写的是「回放用全屏遮罩弹窗、左下角小窗里看图」
 * 的旧界面，那些 DOM（#replayMask / #rpStage / #rpPrev / #rpNext / #rpStrip）**已经删掉了**。
 *
 * 守的是用户明确提的那几条 UI 要求：
 *   [1] 「照这个词作画」的卡片显示**自己**刚写的词；文案说明是「你自己要照它作画」
 *   [2] 待猜的画在**主画布区域**；输入条在画布下方；两者**同时可见**；没有「2 字以上」的限制文案
 *   [4] 回放也在主画布上，不弹遮罩；**不能跨链翻**（服务端指定当前链）；
 *       回放是「上窄带 / 中间只放画 / 下窄带」三段，逐笔动画，词**不是**画布上的大字
 *   [5] 「结束游戏」本地立即回主菜单（不等服务端）
 *   [6] 房主自己也要写词（房主也有候选词）
 *   [7] 画布下方给出 起词 → 最终猜词、「这两个匹配吗？」、√ / ×、「已投 x / y」
 *   [8] 一条链的小结算只在窄带里报结果、**不弹奖杯**；最终结算**先亮「点赞最多的画」**、
 *       点「看奖杯榜 →」（或几秒后自动）才弹奖杯榜
 *   [9] 回放期间没有任何面板压住画布可视区
 *   [10] v12：♥ 是「每条链各一票」—— 横条上那句「你已给 N 条链投过 ♥」是文字证据
 *
 * v10 起三个玩法合并成一个开局面板（#gameMask），开局路径变成：
 *   #btnGame → #gmChain →（参数就在这一层）#btnGameStart → 全员 #btnChainReady → …
 * 所以这份用例里「等 #chainMask / 点 #btnChainStart」那几步换成了
 * 「断言只有一个面板 / 断言接龙那几行露出来了 / 点一次 #btnGameStart」。
 *
 * 用法（窗口要**宽**：这份是人在操作，不是脚本抢时间）:
 *   PORT=8450 GAME_CHAIN_INIT_MS=1200 GAME_CHAIN_WRITE_MS=8000 GAME_CHAIN_DRAW_MS=8000 \
 *     GAME_CHAIN_GUESS_MS=8000 GAME_CHAIN_REVEAL_MS=9000 GAME_CHAIN_VOTE_MS=12000 \
 *     GAME_CHAIN_SCORE_MS=5000 GAME_CHAIN_CHAIN_SCORE_MS=4000 \
 *     DATA_DIR=$(mktemp -d) node server/src/index.js
 *   node tools/test-chain-flow.js http://127.0.0.1:8450
 *
 * ⚠ 别把窗口压到 3~4 秒：这条用例要 4 个页面逐个点按钮，压太紧会在
 *   测试还没走到投票时，服务端就把整局自动跑完（阶段直接回 lobby）。
 */
'use strict';
const path = require('path');
const { chromium } = require('./pw');
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL = (process.argv[2] || 'http://127.0.0.1:8450').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n + (x !== undefined ? '   ' + x : '')); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '   ' + JSON.stringify(x) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.log('  !! 页面报错:', String(e).split('\n')[0]));
  return p;
}
const phase = p => p.evaluate(() => (window.ChaApp.state.game || {}).phase);
const gst = p => p.evaluate(() => window.ChaApp.state.game || {});
const visible = (p, sel) => p.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}, sel);
const waitPhase = async (p, want, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    if (await phase(p) === want) return true;
    await sleep(120);
  }
  return false;
};
const waitAllPhase = async (pages, want, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    const ps = await Promise.all(pages.map(phase));
    if (ps.every(x => x === want)) return true;
    await sleep(150);
  }
  return false;
};

(async () => {
  console.log('接龙重写后的 UI 全流程 @ ' + URL);
  const share = await fetch(URL + '/api/share').then(r => r.json()).catch(() => null);
  if (!share || !share.chain) { console.error('读不到 /api/share'); process.exit(2); }
  console.log('  服务端 pid=' + share.pid + '  接龙计时 ' + JSON.stringify(share.chain));
  if (share.chain.WRITE_MS > 20000 || share.chain.REVEAL_MS < 6000 || share.chain.VOTE_MS < 8000) {
    console.error('✗ 这台服务端的接龙窗口不合适（写词 ' + share.chain.WRITE_MS
      + 'ms / 回放 ' + share.chain.REVEAL_MS + 'ms / 投票 ' + share.chain.VOTE_MS + 'ms）。');
    console.error('  要「宽」：回放 ≥ 6000、投票 ≥ 8000，否则服务端会在测试点完按钮前自动跑完。');
    console.error('  用文件头注释里那套 GAME_CHAIN_* 另起一台。');
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pages = [];
  const host = await newPage(browser);
  pages.push(host);
  await host.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await host.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await host.waitForSelector('#entryMask:not(.hidden)');
  await host.fill('#nameInput', '房主');
  await host.fill('#newRoomName', '接龙 UI 全流程');
  await host.click('#btnCreateRoom');
  await host.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(700);
  const roomId = await host.evaluate(() => window.ChaApp.state.room.id);
  for (let i = 1; i < 4; i++) {
    const p = await newPage(browser);
    await p.goto(URL + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
    pages.push(p);
  }
  await sleep(900);
  await Promise.all(pages.map(p => p.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
  })));
  ok('4 个人都在房间里', (await host.evaluate(() => window.ChaApp.state.members.length)) === 4);

  /* ---------- 开局：大厅 → 写词 ---------- */
  console.log('\n[6] 开局：房主自己也要写词');
  // ⚠ v10 起三个玩法共用一个开局面板（#gameMask）：切到「接龙」之后参数就在**这一层**，
  //   点一次「开始」直接开局 —— 以前还要再点一次才把 #chainMask 顶出来。
  await host.click('#btnGame');
  await sleep(400);
  await host.click('#gmChain');
  await sleep(300);
  ok('★ 只有一个开局面板（#chainMask / #skinMask 已经删掉，不是藏起来）',
    !(await host.evaluate(() => !!document.getElementById('chainMask')
      || !!document.getElementById('skinMask'))));
  ok('★ 切到接龙后露出来的是接龙那几行（回合数那行没了）',
    (await visible(host, '#rowChainLength')) && !(await visible(host, '#rowClassicRounds'))
    && (await visible(host, '#gameDrawTime')) && (await visible(host, '#gameTheme')));
  const lenOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainLength option')).map(o => o.value));
  // ⚠ 上限是 **2×人数**（不是旧的 人数+1）：一个人占两格（猜 + 画），链主占两格（起词 + 画），
  //   所以「人人轮到」= 2N 手。4 人房就是 3..8 手、默认 8。
  ok('★ 链长上限 = 2×人数（4 人 → 到 8 手）',
    lenOpts[0] === String(P.GAME.CHAIN_LENGTH_MIN) && lenOpts[lenOpts.length - 1] === '8',
    JSON.stringify(lenOpts));
  await host.click('#btnGameStart');          // 一次点击 = 开局
  // ⚠ v9 起「进入大厅」不等于开打：四个人都要点「准备」才开局
  await sleep(800);
  // ⚠ CHAIN_PHASE.LOBBY 的值就是 'lobby'（只有 INIT/WRITE/DRAW/… 才带 chain_ 前缀）
  const lob = await phase(host);
  ok('★ 点一次「开始」就落在接龙大厅（不再弹第二个设置页）',
    lob === 'lobby' || lob === 'chain_lobby', lob);
  ok('★ 游戏弹窗自己关掉了，也没有冒出第二层面板',
    !(await visible(host, '#gameMask'))
    && !(await host.evaluate(() => !!document.getElementById('chainMask'))));
  ok('★ 游戏进行中 HUD 上有房主的「结束游戏」入口（#ghStop）',
    await visible(host, '#ghStop'));
  // 面板里那颗「结束游戏」也得在（以前 #btnChainStop 是永远 hidden 的死按钮）
  await host.click('#btnGame');
  await sleep(350);
  ok('★ 面板里的「结束游戏」按钮可见（游戏进行中）', await visible(host, '#btnGameStop'));
  await host.click('#btnGameCancel');
  await sleep(250);
  const readyBtns = await Promise.all(pages.map(p => p.evaluate(() => !!document.querySelector('#btnChainReady'))));
  ok('每页都有「准备」按钮', readyBtns.every(Boolean), readyBtns);
  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#btnChainReady'); if (b) b.click(); });
    await sleep(120);
  }
  ok('全员准备后进入开场鼓点', await waitAllPhase(pages, 'chain_init', 8000)
    || await waitAllPhase(pages, 'chain_write', 14000), await phase(host));
  ok('进入写词阶段', await waitAllPhase(pages, 'chain_write', 14000), await phase(host));

  const choices = await Promise.all(pages.map(p => p.evaluate(() =>
    (window.ChaApp.state.chainTask && window.ChaApp.state.chainTask.choices) || [])));
  ok('★ 房主也拿到了候选词（开局时把自己也加进了选词队列）',
    choices.every(c => c.length >= 3), choices.map(c => c.length));
  ok('卡片文案说明「你自己要照它作画」（写词区上方那一句）',
    await host.evaluate(() => document.querySelector('#chainTask').textContent.indexOf('你自己要照它作画') >= 0),
    await host.evaluate(() => document.querySelector('#chainTask').textContent.slice(0, 60)));
  // ★ v13：写词步**不用画** —— 画布收掉、选词区居中（以前是空画布中间挤一张贴底窄条）
  await sleep(300);
  const writeUi = await host.evaluate(() => {
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const box = document.querySelector('#chainTask');
    const br = box ? box.getBoundingClientRect() : null;
    const layer = document.querySelector('#chainCanvasLayer');
    const ls = layer ? getComputedStyle(layer) : null;
    return {
      box: br && { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) },
      vp,
      // 画布层「不可见」= hidden 类，或者被写词步的 CSS 收掉（display:none）
      canvasHidden: !layer || layer.classList.contains('hidden') || (ls && ls.display === 'none')
    };
  });
  const wc = writeUi.box ? (writeUi.box.x + writeUi.box.w / 2) : -1;
  ok('★ 写词步：选词区水平居中（中心 x ≈ 视口中心）',
    writeUi.box && Math.abs(wc - writeUi.vp.w / 2) <= 30,
    { 中心: Math.round(wc), 视口中心: Math.round(writeUi.vp.w / 2) });
  ok('★ 写词步：画布收起来了（把空间让给选词区）', writeUi.canvasHidden === true, writeUi.canvasHidden);

  /* ---------- [1] 写词 → 作画：题面必须是自己的词 ---------- */
  const myWord = choices.map(c => c[0]);
  for (let i = 0; i < 4; i++) {
    await pages[i].evaluate(() => {
      const b = document.querySelector('#chainTask .ct-choice');
      if (b) b.click();
    });
  }
  ok('全员写完 → 进入作画', await waitAllPhase(pages, 'chain_draw', 15000), await phase(host));
  await sleep(600);
  const drawWords = await Promise.all(pages.map(p => p.evaluate(() =>
    (window.ChaApp.state.chainTask || {}).word)));
  console.log('  作画题面: ' + JSON.stringify(drawWords) + '  自己写的: ' + JSON.stringify(myWord));
  ok('★ 每个人「照这个词作画」显示的是**自己刚写的那个词**',
    drawWords.every((w, i) => w === myWord[i]), { drawWords, myWord });
  ok('卡片上写着「照这个词作画」',
    await host.evaluate(() => document.querySelector('#chainTask').textContent.indexOf('照这个词作画') >= 0));

  /* ---------- 交画 → [2] 猜词界面 ---------- */
  console.log('\n[2] 猜词：画在主画布、输入条在下方、两者同时可见');
  for (const p of pages) {
    const box = await p.locator('#view').boundingBox();
    if (!box) continue;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // ★ v16：画**三笔**（而不是一笔）—— 回放的逐笔动画是「按笔数分帧」的
    //   （帧数 = min(笔数, 18)），只有一笔时一帧就画完了，验不出「一笔一笔长出来」。
    for (let s = 0; s < 3; s++) {
      const y0 = cy - 60 + s * 60;
      await p.mouse.move(cx - 90, y0);
      await p.mouse.down();
      for (let k = 1; k <= 10; k++) await p.mouse.move(cx - 90 + k * 18, y0 + Math.sin(k + s) * 18);
      await p.mouse.up();
      await sleep(60);
    }
    await sleep(150);
    await p.evaluate(() => {
      const b = document.querySelector('#chainTask .ct-submit');
      if (b) b.click();
    });
    await sleep(200);
  }
  ok('全员交画 → 进入猜词', await waitAllPhase(pages, 'chain_guess', 18000), await phase(host));
  // ⚠ 别用固定 sleep 卡阶段切换：题面是私发的，晚到几十毫秒时画布层还是空的（会假红）
  await Promise.all(pages.map(p => p.waitForFunction(
    () => (window.ChaApp.state.chainTask || {}).step === 'GUESS', null, { timeout: 8000 }).catch(() => {})));
  await sleep(500);

  /* ---------- ★ v14 验收②：交完之后画布**仍有内容**（自己的成图留着） ----------
   * 这一步只能验「到了猜词棒，画布上是**这一棒该看的画**」——
   * 因为四个人同时交画时，服务端几乎立刻就把题面换成下一棒了。
   * 「交完到换棒之间一直留着我的成图」由 tools/_round4.js 的探针单独钉住
   * （它在提交后**立刻**取样，那几十毫秒里阶段还是 chain_draw）。 */
  await sleep(200);
  const keepAfterArt = await Promise.all(pages.map(p => p.evaluate(() => {
    const img = document.querySelector('#chainCanvasImg');
    const layer = document.querySelector('#chainCanvasLayer');
    return {
      src: (img && img.getAttribute('src') || '').length,
      shown: !!(img && !img.classList.contains('hidden')),
      layer: !!(layer && !layer.classList.contains('hidden')),
      step: (window.ChaApp.state.chainTask || {}).step || ''
    };
  })));
  console.log('  交画后画布: ' + JSON.stringify(keepAfterArt[0]));
  ok('★ 下一棒交接后画布上是**这一棒该看的画**（换棒才切换，不是交完就永久留着）',
    keepAfterArt.every(u => u.step === 'GUESS' && u.layer === true && u.shown && u.src > 500),
    keepAfterArt.map(u => ({ s: u.step, n: u.src })));

  const guessUi = await Promise.all(pages.map(async p => {
    const vp = p.viewportSize();
    const canvasEl = await p.evaluate(() => {
      const img = document.querySelector('#chainCanvasImg');
      const layer = document.querySelector('#chainCanvasLayer');
      const ct = document.querySelector('#chainCanvasText');
      return {
        layerVisible: !!layer && !layer.classList.contains('hidden'),
        srcLen: (img && img.src || '').length,
        // 词必须是**窄带里的一行**，不是画布上的大字
        topText: (document.querySelector('#cclTopText') || {}).textContent || '',
        canvasText: ct ? (ct.textContent || '') : '',
        canvasTextShown: !!(ct && !ct.classList.contains('hidden'))
      };
    });
    // ⚠ 量的是**画面的可视矩形**（#chainCanvasImg），不是整块画布层：
    //   层里还套着上/下两条窄带，拿层去比面板会永远「重叠」。
    const nb = await p.locator('#chainCanvasImg').boundingBox().catch(() => null);
    const ib = await p.locator('#chainInputMask').boundingBox().catch(() => null);
    const inVp = b => !!b && b.y >= 0 && b.y + b.height <= vp.height + 1 && b.height > 0;
    const overlap = (a, b) => !!a && !!b && !(a.y + a.height <= b.y || b.y + b.height <= a.y);
    // ★ v13：顶部状态条必须是**贴画布上沿的细条**（≤ 40px、不压画面），
    //   房主那几颗按钮（结束游戏 / 计分 / 立刻推进）也得待在条子里，不许回画布中央。
    const barEls = await p.evaluate(() => {
      const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const hud = document.querySelector('#gameHud');
      const ids = ['#ghStop', '#ghScore', '#ghNext'];
      const btns = {};
      for (const s of ids) { const e = document.querySelector(s); if (e && e.offsetParent) btns[s] = r(e); }
      return { hud: hud && !hud.classList.contains('hidden') ? r(hud) : null, btns };
    });
    const hits = (a, b) => !!a && !!b &&
      !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    const midHits = nb ? Object.keys(barEls.btns).filter(k => hits(barEls.btns[k], nb)) : [];
    return {
      layer: canvasEl.layerVisible, srcLen: canvasEl.srcLen,
      topText: canvasEl.topText, canvasText: canvasEl.canvasText, canvasTextShown: canvasEl.canvasTextShown,
      canvasInVp: inVp(nb), inputVisible: !!ib && ib.height > 0, inputInVp: inVp(ib),
      overlap: overlap(nb, ib),
      hudBox: barEls.hud, hudBtnHits: midHits,
      hudOverlapsCanvas: hits(barEls.hud, nb),
      // 猜词期画面上不许有任何大字
      canvasBox: nb && { y: Math.round(nb.y), h: Math.round(nb.height) },
      inputBox: ib && { y: Math.round(ib.y), h: Math.round(ib.height), x: Math.round(ib.x), w: Math.round(ib.width) }
    };
  }));
  console.log('  ' + JSON.stringify(guessUi[0]));
  // 整页可见文本：同一句提示只允许出现一次
  const seenText = (await host.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ');
  const countOf = (s) => seenText.split(s).length - 1;
  console.log('  「这幅画的是什么」出现 ' + countOf('这幅画的是什么') + ' 次 · 「猜词阶段」'
    + countOf('猜词阶段') + ' 次 · 「看图猜词」' + countOf('看图猜词') + ' 次');
  ok('★ 同一句猜词提示在整页只出现一次（「这幅画的是什么」）',
    countOf('这幅画的是什么') === 1, countOf('这幅画的是什么'));
  ok('★ 那条重复的「猜词阶段 —— 要猜的画铺在画布上，输入条在下面」没了',
    countOf('猜词阶段') === 0 && countOf('输入条在下面') === 0, countOf('猜词阶段'));
  ok('★ 顶部状态条是贴画布上沿的细条（高 ≤ 40px）',
    !!guessUi[0].hudBox && guessUi[0].hudBox.h > 0 && guessUi[0].hudBox.h <= 40, guessUi[0].hudBox);
  ok('★ 状态条不压住画面（与画的可视矩形不相交）',
    guessUi.every(u => u.hudOverlapsCanvas === false), guessUi.map(u => u.hudOverlapsCanvas));
  ok('★ 「结束游戏 / 计分 / 立刻推进」都不在画布区域内（在状态条最右侧）',
    guessUi.every(u => u.hudBtnHits.length === 0), guessUi.map(u => u.hudBtnHits));
  ok('★ 待猜的画显示在主画布层里（画布层可见且有真实图像）',
    guessUi.every(u => u.layer && u.srcLen > 500), guessUi.map(u => u.srcLen));
  ok('★ 猜词期画面上**没有**大字（词只出现在窄带里）',
    guessUi.every(u => u.canvasText === '' && !u.canvasTextShown),
    guessUi.map(u => u.canvasText).filter(Boolean));
  ok('★ 画面顶上的窄带写着「看画猜词…」', guessUi.every(u => /看画猜词|上一格/.test(u.topText)),
    guessUi.map(u => u.topText).slice(0, 1));
  ok('★ 输入条可见', guessUi.every(u => u.inputVisible), guessUi.map(u => u.inputVisible));
  ok('★ 画和输入条同时在视口内', guessUi.every(u => u.canvasInVp && u.inputInVp),
    guessUi.map(u => ({ c: u.canvasInVp, i: u.inputInVp })));
  ok('★ 输入条在画的下半部分、不压住画面主体',
    guessUi.every(u => !u.overlap || (u.inputBox && u.canvasBox
      && u.inputBox.y > u.canvasBox.y + u.canvasBox.h * 0.5)),
    guessUi.map(u => ({ cb: u.canvasBox, ib: u.inputBox })));
  ok('★ 输入区固定在画布下方、高度 ≤ 60px',
    guessUi.every(u => u.inputVisible && u.inputBox.h <= 60), guessUi.map(u => u.inputBox));
  const hintTxt = await host.textContent('#ciHint');
  ok('★ 猜词提示里**没有**「2 字以上」这类字数限制',
    hintTxt.indexOf('2 字以上') < 0 && hintTxt.indexOf('2字以上') < 0, hintTxt);
  ok('提示里说明了英文/单字都行',
    /英文/.test(hintTxt) && /单字/.test(hintTxt), hintTxt);
  // ★ v13：√ / × 只在「整条链放完的投票阶段」出现 —— 猜词阶段必须看不见 / 不可点
  //   （以前它们一直挂在贴底横条里、√ 还永远高亮）
  const voteHiddenNow = await host.evaluate(() => {
    const c = document.querySelector('#chainReplayBar');
    const row = document.querySelector('#rpVote');
    const ok = document.querySelector('#rpVoteOk'), bad = document.querySelector('#rpVoteBad');
    const shown = el => !!(el && el.offsetParent && !el.classList.contains('hidden'));
    return {
      bar: !!(c && !c.classList.contains('hidden')),
      row: !!(row && !row.classList.contains('hidden')),
      ok: shown(ok), bad: shown(bad),
      disabled: !!(ok && ok.disabled) && !!(bad && bad.disabled)
    };
  });
  ok('★ 非投票阶段：√ / × 不可见（回放条整条收着）',
    !voteHiddenNow.bar && !voteHiddenNow.row && !voteHiddenNow.ok && !voteHiddenNow.bad,
    voteHiddenNow);

  /* ---------- 猜完 → 回放 / 投票（按链串行） ----------
   * ⚠ 这一段**由测试驱动**：每到一个阶段就把该做的做完，然后用「立刻推进」推下一步，
   *   绝不等服务端计时器 —— 否则 4 个页面逐个点按钮的时候，服务端可能已经把整局跑完了
   *   （我第一次就是栽在这：走到投票时阶段已经是 lobby 了）。 */
  console.log('\n[4] 回放：主画布上、不弹遮罩、不能跨链翻');
  const clickAll = async (sel) => {
    for (const p of pages) {
      await p.evaluate(s => { const b = document.querySelector(s); if (b) b.click(); }, sel);
    }
  };
  const nudge = async () => { await host.evaluate(() => { const b = document.querySelector('#btnRpNext'); if (b) b.click(); }); await sleep(500); };

  let sawReveal = false, sawVote = false;
  const revChecks = {}, voteChecks = {}, partialRows = [], trophies = [], partialPaperHidden = [];
  let revealBarBox = null, voteBarText = '', voteSnap = null;
  // ★ v15：猜词步不再有「回答」卡片 —— 这两笔记录它到底消失没有、输入条是不是自己出现的
  let sawGuessCard = null, guessBarAuto = null;
  // v12 最终结算的新顺序：先亮「点赞最多的画」→ 点「看奖杯榜 →」才弹榜
  let finalFavUi = null, trophyAfterClick = null, favStateText = '';
  let guard = 0;
  while (guard++ < 40) {
    const ph = await phase(host);
    if (ph === 'chain_lobby' || ph === null) break;
    if (ph === 'chain_draw') { await clickAll('#chainTask .ct-submit'); await sleep(400); continue; }
    if (ph === 'chain_guess') {
      for (const p of pages) {
        // ★ v15：猜词那一步**不再有「这幅画画的是什么? + 回答」卡片** ——
        //   输入条由 renderChainTask 直接叫出来（syncChainInput），所以这里**不点任何东西**，
        //   先记下「卡片不存在」+「输入条自己就是可见的」，再直接填词提交。
        if (sawGuessCard === null) {
          const st = await p.evaluate(() => {
            const bar = document.querySelector('#chainInputMask');
            return {
              card: !!document.querySelector('#chainTask .ct-guess'),
              bar: !!bar && !bar.classList.contains('hidden'),
              cardShown: (() => {
                const c = document.querySelector('#chainTask');
                return !!c && !c.classList.contains('hidden')
                  && !document.querySelector('#chainTask .ct-done');
              })()
            };
          });
          sawGuessCard = st.card;
          guessBarAuto = st.bar;
          revChecks.guessCardShown = st.cardShown;
        }
        await p.evaluate(() => {
          const i = document.querySelector('#ciInput');
          if (i) { i.value = '猫'; i.dispatchEvent(new Event('input', { bubbles: true })); }
          const s = document.querySelector('#ciSubmit'); if (s) s.click();
        });
        await sleep(120);
      }
      continue;
    }
    if (ph === 'chain_reveal') {
      if (!sawReveal) {
        sawReveal = true;
        // ★ v16：回放画面**画在真画布上**（引擎的 replayMode + replayCanvas），
        //   所以这里等的是「引擎接管的画面已经有内容」，不再等 <img src>。
        await host.waitForFunction(() => {
          const eng = window.ChaApp && window.ChaApp.engine;
          return !!(eng && eng.replayMode && eng.replayCanvas
            && window.ChaApp.state.cr.anim
            && window.ChaApp.state.cr.anim.frame > 0);
        }, null, { timeout: 8000 }).catch(() => {});
        revChecks.maskGone = !(await host.evaluate(() => !!document.querySelector('#replayMask')));
        revChecks.layerOn = await visible(host, '#chainCanvasLayer');
        revChecks.barOn = await visible(host, '#chainReplayBar');
        revChecks.noCrossNav = !(await host.evaluate(() =>
          !!document.querySelector('#rpPrev') || !!document.querySelector('#rpNext')));
        // ★ v14：回放**没有任何手动干预** —— 播放 / 暂停 / 前后翻格 / 倍速这几颗
        //   连 DOM 都不该存在（全场看同一份服务端推的回放，快慢由开局面板的「回放倍速」定）
        revChecks.noManualCtl = !(await host.evaluate(() => ['#rpPlay', '#rpPrevItem', '#rpNextItem', '#rpSpeed']
          .some(s => !!document.querySelector(s))));
        // ★ v16：**没有独立窗口** —— 回放时那块 <img> 白面板必须是收掉的，
        //   画面由引擎画在真画布上（view 的像素里能读到回放的墨迹）
        revChecks.canvasReplay = await host.evaluate(() => {
          const eng = window.ChaApp.engine;
          const img = document.querySelector('#chainCanvasImg');
          const view = document.querySelector('#view');
          return {
            mode: !!eng.replayMode,
            isFrame: !!(eng.replayCanvas && eng.replayCanvas === window.ChaApp.state.cr.anim.raw),
            cw: eng.replayCanvas ? eng.replayCanvas.width : 0,
            ch: eng.replayCanvas ? eng.replayCanvas.height : 0,
            ew: eng.width, eh: eng.height,
            imgHidden: !img || img.classList.contains('hidden'),
            imgSrc: img ? (img.getAttribute('src') || '').length : -1,
            viewW: view ? view.width : 0
          };
        });
        // ★ v19：♥ 不再「那一格播完就置灰（过时不候）」—— 只要这一棒还停在屏幕上
        //   就点得动。于是判据从「抓到过 finished=false 的窗口」翻成：
        //   **chain_reveal 期间不许出现「显示着但点不动」(blockedInReveal)**。
        //   ⚠ 它**不能放在这一坨里等**（窗口很窄，一等等 6 秒就把后面的
        //     窄带 / 逐笔动画采样拖到下一格去了）—— 这里只起一个后台观察，
        //     剩下的采样照旧立刻做（见 revChecks.order / bands / anim）。
        revChecks.fav = await host.evaluate(() => new Promise(res => {
          const t0 = performance.now();
          const st = { everOpen: false, closedAfter: false, blockedInReveal: false,
                       openType: '', closedType: '', seq: [] };
          window.__favWatchOff = false;
          const timer = setInterval(() => {
            const b = document.querySelector('#rpFavBtn');
            const cr = window.ChaApp.state.cr || {};
            const a = cr.anim || {};
            const g = window.ChaApp.state.game || {};
            const chain = (window.ChaApp.state.chainReveal || [])[cr.chain];
            const item = chain && chain.steps && chain.steps[cr.item];
            const shown = !!(b && !b.classList.contains('hidden'));
            const mark = (g.phase === 'chain_reveal' ? 'R' : g.phase === 'chain_vote' ? 'V' : '?')
              + (item && item.type === 'DRAWING' ? 'D' : '.')
              + (a.finished ? 'f' : 'p') + (shown ? (b.disabled ? 'X' : 'o') : '-');
            if (st.seq[st.seq.length - 1] !== mark) st.seq.push(mark);
            if (shown && b && !b.disabled) {
              st.everOpen = true;
              st.openType = item ? item.type : '';
            }
            // ★ 新规则的反例：回放期间只要抓到一次「显示着 + 置灰」就说明还是旧的过时不候
            if (shown && b && b.disabled && g.phase === 'chain_reveal') st.blockedInReveal = true;
            if (shown && b && b.disabled && (a.finished || g.phase !== 'chain_reveal')) {
              st.closedAfter = true;
              st.closedType = item ? item.type : '';
            }
            if (st.everOpen || performance.now() - t0 > 1500) {
              clearInterval(timer);
              window.__favSt = st;
              res(st);
            }
          }, 10);
        }));
        revChecks.order = await host.evaluate(() => {
          const c = (window.ChaApp.state.chainReveal || [])[0];
          return c ? c.steps.map(s => s.type) : null;
        });
        revealBarBox = await host.evaluate(() => {
          const b = document.querySelector('#chainReplayBar');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { y: Math.round(r.y), h: Math.round(r.height), vh: window.innerHeight };
        });
        // 上-中-下三块：上窄带「<作者> 画了：<词>」/ 中间只放画 / 下窄带
        // ★ v15：下窄带不再提前报出下一棒的猜词，只有「下一棒 <人> 猜的是：」+ 倒计时读数
        revChecks.bands = await host.evaluate(() => {
          const t = (document.querySelector('#cclTopText') || {}).textContent || '';
          const b = (document.querySelector('#cclBottomText') || {}).textContent || '';
          const img = document.querySelector('#chainCanvasImg');
          const ct = document.querySelector('#chainCanvasText');
          const tr = document.querySelector('#cclTop'), br = document.querySelector('#cclBottom');
          const cd = document.querySelector('#cclCount');
          const ib = img && !img.classList.contains('hidden') ? img.getBoundingClientRect() : null;
          const box = r => r && { y: Math.round(r.y), h: Math.round(r.height), x: Math.round(r.x), w: Math.round(r.width) };
          return {
            top: t.replace(/\s+/g, ' ').trim(), bottom: b.replace(/\s+/g, ' ').trim(),
            cd: cd ? (cd.textContent || '').trim() : null,
            cdHtml: !!cd,
            topH: tr ? Math.round(tr.getBoundingClientRect().height) : 0,
            botH: br ? Math.round(br.getBoundingClientRect().height) : 0,
            canvasText: ct ? (ct.textContent || '') : '',
            img: box(ib), topBox: tr ? box(tr.getBoundingClientRect()) : null,
            botBox: br ? box(br.getBoundingClientRect()) : null
          };
        });
        // 逐笔动画：这一格动画期间采样两次画布内容，必须不一样
        revChecks.anim = await host.evaluate(() => new Promise(res => {
          const out = [];
          const t0 = performance.now();
          const timer = setInterval(() => {
            const a = window.ChaApp.state.cr.anim;
            const img = document.querySelector('#chainCanvasImg');
            out.push({ step: a.steps | 0, frame: a.frame | 0, src: (img && img.src || '').length, item: window.ChaApp.state.cr.item });
            if (performance.now() - t0 > 2500) { clearInterval(timer); res(out); }
          }, 30);
        }));
        // 每一格的画面可视矩形 vs 所有可见面板：不许重叠
        revChecks.overlap = await host.evaluate(() => {
          const img = document.querySelector('#chainCanvasImg');
          const ir = (img && !img.classList.contains('hidden')) ? img.getBoundingClientRect() : null;
          const rows = [];
          if (ir) {
            ['#chainReplayBar', '#chainInputMask', '#chainTask', '#chainProgress', '#gameHud',
              '#chainLobby', '#gameScore', '.game-lock-tip'].forEach(s => {
              const el = document.querySelector(s);
              if (!el || el.classList.contains('hidden')) return;
              const r = el.getBoundingClientRect();
              if (r.width < 4 || r.height < 4) return;
              const hit = !(ir.bottom <= r.top || r.bottom <= ir.top || ir.right <= r.left || r.right <= ir.left);
              rows.push({ sel: s, hit, panel: { y: Math.round(r.y), h: Math.round(r.height) }, img: { y: Math.round(ir.y), h: Math.round(ir.height) } });
            });
          }
          return rows;
        });
      }
      // ★ v19：♥ 的「还点不点得动」以前是**每格动画演完就关一次门**，所以要跨格观察；
      //   现在一整条链的展示期间都不该关门（每一棒都能投），这里继续跨格采样，
      //   盯着「有没有出现过显示着却置灰」。
      if (!revChecks.fav || !(revChecks.fav.closedAfter || revChecks.fav.hiddenAfter)) {
        const more = await host.evaluate(() => new Promise(res => {
          const t0 = performance.now();
          const st = window.__favSt || { everOpen: false, closedAfter: false, blockedInReveal: false,
                                         openType: '', closedType: '' };
          st.seq = st.seq || [];
          if (st.blockedInReveal === undefined) st.blockedInReveal = false;
          const timer = setInterval(() => {
            const b = document.querySelector('#rpFavBtn');
            const cr = window.ChaApp.state.cr || {};
            const a = cr.anim || {};
            const g = window.ChaApp.state.game || {};
            const chain = (window.ChaApp.state.chainReveal || [])[cr.chain];
            const item = chain && chain.steps && chain.steps[cr.item];
            const shown = !!(b && !b.classList.contains('hidden'));
            const mark = (g.phase === 'chain_reveal' ? 'R' : g.phase === 'chain_vote' ? 'V' : '?')
              + (item && item.type === 'DRAWING' ? 'D' : '.')
              + (a.finished ? 'f' : 'p') + (shown ? (b.disabled ? 'X' : 'o') : '-');
            if (st.seq[st.seq.length - 1] !== mark) st.seq.push(mark);
            if (shown && b && !b.disabled) {
              st.everOpen = true;
              st.openType = item ? item.type : '';
            }
            if (shown && b && b.disabled && g.phase === 'chain_reveal') st.blockedInReveal = true;
            if (shown && b && b.disabled && (a.finished || g.phase !== 'chain_reveal')) {
              st.closedAfter = true;
              st.closedType = item ? item.type : '';
            }
            // 「过时不候」也可以表现为**整行收掉**（那一格播完 / 切到词格或猜格）——
            // 只要「开过之后不再可点」这一条成立，就算过时不候。
            if (!shown && st.everOpen && (!item || item.type !== 'DRAWING')) st.hiddenAfter = true;
            if (!shown && st.everOpen && g.phase !== 'chain_reveal') st.hiddenAfter = true;
            if ((st.everOpen && (st.closedAfter || st.hiddenAfter)) || performance.now() - t0 > 2600) {
              clearInterval(timer);
              window.__favSt = st;
              res(st);
            }
          }, 10);
        }));
        revChecks.fav = more;
      }
      // ★ v15：回放画面「铺满画布区、不裁切」这两条**必须在回放里量**（出去就晚了）：
      //   · imgFit = 画面元素有多宽（是不是整条画布区，而不是中间一张小卡片）
      //   · crop   = 把**正在显示的那一帧**和引擎按原尺寸渲的参考图做墨迹包围盒对比
      //     老代码（缩小画布 + setTransform 被 paintOnto 抹掉）只剩原图左上角，包围盒会明显偏出
      if (!revChecks.crop) {
        // 量**真画布上的墨迹**：把 #view 里「纸张那一块」抠出来算墨迹包围盒，
        // 再用 engine.screenToDoc 换算回文档比例，和引擎按原尺寸渲的参考图对比。
        // 这一步同时证明三件事：回放真的画在画布上、位置对、且**完整不裁切**。
        // ⚠ 必须等到「当前格是画 + 动画已播完」再量（正在播时只画了一部分，包围盒当然对不上）。
        revChecks.measure = await host.evaluate(() => new Promise(res => {
          const t0 = performance.now();
          // 从一张图（dataURL 或 canvas）里算墨迹包围盒（比例 0~1）
          const boxOfDrawable = (drawInto, w, h) => {
            const cv = document.createElement('canvas');
            cv.width = 240; cv.height = 150;
            const c = cv.getContext('2d');
            c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
            drawInto(c, cv.width, cv.height);
            const d = c.getImageData(0, 0, cv.width, cv.height).data;
            let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
            for (let y = 0; y < cv.height; y++) {
              for (let x = 0; x < cv.width; x++) {
                const i = (y * cv.width + x) * 4;
                if (d[i] < 215 || d[i + 1] < 215 || d[i + 2] < 215) {
                  if (x < x0) x0 = x; if (x > x1) x1 = x;
                  if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
              }
            }
            void w; void h;
            return x1 < 0 ? null : { x0: x0 / cv.width, y0: y0 / cv.height, x1: x1 / cv.width, y1: y1 / cv.height };
          };
          const inkOfUrl = (url, cb) => {
            const im = new Image();
            im.onload = () => cb(boxOfDrawable((c, w, h) => c.drawImage(im, 0, 0, w, h)));
            im.onerror = () => cb(null);
            im.src = url;
          };
          /** 真画布上「纸张」那块区域的墨迹包围盒 */
          const inkOfView = () => {
            const eng = window.ChaApp.engine;
            const view = document.querySelector('#view');
            if (!eng || !view) return null;
            const vr = view.getBoundingClientRect();
            const p0 = eng.docToScreen(0, 0), p1 = eng.docToScreen(eng.width, eng.height);
            const sx = Math.min(p0.x, p1.x), sy = Math.min(p0.y, p1.y);
            const sw = Math.abs(p1.x - p0.x), sh = Math.abs(p1.y - p0.y);
            if (!(sw > 20 && sh > 20)) return null;
            // 屏幕坐标 → 画布位图坐标（dpr）
            const k = view.width / Math.max(1, vr.width);
            const draw = (c, w, h) => {
              c.drawImage(view, sx * k, sy * k, sw * k, sh * k, 0, 0, w, h);
            };
            return boxOfDrawable(draw);
          };
          const shot = () => {
            const st = window.ChaApp.state, cr = st.cr || {}, a = cr.anim || {};
            const eng = window.ChaApp.engine;
            const layer = document.querySelector('#chainCanvasLayer');
            const img = document.querySelector('#chainCanvasImg');
            return {
              mode: !!eng.replayMode,
              imgHidden: !img || img.classList.contains('hidden'),
              imgSrc: img ? (img.getAttribute('src') || '').length : -1,
              layerW: layer ? Math.round(layer.getBoundingClientRect().width) : 0,
              canvasW: eng.width, canvasH: eng.height,
              replayW: eng.replayCanvas ? eng.replayCanvas.width : 0,
              replayH: eng.replayCanvas ? eng.replayCanvas.height : 0,
              strokes: (a.strokes || []).length, done: a.done | 0, steps: a.steps | 0
            };
          };
          const tick = () => {
            const st = window.ChaApp.state, cr = st.cr || {}, a = cr.anim || {};
            const phaseNow = (st.game || {}).phase;
            const chain = (st.chainReveal || [])[cr.chain];
            const item = chain && chain.steps && chain.steps[cr.item];
            if (item && item.type === 'DRAWING' && a.finished) {
              let ref = '';
              try { ref = window.ChaApp.engine.renderStrokesPNG(item.content, '#fff'); } catch (e) { ref = ''; }
              const bottom = ((document.querySelector('#cclBottomText') || {}).textContent || '').replace(/\s+/g, ' ').trim();
              const cdEl = document.querySelector('#cclCount');
              const cd = cdEl ? (cdEl.textContent || '').trim() : null;
              const now = inkOfView();
              if (!ref) { res({ view: now, crop: null, bottom, cd, ...shot() }); return; }
              inkOfUrl(ref, want => res({ view: now, crop: { now, want }, bottom, cd, ...shot() }));
              return;
            }
            // 回放都结束了还没量到（或服务端已经推到投票）—— 别把整段测试拖过头
            const over = performance.now() - t0 > 6000;
            if (over || (phaseNow && phaseNow !== 'chain_reveal')) {
              res({ view: null, crop: null, phase: phaseNow, ...shot() });
              return;
            }
            setTimeout(tick, 120);
          };
          tick();
        }));
      }
      await nudge();                       // 立刻结算 → 进投票
      continue;
    }
    if (ph === 'chain_vote') {
      sawVote = true;
      if (!voteChecks.done) {
        // ★ v14：进投票后**先定格几秒**（服务端 voteFreezeMs）才在画布中央弹纸片 ——
        //   所以这里等纸片真的出现，再取样（不然会采到「正在定格」的那一刻）。
        for (let i = 0; i < 60; i++) {
          const on = await host.evaluate(() => {
            const p = document.querySelector('#rpVote');
            return !!(p && !p.classList.contains('hidden'));
          });
          if (on) break;
          await sleep(150);
        }
        voteChecks.done = true;
        voteSnap = await gst(host);
        voteBarText = await host.evaluate(() => {
          const el = document.querySelector('#chainReplayBar');
          return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        });
        voteChecks.paper = await host.evaluate(() => {
          const p = document.querySelector('#rpVote');
          if (!p || p.classList.contains('hidden')) return null;
          const cs = getComputedStyle(p);
          const r = p.getBoundingClientRect();
          const layer = document.querySelector('#chainCanvasLayer');
          const lr = layer ? layer.getBoundingClientRect() : null;
          return {
            text: (p.textContent || '').replace(/\s+/g, ' ').trim(),
            bg: cs.backgroundColor,
            clip: cs.clipPath || cs.webkitClipPath || '',
            // 「纸片」= 撕痕（clip-path 多边形）而不是 border-radius 圆角
            torn: /polygon/.test(cs.clipPath || cs.webkitClipPath || ''),
            radius: cs.borderRadius,
            shadow: cs.boxShadow,
            // 水平居中在画布可视区（左右偏差 ≤ 8% 画布宽）
            cx: r.x + r.width / 2,
            cy: r.y + r.height / 2,
            layerCx: lr ? lr.x + lr.width / 2 : -1,
            width: Math.round(r.width),
            layerWidth: lr ? Math.round(lr.width) : -1,
            first: (document.querySelector('#rpVoteFirst') || {}).textContent || '',
            last: (document.querySelector('#rpVoteLast') || {}).textContent || '',
            ask: (document.querySelector('#rpVoteHint') || {}).textContent || '',
            okText: (document.querySelector('#rpVoteOk') || {}).textContent || '',
            badText: (document.querySelector('#rpVoteBad') || {}).textContent || '',
            // 手绘圈：两个按钮里都要有内联 SVG（不规则圈），✗ 在左、✓ 在右
            okSvg: !!document.querySelector('#rpVoteOk .sk-disk'),
            badSvg: !!document.querySelector('#rpVoteBad .sk-disk')
          };
        });
        voteChecks.firstLast = !!(voteChecks.paper
          && voteChecks.paper.first.indexOf('<FIRST>') < 0
          && voteChecks.paper.text.indexOf(await host.evaluate(() => {
            const g = window.ChaApp.state.game || {};
            const c = (window.ChaApp.state.chainReveal || []).find(x => x.chainId === g.voteChainId);
            return c ? c.firstWord : '<FIRST>';
          })) >= 0);
        voteChecks.verdictText = await host.evaluate(() => {
          const v = document.querySelector('#rpVerdict');
          return v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
        });
        voteChecks.btns = await visible(host, '#rpVoteOk') && await visible(host, '#rpVoteBad');
        voteChecks.enabled = !(await host.evaluate(() => {
          const a = document.querySelector('#rpVoteOk'), b = document.querySelector('#rpVoteBad');
          return (a && a.disabled) || (b && b.disabled);
        }));
        // ★ v14：未投时两侧都不该是「高亮 / 已投」的样子
        voteChecks.fresh = await host.evaluate(() => {
          const a = document.querySelector('#rpVoteOk'), b = document.querySelector('#rpVoteBad');
          const lit = el => !!(el && (el.classList.contains('voted') || el.classList.contains('primary')));
          return { ok: lit(a), bad: lit(b), okText: a ? a.textContent.trim() : '', badText: b ? b.textContent.trim() : '' };
        });
        // ★ v14：♥ 必须和 √ / × **不在同一个容器**里（纸片 vs 回放条各自一处）
        voteChecks.favSeparate = await host.evaluate(() => {
          const fav = document.querySelector('#rpFavBtn');
          const paper = document.querySelector('#rpVote');
          const own = document.querySelector('#rpFavRow');
          return {
            exists: !!fav, insidePaper: !!(fav && paper && paper.contains(fav)),
            hasOwnRow: !!own, ownRowIsPaper: !!(own && paper && own === paper)
          };
        });
        // ★ v14：投完之前不该有投票标记；投完长出「已投 x / y + 每人一个圈」
        voteChecks.marksBefore = await host.evaluate(() => {
          const m = document.querySelector('#rpVoteMarks');
          return m ? (m.textContent || '').replace(/\s+/g, ' ').trim() : null;
        });
        // ★ v16：**投票阶段画布上要留着最后一棒的成图**（用户要求「不必清除」）——
        //   一条链的最后一格常常是猜词格，这时必须回退到最近的那幅画。
        //   画面在**真画布**上（引擎 replayMode + replayCanvas），不再有 <img> 面板。
        voteChecks.lastArt = await host.evaluate(() => {
          const st = window.ChaApp.state;
          const g = st.game || {};
          const eng = window.ChaApp.engine;
          const list = st.chainReveal || [];
          const chain = list.find(c => c.chainId === g.voteChainId) || list[st.cr.chain];
          const steps = (chain && chain.steps) || [];
          const last = steps[steps.length - 1];
          const draws = steps.filter(s => s.type === 'DRAWING' && Array.isArray(s.content) && s.content.length);
          const img = document.querySelector('#chainCanvasImg');
          const a = st.cr.anim || {};
          // 画布上现在这一格是不是那幅画：动画的 strokes 必须来自 DRAWING 格
          const shownStrokes = Array.isArray(a.strokes) ? a.strokes.length : 0;
          let onArt = false;
          for (let i = 0; i < steps.length; i++) {
            if (Array.isArray(steps[i].content) && steps[i].content === a.strokes) onArt = true;
          }
          return {
            mode: !!eng.replayMode,
            shown: !!eng.replayMode && shownStrokes > 0 && onArt,
            strokes: shownStrokes,
            imgHidden: !img || img.classList.contains('hidden'),
            lastType: last ? last.type : '', draws: draws.length,
            lastDrawStep: draws.length ? steps.indexOf(draws[draws.length - 1]) : -1
          };
        });
      }
      // ★ v14：先只投**一票** —— 服务端在「全员投完」时会立刻结算这条链进下一条，
      //   四个人连点的话取样就落在下一条链上了。先记状态，再把剩下三票补齐。
      await pages[0].evaluate(() => { const b = document.querySelector('#rpVoteOk'); if (b) b.click(); });
      await sleep(500);
      voteChecks.doneAfter = (await gst(host)).voteDone;
      voteChecks.keepLit = await host.evaluate(() => {
        const ok = document.querySelector('#rpVoteOk');
        return !!(ok && (ok.classList.contains('voted') || /已投/.test(ok.textContent || '')));
      });
      voteChecks.votedUi = await host.evaluate(() => {
        const ok = document.querySelector('#rpVoteOk'), bad = document.querySelector('#rpVoteBad');
        const box = document.querySelector('#rpVoteMarks');
        const g = window.ChaApp.state.game || {};
        return {
          okVoted: !!(ok && ok.classList.contains('voted')),
          badVoted: !!(bad && bad.classList.contains('voted')),
          okText: ok ? ok.textContent.trim() : '',
          done: (box || {}).textContent || '',
          markSvg: document.querySelectorAll('#rpVoteMarks .rm .sk-disk').length,
          // ★ v15：**全场每个玩家**都要占一个圈（没投的是浅灰空圈），不只是投过的人
          roster: box ? box.querySelectorAll('.rm').length : 0,
          pending: box ? box.querySelectorAll('.rm.pending').length : 0,
          voted: box ? box.querySelectorAll('.rm.ok, .rm.bad').length : 0,
          voteTotal: g.voteTotal | 0, voteDone: g.voteDone | 0
        };
      });
      // ★ v12：♥ 是**按链**记的 —— 横条上那句「你已给 N 条链投过 ♥」就是新语义的文字证据
      if (!favStateText) favStateText = (await host.textContent('#rpFavState')) || '';
      // 另外三票 → 服务端应当**立刻**自动结算这条链（不用等满投票时限）
      for (let i = 1; i < pages.length; i++) {
        await pages[i].evaluate(() => { const b = document.querySelector('#rpVoteOk'); if (b) b.click(); });
        await sleep(120);
      }
      voteChecks.autoMoved = await (async () => {
        for (let i = 0; i < 40; i++) {
          if (await phase(host) !== 'chain_vote') return true;
          await sleep(100);
        }
        return false;
      })();
      continue;
    }
    if (ph === 'chain_score') {
      const s = await gst(host);
      const partial = !!(s.voteResult && s.voteResult.partial);
      partialRows.push(partial);
      if (!partial) {
        // ★ 用户要的顺序：**全部链结算完 → 先亮「点赞最多的画」→ 再弹奖杯榜**。
        //   所以这一刻 trophyMask 必须还**没弹**，画布上要么是一幅真画、要么如实说「没人点 ♥」。
        finalFavUi = await host.evaluate(() => {
          const img = document.querySelector('#chainCanvasImg');
          const bar = document.querySelector('#favBar');
          const btn = document.querySelector('#favToTrophy');
          return {
            trophy: !document.querySelector('#trophyMask').classList.contains('hidden'),
            layerOn: !document.querySelector('#chainCanvasLayer').classList.contains('hidden'),
            imgOn: !!img && !img.classList.contains('hidden') && (img.getAttribute('src') || '').length > 500,
            text: ((document.querySelector('#cclTopText') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
            barOn: !!bar && !bar.classList.contains('hidden'),
            btnOn: !!btn && !btn.classList.contains('hidden'),
            btnText: btn ? btn.textContent.trim() : ''
          };
        });
        trophies.push(finalFavUi.trophy);        // 必须是 false（还没弹）
        await host.evaluate(() => { const b = document.querySelector('#favToTrophy'); if (b) b.click(); });
        for (let i = 0; i < 24; i++) {
          if (await visible(host, '#trophyMask')) break;
          await sleep(50);
        }
        trophyAfterClick = await visible(host, '#trophyMask');
        break;
      }
      trophies.push(await visible(host, '#trophyMask'));
      // ★ v17：「离开投票阶段 → 投票纸片必须收掉」—— 小结算这一屏就是下一局之前的第一个
      //   非投票阶段；以前纸片没人收，它会一直挂到下一局（用户报的
      //   「新开的一局游戏出现上局的投票窗口」）。
      partialPaperHidden.push(await host.evaluate(() => {
        const p = document.querySelector('#rpVote');
        const m = document.querySelector('#rpVoteMarks');
        return {
          paper: !p || p.classList.contains('hidden'),
          marks: !m || m.classList.contains('hidden'),
          layerOn: !document.querySelector('#chainCanvasLayer').classList.contains('hidden')
        };
      }));
      await nudge();                       // → 下一条链
      continue;
    }
    await sleep(400);
  }

  ok('走完全部格 → 进入回放', sawReveal);
  ok('★ 全屏遮罩 #replayMask 已经不存在了（回放不弹窗）', revChecks.maskGone === true);
  ok('★ 回放的控制条在主画布下方（贴底横条）', revChecks.barOn === true, JSON.stringify(revealBarBox));
  ok('★ 回放画面渲染在主画布层里', revChecks.layerOn === true);
  ok('★ 没有跨链翻页按钮（只能看服务端指定的那条链）', revChecks.noCrossNav === true);
  // ★ v14：回放没有任何手动干预 —— 播放 / 翻格 / 倍速这四颗**连 DOM 都不存在**
  ok('★ 回放里**没有**播放 / 暂停 / 前后翻格 / 倍速控件（全场看服务端推的那一份）',
    revChecks.noManualCtl === true);
  // ★ v16：**回放画在真画布上**（没有独立窗口）：引擎的 replayMode 开着、
  //   回放画布就是逐笔帧画布（引擎尺寸）、而那块白面板 <img> 是收掉的。
  const crv = revChecks.canvasReplay || {};
  console.log('  回放画布: ' + JSON.stringify(crv));
  ok('★ 回放走的是**引擎自己的画布显示位**（replayMode 开、replayCanvas = 逐笔帧画布）',
    crv.mode === true && crv.isFrame === true
      && crv.cw === crv.ew && crv.ch === crv.eh && crv.cw > 100, crv);
  ok('★ 回放期间**没有独立窗口**：那块 <img> 白面板收掉了',
    crv.imgHidden === true && crv.imgSrc <= 0, crv);
  // ★ v19：♥ 改成「**每一棒的展示期间都能投**」—— 以前那一格播完立刻置灰（过时不候），
  //   实际用起来是手速跟不上回放，只有头一棒来得及点（用户反馈的「只有链首才投得上」）。
  ok('★ 回放中 ♥ 可点（这一格是画、还停在屏幕上）',
    !!revChecks.fav && revChecks.fav.everOpen === true && revChecks.fav.openType === 'DRAWING',
    revChecks.fav);
  ok('★ 每一棒展示期间 ♥ 一直可点：chain_reveal 里从不出现「显示着却点不动」',
    !!revChecks.fav && revChecks.fav.blockedInReveal !== true,
    revChecks.fav && { seq: revChecks.fav.seq, everOpen: revChecks.fav.everOpen,
                       blockedInReveal: revChecks.fav.blockedInReveal,
                       closedAfter: revChecks.fav.closedAfter, hiddenAfter: revChecks.fav.hiddenAfter });
  // 全页面文本里不许出现 [object Object]（内层文本全扫一遍）
  const objText = await Promise.all(pages.map(p => p.evaluate(() => {
    const hits = [];
    document.querySelectorAll('#stage *').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent || '';
      if (t.indexOf('[object') >= 0) hits.push((el.id || el.className || el.tagName) + ': ' + t.slice(0, 40));
    });
    if ((document.body.innerText || '').indexOf('[object') >= 0) hits.push('body.innerText');
    return hits;
  })));
  ok('★ 整页文本里没有 [object Object]（每页都扫了）',
    objText.every(h => h.length === 0), objText.filter(h => h.length));
  ok('★ 回放严格按 起词 → 画1 → 猜1 → 画2 → 猜2',
    !!revChecks.order && revChecks.order[0] === 'WORD' && revChecks.order[1] === 'DRAWING'
      && revChecks.order[2] === 'GUESS' && revChecks.order[3] === 'DRAWING',
    JSON.stringify(revChecks.order));

  /* ---------- 上-中-下 三块 + 逐笔动画 ---------- */
  console.log('\n[4b] 回放的上-中-下：两条窄带 + 中间只放画');
  const bands = revChecks.bands || {};
  console.log('  上窄带: ' + JSON.stringify(bands.top));
  console.log('  下窄带: ' + JSON.stringify(bands.bottom));
  ok('★ 上窄带是「<作者> 画了：<词>」形态', /画了：/.test(bands.top || ''), bands.top);
  // ★ v15：下窄带在回放进行中只写「笔迹回放中…」；「下一棒 X 猜的是：」是**播完之后**才出现的
  //   （见下面 [4c] 的 measure.bottom）—— 词则只在上窄带里、等那一格开始放才揭晓
  ok('★ 回放进行中的下窄带不剧透（没有下一棒的猜词）',
    !/猜的是/.test(bands.bottom || '') && /回放中/.test(bands.bottom || ''), bands.bottom);
  ok('★ 两条窄带都是窄条（高 ≤ 40px）', bands.topH > 0 && bands.topH <= 40 && bands.botH > 0 && bands.botH <= 40,
    { top: bands.topH, bottom: bands.botH });
  // ★ v16：画面改由**引擎画在真画布上**了，所以这里不再量 <img>，改成量两条窄带：
  //   上带在画布区靠上、下带靠下，中间那一整块留给画面（窄带只占边缘，压不到中间）。
  ok('★ 上窄带在上、下窄带在下，中间整块留给画布上的画面（画面本体不再是 <img> 面板）',
    !!bands.topBox && !!bands.botBox
      && bands.topBox.y + bands.topBox.h <= bands.botBox.y
      && (bands.botBox.y - (bands.topBox.y + bands.topBox.h)) > 100,
    { top: bands.topBox, bot: bands.botBox, imgHidden: crv.imgHidden });
  ok('★ 画布上没有大字（#chainCanvasText 恒空）', bands.canvasText === '', bands.canvasText);
  const panelHit = (revChecks.overlap || []).filter(x => x.hit);
  ok('★ 回放期间没有任何面板压住画面（40px 安全条内不算）', panelHit.length === 0, panelHit);
  const animSeq = revChecks.anim || [];
  const steps = [...new Set(animSeq.map(x => x.step))];
  console.log('  逐笔动画采样: ' + JSON.stringify(animSeq.filter((x, i) => i % 6 === 0).slice(0, 8)));
  ok('★ 逐笔动画：同一格里画布内容分多次叠上去（step ≥ 2）',
    steps.length >= 2 && Math.max.apply(null, steps) >= 2, { steps: steps });
  ok('★ 逐笔动画：帧号随时间增长（一笔一笔画出来，不是一次性贴图）',
    (revChecks.anim || []).some(x => x.frame >= 2), (revChecks.anim || []).map(x => x.frame).filter((v, i, a) => a.indexOf(v) === i));

  /* ---------- ★ v15/v16：回放节奏与画面 ---------- */
  console.log('\n[4c] ★ v15/v16：逐格时长（按笔数）/ 下窄带不提前报词 / 画面铺在纸张上');
  const legMsInfo = await host.evaluate(() => {
    const g = window.ChaApp.state.game || {};
    const steps = ((window.ChaApp.state.chainReveal || [])[0] || {}).steps || [];
    return {
      arr: Array.isArray(g.legMs) ? g.legMs : null, hold: g.legHoldMs | 0,
      legs: g.revealLegs | 0, step: g.revealStep | 0, types: steps.map(s => s.type),
      drawStrokes: steps.filter(s => s.type === 'DRAWING').map(s => (s.content || []).length)
    };
  });
  const legTypes = legMsInfo.types || [];
  const legArr = legMsInfo.arr || [];
  console.log('  每格时长: ' + JSON.stringify(legArr) + '  类型: ' + JSON.stringify(legTypes)
    + '  作画格笔数: ' + JSON.stringify(legMsInfo.drawStrokes));
  ok('★ 快照下发 legMs（这条链每一格的时长表），长度 = 格数',
    !!legMsInfo.arr && legArr.length === legMsInfo.legs && legArr.length >= 4, legMsInfo);
  const iWordLeg = legTypes.indexOf('WORD'), iGuessLeg = legTypes.indexOf('GUESS');
  const iDrawLeg = legTypes.indexOf('DRAWING');
  ok('★ 起词格只停短短一拍、猜词格停 2 秒（看清那个词再翻下一棒）',
    iWordLeg >= 0 && iGuessLeg >= 0 && legArr[iWordLeg] > 0 && legArr[iWordLeg] <= 1600
      && legArr[iGuessLeg] >= 2000 && legArr[iGuessLeg] <= 2200,
    { word: legArr[iWordLeg], guess: legArr[iGuessLeg] });
  // ★ v16：作画格 = 按笔数算的动画（起步 900 + 每笔 240，夹 [1500,9000]，再除倍速）+ 3 秒悬念尾。
  //   验的是「时长真的跟着笔数走」，而不是被「回放总时长 × 比例」摊成固定值。
  const drawLegExpect = (function () {
    const n = legMsInfo.drawStrokes[0] | 0;
    const speed = 1.5;                       // 开局面板默认档
    const anim = Math.max(1500, Math.min(9000, Math.round((900 + n * 240) / speed)));
    return anim + 3000;
  })();
  ok('★ 作画格 = 按笔数算的动画（900 + 笔数×240，夹 [1500,9000]，÷倍速）+ 3 秒悬念尾',
    iDrawLeg >= 0 && legArr[iDrawLeg] === drawLegExpect,
    { got: legArr[iDrawLeg], want: drawLegExpect, strokes: legMsInfo.drawStrokes[0] });
  ok('★ legHoldMs = 当前这一格的时长（前端排动画就认这一个数）',
    legArr[legMsInfo.step] === legMsInfo.hold, { step: legMsInfo.step, hold: legMsInfo.hold });
  const bandsCd = (revChecks.bands || {}).cd;
  // ★ v15：用户要的顺序是「**笔迹回放完了**再显示『下一棒 X 猜的是：』+ 3 秒倒计时」——
  //   所以回放**进行中**的下窄带里一个字都不许提猜词（不提前报词、也不提前倒数）
  ok('★ 回放进行中：下窄带里**没有**任何猜词内容（还没到揭晓的时候）',
    !/猜的是/.test(bands.bottom || '') && !(revChecks.bands || {}).cdHtml,
    bands.bottom);
  const measure = revChecks.measure || {};
  ok('★ 笔迹回放**播完之后**才出现「下一棒 <人> 猜的是：」+ 倒计时读数',
    /下一棒/.test(measure.bottom || '') && /猜的是：/.test(measure.bottom || '')
      && /^(\？+|\d)$/.test((measure.cd || '').trim()),
    { bottom: measure.bottom, cd: measure.cd, early: bands.bottom, earlyCd: bandsCd });
  ok('★ 猜词步没有「回答」卡片，输入条自己就出现（少一层点击）',
    sawGuessCard === false && guessBarAuto === true, { card: sawGuessCard, bar: guessBarAuto });

  // ★ v16：回放**就画在真画布上**（不是另一块白面板、也不是缩成小图）——
  //   量的是 #view 里「纸张那一块」的墨迹，再和引擎按原尺寸渲的参考图对比。
  ok('★ 回放画面确实画在**真画布**上（纸张区域里读得到墨迹）',
    !!measure.view && measure.mode === true && measure.done > 0,
    { view: measure.view, mode: measure.mode, done: measure.done, strokes: measure.strokes });
  const cropCheck = measure.crop;
  console.log('  墨迹包围盒（真画布 vs 引擎原图）: ' + JSON.stringify(cropCheck));
  ok('★ 回放画面**完整不裁切**：真画布上的墨迹包围盒与引擎按原尺寸渲的参考图几乎重合',
    !!cropCheck && !!cropCheck.now && !!cropCheck.want
      && Math.abs(cropCheck.now.x1 - cropCheck.want.x1) <= 0.1
      && Math.abs(cropCheck.now.y1 - cropCheck.want.y1) <= 0.1
      && Math.abs(cropCheck.now.x0 - cropCheck.want.x0) <= 0.1
      && Math.abs(cropCheck.now.y0 - cropCheck.want.y0) <= 0.1,
    cropCheck);

  console.log('\n[7] 画布中央的「纸片」投票面板 + 画布下方的已投标记');
  ok('走到了投票阶段', sawVote);
  console.log('  投票条: ' + voteBarText.slice(0, 110));
  console.log('  结果行: ' + JSON.stringify(voteChecks.verdictText));
  const paper = voteChecks.paper || null;
  console.log('  纸片: ' + JSON.stringify(paper && {
    w: paper.width, torn: paper.torn, text: (paper.text || '').slice(0, 80)
  }));
  ok('★ 投票面板出现在**画布中央**（水平居中于画布层）',
    !!paper && Math.abs(paper.cx - paper.layerCx) <= Math.max(12, paper.layerWidth * 0.08),
    paper && { cx: Math.round(paper.cx), layerCx: Math.round(paper.layerCx) });
  ok('★ 是「纸片」而不是大浮框：白底 + 阴影 + **撕痕边**（clip-path 多边形，不是圆角矩形）',
    !!paper && /rgb/.test(paper.bg || '') && !!paper.shadow && paper.shadow !== 'none' && paper.torn === true,
    paper && { bg: paper.bg, torn: paper.torn, shadow: (paper.shadow || '').slice(0, 40) });
  ok('★ 内容自上而下：起词 → 最终猜词 → 这个匹配吗？',
    !!paper && paper.first.length > 0 && paper.last.length > 0 && /这个匹配吗/.test(paper.ask),
    paper && { first: paper.first, last: paper.last, ask: paper.ask });
  ok('★ 纸片上给出「起词 → 最终猜词」的对照', voteChecks.firstLast === true,
    paper && (paper.first + ' → ' + paper.last));
  ok('★ 结果在下沿窄带里也有一份（#rpVerdict）',
    /起词/.test(voteChecks.verdictText || '') && /最终猜词/.test(voteChecks.verdictText || ''),
    voteChecks.verdictText);
  ok('★ 一排两个**手绘圈**按钮（内联 SVG 的不规则圈）：✗ 在左、✓ 在右',
    !!paper && paper.badSvg === true && paper.okSvg === true
      && /×/.test(paper.badText || '') && /√/.test(paper.okText || ''),
    paper && { bad: paper.badText, ok: paper.okText, badSvg: paper.badSvg, okSvg: paper.okSvg });
  ok('★ √ 和 × 两个按钮都在且可点', voteChecks.btns === true);
  ok('★ 两个按钮都不是灰白不可点', voteChecks.enabled === true);
  // ★ v15：这条断言只关心「是哪条链由**服务端**说了算」（前端不许自己挑）。
  //   不写死 index === 0：测试在回放里取样花的时间，可能让第 1 条链已经投完进第 2 条，
  //   那台机器慢一点就会假红（实测撞过）。
  ok('★ 服务端指定了当前链（不是让各端自己挑）',
    !!voteSnap && Number(voteSnap.voteChainIndex) >= 0 && !!voteSnap.voteChainId
      && voteSnap.voteGroupId !== undefined,
    JSON.stringify({ i: voteSnap && voteSnap.voteChainIndex, id: voteSnap && voteSnap.voteChainId }));
  ok('★ 投 √ 之后已投人数增长', voteChecks.doneAfter >= 1, voteChecks.doneAfter);
  ok('★ 投过的一侧高亮标「已投」', voteChecks.keepLit === true);
  // ★ v14：未投时两侧都不高亮；投过之后只有 √ 那一侧高亮
  ok('★ 未投时 √ / × 都是常态外观（√ 不再永远高亮）',
    !!voteChecks.fresh && voteChecks.fresh.ok === false && voteChecks.fresh.bad === false,
    voteChecks.fresh);
  ok('★ 投过之后只有 √ 那一侧高亮标「已投」',
    !!voteChecks.votedUi && voteChecks.votedUi.okVoted === true && voteChecks.votedUi.badVoted === false,
    voteChecks.votedUi);
  // ★ v14：画布**下方**那排「已投票玩家标记」：每人一个手绘圈 + 已投 x / y
  ok('★ 画布下方显示「已投 x / y」',
    !!voteChecks.votedUi && /已投\s*\d+\s*\/\s*\d+/.test(voteChecks.votedUi.done),
    voteChecks.votedUi && voteChecks.votedUi.done);
  ok('★ 投过的人下方留下一个手绘圈标记（每人一个 ✓ / ×）',
    !!voteChecks.votedUi && voteChecks.votedUi.markSvg >= 1,
    voteChecks.votedUi && voteChecks.votedUi.markSvg);
  // ★ v15：**全场每个玩家**都占一个圈 —— 投过的是 ✓ / ✗，还没投的是浅灰空圈，
  //   数量必须等于这条链的投票总人数（用户要求「投票窗口下方显示全部玩家所投票」）
  ok('★ 纸片下方给**每个玩家**都留了一个圈（= 投票总人数，没投的是空圈）',
    !!voteChecks.votedUi && voteChecks.votedUi.roster === voteChecks.votedUi.voteTotal
      && voteChecks.votedUi.roster >= 4,
    voteChecks.votedUi && { roster: voteChecks.votedUi.roster, total: voteChecks.votedUi.voteTotal });
  ok('★ 空圈数量 = 还没投的人数（当场就能看出「谁还没投」）',
    !!voteChecks.votedUi
      && voteChecks.votedUi.pending === Math.max(0, voteChecks.votedUi.voteTotal - voteChecks.votedUi.voteDone),
    voteChecks.votedUi && { pending: voteChecks.votedUi.pending, done: voteChecks.votedUi.voteDone, total: voteChecks.votedUi.voteTotal });
  // ★ v16：投票阶段画布上保留最后一棒的成图
  console.log('  投票时画布上的图: ' + JSON.stringify(voteChecks.lastArt));
  ok('★ 投票阶段画布上**保留最后一棒的成图**（最后一格是猜词格也不清成空白）',
    !!voteChecks.lastArt && voteChecks.lastArt.shown === true && voteChecks.lastArt.draws >= 1,
    voteChecks.lastArt);
  ok('★ 投票阶段也**没有独立窗口**：画面仍在真画布上，<img> 面板是收掉的',
    !!voteChecks.lastArt && voteChecks.lastArt.mode === true && voteChecks.lastArt.imgHidden === true,
    voteChecks.lastArt);
  ok('★ 我投完 → **自动进入下一条链 / 结算**（不用点任何按钮）',
    voteChecks.autoMoved === true);
  // ★ v17：离开投票阶段后，纸片与那排圈必须收掉（别留到下一局）
  console.log('  离开投票后纸片状态: ' + JSON.stringify(partialPaperHidden));
  ok('★ 离开投票阶段（小结算那一屏）→ 投票纸片与已投标记**都收掉了**',
    partialPaperHidden.length >= 1
      && partialPaperHidden.every(x => x.paper === true && x.marks === true),
    partialPaperHidden);
  ok('★ 「最喜欢这张」和 √ / × 不在同一个容器里（纸片之外、自己一行）',
    !!voteChecks.favSeparate && voteChecks.favSeparate.insidePaper === false
      && voteChecks.favSeparate.hasOwnRow === true && voteChecks.favSeparate.ownRowIsPaper === false,
    voteChecks.favSeparate);
  // ★ v12：♥ 不再是「一人一票被覆盖」，而是**每条链各一次** —— 横条上那句就是文字证据
  ok('★ ♥ 的进度文案是「你已给 N 条链投过 ♥（每条链一次）」（新语义）',
    /条链投过 ♥/.test(favStateText) && /每条链一次/.test(favStateText), favStateText);
  console.log('\n[8] 逐链串行：小结算不弹奖杯；最终结算**先亮点赞最多的画**、再弹奖杯榜');
  const small = partialRows.filter(Boolean);
  console.log('  小结算 ' + small.length + ' 次，奖杯弹窗出现情况: ' + JSON.stringify(trophies));
  ok('★ 确实经过了一条链一条链的小结算', small.length >= 1, small.length);
  ok('★ 小结算**不弹奖杯**弹窗（这一局一次都没弹过，最终结算那一刻也没弹）',
    trophies.every(x => x === false), JSON.stringify(trophies));
  ok('★ 最后才进入最终结算（partial = false）',
    partialRows.length > 0 && partialRows[partialRows.length - 1] === false,
    JSON.stringify(partialRows));
  console.log('  最终结算第一屏: ' + JSON.stringify(finalFavUi && {
    layer: finalFavUi.layerOn, img: finalFavUi.imgOn, bar: finalFavUi.barOn, text: finalFavUi.text
  }));
  ok('★ 最终结算**先在主画布上亮「点赞最多的画」**（画布层亮着 + 有说明行 + 有按钮），此刻奖杯榜还没弹',
    !!finalFavUi && finalFavUi.layerOn === true && finalFavUi.barOn === true
      && finalFavUi.btnOn === true && /看奖杯榜/.test(finalFavUi.btnText)
      && finalFavUi.trophy === false,
    finalFavUi && { layer: finalFavUi.layerOn, bar: finalFavUi.barOn, btn: finalFavUi.btnText, trophy: finalFavUi.trophy });
  ok('★ 那一屏要么铺出一幅真画、要么如实写「这一局没人点 ♥」（这条用例没投 ♥，所以是后者）',
    !!finalFavUi && (finalFavUi.imgOn === true || /没人点 ♥/.test(finalFavUi.text)),
    finalFavUi && { img: finalFavUi.imgOn, text: finalFavUi.text });
  ok('★ 点「看奖杯榜 →」之后才弹奖杯榜', trophyAfterClick === true);

  console.log('\n[5] 结束游戏：本地立即回主菜单');
  // ★ v17：这一步改在**非房主**那一页点（page 1）——
  //   房主点「结束游戏」会顺手 GAME_STOP 把整局停掉，后面 [8b] 就没大厅可查了；
  //   非房主点是**纯本地**退到主菜单（不发 GAME_STOP），服务端那局还在，
  //   于是「本地立刻回主菜单」与「回到大厅查名单」两件事都能验。
  const quitter = pages[1];
  const t0 = Date.now();
  await quitter.evaluate(() => {
    const b = document.querySelector('#btnTrophyStop');
    if (b) b.click();
  });
  let entryMs = -1;
  for (let i = 0; i < 40; i++) {
    if (await visible(quitter, '#entryMask')) { entryMs = Date.now() - t0; break; }
    await sleep(50);
  }
  ok('★ 点「结束游戏」后立刻看到入口页（不等服务端回执）',
    entryMs >= 0 && entryMs < 2000, entryMs + 'ms');
  ok('★ 接龙浮层 / 画布层 / 输入条 / 投票条全收掉了',
    !(await visible(quitter, '#chainCanvasLayer')) && !(await visible(quitter, '#chainReplayBar'))
      && !(await visible(quitter, '#chainInputMask')));

  /* ---------- ★ v17：大厅的「准备」面板只列屋里真正在的人 ----------
   * 用户报的原话：「准备的时候，准备面板上有房间不存在的人」。
   * 复现条件：一局打完（开局时每个人都落了一行分数）→ 有人离场 → 回大厅。
   * 服务端的 players 里会留一行 online=false 的灰名（**计分板要用**），
   * 大厅那份名单必须把它过滤掉。 */
  console.log('\n[8b] ★ v17：大厅准备面板不出现「房间里不存在的人」');
  let backLobby = false;
  for (let i = 0; i < 120; i++) {
    if (await phase(host) === 'lobby') { backLobby = true; break; }
    await sleep(200);
  }
  ok('★ 最终结算后自动回到大厅', backLobby, await phase(host));
  const lobbyPaper = await host.evaluate(() => {
    const p = document.querySelector('#rpVote');
    const m = document.querySelector('#rpVoteMarks');
    return {
      paper: !p || p.classList.contains('hidden'),
      marks: !m || m.classList.contains('hidden'),
      replay: !!(window.ChaApp.engine || {}).replayMode
    };
  });
  ok('★ 回到大厅时：上局的投票纸片 / 标记 / 回放画面**全都收干净了**（新一局不会再冒出来）',
    lobbyPaper.paper === true && lobbyPaper.marks === true && lobbyPaper.replay === false, lobbyPaper);
  const leaver = await pages[3].evaluate(() => ((window.ChaApp.state.me || {}).name) || '');
  await pages[3].close();
  let ghost = null;
  for (let i = 0; i < 25 && !ghost; i++) {
    ghost = await host.evaluate(() => {
      const g = window.ChaApp.state.game || {};
      const off = (g.players || []).filter(p => p.online === false);
      return off.length ? off.map(p => p.name) : null;
    });
    if (!ghost) await sleep(200);
  }
  ok('★ 离场的人在快照里还留一行 online=false（计分板要它）',
    !!ghost && ghost.indexOf(leaver) >= 0, { ghost, leaver });
  const lobbyRoster = await host.evaluate(() => {
    const g = window.ChaApp.state.game || {};
    const names = Array.from(document.querySelectorAll('#clPlayers .cl-player'))
      .map(e => (e.textContent || '').replace(/[✓（观战）\s]/g, ''));
    const on = (g.players || []).filter(p => p.online !== false).map(p => p.name);
    const off = (g.players || []).filter(p => p.online === false).map(p => p.name);
    return {
      shown: names, online: on, offline: off,
      countText: ((document.querySelector('#clCount') || {}).textContent || '').trim()
    };
  });
  console.log('  大厅名单: ' + JSON.stringify(lobbyRoster));
  ok('★ 大厅名单里**没有**离场的人（房间剩下 3 人 → 名单就 3 个）',
    lobbyRoster.offline.length >= 1
      && lobbyRoster.shown.length === lobbyRoster.online.length
      && lobbyRoster.offline.every(n => lobbyRoster.shown.indexOf(n) < 0),
    lobbyRoster);
  ok('★ 大厅人数也只算在场的人',
    new RegExp('^' + lobbyRoster.online.length + ' 人').test(lobbyRoster.countText),
    lobbyRoster.countText);

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
