/**
 * 茶绘 · 笔刷 / 工具库（对照 PaintTool SAI Ver.2 的基本笔刷）
 *
 * 一个「条目」= 一个图标 + 一个绘制工具 + 一组笔刷参数。
 * 面板上的九宫格就是这个列表，顺序与显隐由用户自定义（见 ChaTools）。
 *
 * 参数含义（与 shared/protocol.js 的 BRUSH_DEFAULTS 一一对应）：
 *   size          直径
 *   opacity       浓度            0.02 ~ 1
 *   hardness      边缘硬度        0 = 极柔边（喷枪），1 = 硬边（钢笔）
 *   minSize       最小直径比例    笔压最轻时的直径占设定直径的比例
 *   pressSize     笔压 → 直径     0 = 不随压感变化，1 = 完全由压感决定
 *   pressOpacity  笔压 → 浓度
 *   edge          水彩边缘        在笔迹外缘压一圈更深的边（水彩笔特征）
 *   scatter       散布            采样点抖散成颗粒状
 *   grain         颗粒            用纸纹噪点打孔
 *   grainScale    纸纹比例
 *   paper         纸张质感        none / fine / coarse / canvas
 *   fx            特殊效果        none / waterdrop / noise / scatter
 *   strength      模糊 / 涂抹强度
 *   tolerance     油漆桶色差范围
 *   expand        油漆桶扩大像素
 *   blend         画笔混合模式
 *   sym           对称尺
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;

  function params(o) {
    return Object.assign({ blend: 'normal', sym: 'none', brush: '', paper: 'none', fx: 'none' },
      P.BRUSH_DEFAULTS, o);
  }

  /* ------------------------------------------------------------ 图标 */

  // 24×24 视窗内的笔画示意（支持 path 字符串，或整段 inner SVG）
  var ICONS = {
    pencil: 'M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19zM13.5 7.5l3 3',
    airbrush: '<path d="M8 20h7a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1z"/><path d="M10 8V6h3.5v2"/><path d="M17 4.5h.01M19.5 6.5h.01M21 9.5h.01M19 13h.01"/>',
    brush: 'M6.5 19.5c0-2 .8-3.6 2.2-5l7-7 3.3 3.3-7 7c-1.4 1.4-3 2.2-5 2.2z"/><path d="M15 6.5l3.3 3.3"/><path d="M6.5 19.5l1-3.2 2.7 2.7z"/>',
    watercolor: '<path d="M5.5 18.5c0-2 .8-3.6 2.2-5l6.6-6.6 3.3 3.3-6.6 6.6c-1.4 1.4-3 2.2-5 2.2z"/><path d="M13.5 6.5l3.3 3.3"/><path d="M17 16.5c1.6 2 2.6 3.3 2.6 4.2a2.6 2.6 0 0 1-5.2 0c0-.9 1-2.2 2.6-4.2z"/>',
    marker: '<path d="M6 15.6 14.4 7.2l2.4 2.4L8.4 18H6z"/><path d="M15.2 6.4l1.8-1.8a1.9 1.9 0 0 1 2.6 2.6l-1.8 1.8z"/><path d="M5.5 21h5"/>',
    eraser: '<path d="M15.5 3.5 5.6 13.4a2 2 0 0 0 0 2.8l2.2 2.2a2 2 0 0 0 2.8 0l9.9-9.9a2 2 0 0 0 0-2.8l-2.2-2.2a2 2 0 0 0-2.8 0z"/><path d="M11 8l5 5"/><path d="M8 20h10"/>',
    select: '<path stroke-dasharray="3 2.4" d="M4.6 4.6h14.8v14.8H4.6z"/><path d="m8.4 15.6 1.2-1.2 5-5 1.6 1.6-5 5z"/><path d="M20.6 4.6l-2.6 2.6"/>',
    selectErase: '<path stroke-dasharray="3 2.4" d="M4.6 4.6h14.8v14.8H4.6z"/><path d="m15.4 8.6-4.8 4.8a1 1 0 0 0 0 1.4l1 1a1 1 0 0 0 1.4 0l4.8-4.8a1 1 0 0 0 0-1.4l-1-1a1 1 0 0 0-1.4 0z"/><path d="M20.6 4.6l-2.6 2.6"/>',
    bucket: '<path d="M4 13 11 6l6 6-7 7a1.4 1.4 0 0 1-2 0l-4-4a1.4 1.4 0 0 1 0-2z"/><path d="M9 3.5 7 5.5"/><path d="M19 15c1.1 1.6 1.6 2.5 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-.7.5-1.6 1.6-3.2z"/>',
    gradient: '<defs><linearGradient id="chgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity="1"/><stop offset="0.5" stop-color="currentColor" stop-opacity=".45"/><stop offset="1" stop-color="currentColor" stop-opacity=".05"/></linearGradient></defs><rect x="4" y="6" width="16" height="12" rx="1.4" fill="url(#chgrad)" stroke="currentColor" stroke-width="1.2"/>',
    blur: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="3.4" opacity=".45"/>',
    effect: '<path d="M5 19.5l1.2-3.6 7-7 2.6 2.6-7 7z"/><path d="m15.4 6.4 1.6-1.6"/><path d="M17 3.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
    scatter: '<path d="M12 4.2 14 6.2 12 8.2 10 6.2zM5.4 10.4 7.6 12.6 5.4 14.8 3.2 12.6zM18.6 12.6 20.8 14.8 18.6 17 16.4 14.8zM11 17.6 12.9 19.5 11 21.4 9.1 19.5z"/>',
    smudge: '<ellipse cx="11.6" cy="9.4" rx="4.2" ry="5.6"/><path d="M6 17.4c1.5 1.1 3.4 1.7 5.4 1.7s3.9-.6 5.4-1.7" opacity=".5"/><path d="M19.6 6.6c.6-.9 1.4-1 2-.5" opacity=".6"/>',
    line: '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.7"/><circle cx="20" cy="4" r="1.7"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
    picker: '<path d="m4 20 1-3.5L15.5 6l2.5 2.5L7.5 19z"/><path d="m15 3.5 5.5 5.5"/><path d="m13.5 5 5.5 5.5"/>',
    marquee: '<path stroke-dasharray="3 2.2" d="M4.5 4.5h15v15h-15z"/>',
    lasso: '<path stroke-dasharray="3 2.2" d="M12 4.6c4.3 0 7.6 2.2 7.6 5s-3.3 5-7.6 5-7.6-2.2-7.6-5 3.3-5 7.6-5z"/><path d="M8.4 14.2c-.9 1.5-.4 3 .9 3.6"/><circle cx="9.2" cy="19.4" r="1.6"/>',
    wand: '<path d="m4.4 19.6 9.6-9.6 1.8 1.8-9.6 9.6z"/><path d="M17.4 3.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="M21 12.4l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/>'
  };

  /* ------------------------------------------------------------ 条目 */

  // type: 'brush' 画笔家族 / 'paint' 特殊绘制工具 / 'shape' 形状 / 'util' 辅助
  var ITEMS = [
    {
      id: 'pencil', name: '铅笔', tool: 'brush', icon: 'pencil', type: 'brush',
      tip: 'SAI2 铅笔：硬边、笔压主要控制粗细，轻轻一带就出细线',
      // 对照 SAI2 的「铅笔（通常）」默认值：直径小、最小直径 30%、浓度 100、
      // 笔压→大小 + 笔压→浓度都开、画材效果关（无颗粒 / 无散布）。
      // 以前这里是 hardness 0.95 + grain 0.22 + paper fine + scatter 0.04，
      // 结果铅笔被「散布」分支整笔拆成了点，又被 0.4px 的强制模糊磨软，完全不像铅笔。
      params: params({
        brush: 'pencil', size: 2, opacity: 1, hardness: 1, minSize: 0.3,
        pressSize: 1, pressOpacity: 0.6, grain: 0, grainScale: 1, paper: 'none', scatter: 0
      })
    },
    {
      id: 'pencilSoft', name: '软铅笔', tool: 'brush', icon: 'pencil', type: 'brush',
      tip: '带一点纸纹的软铅，适合起稿与打调子',
      // 实测边缘过渡带要落在「铅笔但软一点」的区间（10-14px），0.62 太糊（19px）
      params: params({
        brush: 'pencilSoft', size: 4, opacity: 0.85, hardness: 0.78, minSize: 0.35,
        pressSize: 0.9, pressOpacity: 0.5, grain: 0.3, grainScale: 1.1, paper: 'fine'
      })
    },
    {
      id: 'airbrush', name: '喷枪', tool: 'brush', icon: 'airbrush', type: 'brush',
      tip: '极柔边低浓度，适合上色过渡',
      params: params({
        brush: 'airbrush', size: 40, opacity: 0.12, hardness: 0.02, minSize: 0.7,
        pressSize: 0.4, pressOpacity: 0.7
      })
    },
    {
      id: 'brush', name: '画笔', tool: 'brush', icon: 'brush', type: 'brush',
      tip: '通用圆头画笔，粗细稳定、边缘干净',
      // SAI2 的「画笔」边缘偏干净；0.8 实测过渡带 10px 偏糊，0.9 约 4px 更接近
      params: params({
        brush: 'brush', size: 8, opacity: 0.95, hardness: 0.9, minSize: 0.45,
        pressSize: 0.9, pressOpacity: 0.2
      })
    },
    {
      id: 'watercolor', name: '水彩笔', tool: 'brush', icon: 'watercolor', type: 'brush',
      tip: '柔边 + 水彩边缘，会积水',
      params: params({
        brush: 'watercolor', size: 24, opacity: 0.42, hardness: 0.26, minSize: 0.5,
        pressSize: 0.7, pressOpacity: 0.6, edge: 0.8, fx: 'waterdrop'
      })
    },
    {
      id: 'marker', name: '马克笔', tool: 'brush', icon: 'marker', type: 'brush',
      tip: '半透明正片叠底，平涂不叠色',
      params: params({
        brush: 'marker', size: 18, opacity: 0.6, hardness: 0.96, minSize: 1,
        pressSize: 0.1, pressOpacity: 0, blend: 'multiply'
      })
    },
    {
      id: 'eraser', name: '橡皮擦', tool: 'eraser', icon: 'eraser', type: 'brush',
      tip: '硬边橡皮，压感控制粗细',
      params: params({
        brush: 'eraser', size: 20, opacity: 1, hardness: 1, minSize: 0.7, pressSize: 0.6
      })
    },
    {
      id: 'select', name: '选区笔', tool: 'select', icon: 'select', type: 'paint',
      tip: '圈出选区，之后的绘制与填色只在选区内生效',
      params: params({ brush: 'select', size: 20, opacity: 1, hardness: 1, minSize: 0.6, pressSize: 0.5 })
    },
    {
      id: 'selectErase', name: '选区擦', tool: 'selectErase', icon: 'selectErase', type: 'paint',
      tip: '擦掉选区范围',
      params: params({ brush: 'selectErase', size: 20, opacity: 1, hardness: 1, minSize: 0.6, pressSize: 0.5 })
    },
    {
      id: 'marquee', name: '框选', tool: 'marquee', icon: 'marquee', type: 'paint',
      tip: '拖一个矩形选区；Shift 加选、Alt 减选',
      params: params({ brush: 'marquee', size: 20, opacity: 1, hardness: 1, minSize: 1, pressSize: 0 })
    },
    {
      id: 'lasso', name: '套索', tool: 'lasso', icon: 'lasso', type: 'paint',
      tip: '自由圈出选区；首尾自动闭合。Shift 加选、Alt 减选',
      params: params({ brush: 'lasso', size: 20, opacity: 1, hardness: 1, minSize: 1, pressSize: 0 })
    },
    {
      id: 'wand', name: '魔棒', tool: 'wand', icon: 'wand', type: 'paint',
      tip: '点一下，按色差选中相邻的同色区域（色差范围见「特殊效果」面板）',
      params: params({ brush: 'wand', size: 20, opacity: 1, tolerance: 32, expand: 0 })
    },
    {
      id: 'bucket', name: '油漆桶', tool: 'fill', icon: 'bucket', type: 'paint',
      tip: '按色差范围填充，可扩大边缘',
      params: params({ brush: 'bucket', size: 20, opacity: 1, tolerance: 32, expand: 0 })
    },
    {
      id: 'gradient', name: '渐变', tool: 'gradient', icon: 'gradient', type: 'paint',
      tip: '拖一条线拉出线性渐变；勾选「填充」则变成径向渐变',
      params: params({ brush: 'gradient', size: 20, opacity: 1, blend: 'normal' })
    },
    {
      id: 'blur', name: '模糊', tool: 'blur', icon: 'blur', type: 'paint',
      tip: '涂抹即模糊，做柔化与过渡',
      params: params({
        brush: 'blur', size: 30, opacity: 1, hardness: 0.6, minSize: 0.7,
        pressSize: 0.5, pressOpacity: 0.4, strength: 0.7
      })
    },
    {
      id: 'effect', name: '特效笔', tool: 'brush', icon: 'effect', type: 'brush',
      tip: '带特殊效果的笔：水滴 / 噪点 / 散布',
      params: params({
        brush: 'effect', size: 14, opacity: 0.8, hardness: 0.35, minSize: 0.5,
        pressSize: 0.7, pressOpacity: 0.5, edge: 0.55, fx: 'waterdrop'
      })
    },
    {
      id: 'scatter', name: '散布', tool: 'brush', icon: 'scatter', type: 'brush',
      tip: '散开的颗粒笔，适合做质感',
      params: params({
        brush: 'scatter', size: 26, opacity: 0.35, hardness: 0.7, minSize: 0.8,
        pressSize: 0.4, pressOpacity: 0.5, scatter: 0.9
      })
    },
    {
      id: 'smudge', name: '涂抹', tool: 'smudge', icon: 'smudge', type: 'paint',
      tip: '把碰到颜色拖走，做混色与过渡',
      params: params({ brush: 'smudge', size: 30, opacity: 1, hardness: 0.5, minSize: 0.8, pressSize: 0.4, strength: 0.6 })
    },
    { id: 'line', name: '直线', tool: 'line', icon: 'line', type: 'shape', tip: '按住拖一条直线（Shift 吸附 45°）', params: params({ brush: 'line' }) },
    { id: 'rect', name: '矩形', tool: 'rect', icon: 'rect', type: 'shape', tip: '拖出矩形，可勾选填充', params: params({ brush: 'rect' }) },
    { id: 'ellipse', name: '椭圆', tool: 'ellipse', icon: 'ellipse', type: 'shape', tip: '拖出椭圆，可勾选填充', params: params({ brush: 'ellipse' }) },
    { id: 'picker', name: '吸管', tool: 'picker', icon: 'picker', type: 'util', tip: '取画布上的颜色（按住 Alt 可临时取色）', params: params({ brush: 'picker' }) }
  ];

  var BY_ID = {};
  ITEMS.forEach(function (p) { BY_ID[p.id] = p; });

  // 工具 → 家族标签
  var FAMILY = {
    brush: '画笔', eraser: '橡皮', blur: '模糊', smudge: '涂抹',
    fill: '油漆桶', gradient: '渐变', select: '选区笔', selectErase: '选区擦',
    marquee: '框选', lasso: '套索', wand: '魔棒',
    line: '直线', rect: '矩形', ellipse: '椭圆', picker: '吸管'
  };

  // 纸张质感（颗粒 / 纸纹）
  var PAPER_OPTIONS = [
    { id: 'none', name: '无质感' },
    { id: 'fine', name: '细纹' },
    { id: 'coarse', name: '粗纹' },
    { id: 'canvas', name: '画布' }
  ];

  var PAPER_PRESETS = {
    none: { grain: 0, grainScale: 1 },
    fine: { grain: 0.35, grainScale: 1.2 },
    coarse: { grain: 0.55, grainScale: 2.4 },
    canvas: { grain: 0.7, grainScale: 0.7 }
  };

  // 特殊效果（特效笔 / 水彩边缘）
  var FX_OPTIONS = [
    { id: 'none', name: '无效果' },
    { id: 'waterdrop', name: '水滴' },
    { id: 'noise', name: '噪点' },
    { id: 'scatter', name: '散布' }
  ];

  var FX_PRESETS = {
    none: { edge: 0, scatter: 0, grain: 0 },
    waterdrop: { edge: 0.75, hardness: 0.3, scatter: 0 },
    noise: { scatter: 0.7, grain: 0.6, edge: 0 },
    scatter: { scatter: 0.9, edge: 0 }
  };

  function get(id) { return BY_ID[id] || null; }

  function itemForTool(tool) {
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].tool === tool) return ITEMS[i];
    return ITEMS[0];
  }

  /** 指定工具下可用的条目（形状 / 辅助沿用画笔家族） */
  function forTool(tool) {
    var list = ITEMS.filter(function (p) { return p.tool === tool; });
    if (list.length) return list;
    if (tool === 'brush' || tool === 'eraser') return ITEMS.filter(function (p) { return p.type === 'brush'; });
    return [itemForTool('brush')];
  }

  function defaultForTool(tool) {
    return forTool(tool)[0] || ITEMS[0];
  }

  /** 拷贝一份完整参数（含被记忆的覆盖值） */
  function resolveParams(item, overrides) {
    var p = Object.assign({}, item.params);
    var ov = overrides && overrides[item.id];
    if (ov) {
      Object.keys(ov).forEach(function (k) {
        // sym 由全局对称尺控制、brush 恒等于条目 id，其余（含 blend / paper / fx）都允许用户改动
        if (k === 'sym' || k === 'brush') return;
        var t = typeof ov[k];
        if (t === 'number' || t === 'boolean' || t === 'string') p[k] = ov[k];
      });
    }
    return P.normalizeBrush(p);
  }

  function iconSvg(id) {
    var body = ICONS[id] || ICONS.brush;
    if (body.charAt(0) !== '<') body = '<path d="' + body + '"/>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

  global.ChaBrushes = {
    ITEMS: ITEMS,
    FAMILY: FAMILY,
    PAPER_OPTIONS: PAPER_OPTIONS,
    PAPER_PRESETS: PAPER_PRESETS,
    FX_OPTIONS: FX_OPTIONS,
    FX_PRESETS: FX_PRESETS,
    get: get,
    itemForTool: itemForTool,
    forTool: forTool,
    defaultForTool: defaultForTool,
    resolveParams: resolveParams,
    iconSvg: iconSvg
  };
})(window);
