// node test/att-past-1122.mock.test.mjs —— 2026-11-22 Eason 裁示「核定過的人紀錄都要顯示在當天，跟有沒有離職應該不影響」（管理系統這一側）
// 規則（白話）：
//   ‧開關：Script Property ATT_PAST_ON 恰好是字串 '1' 才開；沒設、空白、'on'、'true'、全形１、前後帶空白…一律當關。
//     關著：ident 不出現 att.past_people，整份 ident 跟改前（64b7828）逐位元組相同。
//   ‧開著：每份 ident 的 att 最後多 past_people（陣列，可能空）＝停用（離職）、離職日早於 7 天界線（storeLeftCut_：台北今天往前 7 天）的人，
//     由「照今天的組織、本來會核他工時」的人拿到（工時名單同一條 apprH：打卡店店長／廠長、人資主管、admin、att.extra），
//     考勤作廢持有人照 void_hours 的算法也拿到；申請名單、只看名單（督導、總監）、別店店長不給。每筆形狀同 people、一定帶 last_day。
//     離職日＝last_day（≤ 今天）；沒有或在未來＝最近一次停用紀錄那天；都沒有＝不列。不設期限。
//   ‧原有 people／req_people／view_people／void_hours／void_req 一筆都不變；7 天內的人照舊在 people，不會同時在 past_people。
// 手算對照（今天 T；界線 C＝T−7）：
//   離職日 T−7 → 7 天名單（last_day T−7），不在 past｜T−8 → past（last_day T−8），不在 7 天名單｜
//   沒 last_day、停用紀錄 T−30 → past（last_day T−30）｜last_day T+5、停用紀錄 T−12 → past（last_day T−12，停用優先）｜
//   沒 last_day 也沒停用紀錄 → 都不列｜沒有打卡帳號、帳號被退回 → 都不列｜last_day 2025-06-30（很久以前）→ past（不設期限）
// 全部假資料（假名假編號）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { world, post } from './adv/_storeops_world.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'platform', 'StoreOps.gs'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'dzy-store-contract-v2.json'), 'utf8'));
const BASE_REF = '64b7828';   // 改動前的 origin/main（2026-11-22）：關著開關時的 ident 要跟這版逐位元組相同
let OLD_SRC = null;
try { OLD_SRC = execFileSync('git', ['show', BASE_REF + ':apps-script/platform/StoreOps.gs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); } catch (e) { OLD_SRC = null; }

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (detail !== undefined ? '\n   ' + JSON.stringify(detail) : '')); }
};
const J = (v) => JSON.stringify(v);
const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => ymd(Date.now() - n * 86400e3);
const CUT = daysAgo(7);

const CAST = [
  ['DZY042', '小辛辣店長', 'mala-gf', '', 'sm', 'active', '2026-03-03'],
  ['DZY041', '小辛辣計時', 'mala-gf', '', 'pt', 'active', '2026-03-02'],
  ['DZY001', '別店店長', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY021', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-16'],   // 考勤作廢持有人
  ['DZY014', '小辛辣總監', 'mala-hq', '', 'odir', 'active', '2026-01-13'],
  ['DZY016', '小辛辣督導', 'mala-hq', '', 'osv', 'active', '2026-01-14'],
  ['DZY030', '已離職店長', 'mzt-gf', '', 'sm', 'disabled', '2026-01-23'],   // 沒離職日也沒停用紀錄：哪裡都不列
  ['DZY070', '離職八天', 'mala-gf', '', 'pt', 'disabled', '2025-01-01'],
  ['DZY071', '離職七天', 'mala-gf', '', 'pt', 'disabled', '2025-01-02'],
  ['DZY072', '沒打卡帳號', 'mala-gf', '', 'pt', 'disabled', '2025-01-03'],
  ['DZY073', '沒填離職日', 'mala-gf', '', 'pt', 'disabled', '2025-01-04'],
  ['DZY074', '查無離職日', 'mala-gf', '', 'pt', 'disabled', '2025-01-05'],
  ['DZY075', '預約離職日', 'mala-gf', '', 'pt', 'disabled', '2025-01-06'],
  ['DZY076', '帳號被退回', 'mala-gf', '', 'pt', 'disabled', '2025-01-07'],
  ['DZY077', '很久以前', 'mala-gf', '', 'pt', 'disabled', '2024-01-08'],
  ['DZY078', '名冊老早停', 'mala-gf', '', 'pt', 'disabled', '2024-01-09'],
  ['DZY079', '別店離職', 'mzt-gf', '', 'pt', 'disabled', '2025-01-10'],
  ['DZY080', '已復職', 'mala-gf', '', 'pt', 'active', '2025-01-11']
];
const WHO = ['DZY042', 'DZY001', 'DZY020', 'DZY021', 'DZY014', 'DZY016', 'U:a001'];

