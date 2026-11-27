/* что здесь живёт: личная фигурка и её проекция на план. Старые закладки хранят только lon/lat. */
import { App, on } from './state.js?v=33';
import { $ } from './dom.js?v=33';
import { createFigureEditor } from './figure3d.js?v=33';

const key = 'mam.planMarker';
let point = null;
let sceneEditor=null;
try {
  const stored = JSON.parse(sessionStorage.getItem(key));
  if (Array.isArray(stored) && stored.length === 2 && stored.every(Number.isFinite)) point = stored;
} catch {}

function sync() {
  $('markerAction').textContent = App.mode==='3d' && sceneEditor && !App.noGl
    ? (sceneEditor.exists ? 'Изменить фигурку в 3D' : 'Поставить фигурку в 3D')
    : (point ? 'Переставить фигурку на плане' : 'Поставить фигурку на план');
  $('miMarkerClear').hidden = !point && !sceneEditor?.exists;
  $('markerPrompt').hidden = !planMarker.placing;
  $('plan').classList.toggle('placing', planMarker.placing);
  if (planMarker.placing) $('plan').setAttribute('aria-describedby', 'markerInstruction');
  else $('plan').removeAttribute('aria-describedby');
}

function save(next) {
  point = next;
  try {
    if (point) sessionStorage.setItem(key, JSON.stringify(point));
    else sessionStorage.removeItem(key);
  } catch {}
  planMarker.cancel();
  App.plan?.draw();
}

export const planMarker = {
  placing: false,
  attach(viewer) {sceneEditor=createFigureEditor(viewer,save); sync();},
  start() {
    if (App.mode==='3d' && sceneEditor && !App.noGl) {sceneEditor.start();return;}
    this.placing = true;
    $('markerInstruction').textContent = App.CAMERA_TOUCH ? 'Коснитесь места на плане' : 'Щёлкните по плану. Enter — поставить в центре.';
    sync();
    $('plan').focus({ preventScroll: true });
  },
  cancel() { this.placing = false; sync(); },
  clear() { if(sceneEditor) sceneEditor.clear(); else save(null); },
  place(geo) { if (this.placing && geo) {sceneEditor?.clear(); save([...geo]);} },
  draw(ctx, pane) {
    if (!point) return;
    const [x, y] = pane.project(...point);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#503b92';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-3, -4, -13, -10, -13, -18);
    ctx.arc(0, -18, 13, Math.PI, 2 * Math.PI);
    ctx.bezierCurveTo(13, -10, 3, -4, 0, 0);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, -22, 3.3, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -12, 6, Math.PI, 2 * Math.PI); ctx.fill();
    ctx.restore();
  },
};

sync();
on('mode', () => {
  if (App.mode !== '2d' && planMarker.placing) planMarker.cancel();
  sceneEditor?.changeView();
  if (App.mode==='3d' && !App.noGl && point && sceneEditor && !sceneEditor.exists) void sceneEditor.fromPlan(point);
  sync();
});
$('markerCancel').addEventListener('click', () => {
  planMarker.cancel();
  $('plan').focus({ preventScroll: true });
});
