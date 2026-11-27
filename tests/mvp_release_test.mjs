import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
/* D1: приложение — набор ES-модулей в src/, а не один app.js. Проверки текстовые, поэтому
 * читаем граф как единый текст: «app» — рабочие модули, «camera» — модули камеры (у них свой
 * контракт единственного писателя), «css» — пять подключаемых файлов стилей. Припаркованные
 * модули (вектор/редактор) в выборку НЕ входят: они не участвуют в запуске. */
function jsModules(dir) {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
    const rel = dir + '/' + name;
    if (fs.statSync(path.join(root, rel)).isDirectory()) out.push(...jsModules(rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const PARKED = new Set(['src/vector.js', 'src/editor.js']);
const modules = jsModules('src');
const cameraFiles = modules.filter(f => f.startsWith('src/camera/'));
const appFiles = modules.filter(f => !f.startsWith('src/camera/') && !PARKED.has(f));
const app = appFiles.map(read).join('\n');
const camera = cameraFiles.map(read).join('\n');
const cssFiles = ['styles/tokens.css', 'styles/layout.css', 'styles/controls.css', 'styles/panels.css', 'styles/responsive.css'];
const css = cssFiles.map(read).join('\n');
const plan = read('src/plan.js');
const geo2d = read('src/geo2d.js');
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
/* D1: модули нельзя скормить eval/vm как есть — там import/export. Проверки, которые
  * раньше вырезали кусок текста из app.js и исполняли его, теперь загружают настоящий
  * модуль: import-строки убираются, export-ы снимаются, тело исполняется в функции с
  * подставными зависимостями. Так проверяется реальный код модуля, а не его копия из старой
  * однофайловой сборки. */
function stripModule(src) {
  const out = [];
  let inImport = false;
  for (const line of src.split('\n')) {
    if (inImport) { if (/from\s+'[^']*'/.test(line)) inImport = false; continue; }
    if (/^import\b/.test(line)) { if (!/from\s+'[^']*'/.test(line)) inImport = true; continue; }
    if (/^export\s*\{/.test(line)) continue;
    out.push(line.replace(/^export\s+/, ''));
  }
  return out.join('\n');
}
function loadModule(rel, env = {}) {
  const src = stripModule(read(rel));
  const names = [...src.matchAll(/^(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const keys = Object.keys(env);
  const fn = new Function(...keys, src + '\nreturn {' + names.join(', ') + '};');
  return fn(...keys.map(k => env[k]));
}
/* гео-математика 2D — чистый модуль без зависимостей, нужен плану как env */
const geo2dEnv = loadModule('src/geo2d.js');
/* общий подстановочный мир для модульных проверок: то, что в браузере даёт страница */
function fakeNode() {
  const node = {
    textContent: '', innerHTML: '', value: '', disabled: false, hidden: false,
    dataset: {}, style: {}, onclick: null, oninput: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, appendChild() {},
    querySelector: () => fakeNode(), querySelectorAll: () => [],
  };
  return node;
}
function browserEnv(extra = {}) {
  return Object.assign({
    Cesium: { Math: { toRadians: d => d * Math.PI / 180, toDegrees: r => r * 180 / Math.PI } },
    window: { devicePixelRatio: 1 },
    document: { hidden: false, body: fakeNode(), addEventListener() {}, getElementById: () => fakeNode(),
      querySelector: () => fakeNode(), querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Image: class { constructor() { this.complete = false; } },
    performance: { now: () => 0 },
    $: () => fakeNode(), el: () => fakeNode(), esc: s => String(s),
    console,
  }, geo2dEnv, extra);
}

check('MVP не загружает editor.js', () => !/<script[^>]+editor\.js/.test(html));
check('fallback не предлагает выбор объектов', () =>
  !/function noGlNotice[\s\S]*?выбирать объекты/.test(app));
check('фон карты: доступны схема QGIS и снимок с воздуха с технической подсказкой', () =>
  /const TILE_SOURCE = \{ base: '\.\/tiles_qgis\/'/.test(app) &&
  /id="miQgis" role="menuitemradio" aria-checked="true"/.test(html) &&
  /id="miOrtho" role="menuitemradio" aria-checked="false"/.test(html) &&
  /Схема/.test(html) && /Снимок с воздуха/.test(html) && /title="Орто-подложка"/.test(html) &&
  /\$\('miOrtho'\)\.onclick = \(\) => setBase\('ortho'\)/.test(app) &&
  /\$\('miQgis'\)\.onclick = \(\) => setBase\('qgis'\)/.test(app));
check('MVP не загружает GPKG/sqljs и не рисует векторные слои', () =>
  !/<script[^>]+(?:gpkg\.js|sql-wasm\.js)/.test(html) &&
  /const SHOW_VECTOR_LAYERS = false/.test(app) && /if \(SHOW_VECTOR_LAYERS\) \{[\s\S]*?fetchArrayBuffer/.test(app));
check('панель слоёв и редактор отсутствуют в DOM', () =>
  !/id=["'](?:layers|rail|chEdit|editBtn|apply|cancel|openGpkg|gpkgFile|exp)["']/.test(html));
check('импорт шрифтов разрешается относительно таблицы стилей и ведёт к файлам темы', () => {
  const sheet = 'styles/tokens.css';
  const href = read(sheet).match(/@import url\('([^']+)'\)/)?.[1];
  if (!href) return false;
  const fontCss = path.resolve(root, path.dirname(sheet), href);
  const faces = [...fs.readFileSync(fontCss, 'utf8').matchAll(/src:url\('([^']+)'\)/g)];
  return faces.length > 0 && faces.every(([, file]) => fs.existsSync(path.resolve(path.dirname(fontCss), file)));
});
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
  /import \{ Collision \} from '\.\/collision\.js\?v=\d+'/.test(app) &&
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
  /on\('view', invalidateRay\)/.test(app) &&
  /onState: st => \{ updateCameraState\(st\); invalidateRay\(\); \}/.test(app) &&
  /viewer\.camera\.changed\.addEventListener\(\(\) => invalidateRay\(\)\)/.test(app));
check('Контроллер камеры подключён после классического Cesium и создан для живого viewer', () =>
  /<script src="vendor\/cesium\/Cesium\.js"><\/script>/.test(html) &&
  /<script type="module" src="\.\/src\/main\.js\?v=\d+"><\/script>/.test(html) &&
  html.indexOf('vendor/cesium/Cesium.js') < html.indexOf('<script type="module"') &&
  /import \{ createController \} from '\.\/camera\/controller\.js\?v=\d+'/.test(app) &&
  /App\.CAM = createController\(\{[\s\S]{0,120}Cesium, viewer,/.test(app) &&
  /App\.CAM\.setPose\(HOME_POSE\)/.test(app));
check('экранные режимы камеры явные и доступны с клавиатуры', () =>
  /<div id="viewDock">\s*<div id="camTools" role="group" aria-label="Режим камеры">/.test(html) &&
  /<div id="fabCol">[\s\S]*?id="fabMode"[\s\S]*?id="fabSet"/.test(html) &&
  /id="miOrbit" aria-pressed="true" aria-keyshortcuts="V" title="Вращать модель/.test(html) &&
  /id="miFly" aria-pressed="false" aria-keyshortcuts="F" aria-label="Свободная камера" title="Свободная камера/.test(html) &&
  /#camTools \[aria-pressed="true"\]/.test(css) &&
  /code === 'KeyV'/.test(camera) && /code === 'KeyF'/.test(camera) &&
  /\$\('miOrbit'\)\.onclick = \(\) => App\.CAM && App\.CAM\.setMode\('orbit'\)/.test(app) &&
  /\$\('miFly'\)\.onclick = \(\) => App\.CAM && App\.CAM\.setMode\('fly'\)/.test(app));
check('старые always-on обработчики и зависимость скорости от высоты удалены', () =>
  !/(?:freeKeys|freeLook|freeCameraTick|height \* 0\.12|cam\.moveForward)/.test(app));
check('новый контроллер содержит WASD/QE, R, Esc и два независимых wheel-поведения', () =>
  /KeyW[\s\S]*KeyA[\s\S]*KeyS[\s\S]*KeyD[\s\S]*KeyQ[\s\S]*KeyE/.test(camera) &&
  /r: 'KeyR'/.test(camera) && /e\.key === 'Escape'/.test(camera) &&
  /rig\.setSpeed\(clamp\([\s\S]{0,200}rig\.zoomBy\(Math\.exp/.test(camera));
check('двойной клик использует raycast и прерываемый 400 мс focus без camera.flyTo', () =>
  /options\.pickFocus\(e\.clientX, e\.clientY\)/.test(camera) &&
  /const hit = pickWorld\(clientX, clientY\)/.test(camera) && /rig\.focusTo\(hit\)/.test(camera) &&
  /focusTo\(targetPos, ms = 400\)/.test(camera) && /if \(viewer\.splats\?\.show\)[\s\S]{0,160}options\.pickCollision\(ray, rig\.maxDistance\)/.test(camera) &&
  !/pickTranslucentDepth|camera\.flyTo\(/.test(camera));
check('переход через 2D сохраняет ракурс и не вызывает homeView', () => {
  const source = app.match(/function setMode\(m\) \{[\s\S]*?\n\}/)?.[0] || '';
  return /captureFor2D\(\)/.test(source) && /restoreFrom2D\(\)/.test(source) && !/homeView/.test(source);
});
check('model/Splat взаимоисключающие', () =>
  /for \(const other of Object\.keys\(ASSET_CFG\)\)[\s\S]*?viewer\[other\]\.show = false/.test(app));
/* ADR-37 отменил прежний запрет на автосплат (26.11 — экономия трафика на телефоне): по требованию
 * владельца 27.11 приложение по умолчанию грузится в 3D с gaussian splatting, 3D Tiles — по тапу. */
check('по умолчанию стартует gaussian splatting, 3D Tiles-модель — только следом по выбору (ADR-37)', () => {
  const iSpl = app.indexOf("const loading = toggleAsset('splats')");
  const iTs = app.indexOf("await toggleAsset('tileset')");
  return iSpl > -1 && iTs > iSpl &&
    /const useModelOnRetry = retry\?\.useModel && !Q\.has\('nomodel'\);\s*if \(!Q\.has\('nosplat'\) && !useModelOnRetry\) \{\s*const loading = toggleAsset\('splats'\);/.test(app) &&
    /else if \(!Q\.has\('nomodel'\)\) await toggleAsset\('tileset'\)/.test(app);
});
check('отказ сплата на старте не оставляет пустую сцену: поднимается модель (ADR-37)', () => {
  const main = read('src/main.js');
  return /const loading = toggleAsset\('splats'\);\s*const choice = App\.assetChoice;\s*await loading;/.test(main) &&
    /const up = !!\(App\.viewer\.splats && App\.viewer\.splats\.show\);/.test(main) &&
    /if \(!up && choice === App\.assetChoice && !Q\.has\('nomodel'\)\) await toggleAsset\('tileset'\);/.test(main);
});
check('активный 3D-ресурс скрывает глобус', () => /viewer\.scene\.globe\.show = !hasAsset/.test(app));
check('переключение подложки отбрасывает устаревший ответ', () =>
  /const choice = \+\+baseChoice[\s\S]*?if \(choice !== baseChoice\) return false/.test(app));
check('failed HEAD не закрепляется как постоянный запрет ресурса', () =>
  /if \(found\) assetUrlCache\[slot\] = found;[\s\S]*?else assetUrlCache\[slot\] = undefined/.test(app));
check('отложенный GPKG reader имеет AbortController на headers и тело', () =>
  /async function fetchArrayBuffer[\s\S]*?new AbortController[\s\S]*?response\.arrayBuffer\(\)/.test(app) &&
  /fetchArrayBuffer\('\.\.\/map\/tactical\.gpkg', 10000\)/.test(app));
check('конструктор Viewer защищён fallback', () => /try \{\s*viewer = new Cesium\.Viewer/.test(app) && /catch \(e\) \{[\s\S]{0,200}markNoGl\('Cesium/.test(app));
check('FOV отключён без WebGL', () => /\$\('fovSl'\)\.disabled = App\.noGl;/.test(app));
check('2D доступен с клавиатуры', () => /<canvas id="plan" tabindex="0"/.test(html) &&
  /addEventListener\('keydown'/.test(plan) && /ArrowLeft[\s\S]*ArrowRight[\s\S]*ArrowUp[\s\S]*ArrowDown/.test(plan) &&
  /e\.key === 'Enter'/.test(plan));
check('стартовая камера не добавляет GROUND_H повторно', () => {
  const fn = app.match(/function homePosition\(\) \{[^}]*\}/)?.[0] || '';
  return /App\.CAM\.setPose\(HOME_POSE\)/.test(app) &&
    /target: homePosition\(\)/.test(app) &&
    /fromDegrees\(HOME_POSE\.lon, HOME_POSE\.lat, HOME_POSE\.h\)/.test(fn) &&
    /const HOME_POSE = \{[^}]*h: 3\.1/.test(app) &&
    !/GROUND_H/.test(fn);
});
check('единицы углов на границе rig и движение в системе взгляда (ADR-37)', () => {
  const rig = read('src/camera/rig.js');
  const input = read('src/camera/input.js');
  return /const D2R = Math\.PI \/ 180/.test(rig) &&
    /this\.yaw = wrapPi\(heading \* D2R\)/.test(rig) &&
    /this\.pitch = clamp\(pitch \* D2R, -PITCH_LIMIT, PITCH_LIMIT\)/.test(rig) &&
    /heading: this\.yaw \/ D2R, pitch: this\.pitch \/ D2R/.test(rig) &&
    /this\.yaw = wrapPi\(\(home\.heading \?\? 0\) \* D2R\)/.test(rig) &&
    /moveBy\(f, r, u\) \{ this\.intent\.mvF \+= f; this\.intent\.mvR \+= r; this\.intent\.mvU \+= u; \}/.test(rig) &&
    /i\.mvF \|\| i\.mvR \|\| i\.mvU/.test(rig) &&
    /this\.scale\(this\._dirToWorld\(enu, this\._forwardLocal\(\)\), i\.mvF \* dt\)/.test(rig) &&
    /rig\.moveBy\(forward \* v, right \* v, vertical \* v\)/.test(input) &&
    !/setMoveIntent/.test(camera) &&
    !/moveE|moveN|moveU/.test(rig);
});
check('по умолчанию грузится 3D с gaussian splatting, план подхватывается только своей вкладкой (ADR-37)', () => {
  const main = read('src/main.js');
  const state = read('src/state.js');
  return /if \(!Q\.has\('nosplat'\) && !useModelOnRetry\) \{\s*const loading = toggleAsset\('splats'\);/.test(main) &&
    /else if \(!Q\.has\('nomodel'\)\) await toggleAsset\('tileset'\)/.test(main) &&
    /sessionStorage\.setItem\(VIEW_KEY, v\)/.test(state) &&
    /if \(v\.mode === '2d' && !\(s && s\.mode === '2d'\)\) \{ App\.mode = '3d'; App\.split = false; \}/.test(main) &&
    /mode: '3d',/.test(state) && /split: false,/.test(state);
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
  /3D · Орбита/.test(app) && /3D · Свободная камера/.test(app) && /План сверху/.test(app) &&
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
    classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); } },
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
  const { PlanPane } = loadModule('src/plan.js', browserEnv());
  const pane = new PlanPane(canvas, [], { mpp: 0.1, maxViewM: 320, center: [37.480859, 55.672973] });
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

const watchdogSource = app.match(/App\.viewer\.scene\.postRender\.addEventListener\(\(\) => \{[\s\S]*?\n\s*\}\);/)?.[0] || '';
check('FPS-доглядчик только советует и не меняет сцену', () =>
  /showPerfNotice\('fps'\)/.test(watchdogSource) && /fLow >= 2/.test(watchdogSource) &&
  /App\.resetFpsWatch\(\);/.test(app) &&
  !/(?:degradeTo2D|setMode|syncGlobeVisibility|maximumScreenSpaceError\s*=|\.show\s*=)/.test(watchdogSource));
check('аварийный 2D fallback срабатывает при renderError и потере контекста', () =>
  /scene\.renderError\.addEventListener/.test(app) && /degradeTo2D\('браузер не смог отрисовать сцену'/.test(app) &&
  /viewer\.canvas\.addEventListener\('webglcontextlost', \(\) => \{\s*degradeTo2D\('браузер потерял WebGL-контекст'\)/.test(app) &&
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
  if (!qualityPresets) return false;
  const mockViewer = { scene: { globe: { maximumScreenSpaceError: 4 } }, tileset: {}, splats: {} };
  const saved = [];
  const App = { viewer: mockViewer };
  const q = loadModule('src/quality.js', browserEnv({ App, QUALITY_PRESETS: qualityPresets,
    QUALITY_KEY: 'mam.quality', BASEMAP_SSE: 4,
    localStorage: { getItem: () => null, setItem: (k, v) => saved.push([k, v]), removeItem: () => {} } }));
  q.setQuality('light');
  q.applyQuality();
  const p = qualityPresets.light;
  return mockViewer.scene.globe.maximumScreenSpaceError === 4 &&
    mockViewer.tileset.maximumScreenSpaceError === p.tileset && mockViewer.splats.maximumScreenSpaceError === p.splats &&
    App.qualityMode === 'light' && saved.some(([k, v]) => k === 'mam.quality' && v === 'light');
});
check('подложка имеет фиксированный SSE вне пресета качества (ADR-30)', () => {
  const applySource = app.match(/function applyQuality\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const sse = app.match(/const BASEMAP_SSE = (\d+);/)?.[1];
  return sse === '4' && /scene\.globe\.maximumScreenSpaceError = BASEMAP_SSE;/.test(app) &&
    !/globe/.test(applySource);
});
check('растровая подложка: сетка z15–z23, верхний уровень сообщается плану (ADR-30)', () =>
  /const TILE_ZMIN = 15, TILE_ZMAX = 23;/.test(app) &&
  /const BASE_ZMAX = \{ ortho: TILE_ZMAX, qgis: 22 \};/.test(app) &&
  /minimumLevel: TILE_ZMIN, maximumLevel: zmax/.test(app) &&
  /window\.TILES_BASE = base;[\s\S]{0,80}window\.TILES_ZMAX = zmax;/.test(app) &&
  /\? BASE_ZMAX\.ortho : BASE_ZMAX\.qgis/.test(app) &&
  /window\.TILES_ZMAX \|\| PLAN_ZMAX/.test(plan) &&
  /const PLAN_ZMIN = 15, PLAN_ZMAX = 23;/.test(plan) &&
  /Math\.max\(PLAN_ZMIN, Math\.min\(zmax,/.test(plan));
check('модули не пишут в глобальную область, кроме белого списка мостов', () => {
  // D1: модули имеют свою область, поэтому прежняя проверка «имена файлов не пересекаются»
  // потеряла смысл (одинаковые const в разных модулях безвредны). Остаётся то, что и раньше
  // ломало приложение: запись в window. Разрешены только мосты для припаркованного кода и
  // вендора — всё остальное означает, что модуль снова притворяется классическим скриптом.
  const ALLOWED = ['CESIUM_BASE_URL', 'TILES_BASE', 'TILES_ZMAX', 'App', 'Editor'];
  for (const file of modules) {
    for (const m of read(file).matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) {
      if (!ALLOWED.includes(m[1])) throw new Error(file + ': window.' + m[1] + ' =');
    }
  }
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
  /QUALITY_PRESETS_LOCAL\[qualityMode\]/.test(app) && /preset\[slot\]/.test(app));
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
/* тестовый мир для assets.js: конфиг ресурсов тот же, что в приложении, но узлы и часы — подставные */
const assetCfgForTest = {
  tileset: { urls: ['a.json'], row: 'miAssetModel', flag: 'nomodel', label: '3D-модель', loadingLabel: '3D-модели' },
  splats: { urls: ['b.splat'], row: 'miAssetSplat', flag: 'nosplat', label: 'Сплат', loadingLabel: 'Сплата' },
};
function assetsWorld(extra = {}) {
  let t = 1;
  const nodes = {};
  const env = browserEnv(Object.assign({
    ASSET_CFG: assetCfgForTest,
    Q: { has: () => false },
    GROUND_H: 188, BASE_DROP: 6, setBaseDrop: () => {},
    TILESET: 'a.json', SPLAT_CANDIDATES: ['b.splat'], QUALITY_PRESETS: {}, flattenTileset: t => t,
    performance: { now: () => t++ },
    $: id => (nodes[id] || (nodes[id] = fakeNode())),
  }, extra));
  return { a: loadModule('src/assets.js', env), nodes };
}
check('очередь чанков: Cesium 1.147 (statistics) и старый Cesium (progressEvent) — без падения', () => {
  const mkEvent = () => { const l = []; return { addEventListener: f => l.push(f), fire: x => l.forEach(f => f(x)) }; };
  // Cesium 1.147: у публичного Cesium3DTileset нет tileLoadProgressEvent, очередь — в statistics
  const ts = {
    statistics: { numberOfTilesProcessing: 3, numberOfPendingRequests: 4 },
    tileLoad: mkEvent(), tileFailed: mkEvent(), initialTilesLoaded: mkEvent(), allTilesLoaded: mkEvent(),
  };
  const legacy = { tileLoadProgressEvent: mkEvent() };
  const { a } = assetsWorld({ App: { viewer: { tileset: ts, splats: legacy }, hidePerfNotice: () => {} } });
  a.watchChunkLoading('tileset', ts); a.syncChunkQueues();
  a.watchChunkLoading('splats', legacy); legacy.tileLoadProgressEvent.fire(5);
  ts.tileLoad.fire();
  if (a.chunkState.tileset.pending !== 7) throw new Error('очередь из statistics: pending=' + a.chunkState.tileset.pending);
  if (a.chunkState.splats.pending !== 5) throw new Error('старый progressEvent: pending=' + a.chunkState.splats.pending);
  if (!(a.chunkState.tileset.lastProgress > 0)) throw new Error('tileLoad не обновил отметку активности');
  return true;
});

const chunkWordSource = app.match(/function chunkWord\(n\) \{[\s\S]*?\n\}/)?.[0] || '';
const chunkWord = chunkWordSource ? new Function('return ' + chunkWordSource.replace('function chunkWord', 'function'))() : null;
check('счётчик чанков склоняет русское название', () => {
  if (!chunkWord) return false;
  return [[1, 'фрагмент'], [2, 'фрагмента'], [5, 'фрагментов'], [11, 'фрагментов'], [21, 'фрагмент'], [22, 'фрагмента'], [111, 'фрагментов']]
    .every(([n, word]) => chunkWord(n) === word);
});
check('индикатор показывает ресурс и очередь, затем скрывается', () => {
  let hiddenNotice = null;
  const App = { viewer: {}, hidePerfNotice: k => { hiddenNotice = k; } };
  const { a, nodes } = assetsWorld({ App });
  a.chunkState.tileset = { initial: false, pending: 3, lastProgress: 0 };
  a.chunkState.splats = { initial: false, pending: 0, lastProgress: 0 };
  a.updateChunkUI(true);
  if (nodes.chunkStatus.hidden) throw new Error('индикатор скрыт при активной очереди');
  if (nodes.chunkText.textContent !== 'Загрузка 3D-модели · 3 фрагмента') throw new Error(nodes.chunkText.textContent);
  a.chunkState.tileset.pending = 0;
  a.updateChunkUI(true);
  if (!(nodes.chunkStatus.hidden && nodes.chunkText.textContent === '')) throw new Error('индикатор не скрылся');
  if (hiddenNotice !== 'network') throw new Error('сетевая подсказка не снята вместе с индикатором');
  return true;
});
check('медленная сеть даёт только рекомендацию', () => {
  let tick = null, t = 0;
  const notices = [];
  const tileset = {};
  const App = { viewer: { tileset, splats: null }, showPerfNotice: k => notices.push(k), hidePerfNotice: () => {} };
  const { a } = assetsWorld({ App, setInterval: fn => { tick = fn; return 0; }, performance: { now: () => t } });
  a.startChunkWatch();              // без запуска доглядчика тикать нечем
  a.chunkState.tileset = { initial: true, pending: 5, lastProgress: 1 };
  t = 12001;                        // три интервала без единого прогресса
  tick();
  if (!notices.includes('network')) throw new Error('рекомендация о медленной сети не показана');
  if (Object.keys(tileset).length) throw new Error('доглядчик полез в сцену: ' + JSON.stringify(tileset));
  return true;
});
check('уведомления и контролы доступны и советуют низкое качество', () =>
  /id="perfText" role="status" aria-live="polite" aria-atomic="true"/.test(html) &&
  /id="perfClose"[^>]*aria-label="Закрыть рекомендацию"/.test(html) &&
  /id="dbg" role="region" aria-label="Диагностика 3D">\s*<div id="chunkStatus" hidden>/.test(html) &&
  /if \(App\.noGl \|\| App\.mode !== '3d'\) return;/.test(app) &&
  /fps: \{[^}]*Выберите низкое качество или откройте план/.test(app) &&
  /network: \{[^}]*Выберите низкое качество для медленного соединения/.test(app) &&
  /#perfClose \{[^}]*width: 44px; height: 44px/.test(css) &&
  /prefers-reduced-motion: reduce[\s\S]*?animation: none !important/.test(css));
check('закрытая рекомендация не возвращается при другом сбое и перезагрузке вкладки', () => {
  const nodes = new Map(), store = new Map();
  const env = browserEnv({
    $: id => { if (!nodes.has(id)) nodes.set(id, fakeNode()); return nodes.get(id); },
    App: { mode: '3d' }, QUALITY_PRESETS: {}, QUALITY_KEY: 'q',
    sessionStorage: { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) },
  });
  const quality = loadModule('src/quality.js', env);
  const box = env.$('perfNotice');
  box.hidden = true;
  quality.showPerfNotice('fps');
  if (box.hidden) throw new Error('рекомендация не открылась');
  let stayedOpen = false, focused = false;
  env.$('miQLow').focus = () => { focused = true; };
  env.$('perfClose').onclick({ stopPropagation: () => { stayedOpen = true; } });
  if (!stayedOpen || !focused) throw new Error('после закрытия совета фокус потерян');
  quality.showPerfNotice('network');
  if (!box.hidden) throw new Error('рекомендация вернулась после закрытия');
  const reloaded = loadModule('src/quality.js', env);
  reloaded.showPerfNotice('fps');
  return box.hidden;
});

/* ——— T38+T39: мобильная раскладка, FAB-меню, тач-полёт, мини-карта, дебаг ——— */
/* D2: кэш-бустинг — один и тот же токен на точке входа, CSS и всех межмодульных импортах.
   Разные токены означают «половина графа из старого кеша» — ровно тот регресс, что ловили
   с мёртвыми кнопками. Порог версии не смысл, а следствие: смысл в едином токене. */
const entryToken = (html.match(/<script type="module" src="\.\/src\/main\.js\?v=(\d+)"/) || [])[1];
const TOKEN = entryToken ? +entryToken : 0;
const portrait = css.match(/@media \(max-width: 640px\) and \(orientation: portrait\) \{[\s\S]*?\n\}/)?.[0] || '';
const narrow = css.match(/@media \(max-width: 900px\), \(pointer: coarse\) and \(max-height: 500px\) \{[\s\S]*?\n\}/)?.[0] || '';

check('кэш-бустинг: один токен ?v= на точке входа, CSS и всех импортах модулей', () => {
  if (!TOKEN) throw new Error('у точки входа нет ?v=N');
  const bad = [];
  for (const f of modules) {
    for (const m of read(f).matchAll(/from '(\.[^']*)'/g)) if (!/\?v=\d+$/.test(m[1])) bad.push(f + ': ' + m[1]);
  }
  for (const m of html.matchAll(/<link[^>]+href="\.\/styles\/[^"]*"/g)) if (!/\?v=\d+"/.test(m[0])) bad.push('css без токена: ' + m[0]);
  for (const m of html.matchAll(/<link[^>]+href="\.\/styles\/[^"]*\?v=(\d+)"/g)) if (+m[1] !== TOKEN) bad.push('css v=' + m[1]);
  for (const m of read('src/main.js').matchAll(/from '(\.[^']*)\?v=(\d+)'/g)) if (+m[2] !== TOKEN) bad.push('main v=' + m[2]);
  if (bad.length) throw new Error(bad.slice(0, 6).join(' · '));
  return true;
});
check('сброс исходного вида: строка меню настроек + клавиша R (U4→I1)', () =>
  /<button class="mi" id="miHome" role="menuitem">/.test(html) &&
  /<path d="M3 11\.5 12 4l9 7\.5"\/><path d="M5 10v9h14v-9"\/>/.test(html) &&
  /Исходный вид <span class="kbd">R<\/span>/.test(html) &&
  /function reset\(\) \{\r?\n\s*rig\.reset\(\)/.test(camera) &&
  /App\.CAM\.homePose\(HOME_POSE\);/.test(app) &&
  /code === 'KeyR'[\s\S]{0,140}doReset\(\);\s*return;/.test(camera) &&
  /\$\('miHome'\)\.onclick = \(\) => App\.CAM && App\.CAM\.reset\(\)/.test(app) &&
  /\$\('miHome'\)\.disabled = App\.noGl \|\| App\.mode !== '3d'/.test(app));
check('переключатель «Дебаг» в меню шестерёнки и состояние mam.dbg (U5→I1)', () =>
  /<button class="mi" id="miDbg" role="menuitemcheckbox" aria-checked="false"/.test(html) &&
  /<span class="sw"/.test(html) &&
  /const DBG_KEY = 'mam\.dbg'/.test(app) &&
  /localStorage\.setItem\(DBG_KEY, on \? '1' : '0'\)/.test(app) &&
  /if \(localStorage\.getItem\(DBG_KEY\) === '1'\) setDbg\(true\)/.test(app) &&
  /document\.body\.classList\.toggle\('dbg', on\)/.test(app));
check('панель #dbg: пять групп значений и обновление из postRender (U5)', () =>
  /<div id="dbg" role="region" aria-label="Диагностика 3D">/.test(html) &&
  ['dbgFps', 'dbgCanvas', 'dbgCam', 'dbgAngles', 'dbgFov'].every(id => hasId(id)) &&
  /function updateDbg\(\) \{[\s\S]*?dbgFps[\s\S]*?dbgCanvas[\s\S]*?dbgCam[\s\S]*?dbgAngles[\s\S]*?dbgFov/.test(app) &&
  /positionCartographic[\s\S]*?\+' \+ cc\.height\.toFixed\(1\) \+ ' м'/.test(app) &&
  /\$\(\'dbgAngles\'\)\.textContent[\s\S]*?курс [\s\S]*?наклон [\s\S]*?крен /.test(app) &&
  /cam\.frustum\.fov/.test(app) &&
  /updateReadout\(\);\r?\n\s*if \(document\.body\.classList\.contains\('dbg'\)\) updateDbg\(\);/.test(app) &&
  /viewer\.scene\.postRender\.addEventListener/.test(app) &&
  /if \(!document\.body\.classList\.contains\('dbg'\) \|\| App\.noGl \|\| !App\.viewer\) return/.test(app) &&
  /#dbg \{[^}]*width: 210px;[^}]*display: none/.test(css) &&
  /body\.dbg #dbg \{ display: block; \}/.test(css) &&
  /'miQLow', 'miQMid', 'miQHigh'\]/.test(app) && /syncItem\('miDbg', on\)/.test(app));
check('мини-карта #mm+#mmc: второй PlanPane с постоянным локальным охватом и объектами (N3)', () =>
  /<button id="mm" type="button" aria-label="Открыть 3D и план"[^>]*>\s*<canvas id="mmc" aria-hidden="true"><\/canvas>/.test(html) &&
  /App\.mmPlan = makePlan\(\$\('mmc'\), \{ radar: true, follow: false/.test(app) &&
  /radar: true, follow: false, rotOn: true, miniSpanM: 26/.test(app) &&
  /this\.opts\.miniSpanM \/ box\.width/.test(plan) &&
  /App\.mmPlan\.setFeatures\(out, style\)/.test(app) &&
  /if \(App\.mmPlan\) App\.mmPlan\.resize\(\)/.test(app) &&
  /for \(const id of \['map', 'plan', 'mm'\]\)/.test(app));
check('мини-карта видна только в полноэкранном 3D и не в сплите/2D (N3)', () =>
  /#miniNav \{[^}]*width: var\(--mm\); height: var\(--mm\);[^}]*display: none/.test(css) &&
  /:root \{[\s\S]*?--mm: 190px;/.test(css) &&
  /body\.full3d #miniNav \{ display: block; \}/.test(css) &&
  /document\.body\.classList\.toggle\('full3d', App\.mode === '3d' && !App\.split && !App\.noGl\)/.test(app) &&
  /body\.full3d \.hud \{ left: calc\(var\(--safe-l\) \+ var\(--mm\) \+ var\(--sp-2\)\); \}/.test(css) &&
  /body\.full3d \.hud \{ grid-template-rows: max\(var\(--mm\), 2 \* var\(--fab\) \+ var\(--sp-1\)\) minmax\(0, 1fr\) auto/.test(portrait) &&
  /:root \{ --mm: 132px; \}/.test(narrow));
check('луч взгляда на плане: rayEnd по печной сетке, отсечка RAY_MAX, точка удара и пунктир при промахе (N5→ADR-33)', () =>
  /function rayEnd\(\) \{[\s\S]*?pickCollision\(ray, RAY_MAX\)/.test(app) &&
  /Collision\.grid\.raycast\(o\.x, o\.y, o\.z, d\.x, d\.y, d\.z, maxDistance\)/.test(app) &&
  /Cesium\.Ray\.getPoint\(ray, Collision\.grid \? RAY_MAX : FRUSTUM_RANGE/.test(app) &&
  /if \(split && App\.plan\) \{\s*App\.plan\.setCamera\(\{ \.\.\.cam, rayEnd: rayEnd\(\), rayDist: rayCache\.dist \}\)/.test(app) && /App\.mmPlan\.setCamera\(cam\)/.test(app) &&
  /if \(this\.cam\.rayEnd\) \{[\s\S]*?ctx\.stroke\(\);[\s\S]*?ctx\.arc\(ex, ey, 3\.5/.test(plan) &&
  /ctx\.strokeStyle = '#4ad7ff'; ctx\.lineWidth = 1\.5/.test(plan) &&
  /if \(dist === null\) ctx\.setLineDash\(\[5, 4\]\)/.test(plan));
check('Два общих меню и отдельные кнопки камеры (U2)', () =>
  /<div id="fabCol">/.test(html) && ['fabMode', 'fabSet', 'camTools'].every(hasId) &&
  /<div id="modeMenu" class="menu" role="menu"/.test(html) &&
  /<div id="camTools" role="group"/.test(html) &&
  /<div id="setMenu" class="menu" role="menu"/.test(html) &&
  ['mi3d', 'miSplit', 'mi2d'].every(id => new RegExp('id="' + id + '" role="menuitemradio"').test(html)) &&
  /id="miOrbit" aria-pressed="true"/.test(html) && /id="miFly" aria-pressed="false"/.test(html) &&
  hasId('miHome') && /id="miDbg" role="menuitemcheckbox"/.test(html) && /<span class="sw"/.test(html) &&
  ['miOrtho', 'miQgis', 'miQLow', 'miQMid', 'miQHigh', 'miTut'].every(hasId) &&
  /class="msep"/.test(html));
check('FAB и меню: открытие-закрытие, Escape, тап мимо и синхронизация активности', () =>
  /const FAB_MENUS = \[\['fabMode', 'modeMenu'\], \['fabSet', 'setMenu'\]\]/.test(app) &&
  /function closeMenus\(\)[\s\S]*?classList\.remove\('open'\)[\s\S]*?aria-expanded', 'false'/.test(app) &&
  /const open = !\$\(menu\)\.classList\.contains\('open'\)/.test(app) &&
  /if \(!e\.target\.closest\('\.menu'\) && !e\.target\.closest\('\.fab'\)\) closeMenus\(\)/.test(app) &&
  /document\.addEventListener\('keydown', e => \{[\s\S]*?if \(e\.key !== 'Escape'\) return;[\s\S]*?menuOpen[\s\S]*?e\.stopPropagation\(\);[\s\S]*?closeMenus\(\);[\s\S]*?\}, true\)/.test(app) &&
  !/vpopOpen/.test(app) &&
  /function syncMenus\(\)[\s\S]*?syncItem\('mi3d'[\s\S]*?syncItem\('miSplit'[\s\S]*?syncItem\('mi2d'[\s\S]*?\$\('miOrbit'\)\.setAttribute\('aria-pressed'[\s\S]*?\$\('miFly'\)\.setAttribute\('aria-pressed'/.test(app) &&
  /\$\('miOrbit'\)\.onclick[\s\S]*?setMode\('orbit'\)/.test(app) &&
  /\$\('miFly'\)\.onclick[\s\S]*?setMode\('fly'\)/.test(app) &&
  /\$\('miOrtho'\)\.onclick[\s\S]*?setBase\('ortho'\)/.test(app) &&
  /\$\('miQgis'\)\.onclick[\s\S]*?setBase\('qgis'\)/.test(app) &&
  /\$\('miQLow'\)\.onclick[\s\S]*?setQuality\('light'\)/.test(app) &&
  /\$\('miTut'\)\.onclick[\s\S]*?tutShow\(\)/.test(app) &&
  /App\.syncMenus\(\);\r?\n\s*App\.updateFabTips\(\);/.test(app) &&
  /Object\.assign\(App, \{[\s\S]{0,300}syncMenus, syncItem, updateFabTips,/.test(app));
check('CSS: FAB и их меню — единственная система на всех экранах, нижней панели нет (I1)', () =>
  /\.hud \{[^}]*inset: var\(--fab-top\) var\(--safe-r\)[^}]*grid-template-columns: minmax\(0, 1fr\) auto max-content/.test(css) &&
  /#fabCol \{ grid-column: 3; grid-row: 1; display: flex/.test(css) &&
  /#fabCol \{ grid-column: 2; grid-row: 1; flex-direction: row/.test(portrait) &&
  /\.fab \{[^}]*width: var\(--fab\); height: calc\(var\(--fab\) - 4px\); min-height: 44px/.test(css) &&
  /\.menu \{ grid-column: 2; grid-row: 1;[^}]*display: none/.test(css) &&
  /\.menu \{ grid-column: 1 \/ -1; grid-row: 2;/.test(portrait) &&
  /\.menu\.open \{ display: flex; \}/.test(css) &&
  /\.mi \{[^}]*min-height: 46px/.test(css) &&
  /:root \{[\s\S]*?--menu-top: calc\(var\(--fab-top\) \+ var\(--fab-col-h\) \+ var\(--sp-2\)\)/.test(css) &&
  !/#status|#vpop|#camTag|#cameraMode|#viewSeg|#qualitySeg/.test(css) &&
  !/id="status"|id="vpop"|id="camTag"|id="viewSeg"|id="cameraMode"|id="qualitySeg"/.test(html));
check('значение режима — в подписи FAB и в строках меню, а не в постоянной строке (I5)', () =>
  /<button class="fab" id="fabMode" data-tip="Режим просмотра"/.test(html) &&
  /\.fab::after \{ content: attr\(data-tip\)/.test(css) &&
  /\.fab:hover::after, \.fab:focus-visible::after, \.fab\[aria-expanded="true"\]::after/.test(css) &&
  /function setFabTip\(id, text\) \{[\s\S]*?dataset\.tip[\s\S]*?aria-label/.test(app) &&
  /function updateFabTips\(\)[\s\S]*?setFabTip\('fabMode', 'Режим просмотра: '/.test(app) &&
  /updateFabTips\(\);/.test(app) &&
  /\.mi \.kbd \{/.test(css) && /<span class="kbd">1<\/span>/.test(html));
check('сплит ≤900px: 3D сверху, план снизу, равные половины, управление у своего вида', () => {
  /* инспектор атрибутов припаркован вместе с вектором (§ D9): его стили живут в vector.css,
     который не подключён, — проверяем, что они не потеряны, а не что они действуют */
  const parkedCss = fs.existsSync(path.join(root, 'styles/vector.css')) ? read('styles/vector.css') : '';
  return /body\.split3d #plan \{ left: 0; top: 50%; width: 100%; height: 50%;/.test(narrow) &&
    /body\.split3d #map \{ width: 100%; height: 50%; top: 0; \}/.test(narrow) &&
    /body\.split3d \.readout \{ bottom: max\(var\(--safe-b\), var\(--sp-2\)\)/.test(narrow) &&
    /body\.pure2d \.readout \{ bottom: var\(--safe-b\); \}/.test(narrow) &&
    /body\.split3d:not\(:has\(\.menu\.open\)\) #dbg \{ position: fixed; top: var\(--debug-top\);\s*left: var\(--safe-l\)/.test(narrow) &&
    /id="miFly"[^>]*>[\s\S]*?id="speedTag"[^>]*>[\s\S]*?<\/button>[\s\S]*?<div class="notice-stack"[^>]*>[\s\S]*?id="dbg"/.test(html) &&
    /#insp \{/.test(parkedCss) &&
    !/styles\/vector\.css/.test(html);
});
check('тач-полёт: #stick и #flyBtns в разметке, скрыты базово, видны в flytouch-полёте (N2)', () =>
  /<div id="stick" aria-hidden="true"><div class="knob"><\/div><\/div>/.test(html) &&
  /<div id="flyBtns">/.test(html) && ['flyUp', 'flyDown', 'flyRun'].every(hasId) &&
  /#stick \{[^}]*left: var\(--safe-l\); bottom: max\(var\(--sp-2\), var\(--safe-b\)\);[^}]*display: none/.test(css) &&
  /#flyBtns \{[^}]*right: var\(--safe-r\); bottom: max\(var\(--sp-2\), var\(--safe-b\)\);[^}]*display: none/.test(css) &&
  /body\.flytouch #stick \{ display: block; \}/.test(css) &&
  /body\.flytouch #flyBtns \{ display: flex; \}/.test(css) &&
  /const on = \(document\.body\.dataset\.cameraMode \|\| 'orbit'\) === 'fly' && CAMERA_TOUCH && App\.mode === '3d' && !App\.noGl;\r?\n\s*document\.body\.classList\.toggle\('flytouch', on\)/.test(app) &&
  /const stick = \$\('stick'\), knob = stick\.querySelector\('\.knob'\)/.test(app) &&
  /App\.CAM\.setStick\(dx \/ STICK_R, -dy \/ STICK_R\)/.test(app) &&
  /holdFlyButton\('flyUp', 1\)/.test(app) && /holdFlyButton\('flyDown', -1\)/.test(app) &&
  /App\.CAM\.setRun\(on\)/.test(app));
check('прицел остаётся в тач-полёте и прячется вне него', () =>
  /@media \(pointer: coarse\) \{[^}]*#speedTag \{ display: none; \}/.test(css) &&
  /body\[data-camera-mode="fly"\]:not\(\.flytouch\):not\(\.pure2d\):not\(\.nogl\) #flyCross \{ display: none; \}/.test(css) &&
  !/@media \(pointer: coarse\) \{[^}]*#flyCross, #speedTag/.test(css));
check('drag плана не двигает камеру: onView без panMain, камера ходит по тапу (N4)', () => {
  const mk = app.match(/function makePlan\(canvas, opts\) \{[\s\S]*?\n\}/)?.[0] || '';
  return /onView: \(\) => \{ updateReadout\(\); \}/.test(mk) && !/panMain\(-dLon/.test(mk) &&
    /onTapGround: geo =>/.test(mk) && /App\.CAM\.moveToGround\(lon, lat\)/.test(mk) &&
    /function moveToGround\(lon, lat\)[\s\S]*?rig\.setPose\(\{ lon, lat, h \}\)/.test(camera) &&
    /document\.body\.classList\.contains\('split3d'\)/.test(mk) &&
    /this\.pick\(e\);[\s\S]{0,300}if \(this\.opts\.onTapGround\) \{/.test(plan) &&
    /if \(geo\) this\.opts\.onTapGround\(geo\)/.test(plan);
});
check('обратная проекция тапа плана в гео-координаты', () =>
  /export function worldPxToLonLat\(x, y, z\)/.test(geo2d) &&
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
  /#plan \{[^}]*background: #edf0ea/.test(css) &&
  /ctx\.clearRect\(0, 0, r.width, r.height\)/.test(plan));
check('ошибки внизу, счётчик только в отладке, рекомендация внутри меню качества', () =>
  /<div class="hud">\s*<div class="notice-stack"[^>]*>[\s\S]*?id="dbg"[^>]*>\s*<div id="chunkStatus"[\s\S]*?id="setMenu"[\s\S]*?id="qualityMenuTitle"[\s\S]*?id="perfNotice"/.test(html) &&
  /\.notice-stack \{ grid-column: 1; grid-row: 1;[^}]*display: flex;\s*flex-direction: column/.test(css) &&
  /\.hud \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto max-content/.test(css) &&
  /\.menu \{ grid-column: 2; grid-row: 1;/.test(css) &&
  /#fabCol \{ grid-column: 3; grid-row: 1;/.test(css) &&
  /grid-template-rows: var\(--fab\) minmax\(0, 1fr\) auto/.test(portrait) &&
  /\.notice-stack \{ grid-column: 1 \/ -1; grid-row: 3;/.test(portrait) &&
  /\.menu \{ grid-column: 1 \/ -1; grid-row: 2;/.test(portrait));
check('обучение не перекрывает панели тач-полёта: с открытой карточкой они скрыты (проба раскладок 27.11)', () =>
  /body\.tutOn #stick, body\.tutOn #flyBtns,\r?\nbody:has\(#tut:not\(\[hidden\]\)\) #stick, body:has\(#tut:not\(\[hidden\]\)\) #flyBtns \{ display: none; \}/.test(css) &&
  /document\.body\.classList\.add\('tutOn'\)/.test(app) &&
  /document\.body\.classList\.remove\('tutOn'\)/.test(app));
check('справка даёт отдельные слайды мыши и тача для каждого вида карты', () => {
  const App = { CAMERA_TOUCH: true, mode: '3d' };
  const dom = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, fakeNode()]));
  const document = { body: { dataset: { cameraMode: 'orbit' } } };
  const { tutBuild } = loadModule('src/tutorial.js', { App, document, $: id => dom[id] });
  const mouse = () => dom.tutMousePanel.innerHTML;
  const touch = () => dom.tutTouchPanel.innerHTML;
  const has = (content, ...terms) => terms.every(term => content.includes(term));
  tutBuild();
  if (!dom.tutMousePanel.hidden || dom.tutTouchPanel.hidden ||
      !has(mouse(), 'левой кнопкой', 'правой кнопкой', 'колесо', 'Дважды щёлкните') ||
      !has(touch(), 'одним пальцем', 'два пальца', 'двумя пальцами', 'Дважды коснитесь', 'Исходный вид') ||
      /джойстик|кнопкой мыши/.test(touch()) || /пальцем/.test(mouse())) return false;
  document.body.dataset.cameraMode = 'fly';
  tutBuild();
  if (!has(mouse(), 'правой кнопкой', 'W', 'Shift', 'колесо') ||
      !has(touch(), 'пальцем', 'джойстик', '↑ и ↓', '×4', 'Исходный вид') ||
      /центр вращения/.test(touch())) return false;
  App.mode = '2d';
  tutBuild();
  return dom.tutSub.textContent === 'План сверху' && has(touch(), 'два пальца', 'К центру') &&
    has(mouse(), 'стрелки', 'Home') && !/джойстик|Полёт/.test(touch()) && !/camTag/.test(app) && !/id="camTag"/.test(html);
});

/* ——— T40 партия B2: тач-параллель, режим через 2D, меню ресурса, служебные слои ——— */
check('параллельный тач: чужой pointerdown чистит только клавиши, не жесты (ADR-33)', () =>
  /if \(e\.target !== canvas && e\.pointerType === 'touch'\) keys\.clear\(\);/.test(camera) &&
  /function clearKeys\(\) \{ keys\.clear\(\); \}/.test(camera) &&
  !/if \(e\.target !== canvas[\s\S]{0,40}\)(rig|this)\.(cancel|_clear|endGesture)/.test(camera));
check('зона свайпа взгляда — по фактическим DOM-контролам, а не по половине канваса', () =>
  /function inDomControl\(e\) \{/.test(camera) &&
  /querySelectorAll\('#stick, #flyBtns, #fabCol, \.menu, #miniNav, #fovCtl, #viewDock'\)/.test(camera) &&
  /if \(inDomControl\(e\)\) return;/.test(camera) &&
  /if \(!r\.width \|\| !r\.height\) continue;/.test(camera) &&
  !/rect\.width \/ 2/.test(camera));
check('режим камеры переживает заглядывание в 2D (аудит B1)', () =>
  /target: this\.v3\(this\.target\), mode: this\.mode/.test(camera) &&
  /if \(this\.saved2d\) \{[\s\S]{0,400}this\.mode = s\.mode;[\s\S]{0,700}\} else \{\r?\n\s*this\.mode = 'orbit';/.test(camera) &&
  /this\.syncFromCamera\(\);/.test(camera));
check('гибрид-устройство: dblclick после тача не дублирует двойной тап (аудит A8)', () =>
  /let touchAt = 0;/.test(camera) && /touchAt = performance\.now\(\);/.test(camera) &&
  /lastTouchAt\(\) \{ return touchAt; \}/.test(camera) &&
  /const lastTouch = getTouchAt\(\);\s*if \(lastTouch && performance\.now\(\) - lastTouch < 700\)/.test(camera) &&
  /on\(canvas, 'lostpointercapture', e => onPointerUp\(e, true\)/.test(camera));
check('в меню доступны два 3D-ресурса: 3D-модель и Gaussian Splatting', () =>
  !hasId('miAssetNone') && ['miAssetModel', 'miAssetSplat'].every(hasId) &&
  /role="menuitemradio"/.test(html) &&
  /function assetChoiceState\(\) \{[\s\S]*?App\.viewer\.splats && App\.viewer\.splats\.show[\s\S]*?App\.viewer\.tileset && App\.viewer\.tileset\.show/.test(app) &&
  /function setAssetChoice\(kind\) \{[\s\S]*?toggleAsset\(kind === 'splat' \? 'splats' : 'tileset'\)/.test(app) &&
  // реализация выбора ресурса ровно одна: меню только вызывает её — две копии расходятся при первой
  // же правке (дубликат в menus.js уже был найден аудитом)
  !/function setAssetChoice/.test(read('src/menus.js')) &&
  /\$\('miAssetSplat'\)\.onclick[\s\S]*?setAssetChoice\('splat'\)/.test(app) &&
  /\$\('miAssetModel'\)\.onclick[\s\S]*?setAssetChoice\('model'\)/.test(app) &&
  /syncItem\('miAssetModel', asset === 'model'\)/.test(app) &&
  /syncItem\('miAssetSplat', asset === 'splat'\)/.test(app) &&
  /row: 'miAssetModel'/.test(app) && /row: 'miAssetSplat'/.test(app) &&
  /<span class="lbl">3D-модель<\/span>/.test(html) && /<span class="lbl">Gaussian Splatting<\/span>/.test(html) &&
  /row\.querySelector\('\.lbl'\)\.textContent/.test(app) &&
  /if \(App\.noGl\) row\.title = '3D недоступен: нет WebGL';/.test(app));
check('взаимоисключение ресурсов применяется до загрузки — двоения нет (аудит B-2)', () =>
  /for \(const other of Object\.keys\(ASSET_CFG\)\) if \(other !== slot && App\.viewer\[other\]\) App\.viewer\[other\]\.show = false;\r?\n\s*syncGlobeVisibility\(\);\r?\n\s*const ts = await ensureAsset\(slot\)/.test(app));
check('панели тач-полёта гасятся в 2D и без WebGL: класс из applyViewClasses + страховка CSS (аудит A2)', () =>
  /export function syncFlyTouch\(\) \{[\s\S]{0,240}document\.body\.classList\.toggle\('flytouch', on\)/.test(read('src/state.js')) &&
  // предиката ровно одна: и смена вида, и состояние камеры зовут syncFlyTouch, а не копируют условие
  (app.match(/classList\.toggle\('flytouch'/g) || []).length === 1 &&
  /syncFlyTouch\(\);/.test(read('src/readout.js')) &&
  /body\.pure2d #stick, body\.pure2d #flyBtns, body\.nogl #stick, body\.nogl #flyBtns \{ display: none; \}/.test(css));
check('план: capture не роняет жест, lostpointercapture чистит состояние, клавиши не дублируют 3D (аудит A5-A7)', () =>
  /try \{ this\.c\.setPointerCapture\(e\.pointerId\); \} catch \(err\) \{\}/.test(plan) &&
  /this\.c\.addEventListener\('lostpointercapture', e => \{/.test(plan) &&
  /e\.preventDefault\(\);\r?\n\s*e\.stopPropagation\(\);/.test(plan));
check('служебные слои и канвас мини-карты пропускают касания; кнопка раскрывает план, рекомендацию можно закрыть', () =>
  /#mm canvas \{ pointer-events: none;/.test(css) && /\$\('mm'\)\.onclick[\s\S]*?setView\('3d', true\)/.test(app) &&
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

check('Загрузчик: обработчики камеры не трогают let/const из TDZ (регресс 26.11 — пустая карта и мёртвые кнопки)', () => {
  // регресс 26.11: onState конструктора камеры вызывается ещё до конца файла. Если он (или
  // функция, до которой доходит рука) читает let/const, объявленный ниже по файлу, — ReferenceError
  // в TDZ, и весь загрузчик падает: ни подложки, ни тайлсета, ни обработчиков меню. Статические
  // проверки текста этого не ловят, поэтому проверка порядка объявлений в файле, где камера
  // создаётся (src/main.js), плюс guard флагом App.booted в модулях, куда ведут колбэки.
  const main = read('src/main.js');
  const bootAt = main.indexOf('App.CAM = createController(');
  if (bootAt < 0) throw new Error('нет создания камеры');
  const decls = new Map();                       // имя let/const → позиция объявления в main.js
  for (const m of main.matchAll(/^(?:let|const)\s+([A-Za-z_$][\w$]*)/gm))
    if (!decls.has(m[1])) decls.set(m[1], m.index);
  const late = new Set([...decls].filter(([, at]) => at > bootAt).map(([name]) => name));
  const blockEnd = main.indexOf('\n  });', bootAt);
  if (blockEnd < 0) throw new Error('блок createController не найден');
  const called = new Set([...main.slice(bootAt, blockEnd).matchAll(/\b([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
  for (const name of called)
    if (late.has(name)) throw new Error('колбэк камеры вызывает ' + name + ', объявленный после создания камеры');
  if (!/booted: false,/.test(app)) throw new Error('нет флага booted');
  const setAt = main.indexOf('App.booted = true;');
  if (setAt < 0) throw new Error('booted никогда не выставляется');
  const lastDecl = Math.max(...decls.values());
  if (setAt < lastDecl) throw new Error('App.booted выставляется до последнего объявления верхнего уровня');
  for (const file of ['src/state.js', 'src/readout.js'])
    if (!/if \(!App\.booted\) return;/.test(read(file)))
      throw new Error(file + ': обработчик состояния рисует UI без guard\'а App.booted');
  return true;
});

check('FAB: меню открывается на pointerdown, а не только на click (регресс 26.11, тач)', () =>
  /\$\(fab\)\.onpointerdown = \(\) => \{ fabPressed\.add\(fab\); toggleMenu\(fab, menu\); \};/.test(app) &&
  /if \(fabPressed\.has\(fab\)\) \{ fabPressed\.delete\(fab\); return; \}/.test(app));

check('состояние rig доходит до readout аргументом: data-camera-mode ставится (регресс 27.11 — панели полёта на таче)', () =>
  /onState: st => \{ updateCameraState\(st\); invalidateRay\(\); \}/.test(read('src/main.js')) &&
  /export function updateCameraState\(state\) \{\s*document\.body\.dataset\.cameraMode = state\.mode;/.test(read('src/readout.js')) &&
  /_emitState\(\) \{ this\.onState\(\{ mode: this\.mode, speed: this\.speed, run: this\.run, touch: this\.touchOnly\(\) \}\); \}/.test(read('src/camera/rig.js')));

check('Подпись FAB видна только на устройствах с курсором (регресс 26.11: тап рисовал «НАСТРОЙКИ»)', () =>
  /@media \(hover: hover\) \{\s*\.fab:hover::after/.test(css));

check('Свет направленный, без динамической карты окружения (IBL-префильтры валятся на слабом GPU)', () =>
  /scene\.light = new Cesium\.DirectionalLight\(/.test(app) &&
  !/environmentTexture|specularEnvironmentMaps|enableLighting = true/.test(app));

check('Обвязка сцены не роняет старт 3D: fxaa из postProcessStages, необязательные слои под if (регресс 27.11)', () =>
  /scene\.postProcessStages\.fxaa\.enabled = false/.test(app) &&
  !/scene\.fxaa/.test(app) &&
  /try \{ scene\.msaaSamples = 1; \} catch/.test(app) &&
  /if \(scene\.skyAtmosphere\) scene\.skyAtmosphere\.show = false/.test(app) &&
  /if \(scene\.sun\) scene\.sun\.show = false/.test(app) &&
  /catch \(e\) \{ \/\* сборка без DirectionalLight/.test(app));

check('3D-модель грузится до сетки коллизии, а её отказ не обрывает загрузчик (регресс 26.11, «3Д МОДЕЛЕЙ НЕТ»)', () => {
  const model = app.indexOf("await toggleAsset('tileset')");
  const col = app.indexOf('await Collision.load(');
  return model > 0 && col > model && /try \{\s*await Collision\.load\(/.test(app);
});

check('Углы в отладке заворачиваются в диапазон (на телефоне было «крен 360°» при ровном экране)', () =>
  /wrap\(deg\(cam\.roll\)\)/.test(app) && /wrap\(deg\(cam\.pitch\)\)/.test(app));

check('Кнопка справки Cesium выключена: navigationHelpButton не рисует устаревшую справку поверх UI (26.11)', () =>
  /navigationHelpButton: false/.test(app));

check('Сбой загрузки виден на экране: error и unhandledrejection показывают toast (регресс 26.11)', () =>
  /addEventListener\('error', e => \{/.test(app) && /addEventListener\('unhandledrejection', e => \{/.test(app));

check('≤900px: контролы верхней половины не перекрывают кнопки полёта', () =>
  /#fovCtl \{ top: auto; bottom: calc\(var\(--sp-2\) \+ var\(--fab-col-h\) \+ var\(--sp-2\)\); transform: none; \}/.test(narrow) &&
  /body\.split3d #fovCtl \{ top: auto; bottom: calc\(50% \+ var\(--sp-2\)\); right: var\(--safe-r\); \}/.test(narrow) &&
  /body\.split3d:not\(:has\(\.menu\.open\)\) #dbg \{ position: fixed; top: var\(--debug-top\);\s*left: var\(--safe-l\)/.test(narrow) &&
  /id="miFly"[^>]*>[\s\S]*?id="speedTag"[^>]*>[\s\S]*?<\/button>[\s\S]*?<div class="notice-stack"[^>]*>[\s\S]*?id="dbg"/.test(html) &&
  /body\.full3d #flyBtns \{ flex-direction: row; \}/.test(css) &&
  // панель инспектора припаркована (SHOW_VECTOR_LAYERS = false): в живой сетке её правил нет
  !/#insp/.test(narrow) &&
  !/#fovCtl[^{]*\{[^}]*top: 75%/.test(narrow));

check('контекстное меню ограничено свободной высотой своей ячейки и прокручивается (аудит A3)', () =>
  /\.hud \{ position: fixed; inset: var\(--fab-top\) var\(--safe-r\) max\(var\(--sp-2\), var\(--safe-b\)\) var\(--safe-l\)/.test(css) &&
  /\.menu \{[^}]*min-height: 0; max-height: 100%;[^}]*overflow-y: auto/.test(css) &&
  /grid-template-rows: var\(--fab\) minmax\(0, 1fr\) auto/.test(portrait));

check('слайдер FOV на ПК остаётся читаемым в покое, в сплите расположен внутри 3D-вида', () =>
  /<div id="fovCtl">\s*<b id="fovVal">86°<\/b>/.test(html) &&
  /id="fovSl" min="30" max="120" value="86"/.test(html) &&
  /#fovCtl \{[^}]*right: var\(--safe-r\); top: 50%;[^}]*opacity: \.9/.test(css) &&
  /#fovCtl\.hot \{ opacity: 1; \}/.test(css) &&
  /#fovCtl\.off, body\.pure2d #fovCtl, body\.nogl #fovCtl \{ display: none; \}/.test(css) &&
  /body\.split3d #fovCtl \{ right: calc\(50% \+ var\(--sp-2\)\); \}/.test(css) &&
  /body\.split3d #fovCtl \{ top: auto; bottom: calc\(50% \+ var\(--sp-2\)\); right: var\(--safe-r\); \}/.test(narrow) &&
  /function fovPulse\(\)[\s\S]*?classList\.add\('hot'\)[\s\S]*?remove\('hot'\), 2200\)/.test(app) &&
  /function updateFovCtl\(\)[\s\S]*?classList\.toggle\('off', !on\)/.test(app) &&
  /\$\('fovSl'\)\.oninput = \$\('lensRange'\)\.oninput = e => changeFov\(\+e\.target\.value\)/.test(app) &&
  /\$\('fovCtl'\)\.addEventListener\('pointerenter', fovPulse\)/.test(app));

check('раскладка и FOV переживают перезагрузку; клавиши вида 1/2/3 работают (I1, B5)', () =>
  /const VIEW_KEY = 'mam\.view'/.test(app) &&
  /const v = JSON\.stringify\(\{ mode: App\.mode, split: App\.split \}\);[\s\S]{0,400}localStorage\.setItem\(VIEW_KEY, v\)[\s\S]{0,400}sessionStorage\.setItem\(VIEW_KEY, v\)/.test(app) &&
  // и запись, и чтение: без чтения телефон каждый раз открывал «Только 3D» (потерялось при
  // разнесении модулей — запись осталась, getItem исчез из кода).
  // ADR-37: «Только план» возвращается только той же вкладкой (sessionStorage), новая встреча
  // с сайтом обязана открыться в 3D со сплатами.
  /const v = JSON\.parse\(localStorage\.getItem\(VIEW_KEY\)\);[\s\S]{0,400}App\.mode = v\.mode; App\.split = !!v\.split;/.test(app) &&
  /if \(v\.mode === '2d' && !\(s && s\.mode === '2d'\)\) \{ App\.mode = '3d'; App\.split = false; \}/.test(app) &&
  /if \(NO_GL\) App\.mode = '2d';/.test(app) &&
  /saveViewPrefs\(\)/.test(app) &&
  /const FOV_KEY = 'mam\.fov'/.test(app) &&
  /localStorage\.setItem\(FOV_KEY, String\(/.test(app) &&
  // 1·2·3 и V·F — те же действия, что пункты меню: клавиши разбирает input.js, вид меняет main.js
  /if \(\['Digit1', 'Digit2', 'Digit3'\]\.includes\(code\) && !modalOpen\(\)\)/.test(camera) &&
  /onViewKey: n => \{\s*closeMenus\(\);\s*setView\(n === 3 \? '2d' : '3d', n === 2\)/.test(app) &&
  /const modalOpen = \(\) => \{ const t = document\.getElementById\('tut'\); return !!t && !t\.hidden; \};/.test(camera) &&
  /if \(modalOpen\(\)\) return;/.test(camera));

check('клавиши вида 1·2·3 работают и в плане: они разбираются до gate usable() (регресс 27.11)', () => {
  const fn = camera.indexOf('function onKeyDown');
  const body = fn < 0 ? '' : camera.slice(fn, fn + 4000);
  const viewAt = body.indexOf("['Digit1', 'Digit2', 'Digit3']");
  const gateAt = body.indexOf('if (!usable()) return;');
  const keyAt = body.indexOf("code === 'KeyV'");
  return viewAt > 0 && gateAt > viewAt && keyAt > gateAt;
});

check('стартовый вид, исходная точка и FOV — значения владельца с панели дебага (26.11)', () =>
  /const HOME_POSE = \{ lon: 37\.480054, lat: 55\.673387, h: 3\.1, heading: 130, pitch: -2, roll: 0 \}/.test(app) &&
  /const FOV_DEFAULT = 86/.test(app) &&
  /App\.CAM\.setPose\(HOME_POSE\);/.test(app) &&
  /target: homePosition\(\)/.test(app) &&
  // цель домашнего вида строит rig: позиция + направление взгляда × расстояние. Своя копия цели
  // в config.js расходилась с rig'ом и уже не вызывается.
  /setPose\(\{ lon, lat, h, heading, pitch \}\) \{[\s\S]{0,300}this\._deriveTarget\(\);/.test(camera) &&
  /_deriveTarget\(\) \{[\s\S]*?this\.add\(this\.pos, this\.scale\(this\._dirToWorld\(enu, this\._forwardLocal\(\)\), d\)\)/.test(camera) &&
  !/homeTarget\(/.test(app) &&
  /let savedFov = FOV_DEFAULT;[\s\S]{0,200}setFov\(savedFov\)/.test(app) &&
  /viewer\.camera\.frustum\.fov !== undefined\) \{ viewer\.camera\.frustum\.fov = f/.test(app) &&
  /cam\.frustum\.fov === undefined \? '—' : deg\(cam\.frustum\.fov\)/.test(app) &&
  /id="fovSl"[^>]*value="86"/.test(html));

check('порт не оставил ссылок на чужие экспорты без импорта (регресс 27.11: plans.js трогал Collision.grid без импорта)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'port_reference_check.mjs')], { cwd: root, encoding: 'utf8' });
  return r.status === 0;
});

console.log('ИТОГ:', passed + '/' + (passed + failed) + ' passed,' , failed + ' failed');
process.exitCode = failed ? 1 : 0;
