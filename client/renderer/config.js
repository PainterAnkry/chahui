/* 茶绘 · 运行时配置
 * server 为空时自动推断：
 *   - 页面由服务端托管（http/https）→ 同源 ws(s)://<host>/ws
 *   - 桌面端（file://）→ localStorage 记住的地址，否则回落到内置地址
 */
window.CHAHU_CONFIG = {
  // 公网服务端地址（部署后填写；本地开发留空即可）
  // 已部署到腾讯云 Lighthouse 轻量服务器（2 核 2G / 广州），24 小时在线。
  publicServer: 'ws://139.199.90.209/ws',
  localServer: 'ws://localhost:8437/ws',
  defaultName: '',
  appName: '茶绘',
  // 版本号：关于页显示 + 和 GitHub 的最新 release 比对
  appVersion: '2.0.4',
  // 开源仓库（更新检测用）
  repo: 'PainterAnkry/chahui'
};

window.CHAHU = window.CHAHU || {};

(function () {
  'use strict';
  var CFG = window.CHAHU_CONFIG;
  var LS_SERVER = 'chahu.server';
  var LS_NAME = 'chahu.name';
  var LS_AVATAR = 'chahu.avatar';

  function normalize(url) {
    if (!url) return '';
    url = String(url).trim();
    if (!url) return '';
    // 离线模式用一个**假地址**占位。它不是网络地址，绝不能被拼成 ws://local:///ws ——
    // 网络层看到它就会改走「主进程里那份服务端」，不占端口也不出网。
    if (/^local:\/\//i.test(url)) return 'local://';
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
    try { return localStorage.getItem(LS_SERVER) || ''; } catch (e) { return ''; }
  }

  function resolve() {
    var q = normalize(fromQuery());
    if (q) return q;
    var s = normalize(stored());
    if (s) return s;
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
