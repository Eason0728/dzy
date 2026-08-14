/**
 * platform/api.js — 後端呼叫封裝＋回傳格式轉接（T1-7）
 *
 * 正本規格：docs/spec.md §4.8（送出與回傳格式）、§6.3（平台代管通行碼）、
 * §7（店長節點裁切）、§3 S4（為什麼用 text/plain）。
 *
 * 這是前端呼叫後端的唯一通道。三支後端回傳格式各不相同，這一層把它們轉成
 * 同一個形狀 {ok:true,data:{...}} | {ok:false,error:string}，模組不必各自處理。
 * 店長只能看自己門市這件事也在這一層做——只有一處過濾，不會漏網。
 *
 * 【三支後端的真實送出格式（讀過各自程式碼確認，不是猜的）】
 * - platform（apps-script/platform/Code.gs dispatch_）：
 *     body = {action, token, payload:{...}}，token 與 payload 同層、payload 是巢狀物件。
 *     這支後端本來就是照 spec §4.8 新建的。
 * - audit（~/mala-audit/apps-script/Code.gs handleGetAll/handleSubmitAudit 等）：
 *     通行碼欄位是 payload.code；其餘欄位（record/details/...）與 action、code 同層扁平展開，
 *     不是包在巢狀 payload 裡。
 * - dorm（~/mala-dorm-contract/apps-script/Api.gs requireAdmin(p) 讀 p.pass）：
 *     通行碼欄位是 pass；其餘欄位（name/room/term_start/token/...）同樣與 action、pass 同層扁平展開。
 * 因此 buildRequestBody_() 依 backendId 組出對應的實際格式，不是三支都套同一個殼。
 *
 * 【三支後端的真實回傳格式（同樣讀過程式碼確認）】
 * - platform（apps-script/platform/Auth.gs handleLogin_/handleMe_ 等）：
 *     已經是 {ok:true, data:{...}} 或 {ok:false, error} —— 跟模組要看到的形狀一樣，不必再包一層。
 * - audit：{ok:true, config, items, records, details, ops_records, ops_details} —— 扁平物件，
 *     ok 以外的欄位要整包塞進 data。
 * - dorm：{ok:true, contracts:[...]} 或 {ok:true, contract_id, token, ...} —— 同樣扁平，包法一致。
 * 轉接只在 transformResponse_() 這一處做，模組與這個檔案的其他函式都不得再判一次既有格式。
 *
 * 【逾時／網路錯誤／非 JSON】
 * 一律回 {ok:false, error:'...'}，絕不拋例外讓呼叫方炸掉。預設逾時 15 秒
 * （測試用 __setTimeoutMs() 覆寫，避免真的等 15 秒；傳非正數還原成預設值）。
 */

'use strict';

import { BACKENDS } from './config.js';
import { getUser, can, getSecret, getToken } from './auth.js';

const DEFAULT_TIMEOUT_MS = 15000;
let timeoutMs = DEFAULT_TIMEOUT_MS;

/** 測試用：覆寫逾時毫秒數。傳非正數（或不傳）還原成預設的 15 秒。 */
export function __setTimeoutMs(ms) {
  timeoutMs = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_TIMEOUT_MS;
}

// 既有兩支後端的通行碼參數名（讀程式碼確認，見檔頭說明）。platform 不在這張表裡，
// 它的 token 走 §4.8 的殼（見 buildRequestBody_）。
const LEGACY_SECRET_FIELD = { audit: 'code', dorm: 'pass' };

/**
 * 依 backendId 組出真正要送出的 request body。
 * @param {string} backendId
 * @param {string} action
 * @param {object} payload
 * @returns {object}
 */
