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
console.log('PASS: 稽核日期台北時間 5 項（TZ=' + (process.env.TZ || '系統') + '）');
