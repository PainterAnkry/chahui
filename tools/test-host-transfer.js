/**
 * 房主转让回归 —— 房主把身份主动转给房间里另一个人（v2.0.3 新增）。
 *
 * 与退房时的自动移交（transferOwnerIfNeeded）共用 room.ownerId 状态位，
 * 所以本测试重点在协议语义与权限边界：
 *   1. 基线：A 建房是房主，B/C 进房是普通成员
 *   2. 只有房主能转让（A 转完后以 B 的视角再试一次 —— 普通成员发这条必须被拒）
 *   3. 转给自己 / 转给不在房里的人 → 明确报错
 *   4. 正常转让：MEMBERS 广播里 isOwner 正确换位，系统消息提示
 *   5. 新房主真的有房主权：能设 / 取消观众
 *   6. 转回来 + 房主退房自动移交仍然正常（别把老逻辑改坏）
 *
 * 用法: node tools/test-host-transfer.js [http://127.0.0.1:8440]
 */
'use strict';
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'ws'));
const P = require(path.resolve(__dirname, '..', 'shared', 'protocol'));

const URL_ = (function () {
  const a = process.argv[2] || 'http://127.0.0.1:8440';
  const u = new URL(a);
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  if (!/\/ws$/.test(u.pathname)) u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws';
  return u.toString();
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? ' → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 5000)) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(40);
  }
  if (label) console.log('    （超时：' + label + '）');
  return false;
}

function Client(name) {
  const ws = new WebSocket(URL_);
  const c = { name, ws, log: [], room: null, you: null, uid: null, open: false };
  ws.on('open', () => { c.open = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    c.log.push(m);
    if (m.t === P.S2C.ROOM_JOINED) { c.room = m.room; c.you = m.you; c.uid = m.you && m.you.userId; }
    if (m.t === P.S2C.MEMBERS) c.members = m.members;
  });
  c.send = (t, p) => { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ t }, p || {}))); };
  c.msgs = (t) => c.log.filter(m => m.t === t);
  c.last = (t) => c.msgs(t).pop();
  /** 最近一次 MEMBERS 里「我」的 isOwner */
  c.iAmOwner = () => {
    if (!c.members || !c.uid) return null;
    const row = c.members.find(m => m.userId === c.uid);
    return row ? !!row.isOwner : null;
  };
  /** 最近一次系统消息里匹配正则的文本 */
  c.sysMsg = (re) => {
    for (let i = c.log.length - 1; i >= 0; i--) {
      const m = c.log[i];
      if (m.t === P.S2C.CHAT && m.system && re.test(m.text || '')) return m.text;
    }
    return '';
  };
  c.close = () => ws.close();
  return c;
}

(async () => {
  const roomId = 'htrans_' + Date.now().toString(36).slice(-6);
  console.log('房主转让 · 验收  目标 ' + URL_ + '  房间 ' + roomId + '\n');

  const A = Client('房主甲');
  const B = Client('乙方');
  const C = Client('丙丁');
  await waitFor(() => A.open && B.open && C.open, 5000, '连接');

  /* [1] 建房与进房 */
  console.log('[1] 建房与进房');
  A.send(P.C2S.ROOM_CREATE, { id: roomId, name: '转让验收', user: '房主甲' });
  ok('A 建好房间且是房主', await waitFor(() => A.room && A.room.id === roomId && A.you && A.you.isOwner, 4000, 'A JOIN'));
  B.send(P.C2S.ROOM_JOIN, { roomId, user: '乙方' });
  ok('B 进房（普通成员）', await waitFor(() => B.room && B.room.id === roomId && B.you && !B.you.isOwner, 4000, 'B JOIN'));
  C.send(P.C2S.ROOM_JOIN, { roomId, user: '丙丁' });
  ok('C 进房（普通成员）', await waitFor(() => C.room && C.room.id === roomId && C.you && !C.you.isOwner, 4000, 'C JOIN'));

  /* [2] 权限边界 */
  console.log('\n[2] 权限边界');
  B.send(P.C2S.HOST_TRANSFER, { userId: C.uid });
  await sleep(300);
  const bErr = B.last(P.S2C.ERROR);
  ok('普通成员转让被拒', bErr && bErr.code === 'not_owner', JSON.stringify(bErr));
  A.send(P.C2S.HOST_TRANSFER, { userId: A.uid });
  await sleep(300);
  const selfErr = A.last(P.S2C.ERROR);
  ok('转给自己被拒', selfErr && selfErr.code === 'bad_target', JSON.stringify(selfErr));
  A.send(P.C2S.HOST_TRANSFER, { userId: 'ghost_user_404' });
  await sleep(300);
  const ghostErr = A.last(P.S2C.ERROR);
  ok('转给不在房里的人被拒', ghostErr && ghostErr.code === 'no_member', JSON.stringify(ghostErr));

  /* [3] 正常转让 A → B */
  console.log('\n[3] 转让 A → B');
  A.send(P.C2S.HOST_TRANSFER, { userId: B.uid });
  ok('双方 isOwner 换位', await waitFor(() => A.iAmOwner() === false && B.iAmOwner() === true, 4000, 'isOwner'));
  ok('C 也看到新房主是 B', await waitFor(() => {
    if (!C.members) return false;
    const row = C.members.find(m => m.userId === B.uid);
    return !!row && !!row.isOwner;
  }, 4000, 'C 视角'));
  ok('系统消息播报了转让', /乙.*房主|转给.*乙/.test(A.sysMsg(/乙/)), A.sysMsg(/乙/));

  /* [4] 新房主真的有房主权 */
  console.log('\n[4] 新房主 B 行使房主权');
  B.send(P.C2S.MEMBER_ROLE, { userId: C.uid, readonly: true });
  ok('B 能把 C 设成观众', await waitFor(() => {
    const row = C.members && C.members.find(m => m.userId === C.uid);
    return !!row && !!row.readonly;
  }, 4000, 'C readonly'));
  B.send(P.C2S.MEMBER_ROLE, { userId: C.uid, readonly: false });
  ok('B 能取消观众', await waitFor(() => {
    const row = C.members && C.members.find(m => m.userId === C.uid);
    return !!row && !row.readonly;
  }, 4000, 'C writable'));
  A.send(P.C2S.MEMBER_ROLE, { userId: C.uid, readonly: true });
  await sleep(300);
  const aRoleErr = A.last(P.S2C.ERROR);
  ok('原房主 A 已无房主权（设观众被拒）', aRoleErr && aRoleErr.code === 'not_owner', JSON.stringify(aRoleErr));

  /* [5] 转回来 + 退房自动移交 */
  console.log('\n[5] 转回来与自动移交');
  B.send(P.C2S.HOST_TRANSFER, { userId: A.uid });
  ok('B 转回给 A', await waitFor(() => A.iAmOwner() === true && B.iAmOwner() === false, 4000, '转回'));
  B.close();
  await sleep(500);
  ok('B 退房不触发移交（房主还在）', A.iAmOwner() === true);
  A.close();
  // 房主 A 退了：自动移交给最早进来的 B —— 但 B 也退了，所以应该轮到 C
  ok('房主与 B 都退了，C 接管', await waitFor(() => C.iAmOwner() === true, 4000, 'C 接管'), 'C.iAmOwner=' + C.iAmOwner());

  A.close(); B.close(); C.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
