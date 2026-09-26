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
 *   为支持「笔压→浓度」，笔迹在蒙版内按浓度**粗分档**（带滞回，避免把线切碎）绘制：
 *   每档内把笔身描成一条**逐点变宽的多边形**（宽度连续插值，没有阶梯），
 *   只在整笔首尾补半圆端帽 —— 既不产生接缝叠加，又保留圆润的起笔收笔。
 *   ⚠ 宽度**不能**量化成固定段宽、浓度**不能**按 1/24 档切碎，两者都会让笔身出现
 *     周期性粗细节（详见 paintRuns 注释）。
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;

  var SCRATCH_POOL_MAX = 10;
  var ALPHA_STEPS = 24;   // 浓度量化级数（越大越平滑，分段越多）
  // 浓度「换档滞回」：只有量化值跨过 ≥2 档才算真的变了。
  // 为什么需要它 —— 见 paintRuns 头部注释：真实笔压下 alpha 会在量化边界上
  // **每 1~2 个点来回跳**（例如 inking：pressOpacity 只有 0.15，alpha 实际在
  // 0.965~0.991 之间，量化后只有 23/24 和 24/24 两个值，却沿线跳了 65 次）。
  // 若按「不等就切一刀」分段，一条 120 点的线会被切成 65 段、每段只有 1~2 点
  // （≈ 6~12px）—— 在 ~25px 宽的大笔上就是一堆**平头小方块**，接缝处掉一列像素，
  // 视觉上就是「顿感」。而这 2 档之间的差别只有 4% 不透明度，**根本看不见**。
  // 所以：看不见的档位差，不值得为它切断几何。
  var ALPHA_HYST = 2;

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
   * 颗粒纹理：「孔洞」不再把像素挖到全透（那会把细线打碎，用户反馈「纸纹影响
   * 笔刷使用」），而是保留一层低 alpha —— 纹理观感还在，线条连续。
   * 蒙版每笔都是 clearCtx 后整笔重画（paintToScratch / 各 redraw 路径），
   * applyGrain 只跑一次，所以孔洞带半透明 alpha 不会越叠越透。
   */
  function grainPattern(stroke) {
    var paper = stroke.paper || 'none';
    var grain = stroke.grain || 0;
    if (!grain || paper === 'none') return null;
    var sc = clamp(stroke.grainScale || 1, 0.2, 4);
    var keep = 1 - grain * 0.5;                                   // 全不透明的比例
    var holeA = Math.round(255 * Math.max(0.22, 1 - grain * 0.85)); // 孔洞保留的 alpha
    var key = (stroke.seed >>> 0) + '|' + paper + '|' + Math.round(keep * 40) + '|' + holeA + '|' + Math.round(sc * 10);
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
          d[i + 3] = on ? 255 : holeA;
        }
      }
      ctx.putImageData(img, 0, 0);
    } else if (paper === 'coarse') {
      // 粗纹：低分辨率随机后放大，再按阈值分成「全实 / 半透」两档
      var n = 18;
      var tmp = document.createElement('canvas');
      tmp.width = n; tmp.height = n;
      var tctx = tmp.getContext('2d');
      var ti = tctx.createImageData(n, n);
      for (i = 0; i < n * n; i++) ti.data[i * 4 + 3] = rnd() < keep ? 255 : holeA;
      tctx.putImageData(ti, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, n, n, 0, 0, S, S);
      var img2 = ctx.getImageData(0, 0, S, S);
      var th = holeA + (255 - holeA) * 0.5;   // 阈值随 holeA 走：固定 110 会把新「半透孔」全判成实
      for (i = 0; i < S * S; i++) img2.data[i * 4 + 3] = img2.data[i * 4 + 3] > th ? 255 : holeA;
      ctx.putImageData(img2, 0, 0);
    } else {
      // 细纹：单像素随机噪点
      img = ctx.createImageData(S, S);
      d = img.data;
      for (i = 0, n = S * S; i < n; i++) d[i * 4 + 3] = rnd() < keep ? 255 : holeA;
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
  // ★ 2.0.10：用 **destination-over** 合成。以前是 source-over 画上去的，
  //   端帽的直边正好压在笔身那条横截边上：两边的抗锯齿各占一半覆盖率，
  //   source-over 合出来比满覆盖率淡一点 —— 起笔 / 收笔处就留下一道**细竖线**
  //   （用户报的「起笔和收笔的时候都会出现这样的竖线」）。
  //   画在笔身后面则只在没墨的地方补上，接缝处两半加起来正好是满覆盖率。
  function drawCap(ctx, x, y, dx, dy, r, alpha) {
    var len = Math.hypot(dx, dy);
    if (!len) return;
    var ang = Math.atan2(dy / len, dx / len);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.35, r), ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * 连续笔身：**变宽多边形**（每个采样点自带宽度，段与段之间线性过渡）。
   *
   * ⚠ 这里换过一次实现，起因是用户报「线条中间有顿感」（粗笔 + 真实笔压，
   *   笔身沿线一串周期性加粗的方块，像被一节一节盖章）。老实现是这样的：
   *     把相邻点按 (宽度, 浓度) **量化分组**，每组用 `stroke()` + 固定 `lineWidth` 画。
   *   两个毛病叠加，结果就是上面那个样子：
   *     ① 压力几乎每个点都在动，量化后的宽度也就每点都变 → 一条 100 点的线能切出
   *        **70 段，其中 47 段只有一个点长**（实测）。每段固定宽度 → 宽度沿线的变化
   *        变成阶梯（23 → 24.5 → 26 → 27 → 25 → 24 …），肉眼就是「一节一节」。
   *     ② 段间要接头。用圆头会把每段沿切线各外扩 lineWidth/2，相邻段重叠一整个笔宽，
   *        在 globalAlpha<1 下 source-over 叠加 → 接缝变深；用平头则拐角缺楔形。
   *
   *   现在的做法是这类软件的标准解法：**不要「一段一个宽度」，要「一点一个宽度」**。
   *   把这一笔描成一条**带左右两条侧边的多边形**（每侧 = 逐点沿法线外扩 width/2），
   *   一次性 fill。宽度因此是连续插值的，没有阶梯；多边形自己不相交地覆盖一遍，
   *   没有接缝、也就没有叠色。
   *
   * 浓度（alpha）仍然是分段量化的 —— 但那是**颜色深浅**，量化后只是「一档一档变淡」，
   * 边界上相邻两档共边、不重叠，看不出接缝，而且 alpha 变化本来就该是台阶（可撤销的
   * 量化是色彩管理的常规做法）。宽度不一样：宽度是需要连续几何的。
   *
   * ⚠ 但「分段量化」有个前提：**段要足够长**。切出一堆 1~2 个点长的小段，
   *   每一段都是一个平头小方块，段与段之间不重叠 → 接缝处整列像素掉一半覆盖率，
   *   看起来就是一串周期性细腰（实测最窄掉到 3px，正常应有 23px）。
   *   所以换档要带**滞回**（ALPHA_HYST）：只有当量化值离当前档 ≥2 档时才真的切，
   *   在量化边界上来回抖动的那些「假变化」直接忽略 —— 它们的色差本来也看不见。
   *   再配合「至少 2 个点才成段」，保证每段都够长、不出现细腰。
   */
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

    // 把用到的那一段点先映射到目标空间，并算好每点的半径。
    //
    // ★ 2.0.10：顺手**合并挨得太近的点**（重合 / 亚像素）。
    //   手绘在拐弯处常常连着报两个几乎重合的点（抬笔顿一下），那时切线退化，
    //   变宽多边形的两侧偏移点会被一条 45° 的斜边直接连起来 —— 拐角就成了
    //   「方形的斜切角」，用户报的就是这个（68px 的笔上，切口有 20px 那么明显）。
    //   ⚠ 所有调用点传的都是 fromIndex = 0（整笔重画）；非 0 的增量路径不做这一步。
    var compact = !fromIndex;
    var drop = clamp(stroke.size * 0.06, 0.5, 6);
    var n = pts.length;
    var xs = [], ys = [], rs = [], as = [], ps = [];
    for (var i = 0; i < n; i++) {
      var q = mp(m, pts[i][0], pts[i][1]);
      var rr0 = Math.max(0.18, widthAt(stroke, pts[i][2]) / 2);
      var aa0 = qa(alphaAt(stroke, pts[i][2]));
      if (compact && xs.length && Math.hypot(q[0] - xs[xs.length - 1], q[1] - ys[ys.length - 1]) < drop) {
        // 太近：挪到后一个点的位置上（保留更靠后的压力），点数不增
        xs[xs.length - 1] = q[0]; ys[ys.length - 1] = q[1];
        rs[xs.length - 1] = rr0; as[xs.length - 1] = aa0; ps[xs.length - 1] = pts[i][2];
        continue;
      }
      xs.push(q[0]); ys.push(q[1]); rs.push(rr0); as.push(aa0); ps.push(pts[i][2]);
    }
    n = xs.length;
    if (n < 2) {
      if (n === 1) {
        ctx.globalAlpha = as[0];
        ctx.beginPath();
        ctx.arc(xs[0], ys[0], Math.max(0.35, rs[0]), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      return;
    }

    // ★ 2.0.10（重做）：圆头笔迹不再走「变宽多边形」，改成**沿路径盖章的并集**。
    //
    // 多边形那条路在拐角上三个约束无法同时满足：外侧要圆、内侧要填满、还不能自交 ——
    // 尖角（miter）会拉出长刺，圆弧外角又会捅穿内侧造成自交、nonzero 抵消出**白色三角**，
    // 端帽单独 fill 还会在接缝上留一道**细竖线**（用户连着报了四轮）。
    // 而「圆头笔迹」的几何定义本来就是**一串圆盘的并集**：
    //   · 端头天然是圆的（不需要额外的端帽 → 没有接缝）
    //   · 拐角天然是圆的（不需要 miter → 没有尖刺、不会自交）
    //   · 整条路径一次 fill（nonzero 并集）→ 重叠不叠深、也不可能抵消出洞
    var step = Math.max(0.5, stroke.size * 0.06);
    var key = -1, open = false;
    var flush = function () {
      if (!open) return;
      ctx.globalAlpha = key / ALPHA_STEPS;
      ctx.fill();
      open = false;
    };
    var emit = function (x, y, press) {
      var r = Math.max(0.18, widthAt(stroke, press) / 2);
      var k2 = Math.round(qa(alphaAt(stroke, press)) * ALPHA_STEPS);
      if (k2 !== key) { flush(); ctx.beginPath(); key = k2; open = true; }
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    };
    var arcPos = 0, next = 0;
    emit(xs[0], ys[0], ps[0]);
    next = step;
    for (var si = 1; si < n; si++) {
      var ax2 = xs[si - 1], ay2 = ys[si - 1], bx2 = xs[si], by2 = ys[si];
      var seg = Math.hypot(bx2 - ax2, by2 - ay2);
      if (seg <= 0) continue;
      while (next <= arcPos + seg) {
        var tt = (next - arcPos) / seg;
        emit(ax2 + (bx2 - ax2) * tt, ay2 + (by2 - ay2) * tt, ps[si - 1] + (ps[si] - ps[si - 1]) * tt);
        next += step;
      }
      arcPos += seg;
    }
    emit(xs[n - 1], ys[n - 1], ps[n - 1]);
    flush();
    ctx.globalAlpha = 1;
  }

  /** 取 [lo, hi] 这一段点里的拐角（点序号区间，含两端） */
  function joinsIn(joins, lo, hi) {
    if (!joins || !joins.length) return null;
    var out = null;
    for (var i = 0; i < joins.length; i++) {
      var j = joins[i][0];
      if (j < lo || j > hi) continue;
      if (!out) out = [];
      out.push(joins[i]);
    }
    return out;
  }

  /**
   * 把 [i0,i1] 这段折线描成「左右各一条侧边」的变宽多边形，一次 fill。
   *
   * roundStart / roundEnd：端点是否补半圆（整笔首尾要，档位内部接口不要 ——
   * 接口处两侧是共边相接的，补圆反而会鼓出来）。
   *
   * 用的是**相邻段法线的角平分线**（miter 的方向）而不是单段法线：
   * 单段法线在拐角处会让左右侧边各自错位，窄笔还好，粗笔会出现缺口。
   *
   * ★ 2.0.10：**外侧改用真正的圆角（arc）**。以前两侧都按角平分线拉成 miter 尖角，
   *   外角就多出一块方的尖角 —— 用户报的「笔迹转折处会变成方形」。
   *   现在外角走一段半径 = 该点半宽的圆弧（内角仍然是 miter 交点，那里本来就该是尖的）。
   */
  function fillVariableRibbon(ctx, xs, ys, rs, i0, i1, roundStart, roundEnd) {
    var n = i1 - i0 + 1;
    // 单点段（浓度真的跃变、只隔了一个点时会出现）：描成一个圆点，
    // 别直接 return —— 那会在笔身上留一个洞。
    if (n < 2) {
      if (n === 1) {
        ctx.beginPath();
        ctx.arc(xs[i0], ys[i0], Math.max(0.35, rs[i0]), 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // 逐点算：入射 / 出射单位法线、半径、是不是拐角、外角在左还是在右、miter 交点
    var px = [], py = [], rr = [], n1x = [], n1y = [], n2x = [], n2y = [];
    var mLx = [], mLy = [], mRx = [], mRy = [], isC = [], outerR = [];
    for (var i = 0; i < n; i++) {
      var gi = i0 + i;
      var ax = 0, ay = 0, bx = 0, by = 0;
      if (gi > i0) { ax = xs[gi] - xs[gi - 1]; ay = ys[gi] - ys[gi - 1]; }
      if (gi < i1) { bx = xs[gi + 1] - xs[gi]; by = ys[gi + 1] - ys[gi]; }
      if (!ax && !ay) { ax = bx; ay = by; }
      if (!bx && !by) { bx = ax; by = ay; }
      var la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      var t1x = ax / la, t1y = ay / la, t2x = bx / lb, t2y = by / lb;
      var ux = t1x + t2x, uy = t1y + t2y, lu = Math.hypot(ux, uy);
      if (lu < 1e-6) { ux = -t1y; uy = t1x; lu = 1; }              // 180° 掉头
      ux /= lu; uy /= lu;
      var cosHalf = Math.abs(ux * t1x + uy * t1y);
      // 拐角回到「两侧都用角平分线」的老做法（夹到 3 倍防尖刺）。
      // ⚠ 我这一版试过「外侧走圆弧」：急转弯时内侧的尖会捅穿外侧圆弧 → 路径自交 →
      //   nonzero 在自交处抵消 → 笔迹里出现**白色三角**（用户连报两轮）。
      //   内侧楔形补块同样不可靠（绕向一错就是一块白洞）。这一版先回到不自交的做法，
      //   宁可拐角是 miter 尖角，也绝不留白洞；圆弧拐角留到能把路径几何逐张比对时再做。
      var k = cosHalf > 1e-3 ? Math.min(3, 1 / cosHalf) : 1;
      var r = rs[gi];
      px[i] = xs[gi]; py[i] = ys[gi]; rr[i] = r;
      n1x[i] = -t1y; n1y[i] = t1x;        // 入射段的左法线
      n2x[i] = -t2y; n2y[i] = t2x;        // 出射段的左法线
      var nbx = -uy, nby = ux;            // 角平分线的左法线
      mLx[i] = px[i] + nbx * r * k; mLy[i] = py[i] + nby * r * k;
      mRx[i] = px[i] - nbx * r * k; mRy[i] = py[i] - nby * r * k;
      // 两端点不算拐角（那里由端帽负责）；其余按夹角判定，外角在右侧当 cross > 0
      // （t1=(1,0)、t2=(0,1) 代进去：L 在下/左 = 内角，R 在上/右 = 外角 ✓）
      isC[i] = i > 0 && i < n - 1 && (t1x * t2x + t1y * t2y) < 0.985;
      outerR[i] = (t1x * t2y - t1y * t2x) > 0;
    }

    /** 从方向 a 绕到方向 b 的**短圆弧**（圆角就是它） */
    function arcBetween(cx, cy, rad, adx, ady, bdx, bdy) {
      var s = Math.atan2(ady, adx), e = Math.atan2(bdy, bdx);
      var d = e - s;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ctx.arc(cx, cy, rad, s, e, d < 0);
    }

    // ⚠ 路径顺序必须是「左侧边正向 → 终点 → 右侧边逆向 → closePath 收口」，
    //   即围成一个**不自交**的环。曾经写成「先画起点那条横边、再走左侧边」，
    //   于是路径变成 L0→R0→L1→R1→L0 这种**蝴蝶结**（自交 X）——
    //   canvas 的 nonzero 填充规则会把交叉区域互相抵消掉，
    //   一条本该 31px 宽的带子只填出 ~16px（实测）。
    //   所以：起点那条横边交给 closePath() 去补，绝不在开头画。
    var L0x = px[0] + n2x[0] * rr[0], L0y = py[0] + n2y[0] * rr[0];
    var R0x = px[0] - n2x[0] * rr[0], R0y = py[0] - n2y[0] * rr[0];
    ctx.beginPath();
    ctx.moveTo(L0x, L0y);
    if (roundStart) {
      // 起点端帽（半圆，朝后）：从 L0 出发，画到 R0
      ctx.arc(px[0], py[0], rr[0],
        Math.atan2(L0y - py[0], L0x - px[0]), Math.atan2(R0y - py[0], R0x - px[0]), false);
    }
    // 左侧边（正向）
    for (var a = 1; a < n; a++) ctx.lineTo(mLx[a], mLy[a]);    // 终点端帽（半圆，朝前）：从 L(n-1) 画到 R(n-1)
    var lastI = n - 1;
    if (roundEnd) {
      ctx.arc(px[lastI], py[lastI], rr[lastI],
        Math.atan2(mLy[lastI] - py[lastI], mLx[lastI] - px[lastI]),
        Math.atan2(mRy[lastI] - py[lastI], mRx[lastI] - px[lastI]), false);
    }
    // 右侧边（逆向），最后 closePath 把 R0 → L0 的起点横边补上
    for (var b = n - 1; b >= 0; b--) ctx.lineTo(mRx[b], mRy[b]);
    ctx.closePath();
    ctx.fill();
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

  /**
   * 散布：把采样点抖散成一簇小点（噪点笔）
   *
   * ★ 2.0.10：这一层**画在笔身后面**（调用方用 destination-over 合成），而且点的大小
   *   跟着 scatter 走。以前它画在笔身**上面**、半径又是死的 `size*0.16`：
   *   铅笔只要沾了一点散布（哪怕 0.05），68px 的笔就会沿笔身盖出一串**直径 22px 的深色圆点**，
   *   用户原话是「铅笔笔刷出现明显的圆形停顿」。散布本来就是「画材颗粒」，
   *   它只该在笔身边缘外面加一点毛边，绝不该把笔身压深。
   */
  function paintScatter(ctx, stroke, pts, fromIndex, m, behind) {
    strokeStyleSetup(ctx, stroke);
    // behind = 笔身已经画好了：这一层只当「笔身外面的颗粒」。
    // ⚠ canvas 的合成都是按 alpha 成比例叠加的（没有 max 那种并集），
    //   所以笔身半透明的地方，颗粒仍会往上加一点点浓度 —— 这里把强度打到 35%，
    //   那点增量就落在看不见的范围里（实测 ≤ 5%），而笔身外面的颗粒照旧清晰。
    var mul = behind ? 0.35 : 1;
    if (behind) ctx.globalCompositeOperation = 'destination-over';
    var rnd = mulberry32(((stroke.seed >>> 0) ^ 0x9e3779b9) >>> 0);
    var start = fromIndex || 0;
    // 点的大小跟着散布强度走：一点点散布 = 细颗粒（2~3px），满格散布才回到笔宽量级
    var radius = Math.max(0.35, stroke.size * (0.03 + 0.13 * stroke.scatter));
    // 散布幅度按 scatter 本身缩放。以前是 `0.35 + scatter*1.15`，只要 scatter 不为 0
    // 起步就是笔刷直径的 35%，铅笔那种「一点点散布」直接炸成一团雾。
    var spread = stroke.size * (0.15 + stroke.scatter * 0.85);
    var per = 1 + Math.round(stroke.scatter * 8);
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
        ctx.globalAlpha = a * mul;
        ctx.beginPath();
        ctx.arc(base[0] + Math.cos(ang) * rad, base[1] + Math.sin(ang) * rad, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
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

  /* ---------------- ★ 2.0.10：笔尖形状（照 SAI2 的「笔刷形状」面板） ----------------
   *
   * 圆头仍然走「变宽多边形」那条路（连续、没有盖章感）。方头 / 平头（斜切）/ 三角 / 菱形
   * 这几种**没法用一条描边表示** —— 它们的轮廓不是「沿路径等宽」的，所以改成
   * 沿弧长**盖章**：每一枚章是旋转过的多边形，同一个浓度档里的章凑成**一条路径一次 fill**
   * （nonzero 填充下是并集），因此重叠处不会叠加变深、拐角也自然就是这支笔该有的样子。
   *
   * 笔尖方向由 tipAngle 决定（平头 / 方头最常用：斜着运笔就有粗细变化）。
   */
  function isRoundTip(stroke) {
    return !stroke.tipShape || stroke.tipShape === 'round';
  }

  /** 把一枚笔尖形状加进当前路径（一个子路径）。所有形状绕向一致，nonzero 下才能并集 */
  function tipShapeSubPath(ctx, shape, cx, cy, r, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    var pt = function (x, y) { return [cx + x * c - y * s, cy + x * s + y * c]; };
    var q;
    if (shape === 'square') {
      q = [pt(-r, -r), pt(r, -r), pt(r, r), pt(-r, r)];
    } else if (shape === 'flat') {
      var hw = r, hh = Math.max(0.3, r * 0.32);          // 平头（斜切）：一块很扁的矩形
      q = [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
    } else if (shape === 'triangle') {
      var tr = r * 1.16;
      q = [pt(0, -tr), pt(tr * 0.92, tr * 0.68), pt(-tr * 0.92, tr * 0.68)];
    } else if (shape === 'diamond') {
      q = [pt(0, -r * 1.15), pt(r * 0.72, 0), pt(0, r * 1.15), pt(-r * 0.72, 0)];
    } else {
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      return;
    }
    ctx.moveTo(q[0][0], q[0][1]);
    for (var i = 1; i < q.length; i++) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
  }

  function paintTipShapeStroke(ctx, stroke, pts, fromIndex, m) {
    var n = pts.length;
    if (!n) return;
    var ang = (stroke.tipAngle || 0) * Math.PI / 180;
    // 盖章比「导入笔尖」那条路更密（一半间隔）：多边形章的边缘是折线，
    // 间隔大了侧面会看出锯齿
    var spacing = Math.max(0.5, stroke.size * clamp(stroke.spacing || 0.1, 0.02, 0.5) * 0.5);
    var curKey = -1;
    /** 攒着同一浓度档的章，换档时一次 fill */
    var flush = function (key) {
      if (key < 0) return;
      ctx.globalAlpha = key / ALPHA_STEPS;
      ctx.fill();
    };
    var add = function (x, y, press) {
      var r = Math.max(0.2, widthAt(stroke, press) / 2);
      var key = Math.round(qa(alphaAt(stroke, press)) * ALPHA_STEPS);
      if (key !== curKey) {
        flush(curKey);
        ctx.beginPath();
        curKey = key;
      }
      tipShapeSubPath(ctx, stroke.tipShape, x, y, r, ang);
    };
    var s = 0, next = 0;
    var p0 = mp(m, pts[0][0], pts[0][1]);
    add(p0[0], p0[1], pts[0][2]);
    next = spacing;
    for (var i = 1; i < n; i++) {
      var a = mp(m, pts[i - 1][0], pts[i - 1][1]);
      var b = mp(m, pts[i][0], pts[i][1]);
      var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg <= 0) continue;
      while (next <= s + seg) {
        var t = (next - s) / seg;
        add(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
          pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t);
        next += spacing;
      }
      s += seg;
    }
    // 收尾：最后一枚章落在末点上（末段不足一个 spacing 时也要有）
    var pn = mp(m, pts[n - 1][0], pts[n - 1][1]);
    add(pn[0], pn[1], pts[n - 1][2]);
    flush(curKey);
    ctx.globalAlpha = 1;
    void fromIndex;
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
      // ★ 2.0.10：非圆头笔尖（方 / 平头 / 三角 / 菱形）走盖章那条路
      if (!isRoundTip(st)) { paintTipShapeStroke(ctx, st, pts, fromIndex, m); continue; }
      paintRuns(ctx, st, pts, fromIndex, m, opts);
      // 散布叠在笔身**后面**（destination-over）：只在笔身外面加颗粒，不把笔身压深
      if (st.scatter > 0) paintScatter(ctx, st, pts, fromIndex, m, true);
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
    /**
     * 孤儿笔迹：layerId 在本地还不存在的笔迹，先按图层挂在这儿。
     *
     * 为什么必须有它：多人协作里「某人在**刚新建的图层**上落笔」时，
     * LAYER_ADD 广播和 STROKE_* 广播是两条独立的消息，没有顺序保证 ——
     * 笔迹完全可能先到。以前 addCommitted 遇到认不出的 layerId 会兜底到
     * **最后一层**（newStroke 兜底的是「活动图层」，服务端又是「最后一层」，
     * 三个兜底目标各说各话），于是那一笔落在谁的屏幕上都不一样，
     * 表现就是「有概率看不到别人的某一图层」。
     *
     * 正确做法是**别猜**：认不出就存下来，等 LAYER_ADD 把那一层补进来再落笔。
     * Map<layerId, stroke[]>
     */
    this.orphanStrokes = new Map();
    /**
     * 「正在画」那条路（STROKE_BEGIN→POINTS→END）的孤儿缓冲。
     * 笔迹还没结束时分不清它是几笔，所以单独用一张表：
     *   id -> { begin: info, pts: [[x,y,p]…], end: {seq} | null }
     * 等图层补进来时整条重放，和作者端看到的完全一致。
     * Map<strokeId, {begin, pts, end}>
     */
    this.orphanBegins = new Map();
    /** 孤儿笔迹堆积上限。正常网络下几条就消化掉了，留着是防有人故意灌 */
    this.orphanLimit = 512;
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
      // ★ v2.0.10：SAI2 锁定行里的另外两颗（锁定画笔 / 锁定移动）
      drawLock: !!meta.drawLock,
      moveLock: !!meta.moveLock,
      // ★ 2.0.9：指定为选区样本（整份文档同时只有一层，服务端保证互斥）
      selSample: !!meta.selSample,
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
        drawLock: !!l.drawLock, moveLock: !!l.moveLock, selSample: !!l.selSample,
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
        l.drawLock = !!meta.drawLock;
        l.moveLock = !!meta.moveLock;
        l.selSample = !!meta.selSample;
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
    // 图层表定稿了 —— 把之前因为「层还没到」而挂着的笔迹补落下去。
    // 必须在 baseDirty 之前做，否则这一帧合成用的还是旧图层表。
    var flushed = this.flushOrphanStrokes();
    if (flushed) this.baseKey = '';
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
    // 认不出的 layerId 兜底到「活动图层」。
    // 注意：这条兜底**只**对本地作画（自己刚落笔、图层一定在本地）成立。
    // 远端笔迹走 addCommitted，那边认不出就挂起来等 LAYER_ADD，绝不兜底 ——
    // 两个兜底目标不一致正是「同一笔落在不同图层」的来源。
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
      // ★ 2.0.9 魔棒选项（照 SAI2 的魔棒面板）。这几项**只在本机用** ——
      //   魔棒那一笔不上传、不进历史，所以服务端的白名单里不需要它们，
      //   但 newStroke 这道白名单漏了，wandMask 就永远只能按默认值取样（和笔刷漏字段同一个坑）。
      selMode: ['wrap', 'diff', 'diffAll'].indexOf(info.selMode) >= 0 ? info.selMode : 'wrap',
      transTol: clamp(Number(info.transTol) || 0, 0, 255),
      bleed: clamp(Number(info.bleed) || 0, 0, 20),
      selSource: ['layer', 'sample', 'merged'].indexOf(info.selSource) >= 0 ? info.selSource : 'layer',
      antiAlias: info.antiAlias !== false,
      ignoreSel: !!info.ignoreSel,
      // 导入的 PS / CSP 笔刷：笔尖位图 + 落点间隔
      spacing: br.spacing,
      tip: br.tip,
      mix: br.mix,
      // ★ 2.0.10：笔尖形状 / 方向（照 SAI2 的笔刷形状）—— 这道白名单漏了，
      // 本地画得出来、别人的屏幕上会退回圆头（和导入笔尖漏字段是同一个坑）
      tipShape: br.tipShape,
      tipAngle: br.tipAngle,
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
    // 远端笔迹的 layerId 也认不出时**别兜底**：挂起来等 LAYER_ADD。
    // 这里是「正在画」的实时预览路（STROKE_BEGIN → POINTS → END），
    // 兜底到活动图层的话，那一笔会从头到尾长在错误的层上 ——
    // 和 addCommitted 是同一个坑的两个入口。
    // 本地作画（info.local）不受影响：自己的图层一定在本地。
    if (info && !info.local && info.id && info.layerId && !this.getLayer(info.layerId)) {
      this._queueOrphan(Object.assign({}, info, { _pendingBegin: true }));
      return null;
    }
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

  /**
   * 改写某条「正在画」的笔迹里，末尾 n 个点的压力值。
   * 用途：起笔那一下浏览器给的是占位压力（Chrome 常给 0.5），真值要到第一个
   * pointermove 才出现。等真值到了，把开头的点回改成同一档，笔尖才不会被
   * 起手那半压顶出一个「小圆头」。
   * 只改压力，坐标一律不动。
   */
  CanvasEngine.prototype.patchTailPressure = function (strokeId, n, pressure) {
    var e = this.pending.get(strokeId);
    if (!e || !e.stroke || !e.stroke.points.length) return 0;
    var pts = e.stroke.points;
    var cnt = Math.min(n, pts.length);
    for (var i = pts.length - cnt; i < pts.length; i++) pts[i][2] = pressure;
    return cnt;
  };

  CanvasEngine.prototype.addPoints = function (strokeId, pts) {
    var e = this.pending.get(strokeId);
    // 这条笔迹的 BEGIN 因为「层还没到」被挂起来了 → 点也一并缓冲，
    // 等图层补进来时按原顺序重放，不然大家看到的线会缺前面几段。
    if (!e) {
      var ob = this.orphanBegins.get(strokeId);
      if (ob && pts && pts.length) for (var k = 0; k < pts.length; k++) ob.pts.push(pts[k]);
      return;
    }
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
    // BEGIN 被挂起（层还没到）→ 先把 END 记下来，等 flush 时整条重放。
    if (!e) {
      var ob = this.orphanBegins.get(strokeId);
      if (ob) ob.end = { seq: seq };
      return null;
    }
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
    // ★ 2.0.10：端帽**并进笔身那条路径**（fillVariableRibbon 的首/末段带 roundStart/roundEnd）。
    //   以前端帽是单独一次 fill 叠上去的：两半的抗锯齿在接缝上各占一半覆盖率，
    //   合成出来比满覆盖率淡一点 —— 起笔 / 收笔处就留下一道细竖线（用户报了两轮）。
    //   同一条路径一次 fill 才是真正的并集，接缝自然消失。
    // ★ 2.0.10：圆头 / 非圆头现在都是「盖章的并集」，端头由最后一枚章自己盖出来，
    //   所以**不需要**再单独补端帽（那正是起笔/收笔那道细竖线的来源）。
    var caps = false;
    paintStrokeShape(sctx, stroke, stroke.points, 0, {
      width: this.width, height: this.height, startCap: caps, endCap: caps, noGrain: isBlur(stroke)
    });
    if (!caps) return;
    var copies = symmetryCopies(stroke, this.width, this.height);
    for (var i = 0; i < copies.length; i++) paintEndCap(sctx, stroke, stroke.points, copies[i]);
  };

  CanvasEngine.prototype.cancelStroke = function (strokeId) {
    // 被挂起的孤儿笔迹收到 CANCEL：直接丢掉，别等图层来了再补画一笔废线
    if (this.orphanBegins.has(strokeId)) { this.orphanBegins.delete(strokeId); return; }
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
    if (!stroke) return null;
    if (this.byId.has(stroke.id)) return null;
    var layer = this.getLayer(stroke.layerId);
    // 认不出 layerId → **不要兜底**，先挂着等 LAYER_ADD。
    // 兜底到 layers[last] 会让这一笔落在任意一层上，而且和作者端的兜底
    // （newStroke → activeLayer）还不是同一层 —— 那正是「有概率看不到别人的
    // 某一图层」的根子。等层补进来再落笔，画面对所有人一致。
    if (!layer) { this._queueOrphan(stroke); return null; }
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

  /** 把认不出图层的笔迹挂进待办表 */
  CanvasEngine.prototype._queueOrphan = function (stroke) {
    var lid = stroke && stroke.layerId;
    if (!lid) return;
    // 「正在画」的实时笔迹另走一条：它后面还会来 POINTS / END，必须整条缓冲
    if (stroke._pendingBegin) {
      if (this.orphanBegins.size >= this.orphanLimit) return;
      if (!this.orphanBegins.has(stroke.id)) {
        this.orphanBegins.set(stroke.id, { begin: stroke, pts: [], end: null });
      }
      return;
    }
    var arr = this.orphanStrokes.get(lid);
    if (!arr) { arr = []; this.orphanStrokes.set(lid, arr); }
    if (arr.length >= this.orphanLimit) {
      arr.shift();     // 堆爆了就丢最老的，别让它无限涨
      this.baseDirty = true;
    }
    arr.push(stroke);
  };

  /**
   * 图层表更新后，把「等这一层」的孤儿笔迹补落下去。
   * setLayers / addLayerMeta 之后都要调一次（服务端 LAYERS 广播是唯一入口）。
   */
  CanvasEngine.prototype.flushOrphanStrokes = function () {
    if (!this.orphanStrokes.size && !this.orphanBegins.size) return 0;
    var self = this;
    var landed = 0;
    // 先快照再清空：addCommitted 有可能又挂出新的孤儿（链式情形），
    // 直接在原 Map 上迭代会边改边遍历，行为不确定。
    var pending = new Map(this.orphanStrokes);
    this.orphanStrokes = new Map();
    pending.forEach(function (arr, lid) {
      var layer = self.getLayer(lid);
      if (!layer) { self.orphanStrokes.set(lid, arr); return; }  // 那一层还是没来，继续等
      arr.forEach(function (s) {
        var got = self.addCommitted(s);
        if (got) landed++;
      });
    });
    // 实时笔迹：整条重放（BEGIN → POINTS → END）
    var begins = new Map(this.orphanBegins);
    this.orphanBegins = new Map();
    begins.forEach(function (rec, id) {
      if (!rec.begin || !self.getLayer(rec.begin.layerId)) { self.orphanBegins.set(id, rec); return; }
      var st = self.beginStroke(Object.assign({}, rec.begin, { _pendingBegin: false }));
      if (!st) return;
      if (rec.pts.length) self.addPoints(id, rec.pts);
      // 还没收到 END 的就让它继续在 pending 里长着，后面的 POINTS/END 走正常路
      if (rec.end) self.endStroke(id, rec.end.seq);
      landed++;
    });
    if (landed) this.baseDirty = true;
    return landed;
  };

  /** 孤儿笔迹数（测试 / 调试用） */
  CanvasEngine.prototype.orphanCount = function () {
    var n = 0;
    this.orphanStrokes.forEach(function (a) { n += a.length; });
    n += this.orphanBegins.size;
    return n;
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
    // 变换中的那一层必须看**活画布**，不能走 viewCanvas。
    // 为什么：beginTransform 把选区那块像素「拿起来」了，原地是直接挖空的 ——
    // 这份状态只在 layer.canvas 上，既不在 baseImage 里、也不在笔迹历史里。
    // 而开了「他人笔触淡化」时 viewCanvas 是从 baseImage + 笔迹重建的，
    // 重建等于把挖掉的那块按旧底图补回来：屏幕上就变成「原位置残留一份、
    // 浮层上又跟着鼠标一份」，松手确认后才消失。
    if (this.transform && this.transform.layerId === layer.id) return layer.canvas;
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
    if (!layer || !stroke) return;
    // 协作视图关着时**没有** viewCanvas 这个概念（displayCanvas 直接返回 layer.canvas），
    // 所以什么都不用补。但要顺手把可能存在的陈年 viewCanvas 丢掉 ——
    // 以前这里直接 return，残留的旧 viewCanvas 一旦被读到就是「某一图层画面停在过去」。
    if (!this.dimOn()) {
      if (layer.viewCanvas) { layer.viewCanvas = null; layer.viewCtx = null; layer.viewN = -1; }
      return;
    }
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
    // 服务端回显的「清空」到达时若变换还挂着（比如刚提交过一次像素操作又立刻
    // 开了新变换）：变换的浮层底座（图层像素）马上要被清掉，先中止变换还原，
    // 再执行清除 —— 否则浮层会把已失效的像素叠回来。
    if (this.transform) {
      var tl = this.getLayer(this.transform.layerId);
      if (scope === 'all' || (tl && tl.id === layerId)) this.endTransform(false);
    }
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
      this.selection = {
        canvas: c.canvas, ctx: c.ctx, tint: t.canvas, tintCtx: t.ctx, active: false, bbox: null,
        // ★ 2.0.9：蚂蚁线要沿**选区的真实形状**走，这两块缓存就是干这个的
        //   band = 蒙版的 1px 轮廓带；ants = 「轮廓带 ∩ 斜条纹」的成品（每帧重画一小块）
        band: null, bandDirty: true, ants: null, antsCtx: null, antsKey: ''
      };
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
    // ★ v2.0.10：锁定移动 = 这一层不能整体搬走 / 变形（SAI2 锁定行里那个十字箭头图标）
    if (layer.moveLock) { this.emit('transformError', { message: '图层「' + layer.name + '」锁定了移动' }); return null; }

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
      // ★ 用户报的 bug：变换确定之后图形移走了，**选区还留在原地**。
      //   选区是「被拿起来的那一块」的蒙版，内容走到哪它就该跟到哪 —— 否则下一步
      //   填色 / 再变换 / 擦除都会作用在空掉的老位置上（看着像「选区坏了」）。
      //   跟完之后旧的蚂蚁线不会留在原地，包围盒也跟着刷新。
      if (this.hasSelection()) this.followSelection(t);
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
   * ★ 变换确定之后，让**选区跟着内容一起走**。
   *
   * 做法：把选区蒙版里「被拿起来的那一块」（= t.rect 那块）抠出来当成浮层，
   * 用**同一条变换**（同一组四边形 / 网格控制点）渲到文档尺寸的画布上，
   * 再拿它替换旧选区 —— 形状（含旋转 / 斜切 / 网格变形）和位置都跟着内容。
   *
   * 为什么不用「把旧选区整体平移」这种省事的办法：变形可以是网格变形 / 扭曲 / 翻转，
   * 平移根本表达不了；而 t.render() 本来就是「把这块 buf 按当前变换画出来」，
   * 换掉 buf 就能原样复用，不会和变换本身算出两套不一致的结果。
   */
  CanvasEngine.prototype.followSelection = function (t) {
    var s = this.selection;
    if (!s || !s.active || !t) return false;
    var r = t.rect;
    if (!r || r.w < 1 || r.h < 1) return false;
    var sel = mkCanvas(r.w, r.h, false);
    sel.ctx.drawImage(s.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    var out = mkCanvas(this.width, this.height, false);
    var buf0 = t.buf;
    t.buf = sel.canvas;
    try {
      t.render(out.ctx);
    } catch (e) {
      t.buf = buf0;
      return false;
    }
    t.buf = buf0;
    clearCtx(s.ctx, this.width, this.height);
    s.ctx.drawImage(out.canvas, 0, 0);
    s.active = true;
    this.refreshSelectionTint();          // 染色层与包围盒一起刷新（蚂蚁线跟着走）
    this.emit('selection', { active: true });
    return true;
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
    // 选区没了，挂着「拿起像素」状态的变换就成了孤儿：图层是被挖空的，
    // 之后所有画布点击都会被变换分支吞掉（表现：再也选不中、画不了）。
    // 所以清选区时必须先把变换中止（endTransform(false) 会还原像素）。
    if (this.transform) this.endTransform(false);
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
    // 撤销 / 重做选区快照会整体换掉蒙版 —— 同 clearSelection：变换先中止
    if (this.transform) this.endTransform(false);
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
      // ★ 「忽略已选择的区域」要的是**替换之前**那张选区蒙版 —— 下面那句 clearCtx 会先把它清掉，
      //   等 wandMask 再去读就只能读到一张空蒙版（选项看着像没生效）。
      var prevSel = (stroke.tool === 'wand' && stroke.ignoreSel) ? this.selectionMaskData() : null;
      if (mode === 'copy') clearCtx(s.ctx, this.width, this.height);
      s.ctx.save();
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalAlpha = 1;
      s.ctx.globalCompositeOperation = mode === 'copy' ? 'source-over' : mode;
      s.ctx.fillStyle = '#ffffff';
      this.paintSelectRegion(s.ctx, stroke, prevSel);
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
  CanvasEngine.prototype.paintSelectRegion = function (ctx, stroke, prevSel) {
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
      var mask = this.wandMask(pts[0][0], pts[0][1], {
        // ★ 2.0.9：选项全部来自 SAI2 那张魔棒面板（app 里的 S.wand → 笔迹字段 → 这里）
        mode: stroke.selMode || 'wrap',
        transTol: stroke.transTol,
        diffTol: stroke.tolerance,
        bleed: stroke.bleed,
        source: stroke.selSource || 'layer',
        activeLayerId: stroke.layerId,
        aa: stroke.antiAlias !== false,
        ignore: !!stroke.ignoreSel,
        // 「忽略已选择的区域」用的那张旧蒙版（由 applySelectionStroke 在 clearCtx 之前抓好递进来）
        prevSel: prevSel || null
      });
      if (mask) ctx.drawImage(mask, 0, 0);
    }
  };

  /**
   * 魔棒的取样底图：到底从哪一份像素里读颜色。
   *   layer  = 当前图层自己的像素
   *   sample = 标了「指定为选区样本」的那些图层（服务端保证同时只有一层）
   *   merged = 拼合图像（所有可见图层叠起来）
   *
   * 三种都不铺画布底色：**透明就是「这里什么都没有」**，正是「被线条包围的透明区域」
   * 那一种取样模式要认的东西。铺上白底的话整张图都是不透明的，那种模式就永远选不出东西。
   */
  CanvasEngine.prototype.wandSourceCanvas = function (source, activeLayerId) {
    if (source === 'sample') {
      var ids = this.layers
        .filter(function (l) { return l.selSample && l.visible; })
        .map(function (l) { return l.id; });
      if (ids.length) return this.renderDocument({ transparentBackground: true, onlyLayers: ids });
      source = 'layer';      // 没标样本层 → 退回当前图层（app 那边会先提示一句）
    }
    if (source === 'layer') {
      var l = activeLayerId && this.getLayer(activeLayerId) ? this.getLayer(activeLayerId) : this.activeLayer();
      if (l) return this.renderDocument({ transparentBackground: true, onlyLayer: l.id });
    }
    return this.renderDocument({ transparentBackground: true });
  };

  /** 当前选区蒙版的像素（「忽略已选择的区域」要用） */
  CanvasEngine.prototype.selectionMaskData = function () {
    var s = this.selection;
    if (!s || !s.active) return null;
    try { return s.ctx.getImageData(0, 0, this.width, this.height).data; } catch (e) { return null; }
  };

  /**
   * 魔棒：按选项取一块选区，返回一张「白 = 选中」的蒙版 canvas。
   *
   * 三种取样模式（SAI2 原文）：
   *   wrap    「被线条包围的透明区域」：从点的位置在**透明像素**里做洪水填充 ——
   *           线条（不透明像素）天然就是边界，于是选中被线围住的那一整块。
   *           多透明才算透明，由「透明容差范围」定（0 = 只有全透明算，255 = 什么都不算）。
   *   diff    「色差范围内的区域」：只取**和点中的颜色相近且连成一片**的那块。
   *   diffAll 「色差范围内的全部像素」：不连片 —— 整张图上和点中颜色相近的像素全都要。
   *
   * 「防止溢出范围」(bleed) 把结果往外长 N 像素：线稿的抗锯齿边缘是半透明的，
   * 不长出去的话填色 / 变换会在边上留一圈白边（SAI 那边就是为了这个才有的参数）。
   * 「消除锯齿」把硬边的 1-bit 蒙版做一次极小的模糊，让选区边缘是渐变的。
   * 「忽略已选择的区域」把已经选中的像素当成边界，不再吃进来。
   */
  CanvasEngine.prototype.wandMask = function (sx, sy, opt) {
    opt = opt || {};
    var W = this.width, H = this.height;
    var x0 = Math.round(sx), y0 = Math.round(sy);
    if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return null;

    var src = this.wandSourceCanvas(opt.source, opt.activeLayerId);
    var d = src.ctx.getImageData(0, 0, W, H).data;
    var i0 = (y0 * W + x0) * 4;
    var r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];

    var mode = opt.mode === 'diff' || opt.mode === 'diffAll' ? opt.mode : 'wrap';
    // 透明容差：0..255（默认 19，和 SAI2 出场值一样）
    var transTol = Math.max(0, Math.min(255, opt.transTol == null ? 19 : Math.round(opt.transTol)));
    // 色差：按「最大分量差」算，1..120 → 0..255
    var lim = Math.max(1, Math.min(120, opt.diffTol == null ? 32 : opt.diffTol)) * 2.55;
    var selData = opt.ignore ? (opt.prevSel || this.selectionMaskData()) : null;

    function blocked(p) {
      return !!selData && selData[p * 4 + 3] > 127;
    }
    function match(p) {
      var i = p * 4;
      if (selData && blocked(p)) return false;
      if (mode === 'wrap') return d[i + 3] <= transTol;
      var m = Math.max(
        Math.abs(d[i] - r0), Math.abs(d[i + 1] - g0),
        Math.abs(d[i + 2] - b0), Math.abs(d[i + 3] - a0));
      return m <= lim;
    }

    var bits = new Uint8Array(W * H);
    if (mode === 'diffAll') {
      // 「全部像素」：不连片，整张图扫一遍就完事
      for (var p = 0; p < bits.length; p++) if (match(p)) bits[p] = 1;
    } else {
      if (!match(y0 * W + x0)) return null;     // 点在不匹配的地方 → 这一下什么都选不中
      var seen = new Uint8Array(W * H);
      var stack = [x0, y0];
      while (stack.length) {
        var cy = stack.pop(), cx = stack.pop();
        if (cy < 0 || cy >= H) continue;
        var row = cy * W;
        var xl = cx;
        while (xl >= 0 && !seen[row + xl] && match(row + xl)) xl--;
        xl++;
        var xr = cx;
        while (xr < W && !seen[row + xr] && match(row + xr)) xr++;
        xr--;
        if (xl > xr) continue;
        for (var x = xl; x <= xr; x++) { seen[row + x] = 1; bits[row + x] = 1; }
        // 上下两行找种子
        for (var dy = -1; dy <= 1; dy += 2) {
          var ny = cy + dy;
          if (ny < 0 || ny >= H) continue;
          var nrow = ny * W;
          var inRun = false;
          for (var nx = xl; nx <= xr; nx++) {
            var ok = !seen[nrow + nx] && match(nrow + nx);
            if (ok && !inRun) { stack.push(nx, ny); inRun = true; }
            else if (!ok) inRun = false;
          }
        }
      }
    }

    // 防止溢出：把区域整体往外长 N 像素（分离式最大值滤波，和油漆桶共用一份实现）
    var bleed = Math.max(0, Math.min(20, Math.round(opt.bleed || 0)));
    if (bleed > 0) bits = growMask(bits, W, H, bleed);

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d');
    var img = oc.createImageData(W, H);
    var od = img.data;
    for (var q = 0; q < bits.length; q++) {
      if (!bits[q]) continue;
      var o = q * 4;
      od[o] = 255; od[o + 1] = 255; od[o + 2] = 255; od[o + 3] = 255;
    }
    oc.putImageData(img, 0, 0);

    // 消除锯齿：硬边蒙版过一次极小的模糊，边缘就带上渐变（SAI2 那颗勾选就是这个意思）
    if (opt.aa) {
      var soft = document.createElement('canvas');
      soft.width = W; soft.height = H;
      var sc = soft.getContext('2d');
      sc.filter = 'blur(0.7px)';
      sc.drawImage(out, 0, 0);
      sc.filter = 'none';
      return soft;
    }
    return out;
  };

  /** 把选区蒙版染色成半透明蓝（overlay 直接用，避免每帧读像素） */
  CanvasEngine.prototype.refreshSelectionTint = function () {
    var s = this.selection;
    if (!s) return;
    clearCtx(s.tintCtx, this.width, this.height);
    // ★ 2.0.9：蒙版变了 → 轮廓带（蚂蚁线用）作废，下次画 overlay 时重算
    s.bandDirty = true;
    if (!s.active) { s.bbox = null; return; }
    s.tintCtx.setTransform(1, 0, 0, 1, 0, 0);
    s.tintCtx.drawImage(s.canvas, 0, 0);
    s.tintCtx.globalCompositeOperation = 'source-in';
    s.tintCtx.fillStyle = 'rgba(58,132,255,0.30)';
    s.tintCtx.fillRect(0, 0, this.width, this.height);
    s.tintCtx.globalCompositeOperation = 'source-over';
    s.bbox = this.selectionBBox();
  };

  /* ---------------- ★ 2.0.9：选区轮廓（蚂蚁线）沿真实形状走 ----------------
   *
   * 以前这里是「给选区的包围盒描一圈虚线」（strokeRect(bbox)）——
   * 套索套出来一个圆，屏幕上却是一个虚线方框。用户的原话：
   *   「选区选完是什么形状就是什么形状，比如套索画个圈，选区外围就应该是虚线，
   *     不应该是虚线方框」。
   *
   * 做法分两步，都不需要去追轮廓线（复杂形状 / 带洞 / 散块都能吃）：
   *   ① buildSelectionBand：蒙版 **减去**「四个方向各平移 1px 的蒙版」——
   *      剩下的就是「邻居里有没选中的像素」的那一圈，也就是 1px 宽的轮廓带。
   *   ② drawSelectionAnts：把一块会随时间平移的斜条纹图案用 source-in 裁进这条带，
   *      白 / 深两色交替且**都不透明** → 看上去就是沿着选区边缘爬的蚂蚁线。
   *      只合成 bbox 那一小块，所以每帧的开销很小。
   */

  /** 斜条纹图案（按屏幕像素算尺寸，缩放变了换一块；缓存起来别每帧新建） */
  var antsTiles = {};
  function antsTile(cell) {
    var k = String(cell);
    if (antsTiles[k]) return antsTiles[k];
    var t = document.createElement('canvas');
    t.width = cell; t.height = cell;
    var c = t.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, cell, cell);
    c.save();
    c.translate(cell / 2, cell / 2);
    c.rotate(-Math.PI / 4);
    c.fillStyle = 'rgba(20,24,32,.95)';
    // 45° 等宽条纹，间距 = cell*√2（投到 x/y 上正好等于 cell）→ 平铺无缝
    var span = cell * Math.SQRT2;
    for (var i = -2; i <= 2; i++) c.fillRect(i * span, -span, span / 2, span * 3);
    c.restore();
    antsTiles[k] = t;
    return t;
  }

  /** 轮廓带的粗细（文档像素）：按**屏幕**算 —— 缩得越小，腐蚀半径越大，
   *  这样不管放大到 400% 还是缩到 20%，屏幕上那条蚂蚁线都差不多粗细（PS 就是这个手感）。 */
  CanvasEngine.prototype.selectionBandRadius = function () {
    return Math.max(1, Math.min(4, Math.round(1 / Math.max(0.05, this.scale || 1))));
  };

  CanvasEngine.prototype.buildSelectionBand = function () {
    var s = this.selection;
    if (!s) return;
    var W = this.width, H = this.height;
    if (!s.band) s.band = mkCanvas(W, H, false);
    if (!s.bandTmp) s.bandTmp = mkCanvas(W, H, false);
    if (!s.bandTmp2) s.bandTmp2 = mkCanvas(W, H, false);
    var r = this.selectionBandRadius();
    // ① 反复求「腐蚀」r 次：每一步 = 四个方向各平移 1px 的蒙版求交集 ——
    //    留下的就是「四邻都被选中」的内部像素（贴画布边的那一圈会自然出局，
    //    语义正好：边缘像素的邻居在画布外 = 没选中 → 它属于轮廓）。
    var inC = s.canvas;
    for (var k = 0; k < r; k++) {
      var out = (k % 2 === 0) ? s.bandTmp : s.bandTmp2;
      var oc = out.ctx;
      clearCtx(oc, W, H);
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.globalAlpha = 1;
      oc.globalCompositeOperation = 'source-over';
      oc.drawImage(inC, 1, 0);
      oc.globalCompositeOperation = 'destination-in';
      oc.drawImage(inC, -1, 0);
      oc.drawImage(inC, 0, 1);
      oc.drawImage(inC, 0, -1);
      oc.globalCompositeOperation = 'source-over';
      inC = out.canvas;
    }
    // ② 蒙版 − 腐蚀 = r 像素宽的轮廓带
    var bc = s.band.ctx;
    clearCtx(bc, W, H);
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalAlpha = 1;
    bc.globalCompositeOperation = 'source-over';
    bc.drawImage(s.canvas, 0, 0);
    bc.globalCompositeOperation = 'destination-out';
    bc.drawImage(inC, 0, 0);
    bc.globalCompositeOperation = 'source-over';
    s.bandDirty = false;
    s.bandRadius = r;
  };

  /** 把蚂蚁线画到 overlay 上（沿真实形状，不是包围盒） */
  CanvasEngine.prototype.drawSelectionAnts = function (c) {
    var s = this.selection;
    if (!s || !s.active) return;
    if (!s.bbox) return;
    // 蒙版变了（bandDirty）或者缩放变了（粗细跟着屏幕走）都要重算轮廓
    if (s.bandDirty || !s.band || s.bandRadius !== this.selectionBandRadius()) this.buildSelectionBand();
    var bb = s.bbox;
    var pad = 3;
    var x = Math.max(0, Math.floor(bb.x) - pad);
    var y = Math.max(0, Math.floor(bb.y) - pad);
    var w = Math.min(this.width - x, Math.ceil(bb.w) + pad * 2);
    var h = Math.min(this.height - y, Math.ceil(bb.h) + pad * 2);
    if (w <= 0 || h <= 0) return;
    // 屏幕上看着差不多大的斜条纹：cell 是**文档像素**，除以 scale 换算回屏幕
    var cell = Math.max(4, Math.min(24, Math.round(8 / Math.max(0.05, this.scale || 1))));
    if (!s.ants || s.ants.width !== w || s.ants.height !== h) {
      s.ants = document.createElement('canvas');
      s.ants.width = w; s.ants.height = h;
      s.antsCtx = s.ants.getContext('2d');
    }
    var ac = s.antsCtx;
    ac.setTransform(1, 0, 0, 1, 0, 0);
    ac.globalAlpha = 1;
    ac.globalCompositeOperation = 'source-over';
    clearCtx(ac, w, h);
    ac.drawImage(s.band.canvas, x, y, w, h, 0, 0, w, h);
    ac.globalCompositeOperation = 'source-in';
    var pat = ac.createPattern(antsTile(cell), 'repeat');
    // 条纹随时间平移 = 蚂蚁在爬（大约每 300ms 走一格）
    var phase = ((Date.now() / 300) % 1) * cell;
    if (pat && pat.setTransform && typeof DOMMatrix === 'function') {
      try { pat.setTransform(new DOMMatrix([1, 0, 0, 1, phase, phase])); } catch (e) { /* 老浏览器：不爬也行 */ }
    }
    ac.fillStyle = pat;
    ac.fillRect(0, 0, w, h);
    ac.globalCompositeOperation = 'source-over';
    c.drawImage(s.ants, x, y);
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
        // 蒙版与剪贴的状态**必须进键**。少它们的后果：远端把某层的
        // 「套上/摘掉蒙版」或「设成剪贴蒙版」广播过来时，图层数组的
        // 长度 / 顺序 / 可见性全都没变 → 键一样 → 复用旧基底，
        // 屏幕上那一层看着像根本没变（用户反馈的「看不到某一图层」有一路就是它）。
        return l.id + (l.visible ? '1' : '0') + l.opacity + l.blend + ':' +
          l.groupId + ':' +
          l.strokes.length + '/' + (l.baseSeq || 0) + '/' + (l.alphaLock ? 1 : 0) + '/' +
          (l.hasMask ? 1 : 0) + (l.maskEnabled === false ? 0 : 1) + (l.clip ? 1 : 0);
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
    // 「只要这几层」：魔棒取样来源 = 指定为选区样本的图层时用（onlyLayer 只认一层）
    var only = opts.onlyLayers || null;
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
        var mem = unit.layers.filter(function (x) {
          return x.visible && (!only || only.indexOf(x.id) >= 0);
        });
        if (!mem.length) continue;
        this.renderGroupInto(out.ctx, unit.group, mem, tmp, includeActive);
        continue;
      }
      var l = unit.layers[0];
      if (opts.onlyLayer && opts.onlyLayer !== l.id) continue;
      if (only && only.indexOf(l.id) < 0) continue;
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
      // ★ v2.0.10：刚建出来的蒙版也要刷新那张缩略图（否则面板上是一块空白占位）
      this.markLayerThumb(layer);
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
    // ★ v2.0.10：蒙版改了就刷新那张蒙版缩略图（面板上要能看出遮住了哪块）
    this.markLayerThumb(layer);
    if (!silent) { this.baseDirty = true; this.baseKey = ''; }
  };

  /** 蒙版来自像素（导入 / 固化）时的入口：dataUrl 传空串表示摘掉 */
  CanvasEngine.prototype.setMaskImage = function (layer, dataUrl) {
    var self = this;
    if (!layer) return;
    this.markLayerThumb(layer);      // ★ v2.0.10：蒙版缩略图跟着刷新
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
      // ⚠ 这里必须取**显示那份**（displayCanvas），不能直接用 below.canvas。
      // 下面那层的 srcCanvas 传进来的已经是 displayCanvas/layer.canvas 了，
      // 剪贴的底却读原始像素的话，两边取的不是同一份内容 ——
      // 协作视图开着、或下面那层还有未提交笔迹时，剪贴范围会和实际显示对不上
      // （表现就是「上面那层被裁掉一大块 / 某一层看着像消失了」）。
      if (below && below.canvas && this.layerDrawable(below)) clipSrc = this.displayCanvas(below);
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

  /**
   * 把一份「笔迹数组」渲染成一张图（白底）—— 接龙专用。
   *
   * 猜词阶段拿到的题面是上家的**笔迹数据**（不是 PNG），本地渲成图展示；
   * 回放阶段每幅画的缩略 / 大图也走这里。渲染路径与回放共用
   * （replayStampOne：普通笔迹 / 油漆桶 / 模糊都能吃），保证「猜的时候看到的」
   * 和「回放里看到的」跟作者当时画出来的完全一致。
   *
   * @param {Array} strokes 服务端收格时存下的笔迹数组（engine 原生格式）
   * @param {string} [bg] 背景色（默认白色；传 'transparent' 就不铺底）
   */
  CanvasEngine.prototype.renderStrokesPNG = function (strokes, bg) {
    var c = mkCanvas(this.width, this.height, false);
    if (bg !== 'transparent') {
      c.ctx.fillStyle = bg || '#ffffff';
      c.ctx.fillRect(0, 0, this.width, this.height);
    }
    var self = this;
    (strokes || []).forEach(function (s) {
      try { self.replayStampOne(c.ctx, c.canvas, s); } catch (e) { /* 单笔坏了别拖垮整幅 */ }
    });
    return c.canvas.toDataURL('image/png');
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
          // ★ v2.0.10：蒙版也有自己的缩略图（SAI2 在图层缩略图右边挂一张）——
          //   没有它的话，面板上根本看不出这一层有没有蒙版、遮住了哪一块。
          if (l.hasMask && l.maskCanvas) {
            var mc = document.createElement('canvas');
            mc.width = 60; mc.height = 38;
            var mx = mc.getContext('2d');
            mx.fillStyle = '#fff'; mx.fillRect(0, 0, 60, 38);
            mx.drawImage(l.maskCanvas, 0, 0, 60, 38);
            l.maskThumb = mc.toDataURL('image/png');
          } else {
            l.maskThumb = '';
          }
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

    // 选区提示：半透明蓝 + **沿选区真实形状**的走动虚线（蚂蚁线）
    // 变换中不画：那时选区的像素已经被「拿起来」了，再罩一层蓝色只会挡住变换预览
    if (this.hasSelection() && !this.replayMode && !this.transform) {
      if (!this.selection.bbox) this.refreshSelectionTint();
      c.globalAlpha = 1;
      c.drawImage(this.selection.tint, 0, 0);
      // ★ 2.0.9：套索套出来的圈就是圈的虚线，不再是包围盒那个方框
      this.drawSelectionAnts(c);
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
        // ★ 2.0.9：套索拖拽时**只画那条线**，绝不画回程 —— 和 PS 一样，
        //   松手才闭合成圈（闭合那一刻的选区由 endStroke → applySelectionStroke 落下来）。
        //   原来这里 closePath()，于是「一来就出现一个圈」，用户原话：「应该是画线连接后再出现圈」。
        c.moveTo(pv.points[0][0], pv.points[0][1]);
        for (var li = 1; li < pv.points.length; li++) c.lineTo(pv.points[li][0], pv.points[li][1]);
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
