// node test/adv/fix_taipei_month.mjs —— 對抗驗證 ⑤「稽核本月改台北時間」
// 攻擊：UTC 月底 16:00～23:59（台北已跨月）、台北 00:00～08:00 月初（UTC 還在上月）、跨年、傳 undefined。
// 用 TZ 環境變數跑三次（UTC／America/Los_Angeles／Asia/Taipei）結果要一致——由 shell 迴圈負責，見檔尾。
'use strict';
import { currentMonthStr } from '../../modules/audit-stock/index.js';
import { currentMonth, todayStr } from '../../modules/audit-stock/views/fill-submit.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const T = (s) => new Date(s);
ok(currentMonth(T('2026-10-31T16:00:00Z')) === '2026-11', 'UTC 10/31 16:00 ＝台北 11/1 00:00 → 2026-11', currentMonth(T('2026-10-31T16:00:00Z')));
ok(currentMonth(T('2026-10-31T15:59:59Z')) === '2026-10', 'UTC 10/31 15:59 ＝台北 10/31 23:59 → 2026-10');
ok(currentMonth(T('2026-12-31T16:00:00Z')) === '2027-01', '跨年 → 2027-01');
ok(currentMonthStr(T('2026-12-31T16:00:00Z')) === '2026-01', 'index.js：台北已 2027 → 退回 2026-01（資料年份守門）');
ok(currentMonthStr(T('2026-10-31T16:00:00Z')) === '2026-11', 'index.js：台北 11/1 → 2026-11');
ok(currentMonthStr(T('2025-12-31T16:00:00Z')) === '2026-01', 'index.js：台北 2026/1/1 00:00 → 2026-01');
ok(/^\d{4}-\d{2}$/.test(currentMonth()) && /^\d{4}-\d{2}$/.test(currentMonthStr()), '不傳參數也能用');
ok(currentMonth(T('2026-10-31T16:00:00Z')) === todayStr(T('2026-10-31T16:00:00Z')).slice(0, 7), 'currentMonth 與 todayStr 同一天同一月');

console.log(`fix_taipei_month[TZ=${process.env.TZ || 'local'}]: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
// 跑法：for tz in UTC America/Los_Angeles Asia/Taipei Pacific/Kiritimati; do TZ=$tz node test/adv/fix_taipei_month.mjs; done
