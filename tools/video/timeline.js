/**
 * 给分镜「量时间轴」：每隔 0.5 秒看一帧，统计画布上的着墨比例，
 * 这样就能准确挑出「第几秒开始画 / 第几秒画完」，不用靠眼睛猜。
 *
 * 用法: node tools/video/timeline.js video/shots/02-duo-a.webm [0.5]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../pw');

const file = process.argv[2];
const step = parseFloat(process.argv[3] || '0.5');
if (!file) { console.error('用法: node tools/video/timeline.js <视频> [步长]'); process.exit(2); }
const abs = path.resolve(file);
const dir = path.dirname(abs);
const base = path.basename(abs);

(async () => {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (u === '/__blank__') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>t</title>'); return; }
    const f = path.join(dir, u.replace(/^\/+/, ''));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const total = fs.statSync(f).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const s = m[1] ? parseInt(m[1], 10) : 0;
      const e = m[2] ? parseInt(m[2], 10) : total - 1;
      res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': 'bytes ' + s + '-' + e + '/' + total, 'content-length': String(e - s + 1) });
      fs.createReadStream(f, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': String(total) });
      fs.createReadStream(f).pipe(res);
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  await page.goto('http://127.0.0.1:' + port + '/__blank__');
  await page.setContent('<body style="margin:0"><video id="v" muted playsinline></video></body>');

  const duration = await page.evaluate(async (src) => {
    const v = document.getElementById('v');
    v.src = src;
    await new Promise(res => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 10000); });
    return v.duration || 0;
  }, 'http://127.0.0.1:' + port + '/' + encodeURIComponent(base));

  const rows = [];
  for (let t = 0; t < duration; t += step) {
    const r = await page.evaluate(async (tt) => {
      const v = document.getElementById('v');
      await new Promise((res) => {
        const done = () => { v.removeEventListener('seeked', done); res(); };
        v.addEventListener('seeked', done);
        v.currentTime = tt;
        setTimeout(res, 2000);
      });
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const cx = c.getContext('2d');
      cx.drawImage(v, 0, 0);
      // 只看画布（文档）那一块
      const X = 310, Y = 187, WW = 1262, HH = 788;
      const d = cx.getImageData(X, Y, WW, HH).data;
      let ink = 0, n = 0, orange = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4 * 17) {
        n++;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx - mn > 26) ink++;
        if (R > 200 && G > 120 && G < 200 && B < 110) orange++;
        if (mx < 140) dark++;
      }
      return { ink: ink / n, orange: orange / n, dark: dark / n };
    }, t);
    rows.push({ t, ...r });
  }

  console.log('视频 ' + base + '  时长 ' + duration.toFixed(1) + 's');
  console.log('  t(s)   着墨%   橙色%   深色%');
  rows.forEach(r => {
    const bar = '█'.repeat(Math.round(r.ink * 200));
    console.log('  ' + r.t.toFixed(1).padStart(5) + '  ' + (r.ink * 100).toFixed(2).padStart(6) + '  ' +
      (r.orange * 100).toFixed(2).padStart(6) + '  ' + (r.dark * 100).toFixed(2).padStart(6) + '  ' + bar);
  });

  await browser.close();
  server.close();
})();
