/**
 * 茶绘 · 安卓 shim 回归（纯 Node，不用起 WebView）
 *
 * 安卓端离线模式的支点是 android-shim.js 里的那套零件：
 *   CommonJS 加载器（fetch + Function 包装）+ fs/path/http/os/ws 桩 + LocalWs 会话。
 * 这条测试把它们当成真的来验 —— 走的路径和 WebView 里**完全一致**：
 *
 *   · manifest 预取 → 逐个加载 local-core 的 10 个源文件（fetchText 换成读磁盘）
 *   · 服务端模块在桩上站得起来（没有 Node 内置可用，一个端口都不占）
 *   · 两个 LocalWs 会话互通：建房、加入、落笔、图层、离场广播，全走原有协议
 *   · 桩语义抽查：path/Buffer/fs 的关键行为
 *
 * 用法: node tools/test-android-shim.js
 * （先跑 node tools/sync-android-core.js 保证 local-core 是新鲜的）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const shim = require('../client/renderer/android-shim.js');
const RENDERER = path.join(__dirname, '..', 'client', 'renderer');
const CORE_DIR = path.join(RENDERER, 'local-core');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('茶绘 安卓 shim 回归（加载器 + 桩 + 内嵌会话）\n');

  /* ---------- 0) 零件与 local-core 就位 ---------- */
  console.log('=== 0) 零件就位 ===');
  for (const k of ['createBufferPolyfill', 'createPathPolyfill', 'createBrowserFs',
    'createProcessStub', 'createHttpStub', 'createOsStub', 'createWsStub',
    'createLoader', 'LocalWs', 'CORE_ENV', 'assembleCore']) {
    ok('导出了 ' + k, typeof shim[k] === 'function' || (typeof shim[k] === 'object' && shim[k]));
  }
  ok('local-core 已同步（先跑 tools/sync-android-core.js）', fs.existsSync(path.join(CORE_DIR, 'manifest.json')));

  /* ---------- 1) 桩语义抽查 ---------- */
  console.log('\n=== 1) 桩语义 ===');
  const Buffer = shim.createBufferPolyfill();
  const pathm = shim.createPathPolyfill();
  ok('path.join 归一化', pathm.join('/data/rooms', 'r1/', '../r2') === '/data/rooms/r2');
  ok('path.resolve 带 .. 上翻', pathm.resolve('/local-core', '..', 'data') === '/data');
  ok('path.dirname / basename', pathm.dirname('/a/b/c.png') === '/a/b' && pathm.basename('/a/c.png', '.png') === 'c');
  const b2 = Buffer.from('你好');
  ok('Buffer base64 往返', Buffer.from(b2.toString('base64'), 'base64').toString('utf8') === '你好');
  ok('Buffer.byteLength 按字节算', Buffer.byteLength('你好') === 6);
  const fsBundle = shim.createBrowserFs({ Buffer, path: pathm });
  const f = fsBundle.fs;
  f.mkdirSync('/data/rooms', { recursive: true });
  f.writeFileSync('/data/rooms/a/1.txt', '文本');
  f.writeFileSync('/data/rooms/a/2.bin', Buffer.from('AAEC', 'base64'));
  ok('fs 写读往返（文本 + 二进制）',
    f.readFileSync('/data/rooms/a/1.txt', 'utf8') === '文本'
    && f.readFileSync('/data/rooms/a/2.bin').toString('base64') === 'AAEC');
  f.renameSync('/data/rooms/a/1.txt', '/data/rooms/a/1b.txt');
  ok('fs rename', f.existsSync('/data/rooms/a/1b.txt') && !f.existsSync('/data/rooms/a/1.txt'));
  const dents = f.readdirSync('/data/rooms', { withFileTypes: true });
  ok('fs readdir withFileTypes', dents.some(d => d.name === 'a' && d.isDirectory())
    && dents.some(d => d.name === 'a' && !d.isDirectory()) === false);
  let threw = false;
  try { f.readFileSync('/data/rooms/没有.txt', 'utf8'); } catch (e) { threw = true; }
  ok('fs 读不存在的文件会抛（ENOENT 语义）', threw);
  f.rmSync('/data/rooms/a', { recursive: true, force: true });
  ok('fs rmSync 递归', !f.existsSync('/data/rooms/a/2.bin'));

  /* ---------- 2) 装配：加载器跑真源码 ---------- */
  console.log('\n=== 2) 加载 local-core ===');
  const core = shim.assembleCore({
    Buffer: Buffer,
    path: pathm,
    fsBundle: fsBundle,
    fetchText: function (url) {
      try { return Promise.resolve(fs.readFileSync(path.join(RENDERER, url), 'utf8')); }
      catch (e) { return Promise.reject(new Error('预取失败 ' + url + '：' + e.message)); }
    }
  });
  const server = await core.boot();
  ok('状态机加载成功（onClient/listen 都在）', typeof server.onClient === 'function' && typeof server.listen === 'function');
  ok('没有监听任何端口（离线不占端口）', server.isListening() === false);
  const P = core.loader.requireModule('/local-core', './protocol.js');
  ok('protocol 模块可二次 require（缓存一致）', !!(P && P.C2S && P.S2C && P.C2S.ROOM_CREATE));

  /* ---------- 3) 会话互通（对照 test-local-host.js 的路数） ---------- */
  console.log('\n=== 3) 内嵌会话 ===');
  function mkClient(label) {
    const box = { label, msgs: [] };
    box.ws = new shim.LocalWs(raw => { try { box.msgs.push(JSON.parse(raw)); } catch (e) { /* ignore */ } });
    server.onClient(box.ws);
    box.send = (t, payload) => box.ws.feed(JSON.stringify(Object.assign({ t }, payload || {})));
    box.last = t => { for (let i = box.msgs.length - 1; i >= 0; i--) if (box.msgs[i].t === t) return box.msgs[i]; return null; };
    box.count = t => box.msgs.filter(m => m.t === t).length;
    box.clear = () => { box.msgs.length = 0; };
    return box;
  }
  const A = mkClient('甲');
  ok('会话拿到了 connId', typeof A.ws._connId === 'string' && A.ws._connId.length > 0, A.ws._connId);
  const hello = A.last(P.S2C.HELLO_OK);
  ok('一上来就收到 HELLO_OK（和真连服务器一样）', !!hello);

  A.clear();
  A.send(P.C2S.ROOM_CREATE, { name: '离线房间', user: '甲', width: 800, height: 1200 });
  const joinedA = A.last(P.S2C.ROOM_JOINED);
  ok('甲建房并进房', !!joinedA && joinedA.you && joinedA.you.isOwner === true);
  ok('默认图层就位', !!joinedA && joinedA.layers.length >= 1);
  const roomId = joinedA && joinedA.room.id;
  const layerId = joinedA && joinedA.layers[0].id;

  const B = mkClient('乙');
  B.clear();
  B.send(P.C2S.ROOM_JOIN, { roomId: roomId, user: '乙' });
  const joinedB = B.last(P.S2C.ROOM_JOINED);
  ok('乙进了同一间房', !!joinedB && joinedB.room.id === roomId);

  A.clear(); B.clear();
