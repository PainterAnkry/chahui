/**
 * 茶绘 · 尺子（对照 SAI2 的五种尺子形状）
 *
 *   直线尺   拖一条线，笔画被吸附到这条直线上
 *   椭圆尺   拖一个框，笔画被吸附到这个椭圆上（可旋转）
 *   平行线尺 拖出方向，笔画吸附到一族平行线上
 *   同心圆尺 拖出圆心与半径，笔画吸附到一族同心圆上
 *   集中线尺 拖出圆心与方向，笔画吸附到一族放射线上
 *
 * 关键设计：**吸附发生在取点的时候**（engine.addPoints 里对本地笔迹做），
 * 所以笔迹里存的就是吸附后的点、上传的也是吸附后的点 ——
 * 别人那边原样重放即可，不会因为各自的尺子不同而画出两样东西。
 * 远端来的点**绝不**再吸附一次（否则我换个尺子就把别人的线掰弯了）。
 *
 * 外观与交互对照 SAI2：
 *   · 吸附区是一条约 34px（屏幕像素）宽的**半透明青色带 / 环**，铺满画布；
 *   · 中央（椭圆：环本身）有一段**深色把手**，拖它 = 移动整把尺子；
 *   · 把手两端（椭圆：外圈蓝线上的圆点）是**旋钮**，拖它 = 旋转；
 *   · 中心一个青色小十字标记基准点。
 * 几何全部只用「两个点 + 一个间隔（+ 椭圆的旋转角）」就够。
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
  var MAX_RINGS = 90;          // 同心圆尺一圈圈画出来的上限（防 zsff 极小间隔卡死）

  /* ---- SAI2 观感的尺寸与配色（屏幕像素，绘制时 /scale 转成文档坐标） ---- */
  var BAND = 34;               // 吸附带 / 环的宽度
  var HANDLE_LEN = 180;        // 直线 / 平行线把手长度
  var HANDLE_W = 6;            // 把手粗细
  var KNOB_R = 5.5;            // 旋钮半径
  var CROSS = 8;               // 中心十字半长
  var BLUE_OFF = 14;           // 椭圆外圈蓝线离环的距离
  var KNOB_ANGLE = 1.15;       // 椭圆旋钮的初始方位角（约 4 点半方向，同 SAI2）

  var GUIDE_FILL = 'rgba(64, 205, 170, .38)';
  var GUIDE_LINE = 'rgba(34, 170, 138, .62)';
  var RAIL_BLUE = 'rgba(96, 148, 214, .8)';
  var HANDLE_FILL = 'rgba(42, 54, 70, .92)';
  var HANDLE_EDGE = 'rgba(235, 245, 242, .55)';
  var CROSS_COLOR = 'rgba(22, 168, 132, .95)';

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
      rot: 0,
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
   * 吸附到椭圆上（支持 rot 旋转：先转到椭圆坐标系里投影，再转回来）。
   * 精确的「最近点」要迭代求解；这里用「归一化到圆 → 径向投影 → 变回去」，
   * 对尺子来说足够（点在椭圆上、且连续、可复现），也快。
   */
  function snapEllipse(r, x, y) {
    var cx = (r.p0.x + r.p1.x) / 2, cy = (r.p0.y + r.p1.y) / 2;
    var a = Math.abs(r.p1.x - r.p0.x) / 2, b = Math.abs(r.p1.y - r.p0.y) / 2;
    if (a < 0.5 || b < 0.5) return { x: r.p0.x, y: r.p0.y };
    var rot = r.rot || 0, cos = Math.cos(-rot), sin = Math.sin(-rot);
    var dx = x - cx, dy = y - cy;
    var u = (dx * cos - dy * sin) / a, v = (dx * sin + dy * cos) / b;
    var len = Math.hypot(u, v);
    if (len < 1e-6) return { x: cx + a * Math.cos(rot), y: cy + a * Math.sin(rot) }; // 圆心：给个确定落点
    var rx = (u / len) * a, ry = (v / len) * b;
    var c2 = Math.cos(rot), s2 = Math.sin(rot);
    return { x: cx + rx * c2 - ry * s2, y: cy + rx * s2 + ry * c2 };
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

  /* ============================================================ 操作（移动 / 旋转） */

  /** 尺子的「基准点」：直线 / 平行线 = 把手中点，椭圆 = 中心，圆 / 放射 = 圆心 */
  function centerOf(r) {
    if (r.type === 'ellipse') {
      return { x: (r.p0.x + r.p1.x) / 2, y: (r.p0.y + r.p1.y) / 2 };
    }
    if (r.type === 'circle' || r.type === 'radial') return { x: r.p0.x, y: r.p0.y };
    return { x: (r.p0.x + r.p1.x) / 2, y: (r.p0.y + r.p1.y) / 2 };
  }

  /** 平移整把尺子 */
  function moveBy(r, dx, dy) {
    r.p0.x += dx; r.p0.y += dy;
    if (r.type === 'line' || r.type === 'parallel' || r.type === 'ellipse') {
      r.p1.x += dx; r.p1.y += dy;
    }
  }

  /** 把直线 / 平行线尺绕基准点转到指定角度（长度不变） */
  function setAngle(r, angle) {
    if (r.type !== 'line' && r.type !== 'parallel') return;
    var c = centerOf(r);
    var half = r.len / 2;
    r.p0 = { x: c.x - Math.cos(angle) * half, y: c.y - Math.sin(angle) * half };
    r.p1 = { x: c.x + Math.cos(angle) * half, y: c.y + Math.sin(angle) * half };
  }

  /**
   * 命中测试（文档坐标，tol 也是文档单位）。
   * 返回 'rotate'（旋钮）/ 'move'（把手）/ null。旋钮优先于把手。
   */
  function hitTest(r, x, y, tol) {
    if (!r || !r.type) return null;
    var d = function (px, py) { return Math.hypot(x - px, y - py); };
    if (r.type === 'line' || r.type === 'parallel') {
      var dx = r.p1.x - r.p0.x, dy = r.p1.y - r.p0.y;
      var L = Math.hypot(dx, dy) || 1;
      var ux = dx / L, uy = dy / L;
      var c = centerOf(r);
      var hl = HANDLE_LEN;
      var k0 = { x: c.x - ux * hl / 2, y: c.y - uy * hl / 2 };
      var k1 = { x: c.x + ux * hl / 2, y: c.y + uy * hl / 2 };
      if (d(k0.x, k0.y) <= tol * 1.5 || d(k1.x, k1.y) <= tol * 1.5) return 'rotate';
      // 到把手线段的距离
      var t = Math.max(-hl / 2, Math.min(hl / 2, (x - c.x) * ux + (y - c.y) * uy));
      if (d(c.x + ux * t, c.y + uy * t) <= tol) return 'move';
      return null;
    }
    if (r.type === 'ellipse') {
      var C = centerOf(r);
      var a = Math.abs(r.p1.x - r.p0.x) / 2, b = Math.abs(r.p1.y - r.p0.y) / 2;
      var rot = r.rot || 0;
      var ka = rot + KNOB_ANGLE;
      var R = Math.max(a, b) + BLUE_OFF;
      if (d(C.x + Math.cos(ka) * R, C.y + Math.sin(ka) * R) <= tol * 1.6) return 'rotate';
      if (d(C.x, C.y) <= tol) return 'move';
      // 到环的近似距离：归一化半径偏离 1 的量 × 平均半径
      var co = Math.cos(-rot), si = Math.sin(-rot);
      var ddx = x - C.x, ddy = y - C.y;
      var u = (ddx * co - ddy * si) / a, v = (ddx * si + ddy * co) / b;
      var f = Math.hypot(u, v);
      if (Math.abs((f - 1) * (a + b) / 2) <= tol) return 'move';
      return null;
    }
    // circle / radial：抓住圆心就能拖
    if (d(r.p0.x, r.p0.y) <= tol * 1.6) return 'move';
    return null;
  }

  /* ============================================================ 绘制 */

  /**
   * 画出尺子本身（供 overlay 用，ctx 已在文档坐标系，scale 是当前缩放）。
   * 所有「屏幕像素」尺寸都 /scale 转成文档单位，保证任何缩放下粗细恒定。
   */
  function draw(ctx, r, W, H, scale) {
    if (!r || !r.type) return;
    var s = Math.max(scale || 1, 0.02);
    var px = function (v) { return v / s; };
    var diag = Math.hypot(W, H);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (r.type === 'line') {
      var dir = norm(r.p1.x - r.p0.x, r.p1.y - r.p0.y);
      var M = centerOf(r);
      band(ctx, M, dir, diag + px(80), px(BAND));
      handle(ctx, M, dir, px(HANDLE_LEN), px(HANDLE_W));
      cross(ctx, M, px(CROSS), HANDLE_EDGE);
    } else if (r.type === 'ellipse') {
      var C = centerOf(r);
      var a = Math.abs(r.p1.x - r.p0.x) / 2, b = Math.abs(r.p1.y - r.p0.y) / 2;
      var rot = r.rot || 0;
      var hb = px(BAND) / 2;
      // 青色环：外椭圆 + 内椭圆 evenodd
      ctx.beginPath();
      ctx.ellipse(C.x, C.y, a + hb, b + hb, rot, 0, Math.PI * 2);
      ctx.ellipse(C.x, C.y, Math.max(a - hb, 1), Math.max(b - hb, 1), rot, 0, Math.PI * 2);
      ctx.fillStyle = GUIDE_FILL;
      ctx.fill('evenodd');
      // 环的中线描一圈，边界更清楚
      ctx.beginPath();
      ctx.ellipse(C.x, C.y, a, b, rot, 0, Math.PI * 2);
      ctx.strokeStyle = GUIDE_LINE;
      ctx.lineWidth = px(1.2);
      ctx.stroke();
      // 外圈蓝线 = 旋钮的轨道（同 SAI2）
      var R = Math.max(a, b) + px(BLUE_OFF);
      ctx.beginPath();
      ctx.arc(C.x, C.y, R, 0, Math.PI * 2);
      ctx.strokeStyle = RAIL_BLUE;
      ctx.lineWidth = px(1.2);
      ctx.stroke();
      // 旋钮
      var ka = rot + KNOB_ANGLE;
      knob(ctx, C.x + Math.cos(ka) * R, C.y + Math.sin(ka) * R, px(KNOB_R));
      // 中心十字
      cross(ctx, C, px(CROSS), CROSS_COLOR);
    } else if (r.type === 'parallel') {
      var ddx = r.p1.x - r.p0.x, ddy = r.p1.y - r.p0.y;
      var DL = Math.hypot(ddx, ddy) || 1;
      var ux = ddx / DL, uy = ddy / DL;
      var nx = -uy, ny = ux;
      var ext = diag + px(80);
      var n = Math.min(Math.ceil(ext / r.spacing / 2), 140);
      ctx.strokeStyle = GUIDE_LINE;
      ctx.lineWidth = px(1.8);
      for (var k = -n; k <= n; k++) {
        var ox = r.p0.x + nx * k * r.spacing, oy = r.p0.y + ny * k * r.spacing;
        ctx.beginPath();
        ctx.moveTo(ox - ux * ext, oy - uy * ext);
        ctx.lineTo(ox + ux * ext, oy + uy * ext);
        ctx.stroke();
      }
      // 基准线加一条半透明吸附带 + 把手
      var bandDir = { x: ux, y: uy };
      band(ctx, r.p0, bandDir, ext, px(BAND));
      handle(ctx, r.p0, bandDir, px(HANDLE_LEN), px(HANDLE_W));
      cross(ctx, r.p0, px(CROSS), HANDLE_EDGE);
    } else if (r.type === 'circle') {
      // 只画到「画布四角里最远的那个」：中心在画布外时不再把屏幕外也铺满环
      var cx0 = r.p0.x, cy0 = r.p0.y;
      var maxR = Math.max(
        Math.hypot(cx0, cy0), Math.hypot(W - cx0, cy0),
        Math.hypot(cx0, H - cy0), Math.hypot(W - cx0, H - cy0)
      ) + px(40);
      var rings = Math.min(Math.ceil(maxR / r.spacing), MAX_RINGS);
      for (var rr = 1; rr <= rings; rr++) {
        var rad = rr * r.spacing;
        ctx.beginPath();
        ctx.arc(cx0, cy0, rad, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(64, 205, 170, .20)';
        ctx.lineWidth = px(BAND * 0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx0, cy0, rad, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34, 170, 138, .5)';
        ctx.lineWidth = px(1.1);
        ctx.stroke();
      }
      // 圆心把手：小号深色圆点 + 青十字
      ctx.beginPath();
      ctx.arc(cx0, cy0, px(5), 0, Math.PI * 2);
      ctx.fillStyle = HANDLE_FILL;
      ctx.fill();
      ctx.strokeStyle = HANDLE_EDGE;
      ctx.lineWidth = px(1.1);
      ctx.stroke();
      cross(ctx, r.p0, px(5.5), CROSS_COLOR);
    } else if (r.type === 'radial') {
      var base = Math.atan2(r.p1.y - r.p0.y, r.p1.x - r.p0.x);
      var extR = diag * 0.75 + px(40);
      ctx.strokeStyle = GUIDE_LINE;
      ctx.lineWidth = px(1.8);
      for (var i = 0; i < SPOKES; i++) {
        var ang = base + i * Math.PI * 2 / SPOKES;
        ctx.beginPath();
        ctx.moveTo(r.p0.x, r.p0.y);
        ctx.lineTo(r.p0.x + Math.cos(ang) * extR, r.p0.y + Math.sin(ang) * extR);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(r.p0.x, r.p0.y, px(5), 0, Math.PI * 2);
      ctx.fillStyle = HANDLE_FILL;
      ctx.fill();
      ctx.strokeStyle = HANDLE_EDGE;
      ctx.lineWidth = px(1.1);
      ctx.stroke();
      cross(ctx, r.p0, px(5.5), CROSS_COLOR);
    }
    ctx.restore();
  }

  /* ---- 绘制小件 ---- */

  function norm(x, y) {
    var L = Math.hypot(x, y) || 1;
    return { x: x / L, y: y / L };
  }

  /** 半透明吸附带：过 base、方向 dir、长 len、宽 w */
  function band(ctx, base, dir, len, w) {
    var hx = dir.x * len / 2, hy = dir.y * len / 2;
    var nx = -dir.y * w / 2, ny = dir.x * w / 2;
    ctx.beginPath();
    ctx.moveTo(base.x - hx + nx, base.y - hy + ny);
    ctx.lineTo(base.x + hx + nx, base.y + hy + ny);
    ctx.lineTo(base.x + hx - nx, base.y + hy - ny);
    ctx.lineTo(base.x - hx - nx, base.y - hy - ny);
    ctx.closePath();
    ctx.fillStyle = GUIDE_FILL;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(base.x - hx + nx, base.y - hy + ny);
    ctx.lineTo(base.x + hx + nx, base.y + hy + ny);
    ctx.moveTo(base.x + hx - nx, base.y + hy - ny);
    ctx.lineTo(base.x - hx - nx, base.y - hy - ny);
    ctx.strokeStyle = GUIDE_LINE;
    ctx.lineWidth = Math.min(w, 1.2) > 0 ? Math.max(1, w * 0.04) : 1;
    ctx.stroke();
  }

  /** 深色把手（拖 = 移动） */
  function handle(ctx, base, dir, len, w) {
    var hx = dir.x * len / 2, hy = dir.y * len / 2;
    ctx.beginPath();
    ctx.moveTo(base.x - hx, base.y - hy);
    ctx.lineTo(base.x + hx, base.y + hy);
    ctx.strokeStyle = HANDLE_FILL;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.stroke();
    // 两端旋钮
    knob(ctx, base.x - hx, base.y - hy, w * 0.95);
    knob(ctx, base.x + hx, base.y + hy, w * 0.95);
  }

  /** 旋钮（拖 = 旋转） */
  function knob(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 2.5), 0, Math.PI * 2);
    ctx.fillStyle = HANDLE_FILL;
    ctx.fill();
    ctx.strokeStyle = HANDLE_EDGE;
    ctx.lineWidth = Math.max(r * 0.28, 0.8);
    ctx.stroke();
  }

  /** 中心十字 */
  function cross(ctx, p, half, color) {
    ctx.beginPath();
    ctx.moveTo(p.x - half, p.y); ctx.lineTo(p.x + half, p.y);
    ctx.moveTo(p.x, p.y - half); ctx.lineTo(p.x, p.y + half);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(half * 0.28, 1);
    ctx.lineCap = 'round';
    ctx.stroke();
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
    draw: draw,
    centerOf: centerOf,
    moveBy: moveBy,
    setAngle: setAngle,
    hitTest: hitTest
  };
})(window);
