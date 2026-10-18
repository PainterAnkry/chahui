/* 茶绘 · 运行时配置
 * server 为空时自动推断：
 *   - 页面由服务端托管（http/https）→ 同源 ws(s)://<host>/ws
 *   - 桌面端（file://）→ localStorage 记住的地址，否则回落到内置地址
 */
window.CHAHU_CONFIG = {
  // 公网服务端地址（自建 / 托管服务端时填写）。
  // ★ 官方公共服务器已下线，这里**不再带默认值**：留空时安卓默认进离线模式
  //   （本机房间 + 公网联机 P2P），桌面端默认连本机内置服务器，网页版默认同源。
  publicServer: '',
  localServer: 'ws://localhost:8437/ws',
  defaultName: '',
  appName: '茶绘',
  // 版本号：关于页显示 + 和 GitHub 的最新 release 比对
  appVersion: '2.1.7',
  // 开源仓库（更新检测用）
  repo: 'PainterAnkry/chahui'
};

window.CHAHU = window.CHAHU || {};

(function () {
  'use strict';
  var CFG = window.CHAHU_CONFIG;

  // ?signal=ws://host:port —— P2P 信令服务器（自建信令时随分享链接带上；
  // 不带则用 PeerJS 免费信令云）。必须在配置加载时读取，联机发生在页面初始化后。
  try {
    var qSig = new URLSearchParams(location.search || '').get('signal');
    if (qSig) CFG.signalServer = String(qSig).trim();
  } catch (e) { /* ignore */ }

  // ?localport= —— 桌面端内置服务器的**实际端口**（用户改过端口时 8437 不对）。
  // 只改 localServer 这个兜底值，不碰「?server= / 用户记住的服务器」的优先级。
  try {
    var qLp = parseInt(new URLSearchParams(location.search || '').get('localport'), 10);
    if (qLp > 0 && qLp < 65536) CFG.localServer = 'ws://localhost:' + qLp + '/ws';
  } catch (e) { /* ignore */ }

  var LS_SERVER = 'chahu.server';
  var LS_NAME = 'chahu.name';
  var LS_AVATAR = 'chahu.avatar';
  // 已下线的官方公共服务器：老版本把它记在 localStorage / 桌面配置里，启动时清掉
  var RETIRED_OFFICIAL = 'ws://139.199.90.209:8437/ws';

  function normalize(url) {
    if (!url) return '';
    url = String(url).trim();
    if (!url) return '';
    // 离线模式用一个**假地址**占位。它不是网络地址，绝不能被拼成 ws://local:///ws ——
    // 网络层看到它就会改走「主进程里那份服务端」，不占端口也不出网。
    if (/^local:\/\//i.test(url)) return 'local://';
    // P2P 直连入口（webrtc://<房主peerId>）：原样交给网络层（见 net.js connectWebRTC）
    if (/^webrtc:\/\//i.test(url)) return url.replace(/\/+$/, '');
    if (/^wss?:\/\//i.test(url)) return url;
    if (/^https:\/\//i.test(url)) return 'wss://' + url.slice(8).replace(/\/+$/, '') + '/ws';
    if (/^http:\/\//i.test(url)) return 'ws://' + url.slice(7).replace(/\/+$/, '') + '/ws';
    return 'ws://' + url.replace(/\/+$/, '') + '/ws';
  }

  function fromQuery() {
    try {
      var q = new URLSearchParams(location.search || '');
      return q.get('server') || '';
    } catch (e) { return ''; }
  }

  function stored() {
    try {
      var s = localStorage.getItem(LS_SERVER) || '';
      // 官方公共服务器已下线：老版本记住的这条地址不能再当默认（连不上还会
      // 把入口页卡在「正在连接」），清掉让它回退到「本机服务器 / 离线模式」。
      if (s && s.replace(/\/+$/, '') === RETIRED_OFFICIAL) {
        localStorage.removeItem(LS_SERVER);
        return '';
      }
      return s;
    } catch (e) { return ''; }
  }

  function resolve() {
    var q = normalize(fromQuery());
    if (q) return q;
    var s = normalize(stored());
    if (s) return s;
    // 安卓壳（Capacitor）：页面是本地资产，origin 是 http://localhost ——
    // 「同源推断」会推出一个没人监听的 ws://localhost/ws。
    // 没有官方公网服之后，安卓的缺省落点是**离线模式**（本机房间 + 公网联机 P2P）；
    // 要连别人 / 自建服务器，在入口页的「服务器」里填地址（会记住）。
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      return normalize(CFG.publicServer) || 'local://';
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    return normalize(CFG.publicServer) || normalize(CFG.localServer);
  }

  function remember(url) {
    try { localStorage.setItem(LS_SERVER, url); } catch (e) { /* ignore */ }
  }

  function httpBaseOf(wsUrl) {
    var m = /^(wss?):\/\/([^/]+)/i.exec(wsUrl || '');
    if (!m) return '';
    return (m[1] === 'wss' ? 'https://' : 'http://') + m[2];
  }

  function shareUrl(wsUrl, roomId) {
    var base = httpBaseOf(wsUrl);
    if (!base) return '';
    return base + '/?room=' + encodeURIComponent(roomId);
  }

  function getName() {
    var n = '';
    try { n = localStorage.getItem(LS_NAME) || ''; } catch (e) { /* ignore */ }
    return n || CFG.defaultName || '';
  }
  function setName(n) {
    try { localStorage.setItem(LS_NAME, n); } catch (e) { /* ignore */ }
  }

  /**
   * 头像：一张已压到 96px 的 dataURL。跟昵称一样是「我是谁」的一部分，
   * 所以存在同一层（localStorage），进房时随 ROOM_JOIN / ROOM_CREATE 带上去。
   * 存不下（配额满）就当作没有 —— 头像丢了不影响进房。
   */
  function getAvatar() {
    try { return localStorage.getItem(LS_AVATAR) || ''; } catch (e) { return ''; }
  }
  function setAvatar(a) {
    try {
      if (a) localStorage.setItem(LS_AVATAR, a);
      else localStorage.removeItem(LS_AVATAR);
    } catch (e) { /* ignore */ }
  }

  function queryRoom() {
    try {
      var q = new URLSearchParams(location.search || '');
      return q.get('room') || '';
    } catch (e) { return ''; }
  }

  /**
   * 局域网地址：桌面端内置服务器起来后由主进程通过 ?lan=<ip>&port=<端口> 传进来。
   * 分享链接必须用它 —— 用 localhost 发出去朋友是打不开的。
   */
  var LAN = (function () {
    try {
      var q = new URLSearchParams(location.search || '');
      var ip = q.get('lan') || '';
      var port = q.get('port') || '';
      if (!ip) return '';
      return 'http://' + ip + (port ? ':' + port : '');
    } catch (e) { return ''; }
  })();

  function lanBase() { return LAN; }

  /**
   * 运行时改局域网地址。启动时那条 ?lan= 是主进程**开窗口那一刻**定下的，
   * 而用户可以在界面上把服务器开起来 / 关掉 —— 那时候 query 已经改不了了，
   * 所以必须能后补。（关掉服务器就传空串，入口页那条提示自然收起来。）
   */
  function setLan(base) { LAN = base || ''; }

  window.ChaConfig = {
    normalize: normalize,
    resolve: resolve,
    remember: remember,
    httpBaseOf: httpBaseOf,
    shareUrl: shareUrl,
    getName: getName,
    setName: setName,
    getAvatar: getAvatar,
    setAvatar: setAvatar,
    queryRoom: queryRoom,
    lanBase: lanBase,
    setLan: setLan,
    cfg: CFG
  };
})();
