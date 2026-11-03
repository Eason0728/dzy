/**
 * modules/pnl/views/settings-lib.js — 設定頁的純函式（無 DOM；test/pnl-settings.test.mjs 直接測）
 * 行為對照舊網站 ~/mala-pnl-auto/gas/settings.html（逐段）、csvInclude.html（CSV）、後端 apiWrite.js／adminMaint.js。
 */
'use strict';

export const MODES = ['手動', '匯入', '固定', '公式', '連接器'];
export const BLOCKS = ['營收', '食材', '包材', '人事', '可控', '不可控', '營業稅', '營業外收入'];
export const STORE_BRANDS = ['鼎兆元', '墨竹亭', '小辛辣'];
export const UNIT_TYPES = ['總部', '門市', '央廚'];
export const CONNECTOR_TYPES = ['cashbook', 'transfer', 'payroll'];
export const SHADOW_RE = /^管理系統[:：]/;
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const CUSTOM_KEY = '__custom__';
export const STRING_VALUE_KEYS = { _node: 1, _store: 1 };

// 三種連接器常見的來源鍵（下拉預設選項；都留「自訂…」）。照舊網站 CONNECTOR_KNOWN_KEYS_。
export const CONNECTOR_KNOWN_KEYS = {
  cashbook: ['expense.食材', 'expense.蔬果', 'expense.瓦斯', 'expense.備品耗材', 'expense.清潔用品', 'expense.修繕維護', 'expense.運費', 'expense.文具印刷', 'expense.員工餐費', 'expense.雜支', 'expense.計時薪資', 'income.回收收入', 'income.員工／同業購買', 'income.其他收入'],
  transfer: ['_node', 'in.食材', 'in.包材', 'in.雜貨', 'out.食材', 'out.包材', 'out.雜貨'],
  payroll: ['_store', 'base_ft', 'ot_ft', 'attend_ft', 'allow_ft', 'mgr', 'meal', 'other', 'pt', 'bonus_sales', 'bonus_perf', 'bonus_proj', 'co_labor', 'co_health', 'co_pension', 'co_owner', 'co_group', 'yearend', 'ins_ft_deduct', 'dorm_ft_deduct', 'ins_pt_deduct', 'dorm_pt_deduct', 'ins_self', 'support.墨竹亭光復', 'support.墨竹亭金山', 'support.墨竹亭六張犁', 'support.央廚']
};

export const VALIDATE_CODE_LABEL = {
  BAD_BLOCK: '區塊不合法', BAD_MODE: '取值方式不合法', BAD_PARAM: '參數設定有誤', DUP_ACC: 'acc_id 重複',
  FORMULA_SYNTAX: '公式語法錯', UNKNOWN_REF: '公式引用了不存在的科目', CYCLE: '公式循環引用'
};

export const clone = (x) => JSON.parse(JSON.stringify(x));

