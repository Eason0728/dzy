// node test/security-hardening.test.mjs —— 2026-10-12 平台後端安全修補（九項）的釘子測試
// 做法同 staff.mock.test.mjs：Auth.gs／Users.gs／Staff.gs／Code.gs 讀進同一個 vm sandbox，盡量走 doPost。
// 每一區開頭的編號對應修補清單：1 長度上限、2 公式注入、3 login_log 上限、4 帳號奪取鏈、
// 5 密碼噴灑、6 recheck 簽發、7 同仁帳號走同仁名單、8 帳號不分大小寫、9 常數時間比對。
// ⚠ 所有帳密、姓名、手機都是假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件 ──────────────────────────────────────────────
function makeSheet(rows, opts) {
  const data = (rows || []).map((r) => r.slice());
  const calls = { deleteRows: [], deleteRow: 0 };
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
        setNumberFormat() { return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(n) { calls.deleteRow++; data.splice(n - 1, 1); },
    _rows: () => data.map((r) => r.slice()),
    _calls: calls
  };
  // 真試算表有 deleteRows；minikit 假表沒有 → noDeleteRows 模擬後者
  if (!(opts && opts.noDeleteRows)) sheet.deleteRows = (start, n) => { calls.deleteRows.push([start, n]); data.splice(start - 1, n); };
  return sheet;
}

function bytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff));
}
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }

