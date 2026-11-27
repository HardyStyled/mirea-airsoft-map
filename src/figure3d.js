/* что здесь живёт: взаимодействие с личной фигуркой в 3D и сохранение завершённых действий. */
import { App } from './state.js?v=33';
import { $ } from './dom.js?v=33';
import { createGizmo } from './figureGizmo.js?v=33';
import { createFigureModel, poses } from './figureModel.js?v=33';
import { meshSurface } from './figureSurface.js?v=33';

const C=Cesium, V=C.Cartesian3, Q=C.Quaternion, key='mam.figure3d';
const words={move:'Стрелка — одна ось. XY, XZ, YZ — две оси. Центр — плоскость экрана.',
  rotate:'Тяните кольцо вокруг нужной оси.',
  snap:'Укажите поверхность или перетащите центр на неё.'};
function unpack(data) {
  const finite=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
  if(!data || !finite(data.position,3) || !finite(data.rotation,4)) return null;
  const position=V.unpack(data.position), rotation=Q.unpack(data.rotation);
  if(!Q.magnitude(rotation) || !V.magnitude(position)) return null;
  return {position,rotation:Q.normalize(rotation,rotation),pose:poses.includes(data.pose)?data.pose:'stand'};
}
function snapshot(f) {
  return f && {position:V.pack(f.position,[]),rotation:Q.pack(f.rotation,[]),pose:f.pose};
}
function attachToSurface(hit,f,pose) {
  const frame=C.Transforms.eastNorthUpToFixedFrame(hit.position);
  const old=f?.rotation || Q.fromRotationMatrix(C.Matrix4.getMatrix3(frame,new C.Matrix3()));
  const basis=C.Matrix3.fromQuaternion(old), up=C.Matrix3.getColumn(basis,2,new V());
  const axis=V.cross(up,hit.normal,new V()), dot=C.Math.clamp(V.dot(up,hit.normal),-1,1);
  let rotation=old;
  if(V.magnitudeSquared(axis)>1e-12 || dot<0) {
    if(V.magnitudeSquared(axis)<1e-12) C.Matrix3.getColumn(basis,0,axis);
    const turn=Q.fromAxisAngle(V.normalize(axis,axis),Math.acos(dot));
    rotation=Q.normalize(Q.multiply(turn,old,new Q()),new Q());
  }
  return {position:hit.position,rotation,pose};
}

