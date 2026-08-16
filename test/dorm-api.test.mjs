// node test/dorm-api.test.mjs —— T3-1 驗收：modules/dorm/api.js（宿舍合約資料層，讀取類）
//
// 重點：
//   · 三個讀取 action（rooms／list／contract）的參數與回傳轉接是否正確
//   · 後端回 {ok:false} 原樣通過（錯誤訊息不被改寫）
//   · 回傳缺欄位、ctx.api.call 拋例外／reject、ctx.api 不存在 → 一律 {ok:false,error}，絕不拋例外
//   · 不快取：同一個 action 連續呼叫兩次，底層 ctx.api.call 一定被打兩次
//     （理由見 modules/dorm/api.js 檔頭註解：合約資料隨時可能新增或終止，本任務
//     還沒有寫入類 action 可以在成功後 invalidate 快取，沒有失效機制的快取只會讓
//     畫面停在過期的合約狀態，對法律文件來說風險大於省下的網路請求）
//
// ⚠ 全程用假的 ctx.api.call（單純的 in-memory 計數 mock），不 import platform/api.js、
// 不 import 任何會碰到真實網址的檔案。宿舍合約後端是同仁實際簽過的租約與退宿點交單，
// 打下去會碰到正式資料，絕對不行。
//
// A. 真實網路守衛：測試最開始就把 globalThis.fetch 換成「呼叫了就記一筆、並丟錯」的
// 哨兵函式。modules/dorm/api.js 本來就不 import fetch、不打網路（一律走 ctx.api.call），
// 所以正常情況下這支守衛全程不會被觸發；留著是雙重保險——如果之後有人不小心在
// modules/dorm/api.js 裡加了一行真的 fetch，這裡會馬上讓測試炸開，而不是悄悄放行。
// 檔案最後對 realNetworkCalls.length 做總量斷言。

'use strict';

const realNetworkCalls = [];
globalThis.fetch = async (url) => {
  realNetworkCalls.push(String(url));
  throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
};

import { getRooms, listContracts, getContract } from '../modules/dorm/api.js';

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

/** 造一個假 ctx：ctx.api.call 依 handler 決定回傳什麼，calls 陣列記錄每次呼叫的參數。 */
function makeCtx(handler) {
  const calls = [];
  return {
    calls,
    ctx: {
      api: {
        async call(backendId, action, payload) {
          calls.push({ backendId, action, payload });
          return handler(backendId, action, payload);
        }
      }
    }
  };
}

// ============================================================
// 1. getRooms：成功轉接、參數正確
// ============================================================
await (async function test1() {
  const rooms = [{ room: '二樓單人房', type: '單人房', beds: [] }];
  const equip = ['書桌', '椅子'];
  const { ctx, calls } = makeCtx((backendId, action) => {
    assertEqual(backendId, 'dorm', '1a: backendId 是 dorm');
    assertEqual(action, 'rooms', '1b: action 是 rooms');
    return { ok: true, data: { rooms, equip } };
  });

  const r = await getRooms(ctx);
  assertEqual(calls.length, 1, '1c: 呼叫底層一次');
  assertEqual(calls[0].payload, {}, '1d: payload 是空物件（rooms 不需通行碼／額外參數）');
  assertEqual(r, { ok: true, data: { rooms, equip } }, '1e: 回傳形狀與內容正確');
})();

// ============================================================
// 2. getRooms：後端回 {ok:false} 原樣通過
// ============================================================
await (async function test2() {
  const { ctx } = makeCtx(() => ({ ok: false, error: '伺服器忙線中' }));
  const r = await getRooms(ctx);
  assertEqual(r, { ok: false, error: '伺服器忙線中' }, '2a: {ok:false} 錯誤訊息原樣通過，沒被改寫');
})();

// ============================================================
// 3. getRooms：回傳缺 rooms 欄位 → {ok:false}，不拋例外
// ============================================================
await (async function test3() {
  const { ctx } = makeCtx(() => ({ ok: true, data: { equip: [] } })); // 故意漏掉 rooms
  const r = await getRooms(ctx);
  assertEqual(r.ok, false, '3a: 缺 rooms 欄位回 ok:false');
  assertTrue(typeof r.error === 'string' && r.error.length > 0, '3b: 帶有錯誤訊息');
})();