/** 下一個流水號 id：prefix + 補零（例 S03、A045、T02） */
export function nextId(prefix, existingIds, width) {
  let max = 0;
  (existingIds || []).forEach((id) => {
    if (typeof id === 'string' && id.charAt(0) === prefix) {
      const n = parseInt(id.slice(1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  let s = String(max + 1);
  while (s.length < width) s = '0' + s;
  return prefix + s;
}

/** 'YYYY-MM' 加減月 */
export function shiftMonth(month, delta) {
  const total = parseInt(month.slice(0, 4), 10) * 12 + (parseInt(month.slice(5, 7), 10) - 1) + delta;
  const y = Math.floor(total / 12);
  return y + '-' + String(total - y * 12 + 1).padStart(2, '0');
}

/** 新增／修改／刪除 三組辨識用字串 */
export function computeDiff(keyFn, before, after, labelFn) {
  const b = new Map(), a = new Map();
  (before || []).forEach((r) => b.set(keyFn(r), r));
  (after || []).forEach((r) => a.set(keyFn(r), r));
  const added = [], removed = [], changed = [];
  a.forEach((r, k) => {
    if (!b.has(k)) added.push(labelFn(r));
    else if (JSON.stringify(b.get(k)) !== JSON.stringify(r)) changed.push(labelFn(r));
  });
  b.forEach((r, k) => { if (!a.has(k)) removed.push(labelFn(r)); });
  return { added, removed, changed };
}
export const diffIsEmpty = (d) => !d.added.length && !d.removed.length && !d.changed.length;

// ---------------------------------------------------------------- 科目

/** 跟後端 sanitizeAccountParamsForMode_ 同規則：非公式清 formula、非手動清 carry_from */
export function sanitizeAccountParamsForMode(mode, params) {
  const out = Object.assign({}, params || {});
  if (mode !== '公式' && 'formula' in out) delete out.formula;
  if (mode !== '手動' && 'carry_from' in out) delete out.carry_from;
  return out;
}

const MAX_FORMULA_LENGTH = 500;
/** 公式語法（acc_id＝A+三位數、數字、+ - * / ( )）；回引用的 acc_id 陣列，語法錯丟 Error('FORMULA_SYNTAX') */
export function formulaRefs(str) {
  if (typeof str !== 'string' || str.length > MAX_FORMULA_LENGTH) throw new Error('FORMULA_SYNTAX');
  const toks = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if ('+-*/()'.indexOf(ch) !== -1) { toks.push({ t: ch }); i++; continue; }
    const acc = /^A\d{3}/.exec(str.slice(i));
    if (acc) { toks.push({ t: 'ACC', v: acc[0] }); i += 4; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(str.slice(i));
    if (num) { toks.push({ t: 'NUM' }); i += num[0].length; continue; }
    throw new Error('FORMULA_SYNTAX');
  }
  toks.push({ t: 'EOF' });
  let p = 0;
  const refs = [];
  const peek = () => toks[p].t;
  const fail = () => { throw new Error('FORMULA_SYNTAX'); };
  function primary() {
    const t = toks[p];
    if (t.t === 'NUM') { p++; return; }
    if (t.t === 'ACC') { p++; if (refs.indexOf(t.v) === -1) refs.push(t.v); return; }
    if (t.t === '(') { p++; expr(); if (peek() !== ')') fail(); p++; return; }
    fail();
  }
  function factor() { if (peek() === '-') { p++; factor(); return; } primary(); }
  function term() { factor(); while (peek() === '*' || peek() === '/') { p++; factor(); } }
  function expr() { term(); while (peek() === '+' || peek() === '-') { p++; term(); } }
  if (peek() === 'EOF') fail();
  expr();
  if (peek() !== 'EOF') fail();
  return refs;
}

/** 存檔前驗證（對應 PnlEngine.validateAccounts）：回 [] 或 [{acc_id, code, param?}] */
export function validateAccounts(accounts) {
  accounts = accounts || [];
  const byId = {};
  const count = {};
  accounts.forEach((a) => { byId[a.acc_id] = a; count[a.acc_id] = (count[a.acc_id] || 0) + 1; });
  const out = [];
  const dup = {};
  accounts.forEach((a) => {
    if (count[a.acc_id] > 1 && !dup[a.acc_id]) { dup[a.acc_id] = true; out.push({ acc_id: a.acc_id, code: 'DUP_ACC' }); }
    if (BLOCKS.indexOf(a.block) === -1) out.push({ acc_id: a.acc_id, code: 'BAD_BLOCK' });
    if (MODES.indexOf(a.mode) === -1) out.push({ acc_id: a.acc_id, code: 'BAD_MODE' });
    const isObj = a.params !== null && typeof a.params === 'object' && !Array.isArray(a.params);
    if (!isObj) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'params' });
    if (typeof a.in_pnl !== 'boolean') out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'in_pnl' });
    if (typeof a.active !== 'boolean') out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'active' });
    const params = isObj ? a.params : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(params, k);
    const hasFormula = typeof params.formula === 'string' && params.formula.length > 0;
    if (a.mode === '公式' && !hasFormula) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'formula' });
    if (a.mode !== '公式' && hasFormula) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'formula' });
    if (has('sign') && params.sign !== 1 && params.sign !== -1) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'sign' });
    if (has('fee') && (typeof params.fee !== 'number' || !(params.fee >= 0))) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'fee' });
    if (has('carry_from') && params.carry_from) {
      if (!byId[params.carry_from]) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'carry_from' });
      else {
        if (a.mode !== '手動') out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'carry_from' });
        if (params.carry_from === a.acc_id) out.push({ acc_id: a.acc_id, code: 'BAD_PARAM', param: 'carry_from' });
      }
    }
    if (a.mode === '公式' && hasFormula) {
      let refs = null;
      try { refs = formulaRefs(params.formula); } catch (e) { out.push({ acc_id: a.acc_id, code: 'FORMULA_SYNTAX' }); }
      if (refs) refs.forEach((r) => { if (!byId[r]) out.push({ acc_id: a.acc_id, code: 'UNKNOWN_REF' }); });
    }
  });
  // 循環引用（白灰黑三色 DFS）
  const color = {};
  const cycles = {};
  function dfs(id) {
    if (color[id] === 2) return;
    if (color[id] === 1) { cycles[id] = true; return; }
    const a = byId[id];
    if (!a || a.mode !== '公式' || typeof (a.params && a.params.formula) !== 'string') { color[id] = 2; return; }
    let refs;
    try { refs = formulaRefs(a.params.formula); } catch (e) { color[id] = 2; return; }
    color[id] = 1;
    refs.forEach((r) => { if (byId[r]) dfs(r); });
    color[id] = 2;
  }
  accounts.forEach((a) => { if (a.mode === '公式') dfs(a.acc_id); });
  Object.keys(cycles).forEach((id) => out.push({ acc_id: id, code: 'CYCLE' }));
  return out;
}