// stroke.id 完全由客户端生成（buildStroke 读 msg.id），不带 id 会被状态机静默丢弃；
// 广播带 exceptId —— 作者本人不收自己的 STROKE_BEGIN（本地已画），得从乙那边看
A.send(P.C2S.STROKE_BEGIN, { id: 'stroke-1', layerId, x: 10, y: 10, p: 0.5, brush: { id: 'pen' } });
const beginMsg = B.last(P.S2C.STROKE_BEGIN);
ok('甲的笔迹广播出去了', !!beginMsg && !!beginMsg.stroke);
const strokeId = (beginMsg && beginMsg.stroke && beginMsg.stroke.id) || 'stroke-1';
A.send(P.C2S.STROKE_POINTS, { id: strokeId, pts: [[12, 12, 0.6]] });
await sleep(50);
ok('乙收到了甲的笔迹（消息经状态机互通）', B.count(P.S2C.STROKE_BEGIN) >= 1);
A.send(P.C2S.STROKE_END, { id: strokeId });

  A.clear(); B.clear();
  A.ws.close();
  await sleep(60);
  // leaveRoom 广播的是成员表（MEMBERS）+ 系统聊天，没有 MEMBER_LEFT 这个类型
  ok('甲离场，乙收到了成员表更新', B.count(P.S2C.MEMBERS) >= 1);

  /* ---------- 4) 存档落在桩上（内存树里有 room.json） ---------- */
  console.log('\n=== 4) 存档 ===');
  await sleep(1700);   // markDirty 的防抖存盘是 1500ms，留点余量
  ok('房间存档写进了 fs 桩（room.json）', f.existsSync('/data/rooms/' + roomId + '/room.json'));
  ok('存档里能读回房间名', (function () {
    try { return JSON.parse(f.readFileSync('/data/rooms/' + roomId + '/room.json', 'utf8')).name === '离线房间'; }
    catch (e) { return false; }
  })());

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试没跑起来：', e);
  process.exit(1);
});
