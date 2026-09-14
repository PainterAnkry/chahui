/**
 * 菜单栏与快捷键回归。
 *
 * 守着这几条：
 *   · 九个菜单（文件/编辑/图像/选择/尺子/滤镜/视图/窗口/其他）都在，且每个都有条目
 *   · 任何动作都能在菜单里找到 —— 不允许出现「有功能但菜单里没有」
 *   · 快捷键可改、立刻生效、冲突会被解决（同键只归属一个动作）
 *   · 「全部恢复默认」真的回到默认表
 *   · 焦点在按钮上时，不带修饰键的单键不抢（Enter 应该还是「按下这个按钮」）
 *
 * 用法: node tools/test-menu.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}
// 照 SAI2 的真实菜单来：比原来多了「图层」
const WANT = ['文件', '编辑', '图像', '图层', '选择', '尺子', '滤镜', '视图', '窗口', '其他'];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '菜单');
  await page.fill('#newRoomName', '菜单测试');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(400);

  console.log('\n=== 菜单结构 ===');
  const menus = await page.evaluate(() => Array.from(document.querySelectorAll('#menuBar .menu-title'))
    .map(b => (b.textContent || '').replace(/\([A-Z]\)$/, '')));   // 标题带助记键后缀，先剥掉
  ok('十个菜单都在（含「图层」）', WANT.every(w => menus.indexOf(w) >= 0), menus.join(' / '));
  ok('顺序与 SAI2 一致', menus.join(',') === WANT.join(','), menus.join(','));

  const counts = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#menuBar .menu-item').forEach(function (w) {
      const t = w.querySelector('.menu-title').textContent.replace(/\([A-Z]\)$/, '');
      out[t] = w.querySelectorAll('.menu-drop .menu-row').length;
    });
    return out;
  });
  console.log('  每项条数: ' + JSON.stringify(counts));
  ok('每个菜单都有条目', WANT.every(w => counts[w] > 0));
  const total = Object.values(counts).reduce((a, c) => a + c, 0);
  ok('菜单项总数够用（≥ 70）', total >= 70, total + ' 条');

  const extras = await page.evaluate(() => {
    const bar = document.querySelector('#menuBar');
    return {
      subs: bar.querySelectorAll('.menu-sub').length,
      disabled: bar.querySelectorAll('.menu-row.disabled').length,
      checks: bar.querySelectorAll('.mrow-mark').length,
      mnemonics: (bar.textContent.match(/\([A-Z]\)/g) || []).length
    };
  });
  console.log('  子菜单 ' + extras.subs + ' 个 · 置灰项 ' + extras.disabled + ' 条 · 助记键 ' + extras.mnemonics + ' 个');
  ok('有 ▸ 子菜单（导出 / 画布背景 / 显示操作面板 …）', extras.subs >= 6, String(extras.subs));
  ok('茶绘还没有的功能是「列出来但置灰」', extras.disabled >= 10, String(extras.disabled));
  ok('每项都带助记键 (X)', extras.mnemonics >= 60, String(extras.mnemonics));

  // 顶层工具条上那些按钮，功能都应该能在菜单里找到（不允许「藏起来」）
  const has = await page.evaluate(() => {
    const ids = window.ChaMenu.actions().map(a => a.id);
    return {
      export: ids.indexOf('file.export') >= 0,
      record: ids.indexOf('file.export.webm') >= 0,
      canvas: ids.indexOf('image.size') >= 0,
      layer: ids.indexOf('layer.add') >= 0,
      transform: ids.indexOf('select.transform') >= 0,
      bake: ids.indexOf('layer.bake') >= 0,
      share: ids.indexOf('other.share') >= 0,
      undo: ids.indexOf('edit.undo') >= 0,
      keys: ids.indexOf('edit.keys') >= 0
    };
  });
  console.log('  关键功能: ' + JSON.stringify(has));
  ok('原来顶栏上的功能都进了菜单', Object.values(has).every(Boolean), JSON.stringify(has));

  console.log('\n=== 快捷键 ===');
  const keys = await page.evaluate(() => {
    const out = {};
    window.ChaMenu.actions().forEach(function (a) { if (window.ChaMenu.keyOf(a.id)) out[a.id] = window.ChaMenu.keyOf(a.id); });
    return out;
  });
  ok('有一批默认快捷键（≥ 18）', Object.keys(keys).length >= 18, Object.keys(keys).length + ' 条');
  const dupes = await page.evaluate(() => {
    const seen = {}, dup = [];
    window.ChaMenu.actions().forEach(function (a) {
      const k = window.ChaMenu.keyOf(a.id);
      if (!k) return;
      if (seen[k]) dup.push(k + '(' + seen[k] + ',' + a.id + ')'); else seen[k] = a.id;
    });
    return dup;
  });
  ok('默认表里没有重复键位', dupes.length === 0, dupes.join(' '));

  // 改键立刻生效
  await page.evaluate(() => { window.ChaMenu.setKey('view.zoom100', 'Ctrl+9'); window.ChaMenu.buildMenuBar(); });
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(300);
  const z0 = await page.evaluate(() => window.ChaApp.engine.scale);
  await page.keyboard.press('Control+9');
  await sleep(400);
  const z1 = await page.evaluate(() => window.ChaApp.engine.scale);
  ok('改过的快捷键立刻生效（Ctrl+9 → 100%）', Math.abs(z1 - 1) < 1e-6, z0.toFixed(2) + ' → ' + z1.toFixed(2));

  // 冲突处理
  await page.evaluate(() => { window.ChaMenu.setKey('view.zoomIn', 'Ctrl+9'); window.ChaMenu.buildMenuBar(); });
  const clash = await page.evaluate(() => window.ChaMenu.actions()
    .filter(a => window.ChaMenu.keyOf(a.id) === 'Ctrl+9').map(a => a.id));
  ok('冲突时同一键只归属一个动作', clash.length === 1, clash.join(','));

  console.log('\n=== 快捷键设置对话框 ===');
  await page.evaluate(() => window.ChaMenu.openKeyDialog());
  await sleep(500);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#keyMask').classList.contains('hidden'),
    rows: document.querySelectorAll('#keyBody .key-row').length,
    groups: document.querySelectorAll('#keyBody .key-group').length,
    inputs: document.querySelectorAll('#keyBody .kinput').length
  }));
  console.log('  ' + JSON.stringify(dlg));
  ok('对话框能打开并列出全部可执行动作', dlg.open && dlg.rows > 60 && dlg.inputs === dlg.rows, JSON.stringify(dlg));
  ok('按菜单分组显示', dlg.groups === 10, String(dlg.groups));

  // 在输入框里按键 → 写成新快捷键
  await page.evaluate(() => {
    const inp = document.querySelector('#keyBody .kinput[data-id="view.flip"]');
    inp.click(); inp.focus();
  });
  await page.keyboard.press('Control+Alt+H');
  await page.evaluate(() => document.activeElement.blur());
  await sleep(400);
  const newKey = await page.evaluate(() => window.ChaMenu.keyOf('view.flip'));
  ok('在对话框里按键能写入新快捷键', newKey === 'Ctrl+Alt+H', String(newKey));

  await page.click('#btnKeyReset');
  await sleep(500);
  const restored = await page.evaluate(() => ({
    flip: window.ChaMenu.keyOf('view.flip'),
    zoom100: window.ChaMenu.keyOf('view.zoom100'),
    zoomIn: window.ChaMenu.keyOf('view.zoomIn')
  }));
  ok('「全部恢复默认」把改过的都还原',
    restored.flip === 'H' && restored.zoom100 === 'Ctrl+Alt+0' && restored.zoomIn === '=', JSON.stringify(restored));
  await page.evaluate(() => document.querySelector('#keyMask').classList.add('hidden'));
  await sleep(300);

  console.log('\n=== 不抢交互控件的键盘 ===');
  const beforeT = await page.evaluate(() => !!window.ChaApp.engine.transform);
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'zzTestBtn';
    b.textContent = '按钮';
    document.body.appendChild(b);
    window.__clicked = 0;
    b.addEventListener('click', function () { window.__clicked++; });
    b.focus();
  });
  await page.keyboard.press('Enter');
  await sleep(300);
  const btnRes = await page.evaluate(() => ({
    clicked: window.__clicked,
    transform: !!window.ChaApp.engine.transform
  }));
  console.log('  ' + JSON.stringify(btnRes));
  ok('焦点在按钮上时 Enter 仍然是「按下按钮」', btnRes.clicked >= 1, 'clicked=' + btnRes.clicked);
  ok('焦点在按钮上时 Enter 不会误触发「变换：确定」', btnRes.transform === beforeT);

  console.log('\n=== 点开菜单 ===');
  for (const name of WANT) {
    const opened = await page.evaluate((n) => {
      const t = Array.from(document.querySelectorAll('#menuBar .menu-title')).find(x => x.textContent.replace(/\([A-Z]\)$/, '') === n);
      t.click();
      const w = t.parentElement.querySelector('.menu-drop');
      return !w.classList.contains('hidden');
    }, name);
    if (!opened) ok(name + ' 能展开', false);
  }
  ok('十个菜单都能点开', true);
  await page.evaluate(() => window.ChaMenu.closeAll());
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#menuBar .menu-title')).find(x => x.textContent.replace(/\([A-Z]\)$/, '') === '文件');
    t.click();
  });
  await sleep(300);

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
