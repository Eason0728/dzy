/**
 * platform/auth.js — 身分層：登入、session、can(權限碼)
 *
 * 正本規格：docs/spec.md §4.2（權限碼格式）、§4.3（角色/權限對照）、
 * §4.4（節點代號）、§4.7（ctx 形狀）、§5.2（後端 login/me 回什麼）、
 * §6.1（開機流程）、§6.3（通行碼代管＝Mac mini 代轉）。
 *
 * 這一層判斷錯，整個系統的權限就是假的，所以規則寫死在這裡、不接受任何模組覆寫：
 *
 * 【儲存規則（安全相關）】
 * - token：存 localStorage。後端簽的是 7 天效期的無狀態 token（spec §5.3），
 *   前端只是原樣保存/取出，效期由後端 me 驗證，不在前端重算。
 * - 既有系統（稽核／宿舍）的通行碼：2026-10-12 起**瀏覽器完全拿不到**——
 *   login／me 不再回 secrets，api.js 改打 Mac mini 的 /platform/proxy 由 mini 代帶（spec §6.3）。
 *   本檔不存、也不接受任何通行碼。
 * - logout()：同時清 localStorage 的 token 與記憶體裡的 user／perms。
 *
 * 【can(perm) 規則（spec §4.2）】
 * - 持有 '*'（僅 admin）→ 任何 perm 都 true。
 * - 完全字串相符 → true。
 * - 絕不用 startsWith / 前綴比對 —— audit.read 與 audit.read.own 是兩個完全獨立的
 *   權限碼，互不相等、互不包含（否則 audit.read 會誤放行 audit.readonly 這種形似字串）。
 *
 * 【後端還沒完成，所以要能 mock 測】
 * 實際打網路的邏輯收在 defaultTransport()，可用 __setTransport() 換成假的呼叫函式，
 * 測試（test/perm.test.mjs）一律走注入的假 transport，不真的發 HTTP 請求。
 */

'use strict';

/** localStorage 存 token 用的 key */
const TOKEN_STORAGE_KEY = 'dzy.token';
/** 離線登出沒送到後端時，暫存「那一個」舊 token，下次開頁補送 logout（GPT 複審第 3 條，2026-10-12） */
export const PENDING_LOGOUT_KEY = 'dzy.pendingLogout';
/** 認得的手機（2026-10-25 全資料審查 MB-03）：後端登入成功時發的手機憑證，按帳號存 {帳號小寫: 憑證}。
 *  帶著它登入，別人換來源把帳號整個鎖住時本人照樣進得來（密碼照樣要對）。登出不清（認的是手機，不是這次登入）。
 *  店裡公用手機多人輪流登入：各帳號各一張，互不覆蓋；最多留 DEVICE_MAX 個帳號，超過丟最舊的。 */
export const DEVICE_STORAGE_KEY = 'dzy.device';
const DEVICE_MAX = 20;

// 平台後端網址一律取自 config.js，這裡不留第二份。
// 2026-08-14 踩過的雷：本檔原本自帶 `const BACKEND_URL = ''`（寫的時候後端還沒部署，
// 留了「之後填」的註解），部署後沒人回來填。fetch('') 會打到目前這個頁面本身、拿回 index.html，
// 於是 JSON.parse 收到 '<!DOCTYPE' 而爆掉。單元測試抓不到，因為測試注入的是假 transport。
// 教訓：設定值只能有一份正本；「之後再填」的空字串等於一顆定時炸彈。
import { BACKENDS } from './config.js';
import { isDryRun, isReadAction, notifyDryRun, DRYRUN_MESSAGE } from './dryrun.js';

// ============================================================
// 記憶體狀態
// ============================================================
let currentUser = null; // { id, name, role, node } | null
let currentAuditScope = null; // 後端 login／me 回的 audit_scope：'all'｜'none'｜字串陣列；沒回＝null（退回舊的 node 判斷）
let currentPerms = []; // string[]，可能含 '*'
let currentToken = null; // 記憶體快取的 token（來源仍是 localStorage）

