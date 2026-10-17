// node test/apv-route.test.mjs —— 第三期表單簽核 P1：路線與金額純函式（docs/approvals/task.md T1-1、T1-2、T4-4 的支出／人事矩陣）
// 把 Staff.gs（組織判斷）＋ApprovalRoute.gs 讀進同一個 vm sandbox，不碰任何試算表。
// ⚠ 姓名、編號全是假資料（測試甲、DZY9xx；dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { apvCalcAmount } from '../modules/approvals-shared/amount.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const ROUTE_SRC = fs.readFileSync(path.join(DIR, 'ApprovalRoute.gs'), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (x) => JSON.stringify(x);
const eq = (a, b) => J(a) === J(b);

const sb = { console };
vm.createContext(sb);
['Staff.gs', 'ApprovalRoute.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f }));
const ORG = sb.stfBuildOrg_(sb.STF_DEFAULT_ORG);
// Approvals.gs 的預設門檻在另一個檔；這裡直接寫一份（與 spec §2 預設值相同）
const THR_DEFAULT = [['spend', 1, 5000, 'head', 'head', 1], ['spend', 2, 10000, 'brand_dir', 'head', 1], ['spend', 3, 30000, 'gm', 'gm', 1], ['spend', 4, '', 'chair', 'chair', 1]];

// ── 人員目錄（全部假資料）──
function mk(emp, name, o) {
  const v = new Array(sb.STF_COL_COUNT).fill('');
  const x = Object.assign({ status: 'active', unit: '', dept: '', title: '' }, o);
  v[sb.STF_COL.emp_no] = emp; v[sb.STF_COL.name] = name; v[sb.STF_COL.user_id] = 'u' + emp.slice(3);
  v[sb.STF_COL.status] = x.status; v[sb.STF_COL.unit] = x.unit; v[sb.STF_COL.dept] = x.dept; v[sb.STF_COL.title] = x.title;
  v[sb.STF_COL.brand] = x.unit ? ORG.unit[x.unit].parent : '';
  return sb.apvPerson_(v, ORG, x.extra || [], true);
}
const BASE = [
  mk('DZY901', '測試甲', { unit: 'mala-gf', title: 'ft' }),        // 光復店員
  mk('DZY902', '測試乙', { unit: 'mala-gf', title: 'sm' }),        // 光復店長
  mk('DZY903', '測試丙', { unit: 'mala-hq', title: 'odir' }),      // 小辛辣總監
  mk('DZY904', '測試丁', { unit: 'dzy-hq', dept: 'mgmt', title: 'gm' }),
  mk('DZY905', '測試戊', { unit: 'dzy-hq', dept: 'mgmt', title: 'ceo' }),
  mk('DZY906', '測試己', { unit: 'dzy-hq', dept: 'mgmt', title: 'chair' }),
  mk('DZY907', '測試庚', { unit: 'dzy-hq', dept: 'purchase', title: 'hs' }),
  mk('DZY908', '測試辛', { unit: 'dzy-hq', dept: 'purchase', title: 'hm' }),
  mk('DZY909', '測試壬', { unit: 'ck', title: 'ft' }),
  mk('DZY910', '測試癸', { unit: 'ck', title: 'sm' }),
  mk('DZY911', '測試子', { unit: 'dzy-hq', dept: 'hr', title: 'hm' }),
  mk('DZY913', '測試寅', { unit: 'mzt-gf', title: 'sm' }),
  mk('DZY914', '測試卯', { unit: 'mzt-hq', title: 'odir' }),
  mk('DZY915', '測試辰', { unit: 'mala-gf', title: 'pt' }),
  mk('DZY916', '測試巳', { unit: 'mala-hq', title: 'oam' }),
  mk('DZY917', '測試午', { status: 'unclaimed', unit: 'mala-gf', title: 'ft' })
];
const TABLE = {
  ver: 1,
  rows: THR_DEFAULT.map((r) => ({ seq: r[1], max: r[2] === '' ? null : r[2], store_role: r[3], hq_role: r[4] }))
};
function ctxOf(people, exclude) {
  const byEmp = {};
  people.forEach((p) => { byEmp[p.emp] = p; });
  return { org: ORG, people, byEmp, exclude: exclude || [] };
}
const who = (list) => list.map((p) => p.emp);
/** 請購請款：建路線＋往前走。回 {eff, route} */
function spend(senderEmp, amount, people, table) {
  const ppl = people || BASE;
  const ctx = ctxOf(ppl, [senderEmp]);
  const sender = ctx.byEmp[senderEmp];
  const b = sb.apvBuildRoute_({ type: 'expense', amount, sender, table: table || TABLE, ctx, now: 1 });
  if (!b.ok) return { b };
  return { b, route: b.route, eff: sb.apvAdvance_(b.route, ctx), ctx };
}
function pers(kind, senderEmp, subjectEmp, people, extra) {
  const ppl = people || BASE;
  const ctx = ctxOf(ppl, [senderEmp, subjectEmp]);
  const b = sb.apvBuildRoute_(Object.assign({ type: 'personnel', kind, sender: ctx.byEmp[senderEmp], subject: ctx.byEmp[subjectEmp], ctx, now: 1 }, extra || {}));
  return { b, eff: b.ok ? sb.apvAdvance_(b.route, ctx) : null, ctx };
}

// ===== T1-1：權限表比對 =====
{
  const rows = TABLE.rows;
  const seqOf = (a) => sb.apvPickRow_(rows, a).seq;
  const cases = [[0, 1], [1, 1], [5000, 1], [5001, 2], [10000, 2], [10001, 3], [30000, 3], [30001, 4], [999999, 4], [10000000, 4]];
  cases.forEach(([a, s]) => ok(seqOf(a) === s, `T1-1 金額 ${a} → 第 ${s} 列`, seqOf(a)));
  ok(sb.apvPickRow_(rows, NaN) === null && sb.apvPickRow_(rows, '5000') === null, 'T1-1 NaN／字串金額不比對');
  ok(sb.apvValidateTable_(rows).ok === true, 'T1-1 預設表通過驗證');
  const bad = (mut, label) => {
    const t = JSON.parse(J(rows)); mut(t);
    const r = sb.apvValidateTable_(t);
    ok(r.ok === false && typeof r.error === 'string' && r.error.length > 0, 'T1-1 驗證擋：' + label, r);
  };
  bad((t) => { t[1].max = 5000; }, '金額沒有嚴格遞增（相等）');
  bad((t) => { t[1].max = 4000; }, '金額遞減');
  bad((t) => { t[3].max = 50000; }, '最後一列有金額');
  bad((t) => { t[1].max = ''; }, '中間列金額空白');
  bad((t) => { t[0].store_role = 'boss'; }, '門市權限人代碼不合法');
  bad((t) => { t[0].hq_role = 'pur'; }, '總部權限人代碼不合法');
  bad((t) => { t[0].max = 1.5; }, '金額非整數');
  bad((t) => { t[0].max = -1; }, '金額負數');
  bad((t) => { t[0].max = '5000'; }, '金額是字串');
  ok(sb.apvValidateTable_([]).ok === false && sb.apvValidateTable_(null).ok === false, 'T1-1 空表／非陣列被擋');
  ok(sb.apvValidateTable_([{ max: null, store_role: 'chair', hq_role: 'chair' }]).ok === true, 'T1-1 只有一列「以上全部」可以');
  ok(sb.apvValidateTable_(Array.from({ length: 21 }, (_, i) => ({ max: i < 20 ? (i + 1) * 100 : null, store_role: 'head', hq_role: 'head' }))).ok === false, 'T1-1 超過 20 列被擋');
}

// ===== T1-2：§5.1 四個例子 =====
{
  const cases = [[800, 'head', ['DZY902']], [8600, 'brand_dir', ['DZY903']], [25000, 'gm', ['DZY904']], [42000, 'chair', ['DZY906']]];
  cases.forEach(([amt, role, emps]) => {
    const r = spend('DZY901', amt, null);
    ok(r.eff.status === 'signing' && r.eff.route.steps.length === 1 && r.eff.route.steps[0].role === role && eq(who(r.eff.candidates), emps), `§5.1 光復同仁請款 ${amt} → ${role} ${emps}`, r.eff);
    ok(r.route.v === 1 && r.route.handler === 'fin' && r.route.thr_ver === 1 && r.route.row.role === role, `§5.1 ${amt} 路線快照有版本、權限表列、承辦 fin`, r.route);
  });
  const e = spend('DZY901', 800, null);
  ok(e.eff.route.steps[0].scope === 'mala-gf' && spend('DZY901', 8600, null).eff.route.steps[0].scope === 'mala-hq', 'scope：店長＝單位、品牌總監＝品牌辦公室');
}

// ===== T1-2：總部、央廚、自己、空缺、全空 =====
{
  const hq = spend('DZY907', 8000, null);
  ok(hq.route.row.role === 'head' && hq.eff.status === 'signing' && eq(who(hq.eff.candidates), ['DZY908']), '總部 8,000 → hq_role＝部門主管（同主要部門 hm）', hq.eff);
  const hq2 = spend('DZY907', 4000, null);
  ok(eq(who(hq2.eff.candidates), ['DZY908']), '總部 4,000 → 部門主管');
  const hq3 = spend('DZY907', 20000, null);
  ok(hq3.route.row.role === 'gm' && eq(who(hq3.eff.candidates), ['DZY904']), '總部 20,000 → 總經理');
  const ck = spend('DZY909', 8000, null);
  ok(ck.eff.status === 'signing' && eq(who(ck.eff.candidates), ['DZY905']) && ck.eff.skips.length === 1 && ck.eff.skips[0].role === 'brand_dir' && ck.eff.skips[0].next === 'ceo', 'ck 8,000：央廚沒有品牌總監 → skip → 執行長', ck.eff);
  ok(ck.eff.route.steps.map((s) => s.role + ':' + s.status).join() === 'brand_dir:skipped,ceo:pending', 'ck 路線留下被跳過的那一格');
  const ck2 = spend('DZY909', 800, null);
  ok(eq(who(ck2.eff.candidates), ['DZY910']), 'ck 800 → ck 店長（head）');
  const sm = spend('DZY902', 3000, null);
  ok(sm.eff.status === 'signing' && eq(who(sm.eff.candidates), ['DZY903']) && sm.eff.skips[0].role === 'head', '店長送 3,000：權限人是自己 → 往上到品牌總監', sm.eff);
  const noDir = BASE.filter((p) => p.emp !== 'DZY903');
  const vac = spend('DZY901', 8600, noDir);
  ok(eq(who(vac.eff.candidates), ['DZY905']) && vac.eff.skips[0].role === 'brand_dir', '品牌總監空缺 → 執行長', vac.eff);
  const off = BASE.map((p) => p.emp === 'DZY903' ? mk('DZY903', '測試丙', { status: 'disabled', unit: 'mala-hq', title: 'odir' }) : p);
  ok(eq(who(spend('DZY901', 8600, off).eff.candidates), ['DZY905']), '品牌總監帳號停用 → 當空缺往上');
  const lonely = BASE.filter((p) => p.emp === 'DZY901');
  const none = spend('DZY901', 800, lonely);
  ok(none.eff.status === 'exception' && none.eff.candidates.length === 0 && none.eff.route.steps.map((s) => s.role).join() === 'head,brand_dir,ceo,gm,chair' && none.eff.route.steps.every((s) => s.status === 'skipped'), '全空 → exception（逐級 skip 到董事長），不是自動給人資', none.eff);
  ok(none.eff.index === 4 && none.eff.skips.length === 5, 'exception 指標停在最後一格，skip 事件 5 筆');
  const ch = spend('DZY906', 800, null);
  ok(ch.eff.status === 'exception', '董事長自己送支出單 → exception（沒有更高的人）', ch.eff);
  const gm = spend('DZY904', 25000, null);
  ok(gm.eff.status === 'signing' && eq(who(gm.eff.candidates), ['DZY906']), '總經理送 25,000（權限人是總經理自己）→ 董事長');
  const dup = BASE.concat([mk('DZY918', '測試未', { unit: 'mala-gf', title: 'sm' })]);
  const d = spend('DZY901', 800, dup);
  ok(eq(who(d.eff.candidates), ['DZY902', 'DZY918']), '同一個權限人有多人 → 全部都是候選（任一人核准就過）', d.eff);
  const peer = spend('DZY902', 800, dup);
  ok(!who(peer.eff.candidates).includes('DZY918') && peer.eff.skips[0].role === 'head', '店長送單：同單位另一位店長是同級，不能簽（往上）', peer.eff);
  const unopened = BASE.map((p) => p.emp === 'DZY902' ? mk('DZY902', '測試乙', { status: 'pending', unit: 'mala-gf', title: 'sm' }) : p);
  ok(spend('DZY901', 800, unopened).eff.skips[0].role === 'head', '店長還沒開通（pending）→ 當空缺往上');
  const mzt = spend('DZY913', 8000, null);
  ok(eq(who(mzt.eff.candidates), ['DZY914']), '墨竹亭店長 8,000 → 墨竹亭辦公室總監（依品牌找人，不會找到小辛辣總監）', mzt.eff);
  const oamS = spend('DZY916', 800, null);
  ok(oamS.eff.status === 'signing' && eq(who(oamS.eff.candidates), ['DZY903']), '品牌辦公室區經理 800：head 同級不算 → 總監', oamS.eff);
}

// ===== 快照不受改權限表影響 =====
{
  const t1 = JSON.parse(J(TABLE));
  const r = spend('DZY901', 800, null, t1);
  const before = J(r.route);
  t1.rows[0].max = 100; t1.rows[0].store_role = 'chair'; t1.ver = 9;
  ok(J(r.route) === before && r.route.row.role === 'head' && r.route.row.max === 5000 && r.route.thr_ver === 1, '快照：送出後改權限表，已建好的路線不變');
  const r2 = spend('DZY901', 80, null, t1);
  ok(r2.route.row.role === 'chair' && r2.route.thr_ver === 9, '之後新建的路線吃新表');
  const solo = spend('DZY901', 1, null, { ver: 2, rows: [{ seq: 1, max: null, store_role: 'gm', hq_role: 'gm' }] });
  ok(eq(who(solo.eff.candidates), ['DZY904']), '改成只有一列時，所有金額走那一列');
  ok(spend('DZY901', 1, null, { ver: 1, rows: [] }).b.error === 'not_inited', '權限表是空的 → not_inited');
}

// ===== T4-4 人事矩陣（§14.4）=====
{
  const l1 = pers('leave', 'DZY901', 'DZY901', null, { signedAtSubmit: true });
  ok(l1.b.route.steps.map((s) => s.role + ':' + s.status).join() === 'self_sign:done,direct:pending' && l1.eff.status === 'signing' && eq(who(l1.eff.candidates), ['DZY902']), 'leave 本人送：self_sign 已簽 → 直屬主管（店長）核准', l1.eff);
  ok(l1.b.route.handler === 'hr', 'leave 承辦 hr');
  const l2 = pers('leave', 'DZY902', 'DZY901');
  ok(l2.eff.status === 'signing' && l2.eff.index === 0 && l2.eff.route.steps[0].role === 'self_sign' && eq(who(l2.eff.candidates), ['DZY901']), 'leave 主管送、對象已開通：第一關本人簽名', l2.eff);
  ok(l2.eff.route.steps[1].role === 'direct' && l2.eff.route.steps[1].of === 'DZY902', '送件人（店長）本來就是對象的直屬主管 → 直屬主管關改成店長的直屬主管（of＝送件人）');
  const cands2 = sb.apvCandidates_(l2.eff.route.steps[1], l2.ctx);
  ok(who(cands2).sort().join() === 'DZY903,DZY916', '店長的直屬主管＝同品牌辦公室區經理以上', who(cands2));
  const l3 = pers('leave', 'DZY902', 'DZY917');
  ok(l3.b.route.steps.length === 1 && l3.b.route.steps[0].role === 'direct', 'leave 對象沒開通：沒有本人簽名關（改附紙本照）', l3.b.route.steps);
  const ghost = BASE.concat([mk('DZY919', '測試申', { status: 'unclaimed' })]);
  const l4 = pers('leave', 'DZY911', 'DZY919', ghost);
  ok(l4.eff.status === 'signing' && eq(who(l4.eff.candidates), ['DZY905']) && l4.eff.skips[0].role === 'direct' && l4.eff.skips[0].next === 'brand_dir', '直屬主管算不出來 → 依 §5.2 順序往上（品牌總監不存在 → 執行長）', l4.eff);
  const t1 = pers('transfer', 'DZY902', 'DZY901');
  ok(t1.b.route.steps.length === 1 && t1.b.route.steps[0].role === 'direct' && t1.b.route.steps[0].of === 'DZY902', 'transfer：店長送 → 店長的直屬主管');
  const t2 = pers('transfer', 'DZY911', 'DZY901');
  ok(t2.b.route.steps[0].of === 'DZY901' && eq(who(t2.eff.candidates), ['DZY902']), 'transfer：人資送 → 對象的直屬主管（店長）核准', t2.eff);
  const t3 = pers('transfer', 'DZY911', 'DZY907');
  ok(eq(who(t3.eff.candidates), ['DZY908']), 'transfer：總部同仁 → 同部門主管', t3.eff);
  const r1 = pers('raise', 'DZY902', 'DZY901');
  ok(r1.b.route.steps.length === 1 && r1.b.route.steps[0].role === 'gm' && eq(who(r1.eff.candidates), ['DZY904']), 'raise：總經理一關', r1.eff);
  const r2 = pers('raise', 'DZY904', 'DZY901');
  ok(r2.eff.status === 'signing' && eq(who(r2.eff.candidates), ['DZY906']) && r2.eff.skips[0].role === 'gm', 'raise：總經理＝送件人 → 董事長', r2.eff);
  const r3 = pers('raise', 'DZY911', 'DZY906');
  ok(r3.eff.status === 'exception', 'raise：對象是董事長 → 沒有合格的人 → exception', r3.eff);
  const can = (kind, s, t, hr) => sb.apvCanSendPersonnel_(kind, ctxOf(BASE).byEmp[s], ctxOf(BASE).byEmp[t], ctxOf(BASE), !!hr);
  ok(can('leave', 'DZY901', 'DZY901') === true, '資格：一般同仁可送自己的離職單');
  ok(can('transfer', 'DZY901', 'DZY901') === false && can('raise', 'DZY901', 'DZY901') === false, '資格：一般同仁不能送自己的調職、調薪');
  ok(can('leave', 'DZY915', 'DZY901') === false, '資格：一般同仁不能送別人的離職單');
  ok(can('leave', 'DZY902', 'DZY901') && can('transfer', 'DZY902', 'DZY901') && can('raise', 'DZY902', 'DZY901'), '資格：同店店長可送本店同仁三種');
  ok(can('transfer', 'DZY913', 'DZY901') === false, '資格：跨店店長替別店同仁送 → 擋');
  ok(can('transfer', 'DZY914', 'DZY901') === false, '資格：他牌辦公室總監 → 擋');
  ok(can('transfer', 'DZY903', 'DZY901') && can('transfer', 'DZY916', 'DZY901'), '資格：同品牌辦公室區經理以上可送');
  ok(can('raise', 'DZY904', 'DZY901') && can('raise', 'DZY905', 'DZY901'), '資格：總經理、執行長可送');
  ok(can('transfer', 'DZY908', 'DZY907') && can('transfer', 'DZY907', 'DZY908') === false, '資格：部門主管可送同部門同仁；同仁不能送主管');
  ok(can('transfer', 'DZY902', 'DZY902') === false && can('transfer', 'DZY915', 'DZY902') === false, '資格：下級不能送上級的調職');
  ok(can('transfer', 'DZY911', 'DZY901', true) === true && can('raise', 'DZY915', 'DZY901', true) === true, '資格：人資（platform.staff）一律可送');
  ok(can('transfer', 'DZY910', 'DZY909') === true && can('transfer', 'DZY910', 'DZY901') === false, '資格：央廚店長只能送央廚同仁');
}

// ===== 輔助：承辦、改派 =====
{
  const c = ctxOf(BASE);
  ok(sb.apvIsHandler_(c.byEmp.DZY911, 'hr') && !sb.apvIsHandler_(c.byEmp.DZY911, 'fin') && !sb.apvIsHandler_(c.byEmp.DZY901, 'hr'), '承辦：主要部門才算');
  const ex = BASE.concat([mk('DZY920', '測試酉', { unit: 'mala-gf', title: 'ft', extra: ['fin'] })]);
  ok(sb.apvIsHandler_(ctxOf(ex).byEmp.DZY920, 'fin'), '承辦：兼任部門也算');
  ok(sb.APV_HANDLER_DEPT.purchase === 'purchase' && sb.APV_HANDLER_DEPT.expense === 'fin' && sb.APV_HANDLER_DEPT.personnel === 'hr', '承辦部門代碼 purchase／fin／hr（不是 pur）');
  ok(['purchase', 'fin', 'hr'].every((k) => ORG.dept[k] && ORG.dept[k].active), 'org 正本有 purchase／fin／hr');
  const r = spend('DZY901', 800, null);
  const members = sb.apvReassignMembers_(r.eff.route, 0, 'signing', r.ctx);
  ok(who(members).join() === 'DZY902,DZY903,DZY905,DZY904,DZY906', '改派：該關 role 或更高的合格人選', who(members));
  ok(!who(members).includes('DZY901') && !who(members).includes('DZY907'), '改派名單不含送件人、不含不相干的人');
  const exr = spend('DZY906', 800, null);
  const mem2 = sb.apvReassignMembers_(exr.eff.route, exr.eff.index, 'exception', exr.ctx);
  ok(who(mem2).join() === 'DZY904', '董事長自己送單的 exception：可改派給總經理（不含董事長自己）', who(mem2));
  const ss = pers('leave', 'DZY902', 'DZY901');
  ok(sb.apvReassignMembers_(ss.eff.route, 0, 'signing', ss.ctx).length === 0, '本人簽名關不能改派');
}

// ===== 金額：.gs 與前端 amount.js =====
{
  const CASES = [
    ['purchase', { items: [{ qty: 1.5, price: 333 }] }],
    ['purchase', { items: [{ qty: 3, price: 120 }, { qty: 0.25, price: 400 }, { qty: 10, price: 1 }] }],
    ['purchase', { items: [{ qty: 1.15, price: 100 }] }],
    ['purchase', { items: [{ qty: 0.01, price: 49 }, { qty: 2, price: 3 }] }],
    ['purchase', { items: [{ qty: 9999, price: 1000 }] }],
    ['purchase', { items: [{ qty: 0, price: 10 }] }],
    ['purchase', { items: [{ qty: -1, price: 10 }] }],
    ['purchase', { items: [{ qty: 1, price: 0 }] }],
    ['purchase', { items: [{ qty: 1, price: -5 }] }],
    ['purchase', { items: [{ qty: 1, price: 10.5 }] }],
    ['purchase', { items: [{ qty: 1.234, price: 10 }] }],
    ['purchase', { items: [{ qty: 10000, price: 1 }] }],
    ['purchase', { items: [{ qty: 1, price: 1000001 }] }],
    ['purchase', { items: [{ qty: '2', price: 10 }] }],
    ['purchase', { items: [{ qty: 2, price: '10' }] }],
    ['purchase', { items: [{ qty: NaN, price: 10 }] }],
    ['purchase', { items: [{ qty: Infinity, price: 10 }] }],
    ['purchase', { items: [{ qty: 1, price: Infinity }] }],
    ['purchase', { items: [{ qty: 1, price: 1000000 }, { qty: 9999, price: 1000000 }] }],
    ['purchase', { items: [] }],
    ['purchase', { items: 'x' }],
    ['purchase', {}],
    ['purchase', null],
    ['purchase', { items: [null] }],
    ['purchase', { items: Array.from({ length: 31 }, () => ({ qty: 1, price: 1 })) }],
    ['purchase', { items: Array.from({ length: 30 }, () => ({ qty: 1, price: 1 })) }],
    ['expense', { amount: 8600 }], ['expense', { amount: 1 }], ['expense', { amount: 10000000 }], ['expense', { amount: 10000001 }],
    ['expense', { amount: 0 }], ['expense', { amount: -3 }], ['expense', { amount: 12.5 }], ['expense', { amount: '800' }],
    ['expense', { amount: NaN }], ['expense', { amount: Infinity }], ['expense', {}], ['expense', null],
    ['personnel', { kind: 'leave' }]
  ];
  let same = 0;
  CASES.forEach(([t, b], i) => {
    const a = sb.apvCalcAmount_(t, b);
    const f = apvCalcAmount(t, b);
    if (J(a) === J(f)) same++; else console.error('不同', i, t, J(a), J(f));
  });
  ok(same === CASES.length, `前後端金額函式 ${CASES.length} 組輸入結果完全相同`, same);
  ok(sb.apvCalcAmount_('purchase', { items: [{ qty: 1.5, price: 333 }] }).amount === 500, '反例：1.5×333＝499.5 → 500（四捨五入到元）');
  ok(sb.apvCalcAmount_('purchase', { items: [{ qty: 1.15, price: 100 }] }).amount === 115, '浮點誤差：1.15×100 → 115');
  const two = sb.apvCalcAmount_('purchase', { items: [{ qty: 0.25, price: 333 }, { qty: 0.25, price: 333 }] });
  ok(two.amount === 166 && eq(two.subtotals, [83, 83]), '每列各自四捨五入再加總：83.25→83、83.25→83＝166', two);
  ['purchase|{"items":[{"qty":-1,"price":10}]}', 'purchase|{"items":[{"qty":"2","price":10}]}', 'expense|{"amount":0}', 'expense|{"amount":10000001}'].forEach((s) => {
    const [t, b] = s.split('|');
    ok(sb.apvCalcAmount_(t, JSON.parse(b)).error === 'bad_amount', '金額反例 bad_amount：' + s);
  });
  ok(sb.apvCalcAmount_('purchase', { items: [{ qty: NaN, price: 1 }] }).error === 'bad_amount' && sb.apvCalcAmount_('expense', { amount: Infinity }).error === 'bad_amount', 'NaN／Infinity → bad_amount');
  const grab = (src, re) => { const m = re.exec(src); return m ? m[0] : ''; };
  const gs = grab(ROUTE_SRC, /function apvCalcAmount_\([\s\S]*?\n}\n/).replace('apvCalcAmount_', 'FN');
  const js = grab(fs.readFileSync(path.join(__dirname, '..', 'modules', 'approvals-shared', 'amount.js'), 'utf8'), /export function apvCalcAmount\([\s\S]*?\n}\n/).replace('export function apvCalcAmount', 'function FN');
  ok(gs.length > 200 && gs === js, '前後端金額函式原始碼逐字相同（除函式名）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
