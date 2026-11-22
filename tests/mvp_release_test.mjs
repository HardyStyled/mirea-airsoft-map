import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
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
check('физика ходьбы и collision не остаются в runtime', () =>
  !/(?:startWalk|stopWalk|walkTick|collision\.bin|requestPointerLock|App\.walk)/.test(app));
check('свободная камера использует WASD и Q/E', () =>
  /KeyW[\s\S]*KeyA[\s\S]*KeyS[\s\S]*KeyD[\s\S]*KeyQ[\s\S]*KeyE/.test(app) &&
  /cam\.moveForward/.test(app) && /cam\.moveRight/.test(app));
check('R поддерживает key и code', () => /KEY_FALLBACK[\s\S]*r: 'KeyR'/.test(app) && /freeKeyCode\(e\)/.test(app));
check('колесо двигает камеру с соблюдением min/max distance', () =>
  /const candidate[\s\S]*?minDistance[\s\S]*?maxDistance[\s\S]*?crossesMin[\s\S]*?crossesMax[\s\S]*?cam\.position = candidate/.test(app));
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
check('ширина линейки ограничена в CSS', () => /#sbarBar \{ max-width: 160px; \}/.test(css));

const scaleSource = app.match(/function scaleForMpp\(mpp\) \{[\s\S]*?\n\}/)?.[0];
check('чистая функция масштаба найдена', () => !!scaleSource);
const scaleForMpp = scaleSource ? new Function('return (' + scaleSource.replace('function scaleForMpp', 'function') + ')')() : null;
check('масштаб остаётся в 40–160 px на 36 порядках величины', () => {
  if (!scaleForMpp) return false;
  for (let exp = -6; exp <= 6; exp++) {
    for (const multiplier of [0.5, 1, 1.5, 2.37, 4.99, 9.99]) {
      const mpp = multiplier * 10 ** exp;
      const scale = scaleForMpp(mpp);
      if (!Number.isFinite(scale.px) || !Number.isFinite(scale.meters) || scale.meters <= 0 || scale.px < 40 || scale.px > 160) {
        throw new Error('mpp=' + mpp + ' → ' + JSON.stringify(scale));
      }
    }
  }
  return true;
});
check('масштаб использует круглый ряд 1/2/5', () => {
  if (!scaleForMpp) return false;
  for (const mpp of [0.001, 0.07, 0.21, 1, 13, 1000]) {
    const { meters } = scaleForMpp(mpp);
    const normalized = meters / 10 ** Math.floor(Math.log10(meters));
    if (![1, 2, 5, 10].includes(normalized)) throw new Error('mpp=' + mpp + ', meters=' + meters);
  }
  return true;
});
check('некорректный mpp даёт безопасный fallback', () => {
  if (!scaleForMpp) return false;
  return [0, -1, NaN, Infinity, -Infinity].every(v => {
    const scale = scaleForMpp(v);
    return scale.meters === 10 && scale.px === 100;
  });
});

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

console.log('ИТОГ:', passed + '/' + (passed + failed) + ' passed,' , failed + ' failed');
process.exitCode = failed ? 1 : 0;
