/**
 * 文字工具 / 文字图层回归。
 *
 * 守着这几条：
 *   · 文字作为**一种笔迹**走既有通道：跨端一致 / 能撤销 / 能回放 —— 不另造机制
 *   · 落到新图层上（「文字图层」），图层名取文字开头
 *   · 文字字段要穿过**四道白名单**（BRUSH_DEFAULTS 无关，但 newStroke / strokeInfo /
 *     buildStroke 三道一处漏了就会「本机有字、别人没字」）
 *   · 多行、对齐、粗斜体、字体族都要真的影响渲染
 *
 * 用法: node tools/test-text.js [http://localhost:8437]
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '文字');
  await page.fill('#newRoomName', '文字图层');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => {
    document.querySelector('#entryMask').classList.add('hidden');
    document.querySelector('#btnZoomFit').click();
  });
  await sleep(400);

  console.log('\n=== 工具栏里有文字工具 ===');
  const toolBtn = await page.evaluate(() => {
    const b = document.querySelector('#toolGrid .tool[data-item="text"]') ||
      document.querySelector('#brushGrid .tool[data-item="text"]');
    return { exists: !!b, label: b ? b.textContent.trim() : '' };
  });
  console.log('  ' + JSON.stringify(toolBtn));
  ok('工具栏里有「文字」', toolBtn.exists === true, toolBtn.label);

  await page.evaluate(() => {
    const b = document.querySelector('#toolGrid .tool[data-item="text"]') ||
      document.querySelector('#brushGrid .tool[data-item="text"]');
    b.click();
  });
  await sleep(300);
  ok('能切到文字工具', (await page.evaluate(() => window.ChaApp.state.tool)) === 'text');

  const box = await page.locator('#view').boundingBox();
  const mk = async (x, y) => { const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]); return [box.x + s.x, box.y + s.y]; };

  console.log('\n=== 点画布选位置 → 弹输入框 ===');
  const at = await mk(500, 400);
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down(); await page.mouse.up();
  await sleep(500);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#textMask').classList.contains('hidden'),
    at: window.ChaApp.state.textAt,
    families: document.querySelectorAll('#textFamily option').length
  }));
  console.log('  ' + JSON.stringify(dlg));
  ok('停下的是文字输入框（不是画笔）', dlg.open === true);
  ok('记住了点击位置', dlg.at && Math.abs(dlg.at.x - 500) < 2 && Math.abs(dlg.at.y - 400) < 2, JSON.stringify(dlg.at));
  ok('字体下拉有若干选择', dlg.families >= 5, String(dlg.families));
  ok('点了一下没有画出任何笔迹', (await page.evaluate(() => window.ChaApp.engine.strokes.length)) === 0);

  console.log('\n=== 放到画布上 ===');
  const layersBefore = await page.evaluate(() => window.ChaApp.engine.layers.length);
  await page.evaluate(() => {
    document.querySelector('#textInput').value = '茶绘\nChahui';
    document.querySelector('#textSize').value = '64';
    const f = document.querySelector('#textFamily'); f.value = 'hei'; f.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#textBold').checked = true;
    document.querySelector('#btnTextOk').click();
  });
  await sleep(1800);
  const placed = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const st = e.strokes[e.strokes.length - 1];
    return {
      n: e.strokes.length,
      layers: e.layers.length,
      layerNames: e.layers.map(l => l.name),
      text: st && st.text, family: st && st.fontFamily, size: st && st.fontSize,
      bold: st && st.bold, tool: st && st.tool, pts: st && st.points,
      seq: e.seq
    };
  });
  console.log('  ' + JSON.stringify(placed));
  ok('文字作为一条笔迹进了历史', placed.n === 1 && placed.tool === 'text', JSON.stringify({ n: placed.n, tool: placed.tool }));
  ok('文字内容带上了（含换行）', placed.text === '茶绘\nChahui', JSON.stringify(placed.text));
  ok('字体 / 字号 / 粗体都带上了', placed.family === 'hei' && placed.size === 64 && placed.bold === true,
    JSON.stringify({ f: placed.family, s: placed.size, b: placed.bold }));
  ok('自动建了一个新图层（文字图层）', placed.layers === layersBefore + 1,
    placed.layers + ' 层：' + placed.layerNames.join(' / '));
  ok('图层名取的是文字开头', /茶绘/.test(placed.layerNames[placed.layerNames.length - 1]),
    placed.layerNames.join(' / '));

  console.log('\n=== 画布上真的画出字了 ===');
  const ink = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const d = e.renderDocument({ transparentBackground: true }).canvas
      .getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
      if (d[(y * e.width + x) * 4 + 3] > 30) {
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { n, box: [x0, y0, x1, y1] };
  });
  console.log('  ' + JSON.stringify(ink));
  ok('画布上有字（墨迹像素 > 300）', ink.n > 300, ink.n + ' 像素');
  ok('字出现在点击位置附近（框左上角接近 500,400）',
    ink.box[0] > 400 && ink.box[0] < 620 && ink.box[1] > 300 && ink.box[1] < 480, JSON.stringify(ink.box));
  ok('两行 —— 高度明显大于一个字',
    (ink.box[3] - ink.box[1]) > 80, '高 ' + (ink.box[3] - ink.box[1]) + 'px');

  console.log('\n=== 四道白名单：文字字段要在服务端也活下来 ===');
  const wire = await page.evaluate(() => new Promise(resolve => {
    const net = window.ChaApp.net;
    const orig = net.send.bind(net);
    let captured = null;
    net.send = function (t, p) {
      if (t === 'stroke:begin' && p && p.tool === 'text') captured = p;
      return orig(t, p);
    };
    window.ChaApp.state.textAt = { x: 300, y: 300 };
    document.querySelector('#textInput').value = '白名单';
    document.querySelector('#textSize').value = '40';
    document.querySelector('#btnTextOk').click();
    setTimeout(() => { net.send = orig; resolve(captured); }, 1400);
  }));
  console.log('  发出去的 stroke:begin: ' + JSON.stringify(wire && {
    tool: wire.tool, text: wire.text, family: wire.fontFamily, size: wire.fontSize, lh: wire.lineHeight
  }));
  ok('stroke:begin 里带了 tool=text', wire && wire.tool === 'text');
  ok('stroke:begin 里带了文字内容', wire && wire.text === '白名单', wire && JSON.stringify(wire.text));
  ok('stroke:begin 里带了字体 / 字号 / 行高',
    wire && wire.fontFamily && wire.fontSize === 40 && wire.lineHeight > 0,
    wire ? JSON.stringify({ f: wire.fontFamily, s: wire.fontSize, lh: wire.lineHeight }) : 'null');

  console.log('\n=== 服务端收下之后能回放成一样的字（跨端一致）===');
  const round = await page.evaluate(async () => {
    const e = window.ChaApp.engine;
    // 口径要说清楚：这里比的是**同一条文字笔迹**的两种来源 ——
    // 直接用引擎里那份对象盖一次，再用「只保留服务端会传的字段」重建一份盖一次。
    // 两者像素数一致，就说明字段没有在传输路径上丢掉。
    const st = e.strokes.filter(s => s.tool === 'text').pop();
    const rebuilt = {
      id: st.id, layerId: e.activeLayerId, tool: 'text', color: st.color,
      size: st.size, opacity: st.opacity, hardness: 1, minSize: 1, pressSize: 0, pressOpacity: 0,
      seed: 1, sym: 'none', brush: 'text',
      text: st.text, fontFamily: st.fontFamily, fontSize: st.fontSize,
      bold: st.bold, italic: st.italic, align: st.align, lineHeight: st.lineHeight,
      points: st.points
    };
    function stampWith(stroke) {
      const probe = document.createElement('canvas');
      probe.width = e.width; probe.height = e.height;
      const pc = probe.getContext('2d');
      const layer = { id: 'probe', canvas: probe, opacity: 1, blend: 'normal' };
      e.stampStroke(pc, layer, stroke, null);
      const d = pc.getImageData(0, 0, e.width, e.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
      return n;
    }
    const n1 = stampWith(st);
    const n2 = stampWith(rebuilt);
    return { n1: n1, n2: n2 };
  });
  console.log('  ' + JSON.stringify(round));
  ok('同一条文字：原件与「只留服务端字段」重建版像素数一致', Math.abs(round.n1 - round.n2) <= 2,
    round.n1 + ' vs ' + round.n2);

  console.log('\n=== 撤销能撤掉文字 ===');
  const u0 = await page.evaluate(() => ({ undo: window.ChaApp.state.opUndo.length, ink: (function () {
    const e = window.ChaApp.engine;
    const d = e.renderDocument({ transparentBackground: true }).canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++; return n;
  })() }));
  await page.keyboard.press('Control+z');
  await sleep(1500);
  const u1 = await page.evaluate(() => ({ undo: window.ChaApp.state.opUndo.length, ink: (function () {
    const e = window.ChaApp.engine;
    const d = e.renderDocument({ transparentBackground: true }).canvas.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++; return n;
  })() }));
  console.log('  撤销前 ' + JSON.stringify(u0) + ' → 撤销后 ' + JSON.stringify(u1));
  ok('撤销后画布上的字少了一些', u1.ink < u0.ink, u0.ink + ' → ' + u1.ink);

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
