/**
 * modules/schedule/alerts.js — 排班管理首頁待辦的純函式（2026-10-24，營運系統 docs/autoschedule/hr-move-spec.md §5）
 * 資料來源：營運系統 POST /store/api/svc/sched-alerts，{items:[{code,name,periods:['T01',…]}], asOf}；只有店名與期別。
 * 代轉信封的剝法與考勤管理相同，直接共用 attendance 的 unwrap。
 */
'use strict';

export { unwrap } from '../attendance/alerts.js';

const periodsOf = (it) => (it && Array.isArray(it.periods) ? it.periods.filter((p) => typeof p === 'string' && p) : []);

/** 總部排班提醒（營運系統 server/sched-alerts.js）：data.self＝{due:['T02'…], wait:N, missing:N}；缺或形狀不對＝沒有（不顯示）。
 *  2026-11-03 起總部改四週一期、存檔就生效：due 是期別、意思是「還沒填完」，wait 固定 0；舊版營運系統送 'YYYY-MM' 照舊顯示「N 月班表還沒送出」 */
const countOf = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const monthText = (m) => {
  if (typeof m === 'string' && /^T\d{2,}$/.test(m)) return `${m} 班表還沒填完`;
  const x = /^\d{4}-(\d{2})$/.exec(typeof m === 'string' ? m : ''); return x ? `${Number(x[1])} 月班表還沒送出` : '';
};
function selfOf(data) {
  const s = data && typeof data === 'object' && data.self && typeof data.self === 'object' ? data.self : {};
  return { due: Array.isArray(s.due) ? s.due.map(monthText).filter(Boolean) : [], wait: countOf(s.wait), missing: countOf(s.missing) };
}

/** 央廚固定排班提醒（營運系統 server/sched-alerts.js，2026-10-25）：data.fixed＝[{code,name,missing:N}]；缺或形狀不對＝沒有 */
function fixedOf(data) {
  const l = data && typeof data === 'object' && Array.isArray(data.fixed) ? data.fixed : [];
  return l.filter((x) => x && typeof x === 'object' && countOf(x.missing) > 0).map((x) => ({ name: x.name || x.code || '央廚', missing: countOf(x.missing) }));
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
  for (const m of me.due) out.push({ level: 'warn', text: m, view: 'self' });
  if (me.wait > 0) out.push({ level: 'info', text: `${me.wait} 位同仁的班表等你核准`, view: 'approve' });
  if (me.missing > 0) out.push({ level: 'warn', text: `${me.missing} 位同仁下一期班表還沒填完`, view: 'approve' });
  for (const f of fixedOf(data)) out.push({ level: 'warn', text: `${f.name} 有 ${f.missing} 位同仁還沒設固定班別（平日班表空白）`, view: 'fixedstaff' });
  return out;
}

/** 上游 data → 側邊欄／卡片數字：還沒送到的期數合計＋等你核准的人數（self.wait）；形狀不對回 null */
export function toBadge(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  return data.items.reduce((sum, it) => sum + periodsOf(it).length, 0) + selfOf(data).wait;
}
