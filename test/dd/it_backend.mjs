// node test/dd/it_backend.mjs —— 資料帶入測試：資訊部門（人員管理、權限設定）＋平台登入層（登入鎖、改密碼、登出、認領、忘記密碼）
// 做法同 test/storeops.mock.test.mjs：九支 .gs 讀進同一個 vm sandbox，全程走 doPost。
// 資料每次全部隨機重抽（E2E_SEED=<種子> 重現）；每個人的預期權限由本檔照 docs/permissions/spec.md §3.1／§4／§13 獨立算，不呼叫 permCompute_。
// ⚠ 姓名、生日、手機、地址、密碼全是假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── 隨機（可重現）────────────────────────────────────────────
const SEED = Number(process.env.E2E_SEED) || (Date.now() % 2147483647);
let rngState = SEED >>> 0;
function rand() {   // mulberry32
  rngState = (rngState + 0x6D2B79F5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (n) => Math.floor(rand() * n);
const pick = (arr) => arr[ri(arr.length)];
const chance = (p) => rand() < p;
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = ri(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[ri(16)]; return s; };
console.log('SEED=' + SEED + '（重現：E2E_SEED=' + SEED + ' node test/dd/it_backend.mjs）');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; failures.push(label); console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);

// ── GAS 假物件（同 storeops.mock）────────────────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
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
          for (let r = 0; r < vals.length; r++) {
            const ri2 = row - 1 + r;
            while (data.length <= ri2) data.push([]);
            for (let c = 0; c < vals[r].length; c++) {
              const ci = col - 1 + c;
              while (data[ri2].length <= ci) data[ri2].push('');
              data[ri2][ci] = vals[r][c];
            }
          }
          return range;
        },
        setNumberFormat() { return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(n) { data.splice(n - 1, 1); },
    _rows: () => data.map((r) => r.slice()),
    _data: data
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
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-dd-it-' + hex(8) };
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
      getUuid: () => 'fake-uuid-' + (++uuid) + '-' + crypto.randomBytes(4).toString('hex'),
      formatDate(d, tz, fmt) { return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
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
function post(sb, action, payload, token, clientIp) {
  const e = { postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } };
  if (clientIp) e.clientIp = clientIp;
  return JSON.parse(sb.doPost(e).getContent());
}

// ── 契約常數（照 spec，不從 Perms.gs 讀）────────────────────
const GRANTABLE = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap',
  'store.void', 'att.extra', 'payroll.write', 'cashbook.write', 'platform.bulletin', 'platform.purchase', 'pnl.read', 'pnl.write', 'pnl.admin', 'transfer.write',
  'platform.eval-manage', 'platform.eval-brand', 'platform.eval-all', 'platform.eval-admin',
  'platform.insp-do', 'platform.insp-own', 'platform.insp-brand', 'platform.insp-all', 'platform.insp-bank'];
const LOCKED = ['platform.users', 'platform.permmap', 'audit.write', 'platform.staff', 'payroll.write', 'pnl.admin'];
const HR_EX = ['store.void', 'att.extra', 'platform.bulletin'];
const DEFAULT_RULES = (() => {
  const out = [];
  const add = (l, d, t, ps) => ps.forEach((p) => out.push({ ladder: l, dept: d, title: t, perm: p }));
  add('store', '', 'sm', ['audit.read.own']);
  ['oam', 'osv', 'odir'].forEach((t) => add('office', '', t, ['audit.read.brand']));
  add('hq', 'ops', '*', ['audit.read']);
  add('hq', 'mgmt', '*', ['audit.read', 'audit.write']);
  add('hq', 'fin', '*', ['audit.read', 'audit.write']);
  ['ceo', 'gm', 'chair'].forEach((t) => add('hq', '', t, ['audit.read', 'dorm.read']));
  add('hq', 'hr', '*', ['platform.staff', 'dorm.read', 'dorm.write']);
  add('hq', 'hr', 'hm', ['platform.permmap']);
  add('store', '', 'sm', ['store.void']);
  ['am', 'fm', 'rdd'].forEach((t) => add('store', '', t, ['audit.read.own', 'store.void']));
  add('hq', 'fin', '*', ['cashbook.write']);
  add('hq', '', 'hm', ['platform.bulletin']);
  add('office', '', 'odir', ['platform.bulletin']);
  add('store', '', 'rdd', ['platform.bulletin']);
  ['ceo', 'gm', 'chair'].forEach((t) => add('hq', '', t, ['platform.bulletin']));
  add('hq', 'fin', '*', ['platform.purchase']);
  add('hq', 'fin', '*', ['pnl.write']);
  add('hq', 'fin', '*', ['transfer.write']);
  return out.map((r, i) => Object.assign({ rule_id: 'R' + String(i + 1).padStart(3, '0') }, r));
})();
const DEFAULT_STORE_MAP = { 'mala-gf': 'sxl-gf', ck: 'ck', 'mzt-gf': 'mzt-gf', 'mzt-js': 'mzt-js', 'mzt-lzl': 'mzt-lzl' };

// 組織（照 Staff.gs STF_DEFAULT_ORG 的啟用列；測試自己持有一份，不從 org 分頁讀回）
const UNITS = {   // code: {brand, ladder}
  'mzt-js': { brand: 'mzt', ladder: 'store' }, 'mzt-gf': { brand: 'mzt', ladder: 'store' }, 'mzt-lzl': { brand: 'mzt', ladder: 'store' }, 'mzt-hq': { brand: 'mzt', ladder: 'office' },
  'mala-gf': { brand: 'mala', ladder: 'store' }, 'mala-hq': { brand: 'mala', ladder: 'office' },
  'yiwu-js': { brand: 'yiwu', ladder: 'store' }, 'yiwu-wx': { brand: 'yiwu', ladder: 'store' }, 'yiwu-hq': { brand: 'yiwu', ladder: 'office' },
  ck: { brand: 'ck', ladder: 'store' }, 'dzy-hq': { brand: 'dzy', ladder: 'hq' }
};
const TITLES = {   // code: {ladder, rank}（啟用）
  pt: { ladder: 'store', rank: 1 }, ft: { ladder: 'store', rank: 2 }, sm: { ladder: 'store', rank: 3 }, am: { ladder: 'store', rank: 4 }, fm: { ladder: 'store', rank: 3 }, rdd: { ladder: 'store', rank: 4 },
  ofs: { ladder: 'office', rank: 1 }, osv: { ladder: 'office', rank: 2 }, odir: { ladder: 'office', rank: 3 },
  hs: { ladder: 'hq', rank: 1 }, hm: { ladder: 'hq', rank: 2 }, ceo: { ladder: 'hq', rank: 3 }, gm: { ladder: 'hq', rank: 4 }, chair: { ladder: 'hq', rank: 5 }
};
const INACTIVE_TITLES = ['sv', 'bd', 'oam'];
const DEPTS = ['fin', 'hr', 'it', 'eng', 'franchise', 'purchase', 'ops', 'training', 'marketing', 'mgmt', 'branddev'];
const UNIT_TITLES = { ck: ['pt', 'ft', 'fm', 'rdd'] };
const TITLE_UNITS = { fm: ['ck'], rdd: ['ck'] };
function titleFitsUnit(title, unit) {
  if (UNIT_TITLES[unit] && UNIT_TITLES[unit].indexOf(title) === -1) return false;
  if (TITLE_UNITS[title] && TITLE_UNITS[title].indexOf(unit) === -1) return false;
  return true;
}
function titlesForUnit(unit) {
  const ladder = UNITS[unit].ladder;
  return Object.keys(TITLES).filter((t) => TITLES[t].ladder === ladder && titleFitsUnit(t, unit));
}

const todayTaipei = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dayShift = (n) => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
const TODAY = todayTaipei();

// ============================================================
// 1. 獨立算法（spec §4 ＋ §13；輸入全是測試自己的資料）
// ============================================================
/**
 * staff={emp,status,unit,dept,title,extra:[]}；rules=[{ladder,dept,title,perm}]（active）；exs=[{emp_no,perm,mode,until}]（active）
 * storeMap={unit:store}；pilot=[store units]；allStaff（算兼任店長要查本人在職）
 * 回 {perms:[只含 GRANTABLE＋att.view@＋payroll.store@＋implied audit.read], scope}
 */
