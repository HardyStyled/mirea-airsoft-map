/* что здесь живёт: виджет погоды района и его подробная карточка. */
import { App } from './state.js?v=33';
import { $ } from './dom.js?v=33';
import { SITE_MID } from './config.js?v=33';

const [lon, lat] = SITE_MID;
const endpoint = new URL('https://api.open-meteo.com/v1/forecast');
endpoint.search = new URLSearchParams({
  latitude: lat.toFixed(5), longitude: lon.toFixed(5), wind_speed_unit: 'ms', timeformat: 'unixtime',
  current: 'temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day',
});
const cacheKey = 'mam.weather.site.v2';
const refreshAfter = 15 * 60 * 1000;
const oldestSample = 24 * 60 * 60 * 1000;
const towards = ['на север', 'на северо-восток', 'на восток', 'на юго-восток', 'на юг', 'на юго-запад', 'на запад', 'на северо-запад'];
const from = ['с севера', 'с северо-востока', 'с востока', 'с юго-востока', 'с юга', 'с юго-запада', 'с запада', 'с северо-запада'];
const compass = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
// Краткая подпись нужна на карте, уточнение помещается в раскрытой карточке.
const conditions = [
  [[0], 'Ясно', 'sun'], [[1], 'Малооблачно', 'cloud-sun'], [[2], 'С облаками', 'cloud-sun', 'Переменная облачность'],
  [[3], 'Пасмурно', 'cloud'], [[45, 48], 'Туман', 'fog'],
  [[51, 53, 55], 'Морось', 'rain'], [[56, 57], 'Морось', 'rain', 'Переохлаждённая морось'],
  [[61, 63], 'Дождь', 'rain'], [[65], 'Дождь', 'rain', 'Сильный дождь'],
  [[66, 67], 'Лед. дождь', 'rain', 'Ледяной дождь'], [[80, 81, 82], 'Ливень', 'rain'],
  [[71, 73], 'Снег', 'snow'], [[75, 85, 86], 'Снегопад', 'snow'], [[77], 'Крупа', 'snow', 'Снежная крупа'],
  [[95, 97], 'Гроза', 'storm'], [[96, 99], 'Град', 'storm', 'Гроза с градом'],
];
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
let sample;
try { sample = JSON.parse(sessionStorage.getItem(cacheKey)); } catch {}
let pending = false;
let flowBearing = null;
let lastAngle = null;
function conditionOf(data) {
  const [, label, symbol, detail = label] = conditions.find(([codes]) => codes.includes(data.weather_code)) ||
    [[], 'Нет сводки', 'unknown', 'Состояние погоды неизвестно'];
  const icon = data.is_day === 0 ? symbol.replace('sun', 'moon') : symbol;
  return { label, icon, detail };
}

export function updateWindHeading() {
  if (flowBearing === null || App.mode !== '3d' || App.noGl || !App.viewer) return;
  const heading = App.viewer.camera.heading * 180 / Math.PI;
  if (!Number.isFinite(heading)) return;
  const angle = (Math.round(flowBearing - heading) % 360 + 360) % 360;
  if (angle === lastAngle) return;
  lastAngle = angle;
  document.documentElement.style.setProperty('--wind-view-angle', angle + 'deg');
}

function usable(data) {
  const age = Date.now() - data?.time * 1000;
  return Number.isFinite(age) && age >= -refreshAfter && age <= oldestSample &&
    Number.isFinite(data.temperature_2m) && Number.isFinite(data.wind_speed_10m) && data.wind_speed_10m >= 0;
}

