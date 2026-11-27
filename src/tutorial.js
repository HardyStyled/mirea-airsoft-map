/* что здесь живёт: оверлей «Управление» (первый визит) — наборы жестов для тача/мыши, SVG-глифы. */
/* tutorial.js — оверлей «Управление» (первый визит): наборы жестов для тача/мыши, SVG-глифы.
 * Контент и тексты не меняются — их проверяют тесты (§10). */
import { App } from './state.js?v=15';
import { TUT_SEEN } from './config.js?v=15';
import { $ } from './dom.js?v=15';

export const TUT_TOUCH = App.CAMERA_TOUCH;

const kbd = l => `<span class="k">${l}</span>`;
const MOUSE_WHEEL = `<svg width="34" height="50" viewBox="0 0 34 50" fill="none" aria-hidden="true">
  <rect x="2" y="2" width="30" height="46" rx="14" stroke="currentColor" stroke-width="1.6" opacity=".8"/>
  <rect x="13" y="9" width="8" height="14" rx="4" stroke="currentColor" stroke-width="1.4"/>
  <path d="M11 4l6-5 6 5" stroke="var(--acc,#ffb020)" stroke-width="1.6" fill="none"/>
  <path d="M11 38l6 5 6-5" stroke="var(--acc,#ffb020)" stroke-width="1.6" fill="none"/></svg>`;
const MOUSE_ORBIT = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
  <path d="M7 20l5-6 5 6M40 20l5-6 5 6M7 32l5 6 5-6M40 32l5 6 5-6" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="19" y="12" width="14" height="28" rx="7" stroke="currentColor" stroke-width="1.6" opacity=".85"/>
  <rect x="23.5" y="17" width="5" height="9" rx="2.5" stroke="currentColor" stroke-width="1.3"/></svg>`;
const G_DRAG = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="24" cy="22" r="7" stroke="currentColor" stroke-width="1.6"/>
  <path d="M7 22h10M31 22h10M12 17l-5 5 5 5M36 17l5 5-5 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_PINCH = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="17" cy="17" r="6" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="31" cy="17" r="6" stroke="currentColor" stroke-width="1.6"/>
  <path d="M17 32H9M13 27l-5 5 5 5M31 32h8M35 27l5 5-5 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_TAP = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="24" cy="26" r="5" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="24" cy="26" r="11" stroke="var(--acc,#ffb020)" stroke-width="1.2" opacity=".5"/>
  <path d="M24 5v6M15 8l3 5M33 8l-3 5" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const G_TAP2 = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="16" cy="26" r="5" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="16" cy="26" r="10" stroke="currentColor" stroke-width="1.1" opacity=".4"/>
  <circle cx="34" cy="26" r="5" stroke="var(--acc,#ffb020)" stroke-width="1.6"/>
  <circle cx="34" cy="26" r="10" stroke="var(--acc,#ffb020)" stroke-width="1.2" opacity=".55"/>
  <path d="M34 6v5M27 9l3 4M41 9l-3 4" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const G_HOME = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <path d="M13 24 23 15l10 9" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16 22v11h14V22" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M40 10a9 9 0 1 0 3 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M43 6v6h-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_SWIPE = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <path d="M9 31c9-16 21-16 29-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 4"/>
  <circle cx="9" cy="31" r="5" stroke="currentColor" stroke-width="1.6"/>
  <path d="M31 22l7 6-7 6" stroke="var(--acc,#ffb020)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_STICK = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="18" cy="22" r="13" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 4"/>
  <circle cx="23" cy="16" r="6" stroke="var(--acc,#ffb020)" stroke-width="1.8"/>
  <path d="M39 11v22M34 16l5-5 5 5M34 28l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const G_FAB = `<svg width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true">
  <circle cx="35" cy="10" r="7" stroke="var(--acc,#ffb020)" stroke-width="1.8"/>
  <circle cx="35" cy="26" r="7" stroke="currentColor" stroke-width="1.6"/>
  <path d="M6 10h16M6 26h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/></svg>`;

export function tutBuild() {
  const items = TUT_TOUCH ? [
    { g: G_DRAG, c: 'Осмотр', s: 'один палец — вращение' },
    { g: G_PINCH, c: 'Сдвиг и масштаб', s: 'два пальца' },
    { g: G_TAP2, c: 'Точка орбиты', s: '2×тап по 3D-виду' },
    { g: G_HOME, c: 'Исходный вид', s: 'меню камеры · клавиша R' },
    { g: G_FAB, c: 'Сменить вид', s: 'круглые кнопки справа вверху' },
    { g: G_SWIPE, c: 'Полёт: взгляд', s: 'свайп по 3D, кроме кнопок' },
    { g: G_STICK, c: 'Полёт: движение', s: 'джойстик · ↑↓ высота · ×4 бег' },
  ] : [
    { g: MOUSE_ORBIT, c: 'Осмотр', s: 'ЛКМ — вращение' },
    { g: G_DRAG, c: 'Полёт', s: 'меню камеры справа вверху' },
    { g: `<span class="tut-keys"><span class="row"></span><span class="row">${kbd('W')}</span><span class="row">${kbd('A')}${kbd('S')}${kbd('D')}</span></span>`, c: 'Движение', s: 'в режиме полёта' },
    { g: `<span class="row">${kbd('Q')}${kbd('E')}</span>`, c: 'Высота', s: 'Q / E' },
    { g: MOUSE_WHEEL, c: 'Масштаб / скорость', s: 'осмотр / полёт' },
    { g: G_TAP, c: 'Точка орбиты', s: 'двойной клик' },
    { g: `<span class="k wide">Shift</span>`, c: 'Быстрее', s: 'в полёте' },
    { g: kbd('R'), c: 'Исходный вид', s: 'сброс ракурса' },
  ];
  $('tutSub').textContent = TUT_TOUCH ? '3D и 2D · жесты' : '3D · осмотр и полёт';
  $('tutGrid').innerHTML = items.map(i =>
    `<div class="tut-item"><div>${i.g}</div><div class="cap">${i.c}<small>${i.s}</small></div></div>`).join('');
}

export function tutShow() {
  tutBuild();
  if (App.CAM) App.CAM.setLocked(true);
  $('tut').hidden = false;
  document.body.classList.add('tutOn');   // карточка перекрывает нижнюю половину — см. controls.css
}

export function tutHide() {
  if ($('tut').hidden) return;
  $('tut').hidden = true;
  document.body.classList.remove('tutOn');
  if (App.CAM) App.CAM.setLocked(false);
  try { localStorage.setItem(TUT_SEEN, '1'); } catch (e) {}
}

export function tutSeen() { try { return localStorage.getItem(TUT_SEEN) === '1'; } catch (e) { return true; } }

$('tutOk').addEventListener('click', tutHide);
$('tut').addEventListener('click', e => { if (e.target === $('tut')) tutHide(); });
// возврат обучения — строка «Обучение · жесты» в меню шестерёнки (miTut), отдельной кнопки «?» больше нет
// первый показ решает загрузчик (main.js): он же знает, дождались ли мы разметки и режимов
