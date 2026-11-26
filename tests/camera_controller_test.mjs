import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'camera.js'), 'utf8');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '—', e.stack || e.message); }
}
function assert(value, message) { if (!value) throw new Error(message || 'assertion'); }
function near(a, b, eps, message) { if (Math.abs(a - b) > (eps ?? 1e-6)) throw new Error(`${message || 'not near'}: ${a} != ${b}`); }

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static clone(v) { return new V3(v.x, v.y, v.z); }
  static add(a, b, out) { out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z; return out; }
  static subtract(a, b, out) { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; }
  static multiplyByScalar(v, k, out) { out.x = v.x * k; out.y = v.y * k; out.z = v.z * k; return out; }
  static normalize(v, out) { const n = Math.hypot(v.x, v.y, v.z) || 1; out.x = v.x / n; out.y = v.y / n; out.z = v.z / n; return out; }
  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static cross(a, b, out) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    out.x = x; out.y = y; out.z = z; return out;
  }
  static fromDegrees(lon, lat, height = 0) { return new V3(lon * 100000, lat * 100000, height); }
}
V3.UNIT_Z = Object.freeze(new V3(0, 0, 1));
V3.UNIT_Y = Object.freeze(new V3(0, 1, 0));
class V2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class M4 {
  constructor(origin) { this.origin = origin || new V3(); }
  static inverse(m, out) { out.origin = new V3(-m.origin.x, -m.origin.y, -m.origin.z); return out; }
  static multiplyByPoint(m, v, out) { return V3.add(m.origin, v, out); }
  static multiplyByPointAsVector(m, v, out) { out.x = v.x; out.y = v.y; out.z = v.z; return out; }
}
const Cesium = {
  Cartesian2: V2, Cartesian3: V3, Matrix4: M4,
  Transforms: { eastNorthUpToFixedFrame: origin => new M4(V3.clone(origin)) },
  Cartographic: { fromCartesian: p => ({ longitude: p.x / 100000 * Math.PI / 180, latitude: p.y / 100000 * Math.PI / 180, height: p.z }) },
};

function eventTarget(extra = {}) {
  const listeners = {};
  return Object.assign({
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(x => x !== fn); },
    fire(type, props = {}) {
      const e = Object.assign({ type, target: this, preventDefault() {}, stopImmediatePropagation() {} }, props);
      for (const fn of [...(listeners[type] || [])]) fn(e);
    },
    listeners,
  }, extra);
}

