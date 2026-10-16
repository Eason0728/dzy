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
  return { sb: sandbox, sheets, cache, props };
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
// 2026-10-12：認領後要審核通過才開通——這裡用後台確認（staffConfirm）開通後再登入，
// 回傳形狀維持 { emp, claim:{data:{token}} } 讓既有測試不必改
function claimAndApprove(sb, tok, who, pw, profile) {
  const lk = post(sb, 'claimLookup', { name: who });
  const sub = post(sb, 'claimSubmit', Object.assign({ name: who, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, profile || PROFILE));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, tok);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  const lg = post(sb, 'login', { username: lk.data.emp_no, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('開通後登入失敗 ' + lg.error);
  return { emp: lk.data.emp_no, claim: lg };
}
function seedAndClaim(sb, tok, who) {
  post(sb, 'staffImport', { names: FAKE_NAMES }, tok);
  return claimAndApprove(sb, tok, who || '測試甲');
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
  ok(v({ unit: 'mzt-hq', title: 'ofs' }) === null, 'A2 品牌辦公室用 office 職稱、不必選部門');
  ok(v({ unit: 'mzt-hq', title: 'ofs', dept: 'x' }) !== null, 'A2 品牌辦公室填了部門 → 擋');
  ok(org.list.dept.length === 10 && org.list.dept.some((d) => d.code === 'mgmt' && d.name === '管理部') && org.list.dept.every((d) => d.parent === 'dzy-hq'), 'A2 預設十個部門（含管理部）、全部掛鼎兆元總部');
  ok(v({ brand: 'dzy', unit: 'dzy-hq', dept: '', title: 'hs' }) !== null, 'A2 鼎兆元總部有部門清單 → 部門必填');
  ok(v({ brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs' }) === null, 'A2 鼎兆元總部選對部門通過');
  ok(v({ brand: 'mala', unit: 'mala-hq', dept: '', title: 'osv' }) === null, 'A2 小辛辣品牌辦公室沒有部門 → 不必選');
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
  ok(r.ok && r.pending === true && r.data.pending === true && !r.data.token && !('token' in r) && !r.data.perms, 'A4 ★認領送出不回 token、不自動登入（等主管審核）', r);
  const row = staffRow(sheets, 'DZY001');
  ok(row[COL('status')] === 'pending' && row[COL('p_unit')] === 'mzt-gf' && row[COL('unit')] === '', 'A4 狀態 pending、組織欄進 p_*');
  ok(sheets.staff._fmt[2] === '@', 'A4 寫入前該列設成純文字');
  ok(post(sb, 'claimLookup', { name: '測試甲' }).error === '這個名字已經送出開通申請，等單位主管審核通過就能用編號登入', 'A4 已送出待審的名字');
  ok(!post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'DZY001', password: 'attacker-pw-1' }, PROFILE)).ok, 'A4 已認領後不能再認領一次');
  ok(post(sb, 'login', { username: 'dzy001', password: 'fake-staff-pw-1' }).error === '帳號還在等主管審核', 'A4 ★待審核登入被擋，訊息說明原因');
  ok(post(sb, 'login', { username: 'dzy001', password: 'wrong-pw-123' }).error === '帳號或密碼錯誤', 'A4 待審核＋密碼錯 → 照舊回帳密錯（不先洩漏狀態）');
  post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok);
  const lg = post(sb, 'login', { username: 'dzy001', password: 'fake-staff-pw-1' });
  ok(lg.ok && lg.data.perms.join() === 'platform.self', 'A4 審核通過後小寫編號可登入，權限只有 platform.self', lg);
  // 鎖定計數：大小寫共用
  for (let i = 0; i < 2; i++) post(sb, 'login', { username: 'dzy002', password: 'x1234567' });
  post(sb, 'login', { username: 'DZY002', password: 'x1234567' });
  ok(post(sb, 'login', { username: 'Dzy002', password: 'x1234567' }).error === '嘗試次數過多，請 15 分鐘後再試', 'A4 dzy002／DZY002 共用同一個鎖定計數（未認領也計入）');
  // 2026-10-12 改：所有帳號登入都不分大小寫（人員管理建帳號防重複本來就不分大小寫，保證唯一）
  ok(post(sb, 'login', { username: 'boss', password: ADMIN_PW }).ok === true, 'A4 帳號不分大小寫（boss＝BOSS）');
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
  // 2026-10-12：改手機要帶 current_password
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { emp_no: 'DZY002', user_id: 'u004', phone: '0999888777', current_password: 'fake-staff-pw-1' }), me);
  ok(staffRow(sheets, 'DZY001')[COL('phone')] === '0999888777' && staffRow(sheets, 'DZY002')[COL('phone')] === '', 'A5 payload 夾帶 emp_no 被忽略，只改到自己');
  const PROFILE2 = Object.assign({}, PROFILE, { phone: '0999888777' }); // 手機已改，之後不帶密碼的呼叫維持新手機
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE2, { birthday: '2000-01-01' }), me);
  ok(staffRow(sheets, 'DZY001')[COL('birthday')] === '1995-05-05', 'A5 本人改不了生日');
  post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok);
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE2, { title: 'ft' }), me);
  const row = staffRow(sheets, 'DZY001');
  ok(row[COL('title')] === 'pt' && row[COL('p_title')] === 'ft', 'A5 已開通改職稱只進 p_*，正式值不變');
  post(sb, 'saveMyProfile', Object.assign({}, PROFILE2), me);
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
  ok(post(sb, 'staffReject', { emp_no: 'DZY001', reason: '單位選錯' }, tok).error === '這位同仁沒有待確認的資料', 'A6 已開通且沒有變更 → 不能退回');
  post(sb, 'claimSubmit', Object.assign({ name: '測試丙', emp_no: 'DZY003', password: 'fake-staff-pw-3' }, PROFILE));
  ok(post(sb, 'staffReject', { emp_no: 'DZY003' }, tok).error === '請填寫退回原因', 'A6 退回要原因');
  ok(post(sb, 'staffReject', { emp_no: 'DZY003', reason: '單位選錯' }, tok).ok, 'A6 後台退回認領待審');
  const rj = staffRow(sheets, 'DZY003');
  ok(rj[COL('status')] === 'unclaimed' && rj[COL('reject_reason')] === '單位選錯' && rj[COL('phone')] === '' && rj[COL('p_unit')] === '',
    'A6 退回＝回 unclaimed、清個資、留原因（可重新認領）');
  ok(sheets.users._rows().find((u) => u[1] === 'DZY003')[6] === '', 'A6 退回清掉密碼');
  ok(post(sb, 'claimLookup', { name: '測試丙' }).ok, 'A6 退回後可重新查到編號');
  ok(post(sb, 'claimSubmit', Object.assign({ name: '測試丙', emp_no: 'DZY003', password: 'fake-staff-pw-3' }, PROFILE)).ok &&
    staffRow(sheets, 'DZY003')[COL('reject_reason')] === '', 'A6 重新認領 → pending、清原因');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY003' }, tok).ok && staffRow(sheets, 'DZY003')[COL('unit')] === 'mzt-gf', 'A6 確認：p_* 搬進正式欄');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok).error === '這位同仁沒有待確認的資料', 'A6 沒有待確認時不能再確認');
  ok(post(sb, 'staffConfirm', { emp_no: 'DZY002' }, tok).ok === false, 'A6 unclaimed 不能確認');
  // 停用／啟用
  post(sb, 'staffSetActive', { emp_no: 'DZY001', active: false }, tok);
  ok(staffRow(sheets, 'DZY001')[COL('status')] === 'disabled' && post(sb, 'myProfile', {}, me).ok === false, 'A6 停用後舊登入失效');
  post(sb, 'staffSetActive', { emp_no: 'DZY001', active: true }, tok);
  ok(staffRow(sheets, 'DZY001')[COL('status')] === 'active', 'A6 啟用回到停用前的 active');
  post(sb, 'staffSetActive', { emp_no: 'DZY004', active: false }, tok);
  post(sb, 'staffSetActive', { emp_no: 'DZY004', active: true }, tok);
  ok(staffRow(sheets, 'DZY004')[COL('status')] === 'unclaimed', 'A6 unclaimed 停用再啟用仍是 unclaimed（Fable 第 9 條）');
  // 冒用撤回：舊 token 不能讀真人重新認領後的資料
  const imp = claimAndApprove(sb, tok, '測試乙', 'impostor-pw-1').claim.data.token; // 冒用者騙過審核、已登入
  ok(post(sb, 'staffUnclaim', { emp_no: 'DZY002' }, tok).ok && staffRow(sheets, 'DZY002')[COL('status')] === 'unclaimed' && staffRow(sheets, 'DZY002')[COL('phone')] === '', 'A6 撤回認領：回 unclaimed、清個資');
  const real = claimAndApprove(sb, tok, '測試乙', 'real-owner-pw-1', Object.assign({}, PROFILE, { phone: '0955666777' })).claim;
  ok(real.ok, 'A6 真人可重新認領（審核後登入）');
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
  ok(post(sb, 'forgotReset', Object.assign({}, bad, { birthday: '1995-05-05' })).error === '忘記密碼已鎖住，請找後台解鎖，或 24 小時後再試', 'A7 24 小時內第 3 次時間鎖 → 鎖 24 小時（後台可提早解）');
  const until = sheets.staff._data[rowIdx][COL('reset_lock_until')];
  ok(until - Math.floor(Date.now() / 1000) > 23 * 3600, 'A7 第 3 次鎖的到期是 24 小時後');
  sheets.staff._data[rowIdx][COL('reset_lock_until')] = Math.floor(Date.now() / 1000) - 10;
  ok(post(sb, 'forgotReset', Object.assign({}, bad, { birthday: '1995-05-05', new_password: 'auto-unlock-1' })).ok, 'A7 24 小時到了自動解鎖，不必後台（GPT 第 6 條）');
  ok(sheets.staff._data[rowIdx][COL('reset_locked')] === '', 'A7 自動解鎖後旗標清掉');
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
  cache.set('stf_g_lookup_' + Math.floor(Date.now() / 1000 / 600), { v: '600', exp: null });
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
  ok(post(sb, 'orgOptions', {}).data.units.length === 11, 'A8 orgOptions 不需登入即可取得下拉（停用的三店不列）');
})();

