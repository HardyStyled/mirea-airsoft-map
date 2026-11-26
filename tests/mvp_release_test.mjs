import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const camera = read('camera.js');
const css = read('ui.css');
const plan = read('plan.js');
let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result !== true) throw new Error(result === false ? 'assertion' : 'не независимый boolean');
    passed++; console.log('PASS', name);
  } catch (e) { failed++; console.error('FAIL', name, '—', e.message); }
}
function hasId(id) {
  return html.includes('id="' + id + '"');
}

check('MVP не загружает editor.js', () => !/<script[^>]+editor\.js/.test(html));
check('fallback не предлагает выбор объектов', () =>
  !/function noGlNotice[\s\S]*?выбирать объекты/.test(app));
check('стартовая подложка — Схема QGIS, орто называется Орто-подложка (I1: выбор в меню)', () =>
  /let TILES_BASE = '\.\/tiles_qgis\/'/.test(app) &&
  /id="miQgis" role="menuitemradio" aria-checked="true"/.test(html) &&
  /id="miOrtho" role="menuitemradio" aria-checked="false"/.test(html) &&
  /Схема/.test(html) && /Орто-подложка/.test(html) &&
  /\$\('miOrtho'\)\.onclick[\s\S]*?setBase\('ortho'\)/.test(app) &&
  /\$\('miQgis'\)\.onclick[\s\S]*?setBase\('qgis'\)/.test(app));
