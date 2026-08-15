/**
 * modules/audit-shared/api.js — 稽核共用資料層（T2-1）
 *
 * 正本規格：docs/spec.md §4.7（ctx）、§4.8（後端呼叫與回傳格式）、
 * §6.4（兩張稽核卡片、一次後端呼叫——這支就是那一節在講的東西）、
 * §7（店長節點裁切，已經在平台層 platform/api.js 做掉了，這裡不重做）。
 *
 * audit-ops（營運稽核表）與 audit-stock（月初盤點抽查）是首頁兩張獨立模組／卡片，
 * 但共用同一支稽核後端（manifest.backend='audit'，spec §4.1 已約束 backend 必須等於 ns，
 * 兩個模組的 ns 都是 'audit'）。若兩個模組各自呼叫 getAll，同一份資料會被抓兩次；
 * 這支檔案就是它們共用的資料提供者：記憶體快取（TTL 60 秒）＋同時發起的呼叫合併成一次請求。
 *
 * 這一層刻意「薄」，只做資料存取，不做業務邏輯：
 * - 不做節點裁切——平台層 platform/api.js 的 transformResponse_/maybeFilterOwnNode_
 *   已經做過一次（spec §7）。這裡若重做會出現「裁兩次」的難查問題：兩邊過濾邏輯
 *   稍有出入，就會變成「有時候看得到、有時候看不到別店資料」，比完全不裁切更難查。
 * - 不自己發網路請求、不自己組網址——一律透過 ctx.api.call(backendId, action, payload)
 *   （spec §4.7 ctx.api 的簽章、§4.8 的送出格式）。backendId 固定寫死 'audit'：
 *   audit-ops／audit-stock 兩個模組的 manifest.backend 都是 'audit'（spec §4.1／§4.5），
 *   而 ctx 本身不帶 moduleId（spec §4.7 沒有這個欄位），所以「呼叫端該打哪支後端」
 *   在這支共用層裡是固定的，不是從 ctx 動態讀出來的。
 *
 * 快取策略：
 * - getAll(ctx)：快取命中且未過期 → 直接回傳快取值；否則，若已經有一個 in-flight 的
 *   請求在跑（另一個模組的 badge() 或 mount() 幾乎同時觸發），重複使用同一個 Promise，
 *   不再多發一次請求，兩邊等到的是同一份結果；都沒有的話才真的發一次新請求。
 *   只有 {ok:true} 的結果會被存進快取，{ok:false} 絕不快取——否則後端恢復正常之後，
 *   畫面會因為吃到快取住的失敗結果而繼續顯示壞掉的樣子。
 * - invalidate()：清掉快取與 in-flight 標記，下次 getAll() 一定重抓。
 * - submit(ctx, action, payload)：包裝「送出類」action（submitAudit／markRest／
 *   submitOpsAudit……，見 ~/mala-audit/apps-script/Code.gs 的 ACTIONS 清單），
 *   成功後自動 invalidate()，讓下一次 getAll() 看到最新資料；失敗則原樣回傳，不動快取。
 *
 * 時鐘可注入（見 __setClock），測試不必真的等 60 秒。
 */

'use strict';

const BACKEND_ID = 'audit';
const GET_ALL_ACTION = 'getAll';
const TTL_MS = 60 * 1000;

let cache = null;     // { result, expiresAt } —— result 一定是成功的 {ok:true,...}
let inFlight = null;  // 目前進行中的 getAll() Promise；同時發起的呼叫共用它，不重複發請求
let now_ = () => Date.now();

/**
 * 測試用：注入可控時鐘。傳入一個回傳毫秒數的函式，覆寫「現在時間」的來源；
 * 傳非函式（含不傳、傳 null）還原成真實的 Date.now。
 */
export function __setClock(fn) {
  now_ = (typeof fn === 'function') ? fn : () => Date.now();
}

/**
 * 取得稽核後端的全部資料。
 * 回傳形狀已由 platform/api.js 轉接過（spec §4.8）：
 * {ok:true, data:{config, items, records, details, ops_records, ops_details}} | {ok:false, error}
 *
 * @param {object} ctx  平台交給模組的 ctx（spec §4.7），這裡只用到 ctx.api.call
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
export async function getAll(ctx) {
  const nowMs = now_();
  if (cache && nowMs < cache.expiresAt) {
    return cache.result;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const res = await ctx.api.call(BACKEND_ID, GET_ALL_ACTION, {});
      if (res && res.ok === true) {
        cache = { result: res, expiresAt: now_() + TTL_MS };
      }
      // {ok:false} 不進快取（任務指示第 4 點）：這裡不動 cache，維持它原本的狀態
      // （會走到這裡代表舊快取本來就已經過期或不存在，效果上就是「沒有快取可用」）。
      return res;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 清掉快取與 in-flight 標記，下次 getAll() 一定重抓。 */
export function invalidate() {
  cache = null;
  inFlight = null;
}

/**
 * 送出類動作的封裝（submitAudit／markRest／submitOpsAudit……）。
 * 成功後自動 invalidate()，讓下一次 getAll() 重抓最新資料；失敗則原樣回傳，不動快取。
 *
 * @param {object} ctx
 * @param {string} action
 * @param {object} payload
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
export async function submit(ctx, action, payload) {
  // 試跑模式（網址加 ?dryrun=1）：讀取照常走真實後端，但**寫入一律攔下不送出**。
  // 存在的理由：稽核後端接的是會計每個月實際在用的正式試算表。
  // 要請人實際點過一輪給意見時，不能讓「試按一下送出」變成一筆假資料寫進正式資料。
  // 這不是測試替身，是給真人試用時的安全閥——所以它留在正式程式碼裡，只靠網址開關。
  if (isDryRun()) {
    console.warn('[試跑模式] 攔下一次寫入，未送出到後端：', action, payload);
    return { ok: true, data: { dryRun: true, action, payload } };
  }

  const res = await ctx.api.call(BACKEND_ID, action, payload);
  if (res && res.ok === true) {
    invalidate();
  }
  return res;
}

/** 網址帶 ?dryrun=1 就進入試跑模式。非瀏覽器環境（node 測試）一律不啟用。 */
export function isDryRun() {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    return new URLSearchParams(window.location.search).get('dryrun') === '1';
  } catch {
    return false;
  }
}
