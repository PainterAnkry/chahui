/**
 * 茶绘 · 浏览器端到端验证（驱动本机 Chrome）
 * 验证：页面无报错、建房、作画、另一端实时收到、图层/撤销/聊天/回放、导出图像非空
 * 用法: node tools/test-browser.js [http://localhost:8437]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function watch(page, tag, bag) {
  page.on('console', m => {
    if (m.type() === 'error') bag.push('[' + tag + ':console] ' + m.text());
  });
  page.on('pageerror', e => bag.push('[' + tag + ':pageerror] ' + e.message));
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.startsWith(BASE)) bag.push('[' + tag + ':requestfailed] ' + u + ' ' + (r.failure() || {}).errorText);
  });
}

/**
 * 自动确认应用内的「自定义」确认框（#confirmMask）。
 *
 * 注意：这里必须是自定义对话框，不是 window.confirm。
 * 渲染进程开着 contextIsolation，window.confirm 会被禁用，
 * 所以 app.js 用的是自己画的 #confirmMask；Playwright 的 page.on('dialog')
 * 只拦得住原生对话框，对 #confirmMask 完全无效 ——
 * 之前「图层清除」用例挂掉就是因为对话框弹出来后没人点「确定」。
 */
async function installAutoConfirm(page) {
  await page.addInitScript(() => {
    function arm() {
      const mask = document.querySelector('#confirmMask');
      const yes = document.querySelector('#confirmYes');
      if (!mask || !yes) return;
      new MutationObserver(() => {
        if (mask.classList.contains('hidden')) return;
        // 稍等一拍，让按钮文案/危险色先写好，避免点到上一轮的残留状态
        setTimeout(() => { if (!mask.classList.contains('hidden')) yes.click(); }, 40);
      }).observe(mask, { attributes: true, attributeFilter: ['class'] });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
    else arm();
  });
}

async function createRoom(page, name) {
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 8000 });
  await page.fill('#nameInput', name);
  await page.fill('#newRoomName', name + '的茶绘室');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => {
    const a = window.ChaApp;
    return a && a.state && a.state.joined && a.engine.layers.length > 0;
  }, { timeout: 10000 });
  return page.evaluate(() => window.ChaApp.state.room.id);
}

async function drawStroke(page, opts) {
  const box = await page.locator('#view').boundingBox();
  const o = opts || {};
  const x0 = box.x + (o.x0 != null ? o.x0 : 0.25) * box.width;
  const y0 = box.y + (o.y0 != null ? o.y0 : 0.35) * box.height;
  const x1 = box.x + (o.x1 != null ? o.x1 : 0.75) * box.width;
  const y1 = box.y + (o.y1 != null ? o.y1 : 0.65) * box.height;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 3) * 26;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  await sleep(220);
}

async function inkStats(page) {
  return page.evaluate(() => {
    var eng = window.ChaApp.engine;
    var d = eng.renderDocument({}).ctx.getImageData(0, 0, eng.width, eng.height).data;
    var ink = 0;
    for (var i = 0; i < d.length; i += 4 * 7) {
      if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) ink++;
    }
    return { ink: ink, strokes: eng.strokes.length, layers: eng.layers.length, seq: eng.seq };
  });
}

/** 当前活动图层右半部分的墨迹量（用来验证选区是否限制落笔） */
async function inkRightHalf(page) {
  return page.evaluate(() => {
    const eng = window.ChaApp.engine;
    const c = eng.renderLayerRaw(eng.activeLayerId);
    const x0 = Math.round(c.width * 0.58);
    const d = c.getContext('2d').getImageData(x0, 0, c.width - x0, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 5) if (d[i] > 8) n++;
    return n;
  });
}

async function gridOf(page) {
  // 在文档坐标系上取 320×200 采样网格，用于两端像素级一致性比对
  return page.evaluate(() => {
    const c = window.ChaApp.engine.renderDocument({}).canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height, gx = 320, gy = 200, out = [];
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        const i = (Math.floor(y * H / gy) * W + Math.floor(x * W / gx)) * 4;
        out.push(d[i], d[i + 1], d[i + 2]);
      }
    }
    return out;
  });
}

function gridDiff(a, b) {
  let diff = 0, maxd = 0, tot = 0;
  for (let i = 0; i < a.length; i += 3) {
    tot++;
    const dm = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (dm > 3) diff++;
    if (dm > maxd) maxd = dm;
  }
  return { pct: diff / tot * 100, maxd };
}

