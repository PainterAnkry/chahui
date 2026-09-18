/**
 * 茶绘 · 「离线模式」按钮的界面回归
 *
 * 纯 Node 那条（test-server-toggle.js）验的是**服务端**真的停了 / 真的又开了；
 * 这一条验的是**按钮这头**有没有接对：
 *
 *   · 网页版（没有桌面端桥）→ 整行藏起来，不摆一个点了没反应的按钮
 *   · 桌面端 → 按钮文案是「动作」、右边小字是「状态」，两者不混
 *   · 点「切到离线」→ **不许**调 serverStop（服务器要留在后台跑）、换到离线通道
 *                    （local://）、状态栏写「离线模式」、按钮翻成「连回服务器」、
 *                    局域网地址**照旧**有效（服务器还在）→ 菜单里那个勾要勾上
 *   · 点「连回服务器」→ 服务器本来就在跑所以**不许**再调 serverStart，
 *                    把离线会话收掉（不收会留下幽灵客户端占着本地房间），连回真服务器
 *   · 服务器真没起来（配置里关了内置服务器）→ 按钮写「开启服务器」，点了才真去起
 *
 * 桌面端的桥用 addInitScript 打桩，所以不需要真的起 Electron。
 * 唯一「真」的部分是：回到在线之后它真的去连了 BASE 上那个服务端。
 *
 * 用法: node tools/test-server-button.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8437';
// 假桥里 serverStart 报的端口必须和 BASE 上真正跑着的服务端一致 ——
// 最后一步是**真的**去连它，端口写死就只能在某个固定端口上跑。
const PORT = Number((/^https?:\/\/[^/:]+:(\d+)/.exec(BASE) || [])[1] || 80);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}

/** 打进页面里的假桌面端桥。on = 服务器现在开着吗 */
function fakeBridge(on, port) {
  return `
    window.__srv = { on: ${on ? 'true' : 'false'}, port: ${port || 0}, lan: ${on ? '["192.168.1.50"]' : '[]'} };
    window.__log = [];
    window.chahuDesktop = {
      isDesktop: true,
      serverStatus: function () {
        return Promise.resolve({ on: window.__srv.on, port: window.__srv.port, lan: window.__srv.lan, local: false });
      },
      serverStart: function () {
        window.__log.push('start');
        window.__srv.on = true; window.__srv.port = ${port}; window.__srv.lan = ['192.168.1.50'];
        return Promise.resolve({ ok: true, port: ${port}, lan: window.__srv.lan });
      },
      // 这一条**不该被调到**（离线只是换通道，不停服务器），留着当探针
      serverStop: function () {
        window.__log.push('stop');
        window.__srv.on = false; window.__srv.lan = [];
        return Promise.resolve({ ok: true });
      },
      // 离线通道：不占端口。客户端拿到 ok 之后就会认为「连上了」，够界面切过去
      localOpen: function () {
        window.__log.push('localOpen');
        return Promise.resolve({ ok: true, connId: 'clocal' });
      },
      localFeed: function (raw) {
        // 客户端会发心跳，回一个 PONG，免得日志里一直堆「没回包」
        try { if (JSON.parse(raw).t === 'ping') return true; } catch (e) { /* ignore */ }
        return true;
      },
      localClose: function () { window.__log.push('localClose'); return Promise.resolve(true); },
      onLocalMessage: function (cb) { window.__localCb = cb; return function () { window.__localCb = null; }; },
      onServerState: function (cb) { window.__srvCb = cb; return function () { /* ignore */ }; }
    };
  `;
}

const btn = p => p.textContent('#btnServerToggle').then(t => t.trim());
const st = p => p.textContent('#srvState');
const log = p => p.evaluate(() => window.__log.join(','));
const clearLog = p => p.evaluate(() => { window.__log = []; });
const menuChecked = p => p.evaluate(() => {
  var r = document.querySelector('#menuBar [data-action="other.server"]');
  return !!r && /✓/.test(r.querySelector('.mrow-mark').textContent);
});

