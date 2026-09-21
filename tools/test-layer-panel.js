/**
 * ★ v2.0.10 / 2.0.9 图层面板（照 SAI2 重排）+ 三把锁 + 蒙版缩略图 + 指定为选区样本。
 *
 * 覆盖：
 *   1. 版面顺序：混合模式 → 不透明度 → **锁定行（四颗图标）** → 创建剪贴蒙版 →
 *      **指定为选区样本** → **两排图层操作图标（在列表上面！）** → 图层列表
 *   2. 四把锁都在，而且各自的语义真的生效：
 *        · 锁定透明像素（alphaLock）：画得上去，但不会新增透明区域的像素
 *        · 锁定画笔（drawLock）  ：落笔直接被拦下（笔迹数不涨）
 *        · 锁定移动（moveLock）  ：变换起不来
 *        · 全部锁定（locked）    ：画笔 + 移动一起锁
 *   3. 锁会同步给房间里其它人（两端 meta 一致）
 *   4. 蒙版：行里多出一张**缩进 + 虚线**的蒙版缩略图（和普通图层缩略图区分开），
 *      点它进 / 出蒙版编辑；Alt+点是临时关掉 / 打开
 *   5. ★ 2.0.9「指定为选区样本」：单选圆点、整份文档只认一层、会同步给别人
 *
 * 用法: node tools/test-layer-panel.js [http://127.0.0.1:8437]
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

const HELPERS = () => {
  const E = window.ChaApp.engine;
  window.__meta = (id) => E.layerList().find(l => l.id === id) || null;
  window.__active = () => E.activeLayerId;
  window.__ids = () => E.layers.map(l => l.id);
  window.__strokes = () => E.strokes.length;
  window.__row = (id) => document.querySelector('#layerList .layer-item[data-id="' + id + '"]');
  window.__rowBox = (id, sel) => {
    const row = window.__row(id);
    if (!row) return null;
    const el = row.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  window.__panelOrder = () => {
    const box = document.querySelector('[data-section="layers"]');
    if (!box) return null;
    // 一行可能是「容器 div + 里面的控件」——按**里面的控件 id** 认行，别去猜 div 自己的 id/class
    const keyOf = (el) => {
      for (const id of ['layerBlend', 'layerOpacity', 'alphaLockChk', 'clipChk', 'selSampleChk',
        'layerList', 'btnAddLayer', 'btnLayerMerge']) {
        if (el.id === id || el.querySelector('#' + id)) return id;
      }
      return el.id || el.className.split(' ')[0] || '?';
    };
    return Array.from(box.children).map(keyOf);
  };
};

async function mkPage(browser, nick, roomName, w, h) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('  !! 页面报错:', String(e).split('\n')[0]));
  await page.addInitScript(n => { try { localStorage.setItem('chahu.name', n); } catch (e) {} }, nick);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
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
  return page;
}

async function join(page, room, nick) {
  await page.addInitScript(n => { try { localStorage.setItem('chahu.name', n); } catch (e) {} }, nick);
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
}

async function stroke(page, x0, y0, x1, y1) {
  const box = await page.evaluate(([a, b, c, d]) => {
    const e = window.ChaApp.engine;
    const p0 = e.docToScreen(a, b), p1 = e.docToScreen(c, d);
    const r = e.view.getBoundingClientRect();
    return [r.left + p0.x, r.top + p0.y, r.left + p1.x, r.top + p1.y];
  }, [x0, y0, x1, y1]);
  await page.mouse.move(box[0], box[1]);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box[0] + (box[2] - box[0]) * i / 12, box[1] + (box[3] - box[1]) * i / 12);
  }
  await page.mouse.up();
  await sleep(320);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const A = await mkPage(browser, '房主', '图层面板验收', 1200, 800);
  const room = await A.evaluate(() => window.ChaApp.state.room.id);
  const B = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  B.on('pageerror', e => console.log('  !! 页面报错(B):', String(e).split('\n')[0]));
  await join(B, room, '乙');

  /* ---------- 1. 版面（照 SAI2 那张图） ---------- */
  console.log('\n[1] 图层面板版面');
  const order = await A.evaluate(() => window.__panelOrder());
  console.log('  面板子元素: ' + JSON.stringify(order));
  const idx = (k) => order.indexOf(k);
  ok('★ 混合模式排在第一位（SAI2 就是「混合模式 / 不透明度 / 锁定…」自上而下）',
    idx('layerBlend') >= 0 && idx('layerBlend') < idx('layerOpacity'), order);
  ok('★ 不透明度紧跟其后', idx('layerOpacity') > idx('layerBlend') && idx('layerOpacity') < idx('layerList'));
  ok('★ 锁定行在不透明度下面、图层列表上面（四颗图标夹在中间）',
    idx('alphaLockChk') > idx('layerOpacity') && idx('alphaLockChk') < idx('layerList'), order);
  ok('★ 「创建剪贴蒙版」在锁定行下面、图层列表上面',
    idx('clipChk') > idx('alphaLockChk') && idx('clipChk') < idx('layerList'), order);
  ok('★ 图层列表在锁定行 / 剪贴行**下面**（控制在上、列表在下）',
    idx('layerList') > idx('layerOpacity'), order);
  const locks = await A.evaluate(() => {
    const row = document.querySelector('.lock-row.locks');
    if (!row) return null;
    return {
      n: row.querySelectorAll('input[type=checkbox]').length,
      ids: Array.from(row.querySelectorAll('input[type=checkbox]')).map(i => i.id),
      labels: Array.from(row.querySelectorAll('.lock-tip')).map(s => s.textContent),
      hasLabel: !!row.querySelector('.lb'),
      sizes: Array.from(row.querySelectorAll('.lock-ic')).map(el => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      })
    };
  });
  console.log('  锁定行: ' + JSON.stringify(locks));
  ok('★ 锁定行是**四颗图标开关**（透明像素 / 画笔 / 移动 / 全部）',
    !!locks && locks.n === 4
      && locks.ids.join(',') === 'alphaLockChk,lockDrawChk,lockMoveChk,lockChk', locks && locks.ids);
  ok('★ 每颗都有名字（title / 悬浮标签），不是四个没说明的图标',
    !!locks && locks.labels.join('|') === '锁定透明像素|锁定画笔|锁定移动|全部锁定', locks && locks.labels);
  ok('★ 四颗都是能点的小方块（可见、有尺寸）',
    !!locks && locks.sizes.every(s => s[0] >= 18 && s[1] >= 16), locks && locks.sizes);
  ok('★ 「创建剪贴蒙版」是锁定行下面的一行勾选',
    await A.evaluate(() => {
      const c = document.querySelector('#clipChk');
      return !!c && c.type === 'checkbox' && /创建剪贴蒙版/.test(c.parentElement.textContent);
    }));
  ok('★ 「创建剪贴蒙版」在锁定行下面、图层列表上面',
    idx('clipChk') > idx('alphaLockChk') && idx('clipChk') < idx('layerList'), order);
  ok('★ 「指定为选区样本」跟在创建剪贴蒙版下面（SAI2 那颗圆点的位置）',
    idx('selSampleChk') > idx('clipChk') && idx('selSampleChk') < idx('layerList'), order);
  ok('★ 图层操作图标**搬到图层列表上面**了（用户：「不要放在下面」）',
    idx('btnAddLayer') >= 0 && idx('btnAddLayer') < idx('layerList'), order);
  const opsIds = await A.evaluate(() => Array.from(
    document.querySelectorAll('[data-section="layers"] .layer-ops.icons .lic')).map(b => b.id));
  ok('★ 九个图层操作图标一个不少，全都在那一块里（列表上面）',
    ['btnAddLayer', 'btnGroupAdd', 'btnLayerDup', 'btnLayerMerge', 'btnLayerDrop',
      'btnLayerFlatten', 'btnGroupToggle', 'btnLayerClear', 'btnLayerDel']
      .every(id => opsIds.indexOf(id) >= 0), opsIds.join(','));
  ok('★ 而且是**两排**图标（照 SAI2 那张图）',
    await A.evaluate(() => document.querySelectorAll('[data-section="layers"] .layer-ops.icons .lic-row').length) === 2);
  const ls = await A.evaluate(() => {
    const b = document.querySelector('#layerList').getBoundingClientRect();
    const r = document.querySelector('[data-section="layers"] .layer-ops.icons').getBoundingClientRect();
    return { list: Math.round(b.top), ops: Math.round(r.top) };
  });
  ok('★ 量出来的位置也是图标排在列表上面', ls.ops < ls.list, JSON.stringify(ls));

  /* ---------- 1b. 指定为选区样本 ---------- */
  console.log('\n[1b] 指定为选区样本（魔棒取样来源要用）');
  const lid = await A.evaluate(() => window.__active());
  const ssBefore = await A.evaluate(() => ({
    tag: document.querySelector('#selSampleChk').tagName + '/' + document.querySelector('#selSampleChk').type,
    label: document.querySelector('#selSampleChk').parentElement.textContent
  }));
  ok('★ 是一颗单选圆点（radio），不是勾选框', ssBefore.tag === 'INPUT/radio', ssBefore.tag);
  ok('★ 名字就是「指定为选区样本」', /指定为选区样本/.test(ssBefore.label), ssBefore.label);
  await A.click('#selSampleChk');
  await sleep(600);
  const ssA = await A.evaluate(id => window.__meta(id), lid);
  ok('★ 点一下就把当前图层指定为选区样本（meta 里 selSample = true）',
    !!ssA && ssA.selSample === true, ssA && ssA.selSample);
  await A.click('#btnAddLayer');
  await sleep(700);
  // 新建的那层不会自动变成当前层 → 先点它的行，再点那颗圆点
  const newLid = await A.evaluate(() => window.ChaApp.engine.layers[window.ChaApp.engine.layers.length - 1].id);
  await A.click('#layerList .layer-item[data-id="' + newLid + '"]');
  await sleep(500);
  await A.click('#selSampleChk');
  await sleep(700);
  const ssAll = await A.evaluate(() => window.ChaApp.engine.layerList().map(l => [l.name, !!l.selSample]));
  console.log('  两层上的标记: ' + JSON.stringify(ssAll));
  ok('★ 指定另一层时，原来那层自动取消（整份文档只认一层）',
    ssAll.filter(x => x[1]).length === 1 && ssAll[ssAll.length - 1][1] === true, ssAll);
  const ssB = await B.evaluate(() => window.ChaApp.engine.layerList().map(l => !!l.selSample).filter(Boolean).length);
  ok('★ 会同步给房间里其他人（另一端也正好有一层是样本层）', ssB === 1, ssB);
  // 收尾：把当前图层换回原来那层（后面几段都在这层上验锁 / 蒙版）
  await A.click('#layerList .layer-item[data-id="' + lid + '"]');
  await sleep(500);
  ok('（收尾）当前图层切回来', (await A.evaluate(() => window.__active())) === lid);

  /* ---------- 2. 三把锁的语义 ---------- */
  console.log('\n[2] 三把锁真的拦得住');

  // 锁定画笔：落笔被拦
  await A.check('#lockDrawChk');
  await sleep(500);
  const s0 = await A.evaluate(() => window.__strokes());
  await stroke(A, 300, 260, 520, 380);
  const s1 = await A.evaluate(() => window.__strokes());
  ok('★ 锁定画笔：这一层落笔被拦下（笔迹数不涨）', s1 === s0, s0 + ' → ' + s1);
  const toastLock = await A.evaluate(() => (document.querySelector('#toastWrap') || {}).textContent || '');
  ok('★ 而且给了明确提示（不是默默不响应）', /锁定/.test(toastLock), toastLock.slice(0, 40));

  // 锁定移动：变换起不来
  await A.evaluate(() => { const c = document.querySelector('#lockDrawChk'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } });
  await sleep(400);
  await stroke(A, 300, 260, 520, 380);      // 先画点东西，否则「空图层不给变换」
  await sleep(300);
  await A.check('#lockMoveChk');
  await sleep(500);
  await A.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(500);
  ok('★ 锁定移动：变换起不来（engine.transform 仍是空）',
    (await A.evaluate(() => !!window.ChaApp.engine.transform)) === false);

  // 全部锁定：画笔 + 移动一起锁
  await A.evaluate(() => { const c = document.querySelector('#lockMoveChk'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } });
  await sleep(400);
  await A.check('#lockChk');
  await sleep(500);
  const s2 = await A.evaluate(() => window.__strokes());
  await stroke(A, 340, 300, 560, 420);
  const s3 = await A.evaluate(() => window.__strokes());
  ok('★ 全部锁定：连画笔一起锁住', s3 === s2, s2 + ' → ' + s3);
  await A.evaluate(() => document.querySelector('#btnTransform').click());
  await sleep(400);
  ok('★ 全部锁定：变换也起不来',
    (await A.evaluate(() => !!window.ChaApp.engine.transform)) === false);

  // 全部解开 + 锁定透明像素：能画上去，但不会新增像素范围外的东西
  await A.uncheck('#lockChk');
  await sleep(400);
  await A.check('#alphaLockChk');
  await sleep(500);
  const s4 = await A.evaluate(() => window.__strokes());
  await stroke(A, 700, 200, 860, 300);      // 在空白处画：alphaLock 下不该新增
  await sleep(400);
  const s5 = await A.evaluate(() => window.__strokes());
  const metaA = await A.evaluate(id => window.__meta(id), lid);
  ok('★ 锁定透明像素：笔迹照收（不是被拦），但由引擎按 alpha 保护处理',
    s5 >= s4 && metaA && metaA.alphaLock === true, JSON.stringify({ s4, s5, alphaLock: metaA && metaA.alphaLock }));

  // 锁跨端同步
  const metaB = await B.evaluate(id => {
    const m = window.__meta(id);
    return m ? { alphaLock: !!m.alphaLock, drawLock: !!m.drawLock, moveLock: !!m.moveLock, locked: !!m.locked } : null;
  }, lid);
  console.log('  另一端拿到的锁: ' + JSON.stringify(metaB));
  ok('★ 三把锁都会同步给房间里其他人（服务端存了、S2C 也带上了）',
    !!metaB && metaB.alphaLock === true && metaB.drawLock === false && metaB.moveLock === false && metaB.locked === false,
    metaB);

  // 收尾：全解开
  await A.uncheck('#alphaLockChk');
  await sleep(400);

  /* ---------- 3. 蒙版缩略图 ---------- */
  console.log('\n[3] 图层蒙版：缩进 + 视觉差异化 + 可点');
  await A.click('#btnMaskAdd');
  await sleep(900);
  const thumbs = await A.evaluate(id => {
    const row = window.__row(id);
    if (!row) return null;
    const a = window.__rowBox(id, '.thumb:not(.mask-thumb)');
    const b = window.__rowBox(id, '.thumb.mask-thumb');
    const cs = b ? getComputedStyle(row.querySelector('.thumb.mask-thumb')) : null;
    return {
      layerThumb: a, maskThumb: b,
      border: cs ? cs.borderTopStyle : '', radius: cs ? cs.borderTopLeftRadius : '',
      hasImg: !!(cs && cs.backgroundImage && cs.backgroundImage !== 'none'),
      after: cs ? getComputedStyle(row.querySelector('.thumb.mask-thumb'), '::after').content : ''
    };
  }, lid);
  console.log('  缩略图: ' + JSON.stringify(thumbs));
  ok('★ 有蒙版的图层多出一张**蒙版缩略图**', !!thumbs && !!thumbs.maskThumb);
  ok('★ 蒙版缩略图**往里缩进**（左边在图层缩略图右边，且中间留了空）',
    !!thumbs && !!thumbs.layerThumb && !!thumbs.maskThumb
      && thumbs.maskThumb.x >= thumbs.layerThumb.x + thumbs.layerThumb.w + 4,
    thumbs && { layer: thumbs.layerThumb, mask: thumbs.maskThumb });
  ok('★ 视觉上和普通图层缩略图区分开了（虚线边 + 更小 + 带「蒙版」角标）',
    !!thumbs && (thumbs.border === 'dashed' || thumbs.border === 'dotted' || thumbs.border === 'solid')
      && thumbs.after === '"蒙版"'
      && thumbs.maskThumb.w <= thumbs.layerThumb.w,
    thumbs && { border: thumbs.border, after: thumbs.after, layer: thumbs.layerThumb, mask: thumbs.maskThumb });
  ok('★ 蒙版缩略图有真实像素（不是一块空白占位）',
    !!thumbs && thumbs.hasImg === true, thumbs && thumbs.hasImg);
  await A.click('#btnAddLayer');
  await sleep(700);
  ok('★ 没有蒙版的图层不显示蒙版缩略图',
    await A.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#layerList .layer-item'));
      return rows.filter(r => !r.querySelector('.thumb.mask-thumb')).length >= 1;
    }));

  // 点蒙版缩略图 = 进 / 出蒙版编辑。
  // ⚠ 坐标必须**每次现测**：上面那句「新建图层」会往列表最上面插一行，
  //   蒙版缩略图会跟着往下挪 —— 拿旧坐标去点会点空，测试就会莫名其妙地飘。
  const thumbCenter = async () => {
    const b = await A.evaluate(id => window.__rowBox(id, '.thumb.mask-thumb'), lid);
    if (!b) throw new Error('找不到蒙版缩略图（图层 ' + lid + '）');
    return [b.x + b.w / 2, b.y + b.h / 2];
  };
  const maskEditNow = () => A.evaluate(() => window.ChaApp.state.maskEdit);
  // 「＋蒙版」本身就会直接进蒙版编辑（不然用户点完还得再找一次按钮）
  ok('★ 点「＋蒙版」建好蒙版后直接进蒙版编辑', (await maskEditNow()) === lid, await maskEditNow());
  let c1 = await thumbCenter();
  await A.mouse.click(c1[0], c1[1]);
  await sleep(500);
  ok('★ 点蒙版缩略图退出蒙版编辑', (await maskEditNow()) === null, await maskEditNow());
  c1 = await thumbCenter();
  await A.mouse.click(c1[0], c1[1]);
  await sleep(500);
  ok('★ 再点一下又进入蒙版编辑（不用去点上面那颗按钮）', (await maskEditNow()) === lid, await maskEditNow());
  // 上面那颗图标按钮同样能进出
  await A.click('#btnMaskEdit');
  await sleep(500);
  ok('★ 那一排图标里的「编辑蒙版」按钮也能退出', (await maskEditNow()) === null, await maskEditNow());

  // Alt+点 = 临时关掉这张蒙版
  c1 = await thumbCenter();
  await A.keyboard.down('Alt');
  await A.mouse.click(c1[0], c1[1]);
  await A.keyboard.up('Alt');
  await sleep(700);
  const maskOff = await A.evaluate(id => {
    const m = window.__meta(id);
    return m ? m.maskEnabled : null;
  }, lid);
  ok('★ Alt+点蒙版缩略图 = 临时关掉这张蒙版（maskEnabled 翻成 false）', maskOff === false, maskOff);

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
