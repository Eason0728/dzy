// test/dd/hr_calc.mjs —— 人資部門（甲組）後端資料帶入測試：真的 .gs 在 vm 裡跑，資料每次隨機重抽（E2E_SEED 可重現）。
// 每個計算（互評平均、正職 ×1.2、KPI、± 調整、上限 100、等第、時薪落點、新人考核到期日／分數、誰能審誰）由本檔照規格自己算，
// 逐筆跟後端回傳比對；不 import 系統計算模組。跑法：node test/dd/hr_calc.mjs（E2E_SEED=123 重現）。
'use strict';

import { post, seedFromEnv, loginAs, claim, makeRng } from './hr_lib.mjs';
import { buildBackend } from './hr_backend.mjs';
import { TODAY_FILL, TODAY_CLOSED, TODAY_PUBLISH, QUARTER, NEWBIE_SINCE } from './hr_dataset.mjs';

const seed = seedFromEnv();
console.log('SEED ' + seed + '（重現：E2E_SEED=' + seed + ' node test/dd/hr_calc.mjs）');
let passed = 0, failed = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { passed++; return true; }
  failed++; fails.push(label);
  console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra).slice(0, 400) : ''));
  return false;
}
const near = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : (b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < 1e-9);

const be = buildBackend(seed);
const { sb, ds, emps, keyOf, tok } = be;
const rng = makeRng(seed ^ 0x5151);
const byKey = Object.fromEntries(ds.people.map((p) => [p.key, p]));
const kindOf = (p) => (p.title === 'pt' ? 'pt' : 'ft');
const A = be.app.admin;
const ORG_TITLE = { pt: ['store', 1], ft: ['store', 2], sm: ['store', 3], am: ['store', 4], fm: ['store', 3], rdd: ['store', 4], ofs: ['office', 1], osv: ['office', 2], odir: ['office', 3], hs: ['hq', 1], hm: ['hq', 2], ceo: ['hq', 3], gm: ['hq', 4], chair: ['hq', 5] };

// ─────────────────────────────────────────────────────────────
// 自己照規格算的計分（docs/eval/spec.md、EvalCalc 檔頭規則文字；不呼叫系統函式）
// ─────────────────────────────────────────────────────────────
const r1 = (x) => Math.round(x * 10) / 10;          // JS .5 進位（同畫面）
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
function expectKpi(items, sel) {
  let t = 0;
  for (const it of items) {
    const v = sel[it.key]; const s = v && v.sel;
    if (it.type === '執行力') { if (s === '完成') t += it.weight; else if (s === '未完成') t += 0; else return null; }
    else { const f = { A: 1, B: 0.8, C: 0.6, D: 0.4 }[s]; if (f === undefined) return null; t += r1(it.weight * f); }
  }
  return r1(t);
}
function expectGrade(total, table) {
  if (total === null) return null;
  const t = table.slice().sort((a, b) => b.min - a.min);
  for (const g of t) if (total >= g.min) return g.grade;
  return t[t.length - 1].grade;
}
function expectWageIdx(rows, total) {
  if (total === null) return -1;
  let best = -1, bestLow = -Infinity;
  rows.forEach((r, i) => {
    const s = r[0]; const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    let low;
    if (/以下|以內/.test(s)) low = -Infinity; else if (/以上/.test(s)) low = nums[0]; else if (nums.length >= 2) low = Math.min(nums[0], nums[1]); else low = nums.length ? nums[0] : -Infinity;
    if (low <= total && low >= bestLow) { best = i; bestLow = low; }
  });
  return best;
}
/** 一人一季（live）預期：att 列＝同事＋自評；pt 表現＝同事＋自評；ft 表現＝KPI */
function expectLive(p) {
  const kind = kindOf(p);
  const peersFor = ds.peer.filter((r) => be.applied.peer.find((a) => a.rater === r.rater && a.ok)).flatMap((r) => r.ratings.filter((x) => x.ratee === p.key));
  const selfRow = ds.self.find((s) => s.emp === p.key && be.applied.self.find((a) => a.emp === s.emp && a.ok));
  const supRow = ds.sup.find((s) => s.emp === p.key && be.applied.sup.find((a) => a.emp === s.emp && a.ok));
  if (!peersFor.length && !selfRow && !supRow) return null;
  const attLists = peersFor.map((x) => x.att).concat(selfRow ? [selfRow.att] : []);
  const perfLists = kind === 'pt' ? peersFor.map((x) => x.perf).concat(selfRow ? [selfRow.perf] : []) : [];
  let attitude = avg(attLists.map(sum));
  if (attitude !== null && kind === 'ft') attitude = attitude * 1.2;
  let performance;
  if (kind === 'ft') performance = expectKpi(ds.tpl[p.brand].ft, (supRow && supRow.kpi) || {});
  else performance = avg(perfLists.map(sum));
  const adjAtt = supRow ? supRow.adj_att : 0, adjPerf = supRow ? supRow.adj_perf : 0;
  let total = null, subtotal = null;
  if (attitude !== null) {
    subtotal = r1(performance === null ? attitude : attitude + performance);
    total = Math.min(r1(performance === null ? attitude + adjAtt : attitude + adjAtt + performance + adjPerf), 100);
  }
  const attItems = attLists.length ? attLists[0].map((_, j) => avg(attLists.map((l) => l[j])) * (kind === 'ft' ? 1.2 : 1)) : null;
  return { kind, attitude, performance, adjAtt, adjPerf, subtotal, total, grade: expectGrade(total, ds.grade[p.brand]), wageIdx: expectWageIdx(ds.wage[p.brand], total),
    attCount: attLists.length, perfCount: kind === 'ft' ? (performance === null ? 0 : 1) : perfLists.length, peerCount: peersFor.length, attItems, selfRow, supRow,
    peerAttItems: peersFor.length ? peersFor[0].att.map((_, j) => avg(peersFor.map((x) => x.att[j])) * (kind === 'ft' ? 1.2 : 1)) : null };
}

