// node test/perm.test.mjs —— T1-6 驗收：platform/auth.js（身分層：login／restore／logout／can）
//
// 這一層判斷錯，整個系統的權限就是假的，所以測試重點放在 can() 的邊界：
//   · admin 的 '*' 要對任何 perm 都放行
//   · audit.read 與 audit.read.own 是兩個完全獨立的權限碼，互不相等、互不包含
//   · 絕不能用 startsWith 前綴比對（會讓 audit.read 誤放行 audit.readonly）
// 以及安全規則：token 進 localStorage，瀏覽器不持有通行碼（2026-10-12 代轉），logout() 清乾淨 token 與身分。
//
// 後端（apps-script/platform/Auth.gs）還沒部署，所以全程用 __setTransport() 注入假的
// transport 函式，不打真的網路。
//
// ⚠ 下面所有帳密都是本測試檔自造的假資料，不是任何真實系統的密碼。

'use strict';

// ----------------------------------------------------------
// localStorage polyfill：node 沒有瀏覽器的 localStorage，
// 這裡手刻一個最小可用版本，掛到 globalThis 給 auth.js 用。
// 只在函式呼叫當下才會被 auth.js 讀取（不是 import 當下），
// 所以掛在 import 之後、任何測試呼叫之前即可，順序沒有問題。
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
  keys() {
    return Array.from(this._map.keys());
  }
  values() {
    return Array.from(this._map.values());
  }
}
globalThis.localStorage = new MemoryStorage();

import { login, restore, logout, getUser, can, __setTransport } from '../platform/auth.js';
import * as authModule from '../platform/auth.js';

// 2026-10-12：logout() 改成先呼叫後端 logout（全部裝置登出）再清本機、回 Promise。
// 測試裡的登出一律換上「只回 ok 的假 transport」並 await，不讓它落到預設的真 fetch，也不讓延後的清除蓋掉下一段的登入
async function quietLogout() {
  __setTransport(async () => ({ ok: true, data: {} }));
  try { await logout(); } finally { __setTransport(null); }
}

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

const TOKEN_KEY = 'dzy.token';

/** 建一個假 transport：依 action 分派，並記錄每次呼叫的 request body 供斷言 */
function makeMockTransport(handlers) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const h = handlers[req.action];
    if (!h) return { ok: false, error: '未知 action: ' + req.action };
    return h(req);
  };
  fn.calls = calls;
  return fn;
}

// ============================================================
// A. 未登入時的初始狀態
// ============================================================
(function sectionA() {
  assertEqual(getUser(), null, 'A1: 從未登入，getUser() 回 null');
  assertEqual(can('audit.read'), false, 'A2: 從未登入，can() 一律 false');
  assertEqual(can('*'), false, 'A3: 從未登入，can(\'*\') 也是 false（沒有 currentPerms 可言）');
  assertEqual(typeof authModule.getSecret, 'undefined', 'A4: auth.js 已沒有 getSecret（2026-10-12 代轉：瀏覽器不持有通行碼）');
})();

// ============================================================
// B. admin 的 '*' 對任何 perm 都要 true；login 成功要寫 token、設 user
// ============================================================
await (async function sectionB() {
  const transport = makeMockTransport({
    login: async (req) => {
      assertEqual(
        req,
        { action: 'login', token: '', payload: { username: 'admin1', password: 'pw-admin' } },
        'B1: login() 送出的 request body 格式照 spec §4.8'
      );
      return {
        ok: true,
        data: {
          token: 'tok-admin-aaa',
          user: { id: 'u001', name: '系統管理者', role: 'admin', node: '' },
          perms: ['*']
        }
      };
    }
  });
  __setTransport(transport);

  const res = await login('admin1', 'pw-admin');
  assertEqual(res, { ok: true }, 'B2: login() 成功回 {ok:true}');
  assertEqual(getUser(), { id: 'u001', name: '系統管理者', role: 'admin', node: '' }, 'B3: getUser() 回登入後的身分');

  assertTrue(can('audit.write') === true, "B4: admin 的 '*' → can('audit.write') true");
  assertTrue(can('dorm.write') === true, "B5: admin 的 '*' → can('dorm.write') true");
  assertTrue(can('platform.users') === true, "B6: admin 的 '*' → can('platform.users') true");
  assertTrue(can('audit.read.own') === true, "B7: admin 的 '*' → 三段權限碼一樣 true");


  assertEqual(localStorage.getItem(TOKEN_KEY), 'tok-admin-aaa', 'B11: login() 成功後 token 寫進 localStorage');

  await quietLogout();
  assertEqual(getUser(), null, 'B12: logout() 後 getUser() 回 null');
  assertEqual(can('audit.write'), false, 'B13: logout() 後 can() 回 false（即使原本是 admin）');
  assertEqual(localStorage.getItem(TOKEN_KEY), null, 'B15: logout() 後 localStorage 沒有 token');
})();

