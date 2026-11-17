/**
 * modules/remit/lib.js — 匯款清單的純函式（不碰 DOM、不碰網路；test/remit-front.test.mjs 直接 import）
 */
'use strict';

export function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** 台北今天 YYYY-MM-DD（不靠瀏覽器時區） */
export function taipeiToday(ms) {
  return new Date((ms === undefined ? Date.now() : ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 從 YYYY-MM 往前 n 個月（含本月），新的在前 */
export function monthsBack(month, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return [];
  let idx = Number(m[1]) * 12 + Number(m[2]) - 1;
  const out = [];
  for (let i = 0; i < n; i++, idx--) out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  return out;
}
export function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : String(month || '');
}

/** 銀行帳戶一行字；個人代墊＝同仁代墊；單位請款沒設定＝null */
export function bankText(row) {
  if (!row) return null;
  if (row.self_pay) return '同仁代墊';
  const b = row.bank;
  if (!b) return null;
  return [b.bank_code, b.bank_name, b.branch].filter(Boolean).join(' ') + `｜戶名 ${b.acct_name}｜${b.acct_no}`;
}

/** 看得到的列：mineOnly＝只留我負責的單位（我是該單位會計）；沒設定會計的單位也列（誰都能出帳） */
export function visibleRows(rows, mineOnly) {
  const list = Array.isArray(rows) ? rows : [];
  if (!mineOnly) return list;
  return list.filter((r) => r.mine || !(r.accountants && r.accountants.length));
}

export function totalOf(rows) {
  return (rows || []).reduce((t, r) => t + (Number(r.amount) || 0), 0);
}

/** 標記已匯款前的檢查：回錯誤文字或 '' */
export function checkPaidDate(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '請選匯款日';
  if (date > today) return '匯款日不能是未來的日子';
  return '';
}

/** 廠商帳戶表單檢查（與後端 Approvals.gs apvVendorClean_ 同一套規則）：回錯誤文字或 '' */
export function checkVendor(v) {
  const s = (x) => String(x === undefined || x === null ? '' : x).trim();
  if (!s(v.name) || s(v.name).length > 60) return '廠商名稱要 1～60 字';
  if (!/^\d{3}$/.test(s(v.bank_code))) return '銀行代碼要是 3 位數字';
  if (!s(v.bank_name) || s(v.bank_name).length > 30) return '請填銀行名稱（最多 30 字）';
  if (s(v.branch).length > 30) return '分行最多 30 字';
  if (!s(v.acct_name) || s(v.acct_name).length > 60) return '請填戶名（最多 60 字）';
  const no = s(v.acct_no).replace(/\s+/g, '');
  const digits = no.replace(/-/g, '');
  if (!/^[0-9-]+$/.test(no) || digits.length < 6 || digits.length > 16 || /^-|-$|--/.test(no)) return '帳號只能是 6～16 位數字（可用 - 分段）';
  if (s(v.note).length > 100) return '備註最多 100 字';
  return '';
}

// ── 匯出（CSV，Excel 直接開；以 = + - @ 開頭的格前面加 ' 防公式注入）──
export const CSV_COLUMNS = [
  ['date', '日期'], ['type_name', '種類'], ['unit_name', '單位'], ['payee', '對象'], ['desc', '說明'], ['category', '類別'], ['amount', '金額'],
  ['bank_code', '銀行代碼'], ['bank_name', '銀行'], ['branch', '分行'], ['acct_name', '戶名'], ['acct_no', '帳號'],
  ['state', '狀態'], ['paid_date', '匯款日'], ['id', '單號']
];
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function flatRow(r) {
  const b = r.bank || {};
  return {
    date: r.date, type_name: r.type_name, unit_name: r.unit_name, payee: r.payee, desc: r.desc, category: r.category, amount: Number(r.amount) || 0,
    bank_code: r.self_pay ? '' : (b.bank_code || ''), bank_name: r.self_pay ? '同仁代墊' : (b.bank_name || ''), branch: b.branch || '',
    acct_name: b.acct_name || '', acct_no: b.acct_no ? '​' + b.acct_no : '',   // 帳號前加零寬字元：Excel 不會把開頭 0 吃掉、也不會轉成科學記號
    state: r.state === 'paid' ? '已匯款' : '待出帳', paid_date: (r.paid && r.paid.date) || '', id: r.id
  };
}
export function toCsv(rows) {
  const head = CSV_COLUMNS.map((c) => csvCell(c[1])).join(',');
  const lines = (rows || []).map((r) => { const f = flatRow(r); return CSV_COLUMNS.map(([k]) => csvCell(f[k])).join(','); });
  return '﻿' + [head].concat(lines).join('\r\n');
}

/** 錯誤碼 → 中文 */
export function errText(res) {
  const code = res && res.error;
  const msg = res && res.data && res.data.message;
  switch (code) {
    case 'conflict': return msg || '剛被別人改過，請重新整理';
    case 'forbidden': return msg || '你沒有權限做這件事';
    case 'unauthorized': return '登入已過期，請重新登入';
    case 'not_found': return msg || '找不到這筆資料';
    case 'no_account': return msg || '這家廠商還沒設定銀行帳戶';
    case 'dup': return msg || '已經有同名的廠商';
    case 'not_inited': return '表單簽核還沒初始化';
    case 'busy': return '系統忙碌，請稍後再試';
    case 'bad_request': return msg || '有欄位沒填對';
    default: return msg || (typeof code === 'string' && code ? code : '操作失敗，請稍後再試');
  }
}
