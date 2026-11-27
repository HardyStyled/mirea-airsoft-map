import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ['--enable-unsafe-swiftshader'] });
const base = process.env.MAP_URL || 'http://127.0.0.1:8173/';
async function run(touch) {
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1200, height: 768 },
    hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  const use = (el, position) => touch ? el.tap({ position }) : el.click({ position });
  const view = page.locator('.cesium-widget canvas');
  const plan = page.locator('#plan');
  const eye = () => page.evaluate(() => {
    const p = App.viewer.camera.positionWC;
    return [p.x, p.y, p.z];
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await use(page.getByRole('button', { name: 'Открыть 3D', exact: true }));
    await page.waitForFunction(() => App.frames > 8 && App.viewer.splats?.show);
    await page.evaluate(async () => {
      const { CollisionGrid } = await import('./src/collision.js');
      const meta = await (await fetch('./collision/collision.json')).json();
      const bin = await (await fetch('./collision/collision.bin')).arrayBuffer();
      const grid = new CollisionGrid(meta, new Int16Array(bin));
      const C = Cesium, origin = C.Cartesian3.fromDegrees(meta.originLon, meta.originLat);
      const inverse = C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(origin), new C.Matrix4());
      window.expectedHit = (x, y) => {
        const ray = App.viewer.camera.getPickRay(new C.Cartesian2(x, y));
        const o = C.Matrix4.multiplyByPoint(inverse, ray.origin, new C.Cartesian3());
        const d = C.Matrix4.multiplyByPointAsVector(inverse, ray.direction, new C.Cartesian3());
        const hit = grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, App.CAM.rig.maxDistance);
        return hit && C.Cartesian3.pack(C.Ray.getPoint(ray, hit.dist), []);
      };
      window.depthReads = 0;
      const scene = App.viewer.scene, read = scene.pickPosition.bind(scene);
      scene.pickPosition = (...args) => { window.depthReads++; return read(...args); };
    });
    await page.waitForFunction(() => App.mmPlan?.cam && App.mmPlan.cam.rayEnd == null);
    await use(page.getByRole('button', {name:'Свернуть мини-карту'}));
    assert.equal(await page.locator('#mm').isVisible(), false);
    const miniSize = await page.locator('#miniNav').boundingBox();
    assert.ok(miniSize.width <= 48 && miniSize.height <= 48);
    await use(page.getByRole('button', {name:'Показать мини-карту'}));
    assert.equal(await page.locator('#mm').isVisible(), true);
    for (const split of [false, true]) {
      if (split) await use(page.locator('#mm'));
      const box = await view.boundingBox();
      if (!split) await use(page.locator('#miFly'));
      const position = { x: Math.round(box.width * 0.54), y: Math.round(box.height * 0.65) };
      const beforeEye = await eye();
      const before = await page.evaluate(({x,y}) => ({
        hit: window.expectedHit(x, y),
        radius: Cesium.Cartesian3.distance(App.viewer.camera.positionWC, App.CAM.target),
        direction: Cesium.Cartesian3.pack(App.viewer.camera.directionWC, []),
        depthReads: window.depthReads,
      }), position);
      const hit = before.hit;
      assert.ok(hit, 'fixture pixel must intersect real collision: ' + JSON.stringify({touch,split,position}));
      if (touch) {
        // Use the physical gesture's timestamps; software WebGL can delay CDP round trips by a whole tap interval.
        const cdp = await page.context().newCDPSession(page);
        const start = Date.now() / 1000;
        const finger = { x: box.x + position.x, y: box.y + position.y };
        for (const [type, elapsed, points] of [
          ['touchStart', 0, [finger]], ['touchEnd', 0.04, []],
          ['touchStart', 0.13, [finger]], ['touchEnd', 0.17, []],
        ]) await cdp.send('Input.dispatchTouchEvent', {type, touchPoints: points, timestamp: start + elapsed});
        await cdp.detach();
      }
      else await view.dblclick({ position });
      await page.waitForFunction(p => Cesium.Cartesian3.distance(App.CAM.target, new Cesium.Cartesian3(...p)) < 0.15, hit)
        .catch(async error => {
          const details = await page.evaluate(() => ({
            target: Cesium.Cartesian3.pack(App.CAM.target, []), mode: App.CAM.mode, toast: document.querySelector('#toast').textContent,
          }));
          throw new Error('focus did not reach the chosen point ' + JSON.stringify({touch,split,position,hit,details}), {cause:error});
        });
      assert.equal(await page.locator('#miOrbit').getAttribute('aria-pressed'), 'true');
      const focusedEye = await eye();
      assert.ok(Math.hypot(...focusedEye.map((v,i) => v - beforeEye[i])) > 0.15, 'focus left the eye stationary');
      const focused = await page.evaluate(before => ({
        radius: Cesium.Cartesian3.distance(App.CAM.target, App.viewer.camera.positionWC),
        angle: Cesium.Cartesian3.angleBetween(App.viewer.camera.directionWC, new Cesium.Cartesian3(...before.direction)),
        depthReads: window.depthReads,
      }), before);
      assert.ok(Math.abs(focused.radius - before.radius) < 0.01, 'focus changed the orbit radius');
      assert.ok(focused.angle < 0.0001, 'focus changed the viewing direction');
      assert.equal(focused.depthReads, before.depthReads, 'Gaussian picking read the render depth');
      assert.equal(await page.locator('#orbitCenter').isVisible(), true);
      if (touch) {
        const cdp = await page.context().newCDPSession(page);
        const x = box.x + position.x, y = box.y + position.y;
        for (const [type, points] of [['touchStart', [{x,y}]], ['touchMove', [{x:x+24,y}]], ['touchMove', [{x:x+45,y:y+4}]], ['touchEnd', []]])
          await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
        await cdp.detach();
      } else {
        await page.mouse.move(box.x + position.x, box.y + position.y); await page.mouse.down();
        await page.mouse.move(box.x + position.x + 45, box.y + position.y + 4, {steps:5}); await page.mouse.up();
      }
      await page.waitForFunction(p => Cesium.Cartesian3.distance(App.viewer.camera.positionWC, new Cesium.Cartesian3(...p)) > 0.1, focusedEye);
      const drift = await page.evaluate(p => Cesium.Cartesian3.distance(App.CAM.target, new Cesium.Cartesian3(...p)), hit);
      assert.ok(drift < 0.15, 'rotation lost its selected pivot');
      if (!touch) {
        const project = () => page.evaluate(p => {
          const screen = App.viewer.scene.cartesianToCanvasCoordinates(new Cesium.Cartesian3(...p));
          return [screen.x, screen.y];
        }, hit);
        const p = await project(), x = box.x + position.x, y = box.y + position.y;
        await page.mouse.move(x, y); await page.mouse.down({ button: 'right' });
        await page.mouse.move(x-32, y+14, {steps: 4}); await page.mouse.up({ button: 'right' });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const end = await project();
        assert.ok(Math.hypot(end[0]-p[0]+32, end[1]-p[1]-14) < 1, 'surface did not follow RMB drag: ' + JSON.stringify({p,end}));
      }
    }
    for (const mode of ['Орбита', 'Свободная камера']) {
      await use(page.getByRole('button', {name:mode, exact:true}));
      const box = await plan.boundingBox();
      const point = {x: Math.round(box.width * (mode === 'Орбита' ? 0.54 : 0.58)), y: Math.round(box.height * 0.54)};
      await use(plan, point);
      await page.waitForFunction(({x,y}) => {
        const camera = App.viewer.camera.positionCartographic;
        const p = App.plan.project(Cesium.Math.toDegrees(camera.longitude), Cesium.Math.toDegrees(camera.latitude));
        const rect = document.getElementById('plan').getBoundingClientRect();
        return Math.hypot(p[0]+rect.width/2-x, p[1]+rect.height/2-y) < 2;
      }, point);
    }
    if (!touch) {
      const before = await eye(), box = await plan.boundingBox();
      assert.equal(await plan.evaluate(el => getComputedStyle(el).cursor), 'default');
      await page.mouse.move(box.x+110, box.y+120); await page.mouse.down();
      await page.mouse.move(box.x+150, box.y+145, {steps:4});
      assert.equal(await plan.evaluate(el => getComputedStyle(el).cursor), 'grabbing');
      await page.mouse.up();
      assert.equal(await plan.evaluate(el => getComputedStyle(el).cursor), 'default');
      assert.deepEqual(await eye(), before);
    }
    console.log('PASS collision-based Gaussian focus, radius and orientation preserved, rotation, split navigation:', touch ? 'touch' : 'desktop');
  } finally { await page.close(); }
}
async function checkPhoneZoom() {
  const page = await browser.newPage({ viewport: { width: 773, height: 1011 }, hasTouch: true, isMobile: true });
  try {
    await page.goto(new URL('?nosplat&nomodel', base).href);
    await page.getByRole('button', { name: 'Открыть 3D', exact: true }).tap();
    await page.locator('#mm').tap();
    await page.locator('#miFly').tap();
    const lens = page.locator('#lensToggle'), slider = page.locator('#lensRange');
    const actualFov = () => page.evaluate(() => Cesium.Math.toDegrees(App.viewer.camera.frustum.fov));
    const originalEye = await page.evaluate(() => Cesium.Cartesian3.pack(App.viewer.camera.positionWC, []));
    assert.equal(await page.locator('#fovCtl').isVisible(), false);
    assert.equal(await slider.isVisible(), false);
    for (const [label, zoom] of [['2×', 2], ['0,6×', 0.6], ['1×', 1]]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.tap();
      const degrees = await actualFov();
      assert.ok(Math.abs(Math.tan(86*Math.PI/360) / Math.tan(degrees*Math.PI/360) - zoom) < 0.025);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-zoom][aria-pressed="true"]').count(), 1);
      assert.match(await lens.getAttribute('aria-label'), new RegExp(label + '$'));
      assert.equal(await lens.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#miFly').getAttribute('aria-pressed'), 'true');
      assert.ok(await page.evaluate(() => Math.abs(App.plan.fovRad - App.viewer.camera.frustum.fov) < 1e-8));
    }
    const eyeShift = await page.evaluate(before => Cesium.Cartesian3.distance(App.viewer.camera.positionWC, new Cesium.Cartesian3(...before)), originalEye);
    assert.ok(eyeShift < 0.000001, 'adjusting the lens displaced the camera');
    await lens.tap();
    const track = await slider.boundingBox();
    await slider.tap({position: {x: Math.round(track.width*0.72), y: Math.round(track.height*0.6)}});
    const tapped = Number(await slider.inputValue());
    await slider.press('ArrowRight');
    const custom = Number(await slider.inputValue());
    assert.equal(custom, tapped - 1);
    assert.ok(custom < 86 && custom > 30, 'adjusting the slider toward the right must magnify');
    assert.ok(Math.abs(await actualFov() - custom) < 0.001);
    assert.equal(await page.locator('#lensDegrees').innerText(), custom + '°');
    await slider.press('Escape');
    assert.equal(await lens.getAttribute('aria-expanded'), 'false');
    assert.equal(await lens.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('[data-zoom][aria-pressed="true"]').count(), 0);
    assert.match(await lens.innerText(), /×$/);
    assert.equal(await page.locator('#miFly').getAttribute('aria-pressed'), 'true');
    await page.reload();
    await lens.waitFor();
    assert.ok(Math.abs(await actualFov() - custom) < 0.001);
    await lens.tap();
    await page.locator('#fabMode').tap();
    assert.equal(await slider.isVisible(), false);
    await page.locator('#mi2d').tap();
    assert.equal(await lens.isVisible(), false);
    await page.locator('#fabMode').tap(); await page.locator('#mi3d').tap();
    await page.waitForFunction(expected => App.viewer.scene.mode === Cesium.SceneMode.SCENE3D &&
      Math.abs(Cesium.Math.toDegrees(App.viewer.camera.frustum.fov) - expected) < 0.001, custom);
    await page.setViewportSize({width: 1024, height: 768});
    assert.equal(await lens.isVisible(), true);
    const desktop = await browser.newPage({ viewport: { width: 1200, height: 768 }, storageState: await page.context().storageState() });
    try {
      await desktop.goto(new URL('?nosplat&nomodel', base).href);
      await desktop.locator('#fovSl').waitFor();
      assert.equal(await desktop.locator('#lensTools').isVisible(), false);
      assert.equal(await desktop.locator('#fovSl').inputValue(), String(custom));
      assert.ok(await desktop.evaluate(expected => Math.abs(Cesium.Math.toDegrees(App.viewer.camera.frustum.fov) - expected) < 0.001, custom));
    } finally { await desktop.close(); }
    console.log('PASS one-tap camera zoom at 773×1011, touch and keyboard fine adjustment, shared plan FOV, persistence and desktop slider');
  } finally { await page.close(); }
}
try { await run(false); await run(true); await checkPhoneZoom(); } finally { await browser.close(); }
