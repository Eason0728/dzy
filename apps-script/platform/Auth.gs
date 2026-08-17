/**
 * 鼎兆元管理系統｜平台後端 — 身分驗證（T1-4）
 * 對應 docs/spec.md §4.2 權限碼／§4.3 角色／§4.4 節點／§5.1 試算表／§5.2 API／§5.3 token 格式。
 *
 * 本檔只依賴 Setup.gs 已建立好的四個分頁（users／roles／module_secrets／login_log）與其欄序，
 * 不重新宣告 Setup.gs 已有的頂層常數（TAB_USERS／HEADERS…），避免兩個檔案部署在同一個
 * Apps Script 專案時撞名（GAS 的 const 在同一專案內跨檔共用同一個全域作用域，撞名會直接
 * 在執行期報錯）。因此下面的分頁名稱／欄序常數刻意用不同名字獨立宣告一份。
 *
 * ⚠ 密碼明碼、salt、hash、既有系統通行碼、HMAC 金鑰，一律不得寫死在本檔或任何 repo 內的檔案，
 *   一律從試算表或 Script Properties 讀取。
 *
 * 之後 T1-5（Code.gs）會把 doPost 收到的 action 分派到本檔的 handleLogin_ / handleMe_。
 */

// ── 分頁名稱與欄序（沿用 Setup.gs 的既有結構，見該檔 HEADERS）──────────
var AUTH_SHEET_USERS = 'users';
var AUTH_SHEET_ROLES = 'roles';
var AUTH_SHEET_SECRETS = 'module_secrets';
var AUTH_SHEET_LOG = 'login_log';

// users 分頁欄序（spec §5.1，逐字元、0-based index）
var AUTH_USERS_COL = {
  id: 0, username: 1, name: 2, role: 3, node: 4,
  salt: 5, hash: 6, active: 7, created_at: 8, last_login_at: 9
};
var AUTH_USERS_COL_COUNT = 10;

// ── 參數 ─────────────────────────────────────────────────────────────
var AUTH_HASH_ITERATIONS = 10000;           // spec §5.6：SHA-256 迭代 10,000 次
var AUTH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // spec §5.3：token 有效期 7 天
var AUTH_LOGIN_FAIL_LIMIT = 3;              // spec §5.2：連續失敗 3 次鎖定（Eason 2026-08-14 由 5 改為 3）
var AUTH_LOGIN_LOCK_SECONDS = 15 * 60;      // spec §5.2：鎖 15 分鐘

// login_log 允許的 result 值（spec §5.1，逐字元，不得自創）
var AUTH_LOG_OK = 'ok';
var AUTH_LOG_BAD_PASSWORD = 'bad_password';
var AUTH_LOG_LOCKED = 'locked';
var AUTH_LOG_DISABLED = 'disabled';

// 回前端的錯誤訊息。只有鎖定訊息是 spec 逐字規定，其餘文字可自訂。
var AUTH_MSG_LOCKED = '嘗試次數過多，請 15 分鐘後再試'; // spec §5.2 逐字
var AUTH_MSG_BAD_PASSWORD = '帳號或密碼錯誤';
var AUTH_MSG_DISABLED = '帳號已停用';
var AUTH_MSG_INVALID_TOKEN = '登入已失效，請重新登入';

// ============================================================
// 1. 密碼雜湊（spec §5.6）
// ============================================================

/**
 * hashPassword_(pw, salt) → base64 字串
 * SHA-256 迭代 10,000 次：第一輪對 "salt:pw" 取雜湊，之後每一輪對前一輪的位元組結果再取雜湊。
 * 用冒號分隔 salt 與 pw，避免 salt="ab",pw="c" 與 salt="a",pw="bc" 在無分隔時算出同一組輸入。
 */
function hashPassword_(pw, salt) {
  var algo = Utilities.DigestAlgorithm.SHA_256;
  var digest = Utilities.computeDigest(algo, String(salt) + ':' + String(pw));
  for (var i = 1; i < AUTH_HASH_ITERATIONS; i++) {
    digest = Utilities.computeDigest(algo, digest);
  }
  return Utilities.base64Encode(digest);
}

// ============================================================
// 2. token 簽發／驗證（spec §5.3，格式：base64url(payload).base64url(hmac_sha256(payload, SECRET))）
// ============================================================

