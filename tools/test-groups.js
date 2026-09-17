/**
 * 图层组回归。
 *
 * 组是「没有像素的合成单元」：它只有一条规则 —— 组自己的不透明度 / 混合模式，
 * 而且这条规则对组内所有图层**只作用一次**。要是逐层乘下去，「组 50% + 组内 2 层」
 * 会淡成 25%，用户按 50% 的直觉就落空了。这条不成立的话功能等于没做，
 * 所以第 6 组直接去读像素把它钉死（不是看 DOM 里有没有那一行）。
 *
 * 覆盖：
 *   1. 组合：把图层装进新组；组 id / 成员的 groupId 两端一致
 *   2. 面板：组行排在成员之上、成员缩进、组行显示层数
 *   3. 不变式：同一组的图层在数组里永远连续
 *   4. 折叠只影响面板，不影响画布
 *   5. 隐藏整组 = 组内图层都不参与合成（两端一致）
 *   6. 组的不透明度只乘一次（读像素：128；同条件不分组则 191）
 *   7. 组内图层不能靠「上移 / 下移」挪出组；整组能连着一起挪
 *   8. 进 / 出组
 *   9. 头顶栏改的是「选中的组」，不会写到图层上
 *  10. 只对单层有意义的操作在选中组时会明说
 *  11. 解散：组没了，图层留在原位
 *  12. 删除组：连组里的图层一起删；删到一层不剩会被拒
 *  13. 工程文件往返带得上 groups
 *
 * 用法: node tools/test-groups.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8437';

/** 页面里的小工具 */
const HELPERS = () => {
  window.__groups = () => window.ChaApp.engine.groupList();
  window.__layers = () => window.ChaApp.engine.layerList();
  window.__nLayers = () => window.ChaApp.engine.layers.length;
  window.__ids = () => window.ChaApp.engine.layers.map(l => l.id);
  window.__gids = () => window.ChaApp.engine.layers.map(l => l.groupId || null);
  window.__toasts = () => Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' ⏐ ');
  window.__clearToasts = () => { document.querySelectorAll('.toast').forEach(t => t.remove()); };
  /** 面板里有多少行带某个 class */
  window.__count = sel => document.querySelectorAll('#layerList ' + sel).length;
  /** 某个元素在 #layerList 里的 DOM 次序（用来断「组行在成员上面」） */
  window.__rowIndex = sel => {
    const list = document.querySelectorAll('#layerList > *');
    for (let i = 0; i < list.length; i++) if (list[i].matches(sel)) return i;
    return -1;
  };
  window.__groupRowText = gid => {
    const r = document.querySelector('#layerList .group-row[data-group-id="' + gid + '"]');
    return r ? r.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  window.__selTag = () => {
    const e = document.getElementById('layerSelTag');
    return (!e || e.classList.contains('hidden')) ? '' : e.textContent;
  };
  window.__head = () => ({
    lockDis: document.getElementById('lockChk').disabled,
    alphaDis: document.getElementById('alphaLockChk').disabled,
    opacity: Number(document.getElementById('layerOpacity').value),
    blend: document.getElementById('layerBlend').value
  });
  /** 选中某一行 / 某个组行 —— 直接对元素 click()，免得点到行里的眼睛按钮上 */
  window.__pick = id => {
    const r = document.querySelector('#layerList .layer-item[data-id="' + id + '"]');
    if (!r) return false;
    r.click(); return true;
  };
  window.__pickGroup = gid => {
    const r = document.querySelector('#layerList .group-row[data-group-id="' + gid + '"]');
    if (!r) return false;
    r.click(); return true;
  };
  window.__clickIn = (sel, text) => {
    const list = Array.from(document.querySelectorAll(sel));
    const el = text ? list.find(e => e.textContent.trim() === text) : list[0];
    if (!el) return false;
    el.click(); return true;
  };
  /**
   * 不变式：同一组的图层在 engine.layers 里必须连续。
   * 被打破的后果是「同一组被当成两个渲染单元」，组的不透明度就叠了两遍。
   */
  window.__contiguous = () => {
    const L = window.ChaApp.engine.layers;
    const first = {}, last = {}, n = {};
    L.forEach((l, i) => {
      const g = l.groupId; if (!g) return;
      if (first[g] === undefined) first[g] = i;
      last[g] = i; n[g] = (n[g] || 0) + 1;
    });
    for (const g in first) if (last[g] - first[g] + 1 !== n[g]) return false;
    return true;
  };
  /** 组内某一层这一刻该不该画出来 */
  window.__drawable = id => {
    const l = window.ChaApp.engine.getLayer(id);
    return !!l && window.ChaApp.engine.layerDrawable(l);
  };
  window.__visibleMap = () => window.ChaApp.engine.visibleMap();
  window.__units = () => window.ChaApp.engine.renderUnits().map(u => !!u.group);
};

