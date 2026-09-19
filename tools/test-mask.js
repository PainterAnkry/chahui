/**
 * 茶绘 · 图层蒙版回归
 *
 * 蒙版这东西的风险几乎全在「非破坏」这三个字上，所以测试的重心是：
 *
 *   · **蒙版不能改图层像素**。如果实现成「涂黑就把图层那块的像素抹掉」，
 *     屏幕上看效果一模一样，但撤销不回来、关掉蒙版也回不来 —— 那是假的蒙版。
 *     所以这里每次都同时看两个数：合成后的像素数（该变小）和
 *     `renderLayerRaw` 出来的图层自身像素数（**必须一个字节都不动**）。
 *   · **两端要一致**。蒙版笔迹走的是普通笔迹通道（带 target='mask'），
 *     漏了 target 的广播就是「自己看得到、别人看不到」。
 *   · **新进来的人也要有**。蒙版像素平时是本地按笔迹重建的，
 *     所以第三个页面进来后看到的画面必须和房主一致。
 *   · 大原则：**新增字段要顺着整条链查**（协议 → 服务端 → S2C → engine → 面板），
 *     少一环就会出现「服务端存了、客户端收不到」这种只在截图里才发现的毛病。
 *
 * 覆盖：
 *   1. 加蒙版：默认全白 = 完全不影响画面（加完画面必须一模一样）
 *   2. 黑笔涂抹：合成变透明，**图层像素纹丝不动**
 *   3. 白笔涂回来：恢复显示
 *   4. 跨端：另一端看到的合成结果与房主一致
 *   5. 撤销：蒙版按历史重建
 *   6. 关掉 / 删掉蒙版：画面完全还原
 *   7. 剪贴蒙版：只显示在下面那一层的不透明区域里
 *   8. 中途进来的人：蒙版靠自己重放笔迹重建，画面要对得上
 *
 * 用法: node tools/test-mask.js [http://127.0.0.1:8437]
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

const HELPERS = () => {
  const E = window.ChaApp.engine;
  const inkOf = (canvas) => {
    const d = canvas.getContext('2d').getImageData(0, 0, E.width, E.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
    return n;
  };
  // ⚠ 「墨量」用 **alpha 总和**，不能用「alpha > 30 的像素个数」。
  //   蒙版是非破坏的**半透明**遮罩：黑笔按笔迹覆盖率把蒙版 alpha 抹到 64~104
  //   （不是抹成 0），合成后的像素 alpha 仍有 60+，稳稳越过 30 这条线 ——
  //   于是「数像素」这个指标对部分遮挡完全瞎，看起来像「蒙版没生效」。
  //   求和能如实反映「画面整体变淡了多少」，对全遮 / 半遮都灵敏。
  const inkSumOf = (canvas) => {
    const d = canvas.getContext('2d').getImageData(0, 0, E.width, E.height).data;
    let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
    return s;
  };
  // 合成后的画面（导出用的那份，等于用户眼里的成品）
  window.__ink = () => inkOf(E.renderDocument({ transparentBackground: true }).canvas);
  // 合成画面的**墨量**（alpha 总和）—— 判断「变淡了 / 回来了」看这个
  window.__inkSum = () => inkSumOf(E.renderDocument({ transparentBackground: true }).canvas);
  // 图层**自身**像素 —— 不含蒙版、不含浓度混合。蒙版绝不该动它
  window.__layerInk = (id) => {
    const c = E.renderLayerRaw(id);
    return c ? inkOf(c) : -1;
  };
  // 蒙版里「被遮住」的像素数（alpha < 一半）
  window.__maskHoles = (id) => {
    const l = E.getLayer(id);
    if (!l || !l.maskCanvas) return -1;
    const d = l.maskCanvas.getContext('2d').getImageData(0, 0, E.width, E.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 128) n++;
    return n;
  };
  window.__meta = (id) => E.layerList().find(l => l.id === id) || null;
  window.__active = () => E.activeLayerId;
  window.__ids = () => E.layers.map(l => l.id);
  window.__pick = (id) => E.setActiveLayer(id);
};

async function waitFor(page, fn, arg, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(120);
  }
  return false;
}
async function waitBoth(a, b, fn, arg, ms) {
  return (await waitFor(a, fn, arg, ms)) && (await waitFor(b, fn, arg, ms));
}

const metaOf = (p, id) => p.evaluate(i => window.__meta(i), id);

async function createRoom(page, nick, roomName, w, h) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.evaluate(([a, b]) => {
    const s = document.querySelector('#newRoomSize');
    if (s) {
      let hit = false;
      for (const o of s.options) if (o.value === a + 'x' + b) hit = true;
      if (!hit) { const o = document.createElement('option'); o.value = a + 'x' + b; o.textContent = a + '×' + b; s.appendChild(o); }
      s.value = a + 'x' + b;
    }
  }, [w, h]);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(400);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function join(page, room, nick) {
  await page.addInitScript(n => {
    try { localStorage.setItem('chahu.name', n); } catch (e) { /* ignore */ }
  }, nick);
  await page.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(500);
}

