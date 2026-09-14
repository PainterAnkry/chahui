/**
 * 「个人操作不影响别人」+ 本轮那两处界面问题的回归。
 *
 * 1) 个人操作**一条消息都不该发出去**：缩放 / 旋转 / 翻转 / 适应窗口 / 网格 /
 *    导航器 / 侧栏显隐 / 面板显隐 / 界面缩放 / 光标样式 / 参考图 / 尺子 /
 *    对称尺 / 笔刷参数 / 换颜色 / 换工具 / 换当前图层 / 选区全选取消 / 滤镜预览…
 *    （只有光标位置和心跳是允许发的 —— 那两样本来就是临时的在场信息）
 * 2) 子菜单在窗口底部要能点到（以前会掉到屏幕外）
 * 3) 缩放 / 旋转可以直接输入
 *
 * 用法: node tools/test-personal.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

// 允许发出去的：光标位置（远端光标要用）和心跳
const ALLOWED = ['cursor', 'ping', 'pong'];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '隔离');
  await page.fill('#newRoomName', '个人操作隔离');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(900);
  await page.evaluate(() => {
    document.querySelector('#entryMask').classList.add('hidden');
    // 装一个监听：从这一刻起，把发出去的消息全记下来
    const net = window.ChaApp.net;
    window.__sent = [];
    const orig = net.send.bind(net);
    net.send = function (t, p, o) { window.__sent.push({ t: t, keys: p && Object.keys(p) }); return orig(t, p, o); };
  });
  await sleep(300);

  console.log('\n=== 个人操作：一条消息都不该发 ===');
  const acts = [
    ['缩放 +', () => document.querySelector('#qbZoomIn').click()],
    ['缩放 −', () => document.querySelector('#qbZoomOut').click()],
    ['适应窗口', () => document.querySelector('#qbZoomFit').click()],
    ['1:1', () => document.querySelector('#qbZoom100').click()],
    ['向左旋转', () => document.querySelector('#qbRotL').click()],
    ['向右旋转', () => document.querySelector('#qbRotR').click()],
    ['角度归零', () => document.querySelector('#qbRotReset').click()],
    ['水平翻转视图', () => document.querySelector('#qbFlip').click()],
    ['手抖修正 +', () => window.ChaApp.nudgeSteadier(1)],
    ['视图模式切换', () => { const s = document.querySelector('#qbViewMode'); s.value = 'gray'; s.dispatchEvent(new Event('change', { bubbles: true })); }],
    ['收起快捷条', () => document.querySelector('#qbToggle').click()],
    ['展开快捷条', () => document.querySelector('#qbToggle').click()],
    ['网格开关', () => window.ChaApp.toggleGrid()],
    ['导航器开关', () => window.ChaApp.toggleNav()],
    ['隐藏所有面板', () => window.ChaApp.toggleLeftPanel()],
    ['显示所有面板', () => window.ChaApp.toggleLeftPanel()],
    ['隐藏侧栏', () => window.ChaApp.toggleSide()],
    ['显示侧栏', () => window.ChaApp.toggleSide()],
    ['界面缩放 125%', () => window.ChaApp.setUiScale(1.25)],
    ['界面缩放回 100%', () => window.ChaApp.setUiScale(1)],
    ['光标：圆环', () => window.ChaApp.setCursorMode('ring')],
    ['光标：圆点', () => window.ChaApp.setCursorMode('dot')],
    ['光标：智能', () => window.ChaApp.setCursorMode('auto')],
    ['切换光标样式', () => window.ChaApp.cycleCursor()],
    ['隐藏尺子', () => window.ChaApp.toggleRulerVisible(false)],
    ['显示尺子', () => window.ChaApp.toggleRulerVisible(true)],
    ['摆一把直线尺', () => window.ChaApp.commitRuler('line', { x: 200, y: 200 }, { x: 900, y: 500 })],
    ['摆一把同心圆尺', () => window.ChaApp.commitRuler('circle', { x: 600, y: 500 }, { x: 800, y: 500 })],
    ['重置尺子', () => window.ChaApp.clearRuler()],
    ['对称尺：四向', () => window.ChaApp.setSymmetry('quad')],
    ['对称尺：关闭', () => window.ChaApp.setSymmetry('none')],
    ['换笔刷大小', () => { const e = document.querySelector('#sizeRange'); e.value = 99; e.dispatchEvent(new Event('input', { bubbles: true })); }],
    ['换浓度', () => { const e = document.querySelector('#opacityRange'); if (e) { e.value = 0.5; e.dispatchEvent(new Event('input', { bubbles: true })); } }],
    ['换颜色', () => window.ChaApp.engine && document.querySelectorAll('#palette i')[5].click()],
    ['换工具（铅笔）', () => { const b = document.querySelector('#brushGrid .tool[data-item="pencil"]'); b && b.click(); }],
    ['换工具（液化）', () => { const b = document.querySelector('#brushGrid .tool[data-item="liquify"]'); b && b.click(); }],
    ['切换当前图层可见性', () => { const b = document.querySelector('#layerList .ly-vis'); b && b.click(); }],
    ['选区全选', () => window.ChaApp.selectAll()],
    ['取消选区', () => window.ChaApp.selectNone()],
    ['打开色阶（预览不改别人）', () => window.ChaApp.openLevelsDialog()],
    ['拖色阶滑块', () => { const e = document.querySelector('#lvGamma'); e.value = 150; e.dispatchEvent(new Event('input', { bubbles: true })); }],
    ['色阶自动', () => window.ChaApp.levelsAuto()],
    ['取消色阶', () => window.ChaApp.closeLevelsDialog(false)]
  ];
  const leaked = [];
  for (const [name, fn] of acts) {
    const before = await page.evaluate(() => window.__sent.length);
    await page.evaluate((i) => { window.__act = i; }, name);
    await page.evaluate(fn).catch(() => { });
    await sleep(180);
    const added = await page.evaluate(() => window.__sent.slice());
    const news = added.slice(before).filter(m => ALLOWED.indexOf(m.t) < 0);
    if (news.length) leaked.push(name + ' → ' + JSON.stringify(news.map(m => m.t)));
    void added;
  }
  console.log('  一共试了 ' + acts.length + ' 个个人操作');
  if (leaked.length) leaked.forEach(l => console.log('    ✗ ' + l));
  ok('所有个人操作都没有向别人发消息', leaked.length === 0, leaked.join(' | ') || '零泄漏');

  const total = await page.evaluate(() => window.__sent.map(m => m.t));
  console.log('  这期间发出去的全部消息: ' + JSON.stringify(total));

  console.log('\n=== 换当前图层 / 可见性 也不该动别人 ===');
  const layerLeak = await page.evaluate(() => new Promise(resolve => {
    const net = window.ChaApp.net;
    const seen = [];
    const orig = net.send.bind(net);
    net.send = function (t, p) { seen.push(t); return orig(t, p); };
    setTimeout(() => {
      // 只切「我当前在哪一层」，不发任何东西
      const ls = window.ChaApp.engine.layers;
      if (ls.length > 1) window.ChaApp.engine.setActiveLayer(ls[0].id);
      setTimeout(() => { net.send = orig; resolve(seen); }, 400);
    }, 50);
  }));
  ok('切换我的当前图层不发消息', layerLeak.filter(t => ALLOWED.indexOf(t) < 0).length === 0,
    JSON.stringify(layerLeak));

  console.log('\n=== 别人那边看到的还是原样（本地改视图不影响远端笔迹）===');
  const remoteSafe = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    // 本地视图缩放 3 倍 + 旋转 + 翻转之后，文档坐标换算仍然自洽
    e.setZoom(3);
    e.setRotation(0.7);
    if (!e.flipX) e.flipView();
    const doc = { x: 640, y: 480 };
    const s = e.docToScreen(doc.x, doc.y);
    const back = e.screenToDoc(s.x, s.y);
    const err = Math.hypot(back.x - doc.x, back.y - doc.y);
    // 复位
    e.setZoom(1); e.setRotation(0); if (e.flipX) e.flipView();
    return { err: err };
  });
  console.log('  ' + JSON.stringify(remoteSafe));
  ok('视图怎么变，文档坐标换算都自洽（书写坐标不受视图影响）', remoteSafe.err < 0.01,
    '误差 ' + remoteSafe.err.toFixed(6));

  console.log('\n=== 子菜单在窗口底部要能点到 ===');
  const sub = await page.evaluate(() => {
    window.ChaMenu.closeAll();
    // 挑「滤镜」—— 它有三个子菜单，最后那个贴近窗口底部，最容易掉出去
    const t = Array.from(document.querySelectorAll('#menuBar .menu-title'))
      .find(x => /滤镜/.test(x.textContent));
    t.click();
    const drop = t.parentElement.querySelector('.menu-drop');
    // 注意：子菜单是 .menu-row 的**兄弟**（两者都在 .menu-subwrap 里），不是子节点
    const rows = Array.from(drop.querySelectorAll('.menu-row.has-sub'));
    const out = [];
    for (const row of rows) {
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const box = row.parentElement.querySelector('.menu-sub');
      if (!box) { out.push({ label: '（找不到子菜单）', inView: false }); continue; }
      const r = box.getBoundingClientRect();
      out.push({
        label: row.textContent.replace(/[▸]/g, '').trim().slice(0, 8),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        ups: box.classList.contains('up'),
        inView: r.top >= 0 && r.bottom <= (window.innerHeight - 2)
      });
    }
    return { vh: window.innerHeight, subs: out };
  });
  console.log('  窗口高 ' + sub.vh + '，子菜单: ' + JSON.stringify(sub.subs));
  ok('滤镜里能找到子菜单', sub.subs.length >= 3, String(sub.subs.length));
  ok('展开的子菜单都在窗口内（掉不出屏幕）', sub.subs.every(s => s.inView),
    sub.subs.filter(s => !s.inView).map(s => s.label).join(',') || '全都在窗口内');

  // 再挑一个「贴着窗口底部」的菜单试一次
  const sub2 = await page.evaluate(() => {
    window.ChaMenu.closeAll();
    const titles = Array.from(document.querySelectorAll('#menuBar .menu-title'));
    const t = titles.find(x => /滤镜/.test(x.textContent));
    t.click();
    const drop = t.parentElement.querySelector('.menu-drop');
    const rows = Array.from(drop.querySelectorAll('.menu-row.has-sub'));
    rows[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const box = rows[0].parentElement.querySelector('.menu-sub');
    const r = box.getBoundingClientRect();
    const item = box.querySelector('.menu-row');
    const ir = item.getBoundingClientRect();
    // 命中测试：这个子菜单项在不在可点的位置上
    const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
    return { bottom: Math.round(r.bottom), vh: window.innerHeight,
      inside: r.top >= 0 && r.bottom <= window.innerHeight - 2,
      hittable: !!(hit && box.contains(hit)) };
  });
  console.log('  ' + JSON.stringify(sub2));
  ok('滤镜 → 色调调整 的子菜单在窗口内', sub2.inside === true, JSON.stringify(sub2));
  ok('子菜单项真的能被点到（命中测试通过）', sub2.hittable === true, JSON.stringify(sub2));
  await page.evaluate(() => window.ChaMenu.closeAll());

  console.log('\n=== 缩放 / 旋转可以直接输入 ===');
  const z0 = await page.evaluate(() => window.ChaApp.engine.scale);
  await page.evaluate(() => {
    const el = document.querySelector('#qbZoomText');
    el.focus(); el.value = '180%';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await sleep(400);
  const z1 = await page.evaluate(() => ({ scale: window.ChaApp.engine.scale, text: document.querySelector('#qbZoomText').value }));
  console.log('  ' + JSON.stringify({ before: z0, after: z1 }));
  ok('输入 180% 后缩放真的是 1.8', Math.abs(z1.scale - 1.8) < 1e-6, String(z1.scale));
  ok('输入框里显示规范化的百分比', z1.text === '180%', z1.text);

  await page.evaluate(() => {
    const el = document.querySelector('#qbRotText');
    el.focus(); el.value = '45';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await sleep(400);
  const rot = await page.evaluate(() => ({
    deg: Math.round(window.ChaApp.engine.rot * 180 / Math.PI),
    text: document.querySelector('#qbRotText').value
  }));
  console.log('  ' + JSON.stringify(rot));
  ok('输入 45 度后旋转变为 45°', rot.deg === 45, String(rot.deg));
  ok('输入框里显示带度数符号', /45\.0°/.test(rot.text), rot.text);

  await page.evaluate(() => {
    const el = document.querySelector('#qbRotText');
    el.focus(); el.value = '400';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await sleep(400);
  const norm = await page.evaluate(() => Math.round(window.ChaApp.engine.rot * 180 / Math.PI));
  // 400° ≡ 40°（差一整圈），归一化到 -180..180 之间即可
  ok('输入 400 会被归一化到 40°（不会越输越大）', norm === 40, String(norm));

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
