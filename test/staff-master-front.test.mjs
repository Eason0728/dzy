// node test/staff-master-front.test.mjs —— 員工名單統一前端的純函式與接線檢查（docs/personnel/master-data/task.md D1–D6）
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../platform/manifest-check.js';
import * as L from '../modules/staff-shared/clock-lib.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('PASS: ' + l); } else { failed++; console.error('FAIL: ' + l); } };

// ---- 日期限制（D2）----
ok(L.addDays('2026-10-13', -7) === '2026-10-06', 'addDays 往回 7 天');
ok(L.addDays('2026-03-01', -1) === '2026-02-28' && L.addDays('2024-03-01', -1) === '2024-02-29', 'addDays 跨月與閏年');
ok(L.addDays('2026-13-01', 1) === '', 'addDays 格式錯回空字串');
ok(L.leaveMinDate('2026-10-13', false) === '2026-10-06' && L.leaveMinDate('2026-10-13', true) === '', '店長最小日=今天-7；總部不擋');
ok(L.leaveDateError('2026-10-06', '2026-10-13', false) === '', '店長：第 7 天可以');
ok(L.leaveDateError('2026-10-05', '2026-10-13', false).includes('7 天'), '店長：第 8 天擋下並說最多補 7 天');
ok(L.leaveDateError('2026-01-01', '2026-10-13', true) === '', '總部：不擋往回');
ok(L.leaveDateError('2026-10-13', '2026-10-13', false) === '' && L.leaveDateError('2026-10-31', '2026-10-13', false) === '', '今天與未來日可登記');
ok(L.leaveDateError('2027-10-13', '2026-10-13', true) !== '' && L.leaveDateError('2027-10-12', '2026-10-13', true) === '', '今天+365 天以後不收');
ok(L.leaveDateError('', '2026-10-13', false) !== '' && L.leaveDateError('2026-02-30', '2026-10-13', false) !== '', '空白與不存在的日期擋下');
ok(L.leaveLabel('2026-10-31') === '10/31 離職' && L.leaveLabel('2026-01-05') === '1/5 離職' && L.leaveLabel('') === '', '離職標籤 10/31 離職');

// ---- 打卡已停 n/m ----
ok(L.stoppedLabel({ clock_total: 3, clock_stopped: 2, last_day: '2026-10-31' }) === '打卡已停 2/3', '打卡已停 2/3');
ok(L.stoppedLabel({ clock_total: 1, clock_stopped: 0, status: 'disabled' }) === '打卡已停 0/1', '已停用也顯示');
ok(L.stoppedLabel({ clock_total: 2, clock_stopped: 0 }) === '' && L.stoppedLabel({ clock_total: 0, last_day: '2026-10-31' }) === '', '在職無離職日、或沒有打卡 → 不顯示');
ok(L.allStopped({ clock_total: 2, clock_stopped: 2 }) && !L.allStopped({ clock_total: 2, clock_stopped: 1 }) && !L.allStopped({ clock_total: 0 }), 'allStopped');

