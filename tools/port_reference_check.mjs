/* port_reference_check.mjs — ловит класс регрессов портирования: модуль обращается к чужому
 * экспорту, но не импортирует его. В ES-модулях такая опечатка не видна при загрузке (граф
 * собирается), а вылезает в рантайме — ReferenceError ровно в том кадре, где код нужен.
 * Проверка текстовая и дешёвая: имена экспортов собираются по всему src/, дальше смотрим, где
 * они упоминаются без импорта и без собственного объявления.
 * Запуск: node tools/port_reference_check.mjs   (exit 1 — есть незаимпортированные ссылки) */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] || 'src';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* import-строки вырезаем из тела: имя в import не считается использованием */
const IMPORT_RE = /import\s+(?:[\s\S]*?)\s*from\s*['"][^'"]+['"]\s*;?/g;

function importNames(src) {
  const names = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    const clause = m[0].replace(/^import\s+/, '').replace(/\s*from\s*['"].*$/, '');
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        if (bits.length === 2) names.add(bits[1].trim());
        else if (bits[0]) names.add(bits[0].trim());
      }
    }
    const rest = clause.replace(/\{[\s\S]*?\}/g, ' ').trim();
    for (const tok of rest.split(/\s+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(tok)) names.add(tok);
    }
  }
  return names;
}

function exportNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits.length === 2 ? bits[1] : bits[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function localDecls(src, name) {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(`(?:^|[;{}()\\n])\\s*(?:async\\s+)?(?:class|function|const|let|var)\\s+${n}\\b`).test(src) ||  // объявление, в т.ч. for (const x of …)
    new RegExp(`function\\s+${n}\\s*\\(`).test(src) ||                                                          // имя функции
    new RegExp(`^\\s*${n}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(src) ||                                             // метод класса/объекта
    new RegExp(`[,(]\\s*${n}\\s*[,)=]`).test(src);                                                              // параметр функции
}

function stripNoise(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')   /* блок-комментарии: в них полно латиницы */
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');   // строки и шаблоны не в счёт
}

const files = walk(ROOT);
const exportsByFile = new Map();
for (const f of files) exportsByFile.set(f, exportNames(readFileSync(f, 'utf8')));

const allExports = new Map();          // имя -> [файлы-экспортёры]
for (const [f, set] of exportsByFile) {
  for (const n of set) { if (!allExports.has(n)) allExports.set(n, []); allExports.get(n).push(f); }
}

let problems = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const imports = importNames(src);
  const body = src.replace(IMPORT_RE, '');
  const clean = stripNoise(body);
  for (const name of allExports.keys()) {
    if (name === 'default' || exportsByFile.get(f).has(name)) continue;
    if (imports.has(name) || localDecls(clean, name)) continue;
    const use = new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`);   // не .prop и не ключ объекта
    const at = clean.search(use);
    if (at >= 0) {
      problems++;
      console.log(`ОШИБКА ${relative('.', f)} — «${name}» используется, но не импортирован (экспорт: ${allExports.get(name).map(p => relative('.', p)).join(', ')})`);
    }
  }
}

if (problems) {
  console.log(`ИТОГ: ${problems} незаимпортированных ссылок`);
  process.exitCode = 1;
} else {
  console.log(`ИТОГ: ПРОВЕРКА ПРОЙДЕНА — ${files.length} модулей, незаимпортированных ссылок нет`);
}
