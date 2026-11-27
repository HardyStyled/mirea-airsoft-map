/* Единый токен кэш-бастинга (D2): ?v=N должен быть одинаковым во всём графе модулей и в
 * index.html. Правка вручную по 19 файлам гарантирует расхождение, поэтому — этот скрипт:
 *   node tools/bump_version.mjs 3
 * Он меняет только суффикс ?v=... у локальных импортов и у src/main.js в index.html. */
import fs from 'node:fs';
import path from 'node:path';

const target = Number(process.argv[2]);
if (!Number.isInteger(target) || target < 1) {
  console.error('нужен целый номер версии, например: node tools/bump_version.mjs 3');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const files = ['index.html'];
for (const dir of ['src', 'src/camera']) {
  for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
}

const re = /(\.js)\?v=\d+/g;
let changed = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  const src = fs.readFileSync(file, 'utf8');
  const isHtml = rel.endsWith('.html');
  const out = isHtml
    ? src.replace(/(src\/main\.js)\?v=\d+/g, `$1?v=${target}`)
         .replace(/(styles\/[A-Za-z]+\.css)\?v=\d+/g, `$1?v=${target}`)
    : src.replace(re, `$1?v=${target}`);
  if (out !== src) { fs.writeFileSync(file, out); changed++; }
}
console.log(`версия ${target}: обновлено файлов — ${changed} из ${files.length}`);
