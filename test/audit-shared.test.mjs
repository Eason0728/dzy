// node test/audit-shared.test.mjs —— T2-1 驗收：modules/audit-shared/api.js（稽核共用資料層）
//
// 重點：
//   · 記憶體快取 TTL 60 秒：同一份資料在 TTL 內重複呼叫只發一次底層請求
//   · 同時發起的呼叫合併成一次請求（in-flight promise 共用，兩邊拿到同一份結果）
//   · {ok:false} 不進快取，下次會重試
//   · invalidate() / submit() 成功後都會讓下次 getAll() 重抓；submit() 失敗不動快取
//
// ⚠ 全程用假的 ctx.api.call（單純的 in-memory 計數 mock），不 import platform/api.js、
// 不打真實網路——稽核後端是正在運作的正式系統，打下去會碰到正式資料。
//
// 這支模組是「模組層」的資料提供者，內部狀態（cache／inFlight）是 module-level 單例，
// 跨測試段落會殘留，所以每個測試段落開始前都呼叫 reset()（invalidate + 還原時鐘）。

'use strict';

import { getAll, invalidate, submit, __setClock } from '../modules/audit-shared/api.js';

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

function okResult(data) {
  return { ok: true, data: data || {} };
}

function reset() {
  invalidate();
  __setClock(null); // 還原成真實時間
}

// ============================================================
// 1. 連續呼叫三次 getAll → 底層 api.call 只被呼叫一次
// ============================================================
await (async function test1() {
  reset();
  const { ctx, calls } = makeCtx(() => okResult({ n: 1 }));

  const r1 = await getAll(ctx);
  const r2 = await getAll(ctx);
  const r3 = await getAll(ctx);

  assertEqual(calls.length, 1, '1a: 連續呼叫三次只發一次底層請求');
  assertEqual(r1, okResult({ n: 1 }), '1b: 第一次拿到正確結果');
  assertEqual(r2, r1, '1c: 第二次拿到快取結果（與第一次相同）');
  assertEqual(r3, r1, '1d: 第三次也是快取結果');
})();

// ============================================================
// 2. 同時發起兩個 getAll（不 await 第一個就發第二個）→ 底層只被呼叫一次，兩邊拿到相同結果
// ============================================================
await (async function test2() {
  reset();
  let resolveCall;
  const gate = new Promise((resolve) => { resolveCall = resolve; });
  const { ctx, calls } = makeCtx(async () => {
    await gate; // 卡住，模擬還沒回來的網路請求
    return okResult({ n: 2 });
  });

  const p1 = getAll(ctx);
  const p2 = getAll(ctx); // 刻意不 await p1，緊接著發第二個（模擬兩張卡片的 badge() 幾乎同時觸發）

  assertEqual(calls.length, 1, '2a: 兩個同時發起的呼叫，底層只打一次');

  resolveCall();
  const [r1, r2] = await Promise.all([p1, p2]);

  assertEqual(calls.length, 1, '2b: resolve 之後底層呼叫次數仍是一次');
  assertEqual(r1, r2, '2c: 兩邊拿到相同的結果內容');
  assertEqual(r1, okResult({ n: 2 }), '2d: 結果內容正確');
})();

// ============================================================
// 3. TTL 過期後會重抓（用可注入的時鐘，不真的 sleep 60 秒）
// ============================================================
await (async function test3() {
  reset();
  let t = 1000000; // 任意起始毫秒數
  __setClock(() => t);
  const { ctx, calls } = makeCtx(() => okResult({ n: 3 }));

  await getAll(ctx);
  assertEqual(calls.length, 1, '3a: 第一次呼叫底層一次');

  t += 30 * 1000; // 過 30 秒，還在 TTL(5 分鐘) 內
  await getAll(ctx);
  assertEqual(calls.length, 1, '3b: TTL 內（30 秒後）仍吃快取，不重抓');

  // 2026-08-17：TTL 由 60 秒放寬為 5 分鐘（Eason 回報切分頁要等好幾秒——每個分頁
  // mount 都會 getAll，而後端一次要 2–5 秒）。這條驗的行為沒變（過了 TTL 會重抓），
  // 只是門檻跟著實作的常數走。超過 TTL 但未超過 STALE 時會「先回舊值＋背景重抓」，
  // 所以這裡看到的是背景那一次呼叫（第 8 組測試專門驗這個新行為）。
  t += 5 * 60 * 1000 + 1000; // 累積超過 5 分鐘
  await getAll(ctx);
  assertEqual(calls.length, 2, '3c: 超過 TTL（累積 5 分鐘後）會重抓');
})();

// ============================================================
// 4. invalidate() 之後下次重抓
// ============================================================
await (async function test4() {
  reset();
  const { ctx, calls } = makeCtx(() => okResult({ n: 4 }));

  await getAll(ctx);
  assertEqual(calls.length, 1, '4a: 第一次呼叫底層一次');

  await getAll(ctx);
  assertEqual(calls.length, 1, '4b: TTL 內第二次仍吃快取');

  invalidate();
  await getAll(ctx);
  assertEqual(calls.length, 2, '4c: invalidate() 之後下次呼叫會重抓');
})();

