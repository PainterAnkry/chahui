/* 验证：1) 小节能跨左右两栏拖动 2) 颜色栏 RGB/HSV 滑块与开关 3) 恢复默认布局 */
const { chromium } = require('./pw');

const URL = process.env.CHAHU_URL || 'http://127.0.0.1:8440/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* 小节可能在被滚出视野的位置 —— 拖之前先把它滚到可视区中间，
   否则鼠标坐标落在窗口外，事件根本命中不到元素。 */
async function gripAt(page, sel) {
  await page.evaluate((s) => {
    const g = document.querySelector(s);
    if (g) g.scrollIntoView({ block: 'center' });
  }, sel);
  await page.waitForTimeout(120);
  const r = await page.evaluate((s) => {
    const g = document.querySelector(s);
    if (!g) return null;
    const b = g.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
  }, sel);
  if (!r) throw new Error('找不到 ' + sel);
  if (r.y < 5 || r.y > 890) throw new Error(sel + ' 滚不进可视区: y=' + r.y);
  return r;
}
async function dragTo(page, from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 6, { steps: 4 });
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.waitForTimeout(140);
  return async () => { await page.mouse.up(); await page.waitForTimeout(240); };
}

/* 进房间：入口那个「进入茶绘室」弹窗会盖住整个页面（.modal-mask 铺满），
   不关掉的话鼠标事件全被它吃掉，拖拽根本起不了手。 */