// ============================================================
// 4. listContracts：成功轉接、參數正確
// ============================================================
await (async function test4() {
  const contracts = [
    { contract_id: 'C0001', name: '王小明', room: '二樓單人房', bed: '', status: '在住' }
  ];
  const { ctx, calls } = makeCtx((backendId, action) => {
    assertEqual(backendId, 'dorm', '4a: backendId 是 dorm');
    assertEqual(action, 'list', '4b: action 是 list');
    return { ok: true, data: { contracts } };
  });

  const r = await listContracts(ctx);
  assertEqual(calls.length, 1, '4c: 呼叫底層一次');
  assertEqual(calls[0].payload, {}, '4d: payload 是空物件（通行碼由 platform/api.js 自動帶，本檔不處理）');
  assertEqual(r, { ok: true, data: { contracts } }, '4e: 回傳形狀與內容正確');
})();

// ============================================================
// 5. listContracts：後端回 {ok:false}（例如通行碼錯誤）原樣通過
// ============================================================
await (async function test5() {
  const { ctx } = makeCtx(() => ({ ok: false, error: '通行碼錯誤' }));
  const r = await listContracts(ctx);
  assertEqual(r, { ok: false, error: '通行碼錯誤' }, '5a: {ok:false} 錯誤訊息原樣通過');
})();

// ============================================================
// 6. listContracts：回傳缺 contracts 欄位 → {ok:false}，不拋例外
// ============================================================
await (async function test6() {
  const { ctx } = makeCtx(() => ({ ok: true, data: {} })); // 故意漏掉 contracts
  const r = await listContracts(ctx);
  assertEqual(r.ok, false, '6a: 缺 contracts 欄位回 ok:false');
  assertTrue(typeof r.error === 'string' && r.error.length > 0, '6b: 帶有錯誤訊息');
})();

// ============================================================
// 7. listContracts：不快取——連續呼叫兩次，底層一定被打兩次
// ============================================================
await (async function test7() {
  let n = 0;
  const { ctx, calls } = makeCtx(() => {
    n++;
    return { ok: true, data: { contracts: [{ contract_id: 'C000' + n }] } };
  });

  const r1 = await listContracts(ctx);
  const r2 = await listContracts(ctx);
  assertEqual(calls.length, 2, '7a: 連續呼叫兩次，底層 ctx.api.call 被打兩次（不快取）');
  assertTrue(JSON.stringify(r1) !== JSON.stringify(r2), '7b: 兩次結果不同，證明第二次真的重打了後端而非吃到快取');
})();

// ============================================================
// 8. getContract：成功轉接、參數正確（token 是合約簽署 token，不是登入 token）
// ============================================================
await (async function test8() {
  const contractData = {
    state: 'signed',
    contract: { contract_id: 'C0001', name: '王小明', room: '二樓單人房' },
    equip: ['書桌'],
    terms: '條文內容……'
  };
  const { ctx, calls } = makeCtx((backendId, action, payload) => {
    assertEqual(backendId, 'dorm', '8a: backendId 是 dorm');
    assertEqual(action, 'contract', '8b: action 是 contract');
    assertEqual(payload, { token: 'abc123token' }, '8c: payload 帶正確的 token 欄位');
    return { ok: true, data: contractData };
  });

  const r = await getContract(ctx, 'abc123token');
  assertEqual(calls.length, 1, '8d: 呼叫底層一次');
  assertEqual(r, { ok: true, data: contractData }, '8e: 回傳形狀與內容正確（state/contract/equip/terms 整包在 data 裡）');
})();

// ============================================================
// 9. getContract：後端回 {ok:false}（例如連結無效）原樣通過
// ============================================================
await (async function test9() {
  const { ctx } = makeCtx(() => ({ ok: false, error: '連結無效' }));
  const r = await getContract(ctx, 'bad-token');
  assertEqual(r, { ok: false, error: '連結無效' }, '9a: {ok:false} 錯誤訊息原樣通過');
})();

