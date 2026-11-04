/**
 * modules/pnl/views/settings-ops.js — 設定頁的作業區塊：月份作業、匯出 CSV、維護
 * 對照 settings.html 的 buildCreateDraftPanel／buildRefreshConnectorsPanel、entry.html 的定稿區、dashboard.html 的「下載明細 CSV」，
 * 以及試算表選單搬來的維護動作（後端 adminMaint.js，規格 plan.md C7）。
 * 建立草稿／立即拉取／建上月草稿在 mini 上回 {queued, job_id}：用 settleQueued／waitJob 等做完，畫面顯示「排隊中／執行中」。
 */
'use strict';

import { call, errText, settleQueued, waitJob } from '../lib/api.js';
import { currentMonth } from '../bridge.js';
import { monthList } from './common.js';
import {
  formatRefreshFixedResult, formatConnectorIssues, describeDraftResult, describeRefreshConnectors, jobProgressText,
  describeSelfCheck, describeSeedPreview, describeConnectorPreview, buildEntriesCsvRows, buildCsv, withBom, csvFilename
} from './settings-lib.js';

const opt = (esc, value, text, cur) => `<option value="${esc(value)}"${String(value) === String(cur) ? ' selected' : ''}>${esc(text)}</option>`;
const say = (key, cls) => `<p class="field-hint${cls ? ' ' + cls : ''}" data-say="${key}" data-role="pnl-say-${key}" role="status"></p>`;

/** 按鈕送出中停用，做完恢復 */
async function busy(t, fn) {
  t.disabled = true;
  try { return await fn(); } finally { if (t.isConnected) t.disabled = false; }
}

export function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function storeSelect(S, id, role, key, list) {
  const esc = S.esc;
  return `<div class="field"><label class="field-label" for="${id}">門市</label><select class="input" id="${id}" data-f="${key}" data-role="${role}">${list.map((s) => opt(esc, s.store_id, (s.name || s.store_id) + '（' + s.store_id + '）', S.ops[key])).join('')}</select></div>`;
}

