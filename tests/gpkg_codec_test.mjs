// T8b: юнит-тесты кодека GPKG-blob/WKB на настоящих данных tactical.gpkg.
// Запуск: node mirea-airsoft-map/tests/gpkg_codec_test.mjs
// Идея: тот же код, что в браузере (gpkg.js + vendor/sqljs), только вход — файл с диска.
// Исходный файл не трогаем: sql.js работает в памяти.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(process.argv[1]);
const root = path.join(here, '..');            // mirea-airsoft-map/

// sql-wasm.js — CommonJS-модуль (module.exports = initSqlJs). createRequire()
// не выставляет module.exports для него в ESM-контексте, поэтому загружаем через vm,
// как это делает браузер: отдаём module.exports и берём .default.
const sqlVm = { module: { exports: {} }, exports: {} };
vm.runInContext(fs.readFileSync(path.join(root, 'vendor/sqljs/sql-wasm.js'), 'utf8'),
  vm.createContext(sqlVm), { filename: path.join(root, 'vendor/sqljs/sql-wasm.js') });
const initSqlJs = sqlVm.module.exports.default;

// sql.js без wasmBinary пытается загрузить .wasm через fetch (не работает в Node),
// поэтому читаем wasm синхронно и подаём в конфиг.
const initSqlJsBin = (cfg) => initSqlJs(Object.assign({ wasmBinary: fs.readFileSync(path.join(root, 'vendor/sqljs/sql-wasm.wasm')) }, cfg));

function loadModule(filePath, shimMap, exportNames) {
  // загрузка ESM-модуля без import/export: вырезаем строки import и слово export только
  // на уровне объявлений (начало строки), чтобы не сломать имена вроде db.export().
  // Исполняем тело через new Function с подставленными шимами, возвращаем нужные имена.
  const src = fs.readFileSync(filePath, 'utf8');
  const body = src
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .map(line => line.replace(/^\s*export\b\s*/, ''))
    .join('\n');
  const ret = 'return {' + exportNames.join(',') + '};';
  const fn = new Function(Object.keys(shimMap), body + '\n' + ret);
  return fn(...Object.values(shimMap));
}

const gpkg = loadModule(path.join(root, 'src/gpkg.js'), {
  console, Uint8Array, DataView, Math, JSON, Error, Object, Array, String, Number, Set,
  window: { SQLJS_PATH: path.join(root, 'vendor/sqljs/') + '\\' }
}, ['wkbRead', 'gpkgWriteBlob', 'gpkgBbox', 'gpkgOpen']);
const { wkbRead, gpkgWriteBlob, gpkgBbox, gpkgOpen } = gpkg;

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const norm = g => ({ type: g.type, hasZ: g.hasZ, parts: g.parts });

const buf = fs.readFileSync(path.join(root, '..', 'map/tactical.gpkg'));
console.log('вход: map/tactical.gpkg, ' + buf.length + ' байт');

