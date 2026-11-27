/* что здесь живёт: сборка приложения — создание Viewer'а, порядок старта и связывание модулей. */
/* main.js — точка входа (D1). Единственный модуль, который создаёт Cesium.Viewer и знает про
 * весь кадр. Порядок старта важнее содержания: 3D-модель поднимается первой, потому что без неё
 * половина экрана пустая и всё остальное не важно (регресс 26.11 «3Д МОДЕЛЕЙ НЕТ»).
 * Камера: здесь её никто не пишет — только создаётся контроллер (src/camera/, ADR-34). */
import { $ } from './dom.js?v=33';
import { App, on, setMode, setView, applyViewClasses, applyZoomLimits, syncFlyTouch } from './state.js?v=33';
import { hasWebGL, NO_GL, markNoGl, degradeTo2D, noGlNotice, retry3D, takeRetryView } from './gl.js?v=33';
import {
  EXTENT, SITE_CENTER, Q, TILES_Q, makeProvider, BASEMAP_SSE, FOV_DEFAULT, FOV_KEY, VIEW_KEY,
  MAX_VIEW_M, ASSET_CFG, HOME_POSE, SHOW_VECTOR_LAYERS, homePosition,
} from './config.js?v=33';
import { applyQuality, updateQualityButtons, startWatchdog } from './quality.js?v=33';
import { wireFab, wireMenuItems, closeMenus, syncMenus, syncItem, updateFabTips } from './menus.js?v=33';
import { bindStick, wireFlyRun } from './touchControls.js?v=33';
import {
  toggleAsset, updateAssetButtons, syncGlobeVisibility, applyBasemapDrop,
  startChunkWatch, clearChunkLoading, assetChoiceState,
} from './assets.js?v=33';
import { ensurePanels, syncPlans, onViewRay, invalidateRay, select, wireScenePick, pickCollision } from './plans.js?v=33';
import { updateReadout, updateDbg, updateCameraState } from './readout.js?v=33';
import { offerWelcome, tutSeen } from './tutorial.js?v=33';
import { updateWindHeading } from './weather.js?v=33';
import { setBase, baseState } from './basemap.js?v=33';
import { Collision } from './collision.js?v=33';
import { createController } from './camera/controller.js?v=33';
import { planMarker } from './planMarker.js?v=33';

window.CESIUM_BASE_URL = './vendor/cesium/';
Cesium.Ion.defaultAccessToken = undefined;      // публичный MVP без Ion-аккаунта (ADR-27)

let toastTimer = 0;
function toast(text) {
  const box = $('toast');
  if (box.classList.contains('show') && box.textContent === text) return;
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 8000);
}
App.toast = toast;
const reportedErrors = new Set();
function reportError(text) {
  if (reportedErrors.has(text)) return;
  reportedErrors.add(text);
  toast(text);
}
addEventListener('error', e => { console.error(e); reportError('ошибка: ' + (e.message || e.error)); });
addEventListener('unhandledrejection', e => { console.error(e); reportError('сбой: ' + (e.reason && e.reason.message || e.reason)); });
App.withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + (ms / 1000) + ' с')), ms))]);
App.Q = Q;

/* Мост для модулей, которым нужно действие, живущее в другом месте (gl.js → setMode,
 * readout.js → галочки меню, plans.js → снятие выделения). Присваиваем сразу после импортов:
 * загрузчик ниже вызывает их асинхронно, и в конце файла эти поля появились бы уже «после». */
Object.assign(App, {
  setMode, setView, retry3D, syncMenus, syncItem, updateFabTips, updateAssetButtons, syncGlobeVisibility,
  assetChoiceState, clearChunkLoading, updateDbg, select, toggleAsset,
  homeView: () => App.CAM && App.CAM.setPose(HOME_POSE),
});