async function main() {
  console.log('茶绘浏览器端到端验证 @ ' + BASE + '\n');
  const errors = [];

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const ctxA = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const ctxB = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'A', errors);
  watch(B, 'B', errors);
  // 图层清除 / 合并 / 解散等操作会弹自定义确认框（#confirmMask），统一自动点「确定」
  await installAutoConfirm(A);
  await installAutoConfirm(B);

  console.log('[1] 打开页面');
  await A.goto(BASE, { waitUntil: 'load' });
  await sleep(900);
  ok('页面加载完成', await A.title() !== '');
  const stage0 = await A.evaluate(() => ({
    engine: typeof window.CanvasEngine,
    proto: typeof window.CHAPROTO,
    net: typeof window.Net,
    app: typeof window.ChaApp,
    tools: document.querySelectorAll('#toolGrid .tool, #brushGrid .tool').length,
    palette: document.querySelectorAll('#palette i').length
  }));
  ok('引擎 / 协议 / 网络层均已就绪', stage0.engine === 'function' && stage0.proto === 'object' && stage0.net === 'function' && stage0.app === 'object',
    JSON.stringify(stage0));
  ok('工具栏已渲染（SAI2 基本笔刷 + 附加工具）', stage0.tools >= 18, '实际 ' + stage0.tools);
  ok('调色板已生成', stage0.palette >= 40, '实际 ' + stage0.palette);
  await A.screenshot({ path: path.join(OUT, '01-入口界面.png') });

  console.log('\n[2] 连接服务器');
  await A.waitForFunction(() => window.ChaApp.net.status === 'online', { timeout: 8000 });
  ok('WebSocket 已连接', true);
  await sleep(400);

  console.log('\n[3] 创建房间');
  const roomId = await createRoom(A, '绘画小白');
  ok('房间创建成功', !!roomId, String(roomId));
  const meta = await A.evaluate(() => ({ members: document.querySelectorAll('#memberList .member').length, layers: document.querySelectorAll('#layerList .layer-item').length }));
  ok('成员面板已渲染', meta.members >= 1, JSON.stringify(meta));
  ok('图层面板已渲染', meta.layers >= 1, JSON.stringify(meta));
  await A.screenshot({ path: path.join(OUT, '02-建房后空画布.png') });

  console.log('\n[4] 本机作画');
  await A.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await A.fill('#hexInput', '#ec4141');
  await A.dispatchEvent('#hexInput', 'change');
  await A.fill('#sizeRange', '18');
  await A.dispatchEvent('#sizeRange', 'input');
  await drawStroke(A, {});
  const s1 = await inkStats(A);
  ok('画笔产生了笔迹', s1.strokes >= 1, JSON.stringify(s1));
  ok('画布上确实有墨迹像素', s1.ink > 200, 'ink=' + s1.ink);

  console.log('\n[5] 第二种工具 + 新图层');
  await A.click('#btnAddLayer');
  await sleep(400);
  const layerCount = await A.evaluate(() => window.ChaApp.engine.layers.length);
  ok('新建图层成功', layerCount === 2, '实际 ' + layerCount);
  await A.click('#toolGrid .tool[data-item="blur"], #brushGrid .tool[data-item="blur"]');
  await sleep(200);
  const blurOnly = await A.evaluate(() => ({
    tool: window.ChaApp.state.tool,
    item: window.ChaApp.state.brushId,
    strength: !document.querySelector('#strengthRange').closest('.row-line').classList.contains('hidden')
  }));
  ok('切到模糊工具（SAI2 新工具）', blurOnly.tool === 'blur', JSON.stringify(blurOnly));
  ok('模糊工具显示专属「强度」参数', blurOnly.strength === true);
  await A.fill('#sizeRange', '40');
  await A.dispatchEvent('#sizeRange', 'input');
  await drawStroke(A, { x0: 0.3, y0: 0.6, x1: 0.7, y1: 0.3 });
  const s2 = await inkStats(A);
  ok('模糊笔迹也被记录', s2.strokes >= 2, JSON.stringify(s2));

  console.log('\n[6] 另一端实时同步');
  await B.goto(BASE + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'load' });
  await B.waitForFunction(() => window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(1200);
  const sb = await inkStats(B);
  ok('B 已加入同一房间', sb.layers === 2, '层数 ' + sb.layers);
  ok('B 完整收到 A 的笔迹', sb.strokes === s2.strokes, 'A=' + s2.strokes + ' B=' + sb.strokes);
  ok('B 的画布上也有墨迹', sb.ink > 200, 'ink=' + sb.ink);
  ok('B 端画面确有内容', sb.ink > 200, 'ink=' + sb.ink);
  const gd = gridDiff(await gridOf(A), await gridOf(B));
  ok('两端像素级一致（采样网格差异 < 2%）', gd.pct < 2, gd.pct.toFixed(2) + '% maxΔ=' + gd.maxd);
  await A.screenshot({ path: path.join(OUT, '03-A端作画后.png') });
  await B.screenshot({ path: path.join(OUT, '04-B端同步画面.png') });

  console.log('\n[7] B 作画，A 实时看到');
  await B.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await B.fill('#sizeRange', '12');
  await B.dispatchEvent('#sizeRange', 'input');
  await drawStroke(B, { x0: 0.2, y0: 0.7, x1: 0.8, y1: 0.8 });
  await sleep(600);
  const s3 = await inkStats(A);
  ok('A 实时收到 B 的笔迹', s3.strokes === s2.strokes + 1, 'A=' + s3.strokes + ' 期望 ' + (s2.strokes + 1));
  ok('A 画布墨迹增加', s3.ink > s2.ink, s2.ink + ' → ' + s3.ink);

  console.log('\n[8] 聊天');
  await A.fill('#chatInput', '大家好，这里是茶绘室！');
  await A.press('#chatInput', 'Enter');
  await sleep(500);
  const chatB = await B.evaluate(() => document.querySelectorAll('#chatList .msg .text').length);
  const chatTextB = await B.evaluate(() => Array.from(document.querySelectorAll('#chatList .msg .text')).map(e => e.textContent).join('|'));
  ok('B 收到聊天消息', chatTextB.indexOf('这里是茶绘室') >= 0, '消息数 ' + chatB);

  console.log('\n[9] 成员列表');
  const memA = await A.evaluate(() => window.ChaApp.state.members.length);
  ok('双方各看到 2 名成员', memA === 2, '实际 ' + memA);
  const ownerBadge = await A.evaluate(() => document.querySelectorAll('#memberList .badge').length);
  ok('房主/我 标记已显示', ownerBadge >= 2, 'badge=' + ownerBadge);

  console.log('\n[10] 撤销 / 重做');
  await A.click('.tab[data-tab="history"]');
  await sleep(300);
  const before = (await inkStats(A)).strokes;
  await A.click('#btnUndo');
  await sleep(500);
  const afterUndo = (await inkStats(A)).strokes;
  ok('A 撤销掉自己的一笔', afterUndo === before - 1, before + ' → ' + afterUndo);
  await A.click('#btnRedo');
  await sleep(500);
  const afterRedo = (await inkStats(A)).strokes;
  ok('A 重做恢复', afterRedo === before, afterRedo + ' vs ' + before);
  await sleep(400);
  const bAfterRedo = (await inkStats(B)).strokes;
  ok('撤销/重做已同步到 B', bAfterRedo === before, 'B=' + bAfterRedo + ' 期望 ' + before);

  console.log('\n[11] 图层可见性同步');
  await B.evaluate(() => {
    const btn = document.querySelectorAll('#layerList .layer-item .eye')[0];
    btn.click();
  });
  await sleep(500);
  const visA = await A.evaluate(() => window.ChaApp.engine.layers.map(l => l.visible).join(','));
  ok('图层隐藏同步到 A', visA.indexOf('false') >= 0, 'A 端可见性: ' + visA);
  await B.evaluate(() => { document.querySelectorAll('#layerList .layer-item .eye')[0].click(); });
  await sleep(400);

  console.log('\n[12] 视图缩放 / 适应');
  await A.click('#btnZoomIn');
  await sleep(200);
  const z = await A.evaluate(() => Math.round(window.ChaApp.engine.scale * 100));
  ok('放大生效', z > 0, z + '%');
  await A.click('#btnZoomFit');
  await sleep(200);
  ok('适应窗口生效', true);

  console.log('\n[13] 导出 PNG');
  const png = await A.evaluate(() => window.ChaApp.engine.exportPNG());
  ok('导出为合法 PNG dataURL', typeof png === 'string' && png.indexOf('data:image/png;base64,') === 0 && png.length > 20000,
    '长度 ' + (png ? png.length : 0));

  console.log('\n[14] 笔迹回放');
  await A.click('#btnReplay');
  await sleep(900);
  const replayOn = await A.evaluate(() => ({
    on: window.ChaApp.engine.replayMode,
    bar: !document.querySelector('#replayBar').classList.contains('hidden'),
    n: window.ChaApp.engine.replayStrokes.length
  }));
  ok('进入回放模式', replayOn.on === true && replayOn.bar === true, JSON.stringify(replayOn));
  ok('回放包含全部笔迹', replayOn.n >= 3, 'n=' + replayOn.n);
  await A.screenshot({ path: path.join(OUT, '05-作画回放.png') });
  await A.click('#btnReplayExit');
  await sleep(400);
  ok('退出回放', (await A.evaluate(() => window.ChaApp.engine.replayMode)) === false);

  console.log('\n[15] 固化底图（房主）');
  await A.click('#btnBake');
  await sleep(1400);
  const baked = await A.evaluate(() => ({
    strokes: window.ChaApp.engine.strokes.length,
    hasBase: window.ChaApp.engine.layers.some(l => !!l.baseImage)
  }));
  ok('已生成底图', baked.hasBase === true, JSON.stringify(baked));
  ok('历史笔迹被裁剪', baked.strokes === 0, JSON.stringify(baked));
  const inkAfterBake = await A.evaluate(() => {
    var eng = window.ChaApp.engine;
    var d = eng.renderDocument({}).ctx.getImageData(0, 0, eng.width, eng.height).data;
    var ink = 0;
    for (var i = 0; i < d.length; i += 4 * 7) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) ink++;
    return ink;
  });
  ok('固化后画面内容仍在', inkAfterBake > 200, 'ink=' + inkAfterBake);

  const C = await ctxB.newPage();
  watch(C, 'C', errors);
  await C.goto(BASE + '/?room=' + encodeURIComponent(roomId), { waitUntil: 'load' });
  await C.waitForFunction(() => window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(1500);
  const sc = await inkStats(C);
  ok('新客户端从底图还原画面', sc.ink > 200, 'ink=' + sc.ink + ' strokes=' + sc.strokes);
  ok('新客户端笔迹数为 0（已在底图中）', sc.strokes === 0, '实际 ' + sc.strokes);

  console.log('\n[15.5] 房间信息面板');
  await A.click('#roomChip');
  await sleep(500);
  const info = await A.evaluate(() => ({
    open: !document.querySelector('#infoMask').classList.contains('hidden'),
    buttons: Array.prototype.map.call(document.querySelectorAll('#infoBody .info-actions .btn'), function (b) { return b.textContent; }),
    share: (document.querySelector('#shareLinkText') || {}).textContent || ''
  }));
  ok('房间信息弹窗打开', info.open === true);
  ok('四个操作按钮齐全', info.buttons.length === 4, JSON.stringify(info.buttons));
  ok('分享链接可用', /room=/.test(info.share), info.share);
  await A.screenshot({ path: path.join(OUT, '07-房间信息.png') });
  await A.click('#btnInfoClose');
  await sleep(250);

  console.log('\n[16] 断线重连');
  await B.evaluate(() => window.ChaApp.net.ws.close());
  await sleep(1600);
  const st = await B.evaluate(() => window.ChaApp.net.status);
  ok('断线后进入重连流程', st === 'offline' || st === 'connecting' || st === 'online', '状态 ' + st);
  await B.waitForFunction(() => window.ChaApp.net.status === 'online', { timeout: 20000 }).catch(() => {});
  ok('重连成功', (await B.evaluate(() => window.ChaApp.net.status)) === 'online');
  await sleep(2000);
  const rejoin = await B.evaluate(() => ({ joins: window.ChaApp.state.joinCount, joined: window.ChaApp.state.joined, strokes: window.ChaApp.engine.strokes.length }));
  ok('重连后自动重新加入房间（服务端确认过一次 room:joined）', rejoin.joins >= 2, JSON.stringify(rejoin));
  const beforeRe = (await inkStats(A)).strokes;
  await B.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await drawStroke(B, { x0: 0.15, y0: 0.22, x1: 0.45, y1: 0.18 });
  await sleep(900);
  const bSelf = await inkStats(B);
  const afterRe = (await inkStats(A)).strokes;
  ok('重连后 B 仍能作画', bSelf.strokes === rejoin.strokes + 1, 'B=' + bSelf.strokes + ' 期望 ' + (rejoin.strokes + 1));
  ok('重连后新笔迹仍能同步到 A', afterRe === beforeRe + 1, beforeRe + ' → ' + afterRe);

  await A.screenshot({ path: path.join(OUT, '06-最终界面.png') });

  /* ================= v2：SAI2 风格笔刷 / 视图 / 图层能力 ================= */

  const selectTop = async (page) => {
    await page.evaluate(() => { document.querySelectorAll('#layerList .layer-item')[0].click(); });
    await sleep(220);
    return page.evaluate(() => window.ChaApp.engine.activeLayerId);
  };
  const selectLayer = async (page, id) => {
    await page.evaluate((lid) => {
      const r = document.querySelector('#layerList .layer-item[data-id="' + lid + '"]');
      if (r) r.click();
    }, id);
    await sleep(220);
  };

  console.log('\n[16.5] v3 · SAI2 基本笔刷工具栏');
  const grid0 = await A.evaluate(() => {
    const btns = Array.prototype.slice.call(document.querySelectorAll('#toolGrid .tool, #brushGrid .tool'));
    return {
      n: btns.length,
      ids: btns.map(b => b.dataset.item),
      names: btns.map(b => (b.querySelector('span') || {}).textContent),
      withIcon: btns.filter(b => !!b.querySelector('svg')).length,
      family: (document.querySelector('#brushFamily') || {}).textContent
    };
  });
  const SAI2_BASIC = ['pencil', 'airbrush', 'brush', 'watercolor', 'marker', 'eraser',
    'select', 'selectErase', 'bucket', 'gradient', 'blur', 'effect', 'scatter', 'smudge'];
  const missingBasic = SAI2_BASIC.filter(id => grid0.ids.indexOf(id) < 0);
  ok('工具栏已换成 SAI2 十四个基本笔刷', missingBasic.length === 0, '缺少 ' + missingBasic.join(',') + ' / 实际 ' + grid0.ids.join(','));
  ok('每个工具都有图标', grid0.withIcon === grid0.n, grid0.withIcon + '/' + grid0.n);
  ok('工具栏为四列九宫格布局', grid0.n >= 14, '共 ' + grid0.n + ' 项');

  await A.click('#toolGrid .tool[data-item="pencil"], #brushGrid .tool[data-item="pencil"]');
  await sleep(250);
  // 家族标签在切换工具后才会刷新，必须重新读取
  const famAfter = await A.evaluate(() => ({
    family: (document.querySelector('#brushFamily') || {}).textContent,
    tool: window.ChaApp.state.tool,
    item: window.ChaApp.state.brushId
  }));
  ok('工具栏显示当前家族', /画笔/.test(famAfter.family || '') && famAfter.item === 'pencil',
    JSON.stringify(famAfter));

  console.log('\n[16.5.1] v3 · 特殊效果面板（纸张质感 / 特效）');
  const fx0 = await A.evaluate(() => ({
    papers: Array.from(document.querySelectorAll('#paperSelect option')).map(o => o.value),
    fx: Array.from(document.querySelectorAll('#fxSelect option')).map(o => o.value)
  }));
  ok('纸张质感可选（无质感/细纹/粗纹/画布）', fx0.papers.join(',') === 'none,fine,coarse,canvas', fx0.papers.join(','));
  ok('特殊效果可选（无/水滴/噪点/散布）', fx0.fx.join(',') === 'none,waterdrop,noise,scatter', fx0.fx.join(','));

  await A.selectOption('#paperSelect', 'coarse');
  await sleep(300);
  const paper = await A.evaluate(() => ({
    paper: window.ChaApp.state.brush.paper,
    grain: window.ChaApp.state.brush.grain,
    scale: window.ChaApp.state.brush.grainScale
  }));
  ok('选择纸张质感会写入笔刷参数', paper.paper === 'coarse' && paper.grain > 0, JSON.stringify(paper));

  await A.click('#toolGrid .tool[data-item="watercolor"], #brushGrid .tool[data-item="watercolor"]');
  await sleep(350);
  const wc = await A.evaluate(() => ({
    id: window.ChaApp.state.brushId,
    edge: window.ChaApp.state.brush.edge,
    fx: window.ChaApp.state.brush.fx,
    fxWidth: +document.querySelector('#fxWidth').value
  }));
  ok('水彩笔带水彩边缘与水滴特效', wc.id === 'watercolor' && wc.edge > 0 && wc.fx === 'waterdrop', JSON.stringify(wc));
  ok('特殊效果「宽度」滑块反映边缘值', wc.fxWidth > 0, 'fxWidth=' + wc.fxWidth);

  console.log('\n[16.5.2] v3 · 圆形画笔光标（直径 = 笔刷大小）');
  await A.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await sleep(200);
  await A.fill('#sizeRange', '60');
  await A.dispatchEvent('#sizeRange', 'input');
  await sleep(200);
  const vbox = await A.locator('#view').boundingBox();
  await A.mouse.move(vbox.x + vbox.width * 0.5, vbox.y + vbox.height * 0.5);
  await sleep(250);
  const cursor = await A.evaluate(() => {
    const el = document.querySelector('#brushCursor');
    const r = el.getBoundingClientRect();
    const eng = window.ChaApp.engine;
    return {
      hidden: el.classList.contains('hidden'),
      w: Math.round(r.width),
      expect: Math.round(60 * eng.scale),
      radius: getComputedStyle(el).borderRadius,
      size: window.ChaApp.state.brush.size
    };
  });
  ok('画笔光标可见（不再是十字）', cursor.hidden === false);
  ok('光标为圆形', /50%|9999px/.test(cursor.radius), cursor.radius);
  ok('光标直径对应笔刷大小', Math.abs(cursor.w - cursor.expect) <= 2, 'w=' + cursor.w + ' 期望≈' + cursor.expect);

  console.log('\n[16.5.3] v3 · 工具栏可自定义（排序 / 显隐 / 复位）');
  await A.click('#btnToolEdit');
  await sleep(250);
  const editing = await A.evaluate(() => ({
    toolCls: document.querySelector('#toolGrid').classList.contains('editing'),
    brushCls: document.querySelector('#brushGrid').classList.contains('editing'),
    badges: document.querySelectorAll('#toolGrid .tbadge, #brushGrid .tbadge').length
  }));
  ok('进入编辑模式（工具栏与笔刷栏一起）',
    editing.toolCls === true && editing.brushCls === true && editing.badges > 0, JSON.stringify(editing));
  const beforeHide = await A.evaluate(() => document.querySelectorAll('#toolGrid .tool, #brushGrid .tool').length);
  // scatter 是笔刷，现在住在笔刷栏里
  await A.evaluate(() => {
    const b = document.querySelector('#brushGrid .tool[data-item="scatter"] .tbadge button[data-act="hide"]');
    if (b) b.click();
  });
  await sleep(250);
  const afterHide = await A.evaluate(() => ({
    n: document.querySelectorAll('#toolGrid .tool, #brushGrid .tool').length,
    pool: document.querySelectorAll('#toolHiddenPool .tb-item').length
  }));
  ok('可以把笔刷从笔刷栏收起', afterHide.n === beforeHide - 1 && afterHide.pool === 1, JSON.stringify(afterHide));
  // 记录点「▶」之前的前两项，断言它们确实换了位置（不写死具体是哪个笔刷，
  // 否则以后往工具栏里加一支笔就会误报）
  const pair0 = await A.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#toolGrid .tool, #brushGrid .tool'), b => b.dataset.item).slice(0, 2));
  await A.evaluate((first) => {
    // 注意：两栏分开之后，后代选择器要**两边都写全**。
    // 写成 `A, B .child` 是选择器列表，第一项只匹配到工具按钮本身，点了个寂寞。
    const sel = '#toolGrid .tool[data-item="' + first + '"] .tbadge button[data-act="right"],' +
      '#brushGrid .tool[data-item="' + first + '"] .tbadge button[data-act="right"]';
    const b = document.querySelector(sel);
    if (b) b.click();
  }, pair0[0]);
  await sleep(200);
  const order1 = await A.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#toolGrid .tool, #brushGrid .tool'), b => b.dataset.item).slice(0, 2));
  ok('可以调整工具顺序', order1[0] === pair0[1] && order1[1] === pair0[0], pair0.join(',') + ' → ' + order1.join(','));
  await A.click('#btnToolReset');
  await sleep(250);
  const restored = await A.evaluate(() => ({
    n: document.querySelectorAll('#toolGrid .tool, #brushGrid .tool').length,
    firstTool: (document.querySelector('#toolGrid .tool') || {}).dataset.item,
    firstBrush: (document.querySelector('#brushGrid .tool') || {}).dataset.item
  }));
  ok('恢复默认工具栏', restored.n === grid0.n && restored.firstBrush === 'pencil',
    JSON.stringify(restored));
  await A.click('#btnToolEdit');
  await sleep(200);

  console.log('\n[16.6] v3 · 对称尺、渐变与视图工具');
  await A.click('#toolGrid .tool[data-item="watercolor"], #brushGrid .tool[data-item="watercolor"]');
  await sleep(250);
  await A.selectOption('#symSelect', 'xy');
  await sleep(250);
  await drawStroke(A, { x0: 0.42, y0: 0.42, x1: 0.58, y1: 0.5 });
  await sleep(800);
  const symStroke = await A.evaluate(() => {
    const eng = window.ChaApp.engine;
    const s = eng.strokes[eng.strokes.length - 1];
    return s ? { sym: s.sym, edge: s.edge, brush: s.brush } : null;
  });
  ok('对称尺随笔迹落库（sym=xy）', !!symStroke && symStroke.sym === 'xy', JSON.stringify(symStroke));
  ok('水彩边缘参数随笔迹落库', !!symStroke && symStroke.edge > 0, JSON.stringify(symStroke));
  const symInk = await inkStats(A);
  ok('四向对称使墨迹量翻倍显示', symInk.ink > 200, 'ink=' + symInk.ink);
  await A.selectOption('#symSelect', 'none');
  await sleep(200);

  const gradBefore = await A.evaluate(() => ({
    strokes: window.ChaApp.engine.strokes.length,
    // 与渐变后使用同一亮度口径，避免「不透明白底」把 alpha 计数撑满导致不可比
    ink: (() => {
      const c = window.ChaApp.engine.renderDocument({}).canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 29) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
      return n;
    })()
  }));
  await A.click('#toolGrid .tool[data-item="gradient"], #brushGrid .tool[data-item="gradient"]');
  await sleep(250);
  await drawStroke(A, { x0: 0.2, y0: 0.78, x1: 0.8, y1: 0.78 });
  await sleep(700);
  const grad = await A.evaluate(() => {
    const eng = window.ChaApp.engine;
    const s = eng.strokes[eng.strokes.length - 1];
    const c = eng.renderDocument({}).canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 29) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
    return { tool: s && s.tool, ink: n, pts: s ? s.points.length : 0 };
  });
  ok('渐变工具落库为 gradient', grad.tool === 'gradient' && grad.pts === 2, JSON.stringify(grad));
  ok('渐变在画布上产生了像素', grad.ink > gradBefore.ink, gradBefore.ink + ' → ' + grad.ink);

  await A.click('#btnRotateCW');
  await sleep(300);
  const rot = await A.evaluate(() => ({ rot: window.ChaApp.engine.rot, label: document.querySelector('#angleRangeVal').textContent }));
  ok('顺时针旋转视图 15°', Math.abs(rot.rot - Math.PI / 12) < 1e-3, JSON.stringify(rot));
  ok('旋转角度已显示在左侧导航器', /15/.test(rot.label), rot.label);
  await A.click('#btnFlipView');
  await sleep(250);
  ok('水平翻转视图生效', (await A.evaluate(() => window.ChaApp.engine.flipX)) === true);
  await A.click('#btnGrid');
  await sleep(250);
  ok('网格开关生效', (await A.evaluate(() => window.ChaApp.engine.grid.on)) === true);
  await A.click('#btnGrid');
  await sleep(150);
  await A.click('#btnResetView');
  await sleep(300);
  const reset = await A.evaluate(() => ({ rot: window.ChaApp.engine.rot, flip: window.ChaApp.engine.flipX, scale: window.ChaApp.engine.scale }));
  ok('复位视图（旋转 / 翻转归零）', Math.abs(reset.rot) < 1e-6 && reset.flip === false, JSON.stringify(reset));
  await A.fill('#zoomRange', '150');
  await A.dispatchEvent('#zoomRange', 'input');
  await sleep(300);
  ok('左侧「缩放比例」滑块可改变视图', Math.abs((await A.evaluate(() => window.ChaApp.engine.scale)) - 1.5) < 0.02);
  await A.click('#btnZoomFit');
  await sleep(300);

  console.log('\n[16.7] v3 · 导航器（左栏）与 HSV 色轮');
  const nav = await A.evaluate(() => {
    const c = document.querySelector('#navCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4 * 17) if (d[i] > 0) painted++;
    const rect = document.querySelector('#navRect');
    return { painted, rectW: Math.round(rect.getBoundingClientRect().width), inPanel: !!document.querySelector('.panel.left #navCanvas') };
  });
  ok('导航器位于左侧面板内', nav.inPanel === true);
  await sleep(400);
  const nav2 = await A.evaluate(() => {
    const c = document.querySelector('#navCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4 * 17) if (d[i] > 0) painted++;
    return painted;
  });
  ok('导航器已绘制整幅缩略图', nav2 > 50, 'alpha 采样=' + nav2);
  // 取景框只在「视口小于整幅画」时才有意义：整幅画都看得见时画一个占满缩略图的大方块
  // 只会让人以为是来路不明的框（用户反馈过），所以那时故意不画。
  const navFit = await A.evaluate(() => ({
    display: getComputedStyle(document.querySelector('#navRect')).display,
    scale: window.ChaApp.engine.scale
  }));
  ok('整幅画可见时不画取景框', navFit.display === 'none', JSON.stringify(navFit));
  await A.evaluate(() => window.ChaApp.engine.setZoom(4));
  await sleep(400);
  const navZoom = await A.evaluate(() => {
    const r = document.querySelector('#navRect').getBoundingClientRect();
    const c = document.querySelector('#navCanvas').getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      inside: r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1
    };
  });
  ok('放大后取景框出现且不越出缩略图', navZoom.w > 0 && navZoom.inside, JSON.stringify(navZoom));
  await A.evaluate(() => window.ChaApp.engine.fitView());
  await sleep(300);

  const wheel = await A.evaluate(() => {
    const c = document.querySelector('#colorWheel');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 0) painted++;
    return { painted, size: c.width };
  });
  ok('HSV 色轮已绘制（环 + 三角）', wheel.painted > 300, JSON.stringify(wheel));
  let wheelChanged = false;
  for (const [fx, fy] of [[0.5, 0.34], [0.5, 0.6], [0.5, 0.2]]) {
    await A.locator('#colorWheel').scrollIntoViewIfNeeded();
    await sleep(200);
    const c0 = await A.evaluate(() => window.ChaApp.state.color);
    const wb = await A.locator('#colorWheel').boundingBox();
    await A.mouse.click(wb.x + wb.width * fx, wb.y + wb.height * fy);
    await sleep(250);
    const c1 = await A.evaluate(() => window.ChaApp.state.color);
    if (c0 !== c1) { wheelChanged = true; break; }
  }
  ok('点击色轮可改变前景色', wheelChanged === true);

  console.log('\n[16.8] v2 · 图层混合 / 保护不透明度 / 复制 / 清除 / 合并');
  const srcId = await selectTop(A);
  await A.selectOption('#layerBlend', 'multiply');
  await sleep(600);
  const idx0 = await A.evaluate(() => window.ChaApp.engine.layers.findIndex(l => l.id === window.ChaApp.engine.activeLayerId));
  const blendB = await B.evaluate((i) => (window.ChaApp.engine.layers[i] || {}).blend, idx0);
  ok('图层混合模式同步到另一端', blendB === 'multiply', 'B 端=' + blendB);

  await A.check('#alphaLockChk');
  await sleep(600);
  const lockB = await B.evaluate((i) => (window.ChaApp.engine.layers[i] || {}).alphaLock, idx0);
  ok('保护不透明度同步到另一端', lockB === true, 'B 端=' + lockB);
  await A.uncheck('#alphaLockChk');
  await sleep(400);

  const n0 = await A.evaluate(() => window.ChaApp.engine.layers.length);
  await A.click('#btnLayerDup');
  await sleep(1000);
  const n1 = await A.evaluate(() => window.ChaApp.engine.layers.length);
  const n1b = await B.evaluate(() => window.ChaApp.engine.layers.length);
  ok('复制图层：A 端 +1 层', n1 === n0 + 1, n0 + ' → ' + n1);
  ok('复制图层：B 端同步', n1b === n1, 'B=' + n1b);
  const dupId = await selectTop(A);
  ok('复制出的图层成为顶部层', !!dupId && dupId !== srcId, 'dup=' + dupId);

  const dupInk = await A.evaluate((id) => {
    const eng = window.ChaApp.engine;
    const l = eng.getLayer(id);
    if (!l) return -1;
    const c = eng.renderLayerRaw(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 13) if (d[i + 3] > 8) ink++;
    return ink;
  }, dupId);
  ok('复制层包含原层像素', dupInk > 0, 'dup ink=' + dupInk);

  await A.click('#btnLayerClear');
  await sleep(1000);
  const cleared = await B.evaluate((i) => {
    const l = window.ChaApp.engine.layers[i];
    return l ? { baseSeq: l.baseSeq } : null;
  }, idx0 + 1);
  ok('清除图层：另一端底图被丢弃（baseSeq 归零）', !!cleared && cleared.baseSeq === 0, JSON.stringify(cleared));

  await selectLayer(A, srcId);
  const m0 = await A.evaluate(() => window.ChaApp.engine.layers.length);
  await A.click('#btnLayerMerge');
  await sleep(1200);
  const m1 = await A.evaluate(() => window.ChaApp.engine.layers.length);
  const m1b = await B.evaluate(() => window.ChaApp.engine.layers.length);
  ok('向下合并：图层数 -1', m1 === m0 - 1, m0 + ' → ' + m1);
  ok('向下合并：B 端同步', m1b === m1, 'B=' + m1b);

  await A.click('#btnLayerFlatten');
  await sleep(1400);
  const flat = await A.evaluate(() => ({
    layers: window.ChaApp.engine.layers.length,
    strokes: window.ChaApp.engine.strokes.length,
    hasBase: window.ChaApp.engine.layers.some(l => !!l.baseImage)
  }));
  const flatB = await B.evaluate(() => window.ChaApp.engine.layers.length);
  ok('合并可见图层后仅剩 1 层', flat.layers === 1, JSON.stringify(flat));
  ok('合并可见图层：B 端同步', flatB === 1, 'B=' + flatB);
  ok('扁平化结果固化为底图', flat.hasBase === true, JSON.stringify(flat));
  await A.screenshot({ path: path.join(OUT, '08-SAI2功能面板.png') });

  console.log('\n[16.9] v3 · 表情包（内置 + 自行添加）');
  await A.evaluate(() => document.querySelector('#btnSticker').click());
  await sleep(350);
  const sp = await A.evaluate(() => ({
    open: !document.querySelector('#stickerPanel').classList.contains('hidden'),
    builtin: document.querySelectorAll('#stickerBuiltin .st').length
  }));
  ok('表情面板可打开', sp.open === true);
  ok('内置表情已渲染', sp.builtin >= 32, '内置 ' + sp.builtin + ' 个');

  const chatN0 = await B.evaluate(() => document.querySelectorAll('#chatList .msg').length);
  await A.evaluate(() => { document.querySelector('#stickerBuiltin .st').click(); });
  await sleep(800);
  const chatN1 = await B.evaluate(() => document.querySelectorAll('#chatList .msg').length);
  const emojiText = await B.evaluate(() => {
    const els = document.querySelectorAll('#chatList .msg .text');
    return els.length ? els[els.length - 1].textContent : '';
  });
  ok('内置表情可发送到另一端', chatN1 === chatN0 + 1 && emojiText.length > 0,
    JSON.stringify({ chatN0: chatN0, chatN1: chatN1, emojiText: emojiText }));

  const pngData = await A.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const x = c.getContext('2d');
    x.fillStyle = '#f2994a'; x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#ffffff'; x.fillRect(9, 9, 14, 14);
    return c.toDataURL('image/png');
  });
  await A.setInputFiles('#stickerFile', {
    name: 'custom.png', mimeType: 'image/png', buffer: Buffer.from(pngData.split(',')[1], 'base64')
  });
  await sleep(800);
  const mine = await A.evaluate(() => ({
    n: document.querySelectorAll('#stickerMine .st').length,
    stored: (window.ChaApp.state.stickers || []).length
  }));
  ok('可自行添加表情图片', mine.n === 1 && mine.stored === 1, JSON.stringify(mine));

  const imgN0 = await B.evaluate(() => document.querySelectorAll('#chatList .msg img.stick').length);
  await A.evaluate(() => { document.querySelector('#stickerMine .st').click(); });
  await sleep(1000);
  const imgN1 = await B.evaluate(() => document.querySelectorAll('#chatList .msg img.stick').length);
  const imgInfo = await B.evaluate(() => {
    const im = document.querySelectorAll('#chatList .msg img.stick');
    const last = im[im.length - 1];
    return last ? { src: last.getAttribute('src').slice(0, 22), w: last.naturalWidth } : null;
  });
  ok('自定义表情可发送到另一端', imgN1 === imgN0 + 1, imgN0 + ' → ' + imgN1);
  ok('表情图正确渲染为图片', !!imgInfo && imgInfo.src.indexOf('data:image/png') === 0 && imgInfo.w > 0, JSON.stringify(imgInfo));
  await A.evaluate(() => document.querySelector('#btnStickerClose').click());
  await sleep(250);
  const closed = await A.evaluate(() => document.querySelector('#stickerPanel').classList.contains('hidden'));
  ok('表情面板可收起', closed === true);

  console.log('\n[16.10] v3 · 选区工具（本地私有状态）');
  await A.click('#toolGrid .tool[data-item="select"], #brushGrid .tool[data-item="select"]');
  await sleep(250);
  const strokesBeforeSel = await A.evaluate(() => window.ChaApp.engine.strokes.length);
  await A.click('#btnSelAll');
  await sleep(500);
  const sel1 = await A.evaluate(() => ({
    active: window.ChaApp.engine.hasSelection(),
    hint: !document.querySelector('#selHint').classList.contains('hidden'),
    strokes: window.ChaApp.engine.strokes.length
  }));
  ok('全选后进入选区状态', sel1.active === true, JSON.stringify(sel1));
  ok('底部出现「有选区」提示', sel1.hint === true);
  ok('选区笔不写入笔迹历史', sel1.strokes === strokesBeforeSel, strokesBeforeSel + ' → ' + sel1.strokes);
  ok('选区状态不会同步到另一端', (await B.evaluate(() => window.ChaApp.engine.hasSelection())) === false);

  await A.click('#btnSelInvert');
  await sleep(400);
  ok('反选可用', (await A.evaluate(() => window.ChaApp.engine.hasSelection())) === true);
  await A.click('#btnSelNone');
  await sleep(350);
  ok('可以取消选区', (await A.evaluate(() => window.ChaApp.engine.hasSelection())) === false);

  // 只用左半边选区画一笔横跨整幅的线，右侧不应落墨
  await A.click('#toolGrid .tool[data-item="brush"], #brushGrid .tool[data-item="brush"]');
  await A.fill('#sizeRange', '30');
  await A.dispatchEvent('#sizeRange', 'input');
  await sleep(250);
  await A.evaluate(() => {
    const eng = window.ChaApp.engine;
    const s = eng.ensureSelection();
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.globalCompositeOperation = 'source-over';
    s.ctx.fillStyle = '#ffffff';
    s.ctx.fillRect(0, 0, eng.width / 2, eng.height);
    s.active = true;
    eng.refreshSelectionTint();
    eng.drawOverlay();
    eng.invalidate();
  });
  await sleep(400);
  const inkR0 = await inkRightHalf(A);
  await drawStroke(A, { x0: 0.15, y0: 0.92, x1: 0.85, y1: 0.92 });
  await sleep(900);
  const inkR1 = await inkRightHalf(A);
  ok('选区之外不会落笔', inkR1 - inkR0 <= 20, inkR0 + ' → ' + inkR1);
  await A.click('#btnSelNone');
  await sleep(300);

  console.log('\n[17] 运行期报错检查');
  ok('浏览器控制台无报错', errors.length === 0, errors.slice(0, 6).join(' || '));

  console.log('\n[18] 解散房间（同时清理本次测试数据）');
  await A.click('#roomChip');
  await sleep(500);
  await A.click('#btnInfoDestroy');
  await sleep(1200);
  const gone = await A.evaluate(() => ({ joined: window.ChaApp.state.joined, room: window.ChaApp.state.room }));
  ok('房主解散后回到未加入状态', gone.joined === false && gone.room === null, JSON.stringify(gone));
  await sleep(700);
  const roomsNow = await B.evaluate(async () => {
    const r = await fetch('/api/rooms');
    const j = await r.json();
    return j.rooms.map(function (x) { return x.id; });
  });
  ok('房间已从服务端移除', roomsNow.indexOf(roomId) < 0, JSON.stringify(roomsNow));

  await browser.close();

  console.log('\n════════════════════════════════════════');
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  if (errors.length) { console.log('  控制台报错：'); errors.slice(0, 10).forEach(e => console.log('   ! ' + e)); }
  console.log('  截图目录: ' + OUT);
  console.log('════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
