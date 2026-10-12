/**
 * platform/api.js — 後端呼叫封裝＋回傳格式轉接（T1-7）
 *
 * 正本規格：docs/spec.md §4.8（送出與回傳格式）、§6.3（通行碼代管＝Mac mini 代轉）、
 * §7（店長節點裁切）、§3 S4（為什麼用 text/plain）。
 *
 * 【2026-10-12 起：稽核／宿舍改由 Mac mini 代轉，瀏覽器拿不到通行碼】
 * audit／dorm 一律 POST 到 <平台主機>/platform/proxy，body {token, ns, action, payload}；
 * 通行碼由 mini 代帶（契約正本：~/dzy-minikit/apps/dzy-platform/PROXY.md）。
 * 下面「audit／dorm 真實送出格式」那段（code／pass 扁平展開）現在由 mini 的 proxy-hook.js 組，
 * 這裡只送 payload 原樣（呼叫端夾帶的 token／code／pass 照舊刪掉）。
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
import { getUser, can, getToken } from './auth.js';
import { isDryRun, isReadAction, notifyDryRun } from './dryrun.js';

// 代轉逾時 35 秒：mini 對舊後端等 30 秒，再留 5 秒餘裕（PROXY.md 第 3 節）
const PROXY_TIMEOUT_MS = 35000;
const PROXY_NS = { audit: true, dorm: true };

// 45 秒（2026-08-17 由 15 秒放寬，與 auth.js 同一個理由：Apps Script 本來就慢，
// 稽核 getAll 還要一次讀回五個分頁的整年資料，行動網路上 15 秒不夠用）。
const DEFAULT_TIMEOUT_MS = 45000;
let timeoutMs = DEFAULT_TIMEOUT_MS;

/** 測試用：覆寫逾時毫秒數。傳非正數（或不傳）還原成預設的 15 秒。 */
export function __setTimeoutMs(ms) {
  timeoutMs = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_TIMEOUT_MS;
}

/**
 * 代轉網址：從平台後端網址推（…/platform/api → …/platform/proxy），config.js 不另存一份。
 * 推不出來（網址不是 /api 結尾）回 ''＝當作沒設定。
 */
export function proxyUrl() {
  const u = BACKENDS.platform || '';
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/proxy') : '';
}

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
    // token 一律由 getToken() 自動帶（2026-08-14 改）：憑證只認目前登入身分持有的那一份，
    // 不採信呼叫端 payload 裡夾帶的同名欄位。呼叫端若還是塞了 payload.token，一律丟棄。
    const rest = { ...p };
    delete rest.token;
    return { action, token: getToken(), payload: rest };
  }

  // audit／dorm（2026-10-12 代轉）：{token, ns, action, payload}。
  // payload 裡呼叫端夾帶的 action／code／pass 一律刪掉——通行碼只在 mini 那邊帶，
  // 瀏覽器既沒有、也不准送；action 由平台決定（2026-08-15 對抗審查：不給 payload 覆寫 action）。
  // ⚠ payload.token **不能刪**：那是宿舍的「簽約／點交單 token」（handover／contract 要用），
  //   不是登入 token；登入 token 在外層 body.token，一律由 getToken() 帶，兩者不會混。
  //  （mini 的 proxy-hook.js buildBody 也只刪 action 與通行碼欄位，兩邊一致。）
  const rest = { ...p };
  delete rest.action;
  delete rest.code;
  delete rest.pass;
  return { token: getToken(), ns: backendId, action, payload: rest };
}

/** 帶逾時的 POST；逾時用 AbortController 中斷，fetch 會丟出 name==='AbortError' 的例外 */
async function postJson_(url, body, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs);
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
    // 沒有 store 欄位的列（含 null／非物件）一律丟掉：往關的方向失敗
    out[key] = isStoreRowArray_(val)
      ? val.filter((row) => row && typeof row === 'object' && row.store === node)
      : val;
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

  // 2026-08-15 對抗審查修正：原本這裡是 `if (!node) return data;`，
  // 註解寫「理論上不會發生」——但它一旦發生，回傳的是**全部節點的資料**，
  // 也就是這個防呆是往「開」的方向失敗的。
  // 只要有人在人員管理建了一個「店長 + 所屬節點留空」的帳號，隔離就整個消失。
  // 改成往「關」的方向失敗：拿不到節點就一列都不給，並在 console 留下可查的訊息。
  if (!node) {
    console.error(
      `[api] 使用者 ${user && user.id} 只有 ${backendId}.read.own 卻沒有所屬節點，` +
      '無法判斷該看哪一店，已回傳空資料。請到人員管理補上他的所屬節點。'
    );
    return emptyRows_(data);
  }

  return filterOwnNode_(data, node);
}