// ═══ A. 單位結果＋個人明細：每人每季逐欄比對 ═══
const unitsAll = Object.keys(ds.byUnit);
let fewSeen = 0, manySeen = 0, hundredSeen = 0, gradesSeen = new Set();
for (const u of unitsAll) {
  const res = post(sb, 'evUnitResults', { unit: u, quarter: QUARTER }, A);
  if (!ok(res.ok, 'A evUnitResults ' + u, res)) continue;
  const rows = Object.fromEntries(res.data.rows.map((r) => [r.emp, r]));
  for (const p of ds.byUnit[u]) {
    const row = rows[emps[p.key]];
    if (!ok(!!row, `A ${u} 單位結果列出 ${p.key}`)) continue;
    const exp = expectLive(p);
    if (!exp) { ok(row.result === null, `A ${p.key} 沒人評 → result null`, row.result); continue; }
    const r = row.result;
    ok(r && near(r.attitude, exp.attitude) && near(r.performance, exp.performance) && near(r.total, exp.total) && near(r.subtotal, exp.subtotal), `A ${p.key}(${exp.kind}) 態度／表現／小計／實際分數`, { got: r, exp });
    ok(r && r.grade === exp.grade && r.wageIdx === exp.wageIdx, `A ${p.key} 等第／時薪落點`, { got: [r.grade, r.wageIdx], exp: [exp.grade, exp.wageIdx] });
    ok(r && r.attCount === exp.attCount && r.perfCount === exp.perfCount && near(r.adjAtt, exp.adjAtt) && near(r.adjPerf, exp.adjPerf), `A ${p.key} 份數／調整`, { got: r, exp });
    if (exp.total === 100) hundredSeen++;
    if (exp.grade) gradesSeen.add(exp.grade);
    // 明細（admin 看）：同事少於兩位 → 逐題與自評都不回；兩位以上 → 逐題平均逐格比對
    const det = post(sb, 'evPersonDetail', { emp: emps[p.key], quarter: QUARTER }, A);
    if (!ok(det.ok && det.data.result, `A 明細 ${p.key}`, det)) continue;
    const f = det.data.result;
    if (exp.peerCount < 2) {
      fewSeen++;
      ok(f.attItems === null && f.perfItems === null && f.peerAttItems === null && f.selfAtt === null && f.itemsHidden === true, `A ${p.key} 同事 ${exp.peerCount} 位 → 明細不回逐題／自評`, f);
    } else {
      manySeen++;
      ok(Array.isArray(f.attItems) && f.attItems.every((v, j) => near(v, exp.attItems[j])), `A ${p.key} 逐題態度平均（含自評）`, { got: f.attItems, exp: exp.attItems });
      ok(Array.isArray(f.peerAttItems) && f.peerAttItems.every((v, j) => near(v, exp.peerAttItems[j])), `A ${p.key} 同事逐題平均`, { got: f.peerAttItems, exp: exp.peerAttItems });
      ok(exp.selfRow ? JSON.stringify(f.selfAtt) === JSON.stringify(exp.selfRow.att) : f.selfAtt === null, `A ${p.key} 自評原樣`, f.selfAtt);
    }
    // 任何回應不得出現評分者身分（rater 欄位）
    ok(!JSON.stringify(det).includes('"rater"'), `A ${p.key} 明細沒有 rater`);
  }
  // 填寫進度
  for (const p of ds.byUnit[u]) {
    const row = rows[emps[p.key]];
    const didPeer = be.applied.peer.some((a) => a.ok && a.rater === p.key);
    const didSelf = be.applied.self.some((a) => a.ok && a.emp === p.key);
    ok(row.peerDone === didPeer && row.selfDone === didSelf, `A ${p.key} 填寫進度 peer/self`, { row: [row.peerDone, row.selfDone], exp: [didPeer, didSelf] });
  }
  ok(!JSON.stringify(res).includes('"rater"'), `A ${u} 單位結果沒有 rater`);
}
console.log(`分層覆蓋：同事<2 位 ${fewSeen} 人、≥2 位 ${manySeen} 人、滿分 ${hundredSeen} 人、等第出現 ${[...gradesSeen].sort().join('')}`);
ok(fewSeen > 0 && manySeen > 0, 'A 分層：同事少於兩位與兩位以上都出現');

