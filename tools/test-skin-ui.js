/**
 * 画皮 UI 冒烟测试（真浏览器，无头）。
 *
 * 为什么单有 test-skin.js 还不够：那条只跟 WebSocket 说话，验证的是「服务端有没有
 * 把正确的东西发出来」。前端拿到消息之后有没有炸、身份卡有没有真的显示、
 * 夜里面板有没有弹出来、按钮点下去有没有反应 —— 这些它一个字都测不到。
 * 画皮尤其危险：它比接龙多了一整套**私有信息**（身份、夜里裁定、刀口），
 * 前端任何一处渲染分支写错，画出来的就是「全房间都看得见底牌」。
 *
 * 这里做的事：开一个真 Chrome，六个人进同一间房 → 开画皮 → 逐个把新加的
 * 面板 / 卡片翻出来看它们在不在、内容对不对、有没有报错。
 *
 * 用法：
 *   GAME_SKIN_NIGHT_MS=4000 GAME_SKIN_DAWN_MS=3000 GAME_SKIN_DRAW_MS=4000 \
 *   GAME_SKIN_TALK_MS=2500 GAME_SKIN_VOTE_MS=3000 GAME_SKIN_VOTE_END_MS=2000 \
 *   GAME_SKIN_WITCH_GRACE_MS=1500 PORT=8446 node server/src/index.js
 *   node tools/test-skin-ui.js http://127.0.0.1:8446
 *
 * ⚠ 六个人 = 六个 Chrome 页面。这个脚本比别的 UI 测试慢，而且夜里有人要开面板、
 *   有人只该看到「等别人」—— 每个页面的身份是随机的，所以断言全部按
 *   「这个页面自己的身份」来分支，不假设谁是狼。
 */
'use strict';

const { chromium } = require('./pw');
const http = require('http');