function build(prop) {
  const app = world(CAST, {});
  const st = (emp) => app.sheets.staff._data.find((r) => r[0] === emp);
  const sc = (emp) => app.sheets.staff_clock._data.find((r) => r[0] === emp);
  const log = (emp, d) => app.sheets.staff_log._data.push([d + ' 00:10:00', emp, 'disable', 'daily', '']);
  st('DZY070')[25] = daysAgo(8);
  st('DZY071')[25] = daysAgo(7);
  st('DZY072')[25] = daysAgo(20);
  app.sheets.staff_clock._data.splice(app.sheets.staff_clock._data.indexOf(sc('DZY072')), 1);   // 沒有打卡帳號
  log('DZY073', daysAgo(30)); st('DZY073')[20] = daysAgo(30) + ' 00:10:00';                       // 沒填離職日、30 天前停用（updated_at 也在 30 天前）
  st('DZY075')[25] = daysAgo(-5); log('DZY075', daysAgo(12)); st('DZY075')[20] = daysAgo(12) + ' 00:10:00';   // 離職日在未來、12 天前先停用
  st('DZY076')[25] = daysAgo(15); sc('DZY076')[4] = 'rejected';                                     // 打卡對照被退回
  st('DZY077')[25] = '2025-06-30'; sc('DZY077')[6] = 'FALSE'; sc('DZY077')[7] = '2025-06-28';        // 很久以前離職，名冊已停用、最後打卡在離職日前 2 天
  st('DZY078')[25] = '2025-06-30'; sc('DZY078')[6] = 'FALSE'; sc('DZY078')[7] = '2025-01-02';        // 名冊停用、最後打卡在離職日前 62 天以前
  st('DZY079')[25] = daysAgo(10);
  st('DZY080')[25] = daysAgo(40); log('DZY080', daysAgo(40));                                       // 停用過、已復職（status active）
  post(app.sb, 'permExSave', { emp_no: 'DZY021', perm: 'att.void', mode: 'add', until: '', note: '考勤作廢' }, app.adminTok);
  app.props.REGIONS_ON = '1';
  app.sheets.regions._data.push(['r-mala-a', 'A區', 'mala', 'mala-gf', 'DZY016', 'TRUE', '2026-10-25 09:00:00', 'tester']);
  app.sb.regionCtxReset_();
  if (prop !== undefined) app.props.ATT_PAST_ON = prop;
  return app;
}
const identRaw = (app, sub) => { app.sb.regionCtxReset_(); const r = app.who(sub); return r.ok ? r.data : r; };
const pastOf = (app, sub) => (identRaw(app, sub).att || {}).past_people;
const subsOf = (rows) => (rows || []).map((x) => x.sub);
const swapSrc = (app, src) => vm.runInContext(src, app.sb, { filename: 'StoreOps.gs' });

