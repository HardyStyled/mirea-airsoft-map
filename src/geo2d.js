/* что здесь живёт: чистая математика плана — сферическая проекция Web Mercator, разрешение зума, расстояние до отрезка. */
/* geo2d.js — перекрёстные вычисления 2D-плана без единой ссылки на DOM и Cesium: их можно
 * проверить в node (tests/plan_geo_test.mjs) и использовать и плану, и радару. Формулы —
 * стандартные для XYZ-тайлов Web Mercator (z15–z23), поэтому сверены с определением тайла. */
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function lonLatToWorldPx(lon, lat, z) {
  const s = 256 * Math.pow(2, z);
  const x = (lon + 180) / 360 * s;
  const rad = lat * D2R;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * s;
  return [x, y];
}

export function resolution(z, lat) {
  return 156543.0339 * Math.cos(lat * D2R) / Math.pow(2, z);
}

export function worldPxToLonLat(x, y, z) {
  const s = 256 * Math.pow(2, z);
  return [x / s * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * R2D];
}

export function hexA(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

export function ptsOf(part) { return Array.isArray(part) ? part : (part && part.pts) || []; }

export function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
