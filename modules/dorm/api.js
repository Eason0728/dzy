/**
 * modules/dorm/api.js — 宿舍合約資料層（讀取類，T3-1）
 *
 * 正本規格：docs/spec.md §4.7（ctx）、§4.8（後端呼叫與回傳格式）、
 * §4.5（本期三模組摘要表，dorm 那一列：ns='dorm', backend='dorm'）。
 *
 * 本檔只包三個讀取類 action，讀 ~/mala-dorm-contract/apps-script/Api.gs 確認
 * （不是猜的，行號見下方各函式註解）：
 *   - rooms：房間清單（不需通行碼）
 *   - list ：合約清單（後端 requireAdmin 檢查，但通行碼由 platform/api.js 的
 *            buildRequestBody_() 依 backendId='dorm' 自動帶 pass，本檔不必處理）
 *   - contract：單一合約查詢（用 token，指合約自己的簽署 token，
 *            不是登入用的平台 token，兩者是不同東西）
 *
 * 這一層跟 modules/audit-shared/api.js 一樣「薄」：只做資料存取＋防禦性驗證，
 * 不做業務邏輯、不自己 fetch、不自己組網址——一律透過 ctx.api.call('dorm', action, payload)。
 *
 * 【快取決定：這三個讀取 action 全部不快取，理由見下】
 * audit-shared 之所以要快取＋in-flight 合併，是因為 audit-ops／audit-stock
 * 兩個模組共用同一支 audit 後端，兩張卡片的 badge()/mount() 幾乎同時觸發時
 * 會重複打同一份 getAll，而且稽核資料本來就是「一個月才變一次」的月結性質，
 * 快取 60 秒不會讓人看到錯的資料。
 * dorm 是本期唯一一個 backend='dorm' 的模組（spec §4.5 三模組摘要表只有這一列
 * ns=backend='dorm'），沒有「兩個模組同時搶同一份資料」這個結構性問題，快取
 * 對效能的幫助很小；但合約資料「隨時可能新增或終止」——建單、簽約、退宿點交、
 * 終止合約都會讓 list/contract 的結果立刻過期，而本任務只做讀取，還沒有寫入類
 * 動作可以在成功後 invalidate() 快取（那是下一個任務的事）。沒有寫入觸發失效
 * 機制的快取，只會讓「剛建好的合約在清單裡看不到」「已經終止的合約還顯示在住」
 * 這種情況維持到 TTL 到期為止——這是法律文件，寧可每次都重打後端，不要為了省
 * 幾次網路請求換來畫面可能顯示過期的合約狀態。所以這三個函式都是單純的
 * passthrough，不設快取、不設 TTL、不合併 in-flight 呼叫。
 *
 * 【⚠ 讀 Api.gs 時發現的既有後端缺口，記在這裡供之後的任務參照】
 * Api.gs 的 rooms／list／contract 三個 action 只定義在 doGet()（第 22-41 行）的
 * switch 裡；doPost()（第 43-85 行）的 switch 只有 create/sign/handoverCreate/
 * handoverSign/terminate/delete/cleanupTest/setSetting 這些寫入類 case，沒有這
 * 三個讀取 action。而 platform/api.js 的 call() 一律用 POST 送出（postJson_()
 * 固定 method:'POST'，spec §4.8 也明講送出格式是 POST），也就是說目前透過
 * ctx.api.call('dorm', 'rooms'/'list'/'contract', ...) 打到「真的」Api.gs 後端時，
 * 會落進 doPost() 的 default case，被當成「未知的 action」打回 {ok:false}——
 * 這三個 action 實際上打不通。這是既有後端（Api.gs，本任務唯讀不准改）的缺口，
 * 不是本檔或 platform 層的問題，本任務的測試全程 mock ctx.api.call，不會暴露
 * 這個問題，但這支模組要在正式環境真的動起來，需要另開任務在 Api.gs 的
 * doPost() 補上這三個 action 的 case（或改成也接受 GET）。
 */

'use strict';

const BACKEND_ID = 'dorm';

