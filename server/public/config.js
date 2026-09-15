/* 茶绘 · 运行时配置
 * server 为空时自动推断：
 *   - 页面由服务端托管（http/https）→ 同源 ws(s)://<host>/ws
 *   - 桌面端（file://）→ localStorage 记住的地址，否则回落到内置地址
 */
window.CHAHU_CONFIG = {
  // 公网服务端地址（部署后填写；本地开发留空即可）
  publicServer: '',
  localServer: 'ws://localhost:8437/ws',
  defaultName: '',
  appName: '茶绘',
  // 版本号：关于页显示 + 和 GitHub 的最新 release 比对
  appVersion: '1.7.0',
  // 开源仓库（更新检测用）
  repo: 'PainterAnkry/chahui'
};

window.CHAHU = window.CHAHU || {};

(function () {
  'use strict';
  var CFG = window.CHAHU_CONFIG;
  var LS_SERVER = 'chahu.server';
  var LS_NAME = 'chahu.name';

  function normalize(url) {
    if (!url) return '';
    url = String(url).trim();
    if (!url) return '';
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

  window.ChaConfig = {
    normalize: normalize,
    resolve: resolve,
    remember: remember,
    httpBaseOf: httpBaseOf,
    shareUrl: shareUrl,
    getName: getName,
    setName: setName,
    queryRoom: queryRoom,
    lanBase: lanBase,
    cfg: CFG
  };
})();
