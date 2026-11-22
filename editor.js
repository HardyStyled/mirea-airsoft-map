/* editor.js — редактор объектов tactical.gpkg прямо в 3D (задача T9, контракт PLAN-editor.md).
 * Две ступени доступа (требование владельца 22.11): сначала глобальный режим «Правка»
 * (App.edit в app.js) — до него клики только выбирают и инспектор read-only; внутри него
 * поток правки одного объекта (ADR-10): «Правка» → вершины (drag по земле, Shift+drag = высота,
 * Z-поля в инспекторе) → «Применить» (запись в сессионную копию) или «Отменить» (откат).
 * Автосохранения нет. Геометрия сохраняется в исходном типе: CurvePolygon/CompoundCurve
 * не превращаются в полилинии (ADR-9). Высоты в геометрии — реальные (~188 м), сущности
 * рисуются в кадре приложения (z − GROUND_H), ADR-2. */
'use strict';

const Editor = {
  attach, onTool, onSceneClick, onBeforeDeselect, onSelect, renderVerts, acts,
  canEditName, canMove, rename, moveToLayer, escape, enter, deleteSelected,
  isDrawing, drawLayer, drawLayerName, drawKind, onLayerPick,
};
window.Editor = Editor;

let editing = false, snap = null;
let handles = [], mids = [], preview = [];
let drag = null, drawing = null, lastHandleAt = 0, lastRedraw = 0, shiftDown = false;

