'use strict';
/**
 * ★ v2.0.10：把 SAI2 笔刷包（SAI2-CATXQ-Ver1.22）里的笔刷**转换**成茶绘的笔刷参数。
 *
 * 用法：
 *   node tools/sai2-brush-convert.js "C:\\Users\\你\\Desktop\\SAI2-CATXQ-Ver1.22笔刷包"
 *   （不传就用这个默认路径；找不到就报错退出，绝不悄悄生成半份数据）
 *
 * 产出：client/renderer/sai2-brushes.js —— 一份**生成物**，内容是
 *   window.CHAHU_SAI2 = { source, picks, overrides, extra }
 *   · overrides：把内置的同名笔刷（铅笔/喷枪/画笔/水彩笔/马克笔/橡皮擦/选区笔/选区擦/
 *     油漆桶/渐变/模糊/特效笔/散布/涂抹）按包里的对应预设**替换参数**
 *   · extra：包里值得补进来的几只（草稿铅笔 / 水彩渗化 / 油画厚涂）
 *   brushes.js 会在定义完 ITEMS 之后把它套上去（没加载这份文件时行为完全不变）。
 *
 * ⚠ 参数不是 1:1 抄过来的，SAI2 和茶绘的笔刷模型不一样，映射规则写在 convert() 里，
 *   每一条都写了「为什么这么折」。**尺寸不照搬**：SAI2 存的是千分比（500 = 50%），
 *   而茶绘的 size 是像素，所以只拿它做「相对大小」的微调，绝对像素仍用我们调过的基准值。
 */
const fs = require('fs');
const path = require('path');
const { parseSaitdat } = require('./sai2-saitdat');

const PACK = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || '',
  'Desktop', 'SAI2-CATXQ-Ver1.22笔刷包');
const OUT = path.join(__dirname, '..', 'client', 'renderer', 'sai2-brushes.js');

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

/** 把包里 settings/custool/{nrm,ink,shp}/*.saitdat 全读出来 */
function loadPack(root) {
  const base = path.join(root, 'settings', 'custool');
  if (!fs.existsSync(base)) {
    throw new Error('没找到 ' + base + '（笔刷包解压后的目录结构应当是 <包>/settings/custool/...）');
  }
  const all = [];
  for (const sub of fs.readdirSync(base)) {
    const dir = path.join(base, sub);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.saitdat')) continue;
      try { all.push({ sub, file: f, o: parseSaitdat(path.join(dir, f)) }); }
      catch (e) { /* 单个文件坏了不该拖垮整包 */ }
    }
  }
  return all;
}

/** 纸纹名 → 茶绘的纸张质感 */
function paperOf(texnam) {
  const t = String(texnam || '');
  if (!t || t === '-') return 'none';
  if (/画布/.test(t)) return 'canvas';
  if (/铅笔|画用纸|图画纸|素描/.test(t)) return 'fine';
  if (/蜡笔|颗粒|亚麻|棉麻|水彩|渗|噪点|地表|粗糙/.test(t)) return 'coarse';
  return 'fine';
}

/**
 * SAI2 参数 → 茶绘笔刷参数。
 * base = 我们内置那一只的参数（拿它的 size / strength 等当基准）。
 */