// ═══ B. 我的成績：公布閘門（10 號）、留言匿名、舊成績 ═══
for (const p of ds.people.filter((x) => ds.byUnit[x.unit])) {
  const t = tok(p.key);
  be.today = TODAY_FILL;
  const r1st = post(sb, 'evMyScores', {}, t);
  if (!ok(r1st.ok, `B evMyScores ${p.key}`, r1st)) continue;
  const hasHist = ds.hist.some((h) => h.emp === p.key);
  const qs1 = r1st.data.quarters.map((q) => q.quarter);
  ok(!qs1.includes(QUARTER), `B ${p.key} 1/3 看不到 ${QUARTER}`, qs1);
  ok(qs1.includes('2026-Q3') === hasHist, `B ${p.key} 舊成績 2026-Q3 ${hasHist ? '看得到' : '沒有'}`, qs1);
  if (hasHist) {
    const h = ds.hist.find((x) => x.emp === p.key); const q = r1st.data.quarters.find((x) => x.quarter === '2026-Q3');
    ok(near(q.total, h.result.total) && q.grade === expectGrade(h.result.total, ds.grade[p.brand]) && q.wageIdx === expectWageIdx(ds.wage[p.brand], h.result.total) && q.source === 'hist', `B ${p.key} 舊成績總分／等第／落點`, { q, h });
  }
  // 主管回饋在 10 號前不回
  const fbExp = ds.sup.find((s) => s.emp === p.key && s.feedback && be.applied.sup.find((a) => a.ok && a.emp === s.emp));
  ok(!r1st.data.feedback.some((f) => f.quarter === QUARTER), `B ${p.key} 1/3 看不到本季主管回饋`);
  be.today = TODAY_PUBLISH;
  const r2 = post(sb, 'evMyScores', {}, t);
  const exp = expectLive(p);
  const q4 = r2.data.quarters.find((x) => x.quarter === QUARTER);
  if (exp) {
    if (ok(!!q4, `B ${p.key} 1/12 看得到 ${QUARTER}`)) {
      ok(near(q4.total, exp.total) && near(q4.attitude, exp.attitude) && near(q4.performance, exp.performance) && q4.grade === exp.grade && q4.wageIdx === exp.wageIdx, `B ${p.key} 我的成績數字`, { q4, exp });
      ok(exp.peerCount < 2 ? (q4.attItems === null && q4.itemsHidden === true) : Array.isArray(q4.attItems), `B ${p.key} 本人逐題守門（同事 ${exp.peerCount} 位）`);
      ok(q4.feedback === ((exp.supRow && exp.supRow.feedback) || ''), `B ${p.key} 主管回饋文字`, [q4.feedback, exp.supRow && exp.supRow.feedback]);
    }
  } else ok(!q4, `B ${p.key} 沒資料就沒有 ${QUARTER}`);
  ok(!!fbExp === r2.data.feedback.some((f) => f.quarter === QUARTER), `B ${p.key} 1/12 主管回饋卡`, r2.data.feedback);
  // 留言：給我的夥伴留言（匿名 → from 空；不匿名 → 發話者姓名）、自己的話；給公司的話不回
  const toMe = ds.self.filter((s) => be.applied.self.find((a) => a.ok && a.emp === s.emp)).flatMap((s) => s.peers.filter((m) => m.to === p.key).map((m) => ({ text: m.msg, from: m.anon ? '' : byKey[s.emp].name })));
  const gotPeer = r2.data.messages.filter((m) => m.kind === 'peer').map((m) => ({ text: m.text, from: m.from }));
  ok(JSON.stringify(gotPeer.sort((a, b) => a.text.localeCompare(b.text))) === JSON.stringify(toMe.sort((a, b) => a.text.localeCompare(b.text))), `B ${p.key} 夥伴留言（匿名／不匿名）`, { gotPeer, toMe });
  const mySelf = ds.self.find((s) => s.emp === p.key && be.applied.self.find((a) => a.ok && a.emp === s.emp));
  ok(r2.data.messages.filter((m) => m.kind === 'self').map((m) => m.text).join('|') === ((mySelf && mySelf.note) || ''), `B ${p.key} 寫給自己的話`);
  ok(!r2.data.messages.some((m) => m.kind === 'company'), `B ${p.key} 給公司的話不回本人`);
  // 新人考核卡
  const nb = ds.newbie.find((n) => n.emp === p.key && be.applied.newbie.find((a) => a.ok && a.emp === n.emp));
  if (nb) ok(r2.data.newbie && near(r2.data.newbie.attitude, sum(nb.att)) && near(r2.data.newbie.performance, sum(nb.perf)) && near(r2.data.newbie.total, Math.min(100, r1(sum(nb.att) + sum(nb.perf)))), `B ${p.key} 新人考核分數＝單人直接加總`, r2.data.newbie);
  else ok(!r2.data.newbie, `B ${p.key} 沒有新人考核`);
  ok(!JSON.stringify(r2).includes('"rater"'), `B ${p.key} 我的成績沒有 rater`);
}
be.today = TODAY_FILL;

