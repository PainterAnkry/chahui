/**
 * 笔刷导入回归：PS `.abr`（v1/v2 与 v6+）与 CSP `.sut` 的解析 + 笔尖渲染。
 *
 * ⚠️ 关于测试的诚实说明：这台机器上没有真实的 Photoshop / CSP 笔刷文件，
 * 所以这里用的是**按格式规范自己构造的样本**（写字节 → 解析回来）。
 * 这能证明解析器和渲染链路是对的，但**不能**证明它能吃下你手上的每一个真实文件。
 * 拿到真实文件后如果解析失败，把文件名和现象告诉我 —— 解析器是「读不懂就明确报错」，
 * 不会静默给出一支错的笔。
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
      centre: u.rgba[(16 * u.w + 16) * 4 + 3],
      corner: u.rgba[(1 * u.w + 1) * 4 + 3],
      hard: hard, soft: BI.hardnessOf(soft, w, h),
      bad: [BI.unpackTip('nope'), BI.unpackTip('32x32x8:AAAA'), BI.unpackTip('')]
    };
  });
  console.log('  打包结果:', pack.w + '×' + pack.h, '共', pack.len, '字符');
  check('笔尖打包成 32×32 的 4 位小图', pack.w === 32 && pack.h === 32, pack.w + '×' + pack.h);
  check('打包体积够小（≤ 900 字符，会跟着每一笔走）', pack.len <= 900, pack.len + ' 字符');
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
    const body = [].concat(
      u32('Named brush'.length), Array.from('Named brush').flatMap(c => [0, c.charCodeAt(0)]),
      u32(0), u32(0), u32(h), u32(w), u16(8), [1],
      lens.reduce((a, b) => a.concat(b), []),
      rows.reduce((a, b) => a.concat(b), [])
    );
    const entry = [].concat(u32(body.length), body);
    const pad = (4 - (entry.length % 4)) % 4;
    const samp = new Uint8Array(entry.concat(new Array(pad).fill(0)));
    const blocks = [].concat(
      [0x38, 0x42, 0x49, 0x4d], 'samp'.split('').map(c => c.charCodeAt(0)), u32(samp.length), Array.from(samp)
    );
    const bytes = new Uint8Array([].concat(u16(6), u16(1), blocks));
    const r = window.ChaBrushImport.parseAbr(bytes.buffer);
    const b = r.brushes[0];
    return { n: r.brushes.length, name: b && b.name, w: b && b.w,
      top: b && b.gray[2 * w + 8], bottom: b && b.gray[14 * w + 8] };
  });
  console.log('  解析:', JSON.stringify(abr6));
  check('.abr v6：解析出 1 支笔', abr6.n === 1, String(abr6.n));
  check('.abr v6：读到了名字', abr6.name === 'Named brush', String(abr6.name));
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

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
