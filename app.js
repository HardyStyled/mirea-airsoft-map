/* app.js — MVP навигации и просмотра (ADR-26).
 * Разметка — index.html, стиль — ui.css. Редактор и панель слоёв отложены и в MVP не загружаются.
 * Модель и Splat взаимоисключающие; при активном 3D-ресурсе глобус с орто не рисуется.
 * WASD/Q/E — свободная камера, ПКМ — обзор, R — исходный ракурс.
 * Координаты и масштаб показываются только над видимым 2D-планом. */
'use strict';

Cesium.Ion.defaultAccessToken = undefined;            // никаких обращений к Cesium ion
window.CESIUM_BASE_URL = './vendor/cesium/';

/* ——— геометрия участка (без изменений) ——— */
const EXTENT = { w: 37.479587839, s: 55.672218962, e: 37.482130196, n: 55.673727617 };
const rect = Cesium.Rectangle.fromDegrees(EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n);
// Кадр высот (ADR-2): реальная высота − GROUND_H. Все Metashape-данные (3D-модель, сплаты,
// вектор с Z) живут в этом кадре вместе и друг относительно друга не сдвигаются.
// Подложка (глобус с ортофотопланом) опускается на BASE_DROP метров НИЖЕ эллипсоида: оставаясь
// на эллипсоиде, орто резало низ модели (z-fight) и ломало перспективу — «земля» оказывалась
// выше крыш. Опускаем именно подложку, отметки объектов не трогаем (решение владельца 22.11).
const GROUND_H = 188;
let BASE_DROP = 6;                        // метров ниже эллипсоида, где лежит ортоподложка
const SITE_CENTER = Cesium.Cartesian3.fromDegrees((EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2, GROUND_H);
const SITE_GROUND_CENTER = Cesium.Cartesian3.fromDegrees((EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2, 0);
const ENU = Cesium.Transforms.eastNorthUpToFixedFrame(SITE_CENTER);

// Metashape кладёт в тайлсет собственный transform: сцена в нём уже Z-up и на своих местах,
// из матрицы нужен только сдвиг кадра высот. Прежний yUpFix (поворот на 90° вокруг X)
// применялся к уже повёрнутой сцене и потому докручивал модель (замечание владельца 22.11).
function flattenTileset(ts) {
  const shift = Cesium.Matrix4.multiplyByPointAsVector(ENU, new Cesium.Cartesian3(0, 0, -GROUND_H), new Cesium.Cartesian3());
  ts.modelMatrix = Cesium.Matrix4.fromTranslation(shift);
}

/* Подложку опускаем плоским terrain-провайдером: поверхность глобуса (и орто на ней) лежит на
 * −BASE_DROP, а не на 0. Свой провайдер, а не scene.verticalExaggeration: exaggeration в 1.147
 * действует и на 3D-тайлсеты, то есть смяло бы саму модель. TerrainData в 1.147 — интерфейс,
 * конкретный класс для heightmap-1.0 это HeightmapTerrainData (проверено в консоли). */
function applyBasemapDrop() {
  if (!viewer) return;
  const buf = new Float32Array(16 * 16).fill(-BASE_DROP);
  class FlatTerrain extends Cesium.EllipsoidTerrainProvider {
    requestTileGeometry() {
      return Promise.resolve(new Cesium.HeightmapTerrainData({ buffer: buf, width: 16, height: 16 }));
    }
  }
  // новый объект каждый раз: свойство terrainProvider проверяет несовпадение экземпляра и только
  // тогда перекладывает тайлы глобуса, поэтому тот же экземпляр с мутацией буфера не сработает
  viewer.scene.globe.terrainProvider = new FlatTerrain();
}

/* ——— растр: орто / QGIS; QGIS-тайлы ищутся в репо и в корне данных (ADR-7) ——— */
const TILES_Q = new URLSearchParams(location.search).get('tiles');
const BASES = { ortho: ['./tiles/'], qgis: ['./tiles_qgis/', '../tiles_qgis/'] };
const BASE_PROBES = ['15/19795/10256.png', '18/158364/82054.png', '20/633459/328218.png'];
let TILES_BASE = './tiles_qgis/';   // стартовая подложка 2D — «Схема» (QGIS), «Карта» переключает на орто
window.TILES_BASE = TILES_BASE;
async function resolveBase(list) {
  for (const u of list)
    for (const p of BASE_PROBES)
      try { const r = await fetch(u + p, { method: 'HEAD' }); if (r.ok) return u; } catch (e) {}
  return null;
}
function makeProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: TILES_BASE + '{z}/{x}/{y}.png',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256, tileHeight: 256, minimumLevel: 15, maximumLevel: 22,
    rectangle: rect,            // орто заполнено на 8.84 % — за экстент не ходим
  });
}
const TILESET = './3dtiles/tileset.json';
const SPLATS = new URLSearchParams(location.search).get('splats');
const SPLAT_CANDIDATES = SPLATS ? [SPLATS] : ['./splat/tileset.json', './splats/tileset.json'];
// Публичный MVP: векторные слои и GPKG выключены полностью (ADR-27).
// Код чтения оставлен для отдельного рефактора, но сеть и рендер объектов не используются.
const SHOW_VECTOR_LAYERS = false;

