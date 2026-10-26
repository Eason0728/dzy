// node test/eval-calc.test.mjs —— 績效評核 P1：計分純函式（docs/eval/task.md T1-1～T1-4）
// 舊站 mala-eval tests/scoring.test.js、newbie.test.js 的案例逐條移植，規則不得改變。
// ⚠ 全部假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'platform', 'EvalCalc.gs'), 'utf8');

let passed = 0;
let failed = 0;
const J = (x) => JSON.stringify(x);
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + J(extra) : '')); }
}
const eq = (a, b, label) => ok(J(a) === J(b), label, { got: a, want: b });

const sb = { console };
vm.createContext(sb);
vm.runInContext(SRC, sb, { filename: 'EvalCalc.gs' });

// ── 1. 基本運算 ──
eq(sb.evCapScore_(106), 100, 'cap 106→100');
eq(sb.evCapScore_(99.9), 99.9, 'cap 99.9');
eq(sb.evCapScore_(0), 0, 'cap 0');
ok(sb.evCapScore_(null) === null && sb.evCapScore_(undefined) === undefined, 'cap null/undefined 原樣');
eq(sb.evRaterTotal_([5, 4, 3]), 12, 'raterTotal');
ok(sb.evRaterTotal_([]) === null && sb.evRaterTotal_(null) === null, 'raterTotal 空 null');
eq(sb.evAverageTotals_([10, 20]), 15, 'averageTotals');
ok(sb.evAverageTotals_([]) === null, 'averageTotals 空 null');
eq(sb.evAverageItems_([[5, 4], [3, 4]]), [4, 4], 'averageItems');
ok(sb.evAverageItems_([]) === null, 'averageItems 空');
{
  const list = [[5, 4, 3], [4, 4, 2]];
  const per = sb.evAverageItems_(list).reduce((a, b) => a + b, 0);
  const avg = sb.evAverageTotals_(list.map(sb.evRaterTotal_));
  eq(sb.evRound1_(per), sb.evRound1_(avg), '每題平均加總＝總分平均');
}
eq(sb.evRound1_(15.049), 15, 'round1 15.049');
eq(sb.evRound1_(15.05), 15.1, 'round1 15.05');
eq(sb.evFtAttitudeScale_(5), 6, 'ft ×1.2 5→6');
eq(sb.evRound1_(sb.evFtAttitudeScale_(14.7)), 17.6, 'ft ×1.2 14.7→17.6');
ok(sb.evFtAttitudeScale_(null) === null, 'ft ×1.2 null');

// ── 2. finalScore ──
eq(sb.evFinalScore_({ attitude: null }), { score: null, performanceCounted: false }, 'final 態度 null');
eq(sb.evFinalScore_({ attitude: 20, attitudeAdjust: 2 }), { score: 22, performanceCounted: false }, 'final 只態度含調整');
eq(sb.evFinalScore_({ attitude: 20, attitudeAdjust: 1, performance: 30, performanceAdjust: -2 }), { score: 49, performanceCounted: true }, 'final 雙調整');

// ── 3. 等第、時薪 ──
[[90, 'A'], [85, 'A'], [84.9, 'B'], [75, 'B'], [74, 'C'], [65, 'C'], [64, 'D'], [0, 'D']].forEach(([s, g]) => eq(sb.evGradeFor_(s).grade, g, 'grade ' + s));
ok(sb.evGradeFor_(null) === null, 'grade null');
eq([85, 80, 70, 50].map((s) => sb.evGradeFor_(s).base), [1, 0.7, 0.5, 0], 'grade 基數');
eq(sb.evGradeFor_(80, [{ grade: 'A', min: 90, base: 1 }, { grade: 'B', min: 0, base: 0.5 }]).grade, 'B', 'grade 自訂表（品牌各一張）');
{
  const tiers = [['96 分以上', '340'], ['91～95 分', '300'], ['86～90 分', '280'], ['81～85 分', '230'],
    ['76～80 分', '220'], ['71～75 分', '210'], ['66～70 分', '205'], ['65 分以下', '法定時薪']];
  eq([98, 96, 95, 83.4, 66, 65, 40].map((s) => sb.evWageTierIndex_(tiers, s)), [0, 0, 1, 3, 6, 7, 7], '時薪落點');
  eq(sb.evWageTierIndex_(tiers, null), -1, '時薪 null');
}

