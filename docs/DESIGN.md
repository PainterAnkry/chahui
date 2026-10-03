# 茶绘 · 界面设计系统（DESIGN.md）

> 这份文档是**改界面的唯一入口**：颜色、玻璃材质、圆角、阴影、动效、组件规格都从这里查，
> 不要再往 CSS 里写新的 `#hex`。
> 代码位置：令牌在 [`client/renderer/styles.css`](../client/renderer/styles.css) 顶部（`:root` 与
> `html[data-theme="dark"]`），主题开关在 [`client/renderer/app.js`](../client/renderer/app.js) 的「界面主题」一段
> 与 [`client/renderer/menu.js`](../client/renderer/menu.js) 的「窗口 → 界面主题」。

---

## 一、设计语言与三条硬约束（绘画工具和普通网页不一样）

2.2 起界面语言换成 **iOS「Liquid Glass」**：模态与菜单是一块块半透明玻璃（模糊 + 提饱和 +
顶部高光发丝线），按钮按压有轻微缩放的弹性反馈，弹层进出用 iOS 减速/弹性曲线。
但这是**绘画工具**，有三条压倒一切的硬约束：

1. **画布外围必须是无色相的中明度灰**，深色主题也不低于 `#45464a`。
   周围太暗会系统性抬高你对画面明度的主观判断 —— 画的时候觉得挺好，导出来发灰发暗。
   所以 `--stage-bg` 是中性灰，不是「深色主题的深灰」。
2. **强调色只有一支**（蓝），只给主操作、焦点环、选中态；**不用它填面板、不做装饰**。
   面板一花，画面里的颜色就没法判断了。选区高亮另有一套 `--sel-*` 令牌，与品牌色分开。
3. **玻璃不能糊住画面，动效不能抢画笔的 GPU 预算**：
   - 玻璃分三档，透明度按「压在上面的文字多少」递增（`--glass` → `--glass-strong` → `--glass-modal`）；
     深色主题下透明度只升不降，字永远压得住底。
   - 动效只动 `transform` / `opacity`（合成器属性）；background / border / color ≤ .18s。
     **永远不要动 backdrop-filter 的数值、不要给大面积玻璃做阴影动画。**
   - 弹层（菜单 / 弹窗 / 右键小弹窗）的开合用 `@starting-style` +
     `transition-behavior: allow-discrete` 纯 CSS 完成，JS 只 toggle `.hidden`；
     落笔画画全程没有动画在跑。
   - 靠 `transform` 定位的浮层（快捷栏 / HUD / 回放条的 `translateX(-50%)`）只做 opacity 进场。

圆角整体比 2.1 外扩一档（5 / 7 / 9 / 14 / 20 / 999），往 iOS 的连续圆角手感靠；
**不使用 `linear-gradient` 渐变底**（强调色 `--accent-grad` 只给字标与主按钮）。

---

## 二、令牌（改配色的唯一地方）

三层结构：**表面阶梯 → 交互态 → 语义色**。浅色在 `:root`，深色在 `html[data-theme="dark"]`，
同名同角色、只换数值。

### 表面阶梯（由外到内逐层提亮）

| 令牌 | 浅色 | 深色 | 用在哪 |
| --- | --- | --- | --- |
| `--bg` | `#eceef2` | `#1b1c1f` | 应用底色 |
| `--chrome` | `#f8f9fb` | `#232529` | 菜单栏 / 顶栏 / 底栏 / 右栏页签 |
| `--panel` | `#f2f4f7` | `#272a2e` | 左右侧栏 |
| `--panel-2` / `--surface` | `#ffffff` | `#2f3237` | 小节卡片 / 按钮 / 输入框 / 气泡 |
| `--surface-sunken` | `#f6f8fb` | `#23262a` | 凹陷块：弹窗底栏、预览块、禁用输入 |
| `--surface-mute` | `#fbfcfe` | `#2a2d31` | 比卡片再浅一档的底 |
| `--surface-trans` | = `--glass` | = `--glass` | 旧引用别名（快捷栏 / 参考图标签） |

### 液态玻璃（浮在画布上的东西才用）

玻璃 = `--glass-sheen`（顶部高光渐变）叠 `--glass*` 半透明底 + `backdrop-filter: blur() saturate()`
+ `--glass-border` 外圈发丝线 + `--glass-inset` 内圈高光 + `--glass-shadow` 分层阴影。
三档按「压在上面的文字多少」递增透明度：

