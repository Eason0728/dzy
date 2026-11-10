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

import { BACKENDS, homeFastAllowed } from './config.js';
import { getUser, can, getToken, getAuditScope } from './auth.js';
import { isDryRun, isReadAction, notifyDryRun, BATCH_READ_ACTIONS } from './dryrun.js';
import { routeUrl, routeUrlForNs, oldUrl, isNewHostUrl, markGatewayDown, confirmGatewayDown } from './route.js';

// 代轉逾時 35 秒：mini 對舊後端等 30 秒，再留 5 秒餘裕（PROXY.md 第 3 節）
const PROXY_TIMEOUT_MS = 35000;
// 薪酬系統（2026-10-19）：重算整月、出勤紀錄表匯出可能超過 30 秒，mini 對薪資後端等 120 秒（app.json backends.payroll.timeoutMs），這裡多留 5 秒
const PROXY_TIMEOUT_BY_NS = { payroll: 125000, pnl: 65000, transfer: 65000, attendance: 30000 };   // attendance（2026-11-06）：清單核准要等打卡 Apps Script 寫入，3～8 秒   // 損益（2026-10-24）：Apps Script 偶發卡 10 秒以上；調撥管理：mini 對調撥後端等 60 秒，多留 5 秒
// attendance＝考勤管理首頁待辦（2026-10-24，營運系統 spec §17.5）；cashbook＝收支管理（2026-10-24）；schedule＝排班管理首頁待辦（hr-move-spec §5）
const PROXY_NS = { audit: true, dorm: true, payroll: true, attendance: true, cashbook: true, schedule: true, pnl: true, transfer: true };

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
export function proxyUrl(ns) {
  const u = routeUrlForNs(BACKENDS.platform || '', ns);   // 2026-11-10：主機經 platform/route.js（櫃台／舊路／payroll 例外）
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/proxy') : '';
}

/**
 * 依 backendId 組出真正要送出的 request body。
 * @param {string} backendId
 * @param {string} action
 * @param {object} payload
 * @returns {object}
 */
/** 代轉 ns 的 payload 頂層一律剝除的欄位（見 buildRequestBody_ 說明） */
const PROXY_STRIP_FIELDS = ['operator', 'adminKey', 'admin_key', 'pin_master', 'key', 'level', 'scope', 'account'];

function buildRequestBody_(backendId, action, payload, tokenOverride) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const tok = (typeof tokenOverride === 'string') ? tokenOverride : getToken();   // 併請求時要用「排隊當下」的身分，不是送出當下

  if (backendId === 'platform') {
    // spec §4.8 的殼：{action, token, payload}。
    // token 一律由 getToken() 自動帶（2026-08-14 改）：憑證只認目前登入身分持有的那一份，
    // 不採信呼叫端 payload 裡夾帶的同名欄位。呼叫端若還是塞了 payload.token，一律丟棄。
    const rest = { ...p };
    delete rest.token;
    return { action, token: tok, payload: rest };
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
  delete rest.admin_key;   // 薪酬管理金鑰只在 mini 那邊帶（2026-10-19）
  // 2026-10-29 第二道防線（資料帶入測試）：mini 代轉層會依登入身分自己補 operator／level／account 等影子欄位、各後端金鑰
  // （adminKey／pin_master／key／scope）也只在 mini 帶。瀏覽器端沒有任何模組合法需要送這些頂層欄位（grep 過 modules/），一律剝除；巢狀同名欄位不動。
  PROXY_STRIP_FIELDS.forEach((k) => { delete rest[k]; });
  return { token: tok, ns: backendId, action, payload: rest };
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

// 稽核回傳裁切（2026-10-17 第二期：改白名單 fail closed，spec §5、§13 第 8、9 條）。
// 稽核 getAll 的 data 頂層只認：config（物件）、items／records／details／ops_records／ops_details
// （五個扁平陣列，每列有 `store` 欄，讀 ~/mala-audit/apps-script/Code.gs 確認）、dry。其餘一律刪除。
// node（= 代轉層 filterNode）可以是字串（舊後端，單店）或字串陣列（新後端，可為空陣列＝全清）。
// mini 的 apps/dzy-platform/proxy-hook.js filterResponse 是同一份語意，兩邊 fixture 逐字相同。
const AUDIT_ROW_KEYS_ = ['items', 'records', 'details', 'ops_records', 'ops_details'];
const AUDIT_CONFIG_KEYS_ = ['reasons', 'change_fund_std', 'petty_cash_std', 'accountant_ok', 'stores'];   // all_stores 含全部店清單，不在白名單（受裁切時一律刪）

/** node 是否允許這個店代碼：字串＝全等；陣列＝包含；其餘（含空字串、空陣列）＝一律不允許。比對前 String()。 */
function storeAllowed_(store, node) {
  if (store === undefined || store === null) return false;
  const s = String(store);
  if (typeof node === 'string') return node !== '' && s === node;
  if (Array.isArray(node)) return node.indexOf(s) !== -1;
  return false;
}

function filterAuditData_(data, node) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  // 信封欄位：作用在含 ok 的整包回應時保留 ok（ok:false 另留字串 error），只裁資料鍵
  if ('ok' in data) {
    out.ok = data.ok;
    if (data.ok === false && typeof data.error === 'string') out.error = data.error;
  }
  for (const key of AUDIT_ROW_KEYS_) {
    if (!(key in data)) continue;
    const val = data[key];
    out[key] = Array.isArray(val)
      ? val.filter((row) => row && typeof row === 'object' && storeAllowed_(row.store, node))
      : [];
  }
  const cfg = data.config;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const c = {};
    for (const k of AUDIT_CONFIG_KEYS_) {
      if (!(k in cfg)) continue;
      c[k] = (k === 'stores')
        ? (Array.isArray(cfg[k]) ? cfg[k].filter((r) => r && typeof r === 'object' && storeAllowed_(r.code, node)) : [])
        : cfg[k];
    }
    out.config = c;
  }
  if ('dry' in data) out.dry = data.dry;
  return out;
}