export function validationLabel(v) {
  return (VALIDATE_CODE_LABEL[v.code] || v.code) + (v.param ? '（' + v.param + '）' : '');
}

/** 科目存檔預覽的紅字：改區塊／計入損益／取值方式／公式／sign／fee／停用，會影響所有月份（含已定稿） */
export function accountImpactWarnings(before, rows) {
  const names = [];
  rows.forEach((r) => {
    const b = (before || []).filter((x) => x.acc_id === r.acc_id)[0];
    if (!b) return;
    const bp = b.params || {}, ap = r.params || {};
    const changed = b.block !== r.block || b.in_pnl !== r.in_pnl || b.mode !== r.mode ||
      (bp.sign !== undefined ? bp.sign : 1) !== (ap.sign !== undefined ? ap.sign : 1) ||
      (bp.fee !== undefined ? bp.fee : 0) !== (ap.fee !== undefined ? ap.fee : 0) ||
      (bp.formula || '') !== (ap.formula || '') || b.active !== r.active;
    if (changed) names.push(r.acc_id + ' ' + r.name);
  });
  return names.length ? ['⚠ ' + names.join('、') + '：修改區塊／計入損益／取值方式／公式／sign／fee／停用，會影響所有月份（含已定稿）的計算結果'] : [];
}

// ---------------------------------------------------------------- 門市

/** 回 ''＝通過；rows 會被就地整理（brand_color、brand、unit_type） */
export function validateStores(rows, original) {
  const seen = {};
  for (const r of rows) {
    if (!r.store_id || !/^S\d{2}$/.test(r.store_id)) return 'store_id 格式須為 Sxx';
    if (r.store_id === 'ALL') return 'store_id 不可為保留字 ALL';
    if (!r.name) return r.store_id + '：名稱必填';
    if (seen[r.store_id]) return 'store_id 重複：' + r.store_id;
    r.brand_color = (r.brand_color || '').trim().toUpperCase();
    if (r.brand_color && !HEX_RE.test(r.brand_color)) r.brand_color = '';
    r.brand = (r.brand || '').trim();
    const orig = (original || []).filter((x) => x.store_id === r.store_id)[0];
    const origBrand = orig ? String(orig.brand || '').trim() : '';
    // 舊表存的自訂字（沒改動）只在下拉標「（無效，請改選）」、不擋存檔；新值只能三選一或空白
    if (r.brand && STORE_BRANDS.indexOf(r.brand) === -1 && r.brand !== origBrand) return r.store_id + '：品牌須為 鼎兆元／墨竹亭／小辛辣（或留空）';
    r.unit_type = r.unit_type || '';
    if (r.unit_type && UNIT_TYPES.indexOf(r.unit_type) === -1) return r.store_id + '：類型須為 總部／門市／央廚（或留空）';
    seen[r.store_id] = true;
  }
  return '';
}

export const storeLabel = (r) => r.store_id + ' ' + r.name + '（' + (r.active ? '啟用' : '停用') + (r.brand ? '，品牌 ' + r.brand : '') + (r.unit_type ? '，' + r.unit_type : '') + '）';

