// node test/api.mock.test.mjs —— T1-7 驗收：platform/api.js（後端呼叫封裝＋回傳格式轉接）
//
// 重點：
//   · 三支後端回傳格式不同 → 轉接後模組看到的一律是 {ok:true,data:{...}} | {ok:false,error}
//   · 店長節點裁切（spec §7）：只有一處過濾，裁完才交給呼叫端
//   · 網路錯誤／逾時／非 JSON 一律回 {ok:false}，絕不拋例外
//   · 呼叫 audit／dorm 時通行碼有沒有正確帶上（欄位名照既有後端程式碼，不是猜的）
//
// ⚠ 這支測試全程用假的 fetch（覆寫 globalThis.fetch），一次真實網路請求都不打——
// 三支後端現在全部是活的正式系統（platform 剛部署、audit/dorm 是正式資料），打下去會出事。
// 守衛做法見下方「A. 真實網路守衛」：fetch 在還沒被某個測試自己蓋掉之前，
// 一律指向一個「呼叫了就記一筆、並丟錯」的哨兵函式；每個測試段落結束都重新武裝一次，
// 漏掉 mock 的呼叫一定會被攔下來（api.js 會把丟出的例外包成 {ok:false,error:'GUARD:...'}，
// 讓對應的斷言直接顯示不符合預期，而不是悄悄放行）。檔案最後再對 realNetworkCalls 做一次
// 總量斷言，雙重保險。
//
// 帳密／通行碼都是本測試檔自造的假資料，不是任何真實系統的值。

'use strict';

