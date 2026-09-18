/**
 * 茶绘 · 「开启 / 关闭服务器」按钮的界面回归
 *
 * 纯 Node 的那条（test-server-toggle.js）验的是服务端真的停了 / 真的又开了；
 * 这一条验的是**按钮这头**有没有接对：
 *
 *   · 网页版（没有桌面端桥）→ 整行藏起来，不摆一个点了没反应的按钮
 *   · 桌面端 → 按钮文案是「动作」、右边小字是「状态」，两者不混
 *   · 点「关闭服务器」→ 调 serverStop，客户端换到离线通道（local://），
 *                        状态栏写「离线模式」，按钮翻成「开启服务器」
 *   · 点「开启服务器」→ 调 serverStart，客户端连回真实服务器（这里是测试用的那个），
 *                        同时**把离线会话收掉**（不收会留下一个幽灵客户端占着本地房间）
 *
 * 桌面端的桥用 addInitScript 打桩，所以不需要真的起 Electron。
 * 唯一「真」的部分是：turn on 之后它真的去连了 BASE 上那个服务端。
 *
 * 用法: node tools/test-server-button.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8437';
// 假桥里 serverStart 报的端口必须和 BASE 上真正跑着的服务端一致 ——
// 第 4 步是**真的**去连它，端口写死就只能在某个固定端口上跑。
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

(async () => {
  console.log('茶绘 服务器开关按钮测试 @ ' + BASE + '\n');
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
      ok('「本机服务器」那一行是藏起来的', !(await page.isVisible('#srvRow')));
      await ctx.close();
    }

    // ---------------------------------------------------------- 2) 桌面端：显示状态
    console.log('\n=== 2) 桌面端：按钮文案与状态 ===');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(fakeBridge(true, PORT));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('desktop: ' + e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.ChaApp', null, { timeout: 15000 });
    await sleep(600);   // 等 serverStatus 那个 promise 落地

    await page.evaluate(() => window.ChaApp.openEntry(true));
    await sleep(300);
    ok('「本机服务器」那一行显示出来了', await page.isVisible('#srvRow'));
    ok('按钮写的是「关闭服务器」（服务器正开着）',
      (await page.textContent('#btnServerToggle')).trim() === '关闭服务器',
      (await page.textContent('#btnServerToggle')).trim());
    ok('状态小字说明「已开启」并带上局域网地址',
      /已开启/.test(await page.textContent('#srvState')) && /192\.168\.1\.50/.test(await page.textContent('#srvState')),
      (await page.textContent('#srvState')).trim());
    ok('局域网提示条也出现了（地址是后补进去的）',
      await page.evaluate(() => !!window.ChaConfig.lanBase()),
      await page.evaluate(() => window.ChaConfig.lanBase()));
    ok('菜单里那一项也勾上了（其他 → 本机服务器）',
      await page.evaluate(() => {
        var rows = document.querySelectorAll('#menuBar [data-action="other.server"]');
        return rows.length === 1 && /✓/.test(rows[0].querySelector('.mrow-mark').textContent);
      }));

    // ---------------------------------------------------------- 3) 关掉
    console.log('\n=== 3) 点「关闭服务器」 ===');
    await page.click('#btnServerToggle');
    await sleep(800);
    ok('调了 serverStop', (await page.evaluate(() => window.__log)).indexOf('stop') >= 0,
      await page.evaluate(() => window.__log.join(',')));
    ok('调了 localOpen（切到离线通道）', (await page.evaluate(() => window.__log)).indexOf('localOpen') >= 0);
    ok('客户端现在走的是离线通道', await page.evaluate(() => window.ChaApp.net.isLocal() === true));
    ok('网络地址变成了 local://', await page.evaluate(() => window.ChaApp.net.url) === 'local://',
      await page.evaluate(() => window.ChaApp.net.url));
    ok('客户端认为自己是连接着的（离线也能画）', await page.evaluate(() => window.ChaApp.net.isOpen() === true));
    ok('状态栏写「离线模式 · 本机独自画，不联机」',
      /离线模式/.test(await page.textContent('#statusText')), (await page.textContent('#statusText')).trim());
    await page.evaluate(() => window.ChaApp.openEntry(true));
    await sleep(250);
    ok('按钮翻成「开启服务器」',
      (await page.textContent('#btnServerToggle')).trim() === '开启服务器',
      (await page.textContent('#btnServerToggle')).trim());
    ok('状态小字改成「已关闭 · 离线模式」',
      /已关闭/.test(await page.textContent('#srvState')) && /离线模式/.test(await page.textContent('#srvState')),
      (await page.textContent('#srvState')).trim());
    ok('局域网提示条收起来了', await page.evaluate(() => !window.ChaConfig.lanBase()));
    ok('菜单里的勾去掉了', await page.evaluate(() => {
      var r = document.querySelector('#menuBar [data-action="other.server"]');
      return !!r && r.querySelector('.mrow-mark').textContent === '';
    }));

    // ---------------------------------------------------------- 4) 再开（真的连回服务端）
    console.log('\n=== 4) 点「开启服务器」：真的连回服务端 ===');
    await page.click('#btnServerToggle');
    await sleep(1500);
    ok('调了 serverStart', (await page.evaluate(() => window.__log)).indexOf('start') >= 0);
    ok('离线会话被收掉了（不留幽灵客户端）',
      (await page.evaluate(() => window.__log)).indexOf('localClose') >= 0,
      await page.evaluate(() => window.__log.join(',')));
    ok('不再走离线通道', await page.evaluate(() => window.ChaApp.net.isLocal() === false));
    ok('连的是本机服务器的地址', await page.evaluate(() => window.ChaApp.net.url) === 'ws://localhost:' + PORT + '/ws',
      await page.evaluate(() => window.ChaApp.net.url));
    ok('确实连上了（WebSocket 握手完成）', await page.evaluate(() => window.ChaApp.net.isOpen() === true));
    ok('拿到了服务端分配的 connId', await page.evaluate(() => !!window.ChaApp.net.selfId),
      await page.evaluate(() => window.ChaApp.net.selfId));
    ok('状态栏回到「已连接 …」', /已连接/.test(await page.textContent('#statusText')),
      (await page.textContent('#statusText')).trim());

    await ctx.close();
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
