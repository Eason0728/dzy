// node test/users.mock.test.mjs —— T1-5 驗收：Users.gs（人員管理四個 action）＋ Code.gs（doPost 白名單分派）
// 做法照 test/auth.mock.test.mjs：把 .gs 檔當文字讀進來，丟進 node vm 的 sandbox 執行。
// 這次要把 Auth.gs／Users.gs／Code.gs 三支依序跑進「同一個」 sandbox context，
// 因為 Users.gs 呼叫 Auth.gs 的 handleMe_／hasPerm_ 等函式、Code.gs 呼叫 Users.gs 的 handle*_，
// 這正是同一個 Apps Script 專案共用全域範疇的真實情境。
// 零依賴、直跑、失敗時 process.exit(1)。
//
// ⚠ 下面所有帳密都是本測試檔自造的假資料（一看就是 test/fake 字樣），不是任何真實系統的密碼。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORM_DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const AUTH_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Auth.gs'), 'utf8');
const USERS_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Users.gs'), 'utf8');
const CODE_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Code.gs'), 'utf8');

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
// GAS 全域物件的假實作（同 auth.mock.test.mjs，另外加 ContentService）
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

let uuidCounter = 0;
function makeUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: (_algo, value) => toSignedBytes(crypto.createHash('sha256').update(toBuffer(value)).digest()),
    computeHmacSha256Signature: (value, key) =>
      toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
    base64Encode: (data) => toBuffer(data).toString('base64'),
    base64Decode: (str) => toSignedBytes(Buffer.from(String(str), 'base64')),
    // 真隨機（測試用計數器 + random，確保每次呼叫都不同，足夠驗證「產生新 salt」這件事）
    getUuid: () => 'fake-uuid-' + (++uuidCounter) + '-' + crypto.randomBytes(8).toString('hex')
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

function makeContentService() {
  return {
    MimeType: { JSON: 'JSON' },
    createTextOutput(text) {
      return {
        _text: text,
        _mimeType: null,
        setMimeType(mt) {
          this._mimeType = mt;
          return this;
        },
        getContent() {
          return this._text;
        }
      };
    }
  };
}

// loadPlatform(sheetsSeed, propsSeed) → { sandbox, sheets }
// Auth.gs → Users.gs → Code.gs 依序跑進同一個 vm context，模擬同一個 Apps Script 專案共用全域範疇。
function loadPlatform(sheetsSeed, propsSeed) {
  const ssApp = makeSpreadsheetApp(sheetsSeed);
  const sandbox = {
    console,
    SpreadsheetApp: ssApp.api,
    Utilities: makeUtilities(),
    PropertiesService: makePropertiesService(propsSeed),
    CacheService: makeCacheService(),
    ContentService: makeContentService()
  };
  vm.createContext(sandbox);
  vm.runInContext(AUTH_GS_CODE, sandbox, { filename: 'Auth.gs' });
  vm.runInContext(USERS_GS_CODE, sandbox, { filename: 'Users.gs' });
  vm.runInContext(CODE_GS_CODE, sandbox, { filename: 'Code.gs' });
  return { sandbox, sheets: ssApp.sheets };
}

/** 模擬 doPost 收到的事件物件：body 可以是物件（會 JSON.stringify）或已經是字串（原樣送，用來測「不是合法 JSON」） */
function callDoPost(sandbox, body) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  const e = { postData: { contents } };
  const out = sandbox.doPost(e);
  return JSON.parse(out.getContent());
}

function callDoGet(sandbox, e) {
  const out = sandbox.doGet(e);
  return JSON.parse(out.getContent());
}

// ── 密碼雜湊工具（用一個不帶業務資料的 sandbox 算，避免雞生蛋問題）──────
const HASH_TOOL = loadPlatform(
  { users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] },
  { HMAC_SECRET: 'tool-only-not-used-for-signing' }
);
function hashFor(pw, salt) {
  return HASH_TOOL.sandbox.hashPassword_(pw, salt);
}

// ── 測試資料 ─────────────────────────────────────────────────────────
const PW = {
  admin1: 'test-pw-admin-01',
  acc1: 'test-pw-accountant-01',
  lead1: 'test-pw-storelead-01'
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
    ['u001', 'acc1', '王會計', 'accountant', '', 'salt-acc1', hashFor(PW.acc1, 'salt-acc1'), 'TRUE', '2026-01-01 09:00:00', ''],
    ['u002', 'lead1', '林店長', 'storelead', 'sxl-gf', 'salt-lead1', hashFor(PW.lead1, 'salt-lead1'), 'TRUE', '2026-01-01 09:00:00', ''],
    ['u003', 'admin1', '系統管理者帳號', 'admin', '', 'salt-admin1', hashFor(PW.admin1, 'salt-admin1'), 'TRUE', '2026-01-01 09:00:00', '']
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
  return loadPlatform(freshSheets(), { HMAC_SECRET: 'fake-hmac-secret-for-tests-only' });
}

