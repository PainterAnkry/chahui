/**
 * 统一的 Playwright 定位。
 *
 * 以前每个脚本都写死了一条本机路径（C:/Users/<某人>/...），既泄露隐私，
 * 别人 clone 下来也跑不了。现在按下面的顺序找，找不到就给一句人话：
 *
 *   1. 环境变量 CHAHU_PLAYWRIGHT（指向 playwright-core 目录或包名）
 *   2. 直接 require('playwright-core')  —— 装在本项目里
 *   3. 直接 require('playwright')
 *   4. 常见的全局 / 隔壁目录（只兜底，不写死用户名）
 *
 * 用法： const { chromium } = require('./pw');
 */
'use strict';

const path = require('path');
const fs = require('fs');

function tryLoad(name) {
  try { return require(name); } catch (e) { return null; }
}

function tryPath(p) {
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    return require(p);
  } catch (e) { return null; }
}

function resolve() {
  // 1) 环境变量
  const env = process.env.CHAHU_PLAYWRIGHT;
  if (env) {
    const hit = tryPath(env) || tryPath(path.join(env, 'node_modules', 'playwright-core')) || tryLoad(env);
    if (hit) return hit;
  }
  // 2) 本项目依赖
  const local = tryLoad('playwright-core') || tryLoad('playwright');
  if (local) return local;

  // 3) 兜底：向上找几层 node_modules，以及几个常见的全局安装位置
  const roots = [];
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(dir, 'node_modules'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'));
  // WorkBuddy 风格的托管 node 工作区：npm 包常装在这里，而它不在向上查找的链路里。
  // 用 os.homedir() 推导，不写死用户名。
  try {
    roots.push(path.join(require('os').homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'));
  } catch (e) { /* ignore */ }
  for (const r of roots) {
    const hit = tryPath(path.join(r, 'playwright-core')) || tryPath(path.join(r, 'playwright'));
    if (hit) return hit;
  }

  console.error([
    '',
    '找不到 playwright-core。浏览器类的测试需要它。任选一种：',
    '  1) 在项目根目录安装：  npm i -D playwright-core',
    '     （playwright-core 不会下载浏览器，用它本机已有的 Chrome 即可）',
    '  2) 已经装在别处的话，指一下：',
    '     CHAHU_PLAYWRIGHT=/path/to/node_modules/playwright-core node tools/test-browser.js',
    ''
  ].join('\n'));
  process.exit(3);
}

const pw = resolve();
module.exports = pw;
module.exports.chromium = pw.chromium;
