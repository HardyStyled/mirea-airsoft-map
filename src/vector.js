/* что здесь живёт: припаркованный интерфейс справочника объекта (инспектор) — разметки в MVP нет. */
/* vector.js — припаркованное (D9): панель слоёв, редактор и инспектор атрибутов. Разметки
 * #insp/#oFid/#verts в index.html нет, SHOW_VECTOR_LAYERS=false, sql.js не подключается,
 * поэтому код не участвует в запуске и не импортируется (гейт структуры это проверяет).
 * Возвращается вместе с GPKG-слоями: тогда же к index.html вернутся и id элементов.
 * Логика перенесена из app.js без правок, чтобы её не переписывать при возврате. */
import { App } from './state.js?v=14';
import { $, el, esc } from './dom.js?v=14';

export function showInsp() { const box = $('insp'); if (!box || !App.sel) { if (box) { box.classList.remove('show'); box.inert = true; } return; } box.inert = false; box.classList.add('show'); const s = App.sel; $('oFid').textContent = 'fid ' + s.fid; $('oLayer').textContent = s.layer; $('oType').textContent = (s.geom.type || '').toUpperCase(); const nm = $('fName'); nm.value = s.name || 'Без названия'; nm.disabled = false; nm.readOnly = true; renderAttrs(s); }

export function renderAttrs(s) { const vt = $('verts'); vt.innerHTML = ''; const skip = new Set(['name', 'NAME', 'fid', 'id']); const rows = Object.entries(s.attrs || {}).filter(([k, v]) => !skip.has(k) && v !== null && v !== '').slice(0, 12); for (const [k, v] of rows) vt.append(el('div', 'vrow', `<span class="vidx" style="width:auto">${esc(k)}</span><span class="zu" style="margin-left:auto;color:var(--ink)">${esc(v)}</span>`)); if (window.Editor) Editor.renderVerts(); }

/* Закрытие инспектора снимает выделение. Привязка живёт здесь, а не в plans.js: без разметки
 * эти строки в рабочем модуле выглядели бы мёртвым кодом и роняли загрузку на null-элементе. */
export function wireInspector(unselect) {
  const box = $('inspClose');
  if (!box) return false;
  box.onclick = () => unselect(null);
  return true;
}
