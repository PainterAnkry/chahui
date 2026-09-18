/* 回归跑批：把浏览器类测试逐个跑一遍，只收结果。
   用法: node tools/_runall.js [baseUrl]  —— 默认 http://127.0.0.1:8440 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8440';
const SUITE = [
  'test-browser.js',
  'test-stroke.js',
  'test-selection.js',
  'test-overlay.js',
  'test-transform-buttons.js',
  'test-brush-import.js',
  'test-project.js',
  'test-paste.js',
  'test-replay.js',
  'test-brush-feel.js',
  'test-menu.js',
  'test-shell.js',
  'test-wheel.js',
  'test-mesh.js',
  'test-filters.js',
  'test-export.js',
  'test-psd.js',
  'test-text.js',
  'test-ruler.js',
  'test-liquify.js',
  'test-personal.js',
  'test-layout.js',
  'test-panels.js',
  'test-color.js',
  'test-cansize.js',
  'test-collab-view.js',
  'test-readonly.js',
  'test-avatar.js',
  'test-groups.js',
  'test-update.js',
  'test-chain-ui.js',
  'test-passkeys.js',
  'test-mobile.js',
  'test-chain-sim.js',
  'test-theme-ui.js',
  // 隧道不需要服务端，它自己起假进程；放最后当纯 Node 用例跑
  'test-tunnel.js',
  'verify-issues.js',
  'verify-round2.js',
  'verify-round3.js'
];

const results = [];
for (const f of SUITE) {
  const p = path.join(__dirname, f);
  process.stdout.write('\n================ ' + f + ' ================\n');
  const r = spawnSync(process.execPath, [p, BASE], {
    stdio: 'inherit',
    env: process.env,
    cwd: path.join(__dirname, '..')
  });
  results.push({ file: f, code: r.status });
  process.stdout.write('---- ' + f + ' → exit ' + r.status + '\n');
}

process.stdout.write('\n\n================ 汇总 ================\n');
let bad = 0;
for (const x of results) {
  if (x.code !== 0) bad++;
  process.stdout.write((x.code === 0 ? '  ✓ ' : '  ✗ ') + x.file + '  (exit ' + x.code + ')\n');
}
process.stdout.write('\n' + (results.length - bad) + '/' + results.length + ' 个测试文件通过\n');
process.exit(bad ? 1 : 0);
