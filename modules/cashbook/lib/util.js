/**
 * modules/cashbook/lib/util.js — 收支管理的純函式（不碰 DOM、不碰網路，node 測試直接 import）
 * 日期一律用台北時間（UTC+8）算，不吃瀏覽器所在時區。
 */
'use strict';

/** 台北現在的年月日 */
export function taipeiParts(now) {
  const t = new Date((now instanceof Date ? now : new Date()).getTime() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;
export const ymKey = (y, m) => y + '-' + pad2(m);

/** 上一個月 → 'YYYY-MM' */
export function lastMonthOf(now) {
  const { y, m } = taipeiParts(now);
  return m === 1 ? ymKey(y - 1, 12) : ymKey(y, m - 1);
}

export function currentMonthOf(now) {
  const { y, m } = taipeiParts(now);
  return ymKey(y, m);
}

/** 預設月份：每月 1–10 日是上個月（會計月初對帳），其餘當月 */
export function defaultMonth(now) {
  return taipeiParts(now).d <= 10 ? lastMonthOf(now) : currentMonthOf(now);
}

/** 首頁提醒用：每月 1–10 日回上個月 'YYYY-MM'，其餘回 null */
export function alertMonth(now) {
  return taipeiParts(now).d <= 10 ? lastMonthOf(now) : null;
}

/** 從當月往前數 n 個月（含當月），新的在前 */
export function monthOptions(now, n) {
  const { y, m } = taipeiParts(now);
  const out = [];
  let yy = y, mm = m;
  for (let i = 0; i < n; i++) {
    out.push(ymKey(yy, mm));
    mm -= 1;
    if (mm === 0) { mm = 12; yy -= 1; }
  }
  return out;
}

/** 'YYYY-MM' → '9 月'（提醒用） */
export function monthNum(ym) {
  const m = /^\d{4}-(\d{2})$/.exec(String(ym));
  return m ? String(Number(m[1])) : String(ym);
}

/** 鎖定紀錄是否為「有效鎖定」（status 為 鎖定） */
export function isLocked(rec) {
  return !!rec && String(rec.status) === '鎖定';
}

/** 鎖定來源：acct 會計、store 店長、其他（舊資料）＝未知 */
export function lockKind(rec) {
  if (!isLocked(rec)) return 'none';
  if (rec.lockedVia === 'acct') return 'acct';
  if (rec.lockedVia === 'store') return 'store';
  return 'unknown';
}

export function lockLabel(rec) {
  const k = lockKind(rec);
  return k === 'acct' ? '會計鎖定' : k === 'store' ? '店長鎖定' : k === 'unknown' ? '已鎖定' : '未鎖';
}

/** 這個月還沒被「會計」鎖（沒有鎖、或是店長鎖的、舊資料來源不明）→ true */
export function needsAcctLock(locks, month) {
  const rec = (Array.isArray(locks) ? locks : []).find((x) => x && x.month === month && isLocked(x));
  return lockKind(rec) !== 'acct';
}

/**
 * 首頁提醒要列哪些店：stores=[{code,name}]、locksByStore={code:[lock…]}、liveByStore={code:bool 上個月有沒有未作廢的帳}
 * 沒帳的店（例如新店還沒開始記）不提醒。回 [{code,name}]
 */
export function storesToAlert(stores, locksByStore, month, liveByStore) {
  return (Array.isArray(stores) ? stores : []).filter((s) => s && needsAcctLock((locksByStore || {})[s.code], month) && (liveByStore || {})[s.code] !== false);
}

/** 錯誤碼（現金帳伺服器）與代轉層訊息 → 給人看的話 */
const ERR = {
  LOCKED: '這個月已經月結鎖定，不能這樣改',
  LOCKED_BY_ACCT: '這個月是會計鎖的',
  BAD_INPUT: '資料格式不對，請檢查後再試',
  FORBIDDEN: '沒有權限',
  AUTH_FAIL: '收支管理連線金鑰不對，請聯絡管理者',
  NOT_FOUND: '找不到這筆資料',
  MOVED_TO_DZY: '這個功能已搬到管理系統'
};
export function errText(r) {
  const e = r && r.error;
  if (!e) return '沒有成功，請再試一次';
  return ERR[e] || String(e);
}

/** 一行一個科目的文字 → 清單（去空白、去空行、去重；順序保留） */
export function parseSubjects(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (t && out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

/** 科目清單檢查：1–100 個、單一名稱 30 字內；回 null＝合格，否則中文原因 */
export function validateSubjects(list, label) {
  if (!Array.isArray(list) || list.length < 1) return label + '至少要有 1 個科目';
  if (list.length > 100) return label + '最多 100 個科目（現在 ' + list.length + ' 個）';
  const long = list.find((s) => s.length > 30);
  if (long) return label + '「' + long.slice(0, 12) + '…」超過 30 字';
  return null;
}

/** 只有 http(s) 網址才當圖片連結（收據照片網址來自現金帳伺服器，仍擋掉 javascript: 之類） */
export function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}
