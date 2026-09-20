'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const P = require('./protocol');
const { RoomStore } = require('./rooms');
const { Game, PHASE, CFG: GAME_CFG } = require('./game');
const { ChainGame, CHAIN_PHASE, CHAIN_PHASE_LABEL, CFG: CHAIN_CFG } = require('./chain');
const { SkinGame, SKIN_PHASE, SKIN_PHASE_LABEL, ROLE_INFO, CAMP, CFG: SKIN_CFG } = require('./skin');
const PREFS = require('./game-prefs');
const THEMES = require('./themes');
const WORDS = require('./words');

const PORT = parseInt(process.env.PORT || '8437', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 桌面端内置这个服务端时，静态目录要指向 app 里的 renderer 而不是 server/public
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(__dirname, '..', 'public');
// 被桌面端 require 进来当内置服务器时置 1：出错不要直接结束进程
const EMBEDDED = process.env.CHAHU_EMBEDDED === '1';
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data', 'rooms');
const IDLE_ROOM_TTL = parseInt(process.env.IDLE_ROOM_TTL || String(12 * 3600 * 1000), 10);
// 空房（没人在线且没有任何内容）的宽限期。以前是 30 分钟、而且扫描间隔 10 分钟，
// 于是随手建的探路房间会在列表里堆一大片。现在 5 分钟 + 30 秒扫一次。
const EMPTY_ROOM_TTL = parseInt(process.env.EMPTY_ROOM_TTL || String(5 * 60 * 1000), 10);
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '400', 10);
const MAX_MEMBERS_PER_ROOM = parseInt(process.env.MAX_MEMBERS || '40', 10);
const MAX_LAYERS = parseInt(process.env.MAX_LAYERS || '16', 10);

const store = new RoomStore(DATA_DIR);

/* --------------------------------------------------- 对外地址（局域网 / 公网隧道） */

const DATA_ROOT = path.dirname(DATA_DIR);           // server/data
const PUBLIC_URL_FILE = path.join(DATA_ROOT, 'public-url.txt');
// 隧道文件太旧就当它已经失效（cloudflared 快速隧道的域名是临时的）
const PUBLIC_URL_TTL = parseInt(process.env.PUBLIC_URL_TTL || String(12 * 3600 * 1000), 10);

/**
 * 公网入口地址。由 tools/expose.js 启动隧道时写入 server/data/public-url.txt，
 * 这里每次都现读 —— 隧道起来/关掉都不需要重启服务端。
 */
function currentPublicUrl() {
  try {
    if (!fs.existsSync(PUBLIC_URL_FILE)) return '';
    const st = fs.statSync(PUBLIC_URL_FILE);
    if (Date.now() - st.mtimeMs > PUBLIC_URL_TTL) return '';
    const line = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').split('\n')[0].trim();
    return /^https?:\/\/[^\s]+$/i.test(line) ? line.replace(/\/+$/, '') : '';
  } catch (e) { return ''; }
}

/** 本机的局域网地址，供「同一 WiFi 的朋友」直接打开 */
function lanUrls() {
  const out = [];
  try {
    const nets = os.networkInterfaces();
    for (const k of Object.keys(nets)) {
      for (const n of nets[k] || []) {
        if (n.family === 'IPv4' && !n.internal) out.push('http://' + n.address + ':' + PORT);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

/* ------------------------------------------------------------------ 静态站点 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  const url = parseReqUrl(req);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self' http: https: ws: wss:"
      ].join('; ');
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 安全地解析请求 URL。
 *
 * 为什么不能直接 `new URL(req.url, 'http://localhost')`：
 * Node 的 HTTP 解析器对「请求行」相当宽松，`GET // HTTP/1.1` 这种
 * 请求目标是合法收下的，但 `new URL('//', base)` 会抛 `ERR_INVALID_URL`。
 * 这个抛在请求处理器顶层且没被 catch —— 一个畸形请求就能把整个服务端
 * 进程带走（实测：一条 `//` 请求让 112 个房间的服务原地退出）。
 * 外壳/扫描器/手滑的客户端都可能造出这种 URL，不能靠「没人会这么发」兜底。
 * 解析失败就退化成根路径，让后续逻辑当成普通 404 处理。
 */
function parseReqUrl(req) {
  try {
    return new URL(req.url, 'http://localhost');
  } catch (e) {
    return new URL('http://localhost/');
  }
}

const server = http.createServer((req, res) => {
  const url = parseReqUrl(req);
  // pid / 协议版本一并给：监控和自动化测试靠它判断「端口上挂着的还是不是我起的那一个」
  // （旧进程残留会静默顶替，光看 200 分辨不出来）。/api/share 也有，两处保持一致。
  // 服务端没有「应用版本」这个概念（那是 client 的 package.json），
  // 这里报协议版本 —— 它才是服务端真正对外承诺的东西。
  if (url.pathname === '/health') return json(res, 200, {
    ok: true,
    rooms: store.rooms.size,
    uptime: process.uptime(),
    pid: process.pid,
    protocolVersion: P.PROTOCOL_VERSION
  });
  if (url.pathname === '/api/rooms') return json(res, 200, { rooms: store.list() });
  // 自定义主题词库的增删改查（配置类，见下方 handleThemesApi）
  if (url.pathname === '/api/themes' || url.pathname.indexOf('/api/themes/') === 0) {
    return handleThemesApi(req, res, url);
  }
  // 附带「这台服务端到底是什么配置」——自动化测试靠它判断端口上挂着的
  // 是不是自己刚起的那个进程（旧进程残留会静默顶替，测试就白跑了）。
  if (url.pathname === '/api/share') return json(res, 200, {
    publicUrl: currentPublicUrl(),
    lanUrls: lanUrls(),
    pid: process.pid,
    // GAME_FAST=1 时三套 CFG 的阶段时长默认值全被压成 1000ms。
    // 自动化测试**必须**靠这个字段判断「端口上挂的是不是那台一秒一阶段的进程」——
    // 光看端口通不通分不出旧进程残留（那会跑出一片假绿）。
    fast: PREFS.isGameFast(),
    game: { PICK_MS: GAME_CFG.PICK_MS, ROUND_MS: GAME_CFG.ROUND_MS, ROUND_END_MS: GAME_CFG.ROUND_END_MS },
    chain: {
      INIT_MS: CHAIN_CFG.INIT_MS, WRITE_MS: CHAIN_CFG.WRITE_MS, DRAW_MS: CHAIN_CFG.DRAW_MS,
      GUESS_MS: CHAIN_CFG.GUESS_MS, REVEAL_MS: CHAIN_CFG.REVEAL_MS, VOTE_MS: CHAIN_CFG.VOTE_MS,
      SCORE_MS: CHAIN_CFG.SCORE_MS,
      // CHAIN_SCORE_MS 是「按链串行投票时，每条链的小结算展示时长」——
      // 忘了报它的话，测试没法判断端口上那台是不是自己配的那份计时。
      CHAIN_SCORE_MS: CHAIN_CFG.CHAIN_SCORE_MS,
      GRACE_MS: CHAIN_CFG.GRACE_MS,
      // 回放**每一格**定格时长的地板（v11）：真实每格时长 = max(它, REVEAL_MS / 链长)，
      // 链长每局都不一样（默认 2×人数），所以这里只能报这个地板。
      REVEAL_LEG_MS_MIN: P.GAME.CHAIN_REVEAL_LEG_MS_MIN
    },
    // 画皮的计时同理：自动化测试靠这几个值判断「端口上挂的是不是压缩计时的那个进程」。
    // 少了这一段，画皮 E2E 就只能盲跑，旧进程残留时会跑出一片假绿。
    skin: {
      NIGHT_MS: SKIN_CFG.NIGHT_MS,
      DAWN_MS: SKIN_CFG.DAWN_MS,
      DRAW_MS: SKIN_CFG.DRAW_MS,
      TALK_MS: SKIN_CFG.TALK_MS,
      VOTE_MS: SKIN_CFG.VOTE_MS,
      VOTE_END_MS: SKIN_CFG.VOTE_END_MS,
      WITCH_GRACE_MS: SKIN_CFG.WITCH_GRACE_MS
    },
    words: WORDS.length,
    customWords: WORDS.isCustom(),          // CHAHU_WORDS 是否生效（测试的「身份」判据之一）
    // 开局设置面板的档位（秒数 / 人数上下限 / 换词次数 / 回合档位）。
    // 全部从 protocol 的常量推出来（见 game-prefs.js 的 setupOptions），
    // 前端照着它渲染下拉框即可 —— 别在客户端再抄一份数字。
    setup: PREFS.setupOptions(),
    // 主题词库：给前端拿来填「接龙主题」下拉（含可读名），也给测试当身份判据。
    // 只给 id / name / 词数 —— 一个词都不下发，免得提前泄题。
    themes: THEMES.themeList().map(t => t.id),
    themeList: THEMES.themeList(),
    customThemes: THEMES.custom.list().length,     // 自定义词库套数（测试身份判据）
    themesSig: THEMES.custom.signature()           // 自定义词库指纹
  });
  if (!fs.existsSync(PUBLIC_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('茶绘服务端运行中（端口 ' + PORT + '）。桌面客户端可直接连接 /ws。');
  }
  serveStatic(req, res);
});

/* ------------------------------------------------------------------ 自定义主题词库 API
 *
 * 为什么不走 WebSocket 协议：这是**配置类**操作（建/改/删词库），
 * 不是实时房间状态。塞进 C2S 只会让协议表多出四条一辈子用一次的指令。
 * 而且词库是全局的（不分房间）—— 用 HTTP 表达「全局资源」更自然。
 *
 * 权限：谁都能建（局域网/自建服务器的场景下，使用者本来就是熟人）；
 * 上限靠 MAX_THEMES 兜住。
 */

function readBody(req, cb) {
  let raw = '';
  let tooBig = false;
  req.on('data', d => {
    raw += d;
    if (raw.length > 64 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return cb({ error: '内容太大了' });
    try { cb({ data: raw ? JSON.parse(raw) : {} }); }
    catch (e) { cb({ error: '数据格式不对' }); }
  });
  req.on('error', () => cb({ error: '读取失败' }));
}

/** 词库变了要把新的菜单推给所有在场的人（下拉框里立刻能选到） */
function broadcastThemes() {
  const raw = JSON.stringify({ t: P.S2C.GAME_THEMES, themes: THEMES.themeList() });
  for (const room of store.rooms.values()) {
    for (const m of room.members.values()) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(raw);
    }
  }
}

function handleThemesApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // ['api','themes', id?]
  const id = parts[2] || '';
  const method = req.method.toUpperCase();

  // GET /api/themes/<id>/words —— 取某套自定义词库的完整词表（「编辑」时要回填）
  // ⚠️ 只能取**自定义**的：内置主题的词绝不能下发（F12 一看游戏就废了）。
  if (method === 'GET' && id && parts[3] === 'words') {
    const words = THEMES.custom.wordsOf(id);
    if (!words) return json(res, 404, { ok: false, message: '没有这套自定义词库' });
    return json(res, 200, { ok: true, id, name: THEMES.custom.nameOf(id), words });
  }

  // GET /api/themes —— 列出全部（自带的 + 自定义）
  if (method === 'GET') {
    return json(res, 200, {
      themes: THEMES.themeList(),
      custom: THEMES.custom.list(),
      minWords: THEMES.custom.MIN_WORDS,
      maxThemes: THEMES.custom.MAX_THEMES,
      maxNameLen: THEMES.custom.MAX_NAME_LEN
    });
  }

  // POST /api/themes —— 新建
  if (method === 'POST') {
    return readBody(req, ({ data, error }) => {
      if (error) return json(res, 400, { ok: false, message: error });
      const r = THEMES.custom.create(data && data.name, data && data.words);
      if (!r.ok) return json(res, 400, r);
      broadcastThemes();
      json(res, 200, r);
    });
  }

  // PUT /api/themes/<id> —— 改名 / 改词
  if (method === 'PUT') {
    if (!id) return json(res, 400, { ok: false, message: '缺少 id' });
    return readBody(req, ({ data, error }) => {
      if (error) return json(res, 400, { ok: false, message: error });
      const r = THEMES.custom.update(id, data && data.name, data && data.words);
      if (!r.ok) return json(res, 400, r);
      broadcastThemes();
      json(res, 200, r);
    });
  }

  // DELETE /api/themes/<id>
  if (method === 'DELETE') {
    if (!id) return json(res, 400, { ok: false, message: '缺少 id' });
    // 内置主题删不得（它们是代码里的常量）
    if (!THEMES.custom.has(id)) return json(res, 400, { ok: false, message: '只能删自定义词库' });
    const r = THEMES.custom.remove(id);
    if (!r.ok) return json(res, 400, r);
    broadcastThemes();
    return json(res, 200, r);
  }

  json(res, 405, { ok: false, message: '不支持的方法' });
}

/* ------------------------------------------------------------------ WebSocket */

/**
 * WebSocket 服务端**每次 listen 都重新建一个**。
 *
 * 为什么不复用同一个实例：`wss.close()` 之后它就是终态了（内部 state 置 CLOSED、
 * 升级监听也摘掉了），再 listen 会连不上 —— 而「关服务器」再「开服务器」正好会走到这条路。
 * 重建一次成本极低，换来的是开关可以来回点。
 */
let wss = null;
const NO_CLIENTS = new Set();

function createWss() {
  const s = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 12 * 1024 * 1024,
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } }
  });
  s.on('connection', (ws) => onClient(ws));
  return s;
}

