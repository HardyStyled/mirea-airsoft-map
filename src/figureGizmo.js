/* что здесь живёт: экранные рукоятки гизмо и преобразования по локальным осям восток/север/верх. */
const C=Cesium, V=C.Cartesian3, Q=C.Quaternion;
const axes=[V.UNIT_X,V.UNIT_Y,V.UNIT_Z];
const colors=['#ff8a82','#81dc98','#80baff'];
const planes={xy:[0,1,2],xz:[0,2,1],yz:[1,2,0]};
const ns='http://www.w3.org/2000/svg';
function node(tag,attrs,parent) {
  const el=document.createElementNS(ns,tag);
  for(const [name,value] of Object.entries(attrs)) el.setAttribute(name,value);
  parent.append(el); return el;
}
function worldAxes(position) {
  const m=C.Transforms.eastNorthUpToFixedFrame(position);
  return axes.map(v=>C.Matrix4.multiplyByPointAsVector(m,v,new V()));
}
function offset(origin,axis,length) {
  return V.add(origin,V.multiplyByScalar(axis,length,new V()),new V());
}
function planePoint(ray,position,normal) {
  const d=V.dot(normal,ray.direction);
  if(Math.abs(d)<1e-5) return null;
  const t=V.dot(normal,V.subtract(position,ray.origin,new V()))/d;
  return t>0 ? C.Ray.getPoint(ray,t,new V()) : null;
}
function alongAxis(ray,position,axis) {
  const w=V.subtract(ray.origin,position,new V()), dot=V.dot(axis,ray.direction);
  const denom=1-dot*dot;
  return denom>1e-6 ? (V.dot(axis,w)-dot*V.dot(ray.direction,w))/denom : null;
}

// When a plane is seen edge-on, its ray intersection is undefined. Keep the
// more visible axis along its screen direction and map the other to the perpendicular.
function edgeOnDrag(camera,first,second,scale) {
  const projected=axis=>new C.Cartesian2(V.dot(axis,camera.rightWC),-V.dot(axis,camera.upWC));
  let a=projected(first), b=projected(second);
  if(C.Cartesian2.magnitudeSquared(b)>C.Cartesian2.magnitudeSquared(a)) {
    [first,second]=[second,first]; [a,b]=[b,a];
  }
  C.Cartesian2.normalize(a,a);
  const sign=a.x*b.y-a.y*b.x>0 ? 1 : -1;
  return (dx,dy)=>V.add(V.multiplyByScalar(first,(dx*a.x+dy*a.y)*scale,new V()),
    V.multiplyByScalar(second,(-dx*a.y+dy*a.x)*scale*sign,new V()),new V());
}

// Keep labelled handles pickable even when projected axes nearly coincide.
function planeLabel(origin,tips,pair,used) {
  const direction=i=>Math.atan2(tips[i].y-origin.y,tips[i].x-origin.x);
  const u=direction(pair[0]),v=direction(pair[1]);
  const ideal=u+Math.atan2(Math.sin(v-u),Math.cos(v-u))/2;
  let best=null, bestScore=-Infinity;
  for(let j=0;j<24;j++) {
    const a=ideal+j*Math.PI/12;
    const dx=42*Math.cos(a),dy=42*Math.sin(a);
    let clearance=42;
    for(const tip of tips) {
      const x=tip.x-origin.x,y=tip.y-origin.y;
      const t=Math.min(1,Math.max(0,(dx*x+dy*y)/(x*x+y*y||1)));
      clearance=Math.min(clearance,Math.hypot(dx-t*x,dy-t*y));
    }
    for(const q of used) clearance=Math.min(clearance,Math.hypot(origin.x+dx-q.x,origin.y+dy-q.y)-11);
    const score=Math.min(clearance,22)+5*Math.cos(a-ideal);
    if(score>bestScore) {bestScore=score;best={x:origin.x+dx,y:origin.y+dy};}
  }
  return best;
}