// ============================================================
// transport：實際打後端的函式，測試可注入假的（不要真的打網路）
// ============================================================

/**
 * 送出格式照 spec §4.8：{"action":..., "token":..., "payload":{...}}
 * 回傳格式：{ok:true, data:{...}} 或 {ok:false, error:"..."}
 */
async function defaultTransport(requestBody) {
  const url = BACKENDS.platform;
  if (!url) {
    return { ok: false, error: '尚未設定平台後端網址（platform/config.js）', transient: true };
  }

  // 逾時 45 秒（2026-08-17 由 15 秒放寬，Eason 在手機上實際踩到「連線逾時」）。
  // 為什麼登入天生就慢：後端每次驗密碼要跑 AUTH_HASH_ITERATIONS=10000 次 SHA-256
  //（spec §5.6，刻意加重以防暴力破解），在 Apps Script 上就是好幾秒；加上 Google 的
  // 轉址與行動網路來回，很容易頂到 15 秒。那個上限一開始是照「一般 API」的直覺定的，
  // 沒有考慮這條路徑本來就重。
  // 不能改成降低雜湊次數——既有帳號的 hash 都是用 10000 次算的，改了全部人都登不進來。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (err) {
    // transient：不是後端的判定（連線失敗／逾時），restore() 看到就保留 token（2026-10-28 審查 #9）
    return { ok: false, error: (err && err.name === 'AbortError') ? '連線逾時，請稍後再試' : '連線失敗，請檢查網路', transient: true };
  } finally {
    clearTimeout(timer);
  }

  // 後端理應回 JSON；收到 HTML（Google 的錯誤頁或轉址頁）時不要把解析錯誤丟給使用者看——
  // 那種訊息（Unexpected token '<'）對現場的人完全沒有意義。
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: '伺服器回應格式錯誤，請稍後再試', transient: true };
  }
}

let transport = defaultTransport;

/** 測試用：注入假的 transport 函式，簽章同 defaultTransport。傳非函式則還原成預設。 */
export function __setTransport(fn) {
  transport = typeof fn === 'function' ? fn : defaultTransport;
}

// ============================================================
// localStorage 存取：只用來存 token；任何環境沒有 localStorage
// （例如非瀏覽器環境）就靜默退化，不拋錯把呼叫方炸掉
// ============================================================

function readTokenFromStorage() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function writeTokenToStorage(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* localStorage 不可用（例如無痕模式關閉儲存）就放棄持久化，
       登入狀態退化成只在本次頁面存活，不影響當下操作 */
  }
}

function readDeviceMap() {
  try {
    const m = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || '{}');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function readDevice(username) {
  const v = readDeviceMap()[String(username || '').trim().toLowerCase()];
  return typeof v === 'string' ? v : '';
}

function writeDevice(username, device) {
  if (typeof device !== 'string' || !device) return;
  const key = String(username || '').trim().toLowerCase();
  if (!key) return;
  const m = readDeviceMap();
  delete m[key];
  m[key] = device;   // 重新放到最後＝最新
  const keys = Object.keys(m);
  keys.slice(0, Math.max(0, keys.length - DEVICE_MAX)).forEach((k) => { delete m[k]; });
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* 存不了就算了：只是少了「認得的手機」，登入照常 */
  }
}

/** 憑證屬於哪個使用者 id（只解開 payload 看 d，不驗簽章：驗章在後端）；解不開回 '' */
function deviceUserId(device) {
  try {
    const part = String(device).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(part + '==='.slice((part.length + 3) % 4))));
    const d = JSON.parse(json).d;
    return typeof d === 'string' ? d : '';
  } catch {
    return '';
  }
}

/** 改密碼後舊憑證會失效：把這個使用者在本機的憑證換成後端新發的（找不到就不動，下次登入成功自然會存） */
function replaceDeviceForUser(userId, device) {
  if (!userId || typeof device !== 'string' || !device) return;
  const m = readDeviceMap();
  const key = Object.keys(m).find((k) => deviceUserId(m[k]) === String(userId));
  if (key) writeDevice(key, device);
}

