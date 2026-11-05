/**
 * modules/pnl/views/import.js — 匯入頁（對照舊網站 gas/import.html：選門市／月份／匯入範本 → 選檔（可多選）→ 預覽 → 確認匯入 importEntries）。
 * 檔案只在瀏覽器解析（SheetJS 於選檔時才載入），送到後端的只有各科目彙總後的金額。解析／彙總規則全在 lib/import-logic.js。
 * 範本進階設定／存成新範本只給管理者（saveSettings table=templates）。
 */
'use strict';

import { call, errText } from '../lib/api.js';
import { getSettings, invalidateSettings, storeOptions, settle, sel, isAdmin, canWrite } from '../state.js';
import { currentMonth } from '../bridge.js';
import { storeSelectHtml, monthSelectHtml, loadingHtml, noticeHtml, errorHtml } from './common.js';
import { loadXlsx } from '../lib/load-xlsx.js';
import {
  ImportLogic, ACC_ID_DIRECT_KEY, fmtInt, sheetToRows2D, readWorkbookBuf, canConfirmImport
} from '../lib/import-logic.js';

const STYLE = `
.pnl-imp-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border,#e5e7eb)}
.pnl-imp-total{font-weight:700}
.pnl-imp-amt{white-space:nowrap}
.pnl-imp-warn{background:#fff7e0;border:1px solid #e8c660;border-radius:8px;padding:10px 12px}
.pnl-imp-err{background:#fdecec;border:1px solid #e08a8a;border-radius:8px;padding:10px 12px}
.pnl-imp-check{display:flex;gap:6px;align-items:flex-start;padding:3px 0}
.pnl-imp-maprow{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
.pnl-imp-maprow .input{flex:1 1 120px;min-width:0}
`;

