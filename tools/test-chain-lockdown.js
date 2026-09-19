/**
 * 接龙 · 作画阶段的「结构性操作」闸门（**真 WebSocket 层**）
 *
 * ⚠ 和 tools/test-chain-private.js 是**互补**的，别搞混：
 *   test-chain-private.js 守的是「笔迹 / 光标 / 清空 / 历史裁剪」的私密性；
 *   这一份守的是**会动图层结构或画布尺寸的那批消息**。
 *
 * 为什么必须单独守：接龙的作画阶段 lockedFor() 是「环里没交的人一律解锁」，
 * 也就是**所有人同时都能动笔**——writeBlocked() 在这个阶段拦不住任何东西。
 * 而私密作画时大家共用同一块画布（只是互相看不见），于是这些操作会：
 *   · LAYER_PIXELS / LAYER_DUP / LAYER_MERGE / LAYER_FLATTEN / ROOM_COMPRESS
 *     全都带 `baseImages` 广播 —— 整张图层 PNG 发给全场，下一位猜词的人等于直接拿到答案；
 *   · LAYER_CLEAR / ROOM_RESIZE 会把别人正在画的私密内容一起抹掉；
 *   · PROJECT_* 是整份文档替换，局里画的东西全没。
 * 它们在这一步本来也没有正当用法，所以一律拒绝（见 index.js 的 privateDrawLocked / gameBusy）。
 *
 * 最后一条同样重要：**结束游戏之后闸门必须放开** —— 别一局打完就再也改不了画布。
 *
 * 用法: node tools/test-chain-lockdown.js [http://127.0.0.1:8440]
 */
'use strict';
const path = require('path');
const R = f => path.resolve(__dirname, '..', f);
const P = require(R('shared/protocol'));
// 用服务端那份 ws（Node 自带的全局 WebSocket 只有 addEventListener，没有 .on）
const WebSocket = require(R('server/node_modules/ws'));

const BASE = (process.argv[2] || 'http://127.0.0.1:8440').replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- 裸 ws 客户端 */

function Client(nick) {
  const ws = new WebSocket(WS_URL);
  const c = { nick, ws, log: [], room: null, you: null, layers: [] };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) { c.room = m.room; c.you = m.you; c.layers = m.layers || []; }
  });
  ws.on('close', () => { c.closed = true; });
  c.send = (t, payload) => { try { ws.send(JSON.stringify(Object.assign({ t }, payload || {}))); } catch (e) { /* ignore */ } };
  /** 记游标：mark() 之后只看新来的消息 */
  c.mark = () => { const n = c.log.length; return () => c.log.slice(n); };
  c.phase = () => {
    const st = c.log.filter(m => m.t === P.S2C.GAME_STATE).pop();
    return st && st.game ? st.game.phase : null;
  };
  c.waitFor = async (pred, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) { if (pred(c)) return true; await sleep(40); }
    return false;
  };
  return c;
}

function connect(nick) {
  return new Promise((resolve, reject) => {
    const c = Client(nick);
    c.ws.on('open', () => resolve(c));
    c.ws.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 8000);
  });
}

/** 新来的消息里有没有「带图层像素」的广播 —— 这就是泄漏的判据 */
const pixelLeaks = (msgs) => msgs.filter(m =>
  m.t === P.S2C.LAYERS && m.baseImages && Object.keys(m.baseImages).length);