function clearTokenFromStorage() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* 同上，靜默即可 */
  }
}

// ============================================================
// session 狀態的套用／清除（login 與 restore 共用）
// ============================================================

/** @param {{token?:string, user:object, perms:string[]}} data（後端舊版若仍夾帶 secrets，一律忽略） */
function applySession(data) {
  if (data && typeof data.token === 'string' && data.token) {
    currentToken = data.token;
  }
  currentUser = (data && data.user) || null;
  currentPerms = Array.isArray(data && data.perms) ? data.perms.slice() : [];
  const sc = data && data.audit_scope;
  currentAuditScope = (sc === 'all' || sc === 'none') ? sc : (Array.isArray(sc) ? sc.map(String) : null);
}

function clearSession() {
  currentUser = null;
  currentAuditScope = null;
  currentPerms = [];
  currentToken = null;
}

// ============================================================
// 對外 API
// ============================================================

/**
 * 登入。
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function login(username, password) {
  // 先補送上次沒送到的登出（成功才刪）：要在 login 之前，否則補送的 logout 會把這次新簽的 token 一起撤掉
  await flushPendingLogout();
  let res;
  try {
    const payload = { username, password };
    const device = readDevice(username);
    if (device) payload.device = device;
    res = await transport({ action: 'login', token: '', payload });
  } catch (err) {
    return { ok: false, error: (err && err.message) || '網路連線失敗，請稍後再試' };
  }

  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || '登入失敗' };
  }

  const data = res.data || {};
  if (!data.token || !data.user) {
    return { ok: false, error: '伺服器回應格式錯誤' };
  }

  applySession(data);
  writeTokenToStorage(data.token);
  writeDevice(username, data.device);
  return { ok: true };
}

/**
 * 開機還原：讀 localStorage 的 token，打 me 換最新身分（spec §6.1 step 2）。
 * 沒有 token、或 token 已失效 → 清乾淨並回 false，呼叫方（shell.js）改顯示登入頁。
 * 連線失敗／逾時／格式錯誤（transient）→ 保留 token、回 false。
 * @returns {Promise<boolean>}
 */
export async function restore() {
  // 開頁先在背景補送上次沒送到的登出（不擋開機；成功才刪）
  lastFlush = flushPendingLogout();
  const token = readTokenFromStorage();
  if (!token) return false;

  let res;
  try {
    res = await transport({ action: 'me', token, payload: {} });
  } catch {
    return false;
  }

  if (!res || res.ok !== true || !res.data || !res.data.user) {
    // 只有後端明確判定 token 失效才清；連線失敗、逾時、格式錯誤、後端忙碌都保留 token（下次開頁再試，不用重新登入；2026-10-28 審查 #9）
    if (isTokenRejected(res)) clearTokenFromStorage();
    clearSession();
    return false;
  }

  applySession({ token, ...res.data });
  return true;
}

/** 後端對 me 明確說「這個 token 不能用」的錯誤（Auth.gs AUTH_MSG_INVALID_TOKEN／AUTH_MSG_DISABLED 等，逐字） */
const TOKEN_REJECTED_ERRORS = ['登入已失效，請重新登入', '帳號已停用', '此帳號不在同仁名單，請聯絡人資', 'unauthorized'];
function isTokenRejected(res) {
  if (!res || typeof res !== 'object' || res.transient === true || res.ok === true) return false;
  return TOKEN_REJECTED_ERRORS.indexOf(String(res.error || '')) !== -1 || res.code === 'unauthorized';
}

/** 登出後端的等待上限（毫秒）：逾時就不等了，照樣清本機 */
const LOGOUT_TIMEOUT_MS = 5000;

