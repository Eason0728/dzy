/**
 * 廠商帳戶分頁：列出全部廠商（啟用在前）、新增、修改、停用／重新啟用；每家看最近 5 筆異動。
 * openVendorForm 也給匯款清單「設定帳戶」用（帶入廠商名稱）。同名廠商（不分大小寫、空白）後端會擋。
 */
'use strict';

import { checkVendor, errText } from '../lib.js';
import { domOf } from '../../approvals/widgets.js';

const ACTION_ZH = { add: '新增', edit: '修改', enable: '重新啟用', disable: '停用' };

/** 開廠商表單對話框。v＝既有廠商（修改）或 {name}（新增）。存成功回 true */
export async function openVendorForm(ctx, v) {
  const esc = ctx.fmt.esc;
  const isEdit = !!(v && v.id);
  const val = (k) => esc((v && v[k]) || '');
  const box = domOf(`<div class="stack">
    <div class="field"><label class="field-label" for="vd-name">廠商名稱（跟送單時打的名稱一樣）</label><input class="input" id="vd-name" maxlength="60" value="${val('name')}"></div>
    <div class="form-grid-2">
      <div class="field"><label class="field-label" for="vd-code">銀行代碼（3 碼）</label><input class="input" id="vd-code" inputmode="numeric" maxlength="3" value="${val('bank_code')}"></div>
      <div class="field"><label class="field-label" for="vd-bank">銀行名稱</label><input class="input" id="vd-bank" maxlength="30" value="${val('bank_name')}"></div>
      <div class="field"><label class="field-label" for="vd-branch">分行（選填）</label><input class="input" id="vd-branch" maxlength="30" value="${val('branch')}"></div>
      <div class="field"><label class="field-label" for="vd-an">戶名</label><input class="input" id="vd-an" maxlength="60" value="${val('acct_name')}"></div>
    </div>
    <div class="field"><label class="field-label" for="vd-no">帳號</label><input class="input" id="vd-no" inputmode="numeric" maxlength="24" value="${val('acct_no')}"></div>
    <div class="field"><label class="field-label" for="vd-note">備註（選填，例：月結、統編）</label><input class="input" id="vd-note" maxlength="100" value="${val('note')}"></div>
    <p class="field-hint">設定一次，之後同名廠商的單位請款會自動帶出這個帳戶。每次修改都會留紀錄。</p></div>`);
  for (;;) {
    const go = await ctx.ui.dialog({ title: isEdit ? `修改 ${v.name} 的帳戶` : '設定廠商銀行帳戶', body: box,
      actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '儲存', value: 'ok', variant: 'primary' }] });
    if (go !== 'ok') return false;
    const g = (id) => box.querySelector('#' + id).value.trim();
    const p = { name: g('vd-name'), bank_code: g('vd-code'), bank_name: g('vd-bank'), branch: g('vd-branch'), acct_name: g('vd-an'), acct_no: g('vd-no'), note: g('vd-note') };
    const bad = checkVendor(p);
    if (bad) { ctx.ui.toast(bad, 'warn'); continue; }
    if (isEdit) { p.id = v.id; p.expected_updated_at = v.updated_at; }
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('remit', 'apvVendorSave', p); } finally { ctx.ui.loading(false); }
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); if (r && (r.error === 'dup' || r.error === 'bad_request')) continue; return false; }
    if (r.dryrun) { ctx.ui.toast('試跑模式，未真的寫入', 'info'); return false; }
    ctx.ui.toast('已儲存廠商帳戶', 'ok');
    return true;
  }
}

export function mountVendors(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let list = [];
  let q = '';

  function render() {
    const kw = q.trim().toLowerCase();
    const rows = list.filter((v) => !kw || v.name.toLowerCase().indexOf(kw) !== -1);
    el.innerHTML = `<div class="card stack"><div class="remit-bar">
        <button type="button" class="btn btn-primary" data-act="add">新增廠商帳戶</button>
        <label class="field-label" for="vd-q">搜尋</label><input class="input" id="vd-q" data-role="q" style="width:auto;min-width:0;flex:1 1 160px" value="${esc(q)}" placeholder="廠商名稱">
        <span class="remit-sum">共 ${list.filter((v) => v.active).length} 家啟用</span></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="table remit-table" data-role="vendor-table"><thead><tr><th>廠商</th><th>銀行</th><th>戶名</th><th>帳號</th><th>最近異動</th><th></th></tr></thead><tbody>
        ${rows.map((v) => `<tr data-role="vendor-row" data-id="${esc(v.id)}">
          <td class="remit-payee" data-label="廠商">${esc(v.name)}${v.active ? '' : ' <span class="tag">已停用</span>'}${v.note ? `<div class="remit-sub">${esc(v.note)}</div>` : ''}</td>
          <td data-label="銀行">${esc(v.bank_code)} ${esc(v.bank_name)}${v.branch ? ` ${esc(v.branch)}` : ''}</td>
          <td data-label="戶名">${esc(v.acct_name)}</td>
          <td data-label="帳號" class="num">${esc(v.acct_no)}</td>
          <td data-label="最近異動" class="remit-sub">${(v.log || []).slice(0, 3).map((l) => `${esc(ctx.fmt.datetime(l.at))} ${esc(l.actor_name)} ${esc(ACTION_ZH[l.action] || l.action)}`).join('<br>') || '—'}</td>
          <td><div class="remit-acts"><button type="button" class="btn btn-secondary" data-act="edit" data-id="${esc(v.id)}">修改</button>
            <button type="button" class="btn btn-secondary" data-act="toggle" data-id="${esc(v.id)}">${v.active ? '停用' : '重新啟用'}</button></div></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card"><p class="text-muted" data-role="empty">${list.length ? '找不到符合的廠商' : '還沒有廠商帳戶。單位請款送進來後，可以在匯款清單按「設定帳戶」，或在這裡先新增。'}</p></div>`}`;
  }

  async function load() {
    const r = await ctx.api.call('remit', 'apvVendorList', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card" data-role="remit-error"><p class="text-muted">${esc(errText(r))}</p></div>`; return; }
    list = (r.data && r.data.vendors) || [];
    render();
  }

  async function onToggle(v) {
    const go = await ctx.ui.dialog({ title: v.active ? `停用 ${v.name}？` : `重新啟用 ${v.name}？`,
      body: domOf(`<p>${v.active ? '停用後，這家廠商的單位請款會顯示「還沒設定帳戶」，要重新啟用或另設帳戶才能標記匯款。' : '重新啟用後，同名廠商的單位請款會帶出這個帳戶。'}</p>`),
      actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: v.active ? '停用' : '重新啟用', value: 'ok', variant: v.active ? 'danger' : 'primary' }] });
    if (go !== 'ok' || !alive) return;
    const r = await ctx.api.call('remit', 'apvVendorToggle', { id: v.id, active: !v.active, expected_updated_at: v.updated_at });
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
    if (r.dryrun) { ctx.ui.toast('試跑模式，未真的寫入', 'info'); return; }
    ctx.ui.toast(v.active ? '已停用' : '已重新啟用', 'ok');
    load();
  }

  function onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'add') { openVendorForm(ctx, {}).then((ok) => { if (ok && alive) load(); }); return; }
    const v = list.find((x) => x.id === b.getAttribute('data-id'));
    if (!v) return;
    if (a === 'edit') openVendorForm(ctx, v).then((ok) => { if (ok && alive) load(); });
    else if (a === 'toggle') onToggle(v);
  }
  function onInput(e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-role') === 'q') {
      q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = el.querySelector('[data-role="q"]');
      if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  }
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); };
}