function setup(options = {}) {
  let now = 1000;
  let touch = !!options.touch;
  const document = eventTarget({
    hidden: false,
    /* контролы, которые камера обязана обходить свайпом взгляда (ADR-33): [{rect}] */
    querySelectorAll: () => (options.controls || []).map(rect => ({
      offsetParent: {}, getBoundingClientRect: () => rect,
    })),
  });
  const window = eventTarget();
  const canvas = eventTarget({
    clientWidth: 800, clientHeight: 600, style: {}, tabIndex: -1,
    setPointerCapture() {}, focus() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  const camera = {
    frustum: { fov: Math.PI / 3, fovy: Math.PI / 3 },
    setView(view) {
      this.position = V3.clone(view.destination);
      const o = view.orientation;
      if (o.direction) {
        this.direction = V3.normalize(o.direction, new V3());
        this.right = V3.normalize(V3.cross(this.direction, o.up, new V3()), new V3());
        this.up = V3.normalize(V3.cross(this.right, this.direction, new V3()), new V3());
      } else throw new Error('test camera expects direction/up');
    },
    getPickRay() { return { origin: V3.clone(this.position), direction: V3.clone(this.direction) }; },
  };
  const extent = { w: 37.479587839, s: 55.672218962, e: 37.482130196, n: 55.673727617 };
  const lon = (extent.w + extent.e) / 2, lat = (extent.s + extent.n) / 2;
  const target = V3.fromDegrees(lon, lat, 0);
  camera.position = V3.fromDegrees(lon, lat - 0.00125, options.height ?? 140);
  camera.setView({ destination: camera.position, orientation: { direction: V3.subtract(target, camera.position, new V3()), up: V3.UNIT_Z } });
  let pick = null;
  const scene = {
    screenSpaceCameraController: { enableInputs: true }, pickPositionSupported: true,
    pickPosition: () => pick && V3.clone(pick), pickFromRay: () => null,
    requestRender() { this.renders = (this.renders || 0) + 1; },
  };
  const viewer = { camera, scene, canvas };
  const context = {
    Cesium, window, document, console,
    performance: { now: () => now },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const states = [];
  const controller = new context.window.CameraController({
    Cesium, viewer, extent, target, autoStart: false,
    touchOnly: () => touch, reducedMotion: () => !!options.reducedMotion,
    onState: state => states.push({ ...state }),
  });
  return {
    controller, camera, scene, canvas, document, window, states, target, extent,
    setPick(value) { pick = value; },
    tick(ms = 50) { now += ms; controller.tick(now); },
    advance(frames = 20, ms = 50) { for (let i = 0; i < frames; i++) { now += ms; controller.tick(now); } },
    key(key, extra = {}) {
      const code = extra.code || ({ w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', r: 'KeyR' }[key] || key);
      document.fire('keydown', { key, code, target: canvas, ...extra });
    },
    keyUp(key, extra = {}) {
      const code = extra.code || ({ w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE' }[key] || key);
      document.fire('keyup', { key, code, target: canvas, ...extra });
    },
    pointer(type, props = {}) { canvas.fire(type, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200, ...props }); },
    wheel(deltaY) { canvas.fire('wheel', { deltaY, deltaMode: 0 }); },
  };
}
const dist = (a, b) => V3.distance(a, b);
const moved = (a, b) => dist(a, b) > 1e-5;
const radius = t => dist(t.camera.position, t.controller.target);

check('старт: Orbit, Cesium inputs отключены, исходный target', t => {
  const x = setup();
  assert(x.controller.mode === 'orbit');
  assert(x.scene.screenSpaceCameraController.enableInputs === false);
  near(radius(x), dist(x.camera.position, x.target), 1e-8);
});

check('Orbit: ЛКМ вращает без изменения radius и target', () => {
  const x = setup(), before = radius(x), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 260, clientY: 220 }); x.pointer('pointerup');
  near(radius(x), before, 1e-6); near(dist(target, x.controller.target), 0, 1e-9);
  assert(moved(direction, x.camera.direction), 'направление не изменилось');
});

check('Orbit: горизонталь инвертирована — сцена идёт за курсором (решение владельца 25.11)', () => {
  const x = setup(), p = V3.clone(x.camera.position), r = radius(x), target = V3.clone(x.controller.target);
  assert(x.camera.right.x > 0, 'в тестовой сцене экранное «вправо» смотрит на восток');
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 260, clientY: 200 }); x.pointer('pointerup');
  assert(x.camera.position.x < p.x - 1, 'тяга вправо не уводит камеру на запад — сцена едет против курсора');
  near(x.camera.position.z, p.z, 1e-6, 'чисто горизонтальная тяга изменила высоту');
  near(radius(x), r, 1e-6); near(dist(target, x.controller.target), 0, 1e-9);
});

check('Orbit: стрелка вправо вращает сцену в ту же сторону, что и тяга вправо', () => {
  const a = setup(), b = setup();
  const ax = a.camera.position.x, bx = b.camera.position.x;
  a.pointer('pointerdown'); a.pointer('pointermove', { clientX: 260, clientY: 200 }); a.pointer('pointerup');
  b.key('ArrowRight');
  assert(a.camera.position.x < ax && b.camera.position.x < bx, 'знак горизонтального вращения разошёлся у мыши и клавиатуры');
});

check('Orbit: вертикаль остаётся «сцена за курсором» — тяга вниз поднимает камеру', () => {
  const x = setup(), p = V3.clone(x.camera.position), r = radius(x);
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 200, clientY: 260 }); x.pointer('pointerup');
  assert(x.camera.position.z > p.z + 1, 'тяга вниз не подняла камеру');
  near(radius(x), r, 1e-6, 'вертикальная тяга изменила дистанцию');
});