export function mountImport(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let settings = null;
  let accounts = [];
  let templates = [];
  let storeNameMap = {};
  let currentTpl = null;
  let currentTplSaved = true;
  let files = [];               // [{name, buf}] 目前選的檔
  let lastFileList = [];        // [{name, rows2D}]
  let failedFiles = [];
  let includedOverride = {};
  let voidOtherOverride = {};
  let lastExisting = null;      // 代號直入模式才讀 getMonth
  let previewSeq = 0;
  let busy = false;
  let view = null;              // 目前預覽的彙總結果（確認匯入要用）

  const $ = (q) => el.querySelector(q);

  function injectStyle() {
    if (document.head.querySelector('style[data-pnl="import"]')) return;
    const st = document.createElement('style');
    st.setAttribute('data-pnl', 'import');
    st.textContent = STYLE;
    document.head.appendChild(st);
  }
  injectStyle();

  const accountName = (id) => { const a = accounts.find((x) => x.acc_id === id); return a ? a.name : id; };
  const toast = (m, t) => ctx.ui.toast(m, t || 'info');
  const monthNow = () => (sel.month || currentMonth());

  /* ------------------------------ 骨架 ------------------------------ */
  function shell(options) {
    el.innerHTML = `<div class="stack" data-role="pnl-import">
      <div class="card stack">
        <div class="form-grid-2">${storeSelectHtml(esc, options, sel.store, 'pnl-imp-store')}${monthSelectHtml(esc, sel.month, currentMonth(), 'pnl-imp-month')}</div>
        <div class="field"><label class="field-label" for="pnl-imp-tpl">匯入範本</label>
          <select class="input" id="pnl-imp-tpl" data-role="pnl-import-tpl">${templates.map((t) => `<option value="${esc(t.tpl_id)}"${currentTpl && t.tpl_id === currentTpl.tpl_id ? ' selected' : ''}>${esc(t.tpl_id + ' ' + t.name)}</option>`).join('')}</select></div>
        <div class="field-hint" data-role="pnl-import-tpl-summary"></div>
        <div data-role="pnl-import-tpl-editor"></div>
        <div class="field"><label class="field-label" for="pnl-imp-file">選檔（可一次多選）</label>
          <input class="input" type="file" id="pnl-imp-file" data-role="pnl-import-file" multiple accept=".xls,.xlsx,.csv">
          <p class="field-hint">副檔名只是參考，系統依檔案內容判斷格式；檔案只在這台電腦解析，不會上傳原檔。</p></div>
      </div>
      <div data-role="pnl-import-preview"></div>
    </div>`;
    renderTplSummary();
    renderTplEditor();
  }

  /* ------------------------------ 範本摘要／編輯 ------------------------------ */
  function renderTplSummary() {
    const box = $('[data-role="pnl-import-tpl-summary"]');
    if (!box) return;
    if (!currentTpl) { box.innerHTML = ''; return; }
    const t = currentTpl;
    const keys = Object.keys(t.mapping || {});
    const line1 = `金額欄：${esc(t.amount_col || '—')}　日期欄：${esc(t.date_col || '（不檢查月份）')}　分組欄：${esc(t.group_col || '（全部歸同一科目）')}`;
    const line2 = ImportLogic.isAccIdDirect(t)
      ? '對應規則：分組欄的值直接當科目代號（去前後空白、轉大寫；不存在／未啟用／不能匯入的代號會擋下）'
      : `對應規則：${keys.length} 條（完全相符優先 → 前綴 * → 萬用字元 *）`;
    box.innerHTML = `<div>${line1}</div><div>${esc(line2)}</div>`;
  }

  function eligibleAccounts() {
    const allowed = { 匯入: true, 手動: true, 連接器: true };
    return accounts.filter((a) => a.active === true && allowed[a.mode]);
  }

  function mapRowHtml(key, accId) {
    const opts = eligibleAccounts().map((a) => `<option value="${esc(a.acc_id)}"${a.acc_id === accId ? ' selected' : ''}>${esc(a.acc_id + ' ' + a.name)}</option>`).join('');
    return `<div class="pnl-imp-maprow" data-role="pnl-tpl-maprow">
      <input class="input" type="text" placeholder="分組值或前綴*" value="${esc(key || '')}" data-role="pnl-tpl-mapkey">
      <select class="input" data-role="pnl-tpl-mapacc">${opts}</select>
      <button type="button" class="btn" data-act="tpl-del-map">移除</button></div>`;
  }

  function renderTplEditor() {
    const box = $('[data-role="pnl-import-tpl-editor"]');
    if (!box) return;
    if (!isAdmin(settings) || !currentTpl) { box.innerHTML = ''; return; }
    const t = currentTpl;
    const direct = ImportLogic.isAccIdDirect(t);
    const mapping = direct ? {} : (t.mapping || {});
    const first = eligibleAccounts()[0];
    const rows = Object.keys(mapping).map((k) => mapRowHtml(k, mapping[k])).join('') || mapRowHtml('*', first ? first.acc_id : '');
    box.innerHTML = `<div class="stack">
      <div><button type="button" class="btn" data-act="tpl-toggle">進階設定／存成新範本</button></div>
      <div class="stack" data-role="pnl-tpl-body" hidden>
        <div class="form-grid-2">
          <div class="field"><label class="field-label">範本名稱</label><input class="input" type="text" data-role="pnl-tpl-name" value="${esc(t.name || '')}"></div>
          <div class="field"><label class="field-label">檔案類型</label><input class="input" type="text" data-role="pnl-tpl-filetype" value="${esc(t.file_type || 'xls')}"></div>
          <div class="field"><label class="field-label">表頭列</label><input class="input" type="number" min="1" data-role="pnl-tpl-header" value="${esc(t.header_row || 1)}"></div>
          <div class="field"><label class="field-label">日期欄（留空＝不檢查月份）</label><input class="input" type="text" data-role="pnl-tpl-date" value="${esc(t.date_col || '')}"></div>
          <div class="field"><label class="field-label">金額欄</label><input class="input" type="text" data-role="pnl-tpl-amount" value="${esc(t.amount_col || '')}"></div>
          <div class="field"><label class="field-label">分組欄（留空＝全部歸同一科目）</label><input class="input" type="text" data-role="pnl-tpl-group" value="${esc(t.group_col || '')}"></div>
        </div>
        <label class="pnl-imp-check"><input type="checkbox" data-role="pnl-tpl-direct" data-act="tpl-direct"${direct ? ' checked' : ''}> 分組欄的值就是科目代號（例如 A012；不用逐列設對應）</label>
        <div data-role="pnl-tpl-mapping"${direct ? ' hidden' : ''}>
          <div class="field-label">對應規則（分組值 → 科目；結尾打 * 表示前綴比對，單一個 * 是兜底）</div>
          <div data-role="pnl-tpl-maprows">${rows}</div>
          <button type="button" class="btn" data-act="tpl-add-map">+ 新增一條對應規則</button>
        </div>
        <div><button type="button" class="btn" data-act="tpl-apply">套用這份設定（不儲存，僅本次匯入用）</button>
        <button type="button" class="btn btn-primary" data-act="tpl-save">存成新範本</button></div>
      </div></div>`;
  }

  function readFormAsTemplate(tplId) {
    const v = (r) => ($(`[data-role="${r}"]`) || { value: '' }).value;
    const newMapping = {};
    if ($('[data-role="pnl-tpl-direct"]').checked) newMapping[ACC_ID_DIRECT_KEY] = ACC_ID_DIRECT_KEY;
    else {
      el.querySelectorAll('[data-role="pnl-tpl-maprow"]').forEach((row) => {
        const key = row.querySelector('[data-role="pnl-tpl-mapkey"]').value.trim();
        const acc = row.querySelector('[data-role="pnl-tpl-mapacc"]').value;
        if (key && acc) newMapping[key] = acc;
      });
    }
    return {
      tpl_id: tplId, name: v('pnl-tpl-name').trim(), file_type: v('pnl-tpl-filetype').trim(),
      header_row: parseInt(v('pnl-tpl-header'), 10) || 1,
      date_col: v('pnl-tpl-date').trim(), amount_col: v('pnl-tpl-amount').trim(), group_col: v('pnl-tpl-group').trim(),
      mapping: newMapping
    };
  }

  function nextTplId() {
    const used = {};
    templates.forEach((t) => { used[t.tpl_id] = true; });
    for (let i = 1; i <= 99; i++) { const id = 'T' + (i < 10 ? '0' + i : i); if (!used[id]) return id; }
    return 'T99';
  }

  async function saveAsNewTemplate() {
    if (busy) return;
    const newTpl = readFormAsTemplate(nextTplId());
    if (!newTpl.name) { toast('請填範本名稱', 'warn'); return; }
    if (Object.keys(newTpl.mapping).length === 0) { toast('至少要有一條對應規則', 'warn'); return; }
    if (ImportLogic.isAccIdDirect(newTpl) && !newTpl.group_col) { toast('「分組欄的值就是科目代號」要填分組欄（放科目代號的那一欄）', 'warn'); return; }
    const rows = templates.map((t) => ({ tpl_id: t.tpl_id, name: t.name, file_type: t.file_type, header_row: t.header_row, date_col: t.date_col, amount_col: t.amount_col, group_col: t.group_col, mapping: t.mapping })).concat([newTpl]);
    busy = true; ctx.ui.loading(true);
    let r;
    const payload = { table: 'templates', rows };
    const bv = settings && settings.versions && settings.versions.templates;
    if (bv) payload.base_version = bv;
    try { r = await call(ctx, 'saveSettings', payload); } finally { busy = false; ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) {
      if (r.error === 'CONFLICT') {
        toast('範本剛被別人改過，已重新載入，請再存一次', 'warn');
        invalidateSettings();
        const r2 = await getSettings(ctx, true);
        if (!alive) return;
        if (r2.ok) { settings = r2.data; templates = settings.templates || []; accounts = settings.accounts || accounts; }
        return;
      }
      toast(errText(r), 'danger'); return;
    }
    if (r.data && typeof r.data.version === 'string') { if (!settings.versions) settings.versions = {}; settings.versions.templates = r.data.version; }
    invalidateSettings();
    templates = rows;
    currentTpl = newTpl; currentTplSaved = true;
    const selEl = $('[data-role="pnl-import-tpl"]');
    selEl.innerHTML = templates.map((t) => `<option value="${esc(t.tpl_id)}">${esc(t.tpl_id + ' ' + t.name)}</option>`).join('');
    selEl.value = newTpl.tpl_id;
    renderTplSummary(); renderTplEditor();
    if (files.length) runPreview();
    toast('已存成新範本：' + newTpl.tpl_id, 'ok');
  }

  /* ------------------------------ 解析＋預覽 ------------------------------ */
  async function readFiles(fileObjs) {
    const out = [];
    for (const f of fileObjs) {
      try { out.push({ name: f.name, buf: await f.arrayBuffer() }); } catch (e) { out.push({ name: f.name, buf: null }); }
    }
    return out;
  }

  async function runPreview() {
    const seq = ++previewSeq;
    const box = $('[data-role="pnl-import-preview"]');
    if (!box) return;
    if (files.length === 0) { box.innerHTML = ''; lastFileList = []; includedOverride = {}; view = null; return; }
    if (!currentTpl) { toast('請先選匯入範本', 'warn'); return; }
    box.innerHTML = '<div class="card" data-role="pnl-import-parsing"><p class="text-muted">解析中…</p></div>';
    const month = monthNow();
    const store = sel.store;
    const tpl = currentTpl;
    let XLSX;
    try { XLSX = await loadXlsx(); } catch (e) {
      if (seq !== previewSeq || !alive) return;
      box.innerHTML = errorHtml(esc, '讀檔元件載入失敗，請重新整理後再試');
      return;
    }
    const failed = [];
    const existingP = ImportLogic.isAccIdDirect(tpl)
      ? call(ctx, 'getMonth', { store_id: store, month }).then((r) => (r.ok && r.data && Array.isArray(r.data.entries) ? r.data.entries : null)).catch(() => null)
      : Promise.resolve([]);
    const list = files.map((f) => {
      try {
        if (!f.buf) throw new Error('read');
        return { name: f.name, rows2D: sheetToRows2D(XLSX, readWorkbookBuf(XLSX, f.buf, tpl)) };
      } catch (e) { failed.push(f.name); return { name: f.name, rows2D: [] }; }
    });
    const existing = await existingP;
    if (seq !== previewSeq || !alive) return;     // 讀檔期間又改了選檔／範本／月份／門市，這批結果已過期
    lastExisting = existing;
    lastFileList = list;
    failedFiles = failed;
    includedOverride = {};
    voidOtherOverride = {};
    renderPreview();
  }

  function computeIncluded(fileList, month) {
    const agg0 = ImportLogic.aggregateFiles(fileList, currentTpl, month);
    const duplicates = ImportLogic.detectDuplicateFiles(agg0.fileResults);
    const storeName = storeNameMap[sel.store] || sel.store;
    const flags = fileList.map((f, i) => {
      const dup = duplicates[i];
      const mismatch = ImportLogic.findStoreMismatch(f.rows2D, currentTpl, storeName);
      const reasons = (dup && dup.duplicate) ? dup.reasons.slice() : [];
      if (mismatch) reasons.push('「店別」欄讀到「' + mismatch + '」，跟目前選的門市（' + storeName + '）對不起來');
      const defaultIncluded = !(dup && dup.nameConflict) && !mismatch;
      const included = Object.prototype.hasOwnProperty.call(includedOverride, f.name) ? includedOverride[f.name] : defaultIncluded;
      return { name: f.name, flagged: reasons.length > 0, reasons, included };
    });
    const agg = ImportLogic.aggregateFiles(fileList.filter((f, i) => flags[i].included), currentTpl, month);
    return { agg, flags };
  }

  function renderPreview() {
    const box = $('[data-role="pnl-import-preview"]');
    if (!box) return;
    const month = monthNow();
    const { agg, flags } = computeIncluded(lastFileList, month);
    const parts = [];

    if (failedFiles.length) {
      parts.push(`<div class="pnl-imp-warn" data-role="pnl-import-failed"><strong>有檔案讀不出內容（已略過，不計入彙總）：</strong>${failedFiles.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`);
    }
    if (agg.filesWithErrors.length) {
      parts.push(`<div class="pnl-imp-err" data-role="pnl-import-errors"><strong>這些檔案的表頭對不起來，整份未計入彙總：</strong>${agg.filesWithErrors.map((fe) => `<div>${esc(fe.name + '：缺 ' + fe.missingColumns.join('、'))}</div>`).join('')}</div>`);
    }
    const flagged = flags.filter((f) => f.flagged);
    if (flagged.length) {
      parts.push(`<div class="pnl-imp-warn" data-role="pnl-import-flagged"><strong>這些檔案疑似有問題，勾選框是目前是否計入彙總（可自行調整）：</strong>${flagged.map((f) =>
        `<label class="pnl-imp-check"><input type="checkbox" data-act="include-file" data-file="${esc(f.name)}"${f.included ? ' checked' : ''}> ${esc(f.name + '：' + f.reasons.join('；'))}</label>`).join('')}</div>`);
    }

    const direct = ImportLogic.isAccIdDirect(currentTpl);
    const invalidCodes = direct ? ImportLogic.validateDirectCodes(agg, accounts) : [];
    const skippedRows = direct ? (agg.skippedRows || []) : [];
    const invalidSet = {};
    invalidCodes.forEach((v) => { invalidSet[v.code] = true; });
    if (invalidCodes.length || skippedRows.length) {
      const SHOW = 50;
      parts.push(`<div class="pnl-imp-err" data-role="pnl-import-invalid"><strong>${esc('無法對應（' + invalidCodes.length + ' 個代號、' + skippedRows.length + ' 列被略過；修正檔案或科目設定後再選一次檔，沒修好不能匯入）：')}</strong>`
        + invalidCodes.map((v) => `<div>${esc(v.code + (v.name ? ' ' + v.name : '') + '：' + v.reason + '　' + v.rows + ' 列　NT$ ' + ImportLogic.formatAmount(v.amount))}</div>`).join('')
        + skippedRows.slice(0, SHOW).map((sr) => `<div>${esc(sr.file + ' 第 ' + sr.row + ' 列（代號 ' + (sr.code || '空白') + '）：' + sr.reason)}</div>`).join('')
        + (skippedRows.length > SHOW ? `<div>${esc('……另有 ' + (skippedRows.length - SHOW) + ' 列未列出')}</div>` : '') + '</div>');
    }

    const entries = ImportLogic.buildEntries(agg, currentTpl).filter((en) => !invalidSet[en.acc_id]);
    const fmtAmt = direct ? ImportLogic.formatAmount : fmtInt;

    const existingUnknown = direct && lastExisting === null;
    const otherSources = (direct && !existingUnknown) ? ImportLogic.findOtherSources(lastExisting, entries, currentTpl.tpl_id) : [];
    if (existingUnknown) {
      parts.push('<div class="pnl-imp-err" data-role="pnl-import-existing-unknown">讀不到本店本月既有明細，沒辦法檢查會不會跟其他來源重複，「確認匯入」已停用；請稍後重新選檔再試。</div>');
    }
    if (otherSources.length) {
      parts.push(`<div class="pnl-imp-warn" data-role="pnl-import-other"><strong>這些科目本月已有其他來源的明細，勾選＝匯入時連帶作廢（不勾會兩筆都算）：</strong>${otherSources.map((o) => {
        const checked = Object.prototype.hasOwnProperty.call(voidOtherOverride, o.acc_id) ? voidOtherOverride[o.acc_id] : true;
        voidOtherOverride[o.acc_id] = checked;
        return `<label class="pnl-imp-check"><input type="checkbox" data-act="void-other" data-acc="${esc(o.acc_id)}"${checked ? ' checked' : ''}> ${esc('連帶作廢　' + o.acc_id + ' ' + accountName(o.acc_id) + '：已有其他來源 ' + ImportLogic.formatAmount(o.amount) + ' 元（' + o.sources.join('、') + '，' + o.count + ' 筆）')}</label>`;
      }).join('')}</div>`);
    }

    const accMode = {};
    accounts.forEach((a) => { accMode[a.acc_id] = a.mode; });
    const rowsHtml = entries.map((en) => {
      let label = en.acc_id + ' ' + accountName(en.acc_id);
      if (direct) label += '（' + (agg.rowCounts[en.acc_id] || 0) + ' 列）';
      const hint = (direct && accMode[en.acc_id] === '連接器') ? '<div class="field-hint">匯入後此科目本月不再由連接器自動帶入</div>' : '';
      return `<div class="pnl-imp-row" data-role="pnl-import-row" data-acc="${esc(en.acc_id)}"><span>${esc(label)}${hint}</span><span class="pnl-imp-amt" data-role="pnl-import-amount">NT$ ${esc(fmtAmt(en.amount))}</span></div>`;
    }).join('');
    const total = entries.reduce((s, e) => s + e.amount, 0);
    parts.push(`<div class="card" data-role="pnl-import-table">${rowsHtml}<div class="pnl-imp-row pnl-imp-total" data-role="pnl-import-total"><span>${esc(direct ? '合計（' + entries.length + ' 個科目）' : '合計')}</span><span class="pnl-imp-amt">NT$ ${esc(fmtAmt(total))}</span></div></div>`);

    let incomplete = false;
    let hasSkipped = false;
    if (direct) {
      parts.push(`<div class="text-muted" data-role="pnl-import-stats">${esc(agg.matchedRowCount + ' 列／' + entries.length + ' 個科目')}</div>`);
    } else {
      parts.push(`<div class="text-muted" data-role="pnl-import-stats">${esc('未對應 ' + agg.unmappedCount + ' 列（金額 NT$ ' + fmtInt(agg.unmappedAmount) + '）　略過（金額格式錯）' + agg.skippedBadAmount + ' 列　略過（日期不在月份）' + agg.skippedBadDate + ' 列')}</div>`);
      const range = ImportLogic.dateRangeOf(agg.dayStrs);
      const totalDays = ImportLogic.daysInMonth(month);
      const covered = range ? range.count : 0;
      incomplete = covered < totalDays;
      hasSkipped = (agg.skippedBadAmount + agg.skippedBadDate) > 0;
      const l1 = range ? `涵蓋日期：${range.from} ~ ${range.to}（${covered}/${totalDays} 天）` : `沒有任何列落在 ${month}（0/${totalDays} 天）`;
      parts.push(`<div class="${incomplete ? 'pnl-imp-warn' : 'text-muted'}" data-role="pnl-import-coverage"><div>${esc(l1)}</div>${incomplete ? '<div>一次匯入＝整月取代，缺的天數會變成 0，請確認是否選齊整月的檔案。</div>' : ''}</div>`);
    }

    if (!currentTplSaved) parts.push('<div class="pnl-imp-warn" data-role="pnl-import-unsaved">目前套用的範本設定還沒存成範本，請先按「存成新範本」才能匯入。</div>');

    const canConfirm = canConfirmImport({ agg, currentTplSaved, invalidCodes, skippedRows, existingUnknown, failedFiles });
    if (failedFiles.length || agg.filesWithErrors.length) parts.push('<div class="text-muted" data-role="pnl-import-badfiles">有讀不出內容或表頭對不起來的檔案，「確認匯入」已停用：請把這些檔案移除後重新選檔（整月取代會把它們涵蓋的資料清成 0）。</div>');
    if (invalidCodes.length || skippedRows.length) parts.push('<div class="text-muted">有無法對應的科目代號或被略過的列，「確認匯入」已停用。</div>');
    if (agg.matchedRowCount === 0) parts.push('<div class="text-muted">沒有任何列對到任何科目，「確認匯入」已停用。</div>');
    parts.push(`<div><button type="button" class="btn btn-primary" data-act="import-confirm"${canConfirm ? '' : ' disabled'}>確認匯入</button></div>`);

    view = { agg, month, incomplete, hasSkipped };
    box.innerHTML = `<div class="stack">${parts.join('')}</div>`;
  }

  async function confirmImport() {
    if (busy || !view) return;
    const { agg, month, incomplete, hasSkipped } = view;
    if (failedFiles.length || agg.filesWithErrors.length) { toast('有讀不出或表頭錯的檔案，請移除後重新選檔', 'warn'); return; }
    if (incomplete || hasSkipped) {
      const msg = '這次匯入的資料' + (incomplete ? '不足整月' : '') + (incomplete && hasSkipped ? '、' : '') + (hasSkipped ? '有略過的列' : '')
        + '。\n\n確認匯入將整月取代既有匯入（同一個範本這個月份先前匯入的資料會被作廢），缺漏的部分會變成 0。確定要繼續嗎？';
      if (!(await ctx.ui.confirm(msg))) return;
    }
    const directMode = ImportLogic.isAccIdDirect(currentTpl);
    if (directMode && (ImportLogic.validateDirectCodes(agg, accounts).length > 0 || (agg.skippedRows || []).length > 0 || lastExisting === null)) {
      toast('有無法對應的科目代號或被略過的列，不能匯入', 'warn');
      return;
    }
    const entries = ImportLogic.buildEntries(agg, currentTpl);
    const range = ImportLogic.dateRangeOf(agg.dayStrs);
    const meta = {
      files: agg.fileCount, rows: agg.matchedRowCount,
      skipped: agg.skippedBadAmount + agg.skippedBadDate, unmapped: agg.unmappedCount,
      date_from: range ? range.from : null, date_to: range ? range.to : null
    };
    const req = { store_id: sel.store, month, tpl_id: currentTpl.tpl_id, entries, meta };
    if (directMode) {
      const ids = {};
      entries.forEach((en) => { ids[en.acc_id] = true; });
      req.void_other_sources = Object.keys(voidOtherOverride).filter((a) => voidOtherOverride[a] === true && ids[a]).sort();
    }
    busy = true; ctx.ui.loading(true);
    const btn = $('[data-act="import-confirm"]');
    if (btn) btn.disabled = true;
    let r;
    try { r = await call(ctx, 'importEntries', req); } finally { busy = false; ctx.ui.loading(false); }
    if (!alive) return;
    const b = $('[data-act="import-confirm"]');
    if (b) b.disabled = false;
    if (!r.ok) { toast(errText(r), 'danger'); return; }
    const d = r.data || {};
    toast('匯入完成：新增 ' + d.added + ' 筆，作廢舊資料 ' + d.voided + ' 筆' + (d.voided_other ? '，連帶作廢其他來源 ' + d.voided_other + ' 筆' : ''), 'ok');
    if (directMode) runPreview();   // 本月既有明細已變，重算（其他來源黃卡跟著更新）
  }

  /* ------------------------------ 事件 ------------------------------ */
  function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || !el.contains(t)) return;
    const act = t.getAttribute('data-act');
    if (act === 'import-confirm') confirmImport();
    else if (act === 'tpl-toggle') { const b = $('[data-role="pnl-tpl-body"]'); if (b) b.hidden = !b.hidden; }
    else if (act === 'tpl-add-map') {
      const first = eligibleAccounts()[0];
      $('[data-role="pnl-tpl-maprows"]').insertAdjacentHTML('beforeend', mapRowHtml('', first ? first.acc_id : ''));
    } else if (act === 'tpl-del-map') t.closest('[data-role="pnl-tpl-maprow"]').remove();
    else if (act === 'tpl-apply') {
      currentTpl = readFormAsTemplate(currentTpl.tpl_id);
      currentTplSaved = false;
      renderTplSummary();
      if (files.length) runPreview();
      toast('已套用（尚未存成範本，不能直接匯入，請先存成新範本）', 'info');
    } else if (act === 'tpl-save') saveAsNewTemplate();
    else if (act === 'pnl-retry') start(true);
  }

  function onChange(e) {
    const t = e.target;
    const act = t.getAttribute && t.getAttribute('data-act');
    const role = t.getAttribute && t.getAttribute('data-role');
    if (act === 'include-file') { includedOverride[t.getAttribute('data-file')] = t.checked; renderPreview(); }
    else if (act === 'void-other') { voidOtherOverride[t.getAttribute('data-acc')] = t.checked; }
    else if (act === 'tpl-direct') { const m = $('[data-role="pnl-tpl-mapping"]'); if (m) m.hidden = t.checked; }
    else if (role === 'pnl-store') { sel.store = t.value; if (files.length) runPreview(); }
    else if (role === 'pnl-month') { sel.month = t.value; if (files.length) runPreview(); }
    else if (role === 'pnl-import-tpl') {
      const tpl = templates.find((x) => x.tpl_id === t.value);
      if (!tpl) return;
      currentTpl = tpl; currentTplSaved = true;
      renderTplSummary(); renderTplEditor();
      if (files.length) runPreview();
    } else if (role === 'pnl-import-file') {
      const picked = Array.prototype.slice.call(t.files || []);
      readFiles(picked).then((fs) => { if (!alive) return; files = fs; runPreview(); });
    }
  }

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);

  /* ------------------------------ 開機 ------------------------------ */
  async function start(force) {
    el.innerHTML = loadingHtml('讀取中…');
    const r = await getSettings(ctx, force);
    if (!alive) return;
    if (!r.ok) { el.innerHTML = errorHtml(esc, errText(r)); return; }
    settings = r.data;
    if (!canWrite(settings)) { el.innerHTML = noticeHtml(esc, '你的帳號只能看儀表板，沒有匯入權限。'); return; }
    accounts = settings.accounts || [];
    templates = settings.templates || [];
    storeNameMap = {};
    (settings.stores || []).forEach((s) => { storeNameMap[s.store_id] = s.name; });
    const options = storeOptions(settings, false).filter((s) => s.active !== false);
    if (!options.length) { el.innerHTML = noticeHtml(esc, '沒有可匯入的門市。'); return; }
    settle(options, ctx.params);
    if (templates.length) { currentTpl = templates[0]; currentTplSaved = true; }
    shell(options);
    if (!templates.length) $('[data-role="pnl-import-preview"]').innerHTML = noticeHtml(esc, '還沒有任何匯入範本，請先請管理者新增一個。', 'pnl-import-notemplate');
  }
  start(false);

  return function unmount() {
    alive = false;
    previewSeq++;
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
  };
}
