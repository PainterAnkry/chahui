/**
 * 茶绘 · 头像回归
 *
 * 头像是本轮新加的东西，而它的风险点全在「体积」和「一致性」上：
 *
 *   · **体积**：头像会跟着**每一次成员广播**发给全房。40 人的房间要是每人一张
 *     100KB 的图，一次广播就是 4MB —— 所以「本机压到 96px」和「服务端卡 48KB」
 *     是两道必须都在的闸门。第 6 组故意绕开前端直接往 WebSocket 上抛超大头像，
 *     验的就是服务端那一道（只测前端的话，把 normalizeAvatar 删了测试照样全绿）。
 *   · **一致性**：同一张头像，自己看到的和别人的看到的必须是同一张；
 *     清除之后两端的成员列表都要退回「颜色 + 名字首字」，不能一边留一半。
 *   · **走真实路径**：选图走 `#btnPickAvatar`（真的喂一个 PNG 文件进去，
 *     不是直接调 setMyAvatar），所以压缩、preview、localStorage、进房携带
 *     这一整条链都是真跑过的。
 *
 * 覆盖：
 *   1. 入口弹窗的头像控件（预览 / 选择 / 清除）
 *   2. 选一张 320×240 的图：在裁剪窗里框成方形 → 输出 96×96、体积 < 48KB、落进 localStorage
 *   3. 建房时随 ROOM_CREATE 带上去，另一端成员列表立刻是图片
 *   4. 已在房里改头像：走「进入茶绘室」把入口弹窗叫回来，改完**不用重进房**，
 *      另一端当场更新（这正是 member:avatar 这条消息存在的理由）
 *   5. 聊天消息上的头像也走同一份数据
 *   6. 服务端卡上限：绕开前端直接发超大头像 / 非图片 dataURL，**别人的屏幕上**
 *      一律退回默认（广播体积不会被顶穿）；之后再正常设一次还能恢复
 *   7. 清除头像：两端一起退回「颜色 + 首字」
 *   8. 头像存在本机：重开页面重新进房，头像自己回来
 *
 * 用法: node tools/test-avatar.js [http://127.0.0.1:8437]
 */
'use strict';
const zlib = require('zlib');
const { chromium } = require('./pw');
const P = require('../client/renderer/protocol.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}
const BASE = process.argv[2] || 'http://127.0.0.1:8437';

/* ============================================================
 * 手搓一张**真 PNG**：测试要喂给 `#brushFileInput` 那样的 file input，
 * 所以必须是能解码的字节，不能是假的 base64。不引第三方库，
 * 用 zlib 压一下 IDAT 就够了（8 位 RGBA、filter 全 0）。
 * ============================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 纯色 PNG（带一点点渐变，免得整张一个色块看不出压缩有没有压歪） */
function makePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = (rgba[0] + x) & 0xFF;
      raw[p++] = rgba[1];
      raw[p++] = (rgba[2] + y) & 0xFF;
      raw[p++] = rgba[3];
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================================================ 页面内小工具 */

const HELPERS = () => {
  window.__me = () => window.ChaApp.state.me;
  window.__meAva = () => window.ChaApp.state.me.avatar || '';
  /** 服务端那份成员表里某人的 avatar 长度（-1 = 根本没这个人） */
  window.__avaLen = (name) => {
    const m = (window.ChaApp.state.members || []).filter(x => x.name === name)[0];
    return m ? (m.avatar || '').length : -1;
  };
  /** 成员列表里某个昵称那一行的头像长什么样 */
  window.__avaRow = (name) => {
    const rows = Array.from(document.querySelectorAll('#memberList .member'));
    for (const r of rows) {
      const b = r.querySelector('.info b');
      if (b && b.textContent.indexOf(name) === 0) {
        const ava = r.querySelector('.ava');
        const img = r.querySelector('.ava img');
        return {
          hasImg: !!img,
          src: img ? (img.getAttribute('src') || '') : '',
          text: ava ? ava.textContent : '',
          bg: ava ? (ava.style.background || '') : ''
        };
      }
    }
    return null;
  };
  /** 聊天里最后一条消息的头像 */
  window.__chatAva = () => {
    const msgs = Array.from(document.querySelectorAll('#chatList .msg'));
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    const img = last.querySelector('.ava img');
    return { hasImg: !!img, src: img ? (img.getAttribute('src') || '') : '' };
  };
  /** 入口弹窗里的预览框 */
  window.__preview = () => {
    const e = document.getElementById('avaPreview');
    const img = e && e.querySelector('img');
    const clr = document.getElementById('btnClearAvatar');
    return {
      hasImg: !!img,
      src: img ? (img.getAttribute('src') || '') : '',
      text: e ? e.textContent.trim() : '',
      clearHidden: clr ? clr.classList.contains('hidden') : null
    };
  };
  /** 压缩后的实际像素尺寸（naturalWidth/Height，不是 CSS 尺寸） */
  window.__avaSize = () => new Promise(res => {
    const src = window.ChaApp.state.me.avatar || '';
    if (!src) return res(null);
    const im = new Image();
    im.onload = () => res([im.naturalWidth, im.naturalHeight]);
    im.onerror = () => res(null);
    im.src = src;
  });
  window.__ls = () => { try { return localStorage.getItem('chahu.avatar') || ''; } catch (e) { return '(throw)'; } };
  window.__toasts = () => Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' ⏐ ');
  window.__clearToasts = () => { document.querySelectorAll('.toast').forEach(t => t.remove()); };
};

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await fn()) return true;
    await sleep(120);
  }
  return false;
}

