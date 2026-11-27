/* что здесь живёт: виртуальный стик (STICK_R=38) и кнопки ↑/↓/×4 для тач-полёта. */
/* touchControls.js — виртуальный стик (STICK_R = 38) и кнопки ↑/↓/×4. setPointerCapture на
 * кнопках: уход пальца не обрывает движение; pointercancel очищает состояние. */
import { STICK_R } from './config.js?v=10';
import { App } from './state.js?v=10';
import { $ } from './dom.js?v=10';

export function bindStick() {
  const stick = $('stick'), knob = stick.querySelector('.knob');
  let cx = 0, cy = 0, id = null;
  const move = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
    knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    if (App.CAM) App.CAM.setStick(dx / STICK_R, -dy / STICK_R);
  };
  stick.addEventListener('pointerdown', e => {
    e.preventDefault();
    id = e.pointerId;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    stick.setPointerCapture(id);
    stick.classList.add('drag');
    move(e.clientX - cx, e.clientY - cy);
  });
  stick.addEventListener('pointermove', e => { if (id === e.pointerId) move(e.clientX - cx, e.clientY - cy); });
  const stop = e => {
    if (id !== e.pointerId) return;
    id = null;
    stick.classList.remove('drag');
    knob.style.transform = '';
    if (App.CAM) App.CAM.setStick(0, 0);
  };
  stick.addEventListener('pointerup', stop);
  stick.addEventListener('pointercancel', stop);
}

export function holdFlyButton(id, value) {
  const b = $(id);
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (App.CAM) App.CAM.setVert(value);
  });
  const off = () => { if (App.CAM) App.CAM.setVert(0); };
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('pointerleave', off);
}

export function wireFlyRun() {
  /* ↑/↓ привязываем здесь: один вызов в загрузчике включает всю панель полёта. Отдельного
   * вызова не было — кнопки рисовались и молчали (мёртвый контрол на таче). */
  holdFlyButton('flyUp', 1);
  holdFlyButton('flyDown', -1);
  const b = $('flyRun');
  b.addEventListener('click', () => {
    const on = b.classList.toggle('on');
    if (App.CAM) App.CAM.setRun(on);
  });
}

/* Класс flytouch включает эту панель; предиката у него одна — syncFlyTouch() в state.js. */
