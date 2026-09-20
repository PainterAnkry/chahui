/* 回归跑批：把浏览器类测试逐个跑一遍，只收结果。
   用法: node tools/run-all-tests.js [baseUrl]  —— 默认 http://127.0.0.1:8440

   ⚠ 有三个用例需要**压缩计时**的游戏服务端（默认计时下一局要 80 秒，跑不完）：
       test-skin.js / test-skin-ui.js / test-game-restore.js
     以前它们要求人工先起一台 8446，跑批时忘了起就整片红 —— 那是环境问题、
     不是代码问题，却会一直污染汇总。现在由本脚本**自己**在 GAME_PORT 上起一台
     压缩计时的服务端，跑完再关，跑批因此自足、可控、可重复。 */
'use strict';
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8440';
// 压缩计时服务端专用端口（别跟主服务端 8440 撞）
const GAME_PORT = Number(process.env.GAME_TEST_PORT || 8446);
const GAME_BASE = 'http://127.0.0.1:' + GAME_PORT;
// 这三个文件必须打压缩计时的服务端
const NEEDS_GAME_SERVER = ['test-skin.js', 'test-skin-ui.js', 'test-game-restore.js',
  // 接龙重写后的数据流（起词非空 / 自己画自己 / 逐链串行投票）——
  // 它要跑完整整一局接龙，所以也要那台压缩计时的（见 GAME_ENV 里的 GAME_CHAIN_*）
  'test-chain-serial.js'];

/**
 * 「选词窗口要够长」的那一个：test-game-theme.js 要在选词阶段点「换一组」，
 * GAME_PICK_MS=1200 根本来不及。
 * ⚠ 不能直接把 GAME_ENV 的 PICK_MS 调大 —— test-game.js 里有一节是
 *   「选词超时后服务端自动选词」，它**靠 1200ms 的短窗口**才能按时跑到。
 *   所以单独再起一台，两边互不干扰。
 */
const PICK_LONG_PORT = GAME_PORT + 1;
const PICK_LONG_BASE = 'http://127.0.0.1:' + PICK_LONG_PORT;
const NEEDS_LONG_PICK = ['test-game-theme.js', 'test-chain-flow.js'];

const GAME_ENV = Object.assign({}, process.env, {
  PORT: String(GAME_PORT),
  DATA_DIR: path.join(os.tmpdir(), 'chahui-runall-' + Date.now().toString(36)),
  // 画皮：**用 test-skin-ui.js 头部注明的那一套**（不是 test-skin.js 更紧的那套）。
  // test-skin-ui 要驱动 6 个真浏览器页面、逐页读身份卡再点按钮，是按顺序 await 的，
  // 夜晚太短的话轮到预言家时夜早就结束了 —— 会在「验人后就地显示结果」上假红。
  // 两个文件本身都能接受这套（test-skin.js 只是嫌慢，不嫌长）。
  GAME_SKIN_NIGHT_MS: '4000',
  GAME_SKIN_DAWN_MS: '3000',
  GAME_SKIN_DRAW_MS: '4000',
  GAME_SKIN_TALK_MS: '2500',
  GAME_SKIN_VOTE_MS: '3000',
  GAME_SKIN_VOTE_END_MS: '2000',
  GAME_SKIN_WITCH_GRACE_MS: '1500',
  // 经典 / 接龙 / 还原（test-game-restore 靠这几个字段判「是不是压缩计时」）
  GAME_PICK_MS: '1200',
  GAME_ROUND_MS: '2500',
  GAME_ROUND_END_MS: '800',
  // 接龙的计时：test-chain-serial.js 要把「写词 → 作画 → 猜词 → 逐链回放投票」整条流程跑完，
  // 默认（写词 60s、回放 150s、每条链一轮）一局要十几分钟。压到这里一局 ~40 秒。
  // ⚠ v11 起 4 人房是 **8 格**（每格 = 画 + 猜），回放也是**逐格**推的：
  //   每格 = max(CHAIN_REVEAL_LEG_MS_MIN, REVEAL_MS / 链长)，这里 = max(1500, 2500/8) = 1500ms。
  //   test-chain-serial.js 用「房主立刻推进」快速走完回放，所以这条不影响它；
  //   但**别把 REVEAL_MS 再往下压** —— 1500ms 是地板，压了只会更慢。
  GAME_CHAIN_INIT_MS: '1200',
  GAME_CHAIN_WRITE_MS: '3000',
  GAME_CHAIN_DRAW_MS: '4000',
  GAME_CHAIN_GUESS_MS: '3000',
  GAME_CHAIN_REVEAL_MS: '2500',
  GAME_CHAIN_VOTE_MS: '3000',
  GAME_CHAIN_SCORE_MS: '1500',
  GAME_CHAIN_CHAIN_SCORE_MS: '1200'
});

