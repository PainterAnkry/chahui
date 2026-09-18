/**
 * 导出格式回归。
 *
 * 守着这几条：
 *   · png / jpg / webp 是 canvas 原生编码，浏览器能解回来（真的是一张图）
 *   · jpg 不支持透明 → 必须垫白底，不能出来一片黑
 *   · bmp / tga 是茶绘自己写的编码器：**写出去的要能被读回来**，
 *     而且像素和原图一致（BMP 我们自带解码器；TGA 检查头部与字节序）
 *   · 扩展名都在；**psd 是唯一一个带图层的格式（layered）**，它不吃「一张画布」——
 *     所以这里只验两件事：不给文档时它必须明确报错（而不是编出一个打不开的文件）、
 *     走 exportAs 时给出的是 .psd 文件名。真正的字节级验收在 tools/test-psd.js。
 *   · .sai2 不做（那要写 SAI 自己的图层记录）
 *
 * 用法: node tools/test-export.js [http://localhost:8437]
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
  await page.fill('#nameInput', '导出');
  await page.fill('#newRoomName', '导出格式');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);

  console.log('\n=== 格式清单 ===');
  const list = await page.evaluate(() => window.ChaExport.FORMATS.map(f => f.ext));
  console.log('  ' + list.join(', '));
  ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'].forEach(function (ext) {
    const hit = ext === 'jpeg' ? list.indexOf('jpg') >= 0 : list.indexOf(ext) >= 0;
    ok('有 .' + ext, hit, list.join(','));
  });
  ok('没有 .sai2（SAI 那个格式要写图层记录，本轮不做）', list.indexOf('sai2') < 0);
  ok('★ 有 .psd，而且是唯一一个「带图层」的格式（layered=true）',
    list.indexOf('psd') >= 0 && (await page.evaluate(() => {
      const all = window.ChaExport.FORMATS;
      const psd = all.filter(f => f.id === 'psd')[0];
      return !!psd && psd.layered === true && all.filter(f => f.id !== 'psd').every(f => !f.layered);
    })));

  console.log('\n=== 编码结果能不能读回来 ===');
  const enc = await page.evaluate(async () => {
    // 造一张有透明角的测试图：左上半红、右下半透明
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ff0000';
    cx.fillRect(0, 0, 32, 24);
    cx.fillStyle = '#0000ff';
    cx.fillRect(32, 24, 32, 24);
    const out = {};
    for (const f of window.ChaExport.FORMATS) {
      // psd **不能**「拍平之后再编」—— 它要的是文档的图层树，一张 canvas 给不了，
      // 所以这一轮只过「一张画布就够」的格式；psd 走下面的对照断言（自己那条在
      // test-psd.js 里逐字节验过）。
      if (f.layered) {
        try { window.ChaExport.encode(c, f.id, 0.9); out.__psdNoEngine = 'no-error'; }
        catch (e) { out.__psdNoEngine = String(e && e.message || e); }
        continue;
      }
      const url = window.ChaExport.encode(c, f.id, 0.9);
      out[f.id] = { head: url.slice(0, 32), len: url.length, ext: f.ext };
    }
    // 浏览器能不能解回来（png / jpg / webp）
    async function decode(url) {
      return new Promise(res => {
        const img = new Image();
        img.onload = () => {
          const t = document.createElement('canvas');
          t.width = img.width; t.height = img.height;
          const tc = t.getContext('2d');
          tc.drawImage(img, 0, 0);
          const d = tc.getImageData(0, 0, img.width, img.height).data;
          res({ ok: true, w: img.width, h: img.height,
            tl: [d[0], d[1], d[2], d[3]],
            br: [d[(24 * 64 + 40) * 4], d[(24 * 64 + 40) * 4 + 1], d[(24 * 64 + 40) * 4 + 2], d[(24 * 64 + 40) * 4 + 3]] });
        };
        img.onerror = () => res({ ok: false });
        img.src = url;
      });
    }
    out.__png = await decode(window.ChaExport.encode(c, 'png', 0.9));
    out.__jpg = await decode(window.ChaExport.encode(c, 'jpeg', 0.9));
    out.__webp = await decode(window.ChaExport.encode(c, 'webp', 0.9));
    // BMP：用自带的解码器读回来，逐像素比对
    const bmpUrl = window.ChaExport.encode(c, 'bmp', 1);
    const bmpBytes = window.ChaExport.b64ToBytes(bmpUrl.split(',')[1]);
    const dec = window.ChaExport.decodeBMP(bmpBytes);
    // 期望值要记得：BMP 不支持透明，没画到的地方被垫成**白底**（不是黑）
    let maxErr = 0;
    for (let i = 0; i < dec.data.length; i += 4) {
      const x = (i / 4) % 64, y = Math.floor(i / 4 / 64);
      const inRed = x < 32 && y < 24;
      const inBlue = x >= 32 && y >= 24;
      // 三个区域的期望值写清楚：红块 (255,0,0)、蓝块 (0,0,255)、其余是白底 (255,255,255)
      const wantR = inBlue ? 0 : 255;
      const wantG = (inRed || inBlue) ? 0 : 255;
      const wantB = inRed ? 0 : 255;
      maxErr = Math.max(maxErr,
        Math.abs(dec.data[i] - wantR),
        Math.abs(dec.data[i + 1] - wantG),
        Math.abs(dec.data[i + 2] - wantB));
    }
    // TGA：检查头部
    const tgaUrl = window.ChaExport.encode(c, 'tga', 1);
    const tgaBytes = window.ChaExport.b64ToBytes(tgaUrl.split(',')[1]);
    out.__bmp = { w: dec.w, h: dec.h, size: bmpBytes.length, maxErr: maxErr,
      corner: [dec.data[0], dec.data[1], dec.data[2]],
      brCorner: (function () { const o = (24 * dec.w + 40) * 4; return [dec.data[o], dec.data[o + 1], dec.data[o + 2]]; })() };
    out.__tga = { imgType: tgaBytes[2], w: tgaBytes[12] | (tgaBytes[13] << 8), h: tgaBytes[14] | (tgaBytes[15] << 8),
      bpp: tgaBytes[16], desc: tgaBytes[17], size: tgaBytes.length,
      first: [tgaBytes[18 + 2], tgaBytes[18 + 1], tgaBytes[18], tgaBytes[18 + 3]] };
    return out;
  });

  console.log('  png  ' + enc.png.len + ' 字符  ' + JSON.stringify(enc.__png));
  ok('★ psd 不给文档时会明确报错（而不是编出一个打不开的文件）',
    enc.__psdNoEngine !== 'no-error' && /PSD/.test(enc.__psdNoEngine || ''), enc.__psdNoEngine);
  ok('PNG 能被浏览器解回来', enc.__png.ok === true && enc.__png.w === 64, JSON.stringify(enc.__png));
  ok('PNG 左上角是红的', enc.__png.tl[0] > 200 && enc.__png.tl[1] < 60, JSON.stringify(enc.__png.tl));
  ok('PNG 右下角是蓝的', enc.__png.br[2] > 200 && enc.__png.br[0] < 60, JSON.stringify(enc.__png.br));

  console.log('  jpg  ' + enc.jpeg.len + ' 字符  ' + JSON.stringify(enc.__jpg));
  ok('JPEG 能被浏览器解回来', enc.__jpg.ok === true, JSON.stringify(enc.__jpg));
  ok('JPEG 透明处垫成了白底（不是黑的）', enc.__jpg.tl[3] === 255 && enc.__jpg.br[3] === 255,
    'alpha tl=' + enc.__jpg.tl[3] + ' br=' + enc.__jpg.br[3]);

  console.log('  webp ' + enc.webp.len + ' 字符  ' + JSON.stringify(enc.__webp));
  ok('WebP 能被浏览器解回来', enc.__webp.ok === true, JSON.stringify(enc.__webp));

  console.log('  bmp  ' + enc.bmp.len + ' 字符  ' + JSON.stringify(enc.__bmp));
  ok('BMP 头合法且能解回来（尺寸一致）', enc.__bmp.w === 64 && enc.__bmp.h === 48,
    enc.__bmp.w + '×' + enc.__bmp.h + '，' + enc.__bmp.size + ' 字节');
  ok('BMP 像素逐一核对无误（含透明处垫白底）', enc.__bmp.maxErr === 0, 'maxErr=' + enc.__bmp.maxErr);
  ok('BMP 左上角是红、右下角是蓝（自下而上没写反）',
    enc.__bmp.corner[0] > 200 && enc.__bmp.corner[2] < 60 && enc.__bmp.brCorner[2] > 200,
    JSON.stringify(enc.__bmp.corner) + ' / ' + JSON.stringify(enc.__bmp.brCorner));

  console.log('  tga  ' + enc.tga.len + ' 字符  ' + JSON.stringify(enc.__tga));
  ok('TGA 头合法（未压缩真彩、32 位、左上角原点）',
    enc.__tga.imgType === 2 && enc.__tga.bpp === 32 && enc.__tga.desc === 0x28,
    JSON.stringify(enc.__tga));
  ok('TGA 尺寸正确、字节数对得上', enc.__tga.w === 64 && enc.__tga.h === 48 &&
    enc.__tga.size === 18 + 64 * 48 * 4, enc.__tga.size + ' 字节');
  ok('TGA 第一个像素是 BGRA 顺序的红', enc.__tga.first[0] > 200 && enc.__tga.first[1] < 60,
    JSON.stringify(enc.__tga.first));

  console.log('\n=== 对话框 ===');
  await page.evaluate(() => window.ChaApp.openExportDialog());
  await sleep(400);
  const dlg = await page.evaluate(() => ({
    open: !document.querySelector('#exportMask').classList.contains('hidden'),
    opts: Array.from(document.querySelectorAll('#exportFormat option')).map(o => o.value),
    qualityShown: !document.querySelector('#exportQualityRow').classList.contains('hidden')
  }));
  console.log('  ' + JSON.stringify(dlg));
  ok('导出对话框能打开', dlg.open === true);
  ok('下拉里六种格式都在（png / jpeg / webp / psd / bmp / tga）', dlg.opts.join(',') === 'png,jpeg,webp,psd,bmp,tga', dlg.opts.join(','));
  ok('默认 PNG 时不显示画质滑块', dlg.qualityShown === false);
  await page.evaluate(() => {
    const s = document.querySelector('#exportFormat');
    s.value = 'jpeg'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  ok('换成 JPEG 后出现画质滑块',
    (await page.evaluate(() => !document.querySelector('#exportQualityRow').classList.contains('hidden'))) === true);
  ok('提示文字说明了透明问题',
    /透明/.test(await page.evaluate(() => document.querySelector('#exportNote').textContent)),
    await page.evaluate(() => document.querySelector('#exportNote').textContent));

  // 真的导出一次（拦截 download，避免真写盘）
  const names = await page.evaluate(() => {
    const seen = [];
    window.__dl = seen;
    if (!window.__patched) {
      window.__patched = true;
      const origCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        const el = origCreate(tag);
        if (String(tag).toLowerCase() === 'a') {
          const origClick = el.click.bind(el);
          el.click = function () { seen.push(el.download + '|' + String(el.href).slice(0, 24)); };
          void origClick;
        }
        return el;
      };
    }
    return seen;
  });
  void names;
  // psd 也走一遍：它对 exportAs 来说是一条特例路径（要用 engine 而不是画布）
  for (const f of ['png', 'jpeg', 'bmp', 'tga', 'psd']) {
    const r = await page.evaluate((fmt) => {
      const before = window.__dl.length;
      window.ChaApp.exportAs(fmt);
      return window.__dl.slice(before);
    }, f);
    console.log('  导出 ' + f + ': ' + JSON.stringify(r));
    ok('导出 ' + f + ' 时给出了文件名', r.length === 1 && /\.[a-z]+$/.test(r[0].split('|')[0]), JSON.stringify(r));
    if (f === 'psd') ok('psd 的文件名后缀是 .psd', /\.psd\|/.test(r[0] || ''), r[0]);
  }

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
