/**
 * 茶绘 · 离线宿主回归（纯 Node，不用起 Electron）
 *
 * 「关掉服务器」之后还能画画，靠的是 client/local-host.js ——
 * 它在同一个进程里用服务端的 onClient() 挂一个不走 socket 的客户端。
 * 这一条测试就是把这件事当成真的来验：
 *
 *   · 会话能建起来，并且**不需要监听任何端口**（一个 socket 都不碰）
 *   · 两个离线会话能互相看见 —— 建房、加入、落笔、图层变更全都走原有的协议
 *   · 关掉一个会话，另一个人能收到「他离开了」
 *
 * 为什么值得单独测：这是「离线模式」唯一的支点。它要是漏了某条消息的回路，
 * 表现会是「离线时某些按钮没反应」，而那种毛病在界面上极难定位。
 *
 * 用法: node tools/test-local-host.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// DATA_DIR 必须在 require 服务端之前设好 —— 它是 require 时读环境变量的。
// 而且**不能让测试污染真实的房间存档目录**。
const TMP = path.join(os.tmpdir(), 'chahui-localhost-' + Date.now());
process.env.DATA_DIR = TMP;
process.env.CHAHU_EMBEDDED = '1';

const localHost = require('../client/local-host.js');
const P = require('../client/server/protocol.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}

/** 一个「假渲染层」：把收到的原始字符串解析成消息对象排队 */
function mkClient(label) {
  const box = { label: label, msgs: [], session: null };
  box.session = localHost.createSession({
    toClient: function (raw) { box.msgs.push(JSON.parse(raw)); }
  });
  box.send = function (t, payload) {
    box.session.feed(JSON.stringify(Object.assign({ t: t }, payload || {})));
  };
  box.last = function (t) {
    for (let i = box.msgs.length - 1; i >= 0; i--) if (box.msgs[i].t === t) return box.msgs[i];
    return null;
  };
  box.count = function (t) { return box.msgs.filter(m => m.t === t).length; };
  box.clear = function () { box.msgs.length = 0; };
  return box;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('茶绘 离线宿主回归（进程内，无 socket）\n');

  /* ---------- 1) 会话建得起来，且真的没占端口 ---------- */
  console.log('=== 1) 建会话 ===');
  const A = mkClient('甲');
  ok('会话建起来了，并拿到了 connId', !!A.session.connId, A.session.connId);
  const hello = A.last(P.S2C.HELLO_OK);
  ok('一上来就收到了 HELLO_OK（和真连服务器一样）', !!hello,
    hello ? 'connId=' + hello.connId : '');
  ok('HELLO_OK 里带着房间列表与上限', !!hello && Array.isArray(hello.rooms) && !!hello.limits);
  ok('服务端没有监听任何端口（离线模式不占端口）',
    require('../client/server/index.js').isListening() === false);

  /* ---------- 2) 建房 ---------- */
  console.log('\n=== 2) 甲建房 ===');
  A.clear();
  A.send(P.C2S.ROOM_CREATE, { name: '离线房间', user: '甲', width: 800, height: 1200 });
  const joinedA = A.last(P.S2C.ROOM_JOINED);
  ok('甲进了房间', !!joinedA, joinedA ? joinedA.room.name + ' ' + joinedA.you.name : '');
  ok('甲是房主', !!joinedA && joinedA.you.isOwner === true);
  ok('房间里已经有一个默认图层', !!joinedA && joinedA.layers.length >= 1,
    joinedA ? joinedA.layers.length + ' 层' : '');
  const roomId = joinedA && joinedA.room.id;
  const layerId = joinedA && joinedA.layers[0].id;

  /* ---------- 3) 第二个人加入（同一个进程里的另一个会话） ---------- */
  console.log('\n=== 3) 乙加入（离线也能两个人 —— 就是同一台机器上的两个窗口）===');
  const B = mkClient('乙');
  B.clear();
  B.send(P.C2S.ROOM_JOIN, { roomId: roomId, user: '乙' });
  const joinedB = B.last(P.S2C.ROOM_JOINED);
  ok('乙也进来了', !!joinedB, joinedB ? joinedB.you.name + '（房主=' + joinedB.you.isOwner + '）' : '');
  ok('乙不是房主', !!joinedB && joinedB.you.isOwner === false);
  ok('乙看到了房间里的 2 个人', !!joinedB && joinedB.members.length === 2,
    joinedB ? joinedB.members.map(m => m.name).join(',') : '');
  ok('甲收到了「乙进来了」的成员广播',
    !!A.last(P.S2C.MEMBERS) && A.last(P.S2C.MEMBERS).members.length === 2);

  /* ---------- 4) 落笔：一条笔迹要走完 BEGIN / POINTS / END ---------- */
  console.log('\n=== 4) 甲画一笔，乙要能收到 ===');
  A.clear(); B.clear();
  A.send(P.C2S.STROKE_BEGIN, {
    id: 's1', tool: 'brush', layerId: layerId, color: '#112233',
    size: 12, opacity: 1, points: []
  });
  const begin = B.last(P.S2C.STROKE_BEGIN);
  ok('乙收到了 STROKE_BEGIN', !!begin, begin ? 'tool=' + begin.stroke.tool + ' color=' + begin.stroke.color : '');
  ok('笔刷参数原样传过去了（色值 / 粗细没丢）',
    !!begin && begin.stroke.color === '#112233' && begin.stroke.size === 12);
  A.send(P.C2S.STROKE_POINTS, { id: 's1', pts: [[10, 20, 0.5], [30, 40, 0.6]] });
  const pts = B.last(P.S2C.STROKE_POINTS);
  ok('乙收到了 STROKE_POINTS（两个点）', !!pts && pts.pts.length === 2,
    pts ? JSON.stringify(pts.pts) : '');
  A.send(P.C2S.STROKE_END, { id: 's1', seq: 1 });
  const end = B.last(P.S2C.STROKE_END);
  ok('乙收到了 STROKE_END，并且带上了水位 seq', !!end && end.seq === 1,
    end ? 'seq=' + end.seq : '');

  /* ---------- 5) 图层与元数据 ---------- */
  console.log('\n=== 5) 图层操作（离线时按钮也得有反应）===');
  A.clear(); B.clear();
  A.send(P.C2S.LAYER_ADD, { name: '第二层' });
  const lay = B.last(P.S2C.LAYERS);
  ok('乙收到了 LAYERS（图层数变了）', !!lay && lay.layers.length === 2,
    lay ? lay.layers.map(l => l.name).join('/') : '');
  const lid2 = lay && lay.layers[1] && lay.layers[1].id;
  A.send(P.C2S.LAYER_UPD, { layerId: lid2, patch: { opacity: 0.5, blend: 'multiply', clip: true } });
  const lay2 = B.last(P.S2C.LAYERS);
  const l2 = lay2 && lay2.layers.find(l => l.id === lid2);
  ok('图层补丁（浓度 / 混合 / 剪贴）都到了',
    !!l2 && Math.abs(l2.opacity - 0.5) < 0.01 && l2.blend === 'multiply' && l2.clip === true,
    l2 ? JSON.stringify({ o: l2.opacity, b: l2.blend, c: l2.clip }) : '');

  /* ---------- 6) 聊天 ---------- */
  console.log('\n=== 6) 聊天 ===');
  A.clear(); B.clear();
  A.send(P.C2S.CHAT, { text: '离线测试' });
  const chat = B.last(P.S2C.CHAT);
  ok('乙收到了甲的聊天', !!chat && chat.text === '离线测试', chat ? chat.text : '');

  /* ---------- 7) 离开 ---------- */
  console.log('\n=== 7) 一个人走了，另一个人要知道 ===');
  A.clear();
  B.session.close();
  await sleep(60);
  ok('甲收到了成员变化', !!A.last(P.S2C.MEMBERS) && A.last(P.S2C.MEMBERS).members.length === 1,
    A.last(P.S2C.MEMBERS) ? A.last(P.S2C.MEMBERS).members.length + ' 人' : 'null');

  /* ---------- 8) 房间还在（离线房间和在线房间是同一份存档） ---------- */
  console.log('\n=== 8) 房间存档还在 —— 重开一个会话能再进去 ===');
  const C = mkClient('丙');
  C.clear();
  C.send(P.C2S.ROOM_JOIN, { roomId: roomId, user: '丙' });
  const joinedC = C.last(P.S2C.ROOM_JOINED);
  ok('新会话能进回同一个房间', !!joinedC && joinedC.room.id === roomId);
  ok('房间里的图层还是 2 层（离线画的没丢）',
    !!joinedC && joinedC.layers.length === 2, joinedC ? joinedC.layers.length + ' 层' : '');
  A.session.close();
  C.session.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n测试崩了:', e);
  process.exit(2);
});
