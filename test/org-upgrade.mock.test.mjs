// node test/org-upgrade.mock.test.mjs —— 組織架構改版 Phase 1 後端驗收（docs/org/task.md T1–T4；規格以 spec.md 第 12 > 11 > 前文為準）
// 做法同 staff-clock.mock.test.mjs：Auth／Users／Staff／StaffClock／Code 讀進同一個 vm sandbox，對外 action 走 doPost。
// ⚠ 所有姓名、手機、地址都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'StaffClock.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件（同 staff.mock.test.mjs）──────────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const fmt = {};
  const sheet = {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const range = {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = data[row - 1 + r] || [];
            const o = [];
            for (let c = 0; c < numCols; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); }
            out.push(o);
          }
          return out;
        },
        setValue(v) { range.setValues([[v]]); },
        setValues(vals) {
          if (vals.length !== numRows || vals.some((r) => r.length !== numCols)) throw new Error('setValues 尺寸不符');
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
        },
        setNumberFormat(f) { for (let r = 0; r < numRows; r++) fmt[row + r] = f; return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    _rows: () => data.map((r) => r.slice()),
    _data: data,
    _fmt: fmt
  };
  return sheet;
}

function bytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff));
}
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }

function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-org-tests' };
  let uuid = 0;
  const sandbox = {
    console,
    SpreadsheetApp: { getActive: () => ss },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_a, v) => signed(crypto.createHash('sha256').update(bytes(v)).digest()),
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', bytes(k)).update(bytes(v)).digest()),
      base64Encode: (d) => bytes(d).toString('base64'),
      base64Decode: (s) => signed(Buffer.from(String(s), 'base64')),
      getUuid: () => 'fake-uuid-' + (++uuid)
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props };
}

function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
function freshSeed(h) {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, h.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'HR01', '測試人資', 'hr', '', salt, h.hashPassword_('fake-hr-pw-0001', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', ''], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;

function fresh() {
  const app = load(freshSeed(HASHER));
  app.sb.setupStaff();
  app.tok = post(app.sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
  app.hrTok = post(app.sb, 'login', { username: 'HR01', password: 'fake-hr-pw-0001' }).data.token;
  return app;
}

const PROF = (over) => Object.assign({ brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' }, over || {});
let pwSeq = 0;
/** 匯入＋認領＋由 BOSS 確認＋登入；回 {emp, token, name} */
function mk(app, name, over) {
  const { sb, tok } = app;
  const pw = 'fake-staff-pw-' + (++pwSeq + 1000);
  post(sb, 'staffImport', { names: [name] }, tok);
  const lk = post(sb, 'claimLookup', { name });
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw }, PROF(over)));
  if (!sub.ok) throw new Error('claimSubmit ' + name + ' ' + sub.error);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, tok);
  if (!cf.ok) throw new Error('staffConfirm ' + cf.error);
  const lg = post(sb, 'login', { username: lk.data.emp_no, password: pw });
  if (!lg.ok) throw new Error('login ' + lg.error);
  return { emp: lk.data.emp_no, token: lg.data.token, name, pw };
}
/** 只認領送出（不確認）→ 待審；回 {emp, name} */
function submitOnly(app, name, over) {
  const { sb, tok } = app;
  const pw = 'fake-staff-pw-' + (++pwSeq + 1000);
  post(sb, 'staffImport', { names: [name] }, tok);
  const lk = post(sb, 'claimLookup', { name });
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw }, PROF(over)));
  if (!sub.ok) throw new Error('claimSubmit ' + name + ' ' + sub.error);
  return { emp: lk.data.emp_no, name };
}
function rowsOf(app, name) {
  const rows = app.sheets[name]._rows();
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}
const staffOf = (app, emp) => rowsOf(app, 'staff').find((r) => r.emp_no === emp);
function setStaff(app, emp, header, value) {
  const d = app.sheets.staff._data;
  const idx = d.findIndex((r) => r[0] === emp);
  d[idx][d[0].indexOf(header)] = value;
}
const orgRows = (app) => app.sheets.org._rows();
const orgRow = (app, kind, code) => orgRows(app).find((r) => r[0] === kind && r[1] === code);
const login = (app, u, p) => post(app.sb, 'login', { username: u, password: p });

