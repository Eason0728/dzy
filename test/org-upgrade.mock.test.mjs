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
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件（同 staff.mock.test.mjs）──────────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const fmt = {};
  let maxCols = Math.max(26, data.reduce((m, r) => Math.max(m, r.length), 0));   // 真 Google 新分頁預設 26 欄；越界讀寫會丟錯
  const sheet = {
    getMaxColumns: () => maxCols,
    insertColumnsAfter(after, n) { maxCols += n; },
    _setMaxCols(n) { maxCols = n; data.forEach((r) => { if (r.length > n) r.length = n; }); },
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      if (col < 1 || col + numCols - 1 > maxCols) throw new Error('The coordinates or dimensions of the range are invalid.');
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
    insertSheet: (n) => { if (sheets[n]) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.'); sheets[n] = makeSheet([]); return sheets[n]; }
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

/**
 * 預設：2026-10-16 切換後、2026-10-20 職稱調整「之前」的 org（am 停用、oam 啟用、沒有 fm／rdd）——
 * 這個檔大部分在驗第 10–14 節（orgUpgrade2026 那一代）的規則；第 15 節另用 freshNew()（setupStaff 的新預設）與 2610 段。
 */
function to1016(app) {
  const od = app.sheets.org._data;
  for (let i = od.length - 1; i >= 1; i--) if (od[i][0] === 'title' && (od[i][1] === 'fm' || od[i][1] === 'rdd')) od.splice(i, 1);
  od.forEach((r) => { if (r[0] === 'title' && r[1] === 'am') r[7] = 'FALSE'; if (r[0] === 'title' && r[1] === 'oam') r[7] = 'TRUE'; });
}
function fresh() {
  const app = freshNew();
  to1016(app);
  return app;
}
function freshNew() {
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
  // setupStaff 的預設值（2026-10-20 第 15 節之後）
  const sb0 = freshNew().sb;
  const n = sb0.stfReadOrg_();
  ok(['pt', 'ft', 'sm', 'am'].every((c) => n.title[c].parent === 'store' && n.title[c].active) && ['sv', 'bd'].every((c) => n.title[c] && n.title[c].active === false), 'T1/15 預設：門市 pt／ft／sm／am（區經理移回門市、rank 4）；sv／bd 停用不刪');
  ok(n.title.am.rank === 4 && n.title.fm && n.title.fm.parent === 'store' && n.title.fm.rank === 3 && n.title.fm.name === '廠長' && n.title.rdd && n.title.rdd.rank === 4 && n.title.rdd.name === '廚藝總監', 'T1/15 預設：廠長 fm rank 3、廚藝總監 rdd rank 4（store 階梯）');
  ok(n.title.oam.active === false && [['ofs', 1], ['osv', 2], ['odir', 3]].every(([c, r]) => n.title[c].parent === 'office' && n.title[c].rank === r && n.title[c].active), 'T1/15 預設：品牌辦公室區經理 oam 停用，ofs／osv／odir 照舊');
  const vn = (u, t) => n.unit[u] && sb0.stfValidateOrg_(n, { brand: n.unit[u].parent, unit: u, dept: '', title: t });
  ok(['pt', 'ft', 'fm', 'rdd'].every((t) => vn('ck', t) === null) && ['sm', 'am'].every((t) => vn('ck', t) !== null), 'T1/15 預設：中央工廠可選 pt／ft／fm／rdd，不能選店長、區經理');
  ok(['pt', 'ft', 'sm', 'am'].every((t) => vn('mala-gf', t) === null) && ['fm', 'rdd'].every((t) => vn('mala-gf', t) !== null && vn('yiwu-js', t) !== null), 'T1/15 預設：門市可選 pt／ft／sm／am，不能選廠長、廚藝總監');
  ok(vn('mala-hq', 'oam') !== null, 'T1/15 預設：品牌辦公室不能再選 oam');

  // 以下沿用 2026-10-16 那一代的 org（to1016）
  const app = fresh();
  const { sb } = app;
  const org = sb.stfReadOrg_();
  ok(org.brand.ck.name === '中央工廠' && org.unit.ck.name === '中央工廠（央廚）' && org.unit.ck.ladder === 'store', 'T1 ck 品牌與單位改名（單位代碼 ck 不變、仍 store）');
  ok(org.unit['mzt-hq'].name === '墨竹亭品牌辦公室' && org.unit['mzt-hq'].ladder === 'office' && org.unit['mala-hq'].name === '小辛辣品牌辦公室' && org.unit['mala-hq'].ladder === 'office', 'T1 mzt-hq／mala-hq 改名＋ladder＝office（代碼不變）');
  ok(org.unit['yiwu-hq'] && org.unit['yiwu-hq'].parent === 'yiwu' && org.unit['yiwu-hq'].ladder === 'office' && org.unit['yiwu-hq'].active, 'T1 新增 yiwu-hq 一悟燒肉品牌辦公室');
  ok(['mzt-wx', 'mzt-rg', 'mzt-mc'].every((c) => org.unit[c] && org.unit[c].active === false), 'T1 mzt-wx／rg／mc 預設停用');
  ok(org.dept.training && org.dept.training.name === '訓練部' && org.dept.training.parent === 'dzy-hq', 'T1 訓練部保留');
  ok(['pt', 'ft', 'sm'].every((c) => org.title[c].parent === 'store' && org.title[c].active) && ['am', 'sv', 'bd'].every((c) => org.title[c] && org.title[c].active === false), 'T1 門市只剩 pt／ft／sm；am／sv／bd 停用不刪');
  ok([['ofs', 1], ['oam', 2], ['osv', 2], ['odir', 3]].every(([c, r]) => org.title[c] && org.title[c].parent === 'office' && org.title[c].rank === r && org.title[c].active) && org.title.ofs.name === '行政同仁' && org.title.odir.name === '總監', 'T1 品牌辦公室 ofs／oam／osv／odir 四級（職級 1／2／2／3，2026-10-17 修正）');
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
  const mv = post(sb, 'staffEdit', { emp_no: crew.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' }, tok);
  ok(mv.ok && staffOf(app, crew.emp).extra_depts === 'training' && mv.data.staff.extra_depts.join() === 'training', 'T2 後台改主要部門 → 新主要部門自動從兼任移除', mv);
  // 同一次改主要部門又帶新的兼任：用新主要部門驗
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, dept: 'fin', extra_depts: ['it'] }, tok).ok && staffOf(app, crew.emp).dept === 'fin' && staffOf(app, crew.emp).extra_depts === 'it', 'T2 同次改主要部門＋兼任：以新主要部門驗證');
  ok(post(sb, 'staffEdit', { emp_no: crew.emp, dept: 'it', extra_depts: ['it'] }, hrTok).ok === false, 'T2 反：同次把主要部門改成兼任中的部門 → 擋');
  // 核准（staffConfirm）搬 p_dept → 自動移除
  post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['it', 'training'] }, hrTok);
  const sp = post(sb, 'saveMyProfile', { brand: 'dzy', unit: 'dzy-hq', dept: 'training', title: 'hs', phone: '0933444555', address: '新竹市測試路二段2號' }, crew.token);
  ok(sp.ok, 'T2 （前置）同仁送出改部門', sp);
  ok(post(sb, 'staffConfirm', { emp_no: crew.emp }, tok).ok && staffOf(app, crew.emp).dept === 'training' && staffOf(app, crew.emp).extra_depts === 'it', 'T2 核准改部門 → 新主要部門自動從兼任移除');

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
  ok(post(sb, 'unitApprove', { emp_no: P.ceoP.emp }, hrTok).code === 'perm_admin_only', 'T3 人資核准人資部執行長 → 改變 platform.staff，鎖碼擴大後只有 admin（2026-10-17）');
  ok(post(sb, 'unitApprove', { emp_no: P.ceoP.emp }, tok).ok, 'T3 正：admin 核准人資部執行長');
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
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 3, 'store')) === false, 'T3 反（第二期 13：職稱＝權限）：同階梯同級不能審（< 改 <=）');
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 2, 'store')) === true, 'T3 正：同階梯高審低可以審');
  ok(sb.stfScopeMeets_(m(['dept'], 2, 'hq'), nd('dept', 2, 'hq')) === false && sb.stfScopeMeets_(m(['ops'], 2, 'hq'), nd('ops', 2, 'hq')) === false, 'T3 反：部門階梯同級也擋');
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 4, 'store')) === false, 'T3 反：同階梯、被審的職級比審核者高 → 擋');
  ok(sb.stfScopeMeets_(m(['brand'], 2, 'office'), nd('brand', 3, 'store')) === true, 'T3 正：不同階梯不比職級（辦公室 rank2 審門市 rank3 店長）');
  ok(sb.stfScopeMeets_(m(['dept'], 2, 'hq'), nd('dept', 1, 'hq')) === true && sb.stfScopeMeets_(m(['dept'], 1, 'hq'), nd('dept', 2, 'hq')) === false, 'T3 部門階梯：高審低可、低審高擋');
})();

// ============================================================
// T4 升級／回退（orgUpgrade2026／orgRollback2026，只有 role admin）
// ============================================================
// 升級前（2026-10-14 之前）正式表的 org 預設值
const LEGACY_ORG = [
  ['brand', 'mzt', '墨竹亭', '', '', '', 1, 'TRUE'],
  ['brand', 'mala', '麻的小辛辣', '', '', '', 2, 'TRUE'],
  ['brand', 'yiwu', '一悟燒肉', '', '', '', 3, 'TRUE'],
  ['brand', 'ck', '央廚', '', '', '', 4, 'TRUE'],
  ['brand', 'dzy', '鼎兆元總部', '', '', '', 5, 'TRUE'],
  ['unit', 'mzt-js', '新竹金山', 'mzt', 'store', '', 1, 'TRUE'],
  ['unit', 'mzt-gf', '新竹光復', 'mzt', 'store', '', 2, 'TRUE'],
  ['unit', 'mzt-lzl', '台北六張犁', 'mzt', 'store', '', 3, 'TRUE'],
  ['unit', 'mzt-wx', '台中文心', 'mzt', 'store', '', 4, 'TRUE'],
  ['unit', 'mzt-rg', '內湖瑞光', 'mzt', 'store', '', 5, 'TRUE'],
  ['unit', 'mzt-mc', '台中美村', 'mzt', 'store', '', 6, 'TRUE'],
  ['unit', 'mzt-hq', '墨竹亭總部', 'mzt', 'hq', '', 7, 'TRUE'],
  ['unit', 'mala-gf', '新竹光復', 'mala', 'store', '', 1, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣總部', 'mala', 'hq', '', 2, 'TRUE'],
  ['unit', 'yiwu-js', '新竹金山', 'yiwu', 'store', '', 1, 'TRUE'],
  ['unit', 'yiwu-wx', '竹北文興', 'yiwu', 'store', '', 2, 'TRUE'],
  ['unit', 'ck', '央廚', 'ck', 'store', '', 1, 'TRUE'],
  ['unit', 'dzy-hq', '鼎兆元總部', 'dzy', 'hq', '', 1, 'TRUE'],
  ['title', 'pt', '計時同仁', 'store', '', 1, 1, 'TRUE'],
  ['title', 'ft', '正職同仁', 'store', '', 2, 2, 'TRUE'],
  ['title', 'sm', '店長', 'store', '', 3, 3, 'TRUE'],
  ['title', 'am', '區經理', 'store', '', 4, 4, 'TRUE'],
  ['title', 'sv', '督導', 'store', '', 5, 5, 'TRUE'],
  ['title', 'bd', '品牌總監', 'store', '', 6, 6, 'TRUE'],
  ['title', 'hs', '部門同仁', 'hq', '', 1, 1, 'TRUE'],
  ['title', 'hm', '部門主管', 'hq', '', 2, 2, 'TRUE'],
  ['title', 'ceo', '執行長', 'hq', '', 3, 3, 'TRUE'],
  ['title', 'gm', '總經理', 'hq', '', 4, 4, 'TRUE'],
  ['title', 'chair', '董事長', 'hq', '', 5, 5, 'TRUE'],
  // 部門只掛在鼎兆元總部（Eason 2026-10-11）；墨竹亭總部、小辛辣總部沒有部門，同仁不必選
  ['dept', 'fin', '財務部', 'dzy-hq', '', '', 1, 'TRUE'],
  ['dept', 'hr', '人資部', 'dzy-hq', '', '', 2, 'TRUE'],
  ['dept', 'it', '資訊部', 'dzy-hq', '', '', 3, 'TRUE'],
  ['dept', 'eng', '工程部', 'dzy-hq', '', '', 4, 'TRUE'],
  ['dept', 'franchise', '加盟招商部', 'dzy-hq', '', '', 5, 'TRUE'],
  ['dept', 'purchase', '採購部', 'dzy-hq', '', '', 6, 'TRUE'],
  ['dept', 'ops', '營運部', 'dzy-hq', '', '', 7, 'TRUE'],
  ['dept', 'training', '訓練部', 'dzy-hq', '', '', 8, 'TRUE'],
  ['dept', 'marketing', '行銷部', 'dzy-hq', '', '', 9, 'TRUE']
];

const nonBlank = (rows) => rows.filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => r.slice(0, 8).map((c) => String(c).trim().toUpperCase() === 'TRUE' || String(c).trim().toUpperCase() === 'FALSE' ? String(c).trim().toUpperCase() : String(c).trim()));
const orgSnap = (app) => nonBlank(app.sheets.org._rows().slice(1));
const clkHq = (app) => app.sheets.clock_stores._data.find((r) => String(r[0]).toLowerCase() === 'hq');