/* ——— стили слоёв gpkg (те же, что в v1; план их получает для окраски) ——— */
const GPK_STYLE = {
  buildings:   { fill: 'rgba(55,200,232,0.18)', line: '#37c8e8' },
  objects:     { fill: 'rgba(55,232,120,0.15)', line: '#37e878' },
  playzone:    { fill: 'rgba(255,159,28,0.08)', line: '#ff9f1c' },
  restricted:  { fill: 'rgba(255,59,48,0.15)',  line: '#ff3b30' },
  clearground: { fill: 'rgba(255,255,255,0.05)', line: '#99aabc' },
  land_cover:  { fill: 'rgba(120,200,120,0.10)', line: '#77cc77' },
  ground:      { fill: 'rgba(200,200,120,0.06)', line: '#cccc88' },
  vehicles:    { fill: 'rgba(255,200,60,0.15)',  line: '#ffc83c' },
  roads:       { line: '#d8b26a' },
  tactical:    { line: '#ff6b6b' },
  river:       { line: '#4aa8ff' },
  'щиты':      { line: '#c8a2ff' },
  'Бочки':     { line: '#ffb26a' },
};
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
// gpkg открываем в том числе чужим файлом («открыть файл…»), поэтому имена слоёв, таблиц и
// атрибутов — недоверенный текст: в innerHTML они попадают только через esc (code-review 22.11).
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ——— общее состояние: сюда же смотрит editor.js ——— */
const App = {
  viewer: null, plan: null, GP: null,
  ents: new Map(),            // 'table:fid' -> [entity...]
  layerOn: Object.create(null),
  sel: null,                  // { table, fid, id, layer, name, geom, attrs, hasZ }
  tool: 'sel', mode: '3d',
  feats: [],                  // нормализованные объекты gpkg для плана/выбора на плане
  styleOf: t => GPK_STYLE[t] || { line: '#99aabc' },
};
window.App = App;

/* ——— toast (как в превью) ——— */
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
App.toast = toast;

/* ——— вьювер. Без WebGL Cesium не строит сцену и бросает свой английский диалог, поэтому
 * поддержку проверяем заранее и уходим в 2D-режим: карта остаётся планом-канвасом (T15). ——— */
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    // контекст сразу освобождаем: браузер лимитирует их число, иначе проба сама ломает 3D
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) { return false; }
}
const Q = new URLSearchParams(location.search);
// ?nogl=1 включает 2D-режим принудительно (проверка и слабые машины)
let NO_GL = !hasWebGL() || Q.has('nogl');
let viewer = null;
if (!NO_GL) {
  try {
    viewer = new Cesium.Viewer($('map'), {
      baseLayer: new Cesium.ImageryLayer(makeProvider()),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      animation: false, timeline: false, fullscreenButton: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      shouldAnimate: false,
    });
  } catch (e) {
    NO_GL = true;
    App.noGL = true;
    App.noGlReason = 'Cesium не смог создать WebGL-контекст: ' + (e.message || e);
    document.body.classList.add('nogl');
  }
  if (viewer) App.viewer = viewer;
  if (viewer) {
  viewer.scene.mode = Cesium.SceneMode.SCENE3D;
  /* Слабое железо (ADR-21, T21): по умолчанию Cesium берёт максимум качества. На этом ПК
   * глобус с maximumScreenSpaceError 2, атмосферой, туманом и HDR подвешивает вкладку до того,
   * как вообще успеет что-то нарисовать. Дорогое снимаем сразу, остальное режет доглядчик кадров. */
  const sc = viewer.scene;
  sc.globe.maximumScreenSpaceError = 8;
  sc.globe.atmosphereShow = false;
  if (sc.skyAtmosphere) sc.skyAtmosphere.show = false;
  if (sc.skyBox) sc.skyBox.show = false;
  sc.backgroundColor = Cesium.Color.fromCssColorString('#04060a');
  if (sc.sun) sc.sun.show = false;
  if (sc.moon) sc.moon.show = false;
  sc.fog.enabled = false;
  sc.highDynamicRange = false;
  sc.postProcessStages.fxaa.enabled = false;
  try { sc.msaaSamples = 1; } catch (e) { /* older Cesium: свойство только для чтения */ }
  sc.globe.baseColor = Cesium.Color.fromCssColorString('#0a0d12');   // без подложки — тёмный фон, а не синий океан
  /* Доглячик кадров. Cesium 1.147 роняет PerformanceWatchdog на сцене Viewer'а
   * («Cannot read properties of undefined (reading _frameRateMonitor)», замер 22.11 18:55) —
   * поэтому считаем кадры сами, в том же postRender. */
  let cut = 0, fFrames = 0, fT0 = performance.now(), fWatch = true;
  viewer.scene.postRender.addEventListener(() => {
    if (!fWatch) return;
    fFrames++;
    const dt = performance.now() - fT0;
    if (dt < 2500) return;                       // первые секунды грузятся тайлы — не считаем
    const fps = fFrames * 1000 / dt;
    fFrames = 0; fT0 = performance.now();
    if (fps >= 6) return;
    cut++;
    if (cut === 1 && viewer.tileset) { viewer.tileset.maximumScreenSpaceError = 48; toast('кадров мало: 3D-модель упрощена'); }
    else if (cut === 2 && viewer.splats) { viewer.splats.show = false; syncGlobeVisibility(); toast('кадров мало: Splat выключен'); }
    else if (cut === 3) { sc.globe.maximumScreenSpaceError = 16; toast('кадров мало: подложка упрощена'); }
    else { fWatch = false; degradeTo2D('кадров слишком мало, 3D отключён'); }
  });
  }
} else {
  App.noGL = true;
  document.body.classList.add('nogl');
}
function noGlNotice() {
  App.noGlReason = App.noGlReason || 'браузер не дал WebGL (включи аппаратное ускорение в настройках Chrome)';
  $('stat').textContent = '2D без 3D: ' + App.noGlReason;
  toast('3D недоступен. Можно смотреть и масштабировать 2D-план');
}
/* Cesium отваливается и уже в процессе рендера (сбой шейдеров, потеря контекста). Его английский
 * диалог плюс чёрная половина экрана — тупик: убираем диалог и переходим в 2D-режим (T15). */