| 令牌 | 浅色 | 深色 | 用在哪 |
| --- | --- | --- | --- |
| `--glass` | 白 .62 + blur 18px | 黑 .66 | 贴画布的窄条：快捷栏 / HUD / 接龙条 / 参考图标签 |
| `--glass-strong` | 白 .80 + blur 30px | 黑 .80 | 菜单 / 右键弹窗 / Toast / 浮窗 / 计分板 |
| `--glass-modal` | 白 .90 + blur 30px | 黑 .91 | 模态弹窗（文字最多，最不透） |
| `--glass-blur` / `--glass-blur-lg` | 18 / 30px | 同左 | 模糊半径（配 `--glass-sat` 提饱和） |
| `--glass-border` / `--glass-line` | 外圈深发丝 / 内圈白高光 | 反过来 | 玻璃的双圈描边 |
| `--glass-inset` / `--glass-sheen` | 顶部高光 inset + 高光渐变 | 减弱版 | 玻璃的「光从上面来」 |
| `--glass-shadow` | 三层分离阴影 | 更重 | 玻璃的落影（**不要给它做动画**） |

### 交互态

| 令牌 | 浅色 | 深色 | 说明 |
| --- | --- | --- | --- |
| `--hover` | `#eaeef5` | `#363a40` | 悬停底色（**只换色，不改尺寸**） |
| `--active-bg` | `#e0e6f0` | `#41454d` | 按下底色 |
| `--overlay` | `rgba(20,26,36,.38)` | `rgba(0,0,0,.55)` | 弹窗遮罩 |
| `--ring` | `rgba(47,125,225,.22)` | `rgba(90,162,247,.30)` | 焦点环（`box-shadow`，不加尺寸） |
| `--tooltip-bg` | `rgba(28,34,44,.94)` | `rgba(12,14,18,.95)` | 提示气泡 |
| `--slider-thumb` | `#ffffff` | `#e9eaee` | 滑块圆点 |

### 描边与文字

| 令牌 | 浅色 | 深色 | 用在哪 |
| --- | --- | --- | --- |
| `--line` | `#dde1e9` | `#3a3e45` | 结构性分隔（栏与栏、页签下沿） |
| `--line-soft` | `#e9ecf1` | `#33373d` | 卡片内部发丝线 |
| `--line-strong` | `#ccd2dc` | `#4d525b` | 按钮 / 输入框 / 下拉的描边 |
| `--text` | `#1f2228` | `#e9eaee` | 正文 |
| `--text-dim` | `#5e6672` | `#a9aeb9` | 次级文字（标签、说明） |
| `--text-mute` | `#8d94a0` | `#828894` | 三级文字（时间戳、计数）——**只给非关键元数据** |
| `--text-on-accent` | `#ffffff` | `#ffffff` | 彩底上的白字 |

### 强调色与语义色

| 令牌 | 浅色 | 深色 | 说明 |
| --- | --- | --- | --- |
| `--accent` | `#2f7de1` | `#5aa2f7` | 主操作 / 选中 / 链接 |
| `--accent-strong` | `#2469c9` | `#7cb6f9` | 悬停 / 按下 |
| `--accent-ink` | `#1c5aa8` | `#a8cdfb` | 浅底上的强调文字（**曾经的 `#1d5dad`**） |
| `--accent-soft` | `#e7f0fd` | `#23364f` | 选中态底色 |
| `--accent-line` | `#a9c9f0` | `#3d5c85` | 选中态描边 |
| `--accent-grad` | `linear-gradient(135deg,#4b93ea,#2a6ed4)` | 同左（更深） | 只给字标与主按钮 |
| `--danger` / `-soft` / `-line` / `-ink` | `#d9534f` / `#fdf0ef` / `#eccac9` / `#b3382f` | 对应深色档 | 危险操作、错误提示 |
| `--warn*` | `#c8862a` / `#fdf5e6` / `#f0dcb4` / `#8a5d12` | 对应深色档 | 能跑但要注意（压感异常、降级导入） |
| `--ok*` | `#2f9e5f` / `#ecf7f0` / `#c3e3ce` / `#1f7a45` | 对应深色档 | 成功 |

### 画布区与阴影

| 令牌 | 说明 |
| --- | --- |
| `--stage-bg` / `--stage-check` | 画布外围底色与棋盘格（两者**必须一起改**，否则深色下会留一块亮棋盘） |
| `--sel-line` / `--sel-fill` | 选区高亮（和品牌强调色**分开**，免得选区和按钮抢眼） |
| `--shadow-xs` / `-sm` / `--shadow` / `--shadow-lg` | 多层小偏移阴影；深色一般不用阴影、靠表面阶梯分层 |
| `--highlight-top` | 浮层顶边 1px 微高光（深色下区分浮层很有用） |

