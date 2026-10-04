/**
 * 介绍视频 · 拍摄脚本
 *
 * 用 Playwright 真实操作茶绘，并把整个过程录下来（每个镜头一个 webm）。
 * 分镜录是为了后期能单独调速 / 裁剪 / 并排。
 *
 * 几个踩过的坑，写在前面：
 *   · **坐标一律用「文档比例」**（0~1），再乘 engine.width/height 换成文档坐标。
 *     直接写死像素的话，换个画布尺寸就有点落到画布外面 —— 那样 pointerdown
 *     会被引擎忽略，整笔都画不出来（而且界面上什么都不报，很难查）。
 *   · 每一笔画完都回头数一下 engine.strokes，没涨就说明这一笔没落下去。
 *   · 房子默认是 1600×1000；zoomFit 之后文档在 #view 里的位置由 docToScreen 给。
 *
 * 用法: node tools/video/shoot.js [http://127.0.0.1:8440]
 * 产物: video/shots/*.webm
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('../pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8440';
const OUT = path.resolve(__dirname, '..', '..', 'video', 'shots');
const W = 1920, H = 1080;
// --only=3 只重拍第 3 个镜头（改一处不用三条都重来）
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const want = n => !ONLY || ONLY.indexOf(String(n)) >= 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

/* ---------------------------------------------------------------- 分镜录制 */

async function newShot(browser, name) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: W, height: H } }
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  !! pageerror:', String(e).split('\n')[0]));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  return { ctx, page, name, t0: Date.now() };
}

async function finishShot(shot) {
  const v = shot.page.video();
  await shot.ctx.close();
  const src = await v.path();
  const dst = path.join(OUT, shot.name + '.webm');
  fs.copyFileSync(src, dst);
  try { fs.unlinkSync(src); } catch (e) { /* ignore */ }
  log(shot.name + '.webm', (fs.statSync(dst).size / 1024 / 1024).toFixed(1) + 'MB');
  return dst;
}

/* ---------------------------------------------------------------- 进房间 */

async function createOnPage(page, nick, roomName) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 20000 });
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await page.evaluate(() => {
    document.getElementById('entryMask').classList.add('hidden');
    window.ChaApp.zoomFit();
  });
  await sleep(700);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function joinOnPage(page, roomId, nick) {
  await page.goto(BASE + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state && window.ChaApp.state.joined, { timeout: 25000 });
  await sleep(800);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    if (window.ChaApp.state.room) window.ChaApp.zoomFit();
  });
  await sleep(700);
}

/**
 * 「朋友第一次来」：真的走一遍入口界面 ——
 * 打开页面 → 看到房间列表 → 点一下房间 → 进来。
 * 这段是整支片子最想讲清楚的事：**不用装东西，浏览器打开就能进**。
 */
async function joinViaEntry(page, roomName, nick) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 25000 });
  await sleep(300);
  await page.fill('#nameInput', nick);
  await sleep(1500);                       // 让观众看清「进入茶绘室」这个界面
  const clicked = await page.evaluate((want) => {
    const rows = [...document.querySelectorAll('#entryMask .room-item')];
    const hit = rows.find(r => (r.textContent || '').indexOf(want) >= 0) || rows[0];
    if (!hit) return false;
    hit.click();
    return true;
  }, roomName);
  if (!clicked) throw new Error('入口里没找到房间行');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 25000 });
  await sleep(1600);                       // 进来之后停一下：画面同步是有过程的
  await page.evaluate(() => window.ChaApp.zoomFit());
  await sleep(700);
}

/* ---------------------------------------------------------------- 操作小工具 */