// ============================================================
// T1 組織預設值與 office 門檻
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const org = sb.stfReadOrg_();
  ok(org.brand.ck.name === '中央工廠' && org.unit.ck.name === '中央工廠（央廚）' && org.unit.ck.ladder === 'store', 'T1 ck 品牌與單位改名（單位代碼 ck 不變、仍 store）');
  ok(org.unit['mzt-hq'].name === '墨竹亭品牌辦公室' && org.unit['mzt-hq'].ladder === 'office' && org.unit['mala-hq'].name === '小辛辣品牌辦公室' && org.unit['mala-hq'].ladder === 'office', 'T1 mzt-hq／mala-hq 改名＋ladder＝office（代碼不變）');
  ok(org.unit['yiwu-hq'] && org.unit['yiwu-hq'].parent === 'yiwu' && org.unit['yiwu-hq'].ladder === 'office' && org.unit['yiwu-hq'].active, 'T1 新增 yiwu-hq 一悟燒肉品牌辦公室');
  ok(['mzt-wx', 'mzt-rg', 'mzt-mc'].every((c) => org.unit[c] && org.unit[c].active === false), 'T1 mzt-wx／rg／mc 預設停用');
  ok(org.dept.training && org.dept.training.name === '訓練部' && org.dept.training.parent === 'dzy-hq', 'T1 訓練部保留');
  ok(['pt', 'ft', 'sm'].every((c) => org.title[c].parent === 'store' && org.title[c].active) && ['am', 'sv', 'bd'].every((c) => org.title[c] && org.title[c].active === false), 'T1 門市只剩 pt／ft／sm；am／sv／bd 停用不刪');
  ok([['ofs', 1], ['oam', 2], ['osv', 3], ['odir', 4]].every(([c, r]) => org.title[c] && org.title[c].parent === 'office' && org.title[c].rank === r && org.title[c].active) && org.title.ofs.name === '行政同仁' && org.title.odir.name === '總監', 'T1 品牌辦公室 ofs／oam／osv／odir 四級');
  ok(sb.STF_UNIT_VIEW_MIN_RANK.office === 2 && sb.STF_UNIT_VIEW_MIN_RANK.store === 3 && sb.STF_UNIT_VIEW_MIN_RANK.hq === 2, 'T1 STF_UNIT_VIEW_MIN_RANK.office＝2');
  ok(typeof sb.stfTitleLadder_ === 'undefined', 'T1 沒有 stfTitleLadder_（第 13 節取消）');

  const v = (o) => sb.stfValidateOrg_(org, Object.assign({ brand: 'mala', unit: 'mala-hq', dept: '', title: 'osv' }, o));
  ok(v({}) === null && ['ofs', 'oam', 'osv', 'odir'].every((t) => v({ title: t }) === null), 'T1 正：品牌辦公室四級職稱都通過');
  ok(['pt', 'ft', 'sm', 'hs', 'hm', 'ceo', 'am', 'sv', 'bd'].every((t) => v({ title: t }) !== null), 'T1 反：品牌辦公室選門市／總部職稱 → 回錯');
  ok(v({ dept: 'it' }) !== null, 'T1 反：品牌辦公室填部門 → 回錯');
  ok(sb.stfValidateOrg_(org, { brand: 'yiwu', unit: 'yiwu-hq', dept: '', title: 'oam' }) === null, 'T1 正：一悟品牌辦公室可選 oam');
  const st = (t, u) => sb.stfValidateOrg_(org, { brand: 'mala', unit: u || 'mala-gf', dept: '', title: t });
  ok(['pt', 'ft', 'sm'].every((t) => st(t) === null && sb.stfValidateOrg_(org, { brand: 'ck', unit: 'ck', dept: '', title: t }) === null), 'T1 正：門市與 ck 可選 pt／ft／sm');
  ok(['am', 'sv', 'bd'].every((t) => st(t) !== null) && ['ofs', 'oam', 'osv', 'odir'].every((t) => st(t) !== null), 'T1 反：門市選停用的 am／sv／bd 或辦公室職稱 → 回錯');
  ok(sb.stfValidateOrg_(org, { brand: 'mzt', unit: 'mzt-mc', dept: '', title: 'pt' }) !== null, 'T1 反：停用的門市（mzt-mc）不能選');
  ok(sb.stfValidateOrg_(org, { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'sm' }) !== null, 'T1 反：總部單位仍不能選門市職稱');

  const opt = post(sb, 'orgOptions', {}).data;
  ok(opt.units.find((u) => u.code === 'mala-hq').ladder === 'office' && !opt.units.some((u) => u.code === 'mzt-mc'), 'T1 orgOptions：office 單位帶 ladder、停用單位不列');

  // 單位通訊錄：office 區督導(rank5)有、店長級(rank3)沒有
  const sv = mk(app, '測試甲', { brand: 'mala', unit: 'mala-hq', title: 'oam' });
  const am = mk(app, '測試乙', { brand: 'mala', unit: 'mala-hq', title: 'ofs' });
  const staff1 = mk(app, '測試丙', { brand: 'mala', unit: 'mala-hq', title: 'ofs' });
  const mu = post(sb, 'myUnit', {}, sv.token);
  ok(mu.ok && mu.data.unit_name === '小辛辣品牌辦公室' && mu.data.people.length === 3, 'T1 正：品牌辦公室區經理(rank2)有單位通訊錄', mu);
  ok(post(sb, 'myUnit', {}, am.token).ok === false, 'T1 反：品牌辦公室行政同仁(rank1)沒有單位通訊錄');
  ok(post(sb, 'myUnit', {}, staff1.token).ok === false, 'T1 反：品牌辦公室第二位行政同仁也沒有');
  // 門市店長仍有、沒受影響
  const smgr = mk(app, '測試丁', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  ok(post(sb, 'myUnit', {}, smgr.token).ok, 'T1 門市店長通訊錄不受影響');
  // 未知 ladder → 無主管權限
  app.sheets.org._data.find((r) => r[1] === 'mala-hq')[4] = 'weird';
  ok(sb.stfManagerScope_(sb.stfFindByEmp_(sv.emp).values, sb.stfReadOrg_()) === null, 'T1 未知 ladder 一律當無主管權限');
})();

