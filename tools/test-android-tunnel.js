/**
 * 茶绘 · 安卓公网联机（隧道宿主）端到端回归 —— 纯 Node，起一台真中继。
 *
 * 守着这条链路：**朋友的协议帧 → 中继 /tunnel/<id> → 手机（shim 隧道宿主）
 * → WebView 里的房间状态机（local-core）→ 原路回给朋友**。
 *   · shim 的 createTunnelHost 在真中继上开出隧道（phase: starting → on）
 *   · 访客用真 ws 连 /tunnel/<id>，发 ROOM_CREATE，要能收到 ROOM_JOINED
 *     —— 即「手机当服务器、公网朋友进房」这条主路径
 *   · 房间协议帧必须原样到达（不能被 JSON 再包一层）
 *   · stop() 之后访客的连接被收回
 *
 * 用法: node tools/test-android-tunnel.js
 * （先跑 node tools/sync-android-core.js 保证 local-core 是新鲜的）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const shim = require('../client/renderer/android-shim.js');
const RENDERER = path.join(__dirname, '..', 'client', 'renderer');
const WS = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
// 隧道宿主用的是全局 WebSocket（WebView 里有）；Node 20 没有 —— 用 ws 包顶上，
// 它实现同一套 onopen/onmessage/onclose 接口
if (typeof global.WebSocket !== 'function') global.WebSocket = WS;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('茶绘 安卓隧道（公网联机）端到端\n');

  /* ---------- 0) 起一台真中继（就是普通的服务端，2.1.1 起自带隧道路由） ---------- */
  const PORT = 8445;
  const DATA_DIR = path.join(os.tmpdir(), 'chahui-tunnel-test-' + Date.now());
  const srv = spawn(process.execPath, ['server/src/index.js'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  const BASE = 'http://127.0.0.1:' + PORT;
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (e) { await sleep(250); }
  }
  ok('中继（服务端）起来了', up, BASE);

  /* ---------- 1) 手机侧：装配 WebView 同款状态机 + 隧道宿主 ---------- */
  const Buffer = shim.createBufferPolyfill();
  const pathm = shim.createPathPolyfill();
  const fsBundle = shim.createBrowserFs({ Buffer, path: pathm });
  const core = shim.assembleCore({
    Buffer, path: pathm, fsBundle,
    fetchText: function (url) {
      try { return Promise.resolve(fs.readFileSync(path.join(RENDERER, url), 'utf8')); }
      catch (e) { return Promise.reject(new Error('预取失败 ' + url)); }
    }
  });
  const host = shim.createTunnelHost(core, shim.LocalWs);
  const states = [];
  host.onState(s => states.push(s));

  /* ---------- 2) 开隧道 ---------- */
  const startRes = await host.start('ws://127.0.0.1:' + PORT);
  ok('隧道开起来了', !!(startRes && startRes.ok), JSON.stringify(startRes));
  const st = host.getStatus();
  ok('相位到 on，拿到访客端点', st.phase === 'on' && /^ws:\/\/127\.0\.0\.1:\d+\/tunnel\/[a-z0-9]+$/.test(st.url), st.url);
  ok('onState 推过 starting → on', states.some(s => s.phase === 'starting') && states.some(s => s.phase === 'on'));

  /* ---------- 3) 朋友从公网进来：真 ws + 真协议帧 ---------- */
  const guest = new WebSocket(st.url);
  const msgs = [];
  // 收集器必须先挂：欢迎帧（hello:ok）在宿主侧挂载完的瞬间就发过来了，晚一步就漏
  guest.on('message', raw => { try { msgs.push(JSON.parse(raw.toString())); } catch (e) { /* 非协议帧 */ } });
  await new Promise((res, rej) => { guest.on('open', res); guest.on('error', rej); });
  ok('访客连上隧道端点', guest.readyState === 1);
  await sleep(400);
  const hello = msgs.find(m => m.t === 'hello:ok');
  ok('挂载欢迎帧 hello:ok 穿过中继到达访客（含房间列表）', !!hello && Array.isArray(hello.rooms));

  guest.send(JSON.stringify({ t: 'room:create', name: '手机开的公网房', user: '机主', width: 1280, height: 720 }));
  await sleep(400);
  const joined = msgs.find(m => m.t === 'room:joined');
  ok('访客在**手机的房间服务器**上建了房（ROOM_JOINED 原路回来）',
    !!joined && joined.you && joined.you.isOwner === true && !!joined.layers && joined.layers.length >= 1);
  ok('帧没有被再包一层（t 是协议原词，不是 TUNNEL_DATA）', msgs.every(m => m.t !== 'TUNNEL_DATA'));

  /* ---------- 4) 第二个访客也能进同一间房（多客户端） ---------- */
  const guest2 = new WebSocket(st.url);
  await new Promise((res, rej) => { guest2.on('open', res); guest2.on('error', rej); });
  const msgs2 = [];
  guest2.on('message', raw => { try { msgs2.push(JSON.parse(raw.toString())); } catch (e) { /* ignore */ } });
  guest2.send(JSON.stringify({ t: 'room:join', roomId: joined.room.id, user: '第二个朋友' }));
  await sleep(400);
  const joined2 = msgs2.find(m => m.t === 'room:joined');
  ok('第二个访客进同一间房（本地房间服务器多客户端）',
    !!joined2 && joined2.room.id === joined.room.id);

  /* ---------- 5) 关隧道：访客被收回 ---------- */
  await host.stop();
  await sleep(500);
  const closed = guest.readyState === 3 || guest.readyState === 2;
  ok('stop() 后隧道收回、访客连接关闭', closed, 'readyState=' + guest.readyState);
  ok('状态回 off', host.getStatus().phase === 'off');

  guest.terminate(); guest2.terminate();
  srv.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试没跑起来：', e);
  process.exit(1);
});