// ================================================================ 月份作業
const month = {
  id: 'month', label: '月份作業',
  render(S) {
    const esc = S.esc, o = S.ops, thisMonth = currentMonth();
    const active = S.data.stores.filter((s) => s.active);
    const none = active.length === 0 ? '<p class="field-hint" data-role="pnl-set-nostore">尚未設定啟用的門市：請先到「門市」新增並勾選啟用。</p>' : '';
    const fin = o.fin;
    let finBody = '';
    if (fin) {
      if (fin.status === '無') finBody = `<p data-role="pnl-fin-status">${esc(fin.store_id)} ${esc(fin.month)}：尚無這個月份，請先建立草稿。</p>`;
      else if (fin.status === '定稿') {
        finBody = `<p data-role="pnl-fin-status"><span class="tag tag-ok">已定稿</span> ${esc(fin.store_id)} ${esc(fin.month)}（管理者可解除）</p>
          <button type="button" class="btn btn-secondary" data-act="fin-unlock" data-role="pnl-fin-unlock">解除定稿</button>`;
      } else {
        const names = {}; S.data.accounts.forEach((a) => { names[a.acc_id] = a.name; });
        const pend = fin.pending.length
          ? '<p class="field-hint">以下科目本月尚未填寫，請逐項確認：</p>' + fin.pending.map((id) => `<label class="field-hint" style="display:block"><input type="checkbox" data-f="fin-zero" data-acc="${esc(id)}"${o.finZero[id] ? ' checked' : ''}> ${esc(id)} ${esc(names[id] || '')}　本月確實為 0</label>`).join('')
          : '<p class="field-hint">所有科目都已有明細，可以直接定稿。</p>';
        finBody = `<p data-role="pnl-fin-status"><span class="tag tag-warn">${esc(fin.status)}</span> ${esc(fin.store_id)} ${esc(fin.month)}</p>${pend}
          <button type="button" class="btn btn-primary" data-act="fin-do" data-role="pnl-fin-do">定稿</button>`;
      }
    }
    return `<div class="stack" data-role="pnl-set-month">
      <div class="card stack" data-role="pnl-set-create"><div class="card-title">建立草稿</div>${none}
        <p class="field-hint">月份上限＝當月（每天 06:30 本來就會建當月草稿，1 號 06:30 前或排程沒跑時可以手動補建）。預設上個月（月結最常用）。</p>
        <div class="form-grid-2">${storeSelect(S, 'pnl-create-store', 'pnl-create-store', 'createStore', active)}
          <div class="field"><label class="field-label" for="pnl-create-month">月份</label><input class="input" type="month" id="pnl-create-month" data-f="createMonth" data-role="pnl-create-month" max="${esc(thisMonth)}" value="${esc(o.createMonth)}"></div></div>
        <div class="card-row"><button type="button" class="btn btn-primary" data-act="create-draft" data-role="pnl-create-draft"${none ? ' disabled' : ''}>建立草稿</button>
          <button type="button" class="btn btn-secondary" data-act="refresh-fixed" data-role="pnl-refresh-fixed"${none ? ' disabled' : ''}>重新帶入固定值</button></div>
        ${say('create')}${say('fixed')}</div>
      <div class="card stack" data-role="pnl-set-refresh"><div class="card-title">立即拉取連接器</div>
        <p class="field-hint">只重拉「連接器」取值方式的科目，手動填過的科目不會被覆蓋；調撥連接器建議在每個月定稿前重拉一次（單據可能後補簽收，數字會變動）。月份列必須已經存在（通常是建過草稿之後）。</p>
        <div class="form-grid-2">${storeSelect(S, 'pnl-refresh-store', 'pnl-refresh-store', 'refreshStore', active)}
          <div class="field"><label class="field-label" for="pnl-refresh-month">月份</label><input class="input" type="month" id="pnl-refresh-month" data-f="refreshMonth" data-role="pnl-refresh-month" max="${esc(thisMonth)}" value="${esc(o.refreshMonth)}"></div></div>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="refresh-conn" data-role="pnl-refresh-conn"${none ? ' disabled' : ''}>立即拉取連接器</button></div>${say('refresh')}</div>
      <div class="card stack" data-role="pnl-set-finalize"><div class="card-title">定稿／解除定稿</div>
        <div class="form-grid-2">${storeSelect(S, 'pnl-fin-store', 'pnl-fin-store', 'finStore', active)}
          <div class="field"><label class="field-label" for="pnl-fin-month">月份</label><select class="input" id="pnl-fin-month" data-f="finMonth" data-role="pnl-fin-month">${monthList(thisMonth, 24).map((m) => opt(esc, m, m, o.finMonth)).join('')}</select></div></div>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="fin-load" data-role="pnl-fin-load"${none ? ' disabled' : ''}>查看這個月的狀態</button></div>
        ${finBody}${say('fin')}</div></div>`;
  },
  async event(S, kind, t) {
    const o = S.ops, ctx = S.ctx;
    if (kind === 'input') {
      const f = t.dataset.f;
      if (f === 'fin-zero') { o.finZero[t.dataset.acc] = t.checked; return; }
      o[f] = t.value;
      if (f === 'finStore' || f === 'finMonth') { o.fin = null; o.finZero = {}; S.redraw(); }
      return;
    }
    switch (t.dataset.act) {
      case 'create-draft': return busy(t, async () => {
        const sid = o.createStore, mon = o.createMonth;
        S.say('fixed', ''); S.say('create', '');
        if (!sid || !mon) return S.say('create', '請選門市與月份', true);
        S.say('create', '已送出，排隊中…');
        const r0 = await call(ctx, 'createDraft', { store_id: sid, month: mon });
        const r = await settleQueued(ctx, r0, (job) => S.say('create', jobProgressText(job, sid + ' ' + mon + ' 建立草稿')));
        if (!S.alive) return;
        if (!r.ok) { S.say('create', errText(r), true); return S.toast(errText(r), 'danger'); }
        const res = Object.assign({ store_id: sid, month: mon }, r.data);
        const issues = formatConnectorIssues(res);
        const text = describeDraftResult(res) + (issues ? '；' + issues : '');
        S.say('create', text);
        S.toast(describeDraftResult(res), 'ok');
      });
      case 'refresh-fixed': return busy(t, async () => {
        const sid = o.createStore, mon = o.createMonth;
        S.say('create', ''); S.say('fixed', '');
        if (!sid || !mon) return S.say('fixed', '請選門市與月份', true);
        const body = S.lines([sid + ' ' + mon + '：依「門市固定值」目前的設定（含攤提、起迄月），重寫這個月「固定」與「上月結轉」兩種來源的明細。',
          '金額不同的會作廢舊的、寫新的；缺的會補寫；已不適用的（過了迄月、設定已移除）會作廢；相同的不動。',
          '手動、匯入、連接器、確認為 0 的明細一律不動；已定稿的月份不能用（要先解鎖）。']);
        if (!(await S.ask('重新帶入固定值', body, '確認重新帶入'))) return;
        S.say('fixed', '處理中…');
        const r = await call(ctx, 'refreshFixed', { store_id: sid, month: mon });
        if (!S.alive) return;
        if (!r.ok) { S.say('fixed', errText(r), true); return S.toast(errText(r), 'danger'); }
        const text = formatRefreshFixedResult(Object.assign({ store_id: sid, month: mon }, r.data));
        S.say('fixed', text);
        S.toast('已重新帶入固定值（更新 ' + (r.data.updated || 0) + '、補寫 ' + (r.data.added || 0) + '、作廢 ' + (r.data.voided || 0) + '）', 'ok');
      });
      case 'refresh-conn': return busy(t, async () => {
        const sid = o.refreshStore, mon = o.refreshMonth;
        S.say('refresh', '');
        if (!sid || !mon) return S.say('refresh', '請選門市與月份', true);
        S.say('refresh', '已送出，排隊中…');
        const r0 = await call(ctx, 'refreshConnectors', { store_id: sid, month: mon });
        const r = await settleQueued(ctx, r0, (job) => S.say('refresh', jobProgressText(job, sid + ' ' + mon + ' 拉取連接器')));
        if (!S.alive) return;
        if (!r.ok) { S.say('refresh', errText(r), true); return S.toast(errText(r), 'danger'); }
        const text = describeRefreshConnectors(Object.assign({ store_id: sid, month: mon }, r.data));
        S.say('refresh', text);
        S.toast('已重新拉取連接器', 'ok');
      });
      case 'fin-load': return busy(t, async () => {
        await loadFin(S);
      });
      case 'fin-do': return busy(t, async () => {
        const fin = o.fin;
        const left = fin.pending.filter((id) => !o.finZero[id]);
        if (left.length) return S.say('fin', '還有 ' + left.length + ' 個待補科目尚未勾選確認', true);
        S.say('fin', '');
        const r = await call(ctx, 'finalize', { store_id: fin.store_id, month: fin.month, zero_confirm: fin.pending.slice() });
        if (!S.alive) return;
        if (!r.ok) { S.say('fin', errText(r), true); return S.toast(errText(r), 'danger'); }
        S.toast('已定稿', 'ok');
        await loadFin(S);
      });
      case 'fin-unlock': return busy(t, async () => {
        const fin = o.fin;
        const reason = await S.promptReason('解除定稿', '確定要解除定稿嗎？解除後可再編輯，需要重新定稿。');
        if (reason === null) return;
        if (!reason) return S.say('fin', '請填解除定稿的原因', true);
        S.say('fin', '');
        const r = await call(ctx, 'unlock', { store_id: fin.store_id, month: fin.month, reason });
        if (!S.alive) return;
        if (!r.ok) { S.say('fin', errText(r), true); return S.toast(errText(r), 'danger'); }
        S.toast('已解除定稿', 'ok');
        await loadFin(S);
      });
      default:
    }
  }
};

