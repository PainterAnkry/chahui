/**
 * 茶绘 · 「开启 / 关闭服务器」回归（纯 Node，不用起 Electron）
 *
 * 桌面端入口页那颗按钮干的是两件事，都得能**反复**做：
 *   关 -> 服务器不再监听端口（socket 上连不进来），但房间状态还活着，
 *        紧接着切到离线模式（local-host）就能接着画；
 *   开 -> 端口重新监听，**新**的 WebSocket 客户端还能连上、还能建房。
 *
 * 为什么值得单独测：`wss.close()` 之后那个 WebSocketServer 是不可复用的终态
 * （内部 state 置 CLOSED、http server 上的 upgrade 监听也摘了）。所以「关掉再开」
 * 如果不重建实例，症状是**端口能连上、但握手永远不成功** —— 界面表现为
 * 「服务器开着的，可就是进不去房间」，而且只有第二次开才会出现，极易漏掉。
 *
 * 用法: node tools/test-server-toggle.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const WebSocket = require(path.resolve(__dirname, '..', 'client', 'node_modules', 'ws'));

const PORT = Number(process.env.TOGGLE_PORT || 8441);
// DATA_DIR / PORT 都是服务端模块 **require 那一次**读的环境变量，必须先设好。
// 而且不能让测试污染真实的房间存档。
const TMP = path.join(os.tmpdir(), 'chahui-toggle-' + Date.now());
process.env.DATA_DIR = path.join(TMP, 'rooms');
process.env.CHAHU_EMBEDDED = '1';
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';

const srv = require('../client/server/index.js');
const P = require('../client/server/protocol.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 端口上有人在监听吗 */
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port: port, host: '127.0.0.1' });
    let done = false;
    const fin = v => { if (!done) { done = true; try { s.destroy(); } catch (e) { /* ignore */ } resolve(v); } };
    s.setTimeout(800);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

/** 起一个真 WebSocket 客户端，排队收消息 */
function connectWs() {
  const box = { ws: null, msgs: [], closed: false };
  box.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  box.ws.on('message', (raw) => {
    try { box.msgs.push(JSON.parse(raw.toString())); } catch (e) { /* ignore */ }
  });
  box.ws.on('close', () => { box.closed = true; });
  box.open = new Promise((resolve, reject) => {
    box.ws.on('open', resolve);
    box.ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket 连不上（' + PORT + '）')), 4000);
  });
  box.send = (t, p) => box.ws.send(JSON.stringify(Object.assign({ t: t }, p || {})));
  box.wait = async (t, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 3000)) {
      const m = box.msgs.find(x => x.t === t);
      if (m) return m;
      await sleep(25);
    }
    return null;
  };
  box.close = () => { try { box.ws.close(); } catch (e) { /* ignore */ } };
  return box;
}

