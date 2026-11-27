/* что здесь живёт: выбор растровой подложки (орто / «Схема» QGIS) и её верхний уровень зума. */
/* basemap.js — подложка: какой набор тайлов показывать, с каким максимумом зума, в Cesium и в
 * canvas-плане. Наборы и их проработка — в config.js (BASES/BASE_ZMAX), здесь только переключение.
 * Уровень берём по имени набора, а для отладочного ?tiles= — по URL: неизвестный набор считаем
 * отстающим (z22), иначе просим z23, получаем 404 и дырки в подложке. */
import { App, emit } from './state.js?v=10';
import { BASES, BASE_ZMAX, resolveBase, makeProvider, setTileSource } from './config.js?v=10';
import { $ } from './dom.js?v=10';

let baseChoice = 0;                              // гонка проверок набора: побеждает последний заказ

export function baseState() {
  $('stat').title = 'растр: ' + (App.baseName === 'qgis' ? 'QGIS' : 'орто');
}

export async function setBase(name, listOverride) {
  const choice = ++baseChoice;
  const url = await resolveBase(listOverride || BASES[name]);
  if (choice !== baseChoice) return false;       // пока проверяли файлы, заказали другой набор
  if (!url) { App.toast('карта ' + name + ': файлы не найдены'); return false; }
  const zmax = listOverride
    ? (/\/tiles\/$/.test(url) ? BASE_ZMAX.ortho : BASE_ZMAX.qgis)
    : (BASE_ZMAX[name] ?? BASE_ZMAX.qgis);
  setTileSource(url, zmax);
  if (App.viewer) {
    App.viewer.imageryLayers.removeAll();
    App.viewer.imageryLayers.addImageryProvider(makeProvider());
  }
  if (App.plan) App.plan.clearTiles();
  App.baseName = name;
  baseState();
  App.syncMenus();
  emit('view');                                  // план перерисовывает тайлы, кэш старых сброшен
  if (App.viewer && !App.viewer.scene.globe.show) App.toast('подложка видна в 2D или при выключенных model/Splat');
  return true;
}
