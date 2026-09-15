/**
 * 验一下成品：能播吗、多长、有没有声音轨、音量是不是真的不是静音。
 * 用法: node tools/video/verify.js "video/茶绘-介绍.mp4"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../pw');

const abs = path.resolve(process.argv[2] || 'video/茶绘-介绍.mp4');
const dir = path.dirname(abs), base = path.basename(abs);

(async () => {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (u === '/__blank__') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>v</title>'); return; }
    const f = path.join(dir, u.replace(/^\/+/, ''));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const total = fs.statSync(f).size;
    const type = path.extname(f).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/webm';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const s = m[1] ? parseInt(m[1], 10) : 0;
      const e = m[2] ? parseInt(m[2], 10) : total - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + s + '-' + e + '/' + total, 'content-length': String(e - s + 1) });
      fs.createReadStream(f, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(total) });
      fs.createReadStream(f).pipe(res);
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + port + '/__blank__');
  await page.setContent('<body style="margin:0"><video id="v" muted playsinline></video></body>');

  const info = await page.evaluate(async (src) => {
    const v = document.getElementById('v');
    v.src = src;
    await new Promise(res => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 15000); });
    // 播两秒，看音频有没有真的解码出数据
    let audioBytes = 0;
    try {
      await v.play();
      await new Promise(r => setTimeout(r, 2200));
      v.pause();
      audioBytes = v.webkitAudioDecodedByteCount || 0;
    } catch (e) { /* ignore */ }
    const tracks = (() => { try { return v.captureStream().getAudioTracks().length; } catch (e) { return -1; } })();
    return {
      duration: v.duration, w: v.videoWidth, h: v.videoHeight,
      audioBytes, tracks,
      error: v.error ? v.error.code + '/' + v.error.message : null,
      readyState: v.readyState
    };
  }, 'http://127.0.0.1:' + port + '/' + encodeURIComponent(base));

  // 再单独量一下整段音频的峰值，确认不是「有轨道但全程静音」
  const peak = await page.evaluate(async (src) => {
    try {
      const buf = await fetch(src).then(r => r.arrayBuffer());
      const ac = new OfflineAudioContext(1, 1024, 48000);
      const dec = await ac.decodeAudioData(buf.slice(0));
      let mx = 0, sum = 0, n = 0;
      for (let ch = 0; ch < dec.numberOfChannels; ch++) {
        const d = dec.getChannelData(ch);
        for (let i = 0; i < d.length; i += 61) { const a = Math.abs(d[i]); if (a > mx) mx = a; sum += a * a; n++; }
      }
      return { dur: dec.duration, ch: dec.numberOfChannels, peak: mx, rms: Math.sqrt(sum / n) };
    } catch (e) { return { err: String(e) }; }
  }, 'http://127.0.0.1:' + port + '/' + encodeURIComponent(base));

  console.log('文件   ', base, (fs.statSync(abs).size / 1024 / 1024).toFixed(1) + 'MB');
  console.log('视频   ', info.w + '×' + info.h, (info.duration || 0).toFixed(2) + 's', 'readyState=' + info.readyState, info.error ? ('错误=' + info.error) : '');
  console.log('音轨   ', '已解码字节 ' + info.audioBytes, ' captureStream 音轨数 ' + info.tracks);
  console.log('音频   ', JSON.stringify(peak));
  const okAll = !info.error && info.duration > 1 && info.w === 1920 && peak.peak > 0.01;
  console.log(okAll ? '\n通过：能播、有画面、有声音（不是静音）' : '\n有问题，看上面');
  await browser.close();
  server.close();
  process.exit(okAll ? 0 : 1);
})();
