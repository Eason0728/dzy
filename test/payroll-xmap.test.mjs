// node test/payroll-xmap.test.mjs —— 薪酬計算「跨店支援時數自動帶入」平台端 payrollXmap（StaffClock.gs 末節，2026-11-05）
// 契約：mala-clock-in docs/support-auto/spec.md §2、§7-7～9
// 驗：①只出 confirmed／suggested ②pay_store 或 acct_store 空不出 ③個人例外帳號 not_support=true
//     ④非 admin 只回負責門市 ⑤只回六欄（不含姓名）⑥離職規則（上月以前離職不出、本月離職照出）
//     ⑦Code.gs 白名單＋分派、dryrun READ_ACTIONS ⑧bridge payroll_dzy_xmap 改道、不帶任何欄位
// ⚠ 全部假資料（public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { routeOf, parseCall, PLATFORM_ROUTES } from '../modules/payroll/bridge.js';
import { READ_ACTIONS, WRITE_ACTIONS } from '../platform/dryrun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
let passed = 0, failed = 0;
function ok(c, label, extra) {
  if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

const sb = { console };
vm.createContext(sb);
['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'StaffClock.gs', 'StoreOps.gs', 'Code.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f }));

// ── 假資料 ─────────────────────────────────────────────
const stores = [
  { store_code: 'gf', store_name: '小辛辣 新竹光復', unit_code: 'sxl-gf', enabled: true, payroll_store: 'SSLGF' },
  { store_code: 'mztjs', store_name: '墨竹亭 新竹金山', unit_code: 'mzt-js', enabled: true, payroll_store: 'MZTJS' },
  { store_code: 'mztgf', store_name: '墨竹亭 新竹光復', unit_code: 'mzt-gf', enabled: true, payroll_store: '' },   // 空白 → 預設 MZTGF
  { store_code: 'hq', store_name: '鼎兆元 總部', unit_code: 'dzy-hq,mzt-hq,mala-hq,yiwu-hq', enabled: true, payroll_store: 'HQ' },
  { store_code: 'cf', store_name: '中央廚房', unit_code: 'ck', enabled: true, payroll_store: 'CF' },
  { store_code: 'zz', store_name: '測試店', unit_code: 'zz-x', enabled: true, payroll_store: '' }    // 不在預設表 → 薪酬代碼空白
];
const org = sb.stfBuildOrg_([
  ['unit', 'sxl-gf', '新竹光復', 'mala', 'store', 0, 1, 'TRUE'], ['unit', 'mzt-js', '新竹金山', 'mzt', 'store', 0, 2, 'TRUE'],
  ['unit', 'mzt-gf', '墨竹亭新竹光復', 'mzt', 'store', 0, 3, 'TRUE'], ['unit', 'dzy-hq', '鼎兆元總部', 'dzy', 'hq', 0, 4, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣品牌辦公室', 'mala', 'office', 0, 5, 'TRUE'], ['unit', 'mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office', 0, 6, 'TRUE'],
  ['unit', 'yiwu-hq', '一悟燒肉品牌辦公室', 'yiwu', 'office', 0, 7, 'TRUE'], ['unit', 'ck', '中央工廠（央廚）', 'ck', 'store', 0, 8, 'TRUE'],
  ['title', 'pt', '計時', '', 'store', 1, 1, 'TRUE'], ['title', 'ft', '正職', '', 'store', 2, 2, 'TRUE'], ['title', 'hs', '部門同仁', '', 'hq', 1, 3, 'TRUE']
]);
const C = sb.STF_COL;
function person(emp, name, status, unit, title, last) {
  const v = new Array(sb.STF_COL_COUNT).fill('');
  v[C.emp_no] = emp; v[C.name] = name; v[C.status] = status; v[C.unit] = unit; v[C.title] = title;
  return { emp, values: v, hire: '', last: last || '' };
}
const staffAll = [
  person('DZY001', '甲一', 'active', 'mzt-js', 'ft'),
  person('DZY005', '戊五', 'active', 'sxl-gf', 'ft'),                 // 光復正職、去金山支援
  person('DZY009', '壬九', 'active', 'yiwu-hq', 'hs'),                // 一悟品牌辦公室：沒有薪酬門市 → 不出
  person('DZY010', '癸十', 'active', 'dzy-hq', 'hs'),                 // 總部、央廚有支援帳號
  person('DZY027', '例外甲', 'active', 'dzy-hq', 'hs'),               // STORE_NOT_SUPPORT_EX { DZY027: ['cf'] }
  person('DZY030', '上月離職', 'active', 'mzt-js', 'pt', '2026-10-31'),
  person('DZY031', '本月離職', 'active', 'mzt-js', 'pt', '2026-11-02'),
  person('DZY032', '已停用', 'disabled', 'mzt-js', 'pt'),
  person('DZY033', '沒單位', 'unclaimed', '', '')
];
const maps = [
  ['DZY001', 'mztjs', 'MZTJS05', 'home'],
  ['DZY001', 'gf', 'GF99', 'support', 'rejected'],
  ['DZY001', 'mztgf', 'MZTGF07', 'support', 'suggested'],
  ['DZY001', 'cf', 'CF77', 'support', 'pending'],
  ['DZY005', 'gf', 'GF03', 'home'], ['DZY005', 'mztjs', 'MZTJS12', 'support'],
  ['DZY005', 'zz', 'ZZ01', 'support'],                                // 打卡店沒有薪酬代碼 → 不出
  ['DZY005', 'nope', 'NO01', 'support'],                              // clock_stores 沒這家 → 不出
  ['DZY009', 'hq', 'HQ-09', 'home'],
  ['DZY010', 'hq', 'HQ-10', 'home'], ['DZY010', 'cf', 'CF10', 'support'],
  ['DZY027', 'hq', 'HQ-27', 'home'], ['DZY027', 'cf', 'CF27', 'support'],
  ['DZY030', 'mztjs', 'MZTJS30', 'home'], ['DZY031', 'mztjs', 'MZTJS31', 'home'], ['DZY032', 'mztjs', 'MZTJS32', 'home'],
  ['DZY033', 'mztjs', 'MZTJS33', 'home'],
  ['DZY999', 'mztjs', 'MZTJS99', 'home']                              // 同仁名單沒有這人 → 不出
].map(([emp_no, store_code, emp_id, role, state]) => ({ emp_no, store_code, emp_id, role, state: state || 'confirmed' }));
const TODAY = '2026-11-05';
const build = (scope) => sb.payXmapBuild_(staffAll, maps, stores, org, TODAY, scope === undefined ? null : scope);
const keyOf = (r) => r.emp_no + '@' + r.emp_id;

// ── 1. 純函式 ────────────────────────────────────────────
const all = build();
const byId = Object.fromEntries(all.map((r) => [r.emp_id, r]));
const ids = all.map((r) => r.emp_id).sort().join();
ok(ids === 'CF10,CF27,GF03,HQ-10,HQ-27,MZTGF07,MZTJS05,MZTJS12,MZTJS31,MZTJS32', '1a: admin 全部列（預期十列）', ids);
ok(all.every((r) => r.state === 'confirmed' || r.state === 'suggested'), '1b: state 只有 confirmed／suggested');
ok(!byId.GF99 && !byId.CF77, '1c: rejected、pending 不出');
ok(byId.MZTGF07 && byId.MZTGF07.state === 'suggested' && byId.MZTGF07.acct_store === 'MZTGF', '1d: suggested 照出，acct_store 空白時退回預設 MZTGF', byId.MZTGF07);
ok(!byId['HQ-09'], '1e: pay_store 空（一悟品牌辦公室）不出');
ok(!byId.MZTJS33, '1e2: 單位空白（未認領）→ pay_store 空不出');
ok(!byId.ZZ01 && !byId.NO01, '1f: acct_store 空（打卡店沒有薪酬代碼、clock_stores 沒這家）不出');
ok(!byId.MZTJS99, '1g: 同仁名單沒有這人不出');
ok(byId.CF27.not_support === true && byId['HQ-27'].not_support === false, '1h: 個人例外 DZY027 在央廚的帳號 not_support=true，總部帳號 false', [byId.CF27, byId['HQ-27']]);
ok(byId.CF10.not_support === false && byId.CF10.pay_store === 'HQ' && byId.CF10.acct_store === 'CF', '1i: 一般總部同仁在央廚＝支援（not_support=false），pay_store HQ、acct_store CF', byId.CF10);
ok(byId.MZTJS12.pay_store === 'SSLGF' && byId.MZTJS12.acct_store === 'MZTJS', '1j: 光復正職在金山的帳號：pay_store SSLGF、acct_store MZTJS', byId.MZTJS12);
ok(!byId.MZTJS30, '1k: 最後上班日在上個月（10/31）→ 不出');
ok(byId.MZTJS31, '1l: 本月才離職（11/02，已過）→ 照出（當月還要算薪）');
ok(byId.MZTJS32, '1m: 已停用但沒有最後上班日 → 照出（規則只排除上月以前離職）');
const KEYS = 'acct_store,emp_id,emp_no,not_support,pay_store,state';
ok(all.every((r) => Object.keys(r).sort().join() === KEYS), '1n: 每列只有六欄', all.map((r) => Object.keys(r).sort().join()).filter((k) => k !== KEYS));
const allJson = JSON.stringify(all);
ok(['甲一', '戊五', '癸十', '例外甲', '本月離職', '已停用'].every((n) => !allJson.includes(n)), '1o: 回傳不含任何姓名');
const sortKey = (r) => r.emp_no + '|' + r.acct_store + '|' + r.emp_id;
ok(all.map(sortKey).join() === all.map(sortKey).slice().sort().join(), '1p: 依 emp_no、acct_store、emp_id 排序', all.map(keyOf));
ok(JSON.stringify(build()) === JSON.stringify(all), '1q: 同一輸入結果相同');
// 月初邊界：today＝12/01 時，11/02 離職的那位就不出
ok(!sb.payXmapBuild_(staffAll, maps, stores, org, '2026-12-01', null).some((r) => r.emp_id === 'MZTJS31'), '1r: 下個月起，上月離職那位不出');
// scope
const sc = build(['SSLGF']);
ok(sc.map((r) => r.emp_id).sort().join() === 'GF03,MZTJS12', '1s: scope [SSLGF] → 只回 pay_store=SSLGF 的列（含他在金山的帳號）', sc.map((r) => r.emp_id));
ok(build([]).length === 0, '1t: scope 空陣列 → 一列都沒有');
ok(build(['HQ', 'MZTJS']).every((r) => ['HQ', 'MZTJS'].includes(r.pay_store)) && build(['HQ', 'MZTJS']).length === 8, '1u: scope 兩家 → 只回這兩家');

// ── 2. handler 守門 ──────────────────────────────────────
sb.clkSheetsReady_ = () => true;
sb.clkStaffAll_ = () => staffAll; sb.clkMaps_ = () => maps; sb.clkStores_ = () => stores; sb.stfReadOrg_ = () => org;
sb.clkTodayOf_ = () => TODAY;
let perms = ['platform.self'];
sb.handleMe_ = (t) => (t === 'good' ? { ok: true, data: { perms, user: { id: 'u1', role: 'staff' } } } : { ok: false, error: '登入已失效' });
ok(!sb.handlePayrollXmap_('bad', {}).ok, '2a: 沒登入擋');
ok(sb.handlePayrollXmap_('good', {}).code === 'FORBIDDEN', '2b: 沒有 payroll.write 擋');
perms = ['payroll.store@SSLGF'];
ok(sb.handlePayrollXmap_('good', {}).code === 'FORBIDDEN', '2c: 只有負責門市沒有 payroll.write 擋');
perms = ['*'];
const ra = sb.handlePayrollXmap_('good', { store: 'SSLGF', scope: ['x'], emp_ids: ['GF03'] });
ok(ra.ok && JSON.stringify(ra.data.rows) === JSON.stringify(all), '2d: admin 回全部，payload 其他欄位一律忽略', ra.data && ra.data.rows.length);
ok(typeof ra.data.generated_at === 'string' && !isNaN(Date.parse(ra.data.generated_at)) && /T.*Z$/.test(ra.data.generated_at), '2e: generated_at 是 ISO 字串', ra.data.generated_at);
ok(Object.keys(ra.data).sort().join() === 'generated_at,rows', '2f: data 只有 rows、generated_at');
perms = ['payroll.write', 'payroll.store@SSLGF'];
const rs = sb.handlePayrollXmap_('good', {});
ok(rs.ok && rs.data.rows.every((r) => r.pay_store === 'SSLGF') && rs.data.rows.length === 2, '2g: 非 admin 只回負責門市', rs.data && rs.data.rows);
perms = ['payroll.write'];
const rn = sb.handlePayrollXmap_('good', {});
ok(rn.ok && rn.data.rows.length === 0, '2h: 非 admin 沒有任何負責門市 → 空清單（不是全部）', rn);
perms = ['payroll.write', 'payroll.store@SSLGF'];
ok(sb.handlePayrollXmap_('good', { scope: '*' }).data.rows.length === 2, '2i: payload 帶 scope 不會放大範圍');
sb.clkSheetsReady_ = () => false;
ok(sb.handlePayrollXmap_('good', {}).ok === false, '2j: 分頁沒準備好 → not_ready');
sb.clkSheetsReady_ = () => true;

// ── 3. 白名單 ────────────────────────────────────────────
const code = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
ok((code.match(/'payrollXmap'/g) || []).length === 2, '3a: Code.gs 白名單＋分派各一次');
ok(READ_ACTIONS.platform.includes('payrollXmap') && !(WRITE_ACTIONS.platform || []).includes('payrollXmap'), '3b: dryrun 列為讀取');
ok(READ_ACTIONS.payroll.includes('payroll_xmap_get') && WRITE_ACTIONS.payroll.includes('payroll_xmap_set') && WRITE_ACTIONS.payroll.includes('payroll_support_decide'),
  '3c: 薪資代轉新 action：payroll_xmap_get 讀、payroll_xmap_set／payroll_support_decide 寫');
ok(JSON.stringify(sb.PROXY_READ_ACTIONS.payroll) === JSON.stringify(READ_ACTIONS.payroll) && JSON.stringify(sb.PROXY_WRITE_ACTIONS.payroll) === JSON.stringify(WRITE_ACTIONS.payroll),
  '3d: Auth.gs 與 dryrun.js 的 payroll 讀寫清單一致');

// ── 4. bridge ────────────────────────────────────────────
const c1 = parseCall({ type: 'dzy-payroll-call', v: 1, id: 'x1', action: 'payroll_dzy_xmap', body: { store: 'SSLGF', admin_key: 'k', scope: '*' } });
const to = routeOf(c1);
ok(to.ns === 'platform' && to.action === 'payrollXmap' && JSON.stringify(to.payload) === '{}', '4a: payroll_dzy_xmap 改送平台 payrollXmap、payload 一律 {}', to);
ok(Object.keys(PLATFORM_ROUTES).sort().join() === 'payroll_dzy_staff,payroll_dzy_xmap', '4b: 改道只有這兩支');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