async function waitFor(page, fn, arg, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(120);
  }
  return false;
}
const groupsOf = p => p.evaluate(() => window.__groups());
const waitGroups = (p, n, ms) => waitFor(p, k => window.__groups().length === k, n, ms);
const waitLayers = (p, n, ms) => waitFor(p, k => window.__nLayers() === k, n, ms);
/** 两端都等：单端等完另一端可能还没推送到 */
async function waitBoth(a, b, fn, arg, ms) {
  return (await waitFor(a, fn, arg, ms)) && (await waitFor(b, fn, arg, ms));
}
const metaOf = async (p, id) => (await p.evaluate(() => window.__layers())).find(l => l.id === id) || null;

async function createRoom(page, nick, roomName, w, h) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.evaluate(([a, b]) => {
    const s = document.querySelector('#newRoomSize');
    if (s) {
      let hit = false;
      for (const o of s.options) if (o.value === a + 'x' + b) hit = true;
      if (!hit) { const o = document.createElement('option'); o.value = a + 'x' + b; o.textContent = a + '×' + b; s.appendChild(o); }
      s.value = a + 'x' + b;
    }
  }, [w, h]);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(400);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function join(page, room, nick) {
  await page.addInitScript(n => {
    try { localStorage.setItem('chahu.name', n); } catch (e) { /* ignore */ }
  }, nick);
  await page.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(500);
  const got = await page.evaluate(() => window.ChaApp.state.me.name);
  if (got !== nick) throw new Error('进房昵称没生效：期望 ' + nick + '，实际 ' + got);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const mkPage = async () => {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    return p;
  };
  const A = await mkPage();
  const B = await mkPage();

  const room = await createRoom(A, '甲', '图层组回归', 600, 800);
  await join(B, room, '乙');
  console.log('\n房间 ' + room + '（画布 600×800）已就绪：甲=房主，乙=成员');

  /* ================= 1) 组合：装进新组 ================= */
  console.log('\n=== 1) 组合：把图层装进新组 ===');
  await A.evaluate(() => window.ChaApp.addLayer());
  ok('新建图层两端都到齐', await waitBoth(A, B, () => window.__nLayers() === 2, null, 6000),
    '甲=' + (await A.evaluate(() => window.__nLayers())) + ' 乙=' + (await B.evaluate(() => window.__nLayers())));
  const ids0 = await A.evaluate(() => window.__ids());
  const [idLow, idTop] = ids0;                 // idTop 在合成顺序里更靠上
  ok('新图层加在最上面（数组末尾）', ids0.length === 2);

  // 包住**上面**那一层 → 组落在 index 1，底下留着 idLow 这一层不分组。
  // 这个摆位是刻意的：后面「组内不能挪出去」要的是一个不贴边的组。
  await A.evaluate(id => window.__pick(id), idTop);
  await A.evaluate(() => window.__clearToasts());
  await A.evaluate(() => window.ChaApp.groupAdd());
  ok('组合后两端都出现 1 个组', await waitBoth(A, B, () => window.__groups().length === 1, null, 6000),
    '甲=' + JSON.stringify(await groupsOf(A)) + ' 乙=' + JSON.stringify(await groupsOf(B)));

  const gA = await groupsOf(A), gB = await groupsOf(B);
  const gid = (gA[0] || {}).id;
  ok('组 id 两端一致（客户端指定、服务端采纳）', !!gid && (gB[0] || {}).id === gid, gid);
  const mA = await metaOf(A, idTop), mB = await metaOf(B, idTop);
  ok('被装进去的那层 groupId 两端都指向这个组',
    mA && mA.groupId === gid && mB && mB.groupId === gid,
    (mA && mA.groupId) + ' / ' + (mB && mB.groupId));
  ok('没被选中的那层没被顺手塞进去',
    (await metaOf(A, idLow)).groupId === null);
  ok('组行显示「1 层」', (gA[0] || {}).count === 1, JSON.stringify(gA[0]));
  ok('组行有名字', !!(gA[0] && gA[0].name), gA[0] && gA[0].name);

  /* ================= 2) 面板结构 ================= */
  console.log('\n=== 2) 面板：组行在成员之上、成员缩进 ===');
  ok('面板里有 1 个组行', await A.evaluate(() => window.__count('.group-row')) === 1);
  ok('组内那一行带 in-group 缩进', await A.evaluate(() => window.__count('.in-group')) === 1);
  const gi = await A.evaluate(g => window.__rowIndex('.group-row[data-group-id="' + g + '"]'), gid);
  const mi = await A.evaluate(id => window.__rowIndex('.layer-item[data-id="' + id + '"]'), idTop);
  ok('组行排在成员行上面', gi >= 0 && mi >= 0 && gi < mi, '组行#' + gi + ' 成员行#' + mi);
  const growText = await A.evaluate(g => window.__groupRowText(g), gid);
  ok('组行显示「N 层」和「组」标记', /1 层/.test(growText || '') && /组/.test(growText || ''), growText);
  ok('建完就选中了这个组（头顶栏显示「正在编辑」）',
    /正在编辑/.test(await A.evaluate(() => window.__selTag())),
    await A.evaluate(() => window.__selTag()));
  ok('组行在数组里的顺序 = 面板顺序的倒转（idLow 在下面）',
    gi < mi && (await A.evaluate(() => window.__ids())).join() === [idLow, idTop].join());

  /* ================= 3) 不变式 ================= */
  console.log('\n=== 3) 不变式：同组图层在数组里连续 ===');
  ok('甲：连续', await A.evaluate(() => window.__contiguous()));
  ok('乙：连续', await B.evaluate(() => window.__contiguous()));

  /* ================= 4) 折叠只影响面板 ================= */
  console.log('\n=== 4) 折叠只影响面板，不影响画布 ===');
  await A.evaluate(g => window.__clickIn('#layerList .group-row[data-group-id="' + g + '"] .fold'), gid);
  ok('折叠状态推到了另一端', await waitFor(B, g => {
    const gs = window.__groups(); return gs.length === 1 && gs[0].collapsed === true;
  }, gid, 6000), JSON.stringify(await groupsOf(B)));
  ok('折叠后成员行从面板上消失', await A.evaluate(() => window.__count('.in-group')) === 0);
  ok('折叠后画布上照样合成（组仍在渲染单元里）',
    (await A.evaluate(() => window.__units())).indexOf(true) >= 0);
  ok('折叠后组内那一层仍然「该画」', await A.evaluate(id => window.__drawable(id), idTop));
  await A.evaluate(g => window.__clickIn('#layerList .group-row[data-group-id="' + g + '"] .fold'), gid);
  ok('再点一次展开，成员行回来',
    await waitBoth(A, B, () => window.__groups()[0].collapsed === false, null, 6000)
    && await A.evaluate(() => window.__count('.in-group')) === 1);

  /* ================= 5) 隐藏整组 ================= */
  console.log('\n=== 5) 隐藏整组 = 组内图层都不参与合成 ===');
  await A.evaluate(g => window.__clickIn('#layerList .group-row[data-group-id="' + g + '"] .eye'), gid);
  ok('组的隐藏状态推到了另一端', await waitBoth(A, B, () => window.__groups()[0].visible === false, null, 6000));
  ok('甲：组内那一层不再参与合成', !(await A.evaluate(id => window.__drawable(id), idTop)));
  ok('乙：口径一致（不是只有本机这样）', !(await B.evaluate(id => window.__drawable(id), idTop)));
  ok('乙的 visibleMap 也认组', await B.evaluate(id => window.__visibleMap()[id] === false, idTop));
  ok('组外那一层不受影响', await A.evaluate(id => window.__drawable(id), idLow));
  await A.evaluate(g => window.__clickIn('#layerList .group-row[data-group-id="' + g + '"] .eye'), gid);
  ok('恢复显示', await waitBoth(A, B, () => window.__groups()[0].visible === true, null, 6000)
    && await A.evaluate(id => window.__drawable(id), idTop));

  /* ================= 6) 组的不透明度只乘一次（读像素） ================= */
  console.log('\n=== 6) 组的不透明度只乘一次（读像素）===');
  // 另开一个页面单独造静态场景 —— 这段要直接改本地的图层像素，会和服务端对不上，
  // 放在甲/乙身上会把后面的断言搅乱。
  const C = await mkPage();
  await createRoom(C, '丙', '组像素对照', 200, 200);
  const px = await C.evaluate(() => {
    const e = window.ChaApp.engine;
    const gid2 = 'G_PX_TEST';
    const ids = ['L_PX_1', 'L_PX_2'];
    // 两层都铺满不透明纯黑；先进组，组浓度 50%
    e.setLayers([
      { id: ids[0], name: 'A', visible: true, opacity: 1, locked: false, alphaLock: false, blend: 'normal', groupId: gid2, baseSeq: 0 },
      { id: ids[1], name: 'B', visible: true, opacity: 1, locked: false, alphaLock: false, blend: 'normal', groupId: gid2, baseSeq: 0 }
    ], null, [{ id: gid2, name: 'G', visible: true, opacity: 0.5, blend: 'normal', collapsed: false }]);
    ids.forEach(id => {
      const c = e.getLayer(id).canvas.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#000000'; c.fillRect(0, 0, e.width, e.height);
    });
    const sample = () => {
      const out = e.renderDocument({ transparentBackground: true, includeActive: false });
      return out.ctx.getImageData(Math.round(e.width / 2), Math.round(e.height / 2), 1, 1).data[3];
    };
    const grouped = sample();                       // 组 50%，组内两层都全不透明 → 期望 128
    // 对照：同样的两层不分组、各自 50% → 期望 191
    e.setGroups([]);
    e.layers.forEach(l => { l.groupId = null; l.opacity = 0.5; });
    const loose = sample();
    // 再对照：不分组、都不透明 → 255
    e.layers.forEach(l => { l.opacity = 1; });
    const solid = sample();
    return { grouped, loose, solid };
  });
  ok('组 50% + 组内两层全不透明 → 128（组只乘了一次）',
    Math.abs(px.grouped - 128) <= 2, px.grouped);
  ok('同样的两层不分组、各自 50% → 191（对照，证明 128 不是「因为只有一层」）',
    Math.abs(px.loose - 191) <= 3, px.loose);
  ok('不分组且全不透明 → 255（基线）', px.solid === 255, px.solid);
  ok('组的合成结果明显比逐层相乘更「实」', px.grouped < px.loose);
  ok('丙页面没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' ⏐ '));
  await C.close();

  /* ================= 7) 组内挪不出去 / 整组一起挪 ================= */
  console.log('\n=== 7) 组内图层挪不出组；整组连着挪 ===');
  await A.evaluate(id => window.__pick(id), idTop);
  await A.evaluate(() => window.__clearToasts());
  await A.evaluate(() => window.__clickIn('#btnLayerDown'));
  await sleep(400);
  ok('组内最下面那层点「下移」：明说不能靠它出组',
    /已经在组的最下面/.test(await A.evaluate(() => window.__toasts())),
    await A.evaluate(() => window.__toasts()));
  ok('并且真的没挪（顺序没变）',
    (await A.evaluate(() => window.__ids())).join() === [idLow, idTop].join(),
    JSON.stringify(await A.evaluate(() => window.__ids())));

  await A.evaluate(g => window.__pickGroup(g), gid);
  await A.evaluate(() => window.__clickIn('#btnLayerDown'));   // 选中组 → 整组下移
  ok('整组下移一格：组整个换到了下面（两组图层次序互换）',
    await waitBoth(A, B, k => window.__ids().join() === k, [idTop, idLow].join(), 6000),
    JSON.stringify(await A.evaluate(() => window.__ids())));
  ok('挪完之后仍然连续', await A.evaluate(() => window.__contiguous()) && await B.evaluate(() => window.__contiguous()));

  await A.evaluate(g => window.__pickGroup(g), gid);
  await A.evaluate(() => window.__clickIn('#btnLayerUp'));     // 挪回来
  ok('再挪回来', await waitBoth(A, B, k => window.__ids().join() === k, [idLow, idTop].join(), 6000));

  // 现在组在下面（span [0,0]），上面那一层是散着的 → 「上移」会撞到组的上沿
  await A.evaluate(g => window.__pickGroup(g), gid);
  await A.evaluate(() => window.__clickIn('#btnLayerDown'));   // 到最底了
  await waitBoth(A, B, k => window.__ids().join() === k, [idTop, idLow].join(), 6000);
  await A.evaluate(id => window.__pick(id), idTop);
  await A.evaluate(() => window.__clearToasts());
  await A.evaluate(() => window.__clickIn('#btnLayerUp'));
  await sleep(400);
  ok('组内最上面那层点「上移」：同样明说',
    /已经在组的最上面/.test(await A.evaluate(() => window.__toasts())),
    await A.evaluate(() => window.__toasts()));
  await A.evaluate(g => window.__pickGroup(g), gid);
  await A.evaluate(() => window.__clickIn('#btnLayerUp'));
  ok('把组挪回上面，回到初始次序',
    await waitBoth(A, B, k => window.__ids().join() === k, [idLow, idTop].join(), 6000));

  /* ================= 8) 进 / 出组 ================= */
  console.log('\n=== 8) 进 / 出组 ===');
  await A.evaluate(id => window.__pick(id), idLow);
  await A.evaluate(() => window.__clickIn('#btnGroupToggle'));
  ok('下面那层被挪进了它上面那个组（组内 2 层）',
    await waitBoth(A, B, () => window.__groups()[0].count === 2, null, 6000),
    JSON.stringify(await groupsOf(A)));
  ok('两层都指向这个组',
    (await metaOf(A, idLow)).groupId === gid && (await metaOf(B, idLow)).groupId === gid);
  ok('进组后仍然连续', await A.evaluate(() => window.__contiguous()) && await B.evaluate(() => window.__contiguous()));

  await A.evaluate(id => window.__pick(id), idLow);
  await A.evaluate(() => window.__clickIn('#btnGroupToggle'));
  ok('再点一次就出组（组内回到 1 层）',
    await waitBoth(A, B, () => window.__groups()[0].count === 1, null, 6000),
    JSON.stringify(await groupsOf(A)));
  ok('出组后 groupId 清空（两端）',
    (await metaOf(A, idLow)).groupId === null && (await metaOf(B, idLow)).groupId === null);
  ok('出组后仍然连续', await A.evaluate(() => window.__contiguous()));

  /* ================= 9) 头顶栏改的是组 ================= */
  console.log('\n=== 9) 头顶栏改的是「选中的组」，不写到图层上 ===');
  await A.evaluate(g => window.__pickGroup(g), gid);
  const head = await A.evaluate(() => window.__head());
  ok('锁定 / 保护不透明度被禁用（组没有这两样）', head.lockDis && head.alphaDis, JSON.stringify(head));
  ok('头顶栏显示的是组的浓度', head.opacity === 100, head.opacity);
  ok('头顶栏显示的是组的混合模式', head.blend === 'normal', head.blend);

  await A.evaluate(() => {
    const el = document.getElementById('layerOpacity');
    el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ok('改浓度：改到的是组（两端）',
    await waitBoth(A, B, () => window.__groups()[0].opacity === 0.5, null, 6000),
    JSON.stringify(await groupsOf(B)));
  ok('组内图层自己的浓度没被动过', (await metaOf(B, idTop)).opacity === 1,
    (await metaOf(B, idTop)).opacity);

  await A.evaluate(() => {
    const el = document.getElementById('layerBlend');
    el.value = 'multiply';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  ok('改混合模式：改到的是组（两端）',
    await waitBoth(A, B, () => window.__groups()[0].blend === 'multiply', null, 6000),
    JSON.stringify(await groupsOf(B)));
  ok('组内图层的混合模式没被动过', (await metaOf(B, idTop)).blend === 'normal');

  await A.evaluate(() => {
    const o = document.getElementById('layerOpacity'); o.value = '100';
    o.dispatchEvent(new Event('input', { bubbles: true }));
    const b = document.getElementById('layerBlend'); b.value = 'normal';
    b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitBoth(A, B, () => window.__groups()[0].opacity === 1 && window.__groups()[0].blend === 'normal', null, 6000);

  /* ================= 10) 只对单层有效的操作会明说 ================= */
  console.log('\n=== 10) 选中组时，「复制 / 清除 / 合并」会明说 ===');
  const nL = await A.evaluate(() => window.__nLayers());
  for (const [btn, label] of [['#btnLayerDup', '复制图层'], ['#btnLayerMerge', '向下合并'], ['#btnLayerClear', '清除图层']]) {
    await A.evaluate(() => window.__clearToasts());
    await A.evaluate(s => window.__clickIn(s), btn);
    await sleep(350);
    ok('点' + label + '：提示「只对单个图层有效」',
      /只对单个图层有效/.test(await A.evaluate(() => window.__toasts())),
      await A.evaluate(() => window.__toasts()));
  }
  ok('这几次点击都没真的改动图层表',
    (await A.evaluate(() => window.__nLayers())) === nL && (await B.evaluate(() => window.__nLayers())) === nL);

  /* ================= 11) 工程文件往返 ================= */
  console.log('\n=== 11) 工程文件往返带得上 groups ===');
  const proj = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const doc = window.ChahuProject.capture(e, { name: '组往返' });
    const back = window.ChahuProject.parse(window.ChahuProject.stringify(doc));
    return {
      n: back.doc.groups.length,
      gid: (back.doc.groups[0] || {}).id,
      layerGid: (back.doc.layers.find(l => l.groupId) || {}).groupId,
      desc: window.ChahuProject.describe(back),
      version: window.ChahuProject.VERSION,
      gotVersion: back.version,
      nLayers: back.doc.layers.length
    };
  });
  ok('往返后组还在（1 个）', proj.n === 1, JSON.stringify(proj));
  ok('组 id 原样保留', proj.gid === gid, proj.gid + ' / ' + gid);
  ok('成员的 groupId 也保留', proj.layerGid === gid, proj.layerGid);
  ok('没有因为加了组就抬版本号（老客户端打开画面照样对）',
    proj.version === 1 && proj.gotVersion === 1, proj.gotVersion);
  ok('describe 里写了组数', /1 个图层组/.test(proj.desc), proj.desc);

  /* ================= 12) 解散 ================= */
  console.log('\n=== 12) 解散：组没了，图层留在原位 ===');
  await A.evaluate(g => window.__pickGroup(g), gid);
  await A.evaluate(() => window.__clickIn('#layerList .group-row .rowbtn', '解散'));
  ok('组没了（两端）', await waitBoth(A, B, () => window.__groups().length === 0, null, 6000),
    JSON.stringify(await groupsOf(B)));
  ok('图层一个都没少', (await A.evaluate(() => window.__nLayers())) === nL && (await B.evaluate(() => window.__nLayers())) === nL);
  ok('组内那层的 groupId 清空了（两端）',
    (await metaOf(A, idTop)).groupId === null && (await metaOf(B, idTop)).groupId === null);
  ok('画布上那层还在（解散不是删除）', await A.evaluate(id => window.__drawable(id), idTop));

  /* ================= 13) 删除组：连内容一起删；删空了会被拒 ================= */
  console.log('\n=== 13) 删除组及其内容 ===');
  await A.evaluate(id => window.__pick(id), idTop);
  await A.evaluate(() => window.ChaApp.groupAdd());
  ok('（重建）两端又出现 1 个组', await waitBoth(A, B, () => window.__groups().length === 1, null, 6000));
  const gid2 = (await groupsOf(A))[0].id;
  await A.evaluate(g => window.__pickGroup(g), gid2);
  await A.evaluate(() => { window.ChaApp.groupDelWithLayers(); });   // 不 await：它要等确认框
  await A.waitForSelector('#confirmMask:not(.hidden)', { timeout: 6000 });
  await A.click('#confirmYes');
  ok('组和组里的图层一起没了（两端都只剩 1 层）',
    await waitBoth(A, B, () => window.__groups().length === 0 && window.__nLayers() === 1, null, 6000),
    '甲: ' + JSON.stringify(await groupsOf(A)) + ' ' + (await A.evaluate(() => window.__nLayers())) +
    ' 乙: ' + (await B.evaluate(() => window.__nLayers())));
  ok('剩下的是没进组的那个', (await A.evaluate(() => window.__ids()))[0] === idLow);

  const lastId = idLow;
  await A.evaluate(id => window.__pick(id), lastId);
  await A.evaluate(() => window.ChaApp.groupAdd());
  ok('（重建）把最后一层装进组', await waitBoth(A, B, () => window.__groups().length === 1, null, 6000));
  const gid3 = (await groupsOf(A))[0].id;
  await A.evaluate(() => window.__clearToasts());
  await A.evaluate(g => window.__pickGroup(g), gid3);
  await A.evaluate(() => { window.ChaApp.groupDelWithLayers(); });
  await A.waitForSelector('#confirmMask:not(.hidden)', { timeout: 6000 });
  await A.click('#confirmYes');
  await sleep(900);
  ok('删到一层都不剩时被服务端拒掉（不能把房子拆没）',
    /至少要保留一个图层/.test(await A.evaluate(() => window.__toasts())),
    await A.evaluate(() => window.__toasts()));
  ok('被拒之后房间保持原样：组还在、那一层还在',
    (await A.evaluate(() => window.__groups().length)) === 1 && (await A.evaluate(() => window.__nLayers())) === 1);
  // 收尾：解散掉，别把状态留在组里
  await A.evaluate(g => window.__pickGroup(g), gid3);
  await A.evaluate(() => window.__clickIn('#layerList .group-row .rowbtn', '解散'));
  ok('收尾：解散成功', await waitBoth(A, B, () => window.__groups().length === 0, null, 6000));

  /* ================= 14) 观众看到的是同一份组 ================= */
  console.log('\n=== 14) 新来的人也能看到组（入房就带 groups）===');
  await A.evaluate(id => window.__pick(id), lastId);
  await A.evaluate(() => window.ChaApp.groupAdd());
  await waitBoth(A, B, () => window.__groups().length === 1, null, 6000);
  const gid4 = (await groupsOf(A))[0].id;
  await A.evaluate(() => {
    const el = document.getElementById('layerBlend');
    el.value = 'multiply';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitBoth(A, B, () => window.__groups()[0].blend === 'multiply', null, 6000);

  const D = await mkPage();
  await join(D, room, '丁');
  const gD = await groupsOf(D);
  ok('刚进房的人看得到这个组', gD.length === 1 && gD[0].id === gid4, JSON.stringify(gD));
  ok('组的混合模式也跟着来了', (gD[0] || {}).blend === 'multiply');
  ok('他在面板上也看得到组行', await D.evaluate(() => window.__count('.group-row')) === 1);
  ok('他那边的图层也是缩进的', await D.evaluate(() => window.__count('.in-group')) === 1);
  ok('他那边的图层表也连续', await D.evaluate(() => window.__contiguous()));
  await D.close();

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' ⏐ '));

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' / ' + fail);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('崩了：', e); process.exit(2); });