// ---- 權限顯示判斷（D2/D3）----
const lead = { isHq: false, isLead: true, user: { username: 'DZY010' } };
const hq = { isHq: true, isLead: false, user: { username: 'DZY001' } };
const p = (o) => Object.assign({ emp_no: 'DZY050', status: 'active', clock_total: 1, clock_stopped: 0, last_day: '', can_cancel_leave: false }, o);
ok(L.personActions(p(), lead).link && L.personActions(p(), hq).link, '店長與總部看得到「顯示打卡連結」');
ok(!L.personActions(p(), { isHq: false, isLead: false }).link && !L.personActions(p(), {}).leave, '其他人（非店長非總部）看不到連結與離職');
ok(!L.personActions(p({ clock_total: 0 }), hq).link, '沒有生效打卡對照 → 不顯示連結');
ok(!L.personActions(p({ status: 'disabled' }), hq).link && !L.personActions(p({ status: 'disabled' }), hq).leave, '已停用 → 不顯示連結、不能登記離職');
ok(!L.personActions(p({ emp_no: 'DZY010' }), lead).leave, '店長不能對自己登記離職');
ok(L.personActions(p({ last_day: '2026-10-31', can_cancel_leave: true }), lead).cancelLeave, '可撤銷時出現撤銷鈕');
ok(!L.personActions(p({ last_day: '2026-10-01', can_cancel_leave: false }), hq).cancelLeave, '不可撤銷（已過）→ 沒有撤銷鈕');
ok(!L.personActions(p({ last_day: '', can_cancel_leave: true }), hq).cancelLeave, '沒登記離職 → 沒有撤銷鈕');
ok(!L.personActions(p({ emp_no: 'DZY010', last_day: '2026-10-31', can_cancel_leave: true }), lead).cancelLeave, '店長不能撤銷自己的離職');
ok(L.personActions(p(), hq).rename && !L.personActions(p(), lead).rename, '改名只有總部');
ok(L.personActions(p({ status: 'disabled' }), hq).reinstate && !L.personActions(p(), hq).reinstate && !L.personActions(p({ status: 'disabled' }), lead).reinstate, '復職只有總部、且只對已停用的人');
ok(!L.personActions(p({ status: 'unclaimed' }), hq).rename, '未開通者走既有改姓名，不重複出現');

// ---- 新增表單 ----
const good = { name: '測試人', title: 'pt', hire_date: '2026-10-13', phone: '0912-000-111' };
ok(L.addFormErrors(good, '2026-10-13').length === 0, '新增表單：合格');
ok(L.addFormErrors({ ...good, phone: '0812000111' }, '2026-10-13').length === 1, '手機非 09 開頭擋下');
ok(L.addFormErrors({ ...good, name: ' ' }, '2026-10-13').length === 1 && L.addFormErrors({ ...good, name: 'x'.repeat(31) }, '2026-10-13').length === 1, '姓名空白／超過 30 字擋下');
ok(L.addFormErrors({ ...good, hire_date: '1999-12-31' }, '2026-10-13').length === 1 && L.addFormErrors({ ...good, hire_date: '2028-01-01' }, '2026-10-13').length === 1, '到職日太早／太晚擋下');
ok(L.addFormErrors({ ...good, title: '' }, '2026-10-13').length === 1, '沒選職稱擋下');
ok(L.addUnitChoice(lead, [], 'mzt-gf').fixed === true && L.addUnitChoice(lead, [], 'mzt-gf').unit === 'mzt-gf', '店長版單位固定為自己單位');
ok(L.addUnitChoice(hq, [{ code: 'a' }], '').fixed === false && L.addUnitChoice(hq, [{ code: 'a' }], '').options.length === 1, '總部版可選單位');