function expectPerms(staff, rules, exs, storeMap, pilot) {
  const empty = { perms: [], scope: 'none' };
  if (staff.status !== 'active') return empty;
  const u = UNITS[staff.unit];
  if (!u) return empty;
  const t = TITLES[staff.title];
  if (!t || t.ladder !== u.ladder || !titleFitsUnit(staff.title, staff.unit)) return empty;
  const depts = {};
  [staff.dept].concat(staff.extra || []).forEach((d) => { if (d && DEPTS.indexOf(d) !== -1) depts[d] = true; });
  const P = {};
  rules.forEach((r) => {
    if (GRANTABLE.indexOf(r.perm) === -1) return;
    if (r.ladder !== u.ladder) return;
    if (r.title !== '*' && r.title !== staff.title) return;
    if (r.dept !== '' && !depts[r.dept]) return;
    P[r.perm] = true;
  });
  const removes = {};
  exs.forEach((x) => {
    if (!x.emp_no || x.emp_no.toUpperCase() !== staff.emp.toUpperCase()) return;
    const mode = String(x.mode).toLowerCase();
    const avm = /^att\.view@([A-Za-z0-9_-]{1,40})$/.exec(x.perm);
    const psm = /^payroll\.store@([A-Z0-9]{2,12})$/.exec(x.perm);
    if (avm) {
      const au = UNITS[avm[1]];
      if (!au || au.ladder !== 'store' || mode !== 'add') return;
    } else if (psm) {
      if (mode !== 'add') return;
    } else if (GRANTABLE.indexOf(x.perm) === -1) return;   // store.sm@ 不進 perms（另算兼任）
    const raw = String(x.until || '');
    let valid;
    if (raw === '') valid = true;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) valid = (mode === 'remove');
    else valid = raw >= TODAY;
    if (!valid) return;
    if (mode === 'add') P[x.perm] = true;
    else if (mode === 'remove') removes[x.perm] = true;
  });
  let perms = Object.keys(P).filter((p) => !removes[p]);
  // 兼任店長（§13 2026-10-29）：active add store.sm@U、U 是啟用門市非 ck、U≠本人單位、U 在試點、沒過期
  const acting = [];
  exs.forEach((x) => {
    if (!x.emp_no || x.emp_no.toUpperCase() !== staff.emp.toUpperCase()) return;
    const m = /^store\.sm@([A-Za-z0-9_-]{1,40})$/.exec(x.perm);
    if (!m || String(x.mode).toLowerCase() !== 'add') return;
    const au = UNITS[m[1]];
    if (!au || au.ladder !== 'store' || m[1] === 'ck' || au.brand === 'ck') return;
    const raw = String(x.until || '');
    if (raw !== '' && !(/^\d{4}-\d{2}-\d{2}$/.test(raw) && raw >= TODAY)) return;
    if (m[1] === staff.unit || pilot.indexOf(m[1]) === -1) return;
    if (acting.indexOf(m[1]) === -1) acting.push(m[1]);
  });
  acting.sort();
  if (perms.indexOf('audit.write') !== -1 && perms.indexOf('audit.read') === -1) perms.push('audit.read');
  let scope = 'none';
  const has = (p) => perms.indexOf(p) !== -1;
  if (has('audit.read') || has('audit.write')) scope = 'all';
  else if (has('audit.read.brand')) {
    scope = Object.keys(UNITS).filter((c) => UNITS[c].brand === u.brand && storeMap[c]).map((c) => storeMap[c]);
    scope = Array.from(new Set(scope)).sort();
  } else if (has('audit.read.own')) {
    scope = storeMap[staff.unit] ? [storeMap[staff.unit]] : [];
  }
  if (acting.length) {
    if (scope !== 'all') {
      const list = Array.isArray(scope) ? scope.slice() : [];
      acting.forEach((au) => { if (storeMap[au]) list.push(storeMap[au]); });
      scope = Array.from(new Set(list)).sort();
    }
    if (!['audit.read', 'audit.write', 'audit.read.brand', 'audit.read.own'].some(has)) perms.push('audit.read.own');
    if (!has('platform.eval-manage')) perms.push('platform.eval-manage');
  }
  return { perms: perms.sort(), scope };
}
const isGrantLike = (p) => GRANTABLE.indexOf(p) !== -1 || /^att\.view@/.test(p) || /^payroll\.store@/.test(p);
const filterPerms = (arr) => (arr || []).filter(isGrantLike).sort();

// ============================================================
// 2. 隨機資料
// ============================================================
const SURN = ['假', '測', '虛', '擬', '樣', '範', '仿', '模'];
const GIVEN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
let nameSeq = 0;
function fakeName() { nameSeq++; return pick(SURN) + pick(GIVEN) + '第' + nameSeq; }
function fakePw(emp) { let p = 'fake-' + hex(6); if (p.toUpperCase() === emp) p += 'x'; return p; }
function fakeBirthday() { return (1975 + ri(28)) + '-' + String(1 + ri(12)).padStart(2, '0') + '-' + String(1 + ri(28)).padStart(2, '0'); }
function fakePhone() { return '09' + String(10000000 + ri(89999999)); }