function showSample(data, offline = false) {
  const widget = $('weatherWidget');
  $('weatherData').hidden = !data;
  $('wxWind').hidden = !data;
  const saved = data && (offline || Date.now() - data.time * 1000 > 3600000);
  $('wxArchive').toggleAttribute('hidden', !saved);
  const sky = data && conditionOf(data);
  for (const icon of document.querySelectorAll('.sky-icon')) {
    icon.toggleAttribute('hidden', !data);
    if (sky) {
      icon.dataset.sky = sky.icon;
      icon.querySelector('use').setAttribute('href', '#sky-' + sky.icon);
    }
  }
  $('wxLabel').textContent = sky?.label || 'Погода';
  if (!data) {
    flowBearing = null;
    $('wxFrames').hidden = true;
    const message = offline ? 'Нет данных' : 'Загрузка…';
    $('wxTemp').textContent = message;
    widget.title = message;
    $('welcomeSummary').textContent = offline ? 'Погода сейчас недоступна' : 'Загружаем погоду…';
    widget.setAttribute('aria-label', 'Погода. ' + message + ' Открыть подробности');
    return;
  }
  const temperature = number.format(data.temperature_2m);
  $('weatherTemp').textContent = temperature;
  $('weatherCondition').textContent = sky.detail;
  $('wxTemp').textContent = temperature + '°';
  const speed = data.wind_speed_10m;
  const degrees = data.wind_direction_10m;
  const hasDirection = Number.isFinite(degrees) && degrees >= 0 && degrees <= 360 && speed > 0;
  // Open-Meteo даёт азимут источника. В интерфейсе стрелка направлена по движению воздуха.
  flowBearing = hasDirection ? (degrees + 180) % 360 : null;
  const sector = hasDirection ? Math.round(flowBearing / 45) % 8 : null;
  const sourceSector = hasDirection ? Math.round(degrees / 45) % 8 : null;
  const windSpeed = number.format(speed) + ' м/с';
  const wind = speed === 0 ? 'Штиль · 0 м/с' : 'Ветер ' + windSpeed + (hasDirection ? ', ' + from[sourceSector] + ' ' + towards[sector] : '');
  const summary = (saved ? 'Сохранено · ' : '') + sky.detail + ' · ' + temperature + ' °C · ' + wind;
  $('welcomeSummary').textContent = summary;
  $('weatherWind').textContent = wind;
  $('wxSpeed').textContent = windSpeed;
  const shortDirection = speed === 0 ? 'Штиль' : hasDirection ? compass[sourceSector] : 'Ветер';
  $('wxDirection').textContent = shortDirection;
  widget.setAttribute('aria-label', 'Погода. ' + summary + '. Открыть подробности');
  widget.title = summary + (hasDirection ? '. Стрелка показывает, куда дует ветер.' : '');
  $('wxFrames').hidden = !hasDirection;
  if (hasDirection) {
    document.documentElement.style.setProperty('--wind-north-angle', flowBearing + 'deg');
    updateWindHeading();
  }
}

async function refresh() {
  if (pending) return;
  const previous = usable(sample) ? sample : null;
  const stamp = data => time.format(data.time * 1000) + ' МСК';
  const status = $('weatherStatus');
  $('weatherRetry').hidden = true;
  showSample(previous);
  if (previous && Date.now() >= previous.fetchedAt && Date.now() - previous.fetchedAt < refreshAfter) {
    status.textContent = 'Данные на ' + stamp(previous);
    return;
  }
  status.textContent = 'Обновляем погоду…';
  pending = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) throw new Error('weather unavailable');
    const { current } = await response.json();
    if (!usable(current)) throw new Error('invalid sample');
    sample = { ...current, fetchedAt: Date.now() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(sample)); } catch {}
    showSample(current);
    status.textContent = 'Данные на ' + stamp(current);
  } catch {
    showSample(previous, true);
    status.textContent = previous ? 'Не удалось обновить. Сохранено на ' + stamp(previous) : 'Погода сейчас недоступна. Попробуйте ещё раз.';
    $('weatherRetry').hidden = false;
  } finally {
    pending = false;
    clearTimeout(timer);
  }
}

export function openWeather() {
  App.CAM?.setLocked(true);
  $('weather').showModal();
  refresh();
}

$('weatherRetry').addEventListener('click', refresh);
$('weatherWidget').addEventListener('click', openWeather);
$('weather').addEventListener('close', () => App.CAM?.setLocked(false));
// Горячие клавиши карты не должны менять вид за диалогом. Escape закрывает его штатно.
$('weather').addEventListener('keydown', event => event.stopPropagation());

function refreshIfVisible() {
  if (!document.hidden) refresh();
}
refreshIfVisible();
setInterval(refreshIfVisible, refreshAfter);
document.addEventListener('visibilitychange', refreshIfVisible);
window.addEventListener('online', refreshIfVisible);
