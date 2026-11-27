/* tools/module_structure_check.mjs — жёсткий гейт структуры модулей SPEC §16.
 * Выводит таблицу файлов src/ и строк, проверяет токены ?v=, отсутствие импортов
 * припаркованных модулей, прямые записи в камеру вне src/camera/, подключение index.html
 * и отсутствие var. Завершается с exit 0 только при полном соответствии. */
import { readFileSync } from 'fs';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const INDEX = join(ROOT, 'index.html');
const TOKEN = '?v=1';
const MAX_LINES = 500;

let failures = 0;
function fail(msg) { failures++; console.error('✗ ' + msg); }
function ok(msg) { console.log('✓ ' + msg); }

// --- 1. все .js в src/ (включая подкаталоги) ≤ 500 строк (таблица) ---
console.log('\nТаблица модулей src/ (файл → строки):');
let totalLines = 0;
function walkJs(dir, prefix) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJs(full, prefix + name + '/'));
    else if (name.endsWith('.js')) out.push(prefix + name);
  }
  return out;
}
const srcFiles = walkJs(SRC, '');
for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  const lines = src.split('\n').length;
  totalLines += lines;
  const flag = lines > MAX_LINES ? '  ← ПРЕВЫШЕНО' : '';
  console.log(`  ${f.padEnd(28)} ${String(lines).padStart(4)} строк${flag}`);
  if (lines > MAX_LINES) fail(`${f}: ${lines} строк > ${MAX_LINES}`);
}
console.log(`  Всего файлов: ${srcFiles.length}, строк: ${totalLines}`);

// --- 2. токен ?v= у всех import внутри src/ и совпадение с index.html ---
console.log('\nТокены версий импортов:');
let indexHtml = readFileSync(INDEX, 'utf8');
const indexTokenMatch = indexHtml.match(/type="module"\s+src="([^"]+)"/);
const indexToken = indexTokenMatch ? indexTokenMatch[1].match(/\?v=\d+/) : null;
let expectedToken = indexToken ? indexToken[0] : null;
if (!expectedToken) { fail('index.html: не найден токен ?v= в type="module"'); expectedToken = TOKEN; }
else ok(`index.html токен: ${expectedToken}`);

for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  const imports = src.match(/from\s+['"]([^'"]+)['"]/g) || [];
  for (const imp of imports) {
    const m = imp.match(/from\s+['"]([^'"]+)['"]/);
    const specifier = m[1];
    if (!specifier.startsWith('./')) continue;
    const token = specifier.match(/\?v=\d+/);
    if (!token) { fail(`${f}: импорт без токена ?v=: ${specifier}`); continue; }
    if (token[0] !== expectedToken) fail(`${f}: токен ${token[0]} !== ожидаемый ${expectedToken} (${specifier})`);
  }
}
ok('все импорты внутри src/ имеют токен ?v=, совпадающий с index.html');

// --- 3. ни один модуль не импортирует vector.js / editor.js ---
console.log('\nИмпорты припаркованных модулей:');
let importedParked = false;
for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  if (/(from\s+['"]\.\/(?:vector|editor)\.js\?v=\d+['"])/.test(src)) {
    fail(`${f} импортирует припаркованный модуль`);
    importedParked = true;
  }
}
if (!importedParked) ok('nikем не импортирует vector.js / editor.js');

// --- 4. вне src/camera/ нет прямых записей в камеру ---
console.log('\nПрямые записи в камеру вне src/camera/:');
const cameraPatterns = [/camera\.setView\(/, /camera\.position\s*=/,
  /camera\.flyTo\(/, /camera\.lookAt\(/, /camera\.direction\s*=/];
let foundDirectCamera = false;
for (const f of srcFiles) {
  if (f.startsWith('camera/')) continue;
  const src = readFileSync(join(SRC, f), 'utf8');
  for (const pat of cameraPatterns) {
    if (pat.test(src)) { fail(`${f}: найдено ${pat}`); foundDirectCamera = true; }
  }
}
if (!foundDirectCamera) ok('nikого прямого обращения к viewer.camera / camera.* вне src/camera/');

// --- 5. index.html: ровно один type="module" на src/main.js ---
console.log('\nПодключение index.html:');
const moduleScripts = (indexHtml.match(/<script\s+type="module"[^>]*>/g) || []).length;
if (moduleScripts !== 1) fail(`index.html: type="module" скриптов = ${moduleScripts}, нужно 1`);
else ok('ровно один type="module"');
const mainRef = indexHtml.match(/<script\s+type="module"\s+src="([^"]+)"[^>]*>/);
// номер токена не зашит: важен не номер, а что ОДИН токен на весь граф (иначе правка одного
// файла оставит браузер на старом кэше — ровно тот баг, из-за которого в 26.11 «не обновился» UI)
if (!mainRef || mainRef[1] !== `./src/main.js${expectedToken}`) {
  fail(`index.html: модуль должен быть ./src/main.js${expectedToken}, найдено ${mainRef ? mainRef[1] : 'отсутствует'}`);
} else ok(`модуль = ./src/main.js${expectedToken}`);

// классический Cesium до модулей
if (!indexHtml.includes('<script src="vendor/cesium/Cesium.js"></script>')) {
  fail('index.html: отсутствует классический <script src="vendor/cesium/Cesium.js">');
} else ok('Cesium загружается классическим скриптом до модулей');

// --- 6. нет `var ` в src/*.js ---
console.log('\nОтсутствие var:');
let foundVar = false;
for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  if (/\bvar\s/.test(src)) { fail(`${f}: есть var `); foundVar = true; }
}
if (!foundVar) ok('nikого `var ` в src/*.js');

// --- 7. каждый файл начинается с комментария «что здесь живёт» ---
console.log('\nЗаголовок «что здесь живёт»:');
let missingHeader = false;
for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  const firstLine = src.split('\n')[0];
  if (!firstLine || !firstLine.includes('что здесь живёт')) {
    fail(`${f}: не начинается с комментария «что здесь живёт»`);
    missingHeader = true;
  }
}
if (!missingHeader) ok('все файлы начинаются с комментария «что здесь живёт»');

// --- 8. комментарии на русском (проверяем наличие хотя бы одного русского слова в заголовке) ---
let nonRussianHeader = false;
for (const f of srcFiles) {
  const src = readFileSync(join(SRC, f), 'utf8');
  const firstLine = src.split('\n')[0];
  if (firstLine && !/[А-Яа-я]/.test(firstLine)) {
    fail(`${f}: заголовок не содержит русского текста`);
    nonRussianHeader = true;
  }
}
if (!nonRussianHeader) ok('заголовки на русском');

console.log(`\n${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ОШИБОК(И) НАЙДЕНО'}\n`);
process.exit(failures === 0 ? 0 : 1);
