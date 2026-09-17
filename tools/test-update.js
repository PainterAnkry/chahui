/**
 * 更新检测回归。
 *
 * 这个功能要解决的是「别让人自己去 GitHub 的 Releases 页面里挑文件名」——
 * 那一步正是最容易下错的（便携版 / 安装包 / 源码 zip 混在一起）。
 * 所以重点有两块：
 *
 *   ① `pickUpdateAsset()` 是个**纯函数**（不碰 DOM、不碰网络），直接拿假 release 数据喂它，
 *      把「这台机器该下哪一个」的规则钉死：Windows 安装包优先于便携版、Mac 认 dmg、
 *      Linux 认 AppImage，认不出就返回 null（调用方退回手动下载，不假装能一键下）。
 *   ② 整条 UI 流程用**顶掉的 fetch** 灌一份假的 release 走一遍 —— 这样测的是真代码路径
 *      （checkUpdate → 挑包 → 露出按钮 → 点它 → downloadUpdate），而不是我看一遍源码觉得对。
 *
 * 覆盖：
 *   1. pickUpdateAsset：Win / Mac / Linux 各自的优先级与兜底
 *   2. pickUpdateAsset：数据不干净时返回 null（空 assets / 缺下载地址 / 只有源码 zip）
 *   3. cmpVer：版本比较（决定要不要提示更新）
 *   4. DOM：更新区与按钮就位，按钮默认是藏着的
 *   5. 假 release（有新版本 + 有 exe）：提示里点名要下哪个包，按钮露出来
 *   6. 点按钮：走 blob 下载这条路（**不把人带去 GitHub 页面**）
 *   7. 假 release（有新版本但没认得出的包）：老实给 Releases 链接，不露按钮
 *   8. 假 release（就是当前版本）：说「已经是最新版」，不露按钮
 *   9. 恢复网络后真跑一次：有结论、不会卡在「正在检查更新…」
 *
 * 用法: node tools/test-update.js [http://127.0.0.1:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8437';

/** 几份假 release：都长得像 GitHub API 真正回的那份 */
const FAKE = {
  full: {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/PainterAnkry/chahui/releases/tag/v9.9.9',
    assets: [
      { name: 'chahui-portable-9.9.9.exe', size: 3145728, browser_download_url: 'https://example.invalid/portable.exe' },
      { name: 'chahui-setup-9.9.9.exe', size: 4194304, browser_download_url: 'https://example.invalid/setup.exe' },
      { name: 'source-code.zip', size: 1024, browser_download_url: 'https://example.invalid/src.zip' }
    ]
  },
  noAsset: {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/PainterAnkry/chahui/releases/tag/v9.9.9',
    assets: [
      { name: 'source-code.zip', size: 1024, browser_download_url: 'https://example.invalid/src.zip' },
      { name: 'Source code (tar.gz)', size: 900, browser_download_url: 'https://example.invalid/src.tar.gz' }
    ]
  }
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await sleep(400);
  const cur = await page.evaluate(() => (window.CHAHU_CONFIG && window.CHAHU_CONFIG.appVersion) || '0.0.0');
  console.log('\n当前版本 v' + cur + '，页面已就绪');

  /* ================= 1) pickUpdateAsset：平台优先级 ================= */
  console.log('\n=== 1) 挑包规则（纯函数，喂假数据）===');
  const pick = await page.evaluate(() => {
    const f = window.ChaApp.pickUpdateAsset;
    const A = 'chahui-portable-1.0.0.exe', S = 'chahui-setup-1.0.0.exe';
    const mk = names => ({ assets: names.map(n => ({ name: n, browser_download_url: 'https://x.invalid/' + n })) });
    return {
      // Windows：便携版排在前面也应该挑安装包
      winPrefers: f(mk([A, S]), 'win32'),
      winOnlyPortable: f(mk([A]), 'win32'),
      winGenericSetup: f(mk(['chahui-setup-x.exe', 'chahui-portable-y.exe']), 'win32'),
      winBareExe: f(mk(['something.exe']), 'win32'),
      winUpper: f(mk([A, S]), 'Win32'),
      winNoExe: f(mk(['a.zip', 'b.dmg']), 'win32'),
      // Mac
      macDmg: f(mk(['a.zip', 'b.dmg']), 'darwin'),
      macOnlyZip: f(mk(['a.zip']), 'darwin'),
      macApk: f(mk(['a.exe']), 'darwin'),
      // Linux
      linuxAppImage: f(mk(['a.deb', 'b.AppImage']), 'linux'),
      linuxDeb: f(mk(['a.deb']), 'linux'),
      linuxTarGz: f(mk(['chahui-linux-x64.tar.gz']), 'linux'),
      linuxZipOnly: f(mk(['a.zip']), 'linux'),
      // 脏数据
      empty: f({ assets: [] }, 'win32'),
      noRel: f(null, 'win32'),
      noUrl: f({ assets: [{ name: 'chahui-setup-1.exe' }] }, 'win32')
    };
  });
  const nm = a => (a && a.name) || null;
  ok('Windows：安装包优先于便携版（哪怕便携版排在前面）', nm(pick.winPrefers) === 'chahui-setup-1.0.0.exe', nm(pick.winPrefers));
  ok('Windows：只有便携版时就用便携版', nm(pick.winOnlyPortable) === 'chahui-portable-1.0.0.exe', nm(pick.winOnlyPortable));
  ok('Windows：认通用的 xxx-setup-*.exe 命名', nm(pick.winGenericSetup) === 'chahui-setup-x.exe', nm(pick.winGenericSetup));
  ok('Windows：兜底认得任何 .exe', nm(pick.winBareExe) === 'something.exe', nm(pick.winBareExe));
  ok('平台名大小写不影响（Win32 ≈ win32）', nm(pick.winUpper) === 'chahui-setup-1.0.0.exe', nm(pick.winUpper));
  ok('Windows：只有 zip / dmg 时返回 null（不硬塞一个装不了的）', pick.winNoExe === null, pick.winNoExe);
  ok('Mac：dmg 优先于 zip', nm(pick.macDmg) === 'b.dmg', nm(pick.macDmg));
  ok('Mac：只有 zip 时用 zip', nm(pick.macOnlyZip) === 'a.zip', nm(pick.macOnlyZip));
  ok('Mac：Windows 的 exe 不会被当成 Mac 的包', pick.macApk === null, pick.macApk);
  ok('Linux：AppImage 优先于 deb', nm(pick.linuxAppImage) === 'b.AppImage', nm(pick.linuxAppImage));
  ok('Linux：只有 deb 时用 deb', nm(pick.linuxDeb) === 'a.deb', nm(pick.linuxDeb));
  ok('Linux：认 .tar.gz（我们自己发的 Linux 包就是 tar.gz）',
    nm(pick.linuxTarGz) === 'chahui-linux-x64.tar.gz', nm(pick.linuxTarGz));
  ok('Linux：只有 zip 时返回 null（Linux 上没有装机包就别硬塞）', pick.linuxZipOnly === null, pick.linuxZipOnly);
  ok('空 assets → null', pick.empty === null, pick.empty);
  ok('release 为 null → null', pick.noRel === null, pick.noRel);
  ok('资产缺 browser_download_url → 跳过', pick.noUrl === null, pick.noUrl);

  /* ================= 2) cmpVer ================= */
  console.log('\n=== 2) 版本比较 ===');
  const cmp = await page.evaluate(() => {
    const c = window.ChaApp.cmpVer;
    return {
      up: c('1.9.0', '1.8.4'), same: c('1.8.4', '1.8.4'), down: c('1.8.3', '1.8.4'),
      minorUp: c('1.10.0', '1.9.9'), shortA: c('1.9', '1.9.0')
    };
  });
  ok('1.9.0 > 1.8.4', cmp.up > 0, cmp.up);
  ok('1.8.4 == 1.8.4', cmp.same === 0, cmp.same);
  ok('1.8.3 < 1.8.4', cmp.down < 0, cmp.down);
  ok('1.10.0 > 1.9.9（按数字比，不是按字符串）', cmp.minorUp > 0, cmp.minorUp);
  ok('1.9 与 1.9.0 视为相同（缺的位补 0）', cmp.shortA === 0, cmp.shortA);

  /* ================= 3) DOM 就位 ================= */
  console.log('\n=== 3) 更新区就位 ===');
  const dom = await page.evaluate(() => {
    const b = document.getElementById('btnDoUpdate');
    return {
      box: !!document.getElementById('aboutUpdate'),
      msg: !!document.getElementById('aboutUpdateMsg'),
      btn: !!b,
      hidden: !!(b && b.classList.contains('hidden')),
      text: b ? b.textContent : ''
    };
  });
  ok('更新区 / 说明文字 / 下载按钮都在', dom.box && dom.msg && dom.btn, JSON.stringify(dom));
  ok('下载按钮默认是藏着的（没新版本就不该出现）', dom.hidden, dom.hidden);

  /* ================= 4) 有新版本 + 有包：点名要下哪个 ================= */
  console.log('\n=== 4) 假 release（有新版本、有 exe）===');
  await page.evaluate(f => {
    window.__origFetch = window.fetch;
    // 顶掉网络：release 查询回假数据，资产请求抛错（用来验证「下不动时」不崩）
    window.fetch = async u => {
      if (String(u).indexOf('/releases/latest') >= 0) {
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(f)) };
      }
      throw new Error('stub: 网络不可用');
    };
  }, FAKE.full);
  await page.evaluate(() => window.ChaApp.checkUpdate());
  await sleep(400);
  const s4 = await page.evaluate(() => {
    const b = document.getElementById('btnDoUpdate');
    return {
      msg: document.getElementById('aboutUpdateMsg').textContent,
      html: document.getElementById('aboutUpdateMsg').innerHTML,
      visible: !b.classList.contains('hidden'),
      text: b.textContent,
      hasNew: document.getElementById('aboutUpdate').classList.contains('has-new')
    };
  });
  ok('提示里有新版本号', /9\.9\.9/.test(s4.msg), s4.msg);
  ok('提示里点名了该下哪个包（不用自己去挑）', /chahui-setup-9\.9\.9\.exe/.test(s4.msg), s4.msg);
  ok('下载按钮露出来了', s4.visible, s4.visible);
  ok('网页版按钮写的是「直接下载」', s4.text === '直接下载', s4.text);
  ok('更新区打了 has-new 标记', s4.hasNew, s4.hasNew);

  /* ================= 5) 点按钮：blob 下载，不跳 GitHub ================= */
  console.log('\n=== 5) 点「直接下载」：走 blob，不跳 GitHub ===');
  const dl = await page.evaluate(async () => {
    // 资产请求也回一个真 Blob —— downloadUpdate 会把它存成对象 URL 再点 <a download>
    window.fetch = async () => ({
      ok: true, status: 200,
      blob: async () => new Blob(['x'], { type: 'application/octet-stream' })
    });
    // 记下有没有发生「把人带走」的导航
    const anchors = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      anchors.push({ href: String(this.href).slice(0, 40), download: this.download, target: this.target || '' });
    };
    document.getElementById('btnDoUpdate').click();
    const t0 = Date.now();
    const msg = () => document.getElementById('aboutUpdateMsg').textContent;
    while (Date.now() - t0 < 6000 && !/已开始下载|下载到|正在启动安装|下载失败/.test(msg())) {
      await new Promise(r => setTimeout(r, 120));
    }
    HTMLAnchorElement.prototype.click = origClick;
    return {
      msg: msg(),
      anchors: anchors,
      btnText: document.getElementById('btnDoUpdate').textContent,
      btnDisabled: document.getElementById('btnDoUpdate').disabled,
      url: location.href
    };
  });
  ok('下载跑完了（没有被跨域/CORS 卡死在中间）', !/正在准备下载/.test(dl.msg), dl.msg);
  ok('走的是一次「下载」而不是跳页', /已开始下载/.test(dl.msg), dl.msg);
  ok('生成的 <a> 带 download 属性（浏览器直接存盘）',
    dl.anchors.length >= 1 && dl.anchors[0].download !== '', JSON.stringify(dl.anchors));
  ok('页面没有被导航走（还停在本站）', /127\.0\.0\.1|localhost/.test(dl.url), dl.url);
  ok('下完把按钮还原了（能再点）', dl.btnText === '直接下载' && dl.btnDisabled === false,
    dl.btnText + ' disabled=' + dl.btnDisabled);

  /* ================= 6) 有新版本但没认得出的包 ================= */
  console.log('\n=== 6) 有新版本、但这个 release 里没有装机包 ===');
  await page.evaluate(f => {
    window.fetch = async u => {
      if (String(u).indexOf('/releases/latest') >= 0) {
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(f)) };
      }
      throw new Error('stub');
    };
  }, FAKE.noAsset);
  await page.evaluate(() => window.ChaApp.checkUpdate());
  await sleep(400);
  const s6 = await page.evaluate(() => {
    const b = document.getElementById('btnDoUpdate');
    const link = document.querySelector('#aboutUpdateMsg a');
    return {
      msg: document.getElementById('aboutUpdateMsg').textContent,
      visible: !b.classList.contains('hidden'),
      href: link ? link.getAttribute('href') : '',
      target: link ? link.getAttribute('target') : ''
    };
  });
  ok('老实说「没有认得出的安装包」', /没有认得出的安装包/.test(s6.msg), s6.msg);
  ok('不露「直接下载」按钮（假装能一键下才坑人）', !s6.visible, s6.visible);
  ok('给了一个 Releases 页面入口', /releases/.test(s6.href), s6.href);
  ok('这个外链是新开标签的（不把当前页面顶掉）', s6.target === '_blank', s6.target);

  /* ================= 7) 已经是最新版 ================= */
  console.log('\n=== 7) 假 release 就是当前版本 ===');
  await page.evaluate(c => {
    window.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v' + c, html_url: 'https://github.com/x/y/releases',
        assets: [{ name: 'chahui-setup-' + c + '.exe', browser_download_url: 'https://x.invalid/a.exe' }]
      })
    });
  }, cur);
  await page.evaluate(() => window.ChaApp.checkUpdate());
  await sleep(400);
  const s7 = await page.evaluate(() => ({
    msg: document.getElementById('aboutUpdateMsg').textContent,
    visible: !document.getElementById('btnDoUpdate').classList.contains('hidden'),
    text: document.getElementById('btnDoUpdate').textContent
  }));
  ok('说「已经是最新版」', /已经是最新版/.test(s7.msg) && s7.msg.indexOf(cur) >= 0, s7.msg);
  ok('不露按钮', !s7.visible, s7.visible);
  ok('按钮文案还原成默认的「下载更新」', s7.text === '下载更新', s7.text);

  /* ================= 8) 恢复网络，真跑一次 ================= */
  console.log('\n=== 8) 恢复真实网络，真跑一次（只要求「有结论」）===');
  await page.evaluate(() => { window.fetch = window.__origFetch; });
  await page.evaluate(() => window.ChaApp.checkUpdate());
  const done = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const m = await page.evaluate(() => document.getElementById('aboutUpdateMsg').textContent);
      if (m && !/正在检查更新/.test(m)) return m;
      await sleep(250);
    }
    return null;
  })();
  ok('真跑一次能收尾（联网成功说是最新版/有新版本，受限时给出失败原因）',
    !!done && /已经是最新版|有新版本|检查更新失败/.test(done), done);
  ok('失败时也给了手动入口（不会只剩一句错误）',
    !done || !/检查更新失败/.test(done) || /Releases 页面/.test(await page.evaluate(() => document.getElementById('aboutUpdateMsg').innerHTML)));

  ok('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' ⏐ '));

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' / ' + fail);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('崩了：', e); process.exit(2); });
