// Run against the served app. MAP_URL, NODE_PATH and CHROMIUM_EXECUTABLE_PATH can select the test environment.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: ['--enable-unsafe-swiftshader'],
});
const base = process.env.MAP_URL || 'http://127.0.0.1:8173/';
const planView = page => page.evaluate(() => [...App.plan.center, App.plan.mpp]);

async function checkRecovery(initial, failure, split) {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  let loads = 0;
  page.on('pageerror', err => errors.push(err.message));
  page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loads++; });
  try {
    if (failure === 'context') {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
          return /webgl/.test(kind) ? null : original.call(this, kind, ...options);
        };
      });
    }
    const url = new URL(base);
    url.search = 'nomodel&nosplat&nocol';
    if (initial !== 'contextloss') url.searchParams.set(initial, '1');
    url.hash = 'recovery';
    await page.goto(url.href);
    if (initial === 'contextloss') {
      await page.locator('#tut[open]').waitFor();
      await page.evaluate(() => App.viewer.canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    }
    await page.waitForFunction(() => window.App?.noGl && App.plan && App.mode === '2d');
    assert.equal(await page.locator('#tut').evaluate(el => el.open), false);
    assert.equal(await page.locator('#toast.show').count(), 0);
    // An older build may have written the fallback as the user's preferred view.
    await page.evaluate(() => {
      const old = JSON.stringify({ mode: '2d', split: false });
      localStorage.setItem('mam.view', old);
      sessionStorage.setItem('mam.view', old);
    });
    if (failure === 'context') {
      await page.locator('#fabSet').click();
      await page.locator('#miOrtho').click();
      await page.waitForFunction(() => App.baseName === 'ortho');
    }
    await page.locator('#plan').press('ArrowRight');
    await page.locator('#plan').press('+');
    const saved = await planView(page);
    await page.locator('#fabMode').click();
    assert.match(await page.locator('#mi3d').innerText(), /Повторить 3D/);
    assert.equal(await page.locator('#mi3d').isEnabled(), true);
    assert.equal(await page.locator('#miSplit').isEnabled(), true);
    await Promise.all([page.waitForNavigation(), page.locator(split ? '#miSplit' : '#mi3d').click()]);
    if (failure === 'render') {
      await page.waitForFunction(() => window.App?.frames > 0 && App.mode === '3d');
      await page.evaluate(() => App.viewer.scene.renderError.raiseEvent(App.viewer.scene, 'проверка повторного сбоя'));
    }
    if (failure) {
      await page.waitForFunction(() => window.App?.noGl && App.mode === '2d' && App.plan);
      assert.deepEqual(await planView(page), saved);
      if (failure === 'context') await page.waitForFunction(() => App.baseName === 'ortho');
      await page.locator('#plan').press('ArrowLeft');
      assert.notDeepEqual(await planView(page), saved);
    } else {
      await page.waitForFunction(split => window.App?.frames > 1 && !App.noGl && App.mode === '3d' &&
        App.split === split && document.body.classList.contains(split ? 'split3d' : 'full3d'), split);
      assert.equal(await page.locator('#map canvas').isVisible(), true);
      if (split) assert.deepEqual(await planView(page), saved);
    }
    const after = new URL(page.url());
    assert.equal(after.searchParams.has(initial), false);
    assert.equal(after.searchParams.has('nocol'), true);
    assert.equal(after.hash, '#recovery');
    // Wait past the diagnostic render error and the next watchdog tick.
    await page.waitForTimeout(1250);
    assert.equal(loads, 2);
    assert.equal(await page.locator('#tut').evaluate(el => el.open), false);
    assert.equal(await page.locator('#toast.show').count(), 0);
    assert.equal(await page.locator('.cesium-widget-errorPanel').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS', initial, '→', split ? 'split' : '3D', failure || 'recovered');
  } finally {
    await page.close();
  }
}

async function checkSplatRecovery() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    // A repeatable renderer fault tied to the chosen asset, including on the new viewer.
    await page.addInitScript(() => {
      localStorage.setItem('mam.tut', '1');
      const failSplats = () => {
        if (window.App?.viewer?.splats?.show) {
          App.viewer.scene.renderError.raiseEvent(App.viewer.scene, 'сбой при показе сплатов');
        } else requestAnimationFrame(failSplats);
      };
      requestAnimationFrame(failSplats);
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.App?.noGl && App.viewer.splats?.show);
    await page.locator('#fabMode').click();
    await Promise.all([page.waitForNavigation(), page.locator('#mi3d').click()]);
    await page.waitForFunction(() => window.App?.frames > 1 && App.viewer.tileset?.show && !App.noGl);
    assert.equal(await page.evaluate(() => !!App.viewer.splats), false);
    assert.equal(await page.locator('#map canvas').isVisible(), true);
    console.log('PASS splat render error → 3D model');
  } finally {
    await page.close();
  }
}

async function checkFailedSplatLoad(cancel) {
  const page = await browser.newPage();
  let finishRequest;
  const gate = new Promise(resolve => { finishRequest = resolve; });
  try {
    await page.route(/\/splats?\/tileset\.json$/, async route => {
      await gate;
      await route.fulfill({ status: 404, body: '' });
    });
    const requested = page.waitForRequest(request => /\/splats?\/tileset\.json$/.test(request.url()));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await requested;
    assert.equal(await page.locator('#chunkStatus').isVisible(), false);
    if (cancel) {
      await page.locator('#fabMode').click();
      await page.locator('#mi2d').click();
    }
    finishRequest();
    if (cancel) {
      await page.waitForFunction(() => App.mode === '2d' && !document.querySelector('#miAssetSplat .lbl').textContent.endsWith('…'));
      assert.equal(await page.locator('#tut').evaluate(el => el.open), false);
      assert.equal(await page.locator('#toast.show').count(), 0);
    } else await page.locator('#tut[open]').waitFor();
    assert.equal(await page.evaluate(() => !!App.viewer.tileset?.show), !cancel);
    assert.equal(await page.evaluate(() => !!App.viewer.splats), false);
    console.log('PASS missing splat →', cancel ? 'user choice preserved' : '3D model');
  } finally {
    finishRequest();
    await page.close();
  }
}

try {
  await checkRecovery('nogl', null, false);
  await checkRecovery('failrender', null, true);
  await checkRecovery('nogl', 'context', true);
  await checkRecovery('failrender', 'render', false);
  await checkRecovery('contextloss', null, false);
  await checkSplatRecovery();
  await checkFailedSplatLoad(false);
  await checkFailedSplatLoad(true);
} finally {
  await browser.close();
}
