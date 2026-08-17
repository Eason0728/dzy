/**
 * platform/auth.js — 身分層：登入、session、can(權限碼)
 *
 * 正本規格：docs/spec.md §4.2（權限碼格式）、§4.3（角色/權限對照）、
 * §4.4（節點代號）、§4.7（ctx 形狀）、§5.2（後端 login/me 回什麼）、
 * §6.1（開機流程）、§6.3（平台代管通行碼）。
 *
 * 這一層判斷錯，整個系統的權限就是假的，所以規則寫死在這裡、不接受任何模組覆寫：
 *
 * 【儲存規則（安全相關）】
 * - token：存 localStorage。後端簽的是 7 天效期的無狀態 token（spec §5.3），
 *   前端只是原樣保存/取出，效期由後端 me 驗證，不在前端重算。
 * - secrets（既有系統的通行碼，spec §6.3）：**只存在這個模組的記憶體變數**，
 *   絕對不寫進 localStorage／sessionStorage／cookie／DOM。重新整理就靠 restore()
 *   重新用 token 換一次，這是刻意的設計（降低外洩面，見 spec §6.3）。
 * - logout()：同時清 localStorage 的 token，
 *   以及記憶體裡的 user／perms／通行碼（secrets 那份記憶體狀態）。
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

// 平台後端網址一律取自 config.js，這裡不留第二份。
// 2026-08-14 踩過的雷：本檔原本自帶 `const BACKEND_URL = ''`（寫的時候後端還沒部署，
// 留了「之後填」的註解），部署後沒人回來填。fetch('') 會打到目前這個頁面本身、拿回 index.html，
// 於是 JSON.parse 收到 '<!DOCTYPE' 而爆掉。單元測試抓不到，因為測試注入的是假 transport。
// 教訓：設定值只能有一份正本；「之後再填」的空字串等於一顆定時炸彈。
import { BACKENDS } from './config.js';

// ============================================================
// 記憶體狀態 —— secrets 永遠、只、活在這裡，不落地
// ============================================================
let currentUser = null; // { id, name, role, node } | null
let currentPerms = []; // string[]，可能含 '*'
let secrets = {}; // { [backendId]: secret } —— 絕不寫進任何持久化儲存
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
    return { ok: false, error: '尚未設定平台後端網址（platform/config.js）' };
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
    return { ok: false, error: (err && err.name === 'AbortError') ? '連線逾時，請稍後再試' : '連線失敗，請檢查網路' };
  } finally {
    clearTimeout(timer);
  }

  // 後端理應回 JSON；收到 HTML（Google 的錯誤頁或轉址頁）時不要把解析錯誤丟給使用者看——
  // 那種訊息（Unexpected token '<'）對現場的人完全沒有意義。
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: '伺服器回應格式錯誤，請稍後再試' };
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

/** @param {{token?:string, user:object, perms:string[], secrets?:object}} data */
function applySession(data) {
  if (data && typeof data.token === 'string' && data.token) {
    currentToken = data.token;
  }
  currentUser = (data && data.user) || null;
  currentPerms = Array.isArray(data && data.perms) ? data.perms.slice() : [];
  secrets = (data && data.secrets && typeof data.secrets === 'object') ? { ...data.secrets } : {};
}

function clearSession() {
  currentUser = null;
  currentPerms = [];
  secrets = {};
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
  let res;
  try {
    res = await transport({ action: 'login', token: '', payload: { username, password } });
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
  return { ok: true };
}

/**
 * 開機還原：讀 localStorage 的 token，打 me 換最新身分（spec §6.1 step 2）。
 * 沒有 token、或 token 已失效 → 清乾淨並回 false，呼叫方（shell.js）改顯示登入頁。
 * @returns {Promise<boolean>}
 */
export async function restore() {
  const token = readTokenFromStorage();
  if (!token) return false;

  let res;
  try {
    res = await transport({ action: 'me', token, payload: {} });
  } catch {
    return false;
  }

  if (!res || res.ok !== true || !res.data || !res.data.user) {
    clearTokenFromStorage();
    clearSession();
    return false;
  }

  applySession({ token, ...res.data });
  return true;
}

/** 登出：清 localStorage 的 token，
 *  也清記憶體裡的 user／perms／通行碼（secrets 那份記憶體狀態）。 */
export function logout() {
  clearTokenFromStorage();
  clearSession();
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
  if (currentPerms.indexOf('*') !== -1) return true;
  return currentPerms.indexOf(perm) !== -1;
}

/**
 * 拿既有系統的通行碼（spec §6.3），只存在記憶體。
 * @param {string} backendId 例：'audit'、'dorm'
 * @returns {string} 拿不到回空字串
 */
/**
 * 目前 session 的 token（給 api.js 呼叫平台後端時自動帶上，模組不該直接用到它）。
 *
 * 為什麼要有這支（2026-08-14 整合時補）：既有系統的通行碼是由 api.js 自動帶的，
 * 平台後端的 token 卻要呼叫端自己塞進 payload——兩套規則不一致，模組作者遲早會忘記帶而收到
 * 「登入已失效」，那種錯誤訊息完全指不到真正的原因。統一成「兩者都由 api.js 自動帶」。
 *
 * @returns {string} 沒有就回空字串
 */
export function getToken() {
  return currentToken || readTokenFromStorage() || '';
}

export function getSecret(backendId) {
  if (!backendId) return '';
  return secrets[backendId] || '';
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
  return { ok: true };
}
