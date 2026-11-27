/* camera_gestures_test.mjs — сетка качества WP-CAM-2: 43 проверки перенесены из
 * camera_controller_test.mjs на новые модули (input.js/touch.js/controller.js поверх rig.js)
 * без ослаблений + новые проверки (а–е). Отличия от старых проверок помечены [порт]. */
import { makeEnv as setup, Cesium, dist, moved, radius, touchTap, checkRunner, assert, near } from './camera_test_harness.mjs';

const V3 = Cesium.Cartesian3;
const { check, done } = checkRunner();

check('старт: Orbit, Cesium inputs отключены, исходный target', () => {
  const x = setup();
  assert(x.controller.mode === 'orbit');
  assert(x.scene.screenSpaceCameraController.enableInputs === false);
  near(radius(x), dist(x.camera.position, x.target), 1e-8);
});

check('Orbit: ЛКМ вращает без изменения radius и target', () => {
  const x = setup(), before = radius(x), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 260, clientY: 220 }); x.pointer('pointerup'); x.tick();
  near(radius(x), before, 1e-6); near(dist(target, x.controller.target), 0, 1e-9);
  assert(moved(direction, x.camera.direction), 'направление не изменилось');
});

check('Orbit: горизонталь инвертирована — сцена идёт за курсором (решение владельца 25.11)', () => {
  const x = setup(), p = V3.clone(x.camera.position), r = radius(x), target = V3.clone(x.controller.target);
  assert(x.camera.right.x > 0, 'в тестовой сцене экранное «вправо» смотрит на восток');
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 260, clientY: 200 }); x.pointer('pointerup'); x.tick();
  assert(x.camera.position.x < p.x - 1, 'тяга вправо не уводит камеру на запад — сцена едет против курсора');
  near(x.camera.position.z, p.z, 1e-6, 'чисто горизонтальная тяга изменила высоту');
  near(radius(x), r, 1e-6); near(dist(target, x.controller.target), 0, 1e-9);
});

check('Orbit: стрелка вправо вращает сцену в ту же сторону, что и тяга вправо', () => {
  const a = setup(), b = setup();
  const ax = a.camera.position.x, bx = b.camera.position.x;
  a.pointer('pointerdown'); a.pointer('pointermove', { clientX: 260, clientY: 200 }); a.pointer('pointerup'); a.tick();
  b.key('ArrowRight'); b.tick();
  assert(a.camera.position.x < ax && b.camera.position.x < bx, 'знак горизонтального вращения разошёлся у мыши и клавиатуры');
});

check('Orbit: вертикаль остаётся «сцена за курсором» — тяга вниз поднимает камеру', () => {
  const x = setup(), p = V3.clone(x.camera.position), r = radius(x);
  x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 200, clientY: 260 }); x.pointer('pointerup'); x.tick();
  assert(x.camera.position.z > p.z + 1, 'тяга вниз не подняла камеру');
  near(radius(x), r, 1e-6, 'вертикальная тяга изменила дистанцию');
});

check('Orbit: ПКМ pan переносит камеру и target на один offset', () => {
  const x = setup(), p = V3.clone(x.camera.position), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.pointer('pointerdown', { button: 2 }); x.pointer('pointermove', { button: 2, clientX: 240, clientY: 230 }); x.pointer('pointerup', { button: 2 }); x.tick();
  const dp = V3.subtract(x.camera.position, p, new V3()), dt = V3.subtract(x.controller.target, target, new V3());
  near(dist(dp, dt), 0, 1e-6); assert(moved(p, x.camera.position)); near(dist(direction, x.camera.direction), 0, 1e-8);
});

check('Orbit: колесо меняет только дистанцию', () => {
  const x = setup(), before = radius(x), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  x.wheel(-120); x.tick();
  assert(radius(x) < before, 'колесо вверх не приблизило'); near(dist(target, x.controller.target), 0, 1e-9);
  near(dist(direction, x.camera.direction), 0, 1e-8);
});

check('Double click: промах не двигает камеру и target', () => {
  const x = setup(), p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  x.dblclick();
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
});