/** HMAC 金鑰只從 Script Properties 讀，讀不到就丟錯——不得有預設值寫死在程式裡 */
function getHmacSecret_() {
  var secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!secret) {
    throw new Error('HMAC_SECRET 未設定（Script Properties），無法簽發／驗證 token');
  }
  return secret;
}

function stringToBytes_(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  return bytes;
}

/** byte[] → 字串。computeDigest／base64Decode 回傳的可能是帶正負號的位元組，統一轉回 0-255 */
function bytesToString_(bytes) {
  var chars = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    chars.push(String.fromCharCode(b < 0 ? b + 256 : b));
  }
  return chars.join('');
}

/** 標準 base64 → base64url：+→-、/→_，去掉尾端補位的 = */
function toBase64Url_(data) {
  var b64 = Utilities.base64Encode(data);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → byte[]：補回 = 再用標準 base64Decode */
function fromBase64UrlToBytes_(str) {
  var b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return Utilities.base64Decode(b64);
}

/** 對任意 payload 物件簽出 token 字串（issueToken_ 與測試用的過期 token 都靠這個） */
function signPayload_(payload) {
  var payloadPart = toBase64Url_(stringToBytes_(JSON.stringify(payload)));
  var sigBytes = Utilities.computeHmacSha256Signature(payloadPart, getHmacSecret_());
  var sigPart = toBase64Url_(sigBytes);
  return payloadPart + '.' + sigPart;
}

/** issueToken_(user) — user = {id, role, node}；payload 逐字照 spec §5.3：{u,r,n,e} */
function issueToken_(user) {
  var nowSec = Math.floor(Date.now() / 1000);
  var payload = { u: user.id, r: user.role, n: user.node, e: nowSec + AUTH_TOKEN_TTL_SECONDS };
  return signPayload_(payload);
}

/**
 * verifyToken_(t) → 驗證通過回傳解出的 payload 物件（{u,r,n,e}）；
 * 格式錯誤／簽章不符／過期，一律回 false。竄改 payload 或竄改簽章都會讓簽章比對失敗。
 */
function verifyToken_(t) {
  if (typeof t !== 'string') return false;
  var dot = t.indexOf('.');
  if (dot === -1 || t.indexOf('.', dot + 1) !== -1) return false; // 必須剛好一個點
  var payloadPart = t.slice(0, dot);
  var sigPart = t.slice(dot + 1);
  if (!payloadPart || !sigPart) return false;

  var expectedSig;
  try {
    expectedSig = toBase64Url_(Utilities.computeHmacSha256Signature(payloadPart, getHmacSecret_()));
  } catch (e) {
    return false;
  }
  if (expectedSig !== sigPart) return false; // 簽章被竄改，或 payload 被竄改導致簽章對不上

  var payload;
  try {
    payload = JSON.parse(bytesToString_(fromBase64UrlToBytes_(payloadPart)));
  } catch (e) {
    return false;
  }
  if (!payload || typeof payload.e !== 'number') return false;

  var nowSec = Math.floor(Date.now() / 1000);
  if (payload.e < nowSec) return false; // 過期

  return payload;
}

// ============================================================
// 3. 權限（spec §4.2／§4.3）
// ============================================================

/** hasPerm_(perms, need) — 精確比對，'*' 萬用；不得用前綴比對（audit.read.own ≠ audit.read）*/
function hasPerm_(perms, need) {
  if (!Array.isArray(perms)) return false;
  if (perms.indexOf('*') !== -1) return true;
  return perms.indexOf(need) !== -1;
}

/** 查 roles 分頁，把 perms 欄（逗號分隔，或 '*'）展開成陣列 */
function getRolePerms_(role) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_ROLES);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === role) {
      var raw = String(rows[i][2] || '').trim();
      if (!raw) return [];
      if (raw === '*') return ['*'];
      return raw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    }
  }
  return [];
}

/**
 * pickSecrets_(perms) → {backend_id: secret}（spec §5.2）
 * 依 module_secrets 分頁動態列出出現過的 backend_id，逐一判斷：
 *   有 <backend_id>.write → 要 level=write 的碼；否則有 <backend_id>.read 或 .read.own → 要 level=read 的碼；
 *   都沒有 → 不下發這個後端；查不到對應 level 的那一列，也不下發。
 */