/** 把所有「一列一店」的陣列清空，其餘欄位（設定、對照表）保留——用於裁切失敗時的保守回傳 */
function emptyRows_(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    out[key] = isStoreRowArray_(val) ? [] : val;
  }
  return out;
}

/**
 * 判斷一個值是不是「一列一店」的資料陣列：只要有任一列帶 store 欄位就算（2026-10-12 修）。
 * 原本要求「每一列」都有 store，混入一列沒 store 就整批不裁切＝往開的方向失敗。
 * 沒有 store 的列由 filterOwnNode_ 丟掉。空陣列照舊不算。
 */
function isStoreRowArray_(val) {
  return Array.isArray(val) && val.length > 0
    && val.some((row) => row && typeof row === 'object' && 'store' in row);
}

/** 轉接只在這一處做（spec §4.8）：依 backendId 決定既有回傳長怎樣、要怎麼包進 data。 */
function transformResponse_(backendId, json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: '伺服器回應格式錯誤' };
  }
  if (json.ok !== true) {
    // 2026-08-15 修：原本只留 error，其餘欄位全丟掉。
    // 但宿舍後端的「床位重複」是一種**軟性警告**：
    //   {ok:false, warn:'床位重複', message:'…確定要建立嗎？'}
    // 它連 error 欄位都沒有，舊版是拿 message 問使用者、確認後帶 force 重送。
    // 只留 error 的結果是：既有的「強制建立」流程整個消失，而且畫面只顯示
    // 「請求失敗」四個字——會計完全不知道發生什麼事。
    // 改成：訊息取 error → message → 通用字；其餘欄位原樣放進 data 供模組判斷。
    const rest = { ...json };
    delete rest.ok;
    delete rest.error;
    const out = { ok: false, error: json.error || json.message || '請求失敗' };
    if (Object.keys(rest).length > 0) out.data = rest;
    return out;
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

// 代轉回 401（token 失效／帳號停用）時要走「登入過期」流程：shell 開機時註冊處理函式
let sessionExpiredHandler = null;
/** shell.js 註冊：代轉回 401 時呼叫（清本機 session、回登入頁）。傳非函式＝取消註冊。 */
export function setSessionExpiredHandler(fn) {
  sessionExpiredHandler = (typeof fn === 'function') ? fn : null;
}

/** 代轉的 HTTP 狀態 → 給人看的訊息（PROXY.md 第 3 節）。200 不在表內。 */
const PROXY_STATUS_MSG = {
  401: '登入已失效，請重新登入',
  403: '沒有權限',
  429: '系統忙碌，請稍後再試',
  503: '系統忙碌，請稍後再試',
  504: '舊系統回應逾時，請稍後再試',
  502: '舊系統暫時無法連線',
  501: '代轉尚未啟用'
};

/**
 * 前端呼叫後端的唯一通道。
 * @param {string} backendId 'platform' | 'audit' | 'dorm'
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
export async function call(backendId, action, payload = {}) {
  const viaProxy = PROXY_NS[backendId] === true;
  const url = viaProxy ? proxyUrl() : BACKENDS[backendId];
  if (!url) {
    return { ok: false, error: `後端尚未設定：${backendId}` };
  }

  // 試跑模式（?dryrun=1）中央攔截：白名單（platform/dryrun.js）外的 action 一律不送出。
  // 拿不準的當寫入擋（往關的方向失敗）。回 ok:true 讓畫面流程走完，data.dryRun 供模組辨識。
  if (isDryRun() && !isReadAction(backendId, action, payload)) {
    notifyDryRun(backendId, action, payload);
    return { ok: true, dryrun: true, data: { dryRun: true, action, payload } };
  }

  const body = buildRequestBody_(backendId, action, payload);

  let res;
  try {
    res = await postJson_(url, body, viaProxy ? PROXY_TIMEOUT_MS : timeoutMs);
  } catch (err) {
    const timedOut = !!(err && err.name === 'AbortError');
    return {
      ok: false,
      error: timedOut ? '請求逾時，請稍後再試' : ((err && err.message) || '網路連線失敗，請稍後再試')
    };
  }

  if (viaProxy && res && typeof res.status === 'number' && res.status !== 200) {
    if (res.status === 401 && sessionExpiredHandler) {
      try { sessionExpiredHandler(); } catch { /* 處理函式出錯不影響回傳 */ }
    }
    return { ok: false, error: PROXY_STATUS_MSG[res.status] || '代轉失敗，請稍後再試', status: res.status };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: '伺服器回應格式錯誤' };
  }

  return transformResponse_(backendId, json);
}
