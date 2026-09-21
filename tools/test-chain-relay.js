'use strict';
/**
 * ★ v17「传词接龙」（接龙的第二种玩法）的浏览器端到端。
 *
 * 规则（用户给的验收标准）：
 *   4 人 2 轮：A起词 → A画 → B猜 → C画 → D猜 → A画 → B猜 → C画 → D猜（共 9 格）
 *   · 猜完**不画**：猜出来的词直接交给**下家画**
 *   · 回放按实际棒次顺序播（不按玩家分组）
 *   · 投票比对「起词 vs 最后一手猜出来的词」
 *   · 不会无限循环（传满 2 轮就进回放）
 *
 * 用法（要一台**宽**计时的接龙服务端）：
 *   GAME_PICK_MS=9000 GAME_CHAIN_WRITE_MS=8000 GAME_CHAIN_DRAW_MS=8000 \
 *   GAME_CHAIN_GUESS_MS=8000 GAME_CHAIN_REVEAL_MS=9000 GAME_CHAIN_VOTE_MS=12000 \
 *   GAME_CHAIN_SCORE_MS=5000 GAME_CHAIN_CHAIN_SCORE_MS=4000 PORT=8447 node server/src/index.js
 *   node tools/test-chain-relay.js http://127.0.0.1:8447
 *
 * ⚠ 与 test-chain-flow.js 是一条线上的用例：那条守「接龙模式（猜完自己画）」，
 *   这条守「传词接龙（猜完交给下家画）」—— 两条都跑才算两种玩法都没坏。
 */
