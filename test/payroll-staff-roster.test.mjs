// node test/payroll-staff-roster.test.mjs —— 薪酬管理「差異清單＋一鍵帶入」平台端（StaffClock.gs 末節，2026-10-28）
// 驗：①薪酬門市 → 打卡店、單位 → 薪酬門市的對照（含總部四單位共用 hq、一悟品牌辦公室不歸任何一家）
//     ②支援別店、共用打卡機的人不會被算進支援店的名單 ③payrollStaffRoster 要 payroll.write、只回該回的欄位
//     ④bridge.js 只把 payroll_dzy_staff 改送平台、只帶 store
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
['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'StaffClock.gs', 'Code.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f }));

// ── 假資料 ─────────────────────────────────────────────
const stores = [
  { store_code: 'gf', store_name: '小辛辣 新竹光復', unit_code: 'sxl-gf', enabled: true, payroll_store: 'SSLGF' },
  { store_code: 'mztjs', store_name: '墨竹亭 新竹金山', unit_code: 'mzt-js', enabled: true, payroll_store: 'MZTJS' },
  { store_code: 'mztgf', store_name: '墨竹亭 新竹光復', unit_code: 'mzt-gf', enabled: true, payroll_store: '' },   // 正式表曾是空白
  { store_code: 'hq', store_name: '鼎兆元 總部', unit_code: 'dzy-hq,mzt-hq,mala-hq,yiwu-hq', enabled: true, payroll_store: 'HQ' },
  { store_code: 'cf', store_name: '中央廚房', unit_code: 'ck', enabled: true, payroll_store: 'CF' }
];
const org = sb.stfBuildOrg_([
  ['unit', 'sxl-gf', '新竹光復', 'mala', 'store', 0, 1, 'TRUE'], ['unit', 'mzt-js', '新竹金山', 'mzt', 'store', 0, 2, 'TRUE'],
  ['unit', 'mzt-gf', '墨竹亭新竹光復', 'mzt', 'store', 0, 3, 'TRUE'], ['unit', 'dzy-hq', '鼎兆元總部', 'dzy', 'hq', 0, 4, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣品牌辦公室', 'mala', 'office', 0, 5, 'TRUE'], ['unit', 'mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office', 0, 6, 'TRUE'],
  ['unit', 'yiwu-hq', '一悟燒肉品牌辦公室', 'yiwu', 'office', 0, 7, 'TRUE'], ['unit', 'ck', '中央工廠（央廚）', 'ck', 'store', 0, 8, 'TRUE'],
  ['title', 'pt', '計時', '', 'store', 1, 1, 'TRUE'], ['title', 'ft', '正職', '', 'store', 2, 2, 'TRUE'], ['title', 'hs', '部門同仁', '', 'hq', 1, 3, 'TRUE']
]);
const C = sb.STF_COL;
function person(emp, name, status, unit, title, last, hire) {
  const v = new Array(sb.STF_COL_COUNT).fill('');
  v[C.emp_no] = emp; v[C.name] = name; v[C.status] = status; v[C.unit] = unit; v[C.title] = title;
  return { emp, values: v, hire: hire || '', last: last || '' };
}
const staffAll = [
  person('DZY001', '甲一', 'active', 'mzt-js', 'ft', '', '2025-01-02'),
  person('DZY002', '乙二', 'unclaimed', 'mzt-js', 'pt'),           // 未認領也算在職
  person('DZY003', '丙三', 'disabled', 'mzt-js', 'pt'),            // 已停用
  person('DZY004', '丁四', 'active', 'mzt-js', 'pt', '2026-10-01'),// 最後上班日已過＝離職
  person('DZY005', '戊五', 'active', 'sxl-gf', 'ft'),              // 光復正職、去金山支援
  person('DZY006', '己六', 'active', 'mzt-gf', 'pt'),              // 墨竹亭光復、共用金山打卡機
  person('DZY007', '庚七', 'active', 'mala-hq', 'hs'),
  person('DZY008', '辛八', 'active', 'mzt-hq', 'hs'),
  person('DZY009', '壬九', 'active', 'yiwu-hq', 'hs'),
  person('DZY010', '癸十', 'active', 'dzy-hq', 'hs'),
  person('DZY011', '子十一', 'active', 'mzt-js', 'pt')             // 還沒有打卡帳號
];
const maps = [
  ['DZY001', 'mztjs', 'MZTJS05', 'home'], ['DZY002', 'mztjs', 'MZTJS08', 'home'], ['DZY003', 'mztjs', 'MZTJS09', 'home'],
  ['DZY004', 'mztjs', 'MZTJS10', 'home'], ['DZY005', 'gf', 'GF03', 'home'], ['DZY005', 'mztjs', 'MZTJS12', 'support'],
  ['DZY006', 'mztjs', 'MZTJS01', 'home'], ['DZY006', 'mztgf', 'MZTGF01', 'home'],
  ['DZY007', 'hq', 'HQ-07', 'home'], ['DZY008', 'hq', 'HQ-08', 'home'], ['DZY009', 'hq', 'HQ-09', 'home'], ['DZY010', 'hq', 'HQ-10', 'home'],
  ['DZY010', 'cf', 'HQ-10', 'support'], ['DZY001', 'gf', 'GF99', 'support', 'rejected']
].map(([emp_no, store_code, emp_id, role, state]) => ({ emp_no, store_code, emp_id, role, state: state || 'confirmed' }));
const TODAY = '2026-10-28';
const build = (p) => sb.payStaffRosterBuild_(p, staffAll, maps, stores, org, TODAY);

// ── 1. 對照 ─────────────────────────────────────────────
ok(sb.clkPayStoreOf_(stores[2]) === 'MZTGF', '1a: mztgf 的 payroll_store 空白 → 退回預設 MZTGF');
ok(sb.CLK_DEFAULT_STORES.filter((r) => r[0] === 'mztgf')[0][3] === 'MZTGF', '1b: CLK_DEFAULT_STORES 的 mztgf 已補 MZTGF');
ok(sb.payStoreOfUnit_('mala-hq', stores) === 'SSLHQ' && sb.payStoreOfUnit_('mzt-hq', stores) === 'MZTHQ' && sb.payStoreOfUnit_('dzy-hq', stores) === 'HQ', '1c: 總部三單位各歸 HQ／SSLHQ／MZTHQ（不跟 hq 打卡店的 HQ）');
ok(sb.payStoreOfUnit_('yiwu-hq', stores) === '', '1d: 一悟品牌辦公室不歸任何一家');
ok(sb.payStoreOfUnit_('ck', stores) === 'CF' && sb.payStoreOfUnit_('mzt-gf', stores) === 'MZTGF', '1e: 央廚→CF、墨竹亭光復→MZTGF');
ok(['SSLHQ', 'MZTHQ', 'HQ'].every((p) => sb.payClockStoreOf_(p, stores).store_code === 'hq'), '1f: 三個總部薪酬門市都去 hq 打卡店找編號');
ok(sb.payClockStoreOf_('MZTGF', stores).store_code === 'mztgf' && sb.payClockStoreOf_('NOPE', stores) === null, '1g: MZTGF→mztgf、不認得的→null');

// ── 2. 名單 ─────────────────────────────────────────────
const js = build('MZTJS');
const names = js.staff.map((s) => s.emp_no).join(',');
ok(names === 'DZY001,DZY002,DZY003,DZY004,DZY011', '2a: 金山名單只含所屬單位是金山的人（不含光復支援、墨竹亭光復共用打卡機）', names);
const st = Object.fromEntries(js.staff.map((s) => [s.emp_no, s]));
ok(st.DZY002.state === 'active' && st.DZY003.state === 'disabled' && st.DZY004.state === 'left', '2b: 未認領＝在職、停用＝disabled、最後上班日已過＝left');
ok(st.DZY001.emp_id === 'MZTJS05' && st.DZY011.emp_id === '', '2c: emp_id＝該打卡店 confirmed 對照；沒有打卡帳號＝空');
ok(js.ids.MZTJS12 && js.ids.MZTJS12.pay_store === 'SSLGF' && js.ids.MZTJS12.here === true, '2d: 支援帳號查得到、標出薪資歸光復');
ok(!js.ids.GF99, '2e: rejected 對照不列');
ok(js.ids.GF03 && js.ids.GF03.here === false, '2f: 別家打卡店的編號也查得到（here=false）');
ok(build('SSLHQ').staff.map((s) => s.emp_no).join() === 'DZY007' && build('MZTHQ').staff.map((s) => s.emp_no).join() === 'DZY008'
  && build('HQ').staff.map((s) => s.emp_no).join() === 'DZY010', '2g: 總部三家各自只有自己的人，一悟那位哪裡都不出現');
ok(build('HQ').ids['HQ-09'].pay_none === true && build('HQ').ids['HQ-09'].pay_store === '' && build('HQ').ids['HQ-10'].pay_none === false, '2g2: 一悟那位的編號標 pay_none（薪酬頁顯示尚未設薪資門市）');
ok(build('SSLHQ').staff[0].emp_id === 'HQ-07', '2h: SSLHQ 的人用 hq 打卡店的編號');
ok(build('MZTGF').staff.map((s) => s.emp_no + ':' + s.emp_id).join() === 'DZY006:MZTGF01', '2i: 墨竹亭光復用 MZTGF 編號（不是金山那個）');
ok(build('HQ').ids['HQ-10'].here === true, '2j: 同一編號在兩店都有時以這家打卡店優先');
const keys = Object.keys(js.staff[0]).sort().join(',');
ok(keys === 'emp_id,emp_no,hire_date,last_day,name,state,title,title_name,unit,unit_name', '2k: 只回這幾欄（沒有手機、生日、地址）', keys);

// ── 3. handler 守門 ───────────────────────────────────────
sb.clkSheetsReady_ = () => true;
sb.clkStaffAll_ = () => staffAll; sb.clkMaps_ = () => maps; sb.clkStores_ = () => stores; sb.stfReadOrg_ = () => org;
let perms = ['platform.self'];
sb.handleMe_ = (t) => (t === 'good' ? { ok: true, data: { perms, user: { id: 'u1', role: 'staff' } } } : { ok: false, error: '登入已失效' });
ok(!sb.handlePayrollStaffRoster_('bad', { store: 'MZTJS' }).ok, '3a: 沒登入擋');
ok(sb.handlePayrollStaffRoster_('good', { store: 'MZTJS' }).code === 'FORBIDDEN', '3b: 沒有 payroll.write 擋');
perms = ['payroll.write', 'payroll.store@MZTJS'];   // 2026-10-29 非 admin 要有負責門市才讀得到（見 3h）
const r = sb.handlePayrollStaffRoster_('good', { store: 'mztjs' });
ok(r.ok && r.data.store === 'MZTJS' && r.data.clock_store === 'mztjs' && r.data.staff.length === 5, '3c: 有權限回名單（店代碼不分大小寫）');
ok(sb.handlePayrollStaffRoster_('good', { store: '<x>' }).code === 'bad_input', '3d: 店代碼格式錯擋');
perms = ['*'];
ok(sb.handlePayrollStaffRoster_('good', { store: 'CF' }).ok, '3e: admin（*）可讀');

// 3h. 負責門市 scope（payroll-scope spec §2；測試編號 13m）：非 admin 只能讀 payroll.store@ 清單內的門市
perms = ['payroll.write', 'payroll.store@CF'];
const sf = sb.handlePayrollStaffRoster_('good', { store: 'SSLGF' });
ok(sf.ok === false && sf.code === 'FORBIDDEN' && sf.error === 'scope_forbidden', '13m-1: 只負責 CF 的人讀 SSLGF → FORBIDDEN／scope_forbidden', sf);
ok(sb.handlePayrollStaffRoster_('good', { store: 'CF' }).ok, '13m-2: 讀 CF 放行');
ok(sb.handlePayrollStaffRoster_('good', { store: 'cf' }).ok, '13m-3: 小寫 cf 正規化後放行');
perms = ['payroll.write'];
ok(sb.handlePayrollStaffRoster_('good', { store: 'CF' }).error === 'scope_forbidden', '13m-4: 沒任何負責門市 → 全擋');
perms = ['payroll.write', 'payroll.store@MZTJS', 'payroll.store@CF'];
ok(sb.handlePayrollStaffRoster_('good', { store: 'MZTJS' }).ok && sb.handlePayrollStaffRoster_('good', { store: 'SSLGF' }).error === 'scope_forbidden', '13m-5: 兩家都負責 → 兩家放行、第三家擋');
perms = ['payroll.store@CF'];
ok(sb.handlePayrollStaffRoster_('good', { store: 'CF' }).code === 'FORBIDDEN' && sb.handlePayrollStaffRoster_('good', { store: 'CF' }).error !== 'scope_forbidden', '13m-6: 只有 payroll.store@ 沒有 payroll.write → 仍 FORBIDDEN（權限先擋）');
perms = ['*'];
ok(['SSLGF', 'MZTJS', 'CF', 'HQ'].every((st) => sb.handlePayrollStaffRoster_('good', { store: st }).ok), '13m-7: admin（*）任何門市放行');
// 3i. 負責門市不得看到別店同仁姓名／員編（final review C1）：ids 是全集團對照，非 admin 只留本店打卡店或薪資歸負責門市的人
perms = ['payroll.write', 'payroll.store@CF'];
const cfr = sb.handlePayrollStaffRoster_('good', { store: 'CF' });
const cfJson0 = JSON.stringify(cfr);
// 癸十（DZY010）薪資歸 HQ，只是在 CF 打卡店支援（here）→ 也不能看到（fix2-2 拿掉 here 例外）
const otherNames = ['甲一', '乙二', '丙三', '丁四', '戊五', '己六', '庚七', '辛八', '壬九', '癸十', '子十一'];
const otherEmps = ['DZY001', 'DZY002', 'DZY003', 'DZY004', 'DZY005', 'DZY006', 'DZY007', 'DZY008', 'DZY009', 'DZY010', 'DZY011'];
ok(cfr.ok && otherNames.every((n) => !cfJson0.includes(n)), '13n-1: 只負責 CF → 回傳 JSON 不含任何非 CF 同仁姓名', otherNames.filter((n) => cfJson0.includes(n)));
ok(otherEmps.every((e) => !cfJson0.includes(e)), '13n-2: 只負責 CF → 回傳 JSON 不含任何非 CF 同仁員編', otherEmps.filter((e) => cfJson0.includes(e)));
const THIN = 'pay_none,pay_store,state';
// 13n-3～4b：帶 emp_ids 時別店編號才回三欄（沒帶整筆不回，見 13n-14）
const cfrE = sb.handlePayrollStaffRoster_('good', { store: 'CF', emp_ids: ['GF03', 'HQ-10'] });
const cfJson = JSON.stringify(cfrE);
ok(cfrE.data.ids.GF03 && Object.keys(cfrE.data.ids.GF03).sort().join() === THIN && cfrE.data.ids.GF03.pay_store === 'SSLGF' && cfrE.data.ids.GF03.state === 'active',
  '13n-3: 帶 emp_ids → 別店編號只留 state／pay_store／pay_none（差異清單判斷用），沒有 name／emp_no／unit_name／store_code／here', cfrE.data.ids.GF03);
ok(cfrE.data.ids['HQ-10'] && Object.keys(cfrE.data.ids['HQ-10']).sort().join() === THIN && cfrE.data.ids['HQ-10'].pay_store === 'HQ',
  '13n-4: 帶 emp_ids → 在本打卡店支援、薪資歸別店（HQ）的人也只留三欄', cfrE.data.ids['HQ-10']);
ok(!cfJson.includes('鼎兆元總部') && !cfJson.includes('"here"'), '13n-4b: 只負責 CF → 回應沒有別店單位名稱、沒有 here 欄', cfJson.match(/.{0,30}(鼎兆元總部|"here").{0,30}/g));
perms = ['payroll.write', 'payroll.store@MZTJS', 'payroll.store@SSLGF'];
const jsr = sb.handlePayrollStaffRoster_('good', { store: 'MZTJS', emp_ids: ['GF03', 'MZTGF01', 'HQ-07', 'MZTJS01'] });
ok(jsr.data.ids.GF03.name === '戊五' && jsr.data.ids.GF03.emp_no === 'DZY005', '13n-5: 薪資歸負責門市（SSLGF）的別店編號保留完整', jsr.data.ids.GF03);
ok(jsr.data.ids.MZTGF01.name === undefined && jsr.data.ids['HQ-07'].name === undefined && jsr.data.ids.MZTJS01.name === undefined
  && jsr.data.ids.MZTJS05.name === '甲一', '13n-6: 非負責門市的別店編號沒有姓名（MZTJS01 雖在本打卡店，薪資歸 MZTGF 也一樣）');
// 13n-8：只負責 SSLHQ 的財務讀 SSLHQ（hq 打卡店共用：HQ／MZTHQ／一悟的人都在同一張打卡表）
perms = ['payroll.write', 'payroll.store@SSLHQ'];
const hqr = sb.handlePayrollStaffRoster_('good', { store: 'SSLHQ', emp_ids: ['HQ-08', 'HQ-09', 'HQ-10'] });
const hqJson = JSON.stringify(hqr);
ok(hqr.ok && ['辛八', '壬九', '癸十', 'DZY008', 'DZY009', 'DZY010'].every((n) => !hqJson.includes(n)) && hqr.data.ids['HQ-07'].name === '庚七',
  '13n-8: 只負責 SSLHQ → 看不到同打卡店 HQ／MZTHQ／一悟同仁的姓名員編；自己的人完整', ['辛八', '壬九', '癸十', 'DZY008', 'DZY009', 'DZY010'].filter((n) => hqJson.includes(n)));
ok(hqr.data.ids['HQ-08'].pay_store === 'MZTHQ' && hqr.data.ids['HQ-09'].pay_none === true && hqr.data.ids['HQ-10'].pay_store === 'HQ', '13n-9: 別店只回 pay_store／pay_none（可能看到別店代碼，不會看到人）');
// 13n-10：payload.emp_ids 是陣列 → ids 只回這些編號（＋本店名單的打卡編號，帶入後重算不會變「對不到」）；沒帶 → 照舊
perms = ['payroll.write', 'payroll.store@MZTJS'];
const eir = sb.handlePayrollStaffRoster_('good', { store: 'MZTJS', emp_ids: ['MZTJS12', ' MZTJS05 ', 'NOPE', 5] });
const eiKeys = Object.keys(eir.data.ids).sort().join();
ok(eir.ok && eiKeys === 'MZTJS05,MZTJS08,MZTJS09,MZTJS10,MZTJS12', '13n-10: 帶 emp_ids → 只回這些＋本店名單的打卡編號（不回 GF03／HQ-xx 等）', eiKeys);
ok(eir.data.ids.MZTJS12.name === undefined && eir.data.ids.MZTJS12.pay_store === 'SSLGF', '13n-11: emp_ids 篩選後仍套負責門市裁切');
perms = ['*'];
const eia = sb.handlePayrollStaffRoster_('good', { store: 'CF', emp_ids: ['GF03'] });
ok(Object.keys(eia.data.ids).sort().join() === 'GF03' && eia.data.ids.GF03.name === '戊五', '13n-12: admin 帶 emp_ids 也只回那些（＋本店名單），內容完整', Object.keys(eia.data.ids));
ok(JSON.stringify(sb.handlePayrollStaffRoster_('good', { store: 'CF', emp_ids: 'GF03' }).data.ids) === JSON.stringify(build('CF').ids), '13n-13: emp_ids 不是陣列 → 當沒帶（admin 全回）');
// 13n-14：非 admin 沒帶 emp_ids（或不是陣列）→ ids 只留薪資歸負責門市的編號，別店連 state／pay_store 都不回（不能列舉全集團打卡編號與其薪資門市）
perms = ['payroll.write', 'payroll.store@CF'];
const nf = sb.handlePayrollStaffRoster_('good', { store: 'CF' });
const nfBad = Object.keys(nf.data.ids).filter((k) => nf.data.ids[k].pay_store !== 'CF');
ok(nf.ok && nfBad.length === 0 && !('GF03' in nf.data.ids) && !('HQ-10' in nf.data.ids), '13n-14: 只負責 CF、沒帶 emp_ids → ids 只剩 pay_store=CF 的編號', nfBad);
perms = ['payroll.write', 'payroll.store@MZTJS'];
const nfj = sb.handlePayrollStaffRoster_('good', { store: 'MZTJS' });
ok(nfj.data.ids.MZTJS05 && nfj.data.ids.MZTJS05.name === '甲一' && Object.values(nfj.data.ids).every((x) => x.pay_store === 'MZTJS' && x.name !== undefined) && !('MZTJS12' in nfj.data.ids),
  '13n-15: 只負責 MZTJS、沒帶 emp_ids → 留下的（薪資歸 MZTJS）內容完整，薪資歸 SSLGF 的 MZTJS12 不回', Object.keys(nfj.data.ids));
perms = ['payroll.write', 'payroll.store@CF'];
const nfs = sb.handlePayrollStaffRoster_('good', { store: 'CF', emp_ids: 'GF03' });
ok(!('GF03' in nfs.data.ids) && Object.values(nfs.data.ids).every((x) => x.pay_store === 'CF'), '13n-16: emp_ids 不是陣列 → 當沒帶，同樣只回 pay_store∈L', Object.keys(nfs.data.ids));
perms = ['payroll.write', 'payroll.store@MZTJS', 'payroll.store@SSLGF'];
const nf2 = sb.handlePayrollStaffRoster_('good', { store: 'MZTJS' });
ok(nf2.data.ids.GF03 && nf2.data.ids.GF03.name === '戊五' && !('MZTJS01' in nf2.data.ids) && Object.values(nf2.data.ids).every((x) => ['MZTJS', 'SSLGF'].includes(x.pay_store)),
  '13n-17: 負責兩家、沒帶 emp_ids → 兩家薪資的人都完整，其他（含本打卡店薪資歸 MZTGF 的 MZTJS01）不回', Object.keys(nf2.data.ids));
perms = ['*'];
const adm = sb.handlePayrollStaffRoster_('good', { store: 'CF' });
ok(JSON.stringify(adm.data.ids) === JSON.stringify(build('CF').ids), '13n-7: admin（*）ids 不變（含別店姓名）');
const code = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
ok((code.match(/'payrollStaffRoster'/g) || []).length === 2, '3f: Code.gs 白名單＋分派各一次');
ok(READ_ACTIONS.platform.includes('payrollStaffRoster') && !(WRITE_ACTIONS.platform || []).includes('payrollStaffRoster'), '3g: dryrun 列為讀取');

// ── 4. bridge ────────────────────────────────────────────
const c1 = parseCall({ type: 'dzy-payroll-call', v: 1, id: 'c1', action: 'payroll_dzy_staff', body: { store: 'MZTJS', admin_key: 'x', extra: 1 } });
const to = routeOf(c1);
ok(to.ns === 'platform' && to.action === 'payrollStaffRoster' && JSON.stringify(to.payload) === '{"store":"MZTJS"}', '4a: payroll_dzy_staff 改送平台、只帶 store', to);
const c1e = parseCall({ type: 'dzy-payroll-call', v: 1, id: 'c1e', action: 'payroll_dzy_staff', body: { store: 'CF', emp_ids: ['CF01', 7, 'CF02', null, { x: 1 }], admin_key: 'x' } });
const toE = routeOf(c1e);
ok(JSON.stringify(toE.payload) === '{"store":"CF","emp_ids":["CF01","CF02"]}', '4a2: emp_ids（字串陣列）也帶過去，非字串元素丟掉（fix2-2）', toE.payload);
ok(!('emp_ids' in routeOf(parseCall({ type: 'dzy-payroll-call', v: 1, id: 'c1f', action: 'payroll_dzy_staff', body: { store: 'CF', emp_ids: 'CF01' } })).payload), '4a3: emp_ids 不是陣列就不帶');
const c2 = parseCall({ type: 'dzy-payroll-call', v: 1, id: 'c2', action: 'payroll_master_get', body: { store: 'CF' } });
ok(routeOf(c2).ns === 'payroll' && routeOf(c2).action === 'payroll_master_get', '4b: 其他照舊送薪資後端');
ok(Object.keys(PLATFORM_ROUTES).join() === 'payroll_dzy_staff', '4c: 只有這一支改道');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
