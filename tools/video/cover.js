/**
 * B 站视频封面生成：1920×1080，软件图标 + 成品画 + 标题/卖点。
 *
 * 用法: node tools/video/cover.js
 * 产物: docs/cover-bilibili.png
 *
 * 设计：左侧品牌区（图标 + 茶绘 + 一句话 + 卖点胶囊），右侧成品画大卡片
 * （略微旋转 + 白边 + 投影），画上摆两枚协作光标钉 —— 一眼看出「多人一起画」。
 * 主色取软件图标的蓝，装饰元素沿用成片的设计语言（圆角卡片 / 胶囊 / 上浮阴影）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('../pw');

const OUT = path.resolve(__dirname, '..', '..', 'docs', 'cover-bilibili.png');
const ICON = path.resolve(__dirname, '..', '..', 'client', 'build', 'icon.png');
const FRAME = path.resolve(__dirname, '..', '..', 'video', 'frames', '02-duo-a_26s.png');
const W = 1920, H = 1080;

const b64 = p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');

(async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden;
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
    .stage { position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
      background:
        radial-gradient(900px 700px at 88% 8%, rgba(59,130,224,.14), transparent 60%),
        radial-gradient(800px 620px at 8% 96%, rgba(59,130,224,.10), transparent 55%),
        linear-gradient(160deg, #f2f6fc 0%, #e7eef9 55%, #dde8f7 100%); }
    /* 细网格，像画布底纹 */
    .grid { position: absolute; inset: 0; opacity: .5;
      background-image:
        linear-gradient(rgba(70,110,180,.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(70,110,180,.05) 1px, transparent 1px);
      background-size: 48px 48px; }

    /* ---------------- 右侧：成品画卡片 ----------------
       素材帧 1920×1080，白纸区域在 x[310,1572] y[240,975]。
       卡片 950×560 ≈ 白纸等比：把整帧按 0.753 缩放后反向偏移，
       让白纸正好铺满卡片 —— UI 菜单栏 / 侧栏一点不露。 */
    .art { position: absolute; right: 84px; top: 296px; width: 950px; height: 560px;
      transform: rotate(-2deg); }
    .art .paper { position: absolute; inset: 0; background: #fff;
      border-radius: 26px; border: 10px solid #ffffff;
      box-shadow: 0 30px 70px rgba(24,42,80,.22), 0 6px 18px rgba(24,42,80,.10);
      overflow: hidden; }
    .art .paper img { position: absolute; width: 1446px; height: auto;
      left: -234px; top: -181px; display: block; }

    /* 协作光标钉（照 app 里的远端光标：水滴 pin + 名字胶囊），画在卡片坐标系里 */
    .pin { position: absolute; transform: rotate(-45deg); width: 26px; height: 26px;
      border-radius: 50% 50% 50% 0; border: 3px solid #fff;
      box-shadow: 0 3px 10px rgba(0,0,0,.30); z-index: 2; }
    .pin.a { background: #e8833a; left: 250px; top: 300px; }
    .pin.b { background: #3b82e0; left: 620px; top: 170px; }
    .tag { position: absolute; padding: 7px 16px;
      border-radius: 999px; color: #fff; font-size: 24px; font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,.22); white-space: nowrap; z-index: 2; }
    .tag.a { background: #e8833a; left: 272px; top: 334px; }
    .tag.b { background: #3b82e0; left: 642px; top: 204px; }

    /* ---------------- 左侧：品牌区 ---------------- */
    .brand { position: absolute; left: 128px; top: 128px; width: 860px; }
    .icon { width: 216px; height: 216px; border-radius: 52px; display: block;
      box-shadow: 0 24px 54px rgba(38,84,164,.30), 0 4px 12px rgba(38,84,164,.16); }
    .name { margin-top: 40px; font-size: 196px; line-height: 1.04; font-weight: 800;
      color: #101623; letter-spacing: 6px; }
    .name small { font-size: 44px; font-weight: 600; color: #5b6b85;
      letter-spacing: 2px; margin-left: 18px; }
    .bar { width: 210px; height: 12px; border-radius: 6px; margin: 26px 0 30px;
      background: linear-gradient(90deg, #4b93ea, #2a6ed4); }
    .slogan { font-size: 46px; font-weight: 700; color: #17233a; line-height: 1.4;
      white-space: nowrap; }
    .slogan b { color: #2a6ed4; }

    .chips { position: absolute; left: 132px; top: 866px; display: flex; gap: 22px; }
    .chip { padding: 16px 30px; border-radius: 999px; font-size: 31px; font-weight: 600;
      color: #2456a8; background: rgba(255,255,255,.86);
      border: 2px solid rgba(59,130,224,.35);
      box-shadow: 0 6px 16px rgba(38,84,164,.10); }
    .chip.solid { background: linear-gradient(135deg, #4b93ea, #2a6ed4);
      color: #fff; border-color: transparent; }
  </style></head><body>
  <div class="stage">
    <div class="grid"></div>

    <div class="art">
      <div class="paper"><img src="${b64(FRAME)}" /></div>
      <div class="pin a"></div><div class="tag a">小茶</div>
      <div class="pin b"></div><div class="tag b">阿墨</div>
    </div>

    <div class="brand">
      <img class="icon" src="${b64(ICON)}" />
      <div class="name">茶绘<small>Chahui</small></div>
      <div class="bar"></div>
      <div class="slogan">和朋友们，在同一张画布上<b>一起画</b></div>
    </div>

    <div class="chips">
      <div class="chip solid">免费 · 开源</div>
      <div class="chip">手机 · 电脑 · 公网联机</div>
      <div class="chip">SAI2 式笔刷</div>
    </div>
  </div>
  </body></html>`;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT });
  await browser.close();
  console.log('✓ 封面已生成：' + OUT + '（' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB）');
})().catch(e => { console.error(e); process.exit(1); });
