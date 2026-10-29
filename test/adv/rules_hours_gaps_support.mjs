// node test/adv/rules_hours_gaps_support.mjs —— 對抗驗證 2026-10-30 規則 2「工時沒人核提醒」（StoreOps.gs storeHoursGaps_／attUpperGaps.hours_items）
// 與規則 3「推算者支援」（storeAttIsSupport_ 對 inferred 套支援規則）。
// 規則 2 攻擊：誰看得到（店長有 platform.att 也不能看）、att.extra 例外核定人在表上其實核得到卻被列成「沒人核」（誤報）、
//            兼任店長算不算核定人、hr_only 財務部不列、支援帳號看打卡店四層。
// 規則 3 攻擊：推算者到非主店打卡 → 打卡店店長核、主店店長只看；orphan 不變；主店 role 標錯店時誰核；非試點店的帳號消失。
'use strict';
import { world, post } from './_storeops_world.mjs';

let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }
const sorted = (a) => a.slice().sort();
const ex = (app, emp, perm, mode) => post(app.sb, 'permExSave', { emp_no: emp, perm, mode: mode || 'add', until: '', note: '對抗測試' }, app.adminTok);
const gaps = (app, tok) => post(app.sb, 'attUpperGaps', {}, tok);
const hoursEmps = (r) => sorted((r.data.hours_items || []).map((x) => x.emp));

