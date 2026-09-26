/**
 * 茶绘 · 安卓 shim（Capacitor WebView 专用）
 *
 * 桌面端靠 preload.js 把 `chahuDesktop` 桥接进渲染层；安卓端没有 Electron，
 * 这个文件就是那座桥：只在 Capacitor 原生环境里激活，网页版 / 桌面端零影响
 * （它排在 net.js 之前加载，但激活前什么都不做）。
 *
 * 两大块：
 *   ① chahuDesktop 安卓实现 —— saveFile（Filesystem + Share）、getInfo、
 *      setServer、离线模式四件套（localOpen/localFeed/localClose/onLocalMessage）。
 *      刻意**不暴露** openFile / clipboardImage / server* / tunnel* / downloadUpdate：
 *      渲染端对每个能力都判存在性并带网页版降级（app.js / menu.js），不暴露即自动隐藏。
 *   ② WebView 内嵌离线状态机 —— 桌面端离线模式是主进程里 require 服务端、
 *      挂一个不走 socket 的客户端（client/local-host.js）。安卓 WebView 跑不了 Node，
 *      这里把同一份服务端源码（client/renderer/local-core/，由 tools/sync-android-core.js
 *      从 server/src 原样同步）用微型 CommonJS 加载器跑在 WebView 里：
 *        · fs   → 内存目录树 + 启动时 IndexedDB 全量注水 + 防抖写回（存档不丢）
 *        · Node 内置（http/os/ws）→ 空桩：离线模式一个端口都不占，这些桩永远不会被真正用上
 *        · process.env → 置超长房间 TTL：手机用户几天不打开很正常，sweeper 不许清房
 *      会话协议与桌面端完全一致（LocalWs 的浏览器版），net.js 一行不用改。
 *
 * 本文件同时可被 Node require（tools/test-android-shim.js 用）：
 * 没检测到 Capacitor 时不激活，只导出内部的工厂函数供测试拼装。
 */