/** 用 doPost 的 login action 拿 token（走完整路徑，比直接呼叫 issueToken_ 更貼近真實情境） */
function loginToken(sandbox, username, password) {
  const res = callDoPost(sandbox, { action: 'login', payload: { username, password } });
  if (!res.ok) throw new Error('loginToken 失敗：' + username + ' → ' + res.error);
  return res.data.token;
}

// ============================================================
// A. doPost 白名單分派：未知 action／不是合法 JSON／缺 action，都不拋例外、都回 ok:false
// ============================================================
(() => {
  const { sandbox } = freshApp();

  const r1 = callDoPost(sandbox, { action: 'deleteEverything', token: 'x', payload: {} });
  assertTrue(r1.ok === false, 'A1: 未知 action 被拒（ok:false）');

  let threw = false;
  let r2;
  try {
    r2 = callDoPost(sandbox, '{ this is not json ');
  } catch (e) {
    threw = true;
  }
  assertTrue(threw === false, 'A2: body 不是合法 JSON 不拋例外');
  assertTrue(r2 && r2.ok === false, 'A2b: body 不是合法 JSON 回 ok:false');

  const r3 = callDoPost(sandbox, { token: 'x', payload: {} }); // 缺 action
  assertTrue(r3.ok === false, 'A3: 缺 action 被拒（ok:false）');

  const r4 = callDoPost(sandbox, { action: 123, payload: {} }); // action 不是字串
  assertTrue(r4.ok === false, 'A4: action 不是字串被拒');

  let threw5 = false;
  let r5;
  try {
    r5 = sandbox.doPost(undefined); // e 本身就不合法
  } catch (e) {
    threw5 = true;
  }
  assertTrue(threw5 === false, 'A5: doPost(undefined) 不拋例外');
  const parsed5 = r5 ? JSON.parse(r5.getContent()) : null;
  assertTrue(parsed5 && parsed5.ok === false, 'A5b: doPost(undefined) 回 ok:false');

  const r6 = callDoGet(sandbox, { parameter: { action: 'listUsers' } }); // doGet 不接受任何 action
  assertEqual(r6, { ok: true, data: { service: 'dzy-platform' } }, 'A6: doGet 健康檢查回固定內容，忽略任何 action 參數');
})();

// ============================================================
// B. 沒有 platform.users 權限的 token 呼叫四個 handler，全部被拒
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const accToken = loginToken(sandbox, 'acc1', PW.acc1); // accountant：audit.read/audit.write，沒有 platform.users

  const rList = callDoPost(sandbox, { action: 'listUsers', token: accToken, payload: {} });
  assertEqual(rList, { ok: false, error: '沒有權限' }, 'B1: 無權限帳號呼叫 listUsers 被拒');

  const rSave = callDoPost(sandbox, {
    action: 'saveUser', token: accToken,
    payload: { username: 'sneaky', name: '偷渡', role: 'staff', node: '', password: 'whatever1' }
  });
  assertEqual(rSave, { ok: false, error: '沒有權限' }, 'B2: 無權限帳號呼叫 saveUser 被拒');

  const rActive = callDoPost(sandbox, { action: 'setActive', token: accToken, payload: { id: 'u002', active: false } });
  assertEqual(rActive, { ok: false, error: '沒有權限' }, 'B3: 無權限帳號呼叫 setActive 被拒');

  const rReset = callDoPost(sandbox, { action: 'resetPassword', token: accToken, payload: { id: 'u002', newPassword: 'brandnewpw1' } });
  assertEqual(rReset, { ok: false, error: '沒有權限' }, 'B4: 無權限帳號呼叫 resetPassword 被拒');

  // 額外：無效 token 一樣被拒（不是因為權限訊息洩漏內部細節）
  const rGarbage = callDoPost(sandbox, { action: 'listUsers', token: 'garbage-token', payload: {} });
  assertTrue(rGarbage.ok === false, 'B5: 無效 token 呼叫 listUsers 也被拒');
})();

