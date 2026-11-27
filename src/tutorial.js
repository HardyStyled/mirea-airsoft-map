/* что здесь живёт: первый вход и справка по текущему виду карты. */
import { App, setView } from './state.js?v=33';
import { TUT_SEEN } from './config.js?v=33';
import { $ } from './dom.js?v=33';

const mouseShell = '<rect x="6.5" y="2" width="13" height="21" rx="6.5"/><path d="M6.5 11h13M13 2v9"/>';
const leftButton = '<path class="pressed" d="M7.5 10V8.5a5.5 5.5 0 0 1 4.5-5.4V10z"/>';
const rightButton = '<path class="pressed" d="M14 10V3.1a5.5 5.5 0 0 1 4.5 5.4V10z"/>';
const finger = '<path d="M9 14V6a1.7 1.7 0 0 1 3.4 0v6.1l5.8 1.3a2.8 2.8 0 0 1 2.1 3.1l-.6 4.3a2.4 2.4 0 0 1-2.4 2h-5.1a3.2 3.2 0 0 1-2.5-1.2l-5.4-6.8a1.6 1.6 0 0 1 2.3-2.2L9 15"/>';
const symbols = {
  left: mouseShell + leftButton,
  right: mouseShell + rightButton,
  wheel: mouseShell + '<rect x="11.5" y="5" width="3" height="6" rx="1.5" class="pressed"/>',
  doubleClick: mouseShell + leftButton,
  drag: finger + '<path class="motion" d="M16 6h7m-3-3 3 3-3 3"/>',
  doubleTap: finger,
  twoDrag: '<path d="M7.5 15V7a1.6 1.6 0 0 1 3.2 0v5.5-8a1.6 1.6 0 0 1 3.2 0v8l4.8 1.1a2.5 2.5 0 0 1 1.9 2.8l-.6 4.2a2.5 2.5 0 0 1-2.4 2.1h-5.4a3 3 0 0 1-2.3-1.1l-5.8-6.9a1.6 1.6 0 0 1 2.3-2.2l1.1 1.2"/><path class="motion" d="M17 6h6m-2.5-2.5L23 6l-2.5 2.5"/>',
  pinch: '<circle cx="9" cy="16" r="3"/><circle cx="16" cy="9" r="3"/><path class="motion" d="m3 22 3-3m-3-1v4h4M22 3l-3 3m-1-3h4v4"/>',
  keys: '<rect x="2" y="6" width="20" height="14" rx="2.5"/><path d="M5.5 10h1m3 0h1m3 0h1m3 0h1m-13 3h1m3 0h1m3 0h1m3 0h1"/><path class="motion" d="M8 16h8"/>',
  height: '<path d="M7.5 19V5M3.5 9l4-4 4 4"/><path class="motion" d="M16.5 5v14m-4-4 4 4 4-4"/>',
  stick: '<ellipse cx="12" cy="17" rx="9" ry="4.5"/><path d="M12 15.5V10"/><circle class="motion" cx="12" cy="7.3" r="3.3"/>',
  fast: '<path d="m3 6 6 6-6 6"/><path class="motion" d="m11 6 6 6-6 6"/><path d="M21 6v12"/>',
  home: '<path d="m3 11 9-7 9 7m-15-2v10a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V9"/><path class="motion" d="M10 20v-6h4v6"/>',
};

const homeRow = ['Вернуться к исходному виду', ['home', 'Нажмите R или выберите «Исходный вид» в меню.'],
  ['home', 'Выберите «Исходный вид» в меню.']];
