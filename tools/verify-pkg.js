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
  ['renderer/engine.js', [/renderUnits/, /composeGroup/, /activeGroupIds/, /applyStrokeToMask/, /dropMask/,
    // v2.0.4：「线条中间有顿感」的根治 —— 逐点变宽带状填充 + alpha 迟滞，
    // 两者缺一，包里的笔迹还是会一段粗一段细、每隔几个点掐一下
    /fillVariableRibbon/, /ALPHA_HYST/,
    // v2.0.4 追加：「有概率看不到别人的某一图层」—— 孤儿笔迹挂起等图层，
    // 缺了它包里的多人协作还是会把先到的笔迹兜底到错误的图层上
    /orphanStrokes/, /flushOrphanStrokes/,
    // 同批：合成缓存键必须含蒙版/剪贴状态（否则远端改蒙版那一层看着不更新）
    /\(l\.hasMask \? 1 : 0\)/]],
  ['renderer/app.js', [/groupAdd/, /pickUpdateAsset/, /groups/, /tunnelRowHtml/, /setMyAvatar/,
    // v2.0.1：图层蒙版 / 剪贴蒙版 + PSD 导入 + 入口页那颗「离线模式」开关
    // serverButtonAction 是「按按钮文案行事」那一下 —— 有它才说明不是旧的「关闭服务器」语义
    /importPsdBytes/, /toggleOffline/, /serverButtonAction/, /renderServerToggle/, /maskEdit/,
    // v2.0.2：GIF 表情不再 canvas 重编码（否则动画变静态第一帧）+ 头像方形裁剪
    /GIF 无论大小都原样保留/, /openAvaCrop/, /acConfirm/,
    // v2.0.7（第五轮）：回放铺满画布区（两张离屏画布，笔迹 1:1 落 raw 再整幅缩下来）、
    // 起词/猜词格短、播完接悬念倒计时、纸片下方全场投票圈、投票音效
    /chainRoster/, /crTeaseText/, /crStartTease/, /rawCtx/, /voteSeen/, /myVoteAt/,
    // v2.0.7（第六轮）：回放**画在真画布上**（接管引擎的 replayCanvas，不再有 <img> 面板）、
    // 作画格按笔数播动画、投票阶段留最后一棒的成图
    /crCanvasTake/, /crCanvasShowArt/, /crHideImg/, /engine\.replayCanvas = a\.raw/,
    // v2.0.7（第七轮）：离场收干净（投票纸片别留到下一局）+ 大厅名单过滤掉离场的人
    /crHideVotePaper/, /p\.online !== false/]],
  // v2.0.4 追加：.sut（CSP 笔刷）导入 —— 列名感知的 SQLite 读取 + 真参数连表 + 空白缩略图拒绝
  ['renderer/brush-import.js', [/sqliteTableRows/, /sutBrushMeta/, /isFlatImage/, /cspColumnNames/]],
  ['renderer/project.js', [/groups/, /maskPng/]],
  // PSD 导出（v1.10.0）：整块自己写的编码器，特征挑格式里最认得出的几个
  ['renderer/psd.js', [/8BPS/, /luni/, /lddg/, /packbits/, /grayChannelRLE/]],
  // PSD 导入（v2.0.1）：读字节的那一半。少了它，包里的「导入 PSD」会点了没反应
  ['renderer/psd-read.js', [/ChaPsdRead/, /8BPS/, /toProject/]],
  // 游戏音效（v1.10.0）：回合结算音 + 音量滑块
  // v2.0.7（第五轮）：悬念倒计时 / 揭晓惊喜音 / 投票落章音
  ['renderer/sfx.js', [/roundEnd/, /setVolume/, /tease\(\)/, /countTick/, /voteStamp/, /voteLand/]],
  // v2.0.7：回放画面铺满画布区（去掉卡片外观）+ 悬念倒计时读数 + 空圈占位
  ['renderer/styles.css', [/ccl-cd/, /ccl-img/, /rm\.pending/]],
  // v2.0.7：每一格的时长不再一样（legMs 表）+ 16 版协议（按笔数播动画 / 猜词定格 2 秒）
  ['server/protocol.js', [/CHAIN_REVEAL_TEASE_MS/, /CHAIN_REVEAL_DRAW_PER_STROKE_MS/,
    /chainRevealAnimMs/, /PROTOCOL_VERSION = 16/]],
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
  // ⚠ 原来这里记的是 pickStandIn / isPlayer 两个函数名 —— 它们在后来的重构里改掉了
  //   （掉线顶替 / 观战现在是 spectators + votersFor 这套），继续留着只会每次打包
  //   报一条假的「缺少特征」。换成现在真实存在的两个：
  //     · spectators：中途进房的人本局只观战（不进环、不投票）
  //     · votersFor ：投票人 = **这条链那一组**的人（跨组不算票）
  // v2.0.7（第五轮）：每格时长分开算（legMsAt / legMsOf）+ 起词猜词格的悬念尾
  // v2.0.7（第六轮）：作画格按**笔数**算动画（chainRevealAnimMs + DRAW_* 常量）
  ['server/chain.js', [/spectators/, /votersFor/, /legMsAt/, /legMsOf/, /REVEAL_TEASE_MS/,
    /REVEAL_DRAW_PER_STROKE_MS/, /REVEAL_HOLD_MS/]],
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