function convert(o, kind, base) {
  const dens = clamp(num(o.curdens, 100) / 100, 0.02, 1);      // 浓度（%）
  // 硬度（%）—— SAI2 的「硬度 50」在我们引擎里是**很软**的边缘（实测铅笔 26px 时
  // 沿线墨量几乎是直线 dev≈1，纸纹完全看不出来）。所以：
  //   · 本来就该硬边的工具（铅笔 / 画笔 / 马克笔 / 橡皮 / 选区笔）：SAI 的「硬边档」（≥50）
  //     直接当**满硬边** —— 茶绘的 grain（纸纹）是 destination-in 打孔，边缘一软，
  //     沿线中心就摸不到孔洞了；<50 的按 1.8 倍线性放大（0 → 仍是最软的 0）。
  //   · 其余（喷枪 / 水彩 / 模糊 / 涂抹 / 散布 / 特效）本来就是软笔，压到 0.6 倍
  const HARD_KINDS = { pencil: 1, brush: 1, marker: 1, eraser: 1, selpen: 1, selers: 1 };
  const hardRaw = clamp(num(o.hardness, 50) / 100, 0, 1);
  const hard = HARD_KINDS[kind]
    ? (hardRaw >= 0.5 ? 1 : clamp(hardRaw * 1.8, 0, 0.9))
    : hardRaw * 0.6;
  const minS = clamp(num(o.minsize, 0) / 100, 0.02, 1);        // 最小直径（%）
  const minD = clamp(num(o.mindens, 0) / 100, 0, 1);           // 最小浓度（%）
  // 笔压→大小：SAI 的 szprsf 是开关（1 开 / 0 关），szsens 是感应强度（%）
  const szOn = num(o.szprsf, 1) ? 1 : 0.25;
  const szSens = clamp(num(o.szsens, 100) / 100, 0.4, 1);
  // 笔压→浓度：dnprsf 开关 + 「最小浓度」反过来就是浓度随笔压变化的幅度
  const dnOn = num(o.dnprsf, 1) ? 1 : 0.3;
  // 尺寸：SAI2 存千分比（500 = 50%），茶绘是像素 —— 只做相对微调，绝对像素用我们的基准
  const ratio = clamp(num(o.cursize, 500) / 1000, 0, 4);
  const size = Math.round(clamp(num(base.size, 12) * (0.8 + ratio * 0.6), 1, 400));
  // 纹理：texnam 有名字才算真有纹理（SAI 里「纹理强度 95 但没有纹理」= 没效果）
  const hasTex = !!o.texnam && o.texnam !== '-';
  const grain = hasTex ? clamp(num(o.texval, 0) / 100, 0, 1) * 0.6 : 0;
  // ⚠ 纸纹比例的下限兜到 0.6：SAI2 里「纹理缩放 20%」是很细的颗粒，而茶绘的 grain 是
  //   按比例采样噪点 —— 0.2 这么细的纹在 20~30px 的笔迹上**完全看不出起伏**
  //   （自测 test-brush-feel 抓过：沿线墨量标准差只有 1，等于没有纸纹）。
  const grainScale = clamp(num(o.texscl, 100) / 100, 0.6, 4);
  // 散布：SAI 的默认散布间隔是 15，超过才当「真的散」；散布笔 / 特效笔直接给一档
  const scatSpc = num(o.scatspc, 15);
  const scatter = (kind === 'scatter' || kind === 'effpen')
    ? 0.35 : clamp((scatSpc - 20) / 100, 0, 0.4);
  // 水彩：SAI 的「混色」= blend，「水分量」= dilution
  const mix = kind === 'water' ? clamp(num(o.blend, 0) / 100, 0, 1) : 0;
  const edge = kind === 'water' ? clamp(num(o.dilution, 0) / 100 * 0.5, 0, 0.6) : 0;
  const p = {
    size: size,
    opacity: dens,
    hardness: hard,
    minSize: minS,
    pressSize: clamp(szOn * szSens, 0.2, 1),
    pressOpacity: clamp(dnOn * (1 - minD), 0, 1),
    grain: +grain.toFixed(3),
    grainScale: +grainScale.toFixed(3),
    paper: paperOf(o.texnam),
    scatter: +scatter.toFixed(3)
  };
  if (kind === 'water') { p.mix = +mix.toFixed(3); p.edge = +edge.toFixed(3); }
  // 模糊 / 涂抹：强度跟「浓度」走（SAI 的涂抹只有浓度一个可调项）
  if (kind === 'blur' || kind === 'smudge') p.strength = clamp(dens * 0.8, 0.05, 1);
  return p;
}

