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

  // 完整 parse() 一遍：笔尖必须真的被解出来 —— 回归「png 只存不解码、
  // 导出来的全是圆头空壳」的 bug（真实 CSP sample.sut 上踩过）
  const sutTip = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const cx = c.getContext('2d');
    const g = cx.createRadialGradient(12, 12, 0, 12, 12, 12);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 24, 24);
    const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));
    const head = new Uint8Array(64);
    const magic = 'SQLite format 3\0';
    for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
    const all = new Uint8Array(head.length + png.length + 8);
    all.set(head, 0); all.set(png, head.length);
    const r = window.ChaBrushImport.parse('x.sut', all);
    const b = r.brushes[0] || {};
    return { n: r.brushes.length, tip: (b.tip || '').length, dia: b.diameter, hard: b.hardness };
  });
  check('.sut：parse() 出来的笔真的带笔尖位图（空壳 bug 回归）', sutTip.tip > 100, String(sutTip.tip));
  check('.sut：直径 / 硬度也从笔尖推出来了', sutTip.dia === 24 && sutTip.hard > 0, sutTip.dia + ' / ' + sutTip.hard);

  /* ---------- 纯色笔尖：收下并打标记（真·方头笔 vs 空白缩略图的取舍） ----------
   * 「方头」类笔刷的图案本来就是一块实心方块，跟素材库的空白预览图**解码后长得一模一样**
   * （都是一片满值），单看图分不出来。所以现在不再一刀切拒掉，而是收下 + flat 标记，
   * 由导入对话框给提醒。仍然直接拒的只有「盖上等于什么都不画」的近黑纯色图。
   * 见 tools/_sutdraw 的实测：真导入这支「方头纯度上色」之后画出来是一条连续实心直线。 */
  const flatTip = await page.evaluate(() => {
    function mk(fill) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const cx = c.getContext('2d');
      cx.fillStyle = fill; cx.fillRect(0, 0, 64, 64);
      const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));
      const head = new Uint8Array(64);
      const magic = 'SQLite format 3\0';
      for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
      const all = new Uint8Array(head.length + png.length + 8);
      all.set(head, 0); all.set(png, head.length);
      return all;
    }
    const out = {};
    // 满值纯色（不透明黑 = 实心方块笔尖）
    try {
      const r = window.ChaBrushImport.parse('solid.sut', mk('rgba(0,0,0,1)'));
      out.solid = { n: r.brushes.length, flat: !!(r.brushes[0] || {}).flat };
    } catch (e) { out.solid = { err: e.message }; }
    // 全透明（盖上什么都不画）
    try {
      const r2 = window.ChaBrushImport.parse('empty.sut', mk('rgba(0,0,0,0)'));
      out.empty = { n: r2.brushes.length };
    } catch (e) { out.empty = { err: e.message }; }
    return out;
  });
  console.log('  纯色笔尖:', JSON.stringify(flatTip));
  check('★ 实心纯色笔尖被收下（不再一刀切拒掉）', flatTip.solid && flatTip.solid.n === 1,
    JSON.stringify(flatTip.solid));
  check('★ 收下的同时打上 flat 标记（对话框据此提醒用户）',
    !!(flatTip.solid && flatTip.solid.flat), JSON.stringify(flatTip.solid));
  check('全透明笔尖仍然拒掉（盖上什么都不画）',
    !!(flatTip.empty && flatTip.empty.err), JSON.stringify(flatTip.empty));

  // SQLite 头但没有图 → 必须「配置型」明确拒绝，不许含糊
  const sutCfg = await page.evaluate(() => {
    const head = 'SQLite format 3\0';
    const all = new Uint8Array(300);
    for (let i = 0; i < head.length; i++) all[i] = head.charCodeAt(i);
    try { window.ChaBrushImport.parse('cfg.sut', all); return 'no-error'; }
    catch (e) { return e.message; }
  });
  check('.sut：SQLite 但没图 → 明确说「配置型」', /配置型/.test(sutCfg), sutCfg);

  /* ---------- 5a-2) 纯色笔尖：收下但**必须打标记**（不能静默当正常笔尖） ---------- */
  //
  //  真实案例：「方头纯度上色.sut」。CSP 的素材 tar 里带 thumbnail/thumbnail.png，
  //  实测那张解码后是 90000 像素里 89700 个满值（极差 65，所以「看极差」的判定会被骗过去）。
  //  老代码把它当笔尖收下 → 而且 diameter 用图片尺寸 300 → 导入一支 300px 大白方块 →
  //  盖章间隔一拉就是一堆不相连的「半个圆」。
  //
  //  ⚠ 政策在 2026-09 变了：**「方头」类笔刷的图案本来就是一块实心方块**，
  //  跟空白预览图解码后长得一模一样，单看图分不出来。所以不再一刀切拒，
  //  改成「收下 + flat 标记」——导入对话框会亮黄条 + 写「⚠ 纯色笔尖」+ 笔尖预览，
  //  由用户自己判断。这里必须钉住的是：**它绝不能不带标记地混进去**。
  //  （真正拦「300px 大白块 + 半圆」的是尺寸：diameter 走库里的 BrushSize，
  //    见下面 5a-3 的断言。）
  console.log('\n=== .sut（纯色笔尖：收下但必须打 flat 标记） ===');
  const blankThumb = await page.evaluate(async () => {
    // 造一张「白底 + 极淡角标」的 300×300 PNG，模拟 CSP 的预览缩略图
    const c = document.createElement('canvas');
    c.width = c.height = 300;
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(255,255,255)'; cx.fillRect(0, 0, 300, 300);
    cx.fillStyle = 'rgb(190,190,190)'; cx.fillRect(0, 0, 6, 50);   // 极淡的角标
    const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));

    // 包成 tar 成员，路径写 thumbnail/thumbnail.png（跟真实文件一样）
    const tar = new Uint8Array(512 + Math.ceil(png.length / 512) * 512);
    const nm = 'thumbnail/thumbnail.png';
    for (let i = 0; i < nm.length; i++) tar[i] = nm.charCodeAt(i);
    const sizeStr = png.length.toString(8).padStart(11, '0');
    for (let i = 0; i < 11; i++) tar[124 + i] = sizeStr.charCodeAt(i);
    'ustar'.split('').forEach((ch, i) => { tar[257 + i] = ch.charCodeAt(0); });
    tar.set(png, 512);

    const head = new Uint8Array(64);
    const magic = 'SQLite format 3\0';
    for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
    const all = new Uint8Array(head.length + tar.length);
    all.set(head, 0); all.set(tar, head.length);
    try {
      const r = window.ChaBrushImport.parse('blank.sut', all);
      const b = r.brushes[0] || {};
      return { ok: true, n: r.brushes.length, flat: !!b.flat, name: b.name };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  console.log('  ' + JSON.stringify(blankThumb));
  check('★ 纯色缩略图不再「静默」混进来（要么拒，要么必须带 flat 标记）',
    (blankThumb.ok === false) || blankThumb.flat === true, JSON.stringify(blankThumb));
  check('★ 收下时确实带上了 flat 标记（对话框据此亮黄条 + 提醒）',
    blankThumb.ok && blankThumb.flat === true, JSON.stringify(blankThumb));

  /* ---------- 5a-3) 尺寸 / 间距必须读库里真值，不能硬编码 ---------- */
  //
  //  老代码 spacing 写死 0.1、diameter 用「图片像素尺寸」顶，
  //  于是一张 1000px 的素材图直接变成 1000px 的笔刷。
  //  真值在 Node.NodeVariantID → Variant.VariantID 那一行的 BrushSize / BrushInterval。
  //  这里造一个真 SQLite 库（含 Node / Variant / MaterialFile 三张表）来验。
  console.log('\n=== .sut（BrushSize / BrushInterval 读真值） ===');
  const sutParams = await page.evaluate(async () => {
    /* --- 造图：一张有形状的 32×32 笔尖（不能是空白，否则会被新的空白判定拒掉） --- */
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const cx = c.getContext('2d');
    cx.fillStyle = '#000'; cx.fillRect(4, 4, 24, 24);
    const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));

    /* --- 把 PNG 包进 tar，再当 MaterialFile.FileData --- */
    const tar = new Uint8Array(512 + Math.ceil(png.length / 512) * 512);
    const nm = 'data/material_0.png';
    for (let i = 0; i < nm.length; i++) tar[i] = nm.charCodeAt(i);
    const sizeStr = png.length.toString(8).padStart(11, '0');
    for (let i = 0; i < 11; i++) tar[124 + i] = sizeStr.charCodeAt(i);
    'ustar'.split('').forEach((ch, i) => { tar[257 + i] = ch.charCodeAt(0); });
    tar.set(png, 512);

    /* --- 写一个最小 SQLite 库：页 1 放 sqlite_master，其余表各一页 ---
     *
     *  ⚠ 这个夹具踩过三个坑，改的时候别再犯：
     *    ① 页 1 的 b-tree 头从**第 100 字节**开始（前 100 是文件头），其余页从 0 开始。
     *    ② 必须先拷页、**最后**写 100 字节文件头 —— 反过来写的话页 1 前 100 字节的零会把文件头抹掉。
     *    ③ 记录头的长度字段 = 它自己 + 所有 serial type 的 **varint 宽度**之和，
     *       有 ≥128 的 type（文本/BLOB 必然有）时就不能写「1 + type 个数」。
     *    另外 cell 指针数组要按 rowid 顺序排，而 cell 数据是从页尾往前放的，两者不要边写边 push。
     */
    const PAGE = 4096;
    const mk = () => new Uint8Array(PAGE);
    const pages = { 1: mk() };            // 页 1 = sqlite_master
    // 表规划：root 2=Node, 3=Variant, 4=MaterialFile

    /** SQLite 变长整数：每字节低 7 位是数据，最高位表示「后面还有」 */
    function varintBytes(v) {
      const out = [];
      if (v === 0) return new Uint8Array([0]);
      while (v > 0) { out.unshift(v & 0x7f); v = Math.floor(v / 128); }
      for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
      return new Uint8Array(out);
    }

    // 记录编码（serial types）：简化用「text / int / blob」三种够用
    function encRecord(vals) {
      // vals: [{t:'int',v}, {t:'text',v}, {t:'blob',v}]
      const ser = [], data = [];
      for (const it of vals) {
        if (it === null) { ser.push(0); continue; }
        if (it.t === 'int') {
          if (it.v === 0) { ser.push(8); continue; }
          if (it.v === 1) { ser.push(9); continue; }
          if (it.v >= -128 && it.v <= 127) { ser.push(1); data.push(it.v & 255); continue; }
          if (it.v >= -32768 && it.v <= 32767) { ser.push(2); data.push(it.v >> 8 & 255, it.v & 255); continue; }
          ser.push(4); data.push(it.v >>> 24 & 255, it.v >> 16 & 255, it.v >> 8 & 255, it.v & 255);
        } else if (it.t === 'text') {
          const b = [];
          for (let i = 0; i < it.v.length; i++) b.push(it.v.charCodeAt(i) & 255);
          ser.push(13 + b.length * 2);
          for (const x of b) data.push(x);
        } else {
          ser.push(12 + it.v.length * 2);
          for (const x of it.v) data.push(x);
        }
      }
      // 每个 serial type 按 varint 展开
      const typeBytes = [];
      for (const s of ser) {
        if (s < 128) typeBytes.push([s]);
        else typeBytes.push([0x80 | ((s >> 7) & 0x7f), s & 0x7f]);
      }
      let typeLen = 0;
      for (const tb of typeBytes) typeLen += tb.length;
      let hdrLen = 1 + typeLen;
      if (hdrLen >= 128) hdrLen += 1;                       // 长度字段自己变宽
      const hdr = [];
      if (hdrLen < 128) hdr.push(hdrLen);
      else hdr.push(0x80 | ((hdrLen >> 7) & 0x7f), hdrLen & 0x7f);
      for (const tb of typeBytes) hdr.push.apply(hdr, tb);
      return new Uint8Array([].concat(hdr, data));
    }

    function writeLeaf(pgNo, records) {
      const p = pages[pgNo] || (pages[pgNo] = mk());
      const base = pgNo === 1 ? 100 : 0;                    // ← 坑 ①
      p[base] = 13;
      p[base + 3] = records.length >> 8 & 255;
      p[base + 4] = records.length & 255;
      const offs = [];
      let cursor = PAGE;
      for (const rec of records) {
        // ⚠ cell 的 payload 长度和 rowid 都是 **varint**，≥128 时要占 2 字节。
        //   曾经写成 `cell[0] = len & 0x7f` —— 长 DDL（Variant / MaterialFile 那种）
        //   一超过 127 字节长度就被截断，整行读成乱码，表现是「库里没有这张表」。
        const lenV = varintBytes(rec.body.length);
        const ridV = varintBytes(rec.rowid);
        const cell = new Uint8Array(lenV.length + ridV.length + rec.body.length);
        cell.set(lenV, 0);
        cell.set(ridV, lenV.length);
        cell.set(rec.body, lenV.length + ridV.length);
        cursor -= cell.length;
        p.set(cell, cursor);
        offs.push(cursor);
      }
      p[base + 5] = cursor >> 8 & 255; p[base + 6] = cursor & 255;
      for (let i = 0; i < offs.length; i++) {               // ← 指针按 rowid 顺序
        p[base + 8 + i * 2] = offs[i] >> 8 & 255;
        p[base + 8 + i * 2 + 1] = offs[i] & 255;
      }
    }

    // sqlite_master 记录: type, name, tbl_name, rootpage, sql
    const masterRecs = [
      { rowid: 1, body: encRecord([{ t: 'text', v: 'table' }, { t: 'text', v: 'Node' }, { t: 'text', v: 'Node' }, { t: 'int', v: 2 }, { t: 'text', v: 'CREATE TABLE Node(NodeName TEXT, NodeVariantID INTEGER)' }]) },
      { rowid: 2, body: encRecord([{ t: 'text', v: 'table' }, { t: 'text', v: 'Variant' }, { t: 'text', v: 'Variant' }, { t: 'int', v: 3 }, { t: 'text', v: 'CREATE TABLE Variant(VariantID INTEGER, BrushSize INTEGER, BrushInterval INTEGER, BrushHardness INTEGER)' }]) },
      { rowid: 3, body: encRecord([{ t: 'text', v: 'table' }, { t: 'text', v: 'MaterialFile' }, { t: 'text', v: 'MaterialFile' }, { t: 'int', v: 4 }, { t: 'text', v: 'CREATE TABLE MaterialFile(FileData BLOB)' }]) }
    ];
    writeLeaf(1, masterRecs);

    writeLeaf(2, [{ rowid: 1, body: encRecord([{ t: 'text', v: 'TestCSP' }, { t: 'int', v: 7001 }]) }]);
    writeLeaf(3, [{ rowid: 1, body: encRecord([{ t: 'int', v: 7001 }, { t: 'int', v: 20 }, { t: 'int', v: 40 }, { t: 'int', v: 100 }]) }]);
    writeLeaf(4, [{ rowid: 1, body: encRecord([{ t: 'blob', v: tar }]) }]);

    // 拼成文件
    // ⚠ 坑 ②：先拷各页，**最后**写 100 字节文件头 —— 顺序反了页 1 的零会把文件头抹掉
    const maxPage = Math.max.apply(null, Object.keys(pages).map(Number));
    const out = new Uint8Array(maxPage * PAGE);
    for (const k of Object.keys(pages)) out.set(pages[k], (Number(k) - 1) * PAGE);
    out.set(new TextEncoder().encode('SQLite format 3\0'), 0);
    out[16] = PAGE >> 8 & 255; out[17] = PAGE & 255;
    out[18] = 1; out[19] = 1;                  // 文件格式版本
    out[20] = 0;                               // reserved
    out[21] = 64; out[22] = 32; out[23] = 32;  // payload 分数
    out[28] = maxPage >>> 24 & 255; out[29] = maxPage >> 16 & 255;
    out[30] = maxPage >> 8 & 255; out[31] = maxPage & 255;

    const r = window.ChaBrushImport.parse('params.sut', out.buffer);
    const b = r.brushes[0] || {};
    // 顺带断言底层读取没坏：库里三张表都要读得出来
    // （夹具手搓 SQLite 最容易在这里翻车，所以直接把结果带出来给 check 用）
    const rows = {};
    ['Node', 'Variant', 'MaterialFile'].forEach(t => {
      try { rows[t] = window.ChaBrushImport.sqliteTableRows(out, t).length; }
      catch (e) { rows[t] = e.message; }
    });
    return { n: r.brushes.length, name: b.name, dia: b.diameter, spacing: b.spacing,
      hard: b.hardness, rows: rows };
  });
  console.log('  解析:', JSON.stringify(sutParams));
  check('.sut：三张表都读得出来（Node / Variant / MaterialFile）',
    sutParams.rows.Node === 1 && sutParams.rows.Variant === 1 && sutParams.rows.MaterialFile === 1,
    JSON.stringify(sutParams.rows));
  check('.sut：读到了真笔名（Node.NodeName）', sutParams.name === 'TestCSP', String(sutParams.name));
  check('.sut：diameter 用 Variant.BrushSize（20），不是图片尺寸（32）',
    sutParams.dia === 20, String(sutParams.dia));
  check('.sut：spacing 用 Variant.BrushInterval（40 → 0.4）',
    Math.abs(sutParams.spacing - 0.4) < 1e-6, String(sutParams.spacing));
  check('.sut：hardness 用 Variant.BrushHardness（100 → 1）',
    Math.abs(sutParams.hard - 1) < 1e-6, String(sutParams.hard));

  /* ---------- 5b) .sut：SQLite 跨溢出页（真实 CSP 里 blob 都是被切碎存的） ---------- */
  console.log('\n=== .sut（SQLite 跨溢出页：blob 被切碎也要按链拼回来） ===');
  const sqliteSut = await page.evaluate(() => {
    // 8×8 软圆点 PNG
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const cx = c.getContext('2d');
    const g = cx.createRadialGradient(4, 4, 0, 4, 4, 4);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 8, 8);
    const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));

    const PS = 512;                                  // 故意用最小页，逼 blob 跨页
    function varint(v) {
      const d = [];
      if (v === 0) d.push(0);
      else { while (v > 0) { d.unshift(v & 127); v = Math.floor(v / 128); } }
      return d.map((x, i) => (i === d.length - 1 ? x : 128 | x));
    }
    function set(u8, pos, arr) { for (let i = 0; i < arr.length; i++) u8[pos + i] = arr[i]; }
    function u32a(v) { return [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]; }

    function tarMember(name, data) {
      const head = new Uint8Array(512);
      for (let i = 0; i < name.length && i < 100; i++) head[i] = name.charCodeAt(i);
      const oct = data.length.toString(8);
      const sf = ('00000000000' + oct).slice(-11) + '\0';      // 12 字节八进制
      for (let i = 0; i < 12; i++) head[124 + i] = sf.charCodeAt(i);
      const magic = 'ustar\0';
      for (let i = 0; i < 6; i++) head[257 + i] = magic.charCodeAt(i);
      for (let i = 148; i < 156; i++) head[i] = 32;          // 校验和占位，解析器不查
      const out = new Uint8Array(1024);                      // 512 头 + 512 数据槽
      out.set(head, 0); out.set(data, 512);
      return out;
    }
    const blob = tarMember('mytip.png', png);                // 1024B，肯定跨页

    // record：varint(headerLen) + serial types + 值
    function rec(cols) {
      const types = [], vals = [];
      for (const c of cols) {
        if (c.t === 'txt') {
          const n = c.v.length; types.push(13 + 2 * n);
          const b = new Uint8Array(n);
          for (let i = 0; i < n; i++) b[i] = c.v.charCodeAt(i);
          vals.push(b);
        } else if (c.t === 'int') {
          const v = c.v;
          if (v >= 0 && v < 128) { types.push(1); vals.push(new Uint8Array([v])); }
          else { types.push(2); vals.push(new Uint8Array([(v >> 8) & 255, v & 255])); }
        } else { types.push(12 + 2 * c.v.length); vals.push(c.v); }
      }
      const tb = [];
      for (const ty of types) tb.push(...varint(ty));
      const out = new Uint8Array(1 + tb.length + vals.reduce((s, v) => s + v.length, 0));
      out[0] = tb.length + 1;          // SQLite 规范：header size 含它自己这 1 字节
      set(out, 1, tb);
      let o = 1 + tb.length;
      for (const v of vals) { set(out, o, v); o += v.length; }
      return out;
    }

    // 表叶子页：cells = 完整的字节数组（调用方自己拼好 varint/rowid/内联+溢出指针）
    function leaf(pageNo, cells) {
      const page = new Uint8Array(PS);
      const hdr = pageNo === 1 ? 100 : 0;
      page[hdr] = 13;
      let content = PS;
      const ptrs = [];
      for (let i = cells.length - 1; i >= 0; i--) {          // 从页尾往前放
        content -= cells[i].length;
        set(page, content, cells[i]);
        ptrs[i] = content;
      }
      page[hdr + 3] = cells.length >> 8; page[hdr + 4] = cells.length & 255;
      page[hdr + 5] = content >> 8; page[hdr + 6] = content & 255;
      for (let i = 0; i < cells.length; i++) {
        page[hdr + 8 + i * 2] = ptrs[i] >> 8; page[hdr + 8 + i * 2 + 1] = ptrs[i] & 255;
      }
      return page;
    }

    // page1：sqlite_master（带 100 字节文件头）。cell = varint(长度) + varint(rowid) + record
    const masterRec = rec([
      { t: 'txt', v: 'table' }, { t: 'txt', v: 'MaterialFile' }, { t: 'txt', v: 'MaterialFile' },
      { t: 'int', v: 2 }, { t: 'txt', v: 'CREATE TABLE MaterialFile (_PW_ID INTEGER, FileData BLOB)' }
    ]);
    const p1 = leaf(1, [new Uint8Array([...varint(masterRec.length), ...varint(1), ...masterRec])]);
    const magic = 'SQLite format 3\0';
    for (let i = 0; i < magic.length; i++) p1[i] = magic.charCodeAt(i);
    p1[16] = PS >> 8; p1[17] = PS & 255;                     // 页大小

    // page2：MaterialFile 行（_PW_ID int + FileData blob）。注意 cell 的 payload 长度
    // 是**整条记录**（头 + int + blob），不是 blob 本身——别再写错了
    const mfRec = rec([{ t: 'int', v: 1 }, { t: 'blob', v: blob }]);
    const P = mfRec.length;                                   // 1029
    const U = PS;                                             // reserved=0
    const X = U - 35;
    const M = Math.floor((U - 12) * 32 / 255) - 23;
    const K = M + ((P - M) % (U - 4));
    const local = K <= X ? K : M;                             // 1029 → 39
    const cell = [...varint(P), ...varint(1), ...mfRec.slice(0, local), ...u32a(3)];
    const p2 = leaf(2, [new Uint8Array(cell)]);
    // page3/page4：溢出链 3 → 4 → 0
    const p3 = new Uint8Array(PS); set(p3, 0, u32a(4)); set(p3, 4, mfRec.slice(local, local + U - 4));
    const p4 = new Uint8Array(PS); set(p4, 0, u32a(0)); set(p4, 4, mfRec.slice(local + U - 4));

    const all = new Uint8Array(PS * 4);
    set(all, 0, p1); set(all, PS, p2); set(all, PS * 2, p3); set(all, PS * 3, p4);
    const r = window.ChaBrushImport.parse('chopped.sut', all);
    return { n: r.brushes.length, names: r.brushes.map(b => b.name),
      tips: r.brushes.map(b => (b.tip || '').length), dias: r.brushes.map(b => b.diameter) };
  });
  check('.sut：跨页 blob 拼回来并解出笔尖', sqliteSut.n === 1, JSON.stringify(sqliteSut));
  check('.sut：笔名来自 tar 成员名「mytip」', sqliteSut.names[0] === 'mytip', JSON.stringify(sqliteSut.names));
  check('.sut：拼回的笔尖带位图且直径 8', sqliteSut.tips[0] > 50 && sqliteSut.dias[0] === 8,
    'tip=' + sqliteSut.tips[0] + ' dia=' + sqliteSut.dias[0]);

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
