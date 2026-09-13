/**
 * 把应用图标从红色改成蓝色（保持形状与明暗，只旋转色相）。
 * 用浏览器做：Node 这边没有 PNG 编解码库，而页面里的 canvas 现成就能改像素。
 * 用法: node tools/recolor-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PW = 'C:/Users/Ankry/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const ICON = path.resolve(__dirname, '..', 'client', 'build', 'icon.png');
const OUT_SIZES = [
  ['client/build/icon.png', 256]
];

(async () => {
  const src = fs.readFileSync(ICON);
  const dataUrl = 'data:image/png;base64,' + src.toString('base64');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  const outB64 = await page.evaluate(async (url) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;

    function rgb2hsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 2;
      let h = 0, s = 0;
      if (mx !== mn) {
        const dd = mx - mn;
        s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
        if (mx === r) h = ((g - b) / dd + (g < b ? 6 : 0));
        else if (mx === g) h = (b - r) / dd + 2;
        else h = (r - g) / dd + 4;
        h /= 6;
      }
      return [h, s, l];
    }
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    function hsl2rgb(h, s, l) {
      if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
      ];
    }

    // 目标色：与应用主色一致（#3f8be8 → #2f6fd0 那一族，色相约 213°）
    const TARGET_HUE = 213 / 360;
    let changed = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      // 只动「红色家族」的像素：白色杯子和高光饱和度很低，不会被碰到；
      // 淡粉色的那道横条饱和度约 0.2，能跟着一起变蓝。
      const isRed = (h < 0.09 || h > 0.94) && s > 0.06;
      if (!isRed) continue;
      // 保留原来的饱和度和亮度，只换色相 —— 渐变和高光的层次都还在
      const rgb = hsl2rgb(TARGET_HUE + (h > 0.5 ? h - 1 : h) * 0.06, s, l);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
      changed++;
    }
    ctx.putImageData(id, 0, 0);
    return { b64: c.toDataURL('image/png').split(',')[1], changed, total: c.width * c.height };
  }, dataUrl);

  const buf = Buffer.from(outB64.b64, 'base64');
  fs.writeFileSync(ICON, buf);
  console.log('已重写着色 ' + ICON);
  console.log('  改动像素 ' + outB64.changed + ' / ' + outB64.total +
    '（' + (outB64.changed / outB64.total * 100).toFixed(1) + '%）');
  console.log('  文件大小 ' + (src.length / 1024).toFixed(1) + 'KB → ' + (buf.length / 1024).toFixed(1) + 'KB');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
