/**
 * 介绍视频 · 合成
 *
 * 把 shoot.js 拍到的分镜，在浏览器里合成成一支带标题、字幕、运镜和 BGM 的 MP4。
 * 之所以在浏览器里合成：本机没有 ffmpeg，而 Chrome 的 MediaRecorder 能直接吐 H.264 MP4。
 *
 * 用法:
 *   node tools/video/build.js                     合成并输出 MP4
 *   node tools/video/build.js --preview 3,12,28   只渲染几个时间点的 PNG（用来「看一眼」）
 *   node tools/video/build.js --preview 3 --scale 0.5
 *
 * 产物: video/茶绘-介绍.mp4
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../pw');

const ROOT = path.resolve(__dirname, '..', '..');
const VIDEO_DIR = path.join(ROOT, 'video');
const SHOTS = path.join(VIDEO_DIR, 'shots');
const OUT_MP4 = path.join(VIDEO_DIR, '茶绘-介绍.mp4');
const OUT_FRAMES = path.join(VIDEO_DIR, 'frames');

const argv = process.argv.slice(2);
const previewIdx = argv.indexOf('--preview');
const PREVIEW = previewIdx >= 0 ? argv[previewIdx + 1].split(',').map(s => parseFloat(s.trim())) : null;
const scaleIdx = argv.indexOf('--scale');
const PREVIEW_SCALE = scaleIdx >= 0 ? parseFloat(argv[scaleIdx + 1]) : 1;

const W = 1920, H = 1080;

/* ================================================================ 时间轴 */

/**
 * 素材里的「源矩形」都是 16:9 —— 卡片也是 16:9，这样一张都不用拉伸变形。
 *   full   整个 app 窗口
 *   wide   收一点点（去掉最外圈）
 *   canvas 只留画布区（含左右面板一点边）
 *   doc    几乎只剩那张白纸
 * 这几个数字是量出来的：文档 1600×1000 在 1920×1080 的窗口里，
 * zoomFit 之后落在屏幕 x∈[310,1572] y∈[187,975]，中心 (941,581)。
 */
const CROP = {
  full: { x: 0, y: 0, w: 1920, h: 1080 },
  wide: { x: 141, y: 131, w: 1600, h: 900 },
  // 下面两个都严格落在白纸里面（白纸 1262×788），避免画面边缘露出透明的棋盘格；
  // doc 这个框是照着「画面本身的范围」算的 —— 少一像素就会把下面那条地平线切掉
  canvas: { x: 310, y: 226, w: 1262, h: 710 },
  doc: { x: 358, y: 281, w: 1164, h: 655 }
};
const C = CROP;

/**
 * 时间轴。in / rate 是照着 tools/video/timeline.js 量出来的着墨曲线定的：
 *   01-solo     3.6s 开始画，14s 画完
 *   02-duo-a/b  8.5s 开始画，10.0s 太阳出现，20s 画完（两端几乎同步）
 *   03-guest-b  1.0s 就看到已有画面，3.0s 开始添太阳
 */
const TIMELINE = [
  { kind: 'card', dur: 5.0, title: '茶绘', sub: '一起画，就在同一张画布上', fade: 0.7 },

  { kind: 'shot', dur: 7.0, shot: '01-solo', in: 3.6, rate: 1.15,
    zoom: [C.full, C.wide], caption: '不用注册 · 打开就能画', fade: 0.5 },

  { kind: 'shot', dur: 6.5, shot: '02-duo-a', in: 8.4, rate: 1.0,
    pip: { shot: '02-duo-b', in: 8.4, rate: 1.0 },
    zoom: [C.wide, C.canvas], caption: '同一 WiFi，两台电脑，一张画布', fade: 0.4 },

  { kind: 'split', dur: 7.0, shot: '02-duo-a', in: 10.0, rate: 0.75,
    shot2: '02-duo-b', in2: 10.0, rate2: 0.75,
    zoom: [C.canvas, C.doc], caption: '两边看到的是同一张画布', fade: 0.4 },

  { kind: 'shot', dur: 6.5, shot: '02-duo-a', in: 14.2, rate: 1.0,
    pip: { shot: '02-duo-b', in: 14.2, rate: 1.0 },
    zoom: [C.canvas, C.wide], caption: '你画这边，他画那边', fade: 0.4 },

  { kind: 'shot', dur: 7.5, shot: '03-guest-b', in: 0.05, rate: 0.9,
    zoom: [C.full, C.wide], caption: '把地址发出去，朋友用浏览器就能进来', fade: 0.5 },

  { kind: 'still', dur: 6.5, shot: '02-duo-a', in: 25.4,
    zoom: [C.canvas, C.doc], caption: '一起画完的', fade: 0.6 },

  { kind: 'card', dur: 6.5, title: '茶绘', sub: '开源免费 · 一个人画，一群人画，都行', tail: true }
];