export function describeGroupUnits(res) {
  res = res || {};
  return '已建立 ' + (res.added || []).length + ' 個單位（預設停用，請逐店勾「啟用」後存檔）、補品牌／類型 ' + (res.patched || []).length +
    ' 個、略過 ' + (res.skipped || []).length + ' 個' + ((res.accounts_added || []).length ? '；補科目 ' + res.accounts_added.join('、') : '') +
    (res.accounts_error ? '；科目未補（' + res.accounts_error + '，請用維護區「同步科目範本」）' : '');
}

// ---------------------------------------------------------------- 門市固定值

export function newStoreAccount(storeId, accId) {
  return { store_id: storeId, acc_id: accId, fixed_amount: null, amort_total: null, amort_months: null, from_month: null, to_month: null };
}

/** 存檔前整理：回 {kept, orphans, error}；孤兒＝門市已停用或科目已不是「固定」 */
export function splitStoreAccounts(rows, stores, accounts) {
  const valid = rows.filter((r) => r.fixed_amount !== null || r.amort_total !== null || r.amort_months !== null || r.from_month || r.to_month);
  const storeById = {}; stores.forEach((s) => { storeById[s.store_id] = s; });
  const accById = {}; accounts.forEach((a) => { accById[a.acc_id] = a; });
  const kept = [], orphans = [];
  valid.forEach((r) => {
    const s = storeById[r.store_id], a = accById[r.acc_id];
    ((s && !s.active) || (a && a.mode !== '固定') ? orphans : kept).push(r);
  });
  for (const r of kept) {
    if (typeof r.amort_months === 'number' && r.amort_months > 0 && !r.from_month) return { kept, orphans, error: r.store_id + '/' + r.acc_id + '：有攤提月數就必填起月' };
  }
  return { kept, orphans, error: '' };
}

export function storeAccountsDiff(baseline, kept, orphans, stores) {
  const key = (r) => r.store_id + '/' + r.acc_id;
  const baseKeys = {}; (baseline || []).forEach((r) => { baseKeys[key(r)] = true; });
  const diffBase = (baseline || []).filter((r) => !orphans.some((o) => key(o) === key(r)));
  const diff = computeDiff(key, diffBase, kept, (r) => key(r) + ' 固定' + (r.fixed_amount || 0) + ' 攤提' + (r.amort_total || 0) + '/' + (r.amort_months || 0) + '月');
  const storeById = {}; stores.forEach((s) => { storeById[s.store_id] = s; });
  orphans.forEach((r) => {
    if (!baseKeys[key(r)]) return;
    const s = storeById[r.store_id];
    diff.removed.push(key(r) + '（' + (s && !s.active ? '門市已停用' : '科目已不是固定取值方式') + '，將移除這筆設定）');
  });
  return diff;
}

// ---------------------------------------------------------------- 匯入範本

export const ACC_ID_DIRECT_KEY = '@ACC_ID';
export const isDirectTemplate = (r) => !!(r.mapping && Object.prototype.hasOwnProperty.call(r.mapping, ACC_ID_DIRECT_KEY));

export function validateTemplates(rows) {
  for (const r of rows) {
    if (!/^T\d{2}$/.test(r.tpl_id)) return 'tpl_id 格式須為 Txx';
    if (!r.name) return r.tpl_id + '：名稱必填';
    if (typeof r.header_row !== 'number' || !(r.header_row >= 1)) return r.tpl_id + '：表頭列須為 ≥1 整數';
    if (isDirectTemplate(r) && !(r.group_col || '').trim()) return r.tpl_id + '：「分組欄的值就是科目代號」要填分組欄';
    const keys = Object.keys(r.mapping || {});
    if (!keys.length) return r.tpl_id + '：至少要有一條對應規則（或勾「分組欄的值就是科目代號」）';
    for (const k of keys) {
      if (!k) return r.tpl_id + '：有一組對應的分組欄值是空的，請填寫或移除';
      if (!r.mapping[k]) return r.tpl_id + '：對應「' + k + '」尚未選科目';
    }
  }
  return '';
}

/** 改對應鍵（保留順序）；撞到同範本既有的鍵回 null */
export function renameMappingKey(mapping, oldKey, newKey) {
  if (newKey !== oldKey && Object.prototype.hasOwnProperty.call(mapping, newKey)) return null;
  const out = {};
  Object.keys(mapping).forEach((k) => {
    if (k === oldKey) { if (newKey) out[newKey] = mapping[k]; } else out[k] = mapping[k];
  });
  return out;
}