// ============================================================
// A9 上線前關（Fable 2026-10-11）抓到的問題，各一個回歸測試
// ============================================================
(() => {
  const { sb, sheets, cache } = fresh();
  const tok = adminToken(sb);
  // 第 1 條：setupStaff 加了第 11 欄後，人員管理編輯（含 admin → BOSS 改名）不能壞
  const ed = post(sb, 'saveUser', { id: 'u002', username: 'acc1', name: '假會計改', role: 'accountant', node: '' }, tok);
  ok(ed.ok, 'A9-1 跑過 setupStaff 後人員管理編輯仍正常', ed);
  const rn = post(sb, 'saveUser', { id: 'u001', username: 'BOSS2', name: '系統管理者', role: 'admin', node: '' }, tok);
  ok(rn.ok && sheets.users._rows()[1][1] === 'BOSS2', 'A9-1 系統管理員帳號可以改名');
  post(sb, 'saveUser', { id: 'u001', username: 'BOSS', name: '系統管理者', role: 'admin', node: '' }, tok);
  // 第 5 條：系統帳號重設密碼／停用再啟用，舊 token 失效
  const accTok = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  post(sb, 'resetPassword', { id: 'u002', newPassword: 'fake-acc-pw-02' }, tok);
  ok(post(sb, 'me', {}, accTok).ok === false, 'A9-5 admin 重設密碼後對方舊 token 失效');
  const accTok2 = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-02' }).data.token;
  post(sb, 'setActive', { id: 'u002', active: false }, tok);
  post(sb, 'setActive', { id: 'u002', active: true }, tok);
  ok(post(sb, 'me', {}, accTok2).ok === false, 'A9-5 停用再啟用後舊 token 不復活');
  // 第 6 條：人員管理手動建過 DZY 帳號 → 匯入不撞號
  // 2026-10-12：saveUser 不再能建 role staff（同仁帳號只走同仁名單），改用系統角色建一個 DZY 名稱的帳號
  post(sb, 'saveUser', { username: 'DZY001', name: '手動建的', role: 'accountant', node: '', password: 'manual-pw-123' }, tok);
  const im = post(sb, 'staffImport', { names: ['測試甲'] }, tok);
  ok(im.ok && im.data.created[0].emp_no === 'DZY002', 'A9-6 已有 DZY001 帳號 → 匯入從 DZY002 起', im);
  ok(sheets.users._rows().filter((u) => u[1] === 'DZY002').length === 1, 'A9-6 users 沒有重複帳號');
  // 第 2 條：生日手機對、密碼亂打 → 訊息不能跟「資料不符」不同到可以當探測器
  const lk = post(sb, 'claimLookup', { name: '測試甲' });
  post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: lk.data.emp_no, password: 'fake-staff-pw-1' }, PROFILE));
  const rightBadPw = post(sb, 'forgotReset', { emp_no: 'DZY002', birthday: '1995-05-05', phone: '0911222333', new_password: 'x' });
  const wrongBadPw = post(sb, 'forgotReset', { emp_no: 'DZY002', birthday: '1990-01-01', phone: '0911222333', new_password: 'x' });
  ok(rightBadPw.error === wrongBadPw.error, 'A9-2 密碼不合規時，生日手機對錯回一樣的訊息', [rightBadPw, wrongBadPw]);
  // 第 4 條：三支各自一桶、被擋不計數
  const win = Math.floor(Date.now() / 1000 / 600);
  cache.set('stf_g_lookup_' + win, { v: '600', exp: null });
  ok(post(sb, 'claimLookup', { name: '測試丙' }).error === '操作太頻繁，請稍後再試', 'A9-4 查詢桶滿了被擋');
  ok(cache.get('stf_g_lookup_' + win).v === '600', 'A9-4 被擋的請求不再計數');
  ok(post(sb, 'forgotReset', { emp_no: 'DZY002', birthday: '1995-05-05', phone: '0911222333', new_password: 'new-pw-99999' }).ok, 'A9-4 查詢被刷爆時忘記密碼照常可用');
  // 第 9 條：表頭不一致 → 停，不覆寫
  sheets.staff._data[0][2] = '姓名被人改過';
  let threw = false;
  try { sb.setupStaff(); } catch (e) { threw = /表頭與程式不一致/.test(e.message); }
  ok(threw && sheets.staff._data[0][2] === '姓名被人改過', 'A9-9 表頭被改過 → setupStaff 停下、不覆寫');
})();

