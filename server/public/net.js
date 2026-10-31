/**
 * 茶绘 · 网络层
 * WebSocket 封装：自动重连、发送队列、心跳、断线状态上报
 *
 * **三条通道，同一套消息**：
 *   · `ws://…`     —— 正常的 WebSocket（网页版、连别人的服务器、连公网）
 *   · `local://`   —— 离线模式：不走 socket 的客户端，消息还是这些消息（见 client/local-host.js）
 *   · `webrtc://…` —— P2P 直连（安卓 / 网页房主）：DataChannel 管道，接口对齐 WebSocket，
 *                     信令走 PeerJS 免费云，数据不经任何服务器（见 webrtc-host.js）
 *   · `relay://…`  —— 公共中继（MQTT over WSS）：P2P 打不通时的兜底。跨 WiFi、
 *                     手机流量、公司网这些对称 NAT 场景下 P2P 打洞会失败，
 *                     这条通道借公共 broker 转发，只要双方能上网就一定连得通（见 mqtt-relay.js）
 *
 * 四条通道共用同一个收包出口 `_recv()`，所以「离线时某些消息没处理」这种
 * 只在真机上才发现的毛病，从结构上就不会出现。
 */
(function (global) {
  'use strict';

  var P = global.CHAPROTO;
  var LOCAL_URL = 'local://';

  function isLocalUrl(u) { return /^local:\/\//i.test(String(u || '')); }
  function isWebRtcUrl(u) { return /^webrtc:\/\//i.test(String(u || '')); }
  function isRelayUrl(u) { return /^relay:\/\//i.test(String(u || '')); }

  /**
   * 从 P2P 入口地址反推「同一间房」的公共中继 key。
   * 房主的信令 id 是 `chahui-<房间号去掉分隔符>`（见 webrtc-host.js 的 stablePeerId），
   * 中继 topic 用的是同一个房间号的同样处理结果 —— 所以分享链接里不用额外带字段，
   * 换通道时两边天然对得上。
   */
  function relayKeyOf(hostId) {
    var k = String(hostId || '')
      .replace(/^chahui-/i, '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toLowerCase();
    return k.length >= 4 ? k : '';
  }

  /**
   * WebRTC DataChannel 的 WebSocket 外衣：net 层其余代码（readyState 判断、
   * send/close、onopen/onmessage/onclose）感知不到它不是真 WebSocket。
   * serialization 用 json（与房主侧约定一致），收发的都是原始协议 JSON 字符串。
   */
  function RtcTransport(conn, peer) {
    var self = this;
    this.readyState = 0;
    this.OPEN = 1;
    this.CLOSED = 3;
    this._conn = conn;
    this._peer = peer;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    conn.on('open', function () {
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    });
    conn.on('data', function (d) {
      if (self.onmessage) self.onmessage({ data: (typeof d === 'string') ? d : JSON.stringify(d) });
    });
    conn.on('close', function () {
      self.readyState = 3;
      if (self.onclose) self.onclose({});
    });
    conn.on('error', function (e) {
      if (self.onerror) self.onerror(e || {});
    });
  }
  RtcTransport.prototype.send = function (raw) {
    if (this.readyState !== 1) return;
    try { this._conn.send(String(raw)); } catch (e) { /* 通道正在死 */ }
  };
  RtcTransport.prototype.close = function () {
    this.readyState = 3;
    try { this._conn.close(); } catch (e) { /* ignore */ }
    try { this._peer.destroy(); } catch (e) { /* ignore */ }
  };

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

  /**
   * 离开本机通道（离线模式）：摘监听 + 收掉主进程/壳里的那份会话。
   *
   * ★ 切到**任何一条**网络通道前都要先做这一步。以前只有 ws 那条岔路做了，
   *   webrtc:// 分支直接 `return this.connectWebRTC()` —— local 还是 true，
   *   send() 继续把消息喂给本机那份**空**服务器，于是「明明已经连上房主，
   *   却一直报房间不存在」。安卓默认落在 local://，点分享链接或粘 P2P 地址
   *   进别人房间正好走这条岔路，这就是「安卓加不进去房间」的一大来源。
   */
  Net.prototype.leaveLocalChannel = function () {
    var wasLocal = this.local;
    this.local = false;
    this.localReady = false;
    if (this._localOff) { try { this._localOff(); } catch (e) { /* ignore */ } this._localOff = null; }
    // 只摘监听不够 —— 会话还留在本地房间里当一个「幽灵客户端」，
    // 既占着房间又让成员列表多出一个空位。
    if (wasLocal) {
      var DL = global.chahuDesktop;
      if (DL && DL.localClose) { try { DL.localClose(); } catch (e) { /* ignore */ } }
    }
  };

  Net.prototype.connect = function (url) {
    if (url) this.url = url;
    if (!this.url) return;
    if (isLocalUrl(this.url)) return this.connectLocal();
    // P2P 也要先把本机通道拆干净，理由见 leaveLocalChannel
    if (isWebRtcUrl(this.url)) { this.leaveLocalChannel(); return this.connectWebRTC(); }
    if (isRelayUrl(this.url)) { this.leaveLocalChannel(); return this.connectRelay(); }
    this.leaveLocalChannel();
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
      if (self.manualClose || !self.local) {
        // 等这份会话起来的这几十毫秒里已经切到别的通道了 —— 把刚建起来的
        // 本机会话收掉，别在本地房间里留一个占位的「幽灵客户端」。
        try { if (D.localClose) D.localClose(); } catch (e) { /* ignore */ }
        return;
      }
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

  /** 给传输对象（真 WebSocket 或 RtcTransport）接上统一的开/收/断处理。
   *  连接成功后的状态推进、心跳、flush 在两条通道上必须完全一致 —— 抽出来。 */
  function wireTransport(self, t, closeMsg) {
    t.onopen = function () {
      if (self.ws !== t) return;   // 已经被换掉了（换通道 / 重连），别把状态改回来
      self.retry = 0;
      self.lastPong = Date.now();
      self.setStatus('online');
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send(P.C2S.PING, { at: Date.now() }); }, 20000);
      self.flush();
      self.emit('open', {});
    };

    t.onmessage = function (ev) {
      if (self.ws !== t) return;
      self._recv(ev.data);
    };

    t.onerror = function () {
      if (self.ws !== t) return;
      self.emit('neterror', { url: self.url });
    };

    t.onclose = function (ev) {
      // **这条 socket 还是「当前那条」吗？**
      // 换通道（在线 ↔ 离线）时我们会先 close() 掉旧的再建新的，而 close 事件是
      // 下一个 tick 才派发的 —— 那时候 manualClose 早被新通道重置成 false 了。
      // 不认 socket 只看 manualClose，旧连接的收尾就会把状态改回「已断开」并排一个重试，
      // 于是刚切到离线模式、状态栏却写着「连接中断，1s 后重试…」。
      if (self.ws !== t) return;
      clearInterval(self.pingTimer);
      self.ws = null;
      if (self._rtc) { try { self._rtc.destroy(); } catch (e) { /* ignore */ } self._rtc = null; }
      self.emit('close', ev);
      if (self.manualClose) { self.setStatus('idle'); return; }
      self.setStatus('offline', { message: closeMsg || '与服务器的连接已断开' });
      self.scheduleRetry();
    };
  }

  Net.prototype.connectWs = function () {
    var self = this;
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
    if (this._rtc) { try { this._rtc.destroy(); } catch (e) { /* ignore */ } this._rtc = null; }
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');

    var ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this.setStatus('offline', { message: '地址无效：' + this.url });
      return this.scheduleRetry();
    }
    this.ws = ws;
    wireTransport(self, ws);
  };

  /* ------------------------------------------------------------ WebRTC P2P 通道 */

  /**
   * P2P 直连（访客侧）：webrtc://<房主peerId>。
   * 信令走 PeerJS 免费云（只交换握手信息），数据走 DataChannel 直达房主手机 ——
   * 中间没有任何人的服务器。打洞失败 / 房主不在线 → 明确报错 + 走重连节奏。
   */
  Net.prototype.connectWebRTC = function () {
    var self = this;
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    if (this._rtc) { try { this._rtc.destroy(); } catch (e) { /* ignore */ } this._rtc = null; }
    clearTimeout(this.retryTimer);
    if (!global.Peer) {
      this.setStatus('offline', { message: '缺少 WebRTC 组件（vendor/peerjs.min.js 没加载）' });
      return;
    }
    this.setStatus('connecting');

    var hostId = this.url.replace(/^webrtc:\/\//i, '').replace(/\/+$/, '');
    var peer;
    try {
      // 信令与 ICE 配置与房主侧同源（ChaWebRTC.signalOpts；信令云可被 CHAHU_CONFIG.signalServer 覆盖）
      var popts = (global.ChaWebRTC && global.ChaWebRTC.signalOpts)
        ? global.ChaWebRTC.signalOpts()
        : { config: { iceServers: [] } };
      peer = new global.Peer(popts);
    } catch (e) {
      this.setStatus('offline', { message: 'WebRTC 初始化失败：' + e.message });
      return this.scheduleRetry();
    }
    this._rtc = peer;

    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      // ★ 打洞失败的两类原因：房主不在线，或者两边都在对称 NAT 后面（手机流量、
      //   校园网、公司网几乎都是）。后者以前只能干瞪眼 —— 现在只要房主开了
      //   公共中继，这里就自动改走 relay://，用户什么都不用做。
      //   P2P 正常握手 3~8 秒；等到 20 秒还没通，再等下去也不会有惊喜。
      var fb = relayKeyOf(hostId);
      var allow = (global.CHAHU_CONFIG || {}).relayFallback !== false;
      if (allow && fb && global.ChaRelay && global.ChaRelay.hasLib && global.ChaRelay.hasLib()) {
        try { if (self._rtc) self._rtc.destroy(); } catch (e) { /* ignore */ }
        self._rtc = null;
        self.url = 'relay://' + fb;
        self.emit('fallback', { from: 'webrtc', to: 'relay://' + fb });
        self.setStatus('connecting', { message: '直连打不通，正在改用公共中继…' });
        return self.connectRelay();
      }
      // 没有中继兜底时把话说清楚：是「连不上」而不是「不存在」
      self.setStatus('offline', { message: 'P2P 连接超时 —— 房主可能不在线，或双方网络无法直连（手机流量/公司网常见）。让房主换个网络重开，或改用一台公网服务器/中继' });
      self.scheduleRetry();
    }, 20000);

    peer.on('open', function () {
      if (self._rtc !== peer) return;
      var conn = peer.connect(hostId, (global.ChaWebRTC && global.ChaWebRTC.connectOpts) || { reliable: true });
      var t = new RtcTransport(conn, peer);
      self.ws = t;
      wireTransport(self, t, '与房主的 P2P 连接已断开');
    });

    peer.on('error', function (err) {
      var type = (err && err.type) || '';
      if (type === 'peer-unavailable') {
        // 房主不在线 / id 无效：重试也没用。先把 manualClose 顶上，让紧跟着的
        // close 事件走「静默收尾」，再用真实原因覆盖状态文案。
        settled = true;
        clearTimeout(timer);
        self.manualClose = true;
        if (self.ws) { try { self.ws.close(); } catch (e) { /* ignore */ } }
        self.ws = null;
        if (self._rtc) { try { self._rtc.destroy(); } catch (e) { /* ignore */ } self._rtc = null; }
        clearInterval(self.pingTimer);
        self.setStatus('offline', { message: '房主不在线或入口已失效（P2P）' });
        return;
      }
      // 信令本身连不上（PeerJS 云被墙 / 弱网）：这条要单独说，
      // 否则用户只看到「连接超时」，会以为是房主的问题。
      // 而且这种情况不用等 20 秒 —— 立刻改走公共中继，那条只是普通 WSS。
      if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        var fbSig = relayKeyOf(hostId);
        var allowSig = (global.CHAHU_CONFIG || {}).relayFallback !== false;
        if (allowSig && fbSig && global.ChaRelay && global.ChaRelay.hasLib && global.ChaRelay.hasLib()) {
          settled = true;
          clearTimeout(timer);
          try { if (self._rtc) self._rtc.destroy(); } catch (e) { /* ignore */ }
          self._rtc = null;
          self.url = 'relay://' + fbSig;
          self.emit('fallback', { from: 'webrtc', to: 'relay://' + fbSig, reason: type });
          self.setStatus('connecting', { message: 'P2P 信令不通，正在改用公共中继…' });
          self.connectRelay();
          return;
        }
        self.setStatus('offline', {
          message: '连不上 P2P 信令服务器 —— 换一条通道（公网服务器 / 中继）会更稳'
        });
      }
      self.emit('neterror', { url: self.url, error: type });
    });

    peer.on('disconnected', function () {
      // 信令断了不影响已建立的管道；恢复信令让重连机制还有效
      try { peer.reconnect(); } catch (e) { /* ignore */ }
    });
  };

  /* ------------------------------------------------------------ 公共中继通道 */

  /**
   * 公共中继（relay://<房间key>）：P2P 打不通时的兜底。
   *
   * 为什么需要它：跨 WiFi / 手机流量时两端大多在 NAT 后面，碰上对称 NAT
   * 打洞必然失败 —— 这是 WebRTC 的物理上限，不是程序能修的 bug。
   * 这条通道借公共 MQTT broker 转发，只要双方能上网就连得通，
   * 代价是数据要过第三方服务器、延迟多 100~300ms（见 mqtt-relay.js）。
   */
  Net.prototype.connectRelay = function () {
    var self = this;
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    if (this._rtc) { try { this._rtc.destroy(); } catch (e) { /* ignore */ } this._rtc = null; }
    clearTimeout(this.retryTimer);
    if (!global.ChaRelay) {
      this.setStatus('offline', { message: '缺少中继组件（vendor/mqtt.min.js 或 mqtt-relay.js 没加载）' });
      return;
    }
    this.setStatus('connecting');

    var key = this.url.replace(/^relay:\/\//i, '').replace(/\/+$/, '');
    var t;
    try {
      t = global.ChaRelay.createTransport(key);
    } catch (e) {
      this.setStatus('offline', { message: '中继初始化失败：' + e.message });
      return this.scheduleRetry();
    }
    this.ws = t;
    wireTransport(self, t, '公共中继连接已断开');
    // 首次连接要逐个试公共 broker（最坏 3 台 × 12s），给足时间再判死
    setTimeout(function () {
      if (self.ws !== t || t.readyState === 1) return;
      self.setStatus('offline', { message: '连不上公共中继 —— 换个网络试试（公司/校园网常封 WSS）' });
    }, 40000);
  };

  Net.prototype.scheduleRetry = function () {    var self = this;
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
    if (this._rtc) { try { this._rtc.destroy(); } catch (e) { /* ignore */ } this._rtc = null; }
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