// ----------------------------------------------------------
// localStorage polyfill（同 test/perm.test.mjs）：api.js 會透過 auth.js 的
// login()/logout() 間接用到，這裡掛一份最小可用版本給 auth.js 用。
// ----------------------------------------------------------
class MemoryStorage {
  constructor() {
    this._map = new Map();
  }
  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }
  setItem(key, value) {
    this._map.set(key, String(value));
  }
  removeItem(key) {
    this._map.delete(key);
  }
  clear() {
    this._map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

import { login, logout, __setTransport } from '../platform/auth.js';
import { call, __setTimeoutMs } from '../platform/api.js';

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
// A. 真實網路守衛
// ============================================================
const realNetworkCalls = [];

function armGuard() {
  globalThis.fetch = async (url) => {
    realNetworkCalls.push(String(url));
    throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
  };
}
armGuard();

/** 幫測試裝一支假 fetch：依 body.action 分派到對應 handler，並記錄每次呼叫供斷言。 */
function makeFetchMock(handlersByAction) {
  const calls = [];
  const fn = async (url, opts) => {
    let body = null;
    try {
      body = JSON.parse((opts && opts.body) || '{}');
    } catch {
      body = null;
    }
    calls.push({ url: String(url), opts, body });
    const action = body && body.action;
    const handler = handlersByAction[action];
    if (!handler) {
      return { json: async () => ({ ok: false, error: '（mock）未預期的 action：' + action }) };
    }
    const result = handler(body);
    return { json: async () => result };
  };
  fn.calls = calls;
  return fn;
}

/** 建一個假 auth transport：login 一次就回指定的身分/權限/secrets（沿用 perm.test.mjs 的做法）。 */
function makeAuthTransport(sessionData) {
  return async (req) => {
    if (req.action === 'login') return { ok: true, data: sessionData };
    return { ok: false, error: '（mock auth）未預期的 action：' + req.action };
  };
}

async function loginAs(sessionData) {
  __setTransport(makeAuthTransport(sessionData));
  const res = await login('u', 'pw');
  if (!res.ok) throw new Error('測試用登入失敗，測試資料本身有問題');
  __setTransport(null); // 還原成預設 transport，避免殘留假 transport 影響到別的地方
}

// ============================================================
// B. 稽核 mock 回應（五個節點都有資料，欄位名照 ~/mala-audit/apps-script/Code.gs 讀過確認）
// ============================================================
const STORE_CODES = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'];

function buildAuditGetAllResponse() {
  return {
    ok: true,
    config: {
      reasons: ['盤點錯誤（門市盤錯）', '損耗未記'],
      change_fund_std: 10000,
      petty_cash_std: 10000,
      // 參考用店代碼對照表，欄位是 `code` 不是 `store`——這是店名選單，不是一列稽核資料，
      // 不該被店長裁切掉（店長也要看得懂店名選單）。
      stores: STORE_CODES.map((code, i) => ({ code, name: code + '-名稱', order: i + 1 })),
      accountant_ok: true
    },
    items: STORE_CODES.map((store) => ({ store, name: store + '-品項', unit: '包', active: true })),
    records: STORE_CODES.map((store) => ({
      store, record_key: store + '_2026-08', month: '2026-08', status: '已稽核', correct_rate: 0.95
    })),
    details: STORE_CODES.map((store) => ({
      store, record_key: store + '_2026-08', item: store + '-品項', verdict: '正確'
    })),
    ops_records: STORE_CODES.map((store) => ({
      store, record_key: store + '_2026-08', status: '已稽核', pass_rate: 0.9
    })),
    ops_details: STORE_CODES.map((store) => ({
      store, record_key: store + '_2026-08', item_id: '1', verdict: '合格'
    }))
  };
}

// ============================================================
// 1. 稽核形狀轉接正確（會計身分，看全部節點）
// ============================================================
await (async function test1() {
  await loginAs({
    token: 'tok-acct-1',
    user: { id: 'u020', name: '會計', role: 'accountant', node: '' },
    perms: ['audit.read', 'audit.write'],
    secrets: { audit: 'secret-acct-audit-001' }
  });

  const auditResp = buildAuditGetAllResponse();
  globalThis.fetch = makeFetchMock({ getAll: () => auditResp });

  const res = await call('audit', 'getAll', {});
  assertTrue(res.ok === true, '1a: 稽核 getAll 轉接後 ok:true');
  assertEqual(res.data.config, auditResp.config, '1b: 原本平鋪的 config 欄位搬進 data.config，內容不變');
  assertEqual(res.data.items, auditResp.items, '1c: data.items 內容不變（原本平鋪在 items）');
  assertEqual(res.data.records, auditResp.records, '1d: data.records 內容不變，五個節點都在（會計不裁切）');
  assertEqual(res.data.details, auditResp.details, '1e: data.details 內容不變');
  assertEqual(res.data.ops_records, auditResp.ops_records, '1f: data.ops_records 內容不變');
  assertEqual(res.data.ops_details, auditResp.ops_details, '1g: data.ops_details 內容不變');
  assertEqual(Object.keys(res).sort(), ['data', 'ok'], '1h: 回傳只有 ok/data 兩個 key');

  armGuard();
  logout();
})();

// ============================================================
// 2. 宿舍形狀轉接正確（list 與 create 兩種回傳形狀都要轉對）
// ============================================================
await (async function test2() {
  await loginAs({
    token: 'tok-mgr-1',
    user: { id: 'u030', name: '部門主管', role: 'manager', node: '' },
    perms: ['audit.read', 'dorm.read', 'dorm.write'],
    secrets: { dorm: 'secret-mgr-dorm-002' }
  });

  const listResp = {
    ok: true,
    contracts: [
      { contract_id: 'C0001', name: '測試一', room: '二樓單人房', bed: '', status: '待簽' },
      { contract_id: 'C0002', name: '測試二', room: '三樓1號房', bed: '雙人床位A', status: '在住' }
    ]
  };
  const createResp = {
    ok: true,
    contract_id: 'C0099',
    token: 'sign-tok-abc123',
    rent: 3500,
    term_start: '2026-08-01',
    term_end: '2027-01-31',
    sign_url: 'https://eason0728.github.io/dzy/sign.html?t=sign-tok-abc123'
  };
  globalThis.fetch = makeFetchMock({ list: () => listResp, create: () => createResp });

  const res1 = await call('dorm', 'list', {});
  assertTrue(res1.ok === true, '2a: 宿舍 list 轉接後 ok:true');
  assertEqual(res1.data.contracts, listResp.contracts, '2b: data.contracts 內容不變（原本平鋪在 contracts）');

  const res2 = await call('dorm', 'create', { name: '測試三', room: '二樓單人房', term_start: '2026-08-01' });
  assertTrue(res2.ok === true, '2c: 宿舍 create 轉接後 ok:true');
  assertEqual(
    res2.data,
    { contract_id: 'C0099', token: 'sign-tok-abc123', rent: 3500, term_start: '2026-08-01', term_end: '2027-01-31', sign_url: createResp.sign_url },
    '2d: create 回傳的散欄位（contract_id/token/...）整包搬進 data，內容不變'
  );

  armGuard();
  logout();
})();

// ============================================================
// 3. {ok:false,error} 原樣通過，error 訊息不被改掉（audit／dorm 各驗一次）
// ============================================================
await (async function test3() {
  await loginAs({
    token: 'tok-acct-2',
    user: { id: 'u021', name: '會計', role: 'accountant', node: '' },
    perms: ['audit.read', 'audit.write'],
    secrets: { audit: 'secret-acct-003' }
  });

  globalThis.fetch = makeFetchMock({
    getAll: () => ({ ok: false, error: '通行碼錯誤' })
  });
  const res1 = await call('audit', 'getAll', {});
  assertEqual(res1, { ok: false, error: '通行碼錯誤' }, '3a: 稽核 {ok:false,error} 原樣通過，訊息逐字不變');

  globalThis.fetch = makeFetchMock({
    list: () => ({ ok: false, error: '通行碼錯誤', code: 401 })
  });
  const res2 = await call('dorm', 'list', {});
  // 2026-08-15 放寬：從「完全相等」改成驗真正的不變量——error 訊息逐字不變。
  // 原因：轉接層現在會把後端多回的欄位（這裡是 code:401）保留進 data，
  // 那是刻意的（宿舍「床位重複」是 {ok:false, warn, message} 的軟性警告，
  // 只留 error 會讓既有的「確認後強制建立」流程消失）。斷言的本意沒有被弱化。
  assertTrue(res2.ok === false, '3b-1: 宿舍失敗回應 ok 為 false');
  assertEqual(res2.error, '通行碼錯誤', '3b-2: 宿舍失敗訊息逐字不變');
  assertEqual(res2.data && res2.data.code, 401, '3b-3: 後端多回的欄位保留在 data，沒有被丟掉');

  armGuard();
  logout();
})();

// ============================================================
// 4. 網路錯誤 → {ok:false}，不拋例外
// ============================================================
await (async function test4() {
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND script.google.com');
  };

  let threw = false;
  let res;
  try {
    res = await call('audit', 'getAll', {});
  } catch {
    threw = true;
  }
  assertTrue(threw === false, '4a: fetch 丟例外時 call() 不會讓呼叫方炸掉');
  assertTrue(res && res.ok === false, '4b: 網路錯誤時回 {ok:false,...}');
  assertTrue(typeof res.error === 'string' && res.error.length > 0, '4c: 網路錯誤時 error 是非空字串');

  armGuard();
})();