function degradeTo2D(why) {
  if (NO_GL) return;
  NO_GL = true; App.noGL = true;
  if (viewer) viewer.useDefaultRenderLoop = false;
  document.body.classList.add('nogl');
  document.querySelectorAll('#viewSeg button').forEach(b => {
    if (b.textContent.trim().toLowerCase() !== '2d') { b.disabled = true; b.title = why; }
  });
  $('chModel').disabled = $('chSplats').disabled = true;
  setMode('2d');
  App.noGlReason = why;
  $('stat').textContent = '3D выключен: ' + why + '. Работает 2D-план и выбор объектов';
  toast('3D недоступен: ' + why);
}
if (viewer) viewer.scene.renderError.addEventListener((scene, message) => {
  const panel = document.querySelector('.cesium-widget-errorPanel');
  if (panel) panel.remove();                 // показываем своё объяснение по-русски, а не диалог Cesium
  // текст Cesium'а прячем за своим, но без него не понять, ЧТО именно сломалось (шейдеры, контекст, тайлы)
  const why = String(message || '').split('\n')[0].slice(0, 140);
  degradeTo2D('браузер не смог отрисовать сцену' + (why ? ': ' + why : ''));   // «Rendering has stopped» — второй попытки не будет
});
// ?failrender=1 прогоняет этот путь на машинах, где 3D исправен: проверяем деградацию, а не удачу
if (viewer && Q.has('failrender')) setTimeout(() => viewer.scene.renderError.raiseEvent(viewer.scene, 'проверка'), 900);
/* стартовый вид: камера НАД землёй и южнее полигона (кадр ADR-2: полигон на ~188 м).
 * View по rect ставил камеру на 157 м — под полигоном, экран тонул в сплатах. */
function homeView(m) {
  if (!viewer) return;
  if (m === '3d') {
    // Данные уже приведены к нулевому кадру: высота камеры 140 м, а не GROUND_H + 140.
    // Южнее центра на ~139 м; наклон направлен в центр участка и не оставляет модель внизу кадра.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees((EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2 - 0.00125, 140),
      orientation: { heading: 0, pitch: -0.78, roll: 0 },
    });
  } else {
    viewer.camera.setView({ destination: rect, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }
}
if (!NO_GL) homeView('3d');
const camCtrl = () => viewer ? (viewer.scene.screenSpaceCameraController || viewer.screenSpaceCameraController || viewer.cameraController) : null;
/* ——— предел отдаления (замечание владельца 22.11: «зачем мне земной шар»).
 * Максимальный зум наружу = полигон целиком в кадре + запас. Дальше не пускаем
 * ни в 3D (штатный лимит контроллера), ни в 2D (размер орто-кадра), ни на canvas-плане. */
const MAX_VIEW_M = 320;                       // ширина кадра по земле на максимальном отдалении, м
function applyZoomLimits() {
  if (!viewer) return;
  const c = viewer.scene.screenSpaceCameraController;
  if (!c) return;
  const fov = (viewer.camera.frustum && viewer.camera.frustum.fov) || Cesium.Math.toRadians(60);
  c.maximumZoomDistance = MAX_VIEW_M / (2 * Math.tan(fov / 2));
  c.minimumZoomDistance = 0.6;
}
App.applyZoomLimits = applyZoomLimits;
applyZoomLimits();
// на время drag'а в редакторе камеру глушим, иначе Cesium тащит её вместе с вершиной
App.camLock = on => {
  const c = camCtrl();
  if (!c) return;
  for (const k of ['enableInputs', 'enableRotate', 'enableTranslate', 'enableZoom', 'enableTilt', 'enableLook'])
    if (k in c) c[k] = !on;
};

/* ——— режимы вида + правила мини-карты (ADR-15) ——— */
const MODES = { '3d': Cesium.SceneMode.SCENE3D, '2d': Cesium.SceneMode.SCENE2D };   // 2.5D убран (решение владельца 22.11)

/* Вид — два независимых переключателя (решение владельца 22.11):
 *   режим  3D | 2D     — сегмент вида внизу;
 *   сплит  вкл | выкл  — кнопка между 3D и 2D: 3D слева + план справа, иначе один вьюпорт.
 * В 2D плана «половины» нет: там план и есть весь экран (как правая половина сплита). */
App.split = true;
function applyViewClasses() {
  document.body.classList.toggle('split3d', App.mode === '3d' && App.split && !NO_GL);
  document.body.classList.toggle('pure2d', App.mode === '2d');
  const sp = $('chSplit');
  if (sp) {
    const off = App.mode === '2d';
    sp.classList.toggle('on', App.mode === '3d' && App.split);
    sp.toggleAttribute('disabled', off);
    sp.setAttribute('aria-disabled', off ? 'true' : 'false');
    sp.tabIndex = off ? -1 : 0;
    sp.title = off ? 'в 2D и так один план на весь экран'
                   : (App.split ? 'выключить сплит: 3D на весь экран' : 'включить сплит: 3D слева, план справа');
  }
  if (App.plan) App.plan.resize();
  if (viewer) viewer.resize();
  moveThumb();
  updateAssetButtons();
  $('fovSl').disabled = NO_GL;
  $('fovSl').title = NO_GL ? 'поле зрения доступно только в 3D' : '';
  updateReadout();
}
function setMode(m) {
  clearFreeKeys();
  stopFreeLook();
  if (NO_GL) { m = '2d'; }
  if (m === '2d') assetChoice++;       // отложенная загрузка ресурса не включается поверх 2D
  App.mode = m;
  applyViewClasses();
  if (viewer) { viewer.scene.mode = MODES[m]; homeView(m); }
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.textContent.trim().toLowerCase() === m));
  moveThumb();
}
function moveThumb() {
  const on = document.querySelector('#viewSeg button.on'), th = document.querySelector('#viewSeg .thumb');
  if (on && th) { th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px'; }
}
document.querySelectorAll('#viewSeg button').forEach(b =>
  b.addEventListener('click', () => setMode(b.textContent.trim().toLowerCase())));
function toggleSplit() {
  if (App.mode === '2d' || NO_GL) { toast('в 2D и так один план на весь экран'); return; }
  App.split = !App.split;
  applyViewClasses();
  toast(App.split ? 'сплит: 3D слева, план справа' : 'сплит выключен: 3D на весь экран');
}
$('chSplit').onclick = toggleSplit;
// role="button" и tabindex=0 обязывают отвечать на клавиатуру (code-review 22.11)
$('chSplit').onkeydown = e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); e.stopPropagation(); toggleSplit();
};

// Ходьба → один вьюпорт + радар (ADR-15). Без WebGL план становится главным вьюпортом (nogl в ui.css).

/* ——— поповер «ВИД» и ящик слоёв ——— */
$('vbtn').setAttribute('aria-expanded', 'false');
$('vbtn').onclick = () => {
  const open = document.body.classList.toggle('vopen');
  $('vbtn').setAttribute('aria-expanded', String(open));
};

