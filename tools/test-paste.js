/**
 * 粘贴回归：把剪贴板里的图片贴成新图层。
 *
 * 这一条最容易出错的地方不是「贴不上去」，而是**贴到哪一层去了**。
 * 图层是服务端建的，客户端得提前指定 id —— 不指定的话本地兜底到「活动图层」、
 * 服务端兜底到「最后一层」，两边一旦不是同一层，作者看到的和别的端看到的就分家
 * （「文字图层」此前就是这么错的，所以第 5 组专门为它留了断言）。
 *
 * 覆盖：
 *   1. 真·系统剪贴板（navigator.clipboard.write → Ctrl+V 走菜单快捷键）：
 *      新图层 / 像素落对新图层 / 居中 / 尺寸不变 / 跨端一致 / 可撤销
 *   2. 系统剪贴板里只有文字时的**内部剪贴板兜底** + 超尺寸等比缩放
 *   3. 原生粘贴事件（右键 → 粘贴那条路）
 *   4. 边界：剪贴板没图 / 变换中 / 图层数上限
 *   5. 文字图层的归属（根因回归：笔迹必须落在新建的那一层）
 *
 * 用法: node tools/test-paste.js [http://127.0.0.1:8437]
 *
 * ⚠ 桌面端那条 `chahu:clipboard-image`（主进程 clipboard.readImage）没法在
 *   浏览器里测 —— 它要打包后的 Electron 环境。这里测的是网页版那条
 *   navigator.clipboard.read() 与两条兜底路径。
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

/** 注入几个测量小工具：造 PNG、按图层算墨迹包围盒、列图层 id */
const HELPERS = () => {
  window.__mkPng = function (w, h, color) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = color || '#3366ff';
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };
  /** 某个图层自己那点像素的包围盒。图层底子是透明的，所以 alpha>8 就是「贴进去的那块」 */
  window.__bbox = function (id) {
    const e = window.ChaApp.engine;
    const c = e.renderDocument({ onlyLayer: id, transparentBackground: true, rawLayer: true });
    const d = c.ctx.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
    const W = c.canvas.width, H = c.canvas.height;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 8) {
          n++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, W, H, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  window.__ids = function () { return window.ChaApp.engine.layerList().map(l => l.id); };
  window.__count = function () { return window.ChaApp.engine.layers.length; };
};

/**
 * 在页面里造一张 PNG 并**写进系统剪贴板**（要 clipboard-write 权限）。
 * 这是在浏览器里能做到的、最接近「从别的软件复制一张图过来」的模拟。
 *
 * 注意：图片必须在页面里现造 —— Chrome 不允许 `fetch()` 读 `data:` URL
 * （报 "Failed to fetch"），所以别想着先把 dataURL 传进去再 fetch 成 blob。
 */
async function writeImageToClipboard(page, w, h, color) {
  return page.evaluate(async ([w, h, color]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = color || '#3366ff';
    x.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  }, [w, h, color]);
}

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

/** 等图层数到达 want（粘贴是「建层 → 广播 → 再回传像素」两步，得等齐） */
async function waitLayers(page, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    if (await page.evaluate(() => window.ChaApp.engine.layers.length) === want) return true;
    await sleep(100);
  }
  return false;
}

/** 等某个图层的墨迹数到达 want（像素回传要一个往返） */
async function waitInk(page, id, want, ms) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < (ms || 8000)) {
    last = await page.evaluate(x => window.__bbox(x).n, id);
    if (want === 0 ? last === 0 : last > 0) return last;
    await sleep(120);
  }
  return last;
}