// ── 4. KPI ──
eq(['A', 'B'].map((g) => sb.evKpiItemScore_({ weight: 20, type: '技能' }, g)), [20, 16], 'kpi 技能 A/B');
eq(sb.evKpiItemScore_({ weight: 10, type: '技能' }, 'C'), 6, 'kpi 技能 C');
eq(sb.evKpiItemScore_({ weight: 5, type: '技能' }, 'D'), 2, 'kpi 技能 D');
ok(sb.evKpiItemScore_({ weight: 5, type: '技能' }, '') === null, 'kpi 技能未評');
eq(sb.evKpiItemScore_({ weight: 5, type: '執行力' }, '完成'), 5, 'kpi 執行力完成');
eq(sb.evKpiItemScore_({ weight: 5, type: '執行力' }, '未完成'), 0, 'kpi 執行力未完成');
ok(sb.evKpiItemScore_({ weight: 5, type: '執行力' }, '') === null, 'kpi 執行力未評');
const KPI10 = [
  { key: 'sales', weight: 5, type: '技能' }, { key: 'profit', weight: 10, type: '技能' }, { key: 'op', weight: 20, type: '技能' },
  { key: 'stock', weight: 5, type: '技能' }, { key: 'google', weight: 5, type: '技能' },
  ...['e6', 'e7', 'e8', 'e9', 'e10'].map((k) => ({ key: k, weight: 5, type: '執行力' }))
];
{
  const allA = {};
  KPI10.forEach((it) => { allA[it.key] = it.type === '執行力' ? '完成' : 'A'; });
  eq(sb.evKpiTotal_(KPI10, allA), 70, 'kpi 滿分 70');
  const obj = {};
  KPI10.forEach((it) => { obj[it.key] = { sel: allA[it.key], actual: 'x' }; });
  eq(sb.evKpiTotal_(KPI10, obj), 70, 'kpi 值為 {sel,actual} 也算');
}
eq(sb.evKpiTotal_(KPI10.slice(0, 3).concat(KPI10.slice(5, 7)), { sales: 'A', profit: 'B', op: 'C', e6: '完成', e7: '未完成' }), 30, 'kpi 混合');
ok(sb.evKpiTotal_([{ key: 'a', weight: 5, type: '技能' }, { key: 'b', weight: 5, type: '執行力' }], { a: 'A' }) === null, 'kpi 有項未評 null');
ok(sb.evKpiTotal_([], {}) === null, 'kpi 無項 null');

// ── 5. 新人考核 ──
eq(sb.evDueDate_('2026-09-03'), '2026-10-03', 'due 下月同日');
eq(sb.evDueDate_('2026-12-15'), '2027-01-15', 'due 跨年');
eq(sb.evDueDate_('2027-01-31'), '2027-02-28', 'due 1/31→2/28');
eq(sb.evDueDate_('2028-01-31'), '2028-02-29', 'due 閏年');
eq(sb.evDueDate_('2026-10-31'), '2026-11-30', 'due 10/31→11/30');
eq(sb.evDaysBetween_('2026-10-03', '2026-10-10'), 7, 'daysBetween');
const SINCE = '2026-08-01';
eq(sb.evNewbieStatus_('', '2026-10-05', false, SINCE).state, 'none', 'newbie 無到職日');
eq(sb.evNewbieStatus_('2024-05-01', '2026-10-05', false, SINCE).state, 'none', 'newbie 早於保險絲');
eq(sb.evNewbieStatus_(SINCE, '2026-10-05', false, SINCE).state, 'due', 'newbie 保險絲當天起算');
{
  const w = sb.evNewbieStatus_('2026-09-10', '2026-10-05', false, SINCE);
  eq([w.state, w.daysLeft], ['waiting', 5], 'newbie waiting 剩 5 天');
  const d0 = sb.evNewbieStatus_('2026-09-10', '2026-10-10', false, SINCE);
  eq([d0.state, d0.overdueDays, d0.late], ['due', 0, false], 'newbie 滿月當天 due');
  const late = sb.evNewbieStatus_('2026-09-10', '2026-10-20', false, SINCE);
  eq([late.overdueDays, late.late], [10, true], 'newbie 逾期 10 天 late');
  eq(sb.evNewbieStatus_('2026-09-10', '2026-10-20', true, SINCE).state, 'done', 'newbie done');
}
eq(sb.evNewbieScore_([5, 5, 5, 5, 5, 5], new Array(14).fill(5)), { attitude: 30, performance: 70, total: 100 }, 'newbie 滿分');
eq(sb.evNewbieScore_([3, 3, 3, 3, 3, 3], new Array(14).fill(4)), { attitude: 18, performance: 56, total: 74 }, 'newbie 中段');
eq(sb.evNewbieScore_([5, 5, 0, 5, 5, 5], new Array(14).fill(5)), { attitude: null, performance: 70, total: null }, 'newbie 有 0 分');
eq(sb.evNewbieScore_([], []), { attitude: null, performance: null, total: null }, 'newbie 空');