async function setSize(page, n) {
  await page.evaluate((v) => {
    const el = document.getElementById('sizeRange');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, n);
}

async function pickBrush(page, id) {
  const okc = await page.evaluate((bid) => {
    const el = document.querySelector('#toolGrid .tool[data-item="' + bid + '"], #brushGrid .tool[data-item="' + bid + '"]');
    if (!el) return false;
    el.click();
    return true;
  }, id);
  if (!okc) console.log('  !! 找不到笔刷', id);
  await sleep(140);
}

async function setColor(page, hex) {
  await page.evaluate((h) => {
    const el = document.getElementById('hexInput');
    el.value = h;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
  await sleep(100);
}

/** Catmull-Rom 采样，把几个控制点变成一条顺滑的曲线 */
function catmull(pts, per) {
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i < p.length - 2; i++) {
    const p0 = p[i - 1], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * 画一笔。pts 用**文档比例**给（0~1），内部再换成文档坐标 → 屏幕坐标。
 * 传 smooth=true 会先过一遍 Catmull-Rom，画出来是圆润的曲线而不是折线。
 */
async function stroke(page, pts, opts) {
  const o = opts || {};
  const stepMs = o.stepMs != null ? o.stepMs : 38;
  const docPts = await page.evaluate((ps) => {
    const e = window.ChaApp.engine;
    return ps.map(p => [p[0] * e.width, p[1] * e.height]);
  }, pts);
  const path = o.smooth === false ? docPts : catmull(docPts, o.per || 10);

  const before = await page.evaluate(() => window.ChaApp.engine.strokes.length);
  const scr = await page.evaluate((ps) => ps.map(p => window.ChaApp.engine.docToScreen(p[0], p[1])), path);
  const box = await page.locator('#view').boundingBox();

  // 起点一定要落在文档里，否则引擎不认这一笔（而且不报错）
  const first = await page.evaluate((p) => {
    const e = window.ChaApp.engine;
    return { inside: p[0] >= 0 && p[1] >= 0 && p[0] < e.width && p[1] < e.height, doc: [Math.round(p[0]), Math.round(p[1])] };
  }, path[0]);
  if (!first.inside) throw new Error('起点在文档外: ' + JSON.stringify(first.doc));

  await page.mouse.move(box.x + scr[0].x, box.y + scr[0].y);
  await sleep(70);
  await page.mouse.down();
  for (let i = 1; i < scr.length; i++) {
    await page.mouse.move(box.x + scr[i].x, box.y + scr[i].y);
    await sleep(stepMs);
  }
  await page.mouse.up();
  await sleep(o.after != null ? o.after : 260);

  const after = await page.evaluate(() => window.ChaApp.engine.strokes.length);
  if (after <= before) console.log('  !! 这一笔没落下去（strokes', before, '→', after, '）');
  return after > before;
}

/** 光标溜达，让「远端光标」动起来 */
async function wander(page, pts, stepMs) {
  const box = await page.locator('#view').boundingBox();
  const docPts = await page.evaluate((ps) => {
    const e = window.ChaApp.engine;
    return ps.map(p => [p[0] * e.width, p[1] * e.height]);
  }, pts);
  const path = catmull(docPts, 6);
  for (const p of path) {
    const s = await page.evaluate((q) => window.ChaApp.engine.docToScreen(q[0], q[1]), p);
    await page.mouse.move(box.x + s.x, box.y + s.y);
    await sleep(stepMs || 80);
  }
}

/** 打开某个菜单并点其中一项（文本匹配；二级菜单先 hover 展开） */
async function pickMenuItem(page, menu, rowText, sub) {
  await page.click('.menu-title[data-menu="' + menu + '"]');
  await sleep(420);
  if (sub) {
    await page.hover('.menu-drop:not(.hidden) .menu-row:has-text("' + rowText + '")');
    await sleep(560);                       // 子菜单有玻璃入场动画，等它弹出来
    await page.click('.menu-sub:not(.hidden) .menu-row:has-text("' + sub + '")');
  } else {
    await page.click('.menu-drop:not(.hidden) .menu-row:has-text("' + rowText + '")');
  }
  await sleep(320);
}

/** 关掉还开着的菜单（点底栏，不会落笔） */
async function dismissMenu(page) {
  await page.mouse.click(1560, 1066);
  await sleep(260);
}

/**
 * 裸拖拽（不落笔）：摆尺子 / 拖尺子把手都用它。坐标同样是文档比例。
 * 会分 8 步挪过去，让「拖动」这件事在录屏里看得见。
 */
async function rawDrag(page, from, to, stepMs) {
  const box = await page.locator('#view').boundingBox();
  const at = (fx, fy) => page.evaluate(([fx2, fy2]) => {
    const e = window.ChaApp.engine;
    return window.ChaApp.engine.docToScreen(fx2 * e.width, fy2 * e.height);
  }, [fx, fy]);
  const a = await at(from[0], from[1]);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await sleep(90);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    const s = await at(from[0] + (to[0] - from[0]) * k / 8, from[1] + (to[1] - from[1]) * k / 8);
    await page.mouse.move(box.x + s.x, box.y + s.y);
    await sleep(stepMs || 42);
  }
  await page.mouse.up();
  await sleep(320);
}

/**
 * 把鼠标挪出画布（停到左栏上）。
 * 收尾用：不然画面定格的时候，画布上会挂着两个光标圈 ——
 * 本机的圆圈笔刷光标 + 对方的名字标签，挡在画上很难看。
 */
async function parkMouse(page) {
  await page.mouse.move(120, 560);
  await sleep(120);
  await page.mouse.move(130, 620);
  await sleep(400);
}

/* ---------------------------------------------------------------- 画什么 */

// 全部用文档比例（0~1）。画布是 1600×1000。
const ART = {
  hillBack: [[0.08, 0.70], [0.24, 0.53], [0.40, 0.63], [0.58, 0.47], [0.76, 0.66], [0.93, 0.58]],
  hillFront: [[0.05, 0.84], [0.27, 0.66], [0.50, 0.79], [0.73, 0.64], [0.95, 0.79]],
  ground: [[0.10, 0.925], [0.36, 0.885], [0.62, 0.905], [0.90, 0.88]],
  sun: [[0.760, 0.245], [0.766, 0.252]],
  cloud1: [[0.180, 0.230], [0.235, 0.196], [0.292, 0.228]],
  cloud2: [[0.470, 0.150], [0.525, 0.122], [0.580, 0.152]],
  bird1: [[0.395, 0.315], [0.420, 0.288], [0.445, 0.316]],
  bird2: [[0.470, 0.372], [0.492, 0.348], [0.514, 0.372]],
  bird3: [[0.545, 0.290], [0.568, 0.266], [0.591, 0.292]]
};

const C = {
  hillBack: '#8CC3A6',
  hillFront: '#3F8F6E',
  ground: '#2C5F4C',
  sun: '#F5A62B',
  cloud: '#B9D2EA',
  bird: '#33413C'
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!ONLY) for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webm')) fs.unlinkSync(path.join(OUT, f));

  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ================= 镜头 1：一个人也能画 ================= */
  if (want(1)) {
  console.log('\n[镜头 1] solo');
    const s = await newShot(browser, '01-solo');
    await createOnPage(s.page, '小茶', '一起画的小风景');
    await pickBrush(s.page, 'hardRound');
    await setSize(s.page, 54);
    await setColor(s.page, C.hillBack);
    await sleep(1400);                       // 空画布停一下，剪辑时好切
    await stroke(s.page, ART.hillBack, { stepMs: 46, after: 700 });
    await setColor(s.page, C.hillFront);
    await setSize(s.page, 62);
    await stroke(s.page, ART.hillFront, { stepMs: 44, after: 700 });
    await setColor(s.page, C.ground);
    await setSize(s.page, 30);
    await stroke(s.page, ART.ground, { stepMs: 40, after: 900 });
    await pickBrush(s.page, 'hardRound');
    await setSize(s.page, 190);
    await setColor(s.page, C.sun);
    await stroke(s.page, ART.sun, { smooth: false, stepMs: 140, after: 1400 });
    await parkMouse(s.page);
    await sleep(1500);
    await finishShot(s);
  }

  /* ================= 镜头 2：两个人一起画 ================= */
  if (want(2)) {
  console.log('\n[镜头 2] duo（两端同时录）');
    const A = await newShot(browser, '02-duo-a');
    const B = await newShot(browser, '02-duo-b');
    const room = await createOnPage(A.page, '小茶', '一起画的小风景');
    await joinOnPage(B.page, room, '阿墨');
    await pickBrush(A.page, 'hardRound');
    await pickBrush(B.page, 'hardRound');
    await setSize(A.page, 54);
    await setSize(B.page, 54);
    await setColor(A.page, C.hillBack);
    await setColor(B.page, '#5B8DEF');
    await sleep(1500);

    // 先互相打个招呼：两边的光标各自溜达
    await Promise.all([
      wander(A.page, [[0.32, 0.60], [0.45, 0.52], [0.60, 0.62], [0.72, 0.55]], 105),
      wander(B.page, [[0.70, 0.42], [0.58, 0.48], [0.44, 0.40]], 105)
    ]);

    // A 画远山；B 同时把太阳扫出来
    await Promise.all([
      stroke(A.page, ART.hillBack, { stepMs: 52, after: 400 }),
      (async () => {
        await sleep(1100);
        await setSize(B.page, 190);
        await setColor(B.page, C.sun);
        await stroke(B.page, ART.sun, { smooth: false, stepMs: 150, after: 400 });
        await sleep(500);
      })()
    ]);

    // A 画前景山；B 添两朵云
    await Promise.all([
      (async () => {
        await setColor(A.page, C.hillFront);
        await setSize(A.page, 62);
        await stroke(A.page, ART.hillFront, { stepMs: 50, after: 400 });
      })(),
      (async () => {
        await sleep(900);
        await pickBrush(B.page, 'airbrush');
        await setSize(B.page, 120);
        await setColor(B.page, C.cloud);
        await stroke(B.page, ART.cloud1, { stepMs: 70, after: 300 });
        await stroke(B.page, ART.cloud2, { stepMs: 70, after: 300 });
        await sleep(400);
      })()
    ]);

    // A 收地面线；B 点几只鸟
    await Promise.all([
      (async () => {
        await setColor(A.page, C.ground);
        await setSize(A.page, 30);
        await stroke(A.page, ART.ground, { stepMs: 44, after: 400 });
      })(),
      (async () => {
        await sleep(700);
        await pickBrush(B.page, 'inking');
        await setSize(B.page, 14);
        await setColor(B.page, C.bird);
        await stroke(B.page, ART.bird1, { stepMs: 46, after: 220 });
        await stroke(B.page, ART.bird2, { stepMs: 46, after: 220 });
        await stroke(B.page, ART.bird3, { stepMs: 46, after: 500 });
      })()
    ]);

    // 收尾：两边光标各自走开，再挪出画布，画面干干净净地定格
    await Promise.all([
      wander(A.page, [[0.55, 0.80], [0.68, 0.74]], 150),
      wander(B.page, [[0.72, 0.52], [0.52, 0.40]], 150)
    ]);
    await sleep(700);
    await Promise.all([parkMouse(A.page), parkMouse(B.page)]);
    await sleep(2500);

    await finishShot(A);
    await finishShot(B);
  }

  /* ================= 镜头 3：朋友用浏览器加进来 ================= */
  if (want(3)) {
  console.log('\n[镜头 3] join');
    const A = await newShot(browser, '03-host-a');
    const room = await createOnPage(A.page, '小茶', '一起画的小风景');
    await pickBrush(A.page, 'hardRound');
    await setSize(A.page, 54);
    await setColor(A.page, C.hillBack);
    await stroke(A.page, ART.hillBack, { stepMs: 50, after: 400 });
    await setColor(A.page, C.hillFront);
    await setSize(A.page, 62);
    await stroke(A.page, ART.hillFront, { stepMs: 48, after: 500 });

    // B 从「打开浏览器」开始，全程真走一遍
    const B = await newShot(browser, '03-guest-b');
    await joinViaEntry(B.page, '一起画的小风景', '阿墨');
    await pickBrush(B.page, 'hardRound');
    await setSize(B.page, 190);
    await setColor(B.page, C.sun);
    await stroke(B.page, ART.sun, { smooth: false, stepMs: 150, after: 900 });
    await pickBrush(B.page, 'airbrush');
    await setSize(B.page, 140);
    await setColor(B.page, C.cloud);
    await stroke(B.page, ART.cloud1, { stepMs: 70, after: 700 });
    await sleep(1200);
    await sleep(1500);
    await finishShot(A);
    await finishShot(B);
  }

  /* ================= 镜头 4：SAI2 式尺子 ================= */
  if (want(4)) {
  console.log('\n[镜头 4] ruler');
    const s = await newShot(browser, '04-ruler');
    await createOnPage(s.page, '小茶', '尺子画的小镇');
    // 先画条地平线，让画面不空
    await pickBrush(s.page, 'hardRound');
    await setSize(s.page, 44);
    await setColor(s.page, C.hillBack);
    await stroke(s.page, ART.hillBack, { stepMs: 46, after: 500 });

    // 摆一把直线尺（尺子菜单 → 直线尺 → 在画布上拖一下）
    await pickMenuItem(s.page, 'ruler', '直线尺');
    await sleep(500);
    await rawDrag(s.page, [0.14, 0.62], [0.86, 0.58], 46);
    await sleep(600);

    // 三条不同颜色 / 不同位置的笔画全部吸附到尺子上
    await setSize(s.page, 20);
    await setColor(s.page, '#33413C');
    await stroke(s.page, [[0.18, 0.50], [0.82, 0.46]], { stepMs: 40, after: 260 });
    await setColor(s.page, '#D9534F');
    await stroke(s.page, [[0.24, 0.72], [0.78, 0.70]], { stepMs: 40, after: 260 });
    await setColor(s.page, '#2F7DE1');
    await stroke(s.page, [[0.30, 0.44], [0.72, 0.42]], { stepMs: 40, after: 500 });

    // 抓住中央把手，把整把尺子往下挪 —— 笔画跟着新位置吸
    await rawDrag(s.page, [0.50, 0.60], [0.50, 0.78], 52);
    await sleep(400);
    await setSize(s.page, 20);
    await setColor(s.page, '#8A5D12');
    await stroke(s.page, [[0.26, 0.60], [0.74, 0.58]], { stepMs: 40, after: 600 });

    await pickMenuItem(s.page, 'ruler', '重置尺子');
    await parkMouse(s.page);
    await sleep(1400);
    await finishShot(s);
  }

  /* ================= 镜头 5：深浅双主题（液态玻璃） ================= */
  if (want(5)) {
  console.log('\n[镜头 5] theme');
    const s = await newShot(browser, '05-theme');
    await createOnPage(s.page, '小茶', '一起画的小风景');
    await pickBrush(s.page, 'hardRound');
    await setSize(s.page, 54);
    await setColor(s.page, C.hillBack);
    await stroke(s.page, ART.hillBack, { stepMs: 44, after: 400 });
    await setSize(s.page, 190);
    await setColor(s.page, C.sun);
    await stroke(s.page, ART.sun, { smooth: false, stepMs: 140, after: 600 });

    // 菜单本身就是玻璃的：打开 → 悬停「界面主题」弹出子菜单 → 深色
    await pickMenuItem(s.page, 'window', '界面主题', '深色');
    await sleep(300);
    await dismissMenu(s.page);
    await sleep(2200);                      // 深色玻璃 UI 停一会儿，让观众看清
    await parkMouse(s.page);
    await sleep(900);
    await finishShot(s);
  }

  /* ================= 镜头 6：手机浏览器加进来 ================= */
  if (want(6)) {
  console.log('\n[镜头 6] phone（电脑 + 手机同时录）');
    const A = await newShot(browser, '06-host-a');
    const room = await createOnPage(A.page, '小茶', '一起画的小风景');
    await pickBrush(A.page, 'hardRound');
    await setSize(A.page, 54);
    await setColor(A.page, C.hillBack);
    await stroke(A.page, ART.hillBack, { stepMs: 48, after: 400 });
    await setColor(A.page, C.hillFront);
    await setSize(A.page, 62);
    await stroke(A.page, ART.hillFront, { stepMs: 46, after: 600 });

    // B 是一台「手机」：竖屏 + 触屏模拟 —— 侧边滑条 / 抽屉面板都会出现
    const pctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      recordVideo: { dir: OUT, size: { width: 390, height: 844 } }
    });
    const ppage = await pctx.newPage();
    ppage.on('pageerror', e => console.log('  !! [phone] pageerror:', String(e).split('\n')[0]));
    await ppage.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
    await ppage.waitForFunction(() => window.ChaApp && window.ChaApp.state && window.ChaApp.state.joined, { timeout: 25000 });
    await sleep(1000);
    await ppage.evaluate(() => {
      const m = document.getElementById('entryMask');
      if (m) m.classList.add('hidden');
      if (window.ChaApp.state.room) window.ChaApp.zoomFit();
    });
    await sleep(900);

    // 手机上画太阳和云（左侧的 Procreate 式滑条全程可见）
    await setSize(ppage, 190);
    await setColor(ppage, C.sun);
    await stroke(ppage, ART.sun, { smooth: false, stepMs: 150, after: 500 });
    await pickBrush(ppage, 'airbrush');
    await setSize(ppage, 120);
    await setColor(ppage, C.cloud);
    await stroke(ppage, ART.cloud1, { stepMs: 70, after: 400 });
    await stroke(ppage, ART.cloud2, { stepMs: 70, after: 900 });
    await sleep(1200);

    await finishShot(A);
    const pv = ppage.video();
    await pctx.close();
    const psrc = await pv.path();
    const pdst = path.join(OUT, '06-phone-b.webm');
    fs.copyFileSync(psrc, pdst);
    try { fs.unlinkSync(psrc); } catch (e) { /* ignore */ }
    log('06-phone-b.webm', (fs.statSync(pdst).size / 1024 / 1024).toFixed(1) + 'MB');
  }

  await browser.close();
  console.log('\n拍摄完成，产物在', OUT);
})();
