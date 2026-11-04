/**
 * modules/pnl/views/entry.js — 填資料（待補總覽＋食材／人事／可控／不可控／營業收入五類）
 * 行為對照舊網站 ~/mala-pnl-auto/gas/entry.html（renderEntry、renderAccountCard、renderAddForm、renderEntryRow、
 * renderConfirmZero、renderFinalizeSection）：
 *   pending＝所有類別的待補、依類別分組、不列已填／選填，頁首「本月待補 N 項」（0＝本月資料已齊）；
 *   其餘＝該類別完整資料（待補、選填、已填、固定／公式唯讀全列）。
 * 每個科目卡片：新增明細（金額、分攤月數、備註、附件）、作廢（填原因）、確認為 0（連接器科目當月不給）、已定稿月份唯讀；
 * 附件：前端壓縮圖片（長邊 1600px JPEG）、HEIC 擋下、PDF 照傳；檢視走 getAttachment → Blob URL，不把附件網址當連結。
 * 寫入按鈕依 canWrite；管理者另有定稿／解除定稿（舊網站同頁）。
 */
'use strict';

import { call, errText } from '../lib/api.js';
import { getSettings, storeOptions, settle, sel, canWrite, isAdmin } from '../state.js';
import { currentMonth } from '../bridge.js';
import { storeSelectHtml, monthSelectHtml, loadingHtml, noticeHtml, errorHtml } from './common.js';
import {
  ADD_ALLOWED_MODES, catOf, fmtInt, pendingSetOf, liveSetOf, pendingGroups, categoryBlocks,
  sourceLabel, sourceSummary, showConfirmZero, validateAdd, splitHint, feeHint, attachFileId, attachKind,
  base64ToObjectUrl, prepareUpload
} from './entry-lib.js';

const STYLE = `.pnl-entry-row{border-top:1px solid var(--border,#e5e5e5);padding:8px 0}
.pnl-entry-row:first-child{border-top:0}.pnl-acc-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center}
.pnl-acc-card.is-pending{border-left:4px solid var(--warn,#d97706)}.pnl-photo{max-width:100%;max-height:360px;margin-top:6px}
.pnl-group-title{margin:12px 0 4px;font-weight:600}.pnl-add-form{margin-top:8px}.pnl-btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}`;

