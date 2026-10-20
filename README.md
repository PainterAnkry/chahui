# 茶绘 · Chahui

**[中文](#中文) · [English](#english)**

> 多人实时协作绘画聊天室 —— 桌面（Electron）/ 安卓（Capacitor）/ 网页三端同一套界面，笔刷与面板对照 PaintTool SAI Ver.2。
>
> A real-time collaborative drawing room — one shared UI across desktop (Electron), Android (Capacitor) and the web, with brushes and panels modelled on PaintTool SAI Ver.2.

---

## 中文

> 开一个房间，把链接发给朋友，大家就能在同一张纸上一起画，边画边聊。所有笔迹实时同步，
> 每台机器都用同一套确定性渲染，**两端像素级一致**。

![主界面](docs/01-主界面.png)

📹 [74 秒介绍视频](https://github.com/PainterAnkry/chahui/releases/download/v2.1.1/chahui-intro-1080p.mp4)

### 下载

直接去 **[Releases](https://github.com/PainterAnkry/chahui/releases/latest)** 拿现成的包：

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `chahui-setup-<版本>.exe` | Windows x64 | 安装版，可自选目录 |
| `chahui-portable-<版本>.exe` | Windows x64 | 免安装，双击即用 |
| `chahui-green-<版本>.zip` | Windows x64 | 绿色版：解压后双击 `茶绘.exe`（报 NSIS Error 的机器用这份） |
| `chahui-linux-<版本>-x86_64.AppImage` | Linux x64 | 通用版：`chmod +x` 后双击即用，无需安装 |
| `chahui-linux-<版本>-amd64.deb` | Debian/Ubuntu x64 | 安装版：双击用软件安装器打开，或 `sudo dpkg -i <文件>` |
| `chahui-linux-<版本>-x64.tar.gz` | Linux x64 | 绿色版：解压后运行 `./茶绘-绿色版-<版本>/chahui-desktop`（先 `chmod +x`） |
| `chahui-android-<版本>.apk` | Android 7.0+ | 安卓版，下载后直接安装 |
| `chahui-linux-<版本>-x86_64.AppImage` | Linux x64 | 通用版：`chmod +x` 后双击即用，无需安装 |
| `chahui-linux-<版本>-amd64.deb` | Debian/Ubuntu x64 | 安装版：双击用软件安装器打开，或 `sudo dpkg -i <文件>` |
| `chahui-linux-<版本>-x64.tar.gz` | Linux x64 | 绿色版：解压后运行 `./茶绘-绿色版-<版本>/chahui-desktop`（先 `chmod +x`） |
| `chahui-server-<版本>.tar.gz` | Linux | 自建服务端（解压覆盖 `server/` 即可） |

> **v2.1.8 只提供 Windows 与安卓包**（Linux 桌面版与服务端包沿用 [v2.1.5](https://github.com/PainterAnkry/chahui/releases/tag/v2.1.5) 的产物）。

- 桌面端升级：「其他 → 关于 → 检查更新」会自己认出该下哪个包并直接下载
- 首次运行弹 SmartScreen 是未签名 exe 的正常提示，点「更多信息 → 仍要运行」即可
- Linux 的 AppImage 首次运行需先 `chmod +x chahui-linux-*-x86_64.AppImage`；Ubuntu 22.04+ 没预装 libfuse2 的，可改用 deb 包，或 `./chahui-linux-*-x86_64.AppImage --appimage-extract` 解压后运行

### 功能一览

**绘画**
- 22 支笔刷（铅笔 / 圆笔 / 水彩 / 马克 / 橡皮 / 油漆桶 / 渐变 / 模糊 / 涂抹 / 散布…），其中 12 支参数直接取自 SAI2 笔刷包
- 每支笔独立控制大小、浓度、边缘硬度、笔压曲线、抖动修正、混色；铅笔带纸纹、水彩笔会与底色融合
- 导入 Photoshop / CSP / Procreate / SAI2 / 画世界Pro 的笔刷（`.abr` `.sut` `.brush` `.saitdat` `.bru`），笔尖跟着笔迹同步，跨端笔触一致
- 导入的笔刷可**批量多选删除**：笔刷栏「批量」→ 勾选 → 一次清掉，内置笔刷不会被误删
- 尺子五种（直线 / 椭圆 / 平行线 / 同心圆 / 集中线）+ 对称尺、网格变换、液化、高斯模糊、色调调整滤镜、文字图层
- 稀疏采样（手快、设备卡、缩放后画）也按圆弧插值补齐，画圆不再出现折线

**选区**
- 选区笔 / 选区擦、框选、套索（松手才闭合）、魔棒（SAI2 式选项面板：取样模式 / 容差 / 防止溢出 / 取样来源）
- `Shift` 加选、`Alt` 减选；蚂蚁线沿真实形状走，画笔画不出选区会明确提示

**图层与文件**
- 17 种混合模式、不透明度、保护不透明度、四把锁
- 图层组（组参数对成员只作用一次）、图层蒙版 / 剪贴蒙版（非破坏，能进 PSD 也能读回来）
- 工程文件 `.chahu`（画布 + 图层 + 像素，换机器接着画）+ 崩溃自动恢复
- 导出 png / jpg / webp / bmp / tga，以及**带图层和图层组的 PSD**（也能导入 PSD）

**协作**
- 房间列表、密码房间、头像、成员列表、实时聊天 + 表情包、远端光标
- 只读观众（服务端拦截写操作）、他人笔触淡化 / 单人隐藏（纯本机显示）
- 作画过程回放（逐笔生长、洋葱皮、作者标注、倍速、一键导出视频）

**联机小游戏**（房间内开局，玩完接着画）
- **你画我猜**：轮流派画手，猜对得分，卡住自动露字
- **接龙 / 传词接龙**：画→猜→画接力，逐链回放投票
- **画皮**：夜里验人、白天投票的绘画狼人杀
- 15 套主题词库 + 自建词库；答案与题面全走服务端私有消息，想作弊也没得扒

**界面**
- **简体中文 / English / 日本語** 三语界面，右上角「中 / EN / 日」随时切换，默认中文，选择记在本机
- 浅色 / 深色主题（默认跟随系统）、SAI2 式菜单栏、快捷键可改、面板可拖动排序 / 拖成浮窗

### 快速开始

**桌面版：双击即用**

1. 双击「茶绘」（内置服务器自动启动，默认 8437 端口）
2. 创建房间，点「分享」或「复制地址」
3. 同一 WiFi 下的朋友**用浏览器打开那个链接**就进来一起画（他们什么都不用装）

![双击即联机](docs/05-双击即联机.png)

**公网联机**

- **桌面端**：房间信息面板点「开启公网联机」，App 自动起一条 cloudflared 快速隧道，复制公网链接发出去即可（不用装任何额外软件）
- **安卓 / 网页端房主**：优先走 **WebRTC P2P 直连**（点对点，不经过服务器）；打洞失败时可回落到**你自己配置的服务端**当哑中继（在 `client/renderer/config.js` 的 `publicServer` 填自建地址即可）。官方公共服务器已下线，不再提供默认中继
- **网页端访客**：需要一台托管了网页版的服务端来打开页面（自建 `server/` 或任意静态托管）；装了茶绘的桌面 / 安卓端则可以直接用 `chahui://` 应用链接进房
- 命令行方式：`npm run expose`（服务端跑着的情况下，一条命令开临时隧道）
- 有公网服务器的话直接部署 `server/`，大家访问 `http://<公网地址>:8437`

**自建服务端 / 网页版**

```bash
npm install --prefix server
npm run server          # 默认监听 0.0.0.0:8437
```

浏览器打开 `http://localhost:8437` 就是网页版。环境变量（`PORT` / `DATA_DIR` / `MAX_ROOMS` /
限流等）都有默认值，见 `server/src/index.js` 头部注释。

### 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 全选 / 取消 / 反选 | `Ctrl+A` / `Ctrl+D` / `Ctrl+I` |
| 变换 | `Ctrl+T`，`Enter` 确定、`Esc` 中止 |
| 新建图层 | `Ctrl+Shift+N` |
| 导出 PNG | `Ctrl+S` / `Ctrl+E` |
| 工具 | `B` 画笔 `E` 橡皮 `U` 模糊 `S` 涂抹 `G` 油漆桶 `N` 渐变 `W` 魔棒，按住 `Alt` 临时吸管 |
| 抓手 / 平移 | 空格 + 左键拖动（或中键；触屏单指拖画布） |
| 笔刷大小 | `[` / `]` |
| 前景 / 背景互换 | `X`（`D` 回到黑 / 白） |
| 缩放 | 滚轮 |

### 开发

需要 Node.js 18+。

```bash
npm run sync            # 同步协议 + 前端 + 服务端（改代码后必跑）
npm run check           # CSS / 函数 / 元素 id / 协议接线静态检查
npm test                # 双虚拟客户端端到端（不需要浏览器）
npm run test:browser    # Chrome 双上下文端到端（含两端像素比对）
npm run test:all        # 一次跑完全部浏览器类回归
```

**四个「唯一来源」**：协议只改 `shared/protocol.js`、前端只改 `client/renderer/`、
服务端只改 `server/src/`、界面样式遵循 `docs/DESIGN.md` 的设计令牌 ——
改完跑 `npm run sync`（漏同步 `server/public/` 网页版就是旧代码）。

界面文案的多语言走「源文案作 key」的运行期翻译层：中文写在原处不用动，译文集中在
`client/renderer/i18n-dict.js`（批量生成）与 `client/renderer/i18n-extra.js`（手工补充），
动态文案（数字、房间名、连接地址）由 `i18n.js` 里的正则规则处理。

桌面端开发与打包：

```bash
npm install --prefix client && npm run client   # Electron 开发模式
npm run dist                                    # 打包 Windows 三件套到 dist/
```

安卓端（Capacitor 壳，同一份 `client/renderer`）：

```bash
cd client-android && npm install && npm run sync
cd android && gradlew.bat assembleRelease       # JDK 21 + Android SDK
```

`tools/` 里有同步、测试、验收、截图等脚本；测试大多接受服务端地址作为第一个参数，
例如 `node tools/test-panels.js http://127.0.0.1:8440`。浏览器类测试需要一个
`playwright-core`（不下载浏览器，用本机 Chrome）。

### 许可

[MIT](LICENSE)

---

## English

> Open a room, send the link to your friends, and everyone draws on the same sheet while chatting.
> Every stroke syncs in real time, and every machine runs the same deterministic renderer, so both
> ends match **pixel for pixel**.

![Main window](docs/01-主界面.png)

📹 [74-second intro video](https://github.com/PainterAnkry/chahui/releases/download/v2.1.1/chahui-intro-1080p.mp4)

### Download

Grab a ready-made build from **[Releases](https://github.com/PainterAnkry/chahui/releases/latest)**:

| File | Platform | Notes |
| --- | --- | --- |
| `chahui-setup-<version>.exe` | Windows x64 | Installer, you can pick the folder |
| `chahui-portable-<version>.exe` | Windows x64 | Portable, just double-click |
| `chahui-green-<version>.zip` | Windows x64 | Zipped build: unzip and run `茶绘.exe` (use this if you hit an NSIS Error) |
| `chahui-linux-<version>-x86_64.AppImage` | Linux x64 | Universal: `chmod +x` then run, no install |
| `chahui-linux-<version>-amd64.deb` | Debian/Ubuntu x64 | Installer: open with your software installer, or `sudo dpkg -i <file>` |
| `chahui-linux-<version>-x64.tar.gz` | Linux x64 | Zipped build: unzip and run `./茶绘-绿色版-<version>/chahui-desktop` (after `chmod +x`) |
| `chahui-android-<version>.apk` | Android 7.0+ | Android build, install directly |
| `chahui-server-<version>.tar.gz` | Linux | Self-hosted server (unzip over `server/`) |

> **v2.1.8 ships Windows and Android only.** The Linux desktop and server packages come from [v2.1.5](https://github.com/PainterAnkry/chahui/releases/tag/v2.1.5).

- Desktop updates: **Other → About → Check for updates** picks the right package and downloads it for you
- SmartScreen warns on first run because the exe is unsigned — click "More info → Run anyway"
- On Linux, `chmod +x chahui-linux-*-x86_64.AppImage` first; if Ubuntu 22.04+ lacks libfuse2, use the deb, or run `./chahui-linux-*-x86_64.AppImage --appimage-extract` and launch from there

### Features

**Drawing**
- 22 brushes (pencil / round / watercolour / marker / eraser / bucket / gradient / blur / smudge / scatter…), 12 of them taking their parameters straight from the SAI2 brush pack
- Per-brush size, opacity, edge hardness, pressure curve, stabiliser and colour mixing; pencils carry paper grain, watercolour blends with what's underneath
- Import brushes from Photoshop / CSP / Procreate / SAI2 / Huashijie Pro (`.abr` `.sut` `.brush` `.saitdat` `.bru`); the tip travels with the stroke, so strokes look the same on every device
- Imported brushes can be **removed in bulk**: "Bulk" in the brush bar → tick the ones you want → delete them at once. Built-in brushes are greyed out and can't be removed by accident
- Five ruler types (line / ellipse / parallel / concentric / focus lines) plus symmetry, grid transform, liquify, gaussian blur, tone filters and text layers
- Sparse input (fast strokes, slow devices, zoomed-out canvas) is filled in with circular-arc interpolation, so circles no longer come out as polygons

**Selection**
- Selection pen / selection eraser, marquee, lasso (closes on release), magic wand (SAI2-style options: sampling mode / tolerance / anti-overflow / sample source)
- `Shift` adds, `Alt` subtracts; the marching ants follow the real shape, and the app tells you plainly when a brush can't produce a selection

**Layers and files**
- 17 blend modes, opacity, lock opacity and four locks
- Layer groups (group settings apply once to members), layer masks and clipping masks (non-destructive, survive a PSD round-trip)
- `.chahu` project files (canvas + layers + pixels, continue on another machine) with crash recovery
- Export png / jpg / webp / bmp / tga, and **PSD with layers and groups** (PSD import too)

**Collaboration**
- Room list, password rooms, avatars, member list, live chat with emoji, remote cursors
- Read-only spectators (writes are blocked server-side), dimmed or hidden other-player strokes (local display only)
- Replay of the whole session (strokes grow one by one, onion skin, author labels, speed control, one-click video export)

**Party games** (start inside a room, keep drawing afterwards)
- **Draw & Guess**: take turns drawing, guessers score, the word is revealed when time is up
- **Telestrations**: draw → guess → draw relay, with chain-by-chain replay and voting
- **Skinwalker**: a drawing werewolf game — inspect at night, vote by day
- 15 themed word packs plus your own; answers travel as server-private messages, so there's nothing to peek at

**Interface**
- **Simplified Chinese / English / 日本語**, switchable from the "中 / EN / 日" control at the top right; Chinese is the default and the choice is remembered per machine
- Light / dark themes (follows the system by default), SAI2-style menu bar, remappable shortcuts, draggable and re-orderable panels that can float free

### Quick start

**Desktop: double-click and go**

1. Double-click "茶绘" (the built-in server starts automatically on port 8437)
2. Create a room, then click "Share" or "Copy address"
3. Friends on the same Wi-Fi **open that link in a browser** and start drawing — they install nothing

![LAN in one double-click](docs/05-双击即联机.png)

**Drawing over the internet**

- **Desktop host**: click "Enable internet play" in the room info panel — the app opens a cloudflared quick tunnel and gives you a public link to share (no extra software to install)
- **Android / web host**: prefers a direct **WebRTC P2P** connection (peer to peer, no server in between); if hole punching fails it can fall back to **a server you configure** as a dumb relay (put your address in `publicServer` in `client/renderer/config.js`). The official public server has been retired, so there is no default relay any more
- **Web guests**: you need a server hosting the web build to open the page (self-host `server/` or any static host); installed desktop / Android builds can also join through `chahui://` app links
- From the command line: `npm run expose` (opens a temporary tunnel while the server is running)
- With your own public server, just deploy `server/` and point everyone at `http://<your-host>:8437`

**Self-hosted server / web build**

```bash
npm install --prefix server
npm run server          # listens on 0.0.0.0:8437 by default
```

Open `http://localhost:8437` in a browser for the web build. Environment variables (`PORT` / `DATA_DIR` /
`MAX_ROOMS` / rate limits and so on) all have defaults — see the header comment in `server/src/index.js`.

### Shortcuts

| Action | Shortcut |
| --- | --- |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Select all / deselect / invert | `Ctrl+A` / `Ctrl+D` / `Ctrl+I` |
| Transform | `Ctrl+T`, `Enter` to apply, `Esc` to cancel |
| New layer | `Ctrl+Shift+N` |
| Export PNG | `Ctrl+S` / `Ctrl+E` |
| Tools | `B` brush `E` eraser `U` blur `S` smudge `G` bucket `N` gradient `W` magic wand; hold `Alt` for a temporary eyedropper |
| Hand / pan | Space + drag (or middle mouse; one-finger drag on touch screens) |
| Brush size | `[` / `]` |
| Swap foreground / background | `X` (`D` resets to black / white) |
| Zoom | Mouse wheel |

### Development

Node.js 18+ required.

```bash
npm run sync            # sync protocol + client + server (run after any change)
npm run check           # static checks: CSS, functions, element ids, protocol wiring
npm test                # end-to-end with two virtual clients (no browser needed)
npm run test:browser    # two Chrome contexts end-to-end (includes pixel comparison)
npm run test:all        # run every browser-based regression in one go
```

**Four single sources of truth**: change the protocol only in `shared/protocol.js`, the client
only in `client/renderer/`, the server only in `server/src/`, and follow the design tokens in
`docs/DESIGN.md` for UI styling — then run `npm run sync` (skip it and the web build under
`server/public/` keeps serving the old code).

UI localisation uses a runtime translation layer keyed by the Chinese source string, so the
original copy stays where it is. Translations live in `client/renderer/i18n-dict.js` (generated)
and `client/renderer/i18n-extra.js` (hand-written additions); dynamic strings (numbers, room names,
connection URLs) are handled by the regex rules in `i18n.js`.

Desktop development and packaging:

```bash
npm install --prefix client && npm run client   # Electron dev mode
npm run dist                                    # package the Windows trio into dist/
```

Android (Capacitor shell around the same `client/renderer`):

```bash
cd client-android && npm install && npm run sync
cd android && gradlew.bat assembleRelease       # JDK 21 + Android SDK
```

`tools/` holds the sync, test, acceptance and screenshot scripts; most tests take a server address
as their first argument, e.g. `node tools/test-panels.js http://127.0.0.1:8440`. Browser tests need
`playwright-core` (no browser download — they use your local Chrome).

### Licence

[MIT](LICENSE)