/** 測試用：直接驗裁切函式（test/filter-cases.test.mjs） */
export function __filterAuditData(data, node) {
  return filterAuditData_(data, node);
}

/**
 * 店長／同仁節點裁切（spec §7——這條寫錯等於權限是假的）。
 * 裁切依據優先序：
 *  1. 後端 login／me 回的 audit_scope（auth.js getAuditScope）：'all'＝不裁；'none'＝全清；陣列＝只看這些店。
 *  2. 沒有 audit_scope（舊後端）：沿用舊邏輯——有 `<ns>.read` 不裁；沒有 `<ns>.read.own` 也不裁（本來就進不來）；
 *     否則依 user.node 裁，node 為空一律清空（往關的方向失敗）。
 */
function maybeFilterOwnNode_(backendId, data) {
  // 稽核範圍只管稽核的回應；宿舍等其他後端原樣不動（否則稽核範圍＝none 的人會拿到被裁空的宿舍資料）
  if (backendId !== 'audit') return data;
  const scope = getAuditScope();
  if (scope === 'all') return data;
  if (scope === 'none') return filterAuditData_(data, []);
  if (Array.isArray(scope)) return filterAuditData_(data, scope);

  const hasFull = can(`${backendId}.read`);
  const hasOwn = can(`${backendId}.read.own`);
  if (hasFull || !hasOwn) return data;
  const user = getUser();
  const node = user && user.node;
  if (!node) {
    console.error(
      `[api] 使用者 ${user && user.id} 只有 ${backendId}.read.own 卻沒有所屬節點，` +
      '無法判斷該看哪一店，已回傳空資料。請到人員管理補上他的所屬節點。'
    );
    return filterAuditData_(data, []);
  }
  return filterAuditData_(data, node);
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
    // 稽核的非 ok 回應也要過一次範圍裁切（其他後端原樣；宿舍的軟性警告需要完整欄位）
    const kept = maybeFilterOwnNode_(backendId, rest);
    if (kept && Object.keys(kept).length > 0) out.data = kept;
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
  const url = (PROXY_NS[backendId] === true) ? proxyUrl(backendId) : routeUrl(BACKENDS[backendId]);
  if (!url) {
    return { ok: false, error: `後端尚未設定：${backendId}` };
  }
  // 試跑模式（?dryrun=1）中央攔截：白名單（platform/dryrun.js）外的 action 一律不送出。
  // 拿不準的當寫入擋（往關的方向失敗）。回 ok:true 讓畫面流程走完，data.dryRun 供模組辨識。
  if (isDryRun() && !isReadAction(backendId, action, payload)) {
    notifyDryRun(backendId, action, payload);
    return { ok: true, dryrun: true, data: { dryRun: true, action } };
  }
  // 首頁少等：同一輪（約 80 毫秒）發出的白名單 platform 讀取併成一次 batchRead。寫入永遠不併；開關關閉時這段完全不執行
  if (backendId === 'platform' && BATCH_READ_ACTIONS.indexOf(action) !== -1 && batchingOn_()) {
    const tok = getToken();
    if (tok) return enqueueBatch_(action, payload, tok);
  }
  return callRaw_(backendId, action, payload);
}