/* ——— Viewer: если 3D недоступен, приложение не падает, а остаётся 2D-планом (T15) ——— */
// ?nogl=1 проверяет этот путь на машине, где 3D исправен: деградация должна быть одинаковой.
if (Q.has('nogl')) markNoGl('3D выключен флагом ?nogl=1');
else if (!hasWebGL()) markNoGl('браузер не дал WebGL (включи аппаратное ускорение в настройках Chrome)');
let viewer = null;
if (!NO_GL) {
  try {
    viewer = new Cesium.Viewer($('map'), {
      baseLayer: new Cesium.ImageryLayer(makeProvider()),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(), shouldAnimate: false, showRenderLoopErrors: false,
    });
  } catch (e) {
    markNoGl('Cesium не смог создать WebGL-контекст: ' + (e.message || e));
  }
}
App.viewer = viewer;

if (viewer) {
  const scene = viewer.scene;
  /* Штатный ввод Cesium выключен совсем: писатель камеры один — rig (ADR-34). Иначе мышь и тач
   * утаскивают камеру в обход инвариантов, и координаты перезаписываются наполовину. */
  scene.screenSpaceCameraController.enableInputs = false;
  scene.globe.maximumScreenSpaceError = BASEMAP_SSE;
  applyQuality();
  /* Небесная обвязка опциональна: в сборке Cesium без какого-то из слоёв присваивание
     undefined.show роняет весь старт 3D (архив монолита это берег, порт это потерял). */
  if (scene.atmosphere) scene.atmosphere.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#04060a');
  /* Свет со стороны участка, а не дефолтное солнце по часам: IBL/GGX-материалы 1.147 на
   * направленном свете дают ровный кадр без оранжевых засветок на горизонте. */
  try {
    const lightDir = Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(SITE_CENTER, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    scene.light = new Cesium.DirectionalLight({ direction: lightDir });
  } catch (e) { /* сборка без DirectionalLight — оставляем штатный свет */ }
  scene.fog.enabled = false; scene.highDynamicRange = false;
  /* fxaa живёт в postProcessStages: у Scene такого свойства нет, и присваивание роняет весь старт
     3D (проверено на браузере без WebGL: конструктор Cesium доживает до этой строки). msaaSamples в
     части сборок только для чтения — отсюда try/catch. */
  scene.postProcessStages.fxaa.enabled = false;
  try { scene.msaaSamples = 1; } catch (e) { /* свойство только для чтения */ }
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0d12');
  startWatchdog();
}

/* Cesium отваливается и уже в процессе рендера (сбой шейдеров, потеря контекста). Его английский
 * диалог плюс чёрная половина экрана — тупик: убираем диалог и переходим в 2D-режим (T15). */
if (viewer) viewer.scene.renderError.addEventListener((scene, message) => {
  const why = String(message || '').split('\n')[0].slice(0, 140);
  degradeTo2D('браузер не смог отрисовать сцену' + (why ? ': ' + why : ''));
});
if (viewer) viewer.canvas.addEventListener('webglcontextlost', () => {
  degradeTo2D('браузер потерял WebGL-контекст');
}, { once: true });
// ?failrender=1 прогоняет этот путь на машинах, где 3D исправен: проверяем деградацию, а не удачу
if (viewer && Q.has('failrender')) setTimeout(() => viewer.scene.renderError.raiseEvent(viewer.scene, 'проверка'), 900);

/* ——— камера: единственный писатель + весь ввод (SPEC-camera-rig, ADR-34) ——— */
if (viewer) {
  planMarker.attach(viewer);
  App.CAM = createController({
    Cesium, viewer, pickCollision, extent: EXTENT, target: homePosition(), maxDistance: MAX_VIEW_M, initialOrbitDistance: 12,
    isActive: () => App.mode === '3d' && !NO_GL,
    touchOnly: () => App.CAMERA_TOUCH,
    reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    // любое дискретное состояние rig'а (сброс вида, смена режима, тач) — луч плана устаревает сразу,
    // без ожидания camera.changed, который на короткие сдвиги может и не сработать
    // состояние rig'а приходит аргументом: по нему readout ставит data-camera-mode (от него
    // зависят панели полёта на таче), скорость и синхронизацию меню
    onState: st => { updateCameraState(st); invalidateRay(); },
    onMessage: toast,
    // 1/2/3 на клавиатуре — тот же ряд, что и пункты меню вида (значки 1·2·3 в меню)
    onViewKey: n => {
      closeMenus();
      setView(n === 3 ? '2d' : '3d', n === 2);
      (n === 3 ? $('plan') : viewer.canvas).focus({ preventScroll: true });
    },
  });
  App.camLock = on => App.CAM.setLocked(on);
  App.CAM.homePose(HOME_POSE);
  App.CAM.setPose(HOME_POSE);              // стартовый вид: точка на уровне глаз у северо-восточного края
  applyZoomLimits();
  wireScenePick();                         // выбор объектов в 3D: обработчик нужен после Viewer'а
}

/* ——— угол обзора: слайдер FOV (режим «Полёт» шире — иначе упираешься в стену) ——— */
/* FOV (I6): контрол живёт только там, где есть 3D-камера, и в покое гаснет, чтобы не мешать
 * взгляду; подсвечивается на касание/наведение/фокус и через 2,2 с снова уходит. Поведение
 * перенесено из app.js без изменений — классы off/hot описаны в controls.css. */
let fovIdleTimer = 0;
function fovPulse() {
  const ctl = $('fovCtl');
  ctl.classList.add('hot');
  if (fovIdleTimer) clearTimeout(fovIdleTimer);
  fovIdleTimer = setTimeout(() => ctl.classList.remove('hot'), 2200);
}
const lensPanel = $('lensPanel'), lensToggle = $('lensToggle');
const lensPresets = [...$('lensTools').querySelectorAll('[data-zoom]')];
const zoomFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const normalLens = Math.tan(Cesium.Math.toRadians(FOV_DEFAULT) / 2);
const degreesForZoom = zoom => Math.round(Cesium.Math.toDegrees(2 * Math.atan(normalLens / zoom)));

function setFov(deg) {
  const f = Cesium.Math.toRadians(deg);
  if (viewer && viewer.camera.frustum.fov !== undefined) { viewer.camera.frustum.fov = f; applyZoomLimits(); }
  if (App.plan) App.plan.fovRad = f;
  if (App.mmPlan) App.mmPlan.fovRad = f;
  $('fovVal').textContent = deg + '°';
  $('fovSl').value = $('lensRange').value = deg;
  const preset = lensPresets.find(button => degreesForZoom(+button.dataset.zoom) === deg);
  const zoom = preset?.textContent || zoomFormat.format(normalLens / Math.tan(f / 2)) + '×';
  lensToggle.dataset.currentZoom = zoom;
  lensToggle.toggleAttribute('data-custom', !preset);
  labelLens();
  $('lensDegrees').value = deg + '°';
  $('lensRange').setAttribute('aria-valuetext', deg + '°, ' + zoom);
  for (const button of lensPresets) {
    button.setAttribute('aria-pressed', String(button === preset));
  }
  fovPulse();
}

function changeFov(deg) {
  setFov(deg);
  try { localStorage.setItem(FOV_KEY, String(deg)); } catch {}
}
function labelLens() {
  const zoom = lensToggle.dataset.currentZoom || '1×';
  lensToggle.textContent = !lensPanel.hidden ? '✓' : lensToggle.hasAttribute('data-custom') ? zoom : '⋯';
  lensToggle.title = lensPanel.hidden ? 'Точная настройка увеличения' : 'Закрыть точную настройку';
  lensToggle.setAttribute('aria-label', lensToggle.title + ', ' + zoom);
}
function openLens(open) {
  lensPanel.hidden = !open;
  lensToggle.setAttribute('aria-expanded', String(open));
  labelLens();
}
function closeLens() {
  openLens(false);
  lensToggle.focus({ preventScroll: true });
}
lensToggle.onclick = () => {
  if (!lensPanel.hidden) { closeLens(); return; }
  openLens(true);
  $('lensRange').focus({ preventScroll: true });
};
for (const button of lensPresets) button.onclick = () => {
  changeFov(degreesForZoom(+button.dataset.zoom));
};
const dismissLens = e => {
  if (!lensPanel.hidden && !lensPanel.contains(e.target) && !lensToggle.contains(e.target)) openLens(false);
};
document.addEventListener('pointerdown', dismissLens, true);
document.addEventListener('focusin', dismissLens);
$('viewDock').addEventListener('keydown', e => {
  if (lensPanel.hidden) return;
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeLens(); }
});
addEventListener('resize', () => { if (!lensToggle.getClientRects().length) openLens(false); });
function updateFovCtl() {
  const on = !!viewer && !NO_GL && App.mode === '3d';
  $('fovCtl').classList.toggle('off', !on);
  lensToggle.disabled = !on;
  for (const button of lensPresets) button.disabled = !on;
  openLens(false);
  if (!on) $('fovCtl').classList.remove('hot');
}
$('fovSl').oninput = $('lensRange').oninput = e => changeFov(+e.target.value);
$('fovSl').addEventListener('pointerdown', fovPulse);
$('fovSl').addEventListener('focus', fovPulse);
$('fovCtl').addEventListener('pointerenter', fovPulse);
// Cesium создаёт новую перспективную проекцию при возврате из 2D.
viewer?.scene.morphComplete.addEventListener(() => {
  if (App.mode === '3d') setFov(Number($('fovSl').value));
});

