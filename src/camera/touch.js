/* что здесь живёт: тач-жесты пальцами — орбита, щипок, взгляд, тап и двойной тап. */
/* touch.js — тач-жесты → намерения rig'а (WP-CAM-2, SPEC §4, ADR-33).
 * Обработчики ничего не пишут в камеру: только методы rig. Перенос из camera.js 1:1:
 * 1 палец в орбите — orbitBy; 2 пальца — щипок (zoomBy) + пан по середине;
 * в полёте 1 палец — взгляд, 2 пальца — щипок без пана; тап/двойной тап по контракту
 * PLAN-mobile: тап ≤300 мс/≤16 px, двойной — пара ≤350 мс/≤40 px, pinch сбрасывает тап. */

const TAP_MAX_MS = 300;   // тап: нажатие не длиннее
const TAP_MAX_PX = 16;    // тап: смещение не больше
const DBL_MAX_MS = 350;   // двойной тап: пауза между тапами
const DBL_MAX_PX = 40;    // двойной тап: расстояние между тапами

export function createTouch(options) {
  const { viewer, rig } = options;
  const canvas = viewer.canvas;
  const usable = options.usable || (() => true);
  const pickFocus = options.pickFocus || (() => false);
  const focusCanvas = () => { try { canvas.focus({ preventScroll: true }); } catch (e) {} };
  /* capture обязателен: палец, ушедший поверх DOM-плашки (стик, мини-карта), продолжает
   * жест — события приходят на канвас, inDomControl проверяется только на pointerdown. */
  const capture = e => { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} };
  const release = e => { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} };

  const pointers = new Map(); // активные тач-указатели в орбите: id → {x, y}
  let look = null;            // активный «взгляд»-указатель в полёте: {id, x, y}
  let pinch = null;           // состояние щипка: {distance, x, y}
  let tap = null;             // текущий тап: {id, x0, y0, at, moved}
  let lastTap = null;         // завершённый тап: {x, y, at} — кандидат в двойной
  let touchAt = 0;            // время последнего touch-указателя: фильтр dblclick на гибридах

  /* чувствительность взгляда от FOV (SPEC §4): при широком FOV тот же угол покрывает
   * меньше пикселей, поэтому на пиксель приходится больше радиан: 0.0021 · fov/(60°).
   * fov берём из frustum (fov → fovy → 60°), т.к. app умеет менять FOV прямо в рантайме. */
  function fovScale() {
    const frustum = viewer.camera.frustum || {};
    const fov = frustum.fov || frustum.fovy || (Math.PI / 3);
    return fov / (Math.PI / 3);
  }

  /* точка тача над видимым DOM-контролом: свайп взгляда над ними не стартует (аудит A4).
   * Проверяется ТОЛЬКО на pointerdown — дальше указатель захвачен канвасом. */
  function inDomControl(e) {
    for (const el of document.querySelectorAll('#stick, #flyBtns, #fabCol, .menu, #mm, #fovCtl')) {
      const r = el.getBoundingClientRect();
      // скрытый элемент (display:none) даёт нулевой rect; offsetParent у fixed-элементов null,
      // поэтому на него смотреть нельзя
      if (!r.width || !r.height) continue;
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
    }
    return false;
  }

  /* пан по пикселям щипка: mpp как в camera.js _pan; знак — «сцена едет за пальцем». */
  function panByPixels(dx, dy) {
    const distance = Math.max(rig.distance, rig.minDistance);
    const frustum = viewer.camera.frustum || {};
    const fov = frustum.fov || frustum.fovy || Math.PI / 3;
    const mpp = 2 * distance * Math.tan(fov / 2) / Math.max(1, canvas.clientHeight);
    rig.translateBy(-dx * mpp, dy * mpp, 0);
  }

  function resetPinch() {
    if (pointers.size !== 2) { pinch = null; return; }
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    if (e.pointerType !== 'touch') return; // мышь живёт в input.js
    if (!usable()) return;
    rig.cancelFocus();
    focusCanvas();
    touchAt = performance.now();
    if (rig.mode === 'fly') {
      /* тач-полёт (ADR-33): палец по канвасу — свайп взгляда; точки над DOM-контролами
       * (стик, кнопки высоты, мини-карта) не трогаем */
      if (inDomControl(e)) return;
      e.preventDefault();
      look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e);
      return;
    }
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e);
    resetPinch();
    if (pointers.size === 1) tap = { id: e.pointerId, x0: e.clientX, y0: e.clientY, at: performance.now(), moved: 0 };
    else tap = lastTap = null; // второй палец = pinch: счётчик тапов обнуляется (контракт)
  }

  function onPointerMove(e) {
    if (e.pointerType !== 'touch') return;
    if (look && look.id === e.pointerId) {
      e.preventDefault();
      const k = fovScale(); // FOV мог измениться между кадрами — масштаб берём на каждый жест
      rig.lookBy((e.clientX - look.x) * k, (e.clientY - look.y) * k);
      look.x = e.clientX; look.y = e.clientY;
      return;
    }
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    const old = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      if (tap && tap.id === e.pointerId) {
        tap.moved = Math.max(tap.moved, Math.hypot(e.clientX - tap.x0, e.clientY - tap.y0));
      }
      rig.orbitBy(e.clientX - old.x, e.clientY - old.y);
    } else if (pointers.size === 2) {
      const previous = pinch;
      resetPinch();
      if (previous) {
        panByPixels(pinch.x - previous.x, pinch.y - previous.y);
        if (previous.distance > 1 && pinch.distance > 1) rig.zoomBy(previous.distance / pinch.distance);
      }
    }
  }

  /* тап-контракт: отменяющие события (cancel/lostcapture) тапом не считаются (аудит A8).
   * commitTapAt вызывается только с валидным снимком тапа (см. onPointerUp). */
  function commitTapAt(e, now) {
    const prev = lastTap;
    lastTap = null;
    const near = !!prev && Math.abs(e.clientX - prev.x) <= DBL_MAX_PX && Math.abs(e.clientY - prev.y) <= DBL_MAX_PX;
    if (prev && now - prev.at <= DBL_MAX_MS && near) {
      if (rig.mode === 'orbit') pickFocus(e.clientX, e.clientY);
    } else {
      lastTap = { x: e.clientX, y: e.clientY, at: now };
    }
  }

  /* завершение тач-указателя: один обработчик на канвасе для up/cancel/lostpointercapture.
   * Для тапа берём снимок (t) ДО удаления указателя: cancel/lost не засчитываются (A8). */
  function onPointerUp(e, cancelled) {
    if (e.pointerType !== 'touch') return;
    if (look && look.id === e.pointerId) look = null;
    if (pointers.has(e.pointerId)) {
      const t = tap;
      pointers.delete(e.pointerId);
      resetPinch();
      if (t && t.id === e.pointerId) {
        tap = null;
        const now = performance.now();
        if (cancelled || t.moved > TAP_MAX_PX || now - t.at > TAP_MAX_MS) { lastTap = null; }
        else commitTapAt(e, now);
      }
    }
    release(e);
  }

  const bindings = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); bindings.push([target, type, fn]); };

  on(canvas, 'pointerdown', onPointerDown, true);
  on(canvas, 'pointermove', onPointerMove, true);
  on(canvas, 'pointerup', e => onPointerUp(e, false), true);
  on(canvas, 'pointercancel', e => onPointerUp(e, true), true);
  on(canvas, 'lostpointercapture', e => onPointerUp(e, true), true);

  return {
    clearInput() {
      pointers.clear();
      look = null; pinch = null; tap = null; lastTap = null;
    },
    lastTouchAt() { return touchAt; },
    get look() { return look; },
    get pointers() { return pointers; },
    get pinch() { return pinch; },
    get tap() { return tap; },
    get lastTap() { return lastTap; },
    fovScale,
    dispose() {
      for (const [t, type, fn] of bindings) t.removeEventListener(type, fn);
      bindings.length = 0;
      clearInput();
    },
  };
}