### 动效

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--dur-fast` | .12s | 悬停 / 按下的颜色过渡 |
| `--dur` | .18s | 弹层退场、遮罩淡入淡出 |
| `--dur-slow` | .3s | 弹层开场的弹性上浮 |
| `--ease` | `cubic-bezier(.25,1,.38,1)` | HIG 减速曲线（默认） |
| `--ease-spring` | `cubic-bezier(.36,1.22,.4,1)` | 弹性回弹，**只给 transform 用**（opacity 会闪） |

弹层开合的标准写法（JS 只 toggle `.hidden`，不需要任何 setTimeout）：

```css
.menu-drop {
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease-spring),
              display var(--dur) allow-discrete;
}
.menu-drop.hidden { opacity: 0; transform: scale(.97) translateY(-5px); }
@starting-style { .menu-drop { opacity: 0; transform: scale(.97) translateY(-5px); } }
```

注意：带 `fill-mode: forwards/both` 的入场动画会一直压着内联样式，Toast 这类
**JS 还要补内联退场过渡**的元素不能加 fill；`@starting-style` 方案则没有这个冲突。

---

## 三、组件规格

| 组件 | 规格 |
| --- | --- |
| **主按钮** `.btn.primary` | `--accent-grad` 底、白字、`--accent-glow`；悬停提亮 6%，**按下 scale(.96)** |
| **常规按钮** `.btn` | `--surface` 底 + `--line-strong` 描边 + `--shadow-xs` + 顶边高光；悬停换 `--hover`；按下 scale(.96) |
| **小片** `.mini` | 高 24、圆角 `--radius-xs`、11.5px 字；悬停只有颜色变化，按下 scale(.95) |
| **图标按钮** `.icon-btn` | 26×26、透明底；悬停才有 `--hover`；按下 scale(.9)；焦点 `--ring` |
| **输入框 / 下拉** | `--surface` 底、`--line-strong` 描边、圆角 `--radius-xs`；聚焦**换描边 + 加环，尺寸与底色都不动**（避免跳动） |
| **滑条** | 5px 轨道胶囊、15px 白圆点 thumb（无描边、立体小投影）；按住 thumb scale(1.15) |
| **卡片** `.group` | `--panel-2` 底 + `--line-soft` 描边 + `--radius` + `--shadow-xs`；小节标题 12px/600 `--text` |
| **分段控件** `.tabs` / `.seg` | 凹槽 = `--surface-sunken` 底 + 10px 圆角；选中 = 白胶囊 + `--shadow-xs`；不要用下划线态 |
| **下拉菜单** `.menu-drop` | 玻璃 strong、`--radius-lg`；行高亮 = 整行 `--accent` 底白字 + `--radius-sm` 圆角；禁用行 opacity .4；**必须保持 `position: fixed`**（`menu.js` 用 offsetWidth/offsetHeight 算坐标，改 absolute 会「看得见点不到」） |
| **右键小弹窗** `#itemCtxMenu` | 与 `.menu-drop` 完全同一块玻璃、同一套行样式 —— 右键呼出的东西必须长得一样 |
| **弹窗** `.modal` | 玻璃 modal、`--radius-xl`、`--glass-shadow` + `--glass-inset`；遮罩 `--overlay` + `blur(6px)`；开场弹性上浮、退场 .18s 缩回 |
| **Toast** | 深玻璃胶囊（`--tooltip-bg` + blur）；入场 spring 弹起，退场由 JS 补内联过渡下沉 |
| **滚动条** | 9px、轨道透明、滑块 `--line-strong`、悬停 `--text-mute`、胶囊形 |
| **状态标签** | 同色 `-soft` 底 + `-line` 边 + `-ink` 字（如 `.pen-hint`、`.badge.guest`） |
| **列表行**（图层 / 成员 / 房间） | 行高不变、悬停只换 `--hover`、选中 = `--accent-soft` 底 + 高亮字 |

---

## 四、主题机制

- 三个取值：`system`（默认，跟随系统）/ `light` / `dark`，存在 `localStorage['chahu.theme']`。
- `app.js` 的 `applyUiTheme()` 把 `system` **解析**成 `light`/`dark` 后写到 `<html data-theme>`；
  CSS 里因此只有 `:root` 与 `html[data-theme="dark"]` **两处**，不需要把深色令牌写两遍。
- 入口：菜单 **窗口 → 界面主题**（带勾选态）；也可以控制台 `ChaApp.setUiTheme('dark')`。
- 跟随系统时监听 `prefers-color-scheme` 变化，系统换主题当场跟着换。
- **不要**在 `index.html` 里用内联脚本抢首帧：服务端给 `.html` 发的 CSP 是 `script-src 'self'`，
  内联脚本会被挡掉。`app.js` 是本页最后一段同步脚本，跑完才首次绘制，不会闪白底。

新增一个组件时：先看现有令牌够不够，不够就**成对**加到两套主题里（浅色 + 深色），
不要在组件里写死颜色。`#f00` / `#0f0` / `#00f` 那几处是颜色滑条的**通道渐变**（见
`client/renderer/index.html` 的 `data-ch`），属于功能色，**不要令牌化**。

