// 稽核日期一律台灣時間（2026-10-25 審查 A-09）：不論執行環境時區，台北 11/1 凌晨 1 點填的單都算 11/1、11 月
import assert from 'node:assert/strict';
import * as Ops from '../modules/audit-ops/views/fill-submit.js';
import * as Stock from '../modules/audit-stock/views/fill-submit.js';

const at = new Date('2026-10-31T17:00:00Z');   // 台北 2026-11-01 01:00
assert.equal(Ops.todayStr(at), '2026-11-01', '營運稽核 todayStr 用台北日期');
assert.equal(Ops.currentMonth(at), '2026-11', '營運稽核 currentMonth 用台北月份');
assert.equal(Stock.todayStr(at), '2026-11-01', '盤點抽查 todayStr 用台北日期');
const late = new Date('2026-11-30T15:59:59Z');  // 台北 11/30 23:59:59
assert.equal(Ops.todayStr(late), '2026-11-30');
assert.equal(Ops.currentMonth(late), '2026-11');
assert.equal(Stock.currentMonth(at), '2026-11', '盤點抽查 currentMonth 用台北月份');
// index.js 的 badge／首頁待辦「本月」也要台北時間（2026-10-29）
const { currentMonthStr } = await import('../modules/audit-stock/index.js');
assert.equal(currentMonthStr(at), '2026-11', '盤點抽查 badge／待辦「本月」用台北月份');
assert.equal(currentMonthStr(new Date('2027-03-01T00:00:00Z')), '2026-01', '年份對不上資料年份 → 退回 2026-01');
// 對抗驗證 C（2026-10-29）：三個畫面的「本月」預設也不能再用本機 getMonth()
import fs from 'node:fs';
for (const f of ['modules/audit-ops/views/fill.js', 'modules/audit-ops/views/report.js', 'modules/audit-stock/views/report.js']) {
  const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.ok(!/getMonth\(\)/.test(src), f + ' 不能再用本機 getMonth()');
  assert.ok(/currentMonth\(/.test(src), f + ' 要用 fill-submit 的 currentMonth（台北）');
}
console.log('PASS: 稽核日期台北時間 8 項＋三個畫面不用本機月份（TZ=' + (process.env.TZ || '系統') + '）');
