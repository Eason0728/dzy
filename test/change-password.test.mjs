// node test/change-password.test.mjs —— 修改密碼（2026-08-17，Eason 指定「同仁可自己改密碼」）
//
// 這支測兩層，因為這個功能寫錯就是提權漏洞：
//   A. 前端 platform/auth.js 的 changePassword()：送出的形狀、token 自動帶、失敗不拋例外
//   B. 後端 apps-script/platform/Users.gs 的 handleChangePassword_()：用 vm 沙箱跑真的 .gs 原始碼
//      （做法同 ~/mala-audit/test/gas-*.test.js），重點釘住三條安全規則：
//        1. 一定要驗舊密碼
//        2. 身分只認 token，payload 夾帶 id 一律無效（否則＝登入任一帳號即可改他人密碼）
//        3. 不需要 platform.users 權限（一般同仁本來就要能改自己的）
//
// ⚠ 下面所有帳密都是本測試檔自造的假資料，不是任何真實系統的密碼。

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

async function t(label, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + label);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  ' + (err && err.message));
  }
}

// ============================================================
// A. 前端 platform/auth.js
// ============================================================

class MemoryStorage {
  constructor() { this._map = new Map(); }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
}
globalThis.localStorage = new MemoryStorage();

const auth = await import('../platform/auth.js');

await t('A1: changePassword 送出 action/token/payload 的形狀正確，token 自動帶（呼叫端不必自己塞）', async () => {
  localStorage.setItem('dzy.token', 'tok-abc');
  const calls = [];
  auth.__setTransport(async (req) => { calls.push(req); return { ok: true, data: {} }; });

  const res = await auth.changePassword('oldpw123', 'newpw45678');
  assert.equal(res.ok, true, '應該回 ok');
  assert.equal(calls.length, 1, '應該只打一次後端');
  assert.equal(calls[0].action, 'changePassword');
  assert.equal(calls[0].token, 'tok-abc', 'token 應該自動從 session 帶上');
  assert.deepEqual(calls[0].payload, { oldPassword: 'oldpw123', newPassword: 'newpw45678' });
});

await t('A2: 前端不送 id（身分只能由後端從 token 決定，不給呼叫端指定對象的機會）', async () => {
  const calls = [];
  auth.__setTransport(async (req) => { calls.push(req); return { ok: true, data: {} }; });
  await auth.changePassword('a12345678', 'b12345678');
  assert.equal('id' in calls[0].payload, false, 'payload 不得含 id');
  assert.equal('username' in calls[0].payload, false, 'payload 不得含 username');
});

await t('A3: 後端回 {ok:false} 時原樣回傳錯誤訊息，不拋例外', async () => {
  auth.__setTransport(async () => ({ ok: false, error: '目前密碼不正確' }));
  const res = await auth.changePassword('wrong', 'newpw45678');
  assert.deepEqual(res, { ok: false, error: '目前密碼不正確' });
});

await t('A4: transport 拋例外（斷網）收斂成 {ok:false}，不讓畫面炸掉', async () => {
  auth.__setTransport(async () => { throw new Error('boom'); });
  const res = await auth.changePassword('a12345678', 'b12345678');
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
});

auth.__setTransport(null);

// ============================================================
// B. 後端 apps-script/platform/Users.gs（vm 沙箱跑真的 .gs）
// ============================================================

/**
 * 建一個最小可用的 GAS 沙箱：只實作被測程式碼真的會用到的 API。
 * hashPassword_ 用可預測的假雜湊（salt:pw 反轉），這樣測試不必真的跑 10000 次 SHA-256，
 * 但「舊密碼要能算出同一個 hash 才算過」這條行為完全一樣。
 */
function makeSandbox(usersRows) {
  // 替身要涵蓋 readUsersRawRows_ 用到的 getLastRow／getLastColumn／getRange().getValues()，
  // 以及寫入用的 getRange().setValues()。第 1 列是標題列，資料列從第 2 列起。
  const sheet = {
    _rows: usersRows,
    getLastRow() { return sheet._rows.length + 1; },
    getLastColumn() { return 10; },
    getRange(row, col, numRows, numCols) {
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const src = sheet._rows[row - 2 + i] || [];
            out.push(src.slice(col - 1, col - 1 + numCols));
          }
          return out;
        },
        setValues(values) {
          for (let i = 0; i < numRows; i++) {
            for (let j = 0; j < numCols; j++) {
              sheet._rows[row - 2 + i][col - 1 + j] = values[i][j];
            }
          }
        }
      };
    }
  };

  const sandbox = {
    console,
    Utilities: { getUuid: () => 'new-salt-uuid' },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => sheet }) },
    // 被測函式依賴的既有函式，用最小替身（它們各自有自己的測試）
    hashPassword_: (pw, salt) => 'H(' + salt + ':' + pw + ')',
    handleMe_: (token) => sandbox.__meResult(token),
    hasPerm_: (perms, need) => Array.isArray(perms) && (perms.indexOf('*') !== -1 || perms.indexOf(need) !== -1),
    __sheet: sheet
  };
  vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(ROOT, 'apps-script', 'platform', 'Users.gs'), 'utf8');
  vm.runInContext(src, sandbox);
  return sandbox;
}

