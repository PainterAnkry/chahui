/**
 * 茶绘 · 网络层
 * WebSocket 封装：自动重连、发送队列、心跳、断线状态上报
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;

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

  Net.prototype.connect = function (url) {
    var self = this;
    if (url) this.url = url;
    if (!this.url) return;
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
      self.retry = 0;
      self.lastPong = Date.now();
      self.setStatus('online');
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send(P.C2S.PING, { at: Date.now() }); }, 20000);
      self.flush();
      self.emit('open', {});
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.t) return;
      if (msg.t === P.S2C.PONG) {
        self.latency = Math.max(0, Date.now() - (msg.t0 || Date.now()));
        self.setStatus('online');
        return;
      }
      if (msg.t === P.S2C.HELLO_OK) { self.selfId = msg.connId; self.limits = msg.limits || {}; }
      self.emit('message', msg);
      self.emit(msg.t, msg);
    };

    ws.onerror = function () {
      self.emit('neterror', { url: self.url });
    };

    ws.onclose = function (ev) {
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
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.ws = null;
    this.setStatus('idle');
  };

  Net.prototype.isOpen = function () {
    return !!this.ws && this.ws.readyState === 1;
  };

  Net.prototype.send = function (type, payload, opts) {
    var msg = Object.assign({ t: type }, payload || {});
    var data = JSON.stringify(msg);
    if (this.isOpen()) {
      try { this.ws.send(data); return true; } catch (e) { /* fallthrough */ }
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
      try { this.ws.send(q[i]); } catch (e) { /* ignore */ }
    }
  };

  global.Net = Net;
})(window);