// ============================================================
// C. storelead：只有 audit.read.own —— 不涵蓋 audit.read，也不涵蓋 audit.readonly（前綴誤判反例）
// ============================================================
await (async function sectionC() {
  __setTransport(
    makeMockTransport({
      login: async () => ({
        ok: true,
        data: {
          token: 'tok-storelead-bbb',
          user: { id: 'u010', name: '店長', role: 'storelead', node: 'sxl-gf' },
          perms: ['audit.read.own']
        }
      })
    })
  );
  const res = await login('lead1', 'pw-lead');
  assertEqual(res, { ok: true }, 'C1: storelead 登入成功');

  assertEqual(can('audit.read.own'), true, "C2: can('audit.read.own') 在只有 ['audit.read.own'] 時為 true");
  assertEqual(can('audit.read'), false, "C3: can('audit.read') 在只有 ['audit.read.own'] 時為 false（不互相涵蓋）");
  assertEqual(can('audit.readonly'), false, "C4: can('audit.readonly') 在只有 ['audit.read.own'] 時為 false（形似字串反例）");
  assertEqual(can('dorm.read'), false, 'C5: 沒有的 ns 一律 false');

  await quietLogout();
})();

// ============================================================
// D. accountant：只有 audit.read（不含 .own）—— 反過來也不涵蓋 audit.read.own
// ============================================================
await (async function sectionD() {
  __setTransport(
    makeMockTransport({
      login: async () => ({
        ok: true,
        data: {
          token: 'tok-accountant-ccc',
          user: { id: 'u020', name: '會計', role: 'accountant', node: '' },
          perms: ['audit.read', 'audit.write']
        }
      })
    })
  );
  const res = await login('acc1', 'pw-acc');
  assertEqual(res, { ok: true }, 'D1: accountant 登入成功');

  assertEqual(can('audit.read'), true, "D2: can('audit.read') 在只有 ['audit.read'] 時為 true");
  assertEqual(can('audit.read.own'), false, "D3: can('audit.read.own') 在只有 ['audit.read'] 時為 false（★核心反例：audit.read 不涵蓋 audit.read.own）");
  assertEqual(can('audit.readonly'), false, "D4: can('audit.readonly') 在只有 ['audit.read'] 時為 false（★核心反例：前綴誤判）");
  assertEqual(can('audit.write'), true, 'D5: 完全相符的另一個 perm 仍正常判斷');

  await quietLogout();
})();

// ============================================================
// E. 未登入時的行為（在 login/logout 循環之後再驗一次，確保狀態真的清乾淨）
// ============================================================
(function sectionE() {
  assertEqual(getUser(), null, 'E1: 一輪 login/logout 之後，未登入狀態下 getUser() 仍回 null');
  assertEqual(can('audit.read'), false, 'E2: 未登入狀態下 can() 一律 false');
  assertEqual(can('audit.read.own'), false, 'E3: 未登入狀態下 can() 一律 false（換一個 perm 再驗一次）');
})();