check('Orbit: ПКМ pan переносит камеру и target на один offset', () => {
  const x = setup(), p = V3.clone(x.camera.position), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.pointer('pointerdown', { button: 2 }); x.pointer('pointermove', { button: 2, clientX: 240, clientY: 230 }); x.pointer('pointerup', { button: 2 });
  const dp = V3.subtract(x.camera.position, p, new V3()), dt = V3.subtract(x.controller.target, target, new V3());
  near(dist(dp, dt), 0, 1e-6); assert(moved(p, x.camera.position)); near(dist(direction, x.camera.direction), 0, 1e-8);
});

check('Orbit: колесо меняет только дистанцию', () => {
  const x = setup(), before = radius(x), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.wheel(-120);
  assert(radius(x) < before, 'колесо вверх не приблизило'); near(dist(target, x.controller.target), 0, 1e-9);
  near(dist(direction, x.camera.direction), 0, 1e-8);
});

check('Double click: промах не двигает камеру и target', () => {
  const x = setup(), p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  canvasDoubleClick(x);
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
});
function canvasDoubleClick(x, clientX = 260, clientY = 240) { x.canvas.fire('dblclick', { clientX, clientY }); }

check('Double click: tween идёт через промежуток и сохраняет дистанцию/направление', () => {
  const x = setup(), hit = V3.add(x.controller.target, new V3(20, 10, 5), new V3());
  x.setPick(hit);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  const expected = V3.add(hit, V3.subtract(p, target, new V3()), new V3());
  canvasDoubleClick(x);
  assert(x.controller.focus, 'анимация не создана');
  x.tick(200);
  assert(moved(p, x.camera.position), 'нет промежуточного движения');
  assert(dist(x.camera.position, expected) > 1e-4, 'tween завершился мгновенно');
  near(radius(x), dist(p, target), 1e-6); near(dist(direction, x.camera.direction), 0, 1e-8);
  x.tick(200);
  near(dist(x.camera.position, expected), 0, 1e-6); near(dist(hit, x.controller.target), 0, 1e-6);
  near(dist(direction, x.camera.direction), 0, 1e-8); assert(!x.controller.focus);
});

check('Double click: reduced motion завершает focus сразу', () => {
  const x = setup({ reducedMotion: true }), hit = V3.clone(x.target); x.setPick(hit);
  canvasDoubleClick(x); assert(!x.controller.focus); near(dist(hit, x.controller.target), 0, 1e-6);
});

check('Focus: новый ввод отменяет tween без позднего скачка', () => {
  const x = setup(), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  canvasDoubleClick(x); x.tick(100); x.wheel(-100); const p = V3.clone(x.camera.position);
  assert(!x.controller.focus); x.advance(10); near(dist(p, x.camera.position), 0, 1e-6);
});

check('Вход в Fly не меняет position/direction', () => {
  const x = setup(), p = V3.clone(x.camera.position), d = V3.clone(x.camera.direction);
  x.controller.setMode('fly');
  assert(x.controller.mode === 'fly'); near(dist(p, x.camera.position), 0, 1e-9); near(dist(d, x.camera.direction), 0, 1e-9);
});

check('Fly: взгляд только во время ПКМ-drag', () => {
  const x = setup(); x.controller.setMode('fly');
  const d = V3.clone(x.camera.direction);
  x.pointer('pointermove', { clientX: 280, clientY: 220 }); near(dist(d, x.camera.direction), 0, 1e-9);
  x.pointer('pointerdown', { button: 2 }); x.pointer('pointermove', { button: 2, clientX: 260, clientY: 230 });
  assert(moved(d, x.camera.direction)); x.pointer('pointerup', { button: 2 });
});

