// node test/staff.mock.test.mjs —— 個人帳號管理第一期後端驗收（docs/personnel/task.md A1–A8）
// 做法同 users.mock.test.mjs：把 Auth.gs／Users.gs／Staff.gs／Code.gs 讀進同一個 vm sandbox，
// 全程走 doPost（跟正式環境同一條路）。
// ⚠ 所有姓名、生日、手機、地址都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件 ──────────────────────────────────────────────
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
  const props = { HMAC_SECRET: 'fake-hmac-for-staff-tests' };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
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
  return { sb: sandbox, sheets, cache };
}

function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
function freshSeed(sbForHash) {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, sbForHash.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', salt, sbForHash.hashPassword_('fake-acc-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;

function fresh() {
  const app = load(freshSeed(HASHER));
  app.sb.setupStaff();
  return app;
}
function adminToken(sb) {
  const r = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW });
  if (!r.ok) throw new Error('admin login 失敗 ' + r.error);
  return r.data.token;
}
const FAKE_NAMES = ['測試甲', '測試乙', '測試丙', '測試丁'];
const PROFILE = { brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' };
function seedAndClaim(sb, tok, who) {
  post(sb, 'staffImport', { names: FAKE_NAMES }, tok);
  const lk = post(sb, 'claimLookup', { name: who || '測試甲' });
  const r = post(sb, 'claimSubmit', Object.assign({ name: who || '測試甲', emp_no: lk.data.emp_no, password: 'fake-staff-pw-1' }, PROFILE));
  return { emp: lk.data.emp_no, claim: r };
}
const staffRow = (sheets, emp) => sheets.staff._rows().find((r) => r[0] === emp);
const COL = (h) => HASHER.STF_HEADERS.indexOf(h);

// ============================================================
// A1 setupStaff
// ============================================================
(() => {
  const { sb, sheets } = load(freshSeed(HASHER));
  sb.setupStaff();
  sb.setupStaff(); // 重跑
  ok(sheets.staff._rows()[0].join() === sb.STF_HEADERS.join(), 'A1 staff 表頭逐字');
  ok(sheets.org._rows().length === 1 + sb.STF_DEFAULT_ORG.length, 'A1 org 預設列只寫一次（重跑不重複）');
  ok(sheets.roles._rows().find((r) => r[0] === 'staff')[2] === 'platform.self', 'A1 既有 roles.staff perms 被 upsert 成 platform.self');
  ok(sheets.roles._rows().length === 4, 'A1 roles 其他列不變、沒新增重複列');
  ok(sheets.users._rows()[0][10] === 'token_after', 'A1 users 補第 11 欄表頭');
  ok(sheets.users._rows()[1][1] === 'BOSS', 'A1 既有帳號資料不變');
})();

// ============================================================
// A2 驗證
// ============================================================
(() => {
  const { sb } = fresh();
  const org = sb.stfReadOrg_();
  const v = (o) => sb.stfValidateOrg_(org, Object.assign({ brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt' }, o));
  ok(v({}) === null, 'A2 正確組合通過');
  ok(v({ unit: 'mala-gf' }) !== null, 'A2 單位不屬於品牌 → 擋');
  ok(v({ title: 'hs' }) !== null, 'A2 門市單位選總部職稱 → 擋');
  ok(v({ unit: 'mzt-hq', title: 'hs' }) === null, 'A2 總部單位用總部職稱、沒有部門清單時不必選部門');
  ok(v({ unit: 'mzt-hq', title: 'hs', dept: 'x' }) !== null, 'A2 沒有部門清單時填了部門 → 擋');
  sb.SpreadsheetApp.getActive().getSheetByName('org').appendRow(['dept', 'acct', '會計部', 'dzy-hq', '', '', 1, 'TRUE']);
  const org2 = sb.stfReadOrg_();
  ok(sb.stfValidateOrg_(org2, { brand: 'dzy', unit: 'dzy-hq', dept: '', title: 'hs' }) !== null, 'A2 有部門清單時部門必填');
  ok(sb.stfValidateOrg_(org2, { brand: 'dzy', unit: 'dzy-hq', dept: 'acct', title: 'hs' }) === null, 'A2 有部門清單時選對部門通過');
  ok(sb.stfValidateBirthday_('1995-02-30') !== null, 'A2 不存在的日期擋');
  ok(sb.stfValidateBirthday_('1995-02-28') === null, 'A2 正常生日通過');
  ok(sb.stfValidatePhone_('0911222333') === null && sb.stfValidatePhone_('0211222333') !== null, 'A2 手機 09 開頭 10 碼');
  ok(sb.stfValidatePassword_('dzy001ab', 'DZY001') === null && sb.stfValidatePassword_('dzy00100', 'DZY001') === null, 'A2 密碼 8 碼以上通過');
  ok(sb.stfValidatePassword_('Dzy001', 'DZY001') !== null, 'A2 密碼太短擋');
  ok(sb.stfPhone_(911222333) === '0911222333', 'A2 手機被存成數字仍補回 10 碼');
})();

// ============================================================
// A3 匯入
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const pv = post(sb, 'staffImport', { names: FAKE_NAMES, preview: true }, tok);
  ok(pv.ok && pv.data.created[0].emp_no === 'DZY001' && pv.data.created[3].emp_no === 'DZY004', 'A3 預覽編號 DZY001～DZY004');
  ok(sheets.staff._rows().length === 1, 'A3 預覽不寫入');
  const r = post(sb, 'staffImport', { names: FAKE_NAMES }, tok);
  ok(r.ok && sheets.staff._rows().length === 5, 'A3 匯入 4 筆', r);
  ok(staffRow(sheets, 'DZY001')[2] === '測試甲' && staffRow(sheets, 'DZY001')[3] === 'unclaimed', 'A3 順序與狀態');
  ok(sheets.users._rows().filter((u) => u[3] === 'staff').length === 4, 'A3 users 建 4 個 staff 帳號');
  ok(new Set(sheets.users._rows().slice(1).map((u) => u[0])).size === 6, 'A3 users.id 不重複');
  ok(!post(sb, 'staffImport', { names: ['測試甲'] }, tok).ok, 'A3 與未認領者同名 → 拒絕');
  ok(!post(sb, 'staffImport', { names: ['新人', '新人'] }, tok).ok, 'A3 名單內重複 → 拒絕');
  ok(sheets.staff._rows().length === 5, 'A3 被拒時一筆都沒寫');
  const add = post(sb, 'staffAdd', { name: '新人' }, tok);
  ok(add.ok && add.data.created[0].emp_no === 'DZY005', 'A3 新增接下一號 DZY005');
  const acc = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  ok(post(sb, 'staffImport', { names: ['某人'] }, acc).error === '沒有權限', 'A3 沒有 platform.staff 被擋');
  ok(!post(sb, 'listUsers', {}, tok).data.users.some((u) => u.role === 'staff'), 'A3 人員管理清單不列 staff 帳號');
})();

// ============================================================
// A4 認領＋登入
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  post(sb, 'staffImport', { names: FAKE_NAMES }, tok);
  ok(post(sb, 'claimLookup', { name: '不存在' }).error === '名單上找不到這個名字，請找後台', 'A4 查無姓名');
  const lk = post(sb, 'claimLookup', { name: ' 測試甲 ' });
  ok(lk.ok && lk.data.emp_no === 'DZY001' && Object.keys(lk.data).length === 1, 'A4 查到只回編號');
  ok(post(sb, 'login', { username: 'DZY001', password: 'whatever1' }).error === '這個編號還沒開通，請按「第一次使用」', 'A4 未認領登入回專屬訊息');
  ok(!post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'DZY002', password: 'fake-staff-pw-1' }, PROFILE)).ok, 'A4 姓名與編號對不上 → 擋');
  ok(!post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'DZY001', password: 'short' }, PROFILE)).ok, 'A4 密碼太短 → 擋');
  ok(!post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: 'fake-staff-pw-1', unit: 'yiwu-js' })).ok, 'A4 單位不屬於品牌 → 擋');
  const r = post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'dzy001', password: 'fake-staff-pw-1' }, PROFILE));
  ok(r.ok && r.data.token && r.data.perms.join() === 'platform.self', 'A4 認領成功直接登入，權限只有 platform.self', r);
  const row = staffRow(sheets, 'DZY001');
  ok(row[COL('status')] === 'pending' && row[COL('p_unit')] === 'mzt-gf' && row[COL('unit')] === '', 'A4 狀態 pending、組織欄進 p_*');
  ok(sheets.staff._fmt[2] === '@', 'A4 寫入前該列設成純文字');
  ok(post(sb, 'claimLookup', { name: '測試甲' }).error === '這個名字已經開通，請用編號登入', 'A4 已認領的名字');
  ok(!post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'DZY001', password: 'attacker-pw-1' }, PROFILE)).ok, 'A4 已認領後不能再認領一次');
  ok(post(sb, 'login', { username: 'dzy001', password: 'fake-staff-pw-1' }).ok, 'A4 小寫編號可登入');
  // 鎖定計數：大小寫共用
  for (let i = 0; i < 2; i++) post(sb, 'login', { username: 'dzy002', password: 'x1234567' });
  post(sb, 'login', { username: 'DZY002', password: 'x1234567' });
  ok(post(sb, 'login', { username: 'Dzy002', password: 'x1234567' }).error === '嘗試次數過多，請 15 分鐘後再試', 'A4 dzy002／DZY002 共用同一個鎖定計數（未認領也計入）');
  ok(post(sb, 'login', { username: 'boss', password: ADMIN_PW }).ok === false, 'A4 非 DZY 帳號維持原樣比對（boss ≠ BOSS）');
  ok(post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).ok, 'A4 BOSS 原樣可登入');
})();