// A10 上線第一次：後台打開名單自動建分頁、upsert roles.staff
(() => {
  const { sb, sheets } = load(freshSeed(HASHER));
  const tok = adminToken(sb);
  ok(!sheets.staff, 'A10 開始時沒有 staff 分頁');
  const r = post(sb, 'staffList', {}, tok);
  ok(r.ok && r.data.staff.length === 0 && sheets.staff && sheets.org && sheets.staff_log, 'A10 後台第一次打開名單自動建三個分頁');
  ok(sheets.roles._rows().find((x) => x[0] === 'staff')[2] === 'platform.self', 'A10 roles.staff 同時 upsert');
  const acc = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  const { sb: sb2, sheets: sh2 } = load(freshSeed(HASHER));
  const acc2 = post(sb2, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  post(sb2, 'staffList', {}, acc2);
  ok(!sh2.staff, 'A10 沒權限的人呼叫不會觸發建表');
})();

// A11 GPT 上線前關的修正
(() => {
  const { sb, sheets, cache } = fresh();
  const tok = adminToken(sb);
  // 第 4 條：分頁還沒建就直接匯入 → 先建分頁，不留孤兒帳號
  const { sb: sb2, sheets: sh2 } = load(freshSeed(HASHER));
  const t2 = adminToken(sb2);
  const im = post(sb2, 'staffImport', { names: ['測試甲'] }, t2);
  ok(im.ok && sh2.staff && sh2.staff._rows().length === 2 && sh2.staff_log._rows().length === 2, 'A11-4 沒先開名單直接匯入：分頁自動建好，users／staff／log 一致', im);
  // 第 9 條：格式不對的請求不計入全域額度
  const win = Math.floor(Date.now() / 1000 / 600);
  for (let i = 0; i < 20; i++) post(sb, 'forgotReset', {});
  for (let i = 0; i < 20; i++) post(sb, 'claimLookup', { name: '' });
  ok(!cache.get('stf_g_forgot_' + win) && !cache.get('stf_g_lookup_' + win), 'A11-9 空請求不耗全域額度');
  // 第 12 條：編輯帳號只寫 B:E，不蓋掉 last_login_at
  post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' });
  const lastLogin = sheets.users._rows().find((u) => u[0] === 'u002')[9];
  ok(lastLogin !== '', 'A11-12 登入寫了 last_login_at');
  post(sb, 'saveUser', { id: 'u002', username: 'acc1', name: '改名會計', role: 'accountant', node: '' }, tok);
  const row = sheets.users._rows().find((u) => u[0] === 'u002');
  ok(row[2] === '改名會計' && row[9] === lastLogin && row[6] !== '', 'A11-12 編輯只改姓名等四格，登入時間與密碼不動');
  // 第 1 條：登入雜湊期間帳號被撤回 → 不簽 token（模擬：雜湊時偷改 hash）
  post(sb, 'staffImport', { names: ['測試乙'] }, tok);
  const lk = post(sb, 'claimLookup', { name: '測試乙' });
  post(sb, 'claimSubmit', Object.assign({ name: '測試乙', emp_no: lk.data.emp_no, password: 'race-pw-1234' }, PROFILE));
  const origHash = sb.hashPassword_;
  sb.hashPassword_ = function (pw, salt) {
    const h = origHash(pw, salt);
    const u = sheets.users._data.find((r) => r[1] === lk.data.emp_no);
    u[6] = ''; // 雜湊跑的同時被後台撤回認領
    return h;
  };
  const raced = post(sb, 'login', { username: lk.data.emp_no, password: 'race-pw-1234' });
  sb.hashPassword_ = origHash;
  ok(raced.ok === false, 'A11-1 雜湊期間被撤回 → 不簽發 token', raced);
})();

// ============================================================
// A12 認領後主管審核（Eason 2026-10-12：送交各單位主管審核完畢才開通）
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  // 名單：甲＝申請人（光復）、乙＝光復店長、丙＝他店（金山）店長、丁＝光復計時同仁、
  //       戊＝總部資訊部主管、己＝總部資訊部申請人、庚＝總部財務部申請人、辛＝光復第二位申請人
  post(sb, 'staffImport', { names: ['審甲', '審乙', '審丙', '審丁', '審戊', '審己', '審庚', '審辛'] }, tok);
  const emp = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  const HQ = (dept, title) => ({ brand: 'dzy', unit: 'dzy-hq', dept, title, birthday: '1990-03-03', phone: '0922333444', address: '新竹市測試總部路3號' });
  const tokB = claimAndApprove(sb, tok, '審乙', 'mgr-b-pw-1', Object.assign({}, PROFILE, { title: 'sm' })).claim.data.token;
  const tokC = claimAndApprove(sb, tok, '審丙', 'mgr-c-pw-1', Object.assign({}, PROFILE, { unit: 'mzt-js', title: 'sm' })).claim.data.token;
  const tokD = claimAndApprove(sb, tok, '審丁', 'crew-d-pw-1').claim.data.token;
  const tokE = claimAndApprove(sb, tok, '審戊', 'mgr-e-pw-1', HQ('it', 'hm')).claim.data.token;
  const sub = (n, pw, prof) => post(sb, 'claimSubmit', Object.assign({ name: n, emp_no: emp(n), password: pw }, prof || PROFILE));
  ok(sub('審甲', 'apply-a-pw-1').ok && sub('審己', 'apply-f-pw-1', HQ('it', 'hs')).ok && sub('審庚', 'apply-g-pw-1', HQ('fin', 'hs')).ok && sub('審辛', 'apply-h-pw-1').ok, 'A12 四位申請人送出');

  // 登入閘門＋衍生權限
  ok(post(sb, 'login', { username: emp('審甲'), password: 'apply-a-pw-1' }).error === '帳號還在等主管審核', 'A12 ★待審核登不進去');
  const lgB = post(sb, 'login', { username: emp('審乙'), password: 'mgr-b-pw-1' });
  ok(lgB.data.perms.indexOf('platform.review') !== -1, 'A12 店長登入帶 platform.review（讓待審核分頁出現）');
  ok(post(sb, 'login', { username: emp('審丁'), password: 'crew-d-pw-1' }).data.perms.join() === 'platform.self', 'A12 一般同仁沒有 platform.review');
  ok(post(sb, 'me', {}, tokB).data.perms.indexOf('platform.review') !== -1, 'A12 me 也帶 platform.review（重新整理後分頁還在）');

  // 待審名單
  const pB = post(sb, 'unitPending', {}, tokB);
  const a = pB.ok && pB.data.people.find((x) => x.emp_no === emp('審甲'));
  ok(a && a.birthday === '1995-05-05' && a.phone === '0911222333' && a.address === '新竹市測試路一段1號' && a.unit === 'mzt-gf' && a.title_name === '計時同仁', 'A12 ★同單位店長看得到待審名單，含生日手機地址與填的單位職稱', pB);
  ok(pB.data.people.map((x) => x.name).sort().join() === '審甲,審辛', 'A12 店長只看到自己單位的待審（不含他店、總部、已開通）', pB.data.people);
  ok(post(sb, 'unitPending', {}, tokC).data.people.length === 0, 'A12 ★他店店長看不到這家的待審');
  ok(post(sb, 'unitPending', {}, tokD).error === '只有單位主管可以審核', 'A12 ★一般同仁不能看待審名單');
  const pE = post(sb, 'unitPending', {}, tokE);
  ok(pE.ok && pE.data.people.map((x) => x.name).join() === '審己', 'A12 總部部門主管只看同單位同部門（資訊部看不到財務部）', pE);

  // 審核權限
  ok(post(sb, 'unitApprove', { emp_no: emp('審甲') }, tokC).error === '只有單位主管可以審核', 'A12 ★他店店長不能審');
  ok(post(sb, 'unitApprove', { emp_no: emp('審甲') }, tokD).error === '只有單位主管可以審核', 'A12 ★一般同仁不能審');
  ok(post(sb, 'unitApprove', { emp_no: emp('審乙') }, tokB).error === '不能審核自己', 'A12 ★不能審自己');
  ok(post(sb, 'unitApprove', { emp_no: emp('審庚') }, tokE).error === '只有單位主管可以審核', 'A12 總部資訊部主管不能審財務部');
  ok(post(sb, 'unitApprove', { emp_no: emp('審丁') }, tokB).error === '這位同仁不在等待審核', 'A12 已開通的人不能再審');
  ok(staffRow(sheets, emp('審甲'))[COL('status')] === 'pending', 'A12 被擋的審核沒有改到資料');

  // 退回 → 重新認領 → 通過 → 登入
  ok(post(sb, 'unitReject', { emp_no: emp('審甲') }, tokB).error === '請填寫退回原因', 'A12 退回要原因');
  ok(post(sb, 'unitReject', { emp_no: emp('審甲'), reason: '職稱填錯' }, tokB).ok, 'A12 同單位店長退回');
  const ra = staffRow(sheets, emp('審甲'));
  ok(ra[COL('status')] === 'unclaimed' && ra[COL('reject_reason')] === '職稱填錯' && ra[COL('birthday')] === '' && ra[COL('p_unit')] === '', 'A12 ★退回＝回未開通、清個資、留原因');
  ok(post(sb, 'login', { username: emp('審甲'), password: 'apply-a-pw-1' }).ok === false, 'A12 退回後舊密碼登不進去');
  ok(post(sb, 'claimLookup', { name: '審甲' }).data.emp_no === emp('審甲'), 'A12 ★退回後可以重新認領（查得到編號）');
  ok(sub('審甲', 'apply-a-pw-2').ok && staffRow(sheets, emp('審甲'))[COL('status')] === 'pending', 'A12 重新送出 → 待審');
  ok(post(sb, 'unitApprove', { emp_no: emp('審甲') }, tokB).ok, 'A12 ★同單位店長通過');
  const fa = staffRow(sheets, emp('審甲'));
  ok(fa[COL('status')] === 'active' && fa[COL('unit')] === 'mzt-gf' && fa[COL('p_unit')] === '' && fa[COL('confirmed_at')] !== '', 'A12 通過＝p_* 搬正式欄、status active');
  const la = post(sb, 'login', { username: emp('審甲'), password: 'apply-a-pw-2' });
  ok(la.ok && post(sb, 'myProfile', {}, la.data.token).data.status === 'active', 'A12 ★通過後可以登入');
  ok(post(sb, 'unitApprove', { emp_no: emp('審己') }, tokE).ok, 'A12 總部部門主管可審同部門');

  // 人資（platform.staff）一律可審（單位還沒有主管時的備援）
  sheets.roles._data.push(['hr', '人資', 'platform.staff']);
  post(sb, 'saveUser', { username: 'hr1', name: '假人資', role: 'hr', node: '', password: 'fake-hr-pw-01' }, tok);
  const tokHr = post(sb, 'login', { username: 'hr1', password: 'fake-hr-pw-01' }).data.token;
  const pHr = post(sb, 'unitPending', {}, tokHr);
  ok(pHr.ok && pHr.data.all_units === true && pHr.data.people.map((x) => x.name).sort().join() === '審庚,審辛', 'A12 人資看得到全部單位的待審', pHr);
  ok(post(sb, 'unitApprove', { emp_no: emp('審庚') }, tokHr).ok, 'A12 ★人資可審（財務部沒有主管也能開通）');
  ok(post(sb, 'unitApprove', { emp_no: emp('審辛') }, tok).ok, 'A12 admin（*）也可審');

  // 紀錄只寫事件不寫個資
  const logs = sheets.staff_log._rows().filter((r) => r[4] === 'unit_review');
  ok(logs.length === 5 && logs.filter((r) => r[2] === 'confirm').length === 4 && logs.filter((r) => r[2] === 'reject').length === 1, 'A12 staff_log 記了 4 筆通過、1 筆退回', logs);
  const all = sheets.staff_log._rows().map((r) => r.join('|')).join('\n');
  ok(all.indexOf('0911222333') === -1 && all.indexOf('1995-05-05') === -1 && all.indexOf('職稱填錯') === -1, 'A12 staff_log 不含個資與退回原因');
  // Code.gs：讀取不上鎖、寫入上鎖
  const src = SRC.find(([f]) => f === 'Code.gs')[1];
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(src)[1];
  ok(mut.indexOf('unitApprove: 1') !== -1 && mut.indexOf('unitReject: 1') !== -1 && mut.indexOf('logout: 1') !== -1 && mut.indexOf('unitPending') === -1, 'A12 審核與登出上寫入鎖，待審名單不上鎖');
})();

