// node test/auth.mock.test.mjs —— T1-4 驗收：Auth.gs（login／me／token／權限／鎖定）
// 做法照 ~/mala-audit/test/gas-core.test.js：把 Auth.gs 當文字讀進來，丟進 node vm 的 sandbox
// 執行，sandbox 裡手刻 SpreadsheetApp／Utilities／PropertiesService／CacheService 四個 GAS 全域
// 物件的假實作（Utilities 底層用 node:crypto 算真的 SHA-256／HMAC，不是隨便回假值）。
// 零依賴、直跑、失敗時 process.exit(1)。
//
// ⚠ 下面所有帳密／通行碼都是本測試檔自造的假資料（一看就是 test/salt/fake 字樣），
//   不是任何真實系統的密碼或通行碼。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_GS_PATH = path.join(__dirname, '..', 'apps-script', 'platform', 'Auth.gs');
const AUTH_GS_CODE = fs.readFileSync(AUTH_GS_PATH, 'utf8');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log('PASS: ' + label);
  } else {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  }
}

function assertTrue(cond, label) {
  if (cond) {
    passed++;
    console.log('PASS: ' + label);
  } else {
    failed++;
    console.error('FAIL: ' + label);
  }
}

// ============================================================
// GAS 全域物件的假實作
// ============================================================

function makeSheet(initialRows) {
  const data = (initialRows || []).map((r) => r.slice());
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const srcRow = data[row - 1 + r] || [];
            const outRow = [];
            for (let c = 0; c < numCols; c++) {
              const v = srcRow[col - 1 + c];
              outRow.push(v === undefined ? '' : v);
            }
            out.push(outRow);
          }
          return out;
        },
        setValue(v) {
          const r = row - 1;
          const c = col - 1;
          while (data.length <= r) data.push([]);
          while (data[r].length <= c) data[r].push('');
          data[r][c] = v;
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
        }
      };
    },
    appendRow(row) {
      data.push((row || []).slice());
    },
    _rows: () => data.map((r) => r.slice())
  };
}

function makeSpreadsheetApp(sheetsSeed) {
  const sheets = {};
  Object.keys(sheetsSeed).forEach((name) => {
    sheets[name] = makeSheet(sheetsSeed[name]);
  });
  const active = {
    getSheetByName: (name) => (Object.prototype.hasOwnProperty.call(sheets, name) ? sheets[name] : null)
  };
  return {
    api: { getActive: () => active },
    sheets
  };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Array.isArray(value)) return Buffer.from(value.map((b) => (b < 0 ? b + 256 : b) & 0xff));
  throw new Error('toBuffer: 不支援的型別 ' + typeof value);
}

function toSignedBytes(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}

function makeUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: (_algo, value) => toSignedBytes(crypto.createHash('sha256').update(toBuffer(value)).digest()),
    computeHmacSha256Signature: (value, key) =>
      toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
    base64Encode: (data) => toBuffer(data).toString('base64'),
    base64Decode: (str) => toSignedBytes(Buffer.from(String(str), 'base64'))
  };
}

function makePropertiesService(initialProps) {
  const store = Object.assign({}, initialProps || {});
  const scriptProps = {
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setProperty(key, val) {
      store[key] = val;
      return scriptProps;
    },
    deleteProperty(key) {
      delete store[key];
      return scriptProps;
    }
  };
  return { getScriptProperties: () => scriptProps, _store: store };
}

function makeCacheService() {
  const store = new Map();
  const cache = {
    get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && Date.now() > e.expiresAt) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    put(key, value, ttlSeconds) {
      store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    },
    remove(key) {
      store.delete(key);
    }
  };
  return { getScriptCache: () => cache, _store: store };
}

