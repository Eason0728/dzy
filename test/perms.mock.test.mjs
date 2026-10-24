// node test/perms.mock.test.mjs —— 個人帳號第二期 P1 後端計算（docs/permissions/task.md T1-1～T1-3）
// 用 vm 載入 Perms.gs（單檔），假 SpreadsheetApp／Utilities。全部假資料。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'platform', 'Perms.gs'), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  return {
    getLastRow: () => data.length,
    getRange(row, col, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const range = {
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const src = data[row - 1 + r] || [];
            const o = [];
            for (let c = 0; c < nc; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); }
            out.push(o);
          }
          return out;
        },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) {
            const ri = row - 1 + r;
            while (data.length <= ri) data.push([]);
            for (let c = 0; c < vals[r].length; c++) {
              const ci = col - 1 + c;
              while (data[ri].length <= ci) data[ri].push('');
              data[ri][ci] = vals[r][c];
            }
          }
          return range;
        }
      };
      return range;
    },
    _data: data
  };
}

function load(seed) {
  const sheets = {};
  Object.keys(seed || {}).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const sb = {
    console,
    SpreadsheetApp: { getActive: () => ss },
    Utilities: {
      formatDate(d, tz, fmt) {
        if (tz !== 'Asia/Taipei' || fmt !== 'yyyy-MM-dd') throw new Error('unexpected formatDate args');
        return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      }
    }
  };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'Perms.gs' });
  return { sb, sheets };
}

const { sb } = load({});
const P = sb;

// ── 組織（對應 Staff.gs 預設 org）──
const ORG = {
  units: {
    'mala-gf': { ladder: 'store', parent: 'mala' }, 'mala-mc': { ladder: 'store', parent: 'mala' }, 'mala-ny': { ladder: 'store', parent: 'mala' },
    'mala-hq': { ladder: 'office', parent: 'mala' },
    'mzt-gf': { ladder: 'store', parent: 'mzt' }, 'mzt-js': { ladder: 'store', parent: 'mzt' }, 'mzt-hq': { ladder: 'office', parent: 'mzt' },
    ck: { ladder: 'store', parent: 'ck' },
    'dzy-hq': { ladder: 'hq', parent: 'dzy' }
  },
  depts: { ops: { parent: 'dzy-hq', active: true }, mgmt: { parent: 'dzy-hq', active: true }, fin: { parent: 'dzy-hq', active: true }, hr: { parent: 'dzy-hq', active: true }, it: { parent: 'dzy-hq', active: true } },
  titles: { sm: { parent: 'store', rank: 2 }, ft: { parent: 'store', rank: 1 }, pt: { parent: 'store', rank: 0 }, ofs: { parent: 'office', rank: 1 }, oam: { parent: 'office', rank: 2 }, osv: { parent: 'office', rank: 2 }, odir: { parent: 'office', rank: 3 }, hs: { parent: 'hq', rank: 1 }, hm: { parent: 'hq', rank: 2 }, ceo: { parent: 'hq', rank: 3 }, gm: { parent: 'hq', rank: 4 }, chair: { parent: 'hq', rank: 5 } }
};
const STORE_MAP = { 'mala-gf': 'sxl-gf', ck: 'ck', 'mzt-gf': 'mzt-gf', 'mzt-js': 'mzt-js', 'mzt-lzl': 'mzt-lzl' };
const TODAY = '2026-10-17';

// 預設規則：用 permInit_ 建出來再讀回（同時驗讀表 helper）
const dbInit = load({});
const r0 = dbInit.sb.permInit_({ role: 'admin', id: 'boss' });
const tables = dbInit.sb.permLoadTables_();
const RULES = tables.rules;

function staffOf(o) { return Object.assign({ emp_no: 'E1', status: 'active', brand: 'mala', unit: 'mala-gf', dept: '', title: 'ft', extra_depts: [] }, o); }
function run(staff, extra) {
  const st = staffOf(staff);
  const args = Object.assign({ staff: st, org: ORG, rules: RULES, exs: [], storeMap: STORE_MAP, today: TODAY }, extra || {});
  // 例外要帶本人工號才生效（permCompute_ 不採用沒工號的例外）；測試沒特別指定時補上本人工號
  args.exs = (args.exs || []).map((x) => ('emp_no' in x ? x : Object.assign({ emp_no: st.emp_no }, x)));
  return P.permCompute_(args);
}
const has = (res, p) => res.perms.indexOf(p) !== -1;