// ============================================================
// 5. 逾時（預設 15 秒，這裡用 __setTimeoutMs 覆寫成 50ms 避免測試真的等 15 秒）→ {ok:false}，不拋例外
// ============================================================
await (async function test5() {
  __setTimeoutMs(50);
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      // 模擬真實 fetch：signal 被 abort 時才 reject，其餘情況永遠不 resolve（模擬掛住的請求）
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });

  let threw = false;
  let res;
  try {
    res = await call('audit', 'getAll', {});
  } catch {
    threw = true;
  }
  assertTrue(threw === false, '5a: 逾時時 call() 不會讓呼叫方炸掉');
  assertTrue(res && res.ok === false, '5b: 逾時時回 {ok:false,...}');
  assertTrue(typeof res.error === 'string' && res.error.length > 0, '5c: 逾時時 error 是非空字串');

  __setTimeoutMs(); // 還原成預設 15 秒，不影響後面的測試
  armGuard();
})();

// ============================================================
// 6. 回傳不是 JSON（例如 HTML 錯誤頁）→ {ok:false}，不拋例外
// ============================================================
await (async function test6() {
  globalThis.fetch = async () => ({
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    }
  });

  let threw = false;
  let res;
  try {
    res = await call('audit', 'getAll', {});
  } catch {
    threw = true;
  }
  assertTrue(threw === false, '6a: 回傳不是 JSON 時 call() 不會讓呼叫方炸掉');
  assertTrue(res && res.ok === false, '6b: 回傳不是 JSON 時回 {ok:false,...}');
  assertTrue(typeof res.error === 'string' && res.error.length > 0, '6c: 回傳不是 JSON 時 error 是非空字串');

  armGuard();
})();

