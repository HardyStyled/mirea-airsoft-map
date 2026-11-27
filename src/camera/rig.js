/* что здесь живёт: ядро камеры — поза, инварианты орбита/полёт и единственный запись в camera. */
/* CameraRig — единственный писатель камеры (WP-CAM-1, ADR-34). Cesium инжектится через
 * options.Cesium; DOM-слушателей нет — ввод приходит намерениями из input.js/touch.js. */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const D2R = Math.PI / 180;   // углы наружу от rig — в градусах, как панель дебага и HOME_POSE
const DIR_EPS_RAD = 0.05 * Math.PI / 180; // порог «чужой записи» по направлению (спека §2)

/* нормализация в (−π, π]: yaw хранится именно так, чтобы сравнения и wrapPi(π)=π были стабильны */
function wrapPi(a) {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  else if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

export class CameraRig {
  constructor(options) {
    this.Cesium = options.Cesium;
    this.viewer = options.viewer;
    this.camera = options.viewer.camera;
    this.scene = options.viewer.scene;
    this.extent = options.extent;
    this.isActive = options.isActive || (() => true);
    this.onState = options.onState || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.reducedMotion = options.reducedMotion || (() => false);
    this.touchOnly = options.touchOnly || (() => false);

    this.mode = 'orbit';
    this.minDistance = 0.5;
    this.maxDistance = options.maxDistance || 320;
    this.maxHeight = 400;
    this.speed = 6;
    this.lookSensitivity = 0.0021;   // как в camera.js:1:1
    this.orbitSensitivity = 0.006;

    this.stick = { x: 0, y: 0 };
    this.vert = 0;
    this.run = false;
    // move* — скорость м/с в системе ВЗГЛЯДА (f вдоль направления камеры, r вправо, u вверх):
    // клавиши и джойстик должны вести туда, куда смотрит камера, а не на север.
    // pan* — разовое смещение в метрах ENU (план, стрелки): там мировые оси и нужны.
    this.intent = { dYaw: 0, dPitch: 0, dolly: 0, panE: 0, panN: 0, panU: 0, mvF: 0, mvR: 0, mvU: 0 };

    this.enabled = true;
    this.locked = false;
    this.focus = null;
    this.saved2d = null;
    this._last = null;   // null до первого tick: dt=0, чтобы первый кадр не «прыгал»
    this._raf = null;
    this._dirty = false;

    this._initBounds();
    const ctl = this.scene.screenSpaceCameraController;
    if (ctl) ctl.enableInputs = false;   // Cesium-вводы выключены (спека §2.5)

    const target = options.target || this.Cesium.Cartesian3.fromDegrees(
      (this.extent.w + this.extent.e) / 2, (this.extent.s + this.extent.n) / 2, 0);
    const d0 = options.initialOrbitDistance ?? this._dist(this.camera.position, target);
    this.distance = clamp(d0, this.minDistance, this.maxDistance);
    this.focusDist = clamp(d0, 3, 220);
    // стартовая поза берётся из живой камеры: app уже выставил HOME_POSE до создания rig
    this.syncFromCamera();
    // home хранит углы в градусах — в тех же единицах, что и HOME_POSE и панель дебага
    this.home = { position: this.v3(this.pos), heading: this.yaw / D2R, pitch: this.pitch / D2R };
  }

  // ——— мелкие векторные/ENU хелперы (как в camera.js) ———
  v3(v) { return this.Cesium.Cartesian3.clone(v); }
  add(a, b) { return this.Cesium.Cartesian3.add(a, b, new this.Cesium.Cartesian3()); }
  sub(a, b) { return this.Cesium.Cartesian3.subtract(a, b, new this.Cesium.Cartesian3()); }
  scale(v, k) { return this.Cesium.Cartesian3.multiplyByScalar(v, k, new this.Cesium.Cartesian3()); }
  norm(v) { return this.Cesium.Cartesian3.normalize(v, new this.Cesium.Cartesian3()); }
  _dist(a, b) { return this.Cesium.Cartesian3.distance(a, b); }
  dot(a, b) { return this.Cesium.Cartesian3.dot(a, b); }
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

  /* локальный forward из yaw/pitch: yaw от севера по часовой, как в camera.js _applyFlyView */
  _forwardLocal() {
    const cp = Math.cos(this.pitch);
    return new this.Cesium.Cartesian3(Math.sin(this.yaw) * cp, Math.cos(this.yaw) * cp, Math.sin(this.pitch));
  }
  _rightLocal() {
    return new this.Cesium.Cartesian3(Math.cos(this.yaw), -Math.sin(this.yaw), 0);
  }
  /* up строим из локального Z ортогонализацией против forward: roll жёстко 0 (требование 5) */
  _upLocal(forward) {
    const base = Math.abs(this.dot(forward, this.Cesium.Cartesian3.UNIT_Z)) > 0.999
      ? this.Cesium.Cartesian3.UNIT_Y : this.Cesium.Cartesian3.UNIT_Z;
    return this.norm(this.sub(base, this.scale(forward, this.dot(forward, base))));
  }
  _anglesFromDir(dir, origin) {
    const local = this.norm(this._dirToLocal(this._enu(origin), dir));
    return { yaw: wrapPi(Math.atan2(local.x, local.y)), pitch: clamp(Math.asin(clamp(local.z, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT) };
  }

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

  /* нижней границы высоты нет — решение владельца PLAN-mobile N1, камеру не «приземлять».
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

  _usable() { return this.enabled && !this.locked && this.isActive(); }

  // ——— состояние и поза ———
  getMode() { return this.mode; }
  isFlying() { return this.mode === 'fly'; }

  /* инвариант режимов: орбита — pos = target − f·distance, полёт — target = pos + f·focusDist.
   * Одна формула на оба режима даёт обратимый переход без потерь (тест 3). */
  _deriveTarget() {
    const d = this.mode === 'orbit' ? this.distance : this.focusDist;
    const enu = this._enu(this.pos);
    this.target = this.add(this.pos, this.scale(this._dirToWorld(enu, this._forwardLocal()), d));
  }

  /* Углы наружу — в ГРАДУСАХ (ADR-37): HOME_POSE, панель дебага и «Домой» оперируют градусами,
   * внутреннее состояние rig — радианы. Конвертация в одном месте: без неё pitch −2° читается как
   * −2 радиана, клампится в −89.4° и стартовый вид на проде смотрит в пол (регресс 27.11). */
  setPose({ lon, lat, h, heading, pitch }) {
    this.pos = this.Cesium.Cartesian3.fromDegrees(lon, lat, h);
    if (heading !== undefined) this.yaw = wrapPi(heading * D2R);
    if (pitch !== undefined) this.pitch = clamp(pitch * D2R, -PITCH_LIMIT, PITCH_LIMIT);
    this._deriveTarget();
    this._dirty = true;
    this.apply();
  }

  /* homePose() без аргумента — зафиксировать текущую позу как «Домой»; углы тоже в градусах,
   * иначе reset() вернёт радианы как градусы и вид уедет в землю */
  homePose(pose) {
    if (!pose) { this.home = { position: this.v3(this.pos), heading: this.yaw / D2R, pitch: this.pitch / D2R }; return; }
    this.home = { ...pose };
  }

  reset() {
    this.cancelFocus();
    this._clearChannels();
    const home = this.home;
    if (home.lon !== undefined) {
      this.pos = this.Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.h);
    } else {
      this.pos = this.v3(home.position);
    }
    this.yaw = wrapPi((home.heading ?? 0) * D2R);
    this.pitch = clamp((home.pitch ?? 0) * D2R, -PITCH_LIMIT, PITCH_LIMIT);
    this._deriveTarget();
    this._dirty = true;
    this.apply();
    this.scene.requestRender();
  }

  /* перечитать позу из живой камеры; camera.up игнорируется — roll принудительно 0 (спека §2) */
  syncFromCamera() {
    this.pos = this.v3(this.camera.position);
    const a = this._anglesFromDir(this.camera.direction, this.pos);
    this.yaw = a.yaw;
    this.pitch = a.pitch;
    this._deriveTarget();
    this._appliedPos = this.v3(this.pos);
    this._appliedDir = this._dirToWorld(this._enu(this.pos), this._forwardLocal());
    this._dirty = false;
  }

  _intentPending() {
    const i = this.intent;
    return !!(i.dYaw || i.dPitch || i.dolly || i.panE || i.panN || i.panU ||
      i.mvF || i.mvR || i.mvU || (this.mode === 'fly' && (this.stick.x || this.stick.y || this.vert)));
  }

  /* Пан и зум прерывают перенос. Поворот можно применять к движущемуся центру. */
  _movementPending() {
    const i = this.intent;
    return !!(i.dolly || i.panE || i.panN || i.panU ||
      i.mvF || i.mvR || i.mvU || this.stick.x || this.stick.y || this.vert);
  }

  /* если живая поза разошлась с последней нашей записью, а своих намерений нет — писал чужой:
   * принимаем её (syncFromCamera), а не перезаписываем. Иначе выигрывает rig (тест 2). */
  _guard() {
    const cp = this.camera.position;
    if (!this.finite(cp) || !this.finite(this.camera.direction)) return;
    const posDiff = this._dist(cp, this._appliedPos) > 1e-6;
    const cos = clamp(this.dot(this.norm(this.camera.direction), this._appliedDir), -1, 1);
    const dirDiff = Math.acos(cos) > DIR_EPS_RAD;
    if (!posDiff && !dirDiff) return;
    if (this._intentPending() || this.focus) return;
    this.syncFromCamera();
  }

  // ——— каналы скорости (стик/высота/бег/скорость) ———
  setStick(x, y) { this.stick = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }; }
  setVert(v) { this.vert = clamp(v, -1, 1); }
  setRun(on) {
    if (this.run === !!on) return;
    this.run = !!on;
    this._emitState();
  }
  setSpeed(v) { this.speed = clamp(v, 0.5, 60); this._emitState(); }

  // ——— намерения (единственный способ для ввода влиять на позу) ———
  lookBy(dx, dy) {
    this.intent.dYaw += dx * this.lookSensitivity;
    this.intent.dPitch -= dy * this.lookSensitivity;
  }
  orbitBy(dx, dy) {
    // знак как в camera.js _orbit: convention «сцена едет за курсором» (решение владельца 25.11)
    this.intent.dYaw += dx * this.orbitSensitivity;
    this.intent.dPitch -= dy * this.orbitSensitivity;
  }
  zoomBy(factor) { if (factor > 0) this.intent.dolly += Math.log(factor); }
  /* приращения гео-координат плана — в ГРАДУСАХ (их даёт план), перевод в метры здесь */
  panByGround(dLonDeg, dLatDeg) {
    const c = this.Cesium.Cartographic.fromCartesian(this.pos);
    this.intent.panE += dLonDeg * 111320 * Math.cos(c.latitude);
    this.intent.panN += dLatDeg * 110574;
  }
  translateBy(e, n, u) { this.intent.panE += e; this.intent.panN += n; this.intent.panU += u; }
  panByPixels(dx, dy) {
    const cam = this.camera, height = Math.max(1, this.viewer.canvas.clientHeight);
    const fovy = cam.frustum?.fovy || cam.frustum?.fov || Math.PI / 3;
    const mpp = 2 * this.distance * Math.tan(fovy / 2) / height;
    const shift = this.add(this.scale(cam.rightWC || cam.right, -dx * mpp), this.scale(cam.upWC || cam.up, dy * mpp));
    const local = this._dirToLocal(this._enu(this.target), shift);
    this.translateBy(local.x, local.y, local.z);
  }
  /* скорость м/с в системе ВЗГЛЯДА: f вперёд по направлению камеры, r вправо, u вверх.
   * Единая система с джойстиком (_applyChannels): W и стик обязаны вести одинаково (регресс 27.11 —
   * клавиши ехали по мировым осям ENU, то есть W всегда на север). */
  moveBy(f, r, u) { this.intent.mvF += f; this.intent.mvR += r; this.intent.mvU += u; }

  _clearChannels() {
    this.stick = { x: 0, y: 0 };
    this.vert = 0;
    this.setRun(false);
    for (const k of Object.keys(this.intent)) this.intent[k] = 0;
  }

  // ——— режимы: пересчёт обратим, pos при переходе не телепортируется ———
  setMode(mode) {
    if (mode !== 'orbit' && mode !== 'fly') return;
    if (this.mode === mode) return;
    this.cancelFocus();
    this._clearChannels();   // джойстик и кнопки высоты не переезжают в другой режим
    if (mode === 'fly') {
      const a = this._anglesFromDir(this.sub(this.target, this.pos), this.pos);
      this.yaw = a.yaw;
      this.pitch = a.pitch;
      this.focusDist = clamp(this._dist(this.pos, this.target), 3, 220);
      this.mode = 'fly';
    } else {
      const enu = this._enu(this.pos);
      this.target = this.add(this.pos, this.scale(this._dirToWorld(enu, this._forwardLocal()), this.focusDist));
      this.distance = clamp(this.focusDist, this.minDistance, this.maxDistance);
      this.mode = 'orbit';
    }
    this._dirty = true;
    this._emitState();
  }

  /* Минимальная правка WP-CAM-2: перенос точки орбиты без движения камеры — нужен для
   * raycast при выходе из полёта (поведение camera.js сохранено регрессией). Инвариант
   * орбиты pos = target − f·distance не даёт одновременно сохранить target=hit, pos и
   * направление, поэтому yaw/pitch пересчитываются на hit: позиция не двигается вообще. */
  setOrbitTarget(position) {
    if (!this.finite(position) || this.mode !== 'orbit') return false;
    const d = this._dist(this.pos, position);
    if (d < 1e-6) return false;
    const a = this._anglesFromDir(this.sub(position, this.pos), position);
    this.target = this.v3(position);
    this.yaw = a.yaw; this.pitch = a.pitch;
    this.distance = clamp(d, this.minDistance, this.maxDistance);
    this._dirty = true;
    this.apply();
    return true;
  }

  // ——— tween «Домой» / двойной тап: своя анимация, никакого camera.flyTo ———
  focusTo(targetPos, ms = 400) {
    if (!this.finite(targetPos)) return false;
    const radius = this.isFlying() ? this.focusDist : this.distance;
    const toPos = this._toWorld(this._enu(targetPos), this.scale(this._forwardLocal(), -radius));
    if (!this._inside(toPos)) {
      this.onMessage('точка слишком далеко: исходная дистанция выводит камеру за границы участка');
      return false;
    }
    if (this.isFlying()) this.setMode('orbit');
    this._clearChannels();
    this.focus = {
      start: this._last, duration: this.reducedMotion() ? 0 : ms,
      fromTarget: this.v3(this.target), toTarget: this.v3(targetPos),
    };
    return true;
  }
  cancelFocus() { this.focus = null; }

  // ——— 2D: снимок состояния → возврат; Cesium сам переставляет камеру при смене SceneMode ———
  captureFor2D() {
    this.saved2d = {
      pos: this.v3(this.pos), target: this.v3(this.target), mode: this.mode,
      distance: this.distance, focusDist: this.focusDist, yaw: this.yaw, pitch: this.pitch,
    };
    this.setEnabled(false);
  }

  restoreFrom2D() {
    if (this.saved2d) {
      const s = this.saved2d;
      this.pos = this.v3(s.pos); this.target = this.v3(s.target); this.mode = s.mode;
      this.distance = s.distance; this.focusDist = s.focusDist; this.yaw = s.yaw; this.pitch = s.pitch;
      this.setEnabled(true);
      this._dirty = true;
      this.apply();
    } else {
      this.mode = 'orbit';
      this.setEnabled(true);
      this.syncFromCamera();
    }
    this._emitState();
    this.scene.requestRender();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._clearChannels();
    if (!on) this.cancelFocus();
    this._emitState();
  }

  setLocked(on) {
    this.locked = !!on;
    this._clearChannels();
    if (on) this.cancelFocus();
  }

  // ——— цикл: rAF только у rig; в тестах tick вызывается вручную и идемпотентен ———
  start() {
    if (this._raf != null) return;
    const frame = now => { this._raf = requestAnimationFrame(frame); this.tick(now); };
    this._raf = requestAnimationFrame(frame);
  }
  stop() {
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  tick(now) {
    const dt = this._last == null ? 0 : clamp((now - this._last) / 1000, 0, 0.05);
    this._last = now;
    if (!this._usable()) return;
    this._guard();
    // новое намерение/движение отменяет tween (как сейчас в camera.js)
    if (this.focus && this._movementPending()) this.focus = null;
    if (this.focus) {
      const f = this.focus;
      if (f.start == null) f.start = now;
      const t = f.duration ? clamp((now - f.start) / f.duration, 0, 1) : 1;
      const k = 1 - Math.pow(1 - t, 3);
      this.target = this.add(f.fromTarget, this.scale(this.sub(f.toTarget, f.fromTarget), k));
      this._dirty = true;
      if (t === 1) this.focus = null;
    }
    if (this.mode === 'fly') {
      const speed = this.speed * (this.run ? 4 : 1);
      this.moveBy(this.stick.y * speed, this.stick.x * speed, this.vert * speed);
    }
    this._applyIntent(dt);
    if (this._dirty) { this.apply(); this.scene.requestRender(); }
    this._emitState();
  }

  /* На границе сокращаем весь шаг до первого пересечения. Поосевое ограничение
   * превращало W в боковое движение, пока камера смотрела за край области. */
  _flyEndpoint(offset) {
    const end = this.add(this.pos, offset);
    if (this._inside(end)) return end;
    const from = this._toLocal(this.siteEnu, this.pos);
    const to = this._toLocal(this.siteEnu, end);
    const fraction = (a, b, min, max) => {
      if (b < min && b < a) return (min - a) / (b - a);
      if (b > max && b > a) return (max - a) / (b - a);
      return 1;
    };
    const t = Math.max(0, Math.min(
      fraction(from.x, to.x, this.bounds.minX, this.bounds.maxX),
      fraction(from.y, to.y, this.bounds.minY, this.bounds.maxY),
      fraction(from.z, to.z, -Infinity, this.maxHeight)));
    return this.add(this.pos, this.scale(offset, t));
  }

  _applyIntent(dt) {
    const i = this.intent;
    if (i.dYaw) { this.yaw = wrapPi(this.yaw + i.dYaw); this._dirty = true; }
    if (i.dPitch) { this.pitch = clamp(this.pitch + i.dPitch, -PITCH_LIMIT, PITCH_LIMIT); this._dirty = true; }
    if (i.dolly) {
      const k = Math.exp(i.dolly);
      if (this.mode === 'orbit') this.distance = clamp(this.distance * k, this.minDistance, this.maxDistance);
      else this.focusDist = clamp(this.focusDist * k, 3, 220);
      this._dirty = true;
    }
    if (i.panE || i.panN || i.panU) {
      const enu = this._enu(this.mode === 'orbit' ? this.target : this.pos);
      const offset = this._dirToWorld(enu, new this.Cesium.Cartesian3(i.panE, i.panN, i.panU));
      if (this.mode === 'orbit') this.target = this.add(this.target, offset);
      else this.pos = this._clampPosition(this.add(this.pos, offset));
      this._dirty = true;
    }
    // move* — скорость в системе взгляда, перемножается на dt; та же математика, что у джойстика
    if (i.mvF || i.mvR || i.mvU) {
      const enu = this._enu(this.pos);
      const offset = this.add(
        this.scale(this._dirToWorld(enu, this._forwardLocal()), i.mvF * dt),
        this.scale(this._dirToWorld(enu, this._rightLocal()), i.mvR * dt));
      this.pos = this._flyEndpoint(offset);
      if (i.mvU) {
        const lift = this.scale(this._upAt(this.pos), i.mvU * dt);
        this.pos = this._clampPosition(this.add(this.pos, lift));
      }
      this._dirty = true;
    }
    for (const key of Object.keys(i)) i[key] = 0;
  }

  /* единственный setView за кадр. Поза выводится из состояния — прямых записей в camera нет. */
  apply() {
    const f = this._forwardLocal();
    if (this.mode === 'orbit') {
      const enuT = this._enu(this.target);
      const want = this._toWorld(enuT, this.scale(f, -this.distance));
      const pos = this._clampPosition(want);
      const corr = this.sub(pos, want);
      if (corr.x || corr.y || corr.z) this.target = this.add(this.target, corr); // инвариант важнее неподвижности target
      this.pos = pos;
    } else {
      this.pos = this._clampPosition(this.pos);
      const enuP = this._enu(this.pos);
      this.target = this.add(this.pos, this.scale(this._dirToWorld(enuP, f), this.focusDist));
    }
    const enu = this._enu(this.pos);
    const direction = this.mode === 'orbit' ? this.norm(this.sub(this.target, this.pos)) : this._dirToWorld(enu, f);
    const up = this._dirToWorld(enu, this._upLocal(f));
    this.camera.setView({ destination: this.pos, orientation: { direction, up } });
    this._appliedPos = this.v3(this.pos);
    this._appliedDir = direction;
    this._dirty = false;
  }

  _emitState() { this.onState({ mode: this.mode, speed: this.speed, run: this.run, touch: this.touchOnly() }); }

  dispose() {
    this.stop();
    this._clearChannels();
    this.cancelFocus();
  }
}