// users 欄序（Users.gs USR_COL）：id, username, name, role, node, salt, hash, active, created_at, last_login_at
const ROW_ALICE = ['u001', 'alice', '小美', 'storelead', 'sxl-gf', 'salt-a', 'H(salt-a:alicepw123)', 'TRUE', '', ''];
const ROW_BOB = ['u002', 'bob', '阿宏', 'accountant', '', 'salt-b', 'H(salt-b:bobpw12345)', 'TRUE', '', ''];

function setupAs(userId, perms) {
  const rows = [ROW_ALICE.slice(), ROW_BOB.slice()];
  const sb = makeSandbox(rows);
  const row = rows.find((r) => r[0] === userId);
  sb.__meResult = () => ({
    ok: true,
    data: { user: { id: row[0], name: row[2], role: row[3], node: row[4] }, perms, secrets: {} }
  });
  return { sb, rows };
}

await t('B1: 舊密碼正確 → 改成功，該列 salt 與 hash 都被換掉', async () => {
  const { sb, rows } = setupAs('u001', ['audit.read.own']);   // 一般店長，沒有 platform.users
  const res = sb.handleChangePassword_('tok', { oldPassword: 'alicepw123', newPassword: 'brandnew123' });
  assert.equal(res.ok, true, '應該成功：' + JSON.stringify(res));
  assert.equal(rows[0][5], 'new-salt-uuid', 'salt 應更新');
  assert.equal(rows[0][6], 'H(new-salt-uuid:brandnew123)', 'hash 應以新 salt 重算');
});

await t('B2: 一般同仁不需要 platform.users 權限也能改自己的密碼', async () => {
  const { sb } = setupAs('u001', []);   // 完全沒有任何權限碼
  const res = sb.handleChangePassword_('tok', { oldPassword: 'alicepw123', newPassword: 'brandnew123' });
  assert.equal(res.ok, true, '沒有 perm 也應該能改自己的：' + JSON.stringify(res));
});

await t('B3: 舊密碼錯誤 → 拒絕，且該列 salt/hash 一個字都沒動', async () => {
  const { sb, rows } = setupAs('u001', ['*']);
  const before = rows[0].slice();
  const res = sb.handleChangePassword_('tok', { oldPassword: '這不是舊密碼', newPassword: 'brandnew123' });
  assert.equal(res.ok, false);
  assert.equal(res.error, '目前密碼不正確');
  assert.deepEqual(rows[0], before, '失敗時不得寫入任何欄位');
});

await t('B4: ★payload 夾帶別人的 id 一律無效——改到的仍是 token 本人那一列（提權防線）', async () => {
  const { sb, rows } = setupAs('u001', ['audit.read.own']);
  const bobBefore = rows[1].slice();
  // 攻擊情境：alice 登入，卻在 payload 塞 bob 的 id，並用 alice 自己的舊密碼
  const res = sb.handleChangePassword_('tok', {
    id: 'u002', username: 'bob',
    oldPassword: 'alicepw123', newPassword: 'attacker123'
  });
  assert.equal(res.ok, true, 'alice 改自己的仍應成功');
  assert.deepEqual(rows[1], bobBefore, '★bob 那一列必須完全沒被動到');
  assert.equal(rows[0][6], 'H(new-salt-uuid:attacker123)', '被改的是 alice 自己那一列');
});

await t('B5: 新密碼少於 8 字元 → 拒絕（與 saveUser／resetPassword 同一條規則）', async () => {
  const { sb, rows } = setupAs('u001', ['*']);
  const before = rows[0].slice();
  const res = sb.handleChangePassword_('tok', { oldPassword: 'alicepw123', newPassword: 'short7' });
  assert.equal(res.ok, false);
  assert.equal(res.error, '密碼至少需要 8 個字元');
  assert.deepEqual(rows[0], before, '失敗時不得寫入');
});

await t('B6: 新密碼與舊密碼相同 → 拒絕（改了等於沒改，要讓使用者知道）', async () => {
  const { sb } = setupAs('u001', ['*']);
  const res = sb.handleChangePassword_('tok', { oldPassword: 'alicepw123', newPassword: 'alicepw123' });
  assert.equal(res.ok, false);
  assert.equal(res.error, '新密碼不能與目前密碼相同');
});

await t('B7: token 無效／帳號已停用 → handleMe_ 的錯誤原樣回傳，不繼續往下寫', async () => {
  const { sb, rows } = setupAs('u001', ['*']);
  const before = rows[0].slice();
  sb.__meResult = () => ({ ok: false, error: '帳號已停用' });
  const res = sb.handleChangePassword_('tok', { oldPassword: 'alicepw123', newPassword: 'brandnew123' });
  assert.equal(res.ok, false);
  assert.equal(res.error, '帳號已停用');
  assert.deepEqual(rows[0], before, '停用帳號不得改密碼');
});

await t('B8: changePassword 在 Code.gs 的 action 白名單裡，且分派到正確的 handler', async () => {
  const code = fs.readFileSync(path.join(ROOT, 'apps-script', 'platform', 'Code.gs'), 'utf8');
  assert.ok(/CODE_ALLOWED_ACTIONS\s*=\s*\[[^\]]*'changePassword'/.test(code), 'changePassword 應在白名單');
  assert.ok(/case 'changePassword':\s*\n(?:\s*\/\/[^\n]*\n)*\s*return handleChangePassword_\(token, payload\)/.test(code),
    'case changePassword 應呼叫 handleChangePassword_(token, payload)');
});

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
