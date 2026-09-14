/**
 * 茶绘 · 端到端联调脚本
 * 用两个虚拟客户端验证：建房 / 加入 / 笔迹同步 / 图层 / 撤销重做 / 聊天 / 迟到者快照 / 固化底图
 * 用法: node tools/test-clients.js [ws://host:port/ws]
 */
'use strict';

const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = process.argv[2] || 'ws://localhost:8437/ws';

let pass = 0, fail = 0;
const failures = [];

/** 把 ws(s):// 地址换算成 http(s)://，用来打 REST 接口 */
function httpBase() {
  return URL_.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws\/?$/, '');
}

function httpJson(pathname) {
  return new Promise((resolve) => {
    const mod = /^https:/.test(httpBase()) ? require('https') : require('http');
    const req = mod.get(httpBase() + pathname, { timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}

function Client(name) {
  const ws = new WebSocket(URL_);
  const c = {
    name, ws, log: [], room: null, you: null, layers: [], members: [], chat: [],
    history: [], got: {}, closed: false, lastBase: null
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) {
      c.room = m.room; c.you = m.you; c.layers = m.layers; c.members = m.members;
      c.chat = m.chat || []; c.history = [];
      c.baseImages = (m.history && m.history.baseImages) || {};
      c.gotBase = Object.keys(c.baseImages).length > 0;
    }
    if (m.t === P.S2C.HISTORY_CHUNK) c.history.push(...(m.strokes || []));
    if (m.t === P.S2C.STROKE_BEGIN) (c.got.begin = c.got.begin || []).push(m.stroke);
    if (m.t === P.S2C.STROKE_POINTS) c.got.pts = (c.got.pts || 0) + m.pts.length;
    if (m.t === P.S2C.STROKE_END) (c.got.end = c.got.end || []).push(m);
    if (m.t === P.S2C.STROKE_REMOVED) (c.got.removed = c.got.removed || []).push(m);
    if (m.t === P.S2C.STROKE_ADDED) (c.got.added = c.got.added || []).push(m.stroke);
    if (m.t === P.S2C.LAYERS) {
      c.layers = m.layers;
      if (m.baseImages) c.lastBase = Object.assign(c.lastBase || {}, m.baseImages);
    }
    if (m.t === P.S2C.MEMBERS) c.members = m.members;
    if (m.t === P.S2C.CHAT) c.chat.push(m);
    if (m.t === P.S2C.PONG) (c.got.pong = c.got.pong || []).push(m);
    if (m.t === P.S2C.ERROR) (c.got.errors = c.got.errors || []).push(m);
  });
  c.send = (t, payload) => ws.send(JSON.stringify(Object.assign({ t }, payload || {})));
  c.ready = () => new Promise(r => ws.once('open', r));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 轮询等待某个条件成立（成功立刻返回，不必等满）。
 *
 * 为什么不用固定 sleep：服务端把房间目录挪走、写存档、压消息都在同一个
 * 事件循环 / 线程池里排队，宿主机磁盘一忙，广播就可能晚到几十~几百毫秒。
 * 固定 sleep 会变成随机失败，轮询则只在「真的没发生」时才失败。
 */
async function waitFor(cond, timeoutMs) {
  const end = Date.now() + (timeoutMs || 2500);
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= end) return cond();
    await sleep(50);
  }
}

function stroke(id, layerId, color, n, size) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(P.qp([100 + i * 7.3, 200 + Math.sin(i / 3) * 40, 0.5]));
  return { id, layerId, color, size: size || 8, pts };
}

