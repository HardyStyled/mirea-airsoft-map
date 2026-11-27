/* что здесь живёт: FAB-меню, строка состояния, синхронизация галочек, открытие меню на pointerdown. */
/* menus.js — FAB-меню, строка состояния и синхронизация галочек. Открытие меню строго на
 * pointerdown (регресс 26.11). Дублирующих назначений onclick нет (§15.2). */
import { App, on, setView } from './state.js?v=33';
import { updateReadout } from './readout.js?v=33';
import { $ } from './dom.js?v=33';
import { assetChoiceState, setAssetChoice } from './assets.js?v=33';
import { setQuality } from './quality.js?v=33';
import { setBase } from './basemap.js?v=33';
import { tutShow } from './tutorial.js?v=33';
import { openWeather } from './weather.js?v=33';
import { planMarker } from './planMarker.js?v=33';

export const FAB_MENUS = [['fabMode', 'modeMenu'], ['fabSet', 'setMenu']];

export function closeMenus() {
  for (const [fab, menu] of FAB_MENUS) {
    $(menu).classList.remove('open');
    $(fab).setAttribute('aria-expanded', 'false');
  }
}

export function toggleMenu(fab, menu) {
  const open = !$(menu).classList.contains('open');   // повторный тап по FAB закрывает меню
  closeMenus();
  if (open) {
    $(menu).classList.add('open');
    $(fab).setAttribute('aria-expanded', 'true');
  }
}

const fabPressed = new Set();
export function wireFab() {
  for (const [fab, menu] of FAB_MENUS) {
    const trigger = $(fab), panel = $(menu);
    const items = () => Array.from(panel.querySelectorAll('button:not(:disabled)')).filter(b => b.getClientRects().length);
    trigger.setAttribute('aria-controls', menu);
    trigger.setAttribute('aria-haspopup', 'menu');
    panel.addEventListener('click', e => {
      if (!e.target.closest('button') || !panel.classList.contains('open')) return;
      closeMenus();
      const target = fab === 'fabSet' ? trigger : (App.mode === '2d' ? $('plan') : App.viewer?.canvas);
      target?.focus({ preventScroll: true });
    });
    $(fab).onpointerdown = () => { fabPressed.add(fab); toggleMenu(fab, menu); };
    $(fab).onclick = e => {
      if (e.detail === 0) fabPressed.delete(fab);
      if (fabPressed.has(fab)) { fabPressed.delete(fab); return; }
      toggleMenu(fab, menu);
      if (e.detail === 0 && panel.classList.contains('open')) items()[0]?.focus();
    };
    trigger.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      if (!panel.classList.contains('open')) toggleMenu(fab, menu);
      items().at(e.key === 'ArrowUp' ? -1 : 0)?.focus();
    });
    panel.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        closeMenus();
        trigger.focus(); // стандартный Tab продолжает обход с кнопки, открывшей меню
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const buttons = items();
      if (!buttons.length) return;
      const i = buttons.indexOf(document.activeElement);
      let next = e.key === 'End' ? buttons.length - 1 : 0;
      if (e.key === 'ArrowDown') next = (i + 1) % buttons.length;
      if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    });
  }
  // тап мимо закрывает меню
  document.addEventListener('pointerdown', e => {
    if (e.target.closest('.notice-stack')) return;
    if (!e.target.closest('.menu') && !e.target.closest('.fab')) closeMenus();
  });
  // Escape — приоритет: закрыть меню, не дёргая обработчик камеры на document
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const menuOpen = FAB_MENUS.find(([, menu]) => $(menu).classList.contains('open'));
    if (!menuOpen || $('tut').open) return;
    e.stopPropagation();
    closeMenus();
    $(menuOpen[0]).focus();
  }, true);
}

export function syncItem(id, on) {
  const b = $(id);
  b.classList.toggle('on', on);
  const role = b.getAttribute('role');
  if (role === 'menuitemradio' || role === 'menuitemcheckbox') b.setAttribute('aria-checked', String(on));
}