// ---- 輪詢（D1：每 3 秒、最多 60 秒）----
function fakeClock() {
  let t = 0; const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, get t() { return t; } };
}
{
  const c = fakeClock(); let n = 0;
  const r = await L.pollJob(async () => ({ ok: true, data: { state: ++n >= 3 ? 'done' : 'running', emp_id: 'E09' } }), c);
  ok(r.status === 'done' && r.job.emp_id === 'E09' && n === 3, '輪詢：第 3 次拿到 done，打卡編號帶回');
  ok(c.sleeps.every((x) => x === 3000) && c.sleeps.length === 2, '輪詢：間隔 3 秒');
}
{
  const c = fakeClock(); let n = 0;
  const r = await L.pollJob(async () => { n++; return { ok: true, data: { state: 'pending' } }; }, c);
  ok(r.status === 'timeout', '輪詢：一直 pending → 逾時');
  ok(c.t <= 60000 && c.t >= 57000, '輪詢：逾時時間不超過 60 秒（' + c.t + 'ms）');
  ok(n === 21, '輪詢：60 秒內共問 21 次（0,3,…,60 秒）：' + n);
}
{
  const r = await L.pollJob(async () => ({ ok: true, data: { state: 'failed', last_error: 'x' } }), fakeClock());
  ok(r.status === 'failed', '輪詢：failed → 失敗畫面');
  const r2 = await L.pollJob(async () => ({ ok: true, data: { state: 'cancelled' } }), fakeClock());
  ok(r2.status === 'failed', '輪詢：cancelled 也算失敗');
  const r3 = await L.pollJob(async () => ({ ok: false, code: 'no_job', error: '找不到' }), fakeClock());
  ok(r3.status === 'failed', '輪詢：查不到單 → 失敗');
}
{
  const c = fakeClock(); let n = 0;
  const r = await L.pollJob(async () => { n++; if (n < 4) throw new Error('network'); return { ok: true, data: { state: 'done', emp_id: 'E1' } }; }, c);
  ok(r.status === 'done', '輪詢：中間網路失敗會繼續問');
  const c2 = fakeClock();
  const r2 = await L.pollJob(async () => { throw new Error('down'); }, c2);
  ok(r2.status === 'timeout', '輪詢：網路一直失敗 → 逾時，不會當成成功');
}
{
  let stop = false; let n = 0;
  const r = await L.pollJob(async () => { n++; if (n === 2) stop = true; return { ok: true, data: { state: 'running' } }; }, { ...fakeClock(), shouldStop: () => stop });
  ok(r.status === 'stopped' && n === 2, '輪詢：關掉畫面就停止，不再呼叫後端');
}

// ---- 打卡連結（D3）----
ok(L.clockLinkUrl('gf', 'Ab+3x/7m') === 'https://eason0728.github.io/mala-clock-in/clock.html?k=Ab%2B3x%2F7m', '光復打卡網址：clock.html?k=（金鑰編碼）');
ok(L.clockLinkUrl('mztjs', 'K1').endsWith('/clock-mztjs.html?k=K1') && L.clockLinkUrl('cf', 'K1').endsWith('/clock-cf.html?k=K1') && L.clockLinkUrl('hq', 'K1').endsWith('/clock-hq.html?k=K1'), '各店頁名（stores.json page 欄）');
ok(L.clockLinkUrl('zzz', 'K1') === '' && L.clockLinkUrl('gf', '') === '', '店代碼不認得或沒金鑰 → 空字串（畫面只顯示金鑰）');
ok(L.linkOutcome({ status: 'done', job: { link_key: 'KK' } }).kind === 'ok', 'linkOutcome：拿到金鑰');
ok(L.linkOutcome({ status: 'done', job: { link_expired: true } }).kind === 'expired', 'linkOutcome：已取走／過期');
ok(L.linkOutcome({ status: 'timeout', job: null }).kind === 'timeout' && L.linkOutcome({ status: 'failed', job: { last_error: 'x' } }).kind === 'failed', 'linkOutcome：逾時／失敗');

// ---- 首頁提醒 D5 ----
const A = {
  outbox_failed: [{ job_id: 'J1' }], unmapped: [{}, {}], left_but_active: [{}], pending_confirm: { count: 4, items: [] },
  no_home_map: ['DZY1'], name_diff: [{}], payroll_diff: [{}], transfer_ask: [{}], needs_hq_count: 2, candidates_count: 3
};
const rowsHq = L.alertRows(A, hq);
ok(rowsHq.length === 10, '總部：每一類一列（共 10 類）：' + rowsHq.length);
ok(rowsHq.find((r) => r.key === 'outbox_failed').retry === true && rowsHq.find((r) => r.key === 'outbox_failed').view === 'clockmap' && rowsHq.find((r) => r.key === 'outbox_failed').params.t === 'jobs', '失敗待辦單那列帶重試、導到打卡對照');
ok(rowsHq.find((r) => r.key === 'pending_confirm').count === 4 && rowsHq.find((r) => r.key === 'unmapped').text.includes('2'), '件數寫進文字');
const rowsLead = L.alertRows({ ...A, needs_hq_count: 0, candidates_count: 0 }, lead);
ok(!rowsLead.some((r) => ['payroll_diff', 'transfer_ask', 'needs_hq', 'candidates'].includes(r.key)), '店長看不到總部才有的類別');
ok(rowsLead.find((r) => r.key === 'pending_confirm').view === 'clock' && rowsLead.find((r) => r.key === 'outbox_failed').view === 'team', '店長的提醒導到「打卡對照」「我的單位」分頁');
ok(L.alertRows({}, hq).length === 0 && L.alertRows(null, hq).length === 0, '全零異常 → 沒有任何提醒列');
ok(L.staleSyncStores({ gf: '2026-10-13 00:10:00', cf: '2026-10-11 00:10:00' }, Date.parse('2026-10-13T12:00:00+08:00')).join() === 'cf', '超過 26 小時沒同步的店會被點名');


