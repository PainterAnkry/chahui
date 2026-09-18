/**
 * 茶绘 · 网络层
 * WebSocket 封装：自动重连、发送队列、心跳、断线状态上报
 *
 * **两条通道，同一套消息**：
 *   · `ws://…`  —— 正常的 WebSocket（网页版、连别人的服务器、连公网）
 *   · `local://` —— 桌面端的「离线模式」：主进程里挂一个不走 socket 的客户端，
 *                  消息还是这些消息，只是不经过网络（见 client/local-host.js）
 *
 * 两条通道共用同一个收包出口 `_recv()`，所以「离线时某些消息没处理」这种
 * 只在真机上才发现的毛病，从结构上就不会出现。
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;
  var LOCAL_URL = 'local://';

  function isLocalUrl(u) { return /^local:\/\//i.test(String(u || '')); }

  function Net() {
    this.ws = null;
    this.url = '';
    this.handlers = {};
    this.queue = [];
    this.status = 'idle'; // idle | connecting | online | offline
    this.retry = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.manualClose = false;
    this.lastPong = 0;
    this.latency = 0;
    this.selfId = null;
    // 本机通道（离线模式）
    this.local = false;
    this.localReady = false;
    this._localOff = null;
  }

  Net.prototype.on = function (name, fn) {
    (this.handlers[name] || (this.handlers[name] = [])).push(fn);
    return this;
  };

  Net.prototype.emit = function (name, payload) {
    var l = this.handlers[name];
    if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](payload); } catch (e) { console.error(e); } }
  };

  Net.prototype.setStatus = function (s, extra) {
    if (this.status === s && !extra) return;
    this.status = s;
    this.emit('status', Object.assign({ status: s, latency: this.latency }, extra || {}));
  };

  /** 收包的**唯一出口**：WebSocket 与本机通道都从这里进 */
  Net.prototype._recv = function (data) {
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || !msg.t) return;
    if (msg.t === P.S2C.PONG) {
      this.latency = Math.max(0, Date.now() - (msg.t0 || Date.now()));
      this.setStatus('online');
      return;
    }
    if (msg.t === P.S2C.HELLO_OK) { this.selfId = msg.connId; this.limits = msg.limits || {}; }
    this.emit('message', msg);
    this.emit(msg.t, msg);
  };

  Net.prototype.connect = function (url) {
    if (url) this.url = url;
    if (!this.url) return;
    if (isLocalUrl(this.url)) return this.connectLocal();
    var wasLocal = this.local;
    this.local = false;
    this.localReady = false;
    if (this._localOff) { try { this._localOff(); } catch (e) { /* ignore */ } this._localOff = null; }
    // 离开本机通道时把主进程那份会话也收掉。只摘监听不够 —— 会话还留在
    // 本地房间里当一个「幽灵客户端」，既占着房间又让成员列表多出一个空位。
    if (wasLocal) {
      var DL = global.chahuDesktop;
      if (DL && DL.localClose) { try { DL.localClose(); } catch (e) { /* ignore */ } }
    }
    this.connectWs();
  };

  /* ---------------------------------------------------------------- 本机通道 */

  /**
   * 离线模式：消息交给主进程里那份服务端，回包直接推回来。
   * 不占端口、不出网，所以「关掉服务器」之后还能接着画同一间房。
   */
  Net.prototype.connectLocal = function () {
    var self = this;
    var D = global.chahuDesktop;
    if (!D || !D.localOpen) {
      this.setStatus('offline', { message: '离线模式只有桌面端有；网页版必须连服务器' });
      return;
    }
    // 从 ws 切过来时，旧 socket **必须在这里关掉**：connect() 走本机通道这条岔路时
    // 不会碰 ws，留着它那条连接就还挂在服务端的房间里 —— 你这边已经在走本机通道了，
    // 两边各算一个人，等于自己占两个座位（成员列表多一个、房间退不掉）。
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    this.manualClose = false;
    this.local = true;
    this.localReady = false;
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');

    // 回包只登一次监听。切来切去（在线 ↔ 离线）时不能重复登，否则一条消息会被处理好几遍
    if (!this._localOff && D.onLocalMessage) {
      this._localOff = D.onLocalMessage(function (raw) { self._recv(raw); });
    }

    D.localOpen().then(function (r) {
      if (self.manualClose || !self.local) return;
      if (!r || !r.ok) {
        self.setStatus('offline', { message: (r && r.error) || '离线模式没起来' });
        return;
      }
      self.localReady = true;
      self.retry = 0;
      self.lastPong = Date.now();
      self.setStatus('online');
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send(P.C2S.PING, { at: Date.now() }); }, 20000);
      self.flush();
      self.emit('open', { local: true });
    }).catch(function (e) {
      self.setStatus('offline', { message: '离线模式没起来：' + (e && e.message) });
    });
  };

  /* ------------------------------------------------------------ WebSocket 通道 */

  Net.prototype.connectWs = function () {
    var self = this;
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');

    var ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this.setStatus('offline', { message: '地址无效：' + this.url });
      return this.scheduleRetry();
    }
    this.ws = ws;

    ws.onopen = function () {
      if (self.ws !== ws) return;   // 已经被换掉了（换通道 / 重连），别把状态改回来
      self.retry = 0;
      self.lastPong = Date.now();
      self.setStatus('online');
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send(P.C2S.PING, { at: Date.now() }); }, 20000);
      self.flush();
      self.emit('open', {});
    };

    ws.onmessage = function (ev) {
      if (self.ws !== ws) return;
      self._recv(ev.data);
    };

    ws.onerror = function () {
      if (self.ws !== ws) return;
      self.emit('neterror', { url: self.url });
    };

    ws.onclose = function (ev) {
      // **这条 socket 还是「当前那条」吗？**
      // 换通道（在线 ↔ 离线）时我们会先 close() 掉旧的再建新的，而 close 事件是
      // 下一个 tick 才派发的 —— 那时候 manualClose 早被新通道重置成 false 了。
      // 不认 socket 只看 manualClose，旧连接的收尾就会把状态改回「已断开」并排一个重试，
      // 于是刚切到离线模式、状态栏却写着「连接中断，1s 后重试…」。
      if (self.ws !== ws) return;
      clearInterval(self.pingTimer);
      self.ws = null;
      self.emit('close', ev);
      if (self.manualClose) { self.setStatus('idle'); return; }
      self.setStatus('offline', { message: '与服务器的连接已断开' });
      self.scheduleRetry();
    };
  };

  Net.prototype.scheduleRetry = function () {
    var self = this;
    if (this.manualClose) return;
    clearTimeout(this.retryTimer);
    this.retry += 1;
    var delay = Math.min(15000, 700 * Math.pow(1.6, Math.min(this.retry, 8)));
    this.emit('retry', { attempt: this.retry, delay: delay });
    this.retryTimer = setTimeout(function () { self.connect(); }, delay);
  };

  Net.prototype.close = function () {
    this.manualClose = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.local) {
      var D = global.chahuDesktop;
      try { if (D && D.localClose) D.localClose(); } catch (e) { /* ignore */ }
      this.local = false;
      this.localReady = false;
      if (this._localOff) { try { this._localOff(); } catch (e) { /* ignore */ } this._localOff = null; }
      this.setStatus('idle');
      return;
    }
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.ws = null;
    this.setStatus('idle');
  };

  Net.prototype.isOpen = function () {
    if (this.local) return !!this.localReady;
    return !!this.ws && this.ws.readyState === 1;
  };

  /** 现在走的是本机通道吗（界面上的「离线」档靠它判断） */
  Net.prototype.isLocal = function () { return !!this.local; };

  Net.prototype.send = function (type, payload, opts) {
    var msg = Object.assign({ t: type }, payload || {});
    var data = JSON.stringify(msg);
    if (this.isOpen()) {
      try {
        if (this.local) {
          var D = global.chahuDesktop;
          if (D && D.localFeed) { D.localFeed(data); return true; }
        } else {
          this.ws.send(data);
          return true;
        }
      } catch (e) { /* fallthrough */ }
    }
    if (opts && opts.dropIfClosed) return false;
    this.queue.push(data);
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
    return false;
  };

  Net.prototype.flush = function () {
    if (!this.isOpen()) return;
    var q = this.queue;
    this.queue = [];
    for (var i = 0; i < q.length; i++) {
      try {
        if (this.local) {
          var D = global.chahuDesktop;
          if (D && D.localFeed) D.localFeed(q[i]);
        } else {
          this.ws.send(q[i]);
        }
      } catch (e) { /* ignore */ }
    }
  };

  global.Net = Net;
  Net.LOCAL_URL = LOCAL_URL;
})(window);