/** 我们的 14 个目标 → 包里的挑选规则（先按工具类型，再按名字关键词） */
const MAP = [
  // 「铅笔」挑包里的 **B**（浓度 100 / 硬度 50 / 铅笔纹理）：
  //   HB 那只浓度只有 30（SAI2 里靠反复叠加变深），拿来当茶绘的**默认**笔太淡 ——
  //   蒙版上涂黑遮不住、纸上轻轻一划看不见。B 是同一套手感里浓度满的那只。
  { id: 'pencil', kind: 'pencil', want: ['B', '2B', 'HB', '草图铅笔'] },
  { id: 'airbrush', kind: 'airbrush', want: ['喷枪'] },
  // 「画笔」= 包里那两只**就叫「画笔」**的：500‰ 尺寸 / 浓度 100 / 硬边 50 / 最小 50，
  //   没有笔形也没有纹理 —— 正是 SAI2 的「基本圆笔」，拿它当我们的画笔最稳。
  { id: 'brush', kind: 'brush', want: ['画笔'], nameEq: '画笔', plain: true, preferHard: true },
  { id: 'watercolor', kind: 'water', want: ['水彩笔', '水彩'] },
  { id: 'marker', kind: 'marker', want: ['马克笔'], preferHard: true },
  { id: 'eraser', kind: 'eraser', want: ['橡皮擦'], preferHard: true },
  { id: 'select', kind: 'selpen', want: ['选区笔'], preferHard: true },
  { id: 'selectErase', kind: 'selers', want: ['选区擦'], preferHard: true },
  { id: 'bucket', kind: 'bucket', want: ['油漆桶'] },
  { id: 'gradient', kind: 'gradation', want: ['渐变'] },
  { id: 'blur', kind: 'blur', want: ['模糊'] },
  { id: 'effect', kind: 'effpen', want: ['特效笔'] },
  { id: 'scatter', kind: 'scatter', want: ['散布'] },
  { id: 'smudge', kind: 'smudge', want: ['涂抹'] }
];

/** 补进来的几只（用户：「加上你认为必要的笔刷，不要加太多」） */
const EXTRA = [
  { id: 'sai2Sketch', name: '草稿铅笔', icon: 'pencil', kind: 'pencil', want: ['草图铅笔'],
    tip: 'SAI2 笔刷包里的「草图铅笔」：60% 尺寸 + 低浓度，起稿时越描越深' },
  { id: 'sai2Wet', name: '水彩（渗化）', icon: 'watercolor', kind: 'water', want: ['水彩'], nameEq: '水彩',
    tip: 'SAI2 笔刷包里的「水彩」：带渗化笔形 + 混色/水分量，湿画法铺色' },
  { id: 'sai2Oil', name: '油画厚涂', icon: 'bristle', kind: 'brush', want: ['油画', '厚涂', '刮刀'],
    tip: 'SAI2 笔刷包里的油画笔：鬃毛笔形 + 画布纸纹，厚涂出笔触' }
];

function pick(all, kind, want, opt) {
  opt = opt || {};
  let list = all.filter(x => x.o.tidstr === kind);
  if (!list.length) return null;
  if (opt.nameEq) {
    const eq = list.filter(x => String(x.o.name || '') === opt.nameEq);
    if (eq.length) list = eq;
  }
  for (const w of want || []) {
    const hit = list.filter(x => String(x.o.name || '').indexOf(w) >= 0);
    if (hit.length) list = hit;
  }
  // 有些工具天然要硬边（马克笔 / 橡皮 / 选区笔）：同名多只时优先挑硬度 ≥ 50 的那只，
  // 别让「最接近 500‰」把一只软边版本选进来
  if (opt.preferHard) {
    const hard = list.filter(x => num(x.o.hardness, 0) >= 50);
    if (hard.length) list = hard;
  }
  if (opt.plain) {
    // 「画笔」优先挑最朴素的那一只：没有笔形 / 没有纹理 / 浓度 100 / 硬边
    const plainList = list.filter(x => (!x.o.fomnam || x.o.fomnam === '-') && (!x.o.texnam || x.o.texnam === '-')
      && num(x.o.curdens, 0) >= 90 && num(x.o.hardness, 0) >= 50);
    if (plainList.length) list = plainList;
  }
  // 同名多只时挑「最中间」的那一只（尺寸接近 500‰，别挑到 3420 那种极端值）
  list = list.slice().sort((a, b) =>
    Math.abs(num(a.o.cursize, 500) - 500) - Math.abs(num(b.o.cursize, 500) - 500));
  return list[0];
}

