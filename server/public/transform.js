/**
 * 茶绘 · 图像变换（对照 SAI2 的「变换」面板）
 *
 * 三种模式（截图二里的单选）：
 *   自由变换  拖角 → 绕对角自由缩放；拖边中点 → 单轴拉伸
 *   缩放      拖角 → 等比缩放（Shift 反向约束）
 *   扭曲      拖角 → 四个角各自独立移动（做透视、斜切）
 *   旋转      拖动 → 绕中心旋转
 * 另外还有「透视」滑块与水平/垂直翻转、±90° 旋转。
 *
 * 渲染方式：把源图切成网格，逐格双线性插值映射到四角构成的目标四边形上，
 * 每格拆两个三角形用「解仿射 + clip」画。
 * 为什么不用逐像素反查：那是 1.6M 次 JS 运算，拖动时必卡；
 * 网格法交给 GPU，拖动流畅，而且**预览与最终提交走同一套代码**，
 * 所见即所得（这是变换功能最容易翻车的地方）。
 * 平行四边形（纯缩放/旋转/斜切）走单次 setTransform 的快路径。
 */
(function (global) {
  'use strict';

  var EPS = 0.01;

  function pt(x, y) { return { x: x, y: y }; }

  function quadCenter(q) {
    return pt((q[0].x + q[1].x + q[2].x + q[3].x) / 4,
      (q[0].y + q[1].y + q[2].y + q[3].y) / 4);
  }

  function rotatePt(p, c, ang) {
    var s = Math.sin(ang), co = Math.cos(ang);
    var dx = p.x - c.x, dy = p.y - c.y;
    return pt(c.x + dx * co - dy * s, c.y + dx * s + dy * co);
  }

  /** 四边形是不是平行四边形（可以用单次仿射变换画） */
  function isAffine(q) {
    var ex = q[0].x + q[2].x - q[1].x - q[3].x;
    var ey = q[0].y + q[2].y - q[1].y - q[3].y;
    return Math.abs(ex) < EPS && Math.abs(ey) < EPS;
  }

  function tri(ctx, img, s, d, W, H) {
    var denom = (s[1].x - s[0].x) * (s[2].y - s[0].y) - (s[2].x - s[0].x) * (s[1].y - s[0].y);
    if (Math.abs(denom) < 1e-9) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d[0].x, d[0].y);
    ctx.lineTo(d[1].x, d[1].y);
    ctx.lineTo(d[2].x, d[2].y);
    ctx.closePath();
    ctx.clip();
    var a = ((d[1].x - d[0].x) * (s[2].y - s[0].y) - (d[2].x - d[0].x) * (s[1].y - s[0].y)) / denom;
    var b = ((d[1].y - d[0].y) * (s[2].y - s[0].y) - (d[2].y - d[0].y) * (s[1].y - s[0].y)) / denom;
    var c = ((d[2].x - d[0].x) * (s[1].x - s[0].x) - (d[1].x - d[0].x) * (s[2].x - s[0].x)) / denom;
    var dd = ((d[2].y - d[0].y) * (s[1].x - s[0].x) - (d[1].y - d[0].y) * (s[2].x - s[0].x)) / denom;
    var e = d[0].x - a * s[0].x - c * s[0].y;
    var f = d[0].y - b * s[0].x - dd * s[0].y;
    ctx.setTransform(a, b, c, dd, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /** 双线性插值：单位方格坐标 (u,v) → 四边形内点 */
  function bilerp(q, u, v) {
    var top = pt(q[0].x + (q[1].x - q[0].x) * u, q[0].y + (q[1].y - q[0].y) * u);
    var bot = pt(q[3].x + (q[2].x - q[3].x) * u, q[3].y + (q[2].y - q[3].y) * u);
    return pt(top.x + (bot.x - top.x) * v, top.y + (bot.y - top.y) * v);
  }

  /**
   * 把 src 的 [sx,sy,sw,sh] 区域按 quad 画到 ctx 上（ctx 已处于文档坐标系）。
   */
  function drawQuad(ctx, src, sx, sy, sw, sh, quad, cells, pointAt) {
    if (sw <= 0 || sh <= 0) return;
    // pointAt 给了就用它算目标点（网格变换走这条），否则按四边形双线性插值
    var at = pointAt || function (u, v) { return bilerp(quad, u, v); };
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(ctx.getTransform());   // 保留调用方设好的文档变换

    if (!pointAt && isAffine(quad)) {
      // 快路径：整个源矩形一次仿射搞定
      var s = [pt(sx, sy), pt(sx + sw, sy), pt(sx + sw, sy + sh)];
      var d = [quad[0], quad[1], quad[2]];
      ctx.save();
      var denom = (s[1].x - s[0].x) * (s[2].y - s[0].y) - (s[2].x - s[0].x) * (s[1].y - s[0].y);
      var a = ((d[1].x - d[0].x) * (s[2].y - s[0].y) - (d[2].x - d[0].x) * (s[1].y - s[0].y)) / denom;
      var b = ((d[1].y - d[0].y) * (s[2].y - s[0].y) - (d[2].y - d[0].y) * (s[1].y - s[0].y)) / denom;
      var c = ((d[2].x - d[0].x) * (s[1].x - s[0].x) - (d[1].x - d[0].x) * (s[2].x - s[0].x)) / denom;
      var e2 = ((d[2].y - d[0].y) * (s[1].x - s[0].x) - (d[1].y - d[0].y) * (s[2].x - s[0].x)) / denom;
      var f2 = d[0].x - a * s[0].x - c * s[0].y;
      var g2 = d[0].y - b * s[0].x - e2 * s[0].y;
      ctx.transform(a, b, c, e2, f2, g2);
      ctx.drawImage(src, 0, 0);
      ctx.restore();
      ctx.restore();
      return;
    }

    // 网格路径：逐格双三角形
    var n = Math.max(1, cells || 10);
    var i, j;
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
        var s00 = pt(sx + sw * u0, sy + sh * v0);
        var s10 = pt(sx + sw * u1, sy + sh * v0);
        var s11 = pt(sx + sw * u1, sy + sh * v1);
        var s01 = pt(sx + sw * u0, sy + sh * v1);
        var d00 = at(u0, v0), d10 = at(u1, v0);
        var d11 = at(u1, v1), d01 = at(u0, v1);
        tri(ctx, src, [s00, s10, s11], [d00, d10, d11]);
        tri(ctx, src, [s00, s11, s01], [d00, d11, d01]);
      }
    }
    ctx.restore();
  }

  /**
   * 网格变换：把 (u,v) 映射到「N×N 网格」里的点。
   * 先在所属格子里做双线性插值 —— 这正是逐格双三角形渲染的逆运算，
   * 所以拖某个控制点之后的画面和网格线完全对得上。
   */
  function meshAt(mesh, u, v) {
    var N = mesh.length - 1;
    var fu = Math.min(N - 1e-9, Math.max(0, u * N));
    var fv = Math.min(N - 1e-9, Math.max(0, v * N));
    var i = Math.floor(fu), j = Math.floor(fv);
    var tu = fu - i, tv = fv - j;
    var p00 = mesh[j][i], p10 = mesh[j][i + 1], p01 = mesh[j + 1][i], p11 = mesh[j + 1][i + 1];
    var topX = p00.x + (p10.x - p00.x) * tu, topY = p00.y + (p10.y - p00.y) * tu;
    var botX = p01.x + (p11.x - p01.x) * tu, botY = p01.y + (p11.y - p01.y) * tu;
    return pt(topX + (botX - topX) * tv, topY + (botY - topY) * tv);
  }

  function meshCenter(mesh) {
    var N = mesh.length - 1;
    var x = 0, y = 0, n = 0;
    for (var j = 0; j <= N; j++) for (var i = 0; i <= N; i++) { x += mesh[j][i].x; y += mesh[j][i].y; n++; }
    return pt(x / n, y / n);
  }

  /* ============================================================ 会话 */

  function Session(engine, opt) {
    this.engine = engine;
    this.mode = 'free';                 // free | scale | distort | rotate
    this.persp = 100;                   // 100 = 无透视
    this.rotation = 0;
    this.cells = 12;
    // 源像素只保留「选区那一块」，尺寸就是 rect.w × rect.h —— 这是关键。
    // 以前这里放的是整幅文档的 canvas，于是翻转/90° 旋转是绕着**文档中心**做的，
    // 而变换框是绕着**选区中心**转的，两者一错位，内容就跑到选区外面去了。
    this.buf = opt.buf;
    this.rect = opt.rect;               // 源区域在文档里的位置（只用来摆初始四边形）
    this.layerId = opt.layerId;
    this.saved = opt.saved;             // 变换前该图层的完整像素（中止时还原）
    this.quad = [
      pt(this.rect.x, this.rect.y),
      pt(this.rect.x + this.rect.w, this.rect.y),
      pt(this.rect.x + this.rect.w, this.rect.y + this.rect.h),
      pt(this.rect.x, this.rect.y + this.rect.h)
    ];
    this.drag = null;
    // 网格变换：null = 关闭；开启时是 (meshN+1)×(meshN+1) 个控制点
    this.mesh = null;
    this.meshN = 3;
  }

  /** 透视滑块作用到四边形上（绕着上下边的中轴收放上边） */
  Session.prototype.effectiveQuad = function () {
    var q = this.quad;
    if (Math.abs(this.persp - 100) < 0.5) return q;
    var k = 1 - (100 - this.persp) / 100 * 0.6;
    var topCx = (q[0].x + q[1].x) / 2;
    return [
      pt(topCx + (q[0].x - topCx) * k, q[0].y),
      pt(topCx + (q[1].x - topCx) * k, q[1].y),
      q[2], q[3]
    ];
  };

  /**
   * 开关网格变换。开启时按当前四边形摊出一张 (n+1)×(n+1) 的网格，
   * 之后拖哪个控制点就只动那一个 —— 这就是 SAI2 的「网格变换」。
   */
  Session.prototype.setMesh = function (on, n) {
    if (!on) { this.mesh = null; return; }
    this.meshN = Math.max(1, Math.min(10, Math.round(n || this.meshN || 3)));
    var q = this.effectiveQuad();
    var N = this.meshN, rows = [];
    for (var j = 0; j <= N; j++) {
      var row = [];
      for (var i = 0; i <= N; i++) row.push(bilerp(q, i / N, j / N));
      rows.push(row);
    }
    this.mesh = rows;
  };

  /** 渲染用的 (u,v) → 点映射；没开网格就返回 null，交给 drawQuad 走四边形路径 */
  Session.prototype.effectivePointAt = function () {
    var m = this.mesh;
    if (!m) return null;
    return function (u, v) { return meshAt(m, u, v); };
  };

  /** 网格控制点在文档坐标下的位置（扁平数组，供命中测试与绘制） */
  Session.prototype.meshNodes = function () {
    var m = this.mesh;
    if (!m) return [];
    var N = m.length - 1, out = [];
    for (var j = 0; j <= N; j++) {
      for (var i = 0; i <= N; i++) out.push({ i: i, j: j, p: m[j][i] });
    }
    return out;
  };

  /** 手柄位置（文档坐标）：4 角 + 4 边中点 + 旋转柄 */
  Session.prototype.handles = function () {
    var q = this.quad;
    var m = function (a, b) { return pt((a.x + b.x) / 2, (a.y + b.y) / 2); };
    var c = quadCenter(q);
    // 旋转柄放在「上边中点再往外挪一点」的位置
    var topMid = m(q[0], q[1]);
    var dir = pt(topMid.x - c.x, topMid.y - c.y);
    var len = Math.hypot(dir.x, dir.y) || 1;
    var off = Math.max(len * 0.35, 18 / Math.max(this.engine.scale, 0.05));
    var rot = pt(topMid.x + dir.x / len * off, topMid.y + dir.y / len * off);
    return {
      nw: q[0], ne: q[1], se: q[2], sw: q[3],
      n: m(q[0], q[1]), e: m(q[1], q[2]), s: m(q[2], q[3]), w: m(q[3], q[0]),
      rotate: rot, center: c
    };
  };

  /** 命中测试；半径用屏幕像素给出，按缩放换算到文档坐标 */
  Session.prototype.hitTest = function (p, screenPx) {
    var r = (screenPx || 9) / Math.max(this.engine.scale, 0.02);
    // 网格变换开着的时候，控制点优先于四角 / 边中点手柄
    if (this.mesh) {
      var nodes = this.meshNodes();
      var best = null, bestD = r;
      for (var m = 0; m < nodes.length; m++) {
        var d = Math.hypot(p.x - nodes[m].p.x, p.y - nodes[m].p.y);
        if (d <= bestD) { bestD = d; best = nodes[m]; }
      }
      if (best) return 'mesh:' + best.j + ':' + best.i;
      // 网格模式下仍然允许整体拖动
      if (meshAt(this.mesh, 0.5, 0.5)) {
        var inMesh = pointInQuad(p, [this.mesh[0][0], this.mesh[0][this.meshN], this.mesh[this.meshN][this.meshN], this.mesh[this.meshN][0]]);
        if (inMesh) return 'move';
      }
      return null;
    }
    var h = this.handles();
    var keys = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w', 'rotate'];
    for (var i = 0; i < keys.length; i++) {
      var q = h[keys[i]];
      if (Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r) return keys[i];
    }
    if (pointInQuad(p, this.effectiveQuad())) return 'move';
    return null;
  };

  /** 点是否在四边形内。镜像之后绕向会反，所以两种绕向都要认。 */
  function pointInQuad(p, q) {
    var pos = 0, neg = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      var cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cross > 0) pos++;
      else if (cross < 0) neg++;
    }
    return pos === 0 || neg === 0;
  }

  Session.prototype.dragStart = function (handle, p) {
    this.drag = {
      handle: handle,
      start: p,
      quad0: this.quad.map(function (q) { return pt(q.x, q.y); }),
      center0: quadCenter(this.quad)
    };
    if (handle === 'rotate' || this.mode === 'rotate') {
      this.drag.ang0 = Math.atan2(p.y - this.drag.center0.y, p.x - this.drag.center0.x);
    }
    if (this.mesh) {
      this.drag.soft = !!global.__softMeshDrag;
      this.drag.mesh0 = this.mesh.map(function (row) {
        return row.map(function (q) { return pt(q.x, q.y); });
      });
    }
  };

  Session.prototype.dragMove = function (p, shift) {
    var d = this.drag;
    if (!d) return;
    var q = d.quad0.map(function (x) { return pt(x.x, x.y); });
    var c = d.center0;

    // 网格控制点：只动被抓的那一个；按住 Alt 连周围一起柔和地带动
    if (this.mesh && d.mesh0) {
      var mm = /^mesh:(\d+):(\d+)$/.exec(d.handle);
      if (mm) {
        var jj = +mm[1], ii = +mm[2];
        var dx = p.x - d.start.x, dy = p.y - d.start.y;
        var N = this.meshN;
        this.mesh = d.mesh0.map(function (row, j) {
          return row.map(function (node, i) {
            var k = 1;
            if (global.CtrlShape) { /* 占位，见下 */ }
            if (d.soft) {
              // 距离越远带得越少：0 环 = 1，1 环 = 0.5，2 环 = 0.2，更远不动
              var dd = Math.max(Math.abs(i - ii), Math.abs(j - jj));
              k = dd === 0 ? 1 : dd === 1 ? 0.5 : dd === 2 ? 0.2 : 0;
            } else if (i !== ii || j !== jj) {
              k = 0;
            }
            void N;
            return k === 0 ? pt(node.x, node.y) : pt(node.x + dx * k, node.y + dy * k);
          });
        });
        // 网格一动，四个角也跟着走，这样「确定」之后的外框和画面一致
        this.quad = [
          this.mesh[0][0], this.mesh[0][this.meshN],
          this.mesh[this.meshN][this.meshN], this.mesh[this.meshN][0]
        ];
        return;
      }
    }

    if (d.handle === 'rotate' || this.mode === 'rotate') {
      var ang = Math.atan2(p.y - c.y, p.x - c.x) - d.ang0;
      if (shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);   // Shift 吸附 15°
      for (var i = 0; i < 4; i++) q[i] = rotatePt(q[i], c, ang);
      this.quad = q;
      this.rotation += ang;
      return;
    }

    if (d.handle === 'move') {
      var dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (this.mesh) {
        var ddx = dx, ddy = dy;
        this.mesh = d.mesh0.map(function (row) {
          return row.map(function (node) { return pt(node.x + ddx, node.y + ddy); });
        });
        this.quad = [this.mesh[0][0], this.mesh[0][this.meshN],
          this.mesh[this.meshN][this.meshN], this.mesh[this.meshN][0]];
        return;
      }
      for (var k = 0; k < 4; k++) q[k] = pt(q[k].x + dx, q[k].y + dy);
      this.quad = q;
      return;
    }

    if (this.mode === 'distort') {
      // 扭曲：只动被抓的那个角
      var idx = { nw: 0, ne: 1, se: 2, sw: 3 }[d.handle];
      if (idx != null) { q[idx] = pt(p.x, p.y); this.quad = q; return; }
    }

    if (this.mode === 'scale' || this.mode === 'free') {
      var map = { nw: 0, ne: 1, se: 2, sw: 3 };
      var mi = map[d.handle];
      if (mi != null) {
        var opp = q[(mi + 2) % 4];             // 对角固定
        if (this.mode === 'scale') {
          var sw0 = (q[1].x - q[0].x), sh0 = (q[2].y - q[1].y);
          var kx = sw0 ? (p.x - opp.x) / (q[mi].x - opp.x || 1) : 1;
          var ky = sh0 ? (p.y - opp.y) / (q[mi].y - opp.y || 1) : 1;
          var kk = (Math.abs(kx) > Math.abs(ky)) ? Math.abs(kx) : Math.abs(ky);
          if (shift) kk = kk;                     // 已经是等比
          var sign = function (v) { return v < 0 ? -1 : 1; };
          kx = kk * sign(kx); ky = kk * sign(ky);
          for (var a = 0; a < 4; a++) {
            q[a] = pt(opp.x + (q[a].x - opp.x) * kx, opp.y + (q[a].y - opp.y) * ky);
          }
        } else {
          // 自由变换：对角固定，两轴各按拖动后的位置走
          var sxs = (q[mi].x - opp.x) || 1, sys = (q[mi].y - opp.y) || 1;
          var kx2 = (p.x - opp.x) / sxs, ky2 = (p.y - opp.y) / sys;
          for (var b = 0; b < 4; b++) {
            q[b] = pt(opp.x + (q[b].x - opp.x) * kx2, opp.y + (q[b].y - opp.y) * ky2);
          }
        }
        this.quad = q;
        return;
      }
      // 边中点：单轴拉伸
      var axis = { n: [0, 1], s: [2, 3], w: [3, 0], e: [1, 2] }[d.handle];
      if (axis) {
        var horiz = (d.handle === 'w' || d.handle === 'e');
        var delta = horiz ? (p.x - d.start.x) : (p.y - d.start.y);
        var opp0 = axis[0], opp1 = axis[1];
        var other = { n: [3, 2], s: [0, 1], w: [1, 2], e: [0, 3] }[d.handle];
        if (horiz) {
          q[opp0] = pt(q[opp0].x + delta, q[opp0].y);
          q[opp1] = pt(q[opp1].x + delta, q[opp1].y);
        } else {
          q[opp0] = pt(q[opp0].x, q[opp0].y + delta);
          q[opp1] = pt(q[opp1].x, q[opp1].y + delta);
        }
        void other;
        this.quad = q;
      }
    }
  };

  Session.prototype.dragEnd = function () { this.drag = null; };

  /**
   * 水平 / 垂直翻转。
   *
   * 关键：**只动变换框，不动源图**。
   * 之前是「源图绕自己的中心镜像」+「变换框绕自己的中心镜像」两个操作叠在一起 ——
   * 两次镜像互相抵消，画面看起来毫无变化（用户报的「翻转有 bug」就是这个）。
   * 现在把框镜像过去、源图原样贴上去：源图的 u 轴方向就反了，画面等于就地镜像，
   * 而框仍然停在原地（镜像一个平行四边形，它的外接框不变）。
   */
  Session.prototype.flip = function (axis) {
    var cq = quadCenter(this.quad);
    var f = function (p) {
      return axis === 'h' ? pt(2 * cq.x - p.x, p.y) : pt(p.x, 2 * cq.y - p.y);
    };
    this.quad = this.quad.map(f);
    if (this.mesh) this.mesh = this.mesh.map(function (row) { return row.map(f); });
    // 镜像会把四个角的绕向反过来，命中测试要能认出来（见 pointInQuad）
    this.mirrored = !this.mirrored;
  };

  /**
   * 顺时针 / 逆时针旋转 90°。同样只动变换框：
   * 把四个角绕框心转 90°，源图原样贴上去，画面就跟着转了 90°，
   * 而框自然变成「宽高互换」的样子（和 SAI2 一致）。
   * 之前是「源图转 90°」+「框转 90°」叠加 → 实际转了 180°。
   */
  Session.prototype.rotate90 = function (dir) {
    var nc = quadCenter(this.quad);
    var f = function (p) { return rotatePt(p, nc, dir * Math.PI / 2); };
    this.quad = this.quad.map(f);
    if (this.mesh) this.mesh = this.mesh.map(function (row) { return row.map(f); });
    this.rotation += dir * Math.PI / 2;
  };

  /** 把变换结果画到 ctx（ctx 已处于文档坐标系） */
  Session.prototype.render = function (ctx) {
    drawQuad(ctx, this.buf, 0, 0, this.buf.width, this.buf.height,
      this.effectiveQuad(), this.cells, this.effectivePointAt());
  };

  /** 覆盖层：画面预览 + 外框 + 手柄 */
  Session.prototype.drawOverlay = function (ctx) {
    var q = this.effectiveQuad();
    var s = this.engine.scale || 1;

    ctx.save();
    ctx.globalAlpha = 0.92;
    this.render(ctx);
    ctx.restore();

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2 / s;
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (var i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 0.9 / s;
    ctx.strokeStyle = 'rgba(40,110,255,.95)';
    ctx.stroke();

    // 中线（SAI2 变换框里也有这两条辅助线）
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[2].x, q[2].y);
    ctx.moveTo(q[1].x, q[1].y); ctx.lineTo(q[3].x, q[3].y);
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 网格变换：把网格线和控制点画出来（SAI2 里也是一格一格的）
    if (this.mesh) {
      var N = this.meshN;
      ctx.strokeStyle = 'rgba(40,110,255,.55)';
      ctx.lineWidth = 0.9 / s;
      ctx.beginPath();
      for (var gj = 0; gj <= N; gj++) {
        ctx.moveTo(this.mesh[gj][0].x, this.mesh[gj][0].y);
        for (var gi = 1; gi <= N; gi++) ctx.lineTo(this.mesh[gj][gi].x, this.mesh[gj][gi].y);
      }
      for (var gi2 = 0; gi2 <= N; gi2++) {
        ctx.moveTo(this.mesh[0][gi2].x, this.mesh[0][gi2].y);
        for (var gj2 = 1; gj2 <= N; gj2++) ctx.lineTo(this.mesh[gj2][gi2].x, this.mesh[gj2][gi2].y);
      }
      ctx.stroke();
      var nodes = this.meshNodes();
      var ns = 5 / s;
      for (var ni = 0; ni < nodes.length; ni++) {
        var np = nodes[ni].p;
        ctx.beginPath();
        ctx.arc(np.x, np.y, ns, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(30,60,140,.95)';
        ctx.lineWidth = 1 / s;
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // 手柄
    var h = this.handles();
    var hs = 8 / s;
    var keys = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];
    for (var k = 0; k < keys.length; k++) {
      var p = h[keys[k]];
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(30,60,140,.95)';
      ctx.lineWidth = 1 / s;
      ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
    }
    // 旋转柄画成圆形，和方形缩放柄区分开
    var rp = h.rotate;
    var rr = 5 / s;
    ctx.beginPath();
    ctx.moveTo((h.n.x), (h.n.y));
    ctx.lineTo(rp.x, rp.y);
    ctx.strokeStyle = 'rgba(40,110,255,.8)';
    ctx.lineWidth = 1 / s;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,60,140,.95)';
    ctx.stroke();
    ctx.restore();
  };

  /** 生成提交结果：底部像素 + 变换后的浮层 */
  Session.prototype.compose = function (baseCanvas, docW, docH) {
    var out = document.createElement('canvas');
    out.width = docW; out.height = docH;
    var c = out.getContext('2d');
    c.drawImage(baseCanvas, 0, 0);
    c.save();
    this.render(c);
    c.restore();
    return out;
  };

  global.ChaTransform = {
    Session: Session,
    meshAt: meshAt,
    meshCenter: meshCenter,
    drawQuad: drawQuad,
    quadCenter: quadCenter,
    pointInQuad: pointInQuad
  };
})(window);
