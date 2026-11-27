import { readFileSync } from 'fs';

const htmlFile = 'index.html';
let failed = false;
const warnings = [];
const linesReport = [];

// ---------- 1. Собираем подключённые css из index.html (только со ?v=) ----------
const html = readFileSync(htmlFile, 'utf8');
const cssLinks = html.match(/<link[^>]+href="([^"]+\.css\?v=\d+)"[^>]*>/gi) || [];
const linkedCssHrefs = [];
for (const link of cssLinks) {
  const m = link.match(/href="([^"]+\.css\?v=\d+)"/i);
  if (m) linkedCssHrefs.push(m[1]);
}

// должно быть ровно пять подключённых CSS-файла
if (linkedCssHrefs.length !== 5) {
  failed = true;
  console.error(`ОШИБКА: в index.html ровно 5 <link> на styles/*.css со ?v= ожидается, найдено ${linkedCssHrefs.length}: ${linkedCssHrefs.join(', ')}`);
} else {
  console.log(`подключённых CSS-файлов: ${linkedCssHrefs.length} — ${linkedCssHrefs.map(h => h.split('?')[0]).join(', ')}`);
}

// ---------- 2. Читаем index.html: viewport-fit=cover, ui.css ----------
const viewportMatch = html.match(/<meta[^>]+name="viewport"[^>]+>/i);
if (!viewportMatch || !viewportMatch[0].includes('viewport-fit=cover')) {
  failed = true;
  console.error('ОШИБКА: в index.html нет viewport-fit=cover в мета-теге viewport');
}

const uiCssLinks = (html.match(/<link[^>]+href="[^"]*ui\.css[^"]*"[^>]*>/gi) || []);
if (uiCssLinks.length) {
  failed = true;
  console.error(`ОШИБКА: ui.css удалён (стили живут в styles/*.css), а ссылка осталась: ${uiCssLinks.length}`);
}

// ---------- 3. Проверяем каждый из 5 подключённых css ----------
let mediaFound900 = false, mediaFound620 = false, safeAreaFound = false, dvhFound = false;
const parkedSelectors = ['#layers', '#laytab', '#exp', '#rail', '.tool', '#insp'];

for (const href of linkedCssHrefs) {
  const filePath = href.split('?')[0];  // отрезаем ?v= для чтения с диска
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`ОШИБКА: не удалось прочитать ${filePath}: ${e.message}`);
    failed = true;
    continue;
  }

  const lines = content.split('\n').length;
  linesReport.push(`  ${href}: ${lines} строк`);
  if (lines > 500) {
    failed = true;
    console.error(`ОШИБКА: ${href} — ${lines} строк (лимит 500)`);
  }

  // нет //-комментариев в проектных css
  const linesWithSlashSlash = content.split('\n').filter((line, i) => {
    const trimmed = line.trim();
    return trimmed.startsWith('//');
  });
  if (linesWithSlashSlash.length > 0) {
    failed = true;
    console.error(`ОШИБКА: ${href} содержит //-комментарии (строки: ${linesWithSlashSlash.map(l => l.trim().slice(0, 60)).join('; ')})`);
  }

  // убираем комментарии /* ... */ перед парсингом селекторов
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');

  // 3a. паркованные селекторы не должны быть в подключаемых css
  for (const sel of parkedSelectors) {
    const name = sel.startsWith('.') ? sel.slice(1) : sel.slice(1);
    const re = new RegExp(`(^|[\\s,{>+~])${sel.replace(/([.#])/g, '\\$1')}([\\s,{>+~:]|$)`, 'm');
    if (re.test(stripped)) {
      failed = true;
      console.error(`ОШИБКА: ${href} содержит паркованный селектор ${sel}`);
    }
  }

  // 3b. извлекаем id-селекторы #xxx
  const idSelectors = new Set();
  const idRe = /#([A-Za-z_][\w-]*)/g;
  let m;
  while ((m = idRe.exec(stripped)) !== null) {
    idSelectors.add(m[1]);
  }

  // 3c. проверяем наличие id в index.html
  for (const id of idSelectors) {
    const hasId = new RegExp(`id="${id}"`).test(html);
    if (!hasId) {
      warnings.push(`  ${href}: #${id} — нет id="${id}" в index.html`);
    }
  }

  // 3d. медиа-запросы 900px и 620px — проверяются по совокупности всех 5 файлов
  const hasMedia900 = /@media[^}]*\b900px\b/.test(content);
  const hasMedia620 = /@media[^}]*\b620px\b/.test(content);
  if (hasMedia900) mediaFound900 = true;
  if (hasMedia620) mediaFound620 = true;

  // 3e. safe-area — проверяется по совокупности
  if (/safe-area-inset/.test(content) || /--safe-/.test(content)) safeAreaFound = true;

  // 3f. 100dvh — проверяется по совокупности
  if (/100dvh/.test(content)) dvhFound = true;
}

// ---------- 4. Совокупные проверки по всем 5 файлам ----------
if (!mediaFound900) { failed = true; console.error('ОШИБКА: среди подключённых CSS нет медиа-запроса 900px'); }
if (!mediaFound620) { failed = true; console.error('ОШИБКА: среди подключённых CSS нет медиа-запроса 620px'); }
if (!safeAreaFound) { failed = true; console.error('ОШИБКА: среди подключённых CSS нет safe-area'); }
if (!dvhFound) { failed = true; console.error('ОШИБКА: среди подключённых CSS нет 100dvh'); }

// ---------- Вывод ----------
console.log('=== Количество строк в подключённых styles/*.css ===');
for (const r of linesReport) console.log(r);
console.log('');

if (warnings.length > 0) {
  console.log('=== Подозрительные id-селекторы (есть в CSS, нет в index.html) ===');
  for (const w of warnings) console.log(w);
  console.log('');
}

if (failed) {
  console.error('ИТОГ: ПРОВЕРКА НЕ ПРОЙДЕНА (есть ошибки)');
  process.exit(1);
} else {
  console.log('ИТОГ: ПРОВЕРКА ПРОЙДЕНА (exit 0)');
  process.exit(0);
}
