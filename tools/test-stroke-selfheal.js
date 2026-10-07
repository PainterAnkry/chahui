/**
 * 茶绘 · 「上一笔没收到 END」自愈验收（纯 Node，自带服务端）
 *
 * 背景（iPad 用户反馈「约四笔吞一笔」）：服务端 STROKE_BEGIN 里旧逻辑是
 * `if (ws._activeStroke) return;` —— 只要有一笔没等到 END（断线重连、iPad 上
 * 系统抢走指针触发 pointercancel），_activeStroke 就卡死在旧笔上，之后每一笔的
 * BEGIN 都被忽略、POINTS 因 id 不匹配被丢弃，用户看到的就是连续吞笔。
 *
 * 修复后 STROKE_BEGIN 要「自动替上一笔收尾」：有点 → 隐式 END 提交，没点 → CANCEL。
 *
 * 覆盖：
 *   ① 笔画 A（有点，无 END）后直接 BEGIN 笔画 B → A 被隐式提交（双方都收到
 *      stroke:end[sA]），B 正常开始、正常收尾 —— **没有吞笔**
 *   ② 笔画 C（无点，无 END）后直接 BEGIN 笔画 D → C 被广播 stroke:cancel，D 正常
 *   ③ 正常流程回归：BEGIN → POINTS → END 的广播与回显一次不多一次不少
 *   ④ 服务端连接始终存活（自愈过程不误杀连接）
 *
 * 用法: node tools/test-stroke-selfheal.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws'));
const PORT = 8476;
const TMP = path.join(ROOT, '.tmp-rooms-selfheal');
const LOG = path.join(os.tmpdir(), 'chahui-selfheal.log');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 一个带收件箱的 WS 客户端 */
function client(name) {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  const c = { name, ws, inbox: [], closed: false, waiters: [] };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    for (let i = c.waiters.length - 1; i >= 0; i--) {
      const w = c.waiters[i];
      if (w.type && m.t !== w.type) continue;
      if (w.match && !w.match(m)) continue;
      c.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
      return;
    }
    c.inbox.push(m);
  });
  ws.on('close', () => { c.closed = true; });
  ws.on('error', () => { /* close 会跟着来 */ });
  c.wait = (type, match, ms) => new Promise((resolve) => {
    const w = { type, match, resolve, timer: null };
    w.timer = setTimeout(() => {
      const i = c.waiters.indexOf(w);
      if (i >= 0) c.waiters.splice(i, 1);
      resolve(null);
    }, ms || 3000);
    c.waiters.push(w);
  });
  c.send = (obj) => ws.send(JSON.stringify(obj));
  c.open = new Promise(r => ws.on('open', r));
  return c;
}

