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

/**
 * 審單出勤試算（2026-11-25 營運系統 ot-review-hint 第 7 題 A）：加班單比照核定規則試算「多了」時，手機只多這一行。
 * 營運系統開關（DUTY_REQ_OT_CHECK）關著、或不是「多了」＝不帶 otCheck＝''（卡片跟以前逐字相同）。只提示，核准照常。
 */
export function otLine(it) {
  const o = it && it.otCheck;
  const ok = (v) => typeof v === 'number' && isFinite(v);
  if (!o || typeof o !== 'object' || !ok(o.need) || !ok(o.n) || !ok(o.over)) return '';
  const f = (x) => String(Math.round(x * 100) / 100);
  return `出勤試算：應有加班 ${f(o.need)} 小時，這張 ${f(o.n)} 小時（多 ${f(o.over)} 小時）`;
}

/** 待核一筆 → 可以直接核准的卡片（id＝「店|單號」，decide 再拆） */
export function quickItem(it) {
  return {
    id: `${it.store}|${it.id}`,
    text: `${it.name || ''} ${what(it)}`.trim(),
    sub: [when(it), it.storeName].filter(Boolean).join('・'),
    detail: [it.reason ? `原因：${it.reason}` : '', it.hasAttach ? '有附證明（到考勤管理看）' : ''].filter(Boolean).join('　'),
    ...(otLine(it) ? { ot: otLine(it) } : {}),      // 試算那一行：殼另外畫一列（.m-card-ot），沒有＝卡片跟以前一樣
    view: 'request',
    // 一次填兩段（2026-11-18）：同一次送出的兩張單，營運系統帶同一個 group（舊資料／單張＝空）。
    // 殼只看 group（店|組別|姓名|日期，四個都一樣才併成一張卡）；其餘 g* 欄位給 groupCard 組標題與兩段各一列用
    group: groupKeyOf(it),
    gSeg: Number.isInteger(it.seg) && it.seg >= 1 ? it.seg : 0,
    gWho: it.name || '', gLabel: it.label || '申請', gDate: it.date || '', gStoreName: it.storeName || '',
    gFrom: it.from || '', gTo: it.to || '', gHours: typeof it.hours === 'number' && isFinite(it.hours) ? it.hours : null,
    gReason: it.reason || '', gAttach: !!it.hasAttach,
    ...(otLine(it) ? { gOt: otLine(it) } : {})
  };
}

function groupKeyOf(it) {
  const g = typeof it.group === 'string' ? it.group.trim() : '';
  return g ? [it.store || '', g, it.name || '', it.date || ''].join('|') : '';
}

const WORD = ['零', '一', '兩', '三', '四', '五', '六', '七', '八', '九'];
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function segOrder(a, b) {
  if (a.gSeg && b.gSeg && a.gSeg !== b.gSeg) return a.gSeg - b.gSeg;
  const ta = hm(a.gFrom), tb = hm(b.gFrom);
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : (a.id === b.id ? 0 : 1);
}
const hoursText = (h) => `${Math.round(h * 100) / 100} 小時`;

/**
 * 同一次送出的幾張待核單（quickItem 的結果，已確認 group 相同）→ 一張組卡要顯示的內容。純函式，不碰網路。
 * 回 { text, sub, detail, segs:[{ id, tag, text }] }；segs 依第幾段（沒有 seg 就依開始時間）排好。
 * 標題「姓名 加班兩段 共 7 小時」；每張都有小時數才寫「共 N 小時」。
 */
export function groupCard(items) {
  const its = items.slice().sort(segOrder);
  const first = its[0];
  const n = its.length;
  let total = 0, all = true;
  for (const x of its) { if (x.gHours === null) all = false; else total += x.gHours; }
  const segWord = (n < 10 ? (n === 2 ? '兩' : WORD[n]) : String(n)) + '段';
  const reasons = [];
  for (const x of its) if (x.gReason && !reasons.includes(x.gReason)) reasons.push(x.gReason);
  return {
    text: `${first.gWho} ${first.gLabel}${segWord}${all ? ` 共 ${hoursText(total)}` : ''}`.trim(),
    sub: [first.gDate, first.gStoreName].filter(Boolean).join('・'),
    detail: [reasons.length ? `原因：${reasons.join('、')}` : '', its.some((x) => x.gAttach) ? '有附證明（到考勤管理看）' : ''].filter(Boolean).join('　'),
    ...(its.some((x) => x.gOt) ? { ot: its.find((x) => x.gOt).gOt } : {}),
    segs: its.map((x, i) => ({
      id: x.id,
      tag: `第 ${x.gSeg || i + 1} 段`,
      text: [x.gFrom && x.gTo ? `${x.gFrom}–${x.gTo}` : '', x.gHours !== null ? hoursText(x.gHours) : ''].filter(Boolean).join('　')
    }))
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

// 核准或退回一張（decide 與 decideGroup 共用）
async function decideOne(ctx, id, decision, reason) {
  const k = splitId(id);
  if (!k || (decision !== 'approve' && decision !== 'reject')) return { ok: false, error: '這張單的資料不完整，請到考勤管理處理' };
  const r = await ctx.api.call('attendance', 'reqDecide', { store: k.store, id: k.id, decision, reason: reason || '' });
  const inner = r && r.data && r.data.data;
  // 那天已經核定過（Eason 2026-11-13 紅燈 a2 選 A）：照常核准，帶提醒給畫面（營運系統 reqDecide 回 warn／message）
  if (r && r.ok && (!inner || inner.ok !== false)) return inner && inner.warn ? { ok: true, warn: String(inner.warn), message: String(inner.message || '那天已經核定過，請重新核定一次') } : { ok: true };
  return { ok: false, error: errOf(r) };
}

export const mobileHooks = {
  mine,
  decided: (ctx) => list(ctx, 'reqDecided', decidedItem),
  quick: (ctx) => list(ctx, 'reqPending', quickItem),
  decide: (ctx, id, decision, reason) => decideOne(ctx, id, decision, reason),
  groupCard,
  /**
   * 「兩筆一起核准」（2026-11-18）：依序把每張各送一次既有的核准動作（管理系統後端沒有批次動作，這裡不新增）。
   * 任何一張失敗就停（後面的不送）。回 { results: [{ id, ok, error?, warn?, message? }] }，只含有送出的；沒出現的＝沒送。
   * 兩張本來就各自獨立：第 1 張已核准、第 2 張失敗，第 1 張不會退回，畫面照實顯示、第 2 張留著可以再按。
   */
  async decideGroup(ctx, ids) {
    const results = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      let r;
      try { r = await decideOne(ctx, id, 'approve', ''); } catch (e) { r = { ok: false, error: '送出失敗，請稍後再試' }; }
      results.push(Object.assign({ id }, r));
      if (!r.ok) break;
    }
    return { results };
  }
};