(async () => {
  console.log('=== 服务器开关（端口 ' + PORT + '） ===');
  fs.mkdirSync(path.join(TMP, 'rooms'), { recursive: true });

  // ---------------------------------------------------------- 1) 开
  console.log('\n--- 1) 第一次开启 ---');
  ok('还没 listen 时 isListening() 是 false', srv.isListening() === false);
  srv.listen();
  await sleep(300);
  ok('端口开始监听了', await portOpen(PORT));
  ok('isListening() 变 true', srv.isListening() === true);

  const a = connectWs();
  await a.open;
  const hello = await a.wait(P.S2C.HELLO_OK);
  ok('WebSocket 握手成功（收到 HELLO_OK）', !!hello, hello && hello.connId);

  a.send(P.C2S.ROOM_CREATE, { name: '开关测试房', width: 800, height: 600, user: '甲' });
  const joined = await a.wait(P.S2C.ROOM_JOINED);
  ok('能建房并进入', !!joined, joined && joined.room && joined.room.id);
  const roomId = joined && joined.room && joined.room.id;
  const layer0 = joined && joined.layers && joined.layers[0] && joined.layers[0].id;
  ok('建房时带了图层', !!layer0, layer0);

  // 笔迹的 id 是**客户端**指定的（服务端认不出就丢掉），几个字段名也得对准协议：
  // STROKE_POINTS 收 `pts`、STROKE_END 要 `points.length > 0` 才会真的落进房间
  const sid = 's_toggle_1';
  a.send(P.C2S.STROKE_BEGIN, { id: sid, tool: 'brush', color: '#123456', size: 8, layerId: layer0 });
  a.send(P.C2S.STROKE_POINTS, { id: sid, pts: [[5, 5, 0.5], [15, 25, 0.6]] });
  a.send(P.C2S.STROKE_END, { id: sid });
  const end = await a.wait(P.S2C.STROKE_END);
  ok('能落笔（服务端确认了这一笔）', !!end && end.seq >= 1, end && 'seq=' + end.seq);

  // ---------------------------------------------------------- 2) 关
  console.log('\n--- 2) 关闭服务器 ---');
  const stopped = await srv.stopListening();
  ok('stopListening() 返回 true', stopped === true);
  ok('isListening() 变 false', srv.isListening() === false);
  await sleep(250);
  ok('端口不再监听了（连不进来）', (await portOpen(PORT)) === false, '同机别的程序也连不上了');
  ok('原来那个客户端被剪断了', a.closed === true);

  // ---------------------------------------------------------- 3) 再开（关键：wss 必须重建）
  console.log('\n--- 3) 再开一次（这条最要紧）---');
  srv.listen();
  await sleep(300);
  ok('端口又重新监听了', await portOpen(PORT));

  const b = connectWs();
  let bErr = null;
  try { await b.open; } catch (e) { bErr = e; }
  ok('新的 WebSocket 客户端能连上（wss 重建成功）', !bErr, bErr && bErr.message);
  const hello2 = bErr ? null : await b.wait(P.S2C.HELLO_OK);
  ok('第二次开启后握手也正常', !!hello2, hello2 && hello2.connId);

  // 房间存档没丢：关掉服务器不该把房间一起销毁。
  // HELLO_OK 里就带着房间列表（不用再问一次），拿它来核对。
  const list = { rooms: (hello2 && hello2.rooms) || [] };
  ok('第二次开启后能拿到房间列表', list.rooms.length >= 1, list.rooms.length + ' 个房间');
  const still = list && (list.rooms || []).find(r => r.id === roomId);
  ok('关服务器前建的那个房间还在（存档没丢）', !!still, still && still.name);
  ok('房间里的那一笔也还在', !!still && still.strokes >= 1, still && JSON.stringify({ strokes: still.strokes, online: still.online }));

  // 第二次开启后还能正常干活
  b.send(P.C2S.ROOM_JOIN, { roomId: roomId, user: '乙' });
  const joined2 = await b.wait(P.S2C.ROOM_JOINED);
  ok('第二次开启后还能加入原来的房间', !!joined2, joined2 && joined2.layers && joined2.layers.length + ' 层');
  b.send(P.C2S.LAYER_ADD, { name: '再来一层' });
  const layers = await b.wait(P.S2C.LAYERS);
  ok('第二次开启后图层操作也正常', !!layers && layers.layers.length >= 2, layers && layers.layers.length + ' 层');
  b.close();
  await sleep(120);

  // ---------------------------------------------------------- 4) 幂等 / 收尾
  console.log('\n--- 4) 幂等收尾 ---');
  ok('第二次 stopListening() 也能停', (await srv.stopListening()) === true);
  ok('再停一次返回 false（本来就没在跑）', (await srv.stopListening()) === false);
  ok('最终端口是关的', (await portOpen(PORT)) === false);
  ok('isListening() 最终为 false', srv.isListening() === false);

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n测试崩了：', e);
  process.exit(1);
});
