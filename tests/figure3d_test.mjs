import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,
  args:['--enable-unsafe-swiftshader']});
try {
  const page = await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'reduce'});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.MAP_URL || 'http://127.0.0.1:8173/');
  await page.getByRole('button',{name:'Открыть 3D',exact:true}).click();
  await page.waitForFunction(() => App.frames > 4 && App.viewer.splats?.show);
  await page.locator('#fabSet').click();
  assert.match(await page.locator('#miMarker').innerText(),/в 3D/);
  await page.locator('#miMarker').click();
  const map=page.locator('.cesium-widget canvas'), box=await map.boundingBox();
  const clickMap=(x,y)=>map.click({position:{x:Math.round(box.width*x),y:Math.round(box.height*y)}});
  const read=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('mam.figure3d')));
  await clickMap(.53,.65);
  await page.waitForFunction(()=>sessionStorage.getItem('mam.figure3d'));
  const first=await read();
  assert.equal(await page.evaluate(()=>App.mode),'3d');
  assert.ok(await page.evaluate(()=>App.viewer.splats.show));
  const headPixel=await page.evaluate(()=>{
    const v=App.viewer;
    const head=v.entities.values.find(e=>e.ellipsoid?.radii.getValue(v.clock.currentTime).z===.11);
    const pixel=v.scene.cartesianToCanvasCoordinates(head.position.getValue(v.clock.currentTime));
    return {x:pixel.x,y:pixel.y};
  });
  await page.locator('#figureDone').click();
  await map.click({position:headPixel});
  await page.locator('#figureTools').waitFor({state:'visible'});
  await page.locator('#figurePose').selectOption('kneel');
  assert.equal((await read()).pose,'kneel');
  const drag=async(axis)=>{
    const handle=page.locator('#figureGizmo [data-axis="'+axis+'"]');
    const p=await handle.evaluate(el=>{
      const pt=el.getPointAtLength(el.getTotalLength()*.74);
      const screen=new DOMPoint(pt.x,pt.y).matrixTransform(el.getScreenCTM());
      return [screen.x,screen.y];
    });
    await page.mouse.move(...p); await page.mouse.down();
    const committed=await read();
    await page.evaluate(()=>{
      const v=App.viewer, C=Cesium;
      const head=v.entities.values.find(e=>e.ellipsoid?.radii.getValue(v.clock.currentTime).z===.11);
      const sphere=new C.BoundingSphere(), last=C.Cartesian3.clone(head.position.getValue(v.clock.currentTime));
      window.dragFrames=[];
      window.stopDragProbe=v.scene.postRender.addEventListener(()=>{
        const target=head.position.getValue(v.clock.currentTime);
        if(C.Cartesian3.distance(last,target)<.001) return;
        C.Cartesian3.clone(target,last);
        const state=v.dataSourceDisplay.getBoundingSphere(head,false,sphere);
        window.dragFrames.push(state===C.BoundingSphereState.DONE ? C.Cartesian3.distance(sphere.center,target) : null);
      });
    });
    for(const step of [.35,.7,1]){
      await page.mouse.move(p[0]+45*step,p[1]-25*step);
      await page.evaluate(()=>new Promise(done=>{
        const off=App.viewer.scene.postRender.addEventListener(()=>{off();done();});
      }));
    }
    const frames=await page.evaluate(()=>{window.stopDragProbe();return window.dragFrames;});
    assert.ok(frames.length>=2 && frames.every(error=>error!==null && error<.01),
      'rendered mannequin must follow the held pointer every frame: '+JSON.stringify(frames));
    assert.deepEqual(await read(),committed);
    await page.mouse.up();
  };
  const eye=()=>page.evaluate(()=>Cesium.Cartesian3.pack(App.viewer.camera.positionWC,[]));
  const beforeEye=await eye();
  await drag(0);
  const moved=await read();
  assert.notDeepEqual(moved.position,first.position);
  for(const [name,locked] of [['xy',2],['xz',1],['yz',0]]){
    const pad=page.locator('#figureGizmo [data-axis="'+name+'"]');
    assert.equal(await pad.count(),1,'missing plane handle '+name);
    const before=await read(), rect=await pad.boundingBox();
    const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest('[data-axis]')?.dataset.axis,[x,y]),name);
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+9,y-6,{steps:3}); await page.mouse.up();
    const after=await read();
    const delta=await page.evaluate(([a,b])=>{
      const C=Cesium,V=C.Cartesian3,anchor=V.unpack(a);
      const frame=C.Transforms.eastNorthUpToFixedFrame(anchor);
      return V.pack(C.Matrix4.multiplyByPoint(C.Matrix4.inverseTransformation(frame,new C.Matrix4()),V.unpack(b),new V()),[]);
    },[before.position,after.position]);
    assert.ok(Math.abs(delta[locked])<1e-6 && delta.every((d,i)=>i===locked || Math.abs(d)>.0001),
      name+' must move only on its two axes: '+delta);
  }
  const translated=await read();
  await page.locator('#figureRotate').click();
  await drag(2);
  const rotated=await read();
  assert.notDeepEqual(rotated.rotation,moved.rotation);
  assert.deepEqual(rotated.position,translated.position);
  assert.deepEqual(await eye(),beforeEye);
  await page.locator('#figureSnap').click();
  const headWorld=()=>page.evaluate(()=>{
    const v=App.viewer, time=v.clock.currentTime;
    const head=v.entities.values.find(e=>e.ellipsoid?.radii.getValue(time).z===.11);
    return Cesium.Cartesian3.pack(head.position.getValue(time),[]);
  });
  const headBeforeSnap=await headWorld();
  await page.mouse.move(box.x+Math.round(box.width*.59),box.y+Math.round(box.height*.6));
  await page.mouse.down();
  await page.waitForFunction(old=>{
    const v=App.viewer, time=v.clock.currentTime;
    const head=v.entities.values.find(e=>e.ellipsoid?.radii.getValue(time).z===.11);
    return Cesium.Cartesian3.distance(head.position.getValue(time),Cesium.Cartesian3.unpack(old))>.01;
  },headBeforeSnap,{timeout:5000});
  assert.deepEqual(await read(),rotated);
  await page.mouse.up();
  await page.waitForFunction(p=>JSON.stringify(JSON.parse(sessionStorage.getItem('mam.figure3d')).position)!==JSON.stringify(p),rotated.position);
  const snapped=await read();
  await page.locator('#figureDone').click();
  await page.locator('#fabSet').click();
  await page.locator('#miAssetModel').click();
  await page.waitForFunction(()=>App.viewer.tileset?.show);
  await page.locator('#fabSet').click();
  await page.locator('#miMarker').click();
  await page.locator('#figureSnap').click();
  await clickMap(.55,.67);
  await page.waitForFunction(p=>JSON.stringify(JSON.parse(sessionStorage.getItem('mam.figure3d')).position)!==JSON.stringify(p),snapped.position);
  for(const pose of ['stand','kneel','lie','left','right','sit']){
    await page.locator('#figurePose').selectOption(pose);
    assert.equal((await read()).pose,pose);
  }
  const saved=await read();
  await page.reload(); await page.waitForFunction(()=>App.booted);
  assert.deepEqual(await read(),saved);
  assert.deepEqual(errors,[]);
  console.log('PASS 3D placement in splat and model views, six poses, move, rotation, snap, camera isolation and session restore');

  // Exercise wall, underside, nearest hit and miss independently of the surveyed site.
  const originFrame=await page.evaluate(async()=>{
    const config=await import(document.querySelector('script[type=module]').src.replace('main.js','config.js'));
    const transform={}; config.flattenTileset(transform);
    return Cesium.Matrix4.toArray(transform.modelMatrix);
  });
  const fixture=await browser.newPage();
  await fixture.route('**/3dtiles/tileset.json',route=>route.fulfill({json:{asset:{version:'1.1'},root:{
    boundingVolume:{box:[0,0,0,4,0,0,0,4,0,0,0,4]},content:{uri:'fixture.glb'}}}}));
  // glTF is Y-up: these triangles are a vertical wall and a horizontal shelf.
  const v=new Float32Array([0,0,-2,0,0,2,0,3,0, -2,2,-2,2,2,-2,0,2,2]);
  const indices=new Uint16Array([0,1,2,3,4,5]);
  const doc={asset:{version:'2.0'},buffers:[{byteLength:v.byteLength+indices.byteLength}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:v.byteLength},{buffer:0,byteOffset:v.byteLength,byteLength:indices.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3'},{bufferView:1,componentType:5123,count:6,type:'SCALAR'}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}]};
  const json=Buffer.from(JSON.stringify(doc)), jsonSize=Math.ceil(json.length/4)*4;
  const binSize=v.byteLength+indices.byteLength, glb=Buffer.alloc(28+jsonSize+binSize);
  glb.write('glTF'); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(jsonSize,12); glb.write('JSON',16); glb.fill(32,20,20+jsonSize); json.copy(glb,20);
  glb.writeUInt32LE(binSize,20+jsonSize);glb.write('BIN\0',24+jsonSize);
  Buffer.from(v.buffer).copy(glb,28+jsonSize);Buffer.from(indices.buffer).copy(glb,28+jsonSize+v.byteLength);
  await fixture.route('**/fixture.glb',route=>route.fulfill({body:glb,contentType:'model/gltf-binary'}));
  await fixture.goto(new URL('?nogl',page.url()).href);
  const hits=await fixture.evaluate(async frame=>{
    const {meshSurface}=await import('./src/figureSurface.js');
    const C=Cesium,V=C.Cartesian3,M=C.Matrix4, matrix=M.fromArray(frame);
    async function cast(origin,direction){
      const start=M.multiplyByPoint(matrix,V.fromArray(origin),new V());
      const hit=await meshSurface(new C.Ray(start,V.fromArray(direction)));
      return hit && [Math.round(V.distance(start,hit.position)),V.pack(hit.normal,[]).map(n=>Math.round(n)||0)];
    }
    return [await cast([2,0,1],[-1,0,0]),await cast([.4,0,.5],[0,0,1]),await cast([.4,0,4],[0,0,-1]),
      await cast([20,20,1],[0,0,1])];
  },originFrame);
  assert.deepEqual(hits,[[2,[1,0,0]],[2,[0,0,-1]],[2,[0,0,1]],null]);
  console.log('PASS vertical face, underside, top and empty space');

  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await phone.goto(process.env.MAP_URL || 'http://127.0.0.1:8173/');
  await phone.getByRole('button',{name:'Открыть 3D',exact:true}).tap();
  await phone.waitForFunction(()=>App.frames>4 && App.viewer.splats?.show);
  await phone.locator('#fabSet').tap(); await phone.locator('#miMarker').tap();
  await phone.locator('.cesium-widget canvas').tap({position:{x:200,y:530}});
  await phone.waitForFunction(()=>sessionStorage.getItem('mam.figure3d'));
  await phone.locator('#figureRotate').tap();
  assert.equal(await phone.locator('#figureRotate').getAttribute('aria-pressed'),'true');
  await phone.locator('#figureDone').tap();
  assert.equal(await phone.locator('#figureTools').isVisible(),false);
  console.log('PASS touch placement and editing controls');
} finally { await browser.close(); }
