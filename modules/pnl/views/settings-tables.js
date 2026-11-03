/**
 * modules/pnl/views/settings-tables.js — 設定頁的表格編輯區塊（門市、科目、門市科目、連接器、匯入範本、系統設定、使用者）
 * 行為對照 ~/mala-pnl-auto/gas/settings.html 的 render*Section。每個區塊 { id, label, render(S), event(S, kind, t) }：
 *   kind＝'click'（t 有 data-act）｜'input'（t 有 data-f，輸入框每打一個字、下拉／勾選變動時）｜'change'（t 有 data-fc，離開欄位才觸發）。
 * 草稿 S.draft.* 是深拷貝；按存檔 → 驗證 → 預覽差異 → 確認 → saveSettings（S.saveTable 帶 base_version，CONFLICT 時重讀）。
 */
'use strict';

import { call, errText } from '../lib/api.js';
import {
  MODES, BLOCKS, STORE_BRANDS, UNIT_TYPES, CONNECTOR_TYPES, CONNECTOR_KNOWN_KEYS, CUSTOM_KEY, STRING_VALUE_KEYS,
  clone, nextId, computeDiff, sanitizeAccountParamsForMode, validateAccounts, validationLabel, accountImpactWarnings,
  validateStores, storeLabel, describeGroupUnits, newStoreAccount, splitStoreAccounts, storeAccountsDiff,
  isDirectTemplate, ACC_ID_DIRECT_KEY, validateTemplates, renameMappingKey, addMappingKey,
  isValidConnectorUrl, urlDomainOnly, mapRowsFrom, mappingFromRows, validateConnectors, connectorPayload, connectorDiffPick, connectorBaseline,
  validateSystem, shadowUsers, buildUsersPayload, validateShadowUsers, userLabel, scopeNote
} from './settings-lib.js';

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const opt = (esc, value, text, cur) => `<option value="${esc(value)}"${String(value) === String(cur) ? ' selected' : ''}>${esc(text)}</option>`;
const saveBtn = (act, role) => `<button type="button" class="btn btn-primary" data-act="${act}" data-role="${role || 'pnl-set-save'}">存檔</button>`;
const errLine = () => '<p class="field-hint pnl-set-err" data-role="pnl-set-err" role="alert"></p>';

/** 存檔共用：預覽差異 → 確認 → saveSettings。回 true＝已存 */
async function confirmAndSave(S, title, table, rows, diff, notes, warnings, onSaved) {
  if (!(await S.confirmDiff(title, diff, notes, warnings))) return false;
  const r = await S.saveTable(table, rows);
  if (!r.ok) return false;
  onSaved(r);
  S.toast(title + '已存檔', 'ok');
  S.log('存檔：' + title, '新增 ' + diff.added.length + '、修改 ' + diff.changed.length + '、刪除 ' + diff.removed.length);
  return true;
}