// 「窗口够长」那台：给 test-game-theme.js（要在选词阶段点「换一组」）和
// test-chain-flow.js（4 个页面逐个点按钮走完整局接龙）用。
// ⚠ 接龙这几项必须**宽**：压到 3~4 秒的话，测试还没点到投票，服务端就把整局自动跑完了。
const PICK_LONG_ENV = Object.assign({}, GAME_ENV, {
  PORT: String(PICK_LONG_PORT),
  DATA_DIR: path.join(os.tmpdir(), 'chahui-picklong-' + Date.now().toString(36)),
  GAME_PICK_MS: '9000',
  GAME_ROUND_MS: '3000',
  GAME_ROUND_END_MS: '800',
  GAME_CHAIN_INIT_MS: '1200',
  GAME_CHAIN_WRITE_MS: '8000',
  GAME_CHAIN_DRAW_MS: '8000',
  GAME_CHAIN_GUESS_MS: '8000',
  GAME_CHAIN_REVEAL_MS: '9000',
  GAME_CHAIN_VOTE_MS: '12000',
  GAME_CHAIN_SCORE_MS: '5000',
  GAME_CHAIN_CHAIN_SCORE_MS: '4000'
});

async function reachable(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => true);
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

let gameServer = null;
let pickServer = null;
/* ⚠ 这个函数必须在 SUITE 定义**之后**才调用 —— 它一开始就读 SUITE。
   早先写成 IIFE 直接执行，会撞上 const 的暂时性死区
   （Cannot access 'SUITE' before initialization）。 */