(async () => {
  console.log('接龙作画阶段的结构性操作闸门 @ ' + WS_URL);

  /* ---------------- 建房 + 4 人入座（接龙最少 4 人） ---------------- */
  const host = await connect('甲');
  host.send(P.C2S.HELLO, { name: '甲' });
  await sleep(200);
  host.send(P.C2S.ROOM_CREATE, { name: '闸门回归', width: 1600, height: 1000, background: '#ffffff' });
  if (!await host.waitFor(c => c.room, 6000)) { console.error('建房失败'); process.exit(2); }
  const roomId = host.room.id;
  console.log('  房间 ' + roomId);

  const others = [];
  for (const n of ['乙', '丙', '丁']) {
    const c = await connect(n);
    c.send(P.C2S.HELLO, { name: n });
    await sleep(120);
    c.send(P.C2S.ROOM_JOIN, { roomId, user: { name: n } });
    if (!await c.waitFor(x => x.room, 6000)) { console.error(n + ' 进房失败'); process.exit(2); }
    others.push(c);
  }
  const all = [host, ...others];
  await sleep(500);

  /* ---------------- 推进到「作画」这一步 ---------------- */
  console.log('\n[0] 推进到作画阶段');
  host.send(P.C2S.GAME_START, { mode: 'chain', chainLength: 4, theme: 'default' });
  await sleep(400);
  ok('开局后进大厅', host.phase() === 'lobby', host.phase());
  const st0 = host.log.filter(m => m.t === P.S2C.GAME_STATE).pop();
  ok('GAME_STATE 里回显 chainLength = 4（① 开局参数透传到游戏里）',
    st0 && st0.game && st0.game.chainLength === 4, st0 && st0.game ? st0.game.chainLength : null);

  all.forEach(c => c.send(P.C2S.GAME_READY, { ready: true }));
  ok('全员准备后自动开局', await host.waitFor(c => c.phase() === 'chain_init' || c.phase() === 'chain_write', 6000), host.phase());
  ok('开场鼓点结束后进入写词', await host.waitFor(c => c.phase() === 'chain_write', 12000), host.phase());
  all.forEach((c, i) => c.send(P.C2S.GAME_SUBMIT, { text: '测试词' + (i + 1) }));
  if (!await host.waitFor(c => c.phase() === 'chain_draw', 8000)) {
    ok('全员写完词后进入作画', false, host.phase());
    console.log('\n后续用例依赖作画阶段，提前退出');
    process.exit(1);
  }
  ok('全员写完词后进入作画', true, host.phase());
  await sleep(400);

  const layerId = host.layers[host.layers.length - 1].id;

  /* ---------------- 闸门：作画这一步一律拒绝 ---------------- */
  console.log('\n[1] 作画这一步：会泄漏像素 / 会抹掉别人的结构性操作一律被拒');
  const risky = [
    ['LAYER_PIXELS', P.C2S.LAYER_PIXELS, { layerId, png: 'data:image/png;base64,iVBORw0KGgo=', upToSeq: 1 }],
    ['LAYER_CLEAR', P.C2S.LAYER_CLEAR, { layerId }],
    ['LAYER_DUP', P.C2S.LAYER_DUP, { layerId }],
    ['LAYER_MERGE', P.C2S.LAYER_MERGE, { srcId: layerId, dstId: layerId }],
    ['LAYER_FLATTEN', P.C2S.LAYER_FLATTEN, { name: '合并' }],
    ['ROOM_COMPRESS', P.C2S.ROOM_COMPRESS, { pngs: {}, upToSeq: 1 }],
    ['ROOM_RESIZE', P.C2S.ROOM_RESIZE, { width: 900, height: 700 }]
  ];
  for (const [label, t, payload] of risky) {
    const mk = all.map(c => c.mark());
    host.send(t, payload);
    await sleep(350);
    const after = mk.map(fn => fn());
    const err = after[0].find(m => m.t === P.S2C.ERROR);
    ok(label + ' 被拒（房主也拦）', !!(err && err.code === 'game_private'),
      err ? err.code : '没有报错');
    ok('★ ' + label + ' 没有把图层像素广播出去',
      after.slice(1).every(msgs => pixelLeaks(msgs).length === 0),
      after.slice(1).map(msgs => pixelLeaks(msgs).length).join(','));
  }

  {
    const mk = others[1].mark();
    others[1].send(P.C2S.LAYER_PIXELS, { layerId, png: 'data:image/png;base64,iVBORw0KGgo=', upToSeq: 1 });
    await sleep(350);
    const err = mk().find(m => m.t === P.S2C.ERROR);
    ok('非房主收到的是「作画这一步不能改」，而不是那句误导的「该图层上有别人的成果」',
      !!(err && err.code === 'game_private'), err ? err.code : '没有报错');
  }

  console.log('\n[2] 游戏进行中不能装载工程（整份文档替换）');
  {
    const mk = host.mark();
    host.send(P.C2S.PROJECT_BEGIN, { count: 1 });
    await sleep(350);
    const err = mk().find(m => m.t === P.S2C.ERROR);
    ok('PROJECT_BEGIN 被拒', !!(err && err.code === 'game_busy'), err ? err.code : '没有报错');
    const mk2 = host.mark();
    host.send(P.C2S.PROJECT_LAYER, { index: 0, name: '偷换', png: 'data:image/png;base64,iVBORw0KGgo=' });
    await sleep(300);
    ok('PROJECT_LAYER 被拒（连 owner 也不行）',
      !!mk2().find(m => m.t === P.S2C.ERROR && m.code === 'game_busy'));
    const mk3 = host.mark();
    host.send(P.C2S.PROJECT_END, {});
    await sleep(300);
    ok('PROJECT_END 被拒', !!mk3().find(m => m.t === P.S2C.ERROR && m.code === 'game_busy'));
  }

  /* ---------------- 闸门要能放开 ---------------- */
  console.log('\n[3] 结束游戏之后闸门必须放开（别一局打完就改不了画布）');
  host.send(P.C2S.GAME_STOP, {});
  await sleep(700);
  ok('游戏已结束（phase=off）', host.phase() === 'off' || host.phase() === null, host.phase());

  {
    const mk = all.map(c => c.mark());
    host.send(P.C2S.ROOM_RESIZE, { width: 900, height: 700 });
    // c.room 是 ROOM_JOINED 那一刻的快照，不会自己更新 —— 要看 ROOM_RESIZED
    const got = await host.waitFor(c => c.log.some(m => m.t === P.S2C.ROOM_RESIZED && m.width === 900), 5000);
    const err = mk[0]().find(m => m.t === P.S2C.ERROR);
    ok('ROOM_RESIZE 能生效', got, got ? '' : (err ? err.code : '超时'));
    ok('其他人也收到尺寸变更', mk.slice(1).some(fn => fn().some(m => m.t === P.S2C.ROOM_RESIZED)));
  }
  {
    const mk = all.map(c => c.mark());
    host.send(P.C2S.LAYER_CLEAR, { layerId: host.layers[0].id });
    await sleep(500);
    ok('LAYER_CLEAR 能生效', !mk[0]().find(m => m.t === P.S2C.ERROR),
      mk[0]().find(m => m.t === P.S2C.ERROR) ? mk[0]().find(m => m.t === P.S2C.ERROR).code : '');
  }
  {
    // ⚠ 这条守的是 gameBusy 的写法：结束游戏之后 room.game 这个对象**还在**，
    // 只是 phase 变回了 'off'。只看「有没有 game」的话，闸门就永远关死了。
    const mk = host.mark();
    host.send(P.C2S.PROJECT_BEGIN, { count: 1 });
    await sleep(350);
    const err = mk().find(m => m.t === P.S2C.ERROR && m.code === 'game_busy');
    ok('PROJECT_BEGIN 不再被 game_busy 拒（room.game 还在但 phase=off 不算进行中）', !err,
      err ? err.code : '');
  }

  all.forEach(c => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  await sleep(200);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