(async () => {
  console.log('茶绘 离线模式按钮测试 @ ' + BASE + '\n');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];

  try {
    // ---------------------------------------------------------- 1) 网页版
    console.log('=== 1) 网页版：这一行应该藏起来 ===');
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push('web: ' + e.message));
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('!!window.ChaApp', null, { timeout: 15000 });
      await page.evaluate(() => window.ChaApp.openEntry(true));
      await sleep(250);
      ok('入口面板打开了', await page.isVisible('#entryMask'));
      ok('「离线模式」那一行是藏起来的', !(await page.isVisible('#srvRow')));
      await ctx.close();
    }

    // ---------------------------------------------------------- 2) 桌面端：显示状态
    console.log('\n=== 2) 桌面端（服务器在跑、当前在线）：按钮文案与状态 ===');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(fakeBridge(true, PORT));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('desktop: ' + e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.ChaApp', null, { timeout: 15000 });
    await sleep(600);   // 等 serverStatus 那个 promise 落地

    await page.evaluate(() => window.ChaApp.openEntry(true));
    await sleep(300);
    ok('「离线模式」那一行显示出来了', await page.isVisible('#srvRow'));
    ok('按钮写的是「切到离线」（服务器正开着、人也在线）',
      (await btn(page)) === '切到离线', await btn(page));
    ok('状态小字说明「已开启」并带上局域网地址',
      /已开启/.test(await st(page)) && /192\.168\.1\.50/.test(await st(page)), (await st(page)).trim());
    ok('局域网提示条也出现了（地址是后补进去的）',
      await page.evaluate(() => !!window.ChaConfig.lanBase()),
      await page.evaluate(() => window.ChaConfig.lanBase()));
    ok('在线时菜单里那一项不勾（离线模式没开）', !(await menuChecked(page)));
    // 专项守一条曾经踩过的坑：提示文字太长时把按钮那一列挤成 0 宽，按钮被画到提示
    // 底下 —— 看着在、点不到（Playwright 的命中测试就是靠这个报错的）。
    ok('按钮真的点得到（中心点没被提示文字盖住）', await page.evaluate(() => {
      var b = document.querySelector('#btnServerToggle').getBoundingClientRect();
      var hit = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      return !!(hit && (hit.id === 'btnServerToggle' || (hit.closest && hit.closest('#btnServerToggle'))));
    }), await page.evaluate(() => {
      var b = document.querySelector('#btnServerToggle').getBoundingClientRect();
      var hit = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      return hit ? (hit.tagName + '#' + hit.id) : 'null';
    }));
    ok('按钮那一列有宽度（没被提示压成 0）',
      await page.evaluate(() => document.querySelector('#btnServerToggle').getBoundingClientRect().width >= 80),
      await page.evaluate(() => Math.round(document.querySelector('#btnServerToggle').getBoundingClientRect().width)));

    // ---------------------------------------------------------- 3) 切到离线
    console.log('\n=== 3) 点「切到离线」：只换通道，不停服务器 ===');
    await clearLog(page);
    await page.click('#btnServerToggle');
    await sleep(800);
    ok('**没有**调 serverStop（这是本次改动的核心）',
      (await log(page)).indexOf('stop') < 0, await log(page));
    ok('服务器状态没被动过（仍然是开着的）',
      await page.evaluate(() => window.__srv.on === true) &&
      await page.evaluate(() => window.ChaApp.serverState().on === true),
      await page.evaluate(() => JSON.stringify({ fake: window.__srv.on, ui: window.ChaApp.serverState().on })));
    ok('调了 localOpen（切到离线通道）', (await log(page)).indexOf('localOpen') >= 0, await log(page));
    ok('客户端现在走的是离线通道', await page.evaluate(() => window.ChaApp.net.isLocal() === true));
    ok('网络地址变成了 local://', await page.evaluate(() => window.ChaApp.net.url) === 'local://',
      await page.evaluate(() => window.ChaApp.net.url));
    ok('客户端认为自己是连接着的（离线也能画）', await page.evaluate(() => window.ChaApp.net.isOpen() === true));
    ok('状态栏写「离线模式」', /离线模式/.test(await page.textContent('#statusText')),
      (await page.textContent('#statusText')).trim());
    await page.evaluate(() => window.ChaApp.openEntry(true));
    await sleep(250);
    ok('按钮翻成「连回服务器」', (await btn(page)) === '连回服务器', await btn(page));
    ok('状态小字写「已开启（后台运行）· 当前离线」',
      /已开启/.test(await st(page)) && /后台运行/.test(await st(page)) && /当前离线/.test(await st(page)),
      (await st(page)).trim());
    ok('局域网地址**还在**（服务器没停，地址照样有效）',
      /192\.168\.1\.50/.test(await st(page)) && await page.evaluate(() => !!window.ChaConfig.lanBase()),
      await page.evaluate(() => window.ChaConfig.lanBase()));
    ok('菜单里那个勾**勾上**了（现在处于离线档）', await menuChecked(page));

    // ---------------------------------------------------------- 4) 连回在线
    console.log('\n=== 4) 点「连回服务器」：真的连回服务端 ===');
    await clearLog(page);
    await page.click('#btnServerToggle');
    await sleep(1500);
    ok('**没有**再调 serverStart（服务器本来就在跑）',
      (await log(page)).indexOf('start') < 0, await log(page));
    ok('离线会话被收掉了（不留幽灵客户端）',
      (await log(page)).indexOf('localClose') >= 0, await log(page));
    ok('不再走离线通道', await page.evaluate(() => window.ChaApp.net.isLocal() === false));
    ok('连的是本机服务器的地址', await page.evaluate(() => window.ChaApp.net.url) === 'ws://localhost:' + PORT + '/ws',
      await page.evaluate(() => window.ChaApp.net.url));
    ok('确实连上了（WebSocket 握手完成）', await page.evaluate(() => window.ChaApp.net.isOpen() === true));
    ok('拿到了服务端分配的 connId', await page.evaluate(() => !!window.ChaApp.net.selfId),
      await page.evaluate(() => window.ChaApp.net.selfId));
    ok('状态栏回到「已连接 …」', /已连接/.test(await page.textContent('#statusText')),
      (await page.textContent('#statusText')).trim());
    ok('局域网提示条还在', await page.evaluate(() => !!window.ChaConfig.lanBase()));
    ok('菜单里那个勾去掉了（回到在线档）', !(await menuChecked(page)));

    await ctx.close();

    // ---------------------------------------------------------- 5) 服务器没起来
    console.log('\n=== 5) 服务器根本没起来：按钮该是「开启服务器」 ===');
    {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await ctx2.addInitScript(fakeBridge(false, PORT));
      const p2 = await ctx2.newPage();
      p2.on('pageerror', e => errors.push('desktop-off: ' + e.message));
      await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await p2.waitForFunction('!!window.ChaApp', null, { timeout: 15000 });
      await sleep(600);
      await p2.evaluate(() => window.ChaApp.openEntry(true));
      await sleep(300);
      ok('按钮写「开启服务器」', (await btn(p2)) === '开启服务器', await btn(p2));
      ok('状态写「已关闭」', /已关闭/.test(await st(p2)), (await st(p2)).trim());

      await clearLog(p2);
      await p2.click('#btnServerToggle');
      await sleep(1500);
      ok('这次才真的调 serverStart', (await log(p2)).indexOf('start') >= 0, await log(p2));
      ok('仍然没调 serverStop', (await log(p2)).indexOf('stop') < 0, await log(p2));
      ok('连上了服务端', await p2.evaluate(() => window.ChaApp.net.isOpen() === true));
      ok('状态栏「已连接」', /已连接/.test(await p2.textContent('#statusText')),
        (await p2.textContent('#statusText')).trim());
      await ctx2.close();
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== 全程无 JS 报错 ===');
  ok('没有未捕获的异常', errors.length === 0, errors.join(' | '));

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n测试崩了：', e);
  process.exit(1);
});
