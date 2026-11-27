/* Run with playwright-core on the Node module path and a Chromium installation.
 * CHROMIUM_EXECUTABLE_PATH can select an existing browser. The fixture uses the
 * real HTML, fonts and styles; only the async application state is supplied here. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
const failures = new Map();
let cases = 0;
try {
  const viewports = [
    [1440, 900, false], [1024, 768, false], [1024, 500, false], [768, 1024, true],
    [844, 390, true], [667, 375, true], [568, 320, true], [390, 844, true], [320, 568, true],
    [360, 740, true], [375, 667, true], [390, 1011, true], [412, 915, true], [932, 430, true],
    [693, 1011, false], [924, 1011, false], [924, 1011, true], [390, 844, false],
    [381, 740, true], [393, 608, true], [430, 740, true],
    [773, 1011, true], [773, 1011, false], [740, 600, true], [740, 400, false], [900, 1011, false], [901, 1011, false],
    [568, 320, true, [0, 44, 21]],
    [844, 390, true, [0, 44, 21]], [390, 844, true, [47, 8, 34]], [320, 568, true, [20, 8, 34]],
  ];
  for (const [width, height, touch, insets] of viewports) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, reducedMotion: 'reduce' });
    await page.route('**/*.js*', route => route.abort());
    await page.goto(new URL('../index.html', import.meta.url).href);
    if (insets) {
      const [top, side, bottom] = insets;
      await page.addStyleTag({ content: `:root{--safe-t:${top}px;--safe-l:${side}px;--safe-r:${side}px;--safe-b:${bottom}px}` });
    }
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(({ touch, safeLeft }) => {
      const id = value => document.getElementById(value);
      const phoneControls = matchMedia('(max-width: 640px), (pointer: coarse) and (max-height: 500px)').matches;
      const cameraZoomRow = touch || innerWidth <= 640 || (innerWidth <= 900 && innerHeight >= innerWidth);
      const menus = [...document.querySelectorAll('.menu')];
      const planActions = document.querySelector('.plan-actions');
      const tested = [...document.querySelectorAll('.menu, .fab, #miniNav, #mm, #dbg, #stat, #perfNotice, #chunkStatus, .readout, #speedTag, #stick, #flyBtns, #fovCtl, #flyCross, #toast, #weatherWidget, #markerPrompt, #camTools')];
      id('wxWind').hidden = false;
      id('wxFrames').hidden = false;
      id('weatherWidget').querySelector('.sky-icon').removeAttribute('hidden');
      id('wxLabel').textContent = 'Малооблачно';
      id('wxTemp').textContent = '−18,5°';
      id('wxSpeed').textContent = '12,5 м/с';
      id('wxDirection').textContent = 'СЗ';
      id('wxArchive').removeAttribute('hidden');
      id('chunkText').textContent = 'Загрузка 3D-модели · 128 фрагментов';
      id('perfTitle').textContent = '3D загружается дольше обычного';
      id('perfBody').textContent = 'Похоже, соединение медленное. Рекомендуем открыть 2D или выбрать низкое качество в настройках 3D.';
      id('dbgCam').textContent = '00.000000, 00.000000 · +123.0 м';
      id('dbgAngles').textContent = 'курс 180° · наклон -45° · крен 0°';
      id('dbgCanvas').textContent = '1200×600 px · DPR 2';
      id('stat').textContent = '2D без 3D: WebGL недоступен';
      id('roCoord').textContent = '00.000000, 00.000000 · план';
      id('sbarBar').style.width = '135px';
      id('toast').textContent = 'Не удалось загрузить карту. Попробуйте ещё раз.';
      const errors = new Map();
      let count = 0;
      for (const layout of ['full3d', 'full3d mini-collapsed', 'split3d', 'pure2d', 'nogl pure2d']) {
        const mode = layout.replace(' mini-collapsed', '');
        const has3d = mode.endsWith('3d');
        let cameraBox;
        for (const fly of has3d ? [false, true] : [false]) {
          let speedPosition;
          for (const menu of [null, ...menus]) {
            for (const state of ['idle', 'loading', 'warning', 'busy', 'error']) {
              document.body.className = [layout, state === 'busy' ? 'dbg' : '', state === 'error' ? 'data-error' : '', fly && touch ? 'flytouch' : ''].join(' ');
              document.body.dataset.cameraMode = fly ? 'fly' : 'orbit';
              id('speedTag').hidden = !fly || touch;
              id('markerPrompt').hidden = has3d || state !== 'busy';
              id('chunkStatus').hidden = !has3d || !['loading', 'busy'].includes(state);
              id('perfNotice').hidden = !has3d || !['warning', 'busy'].includes(state);
              id('toast').classList.toggle('show', state === 'busy' || state === 'error');
              for (const node of menus) node.classList.toggle('open', node === menu);
              const scenario = [layout, fly ? 'fly' : 'orbit', menu?.id || 'closed', state].join('/');
              const fail = (issue, details) => { if (!errors.has(issue)) errors.set(issue, scenario + ' ' + details); };
              if (mode === 'split3d' && (innerWidth <= 900 || (touch && innerHeight <= 500)) && !menu) {
                const map = id('map').getBoundingClientRect(), plan = id('plan').getBoundingClientRect();
                if (map.top !== 0 || Math.abs(map.height - innerHeight / 2) > 0.5 ||
                    Math.abs(plan.top - map.bottom) > 0.5 || Math.abs(plan.bottom - innerHeight) > 0.5 ||
                    map.width !== innerWidth || plan.width !== innerWidth) fail('incorrect vertical split', '');
                const inside = (el, pane) => {
                  if (!el.checkVisibility()) return;
                  const box = el.getBoundingClientRect();
                  if (box.top < pane.top - 0.5 || box.bottom > pane.bottom + 0.5 ||
                      box.left < pane.left - 0.5 || box.right > pane.right + 0.5)
                    fail('control outside its pane', el.id || el.className);
                };
                for (const name of ['viewDock','fovCtl','flyCross','stick','flyBtns','dbg']) inside(id(name), map);
                inside(document.querySelector('.readout'), plan);
                inside(planActions, plan);
              }
              if (!menu && !fly && state === 'idle') {
                const shape = el => {
                  const css = getComputedStyle(el);
                  return [css.borderRadius, css.cornerShape, css.borderWidth].join(' ');
                };
                const frame = id('fabCol'), frameCss = getComputedStyle(frame);
                const primaryButton = id('fabMode');
                const trays = has3d ? [id('camTools'), ...(cameraZoomRow ? [id('lensTools')] : [])] : [];
                for (const tray of trays) {
                  const css = getComputedStyle(tray);
                  if (shape(tray) !== shape(frame) || css.backgroundImage !== frameCss.backgroundImage ||
                    css.borderColor !== frameCss.borderColor || tray.offsetHeight !== 48)
                    fail('camera tray differs from header style', tray.id);
                }
                const buttons = [...trays.flatMap(el => [...el.querySelectorAll('button')]), ...planActions.querySelectorAll('button')];
                for (const button of buttons.filter(el => el.checkVisibility())) {
                  const css = getComputedStyle(button);
                  if (shape(button) !== shape(primaryButton) || css.backgroundImage !== 'none')
                    fail('inconsistent control shape', button.id || button.textContent);
                }
                if (has3d && cameraZoomRow) {
                  const selected = ['#camTools', '#lensTools'].map(sel => getComputedStyle(document.querySelector(sel + ' [aria-pressed="true"]')));
                  if (['backgroundColor', 'borderColor', 'color'].some(key => selected[0][key] !== selected[1][key]))
                    fail('zoom and camera use different selection styles', '');
                }
              }
              if (fly && !touch) {
                const speed = id('speedTag').getBoundingClientRect();
                if (!speed.width) fail('missing camera speed', '');
                else if (!speedPosition) speedPosition = speed;
                else if (Math.abs(speed.x - speedPosition.x) > 0.5 || Math.abs(speed.y - speedPosition.y) > 0.5) fail('camera speed moved', '');
              }
              const wx = ['wxSpeed', 'wxFrames', 'wxDirection'].map(name => id(name).getBoundingClientRect());
              if (Math.max(...wx.map(b => b.top)) >= Math.min(...wx.map(b => b.bottom))) fail('wind spans multiple lines', '');
              const required = [id('fabMode'), id('fabSet'), id('weatherWidget')];
              if (layout === 'full3d mini-collapsed' && !menu && state === 'idle') {
                const controls = ['miniToggle', 'weatherWidget', 'fabCol'].map(id);
                const [mini, weather, group] = controls.map(node => node.getBoundingClientRect());
                const frame = node => {
                  const s = getComputedStyle(node);
                  return [s.borderRadius, s.cornerShape, s.borderWidth, s.borderColor, s.borderStyle].join(' ');
                };
                if (new Set(controls.map(frame)).size !== 1) fail('inconsistent header frames', controls.map(frame).join(', '));
                if (mini.top !== weather.top || mini.top !== group.top || mini.bottom !== weather.bottom || mini.bottom !== group.bottom)
                  fail('header edges misaligned', [mini, weather, group].map(b => b.top + '–' + b.bottom).join(', '));
                const temp = id('wxTemp').getBoundingClientRect(), wind = id('wxWind').getBoundingClientRect();
                if (innerWidth >= 381 && (temp.right > wind.left || temp.bottom <= wind.top || temp.top >= wind.bottom))
                  fail('temperature and wind misplaced', [temp.right, wind.left, temp.top, wind.top].join(', '));
                if (id('fabMode').querySelector('svg').getBoundingClientRect().top !== id('fabSet').querySelector('svg').getBoundingClientRect().top)
                  fail('menu icons misaligned', '');
                const hud = getComputedStyle(document.querySelector('.hud'));
                if (mini.left < safeLeft || mini.top < parseFloat(hud.top) || group.right > innerWidth - parseFloat(hud.right) ||
                    weather.left - mini.right < 8 || group.left - weather.right < 8)
                  fail('header controls outside safe area or crowded', [mini.left, mini.top, weather.left, group.left, group.right].join(', '));
                for (const button of ['miniToggle', 'weatherWidget', 'fabMode', 'fabSet'].map(id)) {
                  const box = button.getBoundingClientRect();
                  const icon = button.querySelector('svg').getBoundingClientRect();
                  if (box.width < 44 || box.height < 44 || !button.contains(document.elementFromPoint(icon.x + icon.width / 2, icon.y + icon.height / 2)))
                    fail('header icon inaccessible', button.id);
                }
                const bounds = id('fabMode').getBoundingClientRect(), range = document.createRange();
                range.selectNodeContents(id('fabMode').querySelector('.fab-label'));
                if ([...range.getClientRects()].some(r => r.left < bounds.left || r.right > bounds.right || r.bottom > bounds.bottom))
                  fail('view mode label clipped', '');
              }
              if (!menu && mode === 'full3d') {
                const mini = id('miniNav').getBoundingClientRect(), toggle = id('miniToggle'), box = toggle.getBoundingClientRect();
                if (Math.abs(box.left - mini.left) > 0.5 || Math.abs(box.top - mini.top) > 0.5 || box.width < 44 || box.height < 44 ||
                  !toggle.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))) fail('minimap toggle inaccessible', '');
                if (!layout.includes('mini-collapsed')) {
                  const arrow = toggle.querySelector('.mini-hide'), length = arrow.getTotalLength();
                  const start = arrow.getPointAtLength(0), tip = arrow.getPointAtLength(length / 2), end = arrow.getPointAtLength(length);
                  if (tip.x >= start.x || tip.x >= end.x || start.y >= tip.y || end.y <= tip.y) fail('minimap collapse arrow points away from left edge', '');
                }
              }
              for (const name of ['fabMode', 'fabSet']) {
                const trigger = id(name), box = trigger.getBoundingClientRect();
                if (!trigger.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))) fail('menu trigger obstructed', name);
              }
              if (!id('fabCol').contains(id('fabMode')) || id('fabMode').innerText !== 'Режим просмотра') fail('map view missing by settings', '');
              if (!has3d && (!phoneControls || !menu)) required.push(id(phoneControls ? 'planHomeCompact' : 'planHome'));
              if (phoneControls && (menu || has3d) && id('planHomeCompact').checkVisibility()) fail('wrong plan center visible', '');
              if (phoneControls && mode !== 'full3d' && !menu) {
                const plan = id('plan').getBoundingClientRect();
                const actions = planActions.getBoundingClientRect();
                const railRight = plan.right - parseFloat(getComputedStyle(document.querySelector('.hud')).right);
                const fabCol = id('fabCol').getBoundingClientRect();
                const nextToMenu = matchMedia('(orientation: landscape) and (max-height: 500px)').matches &&
                  Math.abs(actions.right - fabCol.left + 8) <= 1;
                if (Math.abs((actions.top + actions.bottom - plan.top - plan.bottom) / 2) > 1 ||
                  (Math.abs(actions.right - railRight) > 1 && !nextToMenu) || actions.width > 100) fail('plan controls misplaced', JSON.stringify(actions));
                const metrics = document.querySelector('.plan-metrics').getBoundingClientRect();
                if (metrics.right > actions.left && actions.right > metrics.left && metrics.bottom > actions.top && actions.bottom > metrics.top)
                  fail('plan scale overlaps controls', '');
                for (const button of planActions.querySelectorAll('button')) {
                  if (!button.checkVisibility()) continue;
                  const box = button.getBoundingClientRect();
                  if (!button.title || box.width < 44 || box.height < 44 || box.top < plan.top || box.bottom > plan.bottom ||
                    !button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))) fail('plan control inaccessible', button.id);
                }
              }
              if (has3d && !menu) required.push(id('camTools'));
              if (!id('markerPrompt').hidden) required.push(id('markerPrompt'));
              if (id(has3d ? 'planHome' : 'camTools').checkVisibility()) fail('wrong navigation control visible', '');
              if (has3d && !menu) {
                const view = id('map').getBoundingClientRect();
                const dock = id('camTools').getBoundingClientRect();
                const toolbar = id('viewDock').getBoundingClientRect();
                if (Math.abs((toolbar.left + toolbar.right - view.left - view.right) / 2) > 0.5) fail('camera controls off center', '');
                if (cameraZoomRow && dock.width > 145) fail('mobile camera buttons too wide', dock.width);
                if (cameraBox && (Math.abs(cameraBox.x - dock.x) > 0.5 || Math.abs(cameraBox.width - dock.width) > 0.5 ||
                  Math.abs(cameraBox.y - dock.y) > 0.5 || Math.abs(cameraBox.height - dock.height) > 0.5)) fail('camera controls moved', '');
                cameraBox = dock;
                const orbit = id('miOrbit').getBoundingClientRect();
                for (const name of ['miFly', 'miOrbit']) {
                  const button = id(name), box = button.getBoundingClientRect();
                  if (Math.abs(box.width - orbit.width) > 0.5 || Math.abs(box.height - orbit.height) > 0.5) fail('unequal camera buttons', name);
                  const range = document.createRange();
                  range.selectNodeContents(button.lastElementChild);
                  const label = range.getBoundingClientRect();
                  if (label.width < 1 || label.left < box.left || label.right > box.right || label.bottom > box.bottom) fail('camera label clipped', name);
                  if (box.width < 44 || box.height < 44 || box.left < view.left || box.right > view.right ||
                    box.top < view.top || box.bottom > view.bottom || !button.contains(document.elementFromPoint(box.x + box.width/2, box.y + box.height/2))) fail('camera control inaccessible in 3D', name);
                }
              }
              if (menu) required.push(menu);
              if (state === 'busy' && has3d) required.push(id('chunkStatus'));
              else if (id('chunkStatus').checkVisibility()) fail('chunk counter visible during navigation', '');
              const showAdvice = menu?.id === 'setMenu' && !id('perfNotice').hidden;
              if (showAdvice) required.push(id('perfNotice'));
              else if (id('perfNotice').checkVisibility()) fail('performance advice outside settings', '');
              if (state === 'busy' && has3d) required.push(id('dbg'));
              if (state === 'error' || mode.includes('nogl')) required.push(id('stat'));
              if (!menu && has3d) required.push(id(cameraZoomRow ? 'lensTools' : 'fovCtl'));
              if (!menu && fly && touch) required.push(id('stick'), id('flyBtns'));
              if (!menu && !mode.includes('full3d')) required.push(document.querySelector('.readout'));
              for (const node of required) {
                if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) fail('missing ' + (node.id || node.className), '');
              }
              if (mode === 'full3d' && document.querySelector('.readout').checkVisibility()) fail('hidden plan readout visible', '');
              if (mode.includes('nogl') && id('dbg').checkVisibility()) fail('unavailable 3D diagnostics visible', '');
              const stack = document.querySelector('.notice-stack');
              if (stack) stack.scrollTop = 0;
              const boxes = [];
              for (const node of [...tested, planActions]) {
                const name = node.id || node.className;
                const style = getComputedStyle(node);
                const raw = node.getBoundingClientRect();
                if (!raw.width || !raw.height || style.visibility !== 'visible' || +style.opacity === 0) continue;
                let { left, right, top, bottom } = raw;
                for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                  if (style.position === 'fixed') break;
                  if (!['auto', 'scroll', 'hidden'].includes(getComputedStyle(parent).overflowY)) continue;
                  const clip = parent.getBoundingClientRect();
                  top = Math.max(top, clip.top);
                  bottom = Math.min(bottom, clip.bottom);
                }
                if (top >= bottom) continue;
                if (left < -0.1 || right > innerWidth + 0.1 || top < -0.1 || bottom > innerHeight + 0.1) fail(name + ' exceeds viewport', JSON.stringify({ left, right, top, bottom }));
                if (node.scrollWidth > node.clientWidth + 1) fail(name + ' overflows horizontally', node.scrollWidth + '/' + node.clientWidth);
                for (const box of boxes) {
                  if (node.contains(box.node) || box.node.contains(node)) continue;
                  const w = Math.min(right, box.right) - Math.max(left, box.left);
                  const h = Math.min(bottom, box.bottom) - Math.max(top, box.top);
                  if (w > 0.5 && h > 0.5) fail([name, box.name].sort().join(' × '), Math.round(w) + '×' + Math.round(h) + ' px');
                }
                boxes.push({ node, name, left, right, top, bottom });
              }
              if (showAdvice) {
                const close = id('perfClose');
                close.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                const bounds = close.getBoundingClientRect();
                const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
                if (!close.contains(target)) fail('warning dismissal obstructed', target?.id || target?.tagName);
                const copy = id('perfText');
                const textWidth = copy.clientWidth - parseFloat(getComputedStyle(copy).paddingRight);
                if (textWidth < 96) fail('unreadable warning column', textWidth + ' px');
                if (stack) stack.scrollTop = 0;
              }
              if (!menu && has3d && !cameraZoomRow) {
                const label = id('fovVal').getBoundingClientRect();
                const input = id('fovSl').getBoundingClientRect();
                if (input.top < label.bottom - 0.5 || input.height < 12) fail('slider overlaps label or loses track', input.height + ' px');
              }
              if (!menu && has3d && cameraZoomRow) {
                const lens = id('lensToggle'), panel = id('lensPanel'), map = id('map').getBoundingClientRect();
                const visibleTarget = el => {
                  const r = el.getBoundingClientRect();
                  return r.width >= 44 && r.height >= 44 && r.left >= map.left && r.right <= map.right &&
                    r.top >= map.top && r.bottom <= map.bottom && el.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));
                };
                if (!visibleTarget(lens) || id('fovCtl').checkVisibility()) fail('mobile zoom trigger inaccessible', '');
                const presets = [...id('lensTools').querySelectorAll('[data-zoom]')];
                if (presets.length !== 3 || !presets.every(visibleTarget)) fail('one-tap camera presets inaccessible', '');
                panel.hidden = false;
                lens.setAttribute('aria-expanded', 'true');
                for (const el of [lens, id('lensRange'), id('miOrbit'), id('miFly')]) {
                  if (!visibleTarget(el)) fail('expanded lens control inaccessible', el.id || el.textContent);
                }
                const bar = id('viewDock').getBoundingClientRect();
                for (const el of [id('stick'), id('flyBtns'), id('dbg'), id('toast')]) {
                  const box = el.id === 'flyBtns' && el.checkVisibility()
                    ? el.getBoundingClientRect() : boxes.find(item => item.node === el);
                  if (box && Math.min(bar.right,box.right)-Math.max(bar.left,box.left)>1 &&
                    Math.min(bar.bottom,box.bottom)-Math.max(bar.top,box.top)>1)
                    fail('expanded camera toolbar overlaps '+el.id, '');
                }
                panel.hidden = true;
                lens.setAttribute('aria-expanded', 'false');
              }
              if (menu) {
                menu.scrollTop = menu.scrollHeight;
                const lastAction = [...menu.querySelectorAll('.mi')].at(-1);
                const lastButton = lastAction.getBoundingClientRect();
                const bounds = menu.getBoundingClientRect();
                if (lastButton.bottom > bounds.bottom + 1 || lastButton.top < bounds.top - 1) fail('last menu action inaccessible', menu.id);
                const x = lastButton.left + lastButton.width / 2, y = lastButton.top + lastButton.height / 2;
                const hit = document.elementFromPoint(x, y);
                if (!lastAction.contains(hit)) fail('last menu action obstructed', menu.id);
                menu.scrollTop = 0;
              }
              count++;
            }
          }
        }
      }
      return { errors: [...errors], count };
    }, { touch, safeLeft: insets?.[1] ?? 8 });
    await page.close();
    cases += result.count;
    for (const [issue, details] of result.errors) failures.set(width + '×' + height + (insets ? ' safe-area ' : ' ') + issue, details);
  }
} finally { await browser.close(); }
for (const [issue, details] of failures) console.error(issue + ' — ' + details);
console.log(cases + ' shell layouts, ' + failures.size + ' distinct failures');
if (failures.size) process.exitCode = 1;