/**
 * 送一次。回 {res} 或 {err}；gwFail＝這次是「櫃台自己出的問題」：fetch 丟 TypeError（網路錯誤，逾時 AbortError 不算）
 * 或收到櫃台的 502 + JSON {error:'GATEWAY'}。只有打新主機時才有意義（呼叫端判斷）。
 */
async function trySend_(url, body, ms) {
  let res;
  try {
    res = await postJson_(url, body, ms);
  } catch (err) {
    const netErr = !!(err && err.name !== 'AbortError' && (err instanceof TypeError || err.name === 'TypeError'));
    return { err, gwFail: netErr, netErr };
  }
  let gwFail = false;
  if (res && res.status === 502) {
    try {
      const j = await ((typeof res.clone === 'function') ? res.clone() : res).json();
      gwFail = !!(j && j.ok === false && j.error === 'GATEWAY');
    } catch (e) { /* 不是 JSON：不是櫃台的 502 */ }
  }
  return { res, gwFail };
}

async function callRaw_(backendId, action, payload, tokenOverride) {
  const viaProxy = PROXY_NS[backendId] === true;
  const url = viaProxy ? proxyUrl(backendId) : routeUrl(BACKENDS[backendId]);
  if (!url) {
    return { ok: false, error: `後端尚未設定：${backendId}` };
  }

  const body = buildRequestBody_(backendId, action, payload, tokenOverride);
  const ms = viaProxy ? (PROXY_TIMEOUT_BY_NS[backendId] || PROXY_TIMEOUT_MS) : timeoutMs;

  let r = await trySend_(url, body, ms);
  // 櫃台故障自動改道（2026-11-10）：打新主機失敗 → 設記號（5 分鐘內之後的呼叫都走舊路）；
  // 讀取立刻改用舊主機重送一次；寫入不重送（可能已經送到），照原本錯誤訊息回畫面
  if (r.gwFail && isNewHostUrl(url)) {
    // 櫃台回 502 GATEWAY＝確定故障；網路錯誤要先確認（可能只是使用者重新整理中斷了請求，或一瞬間的網路抖動）
    const down = r.netErr ? await confirmGatewayDown() : (markGatewayDown(), true);
    if (isReadAction(backendId, action, payload)) r = await trySend_(down ? oldUrl(url) : url, body, ms);
  }
  if (r.err) {
    const err = r.err;
    const timedOut = !!(err && err.name === 'AbortError');
    return {
      ok: false,
      error: timedOut ? '請求逾時，請稍後再試' : ((err && err.message) || '網路連線失敗，請稍後再試')
    };
  }
  const res = r.res;

  if (r.gwFail && !(viaProxy && res && typeof res.status === 'number' && res.status !== 200)) {
    return { ok: false, error: PROXY_STATUS_MSG[502], status: 502 };   // 非代轉路徑收到櫃台 502：不要把 GATEWAY 原文丟給畫面
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


// ============================================================
// 首頁少等：白名單讀取併成一次 batchRead（2026-11-10）
// 後端 Mac mini 同一系統一次只處理一筆、手機到 Mac mini 每趟 1.3～2.5 秒，所以把同一輪的讀取併成一趟。
// 規則：只併 platform 的 BATCH_READ_ACTIONS（platform/dryrun.js，與後端 CODE_BATCH_READ_ACTIONS 逐字一致）；
// 寫入、代轉 ns 永遠不併；每筆在後端各自驗權限；整批失敗（逾時、舊後端不認得、格式不符）就退回逐筆送，
// 舊後端明說不支援時暫停併請求 5 分鐘（暫時性錯誤不停）。呼叫端與模組程式完全不用改。
// ============================================================

const BATCH_WINDOW_MS = 80;   // 實測（e2e mock，admin 首頁）：30ms 裂成 3 批、80ms 只要 1 批；多等 50ms 換少兩趟 1.3～2.5 秒的往返
const BATCH_MAX_ITEMS = 6;   // 每批最多 6 筆：Mac mini 一次處理一筆，整包太大會讓 badge() 5 秒逾時、全有全無；後端上限仍是 20
const BATCH_COOLDOWN_MS = 5 * 60 * 1000;
const BATCH_UNKNOWN_ACTION = '不支援的操作';   // 同 Code.gs CODE_MSG_UNKNOWN_ACTION：某筆被後端當白名單外 → 該筆退回單筆送（前後端版本差一點時不丟資料）

let homeFastOverride = null;
let batchOffUntil = 0;
let homeBatchDepth = 0;   // >0 才併：只有首頁載入期間（shell 呼叫 beginHomeBatch）；模組內頁的讀取照舊立刻送
/** token → { items: Map(key → {action, payload, waiters:[resolve]}), timer } */
const batchQueues = new Map();

/** 測試用：強制開／關首頁少等（true／false）；傳其他值還原成看開關。同時清掉排隊與冷卻。 */
export function __setHomeFast(v) {
  homeFastOverride = (v === true || v === false) ? v : null;
  batchOffUntil = 0;
  homeBatchDepth = 0;
  for (const q of batchQueues.values()) clearTimeout(q.timer);
  batchQueues.clear();
}

/**
 * shell 在首頁讀取開始時呼叫，回傳「結束」函式（可重複呼叫）。期間才會併請求；最久 30 秒自動結束（保險）。
 */
export function beginHomeBatch() {
  homeBatchDepth++;
  let done = false;
  const end = () => { if (done) return; done = true; clearTimeout(t); if (homeBatchDepth > 0) homeBatchDepth--; };
  const t = setTimeout(end, 30000);
  return end;
}

function batchingOn_() {
  if (homeBatchDepth <= 0) return false;
  if (Date.now() < batchOffUntil) return false;
  if (homeFastOverride !== null) return homeFastOverride;
  try { return homeFastAllowed(); } catch (e) { return false; }
}

function cloneJson_(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

function enqueueBatch_(action, payload, tok) {
  return new Promise((resolve) => {
    const rest = (payload && typeof payload === 'object') ? { ...payload } : {};
    delete rest.token;   // 同 buildRequestBody_：憑證只認 getToken()
    const key = action + '\u0000' + JSON.stringify(rest);
    let q = batchQueues.get(tok);
    if (q && !q.items.has(key) && q.items.size >= BATCH_MAX_ITEMS) { flushBatch_(tok); q = null; }
    if (!q) {
      q = { items: new Map(), timer: setTimeout(() => flushBatch_(tok), BATCH_WINDOW_MS) };
      batchQueues.set(tok, q);
    }
    const it = q.items.get(key);
    // 同一輪完全相同的讀取（例如 badge() 與 alerts() 都問 staffList）只送一筆，各自拿到一份副本
    if (it) it.waiters.push(resolve);
    else q.items.set(key, { action, payload: rest, waiters: [resolve] });
  });
}

function settleItem_(it, result) {
  it.waiters.forEach((w, i) => w(i === 0 ? result : cloneJson_(result)));
}

async function flushBatch_(tok) {
  const q = batchQueues.get(tok);
  if (!q) return;
  batchQueues.delete(tok);
  clearTimeout(q.timer);
  const items = [...q.items.values()];
  // 只有一筆就照原樣單筆送（不值得包 batchRead）
  const single = async (it) => settleItem_(it, await callRaw_('platform', it.action, it.payload, tok));
  if (items.length === 1) { await single(items[0]); return; }

  let results = null;
  let unsupported = false;   // 只有「後端明說不支援」才停併；斷網、逾時這類暫時錯誤下一輪照常併
  try {
    const res = await postJson_(routeUrl(BACKENDS.platform), {
      action: 'batchRead', token: tok, payload: { items: items.map((it) => ({ action: it.action, payload: it.payload })) }
    }, timeoutMs);
    if (!(res && typeof res.status === 'number' && res.status >= 400)) {
      const json = await res.json();
      if (json && json.ok === true && json.data && Array.isArray(json.data.results) && json.data.results.length === items.length) {
        results = json.data.results;
      } else if (json && json.ok === false && json.error === BATCH_UNKNOWN_ACTION) {
        unsupported = true;
      }
    } else if (res.status === 404 || res.status === 501) {
      unsupported = true;
    }
  } catch (err) { results = null; }

  if (!results) {   // 整批失敗：停併 5 分鐘、逐筆送（各筆照舊自己的逾時與錯誤）
    if (unsupported) batchOffUntil = Date.now() + BATCH_COOLDOWN_MS;
    await Promise.all(items.map(single));
    return;
  }
  await Promise.all(items.map(async (it, i) => {
    const r = results[i];
    if (r && r.ok === false && r.error === BATCH_UNKNOWN_ACTION) { await single(it); return; }
    settleItem_(it, transformResponse_('platform', r));
  }));
}
