/**
 * ★ 2.0.9 魔棒选项 + 套索「先画线、再成圈」。
 *
 * 用户的四条原话（这轮就是照它们做的）：
 *   · 「套索选区工具和PS都不一样，应该是画线连接后再出现圈，而不是一来就出现」
 *   · 「魔棒选区选中之后得有最后一幅图的设置选项」（= SAI2「魔棒」面板那一整块）
 *
 * 覆盖：
 *   1. 套索拖拽中**还没有选区**（只有那条线），松手才闭合成圈、选区才出现
 *   2. 取样模式「被线条包围的透明区域」：点在框里 → 选中框内那块透明区域；点在线上 → 什么都没选中
 *   3. 透明容差范围真的改结果（调到 255 连线条都拦不住）
 *   4. 「色差范围内的区域」（连成一片）↔「色差范围内的全部像素」（不连片，整张图都要）
 *   5. 防止溢出范围：往外长 N 像素，选区面积按周长长大
 *   6. 消除锯齿：关掉是 1-bit 硬边（没有半透明的边缘像素），打开就有一圈渐变
 *   7. 忽略已选择的区域：已经选中的像素当边界，洪水填不进去
 *   8. 取样来源三选一：当前图层 / 指定为选区样本的图层 / 拼合图像，各取各的像素
 *
 * 用法: node tools/test-wand.js [http://127.0.0.1:8440]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '魔棒测试');
  await page.fill('#newRoomName', '魔棒选项验收');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  // 自动变换面板会抢走后面的画布点击，先关掉（这项在别的测试里单独验）
  await page.evaluate(() => {
    const c = document.querySelector('#tpAuto');
    c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);

  // 两层：A = 上面那层（当前图层，画线稿），B = 下面那层（「指定为选区样本」的样本层）。
  // 只有一层的话取样来源那三种根本分不开（A、B 是同一张画布）。
  await page.click('#btnAddLayer');
  await sleep(800);
  const layerCount = await page.evaluate(() => window.ChaApp.engine.layers.length);
  check('（铺垫）房间里有两层，取样来源才分得开', layerCount >= 2, layerCount + ' 层');

  const dim = await page.evaluate(() => ({ w: window.ChaApp.engine.width, h: window.ChaApp.engine.height }));
  console.log('画布 ' + dim.w + '×' + dim.h);
  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    return [box.x + s.x, box.y + s.y];
  };
  const setTool = async t => { await page.click('#toolGrid .tool[data-item="' + t + '"]'); await sleep(220); };

  /** 选区状态：像素数 + 硬边 / 渐变边缘各有多少 */
  const selInfo = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    if (!e.selection) return { active: false, px: 0, soft: 0, bbox: null };
    const d = e.selection.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0, soft = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > 8) n++;
      if (a > 8 && a < 247) soft++;
    }
    return { active: e.hasSelection(), px: n, soft: soft, bbox: e.selection.bbox };
  });
  const clearSel = () => page.evaluate(() => window.ChaApp.engine.restoreSelection(null));

  /** 铺场景：A = 当前图层（最上面那层），B = 最底下那层 */
  const scene = kind => page.evaluate(k => {
    const e = window.ChaApp.engine;
    const A = e.layers[e.layers.length - 1];
    const B = e.layers[0];
    e.layers.forEach(function (l) {
      l.strokes = []; l.baseImage = null; l.baseSeq = 0;
      l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height);
    });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
    e.setActiveLayer(A.id);
    if (k === 'art') {
      // 透明底 + 一个黑色方框（线条）：框里是「被线条包围的透明区域」
      A.ctx.strokeStyle = '#111111'; A.ctx.lineWidth = 8;
      A.ctx.strokeRect(200, 150, 700, 500);
    } else if (k === 'diff') {
      // 蓝底 + 一条竖黑线（把左边那块和右边隔开）
      A.ctx.fillStyle = '#3a86e0'; A.ctx.fillRect(0, 0, e.width, e.height);
      A.ctx.fillStyle = '#111111'; A.ctx.fillRect(600, 0, 60, e.height);
    } else if (k === 'source') {
      // A（当前图层）：只有方框线；B（下面的样本层）：整片蓝
      A.ctx.strokeStyle = '#111111'; A.ctx.lineWidth = 8;
      A.ctx.strokeRect(200, 150, 700, 500);
      B.ctx.fillStyle = '#3a86e0'; B.ctx.fillRect(0, 0, e.width, e.height);
    }
    e.invalidate();
    return { A: A.id, B: B.id, active: e.activeLayerId };
  }, kind);

  const wandMode = async m => {
    await page.click({ wrap: '#wandModeWrap', diff: '#wandModeDiff', diffAll: '#wandModeAll' }[m]);
    await sleep(150);
  };
  const wandSource = async s => {
    await page.click({ layer: '#wandSrcLayer', sample: '#wandSrcSample', merged: '#wandSrcMerge' }[s]);
    await sleep(150);
  };
  const wandSlide = async (id, v) => {
    await page.evaluate(([i, val]) => {
      const el = document.querySelector(i);
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, v]);
    await sleep(120);
  };
  const wandCheck = async (id, on) => {
    await page.evaluate(([i, val]) => {
      const el = document.querySelector(i);
      if (el.checked !== val) { el.checked = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, [id, on]);
    await sleep(120);
  };
  /** 点一下魔棒（真的走鼠标，走的是用户那条路） */
  const wandClick = async (x, y) => {
    const p = await mk(x, y);
    await page.mouse.move(p[0], p[1]);
    await page.mouse.down(); await page.mouse.up();
    await sleep(650);
    return selInfo();
  };
  const near = (a, b, rel) => Math.abs(a - b) <= b * rel;

  /* ---------- 1. 套索：先画线，松手才成圈 ---------- */
  console.log('\n[1] 套索：拖拽中只有线，松手才出现圈');
  await clearSel();
  await setTool('lasso');
  const L0 = await mk(400, 300);
  await page.mouse.move(L0[0], L0[1]);
  await page.mouse.down();
  for (const p of [[900, 300], [900, 700], [420, 700]]) {
    const q = await mk(p[0], p[1]);
    await page.mouse.move(q[0], q[1]);
    await sleep(25);
  }
  await sleep(300);
  const during = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const pv = e.selectPreview;
    return {
      has: e.hasSelection(),
      preview: !!pv,
      pts: pv ? pv.points.length : 0,
      maskPx: e.selection ? e.selection.active : false
    };
  });
  console.log('  拖拽中: ' + JSON.stringify(during));
  check('★ 套索拖拽中**还没有选区**（不是「一来就出现」）', during.has === false, during.has);
  check('★ 拖拽中那条线是画出来了的（overlay 上有实时路径）',
    during.preview === true && during.pts >= 3, during);
  await page.mouse.up();
  await sleep(700);
  const after = await selInfo();
  console.log('  松手后: ' + after.px + ' 像素, bbox=' + JSON.stringify(after.bbox));
  check('★ 松手才闭合成圈、选区才出现', after.active === true && after.px > 120000 && after.px < 320000, after.px);
  check('圈的大小对得上（约 500×400 的三角形 + 收口）',
    !!after.bbox && after.bbox.w > 440 && after.bbox.w < 560 && after.bbox.h > 350 && after.bbox.h < 460,
    after.bbox);

  /* ---------- 2. 取样模式：被线条包围的透明区域 ---------- */
  console.log('\n[2] 取样模式：被线条包围的透明区域');
  await clearSel();
  await scene('art');
  await setTool('wand');
  await wandMode('wrap');
  await wandSlide('#wandTolRange', 19);
  await wandCheck('#wandAAChk', false);
  await wandCheck('#wandIgnoreChk', false);
  await wandSource('layer');
  await sleep(200);
  const inner = 692 * 492;                       // 方框内的透明区域（线宽 8，两边各吃 4px）
  let r = await wandClick(550, 400);
  console.log('  点在框里: ' + r.px + ' 像素（期望 ≈ ' + inner + '）');
  check('★ 点在框里 → 选中「被线条包围的透明区域」', near(r.px, inner, 0.08), r.px + ' / ' + inner);
  check('★ 而且正好是框内那一块（bbox 贴着线内侧）',
    !!r.bbox && Math.abs(r.bbox.x - 204) <= 6 && Math.abs(r.bbox.y - 154) <= 6 &&
    Math.abs(r.bbox.w - 692) <= 12 && Math.abs(r.bbox.h - 492) <= 12, r.bbox);
  r = await wandClick(550, 150);                 // 正上方那条线上
  console.log('  点在线条上: ' + r.px + ' 像素');
  check('★ 点在线条上 → 什么都没选中（并给了提示）', r.px === 0 && r.active === false, r.px);

  /* ---------- 3. 透明容差范围 ---------- */
  console.log('\n[3] 透明容差范围真的改结果');
  await wandSlide('#wandTolRange', 255);
  r = await wandClick(550, 400);
  console.log('  容差 255: ' + r.px + ' 像素（线条也拦不住了）');
  check('★ 透明容差 255 → 线条也不再算边界（整张画布都透明）',
    r.px > dim.w * dim.h * 0.95, r.px + ' / ' + dim.w * dim.h);
  await wandSlide('#wandTolRange', 19);
  r = await wandClick(550, 400);
  check('★ 调回 19 又只选中框内那块', near(r.px, inner, 0.08), r.px + ' / ' + inner);

  /* ---------- 4. 色差范围内的区域 ↔ 全部像素 ---------- */
  console.log('\n[4] 色差范围内的区域 ↔ 色差范围内的全部像素');
  await clearSel();
  await scene('diff');
  await wandSlide('#toleranceRange', 32);
  await wandMode('diff');
  await sleep(200);
  r = await wandClick(200, 200);
  const half = 600 * dim.h;
  console.log('  色差·区域: ' + r.px + ' 像素（期望 ≈ ' + half + '，被黑线挡住）');
  check('★ 色差范围内的区域：只取**连成一片**的那一块', near(r.px, half, 0.04), r.px + ' / ' + half);
  await wandMode('diffAll');
  await sleep(200);
  r = await wandClick(200, 200);
  const allBlue = (dim.w - 60) * dim.h;
  console.log('  色差·全部像素: ' + r.px + ' 像素（期望 ≈ ' + allBlue + '，黑线另一边的蓝也要）');
  check('★ 色差范围内的全部像素：不连片也全要（黑线另一边同样颜色的也算）',
    near(r.px, allBlue, 0.04), r.px + ' / ' + allBlue);
  await wandMode('diff');
  await sleep(200);

  /* ---------- 5. 防止溢出范围 ---------- */
  console.log('\n[5] 防止溢出范围：往外长 N 像素');
  await clearSel();
  await scene('art');
  await wandMode('wrap');
  await wandSlide('#wandTolRange', 19);
  await wandSlide('#wandBleedRange', 0);
  await sleep(200);
  r = await wandClick(550, 400);
  const base = r.px;
  await wandSlide('#wandBleedRange', 6);
  const bled = await wandClick(550, 400);
  const expectGrow = (692 + 12) * (492 + 12) - 692 * 492;   // 长方形外扩 6px
  console.log('  溢出 0 → ' + base + ' 像素；溢出 6 → ' + bled.px + ' 像素（期望多 ≈ ' + expectGrow + '）');
  check('★ 防止溢出 6px：选区按周长往外长出去',
    near(bled.px - base, expectGrow, 0.25), (bled.px - base) + ' / ' + expectGrow);
  check('★ 溢出之后选区还是「框内那块加上一圈」而不是整张画布',
    bled.px < dim.w * dim.h * 0.5, bled.px);
  await wandSlide('#wandBleedRange', 0);

  /* ---------- 6. 消除锯齿 ---------- */
  console.log('\n[6] 消除锯齿');
  await wandCheck('#wandAAChk', false);
  const hard = await wandClick(550, 400);
  await wandCheck('#wandAAChk', true);
  const soft = await wandClick(550, 400);
  console.log('  硬边: ' + hard.px + ' 像素 / 半透明边缘像素 ' + hard.soft +
    '；抗锯齿: ' + soft.px + ' 像素 / 半透明边缘像素 ' + soft.soft);
  check('★ 关掉「消除锯齿」：边缘是硬邦邦的 1-bit（没有半透明像素）', hard.soft === 0, hard.soft);
  check('★ 打开「消除锯齿」：边缘出现一圈渐变（半透明像素 > 100）', soft.soft > 100, soft.soft);
  check('★ 打开 / 关掉的总面积基本一致（只是边缘变柔和，没有变大变小）',
    near(soft.px, hard.px, 0.05), soft.px + ' vs ' + hard.px);

  /* ---------- 7. 忽略已选择的区域 ---------- */
  console.log('\n[7] 忽略已选择的区域');
  await clearSel();
  await scene('diff');
  await wandCheck('#wandAAChk', false);
  await wandMode('diff');
  await wandSlide('#toleranceRange', 32);
  await wandCheck('#wandIgnoreChk', false);
  await sleep(200);
  /**
   * 先造一条**贯通的**横带选区（y 400..600，整幅宽）。
   * 这里故意不走鼠标框选：框选拖到画布最左边会被「点落在画布外」的探针挡下，
   * 起点留在 x=8 就会留下一条 8px 的缝 —— 洪水会从缝里绕过去，
   * 于是「忽略已选择区域」看着像没生效（第一版测试就踩了这个坑）。
   */
  const bandSel = () => page.evaluate(h => {
    const e = window.ChaApp.engine;
    const c = document.createElement('canvas');
    c.width = e.width; c.height = e.height;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, Math.round(h * 0.4), e.width, Math.round(h * 0.2));
    return { ok: e.restoreSelection(c), px: e.selection.bbox };
  }, dim.h);
  const band = await bandSel();
  console.log('  先铺一条贯通的横带选区: ' + JSON.stringify(band.px));
  check('（铺垫）横带选区建好了（整幅宽、y 400..600）',
    band.ok === true && band.px && band.px.x === 0 && band.px.w === dim.w, band.px);
  await setTool('wand');
  const noIgnore = await wandClick(200, 200);
  console.log('  不勾选: ' + noIgnore.px + ' 像素（期望 ≈ ' + half + '）');
  check('★ 不勾选「忽略已选择的区域」：照旧把整块连通的区域都吃进来', near(noIgnore.px, half, 0.04), noIgnore.px);
  await bandSel();
  await setTool('wand');
  await wandCheck('#wandIgnoreChk', true);
  const withIgnore = await wandClick(200, 200);
  console.log('  勾选后: ' + withIgnore.px + ' 像素（期望 ≈ ' + (600 * 400) + '，被那条已经选中的横带挡住）');
  check('★ 勾选「忽略已选择的区域」：已经选中的像素当边界，填不进去',
    near(withIgnore.px, 600 * 400, 0.04), withIgnore.px + ' / ' + (600 * 400));
  check('★ 和不勾选相比明显更小（选项真的起了作用）', withIgnore.px < noIgnore.px * 0.6,
    withIgnore.px + ' < ' + noIgnore.px);
  await wandCheck('#wandIgnoreChk', false);

  /* ---------- 8. 取样来源 ---------- */
  console.log('\n[8] 取样来源：当前图层 / 指定为选区样本的图层 / 拼合图像');
  await clearSel();
  const ids = await scene('source');
  await setTool('wand');
  await wandMode('wrap');
  await wandSlide('#wandTolRange', 19);
  await wandCheck('#wandAAChk', false);
  await wandSource('layer');
  await sleep(200);
  r = await wandClick(550, 400);
  console.log('  当前图层 + 透明区域: ' + r.px + ' 像素（期望 ≈ ' + inner + '）');
  check('★ 取样来源「当前图层」：读的是这一层自己的像素（框里是透明的）',
    near(r.px, inner, 0.08), r.px + ' / ' + inner);
  // 把 B 标成「指定为选区样本」
  await page.evaluate(id => {
    const e = window.ChaApp.engine;
    e.layers.forEach(l => { l.selSample = l.id === id; });
  }, ids.B);
  await wandSource('sample');
  r = await wandClick(550, 400);
  console.log('  样本层 + 透明区域: ' + r.px + ' 像素（样本层整片蓝，没有透明区域可圈）');
  check('★ 取样来源「指定为选区样本的图层」：真的换了一张底图（样本层没有透明区域 → 选不出来）',
    r.px === 0, r.px);
  await wandMode('diff');
  await sleep(200);
  r = await wandClick(550, 400);
  console.log('  样本层 + 色差: ' + r.px + ' 像素（样本层整片同色 → 整张画布）');
  check('★ 换模式后同一次点击读的还是样本层（整片同色 → 整张画布）',
    r.px > dim.w * dim.h * 0.95, r.px + ' / ' + (dim.w * dim.h));
  await wandSource('merged');
  r = await wandClick(550, 400);
  console.log('  拼合图像 + 色差: ' + r.px + ' 像素（期望 ≈ ' + inner + '，方框线挡住了）');
  check('★ 取样来源「拼合图像」：所有可见图层叠起来再取色（方框线把里面圈住了）',
    near(r.px, inner, 0.08), r.px + ' / ' + inner);
  // 没有样本层时退回当前图层，并且明说一句
  await page.evaluate(() => { window.ChaApp.engine.layers.forEach(l => { l.selSample = false; }); });
  await page.evaluate(() => { document.querySelector('#toastWrap').innerHTML = ''; });
  await wandSource('sample');
  await wandMode('wrap');
  r = await wandClick(550, 400);
  const toastTxt = await page.evaluate(() => (document.querySelector('#toastWrap') || {}).textContent || '');
  console.log('  没标样本层时: ' + r.px + ' 像素, toast=' + JSON.stringify(toastTxt.slice(0, 40)));
  check('★ 一层都没标「指定为选区样本」时退回当前图层（不是默默什么都不选）',
    near(r.px, inner, 0.08), r.px + ' / ' + inner);
  check('★ 而且当场提示怎么用（提示里出现「指定为选区样本」）',
    /指定为选区样本/.test(toastTxt), toastTxt.slice(0, 60));

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