// loadAuth(sheetsSeed, propsSeed) → { sandbox, sheets }
// 每次呼叫都是全新 vm sandbox，測試互不汙染全域狀態（含 CacheService 的鎖定計數）。
function loadAuth(sheetsSeed, propsSeed) {
  const ssApp = makeSpreadsheetApp(sheetsSeed);
  const sandbox = {
    console,
    SpreadsheetApp: ssApp.api,
    Utilities: makeUtilities(),
    PropertiesService: makePropertiesService(propsSeed),
    CacheService: makeCacheService()
  };
  vm.createContext(sandbox);
  vm.runInContext(AUTH_GS_CODE, sandbox, { filename: AUTH_GS_PATH });
  return { sandbox, sheets: ssApp.sheets };
}

// ── 密碼雜湊工具（用一個不帶業務資料的 sandbox 算，避免雞生蛋問題）──────
const HASH_TOOL = loadAuth(
  { users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] },
  { HMAC_SECRET: 'tool-only-not-used-for-signing' }
);
function hashFor(pw, salt) {
  return HASH_TOOL.sandbox.hashPassword_(pw, salt);
}

// ── 測試資料（假密碼，一律帶 test/fake 字樣）─────────────────────────
const PW = {
  acc1: 'test-pw-accountant-01',
  lead1: 'test-pw-storelead-01',
  admin1: 'test-pw-admin-01',
  offuser: 'test-pw-disabled-01',
  lockuser: 'test-pw-lockout-01',
  mgr1: 'test-pw-manager-01'
};

const ROLES_SEED = [
  ['role', 'name_zh', 'perms'],
  ['admin', '系統管理者', '*'],
  ['manager', '部門主管', 'audit.read,dorm.read,dorm.write'],
  ['accountant', '會計', 'audit.read,audit.write'],
  ['storelead', '店長', 'audit.read.own'],
  ['staff', '員工', '']
];

const SECRETS_SEED = [
  ['backend_id', 'level', 'secret'],
  ['audit', 'read', 'FAKE-AUDIT-READ-CODE'],
  ['audit', 'write', 'FAKE-AUDIT-WRITE-CODE'],
  ['dorm', 'write', 'FAKE-DORM-WRITE-CODE']
];

function freshUsersSeed() {
  return [
    ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
    ['u001', 'acc1', '王會計', 'accountant', '', 'salt-acc1', hashFor(PW.acc1, 'salt-acc1'), 'TRUE', '', ''],
    ['u002', 'lead1', '林店長', 'storelead', 'sxl-gf', 'salt-lead1', hashFor(PW.lead1, 'salt-lead1'), 'TRUE', '', ''],
    ['u003', 'admin1', '系統管理者帳號', 'admin', '', 'salt-admin1', hashFor(PW.admin1, 'salt-admin1'), 'TRUE', '', ''],
    ['u004', 'offuser', '停用員工', 'storelead', 'sxl-gf', 'salt-off', hashFor(PW.offuser, 'salt-off'), 'FALSE', '', ''],
    ['u005', 'lockuser', '測試鎖定', 'storelead', 'sxl-gf', 'salt-lock', hashFor(PW.lockuser, 'salt-lock'), 'TRUE', '', ''],
    ['u006', 'mgr1', '部門主管帳號', 'manager', '', 'salt-mgr1', hashFor(PW.mgr1, 'salt-mgr1'), 'TRUE', '', '']
  ];
}