// ============================================================
// F. login 失敗：不寫 token、不設身分；transport 丟例外也不讓呼叫方炸掉
// ============================================================
await (async function sectionF() {
  __setTransport(
    makeMockTransport({
      login: async () => ({ ok: false, error: '帳號或密碼錯誤' })
    })
  );
  const res1 = await login('acc1', 'wrong-password');
  assertEqual(res1, { ok: false, error: '帳號或密碼錯誤' }, 'F1: 密碼錯誤 → {ok:false, error}');
  assertEqual(getUser(), null, 'F2: 登入失敗不設定身分');
  assertEqual(localStorage.getItem(TOKEN_KEY), null, 'F3: 登入失敗不寫入 token');

  __setTransport(async () => {
    throw new Error('模擬網路中斷');
  });
  const res2 = await login('acc1', 'whatever');
  assertTrue(res2.ok === false, 'F4: transport 拋例外，login() 仍回 {ok:false,...}，不會讓呼叫方炸掉');
  assertTrue(typeof res2.error === 'string' && res2.error.length > 0, 'F5: 網路例外時 error 是非空字串');
})();

// ============================================================
// G. restore()：開機流程用 localStorage 的 token 換 me
// ============================================================
await (async function sectionG() {
  localStorage.clear();

  // G1：完全沒有 token → 不該打任何網路
  const spy1 = makeMockTransport({});
  __setTransport(spy1);
  const r1 = await restore();
  assertEqual(r1, false, 'G1a: 沒有 token 時 restore() 回 false');
  assertEqual(spy1.calls.length, 0, 'G1b: 沒有 token 時 restore() 不呼叫 transport（省一次網路來回）');

  // G2：有 token，但後端說已失效 → restore() 回 false，並清掉 localStorage 的 token
  localStorage.setItem(TOKEN_KEY, 'tok-expired-zzz');
  __setTransport(
    makeMockTransport({
      me: async (req) => {
        assertEqual(req, { action: 'me', token: 'tok-expired-zzz', payload: {} }, 'G2a: restore() 送出的 me request body 照 spec §4.8');
        return { ok: false, error: '登入已失效，請重新登入' };
      }
    })
  );
  const r2 = await restore();
  assertEqual(r2, false, 'G2b: token 失效 → restore() 回 false');
  assertEqual(localStorage.getItem(TOKEN_KEY), null, 'G2c: token 失效 → restore() 順手清掉 localStorage 的舊 token');
  assertEqual(getUser(), null, 'G2d: token 失效 → 不設定身分');

  // G3：有效 token → restore() 回 true，且身分/權限都套用成功
  localStorage.setItem(TOKEN_KEY, 'tok-valid-yyy');
  __setTransport(
    makeMockTransport({
      me: async () => ({
        ok: true,
        data: {
          // 照 spec §5.2，me 回傳不含 token 欄位——原本的 token 應該繼續沿用
          user: { id: 'u030', name: '部門主管', role: 'manager', node: '' },
          perms: ['audit.read', 'dorm.read', 'dorm.write']
        }
      })
    })
  );
  const r3 = await restore();
  assertEqual(r3, true, 'G3a: 有效 token → restore() 回 true');
  assertEqual(getUser(), { id: 'u030', name: '部門主管', role: 'manager', node: '' }, 'G3b: restore() 成功後 getUser() 是 me 回傳的身分');
  assertEqual(can('dorm.write'), true, 'G3c: restore() 成功後 can() 依 me 回傳的 perms 判斷');
  assertEqual(can('audit.write'), false, 'G3d: manager 沒有 audit.write');
  assertEqual(localStorage.getItem(TOKEN_KEY), 'tok-valid-yyy', 'G3f: restore() 成功後原本的 token 仍留在 localStorage（沒被誤刪或誤改）');

  await quietLogout();
})();