const TOTAL = TIMELINE.reduce((s, x) => s + x.dur, 0);

/* ================================================================ 页面代码 */

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>build</title>
<style>
  html,body{margin:0;background:#000;overflow:hidden}
  canvas{display:block;width:${W}px;height:${H}px}
</style></head>
<body><canvas id="cv" width="${W}" height="${H}"></canvas>
<script>
const TIMELINE = __TIMELINE__;
const TOTAL = __TOTAL__;
const W = ${W}, H = ${H};
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';

/* ---------------- 素材 ---------------- */
const sources = {};          // key -> {video, ready, duration}
const needed = new Set();
TIMELINE.forEach(s => {
  if (s.shot) needed.add(s.shot);
  if (s.pip) needed.add(s.pip.shot);
  if (s.shot2) needed.add(s.shot2);
});
const readyList = [];
for (const name of needed) {
  const v = document.createElement('video');
  v.src = '/shots/' + name + '.webm';
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  const p = new Promise((res) => {
    v.addEventListener('loadeddata', () => res(), { once: true });
    v.addEventListener('error', () => res(), { once: true });
    setTimeout(res, 15000);
  });
  sources[name] = v;
  readyList.push(p);
}
window.assetsReady = Promise.all(readyList).then(() => {
  const info = {};
  for (const k in sources) info[k] = { w: sources[k].videoWidth, h: sources[k].videoHeight, d: sources[k].duration };
  return info;
});

/* ---------------- 缓动 ---------------- */
const clamp01 = x => x < 0 ? 0 : (x > 1 ? 1 : x);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutQuint = t => 1 - Math.pow(1 - t, 5);

/* ---------------- 背景 ---------------- */
function paintBg(c, kind) {
  if (kind === 'dark') { c.fillStyle = '#0B0B0D'; c.fillRect(0, 0, W, H); return; }
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#FBFBFC');
  g.addColorStop(1, '#ECEEF2');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
}

/* 圆角矩形路径 */
function rr(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 把源矩形画进目标卡片（带圆角裁切 + 柔和投影） */
function drawCard(c, video, src, dst, radius, shadow) {
  c.save();
  if (shadow !== false) {
    c.shadowColor = 'rgba(20,24,35,.22)';
    c.shadowBlur = 48;
    c.shadowOffsetY = 18;
  }
  c.fillStyle = '#fff';
  rr(c, dst.x, dst.y, dst.w, dst.h, radius);
  c.fill();
  c.restore();

  c.save();
  rr(c, dst.x, dst.y, dst.w, dst.h, radius);
  c.clip();
  if (video && video.readyState >= 2) {
    c.drawImage(video, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
  } else {
    c.fillStyle = '#fff';
    c.fillRect(dst.x, dst.y, dst.w, dst.h);
  }
  c.restore();
}

/* ---------------- 文字 ---------------- */
function drawText(c, text, x, y, size, color, weight, alpha, align) {
  if (alpha <= 0.001) return;
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.font = weight + ' ' + size + 'px ' + FONT;
  c.textAlign = align || 'center';
  c.textBaseline = 'alphabetic';
  c.fillText(text, x, y);
  c.restore();
}

/* ---------------- 音频 ---------------- */
const NOTE = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
function freq(name) {
  const m = /^([A-G])(#?)(-?\\d)$/.exec(name);
  const semis = NOTE[m[1]] + (m[2] ? 1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  return 440 * Math.pow(2, (semis - 69) / 12);
}
/** 一段简单、干净的和弦垫 + 琶音。苹果那种片子的配乐就是「稳、暖、不抢戏」。 */
function scheduleMusic(ac, dest, t0, dur) {
  const master = ac.createGain();
  master.gain.value = 0.9;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.4;
  const delay = ac.createDelay(1.0); delay.delayTime.value = 0.36;
  const fb = ac.createGain(); fb.gain.value = 0.28;
  const wet = ac.createGain(); wet.gain.value = 0.26;
  delay.connect(fb); fb.connect(delay);
  delay.connect(wet); wet.connect(lp);
  master.connect(lp);
  lp.connect(dest);
  lp.connect(delay);

  const bpm = 84, beat = 60 / bpm, bar = beat * 4;
  // C - G - Am - F，稳稳的四个和弦
  const prog = [
    { pad: ['C3', 'E3', 'G3', 'B3'], root: 'C2', arp: ['C4', 'E4', 'G4', 'B4', 'G4', 'E4'] },
    { pad: ['G2', 'D3', 'G3', 'B3'], root: 'G1', arp: ['D4', 'G4', 'B4', 'D5', 'B4', 'G4'] },
    { pad: ['A2', 'E3', 'A3', 'C4'], root: 'A1', arp: ['E4', 'A4', 'C5', 'E5', 'C5', 'A4'] },
    { pad: ['F2', 'C3', 'F3', 'A3'], root: 'F1', arp: ['C4', 'F4', 'A4', 'C5', 'A4', 'F4'] }
  ];
  const bars = Math.ceil(dur / bar) + 1;
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const ch = prog[b % prog.length];
    const bt = t0 + b * bar;
    if (bt > t0 + dur) break;
    // 垫：慢起慢落
    ch.pad.forEach((n, i) => {
      notes.push({ f: freq(n), at: bt, dur: bar * 1.02, type: 'triangle', gain: 0.055 - i * 0.006, attack: 0.9, release: 1.1, detune: (i - 2) * 4 });
    });
    // 低音
    notes.push({ f: freq(ch.root), at: bt, dur: bar * 0.94, type: 'sine', gain: 0.16, attack: 0.06, release: 0.5, detune: 0 });
    // 琶音：八分音符，音量做点起伏，听着不呆
    const step = beat / 2;
    ch.arp.forEach((n, i) => {
      const at = bt + i * step;
      if (at > t0 + dur) return;
      notes.push({ f: freq(n), at, dur: step * 1.7, type: 'triangle', gain: 0.035 + (i % 3 === 0 ? 0.016 : 0), attack: 0.012, release: step * 1.2, detune: 0 });
    });
  }
  const end = t0 + dur;
  notes.forEach(nt => {
    if (nt.at > end) return;
    const o = ac.createOscillator();
    o.type = nt.type;
    o.frequency.value = nt.f;
    o.detune.value = nt.detune || 0;
    const g = ac.createGain();
    const a = nt.attack, r = nt.release, d = Math.min(nt.dur, end - nt.at);
    g.gain.setValueAtTime(0, nt.at);
    g.gain.linearRampToValueAtTime(nt.gain, nt.at + a);
    g.gain.setValueAtTime(nt.gain, nt.at + Math.max(a, d - r));
    g.gain.linearRampToValueAtTime(0, nt.at + d);
    o.connect(g); g.connect(master);
    o.start(nt.at); o.stop(nt.at + d + 0.05);
  });
  // 首尾各做一个淡入淡出
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.linearRampToValueAtTime(0.9, t0 + 1.2);
  master.gain.setValueAtTime(0.9, t0 + dur - 1.6);
  master.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  return master;
}

/* ---------------- 分镜渲染 ---------------- */

function segAt(t) {
  let acc = 0;
  for (let i = 0; i < TIMELINE.length; i++) {
    const s = TIMELINE[i];
    if (t < acc + s.dur || i === TIMELINE.length - 1) return { s, i, local: t - acc, acc };
    acc += s.dur;
  }
}

/** 字幕：进场 0.5s 上浮，出场 0.4s 淡出 */
function captionAlpha(local, dur) {
  const IN = 0.55, OUT = 0.45;
  if (local < IN) return easeOut(local / IN);
  if (local > dur - OUT) return 1 - clamp01((local - (dur - OUT)) / OUT);
  return 1;
}

function drawShotScene(c, s, local, globalT) {
  const p = clamp01(local / s.dur);
  const zt = easeInOut(p);
  const z = s.zoom;
  const lerpRect = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
  const src = z ? lerpRect(z[0], z[1], zt) : { x: 0, y: 0, w: W, h: H };

  // 卡片固定 16:9，正好和素材一致
  const cw = 1568, ch = 882;
  const card = { x: (W - cw) / 2, y: 64, w: cw, h: ch };
  paintBg(c, 'light');

  if (s.kind === 'split') {
    // 一左一右两台电脑，同时播
    const gap = 34;
    const sw = (card.w - gap) / 2;
    const sh2 = sw * 9 / 16;
    const y = card.y + (card.h - sh2) / 2;
    const left = { x: card.x, y, w: sw, h: sh2 };
    const right = { x: card.x + sw + gap, y, w: sw, h: sh2 };
    drawCard(c, sources[s.shot], src, left, 18, true);
    drawCard(c, sources[s.shot2], src, right, 18, true);
    const tag = (t, box2) => {
      c.save();
      c.globalAlpha = 0.94;
      c.fillStyle = '#111418';
      c.font = '500 17px ' + FONT;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const tw = c.measureText(t).width + 34;
      rr(c, box2.x + 14, box2.y + 14, tw, 34, 17);
      c.fill();
      c.fillStyle = '#fff';
      c.fillText(t, box2.x + 14 + tw / 2, box2.y + 31);
      c.restore();
    };
    tag('小茶的电脑', left);
    tag('阿墨的电脑', right);
  } else {
    drawCard(c, sources[s.shot], src, card, 26, true);
    if (s.pip) {
      const pw = 470, ph = 264;
      const pip = { x: card.x + card.w - pw - 30, y: card.y + card.h - ph - 30, w: pw, h: ph };
      const pv = sources[s.pip.shot];
      c.save();
      c.shadowColor = 'rgba(20,24,35,.30)';
      c.shadowBlur = 26; c.shadowOffsetY = 10;
      c.fillStyle = '#fff';
      rr(c, pip.x, pip.y, pip.w, pip.h, 14);
      c.fill();
      c.restore();
      c.save();
      rr(c, pip.x, pip.y, pip.w, pip.h, 14);
      c.clip();
      if (pv && pv.readyState >= 2) c.drawImage(pv, src.x, src.y, src.w, src.h, pip.x, pip.y, pip.w, pip.h);
      c.restore();
      c.save();
      c.globalAlpha = 0.94;
      c.fillStyle = '#111418';
      rr(c, pip.x + 12, pip.y + 12, 108, 32, 16);
      c.fill();
      c.fillStyle = '#fff';
      c.font = '500 16px ' + FONT;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('另一台电脑', pip.x + 66, pip.y + 28);
      c.restore();
    }
  }

  if (s.caption) {
    const a = captionAlpha(local, s.dur);
    const rise = (1 - easeOut(clamp01(local / 0.55))) * 16;
    c.save();
    c.font = '600 40px ' + FONT;
    const tw = c.measureText(s.caption).width;
    const bw = tw + 88, bh = 82;
    const bx = (W - bw) / 2, by = H - 122 + rise;
    c.globalAlpha = a * 0.94;
    c.fillStyle = '#111418';
    rr(c, bx, by, bw, bh, bh / 2);
    c.fill();
    c.restore();
    drawText(c, s.caption, W / 2, H - 122 + rise + 53, 40, '#fff', '600', a, 'center');
  }
}

function drawCardScene(c, s, local) {
  paintBg(c, s.bg === 'dark' ? 'dark' : 'light');
  const p = clamp01(local / s.dur);
  const dark = s.bg === 'dark';
  const ink = dark ? '#F5F5F7' : '#0E1116';
  const sub = dark ? 'rgba(245,245,247,.62)' : 'rgba(14,17,22,.52)';

  // 标题：淡入 + 上浮，尾卡反过来慢慢淡出
  const inA = easeOut(clamp01(local / 0.9));
  const outA = s.tail ? clamp01((s.dur - local) / 0.9) : 1;
  const a = Math.min(inA, s.tail ? outA : 1);
  const rise = (1 - easeOut(clamp01(local / 0.9))) * 26;

  const bigSize = 168;
  c.save();
  c.font = '700 ' + bigSize + 'px ' + FONT;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  const tw = c.measureText(s.title).width;
  c.restore();
  // 标题底下一条慢慢展开的线，特别「宣传片」
  const lineW = lerp(0, tw * 0.4, easeOutQuint(clamp01((local - 0.55) / 1.1)));
  c.save();
  c.globalAlpha = a * 0.85;
  c.fillStyle = '#3F8F6E';
  c.fillRect(W / 2 - lineW / 2, H / 2 + 76, lineW, 5);
  c.restore();

  drawText(c, s.title, W / 2, H / 2 - 26 + rise, bigSize, ink, '700', a, 'center');
  const subA = Math.min(a, easeOut(clamp01((local - 0.7) / 0.8)));
  drawText(c, s.sub, W / 2, H / 2 + 156 + rise * 0.5, 46, sub, '400', subA, 'center');

  if (s.tail) {
    // 尾卡：来一行小字放地址和许可
    const a2 = easeOut(clamp01((local - 1.5) / 0.9));
    drawText(c, 'github.com/PainterAnkry/chahui', W / 2, H / 2 + 268, 30, sub, '400', a2 * 0.9, 'center');
    drawText(c, 'MIT 许可 · 免费下载 · 自建服务端也行', W / 2, H / 2 + 320, 30, sub, '400', a2 * 0.72, 'center');
  }
}

function drawScene(c, t) {
  const { s, local } = segAt(t);
  if (s.kind === 'card') drawCardScene(c, s, local);
  else drawShotScene(c, s, local, t);
}

/* ---------------- 播放控制（实时合成用） ----------------
 *
 * ⚠ 有坑：同一段素材会被好几个片段用到（02-duo-a 在「并排」「小窗」「定格」里都出现）。
 * 如果边遍历时间轴边改 video 元素，后面那个「当前不在场」的片段会把刚播起来的视频
 * 又暂停掉 —— 表现就是：那一段的画面整块空白（卡片里只剩白底）。
 * 所以先把每个视频的目标状态算清楚，再统一应用一次。
 *
 * 另外换段时素材要跳时间点，得**等 seek 完再播**，否则 seek 过程中
 * readyState 会掉下去，drawImage 画出来就是空的。
 */
function syncVideos(t) {
  const plan = {};
  let acc = 0;
  for (let i = 0; i < TIMELINE.length; i++) {
    const s = TIMELINE[i];
    const local = t - acc;
    if (local >= -1.1 && local < s.dur + 0.05) {
      const still = s.kind === 'still';
      const add = (name, cin, rate) => { if (name) plan[name] = { idx: i, cin, rate, still, local: Math.max(0, local), warm: local < 0 }; };
      add(s.shot, s.in, s.rate);
      if (s.pip) add(s.pip.shot, s.pip.in, s.pip.rate);
      if (s.shot2) add(s.shot2, s.in2, s.rate2);
    }
    acc += s.dur;
  }
  for (const name in sources) {
    const v = sources[name];
    const w = plan[name];
    if (!w) { if (!v.paused) v.pause(); continue; }
    // 换到新片段：先停、跳到起点，等 seeked 之后再播
    if (v._seg !== w.idx) {
      v._seg = w.idx;
      v._pending = true;
      try { v.pause(); } catch (e) { /* ignore */ }
      try { v.playbackRate = 1; } catch (e) { /* ignore */ }
      try { v.currentTime = Math.max(0, w.cin); } catch (e) { /* ignore */ }
      const done = () => { v.removeEventListener('seeked', done); v._pending = false; };
      v.addEventListener('seeked', done);
      setTimeout(done, 450);
      continue;
    }
    if (w.warm || v._pending) { if (!v.paused) v.pause(); continue; }
    const want = w.cin + w.local * (w.still ? 0 : w.rate);
    if (w.still) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - want) > 0.12) { try { v.currentTime = want; } catch (e) {} }
      continue;
    }
    if (Math.abs(v.currentTime - want) > 0.45) { try { v.currentTime = Math.max(0, want); } catch (e) {} continue; }
    if (v.playbackRate !== w.rate) { try { v.playbackRate = w.rate; } catch (e) {} }
    if (v.paused) v.play().catch(() => {});
  }
}
function pauseAll() { for (const k in sources) { try { sources[k].pause(); } catch (e) {} } }

/* ---------------- 渲染循环 ---------------- */
window.renderFrame = function (t) {
  const { s, i, local, acc } = segAt(t);
  const next = TIMELINE[i + 1];
  const fade = s.fade || 0;
  if (next && fade > 0 && local > s.dur - fade) {
    const a = clamp01((local - (s.dur - fade)) / fade);
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tc = tmp.getContext('2d');
    drawScene(tc, t);
    const tmp2 = document.createElement('canvas');
    tmp2.width = W; tmp2.height = H;
    const tc2 = tmp2.getContext('2d');
    drawScene(tc2, acc + s.dur + 0.001);
    ctx.globalAlpha = 1;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = a;
    ctx.drawImage(tmp2, 0, 0);
    ctx.globalAlpha = 1;
  } else {
    ctx.globalAlpha = 1;
    drawScene(ctx, t);
  }
  return { scene: i, local };
};

/* ---------------- 导出接口 ---------------- */
window.buildVideo = async function (opts) {
  await window.assetsReady;
  // 先把每个视频预热到它第一次出场的入点，省得开场那一下是空的
  const firstIn = {};
  let acc0 = 0;
  for (const s of TIMELINE) {
    const add = (n, cin) => { if (n && firstIn[n] === undefined) firstIn[n] = cin; };
    add(s.shot, s.in); if (s.pip) add(s.pip.shot, s.pip.in); if (s.shot2) add(s.shot2, s.in2);
    acc0 += s.dur;
  }
  await Promise.all(Object.keys(firstIn).map(n => new Promise(res => {
    const v = sources[n];
    if (!v) { res(); return; }
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    setTimeout(res, 3000);
    try { v.currentTime = firstIn[n]; } catch (e) { res(); }
  })));
  void acc0;

  const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await ac.resume();
  const audioDest = ac.createMediaStreamDestination();
  scheduleMusic(ac, audioDest, ac.currentTime + 0.25, TOTAL + 0.4);

  const stream = cv.captureStream(30);
  audioDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));

  const wanted = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  const mime = wanted.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 9 * 1000 * 1000,
    audioBitsPerSecond: 160 * 1000
  });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(1000);

  const t0 = performance.now() + 250;
  const audioStart = ac.currentTime + 0.25;
  await new Promise(resolve => {
    function loop() {
      const now = performance.now();
      let t = (now - t0) / 1000;
      if (t > 0) {
        syncVideos(t);
        window.renderFrame(Math.min(t, TOTAL - 0.001));
      }
      if (t >= TOTAL) { resolve(); return; }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
  pauseAll();
  await new Promise(res => { rec.onstop = res; rec.stop(); });
  void audioStart;
  const blob = new Blob(chunks, { type: mime || 'video/mp4' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return { mime, b64: btoa(s) };
};

/* ---------------- 单帧预览 ---------------- */
window.renderStill = async function (t) {
  await window.assetsReady;
  for (const k in sources) {
    const v = sources[k];
    try { v.pause(); } catch (e) {}
  }
  // 把要用到的视频精确 seek 到对应时间
  let acc = 0;
  const jobs = [];
  for (let i = 0; i < TIMELINE.length; i++) {
    const s = TIMELINE[i];
    if (t >= acc && t < acc + s.dur) {
      const local = t - acc;
      const seek = (name, cin, rate, still) => {
        const v = sources[name];
        if (!v) return;
        const want = Math.min(Math.max(0, cin + (still ? 0 : local * rate)), Math.max(0, (v.duration || 1) - 0.05));
        jobs.push(new Promise(res => {
          if (Math.abs(v.currentTime - want) < 0.02) { res(); return; }
          const done = () => { v.removeEventListener('seeked', done); res(); };
          v.addEventListener('seeked', done);
          setTimeout(res, 4000);
          v.currentTime = want;
        }));
      };
      const still = s.kind === 'still';
      if (s.shot) seek(s.shot, s.in, s.rate, still);
      if (s.pip) seek(s.pip.shot, s.pip.in, s.pip.rate, still);
      if (s.shot2) seek(s.shot2, s.in2, s.rate2, still);
    }
    acc += s.dur;
  }
  await Promise.all(jobs);
  await new Promise(r => requestAnimationFrame(r));
  window.renderFrame(t);
  return cv.toDataURL('image/png');
};
<\/script>
</body></html>`;

/* ================================================================ 静态服务 */

const MIME = {
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.js': 'text/javascript', '.html': 'text/html'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (u === '/__blank__') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>build</title>'); return; }
    const f = path.join(VIDEO_DIR, u.replace(/^\/+/, ''));
    if (!f.startsWith(VIDEO_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const total = fs.statSync(f).size;
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes',
        'content-range': 'bytes ' + start + '-' + end + '/' + total,
        'content-length': String(end - start + 1)
      });
      fs.createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(total) });
      fs.createReadStream(f).pipe(res);
    }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ================================================================ 主流程 */

(async () => {
  if (!fs.existsSync(SHOTS) || !fs.readdirSync(SHOTS).some(f => f.endsWith('.webm'))) {
    console.error('没有找到分镜素材，先跑: node tools/video/shoot.js');
    process.exit(2);
  }
  fs.mkdirSync(OUT_FRAMES, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  const args = ['--autoplay-policy=no-user-gesture-required'];
  void args;
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1
  });
  page.on('pageerror', e => console.log('  !! 页面报错:', String(e).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') console.log('  !! console:', m.text()); });

  await page.goto('http://127.0.0.1:' + port + '/__blank__');
  const html = PAGE.replace('__TIMELINE__', JSON.stringify(TIMELINE)).replace('__TOTAL__', String(TOTAL));
  await page.setContent(html);

  const assets = await page.evaluate(() => window.assetsReady);
  console.log('\n素材:');
  Object.keys(assets).forEach(k => console.log('  ' + k.padEnd(14), assets[k].w + '×' + assets[k].h, (assets[k].d || 0).toFixed(1) + 's'));
  console.log('\n总时长 ' + TOTAL.toFixed(1) + 's，共 ' + TIMELINE.length + ' 个片段');

  if (PREVIEW) {
    console.log('\n预览模式，渲染指定时间点的单帧：');
    for (const t of PREVIEW) {
      const dataUrl = await page.evaluate((tt) => window.renderStill(tt), t);
      const out = path.join(OUT_FRAMES, 'preview_' + String(t).replace('.', 'p') + 's.png');
      let buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      if (PREVIEW_SCALE !== 1) {
        // 需要缩小时用页面里的 canvas 再缩放一次
        const small = await page.evaluate(async ([url, k]) => {
          const img = new Image();
          await new Promise(r => { img.onload = r; img.src = url; });
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/png');
        }, [dataUrl, PREVIEW_SCALE]);
        buf = Buffer.from(small.split(',')[1], 'base64');
      }
      fs.writeFileSync(out, buf);
      console.log('  ✓', path.relative(ROOT, out));
    }
    await browser.close();
    server.close();
    return;
  }

  // 真正的合成：实时跑一遍，录下来
  console.log('\n开始合成（实时，约 ' + Math.ceil(TOTAL) + ' 秒）…');
  await page.exposeFunction('__onProgress', (t) => {
    process.stdout.write('\r  进度 ' + t.toFixed(1) + ' / ' + TOTAL.toFixed(1) + 's   ');
  });
  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    const r = await window.buildVideo({});
    return r;
  });
  const secs = (Date.now() - t0) / 1000;
  fs.writeFileSync(OUT_MP4, Buffer.from(res.b64, 'base64'));
  process.stdout.write('\n');
  console.log('  编码 ' + res.mime + '，用时 ' + secs.toFixed(1) + 's');
  console.log('  输出 ' + path.relative(ROOT, OUT_MP4) + '  ' + (fs.statSync(OUT_MP4).size / 1024 / 1024).toFixed(1) + 'MB');

  await browser.close();
  server.close();
})();