export function createGizmo(viewer,svg) {
  const camera=viewer.camera, scene=viewer.scene, canvas=viewer.canvas;
  const paths=axes.map((_,i)=>{
    const group=node('g',{'stroke':colors[i]},svg);
    const line=node('path',{'fill':'none','stroke-width':2.8},group);
    const hit=node('path',{'data-axis':i,'stroke':'transparent','stroke-width':17,'fill':'none',
      'pointer-events':'stroke'},group);
    const label=node('text',{'fill':colors[i],'stroke':'none','text-anchor':'middle'},group);
    label.textContent='XYZ'[i];
    return {group,line,hit,label};
  });
  const pads=Object.entries(planes).map(([name,pair])=>{
    const color=colors[pair[2]], group=node('g',{},svg);
    const hit=node('rect',{'data-axis':name,width:26,height:20,rx:4,fill:'#20313a',stroke:color,
      'stroke-width':1.7,'pointer-events':'all'},group);
    node('title',{},hit).textContent='Переместить в плоскости '+name.toUpperCase();
    const label=node('text',{'fill':color,'text-anchor':'middle','pointer-events':'none'},group);
    label.textContent=name.toUpperCase();
    return {group,hit,label,pair};
  });
  const centre=node('circle',{'r':6,'fill':'#b4f4ff','stroke':'#253b40','pointer-events':'all',
    'data-axis':'centre'},svg);
  let last='';
  function draw(f,mode) {
    const origin=f?.position, project=p=>scene.cartesianToCanvasCoordinates(p);
    const visible=!!origin && mode && V.dot(V.subtract(origin,camera.positionWC,new V()),camera.directionWC)>0;
    svg.style.display=visible?'block':'none';
    if(!visible){last='';return;}
    const p=project(origin);
    if(!p) {svg.style.display='none';return;}
    const size=camera.getPixelSize(new C.BoundingSphere(origin,0),canvas.clientWidth,canvas.clientHeight)
      *(mode==='rotate'?48:72);
    const basis=worldAxes(origin);
    const cache=[mode,p.x,p.y,size,...V.pack(camera.positionWC,[]),...V.pack(camera.directionWC,[]),
      ...V.pack(camera.upWC,[]),canvas.clientWidth,canvas.clientHeight].join('/');
    if(last===cache) return;
    last=cache;
    centre.setAttribute('cx',p.x);centre.setAttribute('cy',p.y);
    centre.style.display=mode==='rotate'?'none':'';
    const tips=basis.map(axis=>project(offset(origin,axis,size)));
    const used=[];
    for(const {group,hit,label,pair} of pads){
      const show=mode==='move' && tips.every(Boolean);
      group.style.display=show?'':'none';
      if(!show) continue;
      const at=planeLabel(p,tips,pair,used);
      used.push(at);
      hit.setAttribute('x',at.x-13);hit.setAttribute('y',at.y-10);
      label.setAttribute('x',at.x);label.setAttribute('y',at.y+4);
    }
    paths.forEach(({group,line,hit,label},i)=>{
      group.style.display=mode==='snap'?'none':'';
      if(mode==='snap') return;
      const tip=tips[i];
      if(!tip) {group.style.display='none';return;}
      let d, labelAt;
      if(mode==='rotate'){
        const u=basis[(i+1)%3],v=basis[(i+2)%3],points=[];
        for(let k=0;k<64;k++){
          const a=k*Math.PI/32;
          const q=project(offset(offset(origin,u,size*Math.cos(a)),v,size*Math.sin(a)));
          if(!q){group.style.display='none';return;}
          points.push(q);
        }
        d=points.map((q,k)=>(k?'L':'M')+q.x+','+q.y).join('')+'Z';
        labelAt=points[8+i*10];
        hit.setAttribute('d',d);
      } else {
        const dx=tip.x-p.x,dy=tip.y-p.y,len=Math.hypot(dx,dy);
        if(len<12) {group.style.display='none';return;}
        const ux=dx/len,uy=dy/len;
        d='M'+p.x+','+p.y+'L'+tip.x+','+tip.y;
        hit.setAttribute('d',d);
        d+='m'+(-10*ux+4*uy)+','+(-10*uy-4*ux)+'L'+tip.x+','+tip.y+'l'+(-10*ux-4*uy)+','+(-10*uy+4*ux);
        labelAt={x:tip.x+ux*10,y:tip.y+uy*10};
      }
      line.setAttribute('d',d);
      label.setAttribute('x',labelAt.x);label.setAttribute('y',labelAt.y-2);
    });
  }
  function begin(f,mode,handle,p) {
    const ray=camera.getPickRay(p), pos=V.clone(f.position), rotation=Q.clone(f.rotation);
    const frame=worldAxes(pos), pair=planes[handle];
    const axis=pair || handle==='centre' ? null : frame[Number(handle)];
    const normal=pair ? frame[pair[2]] : axis||V.clone(camera.directionWC);
    const start=planePoint(ray,pos,normal), distance=axis&&alongAxis(ray,pos,axis);
    let edgeDrag;
    if(pair && (!start || Math.abs(V.dot(ray.direction,normal))<.15)){
      const scale=camera.getPixelSize(new C.BoundingSphere(pos,0),canvas.clientWidth,canvas.clientHeight);
      edgeDrag=edgeOnDrag(camera,frame[pair[0]],frame[pair[1]],scale);
    }
    const localStart=start&&V.subtract(start,pos,new V());
    const origin=scene.cartesianToCanvasCoordinates(pos);
    const axisEnd=axis&&scene.cartesianToCanvasCoordinates(offset(pos,axis,1));
    return point=>{
      const next=camera.getPickRay(point);
      if(mode==='rotate'){
        const q=planePoint(next,pos,axis);
        let angle;
        if(q && localStart && Math.abs(V.dot(ray.direction,axis))>.06) {
          const end=V.subtract(q,pos,q);
          angle=Math.atan2(V.dot(axis,V.cross(localStart,end,new V())),V.dot(localStart,end));
        } else {
          const dx=axisEnd.x-origin.x,dy=axisEnd.y-origin.y;
          angle=((point.x-p.x)*dy-(point.y-p.y)*dx)/(Math.hypot(dx,dy)||1)/48;
        }
        f.rotation=Q.normalize(Q.multiply(Q.fromAxisAngle(axis,angle),rotation,new Q()),new Q());
      } else if(edgeDrag) {
        f.position=V.add(pos,edgeDrag(point.x-p.x,point.y-p.y),new V());
      } else if(axis) {
        const t=alongAxis(next,pos,axis);
        if(t!==null && distance!==null) f.position=offset(pos,axis,t-distance);
      } else {
        const end=planePoint(next,pos,normal);
        if(start && end) f.position=V.add(pos,V.subtract(end,start,end),end);
      }
    };
  }
  return {draw,begin};
}
