/**
 * 全部單據（spec §7）：篩選、改派（人資）、作廢、匯出 CSV（財務，UTF-8 BOM）。
 * 誰看得到哪些單由後端判（承辦部門看自己部門的；platform.staff 看全部）。
 */
'use strict';

import { mountCardList } from '../list-view.js';
import { STATUS, TYPES, toCsv, errText } from '../lib.js';

export function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountAll(el, ctx) {
  const esc = ctx.fmt.esc;
  const q = { month: ctx.fmt.date(new Date()).slice(0, 7), type: '', status: '' };
  const typeOpts = ['<option value="">全部種類</option>'].concat(TYPES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)).join('');
  const stOpts = ['<option value="">全部狀態</option>'].concat(Object.keys(STATUS).map((k) => `<option value="${k}">${esc(STATUS[k][0])}</option>`)).join('');

  return mountCardList(el, ctx, {
    scope: 'all',
    title: '全部單據',
    hint: '承辦部門看自己部門的單，人資／管理者看全部。匯出是依「已處理」日期所在月份的請購與請款明細。',
    empty: '這個條件下沒有單',
    toolbar: () => `<div class="form-grid-2">
        <div class="field"><label class="field-label" for="apv-all-month">月份</label><input class="input" type="month" id="apv-all-month" value="${esc(q.month)}"></div>
        <div class="field"><label class="field-label" for="apv-all-type">種類</label><select class="input" id="apv-all-type">${typeOpts}</select></div>
        <div class="field"><label class="field-label" for="apv-all-status">狀態</label><select class="input" id="apv-all-status">${stOpts}</select></div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-role="apv-query">查詢</button>
        <button type="button" class="btn btn-secondary" data-role="apv-export">匯出 CSV</button>
      </div>`,
    bindToolbar: (root, reload) => {
      const read = () => { q.month = root.querySelector('#apv-all-month').value; q.type = root.querySelector('#apv-all-type').value; q.status = root.querySelector('#apv-all-status').value; };
      root.querySelector('[data-role="apv-query"]').addEventListener('click', () => { read(); reload(); });
      root.querySelector('[data-role="apv-export"]').addEventListener('click', async () => {
        read();
        if (!/^\d{4}-\d{2}$/.test(q.month)) { ctx.ui.toast('請先選月份', 'warn'); return; }
        ctx.ui.loading(true);
        let r;
        try { r = await ctx.api.call('approvals', 'apvExport', { month: q.month }); } finally { ctx.ui.loading(false); }
        if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
        const rows = Array.isArray(r.data && r.data.rows) ? r.data.rows : [];
        if (!rows.length) { ctx.ui.toast('這個月沒有已處理的單', 'warn'); return; }
        downloadCsv(toCsv(rows, (t) => ctx.fmt.datetime(t)), `表單簽核-${q.month}.csv`);
        ctx.ui.toast(`已匯出 ${rows.length} 筆`, 'ok');
      });
    },
    load: async () => {
      const p = {};
      if (q.month) p.month = q.month;
      if (q.type) p.type = q.type;
      if (q.status) p.status = q.status;
      const r = await ctx.api.call('approvals', 'apvList', p);
      if (!r || !r.ok) return r || { ok: false };
      return { ok: true, sections: [{ forms: Array.isArray(r.data && r.data.forms) ? r.data.forms : [] }] };
    }
  });
}
