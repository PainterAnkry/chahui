/**
 * 工程文件（.chahu）回归：保存 → 打开 → **逐图层逐像素比对**。
 *
 * 这一条的验收标准很硬：打开工程之后，每个图层的可见像素数、像素校验和、
 * 图层名、浓度、混合模式、可见性，都必须和保存那一刻**完全一致**。
 * 光断言「有几个图层」是不够的 —— 那证明不了像素真的搬过去了。
 *
 * 覆盖：
 *   1. 保存：走真实的下载链路，把落盘的 .chahu 读回来看结构
 *   2. 打开：走真实的「新建房间承载工程」流程（含确认弹窗），比对像素
 *   3. 坏文件：非 JSON / 不是茶绘的工程 / 版本太新 / 尺寸越界 / 图层超限
 *   4. 自动保存：驱动一次真实抓取，从 IndexedDB 读回来；再验证
 *      「干净退出不提示、异常结束才提示」这条判据
 *
 * 用法: node tools/test-project.js [http://localhost:8437]
 */
'use strict';
const { chromium } = require('./pw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

/** 每个图层的「指纹」：像素数 + 加权校验和 + 元数据。比对的基准 */
const LAYER_SIG = `(() => {
  const e = window.ChaApp.engine;
  return e.layerList().map(function (l) {
    const c = e.renderDocument({ onlyLayer: l.id, transparentBackground: true, rawLayer: true });
    const d = c.ctx.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
    let n = 0, s = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) { n++; s = (s * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + 1) % 2147483647; }
    }
    return { name: l.name, px: n, sig: s,
             opacity: Math.round(l.opacity * 100) / 100, blend: l.blend, visible: l.visible };
  });
})()`;

function sameSig(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.name !== y.name || x.px !== y.px || x.sig !== y.sig ||
      x.opacity !== y.opacity || x.blend !== y.blend || x.visible !== y.visible) return false;
  }
  return true;
}

async function waitForLayers(page, want, ms) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (ms || 20000)) {
    last = await page.evaluate(LAYER_SIG);
    if (sameSig(last, want)) return last;
    await sleep(300);
  }
  return last;
}

