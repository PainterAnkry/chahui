/**
 * 茶绘 · 绘画引擎（v2）
 * 图层模型、SAI2 风格笔刷渲染、撤销/重做、回放、导出
 *
 * 渲染架构（保证「实时增量绘制」与「历史整体重绘」结果完全一致）：
 *   layer.canvas   —— 已确认的累积结果
 *   stroke.scratch —— 正在绘制中的笔迹「覆盖率蒙版」（单色，alpha 已含笔压→浓度）
 *   合成时把 scratch 按 边缘硬度 / 画笔混合模式 / 水彩边缘 / 保护不透明度 叠加到图层
 *
 * 为什么用「覆盖蒙版」而不是逐点盖章：
 *   逐点盖章会让同一笔在自己重叠处反复叠加变深（串珠）。覆盖率蒙版里 alpha 是「最大值」
 *   语义，一笔之内绝对不会因为折返而加深，这也是这类软件的手感来源。
 *   为支持「笔压→浓度」，笔迹在蒙版内按 (宽度, 浓度) 量化分段绘制，段间用平头端点相接，
 *   只在整笔首尾补半圆端帽 —— 既不产生接缝叠加，又保留圆润的起笔收笔。
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;

  var SCRATCH_POOL_MAX = 10;
  var ALPHA_STEPS = 24;   // 浓度量化级数（越大越平滑，分段越多）

  /* ============================================================ 基础工具 */

  function mkCanvas(w, h, readOften) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', readOften ? { willReadFrequently: true } : undefined);
    return { canvas: c, ctx: ctx };
  }

  function q5(v) { return Math.round(v * 4) / 4 || 0; }
  function qa(v) { return Math.max(1, Math.round(v * ALPHA_STEPS)) / ALPHA_STEPS; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /** 确定性伪随机：散布 / 颗粒必须让所有客户端得到完全一样的结果 */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var BLEND_OPS = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    darken: 'darken',
    lighten: 'lighten',
    add: 'lighter',
    difference: 'difference',
    exclusion: 'exclusion',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity'
  };
  function blendOp(name) { return BLEND_OPS[name] || 'source-over'; }

  // 哪些工具吃尺子（形状 / 选区 / 油漆桶不吃 —— 它们本来就有确定的几何）
  var RULER_TOOLS = { brush: 1, eraser: 1, blur: 1, smudge: 1 };

  function isText(stroke) { return stroke.tool === 'text'; }
  function isLiquify(stroke) { return stroke.tool === 'liquify'; }

  var FONT_STACK = {
    sans: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    serif: 'Georgia, "Times New Roman", "SimSun", serif',
    mono: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    kai: '"KaiTi", "STKaiti", "Kaiti SC", serif',
    hei: '"Microsoft YaHei", "PingFang SC", "Heiti SC", sans-serif',
    song: '"SimSun", "Songti SC", serif'
  };

  /** 文字的 CSS font 串。字体族只认白名单，两端才画得一样 */
  function fontOf(stroke) {
    var fam = FONT_STACK[stroke.fontFamily] || FONT_STACK.sans;
    var style = (stroke.italic ? 'italic ' : '') + (stroke.bold ? '700 ' : '400 ');
    return style + Math.max(6, stroke.fontSize || 32) + 'px ' + fam;
  }

  /** 把一段文字画进 ctx（锚点在 points[0]，多行按 lineHeight 排） */
  function paintText(ctx, stroke) {
    if (!stroke.text) return;
    var a = stroke.points && stroke.points[0];
    if (!a) return;
    var size = Math.max(6, stroke.fontSize || 32);
    var lh = size * (stroke.lineHeight || 1.35);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = qa(stroke.opacity == null ? 1 : stroke.opacity);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.font = fontOf(stroke);
    ctx.textAlign = stroke.align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = stroke.color || '#000000';
    var lines = String(stroke.text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], a[0], a[1] + i * lh);
    }
    ctx.restore();
  }

  function isEraser(stroke) { return stroke.tool === 'eraser'; }
  function isBlur(stroke) { return stroke.tool === 'blur'; }
  function isSmudge(stroke) { return stroke.tool === 'smudge'; }
  function isShape(stroke) { return stroke.tool === 'line' || stroke.tool === 'rect' || stroke.tool === 'ellipse'; }
  function isFill(stroke) { return stroke.tool === 'fill'; }
  function isGradient(stroke) { return stroke.tool === 'gradient'; }
  function isSelectTool(stroke) {
    return stroke.tool === 'select' || stroke.tool === 'selectErase' ||
      stroke.tool === 'marquee' || stroke.tool === 'lasso' || stroke.tool === 'wand';
  }
  // 一次性选区工具（框选 / 套索 / 魔棒）：画完直接把结果写进蒙版，而不是像选区笔那样一段段涂
  function isRegionSelect(stroke) {
    return stroke.tool === 'marquee' || stroke.tool === 'lasso' || stroke.tool === 'wand';
  }
  // 两点式工具：只保留首尾点，实时预览画在 overlay 上
  function isTwoPoint(stroke) { return isShape(stroke) || isGradient(stroke); }

  /* ---------------- 协作视图：别人的笔迹可以淡一点 / 藏起来 ----------------
   *
   * 纯**显示**效果：文档（layer.canvas）永远是原样，导出 / 固化 / 合并 / 上传
   * 走的还是 layer.canvas；屏幕上要显示的那一份放在 layer.viewCanvas 里。
   *
   * 为什么非得单独一张画布：笔迹一旦画进图层，像素就分不出是谁的了，
   * 事后没有任何办法「只把某几个人的调淡」。
   *
   * 这几个「破坏类」笔迹不是「画上去的东西」：橡皮 / 模糊 / 涂抹 / 液化。
   * 淡化它们没有意义，而且会让「我屏幕上看到的」和「文档里真实的」差太多，
   * 所以它们一律按原样生效。
   */
  var DIM_LEVELS = { soft: 0.45, faint: 0.14, hide: 0 };
  function isDestructive(stroke) {
    return isEraser(stroke) || isBlur(stroke) || isSmudge(stroke) || isLiquify(stroke);
  }
  // 选区笔不进笔迹历史，也就谈不上「谁的笔触」
  function isSelectStroke(stroke) { return isSelectTool(stroke); }

  /* ============================================================ 笔尖形态 */

  // 笔压 → 直径
  function widthAt(stroke, p) {
    var t = clamp(p == null ? 0.5 : p, 0, 1);
    var mn = clamp(stroke.minSize, 0.02, 1);
    var k = stroke.pressSize == null ? 1 : stroke.pressSize;
    var f = 1 - k * (1 - Math.pow(t, 0.8));
    return Math.max(0.35, stroke.size * clamp(f, mn, 1));
  }

  // 笔压 → 浓度
  function alphaAt(stroke, p) {
    var base = stroke.opacity == null ? 1 : stroke.opacity;
    var t = clamp(p == null ? 0.5 : p, 0, 1);
    var k = stroke.pressOpacity || 0;
    if (!k) return base;
    var f = (1 - k) + k * Math.pow(t, 0.7);
    return Math.max(0.02, base * f);
  }

  /**
   * 边缘硬度 → 模糊半径。
   * 注意以前这里是 `Math.max(0.4, …)`：只要硬度不是 1 就强行加 0.4px 模糊，
   * 于是硬度 0.95 的铅笔/钢笔也被磨成软边，「硬边笔」根本硬不起来。
   * 现在：硬度 ≥ 0.98 完全不模糊；算出来不足 0.35px 的模糊没有意义（只会让边缘发虚），
   * 一并归零。真正的柔边笔（喷枪 / 水彩）硬度很低，模糊半径依然很大，不受影响。
   */
  function blurPxOf(stroke) {
    var h = stroke.hardness == null ? 1 : stroke.hardness;
    if (h >= 0.98) return 0;
    var b = stroke.size * (1 - h) * 0.5;
    return b < 0.35 ? 0 : b;
  }

  function blurPxForTool(stroke) {
    return clamp(stroke.size * 0.35 * (stroke.strength || 0.7), 0.6, 60);
  }

  function strokeMaxWidth(stroke) { return Math.max(1, stroke.size); }

  /* ============================================================ 对称尺 */

  function symmetryCopies(stroke, W, H) {
    var mode = stroke.sym || 'none';
    var cx = W / 2, cy = H / 2;
    var out = [{ sx: 1, sy: 1, cx: cx, cy: cy }];
    if (mode === 'x' || mode === 'xy') out.push({ sx: -1, sy: 1, cx: cx, cy: cy });
    if (mode === 'y' || mode === 'xy') out.push({ sx: 1, sy: -1, cx: cx, cy: cy });
    if (mode === 'xy') out.push({ sx: -1, sy: -1, cx: cx, cy: cy });
    return out;
  }

  function mp(m, x, y) {
    return [m.sx < 0 ? m.cx * 2 - x : x, m.sy < 0 ? m.cy * 2 - y : y];
  }

  /* ============================================================ 颗粒（纸纹） */

  var grainCache = new Map();

  /**
   * 颗粒纹理的 alpha 只有 0 / 1 两种取值，因此「重复叠加」是幂等的 —— 增量绘制时
   * 反复对同一块区域打孔不会越打越透，这是它能边画边生效的关键。
   */
  function grainPattern(stroke) {
    var paper = stroke.paper || 'none';
    var grain = stroke.grain || 0;
    if (!grain || paper === 'none') return null;
    var sc = clamp(stroke.grainScale || 1, 0.2, 4);
    var keep = 1 - grain * 0.5;
    var key = (stroke.seed >>> 0) + '|' + paper + '|' + Math.round(keep * 40) + '|' + Math.round(sc * 10);
    var hit = grainCache.get(key);
    if (hit !== undefined) return hit;
    if (grainCache.size > 12) grainCache.clear();

    var S = paper === 'coarse' ? 64 : 96;
    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var ctx = c.getContext('2d');
    var rnd = mulberry32((stroke.seed >>> 0) || 1);
    var i, x, y, img, d;

    if (paper === 'canvas') {
      // 织纹：横竖细线成网格，网格内再按浓度撒点
      img = ctx.createImageData(S, S);
      d = img.data;
      for (y = 0; y < S; y++) {
        for (x = 0; x < S; x++) {
          i = (y * S + x) * 4;
          var on = (x % 3 === 0) || (y % 3 === 0) || (rnd() < keep);
          d[i + 3] = on ? 255 : 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    } else if (paper === 'coarse') {
      // 粗纹：低分辨率随机后放大，再二值化（保持「重复叠加幂等」）
      var n = 18;
      var tmp = document.createElement('canvas');
      tmp.width = n; tmp.height = n;
      var tctx = tmp.getContext('2d');
      var ti = tctx.createImageData(n, n);
      for (i = 0; i < n * n; i++) ti.data[i * 4 + 3] = rnd() < keep ? 255 : 0;
      tctx.putImageData(ti, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, n, n, 0, 0, S, S);
      var img2 = ctx.getImageData(0, 0, S, S);
      for (i = 0; i < S * S; i++) img2.data[i * 4 + 3] = img2.data[i * 4 + 3] > 110 ? 255 : 0;
      ctx.putImageData(img2, 0, 0);
    } else {
      // 细纹：单像素随机噪点
      img = ctx.createImageData(S, S);
      d = img.data;
      for (i = 0, n = S * S; i < n; i++) d[i * 4 + 3] = rnd() < keep ? 255 : 0;
      ctx.putImageData(img, 0, 0);
    }

    var pat = ctx.createPattern(c, 'repeat');
    if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') {
      try { pat.setTransform(new DOMMatrix([sc, 0, 0, sc, 0, 0])); } catch (e) { /* ignore */ }
    }
    grainCache.set(key, pat);
    return pat;
  }

  function strokeBBox(pts, pad, copies) {
    if (!pts || !pts.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var ci = 0; ci < copies.length; ci++) {
      var m = copies[ci];
      for (var i = 0; i < pts.length; i++) {
        var q = mp(m, pts[i][0], pts[i][1]);
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    }
    pad = pad / 2 + 2;
    return { x0: Math.floor(x0 - pad), y0: Math.floor(y0 - pad), x1: Math.ceil(x1 + pad), y1: Math.ceil(y1 + pad) };
  }

  function applyGrain(ctx, stroke, pts, copies) {
    if (!stroke.grain) return;
    var b = strokeBBox(pts, strokeMaxWidth(stroke) * 1.2, copies);
    if (!b) return;
    var pat = grainPattern(stroke);
    if (!pat) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = pat;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.restore();
  }

  /* ============================================================ 笔迹绘制 */

  function strokeStyleSetup(ctx, stroke) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineJoin = 'round';
  }

  // 半圆端帽：只覆盖「笔身之外」的半个圆，与笔身零重叠，因此不会叠加变深
  function drawCap(ctx, x, y, dx, dy, r, alpha) {
    var len = Math.hypot(dx, dy);
    if (!len) return;
    var ang = Math.atan2(dy / len, dx / len);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.35, r), ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** 连续笔身：按 (宽度, 浓度) 量化分段，段间平头相接 */
  function paintRuns(ctx, stroke, pts, fromIndex, m, opts) {
    strokeStyleSetup(ctx, stroke);

    if (pts.length === 1) {
      var p0 = mp(m, pts[0][0], pts[0][1]);
      ctx.globalAlpha = qa(alphaAt(stroke, pts[0][2]));
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], Math.max(0.35, widthAt(stroke, pts[0][2]) / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    var start = Math.max(0, (fromIndex || 0) - 1);
    if (start > pts.length - 2) return;

    var runs = [];
    var cur = null;
    for (var i = start; i < pts.length - 1; i++) {
      var pmid = (pts[i][2] + pts[i + 1][2]) / 2;
      var w = q5(widthAt(stroke, pmid));
      var al = qa(alphaAt(stroke, pmid));
      if (cur && cur.w === w && cur.a === al) cur.i1 = i + 1;
      else { if (cur) runs.push(cur); cur = { i0: i, i1: i + 1, w: w, a: al }; }
    }
    if (cur) runs.push(cur);

    // 圆头端帽：一笔在「宽度 / 浓度变化处」会被拆成多段分别描边，
    // 平头（butt）对接时，如果接头正好落在拐角上，外侧会缺一个楔形。
    // 用圆头就没这个问题 —— 整笔首尾本来就另外补了半圆端帽，
    // 所以换成圆头并不会让笔画两端变样，只是把内部接头填实。
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var k = 0; k < runs.length; k++) {
      var run = runs[k];
      ctx.globalAlpha = run.a;
      ctx.lineWidth = run.w;
      ctx.beginPath();
      var sp = mp(m, pts[run.i0][0], pts[run.i0][1]);
      ctx.moveTo(sp[0], sp[1]);
      for (var j = run.i0 + 1; j <= run.i1; j++) {
        var pj = mp(m, pts[j][0], pts[j][1]);
        ctx.lineTo(pj[0], pj[1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 整笔起点补半圆端帽（只在第一批绘制时补一次）
    if (opts && opts.startCap && runs.length) {
      var a0 = mp(m, pts[0][0], pts[0][1]);
      var a1 = mp(m, pts[1][0], pts[1][1]);
      drawCap(ctx, a0[0], a0[1], a0[0] - a1[0], a0[1] - a1[1],
        widthAt(stroke, pts[0][2]) / 2, runs[0].a);
    }
  }

  /** 整笔终点补半圆端帽（提交 / 重放时调用一次） */
  function paintEndCap(ctx, stroke, pts, m) {
    if (!pts || pts.length < 2) return;
    var n = pts.length;
    strokeStyleSetup(ctx, stroke);
    var last = mp(m, pts[n - 1][0], pts[n - 1][1]);
    var prev = mp(m, pts[n - 2][0], pts[n - 2][1]);
    drawCap(ctx, last[0], last[1], last[0] - prev[0], last[1] - prev[1],
      widthAt(stroke, pts[n - 1][2]) / 2, qa(alphaAt(stroke, pts[n - 1][2])));
  }

  /** 散布：把采样点抖散成一簇小点（噪点笔） */
  function paintScatter(ctx, stroke, pts, fromIndex, m) {
    strokeStyleSetup(ctx, stroke);
    var rnd = mulberry32(((stroke.seed >>> 0) ^ 0x9e3779b9) >>> 0);
    var start = fromIndex || 0;
    var radius = Math.max(0.4, stroke.size * 0.16);
    // 散布幅度按 scatter 本身缩放。以前是 `0.35 + scatter*1.15`，只要 scatter 不为 0
    // 起步就是笔刷直径的 35%，铅笔那种「一点点散布」直接炸成一团雾。
    var spread = stroke.size * (0.15 + stroke.scatter * 0.85);
    var per = 2 + Math.round(stroke.scatter * 6);
    var i, k;
    // 让随机序列与「绝对点序号」绑定，保证分批绘制与整体重绘完全一致
    for (i = 0; i < start; i++) { for (k = 0; k < per; k++) { rnd(); rnd(); rnd(); } }
    for (i = start; i < pts.length; i++) {
      var base = mp(m, pts[i][0], pts[i][1]);
      var a = qa(alphaAt(stroke, pts[i][2]));
      for (k = 0; k < per; k++) {
        var ang = rnd() * Math.PI * 2;
        var rad = Math.pow(rnd(), 0.6) * spread;
        var rr = radius * (0.55 + rnd() * 0.9);
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(base[0] + Math.cos(ang) * rad, base[1] + Math.sin(ang) * rad, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function shapePath(ctx, tool, a, b, m) {
    var p0 = mp(m, a[0], a[1]);
    var p1 = mp(m, b[0], b[1]);
    ctx.beginPath();
    if (tool === 'line') {
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
    } else if (tool === 'rect') {
      ctx.rect(Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]),
        Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]));
    } else {
      ctx.ellipse((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2,
        Math.max(0.1, Math.abs(p1[0] - p0[0]) / 2), Math.max(0.1, Math.abs(p1[1] - p0[1]) / 2),
        0, 0, Math.PI * 2);
    }
  }

  function paintShapeCopy(ctx, stroke, pts, m) {
    var a = pts[0], b = pts[pts.length - 1];
    strokeStyleSetup(ctx, stroke);
    ctx.globalAlpha = qa(alphaAt(stroke, 1));
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    shapePath(ctx, stroke.tool, a, b, m);
    if (stroke.filled && stroke.tool !== 'line') ctx.fill();
    else ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ---------------- 导入的笔尖位图（PS / CSP 笔刷） ---------------- */

  var tipCache = new Map();      // tip 字符串 -> canvas（同步解包，拿到就能用）

  /** 把打包好的 4 位灰度笔尖解成一张小 canvas；缓存住，一笔只解一次 */
  function tipCanvas(tipStr) {
    if (!tipStr) return null;
    if (tipCache.has(tipStr)) return tipCache.get(tipStr);
    var u = global.ChaBrushImport && global.ChaBrushImport.unpackTip(tipStr);
    if (!u) { tipCache.set(tipStr, null); return null; }
    var c = document.createElement('canvas');
    c.width = u.w; c.height = u.h;
    var cx = c.getContext('2d');
    var img = cx.createImageData(u.w, u.h);
    img.data.set(u.rgba);
    cx.putImageData(img, 0, 0);
    if (tipCache.size > 64) tipCache.clear();     // 别让试笔刷的过程把内存堆满
    tipCache.set(tipStr, c);
    return c;
  }

  /**
   * 按笔尖位图落笔：沿路径按弧长等距盖章。
   *
   * 为什么不是「沿路径描一条线」：导入的笔刷（PS 的星形、CSP 的各种笔尖）
   * 形状在笔尖本身，描线只能得到圆头。盖章点由「量化后的点」算弧长得到，
   * 所以两端算出的落点完全一致。
   */
  function paintTipStroke(ctx, stroke, pts, fromIndex, m) {
    var tip = tipCanvas(stroke.tip);
    if (!tip) return false;                        // 还没解出来：交给调用方退化处理
    strokeStyleSetup(ctx, stroke);
    var n = pts.length;
    if (!n) return true;
    var spacing = Math.max(1, stroke.size * (stroke.spacing || 0.1));
    var rnd = mulberry32(((stroke.seed >>> 0) ^ 0x85ebca6b) >>> 0);

    // 整条路径累计弧长（每次都从头算，保证分批与整笔结果一致）
    var start = fromIndex || 0;
    var pos = mp(m, pts[0][0], pts[0][1]);
    var s = 0, next = 0;
    var i;
    // 起点先盖一枚
    stampTip(ctx, tip, stroke, pos, pts[0][2]);
    next = spacing;
    for (i = 1; i < n; i++) {
      var a = mp(m, pts[i - 1][0], pts[i - 1][1]);
      var b = mp(m, pts[i][0], pts[i][1]);
      var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg <= 0) continue;
      while (next <= s + seg) {
        var t = (next - s) / seg;
        var x = a[0] + (b[0] - a[0]) * t;
        var y = a[1] + (b[1] - a[1]) * t;
        var pr = pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t;
        if (stroke.scatter > 0) {
          var ang = rnd() * Math.PI * 2;
          var rad = Math.pow(rnd(), 0.6) * stroke.size * (0.15 + stroke.scatter * 0.85);
          x += Math.cos(ang) * rad; y += Math.sin(ang) * rad;
        } else if (rnd) { rnd(); rnd(); }
        stampTip(ctx, tip, stroke, [x, y], pr);
        next += spacing;
      }
      s += seg;
      pos = b;
    }
    ctx.globalAlpha = 1;
    void start; void pos;
    return true;
  }

  function stampTip(ctx, tip, stroke, p, press) {
    var d = widthAt(stroke, press);
    ctx.globalAlpha = qa(alphaAt(stroke, press));
    ctx.drawImage(tip, p[0] - d / 2, p[1] - d / 2, d, d);
  }

  /** 把一笔完整画进「覆盖率蒙版」（单色，alpha 含笔压→浓度） */
  function paintStrokeShape(ctx, stroke, pts, fromIndex, opts) {
    opts = opts || {};
    if (!pts || !pts.length) return;
    if (isText(stroke) || isLiquify(stroke)) return;   // 文字 / 液化不走笔刷栅格化
    var W = opts.width || ctx.canvas.width;
    var H = opts.height || ctx.canvas.height;
    var st = stroke;
    if (opts.widthMul && opts.widthMul !== 1) st = Object.assign({}, stroke, { size: stroke.size * opts.widthMul });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = true;

    var copies = symmetryCopies(st, W, H);
    // 散布有两种语义，以前只有一种，于是「铅笔」也画成了点：
    //   · 散布笔（brush === 'scatter'）—— 整笔就是一簇抖散的点，不画连续笔身
    //   · 其它笔刷勾了散布 —— 先画连续笔身，再在上面撒一层颗粒
    //     （SAI2 的「散布」是画材效果，叠加在笔身之上，不会把线拆成点）
    // 铅笔默认 scatter=0.04，以前正因此被整笔走了「纯散布」分支，画出来是一串点而不是线。
    var pureScatter = st.brush === 'scatter';
    for (var ci = 0; ci < copies.length; ci++) {
      var m = copies[ci];
      if (isShape(st)) { paintShapeCopy(ctx, st, pts, m); continue; }
      if (pureScatter) { paintScatter(ctx, st, pts, fromIndex, m); continue; }
      // 带笔尖位图的（导入的 PS / CSP 笔刷）：盖章而不是描线。
      // 位图还没解出来时 paintTipStroke 返回 false，这一帧退回圆头，不影响落点数据。
      if (st.tip && paintTipStroke(ctx, st, pts, fromIndex, m)) continue;
      paintRuns(ctx, st, pts, fromIndex, m, opts);
      if (st.scatter > 0) paintScatter(ctx, st, pts, fromIndex, m);
    }

    if (st.grain > 0 && !opts.noGrain) applyGrain(ctx, st, pts, copies);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }

  /* ============================================================ 合成 */

  /** 把蒙版按笔刷属性叠加到目标上下文 */
  function paintOnto(ctx, stroke, src, alpha, useBlur) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = isEraser(stroke) ? 'destination-out' : blendOp(stroke.blend);
    var b = useBlur ? blurPxOf(stroke) : 0;
    ctx.filter = b > 0 ? 'blur(' + b.toFixed(2) + 'px)' : 'none';
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  /** 模糊工具：把目标里被蒙版覆盖的部分替换成模糊后的结果 */
  function applyBlurMaskedTo(dstCtx, dstCanvas, maskCanvas, stroke, W, H, take, release) {
    var t = take();
    clearCtx(t.ctx, W, H);
    t.ctx.filter = 'blur(' + blurPxForTool(stroke).toFixed(2) + 'px)';
    t.ctx.drawImage(dstCanvas, 0, 0);
    t.ctx.filter = 'none';
    t.ctx.globalCompositeOperation = 'destination-in';
    t.ctx.drawImage(maskCanvas, 0, 0);
    t.ctx.globalCompositeOperation = 'source-over';
    dstCtx.save();
    dstCtx.setTransform(1, 0, 0, 1, 0, 0);
    dstCtx.globalAlpha = 1;
    dstCtx.globalCompositeOperation = 'source-over';
    dstCtx.filter = 'none';
    dstCtx.drawImage(t.canvas, 0, 0);
    dstCtx.restore();
    release(t.canvas);
  }

  /**
   * 涂抹：把「笔迹开始那一刻的图层像素」按拖动方向反复搬运，累积出拖拽感。
   * 源像素取自一份冻结快照（不读自身），因此结果只是 (快照, 笔迹点) 的纯函数，
   * 本地绘制与远端回放能算出完全一致的像素。
   */
  function paintSmudge(sctx, stroke, srcCanvas, W, H, take, release) {
    clearCtx(sctx, W, H);
    var pts = stroke.points;
    if (!pts || pts.length < 2) return;
    var strength = clamp(stroke.strength == null ? 0.6 : stroke.strength, 0.05, 1);
    var copies = symmetryCopies(stroke, W, H);

    // 覆盖率蒙版：限定涂抹范围、并给软边
    var mask = take();
    clearCtx(mask.ctx, W, H);
    paintStrokeShape(mask.ctx, stroke, pts, 0, {
      width: W, height: H, startCap: true, noGrain: true
    });
    for (var ci = 0; ci < copies.length; ci++) paintEndCap(mask.ctx, stroke, pts, copies[ci]);

    var acc = take();
    clearCtx(acc.ctx, W, H);
    acc.ctx.globalAlpha = clamp(strength * 0.5, 0.04, 0.85);
    acc.ctx.imageSmoothingEnabled = true;

    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = (a[0] - b[0]) * 1.25, dy = (a[1] - b[1]) * 1.25;
      if (!dx && !dy) continue;
      var r = Math.max(0.6, widthAt(stroke, b[2]) / 2);
      for (var k = 0; k < copies.length; k++) {
        var q = mp(copies[k], b[0], b[1]);
        acc.ctx.save();
        acc.ctx.beginPath();
        acc.ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
        acc.ctx.clip();
        acc.ctx.drawImage(srcCanvas, dx, dy);
        acc.ctx.restore();
      }
    }
    acc.ctx.globalAlpha = 1;

    // 只用笔迹范围内（含软边）的搬运结果
    sctx.drawImage(acc.canvas, 0, 0);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask.canvas, 0, 0);
    sctx.globalCompositeOperation = 'source-over';

    release(acc.canvas);
    release(mask.canvas);
  }

  // 给测试/排查用
  global.__liquifyProbe = function (stroke, srcCanvas) {
    var f = liquifyField(stroke);
    if (!f) return { field: null };
    var max = 0, at = null;
    for (var i = 0; i < f.dx.length; i++) {
      var v = Math.abs(f.dx[i]);
      if (v > max) { max = v; at = [f.x0 + (i % f.w), f.y0 + Math.floor(i / f.w)]; }
    }
    var out = liquifyResample(srcCanvas, f, srcCanvas.width, srcCanvas.height);
    var a = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;
    var b = out.canvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;
    var diff = 0;
    for (var k = 0; k < a.length; k += 4) if (a[k] !== b[k] || a[k + 3] !== b[k + 3]) diff++;
    return { box: [f.x0, f.y0, f.w, f.h], maxDx: max, at: at, diffAfterResample: diff };
  };

  function clearCtx(ctx, w, h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
  }

  function layerCommit(layer) { layer.dirty = false; layer.thumbDirty = true; }

  /** 整张画布的副本（蒙版预览要「回到落笔前」再整笔重画，就得先留一份） */
  function copyCanvas(src) {
    var c = mkCanvas(src.width, src.height, false);
    c.ctx.drawImage(src, 0, 0);
    return c.canvas;
  }

  /**
   * 颜色的感知亮度（0 = 黑，1 = 白）。
   * 蒙版涂的是黑还是白决定了「隐藏」还是「显示」——
   * 跟 Photoshop 的图层蒙版是同一套直觉：黑遮白露。
   */
  function lumOf(hex) {
    var c = hexToRgb(hex);
    if (!c) return 0;
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var s = v.toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  function hexToRgb(hex) {
    var h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ============================================================ 油漆桶 */

  function growMask(mask, w, h, r) {
    // 分离式「最大值滤波」：行列各扫一遍，复杂度与半径无关
    var tmp = new Uint8Array(w * h);
    var line = new Int32Array(Math.max(w, h) + 1);
    var x, y;
    for (y = 0; y < h; y++) {
      var row = y * w;
      line[0] = 0;
      for (x = 0; x < w; x++) line[x + 1] = line[x] + (mask[row + x] ? 1 : 0);
      for (x = 0; x < w; x++) {
        var l = x - r < 0 ? 0 : x - r;
        var rr = x + r > w - 1 ? w - 1 : x + r;
        tmp[row + x] = (line[rr + 1] - line[l]) > 0 ? 1 : 0;
      }
    }
    var out = new Uint8Array(w * h);
    for (x = 0; x < w; x++) {
      line[0] = 0;
      for (y = 0; y < h; y++) line[y + 1] = line[y] + (tmp[y * w + x] ? 1 : 0);
      for (y = 0; y < h; y++) {
        var t0 = y - r < 0 ? 0 : y - r;
        var t1 = y + r > h - 1 ? h - 1 : y + r;
        out[y * w + x] = (line[t1 + 1] - line[t0]) > 0 ? 1 : 0;
      }
    }
    return out;
  }

  function floodFill(ctx, w, h, sx, sy, hex, tolerance, opacity, expand) {
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var idx = (sy * w + sx) * 4;
    var T = [d[idx], d[idx + 1], d[idx + 2], d[idx + 3]];
    var F = hexToRgb(hex);
    var tol = clamp(tolerance || 32, 1, 120);
    var op = clamp(opacity == null ? 1 : opacity, 0.02, 1);
    var outA = Math.round(255 * op);
    if (Math.abs(T[0] - F.r) <= 2 && Math.abs(T[1] - F.g) <= 2 &&
        Math.abs(T[2] - F.b) <= 2 && Math.abs(T[3] - outA) <= 3) return;

    var seen = new Uint8Array(w * h);
    var flooded = new Uint8Array(w * h);
    var stack = [sy * w + sx];
    var p, x, y, i4;
    while (stack.length) {
      p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      x = p % w; y = (p - x) / w;
      i4 = p * 4;
      if (Math.abs(d[i4] - T[0]) > tol || Math.abs(d[i4 + 1] - T[1]) > tol ||
          Math.abs(d[i4 + 2] - T[2]) > tol || Math.abs(d[i4 + 3] - T[3]) > tol) continue;
      flooded[p] = 1;
      d[i4] = Math.round(d[i4] + (F.r - d[i4]) * op);
      d[i4 + 1] = Math.round(d[i4 + 1] + (F.g - d[i4 + 1]) * op);
      d[i4 + 2] = Math.round(d[i4 + 2] + (F.b - d[i4 + 2]) * op);
      d[i4 + 3] = Math.max(d[i4 + 3], outA);
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }

    if (expand > 0) {
      var grown = growMask(flooded, w, h, Math.round(expand));
      for (p = 0; p < w * h; p++) {
        if (!grown[p] || flooded[p]) continue;
        i4 = p * 4;
        d[i4] = Math.round(d[i4] + (F.r - d[i4]) * op);
        d[i4 + 1] = Math.round(d[i4 + 1] + (F.g - d[i4 + 1]) * op);
        d[i4 + 2] = Math.round(d[i4 + 2] + (F.b - d[i4 + 2]) * op);
        d[i4 + 3] = Math.max(d[i4 + 3], outA);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ============================================================ 引擎 */

  function CanvasEngine() {
    this.listeners = {};
    this.width = 1600;
    this.height = 1000;
    this.background = '#ffffff';

    this.layers = [];
    /**
     * 图层组表。组**没有像素**，它只是一条「子图层怎么合到一起」的规则
     * （组自己的不透明度 + 混合模式），所以它不占 this.layers 里的位置。
     *
     * 不变式（和服务端一致）：**同一组的图层在 this.layers 里连续**，
     * 「组在哪」= 「它那一块在哪」。见 renderUnits()。
     */
    this.groups = [];
    this.groupById = new Map();
    this.activeLayerId = null;

    this.strokes = [];          // 全部已确认笔迹，按 seq 升序
    this.byId = new Map();
    this.seq = 0;

    this.pending = new Map();   // strokeId -> { stroke, layer, scratch, sctx }

    this.scale = 1; this.tx = 0; this.ty = 0;
    this.rot = 0; this.flipX = false;
    this.minScale = 0.05; this.maxScale = 16;

    this.grid = { on: false, size: 50 };

    this.dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.baseComposite = null;
    this.baseKey = '';
    this.baseDirty = true;
    this.needsCompose = true;
    this.scratchPool = [];
    this.composing = false;

    this.replayMode = false;
    this.replayCanvas = null;
    this.replayBaseCanvas = null;   // 「已播完」那部分的基底快照

    /* 协作视图（纯本机显示，不同步、不进文档） */
    this.dimMode = 'off';          // 'off' | 'soft' | 'faint' | 'hide'
    this.dimUsers = {};            // userId -> 0..1，成员面板里单独设的
    this.meId = null;              // 我自己的 userId
    this.localHidden = new Set();  // 「只对我隐藏」的图层 id
    this.replayStrokes = [];
    this.replayCursor = 0;
    this.replayTotal = 0;
    this.replayAt = 0;

    /* 洋葱皮（回放时把前后几笔染成残影）——纯本机显示，不进文档、不上传 */
    this.onion = { on: false, before: 1, after: 1 };
    this.onionWarm = null;         // 前影（暖色）小组画布
    this.onionCool = null;         // 后影（冷色）小组画布
    this.onionTmp = null;          // 建残影时的中转画布
    this._onionKey = '';           // 缓存键：残影只在「当前笔」换了之后重建

    this.view = null; this.viewCtx = null;
    this.overlay = null; this.overlayCtx = null;
    this.previewStroke = null;
    // 尺子：{ type, p0, p1, spacing }；只吸附**本地**取的点
    this.ruler = null;
    this.rulerPreview = null;
    this.showRuler = true;
    this.selectPreview = null;
    this.transform = null;
    this.viewportW = 0; this.viewportH = 0;

    this._raf = null;
    this._thumbTimer = null;
  }

  CanvasEngine.prototype.on = function (name, fn) {
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
  };
  CanvasEngine.prototype.emit = function (name, payload) {
    var l = this.listeners[name];
    if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](payload); } catch (e) { console.error(e); } }
  };

  /* ---------------- 初始化 ---------------- */

  CanvasEngine.prototype.attach = function (viewCanvas, overlayCanvas) {
    this.view = viewCanvas; this.viewCtx = viewCanvas.getContext('2d');
    this.overlay = overlayCanvas; this.overlayCtx = overlayCanvas.getContext('2d');
    this.resize();
    var self = this;
    global.addEventListener('resize', function () { self.resize(); });
    if (global.ResizeObserver && viewCanvas.parentElement) {
      new ResizeObserver(function () { self.resize(); }).observe(viewCanvas.parentElement);
    }
  };

  CanvasEngine.prototype.resize = function () {
    if (!this.view || !this.view.parentElement) return;
    var r = this.view.parentElement.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    this.view.style.width = w + 'px';
    this.view.style.height = h + 'px';
    this.view.width = Math.round(w * this.dpr);
    this.view.height = Math.round(h * this.dpr);
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.overlay.width = Math.round(w * this.dpr);
    this.overlay.height = Math.round(h * this.dpr);
    this.viewportW = w; this.viewportH = h;
    this.drawOverlay();
    this.invalidate();
  };

  CanvasEngine.prototype.init = function (meta) {
    this.width = meta.width || P.DEFAULTS.width;
    this.height = meta.height || P.DEFAULTS.height;
    this.background = meta.background || P.DEFAULTS.background;
    var self = this;
    this.layers = [];
    this.strokes = [];
    this.byId = new Map();
    this.pending.forEach(function (e) { self.releaseScratch(e.scratch); });
    this.pending.clear();
    this.seq = 0;
    this.replayMode = false;
    this.replayCanvas = null;
    this.previewStroke = null;
    this.selectPreview = null;
    this.selection = null;
    this.scratchPool.length = 0;
    this.baseComposite = null;
    this.baseKey = '';
    this.setGroups(meta.groups || []);
    (meta.layers || []).forEach(function (l) { self.addLayerMeta(l); });
    if (!this.layers.length) this.addLayerMeta({ id: P.rid('L'), name: '图层 1' });
    this.activeLayerId = this.layers[this.layers.length - 1].id;
    this.baseDirty = true;
    this.emit('layers', this.layerList());
    this.drawOverlay();
    this.invalidate();
  };

  CanvasEngine.prototype.addLayerMeta = function (meta) {
    var layer = {
      id: meta.id,
      name: meta.name || ('图层 ' + (this.layers.length + 1)),
      visible: meta.visible !== false,
      opacity: typeof meta.opacity === 'number' ? meta.opacity : 1,
      locked: !!meta.locked,
      alphaLock: !!meta.alphaLock,
      blend: P.BLEND_MODES.indexOf(meta.blend) >= 0 ? meta.blend : 'normal',
      groupId: meta.groupId || null,
      baseSeq: meta.baseSeq || 0,
      baseImage: null,
      canvas: null, ctx: null,
      /**
       * 图层蒙版。像素是一张与画布同尺寸的画布，**用 alpha 表示「该处显示多少」**
       * （不透明 = 全显示，透明 = 全隐藏）—— 正好对上 PSD 的蒙版语义，
       * 渲染时一句 destination-in 就套上去了。
       *
       *   hasMask     这一层有没有蒙版
       *   maskEnabled 眼下参不参与合成（关掉但留着，随时能再开）
       *   maskBase    导入 / 固化来的蒙版底图（已解码的 Image），蒙版重建时当底
       *   maskSnapshot 落笔那一刻的副本，供预览「整笔重画」用，松手后置空
       */
      hasMask: !!meta.hasMask,
      maskEnabled: meta.maskEnabled !== false,
      maskCanvas: null, maskCtx: null,
      maskBase: null,
      maskSnapshot: null,
      clip: !!meta.clip,
      strokes: [],
      dirty: true,
      thumb: null
    };
    var c = mkCanvas(this.width, this.height, true);
    layer.canvas = c.canvas; layer.ctx = c.ctx;
    this.layers.push(layer);
    return layer;
  };

  CanvasEngine.prototype.setBaseImage = function (layerId, dataUrl, cb) {
    var layer = this.getLayer(layerId);
    var self = this;
    if (!layer) { if (cb) cb(); return; }
    if (!dataUrl) {
      layer.baseImage = null;
      this.renderLayerFromHistory(layer);
      this.baseDirty = true; this.baseKey = ''; this.invalidate();
      if (cb) cb();
      return;
    }
    var img = new Image();
    img.onload = function () {
      layer.baseImage = img;
      self.renderLayerFromHistory(layer);
      self.baseDirty = true; self.baseKey = '';
      self.invalidate();
      if (cb) cb();
    };
    img.onerror = function () { if (cb) cb(); };
    img.src = dataUrl;
  };

  /* ---------------- 图层组 ----------------
   * 组没有像素，只有「子图层怎么合到一起」的规则。所以它不占 this.layers 的位置，
   * 位置由「它那一块图层在哪」决定 —— 见 renderUnits()。
   */

  CanvasEngine.prototype.setGroups = function (list) {
    this.groups = (list || []).map(function (g) {
      return {
        id: g.id,
        name: g.name || '组',
        visible: g.visible !== false,
        opacity: typeof g.opacity === 'number' ? g.opacity : 1,
        blend: P.BLEND_MODES.indexOf(g.blend) >= 0 ? g.blend : 'normal',
        collapsed: !!g.collapsed
      };
    });
    this.groupById = new Map(this.groups.map(function (g) { return [g.id, g]; }));
  };

  CanvasEngine.prototype.getGroup = function (id) {
    return id ? (this.groupById.get(id) || null) : null;
  };

  CanvasEngine.prototype.groupList = function () {
    var self = this;
    return this.groups.map(function (g) {
      return {
        id: g.id, name: g.name, visible: g.visible, opacity: g.opacity,
        blend: g.blend, collapsed: g.collapsed,
        count: self.layers.reduce(function (n, l) { return n + (l.groupId === g.id ? 1 : 0); }, 0)
      };
    });
  };

  /** 图层所属的组对象；不在组里、或那个组已经不在了（本地还没同步到）都返回 null */
  CanvasEngine.prototype.groupOf = function (layer) {
    if (!layer || !layer.groupId) return null;
    return this.getGroup(layer.groupId);
  };

  /** 这一刻该不该画出这一层：自身可见 + 没被「只对我隐藏」 + 所属的组可见 */
  CanvasEngine.prototype.layerDrawable = function (layer) {
    if (!layer || !layer.visible) return false;
    if (this.isLocallyHidden(layer)) return false;
    var g = this.groupOf(layer);
    if (g && !g.visible) return false;
    return true;
  };

  CanvasEngine.prototype.drawableLayers = function (layers) {
    var self = this;
    return layers.filter(function (l) { return self.layerDrawable(l); });
  };

  /** layerId → 这一刻该不该显示（层自己 + 所属组）。回放 / 洋葱皮的可见性快照复用它 */
  CanvasEngine.prototype.visibleMap = function () {
    var vis = {};
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      var g = this.groupOf(l);
      vis[l.id] = !!l.visible && !(g && !g.visible);
    }
    return vis;
  };

  /**
   * 自下而上把图层归拢成「渲染单元」：
   *   普通图层 → { group: null, layers: [它自己] }
   *   同一组   → { group: 组对象, layers: [组内所有图层，自下而上] }
   * 三处合成（基底 / 活动层重绘 / 导出）都走这一条，免得各写各的走样。
   */
  CanvasEngine.prototype.renderUnits = function () {
    var out = [], seen = {};
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      var g = this.groupOf(l);
      if (!g) { out.push({ group: null, layers: [l] }); continue; }
      if (seen[g.id]) continue;                  // 同一组只出一个单元
      seen[g.id] = 1;
      var members = [];
      for (var j = 0; j < this.layers.length; j++) {
        if (this.layers[j].groupId === g.id) members.push(this.layers[j]);
      }
      out.push({ group: g, layers: members });
    }
    return out;
  };

  /**
   * 把「一组图层」按组的不透明度 / 混合模式落到 dstCtx。
   * 组内各层先合到一张临时画布上（各自套自己的浓度与混合模式），
   * 最后**整组一次性**落下去 —— 这就是组和「一堆普通图层」的全部区别：
   * 组那层参数只作用一次。要是逐层乘下去，「组 50% + 组内 5 层」会淡成 3%，
   * 而用户按 50% 的直觉是「整组半透明」。
   */
  CanvasEngine.prototype.composeGroup = function (dstCtx, group, layers, opts) {
    var gs = this.takeScratch();
    var gctx = gs.ctx;
    clearCtx(gctx, this.width, this.height);
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.globalAlpha = 1; gctx.globalCompositeOperation = 'source-over'; gctx.filter = 'none';
    for (var i = 0; i < layers.length; i++) {
      var t = this.takeScratch();
      this.composeLayer(gctx, t.ctx, t.canvas, layers[i], opts);
      this.releaseScratch(t.canvas);
    }
    dstCtx.globalAlpha = group.opacity;
    dstCtx.globalCompositeOperation = blendOp(group.blend);
    dstCtx.drawImage(gs.canvas, 0, 0);
    dstCtx.globalAlpha = 1;
    dstCtx.globalCompositeOperation = 'source-over';
    this.releaseScratch(gs.canvas);
  };

  CanvasEngine.prototype.activeGroupIds = function () {
    var set = new Set();
    var self = this;
    this.pending.forEach(function (e) {
      var g = self.groupOf(e.layer);
      if (g) set.add(g.id);
    });
    return set;
  };

  CanvasEngine.prototype.getLayer = function (id) {
    for (var i = 0; i < this.layers.length; i++) if (this.layers[i].id === id) return this.layers[i];
    return null;
  };

  CanvasEngine.prototype.activeLayer = function () {
    return this.getLayer(this.activeLayerId) || this.layers[this.layers.length - 1];
  };

  CanvasEngine.prototype.layerList = function () {
    return this.layers.map(function (l) {
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        locked: l.locked, alphaLock: l.alphaLock, blend: l.blend,
        groupId: l.groupId || null, baseSeq: l.baseSeq,
        hasMask: !!l.hasMask, maskEnabled: l.maskEnabled !== false, clip: !!l.clip
      };
    });
  };

  CanvasEngine.prototype.setLayers = function (list, baseImages, groups, maskImages) {
    var self = this;
    var byId = new Map(this.layers.map(function (l) { return [l.id, l]; }));
    var next = [];
    (list || []).forEach(function (meta) {
      var l = byId.get(meta.id);
      if (!l) {
        l = self.addLayerMeta(meta);
        if (baseImages && baseImages[l.id]) self.setBaseImage(l.id, baseImages[l.id]);
      } else {
        l.name = meta.name; l.visible = meta.visible; l.opacity = meta.opacity;
        l.locked = !!meta.locked;
        l.alphaLock = !!meta.alphaLock;
        l.blend = P.BLEND_MODES.indexOf(meta.blend) >= 0 ? meta.blend : 'normal';
        l.groupId = meta.groupId || null;
        l.clip = !!meta.clip;
        l.maskEnabled = meta.maskEnabled !== false;
        // 服务端说有蒙版而本地还没建 → 建一张（全白，等于没套）
        if (meta.hasMask && !l.hasMask) { l.hasMask = true; self.ensureMask(l); }
        // 服务端说蒙版没了 → 本地一并丢掉
        if (!meta.hasMask && l.hasMask) { l.hasMask = false; self.dropMask(l); }
        var oldSeq = l.baseSeq;
        l.baseSeq = meta.baseSeq || 0;
        // 只要服务端给了底图、而本地这份底图对不上（版本变了，或者刚被 clearScope 清空），就要重新加载。
        // 少了 `|| !l.baseImage` 这一条时：服务端回传的 baseSeq 恰好也是 0（空房间里的第一次像素操作），
        // 条件不成立，图层会一直空着 —— 看起来就是「变换 / 清除之后画面没回来」。
        if (baseImages && baseImages[l.id] && (l.baseSeq !== oldSeq || !l.baseImage)) {
          self.setBaseImage(l.id, baseImages[l.id]);
        } else if (!l.baseSeq && l.baseImage) {
          l.baseImage = null;
          self.renderLayerFromHistory(l);
        }
        var i = self.layers.indexOf(l);
        if (i >= 0) self.layers.splice(i, 1);
      }
      next.push(l);
    });
    // 被移除的图层：把它的进行中笔迹一并丢掉
    this.layers.forEach(function (l) {
      if (next.indexOf(l) < 0) {
        Array.from(self.pending.keys()).forEach(function (k) {
          if (self.pending.get(k).layer === l) self.pending.delete(k);
        });
      }
    });
    this.layers = next;
    // 蒙版像素（只有导入 / 固化之后才会有）：等图层表定稿再统一套
    if (maskImages) {
      Object.keys(maskImages).forEach(function (mid) {
        var ml = self.getLayer(mid);
        if (ml) self.setMaskImage(ml, maskImages[mid]);
      });
    }
    // 组表必须先于「图层数组定稿」生效：后面 baseKey / 合成全都按分组走
    if (Array.isArray(groups)) this.setGroups(groups);
    if (!this.layers.length) this.addLayerMeta({ id: P.rid('L'), name: '图层 1' });
    if (!this.getLayer(this.activeLayerId)) this.activeLayerId = this.layers[this.layers.length - 1].id;
    this.baseDirty = true;
    this.baseKey = '';
    this.emit('layers', this.layerList());
    this.invalidate();
  };

  CanvasEngine.prototype.setActiveLayer = function (id) {
    var l = this.getLayer(id);
    if (!l) return;
    this.activeLayerId = id;
    this.emit('layers', this.layerList());
    this.invalidate();
  };

  /* ---------------- 笔迹 ---------------- */

  CanvasEngine.prototype.newStroke = function (info) {
    var layer = this.getLayer(info.layerId) || this.activeLayer();
    var br = P.normalizeBrush(info);
    return {
      id: info.id || P.rid('s'),
      layerId: layer.id,
      // 画在图层上还是蒙版上。**必须在这里落下来** —— 白名单漏了它，
      // 蒙版笔迹就会被当成普通笔迹画到图层上（跟笔刷参数漏字段是同一类坑）。
      target: br.target === 'mask' ? 'mask' : 'layer',
      userId: info.userId || null,
      tool: P.TOOLS.indexOf(info.tool) >= 0 ? info.tool : 'brush',
      color: info.color || '#000000',
      size: clamp(Number(info.size) || br.size || 6, 1, 400),
      opacity: clamp(typeof info.opacity === 'number' ? info.opacity : br.opacity, 0.02, 1),
      hardness: br.hardness,
      minSize: br.minSize,
      pressSize: br.pressSize,
      pressOpacity: br.pressOpacity,
      edge: br.edge,
      scatter: br.scatter,
      grain: br.grain,
      grainScale: br.grainScale,
      paper: br.paper,
      fx: br.fx,
      strength: br.strength,
      tolerance: br.tolerance,
      expand: br.expand,
      blend: br.blend,
      sym: br.sym,
      brush: br.brush,
      filled: br.filled,
      // 选区的加选 / 减选标记必须在这里显式带上 —— newStroke 只挑它认识的字段，
      // 漏掉的话 Shift / Alt 会被静默丢掉，加选退化成「替换」。
      add: !!info.add,
      subtract: !!info.subtract,
      // 导入的 PS / CSP 笔刷：笔尖位图 + 落点间隔
      spacing: br.spacing,
      tip: br.tip,
      mix: br.mix,
      // 文字笔迹（第四道白名单见 app.strokeInfo / server.buildStroke）
      text: P.normalizeText(info.text),
      fontFamily: P.normalizeFontFamily(info.fontFamily),
      fontSize: Math.max(6, Math.min(400, Number(info.fontSize) || 32)),
      bold: !!info.bold,
      italic: !!info.italic,
      align: ['left', 'center', 'right'].indexOf(info.align) >= 0 ? info.align : 'left',
      lineHeight: Math.max(0.8, Math.min(3, Number(info.lineHeight) || 1.35)),
      seed: br.seed || P.newSeed(),
      points: [],
      // ts / te = 这一笔的起止时刻，只有回放用得上。
      // 服务端不打这两个字段（strokeHeader 不含），由**收到消息的这一端本地打点** ——
      // 所以两台机器上「笔与笔之间的相对节奏」一致，绝对时刻各自本地，不必对表。
      ts: info.ts || Date.now(),
      te: info.te || 0,
      seq: info.seq || 0
    };
  };

  CanvasEngine.prototype.beginStroke = function (info) {
    var stroke = this.newStroke(info);
    var layer = this.getLayer(stroke.layerId);
    if (!layer) return null;
    // 液化要一份「落笔那一刻」的像素：结果是 (快照, 笔迹点) 的纯函数。
    // 注意必须挂在 **stroke** 上 —— newStroke 返回的是新对象，
    // 挂在传进来的 info 上会被丢掉（和白名单漏字段是同一种坑）。
    if (isLiquify(stroke)) {
      var fc = mkCanvas(this.width, this.height, false);
      fc.ctx.drawImage(layer.canvas, 0, 0);
      stroke._frozen = fc.canvas;
    }
    // 蒙版笔迹落笔时留一份蒙版快照 —— 预览要「回到落笔前再整笔重画」，
    // 直接往蒙版上累加会让同一笔越描越浓。
    if (stroke.target === 'mask' && layer.maskCanvas && !layer.maskSnapshot) {
      layer.maskSnapshot = copyCanvas(layer.maskCanvas);
    }
    var sc = this.takeScratch();
    var entry = { stroke: stroke, layer: layer, scratch: sc.canvas, sctx: sc.ctx, local: !!info.local };
    clearCtx(entry.sctx, this.width, this.height);
    this.pending.set(stroke.id, entry);
    this.baseDirty = true;
    return stroke;
  };

  CanvasEngine.prototype.addPoints = function (strokeId, pts) {
    var e = this.pending.get(strokeId);
    if (!e || !pts || !pts.length) return;
    var fromIndex = e.stroke.points.length;
    // 尺子吸附：**只对本地笔迹**做，而且就在存点这一刻做 ——
    // 于是笔迹里存的就是吸附后的点、上传的也是吸附后的点，
    // 别人原样重放即可。远端来的点绝不再吸（否则我换个尺子就把别人的线掰弯了）。
    var snapR = (e.local && this.ruler && this.ruler.type && RULER_TOOLS[e.stroke.tool])
      ? this.ruler : null;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!p) continue;
      var px = +p[0], py = +p[1];
      if (snapR && global.ChaRuler) {
        var sp = global.ChaRuler.snap(snapR, px, py);
        px = sp.x; py = sp.y;
      }
      e.stroke.points.push([px, py, p.length > 2 ? +p[2] : 0.5]);
    }
    var stroke = e.stroke;
    if (isTwoPoint(stroke)) {
      // 形状 / 渐变只保留首尾两点，实时预览画在 overlay
      this.previewStroke = stroke;
      this.drawOverlay();
      return;
    }
    if (isFill(stroke) || isSmudge(stroke)) return;
    if (isSelectTool(stroke)) {
      // 框选 / 套索要边拖边看得见框，实时画在 overlay 上
      // 框选 / 套索的实时框用**独立字段**。共用 previewStroke 会被下面的
      // 「形状 / 渐变预览」当成形状来画 —— shapePath 的 else 分支是椭圆，
      // 于是选区时画布上会冒出一个大椭圆（用户报的就是这个）。
      if (isRegionSelect(stroke)) { this.selectPreview = stroke; this.drawOverlay(); }
      return;
    }
    // 关键：实时预览**整笔重画**，而不是只画新增的那一段。
    //
    // 只画增量的话，每一批点都是独立的一条 polyline，批次之间是「平头对接」（butt cap）：
    // 抗锯齿在接缝处各留一半，就出现一圈淡淡的竖缝；笔头方向变化时还会露出楔形缺口。
    // 这些缝在屏幕上就是「笔画断断续续」；等松手时 endStroke 会用 paintToScratch 整笔重画一次，
    // 缝随之消失 —— 也就是用户说的「有延迟才变为连续的」。
    //
    // 整笔重画的代价是可接受的：恒定浓度/粗细时 paintRuns 会把整笔合并成**一次** stroke() 调用；
    // 只有笔压让每段浓度都不同时才会退化成逐段 stroke()，而那种情况段数也被采样点数量限住。
    this.paintToScratch(e.sctx, stroke);
    // 蒙版笔迹要边拖边看得见：恢复成「落笔前」，再把整笔重画一次。
    // 累加着画是不行的 —— 同一笔叠上去会一遍比一遍浓。
    if (stroke.target === 'mask') {
      this.restoreMaskSnapshot(e.layer);
      this.applyStrokeToMask(e.layer, stroke);
    }
    this.invalidate();
  };

  CanvasEngine.prototype.endStroke = function (strokeId, seq) {
    var e = this.pending.get(strokeId);
    if (!e) return null;
    this.pending.delete(strokeId);
    var stroke = e.stroke;
    // 收笔时刻（回放用）。本地落笔和远端笔迹都走这里，
    // 所以两端都能拿到「这一笔持续了多久」。
    if (!stroke.te) stroke.te = Date.now();
    this.previewStroke = null;
    this.selectPreview = null;
    if (stroke.points.length === 0) {
      this.releaseScratch(e.scratch);
      this.clearOverlay();
      this.baseDirty = true; this.invalidate();
      return null;
    }
    if (stroke.target === 'mask') {
      // 蒙版笔迹只改蒙版，不碰图层像素。先把预览留下的痕迹清掉，再正式落一次。
      this.restoreMaskSnapshot(e.layer);
      this.applyStrokeToMask(e.layer, stroke);
      this.releaseScratch(e.scratch);
      layerCommit(e.layer);
      stroke.seq = seq || (++this.seq);
      this.seq = Math.max(this.seq, stroke.seq);
      this.strokes.push(stroke);
      this.byId.set(stroke.id, stroke);
      e.layer.strokes.push(stroke);
      this.baseDirty = true;
      this.markLayerThumb(e.layer);
      this.mirrorToView(e.layer, stroke);
      this.emit('strokeEnd', stroke);
      this.clearOverlay();
      this.invalidate();
      return stroke;
    }
    if (isTwoPoint(stroke) && stroke.points.length > 1) {
      stroke.points = [stroke.points[0], stroke.points[stroke.points.length - 1]];
      if (isGradient(stroke)) {
        this.applyGradient(e.layer, stroke);
      } else {
        this.paintToScratch(e.sctx, stroke);
        this.stampStroke(e.layer.ctx, e.layer, stroke, e.scratch);
      }
    } else if (isFill(stroke)) {
      this.applyFill(e.layer, stroke);
    } else if (isSelectTool(stroke)) {
      this.applySelectionStroke(stroke);
      // 选区笔不作为笔迹进入历史（它是本机状态）
      this.releaseScratch(e.scratch);
      layerCommit(e.layer);
      this.clearOverlay();
      this.emit('selection', { active: this.hasSelection() });
      this.invalidate();
      return null;
    } else if (isSmudge(stroke)) {
      this.applySmudge(e.layer, stroke, { canvas: e.scratch, ctx: e.sctx });
    } else if (isBlur(stroke)) {
      this.paintToScratch(e.sctx, stroke);
      applyBlurMaskedTo(e.layer.ctx, e.layer.canvas, e.scratch, stroke, this.width, this.height,
        this.takeScratch.bind(this), this.releaseScratch.bind(this));
    } else {
      this.paintToScratch(e.sctx, stroke);
      this.stampStroke(e.layer.ctx, e.layer, stroke, e.scratch);
    }
    this.releaseScratch(e.scratch);
    layerCommit(e.layer);
    stroke.seq = seq || (++this.seq);
    this.seq = Math.max(this.seq, stroke.seq);
    this.strokes.push(stroke);
    this.byId.set(stroke.id, stroke);
    e.layer.strokes.push(stroke);
    this.baseDirty = true;
    this.markLayerThumb(e.layer);
    this.mirrorToView(e.layer, stroke);
    this.emit('strokeEnd', stroke);
    this.clearOverlay();
    this.invalidate();
    return stroke;
  };

  /** 整笔（含对称副本 + 首尾端帽）完整画进蒙版 */
  CanvasEngine.prototype.paintToScratch = function (sctx, stroke) {
    clearCtx(sctx, this.width, this.height);
    if (isGradient(stroke) || isSmudge(stroke) || isSelectTool(stroke)) return;
    paintStrokeShape(sctx, stroke, stroke.points, 0, {
      width: this.width, height: this.height, startCap: true, noGrain: isBlur(stroke)
    });
    if (isShape(stroke) || stroke.scatter > 0) return;
    var copies = symmetryCopies(stroke, this.width, this.height);
    for (var i = 0; i < copies.length; i++) paintEndCap(sctx, stroke, stroke.points, copies[i]);
  };

  CanvasEngine.prototype.cancelStroke = function (strokeId) {
    var e = this.pending.get(strokeId);
    if (!e) return;
    this.pending.delete(strokeId);
    this.releaseScratch(e.scratch);
    this.previewStroke = null;
    this.selectPreview = null;
    this.clearOverlay();
    this.baseDirty = true;
    this.invalidate();
  };

  // 直接注入一笔已确认笔迹（历史同步 / 重做）
  CanvasEngine.prototype.addCommitted = function (stroke) {
    if (this.byId.has(stroke.id)) return null;
    var layer = this.getLayer(stroke.layerId) || this.layers[this.layers.length - 1];
    stroke.layerId = layer.id;
    if (stroke.seq && layer.baseSeq && stroke.seq <= layer.baseSeq) {
      this.seq = Math.max(this.seq, stroke.seq);
      return null;
    }
    if (stroke.points && stroke.points.length) {
      this.applyStrokeToLayer(layer, stroke);
      layerCommit(layer);
    }
    this.seq = Math.max(this.seq, stroke.seq || 0);
    this.strokes.push(stroke);
    this.byId.set(stroke.id, stroke);
    layer.strokes.push(stroke);
    this.markLayerThumb(layer);
    this.baseDirty = true;
    this.mirrorToView(layer, stroke);
    this.invalidate();
    return stroke;
  };

  CanvasEngine.prototype.applyStrokeToLayer = function (layer, stroke) {
    // 蒙版笔迹走另一条路。放在最前面：历史重放（撤销 / 清除 / 远端同步）
    // 全都汇到这一个出口，在这里分流就一处都不会漏。
    if (stroke.target === 'mask') { this.applyStrokeToMask(layer, stroke); return; }
    if (isFill(stroke)) { this.applyFill(layer, stroke); return; }
    // 渐变和涂抹以前漏在这里 —— 撤销重做（重放历史）时它们会消失，
    // 别人画过来的渐变也落不下来。补上之后重放才和「刚画完」一致。
    if (isGradient(stroke)) { this.applyGradient(layer, stroke); return; }
    if (isSmudge(stroke)) { this.applySmudge(layer, stroke, null); return; }
    if (isSelectStroke(stroke)) return;
    var sc = this.takeScratch();
    this.paintToScratch(sc.ctx, stroke);
    if (isBlur(stroke)) {
      applyBlurMaskedTo(layer.ctx, layer.canvas, sc.canvas, stroke, this.width, this.height,
        this.takeScratch.bind(this), this.releaseScratch.bind(this));
    } else {
      this.stampStroke(layer.ctx, layer, stroke, sc.canvas);
    }
    this.releaseScratch(sc.canvas);
  };

  /** 把「覆盖率蒙版」按笔刷属性叠加进目标（含保护不透明度、水彩边缘） */
  CanvasEngine.prototype.stampStroke = function (ctx, layer, stroke, scratchCanvas) {
    // 液化：按位移场重采样（覆盖受影响的区域），不走覆盖率蒙版
    if (isLiquify(stroke)) {
      applyLiquifyTo(ctx, this.width, this.height, ctx.canvas, stroke);
      return;
    }

    // 文字：直接画进图层，不走覆盖率蒙版那套
    if (isText(stroke)) {
      paintText(ctx, stroke);
      return;
    }

    var src = scratchCanvas;
    var lock = null;
    var byAlphaLock = !!(layer && layer.alphaLock && !isEraser(stroke) && !isSelectTool(stroke));
    var bySelection = this.hasSelection() && !isSelectTool(stroke);
    if (byAlphaLock || bySelection) {
      lock = this.takeScratch();
      clearCtx(lock.ctx, this.width, this.height);
      lock.ctx.drawImage(scratchCanvas, 0, 0);
      lock.ctx.globalCompositeOperation = 'destination-in';
      if (byAlphaLock) lock.ctx.drawImage(layer.canvas, 0, 0);
      if (bySelection) lock.ctx.drawImage(this.selection.canvas, 0, 0);
      lock.ctx.globalCompositeOperation = 'source-over';
      src = lock.canvas;
    }

    // 混色（SAI2 水彩笔那种「和下面的颜色融在一起」的手感）
    //
    // 先把**落笔之前**的图层像素留一份快照，画完再把这份快照按笔迹覆盖面、
    // 以 mix 的强度盖回去。设下层色 U、笔迹色 C：
    //   正常画完 → P = C
    //   把 U 以 alpha=m 盖上去 → R = (1-m)·C + m·U
    // 正好就是「按 m 把笔迹色和底色混合」。三次 canvas 合成搞定，没有逐像素 JS；
    // 快照取自落笔前，所以两端算出来完全一致。
    var mixSnap = null;
    if (stroke.mix > 0 && !isEraser(stroke) && !isSelectTool(stroke) && !isBlur(stroke) && !isSmudge(stroke)) {
      mixSnap = this.takeScratch();
      clearCtx(mixSnap.ctx, this.width, this.height);
      mixSnap.ctx.drawImage(ctx.canvas, 0, 0);
      mixSnap.ctx.globalCompositeOperation = 'destination-in';
      mixSnap.ctx.drawImage(src, 0, 0);          // 只有笔迹覆盖到的地方才需要混
      mixSnap.ctx.globalCompositeOperation = 'source-over';
    }

    paintOnto(ctx, stroke, src, 1, true);

    if (mixSnap) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = clamp(stroke.mix, 0, 1);
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.drawImage(mixSnap.canvas, 0, 0);
      ctx.restore();
      this.releaseScratch(mixSnap.canvas);
    }

    if (stroke.edge > 0 && !isEraser(stroke)) {
      var rim = this.buildRim(stroke);
      paintOnto(ctx, Object.assign({}, stroke, { blend: 'normal', hardness: 1 }),
        rim.canvas, clamp(stroke.edge * 0.62, 0, 0.85), false);
      this.releaseScratch(rim.canvas);
    }
    if (lock) this.releaseScratch(lock.canvas);
  };

  /** 水彩边缘：把笔迹外扩一圈后挖掉笔身，得到一圈「更浓的边」 */
  CanvasEngine.prototype.buildRim = function (stroke) {
    var mul = 1 + 0.34 * stroke.edge;
    var wide = this.takeScratch();
    var body = this.takeScratch();
    clearCtx(wide.ctx, this.width, this.height);
    clearCtx(body.ctx, this.width, this.height);
    paintStrokeShape(wide.ctx, stroke, stroke.points, 0, {
      width: this.width, height: this.height, startCap: true, widthMul: mul, noGrain: true
    });
    paintStrokeShape(body.ctx, stroke, stroke.points, 0, {
      width: this.width, height: this.height, startCap: true, noGrain: true
    });
    var copies = symmetryCopies(stroke, this.width, this.height);
    var fat = Object.assign({}, stroke, { size: stroke.size * mul });
    for (var i = 0; i < copies.length; i++) {
      paintEndCap(wide.ctx, fat, stroke.points, copies[i]);
      paintEndCap(body.ctx, stroke, stroke.points, copies[i]);
    }
    wide.ctx.globalCompositeOperation = 'destination-out';
    wide.ctx.drawImage(body.canvas, 0, 0);
    wide.ctx.globalCompositeOperation = 'source-over';
    this.releaseScratch(body.canvas);
    return wide;
  };

  CanvasEngine.prototype.removeStrokes = function (ids, silent) {
    var self = this;
    var set = new Set(ids);
    var touched = new Set();
    var removed = [];
    this.strokes = this.strokes.filter(function (s) {
      if (!set.has(s.id)) return true;
      removed.push(s);
      self.byId.delete(s.id);
      touched.add(s.layerId);
      return false;
    });
    if (!removed.length) return removed;
    removed.forEach(function (s) {
      var l = self.getLayer(s.layerId);
      if (l) {
        var i = l.strokes.indexOf(s);
        if (i >= 0) l.strokes.splice(i, 1);
      }
      var e = self.pending.get(s.id);
      if (e) { self.pending.delete(s.id); self.releaseScratch(e.scratch); }
    });
    touched.forEach(function (lid) { self.renderLayerFromHistory(self.getLayer(lid)); });
    this.baseDirty = true;
    if (!silent) this.emit('strokesRemoved', removed);
    this.invalidate();
    return removed;
  };

  CanvasEngine.prototype.renderLayerFromHistory = function (layer) {
    if (!layer) return;
    clearCtx(layer.ctx, this.width, this.height);
    if (layer.baseImage) layer.ctx.drawImage(layer.baseImage, 0, 0, this.width, this.height);
    for (var i = 0; i < layer.strokes.length; i++) {
      var s = layer.strokes[i];
      if (s.seq && layer.baseSeq && s.seq <= layer.baseSeq) continue;
      this.applyStrokeToLayer(layer, s);
    }
    // 蒙版也按同一份历史重建：蒙版笔迹混在 layer.strokes 里，
    // 上面循环里的 applyStrokeToLayer 会把它们分流进蒙版。
    this.rebuildMask(layer);
    layerCommit(layer);
    this.markLayerThumb(layer);
    // 历史被改写（撤销 / 清除 / 换底图）—— 显示用的那份必须整层重建
    if (this.dimOn()) this.rebuildView(layer);
  };

  /* ================================================================
   * 协作视图：别人的笔迹淡一点 / 直接藏起来（纯本机显示效果）
   * ================================================================ */

  CanvasEngine.prototype.dimOn = function () {
    // 全局档位是「原样」，但成员面板里单独给某个人设过 → 也算开着，
    // 否则「我只想把某一个人的笔迹藏起来」这件事在默认档位下根本不起作用。
    if (this.dimMode && this.dimMode !== 'off') return true;
    return !!(this.dimUsers && Object.keys(this.dimUsers).length);
  };

  /** 这一笔在本机显示时该用多少透明度（1 = 原样，0 = 根本不显示） */
  CanvasEngine.prototype.authorAlpha = function (stroke) {
    if (!this.dimOn() || !stroke) return 1;
    if (isDestructive(stroke) || isSelectStroke(stroke)) return 1;
    var who = stroke.userId;
    if (!who || !this.meId || who === this.meId) return 1;
    var per = this.dimUsers ? this.dimUsers[who] : null;
    if (per != null) return clamp(per, 0, 1);
    if (!this.dimMode || this.dimMode === 'off') return 1;   // 只有针对某个人的设置，全局是原样
    var lv = DIM_LEVELS[this.dimMode];
    return lv == null ? 1 : lv;
  };

  /** 影响显示的所有设置的指纹 —— 变了就得重建 baseComposite 缓存 */
  CanvasEngine.prototype.dimKey = function () {
    var ks = Object.keys(this.dimUsers || {}).sort();
    var s = this.dimMode + '|' + (this.meId || '');
    for (var i = 0; i < ks.length; i++) s += '|' + ks[i] + '=' + this.dimUsers[ks[i]];
    return s + '|' + Array.from(this.localHidden).sort().join(',');
  };

  /**
   * 「只对我隐藏」对**组**同样有效。
   * 传图层对象：它自己被隐藏、或者它所属的组被隐藏，都算。
   * 传 id 字符串：只查这一个 id（组行上直接用组 id 调它）。
   */
  CanvasEngine.prototype.isLocallyHidden = function (layer) {
    if (!layer) return false;
    if (typeof layer === 'string') return this.localHidden.has(layer);
    if (this.localHidden.has(layer.id)) return true;
    return !!(layer.groupId && this.localHidden.has(layer.groupId));
  };

  /** 显示用的那份图层画布（没有开协作视图时就是文档本身，零开销） */
  CanvasEngine.prototype.displayCanvas = function (layer) {
    if (!this.dimOn()) return layer.canvas;
    this.syncView(layer);
    return layer.viewCanvas || layer.canvas;
  };

  CanvasEngine.prototype.ensureView = function (layer) {
    if (!layer.viewCanvas || layer.viewCanvas.width !== this.width ||
        layer.viewCanvas.height !== this.height) {
      var c = mkCanvas(this.width, this.height, false);
      layer.viewCanvas = c.canvas;
      layer.viewCtx = c.ctx;
      layer.viewN = -1;
      layer.viewKill = true;
    }
    return layer.viewCtx;
  };

  /** 标成「显示那份作废」，下次合成时整层重建（变换 / 合并这类绕开笔迹流程的操作要调） */
  CanvasEngine.prototype.killView = function (layer) {
    if (!layer) return;
    layer.viewN = -1;
    layer.viewKill = true;
  };

  /**
   * 把一笔按「作者透明度」画进显示用的 viewCanvas。
   *
   * 实现上就是**把 layer.ctx / layer.canvas 临时换成 viewCanvas，再调一次
   * applyStrokeToLayer** —— 绘制代码一行都不用改，也就不会出现
   * 「文档一套算法、视图另一套算法」的偏差（橡皮、混色、选区裁剪、
   * 渐变、涂抹、文字这些全都自动跟着走）。
   *
   * 半透明的情况不能直接把目标画布整体调 alpha（那样别人的笔和我的笔一起变淡），
   * 要的是「这一笔本身淡」。做法：先在临时画布上按原样画一遍，再把它按 alpha
   * 混回 viewCanvas —— 于是橡皮这种「读目标画布」的笔也语义正确（等比例擦掉一点）。
   */
  CanvasEngine.prototype.applyStrokeToView = function (layer, stroke) {
    var a = this.authorAlpha(stroke);
    if (a <= 0) return;                    // 完全隐藏：这一笔当不存在
    var self = this;
    var oc = layer.ctx, ov = layer.canvas;
    var runOn = function (ctx, canvas) {
      layer.ctx = ctx; layer.canvas = canvas;
      try { self.applyStrokeToLayer(layer, stroke); }
      finally { layer.ctx = oc; layer.canvas = ov; }
    };
    if (a >= 1) { runOn(layer.viewCtx, layer.viewCanvas); return; }
    var tmp = this.takeScratch();
    clearCtx(tmp.ctx, this.width, this.height);
    tmp.ctx.drawImage(layer.viewCanvas, 0, 0);
    runOn(tmp.ctx, tmp.canvas);
    var vc = layer.viewCtx;
    vc.save();
    vc.setTransform(1, 0, 0, 1, 0, 0);
    vc.globalAlpha = a;
    vc.globalCompositeOperation = 'source-over';
    vc.filter = 'none';
    vc.drawImage(tmp.canvas, 0, 0);
    vc.restore();
    this.releaseScratch(tmp.canvas);
  };

  /** 刚提交完一笔：顺手往 viewCanvas 上补一笔（不用重放整层，几十笔的图层也不会卡） */
  CanvasEngine.prototype.mirrorToView = function (layer, stroke) {
    if (!this.dimOn() || !layer || !stroke) return;
    if (isSelectStroke(stroke)) return;
    this.ensureView(layer);
    this.applyStrokeToView(layer, stroke);
    layer.viewN = layer.strokes.length;
  };

  /** 整层重建 viewCanvas（设置变了 / 历史被改写过） */
  CanvasEngine.prototype.rebuildView = function (layer) {
    if (!layer) return;
    if (!this.dimOn()) {
      if (layer.viewCanvas) { layer.viewCanvas = null; layer.viewCtx = null; layer.viewN = -1; }
      return;
    }
    this.ensureView(layer);
    clearCtx(layer.viewCtx, this.width, this.height);
    if (layer.baseImage) layer.viewCtx.drawImage(layer.baseImage, 0, 0, this.width, this.height);
    layer.viewN = 0;
    layer.viewBaseSeq = layer.baseSeq || 0;
    layer.viewKill = false;
    for (var i = 0; i < layer.strokes.length; i++) {
      var s = layer.strokes[i];
      if (s.seq && layer.viewBaseSeq && s.seq <= layer.viewBaseSeq) continue;
      this.applyStrokeToView(layer, s);
    }
    layer.viewN = layer.strokes.length;
  };

  /** 需要时把 viewCanvas 补齐（只补新增的那几笔；作废了就整层重建） */
  CanvasEngine.prototype.syncView = function (layer) {
    if (!layer) return;
    if (!this.dimOn()) {
      if (layer.viewCanvas) { layer.viewCanvas = null; layer.viewCtx = null; layer.viewN = -1; layer.viewKill = false; }
      return;
    }
    var baseSeq = layer.baseSeq || 0;
    if (layer.viewKill || !layer.viewCanvas || layer.viewN < 0 ||
        layer.viewN > layer.strokes.length || layer.viewBaseSeq !== baseSeq) {
      this.rebuildView(layer);
      return;
    }
    if (layer.viewN === layer.strokes.length) return;
    for (var i = layer.viewN; i < layer.strokes.length; i++) {
      var s = layer.strokes[i];
      if (s.seq && baseSeq && s.seq <= baseSeq) continue;
      this.applyStrokeToView(layer, s);
    }
    layer.viewN = layer.strokes.length;
  };

  CanvasEngine.prototype.setDimMode = function (mode) {
    this.dimMode = DIM_LEVELS[mode] != null || mode === 'off' ? mode : 'off';
    if (!this.dimOn()) {
      this.layers.forEach(function (l) { l.viewCanvas = null; l.viewCtx = null; l.viewN = -1; l.viewKill = false; });
    } else {
      this.layers.forEach(this.killView.bind(this));
    }
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
  };

  CanvasEngine.prototype.setUserDim = function (userId, alpha) {
    if (!userId) return;
    if (alpha == null) delete this.dimUsers[userId];
    else this.dimUsers[userId] = clamp(alpha, 0, 1);
    if (this.dimOn()) this.layers.forEach(this.killView.bind(this));
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
  };

  CanvasEngine.prototype.setMeId = function (id) {
    if (this.meId === id) return;
    this.meId = id || null;
    if (this.dimOn()) this.layers.forEach(this.killView.bind(this));
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
  };

  CanvasEngine.prototype.setLocalHidden = function (layerId, on) {
    if (on) this.localHidden.add(layerId);
    else this.localHidden.delete(layerId);
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
    this.emit('layerVis', { layerId: layerId, localHidden: !!on });
  };

  CanvasEngine.prototype.toggleLocalHidden = function (layerId) {
    this.setLocalHidden(layerId, !this.localHidden.has(layerId));
    return this.localHidden.has(layerId);
  };

  CanvasEngine.prototype.clearLocalHidden = function () {
    if (!this.localHidden.size) return;
    this.localHidden.clear();
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
    this.emit('layerVis', {});
  };

  CanvasEngine.prototype.localHiddenCount = function () { return this.localHidden.size; };

  CanvasEngine.prototype.clearScope = function (scope, layerId) {
    var self = this;
    this.layers.forEach(function (l) {
      if (scope === 'all' || l.id === layerId) {
        l.baseImage = null; l.baseSeq = 0;
        l.strokes = [];
        clearCtx(l.ctx, self.width, self.height);
        l.thumb = null;
        self.killView(l);
        // 缩略图必须一起刷新：只把 thumb 置空的话，图层条上会一直挂着清除前的旧图，
        // 看上去就像「清除按钮没生效」。
        self.markLayerThumb(l);
      }
    });
    this.strokes = this.strokes.filter(function (s) {
      if (scope === 'all' || s.layerId === layerId) { self.byId.delete(s.id); return false; }
      return true;
    });
    this.baseDirty = true;
    this.baseKey = '';
    this.emit('layers', this.layerList());
    this.invalidate();
  };

  CanvasEngine.prototype.pruneHistory = function (upToSeq) {
    var self = this;
    var touched = new Set();
    this.strokes = this.strokes.filter(function (s) {
      if (s.seq <= upToSeq) { self.byId.delete(s.id); touched.add(s.layerId); return false; }
      return true;
    });
    touched.forEach(function (lid) {
      var l = self.getLayer(lid);
      if (l) l.strokes = l.strokes.filter(function (s) { return s.seq > upToSeq; });
    });
  };

  CanvasEngine.prototype.applyFill = function (layer, stroke) {
    var pt = stroke.points[0];
    if (!pt) return;
    var copies = symmetryCopies(stroke, this.width, this.height);
    var sel = this.hasSelection();
    // 有选区时：先填到临时层，再用选区裁一次，保证填色不越界
    var target = sel ? this.takeScratch() : { ctx: layer.ctx, canvas: layer.canvas };
    if (sel) clearCtx(target.ctx, this.width, this.height);

    for (var i = 0; i < copies.length; i++) {
      var q = mp(copies[i], pt[0], pt[1]);
      floodFill(target.ctx, this.width, this.height, Math.round(q[0]), Math.round(q[1]),
        stroke.color, stroke.tolerance, stroke.opacity, stroke.expand);
    }

    if (sel) {
      target.ctx.save();
      target.ctx.setTransform(1, 0, 0, 1, 0, 0);
      target.ctx.globalCompositeOperation = 'destination-in';
      target.ctx.drawImage(this.selection.canvas, 0, 0);
      target.ctx.globalCompositeOperation = 'source-over';
      target.ctx.restore();
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(target.canvas, 0, 0);
      layer.ctx.restore();
      this.releaseScratch(target.canvas);
    }
  };

  /* ---------------- 渐变 ---------------- */

  CanvasEngine.prototype.gradientStyle = function (stroke, ctx) {
    var pts = stroke.points;
    var a = pts[0], b = pts[pts.length - 1];
    var c = hexToRgb(stroke.color);
    var alpha = clamp(stroke.opacity == null ? 1 : stroke.opacity, 0.02, 1);
    var g;
    if (stroke.filled) {
      var r = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
      g = ctx.createRadialGradient(a[0], a[1], 0, a[0], a[1], r);
    } else {
      g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
    }
    g.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
    return g;
  };

  CanvasEngine.prototype.applyGradient = function (layer, stroke) {
    if (stroke.points.length < 2) return;
    var sel = this.hasSelection();
    var target = sel ? this.takeScratch() : { ctx: layer.ctx, canvas: layer.canvas };
    if (sel) clearCtx(target.ctx, this.width, this.height);

    target.ctx.save();
    target.ctx.setTransform(1, 0, 0, 1, 0, 0);
    target.ctx.globalAlpha = 1;
    target.ctx.globalCompositeOperation = blendOp(stroke.blend);
    target.ctx.fillStyle = this.gradientStyle(stroke, target.ctx);
    target.ctx.fillRect(0, 0, this.width, this.height);
    target.ctx.restore();

    if (sel) {
      target.ctx.save();
      target.ctx.setTransform(1, 0, 0, 1, 0, 0);
      target.ctx.globalCompositeOperation = 'destination-in';
      target.ctx.drawImage(this.selection.canvas, 0, 0);
      target.ctx.globalCompositeOperation = 'source-over';
      target.ctx.restore();
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(target.canvas, 0, 0);
      layer.ctx.restore();
      this.releaseScratch(target.canvas);
    }
  };

  /* ---------------- 涂抹 ---------------- */

  /* ================================================================
   * 液化（小型）
   *
   * 做法：落笔那一刻冻结一份图层像素，整笔按「位移场」重新采样。
   * 每个采样点把自己所在的小圆盘里的像素朝拖动方向推一把，权重按到圆心的
   * 距离平滑衰减；重采样时按 -位移 取值（等于把内容往前推）。
   *
   * 为什么可以跨端一致：结果是 (冻结快照, 笔迹点) 的**纯函数**——
   * 两端在落笔时的图层像素本来就一样，点也一样，所以算出来一样。
   * 这也是它敢在实时预览里反复重算的原因。
   * ================================================================ */

  function liquifyRadius(stroke) {
    return Math.max(4, (stroke.size || 60) * 0.5);
  }

  /** 位移场：返回 { x0,y0,w,h, dx, dy }（只在受影响的包围盒里分配） */
  function liquifyField(stroke) {
    var pts = stroke.points || [];
    if (pts.length < 2) return null;
    var rad = liquifyRadius(stroke);
    var strength = clamp(stroke.strength == null ? 0.6 : stroke.strength, 0.05, 1);
    var maxPush = rad * 0.5;               // 单步最多推这么远，防止一下子撕开

    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (var i = 0; i < pts.length; i++) {
      minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]);
      minY = Math.min(minY, pts[i][1]); maxY = Math.max(maxY, pts[i][1]);
    }
    // 再往外扩：圆盘半径 + 单步最大位移
    var pad = rad + maxPush + 2;
    var x0 = Math.floor(minX - pad), y0 = Math.floor(minY - pad);
    var x1 = Math.ceil(maxX + pad), y1 = Math.ceil(maxY + pad);
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || w * h > 40000000) return null;

    var dx = new Float32Array(w * h);
    var dy = new Float32Array(w * h);
    for (var k = 1; k < pts.length; k++) {
      var ax = pts[k - 1][0], ay = pts[k - 1][1];
      var bx = pts[k][0], by = pts[k][1];
      var mx = bx - ax, my = by - ay;
      var mlen = Math.hypot(mx, my);
      if (mlen < 1e-6) continue;
      // 一步推的位移就是这一步的移动量（乘强度），再夹到上限
      var pushX = mx * strength, pushY = my * strength;
      var plen = Math.hypot(pushX, pushY);
      if (plen > maxPush) { pushX = pushX / plen * maxPush; pushY = pushY / plen * maxPush; }
      var px0 = Math.max(0, Math.floor(bx - rad - x0));
      var py0 = Math.max(0, Math.floor(by - rad - y0));
      var px1 = Math.min(w - 1, Math.ceil(bx + rad - x0));
      var py1 = Math.min(h - 1, Math.ceil(by + rad - y0));
      for (var yy = py0; yy <= py1; yy++) {
        for (var xx = px0; xx <= px1; xx++) {
          var wx = x0 + xx, wy = y0 + yy;
          var d = Math.hypot(wx - bx, wy - by);
          if (d > rad) continue;
          // 平滑衰减：圆心 1，边缘 0（用 cos 曲线，比线性更「软」）
          var t = 1 - d / rad;
          var wgt = (1 - Math.cos(t * Math.PI)) / 2;
          var o = yy * w + xx;
          dx[o] += pushX * wgt;
          dy[o] += pushY * wgt;
        }
      }
    }
    return { x0: x0, y0: y0, w: w, h: h, dx: dx, dy: dy };
  }

  /** 按位移场把 src 重采样到一张新 canvas 上（只有 bbox 被改，其余照抄） */
  function liquifyResample(srcCanvas, field, W, H) {
    var out = mkCanvas(W, H, false);
    out.ctx.drawImage(srcCanvas, 0, 0);
    if (!field) return out;
    var x0 = field.x0, y0 = field.y0, w = field.w, h = field.h;
    var sx = Math.max(0, x0), sy = Math.max(0, y0);
    var ex = Math.min(W, x0 + w), ey = Math.min(H, y0 + h);
    var sw = ex - sx, sh = ey - sy;
    if (sw <= 0 || sh <= 0) return out;

    var srcCtx = srcCanvas.getContext('2d');
    var sImg = srcCtx.getImageData(sx, sy, sw, sh);
    var dImg = out.ctx.createImageData(sw, sh);
    var sd = sImg.data, dd = dImg.data;
    var dx = field.dx, dy = field.dy;

    // 双线性采样（越界就取最近的边界像素，避免出现黑边）
    function sample(fx, fy, out2) {
      if (fx < 0) fx = 0; else if (fx > sw - 1) fx = sw - 1;
      if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1;
      var ix = Math.floor(fx), iy = Math.floor(fy);
      var tx = fx - ix, ty = fy - iy;
      var ix1 = Math.min(sw - 1, ix + 1), iy1 = Math.min(sh - 1, iy + 1);
      var o00 = (iy * sw + ix) * 4, o10 = (iy * sw + ix1) * 4;
      var o01 = (iy1 * sw + ix) * 4, o11 = (iy1 * sw + ix1) * 4;
      for (var c = 0; c < 4; c++) {
        var top = sd[o00 + c] + (sd[o10 + c] - sd[o00 + c]) * tx;
        var bot = sd[o01 + c] + (sd[o11 + c] - sd[o01 + c]) * tx;
        out2[c] = top + (bot - top) * ty;
      }
    }

    var tmp = [0, 0, 0, 0];
    for (var y = 0; y < sh; y++) {
      for (var x = 0; x < sw; x++) {
        var gx = sx + x, gy = sy + y;
        var fi = (gy - y0) * w + (gx - x0);
        var offX = dx[fi], offY = dy[fi];
        var o = (y * sw + x) * 4;
        if (offX === 0 && offY === 0) {
          dd[o] = sd[o]; dd[o + 1] = sd[o + 1]; dd[o + 2] = sd[o + 2]; dd[o + 3] = sd[o + 3];
          continue;
        }
        // 取「来自后方」的像素 → 视觉上内容被推向前方
        sample(x - offX, y - offY, tmp);
        dd[o] = tmp[0]; dd[o + 1] = tmp[1]; dd[o + 2] = tmp[2]; dd[o + 3] = tmp[3];
      }
    }
    out.ctx.putImageData(dImg, sx, sy);
    return out;
  }

  /** 把液化结果写进 ctx（只覆盖受影响的包围盒，其余保持原样） */
  function applyLiquifyTo(ctx, W, H, layerCanvas, stroke) {
    if (stroke.points.length < 2) return;
    var field = liquifyField(stroke);
    if (!field) return;
    var frozen = stroke._frozen || layerCanvas;
    var disp = liquifyResample(frozen, field, W, H);
    var pad = 2;
    var bx = Math.max(0, field.x0 - pad);
    var by = Math.max(0, field.y0 - pad);
    var bw = Math.min(W, field.x0 + field.w + pad) - bx;
    var bh = Math.min(H, field.y0 + field.h + pad) - by;
    if (bw <= 0 || bh <= 0) return;
    // 覆盖受影响的包围盒：先原样清掉这一块，再把重采样结果铺上去。
    // 这里刻意不用 clearCtx —— 它会顺手把变换复位，和 clip 叠在一起容易出岔子；
    // 直接 clearRect 精确清这一块更直白。
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(bx, by, bw, bh);
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.drawImage(disp.canvas, 0, 0);   // mkCanvas 返回 { canvas, ctx }，不是 canvas 本身
    ctx.restore();
  }

  CanvasEngine.prototype.applySmudge = function (layer, stroke, sctx) {
    if (stroke.points.length < 2) return;
    var sc = sctx || this.takeScratch();
    var own = !sctx;
    var src = this.takeScratch();
    clearCtx(src.ctx, this.width, this.height);
    src.ctx.drawImage(layer.canvas, 0, 0);

    paintSmudge(sc.ctx, stroke, src.canvas, this.width, this.height,
      this.takeScratch.bind(this), this.releaseScratch.bind(this));

    var masked = sc.canvas;
    var lock = null;
    if (this.hasSelection()) {
      lock = this.takeScratch();
      clearCtx(lock.ctx, this.width, this.height);
      lock.ctx.drawImage(sc.canvas, 0, 0);
      lock.ctx.globalCompositeOperation = 'destination-in';
      lock.ctx.drawImage(this.selection.canvas, 0, 0);
      lock.ctx.globalCompositeOperation = 'source-over';
      masked = lock.canvas;
    }

    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.globalAlpha = clamp(stroke.opacity == null ? 1 : stroke.opacity, 0.02, 1);
    layer.ctx.globalCompositeOperation = 'source-over';
    layer.ctx.filter = 'none';
    layer.ctx.drawImage(masked, 0, 0);
    layer.ctx.restore();

    if (lock) this.releaseScratch(lock.canvas);
    this.releaseScratch(src.canvas);
    if (own) this.releaseScratch(sc.canvas);
  };

  /* ---------------- 选区（本机私有，不参与同步） ---------------- */

  CanvasEngine.prototype.ensureSelection = function () {
    if (!this.selection) {
      var c = mkCanvas(this.width, this.height, false);
      var t = mkCanvas(this.width, this.height, false);
      this.selection = { canvas: c.canvas, ctx: c.ctx, tint: t.canvas, tintCtx: t.ctx, active: false, bbox: null };
    }
    return this.selection;
  };

  CanvasEngine.prototype.hasSelection = function () {
    return !!(this.selection && this.selection.active);
  };

  /**
   * 一笔是否完全落在选区之外。
   * 有选区时落笔会被裁掉，画面看起来「什么都没发生」，用户会以为画布坏了。
   * app.js 用这个判断给一句明确提示。
   */
  CanvasEngine.prototype.strokeOutsideSelection = function (stroke) {
    if (!this.hasSelection() || !stroke || !stroke.points || !stroke.points.length) return false;
    var bb = this.selection.bbox || (this.refreshSelectionTint(), this.selection.bbox);
    if (!bb) return false;
    var pad = (stroke.size || 0) / 2 + 2;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < stroke.points.length; i++) {
      var p = stroke.points[i];
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    return x1 < bb.x || x0 > bb.x + bb.w || y1 < bb.y || y0 > bb.y + bb.h;
  };

  /** 选区蚂蚁线动画：只在「有选区」时跑，避免闲着空烧 CPU */
  CanvasEngine.prototype.selectionAnimate = function (on) {
    if (on === false || !this.hasSelection()) {
      if (this._antsTimer) { clearInterval(this._antsTimer); this._antsTimer = null; }
      return;
    }
    if (this._antsTimer) return;
    var self = this;
    this._antsTimer = setInterval(function () {
      if (!self.hasSelection()) {
        clearInterval(self._antsTimer);
        self._antsTimer = null;
        return;
      }
      self.selection.dashOffset = ((self.selection.dashOffset || 0) + 1) % 16;
      self.drawOverlay();
    }, 110);
  };

  /* ---------------- 图像变换（自由变换 / 缩放 / 扭曲 / 旋转） ---------------- */

  /**
   * 开始变换。
   * 有选区就只把选区内的像素「拿起来」，没有选区就把整个图层拿起来。
   * 拿起来的意思是：像素被搬到浮层上，图层上先挖掉那块 —— 这样预览里就是真的浮起来了，
   * 移动时不会在原位留一份；中止时再把 saved 还原回去。
   */
  CanvasEngine.prototype.beginTransform = function () {
    if (this.transform) return this.transform;
    var layer = this.activeLayer();
    if (!layer) return null;
    if (layer.locked) { this.emit('transformError', { message: '图层「' + layer.name + '」已锁定' }); return null; }

    var hasSel = this.hasSelection();
    var rect;
    if (hasSel) {
      var bb = this.selection.bbox || (this.refreshSelectionTint(), this.selection.bbox);
      if (!bb || bb.w < 1 || bb.h < 1) { this.emit('transformError', { message: '选区是空的' }); return null; }
      var x0 = Math.max(0, Math.floor(bb.x)), y0 = Math.max(0, Math.floor(bb.y));
      rect = {
        x: x0, y: y0,
        w: Math.max(1, Math.min(this.width - x0, Math.ceil(bb.w))),
        h: Math.max(1, Math.min(this.height - y0, Math.ceil(bb.h)))
      };
    } else {
      rect = { x: 0, y: 0, w: this.width, h: this.height };
    }

    var saved = mkCanvas(this.width, this.height, false);
    saved.ctx.drawImage(layer.canvas, 0, 0);

    // 浮层只保留选区那一块（尺寸 = rect），翻转 / 90° 旋转才会绕着选区自己的中心做，
    // 不会跑到选区外面去（见 transform.js 的 Session 注释）。
    var buf = mkCanvas(rect.w, rect.h, false);
    if (hasSel) {
      // 先整幅取像素，再用选区蒙版裁一次，最后裁到 rect —— 三步都不能少：
      // 直接把选区蒙版和图层一起画进小 canvas 会因为 offset 对不上而错位。
      var full = mkCanvas(this.width, this.height, false);
      full.ctx.drawImage(layer.canvas, 0, 0);
      full.ctx.globalCompositeOperation = 'destination-in';
      full.ctx.drawImage(this.selection.canvas, 0, 0);
      full.ctx.globalCompositeOperation = 'source-over';
      buf.ctx.drawImage(full.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(this.selection.canvas, 0, 0);
      layer.ctx.restore();
    } else {
      buf.ctx.drawImage(layer.canvas, 0, 0, rect.w, rect.h, 0, 0, rect.w, rect.h);
      clearCtx(layer.ctx, this.width, this.height);
    }
    layerCommit(layer);
    this.markLayerThumb(layer);
    this.killView(layer);

    this.transform = new global.ChaTransform.Session(this, {
      buf: buf.canvas, rect: rect, layerId: layer.id, saved: saved.canvas
    });
    this.baseDirty = true;
    this.drawOverlay();
    this.invalidate();
    this.emit('transform', { active: true });
    return this.transform;
  };

  /** 结束变换：commit=true 落盘，false 还原 */
  CanvasEngine.prototype.endTransform = function (commit) {
    var t = this.transform;
    if (!t) return null;
    this.transform = null;
    var layer = this.getLayer(t.layerId);
    var result = null;

    if (commit) {
      var composed = t.compose(layer ? layer.canvas : t.saved, this.width, this.height);
      result = {
        layerId: t.layerId,
        canvas: composed,
        png: composed.toDataURL('image/png'),
        upToSeq: this.seq
      };
      if (layer) this.applyTransformResult(t.layerId, composed);
    } else if (layer) {
      clearCtx(layer.ctx, this.width, this.height);
      layer.ctx.drawImage(t.saved, 0, 0);
      layerCommit(layer);
      this.markLayerThumb(layer);
      this.killView(layer);
    }

    this.baseDirty = true;
    this.baseKey = '';
    this.drawOverlay();
    this.invalidate();
    this.emit('transform', { active: false, committed: !!commit, result: result });
    return result;
  };

  /**
   * 变换结果落地：图层内容整体换成变换结果，该图层原有笔迹一并丢弃。
   * baseImage 直接放 canvas —— renderLayerFromHistory 用的是 drawImage，
   * canvas 和 Image 都能吃，这样不用等异步加载。
   */
  CanvasEngine.prototype.applyTransformResult = function (layerId, composed) {
    var self = this;
    var layer = this.getLayer(layerId);
    if (!layer) return;
    clearCtx(layer.ctx, this.width, this.height);
    layer.ctx.drawImage(composed, 0, 0);
    layer.baseImage = composed;
    layer.baseSeq = this.seq;
    layer.strokes = [];
    layerCommit(layer);
    this.markLayerThumb(layer);
    this.killView(layer);
    this.strokes = this.strokes.filter(function (s) {
      if (s.layerId === layerId) { self.byId.delete(s.id); return false; }
      return true;
    });
    this.baseDirty = true;
    this.baseKey = '';
    this.invalidate();
  };

  CanvasEngine.prototype.clearSelection = function () {
    if (!this.selection) return;
    this.selection.active = false;
    this.selection.bbox = null;
    clearCtx(this.selection.ctx, this.width, this.height);
    clearCtx(this.selection.tintCtx, this.width, this.height);
    this.emit('selection', { active: false });
    this.drawOverlay();
    this.invalidate();
  };

  /** 整体换掉选区蒙版（撤销 / 重做选区快照用）。src 为 null 表示清空选区。 */
  CanvasEngine.prototype.restoreSelection = function (src) {
    var s = this.ensureSelection();
    clearCtx(s.ctx, this.width, this.height);
    if (src) {
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalAlpha = 1;
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.drawImage(src, 0, 0);
      s.active = true;
    } else {
      s.active = false;
    }
    this.refreshSelectionTint();
    if (!s.bbox) { s.active = false; s.bbox = null; }   // 蒙版全空 → 等于没有选区
    this.drawOverlay();
    this.emit('selection', { active: this.hasSelection() });
    this.invalidate();
    return this.hasSelection();
  };

  CanvasEngine.prototype.selectAll = function () {    var s = this.ensureSelection();
    clearCtx(s.ctx, this.width, this.height);
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.fillStyle = '#ffffff';
    s.ctx.fillRect(0, 0, this.width, this.height);
    s.active = true;
    s.bbox = { x: 0, y: 0, w: this.width, h: this.height };
    this.refreshSelectionTint();
    this.drawOverlay();
    this.emit('selection', { active: true });
    this.invalidate();
  };

  /**
   * 选区合成模式：
   *   普通 / 魔棒 / 框选 / 套索 → 先清空再写入（替换）
   *   Shift → 加选，Alt → 减选，选区擦 → 减选
   */
  function selComposite(stroke) {
    if (stroke.tool === 'selectErase') return 'destination-out';
    if (stroke.subtract) return 'destination-out';
    if (stroke.add) return 'source-over';
    // 选区笔默认是「加」：涂一笔加一块，多笔累积成一块选区。
    //
    // 以前这里不分工具一律返回 'copy'（替换），而替换是拿**当前这一笔的**scratch
    // 去覆盖整张蒙版 —— 于是涂第二笔就把第一笔抹掉了，用户永远只能留下最后涂的那一笔，
    // 看起来就是「选区断成一段一段的」。用户的原话：「选区笔的意思是用选区笔画的部分进行选区」。
    if (!isRegionSelect(stroke)) return 'source-over';
    // 一次性工具（框选 / 套索 / 魔棒）保持替换语义：拖一个新框就是新选区
    return 'copy';
  }

  CanvasEngine.prototype.applySelectionStroke = function (stroke) {
    var s = this.ensureSelection();
    var mode = selComposite(stroke);

    if (isRegionSelect(stroke)) {
      if (mode === 'copy') clearCtx(s.ctx, this.width, this.height);
      s.ctx.save();
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalAlpha = 1;
      s.ctx.globalCompositeOperation = mode === 'copy' ? 'source-over' : mode;
      s.ctx.fillStyle = '#ffffff';
      this.paintSelectRegion(s.ctx, stroke);
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.restore();
    } else {
      var sel = Object.assign({}, stroke, {
        color: '#ffffff', opacity: 1, blend: 'normal', grain: 0, paper: 'none', edge: 0, scatter: 0
      });
      var sc = this.takeScratch();
      paintStrokeShape(sc.ctx, sel, sel.points, 0, {
        width: this.width, height: this.height, startCap: true, noGrain: true
      });
      if (sel.scatter === 0 && !isShape(sel)) {
        var copies = symmetryCopies(sel, this.width, this.height);
        for (var i = 0; i < copies.length; i++) paintEndCap(sc.ctx, sel, sel.points, copies[i]);
      }
      s.ctx.save();
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalAlpha = 1;
      s.ctx.globalCompositeOperation = mode;
      s.ctx.drawImage(sc.canvas, 0, 0);
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.restore();
      this.releaseScratch(sc.canvas);
    }

    s.active = true;
    this.refreshSelectionTint();
    if (!s.bbox) s.active = false;      // 全被减掉了 → 视为没有选区
    this.drawOverlay();
    this.invalidate();
  };

  /** 把一次性选区工具（框选 / 套索 / 魔棒）的结果填进给定 ctx */
  CanvasEngine.prototype.paintSelectRegion = function (ctx, stroke) {
    var pts = stroke.points || [];
    if (!pts.length) return;
    if (stroke.tool === 'marquee') {
      var a = pts[0], b = pts[pts.length - 1];
      var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      var w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (w < 1 || h < 1) return;
      ctx.fillRect(x, y, w, h);
      return;
    }
    if (stroke.tool === 'lasso') {
      if (pts.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (stroke.tool === 'wand') {
      var mask = this.wandMask(pts[0][0], pts[0][1], stroke.tolerance == null ? 32 : stroke.tolerance);
      if (mask) ctx.drawImage(mask, 0, 0);
    }
  };

  /**
   * 魔棒：从 (sx,sy) 出发，按色差在**合并后的画面**上做扫描线洪水填充，
   * 结果画成一张蒙版 canvas 返回（白 = 选中）。
   * 取样用合并画面而不是当前图层：用户点是「看到的颜色」，这样最符合直觉。
   */
  CanvasEngine.prototype.wandMask = function (sx, sy, tolerance) {
    var W = this.width, H = this.height;
    var x0 = Math.round(sx), y0 = Math.round(sy);
    if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return null;

    var doc = this.renderDocument({});
    var d = doc.ctx.getImageData(0, 0, W, H).data;
    var i0 = (y0 * W + x0) * 4;
    var r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
    var tol = Math.max(1, tolerance || 32);
    // 色差按「最大分量差」算，再留一点余量给半透明边缘
    var lim = tol * 2.55;

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d');
    var img = oc.createImageData(W, H);
    var od = img.data;
    var seen = new Uint8Array(W * H);

    function match(i) {
      if (d[i + 3] === 0 && a0 === 0) return true;
      var dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0, da = d[i + 3] - a0;
      var m = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db), Math.abs(da));
      return m <= lim;
    }

    var stack = [x0, y0];
    while (stack.length) {
      var cy = stack.pop(), cx = stack.pop();
      if (cy < 0 || cy >= H) continue;
      var row = cy * W;
      var xl = cx;
      while (xl >= 0 && !seen[row + xl] && match((row + xl) * 4)) xl--;
      xl++;
      var xr = cx;
      while (xr < W && !seen[row + xr] && match((row + xr) * 4)) xr++;
      xr--;
      if (xl > xr) continue;
      for (var x = xl; x <= xr; x++) {
        var p = row + x;
        seen[p] = 1;
        var o = p * 4;
        od[o] = 255; od[o + 1] = 255; od[o + 2] = 255; od[o + 3] = 255;
      }
      // 上下两行找种子
      for (var dy = -1; dy <= 1; dy += 2) {
        var ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        var nrow = ny * W;
        var inRun = false;
        for (var nx = xl; nx <= xr; nx++) {
          var np = nrow + nx;
          var ok = !seen[np] && match(np * 4);
          if (ok && !inRun) { stack.push(nx, ny); inRun = true; }
          else if (!ok) inRun = false;
        }
      }
    }
    oc.putImageData(img, 0, 0);
    // 魔棒选出来的是硬边 1-bit 蒙版，做一点点羽化外的「扩大」由 expand 参数控制，
    // 这里不做，保持和 SAI 一样的硬边选区。
    return out;
  };

  /** 把选区蒙版染色成半透明蓝（overlay 直接用，避免每帧读像素） */
  CanvasEngine.prototype.refreshSelectionTint = function () {
    var s = this.selection;
    if (!s) return;
    clearCtx(s.tintCtx, this.width, this.height);
    if (!s.active) { s.bbox = null; return; }
    s.tintCtx.setTransform(1, 0, 0, 1, 0, 0);
    s.tintCtx.drawImage(s.canvas, 0, 0);
    s.tintCtx.globalCompositeOperation = 'source-in';
    s.tintCtx.fillStyle = 'rgba(58,132,255,0.30)';
    s.tintCtx.fillRect(0, 0, this.width, this.height);
    s.tintCtx.globalCompositeOperation = 'source-over';
    s.bbox = this.selectionBBox();
  };

  /**
   * 求选区包围盒。
   * 先用 200px 缩略图粗定位，再在粗框附近按**原分辨率**精修 ——
   * 只扫缩略图的话误差有 width/200 像素（1600px 的画布就是 8px），
   * 而包围盒是「拿起来变换」的范围，偏大的话浮层里会带一圈空白边。
   */
  CanvasEngine.prototype.selectionBBox = function () {
    var s = this.selection;
    if (!s) return null;
    var W = this.width, H = this.height;
    var kW = Math.min(200, W), kH = Math.max(1, Math.round(kW * H / W));
    var c = document.createElement('canvas');
    c.width = kW; c.height = kH;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(s.canvas, 0, 0, kW, kH);
    var d;
    try { d = cx.getImageData(0, 0, kW, kH).data; } catch (e) { return null; }
    var kx0 = kW, ky0 = kH, kx1 = -1, ky1 = -1;
    for (var y = 0; y < kH; y++) {
      for (var x = 0; x < kW; x++) {
        if (d[(y * kW + x) * 4 + 3] > 8) {
          if (x < kx0) kx0 = x;
          if (x > kx1) kx1 = x;
          if (y < ky0) ky0 = y;
          if (y > ky1) ky1 = y;
        }
      }
    }
    if (kx1 < 0) return null;

    // 粗框按比例放大，再往外留一格，然后在这一块里按原分辨率扫
    var pad = Math.ceil(W / kW) + 2;
    var rx0 = Math.max(0, Math.floor(kx0 * W / kW) - pad);
    var ry0 = Math.max(0, Math.floor(ky0 * H / kH) - pad);
    var rx1 = Math.min(W, Math.ceil((kx1 + 1) * W / kW) + pad);
    var ry1 = Math.min(H, Math.ceil((ky1 + 1) * H / kH) + pad);
    var rw = rx1 - rx0, rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) return null;

    var md;
    try { md = s.ctx.getImageData(rx0, ry0, rw, rh).data; } catch (e) {
      // 精修拿不到（理论上不会），退回粗框
      return { x: kx0 * W / kW, y: ky0 * H / kH, w: (kx1 - kx0 + 1) * W / kW, h: (ky1 - ky0 + 1) * H / kH };
    }
    var fx0 = rw, fy0 = rh, fx1 = -1, fy1 = -1;
    for (var yy = 0; yy < rh; yy++) {
      var base = yy * rw * 4;
      for (var xx = 0; xx < rw; xx++) {
        if (md[base + xx * 4 + 3] > 8) {
          if (xx < fx0) fx0 = xx;
          if (xx > fx1) fx1 = xx;
          if (yy < fy0) fy0 = yy;
          if (yy > fy1) fy1 = yy;
        }
      }
    }
    if (fx1 < 0) return null;
    return { x: rx0 + fx0, y: ry0 + fy0, w: fx1 - fx0 + 1, h: fy1 - fy0 + 1 };
  };

  /* ---------------- scratch / 合成 ---------------- */

  CanvasEngine.prototype.takeScratch = function () {
    if (this.scratchPool.length) return this.scratchPool.pop();
    var c = mkCanvas(this.width, this.height, false);
    return { canvas: c.canvas, ctx: c.ctx };
  };
  CanvasEngine.prototype.releaseScratch = function (canvas) {
    if (!canvas) return;
    if (this.scratchPool.length >= SCRATCH_POOL_MAX) return;
    if (canvas.width !== this.width || canvas.height !== this.height) return;
    var ctx = canvas.getContext('2d');
    clearCtx(ctx, this.width, this.height);
    this.scratchPool.push({ canvas: canvas, ctx: ctx });
  };
  CanvasEngine.prototype.takeTmp = function () { return this.takeScratch(); };

  CanvasEngine.prototype.invalidate = function () {
    this.needsCompose = true;
    if (this._raf) return;
    var self = this;
    this._raf = global.requestAnimationFrame(function () {
      self._raf = null;
      self.compose();
    });
  };

  CanvasEngine.prototype.activeLayerIds = function () {
    var set = new Set();
    this.pending.forEach(function (e) { set.add(e.layer.id); });
    return set;
  };

  CanvasEngine.prototype.rebuildBase = function () {
    var active = this.replayMode ? new Set() : this.activeLayerIds();
    // 有进行中笔迹的**组**整组排除在基底之外，交给 compose() 连笔迹一起整组重画。
    // 只排掉那一层是不够的：组的不透明度 / 混合模式要作用在整组上，
    // 把组里单独一层画到基底上面，那一层就绕开了组的参数 ——
    // 组半透明时，手上那一笔会比周围浓。
    var activeGroups = this.replayMode ? new Set() : this.activeGroupIds();
    this.activeGroupsCache = activeGroups;
    // 缓存键里必须放**具体哪些**在画，而不只是「有几个」：
    // 笔数一样但换了一支笔时，只比数量的话缓存不会失效，画面就停在上一笔。
    var key = active.size + '|' + Array.from(active).sort().join(',') + '|' +
      this.width + 'x' + this.height + '|' + this.background + '|' +
      'dim:' + this.dimKey() + '|' +
      'g:' + this.groups.map(function (g) {
        return g.id + (g.visible ? '1' : '0') + g.opacity + g.blend;
      }).join(',') + '|' +
      this.layers.map(function (l) {
        return l.id + (l.visible ? '1' : '0') + l.opacity + l.blend + ':' +
          l.groupId + ':' +
          l.strokes.length + '/' + (l.baseSeq || 0) + '/' + (l.alphaLock ? 1 : 0);
      }).join(',');
    if (!this.baseDirty && key === this.baseKey && this.baseComposite) return;
    if (!this.baseComposite || this.baseComposite.width !== this.width ||
        this.baseComposite.height !== this.height) {
      var c = mkCanvas(this.width, this.height, false);
      this.baseComposite = c.canvas;
      this.baseCtx = c.ctx;
    }
    var ctx = this.baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.width, this.height);
    var units = this.renderUnits();
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      if (unit.group) {
        if (!unit.group.visible) continue;                    // 组隐藏 = 整组不画
        if (activeGroups.has(unit.group.id)) continue;        // 有笔在画 → 交给 compose
        var mem = this.drawableLayers(unit.layers);
        if (!mem.length) continue;
        this.composeGroup(ctx, unit.group, mem);
        continue;
      }
      var l = unit.layers[0];
      if (!this.layerDrawable(l) || active.has(l.id)) continue;
      this.drawLayerPixels(ctx, this.displayCanvas(l), l);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.baseDirty = false;
    this.baseKey = key;
    this.activeIdsCache = active;
  };

  /**
   * 把「图层 + 它的进行中笔迹」合成到 dstCtx。
   * dirty 不为空时，中间那张临时画布也只重画这一块 —— 否则每帧都要全画布 clear+drawImage，
   * 开销与画布面积成正比，画大一点墨迹就跟不上手。
   *
   * opts.raw：**要图层自身的像素，不要协作视图那层淡化**。
   * 导出 / 固化 / 导航器走的是这条路。历史上这里写死了 `displayCanvas`，
   * 于是「别人的笔迹淡一点」开着的时候，只要对方正好有一笔还没提交，
   * 导出出来的那一笔就是**淡的** —— 屏幕与成品不一致。（有 test-collab-view 守着）
   */
  CanvasEngine.prototype.composeLayer = function (dstCtx, tmpCtx, tmpCanvas, layer, opts) {
    var self = this;
    clearCtx(tmpCtx, this.width, this.height);
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    // 图层覆盖：滤镜预览用。设了就整层用它替代（那份像素里已经含未提交的笔迹），
    // 于是预览是**真的**在最终画面上预览，而不是另画一张小图糊弄。
    var ov = this.layerOverride;
    if (ov && ov.layerId === layer.id && ov.canvas) {
      tmpCtx.drawImage(ov.canvas, 0, 0);
      tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      tmpCtx.globalAlpha = 1; tmpCtx.globalCompositeOperation = 'source-over'; tmpCtx.filter = 'none';
      dstCtx.globalAlpha = layer.opacity;
      dstCtx.globalCompositeOperation = blendOp(layer.blend);
      dstCtx.drawImage(tmpCanvas, 0, 0);
      dstCtx.globalAlpha = 1;
      dstCtx.globalCompositeOperation = 'source-over';
      return;
    }
    tmpCtx.drawImage((opts && opts.raw) ? layer.canvas : this.displayCanvas(layer), 0, 0);
    this.pending.forEach(function (e) {
      if (e.layer !== layer) return;
      var s = e.stroke;
      // 蒙版笔迹不画在图层上 —— 它只该改蒙版，蒙版再由 applyMaskTo 统一套用
      if (s.target === 'mask') return;
      if (isText(s) || isLiquify(s)) { self.stampStroke(tmpCtx, layer, s, e.scratch); return; }
      if (isShape(s) || isFill(s)) return;   // 形状走 overlay，油漆桶已直接落到图层
      if (isBlur(s)) {
        applyBlurMaskedTo(tmpCtx, tmpCanvas, e.scratch, s, self.width, self.height,
          self.takeScratch.bind(self), self.releaseScratch.bind(self));
        return;
      }
      self.stampStroke(tmpCtx, layer, s, e.scratch);
    });
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    tmpCtx.globalAlpha = 1; tmpCtx.globalCompositeOperation = 'source-over'; tmpCtx.filter = 'none';
    this.applyMaskTo(tmpCtx, layer, opts);
    dstCtx.globalAlpha = layer.opacity;
    dstCtx.globalCompositeOperation = blendOp(layer.blend);
    dstCtx.drawImage(tmpCanvas, 0, 0);
    dstCtx.globalAlpha = 1;
    dstCtx.globalCompositeOperation = 'source-over';
  };

  CanvasEngine.prototype.applyViewTransform = function (ctx, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.tx, this.ty);
    if (this.rot) ctx.rotate(this.rot);
    if (this.flipX) ctx.scale(-1, 1);
    ctx.scale(this.scale, this.scale);
  };

  CanvasEngine.prototype.compose = function () {
    if (!this.viewCtx || this.composing) return;
    this.composing = true;
    try {
      var ctx = this.viewCtx;
      var dpr = this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      ctx.clearRect(0, 0, this.view.width, this.view.height);
      this.applyViewTransform(ctx, dpr);
      ctx.imageSmoothingEnabled = this.scale < 1;
      ctx.imageSmoothingQuality = 'high';

      if (this.replayMode && this.replayCanvas) {
        ctx.drawImage(this.replayCanvas, 0, 0);
        this.needsCompose = false;
        this.emit('composed', {});
        return;
      }

      this.rebuildBase();
      ctx.drawImage(this.baseComposite, 0, 0);

      var active = this.activeIdsCache || this.activeLayerIds();
      var activeGroups = this.activeGroupsCache || this.activeGroupIds();
      if (active.size) {
        var tmp = this.takeTmp();
        var units = this.renderUnits();
        for (var u = 0; u < units.length; u++) {
          var unit = units[u];
          if (unit.group) {
            // 不在基底里被整组跳过的组，说明现在没人在组里画
            if (!activeGroups.has(unit.group.id)) continue;
            if (!unit.group.visible) continue;
            var mem = this.drawableLayers(unit.layers);
            if (!mem.length) continue;
            this.composeGroup(ctx, unit.group, mem);
            continue;
          }
          var l = unit.layers[0];
          if (!active.has(l.id) || !this.layerDrawable(l)) continue;
          this.composeLayer(ctx, tmp.ctx, tmp.canvas, l);
        }
        this.releaseScratch(tmp.canvas);
      }
      this.needsCompose = false;
      this.emit('composed', {});
    } finally {
      this.composing = false;
    }
  };

  /** 完整渲染整份文档（导出 / 缩略图 / 吸管 / 图层合并） */
  CanvasEngine.prototype.renderDocument = function (opts) {
    opts = opts || {};
    var w = this.width, h = this.height;
    var out = mkCanvas(w, h, false);
    if (!opts.transparentBackground) {
      out.ctx.fillStyle = this.background;
      out.ctx.fillRect(0, 0, w, h);
    }
    var includeActive = opts.includeActive !== false;
    var tmp = mkCanvas(w, h, false);
    // 「只要一层」的调用（导出某层 / 合并 / 复制）不套组：它们要的是那一层自己的像素，
    // 把组的不透明度乘进来反而是错的。
    var useGroups = !opts.onlyLayer && !opts.rawLayer;
    var units = useGroups
      ? this.renderUnits()
      : this.layers.map(function (l) { return { group: null, layers: [l] }; });
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      if (unit.group) {
        if (!unit.group.visible) continue;
        var mem = unit.layers.filter(function (x) { return x.visible; });
        if (!mem.length) continue;
        this.renderGroupInto(out.ctx, unit.group, mem, tmp, includeActive);
        continue;
      }
      var l = unit.layers[0];
      if (opts.onlyLayer && opts.onlyLayer !== l.id) continue;
      if (!l.visible && !opts.onlyLayer) continue;
      // 图层覆盖（滤镜预览）这里也要认，否则会出现「画布上是预览效果、
      // 导出 / 导航器却还是原图」，两边对不上。
      // rawLayer（复制 / 合并用）要的是图层自身的真实像素，所以不套预览。
      var ovd = this.layerOverride;
      if (ovd && ovd.layerId === l.id && ovd.canvas && !opts.rawLayer) {
        out.ctx.globalAlpha = l.opacity;
        out.ctx.globalCompositeOperation = blendOp(l.blend);
        out.ctx.drawImage(ovd.canvas, 0, 0);
        out.ctx.globalAlpha = 1;
        out.ctx.globalCompositeOperation = 'source-over';
        continue;
      }
      if (includeActive && this.hasPendingOn(l)) {
        // raw：导出 / 固化 / 导航器要的是**成品像素**，不能带上「别人笔迹淡一点」那层
        // 只影响本机屏幕的效果。（有 test-collab-view 守着）
        this.composeLayer(out.ctx, tmp.ctx, tmp.canvas, l, { raw: true });
      } else if (opts.rawLayer) {
        // 合并/复制用：只要图层自身像素，不套用图层浓度与混合模式
        out.ctx.drawImage(l.canvas, 0, 0);
      } else {
        this.drawLayerPixels(out.ctx, l.canvas, l, opts);
      }
    }
    return out;
  };

  /**
   * renderDocument 里的「一组」：组内各层先落到一张临时画布（各套自己的浓度与混合模式），
   * 再整组按组自己的浓度 / 混合模式落下去 —— 和屏幕上的 composeGroup 是同一条规则。
   * 区别只在于这条路要的是**成品像素**，所以逐层都不带「别人笔迹淡一点」那层。
   */
  CanvasEngine.prototype.renderGroupInto = function (dstCtx, group, layers, tmp, includeActive) {
    var gs = this.takeScratch();
    var gctx = gs.ctx;
    clearCtx(gctx, this.width, this.height);
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.globalAlpha = 1; gctx.globalCompositeOperation = 'source-over'; gctx.filter = 'none';
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var ovd = this.layerOverride;
      if (ovd && ovd.layerId === l.id && ovd.canvas) {
        gctx.globalAlpha = l.opacity;
        gctx.globalCompositeOperation = blendOp(l.blend);
        gctx.drawImage(ovd.canvas, 0, 0);
        gctx.globalAlpha = 1; gctx.globalCompositeOperation = 'source-over';
        continue;
      }
      if (includeActive && this.hasPendingOn(l)) {
        this.composeLayer(gctx, tmp.ctx, tmp.canvas, l, { raw: true });
      } else {
        this.drawLayerPixels(gctx, l.canvas, l);
      }
    }
    dstCtx.globalAlpha = group.opacity;
    dstCtx.globalCompositeOperation = blendOp(group.blend);
    dstCtx.drawImage(gs.canvas, 0, 0);
    dstCtx.globalAlpha = 1;
    dstCtx.globalCompositeOperation = 'source-over';
    this.releaseScratch(gs.canvas);
  };

  /** 图层「原始像素」（含进行中笔迹，但不套用图层浓度与混合模式）——合并 / 复制用 */
  CanvasEngine.prototype.renderLayerRaw = function (layerId) {
    var layer = this.getLayer(layerId);
    if (!layer) return null;
    var self = this;
    var out = mkCanvas(this.width, this.height, false);
    out.ctx.drawImage(layer.canvas, 0, 0);
    this.pending.forEach(function (e) {
      if (e.layer !== layer) return;
      var s = e.stroke;
      if (isTwoPoint(s) || isFill(s) || isSmudge(s) || isSelectTool(s)) return;
      if (isBlur(s)) {
        applyBlurMaskedTo(out.ctx, out.canvas, e.scratch, s, self.width, self.height,
          self.takeScratch.bind(self), self.releaseScratch.bind(self));
        return;
      }
      self.stampStroke(out.ctx, layer, s, e.scratch);
    });
    return out.canvas;
  };

  /* ================================================================ 图层蒙版 */

  /** 取这一层「眼下生效」的蒙版画布；没有蒙版、或蒙版被关掉、或压根没建出来，都返回 null */
  CanvasEngine.prototype.layerMask = function (layer) {
    if (!layer || !layer.hasMask || layer.maskEnabled === false) return null;
    return layer.maskCanvas || null;
  };

  /** 拿到蒙版画布（没有就建一张全白的）。蒙版画布是懒建的：绝大多数图层一辈子用不上 */
  CanvasEngine.prototype.ensureMask = function (layer) {
    if (!layer) return null;
    if (!layer.maskCanvas || layer.maskCanvas.width !== this.width ||
        layer.maskCanvas.height !== this.height) {
      var c = mkCanvas(this.width, this.height, true);
      layer.maskCanvas = c.canvas;
      layer.maskCtx = c.ctx;
      layer.maskBase = null;
      layer.maskSnapshot = null;
      this.fillMaskWhite(layer);
    }
    return { canvas: layer.maskCanvas, ctx: layer.maskCtx };
  };

  CanvasEngine.prototype.fillMaskWhite = function (layer) {
    if (!layer || !layer.maskCtx) return;
    var ctx = layer.maskCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    clearCtx(ctx, this.width, this.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.width, this.height);
  };

  /** 丢掉蒙版（图层本身不动） */
  CanvasEngine.prototype.dropMask = function (layer) {
    if (!layer) return;
    // 蒙版没了，涂它的那几笔也就没有归宿了 —— 顺手从历史里清掉。
    // 不清的话它们会一直躺在 layer.strokes 里：等这层重新加一张蒙版、
    // 或者别人中途进来按历史重建蒙版时，这些旧笔迹会被重新涂上去，
    // 新蒙版一出生就缺一大块（看着像「蒙版自己坏了」）。
    // 先落 hasMask=false 再清笔迹：中间那次整层重绘不会去碰蒙版。
    layer.hasMask = false;
    var ids = [];
    for (var i = 0; i < layer.strokes.length; i++) {
      if (layer.strokes[i].target === 'mask') ids.push(layer.strokes[i].id);
    }
    if (ids.length) this.removeStrokes(ids, true);
    layer.maskCanvas = null;
    layer.maskCtx = null;
    layer.maskBase = null;
    layer.maskSnapshot = null;
    this.baseDirty = true; this.baseKey = '';
    this.invalidate();
  };

  /**
   * 按历史重建蒙版：底色（导入来的蒙版底图，或者全白）+ 重放本层的蒙版笔迹。
   * 撤销 / 清除 / 换底图 / 载入工程之后都走这里，保证「蒙版」和「图层」同源。
   */
  CanvasEngine.prototype.rebuildMask = function (layer) {
    if (!layer || !layer.hasMask) return;
    if (!layer.maskCanvas) this.ensureMask(layer);
    if (!layer.maskCtx) return;
    var ctx = layer.maskCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    clearCtx(ctx, this.width, this.height);
    if (layer.maskBase) {
      ctx.drawImage(layer.maskBase, 0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.width, this.height);
    }
    for (var i = 0; i < layer.strokes.length; i++) {
      var s = layer.strokes[i];
      if (s.target !== 'mask') continue;
      if (s.seq && layer.baseSeq && s.seq <= layer.baseSeq) continue;
      this.applyStrokeToMask(layer, s, true);
    }
    layer.maskSnapshot = null;
  };

  /** 把落笔前的蒙版副本贴回去（清掉预览留下的痕迹） */
  CanvasEngine.prototype.restoreMaskSnapshot = function (layer) {
    if (!layer || !layer.maskSnapshot || !layer.maskCtx) return;
    var ctx = layer.maskCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    clearCtx(ctx, this.width, this.height);
    ctx.drawImage(layer.maskSnapshot, 0, 0);
  };

  /**
   * 把一笔画到蒙版上。
   *
   * 语义跟 Photoshop 的图层蒙版一致：**黑色遮住、白色露出**。
   * 蒙版用 alpha 表示「显示多少」，所以：
   *   白笔 → 按笔迹覆盖率把 alpha 补回 1（露出）
   *   黑笔 → 按笔迹覆盖率把 alpha 抹成 0（遮住）
   * 笔迹本身的浓度（opacity）与软硬边都体现在覆盖率的 alpha 上，不用额外处理。
   */
  CanvasEngine.prototype.applyStrokeToMask = function (layer, stroke, silent) {
    var m = this.ensureMask(layer);
    if (!m) return;
    var sc = this.takeScratch();
    this.paintToScratch(sc.ctx, stroke);
    var ctx = m.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    if (lumOf(stroke.color) >= 0.5) {
      // 白：先按笔迹的 alpha 把 scratch 染成纯白，再叠上去（管你原来画的是什么颜色）
      var w = this.takeScratch();
      clearCtx(w.ctx, this.width, this.height);
      w.ctx.drawImage(sc.canvas, 0, 0);
      w.ctx.globalCompositeOperation = 'source-in';
      w.ctx.fillStyle = '#ffffff';
      w.ctx.fillRect(0, 0, this.width, this.height);
      w.ctx.globalCompositeOperation = 'source-over';
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(w.canvas, 0, 0);
      this.releaseScratch(w.canvas);
    } else {
      // 黑：按笔迹覆盖率把蒙版的 alpha 抹掉
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sc.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    this.releaseScratch(sc.canvas);
    if (!silent) { this.baseDirty = true; this.baseKey = ''; }
  };

  /** 蒙版来自像素（导入 / 固化）时的入口：dataUrl 传空串表示摘掉 */
  CanvasEngine.prototype.setMaskImage = function (layer, dataUrl) {
    var self = this;
    if (!layer) return;
    if (!dataUrl) {
      layer.maskBase = null;
      layer.hasMask = true;
      this.ensureMask(layer);
      this.rebuildMask(layer);
      this.baseDirty = true; this.baseKey = ''; this.invalidate();
      return;
    }
    layer.hasMask = true;
    this.ensureMask(layer);
    var img = new Image();
    img.onload = function () {
      layer.maskBase = img;
      self.rebuildMask(layer);
      self.baseDirty = true; self.baseKey = ''; self.invalidate();
    };
    img.src = dataUrl;
  };

  /** 把蒙版当作 alpha 套到已经画好的图层内容上 */
  CanvasEngine.prototype.applyMaskTo = function (ctx, layer, opts) {
    if (opts && (opts.rawLayer || opts.onlyLayer && opts.noMask)) return;
    var m = this.layerMask(layer);
    if (!m) return;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(m, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  };

  /**
   * 「把一层连蒙版一起画到 dstCtx」的唯一出口。
   * rebuildBase / renderDocument / renderGroupInto 三条路都走它 ——
   * 免得各写各的，出现「屏幕上套了蒙版、导出却没套」这种两边对不上的事。
   */
  CanvasEngine.prototype.drawLayerPixels = function (dstCtx, srcCanvas, layer, opts) {
    var m = (opts && opts.rawLayer) ? null : this.layerMask(layer);
    // 剪贴蒙版：只显示在**紧邻它下面那一层**的不透明区域里。
    // 不走「下方所有图层的累积」那套 —— 那要在四条渲染路径里各维护一份累积画布，
    // 代价和出错面都大得多；紧邻下层正是 SAI 的直觉，够用。
    var clipSrc = null;
    if (!(opts && opts.rawLayer) && layer.clip) {
      var ci = this.layers.indexOf(layer);
      var below = ci > 0 ? this.layers[ci - 1] : null;
      if (below && below.canvas && this.layerDrawable(below)) clipSrc = below.canvas;
    }
    if (!m && !clipSrc) {
      dstCtx.globalAlpha = layer.opacity;
      dstCtx.globalCompositeOperation = blendOp(layer.blend);
      dstCtx.drawImage(srcCanvas, 0, 0);
      dstCtx.globalAlpha = 1;
      dstCtx.globalCompositeOperation = 'source-over';
      return;
    }
    var t = this.takeScratch();
    clearCtx(t.ctx, this.width, this.height);
    t.ctx.globalAlpha = 1;
    t.ctx.globalCompositeOperation = 'source-over';
    t.ctx.drawImage(srcCanvas, 0, 0);
    t.ctx.globalCompositeOperation = 'destination-in';
    if (m) t.ctx.drawImage(m, 0, 0);
    if (clipSrc) t.ctx.drawImage(clipSrc, 0, 0);
    t.ctx.globalCompositeOperation = 'source-over';
    dstCtx.globalAlpha = layer.opacity;
    dstCtx.globalCompositeOperation = blendOp(layer.blend);
    dstCtx.drawImage(t.canvas, 0, 0);
    dstCtx.globalAlpha = 1;
    dstCtx.globalCompositeOperation = 'source-over';
    this.releaseScratch(t.canvas);
  };

  /** 图层原始像素（不含蒙版）—— PSD 导出要单独取蒙版通道，所以这里不套 */
  CanvasEngine.prototype.renderMaskPNG = function (layerId) {
    var layer = this.getLayer(layerId);
    if (!layer || !layer.maskCanvas) return null;
    var out = mkCanvas(this.width, this.height, false);
    out.ctx.drawImage(layer.maskCanvas, 0, 0);
    return out.canvas.toDataURL('image/png');
  };

  /**
   * 蒙版的灰度（PSD 的蒙版通道是 8 位灰度：0 = 全遮、255 = 全露）。
   * 茶绘的蒙版用 alpha 存同一件事，所以「取灰度」就是「取 alpha」。
   * 导出 PSD 时要这一份；蒙版不存在或没建出来就返回 null。
   */
  CanvasEngine.prototype.maskGray = function (layerId) {
    var layer = this.getLayer(layerId);
    if (!layer || !layer.hasMask || !layer.maskCanvas) return null;
    var w = this.width, h = this.height;
    var d = layer.maskCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    var out = new Uint8Array(w * h);
    for (var i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
    return out;
  };

  CanvasEngine.prototype.renderInto = function (ctx, opts) {
    var doc = this.renderDocument(opts || {});
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(doc.canvas, 0, 0);
    ctx.restore();
    return doc.canvas;
  };

  CanvasEngine.prototype.hasPendingOn = function (layer) {
    var yes = false;
    this.pending.forEach(function (e) { if (e.layer === layer) yes = true; });
    return yes;
  };

  CanvasEngine.prototype.exportPNG = function () {
    return this.renderDocument({}).canvas.toDataURL('image/png');
  };

  CanvasEngine.prototype.renderLayerPNG = function (layerId) {
    var out = this.renderDocument({ onlyLayer: layerId, transparentBackground: true });
    return out.canvas.toDataURL('image/png');
  };

  CanvasEngine.prototype.pickColor = function (x, y) {
    var doc = this.renderDocument({});
    var d = doc.ctx.getImageData(clamp(Math.round(x), 0, this.width - 1), clamp(Math.round(y), 0, this.height - 1), 1, 1).data;
    return rgbToHex(d[0], d[1], d[2]);
  };

  CanvasEngine.prototype.markLayerThumb = function (layer) {
    layer.thumbDirty = true;
    var self = this;
    if (this._thumbTimer) return;
    this._thumbTimer = setTimeout(function () {
      self._thumbTimer = null;
      self.layers.forEach(function (l) {
        if (!l.thumbDirty) return;
        l.thumbDirty = false;
        try {
          var c = document.createElement('canvas');
          c.width = 60; c.height = 38;
          var cx = c.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, 60, 38);
          cx.drawImage(l.canvas, 0, 0, 60, 38);
          l.thumb = c.toDataURL('image/png');
        } catch (e) { /* ignore */ }
      });
      self.emit('thumbs', self.layers);
    }, 700);
  };

  /* ---------------- 视口 ---------------- */

  CanvasEngine.prototype.fitView = function (padding) {
    var pad = padding == null ? 48 : padding;
    var vw = this.viewportW || 800, vh = this.viewportH || 600;
    var c = Math.abs(Math.cos(this.rot)), s = Math.abs(Math.sin(this.rot));
    var bw = this.width * c + this.height * s;
    var bh = this.width * s + this.height * c;
    var k = clamp(Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh), this.minScale, 1);
    this.scale = k;
    this.centerDoc(vw / 2, vh / 2, k);
    this.emit('viewport', { scale: k, rot: this.rot, flipX: this.flipX });
    this.invalidate();
  };

  /** 让文档中心落在指定的屏幕点上 */
  CanvasEngine.prototype.centerDoc = function (sx, sy, scale) {
    var s = scale == null ? this.scale : scale;
    var u = this.width / 2 * s, v = this.height / 2 * s;
    var X = this.flipX ? -u : u;
    var c = Math.cos(this.rot), sn = Math.sin(this.rot);
    this.tx = sx - (X * c - v * sn);
    this.ty = sy - (X * sn + v * c);
  };

  CanvasEngine.prototype.setZoom = function (s, cx, cy) {
    s = clamp(s, this.minScale, this.maxScale);
    if (cx == null) { cx = (this.viewportW || 0) / 2; cy = (this.viewportH || 0) / 2; }
    var d = this.screenToDoc(cx, cy);
    this.scale = s;
    var p = this.docToScreen(d.x, d.y);
    this.tx += cx - p.x;
    this.ty += cy - p.y;
    this.emit('viewport', { scale: s, rot: this.rot, flipX: this.flipX });
    this.invalidate();
  };

  CanvasEngine.prototype.setRotation = function (rad, skipEmit) {
    var cx = (this.viewportW || 0) / 2, cy = (this.viewportH || 0) / 2;
    var d = this.screenToDoc(cx, cy);
    this.rot = rad;
    var p = this.docToScreen(d.x, d.y);
    this.tx += cx - p.x;
    this.ty += cy - p.y;
    if (!skipEmit) this.emit('viewport', { scale: this.scale, rot: this.rot, flipX: this.flipX });
    this.invalidate();
  };

  CanvasEngine.prototype.rotateBy = function (deg) {
    this.setRotation(this.rot + deg * Math.PI / 180);
  };

  CanvasEngine.prototype.flipView = function () {
    var cx = (this.viewportW || 0) / 2, cy = (this.viewportH || 0) / 2;
    var d = this.screenToDoc(cx, cy);
    this.flipX = !this.flipX;
    var p = this.docToScreen(d.x, d.y);
    this.tx += cx - p.x;
    this.ty += cy - p.y;
    this.emit('viewport', { scale: this.scale, rot: this.rot, flipX: this.flipX });
    this.invalidate();
  };

  CanvasEngine.prototype.resetView = function () {
    this.rot = 0; this.flipX = false;
    this.fitView();
  };

  CanvasEngine.prototype.panBy = function (dx, dy) {
    this.tx += dx; this.ty += dy;
    this.invalidate();
  };

  CanvasEngine.prototype.panTo = function (docX, docY, sx, sy) {
    var p = this.docToScreen(docX, docY);
    this.tx += (sx == null ? (this.viewportW || 0) / 2 : sx) - p.x;
    this.ty += (sy == null ? (this.viewportH || 0) / 2 : sy) - p.y;
    this.invalidate();
  };

  CanvasEngine.prototype.docToScreen = function (x, y) {
    var s = this.scale;
    var X = x * s, Y = y * s;
    if (this.flipX) X = -X;
    var c = Math.cos(this.rot), sn = Math.sin(this.rot);
    return { x: X * c - Y * sn + this.tx, y: X * sn + Y * c + this.ty };
  };

  CanvasEngine.prototype.screenToDoc = function (px, py) {
    var X = px - this.tx, Y = py - this.ty;
    var c = Math.cos(this.rot), sn = Math.sin(this.rot);
    var u = X * c + Y * sn, v = -X * sn + Y * c;
    if (this.flipX) u = -u;
    return { x: u / this.scale, y: v / this.scale };
  };

  /** 当前视口在文档坐标下的包围盒（导航器画取景框用） */
  CanvasEngine.prototype.getVisibleRect = function () {
    var vw = this.viewportW || 0, vh = this.viewportH || 0;
    var a = this.screenToDoc(0, 0);
    var b = this.screenToDoc(vw, 0);
    var c = this.screenToDoc(0, vh);
    var d = this.screenToDoc(vw, vh);
    var x0 = Math.min(a.x, b.x, c.x, d.x), x1 = Math.max(a.x, b.x, c.x, d.x);
    var y0 = Math.min(a.y, b.y, c.y, d.y), y1 = Math.max(a.y, b.y, c.y, d.y);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  /** 生成整幅画的缩略图（导航器 / 概览用） */
  CanvasEngine.prototype.makeThumb = function (maxW, maxH) {
    var doc = this.renderDocument({});
    var k = Math.min(maxW / this.width, maxH / this.height);
    var w = Math.max(1, Math.round(this.width * k));
    var h = Math.max(1, Math.round(this.height * k));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(doc.canvas, 0, 0, w, h);
    return c;
  };

  /* ---------------- overlay（网格 / 形状预览 / 对称轴） ---------------- */

  CanvasEngine.prototype.clearOverlay = function () {
    this.previewStroke = null;
    this.selectPreview = null;
    if (!this.overlayCtx) return;
    var c = this.overlayCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.overlay.width, this.overlay.height);
  };

  CanvasEngine.prototype.drawOverlay = function () {
    if (!this.overlayCtx) return;
    var c = this.overlayCtx;
    var dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.filter = 'none';
    c.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.applyViewTransform(c, dpr);

    var W = this.width, H = this.height;

    // 画布边界不再描一圈线：白纸和外面的棋盘格已经把边界说清楚了，
    // 多这一圈框在画布上很碍眼（用户反馈）

    // 网格
    if (this.grid.on) {
      var g = this.grid.size;
      c.save();
      c.beginPath();
      c.rect(0, 0, W, H);
      c.clip();
      c.lineWidth = 1 / this.scale;
      c.strokeStyle = 'rgba(80,120,200,.20)';
      c.beginPath();
      for (var x = g; x < W; x += g) { c.moveTo(x, 0); c.lineTo(x, H); }
      for (var y = g; y < H; y += g) { c.moveTo(0, y); c.lineTo(W, y); }
      c.stroke();
      c.lineWidth = 1.4 / this.scale;
      c.strokeStyle = 'rgba(80,120,200,.35)';
      c.beginPath();
      c.moveTo(W / 2, 0); c.lineTo(W / 2, H);
      c.moveTo(0, H / 2); c.lineTo(W, H / 2);
      c.stroke();
      c.restore();
    }

    // 选区提示：半透明蓝 + 走动的虚线包围盒（蚂蚁线）
    // 变换中不画：那时选区的像素已经被「拿起来」了，再罩一层蓝色只会挡住变换预览
    if (this.hasSelection() && !this.replayMode && !this.transform) {
      if (!this.selection.bbox) this.refreshSelectionTint();
      c.globalAlpha = 1;
      c.drawImage(this.selection.tint, 0, 0);
      var bb = this.selection.bbox;
      if (bb) {
        c.save();
        c.setLineDash([6 / this.scale, 4 / this.scale]);
        c.lineDashOffset = -(this.selection.dashOffset || 0) / this.scale;
        // 先描一圈白底再叠黑虚线：不管底下是深是浅都看得见（SAI / PS 的老办法）
        c.lineWidth = 2.6 / this.scale;
        c.strokeStyle = 'rgba(255,255,255,.95)';
        c.strokeRect(bb.x, bb.y, bb.w, bb.h);
        c.lineWidth = 1.4 / this.scale;
        c.strokeStyle = 'rgba(20,24,32,.95)';
        c.strokeRect(bb.x, bb.y, bb.w, bb.h);
        c.restore();
      }
    }

    // 图像变换：浮层预览 + 变换框 + 手柄
    if (this.transform) {
      this.transform.drawOverlay(c);
    }

    // 尺子（含正在拖拽时的橡皮筋预览）
    if (this.rulerPreview && global.ChaRuler) {
      global.ChaRuler.draw(c, global.ChaRuler.make(this.rulerPreview.type, this.rulerPreview.p0, this.rulerPreview.p1), W, H, this.scale);
    }
    if (this.ruler && this.ruler.type && global.ChaRuler && this.showRuler !== false) {
      global.ChaRuler.draw(c, this.ruler, W, H, this.scale);
    }

    // 框选 / 套索的实时框
    var pv = this.selectPreview;
    if (pv && isRegionSelect(pv) && pv.points.length > 1) {
      c.save();
      c.setLineDash([6 / this.scale, 4 / this.scale]);
      c.lineWidth = 1.4 / this.scale;
      c.strokeStyle = 'rgba(255,255,255,.95)';
      c.beginPath();
      if (pv.tool === 'marquee') {
        var a = pv.points[0], b = pv.points[pv.points.length - 1];
        c.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      } else {
        c.moveTo(pv.points[0][0], pv.points[0][1]);
        for (var li = 1; li < pv.points.length; li++) c.lineTo(pv.points[li][0], pv.points[li][1]);
        c.closePath();
      }
      c.stroke();
      c.strokeStyle = 'rgba(20,24,32,.95)';
      c.setLineDash([6 / this.scale, 4 / this.scale]);
      c.lineDashOffset = 6 / this.scale;
      c.stroke();
      c.restore();
    }

    // 形状 / 渐变预览（只处理真正的形状与渐变 —— 选区预览走上面的 selectPreview）
    var s = this.previewStroke;
    if (s && (isShape(s) || isGradient(s)) && s.points.length > 1) {
      var copies = symmetryCopies(s, W, H);
      var p0 = s.points[0], p1 = s.points[s.points.length - 1];
      if (isGradient(s)) {
        c.globalAlpha = 1;
        c.lineWidth = Math.max(1.4 / this.scale, 2);
        c.strokeStyle = s.color;
        c.beginPath();
        c.moveTo(p0[0], p0[1]);
        c.lineTo(p1[0], p1[1]);
        c.stroke();
        var rr = Math.max(3 / this.scale, 4);
        c.beginPath(); c.arc(p0[0], p0[1], rr, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(p1[0], p1[1], rr, 0, Math.PI * 2); c.stroke();
      } else {
        c.globalAlpha = Math.max(0.25, s.opacity);
        c.strokeStyle = s.tool === 'eraser' ? '#e8544f' : s.color;
        c.lineWidth = Math.max(1 / this.scale, s.size);
        c.lineCap = 'round';
        c.lineJoin = 'round';
        if (s.hardness < 0.5) c.filter = 'blur(' + Math.min(12, blurPxOf(s)).toFixed(2) + 'px)';
        for (var ci = 0; ci < copies.length; ci++) {
          shapePath(c, s.tool, p0, p1, copies[ci]);
          if (s.filled && s.tool !== 'line') c.fill(); else c.stroke();
        }
        c.filter = 'none';
      }
      c.globalAlpha = 1;
    }
  };

  /* ---------------- 回放 ---------------- */

  /**
   * 一笔在时间轴上的时长。
   *   ① 真实值：begin 打的 ts → 收笔打的 te
   *   ② 兜底：到下一笔开始之前的空档
   *   ③ 再兜底：一个名义时长
   * 夹在 [120, 2600] 之间 —— 作者去泡了杯茶留下的长空档照搬，会让回放干等着不动。
   */
  var REPLAY_MIN_MS = 120;
  var REPLAY_MAX_MS = 2600;
  function replaySpanOf(s, nextTs) {
    var dur = 0;
    if (s.te && s.ts && s.te > s.ts) dur = s.te - s.ts;
    else if (nextTs && nextTs > (s.ts || 0)) dur = nextTs - s.ts;
    if (!dur) dur = 400;
    return Math.max(REPLAY_MIN_MS, Math.min(REPLAY_MAX_MS, dur));
  }

  /**
   * 排时间轴。返回笔数。
   *
   * `_roff` / `_rdur` = 这一笔在时间轴上的起跑点与时长，挂在笔迹对象上。
   * 关键一步是 `acc = max(真实起点, 上一笔的终点)`：两个人同时画时笔迹在时间上会重叠，
   * 而一块画布一帧只能画一笔 —— 重叠的按列表顺序串起来。列表顺序就是最终画面的
   * 叠放顺序（ts, seq 排序），所以**末帧一定等于成品**。
   */
  CanvasEngine.prototype.prepareReplay = function () {
    var need = !this.replayCanvas ||
      this.replayCanvas.width !== this.width || this.replayCanvas.height !== this.height;
    if (need) {
      var c = mkCanvas(this.width, this.height, false);
      this.replayCanvas = c.canvas;
      this.replayCtx = c.ctx;
    }
    if (!this.replayBaseCanvas || this.replayBaseCanvas.width !== this.width ||
        this.replayBaseCanvas.height !== this.height) {
      var b = mkCanvas(this.width, this.height, false);
      this.replayBaseCanvas = b.canvas;
      this.replayBaseCtx = b.ctx;
    }
    var src = this.strokes.slice().sort(function (a, b) {
      return (a.ts || 0) - (b.ts || 0) || (a.seq - b.seq);
    });
    var t0 = src.length ? (src[0].ts || 0) : 0;
    var acc = 0;
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      var next = i + 1 < src.length ? (src[i + 1].ts || 0) : 0;
      acc = Math.max(Math.max(0, (s.ts || t0) - t0), acc);
      s._roff = acc;
      s._rdur = replaySpanOf(s, next);
      acc += s._rdur;
    }
    this.replayStrokes = src;
    this.replayTotal = acc;
    this.replayReset();
    return this.replayStrokes.length;
  };

  /**
   * 回到起点：背景 + 各层底图铺好，一笔不剩。
   * 显示画布和「固化基底」两块的初始状态必须**逐像素一致** ——
   * 回放显示 = 基底 + 正在画的那一笔，基底错了整段回放都错。
   */
  CanvasEngine.prototype.replayReset = function () {
    if (!this.replayCtx || !this.replayBaseCtx) return;
    var targets = [this.replayCtx, this.replayBaseCtx];
    for (var t = 0; t < targets.length; t++) {
      var g = targets[t];
      clearCtx(g, this.width, this.height);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = this.background;
      g.fillRect(0, 0, this.width, this.height);
      for (var k = 0; k < this.layers.length; k++) {
        var bl = this.layers[k];
        if (bl.baseImage && this.layerDrawable(bl)) {
          g.drawImage(bl.baseImage, 0, 0, this.width, this.height);
        }
      }
    }
    this.replayCursor = 0;
    this.replayAt = 0;
    this._onionKey = '';        // 回到起点 = 残影缓存作废（prepareReplay 也走这里）
  };

  /** 把一笔画到目标画布（显示画布与固化基底共用这一条渲染路径） */
  CanvasEngine.prototype.replayStampOne = function (ctx, canvas, s) {
    if (isFill(s)) {
      var pt = s.points && s.points[0];
      if (pt) floodFill(ctx, this.width, this.height, Math.round(pt[0]), Math.round(pt[1]),
        s.color, s.tolerance, s.opacity, s.expand);
      return;
    }
    var sc = this.takeScratch();
    this.paintToScratch(sc.ctx, s);
    if (isBlur(s)) {
      applyBlurMaskedTo(ctx, canvas, sc.canvas, s, this.width, this.height,
        this.takeScratch.bind(this), this.releaseScratch.bind(this));
    } else {
      this.stampStroke(ctx, null, s, sc.canvas);
    }
    this.releaseScratch(sc.canvas);
  };

  /** 把 [cursor, upTo) 这些「已经播完」的笔固化到基底上 */
  CanvasEngine.prototype.replayCommit = function (upTo) {
    if (!this.replayBaseCtx) return;
    var vis = this.visibleMap();
    for (var i = this.replayCursor; i < upTo; i++) {
      var s = this.replayStrokes[i];
      if (!s) continue;
      if (vis[s.layerId] === false) continue;
      this.replayStampOne(this.replayBaseCtx, this.replayBaseCanvas, s);
    }
    this.replayCursor = Math.max(this.replayCursor, upTo);
  };

  /**
   * 显示 = 基底 + 「正在画的那一笔」的前 k 个落点。
   * 每帧只是一次整幅 drawImage + 一笔的部分重绘，**帧率与总笔数无关**。
   * 部分重绘必须画在基底副本上、而不是叠在上一帧上 —— 否则同一笔会被反复叠加越来越深。
   *
   * 洋葱皮开着时再多两小组残影：**刚画完的几笔**（暖色）压在正在画的那一笔下面，
   * **马上要画的几笔**（冷色）盖在最上面。残影是纯显示的，不进基底、不进文档。
   */
  CanvasEngine.prototype.replayShow = function (s, k) {
    var ctx = this.replayCtx;
    if (!ctx || !this.replayBaseCanvas) return;
    var vis = this.visibleMap();
    if (s && vis[s.layerId] === false) s = null;

    // 一起算残影：`s` 就是「正在画的那一笔」，为 null 说明此刻落在两笔之间的停顿里
    var onion = !!(this.onion.on && this.replayStrokes && this.replayStrokes.length);
    if (onion) this.replayOnionPrep(this.replayCursor, !!s, vis);

    clearCtx(ctx, this.width, this.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.replayBaseCanvas, 0, 0);
    if (onion) this.replayOnionDraw(ctx, true);

    if (s) {
      var np = (s.points && s.points.length) || 0;
      if (k >= np) {
        this.replayStampOne(ctx, this.replayCanvas, s);
      } else {
        // 截短落点的副本；**原笔迹一个字段都不动**（末帧与导出还要用它）
        var part = Object.assign({}, s);
        part.points = s.points.slice(0, Math.max(1, k));
        this.replayStampOne(ctx, this.replayCanvas, part);
      }
    }
    if (onion) this.replayOnionDraw(ctx, false);
  };

  /* ---------------- 洋葱皮 ---------------- */

  /**
   * 残影配色：前一暖后一冷，跟动画软件的约定一致（红=已有，青=将画）。
   * 浓度按「离当前笔多远」递减 —— 最远那一笔已经很淡了。
   */
  var ONION_WARM = '#ff3b30';
  var ONION_COOL = '#00a8ff';
  var ONION_WARM_ALPHA = 0.42;
  var ONION_COOL_ALPHA = 0.30;
  var ONION_FADE = [1, 0.6, 0.36];

  /**
   * 这一笔能不能做残影。排除的几类都有硬理由，不是挑肥拣瘦：
   *   · 油漆桶：在**透明**画布上从一点灌水会把整张画布灌满 → 残影变成一块全屏色块
   *   · 模糊 / 涂抹 / 液化：读的是「目标像素」，透明底上读不到东西，画了等于没画
   *   · 选区：只有蚂蚁线，没有墨迹
   */
  function onionGhostable(s) {
    return !isFill(s) && !isBlur(s) && !isSmudge(s) && !isLiquify(s) &&
      !isSelectTool(s) && !isRegionSelect(s);
  }

  /**
   * 把 `idx` 里这几笔的**墨迹本身**染成一种颜色，放到一张透明画布上。
   * `idx` 是笔迹索引，**近 → 远**排好（最近的那笔在最前，浓度也最高）。
   *
   * 为什么不直接把「那一刻的整幅画面」当残影：回放画面是不透明的（铺了背景），
   * 把上一帧整幅叠上来只会把整张图压暗，看不出「哪几笔是刚出现的」——
   * 所以残影只包含**这几笔自己**。
   *
   * 染色走 source-atop：只作用在已有像素上。于是残影的形状就是笔迹的形状而不是一块色块，
   * 笔迹半透明的边缘也原样保留。
   */
  CanvasEngine.prototype.buildOnion = function (idx, vis, tint) {
    if (!idx || !idx.length) return null;
    if (!this.onionTmp || this.onionTmp.width !== this.width || this.onionTmp.height !== this.height) {
      this.onionTmp = mkCanvas(this.width, this.height, false).canvas;
    }
    var tmp = this.onionTmp;
    var tctx = tmp.getContext('2d');
    var group = mkCanvas(this.width, this.height, false);
    var gctx = group.ctx;
    var any = false;
    // idx 是**近 → 远**排好的，但要从远往近画（近的压在上面）。
    // 浓淡也按同一份顺序取：最近那笔最浓，越远越淡。
    for (var d = idx.length - 1; d >= 0; d--) {
      var s = this.replayStrokes[idx[d]];
      if (!s || vis[s.layerId] === false || !onionGhostable(s)) continue;
      clearCtx(tctx, this.width, this.height);
      this.replayStampOne(tctx, tmp, s);
      // 浓淡只能靠**合成这一下**给：paintOnto 内部把 globalAlpha 重置成了 1，
      // 所以在 replayStampOne 之前设 globalAlpha 是白设 —— 这是这一段的坑。
      gctx.save();
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.globalAlpha = ONION_FADE[Math.min(d, ONION_FADE.length - 1)];
      gctx.globalCompositeOperation = 'source-over';
      gctx.filter = 'none';
      gctx.drawImage(tmp, 0, 0);
      gctx.restore();
      any = true;
    }
    if (!any) return null;
    gctx.save();
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.globalAlpha = 1;
    gctx.globalCompositeOperation = 'source-atop';
    gctx.fillStyle = tint;
    gctx.fillRect(0, 0, this.width, this.height);
    gctx.restore();
    return group.canvas;
  };

  /**
   * 备好两组残影画布。**只在「当前笔」变了之后才重建** ——
   * 一笔画的过程中残影是固定的（前影=已播完的笔，后影=还没开画的笔），
   * 每帧重建等于每帧重画好几整笔，帧率就没了。
   *
   * `playing` 决定「后影从哪一笔开始数」：正在画的那一笔不该算进「马上要画」里。
   */
  CanvasEngine.prototype.replayOnionPrep = function (base, playing, vis) {
    var before = this.onion.before, after = this.onion.after;
    var visKey = '';
    for (var v = 0; v < this.groups.length; v++) {
      visKey += this.groups[v].visible ? '1' : '0' + this.groups[v].id;
    }
    for (var w = 0; w < this.layers.length; w++) visKey += this.layers[w].visible ? '1' : '0';
    var key = base + '|' + (playing ? 1 : 0) + '|' + before + '|' + after + '|' + visKey;
    if (key === this._onionKey) return;
    this._onionKey = key;
    var n = this.replayStrokes.length;
    // 两组都按**近 → 远**排好再交出去：浓淡就是照这份顺序递减的，最近那笔最清楚。
    // 「近」的定义：前影里离当前笔最近的是 base-1；后影里最近的是 coolFrom 自己。
    // 做不了残影的笔（油漆桶 / 模糊…）在**这里**就剔掉，别让它占掉一档浓度。
    var warm = [], cool = [];
    for (var i = 1; i <= before && base - i >= 0; i++) {
      var sw = this.replayStrokes[base - i];
      if (sw && vis[sw.layerId] !== false && onionGhostable(sw)) warm.push(base - i);
    }
    var coolFrom = base + (playing ? 1 : 0);
    for (var j = 0; j < after && coolFrom + j < n; j++) {
      var sc = this.replayStrokes[coolFrom + j];
      if (sc && vis[sc.layerId] !== false && onionGhostable(sc)) cool.push(coolFrom + j);
    }
    this.onionWarm = this.buildOnion(warm, vis, ONION_WARM);
    this.onionCool = this.buildOnion(cool, vis, ONION_COOL);
  };

  CanvasEngine.prototype.replayOnionDraw = function (ctx, warm) {
    var cv = warm ? this.onionWarm : this.onionCool;
    if (!cv) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = warm ? ONION_WARM_ALPHA : ONION_COOL_ALPHA;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.drawImage(cv, 0, 0);
    ctx.restore();
  };

  /**
   * 开关洋葱皮。开着的时候要**立刻**把当前这一帧重画出来，否则要等下一次 seek 才看得到，
   * 用户点完按钮会觉得没反应。`replaySeek(当前时刻)` 是幂等的，重进一次是安全的。
   */
  CanvasEngine.prototype.setOnion = function (opts) {
    opts = opts || {};
    if (opts.on !== undefined) this.onion.on = !!opts.on;
    var b = Math.round(Number(opts.before));
    if (isFinite(b)) this.onion.before = clamp(b, 0, 3);
    var a = Math.round(Number(opts.after));
    if (isFinite(a)) this.onion.after = clamp(a, 0, 3);
    this._onionKey = '';
    if (this.replayMode) this.replaySeek(this.replayAt || 0);
    else this.invalidate();
    this.emit('onion', { on: this.onion.on, before: this.onion.before, after: this.onion.after });
    return this.onion;
  };

  CanvasEngine.prototype.onionOn = function () { return !!this.onion.on; };
  CanvasEngine.prototype.onionState = function () {
    return { on: this.onion.on, before: this.onion.before, after: this.onion.after };
  };

  /** 按**索引**整笔推进（保留给旧调用方；内部照旧走基底 + 显示这条路） */
  CanvasEngine.prototype.replayDrawUpTo = function (index) {
    if (!this.replayStrokes) return;
    if (index < this.replayCursor) this.replayReset();
    var n = this.replayStrokes.length;
    var upTo = Math.max(0, Math.min(index, n));
    this.replayCommit(upTo);
    this.replayAt = upTo >= n ? this.replayTotal : this.replayStrokes[upTo]._roff;
    this.replayShow(null, 0);
    this.invalidate();
  };

  /**
   * 定位到时间轴第 t 毫秒。
   * 往前推进是增量的；往回退则整条重建（拖进度条才会发生，一笔一笔重画代价可控）。
   */
  CanvasEngine.prototype.replaySeek = function (t) {
    if (!this.replayStrokes || !this.replayStrokes.length) return 0;
    if (t < this.replayAt) this.replayReset();
    var n = this.replayStrokes.length;
    var i = Math.max(0, this.replayCursor);
    while (i < n && t >= this.replayStrokes[i]._roff + this.replayStrokes[i]._rdur) i++;
    this.replayCommit(i);
    var s = this.replayStrokes[i];
    var k = 0, playing = false;
    if (s && t >= s._roff) {
      playing = true;
      var np = (s.points && s.points.length) || 1;
      k = Math.max(1, Math.round(np * Math.min(1, (t - s._roff) / s._rdur)));
    }
    this.replayShow(playing ? s : null, k);
    this.replayAt = t;
    this.invalidate();
    return i;
  };

  CanvasEngine.prototype.replayDuration = function () {
    if (!this.replayStrokes || !this.replayStrokes.length) return 0;
    return Math.max(1000, (this.replayTotal || 0) + 600);
  };

  /**
   * 把「此刻的回放画面」画到任意 ctx —— 导出回放视频用。
   * 注意 `renderInto` 画的是**成品文档**，回放画布只在屏幕合成里用；
   * 想录下「过程」就必须走这里，否则录出来是一张静止的完成图。
   */
  CanvasEngine.prototype.replayInto = function (ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (this.replayCanvas) ctx.drawImage(this.replayCanvas, 0, 0, this.width, this.height);
    ctx.restore();
    return this.replayCanvas;
  };

  /**
   * 此刻正在「画」的那一笔（回放条上标作者用）。
   * 落在两笔之间的停顿里就返回 null —— 那段时间画面本来就不动，标谁都不对。
   * `replaySeek` 把已播完的都固化进 base 了，所以游标位置就是正在画的那一笔，O(1)。
   */
  CanvasEngine.prototype.replayCurrent = function () {
    var s = this.replayStrokes && this.replayStrokes[this.replayCursor];
    if (!s) return null;
    var t = this.replayAt;
    if (t < s._roff || t >= s._roff + s._rdur) return null;
    return { index: this.replayCursor, stroke: s };
  };

  CanvasEngine.prototype.setReplayMode = function (on) {
    this.replayMode = !!on;
    if (on) this.prepareReplay();
    this.baseDirty = true;
    this.baseKey = '';
    this.emit('replayMode', !!on);
    this.invalidate();
  };

  /* ---------------- 静态资源 ---------------- */

  CanvasEngine.SWATCHES = [
    '#000000', '#3b3b3b', '#6b6b6b', '#9a9a9a', '#c9c9c9', '#ffffff',
    '#8c3b2e', '#c0392b', '#ec4141', '#f0685f', '#f4a08c', '#f6d3b0',
    '#7a5c1e', '#b8860b', '#e8b923', '#f2da63', '#fbf0b3', '#fff8d6',
    '#1f5c3a', '#2e8b57', '#4caf74', '#8fd39a', '#bfe6c5', '#e6f5e9',
    '#14507a', '#2a7fb8', '#3c9fe0', '#7cc3ea', '#b3dcf3', '#e3f2fb',
    '#3b2c6b', '#5b4bb8', '#7d6be0', '#a99cec', '#cdc5f5', '#ece9fb',
    '#6b1e46', '#b03070', '#e05a9c', '#f091bd', '#f8c3da', '#fce4ef'
  ];

  CanvasEngine.SIZE_PRESETS = [2, 5, 10, 20, 40];
  CanvasEngine.hexToRgb = hexToRgb;
  CanvasEngine.rgbToHex = rgbToHex;
  CanvasEngine.blendOp = blendOp;

  global.CanvasEngine = CanvasEngine;
  global.ChaEngineUtils = {
    floodFill: floodFill,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    clamp: clamp
  };
})(window);
