/* что здесь живёт: сборка приложения — создание Viewer'а, порядок старта и связывание модулей. */
/* main.js — точка входа (D1). Единственный модуль, который создаёт Cesium.Viewer и знает про
 * весь кадр. Порядок старта важнее содержания: 3D-модель поднимается первой, потому что без неё
 * половина экрана пустая и всё остальное не важно (регресс 26.11 «3Д МОДЕЛЕЙ НЕТ»).
 * Камера: здесь её никто не пишет — только создаётся контроллер (src/camera/, ADR-34). */
import { $ } from './dom.js?v=16';
import { App, on, setMode, setView, applyViewClasses, applyZoomLimits, syncFlyTouch } from './state.js?v=16';
import { hasWebGL, NO_GL, markNoGl, degradeTo2D, noGlNotice } from './gl.js?v=16';
import {
  EXTENT, SITE_CENTER, Q, TILES_Q, makeProvider, BASEMAP_SSE, FOV_DEFAULT, FOV_KEY, VIEW_KEY,
  MAX_VIEW_M, ASSET_CFG, HOME_POSE, SHOW_VECTOR_LAYERS, homePosition,
} from './config.js?v=16';
import { applyQuality, updateQualityButtons, startWatchdog } from './quality.js?v=16';
import { wireFab, wireMenuItems, syncMenus, syncItem, updateFabTips } from './menus.js?v=16';
import { bindStick, wireFlyRun } from './touchControls.js?v=16';
import {
  toggleAsset, updateAssetButtons, syncGlobeVisibility, applyBasemapDrop,
  startChunkWatch, clearChunkLoading, assetChoiceState,
} from './assets.js?v=16';
import { ensurePanels, syncPlans, onViewRay, invalidateRay, select, wireScenePick } from './plans.js?v=16';
import { updateReadout, updateDbg, updateCameraState } from './readout.js?v=16';
import { tutShow, tutSeen } from './tutorial.js?v=16';
import { setBase, baseState } from './basemap.js?v=16';
import { Collision } from './collision.js?v=16';
import { createController } from './camera/controller.js?v=16';

window.CESIUM_BASE_URL = './vendor/cesium/';
Cesium.Ion.defaultAccessToken = undefined;      // публичный MVP без Ion-аккаунта (ADR-27)

let toastTimer = 0;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 4000);
}
App.toast = toast;
addEventListener('error', e => { console.error(e); toast('ошибка: ' + (e.message || e.error)); });
addEventListener('unhandledrejection', e => { console.error(e); toast('сбой: ' + (e.reason && e.reason.message || e.reason)); });
App.withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + (ms / 1000) + ' с')), ms))]);
App.Q = Q;

/* Мост для модулей, которым нужно действие, живущее в другом месте (gl.js → setMode,
 * readout.js → галочки меню, plans.js → снятие выделения). Присваиваем сразу после импортов:
 * загрузчик ниже вызывает их асинхронно, и в конце файла эти поля появились бы уже «после». */
Object.assign(App, {
  setMode, setView, syncMenus, syncItem, updateFabTips, updateAssetButtons, syncGlobeVisibility,
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
      terrainProvider: new Cesium.EllipsoidTerrainProvider(), shouldAnimate: false,
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
  const panel = document.querySelector('.cesium-widget-errorPanel');
  if (panel) panel.remove();                 // показываем своё объяснение по-русски, а не диалог Cesium
  const why = String(message || '').split('\n')[0].slice(0, 140);
  degradeTo2D('браузер не смог отрисовать сцену' + (why ? ': ' + why : ''));   // «Rendering has stopped» — второй попытки не будет
});
// ?failrender=1 прогоняет этот путь на машинах, где 3D исправен: проверяем деградацию, а не удачу
if (viewer && Q.has('failrender')) setTimeout(() => viewer.scene.renderError.raiseEvent(viewer.scene, 'проверка'), 900);