// ============================================================
// A13 上線轉換：舊流程已能登入的 pending／rejected，token 也一起擋
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const { emp, claim } = seedAndClaim(sb, tok);
  const old = claim.data.token;
  const idx = sheets.staff._data.findIndex((r) => r[0] === emp);
  sheets.staff._data[idx][COL('status')] = 'pending'; // 模擬上線前舊流程認領、手上已有 token 的人
  ok(post(sb, 'me', {}, old).error === '帳號還在等主管審核', 'A13 ★舊流程 pending 的 token 上線後一律失效');
  ok(post(sb, 'myProfile', {}, old).ok === false, 'A13 舊 pending token 讀不到個資');
  sheets.staff._data[idx][COL('status')] = 'rejected';
  ok(post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' }).error === '帳號資料被退回，請找人資重新開通', 'A13 舊流程 rejected 登入被擋並說明');
  sheets.staff._data[idx][COL('status')] = 'active';
  sheets.staff._data[idx][COL('p_title')] = 'ft'; // 已開通、改了職稱待確認 ≠ 認領待審
  ok(post(sb, 'me', {}, old).ok, 'A13 ★已開通＋待確認變更（p_*）照常可用，不被當成待審');
})();

// ============================================================
// A14 登出＝全部裝置一起登出（Eason 2026-10-12）
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const { emp, claim } = seedAndClaim(sb, tok);
  const phone = claim.data.token;
  const laptop = post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' }).data.token;
  const before = sheets.users._rows().find((u) => u[1] === emp);
  ok(post(sb, 'logout', {}, laptop).ok, 'A14 logout 成功');
  ok(post(sb, 'me', {}, laptop).ok === false && post(sb, 'me', {}, phone).ok === false, 'A14 ★登出後這台與其他裝置的舊 token 都失效');
  const after = sheets.users._rows().find((u) => u[1] === emp);
  ok(after.length === 11 && typeof after[10] === 'number' && after.slice(0, 10).join('|') === before.slice(0, 10).join('|'), 'A14 只寫 token_after 那一格（users 11 欄，其他不動）', [before, after]);
  ok(post(sb, 'logout', {}, phone).ok === false, 'A14 已失效的 token 再登出 → 回失效（前端照樣清本機）');
  ok(post(sb, 'logout', {}, '').ok === false, 'A14 沒 token 不能登出別人');
  ok(post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' }).ok && post(sb, 'me', {}, post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' }).data.token).ok, 'A14 登出後重新登入照常');
  const adminLaptop = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
  post(sb, 'logout', {}, tok);
  ok(post(sb, 'me', {}, adminLaptop).ok === false, 'A14 系統帳號（BOSS）登出也是全部裝置');
})();

