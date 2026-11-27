/* что здесь живёт: ручное качество 3D (ADR-29/30): пресеты, applyQuality, watchdog, кнопки качества. */
/* quality.js — ручное качество 3D (ADR-29/30): пресеты QUALITY, applyQuality(),
 * setQuality(), updateQualityButtons(), startWatchdog(). Watchdog только советует,
 * сцену не меняет; degradeTo2D — только из renderError. */
import { App } from './state.js?v=14';
import { QUALITY_PRESETS, QUALITY_KEY } from './config.js?v=14';
import { $ } from './dom.js?v=14';

export const QUALITY_PRESETS_LOCAL = QUALITY_PRESETS;   // внешняя ссылка, значения не менять

let qualityMode = 'normal';
try {
  const saved = localStorage.getItem(QUALITY_KEY);
  if (Object.hasOwn(QUALITY_PRESETS_LOCAL, saved)) qualityMode = saved;
} catch (e) {}

export function applyQuality() {
  if (!App.viewer) return;
  const preset = QUALITY_PRESETS_LOCAL[qualityMode];
  for (const slot of ['tileset', 'splats']) {
    if (App.viewer[slot]) App.viewer[slot].maximumScreenSpaceError = preset[slot];
  }
}

export function setQuality(mode) {
  if (!Object.hasOwn(QUALITY_PRESETS_LOCAL, mode)) return;
  qualityMode = mode;
  App.qualityMode = mode;
  try { localStorage.setItem(QUALITY_KEY, mode); } catch (e) {}
  applyQuality();
  updateQualityButtons();
}
App.qualityMode = qualityMode;                   // галочки качества в меню читают состояние отсюда

export function updateQualityButtons() {
  for (const id of ['miQLow', 'miQMid', 'miQHigh']) $(id).disabled = App.noGl;
}

const fStarted = performance.now();
let fFrames = 0, fT0 = fStarted, fLow = 0;
let resetFpsWatch = () => {};

export function startWatchdog() {
  resetFpsWatch = () => { fFrames = 0; fT0 = performance.now(); fLow = 0; };
  App.viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (document.hidden || App.mode !== '3d') { resetFpsWatch(); return; }
    if (now - fStarted < 5000) { fFrames = 0; fT0 = now; return; }
    fFrames++;
    const dt = now - fT0;
    if (dt < 2500) return;
    const fps = fFrames * 1000 / dt;
    fFrames = 0; fT0 = now;
    fLow = fps < 6 ? fLow + 1 : 0;
    if (fLow >= 2) { showPerfNotice('fps'); fLow = 0; }
  });
  document.addEventListener('visibilitychange', resetFpsWatch);
  App.resetFpsWatch = resetFpsWatch;
}

let perfKind = null;
const perfLast = { fps: -Infinity, network: -Infinity };

function hidePerfNotice(kind) {
  if (kind && perfKind !== kind) return;
  perfKind = null;
  $('perfNotice').hidden = true;
}

/* Тексты рекомендации — здесь, а не в разметке: владелец видит только то, что ему предлагают
   сделать, и формулировки меняются вместе с настройками, а не с index.html. */
const PERF_COPY = {
  fps: {
    title: '3D работает медленно',
    body: 'Низкая частота кадров. Рекомендуем открыть 2D или выбрать низкое качество в меню «Вид».',
  },
  network: {
    title: '3D загружается дольше обычного',
    body: 'Похоже, соединение медленное. Рекомендуем открыть 2D или выбрать низкое качество в меню «Вид».',
  },
};

export function showPerfNotice(kind) {
  const copy = PERF_COPY[kind];
  if (!copy) return;
  const now = performance.now();
  if (now - perfLast[kind] < 60000) return;          // не надоеть: одна подсказка того же рода в минуту
  if (App.noGl || App.mode !== '3d') return;
  perfLast[kind] = now;
  perfKind = kind;
  $('perfTitle').textContent = copy.title;
  $('perfBody').textContent = copy.body;
  $('perfNotice').hidden = false;
}
$('perfClose').onclick = () => hidePerfNotice();

App.hidePerfNotice = hidePerfNotice;
App.showPerfNotice = showPerfNotice;
