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
  ok(!org.title.os && !org.title.osv && !org.title.obd, 'T1 不新增 os／osv／obd（第 12 節）');
  ok(org.title.sv.name === '區督導' && org.title.sv.rank === 5 && org.title.bd.rank === 6 && org.title.bd.name === '品牌總監', 'T1 sv 改名「區督導」、rank 5；bd 品牌總監 rank 6');
  ok(sb.STF_UNIT_VIEW_MIN_RANK.office === 5 && sb.STF_UNIT_VIEW_MIN_RANK.store === 3 && sb.STF_UNIT_VIEW_MIN_RANK.hq === 2, 'T1 STF_UNIT_VIEW_MIN_RANK.office＝5');
  ok(sb.stfTitleLadder_(org.unit['mala-hq']) === 'store' && sb.stfTitleLadder_(org.unit['dzy-hq']) === 'hq' && sb.stfTitleLadder_(org.unit['mala-gf']) === 'store' && sb.stfTitleLadder_(null) === 'store' && sb.stfTitleLadder_({ ladder: '' }) === 'store', 'T1 stfTitleLadder_：office→store、hq→hq、空白→store');

  const v = (o) => sb.stfValidateOrg_(org, Object.assign({ brand: 'mala', unit: 'mala-hq', dept: '', title: 'sv' }, o));
  ok(v({}) === null, 'T1 正：品牌辦公室選門市職稱（區督導）通過');
  ok(['pt', 'ft', 'sm', 'am', 'sv', 'bd'].every((t) => v({ title: t }) === null), 'T1 正：品牌辦公室六級職稱都通過');
  ok(v({ title: 'hs' }) !== null && v({ title: 'hm' }) !== null && v({ title: 'ceo' }) !== null, 'T1 反：品牌辦公室選總部職稱 → 回錯');
  ok(v({ dept: 'it' }) !== null, 'T1 反：品牌辦公室填部門 → 回錯');
  ok(sb.stfValidateOrg_(org, { brand: 'yiwu', unit: 'yiwu-hq', dept: '', title: 'am' }) === null, 'T1 正：一悟品牌辦公室可選 am');
  ok(sb.stfValidateOrg_(org, { brand: 'mzt', unit: 'mzt-mc', dept: '', title: 'pt' }) !== null, 'T1 反：停用的門市（mzt-mc）不能選');
  ok(sb.stfValidateOrg_(org, { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'sm' }) !== null, 'T1 反：總部單位仍不能選門市職稱');

  const opt = post(sb, 'orgOptions', {}).data;
  ok(opt.units.find((u) => u.code === 'mala-hq').ladder === 'office' && !opt.units.some((u) => u.code === 'mzt-mc'), 'T1 orgOptions：office 單位帶 ladder、停用單位不列');

  // 單位通訊錄：office 區督導(rank5)有、店長級(rank3)沒有
  const sv = mk(app, '測試甲', { brand: 'mala', unit: 'mala-hq', title: 'sv' });
  const am = mk(app, '測試乙', { brand: 'mala', unit: 'mala-hq', title: 'am' });
  const staff1 = mk(app, '測試丙', { brand: 'mala', unit: 'mala-hq', title: 'ft' });
  const mu = post(sb, 'myUnit', {}, sv.token);
  ok(mu.ok && mu.data.unit_name === '小辛辣品牌辦公室' && mu.data.people.length === 3, 'T1 正：品牌辦公室區督導有單位通訊錄', mu);
  ok(post(sb, 'myUnit', {}, am.token).ok === false, 'T1 反：品牌辦公室區經理(rank4)沒有單位通訊錄');
  ok(post(sb, 'myUnit', {}, staff1.token).ok === false, 'T1 反：品牌辦公室正職沒有單位通訊錄');
  // 門市店長仍有、沒受影響
  const smgr = mk(app, '測試丁', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  ok(post(sb, 'myUnit', {}, smgr.token).ok, 'T1 門市店長通訊錄不受影響');
  // 未知 ladder → 無主管權限
  app.sheets.org._data.find((r) => r[1] === 'mala-hq')[4] = 'weird';
  ok(sb.stfManagerScope_(sb.stfFindByEmp_(sv.emp).values, sb.stfReadOrg_()) === null, 'T1 未知 ladder 一律當無主管權限');
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