// ============================================================
// A15 GPT 上線前複審（2026-10-12）第 1、4、5、6 條
// ============================================================
(() => {
  // ── 第 1 條：LEGACY_SECRETS 過渡旗標 ──
  const { sb, sheets, props } = fresh();
  sheets.module_secrets._data.push(['audit', 'read', 'FAKE-LEG-AUDIT-R'], ['audit', 'write', 'FAKE-LEG-AUDIT-W'], ['dorm', 'write', 'FAKE-LEG-DORM-W']);
  const run = () => {
    const lg = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' });
    const me = post(sb, 'me', {}, lg.data.token);
    return { lg, me };
  };
  let r = run();
  ok(r.lg.ok && !('secrets' in r.lg.data) && !('secrets' in r.me.data), 'A15-1 旗標未設：login／me 都不回 secrets', r);
  props.LEGACY_SECRETS = '0';
  r = run();
  ok(!('secrets' in r.lg.data) && !('secrets' in r.me.data), 'A15-1 旗標＝0：不回 secrets');
  props.LEGACY_SECRETS = '1';
  r = run();
  ok(r.lg.ok && r.lg.data.secrets && r.lg.data.secrets.audit === 'FAKE-LEG-AUDIT-W' && !('dorm' in r.lg.data.secrets), 'A15-1 旗標＝1：login 照舊回 secrets（會計拿 audit write 碼、沒有 dorm）', r.lg.data);
  ok(r.me.ok && r.me.data.secrets && r.me.data.secrets.audit === 'FAKE-LEG-AUDIT-W', 'A15-1 旗標＝1：me 照舊回 secrets', r.me.data);
  delete props.LEGACY_SECRETS;
  r = run();
  ok(!('secrets' in r.lg.data) && !('secrets' in r.me.data), 'A15-1 旗標刪掉後立刻不回 secrets');
})();