function buildRequestBody_(backendId, action, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};

  if (backendId === 'platform') {
    // spec §4.8 的殼：{action, token, payload}。
    // token 一律由 getToken() 自動帶（2026-08-14 改）——與下面既有後端的通行碼同一套規則：
    // 憑證只認目前登入身分持有的那一份，不採信呼叫端 payload 裡夾帶的同名欄位。
    // 呼叫端若還是塞了 payload.token，一律丟棄，避免「用別人的 token 打 API」這條路存在。
    const rest = { ...p };
    delete rest.token;
    return { action, token: getToken(), payload: rest };
  }

  // audit／dorm：既有後端的真實格式，欄位與 action 同層扁平展開，通行碼用各自的參數名，
  // 一律用 getSecret() 自動帶，不採信呼叫端 payload 裡可能夾帶的同名欄位（安全考量：
  // 通行碼只認目前登入身分下發的那一份，不給呼叫端覆寫的機會）。
  const body = { action, ...p };
  const secretField = LEGACY_SECRET_FIELD[backendId];
  if (secretField) {
    body[secretField] = getSecret(backendId);
  }
  return body;
}

/** 帶逾時的 POST；逾時用 AbortController 中斷，fetch 會丟出 name==='AbortError' 的例外 */
async function postJson_(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// 稽核回傳裡，「一列＝一店資料」的陣列（items／records／details／ops_records／ops_details）
// 全部都用 `store` 這個欄位存店代碼（讀 ~/mala-audit/apps-script/Code.gs 的
// readItems_/readRecords_/readDetails_/readOpsRecords_/readOpsDetails_ 逐一確認，不是猜的）。
// config.stores 是店代碼對照表（參考用列舉），欄位名是 `code` 不是 `store`，天生不會被這個
// 過濾器誤裁——它不是「一列稽核資料」，是給畫面選單用的固定清單。
function filterOwnNode_(data, node) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (Array.isArray(val) && val.length > 0 && val.every((row) => row && typeof row === 'object' && 'store' in row)) {
      out[key] = val.filter((row) => row.store === node);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * 店長節點裁切（spec §7、任務指示第 4 點——這條寫錯等於權限是假的）。
 * 判斷條件：這個 ns 底下，使用者沒有 `<ns>.read`（全節點）但有 `<ns>.read.own`。
 * spec §4.1 已約束 backend 必為 ns，這裡直接拿 backendId 當 ns 用。
 * 有 `<ns>.read` 的人（會計、部門主管、admin）一律不裁切——即使同時也有 `.read.own`，
 * 全節點權限優先，不裁切。
 */
function maybeFilterOwnNode_(backendId, data) {
  const hasFull = can(`${backendId}.read`);
  const hasOwn = can(`${backendId}.read.own`);
  if (hasFull || !hasOwn) return data;
  const user = getUser();
  const node = user && user.node;
  if (!node) return data; // 理論上不會發生：有 read.own 的人一定有 node
  return filterOwnNode_(data, node);
}

/** 轉接只在這一處做（spec §4.8）：依 backendId 決定既有回傳長怎樣、要怎麼包進 data。 */
function transformResponse_(backendId, json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: '伺服器回應格式錯誤' };
  }
  if (json.ok !== true) {
    return { ok: false, error: (json && json.error) || '請求失敗' };
  }

  if (backendId === 'platform') {
    // 平台後端本來就回 {ok:true, data:{...}}，不必再包一層，否則會變成 data.data。
    const data = (json.data && typeof json.data === 'object') ? json.data : {};
    return { ok: true, data };
  }

  // audit／dorm：既有回傳是扁平物件，ok 以外的欄位整包塞進 data。
  const rest = { ...json };
  delete rest.ok;
  const data = maybeFilterOwnNode_(backendId, rest);
  return { ok: true, data };
}

/**
 * 前端呼叫後端的唯一通道。
 * @param {string} backendId 'platform' | 'audit' | 'dorm'
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
export async function call(backendId, action, payload = {}) {
  const url = BACKENDS[backendId];
  if (!url) {
    return { ok: false, error: `後端尚未設定：${backendId}` };
  }

  const body = buildRequestBody_(backendId, action, payload);

  let res;
  try {
    res = await postJson_(url, body);
  } catch (err) {
    const timedOut = !!(err && err.name === 'AbortError');
    return {
      ok: false,
      error: timedOut ? '請求逾時，請稍後再試' : ((err && err.message) || '網路連線失敗，請稍後再試')
    };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: '伺服器回應格式錯誤' };
  }

  return transformResponse_(backendId, json);
}