function pickSecrets_(perms) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_SECRETS);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  var byBackend = {};
  rows.forEach(function (r) {
    var backendId = String(r[0] || '').trim();
    var level = String(r[1] || '').trim();
    if (!backendId || !level) return;
    if (!byBackend[backendId]) byBackend[backendId] = {};
    byBackend[backendId][level] = r[2];
  });

  var out = {};
  Object.keys(byBackend).forEach(function (backendId) {
    var levels = byBackend[backendId];
    var wantLevel = null;
    if (hasPerm_(perms, backendId + '.write')) {
      wantLevel = 'write';
    } else if (hasPerm_(perms, backendId + '.read') || hasPerm_(perms, backendId + '.read.own')) {
      wantLevel = 'read';
    }
    if (!wantLevel) return;
    var secret = levels[wantLevel];
    if (secret === undefined || secret === null || secret === '') return;
    // 2026-08-17 修（Eason 實際踩到「店長看稽核＝通行碼錯誤」）：
    // 試算表儲存格若是**純數字**的通行碼，getValues() 回來的是 number 不是 string。
    // 既有兩支後端都用嚴格比對（稽核 Code.gs resolveRole_ 的 `code === settings.viewerCode`、
    // 宿舍 Api.gs 的 requireAdmin），而它們那邊是 String(...) 過的——
    // number 123456 永遠不會等於 string '123456'，於是通行碼「明明填對了卻一直錯」。
    // 一律轉字串並去掉前後空白（貼上時很容易多一個空格，同樣是肉眼看不出來的錯）。
    var normalized = String(secret).trim();
    if (!normalized) return;
    out[backendId] = normalized;
  });
  return out;
}

// ============================================================
// 4. 登入失敗鎖定
//    狀態存 CacheService（非 ScriptProperties）：鎖定本質是「15 分鐘後自動失效」的暫時狀態，
//    CacheService.put(key, value, ttlSeconds) 內建 TTL，時間一到自動消失，不必另外寫清除邏輯；
//    ScriptProperties 沒有 TTL，得自己存時間戳、每次都手動判斷還要手動清，久了會累積一堆
//    過期但沒人清的 key。內部系統少量帳號，CacheService 的「盡力保存、非保證持久」特性可接受。
// ============================================================

function authLoginStateKey_(username) {
  return 'auth_login_state:' + username;
}

function getLoginState_(username) {
  var raw = CacheService.getScriptCache().get(authLoginStateKey_(username));
  if (!raw) return { count: 0, lockedUntil: 0 };
  try {
    var parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, lockedUntil: Number(parsed.lockedUntil) || 0 };
  } catch (e) {
    return { count: 0, lockedUntil: 0 };
  }
}

function setLoginState_(username, state, ttlSeconds) {
  CacheService.getScriptCache().put(authLoginStateKey_(username), JSON.stringify(state), ttlSeconds);
}

function clearLoginState_(username) {
  CacheService.getScriptCache().remove(authLoginStateKey_(username));
}

/** 記一次失敗：次數到 5 才寫入 lockedUntil；TTL 用鎖定秒數，超過這段時間沒再失敗就自然重置 */
function recordLoginFailure_(username, state) {
  var count = (state.count || 0) + 1;
  var nowSec = Math.floor(Date.now() / 1000);
  var next = { count: count, lockedUntil: count >= AUTH_LOGIN_FAIL_LIMIT ? nowSec + AUTH_LOGIN_LOCK_SECONDS : 0 };
  setLoginState_(username, next, AUTH_LOGIN_LOCK_SECONDS);
}

// ============================================================
// 5. 使用者查詢／更新
// ============================================================

function isActiveValue_(v) {
  if (v === true) return true;
  return String(v).trim().toUpperCase() === 'TRUE';
}

function readUsersRows_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_USERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), AUTH_USERS_COL_COUNT);
  return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
}

function findUserRow_(username) {
  var rows = readUsersRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][AUTH_USERS_COL.username]) === username) return { row: i + 2, values: rows[i] };
  }
  return null;
}

function findUserById_(id) {
  var rows = readUsersRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][AUTH_USERS_COL.id]) === String(id)) return { row: i + 2, values: rows[i] };
  }
  return null;
}

