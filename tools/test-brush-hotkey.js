/**
 * 笔刷快捷键 · 端到端测试
 *
 * 用户反馈「笔刷快捷键设置没有用」。守的路径：
 *  1) 右键笔刷格子 → 弹窗点「快捷键：无（点击设置）」→ 按字母 → 弹窗显示已设
 *  2) 按下该字母 → 当前笔刷切过去（角标/active 同步）
 *  3) 冲突排查：设成 U / S（菜单里模糊/涂抹工具占用的裸键）→ 按下是否还切笔刷
 *  4) 刷新页面后快捷键仍在（localStorage 持久化）
 *  5) 清除快捷键后按键不再切
 *
 * 用法：node tools/test-brush-hotkey.js [基地址]（默认 http://127.0.0.1:8441）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { chromium } = require('./pw');

const BASE = process.argv[2] || 'http://127.0.0.1:8441';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e).slice(0, 200)));

  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await p.evaluate(() => {
    document.querySelector('#nameInput').value = '快捷键测试';
    document.querySelector('#newRoomName').value = '快捷键测试房';
    document.querySelector('#btnCreateRoom').click();
  });
  await p.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(500);
  // 进房后的入口遮罩会拦截指针 —— 直接藏掉（其他窄屏测试同款处理）
  await p.evaluate(() => { const m = document.getElementById('entryMask'); if (m) m.classList.add('hidden'); });
  await sleep(200);

  /** 当前选中的笔刷 id */
  const curBrush = () => p.evaluate(() => window.ChaApp.state.brushId);
  /** 右键某笔刷格子 → 点「设置快捷键」→ 按键 */
  async function setKey(itemSelector, key) {
    await p.click(itemSelector, { button: 'right' });
    await sleep(150);
    await p.click('#icmKey');
    await sleep(150);
    await p.keyboard.press(key);
    await sleep(150);
  }
  const icmText = () => p.evaluate(() => document.getElementById('icmKey').textContent);

  /* ---- 1) 正常字母 V：设置 → 生效 ---- */
  // 给第二格笔刷（铅笔 pencil）设 V
  const pencilSel = '#brushGrid .tool[data-item="pencil"]';
  ok('笔刷栏里有「铅笔」格子', await p.evaluate(s => !!document.querySelector(s), pencilSel));
  await setKey(pencilSel, 'v');
  ok('弹窗显示快捷键已设为 V', /V/.test(await icmText()), await icmText());
  await p.keyboard.press('Escape'); // 关弹窗
  await sleep(200);
  await p.keyboard.press('v');
  await sleep(250);
  ok('按下 V 切到铅笔', (await curBrush()) === 'pencil', await curBrush());

  /* ---- 2) 切回默认笔刷，再验证 V 仍可来回切 ---- */
  await p.click('#brushGrid .tool[data-item="brush"]');
  await sleep(200);
  ok('点回默认画笔', (await curBrush()) === 'brush', await curBrush());
  await p.keyboard.press('v');
  await sleep(250);
  ok('再按 V 又切回铅笔', (await curBrush()) === 'pencil', await curBrush());

  /* ---- 3) 冲突键 U（菜单「模糊工具」占用的裸键）---- */
  const waterSel = '#brushGrid .tool[data-item="watercolor"]';
  if (await p.evaluate(s => !!document.querySelector(s), waterSel)) {
    // 修复不得改变默认行为：未自定义时按 U 仍切到模糊工具（ITEM_KEYS_DEFAULT: blur=U）
    await p.keyboard.press('u');
    await sleep(250);
    ok('默认按 U 仍切到模糊工具', (await curBrush()) === 'blur', await curBrush());
    await setKey(waterSel, 'u');
    const icmU = await icmText();
    ok('设置 U：要么成功要么提示冲突', /U/.test(icmU) || /占用|冲突/.test(icmU), icmU);
    await p.keyboard.press('Escape');
    await sleep(200);
    await p.click('#brushGrid .tool[data-item="brush"]');
    await sleep(200);
    await p.keyboard.press('u');
    await sleep(250);
    const afterU = await curBrush();
    ok('按下 U 能切到水彩（笔刷键优先于菜单模糊工具）',
      afterU === 'watercolor',
      '当前=' + afterU + (afterU !== 'watercolor' ? '  ⚠ U 被菜单吃掉了' : ''));
  } else {
    console.log('  - 笔刷栏没有 water（水彩），跳过 U 冲突场景');
  }

  /* ---- 4) 冲突键 S（菜单「涂抹工具」占用的裸键）---- */
  const markerSel = '#brushGrid .tool[data-item="marker"]';
  if (await p.evaluate(s => !!document.querySelector(s), markerSel)) {
    // 未自定义时按 S 仍切到涂抹工具（ITEM_KEYS_DEFAULT: smudge=S）
    await p.keyboard.press('s');
    await sleep(250);
    ok('默认按 S 仍切到涂抹工具', (await curBrush()) === 'smudge', await curBrush());
    await setKey(markerSel, 's');
    const icmS = await icmText();
    ok('设置 S：要么成功要么提示冲突', /S/.test(icmS) || /占用|冲突/.test(icmS), icmS);
    await p.keyboard.press('Escape');
    await sleep(200);
    await p.keyboard.press('s');
    await sleep(250);
    const afterS = await curBrush();
    ok('按下 S 能切到马克笔（笔刷键优先于菜单涂抹工具）',
      afterS === 'marker',
      '当前=' + afterS + (afterS !== 'marker' ? '  ⚠ S 被菜单吃掉了' : ''));
  } else {
    console.log('  - 笔刷栏没有 marker（马克笔），跳过 S 冲突场景');
  }

  /* ---- 5) 刷新持久化：V 还在 ---- */
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await sleep(400);
  const keyAfterReload = await p.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}')).pencil; }
    catch (e) { return null; }
  });
  // localStorage 键名可能不是 chahu.itemKeys，退化看角标
  const badge = await p.evaluate(() => {
    const el = document.querySelector('#brushGrid .tool[data-item="pencil"] .tkey');
    return el ? el.textContent : null;
  });
  ok('刷新后铅笔快捷键仍在（localStorage 或角标）', keyAfterReload === 'V' || badge === 'V',
    'store=' + keyAfterReload + ' 角标=' + badge);
  await p.keyboard.press('v');
  await sleep(250);
  ok('刷新后按 V 仍切到铅笔', (await curBrush()) === 'pencil', await curBrush());

  /* ---- 6) 清除快捷键：按键不再切 ---- */
  await setKey(pencilSel, 'v'); // 先确保弹窗开着（顺带把 V 再设一次）
  await p.click('#icmClear');
  await sleep(150);
  await p.keyboard.press('Escape');
  await sleep(200);
  await p.click('#brushGrid .tool[data-item="brush"]');
  await sleep(200);
  await p.keyboard.press('v');
  await sleep(250);
  ok('清除后按 V 不再切笔刷', (await curBrush()) === 'brush', await curBrush());

  /* ---- 7) 导入真实 .abr → 设快捷键 → 刷新后仍生效（导入笔刷键位持久化）---- */
  const ABR = 'D:/新建文件夹/PS笔刷/简单的祥云Photoshop笔刷素材.abr';
  const fs = require('fs');
  if (fs.existsSync(ABR)) {
    await p.setInputFiles('#brushFileInput', ABR);
    // 导入是两步向导：解析完弹出勾选列表（#importMask），点「导入所选」才真正入库
    await p.waitForFunction(() => {
      const rows = document.querySelectorAll('#importBody .imp-row');
      const m = document.getElementById('importMask');
      return rows.length > 0 && m && !m.classList.contains('hidden');
    }, { timeout: 30000 });
    await p.click('#btnImportOk');
    await p.waitForFunction(() => {
      const m = document.getElementById('importMask');
      return m && m.classList.contains('hidden');
    }, { timeout: 30000 });
    await sleep(600);
    const impCount = await p.evaluate(() =>
      document.querySelectorAll('#brushGrid .tool[data-item^="imp_"]').length);
    ok('导入 .abr 后笔刷栏出现导入笔刷', impCount > 0, '共 ' + impCount + ' 格');
    if (impCount > 0) {
      const firstImp = await p.evaluate(() =>
        document.querySelector('#brushGrid .tool[data-item^="imp_"]').dataset.item);
      await setKey('#brushGrid .tool[data-item="' + firstImp + '"]', 'q');
      ok('导入笔刷快捷键设为 Q', /Q/.test(await icmText()), await icmText());
      await p.keyboard.press('Escape');
      await sleep(200);
      await p.keyboard.press('q');
      await sleep(250);
      ok('按 Q 切到导入笔刷', (await curBrush()) === firstImp, await curBrush());
      // 刷新：导入笔刷 + 它的键位都从 localStorage 恢复
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
      await sleep(500);
      await p.keyboard.press('q');
      await sleep(250);
      const afterReload = await curBrush();
      ok('刷新后按 Q 仍切到导入笔刷', afterReload === firstImp,
        '当前=' + afterReload + (afterReload !== firstImp ? '（⚠ 导入笔刷键位或注册丢了）' : ''));
    }
  } else {
    console.log('  - 找不到测试用 .abr（' + ABR + '），跳过导入场景');
  }

  /* ---- 8)「快捷键设置」对话框里的「笔刷与工具」区块（第二入口）---- */
  // 打开 编辑 → 快捷键设置（菜单命令键位 + 笔刷键位现在同一处）
  await p.evaluate(() => window.ChaMenu.openKeyDialog());
  await sleep(300);
  const hasBrushGroup = await p.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('#keyBody .key-group'));
    return groups.some(g => /笔刷与工具/.test(g.textContent));
  });
  ok('对话框里出现「笔刷与工具」分组', hasBrushGroup);
  const brushRows = await p.evaluate(() =>
    document.querySelectorAll('#keyBody input[data-item]').length);
  ok('笔刷键位行已列出（与笔刷栏一致）', brushRows >= 10, '共 ' + brushRows + ' 行');
  // 经对话框给「墨水勾线」（inking）设 Z：点输入框 → 按 Z → 失焦即提交
  await p.evaluate(() => {
    const inp = document.querySelector('#keyBody input[data-item="inking"]');
    inp.click();
  });
  await sleep(150);
  await p.keyboard.press('z');
  await sleep(300);
  const inkingKey = await p.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}')).inking; }
    catch (e) { return null; }
  });
  ok('对话框里设键成功（inking → Z）', inkingKey === 'Z', 'store=' + inkingKey);
  await p.click('#btnKeyOk');
  await sleep(200);
  await p.keyboard.press('z');
  await sleep(250);
  ok('按 Z 切到墨水勾线', (await curBrush()) === 'inking', await curBrush());

  /* ---- 9) 撞键让位：给默认笔刷（B）设 Z，原「墨水勾线」的 Z 被清空 ---- */
  await p.evaluate(() => window.ChaMenu.openKeyDialog());
  await sleep(300);
  await p.evaluate(() => { document.querySelector('#keyBody input[data-item="brush"]').click(); });
  await sleep(150);
  await p.keyboard.press('z');
  await sleep(300);
  const clashState = await p.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('chahu.itemKeys') || '{}');
    return { brush: raw.brush, inking: raw.inking };
  });
  ok('撞键让位：brush=Z、inking 被清空', clashState.brush === 'Z' && clashState.inking === '',
    JSON.stringify(clashState));
  await p.click('#btnKeyOk');
  await sleep(200);
  await p.keyboard.press('z');
  await sleep(250);
  ok('按 Z 切到默认画笔', (await curBrush()) === 'brush', await curBrush());

  /* ---- 10) 页面报错 ---- */
  ok('页面无报错', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log('\n══════════════════════════════════');
  console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('══════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