// ── (1) 開關關著：7 種身分 ident 跟改前版本逐位元組相同 ──
const OFF = {};
{
  ok(typeof OLD_SRC === 'string' && OLD_SRC.length > 1000 && OLD_SRC.indexOf('ATT_PAST_ON') === -1, '1-0 讀得到改動前的 StoreOps.gs（git show ' + BASE_REF + '）');
  const app = build();
  WHO.forEach((s) => { OFF[s] = J(identRaw(app, s)); });
  ok(OFF.DZY042.indexOf('"last_day":"' + daysAgo(7) + '"') !== -1 && OFF.DZY042.indexOf('DZY070') === -1, '1-1 情境有意義：店長的 7 天名單有 DZY071（last_day T−7）、沒有 DZY070', OFF.DZY042);
  if (OLD_SRC) {
    swapSrc(app, OLD_SRC);
    const old = {};
    WHO.forEach((s) => { old[s] = J(identRaw(app, s)); });
    swapSrc(app, NEW_SRC);
    WHO.forEach((s) => ok(OFF[s] === old[s], '1-2 開關沒設：' + s + ' 的 ident 跟改前逐位元組相同', { now: OFF[s], before: old[s] }));
    // 開關開著的情境，改前版本一樣沒有 past_people（舊程式不認得開關）——用來確認 (8) 的比較基準
    app.props.ATT_PAST_ON = '1';
    swapSrc(app, OLD_SRC);
    const oldOn = J(identRaw(app, 'DZY042'));
    swapSrc(app, NEW_SRC);
    ok(oldOn === OFF.DZY042, '1-3 改前版本不認得開關：開著也跟關著相同（基準一致）');
  }
  ok(WHO.every((s) => !('past_people' in (JSON.parse(OFF[s]).att || {}))), '1-4 開關沒設：沒有人有 past_people 這一欄');
}

// ── (2) 開關各種錯值＝關 ──
{
  const BAD = ['', ' ', 'on', 'true', 'TRUE', 'yes', '１', '1 ', ' 1', '01', '1.0', '0', 'false'];
  const app = build();
  BAD.forEach((v) => {
    app.props.ATT_PAST_ON = v;
    const got = WHO.map((s) => J(identRaw(app, s)));
    ok(got.every((g, i) => g === OFF[WHO[i]]), '2 開關＝' + J(v) + '：當關（7 種身分 ident 跟沒設時逐位元組相同、沒有 past_people）', got.map((g) => g.length));
  });
  ok(app.sb.storeAttPastOn_() === false, '2-x storeAttPastOn_：錯值回 false');
  app.props.ATT_PAST_ON = '1';
  ok(app.sb.storeAttPastOn_() === true, '2-y storeAttPastOn_：恰好 \'1\' 回 true');
}

// ── 開關開著 ──
const app = build('1');
const ON = {};
WHO.forEach((s) => { ON[s] = identRaw(app, s); });