check('Double click: tween идёт через промежуток и сохраняет дистанцию/направление', () => {
  const x = setup(), hit = V3.add(x.controller.target, new V3(20, 10, 5), new V3());
  x.setPick(hit);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target), direction = V3.clone(x.camera.direction);
  const expected = V3.add(hit, V3.subtract(p, target, new V3()), new V3());
  x.tick(0); x.dblclick();                                  // [порт] tick(0) фиксирует время старта tween'а
  assert(x.controller.rig.focus, 'анимация не создана');
  x.tick(200);
  assert(moved(p, x.camera.position), 'нет промежуточного движения');
  assert(dist(x.camera.position, expected) > 1e-4, 'tween завершился мгновенно');
  near(radius(x), dist(p, target), 1e-6); near(dist(direction, x.camera.direction), 0, 1e-8);
  x.tick(200);
  near(dist(x.camera.position, expected), 0, 1e-6); near(dist(hit, x.controller.target), 0, 1e-6);
  near(dist(direction, x.camera.direction), 0, 1e-8); assert(!x.controller.rig.focus);
});

check('Double click: reduced motion завершает focus сразу', () => {
  const x = setup({ reducedMotion: true }), hit = V3.clone(x.target); x.setPick(hit);
  x.tick(0); x.dblclick(); x.tick(0);                       // [порт] завершение — на первом же tick
  assert(!x.controller.rig.focus); near(dist(hit, x.controller.target), 0, 1e-6);
});

check('Focus: новый ввод отменяет tween без позднего скачка', () => {
  const x = setup(), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  x.tick(0); x.dblclick(); x.tick(100); x.wheel(-100);
  assert(!x.controller.rig.focus);
  x.advance(1);                                             // [порт] кадр применения зума от колеса
  const p = V3.clone(x.camera.position);
  x.advance(10); near(dist(p, x.camera.position), 0, 1e-6);
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
  x.pointer('pointerdown', { button: 2 }); x.pointer('pointermove', { button: 2, clientX: 260, clientY: 230 }); x.tick();
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
  const p = V3.clone(x.camera.position); x.setPick(hit); x.controller.setMode('orbit');
  near(dist(hit, x.controller.target), 0, 1e-6); near(dist(p, x.camera.position), 0, 1e-9);
  /* [порт] орбит-инвариант rig'а: после смены target взгляд пересчитывается ровно на hit */
  near(dist(V3.normalize(V3.subtract(hit, p, new V3()), new V3()), x.camera.direction), 0, 1e-8);
  const r = radius(x); x.pointer('pointerdown'); x.pointer('pointermove', { clientX: 230 }); x.pointer('pointerup'); x.tick();
  near(radius(x), r, 1e-6);
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
  near(dist(p, x.camera.position), 0, 1e-6); near(dist(d, x.camera.direction), 0, 1e-9); assert(!x.controller.input.drag);
});

check('Pointerup вне canvas снимает drag', () => {
  const x = setup(); x.pointer('pointerdown', { button: 2 }); assert(x.controller.input.drag);
  x.document.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2 });
  assert(!x.controller.input.drag);
});

check('Touch: один палец orbit, два пальца pinch', () => {
  const x = setup({ touch: true });
  const r = radius(x);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 110 }); x.tick();
  near(radius(x), r, 1e-6);
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch' });
  const before = radius(x);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  x.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 100 });
  x.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 100 }); x.tick();
  assert(radius(x) < before, 'pinch не приблизил');
});

check('Двойной тап в осмотре переносит точку орбиты за 400 мс (U3)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  const target = V3.clone(x.controller.target);
  touchTap(x);
  near(dist(target, x.controller.target), 0, 1e-9, 'первый тап сдвинул камеру');
  assert(!x.controller.rig.focus, 'первый тап дал focus');
  x.tick(150);
  touchTap(x);
  assert(x.controller.rig.focus, 'второй тап не начал focus');
  x.advance(20);
  near(dist(hit, x.controller.target), 0, 1e-6);
  assert(!x.controller.rig.focus, 'tween не завершился');
});

check('Одиночный тап в осмотре не двигает камеру', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  touchTap(x);
  x.tick(2000);
  assert(!x.controller.rig.focus);
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
});

