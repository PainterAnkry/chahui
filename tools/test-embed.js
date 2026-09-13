/**
 * 验证「桌面端内置服务器」这条路真的能跑通：
 *   1) 能起来（用的是 client/server 里那份同步过来的服务端代码）
 *   2) 能托管网页版（局域网朋友用浏览器打开就能加入）
 *   3) WebSocket 能连上、能建房、能收到房间列表
 *   4) 端口被占用时走「复用已存在的服务端」而不是崩掉
 *
 * 用法: node tools/test-embed.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require(path.resolve(__dirname, '..', 'client', 'node_modules', 'ws'));

const embed = require(path.resolve(__dirname, '..', 'client', 'server-embed.js'));
const PORT = Number(process.env.PORT || 8439);
const TMP = path.join(os.tmpdir(), 'chahui-embed-test-' + Date.now());

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

(async () => {
  console.log('=== 内置服务器（端口 ' + PORT + '） ===');
  fs.mkdirSync(TMP, { recursive: true });

  const info = await embed.start({
    port: PORT,
    dataDir: path.join(TMP, 'rooms'),
    publicDir: path.resolve(__dirname, '..', 'client', 'renderer')
  });
  console.log('  start() ->', JSON.stringify({ port: info.port, reused: info.reused, lan: info.lan }));
  check('内置服务器已启动（不是复用）', info.reused === false, String(info.reused));
  check('检测到了局域网地址', info.lan.length > 0, info.lan.join(', ') || '（这台机器没有可用的内网 IP）');

  // 1) HTTP 静态托管
  const idx = await get('http://127.0.0.1:' + PORT + '/');
  check('网页版能打开（HTTP 200）', idx.status === 200, 'HTTP ' + idx.status + '，' + idx.body.length + ' 字节');
  check('返回的是茶绘页面', /茶绘/.test(idx.body) && /<canvas id="view"/.test(idx.body));
  const js = await get('http://127.0.0.1:' + PORT + '/app.js');
  check('静态资源能取到（app.js）', js.status === 200 && js.body.length > 10000, 'HTTP ' + js.status + '，' + js.body.length + ' 字节');

  // 2) WebSocket 协议
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  const got = [];
  ws.on('message', raw => { try { got.push(JSON.parse(raw)); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  check('WebSocket 能连上 /ws', true);

  // 协议信封用的是 t（不是 type）
  ws.send(JSON.stringify({ t: 'hello', name: '内置测试' }));
  await sleep(300);
  ws.send(JSON.stringify({ t: 'room:create', name: '内置服务器测试房', user: '内置测试', width: 1280, height: 800, background: '#ffffff' }));
  await sleep(700);
  const joined = got.find(m => m.t === 'room:joined');
  check('能建房并进入房间', !!joined, joined ? joined.room.id + '（' + joined.room.width + '×' + joined.room.height + '）' : '没收到 room:joined');

  ws.send(JSON.stringify({ t: 'room:list' }));
  await sleep(400);
  const list = got.filter(m => m.t === 'room:list').pop();
  check('能拉取房间列表', !!list && Array.isArray(list.rooms) && list.rooms.length >= 1,
    list ? list.rooms.length + ' 个房间' : '没收到 room:list');

  // 3) 房间被写到了指定的数据目录（落盘有 1.5s 防抖，要等一下）
  await sleep(2000);
  const roomDirs = fs.existsSync(path.join(TMP, 'rooms'))
    ? fs.readdirSync(path.join(TMP, 'rooms')).filter(n => fs.existsSync(path.join(TMP, 'rooms', n, 'room.json')))
    : [];
  check('房间存在指定的数据目录里（不是程序目录）', roomDirs.length >= 1, roomDirs.join(', ') || '（还没落盘）');

  ws.close();
  await sleep(300);

  // 4) 端口占用 → 复用
  const again = await embed.start({ port: PORT, dataDir: path.join(TMP, 'rooms2'), publicDir: path.resolve(__dirname, '..', 'client', 'renderer') });
  check('端口已被占用时复用而不是崩掉', again.reused === true, JSON.stringify(again));

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
