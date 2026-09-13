/**
 * 桌面端的内置服务器。
 *
 * 目的：双击 exe 就能自己开一间房 —— 不用另外装 Node、也不用单独起服务端。
 * 做法：Electron 主进程本身就是 Node，直接把 server 的代码 require 进来跑。
 *
 * 端口被占用时不去抢：认为「已经有一个服务端在跑」，直接用它。
 * 这样「先开了独立服务端，又开桌面端」不会互相打架。
 */
'use strict';

const net = require('net');
const os = require('os');

/** 端口上已经有人监听了吗 */
function portInUse(port, host, timeout) {
  return new Promise(function (resolve) {
    const sock = net.connect({ port: port, host: host || '127.0.0.1' });
    let done = false;
    function finish(v) { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } }
    sock.setTimeout(timeout || 600);
    sock.on('connect', function () { finish(true); });
    sock.on('timeout', function () { finish(false); });
    sock.on('error', function () { finish(false); });
  });
}

/** 本机所有可用的局域网 IPv4 地址（排除虚拟网卡常用的 169.254 / 回环） */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (n.address.startsWith('169.254.')) continue;
      out.push(n.address);
    }
  }
  // 192.168 / 10. 开头的更像真正的局域网地址，排前面
  out.sort(function (a, b) {
    const score = function (ip) {
      if (ip.startsWith('192.168.')) return 0;
      if (ip.startsWith('10.')) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
  return out;
}

function waitForListen(port) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    (function tick() {
      portInUse(port, '127.0.0.1', 400).then(function (up) {
        if (up || Date.now() - t0 > 6000) resolve(up);
        else setTimeout(tick, 120);
      });
    })();
  });
}

/**
 * 起内置服务器（或复用已在跑的那个）。
 * @returns {Promise<{port:number, reused:boolean, lan:string[], origin:string}>}
 */
async function start(opts) {
  opts = opts || {};
  const port = Number(opts.port) || 8437;

  if (await portInUse(port, '127.0.0.1', 500)) {
    return { port: port, reused: true, lan: lanAddresses(), origin: 'http://localhost:' + port };
  }

  // server/src/index.js 全部配置都从 process.env 读，所以这里设好环境变量再 require 就行，
  // 不需要为了「可嵌入」去重构那个文件。
  process.env.PORT = String(port);
  process.env.HOST = '0.0.0.0';
  process.env.CHAHU_EMBEDDED = '1';
  if (opts.dataDir) process.env.DATA_DIR = opts.dataDir;
  if (opts.publicDir) process.env.PUBLIC_DIR = opts.publicDir;

  require('./server/index.js');

  const up = await waitForListen(port);
  return { port: port, reused: !up, lan: lanAddresses(), origin: 'http://localhost:' + port };
}

module.exports = { start: start, lanAddresses: lanAddresses, portInUse: portInUse };
