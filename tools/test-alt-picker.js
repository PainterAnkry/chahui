/**
 * Alt 临时吸管（第 5 项）：按住 Alt，鼠标图标要变成吸管，而且点下去真的是取色。
 *
 * 守四件事：
 *   1) 按住 Alt **那一刻**（还没动鼠标）光标就换成吸管图标 —— 用户要的就是这个。
 *      光靠 pointermove 里读 e.altKey 是不够的：人往往是「先把 Alt 按下去、再准备点」，
 *      那一刻还没有任何指针事件，光标会一直是笔刷圆环，看着像没生效。
 *   2) Alt + 拖 = 取色，不是落笔（取到的颜色必须等于那一块的颜色）。
 *   3) 松开 Alt 之后光标要能变回来（别卡在吸管上）。
 *   4) 选区工具下 Alt 仍然是「减选」，不能被吸管抢走 —— 抢走了 Alt 减选就永远用不了。
 *
 * 用法: node tools/test-alt-picker.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(process.argv[2] || 'http://localhost:8437', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '吸管');
  await page.fill('#newRoomName', 'Alt 吸管回归');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(400);
  // 「自动变换」默认开着：画完选区会自己进变换会话，会把后面的点击吃掉
  await page.evaluate(() => {
    const c = document.querySelector('#tpAuto');
    c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);

  const box = await page.locator('#view').boundingBox();
  /** 文档坐标 → 屏幕坐标（限制在画布区内，落在外面是测试自己写错了） */
  const at = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.ChaApp.engine.docToScreen(a, b), [x, y]);
    const px = box.x + s.x, py = box.y + s.y;
    if (px < box.x + 2 || px > box.x + box.width - 2 || py < box.y + 2 || py > box.y + box.height - 2) {
      throw new Error('探针落在画布区之外：doc(' + x + ',' + y + ')');
    }
    return [px, py];
  };

  /* ---------- 先铺一块纯红，好让「取色取到了什么」有确定答案 ---------- */
  const RED = '#ff0000';
  const BLOCK = { x: 120, y: 120, w: 200, h: 160 };
  await page.evaluate(([hex, b]) => {
    const e = window.ChaApp.engine, l = e.activeLayer();
    const c = l.canvas.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = hex; c.fillRect(b.x, b.y, b.w, b.h);
    e.invalidate();
  }, [RED, BLOCK]);
  await sleep(300);

  /** 「这一笔到底落下去没有」：红块本身是纯红 #ff0000、块外全透明，
   *  所以「这块里既不是透明、也不是纯红」的像素就是那一笔留下的。
   *  ⚠ 别拿「严格的蓝色」当判据：小笔刷画出来大片是混色边缘
   *  （实测混到 rgb(71,0,184)，蓝色分量到不了 200），会一条都数不到。 */
  const blueInk = () => page.evaluate(([b]) => {
    const e = window.ChaApp.engine, l = e.activeLayer();
    const d = l.canvas.getContext('2d').getImageData(b.x, b.y, b.w, b.h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8 && !(d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0)) n++;
    }
    return n;
  }, [BLOCK]);
  /** 光标 + 舞台这一刻的状态 */
  const cursorNow = () => page.evaluate(() => {
    const el = document.querySelector('#brushCursor');
    const r = el.getBoundingClientRect();
    const drop = el.querySelector('.bc-drop'), dot = el.querySelector('.bc-dot');
    const wrap = document.querySelector('.canvas-wrap');
    return {
      cls: el.className, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      hidden: el.classList.contains('hidden'),
      dropShown: drop ? getComputedStyle(drop).display !== 'none' : null,
      dotShown: dot ? getComputedStyle(dot).display !== 'none' : null,
      stageEyedrop: document.getElementById('stage').classList.contains('eyedropping'),
      wrapCursor: wrap ? getComputedStyle(wrap).cursor : '(no .canvas-wrap)',
      altDown: !!window.ChaApp.state.altDown,
      tool: window.ChaApp.state.tool,
      color: window.ChaApp.state.color
    };
  });
  /** 一次「按下 → 分几帧挪一小段 → 抬起」，像真的一笔。
   *  点太少 / 间隔太短的话，这一笔会被当成空笔丢掉（合成帧时一个落点都没有）。 */
  const p0 = await at(BLOCK.x + BLOCK.w / 2, BLOCK.y + BLOCK.h / 2);
  async function dragMini() {
    await page.mouse.move(p0[0], p0[1]);
    await sleep(80);
    await page.mouse.down();
    await sleep(120);
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(p0[0] + 5 * i, p0[1] + 5 * i);
      await sleep(30);
    }
    await page.mouse.up();
    await sleep(700);
  }

  console.log('\n=== 0) 前置：默认工具是画笔，鼠标已经在画布上 ===');
  // 把鼠标移进画布，光标才会显示（updateBrushCursor 里 !S.pointer.inside 就整块收起）
  await page.mouse.move(p0[0], p0[1]);
  await sleep(250);
  let cur = await cursorNow();
  const baseCls = cur.cls;                  // 按 Alt 之前的光标类名，最后要回到它
  console.log('  ' + JSON.stringify({ tool: cur.tool, cls: cur.cls, hidden: cur.hidden }));
  check('默认工具是画笔', cur.tool === 'brush', cur.tool);
  check('鼠标在画布上时光标是显示的', cur.hidden === false);
  check('没按 Alt 时不带 eyedrop 类', !/\beyedrop\b/.test(cur.cls), cur.cls);
  check('没按 Alt 时舞台也没有 eyedropping', cur.stageEyedrop === false);

  console.log('\n=== 1) 按住 Alt：还不移动鼠标，光标就得变成吸管 ===');
  // 这里**故意不动鼠标** —— 要的就是「按下去那一刻就换」
  await page.keyboard.down('Alt');
  await sleep(300);
  cur = await cursorNow();
  console.log('  ' + JSON.stringify({
    cls: cur.cls, w: cur.w, h: cur.h, drop: cur.dropShown, dot: cur.dotShown,
    stage: cur.stageEyedrop, wrapCursor: cur.wrapCursor, altDown: cur.altDown
  }));
  check('Alt 按下去了（state.altDown）', cur.altDown === true);
  check('光标带上了 eyedrop 类（换成吸管图标）', /\beyedrop\b/.test(cur.cls), cur.cls);
  check('吸管图标的盒子是 22×22（和 .eyedrop 的样式一致）',
    Math.abs(cur.w - 22) < 0.6 && Math.abs(cur.h - 22) < 0.6, cur.w + '×' + cur.h);
  check('吸管图标显示出来了（.bc-drop 可见）', cur.dropShown === true);
  check('原来那个小圆点收起来了（.bc-dot 藏掉）', cur.dotShown === false);
  check('舞台加上 eyedropping（系统光标藏掉，不会两个指针叠一起）',
    cur.stageEyedrop === true);
  // ⚠ 这里**不断**「系统光标变成 none」：画笔类工具本来就藏着系统光标
  //   （.stage.drawing 那条，靠自绘的笔刷圆环代替），Alt 只是又叠了一层，
  //   两种情况下算出来的 cursor 都是 none，断它等于没断。

  console.log('\n=== 2) Alt + 拖：取色，不落笔 ===');
  await page.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#0000ff'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  const blueBefore = await blueInk();
  await dragMini();                       // Alt 仍然按着
  const afterAltDrag = await cursorNow();
  const blueAfterAlt = await blueInk();
  console.log('  取到 ' + afterAltDrag.color + '，红块上的蓝色笔画像素 ' + blueBefore + ' → ' + blueAfterAlt);
  check('Alt + 拖取到了那一块的颜色（' + RED + '）',
    (afterAltDrag.color || '').toLowerCase() === RED, afterAltDrag.color);
  check('Alt + 拖没有落笔（红块上没多出一笔）', blueAfterAlt === blueBefore,
    blueBefore + ' → ' + blueAfterAlt);

  console.log('\n=== 3) 松开 Alt：光标要变回笔刷 ===');
  await page.keyboard.up('Alt');
  await sleep(300);
  await page.mouse.move(p0[0] + 40, p0[1] + 40);
  await sleep(200);
  cur = await cursorNow();
  console.log('  ' + JSON.stringify({ cls: cur.cls, drop: cur.dropShown, stage: cur.stageEyedrop, altDown: cur.altDown }));
  check('松开 Alt 后 altDown 复位', cur.altDown === false);
  check('松开 Alt 后不带 eyedrop 类', !/\beyedrop\b/.test(cur.cls), cur.cls);
  check('松开 Alt 后舞台也去掉了 eyedropping', cur.stageEyedrop === false);
  check('光标状态回到按 Alt 之前（类名一模一样）', cur.cls === baseCls, cur.cls + ' vs ' + baseCls);

  console.log('\n=== 4) 对照：不按 Alt 拖一下，是要落笔的 ===');
  // ⚠ 得先把前景色重新设成蓝色：上面那次 Alt 取色已经把它改成红色了，
  //   红笔画在红块上，用「蓝色像素」看等于没画。
  await page.evaluate(() => {
    const el = document.getElementById('hexInput');
    el.value = '#0000ff'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  await dragMini();                       // 和上面 Alt 那一次**完全同一笔**
  const blueAfterPlain = await blueInk();
  console.log('  红块上的蓝色笔画像素 ' + blueAfterAlt + ' → ' + blueAfterPlain);
  check('不按 Alt 时同一处拖一下会落笔（证明上面那条「没落笔」是真的）',
    blueAfterPlain > blueAfterAlt, blueAfterAlt + ' → ' + blueAfterPlain);

  console.log('\n=== 5) 选区工具下 Alt 是「减选」，不能被吸管抢走 ===');
  await page.click('#toolGrid .tool[data-item="marquee"]');
  await sleep(250);
  await page.mouse.move(p0[0], p0[1]);
  await sleep(200);
  await page.keyboard.down('Alt');
  await sleep(300);
  cur = await cursorNow();
  await page.keyboard.up('Alt');
  console.log('  ' + JSON.stringify({ tool: cur.tool, cls: cur.cls, stage: cur.stageEyedrop, altDown: cur.altDown }));
  check('切到了框选工具', cur.tool === 'marquee', cur.tool);
  check('选区工具下按 Alt 光标**不**变吸管（Alt 留给减选）',
    !/\beyedrop\b/.test(cur.cls) && cur.stageEyedrop === false,
    { cls: cur.cls, stage: cur.stageEyedrop });

  check('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：', e); process.exit(2); });