function load(seed, sheetOpts) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k], (sheetOpts || {})[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-security-tests' };
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
      put: (k, v, ttl) => cache.set(k, { v: String(v), exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache };
}

function post(sb, action, payload, token, extraE) {
  const e = Object.assign({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }, extraE || {});
  return JSON.parse(sb.doPost(e).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
const ACC_PW = 'fake-acc-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const H = (pw, salt) => HASHER.hashPassword_(pw, salt);
const LOG_HEADER = ['at', 'username', 'ip_hash', 'result'];

function seed(extra) {
  return Object.assign({
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', 's1', H(ADMIN_PW, 's1'), 'TRUE', '', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', 's2', H(ACC_PW, 's2'), 'TRUE', '', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'],
      ['manager', '部門主管', 'audit.read,dorm.read,dorm.write'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [LOG_HEADER]
  }, extra || {});
}
function fresh(extra, sheetOpts) {
  const app = load(seed(extra), sheetOpts);
  app.sb.setupStaff();
  return app;
}
function adminToken(sb) {
  const r = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW });
  if (!r.ok) throw new Error('admin login 失敗 ' + r.error);
  return r.data.token;
}
const PROFILE = { brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' };
const STAFF_PW = 'fake-staff-pw-1';
function claimOne(sb, tok) {
  post(sb, 'staffImport', { names: ['測試甲', '測試乙'] }, tok);
  const r = post(sb, 'claimSubmit', Object.assign({ name: '測試甲', emp_no: 'DZY001', password: STAFF_PW }, PROFILE));
  if (!r.ok) throw new Error('認領失敗 ' + r.error);
  // 2026-10-12：認領後要審核通過才開通，這裡用後台確認後再登入拿 token
  const cf = post(sb, 'staffConfirm', { emp_no: 'DZY001' }, tok);
  if (!cf.ok) throw new Error('確認失敗 ' + cf.error);
  return post(sb, 'login', { username: 'DZY001', password: STAFF_PW }).data.token;
}
const cacheKeys = (cache) => Array.from(cache.keys()).sort().join('|');

// ============================================================
// 1. 帳號與登入前欄位長度上限：不寫 cache、不寫 login_log
// ============================================================
(() => {
  const { sb, sheets, cache } = fresh();
  const logBefore = sheets.login_log._rows().length;
  const keysBefore = cacheKeys(cache);
  const bad = ['A'.repeat(65), ' ' + 'B'.repeat(65) + ' ', 'X'.repeat(200000), '', '   '];
  bad.forEach((u, i) => {
    const r = post(sb, 'login', { username: u, password: 'whatever-1' });
    ok(r.ok === false && r.error === '帳號或密碼錯誤', '1-' + i + ' 不合規帳號（長度 ' + u.length + '）回通用錯誤');
  });
  [12345678, ['BOSS'], { a: 1 }, null, true].forEach((u, i) => {
    const r = post(sb, 'login', { username: u, password: ADMIN_PW });
    ok(r.ok === false && r.error === '帳號或密碼錯誤', '1-type' + i + ' 帳號不是字串（' + JSON.stringify(u) + '）回通用錯誤');
  });
  ok(sheets.login_log._rows().length === logBefore, '1 不合規帳號一筆 login_log 都沒寫');
  ok(cacheKeys(cache) === keysBefore, '1 不合規帳號沒有寫任何 cache', Array.from(cache.keys()));
  // 對照組：剛好 64 字是合法長度，會照常記失敗
  post(sb, 'login', { username: 'C'.repeat(64), password: 'whatever-1' });
  ok(sheets.login_log._rows().length === logBefore + 1, '1 對照：64 字帳號照常處理、寫一筆 login_log');

  // 登入前三支：超長欄位在碰全域額度 cache 之前就拒絕
  const keys0 = cacheKeys(cache);
  const staffLogBefore = sheets.staff_log._rows().length;
  ok(post(sb, 'claimLookup', { name: '甲'.repeat(31) }).ok === false, '1 claimLookup 姓名 31 字被拒');
  ok(post(sb, 'claimLookup', { name: ['陣列'] }).ok === false, '1 claimLookup 姓名不是字串被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: 'p'.repeat(129) })).error === '密碼最多 128 個字元', '1 claimSubmit 密碼 129 字被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001' + 'x'.repeat(20), password: STAFF_PW })).ok === false, '1 claimSubmit 編號超長被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: STAFF_PW, phone: '0'.repeat(21) })).ok === false, '1 claimSubmit 手機超長被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: STAFF_PW, birthday: '1995-05-055' })).ok === false, '1 claimSubmit 生日超長被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: STAFF_PW, address: '路'.repeat(101) })).ok === false, '1 claimSubmit 地址超長被拒');
  ok(post(sb, 'claimSubmit', Object.assign({}, PROFILE, { name: '測試甲', emp_no: 'DZY001', password: STAFF_PW, brand: 'b'.repeat(41) })).ok === false, '1 claimSubmit 組織欄超長被拒');
  ok(post(sb, 'forgotReset', { emp_no: 'DZY001', birthday: '1995-05-05', phone: '0911222333' + '1'.repeat(11), new_password: 'new-pw-12345' }).error === '資料不符，請確認或找後台', '1 forgotReset 手機超長被拒');
  ok(post(sb, 'forgotReset', { emp_no: 'D'.repeat(17), birthday: '1995-05-05', phone: '0911222333', new_password: 'new-pw-12345' }).ok === false, '1 forgotReset 編號超長被拒');
  ok(post(sb, 'forgotReset', { emp_no: 'DZY001', birthday: '1995-05-05', phone: '0911222333', new_password: 'n'.repeat(129) }).error === '密碼最多 128 個字元', '1 forgotReset 新密碼超長被拒');
  ok(cacheKeys(cache) === keys0, '1 三支登入前動作的超長請求都沒碰 cache（全域額度沒被吃）', Array.from(cache.keys()));
  ok(sheets.staff_log._rows().length === staffLogBefore, '1 超長請求沒寫 staff_log');
})();

