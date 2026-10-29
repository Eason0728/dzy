// node test/adv/rules_leave_gate.mjs —— 對抗驗證 2026-10-30 規則 1「離職當場停」
// （StaffClock.gs handleStaffLeave_／clkLeaveBlocks_、Staff.gs stfLoginGate_、StoreOps.gs storeIdent_）
// 攻擊面：當天登記→舊 token／登入；撤銷後重登；登記未來日期→日子到了（撥沙盒 Date）平台擋不擋、營運系統 svcStoreWho 擋不擋；
// 店長能不能藉此立刻踢同級；人資主管被登記後能不能自救；last_day 格式異常；每晚同步與當場停重疊。
'use strict';
import { world, BIG, post, shiftDays, SVC } from './_storeops_world.mjs';

let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const pad = (n) => (n < 10 ? '0' : '') + n;
function taipeiDay(offsetDays) {
  const t = new Date(Date.now() + (offsetDays || 0) * 86400000 + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
}
const me = (app, tok) => post(app.sb, 'me', {}, tok);
const leave = (app, tok, emp, last_day) => post(app.sb, 'staffLeave', { emp_no: emp, last_day }, tok);
const cancel = (app, tok, emp) => post(app.sb, 'staffLeaveCancel', { emp_no: emp }, tok);
const lastDayOf = (app, emp) => { const r = app.sheets.staff._data.find((x) => x[0] === emp); return r ? r[25] : undefined; };

// ── A. 當天登記：舊 token 立刻失效、登入擋、撤銷後可重登；營運系統 svcStoreWho 也要跟著變 inactive ──
{
  const app = world(BIG);
  const tok3 = app.login('DZY003');
  ok(me(app, tok3).ok, 'A 計時 DZY003 登入正常');
  ok(app.ident('DZY003').active === true, 'A 營運系統 svcStoreWho(DZY003) active');
  const r = leave(app, app.adminTok, 'DZY003', taipeiDay(0));
  ok(r.ok && r.data.can_cancel === true, 'A admin 登記離職日＝今天', r);
  ok(me(app, tok3).ok === false, 'A 舊 token 當場失效');
  ok(app.login('DZY003') === '', 'A 重新登入被擋');
  const lg = post(app.sb, 'login', { username: 'DZY003', password: 'fake-storeops-pw-01' });
  ok(lg.ok === false && /離職/.test(lg.error || ''), 'A 登入錯誤訊息＝已離職', lg);
  // 營運系統（Mac mini 8796 用 svcStoreWho 認身分）：平台說已離職，營運系統也應 inactive
  const w = app.ident('DZY003');
  ok(w.active === false, '【低：不一致】A 離職日＝今天的人，svcStoreWho 仍回 active:true（token_after 已變、既有營運系統 session 會被刪，但 ident／svcStoreRoster 仍說在職）', w);
  // 撤銷 → 可重登（舊 token 仍死）
  ok(cancel(app, app.adminTok, 'DZY003').ok, 'A 撤銷離職');
  ok(me(app, tok3).ok === false, 'A 撤銷後舊 token 仍失效（token_after 不回退）');
  const tokNew = app.login('DZY003');
  ok(tokNew !== '' && me(app, tokNew).ok, 'A 撤銷後可重新登入');
}

// ── B. 登記未來日期（明天）：今天照常；日子到了平台擋、營運系統也要擋；再過一天每晚同步才真的停用 ──
{
  const app = world(BIG);
  const tok5 = app.login('DZY005');
  const r = leave(app, app.adminTok, 'DZY005', taipeiDay(1));
  ok(r.ok, 'B admin 登記 DZY005 離職日＝明天', r);
  ok(me(app, tok5).ok, 'B 今天 token 照常');
  ok(app.ident('DZY005').active === true, 'B 今天營運系統 active');
  const tokenAfterBefore = app.sheets.users._data.find((x) => x[0] === 'u005')[10];
  shiftDays(app, 1);   // 明天 00:00 之後、每晚 00:10 同步之前
  ok(me(app, tok5).ok === false, 'B 日子到了：平台舊 token 擋（clkLeaveBlocks_）');
  ok(app.login('DZY005') === '', 'B 日子到了：登入擋');
  const sso = post(app.sb, 'ssoTicket', { aud: 'store' }, tok5);
  ok(sso.ok === false, 'B 日子到了：拿不到營運系統入場券', sso);
  const w = app.ident('DZY005');
  ok(w.active === false, '【應擋】B 日子到了：svcStoreWho 應 inactive（既有營運系統 session 整天仍有效＝漏洞）', w);
  const tokenAfterNow = app.sheets.users._data.find((x) => x[0] === 'u005')[10];
  ok(tokenAfterNow !== tokenAfterBefore && tokenAfterNow, '【應踢】B 日子到了但 token_after 沒變＝營運系統沿用 token_after 的 session 不會被踢', { before: tokenAfterBefore, now: tokenAfterNow });
  // 當天還能撤銷（last_day ≥ today）→ 放行
  ok(cancel(app, app.adminTok, 'DZY005').ok, 'B 離職日當天仍可撤銷');
  ok(app.login('DZY005') !== '', 'B 撤銷後可登入');
  // 再登記回明天... 這裡直接改回 last_day＝今天（撥過的今天），然後再撥一天跑每晚同步
  ok(leave(app, app.adminTok, 'DZY005', taipeiDay(1)).ok, 'B 重登記離職日＝（撥過的）今天');
  shiftDays(app, 2);
  const daily = app.sb.clockDailyApply_(taipeiDay(2)).data;
  ok(daily.disabled.indexOf('DZY005') !== -1, 'B 隔天每晚同步把他真的停用（不重複、不衝突）', daily);
  ok(app.login('DZY005') === '' && app.ident('DZY005').active === false, 'B 停用後登入擋、營運系統 inactive');
  const daily2 = app.sb.clockDailyApply_(taipeiDay(2)).data;
  ok(daily2.disabled.length === 0 && daily2.disable_errors.length === 0, 'B 同步再跑一次不重複、不報錯', daily2);
}

// ── C. 店長：同級不能登記（rank 檢查仍在前）；對下屬登記今天＝立刻踢（設計如此，記錄） ──
{
  const app = world(BIG);
  const tokSm = app.login('DZY001');
  const r1 = leave(app, tokSm, 'DZY008', taipeiDay(0));
  ok(r1.ok === false && r1.code === 'no_perm', 'C 店長不能對同級店長登記離職（clkLeaveTarget_ 職級檢查在前）', r1);
  const r2 = leave(app, tokSm, 'DZY004', taipeiDay(0));
  ok(r2.ok === false, 'C 店長不能對別店的人登記', r2);
  const r3 = leave(app, tokSm, 'DZY001', taipeiDay(0));
  ok(r3.ok === false && r3.code === 'self_leave', 'C 不能登記自己');
  const tok3 = app.login('DZY003');
  ok(leave(app, tokSm, 'DZY003', taipeiDay(0)).ok, 'C 店長對自店計時登記今天');
  ok(me(app, tok3).ok === false, 'C 計時當場被踢（店長現在有立即踢人的能力；之前要等每晚）');
  ok(leave(app, tokSm, 'DZY002', taipeiDay(-8)).code === 'last_day_past', 'C 店長往回超過 7 天 → 擋');
  ok(cancel(app, tokSm, 'DZY003').ok, 'C 店長可撤銷（當天）');
}

// ── D. 人資主管被登記離職 → 被鎖；admin 可解；人資主管 A 不能被店長登記 ──
{
  const app = world(BIG);
  const tokHr = app.login('DZY020');
  ok(me(app, tokHr).ok, 'D 人資主管登入');
  const r = leave(app, app.adminTok, 'DZY020', taipeiDay(0));
  ok(r.ok, 'D admin 對人資主管登記今天');
  ok(me(app, tokHr).ok === false && app.login('DZY020') === '', 'D 人資主管被鎖、無法自救（設計：要另一位 HQ／admin 撤銷）');
  ok(cancel(app, app.adminTok, 'DZY020').ok && app.login('DZY020') !== '', 'D admin 撤銷後人資主管可登入');
  ok(leave(app, app.login('DZY001'), 'DZY020', taipeiDay(0)).ok === false, 'D 店長不能對人資主管登記');
}

// ── E. last_day 格式異常：API 擋；表上被手改的怪值 → 守門行為 ──
{
  const app = world(BIG);
  for (const bad of ['', '2026/10/30', '20261030', '2026-13-01', 'tomorrow', '2026-2-3']) {
    const r = leave(app, app.adminTok, 'DZY003', bad);
    ok(r.ok === false && r.code === 'bad_input', `E API 擋壞格式 ${JSON.stringify(bad)}`, r);
  }
  ok(leave(app, app.adminTok, 'DZY003', taipeiDay(400)).code === 'last_day_far', 'E 太遠未來擋');
  ok(leave(app, app.adminTok, 'DZY003', '2020-01-01').ok, 'E 總部可登記很久以前（當場停）');
  ok(app.login('DZY003') === '', 'E 很久以前 → 擋');
  ok(cancel(app, app.adminTok, 'DZY003').code === 'leave_passed', 'E 過去日期不能撤銷（要走復職）');
  // 手改表：last_day 填成無連字號的過去日期 → 字串比較下不會被擋（疑慮：守門只做字串比較）
  const idx = app.sheets.staff._data.findIndex((x) => x[0] === 'DZY002');
  app.sheets.staff._data[idx][25] = '20200101';
  ok(app.login('DZY002') === '', 'E 表上 last_day=20200101（手改、過去）→ 字串比較剛好擋得住（但 20261001 這類同年無連字號的值就擋不住：疑慮，API 進不來）');
  app.sheets.staff._data[idx][25] = '';
  // Date 物件（Sheets 自動轉成日期）→ stfDate_ 會轉成 yyyy-mm-dd，照常擋
  app.sheets.staff._data[idx][25] = new Date(Date.now() - 86400000);
  ok(app.login('DZY002') === '', 'E 表上 last_day 是昨天的 Date 物件 → 擋');
  app.sheets.staff._data[idx][25] = '';
  ok(app.login('DZY002') !== '', 'E 清掉後可登入');
}

// ── F. 系統帳號（非 staff role）不受影響；LINE 重設密碼路徑對離職當天的人 ──
{
  const app = world(BIG);
  ok(me(app, app.adminTok).ok, 'F admin 不受守門影響');
  const hrSys = app.login('HRUSER');
  ok(hrSys !== '' && me(app, hrSys).ok, 'F 系統人資帳號（role hr、無 staff 列）照常');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