/** 對外只回這四欄（spec §4.7 ctx.user 的形狀），username／salt／hash／active 一律不外流 */
function rowToUser_(values) {
  return {
    id: values[AUTH_USERS_COL.id],
    username: values[AUTH_USERS_COL.username],
    name: values[AUTH_USERS_COL.name],
    role: values[AUTH_USERS_COL.role],
    node: values[AUTH_USERS_COL.node]
  };
}

/** 台北時間 "YYYY-MM-DD HH:mm:ss"。不靠 Utilities.formatDate／執行環境時區，自己用 UTC+8 換算，可預測、好測 */
function formatTaipeiDatetime_(date) {
  var t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' +
    pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
}

function updateLastLogin_(rowNumber) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_USERS);
  if (!sheet) return;
  sheet.getRange(rowNumber, AUTH_USERS_COL.last_login_at + 1).setValue(formatTaipeiDatetime_(new Date()));
}

// ============================================================
// 6. login_log（spec §5.1／§5.2 第 6 點；result 只能是 ok/bad_password/locked/disabled）
// ============================================================

function writeLoginLog_(username, ipHash, result) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_LOG);
  if (!sheet) return;
  sheet.appendRow([formatTaipeiDatetime_(new Date()), username, ipHash || '', result]);
}

// ============================================================
// 7. action handlers —— T1-5（Code.gs）之後會把 doPost 的 login/me 分派到這兩個函式
// ============================================================

/**
 * handleLogin_({username, password}, ipHash?) → {ok:true, data:{token,user,perms,secrets}} | {ok:false, error}
 * ipHash 由呼叫端（Code.gs）視能否取得 client IP 而定，取不到就不傳，這裡一律用空字串補上。
 */
function handleLogin_(payload, ipHash) {
  payload = payload || {};
  var username = String(payload.username || '').trim();
  var password = String(payload.password || '');
  ipHash = ipHash || '';

  if (!username) {
    return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  }

  var state = getLoginState_(username);
  var nowSec = Math.floor(Date.now() / 1000);
  if (state.lockedUntil && state.lockedUntil > nowSec) {
    writeLoginLog_(username, ipHash, AUTH_LOG_LOCKED);
    return { ok: false, error: AUTH_MSG_LOCKED };
  }

  var found = findUserRow_(username);
  if (!found) {
    recordLoginFailure_(username, state);
    writeLoginLog_(username, ipHash, AUTH_LOG_BAD_PASSWORD);
    return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  }

  if (!isActiveValue_(found.values[AUTH_USERS_COL.active])) {
    writeLoginLog_(username, ipHash, AUTH_LOG_DISABLED);
    return { ok: false, error: AUTH_MSG_DISABLED };
  }

  var salt = found.values[AUTH_USERS_COL.salt];
  var storedHash = found.values[AUTH_USERS_COL.hash];
  var computedHash = hashPassword_(password, salt);
  if (computedHash !== storedHash) {
    recordLoginFailure_(username, state);
    writeLoginLog_(username, ipHash, AUTH_LOG_BAD_PASSWORD);
    return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  }

  // 成功
  clearLoginState_(username);
  updateLastLogin_(found.row);
  writeLoginLog_(username, ipHash, AUTH_LOG_OK);

  var user = rowToUser_(found.values);
  var perms = getRolePerms_(user.role);
  var secrets = pickSecrets_(perms);
  var token = issueToken_(user);

  return {
    ok: true,
    data: {
      token: token,
      user: { id: user.id, name: user.name, role: user.role, node: user.node },
      perms: perms,
      secrets: secrets
    }
  };
}

/**
 * handleMe_(token) → {ok:true, data:{user,perms,secrets}} | {ok:false, error}
 * 每次都重查 users 分頁的 active，停用帳號即使 token 沒過期也一律拒絕（spec §5.2 第 4 點）。
 */
function handleMe_(token) {
  var payload = verifyToken_(token);
  if (!payload) {
    return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  }

  var found = findUserById_(payload.u);
  if (!found) {
    return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  }
  if (!isActiveValue_(found.values[AUTH_USERS_COL.active])) {
    return { ok: false, error: AUTH_MSG_DISABLED };
  }

  var user = rowToUser_(found.values);
  var perms = getRolePerms_(user.role);
  var secrets = pickSecrets_(perms);

  return {
    ok: true,
    data: {
      user: { id: user.id, name: user.name, role: user.role, node: user.node },
      perms: perms,
      secrets: secrets
    }
  };
}