// ============================================================
// C. listUsers：回傳不含 salt／hash
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const res = callDoPost(sandbox, { action: 'listUsers', token: adminToken, payload: {} });
  assertTrue(res.ok === true, 'C1: admin 呼叫 listUsers 成功');
  assertTrue(Array.isArray(res.data.users) && res.data.users.length === 3, 'C2: listUsers 回傳三筆種子使用者');

  res.data.users.forEach((u, i) => {
    assertTrue(!Object.prototype.hasOwnProperty.call(u, 'salt'), 'C3.' + i + ': 使用者物件不含 salt 欄');
    assertTrue(!Object.prototype.hasOwnProperty.call(u, 'hash'), 'C3.' + i + ': 使用者物件不含 hash 欄');
  });

  const first = res.data.users.find((u) => u.id === 'u001');
  assertEqual(
    Object.keys(first).sort(),
    ['active', 'created_at', 'id', 'last_login_at', 'name', 'node', 'role', 'username'].sort(),
    'C4: 使用者物件的 key 集合正確（id/username/name/role/node/active/created_at/last_login_at）'
  );
})();

// ============================================================
// D. saveUser 新增：id 格式 ^u[0-9]{3,6}$，連續新增遞增
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const r1 = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'newlead1', name: '新店長一', role: 'storelead', node: 'ck', password: 'longenoughpw1' }
  });
  assertTrue(r1.ok === true, 'D1: 新增第一位使用者成功');
  assertTrue(/^u[0-9]{3,6}$/.test(r1.data.id), 'D2: 新 id 符合 ^u[0-9]{3,6}$ 格式（實際：' + (r1.data && r1.data.id) + '）');
  assertEqual(r1.data.id, 'u004', 'D3: 種子最大 id 是 u003，新增後應為 u004');

  const r2 = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'newlead2', name: '新店長二', role: 'storelead', node: 'mzt-gf', password: 'longenoughpw2' }
  });
  assertTrue(r2.ok === true, 'D4: 新增第二位使用者成功');
  assertEqual(r2.data.id, 'u005', 'D5: 連續新增第二筆遞增為 u005');

  const listRes = callDoPost(sandbox, { action: 'listUsers', token: adminToken, payload: {} });
  assertEqual(listRes.data.users.length, 5, 'D6: listUsers 現在有 5 筆（3 筆種子 + 2 筆新增）');
})();

// ============================================================
// E. username 重複被拒（含大小寫與前後空白的變形）
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const variants = ['acc1', 'ACC1', ' acc1', 'acc1 ', ' AcC1 '];
  variants.forEach((variant, i) => {
    const res = callDoPost(sandbox, {
      action: 'saveUser', token: adminToken,
      payload: { username: variant, name: '重複測試' + i, role: 'staff', node: '', password: 'longenoughpwX' }
    });
    assertTrue(res.ok === false, 'E' + i + ": username 變形「" + variant + "」重複被拒");
  });

  // 對照組：真的沒重複的帳號應該成功
  const okRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'brandnewname', name: '真的沒重複', role: 'staff', node: '', password: 'longenoughpwY' }
  });
  assertTrue(okRes.ok === true, 'E-ok: 沒有重複的帳號可以正常新增（對照組）');
})();

// ============================================================
// F. node 給不存在的代號被拒
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const beforeCount = sheets.users._rows().length;
  const res = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'badnode', name: '壞節點', role: 'storelead', node: 'sxl-mc', password: 'longenoughpwZ' }
  });
  assertTrue(res.ok === false, 'F1: node=sxl-mc（不存在的代號）被拒');

  const afterCount = sheets.users._rows().length;
  assertEqual(afterCount, beforeCount, 'F2: 驗證失敗時完全沒有寫入（列數不變）');

  // 對照組：空字串節點合法
  const okRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'nonode', name: '無節點', role: 'accountant', node: '', password: 'longenoughpwW' }
  });
  assertTrue(okRes.ok === true, 'F3: node 為空字串（不限節點）合法，對照組成功');

  // 五個合法節點代號都要能通過
  const validNodes = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'];
  validNodes.forEach((node, i) => {
    const r = callDoPost(sandbox, {
      action: 'saveUser', token: adminToken,
      payload: { username: 'nodeok' + i, name: '節點' + node, role: 'storelead', node, password: 'longenoughpwV' }
    });
    assertTrue(r.ok === true, 'F4.' + i + ': 合法節點代號「' + node + '」可以新增成功');
  });
})();