(() => {
  // ── 第 4 條：總部有部門、主管部門空白 → 不具審核／通訊錄資格 ──
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  post(sb, 'staffImport', { names: ['空部甲', '空部乙', '空部丙'] }, tok);
  const emp = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  const HQ = (dept, title) => ({ brand: 'dzy', unit: 'dzy-hq', dept, title, birthday: '1990-03-03', phone: '0922333444', address: '新竹市測試總部路3號' });
  const tokM = claimAndApprove(sb, tok, '空部甲', 'mgr-blank-pw-1', HQ('it', 'hm')).claim.data.token;
  ok(post(sb, 'claimSubmit', Object.assign({ name: '空部乙', emp_no: emp('空部乙'), password: 'apply-fin-pw-1' }, HQ('fin', 'hs'))).ok, 'A15-4 財務部申請人送出');
  // 對照組：有部門時只看得到同部門（財務部看不到）
  const before = post(sb, 'unitPending', {}, tokM);
  ok(before.ok && before.data.people.length === 0, 'A15-4 對照：資訊部主管看不到財務部待審', before);
  // 試算表直接把主管的部門清空（舊資料／部門清單後來才加）
  const ri = sheets.staff._rows().findIndex((r) => r[0] === emp('空部甲'));
  sheets.staff._data[ri][COL('dept')] = '';
  const pend = post(sb, 'unitPending', {}, tokM);
  ok(pend.ok === false && pend.error === '只有單位主管可以審核', 'A15-4 ★部門空白的總部主管不能看待審（不放大成全總部）', pend);
  ok(post(sb, 'unitApprove', { emp_no: emp('空部乙') }, tokM).ok === false, 'A15-4 ★部門空白的總部主管不能審財務部');
  const mu = post(sb, 'myUnit', {}, tokM);
  ok(mu.ok === false, 'A15-4 ★部門空白的總部主管看不到整個總部通訊錄（myUnit 同一套判斷）', mu);
  const lg = post(sb, 'login', { username: emp('空部甲'), password: 'mgr-blank-pw-1' });
  ok(lg.ok && lg.data.perms.indexOf('platform.review') === -1, 'A15-4 部門空白就不帶 platform.review', lg.data && lg.data.perms);
  ok(staffRow(sheets, emp('空部乙'))[COL('status')] === 'pending', 'A15-4 被擋的審核沒有改到資料');
})();