// ============================================================
// 5. 後端回 {ok:false} → 不進快取，下次會重試
// ============================================================
await (async function test5() {
  reset();
  let shouldFail = true;
  const { ctx, calls } = makeCtx(() => {
    if (shouldFail) return { ok: false, error: '通行碼錯誤' };
    return okResult({ n: 5 });
  });

  const r1 = await getAll(ctx);
  assertEqual(r1, { ok: false, error: '通行碼錯誤' }, '5a: 第一次拿到失敗結果');
  assertEqual(calls.length, 1, '5b: 第一次呼叫底層一次');

  await getAll(ctx);
  assertEqual(calls.length, 2, '5c: 失敗結果沒有被快取住，下次會重試');

  shouldFail = false;
  const r3 = await getAll(ctx);
  assertEqual(calls.length, 3, '5d: 後端恢復後，第三次呼叫仍然重打（因為前面一直沒被快取）');
  assertEqual(r3, okResult({ n: 5 }), '5e: 後端恢復後拿到成功結果');

  await getAll(ctx);
  assertEqual(calls.length, 3, '5f: 成功之後才真正進快取，第四次不再重打');
})();

// ============================================================
// 6. submit() 成功後快取失效，下次 getAll 重抓；submit() 失敗則不動快取
// ============================================================
await (async function test6() {
  reset();
  const { ctx, calls } = makeCtx((backendId, action) => {
    if (action === 'getAll') return okResult({ n: 6 });
    if (action === 'submitAudit') return { ok: true, data: { record_key: 'sxl-gf_2026-08' } };
    if (action === 'markRest') return { ok: false, error: '無權限' };
    return { ok: false, error: '未預期的 action：' + action };
  });

  await getAll(ctx);
  assertEqual(calls.length, 1, '6a: 第一次 getAll 呼叫底層一次');

  await getAll(ctx);
  assertEqual(calls.length, 1, '6b: TTL 內第二次 getAll 仍吃快取');

  const submitRes = await submit(ctx, 'submitAudit', { record: {} });
  assertEqual(submitRes.ok, true, '6c: submit() 送出成功');
  assertEqual(calls.length, 2, '6d: submit() 本身也算一次底層呼叫');

  await getAll(ctx);
  assertEqual(calls.length, 3, '6e: submit() 成功後快取失效，下次 getAll 重抓');

  await getAll(ctx);
  assertEqual(calls.length, 3, '6f: 前置確認：目前快取（第 3 次呼叫的結果）仍有效');

  const failRes = await submit(ctx, 'markRest', { store: 'sxl-gf', month: '2026-08' });
  assertEqual(failRes.ok, false, '6g: submit() 失敗');
  assertEqual(calls.length, 4, '6h: submit() 不管成不成功都會打一次底層');

  await getAll(ctx);
  assertEqual(calls.length, 4, '6i: submit() 失敗不會讓快取失效，getAll 仍吃快取');
})();

// ============================================================
// 7. ctx.api.call 收到的 backendId／action／payload 是否正確
//    （audit-shared 固定打 backend='audit'，見 spec §4.1：manifest.backend 必須等於 ns）
// ============================================================
await (async function test7() {
  reset();
  const { ctx, calls } = makeCtx(() => okResult({}));
  await getAll(ctx);
  assertEqual(calls[0].backendId, 'audit', '7a: getAll 打的 backendId 是 audit');
  assertEqual(calls[0].action, 'getAll', '7b: getAll 打的 action 是 getAll');

  invalidate();
  await submit(ctx, 'submitOpsAudit', { foo: 'bar' });
  assertEqual(calls[1].backendId, 'audit', '7c: submit 打的 backendId 也是 audit');
  assertEqual(calls[1].action, 'submitOpsAudit', '7d: submit 把呼叫端指定的 action 原樣傳下去');
  assertEqual(calls[1].payload, { foo: 'bar' }, '7e: submit 把 payload 原樣傳下去');
})();

// ============================================================
// 8. 過期後的「先回舊值、背景更新」（2026-08-17 新增）
//    目的是讓切分頁不必空等；驗：立刻回舊值、背景真的有重抓、之後拿到新值、太舊就等新的。
// ============================================================
await (async () => {
  reset();
  let t = 0;
  __setClock(() => t);

  let n = 0;
  const { ctx, calls } = makeCtx(() => okResult({ n: ++n }));

  const first = await getAll(ctx);
  assertEqual(calls.length, 1, '8a: 第一次真的打後端');
  assertEqual(first.data.n, 1, '8b: 拿到第一版資料');

  t += 6 * 60 * 1000; // 過了 TTL（5 分）但還在 STALE（30 分）內
  const stale = await getAll(ctx);
  assertEqual(stale.data.n, 1, '8c: 過期後「立刻」拿到的是舊資料（不空等）');
  assertEqual(calls.length, 2, '8d: 同時已在背景發出重抓');

  await new Promise((r) => setTimeout(r, 0)); // 讓背景那次落地
  const fresh = await getAll(ctx);
  assertEqual(fresh.data.n, 2, '8e: 背景更新完成後，下一次拿到的是新資料');
  assertEqual(calls.length, 2, '8f: 且沒有因此多打一次後端');

  t += 40 * 60 * 1000; // 超過 STALE 上限
  await getAll(ctx);
  assertEqual(calls.length, 3, '8g: 舊到超過上限就老實等新的（不再回舊值）');

  __setClock(null);
})();

// ============================================================
reset();
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
