/**
 * modules/inspection/scoring.js — 營運巡檢算分（純函式）
 * 公式逐條照舊站 mala-inspection js/scoring.js（docs/spec.md §4；Eason 2026-07-14 定案 D1–D3），
 * 差別只有「題目由參數傳入」（各品牌一份題庫）。
 *
 * answers：{ scores:{'form.cat.n':0..5}, bonuses:{k:true}, freeBonuses:{k:['事實',…]},
 *            penalties:{k:{checked,note}}, reasons:{k:'原因'}, photos:{k:[檔號,…]} }
 * 沒評＝不計分：只算實際評過的題；分類權重按評過的重新正規化；一題都沒評的表＝未評。
 */
'use strict';

import { GRADE_BANDS } from './questions.js';

export function itemKey(formId, catId, n) { return formId + '.' + catId + '.' + n; }
export function round1(x) { return Math.round(x * 10) / 10; }

function computeCategory(form, cat, ans) {
  const scores = ans.scores || {};
  let sum = 0, answered = 0;
  cat.items.forEach((it) => {
    const k = itemKey(form.id, cat.id, it.n);
    if (k in scores && scores[k] != null) { sum += Number(scores[k]); answered++; }
  });
  const max = answered * 5;
  return { id: cat.id, name: cat.name, weight: cat.weight, sum, answered, max, ratio: answered ? sum / max : null };
}

/** 每張表加分總額上限（2026-10-30 Eason 照推薦）：加分題、自由填寫加分合計最多 +20；超過的不計，舊報告存的摘要不重算 */
export const BONUS_CAP = 20;

function computeBonus(form, ans) {
  let total = 0; const detail = [];
  form.categories.filter((c) => c.role === 'bonus').forEach((cat) => {
    cat.items.forEach((it) => {
      const k = itemKey(form.id, cat.id, it.n);
      if (it.type === 'bonus') {
        if (ans.bonuses && ans.bonuses[k]) { total += it.points; detail.push({ key: k, points: it.points, text: it.text }); }
      } else if (it.type === 'bonus_free') {
        const arr = (ans.freeBonuses && ans.freeBonuses[k]) || [];
        arr.filter((s) => s && String(s).trim()).slice(0, it.max).forEach((s) => {
          total += it.points; detail.push({ key: k, points: it.points, text: s });
        });
      }
    });
  });
  const raw = total;
  if (total > BONUS_CAP) total = BONUS_CAP;
  return { total, raw, capped: raw > BONUS_CAP, detail };
}

function computePenalty(form, ans) {
  let total = 0; const detail = [];
  form.categories.filter((c) => c.role === 'penalty').forEach((cat) => {
    cat.items.forEach((it) => {
      const k = itemKey(form.id, cat.id, it.n);
      const p = ans.penalties && ans.penalties[k];
      if (p && p.checked) { total += it.points; detail.push({ key: k, points: it.points, text: it.text, note: p.note || '' }); }
    });
  });
  return { total, detail };
}

export function computeForm(form, ans) {
  ans = ans || {};
  const cats = form.categories.filter((c) => c.role === 'scored').map((c) => computeCategory(form, c, ans));
  const answeredCats = cats.filter((c) => c.ratio !== null);
  const bonus = computeBonus(form, ans);
  const penalty = computePenalty(form, ans);
  let base = null, score = null;
  if (answeredCats.length) {
    const wsum = answeredCats.reduce((s, c) => s + c.weight, 0);
    base = answeredCats.reduce((s, c) => s + c.ratio * c.weight, 0) / wsum * 100;
    score = base + bonus.total;
  }
  return { formId: form.id, name: form.name, categories: cats, base, bonus, penalty, evaluated: answeredCats.length > 0,
    score, scoreRounded: score == null ? null : round1(score) };
}

export function gradeOf(score) {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return '未達';
}

/** 缺失＝評分題給不到 5 分、重大缺失「發生」、加重扣分勾選 */
export function deficiencies(forms, ans) {
  ans = ans || {};
  const out = [];
  forms.forEach((f) => f.categories.forEach((c) => c.items.forEach((it) => {
    const k = itemKey(f.id, c.id, it.n);
    let hit = false;
    if (c.role === 'scored') { const v = ans.scores && ans.scores[k]; hit = v != null && Number(v) < 5; }
    else if (c.role === 'penalty') hit = !!(ans.penalties && ans.penalties[k] && ans.penalties[k].checked);
    if (!hit) return;
    out.push({ key: k, form: f.name, cat: c.name, n: it.n, text: it.text,
      score: c.role === 'scored' ? Number(ans.scores[k]) : null, points: c.role === 'penalty' ? it.points : null,
      reason: (ans.reasons && ans.reasons[k]) || (ans.penalties && ans.penalties[k] && ans.penalties[k].note) || '',
      photos: (ans.photos && ans.photos[k]) || [] });
  })));
  return out;
}

export function computeAll(forms, ans) {
  ans = ans || {};
  const byForm = {};
  forms.forEach((f) => { byForm[f.id] = computeForm(f, ans); });
  const op = forms.filter((f) => f.inOperational);
  const evaluated = op.filter((f) => byForm[f.id].evaluated);
  const penaltyTotal = op.reduce((s, f) => s + byForm[f.id].penalty.total, 0);
  // 營運總分＝已評的表（服務／環境／菜色）平均 − 加重扣分；都沒評＝未評
  let operationalScore = null, operationalGrade = '未評';
  if (evaluated.length) {
    const avg = evaluated.reduce((s, f) => s + byForm[f.id].score, 0) / evaluated.length;
    operationalScore = round1(avg - penaltyTotal);
    operationalGrade = gradeOf(operationalScore);
  }
  const mg = byForm.management;
  const managementScore = mg && mg.evaluated ? round1(mg.score) : null;
  const managementGrade = mg && mg.evaluated ? gradeOf(managementScore) : '未評';
  return { byForm, operationalScore, operationalGrade, penaltyTotal, managementScore, managementGrade };
}

/** 送出時存進後端的摘要（清單畫面直接用，不必重算） */
export function summaryOf(forms, ans) {
  const r = computeAll(forms, ans);
  return {
    operationalScore: r.operationalScore, operationalGrade: r.operationalGrade,
    managementScore: r.managementScore, managementGrade: r.managementGrade, penaltyTotal: r.penaltyTotal,
    forms: forms.map((f) => ({ id: f.id, name: f.name, score: r.byForm[f.id].scoreRounded })),
    defects: deficiencies(forms, ans).length
  };
}
