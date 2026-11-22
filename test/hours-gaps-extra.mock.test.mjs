// test/hours-gaps-extra.mock.test.mjs —— 「工時沒人核」缺口提醒（StoreOps.gs storeHoursGaps_／attUpperGaps.hours_items）
// 要跟 ident 真正核定時用的可核名單一致（2026-11-22）。以前 att.extra 持有人只看個別例外 perm_ex，
// 靠 perm_map 規則拿到 att.extra 的人（例：執行長 hq／ceo）核得到的同仁會被誤報成「沒人核」。
// 這裡驗：perm_map 規則算、停用的規則不算、個別例外 add／remove 照算、兼任部門總監算、真的沒人核仍列、單位不同不算，
// 並且每一項都跟 ident（svcStoreWho 的 att.people）互相對照。全部假資料。
// 跑法：node test/hours-gaps-extra.mock.test.mjs
'use strict';
import { world, post } from './adv/_storeops_world.mjs';

let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }
const gapEmps = (app) => { const r = post(app.sb, 'attUpperGaps', {}, app.adminTok); return (r.data.hours_items || []).map((x) => x.emp).sort(); };
const ex = (app, emp, perm, mode) => post(app.sb, 'permExSave', { emp_no: emp, perm, mode: mode || 'add', until: '', note: '測試' }, app.adminTok);
const addRule = (app, id, ladder, dept, title, active) => app.sheets.perm_map._data.push([id, ladder, dept, title, 'att.extra', active === false ? 'FALSE' : 'TRUE', '', 'tester']);
const setRule = (app, id, active) => { const row = app.sheets.perm_map._data.find((r) => r[0] === id); row[5] = active ? 'TRUE' : 'FALSE'; };

// 總部：財務部有同仁沒有財務總監（要總監核）；執行長 DZY025（責任制職稱，不用核工時，只當 att.extra 持有人）；人資同仁 DZY021 後面當兼任財務總監
const CAST = [
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY021', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-16'],
  ['DZY023', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-18'],
  ['DZY025', '執行長', 'dzy-hq', 'mgmt', 'ceo', 'active', '2026-01-20'],
  ['DZY040', '小辛辣正職', 'mala-gf', '', 'ft', 'active', '2026-03-01'],   // mala-gf 沒有店長
  ['DZY041', '小辛辣計時', 'mala-gf', '', 'pt', 'active', '2026-03-02']
];

{
  const app = world(CAST);
  const base = gapEmps(app);
  ok(JSON.stringify(base) === JSON.stringify(['DZY023', 'DZY040', 'DZY041']), '1 基線：沒有任何 att.extra 時，財務同仁、無店長的兩人沒人核（執行長是責任制不用核）', base);
  ok(base.indexOf('DZY020') === -1 && base.indexOf('DZY021') === -1, '1 人資主管、人資同仁（人資部核定走人資主管）不列', base);

  // 2 perm_map 規則：hq／ceo 拿 att.extra → 執行長能核同單位（dzy-hq）所有要考勤的人，財務同仁有人核
  addRule(app, 'R900', 'hq', '', 'ceo');
  ok(app.subs('DZY025').indexOf('DZY023') !== -1, '2 ident：靠 perm_map 規則拿到 att.extra 的執行長，核定名單含 DZY023');
  const g2 = gapEmps(app);
  ok(g2.indexOf('DZY023') === -1, '2【修正】perm_map 的 att.extra 持有人核得到 DZY023 → 不列', g2);
  ok(g2.indexOf('DZY040') !== -1 && g2.indexOf('DZY041') !== -1, '2 別的單位沒人核的人仍列（單位不同不算）', g2);

  // 3 規則停用 → 又沒人核
  setRule(app, 'R900', false);
  ok(app.subs('DZY025').indexOf('DZY023') === -1, '3 ident：規則停用後 DZY023 不在核定名單');
  ok(gapEmps(app).indexOf('DZY023') !== -1, '3 停用的規則不算 → DZY023 又列入', gapEmps(app));

  // 4 規則在別的階梯／職稱（store／ft）：只管 mala-gf 的 DZY040 → DZY041 有人核；dzy-hq 不受影響
  addRule(app, 'R901', 'store', '', 'ft');
  const g4 = gapEmps(app);
  ok(app.subs('DZY040').indexOf('DZY041') !== -1, '4 ident：store／ft 的 att.extra 持有人 DZY040 核得到同單位 DZY041');
  ok(g4.indexOf('DZY041') === -1 && g4.indexOf('DZY040') !== -1, '4【修正】DZY041 不列、DZY040 本人（不核自己）仍列', g4);
  ok(g4.indexOf('DZY023') !== -1, '4 別單位的規則不影響總部：DZY023 仍列', g4);

  // 5 個別例外 remove 蓋掉 perm_map 規則 → 又沒人核
  setRule(app, 'R900', true);
  ok(gapEmps(app).indexOf('DZY023') === -1, '5 規則重新啟用 → DZY023 不列');
  ok(ex(app, 'DZY025', 'att.extra', 'remove').ok, '5 admin 對 DZY025 設 att.extra remove 例外');
  ok(app.subs('DZY025').indexOf('DZY023') === -1, '5 ident：remove 後 DZY023 不在核定名單');
  ok(gapEmps(app).indexOf('DZY023') !== -1, '5 remove 例外照算 → DZY023 又列入', gapEmps(app));
}

{
  // 6 個別例外 add（舊路徑）與兼任部門總監：行為不變
  const app = world(CAST);
  ok(gapEmps(app).indexOf('DZY023') !== -1, '6 基線 DZY023 列');
  ok(ex(app, 'DZY025', 'att.extra', 'add').ok, '6 admin 給 DZY025 att.extra（個別例外）');
  ok(gapEmps(app).indexOf('DZY023') === -1 && app.subs('DZY025').indexOf('DZY023') !== -1, '6 個別例外 add：DZY023 不列（與 ident 一致）', gapEmps(app));
  ok(ex(app, 'DZY025', 'att.extra', 'remove').ok, '6 再用 remove 蓋掉個別例外');
  ok(gapEmps(app).indexOf('DZY023') !== -1, '6 remove 蓋掉個別例外後 DZY023 又列入', gapEmps(app));
}

{
  // 7 兼任財務部總監（staff.extra_depts＝'fin:hm'）核得到財務同仁
  const app = world(CAST);
  const row = app.sheets.staff._data.find((r) => r[0] === 'DZY021');
  row[26] = 'fin:hm';
  const g = gapEmps(app);
  ok(app.subs('DZY021').indexOf('DZY023') !== -1, '7 ident：兼任財務部總監的 DZY021 核得到 DZY023');
  ok(g.indexOf('DZY023') === -1, '7 兼任部門總監核得到 → DZY023 不列', g);
}

console.log('\n通過 ' + passed + '／' + (passed + failed));
if (failed) process.exit(1);
