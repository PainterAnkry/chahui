/**
 * 画布外壳回归：快捷小菜单、参考图（本机私有）、关于页（准则/风险/更新检测）。
 *
 * 守着这几条真缺陷：
 *   · 快捷条读的字段名和引擎对不上（引擎是 rot / flipX，不是 rotation / flipped），
 *     于是旋转数字永远显示 0.0°、翻转按钮永远不高亮
 *   · 更新检测没有超时，网络被墙时会一直停在「正在检查更新…」
 *   · 参考图必须**只在本机**，绝不能出现在要同步的数据里
 *
 * 用法: node tools/test-shell.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '外壳');
  await page.fill('#newRoomName', '画布外壳');
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 12000 });
  await sleep(800);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(400);

  /* ---------- 快捷小菜单 ---------- */
  console.log('\n=== 画布上的快捷小菜单 ===');
  const q = await page.evaluate(() => ({
    exists: !!document.querySelector('#quickBar'),
    btns: document.querySelectorAll('#quickBar .qb-btn').length,
    zoom: (document.querySelector('#qbZoomText').value || ''),
    rot: (document.querySelector('#qbRotText').value || '')
  }));
  console.log('  ' + JSON.stringify(q));
  ok('画布上沿有快捷条', q.exists && q.btns >= 12, q.btns + ' 个按钮');

  await page.click('#qbToggle'); await sleep(250);
  const collapsed = await page.evaluate(() => ({
    c: document.querySelector('#quickBar').classList.contains('collapsed'),
    t: document.querySelector('#qbToggle').textContent
  }));
  ok('可以收起', collapsed.c === true && collapsed.t === '▸', JSON.stringify(collapsed));
  await page.click('#qbToggle'); await sleep(250);
  ok('可以再拉开', (await page.evaluate(() => document.querySelector('#quickBar').classList.contains('collapsed'))) === false);
  ok('收起状态记在本地', await page.evaluate(() => localStorage.getItem('chahu.quickbar.collapsed') !== null));

  await page.click('#qbFlip'); await sleep(300);
  ok('翻转真的生效', await page.evaluate(() => !!window.ChaApp.engine.flipX));
  ok('翻转按钮高亮', await page.evaluate(() => document.querySelector('#qbFlip').classList.contains('active')));
  await page.click('#qbRotR'); await sleep(400);
  ok('旋转真的生效', Math.abs(await page.evaluate(() => window.ChaApp.engine.rot)) > 1e-6);
  ok('旋转数字跟着视图走（不是死的 0.0°）',
    (await page.evaluate(() => (document.querySelector('#qbRotText').value || ''))) === '15.0°',
    await page.evaluate(() => (document.querySelector('#qbRotText').value || '')));
  await page.click('#qbRotReset'); await sleep(300);
  ok('角度归零可用', Math.abs(await page.evaluate(() => window.ChaApp.engine.rot)) < 1e-6);
  await page.evaluate(() => window.ChaApp.engine.setZoom(0.42)); await sleep(300);
  ok('缩放数字跟随视图变化',
    (await page.evaluate(() => (document.querySelector('#qbZoomText').value || ''))) === '42%',
    await page.evaluate(() => (document.querySelector('#qbZoomText').value || '')));
  await page.click('#qbSteadierUp'); await sleep(300);
  ok('手抖修正加减可用', Number(await page.evaluate(() => window.ChaApp.state.brush.steadier)) >= 1,
    String(await page.evaluate(() => window.ChaApp.state.brush.steadier)));

  /* ---------- 参考图（本机私有） ---------- */
  console.log('\n=== 参考图（只有自己看得见） ===');
  // 造一张图直接喂给 loadReferenceImage（绕开系统文件选择框）
  const ref = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 80; c.height = 60;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ff00ff';
    cx.fillRect(0, 0, 80, 60);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const f = new File([blob], '参考图.png', { type: 'image/png' });
    window.ChaApp.loadReferenceImage(f);
    await new Promise(r => setTimeout(r, 800));
    const w = document.querySelector('#refWindow');
    return {
      open: w && !w.classList.contains('hidden'),
      hasImg: !!document.querySelector('#refImg').getAttribute('src'),
      name: document.querySelector('#refName').textContent,
      hint: (document.querySelector('#refHint') || {}).textContent || '',
      isOverlay: !!document.querySelector('.ref-canvas'),
      // 浮窗是独立 DOM，不再是压在画布上的 canvas
      tag: w ? w.tagName : ''
    };
  });
  console.log('  ' + JSON.stringify(ref));
  // 参考图现在是**独立浮窗**（像 PS 另开一张图），可拖动 / 缩放 / 关闭；
  // 不是盖在画布上的那一层。拖动 / 本地性由 test-layout.js 详细验。
  ok('参考图以独立浮窗打开', ref.open === true && ref.tag === 'DIV', ref.tag);
  ok('图片真的加载出来了', ref.hasImg === true);
  ok('标题栏显示文件名', /参考图\.png/.test(ref.name), ref.name);
  ok('标注了「只有你自己看得见」', /只有你自己看得见/.test(ref.hint), ref.hint.slice(0, 30));
  ok('不再是盖在画布上的那一层', ref.isOverlay === false);

  // ★ 关键：参考图绝不能出现在同步数据里
  const leak = await page.evaluate(() => {
    const json = JSON.stringify({
      strokes: window.ChaApp.engine.strokes,
      layers: window.ChaApp.engine.layers.map(l => ({ id: l.id, name: l.name, hasBase: !!l.baseImage }))
    });
    return { refInData: /ref-canvas|参考图/.test(json), n: window.ChaApp.engine.strokes.length };
  });
  ok('参考图没有混进笔迹 / 图层数据（不会同步给别人）', leak.refInData === false, '笔迹 ' + leak.n + ' 条');

  const gone = await page.evaluate(async () => {
    window.ChaApp.clearReferenceImage();
    await new Promise(r => setTimeout(r, 300));
    return { open: !document.querySelector('#refWindow').classList.contains('hidden') };
  });
  ok('能关闭参考图浮窗', gone.open === false, JSON.stringify(gone));

  /* ---------- 关于 / 准则 / 风险 / 更新 ---------- */
  console.log('\n=== 关于 ===');
  await page.evaluate(() => window.ChaApp.openAbout());
  await page.waitForFunction(() => !/正在检查/.test(document.querySelector('#aboutUpdateMsg').textContent),
    { timeout: 20000 }).catch(() => { });
  const ab = await page.evaluate(() => ({
    open: !document.querySelector('#aboutMask').classList.contains('hidden'),
    tabs: document.querySelectorAll('.about-tabs .tab').length,
    ver: document.querySelector('#aboutVer').textContent,
    terms: document.querySelector('#aboutBody').textContent.length,
    upd: document.querySelector('#aboutUpdateMsg').textContent
  }));
  console.log('  ' + JSON.stringify(ab));
  ok('关于页能打开', ab.open === true);
  ok('有用户准则 / 风险须知 / 致谢三个分页', ab.tabs === 3, String(ab.tabs));
  ok('用户准则有内容', ab.terms > 200, ab.terms + ' 字');
  ok('显示版本号', /^\d+\.\d+\.\d+$/.test(ab.ver), ab.ver);
  ok('更新检测给出了结果（不会一直卡在检查中）', !/正在检查/.test(ab.upd), ab.upd.slice(0, 70));

  await page.evaluate(() => document.querySelector('.about-tabs .tab[data-atab="risk"]').click());
  await sleep(300);
  const risk = await page.evaluate(() => document.querySelector('#aboutBody').textContent);
  ok('风险须知有内容', risk.length > 300, risk.length + ' 字');
  ok('风险须知说明了「画可能会丢」', /丢|备份/.test(risk));
  ok('风险须知说明了「联机不加密」', /加密/.test(risk));

  await page.evaluate(() => document.querySelector('.about-tabs .tab[data-atab="credits"]').click());
  await sleep(300);
  ok('致谢里有 MIT 许可与第三方说明',
    /MIT/.test(await page.evaluate(() => document.querySelector('#aboutBody').textContent)));

  ok('版本比较正确（1.3.10 > 1.3.9）',
    await page.evaluate(() => window.ChaApp.cmpVer('1.3.10', '1.3.9') > 0 && window.ChaApp.cmpVer('1.3.6', '1.3.6') === 0));

  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