/** 走真实路径换头像：点「选择图片…」→ 接住 filechooser → 喂字节 */
async function pickAvatar(page, buf, name) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 8000 }),
    page.evaluate(() => document.getElementById('btnPickAvatar').click())
  ]);
  await chooser.setFiles({ name: name || 'ava.png', mimeType: 'image/png', buffer: buf });
  // v2.0.2 起选图先过裁剪窗：等它弹出，再点「就这个，用它」（默认居中 cover，不用动）
  await page.waitForFunction(
    () => document.getElementById('avaCropMask') && !document.getElementById('avaCropMask').classList.contains('hidden'),
    { timeout: 8000 }
  );
  await page.click('#btnAvaCropOk');
  await sleep(800);
}

/** 建房（入口弹窗此时必须是开着的） */
async function createRoom(page, nick, roomName, w, h) {
  await page.fill('#nameInput', nick);
  await page.fill('#newRoomName', roomName);
  await page.evaluate(([a, b]) => {
    const s = document.querySelector('#newRoomSize');
    if (s) {
      let hit = false;
      for (const o of s.options) if (o.value === a + 'x' + b) hit = true;
      if (!hit) { const o = document.createElement('option'); o.value = a + 'x' + b; o.textContent = a + '×' + b; s.appendChild(o); }
      s.value = a + 'x' + b;
    }
  }, [w, h]);
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(400);
  return page.evaluate(() => window.ChaApp.state.room.id);
}