// ============================================================
// 7. 店長節點裁切：只有 audit.read.own、node=sxl-gf → records 等只剩 sxl-gf，其他四店完全不在
// ============================================================
await (async function test7() {
  await loginAs({
    token: 'tok-lead-1',
    user: { id: 'u010', name: '店長', role: 'storelead', node: 'sxl-gf' },
    perms: ['audit.read.own'],
    secrets: { audit: 'secret-lead-004' }
  });

  const auditResp = buildAuditGetAllResponse();
  globalThis.fetch = makeFetchMock({ getAll: () => auditResp });

  const res = await call('audit', 'getAll', {});
  assertTrue(res.ok === true, '7a: 店長呼叫 getAll 仍是 ok:true（只是資料被裁）');

  assertEqual(res.data.records.length, 1, '7b: 店長只看得到 1 筆稽核紀錄');
  assertEqual(res.data.records[0].store, 'sxl-gf', '7c: 剩下的那筆是自己店 sxl-gf');
  const otherStoresInRecords = res.data.records.filter((r) => r.store !== 'sxl-gf');
  assertEqual(otherStoresInRecords, [], '7d: 其他四個節點的紀錄完全不在回傳裡（不是被標記，是整列不見）');

  assertEqual(res.data.items.map((r) => r.store), ['sxl-gf'], '7e: items 也只剩 sxl-gf');
  assertEqual(res.data.details.map((r) => r.store), ['sxl-gf'], '7f: details 也只剩 sxl-gf');
  assertEqual(res.data.ops_records.map((r) => r.store), ['sxl-gf'], '7g: ops_records 也只剩 sxl-gf');
  assertEqual(res.data.ops_details.map((r) => r.store), ['sxl-gf'], '7h: ops_details 也只剩 sxl-gf');

  assertEqual(
    res.data.config.stores.map((s) => s.code),
    STORE_CODES,
    '7i: config.stores 是店名參考清單（欄位叫 code 不叫 store），不被裁切，店長仍看得到全部店名可供選單使用'
  );

  armGuard();
  logout();
})();

// ============================================================
// 8. 會計（audit.read）拿到全部五個節點，一列都沒少
// ============================================================
await (async function test8() {
  await loginAs({
    token: 'tok-acct-3',
    user: { id: 'u022', name: '會計', role: 'accountant', node: '' },
    perms: ['audit.read', 'audit.write'],
    secrets: { audit: 'secret-acct-005' }
  });

  const auditResp = buildAuditGetAllResponse();
  globalThis.fetch = makeFetchMock({ getAll: () => auditResp });

  const res = await call('audit', 'getAll', {});
  assertEqual(res.data.records.length, 5, '8a: 會計看到 5 筆稽核紀錄（五個節點都在）');
  assertEqual(res.data.records.map((r) => r.store).sort(), [...STORE_CODES].sort(), '8b: 五個節點代碼都在，一個沒少');
  assertEqual(res.data.items.length, 5, '8c: items 也是五個節點都在');

  armGuard();
  logout();
})();