check('Fly: скорость не зависит от высоты', () => {
  const low = setup({ height: 10 }), high = setup({ height: 300 });
  for (const x of [low, high]) { x.controller.setMode('fly'); x.key('w'); x.advance(); x.keyUp('w'); }
  const dl = dist(V3.fromDegrees((low.extent.w + low.extent.e) / 2, (low.extent.s + low.extent.n) / 2 - 0.00125, 10), low.camera.position);
  const dh = dist(V3.fromDegrees((high.extent.w + high.extent.e) / 2, (high.extent.s + high.extent.n) / 2 - 0.00125, 300), high.camera.position);
  near(dl, 6, 1e-5); near(dh, 6, 1e-5); near(dl, dh, 1e-8);
});

check('Fly: диагональ нормализована', () => {
  const x = setup(), p = V3.clone(x.camera.position); x.controller.setMode('fly');
  x.key('w'); x.key('d'); x.advance(); x.keyUp('w'); x.keyUp('d');
  near(dist(p, x.camera.position), 6, 1e-5);
});

check('Fly: Shift даёт ровно ×4', () => {
  const x = setup(), p = V3.clone(x.camera.position); x.controller.setMode('fly');
  x.key('w'); x.document.fire('keydown', { key: 'Shift', code: 'ShiftLeft', target: x.canvas }); x.advance();
  near(dist(p, x.camera.position), 24, 1e-5);
});

check('Fly: E поднимает по локальной вертикали', () => {
  const x = setup(), z = x.camera.position.z; x.controller.setMode('fly'); x.key('e'); x.advance(); x.keyUp('e');
  near(x.camera.position.z - z, 6, 1e-5);
});

check('Fly: колесо меняет скорость, но не позицию', () => {
  const x = setup(), p = V3.clone(x.camera.position); x.controller.setMode('fly'); const speed = x.controller.speed;
  x.wheel(-120); assert(x.controller.speed > speed); near(dist(p, x.camera.position), 0, 1e-9);
  assert(x.states.at(-1).speed === x.controller.speed);
});

check('Выход из Fly: raycast-target меняется без движения камеры', () => {
  const x = setup(), hit = V3.add(x.target, new V3(10, 10, 2), new V3()); x.controller.setMode('fly');
  const p = V3.clone(x.camera.position), d = V3.clone(x.camera.direction); x.setPick(hit); x.controller.setMode('orbit');
  near(dist(hit, x.controller.target), 0, 1e-6); near(dist(p, x.camera.position), 0, 1e-9); near(dist(d, x.camera.direction), 0, 1e-9);
  const r = radius(x); x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 230 }); x.pointer('pointerup'); near(radius(x), r, 1e-6);
});

check('Выход из Fly: промах ставит target впереди на прежней дистанции', () => {
  const x = setup(), before = radius(x); x.controller.setMode('fly'); const p = V3.clone(x.camera.position);
  x.controller.setMode('orbit');
  near(radius(x), before, 1e-6); near(dist(p, x.camera.position), 0, 1e-9);
  const expected = V3.add(x.camera.position, V3.multiplyByScalar(x.camera.direction, before, new V3()), new V3());
  near(dist(expected, x.controller.target), 0, 1e-6);
});

check('2D round-trip сохраняет режим: полёт остаётся полётом (аудит B1)', () => {
  const x = setup(); x.controller.setMode('fly'); x.key('w'); x.advance(); x.keyUp('w');
  const p = V3.clone(x.camera.position), d = V3.clone(x.camera.direction), target = V3.clone(x.controller.target);
  x.controller.captureFor2D(); x.camera.position = V3.clone(x.target);
  x.controller.restoreFrom2D();
  assert(x.controller.mode === 'fly', 'после возврата из 2D режим сменился на ' + x.controller.mode);
  near(dist(p, x.camera.position), 0, 1e-6);
  near(dist(d, x.camera.direction), 0, 1e-8); near(dist(target, x.controller.target), 0, 1e-6);
  const p2 = V3.clone(x.camera.position); x.key('w'); x.advance(); x.keyUp('w');
  assert(moved(p2, x.camera.position), 'после возврата из 2D полёт не управляется');
});