// ============================================================
// G. resetPassword：少於 8 字元被拒；成功時 salt 與 hash 都變了
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const shortRes = callDoPost(sandbox, {
    action: 'resetPassword', token: adminToken, payload: { id: 'u001', newPassword: 'short7x' }
  });
  assertTrue(shortRes.ok === false, 'G1: 少於 8 字元的新密碼被拒（實際長度 7）');
  assertEqual(shortRes.error, '密碼至少需要 8 個字元', 'G1b: 錯誤訊息為指定文字');

  const beforeRow = sheets.users._rows().find((r) => r[0] === 'u001');
  const beforeSalt = beforeRow[5];
  const beforeHash = beforeRow[6];

  const okRes = callDoPost(sandbox, {
    action: 'resetPassword', token: adminToken, payload: { id: 'u001', newPassword: 'brand-new-password-8plus' }
  });
  assertTrue(okRes.ok === true, 'G2: 8 字元以上的新密碼重設成功');
  assertEqual(okRes.data, {}, 'G2b: resetPassword 成功回傳 data 為空物件');

  const afterRow = sheets.users._rows().find((r) => r[0] === 'u001');
  const afterSalt = afterRow[5];
  const afterHash = afterRow[6];

  assertTrue(afterSalt !== beforeSalt, 'G3: salt 已經改變');
  assertTrue(afterHash !== beforeHash, 'G4: hash 已經改變');

  // 用新密碼可以登入，舊密碼不能
  const loginNew = callDoPost(sandbox, { action: 'login', payload: { username: 'acc1', password: 'brand-new-password-8plus' } });
  assertTrue(loginNew.ok === true, 'G5: 用重設後的新密碼登入成功');
  const loginOld = callDoPost(sandbox, { action: 'login', payload: { username: 'acc1', password: PW.acc1 } });
  assertTrue(loginOld.ok === false, 'G6: 用重設前的舊密碼登入失敗');
})();

// ============================================================
// H. saveUser 修改既有使用者：帶 password 不會改到密碼（hash 不變）
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const beforeRow = sheets.users._rows().find((r) => r[0] === 'u001');
  const beforeSalt = beforeRow[5];
  const beforeHash = beforeRow[6];
  const beforeCreatedAt = beforeRow[8];

  const res = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { id: 'u001', username: 'acc1', name: '王會計（改名）', role: 'accountant', node: '', password: 'try-to-hijack-password' }
  });
  assertTrue(res.ok === true, 'H1: 修改既有使用者成功');
  assertEqual(res.data.id, 'u001', 'H2: 修改回傳原本的 id');

  const afterRow = sheets.users._rows().find((r) => r[0] === 'u001');
  assertEqual(afterRow[2], '王會計（改名）', 'H3: 姓名確實被更新');
  assertEqual(afterRow[5], beforeSalt, 'H4: salt 未被改變（payload 帶 password 也不影響）');
  assertEqual(afterRow[6], beforeHash, 'H5: hash 未被改變（payload 帶 password 也不影響）');
  assertEqual(afterRow[8], beforeCreatedAt, 'H6: created_at 保留原值，沒有被清空或重產');

  // 用原密碼仍然能登入，證明密碼真的沒被改掉
  const loginRes = callDoPost(sandbox, { action: 'login', payload: { username: 'acc1', password: PW.acc1 } });
  assertTrue(loginRes.ok === true, 'H7: 修改後用原密碼仍可登入');
})();

// ============================================================
// I. saveUser 新增帳號：密碼長度規則須與 resetPassword 一致（spec §5.2 2026-08-15 補）
//    對抗審查抓到的缺陷①：原本只檢查 !password，一位數密碼也能直接建帳號。
// ============================================================
(() => {
  const { sandbox, sheets } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);
  const beforeCount = sheets.users._rows().length;

  const shortRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'onedigit', name: '一位數密碼', role: 'staff', node: '', password: 'x' }
  });
  assertTrue(shortRes.ok === false, 'I1: 新增帳號密碼只有 1 個字元被拒');
  assertEqual(
    shortRes.error, '密碼至少需要 8 個字元',
    'I1b: 錯誤訊息沿用 resetPassword 既有的 USR_MSG_PASSWORD_TOO_SHORT，不是另造的訊息'
  );

  const sevenRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'sevenchar', name: '七字元密碼', role: 'staff', node: '', password: 'short7x' }
  });
  assertTrue(sevenRes.ok === false, 'I2: 新增帳號密碼 7 個字元（差一個字元）被拒');

  const emptyRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'nopw', name: '沒帶密碼', role: 'staff', node: '' } // 完全不帶 password 欄
  });
  assertTrue(emptyRes.ok === false, 'I3: 新增帳號完全不帶 password 欄位被拒');

  const afterCount = sheets.users._rows().length;
  assertEqual(afterCount, beforeCount, 'I4: 三次密碼過短的嘗試都沒有寫入任何一列');

  // 邊界：剛好 8 個字元要能通過
  const eightRes = callDoPost(sandbox, {
    action: 'saveUser', token: adminToken,
    payload: { username: 'eightchar', name: '八字元密碼', role: 'staff', node: '', password: 'exact8ch' }
  });
  assertTrue(eightRes.ok === true, 'I5: 新增帳號密碼剛好 8 個字元可以成功（邊界）');
})();