function freshSheets() {
  return {
    users: freshUsersSeed(),
    roles: ROLES_SEED,
    module_secrets: SECRETS_SEED,
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}

function freshApp() {
  return loadAuth(freshSheets(), { HMAC_SECRET: 'fake-hmac-secret-for-tests-only' });
}

function flipChar(str, index) {
  const ch = str.charAt(index);
  const alt = ch === 'A' ? 'B' : 'A';
  return str.slice(0, index) + alt + str.slice(index + 1);
}

// ============================================================
// A. token 竄改：改 payload、改簽章，兩種都要被拒
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const res = sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 });
  assertTrue(res.ok === true, 'A0: acc1 用正確密碼登入成功（後續竄改測試的前提）');
  const token = res.data.token;
  assertTrue(typeof token === 'string' && token.indexOf('.') !== -1, 'A0: token 格式含一個點分隔的兩段');

  assertTrue(sandbox.verifyToken_(token) !== false, 'A1: 未竄改的 token 驗證通過');

  const [payloadPart, sigPart] = token.split('.');

  const tamperedPayloadToken = flipChar(payloadPart, Math.floor(payloadPart.length / 2)) + '.' + sigPart;
  assertTrue(sandbox.verifyToken_(tamperedPayloadToken) === false, 'A2: 竄改 payload 一個字元 → verifyToken_ 回 false');

  const tamperedSigToken = payloadPart + '.' + flipChar(sigPart, Math.floor(sigPart.length / 2));
  assertTrue(sandbox.verifyToken_(tamperedSigToken) === false, 'A3: 竄改簽章一個字元 → verifyToken_ 回 false');

  assertTrue(sandbox.verifyToken_('not-a-token') === false, 'A4: 格式不合法（沒有點）→ false');
  assertTrue(sandbox.verifyToken_('a.b.c') === false, 'A5: 兩個點（格式不合法）→ false');
})();

// ============================================================
// B. 過期 token 被拒
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const nowSec = Math.floor(Date.now() / 1000);

  const expiredToken = sandbox.signPayload_({ u: 'u001', r: 'accountant', n: '', e: nowSec - 10 });
  assertTrue(sandbox.verifyToken_(expiredToken) === false, 'B1: 已過期（e 在過去）的 token 被拒');

  const freshToken = sandbox.signPayload_({ u: 'u001', r: 'accountant', n: '', e: nowSec + 100 });
  assertTrue(sandbox.verifyToken_(freshToken) !== false, 'B2: 尚未過期的 token 驗證通過（對照組）');

  const issued = sandbox.issueToken_({ id: 'u001', role: 'accountant', node: '' });
  const payload = sandbox.verifyToken_(issued);
  assertTrue(payload !== false && payload.e > nowSec, 'B3: issueToken_ 產生的 token 到期時間在未來');
  assertEqual(payload.e - nowSec > 6 * 24 * 3600 && payload.e - nowSec <= 7 * 24 * 3600, true, 'B4: issueToken_ 有效期約 7 天');
})();

// ============================================================
// C. 三種身分：secrets 依權限下發最低一級碼
// ============================================================
(() => {
  const { sandbox } = freshApp();

  // C1：會計（audit.read + audit.write）→ 拿 audit 的 write 碼
  const accRes = sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 });
  assertTrue(accRes.ok === true, 'C1a: 會計登入成功');
  assertEqual(accRes.data.perms, ['audit.read', 'audit.write'], 'C1b: 會計 perms 展開正確');
  assertEqual(accRes.data.secrets.audit, 'FAKE-AUDIT-WRITE-CODE', 'C1c: 會計拿到 audit 的 write 碼');
  assertEqual(accRes.data.user, { id: 'u001', name: '王會計', role: 'accountant', node: '' }, 'C1d: 會計 user 物件形狀正確（不含 username/salt/hash）');

  // C2：店長（只有 audit.read.own）→ 拿 audit 的 read 碼
  const leadRes = sandbox.handleLogin_({ username: 'lead1', password: PW.lead1 });
  assertTrue(leadRes.ok === true, 'C2a: 店長登入成功');
  assertEqual(leadRes.data.perms, ['audit.read.own'], 'C2b: 店長 perms 展開正確');
  assertEqual(leadRes.data.secrets.audit, 'FAKE-AUDIT-READ-CODE', 'C2c: 店長拿到 audit 的 read 碼（不是 write 碼）');

  // C3：店長拿不到 dorm 的任何碼
  assertTrue(!Object.prototype.hasOwnProperty.call(leadRes.data.secrets, 'dorm'), 'C3: 店長 secrets 沒有 dorm 這個鍵');
  assertEqual(Object.keys(leadRes.data.secrets), ['audit'], 'C3b: 店長 secrets 只有 audit 一個鍵');

  // 額外：admin（*）→ audit 給 write、dorm 只有 write 一列，也給 write
  const adminRes = sandbox.handleLogin_({ username: 'admin1', password: PW.admin1 });
  assertTrue(adminRes.ok === true, 'C4a: admin 登入成功');
  assertEqual(adminRes.data.perms, ['*'], 'C4b: admin perms 為萬用字元');
  assertEqual(adminRes.data.secrets.audit, 'FAKE-AUDIT-WRITE-CODE', 'C4c: admin 拿到 audit 的 write 碼');
  assertEqual(adminRes.data.secrets.dorm, 'FAKE-DORM-WRITE-CODE', 'C4d: admin 拿到 dorm 的 write 碼');

  // 額外：manager（audit.read、dorm.write）→ 兩個後端各拿不同 level，證明是逐後端判斷
  const mgrRes = sandbox.handleLogin_({ username: 'mgr1', password: PW.mgr1 });
  assertTrue(mgrRes.ok === true, 'C5a: manager 登入成功');
  assertEqual(mgrRes.data.secrets.audit, 'FAKE-AUDIT-READ-CODE', 'C5b: manager 沒有 audit.write，audit 拿 read 碼');
  assertEqual(mgrRes.data.secrets.dorm, 'FAKE-DORM-WRITE-CODE', 'C5c: manager 有 dorm.write，dorm 拿 write 碼');
})();