// ============================================================
// 9. 呼叫 audit 時通行碼有被帶上（檢查送出的 body）；順便驗證欄位名是 `code`，不是 `token`／`passcode`
// ============================================================
await (async function test9() {
  await loginAs({
    token: 'tok-acct-4',
    user: { id: 'u023', name: '會計', role: 'accountant', node: '' },
    perms: ['audit.read', 'audit.write'],
    secrets: { audit: 'secret-check-body-006' }
  });

  const mock = makeFetchMock({ getAll: () => buildAuditGetAllResponse() });
  globalThis.fetch = mock;

  await call('audit', 'getAll', { year: '2026' });
  assertEqual(mock.calls.length, 1, '9a: 送出了一次請求');
  const sentBody = mock.calls[0].body;
  assertEqual(sentBody.code, 'secret-check-body-006', '9b: 送出的 body.code 就是目前登入身分的稽核通行碼（欄位名照 Code.gs 的 payload.code）');
  assertEqual(sentBody.action, 'getAll', '9c: body.action 正確');
  assertEqual(sentBody.year, '2026', '9d: 呼叫端傳入的業務欄位（year）與 action/code 同層扁平展開，不是包在巢狀 payload 裡');

  // 同時驗證 Content-Type 與 method（spec §3 S4：text/plain 避開 CORS preflight）
  assertEqual(mock.calls[0].opts.method, 'POST', '9e: 一律用 POST');
  assertEqual(mock.calls[0].opts.headers['Content-Type'], 'text/plain', '9f: Content-Type 是 text/plain');

  armGuard();
  logout();
})();

// ============================================================
// 10. 邊界情況（也是變異測試要驗的那條界線）：
//     使用者同時有 audit.read 與 audit.read.own → 一律不裁切（全節點權限優先）。
//     正確邏輯是「沒有 audit.read 且有 audit.read.own」才裁切；
//     如果被改成「有 audit.read.own 就裁切」，這個測試會失敗（見任務驗收條件的變異測試）。
//
//     刻意把 node 設成真的店代碼（sxl-gf）而不是像現行會計那樣是空字串：
//     maybeFilterOwnNode_() 還有一道「沒有 node 就不裁」的防呆（node='' 時視為不裁），
//     若這裡沿用空字串當 node，就算裁切條件被改壞也會被那道防呆意外擋住、測試假通過，
//     真正驗不到「hasFull 應該優先」這條線。所以這個帳號的 node 是測試專用的虛構值，
//     只是要確保這個邊界情況本身測得到，不代表現行會計角色真的有 node。
// ============================================================
await (async function test10() {
  await loginAs({
    token: 'tok-dual-1',
    user: { id: 'u099', name: '雙權限測試帳號', role: 'accountant', node: 'sxl-gf' },
    perms: ['audit.read', 'audit.read.own'],
    secrets: { audit: 'secret-dual-007' }
  });

  const auditResp = buildAuditGetAllResponse();
  globalThis.fetch = makeFetchMock({ getAll: () => auditResp });

  const res = await call('audit', 'getAll', {});
  assertEqual(res.data.records.length, 5, '10a: 同時擁有 audit.read 與 audit.read.own → 不裁切，五個節點都在');
  assertEqual(res.data.records.map((r) => r.store).sort(), [...STORE_CODES].sort(), '10b: 五個節點代碼都在（有 audit.read 的人一律不裁切，spec §7）');

  armGuard();
  logout();
})();

// ============================================================
// 11.（額外）platform 後端回傳本來就是 {ok:true,data:{...}}，轉接層不該再包一層變成 data.data
// ============================================================
await (async function test11() {
  const platformResp = {
    ok: true,
    data: {
      token: 'tok-new-login',
      user: { id: 'u001', name: '系統管理者', role: 'admin', node: '' },
      perms: ['*'],
      secrets: { audit: 'x', dorm: 'y' }
    }
  };
  globalThis.fetch = makeFetchMock({ login: () => platformResp });

  const res = await call('platform', 'login', { username: 'admin1', password: 'pw' });
  assertEqual(res, platformResp, '11a: platform 後端本來就回 {ok:true,data:{...}}，轉接層原樣通過，不會變成 data.data');

  armGuard();
})();

// ============================================================
// 12. 未設定的後端（例如打錯 backendId）→ {ok:false}，不拋例外，也不會誤打真的網路
// ============================================================
await (async function test12() {
  const res = await call('no-such-backend', 'x', {});
  assertTrue(res.ok === false, '12a: 未知 backendId 回 {ok:false,...}');
  assertEqual(realNetworkCalls.length, 0, '12b: 未知 backendId 不會觸發任何 fetch 呼叫（守衛也沒被踩到）');
})();