// ---- 缺口補強（2026-10-13）：is_self、dryrun 白名單、結案 ----
ok(L.isSelf({ emp_no: 'DZY010', is_self: true }, {}) === true && L.isSelf({ emp_no: 'DZY010', is_self: false }, { username: 'DZY010' }) === false, 'isSelf：後端給的 is_self 優先');
ok(!L.personActions({ emp_no: 'DZY010', status: 'active', clock_total: 1, is_self: true }, lead).leave, '店長不能對 is_self 那列登記離職（按鈕不出現）');
ok(L.personActions({ emp_no: 'DZY010', status: 'active', clock_total: 1, is_self: true, last_day: '2026-10-31', can_cancel_leave: true }, hq).cancelLeave, '總部對自己那列的撤銷不受店長限制（後端另擋）');
{
  const { isReadAction } = await import('../platform/dryrun.js');
  for (const a of ['staffUnitList', 'clockMapList', 'clockAlerts']) ok(isReadAction('platform', a, {}), `dryrun 放行讀取 ${a}`);
  ok(isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001', preview: true }), 'dryrun 放行 staffReinstate preview:true');
  ok(!isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001' }) && !isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001', preview: false }), 'dryrun 擋真正的 staffReinstate');
  for (const a of ['staffCreateByUnit', 'staffLeave', 'staffLeaveCancel', 'staffRename', 'clockLink', 'clockJobStatus', 'clockMapDecide', 'clockMapBuild', 'clockOutboxRetry', 'clockOutboxCancel', 'clockOldHomeDecide', 'clockCandidateCreate', 'clockCandidateDismiss']) ok(!isReadAction('platform', a, {}), `dryrun 擋（非純讀取）${a}`);
}
{
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok(/clockOutboxCancel/.test(ui) && /data-act="job-cancel"/.test(ui) && /請填結案原因/.test(ui), '待辦單每筆有「結案」鈕，必填原因後送 clockOutboxCancel');
  ok(/data\.confirmed/.test(ui) && /personFilter\('?\w*'?/.test(ui) && /name_diff === true/.test(fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-lib.js'), 'utf8')), '全部對照用後端 confirmed；打卡姓名不同用 name_diff 布林');
  ok(/auto_support_map: '自動（已確認身分的跨店支援）'/.test(ui) && /data-role="cm-source"/.test(ui), '全部對照看得出自動確認（auto_support_map 中文標籤）');
  ok(!/btn btn-primary" data-act="cm-yes"/.test(ui) && /data-act="cm-yes"/.test(ui), '「對」不是紅色主按鈕（改用 --ok 綠）');
}

// ---- 第 4 段：在主店建打卡帳號（總部，no_home_map 異常列）----
ok(L.personActions(p({ no_home: true, clock_total: 1 }), hq).addHome, '總部看 no_home 列有「在主店建打卡帳號」');
ok(!L.personActions(p({ no_home: true }), lead).addHome, '★店長看不到「在主店建打卡帳號」');
ok(!L.personActions(p({ no_home: false }), hq).addHome && !L.personActions(p({}), hq).addHome, '不在 no_home_map 的列沒有這顆鈕');
ok(!L.personActions(p({ no_home: true, status: 'disabled' }), hq).addHome, '已停用沒有這顆鈕');
ok(L.personFilter('nohome', { status: 'unclaimed', clock_total: 1, no_home: true }, '2026-10-14') && !L.personFilter('nohome', { status: 'active', clock_total: 0, no_home: false }, '2026-10-14'), 'nohome 篩選：後端有帶 no_home 就照它（與首頁 no_home_map 一致）');
ok(L.personFilter('nohome', { status: 'active', clock_total: 0 }, '2026-10-14') && !L.personFilter('nohome', { status: 'active', clock_total: 1 }, '2026-10-14'), 'nohome 篩選：舊後端沒帶 no_home → 退回舊判斷');
{
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(!isReadAction('platform', 'clockAddHome', { emp_no: 'DZY001' }), 'dryrun 擋 clockAddHome（寫入）');
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok(/'add-home'/.test(ui) && /在主店建打卡帳號/.test(ui) && /'clockAddHome'/.test(ui) && /openAddHome[\s\S]*ctx\.ui\.dialog[\s\S]*clockAddHome[\s\S]*env\.reload\(\)/.test(ui), '「在主店建打卡帳號」鈕：先 dialog 確認、送 clockAddHome、成功後重新整理');
}


// ---- 第 2 輪審查修正（issue #1）----
// #15 後端 clockAlerts 的每個 key，前端都要有對應的一列（後端新增 key 沒接前端 → 這條紅）
{
  const gs = fs.readFileSync(path.join(ROOT, 'apps-script/platform/StaffClock.gs'), 'utf8');
  const lit = /var empty = \{([\s\S]*?)\};\n/.exec(gs)[1];
  const backendKeys = Array.from(lit.matchAll(/(\w+):/g)).map((m) => m[1]).filter((k, i, a) => a.indexOf(k) === i && k !== 'count' && k !== 'items'); // count／items 是 pending_confirm 的內層欄位
  const NOT_ALERT = ['counts', 'last_sync', 'name_diff_items', 'no_home_map_items']; // 非「一類提醒」：統計、同步時間、逐人明細
  // 後端 key → alertRows 的 key（count 類的欄位名不同）
  const ROW_KEY = { needs_hq_count: 'needs_hq', candidates_count: 'candidates' };
  const feed = (k) => (k === 'pending_confirm' ? { count: 1, items: [{}] } : (k === 'needs_hq_count' || k === 'candidates_count') ? 1 : [{ emp_no: 'DZY001', store_code: 'gf', emp_id: 'E1' }]);
  ok(backendKeys.length >= 14, '#15 解析得到後端 clockAlerts 的 key：' + backendKeys.join());
  for (const k of backendKeys.filter((x) => !NOT_ALERT.includes(x))) {
    const rk = ROW_KEY[k] || k;
    const hqRows = L.alertRows({ [k]: feed(k) }, hq);
    ok(hqRows.length === 1 && hqRows[0].key === rk, `#15 總部：${k} 有對應的一列`, hqRows);
    if (!['unmapped', 'payroll_diff', 'transfer_ask', 'needs_hq_count', 'candidates_count', 'transfer_failed'].includes(k)) {
      ok(L.alertRows({ [k]: feed(k) }, lead).length === 1, `#15 店長：${k} 有對應的一列`);
    }
  }
  const mkp = (o) => ({ emp_no: 'DZY050', status: 'active', clock_total: 1, clock_stopped: 0, last_day: '', clocks: [], ...o });
  ok(L.personFilter('overdue', mkp({ last_day: '2026-10-01' }), '2026-10-13') && !L.personFilter('overdue', mkp({ last_day: '2026-10-01', status: 'disabled' }), '2026-10-13') && !L.personFilter('overdue', mkp({ last_day: '2026-10-20' }), '2026-10-13'), '#15 篩選 overdue：離職日已過且還沒停用');
  ok(L.personFilter('homestopped', mkp({ clocks: [{ role: 'home', roster_active: false }] }), 'x') && !L.personFilter('homestopped', mkp({ clocks: [{ role: 'support', roster_active: false }] }), 'x') && !L.personFilter('homestopped', mkp({ last_day: '2026-10-31', clocks: [{ role: 'home', roster_active: false }] }), 'x'), '#15 篩選 homestopped：在職、沒登記離職、主店被停');
  // 下拉選項清單（匯出的 FILTERS，也是畫面實際用來產生 <option> 的那份）：首頁提醒用到的每個篩選值都要在裡面
  const { FILTERS } = await import('../modules/staff/views/list.js');
  const optVals = FILTERS.map((x) => x[0]);
  for (const v of ['left', 'nohome', 'overdue', 'homestopped']) ok(optVals.includes(v), `#15 同仁名單下拉有篩選選項 ${v}`, optVals);
  const lstSrc = fs.readFileSync(path.join(ROOT, 'modules/staff/views/list.js'), 'utf8');
  ok(/FILTERS\.map\(/.test(lstSrc), '#15 下拉選項確實由 FILTERS 產生');
  // 首頁提醒導到名單的每個 f 參數，名單都得有對應選項（或是已知的特例 namediff＝看全部）
  const fVals = L.alertRows({ left_but_active: [1], leave_overdue: [1], home_stopped: [1], no_home_map: [1], name_diff: [1] }, hq).filter((r) => r.view === 'list').map((r) => r.params.f);
  ok(fVals.every((v) => optVals.includes(v) || v === 'namediff'), '#15 提醒導到名單的 f 參數都有下拉選項', fVals);
}
// #19 姓名上限 20
ok(L.NAME_MAX === 20 && L.addFormErrors({ ...good, name: 'x'.repeat(20) }, '2026-10-13').length === 0 && L.addFormErrors({ ...good, name: 'x'.repeat(21) }, '2026-10-13').length === 1, '#19 姓名 20 字可、21 字擋下');
{
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok(!/maxlength="30"/.test(ui) && (ui.match(/maxlength="20"/g) || []).length >= 2, '#19 姓名欄 maxlength 都是 20');
}
// #20 試跑：clockJobStatus 不是讀取；前端遇到 dryrun 結果不輪詢
{
  const { isReadAction, READ_ACTIONS } = await import('../platform/dryrun.js');
  ok(!READ_ACTIONS.platform.includes('clockJobStatus') && !isReadAction('platform', 'clockJobStatus', { job_id: 'J1' }), '#20 clockJobStatus 不在試跑讀取白名單（取連結金鑰有副作用）');
  ok(L.isDryRunResult({ ok: true, dryrun: true, data: { dryRun: true } }) && !L.isDryRunResult({ ok: true, data: { job_id: 'J1' } }), '#20 isDryRunResult 辨識試跑回應');
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok((ui.match(/isDryRunResult\(/g) || []).length >= 4, '#20 新增／取連結（兩處）／建立對照 遇到試跑結果都不輪詢');
  // 行為：試跑回應 → 新增流程不呼叫 clockJobStatus
  const { openAddFlow } = await import('../modules/staff-shared/clock-ui.js');
  const calls = [];
  const dlgQueue = [];
  globalThis.document = { createElement: () => { const el = { _h: '', set innerHTML(v) { this._h = v; this.children = []; }, get innerHTML() { return this._h; }, querySelector: (sel) => (sel === '#ad-name' ? { value: '測試人' } : sel === '#ad-hire' ? { value: '2026-10-13' } : sel === '#ad-phone' ? { value: '0912000111' } : sel === '#ad-title' ? { value: 'pt' } : null) }; return el; } };
  const toasts = [];
  const ctxD = { ui: { dialog: async () => 'ok', toast: (m, t) => toasts.push(m), loading() {}, confirm: async () => true },
    api: { call: async (m, a) => { calls.push(a); return a === 'staffCreateByUnit' ? { ok: true, dryrun: true, data: { dryRun: true } } : { ok: false }; } } };
  const done = await openAddFlow({ ctx: ctxD, mod: 'me', viewer: lead, org: { titles: [] }, myUnitName: '光復', reload: async () => {} });
  ok(done === false && !calls.includes('clockJobStatus') && toasts.some((t) => t.includes('試跑模式')), '#20 試跑新增：不輪詢 clockJobStatus、顯示試跑訊息', { calls, toasts });
  delete globalThis.document;
}
// #22 總部單位部門主管開店長分頁 → 白話說明，不露 no_perm
{
  ok(L.storeLeadOnlyText({ ok: false, code: 'no_perm', error: '沒有權限' }).includes('門市店長') && L.storeLeadOnlyText({ ok: false, code: 'busy' }) === '', '#22 storeLeadOnlyText 只對 no_perm 出白話說明');
  const { mountTeam, mountClockMap } = await import('../modules/staff-shared/clock-ui.js');
  for (const [name, fn] of [['我的單位', mountTeam], ['打卡對照', mountClockMap]]) {
    const el = { innerHTML: '', addEventListener() {}, removeEventListener() {} };
    const ctx = { params: {}, api: { call: async () => ({ ok: false, code: 'no_perm', error: 'no_perm' }) }, ui: {} };
    const stop = fn(el, { ctx, mod: 'me', viewer: { isHq: false, isLead: true } });
    await new Promise((r) => setTimeout(r, 20));
    ok(el.innerHTML.includes('這個分頁給門市店長用') && !el.innerHTML.includes('no_perm'), `#22 ${name}：收到 no_perm 顯示白話說明`, el.innerHTML);
    if (typeof stop === 'function') stop();
  }
}

// #10 總部／admin 進「我的單位」：後端回全部單位 → 標題「全部單位」＋單位篩選下拉
{
  const { mountTeam } = await import('../modules/staff-shared/clock-ui.js');
  const mk = (n, u, un) => ({ emp_no: n, name: '人' + n, status: 'active', unit: u, unit_name: un, title_name: '', clocks: [], clock_total: 0, clock_stopped: 0 });
  const el = { innerHTML: '', _l: {}, addEventListener(t, f) { this._l[t] = f; }, removeEventListener() {} };
  const ctx = { params: {}, ui: {}, api: { call: async (m, a) => {
    if (a === 'staffUnitList') return { ok: true, data: { people: [mk('A1', 'u-gf', '新竹光復'), mk('B1', 'u-hq', '總部')], unit: '' } };
    if (a === 'orgOptions') return { ok: true, data: { brands: [], units: [{ code: 'u-gf', name: '新竹光復', parent: 'b' }, { code: 'u-hq', name: '總部', parent: 'b' }], depts: [], titles: [] } };
    return { ok: true, data: { outbox_failed: [] } };
  } } };
  const stop = mountTeam(el, { ctx, mod: 'me', viewer: { isHq: true, isLead: false } });
  await new Promise((r) => setTimeout(r, 20));
  ok(el.innerHTML.includes('我的單位｜全部單位') && !el.innerHTML.includes('我的單位｜新竹光復'), '#10 總部標題顯示「全部單位」，不是第一個人的單位', el.innerHTML.slice(0, 200));
  ok(el.innerHTML.includes('data-role="unit-filter"') && el.innerHTML.includes('value="u-gf"'), '#10 有單位篩選下拉（選項來自 orgOptions）');
  el._l.change && el._l.change({ target: { getAttribute: (k) => (k === 'data-role' ? 'unit-filter' : null), value: 'u-hq' } });
  ok(el.innerHTML.includes('人B1') && !el.innerHTML.includes('人A1'), '#10 選單位後只列該單位的人');
  if (typeof stop === 'function') stop();
}

// ---- 接線：manifest／檔案存在／分層 ----
for (const id of ['me', 'staff']) {
  const m = (await import(`../modules/${id}/manifest.js`)).default;
  ok(validateManifest(m).ok, `${id} manifest 仍通過驗證`);
}
const me = (await import('../modules/me/manifest.js')).default;
const staff = (await import('../modules/staff/manifest.js')).default;
ok(me.views.some((v) => v.id === 'team') && me.views.some((v) => v.id === 'clock'), 'me 多了「我的單位」「打卡對照」分頁');
ok(me.views.find((v) => v.id === 'team').requires.join() === 'platform.review', '店長分頁只要 platform.review（一般同仁看不到）');
ok(staff.views.some((v) => v.id === 'clockmap' && v.requires.join() === 'platform.staff'), 'staff 多了「打卡對照」分頁（總部）');
for (const f of ['modules/staff-shared/clock-lib.js', 'modules/staff-shared/clock-ui.js', 'modules/staff-shared/viewer.js', 'modules/me/views/team.js', 'modules/me/views/clock.js', 'modules/staff/views/clockmap.js']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // 去掉註解再檢查
  ok(!/from '\.\.\/(\.\.\/)*platform\//.test(s), `${f} 沒有 import platform/`);
  ok(!/localStorage|sessionStorage|indexedDB/.test(s), `${f} 不碰瀏覽器儲存（打卡金鑰不落地）`);
  ok(!/console\.(log|info|debug)/.test(s), `${f} 不 console 輸出（金鑰不進 log）`);
}
const idx = fs.readFileSync(path.join(ROOT, 'modules/me/index.js'), 'utf8');
ok(/team: mountTeamView/.test(idx) && /clock: mountClockView/.test(idx), 'me/index.js 有接線新分頁（入口點得到）');
const sidx = fs.readFileSync(path.join(ROOT, 'modules/staff/index.js'), 'utf8');
ok(/clockmap: mountClockmap/.test(sidx) && /clockAlerts/.test(sidx), 'staff/index.js 有接線打卡對照與 clockAlerts');

// ---- 未認領者（單位空）卡片顯示 ----
ok(/const unitOf = \(x\) => x\.unit_name \|\| x\.unit \|\| '單位未填（未認領）'/.test(fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8')), '對照卡片：單位為空時顯示「單位未填（未認領）」而不是空白');

// ---- 總部設為主店（clockSetHome）----
{
  const cx = (x, v) => L.homeAction(Object.assign({ state: 'confirmed', role: 'support' }, x), v);
  ok(cx({}, hq) === 'btn', '「設為主店」：總部、已確認、不是主店 → 出現按鈕');
  ok(cx({ role: 'home' }, hq) === 'mark', '已是主店 → 只顯示「主店」標記、不給按鈕');
  ok(cx({ state: 'suggested' }, hq) === '' && cx({ state: 'rejected' }, hq) === '', '待確認／已退回的列不出現');
  ok(cx({}, lead) === '' && cx({}, { isHq: false }) === '' && cx({}, null) === '', '店長與非總部看不到按鈕');
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok(/data-act="cm-home"/.test(ui) && /ctx\.ui\.confirm\(`要把 \$\{emp\} 的主店指定為/.test(ui) && /'clockSetHome'/.test(ui) && /homeAction\(x, \{ isHq \}\) === 'btn'/.test(ui), '按鈕接線：二次確認後呼叫 clockSetHome、成功後 act() 重新載入');
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(!isReadAction('platform', 'clockSetHome', { emp_no: 'DZY001', store_code: 'hq' }), 'dryrun 不放行 clockSetHome（是寫入）');
}

ok(L.alertRows({ no_home_map: [1] }, hq).some((r) => r.text.includes('沒有打卡對照的人無法考勤')), 'no_home_map 提醒文字說明後果（無法考勤）');

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);

