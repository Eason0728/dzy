// node test/att-unreach-1119.mock.test.mjs —— 2026-11-19 Eason：考勤驗收 11-10「有待辦卻沒人核得到」不符 2、6（管理系統這一側）
// 規則（白話）：
//   不符 2：同仁停用（離職）後第 1～7 天（離職日＝staff last_day；沒有就用 staff_log 最近一次停用那天），原本核他工時的人
//           （打卡店店長／廠長、人資主管、admin…）工時名單仍列他，那一筆多 last_day；申請名單、只看名單不列。第 8 天起不列。
//   不符 6：推算不出單位的人（單位／職稱空白、又沒有可推算的主店）一律進人資主管與 admin 的工時＋申請名單；其他人不多看到。
// 全部假資料（world() 的 BIG，假名假編號）。
import { world, post } from './adv/_storeops_world.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (detail !== undefined ? '\n   ' + JSON.stringify(detail) : '')); }
};
const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY = ymd(Date.now());
const daysAgo = (n) => ymd(Date.now() - n * 86400e3);

// 主角：DZY070 小辛辣光復計時（mala-gf），打卡帳號在光復（gf）
const LEFT = ['DZY070', '離職計時', 'mala-gf', '', 'pt', 'disabled', '2025-01-01'];
const CAST0 = [
  ['DZY042', '小辛辣店長', 'mala-gf', '', 'sm', 'active', '2026-03-03'],
  ['DZY001', '店長一', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY014', '小辛辣總監', 'mala-hq', '', 'odir', 'active', '2026-01-13'],
  ['DZY030', '已離職店長', 'mzt-gf', '', 'sm', 'disabled', '2026-01-23'],   // 很久以前停用、沒有離職日：照舊不列
  LEFT
];
const build = (lastDay, opts) => {
  opts = opts || {};
  const app = world(CAST0, {});
  const row = app.sheets.staff._data.find((r) => r[0] === 'DZY070');
  row[25] = lastDay || '';                                   // staff 第 26 欄＝last_day
  if (opts.log) app.sheets.staff_log._data.push([opts.log + ' 00:10:00', 'DZY070', 'disable', 'daily', '']);
  const sc = app.sheets.staff_clock._data.find((r) => r[0] === 'DZY070');
  if (opts.rosterOff) { sc[6] = 'FALSE'; sc[7] = opts.lastPunch || ''; }   // 名冊已停用（離職連動）、最後打卡日
  return app;
};
const rowOf = (app, sub, list) => ((app.ident(sub).att || {})[list || 'people'] || []).find((x) => x.sub === 'DZY070');
const who = (app, list) => ['DZY042', 'DZY001', 'DZY020', 'DZY014', 'U:a001'].filter((s) => !!rowOf(app, s, list));

// ── 不符 2：第 1、7 天在名單，第 8 天不在 ──
{
  const a1 = build(daysAgo(1));
  ok(JSON.stringify(who(a1)) === JSON.stringify(['DZY042', 'DZY020', 'U:a001']), '2-1 離職第 1 天：打卡店店長、人資主管、admin 的工時名單有他（別店店長、總監沒有）', who(a1));
  const r = rowOf(a1, 'DZY042');
  ok(!!r && r.last_day === daysAgo(1) && r.clock === 'gf', '2-2 那一筆帶 last_day＝離職日', r);
  ok(who(a1, 'req_people').length === 0, '2-3 申請名單不列（誰都沒有）', who(a1, 'req_people'));
  ok(who(a1, 'view_people').length === 0 && !rowOf(a1, 'U:a001', 'void_hours'), '2-4 只看名單不列', who(a1, 'view_people'));
  ok(!a1.subs('U:a001').includes('DZY030'), '2-5 很久以前停用、沒有離職日也沒有停用紀錄的人照舊不列');
  ok(a1.ident('DZY070').active === false, '2-6 離職的人本人照舊登不進營運系統（ident inactive）');
  const a7 = build(daysAgo(7));
  ok(JSON.stringify(who(a7)) === JSON.stringify(['DZY042', 'DZY020', 'U:a001']), '2-7 離職第 7 天：還在', who(a7));
  const a8 = build(daysAgo(8));
  ok(who(a8).length === 0, '2-8 離職第 8 天：誰的名單都沒有', who(a8));
  const a0 = build(TODAY);
  ok(JSON.stringify(who(a0)) === JSON.stringify(['DZY042', 'DZY020', 'U:a001']), '2-9 當天被提前停用（離職日＝今天）：也列，只能核到今天', who(a0));
  // 現行行為（2026-11-20 驗收員指出沒有測試；只記錄、不改判定規則）：停用、但離職日在未來（例如預約離職日、帳號先被停用）
  //   判定只比「離職日 ≥ 台北今天往前 7 天」，沒有「離職日 ≤ 今天」的下限 → 照列在工時名單（同離職第 1 天的那幾個人），那一筆 last_day＝那個未來的日期。
  //   營運系統後端是「只准核到 last_day（含）以前」，所以今天以前的日子（含今天）都核得到，不會因為還沒到離職日就被擋；申請名單、只看名單照樣不列。
  //   若要改成「離職日還沒到＝不列」是改判定規則，要 Eason 決定，這裡只守現行。
  const aFut = build(daysAgo(-3));
  ok(JSON.stringify(who(aFut)) === JSON.stringify(['DZY042', 'DZY020', 'U:a001']), '2-9b 停用但離職日在未來（3 天後）：照列（現行行為）', who(aFut));
  const rf = rowOf(aFut, 'DZY042');
  ok(!!rf && rf.last_day === daysAgo(-3) && rf.last_day > TODAY, '2-9c 那一筆 last_day＝未來的離職日（營運系統據此准核到今天、不是被擋）', rf);
  ok(who(aFut, 'req_people').length === 0 && who(aFut, 'view_people').length === 0, '2-9d 離職日在未來：申請名單、只看名單照樣不列', [who(aFut, 'req_people'), who(aFut, 'view_people')]);
}

// ── 離職日來源：沒有 last_day 用停用紀錄 ──
{
  const aNo = build('');
  ok(who(aNo).length === 0, '2-10 停用、沒有離職日也沒有停用紀錄：不列', who(aNo));
  const aLog = build('', { log: daysAgo(3) });
  const r = rowOf(aLog, 'DZY042');
  ok(!!r && r.last_day === daysAgo(3), '2-11 沒有 last_day、3 天前手動停用：列，last_day＝停用那天', r);
  const aOld = build('', { log: daysAgo(9) });
  ok(who(aOld).length === 0, '2-12 沒有 last_day、9 天前停用：不列', who(aOld));
  // 讀 log 的節省：staff 列 updated_at 早於 7 天前＝一定在 7 天外，不為他讀 log（log 寫 3 天前也不採信，因為停用一定會寫 updated_at）
  const aUpd = build('', { log: daysAgo(3) });
  aUpd.sheets.staff._data.find((r) => r[0] === 'DZY070')[20] = daysAgo(30) + ' 00:10:00';
  ok(who(aUpd).length === 0, '2-12b 沒有 last_day、staff 最後更新在 30 天前：不讀停用紀錄、不列', who(aUpd));
  const aUpd2 = build('', { log: daysAgo(3) });
  aUpd2.sheets.staff._data.find((r) => r[0] === 'DZY070')[20] = daysAgo(3) + ' 00:10:00';
  ok(!!rowOf(aUpd2, 'DZY042'), '2-12c staff 最後更新在 3 天前：照停用紀錄列');
}

// ── 名冊已停用（離職連動把打卡帳號停掉）──
{
  const aOff = build(daysAgo(2), { rosterOff: true, lastPunch: daysAgo(2) });
  ok(!!rowOf(aOff, 'DZY042'), '2-13 打卡名冊已停用、最後打卡就是離職日：照列（不然停用連動一跑完就核不到）');
  const aOld = build(daysAgo(2), { rosterOff: true, lastPunch: daysAgo(100) });
  ok(!rowOf(aOld, 'DZY042') && !rowOf(aOld, 'U:a001'), '2-14 名冊停用、最後打卡在離職日前 62 天以前（老早停掉的帳號）：不列');
}

// ── 純函式：其他呼叫端不受影響 ──
{
  const app = build(daysAgo(1));
  const org = app.sb.stfReadOrg_();
  const p = app.sb.storePeople_().find((x) => x.emp === 'DZY070');
  ok(app.sb.storeEffectiveTarget_(p, org, null) === null, '2-15 不給 leftCut（首頁缺核定人提醒、打卡保護名單…）照舊不列停用的人');
  const t = app.sb.storeEffectiveTarget_(p, org, null, app.sb.storeLeftCut_());
  ok(!!t && t.left === daysAgo(1) && t.status === 'active' && !t.notClaimed, '2-16 給 leftCut：照原身分列入、left＝離職日', t);
  ok(app.sb.storeLeftCut_('2026-11-19') === '2026-11-12', '2-17 storeLeftCut_：今天往前 7 天（11/19 → 11/12：11/12 離職的第 7 天還在）');
  ok(app.sb.storeLeftCut_('2026-12-03') === '2026-11-26', '2-18 跨月也對（12/3 → 11/26）');
  const gaps = app.sb.storeHoursGaps_(app.sb.storePeople_(), org, null, app.sb.clkMaps_(), app.sb.storeClockUnits_());
  ok(!gaps.some((g) => g.emp === 'DZY070'), '2-19 工時沒人核提醒不算離職的人');
}

// ── 考勤作廢（att.void）＝人資主管同一份：也帶 last_day ──
{
  const cast = CAST0.concat([['DZY021', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-16']]);
  const app = world(cast, {});
  app.sheets.staff._data.find((r) => r[0] === 'DZY070')[25] = daysAgo(1);
  post(app.sb, 'permExSave', { emp_no: 'DZY021', perm: 'att.void', mode: 'add', until: '', note: '考勤作廢' }, app.adminTok);
  const v = (app.ident('DZY021').att.void_hours || []).find((x) => x.sub === 'DZY070');
  const vr = (app.ident('DZY021').att.void_req || []).find((x) => x.sub === 'DZY070');
  ok(!!v && v.last_day === daysAgo(1) && !vr, '2-20 考勤作廢持有人：工時那份有他（帶 last_day）、申請那份沒有', { v, vr });
}

// ── 不符 6：沒單位的人 ──
{
  const cast = CAST0.filter((p) => p[0] !== 'DZY070').concat([
    ['DZY080', '沒單位主店總部', '', '', '', 'active', '2025-02-01'],
    ['DZY081', '沒單位只有支援', '', '', '', 'active', '2025-02-02']
  ]);
  const app = world(cast, {});
  const sc = app.sheets.staff_clock._data;
  sc.find((r) => r[0] === 'DZY080').splice(1, 3, 'hq', 'HQ080', 'home');
  sc.find((r) => r[0] === 'DZY081').splice(1, 3, 'gf', 'GF081', 'support');
  const lists = (sub, emp) => ['people', 'req_people'].map((k) => (app.ident(sub).att[k] || []).some((x) => x.sub === emp));
  for (const emp of ['DZY080', 'DZY081']) {
    ok(JSON.stringify(lists('DZY020', emp)) === '[true,true]', '6-' + emp + ' 人資主管：工時＋申請都有');
    ok(JSON.stringify(lists('U:a001', emp)) === '[true,true]', '6-' + emp + ' admin：工時＋申請都有');
    ok(JSON.stringify(lists('DZY042', emp)) === '[false,false]' && JSON.stringify(lists('DZY014', emp)) === '[false,false]', '6-' + emp + ' 店長、總監不因此多看到');
  }
  // 試點不含打卡店也不含主店 → 營運系統讀不到，不列
  const app2 = world(cast, { pilot: 'mzt-gf' });
  app2.sheets.staff_clock._data.find((r) => r[0] === 'DZY081').splice(1, 3, 'gf', 'GF081', 'support');
  ok(!(app2.ident('U:a001').att.people || []).some((x) => x.sub === 'DZY081'), '6-3 打卡店不在試點：不列（照舊）');
}

console.log(`\n${fail ? '有失敗' : '全部測試通過'}，共 ${pass + fail} 項（失敗 ${fail}）`);
process.exit(fail ? 1 : 0);