// ============================================================
// J. doPost：被 catch 的未預期例外一律換成通用訊息；handler 正常 return 的業務訊息原樣保留
//    對抗審查抓到的缺陷②：原本 catch(err){ error: err.message } 會把內部結構原文送給前端。
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  // 讓一個 handler 真的拋出例外（模擬未預期的內部錯誤），走完整 doPost → dispatch_ 路徑
  sandbox.handleListUsers_ = function () {
    throw new Error('內部錯誤：找不到工作表 secret_internal_sheet_name，函式 handleListUsers_ 第 42 行');
  };

  const res = callDoPost(sandbox, { action: 'listUsers', token: adminToken, payload: {} });
  assertTrue(res.ok === false, 'J1: 被 catch 的未預期例外仍回 ok:false（不讓例外變成 500）');
  assertEqual(res.error, '系統忙碌中，請稍後再試', 'J2: 前端拿到的是通用訊息，不是例外原文');
  assertTrue(
    res.error.indexOf('secret_internal_sheet_name') === -1 && res.error.indexOf('handleListUsers_') === -1,
    'J3: 通用訊息完全不含原始例外訊息的分頁名／函式名（沒有洩漏內部結構）'
  );
})();

(() => {
  // 對照組（這條最容易改壞）：handler 自己正常 return 的業務錯誤訊息，不是例外，不能被①的通用化規則誤吃
  const { sandbox } = freshApp();

  const loginRes = callDoPost(sandbox, { action: 'login', payload: { username: 'acc1', password: 'totally-wrong-password' } });
  assertTrue(loginRes.ok === false, 'J4: 密碼錯誤的登入失敗');
  assertEqual(loginRes.error, '帳號或密碼錯誤', 'J5: 業務錯誤訊息原樣保留，沒有被換成通用訊息');

  const accToken = loginToken(sandbox, 'acc1', PW.acc1);
  const noPermRes = callDoPost(sandbox, { action: 'listUsers', token: accToken, payload: {} });
  assertEqual(noPermRes.error, '沒有權限', 'J6: 「沒有權限」這類業務訊息也原樣保留');
})();

// ============================================================
// K. listRoles（spec §5.2 2026-08-15 新增）—— 對抗審查抓到的缺陷③：角色清單不得硬編碼
// ============================================================
(() => {
  const { sandbox } = freshApp();
  const accToken = loginToken(sandbox, 'acc1', PW.acc1); // accountant 沒有 platform.users

  const noPermRes = callDoPost(sandbox, { action: 'listRoles', token: accToken, payload: {} });
  assertEqual(noPermRes, { ok: false, error: '沒有權限' }, 'K1: 沒有 platform.users 權限呼叫 listRoles 被拒');
})();

(() => {
  const { sandbox } = freshApp();
  const adminToken = loginToken(sandbox, 'admin1', PW.admin1);

  const res = callDoPost(sandbox, { action: 'listRoles', token: adminToken, payload: {} });
  assertTrue(res.ok === true, 'K2: 有權限的帳號呼叫 listRoles 成功');
  assertTrue(Array.isArray(res.data.roles) && res.data.roles.length === 5, 'K3: 回傳五個角色（roles 分頁種子筆數）');

  assertEqual(
    res.data.roles,
    [
      { role: 'admin', name_zh: '系統管理者', perms: ['*'] },
      { role: 'manager', name_zh: '部門主管', perms: ['audit.read', 'dorm.read', 'dorm.write'] },
      { role: 'accountant', name_zh: '會計', perms: ['audit.read', 'audit.write'] },
      { role: 'storelead', name_zh: '店長', perms: ['audit.read.own'] },
      { role: 'staff', name_zh: '員工', perms: [] }
    ],
    'K4: 五個角色的 role/name_zh/perms 都正確，perms 已展開成陣列（* 展開成 [\'*\']，空字串展開成 []）'
  );

  res.data.roles.forEach((r) => {
    assertTrue(Array.isArray(r.perms), 'K5.' + r.role + ': perms 欄一定是陣列型別');
  });
})();

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
