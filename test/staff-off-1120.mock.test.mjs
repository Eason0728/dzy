// node test/staff-off-1120.mock.test.mjs —— 2026-11-20 Eason「要改」：停用過夜後營運系統看不到人（管理系統這一側）
// 改前：人還在職、但某個打卡帳號在打卡名冊是停用（店端「同仁異動→設為離職」，或管理系統「復職」時沒勾那家）→ 每晚 00:10 名冊同步把
//       staff_clock.roster_active 寫成 FALSE 之後，ident 三份名單一律不送這個帳號 → 營運系統「同仁異動」的已離職清單找不到他、「恢復在職」按了被擋。
//       （實例：李蔓晴 11/20 01:20 復職時兩家都沒勾 → 總部、金山兩個帳號都 roster_active=FALSE → 營運系統同仁異動恢復不了，只能回管理系統停用再復職。）
// 改後：在職者、名冊停用、帳號列 updated_at 或最後打卡在 62 天內 → 原本核他工時的人「工時名單」照列這個帳號（不帶 last_day）；申請、只看名單不列。
// 全部假資料（假名假編號）。
import { world } from './adv/_storeops_world.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (detail !== undefined ? '\n   ' + JSON.stringify(detail) : '')); }
};
const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY = ymd(Date.now());
const daysAgo = (n) => ymd(Date.now() - n * 86400e3);

