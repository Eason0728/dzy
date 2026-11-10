/**
 * modules/attendance/mobile.js — 手機「待處理」用的考勤申請清單（2026-11-06，docs/mobile-v2/spec.md）
 * 營運系統 POST /store/api/svc/att-alerts 依 action 分派（mala-store-ops#101）：
 *   reqMine 我送出的（近 60 天）／reqDecided 我核過的（近 30 天）／reqPending 我現在核得了的／reqDecide 核准或退回一張。
 * 回應信封同 attAlerts（unwrap 剝 r.data.data）；能不能核由營運系統照考勤管理名單判斷，這裡只轉成殼要的清單列。
 */
'use strict';

import { unwrap } from './alerts.js';

const STATE = { pending: 'wait', approved: 'ok', rejected: 'no', void: 'off' };

function when(it) {
  const t = it.from && it.to ? ` ${it.from}–${it.to}` : '';
  return `${it.date || ''}${t}`.trim();
}
function what(it) {
  const h = typeof it.hours === 'number' && it.hours > 0 ? ` ${it.hours} 小時` : '';
  return `${it.label || '申請'}${h}`;
}

/** 我送出的一筆 → 殼的清單列 */
export function mineItem(it) {
  const reject = it.status === 'rejected' && it.rejectReason ? `退回：${it.rejectReason}` : '';
  return {
    text: what(it),
    sub: [when(it), it.storeName, reject].filter(Boolean).join('・'),
    state: STATE[it.status] || 'wait',
    view: 'request'
  };
}

/** 我核過的一筆 */
export function decidedItem(it) {
  const state = it.status === 'void' ? 'off' : (it.decision === 'reject' ? 'no' : 'ok');
  return {
    text: `${it.name || ''} ${what(it)}`.trim(),
    sub: [when(it), it.storeName].filter(Boolean).join('・'),
    state,
    stateText: state === 'off' ? '已作廢' : (state === 'no' ? '你已退回' : '你已核准'),
    view: 'request'
  };
}

/** 待核一筆 → 可以直接核准的卡片（id＝「店|單號」，decide 再拆） */
export function quickItem(it) {
  return {
    id: `${it.store}|${it.id}`,
    text: `${it.name || ''} ${what(it)}`.trim(),
    sub: [when(it), it.storeName].filter(Boolean).join('・'),
    detail: [it.reason ? `原因：${it.reason}` : '', it.hasAttach ? '有附證明（到考勤管理看）' : ''].filter(Boolean).join('　'),
    view: 'request'
  };
}

export function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf('|');
  return i > 0 ? { store: s.slice(0, i), id: s.slice(i + 1) } : null;
}

function errOf(r) {
  if (!r) return '送出失敗，請稍後再試';
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  return r.error || d.error || d.message || (d.data && d.data.error) || '送出失敗，請稍後再試';
}

async function list(ctx, action, map) {
  const r = await ctx.api.call('attendance', action, {});
  const d = unwrap(r);
  return d ? d.items.map(map) : null;
}

/**
 * 我送出的：任何有同仁編號的人都能讀自己的（不需要考勤管理權限；manifest openHooks）。
 * 代轉 403 有兩種來源（mini 代轉 AUTH_STATUS）：
 *   這個帳號沒有同仁編號（後端 storeSubForUser_：不是同仁、也不是系統管理者的系統帳號一定沒有）＝沒有東西可列；
 *   或考勤通行碼沒設定（NO_SECRET），那是故障。
 * 前端只拿得到狀態碼、分不出來，所以只有系統帳號的 403 當空清單；同仁、系統管理者、角色不明的 403 照樣算讀不到
 * （回 null，殼顯示「暫時讀不到」；不可把故障顯示成「沒有送出的單」）。其他失敗一律 null。
 */
async function mine(ctx) {
  const r = await ctx.api.call('attendance', 'reqMine', {});
  const role = ctx && ctx.user && typeof ctx.user.role === 'string' ? ctx.user.role : '';
  if (r && r.ok === false && r.status === 403 && role && role !== 'staff' && role !== 'admin') return [];
  const d = unwrap(r);
  return d ? d.items.map(mineItem) : null;
}

export const mobileHooks = {
  mine,
  decided: (ctx) => list(ctx, 'reqDecided', decidedItem),
  quick: (ctx) => list(ctx, 'reqPending', quickItem),
  async decide(ctx, id, decision, reason) {
    const k = splitId(id);
    if (!k || (decision !== 'approve' && decision !== 'reject')) return { ok: false, error: '這張單的資料不完整，請到考勤管理處理' };
    const r = await ctx.api.call('attendance', 'reqDecide', { store: k.store, id: k.id, decision, reason: reason || '' });
    const inner = r && r.data && r.data.data;
    if (r && r.ok && (!inner || inner.ok !== false)) return { ok: true };
    return { ok: false, error: errOf(r) };
  }
};
