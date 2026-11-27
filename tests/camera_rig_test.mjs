/* Headless-тесты ядра камеры (WP-CAM-1): shim Cesium как в camera_controller_test.mjs,
 * проверки 1-10 из SPEC-camera-rig.md §6 плюс регрессы единиц углов и системы координат
 * движения (11-17, ADR-37): обе поломки всплыли только на проде, статические гейты их не видели. */
import { CameraRig } from '../src/camera/rig.js';

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
class M4 {
  constructor(origin) { this.origin = origin || new V3(); }
  static inverse(m, out) { out.origin = new V3(-m.origin.x, -m.origin.y, -m.origin.z); return out; }
  static multiplyByPoint(m, v, out) { return V3.add(m.origin, v, out); }
  static multiplyByPointAsVector(m, v, out) { out.x = v.x; out.y = v.y; out.z = v.z; return out; }
}
const Cesium = {
  Cartesian2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Cartesian3: V3, Matrix4: M4,
  Transforms: { eastNorthUpToFixedFrame: origin => new M4(V3.clone(origin)) },
  Cartographic: { fromCartesian: p => ({ longitude: p.x / 100000 * Math.PI / 180, latitude: p.y / 100000 * Math.PI / 180, height: p.z }) },
};

function setup(options = {}) {
  let now = 1000;
  const touch = !!options.touch;
  const camera = {
    frustum: { fov: Math.PI / 3, fovy: Math.PI / 3 },
    setViews: 0,        // счётчик setView: ровно один писатель (тест 1)
    positionWrites: 0,  // счётчик записей camera.position =: rig писать не должен
    _pos: new V3(),
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
  };
  const extent = { w: 37.479587839, s: 55.672218962, e: 37.482130196, n: 55.673727617 };
  const lon = (extent.w + extent.e) / 2, lat = (extent.s + extent.n) / 2;
  const target = V3.fromDegrees(lon, lat, 0);
  camera.setView({ destination: V3.fromDegrees(lon, lat - 0.00125, options.height ?? 140),
    orientation: { direction: V3.subtract(target, camera.position, new V3()), up: V3.UNIT_Z } });
  let pick = null;
  const scene = {
    screenSpaceCameraController: { enableInputs: true }, pickPositionSupported: true,
    pickPosition: () => pick && V3.clone(pick),
    requestRender() { this.renders = (this.renders || 0) + 1; },
  };
  const viewer = { camera, scene };
  const states = [];
  const rig = new CameraRig({
    Cesium, viewer, extent, target, touchOnly: () => touch,
    reducedMotion: () => !!options.reducedMotion,
    onState: state => states.push({ ...state }),
  });
  return {
    rig, camera, scene, target, extent, states,
    setPick(value) { pick = value; },
    tick(ms = 50) { now += ms; rig.tick(now); },
    advance(frames = 20, ms = 50) { for (let i = 0; i < frames; i++) { now += ms; rig.tick(now); } },
    /* внешняя запись позы — имитация «писателя не-rig» (тест 2, 8) */
    externalMove(d) { camera.position = new V3(camera.position.x + d.x, camera.position.y + d.y, camera.position.z + d.z); },
    externalPose(pos, dir) { camera.position = pos; camera.direction = V3.normalize(dir, new V3()); },
  };
}
const dist = (a, b) => V3.distance(a, b);
const local = p => ({ x: p.x - 3748085.90175, y: p.y - 5567297.32895, z: p.z }); // ENU центра участка (shim: только перенос)

check('1. Одиночный писатель: 100 кадров стика+свайпа = ровно 100 setView, 0 записей camera.position', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick(); // кадр инициализации режима
  const views = x.camera.setViews, writes = x.camera.positionWrites;
  for (let i = 0; i < 100; i++) { x.rig.setStick(0.8, 0.5); x.rig.lookBy(12, -4); x.tick(); }
  near(x.camera.setViews - views, 100, 0, 'setView за кадр должен быть ровно один');
  near(x.camera.positionWrites - writes, 0, 0, 'rig пишет в camera напрямую');
});