/** 按 Ctrl+V（走菜单那套快捷键；焦点必须在 body 上） */
async function ctrlV(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+V');
  await sleep(400);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const mkPage = async () => {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    return p;
  };

  const A = await mkPage();
  await A.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const B = await mkPage();

  const room = await createRoom(A, '甲', '粘贴回归', 800, 1200);
  await join(B, room, '乙');
  console.log('\n房间 ' + room + '（画布 800×1200）已就绪，两个客户端');

  /* ================= 1) 系统剪贴板 + Ctrl+V ================= */
  console.log('\n=== 1) 系统剪贴板 → Ctrl+V（菜单快捷键）===');
  await writeImageToClipboard(A, 800, 800, '#3366ff');
  const baseIds = await A.evaluate(() => window.__ids());
  const n0 = baseIds.length;

  await ctrlV(A);
  const grew1 = await waitLayers(A, n0 + 1);
  ok('Ctrl+V 之后多出一个图层', grew1, '图层数 ' + (await A.evaluate(() => window.__count())));

  const ids1 = await A.evaluate(() => window.__ids());
  const newId1 = ids1.filter(x => baseIds.indexOf(x) < 0)[0];
  ok('新图层存在', !!newId1, newId1);
  const name1 = await A.evaluate(id => {
    const l = window.ChaApp.engine.getLayer(id);
    return l ? l.name : null;
  }, newId1);
  ok('新图层名字是「粘贴」', name1 === '粘贴', name1);

  const ink1 = await waitInk(A, newId1, 1);
  ok('像素贴进了**新图层**', ink1 > 0, ink1 + ' 像素');

  let oldEmpty = true;
  for (const id of baseIds) {
    const b = await A.evaluate(x => window.__bbox(x).n, id);
    if (b > 0) { oldEmpty = false; console.log('    （旧图层 ' + id + ' 上有 ' + b + ' 像素）'); }
  }
  ok('原有图层一个像素都没被写脏', oldEmpty);

  const bb1 = await A.evaluate(x => window.__bbox(x), newId1);
  ok('尺寸没被缩放（800×800 原样贴入）', bb1.w === 800 && bb1.h === 800, bb1.w + '×' + bb1.h);
  ok('水平居中', Math.abs(bb1.cx - 400) <= 2, 'cx=' + bb1.cx);
  ok('垂直居中', Math.abs(bb1.cy - 600) <= 2, 'cy=' + bb1.cy);

  // 跨端：乙那边也得看到同一个图层、同样的像素
  const grewB = await waitLayers(B, n0 + 1);
  ok('另一端也看到多了一个图层', grewB);
  const inkB = await waitInk(B, newId1, 1);
  ok('另一端看到的像素数和甲一致', inkB === bb1.n, inkB + ' vs ' + bb1.n);

  // 撤销：把这一层清回透明，壳留着
  await A.evaluate(() => window.ChaApp.undo());
  const inkAfterUndo = await waitInk(A, newId1, 0);
  ok('撤销后新图层变回空的', inkAfterUndo === 0, inkAfterUndo + ' 像素');
  const stay = await A.evaluate(() => window.__count());
  ok('撤销不会把图层删掉（只是清空）', stay === n0 + 1, '图层数 ' + stay);

  /* ================= 2) 内部剪贴板兜底 + 等比缩放 ================= */
  console.log('\n=== 2) 系统剪贴板只有文字 → 内部剪贴板兜底 + 等比缩放 ===');
  await A.evaluate(() => navigator.clipboard.writeText('这不是一张图'));
  const widePng = await A.evaluate(() => window.__mkPng(2400, 400, '#ff6633'));
  await A.evaluate(d => {
    const img = new Image();
    img.onload = () => { window.__wideReady = true; };
    img.src = d;
    window.ChaApp.state.clip = { png: d, w: 2400, h: 400 };
  }, widePng);
  await A.waitForFunction(() => window.__wideReady === true, null, { timeout: 5000 });

  const before2 = await A.evaluate(() => window.__ids());
  await ctrlV(A);
  const grew2 = await waitLayers(A, before2.length + 1);
  ok('系统剪贴板里只有文字时，仍然用内部剪贴板贴上了', grew2);

  const newId2 = (await A.evaluate(() => window.__ids())).filter(x => before2.indexOf(x) < 0)[0];
  const ink2 = await waitInk(A, newId2, 1);
  const bb2 = await A.evaluate(x => window.__bbox(x), newId2);
  ok('2400×400 的图被等比缩到画布宽 800', bb2.w === 800, bb2.w + '×' + bb2.h);
  ok('高度按同一比例（400×800/2400 ≈ 133）', Math.abs(bb2.h - 133) <= 2, bb2.h);
  ok('缩放后仍然居中', Math.abs(bb2.cx - 400) <= 2 && Math.abs(bb2.cy - 600) <= 2, bb2.cx + ',' + bb2.cy);
  ok('缩放的图确实有像素', ink2 > 0, ink2);

  /* ================= 3) 原生粘贴事件 ================= */
  console.log('\n=== 3) 原生粘贴事件（右键 → 粘贴那条路）===');
  const before3 = await A.evaluate(() => window.__ids());
  await A.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#22aa55'; x.fillRect(0, 0, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true
    }));
  });
  const grew3 = await waitLayers(A, before3.length + 1);
  ok('粘贴事件被接住并新建了图层', grew3);
  const newId3 = (await A.evaluate(() => window.__ids())).filter(x => before3.indexOf(x) < 0)[0];
  const bb3 = await A.evaluate(x => window.__bbox(x), newId3);
  ok('贴进来的图是 200×200', bb3.w === 200 && bb3.h === 200, bb3.w + '×' + bb3.h);
  ok('同样居中', Math.abs(bb3.cx - 400) <= 2 && Math.abs(bb3.cy - 600) <= 2, bb3.cx + ',' + bb3.cy);

  console.log('\n=== 3b) 焦点在输入框里时不抢粘贴 ===');
  const before3b = await A.evaluate(() => window.__count());
  await A.evaluate(async () => {
    const inp = document.createElement('input');
    inp.id = '__probeInput';
    document.body.appendChild(inp);
    inp.focus();
    const c = document.createElement('canvas');
    c.width = 50; c.height = 50;
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
    inp.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true
    }));
  });
  await sleep(700);
  ok('焦点在输入框时，图片粘贴不会被画布抢走',
    (await A.evaluate(() => window.__count())) === before3b);
  await A.evaluate(() => { const e = document.getElementById('__probeInput'); if (e) e.remove(); });

  /* ================= 4) 边界 ================= */
  console.log('\n=== 4) 边界 ===');
  // 4a 剪贴板里真的没图
  await A.evaluate(() => {
    navigator.clipboard.writeText('只有文字');
    window.ChaApp.state.clip = null;
  });
  const before4 = await A.evaluate(() => window.__count());
  await ctrlV(A);
  await sleep(900);
  ok('剪贴板里没有图片时不建图层',
    (await A.evaluate(() => window.__count())) === before4, '图层数 ' + before4);
  const hasWarn = await A.evaluate(() =>
    Array.from(document.querySelectorAll('.toast')).some(t => /没有图片/.test(t.textContent)));
  ok('并且给了「剪贴板里没有图片」的提示', hasWarn);

  // 4b 变换进行中不许粘（否则像素会写进一个马上要被整体替换的图层）
  await A.evaluate(() => {
    window.ChaApp.state.clip = { png: window.__mkPng(120, 120, '#aa2255'), w: 120, h: 120 };
    window.ChaApp.selectAll();
  });
  await A.click('#btnTransform');
  await sleep(400);
  ok('先进入变换状态', await A.evaluate(() => !!window.ChaApp.engine.transform));
  const before4b = await A.evaluate(() => window.__count());
  await ctrlV(A);
  await sleep(900);
  ok('变换中粘贴被拦下，没有新建图层',
    (await A.evaluate(() => window.__count())) === before4b, '图层数 ' + before4b);
  await A.click('#tpCancel');
  await sleep(500);
  ok('变换已中止', !(await A.evaluate(() => !!window.ChaApp.engine.transform)));

  /* ================= 5) 文字图层的归属（根因回归）================= */
  console.log('\n=== 5) 文字图层的归属（根因回归）===');
  const before5 = await A.evaluate(() => window.__ids());
  await A.evaluate(() => window.ChaApp.placeTextAt({ x: 400, y: 600 }));
  await A.fill('#textInput', '归属');
  await A.evaluate(() => window.ChaApp.commitText());
  const grew5 = await waitLayers(A, before5.length + 1);
  ok('文字自动建了一个新图层', grew5);
  const newId5 = (await A.evaluate(() => window.__ids())).filter(x => before5.indexOf(x) < 0)[0];
  // 文字走的是「建层 → 广播 → 再补笔迹」两步，**等图层到位 = 只等到第一步**：
  // 笔迹要等 stroke:added 回来才进 engine.strokes。这里读一次就跑会读到空数组，
  // 看起来像「归属错了」，其实只是还没回来（下一条断言要等像素，反倒是它先等到）。
  const strokeLayers = await (async () => {
    const t0 = Date.now();
    let seen = [];
    while (Date.now() - t0 < 6000) {
      seen = await A.evaluate(() => window.ChaApp.engine.strokes.map(s => s.layerId || null));
      if (seen.indexOf(newId5) >= 0) return seen;
      await sleep(120);
    }
    return seen;
  })();
  ok('这条文字笔迹落在**新建的那一层**上（不是活动图层）',
    strokeLayers.length > 0 && strokeLayers.every(x => x === newId5),
    '笔迹层=' + JSON.stringify(strokeLayers) + ' / 新层=' + newId5);
  const textPx = await waitInk(A, newId5, 1);
  ok('新图层上真的画出了字', textPx > 0, textPx + ' 像素');

  /* ================= 6) 图层数上限 ================= */
  console.log('\n=== 6) 图层数上限 ===');
  const MAXL = 16;
  let guard = 0;
  while ((await A.evaluate(() => window.__count())) < MAXL && guard++ < 40) {
    const n = await A.evaluate(() => window.__count());
    await A.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await A.keyboard.press('Control+Shift+N');
    await waitLayers(A, n + 1, 4000);
  }
  ok('已经堆到图层上限 ' + MAXL, (await A.evaluate(() => window.__count())) === MAXL,
    '图层数 ' + (await A.evaluate(() => window.__count())));
  await A.evaluate(() => {
    window.ChaApp.state.clip = { png: window.__mkPng(100, 100, '#000000'), w: 100, h: 100 };
  });
  const fullCount = await A.evaluate(() => window.__count());
  await ctrlV(A);
  await sleep(1000);
  ok('到上限之后再粘贴会被拦下，不会突破上限',
    (await A.evaluate(() => window.__count())) === fullCount, '图层数 ' + fullCount);

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n测试崩了:', e && e.stack || e);
  process.exit(2);
});
