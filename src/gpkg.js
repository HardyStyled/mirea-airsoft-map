/* что здесь живёт: gpkgOpen — чтение/запись tactical.gpkg через sql.js + кодек GPKG-blob/WKB. */
// gpkg.js — чтение/запись tactical.gpkg в браузере: sql.js + кодек GPKG-blob/WKB.
// Формат снят с реальных файлов 21.11.2026 (verify/wkb_probe.py, T6):
//   заголовок: 'GP', version(1), flags(1: bit0=LE, bits1-3=env), srs_id(i32),
//   envelope по env: {0:0,1:32,2:48,3:48,4:64} байт, опц. GP-расширение (+6), далее ISO WKB.
//   WKB: byteorder(1)+type(u32); Z = +1000 (PointZ=1001, LineStringZ=1002, PolygonZ=1003,
//   CompoundCurve=1009, CurvePolygon=1010). Кольца Polygon/PolygonZ — БЕЗ заголовка (npts+точки).
//   Члены CompoundCurve и кольца CurvePolygon — С заголовком (внутрь пишется 2/1002,
//   как делает GDAL для CircularString/CircularRing).
'use strict';

const GPKG_ENV_BYTES = { 0: 0, 1: 32, 2: 48, 3: 48, 4: 64 };

// → { srid, type, hasZ, parts }
// Point: parts=[[x,y,z]]; LineString: parts=[pts]; Polygon: parts=[ring...];
// CompoundCurve: parts=[{pts}...члены]; CurvePolygon: parts=[{pts}...кольца].
function wkbRead(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] !== 0x47 || u8[1] !== 0x50) throw new Error('not a GPKG geometry (magic)');
  const flags = u8[3];
  const env = (flags >> 1) & 7;
  let off = 8 + (GPKG_ENV_BYTES[env] ?? 0);
  if (u8[off] === 0x47 && u8[off + 1] === 0x50) off += 6; // GP-расширение
  const srid = dv.getInt32(4, !!(flags & 1));
  let le = null;

  function rdPoints(o, n, hasz) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      pts.push([dv.getFloat64(o, le), dv.getFloat64(o + 8, le), hasz ? dv.getFloat64(o + 16, le) : null]);
      o += hasz ? 24 : 16;
    }
    return [pts, o];
  }
  function readGeom(o) {
    le = u8[o] === 1; o += 1;
    const t = dv.getUint32(o, le); o += 4;
    const hasz = t >= 1000 && t < 2000;
    const base = t % 1000;
    if (base === 1) { const [p, n] = rdPoints(o, 1, hasz); return [['Point', p, hasz], n]; }
    if (base === 2) { const n = dv.getUint32(o, le); o += 4; const [p, m] = rdPoints(o, n, hasz); return [['LineString', [p], hasz], m]; }
    if (base === 3) { // Polygon: кольца без заголовка
      const nr = dv.getUint32(o, le); o += 4;
      const rings = [];
      for (let i = 0; i < nr; i++) {
        const n = dv.getUint32(o, le); o += 4;
        const [p, no] = rdPoints(o, n, hasz); rings.push(p); o = no;
      }
      return [['Polygon', rings, hasz], o];
    }
    if (base === 9) { // CompoundCurve: члены с заголовком, структуру сохраняем
      const nc = dv.getUint32(o, le); o += 4;
      const members = [];
      for (let i = 0; i < nc; i++) {
        const [g, no] = readGeom(o); o = no;
        members.push({ pts: g[1][0] });
      }
      return [['CompoundCurve', members, hasz], o];
    }
    if (base === 10) { // CurvePolygon: кольца с заголовком
      const nr = dv.getUint32(o, le); o += 4;
      const rings = [];
      for (let i = 0; i < nr; i++) { const [g, no] = readGeom(o); o = no; rings.push({ pts: g[1][0] }); }
      return [['CurvePolygon', rings, hasz], o];
    }
    if (base === 4 || base === 5 || base === 6) { // Multi* — рекурсивно
      const nn = dv.getUint32(o, le); o += 4;
      const kind = base === 4 ? 'Point' : base === 5 ? 'LineString' : 'Polygon';
      const all = []; let hasz2 = hasz;
      for (let i = 0; i < nn; i++) {
        const [g, no] = readGeom(o); o = no; hasz2 = hasz2 || g[2];
        if (kind === 'Point') all.push(g[1][0]); else all.push(...g[1]);
      }
      return [[kind, all, hasz2], o];
    }
    throw new Error('WKB type not supported: ' + t);
  }
  const [g] = readGeom(off);
  return { srid, type: g[0], hasZ: g[2], parts: g[1] };
}

