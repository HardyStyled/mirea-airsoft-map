/* что здесь живёт: загрузка 3D-ресурсов (model/Splat), индикатор чанков, подгон высоты подложки. */
/* assets.js — загрузка 3D-ресурсов (model/Splat) взаимоисключающая, индикатор чанков,
 * подгон высоты подложки под геометрию. Единственное место, где меняется viewer.tileset /
 * viewer.splats. */
import { App } from './state.js?v=14';
import { TILESET, SPLAT_CANDIDATES, ASSET_CFG, QUALITY_PRESETS, flattenTileset, GROUND_H, BASE_DROP, setBaseDrop, Q } from './config.js?v=14';
import { $ } from './dom.js?v=14';

export const assetUrlCache = { tileset: undefined, splats: undefined };
export const assetPromises = { tileset: null, splats: null };
export const chunkState = {
  tileset: { initial: false, pending: 0, lastProgress: 0 },
  splats: { initial: false, pending: 0, lastProgress: 0 },
};
let chunkUiLast = 0;

export function chunkWord(n) {
  const lastTwo = n % 100, last = n % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return 'чанков';
  if (last === 1) return 'чанк';
  if (last >= 2 && last <= 4) return 'чанка';
  return 'чанков';
}

function updateChunkUI(force = false) {
  const now = performance.now();
  if (!force && now - chunkUiLast < 1000) return;
  chunkUiLast = now;
  const active = Object.entries(chunkState).filter(([, state]) => state.initial || state.pending > 0);
  if (!active.length) {
    $('chunkStatus').hidden = true;
    $('chunkText').textContent = '';
    App.hidePerfNotice('network');
    return;
  }
  const pending = active.reduce((sum, [, state]) => sum + state.pending, 0);
  const names = [...new Set(active.map(([slot]) => ASSET_CFG[slot].loadingLabel))];
  const label = names.length === 1 ? names[0] : '3D';
  $('chunkText').textContent = pending > 0
    ? 'Загрузка ' + label + ' · ' + pending + ' ' + chunkWord(pending)
    : 'Подготовка ' + label + '…';
  $('chunkStatus').hidden = false;
}

export function setAssetLoading(slot, loading) {
  const state = chunkState[slot];
  state.initial = loading;
  state.lastProgress = performance.now();
  if (!loading && !App.viewer[slot]) state.pending = 0;
  updateChunkUI(true);
}

function watchChunkLoading(slot, ts) {
  const touch = () => { chunkState[slot].lastProgress = performance.now(); updateChunkUI(); };
  for (const name of ['tileLoad', 'tileFailed', 'initialTilesLoaded', 'allTilesLoaded']) {
    const ev = ts[name];
    if (ev && typeof ev.addEventListener === 'function') ev.addEventListener(touch);
  }
  if (ts.tileLoadProgressEvent && typeof ts.tileLoadProgressEvent.addEventListener === 'function') {
    ts.tileLoadProgressEvent.addEventListener(count => {
      chunkState[slot].pending = Math.max(0, Number(count) || 0);
      touch();
    });
  }
}

export function syncChunkQueues() {
  for (const slot of Object.keys(chunkState)) {
    const ts = App.viewer && App.viewer[slot];
    const st = chunkState[slot];
    if (!ts || !ts.statistics) continue;
    const q = Math.max(0, (ts.statistics.numberOfTilesProcessing || 0) + (ts.statistics.numberOfPendingRequests || 0));
    if (q !== st.pending) { st.pending = q; st.lastProgress = performance.now(); }
  }
}

export function clearChunkLoading() {
  for (const state of Object.values(chunkState)) {
    state.initial = false; state.pending = 0; state.lastProgress = 0;
  }
  updateChunkUI(true);
}

export async function resolveAssetUrl(slot) {
  if (assetUrlCache[slot] !== undefined) return assetUrlCache[slot];
  let found = null;
  for (const url of ASSET_CFG[slot].urls) {
    try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) { found = url; break; } } catch (e) {}
  }
  if (found) assetUrlCache[slot] = found;
  else assetUrlCache[slot] = undefined;
  return found;
}

/* ensureAsset: btn объявлена ДО try, чтобы catch не падал с ReferenceError (§15.1). */
export async function ensureAsset(slot) {
  if (App.viewer[slot]) return App.viewer[slot];
  if (assetPromises[slot]) return assetPromises[slot];
  const cfg = ASSET_CFG[slot], row = $(cfg.row);
  row.disabled = true;
  row.querySelector('.lbl').textContent = cfg.label + '…';
  setAssetLoading(slot, true);
  const promise = (async () => {
    const url = await resolveAssetUrl(slot);
    if (!url) throw new Error('файл не найден');
    const ts = await App.withTimeout(Cesium.Cesium3DTileset.fromUrl(url), 20000);
    flattenTileset(ts);
    ts.maximumScreenSpaceError = QUALITY_PRESETS[App.qualityMode][slot];
    ts.skipLevelOfDetail = true;
    if ('cullWithParentBounds' in ts) ts.cullWithParentBounds = true;
    if (slot === 'splats' && 'pickable' in ts) ts.pickable = false;
    ts.show = false;
    App.viewer.scene.primitives.add(ts);
    App.viewer[slot] = ts;
    watchChunkLoading(slot, ts);
    return ts;
  })();
  assetPromises[slot] = promise;
  try { return await promise; }
  catch (e) {
    const btn = row;
    btn.title = cfg.label + ': ' + (e.message || 'ошибка загрузки');
    App.toast(cfg.label + ': ' + (e.message || 'ошибка загрузки'));
    throw e;
  } finally {
    assetPromises[slot] = null;
    setAssetLoading(slot, false);
    updateAssetButtons();
  }
}

