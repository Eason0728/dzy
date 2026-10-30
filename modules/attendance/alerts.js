/**
 * modules/attendance/alerts.js — 考勤管理首頁待辦的純函式（2026-10-24，營運系統 spec §17.5）
 * 資料來源：營運系統 POST /store/api/svc/att-alerts，信封 {ok,data:{items:[{kind,count}],partial,asOf,pending}}。
 * 只有件數，沒有人名（§17.4）。
 */
'use strict';

const TEXT = {
  approve: (n) => `本月還有 ${n} 天沒核定`,
  request: (n) => `${n} 筆加班請假申請待審`,
  device: (n) => `${n} 支新手機等核准`
};
const ORDER = ['approve', 'request', 'device'];

/**
 * ctx.api.call('attendance', …) 的結果 → 上游 data。
 * attendance 是代轉 ns，api.js transformResponse_ 走「扁平物件」分支：ok 以外整包塞進 data，
 * 所以上游的 {ok,data:{items…}} 會變成 r.data.data.items。這裡剝掉那一層；
 * 若哪天 api.js 改成直接給 {items…} 也照樣認得。ok:false／形狀不對回 null。
 */
export function unwrap(r) {
  if (!r || r.ok !== true || !r.data || typeof r.data !== 'object') return null;
  const d = r.data;
  if (Array.isArray(d.items)) return d;
  if (d.data && typeof d.data === 'object' && Array.isArray(d.data.items)) return d.data;
  return null;
}

function countOf(items, kind) {
  let sum = 0;
  for (const it of items) {
    if (it && it.kind === kind && Number.isFinite(it.count) && it.count > 0) sum += it.count;
  }
  return sum;
}

/** 上游 data → alerts() 的陣列；形狀不對回 null */
export function toAlerts(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  if (data.pending === true) return [{ level: 'info', text: '出勤待辦統計中，稍後回首頁就會看到' }];
  const out = [];
  for (const kind of ORDER) {
    const c = countOf(data.items, kind);
    if (c > 0) out.push({ level: 'warn', text: TEXT[kind](c), view: kind });
  }
  if (data.partial === true) out.push({ level: 'warn', text: '部分門市暫時讀不到' });
  return out;
}

/** 上游 data → 側邊欄／卡片數字（核定＋申請）；統計中或形狀不對回 null */
export function toBadge(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  if (data.pending === true) return null;
  return countOf(data.items, 'approve') + countOf(data.items, 'request');
}

/**
 * attUpperGaps（平台後端，人資主管／管理員才有內容）的結果 → 一列提醒或 null。
 * 值班主管本人的申請找不到上層時，由人資主管審（docs/req-upper）；只認 items 裡有 emp 字串的列（別的形狀不算）。
 */
export function toGapAlert(r) {
  if (!r || r.ok !== true || !r.data || !Array.isArray(r.data.items)) return null;
  const n = r.data.items.filter((it) => it && typeof it.emp === 'string' && it.emp !== '').length;
  const un = Array.isArray(r.data.unmapped) ? r.data.unmapped.filter((it) => it && typeof it.emp_id === 'string' && it.emp_id !== '').length : 0;
  const total = n + un;
  if (total <= 0) return null;
  return { level: 'warn', text: `${total} 位值班主管的申請找不到上層，由人資主管審`, view: 'request' };
}

/**
 * attUpperGaps.hours_items（2026-10-30 Eason 照推薦）→ 一列提醒或 null：工時找不到核定人（除人資主管／admin 外沒人能核）的同仁，點了進「核定工時」。
 * 舊後端沒有 hours_items → null（不顯示）。只認 emp 字串的列。
 */
export function toHoursGapAlert(r) {
  if (!r || r.ok !== true || !r.data || !Array.isArray(r.data.hours_items)) return null;
  const n = r.data.hours_items.filter((it) => it && typeof it.emp === 'string' && it.emp !== '').length;
  if (n <= 0) return null;
  return { level: 'warn', text: `${n} 位同仁的工時沒人核，由人資主管核`, view: 'approve' };
}

