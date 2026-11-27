/* что здесь живёт: FAB-меню, строка состояния, синхронизация галочек, открытие меню на pointerdown. */
/* menus.js — FAB-меню, строка состояния и синхронизация галочек. Открытие меню строго на
 * pointerdown (регресс 26.11). Дублирующих назначений onclick нет (§15.2). */
import { App, setView } from './state.js?v=15';
import { $ } from './dom.js?v=15';
import { assetChoiceState, setAssetChoice } from './assets.js?v=15';
import { setQuality } from './quality.js?v=15';
import { setBase } from './basemap.js?v=15';
import { tutShow } from './tutorial.js?v=15';

export const FAB_MENUS = [['fabMode', 'modeMenu'], ['fabCam', 'camMenu'], ['fabSet', 'setMenu']];

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
    $(fab).onpointerdown = () => { fabPressed.add(fab); toggleMenu(fab, menu); };
    $(fab).onclick = () => {
      if (fabPressed.has(fab)) { fabPressed.delete(fab); return; }
      toggleMenu(fab, menu);
    };
  }
  // тап мимо закрывает меню
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.menu') && !e.target.closest('.fab')) closeMenus();
  });
  // Escape — приоритет: закрыть меню, не дёргая обработчик камеры на document
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const menuOpen = FAB_MENUS.some(([, menu]) => $(menu).classList.contains('open'));
    if (!menuOpen) return;
    e.stopPropagation();
    closeMenus();
  }, true);
}

export function syncItem(id, on) {
  const b = $(id);
  b.classList.toggle('on', on);
  const role = b.getAttribute('role');
  if (role === 'menuitemradio' || role === 'switch') b.setAttribute('aria-checked', String(on));
}

export function syncMenus() {
  const camMode = document.body.dataset.cameraMode || 'orbit';
  syncItem('mi3d', App.mode === '3d' && !App.split && !App.noGl);
  syncItem('miSplit', App.mode === '3d' && App.split && !App.noGl);
  syncItem('mi2d', App.mode === '2d');
  syncItem('miOrbit', camMode === 'orbit');
  syncItem('miFly', camMode === 'fly');
  syncItem('miOrtho', App.baseName === 'ortho');
  syncItem('miQgis', App.baseName === 'qgis');
  const asset = assetChoiceState();
  syncItem('miAssetNone', asset === 'none');
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
  const cam = document.body.dataset.cameraMode === 'fly' ? 'Полёт' : 'Осмотр';
  const mode = App.noGl || App.mode === '2d' ? 'Только план' : (App.split ? '3D и план' : 'Только 3D');
  setFabTip('fabMode', 'Режим: ' + mode);
  setFabTip('fabCam', 'Камера: ' + cam);
}

/* setAssetChoice живёт в assets.js — там же, где состояние ресурсов. Дубликат функции в menus.js
   расходился с оригиналом при первой же правке, поэтому меню только вызывает чужую. */

/* Строки меню живут разметкой, а их действия — здесь: меню — единственный вход в режимы
   (I1/ADR-33), и разбросать обработчики по модулям значило бы потерять строку при следующем
   рефакторинге. Камера — через App.CAM: экземпляр создаёт main.js, menus.js его не импортирует. */
export function wireMenuItems() {
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
  $('miAssetNone').onclick = () => setAssetChoice('none');
  $('miAssetModel').onclick = () => setAssetChoice('model');
  $('miAssetSplat').onclick = () => setAssetChoice('splat');
  $('miTut').onclick = () => tutShow();
}