/* ——— связывание модулей: действия строк меню вешает menus.js, здесь только вход ——— */
wireFab();
wireMenuItems();
bindStick();
wireFlyRun();
onViewRay();
const retry = takeRetryView();
let pendingPlan = retry;
on('mode', () => {
  if (pendingPlan && (App.mode === '2d' || App.split)) {
    // После resize(): первичное вписывание невидимого плана отложено до его появления.
    App.plan.setView(...pendingPlan.center, pendingPlan.mpp);
    pendingPlan = null;
  }
  syncFlyTouch();
  syncMenus();
  updateFabTips();
  updateQualityButtons();
  updateFovCtl();
  updateReadout();
});

/* Кадр: планы перерисовываются в 3D (в 2D они и есть экран), счётчик кадров нужен плану,
 * чтобы не перерисовываться чаще сцены. */
App.frames = 0;
if (viewer) {
  viewer.scene.postRender.addEventListener(() => {
    App.frames++;
    if (!App.booted) return;
    if (App.mode === '3d') {
      syncPlans();
      updateWindHeading();
    }
    updateReadout();
    if (document.body.classList.contains('dbg')) updateDbg();
  });
  /* луч плана кэшируется; сбрасываем кэш, когда камера сдвинулась достаточно, чтобы луч
   * упёрся в другое место (SPEC §12: invalidateRay на camera.changed) */
  viewer.camera.percentageChanged = 0.01;
  viewer.camera.changed.addEventListener(() => invalidateRay());
}

