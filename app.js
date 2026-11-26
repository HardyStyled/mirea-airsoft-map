/* app.js — MVP навигации и просмотра (ADR-26/28/29).
 * Разметка — index.html, стиль — ui.css. Редактор и панель слоёв отложены и в MVP не загружаются.
 * Модель и Splat взаимоисключающие; при активном 3D-ресурсе глобус с орто не рисуется.
 * camera.js владеет двумя режимами: орбита с raycast-focus и свободный полёт WASD/QE.
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
/* Сетка растровой подложки: z15–z23 (ADR-30). Экстент и параметры пересборки —
 * ai-project/guides/01-qgis-xyz-tiles.md; тот же верхний уровень у 2D-плана (plan.js).
 * Верхний уровень задаётся по набору: «Схему» пересобирают в QGIS вручную, и она пока
 * отстаёт от орто (в ней z15–z22). После пересборки «Схемы» поднять qgis до 23 — иначе
 * Cesium и план запрашивали бы тайлов, которых нет на хосте: 404 и дышки на дальнем зуме. */
const TILE_ZMIN = 15, TILE_ZMAX = 23;
const BASE_ZMAX = { ortho: TILE_ZMAX, qgis: 22 };
let TILES_ZMAX = BASE_ZMAX.qgis;          // стартовый растр — «Схема»
window.TILES_ZMAX = TILES_ZMAX;
let TILES_BASE = './tiles_qgis/';   // стартовая подложка 2D — «Схема» (QGIS), «Карта» переключает на орто
window.TILES_BASE = TILES_BASE;
async function resolveBase(list) {
  for (const u of list)
    for (const p of BASE_PROBES)
      try { const r = await fetch(u + p, { method: 'HEAD' }); if (r.ok) return u; } catch (e) {}
  return null;
}
function makeProvider(zmax = TILES_ZMAX) {
  return new Cesium.UrlTemplateImageryProvider({
    url: TILES_BASE + '{z}/{x}/{y}.png',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256, tileHeight: 256, minimumLevel: TILE_ZMIN, maximumLevel: zmax,
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

/* ——— ручное качество 3D и рекомендации без автоматических действий (ADR-29/30) ———
 * Пресет качества касается только 3D-ресурсов: модели и Splat. Плоская подложка
 * имеет одну фиксированную детализацию — карта не должна то мылить, то резвиться
 * от переключателя «Качество 3D» (решение владельца 25.11). */
const QUALITY_KEY = 'mam.quality';
const QUALITY_PRESETS = {
  light:  { tileset: 48, splats: 64 },
  normal: { tileset: 24, splats: 32 },
  detail: { tileset: 12, splats: 16 },
};
const BASEMAP_SSE = 4;            // подложка всегда максимально детальна (тайлы z15–z23, ADR-30)
let qualityMode = 'normal';
try {
  const saved = localStorage.getItem(QUALITY_KEY);
  if (Object.hasOwn(QUALITY_PRESETS, saved)) qualityMode = saved;
} catch (e) {}
function updateQualityButtons() {
  document.querySelectorAll('#qualitySeg button').forEach(btn => {
    const on = btn.dataset.quality === qualityMode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.disabled = NO_GL;
  });
  syncMenus();                                // строки качества в меню шестерёнки живут тем же состоянием
}
function applyQuality() {
  if (!viewer) return;
  const preset = QUALITY_PRESETS[qualityMode];
  for (const slot of ['tileset', 'splats']) {
    if (viewer[slot]) viewer[slot].maximumScreenSpaceError = preset[slot];
  }
}
function setQuality(mode) {
  if (!Object.hasOwn(QUALITY_PRESETS, mode)) return;
  qualityMode = mode;
  try { localStorage.setItem(QUALITY_KEY, mode); } catch (e) {}
  applyQuality();
  updateQualityButtons();
}
document.querySelectorAll('#qualitySeg button').forEach(btn => { btn.onclick = () => setQuality(btn.dataset.quality); });

const PERF_COPY = {
  fps: {
    title: '3D работает медленно',
    body: 'Низкая частота кадров. Рекомендуем открыть 2D или выбрать низкое качество в меню «Вид».',
  },
  network: {
    title: '3D загружается дольше обычного',
    body: 'Похоже, соединение медленное. Рекомендуем открыть 2D или выбрать низкое качество в меню «Вид».',
  },
};
const perfLast = { fps: -Infinity, network: -Infinity };
let perfKind = null;
function hidePerfNotice(kind) {
  if (kind && perfKind !== kind) return;
  perfKind = null;
  $('perfNotice').hidden = true;
}
function showPerfNotice(kind) {
  const now = performance.now();
  if (now - perfLast[kind] < 60000) return;
  if (NO_GL || App.mode !== '3d') return;
  perfLast[kind] = now;
  perfKind = kind;
  $('perfTitle').textContent = PERF_COPY[kind].title;
  $('perfBody').textContent = PERF_COPY[kind].body;
  $('perfNotice').hidden = false;
}
$('perfClose').onclick = () => hidePerfNotice();

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
let resetFpsWatch = () => {};
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
  /* Слабое железо (ADR-21/29): дорогие эффекты сняты заранее. Детализация 3D выбирается
   * пользователем в меню «Вид»; доглядчик кадров только показывает рекомендацию.
   * Подложка при этом стоит на фиксированном SSE (ADR-30): качество 3D на неё не влияет. */
  const sc = viewer.scene;
  sc.globe.maximumScreenSpaceError = BASEMAP_SSE;
  applyQuality();
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
  /* Доглячик кадров только советует. Cesium 1.147 роняет PerformanceWatchdog на сцене Viewer'а,
   * поэтому FPS считается в postRender. Два низких окна подряд отсекают одиночную просадку;
   * скрытая вкладка, 2D и первые 5 секунд загрузки в замер не входят. */
  const fStarted = performance.now();
  let fFrames = 0, fT0 = fStarted, fLow = 0;
  resetFpsWatch = () => { fFrames = 0; fT0 = performance.now(); fLow = 0; };
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (document.hidden || App.mode !== '3d') { resetFpsWatch(); return; }
    if (now - fStarted < 5000) { fFrames = 0; fT0 = now; return; }
    fFrames++;
    const dt = now - fT0;
    if (dt < 2500) return;
    const fps = fFrames * 1000 / dt;
    fFrames = 0; fT0 = now;
    fLow = fps < 6 ? fLow + 1 : 0;
    if (fLow >= 2) { showPerfNotice('fps'); fLow = 0; }
  });
  document.addEventListener('visibilitychange', resetFpsWatch);
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
  clearChunkLoading();
  hidePerfNotice();
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
/* стартовый и исходный вид (значения сняты с панели дебага по указанию владельца 26.11):
 * точка на уровне глаз у северо-восточного края участка, курс 126°, взгляд почти горизонтальный.
 * Высота — в кадре приложения (реальная минус GROUND_H), как её показывает дебаг. От этой же
 * точки считается «Исходный вид» (⌂ / R): контроллер захватывает home при создании. */
const HOME_POSE = { lon: 37.48121, lat: 55.67356, h: 2.3, heading: 126, pitch: -1, roll: 0 };
const HOME_LOOK_AHEAD = 40;   // м, вдоль взгляда: вокруг этой точки вращает камера в режиме «Осмотр»
const FOV_DEFAULT = 86;       // °, угол обзора по умолчанию (там же, в панели дебага)
function homeOrientation() {
  const r = Cesium.Math.toRadians;
  return { heading: r(HOME_POSE.heading), pitch: r(HOME_POSE.pitch), roll: r(HOME_POSE.roll) };
}
function homePosition() { return Cesium.Cartesian3.fromDegrees(HOME_POSE.lon, HOME_POSE.lat, HOME_POSE.h); }
/* точка цели для орбиты: вдоль направления взгляда, а не центр участка — иначе первый же поворот
 * в «Осмотре» закручивает камеру вокруг точки за спиной */
function homeTarget() {
  const pos = homePosition(), enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
  const hd = Cesium.Math.toRadians(HOME_POSE.heading), p = Cesium.Math.toRadians(HOME_POSE.pitch);
  const dir = new Cesium.Cartesian3(Math.cos(p) * Math.sin(hd), Math.cos(p) * Math.cos(hd), Math.sin(p));
  const rot = Cesium.Matrix4.getRotation(enu, new Cesium.Matrix3());
  Cesium.Matrix3.multiplyByVector(rot, dir, dir);
  return Cesium.Cartesian3.add(pos, Cesium.Cartesian3.multiplyByScalar(dir, HOME_LOOK_AHEAD, new Cesium.Cartesian3()), new Cesium.Cartesian3());
}
/* стартовый вид: камера НАД землёй и южнее полигона (кадр ADR-2: полигон на ~188 м).
 * View по rect ставил камеру на 157 м — под полигоном, экран тонул в сплатах. */
function homeView(m) {
  if (!viewer) return;
  if (m === '3d') {
    viewer.camera.setView({ destination: homePosition(), orientation: homeOrientation() });
  } else {
    viewer.camera.setView({ destination: rect, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }
}
if (!NO_GL) homeView('3d');
/* ——— предел отдаления (замечание владельца 22.11: «зачем мне земной шар»).
 * Максимальный зум наружу = полигон целиком в кадре + запас. Дальше не пускаем
 * ни в 3D (штатный лимит контроллера), ни в 2D (размер орто-кадра), ни на canvas-плане. */
const MAX_VIEW_M = 320;                       // ширина кадра по земле на максимальном отдалении, м
function applyZoomLimits() {
  if (!viewer) return;
  const c = viewer.scene.screenSpaceCameraController;
  if (!c) return;
  const fov = (viewer.camera.frustum && viewer.camera.frustum.fov) || Cesium.Math.toRadians(FOV_DEFAULT);
  c.maximumZoomDistance = MAX_VIEW_M / (2 * Math.tan(fov / 2));
  c.minimumZoomDistance = 0.6;
}
App.applyZoomLimits = applyZoomLimits;
applyZoomLimits();
const CAMERA_TOUCH = matchMedia('(pointer: coarse)').matches;
const CAMERA_REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
/* тексты подсказок на таче (U3): двойной тап = точка орбиты; в полёте — джойстик.
 * Объявлены до создания контроллера: он вызывает onState ещё на этапе конструктора. */
const CAM_TAG_TOUCH = {
  orbit: 'Осмотр · 1 палец — вращение · 2 пальца — сдвиг и масштаб · 2×тап — точка орбиты · ⌂ — исходный вид',
  fly: 'Полёт · свайп по 3D — взгляд · джойстик — движение · ↑↓ — высота · ×4 — бег',
};
let cameraController = null;
if (viewer) {
  cameraController = new CameraController({
    Cesium, viewer, extent: EXTENT, target: homeTarget(), maxDistance: MAX_VIEW_M,
    isActive: () => App.mode === '3d' && !NO_GL,
    touchOnly: () => CAMERA_TOUCH,
    reducedMotion: () => CAMERA_REDUCED_MOTION.matches,
    onState: updateCameraState,
    onMessage: toast,
  });
  App.cameraController = cameraController;
}
// Все 3D-входы принадлежат CameraController; внешняя блокировка только очищает его ввод.
App.camLock = on => { if (cameraController) cameraController.setLocked(on); };

/* ——— режимы вида + правила мини-карты (ADR-15) ——— */
const MODES = { '3d': Cesium.SceneMode.SCENE3D, '2d': Cesium.SceneMode.SCENE2D };   // 2.5D убран (решение владельца 22.11)

/* Вид — два независимых переключателя (решение владельца 22.11):
 *   режим  3D | 2D     — сегмент вида внизу;
 *   сплит  вкл | выкл  — кнопка между 3D и 2D: 3D слева + план справа, иначе один вьюпорт.
 * В 2D плана «половины» нет: там план и есть весь экран (как правая половина сплита). */
App.split = true;
function applyViewClasses() {
  invalidateRay();                        // старый конец луча не должен переживать смену вида/сброс
  document.body.classList.toggle('split3d', App.mode === '3d' && App.split && !NO_GL);
  document.body.classList.toggle('pure2d', App.mode === '2d');
  /* полноэкранный 3D: только в нём показывается мини-карта (PLAN-mobile N3) */
  document.body.classList.toggle('full3d', App.mode === '3d' && !App.split && !NO_GL);
  /* тач-панели полёта (стик, кнопки высоты) живут теми же классами, что и вид: в 2D и nogl
   * их быть не должно — раньше «flytouch» переживал переход в 2D и джойстик висел над
   * планом, съедая касания (аудит A2) */
  document.body.classList.toggle('flytouch',
    (document.body.dataset.cameraMode || 'orbit') === 'fly' && CAMERA_TOUCH && App.mode === '3d' && !NO_GL);
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
  updateQualityButtons();
  // сброс ракурса имеет смысл только там, где есть 3D-камера
  $('homeBtn').disabled = NO_GL || App.mode !== '3d';
  if (App.mmPlan) App.mmPlan.resize();
  $('fovSl').disabled = NO_GL;
  $('fovSl').title = NO_GL ? 'поле зрения доступно только в 3D' : '';
  syncMenus();
  updateReadout();
}
function setMode(m) {
  if (NO_GL) { m = '2d'; }
  resetFpsWatch();
  const previous = App.mode;
  if (m === '2d' && previous === '3d' && cameraController) cameraController.captureFor2D();
  if (m === '2d') assetChoice++;       // отложенная загрузка ресурса не включается поверх 2D
  if (m === '2d') hidePerfNotice();
  App.mode = m;
  applyViewClasses();
  if (viewer) {
    viewer.scene.mode = MODES[m];
    if (m === '3d') {
      if (previous === '2d' && cameraController) cameraController.restoreFrom2D();
      else if (cameraController) cameraController.setEnabled(true);
    }
  }
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

/* ——— мобильные FAB и контекстные меню (U2): колонка в правом верхнем углу, меню под ней.
 * Десктоп продолжает жить на нижней панели: FAB скрыты CSS-ом (ui.css ≤700px). ——— */
const FAB_MENUS = [['fabMode', 'modeMenu'], ['fabCam', 'camMenu'], ['fabSet', 'setMenu']];
function closeMenus() {
  for (const [fab, menu] of FAB_MENUS) {
    $(menu).classList.remove('open');
    $(fab).setAttribute('aria-expanded', 'false');
  }
}
for (const [fab, menu] of FAB_MENUS) {
  $(fab).onclick = () => {
    const open = !$(menu).classList.contains('open');   // повторный тап по FAB закрывает меню
    closeMenus();
    if (open) {
      $(menu).classList.add('open');
      $(fab).setAttribute('aria-expanded', 'true');
    }
  };
}
// тап мимо и Escape закрывают меню
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.menu') && !e.target.closest('.fab')) closeMenus();
});
/* Escape — один обработчик с приоритетом (аудит A10): сначала закрыть меню/поповер, жалоба
 * «Esc закрывает меню и одновременно переключает режим» закрыта так: если что-то открыто,
 * event гасится в capture-фазе и до обработчика камеры на document не доходит. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const menuOpen = FAB_MENUS.some(([, menu]) => $(menu).classList.contains('open'));
  const vpopOpen = document.body.classList.contains('vopen');
  if (!menuOpen && !vpopOpen) return;
  e.stopPropagation();
  closeMenus();
  if (vpopOpen) {
    document.body.classList.remove('vopen');
    $('vbtn').setAttribute('aria-expanded', 'false');
  }
}, true);

/* активность строк меню рисуют те же функции состояния, что и контролы нижней панели */
function syncItem(id, on) {
  const b = $(id);
  b.classList.toggle('on', on);
  const role = b.getAttribute('role');
  if (role === 'menuitemradio' || role === 'switch') b.setAttribute('aria-checked', String(on));
}
function syncMenus() {
  const camMode = document.body.dataset.cameraMode || 'orbit';
  syncItem('mi3d', App.mode === '3d' && !App.split && !NO_GL);
  syncItem('miSplit', App.mode === '3d' && App.split && !NO_GL);
  syncItem('mi2d', App.mode === '2d');
  syncItem('miOrbit', camMode === 'orbit');
  syncItem('miFly', camMode === 'fly');
  syncItem('miOrtho', $('chOrtho').classList.contains('on'));
  syncItem('miQgis', $('chQgis').classList.contains('on'));
  const asset = assetChoiceState();
  syncItem('miAssetNone', asset === 'none');
  syncItem('miAssetModel', asset === 'model');
  syncItem('miAssetSplat', asset === 'splat');
  syncItem('miQLow', qualityMode === 'light');
  syncItem('miQMid', qualityMode === 'normal');
  syncItem('miQHigh', qualityMode === 'detail');
  syncItem('miDbg', document.body.classList.contains('dbg'));
}

/* «Ресурс 3D» в меню шестерёнки (решение владельца 26.11, I2): Нет / 3D-модель / Splat —
 * тот же выбор, что кнопки chModel/chSplats, но одной группой: раньше сплат был недосягаем
 * на телефоне, т.к. нижняя панель с кнопками в узком экране скрыта. */
function assetChoiceState() {
  if (NO_GL || !viewer) return 'none';
  if (viewer.splats && viewer.splats.show) return 'splat';
  if (viewer.tileset && viewer.tileset.show) return 'model';
  return 'none';
}
function setAssetChoice(kind) {
  if (NO_GL || !viewer) { toast('3D недоступен: нет WebGL'); return; }
  if (App.mode !== '3d') { toast('ресурс доступен в режиме 3D'); return; }
  if (kind === 'none') {
    for (const slot of Object.keys(ASSET_CFG)) if (viewer[slot]) viewer[slot].show = false;
    syncGlobeVisibility();
    return;
  }
  if (assetChoiceState() === kind) return;
  toggleAsset(kind === 'splat' ? 'splats' : 'tileset');
}
$('miAssetNone').onclick = () => { setAssetChoice('none'); closeMenus(); };
$('miAssetModel').onclick = () => { setAssetChoice('model'); closeMenus(); };
$('miAssetSplat').onclick = () => { setAssetChoice('splat'); closeMenus(); };

/* ——— сброс исходного ракурса (U4): ⌂ в нижней панели и строка в меню камеры ——— */
function resetCamera() {
  if (!cameraController) { toast('3D недоступен: нет WebGL'); return; }
  cameraController.reset();
  invalidateRay();
  toast('Исходный ракурс');
}
$('homeBtn').onclick = resetCamera;
$('miHome').onclick = () => { resetCamera(); closeMenus(); };

/* ——— дебаг-панель (U5): строка в поповере «вид» и переключатель в меню шестерёнки ——— */
const DBG_KEY = 'mam.dbg';
/* окно FPS: кадры считает postRender, среднее — за последние 1 с */
const dbgWatch = { frames: 0, at: 0, fps: 0 };
function setDbg(on) {
  document.body.classList.toggle('dbg', on);
  try { localStorage.setItem(DBG_KEY, on ? '1' : '0'); } catch (e) {}
  syncItem('chDbg', on);
  syncItem('miDbg', on);
  dbgWatch.frames = 0; dbgWatch.at = performance.now();   // окно FPS считается заново
}
try { if (localStorage.getItem(DBG_KEY) === '1') setDbg(true); } catch (e) {}
$('chDbg').onclick = () => setDbg(!document.body.classList.contains('dbg'));
$('miDbg').onclick = () => { setDbg(!document.body.classList.contains('dbg')); closeMenus(); };

/* строки панели: FPS за окно 1 с, размер канваса + DPR, широта/долгота/высота,
 * курс/наклон/крен в градусах и вертикальный FOV. Обновление — из postRender. */
function updateDbg() {
  if (!document.body.classList.contains('dbg') || NO_GL || !viewer) return;
  const now = performance.now();
  if (!dbgWatch.at) dbgWatch.at = now;
  else if (now - dbgWatch.at >= 1000) {
    dbgWatch.fps = Math.round(dbgWatch.frames * 1000 / (now - dbgWatch.at));
    dbgWatch.frames = 0; dbgWatch.at = now;
  }
  const cam = viewer.camera, cc = cam.positionCartographic, deg = Cesium.Math.toDegrees;
  $('dbgFps').textContent = dbgWatch.fps ? String(dbgWatch.fps) : '…';
  $('dbgCanvas').textContent = viewer.canvas.width + '×' + viewer.canvas.height + ' px · DPR ' +
    (window.devicePixelRatio || 1);
  $('dbgCam').textContent = deg(cc.latitude).toFixed(6) + ', ' + deg(cc.longitude).toFixed(6) +
    ' · +' + cc.height.toFixed(1) + ' м';
  $('dbgAngles').textContent = 'курс ' + ((deg(cam.heading) + 360) % 360).toFixed(0) +
    '° · наклон ' + deg(cam.pitch).toFixed(0) + '° · крен ' + deg(cam.roll).toFixed(0) + '°';
  // FOV показываем тот же, что у слайдера и чипа (угол конуса frustum.fov), иначе в панели
  // одно число, а настройка другой величины
  $('dbgFov').textContent = cam.frustum.fov === undefined ? '—' : deg(cam.frustum.fov).toFixed(0) + '°';
}

/* ——— переходы вида из меню: те же функции, что у сегмента вида и кнопки «сплит» ——— */
function setView(mode, split) {
  if (NO_GL && mode !== '2d') { toast('3D недоступен: нет WebGL'); return; }
  if (mode === '3d' && split !== null) App.split = split;   // «3D» и «сплит» отличаются только this
  setMode(mode);                                            // сам вызывает applyViewClasses
  closeMenus();
}
$('mi3d').onclick = () => setView('3d', false);
$('miSplit').onclick = () => setView('3d', true);
$('mi2d').onclick = () => setView('2d', null);
$('miOrbit').onclick = () => { if (cameraController) cameraController.setMode('orbit'); closeMenus(); };
$('miFly').onclick = () => { if (cameraController) cameraController.setMode('fly'); closeMenus(); };
$('miOrtho').onclick = () => { setBase('ortho'); closeMenus(); };
$('miQgis').onclick = () => { setBase('qgis'); closeMenus(); };
$('miQLow').onclick = () => { setQuality('light'); closeMenus(); };
$('miQMid').onclick = () => { setQuality('normal'); closeMenus(); };
$('miQHigh').onclick = () => { setQuality('detail'); closeMenus(); };
$('miTut').onclick = () => { closeMenus(); tutShow(); };

/* ——— тач-полёт (N2): виртуальный джойстик движения и кнопки высоты/бега ——— */
const STICK_R = 38;                        // радиус, при котором ручка упирается в край базы
(function bindStick() {
  const stick = $('stick'), knob = stick.querySelector('.knob');
  let cx = 0, cy = 0, id = null;
  const move = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
    knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    if (cameraController) cameraController.setStick(dx / STICK_R, -dy / STICK_R);
  };
  stick.addEventListener('pointerdown', e => {
    e.preventDefault();
    id = e.pointerId;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    stick.setPointerCapture(id);
    stick.classList.add('drag');               // база становится сплошной: палец «на ручке»
    move(e.clientX - cx, e.clientY - cy);
  });
  stick.addEventListener('pointermove', e => { if (id === e.pointerId) move(e.clientX - cx, e.clientY - cy); });
  const stop = e => {
    if (id !== e.pointerId) return;
    id = null;
    stick.classList.remove('drag');
    knob.style.transform = '';
    if (cameraController) cameraController.setStick(0, 0);
  };
  stick.addEventListener('pointerup', stop);
  stick.addEventListener('pointercancel', stop);
})();
/* высоту держат пальцем: ↑ и ↓ работают, пока нажаты; «бег» — переключатель ×4 */
function holdFlyButton(id, value) {
  const b = $(id);
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (cameraController) cameraController.setVertical(value);
  });
  const off = () => { if (cameraController) cameraController.setVertical(0); };
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('pointerleave', off);
}
holdFlyButton('flyUp', 1);
holdFlyButton('flyDown', -1);
$('flyRun').onclick = () => {
  const on = $('flyRun').classList.toggle('on');
  if (cameraController) cameraController.setRun(on);
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
  /* Верхний уровень набора: по имени, а для отладочного ?tiles= — по URL. Неизвестный
     набор считаем отстающим (z22): тайлов z23 в нём может не быть, а просить их — значит
     получить 404 и дырки в подложке. */
  TILES_ZMAX = listOverride
    ? (/\/tiles\/$/.test(url) ? BASE_ZMAX.ortho : BASE_ZMAX.qgis)
    : (BASE_ZMAX[name] ?? BASE_ZMAX.qgis);
  window.TILES_ZMAX = TILES_ZMAX;
  if (viewer) {
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(makeProvider());
  }
  if (App.plan) App.plan.clearTiles();
  $('chOrtho').classList.toggle('on', name === 'ortho');
  $('chQgis').classList.toggle('on', name === 'qgis');
  baseState();
  syncMenus();                                // подложка в меню шестерёнки повторяет поповер «вид»
  if (viewer && !viewer.scene.globe.show) toast('подложка видна в 2D или при выключенных model/Splat');
  return true;
}
$('chOrtho').onclick = () => setBase('ortho');
$('chQgis').onclick = () => setBase('qgis');

