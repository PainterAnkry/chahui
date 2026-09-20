/**
 * 接龙重写后的 **UI 全流程**（真浏览器，4 个页面）
 *
 * 这份取代 tools/test-chain-ui.js —— 那个写的是「回放用全屏遮罩弹窗、左下角小窗里看图」
 * 的旧界面，那些 DOM（#replayMask / #rpStage / #rpPrev / #rpNext / #rpStrip）**已经删掉了**。
 *
 * 守的是用户明确提的那几条 UI 要求：
 *   [1] 「照这个词作画」的卡片显示**自己**刚写的词；文案说明是「你自己要照它作画」
 *   [2] 待猜的画在**主画布区域**；输入条在画布下方；两者**同时可见**；没有「2 字以上」的限制文案
 *   [4] 回放也在主画布上，不弹遮罩；**不能跨链翻**（服务端指定当前链）
 *   [5] 「结束游戏」本地立即回主菜单（不等服务端）
 *   [6] 房主自己也要写词（房主也有候选词）
 *   [7] 画布下方给出 起词 → 最终猜词、「这两个匹配吗？」、√ / ×、「已投 x / y」
 *   [8] 一条链的小结算只在横条里报结果、**不弹奖杯**；最终结算才弹
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
  ok('★ 链长上限 = 人数 + 1（4 人 → 到 5 手）',
    lenOpts[0] === String(P.GAME.CHAIN_LENGTH_MIN) && lenOpts[lenOpts.length - 1] === '5',
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
  ok('卡片文案说明「你自己要照它作画」',
    await host.evaluate(() => document.querySelector('#chainTask').textContent.indexOf('你自己要照它作画') >= 0),
    await host.evaluate(() => document.querySelector('#chainTask').textContent.slice(0, 60)));

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
    await p.mouse.move(cx - 80, cy - 40);
    await p.mouse.down();
    for (let k = 1; k <= 10; k++) await p.mouse.move(cx - 80 + k * 16, cy - 40 + Math.sin(k) * 20);
    await p.mouse.up();
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

  const guessUi = await Promise.all(pages.map(async p => {
    const vp = p.viewportSize();
    const canvasEl = await p.evaluate(() => {
      const img = document.querySelector('#chainCanvasImg');
      const layer = document.querySelector('#chainCanvasLayer');
      return {
        layerVisible: !!layer && !layer.classList.contains('hidden'),
        srcLen: (img && img.src || '').length
      };
    });
    const nb = await p.locator('#chainCanvasLayer').boundingBox().catch(() => null);
    const ib = await p.locator('#chainInputMask').boundingBox().catch(() => null);
    const inVp = b => !!b && b.y >= 0 && b.y + b.height <= vp.height + 1 && b.height > 0;
    const overlap = (a, b) => !!a && !!b && !(a.y + a.height <= b.y || b.y + b.height <= a.y);
    return {
      layer: canvasEl.layerVisible, srcLen: canvasEl.srcLen,
      canvasInVp: inVp(nb), inputVisible: !!ib && ib.height > 0, inputInVp: inVp(ib),
      overlap: overlap(nb, ib),
      canvasBox: nb && { y: Math.round(nb.y), h: Math.round(nb.height) },
      inputBox: ib && { y: Math.round(ib.y), h: Math.round(ib.height) }
    };
  }));
  console.log('  ' + JSON.stringify(guessUi[0]));
  ok('★ 待猜的画显示在主画布层里（画布层可见且有真实图像）',
    guessUi.every(u => u.layer && u.srcLen > 500), guessUi.map(u => u.srcLen));
  ok('★ 输入条可见', guessUi.every(u => u.inputVisible), guessUi.map(u => u.inputVisible));
  ok('★ 画和输入条同时在视口内', guessUi.every(u => u.canvasInVp && u.inputInVp),
    guessUi.map(u => ({ c: u.canvasInVp, i: u.inputInVp })));
  ok('★ 输入条在画的下半部分、不压住画面主体',
    guessUi.every(u => !u.overlap || (u.inputBox && u.canvasBox
      && u.inputBox.y > u.canvasBox.y + u.canvasBox.h * 0.5)),
    guessUi.map(u => ({ cb: u.canvasBox, ib: u.inputBox })));
  const hintTxt = await host.textContent('#ciHint');
  ok('★ 猜词提示里**没有**「2 字以上」这类字数限制',
    hintTxt.indexOf('2 字以上') < 0 && hintTxt.indexOf('2字以上') < 0, hintTxt);
  ok('提示里说明了英文/单字都行',
    /英文/.test(hintTxt) && /单字/.test(hintTxt), hintTxt);

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
  const revChecks = {}, voteChecks = {}, partialRows = [], trophies = [];
  let revealBarBox = null, voteBarText = '', voteSnap = null;
  let guard = 0;
  while (guard++ < 40) {
    const ph = await phase(host);
    if (ph === 'chain_lobby' || ph === null) break;
    if (ph === 'chain_draw') { await clickAll('#chainTask .ct-submit'); await sleep(400); continue; }
    if (ph === 'chain_guess') {
      for (const p of pages) {
        await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-guess'); if (b) b.click(); });
        await sleep(120);
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
        // 题面是私发的、晚到几十毫秒画布层就是空的 —— 所以这里等一下再取样，别用固定 sleep
        await host.waitForFunction(() => {
          const img = document.querySelector('#chainCanvasImg');
          return !!(img && (img.src || '').length > 500);
        }, null, { timeout: 8000 }).catch(() => {});
        revChecks.maskGone = !(await host.evaluate(() => !!document.querySelector('#replayMask')));
        revChecks.layerOn = await visible(host, '#chainCanvasLayer');
        revChecks.barOn = await visible(host, '#chainReplayBar');
        revChecks.noCrossNav = !(await host.evaluate(() =>
          !!document.querySelector('#rpPrev') || !!document.querySelector('#rpNext')));
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
      }
      await nudge();                       // 立刻结算 → 进投票
      continue;
    }
    if (ph === 'chain_vote') {
      sawVote = true;
      if (!voteChecks.done) {
        voteChecks.done = true;
        voteSnap = await gst(host);
        voteBarText = await host.evaluate(() => {
          const el = document.querySelector('#chainReplayBar');
          return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        });
        voteChecks.firstLast = await host.evaluate(() => {
          const g = window.ChaApp.state.game || {};
          const c = (window.ChaApp.state.chainReveal || []).find(x => x.chainId === g.voteChainId);
          if (!c) return false;
          const t = document.querySelector('#chainReplayBar').textContent;
          return t.indexOf(c.firstWord) >= 0;
        });
        voteChecks.btns = await visible(host, '#rpVoteOk') && await visible(host, '#rpVoteBad');
        voteChecks.enabled = !(await host.evaluate(() => {
          const a = document.querySelector('#rpVoteOk'), b = document.querySelector('#rpVoteBad');
          return (a && a.disabled) || (b && b.disabled);
        }));
      }
      // 4 个人各投 √
      for (const p of pages) { await p.evaluate(() => { const b = document.querySelector('#rpVoteOk'); if (b) b.click(); }); }
      await sleep(600);
      voteChecks.doneAfter = (await gst(host)).voteDone;
      voteChecks.marked = /已投/.test(await host.textContent('#rpVoteOk'));
      await nudge();                       // 结算这条链
      continue;
    }
    if (ph === 'chain_score') {
      const s = await gst(host);
      const partial = !!(s.voteResult && s.voteResult.partial);
      partialRows.push(partial);
      trophies.push(await visible(host, '#trophyMask'));
      if (!partial) break;
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
  ok('★ 回放严格按 起词 → 画1 → 猜1 → 画2 → 猜2',
    !!revChecks.order && revChecks.order[0] === 'WORD' && revChecks.order[1] === 'DRAWING'
      && revChecks.order[2] === 'GUESS' && revChecks.order[3] === 'DRAWING',
    JSON.stringify(revChecks.order));

  console.log('\n[7] 画布下方的投票条');
  ok('走到了投票阶段', sawVote);
  console.log('  投票条: ' + voteBarText.slice(0, 110));
  ok('★ 给出「起词 → 最终猜词」的对照', voteChecks.firstLast === true,
    voteBarText.slice(0, 90));
  ok('★ 问了「这两个匹配吗？」', /这两个匹配吗/.test(voteBarText));
  ok('★ √ 和 × 两个按钮都在且可点', voteChecks.btns === true);
  ok('★ 两个按钮都不是灰白不可点', voteChecks.enabled === true);
  ok('★ 显示「已投 x / y」', /已投/.test(voteBarText) && voteSnap && voteSnap.voteTotal === 4,
    JSON.stringify({ bar: (voteBarText.match(/已投[^♡]*/) || [])[0], total: voteSnap && voteSnap.voteTotal }));
  ok('★ 服务端指定了当前链（不是让各端自己挑）',
    !!voteSnap && voteSnap.voteChainIndex === 0 && !!voteSnap.voteChainId,
    JSON.stringify({ i: voteSnap && voteSnap.voteChainIndex, id: voteSnap && voteSnap.voteChainId }));
  ok('★ 投 √ 之后已投人数增长', voteChecks.doneAfter >= 1, voteChecks.doneAfter);
  ok('★ 投过的一侧标出「已投」', voteChecks.marked === true);
  console.log('\n[8] 逐链串行：小结算不弹奖杯，最终才弹');
  const small = partialRows.filter(Boolean);
  console.log('  小结算 ' + small.length + ' 次，奖杯弹窗出现情况: ' + JSON.stringify(trophies));
  ok('★ 确实经过了一条链一条链的小结算', small.length >= 1, small.length);
  ok('★ 小结算**不弹奖杯**弹窗（trophies 里除了最后一次都是 false）',
    trophies.slice(0, -1).every(x => x === false), JSON.stringify(trophies));
  ok('★ 最后才进入最终结算（partial = false）',
    partialRows.length > 0 && partialRows[partialRows.length - 1] === false,
    JSON.stringify(partialRows));
  ok('★ 最终结算才弹奖杯弹窗', trophies[trophies.length - 1] === true, JSON.stringify(trophies));

  console.log('\n[5] 结束游戏：本地立即回主菜单');
  const t0 = Date.now();
  await host.click('#btnTrophyStop');
  let entryMs = -1;
  for (let i = 0; i < 40; i++) {
    if (await visible(host, '#entryMask')) { entryMs = Date.now() - t0; break; }
    await sleep(50);
  }
  ok('★ 点「结束游戏」后立刻看到入口页（不等服务端回执）',
    entryMs >= 0 && entryMs < 2000, entryMs + 'ms');
  ok('★ 接龙浮层 / 画布层 / 输入条 / 投票条全收掉了',
    !(await visible(host, '#chainCanvasLayer')) && !(await visible(host, '#chainReplayBar'))
      && !(await visible(host, '#chainInputMask')));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
