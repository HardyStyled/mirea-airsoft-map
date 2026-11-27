/* что здесь живёт: план (сплит) и радар, луч взгляда rayEnd, syncPlans, makePlan/ensurePanels, гpkg-рендер, выбор, инспектор, loadGpkg. */
/* plans.js — план (сплит) и радар, луч взгляда (rayEnd) по печной сетке коллизии,
 * syncPlans() из postRender, makePlan()/ensurePanels(). Луч инвалидируется через hooks.view
 * (§9), а не прямым вызовом из state. Также здесь гpkg-рендер объектов, выбор, инспектор,
 * пикап и loadGpkg (перенесено из app.js без изменения логики). */
import { App, on } from './state.js?v=16';
import { PlanPane } from './plan.js?v=16';
import { EXTENT, rect, MAX_VIEW_M, FRUSTUM_MAX_H } from './config.js?v=16';
import { updateReadout } from './readout.js?v=16';
import { $, el, esc } from './dom.js?v=16';
import { gpkgOpen } from './gpkg.js?v=16';
import { fitBasemapDrop } from './assets.js?v=16';
import { Collision } from './collision.js?v=16';

export const FRUSTUM_RANGE = 200;               // м: предел дальности точки квада от камеры
export const RAY_MAX = 300;                     // м: предел дальности луча
export const RAY_MS = 250;
export const rayCache = { at: 0, end: null, dist: null };
export function invalidateRay() { rayCache.at = 0; rayCache.end = null; rayCache.dist = null; }

// инвалидация луча при смене вида — через шину, а не прямым вызовом из state (§9)
export function onViewRay() { on('view', invalidateRay); }

let collEnu = null, collEnuInv = null;
function collisionEnu() {
  if (!Collision.grid) return null;
  if (!collEnu) {
    const m = Collision.grid.meta;
    collEnu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(m.originLon, m.originLat));
    collEnuInv = Cesium.Matrix4.inverse(collEnu, new Cesium.Matrix4());
  }
  return collEnu;
}

export function camGround() {
  if (!App.viewer) return App.plan ? App.plan.center : [(EXTENT.w + EXTENT.e) / 2, (EXTENT.s + EXTENT.n) / 2];
  const c = App.viewer.camera.positionCartographic; return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
}

export function frustumQuad() {
  if (!App.viewer) return null;
  const w = App.viewer.canvas.clientWidth, h = App.viewer.canvas.clientHeight, pts = [];
  const cam = App.viewer.camera;
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cam.position);
  const groundPt = Cesium.Cartesian3.add(cam.position,
    Cesium.Cartesian3.multiplyByScalar(normal, -cam.positionCartographic.height, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const plane = Cesium.Plane.fromPointNormal(groundPt, normal);
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const ray = cam.getPickRay(new Cesium.Cartesian2(x, y));
    let t = FRUSTUM_RANGE;
    const hit = ray && Cesium.IntersectionTests.rayPlane(ray, plane);
    if (hit) {
      const d = Cesium.Cartesian3.distance(cam.position, hit);
      if (d > 0 && d < FRUSTUM_RANGE) t = d;
    }
    const p = Cesium.Ray.getPoint(ray, t, new Cesium.Cartesian3());
    const cg = Cesium.Cartographic.fromCartesian(p);
    pts.push([Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)]);
  }
  return pts;
}

export function panMain(dLon, dLat) {
  if (App.CAM) App.CAM.panByGround(dLon, dLat);
}