export function createFigureEditor(viewer,onCommit) {
  const map=$('map'), canvas=viewer.canvas, panel=$('figureTools'), pose=$('figurePose');
  const model=createFigureModel(viewer), gizmo=createGizmo(viewer,$('figureGizmo'));
  let figure=null, tool=null, drag=null, ticket=0;
  try { figure=unpack(JSON.parse(sessionStorage.getItem(key))); } catch {}

  function sync(message) {
    panel.hidden=!tool;
    for(const [name,id] of [['move','figureMove'],['rotate','figureRotate'],['snap','figureSnap']]){
      $(id).setAttribute('aria-pressed',String(name===tool));
      $(id).disabled=!figure && name!=='snap';
    }
    if(figure) pose.value=figure.pose;
    $('figureHint').textContent=message || words[tool] || '';
    gizmo.draw(figure,tool);
  }
  function draw() { model.update(App.mode==='3d' && !App.noGl ? figure : null); }
  function commit() {
    try {
      if(figure) sessionStorage.setItem(key,JSON.stringify(snapshot(figure)));
      else sessionStorage.removeItem(key);
    } catch {}
    const cg=figure && C.Cartographic.fromCartesian(figure.position);
    onCommit(cg && [C.Math.toDegrees(cg.longitude),C.Math.toDegrees(cg.latitude)]);
  }
  function point(e) {
    const rect=canvas.getBoundingClientRect();
    return new C.Cartesian2(e.clientX-rect.left,e.clientY-rect.top);
  }
  function release() {
    const id=drag?.id;
    drag=null;
    if(id!=null && map.hasPointerCapture(id)) map.releasePointerCapture(id);
  }
  function cancelDrag() {
    ticket++;
    if(drag) { figure=unpack(drag.before); release(); draw(); }
  }
  function choose(next) { cancelDrag(); tool=next; sync(); }
  async function surfaceAt(p) {
    const ray=viewer.camera.getPickRay(p);
    if(!ray) return null;
    if(viewer.splats?.show || viewer.tileset?.show) return meshSurface(ray);
    const globe=viewer.scene.globe;
    const position=globe.show && globe.pick(ray,viewer.scene);
    return position ? {position,normal:globe.ellipsoid.geodeticSurfaceNormal(position)} : null;
  }
  async function snap(p,final) {
    const gesture=drag;
    if(!final && gesture.previewBusy){gesture.nextPoint=p;return;}
    const serial=++ticket, initial=gesture.before;
    if(!final) gesture.previewBusy=true;
    try {
      const hit=await surfaceAt(p);
      if(serial!==ticket) return;
      if(!hit){
        if(final){figure=unpack(initial); draw(); sync('Здесь нет поверхности. Укажите точку на карте.');}
        return;
      }
      figure=attachToSurface(hit,unpack(initial),pose.value); draw();
      if(final) { tool='move'; commit(); }
      sync();
    } catch {
      if(serial===ticket && final) {
        figure=unpack(initial); draw(); sync('Не удалось прочитать поверхность. Повторите выбор.');
      }
    } finally {
      if(!final){
        gesture.previewBusy=false;
        if(drag===gesture && !gesture.finishing && gesture.nextPoint){
          const latest=gesture.nextPoint;
          gesture.nextPoint=null;
          void snap(latest,false);
        }
      }
      if(final && serial===ticket) release();
    }
  }
  function consume(e){e.preventDefault();e.stopImmediatePropagation();}
  map.addEventListener('pointerdown',e=>{
    if(App.mode!=='3d'||App.noGl||e.button!==0||!e.isPrimary||App.CAM?.locked) return;
    const p=point(e), handle=e.target.closest?.('[data-axis]')?.dataset.axis;
    if(drag) return;
    if(!handle && tool!=='snap'){
      if(!figure) return;
      if(model.owns(viewer.scene.pick(p)?.id)){consume(e);choose('move');return;}
      // Splats can mask the ID buffer while leaving the mannequin visible.
      const ray=viewer.camera.getPickRay(p), distance=model.pickDistance(ray);
      if(!viewer.splats?.show || !Number.isFinite(distance)) return;
      consume(e);
      const serial=++ticket;
      surfaceAt(p).then(hit=>{
        if(serial===ticket && (!hit || distance<=V.distance(ray.origin,hit.position)+.01)) choose('move');
      }).catch(()=>{});
      return;
    }
    consume(e); canvas.focus({preventScroll:true});
    drag={id:e.pointerId,before:snapshot(figure),apply:handle && tool!=='snap'
      ? gizmo.begin(figure,tool,handle,p) : null,finishing:false};
    map.setPointerCapture(e.pointerId);
    if(tool==='snap') void snap(p,false);
  },true);
  map.addEventListener('pointermove',e=>{
    if(drag?.id!==e.pointerId || drag.finishing) return;
    consume(e);
    if(tool==='snap'){void snap(point(e),false);return;}
    drag.apply(point(e)); draw(); gizmo.draw(figure,tool);
  },true);
  map.addEventListener('pointerup',e=>{
    if(drag?.id!==e.pointerId) return;
    consume(e);
    if(tool==='snap'){drag.finishing=true; void snap(point(e),true);return;}
    drag.apply(point(e)); draw(); commit(); release(); sync();
  },true);
  map.addEventListener('pointercancel',e=>{if(drag?.id===e.pointerId){cancelDrag();sync();}},true);
  map.addEventListener('lostpointercapture',e=>{
    if(drag?.id===e.pointerId && !drag.finishing){cancelDrag();sync();}
  });
  window.addEventListener('keydown',e=>{
    if(tool && e.key==='Escape' && !document.querySelector('dialog[open]')){
      consume(e); if(drag){cancelDrag();sync();} else choose(null);
    }
  },true);
  $('figureMove').onclick=()=>choose('move');
  $('figureRotate').onclick=()=>choose('rotate');
  $('figureSnap').onclick=()=>choose('snap');
  $('figureDone').onclick=()=>choose(null);
  pose.onchange=()=>{if(figure){figure.pose=pose.value;draw();commit();}};
  viewer.scene.postRender.addEventListener(()=>{if(tool) gizmo.draw(figure,tool);});
  return {
    get exists(){return !!figure;},
    start(){choose(figure?'move':'snap');},
    clear(){choose(null); figure=null; draw(); commit();},
    changeView(){if(App.mode!=='3d' || App.noGl) choose(null); draw();},
    async fromPlan(geo){
      const id=++ticket;
      const origin=V.fromDegrees(geo[0],geo[1],500);
      const down=V.negate(C.Ellipsoid.WGS84.geodeticSurfaceNormal(origin),new V());
      try {
        const hit=await meshSurface(new C.Ray(origin,down));
        if(hit && id===ticket && !tool && App.mode==='3d'){
          figure=attachToSurface(hit,null,'stand');draw();commit();
        }
      } catch { /* The 2D bookmark stays available until the map geometry loads. */ }
    }
  };
}
