// node test/rescue-admin.mock.test.mjs —— 救回管理員 rescueAdmin()（Bootstrap.gs）：找不到不新建、成功後可登入、舊 token 失效、鎖定被清、不在分派表
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
const PERMS_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Perms.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(PLATFORM_DIR, 'PermActions.gs'), 'utf8');
const USERS_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Users.gs'), 'utf8');
const CODE_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Code.gs'), 'utf8');
const BOOT_GS_CODE = fs.readFileSync(path.join(PLATFORM_DIR, 'Bootstrap.gs'), 'utf8');

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

// LockService 假物件（2026-09-28 補）：平台後端 b13b402 起寫入動作會先 LockService.getScriptLock()，
// 這個假環境沒有它，所有寫入都掉進 catch 回「系統忙碌中」，D 區整段失敗。
// 記錄上鎖／解鎖次數，L 區斷言寫入動作真的有上鎖且一定解鎖。
function makeLockService() {
  const stats = { tryLock: 0, release: 0 };
  return {
    stats,
    getScriptLock() {
      return {
        tryLock() { stats.tryLock++; return true; },
        releaseLock() { stats.release++; }
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
    ContentService: makeContentService(),
    LockService: makeLockService(),
    Logger: { logs: [], log(m) { this.logs.push(String(m)); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(AUTH_GS_CODE, sandbox, { filename: 'Auth.gs' });
  vm.runInContext(USERS_GS_CODE, sandbox, { filename: 'Users.gs' });
  vm.runInContext(PERMS_GS_CODE, sandbox, { filename: 'Perms.gs' });
  vm.runInContext(CODE_GS_CODE, sandbox, { filename: 'Code.gs' });
  vm.runInContext(BOOT_GS_CODE, sandbox, { filename: 'Bootstrap.gs' });
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
    ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'],
    ['u001', 'acc1', '王會計', 'accountant', '', 'salt-acc1', hashFor(PW.acc1, 'salt-acc1'), 'TRUE', '2026-01-01 09:00:00', ''],
    ['u002', 'lead1', '林店長', 'storelead', 'sxl-gf', 'salt-lead1', hashFor(PW.lead1, 'salt-lead1'), 'TRUE', '2026-01-01 09:00:00', ''],
    ['u003', 'admin1', '系統管理者帳號', 'admin', '', 'salt-admin1', hashFor(PW.admin1, 'salt-admin1'), 'TRUE', '2026-01-01 09:00:00', ''],
    ['u004', 'gone1', '被停用的管理員', 'storelead', 'sxl-gf', 'salt-gone', hashFor('old-gone-pw-0001', 'salt-gone'), 'FALSE', '2026-01-01 09:00:00', '']
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
function setProps(sandbox, u, pw) {
  const p = sandbox.PropertiesService.getScriptProperties();
  if (u !== null) p.setProperty('BOOTSTRAP_USERNAME', u);
  if (pw !== null) p.setProperty('BOOTSTRAP_PASSWORD', pw);
  return p;
}
const NEWPW = 'brand-new-rescue-pw-9';

// 1. 找不到帳號：不新建、印 ❌、不動任何列
(() => {
  const { sandbox, sheets } = freshApp();
  const p = setProps(sandbox, 'nobody', NEWPW);
  const before = JSON.stringify(sheets.users._rows());
  sandbox.rescueAdmin();
  assertEqual(JSON.stringify(sheets.users._rows()), before, 'R1: 找不到帳號 → users 完全沒變（不新建）');
  assertTrue(sandbox.Logger.logs.some((l) => l.indexOf('❌') === 0), 'R1b: Logger 印 ❌');
})();

// 2. 缺屬性／密碼太短
(() => {
  const { sandbox, sheets } = freshApp();
  const before = JSON.stringify(sheets.users._rows());
  sandbox.rescueAdmin();
  assertTrue(JSON.stringify(sheets.users._rows()) === before && sandbox.Logger.logs.some((l) => l.indexOf('❌') === 0), 'R2: 沒設屬性 → ❌ 不動');
  setProps(sandbox, 'acc1', 'short');
  sandbox.rescueAdmin();
  assertTrue(JSON.stringify(sheets.users._rows()) === before, 'R2b: 密碼不到 8 字 → 不動');
})();

// 3. 成功：停用的帳號被救回、role admin、可登入、舊 token 失效、鎖定被清、屬性被刪、不印密碼
(() => {
  const { sandbox, sheets } = freshApp();
  const oldTok = loginToken(sandbox, 'acc1', PW.acc1);
  // 鎖住 acc1（兩個來源各一把）
  for (const ip of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', '']) {
    for (let i = 0; i < 3; i++) callDoPost(sandbox, { action: 'login', payload: { username: 'acc1', password: 'wrong-pw-xxxx' } });
    for (let i = 0; i < 3; i++) sandbox.handleLogin_({ username: 'acc1', password: 'wrong-pw-xxxx' }, ip);
  }
  assertTrue(sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 }, 'aaaaaaaaaaaa').ok === false, 'R3 前置：acc1 被鎖');
  sandbox.CacheService.getScriptCache().put('usr_selfpw:u001', JSON.stringify({ count: 5, since: 1, lockedUntil: 9999999999 }), 600);
  const otherBefore = JSON.stringify(sheets.users._rows().filter((r) => r[0] !== 'u001'));
  const p = setProps(sandbox, 'ACC1', NEWPW);
  sandbox.rescueAdmin();
  const row = sheets.users._rows().find((r) => r[0] === 'u001');
  assertTrue(row[3] === 'admin' && String(row[7]).toUpperCase() === 'TRUE', 'R3a: role=admin、active=TRUE');
  assertTrue(row[1] === 'acc1' && row[2] === '王會計' && row[8] === '2026-01-01 09:00:00', 'R3b: 其他欄（帳號、姓名、建立時間）沒被改');
  assertEqual(JSON.stringify(sheets.users._rows().filter((r) => r[0] !== 'u001')), otherBefore, 'R3c: 其他帳號的列完全沒動');
  assertTrue(sheets.users._rows().length === 5, 'R3d: 列數沒變（沒新建）');
  assertTrue(Number(row[10]) > 0, 'R3e: token_after 已寫');
  assertTrue(callDoPost(sandbox, { action: 'me', token: oldTok, payload: {} }).ok === false, 'R3f: 舊 token 失效');
  const lg = sandbox.handleLogin_({ username: 'acc1', password: NEWPW }, 'aaaaaaaaaaaa');
  assertTrue(lg.ok === true && lg.data.user.role === 'admin', 'R3g: 新密碼可登入（原本被鎖的來源也行）', lg);
  assertTrue(sandbox.handleLogin_({ username: 'acc1', password: PW.acc1 }, 'cccccccccccc').ok === false, 'R3h: 舊密碼不能登入');
  assertTrue(sandbox.CacheService.getScriptCache().get('usr_selfpw:u001') === null, 'R3i: 改密碼失敗鎖定快取被清');
  assertTrue(p.getProperty('BOOTSTRAP_USERNAME') === null && p.getProperty('BOOTSTRAP_PASSWORD') === null, 'R3j: 兩個暫時屬性都被刪');
  assertTrue(sandbox.Logger.logs.some((l) => l.indexOf('✅') === 0) && !sandbox.Logger.logs.some((l) => l.indexOf(NEWPW) !== -1), 'R3k: 印 ✅、不印密碼');
})();
(() => {
  const { sandbox, sheets } = freshApp();
  setProps(sandbox, 'gone1', NEWPW);
  sandbox.rescueAdmin();
  const lg = sandbox.handleLogin_({ username: 'gone1', password: NEWPW }, '');
  assertTrue(lg.ok === true && lg.data.user.role === 'admin', 'R4: 被停用的帳號救回後啟用且可登入', lg);
})();

// 5. 不在分派表
(() => {
  const { sandbox } = freshApp();
  setProps(sandbox, 'acc1', NEWPW);
  const r = callDoPost(sandbox, { action: 'rescueAdmin', payload: {} });
  assertTrue(r.ok === false && r.error === '不支援的操作', 'R5: rescueAdmin 不在分派表', r);
  assertTrue(!/rescueAdmin/.test(CODE_GS_CODE), 'R5b: Code.gs 沒有 rescueAdmin 字樣');
})();

if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
