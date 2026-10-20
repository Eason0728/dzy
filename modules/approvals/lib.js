/**
 * modules/approvals/lib.js — 表單簽核前端的純函式（不碰 DOM，方便單元測試）
 * 契約正本：docs/approvals/api.md（型別、錯誤碼）、spec.md §7／§14。
 */
'use strict';

import { apvCalcAmount } from '../approvals-shared/amount.js';

export const TYPES = [
  { id: 'purchase', name: '請購' },
  { id: 'expense', name: '請款' },
  { id: 'personnel', name: '人事異動' }
];
export const TYPE_LABEL = { purchase: '請購', expense: '請款', personnel: '人事異動' };
export const KIND_LABEL = { leave: '離職', transfer: '調職', raise: '調薪' };
export const CATEGORY = { repair: '設備維修', food: '食材臨時採購', misc: '雜支', transport: '交通', supplies: '文具耗材', other: '其他' };
export const DEPT_LABEL = { purchase: '採購部', fin: '財務部', hr: '人資部' };
// brand_dir：品牌辦公室總監；中央工廠是研發總監（docs/org/spec.md 第 15 節）。head：門市店長、中央工廠廠長
export const ROLE_LABEL = { head: '單位主管', brand_dir: '品牌總監／研發總監', ceo: '執行長', gm: '總經理', chair: '董事長', direct: '直屬主管', self_sign: '本人簽名' };
/** 權限表可選的權限人（由低到高，spec §2） */
export const THR_ROLES = ['head', 'brand_dir', 'ceo', 'gm', 'chair'];
export const THR_ROLE_STORE_LABEL = { head: '店長／廠長', brand_dir: '品牌總監／研發總監', ceo: '執行長', gm: '總經理', chair: '董事長' };
export const THR_ROLE_HQ_LABEL = { head: '部門主管', brand_dir: '品牌總監', ceo: '執行長', gm: '總經理', chair: '董事長' };

/** status → [中文, tag 色 class] */
export const STATUS = {
  signing: ['簽核中', 'tag-warn'],
  handling: ['待承辦', 'tag-warn'],
  done: ['已完成', 'tag-ok'],
  rejected: ['已退回', 'tag-danger'],
  withdrawn: ['已撤回', ''],
  exception: ['找不到簽核人', 'tag-danger'],
  voided: ['已作廢', '']
};

/** 各分頁哪些動作可以出現在卡片上；真正顯不顯示還要看伺服器算好的 form.can（前端只拿來顯示按鈕） */
export const SCOPE_ACTS = {
  sign: ['approve', 'reject', 'sign'],
  handle: ['done', 'return', 'reassign'],
  mine: ['resubmit', 'withdraw'],
  all: ['reassign', 'void']
};
export const ACT_DEF = {
  approve: { label: '核准', variant: 'btn-primary', can: 'decide' },
  reject: { label: '退回', variant: 'btn-danger', can: 'decide' },
  sign: { label: '本人簽名', variant: 'btn-primary', can: 'sign' },
  done: { label: '已處理', variant: 'btn-primary', can: 'handle' },
  return: { label: '退回送件人', variant: 'btn-danger', can: 'handle' },
  resubmit: { label: '改完再送', variant: 'btn-primary', can: 'resubmit' },
  withdraw: { label: '撤回', variant: 'btn-secondary', can: 'withdraw' },
  reassign: { label: '改派', variant: 'btn-secondary', can: 'reassign' },
  void: { label: '作廢', variant: 'btn-danger', can: 'void' }
};

/** 這張單在這個分頁該出現哪些按鈕（依 form.can） */
export function visibleActions(form, scope) {
  const can = (form && form.can) || {};
  return (SCOPE_ACTS[scope] || []).filter((a) => can[ACT_DEF[a].can] === true).map((a) => ({ act: a, ...ACT_DEF[a] }));
}