(() => {
  // ── 第 5 條：帳號至少要有一個英文字母；帳號欄寫入設純文字 ──
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  const ins = (username) => post(sb, 'saveUser', { username, name: '數字帳號', role: 'accountant', node: '', password: 'fake-num-pw-01' }, tok);
  const n0 = sheets.users._rows().length;
  for (const u of ['12345', '0912345678', '１２３', '123-456', '中文帳號']) {
    const r = ins(u);
    ok(r.ok === false && r.error === '帳號至少要有一個英文字母', 'A15-5 ★新增帳號「' + u + '」被擋', r);
  }
  ok(sheets.users._rows().length === n0, 'A15-5 被擋的新增沒有寫入任何列');
  const okIns = ins('acc0912');
  ok(okIns.ok === true, 'A15-5 含英文字母（acc0912）可以新增', okIns);
  const newRow = sheets.users._rows().length;
  ok(sheets.users._fmt[newRow] === '@', 'A15-5 新增時帳號欄設成純文字', sheets.users._fmt);
  const ed = post(sb, 'saveUser', { id: okIns.data.id, username: '0912', name: '數字帳號', role: 'accountant', node: '' }, tok);
  ok(ed.ok === false && ed.error === '帳號至少要有一個英文字母', 'A15-5 ★修改成純數字帳號被擋', ed);
  ok(sheets.users._rows()[newRow - 1][1] === 'acc0912', 'A15-5 被擋的修改沒有改到帳號');
  delete sheets.users._fmt[2];
  const ed2 = post(sb, 'saveUser', { id: 'u002', username: 'acc2', name: '假會計', role: 'accountant', node: '' }, tok);
  ok(ed2.ok && sheets.users._fmt[3] === '@', 'A15-5 修改時帳號欄也設純文字', sheets.users._fmt);
  ok(post(sb, 'login', { username: 'acc0912', password: 'fake-num-pw-01' }).ok, 'A15-5 含數字的英數帳號登得進去');
})();

