/* collision_ray_test.mjs — гейт рейкаста по печной сетке коллизии (ADR-33, партия B1).
 * Проверки идут по НАСТОЯЩЕМУ collision.bin/collision.json из репозитория: код луча плана
 * обязан находить те же пересечения, что независимый мелкий марш по той же высоте.
 * Запуск: node mirea-airsoft-map/tests/collision_ray_test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'collision.js'), 'utf8');
const sandbox = { console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { Collision, CollisionGrid } = sandbox;

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r !== true) throw new Error(r === false ? 'assertion' : 'не независимый boolean');
    passed++; console.log('PASS', name);
  } catch (e) { failed++; console.error('FAIL', name, '—', e.message); }
}

const meta = JSON.parse(fs.readFileSync(path.join(root, 'collision', 'collision.json'), 'utf8'));
const bin = fs.readFileSync(path.join(root, 'collision', 'collision.bin'));
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

check('collision.js не обращается к Cesium и вешает Collision на globalThis', () =>
  !/Cesium\./.test(src) && typeof Collision === 'object' && typeof CollisionGrid === 'function');

const grid = Collision.fromParts(meta, ab);
check('размер bin совпадает с nx*ny и метаданные регламентные (cell 0.5, zScale 100)', () =>
  ab.byteLength === meta.nx * meta.ny * 2 && meta.cell === 0.5 && meta.zScale === 100 &&
  grid.nx === meta.nx && grid.ny === meta.ny);

check('сетка заполнена: геометрия есть больше чем на 15 % ячеек (модель с дырами, ADR-13)', () => {
  let ok = 0;
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) if (grid.cellAt(i, j) !== null) ok++;
  return ok > grid.nx * grid.ny * 0.15;
});

check('heightAt в центре ячейки равна значению ячейки (етка решётки)', () => {
  for (let k = 0; k < 40; k++) {
    const i = (k * 7) % grid.nx, j = (k * 11) % grid.ny;
    const v = grid.cellAt(i, j);
    if (v === null) continue;
    const h = grid.heightAt(i * grid.cell, j * grid.cell);
    if (Math.abs(h - v) > 1e-9) throw new Error(`ячейка ${i},${j}: heightAt ${h} ≠ cellAt ${v}`);
  }
  return true;
});

/* точка с геометрией около центра сетки — от неё считаем лучи */
const ci = Math.floor(grid.nx / 2), cj = Math.floor(grid.ny / 2);
let e0 = 0, n0 = 0, u0 = 0, found = false;
for (let r = 0; r < 40 && !found; r++) {
  for (let dj = -r; dj <= r && !found; dj++) for (let di = -r; di <= r && !found; di++) {
    const v = grid.cellAt(ci + di, cj + dj);
    if (v !== null) { e0 = (ci + di) * grid.cell; n0 = (cj + dj) * grid.cell; u0 = v; found = true; }
  }
}
check('около центра сетки есть геометрия (стартовая точка лучей найдена)', () => found);

check('луч вниз из 10 м над поверхностью бьёт ровно в неё (±0.05 м)', () => {
  const h = grid.heightAt(e0, n0);
  const hit = grid.raycast(e0, n0, h + 10, 0, 0, -1, 300);
  return !!hit && Math.abs(hit.dist - 10) < 0.05;
});

check('луч вверх от поверхности не находит ничего', () => {
  const h = grid.heightAt(e0, n0);
  return grid.raycast(e0, n0, h + 1, 0, 0, 1, 300) === null;
});

check('промах за предел: вниз с 400 м при maxDist 300 даёт null', () => {
  const h = grid.heightAt(e0, n0);
  return grid.raycast(e0, n0, h + 400, 0, 0, -1, 300) === null;
});

check('старт внутри геометрии не даёт мгновенного попадания', () => {
  const h = grid.heightAt(e0, n0);
  const hit = grid.raycast(e0, n0, h - 1, 1, 0, 0, 300);
  return hit === null || hit.dist > 0.5;
});

/* Эталонный марш с шагом 0.05 м по 24 детерминированным направлениям. Ищем ПЕРВОЕ ВХОЖДЕНИЕ
 * в тело: луч ниже поверхности и остаётся ниже ещё 0.3 м. Касания-искры тоньше 0.3 м
 * (билинейная высота на решётке 0.5 м даёт субъячеечные гребни шириной в сантиметры)
 * эталоном не считаются — луч обязан попадать в геометрию, а не в численный артефакт. */
check('raycast находит первое ВХОЖДЕНИЕ в тело как марш (≤0.6 м) на 24 направлениях', () => {
  let seed = 20261126;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const below = (u, t, de, dn, du) => {
    const hh = grid.heightAt(e0 + de * t, n0 + dn * t);
    return hh !== null && u + du * t <= hh;
  };
  let compared = 0;
  for (let k = 0; k < 24; k++) {
    const az = rnd() * Math.PI * 2;
    const el = (rnd() - 0.35) * Math.PI / 2;          // вниз круче −35°, вверх до +45°
    const de = Math.cos(el) * Math.cos(az), dn = Math.cos(el) * Math.sin(az), du = Math.sin(el);
    const h = grid.heightAt(e0, n0), u = h + 2;
    const o = grid.raycast(e0, n0, u, de, dn, du, 300, 0.1);
    let brute = null;
    for (let t = 0.05; t <= 300; t += 0.05) {
      if (below(u, t, de, dn, du) && below(u, t + 0.3, de, dn, du)) { brute = t; break; }
    }
    if (brute === null) {
      /* сплошного входа нет: raycast вправе найти только касание — точка, где поверхность
       * достигнута (|u−h| ≤ 0.05 м), а не выдумана в пустоте */
      if (o !== null) {
        const hh = grid.heightAt(e0 + de * o.dist, n0 + dn * o.dist);
        if (hh === null || Math.abs(u + du * o.dist - hh) > 0.05)
          throw new Error(`азимут ${az.toFixed(2)}: raycast нашёл попадание ${o.dist.toFixed(2)} без касания (h=${hh})`);
      }
    } else {
      if (!o) throw new Error(`азимут ${az.toFixed(2)}: вход в тело на ${brute.toFixed(2)}, raycast — null`);
      if (Math.abs(o.dist - brute) > 0.6) throw new Error(`азимут ${az.toFixed(2)}: raycast ${o.dist.toFixed(2)} vs марш ${brute.toFixed(2)}`);
      compared++;
    }
  }
  if (compared < 8) throw new Error('слишком мало вхождений для проверки: ' + compared);
  return true;
});

check('над пустой зоной (за краем сетки) heightAt отдаёт null, луч — тоже', () => {
  // за краем сетки гарантированно пусто
  const e = (grid.nx + 50) * grid.cell, n = (grid.ny + 50) * grid.cell;
  return grid.heightAt(e, n) === null && grid.raycast(e, n, 5, 0, 0, -1, 300) === null;
});

console.log(`\n${passed} ok / ${failed} fail`);
process.exit(failed ? 1 : 0);