// { srid, type, hasZ, parts } → Uint8Array GPKG-blob (LE, без envelope — GDAL принимает,
// метаданные/триггеры от env не зависят). Единственный путь сборки — finalize().
function gpkgWriteBlob(geom) {
  const head = new Uint8Array(8);
  head[0] = 0x47; head[1] = 0x50; head[2] = 0; head[3] = 0x01;
  new DataView(head.buffer).setInt32(4, geom.srid ?? 4326, true);
  return finalize(head, geom);
}
function finalize(head, geom) {
  const bytes = [];
  const u32 = (v) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); for (let i = 0; i < 8; i++) bytes.push(b[i]); };
  const pts = (arr) => { for (const p of arr) { f64(p[0]); f64(p[1]); if (geom.hasZ) f64(p[2] ?? 0); } };
  const t = geom.type;
  bytes.push(1); u32(({ Point: 1, LineString: 2, Polygon: 3, CompoundCurve: 9, CurvePolygon: 10 })[t] + (geom.hasZ ? 1000 : 0));
  if (t === 'Point') pts([geom.parts[0]]);
  else if (t === 'LineString') { u32(geom.parts[0].length); pts(geom.parts[0]); }
  else if (t === 'Polygon') { u32(geom.parts.length); for (const r of geom.parts) { u32(r.length); pts(r); } }
  else { u32(geom.parts.length); for (const m of geom.parts) { bytes.push(1); u32(2 + (geom.hasZ ? 1000 : 0)); u32(m.pts.length); pts(m.pts); } }
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0); out.set(bytes, head.length);
  return out;
}

// bbox геометрии: из envelope заголовка, иначе — из WKB.
// Нужен для spatialite-функций, которые зовут rtree-триггеры gpkg (ST_MinX/MinY/MaxX/MaxY/IsEmpty) —
// в sql.js их нет, регистрируем сами (иначе любой UPDATE геометрии падает).
function gpkgBbox(u8) {
  const flags = u8[3];
  const env = (flags >> 1) & 7;
  const le = !!(flags & 1);
  if (env) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return [dv.getFloat64(8, le), dv.getFloat64(24, le), dv.getFloat64(16, le), dv.getFloat64(32, le)];
  }
  const g = wkbRead(u8);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const walk = pts => { for (const p of pts) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; } };
  if (g.type === 'Point') walk(g.parts);
  else if (g.type === 'LineString') walk(g.parts[0]);
  else if (g.type === 'Polygon') g.parts.forEach(walk);
  else g.parts.forEach(m => walk(m.pts));
  return [minx, miny, maxx, maxy];
}