/**
 * 登出（2026-10-12 Eason：登出＝全部裝置一起登出）。
 * 先呼叫後端 logout（把這個帳號的 token_after 設成現在，所有裝置上的舊登入一起失效），
 * 等到回應或 5 秒逾時——不管成功、失敗、斷網、逾時——都再清本機：
 * localStorage 的 token、記憶體裡的 user／perms。
 * 試跑模式（?dryrun=1）也照樣送出：登出不是資料寫入（dryrun.js 白名單已放行 logout）。
 * 呼叫端（shell.js doLogout）要 await 這支，等它回來才整頁重載。
 * @returns {Promise<void>}
 */
export async function logout() {
  const token = getToken();
  if (token) {
    const res = await sendLogout(token);
    // 斷網／逾時／伺服器忙：其他裝置還沒被撤銷 → 記下這一個 token，下次開頁補送（只存這一個，不存其他東西）
    if (!isLogoutSettled(res)) writePendingLogout(token);
  }
  clearTokenFromStorage();
  clearSession();
}

/** 送一次 logout，最多等 LOGOUT_TIMEOUT_MS；逾時或丟錯回 null */
async function sendLogout(token) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => transport({ action: 'logout', token, payload: {} })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), LOGOUT_TIMEOUT_MS); })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 後端「確定處理過了」：ok:true（已撤銷），或後端明確說這個 token 已失效／帳號已停用（再送也沒用）。
 * 其他（逾時 null、連線失敗、回應格式錯、RATE_LIMIT、BUSY…）都算沒送到，要補送。
 */
const LOGOUT_SETTLED_ERRORS = ['登入已失效，請重新登入', '帳號已停用'];
function isLogoutSettled(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.ok === true) return true;
  return LOGOUT_SETTLED_ERRORS.indexOf(String(res.error || '')) !== -1;
}