async function loadFin(S) {
  const o = S.ops;
  if (!o.finStore || !o.finMonth) return S.say('fin', '請選門市與月份', true);
  S.say('fin', '讀取中…');
  const r = await call(S.ctx, 'getMonth', { store_id: o.finStore, month: o.finMonth });
  if (!S.alive) return;
  if (!r.ok) { S.say('fin', errText(r), true); return; }
  const d = r.data || {};
  o.fin = { store_id: o.finStore, month: o.finMonth, status: d.status || '無', pending: d.result && Array.isArray(d.result.pending) ? d.result.pending.slice() : [] };
  o.finZero = {};
  o.msgs.fin = '';
  S.redraw();
}

// ================================================================ 匯出 CSV
const exportTab = {
  id: 'export', label: '匯出 CSV',
  render(S) {
    const esc = S.esc, o = S.ops;
    const list = [{ store_id: 'ALL', name: '全部門市' }].concat(S.data.stores);
    return `<div class="card stack" data-role="pnl-set-export"><div class="card-title">匯出明細 CSV</div>
      <p class="field-hint">匯出該店該月的逐筆明細（含作廢；UTF-8、可直接用 Excel 開啟）。月份明細超過上限時，後端會請你改由資料庫匯出。</p>
      <div class="form-grid-2"><div class="field"><label class="field-label" for="pnl-export-store">門市</label><select class="input" id="pnl-export-store" data-f="exportStore" data-role="pnl-export-store">${list.map((s) => opt(esc, s.store_id, (s.name || s.store_id) + (s.store_id === 'ALL' ? '' : '（' + s.store_id + '）'), o.exportStore)).join('')}</select></div>
        <div class="field"><label class="field-label" for="pnl-export-month">月份</label><select class="input" id="pnl-export-month" data-f="exportMonth" data-role="pnl-export-month">${monthList(currentMonth(), 24).map((m) => opt(esc, m, m, o.exportMonth)).join('')}</select></div></div>
      <div class="card-row"><button type="button" class="btn btn-primary" data-act="export-csv" data-role="pnl-export-csv">下載明細 CSV</button></div>${say('export')}</div>`;
  },
  async event(S, kind, t) {
    const o = S.ops;
    if (kind === 'input') { o[t.dataset.f] = t.value; return; }
    if (t.dataset.act !== 'export-csv') return;
    return busy(t, async () => {
      const sid = o.exportStore, mon = o.exportMonth;
      S.say('export', '匯出中…');
      const r = await call(S.ctx, 'exportEntries', { store_id: sid, month: mon });
      if (!S.alive) return;
      if (!r.ok) { S.say('export', errText(r), true); return S.toast(errText(r), 'danger'); }
      const names = {}; S.data.accounts.forEach((a) => { names[a.acc_id] = a.name; });
      const meta = {}; S.data.stores.forEach((s) => { meta[s.store_id] = s; });
      const entries = (r.data && r.data.entries) || [];
      const rows = buildEntriesCsvRows(entries, {
        accountName: (id) => names[id] || id,
        storeName: (id) => (meta[id] && meta[id].name) || id,
        storeBrand: (id) => (meta[id] && meta[id].brand) || ''
      });
      const label = sid === 'ALL' ? '全部' : ((meta[sid] && meta[sid].name) || sid);
      const filename = csvFilename('明細', label, mon);
      downloadCsv(filename, withBom(buildCsv(rows)));
      S.say('export', '已下載 ' + filename + '（' + entries.length + ' 筆）');
      S.toast('已下載 ' + filename, 'ok');
    });
  }
};

