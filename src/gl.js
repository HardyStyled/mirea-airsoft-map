/* что здесь живёт: проверка WebGL, деградация в 2D, уведомление о деградации. */
/* gl.js — проверка WebGL, перевод в 2D-режим без 3D и уведомление о деградации (§4). */
import { App } from './state.js?v=15';
import { $ } from './dom.js?v=15';

export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) { return false; }
}

export let NO_GL = false;

/* 3D выключается не только по probe WebGL: Cesium умеет отвалиться и в конструкторе Viewer'а
   (нет контекста, не скомпилировался шейдер). NO_GL — внутренняя переменная модуля, поэтому
   переключает её этот сеттер, а не main.js. */
export function markNoGl(reason) {
  NO_GL = true;
  App.noGl = true;
  if (reason) App.noGlReason = reason;
  document.body.classList.add('nogl');
}

export function degradeTo2D(why) {
  if (NO_GL) return;
  NO_GL = true; App.noGl = true;
  if (App.viewer) App.viewer.useDefaultRenderLoop = false;
  App.clearChunkLoading();
  App.hidePerfNotice();
  document.body.classList.add('nogl');
  for (const id of ['mi3d', 'miSplit', 'miOrbit', 'miFly', 'miHome', 'miAssetModel', 'miAssetSplat',
                    'miQLow', 'miQMid', 'miQHigh', 'miDbg']) {
    const b = $(id);
    b.disabled = true;
    b.title = why;
  }
  App.CAM && App.CAM.captureFor2D();
  App.setMode('2d');
  App.noGlReason = why;
  $('stat').textContent = '3D выключен: ' + why + '. Работает 2D-план и выбор объектов';
  App.toast('3D недоступен: ' + why);
}

export function noGlNotice() {
  App.noGlReason = App.noGlReason || 'браузер не дал WebGL (включи аппаратное ускорение в настройках Chrome)';
  $('stat').textContent = '2D без 3D: ' + App.noGlReason;
  App.toast('3D недоступен. Можно смотреть и масштабировать 2D-план');
}
