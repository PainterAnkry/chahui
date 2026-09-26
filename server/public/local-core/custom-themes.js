'use strict';

const P = require('./protocol');

/**
 * 用户自定义主题词库 —— 运行时持久化，不需要改代码也不需要重启。
 *
 * 为什么不是「环境变量 / 改 themes.js」：
 *   主题词库是**给不写代码的人用的**。同事想加一套「我们公司梗」，
 *   让他去改 themes.js 重启服务端不现实 —— 所以他能在前端直接填。
 *
 * ⚠️ 和内置词库一样：**只存服务端、只下发名字**。
 * 前端能读到的只有「有哪些主题」，任何一个词都不下发。
 *
 * 存放位置：server/data/themes.json
 *   { "themes": [ { "id": "u1", "name": "我们公司", "words": ["摸鱼", "加班"] } ] }
 *
 * id 一律是 `u` + 数字（u = user），和内置主题的英文 id 天然不冲突。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'themes.json');

const MIN_WORDS = 3;      // 少于 3 个词没法开局（候选要 3 个）
const MAX_THEMES = 20;    // 上限，防止有人往里面塞几万条把内存吃掉
const MAX_WORDS = 300;    // 单套词库上限
const MAX_NAME_LEN = 12;  // 主题名长度

/** 内存镜像：{ id: { id, name, words } }，加载一次后常驻 */
let store = Object.create(null);
let nextId = 1;

/** 存档格式坏了不该让服务器起不来 —— 大不了当空的，用户重填即可 */
function load() {
  store = Object.create(null);
  nextId = 1;
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = Array.isArray(raw && raw.themes) ? raw.themes : [];
    for (const t of list) {
      const one = normalizeEntry(t);
      if (!one) continue;
      store[one.id] = one;
      const n = Number(String(one.id).slice(1));
      if (isFinite(n) && n >= nextId) nextId = n + 1;
    }
  } catch (e) {
    // 读坏了就当没有。保持静默（启动日志里不该因为这个刷一屏红字）
    store = Object.create(null);
    nextId = 1;
  }
}

/**
 * 校验并归一化一条用户主题。
 *
 * 词的门槛和内置词库完全一致：**2 字以上的纯中文**。
 * 这条绝不能放宽 —— 单字词会让接龙的「编辑距离 ≤ 1」判定彻底失效
 * （任何字与单字答案的距离都是 1，猜手会不停收到「很接近了」）。
 */
function normalizeEntry(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id || '').trim();
  const name = String(t.name || '').trim().slice(0, MAX_NAME_LEN);
  if (!/^u\d+$/.test(id) || !name) return null;

  const seen = new Set();
  const words = [];
  const src = Array.isArray(t.words) ? t.words : [];
  for (const w of src) {
    const s = String(w || '').trim();
    if (!s) continue;
    if (!P.isPlayableWord(s)) continue;   // 不合格的直接丢掉（不炸启动）
    if (seen.has(s)) continue;
    seen.add(s);
    words.push(s);
    if (words.length >= MAX_WORDS) break;
  }
  if (!words.length) return null;
  return { id, name, words };
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const themes = Object.keys(store).map(k => store[k]);
    // 先写临时文件再 rename —— 中途崩了不会留下半个 JSON
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ themes }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    return false;
  }
}

load();

/* ------------------------------------------------------------ 查询 */

/** 用户主题的列表（只有 id 与 name，**不带词**） */
function list() {
  return Object.keys(store)
    .map(k => store[k])
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map(t => ({ id: t.id, name: t.name, count: t.words.length }));
}

function wordsOf(id) {
  const t = store[id];
  return t ? t.words.slice() : null;
}

function nameOf(id) {
  const t = store[id];
  return t ? t.name : '';
}

function has(id) { return !!store[id]; }

/* ------------------------------------------------------------ 增删改 */

/**
 * 解析用户粘贴的一坨词。分隔符随便用（逗号 / 顿号 / 空格 / 换行 / 分号）。
 *
 * 返回 { ok, words, rejected }：
 *   rejected 是「被丢掉的词」的原文 —— **必须回显给用户**。
 *   静默丢词是最气人的交互：用户以为存进去了，结果开局抽不到。
 */
function parseWords(text) {
  const parts = String(text || '')
    .split(/[,，、;；\s\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const words = [];
  const rejected = [];
  const seen = new Set();
  for (const p of parts) {
    if (!P.isPlayableWord(p)) { rejected.push(p); continue; }
    if (seen.has(p)) continue;                          // 重复的静默去重（不算错）
    seen.add(p);
    words.push(p);
    if (words.length >= MAX_WORDS) break;
  }
  return { ok: words.length >= MIN_WORDS, words, rejected, min: MIN_WORDS };
}

/** 新建一套。返回 { ok, id } 或 { ok:false, message } */
function create(name, text) {
  const nm = String(name || '').trim().slice(0, MAX_NAME_LEN);
  if (!nm) return { ok: false, message: '给这套词库起个名字吧' };
  if (Object.keys(store).length >= MAX_THEMES) {
    return { ok: false, message: '最多存 ' + MAX_THEMES + ' 套自定义词库' };
  }
  const parsed = parseWords(text);
  if (!parsed.ok) {
    return {
      ok: false, message: '至少要有 ' + MIN_WORDS + ' 个合格的词（2 字以上的中文），现在只有 ' + parsed.words.length + ' 个',
      rejected: parsed.rejected
    };
  }
  const id = 'u' + nextId++;
  store[id] = { id, name: nm, words: parsed.words };
  save();
  return { ok: true, id, name: nm, count: parsed.words.length, rejected: parsed.rejected };
}

/** 改一套（名字 / 词）。只传 name 就只改名 */
function update(id, name, text) {
  const t = store[id];
  if (!t) return { ok: false, message: '没有这套词库' };
  if (name != null) {
    const nm = String(name).trim().slice(0, MAX_NAME_LEN);
    if (!nm) return { ok: false, message: '名字不能为空' };
    t.name = nm;
  }
  if (text != null) {
    const parsed = parseWords(text);
    if (!parsed.ok) {
      return {
        ok: false,
        message: '至少要有 ' + MIN_WORDS + ' 个合格的词，现在只有 ' + parsed.words.length + ' 个',
        rejected: parsed.rejected
      };
    }
    t.words = parsed.words;
    return { ok: true, id, name: t.name, count: t.words.length, rejected: parsed.rejected };
  }
  save();
  return { ok: true, id, name: t.name, count: t.words.length, rejected: [] };
}

function remove(id) {
  if (!store[id]) return { ok: false, message: '没有这套词库' };
  delete store[id];
  save();
  return { ok: true };
}

/** 给 /api/share 用的自检指纹：用户改过词库后测试能一眼看出服务端换了 */
function signature() {
  return Object.keys(store).sort().map(k => k + ':' + store[k].words.length).join(',');
}

module.exports = {
  list, wordsOf, nameOf, has,
  create, update, remove,
  parseWords, signature,
  MIN_WORDS, MAX_THEMES, MAX_WORDS, MAX_NAME_LEN,
  FILE
};