// ═══ C. 填寫窗、重複、跨店、題數閘門（後端擋） ═══
{
  const ui = byKey[ds.uiPt];
  const peersU = ds.byUnit[ui.unit].filter((x) => x !== ui);
  const target = peersU[0];
  const bk = ds.bank[ui.brand];
  const good = { ratee: emps[target.key], att: Array((kindOf(target) === 'pt' ? bk.pt_att : bk.ft_att).length).fill(3), perf: kindOf(target) === 'pt' ? Array(bk.pt_perf.length).fill(3) : [] };
  const t = tok(ui.key);
  be.today = TODAY_CLOSED;
  ok(post(sb, 'evPeerSubmit', { ratings: [good] }, t).error === 'window_closed', 'C 1/7 送互評 → window_closed');
  ok(post(sb, 'evSelfSubmit', { att: good.att, perf: good.perf }, t).error === 'window_closed', 'C 1/7 送自評 → window_closed');
  be.today = '2027-01-05';
  const hmT = tok(ds.hq.hm.key);
  ok(post(sb, 'evBankSave', { brand: ui.brand, set: 'pt_att', items: bk.pt_att }, hmT).error === 'window_closed', 'C 填寫期間改題庫 → window_closed');
  be.today = '2027-01-06';
  ok(post(sb, 'evBankSave', { brand: ui.brand, set: 'pt_att', items: bk.pt_att }, hmT).ok, 'C 1/6 可改題庫');
  be.today = TODAY_FILL;
  ok(post(sb, 'evPeerSubmit', { ratings: [Object.assign({}, good, { att: good.att.slice(1) })] }, t).error === 'bad_request', 'C 態度題數不對 → bad_request');
  ok(post(sb, 'evPeerSubmit', { ratings: [Object.assign({}, good, { att: good.att.map(() => 6) })] }, t).error === 'bad_request', 'C 星等 6 → bad_request');
  const other = ds.people.find((x) => ds.byUnit[x.unit] && x.unit !== ui.unit);
  if (other) ok(post(sb, 'evPeerSubmit', { ratings: [Object.assign({}, good, { ratee: emps[other.key] })] }, t).error === 'not_in_unit', 'C 評別店的人 → not_in_unit');
  ok(post(sb, 'evPeerSubmit', { ratings: [good, good] }, t).error === 'bad_request', 'C 同一人重複 → bad_request');
  ok(post(sb, 'evPeerSubmit', { ratings: [Object.assign({}, good, { ratee: emps[ui.key] })] }, t).error === 'not_in_unit', 'C 評自己 → 擋');
  // 總部同仁不在評核範圍
  const hqT = tok(ds.hq.it.key);
  ok(post(sb, 'evMe', {}, hqT).data.evaluable === false, 'C 總部一般同仁 evaluable=false');
  ok(post(sb, 'evPeerSubmit', { ratings: [good] }, hqT).error === 'forbidden', 'C 總部同仁送互評 → forbidden');
  // 已送出的人再送 → duplicate
  const done = be.applied.peer.find((a) => a.ok);
  if (done) {
    const dp = byKey[done.rater]; const tg = ds.byUnit[dp.unit].find((x) => x !== dp);
    const bk2 = ds.bank[dp.brand];
    ok(post(sb, 'evPeerSubmit', { ratings: [{ ratee: emps[tg.key], att: Array((kindOf(tg) === 'pt' ? bk2.pt_att : bk2.ft_att).length).fill(4), perf: kindOf(tg) === 'pt' ? Array(bk2.pt_perf.length).fill(4) : [] }] }, tok(dp.key)).error === 'duplicate', 'C 一季只能送一次互評 → duplicate');
  }
  const doneSelf = be.applied.self.find((a) => a.ok);
  if (doneSelf) { const dp = byKey[doneSelf.emp]; const bk2 = ds.bank[dp.brand]; ok(post(sb, 'evSelfSubmit', { att: Array((kindOf(dp) === 'pt' ? bk2.pt_att : bk2.ft_att).length).fill(4), perf: kindOf(dp) === 'pt' ? Array(bk2.pt_perf.length).fill(4) : [] }, tok(dp.key)).error === 'duplicate', 'C 自評重複 → duplicate'); }
  // 主管 KPI：未來季、亂填評等、計時不能替人打分
  const sm = byKey[ds.uiSm]; const ft = ds.byUnit[sm.unit].find((x) => x.title === 'ft');
  if (ft) {
    ok(post(sb, 'evSupSave', { emp: emps[ft.key], quarter: '2027-Q2', feedback: 'x' }, tok(sm.key)).error === 'bad_request', 'C 還沒到的季度不能打分');
    ok(post(sb, 'evSupSave', { emp: emps[ft.key], quarter: QUARTER, kpi: { k1: { sel: 'E' } } }, tok(sm.key)).error === 'bad_request', 'C KPI 評等亂填 → bad_request');
    ok(post(sb, 'evSupSave', { emp: emps[ft.key], quarter: QUARTER, adj_att: 101 }, tok(sm.key)).error === 'bad_request', 'C 調整超過 ±100 → bad_request');
    ok(post(sb, 'evSupSave', { emp: emps[ft.key], quarter: QUARTER, feedback: 'x' }, t).error === 'forbidden', 'C 計時同仁替人打分 → forbidden');
    ok(post(sb, 'evPersonDetail', { emp: emps[ft.key], quarter: QUARTER }, t).error === 'forbidden', 'C 計時看別人明細 → forbidden');
    // 店長即時改 KPI 後，單位結果表現欄＝我算的 KPI 合計
    const items = ds.tpl[ft.brand].ft;
    const sel = {}; items.forEach((it) => { sel[it.key] = { sel: it.type === '執行力' ? rng.pick(['完成', '未完成']) : rng.pick(['A', 'B', 'C', 'D']), actual: '' }; });
    const sv = post(sb, 'evSupSave', { emp: emps[ft.key], quarter: QUARTER, kpi: sel }, tok(sm.key));
    ok(sv.ok, 'C 店長打 KPI', sv);
    const det = post(sb, 'evPersonDetail', { emp: emps[ft.key], quarter: QUARTER }, tok(sm.key));
    const expK = expectKpi(items, sel);
    ok(det.ok && det.data.result && near(det.data.result.performance, expK), 'C KPI 合計＝自己算', { got: det.data.result && det.data.result.performance, expK, sel });
    const kpiScores = det.data.result && det.data.result.kpi;
    ok(Array.isArray(kpiScores) && kpiScores.every((k) => { const it = items.find((x) => x.key === k.key); const s = sel[it.key].sel; const e = it.type === '執行力' ? (s === '完成' ? it.weight : 0) : r1(it.weight * { A: 1, B: 0.8, C: 0.6, D: 0.4 }[s]); return near(k.score, e); }), 'C KPI 逐項分數', kpiScores);
  }
  // 兩家店互相看不到
  const sm2 = ds.people.find((x) => x.title === 'sm' && x.unit !== sm.unit);
  if (sm2) {
    const ur = post(sb, 'evUnitResults', { unit: sm.unit, quarter: QUARTER }, tok(sm2.key));
    ok(ur.error === 'forbidden', 'C 別店店長看光復 → forbidden', ur.error);
    const units = post(sb, 'evUnitResults', {}, tok(sm2.key));
    ok(units.ok && units.data.units.length === 1 && units.data.units[0].unit === sm2.unit, 'C 店長的單位清單只有自己店', units.data && units.data.units);
  }
  // 區督導：同品牌全部門市；人資：全部門市
  const osv = Object.values(ds.offices).flat().find((x) => x.title === 'osv');
  if (osv) {
    const ur = post(sb, 'evUnitResults', {}, tok(osv.key));
    const brandStores = Object.keys(ds.byUnit).filter((u) => u.startsWith(osv.brand + '-'));
    ok(ur.ok && JSON.stringify(ur.data.units.map((x) => x.unit).sort()) === JSON.stringify(brandStores.sort()), 'C 區督導單位清單＝同品牌門市', ur.data && ur.data.units);
  }
  const ur2 = post(sb, 'evUnitResults', {}, tok(ds.hq.hs.key));
  ok(ur2.ok && ur2.data.units.length >= Object.keys(ds.byUnit).length, 'C 人資同仁（eval-all）看全部單位', ur2.data && ur2.data.units.length);
  ok(post(sb, 'evUnitResults', {}, hqT).error === 'no_scope' || post(sb, 'evUnitResults', {}, hqT).error === 'forbidden', 'C 總部一般同仁沒有單位結果');
}