async function waitFor(page, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    if (await page.evaluate(fn)) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  const dialogs = [];
  page.on('pageerror', e => errs.push(e.message));
  // 「打开工程会新建房间」的确认框：一律接受，并记下文案供断言
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  await page.goto((process.argv[2] || 'http://localhost:8437') + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entryMask:not(.hidden)');
  await page.fill('#nameInput', '工程');
  await page.fill('#newRoomName', '工程回归');
  await page.evaluate(() => { document.querySelector('#newRoomSize').value = '800x1200'; });
  await page.click('#btnCreateRoom');
  await page.waitForFunction(() => window.ChaApp && window.ChaApp.state.joined, null, { timeout: 15000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#entryMask').classList.add('hidden'));
  await page.evaluate(() => document.querySelector('#btnZoomFit').click());
  await sleep(300);

  /* ---------- 1) 造一份有层次、有元数据的文档 ---------- */
  console.log('\n=== 造文档 ===');
  const box = await page.evaluate(() => {
    const r = document.querySelector('#view').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  async function stroke(x0, y0, x1, y1) {
    const pts = await page.evaluate(([a, b, c, d]) => {
      const e = window.ChaApp.engine;
      const p0 = e.docToScreen(a, b), p1 = e.docToScreen(c, d);
      const bx = document.querySelector('#view').getBoundingClientRect();
      return [[bx.left + p0.x, bx.top + p0.y], [bx.left + p1.x, bx.top + p1.y]];
    }, [x0, y0, x1, y1]);
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    await page.mouse.move(pts[1][0], pts[1][1], { steps: 12 });
    await page.mouse.up();
    await sleep(700);
  }

  await stroke(300, 300, 1200, 380);            // 图层 1 上画一笔
  const layer1Id = await page.evaluate(() => window.ChaApp.engine.layers[0].id);

  // 第 2 层：改名 + 半透明 + 正片叠底
  await page.evaluate(() => window.ChaApp.addLayer());
  await sleep(700);
  const layer2Id = await page.evaluate(() => window.ChaApp.engine.layers[1].id);
  await page.evaluate((lid) => {
    window.ChaApp.net.send(window.CHAPROTO.C2S.LAYER_UPD, {
      layerId: lid, patch: { name: '上层', opacity: 0.5, blend: 'multiply', visible: true }
    });
  }, layer2Id);
  await sleep(700);
  // 新增图层后活动图层**不会**自动切（点图层行才切），这里照用户会做的操作切过去，
  // 否则这一笔会落在第 1 层上，「第 2 层有内容」就永远立不住
  await page.evaluate((lid) => window.ChaApp.engine.setActiveLayer(lid), layer2Id);
  await stroke(200, 600, 600, 660);             // 在第 2 层上画一笔（画面中部，保证在可见区内）

  // 第 3 层：留空（验证「空图层存 null」这条路也走得通）
  await page.evaluate(() => window.ChaApp.addLayer());
  await sleep(700);
  // 顺手把第 1 层藏起来，验证可见性也能带回来
  await page.evaluate((lid) => {
    window.ChaApp.net.send(window.CHAPROTO.C2S.LAYER_UPD, { layerId: lid, patch: { visible: false } });
  }, layer1Id);
  await sleep(800);

  const before = await page.evaluate(LAYER_SIG);
  const oldRoomId = await page.evaluate(() => window.ChaApp.state.room.id);
  console.log('  保存前:', JSON.stringify(before));
  check('文档造好了：3 个图层', before.length === 3, String(before.length));
  check('第 1 层有内容、被藏起来了', before[0].px > 200 && before[0].visible === false,
    before[0].px + ' 像素 / visible=' + before[0].visible);
  check('第 2 层有内容、半透明 + 正片叠底', before[1].px > 200 &&
    before[1].opacity === 0.5 && before[1].blend === 'multiply',
    before[1].px + ' 像素 / ' + before[1].opacity + ' / ' + before[1].blend);
  check('第 3 层是空的', before[2].px === 0, before[2].px + ' 像素');

  /* ---------- 2) 保存：走真实下载链路 ---------- */
  console.log('\n=== 保存 ===');
  const filePath = await (async () => {
    const p = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await page.evaluate(() => window.ChaApp.saveProject());
    const dl = await p;
    if (!dl) return null;
    return { name: dl.suggestedFilename(), path: await dl.path() };
  })();

  check('点「保存工程」真的产生了下载', !!filePath, filePath && filePath.name);
  check('文件名是 .chahu 且带时间戳', !!filePath && /^茶绘-.+-\d{8}-\d{4}\.chahu$/.test(filePath.name),
    filePath && filePath.name);

  const text = filePath && filePath.path ? require('fs').readFileSync(filePath.path, 'utf8') : '';
  let saved = null;
  try { saved = JSON.parse(text); } catch (e) { /* 下面断言会报 */ }
  console.log('  文件大小:', text.length, '字符（UTF-8', Buffer.byteLength(text), '字节）');
  check('落盘的内容是合法 JSON', !!saved);
  check('带了 chahui-project 标记与版本号', !!saved && saved.format === 'chahui-project' && saved.version === 1,
    saved && (saved.format + ' v' + saved.version));
  check('画布尺寸跟着过来了', !!saved && saved.doc.width === 800 && saved.doc.height === 1200,
    saved && (saved.doc.width + '×' + saved.doc.height));
  check('三个图层都在文件里', !!saved && saved.doc.layers.length === 3,
    saved && String(saved.doc.layers.length));
  check('图层名 / 浓度 / 混合模式 / 可见性都存下来了',
    !!saved && saved.doc.layers[1].name === '上层' && saved.doc.layers[1].opacity === 0.5 &&
    saved.doc.layers[1].blend === 'multiply' && saved.doc.layers[0].visible === false,
    saved && JSON.stringify(saved.doc.layers.map(l => [l.name, l.opacity, l.blend, l.visible])));
  check('有内容的层存了 PNG，空层存 null',
    !!saved && /^data:image\/png;base64,/.test(saved.doc.layers[0].png || '') &&
    saved.doc.layers[2].png === null,
    saved && (String(saved.doc.layers[0].png).slice(0, 24) + ' / ' + saved.doc.layers[2].png));

  /* ---------- 3) 打开：新建房间 + 逐像素比对 ---------- */
  console.log('\n=== 打开（新建房间承载工程） ===');
  await page.evaluate((t) => window.ChaApp.loadProjectText(t, '工程.chahu'), text);
  // joinCount 必须 >= 2 —— 打开工程是「再入一次房」。少了这一条，
  // 「没卡住」会因为压根没开始装载而空转通过（第一版就是这么骗过自己的）。
  const joinedNew = await waitFor(page, () => {
    const S = window.ChaApp.state;
    return !!(S.joined && S.room && !S.projectLoad && (S.joinCount || 0) >= 2);
  }, 30000);
  check('真的又入了一次房（装载不是静默失败的）', joinedNew === true,
    'joinCount=' + await page.evaluate(() => window.ChaApp.state.joinCount || 0));
  check('装载流程跑完了（没有卡在半路）', joinedNew === true);
  const newRoomId = await page.evaluate(() => window.ChaApp.state.room.id);
  check('确实是新开了一个房间', !!newRoomId && newRoomId !== oldRoomId, newRoomId);
  check('弹了「会离开当前房间」的确认框', dialogs.length > 0, dialogs[0] && dialogs[0].slice(0, 24));

  const after = await waitForLayers(page, before, 25000);
  console.log('  打开后:', JSON.stringify(after));
  check('图层数与名字完全一致', sameSig(after, before) || (after && before.every((b, i) =>
    after[i] && after[i].name === b.name)),
    after && JSON.stringify(after.map(l => l.name)));
  check('★ 每一层的像素数、像素校验和、浓度、混合、可见性全部一致',
    sameSig(after, before),
    after && JSON.stringify(after.map(l => [l.px, l.sig])));

  const seqAfter = await page.evaluate(() => window.ChaApp.engine.seq);
  check('装载后 seq 往前走了（新底图的 baseSeq 必须 > 0）', seqAfter > 0, String(seqAfter));

  // 房间里是「带着内容的新房间」，不是只读快照 —— 还能接着画。
  // 注意要按**所有图层墨量的总和**来比：装载后活动图层会落到最后一层上，
  // 只盯第 1 层的像素数是看不出「画上去了没有」的。
  const sumPx = (arr) => (arr || []).reduce((a, l) => a + l.px, 0);
  await stroke(300, 400, 700, 460);
  const after2 = await page.evaluate(LAYER_SIG);
  check('装载后还能接着画（不是只读快照）', sumPx(after2) > sumPx(after),
    sumPx(after2) + ' vs ' + sumPx(after));

  // 关键回归：装载后画的这一笔必须扛得住「图层整体重绘」。
  // 装载会把 baseSeq 推到 room.seq+1，如果 engine.seq 没跟着抬起来，
  // 新笔迹的 seq 会 ≤ baseSeq，renderLayerFromHistory 把它当成已固化的旧笔迹跳过 ——
  // 症状就是「画完看着有，一切换图层 / 撤销一次就没了」。
  const redrawn = await page.evaluate(`(() => {
    const e = window.ChaApp.engine;
    e.layers.forEach(function (l) { e.renderLayerFromHistory(l); });
    return e.layerList().map(function (l) {
      const c = e.renderDocument({ onlyLayer: l.id, transparentBackground: true, rawLayer: true });
      const d = c.ctx.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) n++;
      return { px: n };
    });
  })()`);
  check('★ 装载后画的笔迹扛得住图层重绘（seq 水位没掉队）',
    sumPx(redrawn) === sumPx(after2), sumPx(redrawn) + ' vs ' + sumPx(after2));

  /* ---------- 4) 坏文件要明确报错 ---------- */
  console.log('\n=== 坏文件 ===');
  const bads = await page.evaluate(() => {
    const P = window.ChahuProject;
    const grab = (fn) => { try { fn(); return 'no-error'; } catch (e) { return e.message; } };
    const mk = (o) => JSON.stringify(o);
    const okPng = 'data:image/png;base64,iVBORw0KGgo=';
    return {
      notJson: grab(() => P.parse('随手写的一串字')),
      notOurs: grab(() => P.parse(mk({ format: 'photoshop-psd', version: 1, doc: {} }))),
      tooNew: grab(() => P.parse(mk({
        format: 'chahui-project', version: 99,
        doc: { width: 800, height: 600, layers: [{ name: 'A', png: okPng }] }
      }))),
      noLayers: grab(() => P.parse(mk({
        format: 'chahui-project', version: 1, doc: { width: 800, height: 600, layers: [] }
      }))),
      tooWide: grab(() => P.parse(mk({
        format: 'chahui-project', version: 1,
        doc: { width: 99999, height: 600, layers: [{ name: 'A', png: okPng }] }
      }))),
      tooManyLayers: grab(() => P.parse(mk({
        format: 'chahui-project', version: 1,
        doc: {
          width: 800, height: 600,
          layers: new Array(30).fill(0).map((_, i) => ({ name: 'L' + i, png: okPng }))
        }
      }))),
      // 一个「合法但空手」的工程：应该有内容却没有
      goodButPlain: grab(() => P.parse(mk({
        format: 'chahui-project', version: 1,
        doc: { width: 800, height: 600, layers: [{ name: 'A' }] }
      })))
    };
  });
  console.log('  ', JSON.stringify(bads));
  check('不是 JSON → 明确报错', /JSON/.test(bads.notJson), bads.notJson);
  check('不是茶绘的工程 → 明确报错', /茶绘/.test(bads.notOurs), bads.notOurs);
  check('文件版本比本机新 → 让用户升级而不是硬打开', /升级/.test(bads.tooNew), bads.tooNew);
  check('没有图层 → 明确报错', /图层/.test(bads.noLayers), bads.noLayers);
  check('画布尺寸越界 → 明确报错并给出范围', /尺寸/.test(bads.tooWide), bads.tooWide);
  check('图层数超限 → 明确报错', /上限/.test(bads.tooManyLayers), bads.tooManyLayers);
  check('只缺像素的工程能正常打开（缺 png 当空层）', bads.goodButPlain === 'no-error', bads.goodButPlain);

  /* ---------- 5) 自动保存草稿 ---------- */
  console.log('\n=== 自动保存 ===');
  await page.evaluate(() => window.ChaApp.autosaveNow());
  await sleep(1200);
  const rec = await page.evaluate(() => window.ChahuProject.draft.load().then(r => r ? {
    roomId: r.roomId, roomName: r.roomName, layers: r.project.doc.layers.length,
    strokes: r.strokeCount, w: r.project.doc.width, savedAt: r.savedAt
  } : null));
  console.log('  草稿:', JSON.stringify(rec));
  check('自动保存真的往 IndexedDB 写了一份', !!rec);
  check('草稿记着是哪个房间的画', !!rec && !!rec.roomId && rec.roomId === newRoomId, rec && rec.roomId);
  check('草稿内容与画布一致', !!rec && rec.layers === 3 && rec.w === 800,
    rec && (rec.layers + ' 层 / ' + rec.w + 'px'));

  // 「干净退出不提示、异常结束才提示」——这条判据很容易写反，单独钉住
  const setExit = (v) => page.evaluate((x) => {
    localStorage.setItem('chahu.exitAt', String(x));
  }, v);
  const barShown = () => page.evaluate(() => !document.querySelector('#draftBar').classList.contains('hidden'));

  await setExit(Date.now() + 10000);          // 模拟「刚刚干净退出过」
  await page.evaluate(() => window.ChaApp.refreshDraftBar());
  await sleep(700);
  check('正常刷新/关页面后**不再提示**恢复（否则每次开都弹，纯噪音）',
    (await barShown()) === false);

  await setExit(0);                           // 模拟「上次是崩的，exitAt 还是旧值」
  await page.evaluate(() => window.ChaApp.refreshDraftBar());
  const shown = await waitFor(page, () => !document.querySelector('#draftBar').classList.contains('hidden'), 6000);
  const info = await page.evaluate(() => document.querySelector('#draftInfo').textContent);
  console.log('  提示条:', info);
  check('上次异常结束时**会提示**恢复', shown === true);
  check('提示条写得清是哪个房间、多大、几层、什么时候存的',
    /3 层/.test(info) && /800/.test(info), info);

  await page.evaluate(() => window.ChaApp.dropDraft());
  await sleep(1000);
  const gone = await page.evaluate(() => window.ChahuProject.draft.load().then(r => !r));
  check('点「丢弃」之后草稿真的删了', gone === true);

  check('全程没有 JS 报错', errs.length === 0, errs.join(' | '));
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