function main() {
  const all = loadPack(PACK);
  console.log('读到 ' + all.length + ' 个 SAI2 预设（' + PACK + '）');
  const byKind = {};
  all.forEach(x => { byKind[x.o.tidstr] = (byKind[x.o.tidstr] || 0) + 1; });

  // 内置笔刷的基准参数（尺寸 / 强度用我们的，手感参数用 SAI2 的）
  const P = require(path.join(__dirname, '..', 'shared', 'protocol'));
  global.CHAPROTO = P;
  const BASE = {
    pencil: { size: 2 }, hardRound: { size: 19 }, inking: { size: 3 },
    bristle: { size: 22 }, dry: { size: 20 }, chalk: { size: 26 }, glow: { size: 30 },
    pencilSoft: { size: 4 }, airbrush: { size: 30 }, brush: { size: 16 },
    watercolor: { size: 24 }, marker: { size: 26 }, eraser: { size: 28 },
    select: { size: 20 }, selectErase: { size: 20 }, bucket: { size: 20 },
    gradient: { size: 20 }, blur: { size: 26 }, effect: { size: 24 },
    scatter: { size: 22 }, smudge: { size: 26 }
  };

  const picks = {}, overrides = {}, extra = [];
  for (const rule of MAP) {
    const hit = pick(all, rule.kind, rule.want, { plain: rule.plain, preferHard: rule.preferHard, nameEq: rule.nameEq });
    if (!hit) { console.log('  ! ' + rule.id + '：包里没有 ' + rule.kind + ' 这一类，保留原样'); continue; }
    picks[rule.id] = { from: hit.o.name, kind: rule.kind, file: hit.sub + '/' + hit.file };
    // 油漆桶 / 渐变：包里没有可映射的参数（只颜色），保留我们的默认值
    if (rule.kind === 'bucket' || rule.kind === 'gradation') continue;
    overrides[rule.id] = {
      from: hit.o.name,
      params: convert(hit.o, rule.kind, BASE[rule.id] || { size: 16 })
    };
    console.log('  · ' + rule.id.padEnd(12) + ' ← [' + rule.kind + '] ' + String(hit.o.name).padEnd(10)
      + '  ' + JSON.stringify(overrides[rule.id].params));
  }
  for (const x of EXTRA) {
    const hit = pick(all, x.kind, x.want, { nameEq: x.nameEq });
    if (!hit) { console.log('  ! 追加 ' + x.id + '：没找到'); continue; }
    extra.push({
      id: x.id, name: x.name, icon: x.icon, tool: 'brush', type: 'brush',
      tip: x.tip, from: hit.o.name,
      params: convert(hit.o, x.kind, { size: 14 })
    });
    console.log('  + ' + x.id.padEnd(12) + ' ← [' + x.kind + '] ' + hit.o.name + '  ' + JSON.stringify(extra[extra.length - 1].params));
  }

  const body = [
    "'use strict';",
    '/**',
    ' * ★ v2.0.10：这份文件是 **tools/sai2-brush-convert.js 生成的**，别手改。',
    ' *',
    ' * 来源：SAI2 笔刷包「' + path.basename(PACK) + '」（作者：万能的小奇喵，见包内「使用教程与声明.txt」）。',
    ' * 生成时间：' + new Date().toISOString().slice(0, 16).replace('T', ' '),
    ' *',
    ' * 里面只有**参数**：brushs.js 在定义完 ITEMS 之后把它套到同 id 的内置笔刷上，',
    ' * 并在末尾追加 extra 里那几只。没加载这一份（或包没解压）时行为与之前完全一样。',
    ' *',
    ' * ⚠ 尺寸不是照搬的：SAI2 存千分比（500 = 50%），茶绘是像素，所以只拿它做相对微调，',
    ' *   绝对像素仍用我们调过的基准值 —— 否则一换包所有笔刷都会大得没法用。',
    ' */',
    '(function (global) {',
    "  'use strict';",
    '  global.CHAHU_SAI2 = ' + JSON.stringify({ source: path.basename(PACK), picks: picks, overrides: overrides, extra: extra }, null, 2) + ';',
    '})(window);',
    ''
  ].join('\n');
  fs.writeFileSync(OUT, body, 'utf8');
  console.log('\n写出 ' + OUT + '（' + Object.keys(overrides).length + ' 只替换 + '
    + extra.length + ' 只追加）');
}

main();
