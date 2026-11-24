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
check('стартовая подложка — Схема QGIS, орто называется Карта', () =>
  /let TILES_BASE = '\.\/tiles_qgis\/'/.test(app) &&
  /<button class="chip on" id="chQgis"[^>]*>Схема<\/button>/.test(html) &&
  /<button class="chip" id="chOrtho"[^>]*>Карта<\/button>/.test(html));
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
check('физика ходьбы, pointer lock и collision не остаются в runtime', () =>
  !/(?:startWalk|stopWalk|walkTick|collision\.bin|requestPointerLock|App\.walk)/.test(app + camera));
check('CameraController загружен до app.js и создан для живого viewer', () =>
  /<script src="camera\.js\?v=(?:[2-9]|\d{2,})"><\/script>\s*<script src="app\.js/.test(html) &&
  /new CameraController\(/.test(app) && /App\.cameraController = cameraController/.test(app));
check('экранные режимы камеры явные и доступны с клавиатуры', () =>
  /id="cameraMode" role="group" aria-label="Режим 3D-камеры"/.test(html) &&
  /id="orbitBtn" aria-pressed="true"/.test(html) && /id="flyBtn" aria-pressed="false"/.test(html));
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
check('стартовая камера не добавляет GROUND_H повторно', () =>
  /\/ 2 - 0\.00125, 140\)/.test(app) && !/GROUND_H \+ 90/.test(app));
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
check('обучение сохраняет первый визит и описывает оба режима; старая planTag не возвращается', () =>
  /const TUT_SEEN = 'mam\.tut';/.test(app) &&
  /localStorage\.setItem\(TUT_SEEN, '1'\)/.test(app) &&
  /3D · осмотр и полёт/.test(app) && /id="camTag"/.test(html) &&
  !/planTag/.test(html) && /id="tutBtn"/.test(html));

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
  const event = key => ({ key, preventDefault() {} });
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
  />Низкое<\/button>/.test(html) && />Среднее<\/button>/.test(html) && />Высокое<\/button>/.test(html) &&
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

console.log('ИТОГ:', passed + '/' + (passed + failed) + ' passed,' , failed + ' failed');
process.exitCode = failed ? 1 : 0;