// ═══ D. 新人考核：到期日、逾期天數、late、分數 ═══
{
  const dueOf = (hire) => { const [y, m, d] = hire.split('-').map(Number); const y2 = m === 12 ? y + 1 : y, m2 = m === 12 ? 1 : m + 1; const last = new Date(Date.UTC(y2, m2, 0)).getUTCDate(); return `${y2}-${String(m2).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`; };
  const dayNum = (s) => Math.round(Date.UTC(...s.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))) / 86400000);
  let dueSeen = 0, waitSeen = 0, lateSeen = 0;
  for (const u of Object.keys(ds.byUnit)) {
    const head = ds.byUnit[u].find((x) => x.title === 'sm' || x.title === 'fm');
    if (!head) continue;
    const res = post(sb, 'evNewbieList', {}, tok(head.key));
    if (!ok(res.ok, `D evNewbieList ${u}`, res)) continue;
    const exp = ds.byUnit[u].filter((p) => p !== head && p.hire >= NEWBIE_SINCE && !be.applied.newbie.some((a) => a.ok && a.emp === p.key))
      .map((p) => { const due = dueOf(p.hire); const diff = dayNum(TODAY_FILL) - dayNum(due); return { emp: emps[p.key], state: diff < 0 ? 'waiting' : 'due', dueOn: due, overdueDays: diff < 0 ? 0 : diff, daysLeft: diff < 0 ? -diff : 0, late: diff > 7 }; });
    // 區經理（am）比店長高、店長管不到；am 到職日舊，不會進名單。這裡 canManage＝同店職級低於店長的人
    const expMine = exp.filter((e) => { const p = byKey[keyOf[e.emp]]; return ORG_TITLE[p.title][1] < ORG_TITLE[head.title][1]; });
    const got = res.data.list.map((x) => ({ emp: x.emp, state: x.state, dueOn: x.dueOn, overdueDays: x.overdueDays, daysLeft: x.daysLeft, late: x.late }));
    const key = (a) => a.slice().sort((x, y) => x.emp.localeCompare(y.emp)).map((x) => JSON.stringify(x)).join('\n');
    ok(key(got) === key(expMine), `D ${u} 待考核清單（到期日／逾期天數／late）`, { got, exp: expMine });
    got.forEach((g) => { if (g.state === 'due') dueSeen++; else waitSeen++; if (g.late) lateSeen++; });
    // 題庫只回 pt 的兩組
    ok(Object.values(res.data.banks).every((b) => b.pt_att && b.pt_perf && !b.ft_att), `D ${u} 新人題目＝計時兩組`);
    // 送出一位 due 的：分數＝直接加總；waiting 的送 → 擋；再送一次 → duplicate
    const due = got.find((g) => g.state === 'due');
    if (due) {
      const p = byKey[keyOf[due.emp]]; const bk = ds.bank[p.brand];
      const att = Array.from({ length: bk.pt_att.length }, () => rng.int(1, 5)), perf = Array.from({ length: bk.pt_perf.length }, () => rng.int(1, 5));
      const sub = post(sb, 'evNewbieSubmit', { emp: due.emp, att, perf }, tok(head.key));
      ok(sub.ok && near(sub.data.attitude, sum(att)) && near(sub.data.performance, sum(perf)) && near(sub.data.total, Math.min(100, sum(att) + sum(perf))), `D ${u} 新人考核分數＝加總`, { sub, att, perf });
      ok(post(sb, 'evNewbieSubmit', { emp: due.emp, att, perf }, tok(head.key)).error === 'duplicate', `D ${u} 新人考核重複 → duplicate`);
      ok(!post(sb, 'evNewbieList', {}, tok(head.key)).data.list.some((x) => x.emp === due.emp), `D ${u} 考核後從清單消失`);
    }
    const wait = got.find((g) => g.state === 'waiting');
    if (wait) { const p = byKey[keyOf[wait.emp]]; const bk = ds.bank[p.brand]; ok(post(sb, 'evNewbieSubmit', { emp: wait.emp, att: Array(bk.pt_att.length).fill(3), perf: Array(bk.pt_perf.length).fill(3) }, tok(head.key)).error === 'bad_request', `D ${u} 還沒滿月不能考核`); }
  }
  console.log(`新人分層：due ${dueSeen}、waiting ${waitSeen}、late ${lateSeen}`);
  // 到職日早於保險絲（2026-11-20）的人不出現：所有舊人都不在任何名單裡（上面 exp 已隱含）；計時同仁沒權限
  ok(post(sb, 'evNewbieList', {}, tok(ds.uiPt)).error === 'forbidden', 'D 計時同仁看新人考核 → forbidden');
}