(function (global) {
  'use strict';

  var isNative = !!(global.Capacitor && global.Capacitor.isNativePlatform
    && global.Capacitor.isNativePlatform());

  /* ================================================================ Buffer 桩
   * 只覆盖 local-core 用到的面：from(str|u8|b64) / toString('base64'|'utf8') /
   * byteLength / isBuffer / alloc。rooms.js 存 PNG 底图全靠 base64 这条路。
   */
  function createBufferPolyfill() {
    var te = new TextEncoder();
    var td = new TextDecoder();
    function bytesToB64(u8) {
      var s = '', CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      }
      return btoa(s);
    }
    function b64ToBytes(b64) {
      var s = atob(b64), u8 = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return u8;
    }
    function FakeBuffer(u8) { this._u8 = u8; this.length = u8.length; }
    FakeBuffer.prototype.toString = function (enc) {
      if (enc === 'base64') return bytesToB64(this._u8);
      if (enc === 'utf8' || enc === undefined) return td.decode(this._u8);
      if (enc === 'utf-8') return td.decode(this._u8);
      throw new Error('Buffer 桩不支持编码 ' + enc);
    };
    FakeBuffer.from = function (input, enc) {
      if (input instanceof FakeBuffer) return new FakeBuffer(input._u8);
      if (input instanceof Uint8Array) return new FakeBuffer(new Uint8Array(input));
      if (typeof input === 'string') {
        if (enc === 'base64') return new FakeBuffer(b64ToBytes(input));
        return new FakeBuffer(te.encode(input));
      }
      if (typeof input === 'number') return new FakeBuffer(new Uint8Array(input));
      return new FakeBuffer(new Uint8Array(0));
    };
    FakeBuffer.alloc = function (n) { return new FakeBuffer(new Uint8Array(Math.max(0, n | 0))); };
    FakeBuffer.isBuffer = function (x) { return x instanceof FakeBuffer; };
    FakeBuffer.byteLength = function (str, enc) {
      if (typeof str !== 'string') return (str && str.length) || 0;
      if (enc === 'base64') return b64ToBytes(str).length;
      return te.encode(str).length;
    };
    FakeBuffer._bytesToB64 = bytesToB64;
    FakeBuffer._b64ToBytes = b64ToBytes;
    return FakeBuffer;
  }

  /* ================================================================ path 桩
   * 虚拟根是 '/'，全部 posix 语义 —— 所有路径都来自 shim 自己注入的 DATA_DIR，
   * 不存在盘符 / 反斜杠混进来的可能。
   */
  function createPathPolyfill() {
    function normalize(p) {
      p = String(p);
      var abs = p.charAt(0) === '/';
      var parts = p.split('/'), out = [];
      for (var i = 0; i < parts.length; i++) {
        var s = parts[i];
        if (!s || s === '.') continue;
        if (s === '..') {
          if (out.length && out[out.length - 1] !== '..') { out.pop(); continue; }
          if (!abs) out.push('..');
          continue;
        }
        out.push(s);
      }
      var j = out.join('/');
      return abs ? '/' + j : (j || '.');
    }
    function join() {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] === undefined || arguments[i] === null) continue;
        parts.push(String(arguments[i]));
      }
      return normalize(parts.join('/'));
    }
    function resolve() {
      var base = '';
      for (var i = 0; i < arguments.length; i++) {
        var a = String(arguments[i] || '');
        if (a.charAt(0) === '/') { base = a; continue; }
        base = base ? base + '/' + a : a;
      }
      return normalize(base.charAt(0) === '/' ? base : '/' + base);
    }
    function dirname(p) {
      p = normalize(p);
      var i = p.lastIndexOf('/');
      if (i <= 0) return '/';
      return p.slice(0, i);
    }
    function basename(p, ext) {
      var b = normalize(p).slice(normalize(p).lastIndexOf('/') + 1);
      if (ext && b.slice(-ext.length) === ext) b = b.slice(0, b.length - ext.length);
      return b;
    }
    function extname(p) {
      var b = basename(p), i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    }
    return { normalize: normalize, join: join, resolve: resolve, dirname: dirname,
      basename: basename, extname: extname, sep: '/', delimiter: ':' };
  }

  /* ================================================================ fs 桩
   * 内存目录树 + （可选）IndexedDB 持久化。rooms.js 只用同步 API（桌面端实测过），
   * 所以同步面给全，异步面只留 promises.rm（删目录队列用）。
   * 写回是防抖的：每 1.2s 把脏文件批量落进 IndexedDB；切后台 / 关页时再抢一把。
   */
  function createBrowserFs(opts) {
    opts = opts || {};
    var Buffer = opts.Buffer;
    var pathm = opts.path;
    var indexedDB = opts.indexedDB || null;
    var persist = !!indexedDB;
    var dirs = { '/': true };
    var files = new Map();          // path -> { t:'s'|'b', d: string|Uint8Array }
    var dirty = new Set(), deleted = new Set();
    var flushTimer = null, flushing = false, dbp = null;

    function mkdirp(p) {
      p = pathm.normalize(p);
      if (p === '/' || !p) return;
      var segs = p.split('/'), cur = '';
      for (var i = 0; i < segs.length; i++) {
        if (!segs[i]) continue;
        cur += '/' + segs[i];
        dirs[cur] = true;
      }
    }
    function parentOf(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
    function removeTree(p) {
      p = pathm.normalize(p);
      if (p === '/') { files.clear(); dirs = { '/': true }; return; }
      files.delete(p); delete dirs[p];
      var pre = p + '/';
      files.forEach(function (_v, k) { if (k.indexOf(pre) === 0) files.delete(k); });
      Object.keys(dirs).forEach(function (k) { if (k.indexOf(pre) === 0) delete dirs[k]; });
      deleted.add(p);
    }
    function enoent(p, op) { return new Error('ENOENT: no such file or directory, ' + op + " '" + p + "'"); }

    function markDirty(p) {
      dirty.add(p);
      deleted.delete(p);
      if (!flushTimer && persist) flushTimer = setTimeout(flush, 1200);
    }

    function openDb() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var rq = indexedDB.open('chahu-local-core', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('files', { keyPath: 'p' }); };
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error || new Error('IndexedDB 打不开')); };
      }).catch(function (e) {
        // 存档库打不开（隐私模式 / 配额）：降级成纯内存，离线还能画，只是不持久
        console.warn('[chahu-shim] IndexedDB 不可用，离线存档将不持久：' + (e && e.message));
        persist = false;
        throw e;
      });
      return dbp;
    }

    /** 启动注水：把上次的存档整个读进内存树。必须在加载状态机之前完成。 */
    function hydrate() {
      if (!persist) return Promise.resolve();
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('files', 'readonly');
          var rq = tx.objectStore('files').getAll();
          rq.onsuccess = function () {
            var rows = rq.result || [];
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              if (!r || !r.p) continue;
              mkdirp(parentOf(r.p));
              if (r.t === 'b') files.set(r.p, { t: 'b', d: Buffer._b64ToBytes(r.d) });
              else files.set(r.p, { t: 's', d: r.d });
            }
            resolve();
          };
          rq.onerror = function () { resolve(); };  // 读不出来就当第一次用
        });
      }).catch(function () { /* 已降级 */ });
    }

    function flush() {
      flushTimer = null;
      if (!persist || flushing) { if (dirty.size && persist) flushTimer = setTimeout(flush, 1500); return; }
      if (!dirty.size && !deleted.size) return;
      flushing = true;
      var puts = [], dels = [];
      dirty.forEach(function (p) {
        var f = files.get(p);
        if (!f) return;
        puts.push(f.t === 'b' ? { p: p, t: 'b', d: Buffer._bytesToB64(f.d) } : { p: p, t: 's', d: f.d });
      });
      deleted.forEach(function (p) { dels.push(p); });
      dirty.clear(); deleted.clear();
      openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('files', 'readwrite');
          var store = tx.objectStore('files');
          for (var i = 0; i < dels.length; i++) { try { store.delete(dels[i]); } catch (e) { /* ignore */ } }
          for (var j = 0; j < puts.length; j++) { try { store.put(puts[j]); } catch (e) { /* ignore */ } }
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写失败')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB 写中止')); };
        });
      }).then(function () { flushing = false; })
        .catch(function (e) {
          // 写失败：把这批还回去，下个周期再试（丢档窗口只有防抖那 1.2s + 本轮）
          flushing = false;
          for (var i = 0; i < puts.length; i++) dirty.add(puts[i].p);
          for (var j = 0; j < dels.length; j++) deleted.add(dels[j]);
          if (persist && (dirty.size || deleted.size)) flushTimer = setTimeout(flush, 2500);
          console.warn('[chahu-shim] 存档写回失败（稍后重试）：' + (e && e.message));
        });
    }

    var fs = {
      existsSync: function (p) {
        p = pathm.normalize(p);
        return files.has(p) || !!dirs[p];
      },
      mkdirSync: function (p, _o) { mkdirp(p); },
      readdirSync: function (p, o) {
        p = pathm.normalize(p);
        if (files.has(p) || !dirs[p]) {
          if (files.has(p)) throw new Error('ENOTDIR: not a directory, readdir \'' + p + '\'');
          throw enoent(p, 'readdir');
        }
        var pre = p === '/' ? '/' : p + '/';
        var names = [], seen = {};
        files.forEach(function (_v, k) {
          if (k.indexOf(pre) !== 0 || k === p) return;
          var rest = k.slice(pre.length);
          var name = rest.split('/')[0];
          if (!seen[name]) { seen[name] = true; names.push(name); }
        });
        Object.keys(dirs).forEach(function (k) {
          if (k === p || k.indexOf(pre) !== 0) return;
          var rest = k.slice(pre.length);
          var name = rest.split('/')[0];
          if (name && !seen[name]) { seen[name] = true; names.push(name); }
        });
        if (o && o.withFileTypes) {
          return names.map(function (nm) {
            var full = pre + nm;
            var isDir = !!dirs[full] && !files.has(full);
            return { name: nm, isDirectory: function () { return isDir; }, isFile: function () { return !isDir; } };
          });
        }
        return names;
      },
      statSync: function (p) {
        p = pathm.normalize(p);
        var f = files.get(p);
        var isFile = !!f, isDir = !f && !!dirs[p];
        if (!isFile && !isDir) throw enoent(p, 'stat');
        var size = isFile ? (f.t === 's' ? Buffer.byteLength(f.d) : f.d.length) : 0;
        var mt = isFile ? (f.mtime || 0) : 0;
        return {
          size: size,
          mtimeMs: mt || 0,
          mtime: new Date(mt || 0),
          isFile: function () { return isFile; },
          isDirectory: function () { return isDir; }
        };
      },
      readFileSync: function (p, enc) {
        p = pathm.normalize(p);
        var f = files.get(p);
        if (!f) throw enoent(p, 'open');
        if (enc === 'utf8' || enc === 'utf-8') return f.t === 's' ? f.d : Buffer.from(f.d).toString('utf8');
        return f.t === 's' ? Buffer.from(f.d) : Buffer.from(f.d);
      },
      writeFileSync: function (p, data) {
        p = pathm.normalize(p);
        mkdirp(parentOf(p));
        if (typeof data === 'string') files.set(p, { t: 's', d: data, mtime: Date.now() });
        else if (data instanceof Uint8Array) files.set(p, { t: 'b', d: new Uint8Array(data), mtime: Date.now() });
        else if (data && data._u8) files.set(p, { t: 'b', d: new Uint8Array(data._u8), mtime: Date.now() });
        else files.set(p, { t: 's', d: String(data), mtime: Date.now() });
        markDirty(p);
      },
      renameSync: function (a, b) {
        a = pathm.normalize(a); b = pathm.normalize(b);
        var f = files.get(a);
        if (f) {
          mkdirp(parentOf(b));
          files.set(b, f);
          files.delete(a);
          deleted.add(a);
          markDirty(b);
          return;
        }
        if (dirs[a]) { dirs[b] = true; delete dirs[a]; return; }
        throw enoent(a, 'rename');
      },
      unlinkSync: function (p) { p = pathm.normalize(p); if (!files.delete(p)) throw enoent(p, 'unlink'); deleted.add(p); },
      rmdirSync: function (p) { removeTree(p); },
      rmSync: function (p, _o) { removeTree(p); },
      chmodSync: function () { /* 内存树没有权限位 */ },
      createReadStream: function () { throw new Error('安卓离线模式用不到 createReadStream（静态站不在这里）'); },
      promises: {
        rm: function (p, _o) { removeTree(pathm.normalize(p)); return Promise.resolve(); },
        writeFile: function (p, data) { fs.writeFileSync(p, data); return Promise.resolve(); }
      }
    };
    return { fs: fs, hydrate: hydrate, flush: flush };
  }

  /* ================================================================ Node 内置桩 */
  function createProcessStub(env) {
    return {
      env: env || {}, platform: 'browser', version: 'v18.0.0', argv: [],
      on: function () { }, off: function () { }, once: function () { },
      exit: function () { /* 离线状态机没有进程可退：no-op（只有 shutdown() 会调它） */ },
      nextTick: function (fn) { Promise.resolve().then(fn); },
      cwd: function () { return '/'; }
    };
  }

  function createHttpStub() {
    function createServer() {
      return {
        on: function () { return this; }, once: function () { return this; },
        listen: function (a, b, c) {
          var cb = typeof a === 'function' ? a : (typeof b === 'function' ? b : c);
          if (cb) cb();
          return this;
        },
        close: function (cb) { if (cb) cb(); return this; },
        address: function () { return { port: 0, address: '127.0.0.1', family: 'IPv4' }; }
      };
    }
    return { createServer: createServer, get: function () { throw new Error('安卓离线模式不联网'); } };
  }

  function createOsStub() {
    return {
      networkInterfaces: function () { return {}; },   // lanUrls() 拿到空表，安静
      platform: function () { return 'android'; }, release: function () { return ''; },
      tmpdir: function () { return '/tmp'; }, hostname: function () { return 'localhost'; },
      EOL: '\n', cpus: function () { return []; },
      freemem: function () { return 0; }, totalmem: function () { return 0; }, uptime: function () { return 0; }
    };
  }

  function createWsStub() {
    // 只会在 listen() → createWss() 里被 new：离线模式永远走不到，桩成什么样都无所谓
    function WebSocketServer() { this.clients = new Set(); }
    WebSocketServer.prototype.on = function () { return this; };
    WebSocketServer.prototype.close = function () { };
    return { WebSocketServer: WebSocketServer };
  }

  /* ================================================================ 加载器
   * local-core 的源码先按 manifest 全量预取（浏览器没有同步 require，
   * 但文件清单是死的），之后 require 就完全是同步语义 —— 和 Node 一致。
   */
  function createLoader(opts) {
    var pathm = opts.path;
    var sources = new Map();       // '/local-core/xxx.js' -> 源码
    var cache = new Map();         // path -> module（先入缓存再执行：容忍循环依赖，Node 同款）
    var builtins = opts.builtins;

    function resolveName(baseDir, name) {
      if (/^\.{1,2}\//.test(name)) {
        var p = pathm.normalize(baseDir + '/' + name);
        if (!/\.js$/i.test(p)) p += '.js';
        return { file: p };
      }
      if (builtins[name]) return { builtin: name };
      throw new Error('[chahu-shim] 不认识的模块：' + name + '（local-core 只依赖内置模块和相对路径）');
    }

    function requireFrom(baseDir) {
      var req = function (name) {
        var r = resolveName(baseDir, name);
        if (r.builtin) return builtins[name];
        var p = r.file;
        if (cache.has(p)) return cache.get(p).exports;
        var src = sources.get(p);
        if (src == null) throw new Error('[chahu-shim] local-core 缺文件：' + p + '（先跑 tools/sync-android-core.js）');
        var module = { exports: {} };
        cache.set(p, module);
        var fn = new Function('require', 'module', 'exports', '__filename', '__dirname',
          src + '\n//# sourceURL=' + p);
        fn(req, module, module.exports, p, pathm.dirname(p));
        return module.exports;
      };
      req.main = null;   // `require.main === module` 永远不成立 → listen() 不会被自动调用
      return req;
    }

    return {
      requireModule: function (baseDir, name) { return requireFrom(baseDir)(name); },
      addSource: function (p, src) { sources.set(p, src); },
      hasSource: function (p) { return sources.has(p); }
    };
  }

  /* ================================================================ 离线会话
   * client/local-host.js 的 LocalWs 浏览器版：接口一模一样
   * （readyState/send/feed/close/on/emit），服务端 onClient() 感知不到差别。
   */
  function LocalWs(toClient) {
    this.readyState = 1;
    this.OPEN = 1;
    this.CLOSED = 3;
    this._toClient = typeof toClient === 'function' ? toClient : function () { };
    this._handlers = { message: [], close: [], error: [], pong: [] };
    this._connId = null;
    this._roomId = null;
    this._userId = null;
    this._alive = true;
  }
  LocalWs.prototype.on = function (name, fn) {
    (this._handlers[name] || (this._handlers[name] = [])).push(fn);
    return this;
  };
  LocalWs.prototype.emit = function (name, arg) {
    var l = this._handlers[name] || [];
    for (var i = 0; i < l.length; i++) {
      try { l[i](arg); } catch (e) { console.error('[local] ' + name + ' 回调出错：' + e.message); }
    }
  };
  LocalWs.prototype.send = function (raw) {
    if (this.readyState !== 1) return;
    try { this._toClient(String(raw)); } catch (e) { /* 渲染层可能已经关了，丢掉就好 */ }
  };
  LocalWs.prototype.feed = function (raw) { this.emit('message', raw); };
  LocalWs.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  };
  LocalWs.prototype.terminate = function () { this.close(); };
  LocalWs.prototype.ping = function () { /* 离线客户端不参与心跳 */ };

  /* ================================================================ 组装（激活路径） */

  // 手机用户几天不打开很正常：房间永不被 sweeper / gc 清掉（想删手动删）
  var CORE_ENV = {
    CHAHU_EMBEDDED: '1',
    PORT: '8437',
    HOST: '127.0.0.1',
    DATA_DIR: '/data/rooms',
    PUBLIC_DIR: '/data/public',
    IDLE_ROOM_TTL: String(10 * 365 * 24 * 3600 * 1000),
    EMPTY_ROOM_TTL: String(10 * 365 * 24 * 3600 * 1000),
    PUBLIC_URL_TTL: String(12 * 3600 * 1000)
  };

  function assembleCore(parts) {
    // parts: { Buffer, path, fsBundle: {fs, hydrate, flush}, fetchText, indexedDB? }
    var builtins = {
      fs: parts.fsBundle.fs,
      path: parts.path,
      http: createHttpStub(),
      os: createOsStub(),
      ws: createWsStub()
    };
    var loader = createLoader({ path: parts.path, builtins: builtins });
    return {
      loader: loader,
      boot: function () {
        return parts.fsBundle.hydrate().then(function () {
          return parts.fetchText('local-core/manifest.json').then(function (txt) {
            var names = [];
            try { names = JSON.parse(txt); } catch (e) { throw new Error('manifest.json 坏了：' + e.message); }
            var ps = [];
            for (var i = 0; i < names.length; i++) {
              (function (nm) {
                ps.push(parts.fetchText('local-core/' + nm).then(function (src) {
                  loader.addSource('/local-core/' + nm, src);
                }));
              })(names[i]);
            }
            return Promise.all(ps);
          });
        }).then(function () {
          return loader.requireModule('/local-core', './index.js');
        });
      }
    };
  }

  /* ================================================================ 激活 */

  function activate() {
    var Buffer = createBufferPolyfill();
    var pathm = createPathPolyfill();
    var fsBundle = createBrowserFs({ Buffer: Buffer, path: pathm, indexedDB: global.indexedDB });
    var Cap = global.Capacitor;
    var CapPlugins = (Cap && Cap.Plugins) || {};

    // WebView 没有 process / setImmediate，状态机源码里都用得到
    if (!global.process) global.process = createProcessStub(CORE_ENV);
    else global.process.env = Object.assign({}, global.process.env || {}, CORE_ENV);
    global.setImmediate = global.setImmediate || function (fn) { return setTimeout(fn, 0); };
    global.Buffer = global.Buffer || Buffer;

    // 状态机要的两个根目录先建好（custom-themes 要 /data，RoomStore 要 /data/rooms）
    fsBundle.fs.mkdirSync('/data/rooms', { recursive: true });
    fsBundle.fs.mkdirSync('/data/public', { recursive: true });

    var core = assembleCore({
      Buffer: Buffer,
      path: pathm,
      fsBundle: fsBundle,
      fetchText: function (url) {
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
          return r.text();
        });
      }
    });

    /* ---------- 离线会话（与桌面端 client/main.js 的 localSession 同构） */
    var session = null;
    var localSink = null;   // net.js 通过 onLocalMessage 登记的收包口

    function openLocalSession() {
      return core.boot().then(function (server) {
        if (session) return { ok: true, connId: session.connId, reused: true };
        var ws = new LocalWs(function (raw) {
          if (localSink) { try { localSink(raw); } catch (e) { /* 渲染层的问题不甩给状态机 */ } }
        });
        server.onClient(ws);
        session = { ws: ws, connId: ws._connId };
        console.log('[chahu-shim] 离线会话 ' + session.connId + '（WebView 内嵌状态机，不占端口）');
        return { ok: true, connId: session.connId, reused: false };
      }).catch(function (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      });
    }

    /* ---------- chahuDesktop 安卓实现 */
    global.chahuDesktop = {
      isDesktop: true,
      isAndroid: true,

      getInfo: function () {
        var cfg = global.CHAHU_CONFIG || {};
        return Promise.resolve({
          version: cfg.appVersion || '0.0.0',
          platform: 'android',
          config: { server: (function () { try { return localStorage.getItem('chahu.server') || ''; } catch (e) { return ''; } })() },
          server: null
        });
      },

      /** 记住服务器地址。渲染端网页版的 ChaConfig.remember 就是 localStorage，这里保持同一种存储 */
      setServer: function (url) {
        return Promise.resolve().then(function () {
          var norm = (global.ChaConfig && global.ChaConfig.normalize) ? global.ChaConfig.normalize(url) : String(url || '');
          try {
            if (norm) localStorage.setItem('chahu.server', norm);
            else localStorage.removeItem('chahu.server');
          } catch (e) { /* 存不进就算了 */ }
          return { ok: true };
        });
      },

      /**
       * 导出（PNG/JPEG/WebM/.chahu 工程）：写进应用缓存目录，再唤起系统分享表。
       * WebView 里 <a download> 是静默失败的（没有 DownloadListener），必须走插件。
       * 用户取消分享表算 canceled —— 文件其实还躺在缓存里，不报错吓人。
       */
      saveFile: function (name, payload) {
        return Promise.resolve().then(function () {
          var CapFs = CapPlugins.Filessystem || CapPlugins.Filesystem;
          var CapShare = CapPlugins.Share;
          if (!CapFs || !CapShare) throw new Error('Capacitor 插件没就位（Filesystem/Share）');
          var fname = String(name || 'chahu-export').replace(/[\\/:*?"<>|]+/g, '_');
          var b64 = null;
          if (typeof payload === 'string' && /^data:[^;]*;base64,/.test(payload)) {
            b64 = payload.slice(payload.indexOf(',') + 1);
          } else if (payload instanceof Uint8Array) {
            b64 = Buffer._bytesToB64(payload);
          } else if (payload && payload._u8) {
            b64 = Buffer._bytesToB64(payload._u8);
          } else if (typeof payload === 'string') {
            b64 = Buffer.from(payload).toString('base64');
          } else {
            throw new Error('不支持的数据格式');
          }
          return CapFs.writeFile({ path: fname, data: b64, directory: 'CACHE', recursive: true })
            .then(function () { return CapFs.getUri({ path: fname, directory: 'CACHE' }); })
            .then(function (r) {
              return CapShare.share({ title: fname, text: fname, url: r && r.uri, dialogTitle: '保存 / 分享' });
            })
            .then(function () { return { ok: true, path: fname }; });
        }).catch(function (e) {
          var msg = (e && (e.message || e.code)) || String(e);
          if (/cancel|abort|dismiss/i.test(String(msg))) return { canceled: true };
          return { ok: false, error: msg };
        });
      },

      /* 离线四件套：net.js 的 connectLocal() 就认这几个名字，一个字都不用改 */
      localOpen: function () { return openLocalSession(); },
      localFeed: function (raw) {
        if (!session) return Promise.resolve(false);
        try { session.ws.feed(String(raw || '')); return Promise.resolve(true); }
        catch (e) { return Promise.resolve(false); }
      },
      localClose: function () {
        if (!session) return Promise.resolve(false);
        try { session.ws.close(); } catch (e) { /* ignore */ }
        session = null;
        return Promise.resolve(true);
      },
      onLocalMessage: function (cb) {
        localSink = function (raw) { try { cb(raw); } catch (e) { /* ignore */ } };
        return function () { localSink = null; };
      }
    };

    // 切后台 / 关页前把没落盘的存档抢一把（IndexedDB 是异步的，尽力而为）
    global.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') fsBundle.flush();
    });
    global.addEventListener('pagehide', function () { fsBundle.flush(); });
  }

  if (isNative && !global.chahuDesktop) {
    activate();
  } else if (typeof module === 'object' && module.exports && !isNative) {
    // Node 测试模式（tools/test-android-shim.js）：不激活，只给零件
    module.exports = {
      createBufferPolyfill: createBufferPolyfill,
      createPathPolyfill: createPathPolyfill,
      createBrowserFs: createBrowserFs,
      createProcessStub: createProcessStub,
      createHttpStub: createHttpStub,
      createOsStub: createOsStub,
      createWsStub: createWsStub,
      createLoader: createLoader,
      LocalWs: LocalWs,
      CORE_ENV: CORE_ENV,
      assembleCore: assembleCore
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
