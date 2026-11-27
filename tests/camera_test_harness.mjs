/* camera_test_harness.mjs — общая среда для тестов слоя ввода камеры (WP-CAM-2).
 * Те же шимы Cesium/DOM, что в camera_controller_test.mjs, плюс:
 *  — эмуляция setPointerCapture: pointerup/pointercancel/pointermove, пришедшие на document
 *    для захваченного id, ретаргетятся на канвас (как в браузере) — так работает единственный
 *    обработчик up на канвасе и свайп поверх DOM-плашек;
 *  — счётчики у шима камеры: setViews (каждый setView) и positionWrites (каждая прямая запись
 *    в camera.position) — проверка «единственный писатель — rig.apply»;
 *  — globalThis.document/window/performance/rAF ставятся здесь, до создания контроллера. */

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
export const Cesium = {
  Cartesian2: V2, Cartesian3: V3, Matrix4: M4,
  Transforms: { eastNorthUpToFixedFrame: origin => new M4(V3.clone(origin)) },
  Cartographic: { fromCartesian: p => ({ longitude: p.x / 100000 * Math.PI / 180, latitude: p.y / 100000 * Math.PI / 180, height: p.z }) },
};

export function eventTarget(extra = {}) {
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

import { createController } from '../src/camera/controller.js';

export function makeEnv(options = {}) {
  let now = 1000;
  let touch = !!options.touch;
  const document = eventTarget({
    hidden: false,
    /* контролы, которые камера обязана обходить свайпом взгляда (ADR-33): [{left,top,right,bottom}] */
    querySelectorAll: () => (options.controls || []).map(r => ({
      offsetParent: {},
      getBoundingClientRect: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }),
    })),
    /* карточка обучения в DOM есть всегда, её вид задаёт options.tutOpen — input.js по ней
       определяет, что модальное окно открыто и вид экрана менять нельзя */
    getElementById: (id) => (id === 'tut' ? { hidden: !options.tutOpen } : null),
  });
  const window = eventTarget();
  const canvas = eventTarget({
    clientWidth: 800, clientHeight: 600, style: {}, tabIndex: -1,
    focus() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  /* эмуляция pointer capture: тип указателя помним по последнему событию, захват/релиз —
   * на канвасе; pointer*-события с document для захваченного id уходят на канвас, а после
   * up/cancel браузер неявно снимает capture — здесь так же стреляет lostpointercapture */
  const captured = new Map();
  const lastType = new Map();
  canvas.setPointerCapture = id => { captured.set(id, lastType.get(id) || 'mouse'); };
  canvas.releasePointerCapture = id => { captured.delete(id); };
  canvas.hasPointerCapture = id => captured.has(id);
  const noteType = (type, props) => {
    if (props && props.pointerId != null && String(type).startsWith('pointer')) lastType.set(props.pointerId, props.pointerType || 'mouse');
  };
  const canvasFire = canvas.fire.bind(canvas);
  canvas.fire = (type, props = {}) => { noteType(type, props); canvasFire(type, props); };
  const docFire = document.fire.bind(document);
  document.fire = (type, props = {}) => {
    noteType(type, props);
    if (captured.has(props.pointerId) && (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel')) {
      canvasFire(type, props);
      if (type !== 'pointermove') {
        const t = captured.get(props.pointerId);
        captured.delete(props.pointerId);
        canvasFire('lostpointercapture', { pointerId: props.pointerId, pointerType: t });
      }
      return;
    }
    docFire(type, props);
  };

  const camera = {
    frustum: options.frustum ?? { fov: options.fov ?? Math.PI / 3, fovy: options.fov ?? Math.PI / 3 },
    setViews: 0, positionWrites: 0, _pos: new V3(),
    get position() { return this._pos; },
    set position(v) { this.positionWrites++; this._pos = V3.clone(v); },
    setView(view) {
      this.setViews++;
      this._pos = V3.clone(view.destination);
      const o = view.orientation;
      if (o.direction) {
        this.direction = V3.normalize(o.direction, new V3());
        this.right = V3.normalize(V3.cross(this.direction, o.up, new V3()), new V3());
        this.up = V3.normalize(V3.cross(this.right, this.direction, new V3()), new V3());
      } else throw new Error('test camera expects direction/up');
    },
    getPickRay() { return { origin: V3.clone(this._pos), direction: V3.clone(this.direction) }; },
  };
  const extent = { w: 37.479587839, s: 55.672218962, e: 37.482130196, n: 55.673727617 };
  const lon = (extent.w + extent.e) / 2, lat = (extent.s + extent.n) / 2;
  const target = V3.fromDegrees(lon, lat, 0);
  camera._pos = V3.fromDegrees(lon, lat - 0.00125, options.height ?? 140);
  camera.setView({ destination: camera.position, orientation: { direction: V3.subtract(target, camera.position, new V3()), up: V3.UNIT_Z } });
  let pick = null;
  const scene = {
    screenSpaceCameraController: { enableInputs: true }, pickPositionSupported: true,
    pickPosition: () => pick && V3.clone(pick), pickFromRay: () => null,
    requestRender() { this.renders = (this.renders || 0) + 1; },
  };
  const viewer = { camera, scene, canvas, splats: { show: !!options.splats } };

  /* модули input/touch читают document/window/performance в рантайме — ставим до создания */
  globalThis.document = document;
  globalThis.window = window;
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  const states = [];
  const messages = [];
  const viewKeys = [];
  const controller = createController({
    Cesium, viewer, extent, target, pickCollision: options.pickCollision, autoStart: false,
    isActive: () => options.active !== false,
    touchOnly: () => touch, reducedMotion: () => !!options.reducedMotion,
    onState: state => states.push({ ...state }),
    onMessage: m => messages.push(m),
    onViewKey: n => viewKeys.push(n),
  });
  /* «прогрев» как в бою: rAF-цикл к моменту ввода уже крутится, поэтому у первого реального
   * кадра dt нормальный (у rig первый кадр после создания намеренно dt=0) */
  controller.tick(now);
  return {
    controller, camera, scene, canvas, document, window, states, messages, viewKeys, target, extent,
    setPick(value) { pick = value; },
    setActive(on) { options.active = !!on; },
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
    dblclick(clientX = 260, clientY = 240) { canvas.fire('dblclick', { clientX, clientY }); },
  };
}

export const dist = (a, b) => V3.distance(a, b);
export const moved = (a, b) => dist(a, b) > 1e-5;
export const radius = t => dist(t.camera.position, t.controller.target);
/* реестр проверок: PASS/FAIL поимённо + ИТОГ на exits — сетку качества ослаблять нельзя */
export function checkRunner() {
  let passed = 0, failed = 0;
  return {
    check(name, fn) {
      try { fn(); passed++; console.log('PASS', name); }
      catch (e) { failed++; console.error('FAIL', name, '—', e.stack || e.message); }
    },
    done() { console.log(`ИТОГ: ${passed}/${passed + failed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; },
  };
}
export function assert(value, message) { if (!value) throw new Error(message || 'assertion'); }
export function near(a, b, eps, message) { if (Math.abs(a - b) > (eps ?? 1e-6)) throw new Error(`${message || 'not near'}: ${a} != ${b}`); }
export const touchTap = (x, ms = 10, id = 1, cx = 200, cy = 200) => {
  x.pointer('pointerdown', { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy });
  x.tick(ms);
  x.pointer('pointerup', { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy });
};