export function addMappingKey(mapping) {
  let k = '', n = 1;
  while (Object.prototype.hasOwnProperty.call(mapping, k)) { k = '新對應' + n; n++; }
  const out = Object.assign({}, mapping);
  out[k] = '';
  return out;
}

// ---------------------------------------------------------------- 連接器

// 舊網站只收 https；mini 上現金帳、調撥在同一台機器，也收本機 http://127.0.0.1:<埠>/<路徑>（後端 api.js 同一條規則）
export const CONNECTOR_URL_RE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?([\/?#][^\s]*)?$/i;
export const CONNECTOR_LOCAL_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/[A-Za-z0-9_\/-]*$/;
export function isValidConnectorUrl(url) {
  return typeof url === 'string' && (CONNECTOR_URL_RE.test(url) || CONNECTOR_LOCAL_URL_RE.test(url));
}

export function urlDomainOnly(url) {
  if (typeof url !== 'string' || !url) return '';
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^\/?#]+)/.exec(url);
  if (!m) return '';
  const at = m[1].lastIndexOf('@');
  return at === -1 ? m[1] : m[1].slice(at + 1);
}

/** 連接器列的對應編輯用陣列 ↔ mapping 物件 */
export function mapRowsFrom(r) {
  const known = CONNECTOR_KNOWN_KEYS[r.type] || [];
  return Object.keys(r.mapping || {}).map((k) => ({ key: k, value: r.mapping[k], custom: known.indexOf(k) === -1 }));
}
export function mappingFromRows(rows) {
  const out = {};
  (rows || []).forEach((m) => { if (m.key) out[m.key] = m.value || ''; });
  return out;
}

/** 回 {error, badIndex}；rows 會把 newUrl 前後空白去掉 */
export function validateConnectors(rows, originalNames) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name) return { error: '第 ' + (i + 1) + ' 列：名稱必填', badIndex: -1 };
    r.newUrl = (r.newUrl || '').trim();
    if (r.newUrl && !isValidConnectorUrl(r.newUrl)) {
      return { error: r.name + '：URL 必須是 https:// 開頭的完整網址，或本機 http://127.0.0.1:埠/路徑（目前填的是「' + r.newUrl + '」，可能是瀏覽器自動填入）；只想改金鑰的話，URL 欄請留白', badIndex: i };
    }
    if (!originalNames[r.name]) {
      if (!r.key) return { error: r.name + '：新連接器（含改名）必須填寫金鑰', badIndex: -1 };
      if (!r.newUrl) return { error: r.name + '：新連接器（含改名）必須填寫 URL', badIndex: i };
    }
  }
  return { error: '', badIndex: -1 };
}

/** 金鑰／URL 沒改就送 '***'（後端保留原值） */
export function connectorPayload(rows) {
  return rows.map((r) => ({
    name: r.name, type: r.type, url: r.newUrl ? r.newUrl : '***', key: r.key ? r.key : '***',
    mapping: r.mapping || {}, store_id: r.store_id || '', active: !!r.active
  }));
}
export const connectorDiffPick = (c) => ({ name: c.name, type: c.type, store_id: c.store_id || '', active: !!c.active });
export const connectorBaseline = (r) => ({ name: r.name, type: r.type, url: r.url || '', url_set: !!r.url_set, url_valid: r.url_valid !== false, key: '***', mapping: r.mapping, store_id: r.store_id, active: r.active });

// ---------------------------------------------------------------- 系統設定

export function validateSystem(name, color) {
  if (!String(name || '').trim()) return '系統名稱必填';
  if (!HEX_RE.test(String(color || '').trim())) return '主色格式須為 #RRGGBB';
  return '';
}

// ---------------------------------------------------------------- 使用者（只動「管理系統:」帳號的可看門市）

export const isShadowName = (name) => SHADOW_RE.test(String(name || ''));

/** 設定頁只列影子帳號 */
export function shadowUsers(users) { return (users || []).filter((u) => isShadowName(u.name)); }

/**
 * saveSettings(users) 是整張表取代：非影子帳號原樣帶回（不顯示、不能改），影子帳號只換 stores。
 * edited＝[{name, role, stores}]（畫面上的草稿）
 */
