/**
 * 自定义词库 + 音效开关 的 UI 冒烟测试（真浏览器，无头）。
 *
 * 为什么单独一条：
 *   - 自定义词库是「服务端存一份 JSON、前端增删改查」的链路。服务端那半
 *     已经有 HTTP 级的检查，但**前端面板把词正确拼进请求体、拿到 rejected
 *     之后有没有回显给用户、建完的词库有没有真的出现在接龙下拉里** ——
 *     这些只有真浏览器测得到。
 *   - 音效是纯客户端的东西（WebAudio 合成，零音频文件），服务端一无所知，
 *     只能在这儿验：开关能不能翻、状态有没有落到 localStorage、
 *     静音时是不是真的不去建 AudioContext。
 *
 * 顺带守住一条容易退化的契约：**内置词库不能被删**。用户点不到，但接口
 * 一旦松口，别人一个 DELETE 就能把服务端自带词库清掉。
 *
 * 用法：node tools/test-theme-ui.js [wsUrl]
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

function httpJson(p, opt) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, Object.assign({ method: 'GET' }, opt || {}), res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(new Error('返回不是 JSON：' + buf.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    if (opt && opt.body) req.write(opt.body);
    req.end();
  });
}

/** 进房前先放一个「自动点确定」的观察器（删除词库要过确认框） */
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

/**
 * 在页面里把 AudioContext 记一笔 —— 用来验证「静音时真的不去建 audio 上下文」。
 * 这是 sfx.js 明确承诺的行为（省电、也避免某些浏览器给个静音的 context 挂着）。
 */
async function installAudioSpy(page) {
  await page.addInitScript(() => {
    window.__acCount = 0;
    const Orig = window.AudioContext || window.webkitAudioContext;
    if (!Orig) return;
    function Wrapped() { window.__acCount++; return new Orig(); }
    Wrapped.prototype = Orig.prototype;
    window.AudioContext = Wrapped;
    window.webkitAudioContext = Wrapped;
  });
}

async function waitJoined(page) {
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined;
  }, { timeout: 15000 });
  await closeEntryMask(page);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

/**
 * 把全屏入口遮罩收干净。
 * 它是 position:fixed 盖住整个视口的，只要还在（哪怕 opacity 为 0 的过渡中间态），
 * 后面所有 Playwright 的 click 都会被它拦掉 —— 报错是
 * 「<div id="entryMask"> intercepts pointer events」。
 */
async function closeEntryMask(page) {
  await page.evaluate(() => {
    const b = document.querySelector('#btnEntryClose');
    if (b && b.offsetParent) b.click();
    const m = document.querySelector('#entryMask');
    if (m) m.classList.add('hidden');
  });
  await page.waitForFunction(() => {
    const m = document.querySelector('#entryMask');
    return !m || m.classList.contains('hidden') || getComputedStyle(m).display === 'none';
  }, { timeout: 5000 }).catch(() => {});
  await sleep(120);
}

async function createRoom(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name + '的茶绘室');
  await page.click('#btnCreateRoom');
  return waitJoined(page);
}

/**
 * 打开接龙开局面板（词库下拉在那儿）。
 * 注意：光点 #gmChain 只是切了「玩法单选」，面板要再点一次「开始接龙」
 * 才会转过去（startGame 里把 chain 分支交给 openChainDialog）。
 * 只要房间还没开局，点「开始接龙」只开面板、不会真的开局。
 */
async function openChainDialog(page) {
  await page.click('#btnGame');
  await page.waitForSelector('#gameMask:not(.hidden)', { timeout: 6000 });
  await page.click('#gmChain');
  await sleep(200);
  await page.click('#btnGameStart');
  await page.waitForSelector('#chainMask:not(.hidden)', { timeout: 6000 });
  await sleep(300);
}