// ═══ E. 誰能審誰（docs/org/spec.md 第 14、15、20 節）：每個單位造一位待審，每位在職同仁各問一次 unitPending ═══
function expectReview(R, T) {
  // R、T＝dataset 人物；T 的身分＝p_*（首次認領）。回 true＝R 應該審得到
  if (R === T) return false;
  const [rl, rr] = ORG_TITLE[R.title], [tl, tr] = ORG_TITLE[T.title];
  if (rl === tl && rr <= tr) return false;   // 同階梯職級要更高
  const execR = R.unit === 'dzy-hq' && rr >= 3;
  if (T.unit === 'ck') {
    if (['pt', 'ft'].includes(T.title)) return R.unit === 'ck' && ['fm', 'rdd'].includes(R.title);
    if (T.title === 'fm') return (R.unit === 'ck' && R.title === 'rdd') || execR;
    if (T.title === 'rdd') return execR;
    return false;
  }
  if (tl === 'store') {
    const office = T.brand + '-hq';
    if (tr <= 2) return R.unit === T.unit && ['sm', 'am'].includes(R.title);
    if (T.title === 'sm') return (R.unit === office && ['osv', 'odir'].includes(R.title)) || (R.unit === T.unit && R.title === 'am');
    if (T.title === 'am') return R.unit === office && ['osv', 'odir'].includes(R.title);
    return false;
  }
  if (tl === 'office') {
    if (T.title === 'odir') return execR;
    return R.unit === T.unit && R.title === 'odir';
  }
  if (tl === 'hq') {
    if (tr >= 3) return false;
    if (T.title === 'hm') return execR;
    if (T.dept === 'mgmt') return execR;
    return R.unit === 'dzy-hq' && R.title === 'hm' && R.dept === T.dept;
  }
  return false;
}
{
  // 候選被審身分：每個有人的單位抽一種職稱（含主管職稱），總部抽 hs(hr)、hs(mgmt)、hm(it)
  const cands = [];
  Object.keys(ds.byUnit).forEach((u) => { const b = u === 'ck' ? 'ck' : u.split('-')[0]; const titles = u === 'ck' ? ['pt', 'ft', 'fm', 'rdd'] : ['pt', 'ft', 'sm', 'am']; cands.push({ brand: b, unit: u, dept: '', title: rng.pick(titles) }); });
  Object.keys(ds.offices).forEach((b) => cands.push({ brand: b, unit: b + '-hq', dept: '', title: rng.pick(['ofs', 'osv', 'odir']) }));
  cands.push({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' }, { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hs' }, { brand: 'dzy', unit: 'dzy-hq', dept: rng.pick(['it', 'fin', 'ops', 'marketing']), title: rng.pick(['hs', 'hm']) });
  const isHr = (p) => p.unit === 'dzy-hq' && p.dept === 'hr';   // 人資部全部有 platform.staff（預設規則）→ 全可審
  const pendings = cands.map((c, i) => { const nm = '假待審者' + seed % 97 + '-' + i; const emp = claim(be.app, nm, c); return Object.assign({ emp, name: nm }, c); });
  let pairs = 0, hits = 0;
  const execSeen = { yes: 0 };
  for (const R of ds.people) {
    const res = post(sb, 'unitPending', {}, tok(R.key));
    const got = res.ok ? res.data.people.map((x) => x.emp_no) : [];
    for (const T of pendings) {
      const exp = isHr(R) || expectReview(R, T);
      pairs++;
      if (exp) hits++;
      if (!ok(got.includes(T.emp) === exp, `E ${R.title}@${R.unit}${R.dept ? '/' + R.dept : ''} 審 ${T.title}@${T.unit}${T.dept ? '/' + T.dept : ''} → ${exp ? '可' : '不可'}`, { got, res: res.error })) break;
    }
    if (!res.ok) ok(res.error === '只有單位主管可以審核', `E ${R.title}@${R.unit} 無資格訊息逐字`, res.error);
  }
  console.log(`審核矩陣：${pairs} 對、可審 ${hits} 對`);
  // 動作層：不可審的人按核准／退回要被擋；可審的核准後 status active；退回要原因
  const T0 = pendings.find((t) => t.unit !== 'dzy-hq' && t.title !== 'am' && t.title !== 'rdd' && t.title !== 'odir');
  if (T0) {
    const can = ds.people.find((R) => !isHr(R) && expectReview(R, T0));
    const cannot = ds.people.find((R) => !isHr(R) && !expectReview(R, T0) && R.unit !== T0.unit);
    if (cannot) ok(['只有單位主管可以審核', '不能審核自己'].includes(post(sb, 'unitApprove', { emp_no: T0.emp }, tok(cannot.key)).error), `E 無資格核准被擋（${cannot.title}@${cannot.unit}）`);
    if (can) {
      ok(post(sb, 'unitReject', { emp_no: T0.emp }, tok(can.key)).error === '請填寫退回原因', 'E 退回要原因（逐字）');
      const ap = post(sb, 'unitApprove', { emp_no: T0.emp }, tok(can.key));
      ok(ap.ok, `E 可審者（${can.title}@${can.unit}）核准成功`, ap);
      const row = post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === T0.emp);
      ok(row.status === 'active' && row.unit === T0.unit && row.title === T0.title && !row.has_pending_change, 'E 核准後 p_* 搬正式欄、status active', row);
      ok(post(sb, 'login', { username: T0.emp, password: 'fake-staff-pw-1' }).ok, 'E 核准後能登入');
      ok(post(sb, 'unitApprove', { emp_no: T0.emp }, tok(can.key)).error === '這位同仁不在等待審核', 'E 再核一次 → 不在等待審核（逐字）');
    }
  }
  // 待審的人登入被擋
  const T1 = pendings.find((t) => t !== T0);
  if (T1) ok(post(sb, 'login', { username: T1.emp, password: 'fake-staff-pw-1' }).error === '帳號還在等主管審核', 'E 待審帳號登入被擋（逐字）');
  // 退回：原因進 reject_reason、個資清空、status unclaimed、名字可重新認領
  if (T1) {
    const rj = post(sb, 'unitReject', { emp_no: T1.emp, reason: '資料有誤' }, A);
    ok(rj.ok, 'E 人資退回', rj);
    const row = post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === T1.emp);
    ok(row.status === 'unclaimed' && row.reject_reason === '資料有誤' && row.phone === '' && row.p_unit === '', 'E 退回後 unclaimed＋原因＋個資清空', row);
    ok(post(sb, 'claimLookup', { name: T1.name }).ok, 'E 退回後名字可重新查到');
  }
  // 區域：開關開後，區督導只審自己區的店長；沒劃區的店沒有督導審得到；總監不受影響
  const brandWithOsv = Object.keys(ds.offices).find((b) => ds.offices[b].some((x) => x.title === 'osv') && Object.keys(ds.byUnit).some((u) => u.startsWith(b + '-')));
  if (brandWithOsv) {
    const stores = Object.keys(ds.byUnit).filter((u) => u.startsWith(brandWithOsv + '-'));
    const osvs = ds.offices[brandWithOsv].filter((x) => x.title === 'osv');
    const odir = ds.offices[brandWithOsv].find((x) => x.title === 'odir');
    const inRegion = stores[0];
    const lst = post(sb, 'regionList', {}, A);
    const sv = post(sb, 'regionSave', { region: { name: '測試區' + seed % 9, brand: brandWithOsv, stores: [inRegion], supervisor: emps[osvs[0].key] }, expected_ver: lst.data.ver }, A);
    ok(sv.ok, 'E 建區域', sv);
    const bad = post(sb, 'regionSave', { region: { name: '重複店' , brand: brandWithOsv, stores: [inRegion] }, expected_ver: sv.data.ver }, A);
    ok(!bad.ok && bad.code === 'store_taken', 'E 同一家店不能劃進兩區', bad);
    const badSup = post(sb, 'regionSave', { region: { name: '壞督導', brand: brandWithOsv, stores: [] , supervisor: emps[byKey[ds.uiSm].key] }, expected_ver: sv.data.ver }, A);
    ok(!badSup.ok && badSup.code === 'bad_supervisor', 'E 店長不能當區督導', badSup);
    const badBrand = post(sb, 'regionSave', { region: { name: '央廚區', brand: 'ck', stores: [] }, expected_ver: sv.data.ver }, A);
    ok(!badBrand.ok, 'E 央廚不能劃區', badBrand);
    // 兩位店長待審：區內店、區外店（若有）
    const pendSm = (u) => { const nm = '假待審店長' + u; const emp = claim(be.app, nm, { brand: brandWithOsv, unit: u, dept: '', title: 'sm' }); return emp; };
    const inEmp = pendSm(inRegion);
    const outEmp = stores[1] ? pendSm(stores[1]) : null;
    const sees = (R, emp) => (post(sb, 'unitPending', {}, tok(R.key)).data || { people: [] }).people.some((x) => x.emp_no === emp);
    ok(osvs.every((o) => sees(o, inEmp)), 'E 開關關：所有督導都審得到店長');
    post(sb, 'regionSwitch', { on: true }, A);
    ok(sees(osvs[0], inEmp), 'E 開關開：負責督導審得到區內店長');
    if (osvs[1]) ok(!sees(osvs[1], inEmp), 'E 開關開：別的督導審不到');
    if (outEmp) ok(osvs.every((o) => !sees(o, outEmp)), 'E 開關開：沒劃區的店沒有督導審得到');
    if (odir) ok(sees(odir, inEmp) && (!outEmp || sees(odir, outEmp)), 'E 開關開：總監不受影響');
    if (osvs[1]) ok(post(sb, 'unitApprove', { emp_no: inEmp }, tok(osvs[1].key)).error === '這家店不在你負責的區域', 'E 區外督導核准 → 區域訊息（逐字）', post(sb, 'unitApprove', { emp_no: inEmp }, tok(osvs[1].key)).error);
    // 績效評核主管範圍跟著區域：負責督導 canManage 區內店長；別的督導不行
    const smIn = ds.byUnit[inRegion].find((x) => x.title === 'sm');
    ok(post(sb, 'evPersonDetail', { emp: emps[smIn.key], quarter: QUARTER }, tok(osvs[0].key)).ok, 'E 區域開：負責督導可看區內店長評核');
    const d2 = post(sb, 'evPersonDetail', { emp: emps[smIn.key], quarter: QUARTER }, osvs[1] ? tok(osvs[1].key) : null);
    if (osvs[1]) ok(d2.ok && d2.data.canManage === false, 'E 區域開：別的督導可看（同品牌）但不能打分', d2.data && d2.data.canManage);
    post(sb, 'regionSwitch', { on: false }, A);
  }
}

