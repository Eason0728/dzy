/**
 * 匯出 Excel（spec §7、D4）：選店＋月份 → 讀 adminList → 在瀏覽器產 xlsx（檔名與欄位與現金帳現行相同）。
 * SheetJS 按下「匯出」才載入。
 */
'use strict';

import { getStores, settle, sel } from '../state.js';
import { errText } from '../lib/util.js';
import { summarize, toXlsxBytes, fileName } from '../lib/matrix.js';
import { loadXlsx } from '../lib/load-xlsx.js';
import { storeSelectHtml, monthSelectHtml, noticeHtml, NO_STORES } from './common.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.setAttribute('data-role', 'cb-download');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountExport(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let stores = [];
  let busy = false;

  function draw(msg, level) {
    el.innerHTML = `<div class="card stack">
      <div class="form-grid-2">${storeSelectHtml(esc, stores, sel.store, 'cb-store')}${monthSelectHtml(esc, sel.month, 'cb-month')}</div>
      <div class="btn-row"><button type="button" class="btn btn-primary" data-act="export" data-role="cb-export-btn">匯出 Excel</button></div>
      <p class="field-hint" data-role="cb-msg" data-level="${esc(level || '')}">${esc(msg || '')}</p>
      <p class="field-hint">檔案在這台電腦上直接產生，不到 1 秒；作廢的帳不會出現在檔案裡。檔名「現金收支_店名_月份.xlsx」，欄位與店長端的匯出相同。</p></div>`;
  }

  async function doExport() {
    if (busy || !sel.store) return;
    busy = true;
    const btn = el.querySelector('[data-act="export"]');
    if (btn) btn.disabled = true;
    ctx.ui.loading(true);
    let msg = '', level = 'ok';
    try {
      const r = await ctx.api.call('cashbook', 'adminList', { store: sel.store, month: sel.month });
      if (!r || !r.ok) throw new Error(errText(r));
      const d = r.data || {};
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const XLSX = await loadXlsx();
      const bytes = toXlsxBytes(XLSX, rows);
      const name = fileName(d.name || sel.store, d.month || sel.month);
      download(new Blob([bytes], { type: XLSX_MIME }), name);
      const sum = summarize(rows);
      msg = `已匯出 ${name}：${sum.count} 筆（支出 ${ctx.fmt.money(sum.expense)}、收入 ${ctx.fmt.money(sum.income)}、淨額 ${ctx.fmt.money(sum.net)}）`;
    } catch (e) {
      level = 'error';
      msg = e && e.message === 'XLSX_MISSING' ? '匯出元件沒有載入成功，請按 Cmd+Shift+R 重新整理頁面再試。' : ((e && e.message) || '匯出失敗，請再試一次');
    } finally {
      ctx.ui.loading(false);
      busy = false;
    }
    if (!alive) return;
    draw(msg, level);
  }

  function onClick(e) {
    if (e.target && e.target.closest && e.target.closest('[data-act="export"]')) doExport();
  }
  function onChange(e) {
    const t = e.target;
    const role = t && t.getAttribute && t.getAttribute('data-role');
    if (role === 'cb-store') sel.store = t.value;
    else if (role === 'cb-month') sel.month = t.value;
  }
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  (async () => {
    el.innerHTML = noticeHtml(esc, '讀取中…');
    const s = await getStores(ctx);
    if (!alive) return;
    if (!s.ok) { el.innerHTML = noticeHtml(esc, errText(s.raw), 'cb-error'); return; }
    if (!s.stores.length) { el.innerHTML = noticeHtml(esc, NO_STORES); return; }
    stores = s.stores;
    settle(stores, ctx.params);
    draw('');
  })();
  return () => { alive = false; el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
}