/**
 * 当前连着的客户端。服务器没监听时是空的。
 * 离线模式（桌面端关闭服务器后）那个不走 socket 的客户端**刻意不在这个集合里**：
 * 心跳会 ping 它、而它没有 pong，两轮之后就会被 terminate 掉。
 */
function liveClients() { return wss ? wss.clients : NO_CLIENTS; }

let connSeq = 0;
const colorCursor = { i: 0 };

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(Object.assign({ t: type }, payload || {})));
}

function roomBroadcast(room, type, payload, exceptId) {
  const raw = JSON.stringify(Object.assign({ t: type }, payload || {}));
  for (const m of room.members.values()) {
    if (m.connId === exceptId) continue;
    if (m.ws.readyState === m.ws.OPEN) m.ws.send(raw);
  }
}

/** 只发给房间里的某一个人（找不到人就算了） */
function sendToUser(room, userId, type, payload) {
  const raw = JSON.stringify(Object.assign({ t: type }, payload || {}));
  for (const m of room.members.values()) {
    if (m.userId !== userId) continue;
    if (m.ws.readyState === m.ws.OPEN) m.ws.send(raw);
    return;
  }
}

/* ------------------------------------------------------------------ 私密作画
 *
 * 接龙的「作画」这一步是**并行多条链**：一圈里可能有好几个人同时要画，
 * 而且画的还是不同的链。可房间只有一块画布 —— 如果照常广播，结果就是
 *   ① 大家能实时看见别人正在画什么（下一位猜词的人等于提前拿到答案，链条永远不跑偏）
 *   ② 每个人的 exportPNG 导出的是**所有人叠在一起的画面**，交上去的作品全是同一张
 * 两条都足以把玩法毁掉。
 *
 * 所以作画这一步的笔迹**只回给作者本人**：服务端照旧存进房间笔迹（这样作者掉线重连
 * 能把画找回来），但不发给别人；重连 / 中途进房时也只把这**自己的**那几笔发过去。
 * 步骤首尾的 resetCanvas() 会把画布清干净，所以私有笔迹不会活到下一步。
 *
 * ⚠ 新增「会带笔迹像素出去」的消息时，**必须**用 strokeBroadcast() 而不是 roomBroadcast()，
 * 否则就是在私密作画期间把它泄给全场。
 */
function privateDrawOn(room) {
  const g = room && room.game;
  if (!g) return false;
  if (g.mode === 'chain' && g.phase === CHAIN_PHASE.DRAW) return true;
  // 画皮：天亮后大家画同一主题，但**各自私密画** —— 交稿之前谁都不该看见别人的画，
  // 否则「看画猜作者」这个玩法在第一笔落下去的时候就没了。
  // 展示阶段（DAY_TALK 起）画布是干净的（beginTalk 前已经交完了），
  // 笔迹不出现在画布上，所以不在这里放行 —— 展示靠 SKIN_GALLERY 里的 PNG。
  if (g.mode === 'skin' && g.phase === SKIN_PHASE.DAY_DRAW) return true;
  return false;
}

/** 笔迹类广播的统一出口：私密作画期间**谁都不发** */
function strokeBroadcast(room, type, payload, exceptId) {
  if (privateDrawOn(room)) return;
  roomBroadcast(room, type, payload, exceptId);
}

/**
 * 私密作画这一步**不能动图层结构或画布尺寸**。
 *
 * 这一步大家共用同一块画布、只是互相看不见，所以这些操作会直接把「我这张画」
 * 漏出去或者把别人正在画的东西一起抹掉：
 *   · LAYER_PIXELS / LAYER_DUP / LAYER_MERGE / LAYER_FLATTEN / ROOM_COMPRESS
 *     全都带 `baseImages` 广播 —— 整张图层 PNG 发给全场，下一位猜词的人等于直接拿到答案；
 *   · LAYER_CLEAR / ROOM_RESIZE 会把别人正在画的私密内容一起清掉。
 * 它们在这一步本来也没有正当用法，一律拒绝。
 *
 * 只管作画这一步：其余阶段 lockedFor() 已经是「一律锁笔」，writeBlocked() 自己就挡住了，
 * 这里补的是作画阶段「全员解锁」留下的那个缺口。
 */
function privateDrawLocked(ws, room, member) {
  if (!member || !privateDrawOn(room)) return false;
  send(ws, P.S2C.ERROR, {
    code: 'game_private',
    message: '作画这一步不能改图层结构或画布尺寸 —— 交了这张画再说'
  });
  return true;
}

/** 游戏进行中一律不许装载工程：它是整份文档替换，局里画的东西会全没 */
function gameBusy(ws, room, member) {
  // ⚠ 结束游戏之后 room.game 这个对象**还在**，只是 phase 变回了 'off'
  //（三个玩法的 PHASE.OFF 都是字符串 'off'）。所以不能只看「有没有 game」——
  // 那样一局打完就再也装不了工程了，闸门等于关死。
  const g = room && room.game;
  if (!member || !g || !g.phase || g.phase === 'off') return false;
  send(ws, P.S2C.ERROR, {
    code: 'game_busy',
    message: '游戏进行中不能装载工程 —— 先点「结束游戏」'
  });
  return true;
}

/** 某人此刻**能看到的**历史笔迹（私密作画期间只有他自己画的那几笔） */
function strokesFor(room, userId) {
  if (!privateDrawOn(room)) return room.strokes;
  return room.strokes.filter(s => s.userId === userId);
}

function sanitizeName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return t || fallback;
}

function sanitizeText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}