// ============================================================
// 2. 公式注入：login_log、users 姓名
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const evil = ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(1)', ' \t=1+1'];
  evil.forEach((u) => post(sb, 'login', { username: u, password: 'whatever-1' }));
  const logged = sheets.login_log._rows().slice(1).map((r) => r[1]);
  ok(evil.every((u) => logged.indexOf("'" + u.trim()) !== -1), '2 login_log 帳號開頭 = + - @（含前導空白）前面都加了單引號', logged);
  ok(sheets.login_log._rows().slice(1).every((r) => r.every((c) => typeof c !== 'string' || !/^\s*[=+\-@]/.test(c))), '2 login_log 沒有任何一格以公式字元開頭');
  // 一般帳號不受影響
  post(sb, 'login', { username: 'acc1', password: ACC_PW });
  ok(sheets.login_log._rows().slice(-1)[0][1] === 'acc1', '2 一般帳號原樣記錄');
  ok(HASHER.authSafeCell_(5) === 5 && HASHER.authSafeCell_('王小明') === '王小明', '2 非字串與一般字串原樣');

  // Setup.gs：login_log 第 2 欄設純文字
  const setupCtx = { };
  vm.createContext(setupCtx);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'Setup.gs'), 'utf8') + '\n;this.__tc = TEXT_COLUMNS;', setupCtx);
  ok(setupCtx.__tc.login_log.indexOf(2) !== -1 && setupCtx.__tc.login_log.indexOf(1) !== -1, '2 Setup.gs 建 login_log 時第 1、2 欄設純文字', setupCtx.__tc.login_log);

  // users 姓名：saveUser 新增／修改、同仁匯入、後台改名
  const tok = adminToken(sb);
  const r1 = post(sb, 'saveUser', { username: 'evil1', name: '=IMPORTXML("http://x","//a")', role: 'accountant', node: '', password: 'fake-pw-12345' }, tok);
  const row1 = sheets.users._rows().find((r) => r[1] === 'evil1');
  ok(r1.ok && row1[2] === '\'=IMPORTXML("http://x","//a")', '2 saveUser 新增：姓名加單引號', row1);
  post(sb, 'saveUser', { id: row1[0], username: 'evil1', name: '+cmd', role: 'accountant', node: '' }, tok);
  ok(sheets.users._rows().find((r) => r[1] === 'evil1')[2] === "'+cmd", '2 saveUser 修改：姓名加單引號');
  ok(post(sb, 'saveUser', { username: '=evil', name: '正常', role: 'accountant', node: '', password: 'fake-pw-12345' }, tok).error === '帳號不能用 = + - @ 開頭', '2 saveUser 帳號以公式字元開頭被拒');
  post(sb, 'staffImport', { names: ['@測試丙'] }, tok);
  const urow = sheets.users._rows().find((r) => r[3] === 'staff' && String(r[2]).indexOf('測試丙') !== -1);
  ok(urow && urow[2] === "'@測試丙", '2 同仁匯入：users 姓名加單引號', urow);
  const emp = urow[1];
  post(sb, 'staffEdit', { emp_no: emp, name: '-測試丁' }, tok);
  ok(sheets.users._rows().find((r) => r[1] === emp)[2] === "'-測試丁", '2 後台改名：users 姓名加單引號');
})();

// ============================================================
// 3. login_log 上限 5000（批次刪最舊）
// ============================================================
(() => {
  const old = [];
  for (let i = 0; i < 5003; i++) old.push(['2026-01-01 00:00:00', 'old' + i, '', 'bad_password']);
  const { sb, sheets } = fresh({ login_log: [LOG_HEADER].concat(old) });
  post(sb, 'login', { username: 'acc1', password: ACC_PW });
  const rows = sheets.login_log._rows();
  ok(rows.length === 5001, '3 超過上限後只留 5000 列（＋表頭）', rows.length);
  ok(rows[0].join() === LOG_HEADER.join(), '3 表頭還在');
  ok(rows[1][1] === 'old4' && rows[5000][1] === 'acc1', '3 刪掉的是最舊的 4 列，最新一筆在最後', [rows[1][1], rows[5000][1]]);
  ok(JSON.stringify(sheets.login_log._calls.deleteRows) === '[[2,4]]' && sheets.login_log._calls.deleteRow === 0, '3 一次 deleteRows(2,4) 批次刪，不逐列', sheets.login_log._calls);
  post(sb, 'login', { username: 'acc1', password: ACC_PW });
  ok(sheets.login_log._rows().length === 5001 && JSON.stringify(sheets.login_log._calls.deleteRows[1]) === '[2,1]', '3 穩定狀態：每多 1 列就刪最舊 1 列');
})();
(() => {
  // minikit 假表沒有 deleteRows：大量超出時整塊搬移後從尾端刪，結果一樣
  const old = [];
  for (let i = 0; i < 5100; i++) old.push(['2026-01-01 00:00:00', 'old' + i, '', 'bad_password']);
  const { sb, sheets } = fresh({ login_log: [LOG_HEADER].concat(old) }, { login_log: { noDeleteRows: true } });
  post(sb, 'login', { username: 'acc1', password: ACC_PW });
  const rows = sheets.login_log._rows();
  ok(rows.length === 5001 && rows[1][1] === 'old101' && rows[5000][1] === 'acc1', '3 沒有 deleteRows 的環境（minikit）也保留最新 5000 列', [rows.length, rows[1][1], rows[5000][1]]);
})();