/* ——— базовая карта ——— */
function baseState() { $('stat').title = 'растр: ' + (TILES_BASE.includes('qgis') ? 'QGIS' : 'орто'); }
let baseChoice = 0;
async function setBase(name, listOverride) {
  const choice = ++baseChoice;
  const url = await resolveBase(listOverride || BASES[name]);
  if (choice !== baseChoice) return false;
  if (!url) { toast('карта ' + name + ': файлы не найдены'); return false; }
  TILES_BASE = url; window.TILES_BASE = url;
  if (viewer) {
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(makeProvider());
  }
  if (App.plan) App.plan.clearTiles();
  $('chOrtho').classList.toggle('on', name === 'ortho');
  $('chQgis').classList.toggle('on', name === 'qgis');
  baseState();
  if (viewer && !viewer.scene.globe.show) toast('подложка видна в 2D или при выключенных model/Splat');
  return true;
}
$('chOrtho').onclick = () => setBase('ortho');
$('chQgis').onclick = () => setBase('qgis');

/* ——— model/Splat: один видимый ресурс, Splat загружается по требованию (ADR-26) ——— */
const ASSET_CFG = {
  tileset: { label: '3D-модель', urls: [TILESET], button: 'chModel', flag: 'nomodel' },
  splats: { label: 'Splat', urls: SPLAT_CANDIDATES, button: 'chSplats', flag: 'nosplat' },
};
const assetUrlCache = { tileset: undefined, splats: undefined };
const assetPromises = { tileset: null, splats: null };
let assetChoice = 0;

/* В режиме только орто подложка остаётся ниже вектора. При model/Splat глобус скрывается полностью,
 * поэтому его текстура и поверхность не могут конкурировать с 3D-геометрией за глубину. */
function fitBasemapDrop() {
  let mz = Infinity;
  for (const f of App.feats) {
    const g = f.geom; if (!g || !g.hasZ) continue;
    for (const p of (g.parts || [])) for (const q of (Array.isArray(p) ? p : (p.pts || []))) if (q[2] != null) mz = Math.min(mz, q[2]);
  }
  const need = mz === Infinity ? 6 : Math.ceil(GROUND_H - mz + 2);
  BASE_DROP = Math.max(6, Math.min(20, need));
  applyBasemapDrop();
}
function updateAssetButtons() {
  for (const [slot, cfg] of Object.entries(ASSET_CFG)) {
    const btn = $(cfg.button);
    const on = !!(viewer && viewer[slot] && viewer[slot].show);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.disabled = NO_GL || App.mode === '2d' || !!assetPromises[slot] || Q.has(cfg.flag) || assetUrlCache[slot] === null;
    if (App.mode === '2d') btn.title = 'доступно в режиме 3D';
    else if (btn.title === 'доступно в режиме 3D') btn.title = slot === 'splats' ? 'загрузить и показать Splat вместо 3D-модели' : 'показать 3D-модель вместо Splat';
    if (!assetPromises[slot]) btn.textContent = cfg.label;
  }
}
function syncGlobeVisibility() {
  if (!viewer) return;
  const hasAsset = Object.keys(ASSET_CFG).some(slot => viewer[slot] && viewer[slot].show);
  viewer.scene.globe.show = !hasAsset;
  updateAssetButtons();
}
async function resolveAssetUrl(slot) {
  if (assetUrlCache[slot] !== undefined) return assetUrlCache[slot];
  let found = null;
  for (const url of ASSET_CFG[slot].urls) {
    try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) { found = url; break; } } catch (e) {}
  }
  if (found) assetUrlCache[slot] = found;
  else assetUrlCache[slot] = undefined;   // неудачная проба не запрещает retry после восстановления сервера
  return found;
}
async function ensureAsset(slot) {
  if (viewer[slot]) return viewer[slot];
  if (assetPromises[slot]) return assetPromises[slot];
  const cfg = ASSET_CFG[slot], btn = $(cfg.button);
  btn.disabled = true;
  btn.textContent = cfg.label + '…';
  const promise = (async () => {
    const url = await resolveAssetUrl(slot);
    if (!url) throw new Error('файл не найден');
    const ts = await withTimeout(Cesium.Cesium3DTileset.fromUrl(url), 20000);
    flattenTileset(ts);
    ts.maximumScreenSpaceError = slot === 'tileset' ? 24 : 32;
    ts.skipLevelOfDetail = true;
    ts.preloadSiblings = false;
    if ('cullWithParentBounds' in ts) ts.cullWithParentBounds = true;
    if (slot === 'splats' && 'pickable' in ts) ts.pickable = false;
    ts.show = false;
    viewer.scene.primitives.add(ts);
    viewer[slot] = ts;
    return ts;
  })();
  assetPromises[slot] = promise;
  try { return await promise; }
  catch (e) {
    btn.title = cfg.label + ': ' + (e.message || 'ошибка загрузки');
    toast(cfg.label + ': ' + (e.message || 'ошибка загрузки'));
    throw e;
  } finally {
    assetPromises[slot] = null;
    updateAssetButtons();
  }
}
async function toggleAsset(slot) {
  if (NO_GL || !viewer) return;
  const choice = ++assetChoice;
  const existing = viewer[slot];
  if (existing && existing.show) {
    existing.show = false;
    syncGlobeVisibility();
    return;
  }
  try {
    const ts = await ensureAsset(slot);
    if (choice !== assetChoice) return;
    for (const other of Object.keys(ASSET_CFG)) if (other !== slot && viewer[other]) viewer[other].show = false;
    ts.show = true;
    syncGlobeVisibility();
  } catch (e) { /* ensureAsset уже показал понятную ошибку */ }
}
for (const [slot, cfg] of Object.entries(ASSET_CFG)) {
  const btn = $(cfg.button);
  btn.disabled = true;
  btn.setAttribute('aria-pressed', 'false');
  btn.onclick = () => toggleAsset(slot);
}

/* ——— FOV (ADR-6): горизонтальное поле зрения 3D-камеры ——— */
function setFov(deg) {
  if (!viewer) return;
  const fr = viewer.camera.frustum;
  if (!(fr instanceof Cesium.PerspectiveFrustum)) return;
  fr.fov = Cesium.Math.toRadians(deg);
  $('fovVal').textContent = deg + '°';
  applyZoomLimits();          // предел отдаления пересчитан под новый fov
}
$('fovSl').oninput = e => setFov(+e.target.value);

