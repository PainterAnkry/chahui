/**
 * 数位板压感兼容专项。
 *
 * 守着这几条（都是「绘王一类板子没压感」那件事的根因）：
 *   · 真笔（pointerType='pen'）→ 压力原样进入笔迹
 *   · 板子被驱动报成鼠标，但压力在变化 → 茶绘要认出来并照用（旧的判定会把压力丢掉）
 *   · 真鼠标（恒定 0.5 / 1x1 接触面积）→ 老老实实用 0.5，不许瞎猜
 *   · 起笔那一下 pointerdown 给占位值 0.5 时，不能把每一笔都画成半压
 *   · 面板上要出现「没检测到笔压 → 去驱动里开 Windows Ink」的提示
 *
 * ⚠ 两组坐标坑（都踩过，别重犯）：
 *  1) 合成 PointerEvent 没有真指针，setPointerCapture 会抛 NotFoundError
 *     把 pointerdown 处理器**当场打断** —— 先替掉那两个方法（见 synthScript）。
 *  2) 偏移必须落在画布内。处理器用 #canvasWrap 的 rect 换算坐标（stagePoint）
 *     再交给 engine.screenToDoc，**不能用绝对 clientX 直接调 screenToDoc** ——
 *     tx/ty 是相对视口原点的位移，混用会量出一条假的安全带（踩过）。
 *     1600x1000 的画布在 1400x900 视口下、容器 838x796，实测安全带是：
 *       x ∈ [-370, +370]   y ∈ [-232, +232]
 *     越界会被 pointerdown 的边界检查丢掉，beginLocal 根本不执行，
 *     而测试会读到**上一组残留的笔迹**，看起来像通过（假绿）。
 *     所以偏移一律取下面 VALID 中段的几个，并且每组都必须核对
 *     「新增笔迹数 == 1」，不能只看最后一条笔迹。
 *     （这条带子随容器尺寸/视口变，换 viewport 就要重量：tools/_probe-safeoff.js）
 *
 * 用法: node tools/test-pen-pressure.js [http://127.0.0.1:8440]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

/**
 * 各组落笔的屏幕偏移（相对 canvasWrap 中心）。
 * 全部落在实测安全带 x[-370,+370] / y[-232,+232] 的中段并留足余量。
 */
const Y = { g1: -180, g2: -140, g3: -100, g4: -60, g5: -20, g5b: 20 };
const X = { a: -200, b: -140, c: -60, d: 40 };

/**
 * 在页面里合成 pointer 事件序列（可以精确控制 pointerType / pressure）。
 *
 * 坑：合成的 PointerEvent 没有真实指针，view.setPointerCapture(e.pointerId)
 * 会抛 NotFoundError，把 pointerdown 处理器**当场打断**，beginLocal 根本执行不到。
 * 所以这里先把 setPointerCapture / releasePointerCapture 换成空实现再派发。
 * （真实的 playwright 鼠标事件不需要这层，因为它有真指针。）
 */
function synthScript() {
  return `
    // 合成事件没有真指针，setPointerCapture 会抛异常打断处理器 —— 先替掉
    window.__origSetCapture = Element.prototype.setPointerCapture;
    window.__origRelCapture = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};

    window.__synth = function (opts) {
      const view = document.getElementById('view');
      // 注意两点：
      //  1) 处理器内部用 #canvasWrap 的 rect 换算坐标（stagePoint），不是 view 的
      //  2) 画布在容器里居中且有留白，所以要用「画布中心」当基准再偏移，
      //     直接拿容器左上角 + 小偏移会算出负的文档坐标，被边界检查丢掉
      const wrap = document.getElementById('canvasWrap');
      const r = wrap.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const mk = (type, x, y, o) => {
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: cx + x, clientY: cy + y,
          pointerId: o.id || 1, pointerType: o.pt, isPrimary: true,
          pressure: o.p, width: o.w || 1, height: o.h || 1,
          buttons: type === 'pointerup' ? 0 : 1, button: 0
        });
        ev.getCoalescedEvents = () => [];
        view.dispatchEvent(ev);
      };
      const { pt, points, id } = opts;
      mk('pointerdown', points[0].x, points[0].y, { pt, p: points[0].p, id, w: points[0].w, h: points[0].h });
      for (let i = 1; i < points.length; i++) {
        mk('pointermove', points[i].x, points[i].y, { pt, p: points[i].p, id, w: points[i].w, h: points[i].h });
      }
      const last = points[points.length - 1];
      mk('pointerup', last.x, last.y, { pt, p: last.p, id, w: last.w, h: last.h });
    };
  `;
}

/** 笔迹条数（用来判断这一组有没有新增笔迹，避免被上一组残留干扰） */
function strokeCountScript() {
  return `(() => { const e = window.ChaApp && window.ChaApp.engine; return e && e.strokes ? e.strokes.length : -1; })()`;
}