// ── 規則 2 ──────────────────────────────────────────────
const CAST2 = [
  ['DZY001', '店長一', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY003', '李計時', 'mzt-gf', '', 'pt', 'active', '2026-02-02'],
  ['DZY005', '別店計時', 'mzt-js', '', 'pt', 'active', '2026-02-03'],     // mzt-js 沒有店長
  ['DZY010', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-09'],
  ['DZY013', '墨竹亭行政', 'mzt-hq', '', 'ofs', 'active', '2026-01-12'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY021', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-16'],
  ['DZY023', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-18'],   // hr_only：不列
  ['DZY024', '管理部同仁', 'dzy-hq', 'mgmt', 'hs', 'active', '2026-01-19'],   // 要執行長以上核；本劇本沒有 → 應列
  ['DZY040', '額外核定人', 'mala-gf', '', 'ft', 'active', '2026-03-01'],   // 待會給 att.extra
  ['DZY041', '小辛辣計時', 'mala-gf', '', 'pt', 'active', '2026-03-02']    // mala-gf 沒有店長
];
{
  const app = world(CAST2);
  // 誰看得到
  const smTok = app.login('DZY001');
  const g0 = gaps(app, smTok);
  ok(g0.ok && g0.data.items.length === 0 && g0.data.hours_items === undefined, '2a 店長（有 platform.att）打 attUpperGaps 回空、沒有 hours_items', g0);
  const hrTok = app.login('DZY020');
  const gH = gaps(app, hrTok), gA = gaps(app, app.adminTok);
  ok(gH.ok && Array.isArray(gH.data.hours_items) && JSON.stringify(hoursEmps(gH)) === JSON.stringify(hoursEmps(gA)), '2b 人資主管看到的 hours_items 同 admin', { hr: hoursEmps(gH), admin: hoursEmps(gA) });
  // 名單基線：mzt-js 沒店長→DZY005；mala-gf 沒店長→DZY040、DZY041；管理部同仁沒執行長→DZY024；財務 hr_only 不列；mzt-hq 行政有總監→不列；人資同仁有人資主管→不列
  ok(JSON.stringify(hoursEmps(gA)) === JSON.stringify(['DZY005', 'DZY024', 'DZY040', 'DZY041']), '2c 基線名單', hoursEmps(gA));
  ok(hoursEmps(gA).indexOf('DZY023') === -1, '2d 財務部（hr_only）不列');
  // att.extra：DZY040 拿 att.extra → 他能核同單位 DZY041 的工時（storeAttTargets_ 的例外路徑）→ DZY041 不該再列；DZY040 自己仍沒人核（例外不能核自己）→ 仍列
  ok(ex(app, 'DZY040', 'att.extra').ok, '2e admin 給 DZY040 att.extra');
  ok(app.subs('DZY040').indexOf('DZY041') !== -1, '2f att.extra 持有人的核定名單確實含 DZY041（表上核得到）');
  const g1 = hoursEmps(gaps(app, app.adminTok));
  ok(g1.indexOf('DZY041') === -1, '【誤報】2g DZY041 有 att.extra 同事能核工時，不該列進「沒人核」', g1);
  ok(g1.indexOf('DZY040') !== -1, '2h att.extra 持有人自己仍沒人核 → 列');
  // 兼任店長：DZY001 兼任 mzt-js 店長 → DZY005 有人核 → 不列
  const acting = ex(app, 'DZY001', 'store.sm@mzt-js');
  ok(acting.ok, '2i admin 設 DZY001 兼任 mzt-js 店長', acting);
  const g2 = hoursEmps(gaps(app, app.adminTok));
  ok(g2.indexOf('DZY005') === -1, '2j 兼任店長算核定人 → DZY005 不列', g2);
  // 支援帳號：DZY003 到 mztjs 打卡（支援）→ 打卡店四層：L1 兼任店長 DZY001 → 有人核；拿掉兼任 → L2 無、L3 區域關、L4 總監 DZY010 → 仍有人核
  app.sheets.staff_clock._data.push(['DZY003', 'mztjs', 'MZTJS003S', 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  ok(hoursEmps(gaps(app, app.adminTok)).indexOf('DZY003') === -1, '2k 支援帳號有打卡店四層核定人 → 不列');
  // 把總監停用、兼任撤掉 → mzt-js 四層全空 → DZY003（支援帳號）與 DZY005 都列
  const rv = post(app.sb, 'permExRevoke', { ex_id: acting.data.ex_id }, app.adminTok);
  ok(rv.ok, '2l 撤銷兼任', rv);
  const iDir = app.sheets.staff._data.findIndex((r) => r[0] === 'DZY010');
  app.sheets.staff._data[iDir][3] = 'disabled';
  const g3 = hoursEmps(gaps(app, app.adminTok));
  ok(g3.indexOf('DZY003') !== -1 && g3.indexOf('DZY005') !== -1, '2l 打卡店四層全空 → 支援帳號主人與該店計時都列', g3);
  // 停用單位：mzt-js 停用 → 那裡的人身分無效（storeOrgOf_ null）→ 不列（只是記錄行為：這些人其實也沒人核，但走「沒有對照」那條提醒）
  const iU = app.sheets.org._data.findIndex((r) => r[0] === 'unit' && r[1] === 'mzt-js');
  const keep = app.sheets.org._data[iU][7];
  app.sheets.org._data[iU][7] = 'FALSE';
  const g4 = hoursEmps(gaps(app, app.adminTok));
  ok(g4.indexOf('DZY005') === -1, '2m 單位停用 → 該單位同仁不列（身分無效走別條提醒）', g4);
  app.sheets.org._data[iU][7] = keep;
}

// ── 規則 3 ──────────────────────────────────────────────
const CAST3 = [
  ['DZY001', '店長一', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY004', '店長二', 'mzt-js', '', 'sm', 'active', '2026-01-06'],
  ['DZY010', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-09'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY050', '推算者', 'mzt-gf', '', 'pt', 'active', '2026-04-01'],   // 待會把單位、職稱清空，變成要推算的人
  ['DZY051', '孤兒', 'mzt-gf', '', 'pt', 'active', '2026-04-02']     // 清空且沒有 home 對照 → orphan
];
function world3(opts) {
  const app = world(CAST3, opts);
  for (const emp of ['DZY050', 'DZY051']) {
    const i = app.sheets.staff._data.findIndex((r) => r[0] === emp);
    app.sheets.staff._data[i][5] = ''; app.sheets.staff._data[i][7] = '';
  }
  // 重做兩人的打卡對照
  const d = app.sheets.staff_clock._data;   // 要就地改（sheet 閉包抓的是同一個陣列）
  for (let i = d.length - 1; i > 0; i--) if (d[i][0] === 'DZY050' || d[i][0] === 'DZY051') d.splice(i, 1);
  const row = (emp, store, eid, role) => [emp, store, eid, role, 'confirmed', 'created', 'TRUE', '', 'tester', '', ''];
  app.sheets.staff_clock._data.push(row('DZY050', 'mztgf', 'MZTGF050', opts && opts.homeAt === 'mztjs' ? 'staff' : 'home'));
  app.sheets.staff_clock._data.push(row('DZY050', 'mztjs', 'MZTJS050', opts && opts.homeAt === 'mztjs' ? 'home' : 'staff'));
  app.sheets.staff_clock._data.push(row('DZY051', 'mztgf', 'MZTGF051', 'staff'));
  app.sheets.staff_clock._data.push(row('DZY051', 'mztjs', 'MZTJS051', 'staff'));
  return app;
}
const acc = (list, emp) => list.filter((x) => x.sub === emp).map((x) => x.clock + (x.support ? '*' : '')).sort();
{
  const app = world3();
  const gf = app.ident('DZY001'), js = app.ident('DZY004'), hr = app.ident('DZY020'), dir = app.ident('DZY010');
  ok(JSON.stringify(acc(gf.att.people, 'DZY050')) === JSON.stringify(['mztgf']), '3a 主店（推算 mzt-gf）店長：核主店帳號', acc(gf.att.people, 'DZY050'));
  ok(JSON.stringify(acc(gf.att.view_people, 'DZY050')) === JSON.stringify(['mztjs*']), '3b 主店店長：mztjs 的支援帳號只看', acc(gf.att.view_people, 'DZY050'));
  ok(JSON.stringify(acc(js.att.people, 'DZY050')) === JSON.stringify(['mztjs*']), '3c 打卡店（mzt-js）店長：核支援帳號', acc(js.att.people, 'DZY050'));
  ok(acc(js.att.people, 'DZY050').indexOf('mztgf') === -1 && acc(js.att.view_people, 'DZY050').length === 0, '3d 打卡店店長核不到、也看不到主店帳號');
  const h50 = js.att.people.find((x) => x.sub === 'DZY050');
  ok(h50 && h50.support === true && h50.home_unit === 'mzt-gf', '3e 支援帳號標 home_unit＝推算出的主店單位', h50);
  ok(JSON.stringify(acc(hr.att.people, 'DZY050')) === JSON.stringify(['mztgf', 'mztjs*']), '3f 人資主管兩個帳號都核');
  // orphan 不變：只有人資主管／admin
  ok(acc(gf.att.people, 'DZY051').length === 0 && acc(js.att.people, 'DZY051').length === 0 && acc(gf.att.view_people, 'DZY051').length === 0, '3g orphan：兩位店長都核不到、看不到');
  ok(acc(hr.att.people, 'DZY051').every((c) => !c.endsWith('*')), '3h orphan：帳號都不算支援（沒 home 的 orphan 本來就 pilotUnits=[]，連人資主管名單也不列——規則 3 之前就如此）', acc(hr.att.people, 'DZY051'));
  ok(acc(dir.att.people, 'DZY050').length === 0, '3i 總監不核（有店長在）');
  // 工時沒人核提醒：推算者不列（另有提醒）
  ok(hoursEmps(gaps(app, app.adminTok)).indexOf('DZY050') === -1, '3j 推算者不進 hours_items');
}
// 主店 role 標錯店：home 在 mztjs、staff 在 mztgf → 推算成 mzt-js 的人；mztgf 帳號變支援 → 由 mzt-gf 店長核（打卡店主管），mzt-js 店長核 mztjs 帳號、只看 mztgf
{
  const app = world3({ homeAt: 'mztjs' });
  const gf = app.ident('DZY001'), js = app.ident('DZY004');
  ok(JSON.stringify(acc(gf.att.people, 'DZY050')) === JSON.stringify(['mztgf*']), '3k home 標錯店：mzt-gf 店長仍核 mztgf 帳號（當支援）', acc(gf.att.people, 'DZY050'));
  ok(JSON.stringify(acc(js.att.people, 'DZY050')) === JSON.stringify(['mztjs']) && JSON.stringify(acc(js.att.view_people, 'DZY050')) === JSON.stringify(['mztgf*']), '3l home 標錯店：mzt-js 店長核 mztjs、只看 mztgf', { p: acc(js.att.people, 'DZY050'), v: acc(js.att.view_people, 'DZY050') });
  // 不管 home 標在哪，每家店的店長都核得到自己店的帳號、沒有不相干店長核到人
  ok(acc(gf.att.people, 'DZY050').every((c) => c.startsWith('mztgf')) && acc(js.att.people, 'DZY050').every((c) => c.startsWith('mztjs')), '3m 沒有不相干店長核到人');
}
// 非試點店：mzt-js 不在試點 → 推算者在 mztjs 的帳號（改成支援）從所有人名單消失（之前非支援時主店店長靠 pilotUnits 看得到）
{
  const app = world3({ pilot: 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq' });
  const gf = app.ident('DZY001'), hr = app.ident('DZY020'), adm = app.ident('U:a001');
  const everyone = [gf.att.people, gf.att.view_people, hr.att.people, adm.att.people].map((l) => acc(l, 'DZY050'));
  ok(everyone.some((l) => l.indexOf('mztjs*') !== -1 || l.indexOf('mztjs') !== -1), '【疑慮】3n 非試點店的支援帳號：推算者的 mztjs 帳號應至少有人（人資主管／admin）核得到', everyone);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