/* ——— свободная камера (ADR-26): WASD по взгляду, Q/E по вертикали, ПКМ — обзор ——— */
const freeKeys = App.freeKeys = new Set();
const FREE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const KEY_FALLBACK = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', r: 'KeyR', shift: 'ShiftLeft' };
function freeKeyCode(e) { return e.code || KEY_FALLBACK[e.key.toLowerCase()] || e.key; }
let freeLook = null, freeLast = performance.now();
function clearFreeKeys() { freeKeys.clear(); }
function stopFreeLook() {
  if (!freeLook) return;
  freeLook = null;
  const c = camCtrl();
  if (c) c.enableInputs = true;
  if (viewer) viewer.canvas.style.cursor = '';
}
function editableTarget(target) {
  return target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}
document.addEventListener('keydown', e => {
  if (editableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const code = freeKeyCode(e);
  if (code === 'KeyR' && viewer && !NO_GL && App.mode === '3d') {
    e.preventDefault();
    clearFreeKeys();
    homeView('3d');
    toast('исходный ракурс');
    return;
  }
  if (!viewer || NO_GL || App.mode !== '3d' || !FREE_CODES.has(code)) return;
  e.preventDefault();
  freeKeys.add(code);
});
document.addEventListener('keyup', e => {
  const code = freeKeyCode(e);
  if (!FREE_CODES.has(code)) return;
  freeKeys.delete(code);
  if (viewer && !NO_GL && App.mode === '3d' && !editableTarget(e.target)) e.preventDefault();
});
addEventListener('blur', () => { clearFreeKeys(); stopFreeLook(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearFreeKeys(); stopFreeLook(); } });
document.addEventListener('pointerdown', e => {
  if (viewer && e.target !== viewer.canvas) { clearFreeKeys(); stopFreeLook(); }
}, true);
document.addEventListener('pointerup', () => stopFreeLook(), true);
document.addEventListener('pointercancel', () => stopFreeLook(), true);

if (viewer) {
  const canvas = viewer.canvas;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    if (App.mode !== '3d' || NO_GL) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cam = viewer.camera;
    const factor = Math.min(0.2, Math.max(0.02, Math.abs(cam.positionCartographic.height) * 0.001));
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? canvas.clientHeight : 1));
    const offset = Cesium.Cartesian3.multiplyByScalar(cam.direction, -delta * factor, new Cesium.Cartesian3());
    const candidate = Cesium.Cartesian3.add(cam.position, offset, new Cesium.Cartesian3());
    const controller = camCtrl();
    const minDistance = controller ? controller.minimumZoomDistance : 0.6;
    const maxDistance = controller ? controller.maximumZoomDistance : MAX_VIEW_M;
    const currentDistance = Cesium.Cartesian3.distance(cam.position, SITE_GROUND_CENTER);
    const candidateDistance = Cesium.Cartesian3.distance(candidate, SITE_GROUND_CENTER);
    const toCenter = Cesium.Cartesian3.subtract(SITE_GROUND_CENTER, cam.position, new Cesium.Cartesian3());
    const segment2 = Cesium.Cartesian3.dot(offset, offset);
    const t = segment2 > 0 ? Cesium.Math.clamp(Cesium.Cartesian3.dot(toCenter, offset) / segment2, 0, 1) : 0;
    const closest = Cesium.Cartesian3.add(cam.position, Cesium.Cartesian3.multiplyByScalar(offset, t, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const separation = Cesium.Cartesian3.distance(closest, SITE_GROUND_CENTER);
    const crossesMin = (currentDistance >= minDistance && separation < minDistance) ||
      (currentDistance < minDistance && candidateDistance < currentDistance);
    const crossesMax = (currentDistance <= maxDistance && candidateDistance > maxDistance) ||
      (currentDistance > maxDistance && candidateDistance >= currentDistance);
    if (crossesMin || crossesMax) return;
    cam.position = candidate;
    viewer.scene.requestRender();
  }, { passive: false, capture: true });
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 2 || App.mode !== '3d' || NO_GL) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    freeLook = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    const c = camCtrl();
    if (c) c.enableInputs = false;
    canvas.style.cursor = 'grabbing';
  }, true);
  canvas.addEventListener('pointermove', e => {
    if (!freeLook) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = e.clientX - freeLook.x, dy = e.clientY - freeLook.y;
    freeLook.x = e.clientX; freeLook.y = e.clientY;
    const sensitivity = 0.0021;
    viewer.camera.lookRight(dx * sensitivity);
    viewer.camera.lookDown(dy * sensitivity);
    viewer.scene.requestRender();
  }, true);
  const endLook = e => {
    if (!freeLook) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stopFreeLook();
  };
  canvas.addEventListener('pointerup', endLook, true);
  canvas.addEventListener('pointercancel', endLook, true);
  canvas.addEventListener('lostpointercapture', () => stopFreeLook());
}

function freeCameraTick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - freeLast) / 1000));
  freeLast = now;
  if (viewer && !NO_GL && App.mode === '3d' && freeKeys.size) {
    const cam = viewer.camera;
    const forward = Number(freeKeys.has('KeyW')) - Number(freeKeys.has('KeyS'));
    const right = Number(freeKeys.has('KeyD')) - Number(freeKeys.has('KeyA'));
    const vertical = Number(freeKeys.has('KeyE')) - Number(freeKeys.has('KeyQ'));
    const norm = Math.hypot(forward, right, vertical) || 1;
    const fast = freeKeys.has('ShiftLeft') || freeKeys.has('ShiftRight');
    const height = Math.abs(cam.positionCartographic.height);
    const speed = Math.min(50, Math.max(1.5, height * 0.12)) * (fast ? 4 : 1);
    const step = speed * dt / norm;
    if (forward) cam.moveForward(forward * step);
    if (right) cam.moveRight(right * step);
    if (vertical) {
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cam.position);
      const up = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(0, 0, 1), new Cesium.Cartesian3());
      cam.move(up, vertical * step);
    }
    viewer.scene.requestRender();
  }
  requestAnimationFrame(freeCameraTick);
}
requestAnimationFrame(freeCameraTick);

