/**
 * 茶绘 · 公共中继（MQTT over WebSocket）
 *
 * 解决的问题：跨 WiFi / 跨运营商联机时，两端多半都在 NAT 后面。
 * 「同一 WiFi」靠局域网直连，跨网就只剩两条路 ——
 *   ① STUN 打洞（见 webrtc-host.js）：家宽之间成功率不错，但碰上手机流量、
 *      校园网、公司网这类**对称 NAT** 就基本打不通；这是协议上限，不是 bug。
 *   ② 有一台双方都能连上的中继：传统做法是自建服务端，也就是要一台服务器。
 *
 * 这一层走的是 ②，但**不要求任何人拥有服务器**：借公共 MQTT broker
 * （EMQX / HiveMQ 的公开实例，免费、免注册、支持 WSS）做消息转发。
 * 对茶绘来说这够用 —— 笔画是整笔同步（TIP_MAX_CHARS=7000，一笔一帧），
 * 不是逐帧视频，200ms 的转发延迟肉眼几乎无感。
 *
 * 代价要说清楚：
 *   · 数据经第三方服务器转发（公共 broker 不做端到端加密，房间号是随机的，
 *     但仍属于「公开通道」）——所以它只在 P2P 打不通时兜底，不作默认路径；
 *   · 公共 broker 没有 SLA，可能限流或宕机 → 内置多个互为备份。
 *
 * topic 布局（带版本号，避免和别家应用撞车）：
 *   chahui/v3/<房间key>/h        房主收（访客 → 房主）
 *   chahui/v3/<房间key>/g/<sid>  某个访客收（房主 → 该访客）
 *
 * 帧格式：{ f: 发送方id, s: 单调序号, d: 原始协议帧字符串 }
 *   s 用来去重（MQTT QoS1 是「至少一次」，网络抖动会重投），
 *   序号从时间戳起步，重连后也不会退回到旧值。
 */