// (3) 店長拿到自己店離職超過 7 天的人、帶正確 last_day；人資主管、管理員、作廢持有人拿到
{
  const p = ON.DZY042.att.past_people;
  ok(Array.isArray(p), '3-0 開關開：店長 ident 有 past_people 陣列');
  ok(J(subsOf(p)) === J(['DZY070', 'DZY073', 'DZY075', 'DZY077']), '3-1 店長：自己店離職超過 7 天的 4 人（八天、沒填離職日、預約離職日、很久以前）', subsOf(p));
  ok(J(p.find((x) => x.sub === 'DZY070')) === J({ clock: 'gf', emp_id: 'GF070', sub: 'DZY070', name: '離職八天', last_day: daysAgo(8) }), '3-2 那一筆形狀＝{clock, emp_id, sub, name, last_day}、last_day＝離職日（T−8）', p.find((x) => x.sub === 'DZY070'));
  const want = ['DZY070', 'DZY073', 'DZY075', 'DZY077', 'DZY079'];
  ok(J(subsOf(ON.DZY020.att.past_people)) === J(want), '3-3 人資主管：兩家店的離職超過 7 天的人都有', subsOf(ON.DZY020.att.past_people));
  ok(J(subsOf(ON['U:a001'].att.past_people)) === J(want), '3-4 管理員（沒有同仁編號）：同人資主管', subsOf(ON['U:a001'].att.past_people));
  ok(J(subsOf(ON.DZY021.att.past_people)) === J(want), '3-5 考勤作廢持有人（人資同仁）：照人資主管那份拿到', subsOf(ON.DZY021.att.past_people));
  ok(J(ON.DZY021.att.past_people) === J(ON.DZY020.att.past_people), '3-6 作廢持有人的 past_people 跟人資主管逐筆相同（含 last_day）');
}
// (4) 督導、總監、別店店長沒有
{
  ok(J(ON.DZY014.att.past_people) === '[]', '4-1 總監（只看名單）：past_people 是空陣列', ON.DZY014.att.past_people);
  ok(J(ON.DZY016.att.past_people) === '[]', '4-2 區督導（只看名單）：past_people 是空陣列', ON.DZY016.att.past_people);
  ok(ON.DZY016.att.view_people.some((x) => x.sub === 'DZY041'), '4-3 情境有意義：督導的只看名單有在職的 DZY041');
  ok(J(subsOf(ON.DZY001.att.past_people)) === J(['DZY079']), '4-4 別店店長：只有自己店的 DZY079，沒有小辛辣光復的人', subsOf(ON.DZY001.att.past_people));
  ok(J(identRaw(app, 'DZY070')) === J({ sub: 'DZY070', active: false }), '4-5 離職的人本人：照舊 inactive（沒有 past_people）');
}
// (5) 第 7 天在 7 天名單、第 8 天在 past；同一人不同時出現在兩邊
{
  const r7 = ON.DZY042.att.people.find((x) => x.sub === 'DZY071');
  ok(!!r7 && r7.last_day === daysAgo(7), '5-1 離職第 7 天：照舊在工時名單、last_day＝T−7', r7);
  ok(!subsOf(ON.DZY042.att.past_people).includes('DZY071'), '5-2 離職第 7 天：不在 past_people');
  ok(!subsOf(ON.DZY042.att.people).includes('DZY070') && subsOf(ON.DZY042.att.past_people).includes('DZY070'), '5-3 離職第 8 天：不在工時名單、在 past_people');
  const both = WHO.filter((s) => {
    const a = ON[s].att, live = {};
    a.people.concat(a.void_hours).forEach((x) => { live[x.sub] = true; live[x.clock + '|' + x.emp_id] = true; });
    return a.past_people.some((x) => live[x.sub] || live[x.clock + '|' + x.emp_id]);
  });
  ok(both.length === 0, '5-4 7 種身分：past_people 的人（與帳號）都不在 people／void_hours', both);
}
// (6) last_day 空白用停用日；未來離職日用停用那天
{
  const all = ON.DZY020.att.past_people;
  ok((all.find((x) => x.sub === 'DZY073') || {}).last_day === daysAgo(30), '6-1 沒填離職日：last_day＝最近一次停用那天（T−30；updated_at 早於界線也照讀停用紀錄）', all.find((x) => x.sub === 'DZY073'));
  ok((all.find((x) => x.sub === 'DZY075') || {}).last_day === daysAgo(12), '6-2 離職日在未來、12 天前先停用：last_day＝停用那天（停用優先，同 7 天規則）', all.find((x) => x.sub === 'DZY075'));
  ok((all.find((x) => x.sub === 'DZY077') || {}).last_day === '2025-06-30', '6-3 很久以前離職：照列（不設期限），last_day＝2025-06-30');
  ok(!subsOf(all).includes('DZY074') && !subsOf(all).includes('DZY030'), '6-4 沒離職日也沒停用紀錄：不列');
  ok(!subsOf(all).includes('DZY080') && subsOf(ON.DZY020.att.people).includes('DZY080'), '6-5 已復職（在職）：在工時名單、不在 past');
  ok(!subsOf(all).includes('DZY078'), '6-6 名冊停用、最後打卡在離職日前 62 天以前：不列（同 7 天規則）');
}
// (7) 沒有打卡帳號、帳號被退回：不產生壞資料
{
  const rows = WHO.flatMap((s) => ON[s].att.past_people);
  ok(!rows.some((x) => x.sub === 'DZY072' || x.sub === 'DZY076'), '7-1 沒有打卡帳號、打卡對照被退回的停用同仁：誰的 past_people 都沒有');
  const KEYS = J(['clock', 'emp_id', 'sub', 'name', 'last_day']);
  const bad = rows.filter((x) => J(Object.keys(x)) !== KEYS || !/^\d{4}-\d{2}-\d{2}$/.test(x.last_day) || !(x.last_day < CUT) || !x.clock || !x.emp_id || !/^DZY\d{3,}$/.test(x.sub) || typeof x.name !== 'string');
  ok(rows.length > 0 && bad.length === 0, '7-2 每一筆欄位齊全、last_day 是 YYYY-MM-DD 且早於界線（' + rows.length + ' 筆）', bad);
  const sorted = WHO.every((s) => { const p = ON[s].att.past_people; return p.every((x, i) => i === 0 || (p[i - 1].clock < x.clock || (p[i - 1].clock === x.clock && p[i - 1].emp_id < x.emp_id))); });
  ok(sorted, '7-3 依 clock、emp_id 排序且不重複');
}
// (8) 開著時，原有各欄跟關著時完全相同（只多 past_people）
{
  WHO.forEach((s) => {
    const o = JSON.parse(J(ON[s]));
    const keys = Object.keys(o.att);
    delete o.att.past_people;
    ok(J(o) === OFF[s] && keys[keys.length - 1] === 'past_people', '8 ' + s + '：拿掉 past_people 後跟關著逐位元組相同（people／req_people／view_people／void_*／其他欄都沒變），past_people 在 att 最後');
  });
  const adm = identRaw(app, 'U:a001');
  ok(Array.isArray(adm.att.past_people) && J(Object.keys(adm.att)) === J(['people', 'req_people', 'view_people', 'void_hours', 'void_req', 'past_people']), '8-x att 欄位順序', Object.keys(adm.att));
}
// (9) 可進入的店／管理單位不因此改變（營運系統 attStoresFor 不讀 past_people；平台這邊所有店別欄位不變）
{
  const F = ['pilot_units', 'units_managed', 'void_units', 'sched_units', 'self', 'own_clocks'];
  const same = WHO.every((s) => { const o = JSON.parse(OFF[s]); return F.every((f) => J(o[f]) === J(ON[s][f])); });
  ok(same, '9 7 種身分的 pilot_units／units_managed／void_units／sched_units／self／own_clocks 開關開關都相同');
}
// 純函式：原 people 不被改、其他呼叫端不受影響
{
  const people = app.sb.storePeople_();
  const lc = app.sb.storeLeftCut_();
  app.sb.storeLeftFill_(people, lc);
  const before = J(people);
  const pf = app.sb.storeLeftPastFill_(people, lc);
  ok(J(people) === before && pf.people !== people && pf.people.length === people.length, 'P-1 storeLeftPastFill_ 不改原 people（回新陣列、同長度）');
  ok(pf.n === 8 && J(pf.people.filter((x) => x.past_left).map((x) => x.emp).sort()) === J(['DZY070', 'DZY072', 'DZY073', 'DZY075', 'DZY076', 'DZY077', 'DZY078', 'DZY079']), 'P-2 離職超過 7 天的候選 8 人（不含 7 天內的 DZY071、查無離職日的 DZY030／DZY074、已復職的 DZY080）（之後再由打卡帳號、組織判斷篩）', pf.people.filter((x) => x.past_left).map((x) => x.emp));
  // 界線直接看 storeLeftPastFill_ 的結果（不經過後面的去重）：第 7 天不帶 past_left、照放原物件；第 8 天帶 past_left、left_on＝T−8
  const c7 = pf.people.find((x) => x.emp === 'DZY071');
  ok(!!c7 && c7.past_left === undefined && c7 === people.find((x) => x.emp === 'DZY071'), 'P-2b 離職第 7 天（T−7＝界線那天）：不是 past 候選（沒有 past_left、照放原物件）', c7 && { past_left: c7.past_left, left_on: c7.left_on });
  const c8 = pf.people.find((x) => x.emp === 'DZY070');
  ok(!!c8 && c8.past_left === true && c8.left_on === daysAgo(8), 'P-2c 離職第 8 天（T−8）：是 past 候選（past_left、left_on＝T−8）', c8 && { past_left: c8.past_left, left_on: c8.left_on });
  const org = app.sb.stfReadOrg_();
  // opt.pastOnly 的原始結果（storeAttPastRows_ 去重之前）只能有 past 候選，不能有在職或 7 天內的人
  const pastSet = new Set(pf.people.filter((x) => x.past_left).map((x) => x.emp));
  const args = [org, app.sb.storeHomeFn_(), app.sb.clkMaps_(), app.sb.storeClockUnits_(), app.sb.regionCtx_(), app.sb.storePilotUnits_(), { leftCut: lc, pastOnly: true }];
  const raw = (me, flags) => app.sb.storeAttLists_(me, flags, pf.people, ...args);
  const RAW = [
    ['店長', people.find((x) => x.emp === 'DZY042'), { admin: false, hrHead: false, attExtra: false }],
    ['人資主管', people.find((x) => x.emp === 'DZY020'), { admin: false, hrHead: true, attExtra: false }],
    ['管理員', { emp: '', status: 'active', unit: '', dept: '', title: '' }, { admin: true, hrHead: false, attExtra: false }]
  ];
  RAW.forEach(([label, me, flags]) => {
    const L = raw(me, flags);
    const leak = L.people.filter((r) => !pastSet.has(r.sub));
    ok(L.people.length > 0 && leak.length === 0 && L.req_people.length === 0 && L.view_people.length === 0, 'P-7 ' + label + '：storeAttLists_(opt.pastOnly) 原始結果只有 past 候選（' + L.people.length + ' 筆；在職、7 天內的人 0 筆；申請、只看 0 筆）', leak.map((r) => r.sub));
  });
  const c = pf.people.find((x) => x.emp === 'DZY070');
  ok(app.sb.storeEffectiveTarget_(c, org, null) === null, 'P-3 不給 leftCut（缺核定人提醒、打卡保護名單…）：複本照舊不列');
  const t = app.sb.storeEffectiveTarget_(c, org, null, lc);
  ok(!!t && t.past === true && t.left === daysAgo(8) && t.status === 'active', 'P-4 給 leftCut：複本列入、past＝true、left＝離職日', t);
  const o = people.find((x) => x.emp === 'DZY070');
  ok(app.sb.storeEffectiveTarget_(o, org, null, lc) === null, 'P-5 原物件（沒有 past_left）：照舊不列');
  const gaps = app.sb.storeHoursGaps_(people, org, null, app.sb.clkMaps_(), app.sb.storeClockUnits_());
  ok(!gaps.some((g) => g.emp === 'DZY070'), 'P-6 工時沒人核提醒不算離職的人');
}
// 契約：rules.att_past 與範例 ident_past 的欄位
{
  const fx = FIX.responses.ident_past;
  ok(typeof FIX.rules.att_past === 'string' && FIX.rules.att_past.indexOf('ATT_PAST_ON') !== -1, 'C-1 契約 rules.att_past 有說明（含開關名稱）');
  ok(!!fx && fx.ok === true && J(Object.keys(fx.data)) === J(Object.keys(ON.DZY042).filter((k) => k !== 'sched_units' && k !== 'sched_hq_shift')), 'C-2 契約 ident_past：欄位名與順序同實際店長 ident（不含總監排班兩欄，同 ident_active）', fx && Object.keys(fx.data));
  ok(!!fx && J(Object.keys(fx.data.att)) === J(Object.keys(ON.DZY042.att)), 'C-3 契約 ident_past.att 欄位順序同實際（past_people 在最後）', fx && Object.keys(fx.data.att));
  const row = fx && fx.data.att.past_people[0];
  ok(!!row && J(Object.keys(row)) === J(Object.keys(ON.DZY042.att.past_people[0])) && /^\d{4}-\d{2}-\d{2}$/.test(row.last_day), 'C-4 契約範例那一筆的欄位同實際（clock, emp_id, sub, name, last_day）', row);
  ok(J(Object.keys(ON.DZY042)) === J(Object.keys(JSON.parse(OFF.DZY042))), 'C-5 開關不改 ident 頂層欄位（只在 att 裡多一欄）');
}

console.log(`\n${fail ? '有失敗' : '全部測試通過'}，共 ${pass + fail} 項（失敗 ${fail}）`);
process.exit(fail ? 1 : 0);