const ro = new ResizeObserver(() => {
  if (viewer && !NO_GL) viewer.resize();
  if (App.plan) App.plan.resize();
  if (App.mmPlan) App.mmPlan.resize();
  updateReadout();
});
for (const id of ['map', 'plan', 'mm']) if ($(id)) ro.observe($(id));
addEventListener('resize', () => { updateReadout(); });

/* ——— старт. Публичный MVP самодостаточен: внешний GPKG не запрашивается (ADR-27). ——— */
async function fetchArrayBuffer(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}
const ready = (async () => {
  App.booted = true;                          // объявления выше по файлу живы — можно рисовать UI
  let savedFov = FOV_DEFAULT;
  try { const s = +localStorage.getItem(FOV_KEY); if (s >= 30 && s <= 120) savedFov = s; } catch (e) {}
  $('fovSl').value = savedFov;
  setFov(savedFov);
  /* Раскладка переживает перезагрузку: режим и сплит возвращаются из хранилища (после разнесения
   * модулей запись осталась, а чтение потерялось — телефон каждый раз открывал «Только 3D»).
   * Без WebGL 3D не возвращаем: там единственный живой режим — план.
   * «Только план» возвращается только если эту вкладку уже перегружали: новая встреча с сайтом
   * обязана открываться в 3D со сплатами (ADR-37, требование владельца 27.11). */
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY));
    const s = JSON.parse(sessionStorage.getItem(VIEW_KEY));
    if (v && (v.mode === '2d' || v.mode === '3d')) {
      if (v.mode === '2d' && !(s && s.mode === '2d')) { App.mode = '3d'; App.split = false; }
      else { App.mode = v.mode; App.split = !!v.split; }
    }
  } catch (e) {}
  if (retry) { App.mode = '3d'; App.split = retry.split; }
  if (NO_GL) App.mode = '2d';
  ensurePanels();
  if (App.mode === '2d') setMode('2d');
  else applyViewClasses();
  if (NO_GL) noGlNotice();
  if (SHOW_VECTOR_LAYERS) {
    try {
      const buf = await fetchArrayBuffer('../map/tactical.gpkg', 10000);
      await App.loadGpkg(buf, 'map/tactical.gpkg');
    } catch (e) {
      document.body.classList.add('data-error');
      $('stat').textContent = 'Не удалось загрузить объекты полигона: ' + e.message;
    }
  }
  if (retry?.base === 'ortho') await setBase('ortho');
  else if (TILES_Q === 'qgis') await setBase('qgis');
  else if (TILES_Q) await setBase('qgis', [TILES_Q.replace(/\/?$/, '/')]);
  updateReadout();
  if (NO_GL) return;

  applyBasemapDrop();
  for (const [slot, cfg] of Object.entries(ASSET_CFG)) {
    const row = $(cfg.row);
    if (Q.has(cfg.flag)) {
      row.disabled = true;
      row.title = cfg.label + ': отключён флагом ?' + cfg.flag;
    } else {
      row.disabled = NO_GL;
      row.title = NO_GL ? '3D недоступен: нет WebGL' : cfg.title;
    }
  }
  /* По умолчанию поднимается gaussian splatting — прямое требование владельца 27.11. 3D Tiles-модель
   * остаётся в меню «Актив» и грузается по тапу; на слабом железе это плюс: одна тяжёлая загрузка
   * вместо двух. ?nosplat оставляет сцену со штатной моделью, ?nomodel + ?nosplat — только подложку.
   * Если сплат не поднялся (нет файла, оборвалась сеть, не потянул GPU) сцена не должна оставаться
   * пустой: автоматически поднимаем модель — но только если за время загрузки ничего не выбрали. */
  const useModelOnRetry = retry?.useModel && !Q.has('nomodel');
  if (!Q.has('nosplat') && !useModelOnRetry) {
    const loading = toggleAsset('splats');
    const choice = App.assetChoice;
    await loading;
    const up = !!(App.viewer.splats && App.viewer.splats.show);
    if (!up && choice === App.assetChoice && !Q.has('nomodel')) await toggleAsset('tileset');
  } else if (!Q.has('nomodel')) await toggleAsset('tileset');
  else syncGlobeVisibility();
  if (NO_GL) return;
  /* печная сетка коллизии (ADR-13/33): 221 КБ, нужна лучу плана; отсутствие не ломает
   * приложение — без неё rayEnd откатывается на старую отсечку (collision.js: error).
   * В try/catch и после модели: отказ сети на мобильном обрывал загрузчик посередине,
   * и 3D-модель не создавалась вовсе (регресс 26.11, «3Д МОДЕЛЕЙ НЕТ»). */
  if (!Q.has('nocol')) {
    try { await Collision.load('./collision/collision.json', './collision/collision.bin'); }
    catch (e) { console.warn('Не удалось загрузить сетку коллизии', e); }
  }
  if (NO_GL) return;
  startChunkWatch();
  baseState();
  syncMenus();
  updateFabTips();
  syncFlyTouch();
  updateFovCtl();                 // в 2D и без WebGL контрол FOV скрыт сразу, а не после первого кадра
})();
if (!NO_GL && !retry && !Q.has('failrender') && !tutSeen()) offerWelcome(ready);