(function (global) {
  'use strict';

  var PREFIX = 'chahui/v3/';
  var LS_BROKER = 'chahu.broker';

  /** 公共 broker，按国内可达性排。第一个不通就自动换下一个。 */
  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  function roomKey(roomId) {
    return String(roomId || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  }

  function randomId(n) {
    var s = '', chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  /** 上次连通的 broker 排到最前：换网络后第一次连接会快很多 */
  function brokerList() {
    var last = '';
    try { last = localStorage.getItem(LS_BROKER) || ''; } catch (e) { /* 隐私模式下没有 */ }
    var list = BROKERS.slice();
    var i = list.indexOf(last);
    if (i > 0) { list.splice(i, 1); list.unshift(last); }
    return list;
  }

  function rememberBroker(url) {
    try { localStorage.setItem(LS_BROKER, url); } catch (e) { /* ignore */ }
  }

  function hasLib() { return !!(global.mqtt && global.mqtt.connect); }

  /**
   * 连上任意一台公共 broker。依次尝试，全部失败才 reject。
   * 连上之后交给 mqtt.js 自己保活（keepalive + 自动重连）。
   *
   * @param {Object} [opts]
   *   noAutoReconnect  true = 断线不自己重连，交给上层（访客端的 net.js 有完整的
   *                    重连节奏，两套重连并存会同时开出两条连接）。
   */
  function connectBroker(opts) {
    var noAuto = !!(opts && opts.noAutoReconnect);
    return new Promise(function (resolve, reject) {
      if (!hasLib()) return reject(new Error('缺少 MQTT 组件（vendor/mqtt.min.js 没加载）'));
      var list = brokerList();
      var i = 0;
      var lastErr = null;

      function next() {
        if (i >= list.length) return reject(lastErr || new Error('公共中继都连不上'));
        var url = list[i++];
        var settled = false;
        var cli;
        try {
          cli = global.mqtt.connect(url, {
            clientId: 'chahui_' + randomId(14),
            clean: true,
            connectTimeout: 9000,
            keepalive: 45,
            // 首次连接由我们自己做故障转移，先不要库内重连（否则会一直卡在坏 broker 上）
            reconnectPeriod: 0,
            protocolVersion: 4
          });
        } catch (e) {
          lastErr = e;
          return next();
        }
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          try { cli.end(true); } catch (e) { /* ignore */ }
          lastErr = new Error('连接超时：' + url);
          next();
        }, 12000);
        cli.on('connect', function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rememberBroker(url);
          // 连上以后把重连交给库（掉线自动回来，比我们自己轮询稳）——
          // 访客端例外：那边交给 net.js 统一重连。
          if (!noAuto) { try { cli.options.reconnectPeriod = 3000; } catch (e) { /* 个别版本只读 */ } }
          resolve(cli);
        });
        cli.on('error', function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { cli.end(true); } catch (err) { /* ignore */ }
          lastErr = e || new Error('连接失败：' + url);
          next();
        });
      }
      next();
    });
  }

  /* ------------------------------------------------------------ 房主端 */

  /**
   * 房主端：把 MQTT 上的访客桥进本机房间状态机。
   * 与 createTunnelHost / createHost(webrtc) 同构：start / stop / getStatus / onState。
   *
   * @param {Object} deps
   *   boot     () => Promise<serverLike>  本机房间状态机（有 onClient 方法）
   *   LocalWs  (toClient) => wsLike       服务端侧的本地客户端构造器
   *   roomId   () => string               当前房间号
   */
  function createHost(deps) {
    var state = { phase: 'off', url: '', error: '' };
    var sink = null;
    var cli = null;
    var key = '';
    var guests = {};      // sid -> { ws, ready, out }
    var seen = {};        // sid -> 收到的最大序号
    var seq = Date.now();
    var wantOn = false;
    var starting = false;

    function push(s) {
      state = { phase: s.phase || 'off', url: s.url || '', error: s.error || '' };
      if (sink) { try { sink(state); } catch (e) { /* 渲染层的问题不外抛 */ } }
    }

    function topicIn() { return PREFIX + key + '/h'; }
    function topicOut(sid) { return PREFIX + key + '/g/' + sid; }

    function publish(to, payload) {
      if (!cli || !cli.connected) return;
      try { cli.publish(to, payload, { qos: 1 }); } catch (e) { /* 通道正在死 */ }
    }

    function publishTo(sid, raw) {
      seq += 1;
      publish(topicOut(sid), JSON.stringify({ f: 'h', s: seq, d: String(raw) }));
    }

    /** 拿到（必要时新建）某个访客的本地客户端 */
    function guestFor(sid) {
      var g = guests[sid];
      if (g) return g;
      // out = 服务端要发出去、但 boot 还没好时的缓冲；in = 访客发过来、
      // 但服务端还没接上时的缓冲。**两侧都要缓冲** —— 只缓冲出站的话，
      // 访客的 JOIN 会赶在 onClient 之前到，LocalWs.feed 发出去无人接收，
      // 表现是「中继明明连上了却一直进不了房」（no_room）。
      g = { ws: null, ready: false, out: [], in: [] };
      g.ws = new deps.LocalWs(function (raw) {
        if (!g.ready) { if (g.out.length < 400) g.out.push(raw); return; }
        publishTo(sid, raw);
      });
      guests[sid] = g;
      deps.boot().then(function (server) {
        if (guests[sid] !== g) return;   // 这期间被 reset 掉了
        server.onClient(g.ws);
        g.ready = true;
        var outQ = g.out;
        g.out = [];
        outQ.forEach(function (raw) { publishTo(sid, raw); });
        var inQ = g.in;
        g.in = [];
        inQ.forEach(function (d) { try { g.ws.feed(d); } catch (e) { /* ignore */ } });
      }).catch(function () { /* boot 不了就没有这个访客 */ });
      return g;
    }

    /** 把一帧喂给某个访客；服务端还没接好就先攒着 */
    function feedGuest(sid, d) {
      var g = guestFor(sid);
      if (!g.ready) { if (g.in.length < 400) g.in.push(d); return; }
      g.ws.feed(d);
    }

    function dropGuest(sid) {
      var g = guests[sid];
      if (!g) return;
      delete guests[sid];
      try { g.ws.close(); } catch (e) { /* 已经死了 */ }
    }

    function onPayload(buf) {
      var msg;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      if (!msg || typeof msg.d !== 'string') return;
      var sid = String(msg.f || '');
      if (!sid) return;
      // r=1 是访客的「我（重新）连上了」—— 重连之后旧会话必须作废重建，
      // 否则房主这边还挂着一个已经断掉的 LocalWs，消息全被黑洞吃掉。
      if (msg.r) { dropGuest(sid); seen[sid] = 0; }
      var s = Number(msg.s) || 0;
      if (s && s <= (seen[sid] || 0)) return;   // QoS1 重投，丢掉
      if (s) seen[sid] = s;
      if (!msg.d) return;                       // 纯控制帧（重连握手），没有数据可喂
      feedGuest(sid, msg.d);
    }

    function start() {
      if (starting) return Promise.resolve({ ok: false, error: '正在启动' });
      if (cli && cli.connected && state.phase === 'on') return Promise.resolve({ ok: true, reused: true });
      var rid = '';
      try { rid = String((deps.roomId && deps.roomId()) || ''); } catch (e) { rid = ''; }
      key = roomKey(rid);
      if (!key) {
        push({ phase: 'off', url: '', error: '还没有房间号，无法开中继' });
        return Promise.resolve({ ok: false, error: state.error });
      }
      wantOn = true;
      starting = true;
      push({ phase: 'starting', url: '', error: '' });
      return connectBroker().then(function (c) {
        starting = false;
        if (!wantOn) { try { c.end(true); } catch (e) { /* ignore */ } return { ok: false }; }
        cli = c;
        // 首次 + 每次重连都要重新订阅（clean session 下重连会丢订阅）
        function resub() {
          try { cli.subscribe(topicIn(), { qos: 1 }); } catch (e) { /* ignore */ }
          push({ phase: 'on', url: 'relay://' + rid, error: '' });
        }
        cli.on('connect', resub);
        cli.on('message', function (t, buf) { if (t === topicIn()) onPayload(buf); });
        cli.on('close', function () {
          if (!wantOn) return;
          push({ phase: 'starting', url: '', error: '公共中继断线，正在重连…' });
        });
        return new Promise(function (resolve) {
          cli.subscribe(topicIn(), { qos: 1 }, function (err) {
            if (err) {
              push({ phase: 'off', url: '', error: '中继订阅失败：' + err.message });
              return resolve({ ok: false, error: state.error });
            }
            push({ phase: 'on', url: 'relay://' + rid, error: '' });
            resolve({ ok: true, url: 'relay://' + rid });
          });
        });
      }).catch(function (e) {
        starting = false;
        push({ phase: 'off', url: '', error: '公共中继连不上：' + ((e && e.message) || e) });
        return { ok: false, error: state.error };
      });
    }

    function stop() {
      wantOn = false;
      Object.keys(guests).forEach(dropGuest);
      guests = {};
      seen = {};
      if (cli) {
        try { cli.end(true); } catch (e) { /* ignore */ }
        cli = null;
      }
      push({ phase: 'off', url: '', error: '' });
      return Promise.resolve({ ok: true });
    }

    return {
      start: start,
      stop: stop,
      getStatus: function () { return { phase: state.phase, url: state.url, error: state.error }; },
      onState: function (fn) { sink = typeof fn === 'function' ? fn : null; },
      guestCount: function () { return Object.keys(guests).length; }
    };
  }

  /* ------------------------------------------------------------ 访客端 */

  /**
   * 访客端的 WebSocket 外衣：net.js 拿到它以后照常 send / onmessage，
   * 感知不到底下是 MQTT。接口对齐 net.js 的 RtcTransport。
   */
  function MqttTransport(roomId) {
    var self = this;
    this.readyState = 0;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this._sid = randomId(9);
    this._key = roomKey(roomId);
    this._seq = Date.now();
    this._last = 0;
    this._cli = null;
    this._closed = false;
    this._wasOpen = false;

    var topicIn = PREFIX + this._key + '/g/' + this._sid;
    var topicOut = PREFIX + this._key + '/h';

    function announce() {
      // 告诉房主「我（重新）连上了」，让它把上一轮那个死掉的会话换掉
      try {
        self._cli.publish(topicOut, JSON.stringify({ f: self._sid, s: ++self._seq, r: 1, d: '' }), { qos: 1 });
      } catch (e) { /* ignore */ }
    }

    function afterConnect(cli) {
      cli.subscribe(topicIn, { qos: 1 }, function (err) {
        if (self._closed) return;
        if (err) {
          if (self.onerror) self.onerror(err);
          return;
        }
        self.readyState = 1;
        announce();
        if (!self._wasOpen) {
          self._wasOpen = true;
          if (self.onopen) self.onopen({});
        }
      });
    }

    connectBroker({ noAutoReconnect: true }).then(function (cli) {
      if (self._closed) { try { cli.end(true); } catch (e) { /* ignore */ } return; }
      self._cli = cli;
      cli.on('message', function (t, buf) {
        if (t !== topicIn) return;
        var msg;
        try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
        if (!msg || typeof msg.d !== 'string' || !msg.d) return;
        var s = Number(msg.s) || 0;
        if (s && s <= self._last) return;   // 重投，丢掉
        if (s) self._last = s;
        if (self.onmessage) self.onmessage({ data: msg.d });
      });
      cli.on('connect', function () { afterConnect(cli); });   // 万一同一条连接被复用，重订阅一次
      cli.on('close', function () {
        if (self._closed) return;
        self.readyState = 0;
        // 交给 net.js 的重连节奏（它知道该退避多久），这里不自作主张
        if (self.onclose) self.onclose({});
      });
      cli.on('error', function (e) { if (self.onerror) self.onerror(e || {}); });
      afterConnect(cli);
    }).catch(function (e) {
      self.readyState = 3;
      if (self.onerror) self.onerror(e || {});
      if (self.onclose) self.onclose({ reason: (e && e.message) || '中继连接失败' });
    });
  }

  MqttTransport.prototype.send = function (raw) {
    if (this.readyState !== 1 || !this._cli) return;
    this._seq += 1;
    try {
      this._cli.publish(PREFIX + this._key + '/h',
        JSON.stringify({ f: this._sid, s: this._seq, d: String(raw) }), { qos: 1 });
    } catch (e) { /* 通道正在死 */ }
  };

  MqttTransport.prototype.close = function () {
    this._closed = true;
    this.readyState = 3;
    if (this._cli) { try { this._cli.end(true); } catch (e) { /* ignore */ } this._cli = null; }
  };

  function createTransport(roomId) {
    return new MqttTransport(roomId);
  }

  global.ChaRelay = {
    createHost: createHost,
    createTransport: createTransport,
    roomKey: roomKey,
    hasLib: hasLib,
    BROKERS: BROKERS
  };
})(window);