export function rayEnd() {
  if (!App.viewer) return null;
  const now = performance.now();
  if (rayCache.end && now - rayCache.at < RAY_MS) return rayCache.end;
  const cam = App.viewer.camera;
  let p = null, dist = null;
  if (collisionEnu()) {
    const o = Cesium.Matrix4.multiplyByPoint(collEnuInv, cam.position, new Cesium.Cartesian3());
    const d = Cesium.Matrix4.multiplyByPointAsVector(collEnuInv, cam.direction, new Cesium.Cartesian3());
    const hit = Collision.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, RAY_MAX);
    if (hit) {
      p = Cesium.Matrix4.multiplyByPoint(collEnu, new Cesium.Cartesian3(hit.e, hit.n, hit.u), new Cesium.Cartesian3());
      dist = hit.dist;
    } else {
      p = Cesium.Ray.getPoint(new Cesium.Ray(cam.position, cam.direction), RAY_MAX, new Cesium.Cartesian3());
    }
  } else {
    p = Cesium.Ray.getPoint(new Cesium.Ray(cam.position, cam.direction), FRUSTUM_RANGE, new Cesium.Cartesian3());
  }
  const cg = Cesium.Cartographic.fromCartesian(p);
  rayCache.at = now;
  rayCache.end = [Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)];
  rayCache.dist = dist;
  return rayCache.end;
}

export function syncPlans() {
  const split = document.body.classList.contains('split3d');
  const mini = document.body.classList.contains('full3d');
  if (!App.plan && !App.mmPlan) return;
  if ((split && App.plan && App.plan.busy) || (mini && App.mmPlan && App.mmPlan.busy)) return;
  const [lon, lat] = camGround();
  const hAg = App.viewer ? App.viewer.camera.positionCartographic.height : 0;
  const cam = { lon, lat, heading: App.viewer ? App.viewer.camera.heading : 0,
    quad: hAg <= FRUSTUM_MAX_H ? frustumQuad() : null, rayEnd: rayEnd(), rayDist: rayCache.dist };
  if (split && App.plan) {
    App.plan.setCamera(cam);
    if (App.plan.follow) App.plan.setViewCenter(lon, lat); else App.plan.draw();
  }
  if (mini && App.mmPlan) {
    App.mmPlan.setCamera(cam);
    App.mmPlan.setViewCenter(lon, lat);
  }
}

export function makePlan(canvas, opts) {
  const p = new PlanPane(canvas, [], Object.assign({
    center: camGround(), mpp: 0.35,
    onView: () => { updateReadout(); },
    onTapGround: geo => {
      if (!geo || !App.CAM || !document.body.classList.contains('split3d')) return;
      const [lon, lat] = geo;
      if (App.CAM.mode === 'fly') {
        const [clon, clat] = camGround();
        panMain(lon - clon, lat - clat);
      } else App.CAM.focusAtGround(lon, lat);
    },
    onPick: id => {
      const r = App.feats.find(f => f.id === id); if (!r) { App.select(null); return; }
      const f = App.GP.features(r.table).find(x => x.fid === r.fid);
      App.select({ table: r.table, fid: r.fid, id: r.id, layer: r.layer, name: r.name,
        attrs: (f && f.attrs) || {}, hasZ: r.geom.hasZ, geom: r.geom });
    },
  }, opts));
  return p;
}

export function ensurePanels() {
  if (!App.plan) {
    App.plan = makePlan($('plan'), { follow: false, rotOn: false, maxViewM: MAX_VIEW_M });
    App.plan.resize(); App.plan.fit(rect);
  }
  if (!App.mmPlan && !App.noGl) {
    App.mmPlan = makePlan($('mmc'), { radar: true, follow: false, rotOn: true, maxViewM: MAX_VIEW_M,
      onView: () => {}, onPick: () => {}, onTapGround: undefined });
    App.mmPlan.resize();
    App.mmPlan.fit(rect);
  }
}

