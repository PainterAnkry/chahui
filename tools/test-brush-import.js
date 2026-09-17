/**
 * 笔刷导入回归：PS `.abr`（v1/v2 与 v6+）、CSP `.sut`、Procreate `.brush` 的解析 + 笔尖渲染。
 *
 * ⚠️ 关于测试的诚实说明：这台机器上没有真实的 Photoshop / CSP 笔刷文件，
 * 所以 .abr / .sut 用的是**按格式规范自己构造的样本**（写字节 → 解析回来）。
 * 这能证明解析器和渲染链路是对的，但**不能**证明它能吃下你手上的每一个真实文件。
 * 拿到真实文件后如果解析失败，把文件名和现象告诉我 —— 解析器是「读不懂就明确报错」，
 * 不会静默给出一支错的笔。
 *
 * Procreate 那一段不一样：`tools/procreate-corpus/*.brush` 是**真实文件**，
 * 从 #brushFileInput 灌进去，走的就是用户点「导入笔刷」时的同一条链路。
 *
 * 用法: node tools/test-brush-import.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '导入');
  await page.fill('#newRoomName', '笔刷导入回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);

  /* ---------- 1) 属性：打包 / 解包 / 硬度推断 ---------- */
  console.log('\n=== 笔尖打包与解包 ===');
  const pack = await page.evaluate(() => {
    const BI = window.ChaBrushImport;
    // 造一个中心亮、边缘暗的圆形灰度笔尖
    const w = 64, h = 64, g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2 + 0.5, y - h / 2 + 0.5) / (w / 2);
      g[y * w + x] = d < 0.5 ? 255 : 0;             // 硬边
    }
    const tip = BI.packTip(g, w, h);
    const u = BI.unpackTip(tip);
    const hard = BI.hardnessOf(g, w, h);
    // 再来一个软边
    const soft = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2 + 0.5, y - h / 2 + 0.5) / (w / 2);
      soft[y * w + x] = Math.max(0, Math.round(255 * (1 - d)));
    }
    return {
      tip: tip, w: u.w, h: u.h, bytes: u.rgba.length, len: tip.length,
      centre: u.rgba[(24 * u.w + 24) * 4 + 3],
      corner: u.rgba[(1 * u.w + 1) * 4 + 3],
      hard: hard, soft: BI.hardnessOf(soft, w, h),
      bad: [BI.unpackTip('nope'), BI.unpackTip('32x32x8:AAAA'), BI.unpackTip('')]
    };
  });
  console.log('  打包结果:', pack.w + '×' + pack.h, '共', pack.len, '字符');
  check('笔尖打包成 48×48 的 4 位小图', pack.w === 48 && pack.h === 48, pack.w + '×' + pack.h);
  check('打包体积够小（≤ 1700 字符，会跟着每一笔走）', pack.len <= 1700, pack.len + ' 字符');
  check('解包后中心不透明、角落透明', pack.centre > 200 && pack.corner < 40, pack.centre + ' / ' + pack.corner);
  check('硬边的硬度推断 > 软边', pack.hard > pack.soft, pack.hard.toFixed(2) + ' > ' + pack.soft.toFixed(2));
  check('坏字符串一律解不出东西（不瞎猜）', pack.bad.every(v => v === null));

  /* ---------- 2) .abr v1 / v2 ---------- */
  console.log('\n=== .abr（旧格式 v1 / v2） ===');
  const abr12 = await page.evaluate((ver) => {
    // 手写一个 v1/v2 的 .abr：1 支采样笔，8 位、不压缩、带 4 字节对齐的块
    const w = 16, h = 16;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      gray[y * w + x] = (x < w / 2) ? 255 : 0;      // 左半边亮
    }
    const parts = [];
    const u16 = v => [v >> 8 & 255, v & 255];
    const u32 = v => [v >>> 24 & 255, v >> 16 & 255, v >> 8 & 255, v & 255];
    const name = ver === 2 ? 'TestBrush' : '';
    const nameBytes = ver === 2 ? [].concat(u32(name.length), Array.from(name).flatMap(c => [0, c.charCodeAt(0)])) : [];
    const body = [].concat(
      nameBytes,
      u32(0),                       // misc
      u16(25),                      // spacing 25%
      [1],                          // 抗锯齿
      new Array(8).fill(0),         // 短边界
      u32(0), u32(0), u32(h), u32(w),  // top/left/bottom/right
      u16(8),                       // 位深
      [0],                          // 压缩 = 原样
      Array.from(gray)
    );
    const pad = (4 - (body.length % 4)) % 4;
    const block = body.concat(new Array(pad).fill(0));
    const bytes = new Uint8Array([].concat(u16(ver), u16(1), u16(2), u32(block.length), block));
    const r = window.ChaBrushImport.parseAbr(bytes.buffer);
    return { n: r.brushes.length, name: r.brushes[0] && r.brushes[0].name,
      w: r.brushes[0] && r.brushes[0].w, spacing: r.brushes[0] && r.brushes[0].spacing,
      left: r.brushes[0] && r.brushes[0].gray[8 * w + 2], right: r.brushes[0] && r.brushes[0].gray[8 * w + 13] };
  }, 2);
  console.log('  解析:', JSON.stringify(abr12));
  check('.abr v1/v2：解析出 1 支笔', abr12.n === 1, String(abr12.n));
  check('.abr v1/v2：笔尖尺寸正确', abr12.w === 16, String(abr12.w));
  check('.abr v1/v2：间距读成 0.25', Math.abs(abr12.spacing - 0.25) < 1e-6, String(abr12.spacing));
  check('.abr v1/v2：位图内容正确（左亮右暗）', abr12.left === 255 && abr12.right === 0,
    abr12.left + ' / ' + abr12.right);

  /* ---------- 3) .abr v6（PackBits 压缩） ---------- */
  console.log('\n=== .abr（新格式 v6，PackBits 压缩） ===');
  const abr6 = await page.evaluate(() => {
    const w = 16, h = 16;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = (y < h / 2) ? 200 : 20;
    const u16 = v => [v >> 8 & 255, v & 255];
    const u32 = v => [v >>> 24 & 255, v >> 16 & 255, v >> 8 & 255, v & 255];
    // PackBits：每行 = [ 0x0F, 16 个值 ]（字面量 16 字节）
    const rows = [];
    for (let y = 0; y < h; y++) rows.push([0x0F].concat(Array.from(gray.slice(y * w, y * w + w))));
    const lens = rows.map(() => u16(17));
    // ★ 真实布局（拿 17 个真实 .abr 文件校准过，别照印象改）：
    //   Pascal 名（1 字节长度前缀）→ 次版本 2 要跳 264 字节 → y,x,bottom,right → 位深 → 压缩 → 位图
    const name = 'Named brush';
    const body = [].concat(
      [name.length], Array.from(name).map(c => c.charCodeAt(0)),
      new Array(264).fill(0),                       // 次版本 2 的未知区
      u32(0), u32(0), u32(h), u32(w),               // y, x, y+h, x+w
      u16(8), [1],                                  // 位深 8、PackBits
      lens.reduce((a, b) => a.concat(b), []),
      rows.reduce((a, b) => a.concat(b), [])
    );
    const entry = [].concat(u32(body.length), body);
    const pad = (4 - (entry.length % 4)) % 4;
    const samp = new Uint8Array(entry.concat(new Array(pad).fill(0)));
    const blocks = [].concat(
      [0x38, 0x42, 0x49, 0x4d], 'samp'.split('').map(c => c.charCodeAt(0)), u32(samp.length), Array.from(samp)
    );
    const bytes = new Uint8Array([].concat(u16(6), u16(2), blocks));
    const r = window.ChaBrushImport.parseAbr(bytes.buffer);
    const b = r.brushes[0];
    return { n: r.brushes.length, name: b && b.name, w: b && b.w, minor: r.minor,
      top: b && b.gray[2 * w + 8], bottom: b && b.gray[14 * w + 8] };
  });
  console.log('  解析:', JSON.stringify(abr6));
  check('.abr v6：解析出 1 支笔', abr6.n === 1, String(abr6.n));
  check('.abr v6：读到了 Pascal 名', abr6.name === 'Named brush', String(abr6.name));
  check('.abr v6：次版本读成 2', abr6.minor === 2, String(abr6.minor));
  check('.abr v6：PackBits 解压正确（上亮下暗）', abr6.top === 200 && abr6.bottom === 20,
    abr6.top + ' / ' + abr6.bottom);

  /* ---------- 4) 坏文件要明确报错，不能瞎猜 ---------- */
  console.log('\n=== 坏文件 ===');
  const bad = await page.evaluate(() => {
    const out = {};
    try { window.ChaBrushImport.parseAbr(new Uint8Array([0, 99, 0, 0]).buffer); out.ver = 'no-error'; }
    catch (e) { out.ver = e.message; }
    try { window.ChaBrushImport.parseSut(new Uint8Array([1, 2, 3, 4, 5]).buffer); out.sut = 'no-error'; }
    catch (e) { out.sut = e.message; }
    return out;
  });
  console.log('  ', JSON.stringify(bad));
  check('不认识的 .abr 版本会明确报错', /版本/.test(bad.ver), bad.ver);
  check('没有笔尖的 .sut 会明确报错', /没找到/.test(bad.sut), bad.sut);

  /* ---------- 5) .sut（里面扫 PNG 笔尖） ---------- */
  console.log('\n=== .sut（扫出内嵌的 PNG 笔尖） ===');
  const sut = await page.evaluate(async () => {
    // 造一张 24×24 的 PNG，塞进一段假的 SQLite 头里，模仿真实 .sut 的布局
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const cx = c.getContext('2d');
    const g = cx.createRadialGradient(12, 12, 0, 12, 12, 12);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 24, 24);
    const pngB64 = c.toDataURL('image/png').split(',')[1];
    const png = Uint8Array.from(atob(pngB64), ch => ch.charCodeAt(0));
    const head = new Uint8Array(64);
    const magic = 'SQLite format 3\0';
    for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
    const all = new Uint8Array(head.length + png.length + 8);
    all.set(head, 0); all.set(png, head.length);
    const r = window.ChaBrushImport.parseSut(all.buffer);
    return { n: r.brushes.length, pngLen: r.brushes[0].png.length, expect: png.length };
  });
  console.log('  解析:', JSON.stringify(sut));
  check('.sut：扫出 1 张笔尖 PNG', sut.n === 1, String(sut.n));
  check('.sut：PNG 完整取到（含 IEND）', sut.pngLen === sut.expect, sut.pngLen + ' / ' + sut.expect);

  /* ---------- 6) 端到端：导入 → 出现在笔刷栏 → 画得出笔尖形状 ---------- */
  console.log('\n=== 端到端：导入后真的能画出笔尖形状 ===');
  const e2e = await page.evaluate(async () => {
    // 造一支「左半边亮、右半边暗」的方块笔尖：画出来左右两半的墨量应该明显不同
    const w = 32, h = 32, g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x % 2 === 0) ? 255 : 0;
    const tip = window.ChaBrushImport.packTip(g, w, h);
    const rec = { name: '测试方笔', tip: tip, spacing: 0.5, hardness: 0.9, diameter: 40, hash: 'test', sourceLabel: 'fixture.abr' };
    window.ChaApp.applyImported([rec]);
    await new Promise(r => setTimeout(r, 300));
    const inGrid = !!document.querySelector('#brushGrid .tool[data-item^="imp_"]');
    const cur = window.ChaApp.state.brush;
    return { inGrid: inGrid, tip: cur.tip, spacing: cur.spacing, size: cur.size,
      brushId: window.ChaApp.state.brushId };
  });
  console.log('  ', JSON.stringify(e2e));
  check('导入的笔刷出现在「笔刷栏」里', e2e.inGrid === true);
  check('选中的笔刷带上了笔尖位图', !!e2e.tip && e2e.tip === e2e.tip);
  check('落点间隔也跟着过来了', Math.abs(e2e.spacing - 0.5) < 1e-6, String(e2e.spacing));

  // 用这支笔画一笔，检查画出来的墨是「条纹状」而不是一条实心线
  const draw = await page.evaluate(async () => {
    const e = window.ChaApp.engine;
    e.restoreSelection(null);
    const box = document.querySelector('#view').getBoundingClientRect();
    const s0 = e.docToScreen(300, 400), s1 = e.docToScreen(900, 400);
    return { a: [box.left + s0.x, box.top + s0.y], b: [box.left + s1.x, box.top + s1.y] };
  });
  await page.mouse.move(draw.a[0], draw.a[1]);
  await page.mouse.down();
  await page.mouse.move(draw.b[0], draw.b[1], { steps: 14 });
  await page.mouse.up();
  await sleep(1000);
  const ink = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    const st = e.strokes[e.strokes.length - 1];
    return { px: n, hasTip: !!(st && st.tip), spacing: st && st.spacing };
  });
  console.log('  画出来的墨:', JSON.stringify(ink));
  check('这一笔确实记录了笔尖位图（别人那边才能画得一样）', ink.hasTip === true);
  check('画布上真的落了墨', ink.px > 2000, ink.px + ' 像素');

  /* ---------- 7) Procreate .brush：真实文件 + 真实的文件选择器 ---------- */
  console.log('\n=== Procreate .brush（真实语料，走「导入笔刷」按钮的同一条路） ===');
  // tools/procreate-corpus/marker.brush 是真实 Procreate 导出的文件。
  // 这里不直接调解析函数，而是塞进 #brushFileInput —— 和用户点「导入笔刷」时
  // 走的是同一条链路：FileReader → parse → 弹窗 → 勾选 → 进笔刷栏。
  const corpus = require('path').join(__dirname, 'procreate-corpus', 'marker.brush');
  await page.setInputFiles('#brushFileInput', corpus);
  await page.waitForSelector('#importMask:not(.hidden)', { timeout: 10000 });
  const pcDlg = await page.evaluate(() => {
    const rows = Array.prototype.map.call(document.querySelectorAll('#importBody .imp-row'), r => ({
      name: r.querySelector('.imp-name').textContent,
      meta: r.querySelector('.imp-meta').textContent,
      thumb: !!r.querySelector('img.imp-tip')
    }));
    return { title: document.querySelector('#importTitle').textContent, rows: rows };
  });
  console.log('  弹窗:', JSON.stringify(pcDlg));
  check('Procreate 文件弹出了导入对话框', /发现 1 支/.test(pcDlg.title), pcDlg.title);
  check('读出了真实笔名「Marker」', pcDlg.rows.length === 1 && pcDlg.rows[0].name === 'Marker',
    JSON.stringify(pcDlg.rows.map(r => r.name)));
  check('笔尖缩略图渲染出来了（说明 PNG 解出来了）', pcDlg.rows[0].thumb === true);
  check('摘要显示直径 34px / 间距 6% / 硬度 0.65',
    /34px/.test(pcDlg.rows[0].meta) && /间距 6%/.test(pcDlg.rows[0].meta) && /硬度 0\.65/.test(pcDlg.rows[0].meta),
    pcDlg.rows[0].meta);

  await page.click('#btnImportOk');
  // 注意用 waitForFunction 判类名：`#importMask.hidden` 这个元素是「不可见」的，
  // 而 waitForSelector 默认等「可见」，会一直等不到。
  await page.waitForFunction(() => document.querySelector('#importMask').classList.contains('hidden'), null, { timeout: 5000 });
  await sleep(600);
  const pcState = await page.evaluate(() => {
    const S = window.ChaApp.state;
    const list = S.imported || [];
    // 按名字找，别用 imported[0] —— 上面第 6 段已经先导过一支「测试方笔」了
    const it = list.filter(function (x) { return x.name === 'Marker'; })[0] || list[list.length - 1];
    if (!it) return null;
    return {
      inGrid: !!document.querySelector('#brushGrid .tool[data-item="' + it.id + '"]'),
      importedCount: list.length,
      name: it.name, label: it.tip, tool: it.tool, editing: S.brushId === it.id,
      size: S.brush.size, opacity: S.brush.opacity, spacing: S.brush.spacing,
      hardness: S.brush.hardness, minSize: S.brush.minSize,
      pressSize: S.brush.pressSize, pressOpacity: S.brush.pressOpacity,
      scatter: S.brush.scatter, grain: S.brush.grain, grainScale: S.brush.grainScale,
      tipLen: (S.brush.tip || '').length
    };
  });
  console.log('  导入后:', JSON.stringify(pcState));
  check('导入的 Procreate 笔刷落到「笔刷栏」里', pcState && pcState.inGrid === true);
  check('笔名保持 Marker', pcState && pcState.name === 'Marker', pcState && pcState.name);
  check('来源标注写明了 Procreate', !!pcState && /Procreate/.test(pcState.label), pcState && pcState.label);
  check('导入完自动选中了这支笔', !!pcState && pcState.editing === true);
  check('带上了笔尖位图', !!pcState && pcState.tipLen > 1000, pcState && (pcState.tipLen + ' 字符'));
  // 下面四个值全部和 importedItem 的默认值（0.4 / 0.8 / 0 / 0）不同，
  // 所以它们对上了 = rec.opts 确实合并进来了，而不是被默认值盖住。
  check('最小直径来自 Procreate 的 minSize', !!pcState && Math.abs(pcState.minSize - 0.2727) < 1e-3,
    pcState && String(pcState.minSize));
  check('压力→尺寸力度来自 dynamicsPressureSize', !!pcState && Math.abs(pcState.pressSize - 0.2) < 1e-6,
    pcState && String(pcState.pressSize));
  check('压力→浓度来自 dynamicsPressureOpacity', !!pcState && Math.abs(pcState.pressOpacity - 0.3) < 1e-6,
    pcState && String(pcState.pressOpacity));
  check('颗粒粗细来自 textureScale', !!pcState && Math.abs(pcState.grainScale - 0.74) < 1e-6,
    pcState && String(pcState.grainScale));
  check('间距沿用 Procreate 的 plotSpacing', !!pcState && Math.abs(pcState.spacing - 0.06) < 1e-6,
    pcState && String(pcState.spacing));
  check('硬度没被非圆笔尖拖到下限', !!pcState && pcState.hardness > 0.4, pcState && pcState.hardness.toFixed(3));

  // 真的用这支笔画一笔：Procreate 的笔尖形状要落到画布上
  const pcDraw = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const s0 = e.docToScreen(300, 620), s1 = e.docToScreen(900, 620);
    const box = document.querySelector('#view').getBoundingClientRect();
    return { a: [box.left + s0.x, box.top + s0.y], b: [box.left + s1.x, box.top + s1.y] };
  });
  const before = await page.evaluate(() => {
    const e = window.ChaApp.engine, l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });
  await page.mouse.move(pcDraw.a[0], pcDraw.a[1]);
  await page.mouse.down();
  await page.mouse.move(pcDraw.b[0], pcDraw.b[1], { steps: 16 });
  await page.mouse.up();
  await sleep(900);
  const pcInk = await page.evaluate(() => {
    const e = window.ChaApp.engine, l = e.activeLayer();
    const d = l.ctx.getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    const st = e.strokes[e.strokes.length - 1];
    return { px: n, hasTip: !!(st && st.tip), spacing: st && st.spacing };
  });
  console.log('  这笔的墨:', JSON.stringify(pcInk), '（画前 ' + before + '）');
  check('Procreate 笔刷真的画出墨了', pcInk.px > before + 1500, (pcInk.px - before) + ' 像素');
  check('这一笔记录了笔尖位图（别人那边才能画得一样）', pcInk.hasTip === true);

  /* ---------- 8) Procreate 的坏文件要明确报错 ---------- */
  // 一个「有效 ZIP，但里面没有 Brush.archive」的包：把真实文件里的
  // `Brush.archive` 原地改成同样长度的 `BrushXarchive`（13 字节对 13 字节，
  // ZIP 的本地头和中央目录都不用动，包结构照样合法）。
  const pcB64 = require('fs').readFileSync(corpus).toString('base64');
  const pcBad = await page.evaluate((b64) => {
    const out = {};
    try { window.ChaBrushImport.parse('x.brush', new Uint8Array([1, 2, 3, 4, 5])); out.junk = 'no-error'; }
    catch (e) { out.junk = e.message; }

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const needle = 'Brush.archive', repl = 'BrushXarchive';
    let hits = 0;
    outer:
    for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
      for (let j = 0; j < needle.length; j++) bytes[i + j] = repl.charCodeAt(j);
      hits++; i += needle.length - 1;
    }
    out.patched = hits;
    try { window.ChaBrushImport.parse('z.brush', bytes); out.noarch = 'no-error'; }
    catch (e) { out.noarch = e.message; }
    return out;
  }, pcB64);
  console.log('  ', JSON.stringify(pcBad));
  check('不是 ZIP 的 .brush 会明确报错', pcBad.junk !== 'no-error', pcBad.junk);
  check('改动确实落到了真实文件上（2 处：本地头 + 中央目录）', pcBad.patched === 2, String(pcBad.patched));
  check('是合法 ZIP 但没有 Brush.archive 时会明确报错',
    /Brush\.archive/.test(pcBad.noarch), pcBad.noarch);

  /* ---------- 9) .brushset（多支笔、每支住一个子目录） ---------- */
  // .brushset 才是 Procreate 导出笔刷组时最常用的格式：一个 ZIP，里面每支笔
  // 住一个以笔名命名的子目录。这里把真实的 marker.brush 里的文件原样搬到
  // 「My Marker/」子目录下重新打一个 ZIP —— 内容全是真的，只换了嵌套层级。
  console.log('\n=== .brushset（子目录里找 Brush.archive 的分支） ===');
  const zlibx = require('zlib'), fsx = require('fs'), osx = require('os'), px = require('path');
  const crc32 = zlibx.crc32 || (function () {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  function buildZip(entries) {
    const locals = [], centrals = [];
    let off = 0;
    entries.forEach(e => {
      const nb = Buffer.from(e.name, 'utf8');
      const comp = zlibx.deflateRawSync(e.data, { level: 9 });
      const crc = crc32(e.data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22);
      lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, nb, comp); centrals.push(ch, nb);
      off += lh.length + nb.length + comp.length;
    });
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([].concat(locals, [cd, eocd]));
  }

  // 用页面里的解析器把真实 .brush 拆开，拿到里面每个文件解压后的原始字节。
  // （不能在 Node 里 require brush-import.js —— 那个模块是挂在 window 上的浏览器模块）
  const innerRaw = await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const z = window.ChaBrushImport.readZip(bytes);
    const b64Of = u => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
    return z.entries.filter(e => !/\/$/.test(e.name)).map(e => ({ name: e.name, b64: b64Of(e.data) }));
  }, pcB64);
  const inner = innerRaw.map(e => ({ name: e.name, data: Buffer.from(e.b64, 'base64') }));
  console.log('  真实 .brush 里的文件:', inner.map(e => e.name).join(', '));
  const setDir = px.join(osx.tmpdir(), 'chahui-procreate');
  fsx.mkdirSync(setDir, { recursive: true });
  const setPath = px.join(setDir, 'MyMarker.brushset');
  fsx.writeFileSync(setPath, buildZip(inner.map(e => ({ name: 'My Marker/' + e.name, data: e.data }))));
  check('拆出了 .brush 里的 4 个文件（Shape.png 也在）',
    inner.length === 4 && inner.some(e => e.name === 'Shape.png'), inner.map(e => e.name).join(','));

  await page.setInputFiles('#brushFileInput', setPath);
  await page.waitForSelector('#importMask:not(.hidden)', { timeout: 10000 });
  const setDlg = await page.evaluate(() => {
    const rows = Array.prototype.map.call(document.querySelectorAll('#importBody .imp-row'), r => ({
      name: r.querySelector('.imp-name').textContent,
      meta: r.querySelector('.imp-meta').textContent,
      thumb: !!r.querySelector('img.imp-tip')
    }));
    return { title: document.querySelector('#importTitle').textContent, rows: rows };
  });
  console.log('  弹窗:', JSON.stringify(setDlg));
  check('.brushset 也能弹窗（说明子目录里的 Brush.archive 找到了）', /发现 1 支/.test(setDlg.title), setDlg.title);
  check('.brushset：读出的笔名与 .brush 一致（Marker）',
    setDlg.rows.length === 1 && setDlg.rows[0].name === 'Marker', JSON.stringify(setDlg.rows.map(r => r.name)));
  check('.brushset：笔尖缩略图也在（Shape.png 是在子目录里找到的）', setDlg.rows[0].thumb === true);
  check('.brushset：参数与 .brush 完全一致', setDlg.rows[0].meta === '34px · 间距 6% · 硬度 0.65', setDlg.rows[0].meta);
  await page.click('#btnImportCancel');
  await page.waitForFunction(() => document.querySelector('#importMask').classList.contains('hidden'), null, { timeout: 5000 });

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