check('2. Чужая запись не перезаписывается: сдвиг (10,5,3) принят, yaw/pitch пересняты', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  x.externalMove({ x: 10, y: 5, z: 3 });
  const views = x.camera.setViews;
  x.tick(); // ни намерений, ни движения — guard обязан сделать syncFromCamera, а не setView
  near(x.camera.setViews, views, 0, 'guard перезаписал чужую позу');
  near(dist(x.rig.pos, x.camera.position), 0, 1e-9, 'rig не принял чужую позицию');
  x.rig.lookBy(20, 0);
  x.tick();
  assert(dist(x.camera.position, x.rig.pos) < 1e-9, 'следующая поза не из принятой внешней позиции');
  const dirAng = Math.acos(Math.max(-1, Math.min(1, V3.dot(x.camera.direction, x.rig._appliedDir))));
  assert(dirAng < 1e-9, 'yaw/pitch не пересняты из камеры');
});

check('3. Раунд-трип orbit→fly→orbit: 20 кругов, расхождение pos/distance < 1e-6', () => {
  const x = setup();
  x.tick();
  const pos0 = V3.clone(x.rig.pos), distance0 = x.rig.distance;
  const yaw0 = x.rig.yaw, pitch0 = x.rig.pitch;
  for (let i = 0; i < 20; i++) { x.rig.setMode('fly'); x.rig.setMode('orbit'); }
  near(dist(pos0, x.rig.pos), 0, 1e-6, 'pos разошёлся после кругов');
  near(x.rig.distance, distance0, 1e-6, 'distance разошёлся после кругов');
  near(x.rig.yaw, yaw0, 1e-9, 'yaw не сохранён');
  near(x.rig.pitch, pitch0, 1e-9, 'pitch не сохранён');
});

check('4. Дрейфа target нет: 200 кадров стика → distance(pos,target) не изменилась', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  const d0 = dist(x.rig.pos, x.rig.target);
  x.rig.setStick(0.9, 1);
  x.advance(200);
  near(dist(x.rig.pos, x.rig.target), d0, 1e-6, 'target отстал от pos — дрейф точки фокуса');
});

check('5. Поворот без рывка: свайп 200 px → pitch зажат, yaw ∈ (−π, π], up·z > 0, roll = 0', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  const yaw0 = x.rig.yaw, pitch0 = x.rig.pitch;
  x.rig.lookBy(200, 200);
  x.tick();
  assert(Math.abs(x.rig.yaw - yaw0) > 1e-6 && Math.abs(x.rig.pitch - pitch0) > 1e-6, 'свайп не повернул');
  assert(Math.abs(x.rig.pitch) <= Math.PI / 2 - 0.01 + 1e-12, 'pitch вне клампа');
  assert(x.rig.yaw > -Math.PI && x.rig.yaw <= Math.PI, 'yaw вне (−π, π]');
  assert(x.camera.up.z > 0, 'up смотрит вниз — переворот камеры');
  near(x.camera.right.z, 0, 1e-9, 'roll ≠ 0');
});

check('6. Стик + свайп одновременно: оба канала применены за кадр, порядок не важен', () => {
  const a = setup(), b = setup();
  for (const x of [a, b]) { x.rig.setMode('fly'); x.tick(); }
  const yawA = a.rig.yaw, posA = V3.clone(a.rig.pos);
  a.rig.setStick(1, 0); a.rig.lookBy(60, 0); a.tick();
  b.rig.lookBy(60, 0); b.rig.setStick(1, 0); b.tick();
  assert(Math.abs(a.rig.yaw - yawA) > 1e-6, 'свайп не применён (порядок a)');
  assert(dist(posA, a.rig.pos) > 1e-6, 'стик не применён (порядок a)');
  near(a.rig.yaw, b.rig.yaw, 1e-12, 'порядок вызовов меняет yaw');
  near(dist(a.rig.pos, b.rig.pos), 0, 1e-12, 'порядок вызовов меняет pos');
});

check('7. Двойной тап во время движения: стик отменяет tween, телепорта нет', () => {
  const x = setup();
  x.tick();
  const pick = new V3(x.target.x + 30, x.target.y + 20, 0);
  assert(x.rig.focusTo(pick, 400), 'tween не стартовал');
  x.rig.setStick(1, 0);
  const p0 = V3.clone(x.camera.position);
  x.tick();
  near(dist(p0, x.camera.position), 0, x.rig.speed * 0.05 * 2, 'камера телепортировалась на кадр');
  assert(x.rig.focus === null, 'tween не отменён движением');
});