function req(port, pathName) {
  return new Promise((resolve) => {
    const r = require('http').request({ host: '127.0.0.1', port, path: pathName, timeout: 5000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    r.on('error', () => resolve({ status: 0 }));
    r.end();
  });
}

(async () => {
  console.log('\n【零】起一台自己的服务端（临时存档目录，不碰真存档）');
  fs.mkdirSync(TMP, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TMP }),
    stdio: ['ignore', log, log]
  });
  let up = false;
  for (let t0 = Date.now(); Date.now() - t0 < 20000;) {
    if ((await req(PORT, '/health')).status === 200) { up = true; break; }
    await sleep(200);
  }
  ok('服务端起来了（日志看 ' + LOG + '）', up);
  if (!up) { try { child.kill(); } catch (e) { /* */ } process.exit(1); }

  try {
    const A = client('画手A'); const B = client('看客B');
    await Promise.all([A.open, B.open]);

    /* ------------------------------------------------ 建房 / 进房 */
    A.send({ t: 'room:create', name: '自愈验收房', width: 1600, height: 1000 });
    const joinedA = await A.wait('room:joined');
    ok('A 建房并进房', !!joinedA && !!joinedA.layers && joinedA.layers.length > 0);
    const layerId = joinedA && joinedA.layers[0].id;
    const roomId = joinedA && joinedA.room && joinedA.room.id;
    B.send({ t: 'room:join', roomId: roomId, user: '看客B' });
    const joinedB = await B.wait('room:joined');
    ok('B 进房', !!joinedB);

    const strokeBeginMsg = (id) => ({ t: 'stroke:begin', id: id, layerId: layerId, tool: 'brush', color: '#2244cc', size: 8, opacity: 1 });
    const strokePoints = (id, pts) => ({ t: 'stroke:points', id: id, pts: pts });

    /* ------------------------------------------------ ① 隐式提交 */
    console.log('\n【一】A（有点，无 END）→ 直接 BEGIN B：A 应被隐式提交，B 正常开始');
    A.send(strokeBeginMsg('sA'));
    A.send(strokePoints('sA', [[100, 100, 0.5], [140, 120, 0.6]]));
    await sleep(150);
    A.send(strokeBeginMsg('sB'));
    const endA_onB = await B.wait('stroke:end', (m) => m.id === 'sA');
    const endA_onA = await A.wait('stroke:end', (m) => m.id === 'sA');
    ok('B 收到 sA 的 stroke:end（隐式提交并广播）', !!endA_onB && typeof endA_onB.seq === 'number', endA_onB);
    ok('A 收到自己的 sA stroke:end（服务端代为收尾）', !!endA_onA, endA_onA);
    const beginB_onB = await B.wait('stroke:begin', (m) => m.stroke && m.stroke.id === 'sB');
    ok('B 收到 sB 的 stroke:begin（新一笔没有被吞）', !!beginB_onB);
    A.send(strokePoints('sB', [[300, 300, 0.5], [360, 340, 0.7]]));
    A.send({ t: 'stroke:end', id: 'sB' });
    const endB_onB = await B.wait('stroke:end', (m) => m.id === 'sB');
    ok('B 收到 sB 的 stroke:end（正常收尾）', !!endB_onB && !!endB_onB.seq);

    /* ------------------------------------------------ ② 隐式取消 */
    console.log('\n【二】A（无点，无 END）→ 直接 BEGIN D：C 应被广播取消，D 正常');
    A.send(strokeBeginMsg('sC'));
    await sleep(120);
    A.send(strokeBeginMsg('sD'));
    const cancelC = await B.wait('stroke:cancel', (m) => m.id === 'sC');
    ok('B 收到 sC 的 stroke:cancel（空笔不进历史）', !!cancelC, cancelC);
    const beginD = await B.wait('stroke:begin', (m) => m.stroke && m.stroke.id === 'sD');
    ok('B 收到 sD 的 stroke:begin', !!beginD);
    A.send(strokePoints('sD', [[700, 500, 0.5]]));
    A.send({ t: 'stroke:end', id: 'sD' });
    ok('B 收到 sD 的 stroke:end', !!(await B.wait('stroke:end', (m) => m.id === 'sD')));

    /* ------------------------------------------------ ③ 正常流程回归 */
    console.log('\n【三】正常流程：BEGIN → POINTS → END，广播各一次、不多不少');
    B.inbox.length = 0;
    A.send(strokeBeginMsg('sE'));
    A.send(strokePoints('sE', [[500, 500, 0.5]]));
    A.send({ t: 'stroke:end', id: 'sE' });
    await sleep(250);
    const begins = B.inbox.filter(m => m.t === 'stroke:begin' && m.stroke.id === 'sE');
    const ends = B.inbox.filter(m => m.t === 'stroke:end' && m.id === 'sE');
    ok('B 对 sE 只收到一次 stroke:begin', begins.length === 1, begins.length);
    ok('B 对 sE 只收到一次 stroke:end', ends.length === 1, ends.length);
    ok('A 没收到 sE 的 stroke:begin（只广播给别人）', !A.inbox.some(m => m.t === 'stroke:begin' && m.stroke && m.stroke.id === 'sE'));

    /* ------------------------------------------------ ④ 连接存活 */
    console.log('\n【四】自愈过程不误杀连接');
    A.send({ t: 'room:create', name: '还活着', width: 800, height: 600 });
    const alive = await A.wait('room:joined', null, 3000);
    ok('A 的连接还能正常发消息 / 收响应', !!alive);
    ok('A、B 的 socket 都没有被关掉', !A.closed && !B.closed);

  } finally {
    try { child.kill(); } catch (e) { /* */ }
  }
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