function historyChunks(room, userId) {
  const src = strokesFor(room, userId);
  const chunks = [];
  for (let i = 0; i < src.length; i += P.HISTORY_CHUNK_SIZE) {
    chunks.push(src.slice(i, i + P.HISTORY_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * 图层变更广播；baseImages 只在像素真的变了（复制/合并/固化）时才附带，避免无谓的大包。
 *
 * **组表永远和图层表一起发**：组的「位置」就是它那一块图层的位置，
 * 只发其中一个的话，客户端会拿新图层配旧组表，合成出来的东西和谁都不一样。
 * 组表本身很小（最多十几条、没有像素），不值得为它省这个包。
 */
function broadcastLayers(room, baseImages, maskImages) {
  const payload = { layers: room.layerList(), groups: room.groupList() };
  if (baseImages && Object.keys(baseImages).length) payload.baseImages = baseImages;
  if (maskImages && Object.keys(maskImages).length) payload.maskImages = maskImages;
  roomBroadcast(room, P.S2C.LAYERS, payload);
}

/* ------------------------------------------------------------------ 你画我猜 / 接龙 */

/** 两种玩法的注册表。**加新玩法只需要在这里添一行**，其余接线全是通用的 */
const GAME_MODES = {
  classic: { Cls: Game, phases: PHASE, label: '你画我猜' },
  chain: { Cls: ChainGame, phases: CHAIN_PHASE, label: '接龙' },
  skin: { Cls: SkinGame, phases: SKIN_PHASE, label: '画皮' }
};

function modeDef(mode) { return GAME_MODES[mode] || GAME_MODES.classic; }
function modeOf(room) { return (room && room.game && room.game.mode) || 'classic'; }

/**
 * 取房间的游戏状态机（首次访问时挂上去；状态不落盘，重启即结束）。
 *
 * 一个房间同时只跑一种玩法 —— 房间上只挂一个 `room.game`。
 * 想换玩法必须先把旧的停掉（GAME_START 里统一走 startGameOf 处理这件事）。
 */
function gameOf(room, mode) {
  if (!room) return null;
  const want = GAME_MODES[mode] ? mode : 'classic';
  // 已经在跑同一种玩法 → 直接复用（保留分数、局数）
  if (room.game && room.game.mode === want) return room.game;
  // 在跑另一种玩法 → 只有它已经停了才允许换（在跑的局不能被人一脚踢掉）
  if (room.game && room.game.active) return room.game;
  const def = GAME_MODES[want];
  const g = new def.Cls(room, makeGameApi(room));
  // 包一层生命周期：游戏终局（房主停止 / 整局打完）时把开局前的画还回去。
  // start() 内部不会调 stop/finish（已核对两个玩法），不会误触发。
  for (const m of ['stop', 'finish']) {
    if (typeof g[m] !== 'function') continue;
    const orig = g[m];
    g[m] = function () {
      const r = orig.apply(g, arguments);
      restoreArtwork(room);
      return r;
    };
  }
  room.game = g;
  return g;
}

/**
 * 开一局指定玩法。三种玩法的 start() 都收同一套 opts（按 mode 取用，见 shared/protocol.js
 * 的 C2S.GAME_START 字段表）：
 *   theme            主题词库 id（'' = 通用词库）
 *   drawSeconds      作画时限（秒，可省略 = 全局默认；限 30~300）
 *   rounds           轮数（classic / skin）
 *   repickLimit      每回合「换一组」的次数（classic）
 *   roundEndSeconds  回合结算展示时长（classic）
 *   chainLength      每条链几手（chain）
 *   writeSeconds / guessSeconds / revealSeconds / voteSeconds   （chain）
 *   nightSeconds / dawnSeconds / talkSeconds / voteSeconds      （skin）
 *
 * ⚠ **白名单必须跟着协议走**：漏一个字段 = 「前端发了、服务端收下、start() 永远拿不到」，
 *   表现是下拉框选了没反应，而且不报错。白名单只有一份，在 game-prefs.js 的 pickStartOpts 里
 *   （tools/test-game-setup.js 直接测那个函数，所以这里不会再漏）。
 *   夹取仍由各自的 start() 负责 —— 这里**故意不夹**，`undefined` 原样透传，
 *   老客户端不发新字段时行为与 v9 完全一致。
 */
function startGameOf(room, mode, opts) {
  const g = gameOf(room, mode);
  if (!g || g.mode !== mode) {
    const running = room.game;
    const label = running && GAME_MODES[running.mode] ? GAME_MODES[running.mode].label : '另一局游戏';
    return { ok: false, code: 'game_busy', message: '现在正在玩「' + label + '」，先点「结束游戏」再换' };
  }
  const cfg = PREFS.pickStartOpts(opts);
  if (g.mode === 'chain') {
    snapshotArtwork(room);
    return g.start(cfg);
  }
  snapshotArtwork(room);
  return g.start(cfg);
}

function makeGameApi(room) {
  return {
    sync() { syncGame(room); },
    systemChat(text) { gameChat(room, text); },
    resetCanvas() { resetGameCanvas(room); },
    // 回放数据的一次性广播（进回放阶段时发一次；迟到的人由 syncGame 按 version 补发）
    revealAll(chains, version) {
      roomBroadcast(room, P.S2C.GAME_REVEAL, { version: version, chains: chains });
    }
  };
}

/**
 * 把当前游戏状态推给房间里每个人。
 * **逐人发送**（而不是一次广播）的唯一理由是：快照要按收件人裁剪 ——
 * 猜手拿到的版本里 word 必须是空的。词另走一条私有消息，压根不进广播流。
 *
 * 三种玩法共用这条通路：
 *   经典模式 → 额外给画手补一条 GAME_WORD（他丢了状态就画不了）
 *   接龙     → 额外给「这一步有活的人」补一条 GAME_TASK
 *              （写词的候选 / 要画的词 / 要猜的那幅画，都只能给他本人）
 *   画皮     → 额外补两条**身份类**私有消息：SKIN_ROLE（我是谁）与
 *              SKIN_NIGHT（我验到了什么 / 我被刀了）。这两条**绝不能**并进
 *              GAME_STATE —— 那条是广播的，把身份放进去等于全场底牌公开。
 *              每次 sync 都重发是刻意的：重连、中途入局、阶段切换都会 sync，
 *              重发让「第一次拿到手」和「丢了再要一份」走同一条路径，前端不用额外兜底。
 */
function syncGame(room) {
  const g = room.game;
  if (!g) return;
  const isChain = g.mode === 'chain';
  const isSkin = g.mode === 'skin';
  for (const m of room.members.values()) {
    if (m.ws.readyState !== m.ws.OPEN) continue;
    send(m.ws, P.S2C.GAME_STATE, { game: g.snapshotFor(m.userId) });
    if (isChain) {
      // GAME_TASK 只在「做事」的阶段发；回放 / 投票阶段它自然是 null。
      // 猜词那一步的题面带着上家的**笔迹数据**（可能几百 KB），不能每次 sync 都重发 ——
      // 按 taskVersion 判断：换格了才发。重连 / RESYNC 会把 m._chainTaskV 清零，保证补发。
      const task = g.taskFor(m.userId);
      if (task && m._chainTaskV !== g.taskVersion) {
        send(m.ws, P.S2C.GAME_TASK, { task });
        m._chainTaskV = g.taskVersion;
      }
      // 回放数据：version 没对上的补发一份（进回放阶段的广播 + 迟到者的补发共用这一处）
      if (g.revealVersion && m._chainRevealV !== g.revealVersion && g.revealData) {
        send(m.ws, P.S2C.GAME_REVEAL, { version: g.revealVersion, chains: g.revealData });
        m._chainRevealV = g.revealVersion;
      }
    } else if (isSkin) {
      const role = g.roleInfoFor(m.userId);
      if (role) send(m.ws, P.S2C.SKIN_ROLE, role);
      const night = g.nightInfoFor(m.userId);
      if (night) send(m.ws, P.S2C.SKIN_NIGHT, night);
    } else if (g.phase === PHASE.DRAW && m.userId === g.drawerId && g.word) {
      send(m.ws, P.S2C.GAME_WORD, { word: g.word });
    }
  }
  // 画皮：出局身份公开时补一条「真相表」（只在结算阶段，见 revealAll）
  if (isSkin && g.phase === SKIN_PHASE.OVER) {
    const all = g.revealAll();
    if (all) roomBroadcast(room, P.S2C.SKIN_ROLE + ':all', { all });
  }
}

/** 游戏相关的系统播报（进聊天记录，重启后还看得见） */
function gameChat(room, text, onlyUserId) {
  const entry = {
    id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
    text, ts: Date.now(), system: true
  };
  room.addChat(entry);
  store.markDirty(room);
  if (onlyUserId) {
    for (const m of room.members.values()) {
      if (m.userId === onlyUserId) send(m.ws, P.S2C.CHAT, entry);
    }
    return;
  }
  roomBroadcast(room, P.S2C.CHAT, entry);
}

/**
 * 回合之间的「清空画布」。
 *
 * 与房主手动清空（STROKE_CLEAR）的区别：
 *   ① 由服务端发起，不需要房主身份；
 *   ② 必须掐掉所有进行中的笔迹 —— 否则回合结束后才提交的那一笔会落到新回合的画布上；
 *   ③ 推进一次 seq 并把新水位告诉客户端，保证 engine.seq 与 service seq 始终对齐
 *      （水位错位的表现很隐蔽：之后画的笔会被当成「已固化」而跳过，画上去看不见）。
 *
 * 经典模式每个回合都要清；接龙则**只在「作画」这一步的开始/结束**清
 * （写词 / 猜词时画布上放着上家的画当参考，绝不能清掉）。
 */
/**
 * 开局前把玩家的画作拍快照，结束后原样奉还 —— 游戏不再「吃掉」原画。
 *
 * 快照在**每一次开局**时尝试拍，但只在还没有快照时才真正拍：
 * 「人不够退回大厅 → 再开一局」这种暂停续局，画布上是游戏的残局，
 * 真正要保的是**第一次开局前**的那幅画（恢复时机见 restoreArtwork）。
 */
function snapshotArtwork(room) {
  if (room.gameSnap) return;
  const bases = {}, masks = {};
  for (const l of room.layers) {
    if (l.baseImage) bases[l.id] = l.baseImage;
    if (l.maskImage) masks[l.id] = l.maskImage;
  }
  room.gameSnap = {
    strokes: room.strokes.map(s => Object.assign({}, s)),
    bases, masks
  };
}

/**
 * 游戏结束（房主停止 / 整局打完）时恢复开局前的画：
 * 笔迹按新 seq 重放插回，底图 / 蒙版像素原样放回，
 * 然后广播清空 + 重发底图 + 逐人重发历史，让每个客户端把画面换回来。
 */
function restoreArtwork(room) {
  const snap = room.gameSnap;
  if (!snap) return;
  room.gameSnap = null;
  const alive = new Set(room.layers.map(l => l.id));
  room.clear('all');                     // 丢掉游戏期间的内容（含残局底图）
  for (const s of snap.strokes) {
    if (!alive.has(s.layerId)) continue; // 游戏期间被删掉的层，它的笔迹随它去
    room.strokes.push(Object.assign({}, s, { seq: ++room.seq }));
  }
  const bases = {}, masks = {};
  for (const l of room.layers) {
    if (snap.bases[l.id]) { l.baseImage = snap.bases[l.id]; l.baseSeq = room.seq; bases[l.id] = l.baseImage; }
    if (snap.masks[l.id]) { l.maskImage = snap.masks[l.id]; l.maskSeq = room.seq; masks[l.id] = l.maskImage; }
  }
  store.markDirty(room);
  roomBroadcast(room, P.S2C.STROKE_REMOVED, {
    ids: [], reason: 'clear', scope: 'all', by: 'system', removed: true, seq: room.seq
  });
  broadcastLayers(room, bases, masks);
  for (const m of room.members.values()) {
    if (!m.ws || m.ws.readyState !== m.ws.OPEN) continue;
    const chunks = historyChunks(room, m.userId);
    if (!chunks.length) send(m.ws, P.S2C.HISTORY_CHUNK, { strokes: [], done: true });
    else chunks.forEach((c, i) => send(m.ws, P.S2C.HISTORY_CHUNK, { strokes: c, done: i === chunks.length - 1 }));
  }
}

function resetGameCanvas(room) {
  // 接龙模式下，画布上的内容可能是「上家的画」（猜词阶段的参考图）。
  // 那种情况下不能清 —— 但 chain.js 只会在 DRAW 步的首尾调 resetCanvas()，
  // 那两处画布本来就是空的/该清空的，所以这里照常执行即可。
  for (const m of room.members.values()) {
    const st = m.ws && m.ws._activeStroke;
    if (!st) continue;
    m.ws._activeStroke = null;
    m.drawing = false;
    roomBroadcast(room, P.S2C.STROKE_CANCEL, { id: st.id });
  }
  room.clear('all');
  room.seq += 1;
  store.markDirty(room);
  roomBroadcast(room, P.S2C.STROKE_REMOVED, {
    ids: [], reason: 'clear', scope: 'all', by: 'system', removed: true, seq: room.seq
  });
  broadcastLayers(room);
}

/**
 * 写操作总闸：**只读观众**与**游戏进行中的非当事者**，一律挡在服务端。
 *
 * 前端把工具置灰、弹提示，都只是「别让人白点一笔」，不是权限 —— 谁改一下前端就能绕过去。
 * 所以每一处「改画布」的消息都要先过这里（落笔另有 canDraw，见 STROKE_BEGIN）。
 */
function writeBlocked(ws, room, member) {
  if (!member) return false;
  if (member.readonly) {
    send(ws, P.S2C.ERROR, { code: 'readonly', message: '你现在是观众，只能看着 —— 想画让房主取消' });
    return true;
  }
  if (!room || !room.game) return false;
  if (!room.game.lockedFor(member.userId)) return false;
  const msg = lockedMsg(room, member.userId);
  send(ws, P.S2C.ERROR, { code: 'game_locked', message: msg });
  return true;
}

/** 「现在为什么不能动笔」—— 按玩法给不同的话，别让画皮玩家读一句接龙的提示 */
function lockedMsg(room, userId) {
  const g = room.game;
  if (g.mode === 'chain') return '接龙这一步轮不到你动笔';
  if (g.mode === 'skin') {
    if (g.phase === SKIN_PHASE.DAY_DRAW) return '你已经出局了，只能看着别人画';
    if (g.phase === SKIN_PHASE.NIGHT) return '夜里不能画画 —— 等天亮';
    return '画皮正在进行，现在是看画和投票的时候';
  }
  return '这一回合只有画手能改画布';
}

/**
 * 撤回 / 重做自己的笔迹要不要拦。
 * 画手在「回合结算」阶段（有人猜对 → 立刻进入 round_end）也该能收拾自己刚画的 ——
 * lockedFor 在 round_end 对所有人返回 true，把画手的撤销也挡了（用户实测反馈）。
 * 只放行**经典模式 + 当前（刚结束回合的）画手**：ids 过滤保证只能动自己的笔迹，
 * 接龙不动（每一步的画要原样传下去），选词阶段也不动（画布必须保持干净）。
 */
function undoBlocked(ws, room, member) {
  if (!room || !member || !room.game) return false;
  if (!room.game.lockedFor(member.userId)) return false;
  const g = room.game;
  if (g.mode !== 'chain' && member.userId === g.drawerId && g.phase === 'round_end') return false;
  send(ws, P.S2C.ERROR, { code: 'game_locked', message: lockedMsg(room, member.userId) });
  return true;
}

/** 笔迹的公共字段（笔刷参数全部落库，保证所有客户端渲染结果一致） */
function buildStroke(msg, member, layer) {
  const br = P.normalizeBrush(msg);
  return {
    id: sanitizeText(msg.id, 40),
    layerId: layer.id,
    userId: member.userId,
    tool: P.TOOLS.indexOf(msg.tool) >= 0 ? msg.tool : 'brush',
    // 画在图层上还是图层蒙版上。必须跟着广播走 —— 漏了它，
    // 别人会把你的蒙版笔迹当成普通笔迹画到图层上，两边的画面就对不上了。
    target: br.target === 'mask' ? 'mask' : 'layer',
    color: /^#[0-9a-fA-F]{3,8}$/.test(msg.color) ? msg.color : '#000000',
    size: Math.max(1, Math.min(400, Number(msg.size) || 6)),
    opacity: Math.max(0.02, Math.min(1, Number(msg.opacity) || 1)),
    hardness: br.hardness,
    minSize: br.minSize,
    pressSize: br.pressSize,
    pressOpacity: br.pressOpacity,
    edge: br.edge,
    scatter: br.scatter,
    grain: br.grain,
    grainScale: br.grainScale,
    paper: br.paper,
    fx: br.fx,
    strength: br.strength,
    tolerance: br.tolerance,
    expand: br.expand,
    blend: br.blend,
    sym: br.sym,
    brush: br.brush,
    filled: br.filled,
    // 导入的 PS / CSP 笔刷要带笔尖位图和落点间隔 —— 少了它们，
    // 别人的屏幕上这支笔会变回圆头，两端就对不上了
    spacing: br.spacing,
    tip: br.tip,
    mix: br.mix,
    text: P.normalizeText(br.text),
    fontFamily: P.normalizeFontFamily(br.fontFamily),
    fontSize: Math.max(6, Math.min(400, Number(br.fontSize) || 32)),
    bold: !!br.bold,
    italic: !!br.italic,
    align: ['left', 'center', 'right'].indexOf(br.align) >= 0 ? br.align : 'left',
    lineHeight: Math.max(0.8, Math.min(3, Number(br.lineHeight) || 1.35)),
    seed: br.seed || P.newSeed(),
    points: [],
    ts: Date.now()
  };
}

/** 广播笔迹头（含全部笔刷参数），不含 points */
function strokeHeader(stroke) {
  const h = {
    id: stroke.id, layerId: stroke.layerId, userId: stroke.userId,
    tool: stroke.tool, color: stroke.color, size: stroke.size, opacity: stroke.opacity,
    hardness: stroke.hardness, minSize: stroke.minSize,
    pressSize: stroke.pressSize, pressOpacity: stroke.pressOpacity,
    edge: stroke.edge, scatter: stroke.scatter, grain: stroke.grain,
    grainScale: stroke.grainScale, paper: stroke.paper, fx: stroke.fx,
    strength: stroke.strength, tolerance: stroke.tolerance, expand: stroke.expand,
    blend: stroke.blend, sym: stroke.sym, brush: stroke.brush,
    filled: stroke.filled, seed: stroke.seed,
    target: stroke.target === 'mask' ? 'mask' : 'layer'
  };
  // 文字笔迹必须把**文字本身**和字体参数一起广播出去。
  // 漏了这一段，别人收到就是一条没有内容的空白文字笔迹（自己那边看着正常）。
  if (stroke.tool === 'text') {
    h.text = stroke.text;
    h.fontFamily = stroke.fontFamily;
    h.fontSize = stroke.fontSize;
    h.bold = stroke.bold;
    h.italic = stroke.italic;
    h.align = stroke.align;
    h.lineHeight = stroke.lineHeight;
  }
  return h;
}

function joinRoom(ws, room, name, avatar) {
  colorCursor.i += 1;
  const member = {
    connId: ws._connId,
    userId: P.rid('u'),
    name,
    // 头像是客户端传上来的内联图 —— 必须过一遍 normalizeAvatar
    // （只放行 png/jpeg/webp 的 dataURL，且卡在 48KB 以内），否则一个 10MB 的
    // 字符串就能让每次成员广播变成巨型包。
    avatar: P.normalizeAvatar(avatar),
    color: P.userColor(colorCursor.i),
    ws,
    joinedAt: Date.now(),
    drawing: false,
    // 只读观众：房主在成员列表里能给人扣掉作画权限。默认人人都能画。
    readonly: false,
    lastChat: 0
  };
  room.members.set(ws._connId, member);
  ws._roomId = room.id;
  ws._userId = member.userId;
  // 建房的人当然是房主。另外，房主退房后房间会暂时「没有主」（见 transferOwnerIfNeeded），
  // 这时第一个进来的人接管 —— 否则房间会永久失去所有「仅房主」操作的权限。
  if (!room.ownerId) { room.ownerId = member.userId; room.ownerName = member.name; }
  room.touch();

  send(ws, P.S2C.ROOM_JOINED, {
    room: room.meta(),
    layers: room.layerList(),
    groups: room.groupList(),
    members: room.memberList(),
    chat: room.chat,
    you: {
      userId: member.userId, name: member.name, color: member.color, avatar: member.avatar || '',
      isOwner: member.userId === room.ownerId, readonly: !!member.readonly
    },
    // 游戏状态随入房一起给：新进来的人立刻就能看到 HUD，不用等下一次状态同步
    game: room.game && room.game.active ? room.game.snapshotFor(member.userId) : null,
    history: {
      count: strokesFor(room, member.userId).length,
      lastSeq: room.seq,
      baseImages: room.baseImageMap(),
      maskImages: room.maskImageMap()
    }
  });

  const chunks = historyChunks(room, member.userId);
  if (chunks.length === 0) send(ws, P.S2C.HISTORY_CHUNK, { strokes: [], done: true });
  else chunks.forEach((c, i) => send(ws, P.S2C.HISTORY_CHUNK, { strokes: c, done: i === chunks.length - 1 }));

  roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
  roomBroadcast(room, P.S2C.CHAT, {
    id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
    text: member.name + ' 进入了茶绘室', ts: Date.now(), system: true
  });
  store.markDirty(room);
  // 放在最后：让新人先拿到完整历史，再收到游戏状态（否则 HUD 会先于画布出现）
  if (room.game && room.game.active) room.game.onJoin(member);
  console.log('[room] ' + member.name + ' 加入 ' + room.id + '（在线 ' + room.online + '）');
}

/**
 * 房主退房时把房主交给还在房间里、最早进来的那个人。
 *
 * 不移交的话，所有「仅房主」的操作（结束游戏 / 解散房间 / 固化底图 / 改分辨率）
 * 就永久锁死了 —— 房间还在、人还在，但没有任何人有权限，尤其是游戏：
 * 画手走了、猜手被锁着，没人能按「结束游戏」，全员卡死。
 *
 * 房间空了就把 ownerId 清成 null，交给下一个进来的人接管（见 joinRoom）。
 */
function transferOwnerIfNeeded(room, leaving) {
  if (!room.ownerId || leaving.userId !== room.ownerId) return null;
  let next = null;
  for (const m of room.members.values()) {
    if (!next || m.joinedAt < next.joinedAt) next = m;
  }
  if (!next) { room.ownerId = null; room.ownerName = ''; return null; }
  room.ownerId = next.userId;
  room.ownerName = next.name;
  // 本局预设跟着房主走：换房主不该把大家已经看到的设置一起丢掉，但 by 要换成新人。
  // （与 HOST_TRANSFER 同一条规则，两条路径都走这里/那里。）
  PREFS.retargetGamePrefs(room, room.ownerId);
  return next;
}

function leaveRoom(ws, silent) {
  const room = store.get(ws._roomId);
  if (!room) return;
  const member = room.members.get(ws._connId);
  room.members.delete(ws._connId);
  ws._roomId = null;
  if (!member) return;
  const newOwner = transferOwnerIfNeeded(room, member);
  roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
  if (!silent) {
    roomBroadcast(room, P.S2C.CHAT, {
      id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
      text: member.name + ' 离开了茶绘室', ts: Date.now(), system: true
    });
  }
  if (newOwner) {
    roomBroadcast(room, P.S2C.CHAT, {
      id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
      text: '房主 ' + member.name + ' 离开了，' + newOwner.name + ' 成为新房主', ts: Date.now(), system: true
    });
    // 预设里的 by 换了人，重新广播一次让面板跟上
    if (room.pendingGame) roomBroadcast(room, P.S2C.GAME_PREFS, { prefs: room.pendingGame });
  }
  room.lastActiveAt = Date.now();
  store.markDirty(room);
  // 先把他从成员表里摘掉再通知游戏状态机：onLeave 里的「还剩几个人」必须是最新的
  if (room.game && room.game.active) room.game.onLeave(member);
}

/**
 * 挂一个客户端连接。
 *
 * **刻意从 `wss.on('connection')` 里抽出来**：离线模式（桌面端「关掉服务器」之后
 * 仍然要能画画）就是在这个进程里直接用这个函数挂一个**不走 socket** 的客户端
 * （见 client/local-host.js 的 LocalWs）。这样「有网 / 没网」两种模式共用同一份
 * 服务端逻辑 —— 不然离线就得另写一套房间状态机，两套迟早对不上。
 *
 * 参数只需要一个「像 ws 的东西」：readyState / OPEN / send(string) /
 * on('message'|'close'|'error'|'pong')。`req` 整个用不上，所以不收。
 */
function onClient(ws) {
  ws._connId = 'c' + (++connSeq);
  ws._roomId = null;
  ws._userId = null;
  ws._alive = true;

  ws.on('pong', () => { ws._alive = true; });

  send(ws, P.S2C.HELLO_OK, {
    serverVersion: P.PROTOCOL_VERSION,
    connId: ws._connId,
    rooms: store.list(),
    limits: { maxMembers: MAX_MEMBERS_PER_ROOM }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); } catch (err) {
      console.error('[ws] handle error', msg.t, err);
      send(ws, P.S2C.ERROR, { code: 'internal', message: '服务端处理出错：' + err.message });
    }
  });

  ws.on('close', () => leaveRoom(ws, false));
  ws.on('error', () => {});
}

function currentRoom(ws) {
  const room = store.get(ws._roomId);
  if (!room) return null;
  return room.members.has(ws._connId) ? room : null;
}

function handle(ws, msg) {
  const room = currentRoom(ws);
  const member = room ? room.members.get(ws._connId) : null;

  switch (msg.t) {
    /* ---------------- 基础 ---------------- */
    case P.C2S.PING: return send(ws, P.S2C.PONG, { t0: Number(msg.at) || Date.now() });
    case P.C2S.ROOM_LIST: return send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
    case P.C2S.RESYNC: {
      if (!room) return;
      send(ws, P.S2C.ROOM_JOINED, {
        room: room.meta(), layers: room.layerList(), groups: room.groupList(),
        members: room.memberList(),
        chat: room.chat,
        you: {
          userId: member.userId, name: member.name, color: member.color, avatar: member.avatar || '',
          isOwner: member.userId === room.ownerId, readonly: !!member.readonly
        },
        game: room.game && room.game.active ? room.game.snapshotFor(member.userId) : null,
        history: {
          count: strokesFor(room, member.userId).length, lastSeq: room.seq,
          baseImages: room.baseImageMap(),
          maskImages: room.maskImageMap()
        }
      });
      const chunks = historyChunks(room, member.userId);
      if (!chunks.length) send(ws, P.S2C.HISTORY_CHUNK, { strokes: [], done: true });
      else chunks.forEach((c, i) => send(ws, P.S2C.HISTORY_CHUNK, { strokes: c, done: i === chunks.length - 1 }));
      // 重连的人可能是画手，得把词补发给他；接龙的题面 / 回放包有去重记账，
      // 这里把记账清零强制补发（否则重连后拿不到当前的题面）
      if (room.game && room.game.active) {
        if (member) { member._chainTaskV = 0; member._chainRevealV = 0; }
        syncGame(room);
      }
      return;
    }

    /* ---------------- 房间 ---------------- */
    case P.C2S.ROOM_CREATE: {
      if (ws._roomId) leaveRoom(ws, true);
      if (store.rooms.size >= MAX_ROOMS) {
        return send(ws, P.S2C.ERROR, { code: 'too_many_rooms', message: '房间数已达上限，请稍后再试' });
      }
      const name = sanitizeName(msg.name, P.DEFAULTS.roomName);
      const user = sanitizeName(msg.user, '茶友');
      const wanted = (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(msg.id)) ? msg.id : null;
      if (wanted && store.get(wanted)) {
        return send(ws, P.S2C.ERROR, { code: 'room_exists', message: '房间号「' + wanted + '」已被占用，换一个吧' });
      }
      const room = store.create({
        id: wanted || undefined,
        name, width: msg.width, height: msg.height,
        background: msg.background,
        ownerName: user,
        password: sanitizeText(msg.password, 32)
      });
      joinRoom(ws, room, user, msg.avatar);
      send(ws, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    case P.C2S.ROOM_JOIN: {
      const id = sanitizeText(msg.roomId, 64);
      const target = store.get(id);
      if (!target) return send(ws, P.S2C.ERROR, { code: 'no_room', message: '房间不存在或已关闭' });
      if (target.members.size >= MAX_MEMBERS_PER_ROOM) {
        return send(ws, P.S2C.ERROR, { code: 'room_full', message: '房间人数已满（' + MAX_MEMBERS_PER_ROOM + ' 人）' });
      }
      if (target.password && sanitizeText(msg.password, 32) !== target.password) {
        return send(ws, P.S2C.ERROR, { code: 'bad_password', message: '房间密码不正确' });
      }
      if (ws._roomId) leaveRoom(ws, true);
      joinRoom(ws, target, sanitizeName(msg.user, '茶友'), msg.avatar);
      // 房间里已经有一份「房主预设」时补给这个迟到的人 —— 否则他看到的设置面板是默认值，
      // 而别人看到的是房主刚选的那套。GAME_PREFS 是幂等的，前端覆盖即可。
      if (target.pendingGame) send(ws, P.S2C.GAME_PREFS, { prefs: target.pendingGame });
      return;
    }

    case P.C2S.ROOM_LEAVE:
      leaveRoom(ws, false);
      return send(ws, P.S2C.ROOM_LEFT, {});

    case P.C2S.ROOM_INFO: {
      if (!room) return;
      if (writeBlocked(ws, room, member)) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以修改房间设置' });
      }
      if (typeof msg.name === 'string') room.name = sanitizeName(msg.name, room.name);
      if (typeof msg.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.background)) room.background = msg.background;
      store.markDirty(room);
      roomBroadcast(room, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      send(ws, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    /*
     * 房主把某人设成「只读观众」/ 恢复作画。
     *
     * 这条消息**故意不过 writeBlocked**：房主完全可能把自己设成观众（比如把画板让给
     * 别人，自己只做讲解）。要是它也归写操作管，那一刻起就再没人能取消，房间会永久
     * 失去作画权限 —— 和「房主不移交」是同一类死锁。
     */
    case P.C2S.MEMBER_ROLE: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以设观众' });
      }
      const who = sanitizeText(msg.userId, 40);
      let target = null;
      for (const m of room.members.values()) if (m.userId === who) target = m;
      if (!target) {
        return send(ws, P.S2C.ERROR, { code: 'no_member', message: '这个人已经不在房间里了' });
      }
      const want = !!msg.readonly;
      if (!!target.readonly === want) return;      // 状态没变，不刷屏

      // 正在作画的人不能当场变观众：他手上那一笔会卡在半空，整局干等到超时。
      if (want && room.game && room.game.phase === 'draw' && room.game.drawerId === target.userId) {
        return send(ws, P.S2C.ERROR, {
          code: 'drawer_busy',
          message: target.name + ' 正在作画，等这一回合结束再设为观众'
        });
      }

      target.readonly = want;
      // 已经落下半截的笔要掐掉，否则它会带着半截轨迹提交上去
      const st = want && target.ws && target.ws._activeStroke;
      if (st) {
        target.ws._activeStroke = null;
        target.drawing = false;
        roomBroadcast(room, P.S2C.STROKE_CANCEL, { id: st.id });
      }
      // 成员是**运行时**状态，不落盘（重启后大家重新进房），所以这里不 markDirty
      roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
        text: target.name + (want ? ' 现在是观众，只能看' : ' 可以作画了'),
        ts: Date.now(), system: true
      });
      return;
    }

    /**
     * 房主转让：把房主身份转给房间里另一个人。
     *
     * 与退房时的自动移交（transferOwnerIfNeeded）走同一套状态位 —— room.ownerId /
     * ownerName 改完广播 MEMBERS 就行，客户端的 isOwner 本来就是从成员列表里
     * 自己那行推出来的（见 applyMembers）。纯权限状态、不落盘，所以不 markDirty。
     */
    case P.C2S.HOST_TRANSFER: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以转让房主' });
      }
      const who = sanitizeText(msg.userId, 40);
      if (!who || who === member.userId) {
        return send(ws, P.S2C.ERROR, { code: 'bad_target', message: '要转让的人不对' });
      }
      let target = null;
      for (const m of room.members.values()) if (m.userId === who) target = m;
      if (!target) {
        return send(ws, P.S2C.ERROR, { code: 'no_member', message: '这个人已经不在房间里了' });
      }
      room.ownerId = target.userId;
      room.ownerName = target.name;
      // 本局预设**保留**（大家还能看见房主刚选的那套），但 by 换成新房主 ——
      // 否则面板上挂的是「上一个房主留的设置」，而能改它的已经换人了。
      PREFS.retargetGamePrefs(room, room.ownerId);
      // 成员是运行时状态，不落盘（同 MEMBER_ROLE）
      roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
      // by 变了要重新广播一次，不然前端面板上还写着「由老房主预设」
      if (room.pendingGame) roomBroadcast(room, P.S2C.GAME_PREFS, { prefs: room.pendingGame });
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b',
        text: '房主 ' + member.name + ' 把管理权转给了 ' + target.name + '，' + target.name + ' 现在是房主',
        ts: Date.now(), system: true
      });
      return;
    }

    /**
     * 换头像。**故意不过 writeBlocked**：它改的是「我是谁」，不是画布内容 ——
     * 只读观众在成员列表里也有头像，没理由把他拦在外面。
     * 成员是运行时状态、不落盘，所以这里只广播 MEMBERS，不 markDirty。
     */
    case P.C2S.MEMBER_AVATAR: {
      if (!room || !member) return;
      const next = P.normalizeAvatar(msg.avatar);
      if ((member.avatar || '') === next) return;      // 没变就别刷屏
      member.avatar = next;
      roomBroadcast(room, P.S2C.MEMBERS, { members: room.memberList() });
      return;
    }

    case P.C2S.ROOM_RESIZE: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以调整画布分辨率' });
      }
      const w = Number(msg.width), h = Number(msg.height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || w > 4096 || h < 240 || h > 4096) {
        return send(ws, P.S2C.ERROR, { code: 'bad_size', message: '画布尺寸超出范围（320-4096 × 240-4096）' });
      }
      const changed = room.setSize(w, h);
      if (!changed) return;
      store.markDirty(room);
      // 重要：尺寸变了需要让客户端重建引擎，重新拉一次历史重放
      roomBroadcast(room, P.S2C.ROOM_RESIZED, { width: room.width, height: room.height });
      roomBroadcast(room, P.S2C.ROOM_UPDATED, { patch: room.meta() });
      return;
    }

    case P.C2S.ROOM_DEL: {
      const id = sanitizeText(msg.roomId, 64);
      const target = store.get(id);
      if (!target) return send(ws, P.S2C.OK, { ok: true }); // 房间已不存在也算成功
      const isOwner = member && member.userId === target.ownerId;
      const isEmpty = target.online === 0;
      if (!isOwner && !isEmpty) {
        return send(ws, P.S2C.ERROR, { code: 'room_busy', message: '房间内还有人，无法删除' });
      }
      // 先把还在线的成员请出（房主删自己的房间时会有），并把他们从连接上摘掉。
      // 不摘的话 ws._roomId 会指着一个已被 store.drop 丢弃的房间 ——
      // 之后他们发上来的任何消息都会在 store.get() 处拿到 undefined 被静默丢掉。
      target.members.forEach(function (m) {
        try { send(m.ws, P.S2C.ROOM_DELETED, { id: id, by: member ? member.userId : null }); } catch (e) { /* ignore */ }
        m.ws._roomId = null;
        m.ws._userId = null;
      });
      target.members.clear();
      store.drop(id);
      console.log('[room] ' + id + ' 被 ' + (member ? member.name : 'GC') + ' 删除');
      send(ws, P.S2C.OK, { ok: true, deleted: id });
      send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
      return;
    }

    // 一键清理：把所有「没人在线 + 没有任何内容」的房间都回收掉
    case P.C2S.ROOM_GC: {
      const n = purgeBlankRooms(0);
      console.log('[room] ' + (member ? member.name : ws._connId) + ' 一键清理了 ' + n + ' 个空房间');
      send(ws, P.S2C.OK, { ok: true, purged: n });
      send(ws, P.S2C.ROOM_LIST, { rooms: store.list() });
      // 其他人列表里也刷新一下
      for (const c of liveClients()) {
        if (c !== ws && c.readyState === 1 && !c._roomId) {
          try { send(c, P.S2C.ROOM_LIST, { rooms: store.list() }); } catch (e) { /* ignore */ }
        }
      }
      return;
    }

    /* ---------------- 你画我猜 / 接龙 ---------------- */
    case P.C2S.GAME_START: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以开局' });
      }
      const mode = GAME_MODES[msg.mode] ? msg.mode : 'classic';
      const r = startGameOf(room, mode, msg);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: r.code || 'game_start', message: r.message });
      // 开局成功 = 预设已经「用掉了」：清掉它，免得下一局的面板还挂着上一局的设置
      // （而且房间列表/新进来的人也不该再看到一份过期的预设）。
      PREFS.clearGamePrefs(room);
      const g = room.game;
      if (g.mode === 'chain') {
        console.log('[game] ' + room.id + ' 接龙大厅就绪（链长 ' + g.chainLength
          + '，主题 ' + g.theme + '，' + room.online + ' 人）');
      } else if (g.mode === 'skin') {
        console.log('[game] ' + room.id + ' 画皮开局（' + g.maxRounds + ' 轮，主题 '
          + g.theme + '，' + g.players.length + ' 人，'
          + g.wolves(false).length + ' 狼）');
      } else {
        console.log('[game] ' + room.id + ' 开局（' + g.rounds + ' 回合，' + room.online + ' 人）');
      }
      return;
    }

    case P.C2S.GAME_STOP: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以结束游戏' });
      }
      if (!room.game) return;
      room.game.stop();
      // 结束游戏也把预设清掉：一局结束 = 回到自由绘画，面板应该回到「默认」而不是留着旧值
      PREFS.clearGamePrefs(room);
      gameChat(room, '房主结束了游戏，回到自由绘画');
      return;
    }

    /**
     * 房主的「本局预设」：他在设置面板上改任何一项就发一次（前端自己做防抖）。
     *
     * 只做三件事：**仅房主** → 逐字段白名单清洗 + 夹取 → 广播给全房间（含发送者）。
     * 清洗后的那一份挂在 room.pendingGame 上（不落盘、不进 meta/summary），
     * 别人据此看到「房主选的设置」。真正生效要等 GAME_START。
     */
    case P.C2S.GAME_PREFS: {
      const r = PREFS.applyGamePrefs(room, member, msg);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: r.code, message: r.message });
      roomBroadcast(room, P.S2C.GAME_PREFS, { prefs: r.prefs });
      return;
    }

    case P.C2S.GAME_PICK: {
      if (!room || !member || !room.game) return;
      if (room.game.mode !== 'classic') return;
      const r = room.game.pick(member.userId, msg.index);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_pick', message: r.message });
      return;
    }

    // 画手觉得这组不好画，换一组候选（每回合限次，上限在 game.js 里判）
    case P.C2S.GAME_REPICK: {
      if (!room || !member || !room.game) return;
      if (room.game.mode !== 'classic') return;
      const r = room.game.repick(member.userId);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_repick', message: r.message });
      return;
    }

    /* ---------------- 接龙（v9 重制：多链并行 Whisper） ---------------- */

    // 我这一格交卷：写词 / 猜词带文本（index = 选了第几个候选）；
    // 作画只发一个「画好了」的信号 —— 笔迹早已通过 STROKE_* 进了房间笔迹表，
    // 收格时服务端按作者摘取（像素渲染在客户端，服务端只存数据，与图层像素同一套分工）。
    case P.C2S.GAME_SUBMIT: {
      if (!room || !member || !room.game || room.game.mode !== 'chain') return;
      const r = room.game.submit(member.userId, msg);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_submit', message: r.message });
      return;
    }

    // 大厅准备 / 取消准备（全员就绪自动开局）
    case P.C2S.GAME_READY: {
      if (!room || !member || !room.game || room.game.mode !== 'chain') return;
      const r = room.game.toggleReady(member.userId, msg.ready !== false);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_ready', message: r.message });
      return;
    }

    // 投票：kind='keep'（这条链首尾对得上吗）/ kind='fav'（最喜欢的一张画）。
    // 票是匿名的 —— 不广播「谁投了什么」，只在自己的快照里回显。
    case P.C2S.GAME_VOTE: {
      if (!room || !member || !room.game || room.game.mode !== 'chain') return;
      const g = room.game;
      const chainId = sanitizeText(msg.chainId, 24);
      const r = msg.kind === 'fav'
        ? g.favVote(member.userId, chainId, msg.step)
        : g.keepVote(member.userId, chainId, !!msg.agree);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_vote', message: r.message });
      return;
    }

    // 房主推进：大厅强制开局 / 写画猜跳过没交的人 / 回放→投票 / 投票→结算 / 结算→大厅
    case P.C2S.GAME_NEXT: {
      if (!room || !member || !room.game || room.game.mode !== 'chain') return;
      const r = room.game.next(member.userId);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'game_next', message: r.message });
      return;
    }

    /* ---------------- 画皮 ---------------- */

    /**
     * 画皮唯一的动作通道：夜里验人 / 刀人 / 用药，白天投票，猎人开枪。
     *
     * 做成一条而不是三条：这些动作互斥（同一时刻只可能有一个 phase 有活可干），
     * 而且**裁定全在 skin.js 里**（谁有资格、目标在不在场上，
     * 服务端一律按自己的 players 表核对，不信客户端传来的任何东西）。
     */
    case P.C2S.SKIN_ACTION: {
      if (!room || !member || !room.game || room.game.mode !== 'skin') return;
      const g = room.game;
      const kind = sanitizeText(msg.kind, 12);
      const target = sanitizeText(msg.target, 40);
      let r;
      if (kind === 'vote') r = g.vote(member.userId, target || 'skip');
      else if (kind === 'shot') r = g.hunterShot(member.userId, target);
      else if (kind === 'next') r = g.next(member.userId);
      else r = g.nightAction(member.userId, kind, target);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'skin_action', message: r.message });
      return;
    }

    /**
     * 天亮的作画产物。与接龙的 GAME_ART 同一套分工：
     * **像素由客户端渲染，服务端只做哑存储**。
     */
    case P.C2S.SKIN_ART: {
      if (!room || !member || !room.game || room.game.mode !== 'skin') return;
      const r = room.game.submitArt(member.userId, msg.png);
      if (!r.ok) return send(ws, P.S2C.ERROR, { code: 'skin_art', message: r.message });
      return;
    }

    /* ---------------- 笔迹 ---------------- */
    case P.C2S.STROKE_BEGIN: {
      if (!room || !canDraw(room, member)) return;
      const layer = room.getLayer(msg.layerId) || room.layers[room.layers.length - 1];
      if (!member) return;
      if (ws._activeStroke) return;
      const stroke = buildStroke(msg, member, layer);
      if (!stroke.id) return;
      ws._activeStroke = stroke;
      member.drawing = true;
      strokeBroadcast(room, P.S2C.STROKE_BEGIN, { stroke: strokeHeader(stroke) }, ws._connId);
      return;
    }

    case P.C2S.STROKE_POINTS: {
      const stroke = ws._activeStroke;
      if (!room || !stroke || !Array.isArray(msg.pts) || stroke.id !== msg.id) return;
      const pts = [];
      for (const p of msg.pts) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const x = Number(p[0]), y = Number(p[1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        pts.push(P.qp([x, y, isFinite(Number(p[2])) ? Number(p[2]) : 0.5]));
      }
      if (!pts.length) return;
      stroke.points.push(...pts);
      strokeBroadcast(room, P.S2C.STROKE_POINTS, { id: stroke.id, pts }, ws._connId);
      return;
    }

    case P.C2S.STROKE_END: {
      const stroke = ws._activeStroke;
      ws._activeStroke = null;
      if (!room || !stroke) return;
      if (member) member.drawing = false;
      if (stroke.points.length === 0) {
        strokeBroadcast(room, P.S2C.STROKE_CANCEL, { id: stroke.id }, ws._connId);
        return;
      }
      // 补上结束时刻（起始时刻 buildStroke 里已打 ts）。
      // 存档里的历史笔迹会带着 ts/te 回到新客户端，回放才放得出真实的「一笔画了多久」。
      stroke.te = Date.now();
      room.addStroke(stroke);
      store.markDirty(room);
      strokeBroadcast(room, P.S2C.STROKE_END, { id: stroke.id, seq: stroke.seq }, ws._connId);
      send(ws, P.S2C.STROKE_END, { id: stroke.id, seq: stroke.seq });
      return;
    }

    case P.C2S.STROKE_CANCEL: {
      const stroke = ws._activeStroke;
      ws._activeStroke = null;
      if (!room || !stroke) return;
      if (member) member.drawing = false;
      strokeBroadcast(room, P.S2C.STROKE_CANCEL, { id: stroke.id }, ws._connId);
      return;
    }

    case P.C2S.STROKE_UNDO: {
      if (!room || !member || !Array.isArray(msg.ids)) return;
      if (undoBlocked(ws, room, member)) return;
      const ids = msg.ids.filter(id => room.strokes.some(s => s.id === id && s.userId === member.userId));
      if (!ids.length) return;
      room.removeStrokes(ids);
      store.markDirty(room);
      // 发起者已在本地乐观移除，不回显（否则其重做栈会被 pruneUndo 清空）
      strokeBroadcast(room, P.S2C.STROKE_REMOVED, { ids, reason: 'undo', by: member.userId }, ws._connId);
      return;
    }

    case P.C2S.STROKE_REDO: {
      if (!room || !member || !msg.stroke || typeof msg.stroke !== 'object') return;
      if (undoBlocked(ws, room, member)) return;
      const s = msg.stroke;
      if (!s.id || !Array.isArray(s.points) || !s.points.length) return;
      if (room.strokes.some(k => k.id === s.id)) return;
      const layer = room.getLayer(s.layerId) || room.layers[room.layers.length - 1];
      const stroke = buildStroke(s, member, layer);
      stroke.points = s.points.map(p => P.qp(p));
      const saved = room.redoStroke(stroke);
      store.markDirty(room);
      strokeBroadcast(room, P.S2C.STROKE_ADDED, { stroke: saved });
      send(ws, P.S2C.STROKE_ADDED, { stroke: saved });
      return;
    }

    case P.C2S.STROKE_CLEAR: {
      if (!room || !member) return;
      const scope = msg.scope === 'all' ? 'all' : 'layer';
      const layerId = sanitizeText(msg.layerId, 40);
      if (writeBlocked(ws, room, member)) return;
      if (scope === 'all' && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以清空整个画布' });
      }
      // 私密作画期间：画布是共用的（只是互相看不见），所以「清空」只能清**自己**那几笔 ——
      // 照常按图层清会把别人正在画的私密笔迹一起抹掉，他那边看着画面还在、服务端却已经没了。
      // 回执也只给发起者：别人根本不知道这张画的存在，没必要知道有人清过。
      if (privateDrawOn(room)) {
        const own = room.strokes
          .filter(s => s.userId === member.userId && (scope === 'all' || s.layerId === layerId))
          .map(s => s.id);
        const gone = room.removeStrokes(own);
        if (!gone) return;
        store.markDirty(room);
        return send(ws, P.S2C.STROKE_REMOVED, {
          ids: [], reason: 'clear', scope, layerId, by: member.userId, removed: gone
        });
      }
      const removed = room.clear(scope, layerId);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_REMOVED, { ids: [], reason: 'clear', scope, layerId, by: member.userId, removed });
      broadcastLayers(room, room.baseImageMap());
      return;
    }

    /* ---------------- 图层 ---------------- */
    case P.C2S.LAYER_ADD: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (room.layers.length >= MAX_LAYERS) {
        return send(ws, P.S2C.ERROR, { code: 'layer_limit', message: '图层数量上限为 ' + MAX_LAYERS });
      }
      // 客户端可以指定图层 id —— 和 ROOM_CREATE 一个套路。
      // 为什么必须认它：「文字图层」和「粘贴图片」都是「先建层、再往里写
      // 笔迹 / 像素」，客户端得提前知道 id 才能一次到位。不认的话，
      // 客户端 newStroke 会兜底到**活动图层**、服务端这里会兜底到**最后一层**，
      // 两边一旦不是同一层，作者看到字在自己图层、别人看到在另一层。
      const wanted = (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(msg.id)) ? msg.id : null;
      if (wanted && room.getLayer(wanted)) {
        return send(ws, P.S2C.ERROR, { code: 'layer_exists', message: '图层 id 冲突，请重试' });
      }
      const gid = (typeof msg.groupId === 'string' && room.getGroup(msg.groupId))
        ? msg.groupId : null;
      room.addLayer(sanitizeName(msg.name, ''), msg.at, wanted || undefined, gid || undefined);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_DEL: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以删除' });
      }
      const removed = room.delLayer(l.id);
      if (!removed) return send(ws, P.S2C.ERROR, { code: 'last_layer', message: '至少要保留一个图层' });
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_UPD: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const lid = sanitizeText(msg.layerId, 40);
      const patch = msg.patch || {};
      const lay = room.getLayer(lid);
      const hadMask = !!(lay && lay.hasMask);
      room.updateLayer(lid, patch);
      store.markDirty(room);
      broadcastLayers(room);
      // 「丢掉蒙版」必须连**涂这张蒙版的那几笔**一起丢掉。
      // 留着它们不出声，但后果很吵：重新给这层加一张蒙版、或者别人中途进来重放历史时，
      // 这些陈年笔迹会被重新盖到新蒙版上 —— 表现就是「刚加的白蒙版怎么已经缺了一块」。
      if (hadMask && patch.hasMask === false) {
        const gone = room.strokes.filter(s => s.layerId === lid && s.target === 'mask').map(s => s.id);
        if (gone.length) {
          room.removeStrokes(gone);
          roomBroadcast(room, P.S2C.STROKE_REMOVED, { ids: gone, reason: 'mask', layerId: lid }, ws._connId);
        }
      }
      return;
    }

    case P.C2S.LAYER_MOVE: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      room.moveLayer(sanitizeText(msg.layerId, 40), Number(msg.to) || 0);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_DUP: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      if (room.layers.length >= MAX_LAYERS) {
        return send(ws, P.S2C.ERROR, { code: 'layer_limit', message: '图层数量上限为 ' + MAX_LAYERS });
      }
      const src = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!src) return;
      const copy = room.dupLayer(src.id, msg.png, Number(msg.upToSeq) || room.seq);
      if (!copy) return;
      store.markDirty(room);
      broadcastLayers(room, copy.baseImage ? { [copy.id]: copy.baseImage } : null);
      return;
    }

    case P.C2S.LAYER_CLEAR: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以清空' });
      }
      room.clearLayer(l.id);
      store.markDirty(room);
      // 必须让客户端把本机这份图层的历史笔迹一起丢掉：
      // 只发 LAYERS 的话，客户端会拿自己的笔迹数组重放，看起来像「清除没生效」。
      // 与 STROKE_CLEAR 走同一条通知，客户端已有 clearScope 处理分支。
      roomBroadcast(room, P.S2C.STROKE_REMOVED, {
        ids: [], reason: 'clear', scope: 'layer', layerId: l.id, by: member.userId, removed: true
      });
      broadcastLayers(room);
      return;
    }

    /**
     * 用客户端渲染好的像素整体替换某个图层。
     * 图像变换（自由变换 / 缩放 / 旋转…）和「图像大小」缩放画面都用它 ——
     * 变换后的像素没法用笔迹重放表达，只能像复制/合并那样由客户端烘焙成 PNG 回传，
     * 服务端依旧只做哑存储。
     */
    case P.C2S.LAYER_PIXELS: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      if (!room.layerIsSolo(l.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '该图层上有别人的成果，只有房主可以整体替换' });
      }
      const okPix = room.setLayerPixels(l.id, msg.png, Number(msg.upToSeq) || room.seq);
      if (!okPix) return send(ws, P.S2C.ERROR, { code: 'bad_pixels', message: '图层像素数据无效' });
      store.markDirty(room);
      roomBroadcast(room, P.S2C.STROKE_REMOVED, {
        ids: [], reason: 'clear', scope: 'layer', layerId: l.id, by: member.userId, removed: true
      });
      broadcastLayers(room, { [l.id]: l.baseImage });
      return;
    }

    case P.C2S.LAYER_MERGE: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      const srcId = sanitizeText(msg.srcId, 40);
      const dstId = sanitizeText(msg.dstId, 40);
      if (!room.layerIsSolo(srcId, member.userId) || !room.layerIsSolo(dstId, member.userId)) {
        if (member.userId !== room.ownerId) {
          return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '这两个图层里有别人的成果，只有房主可以合并' });
        }
      }
      const dst = room.mergeLayers(srcId, dstId, msg.png, Number(msg.upToSeq) || room.seq);
      if (!dst) return send(ws, P.S2C.ERROR, { code: 'merge_fail', message: '无法合并这两个图层' });
      store.markDirty(room);
      broadcastLayers(room, dst.baseImage ? { [dst.id]: dst.baseImage } : null);
      return;
    }

    case P.C2S.LAYER_FLATTEN: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以合并所有图层' });
      }
      const keep = room.flatten(msg.png, sanitizeName(msg.name, '合并图层'), Number(msg.upToSeq) || room.seq);
      store.markDirty(room);
      broadcastLayers(room, keep.baseImage ? { [keep.id]: keep.baseImage } : null);
      return;
    }

    /* ---------------- 图层组 ---------------- */
    // 组没有像素，只有一条「子图层怎么合到一起」的规则（组自己的不透明度 + 混合模式）。
    // 不变式见 protocol.js：**同一组的图层在 room.layers 里永远连续**，
    // 由 rooms.js 的 normalizeGroups() 在每次结构变更后维持。

    case P.C2S.GROUP_ADD: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      // id 同样由客户端指定（道理和 LAYER_ADD 一样）：建完要立刻选中这个组、
      // 直接改它的名字 / 不透明度，不能等一个来回才知道它叫什么。
      const wanted = (typeof msg.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(msg.id)) ? msg.id : null;
      if (wanted && room.getGroup(wanted)) {
        return send(ws, P.S2C.ERROR, { code: 'group_exists', message: '组 id 冲突，请重试' });
      }
      // 组必须有成员（没有成员的组没有位置可言），所以建组一定要指定装哪一层
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return send(ws, P.S2C.ERROR, { code: 'no_layer', message: '不知道要把哪一层装进组' });
      room.addGroup({ id: wanted || undefined, name: sanitizeName(msg.name, '') || '组' }, l.id);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.GROUP_UPD: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const g = room.getGroup(sanitizeText(msg.groupId, 40));
      if (!g) return;
      room.updGroup(g.id, msg.patch || {});
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.GROUP_DEL: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const g = room.getGroup(sanitizeText(msg.groupId, 40));
      if (!g) return;
      // 组里有别人的成果 → 只有房主能动。**解散也算破坏性操作**：
      // 组那层不透明度 / 混合模式会跟着消失，画面是真的会变，
      // 不能因为「没删像素」就当成无损操作放给所有人。
      if (!room.groupIsSolo(g.id, member.userId) && member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, {
          code: 'not_owner', message: '这个组里有别人的成果，只有房主可以解散或删除'
        });
      }
      const res = room.delGroup(g.id, !!msg.withLayers);
      if (!res) return;
      if (res.error === 'last_layer') {
        return send(ws, P.S2C.ERROR, { code: 'last_layer', message: '至少要保留一个图层' });
      }
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.GROUP_MOVE: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const g = room.getGroup(sanitizeText(msg.groupId, 40));
      if (!g) return;
      room.moveGroup(g.id, Number(msg.dir) < 0 ? -1 : 1);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    case P.C2S.LAYER_GROUP: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      const l = room.getLayer(sanitizeText(msg.layerId, 40));
      if (!l) return;
      const gid = (typeof msg.groupId === 'string' && msg.groupId)
        ? sanitizeText(msg.groupId, 40) : null;
      if (gid && !room.getGroup(gid)) {
        return send(ws, P.S2C.ERROR, { code: 'no_group', message: '这个组已经不在了' });
      }
      room.setLayerGroup(l.id, gid);
      store.markDirty(room);
      broadcastLayers(room);
      return;
    }

    /* ---------------- 工程文件装载（分片，避开单条 12MB 的 ws 上限） ---------------- */
    // 一次装载 = BEGIN + N×LAYER + END。三条都要房主；中间任何一步不合法就整批丢弃，
    // 房间保持原样 —— 宁可装载失败，也不要留半个错位的图层表。

    case P.C2S.PROJECT_BEGIN: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (gameBusy(ws, room, member)) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以装载工程' });
      }
      const count = Math.round(Number(msg.count) || 0);
      if (!(count >= 1 && count <= MAX_LAYERS)) {
        return send(ws, P.S2C.ERROR, {
          code: 'bad_project',
          message: '工程的图层数要在 1~' + MAX_LAYERS + ' 之间（收到 ' + count + '）'
        });
      }
      // 组表跟着 BEGIN 一起传：它很小（没有像素），而且必须在第一个图层之前
      // 就到齐 —— 服务端要拿它判断各层的 groupId 是否有效。
      const groups = [];
      if (Array.isArray(msg.groups)) {
        for (const g of msg.groups.slice(0, MAX_LAYERS)) {
          if (!g || typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{4,32}$/.test(g.id)) continue;
          groups.push({
            id: g.id,
            name: sanitizeName(g.name, '') || '组',
            visible: g.visible !== false,
            opacity: typeof g.opacity === 'number' ? g.opacity : 1,
            blend: g.blend,
            collapsed: !!g.collapsed
          });
        }
      }
      room.projectLoad = { count: count, layers: [], groups: groups, at: Date.now() };
      return;
    }

    case P.C2S.PROJECT_LAYER: {
      if (!room || !member) return;
      if (gameBusy(ws, room, member)) return;
      if (member.userId !== room.ownerId) return;
      const job = room.projectLoad;
      if (!job) {
        return send(ws, P.S2C.ERROR, { code: 'no_project', message: '没有正在装载的工程' });
      }
      // 装载是「用户正在做一件事」，超时就当它半路断了；别让一个陈旧的暂存区
      // 在房间里躺到下一次装载，把两批图层拼在一起。
      if (Date.now() - job.at > 60000) {
        room.projectLoad = null;
        return send(ws, P.S2C.ERROR, { code: 'no_project', message: '工程装载超时，已中止' });
      }
      const idx = Math.round(Number(msg.index));
      if (idx !== job.layers.length) {
        room.projectLoad = null;
        return send(ws, P.S2C.ERROR, { code: 'bad_project', message: '工程装载顺序错乱，已中止' });
      }
      job.at = Date.now();
      job.layers.push({
        id: P.rid('L'),
        // 24 字：跟 LAYER_UPD 的改名路径对齐（LAYER_ADD 那条只给 16）。
        // 取更宽松的那条，免得「工程带回来的图层名」比用户手打的还短。
        name: String(typeof msg.name === 'string' ? msg.name : '')
          .replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || ('图层 ' + (idx + 1)),
        visible: msg.visible !== false,
        opacity: msg.opacity,
        locked: msg.locked,
        alphaLock: msg.alphaLock,
        blend: msg.blend,
        // 组引用照抄工程文件；指向不存在的组会被 loadProject 里的 normalizeGroups 清掉
        groupId: (typeof msg.groupId === 'string' && msg.groupId) ? msg.groupId : null,
        // 剪贴蒙版与图层蒙版：工程文件 / PSD 导入都会带过来。
        // 蒙版的像素是**整张 PNG**（用 alpha 表示显示多少），不是笔迹，
        // 所以走 maskImage 这条路，由 LAYERS 广播里的 maskImages 发给每个客户端。
        clip: !!msg.clip,
        maskEnabled: msg.maskEnabled !== false,
        maskPng: (typeof msg.maskPng === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(msg.maskPng))
          ? msg.maskPng : null,
        png: msg.png
      });
      return;
    }

    case P.C2S.PROJECT_END: {
      if (!room || !member) return;
      if (gameBusy(ws, room, member)) return;
      if (member.userId !== room.ownerId) return;
      const job = room.projectLoad;
      if (!job) {
        return send(ws, P.S2C.ERROR, { code: 'no_project', message: '没有正在装载的工程' });
      }
      if (job.layers.length !== job.count) {
        room.projectLoad = null;
        return send(ws, P.S2C.ERROR, {
          code: 'bad_project',
          message: '工程只收到 ' + job.layers.length + '/' + job.count + ' 层，已中止'
        });
      }
      room.projectLoad = null;
      // seq 往前走一步：新底图的 baseSeq 必须 > 0，否则 layerIsSolo() 会认为这些
      // 图层「还没固化过」，任何成员都能把它们整体替换掉。
      room.loadProject(job.layers, room.seq + 1, job.groups);
      store.markDirty(room);
      // 笔迹历史被整批换掉了，让所有端把本地的重放缓存丢掉重建
      roomBroadcast(room, P.S2C.STROKE_REMOVED, { ids: [], reason: 'clear', scope: 'all' });
      // maskImages 也得跟着走：导入的 PSD / 工程里那些「不是画出来的」蒙版，
      // 不在 LAYERS 里带上，客户端就只能看到「这层有蒙版」却看不到蒙版长什么样
      broadcastLayers(room, room.baseImageMap(), room.maskImageMap());
      return;
    }

    /* ---------------- 固化底图 ---------------- */
    case P.C2S.ROOM_COMPRESS: {
      if (!room || !member) return;
      if (writeBlocked(ws, room, member)) return;
      if (privateDrawLocked(ws, room, member)) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以固化底图' });
      }
      const saved = room.compress(msg.pngs || {}, Number(msg.upToSeq) || room.seq);
      store.markDirty(room);
      roomBroadcast(room, P.S2C.ROOM_UPDATED, {
        patch: Object.assign(room.meta(), { baseImages: room.baseImageMap() })
      });
      send(ws, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房间已固化底图，压缩了 ' + saved + ' 条历史笔迹', ts: Date.now()
      });
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房主固化了底图，压缩了 ' + saved + ' 条历史笔迹', ts: Date.now()
      });
      return;
    }

    /* ---------------- 解散房间 ---------------- */
    case P.C2S.ROOM_DESTROY: {
      if (!room || !member) return;
      if (member.userId !== room.ownerId) {
        return send(ws, P.S2C.ERROR, { code: 'not_owner', message: '只有房主可以解散房间' });
      }
      const name = room.name;
      roomBroadcast(room, P.S2C.CHAT, {
        id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
        text: '房主解散了房间「' + name + '」', ts: Date.now()
      });
      for (const m of Array.from(room.members.values())) {
        if (m.ws.readyState === m.ws.OPEN) send(m.ws, P.S2C.ROOM_DESTROYED, { by: member.name });
        // 连接上也要摘干净，理由同 ROOM_DEL：否则 ws._roomId 还指着一个已被丢弃的房间
        m.ws._roomId = null;
        m.ws._userId = null;
      }
      room.members.clear();
      store.drop(room.id);
      console.log('[room] ' + name + '（' + room.id + '）已被房主解散');
      return;
    }

    /* ---------------- 聊天 / 光标 ---------------- */
    case P.C2S.CHAT: {
      if (!room || !member) return;
      const now = Date.now();
      if (now - member.lastChat < 250) return;
      member.lastChat = now;
      const text = sanitizeText(msg.text, 500).trim();
      const img = P.normalizeSticker(msg.img);
      if (!text && !img) return;

      const g = room.game;
      // 只有**经典模式**把聊天当猜词。接龙的猜词走 GAME_SUBMIT 单发（不进聊天流），
      // 所以接龙进行中聊天就是普通聊天 —— 但也必须挡掉泄题（见下面的 canChat 判断）。
      const guessing = !!(g && g.mode === 'classic' && g.isPlaying());

      /* 游戏进行中：这句话先当「猜词」处理，由服务端决定它能不能公开 */
      if (guessing && text) {
        const res = g.handleGuess(member, text);
        if (res && res.kind === 'correct') {
          // 猜对了 —— 原话绝不出房间，只广播「谁猜对了第几名」
          roomBroadcast(room, P.S2C.GAME_CORRECT, {
            userId: member.userId, name: member.name, rank: res.rank, points: res.points
          });
          send(ws, P.S2C.CHAT, {
            id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
            ts: now, text: '你猜对了！第 ' + res.rank + ' 名，+' + res.points + ' 分'
          });
          gameChat(room, member.name + ' 猜对了！第 ' + res.rank + ' 名 +' + res.points + ' 分');
          g.afterCorrect();
          return;
        }
        if (res && res.kind === 'near') {
          // 很接近：私下提醒，同时这条猜测照常公开（猜歪的过程本来就该让大家看见）
          send(ws, P.S2C.GAME_GUESS, { kind: 'near' });
          send(ws, P.S2C.CHAT, {
            id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
            ts: now, text: '很接近了，再想想！'
          });
        }
        // 纯粹猜错：**只说给猜的人自己听**。广播「谁猜错了」等于把
        // 「谁在猜、猜了几次」也变成公开信息，对猜的人不公平，也没必要。
        if (res && res.kind === 'wrong') send(ws, P.S2C.GAME_GUESS, { kind: 'wrong' });
      }

      // 防剧透：画手 / 已经猜对的人都可以发言（给提示 / 照常聊天），
      // 但话里带着答案（整词、或答案的字全出现）就拦下，只回本人。
      if (guessing && text && g.chatLeaksAnswer(member.userId, text)) {
        send(ws, P.S2C.CHAT, {
          id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
          ts: now,
          text: '这句话带着答案，不会发出去（可以给提示，但别把词说出来）'
        });
        if (!img) return;
      }

      // 接龙的防剧透：**手里攥着秘密的人不许说话**。
      // 这一步轮到谁「看图猜词」，他就知道答案；轮到谁「照词作画」，他也知道答案 ——
      // 这两种人一开口，后面几步的悬念就没了。自己那张候选词倒不必管（那本来不是别人的谜面）。
      if (text && g && g.mode === 'chain' && g.chatLeaks && g.chatLeaks(member.userId)) {
        send(ws, P.S2C.CHAT, {
          id: P.rid('m'), userId: 'system', name: '系统', color: '#8b8b8b', system: true,
          ts: now, text: '你手上正拿着这一步的答案，先别说话（免得剧透）'
        });
        if (!img) return;
      }

      const entry = { id: P.rid('m'), userId: member.userId, name: member.name, color: member.color, text, ts: now };
      if (img) entry.img = img;
      room.addChat(entry);
      store.markDirty(room);
      // 不带 exceptId：发送者也在 room.members 里，会一起收到。
      // 这里绝对不能再 send(ws, ...) 补一次 —— 那样发送者自己会看到两条同样的消息
      roomBroadcast(room, P.S2C.CHAT, entry);
      return;
    }

    case P.C2S.CURSOR: {
      if (!room || !member) return;
      if (member.cursorAt && Date.now() - member.cursorAt < 60) {
        member.pendingCursor = { x: Number(msg.x) || 0, y: Number(msg.y) || 0, active: !!msg.active };
        return;
      }
      member.cursorAt = Date.now();
      // 私密作画期间不广播光标：大家各画各的，别人屏幕上一群光标乱飞既吵又暗示
      // 「有人正在那张画上落笔」。客户端在作画阶段本来也会把远端光标藏起来，这里是第二道。
      if (privateDrawOn(room)) return;
      roomBroadcast(room, P.S2C.CURSOR, {
        userId: member.userId, name: member.name, color: member.color,
        x: Number(msg.x) || 0, y: Number(msg.y) || 0, active: !!msg.active,
        tool: msg.tool || 'brush'
      }, ws._connId);
      return;
    }

    default:
      return;
  }
}