// ═══ F. 同仁名單後台動作＋單位限定職稱 ═══
{
  const okErr = (r) => !r.ok;
  ok(okErr(post(sb, 'claimSubmit', { name: 'x', emp_no: 'DZY999', password: 'fake-staff-pw-1', brand: 'ck', unit: 'ck', dept: '', title: 'sm', birthday: '1990-01-01', phone: '0911111111', address: '測試市測試路 1 號' })), 'F 央廚不能選店長');
  const fmBad = post(sb, 'staffEdit', { emp_no: emps[ds.uiSm], brand: 'mala', unit: 'mala-gf', dept: '', title: 'fm' }, A);
  ok(!fmBad.ok, 'F 門市不能設廠長', fmBad);
  // 停用 → 不能登入、名單 disabled；啟用 → 回原狀態
  const victim = ds.byUnit['mala-gf'].find((x) => x.title === 'pt' && x.key !== ds.uiPt);
  if (victim) {
    const e = emps[victim.key];
    ok(post(sb, 'staffSetActive', { emp_no: e, active: false }, A).ok, 'F 停用');
    ok(!post(sb, 'login', { username: e, password: 'fake-staff-pw-1' }).ok, 'F 停用後不能登入');
    ok(post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === e).status === 'disabled', 'F 名單顯示 disabled');
    ok(post(sb, 'staffSetActive', { emp_no: e, active: false }, A).ok === false, 'F 重複停用被擋');
    ok(post(sb, 'staffSetActive', { emp_no: e, active: true }, A).ok, 'F 啟用');
    ok(post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === e).status === 'active', 'F 啟用後回 active');
    // 離職：人資登記 last_day（今天）→ 名單帶 last_day；撤銷；再登記過去日期 → 每日同步停用 → 復職
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 台北日期（後端 can_cancel 用台北「今天」比；UTC 晚上會差一天）
    const stokBefore = post(sb, 'login', { username: e, password: 'fake-staff-pw-1' }).data.token;   // 離職前先登入拿一個 token
    const lv = post(sb, 'staffLeave', { emp_no: e, last_day: today }, A);
    ok(lv.ok && lv.data.can_cancel === true, 'F 登記離職（今天）可撤銷', lv);
    ok(post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === e).last_day === today, 'F 名單 last_day');
    // 2026-10-30 Eason 照推薦：離職日 ≤ 台北今天 → 當場踢掉所有登入、之後登入／me 一律擋；撤銷後可重登；未來日期照舊等那天
    ok(post(sb, 'me', {}, stokBefore).ok === false, 'F ★登記今天離職 → 之前的 token 立刻失效');
    const lvLogin = post(sb, 'login', { username: e, password: 'fake-staff-pw-1' });
    ok(lvLogin.ok === false && /離職/.test(lvLogin.error || ''), 'F ★登記今天離職 → 密碼登入被擋、訊息說明已離職：' + (lvLogin.error || ''), lvLogin);
    ok(post(sb, 'staffLeaveCancel', { emp_no: e }, A).ok, 'F 撤銷離職');
    ok(post(sb, 'login', { username: e, password: 'fake-staff-pw-1' }).ok, 'F ★撤銷離職後可以重新登入');
    const future = new Date(Date.now() + 8 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
    ok(post(sb, 'staffLeave', { emp_no: e, last_day: future }, A).ok, 'F 登記未來離職日');
    const futTok = post(sb, 'login', { username: e, password: 'fake-staff-pw-1' });
    ok(futTok.ok && post(sb, 'me', {}, futTok.data.token).ok, 'F ★未來的離職日：照舊可登入、token 有效（等那天每晚同步停用）');
    ok(post(sb, 'staffLeaveCancel', { emp_no: e }, A).ok, 'F 撤銷未來離職日');
    ok(post(sb, 'staffLeaveCancel', { emp_no: e }, A).code === 'no_leave', 'F 沒登記離職就撤銷 → no_leave');
    // 解除鎖定：被鎖的人 reset_locked → 解鎖後 false
    const lk = be.extra.locked;
    ok(post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === lk).reset_locked === true, 'F 錯 5 次忘記密碼被鎖');
    ok(post(sb, 'staffUnlockReset', { emp_no: lk }, A).ok && post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === lk).reset_locked === false, 'F 解除鎖定');
    // 改資料：改手機要 09 開頭 10 碼
    ok(!post(sb, 'staffEdit', { emp_no: e, phone: '12345' }, A).ok, 'F 改手機格式錯 → 擋');
    ok(post(sb, 'staffEdit', { emp_no: e, phone: '0977123456' }, A).ok && post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === e).phone === '0977123456', 'F 改手機成功');
    // 店長（非人資）不能停用、不能改別人資料
    ok(!post(sb, 'staffSetActive', { emp_no: e, active: false }, tok(ds.uiSm)).ok, 'F 店長不能停用同仁');
    ok(!post(sb, 'staffList', {}, tok(ds.uiSm)).ok, 'F 店長看不到同仁名單（platform.staff）');
    ok(post(sb, 'staffList', {}, tok(ds.hq.hs.key)).ok, 'F 人資同仁看得到同仁名單');
  }
  // 匯入預覽不寫入、重名擋
  const before = post(sb, 'staffList', {}, A).data.staff.length;
  const pv = post(sb, 'staffImport', { names: ['假預覽甲', '假預覽乙'], preview: true }, A);
  ok(pv.ok && pv.data.preview === true && pv.data.created.length === 2 && post(sb, 'staffList', {}, A).data.staff.length === before, 'F 匯入預覽不寫入');
  ok(!post(sb, 'staffImport', { names: ['假預覽甲', '假預覽甲'] }, A).ok, 'F 名單內重名被擋');
  ok(!post(sb, 'staffImport', { names: ['=壞名字'] }, A).ok, 'F 公式開頭姓名被擋');
}

