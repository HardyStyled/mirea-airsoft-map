import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ['--enable-unsafe-swiftshader'] });
const base = process.env.MAP_URL || 'http://127.0.0.1:8173/';
const cache = 'mam.weather.site.v2';
const now = Date.now();
const current = { time: Math.floor(now / 1000), temperature_2m: 8, wind_speed_10m: 4.2, wind_direction_10m: 315, weather_code: 73, is_day: 1 };
const arrowAngle = loc => loc.evaluate(el => {
  const matrix = new DOMMatrix(getComputedStyle(el).transform);
  return (Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) + 360) % 360;
});
let calls = 0;
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
  let response = current;
  await page.route('https://api.open-meteo.com/**', route => {
    calls++;
    const params = new URL(route.request().url()).searchParams;
    assert.equal(params.get('wind_speed_unit'), 'ms');
    assert.equal(params.get('latitude'), '55.67297');
    assert.equal(params.get('longitude'), '37.48086');
    assert.match(params.get('current'), /weather_code,is_day/);
    return response ? route.fulfill({ json: { current: response } }) : route.abort();
  });
  const url = new URL(base);
  url.searchParams.set('nogl', '1');
  await page.goto(url.href);
  const menu = page.getByRole('button', { name: 'Меню настроек' });
  const widget = page.locator('#weatherWidget');
  const dialog = page.getByRole('dialog', { name: 'Погода', exact: true });
  const open = async () => {
    await menu.tap();
    await page.getByRole('menuitem', { name: 'Погода' }).tap();
    await dialog.waitFor();
  };
  const close = () => dialog.getByRole('button', { name: 'Закрыть погоду' }).click();
  await widget.getByText('4,2 м/с').waitFor();
  assert.match(await widget.innerText(), /Снег/);
  assert.equal(await widget.locator('.sky-icon use').getAttribute('href'), '#sky-snow');
  assert.equal(await widget.locator('#wxDirection').innerText(), 'СЗ');
  assert.equal(calls, 1);
  await widget.tap();
  await dialog.getByText('Ветер 4,2 м/с, с северо-запада на юго-восток').waitFor();
  assert.match(await dialog.getByRole('status').innerText(), /МСК/);
  assert.equal(await arrowAngle(widget.locator('#wxArrow')), 135);
  assert.match(await dialog.locator('footer').innerText(), /Источник данных — Open-Meteo/);
  assert.equal(await dialog.getByRole('link', { name: 'Open-Meteo' }).getAttribute('href'), 'https://open-meteo.com/');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await widget.evaluate(el => el === document.activeElement), true);
  await open();
  await dialog.getByText('Ветер 4,2 м/с, с северо-запада на юго-восток').waitFor();
  assert.equal(calls, 1);
  await close();

  await page.evaluate(([key, data]) => sessionStorage.setItem(key, JSON.stringify(data)), [
    cache, { ...current, time: current.time - 3600, fetchedAt: now - 3600000 },
  ]);
  response = null;
  await page.reload();
  await widget.getByRole('img', {name: 'Архивная погода'}).waitFor();
  await open();
  await dialog.getByText(/Не удалось обновить/).waitFor();
  assert.match(await dialog.innerText(), /на юго-восток/);
  response = { ...current, wind_speed_10m: 0, wind_direction_10m: null };
  await dialog.getByRole('button', { name: 'Повторить запрос' }).tap();
  await dialog.getByText('Штиль · 0 м/с').waitFor();
  await widget.getByText('Штиль').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#wxArrow').isVisible(), false);
  await close();
  await page.evaluate(key => sessionStorage.removeItem(key), cache);
  response = { ...current, temperature_2m: null };
  await page.reload();
  await widget.getByText('Нет данных').waitFor();
  await open();
  await dialog.getByText(/Погода сейчас недоступна/).waitFor();
  assert.equal(await page.locator('#weatherData').isVisible(), false);
  await close();
  await page.evaluate(key => sessionStorage.removeItem(key), cache);
  response = { ...current, wind_speed_10m: 1, wind_direction_10m: 180 };
  await page.reload();
  await widget.getByText('1 м/с', {exact:true}).waitFor();
  assert.equal(await widget.locator('#wxDirection').innerText(), 'Ю');
  assert.equal(await arrowAngle(page.locator('#wxArrow')), 0);
  for (const [code, day, text, icon] of [[0, 0, 'Ясно', 'moon'], [0, 1, 'Ясно', 'sun'], [2, 0, 'С облаками', 'cloud-moon'], [63, 1, 'Дождь', 'rain'], [95, 1, 'Гроза', 'storm'], [999, 1, 'Нет сводки', 'unknown']]) {
    await page.evaluate(key => sessionStorage.removeItem(key), cache);
    response = { ...current, weather_code: code, is_day: day };
    await page.reload();
    await widget.getByText(text, { exact: true }).waitFor();
    assert.equal(await widget.locator('.sky-icon use').getAttribute('href'), '#sky-' + icon);
  }
  await page.close();
  const scene = await browser.newPage({ viewport: { width: 900, height: 650 } });
  await scene.route('https://api.open-meteo.com/**', r => r.fulfill({ json: { current: { ...current, wind_direction_10m: 0 } } }));
  await scene.goto(new URL('?nomodel&nosplat&nocol', base).href);
  await scene.getByRole('button', { name: 'Открыть 3D', exact: true }).click();
  await scene.getByRole('button', { name: /Режим просмотра/ }).click();
  await scene.getByRole('menuitemradio', { name: /^3D \+/ }).click();
  const north = scene.locator('#wxArrow'), view = scene.locator('#wxCameraArrow');
  assert.equal(await north.isVisible(), false);
  await scene.locator('#weatherWidget').click();
  assert.equal(await scene.locator('#weatherFrames').count(), 0);
  assert.equal(await scene.getByRole('dialog').getByRole('heading').count(), 0);
  assert.match(await scene.locator('#weatherWind').innerText(), /с севера на юг/);
  await scene.keyboard.press('Escape');
  assert.equal(await view.isVisible(), true);
  for (const [heading, screenAngle] of [[0, 180], [90, 90], [180, 0], [270, 270], [359, 181]]) {
    await scene.evaluate(deg => {
      const pos = App.viewer.camera.positionCartographic;
      App.CAM.setPose({ lon: Cesium.Math.toDegrees(pos.longitude), lat: Cesium.Math.toDegrees(pos.latitude), h: pos.height, heading: deg, pitch: -15 });
    }, heading);
    await scene.waitForFunction(expected => document.documentElement.style.getPropertyValue('--wind-view-angle') === expected + 'deg', screenAngle);
    assert.equal(await scene.evaluate(() => document.documentElement.style.getPropertyValue('--wind-north-angle')), '180deg');
    assert.equal(await arrowAngle(view), screenAngle);
  }
  await scene.keyboard.press('1');
  assert.equal(await north.isVisible(), false);
  assert.equal(await view.isVisible(), true);
  await scene.keyboard.press('3');
  assert.equal(await north.isVisible(), true);
  assert.equal(await view.isVisible(), false);
  console.log('PASS weather: site coordinates, day/night icons, wind in plan/3D/split, details, cache, offline, retry and calm');
} finally { await browser.close(); }