// ============================================================
// A5 本人資料
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const { claim } = seedAndClaim(sb, tok);
  const me = claim.data.token;
  const p = post(sb, 'myProfile', {}, me);
  ok(p.ok && p.data.emp_no === 'DZY001' && p.data.birthday === '1995-05-05' && !('reset_locked' in p.data), 'A5 myProfile 回自己、不含 reset 欄');
  ok(post(sb, 'myProfile', {}, tok).data.none === true, 'A5 系統帳號（admin）沒有 staff 列 → none');
  // 夾帶別人的 emp_no
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { emp_no: 'DZY002', user_id: 'u004', phone: '0999888777' }), me);
  ok(staffRow(sheets, 'DZY001')[COL('phone')] === '0999888777' && staffRow(sheets, 'DZY002')[COL('phone')] === '', 'A5 payload 夾帶 emp_no 被忽略，只改到自己');
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { birthday: '2000-01-01' }), me);
  ok(staffRow(sheets, 'DZY001')[COL('birthday')] === '1995-05-05', 'A5 本人改不了生日');
  post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok);
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { title: 'ft' }), me);
  const row = staffRow(sheets, 'DZY001');
  ok(row[COL('title')] === 'pt' && row[COL('p_title')] === 'ft', 'A5 已開通改職稱只進 p_*，正式值不變');
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE), me);
  ok(staffRow(sheets, 'DZY001')[COL('p_title')] === '', 'A5 改回跟正式值一樣 → p_* 清空');
  ok(post(sb, 'myUnit', {}, me).error.indexOf('只有店長') === 0, 'A5 計時同仁看不到單位通訊錄');
  post(sb, 'staffEdit', { emp_no: 'DZY001', title: 'sm' }, tok);
  const u = post(sb, 'myUnit', {}, me);
  ok(u.ok && u.data.people.length === 1 && !('birthday' in u.data.people[0]) && !('address' in u.data.people[0]), 'A5 店長看得到同單位，不含生日地址', u);
  const logs = sheets.staff_log._rows().map((r) => r.join('|')).join('\n');
  ok(logs.indexOf('0999888777') === -1 && logs.indexOf('1995-05-05') === -1 && logs.indexOf('測試路') === -1, 'A5 staff_log 不含個資');
})();

