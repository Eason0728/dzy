/**
 * modules/audit-stock/views/fill-submit.js — 稽核填寫：驗證／建立送出內容／草稿（T2-3 第三段）
 *
 * 正本規格：docs/spec.md §4.8（送出格式，本檔 buildRecord/buildDetails 就是在組這個形狀）。
 * 來源：~/mala-audit/js/views/audit.js 的 validate()／buildRecord()／buildDetails()／
 * 草稿相關函式（原檔第 44-97、252-300、647-777 行一帶），逐字元行為照抄，只是抽成
 * 不碰 DOM 的純函式＋一組 localStorage 存取，方便 fill.js 呼叫、也方便直接單元測試
 * （不必真的掛 DOM 就能驗「缺單位擋下」「只填異常項分母固定」這類規則）。
 *
 * 抽查標準項數 SAMPLE_SIZE：舊版來自 ~/mala-audit/js/config.js 的 Config.SAMPLE_SIZE
 * ——那本身就是前端寫死的常數（不是後端 config 的一部分，該檔案註解寫得很清楚）。
 * 新系統沒有對應的 ctx.config 通道，這裡原樣沿用同一個寫死常數，不是遺漏，是照抄
 * 舊版原本就沒有經過後端的東西。
 *
 * 草稿沿用舊版做法直接用瀏覽器 localStorage（不透過 ctx.api，草稿本來就只是本機
 * 暫存，不是要送後端的資料）：key 規則 `draft_{store}_{month}`，只填異常項模式多
 * 後綴 `_anomaly`，兩種模式的草稿分開存互不覆蓋（同舊版 draftKeyFor()）。
 */
'use strict';

import { Format } from '../../audit-shared/umd-bridge.js';

export const SAMPLE_SIZE = 20;
export const MODE_FULL = 'full';
export const MODE_ANOMALY = 'anomaly';

const MODE_KEY = 'audit_fill_mode';
const LAST_STORE_KEY = 'audit_last_store';

export function isAnomalyMode(mode) {
  return mode === MODE_ANOMALY;
}

/**
 * 品項填值正規化：確保每項都有填寫用的欄位（預設空）。
 * 只填異常項模式下，清單裡的每一項本來就是異常項，判定直接固定成「異常」——
 * 畫面不再顯示正確／異常按鈕，也就沒有「忘了核定」這種狀態（同舊版 normalizeItem()）。
 */
export function normalizeItem(it, mode) {
  return {
    name: it.name,
    unit: it.unit || '', // 品項庫可能沒填單位，統一成空字串好判斷
    lastDrawn: it.lastDrawn || null,
    book_qty: it.book_qty !== undefined && it.book_qty !== null ? it.book_qty : '',
    recount_qty: it.recount_qty !== undefined && it.recount_qty !== null ? it.recount_qty : '',
    verdict: isAnomalyMode(mode) ? '異常' : (it.verdict || ''),
    reason: it.reason || '',
    note: it.note || ''
  };
}

export function isBlankNumber(v) {
  return v === '' || v === null || v === undefined || isNaN(Number(v));
}

/** 只填異常項模式：異常數超過標準項數就沒有意義（正確項會變負數），擋下並提示。 */
export function tooManyAnomalies(mode, itemCount, sampleSize) {
  return isAnomalyMode(mode) && itemCount > (sampleSize || SAMPLE_SIZE);
}

/**
 * 驗證（spec §7 枚舉逐字元，照抄 ~/mala-audit/js/views/audit.js 的 validate()）。
 * @param {{mode:string, items:object[], vault:object, sampleSize?:number}} input
 * @returns {string[]} 錯誤訊息陣列；空陣列＝可以送出
 */
