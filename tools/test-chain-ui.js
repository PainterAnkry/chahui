/**
 * ⚠⚠ **这份已经作废，别再跑它，也别拿它当验收标准。**
 *
 * 它测的是「回放用全屏遮罩弹窗（#replayMask / #rpStage / #rpPrev / #rpNext）、
 * 待猜的画缩在左下角小窗（#chainTask 里的 .ct-img）」那一版界面。
 * 2026-09 的接龙重写把那些 DOM **整个删掉了**：
 *   · 画 / 回放 / 投票全部搬到主画布（#chainCanvasLayer + 贴底 #chainReplayBar）
 *   · 回放改成「按链串行」，跨链翻页按钮（#rpPrev / #rpNext）按设计删除
 * 所以这份文件里凡是碰 DOM 的断言都会失败。
 *
 * 同一片覆盖（而且更全）现在由这两份负责，都在 `npm run test:all` 里：
 *   · tools/test-chain-flow.js   —— 重写后的 UI 全流程（真浏览器 4 页，40 项）
 *   · tools/test-chain-serial.js —— 重写后的数据流（真 WebSocket，36 项）
 * npm script 里它已改名到 `test:chain-ui-old`，不再出现在跑批里。
 *
 * 里面还有几段**没被搬走**的东西（开局面板的结构完整性、窄屏下的弹窗尺寸、
 * 界面上的错误收集），要复活请按上面的新结构重写。
 *
 * ---------------------------------------------------------------
 * 接龙 UI 冒烟测试（真浏览器，无头）。
 *
 * 为什么单有 test-chain.js 还不够：那条只跟 WebSocket 说话，验证的是「服务端有没有
 * 把正确的东西发出来」。前端拿到消息之后有没有炸、面板有没有真的显示出来、
 * 按钮点下去有没有反应 —— 这些它一个字都测不到。
 *
 * 这里做的事：开一个真 Chrome，四个人进同一间房 → 开接龙 → 落到「写词」这一步，
 * 然后逐个把新加的弹窗 / 面板翻出来看它们在不在、有没有报错。
 *
 * 用法：node tools/test-chain-ui.js [wsUrl]
 *
 * ⚠ 现状：**大部分已跟上 v9 的接龙重制，只剩「回放」那一节还没重写，所以整份仍是红的。**
 *   已修好：开局要在**大厅**里四个人都点「准备」（v9 起 GAME_START 只进大厅）；
 *   面板里的「回合数」换成「链长」#chainLength；进度面板是「当前这手 + 已交几份」两行
 *   （不再一条链一行）；题面形状是 WORD/DRAWING/GUESS 三个大写 STEP（作画拿 word、
 *   猜词拿 strokes）；链长 = 人数 = 4，所以一圈是**四格**（词→画→猜→画）。
 *
 *   ❌ 还没改的：[7] 后半段。v9 的回放面板换成了**单舞台播放器**
 *      （`#rpStage` 一次只演一格 + `#rpNextItem`/`#rpPrevItem` 逐格走），
 *      而这节还在找旧版的 `#rpStrip .rp-cell`（一格一列的长条）和 `.rp-cell.covered`，
 *      所以「回放里摆出了每一格」和后面的 `waitReveal()` 都会超时。
 *      要按 `#rpStage` + `#rpPills` + `#rpNextItem` 重写这一节。
 *      回放面板本身是好的 —— 这条是**测试没跟上**，不是功能坏了。
 */
'use strict';

const { chromium } = require('./pw');
const http = require('http');