function canDraw(room, member) {
  if (!member) return false;
  if (member.readonly) return false;
  // 游戏进行中只有画手能落笔。这里拦的是**服务端**：前端禁用工具只是提示，
  // 谁改一下前端就能绕过去。
  if (room && room.game && room.game.lockedFor(member.userId)) return false;
  return true;
}

/* ------------------------------------------------------------------ 心跳 & 清理 */

const heartbeat = setInterval(() => {
  liveClients().forEach(ws => {
    if (ws._alive === false) return ws.terminate();
    ws._alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 30000);
heartbeat.unref && heartbeat.unref();

/**
 * 房间是否「空的」：没人在线，且没有任何绘画内容（笔迹 / 底图）。
 *
 * 聊天不算内容 —— 这是绘画软件，一个连一笔都没画过的房间就是探路房，
 * 只因为一句「大家好」就留 12 小时，正是房间列表越堆越乱的原因。
 * 删掉这种房间不会丢任何人的画。
 */
function isBlankRoom(room) {
  if (room.online > 0) return false;
  if (room.strokes.length) return false;
  if (room.layers.some(l => l.baseImage)) return false;
  return true;
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(store.rooms.values())) {
    if (room.online > 0) continue;
    const idle = now - room.lastActiveAt;
    if (isBlankRoom(room) && idle > EMPTY_ROOM_TTL) { store.drop(room.id); continue; }
    if (idle > IDLE_ROOM_TTL) { store.drop(room.id); }
  }
}, 30 * 1000);
sweeper.unref && sweeper.unref();

/**
 * 你画我猜的回合时钟。
 *
 * 唯一的「时钟」是这一个全局定时器 —— 不为每个房间各起一个，免得房间一多
 * 就是几十个 setInterval 抢事件循环。tick 里只做「到点了就换阶段」，
 * 一次遍历的代价可以忽略。
 *
 * 也**不要**在 tick 里碰同步 IO（存盘 / 删目录）：本机实测过一次
 * fs.rmSync 把事件循环堵了 978ms，整个房间的笔迹与心跳全部停摆。
 */
const gameTimer = setInterval(() => {
  if (!store.rooms.size) return;
  const now = Date.now();
  for (const room of store.rooms.values()) {
    const g = room.game;
    if (!g || !g.active) continue;
    try { g.tick(now); } catch (e) { console.error('[game] tick 失败', e.message); }
  }
}, 500);
gameTimer.unref && gameTimer.unref();

function shutdown() {
  console.log('\n[server] 正在保存房间并退出…');
  clearInterval(heartbeat);
  clearInterval(sweeper);
  clearInterval(gcTimer);
  clearInterval(gameTimer);
  store.saveAll();
  try { wss.close(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ── 最后的兜底：别让「一个畸形请求 / 一个漏网的异常」带走整个服务端。
 * 房间是内存里的东西，进程一死所有人的画都断线（存档虽在，但体验归零）。
 * 上面那个 parseReqUrl 修的是已经定位到的那个坑，这里留一层网兜住还没发现的：
 * 记录 + 继续活着，比「干净地崩掉」对用户友好得多。 */
process.on('uncaughtException', (err) => {
  console.error('[server] 未捕获异常（服务继续运行）:', err && err.stack ? err.stack.split('\n')[0] : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] 未处理的 Promise 拒绝（服务继续运行）:', err && err.stack ? err.stack.split('\n')[0] : err);
});
// 客户端在握手/传输层发来畸形数据（比如坏的请求头）也会触发 error 事件；
// 不接住同样会冒泡成 uncaughtException。
server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (e) { /* ignore */ }
});

// ── 空房 GC：回收「没人在线 + 没有任何内容」的房间，避免房间列表堆积
const ROOM_GC_INTERVAL_MS = parseInt(process.env.ROOM_GC_INTERVAL_MS || '30000', 10);       // 30 秒一次
const ROOM_EMPTY_TTL_MS   = parseInt(process.env.ROOM_EMPTY_TTL_MS   || String(EMPTY_ROOM_TTL), 10);

/** 清掉所有空白房间（没人在线、没有笔迹 / 底图 / 聊天），返回被清掉的数量 */
function purgeBlankRooms(maxAgeMs) {
  const now = Date.now();
  const grace = maxAgeMs == null ? ROOM_EMPTY_TTL_MS : maxAgeMs;
  let n = 0;
  for (const room of Array.from(store.rooms.values())) {
    if (!isBlankRoom(room)) continue;
    if (grace > 0 && now - (room.lastActiveAt || 0) <= grace) continue;
    store.drop(room.id);
    n++;
  }
  return n;
}

const gcTimer = setInterval(function () {
  try {
    const n = purgeBlankRooms();
    if (n) console.log('[gc] 回收 ' + n + ' 个空白房间');
  } catch (e) {
    console.error('[gc] 失败', e.message);
  }
}, ROOM_GC_INTERVAL_MS);
gcTimer.unref && gcTimer.unref();

// 端口被占用（比如用户同时开了独立服务端，或者开了两个茶绘）不要直接崩：
// 内置模式下降级成「用已经跑着的那个」，独立运行时给出明确提示。
// ── 监听端口
//
// 抽成函数并**不在这里自动调用**：桌面端的离线模式要 require 这个文件来拿 onClient，
// 那种场合下一个端口都不该占。直接 `node server/src/index.js` 跑时由文件末尾那行
// `require.main === module` 自己监听。
let listening = false;

// 端口被占用时不去抢：内置模式下降级成「用已经跑着的那个」，独立运行时给出明确提示。
// 注册在 listen() 外面 —— listen 可以被调用多次（关掉服务器再开），
// 写在里面就会攒下一堆重复的错误处理器。
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[server] 端口 ' + PORT + ' 已被占用' + (EMBEDDED ? '，改用已存在的服务端' : ''));
  } else {
    console.error('[server] 启动失败：' + (err && err.message));
  }
  if (!EMBEDDED) process.exit(1);
});