// ============================================================
// G'. restore()：只有後端明確判定 token 失效才清 token；連線失敗／逾時／格式錯誤保留（2026-10-28 審查 #9）
// ============================================================
await (async function sectionGTransient() {
  const realFetch = globalThis.fetch;
  const keepCases = [
    ['連線失敗（fetch 丟錯）', async () => { throw new TypeError('Failed to fetch'); }],
    ['逾時（AbortError）', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ['格式錯誤（回 HTML）', async () => ({ text: async () => '<!DOCTYPE html><p>Google 錯誤頁</p>' })]
  ];
  for (const [label, fakeFetch] of keepCases) {
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, 'tok-keep-on-network-error');
    __setTransport(null);              // 走真的 defaultTransport（fetch 換成假的，不打網路）
    globalThis.fetch = fakeFetch;
    let r;
    try { r = await restore(); } finally { globalThis.fetch = realFetch; }
    assertEqual(r, false, "G'1 " + label + ' → restore() 回 false（改顯示登入頁）');
    assertEqual(localStorage.getItem(TOKEN_KEY), 'tok-keep-on-network-error', "G'1 ★" + label + ' → token 仍在（不是後端判定失效，不清）');
  }
  // 注入的 transport 標了 transient → 也保留
  localStorage.setItem(TOKEN_KEY, 'tok-keep-transient');
  __setTransport(makeMockTransport({ me: async () => ({ ok: false, error: '連線失敗，請檢查網路', transient: true }) }));
  assertEqual(await restore(), false, "G'2 transient:true → restore() 回 false");
  assertEqual(localStorage.getItem(TOKEN_KEY), 'tok-keep-transient', "G'2 ★transient:true → token 仍在");
  // 伺服器回應自己夾帶 transient:true（偽造）→ 不算，照樣清（transient 只能由 transport 自己標；2026-10-28 複驗）
  localStorage.setItem(TOKEN_KEY, 'tok-forged-transient');
  __setTransport(null);
  globalThis.fetch = async () => ({ text: async () => JSON.stringify({ ok: false, error: '登入已失效，請重新登入', transient: true }) });
  try { assertEqual(await restore(), false, "G'3 偽造 transient → restore() 回 false"); } finally { globalThis.fetch = realFetch; }
  assertEqual(localStorage.getItem(TOKEN_KEY), null, "G'3 ★伺服器回應自帶 transient:true → token 照樣被清");
  // 後端回的任何錯誤（失效、停用、待審核、被退回、忙碌）→ 清（往安全的方向失敗，不靠逐字比對訊息）
  for (const err of ['unauthorized', '登入已失效，請重新登入', '帳號已停用', '帳號還在等主管審核', '帳號資料被退回，請找人資重新開通', '系統忙碌中，請稍後再試']) {
    localStorage.setItem(TOKEN_KEY, 'tok-rejected');
    __setTransport(makeMockTransport({ me: async () => ({ ok: false, error: err }) }));
    assertEqual(await restore(), false, "G'4 後端回 " + err + ' → restore() 回 false');
    assertEqual(localStorage.getItem(TOKEN_KEY), null, "G'4 ★後端回 " + err + ' → token 被清');
  }
  __setTransport(null);
  localStorage.clear();
})();

// ============================================================
// H. 舊後端若仍夾帶 secrets（換版過渡期）：前端忽略，翻遍 localStorage 也找不到
// ============================================================
await (async function sectionH() {
  const marker = 'SECRET-MARKER-should-never-touch-storage-8f3a1c';
  __setTransport(
    makeMockTransport({
      login: async () => ({
        ok: true,
        data: {
          token: 'tok-secrets-check',
          user: { id: 'u040', name: '會計', role: 'accountant', node: '' },
          perms: ['audit.read'],
          secrets: { audit: marker }
        }
      })
    })
  );
  await login('acc2', 'pw');
  // 舊版後端（換版過渡期）若仍夾帶 secrets：前端一律忽略——沒有 getter、也不落地
  assertEqual(typeof authModule.getSecret, 'undefined', 'H1: 沒有任何取通行碼的出口');

  const hit = localStorage.values().some((v) => v.includes(marker));
  assertEqual(hit, false, 'H2: localStorage 裡任何一個值都不含 secrets 的內容（只存 token，不存通行碼）');

  await quietLogout();
})();

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
