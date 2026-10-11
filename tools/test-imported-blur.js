/* 导入笔刷「黑色喷枪」修复回归 + 笔刷重命名
 * ① 硬度 0.05 的导入纹理笔刷：整笔不得再被 blurPxOf 糊掉（硬墨像素必须大量存活）
 * ② 内置圆头软笔（无 tip）不受影响，依旧按硬度模糊
 * ③ 右键菜单重命名导入笔刷（prompt 桩）→ 网格/顶栏/localStorage 三处同步
 * 用法：node tools/test-imported-blur.js [BASE]  （默认 http://127.0.0.1:8440）
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  // Node 侧解析用户的真实 ABR：取「笔刷 11」（1186px 源、硬度 0.05、有纹理）
  global.window = global;
  require('../client/renderer/brush-import.js');
  const abr = fs.readFileSync('C:/Users/Ankry/Desktop/未标题画笔.abr');
  const parsed = global.ChaBrushImport.parse('untitled.abr', abr);
  const b11 = parsed.brushes[10];

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.addInitScript(o => {
    try { if (!localStorage.getItem('chahu.brushes.imported')) localStorage.setItem('chahu.brushes.imported', JSON.stringify(o)); } catch (e) {}
  }, [{ id: 'imp_blur_t', name: '纹理笔', tool: 'brush', icon: 'imported', type: 'brush', imported: true,
       params: { brush: 'custom', size: 200, opacity: 1, hardness: 0.05, minSize: 0.4,
                 pressSize: 0, pressOpacity: 0, grain: 0, scatter: 0, spacing: 0.25, tip: b11.tip } }]);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'T');
  await page.fill('#newRoomName', 'imblur' + (Date.now() % 100000));
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));

  /* ---- ① 导入笔刷不再被整笔模糊 ---- */
  const tex = await page.evaluate((tip) => {
    const e = window.ChaApp.engine;
    const st = e.beginStroke({
      id: 'tex1', layerId: e.activeLayerId, tool: 'brush', brush: 'custom', color: '#111111',
      size: 200, opacity: 1, hardness: 0.05, minSize: 0.4, pressSize: 0, pressOpacity: 0,
      grain: 0, scatter: 0, spacing: 0.25, tip: tip, sym: 'none', seed: 42
    });
    e.addPoints(st.id, [[150, 400, 0.7], [560, 400, 0.7]]);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();
    const d = e.activeLayer().ctx.getImageData(0, 0, e.width, e.height).data;
    let ink = 0, hard = 0, maxA = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > 8) { ink++; if (a > 150) hard++; if (a > maxA) maxA = a; }
    }
    return { ink, hard, maxA };
  }, b11.tip);
  ok('纹理笔迹有墨（形状生效）', tex.ink > 8000, tex.ink + ' px');
  ok('硬墨像素大量存活（整笔 blur 已跳过）', tex.hard > 2500, tex.hard + ' px alpha>150');
  ok('墨色能到接近实心（maxA>200）', tex.maxA > 200, 'maxA=' + tex.maxA);

  /* ---- ② 内置圆头软笔依旧模糊（回归保护） ---- */
  const round = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const st = e.beginStroke({
      id: 'rnd1', layerId: e.activeLayerId, tool: 'brush', brush: 'pen', color: '#111111',
      size: 60, opacity: 1, hardness: 0.05, minSize: 0.4, pressSize: 0, pressOpacity: 0,
      grain: 0, scatter: 0, spacing: 0.1, sym: 'none', seed: 42
    });
    e.addPoints(st.id, [[900, 400, 0.7], [1200, 400, 0.7]]);
    e.endStroke(st.id, e.seq + 1);
    e.invalidate();
    // 中心行扫过去：软边笔中心 alpha 高、边缘过渡带宽
    const row = 400, d = e.activeLayer().ctx.getImageData(880, row - 1, 340, 3).data;
    let maxA = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
    return { maxA };
  }, );
  ok('内置软笔中心仍实（模糊管线没被误伤）', round.maxA > 120, 'maxA=' + round.maxA);

  /* ---- ③ 重命名 ---- */
  // 桩掉 prompt
  await page.evaluate(() => {
    window.prompt = function () { return '我的水纹笔'; };
  });
  // 右键导入笔刷格子 → 菜单出现「重命名」
  await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('#brushGrid .tool'));
    const cell = cells.find(c => c.textContent.indexOf('纹理笔') >= 0);
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  });
  await sleep(200);
  const menuSeen = await page.evaluate(() => {
    const m = document.querySelector('#itemCtxMenu');
    const rn = document.querySelector('#icmRename');
    return { open: m && !m.classList.contains('hidden'), renameShown: rn && !rn.classList.contains('hidden') };
  });
  ok('右键菜单出现重命名项', menuSeen.open && menuSeen.renameShown, JSON.stringify(menuSeen));
  await page.click('#icmRename');
  await sleep(200);
  const renamed = await page.evaluate(() => {
    const imp = JSON.parse(localStorage.getItem('chahu.brushes.imported') || '[]');
    const cells = Array.from(document.querySelectorAll('#brushGrid .tool'));
    const inGrid = cells.some(c => c.textContent.indexOf('我的水纹笔') >= 0);
    const label = document.querySelector('#brushNow').textContent;
    return { ls: imp[0] && imp[0].name, inGrid, label };
  });
  ok('localStorage 已改名', renamed.ls === '我的水纹笔', renamed.ls);
  ok('笔刷栏网格显示新名', renamed.inGrid);
  // 选中这支笔，顶栏标签应显示新名
  await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('#brushGrid .tool'));
    const cell = cells.find(c => c.textContent.indexOf('我的水纹笔') >= 0);
    cell.click();
  });
  await sleep(200);
  const label2 = await page.evaluate(() => document.querySelector('#brushNow').textContent);
  ok('选中后顶栏标签显示新名', label2.indexOf('我的水纹笔') >= 0, label2);

  // 刷新后还在（持久化）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(600);
  const persisted = await page.evaluate(() => {
    const imp = JSON.parse(localStorage.getItem('chahu.brushes.imported') || '[]');
    return imp[0] && imp[0].name;
  });
  ok('刷新后名字仍在', persisted === '我的水纹笔', persisted);

  ok('全程无 JS 报错', errs.length === 0, errs.join(';'));
  await browser.close();
  console.log('===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
