/**
 * 收支明細（spec §7）：選店、選月 → adminList → 清單＋合計；點一列展開照片／登記資料／作廢鈕。
 * 作廢：已鎖定月份或已作廢的列不顯示作廢鈕；按下去填原因（1–200 字）→ adminVoid。
 */
'use strict';

import { getStores, settle, sel } from '../state.js';
import { summarize } from '../lib/matrix.js';
import { errText, safeUrl } from '../lib/util.js';
import { storeSelectHtml, monthSelectHtml, noticeHtml, NO_STORES } from './common.js';

export function mountRows(el, ctx) {
  const esc = ctx.fmt.esc;
  const money = ctx.fmt.money;
  let alive = true;
  let stores = [];
  let data = null;      // adminList 的回應
  let openId = null;
  let busy = false;
  let seq = 0;          // 避免舊的回應蓋掉新選的店月

  function head(msg) {
    return `<div class="card stack">
      <div class="form-grid-2">${storeSelectHtml(esc, stores, sel.store, 'cb-store')}${monthSelectHtml(esc, sel.month, 'cb-month')}</div>
      <p class="field-hint" data-role="cb-msg">${esc(msg || '')}</p></div>`;
  }

  function detailHtml(r, locked) {
    const url = safeUrl(r.photo);
    const photo = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="收據照片" loading="lazy" style="max-width:160px;max-height:160px;border-radius:6px;border:1px solid #ddd"></a>`
      : '<span class="text-muted">沒有收據照片</span>';
    const voided = r.status === '作廢';
    const info = [
      `收據編號 ${esc(r.seq)}　未稅 ${esc(money(r.net))}　稅額 ${esc(money(r.tax))}`,
      `登記時間 ${esc(r.createdAt || '')}　填表人 ${esc(r.author || '')}`,
      voided ? `作廢：${esc(r.voidReason || '')}（${esc(r.voidedBy || '')}　${esc(r.voidedAt || '')}）` : ''
    ].filter(Boolean).map((t) => `<div>${t}</div>`).join('');
    const btn = (!voided && !locked)
      ? `<button type="button" class="btn btn-danger" data-act="void" data-id="${esc(r.id)}">作廢這一筆</button>` : '';
    return `<tr data-role="cb-detail" data-id="${esc(r.id)}"><td colspan="5"><div class="stack">${photo}${info}${btn}</div></td></tr>`;
  }

  function tableHtml() {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const sum = summarize(rows);
    const locked = !!data.locked;
    const lockTag = locked ? '<span class="tag tag-warn" data-role="cb-locked">本月已月結鎖定</span>' : '<span class="tag" data-role="cb-locked">本月未鎖定</span>';
    const body = rows.length ? rows.map((r) => {
      const voided = r.status === '作廢';
      const strike = voided ? ' style="text-decoration:line-through;opacity:.6"' : '';
      return `<tr data-role="cb-row" data-id="${esc(r.id)}" style="cursor:pointer">
        <td${strike}>${esc(r.date)}</td>
        <td${strike}>${esc(r.kind)}・${esc(r.subject)}・${esc(r.name)}</td>
        <td${strike}>${esc(money(r.amount))}</td>
        <td>${r.hasInvoice ? '有' : '無'}</td>
        <td>${voided ? '<span class="tag tag-danger">作廢</span>' : '<span class="tag tag-ok">正常</span>'}</td></tr>`
        + (openId === String(r.id) ? detailHtml(r, locked) : '');
    }).join('') : '<tr><td colspan="5" class="text-muted" data-role="cb-empty">這個月沒有任何收支紀錄</td></tr>';
    return `<div class="card stack">
      <div class="card-row"><div class="card-title">${esc(data.name || '')} ${esc(data.month || '')}</div>${lockTag}</div>
      <div class="table-wrap"><table class="table" data-role="cb-table">
        <thead><tr><th>日期</th><th>科目・項目</th><th>金額</th><th>發票</th><th>狀態</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <div data-role="cb-sum">支出 <b data-k="expense">${esc(money(sum.expense))}</b>　收入 <b data-k="income">${esc(money(sum.income))}</b>　淨額 <b data-k="net">${esc(money(sum.net))}</b>　<span class="text-muted">（不含作廢，共 ${esc(sum.count)} 筆）</span></div>
    </div>`;
  }

  function draw(msg) {
    el.innerHTML = head(msg) + (data ? tableHtml() : '');
  }

  async function load() {
    const mine = ++seq;
    if (!sel.store) { el.innerHTML = noticeHtml(esc, NO_STORES); return; }
    data = null;
    draw('讀取中…');
    let r;
    try { r = await ctx.api.call('cashbook', 'adminList', { store: sel.store, month: sel.month }); } catch (e) { r = null; }
    if (!alive || mine !== seq) return;
    if (!r || !r.ok) { draw(errText(r)); return; }
    data = r.data || {};
    draw('');
  }

  async function askReason(r) {
    for (;;) {
      const ta = document.createElement('div');
      ta.innerHTML = `<p>${esc(r.date)}　${esc(r.subject)}・${esc(r.name)}　${esc(money(r.amount))} 元</p>
        <div class="field"><label class="field-label" for="cb-void-reason">作廢原因（必填，200 字內）</label>
        <textarea class="input" id="cb-void-reason" rows="3" maxlength="200" data-role="cb-void-reason"></textarea></div>`;
      const v = await ctx.ui.dialog({ title: '作廢這一筆？', body: ta, actions: [
        { label: '取消', value: null, variant: 'secondary' }, { label: '確定作廢', value: 'ok', variant: 'danger' }] });
      if (v !== 'ok') return null;
      const text = String(ta.querySelector('textarea').value || '').trim();
      if (text.length >= 1 && text.length <= 200) return text;
      ctx.ui.toast('請填作廢原因（1–200 字）', 'warn');
    }
  }

  async function doVoid(id) {
    if (busy || !data) return;
    const r = (data.rows || []).find((x) => String(x.id) === String(id));
    if (!r) return;
    const reason = await askReason(r);
    if (!alive || reason === null) return;
    busy = true;
    ctx.ui.loading(true);
    let res;
    try { res = await ctx.api.call('cashbook', 'adminVoid', { store: sel.store, id: r.id, reason }); } catch (e) { res = null; } finally { ctx.ui.loading(false); busy = false; }
    if (!alive) return;
    if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); await load(); return; }
    ctx.ui.toast(res.data && res.data.dryRun ? '試跑模式：未實際寫入' : '已作廢', 'ok');
    await load();
  }

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const v = t.closest('[data-act="void"]');
    if (v) { doVoid(v.getAttribute('data-id')); return; }
    if (t.closest('a')) return;
    const row = t.closest('[data-role="cb-row"]');
    if (row) {
      const id = row.getAttribute('data-id');
      openId = openId === id ? null : id;
      draw('');
    }
  }
  function onChange(e) {
    const t = e.target;
    const role = t && t.getAttribute && t.getAttribute('data-role');
    if (role === 'cb-store') { sel.store = t.value; openId = null; load(); }
    else if (role === 'cb-month') { sel.month = t.value; openId = null; load(); }
  }

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  (async () => {
    el.innerHTML = noticeHtml(esc, '讀取中…');
    const s = await getStores(ctx);
    if (!alive) return;
    if (!s.ok) { el.innerHTML = noticeHtml(esc, errText(s.raw), 'cb-error'); return; }
    stores = s.stores;
    settle(stores, ctx.params);
    load();
  })();
  return () => { alive = false; el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
}