// ================================================================ 維護
async function previewThenApply(S, o) {
  // o：{ title, action, payload, describe(view)→lines, viewOf(data)→view, ready(view)→'' 或不能繼續的原因, empty(view)→bool, confirmLabel, finalizedWarn(view)→文字|'' , sayKey, doneText(data)→文字 }
  const key = o.sayKey;
  S.say(key, '計算差異中…');
  const p = await call(S.ctx, o.action, Object.assign({}, o.payload));
  if (!S.alive) return;
  if (!p.ok) { S.say(key, errText(p), true); return S.toast(errText(p), 'danger'); }
  const view = o.viewOf(p.data);
  if (!view) { S.say(key, '後端沒有回預覽，未寫入任何資料', true); return; }
  const lines = o.describe(view);
  S.say(key, lines.join('；'));
  const stop = o.stop && o.stop(view);
  if (stop) { S.say(key, stop, true); return S.toast(stop, 'warn'); }
  if (o.empty(view)) { S.say(key, lines.join('；') + '。已一致，不需要變更'); return; }
  if (!(await S.ask(o.title + '：確認前先看差異', S.lines(lines), o.confirmLabel))) { S.say(key, lines.join('；') + '（已取消，未寫入）'); return; }
  const payload = Object.assign({}, o.payload, { confirm: true, signature: view.signature });
  const warn = o.finalizedWarn && o.finalizedWarn(view);
  if (warn) {
    if (!(await S.ask('再確認一次', S.lines([warn, '要繼續嗎？']), '我了解，繼續', 'danger'))) { S.say(key, '已取消，未寫入'); return; }
    payload.confirmFinalized = true;
  }
  S.say(key, '寫入中…');
  const r = await call(S.ctx, o.action, payload);
  if (!S.alive) return;
  if (!r.ok) {
    const msg = r.error === 'CONFLICT' ? '預覽之後資料被改過，請重新按一次預覽' : errText(r);
    S.say(key, msg, true); return S.toast(msg, 'danger');
  }
  const text = r.data && r.data.applied === false ? (r.data.reason || '沒有變更') : o.doneText(r.data || {});
  S.say(key, text);
  S.toast(text, 'ok');
  return r.data;
}

