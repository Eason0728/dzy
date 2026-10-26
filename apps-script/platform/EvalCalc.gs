/**
 * EvalCalc.gs — 績效評核：計分純函式（docs/eval/spec.md §1.1、task.md P1）
 * 由舊站 mala-eval 的 js/scoring.js、js/newbie.js 逐函式移植，規則一條不改：
 *   計時＝態度 30（6 題原始星數）＋表現 70（互評平均）；正職＝態度 30（星數×1.2）＋主管 KPI 70；
 *   ± 調整、上限 100、等第 A/B/C/D、時薪級距落點、新人考核（單人直接加總）。
 * 不碰任何分頁、不讀時鐘（日期一律由呼叫端傳入 'YYYY-MM-DD'），測試 test/eval-calc.test.mjs。
 * 前端即時小計用的 modules/eval-shared/calc.js 與這裡的同名函式逐字比對（測試會檢查）。
 */

var EV_SCORE_CAP = 100;
var EV_FT_ATT_FACTOR = 1.2;
var EV_KPI_SKILL_FACTOR = { A: 1, B: 0.8, C: 0.6, D: 0.4 };
// 等第表預設值（舊站 GRADE_TABLE）；正式值每個品牌一張存 ev_grade，這份只當種子。
var EV_GRADE_DEFAULT = [
  { grade: 'A', min: 85, base: 1 },
  { grade: 'B', min: 75, base: 0.7 },
  { grade: 'C', min: 65, base: 0.5 },
  { grade: 'D', min: 0, base: 0 }
];

// ── 基本運算 ──
function evRaterTotal_(scores) {
  if (!scores || scores.length === 0) return null;
  return scores.reduce(function (a, b) { return a + b; }, 0);
}
function evAverageTotals_(list) {
  if (!list || list.length === 0) return null;
  return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
}
// 每題平均（多位評分者，長度同題數）
function evAverageItems_(scoresList) {
  if (!scoresList || scoresList.length === 0) return null;
  var n = scoresList[0].length;
  var sums = [];
  for (var i = 0; i < n; i++) sums.push(0);
  scoresList.forEach(function (s) { for (var j = 0; j < n; j++) sums[j] += s[j]; });
  return sums.map(function (x) { return x / scoresList.length; });
}
function evRound1_(n) { return Math.round(n * 10) / 10; }
function evCapScore_(v) {
  return (v === null || v === undefined) ? v : Math.min(evRound1_(v), EV_SCORE_CAP);
}
function evFtAttitudeScale_(v) {
  return (v === null || v === undefined) ? v : v * EV_FT_ATT_FACTOR;
}

// 實際分數：態度 null → null；表現 null → 只計態度；皆含 ± 調整
function evFinalScore_(o) {
  var att = o.attitude, perf = o.performance;
  var aAdj = o.attitudeAdjust || 0, pAdj = o.performanceAdjust || 0;
  if (att === null || att === undefined) return { score: null, performanceCounted: false };
  if (perf === null || perf === undefined) return { score: att + aAdj, performanceCounted: false };
  return { score: att + aAdj + perf + pAdj, performanceCounted: true };
}

// 等第：table 省略＝預設表；依 min 由高到低找第一個 score >= min
function evGradeFor_(score, table) {
  if (score === null || score === undefined) return null;
  var t = (table && table.length ? table : EV_GRADE_DEFAULT).slice().sort(function (a, b) { return b.min - a.min; });
  for (var i = 0; i < t.length; i++) if (score >= t[i].min) return t[i];
  return t[t.length - 1];
}

// 時薪級距落點：tiers＝[[區間文字, 時薪], …]，以下限門檻判定，容小數；無 → -1
function evWageTierIndex_(tiers, score) {
  if (score === null || score === undefined || !Array.isArray(tiers)) return -1;
  var best = -1, bestLow = -Infinity;
  tiers.forEach(function (row, i) {
    var s = String((row && row[0]) || '');
    var nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    var low;
    if (/以下|以內/.test(s)) low = -Infinity;
    else if (/以上/.test(s)) low = nums.length ? nums[0] : -Infinity;
    else if (nums.length >= 2) low = Math.min(nums[0], nums[1]);
    else if (nums.length === 1) low = nums[0];
    else low = -Infinity;
    if (low <= score && low >= bestLow) { best = i; bestLow = low; }
  });
  return best;
}

// ── 正職 KPI ──
// item {key, weight, type:'技能'|'執行力'}；sel 技能 'A'~'D'、執行力 '完成'|'未完成'；未評 → null
function evKpiItemScore_(item, sel) {
  var w = Number(item.weight) || 0;
  if (item.type === '執行力') {
    if (sel === '完成') return w;
    if (sel === '未完成') return 0;
    return null;
  }
  var f = EV_KPI_SKILL_FACTOR[sel];
  return f === undefined ? null : evRound1_(w * f);
}
// selByKey 值可為字串或 {sel, actual}；任一項未評 → null
function evKpiTotal_(items, selByKey) {
  if (!items || !items.length) return null;
  var sels = selByKey || {};
  var total = 0;
  for (var i = 0; i < items.length; i++) {
    var v = sels[items[i].key];
    var s = evKpiItemScore_(items[i], (v && typeof v === 'object') ? v.sel : v);
    if (s === null) return null;
    total += s;
  }
  return evRound1_(total);
}

