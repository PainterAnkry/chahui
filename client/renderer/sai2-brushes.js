'use strict';
/**
 * ★ v2.0.10：这份文件是 **tools/sai2-brush-convert.js 生成的**，别手改。
 *
 * 来源：SAI2 笔刷包「SAI2-CATXQ-Ver1.22笔刷包」（作者：万能的小奇喵，见包内「使用教程与声明.txt」）。
 * 生成时间：2026-09-21 04:48
 *
 * 里面只有**参数**：brushs.js 在定义完 ITEMS 之后把它套到同 id 的内置笔刷上，
 * 并在末尾追加 extra 里那几只。没加载这一份（或包没解压）时行为与之前完全一样。
 *
 * ⚠ 尺寸不是照搬的：SAI2 存千分比（500 = 50%），茶绘是像素，所以只拿它做相对微调，
 *   绝对像素仍用我们调过的基准值 —— 否则一换包所有笔刷都会大得没法用。
 */
(function (global) {
  'use strict';
  global.CHAHU_SAI2 = {
  "source": "SAI2-CATXQ-Ver1.22笔刷包",
  "picks": {
    "pencil": {
      "from": "2B",
      "kind": "pencil",
      "file": "nrm/17.saitdat"
    },
    "airbrush": {
      "from": "喷枪",
      "kind": "airbrush",
      "file": "nrm/483.saitdat"
    },
    "brush": {
      "from": "画笔",
      "kind": "brush",
      "file": "nrm/484.saitdat"
    },
    "watercolor": {
      "from": "水彩笔",
      "kind": "water",
      "file": "nrm/485.saitdat"
    },
    "marker": {
      "from": "马克笔",
      "kind": "marker",
      "file": "nrm/506.saitdat"
    },
    "eraser": {
      "from": "橡皮擦",
      "kind": "eraser",
      "file": "nrm/487.saitdat"
    },
    "select": {
      "from": "选区笔",
      "kind": "selpen",
      "file": "ink/7.saitdat"
    },
    "selectErase": {
      "from": "选区擦",
      "kind": "selers",
      "file": "ink/8.saitdat"
    },
    "bucket": {
      "from": "油漆桶",
      "kind": "bucket",
      "file": "nrm/490.saitdat"
    },
    "gradient": {
      "from": "渐变",
      "kind": "gradation",
      "file": "nrm/11.saitdat"
    },
    "blur": {
      "from": "模糊",
      "kind": "blur",
      "file": "nrm/492.saitdat"
    },
    "effect": {
      "from": "特效笔",
      "kind": "effpen",
      "file": "nrm/493.saitdat"
    },
    "scatter": {
      "from": "散布",
      "kind": "scatter",
      "file": "nrm/494.saitdat"
    },
    "smudge": {
      "from": "涂抹",
      "kind": "smudge",
      "file": "nrm/12.saitdat"
    }
  },
  "overrides": {
    "pencil": {
      "from": "2B",
      "params": {
        "size": 2,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.1,
        "pressSize": 1,
        "pressOpacity": 0.3,
        "grain": 0.42,
        "grainScale": 0.6,
        "paper": "fine",
        "scatter": 0
      }
    },
    "airbrush": {
      "from": "喷枪",
      "params": {
        "size": 33,
        "opacity": 1,
        "hardness": 0.3,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05
      }
    },
    "brush": {
      "from": "画笔",
      "params": {
        "size": 18,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05
      }
    },
    "watercolor": {
      "from": "水彩笔",
      "params": {
        "size": 26,
        "opacity": 1,
        "hardness": 0,
        "minSize": 0.6,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05,
        "mix": 0.3,
        "edge": 0.15
      }
    },
    "marker": {
      "from": "马克笔",
      "params": {
        "size": 29,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05
      }
    },
    "eraser": {
      "from": "橡皮擦",
      "params": {
        "size": 31,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.02,
        "pressSize": 0.25,
        "pressOpacity": 0.3,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05
      }
    },
    "select": {
      "from": "选区笔",
      "params": {
        "size": 22,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.02,
        "pressSize": 0.25,
        "pressOpacity": 0.3,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0
      }
    },
    "selectErase": {
      "from": "选区擦",
      "params": {
        "size": 22,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.02,
        "pressSize": 0.25,
        "pressOpacity": 0.3,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0
      }
    },
    "blur": {
      "from": "模糊",
      "params": {
        "size": 29,
        "opacity": 1,
        "hardness": 0.3,
        "minSize": 0.02,
        "pressSize": 0.25,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05,
        "strength": 0.8
      }
    },
    "effect": {
      "from": "特效笔",
      "params": {
        "size": 26,
        "opacity": 1,
        "hardness": 0.3,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.35
      }
    },
    "scatter": {
      "from": "散布",
      "params": {
        "size": 24,
        "opacity": 1,
        "hardness": 0.3,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.35
      }
    },
    "smudge": {
      "from": "涂抹",
      "params": {
        "size": 29,
        "opacity": 0.9,
        "hardness": 0.3,
        "minSize": 0.02,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0,
        "strength": 0.7200000000000001
      }
    }
  },
  "extra": [
    {
      "id": "sai2Sketch",
      "name": "草稿铅笔",
      "icon": "pencil",
      "tool": "brush",
      "type": "brush",
      "tip": "SAI2 笔刷包里的「草图铅笔」：60% 尺寸 + 低浓度，起稿时越描越深",
      "from": "草图铅笔",
      "params": {
        "size": 12,
        "opacity": 0.23,
        "hardness": 0.522,
        "minSize": 0.56,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0.258,
        "grainScale": 1,
        "paper": "fine",
        "scatter": 0
      }
    },
    {
      "id": "sai2Wet",
      "name": "水彩（渗化）",
      "icon": "watercolor",
      "tool": "brush",
      "type": "brush",
      "tip": "SAI2 笔刷包里的「水彩」：带渗化笔形 + 混色/水分量，湿画法铺色",
      "from": "水彩",
      "params": {
        "size": 15,
        "opacity": 1,
        "hardness": 0,
        "minSize": 0.6,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05,
        "mix": 0.5,
        "edge": 0.25
      }
    },
    {
      "id": "sai2Oil",
      "name": "油画厚涂",
      "icon": "bristle",
      "tool": "brush",
      "type": "brush",
      "tip": "SAI2 笔刷包里的油画笔：鬃毛笔形 + 画布纸纹，厚涂出笔触",
      "from": "油画",
      "params": {
        "size": 15,
        "opacity": 1,
        "hardness": 1,
        "minSize": 0.5,
        "pressSize": 1,
        "pressOpacity": 1,
        "grain": 0,
        "grainScale": 1,
        "paper": "none",
        "scatter": 0.05
      }
    }
  ]
};
})(window);
