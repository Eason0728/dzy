/**
 * 單位會計分頁：每個啟用單位由哪幾位財務部同仁出帳（最多 5 位）。財務部主管與系統管理者可以改，其他人只看。
 * 會計不簽核，只負責出帳；沒設定的單位，待出帳提醒給所有有匯款清單權限的人。
 */
'use strict';

import { errText } from '../lib.js';
import { domOf } from '../../approvals/widgets.js';

export function mountAccts(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let data = null;

  function render() {
    const units = data.units || [];
    const unset = units.filter((u) => !u.accountants.some((a) => a.live)).length;
    el.innerHTML = `<div class="card stack"><p>會計只負責出帳（在匯款清單標記已匯款），不簽核。${data.can_edit ? '' : '只有財務部主管或系統管理者可以修改。'}</p>
        <p class="field-hint">共 ${units.length} 個單位，${unset} 個還沒設定。沒設定的單位，待出帳提醒會給所有財務部同仁。</p></div>
      <div class="table-wrap"><table class="table remit-table" data-role="acct-table"><thead><tr><th>單位</th><th>會計</th><th>最後修改</th><th></th></tr></thead><tbody>
      ${units.map((u) => `<tr data-role="acct-row" data-unit="${esc(u.unit)}">
        <td class="remit-payee" data-label="單位">${esc(u.unit_name)}${u.brand_name ? `<div class="remit-sub">${esc(u.brand_name)}</div>` : ''}</td>
        <td data-label="會計">${u.accountants.length ? u.accountants.map((a) => `${esc(a.name)}${a.live ? '' : ' <span class="tag tag-danger">已不在財務部</span>'}`).join('、') : '<span class="tag tag-danger">還沒設定</span>'}</td>
        <td data-label="最後修改" class="remit-sub">${u.updated_at ? `${esc(ctx.fmt.datetime(u.updated_at))} ${esc(u.updated_by_name)}` : '—'}</td>
        <td>${data.can_edit ? `<div class="remit-acts"><button type="button" class="btn ${u.accountants.length ? 'btn-secondary' : 'btn-primary'}" data-act="edit" data-unit="${esc(u.unit)}">${u.accountants.length ? '修改' : '設定'}</button></div>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  async function load() {
    const r = await ctx.api.call('remit', 'apvAcctGet', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card" data-role="remit-error"><p class="text-muted">${esc(errText(r))}</p></div>`; return; }
    data = r.data;
    render();
  }

  async function onEdit(u) {
    const cur = u.accountants.map((a) => a.emp);
    const cands = data.candidates || [];
    if (!cands.length) { ctx.ui.toast('目前沒有已開通的財務部同仁可以選', 'warn'); return; }
    const box = domOf(`<div class="stack"><p>勾選 ${esc(u.unit_name)} 的會計（最多 5 位）：</p>
      ${cands.map((c, i) => `<div class="checkbox-row"><input type="checkbox" id="ac-${i}" value="${esc(c.emp)}"${cur.indexOf(c.emp) !== -1 ? ' checked' : ''}><label for="ac-${i}">${esc(c.name)}（${esc(c.emp)}）</label></div>`).join('')}
      <p class="field-hint">都不勾＝這個單位沒有指定會計。</p></div>`);
    const go = await ctx.ui.dialog({ title: '設定單位會計', body: box, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '儲存', value: 'ok', variant: 'primary' }] });
    if (go !== 'ok' || !alive) return;
    const emps = Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map((x) => x.value);
    if (emps.length > 5) { ctx.ui.toast('會計最多 5 位', 'warn'); return; }
    const r = await ctx.api.call('remit', 'apvAcctSave', { unit: u.unit, emps, expected_updated_at: u.updated_at || 0 });
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); if (r && r.error === 'conflict') load(); return; }
    if (r.dryrun) { ctx.ui.toast('試跑模式，未真的寫入', 'info'); return; }
    ctx.ui.toast('已儲存', 'ok');
    load();
  }

  function onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('[data-act="edit"]');
    if (!b || !data) return;
    const u = (data.units || []).find((x) => x.unit === b.getAttribute('data-unit'));
    if (u) onEdit(u);
  }
  el.addEventListener('click', onClick);
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