// ============================================================
// 14. 呼叫端不得用 payload 覆寫 action 或通行碼（2026-08-15 對抗審查補）
//     原本 buildRequestBody_ 寫成 `{ action, ...p }`，展開順序讓 payload 裡的同名欄位
//     蓋掉平台指定的 action——模組因此能自己決定去打後端的哪個動作。
//     通行碼因為在後面才寫入所以擋得住，action 擋不住。
// ============================================================
await (async function test14() {
  await loginAs({
    token: 'tok-acct-9',
    user: { id: 'u090', name: '會計', role: 'accountant', node: '' },
    perms: ['audit.read', 'audit.write'],
    secrets: { audit: 'real-secret-014' }
  });

  const mock = makeFetchMock({ getAll: () => buildAuditGetAllResponse() });
  globalThis.fetch = mock;

  await call('audit', 'getAll', {
    year: '2026',
    action: 'submitAudit',          // 想把動作換掉
    code: 'attacker-supplied-code'  // 想把通行碼換掉
  });

  const sent = mock.calls[0].body;
  assertEqual(sent.action, 'getAll', '14a: payload 裡的 action 不得覆寫平台指定的 action');
  assertEqual(sent.code, 'real-secret-014', '14b: payload 裡的 code 不得覆寫平台下發的通行碼');
  assertEqual(sent.year, '2026', '14c: 一般業務欄位照常帶上');
  logout();
})();

// ============================================================
// 15. 裁切要往「關」的方向失敗（2026-08-15 對抗審查補）
//     原本：只有 read.own 但 node 空白時 `return data` —— 回傳全部節點的資料。
//     只要有人建了「店長＋所屬節點留空」的帳號，隔離就整個消失。
// ============================================================
await (async function test15() {
  await loginAs({
    token: 'tok-lead-9',
    user: { id: 'u091', name: '沒有節點的店長', role: 'storelead', node: '' },
    perms: ['audit.read.own'],
    secrets: { audit: 'secret-015' }
  });

  const mock = makeFetchMock({ getAll: () => buildAuditGetAllResponse() });
  globalThis.fetch = mock;

  const res = await call('audit', 'getAll', {});
  assertTrue(res.ok === true, '15a: 仍然正常回應，不是拋錯');
  assertEqual(res.data.records.length, 0, '15b: 拿不到所屬節點時一列都不給（不是給全部）');
  assertEqual(res.data.items.length, 0, '15c: items 同樣清空');
  assertEqual(res.data.details.length, 0, '15d: details 同樣清空');
  assertTrue(
    Array.isArray(res.data.config && res.data.config.stores) && res.data.config.stores.length > 0,
    '15e: 設定與對照表（config.stores）保留，只清「一列一店」的資料'
  );
  logout();
})();

// ============================================================
// 16. 軟性警告要傳得到模組（2026-08-15 補）
//     宿舍後端的「床位重複」回 {ok:false, warn, message}，**連 error 都沒有**。
//     舊版是拿 message 問使用者、確認後帶 force 重送。轉接層若只留 error，
//     這個既有流程會整個消失，而且畫面只顯示「請求失敗」。
// ============================================================
await (async function test16() {
  await loginAs({
    token: 'tok-mgr-9',
    user: { id: 'u092', name: '部門主管', role: 'manager', node: '' },
    perms: ['dorm.read', 'dorm.write'],
    secrets: { dorm: 'secret-016' }
  });

  globalThis.fetch = makeFetchMock({
    create: () => ({ ok: false, warn: '床位重複', message: '二樓四人房1號床已有人，確定要建立嗎？' })
  });

  const res = await call('dorm', 'create', { room: '二樓四人房', bed: '1號床' });
  assertTrue(res.ok === false, '16a: 軟性警告仍算失敗（不會誤當成建立成功）');
  assertEqual(res.error, '二樓四人房1號床已有人，確定要建立嗎？', '16b: 沒有 error 時改用 message，不是通用的「請求失敗」');
  assertEqual(res.data && res.data.warn, '床位重複', '16c: warn 保留在 data，模組才判斷得出這是可強制建立的情況');
  logout();
})();

// ============================================================
// 最終檢查：全程沒有任何一次真實網路請求打到守衛哨兵函式
// ============================================================
assertEqual(realNetworkCalls, [], '13: 全程沒有任何一次呼叫落到未被 mock 的真實 fetch');

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