check('MVP не загружает GPKG/sqljs и не рисует векторные слои', () =>
  !/<script[^>]+(?:gpkg\.js|sql-wasm\.js)/.test(html) &&
  /const SHOW_VECTOR_LAYERS = false/.test(app) && /if \(SHOW_VECTOR_LAYERS\) \{[\s\S]*?fetchArrayBuffer/.test(app));
check('панель слоёв и редактор отсутствуют в DOM', () =>
  !/id=["'](?:layers|rail|chEdit|editBtn|apply|cancel|openGpkg|gpkgFile|exp)["']/.test(html));
check('ID уникальны', () => {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  return ids.length === new Set(ids).size;
});
check('все обращения $() разрешаются в существующие ID', () => {
  const refs = [...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  const missing = [...new Set(refs.filter(id => !hasId(id)))];
  if (missing.length) throw new Error(missing.join(', '));
  return true;
});
check('физика ходьбы и pointer lock не возвращаются в runtime', () =>
  !/(?:startWalk|stopWalk|walkTick|requestPointerLock|App\.walk)/.test(app + camera));
/* ADR-33 (26.11): прежнее «collision не в runtime» заменено контрактом — сетка ADR-13
 * грузится и питает луч плана; физики ходьбы по-прежнему нет. */
check('луч плана всегда рейкастит по печной сетке коллизии, pickFromRay из runtime убран (ADR-33)', () =>
  /<script src="collision\.js\?v=\d+"><\/script>/.test(html) &&
  /Collision\.load\('\.\/collision\/collision\.json', '\.\/collision\/collision\.bin'\)/.test(app) &&
  /Collision\.grid\.raycast\(/.test(app) &&
  /const RAY_MAX = 300/.test(app) &&
  !/scene\.pickFromRay/.test(app));
check('дистанция луча: 3D-метры в кэш луча, подпись 0.1 м только на большом плане (ADR-33)', () =>
  /rayCache = \{ at: 0, end: null, dist: null \}/.test(app) &&
  /rayEnd: rayEnd\(\), rayDist: rayCache\.dist/.test(app) &&
  /typeof this\.cam\.rayDist === 'number'/.test(plan) &&
  /dist\.toFixed\(1\) \+ ' м'/.test(plan) &&
  /dist !== null && !this\.radar/.test(plan) &&
  /if \(dist === null\) ctx\.setLineDash\(\[5, 4\]\)/.test(plan));
check('кэш луча инвалидируется при смене вида и сбросе камеры', () =>
  /function invalidateRay\(\) \{ rayCache\.at = 0; rayCache\.end = null; rayCache\.dist = null; \}/.test(app) &&
  /function applyViewClasses\(\) \{\r?\n  invalidateRay\(\)/.test(app) &&
  /cameraController\.reset\(\);\r?\n  invalidateRay\(\)/.test(app));
check('CameraController загружен до app.js и создан для живого viewer', () =>
  /<script src="camera\.js\?v=(?:[3-9]|\d{2,})"><\/script>\s*<script src="app\.js/.test(html) &&
  /new CameraController\(/.test(app) && /App\.cameraController = cameraController/.test(app));
check('экранные режимы камеры явные и доступны с клавиатуры', () =>
  /<button class="mi on" id="miOrbit" role="menuitemradio" aria-checked="true"/.test(html) &&
  /<button class="mi" id="miFly" role="menuitemradio" aria-checked="false"/.test(html) &&
  /<button class="fab" id="fabCam" data-tip="Камера" aria-label="Камера" aria-expanded="false">/.test(html) &&
  /Осмотр <span class="kbd">V<\/span>/.test(html) && /Полёт <span class="kbd">F<\/span>/.test(html) &&
  /k === 'v' && cameraController/.test(app) && /k === 'f' && cameraController/.test(app));
check('старые always-on обработчики и зависимость скорости от высоты удалены', () =>
  !/(?:freeKeys|freeLook|freeCameraTick|height \* 0\.12|cam\.moveForward)/.test(app));
check('новый контроллер содержит WASD/QE, R, Esc и два независимых wheel-поведения', () =>
  /KeyW[\s\S]*KeyA[\s\S]*KeyS[\s\S]*KeyD[\s\S]*KeyQ[\s\S]*KeyE/.test(camera) &&
  /r: 'KeyR'/.test(camera) && /e\.key === 'Escape'/.test(camera) &&
  /this\.speed = clamp[\s\S]*this\._dolly\(Math\.exp/.test(camera));
check('двойной клик использует raycast и прерываемый 400 мс focus без camera.flyTo', () =>
  /_pickWorld\(position\)/.test(camera) && /duration: this\.reducedMotion\(\) \? 0 : 400/.test(camera) &&
  /_focusAt\(\{ x: e\.clientX, y: e\.clientY \}\)/.test(camera) && !/camera\.flyTo/.test(camera));
check('переход через 2D сохраняет ракурс и не вызывает homeView', () => {
  const source = app.match(/function setMode\(m\) \{[\s\S]*?\n\}/)?.[0] || '';
  return /captureFor2D\(\)/.test(source) && /restoreFrom2D\(\)/.test(source) && !/homeView/.test(source);
});
check('model/Splat взаимоисключающие', () =>
  /for \(const other of Object\.keys\(ASSET_CFG\)\)[\s\S]*?viewer\[other\]\.show = false/.test(app));
check('Splat не загружается автоматически при старте', () =>
  /if \(!Q\.has\('nomodel'\)\) await toggleAsset\('tileset'\)/.test(app) &&
  !/await toggleAsset\('splats'\)/.test(app));
check('активный 3D-ресурс скрывает глобус', () => /viewer\.scene\.globe\.show = !hasAsset/.test(app));
check('переключение подложки отбрасывает устаревший ответ', () =>
  /const choice = \+\+baseChoice[\s\S]*?if \(choice !== baseChoice\) return false/.test(app));
check('failed HEAD не закрепляется как постоянный запрет ресурса', () =>
  /if \(found\) assetUrlCache\[slot\] = found;[\s\S]*?else assetUrlCache\[slot\] = undefined/.test(app));
check('отложенный GPKG reader имеет AbortController на headers и тело', () =>
  /async function fetchArrayBuffer[\s\S]*?new AbortController[\s\S]*?response\.arrayBuffer\(\)/.test(app) &&
  /fetchArrayBuffer\('\.\.\/map\/tactical\.gpkg', 10000\)/.test(app));
check('конструктор Viewer защищён fallback', () => /try \{\s*viewer = new Cesium\.Viewer/.test(app) && /catch \(e\) \{[\s\S]*?App\.noGlReason = 'Cesium/.test(app));
check('FOV отключён без WebGL', () => /\$\('fovSl'\)\.disabled = NO_GL/.test(app));
check('2D доступен с клавиатуры', () => /<canvas id="plan" tabindex="0"/.test(html) &&
  /addEventListener\('keydown'/.test(plan) && /ArrowLeft[\s\S]*ArrowRight[\s\S]*ArrowUp[\s\S]*ArrowDown/.test(plan) &&
  /e\.key === 'Enter'/.test(plan));
check('стартовая камера не добавляет GROUND_H повторно', () => {
  const fn = app.match(/function homePosition\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  return /destination: homePosition\(\)/.test(app) &&
    /fromDegrees\(HOME_POSE\.lon, HOME_POSE\.lat, HOME_POSE\.h\)/.test(fn) &&
    /const HOME_POSE = \{[^}]*h: 2\.3/.test(app) &&
    !/GROUND_H/.test(fn);
});
check('readout привязан к центру плана', () =>
  /const \[lon, lat\] = App\.plan\.center/.test(app) && /scaleForMpp\(App\.plan\.mpp\)/.test(app));
check('CSS показывает readout только с 2D', () =>
  /\.readout \{ display: none;/.test(css) &&
  /body\.split3d \.readout, body\.pure2d \.readout, body\.nogl \.readout \{ display: flex; \}/.test(css));
check('CSS не содержит //-комментариев', () => !/(?:^|})\s*\/\//.test(css));
check('ширина линейки не обрезается в CSS (честная пропорция)', () => !/#sbarBar \{[^}]*max-width/.test(css));

const scaleSource = app.match(/function scaleForMpp\(mpp\) \{[\s\S]*?\n\}/)?.[0];
check('чистая функция масштаба найдена', () => !!scaleSource);
const scaleForMpp = scaleSource ? new Function('return (' + scaleSource.replace('function scaleForMpp', 'function') + ')')() : null;
check('масштаб: px честные (метры/mpp) в диапазоне плана', () => {
  if (!scaleForMpp) return false;
  for (let exp = -2; exp <= 0; exp++) {           // mpp 0.01–4.99 — реальный зажим PlanPane
    for (const multiplier of [0.5, 1, 1.5, 2.37, 4.99]) {
      const mpp = multiplier * 10 ** exp;
      const scale = scaleForMpp(mpp);
      if (!Number.isFinite(scale.px) || !Number.isFinite(scale.meters) || scale.meters <= 0) {
        throw new Error('mpp=' + mpp + ' → ' + JSON.stringify(scale));
      }
      if (Math.abs(scale.px - scale.meters / mpp) > 1e-9) {
        throw new Error('нечестная ширина: mpp=' + mpp + ' → ' + JSON.stringify(scale));
      }
    }
  }
  return true;
});
check('масштаб: мантисса 1/2/5 и линейка влезает в кадр на всём зажиме плана', () => {
  if (!scaleForMpp) return false;
  for (let exp = -2; exp <= 1; exp++) {           // mpp 0.005–49.9 — зажим PlanPane (MIN_MPP 0.01, предел отдаления)
    for (const multiplier of [0.5, 1, 1.5, 2.37, 4.99]) {
      const mpp = multiplier * 10 ** exp;
      const { meters, px } = scaleForMpp(mpp);
      const mantissa = Math.round(meters / 10 ** Math.floor(Math.log10(meters)));
      if (![1, 2, 5].includes(mantissa)) throw new Error('mpp=' + mpp + ', meters=' + meters);
      if (px < 40 || px > 200) throw new Error('mpp=' + mpp + ' → px=' + px.toFixed(1) + ', meters=' + meters);
    }
  }
  return true;
});
check('масштаб на зуме тайловой сетки z21 остаётся десятиметровым', () => {
  if (!scaleForMpp) return false;
  return scaleForMpp(0.042).meters === 5 && scaleForMpp(0.084).meters === 10 && scaleForMpp(0.21).meters === 20;
});
check('некорректный mpp даёт безопасный fallback', () => {
  if (!scaleForMpp) return false;
  return [0, -1, NaN, Infinity, -Infinity].every(v => {
    const scale = scaleForMpp(v);
    return scale.meters === 10 && scale.px === 100;
  });
});
check('frustum: выше 25 м квад не рисуется, маркер остаётся', () =>
  /const FRUSTUM_MAX_H = 25;/.test(app) &&
  /hAg <= FRUSTUM_MAX_H \? frustumQuad\(\) : null/.test(app));
check('frustum: квад от плоскости земли с клампом дальности (не pickEllipsoid)', () =>
  /const FRUSTUM_RANGE = 200;/.test(app) &&
  /Cesium\.IntersectionTests\.rayPlane/.test(app) &&
  !/pickEllipsoid/.test(app.match(/function frustumQuad\(\) \{[\s\S]*?\n\}/)?.[0] || ''));
check('обучение сохраняет первый визит и описывает оба режима; постоянной строки-подсказки нет (I5)', () =>
  /const TUT_SEEN = 'mam\.tut';/.test(app) &&
  /localStorage\.setItem\(TUT_SEEN, '1'\)/.test(app) &&
  /3D · осмотр и полёт/.test(app) && /3D и 2D · жесты/.test(app) &&
  !/id="camTag"/.test(html) && !/CAM_TAG_TOUCH/.test(app) &&
  !/planTag/.test(html) && /id="miTut"/.test(html) && /id="tut"/.test(html));

function planMock(width = 500) {
  const listeners = {};
  const ctx = new Proxy({}, {
    get: (target, key) => key in target ? target[key] : (() => {}),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const canvas = {
    width: 0, height: 0, clientWidth: width, clientHeight: 400,
    getContext: () => ctx,
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 }; },
    addEventListener(type, fn) { listeners[type] = fn; },
    focus() {}, setPointerCapture() {},
  };
  const context = {
    Cesium: { Math: { toRadians: degrees => degrees * Math.PI / 180 } },
    window: { devicePixelRatio: 1 },
    Image: class { constructor() { this.complete = false; } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(plan + '\nthis.PlanPane = PlanPane;', context);
  const pane = new context.PlanPane(canvas, [], { mpp: 0.1, maxViewM: 320, center: [37.480859, 55.672973] });
  return { pane, canvas, listeners };
}
check('PlanPane.resize пересчитывает предел mpp при split/full', () => {
  const { pane, canvas } = planMock(500);
  pane.resize();
  pane.mpp = 0.64;
  canvas.clientWidth = 1000;
  pane.resize();
  if (Math.abs(pane.mpp - 0.32) > 1e-9) throw new Error('mpp=' + pane.mpp);
  return true;
});
check('PlanPane.pick сообщает пустое выделение', () => {
  const { pane, listeners } = planMock();
  let selected = 'buildings:1';
  pane.opts.onPick = id => { selected = id; };
  pane.pick({ clientX: 5, clientY: 5 });
  if (selected !== null) throw new Error('onPick(null) не вызван: ' + selected);
  return true;
});
check('PlanPane: pinch и одиночный палец работают без случайного pick', () => {
  const { pane, listeners } = planMock();
  let picks = 0;
  pane.opts.onPick = () => { picks++; };
  const fire = (type, pointerId, clientX, clientY) => listeners[type]({ pointerId, clientX, clientY, preventDefault() {}, type });
  pane.mpp = 0.4;
  fire('pointerdown', 1, 100, 100);
  fire('pointerdown', 2, 200, 100);
  fire('pointermove', 2, 300, 100);
  if (Math.abs(pane.mpp - 0.2) > 1e-9) throw new Error('pinch out не приблизил: ' + pane.mpp);
  fire('pointerup', 1, 100, 100);
  fire('pointerup', 2, 300, 100);
  if (picks !== 0) throw new Error('pinch завершился случайным pick');
  pane.mpp = 0.2;
  fire('pointerdown', 3, 100, 100);
  fire('pointerdown', 4, 200, 100);
  fire('pointermove', 4, 150, 100);
  if (Math.abs(pane.mpp - 0.4) > 1e-9) throw new Error('pinch in не отдалил: ' + pane.mpp);
  fire('pointerup', 3, 100, 100);
  fire('pointerup', 4, 150, 100);
  const before = [...pane.center];
  fire('pointerdown', 5, 100, 100);
  fire('pointermove', 5, 130, 120);
  fire('pointerup', 5, 130, 120);
  if (pane.center[0] === before[0] && pane.center[1] === before[1]) throw new Error('одиночный палец не двигает карту');
  if (picks !== 0) throw new Error('pan завершился случайным pick');
  fire('pointerdown', 6, 140, 140);
  fire('pointerup', 6, 140, 140);
  if (picks !== 1) throw new Error('обычный tap не сработал: ' + picks);
  return true;
});
check('CSS разрешает обработку pinch на canvas', () => /#plan \{[^}]*touch-action: none/.test(css));

check('PlanPane: стрелки панорамируют, +/- масштабируют', () => {
  const { pane, listeners } = planMock();
  const before = [...pane.center];
  const event = key => ({ key, preventDefault() {}, stopPropagation() {} });
  listeners.keydown(event('ArrowRight'));
  if (pane.center[0] === before[0] && pane.center[1] === before[1]) throw new Error('стрелка не сдвинула центр');
  const mpp = pane.mpp;
  listeners.keydown(event('+'));
  if (!(pane.mpp < mpp)) throw new Error('плюс не приблизил план');
  listeners.keydown(event('-'));
  if (Math.abs(pane.mpp - mpp) > 1e-9) throw new Error('минус не вернул масштаб');
  return true;
});

const watchdogSource = app.match(/viewer\.scene\.postRender\.addEventListener\(\(\) => \{[\s\S]*?\n\s*\}\);/)?.[0] || '';
check('FPS-доглядчик только советует и не меняет сцену', () =>
  /showPerfNotice\('fps'\)/.test(watchdogSource) && /fLow >= 2/.test(watchdogSource) &&
  /resetFpsWatch\(\);\r?\n  const previous = App\.mode/.test(app) &&
  !/(?:degradeTo2D|setMode|syncGlobeVisibility|maximumScreenSpaceError\s*=|\.show\s*=)/.test(watchdogSource));
check('аварийный 2D fallback оставлен только для renderError', () =>
  /scene\.renderError\.addEventListener/.test(app) && /degradeTo2D\('браузер не смог отрисовать сцену'/.test(app) &&
  !/degradeTo2D\('кадров/.test(app));

const presetsSource = app.match(/const QUALITY_PRESETS = \{[\s\S]*?\n\};/)?.[0] || '';
const qualityPresets = presetsSource ? new Function(presetsSource + '\nreturn QUALITY_PRESETS;')() : null;
check('пресеты качества описывают только 3D-ресурсы с утверждёнными SSE', () => {
  if (!qualityPresets) return false;
  const modes = Object.keys(qualityPresets).sort();
  if (modes.join(',') !== 'detail,light,normal') return false;
  for (const mode of modes) {
    const slots = Object.keys(qualityPresets[mode]).sort();
    if (slots.join(',') !== 'splats,tileset') {
      throw new Error(mode + ' содержит слоты: ' + slots.join(','));
    }
  }
  return qualityPresets.light.tileset === 48 && qualityPresets.light.splats === 64 &&
    qualityPresets.normal.tileset === 24 && qualityPresets.normal.splats === 32 &&
    qualityPresets.detail.tileset === 12 && qualityPresets.detail.splats === 16;
});
check('ручной пресет меняет модель и Splat, подложка остаётся нетронутой', () => {
  const source = app.match(/function applyQuality\(\) \{[\s\S]*?\n\}/)?.[0];
  if (!source || !qualityPresets) return false;
  const mockViewer = { scene: { globe: { maximumScreenSpaceError: 4 } }, tileset: {}, splats: {} };
  new Function('viewer', 'qualityMode', 'QUALITY_PRESETS', source + '\nreturn applyQuality();')(mockViewer, 'light', qualityPresets);
  return mockViewer.scene.globe.maximumScreenSpaceError === 4 &&
    mockViewer.tileset.maximumScreenSpaceError === 48 && mockViewer.splats.maximumScreenSpaceError === 64;
});
check('подложка имеет фиксированный SSE вне пресета качества (ADR-30)', () => {
  const applySource = app.match(/function applyQuality\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const sse = app.match(/const BASEMAP_SSE = (\d+);/)?.[1];
  return sse === '4' && /sc\.globe\.maximumScreenSpaceError = BASEMAP_SSE;/.test(app) &&
    !/globe/.test(applySource);
});
check('растровая подложка: сетка z15–z23, верхний уровень сообщается плану (ADR-30)', () =>
  /const TILE_ZMIN = 15, TILE_ZMAX = 23;/.test(app) &&
  /const BASE_ZMAX = \{ ortho: TILE_ZMAX, qgis: 22 \};/.test(app) &&
  /minimumLevel: TILE_ZMIN, maximumLevel: zmax/.test(app) &&
  /window\.TILES_ZMAX = TILES_ZMAX;/.test(app) &&
  /\? BASE_ZMAX\.ortho : BASE_ZMAX\.qgis/.test(app) &&
  /const PLAN_ZMIN = 15, PLAN_ZMAX = 23;/.test(plan) &&
  /const zmax = window\.TILES_ZMAX \|\| PLAN_ZMAX;/.test(plan) &&
  /Math\.max\(PLAN_ZMIN, Math\.min\(zmax,/.test(plan));
check('глобальные имена app.js, plan.js и camera.js не пересекаются', () => {
  // классический скрипт в общем window: одинаковый const на двух файлах — SyntaxError,
  // и второй файл не выполняется вообще (проверено живьём 25.11: App стал undefined)
  const tops = src => [...src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const a = new Set(tops(app)), p = tops(plan), c = tops(camera);
  const clash = [...p, ...c].filter(n => a.has(n));
  if (clash.length) throw new Error('пересечение имён: ' + clash.join(', '));
  return true;
});
check('тайлы z23 на диске: сетка полная, верхний уровень не пустой (ADR-30)', () => {
  const dir = path.join(root, 'tiles', '23');
  if (!fs.existsSync(dir)) throw new Error('нет каталога tiles/23');
  const n = fs.readdirSync(dir).reduce((sum, x) => sum + fs.readdirSync(path.join(dir, x)).length, 0);
  if (n < 3000) throw new Error('тайлов z23 меньше ожидаемых 3780: ' + n);
  return true;
});
check('2D-план досматривается до 1 см/px, иначе z23 не используется', () =>
  /const MIN_MPP = 0\.01;/.test(plan) && /Math\.max\(MIN_MPP, v\)/.test(plan));
check('качество имеет подписи Низкое/Среднее/Высокое и сохраняется', () =>
  /id="miQLow" role="menuitemradio" aria-checked="false">Низкое качество/.test(html) &&
  /id="miQMid" role="menuitemradio" aria-checked="true">Среднее качество/.test(html) &&
  /id="miQHigh" role="menuitemradio" aria-checked="false">Высокое качество/.test(html) &&
  /const QUALITY_KEY = 'mam\.quality'/.test(app) && /localStorage\.getItem\(QUALITY_KEY\)/.test(app) &&
  /localStorage\.setItem\(QUALITY_KEY, mode\)/.test(app) &&
  /QUALITY_PRESETS\[qualityMode\]\[slot\]/.test(app));
check('загрузка чанков подписана на события тайлсета и после primitives.add', () =>
  /viewer\[slot\] = ts;\r?\n\s*watchChunkLoading\(slot, ts\);/.test(app) &&
  /for \(const name of \['tileLoad', 'tileFailed', 'initialTilesLoaded', 'allTilesLoaded'\]\)/.test(app) &&
  /syncChunkQueues\(\);/.test(app));
check('тайлсету не назначаются свойства, которых нет в Cesium 1.147', () => {
  // класс регресса: API тайлсета в 1.147 уже, и присваивание несуществующего свойства
  // молча создаёт мёртвое поле (проверено на живом Cesium: preloadSiblings/pickable — false)
  const absent = ['preloadSiblings', 'preloadAncestors', 'pickable', 'cullWithParentBounds'];
  for (const p of absent) {
    for (const h of app.matchAll(new RegExp('ts\\.' + p + '\\s*=', 'g'))) {
      const line = app.slice(0, h.index).split('\n').pop();
      if (!/\bin ts\b/.test(line)) throw new Error('без проверки «in ts»: ts.' + p);
    }
  }
  return true;
});
check('очередь чанков: Cesium 1.147 (statistics) и старый Cesium (progressEvent) — без падения', () => {
  const watchSource = app.match(/function watchChunkLoading\(slot, ts\) \{[\s\S]*?\n\}/)?.[0] || '';
  const syncSource = app.match(/function syncChunkQueues\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  if (!watchSource || !syncSource) return false;
  const mkEvent = () => { const l = []; return { addEventListener: f => l.push(f), fire: x => l.forEach(f => f(x)) }; };
  // Cesium 1.147: у публичного Cesium3DTileset нет tileLoadProgressEvent, очередь — в statistics
  const ts = {
    statistics: { numberOfTilesProcessing: 3, numberOfPendingRequests: 4 },
    tileLoad: mkEvent(), tileFailed: mkEvent(), initialTilesLoaded: mkEvent(), allTilesLoaded: mkEvent(),
  };
  const legacy = { tileLoadProgressEvent: mkEvent() };
  const state = {
    tileset: { initial: true, pending: 0, lastProgress: 0 },
    splats: { initial: false, pending: 0, lastProgress: 0 },
  };
  const out = new Function('chunkState', 'viewer', 'updateChunkUI', 'ts', 'legacy',
    watchSource + '\n' + syncSource + '\nwatchChunkLoading("tileset", ts); syncChunkQueues();' +
    'watchChunkLoading("splats", legacy); legacy.tileLoadProgressEvent.fire(5);' +
    'ts.tileLoad.fire(); return chunkState;')(state, { tileset: ts, splats: null }, () => {}, ts, legacy);
  if (out.tileset.pending !== 7) throw new Error('очередь из statistics: pending=' + out.tileset.pending);
  if (out.splats.pending !== 5) throw new Error('старый progressEvent: pending=' + out.splats.pending);
  if (!(out.tileset.lastProgress > 0)) throw new Error('tileLoad не обновил отметку активности');
  return true;
});

const chunkWordSource = app.match(/function chunkWord\(n\) \{[\s\S]*?\n\}/)?.[0] || '';
const chunkWord = chunkWordSource ? new Function('return ' + chunkWordSource.replace('function chunkWord', 'function'))() : null;
check('счётчик чанков склоняет русское название', () => {
  if (!chunkWord) return false;
  return [[1, 'чанк'], [2, 'чанка'], [5, 'чанков'], [11, 'чанков'], [21, 'чанк'], [22, 'чанка'], [111, 'чанков']]
    .every(([n, word]) => chunkWord(n) === word);
});
check('индикатор показывает ресурс и очередь, затем скрывается', () => {
  const source = app.match(/function updateChunkUI\(force = false\) \{[\s\S]*?\n\}/)?.[0];
  if (!source || !chunkWord) return false;
  const nodes = { chunkStatus: { hidden: true }, chunkText: { textContent: '' } };
  const state = { tileset: { initial: false, pending: 3 }, splats: { initial: false, pending: 0 } };
  const cfg = { tileset: { loadingLabel: '3D-модели' }, splats: { loadingLabel: 'Splat' } };
  const run = new Function('performance', 'chunkUiLast', 'chunkState', 'ASSET_CFG', '$', 'hidePerfNotice', 'chunkWord',
    source + '\nreturn updateChunkUI(true);');
  run({ now: () => 10000 }, 0, state, cfg, id => nodes[id], () => {}, chunkWord);
  if (nodes.chunkStatus.hidden || nodes.chunkText.textContent !== 'Загрузка 3D-модели · 3 чанка') {
    throw new Error(nodes.chunkText.textContent);
  }
  state.tileset.pending = 0;
  run({ now: () => 11000 }, 0, state, cfg, id => nodes[id], () => {}, chunkWord);
  return nodes.chunkStatus.hidden && nodes.chunkText.textContent === '';
});
check('медленная сеть даёт только рекомендацию', () => {
  const source = app.match(/setInterval\(\(\) => \{\r?\n  syncChunkQueues\(\);\r?\n  const now = performance\.now\(\);[\s\S]*?\r?\n\}, 1000\);/)?.[0] || '';
  return /12000/.test(source) && /showPerfNotice\('network'\)/.test(source) &&
    !/(?:degradeTo2D|setMode|syncGlobeVisibility|maximumScreenSpaceError\s*=|\.show\s*=)/.test(source);
});
check('уведомления и контролы доступны и советуют низкое качество', () =>
  /id="perfText" role="status" aria-live="polite" aria-atomic="true"/.test(html) &&
  /id="perfClose"[^>]*aria-label="Закрыть рекомендацию"/.test(html) &&
  /id="chunkStatus" role="status" aria-live="polite" aria-atomic="true" hidden/.test(html) &&
  /if \(NO_GL \|\| App\.mode !== '3d'\) return;/.test(app) &&
  /Низкая частота кадров\. Рекомендуем открыть 2D или выбрать низкое качество/.test(app) &&
  /Похоже, соединение медленное\. Рекомендуем открыть 2D или выбрать низкое качество/.test(app) &&
  /#perfClose \{[^}]*width: 44px; height: 44px/.test(css) &&
  /prefers-reduced-motion: reduce[\s\S]*?animation: none !important/.test(css));

/* ——— T38+T39: мобильная раскладка, FAB-меню, тач-полёт, мини-карта, дебаг ——— */
function scriptVersion(name) {
  const m = html.match(new RegExp('<script src="' + name + '\\?v=(\\d+)"'));
  return m ? +m[1] : 0;
}
const narrow = css.match(/@media \(max-width: 700px\) \{[\s\S]*?\n\}/)?.[0] || '';

check('версии скриптов T38+T39: plan ≥13, camera ≥3, app ≥60', () =>
  scriptVersion('plan.js') >= 13 && scriptVersion('camera.js') >= 3 && scriptVersion('app.js') >= 60);
check('сброс исходного вида: строка меню камеры + клавиша R (U4→I1)', () =>
  /<button class="mi" id="miHome">/.test(html) &&
  /<path d="M3 11\.5 12 4l9 7\.5"\/><path d="M5 10v9h14v-9"\/>/.test(html) &&
  /Исходный вид <span class="kbd">R<\/span>/.test(html) &&
  /function resetCamera\(\)[\s\S]*?cameraController\.reset\(\);[\s\S]*?toast\('Исходный ракурс'\)/.test(app) &&
  /\$\('miHome'\)\.onclick = \(\) => \{ resetCamera\(\); closeMenus\(\); \}/.test(app) &&
  /\$\('miHome'\)\.disabled = NO_GL \|\| App\.mode !== '3d'/.test(app));
check('переключатель «Дебаг» в меню шестерёнки и состояние mam.dbg (U5→I1)', () =>
  /<button class="mi" id="miDbg" role="switch" aria-checked="false"/.test(html) &&
  /<span class="sw"/.test(html) &&
  /const DBG_KEY = 'mam\.dbg'/.test(app) &&
  /localStorage\.setItem\(DBG_KEY, on \? '1' : '0'\)/.test(app) &&
  /if \(localStorage\.getItem\(DBG_KEY\) === '1'\) setDbg\(true\)/.test(app) &&
  /document\.body\.classList\.toggle\('dbg', on\)/.test(app));
check('панель #dbg: пять групп значений и обновление из postRender (U5)', () =>
  /<div id="dbg" role="status" aria-hidden="true">/.test(html) &&
  ['dbgFps', 'dbgCanvas', 'dbgCam', 'dbgAngles', 'dbgFov'].every(id => hasId(id)) &&
  /function updateDbg\(\) \{[\s\S]*?dbgFps[\s\S]*?dbgCanvas[\s\S]*?dbgCam[\s\S]*?dbgAngles[\s\S]*?dbgFov/.test(app) &&
  /positionCartographic[\s\S]*?\+' \+ cc\.height\.toFixed\(1\) \+ ' м'/.test(app) &&
  /\$\(\'dbgAngles\'\)\.textContent[\s\S]*?курс [\s\S]*?наклон [\s\S]*?крен /.test(app) &&
  /cam\.frustum\.fov/.test(app) &&
  /updateReadout\(\); updateDbg\(\)/.test(app) &&
  /if \(!document\.body\.classList\.contains\('dbg'\) \|\| NO_GL \|\| !viewer\) return/.test(app) &&
  /#dbg \{[^}]*width: 210px;[^}]*display: none/.test(css) &&
  /body\.dbg #dbg \{ display: block; \}/.test(css) &&
  /'miQLow', 'miQMid', 'miQHigh', 'miDbg'\]/.test(app));
check('мини-карта #mm+#mmc: второй PlanPane-радар с фичами и fit по участку (N3)', () =>
  /<div id="mm"><canvas id="mmc" aria-hidden="true"><\/canvas><\/div>/.test(html) &&
  /App\.mmPlan = makePlan\(\$\('mmc'\), \{ radar: true, follow: false/.test(app) &&
  /App\.mmPlan\.fit\(rect\)/.test(app) &&
  /App\.mmPlan\.setFeatures\(out, style\)/.test(app) &&
  /if \(App\.mmPlan\) App\.mmPlan\.resize\(\)/.test(app) &&
  /for \(const id of \['map', 'plan', 'mm'\]\)/.test(app));
check('мини-карта видна только в полноэкранном 3D и не в сплите/2D (N3)', () =>
  /#mm \{[^}]*width: var\(--mm\); height: var\(--mm\);[^}]*display: none/.test(css) &&
  /:root \{[\s\S]*?--mm: 190px;/.test(css) &&
  /body\.full3d #mm \{ display: block; \}/.test(css) &&
  /document\.body\.classList\.toggle\('full3d', App\.mode === '3d' && !App\.split && !NO_GL\)/.test(app) &&
  /body\.full3d #speedTag \{ left: calc\(var\(--mm\) \+ var\(--sp-4\)\); \}/.test(css) &&
  /:root \{ --mm: 132px; \}/.test(narrow));
check('луч взгляда на плане: rayEnd по печной сетке, отсечка RAY_MAX, точка удара и пунктир при промахе (N5→ADR-33)', () =>
  /function rayEnd\(\) \{[\s\S]*?Collision\.grid\.raycast\(o\.x, o\.y, o\.z, d\.x, d\.y, d\.z, RAY_MAX\)/.test(app) &&
  /Cesium\.Ray\.getPoint\(new Cesium\.Ray\(cam\.position, cam\.direction\), RAY_MAX/.test(app) &&
  /quad: hAg <= FRUSTUM_MAX_H \? frustumQuad\(\) : null, rayEnd: rayEnd\(\), rayDist: rayCache\.dist/.test(app) &&
  /if \(this\.cam\.rayEnd\) \{[\s\S]*?ctx\.stroke\(\);[\s\S]*?ctx\.arc\(ex, ey, 3\.5/.test(plan) &&
  /ctx\.strokeStyle = '#4ad7ff'; ctx\.lineWidth = 1\.5/.test(plan) &&
  /if \(dist === null\) ctx\.setLineDash\(\[5, 4\]\)/.test(plan));
check('FAB-колонка и три контекстных меню в разметке (U2)', () =>
  /<div id="fabCol">/.test(html) && ['fabMode', 'fabCam', 'fabSet'].every(hasId) &&
  /<div id="modeMenu" class="menu" role="menu"/.test(html) &&
  /<div id="camMenu" class="menu" role="menu"/.test(html) &&
  /<div id="setMenu" class="menu" role="menu"/.test(html) &&
  ['mi3d', 'miSplit', 'mi2d'].every(id => new RegExp('id="' + id + '" role="menuitemradio"').test(html)) &&
  /id="miOrbit" role="menuitemradio"/.test(html) && /id="miFly" role="menuitemradio"/.test(html) &&
  hasId('miHome') && /id="miDbg" role="switch"/.test(html) && /<span class="sw"/.test(html) &&
  ['miOrtho', 'miQgis', 'miQLow', 'miQMid', 'miQHigh', 'miTut'].every(hasId) &&
  /class="msep"/.test(html));
check('FAB и меню: открытие-закрытие, Escape, тап мимо и синхронизация активности', () =>
  /const FAB_MENUS = \[\['fabMode', 'modeMenu'\], \['fabCam', 'camMenu'\], \['fabSet', 'setMenu'\]\]/.test(app) &&
  /function closeMenus\(\)[\s\S]*?classList\.remove\('open'\)[\s\S]*?aria-expanded', 'false'/.test(app) &&
  /const open = !\$\(menu\)\.classList\.contains\('open'\)/.test(app) &&
  /if \(!e\.target\.closest\('\.menu'\) && !e\.target\.closest\('\.fab'\)\) closeMenus\(\)/.test(app) &&
  /document\.addEventListener\('keydown', e => \{[\s\S]*?if \(e\.key !== 'Escape'\) return;[\s\S]*?menuOpen[\s\S]*?e\.stopPropagation\(\);[\s\S]*?closeMenus\(\);[\s\S]*?\}, true\)/.test(app) &&
  !/vpopOpen/.test(app) &&
  /function syncMenus\(\)[\s\S]*?syncItem\('mi3d'[\s\S]*?syncItem\('miSplit'[\s\S]*?syncItem\('mi2d'[\s\S]*?syncItem\('miOrbit'[\s\S]*?syncItem\('miFly'/.test(app) &&
  /\$\('miOrbit'\)\.onclick[\s\S]*?setMode\('orbit'\)/.test(app) &&
  /\$\('miFly'\)\.onclick[\s\S]*?setMode\('fly'\)/.test(app) &&
  /\$\('miOrtho'\)\.onclick[\s\S]*?setBase\('ortho'\)/.test(app) &&
  /\$\('miQgis'\)\.onclick[\s\S]*?setBase\('qgis'\)/.test(app) &&
  /\$\('miQLow'\)\.onclick[\s\S]*?setQuality\('light'\)/.test(app) &&
  /\$\('miTut'\)\.onclick[\s\S]*?tutShow\(\)/.test(app) &&
  /syncMenus\(\);[\s\S]{0,200}updateReadout\(\);/.test(app));
check('CSS: FAB и их меню — единственная система на всех экранах, нижней панели нет (I1)', () =>
  /#fabCol \{[^}]*right: var\(--sp-2\); top: var\(--fab-top\);[^}]*display: flex/.test(css) &&
  /\.fab \{[^}]*width: var\(--fab\); height: var\(--fab\)/.test(css) &&
  /\.menu \{[^}]*top: var\(--menu-top\);[^}]*display: none/.test(css) &&
  /\.menu\.open \{ display: flex; \}/.test(css) &&
  /\.mi \{[^}]*min-height: 46px/.test(css) &&
  /:root \{[\s\S]*?--menu-top: calc\(var\(--fab-top\) \+ var\(--fab-col-h\) \+ var\(--sp-2\)\)/.test(css) &&
  !/#status|#vpop|#camTag|#cameraMode|#viewSeg|#qualitySeg/.test(css) &&
  !/id="status"|id="vpop"|id="camTag"|id="viewSeg"|id="cameraMode"|id="qualitySeg"/.test(html));
check('значение режима — в подписи FAB и в строках меню, а не в постоянной строке (I5)', () =>
  /<button class="fab" id="fabMode" data-tip="Режим вида"/.test(html) &&
  /\.fab::after \{ content: attr\(data-tip\)/.test(css) &&
  /\.fab:hover::after, \.fab:focus-visible::after, \.fab\[aria-expanded="true"\]::after/.test(css) &&
  /function setFabTip\(id, text\) \{[\s\S]*?dataset\.tip[\s\S]*?aria-label/.test(app) &&
  /function updateFabTips\(\)[\s\S]*?'Режим: '[\s\S]*?'Камера: '/.test(app) &&
  /updateFabTips\(\);/.test(app) &&
  /\.mi \.kbd \{/.test(css) && /<span class="kbd">1<\/span>/.test(html));
check('сплит ≤700px: план сверху, 3D снизу (U1); readout у шва; дебаг и карточка в 3D-половине', () =>
  /body\.split3d #plan \{ left: 0; top: 0; width: 100%; height: 50%;/.test(narrow) &&
  /body\.split3d #map \{ width: 100%; height: 50%; top: 50%; \}/.test(narrow) &&
  /body\.split3d \.readout \{ bottom: calc\(50% \+ var\(--sp-2\)\)/.test(narrow) &&
  /body\.pure2d \.readout \{ bottom: var\(--sp-2\); \}/.test(narrow) &&
  /#dbg \{ top: calc\(50% \+ var\(--sp-2\)\); right: var\(--sp-2\); \}/.test(narrow) &&
  /#insp \{ top: auto; bottom: var\(--sp-2\); width: calc\(100% - 2 \* var\(--sp-2\)\)/.test(narrow) &&
  /body\.split3d #insp \{ width: min\(var\(--insp\), calc\(50% - 2 \* var\(--sp-2\)\)\); \}/.test(css));
check('тач-полёт: #stick и #flyBtns в разметке, скрыты базово, видны в flytouch-полёте (N2)', () =>
  /<div id="stick" aria-hidden="true"><div class="knob"><\/div><\/div>/.test(html) &&
  /<div id="flyBtns">/.test(html) && ['flyUp', 'flyDown', 'flyRun'].every(hasId) &&
  /#stick \{[^}]*left: 20px; bottom: 110px;[^}]*display: none/.test(css) &&
  /#flyBtns \{[^}]*right: var\(--sp-2\); bottom: var\(--sp-2\);[^}]*display: none/.test(css) &&
  /body\.flytouch #stick \{ display: block; \}/.test(css) &&
  /body\.flytouch #flyBtns \{ display: flex; \}/.test(css) &&
  /document\.body\.classList\.toggle\('flytouch', fly && CAMERA_TOUCH && App\.mode === '3d' && !NO_GL\)/.test(app) &&
  /const stick = \$\('stick'\), knob = stick\.querySelector\('\.knob'\)/.test(app) &&
  /cameraController\.setStick\(dx \/ STICK_R, -dy \/ STICK_R\)/.test(app) &&
  /holdFlyButton\('flyUp', 1\)/.test(app) && /holdFlyButton\('flyDown', -1\)/.test(app) &&
  /cameraController\.setRun\(on\)/.test(app));
check('прицел остаётся в тач-полёте и прячется вне него', () =>
  /@media \(pointer: coarse\) \{[^}]*#speedTag \{ display: none !important; \}/.test(css) &&
  /body\[data-camera-mode="fly"\]:not\(\.flytouch\):not\(\.pure2d\):not\(\.nogl\) #flyCross \{ display: none; \}/.test(css) &&
  !/@media \(pointer: coarse\) \{[^}]*#flyCross, #speedTag/.test(css));
check('drag плана не двигает камеру: onView без panMain, камера ходит по тапу (N4)', () => {
  const mk = app.match(/function makePlan\(canvas, opts\) \{[\s\S]*?\n\}/)?.[0] || '';
  return /onView: \(\) => \{ updateReadout\(\); \}/.test(mk) && !/panMain\(-dLon/.test(mk) &&
    /onTapGround: geo =>/.test(mk) && /cameraController\.focusAtGround\(lon, lat\)/.test(mk) &&
    /panMain\(lon - clon, lat - clat\)/.test(mk) &&
    /classList\.contains\('split3d'\)/.test(mk) &&
    /this\.pick\(e\);[\s\S]{0,300}if \(this\.opts\.onTapGround\) \{/.test(plan) &&
    /if \(geo\) this\.opts\.onTapGround\(geo\)/.test(plan);
});
check('обратная проекция тапа плана в гео-координаты', () =>
  /function worldPxToLonLat\(x, y, z\)/.test(plan) &&
  /#screenToGeo\(clientX, clientY\) \{[\s\S]*?#screenToLocal\([\s\S]*?worldPxToLonLat\(cx \+ lx \/ k, cy \+ ly \/ k, this\.z\)/.test(plan));
check('мини-карта в 3D и план в сплите получают одну и ту же камеру без раннего выхода', () => {
  const sp = app.match(/function syncPlans\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  return !/if \(!document\.body\.classList\.contains\('split3d'\)/.test(sp) &&
    /if \(split && App\.plan\) \{/.test(sp) &&
    /if \(mini && App\.mmPlan\) \{[\s\S]*?App\.mmPlan\.setCamera\(cam\);[\s\S]*?App\.mmPlan\.setViewCenter\(lon, lat\)/.test(sp);
});
check('луч взгляда троттлится: рейкаст не чаще раза в 250 мс, результат и дистанция переиспользуются', () =>
  /const RAY_MS = 250/.test(app) &&
  /const rayCache = \{ at: 0, end: null, dist: null \}/.test(app) &&
  /if \(rayCache\.end && now - rayCache\.at < RAY_MS\) return rayCache\.end/.test(app) &&
  /rayCache\.at = now;[\s\S]*?rayCache\.end = \[Cesium\.Math\.toDegrees/.test(app) &&
  /rayCache\.dist = dist;/.test(app) &&
  !/Cartesian3\.isValid/.test(app));
check('план на «бумаге»: канвас прозрачен вне тайлов — фон задаёт CSS', () =>
  /#plan \{[^}]*background: #edf0ea/.test(css));
check('≤700px: баннеры чанков и просадок обходят FAB-колонку (отступ из размера кнопки)', () =>
  /#chunkStatus \{[^}]*left: var\(--sp-2\);\r?\n\s*right: calc\(var\(--sp-2\) \+ var\(--fab\) \+ var\(--sp-2\)\)/.test(narrow) &&
  /#perfNotice \{[^}]*left: var\(--sp-2\);\r?\n\s*right: calc\(var\(--sp-2\) \+ var\(--fab\) \+ var\(--sp-2\)\)/.test(narrow) &&
  /body\.full3d #chunkStatus, body\.full3d #perfNotice \{ left: calc\(2 \* var\(--sp-2\) \+ var\(--mm\)\); \}/.test(narrow));
check('обучение на таче содержит 2×тап, джойстик и исходный вид; постоянной строки-подсказки нет (U3→I5)', () =>
  /const items = TUT_TOUCH \? \[[\s\S]*?'2×тап по 3D-виду'/.test(app) &&
  /'меню камеры · клавиша R'/.test(app) &&
  /'свайп по 3D, кроме кнопок'/.test(app) &&
  /'джойстик · ↑↓ высота · ×4 бег'/.test(app) &&
  /'круглые кнопки справа вверху'/.test(app) &&
  !/camTag/.test(app) && !/id="camTag"/.test(html));

/* ——— T40 партия B2: тач-параллель, режим через 2D, меню ресурса, служебные слои ——— */
check('параллельный тач: чужой pointerdown чистит только клавиши, не жесты (ADR-33)', () =>
  /if \(e\.target !== this\.canvas\) this\.keys\.clear\(\);/.test(camera) &&
  !/if \(e\.target !== this\.canvas\) this\._clearInput\(\)/.test(camera));
check('зона свайпа взгляда — по фактическим DOM-контролам, а не по половине канваса', () =>
  /_inDomControl\(e\) \{/.test(camera) &&
  /querySelectorAll\('#stick, #flyBtns, #fabCol, \.menu, #mm, #fovCtl'\)/.test(camera) &&
  /if \(this\._inDomControl\(e\)\) return;/.test(camera) &&
  !/rect\.width \/ 2/.test(camera));
check('режим камеры переживает заглядывание в 2D (аудит B1)', () =>
  /target: this\.v3\(this\.target\), mode: this\.mode/.test(camera) &&
  /if \(this\.saved2d\.mode === 'fly'\) \{ this\.mode = 'fly'; this\._initFlyAngles\(\); \}/.test(camera) &&
  !/restoreFrom2D\(\)[\s\S]*?\n    this\.mode = 'orbit';/.test(camera));
check('гибрид-устройство: dblclick после тача не дублирует двойной тап (аудит A8)', () =>
  /this\._touchAt = performance\.now\(\);/.test(camera) &&
  /performance\.now\(\) - \(this\._touchAt \|\| 0\) < 700/.test(camera) &&
  /e\.type === 'pointercancel' \|\| e\.type === 'lostpointercapture'/.test(camera));
check('меню шестерёнки выбирает 3D-ресурс: Нет / 3D-модель / Splat (решение владельца 26.11)', () =>
  ['miAssetNone', 'miAssetModel', 'miAssetSplat'].every(hasId) &&
  /role="menuitemradio"/.test(html) &&
  /function assetChoiceState\(\) \{[\s\S]*?viewer\.splats && viewer\.splats\.show[\s\S]*?viewer\.tileset && viewer\.tileset\.show/.test(app) &&
  /function setAssetChoice\(kind\) \{[\s\S]*?toggleAsset\(kind === 'splat' \? 'splats' : 'tileset'\)/.test(app) &&
  /\$\('miAssetSplat'\)\.onclick[\s\S]*?setAssetChoice\('splat'\)/.test(app) &&
  /\$\('miAssetNone'\)\.onclick[\s\S]*?setAssetChoice\('none'\)/.test(app) &&
  /syncItem\('miAssetNone', asset === 'none'\)/.test(app) &&
  /syncItem\('miAssetSplat', asset === 'splat'\)/.test(app) &&
  /row: 'miAssetModel'/.test(app) && /row: 'miAssetSplat'/.test(app) &&
  /<span class="lbl">3D-модель<\/span>/.test(html) && /<span class="lbl">Splat<\/span>/.test(html) &&
  /row\.querySelector\('\.lbl'\)\.textContent/.test(app) &&
  /row\.title = NO_GL \? '3D недоступен: нет WebGL' : cfg\.title/.test(app));
check('взаимоисключение ресурсов применяется до загрузки — двоения нет (аудит B-2)', () =>
  /for \(const other of Object\.keys\(ASSET_CFG\)\) if \(other !== slot && viewer\[other\]\) viewer\[other\]\.show = false;\r?\n\s*syncGlobeVisibility\(\);\r?\n\s*const ts = await ensureAsset\(slot\)/.test(app));
check('панели тач-полёта гасятся в 2D и без WebGL: класс из applyViewClasses + страховка CSS (аудит A2)', () =>
  /document\.body\.classList\.toggle\('flytouch',\r?\n\s*\(document\.body\.dataset\.cameraMode \|\| 'orbit'\) === 'fly' && CAMERA_TOUCH && App\.mode === '3d' && !NO_GL\)/.test(app) &&
  /body\.pure2d #stick, body\.pure2d #flyBtns, body\.nogl #stick, body\.nogl #flyBtns \{ display: none; \}/.test(css));
check('план: capture не роняет жест, lostpointercapture чистит состояние, клавиши не дублируют 3D (аудит A5-A7)', () =>
  /try \{ this\.c\.setPointerCapture\(e\.pointerId\); \} catch \(err\) \{\}/.test(plan) &&
  /this\.c\.addEventListener\('lostpointercapture', e => \{/.test(plan) &&
  /e\.preventDefault\(\);\r?\n\s*e\.stopPropagation\(\);/.test(plan));
check('служебные слои не перехватывают касания; мини-карта — картинка; кнопка рекомендации доступна (аудит A9, B5)', () =>
  /#mm \{ pointer-events: none; \}/.test(css) &&
  /\.readout, #dbg, #chunkStatus, #stat, #perfNotice \{ pointer-events: none; \}/.test(css) &&
  /#perfClose \{ pointer-events: auto; \}/.test(css));
check('CSS синтаксис: комментарии только /* */, скобки сбалансированы, var() без висячих токенов', () => {
  // регресс 26.11: строчка «--mm: 190px; // подпись» — «//» не комментарий, парсер CSS
  // съел её вместе со следующим объявлением (--sp-1), и вся шкала отступов сломалась
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\//.test(bare)) throw new Error('// вне блочного комментария');
  const open = (bare.match(/\{/g) || []).length, close = (bare.match(/\}/g) || []).length;
  if (open !== close) throw new Error('фигурные скобки: ' + open + ' { против ' + close + ' }');
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)(\s*,)?/g)].filter(m => !m[2]).map(m => m[1]));
  const miss = [...used].filter(t => !defined.has(t));
  if (miss.length) throw new Error('неопределённые токены: ' + miss.join(', '));
  return true;
});

check('контекстное меню целиком помещается на экране (аудит A3)', () =>  /\.menu \{[^}]*max-height: calc\(100dvh - var\(--menu-top\) - var\(--sp-2\)\);[\s\S]*?overflow-y: auto/.test(css));

check('слайдер FOV внутри 3D-вида: у правого края, гаснет в покое, в сплите — в своей половине (I6)', () =>
  /<div id="fovCtl">\s*<b id="fovVal">86°<\/b>/.test(html) &&
  /id="fovSl" min="30" max="120" value="86"/.test(html) &&
  /#fovCtl \{[^}]*right: var\(--sp-2\); top: 50%;[^}]*opacity: \.3/.test(css) &&
  /#fovCtl\.hot \{ opacity: 1; \}/.test(css) &&
  /#fovCtl\.off, body\.pure2d #fovCtl, body\.nogl #fovCtl \{ display: none; \}/.test(css) &&
  /body\.split3d #fovCtl \{ right: calc\(50% \+ var\(--sp-2\)\); \}/.test(css) &&
  /body\.split3d #fovCtl \{ right: var\(--sp-2\); top: 75%; \}/.test(narrow) &&
  /function fovPulse\(\)[\s\S]*?classList\.add\('hot'\)[\s\S]*?remove\('hot'\), 2200\)/.test(app) &&
  /function updateFovCtl\(\)[\s\S]*?classList\.toggle\('off', !on\)/.test(app) &&
  /\$\('fovSl'\)\.oninput = e => setFov\(\+e\.target\.value, true\)/.test(app) &&
  /\$\('fovCtl'\)\.addEventListener\('pointerenter', fovPulse\)/.test(app));

check('раскладка и FOV переживают перезагрузку; клавиши вида 1/2/3 работают (I1, B5)', () =>
  /const VIEW_KEY = 'mam\.view'/.test(app) &&
  /localStorage\.setItem\(VIEW_KEY, JSON\.stringify\(\{ mode: App\.mode, split: App\.split \}\)\)/.test(app) &&
  /App\.split = !NO_GL && !!savedView\.split/.test(app) &&
  /JSON\.parse\(localStorage\.getItem\(VIEW_KEY\)/.test(app) &&
  /saveViewPrefs\(\)/.test(app) &&
  /const FOV_KEY = 'mam\.fov'/.test(app) &&
  /localStorage\.setItem\(FOV_KEY, String\(deg\)\)/.test(app) &&
  /if \(k === '1'\) setView\('3d', false\)/.test(app) &&
  /if \(k === '2'\) setView\('3d', true\)/.test(app) &&
  /if \(k === '3'\) setView\('2d', null\)/.test(app) &&
  /if \(!\$\('tut'\)\.hidden\) return;/.test(app));

check('стартовый вид, исходная точка и FOV — значения владельца с панели дебага (26.11)', () =>
  /const HOME_POSE = \{ lon: 37\.48121, lat: 55\.67356, h: 2\.3, heading: 126, pitch: -1, roll: 0 \}/.test(app) &&
  /const FOV_DEFAULT = 86/.test(app) &&
  /viewer\.camera\.setView\(\{ destination: homePosition\(\), orientation: homeOrientation\(\) \}\)/.test(app) &&
  /target: homeTarget\(\)/.test(app) &&
  /Cesium\.Cartesian3\.multiplyByScalar\(dir, HOME_LOOK_AHEAD/.test(app) &&
  /let savedFov = FOV_DEFAULT;[\s\S]*?setFov\(savedFov\)/.test(app) &&
  /toRadians\(FOV_DEFAULT\)/.test(app) &&
  /cam\.frustum\.fov === undefined \? '—' : deg\(cam\.frustum\.fov\)/.test(app) &&
  /id="fovSl"[^>]*value="86"/.test(html));

console.log('ИТОГ:', passed + '/' + (passed + failed) + ' passed,' , failed + ' failed');
process.exitCode = failed ? 1 : 0;