// ================================================================ 門市
const stores = {
  id: 'stores', label: '門市',
  render(S) {
    const esc = S.esc, rows = S.draft.stores;
    const body = rows.map((r, i) => {
      const cur = String(r.brand || '').trim();
      const brandOpts = [['', '（未設）']].concat(STORE_BRANDS.map((b) => [b, b]));
      if (cur && STORE_BRANDS.indexOf(cur) === -1) brandOpts.push([cur, cur + '（無效，請改選）']);
      return `<tr data-role="pnl-set-row" data-id="${esc(r.store_id)}">
        <td>${esc(r.store_id)}</td>
        <td><input class="input" data-f="name" data-i="${i}" value="${esc(r.name || '')}" aria-label="${esc(r.store_id)} 名稱"></td>
        <td><input type="checkbox" data-f="active" data-i="${i}"${r.active ? ' checked' : ''} aria-label="${esc(r.store_id)} 啟用"></td>
        <td><select class="input" data-f="brand" data-i="${i}" aria-label="${esc(r.store_id)} 品牌">${brandOpts.map((o) => opt(esc, o[0], o[1], cur)).join('')}</select></td>
        <td><select class="input" data-f="unit_type" data-i="${i}" aria-label="${esc(r.store_id)} 類型">${[['', '（未設）']].concat(UNIT_TYPES.map((u) => [u, u])).map((o) => opt(esc, o[0], o[1], r.unit_type || '')).join('')}</select></td>
        <td><button type="button" class="btn btn-danger" data-act="store-del" data-i="${i}">移除</button></td></tr>`;
    }).join('');
    const group = S.data.group_units_available ? `<div class="card stack" data-role="pnl-set-group">
        <p class="field-hint">載入集團單位清單：一次補上鼎兆元總部、央廚、墨竹亭總部與六家門市、小辛辣總部，並替 S01 補品牌＝小辛辣、類型＝門市。新單位一律「預設停用」，要開始算損益的單位請在上方表格勾「啟用」後存檔。已存在的（同代號或同名稱）一律跳過，不改既有資料；按幾次都一樣。不會建立任何月份資料。</p>
        <div><button type="button" class="btn btn-secondary" data-act="group-units">載入集團單位清單</button></div></div>` : '';
    return `<div class="card stack" data-role="pnl-set-stores">
      <div class="card-title">門市</div>
      <p class="field-hint">品牌（鼎兆元／墨竹亭／小辛辣，或留空）與類型（總部／門市／央廚）給儀表板「全部門市」的品牌篩選與各店比較用；舊資料若不是這三個品牌，下拉會標「（無效，請改選）」，不改也能存檔。</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>store_id</th><th>名稱</th><th>啟用</th><th>品牌</th><th>類型</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="card-row"><button type="button" class="btn btn-secondary" data-act="store-add">新增門市</button>${saveBtn('store-save')}</div>${errLine()}</div>${group}`;
  },
  async event(S, kind, t) {
    const rows = S.draft.stores, i = Number(t.dataset.i);
    if (kind === 'input') { const f = t.dataset.f; rows[i][f] = t.type === 'checkbox' ? t.checked : t.value; return; }
    switch (t.dataset.act) {
      case 'store-del': rows.splice(i, 1); S.redraw(); break;
      case 'store-add': rows.push({ store_id: nextId('S', rows.map((r) => r.store_id), 2), name: '', active: true, brand_color: '', brand: '', unit_type: '' }); S.redraw(); break;
      case 'store-save': {
        const e = validateStores(rows, S.data.stores);
        if (e) return S.err(e);
        S.err('');
        const diff = computeDiff((r) => r.store_id, S.data.stores, rows, storeLabel);
        await confirmAndSave(S, '門市', 'stores', rows, diff, [], [], () => { S.data.stores = clone(rows); });
        break;
      }
      case 'group-units': {
        const body = S.lines(['會新增（缺才補，預設停用）：S10 鼎兆元總部、S11 央廚、S20 墨竹亭總部、S21–S26 墨竹亭六店、S30 小辛辣總部；S01 空白的品牌／類型補小辛辣／門市；科目表缺「其他營業收入（手動）」會補上（總部／央廚手填收入用）。', '尚未存檔的門市修改會被重新載入的資料取代。']);
        if (!(await S.ask('載入集團單位清單', body, '確認載入'))) return;
        S.ctx.ui.loading(true);
        let r;
        try { r = await call(S.ctx, 'loadGroupUnits', {}); } finally { S.ctx.ui.loading(false); }
        if (!r.ok) return S.toast(errText(r), 'danger');
        const msg = describeGroupUnits(r.data);
        S.toast('已載入集團單位清單（' + msg + '）', 'ok');
        S.log('載入集團單位清單', msg);
        await S.reload();
        break;
      }
      default:
    }
  }
};

// ================================================================ 科目
function paramsHtml(S, r, i) {
  const esc = S.esc, p = r.params || {};
  const o = [];
  if (r.mode === '公式') {
    o.push(`<label class="field-hint">公式（acc_id、數字、+ - * / ( )）<textarea class="input" data-f="p.formula" data-i="${i}" rows="2">${esc(p.formula || '')}</textarea></label>`);
  } else {
    o.push(`<label class="field-hint">sign（1 或 -1） <select class="input" data-f="p.sign" data-i="${i}">${[1, -1].map((v) => opt(esc, v, v, p.sign === undefined ? 1 : p.sign)).join('')}</select></label>`);
    o.push(`<label class="field-hint">fee <input class="input" type="number" step="1" data-f="p.fee" data-i="${i}" value="${p.fee === undefined || p.fee === null ? '' : esc(p.fee)}"></label>`);
    if (r.mode === '手動') {
      const others = S.draft.accounts.filter((x) => x.acc_id !== r.acc_id);
      o.push(`<label class="field-hint">carry_from（上月結轉來源，選填） <select class="input" data-f="p.carry_from" data-i="${i}">${opt(esc, '', '（無）', p.carry_from || '')}${others.map((x) => opt(esc, x.acc_id, x.acc_id + ' ' + x.name, p.carry_from || '')).join('')}</select></label>`);
    }
  }
  o.push(`<label class="field-hint"><input type="checkbox" data-f="p.optional" data-i="${i}"${p.optional ? ' checked' : ''}> optional（沒資料不進待補）</label>`);
  return `<div class="stack" style="min-width:170px">${o.join('')}</div>`;
}

