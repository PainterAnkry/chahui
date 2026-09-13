// 把 shared/protocol.js 复制到 server/src 与 client/renderer，保证唯一来源
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'shared', 'protocol.js');
const targets = [
  path.join(root, 'server', 'src', 'protocol.js'),
  path.join(root, 'client', 'renderer', 'protocol.js')
];

const code = fs.readFileSync(src, 'utf8');
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  const old = fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : '';
  if (old === code) {
    console.log('未变化: ' + t);
    continue;
  }
  fs.writeFileSync(t, code, 'utf8');
  console.log('已同步: ' + t);
}
