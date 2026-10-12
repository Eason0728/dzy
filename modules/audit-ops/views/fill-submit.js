/**
 * modules/audit-ops/views/fill-submit.js — 營運稽核填寫：驗證／建送出內容／草稿（T2-5）
 *
 * 正本規格：docs/spec.md §4.8（送出格式，本檔 buildRecord/buildDetails 就是在組這個形狀）。
 * 來源：~/mala-audit/js/views/ops.js 的 emptyEntry()／blankEntries()／loadEntriesFor()／
 * detailList()／counts()／submit() 內的驗證與建 record 邏輯（原檔 55-150、384-453 行
 * 一帶），逐字元行為照抄，只是抽成不碰 DOM 的純函式＋一組 localStorage 存取，方便
 * fill.js 呼叫、也方便直接單元測試（不必真的掛 DOM 就能驗「未完成必填說明」「稽核人員
 * 必填」——這兩條規則是這張表存在的理由，任務指示明講拿掉任何一條就是把這張表變成
 * 裝飾品，所以特意拆成 auditorError()／missingNoteError() 兩支獨立函式，各自對應一條
 * 規則、各自可以單獨測試、單獨當變異測試的目標）。
 *
 * 做法比照 modules/audit-stock/views/fill-submit.js（T2-3 已驗收的範本）：草稿沿用舊版
 * 直接用瀏覽器 localStorage（不透過 ctx.api，草稿本來就只是本機暫存）：
 * key 規則 `ops_draft_{record_key}`（同舊版 DRAFT_PREFIX），記住上次那家店用
 * `ops_last_store`（同舊版 LAST_STORE_KEY）——刻意沿用舊版原本的 key 名稱，不是新取一組。
 */
'use strict';

import { Format, OpsChecklist } from '../../audit-shared/umd-bridge.js';

const DRAFT_PREFIX = 'ops_draft_';
const LAST_STORE_KEY = 'ops_last_store';

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 單一細項的空白核定（同舊版 emptyEntry()）。 */
export function emptyEntry() {
  return { verdict: '未檢查', track: false, note: '' };
}

/** 19 項全部給一個空白核定（同舊版 blankEntries()）。 */
export function blankEntries() {
  const entries = {};
  OpsChecklist.flat.forEach((it) => { entries[it.id] = emptyEntry(); });
  return entries;
}

function recordKeyOf(store, month) {
  return Format.recordKey(store, month);
}

/** 依目前 entries 展開成明細清單（同舊版 detailList()），順序＝OpsChecklist.flat 的順序。 */
export function detailList(entries) {
  return OpsChecklist.flat.map((it) => {
    const e = (entries && entries[it.id]) || emptyEntry();
    return {
      item_id: it.id, cat: it.cat, group: it.group, text: it.text,
      verdict: e.verdict, track: !!e.track, note: e.note || ''
    };
  });
}

/** 統計（同舊版 counts()，包 Format.opsCounts；分母固定＝OpsChecklist.total）。 */
export function counts(entries) {
  return Format.opsCounts(detailList(entries), OpsChecklist.total);
}

/**
 * 規則①：稽核人員必填（照抄 submit() 開頭第一段檢查）。
 * @param {string} auditor
 * @returns {string|null} 沒填回錯誤訊息；有填回 null
 */
export function auditorError(auditor) {
  return String(auditor || '').trim() ? null : '請填稽核人員。';
}

/**
 * 規則②：判「未完成」的項目必填說明（照抄 submit() 第二段檢查，訊息逐字元一致：
 * 只列前 3 項、超過 3 項加「等」）。
 * @param {object[]} details detailList() 的輸出
 * @returns {{message:string,count:number}|null} 沒有缺說明回 null
 */
export function missingNoteError(details) {
  const missing = (details || []).filter((d) => d.verdict === '未完成' && !String(d.note || '').trim());
  if (!missing.length) return null;
  return {
    count: missing.length,
    message: '有 ' + missing.length + ' 項判「未完成」但沒填說明：' +
      missing.map((d) => d.text).slice(0, 3).join('、') +
      (missing.length > 3 ? ' 等' : '')
  };
}

/**
 * 組合版驗證（方便直接單元測試「一次過完整規則」）；稽核人員沒填時只回這一條、
 * 不疊加其他錯誤（同舊版：檢查稽核人員在先，短路一致，見 auditorError() 呼叫端的順序）。
 * @param {{auditor:string, details:object[]}} input
 * @returns {string[]} 錯誤訊息陣列；空陣列＝可以送出
 */