export function buildUsersPayload(allUsers, edited) {
  const byName = {};
  (edited || []).forEach((e) => { byName[e.name] = e; });
  return (allUsers || []).map((u) => ({
    name: u.name, role: u.role,
    stores: isShadowName(u.name) && byName[u.name] ? byName[u.name].stores.slice() : (Array.isArray(u.stores) ? u.stores.slice() : [])
  }));
}

export function validateShadowUsers(edited) {
  for (const u of edited) {
    if (u.role === '填寫者' && (!u.stores || !u.stores.length)) return u.name + '：填寫者至少要選一家可看門市';
  }
  return '';
}

export const userLabel = (r) => r.name + '（' + r.role + '，' + ((r.stores || []).join(',') || '無') + '）';

/** 可看門市旁的提示（檢視者勾個別門市＝看不到全部合計…） */
export function scopeNote(role, stores, allStoreIds) {
  if (role === '管理者') return '管理者一律看全部門市';
  const list = Array.isArray(stores) ? stores : [];
  const msgs = [];
  if (role === '檢視者' && list.length && list.indexOf('ALL') === -1) msgs.push('只看得到：' + list.join('、') + '（看不到全部合計）');
  if (list.indexOf('ALL') === -1 && allStoreIds.length && allStoreIds.every((id) => list.indexOf(id) !== -1)) msgs.push('要看全部合計請改勾「全部門市」');
  return msgs.join('；');
}

// ---------------------------------------------------------------- 月份作業（結果文字）

export function formatDraftWarning(w) {
  const acc = w.acc_id || '';
  if (w.code === 'MANUAL_EXISTS') return acc + ' 本月已有其他來源的值' + (w.existing_sources && w.existing_sources.length ? '（' + w.existing_sources.join('／') + '）' : '') + '，未自動帶入';
  if (w.code === 'STALE_SAME_SOURCE') {
    const split = w.expected_split_months && w.expected_split_months !== 1 ? '（分攤 ' + w.expected_split_months + ' 個月）' : '';
    return acc + ' 本月的「' + (w.source || '') + '」是 ' + (w.existing_amounts || []).join('、') + '，依目前設定應為 ' + w.expected_amount + split + '；沒有自動改，按「重新帶入固定值」更新';
  }
  if (w.code === 'NO_FIXED') return acc + ' 是固定科目，但這家店沒設定固定值';
  return w.code + (acc ? '(' + acc + ')' : '');
}

export function formatRefreshFixedResult(res) {
  if (!res) return '';
  const head = (res.store_id || '') + ' ' + (res.month || '') + '：更新 ' + (res.updated || 0) + '、補寫 ' + (res.added || 0) + '、作廢 ' + (res.voided || 0) + '、未變動 ' + (res.unchanged || 0) + (res.skipped ? '、略過 ' + res.skipped : '');
  const lines = (res.details || []).filter((d) => d.action !== 'unchanged').map((d) => {
    const acc = d.acc_id + '（' + d.source + '）';
    const had = (d.old_amounts || []).join('、');
    if (d.action === 'updated') return acc + ' ' + had + ' → ' + d.new_amount;
    if (d.action === 'added') return acc + ' 補寫 ' + d.new_amount;
    if (d.action === 'voided') return acc + ' 設定已不適用，作廢 ' + had;
    if (d.reason === 'OTHER_SOURCE') return acc + ' 本月已有其他來源（' + (d.other_sources || []).join('／') + '），未動';
    if (d.reason === 'PREV_NOT_FINAL') return acc + ' 上月未定稿，結轉未動';
    return acc + ' ' + d.action;
  });
  (res.warnings || []).forEach((w) => lines.push(formatDraftWarning(w)));
  return lines.length ? head + '；' + lines.join('、') : head;
}

export function formatConnectorIssues(res) {
  if (!res) return '';
  const parts = [];
  const fails = res.connectorFailures || [];
  if (fails.length) {
    parts.push('待處理（' + fails.length + '）：' + fails.map((f) => f.connector + ':' + f.code + (f.acc_id ? '(' + f.acc_id + ')' : '') + (f.message ? '（' + f.message + '）' : '')).join('、'));
  }
  const warns = res.warnings || [];
  if (warns.length) parts.push('提醒（' + warns.length + '）：' + warns.map(formatDraftWarning).join('、'));
  if (res.timedOut) parts.push('執行逾時，部分連接器未跑完，明天 06:30 每日更新會接續，或稍後再按一次');
  return parts.join('；');
}

