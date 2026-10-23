/**
 * modules/cashbook/views/common.js — 四個分頁共用的小零件（店別／月份選單、錯誤卡）
 */
'use strict';

import { monthOptions } from '../lib/util.js';

export function storeSelectHtml(esc, stores, cur, id) {
  return `<div class="field"><label class="field-label" for="${id}">店別</label>
    <select class="input" id="${id}" data-role="cb-store">${stores.map((s) => `<option value="${esc(s.code)}"${s.code === cur ? ' selected' : ''}>${esc(s.name || s.code)}</option>`).join('')}</select></div>`;
}

/** 月份選單：最近 24 個月；目前選的月份若更早（網址帶來的）一併列出 */
export function monthSelectHtml(esc, cur, id, now, n) {
  const list = monthOptions(now || new Date(), n || 24);
  if (cur && list.indexOf(cur) === -1) list.push(cur);
  return `<div class="field"><label class="field-label" for="${id}">月份</label>
    <select class="input" id="${id}" data-role="cb-month">${list.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>`;
}

export function noticeHtml(esc, text, role) {
  return `<div class="card" data-role="${role || 'cb-notice'}"><p class="text-muted">${esc(text)}</p></div>`;
}

export const NO_STORES = '目前現金帳裡還沒有任何門市的帳。';