check('8. Переход 2D→3D: restoreFrom2D + syncFromCamera, следующий lookBy не возвращает старую ориентацию', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  const oldYaw = x.rig.yaw;
  x.rig.captureFor2D();
  x.rig.restoreFrom2D();
  // Cesium сам переставляет камеру при смене SceneMode: внешняя поза с yaw = π/2
  const pos = V3.clone(x.camera.position);
  const dir = new V3(1, 0, 0);
  x.externalPose(pos, dir);
  x.tick(); // guard ловит чужую запись и синхронизируется
  near(x.rig.yaw, Math.PI / 2, 1e-6, 'yaw не переснят после restoreFrom2D');
  x.rig.lookBy(10, 0);
  x.tick();
  near(x.rig.yaw, Math.PI / 2 + 10 * x.rig.lookSensitivity, 1e-9, 'lookBy вернул старую ориентацию');
  assert(Math.abs(x.rig.yaw - oldYaw) > 1e-3, 'rig остался на прежнем yaw');
});

check('9. Клампы: границы участка, потолок 400, distance ≤ maxDistance, зум у стены не дёргает камеру', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  x.rig.setSpeed(60);
  x.rig.setStick(1, 1); x.rig.setVert(1);
  x.advance(400);
  const p = local(x.camera.position);
  const b = x.rig.bounds;
  assert(p.x <= b.maxX + 1e-6 && p.x >= b.minX - 1e-6, 'вылет за границы участка по X');
  assert(p.y <= b.maxY + 1e-6 && p.y >= b.minY - 1e-6, 'вылет за границы участка по Y');
  near(p.z, 400, 1e-6, 'потолок maxHeight не сработал');
  x.rig.setStick(0, 0); x.rig.setVert(-1);
  x.advance(200);
  assert(local(x.camera.position).z < 0, 'появилась нижняя граница высоты — её быть не должно');
  x.rig.setVert(0);
  // зум в полёте: фокус ближе, позиция не дёргается (у стены)
  const pos = V3.clone(x.camera.position);
  x.rig.zoomBy(0.2); x.tick();
  x.rig.zoomBy(5); x.tick();
  near(dist(pos, x.camera.position), 0, 1e-9, 'зум в полёте сдвинул камеру');
  assert(x.rig.focusDist <= 220 + 1e-9 && x.rig.focusDist >= 3 - 1e-9, 'focusDist вне [3, 220]');
  //distance в орбите не выходит за maxDistance
  x.rig.setMode('orbit');
  x.tick();
  for (let i = 0; i < 10; i++) { x.rig.zoomBy(2); x.tick(); }
  assert(x.rig.distance <= x.rig.maxDistance + 1e-9, 'distance > maxDistance');
});

check('10. Esc/lock/blur: setLocked/setEnabled обнуляют намерения и каналы за один кадр', () => {
  const x = setup();
  x.rig.setMode('fly');
  x.tick();
  const views = x.camera.setViews, pos = V3.clone(x.camera.position);
  x.rig.setStick(1, 1); x.rig.setVert(1); x.rig.setRun(true);
  x.rig.lookBy(100, 0); x.rig.moveBy(5, 5, 5);
  x.rig.setLocked(true);
  x.tick();
  near(x.camera.setViews, views, 0, 'заблокированный rig wrote setView');
  near(dist(pos, x.camera.position), 0, 1e-9, 'заблокированный rig сдвинул камеру');
  near(x.rig.stick.x, 0, 0); near(x.rig.stick.y, 0, 0);
  near(x.rig.vert, 0, 0); near(x.rig.run ? 1 : 0, 0, 0);
  for (const k of Object.keys(x.rig.intent)) near(x.rig.intent[k], 0, 0, `намерение ${k} не обнулено`);
  x.rig.setLocked(false);
  x.rig.setStick(1, 0); x.rig.lookBy(50, 0);
  x.rig.setEnabled(false);
  x.tick();
  near(x.camera.setViews, views, 0, 'отключённый rig wrote setView');
  near(x.rig.stick.x, 0, 0, 'setEnabled(false) не обнулил стик');
});

/* ——— регресс 27.11 на проде: единицы углов и система координат движения ———
 * Обе поломки прошли все статические гейты: монопроводка вызывала setPose значениями из HOME_POSE
 * (градусы), а rig ждал радианы — наклон клампился в −89.4° и стартовый вид смотрел в пол;
 * клавиши шли в мировые оси ENU — W ехал на север независимо от курса камеры. */