const maint = {
  id: 'maint', label: '維護',
  render(S) {
    return `<div class="stack" data-role="pnl-set-maint">
      <div class="card stack" data-role="pnl-set-selfcheck"><div class="card-title">自我檢查</div>
        <p class="field-hint">檢查各分頁是否齊全、機密設定是否都有、使用者名單有沒有問題。只讀，不改資料。</p>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="maint-selfcheck" data-role="pnl-maint-selfcheck">執行自我檢查</button></div>
        <div data-role="pnl-selfcheck-result">${S.ops.selfcheck ? selfCheckHtml(S, S.ops.selfcheck) : ''}</div></div>
      <div class="card stack" data-role="pnl-set-sync"><div class="card-title">同步科目範本</div>
        <p class="field-hint">把標準科目範本與目前的科目表比對。「保守同步」只補缺的科目；「完整同步」連已有科目的設定也一併更新。都會先顯示差異，確認後才寫入。</p>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="maint-sync-safe" data-role="pnl-maint-sync-safe">保守同步（預覽）</button>
          <button type="button" class="btn btn-secondary" data-act="maint-sync-full" data-role="pnl-maint-sync-full">完整同步（預覽）</button></div>${say('sync')}</div>
      <div class="card stack" data-role="pnl-set-s01conn"><div class="card-title">套用光復連接器對應</div>
        <p class="field-hint">只寫連接器的「對應 JSON」，不動 URL 與金鑰。先預覽差異，確認才寫入。</p>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="maint-s01conn" data-role="pnl-maint-s01conn">套用光復連接器對應（預覽）</button></div>${say('s01conn')}</div>
      <div class="card stack" data-role="pnl-set-lastmonth"><div class="card-title">建立上月草稿</div>
        <p class="field-hint">為每家啟用的門市建上個月的草稿（每月 1 號 06:00 本來會自動做，沒跑到時用這個補）。</p>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="maint-lastmonth" data-role="pnl-maint-lastmonth">建立上月草稿</button></div>${say('lastmonth')}
        <div data-role="pnl-lastmonth-list">${S.ops.lastLines.map((l) => `<div>${S.esc(l)}</div>`).join('')}</div></div>
      <div class="card stack" data-role="pnl-set-s01seed"><div class="card-title">載入光復門市資料</div>
        <p class="field-hint">載入光復門市與門市科目（冪等，已載過不會重複寫入）。只有光復正式表才有這份種子。</p>
        <div class="card-row"><button type="button" class="btn btn-secondary" data-act="maint-s01seed" data-role="pnl-maint-s01seed">載入光復門市資料</button></div>${say('s01seed')}</div></div>`;
  },
  async event(S, kind, t) {
    if (kind !== 'click') return;
    const ctx = S.ctx;
    switch (t.dataset.act) {
      case 'maint-selfcheck': return busy(t, async () => {
        S.say('selfcheck', '');
        const r = await call(ctx, 'adminSelfCheck', {});
        if (!S.alive) return;
        if (!r.ok) return S.toast(errText(r), 'danger');
        S.ops.selfcheck = r.data;
        const box = S.panelEl.querySelector('[data-role="pnl-selfcheck-result"]');
        if (box) box.innerHTML = selfCheckHtml(S, r.data);
      });
      case 'maint-sync-safe':
      case 'maint-sync-full': {
        const full = t.dataset.act === 'maint-sync-full';
        return busy(t, async () => {
          const data = await previewThenApply(S, {
            title: full ? '完整同步科目範本' : '保守同步科目範本', action: 'adminSyncSeed', payload: { full }, sayKey: 'sync',
            viewOf: (d) => d && d.preview, describe: describeSeedPreview,
            stop: (v) => (v.validation ? '同步後的科目表驗證不通過，未寫入：' + v.validation : ''),
            empty: (v) => !v.adds && !v.updates,
            confirmLabel: '確認同步',
            finalizedWarn: (v) => (full && v.finalizedMonths > 0 ? '完整同步會更新已有科目的設定，目前有 ' + v.finalizedMonths + ' 個已定稿月份，它們的計算結果可能因此改變。' : ''),
            doneText: (d) => '已同步：新增 ' + (d.adds || 0) + '、更新 ' + (d.updates || 0)
          });
          if (data && data.applied) await S.reload();
        });
      }
      case 'maint-s01conn': return busy(t, async () => {
        await previewThenApply(S, {
          title: '套用光復連接器對應', action: 'adminApplyS01Connectors', payload: {}, sayKey: 's01conn',
          viewOf: (d) => d && d.preview, describe: describeConnectorPreview,
          empty: (v) => !v.changes, confirmLabel: '確認套用',
          doneText: (d) => '已套用：' + (d.changes || 0) + ' 項變更'
        });
      });
      case 'maint-lastmonth': return busy(t, async () => {
        if (!(await S.ask('建立上月草稿', S.lines(['為每家啟用的門市建立上個月的草稿；已定稿或已存在的月份不會重建。']), '確認建立'))) return;
        S.ops.lastLines = [];
        S.say('lastmonth', '已送出…');
        const r = await call(ctx, 'adminCreateLastMonthDraft', {});
        if (!S.alive) return;
        if (!r.ok) { S.say('lastmonth', errText(r), true); return S.toast(errText(r), 'danger'); }
        const d = r.data || {};
        const lines = [];
        const paint = () => { S.ops.lastLines = lines.slice(); const box = S.panelEl.querySelector('[data-role="pnl-lastmonth-list"]'); if (box) box.innerHTML = lines.map((l) => `<div>${S.esc(l)}</div>`).join(''); };
        if (Array.isArray(d.jobs)) {
          for (const j of d.jobs) {
            const idx = lines.length;
            lines.push(j.store_id + '：排隊中…'); paint();
            const w = await waitJob(ctx, j.job_id, (job) => { lines[idx] = j.store_id + '：' + jobProgressText(job); paint(); });
            if (!S.alive) return;
            if (!w.ok) lines[idx] = j.store_id + '：' + errText(w);
            else if (w.job.status === 'fail') lines[idx] = j.store_id + '：失敗（' + ((w.job.result && (w.job.result.message || w.job.result.code)) || '') + '）';
            else {
              const res = w.job.result || {};
              const issues = formatConnectorIssues(res);
              lines[idx] = j.store_id + '：' + (res.skipped ? '已定稿，未重建' : '完成（帶入 ' + (res.entriesAdded || 0) + ' 筆）') + (issues ? '；' + issues : '');
            }
            paint();
          }
        } else {
          (d.results || []).forEach((x) => {
            lines.push(x.store_id + '：' + (x.error ? '失敗（' + x.error + '）' : (x.skipped ? '已定稿，未重建' : '完成（帶入 ' + (x.entriesAdded || 0) + ' 筆）') + ((x.connectorFailures || []).length ? '；連接器失敗：' + x.connectorFailures.join('、') : '')));
          });
          paint();
        }
        const text = (d.month || '上月') + ' 草稿：' + lines.join('；');
        S.say('lastmonth', (d.month || '上月') + ' 草稿處理完成（共 ' + lines.length + ' 家）');
        S.toast('上月草稿處理完成', 'ok');
      });
      case 'maint-s01seed': return busy(t, async () => {
        if (!(await S.ask('載入光復門市資料', S.lines(['載入光復門市與門市科目（已載過不會重複寫入）。']), '確認載入'))) return;
        S.say('s01seed', '處理中…');
        const r = await call(ctx, 'adminLoadStoreSeedS01', {});
        if (!S.alive) return;
        if (!r.ok) { S.say('s01seed', errText(r), true); return S.toast(errText(r), 'danger'); }
        S.say('s01seed', '已載入光復門市資料');
        S.toast('已載入光復門市資料', 'ok');
        await S.reload();
      });
      default:
    }
  }
};

function selfCheckHtml(S, data) {
  const esc = S.esc, d = describeSelfCheck(data);
  const warn = d.warnings.length ? d.warnings.map((w) => `<div class="tag tag-danger" data-role="pnl-selfcheck-warn" style="display:block;margin:2px 0">${esc(w)}</div>`).join('') : '<div class="tag tag-ok" data-role="pnl-selfcheck-ok">沒有發現問題</div>';
  return `<div class="stack">${warn}<div class="field-hint" style="white-space:pre-wrap">${d.lines.map(esc).join('\n')}</div></div>`;
}

export const OPS_SECTIONS = [month, exportTab, maint];