// ============================================================
// 4. 帳號奪取鏈：改手機要密碼；改密碼／改手機驗錯共用計數 5 次鎖 15 分鐘
// ============================================================
(() => {
  const { sb, sheets, cache } = fresh();
  const tok = adminToken(sb);
  const me = claimOne(sb, tok);
  const phoneOf = () => sheets.staff._rows().find((r) => r[0] === 'DZY001')[13];
  const NEW = Object.assign({}, PROFILE, { phone: '0988777666' });
  ok(post(sb, 'saveMyProfile', NEW, me).error === '改手機要輸入目前的密碼', '4 改手機沒帶 current_password 被拒');
  ok(phoneOf() === '0911222333', '4 被拒時手機沒變');
  ok(post(sb, 'saveMyProfile', Object.assign({}, NEW, { current_password: 'wrong-pw-1' }), me).error === '目前密碼不正確', '4 改手機帶錯密碼被拒');
  ok(phoneOf() === '0911222333', '4 密碼錯時手機沒變');
  ok(post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { address: '新竹市測試路二段2號' }), me).ok, '4 只改地址不用密碼');
  const good = post(sb, 'saveMyProfile', Object.assign({}, NEW, { current_password: STAFF_PW }), me);
  ok(good.ok && phoneOf() === '0988777666', '4 帶對的目前密碼可以改手機', good);
  ok(!Array.from(cache.keys()).some((k) => k.indexOf('usr_selfpw:') === 0), '4 驗對後清掉錯誤計數');

  // 共用計數：saveMyProfile 錯 3 次＋changePassword 錯 2 次 → 第 6 次連正確密碼也鎖
  const NEW2 = Object.assign({}, PROFILE, { phone: '0977000111', current_password: 'wrong-pw-1' });
  for (let i = 0; i < 3; i++) post(sb, 'saveMyProfile', NEW2, me);
  for (let i = 0; i < 2; i++) post(sb, 'changePassword', { oldPassword: 'wrong-pw-1', newPassword: 'brand-new-pw-1' }, me);
  const key = 'usr_selfpw:' + sheets.staff._rows().find((r) => r[0] === 'DZY001')[1];
  ok(cache.has(key), '4 計數 key 用 user id', Array.from(cache.keys()));
  const locked = post(sb, 'changePassword', { oldPassword: STAFF_PW, newPassword: 'brand-new-pw-1' }, me);
  ok(locked.ok === false && locked.error === '嘗試次數過多，請 15 分鐘後再試', '4 兩邊合計錯 5 次後，改密碼連正確舊密碼也被鎖', locked);
  const locked2 = post(sb, 'saveMyProfile', Object.assign({}, PROFILE, { phone: '0977000111', current_password: STAFF_PW }), me);
  ok(locked2.error === '嘗試次數過多，請 15 分鐘後再試', '4 改手機也同時被鎖');
  // 鎖 15 分鐘：把鎖定時間撥到過去就解開
  const st = JSON.parse(cache.get(key).v);
  ok(st.lockedUntil - Math.floor(Date.now() / 1000) > 14 * 60, '4 鎖定約 15 分鐘', st);
  cache.set(key, { v: JSON.stringify({ count: 5, since: st.since - 1000, lockedUntil: 1 }), exp: null });
  ok(post(sb, 'changePassword', { oldPassword: STAFF_PW, newPassword: 'brand-new-pw-1' }, me).ok, '4 鎖過期後可以正常改密碼');
  // 登入不受影響（本人計數與登入鎖分開）
  ok(post(sb, 'login', { username: 'DZY001', password: 'brand-new-pw-1' }).ok, '4 本人驗密碼計數不影響登入');

  // 系統帳號 changePassword 也計次
  const acc = post(sb, 'login', { username: 'acc1', password: ACC_PW }).data.token;
  for (let i = 0; i < 5; i++) post(sb, 'changePassword', { oldPassword: 'nope-nope-1', newPassword: 'brand-new-pw-2' }, acc);
  ok(post(sb, 'changePassword', { oldPassword: ACC_PW, newPassword: 'brand-new-pw-2' }, acc).error === '嘗試次數過多，請 15 分鐘後再試', '4 系統帳號改密碼錯 5 次也鎖');
})();