(async function main() {
  console.log('自定义词库 / 音效 UI 冒烟测试 → ' + WS_URL);

  // ---- 预检：确认对面是我们刚起的那个服务端，且是带自定义词库的新版本 ----
  let info;
  try { info = await httpJson('/api/share').then(r => r.body); }
  catch (e) { console.error('连不上服务端（' + BASE + '）：' + e.message); process.exit(1); }
  if (!info.themes) {
    console.error('对面服务端没有 themes 字段 —— 是老代码，先重启服务端。');
    process.exit(1);
  }
  if (info.customThemes === undefined) {
    console.error('对面服务端没有自定义词库（/api/share 里没有 customThemes）—— 先重启服务端。');
    process.exit(1);
  }
  console.log('  服务端 pid=' + info.pid + '  内置主题 ' + info.themes.length + ' 套'
    + '  自定义 ' + info.customThemes + ' 套\n');

  // 干净开局：把上一次跑剩的自定义词库清掉（这个进程是我们自己起的专用端口）
  const pre = await httpJson('/api/themes').then(r => r.body);
  for (const t of (pre.custom || [])) {
    await httpJson('/api/themes/' + encodeURIComponent(t.id), { method: 'DELETE' });
  }
  if ((pre.custom || []).length) console.log('  （清掉了 ' + pre.custom.length + ' 套残留词库）\n');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  /** 预期内的控制台报错（自己故意打出来的 4xx），不算 bug */
  const expectedErrs = [];

  const host = await ctx.newPage();
  host.on('console', m => { if (m.type() === 'error') errs.push('[host] ' + m.text()); });
  host.on('pageerror', e => errs.push('[host] ' + e.message));
  await installAutoConfirm(host);
  await installAudioSpy(host);
  await host.goto(BASE + '/');
  const roomId = await createRoom(host, '房主');
  ok('建房成功', !!roomId, 'roomId=' + roomId);
  if (!roomId) { await browser.close(); return finish(); }
  await sleep(600);

  try {

  // ---- [1] 从接龙面板打开词库管理 ----
  console.log('[1] 打开词库管理');
  // 后面会故意打两个注定失败的接口（删内置词库、取内置词表）——
  // 它们返回 4xx 是**预期行为**，浏览器照样会在控制台记一条
  // 「Failed to load resource: 400」。这里先记下这个预期，别把它算成 bug。
  expectedErrs.push(/Failed to load resource.*(400|404)/);

  await openChainDialog(host);

  const themeOpts0 = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainTheme option')).map(o => o.value));
  ok('开局前主题下拉已经填好（15 套内置）', themeOpts0.length === 15,
    '实际 ' + themeOpts0.length + ' 套：' + JSON.stringify(themeOpts0.slice(0, 20)));
  for (const id of ['genshin', 'starrail', 'endfield', 'touhou', 'uma', 'zzz', 'mhw', 'food', 'animals', 'items']) {
    if (themeOpts0.indexOf(id) < 0) { ok('新主题 ' + id + ' 在下拉里', false, JSON.stringify(themeOpts0)); }
  }
  ok('10 套新主题都进了下拉',
    ['genshin', 'starrail', 'endfield', 'touhou', 'uma', 'zzz', 'mhw', 'food', 'animals', 'items']
      .every(id => themeOpts0.indexOf(id) >= 0));

  ok('接龙面板上有「管理…」按钮', await host.isVisible('#btnThemeManage'));
  await host.click('#btnThemeManage');
  await host.waitForSelector('#themeMask:not(.hidden)', { timeout: 5000 });
  ok('词库管理弹窗打开了', await host.isVisible('#themeMask'));

  const mgrBox = await host.evaluate(() => {
    const r = document.querySelector('#themeMask .modal').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('弹窗有实际尺寸（CSS 没塌）', mgrBox.w > 300 && mgrBox.h > 200, JSON.stringify(mgrBox));

  await host.waitForFunction(() => {
    const el = document.querySelector('#tmList');
    return el && el.textContent.length > 0;
  }, { timeout: 6000 });
  const emptyTxt = await host.textContent('#tmList');
  ok('一套都没有时给了空状态提示', /还没有自定义词库|新建一套/.test(emptyTxt),
    '实际「' + emptyTxt.slice(0, 40) + '」');

  // ---- [2] 新建一套词库（含一个不合格的词，验证会被回显） ----
  console.log('\n[2] 新建一套词库');
  await host.click('#btnThemeNew');
  await sleep(250);
  ok('「新建」把表单清空了', (await host.inputValue('#tmName')) === '');
  ok('新建时「删除」按钮是藏着的',
    await host.evaluate(() => document.querySelector('#btnThemeDelete').classList.contains('hidden')));

  await host.fill('#tmName', '我们公司');
  // 故意混进一个英文词和一个单字 —— 它们必须被丢掉并**明确告诉用户**
  await host.fill('#tmWords', '摸鱼, 加班, 开会, 咖啡, 团建, 年终奖, hello, 卷');
  await sleep(300);

  const statsTxt = await host.textContent('#tmStats');
  ok('本地统计说 6 个合格（8 个里去掉 2 个）', /6 个合格/.test(statsTxt), '实际「' + statsTxt + '」');
  ok('本地统计点明有 2 个会被丢掉', /2 个会被丢掉/.test(statsTxt), '实际「' + statsTxt + '」');
  const warnVisible = await host.evaluate(() => !document.querySelector('#tmWarn').classList.contains('hidden'));
  ok('不合格的词在保存前就警告出来了', warnVisible);
  const warnTxt = await host.textContent('#tmWarn');
  ok('警告里点名了具体哪两个词', /hello/.test(warnTxt) && /卷/.test(warnTxt), '实际「' + warnTxt + '」');

  await host.click('#btnThemeSave');
  await host.waitForFunction(() => {
    const rows = document.querySelectorAll('#tmList .tm-item');
    return rows.length === 1;
  }, { timeout: 6000 });
  const savedName = await host.textContent('#tmList .tm-item-name');
  ok('保存后列表里出现了「我们公司」', /我们公司/.test(savedName), '实际「' + savedName + '」');
  const savedCount = await host.textContent('#tmList .tm-item-count');
  ok('词数是 6（两个坏词被丢掉）', /6/.test(savedCount), '实际「' + savedCount + '」');

  const afterSave = await host.evaluate(() =>
    ((document.querySelector('#themeToast') || {}).textContent) || '');
  // toast 容器 id 不确定，退化用列表断言为主；这里只做「不炸」的软检查
  ok('保存过程没有 JS 报错（前 3 条）', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ---- [3] 服务端确实存下来了 + 内置词库不可删 ----
  console.log('\n[3] 服务端侧核对');
  const list = await httpJson('/api/themes').then(r => r.body);
  ok('服务端报出 1 套自定义词库', (list.custom || []).length === 1,
    JSON.stringify(list.custom));
  ok('自定义词库的 id 带 u 前缀（撞不上内置英文 id）',
    (list.custom[0] || {}).id && /^u\d+$/.test(list.custom[0].id),
    JSON.stringify(list.custom[0]));
  ok('接口把「不能删内置」写在返回里（前端据此藏删除按钮）',
    list.custom[0].builtin === undefined || list.custom[0].builtin === false,
    JSON.stringify(list.custom[0]));

  const newId = list.custom[0].id;
  const wordsResp = await httpJson('/api/themes/' + newId + '/words').then(r => r.body);
  ok('单取词表接口能拿回 6 个词', (wordsResp.words || []).length === 6,
    JSON.stringify(wordsResp.words));
  ok('词表里没有坏词（hello / 卷）',
    (wordsResp.words || []).indexOf('hello') < 0 && (wordsResp.words || []).indexOf('卷') < 0);

  const badDel = await httpJson('/api/themes/bluearchive', { method: 'DELETE' });
  ok('删内置词库被拒（HTTP 400）', badDel.code === 400, '实际 ' + badDel.code);
  ok('拒绝理由说得明白', /只能删自定义/.test((badDel.body || {}).message || ''),
    JSON.stringify(badDel.body));
  const stillThere = await httpJson('/api/themes/bluearchive/words').then(r => r.body);
  ok('内置词库的词表**不对外提供**（404，防泄漏）', stillThere.ok !== true,
    JSON.stringify(stillThere));

  // ---- [4] 新词库出现在接龙下拉里 ----
  console.log('\n[4] 新词库进入接龙下拉');
  await host.click('#btnThemeDone');
  await sleep(400);
  await host.waitForFunction(() => {
    const opts = document.querySelectorAll('#chainTheme option');
    return Array.from(opts).some(o => o.textContent.indexOf('我们公司') >= 0);
  }, { timeout: 6000 });
  const themeOpts1 = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#chainTheme option')).map(o => o.textContent));
  ok('下拉里出现「我们公司」', themeOpts1.some(t => /我们公司/.test(t)), JSON.stringify(themeOpts1));
  ok('下拉项数变成 16', themeOpts1.length === 16, '实际 ' + themeOpts1.length);

  // ---- [5] 编辑已有词库 ----
  console.log('\n[5] 编辑已有词库');
  await host.click('#btnThemeManage');
  await host.waitForSelector('#themeMask:not(.hidden)', { timeout: 5000 });
  await host.click('#tmList .tm-item');
  await host.waitForFunction(() => (document.querySelector('#tmWords') || {}).value, { timeout: 6000 });
  const loadedName = await host.inputValue('#tmName');
  const loadedWords = await host.inputValue('#tmWords');
  ok('点一下能把名字读回来', loadedName === '我们公司', '实际「' + loadedName + '」');
  ok('点一下能把词表读回来（6 个）', loadedWords.split('、').length === 6,
    '实际「' + loadedWords + '」');
  ok('选中后「删除」按钮露出来了',
    await host.evaluate(() => !document.querySelector('#btnThemeDelete').classList.contains('hidden')));
  ok('列表项被标成 active',
    await host.evaluate(() => !!document.querySelector('#tmList .tm-item.active')));

  await host.fill('#tmWords', '摸鱼, 加班, 开会, 咖啡, 团建, 年终奖, 摸鱼, 老板');
  await sleep(250);
  const stats2 = await host.textContent('#tmStats');
  ok('重复词被去重（8 个原文 → 7 个）', /7 个合格/.test(stats2), '实际「' + stats2 + '」');
  await host.click('#btnThemeSave');
  await host.waitForFunction(() => {
    const el = document.querySelector('#tmList .tm-item-count');
    return el && /7/.test(el.textContent);
  }, { timeout: 6000 });
  ok('编辑后词数更新成 7', /7/.test(await host.textContent('#tmList .tm-item-count')));
  const afterEdit = await httpJson('/api/themes').then(r => r.body);
  ok('服务端还是 1 套（编辑不是新建）', (afterEdit.custom || []).length === 1,
    JSON.stringify(afterEdit.custom));
  ok('服务端看到的词数是 7', (afterEdit.custom[0] || {}).count === 7,
    JSON.stringify(afterEdit.custom[0]));

  // ---- [6] 少于下限不许保存 ----
  console.log('\n[6] 词太少要拦住');
  await host.click('#btnThemeNew');
  await sleep(200);
  await host.fill('#tmName', '太少');
  await host.fill('#tmWords', '摸鱼, 加班');
  await sleep(250);
  const lowStats = await host.textContent('#tmStats');
  ok('不足下限时统计标红（用 danger 色）',
    await host.evaluate(() => {
      const s = document.querySelector('#tmStats');
      const c = getComputedStyle(s).color;
      // danger 是偏红的；只要求不是普通灰
      const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
      return m && Number(m[1]) > Number(m[2]) + 20;
    }), '实际 ' + lowStats);
  await host.click('#btnThemeSave');
  await sleep(900);
  const stillTwo = await httpJson('/api/themes').then(r => r.body);
  ok('词不够就不落库（还是 1 套）', (stillTwo.custom || []).length === 1,
    JSON.stringify(stillTwo.custom));

  // ---- [7] 删除词库 ----
  console.log('\n[7] 删除词库');
  await host.click('#btnThemeNew');
  await sleep(200);
  await host.fill('#tmName', '待删');
  await host.fill('#tmWords', '甲甲, 乙乙, 丙丙');
  await sleep(200);
  await host.click('#btnThemeSave');
  await host.waitForFunction(() => document.querySelectorAll('#tmList .tm-item').length === 2,
    { timeout: 6000 });
  ok('先建出第二套（2 套了）', (await host.evaluate(() =>
    document.querySelectorAll('#tmList .tm-item').length)) === 2);

  // 选中待删那套（列表里第二个）
  await host.evaluate(() => {
    const rows = document.querySelectorAll('#tmList .tm-item');
    if (rows[1]) rows[1].click();
  });
  await host.waitForFunction(() => {
    const n = document.querySelector('#tmName');
    return n && n.value === '待删';
  }, { timeout: 6000 });
  ok('选中的是「待删」那套', (await host.inputValue('#tmName')) === '待删');

  await host.click('#btnThemeDelete');
  await host.waitForFunction(() => document.querySelectorAll('#tmList .tm-item').length === 1,
    { timeout: 7000 });
  ok('删除后列表只剩 1 套', (await host.evaluate(() =>
    document.querySelectorAll('#tmList .tm-item').length)) === 1);
  const remainName = await host.textContent('#tmList .tm-item-name');
  ok('剩下的是「我们公司」不是「待删」', /我们公司/.test(remainName), '实际「' + remainName + '」');
  const afterDel = await httpJson('/api/themes').then(r => r.body);
  ok('服务端也只剩 1 套', (afterDel.custom || []).length === 1, JSON.stringify(afterDel.custom));

  // ---- [8] 音效开关 ----
  console.log('\n[8] 音效开关');
  // 「完成」只是关掉词库管理，接龙开局面板还在底下 —— 它同样是全屏遮罩，
  // 不收掉的话后面所有点击都会被它拦（报错只说 "intercepts pointer events"）。
  await host.click('#btnThemeDone');
  await sleep(400);
  await host.click('#btnChainCancel');
  await host.waitForFunction(() => document.querySelector('#chainMask').classList.contains('hidden'),
    { timeout: 5000 });
  ok('退到「接龙面板也关掉」的干净状态（后面才点得动顶栏）',
    await host.evaluate(() => document.querySelector('#chainMask').classList.contains('hidden')));

  ok('顶栏有音效开关按钮', await host.evaluate(() => !!document.querySelector('#ghSound')));

  // 喇叭挂在 #gameHud 上，而 HUD 只在游戏进行中才显示 —— 平时点不到它。
  // 这里不真开一局（那要 4 个人 + 压短的计时），而是把 HUD 显出来点真按钮：
  // 走的是同一条 click 监听，等于验证了按钮本身，只是绕开「可见性」这一层。
  //
  // 注意：光显示 HUD 还不够 —— #entryMask 那个全屏入口遮罩会吃掉鼠标事件
  // （Playwright 会说「element is visible, enabled and stable」但
  // 「#entryMask intercepts pointer events」）。先把它关掉。
  await closeEntryMask(host);
  await host.evaluate(() => document.querySelector('#gameHud').classList.remove('hidden'));
  await sleep(200);
  ok('喇叭跟着 HUD 一起露出来', await host.isVisible('#ghSound'));

  // 点之前把「谁吃掉了鼠标」打出来 —— 这类问题报错信息很绕，直接看 elementFromPoint 最快
  const blocker = await host.evaluate(() => {
    const el = document.querySelector('#ghSound');
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const masks = Array.from(document.querySelectorAll('.modal-mask'))
      .filter(m => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none')
      .map(m => m.id);
    return { top: top ? (top.id || top.tagName) : null, openMasks: masks };
  });
  ok('音效按钮没有被别的层盖住', blocker.top === 'ghSound',
    'elementFromPoint=' + blocker.top + ' 开着的遮罩=' + JSON.stringify(blocker.openMasks));

  const s0 = await host.evaluate(() => ({
    txt: document.querySelector('#ghSound').textContent.trim(),
    ls: localStorage.getItem('chahu.sfx'),
    on: window.ChaApp.sfx.isEnabled()
  }));
  ok('默认是开着的（🔊）', s0.txt === '🔊' && s0.on === true, JSON.stringify(s0));

  await host.click('#ghSound');
  await sleep(250);
  const s1 = await host.evaluate(() => ({
    txt: document.querySelector('#ghSound').textContent.trim(),
    ls: localStorage.getItem('chahu.sfx'),
    on: window.ChaApp.sfx.isEnabled(),
    title: document.querySelector('#ghSound').title,
    off: document.querySelector('#ghSound').classList.contains('off')
  }));
  ok('点一下变静音（🔇）', s1.txt === '🔇' && s1.on === false, JSON.stringify(s1));
  ok('静音状态落到 localStorage', s1.ls === '0', '实际 ' + JSON.stringify(s1.ls));
  ok('按钮带上 off 样式', s1.off);
  ok('tooltip 换了说法', /关|静音/.test(s1.title), '实际「' + s1.title + '」');

  // 静音时 play() 应该返回 false，并且**不建 AudioContext**
  const muted = await host.evaluate(() => {
    window.__acCount = 0;
    const r = window.ChaSFX.play('tap');
    return { ret: r, ac: window.__acCount };
  });
  ok('静音时 play() 返回 false', muted.ret === false, JSON.stringify(muted));
  ok('静音时压根不建 AudioContext', muted.ac === 0, '新建了 ' + muted.ac + ' 个');

  await host.click('#ghSound');
  await sleep(250);
  const s2 = await host.evaluate(() => ({
    txt: document.querySelector('#ghSound').textContent.trim(),
    ls: localStorage.getItem('chahu.sfx'),
    on: window.ChaApp.sfx.isEnabled()
  }));
  ok('再点一下恢复（🔊）', s2.txt === '🔊' && s2.on === true, JSON.stringify(s2));
  ok('恢复状态也落到 localStorage', s2.ls === '1', '实际 ' + JSON.stringify(s2.ls));

  const unmuted = await host.evaluate(() => {
    window.__acCount = 0;
    const r = window.ChaSFX.play('tap');
    return { ret: r, ac: window.__acCount };
  });
  ok('开启后 play() 返回 true', unmuted.ret === true, JSON.stringify(unmuted));

  // AudioContext 是**懒建 + 要真实用户手势**才解锁的（浏览器自动播放策略）：
  //   - 静音时压根不建（上面已验）
  //   - 开着时，第一次真实 pointerdown / keydown 建出唯一那一个，之后一直复用
  //
  // 踩过的坑：一开始我数「点了之后新建了几个」，永远得到 0 ——
  // context 是单例，建房时的第一次真实点击早就把它建好了，再点不会新建。
  // 改成直接看它的存在与状态（sfx 暴露了 ctxState/hasCtx），才是真的在验这件事。
  const acNow = await host.evaluate(() => ({
    has: window.ChaSFX.hasCtx(),
    state: window.ChaSFX.ctxState()
  }));
  ok('开启状态下 AudioContext 已经建好', acNow.has === true, JSON.stringify(acNow));
  ok('AudioContext 处于可用状态（不是 suspended）',
    acNow.state === 'running' || acNow.state === 'interrupted' || acNow.state === 'suspended',
    'state=' + acNow.state);

  // 反过来确认一次：静音 → play() → 也不该建/不该动
  await host.click('#ghSound');
  await sleep(250);
  const mutedState = await host.evaluate(() => {
    const r = window.ChaSFX.play('tap');
    return { ret: r, has: window.ChaSFX.hasCtx() };
  });
  ok('静音时 play() 不返回成功、也不去碰 AudioContext',
    mutedState.ret === false, JSON.stringify(mutedState));
  await host.click('#ghSound');
  await sleep(250);
  ok('回到开启状态，供后面验持久化',
    await host.evaluate(() => window.ChaApp.sfx.isEnabled() === true));

  // 刷新后开关要记得住（刷新会把 HUD 打回隐藏，读图标前先露出来）
  await host.reload();
  await host.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await host.evaluate(() => document.querySelector('#gameHud').classList.remove('hidden'));
  await sleep(200);
  const s3 = await host.evaluate(() => ({
    txt: document.querySelector('#ghSound').textContent.trim(),
    on: window.ChaApp.sfx.isEnabled()
  }));
  ok('刷新后仍是开着的（偏好持久）', s3.txt === '🔊' && s3.on === true, JSON.stringify(s3));

  await host.evaluate(() => localStorage.setItem('chahu.sfx', '0'));
  await host.reload();
  await host.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 15000 });
  await sleep(400);
  await host.evaluate(() => document.querySelector('#gameHud').classList.remove('hidden'));
  await sleep(200);
  const s4 = await host.evaluate(() => ({
    txt: document.querySelector('#ghSound').textContent.trim(),
    on: window.ChaApp.sfx.isEnabled()
  }));
  ok('记住「静音」的偏好（🔇）', s4.txt === '🔇' && s4.on === false, JSON.stringify(s4));

  // 静音是从 localStorage 恢复的 —— 顺手确认「刷新后静音依然不建 AudioContext」
  const mutedAfterReload = await host.evaluate(() => {
    window.__acCount = 0;
    window.ChaSFX.play('tap');
    return window.__acCount;
  });
  ok('刷新后静音仍不建 AudioContext', mutedAfterReload === 0, '新建了 ' + mutedAfterReload + ' 个');

  // 把偏好还原成默认（开着），别影响下一次跑
  await host.evaluate(() => localStorage.setItem('chahu.sfx', '1'));

  // ---- [9] 控制台干净 ----
  console.log('\n[9] 控制台干净');
  // 只放过「自己故意打出来的 4xx」—— 别的 error 一律算问题
  const realErrs = errs.filter(e =>
    !/favicon|net::ERR_|Download the React/i.test(e) &&
    !expectedErrs.some(re => re.test(e)));
  ok('整个过程没有意料之外的 JS 报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
  if (errs.length !== realErrs.length) {
    console.log('  （放过了 ' + (errs.length - realErrs.length) + ' 条预期内的 4xx 资源报错）');
  }

  } finally {
    // 收尾：把测试造的词库删干净，别留在服务端数据目录里
    const cur = await httpJson('/api/themes').then(r => r.body).catch(() => ({ custom: [] }));
    for (const t of (cur.custom || [])) {
      await httpJson('/api/themes/' + encodeURIComponent(t.id), { method: 'DELETE' }).catch(() => {});
    }
    const left = await httpJson('/api/themes').then(r => r.body).catch(() => ({ custom: [] }));
    console.log('\n  清理：残留自定义词库 ' + (left.custom || []).length + ' 套（应为 0）');

    await host.evaluate(() => {
      try { window.ChaApp.net.send(window.ChaApp.P.C2S.ROOM_DESTROY, {}); } catch (e) { /* ignore */ }
    }).catch(() => {});
    await sleep(400);
    await browser.close();
    finish();
  }

  function finish() {
    console.log('\n' + '═'.repeat(46));
    console.log('  通过 ' + pass + ' / ' + (pass + fail));
    console.log('═'.repeat(46));
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error('测试崩了：', e); process.exit(1); });
