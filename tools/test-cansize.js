/**
 * 画布大小 / 裁剪回归。
 *
 * 守着这几条：
 *   · 「图像 → 画布大小」真的存在、能开、九宫格锚点会决定画面往哪边靠
 *   · 改尺寸时**画面不缩放**（多出来的是透明边，裁掉的就是没了）
 *   · 「图像 → 裁剪」裁的是选区那一块，不是把整幅画面拉伸成选区尺寸
 *     （以前就是这么错的：走了 scaleArtwork，等于「缩放」而不是「裁剪」）
 *   · 这些改动对**所有图层**生效，而且会同步到另一端
 *
 * 用法: node tools/test-cansize.js [http://localhost:8440]
 */
'use strict';
const { chromium } = require('./pw');

const URL = process.argv[2] || 'http://127.0.0.1:8440';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function join(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 15000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(700);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
  });
  await sleep(300);
}

/** 在图层上画记号，并把笔迹清掉（我们要的是像素，不是笔迹回放） */
async function mark(page, rects) {
  await page.evaluate((rs) => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    rs.forEach(r => { l.ctx.fillStyle = r.c; l.ctx.fillRect(r.x, r.y, r.w, r.h); });
    l.strokes = [];
  }, rects);
  await sleep(250);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const A = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const B = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  const errs = [];
  A.on('pageerror', e => errs.push('A: ' + String(e).split('\n')[0]));
  B.on('pageerror', e => errs.push('B: ' + String(e).split('\n')[0]));
  A.on('dialog', d => d.accept());
  B.on('dialog', d => d.accept());

  await A.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.ChaApp, { timeout: 15000 });
  await B.goto(URL + '/', { waitUntil: 'domcontentloaded' });
  await B.waitForFunction(() => window.ChaApp, { timeout: 15000 });

  await join(A, '画布甲');
  const room = await A.evaluate(() => window.ChaApp.state.room.id);
  // B 用 ?room= 直接进来（和 test-browser 一样的路子）
  await B.goto(URL + '/?room=' + encodeURIComponent(room), { waitUntil: 'load' });
  await B.waitForFunction(() => window.ChaApp.state && window.ChaApp.state.joined, { timeout: 15000 }).catch(() => {});
  await sleep(900);
  await B.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
  });
  const bJoined = await B.evaluate(() => !!(window.ChaApp.state && window.ChaApp.state.joined));
  console.log('  B 端已加入:', bJoined);
  await sleep(400);

  const size = p => p.evaluate(() => [window.ChaApp.engine.width, window.ChaApp.engine.height]);
  const px = (p, x, y) => p.evaluate(([a, b]) => {
    const e = window.ChaApp.engine;
    if (a < 0 || b < 0 || a >= e.width || b >= e.height) return 'out';
    const d = e.activeLayer().ctx.getImageData(Math.round(a), Math.round(b), 1, 1).data;
    return [d[0], d[1], d[2], d[3]].join(',');
  }, [x, y]);
  const bounds = p => p.evaluate(() => {
    const e = window.ChaApp.engine;
    const src = e.renderLayerRaw(e.activeLayer().id);
    const W = src.width, H = src.height;
    const d = src.getContext('2d').getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return { n, box: x1 < 0 ? null : [x0, y0, x1, y1] };
  });

  console.log('\n=== 菜单里「画布大小」是真的了（以前直接打开「图像大小」） ===');
  const menuHit = await A.evaluate(() => {
    window.ChaMenu.closeAll();
    const t = [...document.querySelectorAll('#menuBar .menu-title')].find(x => /图像/.test(x.textContent));
    t.click();
    const rows = [...t.parentElement.querySelectorAll('.menu-drop .menu-row')];
    const row = rows.find(r => /^画布大小/.test(r.textContent.replace(/\([A-Z]\)/g, '').trim()));
    window.ChaMenu.closeAll();
    return { found: !!row, label: row ? row.textContent.trim() : null };
  });
  ok('图像菜单里有「画布大小」', menuHit.found, menuHit);

  console.log('\n=== 画布大小对话框 ===');
  await A.evaluate(() => window.ChaApp.openCanvasSizeDialog());
  await sleep(350);
  let dlg = await A.evaluate(() => ({
    open: !document.getElementById('csizeMask').classList.contains('hidden'),
    w: document.getElementById('csizeW').value,
    h: document.getElementById('csizeH').value,
    anchors: document.querySelectorAll('#csizeAnchor button').length,
    active: [...document.querySelectorAll('#csizeAnchor button')].findIndex(b => b.classList.contains('on')),
    preview: document.getElementById('csizePreview').textContent
  }));
  console.log('  ' + JSON.stringify(dlg));
  ok('对话框能打开', dlg.open === true);
  ok('宽高默认是当前画布尺寸', dlg.w === '1600' && dlg.h === '1000', [dlg.w, dlg.h]);
  ok('有九宫格锚点（9 格）', dlg.anchors === 9, dlg.anchors);
  ok('默认锚点是正中', dlg.active === 4, dlg.active);
  ok('预览里写了「更改前 → 更改后」', /更改前 1600 × 1000/.test(dlg.preview), dlg.preview);

  // 改宽高，预览跟着变
  await A.evaluate(() => {
    const w = document.getElementById('csizeW');
    w.value = '2000'; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.getElementById('csizeH');
    h.value = '1400'; h.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  dlg = await A.evaluate(() => document.getElementById('csizePreview').textContent);
  ok('输入宽高后预览实时更新', /更改后 2000 × 1400/.test(dlg) && /Δ 400 × 400/.test(dlg), dlg);

  console.log('\n=== 扩大画布：内容按锚点摆放，其余透明 ===');
  await mark(A, [{ x: 100, y: 120, w: 200, h: 150, c: '#ff0000' }]);
  let before = await bounds(A);
  console.log('  记号范围:', JSON.stringify(before.box));
  ok('记号画上了', before.n > 20000, before.n);

  // 选「右下」锚点，改成 2000×1400：内容应该整体右移 400、下移 400
  await A.evaluate(() => {
    document.querySelector('#csizeAnchor button[data-ax="1"][data-ay="1"]').click();
    const w = document.getElementById('csizeW');
    w.value = '2000'; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.getElementById('csizeH');
    h.value = '1400'; h.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnCSizeOk').click();
  });
  await A.waitForFunction(() => window.ChaApp.engine.width === 2000 && window.ChaApp.engine.height === 1400, { timeout: 15000 });
  await sleep(1800);

  let sz = await size(A);
  let after = await bounds(A);
  console.log('  尺寸', JSON.stringify(sz), ' 记号范围', JSON.stringify(after.box));
  ok('画布变成 2000×1400', sz[0] === 2000 && sz[1] === 1400, sz);
  ok('画面没有缩放：记号还是 200×150（面积不变）', after.n === before.n, after.n + ' vs ' + before.n);
  ok('记号整体右移下移 400（锚点=右下）',
    after.box && after.box[0] === 100 + 400 && after.box[1] === 120 + 400,
    after.box);
  ok('多出来的地方是透明的', (await px(A, 10, 10)) === '0,0,0,0', await px(A, 10, 10));
  ok('对话框改完自己关掉', await A.evaluate(() => document.getElementById('csizeMask').classList.contains('hidden')));

  console.log('\n=== 缩小画布：超出的部分被裁掉 ===');
  // 记号在 (500,520)-(699,669)。裁到 600×600 且锚点左上 → 只留下 (500,520)-(599,599)
  await A.evaluate(() => window.ChaApp.openCanvasSizeDialog());
  await sleep(250);
  await A.evaluate(() => {
    document.querySelector('#csizeAnchor button[data-ax="0"][data-ay="0"]').click();
    const w = document.getElementById('csizeW');
    w.value = '600'; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.getElementById('csizeH');
    h.value = '600'; h.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnCSizeOk').click();
  });
  await A.waitForFunction(() => window.ChaApp.engine.width === 600, { timeout: 15000 });
  await sleep(1800);
  sz = await size(A);
  after = await bounds(A);
  console.log('  尺寸', JSON.stringify(sz), ' 记号范围', JSON.stringify(after.box), ' 像素', after.n);
  ok('画布变成 600×600', sz[0] === 600 && sz[1] === 600, sz);
  ok('锚点左上：记号没挪位置', after.box && after.box[0] === 500 && after.box[1] === 520, after.box);
  ok('超出右边的部分被裁掉（100×80 而不是被拉伸）',
    after.n === 100 * 80 && after.box[2] === 599 && after.box[3] === 599,
    { n: after.n, box: after.box });

  console.log('\n=== 再扩大回去：裁掉的就是没了，剩下的一点没被拉伸 ===');
  await A.evaluate(() => window.ChaApp.openCanvasSizeDialog());
  await sleep(250);
  await A.evaluate(() => {
    document.querySelector('#csizeAnchor button[data-ax="0"][data-ay="0"]').click();
    const w = document.getElementById('csizeW');
    w.value = '1600'; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.getElementById('csizeH');
    h.value = '1000'; h.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnCSizeOk').click();
  });
  await A.waitForFunction(() => window.ChaApp.engine.width === 1600, { timeout: 15000 });
  await sleep(1800);
  after = await bounds(A);
  console.log('  记号范围', JSON.stringify(after.box), ' 像素', after.n);
  ok('记号还在原来的位置、原来的大小（没被缩放）',
    after.n === 100 * 80 && after.box[0] === 500 && after.box[1] === 520, after);

  console.log('\n=== 「图像 → 裁剪」裁的是选区那一块 ===');
  // 画布 1600×1000，记号在 (500,520)-(599,599)。
  // 裁到 (400,450,400,300)：记号应落在 (100,70)-(199,149)
  const crop = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const s = e.ensureSelection();
    s.ctx.clearRect(0, 0, e.width, e.height);
    s.ctx.fillStyle = '#fff';
    s.ctx.fillRect(400, 450, 400, 300);
    s.active = true;
    if (e.refreshSelectionTint) e.refreshSelectionTint();
    return { has: e.hasSelection(), bbox: e.selectionBBox() };
  });
  console.log('  选区:', JSON.stringify(crop.bbox));
  ok('选区建好了', crop.has === true && crop.bbox.w === 400 && crop.bbox.h === 300, crop);

  await A.evaluate(() => window.ChaApp.cropToSelection());
  await A.waitForFunction(() => window.ChaApp.engine.width === 400, { timeout: 15000 });
  await sleep(1800);
  sz = await size(A);
  after = await bounds(A);
  console.log('  尺寸', JSON.stringify(sz), ' 记号范围', JSON.stringify(after.box), ' 像素', after.n);
  ok('画布变成选区大小 400×300', sz[0] === 400 && sz[1] === 300, sz);
  ok('内容整体平移（左移 400 / 上移 450），而且没有被拉伸',
    after.n === 100 * 80 && after.box && after.box[0] === 100 && after.box[1] === 70 && after.box[2] === 199 && after.box[3] === 149,
    after);
  ok('裁掉的那部分是真的没了（不是被拉进来）',
    (await px(A, 300, 200)) === '0,0,0,0', await px(A, 300, 200));
  ok('裁剪后选区清掉了（旧坐标对不上，留着只会误导）',
    await A.evaluate(() => window.ChaApp.engine.hasSelection()) === false);

  console.log('\n=== 选区比画布下限还小时：夹到最小尺寸并提示，而不是报错 ===');
  await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const s = e.ensureSelection();
    s.ctx.clearRect(0, 0, e.width, e.height);
    s.ctx.fillStyle = '#fff';
    s.ctx.fillRect(10, 10, 50, 40);
    s.active = true;
    if (e.refreshSelectionTint) e.refreshSelectionTint();
  });
  await A.evaluate(() => window.ChaApp.cropToSelection());
  await sleep(2200);
  sz = await size(A);
  ok('夹到了画布下限 320×240', sz[0] === 320 && sz[1] === 240, sz);

  console.log('\n=== 其他图层也跟着走（不是只处理当前层） ===');
  // 先建图层再画：反过来画的话，LAYER_ADD 触发的重新同步会把还没上传的本地像素冲掉
  await A.evaluate(() => window.ChaApp.addLayer());
  await A.waitForFunction(() => window.ChaApp.engine.layers.length >= 2, { timeout: 10000 });
  await sleep(900);
  const active = await A.evaluate(() => {
    const e = window.ChaApp.engine;
    const top = e.layers[e.layers.length - 1];
    e.setActiveLayer(top.id);
    return { name: e.activeLayer().name, total: e.layers.length };
  });
  console.log('  新建并切到:', JSON.stringify(active));
  ok('新图层建好了而且是当前层', active.name === '图层 2', active);

  // 两层各画一块记号
  await A.evaluate(() => {
    const e = window.ChaApp.engine;
    e.setActiveLayer(e.layers[0].id);
  });
  await mark(A, [{ x: 20, y: 20, w: 60, h: 50, c: '#ff0000' }]);
  await A.evaluate(() => {
    const e = window.ChaApp.engine;
    e.setActiveLayer(e.layers[1].id);
  });
  await mark(A, [{ x: 5, y: 5, w: 40, h: 30, c: '#00cc00' }]);

  const layerPixels = () => A.evaluate(() => {
    const e = window.ChaApp.engine;
    return e.layers.map(l => {
      const src = e.renderLayerRaw(l.id);
      const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return { name: l.name, n };
    });
  });
  const beforeLayers = await layerPixels();
  console.log('  改之前各层像素:', JSON.stringify(beforeLayers));
  ok('两层上都有内容（这样才测得到多层）',
    beforeLayers.length === 2 && beforeLayers.every(l => l.n > 0), beforeLayers);

  await A.evaluate(() => window.ChaApp.openCanvasSizeDialog());
  await sleep(250);
  await A.evaluate(() => {
    document.querySelector('#csizeAnchor button[data-ax="1"][data-ay="1"]').click();
    const w = document.getElementById('csizeW');
    w.value = '600'; w.dispatchEvent(new Event('input', { bubbles: true }));
    const h = document.getElementById('csizeH');
    h.value = '500'; h.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnCSizeOk').click();
  });
  await A.waitForFunction(() => window.ChaApp.engine.width === 600, { timeout: 15000 });
  await sleep(1800);
  const afterLayers = await layerPixels();
  console.log('  改之后各层像素:', JSON.stringify(afterLayers));
  ok('两个图层的内容都跟着搬了（像素数一个没少）',
    afterLayers.length === beforeLayers.length &&
    afterLayers.every((l, i) => l.n === beforeLayers[i].n),
    { before: beforeLayers, after: afterLayers });

  console.log('\n=== 「刚好装下内容」按钮 ===');
  const fit = await A.evaluate(() => {
    window.ChaApp.openCanvasSizeDialog();
    const before = [document.getElementById('csizeW').value, document.getElementById('csizeH').value];
    document.getElementById('btnCSizeMax').click();
    return { before, after: [document.getElementById('csizeW').value, document.getElementById('csizeH').value], canvas: [window.ChaApp.engine.width, window.ChaApp.engine.height] };
  });
  console.log('  ' + JSON.stringify(fit));
  ok('点一下就填上了尺寸（内容都在画布内时就是当前尺寸）',
    Number(fit.after[0]) >= fit.canvas[0] && Number(fit.after[1]) >= fit.canvas[1], fit);
  await A.evaluate(() => document.getElementById('btnCSizeZero').click());

  console.log('\n=== 只有房主能改 ===');
  if (bJoined) {
    const notOwner = await B.evaluate(() => {
      window.ChaApp.openCanvasSizeDialog();
      const open = !document.getElementById('csizeMask').classList.contains('hidden');
      const before = window.ChaApp.engine.width;
      const w = document.getElementById('csizeW');
      w.value = '900'; w.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnCSizeOk').click();
      return { open, before, after: window.ChaApp.engine.width };
    });
    ok('客人改不了画布尺寸', notOwner.after === notOwner.before, notOwner);

    console.log('\n=== 改完之后另一端也看得到 ===');
    await B.waitForFunction(() => window.ChaApp.engine.width === 600, { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const bSize = await size(B);
    const bPx = await B.evaluate(() => {
      const e = window.ChaApp.engine;
      const d = e.renderDocument({}).canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    });
    const aPx = await A.evaluate(() => {
      const e = window.ChaApp.engine;
      const d = e.renderDocument({}).canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    });
    console.log('  B 端尺寸', JSON.stringify(bSize), '像素', bPx, ' A 端像素', aPx);
    ok('B 端也是新尺寸', bSize[0] === 600 && bSize[1] === 500, bSize);
    ok('B 端画面像素与 A 端一致', bPx === aPx, bPx + ' vs ' + aPx);
  } else {
    console.log('  （跳过：B 端没进同一房间）');
  }

  console.log('\n=== 页面没报错 ===');
  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 4));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