// ── 6. 一人一季彙總（舊 aggregateRatee 案例＋細項）──
{
  // 計時：態度 [20,22]、表現 [30,28]（各一位評分者一題總分的寫法改成星等陣列）
  const r = sb.evAggregate_({ kind: 'pt', att: [[20], [22]], perf: [[30], [28]] });
  eq([r.attitude, r.performance, r.total, r.performanceCounted, r.attCount, r.perfCount], [21, 29, 50, 1 === 1, 2, 2], 'agg 計時');
}
{
  const r = sb.evAggregate_({ kind: 'ft', att: [[18], [20]], kpiItems: [{ key: 'k', weight: 70, type: '技能' }], kpiSel: { k: 'A' } });
  eq([sb.evRound1_(r.attitude), r.performance, sb.evRound1_(r.total), r.perfCount], [22.8, 70, 92.8, 1], 'agg 正職 ×1.2＋KPI');
}
{
  const r = sb.evAggregate_({ kind: 'ft', att: [[20]], kpiItems: [{ key: 'k', weight: 70, type: '技能' }], kpiSel: {} });
  eq([r.attitude, r.performance, r.performanceCounted, r.total, r.perfCount], [24, null, false, 24, 0], 'agg 正職 KPI 未評只算態度');
}
{
  const r = sb.evAggregate_({ kind: 'ft', att: [[25]], kpiItems: [{ key: 'k', weight: 70, type: '技能' }], kpiSel: { k: 'A' }, adj: { att: 10, perf: 10 } });
  eq([r.total, r.subtotal], [100, 100], 'agg 調整後封頂 100');
}
{
  const r = sb.evAggregate_({ kind: 'pt', att: [], perf: [] });
  ok(r.attitude === null && r.total === null && r.grade === null && r.wageIdx === -1, 'agg 無人評');
}
{
  const r = sb.evAggregate_({ kind: 'pt', att: [[20]], perf: [[30]], adj: { att: 2, perf: -3 } });
  eq([r.total, r.subtotal, r.adjAtt, r.adjPerf], [49, 50, 2, -3], 'agg ± 調整');
}
{
  // 細項：兩位評分者 6 題態度 → 每題平均；正職每題×1.2
  const r = sb.evAggregate_({ kind: 'ft', att: [[5, 4, 3, 5, 4], [3, 4, 5, 5, 2]] });
  eq(r.attItems.map(sb.evRound1_), [4.8, 4.8, 4.8, 6, 3.6], 'agg 正職態度細項×1.2');
  eq(sb.evRound1_(r.attItems.reduce((a, b) => a + b, 0)), sb.evRound1_(r.attitude), 'agg 細項加總＝態度分');
}
{
  // 已定稿／匯入值優先，不再套係數
  const r = sb.evAggregate_({ kind: 'ft', att: [[5, 5, 5, 5, 5]], manual: { att: 27.5, perf: 60 } });
  eq([r.attitude, r.performance, r.total], [27.5, 60, 87.5], 'agg 手動值優先');
}
{
  const tiers = [['86 分以上', '280'], ['85 分以下', '200']];
  const r = sb.evAggregate_({ kind: 'pt', att: [[30]], perf: [[60]], wageTiers: tiers, gradeTable: [{ grade: 'A', min: 90, base: 1 }, { grade: 'B', min: 0, base: 0.5 }] });
  eq([r.total, r.wageIdx, r.grade, r.bonusBase], [90, 0, 'A', 1], 'agg 時薪與品牌等第表');
}
{
  // 空白評分（未評）不算一票
  const r = sb.evAggregate_({ kind: 'pt', att: [[20], []], perf: [[30], null].filter(Boolean) });
  eq([r.attCount, r.attitude], [1, 20], 'agg 空陣列不算一票');
}

// ── 7. 前端共用檔與 .gs 一致 ──
{
  const front = await import('../modules/eval-shared/calc.js');
  const pairs = [['evRound1', 'evRound1_'], ['evKpiItemScore', 'evKpiItemScore_'], ['evKpiTotal', 'evKpiTotal_'], ['evRaterTotal', 'evRaterTotal_']];
  const cases = [[15.05], [{ weight: 20, type: '技能' }, 'B'], [KPI10, { sales: 'A' }], [[5, 4, 3]]];
  pairs.forEach(([f, g], i) => eq(front[f](...cases[i]), sb[g](...cases[i]), 'front=gs ' + f));
  const tiers = [['96 分以上', '340'], ['81～85 分', '230'], ['65 分以下', '法定']];
  [98, 83.4, 40, null].forEach((sc) => eq(front.evWageTierIndex(tiers, sc), sb.evWageTierIndex_(tiers, sc), 'front=gs 時薪落點 ' + sc));
  ok(front.EV_KPI_SKILL_FACTOR.B === sb.EV_KPI_SKILL_FACTOR.B && front.EV_FT_ATT_FACTOR === sb.EV_FT_ATT_FACTOR, 'front=gs 常數');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
