/* что здесь живёт: публичный API камеры — склейка rig + мышь/клавиатура + тач-жесты. */
/* controller.js — публичный API камеры (WP-CAM-2, SPEC §5): собирает rig + input + touch
 * и отдаёт ровно то, что использует приложение. Единственный писатель камеры — rig.apply();
 * rAF-цикл один: start() гоняет rig.tick через controller.tick, чтобы клавиши применялись
 * каждый кадр. Никаких обращений к camera.setView вне rig. */

import { CameraRig } from './rig.js?v=10';
import { createInput } from './input.js?v=10';
import { createTouch } from './touch.js?v=10';

export function createController(options) {
  const { Cesium, viewer } = options;
  const canvas = viewer.canvas;
  const rig = new CameraRig(options);

  /* единый критерий «ввод сейчас уместен» для input/touch (как _usable в camera.js) */
  const usable = () => rig.enabled && !rig.locked && rig.isActive();
  const finite = v => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  const v3 = v => Cesium.Cartesian3.clone(v);

  /* raycast: scene.pickPosition, затем pickFromRay по camera.getPickRay — перенос 1:1 из
   * camera.js _pickWorld (включая typeof-защиты: в тестах и на старых GPU чего-то может не быть) */
  function pickWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const position = new Cesium.Cartesian2(clientX - rect.left, clientY - rect.top);
    return pickAtCanvas(position);
  }

  function pickAtCanvas(position) {
    let hit = null;
    if (viewer.scene.pickPositionSupported !== false && typeof viewer.scene.pickPosition === 'function') {
      try { hit = viewer.scene.pickPosition(position); } catch (e) {}
      if (finite(hit)) return v3(hit);
    }
    if (typeof viewer.scene.pickFromRay === 'function' && typeof viewer.camera.getPickRay === 'function') {
      try {
        const ray = viewer.camera.getPickRay(position);
        const result = viewer.scene.pickFromRay(ray);
        hit = result && (result.position || result);
      } catch (e) {}
      if (finite(hit)) return v3(hit);
    }
    return null;
  }

  /* общий вход для двойного клика, двойного тапа и фокуса по плану: координаты окна →
   * raycast → tween rig'а. Возвращает true, если перенос точки орбиты стартовал. */
  function pickFocus(clientX, clientY) {
    if (!usable() || rig.mode !== 'orbit') return false;
    return rig.focusTo(pickWorld(clientX, clientY), 400);
  }

  const touch = createTouch({ Cesium, viewer, rig, usable, pickFocus });
  const input = createInput({
    Cesium, viewer, rig, usable,
    onMessage: m => rig.onMessage(m),
    getTouchAt: () => touch.lastTouchAt(),
    reset: () => controller.reset(),
    setMode: m => setMode(m),
    pickFocus,
    // 1/2/3 — вид экрана; это не камера, поэтому выводим наружу через колбэк приложения
    onViewKey: options.onViewKey || (() => {}),
  });

  function setMode(mode) {
    if (mode !== 'orbit' && mode !== 'fly') return;
    const wasFly = rig.isFlying();
    rig.setMode(mode);
    /* выход из полёта (как в camera.js): точка орбиты берётся raycast'ом в центр экрана;
     * промах — впереди по направлению взгляда на прежней дистанции (это делает сам rig) */
    if (wasFly && mode === 'orbit') {
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const hit = pickAtCanvas(center);
      if (hit) rig.setOrbitTarget(hit);
    }
  }

  /* тап по 2D-плану: цель из геометрии плана, без raycast'а сцены (camera.js 1:1) */
  function focusAtGround(lon, lat) {
    if (!usable() || rig.mode !== 'orbit') return false;
    return rig.focusTo(Cesium.Cartesian3.fromDegrees(lon, lat, 0), 400);
  }

  function reset() {
    rig.reset();
    input.clearInput();
    touch.clearInput();
  }

  /* очистка ввода при внешних блокировках: залипшие клавиши/жесты не должны «выстрелить»
   * после разблокировки (как _clearInput в camera.js) */
  function setEnabled(on) {
    rig.setEnabled(on);
    input.clearInput();
    touch.clearInput();
  }
  function setLocked(on) {
    rig.setLocked(on);
    input.clearInput();
    touch.clearInput();
  }
  function captureFor2D() {
    rig.captureFor2D();
    input.clearInput();
    touch.clearInput();
  }

  /* rAF-цикл контроллера: rig.tick сам по себе не знает про клавиши — перед ним input
   * переводит зажатые клавиши в намерения этого кадра */
  let rafId = null;
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    controller.tick(now);
  }
  function start() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function tick(now) {
    input.applyToRig();
    rig.tick(now);
  }

  function dispose() {
    stop();
    input.dispose();
    touch.dispose();
    rig.dispose();
  }

  const controller = {
    /* внутренние модули — для тестов и отладки; приложению трогать не нужно */
    rig, input, touch,

    setMode,
    getMode: () => rig.getMode(),
    isFlying: () => rig.isFlying(),
    setEnabled, setLocked,
    reset,
    captureFor2D,
    restoreFrom2D: () => rig.restoreFrom2D(),
    panByGround: (dLon, dLat) => rig.panByGround(dLon, dLat),
    zoomBy: factor => rig.zoomBy(factor),
    orbitBy: (dx, dy) => rig.orbitBy(dx, dy),
    setSpeed: v => rig.setSpeed(v),
    setStick: (x, y) => rig.setStick(x, y),
    setVert: v => rig.setVert(v),
    setVertical: v => rig.setVert(v), // совместимость с app.js:683 до его миграции на setVert
    setRun: on => rig.setRun(on),
    setPose: pose => rig.setPose(pose),
    homePose: pose => rig.homePose(pose),
    focusAt: (x, y) => pickFocus(x, y),
    focusAtGround,
    tick, start, stop, dispose,

    /* геттеры под текущий app.js (cameraController.mode) и регрессионные тесты */
    get mode() { return rig.mode; },
    get speed() { return rig.speed; },
    get target() { return rig.target; },
    get enabled() { return rig.enabled; },
    get locked() { return rig.locked; },
    /* onMessage можно переприсвоить после создания (как в camera.js): rig хранит его
     * как поле, поэтому геттер/сеттер проксируют в rig — обработчики читают rig на лету */
    get onMessage() { return rig.onMessage; },
    set onMessage(fn) { rig.onMessage = fn; },
  };

  /* как autoStart в camera.js: по умолчанию цикл стартует сам, тесты гоняют tick вручную */
  if (options.autoStart !== false) start();
  return controller;
}
