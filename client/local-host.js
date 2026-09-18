/**
 * 茶绘 · 离线宿主（桌面端主进程用）
 *
 * 「关掉服务器」之后还要能画画，靠的就是它：在**同一个进程**里直接用服务端的
 * `onClient()` 挂一个**不走 socket 的客户端**。于是有网 / 没网两种模式共用同一份
 * 房间状态机 —— 离线不需要另写一套，也就不会出现「在线能画、离线某些按钮没反应」
 * 这种两套逻辑慢慢分家的毛病。
 *
 * 为什么不用 127.0.0.1：那**仍然是一个监听端口**（会被防火墙问、同机别的程序也能连），
 * 而用户点「关闭服务器」的意思就是「别开着服务器」。所以这里的客户端不经过任何 socket，
 * 全靠进程内直接调用。
 *
 * 本模块**刻意不依赖 Electron**：它只要求一个「把字符串发回渲染层」的回调，
 * 所以 tools/test-local-host.js 能在纯 Node 里直接跑它（还能起两个会话，
 * 假装两个人），不用起 Electron。
 */
'use strict';

/**
 * 长得像 ws 的最小实现。服务端只用到这些：
 *   readyState / OPEN / send(string) / on('message'|'close'|'error'|'pong')
 * 心跳那套（ping / terminate）用不到，但它**不会被塞进 wss.clients**，
 * 所以心跳循环根本不会碰到它（见 server/src/index.js 里 listen() 的注释）。
 */
class LocalWs {
  constructor(toClient) {
    this.readyState = 1;
    this.OPEN = 1;
    this.CLOSED = 3;
    this._toClient = typeof toClient === 'function' ? toClient : function () {};
    this._handlers = { message: [], close: [], error: [], pong: [] };
    this._connId = null;
    this._roomId = null;
    this._userId = null;
    this._alive = true;
  }
  on(name, fn) {
    (this._handlers[name] || (this._handlers[name] = [])).push(fn);
    return this;
  }
  emit(name, arg) {
    const l = this._handlers[name] || [];
    for (let i = 0; i < l.length; i++) {
      try { l[i](arg); } catch (e) { console.error('[local] ' + name + ' 回调出错：' + e.message); }
    }
  }
  /** 服务端 → 客户端。整个服务端只经这一条路回话 */
  send(raw) {
    if (this.readyState !== 1) return;
    try { this._toClient(String(raw)); } catch (e) { /* 渲染层可能已经关了，丢掉就好 */ }
  }
  /** 客户端 → 服务端（渲染层把收到的字符串原样喂进来） */
  feed(raw) { this.emit('message', raw); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }
  terminate() { this.close(); }
  ping() { /* 离线客户端不参与心跳 */ }
}

/**
 * 起一个离线会话。
 * @param {object} opts
 * @param {(raw:string)=>void} opts.toClient  把服务端的消息交给渲染层
 * @param {object} [opts.server]  注入的服务端模块（不传就 require client/server/index.js）。
 *                                测试用它来保证每个用例拿到的是干净的一份。
 * @returns {{connId:string, feed:(raw:string)=>void, close:()=>void}}
 */
function createSession(opts) {
  opts = opts || {};
  const server = opts.server || require('./server/index.js');
  const ws = new LocalWs(opts.toClient);
  server.onClient(ws);
  return {
    connId: ws._connId,
    feed: (raw) => ws.feed(raw),
    close: () => ws.close(),
    ws: ws
  };
}

module.exports = { createSession: createSession, LocalWs: LocalWs };