export function syncMenus() {
  const camMode = document.body.dataset.cameraMode || 'orbit';
  syncItem('mi3d', App.mode === '3d' && !App.split && !App.noGl);
  syncItem('miSplit', App.mode === '3d' && App.split && !App.noGl);
  syncItem('mi2d', App.mode === '2d');
  $('planSize').title = App.mode === '2d' ? 'Открыть 3D и план' : 'Весь план';
  $('miOrbit').setAttribute('aria-pressed', String(camMode === 'orbit'));
  $('miFly').setAttribute('aria-pressed', String(camMode === 'fly'));
  syncItem('miOrtho', App.baseName === 'ortho');
  syncItem('miQgis', App.baseName === 'qgis');
  const asset = assetChoiceState();
  syncItem('miAssetModel', asset === 'model');
  syncItem('miAssetSplat', asset === 'splat');
  syncItem('miQLow', App.qualityMode === 'light');
  syncItem('miQMid', App.qualityMode === 'normal');
  syncItem('miQHigh', App.qualityMode === 'detail');
  syncItem('miDbg', document.body.classList.contains('dbg'));
}

export function setFabTip(id, text) {
  const b = $(id);
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
}

export function updateFabTips() {
  const mode = App.noGl || App.mode === '2d' ? 'Только план' : (App.split ? '3D и план' : 'Только 3D');
  setFabTip('fabMode', 'Режим просмотра: ' + mode);
}

/* setAssetChoice живёт в assets.js — там же, где состояние ресурсов. Дубликат функции в menus.js
   расходился с оригиналом при первой же правке, поэтому меню только вызывает чужую. */

export function wireMenuItems() {
  const miniToggle = $('miniToggle');
  function showMini(expanded) {
    document.body.classList.toggle('mini-collapsed', !expanded);
    miniToggle.setAttribute('aria-expanded', String(expanded));
    miniToggle.title = expanded ? 'Свернуть мини-карту' : 'Показать мини-карту';
    miniToggle.setAttribute('aria-label', miniToggle.title);
    try { sessionStorage.setItem('mam.miniCollapsed', String(!expanded)); } catch {}
    if (expanded) App.mmPlan?.resize();
  }
  try { showMini(sessionStorage.getItem('mam.miniCollapsed') !== 'true'); } catch {}
  miniToggle.onclick = () => showMini(miniToggle.getAttribute('aria-expanded') !== 'true');
  let seenPlan = false;
  on('view', () => { if (App.mode === '2d' || App.split) seenPlan = true; });
  $('mm').onclick = () => {
    const firstCenter = !seenPlan && App.mmPlan?.cam && App.mmPlan.center;
    setView('3d', true);
    if (firstCenter) {
      App.plan.setViewCenter(...firstCenter);
      updateReadout();
    }
    $('plan').focus({ preventScroll: true });
  };
  $('planSize').onclick = () => {
    if (App.mode === '2d') setView('3d', true);
    else setView('2d', null);
    $('plan').focus({ preventScroll: true });
  };
  $('planBack').onclick = () => {
    showMini(true);
    setView('3d', false);
    $('mm').focus({ preventScroll: true });
  };
  $('planIn').onclick = () => App.plan.zoomBy(1 / 1.2);
  $('planOut').onclick = () => App.plan.zoomBy(1.2);
  $('miMarker').onclick = () => { closeMenus(); planMarker.start(); };
  $('miMarkerClear').onclick = () => planMarker.clear();
  $('planHomeCompact').onclick = $('planHome').onclick = () => {
    closeMenus();
    App.plan.resetView();
    $('plan').focus({ preventScroll: true });
  };
  $('mi3d').onclick = () => setView('3d', false);
  $('miSplit').onclick = () => setView('3d', true);
  $('mi2d').onclick = () => setView('2d', null);
  $('miOrbit').onclick = () => App.CAM && App.CAM.setMode('orbit');
  $('miFly').onclick = () => App.CAM && App.CAM.setMode('fly');
  $('miHome').onclick = () => App.CAM && App.CAM.reset();   // «Исходный вид»: та же точка, что и при старте
  $('miOrtho').onclick = () => setBase('ortho');
  $('miQgis').onclick = () => setBase('qgis');
  $('miQLow').onclick = () => setQuality('light');
  $('miQMid').onclick = () => setQuality('normal');
  $('miQHigh').onclick = () => setQuality('detail');
  $('miAssetModel').onclick = () => setAssetChoice('model');
  $('miAssetSplat').onclick = () => setAssetChoice('splat');
  $('miWeather').onclick = () => {
    closeMenus();
    $('fabSet').focus({ preventScroll: true });
    openWeather();
  };
  $('miTut').onclick = () => {
    closeMenus();
    $('fabSet').focus({ preventScroll: true });
    tutShow();
  };
}
