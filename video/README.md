# 介绍视频

成片：**`video/茶绘-介绍.mp4`**（1920×1080 · 约 53 秒 · H.264 + AAC）。

> 本目录里除了这个 README，其它都是中间产物，已经写进 `.gitignore`，不进版本库。
> 想重新生成，按下面跑一遍就行（本机不需要装 ffmpeg —— 编码是 Chrome 的
> MediaRecorder 干的，Playwright 那个自带的 ffmpeg 只用来录屏打底）。

## 三步重做

```bash
npm run video:shoot    # 1. 用 Playwright 真实操作茶绘，分镜录屏 → video/shots/*.webm
npm run video:build    # 2. 在浏览器里合成（标题卡 / 字幕 / 运镜 / BGM）→ video/茶绘-介绍.mp4
npm run video:verify   # 3. 验一下：能播吗、多长、有没有声音
```

拍摄前要先起一个服务器，并且**用一个干净的房间存档目录** ——
不然「朋友第一次进来」那个镜头里，房间列表会列出一堆测试房间：

```bash
DATA_DIR=./video/serverdata PORT=8451 node server/src/index.js
npm run video:shoot -- http://127.0.0.1:8451
```

## 出问题时用的几个小工具

| 命令 | 干什么 |
| --- | --- |
| `node tools/video/timeline.js video/shots/02-duo-a.webm 1` | 每 1 秒量一次画布着墨比例，一眼看出「第几秒开始画、第几秒画完」——分镜的 `in` 就是这么定的，别靠眼睛猜 |
| `node tools/video/grab.js video/shots/01-solo.webm 3,8,14 video/frames` | 从视频里按时间点抓帧存 PNG（看成片、找问题都靠它） |
| `node tools/video/build.js --preview 9,21,44 --scale 0.5` | 只渲染几个时间点的单帧，改样式时不用整段重跑 |

## 结构

```
tools/video/
  shoot.js      拍摄：真实操作茶绘 + 录屏
  build.js      合成：时间轴 / 标题卡 / 字幕 / 运镜 / BGM / 编码
  timeline.js   量素材（着墨曲线）
  grab.js       抓帧
  verify.js     验成品
video/
  茶绘-介绍.mp4   成片
  shots/        分镜素材（webm）
  frames/       抓出来的帧（排查用）
```

## 改片子主要动哪儿

- **内容 / 节奏**：`tools/video/build.js` 里的 `TIMELINE`。每一段有 `dur`（时长）、
  `in`（从素材第几秒开始用）、`rate`（倍速）、`zoom`（从哪个源矩形推到哪个）、
  `caption`（字幕）。
- **拍什么**：`tools/video/shoot.js` 里的 `ART`（画的东西，用文档比例 0~1）和 `C`（配色）。
- **配乐**：`build.js` 里的 `scheduleMusic()` —— WebAudio 现场合成的
  和弦垫 + 琶音 + 低音，四个和弦 C–G–Am–F 循环，84 BPM。

## 几个已经踩过的坑（改的时候别再踩）

- **坐标一定要用文档比例再乘 `engine.width/height`**。写死像素的话，只要画布尺寸一变，
  点就落到画布外面，`pointerdown` 会被引擎直接忽略 —— 那一笔什么都画不出来，而且界面上不报错。
  `shoot.js` 里每画一笔都会回查 `engine.strokes` 有没有涨，没涨就在控制台喊一声。
- **同一段素材被多个片段用到时，不能边遍历时间轴边改 video 元素**：
  后面那个「当前不在场」的片段会把刚播起来的视频又暂停掉，画面整块空白。
  `build.js` 的 `syncVideos()` 是先算清每个视频的目标状态、再统一应用一次。
- **换段要等 seek 完再播**，否则 `readyState` 掉下去，`drawImage` 画出来是空的。
- 定格镜头不能用 `playbackRate = 0`（非法值），要真的 `pause()` 再 `currentTime`。
- 收尾前记得把鼠标挪出画布，不然定格的时候画上会挂着本机笔刷圈和对方的名字标签。
