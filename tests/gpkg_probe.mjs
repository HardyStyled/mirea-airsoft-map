// Диагностика: какие слои/фичи в tactical.gpkg без Z и без геометрии.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const here = path.dirname(process.argv[1]);
const root = path.join(here, '..');
const require = createRequire(import.meta.url);
const initSqlJs = require(path.join(root, 'vendor/sqljs/sql-wasm.js'));
const ctx = vm.createContext({ console, Uint8Array, DataView, Math, JSON, Error, Object, Array, String, Number, Set, window: { SQLJS_PATH: path.join(root, 'vendor/sqljs/') + '\\' } });
vm.runInContext(fs.readFileSync(path.join(root, 'gpkg.js'), 'utf8'), ctx);

const buf = fs.readFileSync(path.join(root, '..', 'map/tactical.gpkg'));
const db = await ctx.gpkgOpen(initSqlJs, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const rows = db.db.exec("SELECT table_name, geometry_type_name, z, m FROM gpkg_geometry_columns ORDER BY table_name")[0].values;
console.log('gpkg_geometry_columns:');
for (const [t, gt, z, m] of rows) console.log('  ' + t.padEnd(12) + ' ' + String(gt).padEnd(16) + ' z=' + z + ' m=' + m);
console.log('\nфичи:');
for (const L of db.layers) {
  const feats = db.features(L.table);
  const noGeom = feats.filter(f => !f.geom).map(f => f.fid);
  const noZ = feats.filter(f => f.geom && !f.geom.hasZ).map(f => f.fid);
  const types = [...new Set(feats.map(f => (f.geom ? f.geom.type : 'NULL')))].join('/');
  console.log('  ' + L.table.padEnd(12) + ' ' + String(L.geomType).padEnd(16) + 'z=' + L.z + '  фич=' + feats.length +
    '  типов=' + types + '  без геометрии=' + (noGeom.join(',') || '-') + '  без Z=' + (noZ.join(',') || '-'));
}