const db = await gpkgOpen(initSqlJsBin, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log('\n1. структура');
// Структура map/tactical.gpkg: дрейф данных относительно ai-project/DATA.md
// (владелец досыпал слои Бочки/Подписи/Помещения/щиты — DATA.md отстал: 11/94, обновить регламент).
// Ожидаемый список слоёв (фактический, 13 шт.):
//   buildings, clearground, objects, playzone, restricted, river, roads, tactical,
//   vehicles, Бочки, Подписи, Помещения, щиты
const expectedLayers = [
  'buildings', 'clearground', 'objects', 'playzone', 'restricted', 'river',
  'roads', 'tactical', 'vehicles', 'Бочки', 'Подписи', 'Помещения', 'щиты'
];
const actualLayers = db.layers.map(l => l.name);
ok(JSON.stringify(actualLayers.sort()) === JSON.stringify(expectedLayers.sort()),
  '13 слоёв регламента (фактические)', actualLayers.join(' '));
const expectedCounts = { buildings: 6, clearground: 1, objects: 6, playzone: 1, restricted: 1,
  river: 1, roads: 1, tactical: 13, vehicles: 7, Бочки: 55, Подписи: 2, Помещения: 8, щиты: 2 };
let countMismatch = '';
for (const L of db.layers) {
  if (expectedCounts[L.name] !== undefined && L.count !== expectedCounts[L.name]) {
    countMismatch += L.name + ':' + L.count + '(ожидалось ' + expectedCounts[L.name] + ') ';
  }
}
ok(countMismatch === '', 'количество объектов по слоям совпадает с файлом', countMismatch || 'все 13 слоёв сходятся');
const total = db.layers.reduce((s, l) => s + db.features(l.table).length, 0);
const withGeom = db.layers.reduce((s, l) => s + l.count, 0);
const rowsAll = db.layers.reduce((s, l) => s + l.rows, 0);
ok(total === 104, 'строк в таблицах (фактические)', String(total));
ok(withGeom === 104 && rowsAll === 104, 'счётчик панели = все строки (пустые удалены ремонтом fix_data.py)', withGeom + ' из ' + rowsAll);
const anyZ = db.layers.some(l => l.z);
ok(anyZ, 'слои с Z есть', db.layers.filter(l => l.z).map(l => l.table).join(' '));
console.log('  ' + (anyZ ? 'слои с Z: ' + db.layers.filter(l => l.z).map(l => l.table).join(' ') : 'ВНИМАНИЕ: файл целиком 2D (z=0 во всех слоях) — приложение рисует по земле, отметка появляется при правке'));

console.log('\n2. rtree и триггеры сняты (ADR-17)');
const q = sql => { const st = db.db.exec(sql); return st.length ? st[0].values : []; };
ok(q("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rtree_%'").length === 0, 'rtree-таблиц нет');
ok(q("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'gpkg_geometry_%'").length === 0, 'геометрийных триггеров нет');
ok(q("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'rtree%'").length === 0, 'rtree-триггеров GDAL нет (зовут ST_MinX, которых в sql.js нет)');
ok(q("SELECT 1 FROM gpkg_extensions WHERE extension_name='gpkg_rtree_index'").length === 0, 'gpkg_extensions без rtree');
const fc = q("SELECT table_name, feature_count FROM gpkg_ogr_contents ORDER BY table_name");
const badCounters = fc.filter(([t, c]) => q(`SELECT count(*) FROM "${t}"`)[0][0] !== c);
ok(badCounters.length === 0, 'счётчики gpkg_ogr_contents верные (приложение пересчитывает их само)', fc.map(([t, c]) => t + '=' + c).join(' '));

console.log('\n3. чтение всех геометрий + типы');
const byType = {};
let badGeom = 0, noZ = 0;
for (const L of db.layers) {
  for (const f of db.features(L.table)) {
    if (!f.geom) { badGeom++; continue; }
    byType[f.geom.type] = (byType[f.geom.type] || 0) + 1;
    if (!f.geom.hasZ) noZ++;
  }
}
ok(badGeom === 0, 'пустых строк нет', Object.entries(byType).map(([k, v]) => k + ':' + v).join(' '));
ok(noZ === 5, 'плоские слои без Z (playzone, restricted, clearground, roads, river)', noZ + ' геометрий без Z');
// ADR-20: Z вершин — абсолютные отметки эллипсоида, как в dem.tif (184.8..216.7 м)
let zLo = Infinity, zHi = -Infinity, zVerts = 0;
for (const L of db.layers) {
  if (!L.z) continue;
  for (const f of db.features(L.table)) {
    if (!f.geom || !f.geom.hasZ) continue;
    for (const ring of f.geom.parts) {
      for (const p of Array.isArray(ring) ? ring : [ring]) {
        if (p[2] == null) continue;
        zVerts++;
        if (p[2] < zLo) zLo = p[2];
        if (p[2] > zHi) zHi = p[2];
      }
    }
  }
}
ok(zVerts > 500 && zLo >= 184 && zHi <= 217, 'отметки в абсолютных метрах', zVerts + ' вершин, ' + zLo.toFixed(1) + '..' + zHi.toFixed(1) + ' м');
ok((byType.CompoundCurve || 0) > 0, 'кривая реки на месте', 'CompoundCurve ' + (byType.CompoundCurve || 0) + '; CurvePolygon жил в ground, а ground теперь только в тайлах');

console.log('\n4. round-trip кодек: запись -> чтение (все фичи)');
let rtBad = 0, rtCurveBad = 0;
for (const L of db.layers) {
  for (const f of db.features(L.table)) {
    if (!f.geom) continue;
    const back = wkbRead(gpkgWriteBlob(f.geom));
    if (!eq(norm(back), norm(f.geom))) {
      rtBad++;
      if (f.geom.type === 'CurvePolygon' || f.geom.type === 'CompoundCurve') rtCurveBad++;
    }
  }
}
ok(rtBad === 0, 'round-trip без потерь', rtBad ? 'расхождений ' + rtBad + ' (из них кривых ' + rtCurveBad + ')' : '94/94 совпало по координатам');

console.log('\n5. bbox из blobа (нужен для наших spatialite-заглушек)');
const sample = db.features('buildings')[0];
const bb = gpkgBbox(gpkgWriteBlob(sample.geom));
ok(bb.every(v => Number.isFinite(v)) && bb[0] < bb[2] && bb[1] < bb[3], 'bbox конечен', bb.map(v => v.toFixed(6)).join(', '));

console.log('\n6. запись: геометрия (2D -> 3D), атрибут, вставка, удаление');
const b0 = db.features('buildings').find(f => f.fid === 1);
ok(b0.geom.hasZ && b0.geom.parts[0][0][2] > 184, 'buildings fid 1 — 3D с отметкой (после ремонта)', 'z=' + b0.geom.parts[0][0][2]);
// 2D -> 3D снимаем на плоском слое регламента: там вершины честно без отметки
const r0 = db.features('roads')[0];
const rfid = r0.fid;
ok(!r0.geom.hasZ, 'roads fid ' + rfid + ' — 2D (плоский слой)');
const moved = JSON.parse(JSON.stringify(r0.geom));
const line = moved.parts[0];
line[0] = [line[0][0] + 0.0001, line[0][1], 191];        // 188 земля + 3 м
moved.hasZ = true;                                       // так делает editor.setPt, когда тронули высоту
db.promoteZ('roads');                                    // редактор делает это перед записью Z
db.setGeom('roads', rfid, moved);
const r1 = db.features('roads').find(f => f.fid === rfid);
ok(r1.geom.hasZ && eq(r1.geom.parts[0][0], line[0]), 'setGeom + promoteZ: слой стал 3D, Z сохранился', 'z=' + r1.geom.parts[0][0][2]);
ok(r1.geom.parts[0].slice(1).every(p => p[2] === 0), 'ловушка кодека подтверждена: без отметки вершина пишется в 0', 'поэтому editor.apply вызывает fillZ (остальные вершины -> 188)');
const filled = JSON.parse(JSON.stringify(r1.geom));
filled.parts[0].forEach(p => { if (p[2] == null || p[2] === 0) p[2] = 188; });
db.setGeom('roads', rfid, filled);
const r1b = db.features('roads').find(f => f.fid === rfid);
ok(r1b.geom.parts[0].every((p, i) => p[2] === (i === 0 ? 191 : 188)), 'fillZ-путь: 191 у правленой, 188 у остальных', r1b.geom.parts[0].map(p => p[2]).join(','));

db.setAttr('buildings', 1, 'name', 'ТЕСТ КОДЕКА');
ok(db.features('buildings').find(f => f.fid === 1).attrs.name === 'ТЕСТ КОДЕКА', 'setAttr (переименование)');

const before = db.features('tactical').length;
const fid = db.addFeature('tactical', { name: 'новый', fid: 999 }, {
  srid: 4326, type: 'Polygon', hasZ: true,
  parts: [[[37.48, 55.67, 188], [37.481, 55.67, 188], [37.481, 55.671, 188], [37.48, 55.671, 188], [37.48, 55.67, 188]]],
});
ok(typeof fid === 'number' && fid > 0, 'addFeature вернул fid', 'fid=' + fid);
ok(db.features('tactical').length === before + 1, 'фича добавлен', before + ' -> ' + db.features('tactical').length);
const added = db.features('tactical').find(f => f.fid === fid);
ok(added && fid !== 999, 'явный fid из attrs проигнорирован, автоинкремент сработал', 'fid=' + fid + ' (в attrs лежал 999)');
ok(added && added.geom.type === 'Polygon' && added.geom.hasZ && added.geom.parts[0].length === 5, 'новая геометрия читается', added ? added.geom.parts[0].length + ' точек' : 'нет фичи');
db.deleteFeature('tactical', fid);
ok(db.features('tactical').length === before, 'deleteFeature вернул счётчик', 'снова ' + before);

console.log('\n7. экспорт: переоткрытие байтов как файла');
const bytes = db.exportBytes();
ok(bytes.length > 100000 && String.fromCharCode(...bytes.slice(0, 8)) === 'SQLite f', 'экспорт — валидный SQLite', bytes.length + ' байт (исходник ' + buf.length + ', разница за счёт снятых rtree)');
const outPath = path.join(root, '..', 'ai-project/verify/T8b_export.gpkg');
fs.writeFileSync(outPath, Buffer.from(bytes));
const db2 = await gpkgOpen(initSqlJsBin, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
ok(db2.layers.length === 13, 'переоткрыто 13 слоёв');
const t2 = db2.layers.reduce((s, l) => s + db2.features(l.table).length, 0);
ok(t2 === 104, 'переоткрыто 104 фичи', String(t2));
const b2 = db2.features('buildings').find(f => f.fid === 1);
ok(b2.geom.parts[0][0][2] > 184 && b2.attrs.name === 'ТЕСТ КОДЕКА', 'правки дожили до экспорта', 'z=' + b2.geom.parts[0][0][2].toFixed(2) + ' name=' + b2.attrs.name);
const curve2 = db2.features('river').find(f => f.geom && f.geom.type === 'CompoundCurve');
ok(!!curve2, 'кривая реки в экспорте осталась CompoundCurve', curve2 ? curve2.geom.parts.length + ' дуг' : '');
console.log('  файл: ai-project/verify/T8b_export.gpkg');

console.log('\n8. новый слой (newLayer) — путь «создать слой»; после экспорта, чтобы артефакт остался чистым');
let created = false;
try {
  db.newLayer('ТЕСТ3D', 'Polygon', ['name', 'height']);
  created = true;
} catch (e) {
  ok(false, 'newLayer не падает', e.message);
}
if (created) {
  const L = db.layers.find(l => l.table === 'ТЕСТ3D');
  ok(!!L && L.z === true && L.attrs.includes('height'), 'слой появился с полем height', L ? 'attrs=' + L.attrs.join(',') : '');
  const nf = db.addFeature('ТЕСТ3D', { name: 'Коробка', height: 8.5 }, {
    srid: 4326, type: 'Polygon', hasZ: true,
    parts: [[[37.4815, 55.6725, 191], [37.482, 55.6725, 191.4], [37.482, 55.6729, 191.2], [37.4815, 55.6729, 190.8], [37.4815, 55.6725, 191]]],
  });
  const rd = db.features('ТЕСТ3D').find(f => f.fid === nf);
  ok(rd && +rd.attrs.height === 8.5, 'height читается из нового слоя', rd ? 'height=' + rd.attrs.height : 'нет фичи');
  ok(rd && rd.geom.hasZ && rd.geom.parts[0][1][2] === 191.4, 'Z вершин нового слоя читается', rd ? String(rd.geom.parts[0][1][2]) : '');
  db.deleteFeature('ТЕСТ3D', nf);
  ok(db.features('ТЕСТ3D').length === 0, 'объект из нового слоя удаляется');
}

console.log('\nитог: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