check('Двойной тап: drag >16 px и pinch между тапами счётчик сбрасывают', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  x.tick(10);
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 200 });
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 240, clientY: 200 });
  touchTap(x, 10, 1, 240, 200);
  assert(!x.controller.rig.focus, 'drag засчитан как тап');
  const y = setup({ touch: true }); y.setPick(hit);
  touchTap(y);                                   // валидный первый тап
  y.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  y.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 });
  y.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  y.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  y.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  y.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  touchTap(y, 10, 1, 200, 200);                 // сразу после pinch — не двойной
  assert(!y.controller.rig.focus, 'pinch не сбросил счётчик тапов');
});

check('Двойной тап: длинный тап >300 мс и второй тап позже 350 мс не считаются', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x, 400);
  touchTap(x, 10);
  assert(!x.controller.rig.focus, 'длинный тап засчитан как тап');
  const y = setup({ touch: true }); y.setPick(hit);
  touchTap(y, 10); y.tick(500); touchTap(y, 10);
  assert(!y.controller.rig.focus, 'тапы через 500 мс засчитаны как двойной');
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
  const d = V3.clone(x.camera.direction), p = V3.clone(x.camera.position); x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 }); x.tick();
  assert(moved(d, x.camera.direction), 'свайп не изменил взгляд');
  near(dist(p, x.camera.position), 0, 1e-9, 'свайп взгляда двигает позицию');
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 });
  /* пустой левый нижний угол: прежняя граница «левая половина» запрещала свайп без причины (A4) */
  const d2 = V3.clone(x.camera.direction); x.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 200 });
  x.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 360, clientY: 260 }); x.tick();
  assert(moved(d2, x.camera.direction), 'свайп в свободной левой части игнорируется');
  x.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 360, clientY: 260 });
  /* над стиком — не берётся */
  const d3 = V3.clone(x.camera.direction); x.pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 84, clientY: 536 });
  x.pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 130, clientY: 570 }); x.tick();
  near(dist(d3, x.camera.direction), 0, 1e-9, 'свайп поверх джойстика двигает взгляд');
  x.pointer('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 130, clientY: 570 });
});

check('Параллельный тач: тап по DOM-контролу не глувит палец свайпа (аудит A1, ADR-33)', () => {
  const x = setup({ touch: true }); x.controller.setMode('fly');
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  assert(x.controller.touch.look, 'свайп не начат');
  /* второй палец ложится на стик — событие не с канваса, в capture-фазе на document */
  x.document.fire('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 60, clientY: 520, target: { id: 'stick' } });
  const d = V3.clone(x.camera.direction);
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 640, clientY: 230 }); x.tick();
  assert(moved(d, x.camera.direction), 'камера оглохла после касания контрола');
  assert(x.controller.touch.look && x.controller.touch.look.id === 1, 'жест взгляда сброшен чужим pointerdown');
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
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 650, clientY: 200 }); x.tick();
  assert(moved(d, x.camera.direction), 'взгляд оборвался из-за движения джойстика');
});

check('скрытый контроль (нулевой rect) не блокирует свайп взгляда', () => {
  const x = setup({ touch: true, controls: [{ left: 0, top: 0, right: 0, bottom: 0 }] });
  x.controller.setMode('fly');
  const d = V3.clone(x.camera.direction);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 }); x.tick();
  assert(moved(d, x.camera.direction), 'свайп заблокировался над скрытым элементом');
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
});

check('lostpointercapture не засчитывается как тап (аудит A8)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  x.tick(10);
  x.canvas.fire('lostpointercapture', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200 });
  assert(!x.controller.touch.lastTap, 'снятие capture засчитано тапом');
  touchTap(x);
  x.advance(20);
  assert(!x.controller.rig.focus, 'снимание capture + тап дали двойной тап');
});

check('dblclick после тач-жеста не дублирует действие двойного тапа (аудит A8)', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x, 10); x.tick(120); touchTap(x, 10);          // двойной тап: focus уже начат
  assert(x.controller.rig.focus, 'двойной тап не сработал');
  x.controller.rig.focus = null;
  x.dblclick();                                           // гибрид добавляет dblclick следом
  assert(!x.controller.rig.focus, 'dblclick после тача повторно запустил focus');
});