/** 用 ?room= 直接进房；昵称要先塞进 localStorage，否则断言按名字找不到那一行 */
async function join(page, room, nick, avatar) {
  await page.addInitScript(([n, a]) => {
    try {
      localStorage.setItem('chahu.name', n);
      if (a) localStorage.setItem('chahu.avatar', a);
    } catch (e) { /* ignore */ }
  }, [nick, avatar || '']);
  await page.goto(BASE + '/?room=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, { timeout: 20000 });
  await sleep(900);
  await page.evaluate(HELPERS);
  await page.evaluate(() => {
    const m = document.getElementById('entryMask');
    if (m) m.classList.add('hidden');
    window.ChaApp.zoomFit();
    if (document.activeElement) document.activeElement.blur();
  });
  await sleep(500);
}

/** 把入口弹窗叫回来（房内改头像就走这条路：『进入茶绘室』按钮） */
async function reopenEntry(page) {
  await page.evaluate(() => document.getElementById('btnOpenEntry').click());
  await sleep(400);
}

async function closeEntry(page) {
  await page.evaluate(() => {
    const b = document.getElementById('btnEntryClose');
    if (b) b.click(); else document.getElementById('entryMask').classList.add('hidden');
  });
  await sleep(300);
}

/** 绕开前端直接发原始协议消息 */
async function raw(page, type, payload) {
  return page.evaluate(([t, p]) => window.ChaApp.net.send(t, p), [type, payload]);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errs = [];
  const mkPage = async () => {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    return p;
  };
  const A = await mkPage();
  const B = await mkPage();

  const IMG_A = makePng(320, 240, [200, 40, 40, 255]);   // 320×240 → 裁剪输出 96×96
  const IMG_B = makePng(120, 300, [40, 80, 200, 255]);   // 120×300（竖图）→ 裁剪输出 96×96

  // A 打开首页（先不建房，入口弹窗还在）
  await A.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.ChaApp, { timeout: 20000 });
  await A.waitForSelector('#entryMask:not(.hidden)');
  await A.evaluate(HELPERS);

  /* ================= 1) 控件在不在 ================= */
  console.log('\n=== 1) 入口弹窗的头像控件 ===');
  let pv = await A.evaluate(() => window.__preview());
  ok('有头像预览框 / 选择按钮 / 清除按钮',
    !!(await A.$('#avaPreview')) && !!(await A.$('#btnPickAvatar')) && !!(await A.$('#btnClearAvatar')));
  ok('没设头像时预览写的是「默认」', pv.text === '默认' && !pv.hasImg, pv);
  ok('没设头像时「清除」是藏着的', pv.clearHidden === true, pv.clearHidden);

  /* ================= 2) 选图 → 压缩 ================= */
  console.log('\n=== 2) 选一张 320×240 的图：裁剪成 96×96 ===');
  await pickAvatar(A, IMG_A);
  pv = await A.evaluate(() => window.__preview());
  const avaA = await A.evaluate(() => window.__meAva());
  const lenA = avaA.length;
  const sizeA = await A.evaluate(() => window.__avaSize());
  const lsA = await A.evaluate(() => window.__ls());
  ok('预览立刻变成了图片', pv.hasImg, pv);
  ok('预览用的就是同一份数据（src 与 state 一致）', pv.src === avaA && !!avaA);
  ok('压出来的东西是合法 dataURL（png/jpeg/webp）',
    /^data:image\/(png|jpeg|webp);base64,/.test(avaA), avaA.slice(0, 30));
  ok('体积在 48KB 上限以内（不然会被服务端丢掉）', lenA > 0 && lenA <= P.AVATAR_MAX, lenA + ' 字符');
  ok('裁剪输出固定 96×96（方形）', !!sizeA && sizeA[0] === 96 && sizeA[1] === 96, sizeA);
  ok('顺手存进了 localStorage（下次打开还在）', lsA === avaA && lsA.length > 0, lsA.length + ' 字符');
  ok('「清除」按钮露出来了', pv.clearHidden === false, pv.clearHidden);

  /* ================= 3) 建房时带上去 ================= */
  console.log('\n=== 3) 建房：头像随 ROOM_CREATE 带上去 ===');
  const room = await createRoom(A, '甲', '头像回归', 800, 1200);
  const meA = await A.evaluate(() => window.__me());
  ok('进房后自己这份头像还在', meA.avatar === avaA, (meA.avatar || '').length + ' 字符');
  ok('服务端也收到了（成员表里长度一致）',
    (await A.evaluate(() => window.__avaLen('甲'))) === lenA);

  await join(B, room, '乙');
  const rowB = await waitFor(async () => {
    const r = await B.evaluate(() => window.__avaRow('甲'));
    return r && r.hasImg;
  }) ? await B.evaluate(() => window.__avaRow('甲')) : await B.evaluate(() => window.__avaRow('甲'));
  ok('乙的成员列表里，甲那行显示的是图片（不是首字）', !!(rowB && rowB.hasImg), rowB && { hasImg: rowB.hasImg, text: rowB.text });
  ok('两端拿到的是同一张图（src 逐字符相同）', !!(rowB && rowB.src === avaA));
  const rowAself = await A.evaluate(() => window.__avaRow('甲'));
  ok('甲自己那行也是图片（自己看别人看都一样）', !!(rowAself && rowAself.hasImg));
  ok('乙没设头像 → 退回「颜色 + 名字首字」',
    !!(await (async () => { const r = await B.evaluate(() => window.__avaRow('乙')); return r && !r.hasImg && r.text === '乙' && !!r.bg; })()));

  /* ================= 4) 房内改头像，不重进房 ================= */
  console.log('\n=== 4) 房里改头像：不用重进房，另一端当场更新 ===');
  const roomIdBefore = await B.evaluate(() => window.ChaApp.state.room.id);
  await reopenEntry(B);
  ok('「进入茶绘室」能把入口弹窗叫回来（房内改头像的入口）',
    await B.evaluate(() => !document.getElementById('entryMask').classList.contains('hidden')));
  await pickAvatar(B, IMG_B);
  await closeEntry(B);
  const avaB = await B.evaluate(() => window.__meAva());
  const sizeB = await B.evaluate(() => window.__avaSize());
  ok('乙的头像裁剪输出也是固定 96×96（方形）',
    !!sizeB && sizeB[0] === 96 && sizeB[1] === 96, sizeB);
  const gotA = await waitFor(async () => {
    const r = await A.evaluate(() => window.__avaRow('乙'));
    return !!(r && r.hasImg && r.src === avaB);
  });
  const rowAB = await A.evaluate(() => window.__avaRow('乙'));
  ok('甲那边当场就换成了新图（member:avatar 广播到位）', gotA, rowAB && { hasImg: rowAB.hasImg, same: rowAB.src === avaB });
  ok('★ 没有重进房：房间号没变、会话还是同一个',
    (await B.evaluate(() => window.ChaApp.state.room.id)) === roomIdBefore
    && (await B.evaluate(() => window.ChaApp.state.joined)));
  ok('两张头像不是同一份（确实是换掉了，不是没生效）', avaB !== avaA);
  ok('服务端那份也换掉了（成员表长度 = 新头像长度）',
    (await A.evaluate(() => window.__avaLen('乙'))) === avaB.length);

  /* ================= 5) 聊天里的头像 ================= */
  console.log('\n=== 5) 聊天消息上的头像走同一份数据 ===');
  await A.fill('#chatInput', '看我的新头像');
  await A.press('#chatInput', 'Enter');
  await sleep(700);
  const chatB = await B.evaluate(() => window.__chatAva());
  ok('乙收到的这条聊天消息带着甲的头像图', !!(chatB && chatB.hasImg), chatB);
  ok('聊天里的头像与成员列表里的是同一张', !!(chatB && chatB.src === avaA));

  /* ================= 6) 服务端卡上限（绕开前端） ================= */
  console.log('\n=== 6) 服务端卡上限：绕开前端塞大图 ===');
  // ① 超大头像（> 48KB 的 dataURL）
  const huge = 'data:image/png;base64,' + 'A'.repeat(P.AVATAR_MAX + 1000);
  await raw(B, P.C2S.MEMBER_AVATAR, { avatar: huge });
  await sleep(900);
  const rowAB2 = await A.evaluate(() => window.__avaRow('乙'));
  ok('★ 超大头像没被接受：甲那边退回「颜色 + 首字」（广播体积不会被顶穿）',
    !!(rowAB2 && !rowAB2.hasImg && rowAB2.text === '乙'), rowAB2 && { hasImg: rowAB2.hasImg, text: rowAB2.text });
  ok('服务端成员表里也是空的', (await A.evaluate(() => window.__avaLen('乙'))) === 0);

  // ② 不是图片的 dataURL
  await raw(B, P.C2S.MEMBER_AVATAR, { avatar: 'data:text/html;base64,PHNjcmlwdD4=' });
  await sleep(700);
  ok('非图片的 dataURL 同样进不来（只放行 png/jpeg/webp）',
    (await A.evaluate(() => window.__avaLen('乙'))) === 0);

  // ③ 塞了脏数据之后还能正常恢复
  await reopenEntry(B);
  await pickAvatar(B, IMG_B);
  await closeEntry(B);
  const recovered = await waitFor(async () => {
    const r = await A.evaluate(() => window.__avaRow('乙'));
    return !!(r && r.hasImg);
  }, 8000);
  ok('被拒之后重新正常设一次，仍然生效（不是把这个人拉黑了）', recovered);

  /* ================= 7) 清除头像 ================= */
  console.log('\n=== 7) 清除头像：两端一起退回默认 ===');
  await reopenEntry(B);
  await B.evaluate(() => document.getElementById('btnClearAvatar').click());
  await sleep(900);
  const pvClear = await B.evaluate(() => window.__preview());
  ok('乙的预览回到「默认」', pvClear.text === '默认' && !pvClear.hasImg, pvClear);
  ok('乙的 localStorage 也清了', (await B.evaluate(() => window.__ls())) === '');
  ok('「清除」按钮又藏起来了', pvClear.clearHidden === true);
  const clearedBoth = await waitFor(async () => {
    const rA = await A.evaluate(() => window.__avaRow('乙'));
    const rB = await B.evaluate(() => window.__avaRow('乙'));
    return !!(rA && !rA.hasImg && rA.text === '乙' && rB && !rB.hasImg);
  });
  const rAc = await A.evaluate(() => window.__avaRow('乙'));
  const rBc = await B.evaluate(() => window.__avaRow('乙'));
  ok('★ 两端的成员列表都退回「颜色 + 名字首字」（不会一边图一边字）',
    clearedBoth, { 甲看到的: rAc, 乙看到的: rBc });
  ok('服务端也清掉了', (await A.evaluate(() => window.__avaLen('乙'))) === 0);
  await closeEntry(B);

  /* ================= 8) 头像跟着本机走 ================= */
  console.log('\n=== 8) 重开页面重新进房：头像自己回来 ===');
  await join(B, room, '乙', avaB);
  const meB = await B.evaluate(() => window.__meAva());
  ok('重新进房自动带上本机存的那张', meB === avaB, meB.length + ' 字符');
  const backOnA = await waitFor(async () => {
    const r = await A.evaluate(() => window.__avaRow('乙'));
    return !!(r && r.hasImg && r.src === avaB);
  }, 8000);
  ok('甲那边也重新看到图片了', backOnA);
  await A.fill('#chatInput', '欢迎回来');
  await A.press('#chatInput', 'Enter');
  await sleep(800);
  const rowAfter = await A.evaluate(() => window.__avaRow('甲'));
  ok('甲的聊天头像不受别人重进房影响（自己的还是自己的）', !!(rowAfter && rowAfter.hasImg));

  /* ================= 9) 运行期报错 ================= */
  console.log('\n=== 9) 运行期报错 ===');
  ok('全程没有 JS 报错', errs.length === 0, errs.length ? errs.slice(0, 3) : '');

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail));
  console.log('========================================');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试崩了：', e); process.exit(2); });
