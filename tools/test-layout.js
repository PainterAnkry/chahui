/**
 * 布局 / 侧栏 / 参考图浮窗 / 高斯模糊 / 菜单 回归。
 *
 * 守着这几条：
 *   · 工具面板挪到了画布右边，聊天侧栏在最右；侧栏能收拉，收起后画布会变宽
 *   · 参考图是**独立浮窗**（可拖、可缩放、可关），不再是盖在画布上的一层；
 *     而且始终**不上传**（不进笔迹 / 不进图层）
 *   · 高斯模糊：预览是真的（画布上就糊了），确定时作为一次像素操作发出去
 *   · 尺子菜单里没有「抖动修正 ±」；「其他」里显示当前版本而不是「系统 ID」
 *
 * 用法: node tools/test-layout.js [http://localhost:8437]
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '布局');
  await page.fill('#newRoomName', '布局回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(400);

  console.log('\n=== 布局：画布在左，工具面板和聊天侧栏都在右 ===');
  const lay = await page.evaluate(() => {
    const g = s => document.querySelector(s).getBoundingClientRect();
    const stage = g('.workspace > .stage'), left = g('.panel.left'), right = g('.panel.right');
    return { stage: Math.round(stage.left), tools: Math.round(left.left), chat: Math.round(right.left),
      stageW: Math.round(stage.width) };
  });
  console.log('  ' + JSON.stringify(lay));
  ok('画布在最左边', lay.stage < lay.tools, 'stage=' + lay.stage);
  ok('工具面板在画布右边', lay.tools > lay.stage && lay.tools < lay.chat, 'tools=' + lay.tools);
  ok('聊天侧栏在最右', lay.chat > lay.tools, 'chat=' + lay.chat);

  console.log('\n=== 侧栏收拉 ===');
  await page.evaluate(() => document.querySelector('#btnSideCollapse').click());
  await sleep(500);
  const col = await page.evaluate(() => ({
    hidden: document.querySelector('#sidePanel').classList.contains('hidden'),
    rail: !document.querySelector('#sideRail').classList.contains('hidden'),
    stageW: Math.round(document.querySelector('.workspace > .stage').getBoundingClientRect().width)
  }));
  console.log('  收起后 ' + JSON.stringify(col));
  ok('点把手能收起侧栏', col.hidden === true);
  ok('收起后出现窄条', col.rail === true);
  ok('收起后画布变宽（不是留一条空档）', col.stageW > lay.stageW, lay.stageW + ' → ' + col.stageW);
  await page.evaluate(() => document.querySelector('#sideRail').click());
  await sleep(500);
  const back = await page.evaluate(() => ({
    hidden: document.querySelector('#sidePanel').classList.contains('hidden'),
    rail: !document.querySelector('#sideRail').classList.contains('hidden')
  }));
  ok('点窄条能拉回来', back.hidden === false && back.rail === false, JSON.stringify(back));

  console.log('\n=== 参考图是独立浮窗 ===');
  const ref = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    c.getContext('2d').fillStyle = '#e04040';
    c.getContext('2d').fillRect(0, 0, 200, 150);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    window.ChaApp.loadReferenceImage(new File([blob], '参考.png', { type: 'image/png' }));
    await new Promise(r => setTimeout(r, 800));
    const w = document.querySelector('#refWindow');
    return {
      open: !w.classList.contains('hidden'),
      hasImg: !!document.querySelector('#refImg').getAttribute('src'),
      name: document.querySelector('#refName').textContent,
      tag: w.tagName,
      onCanvasOverlay: !!document.querySelector('.ref-canvas')
    };
  });
  console.log('  ' + JSON.stringify(ref));
  ok('参考图以独立浮窗打开', ref.open === true && ref.tag === 'DIV', ref.tag);
  ok('图片显示出来了', ref.hasImg === true);
  ok('标题栏显示文件名', /参考\.png/.test(ref.name), ref.name);
  ok('不再是盖在画布上的那一层', ref.onCanvasOverlay === false);

  const b0 = await page.evaluate(() => {
    const r = document.querySelector('#refWindow').getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top)];
  });
  const hb = await page.locator('#refHead').boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(hb.x - 120, hb.y + 90, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const b1 = await page.evaluate(() => {
    const r = document.querySelector('#refWindow').getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top)];
  });
  console.log('  拖动 ' + JSON.stringify(b0) + ' → ' + JSON.stringify(b1));
  ok('能拖动浮窗', Math.abs(b1[0] - b0[0]) > 50 || Math.abs(b1[1] - b0[1]) > 50, JSON.stringify(b1));
  ok('参考图不上传（不在笔迹 / 图层里）', await page.evaluate(() => {
    const j = JSON.stringify({ s: window.ChaApp.engine.strokes, l: window.ChaApp.engine.layers.map(x => x.name) });
    return !/参考\.png/.test(j);
  }));
  await page.evaluate(() => window.ChaApp.clearReferenceImage());
  await sleep(300);
  ok('能关闭浮窗', await page.evaluate(() => document.querySelector('#refWindow').classList.contains('hidden')));

  console.log('\n=== 高斯模糊 ===');
  // 硬边黑方块 → 模糊后边缘会变成「黑色 + 半透明」的过渡带
  const soft = () => page.evaluate(() => {
    const e = window.ChaApp.engine;
    const src = e.layerOverride && e.layerOverride.canvas
      ? e.layerOverride.canvas : e.renderLayerRaw(e.activeLayerId);
    const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    let edge = 0, solid = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > 250) solid++;
      else if (a > 6) edge++;
    }
    return { edge: edge, solid: solid };
  });

  await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    l.ctx.setTransform(1, 0, 0, 1, 0, 0);
    l.ctx.clearRect(0, 0, e.width, e.height);
    l.ctx.fillStyle = '#000000';
    l.ctx.fillRect(600, 400, 200, 200);
    l.baseImage = l.ctx.canvas.toDataURL('image/png');
    l.baseSeq = e.seq;
  });
  const bm = await soft();
  console.log('  模糊前: 实心=' + bm.solid + ' 过渡带=' + bm.edge);
  ok('模糊前是硬边（过渡带很小）', bm.edge < 3000, '过渡带 ' + bm.edge);

  await page.evaluate(() => window.ChaApp.openBlurDialog());
  await sleep(500);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#blurMask').classList.contains('hidden'),
    note: document.querySelector('#blurNote').textContent
  }));
  ok('模糊对话框能打开', dlg.open === true);
  ok('说明了作用对象', /图层/.test(dlg.note), dlg.note.slice(0, 26));

  await page.evaluate(() => {
    const e = document.querySelector('#blurRadius');
    e.value = 20; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  const prev = await soft();
  console.log('  预览中: 过渡带=' + prev.edge);
  ok('拖滑块产生了预览（图层覆盖生效）', prev.edge !== bm.edge);
  ok('模糊后过渡带大幅变宽（边缘被糊开）', prev.edge > bm.edge + 3000, bm.edge + ' → ' + prev.edge);

  const composed = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.renderDocument({}).canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let mid = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i]; if (v > 60 && v < 200) mid++; }
    return mid;
  });
  ok('画布合成里也是糊的（预览走的是真合成）', composed > 3000, '灰 = ' + composed);

  const sent = await page.evaluate(() => new Promise(res => {
    const net = window.ChaApp.net, orig = net.send.bind(net), seen = [];
    net.send = function (t, pl) { seen.push({ t: t, label: pl && pl.label }); return orig(t, pl); };
    document.querySelector('#btnBlurOk').click();
    setTimeout(() => { net.send = orig; res(seen); }, 900);
  }));
  const px = sent.filter(s => /pixels/.test(s.t));
  console.log('  确定时发出: ' + JSON.stringify(px));
  ok('确定时作为一次像素操作发了出去（标签=高斯模糊）',
    px.length === 1 && px[0].label === '高斯模糊', JSON.stringify(px));

  console.log('\n=== 菜单 ===');
  const menu = await page.evaluate(() => {
    const open = (re) => {
      const t = Array.from(document.querySelectorAll('#menuBar .menu-title')).find(x => re.test(x.textContent));
      if (!t) return [];
      t.click();
      const labels = Array.from(t.parentElement.querySelectorAll('.menu-drop .menu-row'))
        .map(r => r.textContent.replace(/[▸]/g, '').replace(/\([A-Z]\)/g, '').trim());
      window.ChaMenu.closeAll();
      return labels;
    };
    return { ruler: open(/尺子/), other: open(/其他/) };
  });
  console.log('  尺子: ' + JSON.stringify(menu.ruler));
  console.log('  其他: ' + JSON.stringify(menu.other));
  ok('尺子菜单里没有「抖动修正 ±」', !menu.ruler.some(l => /抖动修正/.test(l)), menu.ruler.join(' / '));
  ok('尺子菜单里留了一句指路（手抖修正去哪调）', menu.ruler.some(l => /手抖修正/.test(l)));
  ok('「其他」里显示当前版本', menu.other.some(l => /^版本 \d+\.\d+\.\d+/.test(l)), menu.other.join(' / '));
  ok('不再有「系统 ID」', !menu.other.some(l => /系统 ID/.test(l)));
  const nothingGreyInFilter = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#menuBar .menu-title')).find(x => /滤镜/.test(x.textContent));
    t.click();
    const rows = Array.from(t.parentElement.querySelectorAll('.menu-drop .menu-row'));
    // 展开每个子菜单，看看里面还有没有「暂未实现」
    let pending = 0;
    rows.forEach(r => {
      r.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const sub = r.parentElement.querySelector('.menu-sub');
      if (sub) pending += (sub.textContent.match(/暂未实现/g) || []).length;
    });
    window.ChaMenu.closeAll();
    return pending;
  });
  ok('滤镜里已经没有任何「暂未实现」', nothingGreyInFilter === 0, String(nothingGreyInFilter));

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
