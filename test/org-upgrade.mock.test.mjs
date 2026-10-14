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

// ============================================================
// T3 審核規則（規格第 13 節最終表；權限邏輯＝每條規則一正一反）
// ============================================================
(() => {
  const app = fresh();
  const { sb, tok, hrTok } = app;
  const R = {};   // 審核者（全部已開通）
  const mkR = (key, name, over) => { R[key] = mk(app, name, over); R[key].key = key; return R[key]; };
  const STORE = (title) => ({ brand: 'mala', unit: 'mala-gf', title });
  mkR('smGF', '審核甲', STORE('sm'));
  mkR('smGF2', '審核甲二', STORE('sm'));
  mkR('smMzt', '審核乙', { brand: 'mzt', unit: 'mzt-gf', title: 'sm' });
  mkR('ckSm', '審核丙', { brand: 'ck', unit: 'ck', title: 'sm' });
  mkR('ckSm2', '審核丙二', { brand: 'ck', unit: 'ck', title: 'sm' });
  mkR('ckFt', '審核丙三', { brand: 'ck', unit: 'ck', title: 'ft' });
  mkR('oamMala', '審核丁', { brand: 'mala', unit: 'mala-hq', title: 'oam' });
  mkR('osvMala', '審核丁二', { brand: 'mala', unit: 'mala-hq', title: 'osv' });
  mkR('odirMala', '審核丁三', { brand: 'mala', unit: 'mala-hq', title: 'odir' });
  mkR('ofsMala', '審核丁四', { brand: 'mala', unit: 'mala-hq', title: 'ofs' });
  mkR('oamMzt', '審核戊', { brand: 'mzt', unit: 'mzt-hq', title: 'oam' });
  mkR('opsHm', '審核己', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hm' });
  mkR('itHm', '審核庚', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  mkR('finHm', '審核辛', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hm' });
  mkR('opsHs', '審核辛二', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' });
  mkR('ceo', '審核壬', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'ceo' });
  mkR('pt', '審核癸', STORE('pt'));
  const ALL = Object.keys(R);

  const pendingOf = (token) => { const r = post(sb, 'unitPending', {}, token); return r.ok ? r.data.people.map((x) => x.emp_no) : null; };
  const pend = {};   // key → 該審核者看得到的待審 emp 清單（null＝沒有審核資格）
  const refresh = () => { ALL.forEach((k) => { pend[k] = pendingOf(R[k].token); }); pend.HR = pendingOf(hrTok); pend.BOSS = pendingOf(tok); };
  const whoCan = (emp) => ['HR', 'BOSS'].concat(ALL).filter((k) => pend[k] && pend[k].indexOf(emp) !== -1).sort().join(',');
  const exp = (...keys) => ['HR', 'BOSS'].concat(keys).sort().join(',');

  // ── 待審的人（只送出，不確認）──
  const P = {};
  const sub = (key, name, over) => { P[key] = submitOnly(app, name, over); return P[key]; };
  sub('storePt', '待審甲', STORE('pt'));
  sub('storeFt', '待審甲二', STORE('ft'));
  sub('storeSm', '待審乙', STORE('sm'));
  sub('mztSm', '待審乙二', { brand: 'mzt', unit: 'mzt-gf', title: 'sm' });
  sub('ckPt', '待審丙', { brand: 'ck', unit: 'ck', title: 'pt' });
  sub('ckSm', '待審丙二', { brand: 'ck', unit: 'ck', title: 'sm' });
  sub('offOfs', '待審丁', { brand: 'mala', unit: 'mala-hq', title: 'ofs' });
  sub('offOdir', '待審丁二', { brand: 'mala', unit: 'mala-hq', title: 'odir' });
  sub('mztOff', '待審丁三', { brand: 'mzt', unit: 'mzt-hq', title: 'osv' });
  sub('deptHs', '待審戊', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' });
  sub('deptHm', '待審戊二', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  sub('opsHsP', '待審戊三', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' });
  sub('ceoP', '待審己', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'ceo' });
  refresh();

  // 資格：誰有「待審核」資格
  const hasScope = (k) => pend[k] !== null;
  ok(['smGF', 'smGF2', 'smMzt', 'ckSm', 'ckSm2', 'oamMala', 'osvMala', 'odirMala', 'oamMzt', 'opsHm', 'itHm', 'finHm', 'ceo'].every(hasScope), 'T3 審核資格：店長、ck 店長、辦公室區經理以上、營運部主管、部門主管、執行長以上都有');
  ok(['ckFt', 'ofsMala', 'opsHs', 'pt'].every((k) => !hasScope(k)), 'T3 審核資格：計時／正職、行政同仁、部門同仁沒有');

  // 門市計時／正職 → 同店店長
  ok(whoCan(P.storePt.emp) === exp('smGF', 'smGF2'), 'T3 門市計時：正＝同店店長（兩位）；反＝他店店長、ck 店長、辦公室全部、營運部主管、部門主管、執行長都看不到', whoCan(P.storePt.emp));
  ok(whoCan(P.storeFt.emp) === exp('smGF', 'smGF2'), 'T3 門市正職：同上');
  // 門市店長 → 該品牌辦公室區經理以上
  ok(whoCan(P.storeSm.emp) === exp('oamMala', 'osvMala', 'odirMala'), 'T3 門市店長：正＝該品牌辦公室 oam／osv／odir；反＝同店另一位店長、他品牌辦公室、ck、營運部主管、執行長', whoCan(P.storeSm.emp));
  ok(whoCan(P.mztSm.emp) === exp('oamMzt'), 'T3 墨竹亭店長：只有墨竹亭品牌辦公室（不是小辛辣的）', whoCan(P.mztSm.emp));
  // 中央工廠
  ok(whoCan(P.ckPt.emp) === exp('ckSm', 'ckSm2'), 'T3 中央工廠計時：正＝ck 店長；反＝品牌辦公室（不能審 ck）、營運部主管、執行長、門市店長', whoCan(P.ckPt.emp));
  ok(whoCan(P.ckSm.emp) === exp('ceo'), 'T3 中央工廠店長：正＝執行長以上；反＝另一位 ck 店長、品牌辦公室、營運部主管', whoCan(P.ckSm.emp));
  // 品牌辦公室任何人 → 營運部主管
  ok(whoCan(P.offOfs.emp) === exp('opsHm') && whoCan(P.offOdir.emp) === exp('opsHm') && whoCan(P.mztOff.emp) === exp('opsHm'), 'T3 品牌辦公室任何人：正＝營運部主管；反＝區經理／區督導／總監（同辦公室）、執行長、他部門主管', [whoCan(P.offOfs.emp), whoCan(P.offOdir.emp)]);
  // 總部部門
  ok(whoCan(P.deptHs.emp) === exp('itHm'), 'T3 部門同仁：正＝同主要部門的部門主管；反＝財務部主管、營運部主管、執行長', whoCan(P.deptHs.emp));
  ok(whoCan(P.opsHsP.emp) === exp('opsHm'), 'T3 營運部同仁：營運部主管（同部門）可審', whoCan(P.opsHsP.emp));
  ok(whoCan(P.deptHm.emp) === exp('ceo'), 'T3 部門主管：正＝執行長以上；反＝同部門另一位／他部門／營運部主管', whoCan(P.deptHm.emp));
  ok(whoCan(P.ceoP.emp) === exp(), 'T3 執行長以上：只有人資（和 BOSS）；另一位執行長也不行', whoCan(P.ceoP.emp));
  ok(pend.HR.length === 13 && pend.BOSS.length === 13, 'T3 人資、BOSS 全可審（13 筆全看得到）', [pend.HR.length, pend.BOSS.length]);

  // 反例走實際 action：明確點名的幾個
  const appr = (k, p) => post(sb, 'unitApprove', { emp_no: p.emp }, R[k].token);
  ok(appr('opsHm', P.storePt).error === '只有單位主管可以審核', 'T3 反：營運部主管不能審門市同仁（unitApprove）');
  ok(appr('ceo', P.storePt).ok === false && appr('ceo', P.storeSm).ok === false, 'T3 反：執行長不能審門市同仁／店長');
  ok(appr('itHm', P.opsHsP).ok === false, 'T3 反：部門主管不能審別部門');
  ok(appr('oamMala', P.ckPt).ok === false && appr('odirMala', P.ckSm).ok === false, 'T3 反：品牌辦公室不能審 ck');
  ok(appr('oamMala', P.storePt).ok === false, 'T3 反：品牌辦公室不能越級審門市計時（只有正上一層）');
  ok(appr('smMzt', P.storePt).ok === false, 'T3 反：他店店長不能審');
  ok(appr('smGF', P.storeSm).ok === false, 'T3 反：同店店長不能審店長');
  ok(post(sb, 'unitReject', { emp_no: P.storePt.emp, reason: '測試' }, R.opsHm.token).ok === false, 'T3 反：不夠格的人退回也擋（unitReject）');
  ok(post(sb, 'unitApprove', { emp_no: P.storePt.emp }, R.pt.token).ok === false, 'T3 反：計時同仁呼叫審核被擋');
  ok(staffOf(app, P.storePt.emp).status === 'pending', 'T3 被擋的都沒有改到資料');
  // 正例走實際 action
  ok(appr('smGF', P.storePt).ok && staffOf(app, P.storePt.emp).status === 'active', 'T3 正：同店店長核准門市計時');
  ok(post(sb, 'unitReject', { emp_no: P.storeFt.emp, reason: '資料不符' }, R.smGF2.token).ok && staffOf(app, P.storeFt.emp).status === 'unclaimed', 'T3 正：同店店長退回門市正職');
  ok(appr('oamMala', P.storeSm).ok && staffOf(app, P.storeSm.emp).status === 'active', 'T3 正：品牌辦公室區經理核准店長');
  ok(appr('ckSm', P.ckPt).ok, 'T3 正：ck 店長核准 ck 計時');
  ok(appr('ceo', P.ckSm).ok && appr('ceo', P.deptHm).ok, 'T3 正：執行長核准 ck 店長與部門主管');
  ok(appr('opsHm', P.offOfs).ok && appr('opsHm', P.offOdir).ok, 'T3 正：營運部主管核准品牌辦公室同仁／總監');
  ok(appr('itHm', P.deptHs).ok, 'T3 正：資訊部主管核准資訊部同仁');
  ok(post(sb, 'unitApprove', { emp_no: P.ceoP.emp }, hrTok).ok, 'T3 正：人資核准執行長');
  ok(post(sb, 'unitApprove', { emp_no: P.opsHsP.emp }, tok).ok, 'T3 正：admin 核准');

  // 衍生權限 platform.review 與新資格一致
  const permsOf = (t) => post(sb, 'me', {}, t).data.perms;
  const reviewFlag = (k) => permsOf(R[k].token).indexOf('platform.review') !== -1;
  ok(ALL.every((k) => reviewFlag(k) === hasScope(k)), 'T3 platform.review 衍生權限＝審核者資格（17 人逐一比對）', ALL.filter((k) => reviewFlag(k) !== hasScope(k)));
  ok(permsOf(hrTok).indexOf('platform.review') !== -1 && permsOf(tok).indexOf('*') !== -1, 'T3 人資有 platform.review、admin 為 *（待審核分頁前後端一致）');
  const loginAgain = login(app, R.smGF.emp, R.smGF.pw);
  ok(loginAgain.ok && loginAgain.data.perms.indexOf('platform.review') !== -1, 'T3 登入回傳的 perms 也帶 platform.review');
  ok(login(app, R.pt.emp, R.pt.pw).data.perms.indexOf('platform.review') === -1, 'T3 計時同仁登入沒有 platform.review');

  // 審核者本身必須合規（#3）
  const stfRow = (emp) => sb.stfFindByEmp_(emp).values;
  const org0 = () => sb.stfReadOrg_();
  ok(sb.stfReviewScope_(stfRow(R.smGF.emp), org0()).kinds.join() === 'store' && sb.stfReviewScope_(stfRow(R.ckSm.emp), org0()).kinds.join() === 'ck' &&
    sb.stfReviewScope_(stfRow(R.oamMala.emp), org0()).kinds.join() === 'brand' && sb.stfReviewScope_(stfRow(R.opsHm.emp), org0()).kinds.join() === 'dept,ops' &&
    sb.stfReviewScope_(stfRow(R.itHm.emp), org0()).kinds.join() === 'dept' && sb.stfReviewScope_(stfRow(R.ceo.emp), org0()).kinds.join() === 'exec', 'T3 stfReviewScope_ 回的 kinds 代號（store／ck／brand／dept+ops／dept／exec）');
  ok(sb.stfReviewScope_(stfRow(R.oamMala.emp), org0()).brand === 'mala' && sb.stfReviewScope_(stfRow(R.itHm.emp), org0()).dept === 'it', 'T3 brand 種類帶 brand、dept 種類帶 dept');
  const fresh2 = (mut, key) => {   // 暫時改資料後看資格，再還原
    const r = mut();
    const res = sb.stfReviewScope_(stfRow(R[key].emp), org0());
    r();
    return res;
  };
  const orgCell = (kind, code, idx, val) => { const row = app.sheets.org._data.find((x) => x[0] === kind && x[1] === code); const old = row[idx]; row[idx] = val; return () => { row[idx] = old; }; };
  ok(fresh2(() => orgCell('unit', 'mala-gf', 7, 'FALSE'), 'smGF') === null, 'T3 反：審核者的單位停用 → 沒有資格');
  ok(fresh2(() => orgCell('title', 'sm', 7, 'FALSE'), 'smGF') === null, 'T3 反：審核者的職稱停用 → 沒有資格');
  ok(fresh2(() => { const d = app.sheets.staff._data.find((x) => x[0] === R.smGF.emp); const o = d[7]; d[7] = 'hm'; return () => { d[7] = o; }; }, 'smGF') === null, 'T3 反：審核者職稱不屬於該單位階梯（店裡掛 hm）→ 沒有資格');
  ok(fresh2(() => { const d = app.sheets.staff._data.find((x) => x[0] === R.smGF.emp); const o = d[3]; d[3] = 'disabled'; return () => { d[3] = o; }; }, 'smGF') === null, 'T3 反：審核者不是 active → 沒有資格');
  ok(fresh2(() => orgCell('unit', 'mala-hq', 4, 'weird'), 'oamMala') === null, 'T3 反：未知 ladder → 沒有資格');
  ok(fresh2(() => { const d = app.sheets.staff._data.find((x) => x[0] === R.itHm.emp); const o = d[6]; d[6] = ''; return () => { d[6] = o; }; }, 'itHm') === null, 'T3 反：總部部門主管部門空白 → 沒有資格');
  ok(fresh2(() => orgCell('dept', 'ops', 7, 'FALSE'), 'opsHm') === null, 'T3 反：營運部停用 → 營運部主管資格也沒有');

  // 不能審自己（含人資）
  const own = sb.stfFindByEmp_(R.smGF.emp).values.slice();
  own[sb.STF_COL.status] = 'pending'; own[sb.STF_COL.p_unit] = 'mala-gf'; own[sb.STF_COL.p_title] = 'pt'; own[sb.STF_COL.p_brand] = 'mala';
  ok(sb.stfCanReviewRow_({ user: { id: own[sb.STF_COL.user_id] }, isHr: true, scope: null, org: org0() }, own) === false, 'T3 反：不能審自己（人資也不行）');
  ok(sb.stfCanReviewRow_({ user: { id: 'u999' }, isHr: true, scope: null, org: org0() }, own) === true, 'T3 正：換個人資就可以');

  // 取嚴者（#1）：已有目前身分的待審，審核者要同時夠格審「目前」與「送出」
  const both = submitOnly(app, '待審庚', STORE('pt'));                 // 送出：mala-gf pt
  setStaff(app, both.emp, 'unit', 'mzt-gf'); setStaff(app, both.emp, 'title', 'pt'); setStaff(app, both.emp, 'brand', 'mzt');   // 目前：mzt-gf pt
  refresh();
  ok(whoCan(both.emp) === exp(), 'T3 取嚴者：目前（墨竹亭光復）與送出（小辛辣光復）兩家店長都只夠格一邊 → 只有人資', whoCan(both.emp));
  setStaff(app, both.emp, 'unit', 'mala-gf'); setStaff(app, both.emp, 'brand', 'mala');
  refresh();
  ok(whoCan(both.emp) === exp('smGF', 'smGF2'), 'T3 取嚴者：目前與送出都在小辛辣光復 → 同店店長可審', whoCan(both.emp));
  setStaff(app, both.emp, 'title', 'sm');   // 目前身分是店長、送出是計時
  refresh();
  ok(whoCan(both.emp) === exp(), 'T3 取嚴者：目前身分是店長（要品牌辦公室審）、送出是計時（要店長審）→ 取嚴者後無人夠格，只有人資', whoCan(both.emp));
  setStaff(app, both.emp, 'title', 'am');   // 目前身分職稱已停用
  refresh();
  ok(whoCan(both.emp) === exp(), 'T3 目前身分資料已不合規（停用職稱）→ 只有人資', whoCan(both.emp));

  // 送出的資料不合規：停用職稱在認領就被擋，進不了待審
  const badClaim = (() => { post(sb, 'staffImport', { names: ['待審辛'] }, tok); const lk = post(sb, 'claimLookup', { name: '待審辛' }); return post(sb, 'claimSubmit', Object.assign({ name: '待審辛', emp_no: lk.data.emp_no, password: 'fake-staff-pw-9999' }, PROF(STORE('am')))); })();
  ok(badClaim.ok === false, 'T3 反：送出停用職稱（區經理）→ 認領驗證就擋', badClaim);
  // 送出的單位後來被停用 → 只有人資
  const stopped = submitOnly(app, '待審壬', STORE('pt'));
  const undo = orgCell('unit', 'mala-gf', 7, 'FALSE');
  refresh();
  ok(whoCan(stopped.emp) === exp(), 'T3 反：送出的單位已停用 → 店長（單位也停用）看不到，只有人資', whoCan(stopped.emp));
  undo();

  // 職級比較只在同階梯（單元）
  const m = (kinds, rank, tl, extra) => Object.assign({ kinds, unit: 'x', brand: 'b', dept: 'd', rank, titleLadder: tl }, extra || {});
  const nd = (kind, rank, parent, extra) => Object.assign({ kind, title: { rank, parent }, unit: 'x', brand: 'b', dept: 'd' }, extra || {});
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 3, 'store')) === true, 'T3 同階梯同級可以審');
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 4, 'store')) === false, 'T3 反：同階梯、被審的職級比審核者高 → 擋');
  ok(sb.stfScopeMeets_(m(['brand'], 2, 'office'), nd('brand', 3, 'store')) === true, 'T3 正：不同階梯不比職級（辦公室 rank2 審門市 rank3 店長）');
  ok(sb.stfScopeMeets_(m(['dept'], 2, 'hq'), nd('dept', 1, 'hq')) === true && sb.stfScopeMeets_(m(['dept'], 1, 'hq'), nd('dept', 2, 'hq')) === false, 'T3 部門階梯：高審低可、低審高擋');
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