// ═══ G. 定稿／解除：定稿值凍結、KPI 沒評完略過、定稿後主管不能改 ═══
{
  const hmT = tok(ds.hq.hm.key);
  const u = 'mala-gf';
  const beforeRows = post(sb, 'evUnitResults', { unit: u, quarter: QUARTER }, A).data.rows;
  const fin = post(sb, 'evFinalize', { unit: u, quarter: QUARTER }, hmT);
  ok(fin.ok, 'G 定稿', fin);
  const expSkipped = beforeRows.filter((r) => r.result && r.kind === 'ft' && r.result.performance === null).map((r) => r.name).sort();
  ok(JSON.stringify((fin.data.skipped || []).slice().sort()) === JSON.stringify(expSkipped), 'G KPI 沒評完的正職被略過', { got: fin.data.skipped, expSkipped });
  const expCount = beforeRows.filter((r) => r.result && !(r.kind === 'ft' && r.result.performance === null)).length;
  ok(fin.data.count === expCount, 'G 定稿人數', [fin.data.count, expCount]);
  const after = post(sb, 'evUnitResults', { unit: u, quarter: QUARTER }, A).data;
  ok(after.finalized === true, 'G 單位顯示已定稿');
  for (const r of beforeRows) {
    const a = after.rows.find((x) => x.emp === r.emp);
    if (r.result && !expSkipped.includes(r.name)) ok(a.locked && a.result.source === 'final' && near(a.result.total, r.result.total) && a.result.grade === r.result.grade, `G ${r.name} 定稿值＝定稿前即時值`, { a: a.result, r: r.result });
    else ok(!a.locked, `G ${r.name} 沒定稿列不鎖`);
  }
  const locked = after.rows.find((x) => x.locked);
  if (locked) ok(post(sb, 'evSupSave', { emp: locked.emp, quarter: QUARTER, feedback: 'x' }, tok(ds.uiSm)).error === 'finalized', 'G 定稿後主管不能改');
  ok(post(sb, 'evFinalize', { unit: u, quarter: QUARTER }, tok(ds.uiSm)).error === 'forbidden', 'G 店長不能定稿');
  ok(post(sb, 'evFinalize', { unit: u, quarter: '2027-Q1' }, hmT).error === 'bad_request', 'G 還沒到的季度不能定稿');
  ok(post(sb, 'evUnfinalize', { unit: u, quarter: QUARTER }, hmT).ok && post(sb, 'evUnitResults', { unit: u, quarter: QUARTER }, A).data.finalized === false, 'G 解除定稿');
  // 匯入舊成績：態度＋表現＋調整 ≠ 總分 → 擋
  const p = ds.byUnit[u][0];
  ok(post(sb, 'evImportCommit', { rows: [{ quarter: '2026-Q2', emp: emps[p.key], kind: 'pt', result: { attitude: 20, performance: 50, adjAtt: 0, adjPerf: 0, total: 80 } }] }, hmT).error === 'bad_request', 'G 匯入總分對不上 → 擋');
  ok(post(sb, 'evImportCommit', { rows: [{ quarter: '2026-Q2', emp: emps[p.key], kind: 'pt', result: { attitude: 20, performance: 50, adjAtt: 1, adjPerf: 0, total: 71 } }] }, hmT).ok, 'G 匯入總分對得上');
  // 等第表要有 0 分列；KPI 比重 >70 擋；題庫 key 重複擋
  ok(post(sb, 'evGradeSave', { brand: 'mala', rows: [{ grade: 'A', min: 80, base: 1 }] }, hmT).error === 'bad_request', 'G 等第表沒有 0 分列 → 擋');
  ok(post(sb, 'evTplSave', { brand: 'mala', title: 'ft', items: [{ key: 'a', type: '技能', label: 'x', weight: 71 }] }, hmT).error === 'bad_request', 'G KPI 比重 >70 → 擋');
  be.today = '2026-12-20';
  ok(post(sb, 'evBankSave', { brand: 'mala', set: 'pt_att', items: [{ key: 'a1', label: 'x', levels: ['1', '2', '3', '4', '5'] }, { key: 'a1', label: 'y', levels: ['1', '2', '3', '4', '5'] }] }, hmT).error === 'bad_request', 'G 題目代碼重複 → 擋');
  ok(post(sb, 'evBankSave', { brand: 'mala', set: 'pt_att', items: ds.bank.mala.pt_att }, tok(ds.hq.hs.key)).error === 'forbidden', 'G 人資同仁（非總監）不能改題庫');
  be.today = TODAY_FILL;
}

console.log(`\n共 ${passed + failed} 項檢查，通過 ${passed}，失敗 ${failed}（seed ${seed}）`);
if (failed) { console.log('失敗清單：\n  ' + fails.slice(0, 40).join('\n  ')); process.exit(1); }