// sql.js собран без модуля rtree и без spatialite. В сессионной копии снимаем
// rtree-таблицы и все триггеры, которые их зовут (rtree_* и gpkg_geometry_*):
// вторые при UPDATE/INSERT вызывают ST_IsEmpty/ST_MinX…, которых в sql.js нет.
// rtree — опциональный индекс GPKG: GDAL/QGIS перестраивает его сам при открытии
// (записи gpkg_extensions чистим, чтобы не врал). Проверку геометрии берём на себя.
function gpkgDropSpatialTriggers(db) {
  const q = sql => { const st = db.exec(sql); return st.length ? st[0].values : []; };
  const drop = like => { for (const [name] of q(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '${like}'`)) db.run(`DROP TRIGGER IF EXISTS "${name}"`); };
  drop('%rtree%');
  drop('gpkg_geometry_%');
  // сами rtree-таблицы не удалить через DROP TABLE (sql.js не знает модуль rtree),
  // поэтому вычищаем их записи из sqlite_master и пересобираем файл VACUUM'ом
  try {
    db.run('PRAGMA writable_schema = ON');
    db.run("DELETE FROM sqlite_master WHERE type='table' AND name LIKE 'rtree_%'");
    db.run('PRAGMA writable_schema = OFF');
    db.run('VACUUM');
  } catch (e) { /* индекс останется мёртвым — правду скажет gpkg_extensions ниже */ }
  db.run("DELETE FROM gpkg_extensions WHERE extension_name = 'gpkg_rtree_index'");
  // счётчики gpkg_ogr_contents в файле из QGIS бывают устаревшие (land_cover: 1 при 6 строках) —
  // чистим, чтобы экспорт не врал тем же GDAL/QGIS
  for (const [t] of q('SELECT table_name FROM gpkg_geometry_columns'))
    db.run(`UPDATE gpkg_ogr_contents SET feature_count = (SELECT count(*) FROM "${t}") WHERE table_name = ?`, [t]);
}

// Загрузка БД из ArrayBuffer через sql.js (initSqlJs уже загружен на странице).
export async function gpkgOpen(initSqlJs, buffer) {
  const SQL = await initSqlJs({ locateFile: f => (window.SQLJS_PATH || './vendor/sqljs/') + f });
  const db = new SQL.Database(new Uint8Array(buffer));
  gpkgDropSpatialTriggers(db);
  const bb = v => (v == null ? null : gpkgBbox(v instanceof Uint8Array ? v : new Uint8Array(v)));
  db.create_function('ST_MinX', v => { const b = bb(v); return b ? b[0] : null; });
  db.create_function('ST_MinY', v => { const b = bb(v); return b ? b[1] : null; });
  db.create_function('ST_MaxX', v => { const b = bb(v); return b ? b[2] : null; });
  db.create_function('ST_MaxY', v => { const b = bb(v); return b ? b[3] : null; });
  db.create_function('ST_IsEmpty', v => (v == null || v.length === 0 ? 1 : 0));
  const layers = [];
  const q = (sql) => { const st = db.exec(sql); return st.length ? st[0].values : []; };
  const contents = q("SELECT table_name, identifier, description FROM gpkg_contents WHERE data_type='features' ORDER BY table_name");
  const gc = {};
  for (const [tn, col, gt, srid, z, m] of q('SELECT table_name, column_name, geometry_type_name, srs_id, z, m FROM gpkg_geometry_columns'))
    gc[tn] = { col, geomType: gt, srid, z: !!z, m: !!m };
  for (const [tn, ident, desc] of contents) {
    if (!gc[tn]) continue;
    const n = q(`SELECT count(*) FROM "${tn}" WHERE "${gc[tn].col}" IS NOT NULL`)[0][0];  // объекты с геометрией: пустые строки QGIS не показываем
    const rows = q(`SELECT count(*) FROM "${tn}"`)[0][0];
    const attrs = q(`SELECT name FROM pragma_table_info('${tn}')`).map(r => r[0]).filter(x => x !== gc[tn].col && x !== 'rowid');
    layers.push({ table: tn, name: ident || tn, desc: desc || '', ...gc[tn], count: n, rows, attrs });
  }
  return {
    db, layers,
    features(table) {
      const L = layers.find(l => l.table === table);
      const sel = L.attrs.map(a => `"${a}"`).join(',');
      const st = db.exec(`SELECT fid${sel ? ',' + sel : ''},"${L.col}" FROM "${table}"`);
      if (!st.length) return [];
      return st[0].values.map(row => {
        const attrs = {}; L.attrs.forEach((a, i) => attrs[a] = row[i + 1]);
        const blob = row[L.attrs.length + 1];
        const geom = blob ? wkbRead(blob instanceof Uint8Array ? blob : new Uint8Array(blob)) : null;
        return { fid: row[0], attrs, geom };
      });
    },
    // записать геометрию фиче (T9 пишет сюда из сессии «Правка»)
    setGeom(table, fid, geom) {
      const L = layers.find(l => l.table === table);
      db.run(`UPDATE "${table}" SET "${L.col}" = ? WHERE fid = ?`, [gpkgWriteBlob(geom), fid]);
    },
    // поднять Z у слоя в метаданных (z=1) — нужно до записи PolygonZ-блобов
    promoteZ(table) {
      db.run(`UPDATE gpkg_geometry_columns SET z = 1 WHERE table_name = ?`, [table]);
    },
    // записать атрибут (переименование объекта; имя колонки берётся как в таблице)
    setAttr(table, fid, attr, value) {
      db.run(`UPDATE "${table}" SET "${attr}" = ? WHERE fid = ?`, [value, fid]);
    },
    // новый слой: таблица + записи gpkg_contents/geometry_columns/ogr_contents
    newLayer(name, geomType, attrs = ['name']) {
      if (layers.find(l => l.table === name)) throw new Error('слой уже есть: ' + name);
      const cols = attrs.map(a => `"${a}" TEXT`).join(', ');
      db.run(`CREATE TABLE "${name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT${cols ? ', ' + cols : ''}, geometry GEOMETRY)`);
      db.run(`INSERT INTO gpkg_contents (table_name, data_type, identifier, description, last_change, min_x, max_x, min_y, max_y, srs_id)
              VALUES (?, 'features', ?, '', strftime('%Y-%m-%dT%H:%M:%SZ','now'), -180, 180, -90, 90, 4326)`, [name, name]);
      db.run(`INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m)
              VALUES (?, 'geometry', ?, 4326, 1, 0)`, [name, geomType]);
      db.run(`INSERT OR REPLACE INTO gpkg_ogr_contents (table_name, feature_count) VALUES (?, 0)`, [name]);
      layers.push({ table: name, name, desc: '', col: 'geometry', geomType, srid: 4326, z: true, m: false, count: 0, attrs });
    },
    // вставить фичу (для «новый объект» и переноса между слоями)
    addFeature(table, attrs, geom) {
      const L = layers.find(l => l.table === table);
      const keys = Object.keys(attrs).filter(k => k !== 'fid' && k !== L.col && L.attrs.includes(k));
      const cols = (keys.length ? keys.map(k => `"${k}"`).join(',') + ',' : '') + `"${L.col}"`;
      const marks = (keys.length ? keys.map(() => '?').join(',') + ',' : '') + '?';
      db.run(`INSERT INTO "${table}" (${cols}) VALUES (${marks})`, [...keys.map(k => attrs[k]), gpkgWriteBlob(geom)]);
      db.run(`UPDATE gpkg_ogr_contents SET feature_count = (SELECT count(*) FROM "${table}") WHERE table_name = ?`, [table]);
      L.count++;
      const rid = db.exec('SELECT last_insert_rowid()');       // fid новой фичи (editor.js вставляет и выбирает)
      return rid.length ? rid[0].values[0][0] : null;
    },
    deleteFeature(table, fid) {
      db.run(`DELETE FROM "${table}" WHERE fid = ?`, [fid]);
      const L = layers.find(l => l.table === table);
      db.run(`UPDATE gpkg_ogr_contents SET feature_count = (SELECT count(*) FROM "${table}") WHERE table_name = ?`, [table]);
      if (L) L.count--;
    },
    exportBytes: () => db.export(),
  };
}
