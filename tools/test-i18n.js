/* 多语言回归：默认中文 → EN → 日本語 → 回中文
 * ① 默认中文，页面中文占位齐全
 * ② 切 EN：#btnShare 变 Share、菜单/面板中文节点大幅减少、html lang=en
 * ③ 切 JA：出现日文（かな/カナ），html lang=ja
 * ④ 切回中文：关键文案与初始快照完全一致（不能残留英文/日文，也不能丢字）
 * ⑤ 刷新后语言保持（localStorage）
 * 用法：node tools/test-i18n.js [BASE]   （默认 http://127.0.0.1:8440）
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

const HAN = /[\u4e00-\u9fff]/;
const KANA = /[\u3040-\u30ff]/;

async function enterRoom(page) {
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', 'T');
  await page.fill('#newRoomName', 'i18n' + (Date.now() % 100000));
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(500);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await sleep(300);
}

// 统计 body 下可见文本节点里的中文/日文数量（跳过 canvas/script 等）
const countScripts = () => {
  const skip = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'TEXTAREA']);
  let han = 0, kana = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || skip.has(p.tagName)) continue;
    if (!n.nodeValue.trim()) continue;
    if (/[\u4e00-\u9fff]/.test(n.nodeValue)) han++;
    if (/[\u3040-\u30ff]/.test(n.nodeValue)) kana++;
  }
  return { han, kana };
};

// 中文专有高频词命中数：日文虽含汉字，但这些简体词不会出现，拿它当「还是中文」的判据
const zhWordHits = () => {
  const words = ['房间', '分享', '导出', '撤销', '图层', '笔刷', '设置', '画布', '游戏', '录制', '固化', '变换', '回放', '保存', '取消', '继续'];
  const t = document.body.innerText || '';
  return words.reduce((n, w) => n + (t.split(w).length - 1), 0);
};

// 关于对话框：三个页签逐页点开，返回每页纯文本 + 中文节点数
async function aboutScan(page) {
  await page.evaluate(() => document.querySelector('#aboutMask').classList.remove('hidden'));
  const tabs = await page.$$('#aboutMask .about-tabs .tab');
  const out = [];
  for (const t of tabs) {
    await t.click().catch(() => {});
    await sleep(150);
    out.push(await page.evaluate(() => {
      const box = document.querySelector('#aboutBody');
      const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
      let n, han = 0, txt = '';
      while ((n = w.nextNode())) {
        const s = n.nodeValue.trim();
        if (!s) continue;
        txt += s + ' ';
        if (/[\u4e00-\u9fff]/.test(s)) han++;
      }
      return { han, txt: txt.slice(0, 400) };
    }));
  }
  await page.evaluate(() => document.querySelector('#aboutMask').classList.add('hidden'));
  return out;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await enterRoom(page);

  // 初始快照：一批关键文案
  const snap = await page.evaluate(() => {
    const ids = ['btnRooms', 'btnGame', 'btnCanvas', 'btnExport', 'btnShare'];
    const out = {};
    ids.forEach(id => { const el = document.getElementById(id); out[id] = el ? el.textContent.trim() : null; });
    out.title = document.title;
    out.lang = document.documentElement.lang;
    out.count = null;
    return out;
  });
  const zh0 = await page.evaluate(countScripts);
  const zhWords0 = await page.evaluate(zhWordHits);
  ok('默认中文', snap.btnShare === '分享' && /^zh/.test(snap.lang), { share: snap.btnShare, lang: snap.lang });
  ok('中文文案量正常（>40 个中文节点）', zh0.han > 40, zh0);
  ok('中文界面高频词齐全（> 5 个）', zhWords0 >= 5, zhWords0);

  /* ② EN */
  await page.click('#langSwitch [data-lang="en"]');
  await sleep(400);
  const en = await page.evaluate(countScripts);
  const enSnap = await page.evaluate(() => {
    const g = id => (document.getElementById(id) || {}).textContent;
    return {
      share: g('btnShare').trim(), rooms: g('btnRooms').trim(), exp: g('btnExport').trim(),
      lang: document.documentElement.lang, title: document.title,
      menuItem: (document.querySelector('.menu-bar button, .menus button') || {}).textContent
    };
  });
  ok('EN：分享 → Share', enSnap.share === 'Share', enSnap.share);
  ok('EN：房间/导出已翻译', enSnap.rooms === 'Rooms' || enSnap.rooms === 'Room', enSnap.rooms + ' / ' + enSnap.exp);
  ok('EN：html lang=en', enSnap.lang === 'en', enSnap.lang);
  const zhWordsEn = await page.evaluate(zhWordHits);
  ok('EN：界面中文高频词基本消失（≤ 2）', zhWordsEn <= 2, { before: zhWords0, after: zhWordsEn });
  ok('EN：无日文混入', en.kana === 0, en.kana);

  // 语言开关自身的「中/EN/日」不该被翻译（各语言都用母语写法）
  const langBtns = await page.evaluate(() =>
    [...document.querySelectorAll('#langSwitch [data-lang]')].map(b => b.textContent.trim()));
  ok('EN：语言开关保持中/EN/日', langBtns.join('/') === '中/EN/日', langBtns);

  // 关于对话框是「整块查表」翻的长文，单独验一遍
  const aboutEn = await aboutScan(page);
  ok('EN：关于 3 个页签无中文残留', aboutEn.every(x => x.han === 0), aboutEn.map(x => x.han));
  ok('EN：关于正文已译（In one sentence）', /In one sentence/.test(aboutEn[0].txt), aboutEn[0].txt.slice(0, 60));

  /* ③ JA */
  await page.click('#langSwitch [data-lang="ja"]');
  await sleep(400);
  const ja = await page.evaluate(countScripts);
  const jaSnap = await page.evaluate(() => ({
    share: document.getElementById('btnShare').textContent.trim(),
    lang: document.documentElement.lang
  }));
  ok('JA：html lang=ja', jaSnap.lang === 'ja', jaSnap.lang);
  ok('JA：出现日文假名节点（> 20）', ja.kana > 20, ja.kana);
  ok('JA：分享 → 共有', jaSnap.share === '共有', jaSnap.share);
  const zhWordsJa = await page.evaluate(zhWordHits);
  ok('JA：界面中文高频词基本消失（≤ 2）', zhWordsJa <= 2, { before: zhWords0, after: zhWordsJa });
  const aboutJa = await aboutScan(page);
  ok('JA：关于正文已译（ひとことで）', /ひとことで/.test(aboutJa[0].txt), aboutJa[0].txt.slice(0, 60));

  /* ④ 回中文 */
  await page.click('#langSwitch [data-lang="zh"]');
  await sleep(400);
  const back = await page.evaluate(() => {
    const ids = ['btnRooms', 'btnGame', 'btnCanvas', 'btnExport', 'btnShare'];
    const out = {};
    ids.forEach(id => { const el = document.getElementById(id); out[id] = el ? el.textContent.trim() : null; });
    out.title = document.title;
    out.lang = document.documentElement.lang;
    return out;
  });
  const keys = ['btnRooms', 'btnGame', 'btnCanvas', 'btnExport', 'btnShare', 'title', 'lang'];
  const same = keys.every(k => back[k] === snap[k]);
  ok('切回中文：关键文案逐字恢复', same, { back, snap });
  const zh1 = await page.evaluate(countScripts);
  ok('切回中文：中文节点数恢复（±5%）', Math.abs(zh1.han - zh0.han) <= Math.max(2, zh0.han * 0.05), { before: zh0.han, after: zh1.han });
  ok('切回中文：没有残留日文', zh1.kana === 0, zh1.kana);

  /* ⑤ 持久化 */
  await page.click('#langSwitch [data-lang="en"]');
  await sleep(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaI18n, { timeout: 15000 });
  await sleep(600);
  const persist = await page.evaluate(() => ({
    lang: localStorage.getItem('chahu.lang'),
    htmlLang: document.documentElement.lang,
    btn: (document.getElementById('btnShare') || {}).textContent
  }));
  ok('刷新后语言保持（EN）', persist.lang === 'en' && persist.htmlLang === 'en', persist);

  ok('无页面报错', errs.length === 0, errs.slice(0, 3));
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
