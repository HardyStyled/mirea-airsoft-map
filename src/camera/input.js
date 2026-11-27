/* что здесь живёт: мышь, клавиатура и колесо — превращаются в намерения rig'а. */
/* input.js — мышь + клавиатура + колесо → намерения rig'а (WP-CAM-2, SPEC §3).
 * Дисциплина: обработчики НИЧЕГО не пишут в камеру — только методы rig (intent/каналы),
 * писатель один: rig.apply(). Поведение перенесено из camera.js 1:1 (ADR-34 split):
 * клавиши WASD/QE/Shift/R/Esc/стрелки/+−, wheel (в полёте скорость, в орбите зум),
 * drag (ЛКМ орбита / ПКМ пан; в полёте ПКМ — взгляд), dblclick → raycast + focusTo. */

const KEY_FALLBACK = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', r: 'KeyR', shift: 'ShiftLeft' };
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createInput(options) {
  const { Cesium, viewer, rig } = options;
  const canvas = viewer.canvas;
  const usable = options.usable || (() => true);
  const doReset = options.reset || (() => rig.reset());
  const getTouchAt = options.getTouchAt || (() => 0);
  /* смена режима идёт через контроллер: при выходе из полёта он подбирает точку орбиты
   * raycast'ом — Esc должен вести себя ровно как кнопка «Осмотр» */
  const setMode = options.setMode || (m => rig.setMode(m));
  const onViewKey = options.onViewKey || (() => {});

  const keys = new Set();
  let drag = null; // активный мышиный драг: {id, button, x, y}

  const codeOf = e => e.code || KEY_FALLBACK[String(e.key || '').toLowerCase()] || e.key;
  const editable = t => t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));
  /* открытое обучение — модальное: клавиши вида не должны менять экран «за спиной» подсказки */
  const modalOpen = () => { const t = document.getElementById('tut'); return !!t && !t.hidden; };
  const focusCanvas = () => { try { canvas.focus({ preventScroll: true }); } catch (e) {} };
  /* capture обязателен: пока указатель захвачен канвасом, pointerup/move поверх DOM-плашек
   * приходят на канвас — жест не рвётся и второй pointerup-обработчик на document не нужен. */
  const capture = e => { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} };
  const release = e => { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} };

  function onPointerDown(e) {
    if (e.pointerType === 'touch') return; // тач живёт в touch.js
    if (!usable()) return;
    if (e.button !== 0) rig.cancelFocus();
    focusCanvas();
    const orbitButton = rig.mode === 'fly' ? e.button === 2 : (e.button === 0 || e.button === 2);
    if (!orbitButton) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = { id: e.pointerId, button: e.button, x: e.clientX, y: e.clientY };
    capture(e);
    canvas.style.cursor = rig.mode === 'fly' ? 'crosshair' : (e.button === 2 ? 'grabbing' : 'grab');
  }

  function onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    if (!drag || drag.id !== e.pointerId || !usable()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (rig.mode === 'fly') rig.lookBy(dx, dy);
    else if (drag.button === 0) options.orbitBy(dx, dy);
    else rig.panByPixels(dx, dy);
  }

  /* ОДИН обработчик завершения указателя на канвасе: pointerup + pointercancel +
   * lostpointercapture. Дубля на document нет — capture сам приводит up снаружи к канвасу. */
  function onPointerEnd(e) {
    if (e.pointerType === 'touch') return;
    if (drag && drag.id === e.pointerId) {
      drag = null;
      canvas.style.cursor = '';
    }
    release(e);
  }

  function onDoubleClick(e) {
    if (!usable() || e.button > 0) return;
    /* гибрид (тач+мышь) на двойной тап даёт ещё и dblclick: двойной тап уже обработан в
     * touch.js, второй раз тот же жест не исполняем (аудит A8, перенос 1:1) */
    const lastTouch = getTouchAt();
    if (lastTouch && performance.now() - lastTouch < 700) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // raycast + перенос точки орбиты: общий механизм контроллера (как _focusAt в camera.js)
    options.pickFocus(e.clientX, e.clientY);
  }

  function onWheel(e) {
    if (!usable()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    rig.cancelFocus();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? canvas.clientHeight : 1));
    if (rig.mode === 'fly') {
      // в полёте колесо — скорость, не зум (SPEC §2.5)
      rig.setSpeed(clamp(rig.speed * Math.exp(-delta * 0.002), 0.5, 60));
    } else rig.zoomBy(Math.exp(delta * 0.0012));
  }

  function onKeyDown(e) {
    if (editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = codeOf(e);
    /* 1/2/3 — вид экрана, он меняется из любого режима: значки на пунктах меню не должны быть
       декорацией, пока приложение сидит в плане. Камерные клавиши живут под usable(). */
    if (['Digit1', 'Digit2', 'Digit3'].includes(code) && !modalOpen()) {
      e.preventDefault();
      onViewKey(+code.slice(-1));
      return;
    }
    if (!usable()) return;
    if (code === 'KeyR') {
      e.preventDefault();
      doReset();
      return;
    }
    if (e.key === 'Escape' && rig.mode === 'fly') {
      e.preventDefault();
      setMode('orbit');
      return;
    }
    /* V/F — режим камеры (осмотр/полёт), они имеют смысл только когда 3D жив. В открытом
     * обучении вид не меняем: подсказка не должна уезжать из-под читателя. */
    if (code === 'KeyV' || code === 'KeyF') {
      if (modalOpen()) return;
      if (code === 'KeyV') { e.preventDefault(); setMode('orbit'); return; }
      e.preventDefault();
      setMode('fly');
      return;
    }
    if (rig.mode === 'fly') {
      if (FLY_KEYS.has(code)) {
        e.preventDefault();
        rig.cancelFocus();
        keys.add(code);
      } else if (ARROWS.has(e.key)) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -18 : e.key === 'ArrowRight' ? 18 : 0;
        const dy = e.key === 'ArrowUp' ? -18 : e.key === 'ArrowDown' ? 18 : 0;
        rig.lookBy(dx, dy);
      }
      return;
    }
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      if (e.shiftKey) rig.cancelFocus();
      if (e.shiftKey) rig.panByPixels(e.key === 'ArrowLeft' ? -40 : e.key === 'ArrowRight' ? 40 : 0,
        e.key === 'ArrowUp' ? -40 : e.key === 'ArrowDown' ? 40 : 0);
      else options.orbitBy(e.key === 'ArrowLeft' ? -18 : e.key === 'ArrowRight' ? 18 : 0,
        e.key === 'ArrowUp' ? -18 : e.key === 'ArrowDown' ? 18 : 0);
    } else if (['+', '=', '-', '_'].includes(e.key)) {
      e.preventDefault();
      rig.cancelFocus();
      rig.zoomBy(e.key === '+' || e.key === '=' ? 1 / 1.15 : 1.15);
    }
  }

  function onKeyUp(e) {
    const code = codeOf(e);
    if (FLY_KEYS.has(code)) {
      keys.delete(code);
      if (usable() && rig.mode === 'fly' && !editable(e.target)) e.preventDefault();
    }
  }

  function clearKeys() { keys.clear(); }

  function clearInput() {
    keys.clear();
    drag = null;
    canvas.style.cursor = '';
  }

  function applyToRig() {
    if (!keys.size || !usable() || rig.mode !== 'fly') return;
    const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const vertical = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
    if (!forward && !right && !vertical) return;
    const norm = Math.hypot(forward, right, vertical); // диагональ не быстрее прямой (тест camera.js)
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const v = rig.speed * (fast ? 4 : 1) / norm;
    // Скорость в системе ВЗГЛЯДА: W туда, куда смотрит камера, D вправо по камере, E/Q по вертикали.
    // Раньше уходило в мировые оси ENU — W ехал на север независимо от курса (регресс 27.11).
    rig.moveBy(forward * v, right * v, vertical * v);
  }

  const bindings = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); bindings.push([target, type, fn, opts]); };

  on(canvas, 'contextmenu', e => e.preventDefault());
  on(canvas, 'pointerdown', onPointerDown, true);
  on(canvas, 'pointermove', onPointerMove, true);
  on(canvas, 'pointerup', onPointerEnd, true);
  on(canvas, 'pointercancel', onPointerEnd, true);
  on(canvas, 'lostpointercapture', onPointerEnd, true);
  on(canvas, 'dblclick', onDoubleClick, true);
  on(canvas, 'wheel', onWheel, { passive: false, capture: true });
  on(document, 'keydown', onKeyDown);
  on(document, 'keyup', onKeyUp);
  on(window, 'blur', clearInput);
  on(document, 'visibilitychange', () => { if (document.hidden) clearInput(); });
  /* Правило D6: touch-нажатие ВНЕ канваса (стик, кнопки высоты, FAB, меню, план) сбрасывает
   * только клавиши — у capture нет, иначе залипают (аудит A1). Мышиное нажатие вне канваса
   * клавиши НЕ трогает: на гибридных устройствах клик по UI не должен глушить WASD-полёт. */
  on(document, 'pointerdown', e => {
    if (e.target !== canvas && e.pointerType === 'touch') keys.clear();
  }, true);

  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D-камера. Орбита: стрелки вращают, Shift и стрелки переносят, плюс и минус меняют дистанцию. Свободная камера: WASD и QE, стрелки меняют взгляд. R возвращает исходный ракурс, Esc включает орбиту.');

  return {
    clearInput,
    clearKeys,
    applyToRig,
    get drag() { return drag; },
    get keys() { return keys; },
    dispose() {
      for (const [t, type, fn, opts] of bindings) t.removeEventListener(type, fn, opts);
      bindings.length = 0;
      clearInput();
    },
  };
}