function listen() {
  if (listening) return server;
  listening = true;

  // AI 主题那些广播走的是 wss.clients，离线客户端不在里面 —— 离线时没有「别人」，
  // 这条不影响任何功能，所以**刻意不把本地客户端塞进 wss.clients**：
  // 心跳循环会 ping 它们、而它们没有 pong，两轮之后就会被 terminate 掉。
  // 每次重新 listen 都重建 wss（上次 close 过的实例是终态，再也接不上新连接）。
  if (!wss) wss = createWss();

  server.listen(PORT, HOST, () => {
    // 启动时先扫一遍：上次退出后遗留的探路空房不会一直挂在房间列表里
    try {
      const n = purgeBlankRooms(0);
      if (n) console.log('[gc] 启动清理了 ' + n + ' 个空白房间');
    } catch (e) { /* ignore */ }
    const nets = os.networkInterfaces();
    const ips = [];
    for (const k of Object.keys(nets)) {
      for (const n of nets[k] || []) {
        if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
      }
    }
    console.log('════════════════════════════════════════');
    console.log('  茶绘服务端已启动');
    console.log('  本机:   http://localhost:' + PORT);
    ips.forEach(ip => console.log('  局域网: http://' + ip + ':' + PORT));
    console.log('  房间数: ' + store.rooms.size + '（存档目录 ' + DATA_DIR + '）');
    console.log('════════════════════════════════════════');
  });
  return server;
}

