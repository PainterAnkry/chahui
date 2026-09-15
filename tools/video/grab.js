/**
 * 从 webm / mp4 里按时间点抓帧存成 PNG —— 做视频时用来「看一眼到底长什么样」。
 *
 * 用法: node tools/video/grab.js <视频文件> <时间点秒,逗号分隔> [输出目录]
 * 例:   node tools/video/grab.js video/shots/02-duo-a.webm 1,5,9,14 video/frames
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../pw');

const file = process.argv[2];
const times = (process.argv[3] || '1').split(',').map(s => parseFloat(s.trim())).filter(n => isFinite(n));
if (!file) { console.error('用法: node tools/video/grab.js <视频文件> <时间点,逗号分隔> [输出目录]'); process.exit(2); }
const abs = path.resolve(file);
const dir = path.dirname(abs);
const base = path.basename(abs);
const OUT = process.argv[4] || path.resolve(__dirname, '..', '..', 'video', 'frames');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

(async () => {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__blank__') {
      // 用一个最小的 HTML 把页面挂在 http 源下，之后再用 setContent 铺内容
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>grab</title>');
      return;
    }
    const f = path.join(dir, u.replace(/^\/+/, ''));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const total = fs.statSync(f).size;
    const range = req.headers.range;
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(end - start + 1)
      });
      fs.createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(total) });
      fs.createReadStream(f).pipe(res);
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  // 页面得来自 http（data:/about:blank 里加载 http 视频会被 CORS 拦）
  await page.goto(`http://127.0.0.1:${port}/__blank__`);
  await page.setContent('<body style="margin:0;background:#000"><video id="v" muted playsinline></video></body>');

  const meta = await page.evaluate(async (src) => {
    const v = document.getElementById('v');
    v.src = src;
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('视频加载失败'));
      setTimeout(res, 8000);
    });
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  }, 'http://127.0.0.1:' + port + '/' + encodeURIComponent(base));
  console.log('视频:', base, JSON.stringify(meta));

  for (const t of times) {
    const dataUrl = await page.evaluate(async (tt) => {
      const v = document.getElementById('v');
      await new Promise((res) => {
        const done = () => { v.removeEventListener('seeked', done); res(); };
        v.addEventListener('seeked', done);
        v.currentTime = Math.min(tt, Math.max(0, (v.duration || tt) - 0.02));
        setTimeout(res, 2500);
      });
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 1920; c.height = v.videoHeight || 1080;
      const cx = c.getContext('2d');
      cx.drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }, t);
    const out = path.join(OUT, base.replace(/\.[^.]+$/, '') + '_' + String(t).replace('.', 'p') + 's.png');
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ✓', path.relative(process.cwd(), out));
  }

  await browser.close();
  server.close();
})();