export function validate({ mode, items, vault, sampleSize }) {
  const size = sampleSize || SAMPLE_SIZE;
  const errors = [];
  const anomalyMode = isAnomalyMode(mode);
  const list = items || [];
  const v = vault || {};

  // 只填異常項模式：0 項異常是合法的（＝全部正確，正確率 100%），不能擋。
  if (!anomalyMode && list.length === 0) {
    errors.push('尚未抽樣，清單是空的');
  }
  if (tooManyAnomalies(mode, list.length, size)) {
    errors.push('異常 ' + list.length + ' 項，已超過標準 ' + size + ' 項，請刪除多餘項目');
  }

  list.forEach((it, idx) => {
    const label = (idx + 1) + '.' + it.name;
    // 單位不分來源都要有：品項庫本身就有留空單位的項目，抽到那些項目異常說明會
    // 少一塊（2026-08-07 實查到真實案例）。缺單位的當場補，不用回試算表改。
    if (!it.unit || !String(it.unit).trim()) errors.push(label + '：缺單位，請在該列補上');
    if (isBlankNumber(it.book_qty)) errors.push(label + '：門市盤點數未填');
    if (isBlankNumber(it.recount_qty)) errors.push(label + '：會計複盤數未填');
    if (anomalyMode) {
      if (!it.reason) {
        errors.push(label + '：異常需選擇原因');
      } else if (it.reason === '其他' && !(it.note && it.note.trim())) {
        errors.push(label + '：原因為「其他」需填寫備註');
      }
      return;
    }
    if (it.verdict !== '正確' && it.verdict !== '異常') {
      errors.push(label + '：尚未核定正確／異常');
    } else if (it.verdict === '異常') {
      if (!it.reason) {
        errors.push(label + '：異常需選擇原因');
      } else if (it.reason === '其他' && !(it.note && it.note.trim())) {
        errors.push(label + '：原因為「其他」需填寫備註');
      }
    }
  });

  if (v.change_fund !== '正確' && v.change_fund !== '不正確') {
    errors.push('零找金尚未核定');
  }
  if (v.petty_cash !== '正確' && v.petty_cash !== '不正確') {
    errors.push('零用金尚未核定');
  }
  if (isBlankNumber(v.tip_amount)) {
    errors.push('小費金額未填');
  }
  if (v.tip_match !== '相符' && v.tip_match !== '不相符') {
    errors.push('小費是否相符尚未核定');
  }
  return errors;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

export function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function nowIso(d) {
  d = d || new Date();
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzOffsetMin);
  const oh = pad2(Math.floor(abs / 60));
  const om = pad2(abs % 60);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + oh + ':' + om;
}

/**
 * 建送出的 record（spec §4.8 送出格式；照抄 buildRecord()）。
 * 完整模式：分母＝實際清單項數，正確數＝核定為正確的項數。
 * 只填異常項模式：分母固定 sampleSize，正確數＝sampleSize − 異常項數
 * ——沒被輸入的品項不必逐項核定，直接視同正確（Format.anomalyOnlyCounts 負責這條算式）。
 */
export function buildRecord({ store, month, mode, items, vault, sampleSize, now }) {
  const size = sampleSize || SAMPLE_SIZE;
  const list = items || [];
  const v = vault || {};
  const counts = isAnomalyMode(mode)
    ? Format.anomalyOnlyCounts(list.length, size)
    : (() => {
        const total = list.length;
        const correctCount = list.filter((it) => it.verdict === '正確').length;
        return {
          sample_count: total,
          correct_count: correctCount,
          correct_rate: Format.correctRate(correctCount, total)
        };
      })();
  const anomalyForText = list
    .filter((it) => isAnomalyMode(mode) || it.verdict === '異常')
    .map((it) => ({ item: it.name, unit: it.unit, book_qty: it.book_qty, recount_qty: it.recount_qty, verdict: '異常' }));

  return {
    record_key: Format.recordKey(store, month),
    store,
    month,
    status: '已稽核',
    audit_date: todayStr(now),
    sample_count: counts.sample_count,
    correct_count: counts.correct_count,
    correct_rate: counts.correct_rate,
    change_fund: v.change_fund,
    petty_cash: v.petty_cash,
    tip_amount: Number(v.tip_amount),
    tip_match: v.tip_match,
    anomaly_text: Format.buildAnomalyText(anomalyForText),
    note: v.note || '',
    submitted_at: nowIso(now)
  };
}

