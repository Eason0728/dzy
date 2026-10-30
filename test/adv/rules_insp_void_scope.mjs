// node test/adv/rules_insp_void_scope.mjs —— 對抗驗證 2026-10-30 規則 4「作廢巡檢獨立權限碼 platform.insp-void」
// 攻擊：admin（或人資）用個別例外把 platform.insp-void 給一個「看不到那家店」的人（美村店長、光復計時），
// 他拿巡檢編號直接打 inspVoid。應有行為：作廢要受「看得到」範圔限制（inspList／inspGet／照片都查 view[unit]，作廢卻沒查）。
// 另驗：perm_map 還沒補規則前營運部不能作廢（fail closed）、inspSetup 重按只補不覆蓋（含被停用的那條不會被重新打開）。
'use strict';
import { buildWorld } from '../e2e/inspect_backend.mjs';
import { defaultForms } from '../../modules/inspection/questions.js';
import { summaryOf } from '../../modules/inspection/scoring.js';

let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const w = buildWorld();
const { post, people: P, sb, app } = w;
const A = sb.__admin;
const T = (k) => P[k].token;
const grant = (emp, perm) => post('permExSave', { emp_no: emp, perm, mode: 'add', until: '', note: '對抗測試' }, A);

// ── fail closed：perm_map 還沒補規則（inspSetup 還沒按）→ 營運部不能作廢；按完才可以 ──
{
  // 先建分頁、但不補規則：直接呼叫 setupInspection 以外的方式——這裡用 admin 按 inspSetup 後再把 insp-void 那條停用來模擬「正式環境還沒補規則」
  const setup = post('inspSetup', {}, A);
  ok(setup.ok, 'inspSetup 成功', setup);
  const mapRows = app.sheets.perm_map._rows();
  const head = mapRows[0];
  const voidIdx = mapRows.findIndex((r, i) => i > 0 && r[head.indexOf('perm')] === 'platform.insp-void');
  ok(voidIdx > 0, 'perm_map 有 insp-void 預設規則');
  const activeCol = head.indexOf('active') >= 0 ? head.indexOf('active') : 5;
  app.sheets.perm_map._data[voidIdx][activeCol] = 'FALSE';
  ok(post('inspMe', {}, T('ops')).data.can_void === false, 'fail closed：規則停用（＝上線前還沒補）時營運部 can_void=false');
  // 重按 inspSetup：同一條規則已存在（只是停用）→ 不該重新補一條生效的
  const again = post('inspSetup', {}, A);
  ok(again.ok && again.data.permAdded.length === 0, 'inspSetup 重按只補不覆蓋：已停用的那條不會重補', again);
  ok(post('inspMe', {}, T('ops')).data.can_void === false, '重按後營運部仍不能作廢（admin 停用的設定被尊重）');
  app.sheets.perm_map._data[voidIdx][activeCol] = 'TRUE';
  ok(post('inspMe', {}, T('ops')).data.can_void === true, '規則恢復後營運部可作廢');
}

// ── 督導送兩筆：光復（mala-gf）與墨竹亭光復（mzt-gf，由墨竹亭區經理巡） ──
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const ph = w.filePut({ token: T('malaOsv'), kind: 'receipt', mime: 'image/jpeg', b64: JPG });
const formsMala = defaultForms('mala');
const ans = { scores: { 'service.attitude.1': 3 }, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: { 'service.attitude.1': 'x' }, photos: { 'service.attitude.1': [ph.data.id] } };
const ID_GF = 'INS-ADVGF001-AAAA';
const subGF = post('inspSubmit', { id: ID_GF, unit: 'mala-gf', date: '2026-10-29', bank_ver: 'default', forms: formsMala, answers: ans, summary: summaryOf(formsMala, ans), files: [ph.data.id] }, T('malaOsv'));
ok(subGF.ok, '督導送出光復巡檢', subGF);

// ── 攻擊 1：美村店長（只看自己店 mala-mc）被人資／admin 個別例外給 insp-void，拿編號作廢光復的巡檢 ──
{
  const g = grant(P.mcSm.emp, 'platform.insp-void');
  ok(g.ok, 'admin 可用個別例外給美村店長 platform.insp-void（不鎖碼，刻意）', g);
  const me = post('inspMe', {}, T('mcSm')).data;
  ok(me.can_void === true && (me.stores || []).map((s) => s.unit).join() === 'mala-mc', '美村店長：can_void=true、看得到的店只有 mala-mc', me);
  ok(post('inspGet', { id: ID_GF }, T('mcSm')).error === 'not_found', '美村店長看不到光復那筆（inspGet 有查 view）');
  ok(post('inspList', { include_void: true }, T('mcSm')).data.items.length === 0, '美村店長列不到光復那筆（inspList 有查 view）');
  const v = post('inspVoid', { id: ID_GF }, T('mcSm'));
  ok(v.ok !== true, '【應擋】美村店長不能作廢自己看不到的光復巡檢（作廢要受看得到範圍限制）', v);
  const rows = app.sheets.insp_records._rows();
  const rec = rows.find((r) => r[0] === ID_GF);
  const state = rec ? rec[rows[0].indexOf('state')] : null;
  ok(state !== 'void', '【應擋】光復那筆不該變成 void', { state });
}

// ── 攻擊 2：光復計時（什麼店都看不到）只拿 insp-void，照樣作廢 ──
{
  // 重新送一筆新的（上面若已被作廢，再用另一個編號）
  const ID2 = 'INS-ADVGF002-BBBB';
  const s2 = post('inspSubmit', { id: ID2, unit: 'mala-gf', date: '2026-10-28', bank_ver: 'default', forms: formsMala, answers: ans, summary: summaryOf(formsMala, ans), files: [] }, T('malaOsv'));
  ok(s2.ok, '督導再送一筆', s2);
  ok(grant(P.gfPt.emp, 'platform.insp-void').ok, '給計時同仁 insp-void');
  const me = post('inspMe', {}, T('gfPt')).data;
  ok((me.stores || []).length === 0 && me.can_void === true, '計時：看不到任何店、但 can_void=true', me);
  const v = post('inspVoid', { id: ID2 }, T('gfPt'));
  ok(v.ok !== true, '【應擋】看不到任何店的人不能作廢任何巡檢', v);
  // 作廢後他自己也看不到（說明 canVoid 與 view 脫鉤：能作廢卻不能看）
  if (v.ok === true) ok(post('inspGet', { id: ID2 }, T('gfPt')).error === 'not_found', '（佐證）作廢者連自己剛作廢的那筆都看不到＝作廢沒有受看得到範圍限制');
}

// ── 對照：有 view 但沒 insp-all 的人拿 insp-void，作廢自己店 → 合理放行；作廢後只有他與 ops 看得到照片 ──
{
  const ID3 = 'INS-ADVGF003-CCCC';
  post('inspSubmit', { id: ID3, unit: 'mala-gf', date: '2026-10-27', bank_ver: 'default', forms: formsMala, answers: ans, summary: summaryOf(formsMala, ans), files: [] }, T('malaOsv'));
  ok(grant(P.gfSm.emp, 'platform.insp-void').ok, '給光復店長 insp-void');
  ok(post('inspVoid', { id: ID3 }, T('gfSm')).ok, '光復店長作廢自己店的巡檢（在看得到範圍內，放行）');
  ok(post('inspGet', { id: ID3 }, T('gfSm')).ok, '光復店長作廢後仍看得到');
  ok(post('inspGet', { id: ID3 }, T('malaOsv')).error === 'not_found', '督導（沒 insp-void）看不到作廢那筆');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