check('2D round-trip из осмотра остаётся осмотром', () => {
  const x = setup();
  const r = radius(x);
  x.controller.captureFor2D(); x.camera.position = V3.clone(x.target);
  x.controller.restoreFrom2D();
  assert(x.controller.mode === 'orbit');
  near(radius(x), r, 1e-6);
});

check('R восстанавливает home, очищает клавиши и сохраняет режим', () => {
  const x = setup(), home = V3.clone(x.camera.position); x.controller.setMode('fly'); x.key('w'); x.advance();
  x.key('r'); assert(x.controller.mode === 'fly'); near(dist(home, x.camera.position), 0, 1e-6);
  const p = V3.clone(x.camera.position); x.advance(); near(dist(p, x.camera.position), 0, 1e-6);
});

check('Границы: нижний кламп высоты снят (PLAN-mobile N1) — полёт уходит под 0.5 м', () => {
  const x = setup({ height: 1 }); x.controller.setMode('fly'); x.key('q'); x.advance(100); x.keyUp('q');
  assert(x.camera.position.z < 0.5, 'камера не опустилась ниже прежних 0.5 м: ' + x.camera.position.z);
});

check('Границы: потолок 400 м и прямоугольник участка остались', () => {
  const x = setup({ height: 395 }); x.controller.setMode('fly'); x.key('e'); x.advance(100); x.keyUp('e');
  near(x.camera.position.z, 400, 1e-6);
  x.key('d'); x.advance(1200); const p = V3.clone(x.camera.position); x.advance(400); x.keyUp('d');
  near(dist(p, x.camera.position), 0, 1e-9, 'камера прошла границу участка');
});

check('Blur очищает движение и drag', () => {
  const x = setup(); x.controller.setMode('fly'); x.key('w'); x.pointer('pointerdown', { button: 2 });
  x.window.fire('blur'); const p = V3.clone(x.camera.position), d = V3.clone(x.camera.direction); x.advance();
  near(dist(p, x.camera.position), 0, 1e-6); near(dist(d, x.camera.direction), 0, 1e-9); assert(!x.controller.drag);
});

check('Pointerup вне canvas снимает drag', () => {
  const x = setup(); x.pointer('pointerdown', { button: 2 }); assert(x.controller.drag);
  x.document.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2 });
  assert(!x.controller.drag);
});

check('Touch: один палец orbit, два пальца pinch', () => {
  const x = setup({ touch: true });
  const r = radius(x);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 110 });
  near(radius(x), r, 1e-6);
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch' });
  const before = radius(x);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  x.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 100 });
  x.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 100 });
  assert(radius(x) < before, 'pinch не приблизил');
});

/* ——— тач-полёт и двойной тап (PLAN-mobile U3, N1, N2) ——— */
const touchTap = (x, ms = 10, id = 1, cx = 200, cy = 200) => {
  x.pointer('pointerdown', { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy });
  x.tick(ms);
  x.pointer('pointerup', { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy });
};

check('Двойной тап в осмотре переносит точку орбиты за 400 мс (U3)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  const target = V3.clone(x.controller.target);
  touchTap(x);
  near(dist(target, x.controller.target), 0, 1e-9, 'первый тап сдвинул камеру');
  assert(!x.controller.focus, 'первый тап дал focus');
  x.tick(150);
  touchTap(x);
  assert(x.controller.focus, 'второй тап не начал focus');
  x.advance(20);
  near(dist(hit, x.controller.target), 0, 1e-6);
  assert(!x.controller.focus, 'tween не завершился');
});