---

## 五、改 CSS 的红线（血泪版）

改视觉**不能动**这些（都有 JS 或测试直接依赖）：

1. `.hidden { display: none !important; }` 的语义 —— 13+ 个遮罩靠它开关。
2. `.panel.left` / `.panel.right` 的 `order: 1 / 3`，以及宽度**严格等于** `--left-w` / `--right-w`
   （禁止 `transform: scale()`、禁止 `max-width` 夹取；`test-layout-settings.js` 会量 `getBoundingClientRect`）。
3. `--left-w` / `--right-w` 的默认值必须落在 **(100, 400)** 开区间（当前 262 / 300），夹取范围 190–520。
4. `.menu-drop` / `.menu-sub` 的 `position: fixed`。
5. `.brush-cursor` **不能加 `border`**（`border-width` 必须是 0）、**不能加 `transform`** ——
   圆环是用 `box-shadow` 画的，位置由 JS 写整像素。
6. `#view` 的父元素必须仍是 `.canvas-wrap`，`.stage` 仍是它的定位祖先且保留 `overflow: hidden` ——
   画布尺寸是量这个盒子算出来的，加 `padding` / `border` 会让笔尖坐标偏移。
7. `#colorWheel` 必须 `touch-action: none` 且 CSS 宽高相等（取色坐标是线性映射的）。
8. 七个 `[data-section]`（nav/tools/brushes/brush/fx/color/layers）与 `<section class="group">`、
   小节标题的 `<h4>` 结构不能改（拖动排序、布局设置、测试都按它们找）。
9. 1080 断点是**双向契约**：`app.js` 的 `NARROW_MQ` 与 CSS 里 5 处 `@media (max-width: 1080px)` 必须一致。
10. 文件里大量「后写的赢」（窄屏覆盖块、画布浮层降 z-index 的块都注明**必须留在文件末尾**）——
    **不要重排 styles.css 的段落顺序**，否则层叠结果会静默改变。
11. 改了 `client/renderer/` 一定要 `node tools/sync-web.js`（或 `npm run sync`）——
    服务端和浏览器测试吃的是 `server/public/`，不同步等于没改。
12. `#colorPreview` / `#bgPreview` / 纸张色板的颜色是 JS 写内联样式的，CSS 里**不要**给它们写背景色，
    更不要 `!important`（`test-color.js` 会断言精确的 `rgb()`）。

### 改完最小验证组合

```bash
node tools/check-css.js client/renderer/styles.css   # 括号配对（漏 } 会被浏览器静默吞规则）
npm run check                                        # 顺带查 id / 函数 / 协议接线
node tools/sync-web.js                               # 同步到 server/public
# 起一台自己的服务端（临时存档目录，别灌真存档）：
#   $env:PORT='8440'; $env:DATA_DIR="$env:TEMP\chahui-ui"; node server/src/index.js
node tools/test-layout.js            http://127.0.0.1:8440   # 三栏几何
node tools/test-panels.js            http://127.0.0.1:8440   # 小节面板 / 空右栏收起
node tools/test-layout-settings.js   http://127.0.0.1:8440   # 栏宽字面值 / 缩放
node tools/test-mobile.js            http://127.0.0.1:8440   # 窄屏抽屉 / z-index / 不溢出
node tools/test-menu-narrow.js       http://127.0.0.1:8440   # 下拉 fixed 定位
node tools/verify-issues.js          http://127.0.0.1:8440   # 画笔光标几何
node tools/test-layer-panel.js       http://127.0.0.1:8440   # 图层面板排布
```

---

## 六、参考来源

令牌分档、焦点环、层叠微阴影、列表行规格这些做法，参考了下面这些公开的设计系统；
2.2 的玻璃材质、弹性动效曲线与分段控件参考的是 Apple 公开的 HIG / 「Liquid Glass」设计语言
（只借鉴通用的材质层级 / 曲线 / 组件规则，没有复制任何商标、插画或字体文件；界面字体用系统的
Inter / Segoe UI / PingFang SC，等宽用 JetBrains Mono / Consolas）：

- Apple Human Interface Guidelines — <https://developer.apple.com/design/human-interface-guidelines/materials>
- Cursor DESIGN.md — <https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/cursor/DESIGN.md>
- Linear DESIGN.md — <https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md>
- Vercel DESIGN.md — <https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/vercel/DESIGN.md>
- Figma DESIGN.md — <https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/figma/DESIGN.md>

**没有照抄的三条**（它们对营销站/IDE/手机系统合适，对绘画工具不合适）：超大 hero 字号与 80px 标题、
大面积高饱和渐变、以及把画布外围压到近黑。理由见开头「三条硬约束」。
