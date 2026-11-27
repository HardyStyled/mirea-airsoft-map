/* что здесь живёт: строка координат, линейка масштаба (scale.js), дебаг-панель, подписка postRender. */
/* readout.js — строка координат, линейка масштаба (scale.js), дебаг-панель и подписка postRender.
 * updateReadout() — чистая над планом, работает и без WebGL. Углы в дебаге заворачиваются в диапазон. */
import { App, syncFlyTouch } from './state.js?v=33';
import { scaleForMpp } from './scale.js?v=33';
import { FOV_DEFAULT } from './config.js?v=33';
import { $ } from './dom.js?v=33';

export function updateReadout() {
  const visible = App.plan && (document.body.classList.contains('split3d') ||
    document.body.classList.contains('pure2d') || App.noGl);
  if (!visible) return;
  $('planIn').disabled = !App.plan.canZoomBy(1 / 1.2);
  $('planOut').disabled = !App.plan.canZoomBy(1.2);
  const [lon, lat] = App.plan.center;
  $('roCoord').innerHTML = lat.toFixed(6) + ', <b>' + lon.toFixed(6) + '</b> · план';
  const scale = scaleForMpp(App.plan.mpp);
  const px = Math.round(scale.px);
  const bar = $('sbarBar');
  bar.style.width = px + 'px';
  bar.style.setProperty('--cell', (px / 2) + 'px');
  $('sbarVal').textContent = formatScale(scale.meters);
}

export function formatScale(meters) {
  if (meters >= 1000) return (meters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' км';
  if (meters >= 1) return meters.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' м';
  return (meters * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' см';
}

const dbgWatch = { frames: 0, at: 0, fps: 0 };

export function updateDbg() {
  if (!document.body.classList.contains('dbg') || App.noGl || !App.viewer) return;
  const now = performance.now();
  if (!dbgWatch.at) dbgWatch.at = now;
  else if (now - dbgWatch.at >= 1000) {
    dbgWatch.fps = Math.round(dbgWatch.frames * 1000 / (now - dbgWatch.at));
    dbgWatch.frames = 0; dbgWatch.at = now;
  }
  const cam = App.viewer.camera, cc = cam.positionCartographic, deg = Cesium.Math.toDegrees;
  $('dbgFps').textContent = dbgWatch.fps ? String(dbgWatch.fps) : '…';
  $('dbgCanvas').textContent = App.viewer.canvas.width + '×' + App.viewer.canvas.height + ' px · DPR ' +
    (window.devicePixelRatio || 1);
  $('dbgCam').textContent = deg(cc.latitude).toFixed(6) + ', ' + deg(cc.longitude).toFixed(6) +
    ' · +' + cc.height.toFixed(1) + ' м';
  const wrap = a => { let x = (a + 180) % 360; if (x < 0) x += 360; return x - 180; };
  $('dbgAngles').textContent = 'курс ' + ((deg(cam.heading) + 360) % 360).toFixed(0) +
    '° · наклон ' + wrap(deg(cam.pitch)).toFixed(0) + '° · крен ' + wrap(deg(cam.roll)).toFixed(0) + '°';
  $('dbgFov').textContent = cam.frustum.fov === undefined ? '—' : deg(cam.frustum.fov).toFixed(0) + '°';
}

/* Доглячик кадров и рекомендация по производительности живут в quality.js: отсюда только
   показания панелей. Два watchdog'а на одном postRender считали FPS дважды и показывали
   одинаковую подсказку двумя разными обработчиками (#perfClose был перезаписан). */

export function updateCameraState(state) {
  document.body.dataset.cameraMode = state.mode;
  $('flyRun').classList.toggle('on', state.run);
  $('flyRun').setAttribute('aria-pressed', String(state.run));
  const fly = state.mode === 'fly';
  syncFlyTouch();                               // класс панели полёта считает state.js (одна предиката)
  $('speedTag').hidden = !fly || state.touch || App.mode !== '3d';
  $('speedValue').textContent = (state.speed < 10 ? state.speed.toFixed(1) : String(Math.round(state.speed))) + ' м/с';
  if (!App.booted) return;
  App.syncMenus();
  App.updateFabTips();
}

export const DBG_KEY = 'mam.dbg';
export function setDbg(on) {
  document.body.classList.toggle('dbg', on);
  try { localStorage.setItem(DBG_KEY, on ? '1' : '0'); } catch (e) {}
  App.syncItem('miDbg', on);
  dbgWatch.frames = 0; dbgWatch.at = performance.now();
}
try { if (localStorage.getItem(DBG_KEY) === '1') setDbg(true); } catch (e) {}
$('miDbg').onclick = () => { setDbg(!document.body.classList.contains('dbg')); };
