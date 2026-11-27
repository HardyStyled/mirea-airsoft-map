/* что здесь живёт: шина событий hooks/on/emit, общее состояние App и переключение режимов вида. */
/* state.js — шина событий hooks/on/emit, общее состояние App и переключение режимов вида.
 * Любой межмодульный вызов идёт через emit, а не прямым импортом функции (§1). */
import { GPK_STYLE, VIEW_KEY, FOV_DEFAULT, MAX_VIEW_M, CAMERA_TOUCH } from './config.js?v=33';
import { $ } from './dom.js?v=33';

export const hooks = { view: new Set(), mode: new Set(), camera: new Set(), quality: new Set() };
export function on(hook, fn) { hooks[hook].add(fn); return () => hooks[hook].delete(fn); }
export function emit(hook, payload) { for (const fn of hooks[hook]) fn(payload); }

export const MODES = { '3d': Cesium.SceneMode.SCENE3D, '2d': Cesium.SceneMode.SCENE2D };

export const App = {
  viewer: null, plan: null, GP: null,
  ents: new Map(),
  layerOn: Object.create(null),
  sel: null,
  tool: 'sel', mode: '3d',
  feats: [],
  styleOf: t => GPK_STYLE[t] || { line: '#99aabc' },
  toast: () => {},
  split: false,
  booted: false,
  noGl: false,
  noGlReason: null,
  CAM: null,
  camLock: null,
  refreshPlanFeatures: () => {},
  resetFpsWatch: () => {},
  clearChunkLoading: () => {},
  hidePerfNotice: () => {},
  assetChoice: 0,
  baseName: 'qgis',
  qualityMode: 'normal',
  syncItem: () => {},
  syncMenus: () => {},
  setFabTip: () => {},
  updateFabTips: () => {},
  updateAssetButtons: () => {},
  syncGlobeVisibility: () => {},
  applyBasemapDrop: () => {},
  withTimeout: () => {},
  setDbg: () => {},
  updateDbg: () => {},
  CAMERA_TOUCH,
  applyViewClasses: () => {},
};
window.App = App;      // кадр приложения в консоли и в тестах: как это было в app.js

function saveViewPrefs() {
  const v = JSON.stringify({ mode: App.mode, split: App.split });
  try { localStorage.setItem(VIEW_KEY, v); } catch (e) {}
  /* вторая копия — на уровень вкладки: «Только план» должен переживать перезагрузку, но не новую
   * встречу с сайтом. По умолчанию приложение открывается в 3D со сплатами (ADR-37). */
  try { sessionStorage.setItem(VIEW_KEY, v); } catch (e) {}
}

export function applyZoomLimits() {
  if (!App.viewer) return;
  const c = App.viewer.scene.screenSpaceCameraController;
  if (!c) return;
  const fov = (App.viewer.camera.frustum && App.viewer.camera.frustum.fov) || Cesium.Math.toRadians(FOV_DEFAULT);
  c.maximumZoomDistance = MAX_VIEW_M / (2 * Math.tan(fov / 2));
  c.minimumZoomDistance = 0.6;
}
App.applyZoomLimits = applyZoomLimits;

/* Класс flytouch включает стики и кнопки полёта. Предиката одна: полёт + тач + 3D + живой WebGL.
   Зовут её и смена вида, и каждое изменение состояния камеры: три копии предикаты рано или поздно
   расходятся, а по этому классу телефон решает, показывать ли панель полёта. */
export function syncFlyTouch() {
  const on = (document.body.dataset.cameraMode || 'orbit') === 'fly' && CAMERA_TOUCH && App.mode === '3d' && !App.noGl;
  document.body.classList.toggle('flytouch', on);
}

export function applyViewClasses() {
  if (!App.booted) return;                       // страховка TDZ — до конца загрузки нет побочных эффектов
  document.body.classList.toggle('split3d', App.mode === '3d' && App.split && !App.noGl);
  document.body.classList.toggle('pure2d', App.mode === '2d');
  document.body.classList.toggle('full3d', App.mode === '3d' && !App.split && !App.noGl);
  syncFlyTouch();
  if (App.mode === '2d' && App.plan?.cam) App.plan.setCamera(null);
  if (App.plan) App.plan.resize();
  if (App.viewer && !App.noGl) App.viewer.resize();
  $('miHome').disabled = App.noGl || App.mode !== '3d';
  $('fovSl').disabled = App.noGl;
  emit('view');
  emit('mode');
  if (!App.noGl) saveViewPrefs();
}
App.applyViewClasses = applyViewClasses;

export function setMode(m) {
  if (App.noGl) { m = '2d'; }
  App.resetFpsWatch();
  const previous = App.mode;
  if (m === '2d' && previous === '3d' && App.CAM) App.CAM.captureFor2D();
  if (m === '2d') {
    App.assetChoice++;                           // отложенная загрузка ресурса не включается поверх 2D
    App.hidePerfNotice();
  }
  App.mode = m;
  applyViewClasses();
  if (App.viewer && !App.noGl) {
    App.viewer.scene.mode = MODES[m];
    if (m === '3d') {
      if (previous === '2d' && App.CAM) App.CAM.restoreFrom2D();
      else if (App.CAM) App.CAM.setEnabled(true);
    }
  }
}

export function setView(mode, split) {
  if (App.noGl && mode === '3d') { App.retry3D(!!split); return; }
  if (mode === '3d' && split !== null) App.split = split;
  setMode(mode);
}