const WS_URL = process.argv[2] || 'ws://127.0.0.1:8444/ws';
const BASE = (() => {
  const u = new URL(WS_URL);
  return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpBase(wsUrl) {
  const u = new URL(wsUrl);
  return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
}
function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get(httpBase(WS_URL) + p, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** 和 test-browser.js 一样：进房前先放一个「自动点确定」的观察器 */
async function installAutoConfirm(page) {
  await page.addInitScript(() => {
    function arm() {
      const mask = document.querySelector('#confirmMask');
      const yes = document.querySelector('#confirmYes');
      if (!mask || !yes) return;
      new MutationObserver(() => {
        if (mask.classList.contains('hidden')) return;
        setTimeout(() => { if (!mask.classList.contains('hidden')) yes.click(); }, 40);
      }).observe(mask, { attributes: true, attributeFilter: ['class'] });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
    else arm();
  });
}

/** 在页面里挂一个「记下服务端 ERROR」的钩子（诊断用） */
async function installErrorSpy(page) {
  await page.addInitScript(() => {
    window.__errs = [];
    function arm() {
      // 等 app.js 建好 net 之后，把 message 事件再包一层
      const t = setInterval(() => {
        const a = window.ChaApp;
        if (!a || !a.net || !a.net.on || a.net.__spied) return;
        a.net.__spied = true;
        clearInterval(t);
        const orig = a.net.on.bind(a.net);
        a.net.on = function (ev, fn) {
          if (ev === 'message') {
            return orig(ev, function (m) {
              if (m && m.type === 'error') window.__errs.push((m.code || '') + ':' + (m.message || ''));
              return fn(m);
            });
          }
          return orig(ev, fn);
        };
      }, 60);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
    else arm();
  });
}
async function seedName(page, name) {
  await page.addInitScript(n => {
    try { localStorage.setItem('chahu.name', n); } catch (e) { /* ignore */ }
  }, name);
}

/** 等页面把网络连上（含 ?room= 自动进房那条路径） */
async function waitJoined(page) {
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined;
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const b = document.querySelector('#btnEntryClose');
    if (b && b.offsetParent) b.click();
  });
  return page.evaluate(() => window.ChaApp.state.room.id);
}

/** 房主：在入口页填名字、建房 */
async function createRoom(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name + '的茶绘室');
  await page.click('#btnCreateRoom');
  return waitJoined(page);
}

(async function main() {
  console.log('接龙 UI 冒烟测试 → ' + WS_URL);

  // ---- 预检：确认对面是我们刚起的那个服务端 ----
  let info;
  try { info = await httpJson('/api/share'); }
  catch (e) { console.error('连不上服务端（' + httpBase(WS_URL) + '）：' + e.message); process.exit(1); }
  if (!info.chain) {
    console.error('对面服务端不认识 chain 字段 —— 是老代码，测下去没意义。先重启服务端。');
    process.exit(1);
  }
  if (!info.themes || info.themes.indexOf('bluearchive') < 0) {
    console.error('对面服务端没有主题词库（themes=' + JSON.stringify(info.themes) + '）—— 先重启服务端。');
    process.exit(1);
  }
  console.log('  服务端 pid=' + info.pid + '  主题=' + info.themes.join(',') + '\n');

  // 用本机已装的 Chrome（channel: 'chrome'），不走 playwright 自己那份 chromium
  // —— 和 test-browser.js 保持一致，也省得再下一套浏览器
  const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];

  // ---- [1] 建房 + 其余三人加入 ----
  console.log('[1] 建房与加入');
  const host = await ctx.newPage();
  host.on('console', m => { if (m.type() === 'error') errs.push('[host] ' + m.text()); });
  host.on('pageerror', e => errs.push('[host] ' + e.message));
  await installAutoConfirm(host);
  await installErrorSpy(host);
  await host.goto(BASE + '/');
  const roomId = await createRoom(host, '房主');
  ok('建房成功', !!roomId, 'roomId=' + roomId);
  if (!roomId) { await browser.close(); return finish(); }

  // 其余三个用 ?room= 直接进房（和真人点分享链接是同一条路径）
  const pages = [host];
  for (let i = 1; i < 4; i++) {
    const p = await ctx.newPage();
    p.on('console', m => { if (m.type() === 'error') errs.push('[p' + i + '] ' + m.text()); });
    p.on('pageerror', e => errs.push('[p' + i + '] ' + e.message));
    await installAutoConfirm(p);
    await installErrorSpy(p);
    await seedName(p, '玩家' + i);
    await p.goto(BASE + '/?room=' + encodeURIComponent(roomId));
    pages.push(p);
  }
  for (let i = 1; i < 4; i++) await waitJoined(pages[i]);
  await sleep(900);

  const online = await host.evaluate(() => (window.ChaApp.state.members || []).length);
  ok('房间里 4 个人（接龙门槛）', online === 4, '实际 ' + online);

  // ---- [2] 游戏弹窗里能切到「接龙」 ----
  console.log('\n[2] 玩法切换');
  await host.click('#btnGame');
  await sleep(300);
  ok('游戏弹窗打开了', await host.isVisible('#gameMask'));
  await host.click('#gmChain');
  await sleep(200);
  ok('「接龙」被选中（有 active 样式）',
    await host.evaluate(() => document.querySelector('#gmChain').classList.contains('active')));
  const startTxt = await host.textContent('#btnGameStart');
  ok('开始按钮文案变成「开始接龙」', startTxt.indexOf('接龙') >= 0, '实际「' + startTxt + '」');
  ok('接龙模式下「回合数」那行被隐藏',
    await host.evaluate(() => document.querySelector('#gameRounds').closest('.form-row').classList.contains('hidden')));
  const ruleTxt = await host.textContent('#gameRule');
  ok('规则文案换成了接龙的说法',
    /接龙|传递|回放|连续/.test(ruleTxt), '实际「' + ruleTxt.slice(0, 40) + '…」');

  // ---- [3] 开局，落到写词阶段 ----
  console.log('\n[3] 开局并落到写词阶段');
  await host.click('#btnGameStart');
  await sleep(600);
  // 选接龙 → 会转到接龙自己的面板（圈数、主题、人数门槛都在那儿）
  ok('转到了接龙开局面板', await host.isVisible('#chainMask'));

  // 主题下拉：服务端通过 /api/share 和快照两处下发；面板打开时应该已经填好
  let themeOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainTheme option')).map(o => o.value));
  // 开局前快照里可能还没有 themes（那时 g 是 null），这时前端会主动再问一次 /api/share
  if (themeOpts.length <= 1) {
    await sleep(900);
    themeOpts = await host.evaluate(() =>
      Array.from(document.querySelectorAll('#chainTheme option')).map(o => o.value));
  }
  ok('主题下拉已填充（含方舟 / 鸣潮 / 碧蓝档案）',
    themeOpts.indexOf('bluearchive') >= 0 && themeOpts.indexOf('arknights') >= 0
      && themeOpts.indexOf('wuthering') >= 0,
    JSON.stringify(themeOpts));
  const themeLabels = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainTheme option')).map(o => o.textContent));
  ok('主题名是可读中文（不是裸 id）',
    themeLabels.some(t => /碧蓝|档案/.test(t)) && themeLabels.some(t => /方舟/.test(t)),
    JSON.stringify(themeLabels));

  // ⚠ v9 把接龙的「回合数」换成了「链长」（#chainRounds 在接龙面板里已经不存在了 ——
  //    上面那条「回合数那行被隐藏」正是在说这件事）。默认 = 在线人数，也就是「传遍全场」。
  const chainLen = await host.inputValue('#chainLength');
  ok('链长默认 = 在线人数（4 人 → 4 手，传遍全场）', chainLen === '4', '实际 ' + chainLen);
  const lenOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainLength option')).map(o => o.value));
  ok('链长可选范围是 3 ~ 人数', lenOpts[0] === '3' && lenOpts[lenOpts.length - 1] === '4',
    JSON.stringify(lenOpts));
  const playersTxt = await host.textContent('#chainPlayers');
  ok('写明了在线人数与门槛', /4/.test(playersTxt) && /人/.test(playersTxt), '实际「' + playersTxt + '」');

  // 真的选一个主题开一局，确认走的是主题词库
  await host.selectOption('#chainTheme', 'bluearchive');
  ok('能把主题切到「碧蓝档案」',
    (await host.inputValue('#chainTheme')) === 'bluearchive');

  await host.click('#btnChainStart');
  await sleep(1200);

  // ⚠ v9 起「进入大厅」不等于开打：GAME_START 只把大家带进**大厅**等人准备
  //    （见 chain.js 的 start()）。少了四个人都点「准备」这一步，
  //    后面所有阶段断言都会停在 chain_lobby —— 这条用例是 v9 之前写的。
  const lobby = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  ok('点「进入大厅」后落在接龙大厅', lobby === 'chain_lobby' || lobby === 'lobby', 'phase=' + lobby);
  for (const p of pages) {
    const canReady = await p.evaluate(() => !!document.querySelector('#btnChainReady'));
    if (!canReady) continue;
    await p.click('#btnChainReady');
    await sleep(150);
  }
  // 全员就绪 → 自动开局 → 开场鼓点（INIT）过了才进写词
  await host.waitForFunction(
    () => (window.ChaApp.state.game || {}).phase === 'chain_write',
    null, { timeout: 20000 }).catch(() => {});
  await sleep(300);

  const st = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  ok('四个人都准备后，服务端认为在接龙写词阶段', st === 'chain_write', 'phase=' + st);
  ok('快照里的 mode 是 chain',
    await host.evaluate(() => (window.ChaApp.state.game || {}).mode === 'chain'));

  const taskPanel = await host.evaluate(() => {
    const box = document.querySelector('#chainTask');
    return {
      visible: box && !box.classList.contains('hidden'),
      label: (document.querySelector('#ctStep') || {}).textContent || '',
      choices: document.querySelectorAll('#chainTask .ct-choice').length,
      txt: box ? box.textContent : ''
    };
  });
  ok('「我这一步」面板露出来了', taskPanel.visible);
  ok('面板标题是「写一个词」', taskPanel.label.indexOf('写') >= 0, '实际「' + taskPanel.label + '」');
  ok('给了候选词 +「自己写一个」', taskPanel.choices >= 4, '实际 ' + taskPanel.choices + ' 个按钮');
  ok('候选里有「自己写」入口', taskPanel.txt.indexOf('自己写') >= 0);

  // ---- [4] 顶栏 HUD 与进度面板 ----
  console.log('\n[4] HUD 与进度面板');
  const hud = await host.evaluate(() => {
    const h = document.querySelector('#gameHud');
    return { visible: h && !h.classList.contains('hidden'), text: h ? h.textContent : '' };
  });
  ok('顶栏游戏 HUD 显示中', hud.visible);
  ok('HUD 上写了「圈」（接龙的说法）', hud.text.indexOf('圈') >= 0, '实际「' + hud.text.slice(0, 60) + '」');

  const prog = await host.evaluate(() => {
    const b = document.querySelector('#chainProgress');
    const dots = document.querySelectorAll('#cpList .cp-dot').length;
    return {
      visible: b && !b.classList.contains('hidden'),
      rows: document.querySelectorAll('#cpList .cp-row').length,
      dots,
      text: b ? b.textContent.replace(/\s+/g, ' ').trim() : ''
    };
  });
  ok('链条进度面板可见', prog.visible);
  // ⚠ v9 把「每条链一行」改成了「当前这一手 + 提交进度」两行 ——
  //    因为现在所有链是**同步走同一手**的，一条链一行的列表反而看不出「现在到第几手」。
  ok('进度面板两行（当前这手 / 已交几份）', prog.rows === 2, '实际 ' + prog.rows + ' 行：' + prog.text);
  ok('★ 手数用一排点标出来（点数 = 链长 4）', prog.dots === 4, '实际 ' + prog.dots + ' 个点');

  ok('房主能看到「立刻推进」', await host.isVisible('#ghNext'));
  ok('非房主看不到「立刻推进」', !(await pages[1].isVisible('#ghNext')));

  // ---- [5] 弹窗结构完整性 ----
  console.log('\n[5] 弹窗结构完整性');
  for (const id of ['#chainMask', '#chainInputMask', '#replayMask', '#trophyMask']) {
    ok(id + ' 存在于 DOM', await host.evaluate(s => !!document.querySelector(s), id));
  }
  await host.evaluate(() => document.querySelector('#chainMask').classList.remove('hidden'));
  await sleep(200);
  const box = await host.evaluate(() => {
    const r = document.querySelector('#chainMask .modal').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('开局面板有实际尺寸（CSS 没塌）', box.w > 200 && box.h > 150, JSON.stringify(box));
  await host.evaluate(() => document.querySelector('#chainMask').classList.add('hidden'));

  // ---- [6] 写词提交 → 面板变「已提交」 ----
  console.log('\n[6] 提交一个词');
  await host.evaluate(() => {
    const b = document.querySelector('#chainTask .ct-choice');
    if (b) b.click();
  });
  await sleep(1000);
  const after = await host.evaluate(() => {
    const el = document.querySelector('#chainTask');
    return { txt: el.textContent || '', hidden: el.classList.contains('hidden') };
  });
  ok('提交后题面面板变成「已提交」', after.txt.indexOf('已提交') >= 0,
    '实际「' + after.txt.slice(0, 50) + '」');

  // ---- [7] 全流程：写词 → 作画 → 猜词 → 回放 → 投票 → 奖杯 ----
  // 这一段才是这个脚本存在的意义：前面都是静态检查，这里是真的把四个人的
  // 一圈走完，看前端在「轮到我做什么」不断变化时会不会塌。
  console.log('\n[7] 走完整整一圈（四人 × 写/画/猜）');

  // stepTotal 是「这一圈」的步数（每人一步），不是整局的 —— 4 人一圈就是 4
  const st2 = await host.evaluate(() => ({
    total: (window.ChaApp.state.game || {}).stepTotal,
    chainLength: (window.ChaApp.state.game || {}).chainLength
  }));
  ok('这一圈的总步数 = 在场人数', st2.total === 4, JSON.stringify(st2));
  // ⚠ v9 把「回合数（圈数）」换成了「链长」——一圈就是一次接力，链长 = 传几手。
  //    开局时没显式改过 #chainLength，它的默认值 = 在线人数 = 4。
  ok('链长 = 在线人数（4 手）', st2.chainLength === 4, JSON.stringify(st2));

  // 每个人都提交自己的词
  for (let i = 1; i < 4; i++) {
    await pages[i].evaluate(() => {
      const b = document.querySelector('#chainTask .ct-choice');
      if (b) b.click();
    });
  }
  await sleep(2200);

  // 现在应该进入「作画」步
  let phase = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  ok('写词都交完后进入作画步', phase === 'chain_draw', 'phase=' + phase);

  // 每人画一笔然后「交上去」
  const drawOne = async (p) => {
    const box = await p.locator('#view').boundingBox();
    const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
    await p.mouse.move(cx - 90, cy - 50);
    await p.mouse.down();
    for (let k = 1; k <= 8; k++) await p.mouse.move(cx - 90 + k * 22, cy - 50 + Math.sin(k / 2) * 26);
    await p.mouse.up();
    await sleep(250);
    // 有 task 面板上的「画好了，交上去」就点它
    await p.evaluate(() => {
      const b = document.querySelector('#chainTask .ct-submit');
      if (b) b.click();
    });
    // 顺手记下服务端有没有回 ERROR（比如「作品数据不对」）
    await sleep(200);
    const e = await p.evaluate(() => (window.ChaApp.state.lastGameError || ''));
    if (e) serverErrs.push(e);
  };

  const drawTask = await host.evaluate(() => {
    const t = window.ChaApp.state.chainTask;
    return t ? { step: t.step, hasWord: !!t.word, hasImg: !!t.image, strokes: (t.strokes || []).length } : null;
  });
  // ⚠ STEP 的值在 v9 改成了大写（'DRAWING' / 'GUESS' / 'WORD'），题面也换了形状：
  //    作画拿到的是**一个词**（word），猜词拿到的是**上家的笔迹数组**（strokes，
  //    客户端自己渲染成图）—— 不再是以前的 _img / hasImg。
  ok('作画这一步的题面是「一个词」，不是图',
    !!drawTask && drawTask.step === 'DRAWING' && drawTask.hasWord && drawTask.strokes === 0,
    JSON.stringify(drawTask));

  for (const p of pages) await drawOne(p);
  await sleep(2500);

  phase = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  ok('作画都交完后进入猜词步', phase === 'chain_guess', 'phase=' + phase);
  if (phase !== 'chain_guess') {
    for (let i = 0; i < pages.length; i++) {
      const e = await pages[i].evaluate(() => window.__errs || []);
      console.log('    诊断 p' + i + ' 服务端错误: ' + (e.length ? e.join(' | ') : '（无）'));
      const st = await pages[i].evaluate(() => {
        const g = window.ChaApp.state.game || {};
        const t = window.ChaApp.state.chainTask;
        return g.phase + ' task=' + (t ? t.step : '无') + ' 已交=' + window.ChaApp.state.chainInputSubmitted;
      });
      console.log('    诊断 p' + i + ' 前端状态: ' + st);
    }
  }
  const guessTask = await host.evaluate(() => {
    const t = window.ChaApp.state.chainTask;
    return t ? { step: t.step, keys: Object.keys(t).sort().join(','), strokes: (t.strokes || []).length, word: t.word } : null;
  });
  // ⚠ v9 的猜词题面是 { step:'GUESS', strokes:[...] } —— 笔迹数组，客户端本地渲染成图
  //    （渲染好的那张会挂在本地字段 _img 上，所以 keys 里有它，但那是前端自己加的）。
  //    关键是：**只有笔迹，没有 word**。
  ok('猜词这一步只拿到「上家的笔迹」，没有词',
    !!guessTask && guessTask.step === 'GUESS' && guessTask.strokes > 0 && !guessTask.word,
    JSON.stringify(guessTask));
  ok('猜词面板把图渲染出来了', await host.evaluate(() => {
    const el = document.querySelector('#chainTask .ct-img');
    return !!(el && el.src && el.src.length > 100);
  }));

  // 猜词输入框：点「回答」应该把弹窗顶出来
  await host.evaluate(() => {
    const b = document.querySelector('#chainTask .ct-guess');
    if (b) b.click();
  });
  await sleep(350);
  ok('点「回答」弹出猜词输入框', await host.isVisible('#chainInputMask'));
  const placeholder = await host.getAttribute('#ciInput', 'placeholder');
  ok('输入框有提示文案', !!placeholder, 'placeholder=' + JSON.stringify(placeholder));

  // 四个人都猜一个词
  for (const p of pages) {
    await p.evaluate(() => {
      const b = document.querySelector('#chainTask .ct-guess');
      if (b) b.click();
    });
    await sleep(200);
    await p.evaluate(() => {
      const i = document.querySelector('#ciInput');
      if (i) {
        i.value = '冰淇淋';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const s = document.querySelector('#ciSubmit');
      if (s) s.click();
    });
    await sleep(250);
  }
  await sleep(2600);

  // ⚠ v9 的链长默认 = 在线人数 = 4，所以格子是**四格**：
  //    写词 → 照词作画 → 看画猜词 → 再照词作画（第 4 手还是画），然后才进回放。
  //    这里补上最后一格作画，不然会停在 chain_draw 上。
  phase = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  if (phase === 'chain_draw') {
    console.log('    （第 4 手还是作画 —— 补走一格）');
    for (const p of pages) await drawOne(p);
    await sleep(2600);
    phase = await host.evaluate(() => (window.ChaApp.state.game || {}).phase);
  }
  ok('一圈走完自动进入回放阶段', phase === 'chain_reveal' || phase === 'chain_vote', 'phase=' + phase);
  if (phase !== 'chain_vote') {
    const rg = await host.evaluate(() => {
      const g = window.ChaApp.state.game || {};
      return { round: g.round, rounds: g.rounds, stepDone: g.stepDone, stepTotal: g.stepTotal,
        progress: (g.progress || []).map(p => p.step + '/' + p.total).join(' ') };
    });
    console.log('    诊断服务端轮次: ' + JSON.stringify(rg));
    for (let i = 0; i < pages.length; i++) {
      const e = await pages[i].evaluate(() => window.__errs || []);
      console.log('    诊断 p' + i + ' 错误: ' + (e.length ? e.join(' | ') : '（无）'));
    }
  }

  // 回放面板要等它真的弹出来再取样（阶段刚切过去时它还在渲染）
  await host.waitForSelector('#replayMask:not(.hidden)', { timeout: 6000 }).catch(() => {});
  await sleep(400);
  const rp = await host.evaluate(() => {
    const mask = document.querySelector('#replayMask');
    return {
      visible: mask && !mask.classList.contains('hidden'),
      cells: document.querySelectorAll('#rpStrip .rp-cell').length,
      index: (document.querySelector('#rpIndex') || {}).textContent || '',
      head: (document.querySelector('#rpChainHead') || {}).textContent || '',
      verdict: (document.querySelector('#rpVerdict') || {}).textContent || ''
    };
  });
  ok('回放面板自动弹出来', rp.visible);
  // 链长 4 → 一条链 4 格（词→画→猜→画），4 条链逐条翻
  ok('回放里摆出了这条链的每一格（链长 4 = 4 格）', rp.cells === 4, '实际 ' + rp.cells + ' 格');

  // 回放是「逐格揭晓」的：格子上先挂着 .covered，判定与投票按钮要等演完才出现。
  // 所以下面所有依赖「揭晓完成」的断言都必须先等这一个条件 —— 用固定 sleep 会随机失败。
  await host.waitForFunction(() => {
    const cells = document.querySelectorAll('#rpStrip .rp-cell');
    const verdict = document.querySelector('#rpVerdict');
    return cells.length > 0 &&
      !document.querySelector('#rpStrip .rp-cell.covered') &&
      verdict && verdict.classList.contains('rp-in') &&
      verdict.textContent.indexOf('传了') >= 0;
  }, { timeout: 6000 });

  const rp2 = await host.evaluate(() => ({
    cells: document.querySelectorAll('#rpStrip .rp-cell').length,
    covered: document.querySelectorAll('#rpStrip .rp-cell.covered').length,
    index: (document.querySelector('#rpIndex') || {}).textContent || '',
    head: (document.querySelector('#rpChainHead') || {}).textContent || '',
    verdict: (document.querySelector('#rpVerdict') || {}).textContent || '',
    pills: document.querySelectorAll('#rpChainHead .rp-pill').length,
    pillOn: document.querySelectorAll('#rpChainHead .rp-pill.on').length,
    arrows: document.querySelectorAll('#rpStrip .rp-arrow').length
  }));

  ok('揭晓动画跑完（不再有盖着的格子）', rp2.covered === 0, '实际还有 ' + rp2.covered + ' 格没翻');
  ok('页码显示「1 / N」', /1\s*\/\s*[1-9]/.test(rp2.index), '实际「' + rp2.index + '」');
  ok('写明了这条链的起词人', rp2.head.indexOf('起词人') >= 0, '实际「' + rp2.head + '」');
  ok('进度小点的数量 = 链数（4 人 4 条链）', rp2.pills === 4, '实际 ' + rp2.pills + ' 个点');
  ok('当前链的小点被点亮', rp2.pillOn === 1, '实际 ' + rp2.pillOn + ' 个点亮');
  ok('格与格之间有「传下去」的箭头', rp2.arrows === 2, '实际 ' + rp2.arrows + ' 个箭头');
  ok('首尾对照说明了传了几手', rp2.verdict.indexOf('传了') >= 0, '实际「' + rp2.verdict + '」');

  // 翻页也要等新链的揭晓演完才能断文案
  const waitReveal = () => host.waitForFunction(() => {
    const verdict = document.querySelector('#rpVerdict');
    return !document.querySelector('#rpStrip .rp-cell.covered') &&
      verdict && verdict.textContent.indexOf('传了') >= 0;
  }, { timeout: 6000 });

  const idxBefore = await host.textContent('#rpIndex');
  await host.click('#rpNext');
  await waitReveal();
  const idxAfter = await host.textContent('#rpIndex');
  ok('「下一条」能翻页', idxAfter !== idxBefore, idxBefore + ' → ' + idxAfter);
  await host.click('#rpPrev');
  await waitReveal();
  ok('「上一条」翻回来了', (await host.textContent('#rpIndex')) === idxBefore);

  // 投票
  await host.click('#rpVoteOk');
  await host.waitForFunction(() => {
    const g = window.ChaApp.state.game || {};
    return (g.myVoted || []).length >= 1;
  }, { timeout: 4000 });
  const voted = await host.evaluate(() => {
    const g = window.ChaApp.state.game || {};
    const okBtn = document.querySelector('#rpVoteOk');
    return {
      myVoted: (g.myVoted || []).length,
      myAgainst: (g.myVotes || []).length,
      label: okBtn.textContent,
      primary: okBtn.classList.contains('primary'),
      votedMark: okBtn.classList.contains('voted')
    };
  });
  ok('投了「对得上」之后标记为已投（myVoted 有记录）', voted.myVoted >= 1, JSON.stringify(voted));
  ok('「对得上」不算反对票（myVotes 仍为空）', voted.myAgainst === 0, JSON.stringify(voted));
  ok('按钮文案变成「已投：对得上」', /已投/.test(voted.label), '实际「' + voted.label + '」');
  ok('按钮进入选中态（primary）', voted.primary);
  ok('按钮带上「已投」的记号', voted.votedMark);

  // 投「对不上」再切回来，确认两种都能投
  await host.click('#rpVoteBad');
  await host.waitForFunction(() => ((window.ChaApp.state.game || {}).myVotes || []).length >= 1, { timeout: 4000 });
  const against = await host.evaluate(() => {
    const g = window.ChaApp.state.game || {};
    return { myAgainst: (g.myVotes || []).length,
      label: document.querySelector('#rpVoteBad').textContent };
  });
  ok('改投「对不上」会记进反对票', against.myAgainst >= 1, JSON.stringify(against));
  ok('「对不上」按钮文案也跟着变', /已投/.test(against.label), '实际「' + against.label + '」');
  await host.click('#rpVoteOk');
  await host.waitForFunction(() => ((window.ChaApp.state.game || {}).myVotes || []).length === 0, { timeout: 4000 });
  ok('再切回「对得上」能撤销反对票',
    (await host.evaluate(() => ((window.ChaApp.state.game || {}).myVotes || []).length)) === 0);

  // 房主提前结算。
  // 注意：投票阶段回放面板是全屏的，会盖住顶栏那个「立刻推进」——
  // 所以这里点面板自己的「立刻结算」（同一件事，只是位置在人手边）。
  const settleBtn = await host.isVisible('#btnRpNext');
  ok('回放面板上有房主的「立刻结算」', settleBtn);
  await host.click('#btnRpNext');
  await sleep(1500);

  const over = await host.evaluate(() => ({
    phase: (window.ChaApp.state.game || {}).phase,
    trophy: !document.querySelector('#trophyMask').classList.contains('hidden'),
    rows: document.querySelectorAll('#trophyList .gs-row').length,
    summary: (document.querySelector('#trSummary') || {}).textContent || ''
  }));
  ok('结算后进入 over', over.phase === 'over', 'phase=' + over.phase);
  ok('奖杯面板自动弹出来', over.trophy);
  ok('奖杯榜列出了每一位玩家', over.rows >= 4, '实际 ' + over.rows + ' 行');
  ok('结算摘要里说了哪条链安全到达', /安全到达|全军覆没/.test(over.summary),
    '实际「' + over.summary.slice(0, 40) + '」');

  await host.click('#btnTrophyClose');
  await sleep(250);
  ok('奖杯面板能关掉', !(await host.isVisible('#trophyMask')));

  // ---- [8] 控制台干净 ----
  console.log('\n[8] 控制台干净');
  const realErrs = errs.filter(e => !/favicon|net::ERR_|Download the React/i.test(e));
  ok('整个过程没有 JS 报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  // ---- 收尾 ----
  await host.evaluate(() => { try { window.ChaApp.net.send(window.ChaApp.P.C2S.ROOM_DESTROY, {}); } catch (e) {} });
  await sleep(500);
  await browser.close();
  finish();

  function finish() {
    console.log('\n' + '═'.repeat(46));
    console.log('  通过 ' + pass + ' / ' + (pass + fail));
    console.log('═'.repeat(46));
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error('测试崩了：', e); process.exit(1); });