/** 還原成升級前的樣子：舊 org、舊 clock hq 列、staff 尾端只有 hire_date／last_day，再建一批同仁 */
function legacyApp(clockValue) {
  const app = fresh();
  const od = app.sheets.org._data;
  od.length = 1;
  LEGACY_ORG.forEach((r) => od.push(r.slice()));
  clkHq(app)[2] = clockValue === undefined ? 'dzy-hq,mzt-hq,mala-hq' : clockValue;
  app.sheets.staff._data[0][26] = '';
  const P = {};
  P.offHs = mk(app, '升甲', { brand: 'mzt', unit: 'mzt-hq', title: 'hs' });
  P.offHm = mk(app, '升乙', { brand: 'mala', unit: 'mala-hq', title: 'hm' });
  P.offCeo = mk(app, '升丙', { brand: 'mala', unit: 'mala-hq', title: 'ceo' });
  P.storeAm = mk(app, '升丁', { brand: 'mala', unit: 'mala-gf', title: 'am' });
  P.storeSv = mk(app, '升戊', { brand: 'mzt', unit: 'mzt-js', title: 'sv' });
  P.storeBd = mk(app, '升己', { brand: 'mzt', unit: 'mzt-gf', title: 'bd' });
  P.stopped = mk(app, '升庚', { brand: 'mzt', unit: 'mzt-mc', title: 'pt' });
  P.normal = mk(app, '升辛', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  P.ckPt = mk(app, '升壬', { brand: 'ck', unit: 'ck', title: 'pt' });
  P.hqIt = mk(app, '升癸', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' });
  app.P = P;
  app.legacySnap = orgSnap(app);
  app.legacyClock = app.sheets.clock_stores._rows().map((r) => r.slice());
  return app;
}
const upg = (app, payload, t) => post(app.sb, 'orgUpgrade2026', payload || {}, t === undefined ? app.tok : t);
const rbk = (app, t) => post(app.sb, 'orgRollback2026', {}, t === undefined ? app.tok : t);
const bakNames = (app) => Object.keys(app.sheets).filter((k) => /^(org_bak|clk_bak|stf_bak|org_upg)_/.test(k)).sort();

(() => {
  const app = legacyApp();
  const { sb, tok, hrTok, P } = app;
  const sheetCount0 = Object.keys(app.sheets).length;
  ok(app.legacySnap.length === LEGACY_ORG.length && app.sheets.staff._data[0][26] === '', 'T4 （前置）舊 org、舊 staff 欄位');

  // ── 權限：只有 role admin ──
  ok(upg(app, { dryrun: true }, hrTok).ok === false && upg(app, { dryrun: true }, hrTok).error === '沒有權限', 'T4 反：人資（platform.staff）呼叫 orgUpgrade2026 被擋（含預覽）');
  ok(upg(app, {}, P.normal.token).ok === false && upg(app, {}, '').ok === false, 'T4 反：店長／沒登入被擋');
  ok(rbk(app, hrTok).ok === false && rbk(app, hrTok).error === '沒有權限' && rbk(app, P.normal.token).ok === false, 'T4 反：人資呼叫 orgRollback2026 被擋');
  const src = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  ok(/CODE_ALLOWED_ACTIONS = \[[\s\S]*?'orgUpgrade2026'[\s\S]*?'orgRollback2026'[\s\S]*?\];/.test(src) && /orgUpgrade2026: 1/.test(src) && /orgRollback2026: 1/.test(src), 'T4 兩個 action 在白名單、且上寫入鎖');
  ok(post(sb, 'orgUpgrade2026', {}, '').error !== '不支援的操作', 'T4 action 可分派（沒登入不是 unknown action）');
  ok(sb.stfOrgSnapshot_ && orgSnap(app).join() === app.legacySnap.join(), 'T4 被擋的都沒動到 org');

  // ── 預覽（dryrun）──
  const dr = upg(app, { dryrun: true });
  ok(dr.ok && dr.data.dryrun === true, 'T4 預覽成功', dr);
  const orgHas = (r, code, field, from, to) => r.data.org.some((x) => x.code === code && x.field === field && x.from === from && x.to === to);
  ok(orgHas(dr, 'mzt-hq', 'ladder', 'hq', 'office') && orgHas(dr, 'mala-hq', 'ladder', 'hq', 'office') && orgHas(dr, 'mzt-hq', 'name', '墨竹亭總部', '墨竹亭品牌辦公室') && orgHas(dr, 'ck', 'name', '央廚', '中央工廠（央廚）'), 'T4 預覽：改名與 ladder 變更逐格列出（code,kind,field,from,to）', dr.data.org);
  ok(['mzt-wx', 'mzt-rg', 'mzt-mc'].every((c) => orgHas(dr, c, 'active', 'TRUE', 'FALSE')) && ['am', 'sv', 'bd'].every((c) => orgHas(dr, c, 'active', 'TRUE', 'FALSE')), 'T4 預覽：三店與 am／sv／bd 停用');
  ok(['yiwu-hq', 'ofs', 'oam', 'osv', 'odir'].every((c) => dr.data.org.some((x) => x.code === c && x.field === 'row' && x.to === 'added')), 'T4 預覽：新增 yiwu-hq 與四個辦公室職稱');
  ok(dr.data.backup === 'created' && dr.data.clock === 'updated' && dr.data.staffColumn === 'added', 'T4 預覽：backup／clock／staffColumn 狀態', [dr.data.backup, dr.data.clock, dr.data.staffColumn]);
  ok(dr.data.titles.length === 2 && dr.data.titles.some((t) => t.emp_no === P.offHs.emp && t.from === 'hs' && t.to === 'ofs' && t.name === '升甲') && dr.data.titles.some((t) => t.emp_no === P.offHm.emp && t.from === 'hm' && t.to === 'osv'), 'T4 預覽：品牌辦公室 hs→ofs、hm→osv 逐人列出（emp_no,name,from,to）', dr.data.titles);
  const todoOf = (r, emp) => r.data.todo.filter((x) => x.emp_no === emp).map((x) => x.flag).join();
  ok(todoOf(dr, P.offCeo.emp) === 'title_ladder,exec_misplaced' && todoOf(dr, P.storeAm.emp) === 'title_ladder' && todoOf(dr, P.storeSv.emp) === 'title_ladder' && todoOf(dr, P.storeBd.emp) === 'title_ladder' && todoOf(dr, P.stopped.emp) === 'unit_inactive', 'T4 todo：品牌辦公室 ceo＝title_ladder＋exec_misplaced、am／sv／bd＝title_ladder、停用門市同仁＝unit_inactive');
  ok(todoOf(dr, P.normal.emp) === '' && todoOf(dr, P.ckPt.emp) === '' && todoOf(dr, P.hqIt.emp) === '' && todoOf(dr, P.offHs.emp) === '' && todoOf(dr, P.offHm.emp) === '', 'T4 todo：正常的人、會被自動對應的人不列');
  ok(dr.data.todo.every((x) => ['unit_inactive', 'title_ladder', 'exec_misplaced'].indexOf(x.flag) !== -1 && x.name && x.unit_name !== undefined), 'T4 todo 只有 unit_inactive／title_ladder／exec_misplaced 三種 flag，帶 name／unit_name');
  ok(orgSnap(app).join() === app.legacySnap.join() && Object.keys(app.sheets).length === sheetCount0 && app.sheets.staff._data[0][26] === '' && clkHq(app)[2] === 'dzy-hq,mzt-hq,mala-hq' && staffOf(app, P.offHs.emp).title === 'hs' && !app.props.ORG_UPGRADE_STATE, 'T4 預覽不寫任何東西（org／分頁／欄位／clock／職稱／狀態都沒動）');

  // ── 正式升級 ──
  const r1 = upg(app, { dryrun: false });
  ok(r1.ok && r1.data.backup === 'created' && r1.data.clock === 'updated' && r1.data.staffColumn === 'added' && r1.data.org.length === dr.data.org.length, '正式升級成功、報告與預覽一致'.replace(/^/, 'T4 '), r1);
  const names = bakNames(app);
  ok(names.length === 4 && /^clk_bak_\d{12}$/.test(names[0]) && /^org_bak_\d{12}$/.test(names[1]) && /^org_upg_\d{12}$/.test(names[2]) && /^stf_bak_\d{12}$/.test(names[3]), 'T4 備份分頁名帶時間（org_bak_／clk_bak_／stf_bak_ YYYYMMDDHHmm）', names);
  const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
  ok(st.org_bak === names[1] && st.clk_bak === names[0] && /^[0-9a-f]{64}$/.test(st.org_hash), 'T4 Script Properties ORG_UPGRADE_STATE＝{備份名、升級後 org 雜湊}');
  ok(nonBlank(app.sheets[st.org_bak]._rows().slice(1)).join() === app.legacySnap.join(), 'T4 org 備份＝升級前整份');
  ok(app.sheets[st.clk_bak]._rows().map((r) => r.join('|')).join() === app.legacyClock.map((r) => r.join('|')).join(), 'T4 clock_stores 備份＝升級前整份');
  const org = sb.stfReadOrg_();
  ok(org.unit['mzt-hq'].ladder === 'office' && org.unit['mala-hq'].name === '小辛辣品牌辦公室' && org.unit['yiwu-hq'].ladder === 'office' && org.unit['yiwu-hq'].parent === 'yiwu' && org.brand.ck.name === '中央工廠' && org.unit.ck.name === '中央工廠（央廚）', 'T4 org 已是新樣子');
  ok(['mzt-wx', 'mzt-rg', 'mzt-mc'].every((c) => !org.unit[c].active) && ['am', 'sv', 'bd'].every((c) => !org.title[c].active) && ['pt', 'ft', 'sm'].every((c) => org.title[c].active), 'T4 三店與 am／sv／bd 停用、pt／ft／sm 啟用');
  ok(['ofs', 'oam', 'osv', 'odir'].every((c, k) => org.title[c].parent === 'office' && org.title[c].rank === [1, 2, 2, 3][k] && org.title[c].order === k + 1 && org.title[c].active) && org.dept.training, 'T4 辦公室四級職稱完整八欄、訓練部保留');
  ok(clkHq(app)[2] === 'dzy-hq,mzt-hq,mala-hq,yiwu-hq', 'T4 clock hq 列補上 yiwu-hq');
  ok(app.sheets.staff._data[0].slice(24, 27).join() === 'hire_date,last_day,extra_depts', 'T4 staff 補 extra_depts 欄');
  ok(staffOf(app, P.offHs.emp).title === 'ofs' && staffOf(app, P.offHm.emp).title === 'osv' && staffOf(app, P.offCeo.emp).title === 'ceo' && staffOf(app, P.storeAm.emp).title === 'am', 'T4 辦公室 hs→ofs、hm→osv；ceo 與門市 am 不動');
  const stfBakRows = app.sheets[st.stf_bak]._rows().slice(1);
  ok(stfBakRows.length === 2 && stfBakRows.some((r) => r[0] === P.offHs.emp && r[1] === 'hs' && r[2] === 'ofs'), 'T4 受影響同仁的原職稱已備份（emp_no,title）');
  ok(post(sb, 'orgOptions', {}).data.titles.filter((t) => t.parent === 'store').map((t) => t.code).join() === 'pt,ft,sm', 'T4 orgOptions 門市職稱只剩三級');
  // 升級後同仁名單 flags 與預覽 todo 一致
  const lst = post(sb, 'staffList', {}, tok).data.staff;
  const fl = (emp) => lst.find((x) => x.emp_no === emp).flags.join();
  ok(fl(P.offCeo.emp) === 'title_ladder,exec_misplaced' && fl(P.storeAm.emp) === 'title_ladder' && fl(P.stopped.emp) === 'unit_inactive' && fl(P.normal.emp) === '' && fl(P.offHs.emp) === '', 'T4 升級後 staffList flags 與預覽 todo 一致');

  // ── 重跑：第二次無變更 ──
  const before = orgSnap(app).join();
  const beforeSheets = Object.keys(app.sheets).sort().join();
  const stateBefore = app.props.ORG_UPGRADE_STATE;
  const r2 = upg(app, {});
  ok(r2.ok && r2.data.org.length === 0 && r2.data.backup === 'exists' && r2.data.clock === 'skipped' && r2.data.staffColumn === 'exists' && r2.data.titles.length === 0, 'T4 跑兩次：第二次 org 無變更、備份 exists、clock skipped、欄位 exists、無職稱變更', r2);
  ok(orgSnap(app).join() === before && Object.keys(app.sheets).sort().join() === beforeSheets && app.props.ORG_UPGRADE_STATE === stateBefore && bakNames(app).length === 4, 'T4 第二次沒有任何寫入（org 逐格相同、沒多分頁、狀態不變、備份沒被覆蓋）');
  ok(JSON.stringify(upg(app, { dryrun: true }).data.org) === '[]', 'T4 升級後預覽＝空');

  // ── 回退 ──
  // 切換後有人調到新單位／改過職稱
  ok(post(sb, 'staffEdit', { emp_no: P.hqIt.emp, brand: 'yiwu', unit: 'yiwu-hq', dept: '', title: 'oam' }, tok).ok, 'T4 （前置）切換後把一位同仁調到 yiwu-hq 區經理');
  ok(post(sb, 'staffEdit', { emp_no: P.offHm.emp, title: 'odir' }, tok).ok, 'T4 （前置）切換後又把升級對應過的人改成總監');
  const rb = rbk(app);
  ok(rb.ok && rb.data.restored === LEGACY_ORG.length, 'T4 回退成功，restored＝備份列數', rb);
  ok(orgSnap(app).join() === app.legacySnap.join(), 'T4 回退後 org 與升級前逐格相同');
  ok(app.sheets.clock_stores._rows().map((r) => r.join('|')).join() === app.legacyClock.map((r) => r.join('|')).join(), 'T4 回退後 clock_stores 與升級前逐格相同');
  ok(staffOf(app, P.offHs.emp).title === 'hs', 'T4 回退：升級對應過、之後沒動的人職稱還原（ofs→hs）');
  ok(staffOf(app, P.offHm.emp).title === 'odir' && rb.data.titles_skipped.indexOf(P.offHm.emp) !== -1 && rb.data.titles_restored === 1, 'T4 回退：升級後又被改過的職稱不蓋回、列入 titles_skipped', rb.data);
  ok(rb.data.orphans.some((o) => o.emp_no === P.hqIt.emp && o.unit === 'yiwu-hq') && rb.data.orphans.some((o) => o.emp_no === P.offHm.emp && o.title === 'odir'), 'T4 回退報告：列出回退後單位／職稱找不到的孤兒', rb.data.orphans);
  ok(!rb.data.orphans.some((o) => o.emp_no === P.normal.emp || o.emp_no === P.offHs.emp), 'T4 孤兒不含正常的人');
  ok(rbk(app).ok === false && rbk(app).error === '找不到升級紀錄，沒有可退回的備份', 'T4 沒有升級紀錄時回退 → 找不到升級紀錄');

  // ── 回退保護：切換後 org 被改過 → 拒絕整表覆蓋並列差異 ──
  post(sb, 'staffEdit', { emp_no: P.hqIt.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' }, tok);
  post(sb, 'staffEdit', { emp_no: P.offHm.emp, title: 'hm' }, tok);
  ok(upg(app, {}).ok && upg(app, {}).data.backup === 'exists', 'T4 回退後可再次升級（重新備份）');
  const odata = app.sheets.org._data;
  odata.find((r) => r[1] === 'mala-gf')[2] = '光復店（改名）';
  const snapAfter = orgSnap(app).join();
  const rb2 = rbk(app);
  ok(rb2.ok === false && rb2.data && rb2.data.diff.some((d) => d.code === 'mala-gf' && d.field === 'name' && d.expected === '新竹光復' && d.actual === '光復店（改名）'), 'T4 回退保護：切換後 org 被改過 → 拒絕並列出差異', rb2);
  ok(orgSnap(app).join() === snapAfter, 'T4 被拒絕時 org 原封不動');
  odata.find((r) => r[1] === 'mala-gf')[2] = '新竹光復';
  odata.push(['unit', 'extra-x', '別人加的', 'mala', 'store', '', 9, 'TRUE']);
  const rb3 = rbk(app);
  ok(rb3.ok === false && rb3.data.diff.some((d) => d.code === 'extra-x' && d.field === 'row' && d.actual === 'added'), 'T4 回退保護：別人新增了列也列出來', rb3.data && rb3.data.diff);
  odata.pop();
  ok(rbk(app).ok && orgSnap(app).join() === app.legacySnap.join(), 'T4 差異處理掉後可回退，回退後與備份逐格相同');
})();

// 自訂過的 clock hq 列
(() => {
  const mkApp = (v) => {
    const app = fresh();
    const od = app.sheets.org._data; od.length = 1; LEGACY_ORG.forEach((r) => od.push(r.slice()));
    app.sheets.clock_stores._data.find((r) => r[0] === 'hq')[2] = v;
    return app;
  };
  const up = (a) => post(a.sb, 'orgUpgrade2026', {}, a.tok);
  const hq = (a) => a.sheets.clock_stores._data.find((r) => r[0] === 'hq')[2];
  const a1 = mkApp('mala-hq,dzy-hq');
  const r1 = up(a1);
  ok(r1.ok && r1.data.clock === 'updated' && hq(a1) === 'mala-hq,dzy-hq,yiwu-hq', 'T4 clock hq 自訂值：保留自訂值與順序，只在後面補 yiwu-hq');
  const a2 = mkApp('dzy-hq,yiwu-hq,mzt-hq');
  const r2 = up(a2);
  ok(r2.ok && r2.data.clock === 'skipped' && hq(a2) === 'dzy-hq,yiwu-hq,mzt-hq', 'T4 clock hq 自訂值已含 yiwu-hq → skipped、原樣不動');
  const a3 = mkApp('');
  const r3 = up(a3);
  ok(r3.ok && r3.data.clock === 'custom' && hq(a3) === '', 'T4 clock hq 被刻意清空 → custom、不動');
  const a4 = mkApp('dzy-hq');
  a4.sheets.clock_stores._data.find((r) => r[0] === 'cf')[2] = '自訂-cf';
  up(a4);
  ok(a4.sheets.clock_stores._data.find((r) => r[0] === 'cf')[2] === '自訂-cf' && a4.sheets.clock_stores._data.find((r) => r[0] === 'gf')[2] === 'mala-gf', 'T4 clock 其他列完全不動');
  // 沒有 clock_stores 分頁
  const a5 = mkApp('dzy-hq');
  delete a5.sheets.clock_stores;
  const r5 = up(a5);
  ok(r5.ok && r5.data.clock === 'custom' && !a5.props.ORG_UPGRADE_STATE === false && JSON.parse(a5.props.ORG_UPGRADE_STATE).clk_bak === '', 'T4 沒有 clock_stores 分頁 → clock＝custom、升級照跑、不建 clk 備份', r5);
  // staff 欄表頭被改過 → 停
  const a6 = mkApp('dzy-hq');
  a6.sheets.staff._data[0][26] = 'zzz';
  const before6 = a6.sheets.org._rows().map((r) => r.join('|')).join();
  const r6 = up(a6);
  ok(r6.ok === false && a6.sheets.org._rows().map((r) => r.join('|')).join() === before6 && !a6.props.ORG_UPGRADE_STATE, 'T4 staff 第 27 欄表頭不符 → 停下，什麼都不寫（含備份）', r6);
})();

// ============================================================
// 第 1 輪審查修正（issue #3）
// ============================================================
(() => {
  // #6／G6：備份名撞名 → 加序號；insertSheet 遇同名會丟錯（同真 Google）
  const app = legacyApp();
  const { sb } = app;
  const stamp = sb.stfStamp_();
  ['org_bak_', 'clk_bak_', 'stf_bak_', 'org_upg_'].forEach((p) => { app.sheets[p + stamp] = null; delete app.sheets[p + stamp]; });
  app.sheets['stf_bak_' + stamp] = { _fake: true, getLastRow: () => 0 };
  app.sheets['org_bak_' + stamp] = app.sheets.org;
  const r = post(sb, 'orgUpgrade2026', {}, app.tok);
  const st = JSON.parse(app.props.ORG_UPGRADE_STATE || '{}');
  ok(r.ok, 'R1 #6 備份名已被占用時升級仍成功', r);
  const names = [st.org_bak, st.clk_bak, st.stf_bak, st.org_snap];
  ok(names.every((n) => n && app.sheets[n]) && new Set(names).size === 4 && names.every((n) => /_2$/.test(n)), 'R1 #6 三個（加快照共四個）名稱共用序號、互不相同、都已建立並存進 state', names);
})();

(() => {
  // #1：舊 staff 分頁只有 26 欄（未跑 setupStaff／orgUpgrade2026）→ 讀尾端欄依實際欄數，缺的當空字串
  const app = legacyApp();
  const { sb, tok } = app;
  app.sheets.staff._setMaxCols(26);
  ok(app.sheets.staff.getMaxColumns() === 26, 'R1 #1 （前置）staff 只有 26 欄');
  const call = (a) => { try { return post(sb, a, {}, tok); } catch (e) { return { ok: false, thrown: String(e.message) }; } };
  let all;
  try { all = sb.clkStaffAll_(); } catch (e) { all = e.message; }
  ok(Array.isArray(all) && all.length >= 10 && all.every((x) => x.values.length === 27 && x.values[26] === ''), 'R1 #1 clkStaffAll_ 對 26 欄分頁不丟錯、缺的第 27 欄補空字串', typeof all === 'string' ? all : all.length);
  const sl = call('staffList');
  ok(sl.ok && sl.data.staff.length >= 10, 'R1 #1 staffList 對 26 欄分頁可用（升級前 BOSS 要能開名單）', sl);
  const ca = call('clockAlerts');
  ok(ca.thrown === undefined && !/忙碌/.test(String(ca.error || '')), 'R1 #1 clockAlerts 對 26 欄分頁不爆', ca);
  const up = post(sb, 'orgUpgrade2026', {}, tok);
  ok(up.ok && app.sheets.staff.getMaxColumns() >= 27 && app.sheets.staff._data[0][26] === 'extra_depts', 'R1 #1 升級照常補欄', up);
})();

(() => {
  // #2／G3：重跑升級不得更新 org_hash／快照基準
  const app = legacyApp();
  const { sb, tok } = app;
  post(sb, 'orgUpgrade2026', {}, tok);
  const h0 = JSON.parse(app.props.ORG_UPGRADE_STATE).org_hash;
  app.sheets.org._data.push(['unit', 'extra-x', '外加', 'mala', 'store', '', 9, 'TRUE']);
  app.sheets.org._data.find((r) => r[1] === 'mala-hq' && r[0] === 'unit')[2] = '壞掉';
  const r2 = post(sb, 'orgUpgrade2026', {}, tok);
  ok(r2.ok && r2.data.org.length >= 1, 'R1 #2 重跑升級把改壞的名稱修回', r2);
  ok(JSON.parse(app.props.ORG_UPGRADE_STATE).org_hash === h0, 'R1 #2 重跑後 org_hash 不變（基準只在首次成功建立）');
  const rb = post(sb, 'orgRollback2026', {}, tok);
  ok(rb.ok === false && rb.data && rb.data.diff.some((d) => d.code === 'extra-x'), 'R1 #2 之後回退仍被拒並列出 extra-x', rb);
})();

(() => {
  // #3：flags／升級預覽 todo 也看 p_*（送出待審的單位、職稱）
  const app = legacyApp();
  const { sb, tok } = app;
  const pend1 = submitOnly(app, '待審甲', { brand: 'mzt', unit: 'mzt-hq', title: 'hs' });          // 送出的職稱 hs（hq 階梯），升級後 mzt-hq 變 office
  const pend2 = submitOnly(app, '待審乙', { brand: 'mzt', unit: 'mzt-mc', title: 'pt' });          // 送出的單位 mzt-mc 升級後停用
  const chg = app.P.offHm;                                                                       // 在職、送出晉升待確認 p_title=hm
  setStaff(app, chg.emp, 'p_unit', 'mala-hq'); setStaff(app, chg.emp, 'p_title', 'hm');
  const dr = post(sb, 'orgUpgrade2026', { dryrun: true }, tok);
  const td = (emp) => dr.data.todo.filter((x) => x.emp_no === emp);
  ok(td(pend1.emp).some((x) => x.flag === 'title_ladder' && x.submitted === true), 'R1 #3 預覽 todo：待審送出的 hs 升級後不屬 office 階梯 → title_ladder＋submitted', dr.data.todo);
  ok(td(pend2.emp).some((x) => x.flag === 'unit_inactive' && x.submitted === true), 'R1 #3 預覽 todo：待審送出的 mzt-mc 停用 → unit_inactive＋submitted');
  ok(td(chg.emp).some((x) => x.flag === 'title_ladder' && x.submitted === true), 'R1 #3 預覽 todo：在職送出的 p_title=hm 升級後不合 → title_ladder＋submitted');
  ok(td(app.P.normal.emp).length === 0, 'R1 #3 沒有 p_* 的正常人不列');
  post(sb, 'orgUpgrade2026', {}, tok);
  const list = post(sb, 'staffList', {}, tok).data.staff;
  const fl = (emp) => list.find((x) => x.emp_no === emp).flags;
  ok(fl(pend1.emp).indexOf('title_ladder') !== -1 && fl(pend2.emp).indexOf('unit_inactive') !== -1 && fl(chg.emp).indexOf('title_ladder') !== -1, 'R1 #3 升級後 staffList flags 看得到 p_* 的問題', [fl(pend1.emp), fl(pend2.emp), fl(chg.emp)]);
})();

(() => {
  // #5：flags／orphans 也檢查 dept（主要與送出的部門代碼不存在或停用）
  const app = legacyApp();
  const { sb, tok } = app;
  const it = app.P.hqIt;
  const flagsOf = (emp) => post(sb, 'staffList', {}, tok).data.staff.find((x) => x.emp_no === emp).flags;
  ok(flagsOf(it.emp).indexOf('dept_inactive') === -1, 'R1 #5 （前置）部門正常 → 無 dept_inactive');
  app.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'it')[7] = 'FALSE';
  ok(flagsOf(it.emp).indexOf('dept_inactive') !== -1, 'R1 #5 主要部門停用 → dept_inactive');
  app.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'it')[7] = 'TRUE';
  setStaff(app, it.emp, 'dept', 'ghost');
  ok(flagsOf(it.emp).indexOf('dept_inactive') !== -1, 'R1 #5 主要部門代碼不存在 → dept_inactive');
  setStaff(app, it.emp, 'dept', 'it');
  setStaff(app, it.emp, 'p_dept', 'ghost2'); setStaff(app, it.emp, 'p_title', 'hm');
  const dr = post(sb, 'orgUpgrade2026', { dryrun: true }, tok);
  ok(dr.data.todo.some((x) => x.emp_no === it.emp && x.flag === 'dept_inactive' && x.submitted === true), 'R1 #5 送出的部門不存在 → todo dept_inactive＋submitted', dr.data.todo);
  setStaff(app, it.emp, 'p_dept', ''); setStaff(app, it.emp, 'p_title', '');
  post(sb, 'orgUpgrade2026', {}, tok);
  setStaff(app, it.emp, 'dept', 'ghost');
  const rb = post(sb, 'orgRollback2026', {}, tok);
  ok(rb.ok && rb.data.orphans.some((o) => o.emp_no === it.emp && o.dept === 'ghost'), 'R1 #5 回退 orphans 也列出部門不存在的人', rb);
})();

(() => {
  // G5：目標列缺失 → 以 (kind,code) 補整列八欄；G8：既有列 order 也校正
  const app = legacyApp();
  const { sb, tok } = app;
  const od = app.sheets.org._data;
  ['mzt-hq', 'ck', 'mzt-mc'].forEach((c) => { const i = od.findIndex((r) => r[0] === 'unit' && r[1] === c); od.splice(i, 1); });
  ['am', 'bd'].forEach((c) => { const i = od.findIndex((r) => r[0] === 'title' && r[1] === c); od.splice(i, 1); });
  od.splice(od.findIndex((r) => r[0] === 'brand' && r[1] === 'ck'), 1);
  od.push(['title', 'osv', '區督導', 'office', '', 3, 99, 'TRUE']);
  od.push(['unit', 'yiwu-hq', '舊名', 'yiwu', 'office', '', 77, 'TRUE']);
  const r = post(sb, 'orgUpgrade2026', {}, tok);
  ok(r.ok, 'R1 G5 缺列時升級成功（補整列）', r);
  const row = (k, c) => app.sheets.org._rows().find((x) => x[0] === k && x[1] === c);
  const eq = (x, y) => x && x.slice(0, 8).map(String).join('|') === y.map(String).join('|');
  ok(eq(row('unit', 'mzt-hq'), ['unit', 'mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office', '', 7, 'TRUE']), 'R1 G5 缺的 mzt-hq 補成完整八欄', row('unit', 'mzt-hq'));
  ok(eq(row('unit', 'ck'), ['unit', 'ck', '中央工廠（央廚）', 'ck', 'store', '', 1, 'TRUE']) && eq(row('brand', 'ck'), ['brand', 'ck', '中央工廠', '', '', '', 4, 'TRUE']), 'R1 G5 缺的 unit／brand ck 補成完整八欄');
  ok(eq(row('unit', 'mzt-mc'), ['unit', 'mzt-mc', '台中美村', 'mzt', 'store', '', 6, 'FALSE']) && eq(row('title', 'am'), ['title', 'am', '區經理', 'store', '', 4, 4, 'FALSE']) && eq(row('title', 'bd'), ['title', 'bd', '品牌總監', 'store', '', 6, 6, 'FALSE']), 'R1 G5 缺的 mzt-mc／am／bd 補成停用整列');
  ok(row('title', 'osv')[6] === 3 && row('unit', 'yiwu-hq')[6] === 3 && row('unit', 'yiwu-hq')[2] === '一悟燒肉品牌辦公室', 'R1 G8 既有列 order 也校正（osv 99→3、yiwu-hq 77→3）', [row('title', 'osv'), row('unit', 'yiwu-hq')]);
  ok(post(sb, 'orgUpgrade2026', { dryrun: true }, tok).data.org.length === 0, 'R1 G5 補完後預覽為空');
})();

(() => {
  // #4：clock_stores 回退也要雜湊保護
  const app = legacyApp();
  const { sb, tok } = app;
  post(sb, 'orgUpgrade2026', {}, tok);
  const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
  ok(/^[0-9a-f]{64}$/.test(st.clk_hash || '') && st.clk_snap && app.sheets[st.clk_snap], 'R1 #4 升級後 state 記 clk_hash＋快照分頁', st);
  const cs = app.sheets.clock_stores._data;
  const orgBefore = app.sheets.org._rows().map((r) => r.join('|')).join();
  cs.push(['newstore', '新店', 'x', 'y', 'z']);
  const gf = cs.find((r) => r[0] === 'gf'); const oldPay = gf[3]; gf[3] = '改過';
  const rb = post(sb, 'orgRollback2026', {}, tok);
  ok(rb.ok === false && rb.data && rb.data.clock_diff && rb.data.clock_diff.some((d) => d.key === 'newstore' && d.actual === 'added') && rb.data.clock_diff.some((d) => d.key === 'gf' && d.actual === '改過'), 'R1 #4 clock_stores 被改過 → 回退拒絕並列差異', rb);
  ok(app.sheets.org._rows().map((r) => r.join('|')).join() === orgBefore && app.props.ORG_UPGRADE_STATE && cs.some((r) => r[0] === 'newstore'), 'R1 #4 被拒時零寫入（org 不動、clock 不動、state 保留）');
  cs.pop(); gf[3] = oldPay;
  const rb2 = post(sb, 'orgRollback2026', {}, tok);
  ok(rb2.ok && app.sheets.clock_stores._rows().map((r) => r.join('|')).join() === app.legacyClock.map((r) => r.join('|')).join(), 'R1 #4 差異處理掉後可回退', rb2);
})();

(() => {
  // G4：回退寫入前檢查所有備份與正式分頁
  const cases = [['stf_bak', (a, st) => { delete a.sheets[st.stf_bak]; }], ['clk_bak', (a, st) => { delete a.sheets[st.clk_bak]; }], ['clock_stores', (a) => { delete a.sheets.clock_stores; }], ['org_bak', (a, st) => { delete a.sheets[st.org_bak]; }]];
  cases.forEach(([label, brk]) => {
    const app = legacyApp();
    const { sb, tok } = app;
    post(sb, 'orgUpgrade2026', {}, tok);
    const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
    brk(app, st);
    const snapOrg = app.sheets.org._rows().map((r) => r.join('|')).join();
    const titles = app.sheets.staff._rows().map((r) => r[0] + r[7]).join();
    const rb = post(sb, 'orgRollback2026', {}, tok);
    ok(rb.ok === false && /找不到/.test(rb.error) && app.props.ORG_UPGRADE_STATE === JSON.stringify(st) && app.sheets.org._rows().map((r) => r.join('|')).join() === snapOrg && app.sheets.staff._rows().map((r) => r[0] + r[7]).join() === titles, 'R1 G4 缺 ' + label + ' → 零寫入、回錯、保留 state', rb);
  });
})();

(() => {
  // G2：回退中斷（org 已蓋回、clock 寫入失敗）後可重跑
  const app = legacyApp();
  const { sb, tok } = app;
  post(sb, 'orgUpgrade2026', {}, tok);
  const sh = app.sheets.clock_stores; const orig = sh.getRange; let fail = true;
  sh.getRange = (...a) => { const r = orig(...a); if (fail) r.setValues = () => { throw new Error('timeout'); }; return r; };
  const rb1 = post(sb, 'orgRollback2026', {}, tok);
  ok(rb1.ok === false && app.props.ORG_UPGRADE_STATE && orgSnap(app).join() === app.legacySnap.join(), 'R1 G2 （前置）回退在 clock 步驟中斷：org 已是備份、state 還在', rb1);
  fail = false;
  const rb2 = post(sb, 'orgRollback2026', {}, tok);
  ok(rb2.ok === true && rb2.data.clock_restored === true && app.sheets.clock_stores._rows().map((r) => r.join('|')).join() === app.legacyClock.map((r) => r.join('|')).join() && !app.props.ORG_UPGRADE_STATE, 'R1 G2 重跑成功：續跑 clock、state 清除', rb2);
  ok(orgSnap(app).join() === app.legacySnap.join() && staffOf(app, app.P.offHs.emp).title === 'hs', 'R1 G2 org 與職稱仍是還原後的樣子');
})();

(() => {
  // N1：state 在、備份分頁被刪 → 升級（含 dryrun）拒絕、零寫入
  ['org_bak', 'stf_bak', 'clk_bak'].forEach((k) => {
    const app = legacyApp();
    const { sb, tok } = app;
    post(sb, 'orgUpgrade2026', {}, tok);
    const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
    delete app.sheets[st[k]];
    const names0 = Object.keys(app.sheets).sort().join();
    const org0 = app.sheets.org._rows().map((r) => r.join('|')).join();
    const u1 = post(sb, 'orgUpgrade2026', {}, tok);
    const u2 = post(sb, 'orgUpgrade2026', { dryrun: true }, tok);
    ok(u1.ok === false && u2.ok === false && u1.error.indexOf(st[k]) !== -1 && Object.keys(app.sheets).sort().join() === names0 && app.sheets.org._rows().map((r) => r.join('|')).join() === org0 && app.props.ORG_UPGRADE_STATE === JSON.stringify(st), 'R2 N1 缺 ' + k + ' → 升級／預覽拒絕、說明缺哪份、零寫入', [u1, u2]);
  });
  // N2：快照被刪不要把現況全列 added
  const app = legacyApp();
  const { sb, tok } = app;
  post(sb, 'orgUpgrade2026', {}, tok);
  const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
  app.sheets.org._data.push(['unit', 'extra-x', 'x', 'mala', 'store', '', 9, 'TRUE']);
  delete app.sheets[st.org_snap];
  const rb = post(sb, 'orgRollback2026', {}, tok);
  ok(rb.ok === false && rb.error === '找不到切換後快照，無法比對差異；請先確認組織表沒被改過' && !rb.data && app.props.ORG_UPGRADE_STATE === JSON.stringify(st), 'R2 N2 org_snap 被刪 → 明確訊息、不列 diff、零寫入', rb);
  const app2 = legacyApp();
  post(app2.sb, 'orgUpgrade2026', {}, app2.tok);
  const st2 = JSON.parse(app2.props.ORG_UPGRADE_STATE);
  app2.sheets.clock_stores._data.push(['zz', 'q', 'q', 'q', 'q']);
  delete app2.sheets[st2.clk_snap];
  const rb2 = post(app2.sb, 'orgRollback2026', {}, app2.tok);
  ok(rb2.ok === false && /找不到切換後快照/.test(rb2.error), 'R2 N2 clk_snap 被刪 → 同樣明確訊息', rb2);
})();

(() => {
  // 兼任停用代碼：原有的原樣放行，新加入的仍須啟用
  const app = legacyApp();
  const { sb, tok } = app;
  const org = sb.stfReadOrg_();
  const f = (list, ex) => sb.stfCleanExtraDepts_(org, list, 'dzy-hq', 'it', ex);
  const r = f(['training', 'old', 'ops'], ['training', 'old']);
  ok(!r.error && r.codes.sort().join() === 'old,ops,training', 'R2 兼任：原有 [training,old] 送 [training,old,ops] → 通過（old 原樣保留）', r);
  ok(!!f(['new-inactive'], []).error && !!f(['training', 'old'], ['training']).error, 'R2 兼任：新加入的不存在代碼 → 擋');
  app.sheets.org._data.find((x) => x[0] === 'dept' && x[1] === 'ops')[7] = 'FALSE';
  const f2 = (list, ex) => sb.stfCleanExtraDepts_(sb.stfReadOrg_(), list, 'dzy-hq', 'it', ex);
  ok(!f2(['ops'], ['ops']).error && !!f2(['ops'], []).error, 'R2 兼任：停用的 ops 原有就放行、新加就擋');
  // 端到端
  const crew = mk(app, '兼任甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  app.sheets.staff._data[0][26] = 'extra_depts';
  app.sheets.staff._data.find((x) => x[0] === crew.emp)[26] = 'training,old';
  const e = post(sb, 'staffEdit', { emp_no: crew.emp, extra_depts: ['training', 'old', 'it'] }, tok);
  ok(e.ok && app.sheets.staff._data.find((x) => x[0] === crew.emp)[26] === 'it,training,old', 'R2 兼任：staffEdit 帶入原有停用代碼可存', e);
})();

(() => {
  // N4：備份分頁還在但被清空 → 升級／預覽／回退都拒絕、零寫入
  ['org_bak', 'stf_bak', 'clk_bak'].forEach((k) => {
    const app = legacyApp();
    const { sb, tok } = app;
    post(sb, 'orgUpgrade2026', {}, tok);
    const st = JSON.parse(app.props.ORG_UPGRADE_STATE);
    app.sheets[st[k]]._data.length = 0;
    const snap = () => JSON.stringify([Object.keys(app.sheets).sort(), app.sheets.org._rows(), app.sheets.staff._rows(), app.sheets.clock_stores._rows(), app.props.ORG_UPGRADE_STATE]);
    const before = snap();
    const u1 = post(sb, 'orgUpgrade2026', {}, tok), u2 = post(sb, 'orgUpgrade2026', { dryrun: true }, tok), rb = post(sb, 'orgRollback2026', {}, tok);
    ok(!u1.ok && !u2.ok && !rb.ok && u1.error.indexOf(st[k]) !== -1 && rb.error.indexOf(st[k]) !== -1 && snap() === before, 'R3 N4 ' + k + ' 被清空 → 升級／預覽／回退拒絕、零寫入', [u1, u2, rb]);
  });
})();

(() => {
  // N3：主要單位變成 ck → 自動從 extra_depts 移除 ck
  const app = legacyApp();
  const { sb, tok } = app;
  const c = mk(app, '兼任乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  const row = () => app.sheets.staff._data.find((x) => x[0] === c.emp);
  app.sheets.staff._data[0][26] = 'extra_depts';
  row()[26] = 'fin,ck';
  const e = post(sb, 'staffEdit', { emp_no: c.emp, brand: 'ck', unit: 'ck', dept: '', title: 'pt' }, tok);
  ok(e.ok && row()[26] === 'fin', 'R3 N3 後台把主要單位改成 ck → extra_depts 的 ck 被移除（保留 fin）', [e, row()[26]]);
})();

// ============================================================
// 管理部（規格第 14 節）
// ============================================================
(() => {
  const app = fresh();
  const { sb, tok, hrTok } = app;
  const org = sb.stfReadOrg_();
  ok(org.dept.mgmt && org.dept.mgmt.name === '管理部' && org.dept.mgmt.parent === 'dzy-hq' && org.dept.mgmt.active && org.dept.mgmt.order === 10, 'M1 預設 org 有管理部（dzy-hq、order 10、啟用）');
  ok(Object.keys(org.dept).length === 11, 'M1 部門共 11 個（含 2026-10-23 品牌發展部）', Object.keys(org.dept));
  ok(post(sb, 'orgOptions', {}).data.depts.some((d) => d.code === 'mgmt'), 'M1 orgOptions 兼任／部門選單自然多出管理部');

  const mgHs = mk(app, '管理甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hs' });
  const mgHm = mk(app, '管理乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hm' });
  const itHm = mk(app, '管理丙', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  const opsHm = mk(app, '管理丁', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hm' });
  const ceo = mk(app, '管理戊', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'ceo' });
  const pHs = submitOnly(app, '管理己', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hs' });
  const pItHs = submitOnly(app, '管理庚', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' });
  const pending = (t) => { const r = post(sb, 'unitPending', {}, t); return r.ok ? r.data.people.map((x) => x.emp_no) : null; };
  const scope = (m) => sb.stfReviewScope_(sb.stfFindByEmp_(m.emp).values, sb.stfReadOrg_());
  ok(scope(mgHm) === null && pending(mgHm.token) === null, 'M2 管理部主管（hm）沒有審核資格');
  ok(pending(ceo.token) !== null && pending(ceo.token).indexOf(pHs.emp) !== -1, 'M2 執行長可審管理部同仁');
  ok(pending(itHm.token).indexOf(pHs.emp) === -1 && pending(itHm.token).indexOf(pItHs.emp) !== -1, 'M2 別部門主管不能審管理部同仁、仍可審自己部門');
  ok(pending(opsHm.token).indexOf(pHs.emp) === -1, 'M2 營運部主管不能審管理部同仁');
  ok(pending(hrTok).indexOf(pHs.emp) !== -1 && pending(tok).indexOf(pHs.emp) !== -1, 'M2 人資、admin 可審管理部同仁');
  ok(post(sb, 'unitApprove', { emp_no: pHs.emp }, mgHm.token).ok === false && post(sb, 'unitApprove', { emp_no: pHs.emp }, itHm.token).ok === false, 'M2 反：管理部主管／別部門主管 unitApprove 被擋');
  ok(staffOf(app, pHs.emp).status === 'pending', 'M2 被擋的沒改到資料');
  const perms = (t) => post(sb, 'me', {}, t).data.perms;
  ok(perms(mgHm.token).indexOf('platform.review') === -1, 'M2 管理部 hm 沒有衍生權限 platform.review');
  ok(perms(login(app, itHm.emp, itHm.pw).data.token).indexOf('platform.review') !== -1 && perms(ceo.token).indexOf('platform.review') !== -1, 'M2 資訊部 hm、執行長仍有 platform.review');
  ok(post(sb, 'unitApprove', { emp_no: pHs.emp }, ceo.token).code === 'perm_admin_only', 'M2 執行長核准管理部同仁 → 會拿到 audit.write，鎖碼擴大後只有 admin');
  ok(post(sb, 'unitApprove', { emp_no: pHs.emp }, tok).ok && staffOf(app, pHs.emp).status === 'active', 'M2 正：admin 核准管理部同仁');
  // 管理部同仁改部門的待審（目前身分在 mgmt）：別部門主管也不行
  ok(post(sb, 'unitApprove', { emp_no: pItHs.emp }, itHm.token).ok, 'M2 正：資訊部主管核准資訊部同仁');
  ok(sb.stfReviewNeed_(sb.stfReadOrg_(), 'dzy-hq', 'mgmt', 'hs').kind === 'exec' && sb.stfReviewNeed_(sb.stfReadOrg_(), 'dzy-hq', 'mgmt', 'hm').kind === 'exec', 'M2 stfReviewNeed_：管理部 hs／hm 都要執行長以上');
})();

(() => {
  // exec_misplaced
  const app = fresh();
  const { sb, tok } = app;
  const good = mk(app, '位置甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'ceo' });
  const wrongDept = mk(app, '位置乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'gm' });
  const wrongUnit = mk(app, '位置丙', { brand: 'mala', unit: 'mala-hq', title: 'ofs' });
  const normal = mk(app, '位置丁', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' });
  const pend = submitOnly(app, '位置戊', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'chair' });
  const flags = (emp) => post(sb, 'staffList', {}, tok).data.staff.find((x) => x.emp_no === emp).flags;
  ok(flags(good.emp).indexOf('exec_misplaced') === -1, 'E1 ceo 在 dzy-hq／mgmt → 無 exec_misplaced');
  ok(flags(wrongDept.emp).join() === 'exec_misplaced', 'E1 gm 在 dzy-hq／hr → exec_misplaced', flags(wrongDept.emp));
  ok(flags(normal.emp).length === 0, 'E1 一般同仁無 flag');
  ok(flags(pend.emp).indexOf('exec_misplaced') !== -1, 'E1 送出待審 chair 在 fin → 也判斷');
  const d = sb.stfFlagDetails_({ unit: '', title: '', dept: '', status: 'pending', p_unit: 'dzy-hq', p_title: 'chair', p_dept: 'fin' }, sb.stfReadOrg_());
  ok(d.some((x) => x.flag === 'exec_misplaced' && x.submitted === true), 'E1 送出待審 → submitted＝true', d);
  // 掛品牌辦公室：title_ladder 與 exec_misplaced 同時
  const o = sb.stfReadOrg_();
  const both = sb.stfFlagDetails_({ unit: 'mala-hq', title: 'ceo', dept: '', status: 'active' }, o).map((x) => x.flag).sort().join();
  ok(both === 'exec_misplaced,title_ladder', 'E1 掛品牌辦公室的 ceo → 兩個 flag 都列', both);
  const stu = sb.stfFlagDetails_({ unit: 'mala-gf', title: 'ceo', dept: '', status: 'active' }, o).map((x) => x.flag).sort().join();
  ok(stu === 'exec_misplaced,title_ladder', 'E1 掛門市的 chair／ceo 同上', stu);
  ok(sb.stfFlagDetails_({ unit: 'dzy-hq', title: 'ceo', dept: 'mgmt', status: 'disabled' }, o).length === 0 && sb.stfFlagDetails_({ unit: 'mala-hq', title: 'ceo', dept: '', status: 'disabled' }, o).length === 0, 'E1 已停用帳號不判斷');
})();

(() => {
  // 升級補 mgmt 列、重跑收斂、預覽 todo
  const app = legacyApp();
  const { sb } = app;
  const P = app.P;
  const mgCeo = mk(app, '升管甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'ceo' });
  ok(!orgRow(app, 'dept', 'mgmt'), 'U1 （前置）舊 org 沒有 mgmt');
  const dr = upg(app, { dryrun: true });
  ok(dr.data.org.some((x) => x.code === 'mgmt' && x.kind === 'dept' && x.field === 'row' && x.to === 'added'), 'U1 預覽列出新增 mgmt', dr.data.org);
  ok(dr.data.todo.some((x) => x.emp_no === mgCeo.emp && x.flag === 'exec_misplaced') && dr.data.todo.some((x) => x.emp_no === P.offCeo.emp && x.flag === 'exec_misplaced'), 'U1 預覽 todo：掛錯的 ceo 列 exec_misplaced', dr.data.todo);
  ok(!orgRow(app, 'dept', 'mgmt'), 'U1 預覽不寫入');
  const r1 = upg(app, {});
  ok(r1.ok && orgRow(app, 'dept', 'mgmt').slice(0, 8).join('|') === 'dept|mgmt|管理部|dzy-hq|||10|TRUE', 'U1 升級補上 mgmt 完整八欄', orgRow(app, 'dept', 'mgmt'));
  const r2 = upg(app, {});
  ok(r2.ok && r2.data.org.length === 0 && upg(app, { dryrun: true }).data.org.length === 0, 'U1 重跑收斂（無變更）');
  // 已存在但被改壞的 mgmt 列 → 對齊
  const row = app.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'mgmt');
  row[2] = '亂改'; row[7] = 'FALSE';
  const r3 = upg(app, {});
  ok(r3.ok && orgRow(app, 'dept', 'mgmt').slice(0, 8).join('|') === 'dept|mgmt|管理部|dzy-hq|||10|TRUE', 'U1 mgmt 列被改壞 → 升級對齊回完整八欄');
  const lst = post(sb, 'staffList', {}, app.tok).data.staff;
  const fl = (emp) => lst.find((x) => x.emp_no === emp).flags.join();
  ok(fl(mgCeo.emp) === 'exec_misplaced', 'U1 升級後 staffList 與預覽一致');
})();

(() => {
  // 管理部 hm → title_ladder；mgmt 列不存在時不判斷
  const app = fresh();
  const { sb } = app;
  const o = sb.stfReadOrg_();
  const fl = (x) => sb.stfFlagDetails_(Object.assign({ status: 'active', unit: 'dzy-hq', dept: 'mgmt', title: 'hm' }, x), o).map((d) => d.flag + (d.submitted ? '*' : '')).sort().join();
  ok(fl({}) === 'title_ladder', 'F1 管理部 hm → title_ladder', fl({}));
  ok(fl({ dept: 'it' }) === '' && fl({ dept: 'mgmt', title: 'hs' }) === '', 'F1 反：別部門 hm、管理部 hs 無 flag');
  ok(fl({ unit: '', dept: '', title: '', p_unit: 'dzy-hq', p_dept: 'mgmt', p_title: 'hm' }) === 'title_ladder*', 'F1 送出待審的管理部 hm → title_ladder＋submitted');
  const o2 = sb.stfReadOrg_(); delete o2.dept.mgmt;
  const f2 = (x) => sb.stfFlagDetails_(Object.assign({ status: 'active', unit: 'dzy-hq', dept: 'hr', title: 'ceo' }, x), o2).map((d) => d.flag).join();
  ok(f2({}) === '' && f2({ dept: 'mgmt', title: 'hm' }) === 'dept_inactive', 'F2 org 沒有 mgmt 列：不出 exec_misplaced／管理部 title_ladder');
  const o3 = sb.stfReadOrg_(); o3.dept.mgmt.active = false;
  ok(sb.stfFlagDetails_({ status: 'active', unit: 'dzy-hq', dept: 'hr', title: 'ceo' }, o3).length === 0, 'F2 mgmt 停用同樣不出 exec_misplaced');
  // 升級預覽：升級前 org 沒 mgmt，todo 以升級後 org 判斷 → 會列
  const lg = legacyApp();
  const hm = mk(lg, '管理辛', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  setStaff(lg, hm.emp, 'dept', 'mgmt');
  const dr = upg(lg, { dryrun: true });
  ok(dr.data.todo.some((x) => x.emp_no === hm.emp && x.flag === 'title_ladder'), 'F1 升級預覽 todo 列出管理部 hm', dr.data.todo);
  const lgf = lg.sb.stfFlagDetails_({ status: 'active', unit: 'dzy-hq', dept: 'mgmt', title: 'hm' }, lg.sb.stfReadOrg_()).map((d) => d.flag).join();
  ok(lgf === 'dept_inactive', 'F2 切換前（legacy org）不出 title_ladder／exec_misplaced', lgf);
})();

// ============================================================
// 第 15 節（2026-10-20 Eason）：區經理移回門市、中央工廠廠長 fm／廚藝總監 rdd、單位限定職稱
// ============================================================
(() => {
  const app = freshNew();
  const { sb, tok } = app;
  const pendingOf = (token) => { const r = post(sb, 'unitPending', {}, token); return r.ok ? r.data.people.map((x) => x.emp_no) : []; };
  // 主管們
  const smGF = mk(app, '十五甲', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const amGF = mk(app, '十五乙', { brand: 'mala', unit: 'mala-gf', title: 'am' });
  const amJS = mk(app, '十五丙', { brand: 'mzt', unit: 'mzt-js', title: 'am' });
  const osv = mk(app, '十五丁', { brand: 'mala', unit: 'mala-hq', title: 'osv' });
  const fm = mk(app, '十五戊', { brand: 'ck', unit: 'ck', title: 'fm' });
  const rdd = mk(app, '十五己', { brand: 'ck', unit: 'ck', title: 'rdd' });
  const ceo = mk(app, '十五庚', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'ceo' });
  // 待審
  const pSm = submitOnly(app, '十五辛', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const pAm = submitOnly(app, '十五壬', { brand: 'mala', unit: 'mala-gf', title: 'am' });
  const pFm = submitOnly(app, '十五癸', { brand: 'ck', unit: 'ck', title: 'fm' });
  const pRdd = submitOnly(app, '十五子', { brand: 'ck', unit: 'ck', title: 'rdd' });
  const pCkPt = submitOnly(app, '十五丑', { brand: 'ck', unit: 'ck', title: 'pt' });
  const pPt = submitOnly(app, '十五寅', { brand: 'mala', unit: 'mala-gf', title: 'pt' });

  ok(pendingOf(amGF.token).includes(pSm.emp) && pendingOf(amGF.token).includes(pPt.emp), '15 區經理審同店店長、同店計時');
  ok(!pendingOf(amJS.token).includes(pSm.emp) && !pendingOf(amJS.token).includes(pPt.emp), '15 ★區經理不能審別店（別品牌）的店長／同仁');
  ok(!pendingOf(smGF.token).includes(pAm.emp) && !pendingOf(smGF.token).includes(pSm.emp), '15 ★店長不能審區經理、也不能審同級店長');
  ok(pendingOf(smGF.token).includes(pPt.emp), '15 店長照舊審同店計時');
  ok(pendingOf(osv.token).includes(pAm.emp) && pendingOf(osv.token).includes(pSm.emp), '15 品牌辦公室（區督導）審區經理、店長');
  ok(!pendingOf(amGF.token).includes(pAm.emp), '15 ★區經理不能審同級區經理');
  ok(pendingOf(rdd.token).includes(pFm.emp) && pendingOf(rdd.token).includes(pCkPt.emp), '15 廚藝總監審廠長、央廚計時');
  ok(!pendingOf(fm.token).includes(pRdd.emp) && !pendingOf(fm.token).includes(pFm.emp) && pendingOf(fm.token).includes(pCkPt.emp), '15 ★廠長不能審廚藝總監／同級廠長；照舊審央廚計時');
  ok(pendingOf(ceo.token).includes(pRdd.emp) && pendingOf(ceo.token).includes(pFm.emp) && !pendingOf(ceo.token).includes(pCkPt.emp), '15 執行長以上審廚藝總監、廠長（不審央廚計時）');
  ok(!pendingOf(rdd.token).includes(pRdd.emp) && !pendingOf(rdd.token).includes(pSm.emp), '15 ★廚藝總監不審同級、不審門市');
  const ap = post(sb, 'unitApprove', { emp_no: pSm.emp }, amGF.token);
  ok(ap.ok && staffOf(app, pSm.emp).status === 'active' && staffOf(app, pSm.emp).title === 'sm', '15 區經理核准同店店長（unitApprove）', ap);
  ok(post(sb, 'unitApprove', { emp_no: pAm.emp }, smGF.token).ok === false, '15 ★店長呼叫核准區經理被擋');
  ok(post(sb, 'unitApprove', { emp_no: pRdd.emp }, fm.token).ok === false && post(sb, 'unitApprove', { emp_no: pFm.emp }, rdd.token).ok, '15 廠長核准廚藝總監被擋；廚藝總監核准廠長成功');
  // 衍生權限 platform.review、單位通訊錄：廠長／區經理／廚藝總監與店長相同
  [amGF, fm, rdd].forEach((m) => {
    const me = post(sb, 'me', {}, m.token);
    ok(me.ok && me.data.perms.includes('platform.review') && post(sb, 'myUnit', {}, m.token).ok, '15 ' + m.name + '：有待審核分頁與單位通訊錄');
  });
  // 驗證：中央工廠不能選店長／區經理，門市不能選廠長／廚藝總監（認領送出、後台改都擋）
  const claimErr = (o) => { const n = '十五驗' + (++pwSeq); post(sb, 'staffImport', { names: [n] }, tok); const lk = post(sb, 'claimLookup', { name: n }); return post(sb, 'claimSubmit', Object.assign({ name: n, emp_no: lk.data.emp_no, password: 'fake-staff-pw-x' + pwSeq }, PROF(o))); };
  ok(claimErr({ brand: 'ck', unit: 'ck', title: 'sm' }).ok === false && claimErr({ brand: 'ck', unit: 'ck', title: 'am' }).ok === false, '15 ★認領：中央工廠選店長／區經理 → 擋');
  ok(claimErr({ brand: 'mala', unit: 'mala-gf', title: 'fm' }).ok === false && claimErr({ brand: 'mala', unit: 'mala-gf', title: 'rdd' }).ok === false, '15 ★認領：門市選廠長／廚藝總監 → 擋');
  ok(post(sb, 'staffEdit', { emp_no: smGF.emp, brand: 'ck', unit: 'ck', title: 'sm' }, tok).ok === false && post(sb, 'staffEdit', { emp_no: smGF.emp, brand: 'mala', unit: 'mala-gf', title: 'fm' }, tok).ok === false, '15 ★後台改資料：ck 店長、門市廠長 → 擋');
  ok(post(sb, 'staffEdit', { emp_no: amJS.emp, brand: 'ck', unit: 'ck', title: 'rdd' }, tok).ok, '15 後台改資料：改到中央工廠廚藝總監可以');
  // 名單旗標：還掛中央工廠的店長 → title_ladder
  setStaff(app, smGF.emp, 'unit', 'ck'); setStaff(app, smGF.emp, 'brand', 'ck');
  const org = sb.stfReadOrg_();
  ok(sb.stfFlags_({ status: 'active', unit: 'ck', title: 'sm' }, org).join() === 'title_ladder' && sb.stfFlags_({ status: 'active', unit: 'mala-gf', title: 'fm' }, org).join() === 'title_ladder', '15 名單旗標：ck 店長、門市廠長 → 職稱需重選');
  ok(sb.stfReviewScope_(sb.stfFindByEmp_(smGF.emp).values, org) === null && sb.stfManagerScope_(sb.stfFindByEmp_(smGF.emp).values, org) === null, '15 ★掛在中央工廠的店長沒有審核／主管範圍');
  setStaff(app, smGF.emp, 'unit', 'mala-gf'); setStaff(app, smGF.emp, 'brand', 'mala');
  // orgOptions：單位限定給前端
  const opt = post(sb, 'orgOptions', {}).data;
  ok(JSON.stringify(opt.unit_titles) === JSON.stringify({ ck: ['pt', 'ft', 'fm', 'rdd'] }) && JSON.stringify(opt.title_units) === JSON.stringify({ fm: ['ck'], rdd: ['ck'] }), '15 orgOptions 帶 unit_titles／title_units', opt);
  ok(opt.titles.some((t) => t.code === 'am' && t.parent === 'store') && !opt.titles.some((t) => t.code === 'oam'), '15 orgOptions：am 在門市、oam 不列');
  // 權限：預設規則下 am／fm／rdd ≡ 店長；掛中央工廠的店長 → 空權限
  post(sb, 'permInit', {}, tok);
  const ctx = sb.permLoadCtx_(false);
  const permsOf = (emp) => sb.permComputeRow_(ctx, sb.stfFindByEmp_(emp).values, []).perms.join();
  const smPerms = permsOf(smGF.emp);
  ok(smPerms === 'audit.read.own,store.void' && permsOf(amGF.emp) === smPerms && permsOf(fm.emp) === smPerms && permsOf(rdd.emp) === smPerms, '15 權限：區經理／廠長／廚藝總監 ≡ 店長（稽核自己店、收支作廢）', [smPerms, permsOf(fm.emp)]);
  const ckSm = sb.stfFindByEmp_(fm.emp).values.slice(); ckSm[sb.STF_COL.title] = 'sm';
  ok(sb.permComputeRow_(ctx, ckSm, []).perms.length === 0, '15 ★權限：中央工廠的店長（切換後的舊資料）→ 空權限（fail closed）');
  const auditOwn = sb.permComputeRow_(ctx, sb.stfFindByEmp_(fm.emp).values, []).auditScope;
  ok(JSON.stringify(auditOwn) === JSON.stringify(['ck']), '15 廠長稽核範圍＝ck', auditOwn);
})();

// 單位限定只在 org 有專屬職稱時生效（切換前 org 沒有 fm／rdd → 中央工廠店長照舊）
(() => {
  const app = fresh();
  const { sb } = app;
  const org = sb.stfReadOrg_();
  ok(JSON.stringify(org.unitRules.unit_titles) === '{}' && sb.stfValidateOrg_(org, { brand: 'ck', unit: 'ck', dept: '', title: 'sm' }) === null, '15 切換前（org 沒有 fm／rdd）：中央工廠店長照舊有效');
  const ck = mk(app, '十五前', { brand: 'ck', unit: 'ck', title: 'sm' });
  const sc = sb.stfReviewScope_(sb.stfFindByEmp_(ck.emp).values, org);
  ok(sc && sc.kinds.join() === 'ck', '15 切換前：中央工廠店長照舊有 ck 審核資格');
  ok(sb.stfReviewNeed_(org, 'ck', '', 'sm').kind === 'ck' && sb.stfReviewNeed_(org, 'ck', '', 'sm').alt[0].kind === 'exec', '15 央廚 rank 3（店長／廠長）的 need：ck 更高職級或執行長以上');
})();

// orgUpgrade202610／orgRollback202610
const u2610 = (app, payload, t) => post(app.sb, 'orgUpgrade202610', payload || {}, t === undefined ? app.tok : t);
const r2610 = (app, t) => post(app.sb, 'orgRollback202610', {}, t === undefined ? app.tok : t);
function app2610() {
  const app = fresh();   // 2026-10-16 那一代（am 停用、oam 啟用、沒有 fm／rdd）
  const { sb, tok } = app;
  post(sb, 'permInit', {}, tok);
  // 模擬正式環境：perm_map 只有 2026-10-16 時的店長規則（拿掉新的 am／fm／rdd 預設），且 Eason 另外給店長 dorm.read
  const pm = app.sheets.perm_map._data;
  for (let i = pm.length - 1; i >= 1; i--) if (['am', 'fm', 'rdd'].includes(pm[i][3])) pm.splice(i, 1);
  pm.push(['R099', 'store', '', 'sm', 'dorm.read', 'TRUE', '', '']);
  const P = {};
  P.ckSm = mk(app, '調甲', { brand: 'ck', unit: 'ck', title: 'sm' });
  P.ckPt = mk(app, '調乙', { brand: 'ck', unit: 'ck', title: 'pt' });
  P.gfSm = mk(app, '調丙', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  P.oam = mk(app, '調丁', { brand: 'mala', unit: 'mala-hq', title: 'oam' });
  P.legacyAm = mk(app, '調戊', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  setStaff(app, P.legacyAm.emp, 'title', 'am');                // 2026-10-16 前留下的門市區經理（停用職稱）
  P.ckPend = mk(app, '調己', { brand: 'ck', unit: 'ck', title: 'pt' });
  setStaff(app, P.ckPend.emp, 'p_unit', 'ck'); setStaff(app, P.ckPend.emp, 'p_brand', 'ck'); setStaff(app, P.ckPend.emp, 'p_title', 'sm');   // 送出待審：升央廚店長
  app.P = P;
  return app;
}
const sheetDump = (app) => JSON.stringify(Object.keys(app.sheets).sort().map((k) => [k, app.sheets[k]._rows()]));
(() => {
  const app = app2610();
  const { sb, tok, hrTok, P } = app;
  ok(u2610(app, { dryrun: true }, hrTok).ok === false && r2610(app, hrTok).ok === false, '2610 ★人資呼叫升級／退回被擋（只有 admin）');
  const before = sheetDump(app);
  const dr = u2610(app, { dryrun: true });
  ok(dr.ok && dr.data.dryrun === true && sheetDump(app) === before && !app.props.ORG_UPGRADE_202610_STATE, '2610 dryrun 零寫入（所有分頁不變、沒有 state）', dr);
  const org = dr.data.org.map((o) => o.kind + ':' + o.code + ':' + o.field + ':' + o.to).sort();
  ok(JSON.stringify(org) === JSON.stringify(['title:am:active:TRUE', 'title:fm:row:added', 'title:oam:active:FALSE', 'title:rdd:row:added']), '2610 預覽：am 啟用、oam 停用、補 fm／rdd 兩列', org);
  const st = dr.data.staff.map((x) => x.emp_no + ':' + x.field + ':' + x.from + '>' + x.to).sort();
  ok(JSON.stringify(st) === JSON.stringify([P.ckSm.emp + ':title:sm>fm', P.ckPend.emp + ':p_title:sm>fm'].sort()), '2610 預覽：中央工廠店長（含送出待審的）→ 廠長，門市店長不動', st);
  ok(dr.data.staff[0].to_name === '廠長' && dr.data.staff[0].from_name === '店長', '2610 預覽帶職稱中文名');
  const pa = dr.data.perm.add.map((x) => x.title + ':' + x.perm).sort();
  ok(dr.data.perm.status === 'ok' && JSON.stringify(pa) === JSON.stringify(['am:audit.read.own', 'am:dorm.read', 'am:store.void', 'fm:audit.read.own', 'fm:dorm.read', 'fm:store.void', 'rdd:audit.read.own', 'rdd:dorm.read', 'rdd:store.void']), '2610 預覽：店長的現行規則（含人工加的 dorm.read）複製給 am／fm／rdd', pa);
  ok(dr.data.todo.some((t) => t.emp_no === P.oam.emp && t.flag === 'title_ladder') && !dr.data.todo.some((t) => t.emp_no === P.ckSm.emp), '2610 預覽 todo：品牌辦公室區經理 oam → 職稱需重選；改成廠長的人不列', dr.data.todo);
  ok(dr.data.resolved.some((t) => t.emp_no === P.legacyAm.emp && t.flag === 'title_ladder'), '2610 預覽 resolved：舊的門市區經理變合規', dr.data.resolved);

  const run = u2610(app, {});
  ok(run.ok && run.data.dryrun === false, '2610 執行成功', run);
  const o2 = sb.stfReadOrg_();
  ok(o2.title.am.active && !o2.title.oam.active && o2.title.fm.active && o2.title.fm.rank === 3 && o2.title.rdd.rank === 4 && o2.title.rdd.parent === 'store', '2610 org：am 啟用、oam 停用、fm／rdd 新增');
  ok(staffOf(app, P.ckSm.emp).title === 'fm' && staffOf(app, P.ckPend.emp).p_title === 'fm' && staffOf(app, P.ckPend.emp).title === 'pt' && staffOf(app, P.gfSm.emp).title === 'sm', '2610 同仁：ck 店長→廠長、待審 p_title→廠長、門市店長不動');
  ok(staffOf(app, P.ckSm.emp).unit === 'ck', '2610 單位不變（不觸發調店／打卡寫入）');
  const state = JSON.parse(app.props.ORG_UPGRADE_202610_STATE);
  ok(state.org_bak && app.sheets[state.org_bak] && app.sheets[state.stf_bak] && app.sheets[state.org_snap] && state.org_hash && state.perm_added.length === 9, '2610 備份分頁、快照、雜湊、補的規則編號都記下', state);
  ok(rowsOf(app, 'staff_log').filter((r) => r.event === 'org_upgrade_2610').length === 2, '2610 staff_log 每格一筆');
  const ctx = sb.permLoadCtx_(false);
  ok(sb.permComputeRow_(ctx, sb.stfFindByEmp_(P.ckSm.emp).values, []).perms.join() === 'audit.read.own,dorm.read,store.void', '2610 廠長權限＝店長的現行規則（含 dorm.read）');
  ok(sb.stfReviewScope_(sb.stfFindByEmp_(P.ckSm.emp).values, o2).kinds.join() === 'ck', '2610 廠長有 ck 審核資格');
  ok(u2610(app, { dryrun: true }).data.org.length === 0 && u2610(app, { dryrun: true }).data.staff.length === 0 && u2610(app, { dryrun: true }).data.perm.add.length === 0, '2610 再預覽：沒有任何差異');
  const again = u2610(app, {});
  ok(again.ok && again.data.backup === 'exists' && JSON.parse(app.props.ORG_UPGRADE_202610_STATE).perm_added.length === 9, '2610 重跑：不重建備份、不重複補規則');
  // 舊的 orgUpgrade2026 重跑不倒退 am／oam
  const old = post(sb, 'orgUpgrade2026', { dryrun: true }, tok);
  ok(old.ok && !old.data.org.some((x) => x.kind === 'title' && (x.code === 'am' || x.code === 'oam')), '2610 之後預覽 orgUpgrade2026：不會把 am 停用、oam 啟用改回去', old.data.org);
  ok(post(sb, 'orgRollback2026', {}, tok).ok === false && /職稱調整/.test(post(sb, 'orgRollback2026', {}, tok).error), '2610 ★還沒退回職稱調整時，orgRollback2026 拒絕');

  // 退回：org 被改過 → 拒絕
  const od = app.sheets.org._data;
  const fmRow = od.find((r) => r[0] === 'title' && r[1] === 'fm');
  fmRow[2] = '廠長（改）';
  const rbBad = r2610(app);
  ok(rbBad.ok === false && rbBad.data && rbBad.data.diff.some((d) => d.code === 'fm' && d.field === 'name'), '2610 ★退回：切換後 org 被改過 → 拒絕並列差異', rbBad);
  ok(staffOf(app, P.ckSm.emp).title === 'fm', '2610 被拒時同仁沒動');
  fmRow[2] = '廠長';
  // 同仁被改過 → 拒絕
  setStaff(app, P.ckSm.emp, 'title', 'pt');
  const rbStf = r2610(app);
  ok(rbStf.ok === false && rbStf.data.staff_diff.some((d) => d.emp_no === P.ckSm.emp && d.actual === 'pt') && sb.stfReadOrg_().title.fm, '2610 ★退回：受影響同仁被改過 → 拒絕、org 沒動', rbStf);
  setStaff(app, P.ckSm.emp, 'title', 'fm');
  // 切換後才被設成廚藝總監的人 → 退回後列孤兒
  const later = mk(app, '調庚', { brand: 'ck', unit: 'ck', title: 'rdd' });
  const rb = r2610(app);
  ok(rb.ok && rb.data.staff_restored === 2 && rb.data.perm_disabled.length === 9, '2610 退回成功：同仁 2 格、停用 9 條規則', rb);
  ok(orgSnap(app).join() === nonBlank(app.sheets[state.org_bak]._rows().slice(1)).join(), '2610 退回後 org 與備份逐格相同');
  ok(staffOf(app, P.ckSm.emp).title === 'sm' && staffOf(app, P.ckPend.emp).p_title === 'sm', '2610 退回：廠長→店長、待審 p_title→店長');
  ok(rb.data.orphans.some((o) => o.emp_no === later.emp && o.title === 'rdd'), '2610 退回：之後才設的廚藝總監列孤兒（只列不改）', rb.data.orphans);
  ok(app.sheets.perm_map._rows().filter((r) => state.perm_added.includes(r[0])).every((r) => r[5] === 'FALSE'), '2610 退回：補的規則 active＝FALSE');
  ok(!app.props.ORG_UPGRADE_202610_STATE && app.sheets[state.org_bak], '2610 退回：state 清掉、備份分頁保留');
  const ctx2 = sb.permLoadCtx_(false);
  ok(sb.permComputeRow_(ctx2, sb.stfFindByEmp_(P.ckSm.emp).values, []).perms.join() === 'audit.read.own,dorm.read,store.void', '2610 退回後店長權限照舊');
  ok(r2610(app).ok === false, '2610 沒有紀錄時退回 → 回錯');
  // 退回後可再升級（新的備份名）
  setStaff(app, later.emp, 'title', 'pt');
  const re = u2610(app, {});
  ok(re.ok && JSON.parse(app.props.ORG_UPGRADE_202610_STATE).org_bak !== state.org_bak && staffOf(app, P.ckSm.emp).title === 'fm', '2610 退回後可再升級（新備份）', re);
})();
(() => {
  // perm_map 沒初始化：只改 org／同仁，權限規則交給之後的 permInit 預設
  const app = fresh();
  const ck = mk(app, '調辛', { brand: 'ck', unit: 'ck', title: 'sm' });
  const dr = u2610(app, { dryrun: true });
  ok(dr.ok && dr.data.perm.status === 'not_inited' && dr.data.perm.add.length === 0, '2610 perm_map 沒初始化：預覽標 not_inited、不補規則', dr.data.perm);
  ok(u2610(app, {}).ok && staffOf(app, ck.emp).title === 'fm', '2610 perm_map 沒初始化也能升級');
  // Code.gs 登錄
  const src = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  ok(/CODE_ALLOWED_ACTIONS = \[[\s\S]*?'orgUpgrade202610', 'orgRollback202610'[\s\S]*?\];/.test(src) && /orgUpgrade202610: 1, orgRollback202610: 1/.test(src) && /case 'orgUpgrade202610'/.test(src) && /case 'orgRollback202610'/.test(src), '2610 兩個 action 在白名單、寫入鎖、分派表');
})();

// ── 第 16 節（2026-10-23）：名稱調整 orgRename202610／orgRenameRollback202610 ──
const n2610 = (app, payload, t) => post(app.sb, 'orgRename202610', payload || {}, t === undefined ? app.tok : t);
const nr2610 = (app, t) => post(app.sb, 'orgRenameRollback202610', {}, t === undefined ? app.tok : t);
const orgName = (app, kind, code) => orgRow(app, kind, code)[2];
function setOrgName(app, kind, code, v) { const d = app.sheets.org._data; d.find((r) => r[0] === kind && r[1] === code)[2] = v; }
/** 模擬 2026-10-23 之前的正式環境：加盟招商部、部門主管（rdd 列依需要由呼叫端補，名稱研發總監） */
function oldNames(app, withRdd) {
  setOrgName(app, 'dept', 'franchise', '加盟招商部'); setOrgName(app, 'title', 'hm', '部門主管');
  if (withRdd && !app.sheets.org._data.some((r) => r[1] === 'rdd')) app.sheets.org._data.push(['title', 'rdd', '研發總監', 'store', '', 4, 8, 'TRUE']);
  return app;
}
(() => {
  // 新預設（setupStaff）：三個名稱已是新名
  const nn = freshNew();
  ok(orgName(nn, 'dept', 'franchise') === '加盟部' && orgName(nn, 'title', 'hm') === '總監' && orgName(nn, 'title', 'rdd') === '廚藝總監', '16 新預設：加盟部／總監／廚藝總監');
  // 模擬正式環境：舊名（rdd 是 10/20 升級時補的，名稱研發總監）
  const app = oldNames(fresh(), true);
  ok(orgName(app, 'dept', 'franchise') === '加盟招商部' && orgName(app, 'title', 'hm') === '部門主管', '16 前提：舊名');
  ok(n2610(app, { dryrun: true }, app.hrTok).ok === false && nr2610(app, app.hrTok).ok === false && n2610(app, {}, app.hrTok).ok === false, '16 ★非 admin（人資）預覽／執行／退回都被擋');
  ok(n2610(app, { dryrun: true }, '').ok === false, '16 無 token 被擋');
  const before = sheetDump(app);
  const dr = n2610(app, { dryrun: true });
  ok(dr.ok && dr.data.dryrun === true && dr.data.changes.length === 4 && dr.data.skipped.length === 0 && sheetDump(app) === before, '16 dryrun 預覽四筆、零寫入（org／staff_log 都沒動）', dr);
  ok(dr.data.changes.map((c) => c.code + ':' + c.from + '>' + c.to).sort().join() === ['franchise:加盟招商部>加盟部', 'hm:部門主管>總監', 'rdd:研發總監>廚藝總監', 'ck:中央工廠>研發部'].sort().join(), '16 預覽內容正確');
  const orgBefore = JSON.stringify(orgRows(app));
  const run = n2610(app, {});
  ok(run.ok && run.data.dryrun === false && run.data.changes.length === 4, '16 執行成功', run);
  ok(orgName(app, 'dept', 'franchise') === '加盟部' && orgName(app, 'title', 'hm') === '總監' && orgName(app, 'title', 'rdd') === '廚藝總監' && orgName(app, 'brand', 'ck') === '研發部' && orgName(app, 'unit', 'ck') === '中央工廠（央廚）', '16 四格名稱已改（ck 單位名稱不動）');
  // 只動名稱欄：其他欄逐格相同
  const strip = (rows) => JSON.stringify(rows.map((r) => r.map((v, i) => (i === 2 ? '' : v))));
  ok(strip(JSON.parse(orgBefore)) === strip(orgRows(app)), '16 ★只改名稱那一格（代碼、職級、順序、啟用等其他格逐格相同）');
  const logs = rowsOf(app, 'staff_log').filter((r) => r.event === 'org_rename_2610');
  ok(logs.length === 4 && logs.every((l) => l.by === 'u001' || String(l.by).length > 0), '16 staff_log 每格一筆', logs);
  // 重跑：全部略過、沒有新紀錄
  const again = n2610(app, {});
  ok(again.ok && again.data.changes.length === 0 && again.data.skipped.length === 4 && rowsOf(app, 'staff_log').filter((r) => r.event === 'org_rename_2610').length === 4, '16 重跑冪等：全部略過、不重複寫紀錄', again);
  // 權限與審核不受影響：階梯與職級沒變
  const o3 = app.sb.stfReadOrg_();
  ok(o3.title.hm.rank === 2 && o3.title.hm.parent === 'hq' && o3.title.rdd.rank === 4 && o3.dept.franchise.parent === 'dzy-hq', '16 職級／階梯／父層不變');
  // 退回
  const rb = nr2610(app);
  ok(rb.ok && rb.data.changes.length === 4 && orgName(app, 'brand', 'ck') === '中央工廠' && orgName(app, 'dept', 'franchise') === '加盟招商部' && orgName(app, 'title', 'hm') === '部門主管' && orgName(app, 'title', 'rdd') === '研發總監', '16 退回：四格改回舊名', rb);
  ok(rowsOf(app, 'staff_log').filter((r) => r.event === 'org_rename_2610_rollback').length === 4, '16 退回有 staff_log');
  const rb2 = nr2610(app);
  ok(rb2.ok && rb2.data.changes.length === 0 && rb2.data.skipped.length === 4, '16 退回重跑冪等');
  // 再改一次、然後某格被人改成別的 → 退回拒絕、整批不動
  ok(n2610(app, {}).ok, '16 退回後可再調整');
  setOrgName(app, 'title', 'hm', '部門經理');
  const snap = JSON.stringify(orgRows(app));
  const rbBad = nr2610(app);
  ok(rbBad.ok === false && rbBad.data && rbBad.data.bad.length === 1 && rbBad.data.bad[0].code === 'hm' && rbBad.data.bad[0].actual === '部門經理' && JSON.stringify(orgRows(app)) === snap, '16 ★退回：調整後又被改成別的名稱 → 整批拒絕、什麼都沒動', rbBad);
  // 執行時遇到非預期名稱 → 整批拒絕（包含另外兩列也不改）
  const app2 = oldNames(fresh(), true);
  setOrgName(app2, 'title', 'hm', '某某主管');
  const snap2 = JSON.stringify(orgRows(app2));
  const bad = n2610(app2, {});
  ok(bad.ok === false && bad.data.bad.length === 1 && bad.data.bad[0].code === 'hm' && JSON.stringify(orgRows(app2)) === snap2, '16 ★遇到非預期名稱 → 整批拒絕、其他兩列也沒改', bad);
  ok(n2610(app2, { dryrun: true }).ok === false, '16 預覽同樣列出拒絕原因');
  // 找不到 rdd 列（沒做過 10/20 職稱調整）→ 拒絕
  const app3 = oldNames(fresh(), false);
  const ri3 = app3.sheets.org._data.findIndex((r) => r[1] === 'rdd');
  if (ri3 >= 0) app3.sheets.org._data.splice(ri3, 1);
  const miss = n2610(app3, {});
  ok(miss.ok === false && miss.data.bad.some((b) => b.code === 'rdd'), '16 org 沒有 rdd 列 → 拒絕', miss);
  // 10/20 升級常數已用新名：新補的 rdd 直接是廚藝總監，之後改名是冪等略過
  const app4 = oldNames(app2610(), false);
  ok(u2610(app4, {}).ok && orgName(app4, 'title', 'rdd') === '廚藝總監', '16 orgUpgrade202610 新補的 rdd 直接用廚藝總監');
  const r4 = n2610(app4, {});
  ok(r4.ok && r4.data.changes.length === 3 && r4.data.skipped.length === 1 && r4.data.skipped[0].code === 'rdd', '16 升級後改名：rdd 略過、其餘三格照改', r4);
  // Code.gs 登錄
  const src = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  ok(/CODE_ALLOWED_ACTIONS = \[[\s\S]*?'orgRename202610', 'orgRenameRollback202610'[\s\S]*?\];/.test(src) && /orgRename202610: 1, orgRenameRollback202610: 1/.test(src) && /case 'orgRename202610'/.test(src) && /case 'orgRenameRollback202610'/.test(src), '16 兩個 action 在白名單、寫入鎖、分派表');
  ok(!/READ_ACTIONS[^\n]*orgRename/.test(fs.readFileSync(path.join(DIR, '..', '..', 'platform', 'dryrun.js'), 'utf8')), '16 不在任何讀取清單');
})();

// ── 第 17 節（2026-10-23）：新增品牌發展部 orgAddBranddev202610／orgAddBranddevRollback202610 ──
const b2610 = (app, payload, t) => post(app.sb, 'orgAddBranddev202610', payload || {}, t === undefined ? app.tok : t);
const br2610 = (app, t) => post(app.sb, 'orgAddBranddevRollback202610', {}, t === undefined ? app.tok : t);
const bdRows = (app) => app.sheets.org._data.filter((r) => r[0] === 'dept' && r[1] === 'branddev');
/** 模擬 2026-10-23 之前的正式環境：org 沒有 branddev 列 */
function noBranddev(app) { const d = app.sheets.org._data; for (let i = d.length - 1; i >= 1; i--) if (d[i][0] === 'dept' && d[i][1] === 'branddev') d.splice(i, 1); return app; }
(() => {
  // 種子
  const nn = freshNew();
  const sd = bdRows(nn);
  ok(sd.length === 1 && sd[0][2] === '品牌發展部' && sd[0][3] === 'dzy-hq' && Number(sd[0][6]) === 11 && String(sd[0][7]).toUpperCase() === 'TRUE', '17 種子（setupStaff）有 branddev：品牌發展部、dzy-hq、order 11、啟用');
  const app = noBranddev(fresh());
  ok(bdRows(app).length === 0, '17 前提：正式環境沒有 branddev 列');
  ok(b2610(app, { dryrun: true }, app.hrTok).ok === false && br2610(app, app.hrTok).ok === false && b2610(app, {}, app.hrTok).ok === false, '17 ★非 admin（人資）預覽／執行／退回都被擋');
  ok(b2610(app, { dryrun: true }, '').ok === false, '17 無 token 被擋');
  const before = sheetDump(app);
  const dr = b2610(app, { dryrun: true });
  ok(dr.ok && dr.data.dryrun === true && dr.data.action === 'add' && dr.data.dept.order === 11 && sheetDump(app) === before, '17 dryrun 預覽新增一列、零寫入', dr);
  const run = b2610(app, {});
  ok(run.ok && run.data.dryrun === false && run.data.action === 'add', '17 執行成功', run);
  const ro = bdRows(app);
  ok(ro.length === 1 && ro[0].slice(0, 8).join('|') === 'dept|branddev|品牌發展部|dzy-hq|||11|TRUE', '17 新增的列八欄正確（order＝現有最大 10 + 1）', ro);
  ok(app.sb.stfReadOrg_().dept.branddev.active === true && post(app.sb, 'orgOptions', {}).data.depts.some((d) => d.code === 'branddev'), '17 orgOptions 部門選單出現品牌發展部');
  const logs = rowsOf(app, 'staff_log').filter((r) => r.event === 'org_add_branddev_2610');
  ok(logs.length === 1, '17 staff_log 一筆', logs);
  // 重跑冪等
  const again = b2610(app, {});
  ok(again.ok && again.data.action === 'skip' && bdRows(app).length === 1 && rowsOf(app, 'staff_log').filter((r) => r.event === 'org_add_branddev_2610').length === 1, '17 重跑冪等：略過、不重複列、不重複紀錄', again);
  // 與種子冪等：種子已有的環境直接略過
  const seeded = b2610(nn, {});
  ok(seeded.ok && seeded.data.action === 'skip' && bdRows(nn).length === 1, '17 種子已有 branddev：apply 略過', seeded);
  // 新增後可當一般總部部門用（部門同仁 hs 在 branddev、審核由 hm）
  const hs = mk(app, '品發甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'branddev', title: 'hs' });
  ok(staffOf(app, hs.emp).dept === 'branddev', '17 同仁可選品牌發展部（brand dzy／unit dzy-hq／hs）');
  // 退回：有人在部門 → 拒絕只列 emp_no
  const snapR = JSON.stringify(orgRows(app));
  const rbNo = br2610(app);
  ok(rbNo.ok === false && rbNo.data.members.join() === hs.emp && JSON.stringify(rbNo.data).indexOf('品發甲') === -1 && JSON.stringify(orgRows(app)) === snapR, '17 ★退回：有人主要部門是 branddev → 拒絕、只列 emp_no（不含姓名）、org 不動', rbNo);
  // 兼任也算
  setStaff(app, hs.emp, 'dept', 'it');
  const ex = post(app.sb, 'staffEdit', { emp_no: hs.emp, extra_depts: ['branddev'] }, app.hrTok);
  ok(ex.ok, '17 前提：改設兼任品牌發展部', ex);
  const rbEx = br2610(app);
  ok(rbEx.ok === false && rbEx.data.members.join() === hs.emp, '17 ★退回：兼任 branddev 也拒絕', rbEx);
  post(app.sb, 'staffEdit', { emp_no: hs.emp, extra_depts: [] }, app.hrTok);
  // 送出待審的 p_dept 也算
  const pend = submitOnly(app, '品發乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'branddev', title: 'hs' });
  const rbP = br2610(app);
  ok(rbP.ok === false && rbP.data.members.join() === pend.emp, '17 ★退回：送出待審 p_dept＝branddev 也拒絕', rbP);
  setStaff(app, pend.emp, 'p_dept', ''); setStaff(app, pend.emp, 'status', 'disabled');
  // 沒人了 → 退回成功（停用、不刪列、只動啟用那一格）
  const orgB = JSON.stringify(orgRows(app));
  const rb = br2610(app);
  ok(rb.ok && rb.data.action === 'deactivate' && bdRows(app).length === 1 && String(bdRows(app)[0][7]).toUpperCase() === 'FALSE', '17 退回成功：branddev 停用、列還在', rb);
  const strip = (rows) => JSON.stringify(rows.map((r) => r.map((v, i) => (i === 7 ? '' : v))));
  ok(strip(JSON.parse(orgB)) === strip(orgRows(app)), '17 ★只改啟用那一格（其他格逐格相同）');
  ok(rowsOf(app, 'staff_log').filter((r) => r.event === 'org_add_branddev_2610_rollback').length === 1, '17 退回有 staff_log');
  ok(!post(app.sb, 'orgOptions', {}).data.depts.some((d) => d.code === 'branddev'), '17 退回後部門選單不再列出');
  const rb2 = br2610(app);
  ok(rb2.ok && rb2.data.action === 'skip', '17 退回重跑冪等');
  // 退回後再新增 → 重新啟用
  const re = b2610(app, {});
  ok(re.ok && re.data.action === 'reactivate' && bdRows(app).length === 1 && String(bdRows(app)[0][7]).toUpperCase() === 'TRUE', '17 退回後再新增：重新啟用同一列、不重複', re);
  // 完全沒有列時退回：略過
  const app2 = noBranddev(fresh());
  const rb3 = br2610(app2);
  ok(rb3.ok && rb3.data.action === 'skip' && bdRows(app2).length === 0, '17 沒有 branddev 列時退回：略過');
  // 衝突：同代碼但名稱不同／父層不同／兩者 → 整批拒絕並列出
  const app3 = noBranddev(fresh());
  app3.sheets.org._data.push(['dept', 'branddev', '別的名字', 'dzy-hq', '', '', 11, 'TRUE']);
  const snap3 = JSON.stringify(orgRows(app3));
  const c1 = b2610(app3, {});
  ok(c1.ok === false && c1.data.bad.length === 1 && c1.data.bad[0].code === 'branddev' && c1.data.bad[0].actual.indexOf('別的名字') === 0 && JSON.stringify(orgRows(app3)) === snap3, '17 ★衝突（名稱不同）：apply 拒絕並列出、org 不動', c1);
  ok(b2610(app3, { dryrun: true }).ok === false && br2610(app3).ok === false && JSON.stringify(orgRows(app3)) === snap3, '17 衝突：預覽與退回同樣拒絕、org 不動');
  const app4 = noBranddev(fresh());
  app4.sheets.org._data.push(['dept', 'branddev', '品牌發展部', 'mala', '', '', 11, 'TRUE']);
  ok(b2610(app4, {}).ok === false && bdRows(app4)[0][3] === 'mala', '17 衝突（父層不同）：拒絕、不改');
  // 與種子同名同父層但被別人停用 → 視為退回狀態，apply 重新啟用（不算衝突）
  // order 取現有最大 + 1（現有 order 若有跳號也接在最後）
  const app5 = noBranddev(fresh());
  app5.sheets.org._data.find((r) => r[0] === 'dept' && r[1] === 'mgmt')[6] = 15;
  ok(b2610(app5, { dryrun: true }).data.dept.order === 16 && b2610(app5, {}).ok && Number(bdRows(app5)[0][6]) === 16, '17 order＝現有部門最大值 + 1');
  // Code.gs 登錄
  const src = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  ok(/CODE_ALLOWED_ACTIONS = \[[\s\S]*?'orgAddBranddev202610', 'orgAddBranddevRollback202610'[\s\S]*?\];/.test(src) && /orgAddBranddev202610: 1, orgAddBranddevRollback202610: 1/.test(src) && /case 'orgAddBranddev202610'/.test(src) && /case 'orgAddBranddevRollback202610'/.test(src), '17 兩個 action 在白名單、寫入鎖、分派表');
  ok(!/READ_ACTIONS[^\n]*orgAddBranddev/.test(fs.readFileSync(path.join(DIR, '..', '..', 'platform', 'dryrun.js'), 'utf8')), '17 不在任何讀取清單');
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
