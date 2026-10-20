/* 导入笔刷「批量移除」回归
 * ① 批量模式：管理条出现、按钮文案变「退出」、内置笔刷置灰不可选
 * ② 点格子多选 → 计数正确；全选 / 反选
 * ③ 删除所选：只删选中项、localStorage 同步、网格与快捷键顺序不留残渣
 * 用法：node tools/test-brush-batch.js [BASE]   （默认 http://127.0.0.1:8440）
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8440';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  // 合法的笔尖位图串：4x4x4 打包（64 字节），loadImported 用它做有效性校验
  const tipBuf = Buffer.alloc(64, 255);
  const tip = '4x4x4:' + tipBuf.toString('base64');
  const seed = [1, 2, 3, 4].map(i => ({
    id: 'imp_batch_' + i, name: '笔刷' + i, tool: 'brush', icon: 'imported', type: 'brush', imported: true,
    params: { brush: 'custom', size: 20 + i, opacity: 1, hardness: 0.8, minSize: 1, pressSize: 0.6,
              pressOpacity: 0.3, grain: 0, scatter: 0, spacing: 0.1, tip: tip }
  }));
  await page.addInitScript(o => {
    try { if (!localStorage.getItem('chahu.brushes.imported')) localStorage.setItem('chahu.brushes.imported', JSON.stringify(o)); } catch (e) {}
  }, seed);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'T');
  await page.fill('#newRoomName', 'batch' + (Date.now() % 100000));
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(700);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));

  /* ① 进入批量模式 */
  const enter = await page.evaluate(() => {
    document.querySelector('#btnBrushManage').click();
    const bar = document.querySelector('#brushManageBar');
    const cells = [...document.querySelectorAll('#brushGrid .tool')];
    const dis = cells.filter(c => c.classList.contains('dis')).length;
    const impCells = cells.filter(c => c.dataset.item.startsWith('imp_batch_')).length;
    return {
      barVisible: !bar.classList.contains('hidden'),
      btnText: document.querySelector('#btnBrushManage').textContent,
      gridManaging: document.querySelector('#brushGrid').classList.contains('managing'),
      dis, impCells, count: document.querySelector('#bmCount').textContent
    };
  });
  ok('批量模式：管理条出现', enter.barVisible, enter);
  ok('批量模式：按钮变「退出」', enter.btnText === '退出', enter.btnText);
  ok('批量模式：网格进入 managing', enter.gridManaging);
  ok('批量模式：内置笔刷置灰不可选', enter.dis > 0, enter.dis);
  ok('批量模式：4 支导入笔刷都在', enter.impCells === 4, enter.impCells);

  /* ② 多选 / 全选 / 反选 */
  const sel = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#brushGrid .tool')];
    const imp = cells.filter(c => c.dataset.item.startsWith('imp_batch_'));
    imp[0].click(); imp[1].click();
    const c2 = document.querySelector('#bmCount').textContent;
    const selCount = document.querySelectorAll('#brushGrid .tool.sel').length;
    // 内置笔刷点了不能选中
    const builtin = cells.find(c => !c.dataset.item.startsWith('imp_batch_'));
    builtin.click();
    const c2b = document.querySelector('#bmCount').textContent;
    document.querySelector('#bmAll').click();
    const cAll = document.querySelector('#bmCount').textContent;
    document.querySelector('#bmInvert').click();
    const cInv = document.querySelector('#bmCount').textContent;
    document.querySelector('#bmAll').click();
    return { c2, selCount, c2b, cAll, cInv };
  });
  ok('点两格 → 已选 2 支', sel.c2 === '已选 2 支' && sel.selCount === 2, sel);
  ok('内置笔刷点不选（计数不变）', sel.c2b === '已选 2 支', sel.c2b);
  ok('全选 → 4 支', sel.cAll === '已选 4 支', sel.cAll);
  ok('反选 → 0 支', sel.cInv === '已选 0 支', sel.cInv);

  /* ③ 删除所选（只留 2 支） */
  const del = await page.evaluate(() => {
    window.confirm = () => true;
    const cells = [...document.querySelectorAll('#brushGrid .tool')];
    const imp = cells.filter(c => c.dataset.item.startsWith('imp_batch_'));
    // 先把选择清空，再只选前两支
    document.querySelectorAll('#brushGrid .tool.sel').forEach(c => c.click());
    imp[0].click(); imp[1].click();
    const before = JSON.parse(localStorage.getItem('chahu.brushes.imported') || '[]').length;
    document.querySelector('#bmDelete').click();
    const after = JSON.parse(localStorage.getItem('chahu.brushes.imported') || '[]').length;
    const leftCells = [...document.querySelectorAll('#brushGrid .tool')]
      .filter(c => c.dataset.item.startsWith('imp_batch_')).map(c => c.dataset.item);
    const inOrder = Object.keys(window.ChaApp.state.toolPrefs.order).length &&
      window.ChaApp.state.toolPrefs.order.filter(id => id === 'imp_batch_1' || id === 'imp_batch_2');
    return { before, after, leftCells, inOrder, count: document.querySelector('#bmCount').textContent };
  });
  ok('删除前 4 支 → 删除后 2 支（localStorage 同步）', del.before === 4 && del.after === 2, del);
  ok('被删的两支从网格消失，另两支还在', del.leftCells.length === 2 &&
      del.leftCells.indexOf('imp_batch_1') < 0 && del.leftCells.indexOf('imp_batch_2') < 0, del.leftCells);
  ok('快捷键顺序里不留残渣', Array.isArray(del.inOrder) && del.inOrder.length === 0, del.inOrder);
  ok('删除后计数归零', del.count === '已选 0 支', del.count);

  /* ④ 退出批量模式 */
  const exit = await page.evaluate(() => {
    document.querySelector('#bmDone').click();
    return {
      barHidden: document.querySelector('#brushManageBar').classList.contains('hidden'),
      btnText: document.querySelector('#btnBrushManage').textContent,
      managing: document.querySelector('#brushGrid').classList.contains('managing')
    };
  });
  ok('完成 → 管理条收起、按钮复原', exit.barHidden && exit.btnText === '批量' && !exit.managing, exit);

  ok('无页面报错', errs.length === 0, errs.slice(0, 3));
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
