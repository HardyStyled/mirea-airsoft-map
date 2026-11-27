/* что здесь живёт: жёстко привязанные к разметке index.html хелперы: $ по id, el для создания элементов, esc для безопасного innerHTML. */
/* dom.js — жёстко привязанные к разметке index.html хелперы: $ по id, el для создания элементов, esc для безопасного innerHTML. Никакой бизнес-логики. */
export const $ = id => document.getElementById(id);
export const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
