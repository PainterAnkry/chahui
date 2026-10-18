/**
 * 安卓 / 跨端联机验收打包脚本（一次跑完）：
 *   1. 安卓端到端：shim 回归（本地状态机 + 存档）
 *   2. 安卓公网联机中继链路（真中继）
 *   3. 房间链接解析 / 分享链接生成（浏览器）
 *   4. 安卓默认服务器 /「无需开启」按钮（浏览器）
 *   5. 安卓建房 → Web 访客 P2P 进房（浏览器）
 *   6. 安卓建房 → Web + 桌面渲染层同房作画（真 Electron 需 CHAHU_ELECTRON=1）
 *
 * 用法: node tools/test-android-all.js
 * 说明：需要本机 Chrome；第 6 项要真 Electron 时，先准备 .tmp-electron/electron.exe
 *       （或 dist/win-unpacked），再设 CHAHU_ELECTRON=1。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8437;
const DATA_DIR = path.join(os.tmpdir(), 'chahui-verify-' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(name, args, opts) {
  return new Promise(resolve => {
    console.log('\n\n============================================================');
    console.log('▶ ' + name);
    console.log('============================================================');
    const p = spawn(process.execPath, args, Object.assign({
      cwd: ROOT, stdio: 'inherit'
    }, opts || {}));
    p.on('exit', code => {
      console.log('— ' + name + ' 退出码：' + code);
      resolve(code === 0);
    });
    p.on('error', e => { console.error('— ' + name + ' 起不来：' + e.message); resolve(false); });
  });
}

(async () => {
  // 页面托管服务器（网页版入口）：test-room-link / test-webrtc-p2p 都依赖它
  const srv = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: path.join(DATA_DIR, 'page'),
      // 安卓房主在浏览器里跑 local-core 需要 new Function（真机 WebView 没有 CSP 限制，
      // 网页版 CSP 默认 script-src 'self'）—— 测试服显式放开，生产不要开。
      CHAHU_ALLOW_EVAL: '1'
    }),
    stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); up = r.ok; } catch (e) { await sleep(250); }
  }
  console.log('页面托管服务器：' + (up ? '已就绪 http://127.0.0.1:' + PORT : '起不来'));
  if (!up) { srv.kill(); process.exit(2); }

  const results = [];
  results.push(['安卓端点（shim + 存档）', await run('安卓端点回归', ['tools/test-android-shim.js'])]);
  results.push(['安卓公网联机（中继链路）', await run('安卓公网联机（中继）', ['tools/test-android-tunnel.js'])]);
  results.push(['房间链接 / 分享链接', await run('房间链接与分享链接', ['tools/test-room-link.js', 'http://127.0.0.1:' + PORT])]);
  results.push(['安卓默认服务器 / 无需开启按钮', await run('安卓默认服务器与公网联机按钮', ['tools/test-android-default.js', 'http://127.0.0.1:' + PORT])]);
  results.push(['安卓建房 → Web P2P', await run('安卓建房 → Web P2P', ['tools/test-webrtc-p2p.js', 'http://127.0.0.1:' + PORT, '9527'])]);
  results.push(['安卓建房 → Web + Windows 桌面', await run('安卓建房 → Web + Windows 桌面', ['tools/test-webrtc-desktop.js'])]);

  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n\n============================================================');
  console.log('总览');
  console.log('============================================================');
  let failed = 0;
  for (const [name, ok] of results) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name);
    if (!ok) failed++;
  }
  console.log('\n' + (failed ? (failed + ' 项失败') : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