/* ——— model/Splat: один видимый ресурс, Splat загружается по требованию (ADR-26) ——— */
const ASSET_CFG = {
  tileset: { label: '3D-модель', loadingLabel: '3D-модели', urls: [TILESET], button: 'chModel', flag: 'nomodel' },
  splats: { label: 'Splat', loadingLabel: 'Splat', urls: SPLAT_CANDIDATES, button: 'chSplats', flag: 'nosplat' },
};
const assetUrlCache = { tileset: undefined, splats: undefined };
const assetPromises = { tileset: null, splats: null };
let assetChoice = 0;

/* tileLoadProgressEvent сообщает текущую очередь, а не процент от неизвестного заранее total. */
const chunkState = {
  tileset: { initial: false, pending: 0, lastProgress: 0 },
  splats: { initial: false, pending: 0, lastProgress: 0 },
};
let chunkUiLast = 0;
function chunkWord(n) {
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
    hidePerfNotice('network');
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
function setAssetLoading(slot, loading) {
  const state = chunkState[slot];
  state.initial = loading;
  state.lastProgress = performance.now();
  if (!loading && !viewer[slot]) state.pending = 0;
  updateChunkUI(true);
}
/* Очередь чанков. В Cesium 1.147 у публичного Cesium3DTileset НЕТ tileLoadProgressEvent:
 * он остался только у Globe и у внутреннего провайдера. Подписка на него падала с
 * TypeError ещё до primitives.add — модель и Splat не загружались вообще (найдено
 * вживую 25.11 в Chrome владельца). Публичный API 1.147: события tileLoad / tileFailed /
 * initialTilesLoaded / allTilesLoaded и счётчик statistics, из которого и берём очередь.
 * Подписка на tileLoadProgressEvent оставлена веткой для Cesium до 1.147. */
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
function syncChunkQueues() {
  for (const slot of Object.keys(chunkState)) {
    const ts = viewer && viewer[slot];
    const st = chunkState[slot];
    if (!ts || !ts.statistics) continue;
    const q = Math.max(0, (ts.statistics.numberOfTilesProcessing || 0) + (ts.statistics.numberOfPendingRequests || 0));
    if (q !== st.pending) { st.pending = q; st.lastProgress = performance.now(); }
  }
}
function clearChunkLoading() {
  for (const state of Object.values(chunkState)) {
    state.initial = false; state.pending = 0; state.lastProgress = 0;
  }
  updateChunkUI(true);
}
setInterval(() => {
  syncChunkQueues();
  const now = performance.now();
  const stalled = Object.values(chunkState).some(state =>
    (state.initial || state.pending > 0) && now - state.lastProgress >= 12000);
  if (stalled) showPerfNotice('network');
  updateChunkUI();
}, 1000);

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
  setAssetLoading(slot, true);
  const promise = (async () => {
    const url = await resolveAssetUrl(slot);
    if (!url) throw new Error('файл не найден');
    const ts = await withTimeout(Cesium.Cesium3DTileset.fromUrl(url), 20000);
    flattenTileset(ts);
    ts.maximumScreenSpaceError = QUALITY_PRESETS[qualityMode][slot];
    ts.skipLevelOfDetail = true;
    // preloadSiblings/preloadAncestors в 1.147 у публичного тайлсета нет (проверено на живом
    // Cesium: 'preloadSiblings' in ts === false) — присваивание молча создавало мёртвое поле
    if ('cullWithParentBounds' in ts) ts.cullWithParentBounds = true;
    if (slot === 'splats' && 'pickable' in ts) ts.pickable = false;
    ts.show = false;
    viewer.scene.primitives.add(ts);
    viewer[slot] = ts;
    watchChunkLoading(slot, ts);   // индикатор навешиваем после добавления: его сбой не отменяет загрузку
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
    setAssetLoading(slot, false);
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
    /* взаимоисключение применяется ДО загрузки: пока Splat грузится, модель уже скрыта —
     * иначе в момент загрузки видны оба ресурса друг поверх друга (аудит B-2) */
    for (const other of Object.keys(ASSET_CFG)) if (other !== slot && viewer[other]) viewer[other].show = false;
    syncGlobeVisibility();
    const ts = await ensureAsset(slot);
    if (choice !== assetChoice) return;
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

/* ——— UI двух режимов камеры (ADR-28) ——— */
function updateCameraState(state) {
  document.body.dataset.cameraMode = state.mode;
  const fly = state.mode === 'fly';
  for (const [id, on] of [['orbitBtn', !fly], ['flyBtn', fly]]) {
    const b = $(id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('cameraMode').hidden = state.touch || App.mode !== '3d' || NO_GL;
  // на таче строка-подсказка не показывается: жесты только через «Обучение · жесты» (U2)
  $('camTag').hidden = state.touch || App.mode !== '3d';
  $('camTag').textContent = state.touch
    ? (fly ? CAM_TAG_TOUCH.fly : CAM_TAG_TOUCH.orbit)
    : fly
      ? 'Полёт · ПКМ — обзор · WASD/QE — движение · Shift — быстрее · колесо — скорость · Esc — осмотр'
      : 'Осмотр · ЛКМ — вращение · ПКМ — сдвиг · 2×ЛКМ — центр · колесо — дистанция · R — исходный вид';
  // тач-полёт (N2): джойстик и кнопки высоты нужны только в 3D-полёте на тач-устройстве
  document.body.classList.toggle('flytouch', fly && CAMERA_TOUCH && App.mode === '3d' && !NO_GL);
  $('speedTag').hidden = !fly || state.touch || App.mode !== '3d';
  $('speedValue').textContent = (state.speed < 10 ? state.speed.toFixed(1) : String(Math.round(state.speed))) + ' м/с';
  syncMenus();
}
$('orbitBtn').onclick = () => {
  if (cameraController) { cameraController.setMode('orbit'); viewer.canvas.focus({ preventScroll: true }); }
};
$('flyBtn').onclick = () => {
  if (cameraController) { cameraController.setMode('fly'); viewer.canvas.focus({ preventScroll: true }); }
};

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
  if (App.mmPlan) App.mmPlan.setFeatures(out, style);   // мини-карта рисует те же объекты
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
/* Квад фрустума на план: пересечение угловых лучей с плоскостью земли (не с эллипсоидом —
 * pickEllipsoid не даёт точки на лучах, почти параллельных земле, поэтому на горизонте квад
 * пропадал, а при широком FOV вырождался). Лучи вверх/почти горизонтальные клампим на
 * FRUSTUM_RANGE: на плане это сектор «куда смотрит камера» фиксированной дальности. */
const FRUSTUM_RANGE = 200;               // м: предел дальности точки квада от камеры
function frustumQuad() {
  if (!viewer) return null;
  const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight, pts = [];
  const cam = viewer.camera;
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cam.position);
  const groundPt = Cesium.Cartesian3.add(cam.position,
    Cesium.Cartesian3.multiplyByScalar(normal, -cam.positionCartographic.height, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const plane = Cesium.Plane.fromPointNormal(groundPt, normal);
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const ray = cam.getPickRay(new Cesium.Cartesian2(x, y));
    let t = FRUSTUM_RANGE;
    const hit = ray && Cesium.IntersectionTests.rayPlane(ray, plane);
    if (hit) {
      const d = Cesium.Cartesian3.distance(cam.position, hit);
      if (d > 0 && d < FRUSTUM_RANGE) t = d;
    }
    const p = Cesium.Ray.getPoint(ray, t, new Cesium.Cartesian3());
    const cg = Cesium.Cartographic.fromCartesian(p);
    pts.push([Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)]);
  }
  return pts;
}
function panMain(dLon, dLat) {
  if (cameraController) cameraController.panByGround(dLon, dLat);
}
/* Конец луча взгляда (N5, с 26.11 — ADR-33): из центра камеры по направлению ВСЕГДА
 * рейкастом по печной сетке коллизии (collision.js, ADR-13). Причина замены: у Splat своей
 * коллизии нет (pickable=false), pickFromRay по нему промахивается всегда, и в vendored
 * Cesium 1.147 pick-проход сломан — линия на плане ни с чем не пересекалась. Кадр ENU —
 * в (originLon, originLat) сетки; отметки ячеек — метры над эллипсоидом в кадре ADR-2,
 * та же система, что и высота камеры. Промах за RAY_MAX — отсечка, на плане пунктир без
 * дистанции. dist — прямая 3D от камеры до точки удара (метры), план подписывает её 0.1 м. */
const RAY_MAX = 300;                       // м: предел дальности луча
const RAY_MS = 250;
const rayCache = { at: 0, end: null, dist: null };
function invalidateRay() { rayCache.at = 0; rayCache.end = null; rayCache.dist = null; }
let collEnu = null, collEnuInv = null;
function collisionEnu() {
  if (!Collision.grid) return null;
  if (!collEnu) {
    const m = Collision.grid.meta;
    collEnu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(m.originLon, m.originLat));
    collEnuInv = Cesium.Matrix4.inverse(collEnu, new Cesium.Matrix4());
  }
  return collEnu;
}
function rayEnd() {
  if (!viewer) return null;
  const now = performance.now();
  if (rayCache.end && now - rayCache.at < RAY_MS) return rayCache.end;
  const cam = viewer.camera;
  let p = null, dist = null;
  if (collisionEnu()) {
    const o = Cesium.Matrix4.multiplyByPoint(collEnuInv, cam.position, new Cesium.Cartesian3());
    const d = Cesium.Matrix4.multiplyByPointAsVector(collEnuInv, cam.direction, new Cesium.Cartesian3());
    const hit = Collision.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, RAY_MAX);
    if (hit) {
      p = Cesium.Matrix4.multiplyByPoint(collEnu, new Cesium.Cartesian3(hit.e, hit.n, hit.u), new Cesium.Cartesian3());
      dist = hit.dist;
    } else {
      p = Cesium.Ray.getPoint(new Cesium.Ray(cam.position, cam.direction), RAY_MAX, new Cesium.Cartesian3());
    }
  } else {
    p = Cesium.Ray.getPoint(new Cesium.Ray(cam.position, cam.direction), FRUSTUM_RANGE, new Cesium.Cartesian3());
  }
  const cg = Cesium.Cartographic.fromCartesian(p);
  rayCache.at = now;
  rayCache.end = [Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)];
  rayCache.dist = dist;
  return rayCache.end;
}
function syncPlans() {
  const split = document.body.classList.contains('split3d');
  const mini = document.body.classList.contains('full3d');
  if (!App.plan && !App.mmPlan) return;
  if ((split && App.plan && App.plan.busy) || (mini && App.mmPlan && App.mmPlan.busy)) return;
  const [lon, lat] = camGround();
  // высота над землёй в кадре ADR-2 (эллипсоид − GROUND_H): выше лимита квад фрустума
  // не шлём — на плане остаётся только маркер камеры (PLAN-ui-polish D1)
  const hAg = viewer ? viewer.camera.positionCartographic.height : 0;
  const cam = { lon, lat, heading: viewer ? viewer.camera.heading : 0,
    quad: hAg <= FRUSTUM_MAX_H ? frustumQuad() : null, rayEnd: rayEnd(), rayDist: rayCache.dist };
  // сплит: план справа живёт центром камеры; полноэкранный 3D: та же камера уходит в мини-карту (N3)
  if (split && App.plan) {
    App.plan.setCamera(cam);
    if (App.plan.follow) App.plan.setViewCenter(lon, lat); else App.plan.draw();
  }
  if (mini && App.mmPlan) {
    App.mmPlan.setCamera(cam);
    App.mmPlan.setViewCenter(lon, lat);
  }
}
function makePlan(canvas, opts) {
  const p = new PlanPane(canvas, [], Object.assign({
    center: camGround(), mpp: 0.35,
    // drag плана независим от 3D: камеру двигает только тап (N4), readout перерисовываем всегда
    onView: () => { updateReadout(); },
    onTapGround: geo => {
      // перенос камеры по тапу — только в сплите (N4); в чистом 2D тап лишь выделяет объект
      if (!geo || !cameraController || !document.body.classList.contains('split3d')) return;
      const [lon, lat] = geo;
      // в осмотре тап плавно переносит точку орбиты, в полёте — позицию камеры
      if (cameraController.mode === 'fly') {
        const [clon, clat] = camGround();
        panMain(lon - clon, lat - clat);
      } else cameraController.focusAtGround(lon, lat);
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
  /* мини-карта полноэкранного 3D (N3): радар — камера в центре, drag выключен,
   * масштаб по ширине участка (fit ставит стартовый mpp) */
  if (!App.mmPlan && !NO_GL) {
    App.mmPlan = makePlan($('mmc'), { radar: true, follow: false, rotOn: true, maxViewM: MAX_VIEW_M,
      onView: () => {}, onPick: () => {}, onTapGround: undefined });
    App.mmPlan.resize();
    App.mmPlan.fit(rect);                 // стартовый mpp: весь участок в 132–190 px
  }
}

/* ——— координаты центра плана и масштаб, привязанный к сетке тайлов ———
 * Шаг — мантисса 1/2/5 × 10ⁿ метров: на зумах с видимой сеткой линейка совпадает с клетками
 * тайлов (z21 ≈ 10,8 м ≈ 10 м). Ширина бара честная (метры/mpp), без обрезки, и при этом
 * всегда влезает в кадр: ряд шагов доходит до 10 см, иначе на дальнем зуме плана (1 см/px,
 * тайлы z23) десятиметровый шаг растягивал бы линейку на полтысячи пикселов. */
const FRUSTUM_MAX_H = 25;                 // м над землёй: выше квад фрустума не рисуем
function scaleForMpp(mpp) {
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
  dbgWatch.frames++;                          // FPS считается по всем кадрам, отбор — только для строк
  if (App.mode === '3d') syncPlans();
  if (++frames % 6 === 0) { updateReadout(); updateDbg(); }
});
/* камера → план: дублируем postRender событием changed — postRender молчит, пока кадр не
 * отрисован (в том числе на притормозившем рендере), а changed ловит именно движение камеры */
if (viewer) {
  viewer.camera.percentageChanged = 0.01;
  viewer.camera.changed.addEventListener(() => { if (App.mode === '3d') syncPlans(); });
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (cameraController && cameraController.mode === 'fly') cameraController.setMode('orbit');
  select(null);
  tutHide();
});

/* ——— обучение (PLAN-ui-polish D3): оверлей первого визита вместо вечных плашек.
 * Контент по типу указателя: клавиатура+мышь или жесты — никогда оба сразу. ——— */
const TUT_SEEN = 'mam.tut';
const TUT_TOUCH = CAMERA_TOUCH;
const kbd = l => `<span class="k">${l}</span>`;
const MOUSE_WHEEL = `<svg width="34" height="50" viewBox="0 0 34 50" fill="none" aria-hidden="true">
  <rect x="2" y="2" width="30" height="46" rx="14" stroke="currentColor" stroke-width="1.6" opacity=".8"/>
  <rect x="13" y="9" width="8" height="14" rx="4" stroke="currentColor" stroke-width="1.4"/>
  <path d="M11 4l6-5 6 5" stroke="var(--acc,#ffb020)" stroke-width="1.6" fill="none"/>
  <path d="M11 38l6 5 6-5" stroke="var(--acc,#ffb020)" stroke-width="1.6" fill="none"/></svg>`;
const MOUSE_ORBIT = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
  <path d="M7 20l5-6 5 6M40 20l5-6 5 6M7 32l5 6 5-6M40 32l5 6 5-6" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="19" y="12" width="14" height="28" rx="7" stroke="currentColor" stroke-width="1.6" opacity=".85"/>
  <rect x="23.5" y="17" width="5" height="9" rx="2.5" stroke="currentColor" stroke-width="1.3"/></svg>`;
const G_DRAG = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="24" cy="22" r="7" stroke="currentColor" stroke-width="1.6"/>
  <path d="M7 22h10M31 22h10M12 17l-5 5 5 5M36 17l5 5-5 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_PINCH = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="17" cy="17" r="6" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="31" cy="17" r="6" stroke="currentColor" stroke-width="1.6"/>
  <path d="M17 32H9M13 27l-5 5 5 5M31 32h8M35 27l5 5-5 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_TAP = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="24" cy="26" r="5" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="24" cy="26" r="11" stroke="var(--acc,#ffb020)" stroke-width="1.2" opacity=".5"/>
  <path d="M24 5v6M15 8l3 5M33 8l-3 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
/* жесты телефона (U3): двойной тап, сброс ракурса, свайп взгляда и джойстик полёта */
const G_TAP2 = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="16" cy="26" r="5" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="16" cy="26" r="10" stroke="currentColor" stroke-width="1.1" opacity=".4"/>
  <circle cx="34" cy="26" r="5" stroke="var(--acc,#ffb020)" stroke-width="1.6"/>
  <circle cx="34" cy="26" r="10" stroke="var(--acc,#ffb020)" stroke-width="1.2" opacity=".55"/>
  <path d="M34 6v5M27 9l3 4M41 9l-3 4" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const G_HOME = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <path d="M13 24 23 15l10 9" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16 22v11h14V22" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M40 10a9 9 0 1 0 3 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M43 6v6h-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_SWIPE = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <path d="M9 31c9-16 21-16 29-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 4"/>
  <circle cx="9" cy="31" r="5" stroke="currentColor" stroke-width="1.6"/>
  <path d="M31 22l7 6-7 6" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_STICK = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="18" cy="22" r="13" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 4"/>
  <circle cx="23" cy="16" r="6" stroke="var(--acc,#ffb020)" stroke-width="1.8"/>
  <path d="M39 11v22M34 16l5-5 5 5M34 28l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_FAB = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="35" cy="10" r="7" stroke="var(--acc,#ffb020)" stroke-width="1.8"/>
  <circle cx="35" cy="26" r="7" stroke="currentColor" stroke-width="1.6"/>
  <path d="M6 10h16M6 26h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/></svg>`;
function tutBuild() {
  const items = TUT_TOUCH ? [
    { g: G_DRAG, c: 'Осмотр', s: 'один палец — вращение' },
    { g: G_PINCH, c: 'Сдвиг и масштаб', s: 'два пальца' },
    { g: G_TAP2, c: 'Точка орбиты', s: '2×тап по 3D-виду' },
    { g: G_HOME, c: 'Исходный вид', s: '⌂ в меню камеры' },
    { g: G_FAB, c: 'Сменить вид', s: 'круглые кнопки справа вверху' },
    { g: G_SWIPE, c: 'Полёт: взгляд', s: 'свайп по 3D, кроме кнопок' },
    { g: G_STICK, c: 'Полёт: движение', s: 'джойстик · ↑↓ высота · ×4 бег' },
  ] : [
    { g: MOUSE_ORBIT, c: 'Осмотр', s: 'ЛКМ — вращение' },
    { g: G_DRAG, c: 'Полёт', s: 'кнопка внизу' },
    { g: `<span class="tut-keys"><span class="row"></span><span class="row">${kbd('W')}</span><span class="row">${kbd('A')}${kbd('S')}${kbd('D')}</span></span>`, c: 'Движение', s: 'в режиме полёта' },
    { g: `<span class="row">${kbd('Q')}${kbd('E')}</span>`, c: 'Высота', s: 'Q / E' },
    { g: MOUSE_WHEEL, c: 'Масштаб / скорость', s: 'осмотр / полёт' },
    { g: G_TAP, c: 'Точка орбиты', s: 'двойной клик' },
    { g: `<span class="k wide">Shift</span>`, c: 'Быстрее', s: 'в полёте' },
    { g: kbd('R'), c: 'Исходный вид', s: 'сброс ракурса' },
  ];
  $('tutSub').textContent = TUT_TOUCH ? '3D и 2D · жесты' : '3D · осмотр и полёт';
  $('tutGrid').innerHTML = items.map(i =>
    `<div class="tut-item"><div>${i.g}</div><div class="cap">${i.c}<small>${i.s}</small></div></div>`).join('');
}
function tutShow() {
  tutBuild();
  if (cameraController) cameraController.setLocked(true);
  $('tut').hidden = false;
}
function tutHide() {
  if ($('tut').hidden) return;
  $('tut').hidden = true;
  if (cameraController) cameraController.setLocked(false);
  try { localStorage.setItem(TUT_SEEN, '1'); } catch (e) {}
}
function tutSeen() { try { return localStorage.getItem(TUT_SEEN) === '1'; } catch (e) { return true; } }
$('tutOk').addEventListener('click', tutHide);
$('tut').addEventListener('click', e => { if (e.target === $('tut')) tutHide(); });
$('tutBtn').addEventListener('click', tutShow);
if (!tutSeen()) setTimeout(tutShow, 500);

/* ——— ресайз: Cesium и canvas-планы живут в одной сетке.
 * Наблюдаем за каждым контейнером отдельно: в ?nogl у #map display:none, его размер не меняется,
 * и наблюдатель только за #map никогда не дёргал план, когда менялось окно (баг 22.11: буфер
 * канваса отставал от CSS-бокса, карта оказывалась обрезана и растянута до первого клика). ——— */
const ro = new ResizeObserver(() => {
  if (viewer) viewer.resize();
  if (App.plan) App.plan.resize();
  if (App.mmPlan) App.mmPlan.resize();
});
for (const id of ['map', 'plan', 'mm']) if ($(id)) ro.observe($(id));
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
  setFov(FOV_DEFAULT); moveThumb();
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
  /* печная сетка коллизии (ADR-13/33): 221 КБ, нужна лучу плана; отсутствие не ломает
   * приложение — без неё rayEnd откатывается на старую отсечку (collision.js: error) */
  if (!Q.has('nocol')) await Collision.load('./collision/collision.json', './collision/collision.bin');
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