/* ━━━ гpkg-рендер объектов (перенесено из app.js без изменения логики) ━━━ */
function gpkPos(p, hasz) { const h = hasz ? (p[2] ?? 0) - 188 : 0; return Cesium.Cartesian3.fromDegrees(p[0], p[1], h); }
function heightOf(attrs) {
  if (!attrs) return 0;
  for (const k of Object.keys(attrs)) { if (k.toLowerCase() !== 'height') continue; const v = +attrs[k]; return Number.isFinite(v) && v > 0 ? v : 0; }
  return 0;
}
function maxRelZ(pts) { let m = -Infinity; for (const p of pts) m = Math.max(m, (p[2] ?? 188) - 188); return m === -Infinity ? 0 : m; }
function geomParts(g) { if (g.type === 'Point') return g.parts; if (g.type === 'Polygon') return g.parts; if (g.type === 'LineString') return g.parts; return g.parts.map(m => m.pts); }
function geomKind(t) { return t === 'Point' ? 'pt' : (t === 'Polygon' || t === 'CurvePolygon') ? 'poly' : 'line'; }
function clearLayerEnts(table) {
  if (!App.viewer) return;
  for (const [id, ents] of App.ents) { if (!id.startsWith(table + ':')) continue; for (const e of ents) App.viewer.entities.remove(e); App.ents.delete(id); }
}
function renderFeature(L, f) {
  if (!App.viewer) return [];
  const st = App.styleOf(L.name); const g = f.geom; if (!g) return [];
  const id = L.table + ':' + f.fid; const hasz = g.hasZ;
  const mk = e => { e.gpk = { table: L.table, layer: L.name, fid: f.fid, attrs: f.attrs, hasZ: hasz, type: g.type }; e.gpkId = id; return e; };
  const ents = [];
  if (g.type === 'Point') {
    for (const p of g.parts) ents.push(mk(App.viewer.entities.add({ position: gpkPos(p, hasz), point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(st.line), outlineColor: Cesium.Color.fromCssColorString('#04060a'), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY } })));
  } else if (geomKind(g.type) === 'poly') {
    const vol = hasz ? heightOf(f.attrs) : 0;
    for (const ring of geomParts(g)) ents.push(mk(App.viewer.entities.add({ polygon: Object.assign({ hierarchy: new Cesium.PolygonHierarchy(ring.map(p => gpkPos(p, hasz))), material: Cesium.Color.fromCssColorString(st.fill || 'transparent'), outline: true, outlineColor: Cesium.Color.fromCssColorString(st.line), perPositionHeight: hasz }, vol ? { extrudedHeight: maxRelZ(ring) + vol } : {}) })));
  } else {
    const vol = hasz ? heightOf(f.attrs) : 0;
    for (const line of geomParts(g)) {
      if (vol) ents.push(mk(App.viewer.entities.add({ wall: { positions: line.map(p => gpkPos(p, hasz)), maximumHeights: line.map(p => (p[2] ?? 188) - 188 + vol), material: Cesium.Color.fromCssColorString(st.line).withAlpha(0.5) } })));
      ents.push(mk(App.viewer.entities.add({ polyline: { positions: line.map(p => gpkPos(p, hasz)), width: 2, material: Cesium.Color.fromCssColorString(st.line), clampToGround: !hasz } })));
    }
  }
  App.ents.set(id, ents); return ents;
}
App.renderFeature = renderFeature;
function renderLayer(L) { clearLayerEnts(L.table); if (App.layerOn[L.table] === false) return; for (const f of App.GP.features(L.table)) renderFeature(L, f); }
App.renderLayer = renderLayer;
App.redrawFeature = (table, fid) => { if (!App.viewer) return; const id = table + ':' + fid; const old = App.ents.get(id); if (old) for (const e of old) App.viewer.entities.remove(e); App.ents.delete(id); const L = App.GP && App.GP.layers.find(x => x.table === table); const f = L && App.GP.features(table).find(x => x.fid === fid); if (L && f) renderFeature(L, f); if (App.sel && App.sel.id === id) styleSel(id, true); };
App.refreshPlanFeatures = () => { const out = []; for (const L of App.GP.layers) { if (App.layerOn[L.table] === false) continue; for (const f of App.GP.features(L.table)) { const r = featRow(L, f); if (r) out.push(r); } } App.feats = out; const style = {}; for (const L of App.GP.layers) style[L.name] = App.styleOf(L.name).line; if (App.plan) App.plan.setFeatures(out, style); if (App.mmPlan) App.mmPlan.setFeatures(out, style); };
function featRow(L, f) { const g = f.geom; if (!g) return null; return { id: L.table + ':' + f.fid, table: L.table, layer: L.name, fid: f.fid, name: (f.attrs && (f.attrs.name || f.attrs.NAME)) || '', kind: geomKind(g.type), geom: g, attrs: f.attrs }; }
function rebuildPlanFeatures() { App.refreshPlanFeatures(); }
App.rebuildPlanFeatures = rebuildPlanFeatures;
function renderLayerPanel() { for (const L of App.GP.layers) if (!(L.table in App.layerOn)) App.layerOn[L.table] = true; const nObj = App.GP.layers.reduce((s, L) => s + L.count, 0); $('stat').textContent = App.gpkgLabel + ' · ' + nObj + ' объектов' + (App.noGlReason ? ' · 3D выключен: ' + App.noGlReason : ''); }