/** 在画布上真拖一笔（走真实的指针事件，不是直接调引擎） */
async function stroke(page, x0, y0, x1, y1, steps) {
  const box = await page.evaluate(([a, b, c, d]) => {
    const e = window.ChaApp.engine;
    const p0 = e.docToScreen(a, b), p1 = e.docToScreen(c, d);
    const r = e.view.getBoundingClientRect();
    return [r.left + p0.x, r.top + p0.y, r.left + p1.x, r.top + p1.y];
  }, [x0, y0, x1, y1]);
  await page.mouse.move(box[0], box[1]);
  await page.mouse.down();
  const n = steps || 14;
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(box[0] + (box[2] - box[0]) * i / n, box[1] + (box[3] - box[1]) * i / n);
  }
  await page.mouse.up();
  await sleep(320);
}

const setColor = (p, c) => p.evaluate(v => { window.ChaApp.state.color = v; }, c);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const mkPage = async () => {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    return p;
  };
  const A = await mkPage();
  const B = await mkPage();

  const room = await createRoom(A, '甲', '蒙版回归', 600, 800);
  await join(B, room, '乙');
  console.log('\n房间 ' + room + '（画布 600×800）已就绪：甲=房主，乙=成员');

  /* ================= 1) 先在图层上画一笔 ================= */
  console.log('\n=== 1) 底稿：图层上画一道 ===');
  await A.evaluate(() => { window.ChaApp.state.tool = 'brush'; });
  await A.evaluate(() => { window.ChaApp.state.brush.size = 40; });
  await setColor(A, '#000000');
  await stroke(A, 150, 300, 450, 300);
  await waitFor(B, () => window.__ink() > 0, null, 6000);
  const ink0 = await A.evaluate(() => window.__ink());
  const lid = await A.evaluate(() => window.__active());
  const lay0 = await A.evaluate(i => window.__layerInk(i), lid);
  // 乙的「图层自身像素」要跟**乙自己的**基线比。
  // 两端各自光栅化同一笔，像素数本来就会差个零点几个百分点（抗锯齿落点不同），
  // 拿甲的绝对值去卡乙，卡出来的是假红。
  const layB0 = await B.evaluate(i => window.__layerInk(i), lid);
  ok('图层上出现了墨迹', ink0 > 2000, 'ink=' + ink0);
  ok('另一端也收到了', (await B.evaluate(() => window.__ink())) > 2000);
  ok('图层自身像素数记下来（后面要一直盯着它）', lay0 > 2000,
    'layerInk=' + lay0 + '（乙自己的基线 ' + layB0 + '）');

  /* ================= 2) 加蒙版：默认全白，画面不能有任何变化 ================= */
  console.log('\n=== 2) 加蒙版（默认全白 = 完全不影响画面）===');
  await A.click('#btnMaskAdd');
  ok('两端都记下了「这一层有蒙版」',
    await waitBoth(A, B, i => { const m = window.__meta(i); return !!m && m.hasMask === true; }, lid, 6000),
    JSON.stringify(await metaOf(B, lid)));
  await sleep(400);
  const ink1 = await A.evaluate(() => window.__ink());
  const sum0 = await A.evaluate(() => window.__inkSum());
  ok('刚加上的蒙版是全白 —— 画面一点没变', Math.abs(ink1 - ink0) <= 2, ink0 + ' → ' + ink1);
  ok('刚加上的蒙版是全白 —— 墨量也一点没变', (await A.evaluate(() => window.__inkSum())) === sum0, '墨量 ' + sum0);
  ok('蒙版里没有被遮住的像素', (await A.evaluate(i => window.__maskHoles(i), lid)) <= 2,
    'holes=' + (await A.evaluate(i => window.__maskHoles(i), lid)));
  ok('自动进入了蒙版编辑模式', (await A.evaluate(() => window.ChaApp.state.maskEdit)) === lid);

  /* ================= 3) 黑笔涂抹：遮住，但图层像素不能动 ================= */
  console.log('\n=== 3) 黑笔涂掉左半边 ===');
  // ⚠ 蒙版笔必须**压在底稿墨迹上**：底稿在 y=300 画的，所以这里也走 y=300。
  //   以前这里走 y=280，40px 的笔只擦到墨迹上沿一点点 —— 「合成图该少多少」
  //   本来就只有个位数像素，却拿 500 当阈值，永远不可能通过（假红）。
  await setColor(A, '#000000');
  await stroke(A, 150, 300, 300, 300);
  const s0 = await A.evaluate(() => window.__inkSum());
  const ink2 = await A.evaluate(() => window.__ink());
  const lay2 = await A.evaluate(() => window.__layerInk(window.__active()));
  ok('合成画面变淡了（被遮住）', s0 < sum0 * 0.9, '墨量 ' + sum0 + ' → ' + s0);
  ok('★ 图层自身像素**一个都没少**（蒙版是非破坏的）', lay2 === lay0, 'layerInk ' + lay0 + ' → ' + lay2);
  ok('蒙版上确实出现了被遮住的区域', (await A.evaluate(i => window.__maskHoles(i), lid)) > 500,
    'holes=' + (await A.evaluate(i => window.__maskHoles(i), lid)));

  /* ================= 4) 跨端一致 ================= */
  console.log('\n=== 4) 另一端看到的一样吗 ===');
  await sleep(400);   // 等乙那边把这笔同步过来
  const sumB = await B.evaluate(() => window.__inkSum());
  ok('乙的合成结果和甲一致（墨量）', Math.abs(sumB - s0) / Math.max(1, s0) < 0.03, '甲墨量=' + s0 + ' 乙墨量=' + sumB);
  const layB1 = await B.evaluate(i => window.__layerInk(i), lid);
  ok('乙那边图层自身像素也没变（跟乙自己的基线比）', Math.abs(layB1 - layB0) <= 2,
    '乙 layerInk ' + layB0 + ' → ' + layB1);
  ok('乙那边蒙版确实生效了', (await B.evaluate(i => window.__maskHoles(i), lid)) > 500,
    'holes=' + (await B.evaluate(i => window.__maskHoles(i), lid)));
  const inkB = await A.evaluate(() => window.__ink());   // 后面几步的对照用

  /* ================= 5) 白笔涂回来 ================= */
  console.log('\n=== 5) 白笔把刚才那块涂回来 ===');
  await setColor(A, '#ffffff');
  await stroke(A, 150, 300, 300, 300);
  const s1 = await A.evaluate(() => window.__inkSum());
  ok('显示范围回来了（墨量回到遮之前）', s1 > s0 + sum0 * 0.05, '墨量 ' + s0 + ' → ' + s1);
  ok('图层像素依旧没动', (await A.evaluate(() => window.__layerInk(window.__active()))) === lay0);

  /* ================= 6) 撤销：蒙版按历史重建 ================= */
  console.log('\n=== 6) 撤销刚才那一笔（白笔）===');
  await setColor(A, '#000000');
  await stroke(A, 150, 300, 300, 300);      // 再画一笔黑的，然后撤销它
  const s2 = await A.evaluate(() => window.__inkSum());
  await A.keyboard.press('Control+z');
  await sleep(700);
  const s3 = await A.evaluate(() => window.__inkSum());
  ok('撤销之后那一笔的遮挡消失了', s3 > s2 + sum0 * 0.03, '墨量 ' + s2 + ' → ' + s3);
  ok('撤销没有波及图层像素', (await A.evaluate(() => window.__layerInk(window.__active()))) === lay0);

  /* ================= 7) 关掉 / 删掉蒙版 ================= */
  console.log('\n=== 7) 关掉蒙版、再删掉蒙版 ===');
  await setColor(A, '#000000');
  await stroke(A, 150, 300, 350, 300);     // 制造一块明显的遮挡
  const ink6 = await A.evaluate(() => window.__ink());
  await A.evaluate(i => window.ChaApp.engine.getLayer(i) && window.ChaApp.net.send(
    window.ChaApp.state.room ? 'layer:upd' : '', { layerId: i, patch: { maskEnabled: false } }), lid);
  await waitFor(A, () => window.__ink() > 0, null, 5000);
  await sleep(500);
  const ink7 = await A.evaluate(() => window.__ink());
  ok('关掉蒙版后画面完全还原', Math.abs(ink7 - ink0) <= 2, ink6 + ' → ' + ink7 + '（原始 ' + ink0 + '）');
  await A.evaluate(i => window.ChaApp.net.send('layer:upd', { layerId: i, patch: { maskEnabled: true } }), lid);
  await sleep(500);
  await A.click('#btnMaskDel');
  await waitFor(A, () => !(window.__meta(window.__active()) || {}).hasMask, null, 5000);
  await sleep(400);
  const ink8 = await A.evaluate(() => window.__ink());
  const metaDel = await metaOf(B, lid);
  ok('删掉蒙版后画面也是满的', Math.abs(ink8 - ink0) <= 2, ink8);
  ok('两端都不再有蒙版', metaDel && metaDel.hasMask === false, JSON.stringify(metaDel));
  ok('删蒙版同样没动图层像素', (await A.evaluate(() => window.__layerInk(window.__active()))) === lay0);

  /* ================= 8) 剪贴蒙版 ================= */
  console.log('\n=== 8) 剪贴蒙版：只显示在下面那一层的不透明区域里 ===');
  const baseId = await A.evaluate(() => window.__ids()[0]);
  await A.evaluate(i => window.__pick(i), baseId);
  await A.evaluate(() => window.ChaApp.addLayer());
  await waitFor(A, n => window.__ids().length === n, 2, 6000);
  const topId = await A.evaluate(() => window.__ids()[1]);
  await A.evaluate(i => window.__pick(i), topId);
  await setColor(A, '#e8544f');
  // 在上层拉一道**又长又宽**的红条，它比下层那道黑宽得多 —— 不剪贴的话两边都会溢出
  await stroke(A, 60, 500, 540, 500, 18);
  const inkWide = await A.evaluate(() => window.__ink());
  ok('上层画了一道很宽的条', inkWide > ink0, 'ink=' + inkWide);
  await A.click('#clipChk');
  await sleep(600);
  const inkClip = await A.evaluate(() => window.__ink());
  const clipB = await waitFor(B, k => Math.abs(window.__ink() - k) < 600, inkClip, 6000);
  ok('勾上剪贴后画面变小了（超出下层的部分被剪掉）', inkClip < inkWide - 300, inkWide + ' → ' + inkClip);
  ok('另一端同步到了剪贴状态', clipB, '乙=' + (await B.evaluate(() => window.__ink())));
  const topMeta = await metaOf(B, topId);
  ok('剪贴标记也传到了另一端', topMeta && topMeta.clip === true, JSON.stringify(topMeta));

  /* ================= 9) 中途进来的人也要看得见蒙版 ================= */
  console.log('\n=== 9) 中途进来的人（蒙版靠笔迹重放重建）===');
  // 先给第一层加个蒙版并遮一块，好让「重建」这件事有东西可验
  await A.evaluate(i => window.__pick(i), baseId);
  await A.click('#btnMaskAdd');
  await sleep(400);
  await setColor(A, '#000000');
  await stroke(A, 400, 200, 520, 200);
  await sleep(700);
  const ink9 = await A.evaluate(() => window.__ink());
  const holesA9 = await A.evaluate(i => window.__maskHoles(i), baseId);
  // 这张蒙版是**刚加的**，上面只该有刚才那一道笔迹。
  // 如果删上一张蒙版时没把它的笔迹一起清掉，这里会立刻爆表（旧笔迹全被重涂上来）。
  ok('新加的白蒙版是干净的白（没混进上一张蒙版的旧笔迹）', holesA9 < 9000,
    'holes=' + holesA9 + '（只有这一道的话约 6000；旧笔迹残留会是 13000+）');
  const C = await mkPage();
  await join(C, room, '丙');
  await sleep(1500);
  const inkC = await C.evaluate(() => window.__ink());
  const holesC = await C.evaluate(i => window.__maskHoles(i), baseId);
  ok('丙进来看到的画面和房主一致', Math.abs(inkC - ink9) < 700, '甲=' + ink9 + ' 丙=' + inkC);
  ok('丙那边第一层也带着蒙版', (await metaOf(C, baseId)).hasMask === true);
  ok('丙重建出来的蒙版和房主一致（不是背着旧笔迹重建的）',
    Math.abs(holesC - holesA9) < Math.max(300, holesA9 * 0.3), '甲 holes=' + holesA9 + ' 丙 holes=' + holesC);
  ok('丙的蒙版里确实有被遮住的区域（不是一张全白）', holesC > 500, 'holes=' + holesC);

  console.log('\n=== 全程无 JS 报错 ===');
  ok('没有未捕获的异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试崩了:', e); process.exit(2); });
