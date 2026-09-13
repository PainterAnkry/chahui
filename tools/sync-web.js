// 把 client/renderer 同步到 server/public，使同一套前端既能被 Electron 加载，也能被浏览器直接访问
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const from = path.join(root, 'client', 'renderer');
const to = path.join(root, 'server', 'public');

fs.mkdirSync(to, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile() && !e.name.endsWith('.map')) fs.copyFileSync(s, d);
  }
}

copyDir(from, to);
console.log('已同步前端 -> ' + to);