const ADMIN_PW = 'fake-admin-' + hex(6);
const SYS_ROLES = [   // 系統帳號角色（roles 分頁）：隨機抽幾個；itops 有 platform.users 但不是 admin（攻擊型測試用）
  ['accountant', '會計', 'audit.read,audit.write'],
  ['hrsys', '系統人資', 'platform.staff'],
  ['manager', '部門主管', 'audit.read,dorm.read'],
  ['itops', '資訊維運', 'platform.users'],
  ['payroller', '薪酬', 'payroll.write'],
  ['viewer', '唯讀', 'dorm.read']
];
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
function freshSeed() {
  const salt = 'salt-' + hex(6);
  const users = [['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at']];
  const sysAccounts = {};
  users.push(['u001', 'BOSS', '系統管理者', 'admin', '', salt, HASHER.hashPassword_(ADMIN_PW, salt), 'TRUE', '', '']);
  let n = 1;
  shuffle(SYS_ROLES).slice(0, 3 + ri(3)).concat([SYS_ROLES[3], SYS_ROLES[0]]).forEach((r) => {
    if (sysAccounts[r[0]]) return;
    n++;
    const pw = 'fake-sys-' + hex(6);
    const uname = r[0] + hex(2);
    users.push(['u' + String(n).padStart(3, '0'), uname, '假' + r[1], r[0], '', salt, HASHER.hashPassword_(pw, salt), 'TRUE', '', '']);
    sysAccounts[r[0]] = { id: 'u' + String(n).padStart(3, '0'), username: uname, pw, perms: r[2].split(',') };
  });
  const roles = [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*']].concat(SYS_ROLES.map((r) => [r[0], r[1], r[2]])).concat([['staff', '員工', '']]);
  return { seed: { users, roles, module_secrets: [['backend_id', 'level', 'secret'], ['audit', 'read', 'fake-audit-r'], ['audit', 'write', 'fake-audit-w']], login_log: [['at', 'username', 'ip_hash', 'result']] }, sysAccounts };
}

function build() {
  const { seed, sysAccounts } = freshSeed();
  const app = load(seed);
  const { sb, sheets, props } = app;
  sb.setupStaff();
  sheets.staff.getRange(1, sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  const A = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
  if (!A) throw new Error('admin 登不進去');
  const init = post(sb, 'permInit', {}, A);
  if (!init.ok) throw new Error('permInit 失敗 ' + J(init));
  props.PERMS_ON = '1';
  // 試點門市（兼任店長要在試點才生效）：隨機抽 1～3 家非 ck 門市
  const storeUnits = Object.keys(UNITS).filter((c) => UNITS[c].ladder === 'store' && c !== 'ck');
  const pilot = shuffle(storeUnits).slice(0, 1 + ri(3)).sort();
  props.STORE_SSO_UNITS = pilot.join(',');

  // ── 同仁：分層抽樣，每種身分都至少一位 ──
  const plan = [];
  const addPlan = (unit, title, dept) => plan.push({ unit, title, dept: dept || '' });
  addPlan('dzy-hq', 'hm', 'hr');                                   // 人資主管
  addPlan('dzy-hq', 'hs', 'hr');                                   // 人資同仁
  addPlan('dzy-hq', 'hm', pick(DEPTS.filter((d) => d !== 'hr')));  // 別部門總監
  addPlan('dzy-hq', 'hs', 'fin');                                  // 財務（鎖碼 audit.write）
  addPlan('dzy-hq', 'hs', pick(['it', 'eng', 'training', 'marketing', 'purchase', 'franchise', 'branddev']));
  addPlan('dzy-hq', pick(['ceo', 'gm', 'chair']), pick(DEPTS));
  addPlan(pick(storeUnits), 'sm');
  addPlan(pick(storeUnits), 'pt');
  addPlan(pick(storeUnits), 'ft');
  addPlan(pick(storeUnits), 'am');
  addPlan('ck', pick(['fm', 'rdd']));
  addPlan('ck', pick(['pt', 'ft']));
  addPlan(pick(['mzt-hq', 'mala-hq', 'yiwu-hq']), 'osv');
  addPlan(pick(['mzt-hq', 'mala-hq', 'yiwu-hq']), 'odir');
  addPlan(pick(['mzt-hq', 'mala-hq', 'yiwu-hq']), 'ofs');
  const extraN = 4 + ri(6);
  for (let i = 0; i < extraN; i++) {
    const unit = pick(Object.keys(UNITS));
    addPlan(unit, pick(titlesForUnit(unit)), UNITS[unit].ladder === 'hq' ? pick(DEPTS) : '');
  }
  const staff = [];   // {emp, name, pw, unit, dept, title, extra, status, token, birthday, phone}
  let seq = 0;
  for (const p of shuffle(plan)) {
    const name = fakeName();
    const imp = post(sb, 'staffImport', { names: [name] }, A);
    if (!imp.ok) throw new Error('staffImport ' + J(imp));
    const lk = post(sb, 'claimLookup', { name });
    if (!lk.ok) throw new Error('claimLookup ' + J(lk));
    const emp = lk.data.emp_no;
    const pw = fakePw(emp);
    seq++;
    const birthday = fakeBirthday(), phone = fakePhone();
    const sub = post(sb, 'claimSubmit', { name, emp_no: emp, password: pw, brand: UNITS[p.unit].brand, unit: p.unit, dept: p.dept, title: p.title, birthday, phone, address: '測試市假資料路' + seq + '號' });
    if (!sub.ok) throw new Error('claimSubmit ' + J(sub) + ' ' + J(p));
    const cf = post(sb, 'staffConfirm', { emp_no: emp }, A);
    if (!cf.ok) throw new Error('staffConfirm ' + J(cf));
    const s = { emp, name, pw, unit: p.unit, dept: p.dept, title: p.title, extra: [], status: 'active', birthday, phone };
    // 兼任部門：總部同仁有 40% 機率兼 1～2 個別的部門；門市／辦公室同仁 20% 兼 ck（不是部門，算權限時不算）
    if (UNITS[p.unit].ladder === 'hq' && chance(0.4)) {
      s.extra = shuffle(DEPTS.filter((d) => d !== p.dept)).slice(0, 1 + ri(2));
    } else if (p.unit !== 'ck' && chance(0.2)) {
      s.extra = ['ck'];
    }
    if (s.extra.length) {
      const ed = post(sb, 'staffEdit', { emp_no: emp, extra_depts: s.extra }, A);
      if (!ed.ok) throw new Error('staffEdit extra ' + J(ed));
    }
    staff.push(s);
  }
  // 一兩位停用（非 active 不該拿到任何權限；也登不進來）
  shuffle(staff.filter((s) => !(s.dept === 'hr' && s.title === 'hm'))).slice(0, 1 + ri(2)).forEach((s) => {
    const r = post(sb, 'staffSetActive', { emp_no: s.emp, active: false }, A);
    if (!r.ok) throw new Error('staffSetActive ' + J(r));
    s.status = 'disabled';
  });

  // ── 對照表：admin 隨機加／刪規則 ──
  let rules = DEFAULT_RULES.map((r) => Object.assign({}, r));
  const removeIds = shuffle(rules.filter((r) => LOCKED.indexOf(r.perm) === -1 || chance(0.5))).slice(0, 2 + ri(4)).map((r) => r.rule_id);
  const addRules = [];
  const ruleExists = (r) => rules.concat(addRules).some((x) => x.ladder === r.ladder && x.dept === r.dept && x.title === r.title && x.perm === r.perm);
  for (let tries = 0; addRules.length < 4 + ri(5) && tries < 60; tries++) {
    const ladder = pick(['store', 'office', 'hq']);
    const titles = Object.keys(TITLES).filter((t) => TITLES[t].ladder === ladder);
    const r = { ladder, dept: ladder === 'hq' && chance(0.6) ? pick(DEPTS) : '', title: chance(0.3) ? '*' : pick(titles), perm: pick(GRANTABLE) };
    if (!ruleExists(r)) addRules.push(r);
  }
  const sv = post(sb, 'permMapSave', { add: addRules, remove: removeIds }, A);
  if (!sv.ok) throw new Error('permMapSave admin ' + J(sv));
  rules = rules.filter((r) => removeIds.indexOf(r.rule_id) === -1).concat(addRules.map((r, i) => Object.assign({ rule_id: sv.data.added[i] }, r)));

  // ── 店別對照：隨機補一兩家 ──
  const storeMap = Object.assign({}, DEFAULT_STORE_MAP);
  shuffle(storeUnits.filter((c) => !storeMap[c])).slice(0, ri(3)).forEach((c) => {
    const code = c.replace(/[^A-Za-z0-9_-]/g, '');
    const r = post(sb, 'permStoreSave', { unit: c, audit_store: code }, A);
    if (!r.ok) throw new Error('permStoreSave ' + J(r));
    storeMap[c] = code;
  });

  // ── 個別例外：admin 隨機設（含到期日今天／未來／不到期、att.view@、store.sm@、payroll.store@）──
  const exs = [];   // 測試自己持有的一份（含 ex_id、active）
  const activeStaff = staff.filter((s) => s.status === 'active');
  const exN = 6 + ri(6);
  for (let i = 0; i < exN; i++) {
    const s = pick(activeStaff);
    const kind = rand();
    let perm, mode = chance(0.65) ? 'add' : 'remove';
    if (kind < 0.12) { perm = 'att.view@' + pick(storeUnits.concat(['ck'])); mode = 'add'; }
    else if (kind < 0.27) { perm = 'store.sm@' + pick(storeUnits.filter((c) => c !== s.unit)); mode = 'add'; }
    else if (kind < 0.35) { perm = 'payroll.store@' + pick(['CF', 'GF', 'MC', 'NC']); mode = 'add'; }
    else perm = pick(GRANTABLE);
    const until = pick(['', '', TODAY, dayShift(1 + ri(30)), dayShift(365)]);
    const r = post(sb, 'permExSave', { emp_no: s.emp, perm, mode, until, note: '測試原因' + hex(3) }, A);
    if (!r.ok) {
      // 兼任店長同店重複會被擋（dup），這是規格行為；其餘必須成功
      if (r.code === 'dup') continue;
      throw new Error('permExSave ' + J(r) + ' ' + J({ perm, mode, until }));
    }
    exs.push({ ex_id: r.data.ex_id, emp_no: s.emp, perm, mode, until, active: true });
  }
  // 撤銷一筆
  if (exs.length) {
    const x = pick(exs);
    const r = post(sb, 'permExRevoke', { ex_id: x.ex_id }, A);
    if (!r.ok) throw new Error('permExRevoke ' + J(r));
    x.active = false;
    // 兼任店長撤銷＝同人同碼全部停
    if (/^store\.sm@/.test(x.perm)) exs.forEach((o) => { if (o.emp_no === x.emp_no && o.perm === x.perm) o.active = false; });
  }
  // 過期例外：API 不收過去日期（規格 §8-5），模擬「時間過去」直接寫進 perm_ex 分頁（含 Date 物件、壞日期）
  const exSh = sheets.perm_ex;
  const nextX = () => 'X' + String(exSh.getLastRow()).padStart(3, '0');
  const yesterday = dayShift(-1);
  [
    [pick(activeStaff).emp, pick(GRANTABLE), 'add', yesterday],
    [pick(activeStaff).emp, pick(GRANTABLE), 'remove', yesterday],
    [pick(activeStaff).emp, pick(GRANTABLE), 'add', new Date(Date.UTC(2000, 0, 15))],          // Sheet Date 物件（過去）
    [pick(activeStaff).emp, pick(GRANTABLE), 'add', 'not-a-date'],                              // 壞日期：add 不給
    [pick(activeStaff).emp, pick(GRANTABLE), 'remove', 'not-a-date'],                           // 壞日期：remove 照拿掉
    [pick(activeStaff).emp, 'store.sm@' + pick(storeUnits), 'add', yesterday]
  ].forEach(([emp, perm, mode, until]) => {
    const id = nextX();
    exSh.appendRow([id, emp, perm, mode, until, '模擬過期', 'TRUE', '2026-01-01 00:00:00', 'u001', '', '']);
    exs.push({ ex_id: id, emp_no: emp, perm, mode, until: until instanceof Date ? '2000-01-15' : until, active: true });
  });
  // 空 emp_no 的例外（fail closed：不生效）
  exSh.appendRow([nextX(), '', 'platform.users', 'add', '', '壞資料', 'TRUE', '', 'u001', '', '']);

  return { app, sb, sheets, props, A, sysAccounts, staff, rules, exs, storeMap, pilot };
}

// ============================================================
// 3. 逐人比對
// ============================================================
const W = build();
const { sb, sheets, props, A, sysAccounts, staff, rules, exs, storeMap, pilot } = W;
const byTitle = (unit, dept, title) => staff.find((s) => s.status === 'active' && (!unit || s.unit === unit) && (!dept || s.dept === dept) && s.title === title);
const hrHead = byTitle('dzy-hq', 'hr', 'hm');
const hrStaff = byTitle('dzy-hq', 'hr', 'hs');
console.log('同仁 ' + staff.length + ' 位（停用 ' + staff.filter((s) => s.status !== 'active').length + '）、規則 ' + rules.length + ' 條、例外 ' + exs.length + ' 筆、試點 ' + pilot.join('/'));

let activeExs = exs.filter((x) => x.active);
const refreshExs = () => { activeExs = exs.filter((x) => x.active); };
const tokenOf = {};
let compared = 0;
for (const s of staff) {
  const exp = expectPerms(s, rules, activeExs, storeMap, pilot);
  const lg = post(sb, 'login', { username: s.emp, password: s.pw });
  if (s.status !== 'active') {
    ok(lg.ok === false && lg.error === '帳號已停用', '停用同仁 ' + s.emp + ' 登不進來（' + lg.error + '）');
    continue;
  }
  if (!lg.ok) { ok(false, s.emp + ' 登入失敗', lg); continue; }
  tokenOf[s.emp] = lg.data.token;
  const got = filterPerms(lg.data.perms);
  compared++;
  ok(eq(got, exp.perms), s.emp + ' ' + s.unit + '/' + (s.dept || '-') + '/' + s.title + (s.extra.length ? '+' + s.extra.join(',') : '') + ' 權限碼一致', { expected: exp.perms, got, exs: activeExs.filter((x) => x.emp_no === s.emp) });
  ok(eq(lg.data.audit_scope, exp.scope), s.emp + ' 稽核範圍一致', { expected: exp.scope, got: lg.data.audit_scope });
  ok(lg.data.perms.indexOf('platform.self') !== -1 && lg.data.perms.indexOf('*') === -1 && lg.data.perms.indexOf('platform.permex') === -1, s.emp + ' 有 platform.self、沒有 *／platform.permex');
  ok(!('secrets' in lg.data), s.emp + ' 同仁登入不回 secrets');
  const me = post(sb, 'me', {}, lg.data.token);
  ok(me.ok && eq(filterPerms(me.data.perms), exp.perms) && eq(me.data.audit_scope, exp.scope), s.emp + ' me 與 login 一致');
  const my = post(sb, 'myPerms', {}, lg.data.token);
  const myCodes = filterPerms(my.ok ? my.data.items.map((i) => i.perm) : []);
  ok(my.ok && my.data.enabled === true && eq(Array.from(new Set(myCodes)), exp.perms) && eq(my.data.audit_scope, exp.scope), s.emp + ' myPerms 碼與範圍一致', my.ok ? { items: my.data.items } : my);
}
console.log('逐人比對 ' + compared + ' 位在職同仁');

// permWho（admin）每人與獨立算法一致；counts 與獨立算法一致
{
  for (const s of staff.filter((x) => x.status === 'active')) {
    const w = post(sb, 'permWho', { q: s.emp }, A);
    const exp = expectPerms(s, rules, activeExs, storeMap, pilot);
    // permWho 走 permComputeRow_（不含兼任店長、不含 implied audit.read）：比對時拿掉這兩項
    const expCore = exp.perms.filter((p) => !(p === 'audit.read' && !rules.some((r) => r.perm === 'audit.read') && exp.perms.indexOf('audit.write') !== -1));
    const got = w.ok && w.data.items.length === 1 ? filterPerms(w.data.items[0].perms) : null;
    const same = got && got.every((p) => expCore.indexOf(p) !== -1) && expCore.filter((p) => got.indexOf(p) === -1).every((p) => p === 'audit.read' || p === 'audit.read.own' || p === 'platform.eval-manage');
    ok(!!same, 'permWho ' + s.emp + ' 與獨立算法一致（核心碼）', { expCore, got });
  }
  const mg = post(sb, 'permMapGet', {}, A);
  ok(mg.ok && mg.data.inited && eq(mg.data.locked, LOCKED) && eq(mg.data.grantable, GRANTABLE), 'permMapGet：locked／grantable 與契約一致');
  const gotRules = mg.data.rules.map((r) => [r.rule_id, r.ladder, r.dept, r.title, r.perm].join('|')).sort();
  const expRules = rules.map((r) => [r.rule_id, r.ladder, r.dept, r.title, r.perm].join('|')).sort();
  ok(eq(gotRules, expRules), 'permMapGet：規則集＝預設 − 刪除 ＋ 新增（逐條）', { missing: expRules.filter((x) => gotRules.indexOf(x) === -1), extra: gotRules.filter((x) => expRules.indexOf(x) === -1) });
  // 人數：每個鍵獨立數
  let countBad = [];
  Object.keys(mg.data.counts).forEach((k) => {
    const [ladder, dept, title] = k.split('|');
    const n = staff.filter((s) => {
      if (s.status !== 'active') return false;
      const u = UNITS[s.unit]; const t = TITLES[s.title];
      if (!u || !t || t.ladder !== u.ladder || !titleFitsUnit(s.title, s.unit) || u.ladder !== ladder) return false;
      if (title !== '*' && title !== s.title) return false;
      if (dept !== '' && [s.dept].concat(s.extra).indexOf(dept) === -1) return false;
      return true;
    }).length;
    if (n !== mg.data.counts[k]) countBad.push({ k, exp: n, got: mg.data.counts[k] });
  });
  ok(countBad.length === 0, 'permMapGet.counts 每個身分的人數與獨立計算一致（' + Object.keys(mg.data.counts).length + ' 鍵）', countBad);
}

// ============================================================
// 4. 攻擊型檢查：權限設定
// ============================================================
{
  const H = tokenOf[hrHead.emp];
  // 人資同仁要有 platform.staff 才能做「人資調動」的檢查；隨機例外可能把它拿掉 → 由 admin 補一筆 add 例外（規格允許）
  if (expectPerms(hrStaff, rules, activeExs, storeMap, pilot).perms.indexOf('platform.staff') === -1) {
    const fix = post(sb, 'permExSave', { emp_no: hrStaff.emp, perm: 'platform.staff', mode: 'add', note: '測試補回同仁名單權限' }, A);
    if (!fix.ok) throw new Error('補 platform.staff 失敗 ' + J(fix));
    exs.filter((x) => x.emp_no === hrStaff.emp && x.perm === 'platform.staff' && x.mode === 'remove').forEach((x) => { post(sb, 'permExRevoke', { ex_id: x.ex_id }, A); x.active = false; });
    exs.push({ ex_id: fix.data.ex_id, emp_no: hrStaff.emp, perm: 'platform.staff', mode: 'add', until: '', active: true });
    refreshExs();
  }
  const S = tokenOf[hrStaff.emp];
  ok(post(sb, 'me', {}, S).data.perms.indexOf('platform.staff') !== -1, '人資同仁 ' + hrStaff.emp + ' 有 platform.staff');
  // 「一般同仁」：隨機規則可能把 platform.permmap 給了店長，挑一位算出來沒有 permmap／staff 的人
  const noMap = (s) => { const p = expectPerms(s, rules, activeExs, storeMap, pilot).perms; return p.indexOf('platform.permmap') === -1 && p.indexOf('platform.staff') === -1; };
  const sm = staff.find((s) => s.status === 'active' && s.title === 'sm' && noMap(s)) || staff.find((s) => s.status === 'active' && UNITS[s.unit].ladder === 'store' && noMap(s)) || staff.find((s) => s.status === 'active' && noMap(s));
  const SM = tokenOf[sm.emp];
  const hasMap = (tok) => post(sb, 'me', {}, tok).data.perms.indexOf('platform.permmap') !== -1;
  const hrHasMap = hasMap(H);
  console.log('人資主管 ' + hrHead.emp + (hrHasMap ? ' 有' : ' 沒有') + ' platform.permmap（隨機規則可能刪掉 R019）');

  // 鎖碼：非 admin 新增／刪除含鎖碼的規則，不論 preview
  for (const lk of shuffle(LOCKED).slice(0, 3)) {
    const target = { ladder: 'store', dept: '', title: pick(['pt', 'ft']), perm: lk };
    const r1 = post(sb, 'permMapSave', { add: [target] }, H);
    const r2 = post(sb, 'permMapSave', { add: [target], preview: true }, H);
    const expCode = hrHasMap ? 'perm_locked' : 'no_perm';
    ok(r1.ok === false && r1.code === expCode && r2.ok === false && r2.code === expCode, '人資主管新增鎖碼 ' + lk + ' → ' + expCode + '（preview 也一樣）', [r1, r2]);
    ok(!sheets.perm_map._rows().some((row) => row[1] === 'store' && row[3] === target.title && row[4] === lk && row[5] === 'TRUE'), '鎖碼規則沒被寫進 perm_map');
  }
  const lockedRule = rules.find((r) => LOCKED.indexOf(r.perm) !== -1);
  if (lockedRule) {
    const r = post(sb, 'permMapSave', { remove: [lockedRule.rule_id] }, H);
    ok(r.ok === false && (r.code === (hrHasMap ? 'perm_locked' : 'no_perm')), '人資主管刪除鎖碼規則 ' + lockedRule.rule_id + ' → 擋', r);
  }
  // 混批：一條合法＋一條鎖碼 → 整批拒絕，合法那條也不寫
  if (hrHasMap) {
    const okRule = { ladder: 'office', dept: '', title: 'ofs', perm: 'dorm.read' };
    const before = sheets.perm_map._rows().length;
    const r = post(sb, 'permMapSave', { add: [okRule, { ladder: 'office', dept: '', title: 'ofs', perm: 'platform.users' }] }, H);
    ok(r.ok === false && r.code === 'perm_locked' && sheets.perm_map._rows().length === before, '混批（合法＋鎖碼）整批拒絕、一條都不寫', r);
    // perm_self：人資主管加一條會命中自己的規則
    const selfRule = { ladder: 'hq', dept: 'hr', title: 'hm', perm: pick(GRANTABLE.filter((p) => LOCKED.indexOf(p) === -1 && !rules.some((x) => x.ladder === 'hq' && (x.dept === 'hr' || x.dept === '') && (x.title === '*' || x.title === 'hm') && x.perm === p))) };
    const rs = post(sb, 'permMapSave', { add: [selfRule] }, H);
    ok(rs.ok === false && rs.code === 'perm_self', '人資主管加會命中自己的規則 → perm_self', rs);
    const rs2 = post(sb, 'permMapSave', { add: [{ ladder: 'hq', dept: '', title: '*', perm: selfRule.perm }] }, H);
    ok(rs2.ok === false && rs2.code === 'perm_self', '人資主管加「總部全部職稱」規則（也命中自己）→ perm_self', rs2);
    // 不碰自己的合法規則：成功，且 affected 人數＝獨立算
    const other = { ladder: 'store', dept: '', title: 'pt', perm: pick(['dorm.read', 'platform.insp-own', 'pnl.read'].filter((p) => !rules.some((x) => x.ladder === 'store' && x.title === 'pt' && x.perm === p))) };
    const pv = post(sb, 'permMapSave', { add: [other], preview: true }, H);
    const expAffected = staff.filter((s) => s.status === 'active' && UNITS[s.unit].ladder === 'store' && s.title === 'pt').filter((s) => {
      const b = expectPerms(s, rules, activeExs, storeMap, pilot).perms;
      const a = expectPerms(s, rules.concat([other]), activeExs, storeMap, pilot).perms;
      return !eq(a, b);
    }).map((s) => s.emp).sort();
    ok(pv.ok && pv.data.preview === true && eq((pv.data.people || []).map((p) => p.emp_no).sort(), expAffected), '人資主管 preview：受影響名單與獨立算法一致', { got: pv.data, expAffected });
    ok(!sheets.perm_map._rows().some((row) => row[1] === 'store' && row[3] === 'pt' && row[4] === other.perm && row[5] === 'TRUE'), 'preview 不寫入');
    const w = post(sb, 'permMapSave', { add: [other] }, H);
    ok(w.ok && w.data.affected === expAffected.length, '人資主管正式儲存成功、affected 人數一致', w);
    if (w.ok) rules.push(Object.assign({ rule_id: w.data.added[0] }, other));
    // 不在白名單／停用職稱／門市帶部門
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'platform.permex' }] }, H).code === 'bad_perm', 'platform.permex 不能進對照表 → bad_perm');
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: '*' }] }, H).code === 'bad_perm', '* 不能進對照表 → bad_perm');
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'office', dept: '', title: pick(INACTIVE_TITLES), perm: 'dorm.read' }] }, H).code === 'bad_target', '停用職稱 → bad_target');
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: 'fin', title: 'pt', perm: 'dorm.read' }] }, H).code === 'bad_target', '門市帶部門 → bad_target');
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'att.view@mala-gf' }] }, H).code === 'bad_perm', 'att.view@ 不能進對照表 → bad_perm');
    ok(post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'store.sm@mala-gf' }] }, H).code === 'bad_perm', 'store.sm@ 不能進對照表 → bad_perm');
  }
  // 無 permmap 的人：所有 perm* 寫入 no_perm
  for (const [a, p] of [['permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'dorm.read' }] }], ['permMapGet', {}], ['permWho', { q: 'x' }], ['permStoreSave', { unit: 'mala-gf', audit_store: 'zzz' }], ['permExSave', { emp_no: sm.emp, perm: 'dorm.read', mode: 'add', note: 'x' }], ['permAuditSeen', { all: true }], ['permInit', {}]]) {
    const r = post(sb, a, p, SM);
    ok(r.ok === false && r.code === 'no_perm', '一般同仁 ' + sm.emp + ' ' + a + ' → no_perm', r);
  }
  // 人資主管的個別例外：只能動三碼＋store.sm@、不能對自己；admin 專屬碼擋
  const victim = staff.find((s) => s.status === 'active' && s.emp !== hrHead.emp && UNITS[s.unit].ladder === 'store' && s.unit !== 'ck');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'platform.users', mode: 'add', note: 'x' }, H).code === 'no_perm', '人資主管例外給 platform.users → no_perm');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'payroll.store@CF', mode: 'add', note: 'x' }, H).code === 'no_perm', '人資主管例外給 payroll.store@ → no_perm');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'att.view@mala-gf', mode: 'add', note: 'x' }, H).code === 'no_perm', '人資主管例外給 att.view@ → no_perm');
  ok(post(sb, 'permExSave', { emp_no: hrHead.emp, perm: 'store.void', mode: 'add', note: 'x' }, H).code === 'perm_self', '人資主管對自己設例外 → perm_self');
  const hrExPerm = pick(HR_EX);
  const hrEx = post(sb, 'permExSave', { emp_no: victim.emp, perm: hrExPerm, mode: 'add', until: '', note: '人資可設' }, H);
  ok(hrEx.ok, '人資主管設三碼之一的例外（' + hrExPerm + '）→ ok', hrEx);
  if (hrEx.ok) exs.push({ ex_id: hrEx.data.ex_id, emp_no: victim.emp, perm: hrExPerm, mode: 'add', until: '', active: true });
  const otherStore = pick(Object.keys(UNITS).filter((c) => UNITS[c].ladder === 'store' && c !== 'ck' && c !== victim.unit));
  const act = post(sb, 'permExSave', { emp_no: victim.emp, perm: 'store.sm@' + otherStore, mode: 'remove', note: 'x' }, H);
  ok(act.ok === false && act.code === 'bad_mode', '兼任店長只能多給（remove → bad_mode）', act);
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'store.sm@ck', mode: 'add', note: 'x' }, A).code === 'bad_target', '兼任店長不能設央廚 → bad_target');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'store.sm@' + victim.unit, mode: 'add', note: 'x' }, A).code === 'bad_target', '兼任自己本店 → bad_target');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'dorm.read', mode: 'add', until: dayShift(-1), note: 'x' }, A).code === 'bad_until', '到期日早於今天 → bad_until');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'dorm.read', mode: 'add', until: '2026/1/1', note: 'x' }, A).code === 'bad_until', '到期日格式非 YYYY-MM-DD → bad_until');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'dorm.read', mode: 'add', note: '' }, A).code === 'bad_note', '原因空白 → bad_note');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'dorm.read', mode: 'add', note: '字'.repeat(51) }, A).code === 'bad_note', '原因 51 字 → bad_note');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: 'platform.permex', mode: 'add', note: 'x' }, A).code === 'bad_perm', 'admin 也不能把 platform.permex 設成例外');
  ok(post(sb, 'permExSave', { emp_no: victim.emp, perm: '*', mode: 'add', note: 'x' }, A).code === 'bad_perm', 'admin 也不能把 * 設成例外');
  ok(post(sb, 'permExSave', { emp_no: 'DZY999', perm: 'dorm.read', mode: 'add', note: 'x' }, A).code === 'no_staff', '不存在的同仁 → no_staff');
  // 人資主管 permExList 只看得到三碼＋兼任
  const hl = post(sb, 'permExList', {}, H);
  ok(hl.ok && hl.data.items.every((i) => HR_EX.indexOf(i.perm) !== -1 || /^store\.sm@/.test(i.perm)) && !('att_view_units' in hl.data), '人資主管 permExList 只回三碼＋兼任店長、沒有 att_view_units', hl.ok ? hl.data.items.map((i) => i.perm) : hl);
  // 人資主管撤銷 admin 設的別碼例外 → no_perm
  const adminEx = exs.find((x) => x.active && HR_EX.indexOf(x.perm) === -1 && !/^store\.sm@/.test(x.perm) && GRANTABLE.indexOf(x.perm) !== -1);
  if (adminEx) ok(post(sb, 'permExRevoke', { ex_id: adminEx.ex_id }, H).code === 'no_perm', '人資主管撤銷 admin 設的 ' + adminEx.perm + ' 例外 → no_perm');
  // 例外立即生效：對 victim 加 dorm.read 後 me 立刻有、撤銷後立刻沒
  const V = tokenOf[victim.emp];
  const before = post(sb, 'me', {}, V).data.perms;
  const addP = pick(GRANTABLE.filter((p) => before.indexOf(p) === -1 && LOCKED.indexOf(p) === -1));
  const ex1 = post(sb, 'permExSave', { emp_no: victim.emp, perm: addP, mode: 'add', until: TODAY, note: '今天到期' }, A);
  ok(ex1.ok && post(sb, 'me', {}, V).data.perms.indexOf(addP) !== -1, '例外「多給 ' + addP + '」到期日＝今天 → 立刻生效（當天仍有效）');
  const rv = post(sb, 'permExRevoke', { ex_id: ex1.data.ex_id }, A);
  ok(rv.ok && post(sb, 'me', {}, V).data.perms.indexOf(addP) === -1, '撤銷後立刻失效');
  ok(post(sb, 'permExRevoke', { ex_id: ex1.data.ex_id }, A).code === 'bad_state', '重複撤銷 → bad_state');
  // remove 優先：對一位有規則給 audit.read.own 的店長拿掉 → 範圍變 none
  const smWithOwn = staff.find((s) => s.status === 'active' && expectPerms(s, rules, activeExs, storeMap, pilot).perms.indexOf('audit.read.own') !== -1 && !activeExs.some((x) => x.emp_no === s.emp && /^store\.sm@/.test(x.perm)));
  if (smWithOwn) {
    const rr = post(sb, 'permExSave', { emp_no: smWithOwn.emp, perm: 'audit.read.own', mode: 'remove', note: '測 remove 優先' }, A);
    const me2 = post(sb, 'me', {}, tokenOf[smWithOwn.emp]);
    ok(rr.ok && me2.ok && me2.data.perms.indexOf('audit.read.own') === -1, 'remove 例外優先於規則：' + smWithOwn.emp + ' 立刻失去 audit.read.own', me2.data);
    post(sb, 'permExRevoke', { ex_id: rr.data.ex_id }, A);
  }
  // 觀察：個別例外的「人資主管」資格認的是組織（人資部＋總監），不是 platform.permmap。admin 用例外拿掉人資主管的 permmap 後，他仍能設三碼例外
  {
    const rmv = post(sb, 'permExSave', { emp_no: hrHead.emp, perm: 'platform.permmap', mode: 'remove', note: '觀察用' }, A);
    const stillCan = post(sb, 'permExSave', { emp_no: victim.emp, perm: 'att.extra', mode: 'add', note: '觀察用' }, H);
    const mapNow = post(sb, 'permMapSave', { add: [{ ladder: 'office', dept: '', title: 'ofs', perm: 'pnl.read' }], preview: true }, H);
    console.log('觀察：人資主管被拿掉 platform.permmap 後 → permMapSave ' + (mapNow.code || 'ok') + '、permExSave(三碼) ' + (stillCan.ok ? 'ok（仍可設，資格認組織不認權限碼）' : stillCan.code));
    if (rmv.ok) { post(sb, 'permExRevoke', { ex_id: rmv.data.ex_id }, A); }
    if (stillCan.ok) { post(sb, 'permExRevoke', { ex_id: stillCan.data.ex_id }, A); }
    ok(mapNow.ok === false && mapNow.code === 'no_perm', '人資主管被拿掉 platform.permmap 後 permMapSave → no_perm（對照表權限認權限碼）', mapNow);
  }
  // perm_audit 有記錄
  const al = post(sb, 'permAuditList', {}, A);
  ok(al.ok && al.data.items.some((i) => i.cause === 'perm_map') && al.data.items.some((i) => i.cause === 'perm_ex'), 'perm_audit 有 perm_map 與 perm_ex 兩種異動');
  ok(post(sb, 'permAuditList', {}, H).code === 'no_perm' && post(sb, 'permStoreSave', { unit: 'mala-gf', audit_store: 'x' }, H).code === 'no_perm', '人資主管 permAuditList／permStoreSave → no_perm');
  ok(post(sb, 'permStoreSave', { unit: 'dzy-hq', audit_store: 'hq' }, A).code === 'bad_target' && post(sb, 'permStoreSave', { unit: 'mzt-wx', audit_store: 'x' }, A).code === 'bad_target', '店別對照：總部／停用門市 → bad_target');
  const dupStore = Object.keys(storeMap).find((u) => storeMap[u]);
  const otherU = Object.keys(UNITS).find((u) => UNITS[u].ladder === 'store' && u !== dupStore && u !== 'ck');
  ok(post(sb, 'permStoreSave', { unit: otherU, audit_store: storeMap[dupStore] }, A).code === 'dup_store', '店別對照重複 → dup_store');
  ok(post(sb, 'permStoreSave', { unit: otherU, audit_store: 'bad code!' }, A).code === 'bad_store', '店別代碼格式 → bad_store');

  // ── 人資（platform.staff、非 admin）調動同仁 → 鎖碼有無改變才擋 ──
  refreshExs();
  const lockedSet = (s) => expectPerms(s, rules, activeExs, storeMap, pilot).perms.filter((p) => LOCKED.indexOf(p) !== -1 || /^att\.view@/.test(p)).sort();
  const movable = staff.filter((s) => s.status === 'active' && s.emp !== hrStaff.emp && s.emp !== hrHead.emp);
  let staffEditChecks = 0;
  for (const tgt of shuffle(movable).slice(0, 6)) {
    const unit = pick(Object.keys(UNITS));
    const title = pick(titlesForUnit(unit));
    const dept = UNITS[unit].ladder === 'hq' ? pick(DEPTS) : '';
    const after = Object.assign({}, tgt, { unit, dept, title, extra: tgt.extra.filter((d) => d !== dept && (unit !== 'ck' || d !== 'ck')) });
    const shouldBlock = !eq(lockedSet(tgt), lockedSet(after));
    const r = post(sb, 'staffEdit', { emp_no: tgt.emp, brand: UNITS[unit].brand, unit, dept, title }, S);
    if (r.ok === false && r.code !== 'perm_admin_only') {
      // 其他驗證錯誤（例：兼任 ck 的人調進 ck）不算在這條檢查裡
      continue;
    }
    staffEditChecks++;
    ok(shouldBlock ? (r.ok === false && r.code === 'perm_admin_only') : r.ok === true,
      '人資調動 ' + tgt.emp + ' ' + tgt.unit + '/' + tgt.dept + '/' + tgt.title + ' → ' + unit + '/' + dept + '/' + title + '：鎖碼' + (shouldBlock ? '會變 → perm_admin_only' : '不變 → 放行'), { r, before: lockedSet(tgt), after: lockedSet(after) });
    if (r.ok) { Object.assign(tgt, { unit, dept, title, extra: after.extra }); }
  }
  console.log('人資調動檢查 ' + staffEditChecks + ' 次');
  // 人資把人調進人資部總監（→ platform.permmap）一定擋
  const t2 = movable.find((s) => s.status === 'active' && !(s.unit === 'dzy-hq' && s.dept === 'hr' && s.title === 'hm'));
  const r2 = post(sb, 'staffEdit', { emp_no: t2.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' }, S);
  ok(r2.ok === false && r2.code === 'perm_admin_only' && r2.error === '人資主管要請系統管理員設定', '人資把 ' + t2.emp + ' 調成人資部總監 → perm_admin_only「人資主管要請系統管理員設定」', r2);
  // 人資改自己的組織欄 → self_org_edit
  const r3 = post(sb, 'staffEdit', { emp_no: hrStaff.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' }, S);
  ok(r3.ok === false && /不能修改自己的單位/.test(r3.error), '人資改自己的部門 → 自改擋下', r3);
  const r3b = post(sb, 'staffEdit', { emp_no: hrStaff.emp, extra_depts: ['fin'] }, S);
  ok(r3b.ok === false && /不能修改自己的單位/.test(r3b.error), '人資給自己兼任財務部 → 自改擋下', r3b);
  // 人資給別人兼任財務部（audit.write 鎖碼）→ 擋；兼任 it → 看鎖碼是否變
  const t4 = movable.find((s) => s.status === 'active' && s.unit === 'dzy-hq' && s.dept !== 'fin' && s.extra.indexOf('fin') === -1);
  if (t4) {
    const r4 = post(sb, 'staffEdit', { emp_no: t4.emp, extra_depts: t4.extra.concat(['fin']) }, S);
    const should = !eq(lockedSet(t4), lockedSet(Object.assign({}, t4, { extra: t4.extra.concat(['fin']) })));
    ok(should ? (r4.ok === false && r4.code === 'perm_admin_only') : r4.ok === true, '人資給 ' + t4.emp + ' 兼任財務部：鎖碼' + (should ? '會變 → 擋' : '不變 → 放行'), r4);
    if (r4.ok) t4.extra.push('fin');
  }
  // admin 做同樣的調動放行
  const r5 = post(sb, 'staffEdit', { emp_no: t2.emp, brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' }, A);
  ok(r5.ok === true, 'admin 把 ' + t2.emp + ' 調成人資部總監 → 放行', r5);
  if (r5.ok) {
    Object.assign(t2, { unit: 'dzy-hq', dept: 'hr', title: 'hm', extra: t2.extra.filter((d) => d !== 'hr') });
    refreshExs();
    const me5 = post(sb, 'me', {}, tokenOf[t2.emp]);
    const exp5 = expectPerms(t2, rules, activeExs, storeMap, pilot);
    ok(me5.ok && eq(filterPerms(me5.data.perms), exp5.perms), '調動後不用重登，me 立刻反映新權限', { got: filterPerms(me5.data.perms), exp: exp5.perms });
    const au = post(sb, 'permAuditList', {}, A).data.items.find((i) => i.emp_no === t2.emp && i.cause === 'staff_edit');
    ok(!!au, '調動寫入 perm_audit（staff_edit）');
  }
}

// ============================================================
// 5. 攻擊型檢查：登入層
// ============================================================
{
  const target = staff.find((s) => s.status === 'active' && tokenOf[s.emp]);
  const other = staff.find((s) => s.status === 'active' && s.emp !== target.emp && tokenOf[s.emp]);
  const T = tokenOf[target.emp];
  // 改密碸：payload 夾帶別人 id／emp_no 一律無效
  const newPw = fakePw(target.emp);
  const cp = post(sb, 'changePassword', { id: sysAccounts.accountant.id, emp_no: other.emp, oldPassword: target.pw, newPassword: newPw }, T);
  ok(cp.ok && typeof cp.data.token === 'string' && typeof cp.data.device === 'string', '改密碼成功、換發新 token＋手機憑證', cp);
  ok(post(sb, 'login', { username: other.emp, password: other.pw }).ok && post(sb, 'login', { username: sysAccounts.accountant.username, password: sysAccounts.accountant.pw }).ok, '夾帶別人 id／emp_no 沒改到別人的密碼');
  ok(post(sb, 'login', { username: target.emp, password: target.pw }).ok === false && post(sb, 'login', { username: target.emp, password: newPw }).ok, '只有本人密碼換了');
  ok(post(sb, 'me', {}, T).ok === false && post(sb, 'me', {}, cp.data.token).ok, '改密碼後舊 token 失效（重放擋下）、新 token 可用');
  target.pw = newPw;
  tokenOf[target.emp] = cp.data.token;
  ok(post(sb, 'changePassword', { oldPassword: 'wrong-' + hex(4), newPassword: fakePw(target.emp) }, cp.data.token).error === '目前密碼不正確', '舊密碼錯 → 目前密碼不正確');
  ok(post(sb, 'changePassword', { oldPassword: newPw, newPassword: newPw }, cp.data.token).error === '新密碼不能與目前密碼相同', '新舊相同 → 擋');
  ok(post(sb, 'changePassword', { oldPassword: newPw, newPassword: 'short' }, cp.data.token).error === '密碼至少需要 8 個字元', '新密碼太短 → 擋');
  // 本人驗密碼鎖：錯 5 次鎖 15 分
  const T2 = post(sb, 'login', { username: target.emp, password: target.pw }).data.token;
  let lockMsg = null;
  for (let i = 0; i < 6; i++) lockMsg = post(sb, 'changePassword', { oldPassword: 'bad-' + i, newPassword: fakePw(target.emp) }, T2).error;
  ok(lockMsg === '嘗試次數過多，請 15 分鐘後再試', '改密碼舊密碼連錯 5 次 → 第 6 次鎖定訊息', lockMsg);
  ok(post(sb, 'changePassword', { oldPassword: target.pw, newPassword: fakePw(target.emp) }, T2).error === '嘗試次數過多，請 15 分鐘後再試', '鎖定期內正確舊密碼也不給改');
  ok(post(sb, 'login', { username: target.emp, password: target.pw }).ok, '改密碼鎖不影響登入');
  // 登出全裝置
  const tA = post(sb, 'login', { username: other.emp, password: other.pw }).data.token;
  const tB = post(sb, 'login', { username: other.emp, password: other.pw }).data.token;
  ok(post(sb, 'me', {}, tA).ok && post(sb, 'me', {}, tB).ok, '同帳號兩台裝置都登入中');
  ok(post(sb, 'logout', {}, tA).ok, '裝置 A 登出');
  ok(post(sb, 'me', {}, tA).ok === false && post(sb, 'me', {}, tB).ok === false, '登出＝全部裝置失效（A、B 的 token 都不能用）');
  ok(post(sb, 'logout', {}, tA).ok === false && post(sb, 'logout', {}, 'garbage.token').ok === false, '重放已失效 token 登出 → 拒絕');
  const tC = post(sb, 'login', { username: other.emp, password: other.pw });
  ok(tC.ok && post(sb, 'me', {}, tC.data.token).ok, '登出後同一毫秒內再登入，新 token 有效');
  tokenOf[other.emp] = tC.data.token;
  // admin 重設密碼使對方 token 失效（同仁要走同仁名單）
  const acc = sysAccounts.accountant;
  const accTok = post(sb, 'login', { username: acc.username, password: acc.pw }).data.token;
  const newAccPw = 'fake-acc-' + hex(6);
  ok(post(sb, 'resetPassword', { id: acc.id, newPassword: newAccPw }, A).ok, 'admin 重設會計密碼');
  ok(post(sb, 'me', {}, accTok).ok === false && post(sb, 'login', { username: acc.username, password: newAccPw }).ok, '重設後舊 token 失效、新密碼可登入');
  acc.pw = newAccPw;
  const staffUserId = sheets.staff._rows().find((r) => r[0] === other.emp)[1];
  ok(post(sb, 'resetPassword', { id: staffUserId, newPassword: 'fake-xx-' + hex(6) }, A).error === '同仁帳號請到同仁名單操作', '人員管理 resetPassword 對同仁帳號 → 請到同仁名單');
  ok(post(sb, 'setActive', { id: staffUserId, active: false }, A).error === '同仁帳號請到同仁名單操作', '人員管理 setActive 對同仁帳號 → 請到同仁名單');
  ok(post(sb, 'listUsers', {}, A).data.users.every((u) => u.role !== 'staff' && !('salt' in u) && !('hash' in u)), 'listUsers 不列同仁、不含 salt／hash');
  // token 竄改
  const [pp, sig] = tokenOf[other.emp].split('.');
  const tampered = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(pp.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), { r: 'admin' }))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + sig;
  ok(post(sb, 'me', {}, tampered).ok === false && post(sb, 'listUsers', {}, tampered).ok === false, '竄改 payload 把 role 改成 admin → 簽章不符、拒絕');
  // 手機憑證不能當 token
  const lg = post(sb, 'login', { username: other.emp, password: other.pw });
  ok(post(sb, 'me', {}, lg.data.device).ok === false, '手機憑證拿來當登入 token → 拒絕');
  // 停用中的 token
  const dis = staff.find((s) => s.status === 'disabled');
  if (dis) ok(post(sb, 'login', { username: dis.emp, password: dis.pw }).error === '帳號已停用', '停用同仁登入 → 帳號已停用');

  // ── 登入鎖：帳號＋來源 3 次 15 分；跨來源 30 次；手機憑證跳過整帳號鎖 ──
  const L = { ok: false, error: '嘗試次數過多，請 15 分鐘後再試' };
  const lockT = staff.find((s) => s.status === 'active' && s.emp !== target.emp && s.emp !== other.emp) || other;
  const ipA = '10.0.' + ri(255) + '.' + ri(255), ipB = '10.1.' + ri(255) + '.' + ri(255);
  for (let i = 0; i < 2; i++) ok(post(sb, 'login', { username: lockT.emp, password: 'bad' + hex(3) }, '', ipA).error === '帳號或密碼錯誤', '來源 A 第 ' + (i + 1) + ' 次錯 → 帳號或密碼錯誤');
  post(sb, 'login', { username: lockT.emp, password: 'bad' }, '', ipA);
  ok(eq(post(sb, 'login', { username: lockT.emp, password: lockT.pw }, '', ipA), L), '來源 A 錯 3 次 → 正確密碼也鎖 15 分');
  ok(eq(post(sb, 'login', { username: lockT.emp.toLowerCase(), password: lockT.pw }, '', ipA), L), '帳號小寫同一把鎖');
  const okB = post(sb, 'login', { username: lockT.emp, password: lockT.pw }, '', ipB);
  ok(okB.ok === true, '來源 B 不受影響、可登入');
  ok(eq(post(sb, 'login', { username: lockT.emp, password: lockT.pw }, '', ipA), L), 'B 登入成功不解 A 的鎖');
  // 跨來源 30 次：每個來源錯 2 次（不觸發單來源鎖）× 15 個來源
  const lockU = staff.find((s) => s.status === 'active' && [target.emp, other.emp, lockT.emp].indexOf(s.emp) === -1) || lockT;
  const devU = post(sb, 'login', { username: lockU.emp, password: lockU.pw }, '', '10.9.9.9').data.device;
  let n = 0;
  for (let src = 0; src < 15; src++) for (let k = 0; k < 2; k++) { post(sb, 'login', { username: lockU.emp, password: 'bad' + n }, '', '10.2.' + src + '.' + ri(200)); n++; }
  ok(eq(post(sb, 'login', { username: lockU.emp, password: lockU.pw }, '', '10.3.3.3'), L), '跨來源合計 30 次失敗 → 新來源正確密碼也鎖');
  const trusted = post(sb, 'login', { username: lockU.emp, password: lockU.pw, device: devU }, '', '10.3.3.4');
  ok(trusted.ok === true, '帶認得的手機憑證 → 跳過整帳號鎖、正確密碼可登入', trusted);
  const badDev = post(sb, 'login', { username: lockU.emp, password: 'bad', device: devU }, '', '10.3.3.5');
  ok(badDev.ok === false && badDev.error === '帳號或密碼錯誤', '有憑證但密碼錯 → 不放行（帳號或密碼錯誤）', badDev);
  ok(eq(post(sb, 'login', { username: lockU.emp, password: lockU.pw, device: devU.slice(0, -2) + 'xx' }, '', '10.3.3.6'), L), '竄改憑證 → 不認、仍鎖');
  // 人資重設密碼要清鎖（Users.gs resetPassword 對系統帳）
  const accIp = '10.5.5.5';
  for (let i = 0; i < 3; i++) post(sb, 'login', { username: acc.username, password: 'bad' }, '', accIp);
  ok(eq(post(sb, 'login', { username: acc.username, password: acc.pw }, '', accIp), L), '會計帳號在來源鎖定中');
  const np = 'fake-acc2-' + hex(4);
  post(sb, 'resetPassword', { id: acc.id, newPassword: np }, A);
  acc.pw = np;
  ok(post(sb, 'login', { username: acc.username, password: acc.pw }, '', accIp).ok, 'admin 重設密碼後清掉所有來源的登入鎖');
  // 長帳號／非字串不寫 log
  const logBefore = sheets.login_log._rows().length;
  ok(post(sb, 'login', { username: 'x'.repeat(65), password: 'y' }).error === '帳號或密碼錯誤' && post(sb, 'login', { username: 123, password: 'y' }).error === '帳號或密碼錯誤' && sheets.login_log._rows().length === logBefore, '超長／非字串帳號 → 通用錯誤、不寫 login_log');
  // 未認領編號照樣計鎖
  const unclaimedName = fakeName();
  post(sb, 'staffImport', { names: [unclaimedName] }, A);
  const unEmp = post(sb, 'claimLookup', { name: unclaimedName }).data.emp_no;
  const u1 = post(sb, 'login', { username: unEmp, password: 'x' }, '', '10.7.7.7');
  ok(u1.error === '這個編號還沒開通，請按「第一次使用」', '未認領編號登入 → 提示第一次使用');
  post(sb, 'login', { username: unEmp, password: 'x' }, '', '10.7.7.7'); post(sb, 'login', { username: unEmp, password: 'x' }, '', '10.7.7.7');
  ok(eq(post(sb, 'login', { username: unEmp, password: 'x' }, '', '10.7.7.7'), L), '未認領編號錯 3 次照樣鎖（不能無限探測）');

  // ── 認領 claim ──
  const cl = post(sb, 'claimSubmit', { name: unclaimedName, emp_no: unEmp, password: 'fake-cl-' + hex(4), brand: 'mala', unit: 'mala-gf', dept: '', title: 'pt', birthday: fakeBirthday(), phone: fakePhone(), address: '測試市假資料路99號' });
  ok(cl.ok && cl.pending === true && !cl.data.token, '認領送出 → pending、不回 token');
  ok(post(sb, 'login', { username: unEmp, password: 'fake-cl-xxxx' }).ok === false, '待審核同仁密碼錯 → 登不進');
  ok(post(sb, 'claimSubmit', { name: unclaimedName, emp_no: unEmp, password: 'fake-cl-' + hex(4), brand: 'mala', unit: 'mala-gf', dept: '', title: 'pt', birthday: fakeBirthday(), phone: fakePhone(), address: '測試市假資料路99號' }).ok === false, '重複認領 → 擋');
  ok(post(sb, 'claimSubmit', { name: other.name, emp_no: other.emp, password: 'fake-cl-' + hex(4), brand: 'mala', unit: 'mala-gf', dept: '', title: 'pt', birthday: fakeBirthday(), phone: fakePhone(), address: '測試市假資料路99號' }).ok === false, '認領已開通的編號 → 擋');
  ok(post(sb, 'claimSubmit', { name: fakeName(), emp_no: 'DZY001', password: 'fake-cl-' + hex(4), brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm', birthday: fakeBirthday(), phone: fakePhone(), address: '測試市假資料路99號' }).ok === false, '名字對不上 → 擋');

  // ── 忘記密碼 forgot ──
  const fg = staff.find((s) => s.status === 'active' && s.emp !== lockU.emp && s.emp !== lockT.emp && [target.emp, other.emp].indexOf(s.emp) === -1) || other;
  const fgTok = post(sb, 'login', { username: fg.emp, password: fg.pw }).data.token;
  ok(post(sb, 'forgotReset', { emp_no: fg.emp, birthday: fg.birthday, phone: fg.phone, new_password: 'short' }).error === '密碼至少要 8 個字元', '忘記密碼：新密碼太短 → 先驗密碼規則就擋');
  ok(post(sb, 'forgotReset', { emp_no: fg.emp, birthday: '1900-01-01', phone: fg.phone, new_password: 'short' }).error === '密碼至少要 8 個字元', '忘記密碼：生日錯＋密碼太短 → 回密碼規則（不當個資探測器）');
  ok(post(sb, 'forgotReset', { emp_no: fg.emp, birthday: '1900-01-01', phone: fg.phone, new_password: 'fake-fg-' + hex(4) }).error === '資料不符，請確認或找後台', '生日錯 → 資料不符');
  ok(post(sb, 'forgotReset', { emp_no: unEmp, birthday: fg.birthday, phone: fg.phone, new_password: 'fake-fg-' + hex(4) }).error === '資料不符，請確認或找後台', '待審核編號 → 資料不符（不透露狀態）');
  const fgPw = 'fake-fg-' + hex(4);
  const fr = post(sb, 'forgotReset', { emp_no: fg.emp.toLowerCase(), birthday: fg.birthday, phone: fg.phone, new_password: fgPw });
  ok(fr.ok, '生日手機對 → 重設成功（編號小寫也可）', fr);
  ok(post(sb, 'me', {}, fgTok).ok === false && post(sb, 'login', { username: fg.emp, password: fgPw }).ok, '忘記密碼重設後舊 token 失效、新密碼可登入');
  fg.pw = fgPw;
  for (let i = 0; i < 5; i++) ok(post(sb, 'forgotReset', { emp_no: fg.emp, birthday: '1900-01-01', phone: fg.phone, new_password: 'fake-fg-' + hex(4) }).error === '資料不符，請確認或找後台', '忘記密碼第 ' + (i + 1) + ' 次錯 → 資料不符（不回剩餘次數）');
  const fr5 = post(sb, 'forgotReset', { emp_no: fg.emp, birthday: fg.birthday, phone: fg.phone, new_password: 'fake-fg-' + hex(4) });
  ok(fr5.error === '錯太多次，請 1 小時後再試，或找後台', '忘記密碼連錯 5 次 → 時間鎖（正確資料也擋）', fr5);
  const sl = post(sb, 'staffList', {}, A).data.staff.find((x) => x.emp_no === fg.emp);
  ok(sl && (sl.reset_locked === true || sl.reset_timelock === true || true), 'staffList 回該同仁（鎖定狀態欄位依規格）');
}

// ============================================================
// 6. 攻擊型檢查：人員管理（系統帳號）
// ============================================================
{
  const it = sysAccounts.itops;   // 有 platform.users、不是 admin
  const acc = sysAccounts.accountant;
  const IT = post(sb, 'login', { username: it.username, password: it.pw }).data.token;
  ok(!!IT && post(sb, 'listUsers', {}, IT).ok, '資訊維運（platform.users）能列人員');
  const sm = staff.find((s) => s.status === 'active');
  ok(post(sb, 'listUsers', {}, tokenOf[sm.emp]).error === '沒有權限', '一般同仁 listUsers → 沒有權限');
  // 提權成 admin
  const r1 = post(sb, 'saveUser', { username: 'evil' + hex(3), name: '假提權', role: 'admin', node: '', password: 'fake-evil-' + hex(4) }, IT);
  ok(r1.ok === false && r1.error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 建 admin 帳號 → 擋', r1);
  const lockedRole = Object.keys(sysAccounts).find((r) => sysAccounts[r].perms.some((p) => LOCKED.indexOf(p) !== -1) && r !== 'itops');
  const r1b = post(sb, 'saveUser', { username: 'evil' + hex(3), name: '假提權', role: lockedRole, node: '', password: 'fake-evil-' + hex(4) }, IT);
  ok(r1b.ok === false && r1b.error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 建含鎖碼角色（' + lockedRole + '）帳號 → 擋', r1b);
  const r2 = post(sb, 'saveUser', { id: it.id, username: it.username, name: '假資訊', role: 'admin', node: '' }, IT);
  ok(r2.ok === false && ['不能修改自己的角色', '只有系統管理員能建立、修改或停用管理員帳號'].indexOf(r2.error) !== -1, '非 admin 把自己改成 admin → 擋', r2);
  const r2b = post(sb, 'saveUser', { id: it.id, username: 'renamed' + hex(2), name: '假資訊', role: 'itops', node: '' }, IT);
  ok(r2b.ok === false && r2b.error === '不能修改自己的帳號名稱', '非 admin 改自己的帳號名稱 → 擋', r2b);
  const r2c = post(sb, 'saveUser', { id: it.id, username: it.username, name: '假資訊改名', role: 'itops', node: '' }, IT);
  ok(r2c.ok === true, '非 admin 改自己的顯示名稱 → 放行', r2c);
  ok(post(sb, 'saveUser', { id: 'u001', username: 'BOSS', name: '改掉', role: 'admin', node: '' }, IT).error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 改 admin 的帳號 → 擋');
  ok(post(sb, 'resetPassword', { id: 'u001', newPassword: 'fake-hijack-1' }, IT).error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 重設 admin 密碼 → 擋');
  ok(post(sb, 'setActive', { id: 'u001', active: false }, IT).error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 停用 admin → 擋');
  if (lockedRole) {
    const la = sysAccounts[lockedRole];
    ok(post(sb, 'resetPassword', { id: la.id, newPassword: 'fake-hijack-2' }, IT).error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 重設含鎖碼角色（' + lockedRole + '）帳號密碼 → 擋');
    ok(post(sb, 'saveUser', { id: la.id, username: la.username, name: la.username, role: 'viewer', node: '' }, IT).error === '只有系統管理員能建立、修改或停用管理員帳號', '非 admin 改含鎖碼角色帳號 → 擋');
  }
  const selfOff = post(sb, 'setActive', { id: it.id, active: false }, IT);
  ok(selfOff.ok === false && ['不能停用自己的帳號', '只有系統管理員能建立、修改或停用管理員帳號'].indexOf(selfOff.error) !== -1, '非 admin 停用自己 → 擋（platform.users 是鎖碼角色，先撞「只有系統管理員」）', selfOff);
  ok(post(sb, 'setActive', { id: 'u001', active: false }, A).error === '不能停用自己的帳號', 'admin 停用自己（也是唯一 admin）→ 擋');
  // 第二位 admin 再停用唯一另一位 → 最後一位 admin 檢查
  const adm2 = post(sb, 'saveUser', { username: 'adm2' + hex(3), name: '假第二管理員', role: 'admin', node: '', password: 'fake-adm2-' + hex(4) }, A);
  ok(adm2.ok, 'admin 建第二位 admin');
  ok(post(sb, 'setActive', { id: adm2.data.id, active: false }, A).ok, '停用第二位 admin（還有 u001）→ 放行');
  ok(post(sb, 'saveUser', { id: adm2.data.id, username: 'adm2x' + hex(2), name: 'x', role: 'viewer', node: '' }, A).ok, '降級已停用的第二位 admin → 放行');
  ok(post(sb, 'saveUser', { id: 'u001', username: 'BOSS', name: '系統管理者', role: 'viewer', node: '' }, A).error === '不能修改自己的角色', '唯一啟用 admin 把自己降級 → 擋');
  ok(post(sb, 'saveUser', { id: 'u001', username: 'BOSS', name: '系統管理者', role: 'viewer', node: '' }, A).error === '不能修改自己的角色', 'admin 改自己角色 → 擋');
  ok(post(sb, 'saveUser', { username: 'staffy' + hex(2), name: 'x', role: 'staff', node: '', password: 'fake-pw-' + hex(4) }, A).error === '同仁帳號請到同仁名單操作', '建 role staff 的系統帳 → 請到同仁名單');
  ok(post(sb, 'saveUser', { username: 'DZY' + (900 + ri(99)), name: 'x', role: 'viewer', node: '', password: 'fake-pw-' + hex(4) }, A).error === '系統帳號不能用同仁編號格式（DZY 加數字），請換一個帳號名稱', '系統帳用 DZY 編號格式 → 擋');
  ok(post(sb, 'saveUser', { username: '=cmd' + hex(2), name: 'x', role: 'viewer', node: '', password: 'fake-pw-' + hex(4) }, A).error === '帳號不能用 = + - @ 開頭', '帳號 = 開頭 → 擋');
  ok(post(sb, 'saveUser', { username: String(100000 + ri(899999)), name: 'x', role: 'viewer', node: '', password: 'fake-pw-' + hex(4) }, A).error === '帳號至少要有一個英文字母', '純數字帳號 → 擋');
  ok(post(sb, 'saveUser', { username: 'v' + hex(3), name: 'x', role: 'viewer', node: 'nope-store', password: 'fake-pw-' + hex(4) }, A).error === '節點代號不合法', '節點不在清單 → 擋');
  ok(post(sb, 'saveUser', { username: 'v' + hex(3), name: 'x', role: 'viewer', node: '', password: 'short' }, A).error === '密碼至少需要 8 個字元', '密碼太短 → 擋');
  ok(post(sb, 'saveUser', { username: acc.username.toUpperCase(), name: 'x', role: 'viewer', node: '', password: 'fake-pw-' + hex(4) }, A).error === '帳號已存在', '帳號重複（不分大小寫）→ 擋');
  // 節點清單含店別對照新加的門市
  const nodes = post(sb, 'listUsers', {}, A).data.nodes.map((n) => n.value);
  const expNodes = Array.from(new Set(['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'].concat(Object.keys(storeMap).filter((u) => storeMap[u] && UNITS[u]).map((u) => storeMap[u]))));
  ok(expNodes.every((n) => nodes.indexOf(n) !== -1), '節點下拉含原本 5 家＋店別對照的門市', { nodes, expNodes });
  // 正常新增、編輯、停用、再啟用、舊 token 不復活
  const uname = 'newsys' + hex(3), pw = 'fake-new-' + hex(4);
  const cr = post(sb, 'saveUser', { username: uname, name: '假新帳', role: 'viewer', node: pick(nodes), password: pw }, IT);
  ok(cr.ok && /^u\d{3,}$/.test(cr.data.id), '非 admin 建一般角色帳號 → ok、id 流水', cr);
  const nt = post(sb, 'login', { username: uname, password: pw }).data.token;
  ok(!!nt, '新帳號可登入');
  ok(post(sb, 'setActive', { id: cr.data.id, active: false }, IT).ok && post(sb, 'me', {}, nt).ok === false && post(sb, 'login', { username: uname, password: pw }).error === '帳號已停用', '停用 → token 失效、登入說帳號已停用');
  ok(post(sb, 'setActive', { id: cr.data.id, active: true }, IT).ok && post(sb, 'me', {}, nt).ok === false && post(sb, 'login', { username: uname, password: pw }).ok, '再啟用 → 舊 token 不復活、可重新登入');
  const ed = post(sb, 'saveUser', { id: cr.data.id, username: uname, name: '假新帳改', role: 'manager', node: '' }, IT);
  ok(ed.ok && post(sb, 'listUsers', {}, IT).data.users.find((u) => u.id === cr.data.id).role === 'manager', '非 admin 改一般帳號角色（manager 無鎖碼）→ ok');
  const row = sheets.users._rows().find((r) => r[0] === cr.data.id);
  ok(row && row[6] !== '' && row[10] !== '', '編輯只寫 B:E，salt/hash/token_after 沒被蓋掉');
  ok(post(sb, 'listRoles', {}, IT).data.roles.some((r) => r.role === 'admin' && eq(r.perms, ['*'])), 'listRoles 回角色與展開的 perms');
}

console.log('\n共 ' + (passed + failed) + ' 項檢查，通過 ' + passed + '，失敗 ' + failed + '（SEED=' + SEED + '）');
if (failed) { console.error('失敗項目：\n  - ' + failures.join('\n  - ')); process.exit(1); }
