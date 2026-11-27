/* что здесь живёт: CollisionGrid и Collision — печная heightfield-коллизия для луча плана (ADR-13/33). */
/* collision.js — печная heightfield-коллизия участка (ADR-13, для луча плана — ADR-33).
 * Формат (ai-project/verify/bake_collision.py):
 *   collision.json — {originLon, originLat, cell, nx, ny, zScale, nodata};
 *   collision.bin  — Int16 little-endian, row-major (k = j*nx + i), z в сантиметрах
 *                    (z/zScale = метры над эллипсоидом в КАДРЕ ПРИЛОЖЕНИЯ, ADR-2:
 *                    «реальная высота − 188»). Центр ячейки (0,0) — в (originLon, originLat),
 *                    шаг `cell` метров по локальному ENU (восток/север).
 * Модуль не зависит от Cesium: координаты ENU (метры) передаёт вызывающий.
 * Экспорт: класс CollisionGrid и объект Collision (was on window). */
'use strict';

const NODATA_LIMIT = -30000;              // ниже этой отметки ячейка считается пустой

export class CollisionGrid {
  constructor(meta, i16) {
    this.meta = meta;
    this.cell = meta.cell;
    this.nx = meta.nx;
    this.ny = meta.ny;
    this.zScale = meta.zScale || 100;
    this.g = i16;
    if (this.g.length !== this.nx * this.ny) throw new Error('collision.bin: размер ' + this.g.length + ' не равен nx*ny = ' + (this.nx * this.ny));
  }

  /* значение ячейки (i,j) в метрах; вне сетки и nodata — null */
  cellAt(i, j) {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    const z = this.g[j * this.nx + i];
    return z <= NODATA_LIMIT ? null : z / this.zScale;
  }

  /* высота поверхности в точке ENU (e,n): билинейная по центрам ячеек; пустые соседи
   * в интерполяцию не входят (веса перенормированы по валидным), вся окрестность пуста — null. */
  heightAt(e, n) {
    const gx = e / this.cell, gy = n / this.cell;
    return this.#bilinear(Math.floor(gx), Math.floor(gy), gx, gy);
  }

  #bilinear(i0, j0, gx, gy) {
    const fx = gx - i0, fy = gy - j0;
    const a = this.cellAt(i0, j0), b = this.cellAt(i0 + 1, j0);
    const c = this.cellAt(i0, j0 + 1), d = this.cellAt(i0 + 1, j0 + 1);
    let s = 0, w = 0;
    if (a !== null) { s += a * (1 - fx) * (1 - fy); w += (1 - fx) * (1 - fy); }
    if (b !== null) { s += b * fx * (1 - fy); w += fx * (1 - fy); }
    if (c !== null) { s += c * (1 - fx) * fy; w += (1 - fx) * fy; }
    if (d !== null) { s += d * fx * fy; w += fx * fy; }
    return w > 0 ? s / w : null;
  }

  /* Луч из (e0,n0,u0) по направлению (de,dn,du) (нормализовать не обязательно).
   * Шаг `step` метров до maxDist; первое пересечение с поверхностью уточняется бисекцией.
   * Возвращает {dist, e, n, u} или null (за maxDist геометрии нет).
   * Если старт внутри геометрии (u0 ниже поверхности), луч идёт до выхода наружу,
   * дальше ищет пересечение как обычно — камера «в стене» не даёт мгновенное попадание. */
  raycast(e0, n0, u0, de, dn, du, maxDist = 300, step = 0.1) {
    const len = Math.hypot(de, dn, du);
    if (!(len > 0) || !(maxDist > 0)) return null;
    de /= len; dn /= len; du /= len;
    const h0 = this.heightAt(e0, n0);
    let prev = h0 === null ? Infinity : u0 - h0;
    const at = t => {
      const h = this.heightAt(e0 + de * t, n0 + dn * t);
      return h === null ? Infinity : (u0 + du * t) - h;
    };
    for (let t = step; t <= maxDist; t += step) {
      const cur = at(t);
      if (prev > 0 && cur <= 0) {               // пересечение на шаге (t-step, t]
        let lo = t - step, hi = t;
        for (let k = 0; k < 24 && hi - lo > 1e-4; k++) {
          const mid = (lo + hi) / 2;
          if (at(mid) > 0) lo = mid; else hi = mid;
        }
        const tHit = (lo + hi) / 2;
        return { dist: tHit, e: e0 + de * tHit, n: n0 + dn * tHit, u: u0 + du * tHit };
      }
      prev = cur;
    }
    return null;
  }
}

export const Collision = {
  grid: null,
  error: null,

  /* синхронная сборка из разобранных кусков (тесты читают файлы через fs) */
  fromParts(meta, arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    Collision.grid = new CollisionGrid(meta, i16);
    Collision.error = null;
    return Collision.grid;
  },

  /* загрузка в браузере: два соседних файла, не критична для старта приложения */
  async load(jsonUrl, binUrl, timeoutMs = 8000) {
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + ms + ' мс')), ms)),
    ]);
    try {
      const meta = await withTimeout(fetch(jsonUrl).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }), timeoutMs);
      const bin = await withTimeout(fetch(binUrl).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }), timeoutMs);
      return Collision.fromParts(meta, bin);
    } catch (e) {
      Collision.error = e;
      Collision.grid = null;
      return null;
    }
  },
};