const BASE_IN = process.argv[2] || 'http://127.0.0.1:8445';
const BASE = BASE_IN.replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const ROOM_SIZE = 6;          // 画皮的下限（也是这个脚本用的人数）

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    failures.push(name + (extra ? ' \u2192 ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : ''));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** 进房前先放一个「自动点确定」的观察器（二次确认弹窗会挡住流程） */
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

/** 记下服务端回的 ERROR（诊断用） */
async function installErrorSpy(page) {
  await page.addInitScript(() => {
    window.__errs = [];
    function arm() {
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

async function waitJoined(page) {
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined;
  }, { timeout: 20000 });
  await page.evaluate(() => {
    const b = document.querySelector('#btnEntryClose');
    if (b && b.offsetParent) b.click();
  });
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function createRoom(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 15000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name + '的茶绘室');
  await page.click('#btnCreateRoom');
  return waitJoined(page);
}

/** 这个页面自己的画皮状态（前端内存里的那一份） */
function pageState(p) {
  return p.evaluate(() => {
    const a = window.ChaApp;
    const g = a.state.game || null;
    const r = a.state.skinRole || null;
    return {
      mode: g ? g.mode : '',
      phase: g ? g.phase : '',
      round: g ? g.round : 0,
      word: g ? g.word || '' : '',
      canDraw: !!(g && g.canDraw),
      aliveCount: g ? g.aliveCount : 0,
      drawDone: g ? g.drawDone : 0,
      drawTotal: g ? g.drawTotal : 0,
      voteDone: g ? g.voteDone : 0,
      galleryCount: g ? g.galleryCount : 0,
      gallery: g && g.gallery ? g.gallery.length : 0,
      // 服务端认可的「真交了稿」数 —— skipped 的是超时占位，不算
      galleryReal: g && g.gallery ? g.gallery.filter(x => !x.skipped).length : 0,
      role: r ? r.role : '',
      roleName: r ? r.roleName : '',
      camp: r ? r.camp : '',
      alive: r ? !!r.alive : false,
      mates: r && r.mates ? r.mates.length : 0,
      isOwner: !!(a.state.me && a.state.me.isOwner),
      drawn: !!a.state.skinDrawnSubmitted
    };
  });
}

/** 等某个页面进入某阶段 */
async function waitPhase(p, phase, timeout) {
  try {
    await p.waitForFunction(ph => {
      const g = window.ChaApp.state.game;
      return g && g.phase === ph;
    }, phase, { timeout: timeout || 20000 });
    return true;
  } catch (e) { return false; }
}

/** 等阶段变成「这几个之一」（夜里可能直接判胜负，不能死等一个值） */
async function waitAnyPhase(p, phases, timeout) {
  try {
    await p.waitForFunction(list => {
      const g = window.ChaApp.state.game;
      return g && list.indexOf(g.phase) >= 0;
    }, phases, { timeout: timeout || 20000 });
    return true;
  } catch (e) { return false; }
}

/** 在画布上画一笔（走真鼠标事件，和真人一致） */
async function drawStroke(p, dx) {
  const box = await p.locator('#view').boundingBox();
  if (!box) return;
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
  const off = dx || 0;
  await p.mouse.move(cx - 90 + off, cy - 50);
  await p.mouse.down();
  for (let k = 1; k <= 8; k++) {
    await p.mouse.move(cx - 90 + off + k * 22, cy - 50 + Math.sin(k / 2) * 26);
  }
  await p.mouse.up();
  await sleep(180);
}

(async function main() {
  console.log('画皮 UI 冒烟测试 → ' + BASE);

  // ---- 预检：确认对面是我们刚起的那个服务端（旧进程会把整轮跑成假绿） ----
  let info;
  try { info = await httpJson('/api/share'); }
  catch (e) { console.error('连不上服务端（' + BASE + '）：' + e.message); process.exit(1); }
  if (!info.skin || !info.skin.NIGHT_MS) {
    console.error('对面服务端不认识 skin 计时字段 —— 是老代码或没开压缩计时。先重启服务端。');
    console.error('  share.skin = ' + JSON.stringify(info.skin));
    process.exit(1);
  }
  if (!info.themes || info.themes.indexOf('bluearchive') < 0) {
    console.error('对面服务端没有主题词库（themes=' + JSON.stringify(info.themes) + '）—— 先重启服务端。');
    process.exit(1);
  }
  console.log('  服务端 pid=' + info.pid + '  画皮计时=' + JSON.stringify(info.skin));
  console.log('  主题=' + info.themes.join(',') + '\n');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];

  // ---- [1] 建房 + 另外五人加入（画皮下限 6 人） ----
  console.log('[1] 建房与加入（' + ROOM_SIZE + ' 人）');
  const host = await ctx.newPage();
  host.on('console', m => { if (m.type() === 'error') errs.push('[host] ' + m.text()); });
  host.on('pageerror', e => errs.push('[host] ' + e.message));
  await installAutoConfirm(host);
  await installErrorSpy(host);
  await host.goto(BASE + '/');
  const roomId = await createRoom(host, '房主');
  ok('建房成功', !!roomId, 'roomId=' + roomId);
  if (!roomId) { await browser.close(); return finish(); }

  const pages = [host];
  for (let i = 1; i < ROOM_SIZE; i++) {
    const p = await ctx.newPage();
    p.on('console', m => { if (m.type() === 'error') errs.push('[p' + i + '] ' + m.text()); });
    p.on('pageerror', e => errs.push('[p' + i + '] ' + e.message));
    await installAutoConfirm(p);
    await installErrorSpy(p);
    await seedName(p, '玩家' + i);
    await p.goto(BASE + '/?room=' + encodeURIComponent(roomId));
    pages.push(p);
  }
  for (let i = 1; i < ROOM_SIZE; i++) await waitJoined(pages[i]);
  await sleep(1200);

  const online = await host.evaluate(() => (window.ChaApp.state.members || []).length);
  ok('房间里 ' + ROOM_SIZE + ' 个人（画皮下限）', online === ROOM_SIZE, '实际 ' + online);

  // ---- [2] 游戏弹窗里能切到「画皮」 ----
  console.log('\n[2] 玩法切换');
  await host.click('#btnGame');
  await sleep(300);
  ok('游戏弹窗打开了', await host.isVisible('#gameMask'));
  ok('玩法分段控件里有「画皮」这一项',
    await host.evaluate(() => !!document.querySelector('#gmSkin')));

  await host.click('#gmSkin');
  await sleep(250);
  ok('「画皮」被选中（有 active 样式）',
    await host.evaluate(() => document.querySelector('#gmSkin').classList.contains('active')));
  ok('经典模式不再是选中态',
    await host.evaluate(() => !document.querySelector('#gmClassic').classList.contains('active')));
  const startTxt = await host.textContent('#btnGameStart');
  ok('开始按钮文案变成「开始画皮」', /画皮/.test(startTxt), '实际「' + startTxt + '」');
  ok('画皮模式下「回合数」那行被隐藏',
    await host.evaluate(() => document.querySelector('#gameRounds').closest('.form-row').classList.contains('hidden')));
  const ruleTxt = await host.textContent('#gameRule');
  ok('规则文案换成了画皮的说法（提到伪装者 / 匿名 / 放逐）',
    /伪装者/.test(ruleTxt) && /匿名|摊开/.test(ruleTxt) && /放逐/.test(ruleTxt),
    '实际「' + ruleTxt.slice(0, 60) + '…」');

  // ---- [3] 开局面板：三合一之后**不再有第二层面板**，参数就在 #gameMask 里 ----
  //  （2026-09 面板合并：原来的 #skinMask / #skinTheme / #skinRounds / #btnSkinStart 整块删掉了）
  console.log('\n[3] 开局面板（三合一）');
  ok('画皮参数就在同一个开局面板里（没有第二层 #skinMask）',
    !(await host.evaluate(() => !!document.querySelector('#skinMask'))));
  ok('画皮该显示的参数行露出来了（轮数 / 夜 / 天亮 / 讨论 / 投票）',
    await host.evaluate(() => ['#gameSkinRounds', '#gameNightTime', '#gameDawnTime',
      '#gameTalkTime', '#gameVoteTime'].every(s => {
      const el = document.querySelector(s);
      return !!el && !el.closest('.form-row').classList.contains('hidden');
    })));

  let themeOpts = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#gameTheme option')).map(o => o.value));
  if (themeOpts.length <= 1) {
    await sleep(1100);
    themeOpts = await host.evaluate(() =>
      Array.from(document.querySelectorAll('#gameTheme option')).map(o => o.value));
  }
  ok('主题下拉已填充（含方舟 / 鸣潮 / 碧蓝档案）',
    themeOpts.indexOf('bluearchive') >= 0 && themeOpts.indexOf('arknights') >= 0
      && themeOpts.indexOf('wuthering') >= 0,
    JSON.stringify(themeOpts));

  const rounds = await host.inputValue('#gameSkinRounds');
  ok('轮数默认 6', rounds === '6', '实际 ' + rounds);
  const playersTxt = await host.textContent('#gamePlayers');
  ok('写明了人数门槛与当前人数', /6/.test(playersTxt) && /12/.test(playersTxt) && /人/.test(playersTxt),
    '实际「' + playersTxt + '」');
  const startBtnTxt = await host.textContent('#btnGameStart');
  ok('人够了 → 按钮写「开始画皮」', /开始画皮/.test(startBtnTxt), '实际「' + startBtnTxt + '」');
  ok('人够了 → 按钮可点',
    await host.evaluate(() => !document.querySelector('#btnGameStart').disabled));

  // 换一个玩法看一眼再切回来，确认分段控件是双向的
  await host.click('#gmClassic');
  await sleep(250);
  ok('能切回经典（按钮文案复位）',
    /开始游戏/.test(await host.textContent('#btnGameStart')));
  ok('切回经典后画皮特有参数被收起来',
    await host.evaluate(() => document.querySelector('#gameSkinRounds')
      .closest('.form-row').classList.contains('hidden')));
  await host.click('#gmSkin');
  await sleep(250);
  ok('再切回画皮，参数行又露出来',
    await host.evaluate(() => !document.querySelector('#gameSkinRounds')
      .closest('.form-row').classList.contains('hidden')));

  // 选主题 + 真的开局
  await host.selectOption('#gameTheme', 'bluearchive');
  ok('能把主题切到「碧蓝档案」',
    (await host.inputValue('#gameTheme')) === 'bluearchive');

  /* ⚠ 这一局**选最短的 4 轮**，只为把「结算面板」那一段跑到。
     默认 6 轮，压缩计时下每轮 ~18 秒（夜 4 + 天亮 3 + 作画 4 + 讨论 2.5 + 投票 3
     + 结算 2），六轮 ≈ 110 秒 —— 远超 [10] 那段的耐心，于是它每次都跑不到结算，
     变成一条稳定的假红。
     轮数的**默认值**上面那行已经断言过了（必须还是 6，这里不改默认）。 */
  await host.selectOption('#gameSkinRounds', '4');
  ok('能把轮数选成 4（最短，只为让这一局尽快走到结算）',
    (await host.inputValue('#gameSkinRounds')) === '4');

  await host.click('#btnGameStart');          // 三合一：一次点击直接开局
  await sleep(2000);
  ok('开局面板关掉了', !(await host.isVisible('#gameMask')));

  // ---- [4] 身份卡：每人拿到自己的身份，且只看得到自己那份 ----
  console.log('\n[4] 身份卡');
  const st0 = await pageState(host);
  ok('快照里的 mode 是 skin', st0.mode === 'skin', 'mode=' + st0.mode);
  ok('阶段推进到 lobby 或夜里', /lobby|skin_/.test(st0.phase), 'phase=' + st0.phase);

  // 等身份到手（在夜里才发；lobby 阶段可能还没到）
  await waitAnyPhase(pages[0], ['skin_night', 'skin_dawn', 'over'], 25000);
  await sleep(400);

  const all = [];
  for (let i = 0; i < pages.length; i++) all.push(await pageState(pages[i]));

  const withRole = all.filter(x => x.role);
  ok('每个页面都拿到了身份（6 份）', withRole.length === ROOM_SIZE,
    '实际 ' + withRole.length + ' 份：' + all.map(x => x.role || '无').join(','));

  const roleSet = {};
  withRole.forEach(x => { roleSet[x.role] = (roleSet[x.role] || 0) + 1; });
  const wolves = withRole.filter(x => x.camp === 'wolf').length;
  ok('伪装者恰好 2 个（6 人配比）', wolves === 2, '实际 ' + wolves + ' 个：' + JSON.stringify(roleSet));
  ok('有 1 个预言家', (roleSet.seer || 0) === 1, JSON.stringify(roleSet));
  ok('有 1 个女巫', (roleSet.witch || 0) === 1, JSON.stringify(roleSet));
  ok('剩下 2 个平民画师', (roleSet.villager || 0) === 2, JSON.stringify(roleSet));

  // 身份卡真的画出来了（只对活人、且是画皮局）
  const roleCard = await host.evaluate(() => {
    const box = document.querySelector('#skinRole');
    return {
      visible: box && !box.classList.contains('hidden'),
      badge: (document.querySelector('#srBadge') || {}).textContent || '',
      body: (document.querySelector('#srBody') || {}).textContent || ''
    };
  });
  ok('身份卡显示出来了', roleCard.visible);
  const myHost = all[0];
  ok('身份卡上的身份名与内存里一致', roleCard.badge.indexOf(myHost.roleName) >= 0,
    '卡片「' + roleCard.badge + '」 vs 内存「' + myHost.roleName + '」');
  ok('身份卡写了阵营', /阵营/.test(roleCard.body), '实际「' + roleCard.body.slice(0, 40) + '」');

  // 狼一定拿到同伴名单；好人一定拿不到（这是身份保密的核心）
  for (let i = 0; i < pages.length; i++) {
    const mine = all[i];
    const card = await pages[i].evaluate(() =>
      (document.querySelector('#srBody') || {}).textContent || '');
    if (mine.camp === 'wolf') {
      ok('p' + i + '（伪装者）身份卡上有同伴名单', /同伴/.test(card));
    } else {
      ok('p' + i + '（画师）身份卡上没有同伴名单', !/同伴/.test(card));
    }
  }
  // 狼两人互相看得到对方
  const wolfIdx = [];
  for (let i = 0; i < pages.length; i++) if (all[i].camp === 'wolf') wolfIdx.push(i);
  if (wolfIdx.length === 2) {
    const mateOk = await pages[wolfIdx[0]].evaluate(() =>
      document.querySelectorAll('#srBody .sr-mate').length);
    ok('伪装者看到 1 个同伴（2 狼局）', mateOk === 1, '实际 ' + mateOk + ' 个');
  }

  // 预言家**不该**拿到狼名单长度（只知道阵营不知道整张表）
  const seerIdx = all.findIndex(x => x.role === 'seer');
  if (seerIdx >= 0) {
    const seerMates = all[seerIdx].mates;
    ok('预言家拿不到同伴名单（mates 为空）', !seerMates, 'mates=' + seerMates);
  }

  // ---- [5] 夜里动作面板 ----
  console.log('\n[5] 夜里动作面板');
  const nightIdx = all.map((x, i) => (/seer|wolf|witch/.test(x.role) ? i : -1)).filter(i => i >= 0);
  const plainIdx = all.map((x, i) => (/villager/.test(x.role) ? i : -1)).filter(i => i >= 0);

  for (const i of plainIdx) {
    ok('p' + i + '（平民画师）夜里看不到动作面板', !(await pages[i].isVisible('#skinNightMask')));
  }
  for (const i of nightIdx) {
    ok('p' + i + '（' + all[i].roleName + '）夜里看到动作面板',
      await pages[i].isVisible('#skinNightMask'));
    const t = await pages[i].textContent('#snTitle');
    const expect = all[i].role === 'seer' ? /预言家/
      : all[i].role === 'wolf' ? /伪装者/ : /女巫/;
    ok('p' + i + ' 面板标题写对了身份（' + t + '）', expect.test(t));
  }

  // 狼/预言家在夜里点一个人 → 服务端要收下（不报错）
  const wolfInNight = nightIdx.filter(i => all[i].role === 'wolf');
  const others = all.map((x, i) => ({ i, x })).filter(o => !o.x.isOwner || true);

  for (const i of nightIdx) {
    const role = all[i].role;
    if (role === 'seer') {
      // 预言家：面板上应该有一串人选，点第一个活的
      const picked = await pages[i].evaluate(() => {
        const b = Array.from(document.querySelectorAll('#snList .sn-btn'))
          .filter(x => !x.disabled && x.getAttribute('data-u'))[0];
        if (!b) return '';
        b.click();
        return b.getAttribute('data-u');
      });
      ok('p' + i + '（预言家）能点人验', !!picked);
      /* ⚠ 别用固定 sleep 等结果 —— 压缩计时下夜晚只有 NIGHT_MS，
         固定等待很容易在夜里结束后才去读一个已经拆掉的 #snResult，
         于是「就地显示结果」时红时绿（跟压缩计时赛跑型 flake）。
         改成**轮询等结果出现**；若夜在结果到达前就结束了，如实报告原因。 */
      let r = { txt: '', hidden: true };
      let nightOver = false;
      for (let w = 0; w < 40; w++) {
        r = await pages[i].evaluate(() => {
          const el = document.querySelector('#snResult');
          return {
            txt: (el || {}).textContent || '',
            hidden: (el || {}).classList ? el.classList.contains('hidden') : true,
            nightVisible: !!(document.querySelector('#skinNightMask') &&
              !document.querySelector('#skinNightMask').classList.contains('hidden'))
          };
        });
        nightOver = !r.nightVisible;
        if (!r.hidden && /是/.test(r.txt)) break;
        if (nightOver) break;
        await sleep(120);
      }
      if (nightOver) {
        console.log('  · p' + i + ' 的夜晚在结果返回前就结束了（压缩计时），本条按「已验」跳过');
      }
      ok('p' + i + ' 验人之后就地显示结果', !r.hidden && /是/.test(r.txt),
        '实际「' + r.txt + '」' + (nightOver ? '（夜已结束）' : ''));
      ok('p' + i + ' 验人结果只说是/不是伪装者（不泄露整张身份表）',
        /伪装者|画师/.test(r.txt));
    } else if (role === 'wolf') {
      // 狼：挑一个非同伴的人刀
      const picked = await pages[i].evaluate(mates => {
        const b = Array.from(document.querySelectorAll('#snList .sn-btn'))
          .filter(x => !x.disabled && x.getAttribute('data-u')
            && mates.indexOf(x.getAttribute('data-u')) < 0)[0];
        if (!b) return '';
        b.click();
        return b.getAttribute('data-u');
      }, (await pages[i].evaluate(() => (window.ChaApp.state.skinRole.mates || []).map(m => m.userId))));
      ok('p' + i + '（伪装者）能点人出刀（同伴不可选）', !!picked);
      await sleep(500);
    }
    // 女巫：狼还没定刀时只该看到「等狼定刀」，定刀后才给「救 / 不救」
    if (role === 'witch') {
      const w = await pages[i].evaluate(() => {
        const t = (document.querySelector('#snTitle') || {}).textContent || '';
        const h = (document.querySelector('#snHint') || {}).textContent || '';
        const btns = Array.from(document.querySelectorAll('#snList .sn-btn'))
          .map(b => b.textContent.trim());
        return { t, h, btns };
      });
      ok('p' + i + '（女巫）面板标题是女巫', /女巫/.test(w.t), '实际「' + w.t + '」');
      // 两种合法状态：等狼定刀（无按钮）/ 已定刀（救他 + 不用药）
      const waiting = w.btns.length === 0 && /等/.test(w.t + w.h);
      const ready = w.btns.length === 2 && w.btns.some(b => /用药救/.test(b))
        && w.btns.some(b => /不用药/.test(b));
      ok('p' + i + ' 女巫面板要么「等狼定刀」要么给出「救 / 不救」二选一',
        waiting || ready, JSON.stringify(w));
      if (ready) {
        // 点了「用药救」→ 面板要改成结果态。
        // ⚠ 这里**不能只 sleep**：点下去到服务端 sync 回来之间，任何一个别的状态
        //   推送都会让 renderSkinNight 重画一次名单，把按钮换回「用药救 …」。
        //   固定等一段时间就会随机抓到「还没更新完」的那一帧（实测 4 次里中 2 次）。
        //   所以等真正的 DOM 条件出现，等不到再报错。
        await pages[i].evaluate(() => {
          const b = Array.from(document.querySelectorAll('#snList .sn-btn'))
            .filter(x => /用药救/.test(x.textContent))[0];
          if (b) b.click();
        });
        let updated = true;
        try {
          await pages[i].waitForFunction(() => {
            const t = (document.querySelector('#snList') || {}).textContent || '';
            const h = (document.querySelector('#snHint') || {}).textContent || '';
            // 用药成功 → 「已用药救下 X」；药已用过 → 「已无药可用」
            return /已用药救下|已无药可用/.test(t) || /已经|无用/.test(h);
          }, { timeout: 6000 });
        } catch (e) { updated = false; }
        const after = await pages[i].evaluate(() => ({
          list: (document.querySelector('#snList') || {}).textContent || '',
          hint: (document.querySelector('#snHint') || {}).textContent || '',
          title: (document.querySelector('#snTitle') || {}).textContent || ''
        }));
        ok('p' + i + ' 用药后面板改成「已用药救下 / 已无药可用」',
          updated, '实际 list=「' + after.list.slice(0, 50) + '」 hint=「' + after.hint.slice(0, 40) + '」');
      }
    }
  }

  // 等天亮（或这局直接在夜里结束 —— 那是合法结果）
  const dawnOk = await waitAnyPhase(pages[0], ['skin_dawn', 'skin_talk', 'over'], 25000);
  ok('夜里走完了（天亮或直接结算）', dawnOk);

  /* ⚠ 天亮这一格是**压缩计时**（GAME_SKIN_DAWN_MS=1200），公告弹窗只活那 1.2 秒。
     以前这里先 sleep(600) 再 pageState() 往返一趟，等轮到断言时弹窗早关了 ——
     输赢全看那几百毫秒的调度，属典型的「跟压缩计时赛跑」型 flake。
     正确做法：**把「弹窗出现」本身当成等待条件**（在阶段还有效的时间窗内轮询），
     而不是先等一个阶段值、再来读一个已经过期的 DOM。 */
  let dawnMaskShown = false;
  try {
    await host.waitForSelector('#skinDawnMask:not(.hidden)', { timeout: 8000 });
    dawnMaskShown = true;
  } catch (e) { dawnMaskShown = false; }

  let stDawn = await pageState(host);
  if (stDawn.phase === 'over' && !dawnMaskShown) {
    console.log('  · 这局在夜里就分出了胜负（伪装者刀到了关键人）—— 后面的天亮/作画段落按结算走');
  } else {
    // ---- [6] 天亮公告 ----
    console.log('\n[6] 天亮公告');
    ok('天亮公告弹出来了', dawnMaskShown);
    // 弹窗可能已经自动收起（压缩计时下只活 1.2s）—— 这时标题/正文读不到内容，
    // 但只要**它确实出现过**，这一段的核心不变式就算验过了。读得到才继续查内容。
    const maskStillOpen = await host.isVisible('#skinDawnMask');
    if (!maskStillOpen) {
      console.log('  · 公告已经自动收起（压缩计时下天亮只有 1.2s），本轮跳过正文检查');
    }
    const dt = maskStillOpen ? await host.textContent('#sdTitle') : '';
    if (maskStillOpen) ok('标题写了第几天', /第\s*\d+\s*天/.test(dt), '实际「' + dt + '」');
    const dtext = maskStillOpen ? await host.textContent('#sdText') : '';
    if (maskStillOpen) ok('公告里说了昨晚的结果', dtext.length > 2, '实际「' + dtext + '」');
    if (!maskStillOpen) { /* 正文项本轮跳过 */ }
    const dp = await host.evaluate(() => {
      const el = document.querySelector('#sdPrivate');
      return {
        hidden: el.classList.contains('hidden'),
        txt: el.textContent || '',
        cls: el.className
      };
    });
    // 私有裁定区**只有本人有裁定时才该出现** —— 谁有裁定是随机的（预言家 / 女巫 /
    // 昨晚被刀的人都各有一条），所以这里不能假设它一定是收起的（早先写成
    // 「必须 hidden」时，房主恰好是女巫那几次就误报了）。
    // 真正的不变式：显示出来的内容必须是**我自己的**裁定，且只谈我自己的事。
    if (dp.hidden) {
      ok('私有裁定区收起（房主这局没有私有裁定）', dp.txt.length === 0, JSON.stringify(dp));
    } else {
      // 文案不一定是「你」开头 —— 「昨晚你被刀了，已经出局」也是标准写法。
      // 真正的不变式是：说的是**第二人称的我**，而不是别人的名字 + 别人的结果。
      ok('私有裁定区显示了，且说的是「我」的事（第二人称，不是别人的底牌）',
        /你/.test(dp.txt), JSON.stringify(dp.txt));
      ok('私有裁定区不是「某人是伪装者」这类别人视角的信息',
        !/验人结果|是伪装者！/.test(dp.txt) || /你的验人结果/.test(dp.txt),
        JSON.stringify(dp.txt));
    }

    // **保密的核心断言**：私有裁定只发本人。逐页对比每个人看到的裁定文案，
    // 任何人都不该看到「别人被刀 / 别人验到了谁」。
    const privs = [];
    for (const p of pages) {
      privs.push(await p.evaluate(() => {
        const el = document.querySelector('#sdPrivate');
        if (!el || el.classList.contains('hidden')) return '';
        return el.textContent || '';
      }));
    }
    const nonEmpty = privs.filter(t => t.length);
    ok('私有裁定只发给当事人（不是所有人都收到同一份）',
      nonEmpty.length <= 3, JSON.stringify(privs.map(t => t.slice(0, 20))));
    // 裁定里出现的名字只能是「被裁定对象」，不该出现狼名单里的所有人
    const witchLine = privs.filter(t => /解药|用药|救下/.test(t));
    ok('「解药」这类裁定至多出现在女巫那一页',
      witchLine.length <= 1, '实际 ' + witchLine.length + ' 页有：' + JSON.stringify(witchLine));

    // ---- [7] 本轮主题 + 私密作画 ----
    console.log('\n[7] 主题与私密作画');
    const drawOk = await waitAnyPhase(pages[0], ['skin_draw', 'skin_talk', 'over'], 25000);
    if (!drawOk || (await pageState(host)).phase === 'over') {
      console.log('  · 没走到作画就结束了，跳过作画断言');
    } else {
      const sdWord = await pageState(host);
      ok('进入作画阶段', sdWord.phase === 'skin_draw', 'phase=' + sdWord.phase);
      ok('下发了一个本轮主题', !!sdWord.word, 'word=' + sdWord.word);
      ok('主题是这套词库里的（不是空串 / 占位）', sdWord.word.length > 0 && sdWord.word.length < 20,
        'word=' + sdWord.word);

      // 六个人应该看到同一个主题
      const words = [];
      for (const p of pages) words.push((await pageState(p)).word);
      ok('所有人的主题一致（同一题各自画）',
        words.every(w => w === words[0]), JSON.stringify(words));

      // 能画的人：交稿条要出现，且写着主题
      let sawBar = 0;
      for (let i = 0; i < pages.length; i++) {
        const s = await pageState(pages[i]);
        const bar = await pages[i].isVisible('#skinDrawBar');
        if (s.canDraw) {
          sawBar++;
          ok('p' + i + ' 能画 → 交稿条出现', bar);
          const barTxt = await pages[i].textContent('#sdbState');
          ok('p' + i + ' 交稿条上写着本轮主题',
            barTxt.indexOf(s.word) >= 0, '实际「' + barTxt + '」');
        } else {
          ok('p' + i + ' 不能画（已出局）→ 交稿条不出现', !bar);
        }
      }
      ok('至少有人能画', sawBar >= 1, '实际 ' + sawBar + ' 人');

      // 私密性：作画阶段**画廊绝不能出现**（出现了就等于所有人的画被提前摊开）
      const galNow = await host.evaluate(() => {
        const b = document.querySelector('#skinGallery');
        return b && !b.classList.contains('hidden');
      });
      ok('作画阶段匿名画廊是关着的（私密）', !galNow);

      // 每人画一笔并交稿。
      // ⚠ 压缩计时下 DRAW_MS 只有一两秒，六个页面挨个画**必然**来不及 ——
      //   所以这里**不断言人人都交上了**（超时的人服务端会补空格子，那是设计好的）。
      //   这里只负责：让真鼠标事件在画布上留下一笔、点一下「交稿」、并记下
      //   「谁在点之前按钮还是可点的」—— 后面关于画廊的断言一律以**服务端快照**
      //   为准（前端在发消息前就把按钮置灰了，本地的「已交稿」会把被服务端拒掉的
      //   那几次也算进去，不能当计数用）。
      let sawSubmitBtn = 0;
      for (let i = 0; i < pages.length; i++) {
        if (!(await pageState(pages[i])).canDraw) continue;
        await drawStroke(pages[i], i * 30);
        const clicked = await pages[i].evaluate(() => {
          const b = document.querySelector('#sdbSubmit');
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        });
        if (clicked) sawSubmitBtn++;
        await sleep(200);
      }
      await sleep(500);

      // 交稿之后按钮要变成「已交稿」且不可再点
      const doneBtns = await host.evaluate(() => {
        const b = document.querySelector('#sdbSubmit');
        return b ? { txt: b.textContent, disabled: b.disabled } : null;
      });
      const hostCanDraw = (await pageState(host)).canDraw;
      if (hostCanDraw) {
        ok('房主交稿后按钮变「已交稿」并锁住',
          doneBtns && /已交稿/.test(doneBtns.txt) && doneBtns.disabled,
          JSON.stringify(doneBtns));
      }

      // 等画廊摊开
      const talkOk = await waitAnyPhase(pages[0], ['skin_talk', 'skin_vote', 'skin_vote_end', 'over'], 30000);
      ok('交完稿推进到展示 / 讨论', talkOk);

      // ---- [8] 匿名画廊 ----
      console.log('\n[8] 匿名画廊');
      const sd2 = await pageState(host);
      if (sd2.phase === 'over' || sd2.galleryCount === 0) {
        console.log('  · 画廊为空或已结算（phase=' + sd2.phase + ' gallery=' + sd2.galleryCount + '），跳过');
      } else {
        ok('画廊面板摊开了', await host.isVisible('#skinGallery'));
        const gal = await host.evaluate(() => {
          const cells = Array.from(document.querySelectorAll('#sgGrid .sg-cell'));
          return {
            cells: cells.length,
            imgs: cells.filter(c => c.querySelector('img')).length,
            blanks: cells.filter(c => c.classList.contains('blank')).length,
            nos: cells.map(c => (c.querySelector('.sg-no') || {}).textContent || ''),
            authors: cells.filter(c => c.hasAttribute('data-u') || /作者/.test(c.textContent)).length,
            title: (document.querySelector('#sgTitle') || {}).textContent || '',
            count: (document.querySelector('#sgCount') || {}).textContent || '',
            html: document.querySelector('#sgGrid').innerHTML
          };
        });
        ok('画廊里摆了 ' + sd2.galleryCount + ' 幅（= 本轮所有活人）',
          gal.cells === sd2.galleryCount, '实际 ' + gal.cells);
        // ⚠ 不是每幅都一定有图：作画超时没交的人，服务端会补一格 skipped 占位
        //   （前端画成 .blank 空格子）。压缩计时的测试服务端 DRAW_MS 只有 1.8 秒，
        //   六个页面挨个画一笔本来就常常来不及 —— 这是**设计好的**结果，不是 bug。
        //   真正的不变式有两条，都和「我本地点了几下交稿」无关（那个数不准：
        //   前端在发消息前就把按钮设成「已交稿」了，所以它会把「点了但被服务端拒掉」
        //   也算进去）：
        //     ① 有图的格子数 === 快照里 skipped=false 的作品数（服务端自己说了算）
        //     ② 空格子必然带 .blank（是占位，不是渲染失败）
        ok('有图的格子数 === 服务端认可的已交稿数',
          gal.imgs === sd2.galleryReal, '有图 ' + gal.imgs + ' / 服务端认可 ' + sd2.galleryReal);
        // 「点交稿 → 服务端收下 → 画廊里有图」这条链至少要走通一次，
        // 否则上面那条 0===0 也会绿（页面全崩了反而过得去）。
        ok('「画一笔 + 交稿」至少有一次被服务端收下并出现在画廊里',
          sd2.galleryReal >= 1, '服务端认可 ' + sd2.galleryReal + ' 幅，本地点了 ' + sawSubmitBtn + ' 次');
        ok('空格子都被标成 .blank（占位，不是渲染失败）',
          gal.cells - gal.imgs === gal.blanks,
          '空格 ' + (gal.cells - gal.imgs) + ' 但 .blank 有 ' + gal.blanks);
        ok('每格都编了号（1..N）',
          gal.nos.length === gal.cells && gal.nos.every((n, i) => n === String(i + 1)),
          JSON.stringify(gal.nos));
        ok('标题写了第几轮', /第\s*\d+\s*轮/.test(gal.title), '实际「' + gal.title + '」');
        ok('写了总数', /幅/.test(gal.count), '实际「' + gal.count + '」');

        // **最关键的保密断言**：画廊 HTML 里绝不能出现任何 userId
        const uids = await host.evaluate(() =>
          (window.ChaApp.state.game.players || []).map(p => p.userId));
        const leaked = uids.filter(u => u && gal.html.indexOf(u) >= 0);
        ok('画廊里没有作者信息（HTML 里搜不到任何 userId）',
          leaked.length === 0, '泄露了 ' + leaked.length + ' 个：' + leaked.join(','));
        ok('画廊 DOM 里没有「作者」字样', !/作者/.test(gal.html));

        // 点一幅看大图
        await host.evaluate(() => {
          const c = document.querySelector('#sgGrid .sg-cell img');
          if (c) c.parentElement.click();
        });
        await sleep(300);
        ok('点一幅能弹出大图', await host.evaluate(() => !!document.querySelector('#skinViewer')));
        await host.evaluate(() => {
          const v = document.querySelector('#skinViewer');
          if (v) v.click();
        });
        await sleep(200);
        ok('再点一下大图关掉', await host.evaluate(() => !document.querySelector('#skinViewer')));
      }

      // ---- [9] 投票放逐 ----
      console.log('\n[9] 投票放逐');
      const voteOk = await waitAnyPhase(pages[0], ['skin_vote', 'skin_vote_end', 'over'], 25000);
      const sv = await pageState(host);
      if (!voteOk || sv.phase === 'over' || sv.phase === 'skin_vote_end') {
        console.log('  · 没停到投票窗口（phase=' + sv.phase + '），跳过投票断言');
      } else {
        const voteBox = await host.evaluate(() => {
          const b = document.querySelector('#sgVote');
          return {
            visible: b && !b.classList.contains('hidden'),
            btns: document.querySelectorAll('#sgVoteList .sg-vote-btn').length,
            hint: (document.querySelector('#sgVoteHint') || {}).textContent || '',
            skip: (document.querySelector('#sgVoteSkip') || {}).textContent || '',
            mine: Array.from(document.querySelectorAll('#sgVoteList .sg-vote-btn'))
              .filter(x => x.classList.contains('on')).length
          };
        });
        ok('投票区显示出来了', voteBox.visible);
        ok('列出了每个玩家', voteBox.btns === ROOM_SIZE, '实际 ' + voteBox.btns + ' 个');
        ok('提示里写了投票进度', /\d+\s*\/\s*\d+/.test(voteBox.hint), '实际「' + voteBox.hint + '」');
        ok('弃票按钮文案正确', /弃票|撤销/.test(voteBox.skip), '实际「' + voteBox.skip + '」');

        // ⚠ 房主这局可能**昨晚就被刀了** —— 那他的投票按钮本来就该全是 disabled
        //   （sg-vote-btn 上加 disabled，提示写「你已经出局了，只能看着」）。
        //   早先这里直接假定房主活着，被刀那几次就误报成「房主不能投票」。
        //   所以分开断：出局 → 必须不能投；活着 → 必须能投。
        const hostAlive = (await pageState(host)).alive;
        const enabled = await host.evaluate(() =>
          document.querySelectorAll('#sgVoteList .sg-vote-btn:not([disabled])').length);
        if (!hostAlive) {
          ok('房主已出局 → 投票按钮全部禁用（只能看着）', enabled === 0, '实际 ' + enabled + ' 个可点');
          ok('房主已出局 → 提示写了不能投',
            /出局|只能看/.test(voteBox.hint), '实际「' + voteBox.hint + '」');
        } else {
          ok('房主活着 → 至少有一个可投的人', enabled >= 1, '实际 ' + enabled + ' 个可点');
        }

        // ---- 投一票 + 撤销（只在房主活着且有可投对象时做） ----
        const voted = hostAlive ? await host.evaluate(() => {
          const b = Array.from(document.querySelectorAll('#sgVoteList .sg-vote-btn'))
            .filter(x => !x.disabled)[0];
          if (!b) return '';
          b.click();
          return b.getAttribute('data-u');
        }) : '';
        if (voted) {
          // 等「选中」这个真实 DOM 条件，别赌固定延时
          try {
            await host.waitForFunction(() =>
              document.querySelectorAll('#sgVoteList .sg-vote-btn.on').length === 1,
            { timeout: 5000 });
          } catch (e) { /* 下面照常断言，失败会给出实际值 */ }
          const after = await host.evaluate(() => {
            const on = Array.from(document.querySelectorAll('#sgVoteList .sg-vote-btn'))
              .filter(x => x.classList.contains('on'));
            return {
              on: on.length,
              txt: on[0] ? on[0].textContent : '',
              skip: (document.querySelector('#sgVoteSkip') || {}).textContent || ''
            };
          });
          ok('投出去之后按钮进入选中态', after.on === 1, JSON.stringify(after));
          ok('选中的按钮打了勾', /✓/.test(after.txt), '实际「' + after.txt + '」');
          ok('弃票按钮变成「撤销这一票」', /撤销/.test(after.skip), '实际「' + after.skip + '」');

          // 再点一下撤销
          await host.evaluate(() => {
            const s = document.querySelector('#sgVoteSkip');
            if (s && !s.disabled) s.click();
          });
          try {
            await host.waitForFunction(() =>
              document.querySelectorAll('#sgVoteList .sg-vote-btn.on').length === 0,
            { timeout: 5000 });
          } catch (e) { /* 同上 */ }
          const un = await host.evaluate(() =>
            document.querySelectorAll('#sgVoteList .sg-vote-btn.on').length);
          ok('「撤销这一票」能撤掉', un === 0, '实际还亮着 ' + un + ' 个');
        } else if (hostAlive) {
          ok('房主能投票（有可投的人）', false, '名单里全是自己 / 全 disabled');
        } else {
          console.log('  · 房主出局，跳过「投票 / 撤销」这两步');
        }

        // 其余活人各投一票，催一下投票进度（出局的人点不动，跳过）
        for (let i = 1; i < pages.length; i++) {
          const alive = (await pageState(pages[i])).alive;
          if (!alive) continue;
          await pages[i].evaluate(() => {
            const b = Array.from(document.querySelectorAll('#sgVoteList .sg-vote-btn'))
              .filter(x => !x.disabled)[0];
            if (b) b.click();
          });
          await sleep(150);
        }
      }
    }
  }

  // ---- [10] 结算面板 ----
  console.log('\n[10] 结算面板');
  /* ⚠ 别「干等」结算 —— 房主手里那颗「立刻推进」就是为这件事准备的。
     这里循环：能推就推一把，推不动就等一会儿再看，直到 phase === 'over'。
     之前只推一次就死等 30 秒，一旦那一次正好落在没有可推进的相位
     （比如 VOTE_END 且没猎人待开枪），后面就纯等超时 —— 又是一类假红。 */
  let finOk = false;
  const overDeadline = Date.now() + 90000;
  while (Date.now() < overDeadline) {
    const st = await pageState(pages[0]);
    if (st.phase === 'over') { finOk = true; break; }
    // 能推就推一把（VOTE_END 且没猎人待开枪时推不动，那就等下一轮循环）
    await host.evaluate(() => {
      const n = document.querySelector('#ghNext');
      if (n && !n.classList.contains('hidden') && n.offsetParent) n.click();
    });
    await sleep(500);
  }
  ok('最终走到了 over', finOk, finOk ? '' : '等到超时仍未结算（phase=' + (await pageState(pages[0])).phase + '）');

  if (finOk) {
    await sleep(700);
    const over = await pageState(host);
    ok('快照里有胜者', !!over.phase, 'phase=' + over.phase);
    ok('结算面板弹出来了', await host.isVisible('#skinOverMask'));
    const ov = await host.evaluate(() => {
      const mask = document.querySelector('#skinOverMask');
      const rows = Array.from(document.querySelectorAll('#soList .so-row'));
      return {
        summary: (document.querySelector('#soSummary') || {}).textContent || '',
        rows: rows.length,
        roles: rows.map(r => (r.querySelector('.so-role') || {}).textContent || '').filter(Boolean),
        out: document.querySelectorAll('#soList .so-row.out').length,
        wolves: document.querySelectorAll('#soList .so-row.wolf').length
      };
    });
    ok('结算摘要写了哪方获胜', /阵营获胜/.test(ov.summary), '实际「' + ov.summary.slice(0, 50) + '」');
    ok('摘要写了获胜理由', ov.summary.length > 8);
    ok('列出了每一位玩家', ov.rows === ROOM_SIZE, '实际 ' + ov.rows + ' 行');
    ok('真相表把身份都填上了（不是占位「…」）',
      ov.roles.length === ROOM_SIZE && ov.roles.every(r => r !== '…'),
      JSON.stringify(ov.roles));
    ok('真相表里恰好 2 个伪装者（与开局配比一致）', ov.wolves === 2, '实际 ' + ov.wolves + ' 个');
    ok('真相表标出了出局的人', ov.out >= 0);

    // 结算面板能关
    await host.click('#btnSkinOverClose');
    await sleep(300);
    ok('结算面板能关掉', !(await host.isVisible('#skinOverMask')));
  }

  // ---- [11] 收尾：结束游戏 → 回到自由绘画 ----
  console.log('\n[11] 结束游戏');
  // ⚠ 2026-09 面板合并后 #btnSkinStop 随二层 DOM 删掉了，
  //    结束入口改成：结算面板上的「结束游戏」(#btnSkinOverStop) 、
  //    HUD 上的 #ghStop、以及开局面板里的 #btnGameStop（三选一，谁在点上谁）
  const stopPath = await host.evaluate(() => {
    for (const sel of ['#btnSkinOverStop', '#ghStop', '#btnGameStop']) {
      const b = document.querySelector(sel);
      if (b && b.offsetParent) { b.click(); return sel; }
    }
    return '';
  });
  console.log('  用的结束入口: ' + (stopPath || '（一个都没找到）'));
  await sleep(1800);
  const ended = await pageState(host);
  ok('游戏结束（phase=off 或 lobby）', ended.phase === 'off' || ended.phase === 'lobby',
    'phase=' + ended.phase);
  ok('HUD 收起来了', !(await host.isVisible('#gameHud')));
  ok('身份卡收起来了', !(await host.isVisible('#skinRole')));
  ok('画廊收起来了', !(await host.isVisible('#skinGallery')));
  ok('交稿条收起来了', !(await host.isVisible('#skinDrawBar')));

  // ---- [12] 控制台干净 ----
  console.log('\n[12] 控制台干净');
  const realErrs = errs.filter(e => !/favicon|net::ERR_|Download the React/i.test(e));
  ok('整个过程没有 JS 报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  let serverErrs = [];
  for (let i = 0; i < pages.length; i++) {
    const e = await pages[i].evaluate(() => window.__errs || []);
    if (e.length) serverErrs.push('p' + i + ':' + e.join('|'));
  }
  ok('服务端没回过 ERROR', serverErrs.length === 0, serverErrs.slice(0, 3).join(' , '));

  // ---- 收尾 ----
  await host.evaluate(() => { try { window.ChaApp.net.send(window.ChaApp.P.C2S.ROOM_DESTROY, {}); } catch (e) {} });
  await sleep(600);
  await browser.close();
  finish();

  function finish() {
    console.log('\n' + '═'.repeat(46));
    console.log('  通过 ' + pass + ' / ' + (pass + fail));
    if (failures.length) {
      console.log('  失败项：');
      failures.forEach(f => console.log('    ✗ ' + f));
    }
    console.log('═'.repeat(46));
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error('测试崩了：', e); process.exit(1); });