// ============================================================
// D. hasPerm_：不得用前綴比對誤判
// ============================================================
(() => {
  const { sandbox } = freshApp();
  assertTrue(sandbox.hasPerm_(['audit.read'], 'audit.read.own') === false, "D1: hasPerm_(['audit.read'],'audit.read.own') 必須是 false（前綴誤判反例）");
  assertTrue(sandbox.hasPerm_(['audit.read.own'], 'audit.read') === false, 'D2: 反過來也一樣，不得前綴誤判');
  assertTrue(sandbox.hasPerm_(['audit.read'], 'audit.read') === true, 'D3: 完全相同的權限碼要比對成功');
  assertTrue(sandbox.hasPerm_(['*'], 'platform.users') === true, 'D4: 萬用字元 * 對任何權限碼都成立');
  assertTrue(sandbox.hasPerm_([], 'audit.read') === false, 'D5: 空陣列一律 false');
})();

// ============================================================
// E. 登入失敗鎖定：連錯 3 次後第 4 次回鎖定訊息
//    （Eason 2026-08-14 指定「給連續輸入三次錯誤的機會」，門檻由 5 改為 3）
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();
  for (let i = 1; i <= 3; i++) {
    const r = sandbox.handleLogin_({ username: 'lockuser', password: 'wrong-password' });
    assertTrue(r.ok === false && r.error === '帳號或密碼錯誤', 'E' + i + ': 第 ' + i + ' 次錯誤密碼 → 密碼錯誤（尚未鎖定）');
  }
  const fourth = sandbox.handleLogin_({ username: 'lockuser', password: 'wrong-password' });
  assertEqual(fourth, { ok: false, error: '嘗試次數過多，請 15 分鐘後再試' }, 'E4: 第 4 次回鎖定訊息（逐字）');

  // 鎖定期間就算密碼正確也一樣被擋
  const evenCorrect = sandbox.handleLogin_({ username: 'lockuser', password: PW.lockuser });
  assertEqual(evenCorrect, { ok: false, error: '嘗試次數過多，請 15 分鐘後再試' }, 'E5: 鎖定期間輸入正確密碼仍被擋');

  // login_log：3 筆 bad_password + 2 筆 locked，username 都是 lockuser
  const logRows = sheets.login_log._rows().slice(1); // 去表頭
  const forUser = logRows.filter((r) => r[1] === 'lockuser');
  assertEqual(forUser.filter((r) => r[3] === 'bad_password').length, 3, 'E8: login_log 有 3 筆 bad_password');
  assertEqual(forUser.filter((r) => r[3] === 'locked').length, 2, 'E9: login_log 有 2 筆 locked（第 4、5 次）');
  assertTrue(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(forUser[0][0]), 'E10: login_log 的 at 欄格式為 YYYY-MM-DD HH:mm:ss');
  assertEqual(forUser[0][2], '', 'E11: 沒傳 ipHash 時 login_log 的 ip_hash 欄留空字串');
})();