// ============================================================
// A6 後台狀態轉移＋token 撤銷
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const { claim } = seedAndClaim(sb, tok);
  const me = claim.data.token;
  ok(post(sb, 'staffReject', { emp_no: 'DZY001' }, tok).error === '請填寫退回原因', 'A6 退回要原因');
  ok(post(sb, 'staffReject', { emp_no: 'DZY001', reason: '單位選錯' }, tok).ok && staffRow(sheets, 'DZY001')[COL('status')] === 'rejected', 'A6 pending → rejected');
  post(sb, 'saveMyProfile', PROFILE, me);
  ok(staffRow(sheets, 'DZY001')[COL('status')] === 'pending' && staffRow(sheets, 'DZY001')[COL('reject_reason')] === '', 'A6 rejected 重送 → pending、清原因');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok).ok && staffRow(sheets, 'DZY001')[COL('unit')] === 'mzt-gf', 'A6 確認：p_* 搬進正式欄');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok).error === '這位同仁沒有待確認的資料', 'A6 沒有待確認時不能再確認');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY002' }, tok).ok === false, 'A6 unclaimed 不能確認');
  // 停用／啟用
  post(sb, 'staffSetActive', { emp_no: 'DZY001', active: false }, tok);
  ok(staffRow(sheets, 'DZY001')[COL('status')] === 'disabled' && post(sb, 'myProfile', {}, me).ok === false, 'A6 停用後舊登入失效');
  post(sb, 'staffSetActive', { emp_no: 'DZY001', active: true }, tok);
  ok(staffRow(sheets, 'DZY001')[COL('status')] === 'active', 'A6 啟用回到停用前的 active');
  post(sb, 'staffSetActive', { emp_no: 'DZY003', active: false }, tok);
  post(sb, 'staffSetActive', { emp_no: 'DZY003', active: true }, tok);
  ok(staffRow(sheets, 'DZY003')[COL('status')] === 'unclaimed', 'A6 unclaimed 停用再啟用仍是 unclaimed（Fable 第 9 條）');
  // 冒用撤回：舊 token 不能讀真人重新認領後的資料
  const lk2 = post(sb, 'claimLookup', { name: '測試乙' });
  const imp = post(sb, 'claimSubmit', Object.assign({ name: '測試乙', emp_no: lk2.data.emp_no, password: 'impostor-pw-1' }, PROFILE)).data.token;
  ok(post(sb, 'staffUnclaim', { emp_no: 'DZY002' }, tok).ok && staffRow(sheets, 'DZY002')[COL('status')] === 'unclaimed' && staffRow(sheets, 'DZY002')[COL('phone')] === '', 'A6 撤回認領：回 unclaimed、清個資');
  const real = post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試乙', emp_no: 'DZY002', password: 'real-owner-pw-1', phone: '0955666777' }));
  ok(real.ok, 'A6 真人可重新認領');
  const leak = post(sb, 'myProfile', {}, imp);
  ok(leak.ok === false, 'A6 ★冒用者的舊 token 讀不到真人資料（Fable 第 1 條）', leak);
  ok(post(sb, 'myProfile', {}, real.data.token).ok, 'A6 真人新 token 可用');
  ok(post(sb, 'staffEdit', { emp_no: 'DZY001', birthday: '1990-01-01', name: '測試甲改' }, tok).ok && sheets.users._rows().find((u) => u[1] === 'DZY001')[2] === '測試甲改', 'A6 後台改姓名同步 users');
})();