/* Редактор и его хоткеи отложены (ADR-26); editor.js в MVP не загружается. */
/* ——— gpkg: загрузка, рендер слоёв, панель слоёв (D10) ——— */
function gpkPos(p, hasz) { const h = hasz ? (p[2] ?? 0) - GROUND_H : 0; return Cesium.Cartesian3.fromDegrees(p[0], p[1], h); }
/* объём 3D-объекта (ADR-20): атрибут height в метрах от основания. Основание — Z вершин,
 * поэтому у здания на склоне крыша параллельна земле только при плоском основании; при
 * разных отметках углов верхняя грань берётся по самой высокой вершине + height. */
function heightOf(attrs) {
  if (!attrs) return 0;
  for (const k of Object.keys(attrs)) {
    if (k.toLowerCase() !== 'height') continue;
    const v = +attrs[k];
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  return 0;
}
function maxRelZ(pts) { let m = -Infinity; for (const p of pts) m = Math.max(m, (p[2] ?? GROUND_H) - GROUND_H); return m === -Infinity ? 0 : m; }

// нормализация геометрии gpkg для плана и инспектора: parts -> массивы точек
function geomParts(g) {
  if (g.type === 'Point') return g.parts;                       // [[x,y,z],...]
  if (g.type === 'Polygon') return g.parts;                     // кольца
  if (g.type === 'LineString') return g.parts;                  // [pts]
  return g.parts.map(m => m.pts);                               // CompoundCurve / CurvePolygon
}
function geomKind(t) { return t === 'Point' ? 'pt' : (t === 'Polygon' || t === 'CurvePolygon') ? 'poly' : 'line'; }

function clearLayerEnts(table) {
  if (!viewer) return;
  for (const [id, ents] of App.ents) {
    if (!id.startsWith(table + ':')) continue;
    for (const e of ents) viewer.entities.remove(e);
    App.ents.delete(id);
  }
}
function renderFeature(L, f) {
  if (!viewer) return [];                 // без сцены объекты живут только на плане
  const st = App.styleOf(L.name);
  const g = f.geom; if (!g) return [];
  const id = L.table + ':' + f.fid;
  const hasz = g.hasZ;
  const mk = e => { e.gpk = { table: L.table, layer: L.name, fid: f.fid, attrs: f.attrs, hasZ: hasz, type: g.type }; e.gpkId = id; return e; };
  const ents = [];
  if (g.type === 'Point') {
    for (const p of g.parts) ents.push(mk(viewer.entities.add({
      position: gpkPos(p, hasz),
      point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(st.line),
               outlineColor: Cesium.Color.fromCssColorString('#04060a'), outlineWidth: 1,
               disableDepthTestDistance: Number.POSITIVE_INFINITY },
    })));
  } else if (geomKind(g.type) === 'poly') {
    const vol = hasz ? heightOf(f.attrs) : 0;
    for (const ring of geomParts(g)) ents.push(mk(viewer.entities.add({
      polygon: Object.assign({
        hierarchy: new Cesium.PolygonHierarchy(ring.map(p => gpkPos(p, hasz))),
        material: Cesium.Color.fromCssColorString(st.fill || 'transparent'),
        outline: true, outlineColor: Cesium.Color.fromCssColorString(st.line),
        perPositionHeight: hasz },
        vol ? { extrudedHeight: maxRelZ(ring) + vol } : {}),
    })));
  } else {
    const vol = hasz ? heightOf(f.attrs) : 0;
    for (const line of geomParts(g)) {
      if (vol) ents.push(mk(viewer.entities.add({          // щит/забор: стена вдоль линии
        wall: { positions: line.map(p => gpkPos(p, hasz)),
                maximumHeights: line.map(p => (p[2] ?? GROUND_H) - GROUND_H + vol),
                material: Cesium.Color.fromCssColorString(st.line).withAlpha(0.5) },
      })));
      ents.push(mk(viewer.entities.add({
        polyline: { positions: line.map(p => gpkPos(p, hasz)), width: 2,
                    material: Cesium.Color.fromCssColorString(st.line), clampToGround: !hasz },
      })));
    }
  }
  App.ents.set(id, ents);
  return ents;
}
App.renderFeature = renderFeature;          // наружу: проверка экструзии из тестов без порчи данных
function renderLayer(L) {
  clearLayerEnts(L.table);
  if (App.layerOn[L.table] === false) return;
  for (const f of App.GP.features(L.table)) renderFeature(L, f);
}
App.renderLayer = renderLayer;
// перерисовать один объект (редактор меняет геометрию без перестройки всего слоя)
App.redrawFeature = (table, fid) => {
  if (!viewer) return;
  const id = table + ':' + fid;
  const old = App.ents.get(id);
  if (old) for (const e of old) viewer.entities.remove(e);
  App.ents.delete(id);
  const L = App.GP && App.GP.layers.find(x => x.table === table);
  const f = L && App.GP.features(table).find(x => x.fid === fid);
  if (L && f) renderFeature(L, f);
  if (App.sel && App.sel.id === id) styleSel(id, true);
};
App.refreshPlanFeatures = rebuildPlanFeatures;

function featRow(L, f) {
  const g = f.geom; if (!g) return null;
  return { id: L.table + ':' + f.fid, table: L.table, layer: L.name, fid: f.fid,
           name: (f.attrs && (f.attrs.name || f.attrs.NAME)) || '', kind: geomKind(g.type), geom: g, attrs: f.attrs };
}
function rebuildPlanFeatures() {
  const out = [];
  for (const L of App.GP.layers) {
    if (App.layerOn[L.table] === false) continue;
    for (const f of App.GP.features(L.table)) { const r = featRow(L, f); if (r) out.push(r); }
  }
  App.feats = out;
  const style = {};
  for (const L of App.GP.layers) style[L.name] = App.styleOf(L.name).line;
  if (App.plan) App.plan.setFeatures(out, style);
}