// ===== T1-1 =====
ok(eq(P.PERM_GRANTABLE, ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap', 'store.void', 'att.extra', 'payroll.write', 'cashbook.write', 'platform.bulletin', 'platform.purchase']), 'PERM_GRANTABLE 與契約一致（含營運系統新增的 store.void、att.extra，薪酬系統 payroll.write，收支管理 cashbook.write，2026-10-26 加公告管理 platform.bulletin 共 14 碼）');
ok(eq(P.PERM_LOCKED, ['platform.users', 'platform.permmap', 'audit.write', 'platform.staff', 'payroll.write', 'cashbook.write']), 'PERM_LOCKED 與契約一致（六碼，2026-10-19 加薪酬系統、2026-10-25 加收支管理；2026-10-26 公告管理不鎖）');
ok(P.PERM_LOCKED.indexOf('platform.bulletin') === -1 && P.PERM_GRANTABLE.indexOf('platform.bulletin') !== -1, '公告管理可給、不在鎖碼（人資主管可在個別例外給）');
ok(r0.ok === true && r0.rules_seeded === 34 && r0.stores_seeded === 5, 'permInit_ admin：空庫建表＋33 條規則＋5 筆對照（2026-10-20 加 am／fm／rdd 六條、10-24 加收支管理、10-26 加公告管理六條）', r0);
ok(eq(r0.created, ['perm_map', 'perm_ex', 'perm_store_map', 'perm_audit']), '四張分頁都建出來', r0.created);
ok(RULES.length === 34 && RULES[0].rule_id === 'R001' && RULES[19].rule_id === 'R020' && RULES[19].perm === 'store.void' && RULES[32].rule_id === 'R033', '規則編號 R001..R033（R020＝店長 store.void，既有編號不變）', [RULES[0], RULES[19], RULES[32]]);
// 2026-10-26：R028–R033 公告管理預設規則（總監 hm 不分部門、辦公室 odir、廚藝總監 rdd、執行長／總經理／董事長）
ok(eq(RULES.slice(27, 33).map((r) => [r.rule_id, r.ladder, r.dept, r.title, r.perm]), [
  ['R028', 'hq', '', 'hm', 'platform.bulletin'], ['R029', 'office', '', 'odir', 'platform.bulletin'], ['R030', 'store', '', 'rdd', 'platform.bulletin'],
  ['R031', 'hq', '', 'ceo', 'platform.bulletin'], ['R032', 'hq', '', 'gm', 'platform.bulletin'], ['R033', 'hq', '', 'chair', 'platform.bulletin']]), 'R028–R033：公告管理的預設規則（順序固定）', RULES.slice(27));
ok(['am', 'fm', 'rdd'].every((t) => ['audit.read.own', 'store.void'].every((p) => RULES.slice(20).some((r) => r.ladder === 'store' && r.title === t && r.perm === p && r.dept === ''))), '第 21–26 條：am／fm／rdd 與店長同一套（audit.read.own、store.void）', RULES.slice(20));
ok(eq(tables.storeMap, STORE_MAP), '店別對照 5 筆讀回一致', tables.storeMap);
ok(tables.inited === true && tables.exs.length === 0, 'permLoadTables_ inited，例外為空');
ok(dbInit.sheets.perm_audit._data[0].join('|') === 'at|by|emp_no|added|removed|cause|seen', 'perm_audit 表頭正確');
{
  const hr = RULES.filter((r) => r.ladder === 'hq' && r.dept === 'hr');
  ok(hr.length === 4 && hr.filter((r) => r.title === 'hm').length === 1 && hr.find((r) => r.title === 'hm').perm === 'platform.permmap', 'hr 規則：* 三條＋hm 一條 permmap', hr);
}
{
  const again = dbInit.sb.permInit_({ role: 'admin', id: 'boss' });
  ok(again.ok && again.rules_seeded === 0 && again.stores_seeded === 0 && again.created.length === 0, '重跑不重複建、不重複寫', again);
  ok(dbInit.sheets.perm_map._data.length === 35 && dbInit.sheets.perm_store_map._data.length === 6, '重跑後列數不變（34+表頭、5+表頭）');
}
{
  const d = load({});
  const bad = d.sb.permInit_({ role: 'staff', id: 'x' });
  ok(bad.ok === false && bad.error === 'no_perm', 'permInit_ 非 admin 拒絕', bad);
  ok(d.sheets.perm_map === undefined, '非 admin 拒絕時沒有建任何分頁');
  ok(d.sb.permInit_(null).ok === false, 'permInit_ 沒帶 auth 拒絕');
  ok(d.sb.permLoadTables_().inited === false, '未初始化 permLoadTables_ 回 inited:false');
}
{
  const d = load({ perm_ex: [['ex_id', 'emp_no', 'WRONG']] });
  const bad = d.sb.permInit_({ role: 'admin', id: 'boss' });
  ok(bad.ok === false && bad.error === 'header_mismatch', '表頭被改 permInit_ 回錯', bad);
  ok(d.sheets.perm_map === undefined, '表頭不一致時一張都不建');
}
{
  const d = load({});
  d.sb.permInit_({ role: 'admin', id: 'boss' });
  d.sheets.perm_map._data.push(['R020', 'store', '', 'ft', 'dorm.read', 'FALSE', '', '']);
  d.sheets.perm_ex._data.push(['X001', 'dzy001', 'dorm.read', 'ADD', new Date(Date.UTC(2026, 9, 31, 15, 59, 59)), 'x', true, '', '', '', '']);
  const t = d.sb.permLoadTables_();
  ok(t.rules.length === 34, 'permLoadTables_ 只取 active=TRUE 的規則', t.rules.length);
  ok(t.exs.length === 1 && t.exs[0].emp_no === 'DZY001' && t.exs[0].mode === 'add' && t.exs[0].until === '2026-10-31', '例外：布林 TRUE、Date 物件正規化、大小寫', t.exs[0]);
}
{
  const d = load({
    org: [['kind', 'code', 'name', 'parent', 'ladder', 'rank', 'order', 'active'],
      ['unit', 'mala-gf', '光復', 'mala', 'store', '', 1, 'TRUE'], ['unit', 'old', '舊', 'mala', 'store', '', 2, 'FALSE'],
      ['title', 'sm', '店長', 'store', '', 2, 2, 'TRUE'], ['dept', 'hr', '人資', 'dzy-hq', '', '', 2, 'TRUE']]
  });
  const o = d.sb.permOrgIndex_();
  ok(o.units['mala-gf'].ladder === 'store' && o.units['mala-gf'].parent === 'mala' && o.units.old.active === false, 'permOrgIndex_ units', o.units);
  ok(o.titles.sm.parent === 'store' && o.titles.sm.rank === 2 && o.depts.hr.parent === 'dzy-hq', 'permOrgIndex_ titles／depts', o);
}

// ===== T1-2：門市 =====
{
  const pt = run({ title: 'pt' }); const ft = run({ title: 'ft' }); const sm = run({ title: 'sm' });
  ok(eq(pt.perms, []) && pt.auditScope === 'none', '門市計時 pt：無權限、scope none', pt);
  ok(eq(ft.perms, []) && ft.auditScope === 'none', '門市正職 ft：無權限', ft);
  ok(eq(sm.perms, ['audit.read.own', 'store.void']) && eq(sm.auditScope, ['sxl-gf']), '店長 sm：audit.read.own＋store.void、scope [sxl-gf]', sm);
  ok(eq(sm.sources, [{ perm: 'audit.read.own', source: 'title', rule_id: 'R001' }, { perm: 'store.void', source: 'title', rule_id: 'R020' }]), '店長 sources 來源是職稱＋rule_id', sm.sources);
  const ck = run({ brand: 'ck', unit: 'ck', title: 'sm' });
  ok(eq(ck.auditScope, ['ck']), '央廚店長 ck（ladder store）：scope [ck]', ck);
  const nomap = run({ unit: 'mala-mc', title: 'sm' });
  ok(eq(nomap.perms, ['audit.read.own', 'store.void']) && eq(nomap.auditScope, []), '店長所在單位沒有店別對照：scope []', nomap);
}
// ===== 品牌辦公室 =====
{
  const ofs = run({ unit: 'mala-hq', title: 'ofs' });
  ok(eq(ofs.perms, []) && ofs.auditScope === 'none', '品牌辦公室行政同仁：無權限', ofs);
  for (const t of ['oam', 'osv', 'odir']) {
    const r = run({ unit: 'mala-hq', title: t });
    // 2026-10-26：odir（總監）另有預設規則 R029 公告管理；oam／osv 沒有
    ok(eq(r.perms, t === 'odir' ? ['audit.read.brand', 'platform.bulletin'] : ['audit.read.brand']), `辦公室 ${t}：audit.read.brand${t === 'odir' ? '＋platform.bulletin' : ''}`, r);
  }
  const osv = run({ unit: 'mala-hq', title: 'osv' });
  ok(eq(osv.auditScope, ['sxl-gf']), '小辛辣區督導 scope 只含小辛辣有對照的店（美村南昌無對照被略過）', osv.auditScope);
  const mzt = run({ brand: 'mzt', unit: 'mzt-hq', title: 'odir' });
  ok(eq(mzt.auditScope, ['mzt-gf', 'mzt-js']), '墨竹亭總監 scope 只含墨竹亭的店、已排序', mzt.auditScope);
  ok(!mzt.auditScope.includes('sxl-gf') && !mzt.auditScope.includes('ck'), '品牌 scope 不含他牌的店與央廚');
}
// ===== 總部 =====
{
  const cases = [
    ['ops', 'hs', ['audit.read']], ['mgmt', 'hs', ['audit.read', 'audit.write']], ['fin', 'hm', ['audit.read', 'audit.write', 'cashbook.write', 'platform.bulletin', 'platform.purchase']],
    ['hr', 'hs', ['dorm.read', 'dorm.write', 'platform.staff']], ['hr', 'hm', ['dorm.read', 'dorm.write', 'platform.bulletin', 'platform.permmap', 'platform.staff']]
  ];
  for (const [dept, title, expect] of cases) {
    const r = run({ brand: 'dzy', unit: 'dzy-hq', dept, title });
    ok(eq(r.perms, expect.slice().sort()), `總部 ${dept}/${title} 權限`, r.perms);
  }
  const hs = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  ok(!has(hs, 'platform.permmap'), '人資同仁沒有 platform.permmap');
  ok(run({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' }).auditScope === 'none', '人資主管沒有稽核 scope none');
  ok(run({ brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' }).auditScope === 'all', '營運同仁 scope all');
  for (const t of ['ceo', 'gm', 'chair']) {
    const r = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: t });
    ok(has(r, 'audit.read') && has(r, 'dorm.read') && !has(r, 'platform.users'), `${t} 有 audit.read、dorm.read`, r.perms);
    ok(has(r, 'platform.bulletin'), `${t} 有 platform.bulletin（2026-10-26 預設規則）`, r.perms);
  }
  // 2026-10-26：公告管理只給總監級以上；總部一般同仁、各部門主管以外的職稱沒有
  ok(!has(run({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' }), 'platform.bulletin') && !has(run({ unit: 'mala-gf', title: 'sm' }), 'platform.bulletin') && !has(run({ unit: 'mala-hq', title: 'osv' }), 'platform.bulletin'), '人資同仁／店長／區督導沒有 platform.bulletin');
  const it = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  // 2026-10-26：總監 hm 不分部門有公告管理（R028）；其他預設權限 it 仍不在表
  ok(eq(it.perms, ['platform.bulletin']), '資訊部主管只有公告管理（it 不在表；hm 不分部門的 R028）', it);
}
// ===== 兼任 =====
{
  const r = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs', extra_depts: ['fin'] });
  ok(eq(r.perms, ['audit.read', 'audit.write', 'cashbook.write', 'platform.purchase']) && r.auditScope === 'all', '主部門 ops 兼 fin → 有 audit.write、貨單核對', r);
  const s = r.sources.find((x) => x.perm === 'audit.write');
  ok(s.source === 'dept' && s.rule_id, 'audit.write 來源是部門', s);
  const r2 = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs', extra_depts: ['', 'hr'] });
  ok(has(r2, 'platform.staff') && !has(r2, 'platform.permmap'), '兼任 hr 的同仁拿到同仁名單但不是 permmap（hm 才有）', r2.perms);
}
// ===== 例外 =====
{
  const hq = { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' };
  const add = run(Object.assign({}, { unit: 'mala-gf', title: 'ft' }), { exs: [{ ex_id: 'X001', perm: 'dorm.read', mode: 'add', until: '' }] });
  ok(eq(add.perms, ['dorm.read']), '例外 add 多給', add);
  ok(eq(add.sources, [{ perm: 'dorm.read', source: 'exception', ex_id: 'X001' }]), '例外 add 的 sources', add.sources);
  const rm = run(hq, { exs: [{ ex_id: 'X002', perm: 'audit.read', mode: 'remove', until: '' }] });
  ok(eq(rm.perms, []) && rm.auditScope === 'none', '例外 remove 拿掉 audit.read → scope none', rm);
  const both = run(hq, { exs: [{ ex_id: 'X003', perm: 'audit.read', mode: 'add', until: '' }, { ex_id: 'X004', perm: 'audit.read', mode: 'remove', until: '' }] });
  ok(!has(both, 'audit.read') && !both.sources.some((s) => s.perm === 'audit.read'), 'remove 優先於 add（兩條都在）', both);
  const rev = run(hq, { exs: [{ perm: 'audit.read', mode: 'remove', until: '' }, { perm: 'audit.read', mode: 'add', until: '' }] });
  ok(!has(rev, 'audit.read'), 'remove 優先與列順序無關', rev.perms);
  const same = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: TODAY }] });
  ok(has(same, 'dorm.read') && same.sources[0].until === TODAY, '到期日當天仍有效（附 until）', same);
  const next = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: '2026-10-16' }], today: '2026-10-17' });
  ok(!has(next, 'dorm.read'), '隔天失效', next);
  const edge = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: '2026-10-17' }], today: '2026-10-18' });
  ok(!has(edge, 'dorm.read'), '到期日隔天（today 2026-10-18）失效');
  const rmExp = run(hq, { exs: [{ perm: 'audit.read', mode: 'remove', until: '2026-10-01' }] });
  ok(has(rmExp, 'audit.read'), '過期的 remove 不再生效');
  const dateObj = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: new Date(Date.UTC(2026, 9, 17, 15, 59, 59)) }] });
  ok(has(dateObj, 'dorm.read'), 'Date 物件 until（UTC 15:59:59＝台北當天 23:59:59）仍有效');
  const dateObj2 = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: new Date(Date.UTC(2026, 9, 16, 16, 0, 0)) }], today: '2026-10-17' });
  ok(has(dateObj2, 'dorm.read'), 'Date 物件 UTC 16:00:00 ＝台北隔天 00:00 → 日期為 10-17，當天有效');
  const badDate = run({ title: 'ft' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: 'garbage' }] });
  ok(!has(badDate, 'dorm.read'), '壞日期的 add 不生效（fail closed）');
  const otherEmp = run({ title: 'ft', emp_no: 'DZY001' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: '', emp_no: 'dzy002' }] });
  ok(!has(otherEmp, 'dorm.read'), '例外帶 emp_no 且不是本人 → 略過');
  const sameEmp = run({ title: 'ft', emp_no: 'DZY001' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: '', emp_no: 'dzy001' }] });
  ok(has(sameEmp, 'dorm.read'), '例外 emp_no 大小寫不分比對本人');
  const wl = run({ title: 'ft' }, { exs: [{ perm: 'platform.permex', mode: 'add', until: '' }, { perm: '*', mode: 'add', until: '' }, { perm: 'platform.review', mode: 'add', until: '' }, { perm: 'dorm.write', mode: 'add', until: '' }] });
  ok(eq(wl.perms, ['dorm.write']), '白名單外（permex／*／review）被丟掉', wl.perms);
  const wl2 = run({ title: 'sm' }, { rules: RULES.concat([{ rule_id: 'R099', ladder: 'store', dept: '', title: '*', perm: '*' }, { rule_id: 'R098', ladder: 'store', dept: '', title: '*', perm: 'platform.self' }]) });
  ok(eq(wl2.perms, ['audit.read.own', 'store.void']), '規則裡白名單外的碼也被丟掉', wl2.perms);
  const write = run({ title: 'ft' }, { exs: [{ perm: 'audit.write', mode: 'add', until: '' }] });
  ok(write.auditScope === 'all', 'audit.write ⇒ scope all（spec 13 #7）', write);
  const wrNoRead = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' }, { exs: [{ perm: 'audit.read', mode: 'remove', until: '' }] });
  ok(has(wrNoRead, 'audit.write') && !has(wrNoRead, 'audit.read') && wrNoRead.auditScope === 'all', '拿掉 audit.read 但留 audit.write：scope 仍 all');
  const ownRm = run({ title: 'sm' }, { exs: [{ perm: 'audit.read.own', mode: 'remove', until: '' }] });
  ok(eq(ownRm.perms, ['store.void']) && ownRm.auditScope === 'none', '店長被拿掉 audit.read.own → 只剩 store.void、scope none');
}
// ===== 非 active、輸出形狀 =====
for (const st of ['disabled', 'pending', 'inactive', '', undefined]) {
  const r = run({ status: st, brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hm' }, { exs: [{ perm: 'dorm.read', mode: 'add', until: '' }] });
  ok(eq(r, { perms: [], auditScope: 'none', sources: [] }), `status=${JSON.stringify(st)} 回空權限＋none`, r);
}
{
  const r = run({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' }, { rules: RULES.concat(RULES) });
  ok(eq(r.perms, Array.from(new Set(r.perms)).sort()), '輸出陣列去重＋依代碼排序（規則重複也不重複）', r.perms);
  ok(r.sources.length === r.perms.length, '重複規則的 sources 也去重', r.sources);
  const none = run({ unit: 'not-exist', title: 'sm' });
  ok(eq(none.perms, []) && none.auditScope === 'none', '單位不在 org：fail closed');
  ok(eq(P.permCompute_(null), { perms: [], auditScope: 'none', sources: [] }), 'input 空：回空');
}
// ===== 數字型代碼 =====
{
  const org = { units: { 123: { ladder: 'store', parent: 77 }, 456: { ladder: 'office', parent: 77 }, 789: { ladder: 'store', parent: 77 } }, titles: { 5: { parent: 'store', rank: 2 }, 6: { parent: 'office', rank: 2 } } };
  const rules = [{ rule_id: 'R001', ladder: 'store', dept: '', title: 5, perm: 'audit.read.own' }, { rule_id: 'R002', ladder: 'office', dept: '', title: 6, perm: 'audit.read.brand' }];
  const r = P.permCompute_({ staff: { status: 'active', brand: 77, unit: 123, dept: '', title: 5, extra_depts: [] }, org, rules, exs: [], storeMap: { 123: 'S1', 789: 'S2' }, today: TODAY });
  ok(eq(r.perms, ['audit.read.own']) && eq(r.auditScope, ['S1']), '數字型 unit／title／brand 也能比對', r);
  const b = P.permCompute_({ staff: { status: 'active', brand: 77, unit: 456, dept: '', title: 6, extra_depts: [] }, org, rules, exs: [], storeMap: { 123: 'S1', 789: 'S2' }, today: TODAY });
  ok(eq(b.auditScope, ['S1', 'S2']), '數字型 brand 的品牌 scope', b);
  const d = P.permCompute_({ staff: { status: 'active', brand: 'dzy', unit: 'dzy-hq', dept: 7, title: 'hs', extra_depts: [8] }, org: Object.assign({}, ORG, { depts: { 7: { active: true }, 8: { active: true } } }), rules: [{ rule_id: 'R1', ladder: 'hq', dept: 8, title: '*', perm: 'dorm.read' }], exs: [], storeMap: {}, today: TODAY });
  ok(eq(d.perms, ['dorm.read']), '數字型部門（含兼任）也能比對', d);
}

// ===== permNormDate_ =====
ok(P.permNormDate_('2026-10-31') === '2026-10-31', 'permNormDate_ 字串');
ok(P.permNormDate_('2026/1/5') === '2026-01-05', 'permNormDate_ 斜線補零');
ok(P.permNormDate_(new Date(Date.UTC(2026, 9, 31, 16, 0, 0))) === '2026-11-01', 'permNormDate_ Date UTC 16:00 → 台北隔天');
ok(P.permNormDate_(new Date(Date.UTC(2026, 9, 31, 15, 59, 59))) === '2026-10-31', 'permNormDate_ Date UTC 15:59:59 → 台北當天');
ok(P.permNormDate_('2026-02-30') === '' && P.permNormDate_('abc') === '' && P.permNormDate_(null) === '' && P.permNormDate_(46000) === '' && P.permNormDate_(new Date('x')) === '', 'permNormDate_ 無效回空字串');

// ===== 審查修正：例外只採本人、讀表不吞無效日期 =====
{
  const raw = (st, exs, extra) => P.permCompute_(Object.assign({ staff: staffOf(st), org: ORG, rules: RULES, exs, storeMap: STORE_MAP, today: TODAY }, extra || {}));
  ok(!has(raw({ title: 'ft' }, [{ perm: 'dorm.read', mode: 'add', until: '' }]), 'dorm.read'), '例外沒有 emp_no → 不採用（add 不生效）');
  const hq = { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' };
  ok(has(raw(hq, [{ perm: 'audit.read', mode: 'remove', until: '' }]), 'audit.read'), '例外沒有 emp_no → remove 也不採用');
  ok(!has(raw({ title: 'ft', emp_no: '' }, [{ emp_no: 'E1', perm: 'dorm.read', mode: 'add', until: '' }]), 'dorm.read'), '本人沒有工號 → 所有例外不採用');
  const d = load({});
  d.sb.permInit_({ role: 'admin', id: 'boss' });
  d.sheets.perm_ex._data.push(['X001', 'e1', 'dorm.read', 'add', '2026-13-45', 'x', true, '', '', '', '']);
  d.sheets.perm_ex._data.push(['X002', 'e1', 'dorm.write', 'remove', 'garbage', 'x', true, '', '', '', '']);
  const t = d.sb.permLoadTables_();
  ok(t.exs[0].until !== '' && t.exs[1].until !== '', '讀表：無效日期不被正規化成空字串（空字串＝永不到期）', t.exs);
  const withRules = RULES.concat([{ rule_id: 'R900', ladder: 'store', dept: '', title: 'ft', perm: 'dorm.write' }]);
  const res = P.permCompute_({ staff: staffOf({ title: 'ft', emp_no: 'E1' }), org: ORG, rules: withRules, exs: t.exs, storeMap: STORE_MAP, today: TODAY });
  ok(!has(res, 'dorm.read'), '讀表後：無效日期的 add 例外不生效', res.perms);
  ok(!has(res, 'dorm.write'), '讀表後：無效日期的 remove 例外照樣生效（fail closed）', res.perms);
}

// ===== 審查修正：組織一致性 =====
{
  const org2 = (patch) => {
    const o = JSON.parse(JSON.stringify(ORG));
    patch(o);
    return o;
  };
  const rc = (st, org) => P.permCompute_({ staff: staffOf(st), org, rules: RULES, exs: [], storeMap: STORE_MAP, today: TODAY });
  const base = rc({ unit: 'mala-gf', title: 'sm' }, ORG);
  ok(has(base, 'audit.read.own'), '（對照）正常店長有 audit.read.own');
  const stopUnit = rc({ unit: 'mala-gf', title: 'sm' }, org2((o) => { o.units['mala-gf'].active = false; }));
  ok(eq(stopUnit.perms, []) && stopUnit.auditScope === 'none', '單位停用 → 空權限＋none', stopUnit);
  const stopTitle = rc({ unit: 'mala-gf', title: 'sm' }, org2((o) => { o.titles.sm.active = false; }));
  ok(eq(stopTitle.perms, []) && stopTitle.auditScope === 'none', '職稱停用 → 空權限＋none', stopTitle);
  const noTitle = rc({ unit: 'mala-gf', title: 'ghost' }, ORG);
  ok(eq(noTitle.perms, []) && noTitle.auditScope === 'none', '職稱不存在 → 空權限＋none');
  const wrongLadder = rc({ unit: 'mala-gf', title: 'hm' }, ORG);
  ok(eq(wrongLadder.perms, []) && wrongLadder.auditScope === 'none', '職稱階梯與單位階梯不符 → 空權限＋none', wrongLadder);
  const hqWrong = rc({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'sm' }, ORG);
  ok(eq(hqWrong.perms, []), '總部單位掛店面職稱 → 空權限（hr 部門規則也不給）', hqWrong);
  // brand：以 unit.parent 為準，staff.brand 寫成別牌不影響
  const ofs = rc({ brand: 'mzt', unit: 'mala-hq', title: 'oam' }, ORG);
  ok(eq(ofs.auditScope, ['sxl-gf']), 'brand 一律用 unit.parent（staff.brand 寫別牌也只看 mala）', ofs.auditScope);
  const ofs2 = rc({ brand: 'mala', unit: 'mzt-hq', title: 'oam' }, ORG);
  ok(eq(ofs2.auditScope, ['mzt-gf', 'mzt-js']), 'staff.brand 寫成 mala 但單位是 mzt-hq → 看 mzt 的店', ofs2.auditScope);
  // 部門：停用或不存在的部門不採用
  const stopDept = rc({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' }, org2((o) => { o.depts.hr.active = false; }));
  ok(!has(stopDept, 'platform.permmap') && !has(stopDept, 'platform.staff'), '主部門停用 → dept 規則不命中', stopDept.perms);
  const stopExtra = rc({ brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs', extra_depts: ['fin'] }, org2((o) => { o.depts.fin.active = false; }));
  ok(!has(stopExtra, 'audit.write'), '兼任部門停用 → 不命中', stopExtra.perms);
  const ghostDept = rc({ brand: 'dzy', unit: 'dzy-hq', dept: 'zzz', title: 'hs' }, ORG);
  ok(eq(ghostDept.perms, []), '部門不存在 → 不命中', ghostDept.perms);
  // 品牌 scope 不含停用的單位
  const scopeStop = rc({ unit: 'mala-hq', title: 'oam' }, org2((o) => { o.units['mala-gf'].active = false; }));
  ok(!scopeStop.auditScope.includes('sxl-gf'), '品牌 scope 不含已停用的單位', scopeStop.auditScope);
  // permOrgIndex_ 帶 active
  const od = load({ org: [['kind', 'code', 'name', 'parent', 'ladder', 'rank', 'order', 'active'],
    ['unit', 'a', 'A', 'mala', 'store', '', 1, 'FALSE'], ['title', 't', 'T', 'store', '', 1, 1, 'FALSE'], ['dept', 'd', 'D', 'dzy-hq', '', '', 1, 'FALSE']] });
  const oi = od.sb.permOrgIndex_();
  ok(oi.units.a.active === false && oi.titles.t.active === false && oi.depts.d.active === false, 'permOrgIndex_ 的 unit／title／dept 都帶 active 旗標', oi);
}

// ===== T1-3 驗證 =====
const VORG = {
  units: ORG.units,
  titles: Object.assign({}, ORG.titles, { old: { parent: 'store', rank: 1, active: false } }),
  depts: { hr: { parent: 'dzy-hq', active: true }, fin: { parent: 'dzy-hq', active: true }, gone: { parent: 'dzy-hq', active: false } }
};
const vr = (rule, admin) => P.permValidateRule_(rule, VORG, admin === undefined ? true : admin);
const code = (x) => (x ? x.error : null);
ok(vr({ ladder: 'store', dept: '', title: 'sm', perm: 'audit.read.own' }) === null, '規則合法：回 null');
ok(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'dorm.read' }) === null, '規則合法：hq＋部門＋*');
ok(vr({ ladder: 'store', dept: '', title: '*', perm: 'audit.read.own' }) === null, '規則合法：title * 不必在 org');
ok(code(vr({ ladder: 'store', dept: '', title: 'sm', perm: 'platform.permex' })) === 'bad_perm', 'bad_perm：permex 不在白名單');
ok(code(vr({ ladder: 'store', dept: '', title: 'sm', perm: '*' })) === 'bad_perm', 'bad_perm：*');
ok(code(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'platform.permmap' }, false)) === 'perm_locked', 'perm_locked：非 admin 碰 permmap');
ok(code(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'platform.users' }, false)) === 'perm_locked', 'perm_locked：非 admin 碰 users');
ok(code(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'audit.write' }, false)) === 'perm_locked', 'perm_locked：非 admin 碰 audit.write');
ok(code(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'platform.staff' }, false)) === 'perm_locked', 'perm_locked：非 admin 碰 platform.staff');
ok(code(vr({ ladder: 'store', dept: '', title: 'sm', perm: 'cashbook.write' }, false)) === 'perm_locked', 'perm_locked：非 admin 碰 cashbook.write（2026-10-25 審查 B-01）');
ok(vr({ ladder: 'store', dept: '', title: 'sm', perm: 'cashbook.write' }, true) === null, 'admin 可碰 cashbook.write');
ok(code(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'audit.write' }, true)) === null, 'admin 可碰 audit.write');
ok(vr({ ladder: 'hq', dept: 'hr', title: 'hm', perm: 'platform.permmap' }, true) === null, 'admin 碰鎖碼合法');
ok(vr({ ladder: 'hq', dept: 'hr', title: '*', perm: 'dorm.read' }, false) === null, '非 admin 碰非鎖碼合法');
ok(code(vr({ ladder: 'galaxy', dept: '', title: '*', perm: 'dorm.read' })) === 'bad_target', 'bad_target：ladder 非法');
ok(code(vr({ ladder: 'store', dept: '', title: 'hm', perm: 'dorm.read' })) === 'bad_target', 'bad_target：職稱不屬於該 ladder');
ok(code(vr({ ladder: 'store', dept: '', title: 'old', perm: 'dorm.read' })) === 'bad_target', 'bad_target：職稱已停用');
ok(code(vr({ ladder: 'store', dept: '', title: 'zzz', perm: 'dorm.read' })) === 'bad_target', 'bad_target：職稱不存在');
ok(code(vr({ ladder: 'store', dept: 'hr', title: '*', perm: 'dorm.read' })) === 'bad_target', 'bad_target：非 hq 不能填部門');
ok(code(vr({ ladder: 'hq', dept: 'gone', title: '*', perm: 'dorm.read' })) === 'bad_target', 'bad_target：部門已停用');
ok(code(vr({ ladder: 'hq', dept: 'nope', title: '*', perm: 'dorm.read' })) === 'bad_target', 'bad_target：部門不存在');
ok(code(vr({ ladder: 5, dept: '', title: '*', perm: 'dorm.read' })) === 'bad_target', 'bad_target：數字 ladder');
ok(vr({ ladder: 'store', dept: '', title: 'hm', perm: 'audit.read.own' }).message.length > 0, '錯誤附中文 message');
{
  const org = { units: {}, titles: { 5: { parent: 'store', rank: 2 } }, depts: { 9: { parent: 'dzy-hq', active: true } } };
  ok(P.permValidateRule_({ ladder: 'store', dept: '', title: 5, perm: 'dorm.read' }, org, true) === null, '數字型 title 代碼驗證通過');
  ok(P.permValidateRule_({ ladder: 'hq', dept: 9, title: '*', perm: 'dorm.read' }, org, true) === null, '數字型 dept 代碼驗證通過');
}
const ve = (ex) => P.permValidateEx_(ex, TODAY);
const okEx = { perm: 'dorm.read', mode: 'add', until: '2026-10-31', note: '專案支援' };
ok(ve(okEx) === null, '例外合法：回 null');
ok(ve(Object.assign({}, okEx, { until: '' })) === null, '例外合法：until 空');
ok(ve(Object.assign({}, okEx, { until: TODAY })) === null, '例外合法：until 等於今天');
ok(code(ve(Object.assign({}, okEx, { perm: 'platform.permex' }))) === 'bad_perm', '例外 bad_perm');
ok(code(ve(Object.assign({}, okEx, { until: '2026-10-16' }))) === 'bad_until', '例外 bad_until：早於今天');
ok(code(ve(Object.assign({}, okEx, { until: '10/31' }))) === 'bad_until', '例外 bad_until：格式錯');
ok(code(ve(Object.assign({}, okEx, { until: '2026-02-30' }))) === 'bad_until', '例外 bad_until：不存在的日期');
ok(code(ve(Object.assign({}, okEx, { note: '' }))) === 'bad_note', '例外 bad_note：空');
ok(code(ve(Object.assign({}, okEx, { note: '   ' }))) === 'bad_note', '例外 bad_note：全空白');
ok(code(ve(Object.assign({}, okEx, { note: '字'.repeat(51) }))) === 'bad_note', '例外 bad_note：51 字');
ok(ve(Object.assign({}, okEx, { note: '字'.repeat(50) })) === null, '例外 note 剛好 50 字合法');
ok(code(ve(Object.assign({}, okEx, { mode: 'grant' }))) === 'bad_mode', '例外 bad_mode（額外錯誤碼）');

console.log(`\n通過 ${passed} / 失敗 ${failed}（共 ${passed + failed}）`);
if (failed) process.exit(1);
