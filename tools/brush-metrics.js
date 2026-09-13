/**
 * 笔刷客观量测：用每支笔的**真实预设参数**画一笔，量边缘硬度 / 峰值浓度 / 是否连续。
 * 判断「像不像 SAI2」靠这些数字，而不是盯着缩略图看。
 * 用法: node tools/_brush-metrics.js
 */
'use strict';
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:8437/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '量测');
  await page.fill('#newRoomName', '笔刷量测房');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 10000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));

  const rows = await page.evaluate(() => {
    const e = window.ChaApp.engine;
    const out = [];
    const IDS = ['pencil', 'pencilSoft', 'airbrush', 'brush', 'watercolor', 'marker', 'eraser', 'effect', 'scatter'];

    function reset() {
      e.layers.forEach(function (l) {
        l.strokes = []; l.baseImage = null; l.baseSeq = 0;
        l.ctx.setTransform(1, 0, 0, 1, 0, 0);
        l.ctx.clearRect(0, 0, e.width, e.height);   // 必须真的把画布擦干净，否则上一支笔的墨会叠上来
      });
      e.strokes = []; e.byId = new Map(); e.baseDirty = true; e.baseKey = '';
      e.clearSelection();
      e.pending.clear();
    }

    IDS.forEach(function (id) {
      const item = window.ChaBrushes.get(id);
      if (!item) return;
      reset();
      const p = window.ChaBrushes.resolveParams(item, window.ChaApp.state.overrides);
      const size = 40;                        // 统一按 40px 比，才有的比
      const info = Object.assign({}, p, {
        id: 'm_' + id, layerId: e.activeLayerId, tool: 'brush', color: '#000000',
        size: size, brush: id, seed: 987654, points: [], pressSize: 0, pressOpacity: 0
      });
      const st = e.beginStroke(info);
      e.addPoints(st.id, [[400, 400, 0.5], [400, 600, 0.5], [400, 800, 0.5]]);
      e.endStroke(st.id, e.seq + 1);

      const l = e.activeLayer();
      // 横切剖面：在 y=600 处横向扫过笔身（笔心 x=400），量边缘硬度与峰值浓度
      const CW = 140, cx0 = 330;
      const cross = l.ctx.getImageData(cx0, 600, CW, 1).data;
      const col = [];
      for (let i = 0; i < CW; i++) col.push(cross[i * 4 + 3]);
      const peak = Math.max.apply(null, col);
      const hi = peak * 0.9, lo = peak * 0.1;
      let firstHi = -1, firstLo = -1, lastHi = -1;
      for (let i = 0; i < CW; i++) {
        if (col[i] >= lo && firstLo < 0) firstLo = i;
        if (col[i] >= hi) { if (firstHi < 0) firstHi = i; lastHi = i; }
      }
      // 沿线剖面：竖直扫过整笔，看有没有断口（散布笔会断）
      const LN = 400;
      const along = l.ctx.getImageData(400, 400, 1, LN).data;
      let on = 0, runs = 0, prev = false;
      for (let i = 0; i < LN; i++) {
        const v = along[i * 4 + 3] > 12;
        if (v) on++;
        if (v && !prev) runs++;
        prev = v;
      }
      out.push({
        id: id, peak: peak,
        edge: firstHi >= 0 ? firstHi - firstLo : -1,
        width: firstHi >= 0 ? lastHi - firstHi + 1 : 0,
        coverage: +(on / LN * 100).toFixed(1),
        runs: runs
      });
    });
    return out;
  });

  console.log('笔刷'.padEnd(12) + '峰值浓度  过渡带(px)  笔身宽(px)  沿线覆盖  断口数');
  rows.forEach(r => {
    console.log(
      r.id.padEnd(14) +
      String(r.peak).padStart(6) + '    ' +
      String(r.edge).padStart(8) + '   ' +
      String(r.width).padStart(8) + '   ' +
      String(r.coverage).padStart(7) + '%' +
      String(r.runs).padStart(7)
    );
  });
  console.log('\n参考（SAI2 手感）：');
  console.log('  铅笔      峰值应接近 255，过渡带 1-2px（硬边），覆盖率 100%');
  console.log('  喷枪      峰值应很低（<60），过渡带 ≥15px（极柔），覆盖率 100%');
  console.log('  画笔      过渡带 2-6px，峰值高');
  console.log('  水彩笔    过渡带 8-20px + 边缘更浓');
  console.log('  马克笔    过渡带 1-3px，峰值中等且不随压感变化');
  console.log('  散布      覆盖率明显低于 100%（是点不是线）');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