check('focusAtGround: переносит точку орбиты, у границ отказывает с сообщением', () => {
  const x = setup(), hit = V3.add(x.target, new V3(20, 10, 0), new V3());
  assert(x.controller.focusAtGround(hit.x / 1e5, hit.y / 1e5) === true, 'focus не начался');
  assert(x.controller.rig.focus);
  x.advance(20); near(dist(hit, x.controller.target), 0, 1e-6);
  const far = V3.add(x.target, new V3(900, 0, 0), new V3());
  const messages = []; x.controller.onMessage = m => messages.push(m);
  const p = V3.clone(x.camera.position), target = V3.clone(x.controller.target);
  assert(x.controller.focusAtGround(far.x / 1e5, far.y / 1e5) === false, 'выход за границы разрешён');
  assert(!x.controller.rig.focus);
  near(dist(p, x.camera.position), 0, 1e-9); near(dist(target, x.controller.target), 0, 1e-9);
  assert(messages.some(m => /слишком далеко/.test(m)), 'нет сообщения о границах');
});

check('Клавиатура: Orbit стрелки и +/- работают без drag', () => {
  const x = setup(), d = V3.clone(x.camera.direction), r = radius(x);
  x.key('ArrowRight'); x.tick(); assert(moved(d, x.camera.direction));
  x.key('+'); x.tick(); assert(radius(x) < r); const after = radius(x); x.key('-'); x.tick(); near(radius(x), after * 1.15, 1e-5);
});

check('Lock блокирует ввод и очищает клавиши', () => {
  const x = setup(); x.controller.setMode('fly'); x.key('w'); x.controller.setLocked(true); const p = V3.clone(x.camera.position);
  x.advance(); near(dist(p, x.camera.position), 0, 1e-6);
  x.controller.setLocked(false); x.advance(); near(dist(p, x.camera.position), 0, 1e-6);
});

/* ——— новые проверки WP-CAM-2 (а–е) ——— */

check('(а) свайп, ушедший пальцем поверх DOM-плашки, продолжает жест (pointer capture)', () => {
  const stickRect = { left: 20, top: 472, right: 148, bottom: 600 };
  const x = setup({ touch: true, controls: [stickRect] });
  const d = V3.clone(x.camera.direction); x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  assert(x.canvas.hasPointerCapture(1), 'orbit-палец не захвачен канвасом');
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 84, clientY: 536 }); x.tick();
  assert(moved(d, x.camera.direction), 'вращение оборвалось над плашкой стика');
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 84, clientY: 536 });
  /* в полёте — тот же контракт: look живёт при уходе пальца над контролами */
  const y = setup({ touch: true, controls: [stickRect] }); y.controller.setMode('fly');
  y.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  y.document.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 84, clientY: 536 }); y.tick();
  assert(y.controller.touch.look && y.controller.touch.look.id === 1, 'свайп взгляда сброшен над плашкой');
  const d2 = V3.clone(y.camera.direction);
  y.document.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 560 }); y.tick();
  assert(moved(d2, y.camera.direction), 'взгляд оборвался при движении поверх DOM-плашки');
});

check('(б) touch/mouse pointerdown на канвасе не глушит клавиши-каналы', () => {
  const x = setup({ touch: true }); x.controller.setMode('fly');
  x.key('w');
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 620, clientY: 210 });
  const p = V3.clone(x.camera.position); x.advance();
  assert(moved(p, x.camera.position), 'тач-свайп заглушил WASD-полёт');
  assert(x.controller.input.keys.has('KeyW'), 'touch pointerdown сбросил клавиши');
  const y = setup(); y.controller.setMode('fly');
  y.key('w');
  y.pointer('pointerdown', { button: 2 }); y.pointer('pointermove', { button: 2, clientX: 240, clientY: 230 });
  const p2 = V3.clone(y.camera.position); y.advance();
  assert(moved(p2, y.camera.position), 'мышиный drag заглушил WASD-полёт');
});

check('(в) тап-контракт: 330 мс между тапами — двойной, 400 мс — два одиночных', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x); x.tick(330); touchTap(x);
  assert(x.controller.rig.focus, 'тапы через 330 мс не признаны двойным');
  const y = setup({ touch: true }); y.setPick(hit);
  touchTap(y); y.tick(400); touchTap(y);
  assert(!y.controller.rig.focus, 'тапы через 400 мс признаны двойным');
});