export function mountEntry(el, ctx, category) {
  const esc = ctx.fmt.esc;
  const isPendingView = !catOf(category);
  let alive = true;
  let seq = 0;
  let settings = null;
  let data = null;           // getMonth 回應
  let accounts = [];
  let writer = false, admin = false;
  const blobUrls = [];
  const attachOf = {};       // row_id → 附件網址（不放進 DOM，也不當連結）

  function injectStyle() {
    if (document.querySelector('style[data-pnl="entry"]')) return;
    const s = document.createElement('style');
    s.setAttribute('data-pnl', 'entry');
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const friendly = (e) => (e && e.friendly === true && e.message) ? e.message : '操作失敗，請再試一次';

  function headHtml(stores) {
    return `<div class="card stack" data-role="pnl-entry-head">
      <div class="form-grid-2">${storeSelectHtml(esc, stores, sel.store, 'pnl-entry-store')}${monthSelectHtml(esc, sel.month, currentMonth(), 'pnl-entry-month')}</div>
      <div data-role="pnl-status"></div></div><div data-role="pnl-entry-body"></div>`;
  }

  const bodyEl = () => el.querySelector('[data-role="pnl-entry-body"]');

  // ---------- 明細列 ----------
  function entryRowHtml(e, canEdit) {
    if (e.attach_url) attachOf[e.row_id] = e.attach_url;
    const attach = e.attach_url ? `<button type="button" class="btn" data-act="view-attach" data-row="${esc(e.row_id)}">查看附件</button>` : '';
    const voidBtn = canEdit ? `<button type="button" class="btn btn-danger" data-act="void" data-row="${esc(e.row_id)}" data-amount="${esc(fmtInt(e.amount))}">作廢</button>` : '';
    return `<div class="pnl-entry-row" data-role="pnl-entry" data-row="${esc(e.row_id)}">
      <div><b>NT$ ${esc(fmtInt(e.amount))}</b>${e.split_months > 1 ? ` <span class="tag">分 ${esc(e.split_months)} 月</span>` : ''} <span class="text-muted">${esc(sourceLabel(e.source))}</span></div>
      ${e.note ? `<div>${esc(e.note)}</div>` : ''}
      <div class="text-muted">${esc(e.created_by || '')}　${esc(String(e.created_at || '').slice(0, 10))}</div>
      <div class="pnl-btnrow">${attach}${voidBtn}</div><div data-slot="attach"></div></div>`;
  }

  // ---------- 科目卡片 ----------
  function accountCardHtml(a, ps, canEdit, monthExists) {
    const entries = (data.entries || []).filter((e) => e.acc_id === a.acc_id && e.void !== true);
    const pending = ps[a.acc_id] === true;
    const optional = !pending && a.params && a.params.optional === true && entries.length === 0;
    const value = (data.result.accounts || {})[a.acc_id];
    let inner = '';
    if (a.mode === '固定' || a.mode === '公式') {
      inner = `<p class="text-muted">${a.mode === '固定' ? '固定科目，金額由門市設定值決定，本頁唯讀' : '公式科目，由其他科目計算得出，本頁唯讀'}</p>`;
    } else {
      if (!entries.length) inner += '<p class="text-muted" data-role="pnl-empty">本月尚無明細</p>';
      else {
        const sum = sourceSummary(entries);
        if (sum) inner += `<p class="text-muted">${esc(sum)}</p>`;
        inner += entries.map((e) => entryRowHtml(e, canEdit)).join('');
      }
      const canAdd = canEdit && ADD_ALLOWED_MODES[a.mode];
      if (a.mode === '匯入' && canEdit) inner += '<p class="text-muted">此科目由「匯入」功能寫入整月彙總，本頁僅能查看與作廢單筆，新增請至匯入頁</p>';
      else if (canAdd) inner += `<div class="pnl-btnrow"><button type="button" class="btn" data-act="add-toggle" data-acc="${esc(a.acc_id)}">＋ 新增一筆</button>${
        showConfirmZero(a, pending, canEdit, monthExists, sel.month, currentMonth())
          ? `<button type="button" class="btn" data-act="confirm-zero" data-acc="${esc(a.acc_id)}">確認為 0</button>` : ''}</div><div data-slot="form"></div>`;
    }
    return `<div class="card stack pnl-acc-card${pending ? ' is-pending' : ''}" data-role="pnl-acc" data-acc="${esc(a.acc_id)}" data-pending="${pending ? '1' : '0'}">
      <div class="pnl-acc-head"><div><b>${esc(a.name)}</b> <span class="tag">${esc(a.mode)}</span>${pending ? ' <span class="tag tag-warn">待補</span>' : (optional ? ' <span class="tag">選填</span>' : '')}</div>
      <div data-role="pnl-acc-value">NT$ ${esc(fmtInt(value))}</div></div>${inner}</div>`;
  }

  function addFormHtml(a) {
    const hint = feeHint(a);
    return `<form class="stack pnl-add-form" data-role="pnl-add-form" data-acc="${esc(a.acc_id)}" novalidate>
      <div class="field"><label class="field-label">金額</label><input class="input" type="number" min="0" step="any" data-role="pnl-amount">${hint ? `<div class="field-hint">${esc(hint)}</div>` : ''}</div>
      <div class="field"><label class="field-label">分攤月數</label><input class="input" type="number" min="1" step="1" value="1" data-role="pnl-split"><div class="field-hint" data-role="pnl-split-hint"></div></div>
      <div class="field"><label class="field-label">備註</label><input class="input" type="text" data-role="pnl-note"></div>
      <div class="field"><label class="field-label">附件（選填，圖片或 PDF）</label><input class="input" type="file" accept="image/*,application/pdf" data-role="pnl-file"></div>
      <div class="field-hint" data-role="pnl-photo-status"></div><div class="text-muted" data-role="pnl-add-error"></div>
      <div class="pnl-btnrow"><button type="submit" class="btn btn-primary" data-act="add-submit">送出</button><button type="button" class="btn" data-act="add-cancel">取消</button></div></form>`;
  }

  // ---------- 主畫面 ----------
  function statusHtml(status, locked) {
    let h = `<span class="tag${locked ? ' tag-warn' : ''}" data-role="pnl-month-status">狀態：${esc(status || '無')}</span>`;
    if (status === '無') {
      h += `<p class="text-muted" data-role="pnl-nodraft">本月尚未建立草稿，新增第一筆明細後會自動建立草稿${admin ? '（管理者也可在設定頁建立）' : ''}</p>`;
    } else if (locked) {
      h += ' <span class="text-muted" data-role="pnl-locked">已定稿（管理者可解除）</span>';
    }
    if (admin && status && status !== '無') {
      h += locked
        ? ' <button type="button" class="btn" data-act="unlock">解除定稿</button>'
        : ' <button type="button" class="btn btn-primary" data-act="finalize">定稿</button>';
    }
    return h;
  }

  function renderBody() {
    const b = bodyEl();
    if (!b || !data) return;
    const status = data.status;
    const locked = status === '定稿';
    const canEdit = writer && !locked;
    const monthExists = status !== '無';
    el.querySelector('[data-role="pnl-status"]').innerHTML = statusHtml(status, locked);
    const pend = (data.result && data.result.pending) || [];
    const ps = pendingSetOf(pend);
    let html = '';
    if (isPendingView) {
      const g = pendingGroups(accounts, pend, data.entries);
      html += `<div class="card" role="status"><b data-role="pnl-pending-total">${g.total ? '本月待補 ' + g.total + ' 項' : '本月資料已齊'}</b></div>`;
      if (!g.total) html += '<div class="card" data-role="pnl-all-done"><p class="text-muted">本月資料已齊，沒有待補科目。要查看或修改已填資料，請點上方類別。</p></div>';
      g.groups.forEach((x) => {
        html += `<div class="pnl-group-title" data-role="pnl-group" data-cat="${esc(x.cat.key)}">${esc(x.cat.label)}（${x.accs.length}）</div>`;
        html += x.accs.map((a) => accountCardHtml(a, ps, canEdit, monthExists)).join('');
      });
    } else {
      const blocks = categoryBlocks(accounts, pend, data.entries, category);
      blocks.forEach((x) => {
        html += `<div class="pnl-group-title" data-role="pnl-block" data-block="${esc(x.block)}">${esc(x.block)}</div>`;
        html += x.accs.map((a) => accountCardHtml(a, ps, canEdit, monthExists)).join('');
      });
      if (!blocks.length) html += `<div class="card"><p class="text-muted">「${esc(catOf(category).label)}」沒有科目</p></div>`;
    }
    b.innerHTML = html;
  }

  async function load(opts) {
    const mine = ++seq;
    const b = bodyEl();
    if (b && !(opts && opts.keep)) b.innerHTML = loadingHtml();
    const store = sel.store, month = sel.month;
    const r = await call(ctx, 'getMonth', { store_id: store, month });
    if (!alive || mine !== seq) return;
    if (!r.ok || !r.data || !r.data.result) { bodyEl().innerHTML = errorHtml(esc, errText(r)); return; }
    data = r.data;
    renderBody();
  }

  async function act(fn) {   // 寫入動作共用：讀取遮罩、失敗 toast
    ctx.ui.loading(true);
    try { return await fn(); } finally { ctx.ui.loading(false); }
  }

  async function askReason(title, line) {
    const box = document.createElement('div');
    box.innerHTML = `<p>${esc(line)}</p><div class="field"><label class="field-label">原因（必填）</label>
      <input class="input" type="text" maxlength="200" data-role="pnl-reason"></div>`;
    for (;;) {
      const v = await ctx.ui.dialog({ title, body: box, actions: [
        { label: '取消', value: null, variant: 'secondary' }, { label: '確認', value: 'ok', variant: 'danger' }] });
      if (v !== 'ok') return null;
      const text = box.querySelector('input').value.trim();
      if (text) return text;
      ctx.ui.toast('請填原因', 'warn');
    }
  }

  async function doVoid(btn) {
    if (!writer || btn.disabled) return;
    const reason = await askReason('作廢這筆明細？', '確定要作廢這筆「' + btn.getAttribute('data-amount') + '」的明細嗎？此動作無法復原。');
    if (!alive || reason === null) return;
    btn.disabled = true;
    const r = await act(() => call(ctx, 'voidEntry', { row_id: btn.getAttribute('data-row'), reason }));
    if (!alive) return;
    if (!r.ok) { btn.disabled = false; ctx.ui.toast(errText(r), 'danger'); return; }
    ctx.ui.toast('已作廢', 'ok');
    await load({ keep: true });
  }

  async function doConfirmZero(btn) {
    if (!writer || btn.disabled) return;
    const id = btn.getAttribute('data-acc');
    const a = accounts.filter((x) => x.acc_id === id)[0];
    if (!a) return;
    let msg = '確定「' + a.name + '」本月確實為 0？會寫一筆金額 0、來源「確認為0」的明細（之後可作廢）。';
    if (a.mode === '連接器') msg += '確認後此科目不再由連接器更新，要恢復請到明細作廢這筆。';
    if (!(await ctx.ui.confirm(msg)) || !alive) return;
    btn.disabled = true;
    const r = await act(() => call(ctx, 'confirmZero', { store_id: sel.store, month: sel.month, acc_ids: [id] }));
    if (!alive) return;
    if (!r.ok) { btn.disabled = false; ctx.ui.toast(errText(r), 'danger'); return; }
    ctx.ui.toast('已確認為 0：' + a.name, 'ok');
    await load({ keep: true });
  }

  function toggleAddForm(btn) {
    const card = btn.closest('[data-role="pnl-acc"]');
    const slot = card.querySelector('[data-slot="form"]');
    if (slot.firstChild) { slot.innerHTML = ''; return; }
    const a = accounts.filter((x) => x.acc_id === btn.getAttribute('data-acc'))[0];
    if (!a) return;
    slot.innerHTML = addFormHtml(a);
  }

  async function submitAdd(form) {
    if (!writer || form.dataset.busy === '1') return;
    const q = (r) => form.querySelector('[data-role="' + r + '"]');
    const errBox = q('pnl-add-error'), status = q('pnl-photo-status');
    errBox.textContent = '';
    const v = validateAdd(q('pnl-amount').value, q('pnl-split').value);
    if (!v.ok) { errBox.textContent = v.error; return; }
    const acc = form.getAttribute('data-acc');
    const store = sel.store, month = sel.month;
    form.dataset.busy = '1';
    form.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    const file = q('pnl-file').files && q('pnl-file').files[0];
    try {
      let url = '';
      if (file) {
        if (form._cache && form._cache.file === file) url = form._cache.url;   // 上次已上傳成功，重送不再傳
        else {
          const up = await prepareUpload(file);
          status.textContent = '上傳附件中…';
          const ur = await call(ctx, 'uploadAttachment', { store_id: store, month, filename: file.name || 'attachment', mime: up.mime, base64: up.base64 });
          if (!ur.ok) throw Object.assign(new Error(errText(ur)), { friendly: true });
          url = ur.data && ur.data.url ? ur.data.url : '';
          form._cache = { file, url };
        }
      }
      const r = await call(ctx, 'addEntry', { entry: { store_id: store, month, acc_id: acc, amount: v.amount, split_months: v.split_months, note: q('pnl-note').value || '', attach_url: url } });
      if (!r.ok) throw Object.assign(new Error(errText(r)), { friendly: true });
      if (!alive) return;
      ctx.ui.toast('已新增', 'ok');
      if (store === sel.store && month === sel.month) await load({ keep: true });
    } catch (e) {
      if (!alive) return;
      form.dataset.busy = '0';
      form.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      status.textContent = '';
      errBox.textContent = friendly(e);
    }
  }

  async function viewAttach(btn) {
    const row = btn.closest('[data-role="pnl-entry"]');
    const slot = row.querySelector('[data-slot="attach"]');
    if (slot.firstChild) { slot.innerHTML = ''; return; }
    const id = attachFileId(attachOf[btn.getAttribute('data-row')]);
    if (!id) { slot.innerHTML = '<p class="text-muted">無法預覽</p>'; return; }
    btn.disabled = true;
    const r = await call(ctx, 'getAttachment', { file_id: id });
    btn.disabled = false;
    if (!alive) return;
    if (!r.ok || !r.data) { ctx.ui.toast(errText(r), 'danger'); return; }
    const kind = attachKind(r.data.mime);
    if (kind === 'none') { slot.innerHTML = '<p class="text-muted">無法預覽</p>'; return; }
    const u = base64ToObjectUrl(r.data.base64, r.data.mime);
    blobUrls.push(u);
    slot.innerHTML = (kind === 'image' ? `<img class="pnl-photo" data-role="pnl-photo" alt="附件照片" src="${esc(u)}"> ` : '')
      + `<a data-role="pnl-attach-link" href="${esc(u)}" target="_blank" rel="noopener">${kind === 'pdf' ? 'PDF 附件（點此在新分頁開啟）' : '在新分頁開啟'}</a>`;
  }

  async function doFinalize() {
    const pend = (data.result && data.result.pending) || [];
    const box = document.createElement('div');
    if (!pend.length) box.innerHTML = '<p>所有科目都已有明細，可以直接定稿。</p>';
    else {
      const name = (id) => (accounts.filter((a) => a.acc_id === id)[0] || {}).name || id;
      box.innerHTML = '<p>以下科目本月尚未填寫，請逐項確認：</p>' + pend.map((id) =>
        `<label style="display:block"><input type="checkbox" data-role="pnl-zero-cb" value="${esc(id)}"> ${esc(id)} ${esc(name(id))}　本月確實為 0</label>`).join('');
    }
    for (;;) {
      const v = await ctx.ui.dialog({ title: '定稿 ' + sel.month, body: box, actions: [
        { label: '取消', value: null, variant: 'secondary' }, { label: '確認定稿', value: 'ok', variant: 'danger' }] });
      if (v !== 'ok' || !alive) return;
      const zero = Array.from(box.querySelectorAll('input[type=checkbox]')).filter((c) => c.checked).map((c) => c.value);
      if (pend.length - zero.length > 0) { ctx.ui.toast('還有 ' + (pend.length - zero.length) + ' 個待補科目尚未勾選確認', 'warn'); continue; }
      const r = await act(() => call(ctx, 'finalize', { store_id: sel.store, month: sel.month, zero_confirm: zero }));
      if (!alive) return;
      if (!r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
      ctx.ui.toast('已定稿', 'ok');
      await load({ keep: true });
      return;
    }
  }

  async function doUnlock() {
    const reason = await askReason('解除定稿？', '確定要解除定稿嗎？解除後可再編輯，需要重新定稿。');
    if (!alive || reason === null) return;
    const r = await act(() => call(ctx, 'unlock', { store_id: sel.store, month: sel.month, reason }));
    if (!alive) return;
    if (!r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
    ctx.ui.toast('已解除定稿', 'ok');
    await load({ keep: true });
  }

  // ---------- 事件 ----------
  function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !el.contains(t)) return;
    const a = t.getAttribute('data-act');
    if (a === 'pnl-retry') { init(); return; }
    if (a === 'view-attach') viewAttach(t);
    else if (!writer) return;
    else if (a === 'void') doVoid(t);
    else if (a === 'confirm-zero') doConfirmZero(t);
    else if (a === 'add-toggle') toggleAddForm(t);
    else if (a === 'add-cancel') { const f = t.closest('form'); if (f && f.dataset.busy !== '1') f.parentNode.innerHTML = ''; }
    else if (admin && a === 'finalize') doFinalize();
    else if (admin && a === 'unlock') doUnlock();
  }
  function onSubmit(e) {
    const f = e.target;
    if (f && f.matches && f.matches('[data-role="pnl-add-form"]')) { e.preventDefault(); submitAdd(f); }
  }
  function onInput(e) {
    const f = e.target && e.target.closest ? e.target.closest('[data-role="pnl-add-form"]') : null;
    if (!f) return;
    f.querySelector('[data-role="pnl-split-hint"]').textContent = splitHint(f.querySelector('[data-role="pnl-amount"]').value, f.querySelector('[data-role="pnl-split"]').value);
  }
  function onChange(e) {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const role = t.getAttribute('data-role');
    if (role === 'pnl-store') sel.store = t.value;
    else if (role === 'pnl-entry-month' || role === 'pnl-month') sel.month = t.value;
    else return;
    load();
  }

  async function init() {
    const mine = ++seq;
    el.innerHTML = loadingHtml();
    injectStyle();
    const s = await getSettings(ctx);
    if (!alive || mine !== seq) return;
    if (!s.ok || !s.data) { el.innerHTML = errorHtml(esc, errText(s)); return; }
    settings = s.data;
    accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
    writer = canWrite(settings); admin = isAdmin(settings);
    if (!writer) { el.innerHTML = noticeHtml(esc, '你沒有填寫資料的權限', 'pnl-noperm'); return; }
    const stores = storeOptions(settings, false).filter((x) => x.active !== false);
    if (!stores.length) { el.innerHTML = noticeHtml(esc, '目前沒有可填寫的門市', 'pnl-nostore'); return; }
    settle(stores, ctx.params);
    el.innerHTML = headHtml(stores);
    await load();
  }

  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  init();

  return function unmount() {
    alive = false;
    el.removeEventListener('click', onClick);
    el.removeEventListener('submit', onSubmit);
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
    blobUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
  };
}
