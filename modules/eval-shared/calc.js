/**
 * modules/eval-shared/calc.js — 績效評核前端即時小計用（例如主管打 KPI 時的合計）。
 * 正式分數一律由後端 apps-script/platform/EvalCalc.gs 計算；本檔只放畫面需要即時顯示的少數函式，
 * 與 .gs 同名函式（去掉結尾底線）行為必須一致，test/eval-calc.test.mjs 會比對。
 */
'use strict';

export const EV_FT_ATT_FACTOR = 1.2;
export const EV_KPI_SKILL_FACTOR = { A: 1, B: 0.8, C: 0.6, D: 0.4 };

export function evRound1(n) { return Math.round(n * 10) / 10; }

export function evRaterTotal(scores) {
  if (!scores || scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0);
}

export function evKpiItemScore(item, sel) {
  const w = Number(item.weight) || 0;
  if (item.type === '執行力') {
    if (sel === '完成') return w;
    if (sel === '未完成') return 0;
    return null;
  }
  const f = EV_KPI_SKILL_FACTOR[sel];
  return f === undefined ? null : evRound1(w * f);
}

export function evKpiTotal(items, selByKey) {
  if (!items || !items.length) return null;
  const sels = selByKey || {};
  let total = 0;
  for (const it of items) {
    const v = sels[it.key];
    const s = evKpiItemScore(it, (v && typeof v === 'object') ? v.sel : v);
    if (s === null) return null;
    total += s;
  }
  return evRound1(total);
}

/** 時薪落點：tiers＝[[區間文字, 時薪], …]，以下限門檻判定，容小數；無 → -1 */
export function evWageTierIndex(tiers, score) {
  if (score === null || score === undefined || !Array.isArray(tiers)) return -1;
  let best = -1;
  let bestLow = -Infinity;
  tiers.forEach((row, i) => {
    const s = String((row && row[0]) || '');
    const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    let low;
    if (/以下|以內/.test(s)) low = -Infinity;
    else if (/以上/.test(s)) low = nums.length ? nums[0] : -Infinity;
    else if (nums.length >= 2) low = Math.min(nums[0], nums[1]);
    else if (nums.length === 1) low = nums[0];
    else low = -Infinity;
    if (low <= score && low >= bestLow) { best = i; bestLow = low; }
  });
  return best;
}