check('(г) pinch между тапами отменяет накопленный тап', () => {
  const x = setup({ touch: true }), hit = V3.add(x.target, new V3(20, 0, 0), new V3()); x.setPick(hit);
  touchTap(x);                                            // валидный одиночный тап-кандидат
  x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  x.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 });
  assert(!x.controller.touch.lastTap, 'второй палец не сбросил счётчик тапов');
  x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  x.pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  x.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 100 });
  x.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 240, clientY: 100 });
  touchTap(x, 10, 1, 200, 200);                           // тап после pinch — не продолжение пары
  assert(!x.controller.rig.focus, 'pinch не отменил тап: вышел двойной');
});

check('(д) чувствительность взгляда масштабируется от FOV (fov 120° против 60° — ровно ×2)', () => {
  const a = setup(), b = setup({ fov: 2 * Math.PI / 3 }), c = setup({ frustum: {} });
  for (const x of [a, b, c]) x.controller.setMode('fly');
  const swipe = x => {
    x.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 500, clientY: 200 });
    x.pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 600, clientY: 200 });
    return x.controller.rig.intent.dYaw;                  // намерение до tick: ровно dx·0.0021·fovScale
  };
  const da = swipe(a), db = swipe(b), dc = swipe(c);
  near(da, 100 * 0.0021, 1e-12, 'fov 60° дал не базовую чувствительность');
  near(db, 2 * da, 1e-12, 'fov 120° не удвоил радианы на пиксель');
  near(dc, da, 1e-12, 'пустой frustum не откатился к 60°');
});

check('(е) за всю серию жестов камеру писал только rig: ровно 1 setView за кадр, 0 прямых записей', () => {
  const x = setup();
  const rig = x.controller.rig, cam = x.camera;
  let rigWrites = 0;
  const origApply = rig.apply.bind(rig);                  // обёртка на инстансе: shadowит прототип
  rig.apply = (...args) => { const before = cam.setViews; origApply(...args); if (cam.setViews > before) rigWrites++; };
  const views0 = cam.setViews, writes0 = cam.positionWrites;
  x.pointer('pointerdown');
  for (let i = 0; i < 15; i++) {
    x.pointer('pointermove', { clientX: 202 + 2 * i, clientY: 200 });
    const before = cam.setViews; x.tick();
    assert(cam.setViews - before <= 1, `кадр ${i}: больше одного setView`);
  }
  x.pointer('pointerup');
  x.wheel(-100); x.tick();
  x.controller.setMode('fly');
  x.controller.setStick(0, 1);
  for (let i = 0; i < 10; i++) {
    const before = cam.setViews; x.tick();
    assert(cam.setViews - before <= 1, `кадр полёта ${i}: больше одного setView`);
  }
  assert(cam.setViews - views0 === rigWrites, 'вне rig.apply в камеру писали');
  assert(rigWrites > 0, 'серия вообще не двигала камеру');
  assert(cam.positionWrites === writes0, 'были прямые записи в camera.position');
});

check('вид экрана 1·2·3 разбирается и в плане, когда 3D неактивен (регресс 27.11: клавиши были декорацией)', () => {
  const x = setup();
  x.setActive(false);
  x.key('1', { code: 'Digit1' }); x.key('2', { code: 'Digit2' }); x.key('3', { code: 'Digit3' });
  assert(x.viewKeys.join(',') === '1,2,3', `из плана вид не менялся: [${x.viewKeys.join(',')}]`);
});

check('в открытом обучении 1·2·3 вид не меняют, V·F без живого 3D молчат', () => {
  const x = setup({ tutOpen: true });
  x.key('2', { code: 'Digit2' });
  assert(x.viewKeys.length === 0, 'вид сменился под карточкой обучения');
  const y = setup();
  y.setActive(false);
  y.key('v', { code: 'KeyV' }); y.key('f', { code: 'KeyF' }); y.tick();
  assert(y.controller.mode === 'orbit', 'V/F сменили режим камеры без живого 3D');
});

done();
