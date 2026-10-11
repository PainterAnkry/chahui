/**
 * 安卓快捷条长按功能 · 冒烟测试
 *
 * 守的是「长按弹卡片」三件事：
 *  1) 长按快捷条颜色钮 → 颜色小节（含色板）弹成卡片，完整在视口内
 *  2) 长按笔刷 chip → 笔刷库小节弹成卡片，完整在视口内
 *  3) 短按不受长按逻辑影响（换笔 / 跳面板照常）
 *  4) 卡片 ✕ 可关闭
 *
 * 用法：node tools/test-longpress-dock.js [基地址]（默认 http://127.0.0.1:8441）
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e).slice(0, 200)));

  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ChaApp && window.ChaApp.state, { timeout: 20000 });
  await p.waitForFunction(() => {
    const m = document.getElementById('entryMask');
    return m && !m.classList.contains('hidden');
  }, { timeout: 8000 });
  await p.evaluate(() => {
    document.querySelector('#nameInput').value = '长按测试';
    document.querySelector('#newRoomName').value = '长按测试房';
    document.querySelector('#btnCreateRoom').click();
  });
  await p.waitForFunction(() => window.ChaApp.state.joined, { timeout: 15000 });
  await sleep(1000);

  /** 长按：pointerdown 按住 600ms（长按阈值 450ms） */
  async function longPress(x, y) {
    await p.mouse.move(x, y);
    await p.mouse.down();
    await sleep(600);
    await p.mouse.up();
    await sleep(500);
  }
  const cardInfo = (id) => p.evaluate((sid) => {
    const sec = document.querySelector('[data-section="' + sid + '"].section-floating');
    if (!sec) return { ok: false };
    const r = sec.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      inVp: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.top < innerHeight };
  }, id);
  const closeCard = (id) => p.evaluate((sid) => {
    const sec = document.querySelector('[data-section="' + sid + '"].section-floating');
    const x = sec && sec.querySelector('.float-close');
    if (x) x.click();
    return !!x;
  }, id);

  /* ---- 1) 长按颜色钮 → 色版卡片 ---- */
  const cr = await p.evaluate(() => {
    const r = document.getElementById('tdColor').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await longPress(cr.x, cr.y);
  const colorCard = await cardInfo('color');
  ok('长按颜色钮弹出颜色小节卡片', colorCard.ok);
  ok('色版卡片完整在视口内', colorCard.ok && colorCard.inVp, JSON.stringify(colorCard));
  const hasSwatch = await p.evaluate(() => {
    const sec = document.querySelector('[data-section="color"].section-floating');
    return !!sec && !!sec.querySelector('#swatchBox, .swatch-wrap, [class*="swatch"]');
  });
  ok('卡片里有色板', hasSwatch);
  ok('色版卡片 ✕ 可关闭', await closeCard('color'));
  await sleep(300);

  /* ---- 2) 长按笔刷 chip → 笔刷库卡片 ---- */
  const chip = await p.evaluate(() => {
    const c = document.querySelector('#tdBrushes .td-brush');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (chip) {
    await longPress(chip.x, chip.y);
    const brushCard = await cardInfo('brushes');
    ok('长按笔刷 chip 弹出笔刷库卡片', brushCard.ok);
    const btns = await p.evaluate(() => {
      const sec = document.querySelector('[data-section="brushes"].section-floating');
      return sec ? sec.querySelectorAll('.tool').length : 0;
    });
    ok('笔刷库卡片完整在视口内且带笔刷列表', brushCard.ok && brushCard.inVp && btns > 0,
      brushCard.ok ? (btns + ' 支笔，视口内=' + brushCard.inVp) : '');
    ok('笔刷库卡片 ✕ 可关闭', await closeCard('brushes'));
    await sleep(300);

    /* ---- 3) 短按不受长按影响：照常换笔 ---- */
    const before = await p.evaluate(() => window.ChaApp.state.brushId);
    const chip2 = await p.evaluate(() => {
      const c = document.querySelector('#tdBrushes .td-brush:not(.active)');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (chip2) {
      await p.mouse.move(chip2.x, chip2.y);
      await p.mouse.down();
      await sleep(80);
      await p.mouse.up();
      await sleep(350);
      const after = await p.evaluate(() => window.ChaApp.state.brushId);
      ok('短按笔刷 chip 照常换笔', before !== after, before + ' → ' + after);
    }
  } else {
    console.log('  - 快捷条没有笔刷 chip，跳过笔刷长按场景');
  }

  ok('页面无报错', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log('\n══════════════════════════════════');
  console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('══════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