export function validate({ auditor, details }) {
  const aErr = auditorError(auditor);
  if (aErr) return [aErr];
  const mErr = missingNoteError(details);
  return mErr ? [mErr.message] : [];
}

export function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 建送出的 record（照抄舊版 submit() 組 record 那段，逐欄位對照）。 */
export function buildRecord({ store, month, auditor, details, now }) {
  const c = Format.opsCounts(details || [], OpsChecklist.total);
  const d = now || new Date();
  return {
    record_key: recordKeyOf(store, month),
    store,
    month,
    status: '已稽核',
    audit_date: todayStr(d),
    auditor: String(auditor).trim(),
    total_count: c.total,
    pass_count: c.pass,
    fail_count: c.fail,
    pending_count: c.pending,
    track_count: c.track,
    pass_rate: c.pass_rate,
    summary: Format.buildOpsSummary(details || []),
    note: '',
    submitted_at: d.toISOString()
  };
}

/** 建送出的 details（照抄舊版 payloadDetails 那段）。 */
export function buildDetails({ store, month, details }) {
  const key = recordKeyOf(store, month);
  return (details || []).map((d) => ({
    record_key: key,
    store,
    month,
    item_id: d.item_id,
    cat: d.cat,
    group: d.group,
    text: d.text,
    verdict: d.verdict,
    track: d.track,
    note: d.note
  }));
}

// ============================================================
// 草稿（localStorage；同舊版 key 規則）
// ============================================================

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

export function draftKeyOf(recordKey) {
  return DRAFT_PREFIX + recordKey;
}

export function saveDraft(store, month, auditor, entries) {
  const s = storage();
  if (!s || !store || !month) return;
  try {
    s.setItem(draftKeyOf(recordKeyOf(store, month)), JSON.stringify({ store, month, auditor, entries }));
  } catch (e) { /* 儲存空間不可用時忽略，不擋操作 */ }
}

export function loadDraft(recordKey) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(draftKeyOf(recordKey));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearDraft(recordKey) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(draftKeyOf(recordKey)); } catch (e) { /* 忽略 */ }
}

/** 列出所有未送出的營運稽核草稿 → [{record_key, store, month}]（同舊版 listDrafts()）。 */
export function listDrafts() {
  const s = storage();
  const out = [];
  if (!s) return out;
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || k.indexOf(DRAFT_PREFIX) !== 0) continue;
      const recordKey = k.slice(DRAFT_PREFIX.length);
      const d = loadDraft(recordKey);
      if (d && d.store && d.month) out.push({ record_key: recordKey, store: d.store, month: d.month });
    }
  } catch (e) { /* 存取不到就當沒有草稿 */ }
  return out;
}

export function loadLastStore() {
  const s = storage();
  if (!s) return null;
  try { return s.getItem(LAST_STORE_KEY); } catch (e) { return null; }
}

export function persistLastStore(store) {
  const s = storage();
  if (!s || !store) return;
  try { s.setItem(LAST_STORE_KEY, store); } catch (e) { /* 忽略 */ }
}

/**
 * 依「草稿優先，其次已送出紀錄，都沒有就空白」載入某店某月的內容（同舊版 loadEntriesFor()）。
 * @param {string} store
 * @param {string} month
 * @param {{ops_records:object[], ops_details:object[]}} data ctx.api getAll() 回傳的 data
 * @returns {{entries:object, auditor:string, from:'draft'|'submitted'|'new'}}
 */
export function loadEntriesFor(store, month, data) {
  const key = recordKeyOf(store, month);
  const draft = loadDraft(key);
  if (draft && draft.entries) {
    const merged = blankEntries();
    Object.keys(merged).forEach((id) => {
      if (draft.entries[id]) merged[id] = draft.entries[id];
    });
    return { entries: merged, auditor: draft.auditor || '', from: 'draft' };
  }

  const d = data || {};
  const details = (d.ops_details || []).filter((x) => x.record_key === key);
  if (details.length) {
    const e = blankEntries();
    details.forEach((x) => {
      if (!e[x.item_id]) return;
      e[x.item_id] = { verdict: x.verdict, track: !!x.track, note: x.note || '' };
    });
    const rec = (d.ops_records || []).filter((r) => r.record_key === key)[0];
    return { entries: e, auditor: (rec && rec.auditor) || '', from: 'submitted' };
  }
  return { entries: blankEntries(), auditor: '', from: 'new' };
}

/** 今天所在的年月（同舊版 currentMonth()）。 */
export function currentMonth(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}
