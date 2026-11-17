/**
 * 匯款清單分頁：待出帳／已匯款／全部，依月份（已匯款看匯款日的月份）；「只看我負責的單位」。
 * 每列：標記已匯款（選匯款日、備註）、單位請款沒帳戶 → 設定帳戶、已匯款 → 取消（要寫原因）、明細（收據照片＋簽核紀錄）。
 */
'use strict';

import { money, taipeiToday, monthsBack, monthLabel, bankText, visibleRows, totalOf, checkPaidDate, toCsv, errText } from '../lib.js';
import { openVendorForm } from './vendors.js';
import { detailHtml } from '../../approvals/cards.js';
import { domOf, hydrateImages, showBig } from '../../approvals/widgets.js';

export function mountList(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  const p = ctx.params || {};
  let state = ['pending', 'paid', 'all'].indexOf(p.state) !== -1 ? p.state : 'pending';
  const today = taipeiToday();
  let month = /^\d{4}-\d{2}$/.test(p.month || '') ? p.month : today.slice(0, 7);
  let mineOnly = p.mine === '1';
  let data = null;
  let seq = 0;

  function toolbar() {
    const chip = (id, label) => `<button type="button" class="remit-chip" data-state="${id}" aria-pressed="${state === id}">${esc(label)}</button>`;
    const s = (data && data.summary) || {};
    const months = monthsBack(today.slice(0, 7), 13).map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
    return `<div class="card stack">
      <div class="remit-bar">
        ${chip('pending', `待出帳 ${s.pending || 0}`)}${chip('paid', '已匯款')}${chip('all', '全部')}
        <label class="field-label" for="remit-month" ${state === 'pending' ? 'hidden' : ''}>匯款月份</label>
        <select class="input" id="remit-month" data-role="month" style="width:auto" ${state === 'pending' ? 'hidden' : ''}>${months}</select>
        <span class="checkbox-row"><input type="checkbox" id="remit-mine" data-role="mine"${mineOnly ? ' checked' : ''}><label for="remit-mine">只看我負責的單位</label></span>
        <button type="button" class="btn btn-secondary" data-act="export">匯出（Excel 可開）</button>
      </div>
      <div class="remit-bar"><span class="remit-sum" data-role="sum"></span></div>
    </div>`;
  }

  function rowHtml(r) {
    const acts = [];
    if (r.state === 'pending') {
      if (!r.self_pay && !r.bank) acts.push(`<button type="button" class="btn btn-secondary" data-act="set-bank" data-id="${esc(r.id)}">設定帳戶</button>`);
      else acts.push(`<button type="button" class="btn btn-primary" data-act="mark" data-id="${esc(r.id)}">標記已匯款</button>`);
    } else {
      acts.push(`<button type="button" class="btn btn-secondary" data-act="unmark" data-id="${esc(r.id)}">取消已匯款</button>`);
    }
    acts.push(`<button type="button" class="btn btn-secondary" data-act="detail" data-id="${esc(r.id)}">明細</button>`);
    const accts = r.accountants && r.accountants.length ? r.accountants.map((a) => a.name).join('、') : '還沒設定';
    const status = r.state === 'paid'
      ? `<span class="tag tag-ok">已匯款 ${esc((r.paid && r.paid.date) || '')}</span>${r.paid && r.paid.by_name ? `<div class="remit-sub">${esc(r.paid.by_name)}</div>` : ''}`
      : `<span class="tag tag-warn">待出帳</span>${r.overdue ? '<div class="remit-due">已過希望付款日</div>' : ''}`;
    return `<tr data-role="remit-row" data-id="${esc(r.id)}" data-state="${esc(r.state)}">
      <td class="remit-nw" data-label="${esc(r.date_label)}">${esc(r.date || '—')}${r.own ? '<div class="remit-sub">本人的單</div>' : ''}</td>
      <td class="remit-nw" data-label="種類">${esc(r.type_name)}<div class="remit-sub">${esc(r.category)}</div></td>
      <td data-label="單位">${esc(r.unit_name)}<div class="remit-sub">會計：${esc(accts)}</div></td>
      <td class="remit-payee" data-label="對象">${esc(r.payee)}</td>
      <td data-label="說明">${esc(r.desc)}</td>
      <td class="num" data-label="金額" data-role="amount">${esc(money(r.amount))}</td>
      <td data-label="帳戶" class="remit-bank">${r.self_pay ? '<span class="tag tag-info">同仁代墊</span>' : r.bank ? bankHtml(r.bank) : '<span class="tag tag-danger">還沒設定帳戶</span>'}</td>
      <td data-label="狀態">${status}</td>
      <td><div class="remit-acts">${acts.join('')}</div></td>
    </tr>`;
  }

  function bankHtml(b) {
    return `${esc([b.bank_code, b.bank_name, b.branch].filter(Boolean).join(' '))}<br>戶名 ${esc(b.acct_name)}<br><span class="remit-no">${esc(b.acct_no)}</span>`;
  }

  function rowsNow() { return visibleRows((data && data.rows) || [], mineOnly); }

  function render() {
    const rows = rowsNow();
    const body = rows.length
      ? `<div class="table-wrap"><table class="table remit-table" data-role="remit-table"><thead><tr><th>日期</th><th>種類</th><th>單位</th><th>對象</th><th>說明</th><th class="num">金額</th><th>銀行帳戶</th><th>狀態</th><th></th></tr></thead>
         <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`
      : `<div class="card"><p class="text-muted" data-role="empty">${state === 'pending' ? '目前沒有待出帳的單。個人代墊、單位請款經財務部主管核准後會自動出現在這裡。' : `${esc(monthLabel(month))}沒有已匯款的紀錄。`}</p></div>`;
    el.innerHTML = toolbar() + body;
    const pend = rows.filter((r) => r.state === 'pending');
    const paid = rows.filter((r) => r.state === 'paid');
    const parts = [];
    if (state !== 'paid') parts.push(`待出帳 ${pend.length} 筆，合計 ${money(totalOf(pend))} 元`);
    if (state !== 'pending') parts.push(`已匯款 ${paid.length} 筆，合計 ${money(totalOf(paid))} 元`);
    el.querySelector('[data-role="sum"]').textContent = parts.join('　');
  }

  async function load() {
    const my = ++seq;
    if (!data) el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
    const r = await ctx.api.call('remit', 'apvRemitList', { state, month });
    if (!alive || my !== seq) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card" data-role="remit-error"><p class="text-muted">${esc(errText(r))}</p></div>`; return; }
    data = r.data;
    render();
  }

  const findRow = (id) => ((data && data.rows) || []).find((x) => x.id === id);

  async function onMark(r) {
    const box = domOf(`<div class="stack">
      <p>${esc(r.payee)}　NT$ ${esc(money(r.amount))}</p>
      ${r.self_pay ? '<p class="text-muted">個人代墊：匯到送件同仁的帳戶。</p>' : `<p class="remit-bank">${esc(bankText(r) || '')}</p>`}
      <div class="field"><label class="field-label" for="remit-pd">匯款日</label><input class="input" id="remit-pd" type="date" max="${today}" value="${today}"></div>
      <div class="field"><label class="field-label" for="remit-note">備註（選填）</label><input class="input" id="remit-note" maxlength="200"></div>
      <p class="field-hint" data-role="dlg-msg"></p></div>`);
    const v = await ctx.ui.dialog({ title: '標記已匯款', body: box, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '確定已匯款', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok' || !alive) return;
    const pd = box.querySelector('#remit-pd').value;
    const bad = checkPaidDate(pd, today);
    if (bad) { ctx.ui.toast(bad, 'warn'); return; }
    ctx.ui.loading(true);
    let res;
    try { res = await ctx.api.call('remit', 'apvRemitMark', { id: r.id, rev: r.rev, paid_date: pd, note: box.querySelector('#remit-note').value.trim() }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); if (res && res.error === 'conflict') load(); return; }
    if (res.dryrun) { ctx.ui.toast('試跑模式，未真的寫入', 'info'); return; }
    ctx.ui.toast('已標記匯款，這張單結案了', 'ok');
    load();
  }

  async function onUnmark(r) {
    const box = domOf(`<div class="stack"><p>${esc(r.payee)}　NT$ ${esc(money(r.amount))}　匯款日 ${esc((r.paid && r.paid.date) || '')}</p>
      <p class="text-muted">取消後這張單回到「待出帳」。已推進損益的金額不會重推、也不會撤回。</p>
      <div class="field"><label class="field-label" for="remit-reason">原因（必填）</label><input class="input" id="remit-reason" maxlength="200"></div></div>`);
    const v = await ctx.ui.dialog({ title: '取消已匯款？', body: box, actions: [{ label: '不要', value: null, variant: 'secondary' }, { label: '確定取消', value: 'ok', variant: 'danger' }] });
    if (v !== 'ok' || !alive) return;
    const reason = box.querySelector('#remit-reason').value.trim();
    if (!reason) { ctx.ui.toast('請寫取消的原因', 'warn'); return; }
    ctx.ui.loading(true);
    let res;
    try { res = await ctx.api.call('remit', 'apvRemitUnmark', { id: r.id, rev: r.rev, reason }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); return; }
    if (res.dryrun) { ctx.ui.toast('試跑模式，未真的寫入', 'info'); return; }
    ctx.ui.toast('已取消，回到待出帳', 'ok');
    load();
  }

  async function onDetail(r) {
    ctx.ui.loading(true);
    let res;
    try { res = await ctx.api.call('remit', 'apvGet', { id: r.id }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); return; }
    const box = domOf(`<div>${detailHtml(res.data, esc, ctx.fmt)}</div>`);
    box.addEventListener('click', (e) => { const img = e.target && e.target.closest && e.target.closest('img[data-file]'); if (img) showBig(ctx, img.getAttribute('src')); });
    hydrateImages(box);
    await ctx.ui.dialog({ title: `${r.type_name}　${r.id}`, body: box, actions: [{ label: '關閉', value: null, variant: 'primary' }] });
  }

  function onExport() {
    const rows = rowsNow();
    if (!rows.length) { ctx.ui.toast('沒有資料可以匯出', 'warn'); return; }
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `匯款清單_${state === 'pending' ? '待出帳_' + today : month}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const chip = t.closest('[data-state]');
    if (chip && chip.classList.contains('remit-chip')) { state = chip.getAttribute('data-state'); load(); return; }
    const b = t.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'export') { onExport(); return; }
    const r = findRow(b.getAttribute('data-id'));
    if (!r) return;
    if (a === 'mark') onMark(r);
    else if (a === 'unmark') onUnmark(r);
    else if (a === 'detail') onDetail(r);
    else if (a === 'set-bank') openVendorForm(ctx, { name: r.vendor_name }).then((saved) => { if (saved && alive) load(); });
  }
  function onChange(e) {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-role') === 'month') { month = t.value; load(); }
    else if (t.getAttribute('data-role') === 'mine') { mineOnly = !!t.checked; render(); }
  }
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  load();

  return () => {
    alive = false;
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
  };
}