// ============================================================
// 5. 跨帳號密碼噴灑：同來源 30 次鎖該來源；沒來源用全域桶只加提示
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const A = { clientIp: '203.0.113.7' };
  const B = { clientIp: '198.51.100.9' };
  for (let i = 0; i < 30; i++) {
    const r = post(sb, 'login', { username: 'spray' + i, password: 'Password1' }, '', A);
    if (r.error !== '帳號或密碼錯誤') ok(false, '5 噴灑前 30 次應該是一般錯誤', r);
  }
  const logLen = sheets.login_log._rows().length;
  const blocked = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }, '', A);
  ok(blocked.ok === false && blocked.error === '嘗試次數過多，請 15 分鐘後再試', '5 同一來源跨 30 個帳號失敗 → 該來源連正確密碼也擋', blocked);
  ok(sheets.login_log._rows().length === logLen, '5 來源被鎖時不再寫 login_log（不給它灌 log）');
  ok(post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }, '', B).ok, '5 其他來源不受影響');
  ok(post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).ok, '5 沒有來源資訊的請求不受該來源鎖影響');
  const ipCol = sheets.login_log._rows().slice(1).map((r) => r[2]).filter((x) => x);
  ok(ipCol.length > 0 && ipCol.every((h) => /^[0-9a-f]{24}$/.test(h)) && ipCol.indexOf('203.0.113.7') === -1, '5 login_log 存的是 24 字雜湊，不是原始 IP', ipCol.slice(0, 2));
})();
(() => {
  const { sb } = fresh();
  for (let i = 0; i < 299; i++) post(sb, 'login', { username: 'g' + i, password: 'Password1' });
  ok(post(sb, 'login', { username: 'g299', password: 'Password1' }).error === '帳號或密碼錯誤，請稍後再試', '5 全域桶：第 300 次失敗起訊息加「請稍後再試」');
  ok(post(sb, 'login', { username: 'g300', password: 'Password1' }).error === '帳號或密碼錯誤，請稍後再試', '5 全域桶：之後的失敗都加');
  ok(post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).ok, '5 全域桶滿了，正確密碼照樣登入（不把真正同仁鎖死）');
})();

// ============================================================
// 6. recheck 後用新值簽發
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const orig = sb.hashPassword_;
  let flipped = false;
  // 雜湊期間（第一次比對之後、重讀之前）把 acc1 改成 manager、改姓名——salt/hash/active 不變
  sb.hashPassword_ = function (pw, salt) {
    const out = orig(pw, salt);
    if (!flipped && salt === 's2') {
      flipped = true;
      const r = sheets.users.getRange(3, 3, 1, 3);
      r.setValues([['改名後', 'manager', 'sxl-gf']]);
    }
    return out;
  };
  const r = post(sb, 'login', { username: 'acc1', password: ACC_PW });
  sb.hashPassword_ = orig;
  ok(r.ok && r.data.user.role === 'manager' && r.data.user.name === '改名後' && r.data.user.node === 'sxl-gf', '6 簽發用重讀後的角色／姓名／節點', r.data && r.data.user);
  ok(r.ok && r.data.perms.indexOf('dorm.write') !== -1, '6 perms 依新角色');
  const payload = JSON.parse(Buffer.from(r.data.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  ok(payload.r === 'manager' && payload.n === 'sxl-gf', '6 token 內的角色／節點是新值', payload);
})();

// ============================================================
// 7. 人員管理通用寫入不得動同仁帳號
// ============================================================
(() => {
  const { sb, sheets } = fresh();
  const tok = adminToken(sb);
  claimOne(sb, tok);
  const staffUser = sheets.users._rows().find((r) => r[1] === 'DZY001');
  const before = staffUser.slice();
  const MSG = '同仁帳號請到同仁名單操作';
  ok(post(sb, 'setActive', { id: staffUser[0], active: false }, tok).error === MSG, '7 setActive 同仁帳號被拒');
  ok(post(sb, 'saveUser', { id: staffUser[0], username: 'DZY001', name: '改名', role: 'staff', node: '' }, tok).error === MSG, '7 saveUser 修改同仁帳號被拒');
  ok(post(sb, 'saveUser', { id: staffUser[0], username: 'DZY001', name: '改名', role: 'admin', node: '' }, tok).error === MSG, '7 saveUser 不能把同仁帳號升成 admin');
  ok(post(sb, 'resetPassword', { id: staffUser[0], newPassword: 'admin-set-pw-1' }, tok).error === MSG, '7 resetPassword 同仁帳號被拒');
  ok(post(sb, 'saveUser', { username: 'newstaff', name: '偷建', role: 'staff', node: '', password: 'fake-pw-12345' }, tok).error === MSG, '7 saveUser 不能新增 role staff');
  ok(JSON.stringify(sheets.users._rows().find((r) => r[1] === 'DZY001')) === JSON.stringify(before), '7 同仁那一列完全沒動');
  ok(!sheets.users._rows().some((r) => r[1] === 'newstaff'), '7 沒有多出 role staff 的帳號');
  // 對照：系統帳號照常
  ok(post(sb, 'setActive', { id: 'u002', active: false }, tok).ok, '7 對照：系統帳號 setActive 照常');
  ok(post(sb, 'staffSetActive', { emp_no: 'DZY001', active: false }, tok).ok, '7 對照：同仁名單停用照常');
})();