/* ━━━ выбор объекта + инспектор ━━━ */
function styleSel(id, on) { const ents = App.ents.get(id); if (!ents) return; const table = id.split(':')[0]; const base = Cesium.Color.fromCssColorString(App.styleOf(table).line); for (const e of ents) { if (e.polygon) e.polygon.outlineColor = on ? Cesium.Color.fromCssColorString('#ffb020') : base; if (e.polyline) e.polyline.material = on ? Cesium.Color.fromCssColorString('#ffb020') : base; if (e.point) e.point.color = on ? Cesium.Color.fromCssColorString('#ffb020') : base; } }
function select(rec) { if (App.sel && window.Editor) Editor.onBeforeDeselect(); if (App.sel) styleSel(App.sel.id, false); App.sel = rec || null; if (App.sel) { styleSel(App.sel.id, true); if (App.plan) App.plan.setSelected(App.sel.id); } else if (App.plan) App.plan.setSelected(null); if (window.Editor) Editor.onSelect(); }
export { select };
App.select = select;
/* Инспектор атрибутов (showInsp/renderAttrs) уехал в vector.js: разметки #insp в MVP нет,
 * и в рабочем модуле эти строки были бы мёртвым кодом, падающим на null-элементе. */

/* ━━━ пикап: 3D-сцена и 2D-план дают один и тот же выбор ━━━ */
function pickAt(position) { if (!App.viewer) return null; const mine = o => o && o.id && (o.id.gpk || o.id.editorHandle || o.id.editorMid) ? o.id : null; let ent = null; try { ent = mine(App.viewer.scene.pick(position)); } catch (e) {} if (!ent) { let deep = []; try { deep = App.viewer.scene.drillPick(position, 16) || []; } catch (e) {} for (const q of deep) { ent = mine(q); if (ent) break; } } return ent; }
App.pickAt = pickAt;
/* Пикап 3D-сцены вешается после того, как main.js создал Viewer: в момент импорта модуля
 * App.viewer ещё null, и проверка здесь (как это было в одном файле app.js) просто не сработала бы. */
export function wireScenePick() {
  if (!App.viewer) return;
  const pick3d = new Cesium.ScreenSpaceEventHandler(App.viewer.scene.canvas); pick3d.setInputAction(click => { if (window.Editor && Editor.onSceneClick(click.position)) return; const info = pickAt(click.position)?.gpk; if (!info) { select(null); return; } select({ table: info.table, fid: info.fid, id: info.table + ':' + info.fid, layer: info.layer, name: (info.attrs && (info.attrs.name || info.attrs.NAME)) || '', attrs: info.attrs, hasZ: info.hasZ, geom: geomOf(info.table, info.fid) }); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
function geomOf(table, fid) { const f = App.GP.features(table).find(x => x.fid === fid); return f ? f.geom : null; }
App.geomOf = geomOf;

/* ━━━ loadGpkg ━━━ */
async function loadGpkg(buf, label) { try { if (App.GP) for (const L of App.GP.layers) clearLayerEnts(L.table); App.GP = await gpkgOpen(initSqlJs, buf); App.gpkgLabel = label; renderLayerPanel(); for (const L of App.GP.layers) renderLayer(L); rebuildPlanFeatures(); fitBasemapDrop(); toast('объекты загружены: ' + App.GP.layers.reduce((n, L) => n + L.count, 0)); } catch (e) { document.body.classList.add('data-error'); $('stat').textContent = 'Не удалось прочитать объекты: ' + e.message; toast('объекты не загрузились; орто доступен'); } }
App.loadGpkg = loadGpkg;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
App.toast = toast;
