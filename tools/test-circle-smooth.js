/* 画圆折线回归：稀疏采样点（模拟快速画圈）也必须画成平滑的圆
 * ① 12 个均匀采样点的圆 → 半径方向起伏（maxR-minR）必须很小，不能是多边形
 * ② 30 个点同理
 * ③ 急转角必须保住（L 形三点，拐角处要有墨，不能被样条磨圆）
 * ④ 大笔刷 + 大尺寸不再按尺寸抽稀（同一组点，100px 笔的起伏同样要小）
 * 用法：node tools/test-circle-smooth.js [BASE]   （默认 http://127.0.0.1:8440）
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'T');
  await page.fill('#newRoomName', 'circle' + (Date.now() % 100000));
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(600);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));

  // 在页内画一圈并量「半径起伏」：多边形的起伏 ≈ 矢高，圆 ≈ 0
  const ringTest = (n, size) => page.evaluate(({ n, size }) => {
    const e = window.ChaApp.engine;
    const cx = 400, cy = 400, R = 120;
    const st = e.beginStroke({
      id: 'ring' + n + '_' + size, layerId: e.activeLayerId, tool: 'brush', brush: 'brush',
      color: '#000000', size: size, opacity: 1, hardness: 0.95, minSize: 1,
      pressSize: 0, pressOpacity: 0, grain: 0, scatter: 0, sym: 'none', seed: 7
    });
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = (i % n) / n * Math.PI * 2 - Math.PI / 2;
      pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R, 0.6]);
    }
    e.addPoints(st.id, pts);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();

    const W = e.width, H = e.height;
    const d = e.activeLayer().ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : d[((y | 0) * W + (x | 0)) * 4 + 3];
    // 用「alpha 加权的平均半径」当中心线估计：抗锯齿不会让它的值跳动，
    // 而多边形会让它随角度出现 ±矢高/2 的周期性起伏。
    let rMax = 0, rMin = 1e9, miss = 0;
    for (let deg = 0; deg < 360; deg += 2) {
      const a = deg * Math.PI / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      let sw = 0, sr = 0;
      for (let r = R - 10; r <= R + 10; r += 0.25) {
        const al = at(cx + dx * r, cy + dy * r);
        if (al > 8) { sw += al; sr += al * r; }
      }
      if (!sw) { miss++; continue; }
      const mean = sr / sw;
      if (mean > rMax) rMax = mean;
      if (mean < rMin) rMin = mean;
    }
    return { spread: +(rMax - rMin).toFixed(2), rMax: +rMax.toFixed(2), rMin: +rMin.toFixed(2), miss };
  }, { n, size });

  const r12 = await ringTest(12, 4);
  ok('12 点画圆：半径起伏 < 1.2px（多边形应 ≈4px）', r12.spread < 1.2 && r12.miss === 0, r12);
  const r30 = await ringTest(30, 4);
  ok('30 点画圆：半径起伏 < 0.8px', r30.spread < 0.8 && r30.miss === 0, r30);
  const r12big = await ringTest(12, 100);
  ok('12 点 + 100px 大笔：半径起伏 < 1.2px（不受尺寸抽稀影响）', r12big.spread < 1.2 && r12big.miss === 0, r12big);

  // 急转角保角：L 形（(300,700) → (500,700) → (500,850)），拐角 (500,700) 附近必须有墨
  const corner = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const st = e.beginStroke({
      id: 'corner1', layerId: e.activeLayerId, tool: 'brush', brush: 'brush',
      color: '#000000', size: 6, opacity: 1, hardness: 0.95, minSize: 1,
      pressSize: 0, pressOpacity: 0, grain: 0, scatter: 0, sym: 'none', seed: 9
    });
    e.addPoints(st.id, [[300, 700, 0.6], [500, 700, 0.6], [500, 850, 0.6]]);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();
    const W = e.width, H = e.height;
    const d = e.activeLayer().ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => d[((y | 0) * W + (x | 0)) * 4 + 3];
    // 拐角顶点正下方 1px 处（角的「内尖」附近）应当有墨；被磨圆的样条这里会空
    let near = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (at(500 + dx, 300 + 700 + dy) > 60) near++;
    return { near, cornerInk: at(500, 700), deepInk: at(500, 702) };
  });
  ok('急转保角：L 形拐角处仍有墨（未被磨圆）', corner.deepInk > 60, corner);

  ok('无页面报错', errs.length === 0, errs.slice(0, 3));

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