function readPendingLogout() {
  try { return localStorage.getItem(PENDING_LOGOUT_KEY) || ''; } catch { return ''; }
}
function writePendingLogout(token) {
  try { localStorage.setItem(PENDING_LOGOUT_KEY, String(token)); } catch { /* 存不了就算了 */ }
}
function clearPendingLogout(token) {
  try {
    // 只刪「剛剛送成功的那一個」：送的期間若又寫了別的 token，留著下次補送
    if (localStorage.getItem(PENDING_LOGOUT_KEY) === token) localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch { /* 忽略 */ }
}

let lastFlush = Promise.resolve(false);
/** 測試用：restore() 在背景補送的那個 Promise */
export function __lastFlush() { return lastFlush; }

/**
 * 補送上次沒送到後端的登出（dzy.pendingLogout）。成功（或後端明確說 token 已失效）才刪；
 * 失敗留著，下次開頁再送。回 true＝這次處理掉了。
 * @returns {Promise<boolean>}
 */
export async function flushPendingLogout() {
  const token = readPendingLogout();
  if (!token) return false;
  const res = await sendLogout(token);
  if (!isLogoutSettled(res)) return false;
  clearPendingLogout(token);
  return true;
}

/** @returns {'all'|'none'|string[]|null} 後端給的稽核範圍；沒給（舊後端）回 null */
export function getAuditScope() {
  return Array.isArray(currentAuditScope) ? currentAuditScope.slice() : currentAuditScope;
}

/** @returns {{id:string, name:string, role:string, node:string}|null} 未登入回 null */
export function getUser() {
  return currentUser ? { ...currentUser } : null;
}

/**
 * 權限判斷（spec §4.2、任務指示第 3 點——這裡最容易寫錯，規則見檔頭）。
 * @param {string} perm
 * @returns {boolean}
 */
export function can(perm) {
  if (!currentUser) return false;
  if (typeof perm !== 'string' || perm === '') return false;
  // platform.login＝「已登入」本身：每個登入者都有，不寫進 roles 分頁（公告專區用，2026-10-16）
  if (perm === 'platform.login') return true;
  if (currentPerms.indexOf('*') !== -1) return true;
  return currentPerms.indexOf(perm) !== -1;
}

/**
 * 目前 session 的 token（給 api.js 呼叫平台後端時自動帶上，模組不該直接用到它）。
 *
 * 為什麼要有這支（2026-08-14 整合時補；2026-10-12 起代轉也用它）：既有系統的通行碼當時是由 api.js 自動帶的，
 * 平台後端的 token 卻要呼叫端自己塞進 payload——兩套規則不一致，模組作者遲早會忘記帶而收到
 * 「登入已失效」，那種錯誤訊息完全指不到真正的原因。統一成「兩者都由 api.js 自動帶」。
 *
 * @returns {string} 沒有就回空字串
 */
export function getToken() {
  return currentToken || readTokenFromStorage() || '';
}

/**
 * 登入過期（2026-10-12）：代轉回 401（token 失效／帳號停用）時由 shell 呼叫。
 * 只清本機（localStorage 的 token、記憶體的 user／perms），**不打後端 logout**——
 * token 已經失效，再打 logout 沒有意義；也不能讓一次過期把這個人其他裝置一起登出。
 */
export function expireLocal() {
  clearTokenFromStorage();
  clearSession();
}

/**
 * 本人修改自己的密碼（2026-08-17，Eason 指定「同仁可自己改密碼」）。
 *
 * 與人員管理的「重設密碼」是兩件事：那是 admin 幫別人重設（要 platform.users 權限、
 * 不驗舊密碼）；這支是本人改自己的，**任何登入者都能用，但一定要驗舊密碼**。
 * 身分完全由 token 決定——前端不送 id，後端也只認 token 裡的身分（見 Users.gs §5b），
 * 所以沒有「改到別人密碼」這條路。
 *
 * 成功後 session 不變（token 未失效、不必重新登入）；下次登入才用新密碼。
 *
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function changePassword(oldPassword, newPassword) {
  if (isDryRun()) {
    notifyDryRun('platform', 'changePassword', {});
    return { ok: false, dryrun: true, error: DRYRUN_MESSAGE };
  }
  let res;
  try {
    res = await transport({
      action: 'changePassword',
      token: getToken(),
      payload: { oldPassword, newPassword }
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || '網路連線失敗，請稍後再試' };
  }
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || '修改失敗' };
  }
  // 2026-10-11：後端改完密碼會撤銷所有舊 token（其他裝置登出）並換發一張新的給這台，換上才不會被登出
  if (res.data && typeof res.data.token === 'string' && res.data.token) {
    currentToken = res.data.token;
    writeTokenToStorage(res.data.token);
  }
  if (res.data && currentUser) replaceDeviceForUser(currentUser.id, res.data.device);   // 認得的手機（2026-10-25）
  return { ok: true };
}

/**
 * 登入前的平台呼叫（2026-10-11 個人帳號管理：orgOptions／claimLookup／forgotReset）。
 * 不帶 token；回傳形狀同後端 {ok,data}|{ok:false,error}，斷網收斂成 {ok:false}。
 * @param {string} action
 * @param {object} payload
 */
export async function publicCall(action, payload) {
  if (isDryRun() && !isReadAction('platform', action, payload)) {
    notifyDryRun('platform', action, {});
    return { ok: false, dryrun: true, error: DRYRUN_MESSAGE };
  }
  try {
    const res = await transport({ action, token: '', payload: payload || {} });
    return res && typeof res === 'object' ? res : { ok: false, error: '伺服器回應格式錯誤' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '網路連線失敗，請稍後再試' };
  }
}

/**
 * 第一次使用：送出認領表單。
 * 2026-10-12 Eason：認領只是核對編號，送出後要等單位主管審核通過才開通——
 * 後端不再回 token，這裡也**不登入、不存任何東西**，只回 {ok:true, pending:true}。
 * 密碼只經過這個函式的參數交給 transport，不留副本。
 */
export async function claimSubmit(payload) {
  const res = await publicCall('claimSubmit', payload);
  if (!res || res.ok !== true) {
    return res && res.dryrun ? { ok: false, dryrun: true, error: res.error } : { ok: false, error: (res && res.error) || '送出失敗' };
  }
  return { ok: true, pending: true };
}