check('11. setPose берёт градусы: курс 130° и наклон −2° из HOME_POSE', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2 });
  near(x.rig.yaw, 130 * Math.PI / 180, 1e-9, 'yaw не из градусов');
  near(x.rig.pitch, -2 * Math.PI / 180, 1e-9, 'pitch не из градусов');
});

check('12. направление камеры на старте = курс 130°, наклон −2°, а не в пол', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2 });
  const h = 130 * Math.PI / 180, p = -2 * Math.PI / 180;
  near(x.camera.direction.x, Math.sin(h) * Math.cos(p), 1e-6, 'восточная составляющая взгляда');
  near(x.camera.direction.y, Math.cos(h) * Math.cos(p), 1e-6, 'северная составляющая взгляда');
  near(x.camera.direction.z, Math.sin(p), 1e-6, 'вертикальная составляющая взгляда');
  assert(x.camera.direction.z > -0.05, 'стартовая камера смотрит в пол');
});

check('13. наклон клампится по градусам, курс заворачивается в (−180°, 180°]', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 0, pitch: -95 });
  near(x.rig.pitch, -(Math.PI / 2 - 0.01), 1e-9, 'pitch не клампится как градусы');
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 190, pitch: 0 });
  near(x.rig.yaw, -170 * Math.PI / 180, 1e-9, 'курс не заворачивается');
});

check('14. home и «Домой» оперируют градусами: reset возвращает 130°/−2°', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2 });
  x.rig.homePose();
  near(x.rig.home.heading, 130, 1e-6, 'home.heading не в градусах');
  near(x.rig.home.pitch, -2, 1e-6, 'home.pitch не в градусах');
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 10, pitch: -40 });
  x.rig.reset();
  near(x.rig.yaw, 130 * Math.PI / 180, 1e-9, 'reset не вернул курс');
  near(x.rig.pitch, -2 * Math.PI / 180, 1e-9, 'reset не вернул наклон');
});

check('15. W в полёте едет туда, куда смотрит камера, а не на север', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2 });
  x.rig.setMode('fly');
  x.tick();
  x.rig.setSpeed(20);
  const before = V3.clone(x.camera.position);
  x.rig.moveBy(20, 0, 0);   // «W» со скоростью 20 м/с вдоль направления камеры (так считает input.js)
  x.tick();                 // dt = 0.05 с → 1 м
  const d = V3.subtract(x.camera.position, before, new V3());
  near(V3.distance(new V3(), d), 1, 1e-6, 'смещение W не равно speed*dt');
  assert(V3.dot(V3.normalize(d, new V3()), x.camera.direction) > 1 - 1e-9, 'W едет не по направлению камеры');
  assert(Math.abs(d.y) < 0.99, 'W уехал на север: движение считается в мировых осях ENU');
});

check('16. D вправо по камере, E вверх по локальной вертикали', () => {
  const x = setup();
  x.rig.setPose({ lon: 37.480054, lat: 55.673387, h: 3.1, heading: 130, pitch: -2 });
  x.rig.setMode('fly'); x.tick(); x.rig.setSpeed(20);
  let before = V3.clone(x.camera.position);
  x.rig.moveBy(0, 20, 0); x.tick();
  let d = V3.subtract(x.camera.position, before, new V3());
  assert(V3.dot(V3.normalize(d, new V3()), V3.normalize(x.camera.right, new V3())) > 1 - 1e-6, 'D не вправо по камере');
  before = V3.clone(x.camera.position);
  x.rig.moveBy(0, 0, 20); x.tick();
  d = V3.subtract(x.camera.position, before, new V3());
  near(d.z, 1, 1e-6, 'E не вверх по локальной вертикали');
});

check('17. движение с клавиатуры — намерение: guard его не съедает, tween отменяется', () => {
  const x = setup();
  x.rig.setMode('fly'); x.tick();
  x.rig.moveBy(6, 0, 0);
  assert(x.rig._intentPending(), 'mvF не считается намерением: guard перезапишет позу из камеры');
  for (const k of Object.keys(x.rig.intent)) x.rig.intent[k] = 0;
  assert(x.rig.focusTo(x.rig.target, 400), 'tween не создан');
  x.rig.moveBy(6, 0, 0);
  x.tick();
  assert(!x.rig.focus, 'движение с клавиатуры не отменило tween');
});

console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