check('Одиночный тап в осмотре не двигает камеру', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  touchTap(x);
  x.tick(2000);
  assert(!x.controller.focus);
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
});

check('Двойной тап: drag >16 px и pinch между тапами счётчик сбрасывают', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  x.tick(10);
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 200 });
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 200 });
  touchTap(x, 10, 1, 240, 200);
  assert(!x.controller.focus, 'drag засчитан как тап');
  const y = setup({ touch: true }); y.setPick(hit);
  touchTap(y);                                   // валидный первый тап
  y.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  y.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 });
  y.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  y.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  y.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  y.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  touchTap(y, 10, 1, 200, 200);                 // сразу после pinch — не двойной
  assert(!y.controller.focus, 'pinch не сбросил счётчик тапов');
});

check('Двойной тап: длинный тап >300 мс и второй тап позже 350 мс не считаются', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x, 400);
  touchTap(x, 10);
  assert(!x.controller.focus, 'длинный тап засчитан как тап');
  const y = setup({ touch: true }); y.setPick(hit);
  touchTap(y, 10); y.tick(500); touchTap(y, 10);
  assert(!y.controller.focus, 'тапы через 500 мс засчитаны как двойной');
});

check('Тач-полёт: setStick двигает вперёд и вправо со скоростью speed', () => {
  const x = setup(); x.controller.setMode('fly'); const p = V3.clone(x.camera.position);
  x.controller.setStick(0, 1); x.advance(); x.controller.setStick(0, 0);
  near(dist(p, x.camera.position), 6, 1e-5, 'джойстик вперёд не сдвинул');
  const p2 = V3.clone(x.camera.position);
  x.controller.setStick(1, 0); x.advance(); x.controller.setStick(0, 0);
  near(dist(p2, x.camera.position), 6, 1e-5, 'джойстик вправо не сдвинул');
  const p3 = V3.clone(x.camera.position);
  x.controller.setStick(0, 0); x.advance();
  near(dist(p3, x.camera.position), 0, 1e-9, 'нулевой стик двигает камеру');
});

check('Тач-полёт: setVertical меняет z, setRun даёт ровно ×4', () => {
  const x = setup(); x.controller.setMode('fly'); const z = x.camera.position.z;
  x.controller.setVertical(1); x.advance(); x.controller.setVertical(0);
  near(x.camera.position.z - z, 6, 1e-5);
  x.controller.setRun(true); x.controller.setVertical(-1); x.advance(); x.controller.setVertical(0);
  near(x.camera.position.z - (z + 6), -24, 1e-5);
});

check('Тач-полёт: свайп взгляда по канвасу в любой точке, кроме DOM-контролов (N2→ADR-33)', () => {
  const stickRect = { left: 20, top: 472, right: 148, bottom: 600 };
  const x = setup({ touch: true, controls: [stickRect] }); x.controller.setMode('fly');
  assert(x.controller.mode === 'fly', 'на тач-устройстве полёт всё ещё запрещён');
  const d = V3.clone(x.camera.direction), p = V3.clone(x.camera.position);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 });
  assert(moved(d, x.camera.direction), 'свайп не изменил взгляд');
  near(dist(p, x.camera.position), 0, 1e-9, 'свайп взгляда двигает позицию');
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 });
  /* левый нижний угол пуст (там ничего нет) — взгляд берётся: прежняя граница «левая половина»
   * запрещала свайп на четверти экрана без причины (аудит A4) */
  const d2 = V3.clone(x.camera.direction);
  x.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 200 });
  x.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 360, clientY: 260 });
  assert(moved(d2, x.camera.direction), 'свайп в свободной левой части игнорируется');
  x.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 360, clientY: 260 });
  /* над стиком — не берётся */
  const d3 = V3.clone(x.camera.direction);
  x.pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 84, clientY: 536 });
  x.pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 130, clientY: 570 });
  near(dist(d3, x.camera.direction), 0, 1e-9, 'свайп поверх джойстика двигает взгляд');
  x.pointer('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 130, clientY: 570 });
});

