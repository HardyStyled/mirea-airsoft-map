/* что здесь живёт: чистая функция линейки масштаба плана — шаг 1/2/5 × 10ⁿ метров под 100-пиксельный след. */
/* scale.js — чистая функция линейки масштаба плана: шаг мантиссы 1/2/5 × 10ⁿ метров, подогнанный к 100-пиксельному следу. Проверки в tests/mvp_release_test.mjs остаются рабочими. */
export function scaleForMpp(mpp) {
  if (!Number.isFinite(mpp) || mpp <= 0) return { meters: 10, px: 100 };
  let best = { meters: 10, px: Infinity };
  for (let pow = -1; pow <= 7; pow++) {
    for (const m of [1, 2, 5]) {
      const meters = m * Math.pow(10, pow);
      const px = meters / mpp;
      if (Math.abs(px - 100) < Math.abs(best.px - 100)) best = { meters, px };
    }
  }
  return best;
}
export function formatScale(meters) {
  if (meters >= 1000) return (meters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' км';
  if (meters >= 1) return meters.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' м';
  return (meters * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' см';
}
