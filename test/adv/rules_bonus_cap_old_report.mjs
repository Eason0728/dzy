// node test/adv/rules_bonus_cap_old_report.mjs —— 對抗驗證 2026-10-30 規則 5「巡檢加分題封頂 +20」
// 攻擊：封頂前送出的舊報告（加分 24 已算進存檔的分數）在新版報告頁打開——總分用存檔摘要（不重算，對），
// 但同一列的「加分 ＋N」是 computeAll 現算、會被封成 20 → 同一張報告表內自相矛盾（分數含 24、文字寫 ＋20）。
// 另驗前後端一致：scoring.js BONUS_CAP＝Inspect.gs INSP_BONUS_CAP；bank 擋線 ×2 一致。
'use strict';
import fs from 'node:fs';
import { defaultForms } from '../../modules/inspection/questions.js';
import { computeAll, summaryOf, BONUS_CAP } from '../../modules/inspection/scoring.js';

let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const gs = fs.readFileSync(new URL('../../apps-script/platform/Inspect.gs', import.meta.url), 'utf8');
const capBack = Number(/var INSP_BONUS_CAP = (\d+)/.exec(gs)[1]);
ok(capBack === BONUS_CAP, '前後端 cap 一致', { front: BONUS_CAP, back: capBack });
ok(/INSP_BONUS_MAX_POSSIBLE = INSP_BONUS_CAP \* 2/.test(gs) && fs.readFileSync(new URL('../../modules/inspection/views/bank.js', import.meta.url), 'utf8').includes('BONUS_CAP * 2'), '題目設定擋線前後端都是 cap×2');

// 舊報告：management 表加分 10＋2×5＝20 已到頂；把題目快照改成加分 12＋2×6（可拿 24），模擬舊版沒封頂時送出的報告
const forms = defaultForms('mala');
const mg = forms.find((f) => f.id === 'management');
const bonusCat = mg.categories.find((c) => c.role === 'bonus');
bonusCat.items[0].points = 12; bonusCat.items[1].max = 6;
const ans = { scores: { 'management.finance.7': 5, 'management.hr.4': 5, 'management.admin.1': 5 }, bonuses: { 'management.bonus.1': true },
  freeBonuses: { 'management.bonus.2': ['a', 'b', 'c', 'd', 'e', 'f'] }, penalties: {}, reasons: {}, photos: {} };
const now = computeAll(forms, ans).byForm.management;
ok(now.bonus.raw === 24 && now.bonus.total === 20 && now.bonus.capped === true, '新版現算：raw 24、封成 20', now.bonus);
// 舊版存檔摘要（沒封頂）：分數＝base＋24
const base = now.score - now.bonus.total;
const oldStoredScore = Math.round((base + 24) * 10) / 10;
ok(oldStoredScore !== now.scoreRounded, '舊報告存的分數（含 24）≠ 新版現算（含 20）→ 報告頭用存檔、不重算：對', { old: oldStoredScore, now: now.scoreRounded });
// list.js 報告頁：分數欄用 stored.score、說明欄用 fr.bonus.total → 同一列寫「分數含 24」與「加分 ＋20」
const view = fs.readFileSync(new URL('../../modules/inspection/views/list.js', import.meta.url), 'utf8');
ok(view.includes('const score = stored ? stored.score : fr.scoreRounded') && view.includes('stored.bonus') && view.includes('fr.bonus.raw') && !view.includes('；加分 ＋${fr.bonus.total}'), '（佐證）報告頁分數欄用存檔；加分文字用存檔 bonus、舊報告沒存就用 raw（2026-10-30 修）');
// 舊報告（封頂前送出）沒有 stored.bonus → 報告頁用 raw；新報告 summaryOf 存 bonus（封頂後）→ 用它
const shownBonus = now.bonus.raw, impliedBonus = oldStoredScore - base;
ok(summaryOf(forms, ans).forms.find((f) => f.id === 'management').bonus === 20, '新報告的摘要 forms[].bonus＝封頂後的 20（與分數欄一致）');
ok(shownBonus === impliedBonus, '【低：自相矛盾】舊報告在新版報告頁：分數欄含加分 ' + impliedBonus + '、同列文字卻寫「加分 ＋' + shownBonus + '」；舊報告的加分文字應用 raw（或摘要）而不是封頂值', { shownBonus, impliedBonus });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