// ============================================================
// 10. getContract：回傳缺 contract 欄位 → {ok:false}，不拋例外
// ============================================================
await (async function test10() {
  const { ctx } = makeCtx(() => ({ ok: true, data: { state: 'signed' } })); // 故意漏掉 contract
  const r = await getContract(ctx, 'abc123token');
  assertEqual(r.ok, false, '10a: 缺 contract 欄位回 ok:false');
  assertTrue(typeof r.error === 'string' && r.error.length > 0, '10b: 帶有錯誤訊息');
})();

// ============================================================
// 11. getContract：呼叫端沒帶 token → 直接回 {ok:false}，連底層都不打
// ============================================================
await (async function test11() {
  const { ctx, calls } = makeCtx(() => ({ ok: true, data: { contract: {} } }));

  const r1 = await getContract(ctx, '');
  const r2 = await getContract(ctx, undefined);
  assertEqual(calls.length, 0, '11a: token 缺漏時不呼叫底層');
  assertEqual(r1, { ok: false, error: '缺少 token' }, '11b: 空字串 token 回缺少 token');
  assertEqual(r2, { ok: false, error: '缺少 token' }, '11c: undefined token 回缺少 token');
})();

// ============================================================
// 12. 網路錯誤／例外：ctx.api.call 同步拋例外 → {ok:false}，不拋例外
// ============================================================
await (async function test12() {
  const ctx = {
    api: {
      call() {
        throw new Error('網路連線失敗，請稍後再試');
      }
    }
  };

  let threw = false;
  let r;
  try {
    r = await getRooms(ctx);
  } catch {
    threw = true;
  }
  assertTrue(!threw, '12a: getRooms 面對同步拋例外的 ctx.api.call 不會往外拋');
  assertEqual(r, { ok: false, error: '網路連線失敗，請稍後再試' }, '12b: 轉成 {ok:false,error}');
})();

// ============================================================
// 13. 網路錯誤／例外：ctx.api.call 回傳 rejected promise（逾時等情境）→ {ok:false}，不拋例外
// ============================================================
await (async function test13() {
  const ctx = {
    api: {
      call() {
        return Promise.reject(new Error('請求逾時，請稍後再試'));
      }
    }
  };

  let threw = false;
  let r;
  try {
    r = await listContracts(ctx);
  } catch {
    threw = true;
  }
  assertTrue(!threw, '13a: listContracts 面對 rejected promise 不會往外拋');
  assertEqual(r, { ok: false, error: '請求逾時，請稍後再試' }, '13b: 轉成 {ok:false,error}');

  let threw2 = false;
  let r2;
  try {
    r2 = await getContract(ctx, 'abc123token');
  } catch {
    threw2 = true;
  }
  assertTrue(!threw2, '13c: getContract 面對 rejected promise 不會往外拋');
  assertEqual(r2, { ok: false, error: '請求逾時，請稍後再試' }, '13d: 轉成 {ok:false,error}');
})();

// ============================================================
// 14. ctx 或 ctx.api.call 不存在 → {ok:false}，不拋例外
// ============================================================
await (async function test14() {
  let threw = false;
  let r;
  try {
    r = await getRooms(null);
  } catch {
    threw = true;
  }
  assertTrue(!threw, '14a: ctx 是 null 也不會往外拋');
  assertEqual(r.ok, false, '14b: ctx 是 null 回 ok:false');

  let threw2 = false;
  let r2;
  try {
    r2 = await listContracts({});
  } catch {
    threw2 = true;
  }
  assertTrue(!threw2, '14c: ctx.api 不存在也不會往外拋');
  assertEqual(r2.ok, false, '14d: ctx.api 不存在回 ok:false');
})();

// ============================================================
// 15. 後端回傳不是物件（例如 undefined）→ {ok:false}，不拋例外
// ============================================================
await (async function test15() {
  const { ctx } = makeCtx(() => undefined);
  let threw = false;
  let r;
  try {
    r = await getRooms(ctx);
  } catch {
    threw = true;
  }
  assertTrue(!threw, '15a: 底層回傳 undefined 也不會往外拋');
  assertEqual(r.ok, false, '15b: 回 ok:false');
})();

// ============================================================
// B. 真實網路守衛總量斷言
// ============================================================
assertEqual(realNetworkCalls.length, 0, 'B: 全程真實網路呼叫次數為 0（未被 mock 的 fetch 從未被呼叫）');

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