(() => {
  // ── 第 6 條：改密碼／改手機驗目前密碼走 authSafeEqual_（常數時間） ──
  const { sb, sheets } = fresh();
  const tok = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  const orig = sb.authSafeEqual_;
  let calls = 0;
  // 只算「拿來比密碼雜湊」的呼叫（verifyToken_ 驗簽章也會用 authSafeEqual_，不能混進來）
  sb.authSafeEqual_ = function (a, b) {
    const stored = String(sheets.users._rows().find((u) => u[0] === 'u002')[6]);
    if (String(b) === stored) calls++;
    return orig(a, b);
  };
  const bad = post(sb, 'changePassword', { oldPassword: 'wrong-old-pw-1', newPassword: 'fake-new-pw-0001' }, tok);
  ok(bad.ok === false && calls >= 1, 'A15-6 ★驗舊密碼（錯）呼叫 authSafeEqual_', { bad, calls });
  calls = 0;
  const good = post(sb, 'changePassword', { oldPassword: 'fake-acc-pw-01', newPassword: 'fake-new-pw-0001' }, tok);
  ok(good.ok === true && calls >= 1, 'A15-6 驗舊密碼（對）也走 authSafeEqual_、改密碼成功', { good, calls });
  sb.authSafeEqual_ = orig;
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
