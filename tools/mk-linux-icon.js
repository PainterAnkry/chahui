/**
 * 生成 Linux 版图标（512x512）。
 *
 * electron-builder 的 Linux 目标（AppImage / deb）要求图标至少 512x512，
 * 而 client/build/icon.png 一直是 256x256（Windows 用不到更大的）。
 * 图标是扁平设计（圆角方底 + 白色茶杯），2 倍高质量放大不会糊，
 * 所以拿浏览器 canvas 的 imageSmoothingQuality:'high' 放大一遍即可。
 *
 * 用法: node tools/mk-linux-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw');

const SRC = path.resolve(__dirname, '..', 'client', 'build', 'icon.png');
const OUT = path.resolve(__dirname, '..', 'client', 'build', 'icon-linux.png');
const SIZE = 512;

(async () => {
  const src = fs.readFileSync(SRC);
  const dataUrl = 'data:image/png;base64,' + src.toString('base64');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  const outB64 = await page.evaluate(async (opts) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = opts.url; });
    const c = document.getElementById('c');
    c.width = opts.size; c.height = opts.size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, opts.size, opts.size);
    ctx.drawImage(img, 0, 0, opts.size, opts.size);
    return c.toDataURL('image/png').slice('data:image/png;base64,'.length);
  }, { url: dataUrl, size: SIZE });

  await browser.close();
  fs.writeFileSync(OUT, Buffer.from(outB64, 'base64'));
  console.log('written', OUT, fs.statSync(OUT).size, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
