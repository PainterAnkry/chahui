# Procreate 笔刷语料

这两个文件是**真实格式**的 Procreate `.brush` 文件（不是按规范凭空构造的），
用来回归 `client/renderer/brush-import.js` 里的 Procreate 解析链路
（ZIP → Brush.archive → 二进制 plist → Shape.png → 笔刷参数）。

| 文件 | 笔名 | 形状 | 特点 |
| --- | --- | --- | --- |
| `marker.brush` | Marker | 233×117 **凿形椭圆**（2:1） | 硬边、间距 6%、压力→尺寸 0.2 |
| `pencil.brush` | Pencil | 225×225 圆形 | 软边、间距 8%、压力→尺寸 0.65、两端锥度 0.3 |

`marker.brush` 那支特别有价值：它的笔尖是 **2:1 的椭圆**，正好能守住
「硬度推断不能用半径环平均」这条 —— 旧实现（环平均）在它身上会给出 0.05
（下限），新实现（面积等效半径）给出 0.65。换回旧算法这条语料会立刻报警。

## 来源与许可

来自 <https://github.com/barakbl/procreate_brush_claude_tools>（MIT）的
`examples/` 目录。该项目的 `create_brush.py` 按社区反解出来的 Procreate
格式生成这些文件。

需要说明的是：它们是**该工具生成的**，不是从 iPad 上导出的真实作品笔刷。
所以能证明「解析器认这套格式」，但**不能**证明它能吃下你手上的每一个
真实笔刷包 —— 拿到真文件后如果解析失败，把文件名和报错贴出来，
解析器是「读不懂就明确报错」，不会静默给出一支错的笔。

## 用法

```bash
node tools/procreate-corpus.js                    # 跑内置语料
node tools/procreate-corpus.js <目录或文件> [...]  # 跑你自己的 .brush/.brushset
```
