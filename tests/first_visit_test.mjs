import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.MAP_URL || 'http://127.0.0.1:8173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: ['--enable-unsafe-swiftshader'],
});

async function visit(touch, fallback = false) {
  const page = await browser.newPage({
    viewport: touch ? { width: 390, height: 844 } : { width: 1366, height: 768 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const find = (role, name) => page.getByRole(role, { name });
  const use = loc => touch ? loc.tap() : loc.click();
  const plan = page.getByLabel(/^2D-план полигона/);
  const center = find('button', 'Вернуть план к центру');
  const menu = find('button', 'Меню настроек');
  const readout = () => page.locator('.readout').evaluate(el => [
    el.innerText, el.querySelector('#sbarBar').getBoundingClientRect().width,
  ]);
  const openHelp = async () => {
    await use(menu);
    await use(find('menuitem', 'Управление'));
    return find('dialog', 'Управление');
  };
  try {
    const url = new URL(base);
    if (fallback) url.searchParams.set('nogl', '1');
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    if (!fallback) {
      const welcome = find('dialog', 'Карта полигона МИРЭА');
      await welcome.waitFor();
      assert.match(await welcome.innerText(), touch ? /пальцем/ : /левой кнопкой/);
      assert.equal(await welcome.getByRole('region').count(), 0);
      assert.equal(await welcome.getByRole('button').count(), 2);
      assert.equal(await welcome.getByRole('button', { name: 'Открыть 3D' }).evaluate(el => el === document.activeElement), true);
      await use(welcome.getByRole('button', { name: touch ? 'Открыть план' : 'Открыть 3D' }));
      if (touch) {
        await use(find('button', /^Режим просмотра:/));
        await use(find('menuitemradio', /^3D$/));
      }
      const mini = find('button', 'Открыть 3D и план');
      assert.equal((await mini.innerText()).trim(), '', 'мини-карта должна показывать только план');
      await page.waitForFunction(() => Math.abs(App.mmPlan.mpp * App.mmPlan.c.clientWidth - 26) < 0.1);
      const camera = () => page.evaluate(() => [App.viewer.camera.heading, App.viewer.camera.pitch,
        ...['x', 'y', 'z'].map(k => App.viewer.camera.positionWC[k])]);
      const startingCamera = await camera();
      if (touch) {
        const { width, height } = await mini.boundingBox();
        await mini.tap({ position: { x: Math.floor(width * 0.75), y: Math.floor(height * 0.35) } });
      } else await mini.press('Enter');
      await page.locator('body.split3d').waitFor();
      assert.equal(await mini.isVisible(), false);
      assert.equal(await plan.evaluate(el => el === document.activeElement), true);
      const view = () => page.evaluate(() => ({ center: App.plan.center, mpp: App.plan.mpp }));
      const start = await view();
      const zoomIn = find('button', 'Приблизить план');
      const zoomOut = find('button', 'Отдалить план');
      await use(zoomIn);
      assert.ok((await view()).mpp < start.mpp);
      await use(zoomOut);
      assert.ok(Math.abs((await view()).mpp - start.mpp) < 1e-9);
      await plan.press('ArrowRight');
      await use(zoomIn);
      await use(zoomIn);
      const chosen = await view();
      assert.notDeepEqual(chosen.center, start.center);
      const expand = find('button', 'Весь план');
      const split = find('button', '3D + план');
      const back = find('button', 'К мини-карте');
      const returnToMini = async () => {
        await use(back);
        await page.locator('body.full3d').waitFor();
        assert.equal(await mini.evaluate(el => el === document.activeElement), true);
        const returned = await camera();
        const delta = returned.map((value, i) => value - startingCamera[i]);
        assert.ok(delta.every(d => Math.abs(d) < 1e-4), '3D camera changed (radians and metres): ' + delta);
        await use(mini);
        await page.locator('body.split3d').waitFor();
        assert.deepEqual(await view(), chosen);
      };
      if (touch) {
        const portrait = page.viewportSize();
        await page.setViewportSize({ width: 932, height: 430 });
        const sceneBox = await page.locator('#map').boundingBox(), planBox = await plan.boundingBox();
        assert.equal(sceneBox.y, 0);
        assert.equal(sceneBox.height, 215);
        assert.equal(planBox.y, sceneBox.height);
        assert.equal(planBox.height, sceneBox.height);
        await use(zoomIn);
        assert.ok((await view()).mpp < chosen.mpp);
        await use(zoomOut);
        await returnToMini();
        await page.setViewportSize(portrait);
      } else await returnToMini();
      await use(expand);
      await returnToMini();
      await use(expand);
      await page.locator('body.pure2d').waitFor();
      assert.equal(await page.evaluate(() => App.plan.cam), null);
      assert.deepEqual(await view(), chosen);
      await use(split);
      await page.locator('body.split3d').waitFor();
      assert.deepEqual(await view(), chosen);
      for (let i = 0; i < 40 && await zoomOut.isEnabled(); i++) await use(zoomOut);
      assert.equal(await zoomOut.isDisabled(), true);
      const widest = await view();
      await use(expand);
      assert.deepEqual((await view()).center, widest.center);
      await use(split);
      assert.deepEqual(await view(), widest);
      await use(expand);
      await use(center);
    }
    await center.waitFor();
    assert.equal(await find('button', /Камера/).count(), 0);
    assert.equal(await page.getByRole('menu').count(), 0);
    const initial = await readout();
    if (touch) {
      const cdp = await page.context().newCDPSession(page);
      const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await send('touchStart', [{ x: 180, y: 400 }]);
      await send('touchMove', [{ x: 240, y: 480 }]);
      await send('touchEnd', []);
      await send('touchStart', [{ x: 140, y: 400, id: 1 }, { x: 220, y: 400, id: 2 }]);
      await send('touchMove', [{ x: 100, y: 400, id: 1 }, { x: 260, y: 400, id: 2 }]);
      await send('touchEnd', []);
      await cdp.detach();
    } else {
      await plan.press('ArrowRight');
      await plan.press('+');
    }
    const moved = await readout();
    assert.notEqual(moved[0], initial[0]);
    assert.notEqual(moved[1], initial[1]);
    await use(center);
    assert.deepEqual(await readout(), initial);
    const marker = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('mam.planMarker')));
    const markerMenu = async name => {
      await use(menu);
      await use(find('menuitem', name));
    };
    await markerMenu('Поставить фигурку на план');
    const target = { x: 165, y: 260 };
    if (touch) await plan.tap({ position: target });
    else await plan.click({ position: target });
    const firstPoint = await marker();
    assert.equal(firstPoint?.length, 2);
    const pixel = await plan.evaluate((el, at) => {
      const box = el.getBoundingClientRect();
      const x = Math.round((at.x + 7) * el.width / box.width);
      const y = Math.round((at.y - 17) * el.height / box.height);
      return Array.from(el.getContext('2d').getImageData(x, y, 1, 1).data);
    }, target);
    assert.deepEqual(pixel, [80, 59, 146, 255]);
    await markerMenu('Переставить фигурку на плане');
    await use(find('button', 'Отмена'));
    assert.deepEqual(await marker(), firstPoint);
    await markerMenu('Переставить фигурку на плане');
    await plan.press('ArrowLeft');
    assert.deepEqual(await marker(), firstPoint);
    await plan.press('Enter');
    assert.notDeepEqual(await marker(), firstPoint);
    await markerMenu('Убрать фигурку');
    assert.equal(await marker(), null);
    await use(menu);
    assert.equal(await find('group', 'Качество 3D').count(), 0);
    const helpItem = find('menuitem', 'Управление');
    if (!touch) {
      await find('menuitemradio', 'Схема').press('ArrowDown');
      assert.equal(await helpItem.evaluate(el => el === document.activeElement), true);
    }
    await use(helpItem);
    const help = find('dialog', 'Управление');
    assert.match(await help.innerText(), /К центру/);
    assert.doesNotMatch(await help.innerText(), /Полёт|WASD/);
    const mouseTab = help.getByRole('tab', { name: 'Мышь и клавиатура' });
    const touchTab = help.getByRole('tab', { name: 'Сенсорный экран' });
    const nativeTab = touch ? touchTab : mouseTab;
    const panel = help.getByRole('tabpanel');
    assert.equal(await nativeTab.getAttribute('aria-selected'), 'true');
    assert.equal(await panel.count(), 1);
    if (touch) await mouseTab.tap();
    else await nativeTab.press('End');
    assert.equal(await (touch ? mouseTab : touchTab).getAttribute('aria-selected'), 'true');
    assert.match(await panel.innerText(), touch ? /колесо мыши/ : /два пальца/);
    if (touch) {
      const bounds = await panel.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const point = { x: bounds.x + bounds.width * 0.8, y: bounds.y + 40 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x - 100 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await touchTab.press('ArrowLeft');
      assert.equal(await mouseTab.evaluate(el => el === document.activeElement), true);
      await mouseTab.press('Tab');
      assert.equal(await panel.evaluate(el => el === document.activeElement), true);
    }
    assert.equal(await nativeTab.getAttribute('aria-selected'), 'true');
    await use(help.getByRole('button', { name: 'Вернуться к карте' }));
    await help.waitFor({ state: 'hidden' });
    if (!fallback) {
      await use(find('button', /^Режим просмотра:/));
      await use(find('menuitemradio', /^3D \+/));
      assert.equal(await page.getByRole('menu').count(), 0);
      const orbit = find('button', 'Орбита'), fly = find('button', 'Свободная камера');
      assert.equal(await orbit.getAttribute('aria-pressed'), 'true');
      await use(fly);
      assert.equal(await fly.getAttribute('aria-pressed'), 'true');
      assert.equal(await orbit.getAttribute('aria-pressed'), 'false');
      await use(orbit);
      assert.equal(await orbit.getAttribute('aria-pressed'), 'true');
      await use(fly);
      assert.equal(await page.getByRole('menu').count(), 0);
      const run = find('button', 'Ускорение ×4');
      if (touch) {
        await use(run);
        assert.equal(await run.getAttribute('aria-pressed'), 'true');
      }
      const flightHelp = await openHelp();
      assert.match(await flightHelp.innerText(), touch ? /джойстик/ : /правой кнопкой/);
      assert.doesNotMatch(await flightHelp.innerText(), /центр вращения/);
      await use(flightHelp.getByRole('button', { name: 'Вернуться к карте' }));
      if (touch) assert.equal(await run.getAttribute('aria-pressed'), 'false');
      await page.reload();
      await page.waitForFunction(() => window.App?.frames > 1 && !!App.viewer.splats?.show);
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log('PASS first visit:', touch ? 'touch' : 'desktop', fallback ? '2D fallback' : '3D and plan');
  } finally { await page.close(); }
}

try {
  await visit(false);
  await visit(true);
  await visit(true, true);
} finally { await browser.close(); }
