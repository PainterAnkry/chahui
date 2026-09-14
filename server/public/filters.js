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

  global.ChaFilters = {
    DEFAULTS: DEFAULTS,
    isIdentity: isIdentity,
    applyTone: applyTone,
    toneCanvas: toneCanvas
  };
})(window);