let roomNo = 0;
async function join(page) {
  await page.waitForFunction(() => window.ChaApp, { timeout: 15000 });
  // 弹窗的 .hidden 是脚本稍后加上去的，直接 $() 查会查空 —— 必须等它出现
  try { await page.waitForSelector('#entryMask:not(.hidden)', { timeout: 6000 }); } catch (e) { /* 没弹就算了 */ }
  const joined = await page.evaluate(() => !!(window.ChaApp && window.ChaApp.state && window.ChaApp.state.joined));
  if (!joined) {
    roomNo++;
    await page.fill('#nameInput', '布局');
    await page.fill('#newRoomName', '布局回归' + roomNo);
    await page.click('#btnCreateRoom');
    await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
  // 入口蒙层铺满整个窗口，不关掉鼠标事件全被它吃掉
  await page.evaluate(() => {
    const m = document.querySelector('#entryMask');
    if (m) m.classList.add('hidden');
  });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await join(page);

  console.log('\n【一】默认布局：小节都在左栏，右栏收着');
  let st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    rightHidden: getComputedStyle(document.getElementById('rightPanelScroll')).display === 'none',
    leftOrder: getComputedStyle(document.querySelector('.panel.left')).order,
    rightOrder: getComputedStyle(document.querySelector('.panel.right')).order
  }));
  ok('左栏含 7 个小节', st.left.length === 7, st.left);
  ok('左栏顺序为 nav/tools/brushes/brush/fx/color/layers',
    JSON.stringify(st.left) === JSON.stringify(['nav', 'tools', 'brushes', 'brush', 'fx', 'color', 'layers']), st.left);
  ok('右栏为空', st.right.length === 0, st.right);
  ok('空的右栏被收起来（display:none）', st.rightHidden === true);
  ok('左右栏回到默认位置（左 order=1 / 右 order=3）', st.leftOrder === '1' && st.rightOrder === '3',
    [st.leftOrder, st.rightOrder]);

  console.log('\n【二】拖拽：把「颜色」小节从左边拖到右边');
  const from = await gripAt(page, '#leftPanelScroll [data-section="color"] .section-grip');
  const to = await page.evaluate(() => {
    const r = document.getElementById('sidePanel').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 60 };
  });
  let drop = await dragTo(page, from, to);
  const midDrag = await page.evaluate(() => ({
    dragging: !!document.querySelector('.section-dragging'),
    rightShown: getComputedStyle(document.getElementById('rightPanelScroll')).display !== 'none',
    bodyFlag: document.body.classList.contains('panel-dragging')
  }));
  ok('拖动中被拖的小节带 .section-dragging', midDrag.dragging === true, midDrag);
  ok('拖动中空的右栏临时露出来当落点', midDrag.rightShown === true, midDrag);
  ok('body 带 panel-dragging（抓手指针）', midDrag.bodyFlag === true, midDrag);
  await drop();

  st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    rightHidden: getComputedStyle(document.getElementById('rightPanelScroll')).display === 'none',
    stored: localStorage.getItem('chahu.panelSides'),
    wheelInRight: !!document.querySelector('#rightPanelScroll #colorWheel'),
    wheelBox: (() => { const r = document.getElementById('colorWheel').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
  }));
  ok('颜色小节到了右栏', st.right.includes('color'), st.right);
  ok('左栏不再有颜色小节', !st.left.includes('color'), st.left);
  ok('右栏不再是空的（有内容就展开）', st.rightHidden === false);
  ok('panelSides 记下了 color=right', /"color":"right"/.test(st.stored || ''), st.stored);
  ok('色轮跟着一起过去了', st.wheelInRight === true);
  ok('色轮仍有可见尺寸', st.wheelBox.w > 100 && st.wheelBox.h > 100, st.wheelBox);
  ok('左栏剩 6 个小节且顺序不变', JSON.stringify(st.left) === JSON.stringify(['nav', 'tools', 'brushes', 'brush', 'fx', 'layers']), st.left);

  console.log('\n【三】刷新后仍然记得');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await join(page);
  st = await page.evaluate(() => ({
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section)
  }));
  ok('刷新后颜色小节还在右栏', st.right.includes('color'), st);
  ok('刷新后左栏仍无颜色小节', !st.left.includes('color'), st.left);

  console.log('\n【四】左栏小节也能拖进右栏并排到颜色前面');
  const from2 = await gripAt(page, '#leftPanelScroll [data-section="layers"] .section-grip');
  const to2 = await page.evaluate(() => {
    const s = document.querySelector('#rightPanelScroll [data-section="color"]');
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 5 };
  });
  drop = await dragTo(page, from2, to2);
  await drop();
  st = await page.evaluate(() => [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section));
  ok('右栏顺序变成 layers 在前', st[0] === 'layers', st);

  console.log('\n【五】再拖回左栏');
  const from3 = await gripAt(page, '#rightPanelScroll [data-section="color"] .section-grip');
  const to3 = await page.evaluate(() => {
    const s = document.querySelector('#leftPanelScroll [data-section="fx"]');
    const r = s.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + 5 };
  });
  drop = await dragTo(page, from3, to3);
  await drop();
  st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    rightHidden: getComputedStyle(document.getElementById('rightPanelScroll')).display === 'none'
  }));
  ok('颜色回到左栏', st.left.includes('color'), st.left);
  ok('颜色排在被指向的 fx 前面', st.left.indexOf('color') < st.left.indexOf('fx'), st.left);
  ok('图层留在右栏', st.right.includes('layers'), st.right);
  ok('右栏仍有内容所以展开着', st.rightHidden === false);

  console.log('\n【六】恢复默认面板布局');
  // 走左栏把手上的 ↺（和菜单「窗口 → 恢复默认面板布局」同一段逻辑）
  await page.evaluate(() => document.getElementById('btnPanelReset').click());
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({
    left: [...document.querySelectorAll('#leftPanelScroll [data-section]')].map(s => s.dataset.section),
    right: [...document.querySelectorAll('#rightPanelScroll [data-section]')].map(s => s.dataset.section),
    rightHidden: getComputedStyle(document.getElementById('rightPanelScroll')).display === 'none',
    sides: localStorage.getItem('chahu.panelSides')
  }));
  ok('全部小节回到左栏', st.right.length === 0 && st.left.length === 7, st);
  ok('左栏恢复默认顺序', JSON.stringify(st.left) === JSON.stringify(['nav', 'tools', 'brushes', 'brush', 'fx', 'color', 'layers']), st.left);
  ok('右栏重新收起', st.rightHidden === true);
  ok('panelSides 被清空', st.sides === '{}' || st.sides === '' || st.sides === null, st.sides);

  console.log('\n【七】颜色栏：RGB / HSV 滑块与顶部开关');
  let c = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('#colorModes .cm-btn')].map(b => b.dataset.cm),
    blocks: [...document.querySelectorAll('.cm-block[data-cm-block]')].map(b => ({ k: b.dataset.cmBlock, off: b.classList.contains('off') })),
    hiddenCount: [...document.querySelectorAll('.cm-block[data-cm-block]')].filter(b => b.classList.contains('off')).length
  }));
  ok('顶部有 4 个开关：色轮/RGB/HSV/色板',
    JSON.stringify(c.modes) === JSON.stringify(['wheel', 'rgb', 'hsv', 'swatch']), c.modes);
  ok('有 4 个可折叠的块', c.blocks.length === 4, c.blocks);

  // 全部打开，方便后面测滑块
  await page.evaluate(() => {
    document.querySelectorAll('#colorModes .cm-btn').forEach(b => {
      if (!b.classList.contains('on')) b.click();
    });
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({
    offCount: [...document.querySelectorAll('.cm-block[data-cm-block]')].filter(b => b.classList.contains('off')).length,
    onCount: [...document.querySelectorAll('#colorModes .cm-btn.on')].length,
    rgbVisible: document.getElementById('slR').getBoundingClientRect().height > 0,
    stored: localStorage.getItem('chahu.colorBlocks')
  }));
  ok('点开后 4 块全显示、按钮全高亮', c.offCount === 0 && c.onCount === 4 && c.rgbVisible === true, c);
  ok('开关状态被记进 localStorage', /"rgb":true/.test(c.stored || ''), c.stored);

  console.log('\n【八】RGB 滑块 → 颜色');
  // 点色板上的一个已知颜色，验证 setColor 会把滑条同步过去
  const swatch = await page.evaluate(() => {
    const i = document.querySelectorAll('#palette i')[3];
    const hex = i.title;
    i.click();
    return hex;
  });
  await page.waitForTimeout(180);
  c = await page.evaluate((hex) => {
    const h = hex.replace('#', '');
    return {
      hex,
      want: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      got: [Number(document.getElementById('slR').value), Number(document.getElementById('slG').value), Number(document.getElementById('slB').value)],
      nums: [Number(document.getElementById('numR').value), Number(document.getElementById('numG').value), Number(document.getElementById('numB').value)],
      input: document.getElementById('hexInput').value
    };
  }, swatch);
  ok('选色板颜色后 RGB 滑条同步到该颜色',
    JSON.stringify(c.got) === JSON.stringify(c.want), c);
  ok('数字框也跟着同步', JSON.stringify(c.nums) === JSON.stringify(c.want), c);

  // 先固定成 #2B2B2B，再单拖 R
  await page.evaluate(() => {
    ['R', 'G', 'B'].forEach((ch, i) => {
      const n = document.getElementById('num' + ch);
      n.value = String(43);
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value }));
  ok('用数字框设成 #2B2B2B', c.hex === '#2B2B2B', c.hex);

  await page.evaluate(() => {
    const s = document.getElementById('slR');
    s.value = '255';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(160);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value, g: document.getElementById('numG').value, b: document.getElementById('numB').value }));
  ok('拖 R 到 255 → 颜色 #FF2B2B', c.hex === '#FF2B2B', c.hex);
  ok('G/B 保持 43', Number(c.g) === 43 && Number(c.b) === 43, c);

  await page.evaluate(() => {
    const n = document.getElementById('numG');
    n.value = '0';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    const m = document.getElementById('numB');
    m.value = '0';
    m.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(160);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value, slg: document.getElementById('slG').value, slb: document.getElementById('slB').value }));
  ok('数字框改 G/B → 颜色 #FF0000 且滑条同步', c.hex === '#FF0000' && c.slg === '0' && c.slb === '0', c);

  console.log('\n【九】HSV 滑块');
  c = await page.evaluate(() => ({ h: document.getElementById('slH').value, s: document.getElementById('slS').value, v: document.getElementById('slV').value }));
  ok('#FF0000 对应 H=0 S=100 V=100', Number(c.h) === 0 && Number(c.s) === 100 && Number(c.v) === 100, c);

  await page.evaluate(() => {
    const s = document.getElementById('slH');
    s.value = '120';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value, r: document.getElementById('numR').value, g: document.getElementById('numG').value, b: document.getElementById('numB').value }));
  ok('H 拖到 120 → #00FF00', c.hex === '#00FF00', c.hex);
  ok('RGB 数字框同步为 0/255/0', c.r === '0' && c.g === '255' && c.b === '0', c);

  await page.evaluate(() => {
    const s = document.getElementById('slV');
    s.value = '0';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value, h: document.getElementById('slH').value }));
  ok('V=0 → 黑色', c.hex === '#000000', c.hex);
  ok('变黑后 H 仍保留 120（没被归零）', Number(c.h) === 120, c);

  await page.evaluate(() => {
    const s = document.getElementById('slV');
    s.value = '100';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value }));
  ok('V 拉回 100 → 回到 #00FF00（色相没丢）', c.hex === '#00FF00', c.hex);

  await page.evaluate(() => {
    const s = document.getElementById('slS');
    s.value = '50';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value }));
  ok('S=50 且 V=100 → #80FF80', c.hex === '#80FF80', c.hex);

  console.log('\n【十】色板 / 最近色 / 色轮仍照常工作');
  await page.evaluate(() => {
    const i = document.querySelectorAll('#palette i')[20];
    i.click();
  });
  await page.waitForTimeout(160);
  const before = await page.evaluate(() => document.getElementById('hexInput').value);
  c = await page.evaluate(() => ({ recent: document.querySelectorAll('#recentColors i').length }));
  ok('点色板能换色', /^#[0-9A-F]{6}$/.test(before), before);
  ok('最近色有记录', c.recent > 0, c);

  await page.evaluate(() => {
    const cv = document.getElementById('colorWheel');
    const r = cv.getBoundingClientRect();
    const x = r.right - 8, y = r.top + r.height / 2;
    cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  });
  await page.waitForTimeout(220);
  c = await page.evaluate(() => ({ hex: document.getElementById('hexInput').value, h: document.getElementById('slH').value, v: document.getElementById('numV').value }));
  ok('点色轮右端（色相 0）→ 偏红', /^#[EF][0-9A-F]/.test(c.hex) || Number(c.h) < 12 || Number(c.h) > 348, c);
  ok('HSV 滑条跟着色轮更新', Number(c.v) > 50, c);

  console.log('\n【十一】开关状态刷新后保持');
  await page.evaluate(() => {
    // 只留下 RGB，收起色轮 / HSV / 色板
    document.querySelectorAll('#colorModes .cm-btn').forEach(b => {
      const want = b.dataset.cm === 'rgb';
      if (b.classList.contains('on') !== want) b.click();
    });
  });
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await join(page);
  c = await page.evaluate(() => ({
    on: [...document.querySelectorAll('#colorModes .cm-btn.on')].map(b => b.dataset.cm),
    wheelOff: document.querySelector('.cm-block[data-cm-block="wheel"]').classList.contains('off'),
    swatchOff: document.querySelector('.cm-block[data-cm-block="swatch"]').classList.contains('off')
  }));
  ok('刷新后只剩 RGB 开着', JSON.stringify(c.on) === JSON.stringify(['rgb']), c.on);
  ok('色轮与色板保持收起', c.wheelOff === true && c.swatchOff === true, c);

  console.log('\n【十二】页面无 JS 报错');
  ok('没有 pageerror', errs.length === 0, errs.slice(0, 4));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
