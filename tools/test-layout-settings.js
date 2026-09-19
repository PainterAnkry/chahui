/* 布局设置面板专项测试
 * 覆盖：面板能打开 → 六类控件实时生效并落盘 → 刷新后仍然记得 → 两个重置按钮
 * 落盘 key：chahu.leftOpen / chahu.side / chahu.quickbar.collapsed / chahu.colW
 *           chahu.uiscale / chahu.sections / chahu.panelOrder / chahu.panelSides
 * 地址来源与别的测试一致：CLI 参数 > CHAHU_URL > 8440。
 */
const { chromium } = require('./pw');

const URL = (() => {
  const a = process.argv[2];
  if (a && /^https?:\/\//.test(a)) return a.replace(/\/?$/, '/');
  return (process.env.CHAHU_URL || 'http://127.0.0.1:8440/').replace(/\/?$/, '/');
})();
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

let roomNo = 0;
async function join(page) {
  await page.waitForFunction(() => window.ChaApp, { timeout: 15000 });
  try { await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 6000 }); } catch (e) { /* 没弹就算了 */ }
  const joined = await page.evaluate(() => !!(window.ChaApp && window.ChaApp.state && window.ChaApp.state.joined));
  if (!joined) {
    roomNo++;
    await page.fill('#nameInput', '布局设');
    await page.fill('#newRoomName', '布局设置' + roomNo);
    await page.click('#btnCreateRoom');
    await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    const m = document.querySelector('#entryMask');
    if (m) m.classList.add('hidden');
  });
  await page.waitForTimeout(350);
}

/* 清掉所有布局偏好，让每个用例从干净状态起（否则上一轮残留会串味） */
const LAYOUT_KEYS = [
  'chahu.leftOpen', 'chahu.side', 'chahu.quickbar.collapsed', 'chahu.colW',
  'chahu.uiscale', 'chahu.sections', 'chahu.panelOrder', 'chahu.panelSides'
];
async function wipeLayout(page) {
  await page.evaluate((keys) => {
    keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  }, LAYOUT_KEYS);
}

/* 打开面板 → 执行 → 拿面板里各类控件的状态 */
async function openPanel(page) {
  await page.evaluate(() => window.ChaApp.openLayoutSettings());
  await page.waitForTimeout(220);
}
async function readPanel(page) {
  return page.evaluate(() => {
    const box = document.getElementById('layoutSetBody');
    const rows = [...box.querySelectorAll('.ls-row')];
    return {
      visible: !document.getElementById('layoutMask').classList.contains('hidden'),
      groups: [...box.querySelectorAll('.ls-group-h')].map(h => h.textContent),
      rowTitles: rows.map(r => (r.querySelector('.ls-title') || {}).textContent),
      checks: [...box.querySelectorAll('.ls-row:not(.sub) input[type=checkbox]')].map(c => c.checked),
      sliders: [...box.querySelectorAll('.ls-row input[type=range]')].map(r => ({ v: Number(r.value), min: Number(r.min), max: Number(r.max) })),
      scale: (document.querySelector('#layoutSetBody select') || {}).value,
      sub: rows.filter(r => r.classList.contains('sub')).map(r => ({
        name: (r.querySelector('.ls-title') || {}).textContent,
        side: (r.querySelector('select') || {}).value,
        shown: (r.querySelector('input[type=checkbox]') || {}).checked
      }))
    };
  });
}