/**
 * 呼叫後端＋基本防禦：ctx/ctx.api.call 不存在、呼叫拋例外、回傳不是物件、
 * 回傳 ok!==true，全部收斂成 {ok:false,error}，絕不讓例外往外拋。
 * @param {object} ctx
 * @param {string} action
 * @param {object} payload
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
async function safeCall_(ctx, action, payload) {
  try {
    if (!ctx || !ctx.api || typeof ctx.api.call !== 'function') {
      return { ok: false, error: 'ctx.api.call 不存在，無法呼叫後端' };
    }
    const res = await ctx.api.call(BACKEND_ID, action, payload || {});
    if (!res || typeof res !== 'object') {
      return { ok: false, error: '後端回傳格式錯誤' };
    }
    if (res.ok !== true) {
      // {ok:false} 原樣通過，錯誤訊息不改寫
      return { ok: false, error: (res && res.error) || '請求失敗' };
    }
    return res;
  } catch (err) {
    return { ok: false, error: (err && err.message) || '呼叫後端時發生未預期錯誤' };
  }
}

/**
 * 房間清單（Api.gs doGet 第 26-27 行：case 'rooms' → { ok:true, rooms: ROOMS, equip: EQUIP_ITEMS }，
 * 不需通行碼）。轉接後（spec §4.8）ctx.api.call 回傳 {ok:true, data:{rooms, equip}}。
 * @param {object} ctx
 * @returns {Promise<{ok:true,data:{rooms:Array,equip:Array}}|{ok:false,error:string}>}
 */
export async function getRooms(ctx) {
  const res = await safeCall_(ctx, 'rooms', {});
  if (!res.ok) return res;

  const data = (res.data && typeof res.data === 'object') ? res.data : {};
  if (!Array.isArray(data.rooms)) {
    return { ok: false, error: '後端回傳缺少 rooms 欄位' };
  }
  return { ok: true, data: { rooms: data.rooms, equip: Array.isArray(data.equip) ? data.equip : [] } };
}

/**
 * 合約清單（Api.gs doGet 第 28-30 行：case 'list' → requireAdmin(p); { ok:true, contracts: listContracts() }）。
 * 通行碼欄位是 pass（Api.gs 第 11-20 行 requireAdmin 讀 p.pass），但由 platform/api.js 的
 * buildRequestBody_() 依 backendId='dorm' 自動帶入 getSecret('dorm')，本檔不處理、也不接受
 * 呼叫端夾帶同名欄位。
 * @param {object} ctx
 * @returns {Promise<{ok:true,data:{contracts:Array}}|{ok:false,error:string}>}
 */
export async function listContracts(ctx) {
  const res = await safeCall_(ctx, 'list', {});
  if (!res.ok) return res;

  const data = (res.data && typeof res.data === 'object') ? res.data : {};
  if (!Array.isArray(data.contracts)) {
    return { ok: false, error: '後端回傳缺少 contracts 欄位' };
  }
  return { ok: true, data: { contracts: data.contracts } };
}

/**
 * 單一合約查詢（Api.gs doGet 第 31-32 行：case 'contract' → getContractByToken(p.token, e)；
 * 第 161-180 行 getContractByToken：第 162 行 `if (!token) throw new Error('缺少 token')`，
 * 確認參數名是 token——這是合約自己的簽署 token，不是平台登入 token）。
 * 成功時後端回 { ok:true, state, contract:{...}, equip, terms }，轉接後整包進 data。
 * @param {object} ctx
 * @param {string} token 合約的簽署 token（Api.gs 的 token 欄位，非登入 token）
 * @returns {Promise<{ok:true,data:{state:string,contract:object,equip:Array,terms:*}}|{ok:false,error:string}>}
 */
export async function getContract(ctx, token) {
  if (!token) {
    // 對齊後端本身的錯誤訊息（Api.gs 第 162 行），並省下一次無意義的後端呼叫
    return { ok: false, error: '缺少 token' };
  }

  const res = await safeCall_(ctx, 'contract', { token });
  if (!res.ok) return res;

  const data = (res.data && typeof res.data === 'object') ? res.data : {};
  if (!data.contract || typeof data.contract !== 'object') {
    return { ok: false, error: '後端回傳缺少 contract 欄位' };
  }
  return { ok: true, data };
}