/* ——— камера: единственный писатель + весь ввод (SPEC-camera-rig, ADR-34) ——— */
if (viewer) {
  App.CAM = createController({
    Cesium, viewer, extent: EXTENT, target: homePosition(), maxDistance: MAX_VIEW_M,
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
    onViewKey: n => setView(n === 3 ? '2d' : '3d', n === 2),
  });
  App.camLock = on => App.CAM.setLocked(on);
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
function setFov(deg, fromSlider) {
  const f = Cesium.Math.toRadians(deg);
  if (viewer && viewer.camera.frustum.fov !== undefined) { viewer.camera.frustum.fov = f; applyZoomLimits(); }
  if (App.plan) App.plan.fovRad = f;
  if (App.mmPlan) App.mmPlan.fovRad = f;
  $('fovVal').textContent = deg + '°';
  if (!fromSlider) $('fovSl').value = deg;
  fovPulse();
}
function updateFovCtl() {
  const on = !!viewer && !NO_GL && App.mode === '3d';
  $('fovCtl').classList.toggle('off', !on);
  if (!on) $('fovCtl').classList.remove('hot');
}
$('fovSl').oninput = e => { setFov(+e.target.value, true); try { localStorage.setItem(FOV_KEY, String(+$('fovSl').value)); } catch (e) {} };
$('fovSl').addEventListener('pointerdown', fovPulse);
$('fovSl').addEventListener('focus', fovPulse);
$('fovCtl').addEventListener('pointerenter', fovPulse);

/* ——— связывание модулей: действия строк меню вешает menus.js, здесь только вход ——— */
wireFab();
wireMenuItems();
bindStick();
wireFlyRun();
onViewRay();
on('mode', () => { syncFlyTouch(); updateQualityButtons(); updateFovCtl(); });

/* Кадр: планы перерисовываются в 3D (в 2D они и есть экран), счётчик кадров нужен плану,
 * чтобы не перерисовываться чаще сцены. */
App.frames = 0;
if (viewer) {
  viewer.scene.postRender.addEventListener(() => {
    App.frames++;
    if (!App.booted) return;
    if (App.mode === '3d') syncPlans();
    updateReadout();
    if (document.body.classList.contains('dbg')) updateDbg();
  });
  /* луч плана кэшируется; сбрасываем кэш, когда камера сдвинулась достаточно, чтобы луч
   * упёрся в другое место (SPEC §12: invalidateRay на camera.changed) */
  viewer.camera.percentageChanged = 0.01;
  viewer.camera.changed.addEventListener(() => invalidateRay());
}

const ro = new ResizeObserver(() => {
  if (viewer) viewer.resize();
  if (App.plan) App.plan.resize();
  if (App.mmPlan) App.mmPlan.resize();
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
(async () => {
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
  if (NO_GL) App.mode = '2d';
  ensurePanels();
  applyViewClasses();
  if (App.mode === '2d' && viewer) setMode('2d');       // возвращённый с сохранённого вид
  if (NO_GL) {
    noGlNotice();
    setMode('2d');
    const why = 'нужен WebGL: включи аппаратное ускорение в браузере';
    for (const id of ['mi3d', 'miSplit', 'miOrbit', 'miFly', 'miHome', 'miAssetModel', 'miAssetSplat',
                      'miQLow', 'miQMid', 'miQHigh', 'miDbg']) {
      $(id).disabled = true;
      $(id).title = why;
    }
  }
  if (SHOW_VECTOR_LAYERS) {
    try {
      const buf = await fetchArrayBuffer('../map/tactical.gpkg', 10000);
      await App.loadGpkg(buf, 'map/tactical.gpkg');
    } catch (e) {
      document.body.classList.add('data-error');
      $('stat').textContent = 'Не удалось загрузить объекты полигона: ' + e.message;
      toast('объекты не загрузились; орто доступен');
    }
  }
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
  if (!Q.has('nosplat')) {
    const choice = App.assetChoice;
    await toggleAsset('splats');
    const up = !!(App.viewer.splats && App.viewer.splats.show);
    if (!up && choice === App.assetChoice && !Q.has('nomodel')) await toggleAsset('tileset');
  } else if (!Q.has('nomodel')) await toggleAsset('tileset');
  else syncGlobeVisibility();
  /* печная сетка коллизии (ADR-13/33): 221 КБ, нужна лучу плана; отсутствие не ломает
   * приложение — без неё rayEnd откатывается на старую отсечку (collision.js: error).
   * В try/catch и после модели: отказ сети на мобильном обрывал загрузчик посередине,
   * и 3D-модель не создавалась вовсе (регресс 26.11, «3Д МОДЕЛЕЙ НЕТ»). */
  if (!Q.has('nocol')) {
    try { await Collision.load('./collision/collision.json', './collision/collision.bin'); }
    catch (e) { toast('сетка коллизии не загрузилась: ' + e.message); }
  }
  if (TILES_Q === 'qgis') await setBase('qgis');
  else if (TILES_Q) await setBase('qgis', [TILES_Q.replace(/\/?$/, '/')]);
  startChunkWatch();
  baseState();
  syncMenus();
  updateFabTips();
  syncFlyTouch();
  updateFovCtl();                 // в 2D и без WebGL контрол FOV скрыт сразу, а не после первого кадра
  if (!tutSeen()) tutShow();
})();