async function setRange(page, idx, val) {
  await page.evaluate(({ idx, val }) => {
    const r = document.querySelectorAll('#layoutSetBody input[type=range]')[idx];
    r.value = String(val);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  }, { idx, val });
  await page.waitForTimeout(220);
}
async function clickBox(page, idx) {
  await page.evaluate((i) => {
    document.querySelectorAll('#layoutSetBody .ls-row:not(.sub) input[type=checkbox]')[i].click();
  }, idx);
  await page.waitForTimeout(260);
}
async function setSelect(page, sel, val) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel, val });
  await page.waitForTimeout(260);
}
async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await join(page);
  await wipeLayout(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await join(page);

  console.log('\n【一】菜单入口与面板打开');
  // 走真实菜单路径：打开「窗口」的下拉 → 找「布局设置…」那一行
  let menuOk = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('#menuBar .menu-title')]
      .map(t => t.textContent.replace(/\([A-Z]\)$/, '').trim());
    return {
      titles: titles,
      hasApi: typeof window.ChaApp.openLayoutSettings === 'function',
      hasAction: window.ChaMenu ? window.ChaMenu.actions().some(a => a.id === 'window.layoutSet') : false
    };
  });
  ok('ChaApp 暴露了 openLayoutSettings', menuOk.hasApi === true);
  ok('顶栏有「窗口」菜单', menuOk.titles.includes('窗口'), menuOk.titles);
  ok('菜单表里有 window.layoutSet 动作', menuOk.hasAction === true);

  const menuHit = await page.evaluate(() => {
    const item = [...document.querySelectorAll('#menuBar .menu-item')]
      .find(w => w.querySelector('.menu-title').textContent.replace(/\([A-Z]\)$/, '').trim() === '窗口');
    if (!item) return { found: false };
    const row = [...item.querySelectorAll('.menu-drop .menu-row')]
      .find(r => r.textContent.indexOf('布局设置') >= 0);
    if (!row) return { found: false, rows: [...item.querySelectorAll('.menu-drop .menu-row')].map(r => r.textContent.trim()).slice(0, 20) };
    row.click();
    return { found: true, text: row.textContent.trim() };
  });
  await page.waitForTimeout(300);
  ok('窗口菜单里能找到「布局设置…」', menuHit.found === true, menuHit);
  ok('点菜单项真的能开面板',
    menuHit.found && await page.evaluate(() => !document.getElementById('layoutMask').classList.contains('hidden')));

  let p = await readPanel(page);
  ok('面板含 4 个分组', p.groups.length === 4, p.groups);
  ok('分组标题正确', JSON.stringify(p.groups) === JSON.stringify(['面板显隐', '栏宽', '界面缩放', '区块（可拖标题跨栏，也可在这里指定）']), p.groups);
  ok('面板显隐有 3 个开关（左栏/右栏/快捷栏）', p.checks.length === 3, p.checks);
  ok('三个开关默认都是开的', JSON.stringify(p.checks) === JSON.stringify([true, true, true]), p.checks);
  ok('栏宽有 2 个滑块', p.sliders.length === 2, p.sliders);
  ok('滑块范围是 190–520', p.sliders.every(s => s.min === 190 && s.max === 520), p.sliders);
  ok('缩放默认 100%', p.scale === '1', p.scale);
  ok('区块列出 7 个', p.sub.length === 7, p.sub.length);
  ok('区块名用的是中文名', p.sub[0].name === '导航器' && p.sub[6].name === '图层', p.sub.map(s => s.name));

  // 勾选状态必须与「面板实际是不是露着」一致 —— 以前「左侧面板」是反的（开着却显示未勾），
  // 用户一勾反而把本来开着的面板收起来了。这条专门钉住它。
  const consistency = await page.evaluate(() => {
    const box = document.getElementById('layoutSetBody');
    const cbs = [...box.querySelectorAll('.ls-row:not(.sub) input[type=checkbox]')];
    return {
      leftPanelVisible: !document.querySelector('aside.panel.left').classList.contains('hidden'),
      rightPanelVisible: !document.getElementById('sidePanel').classList.contains('hidden'),
      quickBarVisible: !document.getElementById('quickBar').classList.contains('collapsed'),
      checked: cbs.map(c => c.checked)
    };
  });
  ok('左侧面板勾选状态 == 面板真的开着',
    consistency.checked[0] === consistency.leftPanelVisible, consistency);
  ok('右侧面板勾选状态 == 面板真的开着',
    consistency.checked[1] === consistency.rightPanelVisible, consistency);
  ok('快捷栏勾选状态 == 快捷栏真的露着',
    consistency.checked[2] === consistency.quickBarVisible, consistency);

  console.log('\n【二】面板显隐 → 实时生效 + 落盘');
  await clickBox(page, 0);
  let st = await page.evaluate(() => ({
    collapsed: document.querySelector('aside.panel.left').classList.contains('hidden'),
    rectW: Math.round(document.querySelector('aside.panel.left').getBoundingClientRect().width),
    railShown: !document.getElementById('leftRail').classList.contains('hidden'),
    stored: localStorage.getItem('chahu.leftOpen')
  }));
  ok('取消勾选后左栏收起', st.collapsed === true, st);
  ok('左栏收起后宽度为 0（画布接上）', st.rectW < 5, st.rectW);
  ok('左栏左侧露出可点回来的窄条', st.railShown === true);
  ok('chahu.leftOpen 记为 0（要能读回来）', String(st.stored) === '0', st.stored);

  await clickBox(page, 0);
  st = await page.evaluate(() => ({
    collapsed: document.querySelector('aside.panel.left').classList.contains('hidden'),
    stored: localStorage.getItem('chahu.leftOpen')
  }));
  ok('再勾回左栏展开', st.collapsed === false);
  ok('chahu.leftOpen 记为 1', String(st.stored) === '1', st.stored);

  await clickBox(page, 1);
  st = await page.evaluate(() => ({
    collapsed: document.getElementById('sidePanel').classList.contains('hidden'),
    stored: localStorage.getItem('chahu.side')
  }));
  ok('右栏可收起', st.collapsed === true, st);
  ok('chahu.side 记为 0', String(st.stored) === '0', st.stored);
  await clickBox(page, 1);
  st = await page.evaluate(() => document.getElementById('sidePanel').classList.contains('hidden'));
  ok('右栏可再展开', st === false);

  await clickBox(page, 2);
  st = await page.evaluate(() => ({
    cls: document.getElementById('quickBar').className,
    stored: localStorage.getItem('chahu.quickbar.collapsed')
  }));
  ok('快捷栏可收起', /collapsed/.test(st.cls), st.cls);
  ok('chahu.quickbar.collapsed 有记录', st.stored === '1' || st.stored === 'true', st.stored);
  await clickBox(page, 2);
  st = await page.evaluate(() => document.getElementById('quickBar').className);
  ok('快捷栏可再展开', !/collapsed/.test(st), st);

  console.log('\n【三】栏宽滑块 → 实时 + 落盘');
  await setRange(page, 0, 400);
  let lw = await cssVar(page, '--left-w');
  let panelW = await page.evaluate(() => Math.round(document.querySelector('aside.panel.left').getBoundingClientRect().width));
  let colW = await page.evaluate(() => localStorage.getItem('chahu.colW'));
  ok('拖左栏滑块 → --left-w 变 400px', lw === '400px', lw);
  ok('左栏真实宽度跟着变', panelW === 400, panelW);
  ok('chahu.colW 落了 left=400', /"left":400/.test(colW || ''), colW);

  // 数字框同步
  const numTxt = await page.evaluate(() => document.querySelectorAll('#layoutSetBody .ls-num')[0].textContent);
  ok('滑块旁边的数字跟着更新', numTxt === '400px', numTxt);

  await setRange(page, 1, 340);
  const rw = await cssVar(page, '--right-w');
  const rightW = await page.evaluate(() => Math.round(document.querySelector('aside.panel.right').getBoundingClientRect().width));
  colW = await page.evaluate(() => localStorage.getItem('chahu.colW'));
  ok('拖右栏滑块 → --right-w 变 340px', rw === '340px', rw);
  ok('右栏真实宽度跟着变', rightW === 340, rightW);
  ok('chahu.colW 同时留下 left 与 right', /"left":400/.test(colW || '') && /"right":340/.test(colW || ''), colW);

  // 超范围要被夹住
  await setRange(page, 0, 999);
  lw = await cssVar(page, '--left-w');
  ok('超上限被夹到 520', lw === '520px', lw);
  await setRange(page, 0, 10);
  lw = await cssVar(page, '--left-w');
  ok('低于下限被夹到 190', lw === '190px', lw);

  // 画布跟着重排（左栏宽 + 画布宽 ≈ 容器宽）
  const layout = await page.evaluate(() => {
    const wrap = document.getElementById('canvasWrap').getBoundingClientRect();
    return { wrapW: Math.round(wrap.width), winW: innerWidth };
  });
  ok('画布宽度合理（没被栏宽挤没）', layout.wrapW > 300 && layout.wrapW < layout.winW, layout);

  console.log('\n【四】界面缩放');
  await setSelect(page, '#layoutSetBody select', '1.3');
  st = await page.evaluate(() => ({
    zoom: document.getElementById('leftPanelScroll').style.zoom,
    zoomR: document.getElementById('rightPanelScroll').style.zoom,
    varv: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
    stored: localStorage.getItem('chahu.uiscale')
  }));
  ok('选 130% → 左栏 zoom=1.3', st.zoom === '1.3', st.zoom);
  ok('右栏也一起缩放', st.zoomR === '1.3', st.zoomR);
  ok('--ui-scale 同步', st.varv === '1.3', st.varv);
  ok('chahu.uiscale 落盘 1.3', st.stored === '1.3', st.stored);

  // 画布不受影响（顶栏与画布的 zoom 应保持空）
  const canvasZoom = await page.evaluate(() => ({
    canvas: document.getElementById('canvasWrap').style.zoom || '',
    top: (document.querySelector('header.topbar') || {}).style ? document.querySelector('header.topbar').style.zoom : ''
  }));
  ok('画布没有被 zoom（不被糊）', canvasZoom.canvas === '', canvasZoom);

  await setSelect(page, '#layoutSetBody select', '1');
  const back = await page.evaluate(() => document.getElementById('leftPanelScroll').style.zoom);
  ok('选回 100% → zoom 清空', back === '', back);

  console.log('\n【五】区块归属左/右 切换');
  // 第 6 个区块 = 颜色（nav/tools/brushes/brush/fx/color/layers）
  let moved = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#layoutSetBody .ls-row.sub')];
    const row = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '颜色');
    const sw = row.querySelector('select');
    sw.value = 'right';
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({
    inRight: !!document.querySelector('#rightPanelScroll [data-section="color"]'),
    inLeft: !!document.querySelector('#leftPanelScroll [data-section="color"]'),
    sides: localStorage.getItem('chahu.panelSides'),
    rightShown: getComputedStyle(document.getElementById('rightPanelScroll')).display !== 'none',
    rightW: Math.round(document.querySelector('aside.panel.right').getBoundingClientRect().width)
  }));
  ok('颜色小节被搬到右栏', moved && st.inRight === true, st);
  ok('左栏不再有颜色小节', st.inLeft === false);
  ok('chahu.panelSides 记下 color=right', /"color":"right"/.test(st.sides || ''), st.sides);
  ok('右栏有内容就自动展开', st.rightShown === true);
  ok('右栏展开后的宽度 = 面板里设的 340', st.rightW === 340, st.rightW);

  // 面板里的归属下拉要反映最新状态
  p = await readPanel(page);
  const colorRow = p.sub.find(s => s.name === '颜色');
  ok('面板里颜色的归属显示为「右侧」', colorRow && colorRow.side === 'right', colorRow);

  // 搬回来
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#layoutSetBody .ls-row.sub')];
    const row = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '颜色');
    const sw = row.querySelector('select');
    sw.value = 'left';
    sw.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  st = await page.evaluate(() => !!document.querySelector('#leftPanelScroll [data-section="color"]'));
  ok('能把颜色小节搬回左栏', st === true);

  console.log('\n【六】区块显隐');
  // 收起「图层」小节
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#layoutSetBody .ls-row.sub')];
    const row = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '图层');
    row.querySelector('input[type=checkbox]').click();
  });
  await page.waitForTimeout(260);
  st = await page.evaluate(() => ({
    hidden: document.querySelector('[data-section="layers"]').classList.contains('hidden'),
    stored: localStorage.getItem('chahu.sections')
  }));
  ok('取消「图层」勾选 → 小节收起', st.hidden === true, st);
  ok('chahu.sections 记下 layers=0', /"layers":0/.test(st.stored || ''), st.stored);

  p = await readPanel(page);
  ok('面板里图层的「显示」也跟着不勾', p.sub.find(s => s.name === '图层').shown === false);

  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#layoutSetBody .ls-row.sub')];
    const row = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '图层');
    row.querySelector('input[type=checkbox]').click();
  });
  await page.waitForTimeout(260);
  st = await page.evaluate(() => document.querySelector('[data-section="layers"]').classList.contains('hidden'));
  ok('再勾回来 → 小节展开', st === false);

  console.log('\n【七】刷新后所有布局偏好都还在');
  // 造一套非默认布局：左栏 400、右栏 340、缩放 115%、收起 fx 小节、颜色搬右栏、快捷栏收起
  await setRange(page, 0, 400);
  await setRange(page, 1, 340);
  await setSelect(page, '#layoutSetBody select', '1.15');
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#layoutSetBody .ls-row.sub')];
    const r1 = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '效果');
    r1.querySelector('input[type=checkbox]').click();
    const r2 = rows.find(r => (r.querySelector('.ls-title') || {}).textContent === '颜色');
    const sw = r2.querySelector('select');
    sw.value = 'right';
    sw.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(320);
  await clickBox(page, 2);   // 收起快捷栏
  const beforeReload = await page.evaluate(() => {
    const keys = ['chahu.colW', 'chahu.uiscale', 'chahu.sections', 'chahu.panelSides', 'chahu.quickbar.collapsed', 'chahu.leftOpen', 'chahu.side'];
    const o = {};
    keys.forEach(k => { o[k] = localStorage.getItem(k); });
    return o;
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await join(page);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    leftW: Math.round(document.querySelector('aside.panel.left').getBoundingClientRect().width),
    rightW: Math.round(document.querySelector('aside.panel.right').getBoundingClientRect().width),
    zoomL: document.getElementById('leftPanelScroll').style.zoom,
    fxHidden: document.querySelector('[data-section="fx"]').classList.contains('hidden'),
    colorRight: !!document.querySelector('#rightPanelScroll [data-section="color"]'),
    qbCollapsed: /collapsed/.test(document.getElementById('quickBar').className),
    keys: (() => {
      const ks = ['chahu.colW', 'chahu.uiscale', 'chahu.sections', 'chahu.panelSides', 'chahu.quickbar.collapsed'];
      const o = {}; ks.forEach(k => { o[k] = localStorage.getItem(k); }); return o;
    })()
  }));
  ok('刷新后左栏宽恢复 400', after.leftW === 400, after.leftW);
  ok('刷新后右栏宽恢复 340', after.rightW === 340, after.rightW);
  ok('刷新后界面缩放恢复 115%', after.zoomL === '1.15', after.zoomL);
  ok('刷新后「效果」小节仍然收起（修复只写不读）', after.fxHidden === true, after.fxHidden);
  ok('刷新后颜色小节仍在右栏', after.colorRight === true);
  ok('刷新后快捷栏仍收起', after.qbCollapsed === true);
  ok('localStorage 里的值原样保留', JSON.stringify(after.keys) === JSON.stringify({
    'chahu.colW': beforeReload['chahu.colW'],
    'chahu.uiscale': beforeReload['chahu.uiscale'],
    'chahu.sections': beforeReload['chahu.sections'],
    'chahu.panelSides': beforeReload['chahu.panelSides'],
    'chahu.quickbar.collapsed': beforeReload['chahu.quickbar.collapsed']
  }), { before: beforeReload, after: after.keys });

  console.log('\n【八】重置栏宽 / 恢复默认布局');
  await openPanel(page);
  await page.evaluate(() => document.getElementById('btnLayoutResetWidth').click());
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({
    masked: !document.getElementById('layoutMask').classList.contains('hidden'),
    lw: getComputedStyle(document.documentElement).getPropertyValue('--left-w').trim(),
    rw: getComputedStyle(document.documentElement).getPropertyValue('--right-w').trim(),
    inlineL: document.documentElement.style.getPropertyValue('--left-w'),
    colW: localStorage.getItem('chahu.colW'),
    leftW: Math.round(document.querySelector('aside.panel.left').getBoundingClientRect().width),
    fxHidden: document.querySelector('[data-section="fx"]').classList.contains('hidden')
  }));
  ok('重置栏宽后面板不关（方便继续调）', st.masked === true);
  ok('chahu.colW 被清掉', st.colW === null, st.colW);
  ok('inline --left-w 被移除', st.inlineL === '', st.inlineL);
  ok('左栏回到 CSS 默认宽度（<400）', st.leftW < 400 && st.leftW > 100, st.leftW);
  ok('重置栏宽不动区块显隐', st.fxHidden === true, st.fxHidden);

  await page.evaluate(() => document.getElementById('btnLayoutReset').click());
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    hidden: [...document.querySelectorAll('#leftPanelScroll [data-section], #rightPanelScroll [data-section]')]
      .filter(s => s.classList.contains('hidden')).map(s => s.dataset.section),
    zoom: document.getElementById('leftPanelScroll').style.zoom,
    scaleSel: (document.querySelector('#layoutSetBody select') || {}).value,
    maskShown: !document.getElementById('layoutMask').classList.contains('hidden'),
    ls: (() => {
      const ks = ['chahu.colW', 'chahu.sections', 'chahu.panelOrder', 'chahu.panelSides', 'chahu.uiscale'];
      const o = {}; ks.forEach(k => { o[k] = localStorage.getItem(k); }); return o;
    })()
  }));
  ok('恢复默认：7 个小节全回左栏', st.right.length === 0 && st.left.length === 7, st);
  ok('恢复默认：左栏顺序为默认顺序', JSON.stringify(st.left) === JSON.stringify(['nav', 'tools', 'brushes', 'brush', 'fx', 'color', 'layers']), st.left);
  ok('恢复默认：没有收起的小节', st.hidden.length === 0, st.hidden);
  ok('恢复默认：界面缩放回到 100%', st.zoom === '', st.zoom);
  ok('恢复默认：面板里的缩放下拉同步显示 100%', st.scaleSel === '1', st.scaleSel);
  ok('恢复默认：chahu.colW 清空', st.ls['chahu.colW'] === null, st.ls);
  ok('恢复默认：区块归属清空', st.ls['chahu.panelSides'] === '{}' || st.ls['chahu.panelSides'] === null, st.ls['chahu.panelSides']);
  ok('恢复默认后面板仍开着（能接着调）', st.maskShown === true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await join(page);
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    zoom: document.getElementById('leftPanelScroll').style.zoom
  }));
  ok('刷新后仍是默认布局', st.right.length === 0 && st.left.length === 7 && st.zoom === '', st);

  console.log('\n【九】关闭面板的三种方式');
  await openPanel(page);
  await page.evaluate(() => document.getElementById('btnLayoutOk').click());
  await page.waitForTimeout(220);
  ok('「完成」按钮能关面板', await page.evaluate(() => document.getElementById('layoutMask').classList.contains('hidden')));
  await openPanel(page);
  await page.evaluate(() => document.getElementById('btnLayoutClose').click());
  await page.waitForTimeout(220);
  ok('右上角 × 能关面板', await page.evaluate(() => document.getElementById('layoutMask').classList.contains('hidden')));
  await openPanel(page);
  await page.evaluate(() => {
    const m = document.getElementById('layoutMask');
    const r = m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 }));
  });
  await page.waitForTimeout(220);
  ok('点遮罩空白处能关面板', await page.evaluate(() => document.getElementById('layoutMask').classList.contains('hidden')));

  console.log('\n【十】窄屏下不炸');
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.ChaApp.openLayoutSettings());
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({
    maskShown: !document.getElementById('layoutMask').classList.contains('hidden'),
    boxW: Math.round(document.getElementById('layoutSetBody').getBoundingClientRect().width)
  }));
  ok('窄屏（900px）也能打开面板', st.maskShown === true, st);
  ok('面板内容有宽度', st.boxW > 200, st.boxW);
  await page.evaluate(() => document.getElementById('btnLayoutOk').click());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  console.log('\n【十一】页面无 JS 报错');
  ok('没有 pageerror', errs.length === 0, errs.slice(0, 5));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
