/**
 * 茶绘 · 尺子（对照 SAI2 的五种尺子形状）
 *
 *   直线尺   拖一条线，笔画被吸附到这条直线上
 *   椭圆尺   拖一个框，笔画被吸附到这个椭圆上
 *   平行线尺 拖出方向，笔画吸附到一族平行线上
 *   同心圆尺 拖出圆心与半径，笔画吸附到一族同心圆上
 *   集中线尺 拖出圆心与方向，笔画吸附到一族放射线上
 *
 * 关键设计：**吸附发生在取点的时候**（engine.addPoints 里对本地笔迹做），
 * 所以笔迹里存的就是吸附后的点、上传的也是吸附后的点 ——
 * 别人那边原样重放即可，不会因为各自的尺子不同而画出两样东西。
 * 远端来的点**绝不**再吸附一次（否则我换个尺子就把别人的线掰弯了）。
 *
 * 几何全部只用「两个点 + 一个间隔」就够：拖拽的两个端点定义形状，
 * 间隔（平行线 / 同心圆的疏密）取拖拽长度的一个固定比例，这样不用再加参数。
 */
(function (global) {
  'use strict';

  var TYPES = [
    { id: 'line', name: '直线尺', hint: '拖一条线，笔画会吸附到这条直线上' },
    { id: 'ellipse', name: '椭圆尺', hint: '拖一个框，笔画会吸附到这个椭圆上' },
    { id: 'parallel', name: '平行线尺', hint: '拖出方向，笔画吸附到一族平行线上' },
    { id: 'circle', name: '同心圆尺', hint: '拖出圆心和半径，笔画吸附到一族同心圆上' },
    { id: 'radial', name: '集中线尺', hint: '拖出圆心和方向，笔画吸附到一族放射线上' }
  ];

  var SPOKES = 24;             // 集中线尺的放射条数
  var SPACING_RATIO = 0.3;     // 间隔 = 拖拽长度 × 这个比例
  var MIN_SPACING = 6;         // 间隔下限（像素）

  function typeOf(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return null;
  }

  function make(type, p0, p1) {
    if (!typeOf(type) || !p0 || !p1) return null;
    var len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    return {
      type: type,
      p0: { x: p0.x, y: p0.y },
      p1: { x: p1.x, y: p1.y },
      len: len,
      spacing: Math.max(MIN_SPACING, len * SPACING_RATIO)
    };
  }

  /** 把点投到过 p0/p1 的**无限长直线**上 */
  function snapLine(r, x, y) {
    var dx = r.p1.x - r.p0.x, dy = r.p1.y - r.p0.y;
    var L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) return { x: r.p0.x, y: r.p0.y };
    var t = ((x - r.p0.x) * dx + (y - r.p0.y) * dy) / L2;
    return { x: r.p0.x + dx * t, y: r.p0.y + dy * t };
  }

  /**
   * 吸附到椭圆上。
   * 精确的「最近点」要迭代求解；这里用「归一化到圆 → 径向投影 → 变回去」，
   * 对尺子来说足够（点在椭圆上、且连续、可复现），也快。
   */
  function snapEllipse(r, x, y) {
    var cx = (r.p0.x + r.p1.x) / 2, cy = (r.p0.y + r.p1.y) / 2;
    var a = Math.abs(r.p1.x - r.p0.x) / 2, b = Math.abs(r.p1.y - r.p0.y) / 2;
    if (a < 0.5 || b < 0.5) return { x: r.p0.x, y: r.p0.y };
    var u = (x - cx) / a, v = (y - cy) / b;
    var len = Math.hypot(u, v);
    if (len < 1e-6) return { x: cx + a, y: cy };      // 正好在圆心：给个确定的落点
    return { x: cx + (u / len) * a, y: cy + (v / len) * b };
  }

  /** 吸附到一族平行线（方向 p0→p1，间隔 r.spacing） */
  function snapParallel(r, x, y) {
    var dx = r.p1.x - r.p0.x, dy = r.p1.y - r.p0.y;
    var L = Math.hypot(dx, dy);
    if (L < 1e-9) return { x: x, y: y };
    var nx = -dy / L, ny = dx / L;                    // 法线
    var off = (x - r.p0.x) * nx + (y - r.p0.y) * ny;
    var k = Math.round(off / r.spacing);
    var d = off - k * r.spacing;
    return { x: x - nx * d, y: y - ny * d };
  }

  /** 吸附到一族同心圆（圆心 p0，间隔 r.spacing） */
  function snapCircle(r, x, y) {
    var dx = x - r.p0.x, dy = y - r.p0.y;
    var dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { x: r.p0.x + r.spacing, y: r.p0.y };
    var n = Math.max(1, Math.round(dist / r.spacing));
    var nr = n * r.spacing;
    return { x: r.p0.x + dx / dist * nr, y: r.p0.y + dy / dist * nr };
  }

  /** 吸附到一族放射线（圆心 p0，条数 SPOKES，第一条过 p1） */
  function snapRadial(r, x, y) {
    var dx = x - r.p0.x, dy = y - r.p0.y;
    var dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { x: r.p0.x, y: r.p0.y };
    var base = Math.atan2(r.p1.y - r.p0.y, r.p1.x - r.p0.x);
    var step = Math.PI * 2 / SPOKES;
    var ang = Math.atan2(dy, dx) - base;
    var k = Math.round(ang / step);
    var a = base + k * step;
    return { x: r.p0.x + Math.cos(a) * dist, y: r.p0.y + Math.sin(a) * dist };
  }

  /** 按尺子类型吸附一个点；没有尺子就原样返回 */
  function snap(r, x, y) {
    if (!r || !r.type) return { x: x, y: y };
    switch (r.type) {
      case 'line': return snapLine(r, x, y);
      case 'ellipse': return snapEllipse(r, x, y);
      case 'parallel': return snapParallel(r, x, y);
      case 'circle': return snapCircle(r, x, y);
      case 'radial': return snapRadial(r, x, y);
      default: return { x: x, y: y };
    }
  }

  /**
   * 画出尺子本身（供 overlay 用）。
   * 只画「看得见的那部分」：直线尺画长一点、同心圆画 3 圈、放射线画 48 条。
   */
  function draw(ctx, r, W, H, scale) {
    if (!r || !r.type) return;
    var s = Math.max(scale || 1, 0.02);
    ctx.save();
    ctx.lineWidth = 1 / s;
    ctx.setLineDash([5 / s, 4 / s]);
    ctx.strokeStyle = 'rgba(40,110,255,.55)';
    var cx = W / 2, cy = H / 2;

    if (r.type === 'line') {
      var dx = r.p1.x - r.p0.x, dy = r.p1.y - r.p0.y;
      var L = Math.hypot(dx, dy) || 1;
      var ext = Math.hypot(W, H);                     // 拉到整幅对角那么长
      ctx.beginPath();
      ctx.moveTo(r.p0.x - dx / L * ext, r.p0.y - dy / L * ext);
      ctx.lineTo(r.p0.x + dx / L * ext, r.p0.y + dy / L * ext);
      ctx.stroke();
      ctx.setLineDash([]);
      dot(ctx, r.p0, s); dot(ctx, r.p1, s);
    } else if (r.type === 'ellipse') {
      var ax = (r.p1.x - r.p0.x) / 2, ay = (r.p1.y - r.p0.y) / 2;
      ctx.beginPath();
      ctx.ellipse(r.p0.x + ax, r.p0.y + ay, Math.abs(ax), Math.abs(ay), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeRect(Math.min(r.p0.x, r.p1.x), Math.min(r.p0.y, r.p1.y), Math.abs(r.p1.x - r.p0.x), Math.abs(r.p1.y - r.p0.y));
      dot(ctx, r.p0, s); dot(ctx, r.p1, s);
    } else if (r.type === 'parallel') {
      var ddx = r.p1.x - r.p0.x, ddy = r.p1.y - r.p0.y;
      var DL = Math.hypot(ddx, ddy) || 1;
      var nx = -ddy / DL, ny = ddx / DL;
      var ext2 = Math.hypot(W, H);
      var n = Math.ceil(ext2 / r.spacing / 2);
      for (var k = -n; k <= n; k++) {
        var ox = r.p0.x + nx * k * r.spacing, oy = r.p0.y + ny * k * r.spacing;
        ctx.beginPath();
        ctx.moveTo(ox - ddx / DL * ext2, oy - ddy / DL * ext2);
        ctx.lineTo(ox + ddx / DL * ext2, oy + ddy / DL * ext2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      dot(ctx, r.p0, s); dot(ctx, r.p1, s);
    } else if (r.type === 'circle') {
      var maxR = Math.hypot(W, H);
      for (var rr = r.spacing; rr <= maxR; rr += r.spacing) {
        ctx.beginPath();
        ctx.arc(r.p0.x, r.p0.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      dot(ctx, r.p0, s);
    } else if (r.type === 'radial') {
      var base = Math.atan2(r.p1.y - r.p0.y, r.p1.x - r.p0.x);
      var extR = Math.hypot(W, H) * 0.75;
      for (var i = 0; i < SPOKES; i++) {
        var a = base + i * Math.PI * 2 / SPOKES;
        ctx.beginPath();
        ctx.moveTo(r.p0.x, r.p0.y);
        ctx.lineTo(r.p0.x + Math.cos(a) * extR, r.p0.y + Math.sin(a) * extR);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      dot(ctx, r.p0, s);
    }
    ctx.restore();
    void cx; void cy;
  }

  function dot(ctx, p, s) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5 / s, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,60,140,.95)';
    ctx.lineWidth = 1.2 / s;
    ctx.stroke();
    ctx.restore();
  }

  global.ChaRuler = {
    TYPES: TYPES,
    SPOKES: SPOKES,
    typeOf: typeOf,
    make: make,
    snap: snap,
    snapLine: snapLine,
    snapEllipse: snapEllipse,
    snapParallel: snapParallel,
    snapCircle: snapCircle,
    snapRadial: snapRadial,
    draw: draw
  };
})(window);
