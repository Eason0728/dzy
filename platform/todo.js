/**
 * platform/todo.js — 手機首頁與「待處理」的分段（2026-11-06 Eason：依「已逾期／今天／這週」排）。
 *
 * 模組 alerts() 每一項選填（spec §4.6 補充，docs/mobile-v2/spec.md）：
 *   when: 'overdue' | 'today' | 'week'   模組自己知道是哪一段時直接給
 *   due:  'YYYY-MM-DD'                   期限日；殼依台北今天算段
 * 兩個都沒給：error（要緊）＝今天、warn＝這週、info＝提醒。
 */
'use strict';

export const TODO_GROUPS = [
  { id: 'overdue', name: '已逾期' },
  { id: 'today', name: '今天' },
  { id: 'week', name: '這週' },
  { id: 'info', name: '提醒' }
];
const WHENS = ['overdue', 'today', 'week'];
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 台北今天 'YYYY-MM-DD' */
export function taipeiToday(now) {
  const d = new Date((now instanceof Date ? now.getTime() : Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 期限日 → 段：過了＝已逾期、當天＝今天、其餘＝這週（太遠的也算這週，期限都是本月內的事） */
export function groupOfDue(due, today) {
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'week';
}

/** 一項提醒 → 段 id */
export function groupOf(item, today) {
  if (item && WHENS.includes(item.when)) return item.when;
  if (item && typeof item.due === 'string' && DUE_RE.test(item.due)) return groupOfDue(item.due, today);
  if (item && item.level === 'error') return 'today';
  if (item && item.level === 'warn') return 'week';
  return 'info';
}

/** 清洗 alerts() 項目上的 when／due（不合格就丟掉，當作沒給） */
export function cleanWhen(it) {
  const out = {};
  if (it && WHENS.includes(it.when)) out.when = it.when;
  if (it && typeof it.due === 'string' && DUE_RE.test(it.due)) out.due = it.due;
  return out;
}
