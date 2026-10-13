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
  for (const a of ['staffUnitList', 'clockMapList', 'clockJobStatus', 'clockAlerts']) ok(isReadAction('platform', a, {}), `dryrun 放行讀取 ${a}`);
  ok(isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001', preview: true }), 'dryrun 放行 staffReinstate preview:true');
  ok(!isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001' }) && !isReadAction('platform', 'staffReinstate', { emp_no: 'DZY001', preview: false }), 'dryrun 擋真正的 staffReinstate');
  for (const a of ['staffCreateByUnit', 'staffLeave', 'staffLeaveCancel', 'staffRename', 'clockLink', 'clockMapDecide', 'clockMapBuild', 'clockOutboxRetry', 'clockOutboxCancel', 'clockOldHomeDecide', 'clockCandidateCreate', 'clockCandidateDismiss']) ok(!isReadAction('platform', a, {}), `dryrun 擋寫入 ${a}`);
}
{
  const ui = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
  ok(/clockOutboxCancel/.test(ui) && /data-act="job-cancel"/.test(ui) && /請填結案原因/.test(ui), '待辦單每筆有「結案」鈕，必填原因後送 clockOutboxCancel');
  ok(/data\.confirmed/.test(ui) && /name_diff === true/.test(ui), '全部對照用後端 confirmed；打卡姓名不同用 name_diff 布林');
  ok(!/btn btn-primary" data-act="cm-yes"/.test(ui) && /data-act="cm-yes"/.test(ui), '「對」不是紅色主按鈕（改用 --ok 綠）');
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

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
