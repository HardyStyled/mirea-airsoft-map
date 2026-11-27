/* что здесь живёт: проверка WebGL, деградация в 2D, уведомление о деградации. */
/* gl.js — проверка WebGL, перевод в 2D-режим без 3D и уведомление о деградации (§4). */
import { App } from './state.js?v=33';
import { $ } from './dom.js?v=33';
import { tutHide } from './tutorial.js?v=33';

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
let retryWithModel = false;

// Только явный выбор вида пересоздаёт Viewer. Снимок принадлежит текущей записи истории вкладки.
export function retry3D(split) {
  if (!NO_GL || history.state?.mapRetry) return;
  const { center, mpp } = App.plan;
  const url = new URL(location.href);
  url.searchParams.delete('nogl');
  url.searchParams.delete('failrender');
  const mapRetry = { split, center, mpp, base: App.baseName, useModel: retryWithModel };
  history.replaceState({ ...history.state, mapRetry }, '', url);
  location.reload();
}

export function takeRetryView() {
  const { mapRetry, ...other } = history.state || {};
  if (mapRetry) history.replaceState(other, '');
  return mapRetry;
}

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
  retryWithModel = !!App.viewer?.splats?.show;
  markNoGl(why);
  if (App.viewer) App.viewer.useDefaultRenderLoop = false;
  App.clearChunkLoading();
  App.hidePerfNotice();
  tutHide();
  App.setMode('2d');
  noGlNotice();
}

export function noGlNotice() {
  const why = App.noGlReason;
  for (const id of ['miOrbit', 'miFly', 'miHome', 'miAssetModel', 'miAssetSplat',
                    'miQLow', 'miQMid', 'miQHigh', 'miDbg']) {
    const b = $(id);
    b.disabled = true;
    b.title = why;
  }
  $('mi3d').querySelector('.lbl').textContent = 'Повторить 3D';
  if (!App.CAM) {
    for (const id of ['mi3d', 'miSplit', 'mi2d']) $(id).querySelector('.kbd').hidden = true;
  }
  $('stat').textContent = '3D недоступен. Выберите «Режим просмотра → Повторить 3D».';
  $('stat').title = why;
}