const path = require('path');
const { chromium } = require('./pw');
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL = (process.argv[2] || 'http://127.0.0.1:8447').replace(/\/+$/, '');
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
  console.log('传词接龙（v17 第二种玩法）@ ' + URL);
  const share = await fetch(URL + '/api/share').then(r => r.json()).catch(() => null);
  if (!share || !share.chain) { console.error('读不到 /api/share'); process.exit(2); }
  console.log('  服务端 pid=' + share.pid + '  接龙计时 ' + JSON.stringify(share.chain));
  console.log('  setup.chainPlay=' + JSON.stringify(share.setup && share.setup.chainPlay)
    + '  setup.relayRounds=' + JSON.stringify(share.setup && share.setup.relayRounds));
  if (share.chain.WRITE_MS > 20000 || share.chain.REVEAL_MS < 6000 || share.chain.VOTE_MS < 8000) {
    console.error('✗ 这台服务端的接龙窗口不合适（写词 ' + share.chain.WRITE_MS + 'ms / 回放 '
      + share.chain.REVEAL_MS + 'ms / 投票 ' + share.chain.VOTE_MS + 'ms）—— 见文件头那套 GAME_CHAIN_*。');
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
  await host.fill('#newRoomName', '传词接龙验收');
  await host.click('#btnCreateRoom');
  await host.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(600);
  const roomId = await host.evaluate(() => window.ChaApp.state.room.id);
  for (let i = 1; i < 4; i++) {
    const p = await newPage(browser);
    await p.goto(URL + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
    await p.fill('#nameInput', '玩家' + (i + 1)).catch(() => {});
    pages.push(p);
  }
  await sleep(900);
  await Promise.all(pages.map(p => p.evaluate(() => {
    const m = document.getElementById('entryMask'); if (m) m.classList.add('hidden');
  })));

  /* ---------- [1] 开局面板：选「传词接龙」+ 传几轮 ---------- */
  console.log('\n[1] 开局面板：接龙下面多了「玩法」与「传几轮」');
  await host.click('#btnGame');
  await sleep(400);
  await host.click('#gmChain');
  await sleep(300);
  ok('★ 接龙那一组里露出来「玩法」这一行', await visible(host, '#rowChainPlay'));
  const playOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainPlay option')).map(o => o.value));
  ok('★ 玩法下拉有 classic / relay 两项',
    playOpts.join(',') === 'classic,relay', JSON.stringify(playOpts));
  ok('★ 默认是 classic（接龙模式）：链长那一行露着、传几轮那一行收着',
    (await visible(host, '#rowChainLength')) && !(await visible(host, '#rowChainRelayRounds')));
  await host.selectOption('#chainPlay', 'relay');
  await sleep(300);
  ok('★ 切成传词接龙：链长那一行收起来、传几轮那一行露出来（链长由轮数算）',
    !(await visible(host, '#rowChainLength')) && (await visible(host, '#rowChainRelayRounds')));
  const roundOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainRelayRounds option')).map(o => o.value));
  ok('★ 传几轮档位 = 1~4（默认 2 轮）',
    roundOpts[0] === '1' && roundOpts[roundOpts.length - 1] === '4', JSON.stringify(roundOpts));
  await host.selectOption('#chainRelayRounds', '2');
  await sleep(250);
  const ruleText = await host.evaluate(() => document.querySelector('#gameRule').textContent);
  ok('★ 规则文案讲清了「猜完不画、交给下家画」',
    /不画/.test(ruleText) && /下一个人画|交给/.test(ruleText), ruleText.slice(0, 60));
  await host.click('#btnGameStart');
  await sleep(800);
  ok('★ 点一次「开始」落在接龙大厅', (await phase(host)) === 'lobby', await phase(host));
  const lobbyHead = await host.evaluate(() =>
    (document.querySelector('#chainLobby .cl-head') || {}).textContent || '');
  ok('★ 大厅标题写明「传词接龙大厅」', /传词接龙/.test(lobbyHead), lobbyHead);
  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#btnChainReady'); if (b) b.click(); });
    await sleep(120);
  }
  ok('全员准备 → 写词阶段',
    await waitAllPhase(pages, 'chain_write', 16000), await phase(host));

  /* ---------- [2] 传词闭环：9 格，每格记下「类型 + 谁的活」 ---------- */
  console.log('\n[2] 4 人 2 轮闭环：起词 → A画 → B猜 → C画 → D猜 → A画 → B猜 → C画 → D猜');
  const byStep = [];            // [{ k, phase, cells: [{ page, type, chainId }] }]
  let guard = 0;
  while (guard++ < 40) {
    const ph = await phase(host);
    if (ph === 'chain_write' || ph === 'chain_draw' || ph === 'chain_guess') {
      const gHost = await gst(host);
      const k = gHost.stepIndex | 0;
      const cells = [];
      for (let i = 0; i < pages.length; i++) {
        const t = await pages[i].evaluate(() => {
          const T = window.ChaApp.state.chainTask;
          return T ? { step: T.step, chainId: T.chainId, word: T.word || '' } : null;
        });
        cells.push({ page: i, type: t ? t.step : '', chainId: t ? t.chainId : '' });
      }
      byStep.push({ k: k, phase: ph, cells: cells, chainPlay: gHost.chainPlay, rounds: gHost.relayRounds });
      // 每格都按类型交：写词点候选 / 作画画一笔再交 / 猜词填词提交
      if (ph === 'chain_write') {
        for (const p of pages) {
          await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-choice'); if (b) b.click(); });
          await sleep(80);
        }
      } else if (ph === 'chain_draw') {
        for (const p of pages) {
          const box = await p.locator('#view').boundingBox();
          if (box) {
            const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
            await p.mouse.move(cx - 60, cy - 30);
            await p.mouse.down();
            for (let z = 1; z <= 8; z++) await p.mouse.move(cx - 60 + z * 15, cy - 30 + Math.sin(z) * 14);
            await p.mouse.up();
            await sleep(60);
          }
          await p.evaluate(() => { const b = document.querySelector('#chainTask .ct-submit'); if (b) b.click(); });
          await sleep(80);
        }
      } else {
        for (const p of pages) {
          await p.evaluate(() => {
            const i = document.querySelector('#ciInput');
            if (i) { i.value = '传词' + Math.floor(Math.random() * 90 + 10); i.dispatchEvent(new Event('input', { bubbles: true })); }
            const s = document.querySelector('#ciSubmit'); if (s) s.click();
          });
          await sleep(80);
        }
      }
      await sleep(250);
      continue;
    }
    if (ph === 'chain_reveal' || ph === 'chain_vote' || ph === 'chain_score') break;
    await sleep(250);
  }

  const g0 = await gst(host);
  console.log('  步数: ' + byStep.length + '  每格类型: ' + JSON.stringify(byStep.map(s => s.phase)));
  ok('★ 一局正好走 9 手（1 起词 + 4 画 + 4 猜）—— 不会无限传下去',
    byStep.length >= 9 && (await gst(host)).revealLegs === 9,
    JSON.stringify({ steps: byStep.length, legs: (await gst(host)).revealLegs }));
  ok('★ 服务端收下了玩法与轮数（快照 chainPlay=relay / relayRounds=2）',
    g0.chainPlay === 'relay' && g0.relayRounds === 2,
    JSON.stringify({ play: g0.chainPlay, rounds: g0.relayRounds }));
  const typeSeq = byStep.map(s => s.phase.replace('chain_', ''));
  ok('★ 类型顺序 = 写词 → 画 → 猜 → 画 → 猜 → 画 → 猜 → 画 → 猜',
    typeSeq.slice(0, 9).join(',') === 'write,draw,guess,draw,guess,draw,guess,draw,guess',
    typeSeq.join(','));

  // 每一格：4 个人各拿到一条不同的链（组内一一映射）
  let bijection = true;
  byStep.slice(0, 9).forEach(s => {
    const ids = s.cells.map(c => c.chainId).filter(Boolean);
    if (ids.length !== 4 || new Set(ids).size !== 4) bijection = false;
  });
  ok('★★ 每一格 4 人各拿到一条不同的链（不重不漏）', bijection,
    JSON.stringify(byStep.map(s => s.cells.map(c => c.chainId))));

  // ★ 核心：**猜的人不画** —— 同一格里「猜」的下一格「画」换成了别人
  //   （按链对齐：第 k 格负责链 X 的人，与第 k+1 格负责链 X 的人必须是两个不同的页面）
  const whoOn = (stepIdx, chainId) => {
    const s = byStep[stepIdx];
    if (!s) return -1;
    const hit = s.cells.filter(c => c.chainId === chainId);
    return hit.length ? hit[0].page : -1;
  };
  const pairs = [];
  for (let k = 0; k + 1 < byStep.length; k++) {
    const isGuess = byStep[k].phase === 'chain_guess';
    const nextIsDraw = byStep[k + 1].phase === 'chain_draw';
    if (!isGuess || !nextIsDraw) continue;
    for (const c of byStep[k].cells) {
      if (!c.chainId) continue;
      const guesser = c.page;
      const drawer = whoOn(k + 1, c.chainId);
      pairs.push({ chainId: c.chainId, guesser, drawer });
    }
  }
  console.log('  「猜完谁画」对照: ' + JSON.stringify(pairs.slice(0, 4)));
  ok('★★ 猜完**不自己画**：每一对「猜 → 下一格画」，画的人都不是刚才猜的人',
    pairs.length >= 4 && pairs.every(x => x.drawer >= 0 && x.drawer !== x.guesser), pairs.slice(0, 4));
  ok('★★ 而且是**下家**画的（画的人 = 环上的下一个人，四个人的活正好轮转）',
    pairs.length >= 4 && new Set(pairs.map(x => x.drawer)).size === 4, pairs.map(x => x.drawer));

  /* ---------- [3] 回放：按实际棒次顺序播 ---------- */
  console.log('\n[3] 回放：起词 → 画 → 猜 → 画 → 猜 …（按棒次，不按玩家分组）');
  const rev = await host.evaluate(() => {
    const st = window.ChaApp.state;
    const c = (st.chainReveal || [])[0] || {};
    return {
      legs: st.game && st.game.revealLegs,
      types: (c.steps || []).map(s => s.type),
      who: (c.steps || []).map(s => s.playerName),
      first: c.firstWord, last: c.lastWord
    };
  });
  console.log('  回放类型: ' + JSON.stringify(rev.types));
  console.log('  回放作者: ' + JSON.stringify(rev.who));
  ok('★ 回放按实际棒次顺序（起词 + 4 画 + 4 猜 = 9 格）',
    rev.legs === 9 && rev.types.join(',') === 'WORD,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS,DRAWING,GUESS',
    rev.types.join(','));
  ok('★ 相邻两格的作者（画 / 猜）不是同一个人 —— 回放里看得见「猜完换人画」',
    rev.who.length === 9 && rev.who[2] !== rev.who[3] && rev.who[4] !== rev.who[5],
    JSON.stringify(rev.who.slice(0, 6)));
  const revUi = await host.evaluate(() => {
    const eng = window.ChaApp.engine;
    const img = document.querySelector('#chainCanvasImg');
    return {
      mode: !!eng.replayMode,
      isFrame: !!(eng.replayCanvas && window.ChaApp.state.cr.anim.raw === eng.replayCanvas),
      imgHidden: !img || img.classList.contains('hidden'),
      top: ((document.querySelector('#cclTopText') || {}).textContent || '').trim()
    };
  });
  ok('★ 回放仍然画在真画布上（没有独立窗口）',
    revUi.mode === true && revUi.isFrame === true && revUi.imgHidden === true, revUi);

  /* ---------- [4] 投票：起词 vs 最后一手猜词 ---------- */
  console.log('\n[4] 投票：起词 vs 最后一手猜出来的词');
  const hostVote = await (async () => {
    for (let i = 0; i < 60; i++) {
      if (await phase(host) === 'chain_vote') return true;
      // 回放走完自动进投票；顺手把回放推快一点（房主的「立刻推进」）
      await host.evaluate(() => { const b = document.querySelector('#btnRpNext'); if (b) b.click(); });
      await sleep(500);
    }
    return false;
  })();
  ok('★ 传完 9 手 → 进投票（不会再多传）', hostVote, await phase(host));
  // 等纸片弹出来（服务端先定格几秒）
  for (let i = 0; i < 60; i++) {
    const on = await host.evaluate(() => {
      const p = document.querySelector('#rpVote');
      return !!(p && !p.classList.contains('hidden'));
    });
    if (on) break;
    await sleep(150);
  }
  const paper = await host.evaluate(() => {
    const p = document.querySelector('#rpVote');
    return {
      on: !!(p && !p.classList.contains('hidden')),
      first: ((document.querySelector('#rpVoteFirst') || {}).textContent || '').trim(),
      last: ((document.querySelector('#rpVoteLast') || {}).textContent || '').trim(),
      ask: ((document.querySelector('#rpVoteHint') || {}).textContent || '').trim(),
      torn: p ? /polygon/.test(getComputedStyle(p).clipPath || '') : false
    };
  });
  console.log('  纸片: ' + JSON.stringify(paper));
  ok('★ 纸片对比的是「起词 vs 最后一手猜词」',
    paper.on === true && paper.first === rev.first && paper.last === rev.last
      && paper.first.length > 0 && paper.last.length > 0,
    { paper: paper, first: rev.first, last: rev.last });
  ok('★ 问句与撕纸外观和接龙模式一致', /这个匹配吗/.test(paper.ask) && paper.torn === true, paper);
  // 全员投 √ → 过半 → 起词人拿一个奖杯
  for (const p of pages) {
    await p.evaluate(() => { const b = document.querySelector('#rpVoteOk'); if (b) b.click(); });
    await sleep(150);
  }
  let settled = null;
  for (let i = 0; i < 60 && !settled; i++) {
    const s = await gst(host);
    if (s.voteResult && s.voteResult.chains && s.voteResult.chains.length) {
      settled = s.voteResult.chains[s.voteResult.chains.length - 1];
      break;
    }
    if (await phase(host) === 'chain_score') {
      const s2 = await gst(host);
      const rows = (s2.settled || []);
      if (rows.length) { settled = rows[rows.length - 1]; break; }
    }
    await sleep(200);
  }
  console.log('  结算行: ' + JSON.stringify(settled));
  ok('★ √ 过半 → 这条链算「对上了」，起词人拿奖杯',
    !!settled && settled.agree >= 4 && settled.won === true,
    settled);

  const objHits = await Promise.all(pages.map(p => p.evaluate(() => {
    const hits = [];
    document.querySelectorAll('#stage *').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent || '';
      if (t.indexOf('[object') >= 0) hits.push((el.id || el.className) + ': ' + t.slice(0, 40));
    });
    return hits;
  })));
  ok('★ 全程没有 [object Object]', objHits.every(h => h.length === 0), objHits.filter(h => h.length));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