// ============================================================
// F. 停用帳號：login 擋下、me 每次重查 active
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();

  // F1: 已停用帳號即使密碼正確也登入失敗，且 log 是 disabled
  const res = sandbox.handleLogin_({ username: 'offuser', password: PW.offuser });
  assertEqual(res, { ok: false, error: '帳號已停用' }, 'F1: 停用帳號登入 → ok:false，訊息為帳號已停用');
  const logRows = sheets.login_log._rows().slice(1);
  assertTrue(logRows.some((r) => r[1] === 'offuser' && r[3] === 'disabled'), 'F2: login_log 記到一筆 offuser / disabled');

  // F3: 先用「還是啟用」的帳號登入拿到合法 token，之後把該帳號停用，me 要立刻擋下
  const loginRes = sandbox.handleLogin_({ username: 'lead1', password: PW.lead1 });
  assertTrue(loginRes.ok === true, 'F3a: lead1 登入成功並拿到 token');
  const token = loginRes.data.token;

  const meBeforeDisable = sandbox.handleMe_(token);
  assertTrue(meBeforeDisable.ok === true, 'F3b: 停用前 me 正常回傳');

  // 直接改 users 分頁的 active 欄（模擬管理者事後停用帳號）：lead1 是第 3 列（含表頭），active 是第 8 欄
  sheets.users.getRange(3, 8).setValue('FALSE');

  const meAfterDisable = sandbox.handleMe_(token);
  assertEqual(meAfterDisable, { ok: false, error: '帳號已停用' }, 'F4: token 沒過期，但帳號被停用後 me 立刻拒絕（每次重查 active）');
})();

// ============================================================
// G. me：正常路徑、無效 token
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const loginRes = sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 });
  const token = loginRes.data.token;

  const meRes = sandbox.handleMe_(token);
  assertTrue(meRes.ok === true, 'G1: me 有效 token → ok:true');
  assertEqual(meRes.data.user, loginRes.data.user, 'G2: me 回傳的 user 與 login 一致');
  assertEqual(meRes.data.perms, loginRes.data.perms, 'G3: me 回傳的 perms 與 login 一致');
  assertEqual(meRes.data.secrets, loginRes.data.secrets, 'G4: me 回傳的 secrets 與 login 一致');
  assertTrue(!Object.prototype.hasOwnProperty.call(meRes.data, 'token'), 'G5: me 回傳不含 token 欄位');

  assertEqual(sandbox.handleMe_('garbage-not-a-token'), { ok: false, error: '登入已失效，請重新登入' }, 'G6: 亂字串 token → 拒絕');
  assertEqual(sandbox.handleMe_(''), { ok: false, error: '登入已失效，請重新登入' }, 'G7: 空字串 token → 拒絕');
})();

// ============================================================
// H. 錯誤密碼 / 帳號不存在也不洩漏差異，且不外流 salt/hash
// ============================================================
(() => {
  const { sandbox } = freshApp();
  assertEqual(sandbox.handleLogin_({ username: 'acc1', password: 'totally-wrong' }), { ok: false, error: '帳號或密碼錯誤' }, 'H1: 密碼錯誤');
  assertEqual(sandbox.handleLogin_({ username: 'no-such-user', password: 'whatever' }), { ok: false, error: '帳號或密碼錯誤' }, 'H2: 帳號不存在（訊息與密碼錯誤相同，不洩漏帳號是否存在）');

  const res = sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 });
  const serialized = JSON.stringify(res);
  assertTrue(serialized.indexOf('salt-acc1') === -1, 'H3: 回傳內容不含 salt');
  assertTrue(serialized.indexOf('username') === -1, 'H4: user 物件不含 username 欄位');
})();

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
