/* CameraController — орбита и свободный полёт (ADR-28). Cesium inputs здесь отключены. */
(function (root) {
'use strict';

const KEY_FALLBACK = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', r: 'KeyR', shift: 'ShiftLeft' };
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class CameraController {
  constructor(options) {
    this.Cesium = options.Cesium;
    this.viewer = options.viewer;
    this.camera = options.viewer.camera;
    this.scene = options.viewer.scene;
    this.canvas = options.viewer.canvas;
    this.extent = options.extent;
    this.isActive = options.isActive || (() => true);
    this.onState = options.onState || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.reducedMotion = options.reducedMotion || (() => false);
    this.touchOnly = options.touchOnly || (() => false);
    this.autoStart = options.autoStart !== false;
    this.mode = 'orbit';
    this.target = this.v3(options.target);
    this.home = {
      position: this.v3(this.camera.position), direction: this.v3(this.camera.direction),
      up: this.v3(this.camera.up), target: this.v3(options.target),
    };
    this.keys = new Set();
    this.pointers = new Map();
    this.drag = null;
    this.look = null;                     // тач-свайп взгляда в полёте (левая половина канваса)
    this.pinch = null;
    this.focus = null;
    this.tap = null;                      // текущий тап: {id,x0,y0,at,moved}
    this.lastTap = null;                  // завершённый тап: {x,y,at} — для двойного тапа
    this._touchAt = 0;                    // время последнего touch-указателя: фильтр dblclick на гибридах
    this.saved2d = null;
    this.enabled = true;
    this.locked = false;
    this.speed = 6;
    this.yaw = 0;
    this.pitch = 0;
    this.lookSensitivity = 0.0021;
    this.orbitSensitivity = 0.006;
    this.minDistance = 0.5;
    this.maxDistance = options.maxDistance || 320;
    this.maxHeight = 400;
    /* тач-полёт: значения виртуального джойстика (x — вправо, y — вперёд), кнопок высоты и «бег» */
    this.stick = { x: 0, y: 0 };
    this.vert = 0;
    this.run = false;
    this._last = performance.now();
    this._initBounds();
    this._initFlyAngles();
    this._disableCesium();
    this._bind();
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D-камера. Осмотр: стрелки вращают, Shift и стрелки переносят, плюс и минус меняют дистанцию. Полёт: WASD и QE, стрелки меняют взгляд. R возвращает исходный ракурс, Esc возвращает осмотр.');
    this._emitState();
    if (this.autoStart) {
      const frame = now => {
        this.tick(now);
        this._raf = requestAnimationFrame(frame);
      };
      this._raf = requestAnimationFrame(frame);
    }
  }

  v3(v) { return this.Cesium.Cartesian3.clone(v); }
  add(a, b) { return this.Cesium.Cartesian3.add(a, b, new this.Cesium.Cartesian3()); }
  sub(a, b) { return this.Cesium.Cartesian3.subtract(a, b, new this.Cesium.Cartesian3()); }
  scale(v, k) { return this.Cesium.Cartesian3.multiplyByScalar(v, k, new this.Cesium.Cartesian3()); }
  norm(v) { return this.Cesium.Cartesian3.normalize(v, new this.Cesium.Cartesian3()); }
  distance(a, b) { return this.Cesium.Cartesian3.distance(a, b); }
  dot(a, b) { return this.Cesium.Cartesian3.dot(a, b); }
  cross(a, b) { return this.Cesium.Cartesian3.cross(a, b, new this.Cesium.Cartesian3()); }
  finite(v) { return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }

  _enu(origin) { return this.Cesium.Transforms.eastNorthUpToFixedFrame(origin); }
  _toLocal(matrix, v) {
    const inverse = this.Cesium.Matrix4.inverse(matrix, new this.Cesium.Matrix4());
    return this.Cesium.Matrix4.multiplyByPoint(inverse, v, new this.Cesium.Cartesian3());
  }
  _toWorld(matrix, v) { return this.Cesium.Matrix4.multiplyByPoint(matrix, v, new this.Cesium.Cartesian3()); }
  _dirToWorld(matrix, v) { return this.Cesium.Matrix4.multiplyByPointAsVector(matrix, v, new this.Cesium.Cartesian3()); }
  _dirToLocal(matrix, v) {
    const inverse = this.Cesium.Matrix4.inverse(matrix, new this.Cesium.Matrix4());
    return this.Cesium.Matrix4.multiplyByPointAsVector(inverse, v, new this.Cesium.Cartesian3());
  }
  _upAt(position) { return this.norm(this._dirToWorld(this._enu(position), this.Cesium.Cartesian3.UNIT_Z)); }

  _initBounds() {
    const e = this.extent, C = this.Cesium;
    this.siteCenter = C.Cartesian3.fromDegrees((e.w + e.e) / 2, (e.s + e.n) / 2, 0);
    this.siteEnu = this._enu(this.siteCenter);
    const corners = [[e.w, e.s], [e.w, e.n], [e.e, e.s], [e.e, e.n]].map(([lon, lat]) =>
      this._toLocal(this.siteEnu, C.Cartesian3.fromDegrees(lon, lat, 0)));
    this.bounds = {
      minX: Math.min(...corners.map(p => p.x)) - 80, maxX: Math.max(...corners.map(p => p.x)) + 80,
      minY: Math.min(...corners.map(p => p.y)) - 80, maxY: Math.max(...corners.map(p => p.y)) + 80,
    };
  }

  /* Нижняя граница высоты снята (PLAN-mobile N1): камера опускается сколько хочет.
   * Прямоугольник участка ±80 м и потолок maxHeight остаются. */
  _clampPosition(position) {
    const p = this._toLocal(this.siteEnu, position);
    p.x = clamp(p.x, this.bounds.minX, this.bounds.maxX);
    p.y = clamp(p.y, this.bounds.minY, this.bounds.maxY);
    p.z = Math.min(p.z, this.maxHeight);
    return this._toWorld(this.siteEnu, p);
  }

  _inside(position) {
    const p = this._toLocal(this.siteEnu, position), b = this.bounds;
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z <= this.maxHeight;
  }

  _disableCesium() {
    const c = this.scene.screenSpaceCameraController;
    if (c) c.enableInputs = false;
  }

  _listen(target, type, fn, options) { target.addEventListener(type, fn, options); }

  _bind() {
    this._listen(this.canvas, 'contextmenu', e => e.preventDefault());
    this._listen(this.canvas, 'pointerdown', e => this._pointerDown(e), true);
    this._listen(this.canvas, 'pointermove', e => this._pointerMove(e), true);
    this._listen(this.canvas, 'pointerup', e => this._pointerUp(e), true);
    this._listen(this.canvas, 'pointercancel', e => this._pointerUp(e), true);
    this._listen(this.canvas, 'lostpointercapture', e => this._pointerUp(e), true);
    this._listen(this.canvas, 'dblclick', e => this._doubleClick(e), true);
    this._listen(this.canvas, 'wheel', e => this._wheel(e), { passive: false, capture: true });
    this._listen(document, 'keydown', e => this._keyDown(e));
    this._listen(document, 'keyup', e => this._keyUp(e));
    this._listen(document, 'pointerup', e => this._pointerUp(e), true);
    this._listen(document, 'pointercancel', e => this._pointerUp(e), true);
    this._listen(window, 'blur', () => this._clearInput());
    this._listen(document, 'visibilitychange', () => { if (document.hidden) this._clearInput(); });
    /* Касание DOM-контрола вне канваса (джойстик, кнопки полёта, FAB, меню, план) НЕ должно
     * обрывать жесты канваса: параллельный тач «джойстик + камера» (ADR-33). Указатели живут
     * в capture по pointerId и переживают чужие pointerdown; залипают только клавиши — их у
     * capture нет, поэтому сбрасываем именно их (находка аудита A1). */
    this._listen(document, 'pointerdown', e => { if (e.target !== this.canvas) this.keys.clear(); }, true);
  }

  _usable() { return this.enabled && !this.locked && this.isActive(); }
  _code(e) { return e.code || KEY_FALLBACK[String(e.key || '').toLowerCase()] || e.key; }
  _editable(target) { return target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)); }
  _requestRender() { this.scene.requestRender(); }
  _focusCanvas() { try { this.canvas.focus({ preventScroll: true }); } catch (e) {} }
  _capture(e) { try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {} }

  _clearInput() {
    this.keys.clear();
    this.pointers.clear();
    this.drag = null;
    this.look = null;
    this.pinch = null;
    this.tap = null;
    this.lastTap = null;
    this.canvas.style.cursor = '';
  }

  _cancelFocus() { this.focus = null; }

  _setView(position, target) {
    const enu = this._enu(target);
    const localDirection = this.norm(this.scale(this._toLocal(enu, position), -1));
    let localUp = this.Cesium.Cartesian3.UNIT_Z;
    if (Math.abs(this.dot(localDirection, localUp)) > 0.999) localUp = this.Cesium.Cartesian3.UNIT_Y;
    localUp = this.norm(this.sub(localUp, this.scale(localDirection, this.dot(localDirection, localUp))));
    this.camera.setView({
      destination: position,
      orientation: { direction: this._dirToWorld(enu, localDirection), up: this._dirToWorld(enu, localUp) },
    });
  }

  _orbit(dx, dy) {
    const enu = this._enu(this.target);
    const p = this._toLocal(enu, this.camera.position);
    let radius = Math.max(this.minDistance, Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z));
    // знак задаёт convention «сцена едет за курсором», как пан и 2D:
    // тянем вправо — модель уходит вправо, камера облетает точку в другую сторону (решение владельца 25.11)
    let yaw = Math.atan2(p.x, p.y) + dx * this.orbitSensitivity;
    let elevation = Math.asin(clamp(p.z / radius, -1, 1)) + dy * this.orbitSensitivity;
    elevation = clamp(elevation, -1.45, 1.52);
    const flat = radius * Math.cos(elevation);
    const local = new this.Cesium.Cartesian3(flat * Math.sin(yaw), flat * Math.cos(yaw), radius * Math.sin(elevation));
    const candidate = this._clampPosition(this._toWorld(enu, local));
    this.camera.position = candidate;
    this._setView(this.camera.position, this.target);
    this._requestRender();
  }

  _translate(offset) {
    const oldPosition = this.v3(this.camera.position);
    const position = this._clampPosition(this.add(oldPosition, offset));
    const applied = this.sub(position, oldPosition);
    this.target = this.add(this.target, applied);
    this.camera.position = position;
    this._setView(position, this.target);
    this._requestRender();
  }

  _pan(dx, dy) {
    const distance = Math.max(this.minDistance, this.distance(this.camera.position, this.target));
    const frustum = this.camera.frustum || {};
    const fov = frustum.fovy || frustum.fov || Math.PI / 3;
    const mpp = 2 * distance * Math.tan(fov / 2) / Math.max(1, this.canvas.clientHeight);
    const offset = this.add(this.scale(this.camera.right, -dx * mpp), this.scale(this.camera.up, dy * mpp));
    this._translate(offset);
  }

  _dolly(factor) {
    const offset = this.sub(this.camera.position, this.target);
    const radius = this.distance(this.camera.position, this.target);
    if (radius < 1e-6) return;
    const next = clamp(radius * factor, this.minDistance, this.maxDistance);
    const position = this._clampPosition(this.add(this.target, this.scale(offset, next / radius)));
    this.camera.position = position;
    this._setView(position, this.target);
    this._requestRender();
  }

  _pickWorld(position) {
    let hit = null;
    if (this.scene.pickPositionSupported !== false && typeof this.scene.pickPosition === 'function') {
      try { hit = this.scene.pickPosition(position); } catch (e) {}
      if (this.finite(hit)) return this.v3(hit);
    }
    if (typeof this.scene.pickFromRay === 'function' && typeof this.camera.getPickRay === 'function') {
      try {
        const ray = this.camera.getPickRay(position);
        const result = this.scene.pickFromRay(ray);
        hit = result && (result.position || result);
      } catch (e) {}
      if (this.finite(hit)) return this.v3(hit);
    }
    return null;
  }

  /* Перенос точки орбиты: камера едет параллельно, дистанция и направление сохранены.
   * Общий механизм для двойного клика, двойного тапа и тапа по плану. */
  _startFocus(target) {
    if (!this.finite(target)) return false;
    const offset = this.sub(this.camera.position, this.target);
    const endPosition = this.add(target, offset);
    if (!this._inside(endPosition)) {
      this.onMessage('точка слишком далеко: исходная дистанция выводит камеру за границы участка');
      return false;
    }
    this._clearInput();
    const now = performance.now();
    this.focus = {
      start: now, duration: this.reducedMotion() ? 0 : 400,
      fromPosition: this.v3(this.camera.position), fromTarget: this.v3(this.target),
      endPosition, endTarget: target,
      direction: this.v3(this.camera.direction), up: this.v3(this.camera.up),
    };
    if (!this.focus.duration) this.tick(now);
    return true;
  }

  _focusAt(windowPosition) {
    if (!this._usable() || this.mode !== 'orbit') return false;
    const rect = this.canvas.getBoundingClientRect();
    const position = new this.Cesium.Cartesian2(windowPosition.x - rect.left, windowPosition.y - rect.top);
    return this._startFocus(this._pickWorld(position));
  }

  /* тап по 2D-плану в осмотре: цель берётся из геометрии плана, без raycast'а сцены */
  focusAtGround(lon, lat) {
    if (!this._usable() || this.mode !== 'orbit') return false;
    return this._startFocus(this.Cesium.Cartesian3.fromDegrees(lon, lat, 0));
  }

  _doubleClick(e) {
    if (this.mode !== 'orbit' || this.touchOnly()) return;
    /* гибрид-устройства (тач + мышь) на двойной тап дают ещё и dblclick: двойной тап уже
     * обработан в _tapUp, второй раз тот же жест не исполняем (находка аудита A8) */
    if (performance.now() - (this._touchAt || 0) < 700) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this._focusAt({ x: e.clientX, y: e.clientY });
  }

  /* точка тача над видимым DOM-контролом: свайп взгляда над ними не стартует. Раньше стояла
   * жёсткая граница «левая половина канваса» — из-за неё взгляд не брался в левой части экрана
   * там, где никакого контрола нет, и брался поверх мини-карты (находка аудита A4). */
  _inDomControl(e) {
    for (const el of document.querySelectorAll('#stick, #flyBtns, #fabCol, .menu, #mm, #status')) {
      const r = el.getBoundingClientRect();
      // скрытый элемент (display:none) даёт нулевой rect; offsetParent у fixed-элементов null,
      // поэтому на него смотреть нельзя
      if (!r.width || !r.height) continue;
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
    }
    return false;
  }

  _pointerDown(e) {
    if (!this._usable()) return;
    this._cancelFocus();
    this._focusCanvas();
    if (e.pointerType === 'touch') {
      this._touchAt = performance.now();
      if (this.mode === 'fly') {
        /* тач-полёт (N2 → ADR-33): палец по канвасу — свайп взгляда; точки над DOM-контролами
         * (стик, кнопки высоты, мини-карта) не трогаем */
        if (this._inDomControl(e)) return;
        e.preventDefault();
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this._capture(e);
        return;
      }
      e.preventDefault();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._capture(e);
      this._resetPinch();
      if (this.pointers.size === 1) this.tap = { id: e.pointerId, x0: e.clientX, y0: e.clientY, at: performance.now(), moved: 0 };
      else this.tap = this.lastTap = null;   // второй палец = pinch: счётчик тапов обнуляется
      return;
    }
    if (this.touchOnly()) return;
    const orbitButton = this.mode === 'fly' ? e.button === 2 : (e.button === 0 || e.button === 2);
    if (!orbitButton) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.drag = { id: e.pointerId, button: e.button, x: e.clientX, y: e.clientY };
    this._capture(e);
    this.canvas.style.cursor = this.mode === 'fly' ? 'crosshair' : (e.button === 2 ? 'grabbing' : 'grab');
  }

  _resetPinch() {
    if (this.pointers.size !== 2) { this.pinch = null; return; }
    const [a, b] = [...this.pointers.values()];
    this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  _pointerMove(e) {
    if (e.pointerType === 'touch' && this.look && this.look.id === e.pointerId) {
      e.preventDefault();
      this._look(e.clientX - this.look.x, e.clientY - this.look.y);
      this.look.x = e.clientX; this.look.y = e.clientY;
      return;
    }
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      e.preventDefault();
      const old = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        if (this.tap && this.tap.id === e.pointerId) {
          this.tap.moved = Math.max(this.tap.moved, Math.hypot(e.clientX - this.tap.x0, e.clientY - this.tap.y0));
        }
        this._orbit(e.clientX - old.x, e.clientY - old.y);
      } else if (this.pointers.size === 2) {
        const previous = this.pinch;
        this._resetPinch();
        if (previous) {
          this._pan(this.pinch.x - previous.x, this.pinch.y - previous.y);
          if (previous.distance > 1 && this.pinch.distance > 1) this._dolly(previous.distance / this.pinch.distance);
        }
      }
      return;
    }
    if (!this.drag || this.drag.id !== e.pointerId || !this._usable()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    if (this.mode === 'fly') this._look(dx, dy);
    else if (this.drag.button === 0) this._orbit(dx, dy);
    else this._pan(dx, dy);
  }

  _pointerUp(e) {
    if (this.look && this.look.id === e.pointerId) this.look = null;
    if (this.pointers.has(e.pointerId)) {
      this.pointers.delete(e.pointerId);
      this._resetPinch();
    }
    if (this.drag && this.drag.id === e.pointerId) {
      this.drag = null;
      this.canvas.style.cursor = '';
    }
    this._tapUp(e);
  }

  /* Контракт двойного тапа (PLAN-mobile): тап = touch-нажатие ≤300 мс со смещением ≤16 px;
   * двойной тап — два тапа ≤350 мс друг от друга и ≤40 px, без pinch между ними. В осмотре
   * второй тап делает то же, что двойной клик мыши: raycast и перенос точки орбиты за 400 мс.
   * Одиночный тап остаётся без действия. */
  _tapUp(e) {
    if (e.pointerType !== 'touch' || !this.tap || this.tap.id !== e.pointerId) return;
    const tap = this.tap;
    this.tap = null;
    if (e.type === 'pointercancel' || e.type === 'lostpointercapture') { this.lastTap = null; return; }
    const now = performance.now();
    if (tap.moved > 16 || now - tap.at > 300) { this.lastTap = null; return; }
    const prev = this.lastTap;
    this.lastTap = null;
    if (prev && now - prev.at <= 350 && Math.abs(e.clientX - prev.x) <= 40 && Math.abs(e.clientY - prev.y) <= 40) {
      if (this.mode === 'orbit') this._focusAt({ x: e.clientX, y: e.clientY });
    } else {
      this.lastTap = { x: e.clientX, y: e.clientY, at: now };
    }
  }

  _wheel(e) {
    if (!this._usable()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this._cancelFocus();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? this.canvas.clientHeight : 1));
    if (this.mode === 'fly') {
      this.speed = clamp(this.speed * Math.exp(-delta * 0.002), 0.5, 60);
      this._emitState();
    } else this._dolly(Math.exp(delta * 0.0012));
  }

  _initFlyAngles() {
    const local = this._dirToLocal(this._enu(this.camera.position), this.camera.direction);
    this.yaw = Math.atan2(local.x, local.y);
    this.pitch = Math.asin(clamp(local.z, -1, 1));
  }

  _applyFlyView() {
    const cp = Math.cos(this.pitch);
    const forward = new this.Cesium.Cartesian3(Math.sin(this.yaw) * cp, Math.cos(this.yaw) * cp, Math.sin(this.pitch));
    const right = new this.Cesium.Cartesian3(Math.cos(this.yaw), -Math.sin(this.yaw), 0);
    const up = this.norm(this.cross(right, forward));
    const enu = this._enu(this.camera.position);
    this.camera.setView({
      destination: this.camera.position,
      orientation: { direction: this._dirToWorld(enu, forward), up: this._dirToWorld(enu, up) },
    });
  }

  _look(dx, dy) {
    this.yaw += dx * this.lookSensitivity;
    this.pitch = clamp(this.pitch - dy * this.lookSensitivity, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this._applyFlyView();
    this._requestRender();
  }

  _flyMove(dt) {
    const forward = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const right = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const vertical = Number(this.keys.has('KeyE')) - Number(this.keys.has('KeyQ'));
    if (!forward && !right && !vertical) return;
    const norm = Math.hypot(forward, right, vertical);
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const step = this.speed * (fast ? 4 : 1) * dt / norm;
    const offset = this.add(this.add(this.scale(this.camera.direction, forward * step),
      this.scale(this.camera.right, right * step)), this.scale(this._upAt(this.camera.position), vertical * step));
    this.camera.position = this._clampPosition(this.add(this.camera.position, offset));
    this._applyFlyView();
    this._requestRender();
  }

  _keyDown(e) {
    if (!this._usable() || this._editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = this._code(e);
    if (code === 'KeyR') {
      e.preventDefault();
      this.reset();
      this.onMessage('исходный ракурс');
      return;
    }
    if (e.key === 'Escape' && this.mode === 'fly') {
      e.preventDefault();
      this.setMode('orbit');
      return;
    }
    if (this.mode === 'fly') {
      if (FLY_KEYS.has(code)) {
        e.preventDefault();
        this._cancelFocus();
        this.keys.add(code);
      } else if (ARROWS.has(e.key)) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -18 : e.key === 'ArrowRight' ? 18 : 0;
        const dy = e.key === 'ArrowUp' ? -18 : e.key === 'ArrowDown' ? 18 : 0;
        this._look(dx, dy);
      }
      return;
    }
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      this._cancelFocus();
      if (e.shiftKey) this._pan(e.key === 'ArrowLeft' ? -40 : e.key === 'ArrowRight' ? 40 : 0,
        e.key === 'ArrowUp' ? -40 : e.key === 'ArrowDown' ? 40 : 0);
      else this._orbit(e.key === 'ArrowLeft' ? -18 : e.key === 'ArrowRight' ? 18 : 0,
        e.key === 'ArrowUp' ? -18 : e.key === 'ArrowDown' ? 18 : 0);
    } else if (['+', '=', '-', '_'].includes(e.key)) {
      e.preventDefault();
      this._cancelFocus();
      this._dolly(e.key === '+' || e.key === '=' ? 1 / 1.15 : 1.15);
    }
  }

  _keyUp(e) {
    const code = this._code(e);
    if (FLY_KEYS.has(code)) {
      this.keys.delete(code);
      if (this._usable() && this.mode === 'fly' && !this._editable(e.target)) e.preventDefault();
    }
  }

  _emitState() { this.onState({ mode: this.mode, speed: this.speed, touch: this.touchOnly() }); }

  setMode(mode) {
    if (mode !== 'orbit' && mode !== 'fly') return;
    if (this.mode === mode) return;
    this._cancelFocus();
    this._clearInput();
    this.stick = { x: 0, y: 0 };        // джойстик и кнопки высоты не переезжают в другой режим
    this.vert = 0;
    if (mode === 'fly') {
      this._initFlyAngles();
      this.mode = 'fly';
    } else {
      const oldDistance = clamp(this.distance(this.camera.position, this.target), this.minDistance, this.maxDistance);
      const center = new this.Cesium.Cartesian2(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
      const hit = this._pickWorld(center);
      this.target = hit || this.add(this.camera.position, this.scale(this.camera.direction, oldDistance));
      this.mode = 'orbit';
    }
    this._emitState();
    this._requestRender();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._clearInput();
    if (!on) this._cancelFocus();
    this._emitState();                    // интерфейс узнаёт, что ввод сейчас глушится (2D)
  }

  setLocked(on) {
    this.locked = !!on;
    this._clearInput();
    if (on) this._cancelFocus();
  }

  reset() {
    this._cancelFocus();
    this._clearInput();
    this.camera.setView({ destination: this.home.position,
      orientation: { direction: this.home.direction, up: this.home.up } });
    this.target = this.v3(this.home.target);
    if (this.mode === 'fly') this._initFlyAngles();
    this._requestRender();
  }

  panByGround(dLon, dLat) {
    const c = this.Cesium.Cartographic.fromCartesian(this.camera.position);
    const offset = this._dirToWorld(this._enu(this.camera.position), new this.Cesium.Cartesian3(
      dLon * 111320 * Math.cos(c.latitude), dLat * 110574, 0));
    this._translate(offset);
  }

  /* ——— тач-полёт: значения приходят из DOM-джойстика и кнопок высоты (app.js) ——— */
  setStick(dx, dy) { this.stick = { x: clamp(dx, -1, 1), y: clamp(dy, -1, 1) }; }
  setVertical(v) { this.vert = clamp(v, -1, 1); }
  setRun(on) { this.run = !!on; }

  /* движение джойстика: вперёд по направлению взгляда, вправо по экранному «правому»,
   * вертикаль — по локальной нормали эллипсоида; «бег» умножает скорость на 4 */
  _stickMove(dt) {
    const x = this.stick.x, y = this.stick.y, v = this.vert;
    if (!x && !y && !v) return;
    const step = this.speed * (this.run ? 4 : 1) * dt;
    const offset = this.add(this.add(this.scale(this.camera.direction, y * step),
      this.scale(this.camera.right, x * step)), this.scale(this._upAt(this.camera.position), v * step));
    this._translate(offset);
  }

  captureFor2D() {
    /* режим сохраняется вместе с позой камеры: заглядывание в 2D не должно превращать полёт
     * в осмотр по возврате (находка аудита B1) */
    this.saved2d = { position: this.v3(this.camera.position), direction: this.v3(this.camera.direction),
      up: this.v3(this.camera.up), target: this.v3(this.target), mode: this.mode };
    this.setEnabled(false);
  }

  restoreFrom2D() {
    if (this.saved2d) {
      this.camera.setView({ destination: this.saved2d.position,
        orientation: { direction: this.saved2d.direction, up: this.saved2d.up } });
      this.target = this.v3(this.saved2d.target);
      if (this.saved2d.mode === 'fly') { this.mode = 'fly'; this._initFlyAngles(); }
      else this.mode = 'orbit';
    } else {
      this.mode = 'orbit';
    }
    this.setEnabled(true);
    this._emitState();
    this._requestRender();
  }

  tick(now) {
    const dt = clamp((now - this._last) / 1000, 0, 0.05);
    this._last = now;
    if (!this._usable()) return;
    if (this.focus) {
      const f = this.focus;
      const t = f.duration ? clamp((now - f.start) / f.duration, 0, 1) : 1;
      const k = 1 - Math.pow(1 - t, 3);
      this.camera.setView({
        destination: this.add(f.fromPosition, this.scale(this.sub(f.endPosition, f.fromPosition), k)),
        orientation: { direction: f.direction, up: f.up },
      });
      this.target = this.add(f.fromTarget, this.scale(this.sub(f.endTarget, f.fromTarget), k));
      this._requestRender();
      if (t === 1) this.focus = null;
      return;
    }
    if (this.mode === 'fly') {
      this._flyMove(dt);
      this._stickMove(dt);                     // виртуальный джойстик и кнопки высоты (N2)
    }
  }
}

root.CameraController = CameraController;
})(window);