/** 建送出的 details（照抄 buildDetails()）。只填異常項模式下清單裡本來就只有異常項。 */
export function buildDetails({ store, month, items, mode }) {
  const key = Format.recordKey(store, month);
  return (items || []).map((it) => {
    const isAnomaly = isAnomalyMode(mode) || it.verdict === '異常';
    return {
      record_key: key,
      store,
      month,
      item: it.name,
      unit: it.unit,
      book_qty: Number(it.book_qty),
      recount_qty: Number(it.recount_qty),
      verdict: isAnomaly ? '異常' : it.verdict,
      reason: isAnomaly ? (it.reason || '') : '',
      note: isAnomaly ? (it.note || '') : ''
    };
  });
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

export function draftKeyFor(store, month, mode) {
  return 'draft_' + Format.recordKey(store, month) + (isAnomalyMode(mode) ? '_anomaly' : '');
}

export function saveDraft(store, month, mode, items, vault) {
  const s = storage();
  if (!s || !store || !month) return;
  try {
    const payload = {
      store,
      month,
      items: (items || []).map((it) => ({
        name: it.name, unit: it.unit, lastDrawn: it.lastDrawn,
        book_qty: it.book_qty, recount_qty: it.recount_qty,
        verdict: it.verdict, reason: it.reason, note: it.note
      })),
      vault
    };
    s.setItem(draftKeyFor(store, month, mode), JSON.stringify(payload));
  } catch (e) { /* 儲存空間不可用時忽略，不擋操作 */ }
}

export function loadDraft(store, month, mode) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(draftKeyFor(store, month, mode));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** 送出成功時兩種模式的草稿一起清，避免另一把舊 key 之後又冒出來（同舊版 clearDraft()）。 */
export function clearDraft(store, month) {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(draftKeyFor(store, month, MODE_FULL));
    s.removeItem(draftKeyFor(store, month, MODE_ANOMALY));
  } catch (e) { /* 忽略 */ }
}

function draftHasContent(payload) {
  if (!payload) return false;
  if ((payload.items || []).length) return true;
  const v = payload.vault || {};
  return !!(v.change_fund || v.petty_cash || v.tip_amount || v.tip_match || v.note);
}

/** 列出所有還沒送出的草稿（同舊版 listDrafts()，跨店月掃描 localStorage）。 */
export function listDrafts() {
  const s = storage();
  const out = [];
  if (!s) return out;
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || k.indexOf('draft_') !== 0) continue;
      let payload = null;
      try { payload = JSON.parse(s.getItem(k)); } catch (e) { payload = null; }
      if (!payload || !payload.store || !payload.month) continue;
      if (!draftHasContent(payload)) continue;
      out.push({
        key: k,
        store: payload.store,
        month: payload.month,
        mode: /_anomaly$/.test(k) ? MODE_ANOMALY : MODE_FULL,
        count: (payload.items || []).length
      });
    }
  } catch (e) { /* 儲存空間不可用時當作沒有草稿 */ }
  out.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? 1 : -1; // 新的月份排前面
    return a.store < b.store ? -1 : 1;
  });
  return out;
}

/** 找某家店最近一份「有內容的未送出草稿」→ {month, mode}；沒有回 null（同舊版 latestDraftForStore()）。 */
export function latestDraftForStore(store) {
  if (!store) return null;
  let best = null;
  listDrafts().filter((d) => d.store === store).forEach((d) => {
    if (!best || d.month > best.month) best = { month: d.month, mode: d.mode };
  });
  return best;
}

export function dropDraft(key) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(key); } catch (e) { /* 忽略 */ }
}

export function readDraftByKey(key) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function loadMode() {
  const s = storage();
  if (!s) return MODE_FULL;
  try {
    const m = s.getItem(MODE_KEY);
    return m === MODE_ANOMALY ? MODE_ANOMALY : MODE_FULL;
  } catch (e) {
    return MODE_FULL;
  }
}

export function persistMode(mode) {
  const s = storage();
  if (!s) return;
  try { s.setItem(MODE_KEY, mode); } catch (e) { /* 忽略 */ }
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
