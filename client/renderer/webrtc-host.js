/**
 * 茶绘 · WebRTC P2P 公网直连（房主端）
 *
 * 解决的问题：安卓 / 网页端的房间状态机跑在本机 WebView（local-core）里，
 * 跨网联机原先只能靠「中继服务器」转发（任何 2.1.1+ 茶绘服务端都能当）。
 * 但中继终究依赖一台在线的服务器 —— 这里的 WebRTC 方案**零服务器依赖**：
 *
 *   房主：new Peer('chahui-<随机id>') 挂到 PeerJS 免费信令云上等连接；
 *   访客：peer.connect(hostId) 打洞建立 DataChannel，之后就是一条普通管道，
 *         帧原样进出 local-core —— 和中继的 /tunnel/<id> 端点一个待遇。
 *
 * 数据不走任何人的服务器（信令只负责介绍双方认识，握手完就退场）。
 * 打洞失败的情形（对称 NAT 等）由调用方回落到中继方案。
 *
 * 与 createTunnelHost（android-shim）接口同构：start/stop/getStatus/onState，
 * state.phase 约定一致（off / starting / on），url 为 webrtc://<peerId>。
 */
(function (global) {
  'use strict';

  /** ICE 服务器：STUN 只用来打洞（不中转数据）。多放几个提高成功率，
   *  国内可达性优先（Google STUN 在国内时好时坏，放最后兜底）。 */
  var ICE_SERVERS = [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.qq.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  /**
   * 实际用的 ICE 列表 = 内置 STUN + 配置里补的 TURN。
   *
   * 为什么需要 TURN：手机流量 / 公司网大多是「对称 NAT」，双方都打洞打不通时
   * 只能经一台 TURN 服务器转发（数据是 DTLS 加密的，TURN 只看到密文包）。
   * 没有 TURN 时 P2P 在跨运营商场景下成功率会明显下降 —— 这是 P2P 方案的物理上限，
   * 不是 bug。要稳定就配一台中继（服务端）或 TURN。
   *
   * 配置方式（client/renderer/config.js）：
   *   CHAHU_CONFIG.iceServers = [
   *     { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }
   *   ]
   */
  function iceServers() {
    var cfg = global.CHAHU_CONFIG || {};
    var list = ICE_SERVERS.slice();
    if (Array.isArray(cfg.iceServers)) {
      cfg.iceServers.forEach(function (s) {
        if (s && s.urls) list.push(s);
      });
    }
    return list;
  }

  /** PeerJS 免费信令云（握手完成后数据不经过它）。可被 CHAHU_CONFIG.signalServer 覆盖。 */
  function signalOpts() {
    var cfg = global.CHAHU_CONFIG || {};
    var opts = { config: { iceServers: iceServers() }, debug: 1 };
    var sig = String(cfg.signalServer || '').trim();
    if (sig) {
      // 形如 'ws(s)://host[:port][/path]' 或 'host[:port]' —— PeerJS 自建信令
      if (!/^wss?:\/\//i.test(sig)) sig = 'ws://' + sig;
      var m = /^(wss?):\/\/([^\/:]+)(?::(\d+))?(\/.*)?$/i.exec(sig);
      if (m) {
        opts.host = m[2];
        opts.port = m[3] ? Number(m[3]) : (m[1] === 'wss' ? 443 : 80);
        opts.secure = m[1] === 'wss';
        if (m[4] && m[4] !== '/') opts.path = m[4];
      }
    }
    return opts;
  }

  function randId(n) {
    var s = '', chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function errText(err) {
    var t = (err && err.type) || '';
    if (t === 'peer-unavailable') return '对方不在线（房主已关闭或房间号无效）';
    if (t === 'network') return '连不上信令服务器（网络受限？）';
    if (t === 'unavailable-id') return '入口地址冲突，请重试';
    if (t === 'browser-incompatible') return '这个浏览器不支持 WebRTC';
    return (err && err.message) || t || '未知错误';
  }

  /**
   * 创建一个 P2P 房主端。
   * @param {Object} deps
   *   boot     () => Promise<serverLike>   拿到本机房间状态机（有 onClient 方法）
   *   LocalWs  (toClient) => wsLike        服务端侧的本地客户端构造器（同 android-shim 的 LocalWs）
   *   roomId   () => string                可选：当前房间号。给了就让信令 id 跟着房间走
   *                                        （见 stablePeerId），手机重开后旧链接还能用。
   */
  function createHost(deps) {
    var peer = null;
    var state = { phase: 'off', url: '', error: '' };
    var sink = null;

    /**
     * 信令 id = 房间号，而不是每次随机。
     *
     * 手机上的 WebView 很容易被系统回收（切去聊天软件发个链接就可能没了）。
     * 以前 id 是随机的，重开应用 = 换地址，已经发出去的分享链接全部失效 ——
     * 这正是「安卓开房，朋友明明拿到链接却进不来」的一大来源。
     * 用房间号派生以后，房间还在（存档持久化已经保证了这点），地址就还在。
     */
    function stablePeerId() {
      var rid = '';
      try { rid = deps && deps.roomId ? String(deps.roomId() || '') : ''; } catch (e) { rid = ''; }
      // PeerJS 的 id 只认字母数字和 - _ 空格；房间号形如 r_e1x8b7j94q，去掉分隔符即可
      rid = rid.replace(/[^A-Za-z0-9]/g, '');
      return rid ? ('chahui-' + rid) : ('chahui-' + randId(12));
    }

    function push(s) {
      state = { phase: s.phase || 'off', url: s.url || '', error: s.error || '' };
      if (sink) { try { sink(state); } catch (e) { /* 渲染层的问题不外抛 */ } }
    }

    /** 一条访客 DataChannel ↔ 本机房间服务器的桥（对照 createTunnelHost 的访客接入） */
    function wireGuest(conn) {
      var client = null;
      var pending = [];
      conn.on('open', function () {
        // 访客 open 后立刻就会发 hello，而状态机 boot 是异步的 —— 先缓冲再补喂
        deps.boot().then(function (server) {
          var c = new deps.LocalWs(function (raw) {
            try { conn.send(String(raw)); } catch (e) { /* 通道正在死 */ }
          });
          client = c;
          server.onClient(c);
          if (pending) { pending.forEach(function (d) { try { c.feed(d); } catch (e) { /* ignore */ } }); pending = null; }
        }).catch(function () { /* boot 不了就没有这个访客 */ });
      });
      conn.on('data', function (d) {
        var s = (typeof d === 'string') ? d : JSON.stringify(d);
        if (client) client.feed(s);
        else if (pending.length < 200) pending.push(s);
      });
      conn.on('close', function () {
        if (client) { try { client.close(); } catch (e) { /* ignore */ } client = null; }
      });
      conn.on('error', function () { /* close 会跟着来 */ });
    }

    /** 同一个 peer id 在重试之间保持不变：入口地址是分享出去过的，能不变就不变 */
    var peerId = '';

    function start() {
      if (peer) return Promise.resolve({ ok: true, reused: true });
      if (!global.Peer) {
        push({ phase: 'off', url: '', error: '缺少 WebRTC 组件（vendor/peerjs.min.js 没加载）' });
        return Promise.resolve({ ok: false, error: state.error });
      }
      push({ phase: 'starting', url: '', error: '' });
      peerId = peerId || stablePeerId();
      return attempt(1);
    }

    /**
     * 挂一条信令连接。PeerJS 免费云在弱网下偶尔会「连上又掉」——
     * 之前一次失败就直接报错，用户看到的是「公网联机失败」但再点一次又好了。
     * 现在同一轮启动内自动重试（最多 3 次，间隔递增），id 保持不变。
     */
    function attempt(n) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          try { peer.destroy(); } catch (e) { /* ignore */ }
          peer = null;
          if (n < 3) { setTimeout(function () { attempt(n + 1).then(resolve); }, 600 * n); return; }
          push({ phase: 'off', url: '', error: 'P2P 信令超时（网络受限？试试连一台公网服务器）' });
          resolve({ ok: false, error: state.error });
        }, 20000);
        try {
          peer = new global.Peer(peerId, signalOpts());
        } catch (e) {
          clearTimeout(timer);
          settled = true;
          peer = null;
          push({ phase: 'off', url: '', error: 'WebRTC 初始化失败：' + e.message });
          resolve({ ok: false, error: state.error });
          return;
        }
        peer.on('open', function (myId) {
          clearTimeout(timer);
          settled = true;
          peerId = myId;
          var url = 'webrtc://' + myId;
          push({ phase: 'on', url: url, error: '' });
          resolve({ ok: true, url: url });
        });
        peer.on('connection', wireGuest);
        peer.on('disconnected', function () {
          // 信令断了不影响已建立的管道；试图恢复，让后续访客还能进来
          try { if (peer && !peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ }
        });
        peer.on('error', function (err) {
          if (!settled) {
            clearTimeout(timer);
            settled = true;
            try { peer.destroy(); } catch (e) { /* ignore */ }
            peer = null;
            // id 撞了 / 信令网络抖一下：换一个 id 或稍等再试，别第一次失败就判死
            var type = String((err && err.type) || '');
            var retriable = /network|server-error|socket-error|socket-closed|unavailable-id|ssl/i.test(type);
            if (retriable && n < 3) {
              var wait = 700 * n;
              if (type === 'unavailable-id') {
                // 这个 id 还挂在信令上（上次的连接没退干净 —— 手机刚被系统清掉后重开
                // 就是这种情况）。先等一会儿用**同一个 id** 再试，尽量保住已经分享
                // 出去的地址；到第三轮还撞才换成随机 id（旧链接作废，但新链接能用）。
                wait = 1600 * n;
                if (n >= 2) peerId = 'chahui-' + randId(12);
              }
              push({ phase: 'starting', url: '', error: errText(err) });
              setTimeout(function () { attempt(n + 1).then(resolve); }, wait);
              return;
            }
            push({ phase: 'off', url: '', error: errText(err) });
            resolve({ ok: false, error: state.error });
            return;
          }
          // 已就绪之后的错误：peer-unavailable 是访客侧的事（房主只会在日志里看到），
          // 其余（网络 / id 冲突）如实上报但不拆已建立的连接
          if (err.type !== 'peer-unavailable') {
            push({ phase: state.phase, url: state.url, error: errText(err) });
          }
        });
      });
    }

    function stop() {
      if (peer) {
        try { peer.destroy(); } catch (e) { /* ignore */ }
        peer = null;
      }
      // 下次开的是不是同一间房还不知道 —— 让 start() 按当时的房间号重算（换房就换地址）
      peerId = '';
      push({ phase: 'off', url: '', error: '' });
      return Promise.resolve({ ok: true });
    }

    return {
      start: start,
      stop: stop,
      getStatus: function () { return { phase: state.phase, url: state.url, error: state.error }; },
      onState: function (fn) { sink = typeof fn === 'function' ? fn : null; }
    };
  }

  global.ChaWebRTC = {
    createHost: createHost,
    ICE_SERVERS: ICE_SERVERS,
    signalOpts: signalOpts,
    /** 访客侧参数（serialization 必须与房主侧一致，这里统一 json） */
    connectOpts: { reliable: true, serialization: 'json' }
  };
})(window);