const guide = {
  plan: [
    ['Сдвинуть план', ['left', 'Тяните мышью с зажатой левой кнопкой или нажимайте стрелки.'],
      ['drag', 'Проведите по плану одним пальцем.']],
    ['Изменить масштаб', ['wheel', 'Крутите колесо мыши или нажимайте + и −.'],
      ['pinch', 'Разведите два пальца, чтобы приблизить план. Сведите, чтобы отдалить.']],
    ['Показать весь полигон', ['home', 'Нажмите Home или кнопку «К центру».'], ['home', 'Нажмите «К центру».']],
  ],
  orbit: [
    ['Вращать модель', ['left', 'Тяните мышью с зажатой левой кнопкой или нажимайте стрелки.'],
      ['drag', 'Проведите по модели одним пальцем.']],
    ['Сдвинуть вид', ['right', 'Тяните мышью с зажатой правой кнопкой. С клавиатуры — Shift и стрелки.'],
      ['twoDrag', 'Проведите двумя пальцами в одном направлении.']],
    ['Изменить масштаб', ['wheel', 'Крутите колесо мыши или нажимайте + и −.'],
      ['pinch', 'Разведите два пальца для приближения, сведите для отдаления.']],
    ['Перенести центр вращения', ['doubleClick', 'Дважды щёлкните по модели. Камера сместится к точке, сохранив дистанцию.'],
      ['doubleTap', 'Дважды коснитесь модели. Камера сместится к точке, сохранив дистанцию.']],
    homeRow,
  ],
  fly: [
    ['Осмотреться', ['right', 'Тяните мышью с зажатой правой кнопкой или нажимайте стрелки.'],
      ['drag', 'Проведите пальцем по 3D-виду.']],
    ['Лететь', ['keys', 'W и S — вперёд и назад по направлению взгляда. A и D — в стороны.'],
      ['stick', 'Потяните джойстик в левом нижнем углу 3D-вида.']],
    ['Изменить высоту', ['height', 'Нажмите E для подъёма или Q для спуска.'],
      ['height', 'Удерживайте кнопки ↑ и ↓ для подъёма и спуска.']],
    ['Изменить скорость', ['wheel', 'Крутите колесо мыши. Удерживайте Shift для ускорения в 4 раза.'],
      ['fast', 'Нажмите ×4, чтобы ускориться. Нажмите ещё раз, чтобы вернуть обычную скорость.']],
    ['Перейти в орбиту', ['doubleClick', 'Дважды щёлкните по точке модели, вокруг которой хотите вращаться.'],
      ['doubleTap', 'Дважды коснитесь точки модели, вокруг которой хотите вращаться.']],
    homeRow,
  ],
};

const slides = [
  { tab: $('tutMouseTab'), panel: $('tutMousePanel') },
  { tab: $('tutTouchTab'), panel: $('tutTouchPanel') },
];
let selectedSlide = App.CAMERA_TOUCH ? 1 : 0;

function selectSlide(index) {
  selectedSlide = index;
  slides.forEach(({ tab, panel }, i) => {
    const active = i === index;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
    if (active) panel.scrollTop = 0;
  });
}

function guideRow(title, [symbol, instruction]) {
  const repeat = symbol === 'doubleClick' || symbol === 'doubleTap' ? '<b>×2</b>' : '';
  return `<li><span class="tut-icon" aria-hidden="true"><svg viewBox="0 0 25 25">${symbols[symbol]}</svg>${repeat}</span>
    <div><strong>${title}</strong><span class="tut-instruction">${instruction}</span></div></li>`;
}

export function tutBuild(welcome = false) {
  const planOnly = App.noGl || App.mode === '2d';
  const fly = !planOnly && document.body.dataset.cameraMode === 'fly';
  $('tutTitle').textContent = welcome ? 'Карта полигона МИРЭА' : 'Управление';
  $('tutPlan').hidden = !welcome || planOnly;
  const openView = planOnly ? 'Открыть план' : App.split ? 'Открыть 3D и план' : 'Открыть 3D';
  $('tutOk').textContent = welcome ? openView : 'Вернуться к карте';
  $('tutTabs').hidden = welcome;
  $('tutWelcomeHint').hidden = !welcome;
  $('welcomeWeather').hidden = !welcome;
  if (welcome) {
    for (const { panel } of slides) panel.hidden = true;
    const drag = App.CAMERA_TOUCH ? 'Проведите пальцем' : 'Потяните мышью с зажатой левой кнопкой';
    const planHint = App.split ? 'Кнопка «Весь план» развернёт карту.' : 'Нажмите мини-карту, чтобы раскрыть план.';
    $('tutSub').textContent = planOnly ? drag + ', чтобы сдвинуть план.'
      : (fly ? 'В 3D можно свободно перемещаться.' : drag + ', чтобы повернуть 3D-модель.') + ' ' + planHint;
    return;
  }
  $('tutSub').textContent = planOnly ? 'План сверху' : fly ? '3D · Свободная камера' : '3D · Орбита';
  const rows = planOnly ? guide.plan : fly ? guide.fly : guide.orbit;
  slides.forEach(({ panel }, i) => {
    panel.innerHTML = '<ul>' + rows.map(([title, mouse, touch]) => guideRow(title, i === 0 ? mouse : touch)).join('') + '</ul>';
  });
  selectSlide(selectedSlide);
}