/** 錯誤碼 → 給人看的中文（api.md；error 是碼，message 在 res.data.message） */
export function errText(res) {
  const code = res && res.error;
  const msg = res && res.data && res.data.message;
  switch (code) {
    case 'conflict': return '這張單剛被別人處理過，請重新整理';
    case 'forbidden': return '你沒有權限做這件事';
    case 'unauthorized': return '登入已過期，請重新登入';
    case 'not_found': return '找不到這張單';
    case 'no_files': return '請款至少要附一張收據照片';
    case 'file_invalid': return '照片格式不對，請重新拍一張';
    case 'file_too_large': return '照片太大，請重新拍一張';
    case 'quota': return '今天上傳的照片太多了，明天再試';
    case 'busy': return '系統忙碌，請稍後再試';
    case 'bad_amount': return msg || '金額不對，請檢查數量與單價';
    case 'bad_request': return msg || '有欄位沒填對';
    default: return msg || (typeof code === 'string' && code ? code : '操作失敗，請稍後再試');
  }
}

export function isConflict(res) { return !!res && res.ok === false && res.error === 'conflict'; }

// ── 金額 ───────────────────────────────────────────────
/** 請購金額：呼叫 approvals-shared 的 apvCalcAmount 並把回傳正規化成 {ok, amount, subtotals} */
export function calcPurchase(items) {
  const nums = (items || []).map((it) => ({ qty: toNum(it.qty), price: toNum(it.price) }));
  let r;
  try { r = apvCalcAmount('purchase', { items: nums }); } catch (e) { return { ok: false, amount: 0, subtotals: [] }; }
  if (typeof r === 'number') return { ok: isFinite(r) && r > 0, amount: isFinite(r) ? r : 0, subtotals: [] };
  if (!r || r.ok === false) return { ok: false, amount: 0, subtotals: (r && r.subtotals) || [], row: r && r.row };
  return { ok: true, amount: r.amount, subtotals: r.subtotals || [] };
}
export function toNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (s === '') return NaN;
  return Number(s);
}
/** 請款金額：整數元 1～10,000,000（spec §14.6） */
export function checkExpenseAmount(v) {
  const n = toNum(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000000;
}

// ── 草稿（請購／請款存 localStorage；人事單不存，spec §14.7）──────
export const DRAFT_TYPES = ['purchase', 'expense'];
export function draftKey(userId, type) { return `dzy.u.${userId}.apv_draft_${type}`; }
export function loadDraft(storage, userId, type) {
  if (!storage || !userId || DRAFT_TYPES.indexOf(type) === -1) return null;
  try {
    const raw = storage.getItem(draftKey(userId, type));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch (e) { return null; }
}
export function saveDraft(storage, userId, type, data) {
  if (!storage || !userId || DRAFT_TYPES.indexOf(type) === -1) return false;
  try { storage.setItem(draftKey(userId, type), JSON.stringify(data)); return true; } catch (e) { return false; }
}
export function clearDraft(storage, userId, type) {
  if (!storage || !userId) return;
  try { storage.removeItem(draftKey(userId, type)); } catch (e) { /* ignore */ }
}

// ── 卡在誰 ─────────────────────────────────────────────
export function stepWho(step) {
  if (!step) return '';
  const names = (step.candidates || []).map((c) => c.name).filter(Boolean);
  const role = (step.override && step.override.to) ? `指派：${step.override.to}` : (ROLE_LABEL[step.role] || step.role || '');
  return names.length ? `${role}（${names.join('、')}）` : role;
}
export function whereText(form) {
  if (!form) return '';
  const st = form.status;
  if (st === 'signing') {
    const steps = (form.route && form.route.steps) || [];
    const s = steps[form.step];
    return s ? `卡在：${stepWho(s)}` : '簽核中';
  }
  if (st === 'handling') return `等承辦：${DEPT_LABEL[form.handler_dept] || form.handler_dept || ''}`;
  if (st === 'exception') return '找不到合格的簽核人，等人資指派';
  return '';
}

// ── CSV（spec §14.12）──────────────────────────────────
export const CSV_COLUMNS = [
  ['id', '單號'], ['rev', '版次'], ['type', '種類'], ['unit_name', '單位'], ['sender_name', '送件人'], ['amount', '金額'],
  ['category', '類別'], ['vendor', '廠商'], ['desc', '說明'], ['created_at', '送件日'], ['approved_at', '核准日'], ['done_at', '處理日'], ['handle_note', '承辦備註']
];
/** 以 = + - @ Tab CR 開頭的文字格前面加 '（試算表公式注入）；含逗號／引號／換行的加雙引號 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCsv(rows, fmtTime) {
  const ft = typeof fmtTime === 'function' ? fmtTime : (x) => x;
  const timeKeys = { created_at: 1, approved_at: 1, done_at: 1 };
  const head = CSV_COLUMNS.map((c) => csvCell(c[1])).join(',');
  const lines = (rows || []).map((r) => CSV_COLUMNS.map(([k]) => {
    let v = r[k];
    if (timeKeys[k] && v) v = ft(v);
    if (k === 'type') v = TYPE_LABEL[v] || v;
    if (k === 'category') v = CATEGORY[v] || v;
    return csvCell(v);
  }).join(','));
  return '﻿' + [head].concat(lines).join('\r\n');
}

// ── 核決權限表 ─────────────────────────────────────────
/** 前端檢查（後端才是正本）：金額嚴格遞增、只有最後一列 max 空、role 合法、至少一列 */
export function validateThr(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '至少要有一級';
  let prev = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const last = i === rows.length - 1;
    if (THR_ROLES.indexOf(r.store_role) === -1 || THR_ROLES.indexOf(r.hq_role) === -1) return `第 ${i + 1} 級還沒選權限人`;
    if (last) {
      if (r.max !== null && r.max !== undefined && r.max !== '') return '最後一級金額要留空（＝以上全部）';
    } else {
      const m = toNum(r.max);
      if (!Number.isInteger(m) || m < 1) return `第 ${i + 1} 級金額要填正整數`;
      if (m <= prev) return `第 ${i + 1} 級金額要比上一級大`;
      prev = m;
    }
  }
  return '';
}
export function normThrRows(rows) {
  return rows.map((r, i) => ({
    seq: i + 1,
    max: i === rows.length - 1 ? null : toNum(r.max),
    store_role: r.store_role,
    hq_role: r.hq_role
  }));
}
function rangeText(rows, i) {
  const lo = i === 0 ? 0 : (rows[i - 1].max + 1);
  return rows[i].max === null ? `${lo.toLocaleString('en-US')} 以上` : `${lo.toLocaleString('en-US')}～${rows[i].max.toLocaleString('en-US')}`;
}
/** 儲存前顯示「改了什麼」：回字串陣列（空＝沒改） */
export function diffThr(before, after) {
  const out = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i];
    const b = after[i];
    if (a && !b) { out.push(`刪除第 ${i + 1} 級（${rangeText(before, i)}）`); continue; }
    if (!a && b) {
      out.push(`新增第 ${i + 1} 級（${rangeText(after, i)}）：門市 ${THR_ROLE_STORE_LABEL[b.store_role]}、總部 ${THR_ROLE_HQ_LABEL[b.hq_role]}`);
      continue;
    }
    const parts = [];
    if (a.max !== b.max) parts.push(`金額上限 ${a.max === null ? '以上全部' : a.max.toLocaleString('en-US')} → ${b.max === null ? '以上全部' : b.max.toLocaleString('en-US')}`);
    if (a.store_role !== b.store_role) parts.push(`門市 ${THR_ROLE_STORE_LABEL[a.store_role]} → ${THR_ROLE_STORE_LABEL[b.store_role]}`);
    if (a.hq_role !== b.hq_role) parts.push(`總部 ${THR_ROLE_HQ_LABEL[a.hq_role]} → ${THR_ROLE_HQ_LABEL[b.hq_role]}`);
    if (parts.length) out.push(`第 ${i + 1} 級：${parts.join('；')}`);
  }
  return out;
}

// ── 雜項 ───────────────────────────────────────────────
export function newClientId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) { /* fallthrough */ }
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
export function money(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : ''; }
/** 首頁提醒用：待我簽／待我辦／卡關（卡關用紅色，exception 另列） */
export function buildAlerts(data) {
  const d = data || {};
  const sign = Array.isArray(d.sign) ? d.sign : [];
  const handle = Array.isArray(d.handle) ? d.handle : [];
  const exc = Array.isArray(d.exception) ? d.exception : [];
  const out = [];
  if (sign.length) out.push({ level: sign.some((f) => f && f.stuck) ? 'error' : 'warn', text: `待我簽 ${sign.length} 張`, view: 'sign' });
  if (handle.length) out.push({ level: handle.some((f) => f && f.stuck) ? 'error' : 'warn', text: `待我辦 ${handle.length} 張`, view: 'handle' });
  if (exc.length) out.push({ level: 'error', text: `${exc.length} 張單找不到合格簽核人，要指派`, view: 'handle' });
  return out;
}
