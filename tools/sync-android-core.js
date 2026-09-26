// 把 server/src 同步到 client/renderer/local-core，好让安卓端在 WebView 里
// 跑同一份房间状态机（离线模式）。服务端代码的唯一来源仍然是 server/src
// （跟 client/server 是同一个规矩，见 tools/sync-server.js）。
//
// local-core 是生成物，不进 git（.gitignore 里有它），每次构建前重跑一遍。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const from = path.join(root, 'server', 'src');
const to = path.join(root, 'client', 'renderer', 'local-core');

fs.mkdirSync(to, { recursive: true });

// 只应该有上一轮同步过去的产物，先清干净再拷，
// 免得服务端删掉的文件留在包里当幽灵。
for (const e of fs.readdirSync(to, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.js')) fs.rmSync(path.join(to, e.name), { force: true });
}

let n = 0;
const names = [];
for (const e of fs.readdirSync(from, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.js')) continue;
  fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  names.push(e.name);
  n++;
}
// 浏览器端没有「列目录」这回事：安卓 shim 的加载器靠这份清单预取全部源码
fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(names), 'utf8');
console.log('已同步服务端 -> ' + to + '（' + n + ' 个文件 + manifest.json）');