export function assetChoiceState() {
  if (App.noGl || !App.viewer) return 'none';
  if (App.viewer.splats && App.viewer.splats.show) return 'splat';
  if (App.viewer.tileset && App.viewer.tileset.show) return 'model';
  return 'none';
}

export function setAssetChoice(kind) {
  if (App.noGl || !App.viewer) { App.toast('3D недоступен: нет WebGL'); return; }
  if (App.mode !== '3d') { App.toast('ресурс доступен в режиме 3D'); return; }
  if (kind === 'none') {
    for (const slot of Object.keys(ASSET_CFG)) if (App.viewer[slot]) App.viewer[slot].show = false;
    syncGlobeVisibility();
    return;
  }
  if (assetChoiceState() === kind) return;
  toggleAsset(kind === 'splat' ? 'splats' : 'tileset');
}

export async function toggleAsset(slot) {
  if (App.noGl || !App.viewer) return;
  const choice = ++App.assetChoice;
  const existing = App.viewer[slot];
  if (existing && existing.show) {
    existing.show = false;
    syncGlobeVisibility();
    return;
  }
  try {
    /* взаимоисключение применяется ДО загрузки (§15.2 интерпретация — аудит B-2) */
    for (const other of Object.keys(ASSET_CFG)) if (other !== slot && App.viewer[other]) App.viewer[other].show = false;
    syncGlobeVisibility();
    const ts = await ensureAsset(slot);
    if (choice !== App.assetChoice) return;
    ts.show = true;
    syncGlobeVisibility();
  } catch (e) { /* ensureAsset уже показал понятную ошибку */ }
}

export function syncGlobeVisibility() {
  if (!App.viewer) return;
  const hasAsset = Object.keys(ASSET_CFG).some(slot => App.viewer[slot] && App.viewer[slot].show);
  App.viewer.scene.globe.show = !hasAsset;
  updateAssetButtons();
}

export function updateAssetButtons() {
  for (const [slot, cfg] of Object.entries(ASSET_CFG)) {
    const row = $(cfg.row);
    const on = !!(App.viewer && App.viewer[slot] && App.viewer[slot].show);
    row.classList.toggle('on', on);
    row.disabled = App.noGl || App.mode === '2d' || !!assetPromises[slot] || Q.has(cfg.flag) || assetUrlCache[slot] === null;
    if (App.noGl) row.title = '3D недоступен: нет WebGL';
    else if (App.mode === '2d') row.title = 'доступно в режиме 3D';
    else if (row.title === 'доступно в режиме 3D') row.title = cfg.title;
    row.querySelector('.lbl').textContent = assetPromises[slot] ? cfg.label + '…' : cfg.label;
  }
}

export function fitBasemapDrop() {
  let mz = Infinity;
  for (const f of App.feats) {
    const g = f.geom; if (!g || !g.hasZ) continue;
    for (const p of (g.parts || [])) for (const q of (Array.isArray(p) ? p : (p.pts || []))) if (q[2] != null) mz = Math.min(mz, q[2]);
  }
  const need = mz === Infinity ? 6 : Math.ceil(GROUND_H - mz + 2);
  setBaseDrop(Math.max(6, Math.min(20, need)));
  applyBasemapDrop();
}

/* Подложку опускаем плоским terrain-провайдером: поверхность глобуса (и орто на ней) лежит на
 * −BASE_DROP, а не на 0. Свой провайдер, а не scene.verticalExaggeration: exaggeration в 1.147
 * действует и на 3D-тайлсеты, то есть смяло бы саму модель. TerrainData в 1.147 — интерфейс,
 * конкретный класс для heightmap-1.0 это HeightmapTerrainData (проверено в консоли). */
export function applyBasemapDrop() {
  if (!App.viewer) return;
  const buf = new Float32Array(16 * 16).fill(-BASE_DROP);
  class FlatTerrain extends Cesium.EllipsoidTerrainProvider {
    requestTileGeometry() {
      return Promise.resolve(new Cesium.HeightmapTerrainData({ buffer: buf, width: 16, height: 16 }));
    }
  }
  // новый объект каждый раз: свойство terrainProvider проверяет несовпадение экземпляра и только
  // тогда перекладывает тайлы глобуса, поэтому тот же экземпляр с мутацией буфера не сработает
  App.viewer.scene.globe.terrainProvider = new FlatTerrain();
}
App.applyBasemapDrop = applyBasemapDrop;

/* Очередь чанков живёт на событиях тайлсета, а «зависло или нет» решаем по таймеру: без него
   индикатор «Загрузка 3D-модели · 12 чанков» висел бы вечно при молчаливом обрыве соединения.
   Порог 12 с = три интервала без единого прогресса. */
export function startChunkWatch() {
  setInterval(() => {
    syncChunkQueues();
    const now = performance.now();
    const stalled = Object.values(chunkState).some(state =>
      (state.initial || state.pending > 0) && now - state.lastProgress >= 12000);
    if (stalled) App.showPerfNotice('network');
    updateChunkUI();
  }, 1000);
}
