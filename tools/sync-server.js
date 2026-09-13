// 把 server/src 同步到 client/server，好让桌面端把它打进包里当「内置服务器」跑。
// 服务端代码的唯一来源仍然是 server/src（跟 client/renderer 与 server/public 是同一个规矩）。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const from = path.join(root, 'server', 'src');
const to = path.join(root, 'client', 'server');

fs.mkdirSync(to, { recursive: true });

// client/server 里只应该有上一轮同步过去的产物，先清干净再拷，
// 免得服务端删掉的文件在包里留成幽灵。
for (const e of fs.readdirSync(to, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.js')) fs.rmSync(path.join(to, e.name), { force: true });
}

let n = 0;
for (const e of fs.readdirSync(from, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.js')) continue;
  fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  n++;
}
console.log('已同步服务端 -> ' + to + '（' + n + ' 个文件）');
