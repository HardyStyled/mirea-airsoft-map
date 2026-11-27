/* что здесь живёт: масштабная фигурка и её позы. Координаты в метрах, Z вверх, начало под подставкой. */
const C=Cesium, V=C.Cartesian3, Q=C.Quaternion;
const grey='#9caeb8', dark='#43515e', base='#42aebd';
export const poses = ['stand','kneel','lie','left','right','sit'];

function partsFor(pose) {
  const shapes=[];
  const ellipsoid=(xyz,radii,color,rotation=Q.IDENTITY)=>shapes.push({
    at:V.fromArray(xyz),radii:V.fromArray(radii),color,rotation
  });
  function link(from,to,width,depth,color=grey) {
    const a=V.fromArray(from), b=V.fromArray(to);
    const dir=V.subtract(b,a,new V()), length=V.magnitude(dir);
    V.normalize(dir,dir);
    const side=Math.abs(dir.y)>.99 ? V.UNIT_X : V.UNIT_Y;
    const x=V.normalize(V.cross(side,dir,new V()),new V());
    const y=V.cross(dir,x,new V());
    const m=new C.Matrix3(x.x,y.x,dir.x,x.y,y.y,dir.y,x.z,y.z,dir.z);
    ellipsoid(V.pack(V.midpoint(a,b,new V()),[]),[width,depth,length*.54],color,Q.fromRotationMatrix(m));
  }
  const lying=pose==='lie', kneel=pose==='kneel', sit=pose==='sit';
  const lean=pose==='right'?1:pose==='left'?-1:0;
  const hip=lying ? [0,0,.19] : [0,0,kneel ? .57 : sit ? .53 : .95];
  const chest=lying?[0,.48,.245]:[lean*.23,.014,hip[2]+.51-.04*Math.abs(lean)];
  const head=lying?[0,.72,.23]:[lean*.36,.03,chest[2]+.23];
  const span=lying ? .99 : kneel||sit ? .55 : .34;
  ellipsoid([0,0,.035],[lean ? .42 : .35,span,.035],dark);
  ellipsoid([0,0,.05],[lean ? .405 : .34,span*.97,.025],base);
  link(hip,chest,.205,.14);
  link(chest,head,.064,.061,dark);
  ellipsoid(hip,[.158,.122,.12],dark);
  ellipsoid(head,[.105,.113,.11],grey);
  ellipsoid([head[0],head[1]+.098,head[2]-.013],[.036,.044,.035],grey);
  for(const s of [-1,1]){
    const pelvis=[hip[0]+s*.103,hip[1],hip[2]];
    const shoulder=[chest[0]+s*.18,chest[1],chest[2]-s*lean*.045];
    const knee=lying ? [s*.14,-.42,.135] : kneel ? (s<0 ? [-.14,.34,.49] : [.14,-.12,.15]) :
      [s*.15,sit ? .35 : .025,.52];
    const footY=kneel ? (s<0 ? .33 : -.43) : sit ? .34 : s*.035;
    const foot=lying ? [s*.17,-.79,.135] : [s*(lean ? .235 : .15),footY,.14];
    const elbow=lying?[s*.28,.46,.14]:[shoulder[0]+s*.052,.07,shoulder[2]-.276];
    const hand=lying ? [s*.19,.78,.14] : [elbow[0]-s*.028,kneel||sit ? .31 : .13,elbow[2]-(kneel||sit ? .08 : .23)];
    link(pelvis,knee,.10,.092); link(knee,foot,.075,.072);
    ellipsoid(knee,[.071,.075,.07],dark);
    ellipsoid([foot[0],foot[1]+(lying?-.04:.055),foot[2]],[.067,.127,.065],dark);
    ellipsoid(shoulder,[.094,.09,.089],grey);
    link(shoulder,elbow,.071,.067); link(elbow,hand,.055,.052);
    ellipsoid(hand,[.045,.048,.059],dark);
  }
  return shapes;
}

export function createFigureModel(viewer) {
  let currentPose=null, parts=[];
  function clear() {
    for(const {entity} of parts) viewer.entities.remove(entity);
    parts=[]; currentPose=null;
  }
  function update(figure) {
    if(!figure) { clear(); return; }
    if(figure.pose!==currentPose) {
      clear(); currentPose=figure.pose;
      parts=partsFor(currentPose);
      for(const part of parts) {
        part.center=new V();
        part.orientation=new Q();
        part.inverse=new C.Matrix3();
        // Dynamic transforms let Cesium reuse the ellipsoid mesh on each frame of a drag.
        part.entity=viewer.entities.add({
          position:new C.CallbackPositionProperty((time,result)=>V.clone(part.center,result),false),
          orientation:new C.CallbackProperty((time,result)=>Q.clone(part.orientation,result),false),
          ellipsoid:{radii:part.radii,material:C.Color.fromCssColorString(part.color),
            stackPartitions:10,slicePartitions:16}
        });
      }
    }
    const rotation=C.Matrix3.fromQuaternion(figure.rotation);
    for(const part of parts) {
      C.Matrix3.multiplyByVector(rotation,part.at,part.center);
      V.add(figure.position,part.center,part.center);
      Q.multiply(figure.rotation,part.rotation,part.orientation);
      C.Matrix3.fromQuaternion(part.orientation,part.inverse);
      C.Matrix3.transpose(part.inverse,part.inverse);
    }
    viewer.scene.requestRender();
  }
  function pickDistance(ray) {
    let nearest=Infinity;
    for(const {center,inverse,radii} of parts) {
      const toLocal=v=>V.divideComponents(C.Matrix3.multiplyByVector(inverse,v,new V()),radii,new V());
      const o=toLocal(V.subtract(ray.origin,center,new V())), d=toLocal(ray.direction);
      const a=V.dot(d,d), b=V.dot(o,d), disc=b*b-a*(V.dot(o,o)-1);
      if(disc<0) continue;
      const enter=(-b-Math.sqrt(disc))/a, exit=(-b+Math.sqrt(disc))/a;
      if(exit>0) nearest=Math.min(nearest,Math.max(enter,0));
    }
    return nearest;
  }
  return {update,clear,pickDistance,owns:entity=>parts.some(p=>p.entity===entity)};
}