const accounts = {
  id: 'accounts', label: '科目',
  render(S) {
    const esc = S.esc, rows = S.draft.accounts;
    const errs = S.accErrs || {};
    const body = rows.map((r, i) => {
      if (!r.params || typeof r.params !== 'object') r.params = {};
      return `<tr data-role="pnl-set-row" data-id="${esc(r.acc_id)}">
        <td>${esc(r.acc_id)}</td>
        <td><select class="input" data-f="block" data-i="${i}" aria-label="${esc(r.acc_id)} 區塊">${BLOCKS.map((b) => opt(esc, b, b, r.block)).join('')}</select></td>
        <td><input class="input" data-f="name" data-i="${i}" value="${esc(r.name || '')}" aria-label="${esc(r.acc_id)} 名稱"></td>
        <td><select class="input" data-f="mode" data-i="${i}" aria-label="${esc(r.acc_id)} 取值方式">${MODES.map((m) => opt(esc, m, m, r.mode)).join('')}</select></td>
        <td><input type="checkbox" data-f="in_pnl" data-i="${i}"${r.in_pnl ? ' checked' : ''} aria-label="${esc(r.acc_id)} 計入損益"></td>
        <td><input class="input" type="number" data-f="sort" data-i="${i}" value="${typeof r.sort === 'number' ? esc(r.sort) : 0}" aria-label="${esc(r.acc_id)} 排序" style="width:80px"></td>
        <td><input type="checkbox" data-f="active" data-i="${i}"${r.active ? ' checked' : ''} aria-label="${esc(r.acc_id)} 啟用"></td>
        <td>${paramsHtml(S, r, i)}</td>
        <td><button type="button" class="btn btn-danger" data-act="acc-del" data-i="${i}">移除</button></td></tr>`
        + (errs[r.acc_id] ? `<tr><td colspan="9"><div class="field-hint pnl-set-err" data-role="pnl-acc-err" data-id="${esc(r.acc_id)}">${esc(errs[r.acc_id])}</div></td></tr>` : '');
    }).join('');
    return `<div class="card stack" data-role="pnl-set-accounts">
      <div class="card-title">科目</div>
      <p class="field-hint">公式科目存檔前會驗語法與循環引用，有錯不會送出。</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>acc_id</th><th>區塊</th><th>名稱</th><th>取值方式</th><th>計入損益</th><th>排序</th><th>啟用</th><th>參數</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="card-row"><button type="button" class="btn btn-secondary" data-act="acc-add">新增科目</button>${saveBtn('acc-save')}</div>${errLine()}</div>`;
  },
  async event(S, kind, t) {
    const rows = S.draft.accounts, i = Number(t.dataset.i);
    if (kind === 'input') {
      const f = t.dataset.f, r = rows[i];
      if (f.slice(0, 2) === 'p.') {
        if (!r.params || typeof r.params !== 'object') r.params = {};
        const k = f.slice(2);
        if (k === 'formula') r.params.formula = t.value;
        else if (k === 'sign') r.params.sign = Number(t.value);
        else if (k === 'fee') { if (t.value === '') delete r.params.fee; else r.params.fee = Number(t.value); }
        else if (k === 'carry_from') { if (t.value) r.params.carry_from = t.value; else delete r.params.carry_from; }
        else if (k === 'optional') { if (t.checked) r.params.optional = true; else delete r.params.optional; }
        return;
      }
      if (f === 'mode') { r.mode = t.value; r.params = sanitizeAccountParamsForMode(r.mode, r.params); S.redraw(); return; }
      if (f === 'in_pnl' || f === 'active') r[f] = t.checked;
      else if (f === 'sort') r.sort = Number(t.value);
      else r[f] = t.value;
      return;
    }
    switch (t.dataset.act) {
      case 'acc-del': rows.splice(i, 1); S.redraw(); break;
      case 'acc-add':
        rows.push({ acc_id: nextId('A', rows.map((r) => r.acc_id), 3), block: '營收', name: '', mode: '手動', in_pnl: true, params: {}, sort: (rows.length + 1) * 10, active: true });
        S.redraw(); break;
      case 'acc-save': {
        S.accErrs = {};
        rows.forEach((r) => { r.params = sanitizeAccountParamsForMode(r.mode, r.params); });
        const noName = rows.filter((r) => !r.name)[0];
        if (noName) { S.redraw(); return S.err(noName.acc_id + '：名稱必填'); }
        const bad = validateAccounts(rows);
        if (bad.length) {
          bad.forEach((v) => { S.accErrs[v.acc_id] = (S.accErrs[v.acc_id] ? S.accErrs[v.acc_id] + '；' : '') + validationLabel(v); });
          S.redraw();
          return S.err('有 ' + bad.length + ' 項驗證錯誤，請見下方各列訊息，尚未送出存檔');
        }
        S.redraw();
        const diff = computeDiff((r) => r.acc_id, S.data.accounts, rows, (r) => r.acc_id + ' ' + r.name + '（' + r.block + '／' + r.mode + '）');
        await confirmAndSave(S, '科目', 'accounts', rows, diff, [], accountImpactWarnings(S.data.accounts, rows), () => { S.data.accounts = clone(rows); });
        break;
      }
      default:
    }
  }
};