// ── 新人考核（日期全用 'YYYY-MM-DD' 字串，不受伺服器時區影響）──
function evYmd_(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function evYmdStr_(y, m, d) {
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}
function evDayNum_(s) {
  var p = evYmd_(s);
  return p ? Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000) : null;
}
// 到職滿一個月＝下個月同一日；沒有那一日取當月最後一天（1/31→2/28）
function evDueDate_(hire) {
  var p = evYmd_(hire);
  if (!p) return null;
  var y = p.m === 12 ? p.y + 1 : p.y, m = p.m === 12 ? 1 : p.m + 1;
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return evYmdStr_(y, m, Math.min(p.d, last));
}
function evDaysBetween_(a, b) {
  var x = evDayNum_(a), y = evDayNum_(b);
  return (x === null || y === null) ? null : y - x;
}
// since＝保險絲（到職日早於這天一律不觸發）；today 'YYYY-MM-DD'
function evNewbieStatus_(hireDate, today, done, since) {
  var hire = evYmd_(hireDate) ? String(hireDate).slice(0, 10) : null;
  if (!hire) return { state: 'none' };
  if (since && evDayNum_(hire) < evDayNum_(since)) return { state: 'none' };
  var dueOn = evDueDate_(hire);
  if (done) return { state: 'done', hire: hire, dueOn: dueOn };
  var diff = evDaysBetween_(dueOn, today);
  if (diff < 0) return { state: 'waiting', hire: hire, dueOn: dueOn, daysLeft: -diff };
  return { state: 'due', hire: hire, dueOn: dueOn, overdueDays: diff, late: diff > 7 };
}
// 單一評分者直接加總；任一題組沒填完（含 0）→ 該題組與總分 null
function evNewbieScore_(att, perf) {
  function filled(a) { return Array.isArray(a) && a.length > 0 && a.every(function (v) { return v > 0; }); }
  var a = filled(att) ? evRaterTotal_(att) : null;
  var p = filled(perf) ? evRaterTotal_(perf) : null;
  return { attitude: a, performance: p, total: (a === null || p === null) ? null : evCapScore_(a + p) };
}

// ── 一人一季彙總（舊站 admin-page buildRows＋eval-page buildMyQuarters 的同一套規則）──
// o = {
//   kind: 'pt'|'ft',
//   att: [[星…], …]   互評＋自評的態度星等（自評算一票），
//   perf: [[星…], …]  計時用：互評＋自評的表現星等；正職忽略，
//   kpiItems, kpiSel  正職用：範本項目與主管評分，
//   adj: {att, perf}  主管 ± 調整，
//   manual: {att, perf}  已定稿／匯入的最終分（有值就直接用，不再套係數），
//   wageTiers, gradeTable
// }
// 回傳 {attitude, performance, attItems, perfItems, adjAtt, adjPerf, subtotal, total, grade, wageIdx, attCount, perfCount}
function evAggregate_(o) {
  var kind = o.kind === 'ft' ? 'ft' : 'pt';
  var manual = o.manual || {};
  var adj = o.adj || {};
  var attList = (o.att || []).filter(function (s) { return evRaterTotal_(s) !== null; });
  var perfList = (o.perf || []).filter(function (s) { return evRaterTotal_(s) !== null; });

  var attItems = evAverageItems_(attList);
  if (attItems && kind === 'ft') attItems = attItems.map(evFtAttitudeScale_);
  var attitude;
  if (manual.att !== null && manual.att !== undefined && manual.att !== '') attitude = Number(manual.att);
  else {
    attitude = evAverageTotals_(attList.map(evRaterTotal_));
    if (attitude !== null && kind === 'ft') attitude = evFtAttitudeScale_(attitude);
  }

  var perfItems = null, performance;
  if (manual.perf !== null && manual.perf !== undefined && manual.perf !== '') performance = Number(manual.perf);
  else if (kind === 'ft') performance = evKpiTotal_(o.kpiItems, o.kpiSel);
  else { performance = evAverageTotals_(perfList.map(evRaterTotal_)); perfItems = evAverageItems_(perfList); }
  if (kind === 'ft' && o.kpiItems && o.kpiItems.length) {
    var sels = o.kpiSel || {};
    perfItems = o.kpiItems.map(function (it) {
      var v = sels[it.key];
      return evKpiItemScore_(it, (v && typeof v === 'object') ? v.sel : v);
    });
  }

  var adjAtt = Number(adj.att) || 0, adjPerf = Number(adj.perf) || 0;
  var fin = evFinalScore_({ attitude: attitude, attitudeAdjust: adjAtt, performance: performance, performanceAdjust: adjPerf });
  var noAdj = evFinalScore_({ attitude: attitude, performance: performance });
  var total = evCapScore_(fin.score);
  var g = evGradeFor_(total, o.gradeTable);
  return {
    kind: kind,
    attitude: attitude, performance: performance,
    attItems: attItems, perfItems: perfItems,
    adjAtt: adjAtt, adjPerf: adjPerf,
    performanceCounted: fin.performanceCounted,
    subtotal: noAdj.score === null ? null : evRound1_(noAdj.score),
    total: total,
    grade: g ? g.grade : null,
    bonusBase: g ? g.base : null,
    wageIdx: evWageTierIndex_(o.wageTiers, total),
    attCount: attList.length,
    perfCount: kind === 'ft' ? (performance === null ? 0 : 1) : perfList.length
  };
}