// ============================================================
// T2 兼任部門 extra_depts
// ============================================================
(() => {
  const app = fresh();
  const { sb, tok, hrTok } = app;
  const lead = mk(app, '測試戊', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const crew = mk(app, '測試己', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  const sheetHead = () => app.sheets.staff._data[0];
  ok(sheetHead().slice(24, 27).join() === 'hire_date,last_day,extra_depts', 'T2 setup 後 staff 尾端欄＝hire_date,last_day,extra_depts（STF_HEADERS 未動）', sheetHead().slice(20));
  ok(sb.STF_HEADERS.length === 24, 'T2 STF_HEADERS 仍是 24 欄');

  const listOf = (t) => post(sb, 'staffList', {}, t || tok).data.staff;
  const item = (emp) => listOf().find((x) => x.emp_no === emp);
  ok(Array.isArray(item(crew.emp).extra_depts) && item(crew.emp).extra_depts.length === 0 && item(crew.emp).extra_dept_names.length === 0 && Array.isArray(item(crew.emp).flags), 'T2 list：沒有兼任＝[]、flags 陣列');

  // 人資可設
  const r1 = post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['training', 'it'] }, hrTok);
  ok(r1.ok && r1.data.staff.extra_depts.join() === 'it,training' && r1.data.staff.extra_dept_names.join() === '資訊部,訓練部', 'T2 正：人資可設兼任（依 org order 排序，回傳含名稱）', r1);
  ok(staffOf(app, crew.emp).extra_depts === 'it,training', 'T2 存成逗號字串、無空白、排序');
  ok(item(crew.emp).extra_depts.join() === 'it,training' && item(crew.emp).extra_dept_names.join() === '資訊部,訓練部', 'T2 list 回 extra_depts／extra_dept_names');
  const me = post(sb, 'myProfile', {}, crew.token);
  ok(me.ok && me.data.extra_depts.join() === 'it,training' && me.data.extra_dept_names.join() === '資訊部,訓練部', 'T2 我的資料唯讀顯示兼任');
  // admin 也可
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it'] }, tok).ok && staffOf(app, crew.emp).extra_depts === 'it', 'T2 正：admin 可設');
  // 不給＝保留；其他欄位修改不動它
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, phone: '0933444555' }, hrTok).ok && staffOf(app, crew.emp).extra_depts === 'it', 'T2 沒帶 extra_depts＝保留');
  // 只寫該格：同列 hire_date／last_day 不受影響
  app.sheets.staff._data.find((r) => r[0] === crew.emp)[24] = '2026-01-02';
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it', 'training'] }, hrTok);
  ok(app.sheets.staff._data.find((r) => r[0] === crew.emp)[24] === '2026-01-02', 'T2 只寫該格：hire_date 沒被洗掉');
  // 清空
  const rc = post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: [] }, hrTok);
  ok(rc.ok && staffOf(app, crew.emp).extra_depts === '' && rc.data.staff.extra_depts.length === 0, 'T2 正：給 [] 清空');
  // 特別代碼 ck
  const rk = post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['ck', 'training'] }, hrTok);
  ok(rk.ok && staffOf(app, crew.emp).extra_depts === 'training,ck' && rk.data.staff.extra_dept_names.join() === '訓練部,中央工廠', 'T2 正：特別代碼 ck＝兼任中央工廠（排最後）', rk);
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: [] }, hrTok);

  // 反：非人資
  const bad = post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it'] }, lead.token);
  ok(bad.ok === false && bad.error === '沒有權限修改兼任部門' && staffOf(app, crew.emp).extra_depts === '', 'T2 反：非人資帶 extra_depts → 沒有權限修改兼任部門', bad);
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it'] }, crew.token).error === '沒有權限修改兼任部門', 'T2 反：同仁自己也不能設');
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it'] }, '').ok === false, 'T2 反：沒登入被擋');
  // 反：各種不合法
  const e = (list, emp) => post(sb, 'staffEdit', { emp_no: emp || crew.emp, extra_depts: list }, hrTok);
  ok(e(['hr']).ok === false, 'T2 反：等於主要部門（人資部）被擋');
  ok(e(['it', 'it']).ok === false, 'T2 反：重複被擋');
  ok(e(['nope']).ok === false, 'T2 反：不存在代碼被擋');
  ok(e(['mala-gf']).ok === false, 'T2 反：不是部門的單位代碼被擋');
  ok(e('it').ok === false && e([1]).ok === false && e(['']).ok === false, 'T2 反：非陣列／非字串／空字串被擋');
  app.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'training')[7] = 'FALSE';
  ok(e(['training']).ok === false, 'T2 反：停用部門被擋');
  app.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'training')[7] = 'TRUE';
  ok(staffOf(app, crew.emp).extra_depts === '', 'T2 被擋的都沒寫進去');
  // 中央工廠主管不能再兼任 ck
  const ckp = mk(app, '測試庚', { brand: 'ck', unit: 'ck', title: 'sm' });
  ok(e(['ck'], ckp.emp).ok === false, 'T2 反：主要單位已是中央工廠不用兼任 ck');
  // 兼任不影響審核欄位（只看主要部門）：staff 的 dept 不變
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it'] }, hrTok);
  ok(staffOf(app, crew.emp).dept === 'hr', 'T2 兼任不動主要部門');

  // 主要部門變動 → 自動從兼任移除（後台改）
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it', 'training'] }, hrTok);
  const mv = post(sb, 'staffEdit', { emp_no: crew.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' }, hrTok);
  ok(mv.ok && staffOf(app, crew.emp).extra_depts === 'training' && mv.data.staff.extra_depts.join() === 'training', 'T2 後台改主要部門 → 新主要部門自動從兼任移除', mv);
  // 同一次改主要部門又帶新的兼任：用新主要部門驗
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, dept: 'fin', extra_depts: ['it'] }, hrTok).ok && staffOf(app, crew.emp).dept === 'fin' && staffOf(app, crew.emp).extra_depts === 'it', 'T2 同次改主要部門＋兼任：以新主要部門驗證');
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, dept: 'it', extra_depts: ['it'] }, hrTok).ok === false, 'T2 反：同次把主要部門改成兼任中的部門 → 擋');
  // 核准（staffConfirm）搬 p_dept → 自動移除
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it', 'training'] }, hrTok);
  const sp = post(sb, 'saveMyProfile', { brand: 'dzy', unit: 'dzy-hq', dept: 'training', title: 'hs', phone: '0933444555', address: '新竹市測試路二段2號' }, crew.token);
  ok(sp.ok, 'T2 （前置）同仁送出改部門', sp);
  ok(post(sb, 'staffConfirm', { emp_no: crew.emp }, hrTok).ok && staffOf(app, crew.emp).dept === 'training' && staffOf(app, crew.emp).extra_depts === 'it', 'T2 核准改部門 → 新主要部門自動從兼任移除');

  // 欄位不存在 → 自動補；表頭不符 → 停
  const a2 = fresh();
  const hc = a2.sheets.staff._data[0];
  const p2 = mk(a2, '測試辛', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  hc[26] = '';   // 模擬舊表：只有 hire_date、last_day
  ok(post(a2.sb, 'staffList', {}, a2.tok).data.staff.every((x) => Array.isArray(x.extra_depts) && x.extra_depts.length === 0), 'T2 欄位不存在：list 不炸、回 []');
  const r2 = post(a2.sb, 'staffEdit', { emp_no: p2.emp, extra_depts: ['it'] }, a2.hrTok);
  ok(r2.ok && hc[26] === 'extra_depts' && staffOf(a2, p2.emp).extra_depts === 'it', 'T2 欄位不存在：寫入時自動補表頭並寫入', r2);
  a2.sb.setupStaff();
  ok(hc[26] === 'extra_depts' && staffOf(a2, p2.emp).extra_depts === 'it', 'T2 setupStaff 重跑：欄位與值不變');
  const a3 = fresh();
  const p3 = mk(a3, '測試壬', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  a3.sheets.staff._data[0][26] = 'something_else';
  const r3 = post(a3.sb, 'staffEdit', { emp_no: p3.emp, extra_depts: ['it'] }, a3.hrTok);
  ok(r3.ok === false && a3.sheets.staff._data[0][26] === 'something_else' && String(staffOf(a3, p3.emp).something_else || '') === '', 'T2 表頭不符 → 停下回錯、不寫', r3);
  let threw = false;
  try { a3.sb.setupStaff(); } catch (err) { threw = true; }
  ok(threw, 'T2 表頭不符時 setupStaff 也丟錯停下');
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
