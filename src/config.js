/* что здесь живёт: константы приложения — экстент, кадры высот, подложка, камера, ключи хранилища, флаги адресной строки. */
/* config.js — константы приложения: экстент полигона, кадры высот, подложка, камера, ключи хранилища, флаги адресной строки. Чистые данные и геометрия, нет рендер-логики. */
export const EXTENT = { w: 37.479587839, s: 55.672218962, e: 37.482130196, n: 55.673727617 };
export const rect = Cesium.Rectangle.fromDegrees(EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n);
// Кадр высот (ADR-2): реальная высота − GROUND_H. Все Metashape-данные живут в этом кадре.
export const GROUND_H = 188;
// Подложка лежит на −BASE_DROP метров ниже эллипсоида (решение владельца 22.11).
export let BASE_DROP = 6;
// BASE_DROP меняет только fitBasemapDrop: импорт import-связи read-only, поэтому через сеттер.
export function setBaseDrop(value) { BASE_DROP = value; }
export const SITE_CENTER = Cesium.Cartesian3.fromDegrees((EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2, GROUND_H);
export const ENU = Cesium.Transforms.eastNorthUpToFixedFrame(SITE_CENTER);
// Сдвиг тайлсета в кадр высот приложения (сцена уже Z-up, нужен только перенос кадра).
export function flattenTileset(ts) {
  const shift = Cesium.Matrix4.multiplyByPointAsVector(ENU, new Cesium.Cartesian3(0, 0, -GROUND_H), new Cesium.Cartesian3());
  ts.modelMatrix = Cesium.Matrix4.fromTranslation(shift);
}
// Растр: орто / QGIS. QGIS-тайлы ищутся в репо и в корне данных (ADR-7).
export const TILES_Q = new URLSearchParams(location.search).get('tiles');
export const BASES = { ortho: ['./tiles/'], qgis: ['./tiles_qgis/', '../tiles_qgis/'] };
export const BASE_PROBES = ['15/19795/10256.png', '18/158364/82054.png', '20/633459/328218.png'];
// Сетка растровой подложки: z15–z23 (ADR-30). «Схема» пока отстаёт — верхний уровень z22.
export const TILE_ZMIN = 15, TILE_ZMAX = 23;
export const BASE_ZMAX = { ortho: TILE_ZMAX, qgis: 22 };
// Провайдер подложки и проработка базы (ADR-7). Текущий набор — в TILE_SOURCE: его меняет
// setBase, его же читает 2D-план через window.* (план рисует тайлы сам, импортов не имеет).
export const TILE_SOURCE = { base: './tiles_qgis/', zmax: BASE_ZMAX.qgis };   // стартовый — «Схема»
export function setTileSource(base, zmax) {
  TILE_SOURCE.base = base;
  TILE_SOURCE.zmax = zmax;
  window.TILES_BASE = base;
  window.TILES_ZMAX = zmax;
}
export function makeProvider(zmax = TILE_SOURCE.zmax) {
  return new Cesium.UrlTemplateImageryProvider({
    url: TILE_SOURCE.base + '{z}/{x}/{y}.png',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256, tileHeight: 256, minimumLevel: TILE_ZMIN, maximumLevel: zmax,
    rectangle: rect,
  });
}
export async function resolveBase(list) {
  for (const u of list)
    for (const p of BASE_PROBES)
      try { const r = await fetch(u + p, { method: 'HEAD' }); if (r.ok) return u; } catch (e) {}
  return null;
}
export const TILESET = './3dtiles/tileset.json';
export const SPLATS = new URLSearchParams(location.search).get('splats');
export const SPLAT_CANDIDATES = SPLATS ? [SPLATS] : ['./splat/tileset.json', './splats/tileset.json'];
// Публичный MVP: векторные слои и GPKG выключены полностью (ADR-27).
export const SHOW_VECTOR_LAYERS = false;
// Стили слоёв gpkg (те же, что в v1; план получает их для окраски).
export const GPK_STYLE = {
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
// Домашняя позиция и настройки камеры (значения сняты с панели дебага по указанию владельца 26.11).
export const HOME_POSE = { lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2, roll: 0 };
export const FOV_DEFAULT = 86;       // °, вертикальный FOV по умолчанию
export const MAX_VIEW_M = 320;       // ширина кадра по земле на максимальном отдалении, м
// Ключи хранилища.
export const VIEW_KEY = 'mam.view';
export const FOV_KEY = 'mam.fov';
export const DBG_KEY = 'mam.dbg';
export const TUT_SEEN = 'mam.tut';
export const QUALITY_KEY = 'mam.quality';
export const Q = new URLSearchParams(location.search);
// Флаги адресной строки читаются по месту: ?nogl ?nosplat ?nomodel ?nocol ?tiles ?splats ?failrender ?mobile.
// Окружение устройства.
export const CAMERA_TOUCH = matchMedia('(pointer: coarse)').matches;
export const CAMERA_REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
export const STICK_R = 38;                       // px: радиус стика — по нему считается наклон «педали»

// Пресеты качества 3D (ADR-29/30): экранная погрешность тайлсета/сплатов. Подложка при этом
// всегда стоит на BASEMAP_SSE — качество 3D на растр не влияет (решение владельца 22.11).
export const QUALITY_PRESETS = {
  light:  { tileset: 48, splats: 64 },
  normal: { tileset: 24, splats: 32 },
  detail: { tileset: 12, splats: 16 },
};
export const BASEMAP_SSE = 4;            // подложка всегда максимально детальна (тайлы z15–z23, ADR-30)

/* model/Splat — один видимый ресурс (ADR-26): row — id строки меню «Вид», flag — выключатель
   адресной строки, loadingLabel — как ресурс называется в индикаторе чанков. */
export const ASSET_CFG = {
  tileset: { label: '3D-модель', loadingLabel: '3D-модели', urls: [TILESET], row: 'miAssetModel', flag: 'nomodel',
    title: 'показать 3D-модель вместо Splat' },
  splats: { label: 'Gaussian Splatting', loadingLabel: 'Gaussian Splatting', urls: SPLAT_CANDIDATES, row: 'miAssetSplat', flag: 'nosplat',
    title: 'загрузить и показать Splat вместо 3D-модели' },
};

// Квад фрустума над 2D-планом: выше этой отметки над землёй его не рисуем (плоский план, не сфера).
export const FRUSTUM_MAX_H = 25;
// Центр участка в градусах: запасной центр плана, когда камеры ещё нет.
export const SITE_MID = [(EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2];

/* Домашний вид (значения сняты с панели дебага по указанию владельца 26.11). Точку цели орбиты
   вдоль направления взгляда строит сам rig (_deriveTarget в src/camera/rig.js) — здесь только
   позиция: своя версия цели здесь расходилась с rig'ом и никем не вызывалась. */
export function homePosition() { return Cesium.Cartesian3.fromDegrees(HOME_POSE.lon, HOME_POSE.lat, HOME_POSE.h); }