// ================================================================ 門市固定值（門市科目）
const storeAccounts = {
  id: 'storeAccounts', label: '門市科目',
  render(S) {
    const esc = S.esc, rows = S.draft.storeAccounts;
    const fixed = S.draft.accounts.filter((a) => a.mode === '固定');
    if (!S.saStore || !S.draft.stores.some((s) => s.store_id === S.saStore)) S.saStore = S.draft.stores[0] ? S.draft.stores[0].store_id : '';
    const find = (acc) => rows.filter((r) => r.store_id === S.saStore && r.acc_id === acc)[0];
    const body = fixed.length ? fixed.map((a) => {
      const sa = find(a.acc_id) || {};
      const n = (k) => `<td><input class="input" type="number" data-f="sa" data-k="${k}" data-acc="${esc(a.acc_id)}" value="${typeof sa[k] === 'number' ? esc(sa[k]) : ''}" aria-label="${esc(a.acc_id)} ${k}"></td>`;
      const m = (k) => `<td><input class="input" type="month" data-f="sa" data-k="${k}" data-acc="${esc(a.acc_id)}" value="${esc(sa[k] || '')}" aria-label="${esc(a.acc_id)} ${k}"></td>`;
      return `<tr data-role="pnl-set-row" data-id="${esc(a.acc_id)}"><td>${esc(a.acc_id)} ${esc(a.name)}</td>${n('fixed_amount')}${n('amort_total')}${n('amort_months')}${m('from_month')}${m('to_month')}
        <td><button type="button" class="btn btn-secondary" data-act="sa-clear" data-acc="${esc(a.acc_id)}">清空這列</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="text-muted">目前沒有「固定」取值方式的科目</td></tr>';
    return `<div class="card stack" data-role="pnl-set-storeaccounts">
      <div class="card-title">門市科目（固定費、攤提）</div>
      <p class="field-hint">只列「固定」取值方式的科目；有攤提月數就必填起月（迄月留白＝起月＋攤提月數−1）。</p>
      <div class="field"><label class="field-label" for="pnl-sa-store">選門市</label><select class="input" id="pnl-sa-store" data-f="sa-store" data-role="pnl-sa-store">${S.draft.stores.map((s) => opt(esc, s.store_id, s.name + '（' + s.store_id + '）', S.saStore)).join('')}</select></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>科目</th><th>固定金額</th><th>攤提總額</th><th>攤提月數</th><th>起月</th><th>迄月</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="card-row">${saveBtn('sa-save')}</div>${errLine()}</div>`;
  },
  async event(S, kind, t) {
    const rows = S.draft.storeAccounts;
    if (kind === 'input') {
      if (t.dataset.f === 'sa-store') { S.saStore = t.value; S.redraw(); return; }
      const acc = t.dataset.acc, k = t.dataset.k;
      let sa = rows.filter((r) => r.store_id === S.saStore && r.acc_id === acc)[0];
      if (!sa) { sa = newStoreAccount(S.saStore, acc); rows.push(sa); }
      sa[k] = (k === 'from_month' || k === 'to_month') ? (t.value || null) : num(t.value);
      return;
    }
    switch (t.dataset.act) {
      case 'sa-clear': {
        const idx = rows.findIndex((r) => r.store_id === S.saStore && r.acc_id === t.dataset.acc);
        if (idx !== -1) rows.splice(idx, 1);
        S.redraw(); break;
      }
      case 'sa-save': {
        S.err('');
        const sp = splitStoreAccounts(rows, S.draft.stores, S.draft.accounts);
        if (sp.error) return S.err(sp.error);
        const diff = storeAccountsDiff(S.data.storeAccounts, sp.kept, sp.orphans, S.draft.stores);
        const ok = await confirmAndSave(S, '門市固定值', 'storeAccounts', sp.kept, diff, [], [], () => {
          S.data.storeAccounts = clone(sp.kept);
          rows.length = 0;
          sp.kept.forEach((r) => rows.push(r));
        });
        if (ok) S.redraw();
        break;
      }
      default:
    }
  }
};

// ================================================================ 連接器
function mappingEditorHtml(S, r, i) {
  const esc = S.esc;
  if (!r._mapRows) r._mapRows = mapRowsFrom(r);
  const known = CONNECTOR_KNOWN_KEYS[r.type] || [];
  const accs = (S.draft.accounts || []).filter((a) => a.active && a.mode === '連接器');
  const rows = r._mapRows.length ? r._mapRows.map((m, j) => {
    const keyCell = `<select class="input" data-f="mk-sel" data-i="${i}" data-j="${j}">${known.map((k) => `<option value="${esc(k)}"${!m.custom && m.key === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}<option value="${CUSTOM_KEY}"${m.custom ? ' selected' : ''}>自訂…（例如 expense.新科目、support.門市名）</option></select>`
      + (m.custom ? `<input class="input" type="text" data-f="mk-custom" data-i="${i}" data-j="${j}" placeholder="自訂來源鍵" value="${esc(m.key || '')}">` : '');
    let valCell;
    if (STRING_VALUE_KEYS[m.key]) {
      valCell = `<input class="input" type="text" data-f="mv-str" data-i="${i}" data-j="${j}" placeholder="${m.key === '_node' ? '調撥系統節點名稱（NODE_LIST 裡的字串）' : '薪資模組門市代碼（光復＝SSLGF）'}" value="${esc(typeof m.value === 'string' ? m.value : '')}">`;
    } else {
      const stale = m.value && !accs.some((a) => a.acc_id === m.value);
      valCell = `<select class="input" data-f="mv-acc" data-i="${i}" data-j="${j}">${opt(esc, '', '（請選科目）', m.value || '')}${accs.map((a) => opt(esc, a.acc_id, a.acc_id + ' ' + a.name, m.value || '')).join('')}${stale ? opt(esc, m.value, m.value + '（不在目前啟用的連接器科目清單，請確認）', m.value) : ''}</select>`;
    }
    return `<tr data-role="pnl-set-maprow"><td>${keyCell}</td><td>${valCell}</td><td><button type="button" class="btn btn-danger" data-act="mk-del" data-i="${i}" data-j="${j}">移除</button></td></tr>`;
  }).join('') : '<tr><td colspan="3" class="text-muted">尚未設定任何對應（連接器仍會照樣呼叫，只是回應欄位全部沒對到科目、不會寫入任何明細）</td></tr>';
  return `<div class="stack"><div class="field-label">對應（來源鍵 → 科目）</div><div class="table-wrap"><table class="table"><tbody>${rows}</tbody></table></div>
    <div><button type="button" class="btn btn-secondary" data-act="mk-add" data-i="${i}">新增對應</button></div></div>`;
}

const connectors = {
  id: 'connectors', label: '連接器',
  render(S) {
    const esc = S.esc, rows = S.draft.connectors;
    const activeStores = S.draft.stores.filter((s) => s.active);
    const body = rows.map((r, i) => {
      const urlInvalid = !!r.url_set && r.url_valid === false;
      const badNew = !!r.newUrl && !isValidConnectorUrl(r.newUrl.trim());
      const inactive = r.store_id && !activeStores.some((s) => s.store_id === r.store_id);
      return `<tr data-role="pnl-set-row" data-id="${esc(r.name)}">
        <td><input class="input" type="text" name="pnl-connector-name-${i}" autocomplete="off" data-lpignore="true" data-1p-ignore="true" spellcheck="false" data-f="name" data-i="${i}" value="${esc(r.name || '')}" aria-label="連接器名稱"></td>
        <td><select class="input" data-f="type" data-i="${i}" aria-label="連接器類型">${CONNECTOR_TYPES.map((x) => opt(esc, x, x, r.type)).join('')}</select></td>
        <td><span class="tag ${r.url_set && !urlInvalid ? 'tag-ok' : 'tag-warn'}">${urlInvalid ? 'URL 無效，請重填' : (r.url_set ? '已設定' : '未設定')}</span>
          ${r.url ? `<div class="field-hint">目前網域：${esc(r.url)}</div>` : ''}
          <input class="input${urlInvalid || badNew ? ' is-invalid' : ''}" type="text" inputmode="url" name="pnl-connector-endpoint-${i}" autocomplete="off" data-lpignore="true" data-1p-ignore="true" spellcheck="false" data-f="newUrl" data-i="${i}" placeholder="留白＝不變更；填入完整新 URL（https://… 或本機 http://127.0.0.1:埠/路徑）" value="${esc(r.newUrl || '')}" aria-label="連接器 URL"></td>
        <td><span class="tag tag-ok">已設定</span>
          <input class="input pnl-secret" type="text" name="pnl-connector-secret-${i}" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellcheck="false" data-f="key" data-i="${i}" placeholder="留白＝不變更" value="${esc(r.key || '')}" aria-label="連接器金鑰"></td>
        <td><select class="input" data-f="store_id" data-i="${i}" aria-label="連接器門市">${opt(esc, '', '（不限）', r.store_id || '')}${activeStores.map((s) => opt(esc, s.store_id, s.store_id, r.store_id || '')).join('')}${inactive ? opt(esc, r.store_id, r.store_id + '（已停用）', r.store_id) : ''}</select></td>
        <td><input type="checkbox" data-f="active" data-i="${i}"${r.active ? ' checked' : ''} aria-label="連接器啟用"></td>
        <td><button type="button" class="btn btn-danger" data-act="conn-del" data-i="${i}">移除</button></td></tr>
        <tr><td colspan="7">${mappingEditorHtml(S, r, i)}</td></tr>`;
    }).join('');
    return `<div class="card stack" data-role="pnl-set-connectors">
      <div class="card-title">連接器</div>
      <p class="field-hint">金鑰／URL 只寫不讀：欄位留白＝保留原值不變，畫面上用「已設定／未設定」顯示目前狀態。改名等同新增連接器，必須重新填金鑰與 URL。URL 可以是 https 網址，或 Mac mini 本機的 http://127.0.0.1:埠/路徑。</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>名稱</th><th>類型</th><th>URL</th><th>金鑰</th><th>store_id</th><th>啟用</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="card-row"><button type="button" class="btn btn-secondary" data-act="conn-add">新增連接器</button>${saveBtn('conn-save')}</div>${errLine()}</div>`;
  },
  async event(S, kind, t) {
    const rows = S.draft.connectors, i = Number(t.dataset.i), j = Number(t.dataset.j);
    if (kind === 'input') {
      const f = t.dataset.f, r = rows[i];
      if (f === 'name' || f === 'key') r[f] = t.value;
      else if (f === 'newUrl') { r.newUrl = t.value; t.classList.toggle('is-invalid', !!t.value.trim() && !isValidConnectorUrl(t.value.trim())); }
      else if (f === 'type') { r.type = t.value; (r._mapRows || []).forEach((m) => { m.custom = (CONNECTOR_KNOWN_KEYS[r.type] || []).indexOf(m.key) === -1; }); S.redraw(); }
      else if (f === 'store_id') r.store_id = t.value;
      else if (f === 'active') r.active = t.checked;
      else if (f === 'mk-sel') {
        const m = r._mapRows[j];
        if (t.value === CUSTOM_KEY) { m.custom = true; if ((CONNECTOR_KNOWN_KEYS[r.type] || []).indexOf(m.key) !== -1) m.key = ''; } else { m.custom = false; m.key = t.value; }
        r.mapping = mappingFromRows(r._mapRows); S.redraw();
      } else if (f === 'mk-custom') { r._mapRows[j].key = t.value; r.mapping = mappingFromRows(r._mapRows); }
      else if (f === 'mv-acc' || f === 'mv-str') { r._mapRows[j].value = t.value; r.mapping = mappingFromRows(r._mapRows); }
      return;
    }
    switch (t.dataset.act) {
      case 'conn-del': rows.splice(i, 1); S.redraw(); break;
      case 'conn-add':
        rows.push({ name: '', type: CONNECTOR_TYPES[0], url: '', url_set: false, newUrl: '', key: '', mapping: {}, store_id: '', active: true, _mapRows: [] });
        S.redraw(); break;
      case 'mk-add': rows[i]._mapRows.push({ key: '', value: '', custom: false }); S.redraw(); break;
      case 'mk-del': rows[i]._mapRows.splice(j, 1); rows[i].mapping = mappingFromRows(rows[i]._mapRows); S.redraw(); break;
      case 'conn-save': {
        const orig = {}; (S.data.connectors || []).forEach((c) => { orig[c.name] = true; });
        rows.forEach((r) => { r.mapping = mappingFromRows(r._mapRows || mapRowsFrom(r)); });
        const v = validateConnectors(rows, orig);
        if (v.error) {
          if (v.badIndex >= 0) { const inp = S.panelEl.querySelector('input[name="pnl-connector-endpoint-' + v.badIndex + '"]'); if (inp) { inp.classList.add('is-invalid'); inp.focus(); } }
          return S.err(v.error);
        }
        S.err('');
        const payload = connectorPayload(rows);
        const keyN = rows.filter((r) => r.key).length, urlN = rows.filter((r) => r.newUrl).length;
        const notes = [];
        if (keyN) notes.push(keyN + ' 個連接器的金鑰將更新');
        if (urlN) notes.push(urlN + ' 個連接器的 URL 將更新');
        const diff = computeDiff((r) => r.name, (S.data.connectors || []).map(connectorDiffPick), rows.map(connectorDiffPick), (r) => r.name + '（' + r.type + '／' + (r.active ? '啟用' : '停用') + '）');
        const ok = await confirmAndSave(S, '連接器', 'connectors', payload, diff, notes, [], () => {
          rows.forEach((r) => {
            if (r.newUrl) { r.url = urlDomainOnly(r.newUrl); r.url_valid = true; }
            r.key = ''; r.newUrl = ''; r.url_set = true;
          });
          S.data.connectors = rows.map(connectorBaseline);
        });
        if (ok) S.redraw();
        break;
      }
      default:
    }
  }
};

// ================================================================ 匯入範本
const templates = {
  id: 'templates', label: '匯入範本',
  render(S) {
    const esc = S.esc, rows = S.draft.templates;
    const cards = rows.map((r, i) => {
      if (!r.mapping || typeof r.mapping !== 'object') r.mapping = {};
      const direct = isDirectTemplate(r);
      const f = (label, key, type) => `<div class="field"><label class="field-label">${label}</label><input class="input" type="${type || 'text'}" data-f="${key}" data-i="${i}" value="${esc(r[key] === undefined || r[key] === null ? '' : r[key])}"></div>`;
      const mapRows = direct
        ? '<p class="field-hint">分組欄每列的值（去前後空白、轉大寫）直接當科目代號；不存在／未啟用／不能匯入的代號，匯入預覽會列出並擋下。</p>'
        : Object.keys(r.mapping).map((k, j) => `<div class="card-row" data-role="pnl-set-maprow">
            <input class="input" type="text" data-fc="map-key" data-i="${i}" data-j="${j}" placeholder="分組欄值（結尾 * 代表前綴；* 代表其餘全部）" value="${esc(k)}">
            <select class="input" data-f="map-val" data-i="${i}" data-j="${j}">${opt(esc, '', '（選科目）', r.mapping[k])}${S.draft.accounts.map((a) => opt(esc, a.acc_id, a.acc_id + ' ' + a.name, r.mapping[k])).join('')}</select>
            <button type="button" class="btn btn-secondary" data-act="map-del" data-i="${i}" data-j="${j}">移除</button></div>`).join('')
          + `<div><button type="button" class="btn btn-secondary" data-act="map-add" data-i="${i}">新增一組對應</button></div>`;
      return `<div class="card stack" data-role="pnl-set-row" data-id="${esc(r.tpl_id)}">
        <div class="card-row"><strong>${esc(r.tpl_id)}</strong><button type="button" class="btn btn-danger" data-act="tpl-del" data-i="${i}">移除範本</button></div>
        <div class="form-grid-2">${f('名稱', 'name')}${f('檔案類型（例 xls／xlsx）', 'file_type')}${f('表頭列', 'header_row', 'number')}${f('日期欄', 'date_col')}${f('金額欄', 'amount_col')}${f('分組欄（留白＝全部歸 *）', 'group_col')}</div>
        <label class="field-hint"><input type="checkbox" data-f="direct" data-i="${i}"${direct ? ' checked' : ''}> 分組欄的值就是科目代號（例如 A012；不用逐列設對應）</label>
        <div class="field-label">對應（分組欄值 → 科目）</div>${mapRows}</div>`;
    }).join('');
    return `<div class="stack" data-role="pnl-set-templates"><div class="card stack"><div class="card-title">匯入範本</div><p class="field-hint">對應（mapping）用表單編輯，不用手打 JSON。</p></div>${cards}
      <div class="card stack"><div class="card-row"><button type="button" class="btn btn-secondary" data-act="tpl-add">新增範本</button>${saveBtn('tpl-save')}</div>${errLine()}</div></div>`;
  },
  async event(S, kind, t) {
    const rows = S.draft.templates, i = Number(t.dataset.i), j = Number(t.dataset.j);
    if (kind === 'change') {
      if (t.dataset.fc === 'map-key') {
        const r = rows[i], oldKey = Object.keys(r.mapping)[j];
        const res = renameMappingKey(r.mapping, oldKey, t.value);
        if (!res) { S.toast('「' + t.value + '」已經是這個範本裡的另一組對應，請先改掉或移除那一組', 'warn'); t.value = oldKey; return; }
        r.mapping = res; S.redraw();
      }
      return;
    }
    if (kind === 'input') {
      const f = t.dataset.f, r = rows[i];
      if (f === 'header_row') r.header_row = Number(t.value);
      else if (f === 'direct') { r.mapping = t.checked ? { [ACC_ID_DIRECT_KEY]: ACC_ID_DIRECT_KEY } : {}; S.redraw(); }
      else if (f === 'map-val') r.mapping[Object.keys(r.mapping)[j]] = t.value;
      else r[f] = t.value;
      return;
    }
    switch (t.dataset.act) {
      case 'tpl-del': rows.splice(i, 1); S.redraw(); break;
      case 'tpl-add': rows.push({ tpl_id: nextId('T', rows.map((r) => r.tpl_id), 2), name: '', file_type: 'xlsx', header_row: 1, date_col: '', amount_col: '', group_col: '', mapping: {} }); S.redraw(); break;
      case 'map-add': rows[i].mapping = addMappingKey(rows[i].mapping); S.redraw(); break;
      case 'map-del': { const k = Object.keys(rows[i].mapping)[j]; delete rows[i].mapping[k]; S.redraw(); break; }
      case 'tpl-save': {
        const e = validateTemplates(rows);
        if (e) return S.err(e);
        S.err('');
        const diff = computeDiff((r) => r.tpl_id, S.data.templates, rows, (r) => r.tpl_id + ' ' + r.name);
        await confirmAndSave(S, '匯入範本', 'templates', rows, diff, [], [], () => { S.data.templates = clone(rows); });
        break;
      }
      default:
    }
  }
};

// ================================================================ 系統設定
const system = {
  id: 'system', label: '系統設定',
  render(S) {
    const esc = S.esc, sys = S.draft.system;
    return `<div class="card stack" data-role="pnl-set-system"><div class="card-title">系統設定</div>
      <div class="field"><label class="field-label" for="pnl-sys-name">系統名稱</label><input class="input" id="pnl-sys-name" data-f="sys" data-k="系統名稱" value="${esc(sys['系統名稱'] || '')}"></div>
      <div class="field"><label class="field-label" for="pnl-sys-color">主色（#RRGGBB）</label><input class="input" id="pnl-sys-color" data-f="sys" data-k="主色" placeholder="#RRGGBB" value="${esc(sys['主色'] || '')}"></div>
      <div class="card-row">${saveBtn('sys-save')}</div>${errLine()}</div>`;
  },
  async event(S, kind, t) {
    if (kind === 'input') { S.draft.system[t.dataset.k] = t.value; return; }
    if (t.dataset.act !== 'sys-save') return;
    const sys = S.draft.system;
    const name = String(sys['系統名稱'] || '').trim(), color = String(sys['主色'] || '').trim();
    const e = validateSystem(name, color);
    if (e) return S.err(e);
    S.err('');
    const next = Object.assign({}, S.data.system, sys, { 系統名稱: name, 主色: color });
    const keyRows = (o) => Object.keys(o).map((k) => ({ key: k, value: o[k] }));
    const diff = computeDiff((r) => r.key, keyRows(S.data.system), keyRows(next), (r) => r.key + '：' + r.value);
    await confirmAndSave(S, '系統設定', 'system', keyRows(next), diff, [], [], () => { S.data.system = clone(next); S.draft.system = clone(next); });
  }
};

// ================================================================ 使用者（只列「管理系統:」帳號、只能改可看門市）
const users = {
  id: 'users', label: '使用者',
  render(S) {
    const esc = S.esc, rows = S.draft.users;
    const ids = S.draft.stores.map((s) => s.store_id);
    const body = rows.length ? rows.map((r, i) => {
      const isAdminRole = r.role === '管理者';
      const hasAll = (r.stores || []).indexOf('ALL') !== -1;
      const note = scopeNote(r.role, r.stores, ids);
      const boxes = isAdminRole ? '' : `<label><input type="checkbox" data-f="uall" data-i="${i}"${hasAll ? ' checked' : ''}> 全部門市</label> `
        + ids.map((id) => `<label style="margin-right:8px"><input type="checkbox" data-f="ustore" data-i="${i}" data-v="${esc(id)}"${(r.stores || []).indexOf(id) !== -1 ? ' checked' : ''}${hasAll ? ' disabled' : ''}> ${esc(id)}</label>`).join('');
      return `<tr data-role="pnl-set-row" data-id="${esc(r.name)}"><td>${esc(r.name)}<div class="field-hint">管理系統的同仁帳號：角色與能不能進由管理系統的權限設定決定，這裡只能改可看門市</div></td>
        <td>${esc(r.role)}</td><td>${boxes}${note ? `<div class="field-hint" data-role="pnl-user-note">${esc(note)}</div>` : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="3" class="text-muted" data-role="pnl-set-empty">目前沒有「管理系統:」開頭的帳號（同仁第一次進損益試算時系統會自動建立）</td></tr>';
    return `<div class="card stack" data-role="pnl-set-users"><div class="card-title">使用者</div>
      <p class="field-hint">這裡只列管理系統的同仁帳號，只能改「可看門市」；新增、移除、改角色請到管理系統的權限設定。可看門市：管理者一律全部。檢視者勾「全部門市」或全部不勾＝看全部門市與「全部合計」；勾選個別門市＝只看這幾家、看不到全部合計（就算勾滿每一家也一樣，要看合計請勾「全部門市」）。填寫者至少勾一家；勾「全部門市」也看得到全部合計，勾個別門市則看不到。</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>名稱</th><th>角色</th><th>可看門市</th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="card-row">${rows.length ? saveBtn('user-save') : ''}</div>${errLine()}</div>`;
  },
  async event(S, kind, t) {
    const rows = S.draft.users, i = Number(t.dataset.i);
    if (kind === 'input') {
      const r = rows[i], f = t.dataset.f;
      if (f === 'uall') r.stores = t.checked ? ['ALL'] : [];
      else if (f === 'ustore') {
        const set = (r.stores || []).filter((x) => x !== 'ALL');
        const v = t.dataset.v, at = set.indexOf(v);
        if (t.checked && at === -1) set.push(v);
        if (!t.checked && at !== -1) set.splice(at, 1);
        r.stores = set;
      }
      S.redraw();
      return;
    }
    if (t.dataset.act !== 'user-save') return;
    const e = validateShadowUsers(rows);
    if (e) return S.err(e);
    S.err('');
    const pick = (u) => ({ name: u.name, role: u.role, stores: u.stores || [] });
    const diff = computeDiff((r) => r.name, shadowUsers(S.data.users).map(pick), rows.map(pick), userLabel);
    const payload = buildUsersPayload(S.data.users, rows);
    await confirmAndSave(S, '使用者', 'users', payload, diff, [], [], () => {
      S.data.users = S.data.users.map((u) => Object.assign({}, u, { stores: payload.filter((p) => p.name === u.name)[0].stores }));
    });
  }
};

export const TABLE_SECTIONS = [stores, accounts, storeAccounts, connectors, templates, system, users];