async function main() {
  console.log('茶绘端到端联调 @ ' + URL_ + '\n');

  const A = Client('阿尔法');
  const B = Client('贝塔');
  await Promise.all([A.ready(), B.ready()]);

  console.log('[1] 建房与加入');
  const roomId = 'test_' + Date.now().toString(36);
  A.send(P.C2S.ROOM_CREATE, { id: roomId, name: '联调测试室', user: '阿尔法', width: 1600, height: 1000, background: '#ffffff' });
  await sleep(300);
  ok('A 建房成功', !!A.room, A.got.errors ? JSON.stringify(A.got.errors) : 'no room');
  ok('A 成为房主', A.you && A.you.isOwner === true);
  ok('默认 1 个图层', A.layers.length === 1, '实际 ' + A.layers.length);

  const roomId2 = A.room ? A.room.id : roomId;
  B.send(P.C2S.ROOM_JOIN, { roomId: roomId2, user: '贝塔' });
  await sleep(300);
  ok('B 加入成功', !!B.room && B.room.id === roomId2);
  ok('A 看到 2 名成员', A.members.length === 2, '实际 ' + A.members.length);
  ok('B 不是房主', B.you && B.you.isOwner === false);

  console.log('\n[2] 实时笔迹同步');
  const s1 = stroke('s_alpha_1', A.layers[A.layers.length - 1].id, '#ec4141', 40);
  A.send(P.C2S.STROKE_BEGIN, { id: s1.id, layerId: s1.layerId, tool: 'brush', color: s1.color, size: s1.size, opacity: 1 });
  A.send(P.C2S.STROKE_POINTS, { id: s1.id, pts: s1.pts.slice(0, 20) });
  await sleep(60);
  A.send(P.C2S.STROKE_POINTS, { id: s1.id, pts: s1.pts.slice(20) });
  A.send(P.C2S.STROKE_END, { id: s1.id });
  await sleep(300);
  ok('B 收到 stroke:begin', !!B.got.begin && B.got.begin[0].id === s1.id);
  ok('B 收到全部 40 个点', B.got.pts === 40, '实际 ' + B.got.pts);
  ok('B 收到 stroke:end 并带 seq', !!B.got.end && !!B.got.end[0].seq);
  ok('A 也收到自己的 seq 回执', !!A.got.end && !!A.got.end[0].seq);

  console.log('\n[3] 撤销 / 重做');
  A.send(P.C2S.STROKE_UNDO, { ids: [s1.id] });
  await sleep(250);
  ok('B 收到撤下笔迹', !!B.got.removed && B.got.removed[0].ids.indexOf(s1.id) >= 0);
  const redoStroke = { id: s1.id, layerId: s1.layerId, tool: 'brush', color: s1.color, size: s1.size, opacity: 1, points: s1.pts };
  A.send(P.C2S.STROKE_REDO, { stroke: redoStroke });
  await sleep(250);
  ok('重做后所有端收到 stroke:added', !!B.got.added && B.got.added.some(s => s.id === s1.id));

  console.log('\n[4] 他人笔迹不可被撤销');
  B.send(P.C2S.STROKE_UNDO, { ids: [s1.id] });
  await sleep(200);
  const removedByB = (B.got.removed || []).length;
  ok('B 撤销 A 的笔迹被拒绝（无二次移除）', removedByB === 1, '实际 ' + removedByB);

  console.log('\n[5] 图层操作');
  A.send(P.C2S.LAYER_ADD, { name: '草稿层' });
  await sleep(200);
  ok('图层增加到 2 个', B.layers.length === 2, '实际 ' + B.layers.length);
  const topId = B.layers[B.layers.length - 1].id;
  B.send(P.C2S.LAYER_UPD, { layerId: topId, patch: { opacity: 0.5, name: '半透明层' } });
  await sleep(200);
  const upd = A.layers.find(l => l.id === topId);
  ok('图层属性同步（名字/透明度）', upd && upd.name === '半透明层' && Math.abs(upd.opacity - 0.5) < 0.001);

  console.log('\n[6] 多人同层同时作画');
  const s2 = stroke('s_beta_1', topId, '#3c9fe0', 30);
  const s3 = stroke('s_alpha_2', topId, '#4caf74', 30);
  B.send(P.C2S.STROKE_BEGIN, { id: s2.id, layerId: topId, tool: 'brush', color: s2.color, size: 14, opacity: 0.8, hardness: 0.2 });
  B.send(P.C2S.STROKE_POINTS, { id: s2.id, pts: s2.pts });
  B.send(P.C2S.STROKE_END, { id: s2.id });
  A.send(P.C2S.STROKE_BEGIN, { id: s3.id, layerId: topId, tool: 'line', color: s3.color, size: 4, opacity: 1 });
  A.send(P.C2S.STROKE_POINTS, { id: s3.id, pts: [s3.pts[0], s3.pts[29]] });
  A.send(P.C2S.STROKE_END, { id: s3.id });
  await sleep(320);
  ok('B 收到 A 的直线', (A.got.end || []).length >= 1 && (B.got.end || []).some(e => e.id === s3.id));
  ok('A 收到 B 的柔边笔', (A.got.end || []).some(e => e.id === s2.id));

  console.log('\n[7] 聊天');
  B.send(P.C2S.CHAT, { text: '一起来画吧！' });
  await sleep(200);
  ok('A 收到聊天', A.chat.some(m => m.text === '一起来画吧！'));

  console.log('\n[8] 迟到者快照同步');
  const C = Client('伽马');
  await C.ready();
  C.send(P.C2S.ROOM_JOIN, { roomId: roomId2, user: '伽马' });
  await sleep(600);
  ok('C 拿到历史笔迹', C.history.length >= 3, '实际 ' + C.history.length);
  ok('C 拿到 2 个图层', C.layers.length === 2);
  ok('C 拿到历史聊天记录', C.chat.some(m => m.text === '一起来画吧！'));

  console.log('\n[9] 只有房主能清空整个画布');
  B.send(P.C2S.STROKE_CLEAR, { scope: 'all' });
  await sleep(200);
  ok('非房主清空被拒绝', (B.got.errors || []).some(e => e.code === 'not_owner'));

  console.log('\n[10] 固化底图（压缩历史）');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngs = {}; A.layers.forEach(l => { pngs[l.id] = png; });
  const lastSeq = Math.max(...(A.got.end || [{ seq: 0 }]).map(e => e.seq || 0), 0);
  A.send(P.C2S.ROOM_COMPRESS, { pngs, upToSeq: lastSeq });
  await sleep(300);
  const D = Client('德尔塔');
  await D.ready();
  D.send(P.C2S.ROOM_JOIN, { roomId: roomId2, user: '德尔塔' });
  await sleep(500);
  ok('新客户端收到底图', D.gotBase === true, '底图图层 ' + JSON.stringify(Object.keys(D.baseImages || {})));
  ok('固化后历史笔迹被裁剪为 0', D.history.length === 0, 'C=' + C.history.length + ' D=' + D.history.length);

  console.log('\n[11] 房间列表');
  A.send(P.C2S.ROOM_LIST, {});
  await sleep(200);
  const listMsg = A.log.filter(m => m.t === P.S2C.ROOM_LIST).pop();
  ok('房间列表包含测试房间', !!listMsg && listMsg.rooms.some(r => r.id === roomId2));

  console.log('\n[12] 离开房间');
  B.send(P.C2S.ROOM_LEAVE, {});
  await sleep(250);
  ok('A 看到成员数减少', A.members.length === 3, '实际 ' + A.members.length);

  console.log('\n[13] 房主解散房间');
  const E = Client('艾普西龙');
  await E.ready();
  E.send(P.C2S.ROOM_JOIN, { roomId: roomId2, user: '艾普西龙' });
  await sleep(300);
  const D2 = Client('额外观察者');
  await D2.ready();
  D2.send(P.C2S.ROOM_JOIN, { roomId: roomId2, user: '额外观察者' });
  await sleep(300);
  D2.send(P.C2S.ROOM_DESTROY, {});          // 非房主尝试解散
  await sleep(250);
  ok('非房主解散被拒绝', (D2.got.errors || []).some(e => e.code === 'not_owner'));
  A.send(P.C2S.ROOM_DESTROY, {});            // 房主解散
  const notified = await waitFor(
    () => E.log.some(m => m.t === P.S2C.ROOM_DESTROYED) && D2.log.some(m => m.t === P.S2C.ROOM_DESTROYED));
  ok('成员收到房间已解散', notified,
    'E=[' + E.log.map(m => m.t).join(',') + '] D2=[' + D2.log.map(m => m.t).join(',') + ']');
  C.send(P.C2S.ROOM_LIST, {});
  const removed = await waitFor(() => {
    const l = C.log.filter(m => m.t === P.S2C.ROOM_LIST).pop();
    return !!l && !l.rooms.some(r => r.id === roomId2);
  });
  const list2 = C.log.filter(m => m.t === P.S2C.ROOM_LIST).pop();
  ok('房间已从列表移除', removed,
    'roomId2=' + roomId2 + ' 列表=[' + ((list2 && list2.rooms) || []).map(r => r.id).join(',') + ']');

  A.ws.close(); B.ws.close(); C.ws.close(); D.ws.close(); E.ws.close(); D2.ws.close();
  await sleep(200);

  /* ================= v2：SAI2 风格笔刷与图层能力 ================= */
  const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  console.log('\n[14] v2 · 笔刷参数完整同步（SAI2 风格）');
  const vid = 'v2_' + Date.now().toString(36);
  const X = Client('西格玛');
  const Y = Client('陶');
  await Promise.all([X.ready(), Y.ready()]);
  X.send(P.C2S.ROOM_CREATE, { id: vid, name: 'SAI2 验证室', user: '西格玛', width: 1200, height: 800 });
  await sleep(300);
  ok('X 建房成功', !!X.room, X.got.errors ? JSON.stringify(X.got.errors) : 'no room');
  Y.send(P.C2S.ROOM_JOIN, { roomId: vid, user: '陶' });
  await sleep(300);
  ok('Y 加入成功', !!Y.room && Y.room.id === vid);

  const lx = X.layers[X.layers.length - 1].id;
  const SEED = 123456;
  X.send(P.C2S.STROKE_BEGIN, {
    id: 's_v2_full', layerId: lx, tool: 'brush', color: '#3366cc', size: 24, opacity: 0.9,
    hardness: 0.35, minSize: 0.08, pressSize: 1, pressOpacity: 0.7,
    edge: 0.5, scatter: 0.3, grain: 0.6, blend: 'multiply', sym: 'xy',
    brush: 'watercolor', seed: SEED
  });
  X.send(P.C2S.STROKE_POINTS, { id: 's_v2_full', pts: stroke('s_v2_full', lx, '#3366cc', 20).pts });
  X.send(P.C2S.STROKE_END, { id: 's_v2_full' });
  await sleep(320);
  const hdr = (Y.got.begin || []).find(s => s.id === 's_v2_full');
  ok('笔刷参数（硬度/笔压/水彩边缘/散布/颗粒）完整同步',
    !!hdr && Math.abs(hdr.hardness - 0.35) < 1e-6 && hdr.pressSize === 1 && Math.abs(hdr.pressOpacity - 0.7) < 1e-6
    && Math.abs(hdr.edge - 0.5) < 1e-6 && Math.abs(hdr.scatter - 0.3) < 1e-6 && Math.abs(hdr.grain - 0.6) < 1e-6,
    hdr ? JSON.stringify({ h: hdr.hardness, po: hdr.pressOpacity, e: hdr.edge, sc: hdr.scatter, g: hdr.grain }) : 'no begin');
  ok('混合模式 / 对称 / 预设名随笔迹下传', !!hdr && hdr.blend === 'multiply' && hdr.sym === 'xy' && hdr.brush === 'watercolor');
  ok('seed 由服务端固定并下传（保证多端随机一致）', !!hdr && hdr.seed === SEED, hdr ? 'seed=' + hdr.seed : 'no begin');

  console.log('\n[15] v2 · 非法参数收敛');
  X.send(P.C2S.STROKE_BEGIN, {
    id: 's_v2_clamp', layerId: lx, tool: 'soft', color: '#000000', size: 9999, opacity: -5,
    hardness: 5, minSize: 0.001, tolerance: 999, expand: 99
  });
  X.send(P.C2S.STROKE_POINTS, { id: 's_v2_clamp', pts: stroke('s_v2_clamp', lx, '#000000', 8).pts });
  X.send(P.C2S.STROKE_END, { id: 's_v2_clamp' });
  await sleep(300);
  const h2 = (Y.got.begin || []).find(s => s.id === 's_v2_clamp');
  ok('未知工具回落 brush', !!h2 && h2.tool === 'brush', h2 ? h2.tool : 'no begin');
  ok('size 上限 400 / opacity 下限 0.02', !!h2 && h2.size === 400 && Math.abs(h2.opacity - 0.02) < 1e-6, h2 ? h2.size + '/' + h2.opacity : '');
  ok('hardness / minSize / tolerance / expand 收敛', !!h2 && h2.hardness === 1 && Math.abs(h2.minSize - 0.02) < 1e-6 && h2.tolerance === 120 && h2.expand === 12);

  console.log('\n[15.5] v3 · SAI2 新工具与纸纹 / 特效参数');
  X.send(P.C2S.STROKE_BEGIN, {
    id: 's_v3_smudge', layerId: lx, tool: 'smudge', color: '#000000', size: 30, opacity: 1,
    strength: 0.5, grainScale: 2.5, paper: 'coarse', fx: 'waterdrop', blend: 'soft-light'
  });
  X.send(P.C2S.STROKE_POINTS, { id: 's_v3_smudge', pts: stroke('s_v3_smudge', lx, '#000000', 10).pts });
  X.send(P.C2S.STROKE_END, { id: 's_v3_smudge' });
  await sleep(320);
  const h3 = (Y.got.begin || []).find(s => s.id === 's_v3_smudge');
  ok('涂抹工具被服务端接受', !!h3 && h3.tool === 'smudge', h3 ? h3.tool : 'no begin');
  ok('纸纹比例 / 纸张质感 / 特殊效果同步',
    !!h3 && Math.abs(h3.grainScale - 2.5) < 1e-6 && h3.paper === 'coarse' && h3.fx === 'waterdrop',
    h3 ? JSON.stringify({ gs: h3.grainScale, p: h3.paper, fx: h3.fx }) : 'no begin');
  ok('新增混合模式 soft-light 被接受', !!h3 && h3.blend === 'soft-light', h3 ? String(h3.blend) : '');

  X.send(P.C2S.STROKE_BEGIN, {
    id: 's_v3_clamp', layerId: lx, tool: 'gradient', color: '#123456', size: 10, opacity: 1,
    grainScale: 99, paper: 'nope', fx: 'bogus'
  });
  X.send(P.C2S.STROKE_POINTS, { id: 's_v3_clamp', pts: [[10, 10, 0.5], [200, 200, 0.5]] });
  X.send(P.C2S.STROKE_END, { id: 's_v3_clamp' });
  await sleep(300);
  const h4 = (Y.got.begin || []).find(s => s.id === 's_v3_clamp');
  ok('gradient 工具被服务端接受', !!h4 && h4.tool === 'gradient', h4 ? h4.tool : 'no begin');
  ok('grainScale 收敛到上限 4 / paper·fx 回落默认',
    !!h4 && Math.abs(h4.grainScale - 4) < 1e-6 && h4.paper === 'none' && h4.fx === 'none',
    h4 ? JSON.stringify({ gs: h4.grainScale, p: h4.paper, fx: h4.fx }) : 'no begin');

  console.log('\n[15.6] v3 · 表情图消息');
  const STICKER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  Y.chat = []; X.chat = [];
  X.send(P.C2S.CHAT, { text: '', img: STICKER });
  await sleep(340);
  const gotImg = (Y.chat || []).find(m => m.img);
  ok('表情图随聊天同步到另一端', !!gotImg && gotImg.img === STICKER, gotImg ? gotImg.img.slice(0, 22) : 'no img');
  X.send(P.C2S.CHAT, { text: '', img: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
  await sleep(340);
  const badImg = (Y.chat || []).filter(m => m.img && m.img.indexOf('text/html') >= 0);
  ok('非图片类型的表情被服务端丢弃', badImg.length === 0 && (Y.chat || []).filter(m => m.img).length === 1);
  X.send(P.C2S.CHAT, { text: '', img: '' });
  await sleep(340);
  ok('空消息（无文字无图）不被广播', (Y.chat || []).filter(m => m.img).length === 1);

  console.log('\n[15.6.1] v3 · 画笔默认值（size / opacity 不再被归一化吞掉）');
  const nb = P.normalizeBrush({ size: 42, opacity: 0.35, hardness: 0.5 });
  ok('normalizeBrush 保留 size / opacity',
    nb.size === 42 && Math.abs(nb.opacity - 0.35) < 1e-6, JSON.stringify({ s: nb.size, o: nb.opacity }));
  const nbDef = P.normalizeBrush({});
  ok('缺省时回落到约定默认值 size=12 / opacity=1',
    nbDef.size === 12 && nbDef.opacity === 1, JSON.stringify({ s: nbDef.size, o: nbDef.opacity }));
  const nbClamp = P.normalizeBrush({ size: 9999, opacity: -3 });
  ok('size / opacity 被收敛到合法区间',
    nbClamp.size === 400 && Math.abs(nbClamp.opacity - 0.02) < 1e-6, JSON.stringify({ s: nbClamp.size, o: nbClamp.opacity }));

  X.send(P.C2S.STROKE_BEGIN, {
    id: 's_v3_size', layerId: lx, tool: 'brush', color: '#222222', size: 42, opacity: 0.35,
    hardness: 0.5, grain: 0.4, grainScale: 1.8, paper: 'fine', fx: 'none'
  });
  X.send(P.C2S.STROKE_POINTS, { id: 's_v3_size', pts: stroke('s_v3_size', lx, '#222222', 10).pts });
  X.send(P.C2S.STROKE_END, { id: 's_v3_size' });
  await sleep(320);
  const h5 = (Y.got.begin || []).find(s => s.id === 's_v3_size');
  ok('笔迹携带的 size / opacity 原样同步到另一端',
    !!h5 && h5.size === 42 && Math.abs(h5.opacity - 0.35) < 1e-6,
    h5 ? JSON.stringify({ s: h5.size, o: h5.opacity }) : 'no begin');
  ok('笔迹携带纸张质感与比例（本地渲染同样需要）',
    !!h5 && h5.paper === 'fine' && Math.abs(h5.grainScale - 1.8) < 1e-6,
    h5 ? JSON.stringify({ p: h5.paper, gs: h5.grainScale }) : 'no begin');

  console.log('\n[16] v2 · 图层混合模式与保护不透明度');
  X.send(P.C2S.LAYER_ADD, { name: '混合层' });
  await sleep(220);
  const mixId = Y.layers[Y.layers.length - 1].id;
  Y.send(P.C2S.LAYER_UPD, { layerId: mixId, patch: { blend: 'multiply', alphaLock: true, opacity: 0.6 } });
  await sleep(240);
  const ml = X.layers.find(l => l.id === mixId);
  ok('混合模式 / 保护不透明度 / 透明度同步', !!ml && ml.blend === 'multiply' && ml.alphaLock === true && Math.abs(ml.opacity - 0.6) < 1e-6,
    ml ? JSON.stringify({ b: ml.blend, a: ml.alphaLock, o: ml.opacity }) : 'no layer');
  Y.send(P.C2S.LAYER_UPD, { layerId: mixId, patch: { blend: 'bogus' } });
  await sleep(220);
  const ml2 = X.layers.find(l => l.id === mixId);
  ok('非法混合模式被忽略（保持 multiply）', !!ml2 && ml2.blend === 'multiply');

  console.log('\n[17] v2 · 图层复制（像素由客户端回传）');
  const cntBefore = X.layers.length;
  X.send(P.C2S.LAYER_DUP, { layerId: mixId, png: PNG1 });
  await sleep(280);
  ok('复制后图层数 +1', X.layers.length === cntBefore + 1, '实际 ' + X.layers.length);
  const dupId = X.layers[X.layers.length - 1].id;
  const dupMl = X.layers.find(l => l.id === dupId);
  ok('副本继承混合模式', !!dupMl && dupMl.blend === 'multiply');
  ok('副本底图像素回传给所有端', !!Y.lastBase && !!Y.lastBase[dupId], Y.lastBase ? Object.keys(Y.lastBase).join(',') : 'no base');

  console.log('\n[18] v2 · 清除图层内容');
  X.send(P.C2S.LAYER_CLEAR, { layerId: dupId });
  await sleep(280);
  const cleared = Y.layers.find(l => l.id === dupId);
  ok('清除后 baseSeq 归零（像素被丢弃）', !!cleared && cleared.baseSeq === 0, cleared ? 'baseSeq=' + cleared.baseSeq : 'no layer');

  console.log('\n[19] v2 · 向下合并');
  const beforeMerge = Y.layers.length;
  X.send(P.C2S.LAYER_MERGE, { srcId: dupId, dstId: mixId, png: PNG1 });
  await sleep(300);
  ok('合并后图层数 -1', Y.layers.length === beforeMerge - 1, '实际 ' + Y.layers.length);
  ok('合并结果写入目标层底图', !!Y.lastBase && !!Y.lastBase[mixId]);
  ok('被合并层已移除', !X.layers.some(l => l.id === dupId));

  console.log('\n[20] v2 · 合并可见（仅房主）');
  Y.send(P.C2S.LAYER_FLATTEN, { png: PNG1, name: '扁平化' });
  await sleep(240);
  ok('非房主合并可见被拒绝', (Y.got.errors || []).some(e => e.code === 'not_owner'));
  X.send(P.C2S.LAYER_FLATTEN, { png: PNG1, name: '扁平化' });
  await sleep(300);
  ok('房主合并可见后仅剩 1 层', X.layers.length === 1, '实际 ' + X.layers.length);
  ok('合并可见层名为「扁平化」', X.layers[0] && X.layers[0].name === '扁平化');

  console.log('\n[21] v2 · 心跳回显');
  const t0 = Date.now();
  X.send(P.C2S.PING, { at: t0 });
  await sleep(220);
  const pong = (X.got.pong || []).pop();
  ok('ping → pong 回显时间戳', !!pong && pong.t0 === t0, pong ? 't0=' + pong.t0 : 'no pong');

  X.send(P.C2S.ROOM_DESTROY, {});
  await sleep(300);
  X.ws.close(); Y.ws.close();
  await sleep(150);

  console.log('\n[22] 公网穿透接口 /api/share');
  const share = await httpJson('/api/share');
  ok('/api/share 可用', !!share && typeof share === 'object', JSON.stringify(share));
  ok('/api/share 带 publicUrl 字段（未开隧道时为空串）',
    !!share && typeof share.publicUrl === 'string',
    share ? JSON.stringify(share.publicUrl) : 'no body');
  ok('publicUrl 是合法 http(s) 地址（或为空）',
    !!share && (share.publicUrl === '' || /^https?:\/\/[^\s/]+$/.test(share.publicUrl)),
    share ? share.publicUrl : '');
  ok('/api/share 带局域网地址列表',
    !!share && Array.isArray(share.lanUrls) &&
      share.lanUrls.every(u => /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(u)),
    share ? JSON.stringify(share.lanUrls) : '');

  console.log('\n════════════════════════════════════════');
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  if (failures.length) {
    console.log('  失败项：');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