function renderLayerPanel() {
  for (const L of App.GP.layers) if (!(L.table in App.layerOn)) App.layerOn[L.table] = true;
  const nObj = App.GP.layers.reduce((s, L) => s + L.count, 0);
  $('stat').textContent = App.gpkgLabel + ' · ' + nObj + ' объектов' +
    (App.noGlReason ? ' · 3D выключен: ' + App.noGlReason : '');
}

async function loadGpkg(buf, label) {
  try {
    if (App.GP) for (const L of App.GP.layers) clearLayerEnts(L.table);
    App.GP = await gpkgOpen(initSqlJs, buf);
    App.gpkgLabel = label;
    renderLayerPanel();
    for (const L of App.GP.layers) renderLayer(L);   // D10: gpkg — источник объектов
    rebuildPlanFeatures();
    fitBasemapDrop();
    toast('объекты загружены: ' + App.GP.layers.reduce((n, L) => n + L.count, 0));
  } catch (e) {
    document.body.classList.add('data-error');
    $('stat').textContent = 'Не удалось прочитать объекты: ' + e.message;
    toast('объекты не загрузились; орто доступен');
  }
}
App.loadGpkg = loadGpkg;

/* ——— выбор объекта + инспектор ——— */
function styleSel(id, on) {
  const ents = App.ents.get(id); if (!ents) return;
  const table = id.split(':')[0];
  const base = Cesium.Color.fromCssColorString(App.styleOf(table).line);
  for (const e of ents) {
    if (e.polygon) e.polygon.outlineColor = on ? Cesium.Color.fromCssColorString('#ffb020') : base;
    if (e.polyline) e.polyline.material = on ? Cesium.Color.fromCssColorString('#ffb020') : base;
    if (e.point) e.point.color = on ? Cesium.Color.fromCssColorString('#ffb020') : base;
  }
}
function select(rec) {
  if (App.sel && window.Editor) Editor.onBeforeDeselect();
  if (App.sel) styleSel(App.sel.id, false);
  App.sel = rec || null;
  if (App.sel) {
    styleSel(App.sel.id, true);
    if (App.plan) App.plan.setSelected(App.sel.id);
  } else if (App.plan) App.plan.setSelected(null);
  showInsp();
  if (window.Editor) Editor.onSelect();
}
App.select = select;

function showInsp() {
  const box = $('insp');
  if (!App.sel) { box.classList.remove('show'); box.inert = true; return; }
  box.inert = false;
  box.classList.add('show');
  const s = App.sel;
  $('oFid').textContent = 'fid ' + s.fid;
  $('oLayer').textContent = s.layer;
  $('oType').textContent = (s.geom.type || '').toUpperCase();
  const nm = $('fName');
  nm.value = s.name || 'Без названия';
  nm.disabled = false;
  nm.readOnly = true;
  renderAttrs(s);
}
App.showInsp = showInsp;
function renderAttrs(s) {
  const vt = $('verts'); vt.innerHTML = '';
  const skip = new Set(['name', 'NAME', 'fid', 'id']);
  const rows = Object.entries(s.attrs || {}).filter(([k, v]) => !skip.has(k) && v !== null && v !== '').slice(0, 12);
  for (const [k, v] of rows) vt.append(el('div', 'vrow', `<span class="vidx" style="width:auto">${esc(k)}</span><span class="zu" style="margin-left:auto;color:var(--ink)">${esc(v)}</span>`));
  if (window.Editor) Editor.renderVerts();
}

$('inspClose').onclick = () => select(null);

/* пикап: 3D-сцена и 2D-план дают один и тот же выбор.
 * Сплаты и 3D-модель перекрывают векторные объекты, поэтому обычный pick
 * дополняется drillPick — иначе в 3D нельзя выбрать здание под сплатами. */