/** 建立草稿完成後的一句話 */
export function describeDraftResult(res) {
  if (res.skipped) return res.store_id + ' ' + res.month + ' 已定稿' + (res.status ? '（狀態：' + res.status + '）' : '') + '，未重建';
  if (res.created === false) return res.store_id + ' ' + res.month + ' 月份已存在' + (res.status ? '（狀態：' + res.status + '）' : '') + '，未重複建立';
  return res.store_id + ' ' + res.month + ' 草稿已建立' + (typeof res.entriesAdded === 'number' ? '（帶入 ' + res.entriesAdded + ' 筆）' : '');
}

/** 立即拉取完成後的一句話 */
export function describeRefreshConnectors(res) {
  const ok = res.succeededConnectors || [];
  const fails = res.connectorFailures || [];
  const count = typeof res.connectorCount === 'number' ? res.connectorCount : ok.length + fails.length;
  const lines = [(res.store_id || '') + ' ' + (res.month || '') + '：共 ' + count + ' 個連接器'];
  if (ok.length) lines.push('成功：' + ok.join('、'));
  if (fails.length) lines.push(formatConnectorIssues({ connectorFailures: fails }));
  return lines.join('；');
}

/** 排隊工作進度（onTick 的 job） */
export function jobProgressText(job, what) {
  const st = job && job.status;
  const base = what ? what + '：' : '';
  if (st === 'queued') return base + '排隊中…';
  if (st === 'running') return base + '執行中…（連接器可能要幾十秒）';
  if (st === 'done') return base + '完成';
  if (st === 'fail') return base + '失敗';
  return base + '處理中…';
}

// ---------------------------------------------------------------- 維護區

export function describeSelfCheck(r) {
  r = r || {};
  const lines = [];
  const warnings = [];
  Object.keys(r.sheets || {}).forEach((n) => {
    const s = r.sheets[n];
    lines.push(n + '：' + (s.exists ? '存在，' + s.rowCount + ' 列' : '不存在'));
    if (!s.exists) warnings.push('分頁「' + n + '」不存在');
  });
  const val = (v) => (v === null || v === undefined ? '（本機版不適用）' : v);
  lines.push('執行環境：' + (r.runtime === 'mini' ? 'Mac mini（本機）' : r.runtime === 'gas' ? 'Apps Script' : (r.runtime || '未知')));
  lines.push('monthlyDraft_ 觸發器：' + val(r.monthlyDraftTriggerCount));
  lines.push('dailyRefresh_ 觸發器：' + val(r.dailyRefreshTriggerCount));
  lines.push('onSheetChange_ 觸發器：' + val(r.sheetChangeTriggerCount));
  lines.push('月份欄是純文字格式：' + (r.monthColumnIsTextFormat === null || r.monthColumnIsTextFormat === undefined ? '（本機版不適用）' : (r.monthColumnIsTextFormat ? '是' : '否')));
  const sp = r.scriptProperties || {};
  lines.push('PNL_SALT 已設定：' + (sp.PNL_SALT ? '是' : '否'));
  lines.push('PNL_TOKEN_SECRET 已設定：' + (sp.PNL_TOKEN_SECRET ? '是' : '否'));
  if (r.userMigration && r.userMigration.checked && r.userMigration.degraded) warnings.push('使用者分頁欄位結構異常（「需更換通行碼」欄補不上去）');
  if (r.runtime !== 'mini' && r.sheetChangeTriggerOk === false) warnings.push('缺少 onSheetChange_ 觸發器：手改試算表後網頁要等一段時間才生效');
  if ((r.duplicateUserNames || []).length) warnings.push('使用者名稱正規化後重複：' + r.duplicateUserNames.join('、'));
  return { lines, warnings };
}

