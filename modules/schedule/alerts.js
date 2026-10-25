/**
 * modules/schedule/alerts.js — 排班管理首頁待辦的純函式（2026-10-24，營運系統 docs/autoschedule/hr-move-spec.md §5）
 * 資料來源：營運系統 POST /store/api/svc/sched-alerts，{items:[{code,name,periods:['T01',…]}], asOf}；只有店名與期別。
 * 代轉信封的剝法與考勤管理相同，直接共用 attendance 的 unwrap。
 */
'use strict';

export { unwrap } from '../attendance/alerts.js';

const periodsOf = (it) => (it && Array.isArray(it.periods) ? it.periods.filter((p) => typeof p === 'string' && p) : []);

/** 總部排班提醒（營運系統 docs/schedule-hq/spec.md §10.2）：data.self＝{due:['YYYY-MM'…], wait:N, missing:N}；缺或形狀不對＝沒有（不顯示） */
const countOf = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const monthText = (m) => { const x = /^\d{4}-(\d{2})$/.exec(typeof m === 'string' ? m : ''); return x ? `${Number(x[1])} 月` : ''; };
function selfOf(data) {
  const s = data && typeof data === 'object' && data.self && typeof data.self === 'object' ? data.self : {};
  return { due: Array.isArray(s.due) ? s.due.map(monthText).filter(Boolean) : [], wait: countOf(s.wait), missing: countOf(s.missing) };
}

/** 上游 data → alerts() 的陣列：每家一列；零件數回空陣列；形狀不對回 null */
export function toAlerts(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  const out = [];
  for (const it of data.items) {
    const ps = periodsOf(it);
    if (!ps.length) continue;
    out.push({ level: 'warn', text: `${(it && it.name) || (it && it.code) || '門市'} ${ps.join('、')} 班表還沒送到 LINE`, view: 'board' });
  }
  const me = selfOf(data);
  for (const m of me.due) out.push({ level: 'warn', text: `${m}班表還沒送出`, view: 'self' });
  if (me.wait > 0) out.push({ level: 'info', text: `${me.wait} 位同仁的班表等你核准`, view: 'approve' });
  if (me.missing > 0) out.push({ level: 'warn', text: `${me.missing} 位同仁下個月班表還沒送出`, view: 'approve' });
  return out;
}

/** 上游 data → 側邊欄／卡片數字：還沒送到的期數合計＋等你核准的人數（self.wait）；形狀不對回 null */
export function toBadge(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  return data.items.reduce((sum, it) => sum + periodsOf(it).length, 0) + selfOf(data).wait;
}
