// 打包验收：把 dist/win-unpacked 里的 app.asar 抽出来，确认打进去的确实是当前源码。
// 用法：node tools/verify-pkg.js
// 前一次踩过的坑：只看 build 的汇总像成功，其实便携版根本没生成、asar 里还是旧代码。
// 所以这里直接逐文件比对内容特征，而不是相信日志。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

let asarMod = null;
try {
  asarMod = require(require.resolve('@electron/asar', { paths: [path.join(ROOT, 'client', 'node_modules')] }));
} catch (e) { /* 下面统一报错 */ }

if (!asarMod) {
  console.log('✗ 找不到 @electron/asar（client/node_modules 里没装？）');
  process.exit(2);
}
if (!fs.existsSync(ASAR)) {
  console.log('✗ 没有找到 ' + ASAR + '（先 npm run dist）');
  process.exit(2);
}

// 每条 = [包内文件路径, [必须出现的特征]]。特征挑的是「这次改动才有的东西」，
// 命中不了说明 asar 里还是旧版本。
const CHECKS = [
  ['renderer/config.js', [/appVersion:\s*'([0-9.]+)'/]],
  ['renderer/engine.js', [/renderUnits/, /composeGroup/, /activeGroupIds/, /applyStrokeToMask/, /dropMask/]],
  ['renderer/app.js', [/groupAdd/, /pickUpdateAsset/, /groups/, /tunnelRowHtml/, /setMyAvatar/,
    // v2.0.1：图层蒙版 / 剪贴蒙版 + PSD 导入 + 入口页那颗「离线模式」开关
    // serverButtonAction 是「按按钮文案行事」那一下 —— 有它才说明不是旧的「关闭服务器」语义
    /importPsdBytes/, /toggleOffline/, /serverButtonAction/, /renderServerToggle/, /maskEdit/,
    // v2.0.2：GIF 表情不再 canvas 重编码（否则动画变静态第一帧）+ 头像方形裁剪
    /GIF 无论大小都原样保留/, /openAvaCrop/, /acConfirm/]],
  ['renderer/project.js', [/groups/, /maskPng/]],
  // PSD 导出（v1.10.0）：整块自己写的编码器，特征挑格式里最认得出的几个
  ['renderer/psd.js', [/8BPS/, /luni/, /lddg/, /packbits/, /grayChannelRLE/]],
  // PSD 导入（v2.0.1）：读字节的那一半。少了它，包里的「导入 PSD」会点了没反应
  ['renderer/psd-read.js', [/ChaPsdRead/, /8BPS/, /toProject/]],
  // 游戏音效（v1.10.0）：回合结算音 + 音量滑块
  ['renderer/sfx.js', [/roundEnd/, /setVolume/]],
  // 头像（v1.10.0）：成员表那个白名单必须带上 avatar，否则别人永远收不到
  ['server/rooms.js', [/normalizeGroups/, /moveGroup/, /setLayerGroup/, /avatar/, /hasMask/, /dupLayer/]],
  ['server/index.js', [/GROUP_ADD/, /GROUP_UPD/, /MEMBER_AVATAR/, /GAME_GUESS/,
    // v2.0.1：关服务器再开要重建 wss、离线模式要能从外部挂客户端
    /stopListening/, /createWss/, /function onClient/,
    // v2.0.2：接龙私密作画（笔迹广播抑制 + 按人过滤历史/重同步）
    /privateDrawOn/, /strokeBroadcast/, /strokesFor/]],
  // 中途进房的人先观战（v1.10.0）
  ['server/game.js', [/spectators/,
    // v2.0.2：换一组必须仍在所选主题词库里（第三个参数是主题词池）
    /poolForTheme\(this\.theme\)/]],
  // v2.0.2：接龙不自画 / 掉线顶替 / 观众不投票
  ['server/chain.js', [/pickStandIn/, /isPlayer/]],
  // 应用内一键隧道（v1.10.0）：模块本身也要真的进包
  ['tunnel.js', [/createTunnel/, /trycloudflare/]],
  // 离线模式（v2.0.1）：不占端口的那个客户端，必须在包里
  ['local-host.js', [/createSession/, /LocalWs/]],
  ['preload.js', [/downloadUpdate/, /startTunnel/, /chahu:local-open/, /chahu:server-start/]],
  ['main.js', [/chahu:download-update/, /chahu:tunnel-start/, /chahu:local-open/, /chahu:server-start/]]
];

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
let bad = 0;

for (const [file, pats] of CHECKS) {
  let buf;
  try {
    buf = asarMod.extractFile(ASAR, file);
  } catch (e) {
    console.log('✗ 抽取失败 ' + file + '：' + (e && e.message ? e.message : e));
    bad++; continue;
  }
  if (!buf || !buf.length) { console.log('✗ 空文件 ' + file); bad++; continue; }
  const s = buf.toString('utf8');
  const miss = pats.filter(p => !p.test(s));
  if (miss.length) {
    console.log('✗ ' + file + ' 缺少特征：' + miss.map(String).join(', '));
    bad++; continue;
  }
  console.log('✓ ' + file + '  (' + s.split(/\r?\n/).length + ' 行, ' + (s.length / 1024).toFixed(0) + ' KB)');
}

// 版本号单独核一次：包里的 appVersion 必须等于 package.json
try {
  const cfg = asarMod.extractFile(ASAR, 'renderer/config.js').toString('utf8');
  const m = cfg.match(/appVersion:\s*'([0-9.]+)'/);
  if (!m || m[1] !== pkgVersion) {
    console.log('✗ 包内 appVersion=' + (m && m[1]) + '，但 package.json 是 ' + pkgVersion + '（打包前忘了 sync？）');
    bad++;
  } else {
    console.log('✓ 版本号一致：v' + pkgVersion);
  }
} catch (e) {
  console.log('✗ 读不到包内 config.js：' + e.message);
  bad++;
}

console.log(bad ? ('✗ 失败 ' + bad + ' 项') : '✓ 安装包内容与源码一致');
process.exit(bad ? 1 : 0);