export function describeSeedPreview(v) {
  v = v || {};
  const parts = ['新增 ' + (v.adds || 0) + ' 個科目、更新 ' + (v.updates || 0) + ' 個' + (v.full ? '（完整同步）' : '（保守同步）')];
  if (v.description) parts.push(v.description);
  if ((v.skips || []).length) parts.push('略過：' + v.skips.join('、'));
  if (v.validation) parts.push('驗證不通過：' + v.validation);
  if (v.full && v.finalizedMonths > 0) parts.push('⚠ 目前有 ' + v.finalizedMonths + ' 個已定稿月份，完整同步會影響它們的計算結果');
  return parts;
}

export function describeConnectorPreview(p) {
  p = p || {};
  const parts = [p.description || ('共 ' + (p.changes || 0) + ' 項變更')];
  if (p.skips) parts.push(Array.isArray(p.skips) ? p.skips.join('、') : String(p.skips));
  return parts;
}

// ---------------------------------------------------------------- 匯出 CSV（照 csvInclude.html）

const INJECTION_RE = /^\s*[=+\-@|]|^[\t\r]/;
export function textCell(raw) {
  let s = raw === null || raw === undefined ? '' : String(raw);
  if (INJECTION_RE.test(s)) s = "'" + s;
  return s;
}
function roundScaled(n, decimals) {
  const scale = Math.pow(10, decimals);
  const neg = n < 0;
  let c = Math.abs(n) * scale;
  c = Math.round(c * 1e4) / 1e4;
  const r = Math.round(c);
  return neg && r !== 0 ? -r : r;
}
export function numCell(n, decimals) {
  decimals = decimals === undefined ? 2 : decimals;
  if (typeof n !== 'number' || !isFinite(n)) return '';
  const r = roundScaled(n, decimals);
  const neg = r < 0;
  let a = String(Math.abs(r));
  if (decimals <= 0) return (neg ? '-' : '') + a;
  while (a.length <= decimals) a = '0' + a;
  return (neg ? '-' : '') + a.slice(0, a.length - decimals) + '.' + a.slice(a.length - decimals);
}
export function escapeCsvField(raw) {
  let s = raw === null || raw === undefined ? '' : String(raw);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export const buildCsv = (rows) => rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
export const withBom = (csv) => String.fromCharCode(0xfeff) + csv;
export const sanitizeFilenamePart = (s) => String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
export const csvFilename = (prefix, storeLabelText, month) => prefix + '_' + sanitizeFilenamePart(storeLabelText) + '_' + month + '.csv';

function toFiniteOrNaN(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
function effectiveSplitMonths(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = toFiniteOrNaN(raw);
  return isFinite(n) && Number.isInteger(n) && n >= 1 ? n : 1;
}
function isBadSplitMonths(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  const n = toFiniteOrNaN(raw);
  return !(isFinite(n) && Number.isInteger(n) && n >= 1);
}

/** 明細 CSV（exportEntries 的 entries，含作廢）；欄位與舊網站「下載明細 CSV」一致 */
export function buildEntriesCsvRows(entries, opts) {
  opts = opts || {};
  const accountName = opts.accountName || ((id) => id);
  const storeName = opts.storeName || ((id) => id);
  const storeBrand = opts.storeBrand || (() => '');
  const rows = [['門市', '月份', 'acc_id', '科目', '金額', '分攤月數', '認列金額', '來源', '備註', '建立者', '建立時間', '作廢', '狀態', '品牌']];
  (entries || []).forEach((e) => {
    const amount = toFiniteOrNaN(e.amount);
    const ok = isFinite(amount);
    const split = effectiveSplitMonths(e.split_months);
    const status = !ok ? '金額格式錯' : (isBadSplitMonths(e.split_months) ? '分攤月數格式錯（已當 1）' : '');
    rows.push([
      textCell(storeName(e.store_id)), textCell(e.month), textCell(e.acc_id), textCell(accountName(e.acc_id)),
      ok ? numCell(amount, 2) : '', numCell(split, 0), ok ? numCell(amount / split, 2) : '',
      textCell(e.source), textCell(e.note), textCell(e.created_by), textCell(e.created_at),
      textCell(e.void === true ? '是' : '否'), textCell(status), textCell(storeBrand(e.store_id))
    ]);
  });
  return rows;
}

// ---------------------------------------------------------------- 本次異動紀錄（後端沒有讀取異動紀錄分頁的動作，這頁記錄本次開啟期間在設定頁做過的變更）

export function makeLogEntry(action, summary, now) {
  const d = new Date((now === undefined ? Date.now() : now) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { at: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()), action, summary };
}
