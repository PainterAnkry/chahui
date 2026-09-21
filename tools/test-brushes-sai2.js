/**
 * ★ v2.0.10 SAI2 笔刷包替换：参数表加载 / 套用 / 真能画。
 *
 * 覆盖：
 *   1. sai2-brushes.js 加载了，而且形状对（12 只替换 + 3 只追加）
 *   2. 内置的 14 只里，同名的都被**替换**成了包里的参数（逐字段核对生成物）
 *   3. 包里没有对应预设的（油漆桶 / 渐变）保留原参数，没被清空
 *   4. 追加的三只（草稿铅笔 / 水彩（渗化）/ 油画厚涂）进了笔刷栏，图标/名字/提示都在
 *   5. 换到这些笔刷真的能画：落笔 → 笔迹数 +1、画面有墨；换一支再画也不报错
 *
 * 用法: node tools/test-brushes-sai2.js [http://127.0.0.1:8437]
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

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '笔刷');
  await page.fill('#newRoomName', 'SAI2笔刷验收');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => { document.getElementById('entryMask').classList.add('hidden'); });

  /* ---------- 1. 生成物加载 ---------- */
  console.log('\n[1] SAI2 参数表');
  const pack = await page.evaluate(() => {
    const S = window.CHAHU_SAI2;
    if (!S) return null;
    return {
      source: S.source,
      overrides: Object.keys(S.overrides || {}).length,
      extra: (S.extra || []).map(x => x.id),
      keys: Object.keys(S.overrides || {})
    };
  });
  console.log('  包: ' + (pack && pack.source) + '  替换 ' + (pack && pack.overrides) + ' 只');
  ok('★ sai2-brushes.js 已加载（window.CHAHU_SAI2 在）', !!pack, pack && pack.source);
  ok('★ 替换了 12 只（14 个目标里，油漆桶 / 渐变包里没有可映射的参数，保留原样）',
    !!pack && pack.overrides === 12, pack && pack.overrides);
  ok('★ 追加了 3 只（草稿铅笔 / 水彩渗化 / 油画厚涂）',
    !!pack && pack.extra.join(',') === 'sai2Sketch,sai2Wet,sai2Oil', pack && pack.extra);

  /* ---------- 2. 内置笔刷被替换成包里的参数 ---------- */
  console.log('\n[2] 内置笔刷 → 包里参数');
  const applied = await page.evaluate(() => {
    const S = window.CHAHU_SAI2, B = window.ChaBrushes;
    const out = [];
    Object.keys(S.overrides).forEach(id => {
      const item = B.get(id);
      const want = S.overrides[id].params;
      const got = item ? item.params : null;
      const mism = [];
      if (!item) mism.push('item 不存在');
      else {
        Object.keys(want).forEach(k => {
          const a = typeof want[k] === 'number' ? +Number(got[k]).toFixed(3) : got[k];
          const b = typeof want[k] === 'number' ? +Number(want[k]).toFixed(3) : want[k];
          if (a !== b) mism.push(k + ' ' + a + '≠' + b);
        });
        if (item.sai2 !== S.overrides[id].from) mism.push('sai2 标记 ' + item.sai2);
      }
      out.push({ id: id, from: S.overrides[id].from, mism: mism });
    });
    return out;
  });
  applied.forEach(x => console.log('  ' + x.id.padEnd(13) + ' ← ' + String(x.from).padEnd(10)
    + (x.mism.length ? '  ✗ ' + x.mism.join('; ') : '  ok')));
  ok('★ 12 只**逐字段**和生成物一致（参数真的换过去了，不是只写了个标记）',
    applied.length === 12 && applied.every(x => x.mism.length === 0),
    applied.filter(x => x.mism.length));

  /* ---------- 3. 包里没有的保留原样 ---------- */
  console.log('\n[3] 包里没有对应预设的：保留原参数');
  const kept = await page.evaluate(() => {
    const B = window.ChaBrushes, S = window.CHAHU_SAI2;
    const bucket = B.get('bucket'), grad = B.get('gradient');
    return {
      bucketHas: !!(bucket && bucket.params && bucket.params.brush === 'bucket'),
      bucketTol: bucket && bucket.params.tolerance,
      gradHas: !!(grad && grad.params && grad.params.brush === 'gradient'),
      touched: !!(S.overrides.bucket || S.overrides.gradient)
    };
  });
  ok('★ 油漆桶 / 渐变没被改（包里那两只只有颜色，没有可映射的笔刷参数）',
    kept.bucketHas && kept.gradHas && kept.touched === false && kept.bucketTol > 0, kept);

  /* ---------- 4. 追加的三只进了笔刷栏 ---------- */
  console.log('\n[4] 追加的三只');
  const extraUi = await page.evaluate((ids) => {
    const B = window.ChaBrushes;
    const inList = B.forTool('brush').map(x => x.id);
    return ids.map(id => {
      const it = B.get(id);
      const btn = document.querySelector('#brushGrid .tool[data-item="' + id + '"]');
      return {
        id: id, exists: !!it, name: it && it.name,
        inBrushList: inList.indexOf(id) >= 0,
        btn: !!btn, btnText: btn ? btn.textContent.trim() : '',
        tip: it ? it.tip : ''
      };
    });
  }, pack ? pack.extra : []);
  extraUi.forEach(x => console.log('  ' + x.id.padEnd(11) + ' ' + x.name + '  按钮=' + x.btnText));
  ok('★ 三只都在笔刷列表里，而且面板上真画出了按钮',
    extraUi.length === 3 && extraUi.every(x => x.exists && x.inBrushList && x.btn),
    extraUi.map(x => x.btnText));
  ok('★ 提示里写明了「来自 SAI2 笔刷包」（可追溯）',
    extraUi.every(x => /SAI2 笔刷包/.test(x.tip)), extraUi.map(x => x.tip.slice(0, 20)));

  /* ---------- 5. 换着画真的能画 ---------- */
  console.log('\n[5] 换到这些笔刷真的能画');
  const paint = async (id) => {
    await page.evaluate((bid) => {
      const btn = document.querySelector('#brushGrid .tool[data-item="' + bid + '"]');
      if (btn) btn.click();
    }, id);
    await sleep(250);
    // ⚠ 一条轨迹别指望一次就落上：画布位置 / 面板遮挡 / 上一笔还没提交都可能让它空挥。
    //   这里最多试三次（每次都换一条轨迹），和 test-paste / test-readonly 一个套路。
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await page.evaluate(() => window.ChaApp.engine.strokes.length);
      const box = await page.locator('#view').boundingBox();
      const y0 = box.y + 100 + attempt * 40 + Math.round(Math.random() * 30);
      const x0 = box.x + 100 + attempt * 30;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * 18, y0 + Math.sin(i) * 12);
      await page.mouse.up();
      const grew = await page.waitForFunction(
        (n) => window.ChaApp.engine.strokes.length > n, before, { timeout: 2200 }
      ).then(() => true).catch(() => false);
      const used = await page.evaluate(() => window.ChaApp.state.brushId);
      if (grew && used === id) {
        const after = await page.evaluate(() => window.ChaApp.engine.strokes.length);
        return { before: before, after: after, used: used, ok: true, attempt: attempt };
      }
      if (used !== id) return { before: before, after: before, used: used, ok: false, why: '换笔没生效' };
      await sleep(200);
    }
    const now = await page.evaluate(() => window.ChaApp.engine.strokes.length);
    return { before: now, after: now, used: id, ok: false, why: '三次都没落上' };
  };
  const paintFails = [];
  for (const id of ['pencil', 'brush', 'watercolor', 'marker', 'eraser', 'blur', 'smudge', 'scatter', 'effect', 'airbrush', 'sai2Sketch', 'sai2Wet', 'sai2Oil']) {
    const r = await paint(id);
    if (!r.ok) paintFails.push({ id: id, r: r });
    else console.log('  ✓ ' + id.padEnd(12) + ' 笔迹 ' + r.before + ' → ' + r.after
      + '（第 ' + r.attempt + ' 次落上）');
  }
  ok('★ 13 只（含替换过的 + 追加的）都能落笔', paintFails.length === 0, paintFails);
  const ink = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const c = e.renderDocument({ transparentBackground: true }).canvas;
    const d = c.getContext('2d').getImageData(0, 0, e.width, e.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
    return n;
  });
  ok('★ 画布上确实有墨（不是只涨了笔迹数）', ink > 500, 'ink=' + ink);
  ok('★ 全程没有页面报错', errs.length === 0, errs.slice(0, 3));

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
