/**
 * modules/pnl/views/common.js — 各分頁共用的小零件（門市／月份選單、讀取中、錯誤卡）
 * 樣式一律用管理系統既有 class（card、field、input、btn、table、tag…），不帶損益舊網站的品牌主題。
 */
'use strict';

/** 最近 n 個月（含本月，新到舊）'YYYY-MM' */
export function monthList(cur, n) {
  const out = [];
  let y = Number(cur.slice(0, 4)), m = Number(cur.slice(5, 7));
  for (let i = 0; i < (n || 24); i++) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m--; if (m < 1) { m = 12; y--; }
  }
  return out;
}

export function storeSelectHtml(esc, options, cur, id) {
  return `<div class="field"><label class="field-label" for="${id}">門市</label>
    <select class="input" id="${id}" data-role="pnl-store">${options.map((s) => `<option value="${esc(s.store_id)}"${s.store_id === cur ? ' selected' : ''}>${esc(s.name || s.store_id)}</option>`).join('')}</select></div>`;
}

/** 月份選單：本月往前 24 個月；目前選的月份若不在清單（網址帶來的）一併列出 */
export function monthSelectHtml(esc, cur, thisMonth, id) {
  const list = monthList(thisMonth, 24);
  if (cur && list.indexOf(cur) === -1) list.push(cur);
  return `<div class="field"><label class="field-label" for="${id}">月份</label>
    <select class="input" id="${id}" data-role="pnl-month">${list.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>`;
}

/** 讀取中（管理系統樣式；任何畫面都不會出現登入表單） */
export function loadingHtml(text) {
  return `<div class="card" data-role="pnl-loading"><p class="text-muted">${text || '讀取中…'}</p></div>`;
}

export function noticeHtml(esc, text, role) {
  return `<div class="card" data-role="${role || 'pnl-notice'}"><p class="text-muted">${esc(text)}</p></div>`;
}

export function errorHtml(esc, text) {
  return `<div class="card" data-role="pnl-error"><p>${esc(text)}</p><button type="button" class="btn" data-act="pnl-retry">重新整理</button></div>`;
}

/** 金額（整數元，千分位；小數 2 位內照實顯示） */
export function money(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}