/* ——— доступ к точкам геометрии с сохранением структуры part'ов ——— */
function partList(g, pi) {
  if (g.type === 'Point') return [g.parts[pi]];
  const p = g.parts[pi];
  return Array.isArray(p) ? p : p.pts;
}
function setPt(g, pi, vi, arr) {
  if (g.type === 'Point') g.parts[pi] = arr;
  else if (Array.isArray(g.parts[pi])) g.parts[pi][vi] = arr;
  else g.parts[pi].pts[vi] = arr;
  if (arr[2] != null) g.hasZ = true;   // тронули высоту — слой становится 3D (apply поднимет метаданные)
}
function isRing(g) { return g.type === 'Polygon' || g.type === 'CurvePolygon'; }
function closed(g, c) {
  if (!isRing(g) || c.length < 2) return false;
  const a = c[0], b = c[c.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}
const deep = g => JSON.parse(JSON.stringify(g));
// отметка по умолчанию для слоёв без Z — уровень земли (ADR-2: в файле z реальная, ~188 м)
const zOf = p => (p[2] ?? GROUND_H);
const posOf = p => Cesium.Cartesian3.fromDegrees(p[0], p[1], zOf(p) - GROUND_H);
const nameKey = s => s && s.attrs && Object.keys(s.attrs).find(k => k.toLowerCase() === 'name');

/* ——— кнопки сессии (ADR-14: контекстные Правка → Применить/Отменить).
 * Кнопка «Правка» появляется только в глобальном режиме правки (App.edit). */
function acts() {
  // без WebGL кнопки сессии не нужны: Editor.attach() к плану не привязан, имя правится в инспекторе
  $('editBtn').style.display = (editing || !App.edit || NO_GL) ? 'none' : '';
  $('apply').style.display = editing ? '' : 'none';
  $('cancel').style.display = editing ? '' : 'none';
}
function setEditing(on) {
  if (!on && !editing) return;
  if (on) {
    if (!App.edit || !App.sel || !App.sel.geom || App.walk) return;
    snap = deep(App.sel.geom);
    editing = true;
    App.setTool('vertex');
    makeHandles();
  } else {
    editing = false; snap = null; drag = null;
    clearMarks();
  }
  acts(); renderVerts(); redrawSel();
}

/* ——— маркеры вершин и середин рёбер ——— */
function mark(p, extra, color, size) {
  const e = viewer.entities.add({
    position: posOf(p),
    point: { pixelSize: size, color: Cesium.Color.fromCssColorString(color),
             outlineColor: Cesium.Color.fromCssColorString('#04060a'), outlineWidth: 1,
             disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
  Object.assign(e, extra);
  return e;
}
function makeHandles() {
  clearMarks();
  const g = App.sel.geom;
  for (let pi = 0; pi < g.parts.length; pi++) {
    const c = partList(g, pi);
    c.forEach((p, vi) => handles.push(mark(p, { editorHandle: { pi, vi } }, '#ffb020', 9)));
    if (g.type === 'Point' || c.length < 2) continue;
    // рёбер всегда на одно меньше, чем точек: и для разомкнутой линии, и для замкнутого кольца
    // (замкнутая точка кольца — это снова первая). Прежнее n = c.length для линии читало c[len]
    // и роняло «Правку» на любом LINESTRING (нашли на roads 3, 22.11).
    const n = c.length - 1;
    for (let vi = 0; vi < n; vi++) {
      const a = c[vi], b = c[vi + 1];
      mids.push(mark([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((a[2] ?? 0) + (b[2] ?? 0)) / 2],
        { editorMid: { pi, vi } }, '#4ad7ff', 5));
    }
  }
}
function clearMarks() {
  for (const e of handles.concat(mids, preview)) viewer.entities.remove(e);
  handles = []; mids = []; preview = [];
}
function redrawSel() {
  const now = performance.now();
  if (now - lastRedraw < 60) return;
  lastRedraw = now;
  if (App.sel) App.redrawFeature(App.sel.table, App.sel.fid);
}

/* ——— пересечение луча камеры с горизонтальной плоскостью (drag вершины по земле) ——— */
const UP = Cesium.Matrix4.multiplyByPointAsVector(ENU, new Cesium.Cartesian3(0, 0, 1), new Cesium.Cartesian3());
const SITE = Cesium.Cartographic.fromCartesian(SITE_CENTER);
function rayToPlane(screenPos, worldZ) {
  const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(screenPos.x, screenPos.y));
  if (!ray) return null;
  const denom = Cesium.Cartesian3.dot(ray.direction, UP);
  if (Math.abs(denom) < 1e-9) return null;
  const planePoint = Cesium.Cartesian3.fromRadians(SITE.longitude, SITE.latitude, worldZ);
  const t = Cesium.Cartesian3.dot(Cesium.Cartesian3.subtract(planePoint, ray.origin, new Cesium.Cartesian3()), UP) / denom;
  if (t <= 0) return null;
  const hit = Cesium.Cartesian3.add(ray.origin, Cesium.Cartesian3.multiplyByScalar(ray.direction, t, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const cg = Cesium.Cartographic.fromCartesian(hit);
  return { lon: Cesium.Math.toDegrees(cg.longitude), lat: Cesium.Math.toDegrees(cg.latitude), h: cg.height };
}
const mppNow = () => FOV_TAN * viewer.camera.positionCartographic.height / (viewer.canvas.clientHeight || 1);

/* ——— мышь редактора: drag вершины, drag объекта, hover-курсор ——— */
function attach() {
  $('editBtn').onclick = () => setEditing(true);
  $('apply').onclick = apply;
  $('cancel').onclick = cancel;
  const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  h.setInputAction(e => onDown(e.position), Cesium.ScreenSpaceEventType.LEFT_DOWN);
  h.setInputAction(e => onMove(e.position), Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  h.setInputAction(e => onUp(e.position), Cesium.ScreenSpaceEventType.LEFT_UP);
  h.setInputAction(e => { if (drawing) enter(); }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  // Shift = vertical drag (высота): у события Cesium нет модификаторов, следим сами
  addEventListener('keydown', e => { if (e.key === 'Shift') shiftDown = true; });
  addEventListener('keyup', e => { if (e.key === 'Shift') shiftDown = false; });
  addEventListener('blur', () => { shiftDown = false; });
}
function onDown(pos) {
  if (App.walk) return;
  const id = App.pickAt(pos);          // drillPick: маркеры под сплатами тоже цепляются
  if (id && id.editorHandle) {
    const { pi, vi } = id.editorHandle;
    drag = { kind: 'vertex', pi, vi, last: pos, ent: id };
    App.camLock(true);
    selectVertex(pi, vi);
    lastHandleAt = Date.now();
    viewer.canvas.style.cursor = 'grabbing';
    return;
  }
  if (App.sel && id && id.gpkId === App.sel.id && App.tool === 'move') {
    drag = { kind: 'move', last: pos };
    App.camLock(true);
    viewer.canvas.style.cursor = 'grabbing';
  }
}
function onMove(pos) {
  if (!drag) { hoverCursor(pos); return; }
  const g = App.sel && App.sel.geom;
  if (!g) { drag = null; return; }
  if (drag.kind === 'vertex') {
    const c = partList(g, drag.pi);
    const p = c[drag.vi];
    if (shiftDown) {
      const dz = -(pos.y - drag.last.y) * mppNow();
      setPt(g, drag.pi, drag.vi, [p[0], p[1], zOf(p) + dz]);
    } else {
      const hit = rayToPlane(pos, zOf(p) - GROUND_H);
      if (hit) setPt(g, drag.pi, drag.vi, [hit.lon, hit.lat, zOf(p)]);
    }
    drag.ent.position = new Cesium.ConstantPositionProperty(posOf(partList(g, drag.pi)[drag.vi]));
    drag.last = pos;
    redrawSel();
    return;
  }
  if (drag.kind === 'move') {
    const z0 = g.parts[0] ? zOf(partList(g, 0)[0]) : GROUND_H;
    const a = rayToPlane(drag.last, z0 - GROUND_H);
    const b = rayToPlane(pos, z0 - GROUND_H);
    if (a && b) {
      const dLon = b.lon - a.lon, dLat = b.lat - a.lat;
      for (let pi = 0; pi < g.parts.length; pi++) {
        const c = partList(g, pi);
        for (let vi = 0; vi < c.length; vi++) {
          const p = c[vi];
          setPt(g, pi, vi, [p[0] + dLon, p[1] + dLat, p[2]]);   // высоту не трогаем: 2D-объект не превращаем в 3D
        }
      }
      drag.last = pos;
      redrawSel();
    }
  }
}
function onUp() {
  if (!drag) return;
  drag = null;
  App.camLock(false);
  viewer.canvas.style.cursor = '';
  lastHandleAt = Date.now();
  renderVerts();
  App.refreshPlanFeatures();
}
let hoverAt = 0;
function hoverCursor(pos) {
  if (!editing && App.tool !== 'move') return;
  const now = performance.now();
  if (now - hoverAt < 90) return;          // drillPick дорог на каждый mousemove
  hoverAt = now;
  const id = App.pickAt(pos);
  viewer.canvas.style.cursor =
    (id && (id.editorHandle || id.editorMid)) || (App.sel && App.tool === 'move' && id && id.gpkId === App.sel.id) ? 'grab' : '';
}

/* ——— вставка/удаление вершин ——— */
function insertAfter(pi, vi) {
  const g = App.sel.geom, c = partList(g, pi);
  if (g.type === 'Point' || c.length < 2) return;
  const a = c[vi], b = c[(vi + 1) % c.length];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((a[2] ?? 0) + (b[2] ?? 0)) / 2];
  c.splice(vi + 1, 0, mid);
  if (closed(g, c)) c[c.length - 1] = c[0].slice();
  App.sel.geom = g;
  makeHandles(); redrawSel(); renderVerts();
  toast('вершина вставлена');
}
function longestEdge(pi) {
  const c = partList(App.sel.geom, pi);
  const n = c.length - 1;                       // рёбер всегда на одно меньше точек (см. makeHandles)
  let best = 0, bl = -1;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(c[i][0] - c[i + 1][0], c[i][1] - c[i + 1][1]);
    if (l > bl) { bl = l; best = i; }
  }
  return best;
}
function deleteVertex(pi, vi) {
  const g = App.sel.geom, c = partList(g, pi);
  if (g.type === 'Point') return;
  if (closed(g, c) && vi === c.length - 1) vi = 0;   // замыкающая точка кольца — не отдельная вершина
  if (isRing(g) && c.length <= 4) return toast('полигону нужно ≥3 вершины');
  c.splice(vi, 1);
  if (isRing(g)) c[c.length - 1] = c[0].slice();   // кольцо остаётся кольцом, какую вершину ни удали
  makeHandles(); redrawSel(); renderVerts();
}

/* ——— список вершин в инспекторе (кап 80, ADR-14) ——— */
let selV = -1;
function selectVertex(pi, vi) { selV = vi; renderVerts(); }
function renderVerts() {
  const box = $('verts');
  if (!editing || !App.sel || App.sel.geom.type === 'Point') {
    box.innerHTML = ''; selV = -1;      // после «Отменить» список вершин не должен оставаться на экране
    return;
  }
  const g = App.sel.geom;
  let count = 0, total = 0;
  for (let pi = 0; pi < g.parts.length; pi++) {
    const c = partList(g, pi);
    const n = closed(g, c) ? c.length - 1 : c.length;   // замыкающую точку кольца не показываем
    total += n;
    if (g.parts.length > 1) box.append(el('div', 'vrow', `<span class="vidx" style="width:auto">часть ${pi + 1}</span>`));
    for (let vi = 0; vi < n; vi++) {
      if (count++ >= 80) continue;
      const p = c[vi];
      const row = el('div', 'vrow' + (vi === selV ? ' sel' : ''));
      row.innerHTML = `<span class="vidx">V${String(vi + 1).padStart(2, '0')}</span>` +
        `<input type="number" step="0.1" value="${zOf(p).toFixed(2)}"><span class="zu">м</span>` +
        `<button class="x" title="удалить вершину">✕</button>`;
      row.querySelector('input').oninput = e => {
        const v = +e.target.value;
        if (!Number.isFinite(v)) return;   // пустое поле или мусор — геометрию не портим
        setPt(g, pi, vi, [p[0], p[1], v]);
        const h = handles.find(x => x.editorHandle.pi === pi && x.editorHandle.vi === vi);
        if (h) h.position = new Cesium.ConstantPositionProperty(posOf(partList(g, pi)[vi]));
        redrawSel();
      };
      row.querySelector('.x').onclick = () => deleteVertex(pi, vi);
      box.append(row);
    }
  }
  if (total > 80) box.append(el('div', 'vrow',
    `<span class="vidx">…</span><span class="zu" style="flex:1;white-space:normal">и ещё ${total - 80} — правьте drag'ом на карте</span>`));
}

/* ——— применить / отменить ——— */
// геометрия стала 3D — добиваем пропущенные отметки уровнем земли, иначе кодек запишет 0
// (это на 188 м ниже поверхности) и объект провалится под землю
function fillZ(g) {
  if (!g || !g.hasZ) return;
  const put = p => { if (p[2] == null) p[2] = GROUND_H; };
  for (const part of g.parts) {
    if (g.type === 'Point') put(part);
    else if (Array.isArray(part)) part.forEach(put);
    else if (part && part.pts) part.pts.forEach(put);
  }
}
function apply() {
  const s = App.sel, L = App.GP.layers.find(x => x.table === s.table);
  fillZ(s.geom);
  if (s.geom.hasZ) App.GP.promoteZ(s.table);
  App.GP.setGeom(s.table, s.fid, s.geom);
  const f = App.GP.features(s.table).find(x => x.fid === s.fid);
  if (f && f.geom && f.geom.hasZ) s.geom.hasZ = true;
  setEditing(false);
  App.renderLayer(L);
  App.refreshPlanFeatures();
  toast('применено · запись в сессионную копию');
}
function cancel() {
  if (snap && App.sel) App.sel.geom = snap;
  setEditing(false);
  redrawSel();
  App.refreshPlanFeatures();
  toast('отменено');
}

/* ——— инструменты рельла ——— */
const KIND_RU = { newpoly: 'полигон', newline: 'линия', newpoint: 'точка' };
let lastDrawLayer = '';
function layerName(table) { const L = App.GP && App.GP.layers.find(x => x.table === table); return L ? L.name : table; }
function isDrawing() { return !!drawing; }
function drawLayer() { return drawing ? drawing.table : (App.sel ? App.sel.table : lastDrawLayer); }
function drawLayerName() { return layerName(drawLayer()); }
function drawKind() { return drawing ? KIND_RU[drawing.kind] : ''; }
function cancelDraw() {
  if (!drawing) return;
  drawing = null;
  for (const e of preview) viewer.entities.remove(e);
  preview = [];
  App.setTool('sel');
  App.showInsp();
  toast('рисование отменено');
}
function onLayerPick(v) {
  if (drawing) { drawing.table = v; lastDrawLayer = v; toast('слой: ' + layerName(v)); return; }
  if (App.sel) moveToLayer(v);
}
function onTool(t) {
  if (t === 'arc' && editing && App.sel && App.sel.geom.type !== 'Point') {
    insertAfter(0, longestEdge(0));
    return;
  }
  if (KIND_RU[t]) {
    if (drawing) { for (const e of preview) viewer.entities.remove(e); preview = []; }
    const table = lastDrawLayer || $('fLayer').value || (App.sel && App.sel.table) || App.GP.layers[0].table;
    drawing = { table, kind: t, pts: [] };
    lastDrawLayer = table;
    App.showInsp();
    toast('рисуем в слой «' + layerName(table) + '» · ' + (t === 'newpoint' ? 'клик — поставить точку' : 'клики — вершины, Enter — завершить, Esc — отмена'));
  }
}
function onSceneClick(pos) {
  if (App.walk) return false;
  if (Date.now() - lastHandleAt < 300) return true;
  const id = App.pickAt(pos);
  if (drawing) { addDrawPoint(pos); return true; }
  if (editing && id && id.editorMid) { insertAfter(id.editorMid.pi, id.editorMid.vi); return true; }
  if (editing && id && id.editorHandle) { selectVertex(id.editorHandle.pi, id.editorHandle.vi); return true; }
  return false;
}

/* ——— рисование новых объектов ——— */
function groundAt(pos) {
  const hit = rayToPlane(pos, 0);
  return hit ? [hit.lon, hit.lat, GROUND_H] : null;
}
function addDrawPoint(pos) {
  const p = groundAt(pos);
  if (!p) return;
  drawing.pts.push(p);
  preview.push(mark(p, {}, '#4ad7ff', 7));
  drawPreview();
}
function drawPreview() {
  for (const e of preview.filter(x => x.editorPreview)) viewer.entities.remove(e);
  if (drawing.pts.length < 2) return;
  const e = viewer.entities.add({
    polyline: { positions: drawing.pts.map(posOf), width: 2,
                material: Cesium.Color.fromCssColorString('#4ad7ff'), clampToGround: true },
  });
  e.editorPreview = true;
  preview.push(e);
}
function finishDraw() {
  const d = drawing; drawing = null;
  for (const e of preview) viewer.entities.remove(e);
  preview = [];
  if (!d) return;
  const hasZ = true;
  let geom = null;
  if (d.kind === 'newpoint') {
    if (!d.pts.length) return toast('точка не поставлена');
    geom = { srid: 4326, type: 'Point', hasZ, parts: d.pts };
  } else if (d.kind === 'newline') {
    if (d.pts.length < 2) return toast('линии нужно ≥2 точки');
    geom = { srid: 4326, type: 'LineString', hasZ, parts: [d.pts] };
  } else {
    if (d.pts.length < 3) return toast('полигону нужно ≥3 вершины');
    geom = { srid: 4326, type: 'Polygon', hasZ, parts: [[...d.pts, d.pts[0].slice()]] };
  }
  const L = App.GP.layers.find(x => x.table === d.table);
  lastDrawLayer = L.table;
  App.GP.promoteZ(L.table);
  const fid = App.GP.addFeature(L.table, { name: '' }, geom);
  App.renderLayer(L);
  App.refreshPlanFeatures();
  App.select({ table: L.table, fid, id: L.table + ':' + fid, layer: L.name, name: '',
               attrs: { name: '' }, hasZ, geom });
  App.setTool('sel');
  toast('создан в слой ' + L.name + ' (сессия)');
}

/* ——— имя, перенос между слоями, удаление: всё только в режиме правки (владелец 22.11) ——— */
function canEditName(s) { return !!(App.GP && App.edit && !App.walk && s && nameKey(s)); }
function canMove(s) { return !!(App.GP && App.edit && !App.walk && s && App.GP.layers.length > 1); }
function rename(value) {
  const s = App.sel, key = nameKey(s);
  if (!key || !App.edit) return;
  s.attrs[key] = value; s.name = value;
  App.GP.setAttr(s.table, s.fid, key, value);
  App.refreshPlanFeatures();
}
function moveToLayer(table) {
  const s = App.sel;
  if (!s || !App.edit || table === s.table) return;
  const Lto = App.GP.layers.find(x => x.table === table);
  if (s.geom.hasZ) App.GP.promoteZ(table);        // 2D-объект не должен превращать слой в Z-слой
  const fid = App.GP.addFeature(table, s.attrs, s.geom);
  App.GP.deleteFeature(s.table, s.fid);
  const Lfrom = App.GP.layers.find(x => x.table === s.table);
  App.renderLayer(Lfrom); App.renderLayer(Lto);
  App.refreshPlanFeatures();
  const old = App.ents.get(s.id);
  if (old && App.viewer) for (const e of old) App.viewer.entities.remove(e);
  App.ents.delete(s.id);
  App.select({ table, fid, id: table + ':' + fid, layer: Lto.name, name: s.name,
               attrs: s.attrs, hasZ: s.geom.hasZ, geom: s.geom });
  toast('перенесён в ' + Lto.name);
}
function deleteSelected() {
  const s = App.sel;
  if (!s || !App.edit || App.walk) return;
  const L = App.GP.layers.find(x => x.table === s.table);
  const old = App.ents.get(s.id);
  if (old && App.viewer) for (const e of old) App.viewer.entities.remove(e);
  App.ents.delete(s.id);
  App.GP.deleteFeature(s.table, s.fid);
  App.select(null);
  App.renderLayer(L);
  App.refreshPlanFeatures();
  renderLayerCount(L);
  toast('удалён ' + (s.name || s.layer + ' fid ' + s.fid) + ' · экспорт закрепит в файле');
}
function renderLayerCount(L) {
  const row = [...document.querySelectorAll('#llist .layer .nm')].find(n => n.textContent === L.name);
  if (row) row.parentElement.querySelector('.cnt').textContent = String(L.count);
}

/* ——— смена выбора и Esc/Enter ——— */
function onSelect() { if (editing) cancel(); selV = -1; acts(); }
function onBeforeDeselect() { if (editing) cancel(); }
function escape() {
  if (drawing) { cancelDraw(); return; }
  if (editing) cancel();
}
function enter() { if (drawing) finishDraw(); }