// 主角 DZY090：總部人資部一般同仁（HQ 主帳號）＋金山支援帳號（同李蔓晴的組合，假名）
const CAST = [
  ['DZY004', '金山店長', 'mzt-js', '', 'sm', 'active', '2026-01-06'],
  ['DZY001', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY010', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-09'],
  ['DZY090', '總部兼金山', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-20']
];
const WHO = ['DZY004', 'DZY001', 'DZY020', 'DZY010', 'U:a001'];
const build = (o) => {
  o = o || {};
  const app = world(CAST, {});
  const sc = app.sheets.staff_clock._data;
  const home = sc.find((r) => r[0] === 'DZY090');
  home.splice(1, 3, 'hq', 'HQ90', 'home');
  sc.push(['DZY090', 'mztjs', 'MZTJS90', 'support', o.supState || 'confirmed', 'name_match', 'TRUE', '', 'tester', '', '']);
  const sup = sc[sc.length - 1];
  const setOff = (r, upd, punch) => { r[6] = 'FALSE'; r[7] = punch || ''; r[10] = upd === undefined ? TODAY + ' 00:10:05' : upd; };
  if (o.homeOff) setOff(home, o.homeUpd, o.homePunch);
  if (o.supOff) setOff(sup, o.supUpd, o.supPunch);
  if (o.disabled) {
    const row = app.sheets.staff._data.find((r) => r[0] === 'DZY090');
    row[3] = 'disabled';
    app.sheets.staff_log._data.push([o.disabled + ' 19:50:57', 'DZY090', 'disable', 'u001', '']);
  }
  return app;
};
const rowOf = (app, sub, eid, list) => ((app.ident(sub).att || {})[list || 'people'] || []).find((x) => x.emp_id === eid);
const who = (app, eid, list) => WHO.filter((s) => !!rowOf(app, s, eid, list));
const J = JSON.stringify;

// ── 對照組：兩個帳號都在職 ──
{
  const a = build();
  ok(J(who(a, 'HQ90')) === J(['DZY020', 'U:a001']), 'L0a 對照組：總部帳號在人資主管、admin 的工時名單', who(a, 'HQ90'));
  ok(J(who(a, 'MZTJS90')) === J(['DZY004', 'DZY020', 'U:a001']), 'L0b 對照組：金山支援帳號在金山店長（＋人資主管、admin）的工時名單', who(a, 'MZTJS90'));
}

// ── 李蔓晴案例：復職時兩家都沒勾（人在職、兩個帳號 roster_active=FALSE，今天才變停用）──
{
  const a = build({ homeOff: true, supOff: true });
  ok(J(who(a, 'HQ90')) === J(['DZY020', 'U:a001']), 'L1a 總部帳號名冊停用：人資主管、admin 工時名單照列（改前誰都沒有）', who(a, 'HQ90'));
  ok(J(who(a, 'MZTJS90')) === J(['DZY004', 'DZY020', 'U:a001']), 'L1b 金山帳號名冊停用：金山店長照列 → 同仁異動找得到、能恢復在職', who(a, 'MZTJS90'));
  const r = rowOf(a, 'DZY004', 'MZTJS90');
  ok(!!r && r.last_day === undefined && r.support === true, 'L1c 那一筆不帶 last_day（人沒離職，營運系統不擋恢復在職）、照樣標支援', r);
  ok(who(a, 'HQ90', 'req_people').length === 0 && who(a, 'MZTJS90', 'req_people').length === 0, 'L1d 申請名單不列（被設離職的帳號只為了找得到、能恢復）');
  ok(who(a, 'HQ90', 'view_people').length === 0 && who(a, 'MZTJS90', 'view_people').length === 0, 'L1e 只看名單不列');
  const own = (a.ident('DZY090').own_clocks || []).map((x) => x.emp_id);
  ok(!own.includes('HQ90') && !own.includes('MZTJS90'), 'L1f 本人的 own_clocks 照舊不含名冊停用的帳號（只改核定人那邊）', own);
}

// ── 店端「設為離職」一個帳號，另一個照常 ──
{
  const a = build({ supOff: true, supUpd: daysAgo(1) + ' 00:10:05' });
  ok(J(who(a, 'MZTJS90')) === J(['DZY004', 'DZY020', 'U:a001']), 'L2a 金山店長昨天設離職、過夜同步後：金山店長工時名單照列', who(a, 'MZTJS90'));
  ok(!!rowOf(a, 'DZY020', 'HQ90') && !!rowOf(a, 'DZY020', 'HQ90', 'req_people'), 'L2b 另一個在職帳號完全照舊（工時＋申請）');
}

// ── 期限：很久以前停掉的舊帳號不列 ──
{
  const a = build({ supOff: true, supUpd: daysAgo(70) + ' 00:10:05' });
  ok(who(a, 'MZTJS90').length === 0, 'L3a 名冊停用、帳號列 70 天沒動、沒打卡紀錄：不列', who(a, 'MZTJS90'));
  const b = build({ supOff: true, supUpd: daysAgo(70) + ' 00:10:05', supPunch: daysAgo(10) });
  ok(J(who(b, 'MZTJS90')) === J(['DZY004', 'DZY020', 'U:a001']), 'L3b 帳號列很久沒動、但 10 天前還有打卡：列', who(b, 'MZTJS90'));
  const c = build({ supOff: true, supUpd: daysAgo(62) + ' 00:10:05' });
  ok(J(who(c, 'MZTJS90')) === J(['DZY004', 'DZY020', 'U:a001']), 'L3c 第 62 天還在', who(c, 'MZTJS90'));
  const d = build({ supOff: true, supUpd: daysAgo(63) + ' 00:10:05' });
  ok(who(d, 'MZTJS90').length === 0, 'L3d 第 63 天不列', who(d, 'MZTJS90'));
}

// ── 被店端移除的首次支援（state=rejected）照舊不列：店端恢復也會被每晚對帳停掉，要回管理系統打卡對照處理 ──
{
  const a = build({ supOff: true, supState: 'rejected' });
  ok(who(a, 'MZTJS90').length === 0, 'L4 rejected 的支援對照：照舊不列', who(a, 'MZTJS90'));
}

// ── 管理系統停用（今天停用、沒有離職日）：走離職 7 天內，帶 last_day（營運系統顯示「到管理系統復職」）──
{
  const a = build({ disabled: TODAY, homeOff: true, supOff: true });
  const r = rowOf(a, 'DZY004', 'MZTJS90');
  ok(!!r && r.last_day === TODAY, 'L5a 管理系統停用的人：金山店長名單有、帶 last_day＝停用那天', r);
  ok(a.ident('DZY090').active === false, 'L5b 本人照舊登不進營運系統');
  const b = build({ disabled: daysAgo(8), homeOff: true, supOff: true });
  ok(who(b, 'MZTJS90').length === 0 && who(b, 'HQ90').length === 0, 'L5c 停用第 8 天：不列（照 11-19 規則；復職要在管理系統）');
}

console.log(fail ? `有失敗，共 ${pass + fail} 項（失敗 ${fail}）` : `全部測試通過，共 ${pass} 項（失敗 0）`);
process.exit(fail ? 1 : 0);
