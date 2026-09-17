// 打包验收：把 dist/win-unpacked 里的 app.asar 抽出来，确认打进去的确实是当前源码。
// 用法：node tools/verify-pkg.js
// 前一次踩过的坑：只看 build 的汇总像成功，其实便携版根本没生成、asar 里还是旧代码。
// 所以这里直接逐文件比对内容特征，而不是相信日志。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

let asarMod = null;
try {
  asarMod = require(require.resolve('@electron/asar', { paths: [path.join(ROOT, 'client', 'node_modules')] }));
} catch (e) { /* 下面统一报错 */ }

if (!asarMod) {
  console.log('✗ 找不到 @electron/asar（client/node_modules 里没装？）');
  process.exit(2);
}
if (!fs.existsSync(ASAR)) {
  console.log('✗ 没有找到 ' + ASAR + '（先 npm run dist）');
  process.exit(2);
}

// 每条 = [包内文件路径, [必须出现的特征]]。特征挑的是「这次改动才有的东西」，
// 命中不了说明 asar 里还是旧版本。
const CHECKS = [
  ['renderer/config.js', [/appVersion:\s*'([0-9.]+)'/]],
  ['renderer/engine.js', [/renderUnits/, /composeGroup/, /activeGroupIds/]],
  ['renderer/app.js', [/groupAdd/, /pickUpdateAsset/, /groups/]],
  ['renderer/project.js', [/groups/]],
  ['server/rooms.js', [/normalizeGroups/, /moveGroup/, /setLayerGroup/]],
  ['server/index.js', [/GROUP_ADD/, /GROUP_UPD/]],
  ['preload.js', [/downloadUpdate/]],
  ['main.js', [/chahu:download-update/]]
];

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
let bad = 0;

for (const [file, pats] of CHECKS) {
  let buf;
  try {
    buf = asarMod.extractFile(ASAR, file);
  } catch (e) {
    console.log('✗ 抽取失败 ' + file + '：' + (e && e.message ? e.message : e));
    bad++; continue;
  }
  if (!buf || !buf.length) { console.log('✗ 空文件 ' + file); bad++; continue; }
  const s = buf.toString('utf8');
  const miss = pats.filter(p => !p.test(s));
  if (miss.length) {
    console.log('✗ ' + file + ' 缺少特征：' + miss.map(String).join(', '));
    bad++; continue;
  }
  console.log('✓ ' + file + '  (' + s.split(/\r?\n/).length + ' 行, ' + (s.length / 1024).toFixed(0) + ' KB)');
}

// 版本号单独核一次：包里的 appVersion 必须等于 package.json
try {
  const cfg = asarMod.extractFile(ASAR, 'renderer/config.js').toString('utf8');
  const m = cfg.match(/appVersion:\s*'([0-9.]+)'/);
  if (!m || m[1] !== pkgVersion) {
    console.log('✗ 包内 appVersion=' + (m && m[1]) + '，但 package.json 是 ' + pkgVersion + '（打包前忘了 sync？）');
    bad++;
  } else {
    console.log('✓ 版本号一致：v' + pkgVersion);
  }
} catch (e) {
  console.log('✗ 读不到包内 config.js：' + e.message);
  bad++;
}

console.log(bad ? ('✗ 失败 ' + bad + ' 项') : '✓ 安装包内容与源码一致');
process.exit(bad ? 1 : 0);
