// 把 extension/ 打包成「Zen（火狐）能临时载入」的目录 _dist-firefox/。
// 火狐要求清单文件叫 manifest.json，所以这里用 manifest.firefox.json 顶上去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'extension');
const OUT = path.join(HERE, '_dist-firefox');
// manifest.firefox.json 指向 options.html，所以设置页的两个文件也要一起进包，
// 否则火狐/ Zen 里点「设置」是 404。
const files = ['background.js', 'content.js', 'options.html', 'options.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  console.log('复制 ' + f);
}
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.firefox.json'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('写 manifest.json（' + manifest.name + ' v' + manifest.version + '）');
console.log('输出目录：' + OUT);
