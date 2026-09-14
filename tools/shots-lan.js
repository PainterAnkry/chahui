/**
 * 生成 README 用的「双击即联机」展示图（docs/05-双击即联机.png）。
 *
 * 用法: node tools/shots-lan.js [http://localhost:8437]
 *
 * 与 tools/shots-readme.js 分开的原因：这张图是「入口弹窗」界面，
 * 必须带一个干净的本机连接状态来截图，和主界面那批（01~04）流程不同。
 *
 * 【脱敏】入口弹窗会显示本机局域网地址（形如 http://192.168.x.x:8437），
 * 那是真实的网络信息，不能带进公开仓库。做法有两层：
 *   1. 拦截 /api/share，直接把示例地址喂给页面（页面上根本不存在真实地址）；
 *   2. 截图前再扫一遍文本节点与 input.value，兜底替换内网 IP 与隧道域名。
 * 127.0.0.1 / localhost 是通用回环地址，保留。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('./pw');
const BASE = process.argv[2] || 'http://localhost:8437';
const OUT = path.resolve(__dirname, '..', 'docs');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWPORT = { width: 1500, height: 940 };
const SCALE = 1.6;
const PLACEHOLDER_IP = '192.168.1.23'; // README 里一直在用的示例地址
const maskPage = require('./mask-page').mask;

/** 建房并保持连接，房间才会出现在入口弹窗的列表里 */
async function createRoom(browser, nick, roomName) {
  const pg = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await pg.fill('#nameInput', nick);
  await pg.fill('#newRoomName', roomName);
  await pg.click('#btnCreateRoom');
  await pg.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  return pg;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const keep = [];

  // 先摆几个房间，让列表看起来是活的
  keep.push(await createRoom(browser, 'Ankry', '周末茶绘'));
  keep.push(await createRoom(browser, '小白', '一起画个小人'));
  await sleep(600);

  // 再开一张干净的「入口弹窗」页来截图
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  // 拦截 /api/share：用示例地址顶掉真实的本机局域网地址。
  // 拦截比截后打码更彻底——页面上从头到尾就不存在真实地址。
  await page.route('**/api/share', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ publicUrl: '', lanUrls: ['http://' + PLACEHOLDER_IP + ':8437'] })
  }));

  // 入口里的「本机已开好服务器」提示条用的是 URL 上的 ?lan=<ip>&port=<端口>
  // （正式运行时由桌面端主进程注入）。这里直接喂示例值，真实内网 IP 不进页面。
  await page.goto(BASE + '/?lan=' + PLACEHOLDER_IP + '&port=8437', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 12000 });
  await page.fill('#nameInput', 'Ankry');
  await sleep(1200); // 等房间列表刷新

  await page.evaluate(maskPage);
  await sleep(150);
  // 复核：页面上不该再有任何内网 IP 残留（占位符本身长这样，要排除掉）
  const leaked = await page.evaluate((ph) => {
    const RE = /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g;
    const hits = [];
    const t = document.body.innerText;
    let m; while ((m = RE.exec(t))) { if (m[0] !== ph) hits.push(m[0]); }
    for (const el of document.querySelectorAll('input')) {
      if (!el.value) continue;
      for (const h of (el.value.match(RE) || [])) { if (h !== ph) hits.push(h); }
    }
    return hits;
  }, PLACEHOLDER_IP);
  if (leaked.length) {
    console.log('⚠ 脱敏后仍有真实地址残留：', leaked.join(' / '));
  } else {
    console.log('脱敏检查通过：页面无内网 IP');
  }

  await page.screenshot({ path: path.join(OUT, '05-双击即联机.png') });
  console.log('已存 docs/05-双击即联机.png');

  for (const p of keep) await p.close().catch(() => { /* ignore */ });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