function pickAt(position) {
  if (!viewer) return null;
  const mine = o => o && o.id && (o.id.gpk || o.id.editorHandle || o.id.editorMid) ? o.id : null;
  let ent = null;
  try { ent = mine(viewer.scene.pick(position)); } catch (e) {}   // pick бросает, пока сцена не отрисована
  if (!ent) {
    let deep = [];
    try { deep = viewer.scene.drillPick(position, 16) || []; } catch (e) {}
    for (const q of deep) { ent = mine(q); if (ent) break; }
  }
  return ent;
}
App.pickAt = pickAt;
if (viewer) {
  const pick3d = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  pick3d.setInputAction(click => {
    if (window.Editor && Editor.onSceneClick(click.position)) return;
    const info = pickAt(click.position)?.gpk;
    if (!info) { select(null); return; }
    select({ table: info.table, fid: info.fid, id: info.table + ':' + info.fid, layer: info.layer,
             name: (info.attrs && (info.attrs.name || info.attrs.NAME)) || '',
             attrs: info.attrs, hasZ: info.hasZ, geom: geomOf(info.table, info.fid) });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
function geomOf(table, fid) {
  const f = App.GP.features(table).find(x => x.fid === fid);
  return f ? f.geom : null;
}
App.geomOf = geomOf;

/* ——— план (правая половина сплита) и радар (режим ходьбы): PlanPane из plan.js ———
 * Без WebGL план и есть карта: камера не нужна, координаты берём из плана. */
const SITE_MID = [(EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2];
function camGround() {
  if (!viewer) return App.plan ? App.plan.center : SITE_MID;
  const c = viewer.camera.positionCartographic; return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
}
function frustumQuad() {
  if (!viewer) return null;
  const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight, pts = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const p = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(x, y), viewer.scene.globe.ellipsoid);
    if (!p) return null;
    const cg = Cesium.Cartographic.fromCartesian(p);
    pts.push([Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)]);
  }
  return pts;
}
function panMain(dLon, dLat) {
  if (!viewer) return;
  const c = viewer.camera.positionCartographic;
  const origin = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const off = Cesium.Matrix4.multiplyByPointAsVector(enu,
    new Cesium.Cartesian3(dLon * 111320 * Math.cos(c.latitude), dLat * 110574, 0), new Cesium.Cartesian3());
  viewer.camera.position = Cesium.Cartesian3.add(viewer.camera.position, off, new Cesium.Cartesian3());
}
function syncPlans() {
  if (!document.body.classList.contains('split3d') || !App.plan || App.plan.busy) return;
  const [lon, lat] = camGround();
  const cam = { lon, lat, heading: viewer ? viewer.camera.heading : 0, quad: frustumQuad() };
  App.plan.setCamera(cam);
  if (App.plan.follow) App.plan.setViewCenter(lon, lat); else App.plan.draw();
}
function makePlan(canvas, opts) {
  const p = new PlanPane(canvas, [], Object.assign({
    center: camGround(), mpp: 0.35,
    onView: (kind, dLon, dLat) => {
      updateReadout();
      if (kind !== 'pan') return;      // зум плана независим от 3D
      // план сдвинул свой центр на −d (drag тянет контент), значит и камера едет на −d,
      // иначе follow-синк в сплите возвращает карту против курсора (code-review 22.11)
      panMain(-dLon, -dLat);
    },
    onPick: id => {
      const r = App.feats.find(f => f.id === id); if (!r) { select(null); return; }
      // attrs берём из gpkg: без них инспектор не даёт переименовать объект (выбор с плана)
      const f = App.GP.features(r.table).find(x => x.fid === r.fid);
      select({ table: r.table, fid: r.fid, id: r.id, layer: r.layer, name: r.name,
               attrs: (f && f.attrs) || {}, hasZ: r.geom.hasZ, geom: r.geom });
    },
  }, opts));
  return p;
}
function ensurePanels() {
  if (!App.plan) {
    App.plan = makePlan($('plan'), { follow: false, rotOn: false, maxViewM: MAX_VIEW_M });
    App.plan.resize(); App.plan.fit(rect);
  }
}

/* ——— координаты центра плана и круглый масштаб, только при видимом 2D (ADR-26) ——— */
function scaleForMpp(mpp) {
  if (!Number.isFinite(mpp) || mpp <= 0) return { meters: 10, px: 100 };
  const raw = mpp * 100;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / power;
  const nice = [1, 2, 5, 10].reduce((best, v) => Math.abs(v - normalized) < Math.abs(best - normalized) ? v : best, 1);
  const meters = nice * power;
  return { meters, px: meters / mpp };
}
App.scaleForMpp = scaleForMpp;
function formatScale(meters) {
  if (meters >= 1000) return (meters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' км';
  if (meters >= 1) return meters.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' м';
  return (meters * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' см';
}
function updateReadout() {
  const visible = App.plan && (document.body.classList.contains('split3d') ||
    document.body.classList.contains('pure2d') || NO_GL);
  if (!visible) return;
  const [lon, lat] = App.plan.center;
  $('roCoord').innerHTML = lat.toFixed(6) + ', <b>' + lon.toFixed(6) + '</b> · план';
  const scale = scaleForMpp(App.plan.mpp);
  const px = Math.round(scale.px);
  const bar = $('sbarBar');
  bar.style.width = px + 'px';
  bar.style.setProperty('--cell', (px / 2) + 'px');
  $('sbarVal').textContent = formatScale(scale.meters);
}

let frames = 0;
if (viewer) viewer.scene.postRender.addEventListener(() => {
  if (App.mode === '3d') syncPlans();
  if (++frames % 6 === 0) updateReadout();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  clearFreeKeys();
  stopFreeLook();
  select(null);
});

/* ——— ресайз: Cesium и canvas-планы живут в одной сетке.
 * Наблюдаем за каждым контейнером отдельно: в ?nogl у #map display:none, его размер не меняется,
 * и наблюдатель только за #map никогда не дёргал план, когда менялось окно (баг 22.11: буфер
 * канваса отставал от CSS-бокса, карта оказывалась обрезана и растянута до первого клика). ——— */
const ro = new ResizeObserver(() => {
  if (viewer) viewer.resize();
  if (App.plan) App.plan.resize();
});
for (const id of ['map', 'plan']) if ($(id)) ro.observe($(id));
addEventListener('resize', () => { moveThumb(); updateReadout(); });

/* ——— старт. Публичный MVP самодостаточен: внешний GPKG не запрашивается (ADR-27). ——— */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + (ms / 1000) + ' с')), ms))]);
async function fetchArrayBuffer(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}
(async () => {
  setFov(60); moveThumb();
  ensurePanels();
  applyViewClasses();
  if (NO_GL) {
    noGlNotice();
    setMode('2d');
    document.querySelectorAll('#viewSeg button').forEach(b => {
      if (b.textContent.trim().toLowerCase() !== '2d') { b.disabled = true; b.title = 'нужен WebGL: включи аппаратное ускорение в браузере'; }
    });
    $('chModel').disabled = $('chSplats').disabled = true;
  }
  if (SHOW_VECTOR_LAYERS) {
    try {
      const buf = await fetchArrayBuffer('../map/tactical.gpkg', 10000);
      await loadGpkg(buf, 'map/tactical.gpkg');
    } catch (e) {
      document.body.classList.add('data-error');
      $('stat').textContent = 'Не удалось загрузить объекты полигона: ' + e.message;
      toast('объекты не загрузились; орто доступен');
    }
  }
  updateReadout();
  if (NO_GL) return;

  applyBasemapDrop();
  for (const [slot, cfg] of Object.entries(ASSET_CFG)) {
    const btn = $(cfg.button);
    if (Q.has(cfg.flag)) {
      btn.disabled = true;
      btn.title = cfg.label + ': отключён флагом ?' + cfg.flag;
    } else {
      btn.disabled = false;
      btn.title = slot === 'splats' ? 'загрузить и показать Splat вместо 3D-модели' : 'показать 3D-модель вместо Splat';
    }
  }
  if (!Q.has('nomodel')) await toggleAsset('tileset');
  else syncGlobeVisibility();

  if (!Q.has('nosplat')) {
    resolveAssetUrl('splats').then(url => {
      const btn = $('chSplats');
      btn.title = url ? 'загрузить и показать Splat вместо 3D-модели' : 'Splat: файл не найден';
      updateAssetButtons();
    });
  }
  if (TILES_Q === 'qgis') await setBase('qgis');
  else if (TILES_Q) await setBase('qgis', [TILES_Q.replace(/\/?$/, '/')]);
})();