// ============================================================
// 8. 帳號不分大小寫
// ============================================================
(() => {
  const { sb } = fresh({
    users: seed().users.concat([['u003', 'Mike.Lin', '假主管', 'manager', '', 's3', H('fake-mgr-pw-1', 's3'), 'TRUE', '', '', '']])
  });
  ok(post(sb, 'login', { username: 'boss', password: ADMIN_PW }).ok, '8 boss 可登入 BOSS');
  ok(post(sb, 'login', { username: 'mike.lin', password: 'fake-mgr-pw-1' }).ok, '8 mike.lin 可登入 Mike.Lin');
  ok(post(sb, 'login', { username: 'MIKE.LIN', password: 'fake-mgr-pw-1' }).data.user.id === 'u003', '8 全大寫也對到同一個帳號');
  // 鎖定計數不分大小寫
  post(sb, 'login', { username: 'acc1', password: 'x-wrong-1' });
  post(sb, 'login', { username: 'ACC1', password: 'x-wrong-1' });
  post(sb, 'login', { username: 'Acc1', password: 'x-wrong-1' });
  ok(post(sb, 'login', { username: 'acc1', password: ACC_PW }).error === '嘗試次數過多，請 15 分鐘後再試', '8 大小寫變形共用同一個鎖定計數');
})();

// ============================================================
// 9. token 簽章常數時間比較
// ============================================================
(() => {
  const { sb } = fresh();
  ok(sb.authSafeEqual_('abc', 'abc') === true, '9 相同 → true');
  ok(sb.authSafeEqual_('abc', 'abd') === false, '9 最後一字不同 → false');
  ok(sb.authSafeEqual_('abc', 'ab') === false && sb.authSafeEqual_('ab', 'abc') === false, '9 長度不同 → false');
  ok(sb.authSafeEqual_('', '') === true && sb.authSafeEqual_('', 'a') === false, '9 空字串邊界');
  // 不提早結束：第一個字就不同也要比完整個長度
  const proto = vm.runInContext('String.prototype', sb);
  const orig = proto.charCodeAt;
  let n = 0;
  proto.charCodeAt = function (i) { n++; return orig.call(this, i); };
  const res = sb.authSafeEqual_('Xbcdefghij', 'abcdefghij');
  const resLen = (n = 0, sb.authSafeEqual_('Xbcdefghij', 'abc'), n);
  proto.charCodeAt = orig;
  ok(res === false, '9 第一字不同 → false');
  ok(resLen >= 10, '9 長度不同也跑完一輪（不提早 return）', resLen);
  n = 0;
  proto.charCodeAt = function (i) { n++; return orig.call(this, i); };
  sb.authSafeEqual_('Xbcdefghij', 'abcdefghij');
  proto.charCodeAt = orig;
  ok(n >= 20, '9 第一字不同仍逐字比完 10 個字元（兩邊各讀一次）', n);
  // verifyToken_ 真的走常數時間比較
  const tok = adminToken(sb);
  const realEq = sb.authSafeEqual_;
  let used = 0;
  sb.authSafeEqual_ = function (a, b) { used++; return realEq(a, b); };
  const good = sb.verifyToken_(tok);
  const parts = tok.split('.');
  const bad = sb.verifyToken_(parts[0] + '.' + (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1));
  sb.authSafeEqual_ = realEq;
  ok(good && good.u === 'u001' && bad === false, '9 verifyToken_ 正常 token 通過、竄改簽章被拒');
  ok(used >= 2, '9 verifyToken_ 用 authSafeEqual_ 比對簽章', used);
})();

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
