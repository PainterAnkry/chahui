/**
 * 茶绘 · 色调调整（滤镜）
 *
 * 亮度 / 对比度 / 色相 / 饱和度，逐像素做在 ImageData 上。
 *
 * 为什么逐像素而不是用 canvas 的 filter：
 *   · canvas 的 `filter` 只有 brightness/contrast/saturate/hue-rotate 这些，
 *     各自的取值范围和叠加顺序不透明，想和 SAI2 的滑块手感对上很难；
 *   · 逐像素这边能把公式写清楚、也好写测试。
 * 性能：一条 1600×1000 的图层是 160 万像素，实测量级在几十毫秒，够用。
 */
(function (global) {
  'use strict';

  var DEFAULTS = { brightness: 0, contrast: 0, hue: 0, saturation: 0 };

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    return { canvas: c, ctx: ctx };
  }

  /** 这三个都为 0 就是恒等变换 —— 调用方可以据此跳过整趟循环 */
  function isIdentity(o) {
    return !o || (!o.brightness && !o.contrast && !o.hue && !o.saturation);
  }

  /**
   * 就地修改 ImageData。
   * @param o { brightness:-100..100, contrast:-100..100, hue:-180..180, saturation:-100..100 }
   */
  function applyTone(img, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    if (isIdentity(o)) return img;
    var d = img.data;
    var i;

    // ---- 亮度 / 对比度：先做，作用在 RGB 上，alpha 不动 ----
    if (o.brightness || o.contrast) {
      var b = o.brightness * 2.55;
      // 对比度用常见的这条公式，c=0 时 f=1（恒等）
      var c = Math.max(-254, Math.min(254, o.contrast * 2.54));
      var f = (259 * (c + 255)) / (255 * (259 - c));
      for (i = 0; i < d.length; i += 4) {
        d[i] = clamp255(f * (d[i] + b - 128) + 128);
        d[i + 1] = clamp255(f * (d[i + 1] + b - 128) + 128);
        d[i + 2] = clamp255(f * (d[i + 2] + b - 128) + 128);
      }
    }

    // ---- 色相 / 饱和度：走 HSV ----
    if (!o.hue && !o.saturation) return img;
    var kSat = 1 + o.saturation / 100;
    var hueShift = o.hue;
    for (i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;                 // 全透明的像素不用碰
      var r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255;
      var mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
      var mn = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl);
      var v = mx;
      var s = mx === 0 ? 0 : (mx - mn) / mx;
      var h = 0;
      var dd = mx - mn;
      if (dd > 0) {
        if (mx === r) h = ((g - bl) / dd) % 6;
        else if (mx === g) h = (bl - r) / dd + 2;
        else h = (r - g) / dd + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      // 灰色的像素本来就没有色相，改色相没有意义（也就不会把灰染上颜色）
      if (dd > 0) h = (h + hueShift + 360) % 360;
      s = Math.max(0, Math.min(1, s * kSat));
      // HSV → RGB
      var cc = v * s;
      var xx = cc * (1 - Math.abs(((h / 60) % 2) - 1));
      var mm = v - cc;
      var rr, gg, bb;
      if (h < 60) { rr = cc; gg = xx; bb = 0; }
      else if (h < 120) { rr = xx; gg = cc; bb = 0; }
      else if (h < 180) { rr = 0; gg = cc; bb = xx; }
      else if (h < 240) { rr = 0; gg = xx; bb = cc; }
      else if (h < 300) { rr = xx; gg = 0; bb = cc; }
      else { rr = cc; gg = 0; bb = xx; }
      d[i] = clamp255((rr + mm) * 255);
      d[i + 1] = clamp255((gg + mm) * 255);
      d[i + 2] = clamp255((bb + mm) * 255);
    }
    return img;
  }

  /**
   * 对一张 canvas 的**指定区域**做色调调整，返回一张新 canvas。
   * 只处理这块区域能让大画布上的滤镜快很多（没选区时就是整幅）。
   */
  function toneCanvas(src, o, rect) {
    var W = src.width, H = src.height;
    var x = rect ? Math.max(0, Math.floor(rect.x)) : 0;
    var y = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    var w = rect ? Math.min(W - x, Math.ceil(rect.w)) : W;
    var h = rect ? Math.min(H - y, Math.ceil(rect.h)) : H;
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d');
    oc.drawImage(src, 0, 0);
    if (w <= 0 || h <= 0 || isIdentity(o)) return out;
    var img = oc.getImageData(x, y, w, h);
    applyTone(img, o);
    oc.putImageData(img, x, y);
    return out;
  }

  /* ============================================================ 色阶 */

  var LEVELS_DEFAULTS = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

  function isLevelsIdentity(o) {
    return !o || (o.inBlack === 0 && o.inWhite === 255 && Math.abs(o.gamma - 1) < 1e-6 &&
      o.outBlack === 0 && o.outWhite === 255);
  }

  /**
   * 色阶：输入黑场 / 白场 / 中间调 gamma + 输出黑场 / 白场。
   *   1) 把 [inBlack, inWhite] 拉成 [0,1]（夹住两端）
   *   2) 按 gamma 做中间调幂函数（gamma > 1 变亮，< 1 变暗 —— 和高斯那套一致）
   *   3) 映射到 [outBlack, outWhite]
   * 逐像素、alpha 不动。
   */
  function applyLevels(img, o) {
    o = Object.assign({}, LEVELS_DEFAULTS, o || {});
    if (isLevelsIdentity(o)) return img;
    var inB = clamp255(o.inBlack), inW = clamp255(o.inWhite);
    if (inW <= inB) inW = inB + 1;                       // 防止除零
    var outB = clamp255(o.outBlack), outW = clamp255(o.outWhite);
    var gamma = Math.max(0.1, Math.min(9.99, o.gamma || 1));
    var invG = 1 / gamma;

    // 查表：0..255 一次算好，逐像素只查表，快很多
    var lut = new Uint8ClampedArray(256);
    var span = inW - inB;
    var outSpan = outW - outB;
    for (var v = 0; v < 256; v++) {
      var t = (v - inB) / span;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      if (Math.abs(invG - 1) > 1e-9) t = Math.pow(t, invG);
      lut[v] = clamp255(outB + t * outSpan);
    }
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    return img;
  }

  function levelsCanvas(src, o, rect) {
    var W = src.width, H = src.height;
    var x = rect ? Math.max(0, Math.floor(rect.x)) : 0;
    var y = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    var w = rect ? Math.min(W - x, Math.ceil(rect.w)) : W;
    var h = rect ? Math.min(H - y, Math.ceil(rect.h)) : H;
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d');
    oc.drawImage(src, 0, 0);
    if (w <= 0 || h <= 0 || isLevelsIdentity(o)) return out;
    var img = oc.getImageData(x, y, w, h);
    applyLevels(img, o);
    oc.putImageData(img, x, y);
    return out;
  }

  /* ============================================================ 高斯模糊 */

  /**
   * 高斯模糊（用 canvas 原生的 filter，Chrome/Electron 里就是真高斯）。
   *
   * 直接 blur 有个坑：画布外的像素是「透明」，模糊会把四条边的内容也一起
   * 稀释掉，结果边缘一圈发虚发白。做法是先造一张**四周按边缘像素延展**的
   * 大画布（把原图在 9 个位置各画一遍），模糊它，再把中间那块裁回来。
   */
  function blurCanvas(src, radius, rect) {
    var W = src.width, H = src.height;
    var out = newCanvas(W, H);
    var r = Math.max(0, Math.min(200, Number(radius) || 0));
    if (r < 0.05) { out.ctx.drawImage(src, 0, 0); return out; }

    var pad = Math.ceil(r * 3);
    var pw = W + pad * 2, ph = H + pad * 2;
    var big = document.createElement('canvas');
    big.width = pw; big.height = ph;
    var bc = big.getContext('2d');
    // 9 次平铺：让四周的 padding 拿到边缘像素，模糊时边缘才不会被稀释
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        bc.drawImage(src, pad + ox * W, pad + oy * H);
      }
    }
    out.ctx.save();
    out.ctx.filter = 'blur(' + r.toFixed(2) + 'px)';
    out.ctx.drawImage(big, -pad, -pad);
    out.ctx.restore();
    out.ctx.filter = 'none';

    // 只保留当前图层原本有像素的地方 —— 模糊不该把透明的图层变成一坨灰雾
    if (!rect) {
      var t = document.createElement('canvas');
      t.width = W; t.height = H;
      var tc = t.getContext('2d');
      tc.drawImage(src, 0, 0);
      tc.globalCompositeOperation = 'destination-in';
      // 用「原图不透明的范围」当遮罩：先做一份实心轮廓
      tc.globalCompositeOperation = 'source-in';
      tc.fillStyle = '#fff';
      tc.fillRect(0, 0, W, H);
      // 轮廓按半径膨胀一点，免得边缘被裁掉
      var grown = document.createElement('canvas');
      grown.width = W; grown.height = H;
      var gc = grown.getContext('2d');
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) gc.drawImage(t, dx * r * 0.5, dy * r * 0.5);
      out.ctx.globalCompositeOperation = 'destination-in';
      out.ctx.drawImage(grown, 0, 0);
      out.ctx.globalCompositeOperation = 'source-over';
    }
    return out;
  }

  global.ChaFilters = {
    blurCanvas: blurCanvas,
    LEVELS_DEFAULTS: LEVELS_DEFAULTS,
    isLevelsIdentity: isLevelsIdentity,
    applyLevels: applyLevels,
    levelsCanvas: levelsCanvas,
    DEFAULTS: DEFAULTS,
    isIdentity: isIdentity,
    applyTone: applyTone,
    toneCanvas: toneCanvas
  };
})(window);