check('Параллельный тач: тап по DOM-контролу не глувит палец свайпа (аудит A1, ADR-33)', () => {
  const x = setup({ touch: true }); x.controller.setMode('fly');
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  assert(x.controller.look, 'свайп не начат');
  /* второй палец ложится на стик: событие пришло НЕ с канваса, на document в capture-фазе */
  x.document.fire('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 60, clientY: 520, target: { id: 'stick' } });
  const d = V3.clone(x.camera.direction);
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 });
  assert(moved(d, x.camera.direction), 'камера оглохла после касания контрола');
  assert(x.controller.look && x.controller.look.id === 1, 'жест взгляда сброшен чужим pointerdown');
});

check('Параллельный тач: свайп не глубит стик — значения джойстика живут отдельно (ADR-33)', () => {
  const x = setup({ touch: true }); x.controller.setMode('fly');
  x.controller.setStick(0, 1);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  x.document.fire('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 60, clientY: 520, target: { id: 'stick' } });
  const p = V3.clone(x.camera.position);
  x.advance();
  assert(moved(p, x.camera.position), 'движение джойстика оборвалось из-за свайпа камеры');
  const d = V3.clone(x.camera.direction);
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 650, clientY: 200 });
  assert(moved(d, x.camera.direction), 'взгляд оборвался из-за движения джойстика');
});

check('lostpointercapture не засчитывается как тап (аудит A8)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  x.tick(10);
  x.canvas.fire('lostpointercapture', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  assert(!x.controller.lastTap, 'снятие capture засчитано тапом');
  touchTap(x);
  x.advance(20);
  assert(!x.controller.focus, 'снимание capture + тап дали двойной тап');
});

check('dblclick после тач-жеста не дублирует действие двойного тапа (аудит A8)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x, 10); x.tick(120); touchTap(x, 10);          // двойной тап: focus уже начат
  assert(x.controller.focus, 'двойной тап не сработал');
  x.controller.focus = null;
  canvasDoubleClick(x);                                    // гибрид добавляет dblclick следом
  assert(!x.controller.focus, 'dblclick после тача повторно запустил focus');
});

check('focusAtGround: переносит точку орбиты, у границ отказывает с сообщением', () => {
  const x = setup(), hit = V3.add(x.target, new V3(20, 10, 0), new V3());
  assert(x.controller.focusAtGround(hit.x / 1e5, hit.y / 1e5) === true, 'focus не начался');
  assert(x.controller.focus);
  x.advance(20); near(dist(hit, x.controller.target), 0, 1e-6);
  const far = V3.add(x.target, new V3(900, 0, 0), new V3());
  const messages = []; x.controller.onMessage = m => messages.push(m);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  assert(x.controller.focusAtGround(far.x / 1e5, far.y / 1e5) === false, 'выход за границы разрешён');
  assert(!x.controller.focus);
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
  assert(messages.some(m => /слишком далеко/.test(m)), 'нет сообщения о границах');
});

check('Клавиатура: Orbit стрелки и +/- работают без drag', () => {
  const x = setup(), d = V3.clone(x.camera.direction), r = radius(x);
  x.key('ArrowRight'); assert(moved(d, x.camera.direction));
  x.key('+'); assert(radius(x) < r); const after = radius(x); x.key('-'); near(radius(x), after * 1.15, 1e-5);
});

check('Lock блокирует ввод и очищает клавиши', () => {
  const x = setup(); x.controller.setMode('fly'); x.key('w'); x.controller.setLocked(true); const p = V3.clone(x.camera.position);
  x.advance(); near(dist(p, x.camera.position), 0, 1e-6);
  x.controller.setLocked(false); x.advance(); near(dist(p, x.camera.position), 0, 1e-6);
});

console.log(`ИТОГ: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