slides.forEach(({ tab, panel }, i) => {
  tab.addEventListener('click', () => selectSlide(i));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = 1 - i;
    else return;
    event.preventDefault();
    selectSlide(next);
    slides[next].tab.focus();
  });
  let swipe;
  function slideDistance(touch) {
    if (!swipe) return 0;
    const dx = (touch.clientX - swipe.x) * (i === 0 ? -1 : 1);
    return Math.abs(dx) > 1.5 * Math.abs(touch.clientY - swipe.y) ? dx : 0;
  }
  panel.addEventListener('touchstart', e => {
    const finger = e.touches[0];
    swipe = e.touches.length === 1 ? { x: finger.clientX, y: finger.clientY } : null;
  }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) swipe = null;
    // Если горизонтальный жест забрал слайд, браузер иначе поглотит следующий тап как остановку прокрутки.
    if (e.cancelable && Math.abs(slideDistance(e.touches[0])) >= 8) e.preventDefault();
  }, { passive: false });
  panel.addEventListener('touchcancel', () => { swipe = null; });
  panel.addEventListener('touchend', e => {
    const advance = !e.touches.length && slideDistance(e.changedTouches[0]) >= 48;
    swipe = null;
    if (!advance) return;
    selectSlide(1 - i);
    slides[1 - i].tab.focus({ preventScroll: true });
  });
});

export function tutShow(welcome = false) {
  const dialog = $('tut');
  if (dialog.open) return;
  tutBuild(welcome);
  if (App.CAM) App.CAM.setLocked(true);
  dialog.hidden = false;
  slides.forEach(({ tab }, i) => { tab.autofocus = !welcome && i === selectedSlide; });
  $('tutOk').autofocus = welcome;
  dialog.showModal();
  document.body.classList.add('tutOn');   // карточка перекрывает нижнюю половину — см. controls.css
}

export function tutHide() {
  const dialog = $('tut');
  if (!dialog.open) return;
  dialog.close();
  dialog.hidden = true;
  if (document.activeElement === document.body) $('fabMode').focus({ preventScroll: true });
  document.body.classList.remove('tutOn');
  if (App.CAM) App.CAM.setLocked(false);
  try { localStorage.setItem(TUT_SEEN, '1'); } catch (e) {}
}

export function tutSeen() { try { return localStorage.getItem(TUT_SEEN) === '1'; } catch (e) { return true; } }

// Если человек уже пользуется картой, окончание загрузки не должно перехватывать ввод.
export async function offerWelcome(ready) {
  const input = new AbortController();
  for (const event of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(event, () => input.abort(), { capture: true, passive: true, signal: input.signal });
  }
  try {
    await ready;
    if (!input.signal.aborted && !App.noGl) tutShow(true);
  } finally { input.abort(); }
}

$('tutOk').addEventListener('click', () => {
  const welcome = $('tutTabs').hidden;
  tutHide();
  if (welcome) (App.mode === '2d' ? $('plan') : App.viewer?.canvas)?.focus({ preventScroll: true });
});
$('tutPlan').addEventListener('click', () => {
  tutHide();
  setView('2d', null);
  $('plan').focus({ preventScroll: true });
});
$('tut').addEventListener('cancel', e => { e.preventDefault(); tutHide(); });
$('tut').addEventListener('click', e => { if (e.target === $('tut')) tutHide(); });
