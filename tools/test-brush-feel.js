/**
 * 笔刷手感回归：铅笔要有纸纹但不能断线；水彩笔要真的和底色融合。
 *
 * 用法: node tools/test-brush-feel.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '手感');
  await page.fill('#newRoomName', '笔刷手感');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);

  const params = await page.evaluate(() => {
    const out = {};
    ['pencil', 'watercolor'].forEach(function (id) {
      const p = window.ChaBrushes.resolveParams(window.ChaBrushes.get(id));
      out[id] = { grain: p.grain, paper: p.paper, scatter: p.scatter, mix: p.mix, hardness: p.hardness };
    });
    return out;
  });
  console.log('参数:', JSON.stringify(params));

  console.log('\n=== 铅笔：要有纸纹，但不能断线 ===');
  ok('铅笔开了纸纹（grain > 0）', params.pencil.grain > 0.1, 'grain=' + params.pencil.grain);
  ok('铅笔的纸纹不是「无质感」', params.pencil.paper !== 'none', params.pencil.paper);
  ok('铅笔仍然没有散布（散布会把整笔拆成点）', params.pencil.scatter === 0, 'scatter=' + params.pencil.scatter);

  // 画一笔，看沿线墨量是否有起伏（有纸纹就会起伏），同时不能有整段空档
  const pencil = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height); });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear(); e.restoreSelection(null);
    const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('pencil'));
    prm.size = 26;
    const info = Object.assign({}, prm, { id: 'pk', layerId: e.activeLayerId, tool: 'brush', color: '#111111', sym: 'none', brush: 'pencil', seed: 4242 });
    const st = e.beginStroke(info);
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push([300 + i * 20, 500, 0.8]);
    for (let i = 0; i < pts.length; i += 2) e.addPoints(st.id, pts.slice(i, i + 2));
    e.addPoints(st.id, []);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();
    const l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    // 沿线每隔 4px 取一条竖线上的最大 alpha
    const prof = [];
    // 取笔迹**正中心**的 alpha —— 之前取整条竖直带的最大值，
    // 恰好把颗粒压低的那些点补回满值，于是 std=1，看起来像「没有纸纹」。
    for (let x = 300; x <= 300 + 40 * 20; x += 2) {
      prof.push(d[(500 * e.width + x) * 4 + 3]);
    }
    const nz = prof.filter(v => v > 0);
    const avg = nz.reduce((a, b) => a + b, 0) / (nz.length || 1);
    const dev = Math.sqrt(nz.reduce((a, b) => a + (b - avg) * (b - avg), 0) / (nz.length || 1));
    // 空档：连续 3 个采样点（12px）都没有墨
    let gap = 0, run = 0;
    prof.forEach(function (v) { if (v < 20) { run++; gap = Math.max(gap, run); } else run = 0; });
    return { min: Math.min.apply(null, prof), max: Math.max.apply(null, prof),
      avg: Math.round(avg), dev: Math.round(dev), zeroRatio: +(prof.filter(v => v < 20).length / prof.length).toFixed(3), gap: gap };
  });
  console.log('  沿线墨量: ' + JSON.stringify(pencil));
  // 纸纹本身会让个别点变淡，所以判据是「没有成片空档」而不是「一个空点都没有」
  ok('铅笔画出来是连续的（没有成片空档）', pencil.gap <= 2, '最长空档 ' + pencil.gap + ' 个采样点（每个 2px）');
  ok('铅笔有纸纹起伏（沿线墨量不是一条直线）', pencil.dev > 4, '标准差 ' + pencil.dev + '（平均 ' + pencil.avg + '）');
  ok('铅笔的纸纹没有把笔画打穿', pencil.zeroRatio < 0.05, '空点比例 ' + pencil.zeroRatio);

  console.log('\n=== 水彩笔：要和底色融合 ===');
  ok('水彩笔带混色参数', params.watercolor.mix > 0.1, 'mix=' + params.watercolor.mix);

  const mix = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    // 先铺一块纯红底
    e.layers.forEach(function (l) { l.strokes = []; l.baseImage = null; l.baseSeq = 0; l.ctx.setTransform(1, 0, 0, 1, 0, 0); l.ctx.clearRect(0, 0, e.width, e.height); });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
    const l = e.activeLayer();
    l.ctx.fillStyle = '#ff0000';
    l.ctx.fillRect(0, 0, e.width, e.height);

    function draw(useMix) {
      const prm = window.ChaBrushes.resolveParams(window.ChaBrushes.get('watercolor'));
      prm.size = 60;
      if (!useMix) prm.mix = 0;
      prm.opacity = 1;
      const info = Object.assign({}, prm, { id: 'wc' + useMix, layerId: e.activeLayerId, tool: 'brush', color: '#0000ff', sym: 'none', brush: 'watercolor', seed: 99 });
      const st = e.beginStroke(info);
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push([400 + i * 30, 500, 0.9]);
      for (let i = 0; i < pts.length; i += 2) e.addPoints(st.id, pts.slice(i, i + 2));
      e.addPoints(st.id, []);
      e.endStroke(st.id, e.seq + 1);
      e.invalidate();
    }
    function sample() {
      const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
      const p = (500 * e.width + 600) * 4;      // 笔迹正中（y=500 才是笔迹所在行）
      return { r: d[p], g: d[p + 1], b: d[p + 2], a: d[p + 3] };
    }
    draw(false);
    const noMix = sample();
    // 重来一次，开混色
    e.layers.forEach(function (x) { x.strokes = []; x.baseImage = null; x.baseSeq = 0; x.ctx.setTransform(1, 0, 0, 1, 0, 0); x.ctx.clearRect(0, 0, e.width, e.height); });
    e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = ''; e.pending.clear();
    const l2 = e.activeLayer();
    l2.ctx.fillStyle = '#ff0000';
    l2.ctx.fillRect(0, 0, e.width, e.height);
    draw(true);
    const withMix = sample();
    return { noMix: noMix, withMix: withMix };
  });
  console.log('  笔迹正中颜色: 不混色=' + JSON.stringify(mix.noMix) + '  混色=' + JSON.stringify(mix.withMix));
  // 不混色时应该几乎纯蓝（红底被盖住）；混色时应该吃进红 → R 明显上升
  ok('不混色时笔迹基本以笔色为主（红很少，蓝压过红）', mix.noMix.r < 115 && mix.noMix.b > mix.noMix.r + 40,
    'R=' + mix.noMix.r + ' B=' + mix.noMix.b);
  ok('混色后确实吃进了底色（R 明显上升）', mix.withMix.r > mix.noMix.r + 40,
    'R ' + mix.noMix.r + ' → ' + mix.withMix.r);
  // 融合的结果应该是「两种颜色的中间」，而不是被底色整个吃掉
  ok('融合后是两色的中间（没有变成纯底色）',
    mix.withMix.b > 30 && mix.withMix.r < 230,
    'R=' + mix.withMix.r + ' B=' + mix.withMix.b + '（纯红底是 R=255 B=0）');

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
