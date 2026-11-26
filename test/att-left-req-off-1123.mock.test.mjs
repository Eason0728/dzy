// node test/att-left-req-off-1123.mock.test.mjs —— 2026-11-23 Codex 第三輪擋項 B：att.left_req 不能比「在職時的申請名單」寬
// 規則（白話）：
//   ‧left_req＝離職同仁裡，這個人「在職時的申請名單」本來就審得到的打卡帳號。在職時，名冊已停用（roster_active=FALSE）的帳號一律不在申請名單
//     （近 62 天停用＝標 off、只進工時名單給同仁異動；更早停用＝整個不列）——離職後同一個帳號也不能因此進 left_req。
//   ‧怎麼分「在職時就停用」與「離職時才停用」：打卡對照列的 updated_at（停用時會寫入；同 off 判斷用的同一欄）。
//     名冊停用、updated_at 的日期早於離職日（或空白）＝在職時就停用＝不進 left_req；updated_at 在離職日（含）以後＝離職時／之後才停用＝照列。名冊在職（TRUE／空白）照舊。
//   ‧工時那兩份（7 天內的 people、離職超過 7 天的 past_people）照主管裁示「停用也顯示、可核」不跟著收緊。
// 手算對照（今天 T）：E＝DZY082 小辛辣光復計時，主帳號 GF082、第二帳號 GF082B（名冊停用、最後打卡 T−20、updated_at T−15）
//   在職：店長 req_people 有 GF082、沒有 GF082B｜離職日 T−3、主帳號離職當天才停用（updated_at T−2）：left_req＝GF082（不含 GF082B），people（7 天）兩個都有
//   離職日 T−10（past）、主帳號 updated_at T−9：left_req＝GF082；past_people 兩個都有｜離職日 T−3、主帳號還沒停用（TRUE）：left_req＝GF082
//   界線：GF082B 的 updated_at＝離職日當天（T−3）→ 照列（離職當天停用＝離職時才停用）；updated_at 空白 → 不列（查不到停用時間，保守）
// 全部假資料（假名假編號）。
import { world } from './adv/_storeops_world.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (detail !== undefined ? '\n   ' + JSON.stringify(detail) : '')); }
};
const J = (v) => JSON.stringify(v);
const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => ymd(Date.now() - n * 86400e3);