// ============================================================
// A7 忘記密碼＋限流
// ============================================================
(() => {
  const { sb, sheets, cache } = fresh();
  const tok = adminToken(sb);
  const { claim } = seedAndClaim(sb, tok);
  const oldTok = claim.data.token;
  const bad = { emp_no: 'DZY001', birthday: '1995-05-06', phone: '0911222333', new_password: 'new-pw-12345' };
  ok(post(sb, 'forgotReset', { emp_no: 'DZY009', birthday: '1995-05-05', phone: '0911222333', new_password: 'new-pw-12345' }).error === '資料不符，請確認或找後台', 'A7 不存在的編號回同一句');
  ok(post(sb, 'forgotReset', { emp_no: 'DZY002', birthday: '', phone: '', new_password: 'new-pw-12345' }).error === '資料不符，請確認或找後台', 'A7 未認領回同一句');
  for (let i = 0; i < 4; i++) post(sb, 'forgotReset', bad);
  const r5 = post(sb, 'forgotReset', bad);
  ok(r5.error === '資料不符，請確認或找後台' && !/\d/.test(r5.error), 'A7 不回剩餘次數');
  ok(post(sb, 'forgotReset', Object.assign({}, bad, { birthday: '1995-05-05' })).error === '錯太多次，請 1 小時後再試，或找後台', 'A7 錯 5 次鎖 1 小時，對的也不給過');
  ok(post(sb, 'staffList', {}, tok).data.staff.find((s) => s.emp_no === 'DZY001').reset_locked === true, 'A7 後台看得到鎖住');
  // 模擬一小時後：把 reset_lock_until 改成過去，再錯滿兩輪 → 第 3 次變後台鎖
  const rowIdx = sheets.staff._data.findIndex((r) => r[0] === 'DZY001');
  for (let round = 0; round < 2; round++) {
    sheets.staff._data[rowIdx][COL('reset_lock_until')] = Math.floor(Date.now() / 1000) - 10;
    for (let i = 0; i < 5; i++) post(sb, 'forgotReset', bad);
  }
  sheets.staff._data[rowIdx][COL('reset_lock_until')] = Math.floor(Date.now() / 1000) - 10;
  ok(post(sb, 'forgotReset', Object.assign({}, bad, { birthday: '1995-05-05' })).error === '忘記密碼已鎖住，請找後台解鎖', 'A7 24 小時內第 3 次時間鎖 → 要後台解');
  post(sb, 'staffUnlockReset', { emp_no: 'DZY001' }, tok);
  // 手機被試算表存成數字
  sheets.staff._data[rowIdx][COL('phone')] = 911222333;
  const okr = post(sb, 'forgotReset', Object.assign({}, bad, { birthday: '1995-05-05' }));
  ok(okr.ok, 'A7 解鎖後生日＋手機對 → 重設成功（手機存成數字也比對得上）', okr);
  ok(post(sb, 'myProfile', {}, oldTok).ok === false, 'A7 重設後舊登入失效');
  ok(post(sb, 'login', { username: 'DZY001', password: 'new-pw-12345' }).ok, 'A7 新密碼可登入');
  ok(sheets.login_log._rows().filter((r) => r[1] === 'DZY001' && r[3] === 'ok').length >= 2, 'A7 認領與重設都寫進 login_log');
  // 姓名查無限流
  for (let i = 0; i < 5; i++) post(sb, 'claimLookup', { name: '亂試的名字' });
  ok(post(sb, 'claimLookup', { name: '亂試的名字' }).error === '操作太頻繁，請稍後再試', 'A7 同一姓名查無 5 次 → 限流');
  ok(post(sb, 'claimLookup', { name: '測試丙' }).ok, 'A7 其他人不受影響');
  cache.set('stf_global', { v: '600', exp: null });
  ok(post(sb, 'claimLookup', { name: '測試丙' }).error === '操作太頻繁，請稍後再試', 'A7 全域 600 上限');
})();

// ============================================================
// A8 Code.gs
// ============================================================
(() => {
  const { sb } = fresh();
  ['claimSubmit', 'forgotReset', 'saveMyProfile', 'staffImport', 'staffAdd', 'staffConfirm', 'staffReject',
    'staffSetActive', 'staffUnclaim', 'staffUnlockReset', 'staffEdit'].forEach((a) => {
    ok(sb.CODE_ALLOWED_ACTIONS.indexOf(a) !== -1, 'A8 白名單有 ' + a);
  });
  const src = SRC.find(([f]) => f === 'Code.gs')[1];
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(src)[1];
  ['claimSubmit', 'forgotReset', 'saveMyProfile', 'staffImport', 'staffAdd', 'staffConfirm', 'staffReject',
    'staffSetActive', 'staffUnclaim', 'staffUnlockReset', 'staffEdit'].forEach((a) => {
    ok(mut.indexOf(a + ': 1') !== -1, 'A8 ' + a + ' 有上寫入鎖');
  });
  ok(post(sb, 'nope', {}).error === '不支援的操作', 'A8 未知 action 照舊拒絕');
  ok(post(sb, 'orgOptions', {}).data.units.length === 13, 'A8 orgOptions 不需登入即可取得下拉');
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