async function runAll() {
  const results = [];

  /* ⚠⚠ 跑批前先看主服务端的房间数。
     跑批会往它撞的那台服务端里**灌几十上百个测试房**（每个建房类用例一个），
     而服务端有 `MAX_ROOMS = 400` 的上限 —— 撞上之后**新建房间会被拒**，
     于是「建房 → 等 state.joined」的用例会成片超时失败（exit 2），
     看起来像代码坏了，其实是环境满了。这一坑真踩过：一次跑批从 5 个失败
     涨到 32 个，查了半天才发现是房间数打到 400。
     所以这里先探一下，满了就吼一嗓子并直接退出，别让你对着一片红排查代码。 */
  try {
    const rl = await fetch(BASE + '/api/rooms').then(r => r.json());
    const n = (rl && rl.rooms && rl.rooms.length) || 0;
    if (n >= 380) {
      process.stdout.write('\n[run-all] ✗ ' + BASE + ' 上已经有 ' + n + ' 个房间（上限 400）——\n'
        + '          再建房会被服务端拒绝，跑批会成片假红。\n'
        + '          请用**干净的存档目录**重起主服务端，例如：\n'
        + '            $env:DATA_DIR = "$env:TEMP\\chahui-main"; $env:PORT = "8440"; node server/src/index.js\n'
        + '          （跑批自己起的那两台 8446/8447 已经用临时目录，不用管）\n\n');
      process.exit(2);
    }
    if (n >= 200) {
      process.stdout.write('\n[run-all] ⚠ ' + BASE + ' 上已有 ' + n + ' 个房间，离上限 400 不远了 ——'
        + '跑完这一轮建议换干净的 DATA_DIR 重起。\n');
    }
  } catch (e) { /* 探不到就算了，别因为这一步把跑批挡住 */ }

  let gameServerUp = false;
  let pickServerUp = false;

  // 只有跑批里真的要用到那三个文件时才起（省得白占端口）
  const needGame = SUITE.some(f => NEEDS_GAME_SERVER.includes(f));
  if (needGame) {
    process.stdout.write('\n[run-all] 正在 ' + GAME_PORT + ' 起一台压缩计时服务端 …\n');
    const outFd = fs.openSync(path.join(os.tmpdir(), 'chahui-runall-server.log'), 'a');
    gameServer = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'src', 'index.js')], {
      env: GAME_ENV, cwd: path.join(__dirname, '..'), stdio: ['ignore', outFd, outFd]
    });
    gameServer.on('exit', code => {
      if (!gameServerUp) return;                 // 收尾时自己关掉的，不算意外
      process.stdout.write('\n[run-all] ⚠ 压缩计时服务端意外退出（code ' + code + '）\n');
    });
    const info = await reachable(GAME_BASE + '/api/share', 20000);
    if (info) {
      gameServerUp = true;
      const sk = info.skin || {};
      process.stdout.write('[run-all] 服务端已就绪 · 画皮 night=' + sk.NIGHT_MS +
        ' dawn=' + sk.DAWN_MS + ' draw=' + sk.DRAW_MS + ' · 经典 round=' +
        (info.game && info.game.ROUND_MS) + '\n');
    } else {
      process.stdout.write('[run-all] ✗ 压缩计时服务端没起来，那三个用例会红（看 ' +
        path.join(os.tmpdir(), 'chahui-runall-server.log') + '）\n');
    }
  }

  // 「选词窗口要够长」那台（test-game-theme.js 要在选词阶段点「换一组」）
  if (SUITE.some(f => NEEDS_LONG_PICK.includes(f))) {
    process.stdout.write('\n[run-all] 正在 ' + PICK_LONG_PORT + ' 起一台「长选词窗口」服务端 …\n');
    const outFd2 = fs.openSync(path.join(os.tmpdir(), 'chahui-runall-pick.log'), 'a');
    pickServer = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'src', 'index.js')], {
      env: PICK_LONG_ENV, cwd: path.join(__dirname, '..'), stdio: ['ignore', outFd2, outFd2]
    });
    pickServer.on('exit', code => {
      if (!pickServerUp) return;
      process.stdout.write('\n[run-all] ⚠ 长选词服务端意外退出（code ' + code + '）\n');
    });
    const info2 = await reachable(PICK_LONG_BASE + '/api/share', 20000);
    if (info2) {
      pickServerUp = true;
      process.stdout.write('[run-all] 已就绪 · PICK_MS=' + (info2.game && info2.game.PICK_MS) + '\n');
    } else {
      process.stdout.write('[run-all] ✗ 长选词服务端没起来，test-game-theme.js 会红（看 ' +
        path.join(os.tmpdir(), 'chahui-runall-pick.log') + '）\n');
    }
  }

  try {
    for (const f of SUITE) {
      const p = path.join(__dirname, f);
      process.stdout.write('\n================ ' + f + ' ================\n');
      // 需要压缩游戏服务端的三个文件 → 传它的地址；要长选词窗口的传那台；其余传主 baseUrl
      const arg = NEEDS_GAME_SERVER.includes(f) ? GAME_BASE
        : (NEEDS_LONG_PICK.includes(f) ? PICK_LONG_BASE : BASE);
      const r = spawnSync(process.execPath, [p, arg], {
        stdio: 'inherit',
        env: process.env,
        cwd: path.join(__dirname, '..')
      });
      results.push({ file: f, code: r.status });
      process.stdout.write('---- ' + f + ' → exit ' + r.status + '\n');
    }
  } finally {
    if (gameServer && gameServerUp) {
      gameServerUp = false;                       // 先落旗，免得 exit 钩子报「意外退出」
      try { gameServer.kill(); } catch (e) { /* ignore */ }
    }
    if (pickServer && pickServerUp) {
      pickServerUp = false;
      try { pickServer.kill(); } catch (e) { /* ignore */ }
    }
  }

  process.stdout.write('\n\n================ 汇总 ================\n');
  let bad = 0;
  for (const x of results) {
    if (x.code !== 0) bad++;
    process.stdout.write((x.code === 0 ? '  ✓ ' : '  ✗ ') + x.file + '  (exit ' + x.code + ')\n');
  }
  process.stdout.write('\n' + (results.length - bad) + '/' + results.length + ' 个测试文件通过\n');
  process.exit(bad ? 1 : 0);
}
const SUITE = [
  'test-browser.js',
  'test-stroke.js',
  'test-selection.js',
  // 纸纹只做「半透调制」不再挖穿笔迹（「纸纹影响笔刷」的回归）
  '_probe-paper.js',
  'test-overlay.js',
  'test-transform-buttons.js',
  'test-brush-import.js',
  'test-project.js',
  'test-paste.js',
  'test-replay.js',
  'test-brush-feel.js',
  'test-menu.js',
  // 窄屏（390/480/660）菜单栏下拉被 overflow 裁掉点不了 —— 固定定位 + 视口夹取
  'test-menu-narrow.js',
  'test-shell.js',
  'test-wheel.js',
  'test-mesh.js',
  'test-filters.js',
  'test-export.js',
  'test-psd.js',
  // 蒙版 / 剪贴蒙版，和 PSD 导入回环（导入器唯一的验收标准就是「画面回来了」）
  'test-mask.js',
  'test-psd-import.js',
  // 数位板压感兼容（绘王一类板子被驱动报成鼠标 → 没压感）：
  // 真笔 / 假鼠标真压力 / 真鼠标 / 起笔占位值 / 面板自检提示
  'test-pen-pressure.js',
  'test-text.js',
  'test-ruler.js',
  'test-liquify.js',
  'test-personal.js',
  'test-layout.js',
  'test-panels.js',
  // 布局设置面板：显隐 / 栏宽 / 界面缩放 / 区块归属与显隐，全部实时生效 + 落盘 + 刷新恢复
  'test-layout-settings.js',
  'test-color.js',
  'test-cansize.js',
  'test-collab-view.js',
  'test-readonly.js',
  // 「有概率看不到别人的某一图层」：笔迹比图层先到必须挂起等待（不许兜底乱落）、
  // 实时笔迹同场景、CANCEL 不诈尸、端到端新建图层立刻作画、蒙版/剪贴缓存键失效
  'test-layer-sync.js',
  // 房主转让（协议层）：权限边界 + isOwner 换位 + 自动移交不回归
  'test-host-transfer.js',
  'test-avatar.js',
  'test-groups.js',
  'test-update.js',
  // 接龙 UI 全流程（重写后）：画在主画布 / 输入条在下方 / 主画布回放 + 逐链串行投票。
  // ⚠ 要那台「宽窗口」的服务端（回放 ≥6s、投票 ≥8s），见 NEEDS_LONG_PICK
  'test-chain-flow.js',
  'test-passkeys.js',
  'test-mobile.js',
  'test-chain-sim.js',
  // 「每局可配的游戏设置」：三个玩法的 start(opts) 覆盖值 / 夹取边界 / GAME_FAST /
  // 房主预设 pendingGame 的清洗与权限 / /api/share 的 setup 档位。
  // 纯 Node，不需要浏览器也不需要服务端。
  'test-game-setup.js',
  // 画皮的离线状态机（发身份 / 验人刀人用药 / 自相残杀 / 四种胜负条件）。
  // 纯 Node，不需要浏览器也不需要服务端 —— 直接 new SkinGame 推状态。
  'test-skin-sim.js',
  // 画皮端到端（WebSocket）：身份保密 + 夜里裁定单发 + 私密作画 + 匿名画廊 + 投票放逐。
  // ⚠ 需要**压缩计时**的服务端（见 test-skin.js 头部注释的启动命令）。
  'test-skin.js',
  // 画皮 UI 冒烟（真 Chrome，六个人）：面板真的画出来了没有、点下去有没有反应。
  // ⚠ 同样需要压缩计时的服务端（/api/share 里要有 skin 计时字段，脚本自己会预检）。
  'test-skin-ui.js',
  // 游戏结束还原原画（「游戏模式吃掉原画」的回归）——要压缩计时服务端
  'test-game-restore.js',
  // 接龙「私密作画」：并行作画时笔迹只回作者本人（#4/#5 的回归）
  'test-chain-private.js',
  // 接龙重写后的数据流（ws 层）：起词非空 / 自己画自己的词 / 逐链串行投票 + √ 过半得奖杯。
  // ⚠ 需要带 GAME_CHAIN_* 压缩计时的服务端（本脚本自己会起）
  'test-chain-serial.js',
  // 你画我猜 · 主题词库接线：「再来一局」不能丢主题、「换一组」要立刻刷新候选词。
  // ⚠ 需要**长选词窗口**的服务端（本脚本自己会在 PICK_LONG_PORT 起一台）
  'test-game-theme.js',
  // 接龙作画阶段的「结构性操作」闸门（图层像素 / 画布尺寸 / 工程装载不许在作画时动）
  'test-chain-lockdown.js',
  'test-theme-ui.js',
  // 入口页那颗「开启 / 关闭服务器」按钮（桌面端桥用打桩的，所以不用起 Electron）
  'test-server-button.js',
  // 纯 Node，不需要服务端也不起浏览器：离线宿主 + 「开启/关闭服务器」的来回切
  'test-local-host.js',
  'test-server-toggle.js',
  // 服务端健壮性：畸形 HTTP（`GET //` 等）不能把进程打挂 —— 曾真的被打挂过。
  // 纯 Node 直连 HTTP，不需要起浏览器；要服务端在跑。
  'test-http-robust.js',
  // 隧道不需要服务端，它自己起假进程；放最后当纯 Node 用例跑
  'test-tunnel.js',
  // 隧道内置组件下载的健壮性：多镜像 / 重试 / Range 断点续传 / 完整性校验。
  // ⚠ 最后一项会真连外网（只取响应头不落盘），网络受限时会红 —— 若在代理环境跑，
  //   把这一项当「参考项」看，重点看本地伪服务器那几组（断流续传）。
  'test-tunnel-download.js',
  'verify-issues.js',
  'verify-round2.js',
  'verify-round3.js'
];

// SUITE 定义完了，这时再开跑（runAll 会读 SUITE）
runAll();