const CAST = [
  ['DZY042', '小辛辣店長', 'mala-gf', '', 'sm', 'active', '2026-03-03'],
  ['DZY041', '小辛辣計時', 'mala-gf', '', 'pt', 'active', '2026-03-02'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY082', '雙帳號計時', 'mala-gf', '', 'pt', 'active', '2025-02-01']
];
// o：{ left: 離職日或 ''（在職）, mainOff: 主帳號停用那天或 ''（名冊在職）, bUpd: 第二帳號 updated_at 的日期（'' 空白） }
function build(o) {
  const cast = CAST.map((r) => (r[0] === 'DZY082' && o.left ? r.slice(0, 5).concat(['disabled', r[6]]) : r));
  const app = world(cast, {});
  const st = app.sheets.staff._data.find((r) => r[0] === 'DZY082');
  const sc = app.sheets.staff_clock._data.find((r) => r[0] === 'DZY082');
  if (o.left) st[25] = o.left;
  if (o.mainOff) { sc[6] = 'FALSE'; sc[7] = o.left || ''; sc[10] = o.mainOff + ' 00:10:00'; }
  else sc[7] = daysAgo(1);
  app.sheets.staff_clock._data.push(['DZY082', sc[1], sc[2] + 'B', 'staff', 'confirmed', 'created', 'FALSE', daysAgo(20), 'tester', '', o.bUpd === '' ? '' : (o.bUpd || daysAgo(15)) + ' 10:00:00']);
  app.props.ATT_PAST_ON = '1';
  return app;
}
const ident = (app, sub) => { app.sb.regionCtxReset_(); const r = app.who(sub); return r.ok ? r.data : r; };
const eids = (rows) => (rows || []).filter((x) => x.sub === 'DZY082').map((x) => x.emp_id).sort();

// (1) 在職：店長申請名單有主帳號、沒有停用的第二帳號（基準）
const IN = ident(build({ left: '' }), 'DZY042');
ok(J(eids(IN.att.req_people)) === J(['GF082']), 'B-1 在職：店長 req_people 只有 GF082（GF082B 名冊停用＝不在申請名單）', eids(IN.att.req_people));
ok(eids(IN.att.left_req).length === 0, 'B-1b 在職：left_req 沒有他');

// (2) 離職 3 天（7 天內），主帳號離職隔天才停用：left_req 跟在職時的申請名單同一批帳號
{
  const app = build({ left: daysAgo(3), mainOff: daysAgo(2) });
  const id = ident(app, 'DZY042');
  ok(J(eids(id.att.left_req)) === J(eids(IN.att.req_people)), 'B-2 離職 3 天：店長 left_req＝在職時 req_people 的帳號（GF082，不含在職時就停用的 GF082B）', { left_req: eids(id.att.left_req), in_service: eids(IN.att.req_people) });
  ok(J(eids(id.att.people)) === J(['GF082', 'GF082B']), 'B-2b 工時那份（7 天內 people）照主管裁示兩個帳號都列（停用也顯示、可核）', eids(id.att.people));
  const hr = ident(app, 'DZY020');
  ok(J(eids(hr.att.left_req)) === J(['GF082']), 'B-2c 人資主管的 left_req 也不含 GF082B', eids(hr.att.left_req));
}
// (3) 離職 10 天（past），主帳號離職隔天停用
{
  const app = build({ left: daysAgo(10), mainOff: daysAgo(9) });
  const id = ident(app, 'DZY042');
  ok(J(eids(id.att.left_req)) === J(['GF082']), 'B-3 離職 10 天：left_req＝GF082（不含 GF082B）', eids(id.att.left_req));
  ok(J(eids(id.att.past_people)) === J(['GF082', 'GF082B']) && id.att.past_people.filter((x) => x.sub === 'DZY082').every((x) => x.can_approve === true), 'B-3b 工時那份（past_people）照主管裁示兩個帳號都列、can_approve', id.att.past_people.filter((x) => x.sub === 'DZY082'));
}
// (4) 離職 3 天、主帳號還沒停用（停用單還沒跑）：照列
{
  const id = ident(build({ left: daysAgo(3), mainOff: '' }), 'DZY042');
  ok(J(eids(id.att.left_req)) === J(['GF082']), 'B-4 主帳號名冊仍在職：left_req 照列 GF082（GF082B 照不列）', eids(id.att.left_req));
}
// (5) 界線
{
  const id = ident(build({ left: daysAgo(3), mainOff: daysAgo(2), bUpd: daysAgo(3) }), 'DZY042');
  ok(J(eids(id.att.left_req)) === J(['GF082', 'GF082B']), 'B-5 GF082B 的 updated_at＝離職日當天：算離職時才停用 → 照列', eids(id.att.left_req));
  const id2 = ident(build({ left: daysAgo(3), mainOff: daysAgo(2), bUpd: '' }), 'DZY042');
  ok(J(eids(id2.att.left_req)) === J(['GF082']), 'B-5b GF082B 名冊停用、updated_at 空白：查不到停用時間 → 不列（保守）', eids(id2.att.left_req));
  const id3 = ident(build({ left: daysAgo(3), mainOff: daysAgo(4) }), 'DZY042');
  ok(eids(id3.att.left_req).length === 0, 'B-5c 主帳號在離職日前一天就停用（在職時已不在申請名單）→ 離職後也不列', eids(id3.att.left_req));
}

console.log(`\n${fail ? '有失敗' : '全部測試通過'}，共 ${pass + fail} 項（失敗 ${fail}）`);
process.exit(fail ? 1 : 0);