/**
 * 停掉监听、释放端口。**桌面端不调它** —— 界面上的「离线模式」只换通道不停服务器
 * （理由见 client/main.js 那段注释）；这条是给独立部署 / 测试用的：
 * 端口被优雅地还回去，房间不销毁，重新 listen() 之后照样在。
 */
function stopListening() {
  return new Promise((resolve) => {
    if (!listening) return resolve(false);
    listening = false;
    const dead = wss;
    wss = null;   // 先摘掉引用：心跳 / 广播立刻看不到任何客户端，也不用等 close 完成
    // 把还连着的客户端剪掉。`server.close()` 的回调要等**所有**连接自己断开才触发，
    // 而用户点「关闭服务器」的意思是**现在**就停，不是「等屋里的人走了再说」。
    // 剪断之后每个 ws 的 close 事件照样走 leaveRoom()，房间存档不受影响。
    try {
      for (const sock of Array.from(dead.clients)) { try { sock.terminate(); } catch (e) { /* ignore */ } }
    } catch (e) { /* ignore */ }
    try { dead.close(); } catch (e) { /* ignore */ }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try { server.close(() => finish(true)); } catch (e) { finish(false); }
    // 兜底：端口释放偶尔会拖一会儿，界面不能一直卡在「正在关闭…」
    setTimeout(() => finish(true), 1500);
  });
}

if (require.main === module) listen();

module.exports = {
  onClient: onClient,
  listen: listen,
  stopListening: stopListening,
  shutdown: shutdown,
  isListening: () => listening,
  store: store
};
