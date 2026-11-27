/* что здесь живёт: PlanPane — 2D-план сплита и радар (тайлы, вектор, маркер камеры, луч взгляда).
 * Плановая (2D)-панель: сплит-план и радар — один canvas 2D на оба (ADR-1/3/15).
 * Второй Cesium.Viewer на этой машине падает (нет второго аппаратного контекста),
 * поэтому тайлы того же XYZ-каталога рисуем сами; объекты приходят из gpkg
 * (app.js нормализует их в {id, layer, kind, geom:{parts}}), а не из GeoJSON. */
import { FOV_DEFAULT } from './config.js?v=15';
import { D2R, R2D, lonLatToWorldPx, resolution, worldPxToLonLat, hexA, ptsOf, distSeg } from './geo2d.js?v=15';

const ACCENT = '#ffb020';                 // --acc из палитры Combat HUD
const BG = '#04060a';                     // --bg
const PLAN_ZMIN = 15, PLAN_ZMAX = 23;
const MIN_MPP = 0.01;

// проекция и меряние расстояний — в geo2d.js: те же формулы нужны радару и node-тестам

export class PlanPane {
  constructor(canvas, features, opts) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.features = features || [];
    this.style = {};                      // {имяСлоя: '#hex'} — цвет линии/точки
    this.center = this.opts.center || [37.480859, 55.672973];
    this.mpp = this.#clampMpp(this.opts.mpp || 0.1);   // метров на CSS-пиксел (независим от 3D)
    this.z = 21;
    this.tiles = new Map();               // 'z/x/y' -> Image
    this.selected = null;
    this.busy = false;                    // защита от петли в синхронизации
    this.heading = 0;                     // поворот мира на канвасе (рад)
    this.rotOn = !!this.opts.rotOn;       // режим «по курсу камеры»
    this.follow = this.opts.follow !== false;
    this.radar = !!this.opts.radar;       // маленький радар: камера в центре всегда
    this.cam = null;                      // {lon,lat,heading,quad:[4×[lon,lat]]} из app.js
    this.dpr = 1;
    this._fit = null;                     // pending-fit: вписать rect, когда панель станет видимой
    this.#bindEvents();
  }

  /* предел отдаления: ширина кадра не больше opts.maxViewM метров (в app.js — полигон
   * целиком в кадре, у радара свой лимит). Без лимита план уезжал на километры. */
  #maxMpp() { const w = this.c.clientWidth || 0; return this.opts.maxViewM && w ? this.opts.maxViewM / w : 4; }
  #clampMpp(v) { return Math.min(this.#maxMpp(), Math.max(MIN_MPP, v)); }

  #panBy(dx, dy) {
    if (this.radar) return;
    const th = this.heading;
    const vE = dx * Math.cos(th) + dy * Math.sin(th);
    const vS = -dx * Math.sin(th) + dy * Math.cos(th);
    const dLon = vE * this.mpp / (111320 * Math.cos(this.center[1] * D2R));
    const dLat = -vS * this.mpp / 110574;
    this.center = [this.center[0] - dLon, this.center[1] - dLat];
    this.#push('pan', dLon, dLat);
  }
  #onKey(e) {
    const moves = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (moves[e.key]) {
      e.preventDefault();
      e.stopPropagation();                // план и 3D-камера не дёргаются с одной клавиши (аудит A7)
      this.#panBy(...moves[e.key]);
      return;
    }
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' || e.key === '-' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      e.stopPropagation();
      const zoomIn = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
      this.mpp = this.#clampMpp(this.mpp * (zoomIn ? 1 / 1.2 : 1.2));
      this.#push('zoom');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const r = this.c.getBoundingClientRect();
      this.pick({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      return;
    }
    if (e.key === 'Home' && this.homeRect) {
      e.preventDefault();
      e.stopPropagation();
      this.fit(this.homeRect);
    }
  }
  #bindEvents() {
    let drag = null, pinch = null;
    const pointers = new Map();
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const endPointer = e => {
      const wasPinch = !!pinch;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const p = [...pointers.values()][0];
        drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, moved: wasPinch || (drag && drag.moved) };
      } else if (pointers.size === 0) {
        if (drag && !drag.moved && !wasPinch && e.type !== 'pointercancel') {
          this.pick(e);
          // тот же тап сообщает гео-точку: по ней app.js переносит точку орбиты или камеру (N4)
          if (this.opts.onTapGround) {
            const geo = this.#screenToGeo(e.clientX, e.clientY);
            if (geo) this.opts.onTapGround(geo);
          }
        }
        drag = null; pinch = null;
      }
      e.preventDefault();
    };
    this.c.addEventListener('keydown', e => this.#onKey(e));
    this.c.addEventListener('pointerdown', e => {
      this.c.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // capture может отказать (указатель уже перехвачен/скрыт канвас) — жест не должен падать (аудит A6)
      try { this.c.setPointerCapture(e.pointerId); } catch (err) {}
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
      } else if (pointers.size === 2) {
        pinch = { distance: distance(), mpp: this.mpp };
        if (drag) drag.moved = true;       // второй палец переводит drag в pinch, клика не будет
      }
      e.preventDefault();
    });
    this.c.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const d = distance();
        if (d > 0) {
          this.mpp = this.#clampMpp(pinch.mpp * pinch.distance / d);
          if (drag) drag.moved = true;
          this.#push('zoom');
        }
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 3) drag.moved = true;
        this.#panBy(dx, dy);
      }
      e.preventDefault();
    });
    this.c.addEventListener('pointerup', endPointer);
    this.c.addEventListener('pointercancel', endPointer);
    /* смена вида скрывает канвас — браузер сам снимает capture; без слушателя запись о пальце
     * остаётся, и следующий жест ведёт себя как начало pinch (аудит A5) */
    this.c.addEventListener('lostpointercapture', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) { drag = null; pinch = null; }
      else if (pointers.size === 1) {
        const p = [...pointers.values()][0];
        drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, moved: true };
      }
    });
    this.c.addEventListener('wheel', e => {
      e.preventDefault();
      this.mpp = this.#clampMpp(this.mpp * Math.pow(1.0015, e.deltaY));
      this.#push('zoom');
    }, { passive: false });
  }

  #push(kind, dLon, dLat) {
    this.draw();
    if (!this.busy && this.opts.onView) this.opts.onView(kind, dLon, dLat);
  }

  setView(lon, lat, mpp) {                // первичная посадка плана под камеру
    this.busy = true;
    this.center = [lon, lat];
    this.mpp = this.#clampMpp(mpp);
    this.draw();
    this.busy = false;
  }

  setViewCenter(lon, lat) {               // из 3D-камеры; масштаб не трогаем
    this.center = [lon, lat];
    this.draw();
  }

  setCamera(cam) {                        // {lon,lat,heading,quad} каждый postRender
    this.cam = cam;
    if (this.rotOn) this.heading = -cam.heading;
  }

  setRotateByHeading(on) {
    this.rotOn = on;
    this.heading = on && this.cam ? -this.cam.heading : 0;
    this.draw();
  }

  setFeatures(list, styleByLayer) {       // объекты gpkg + цвета слоёв
    this.features = list || [];
    this.style = styleByLayer || {};
    this.draw();
  }

  setSelected(id) { this.selected = id; this.draw(); }

  clearTiles() { this.tiles.clear(); this.draw(); }

  fit(rect) {                             // rect — Cesium.Rectangle в радианах: вписать кампус
    this.homeRect = rect;
    this._fit = rect;
    this.#applyFit();
  }

  #applyFit() {
    if (!this._fit) return;
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return;    // панель скрыта — дождёмся resize()
    const rect = this._fit; this._fit = null;
    const w = rect.west * R2D, e = rect.east * R2D, s = rect.south * R2D, n = rect.north * R2D;
    const latC = (s + n) / 2;
    const dE = (e - w) * 111320 * Math.cos(latC * D2R);
    const dN = (n - s) * 110574;
    this.center = [(w + e) / 2, latC];
    this.mpp = this.#clampMpp(Math.max(dE / r.width, dN / r.height));
    this.draw();
  }

  #syncSize() {                           // буфер канваса обязан соответствовать CSS-боксу
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return null;    // план/радар скрыты (0×0) — не трогаем канвас
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.c.width !== w || this.c.height !== h || this.dpr !== dpr) {
      this.c.width = w; this.c.height = h; this.dpr = dpr;
    }
    return r;
  }

  resize() {
    if (!this.#syncSize()) return;
    this.mpp = this.#clampMpp(this.mpp);   // maxViewM пересчитывается при split/full resize
    this.#applyFit();                     // применит pending-fit, когда панель стала видимой
    this.draw();
  }

  project(lon, lat) {                     // lon/lat -> локальные пикселы (центр в 0,0, до поворота)
    const [cx, cy] = lonLatToWorldPx(this.center[0], this.center[1], this.z);
    const [x, y] = lonLatToWorldPx(lon, lat, this.z);
    const k = resolution(this.z, this.center[1]) / this.mpp;
    return [(x - cx) * k, (y - cy) * k];
  }

  #screenToLocal(px, py, r) {             // экранные координаты канваса -> локальные
    const x = px - r.width / 2, y = py - r.height / 2;
    const th = this.heading;
    return [x * Math.cos(th) + y * Math.sin(th), -x * Math.sin(th) + y * Math.cos(th)];
  }

  #getTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Image();
      // обработчики вешаем до src: 404 из кеша может выстрелить раньше, чем мы подпишемся
      t.onload = () => this.draw();
      t.onerror = () => { t.missing = true; };
      this.tiles.set(key, t);
      t.src = (window.TILES_BASE || './tiles/') + `${z}/${x}/${y}.png`;
    }
    return t;
  }

  #tiles(ctx, r) {                        // растр того же XYZ-каталога (уровни 15–23)
    // верхний уровень сообщает app.js: у «Схемы» z23 может ещё не быть, и план обязан
    // остаться на z22, а не ловить 404 и дырки в подложке
    const zmax = window.TILES_ZMAX || PLAN_ZMAX;
    const wantZ = Math.max(PLAN_ZMIN, Math.min(zmax,
      Math.round(Math.log2(156543.0339 * Math.cos(this.center[1] * D2R) / this.mpp))));
    this.z = wantZ;
    const k = resolution(wantZ, this.center[1]) / this.mpp;
    const [cx, cy] = lonLatToWorldPx(this.center[0], this.center[1], wantZ);
    const spanX = r.width / k / 256, spanY = r.height / k / 256;
    const tx0 = Math.floor((cx - spanX * 128) / 256), tx1 = Math.ceil((cx + spanX * 128) / 256);
    const ty0 = Math.floor((cy - spanY * 128) / 256), ty1 = Math.ceil((cy + spanY * 128) / 256);
    const n = Math.pow(2, wantZ);
    for (let x = tx0; x <= tx1; x++) {
      for (let y = ty0; y <= ty1; y++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const t = this.#getTile(wantZ, x, y);
        if (t.missing || !t.complete || !t.naturalWidth) continue;
        try {
          ctx.drawImage(t, (x * 256 - cx) * k, (y * 256 - cy) * k, 256 * k, 256 * k);
        } catch (e) {
          // Chrome под нехваткой памяти сбрасывает декодированные картинки: перезагружаем
          t.missing = true;
          this.tiles.delete(wantZ + '/' + x + '/' + y);
        }
      }
    }
  }

  #features(ctx) {                        // вектор из gpkg-объектов
    for (const f of this.features) {
      const g = f.geom; if (!g || !g.parts) continue;
      const col = this.style[f.layer] || '#99aabc';
      const sel = f.id === this.selected;
      const stroke = sel ? ACCENT : col;
      if (f.kind === 'poly') {
        ctx.beginPath();
        for (const part of g.parts) {
          const pts = ptsOf(part); if (!pts.length) continue;
          pts.forEach((c, i) => { const [x, y] = this.project(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath();
        }
        ctx.fillStyle = hexA(sel ? ACCENT : col, sel ? 0.28 : 0.18);
        ctx.fill('evenodd');              // дырки (внутренние кольца) вычитаются
        ctx.strokeStyle = stroke; ctx.lineWidth = sel ? 2.5 : 1.2; ctx.stroke();
      } else if (f.kind === 'line') {
        ctx.beginPath();
        for (const part of g.parts) {
          const pts = ptsOf(part); if (!pts.length) continue;
          pts.forEach((c, i) => { const [x, y] = this.project(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        }
        ctx.strokeStyle = stroke; ctx.lineWidth = sel ? 3 : 1.5; ctx.stroke();
      } else {                            // pt: каждая часть — отдельная точка [lon,lat,z]
        const rad = sel ? 5 : 3;
        ctx.fillStyle = stroke; ctx.strokeStyle = BG; ctx.lineWidth = 1;
        for (const p of g.parts) {
          const [x, y] = this.project(p[0], p[1]);
          ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  #camera(ctx) {                          // frustum + маркер камеры (в повёрнутой системе)
    if (!this.cam) return;
    const h = this.cam.heading;
    // квад прячем на большой высоте: с высоты птичьего полёта он перекрывает весь план
    // (PLAN-ui-polish D1: app.js присылает quad=null, когда камера выше лимита)
    if (this.cam.quad) {
      ctx.beginPath();
      this.cam.quad.forEach((c, i) => { const [x, y] = this.project(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,176,32,0.15)'; ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const [mx, my] = this.project(this.cam.lon, this.cam.lat);
    /* луч взгляда (N5 → ADR-33): от маркера камеры до конца rayEnd. Конец считает app.js
     * рейкастом по печной сетке коллизии: попадание — точка удара + дистанция rayDist
     * (метры, подписываем 0.1 м только на большом плане); промах за предел — rayDist=null,
     * рисуем пунктир до отсечки без подписи. Луч виден и когда квада нет: камера выше лимита. */
    if (this.cam.rayEnd) {
      const [ex, ey] = this.project(this.cam.rayEnd[0], this.cam.rayEnd[1]);
      const dist = typeof this.cam.rayDist === 'number' ? this.cam.rayDist : null;
      ctx.strokeStyle = '#4ad7ff'; ctx.lineWidth = 1.5;
      if (dist === null) ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#4ad7ff'; ctx.fill();
      if (dist !== null && !this.radar) {
        const label = dist.toFixed(1) + ' м';
        ctx.font = '600 11px ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        const lx = mx + (ex - mx) * 0.62, ly = my + (ey - my) * 0.62;
        ctx.fillStyle = 'rgba(4,6,10,0.72)';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(lx - tw / 2 - 4, ly - 15, tw + 8, 15);
        ctx.fillStyle = '#4ad7ff';
        ctx.fillText(label, lx, ly - 2);
      }
    }
    const vE = Math.sin(h), vN = -Math.cos(h);   // направление взгляда в локальных пикселах
    ctx.beginPath();
    ctx.moveTo(mx + vE * 14, my + vN * 14);
    ctx.lineTo(mx - vN * 5 - vE * 4, my + vE * 5 - vN * 4);
    ctx.lineTo(mx + vN * 5 - vE * 4, my - vE * 5 - vN * 4);
    ctx.closePath();
    ctx.fillStyle = ACCENT; ctx.fill();
    ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  #compass(ctx, r) {                      // стрелка «С» в screen-space, когда мир повёрнут
    const cx = r.width / 2, cy = r.height / 2, th = this.heading;
    const nx = Math.sin(th), ny = -Math.cos(th);  // север на экране
    const rad = Math.min(r.width, r.height) / 2 - 9;
    const tipx = cx + nx * rad, tipy = cy + ny * rad;
    const bx = -nx, by = -ny, px = -ny, py = nx;
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tipx, tipy); ctx.lineTo(cx + nx * (rad - 11), cy + ny * (rad - 11));
    ctx.moveTo(tipx, tipy); ctx.lineTo(tipx + bx * 6 + px * 3.5, tipy + by * 6 + py * 3.5);
    ctx.moveTo(tipx, tipy); ctx.lineTo(tipx + bx * 6 - px * 3.5, tipy + by * 6 - py * 3.5);
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    ctx.font = '600 10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('С', cx + nx * (rad - 20), cy + ny * (rad - 20));
  }

  draw() {
    const r = this.#syncSize();           // самовосстановление: см. resize(), правка 22.11 (баг ресайза)
    if (!r) return;
    const ctx = this.ctx, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, r.width, r.height);
    ctx.save();
    ctx.translate(r.width / 2, r.height / 2);
    if (this.heading) ctx.rotate(this.heading);
    this.#tiles(ctx, r);
    this.#features(ctx);
    this.#camera(ctx);
    ctx.restore();
    if (this.rotOn) this.#compass(ctx, r);
  }

  pick(e) {
    const r = this.c.getBoundingClientRect();
    if (!r.width) return;
    const [px, py] = this.#screenToLocal(e.clientX - r.left, e.clientY - r.top, r);
    let hit = null, best = Infinity;
    // сначала точки/линии — они конкретнее полигонов
    for (const f of this.features) {
      const g = f.geom; if (!g || !g.parts) continue;
      if (f.kind === 'pt') {
        for (const p of g.parts) {
          const [x, y] = this.project(p[0], p[1]);
          const d = Math.hypot(x - px, y - py);
          if (d <= 9 && d < best) { best = d; hit = f; }
        }
      } else if (f.kind === 'line') {
        for (const part of g.parts) {
          const pts = ptsOf(part);
          for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = this.project(pts[i - 1][0], pts[i - 1][1]);
            const [bx, by] = this.project(pts[i][0], pts[i][1]);
            const d = distSeg(px, py, ax, ay, bx, by);
            if (d <= 9 && d < best) { best = d; hit = f; }
          }
        }
      }
    }
    // затем полигоны: попадание по правилу чётности (учитывает дырки и мультиполигоны)
    if (!hit) {
      for (const f of this.features) {
        const g = f.geom; if (!g || f.kind !== 'poly') continue;
        let inside = false;
        for (const part of g.parts) if (this.#inRing(ptsOf(part), px, py)) inside = !inside;
        if (inside) { hit = f; break; }
      }
    }
    if (this.opts.onPick) this.opts.onPick(hit ? hit.id : null);
  }

  /* гео-координата точки канваса: инверсия project() через ту же сетку тайлов,
   * с снятием поворота мира (heading), если включён rotOn */
  #screenToGeo(clientX, clientY) {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const [lx, ly] = this.#screenToLocal(clientX - r.left, clientY - r.top, r);
    const k = resolution(this.z, this.center[1]) / this.mpp;
    const [cx, cy] = lonLatToWorldPx(this.center[0], this.center[1], this.z);
    return worldPxToLonLat(cx + lx / k, cy + ly / k, this.z);
  }

  #inRing(ring, px, py) {
    let inside = false;
    const pts = ring.map(c => this.project(c[0], c[1]));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
}