/** 取最后一条笔迹的压力序列 */
function readStrokeScript() {
  return `
    (() => {
      const eng = window.ChaApp && window.ChaApp.engine;
      if (!eng || !eng.strokes || !eng.strokes.length) return null;
      const s = eng.strokes[eng.strokes.length - 1];
      return { n: s.points.length, pts: s.points.map(p => p[2]) };
    })()
  `;
}

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8440';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '压感');
  await page.fill('#newRoomName', '压感测试');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(700);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);
  await page.evaluate(synthScript());
  await sleep(400);   // 等一拍拍把画布初始化完（合成事件打得过早会被静默丢弃）


  /**
   * 落一笔并断言「确实新画了一条」。
   * 返回该笔的压力序列；没新增就返回 null（调用方据此判失败）。
   * 这层护栏很关键：坐标算出界时 beginLocal 不执行，笔迹不新增，
   * 若不检查条数就会读到上一组的笔迹 → 假绿。
   */
  async function strokeAndExpectNew(label, opts) {
    const before = await page.evaluate(strokeCountScript());
    await page.evaluate(o => window.__synth(o), opts);
    await sleep(400);
    const after = await page.evaluate(strokeCountScript());
    const noNew = !(after === before + 1);
    ok(label, !noNew, noNew ? ('没新增笔迹 ' + before + ' → ' + after + '（事件被丢掉了？）') : (before + ' → ' + after));
    if (noNew) return null;
    const s = await page.evaluate(readStrokeScript());
    return s ? s.pts : null;
  }

  console.log('\n=== 1) 真笔（pointerType=pen）压力必须原样入笔迹 ===');
  let ps = await strokeAndExpectNew('笔迹已产生（新增 1 条）', {
    pt: 'pen', id: 11,
    points: [
      { x: X.a, y: Y.g1, p: 0.2 }, { x: X.b, y: Y.g1, p: 0.45 },
      { x: X.c, y: Y.g1, p: 0.7 }, { x: X.d, y: Y.g1, p: 0.95 }
    ]
  });
  if (ps) {
    const spread = Math.max(...ps) - Math.min(...ps);
    ok('压力有真实变化（不是恒定 0.5）', spread > 0.2,
      '压力 ' + ps.map(v => v.toFixed(2)).join(','));
    ok('最重的那下接近 0.95', Math.max(...ps) > 0.8, 'max=' + Math.max(...ps).toFixed(2));
    const det = await page.evaluate(() => window.ChaApp.state.penDetect);
    ok('识别结果为 pen', det === 'pen', String(det));
  } else {
    ok('压力有真实变化（不是恒定 0.5）', false, '没产生笔迹');
    ok('识别结果为 pen', false, '没产生笔迹');
  }

  console.log('\n=== 2) 板子被报成 mouse，但压力在变 → 要认出来照用 ===');
  await page.evaluate(() => window.ChaApp.resetPenProbe());
  // 先喂几帧「有压力变化」的鼠标样本让判定成立，再落一笔
  await page.evaluate(() => {
    const view = document.getElementById('view');
    const r = document.getElementById('canvasWrap').getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    [0.3, 0.4, 0.5, 0.6, 0.7].forEach((p, i) => {
      const ev = new PointerEvent('pointermove', {
        bubbles: true, clientX: cx - 220 + i * 4, clientY: cy - 160,
        pointerId: 22, pointerType: 'mouse', isPrimary: true,
        pressure: p, width: 4, height: 4, buttons: 0
      });
      ev.getCoalescedEvents = () => [];
      view.dispatchEvent(ev);
    });
  });
  await sleep(200);
  ps = await strokeAndExpectNew('报成 mouse 的板子也画上了（新笔迹已产生）', {
    pt: 'mouse', id: 22,
    points: [
      { x: X.a, y: Y.g2, p: 0.35, w: 4, h: 4 }, { x: X.b, y: Y.g2, p: 0.5, w: 4, h: 4 },
      { x: X.c, y: Y.g2, p: 0.75, w: 4, h: 4 }, { x: X.d, y: Y.g2, p: 0.9, w: 4, h: 4 }
    ]
  });
  if (ps) {
    const spread = Math.max(...ps) - Math.min(...ps);
    ok('报成 mouse 的板子也用上了压力（旧代码这里恒 0.5）', spread > 0.2,
      '压力 ' + ps.map(v => v.toFixed(2)).join(','));
  } else {
    ok('报成 mouse 的板子也用上了压力', false, '没产生笔迹');
  }
  const detect2 = await page.evaluate(() => window.ChaApp.state.penDetect);
  ok('识别结果为 guess（已兼容）', detect2 === 'guess', String(detect2));

  console.log('\n=== 3) 真鼠标（恒定 0.5、1x1 面积）→ 必须用 0.5，不许瞎猜 ===');
  await page.evaluate(() => window.ChaApp.resetPenProbe());
  ps = await strokeAndExpectNew('真鼠标也画上了（新笔迹已产生）', {
    pt: 'mouse', id: 33,
    points: [
      { x: X.a, y: Y.g3, p: 0.5, w: 1, h: 1 }, { x: X.b, y: Y.g3, p: 0.5, w: 1, h: 1 },
      { x: X.c, y: Y.g3, p: 0.5, w: 1, h: 1 }, { x: X.d, y: Y.g3, p: 0.5, w: 1, h: 1 }
    ]
  });
  if (ps) {
    const allHalf = ps.every(v => Math.abs(v - 0.5) < 0.001);
    ok('真鼠标全程 0.5（没有把鼠标误判成笔）', allHalf,
      '压力 ' + ps.map(v => v.toFixed(2)).join(','));
  } else {
    ok('真鼠标全程 0.5', false, '没产生笔迹');
  }

  console.log('\n=== 4) 起笔占位值不该污染整笔 ===');
  // 真笔：pointerdown 给 0.5（Chrome 常见），后续 move 给真实值
  ps = await strokeAndExpectNew('起笔那笔也画上了（新笔迹已产生）', {
    pt: 'pen', id: 44,
    points: [
      { x: X.a, y: Y.g4, p: 0.5 }, { x: X.b, y: Y.g4, p: 0.15 },
      { x: X.c, y: Y.g4, p: 0.2 }, { x: X.d, y: Y.g4, p: 0.18 }
    ]
  });
  if (ps) {
    // 起点不该是「半压」那种明显偏大的值：应该贴近后续的真实压力档
    const first = ps[0];
    ok('起笔没有停在占位值 0.5（真压力立刻接管）', first < 0.45,
      '首点压力 ' + first.toFixed(2) + '，序列 ' + ps.map(v => v.toFixed(2)).join(','));
  } else {
    ok('起笔没有停在占位值 0.5', false, '没产生笔迹');
  }

  console.log('\n=== 5) 面板提示 ===');
  // 模拟「板子完全没把压力交给浏览器」：mouse + 恒定 0.5 + 1x1。
  // 必须换一根新的指针 id（id 变了 notePointerSample 会重开一局采样），
  // 并且先把上一组的采样清掉 —— 否则 penProbe 里还留着第 4 组真笔的记录，
  // looksLikePen() 会看到 types.pen 直接返回 false（判定「有真笔，不用猜」），
  // 这一笔就被当成真鼠标，penDetect 也就永远走不到 'none'。
  await page.evaluate(() => window.ChaApp.resetPenProbe());
  await strokeAndExpectNew('无压感的鼠标也画上了（新笔迹已产生）', {
    pt: 'mouse', id: 55,
    points: [
      { x: X.a, y: Y.g5, p: 0.5, w: 1, h: 1 }, { x: X.b, y: Y.g5, p: 0.5, w: 1, h: 1 },
      { x: X.c, y: Y.g5, p: 0.5, w: 1, h: 1 }
    ]
  });
  const hint = await page.evaluate(() => {
    const el = document.getElementById('penHint');
    return {
      cls: el.className, text: el.textContent || '',
      visible: el.offsetParent !== null, detect: window.ChaApp.state.penDetect
    };
  });
  ok('给了「没检测到笔压」的提示', hint.visible && hint.text.indexOf('Windows Ink') >= 0,
    'detect=' + hint.detect + ' · ' + (hint.text || '(空)').slice(0, 30) + '…');

  // 一旦出现真笔，提示要撤掉
  await page.evaluate(o => window.__synth(o), {
    pt: 'pen', id: 66,
    points: [{ x: X.b, y: Y.g5b, p: 0.3 }, { x: X.c, y: Y.g5b, p: 0.6 }]
  });
  await sleep(400);
  const after = await page.evaluate(() => {
    const el = document.getElementById('penHint');
    return { cls: el.className, on: el.className.indexOf('on') >= 0, detect: window.ChaApp.state.penDetect };
  });
  ok('真笔出现后提示撤掉', after.detect === 'pen' && !after.on,
    'class=' + after.cls + ' detect=' + after.detect);

  console.log('\n=== 6) 关掉压感开关时不该有提示 ===');
  await page.evaluate(() => {
    const c = document.getElementById('pressureChk');
    c.checked = false;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  const off = await page.evaluate(() => {
    const el = document.getElementById('penHint');
    return { visible: el.offsetParent !== null, cls: el.className };
  });
  ok('关掉压感后提示消失', !off.visible, 'class=' + off.cls);

  // 再打开压感：之前的判定要能恢复出提示（面板不能一直空着）
  await page.evaluate(() => {
    const c = document.getElementById('pressureChk');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '  ' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
