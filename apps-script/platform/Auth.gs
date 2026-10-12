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
  salt: 5, hash: 6, active: 7, created_at: 8, last_login_at: 9,
  token_after: 10   // 2026-10-11 個人帳號管理：此時間（Unix 毫秒）以前簽發的 token 一律無效（docs/personnel/spec.md §4.1b）
};
var AUTH_USERS_COL_COUNT = 10; // 寫入既有十欄用；token_after 由 setTokenAfter_ 單獨寫
var AUTH_MSG_NOT_CLAIMED = '這個編號還沒開通，請按「第一次使用」';

// ── 參數 ─────────────────────────────────────────────────────────────
var AUTH_HASH_ITERATIONS = 10000;           // spec §5.6：SHA-256 迭代 10,000 次
var AUTH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // spec §5.3：token 有效期 7 天
var AUTH_LOGIN_FAIL_LIMIT = 3;              // spec §5.2：連續失敗 3 次鎖定（Eason 2026-08-14 由 5 改為 3）
var AUTH_LOGIN_LOCK_SECONDS = 15 * 60;      // spec §5.2：鎖 15 分鐘
// 2026-10-12 安全修補
var AUTH_USERNAME_MAX = 64;                 // 帳號 trim 後 1–64 字，超過直接回通用錯誤、不碰 cache／表
var AUTH_LOG_MAX_ROWS = 5000;               // login_log 只留最新 5000 列（不含表頭）
var AUTH_IP_FAIL_LIMIT = 30;                // 同一來源（ipHash）15 分鐘失敗 30 次 → 該來源鎖 15 分鐘
var AUTH_IP_WINDOW_SECONDS = 15 * 60;
var AUTH_GLOBAL_FAIL_LIMIT = 300;           // 取不到 ipHash 時的全域桶：15 分鐘失敗 300 次 → 失敗訊息加「請稍後再試」
var AUTH_GLOBAL_WINDOW_SECONDS = 15 * 60;
var AUTH_MSG_SLOW_DOWN_SUFFIX = '，請稍後再試';

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

/**
 * 常數時間字串比較（2026-10-12）：逐字元 XOR 累積，不因第一個不同的字元就提早結束，
 * 避免從回應時間推出簽章前綴。長度不同直接判 false，但仍跑完一輪（以 a 的長度為準）。
 */
function authSafeEqual_(a, b) {
  a = String(a);
  b = String(b);
  var diff = a.length === b.length ? 0 : 1;
  for (var i = 0; i < a.length; i++) {
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= a.charCodeAt(i) ^ cb;
  }
  return diff === 0;
}

/** 對任意 payload 物件簽出 token 字串（issueToken_ 與測試用的過期 token 都靠這個） */
function signPayload_(payload) {
  var payloadPart = toBase64Url_(stringToBytes_(JSON.stringify(payload)));
  var sigBytes = Utilities.computeHmacSha256Signature(payloadPart, getHmacSecret_());
  var sigPart = toBase64Url_(sigBytes);
  return payloadPart + '.' + sigPart;
}

/** issueToken_(user) — user = {id, role, node}；payload 逐字照 spec §5.3：{u,r,n,e} */
function issueToken_(user, minIssuedAt) {
  var nowSec = Math.floor(Date.now() / 1000);
  // i＝簽發時間（毫秒，2026-10-11 加）：配合 users.token_after 撤銷舊登入。
  // 用毫秒不用秒：撤銷與冒用者的 token 若落在同一秒，用秒會讓舊 token 照樣過關（測試抓到）
  // minIssuedAt：剛撤銷完馬上換發新 token 時（改密碼），保證新 token 比撤銷時間晚，才過得了嚴格大於的檢查
  var issuedAt = Math.max(Date.now(), Number(minIssuedAt) || 0);
  var payload = { u: user.id, r: user.role, n: user.node, e: nowSec + AUTH_TOKEN_TTL_SECONDS, i: issuedAt };
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
  if (!authSafeEqual_(expectedSig, sigPart)) return false; // 簽章被竄改，或 payload 被竄改導致簽章對不上

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
 * readModuleSecrets_() → { backend_id: { level: 原始儲存格值 } }（Object.create(null)，沒有原型鏈欄位）
 * module_secrets 分頁只有 backend_id／level／secret 三欄（spec §5.1）。
 */
function readModuleSecrets_() {
  var byBackend = Object.create(null);
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_SECRETS);
  if (!sheet) return byBackend;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return byBackend;
  var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  rows.forEach(function (r) {
    var backendId = String(r[0] || '').trim();
    var level = String(r[1] || '').trim();
    if (!backendId || !level) return;
    if (!byBackend[backendId]) byBackend[backendId] = Object.create(null);
    byBackend[backendId][level] = r[2];
  });
  return byBackend;
}

/**
 * pickSecretFor_(perms, ns, byBackend?) → 這個身分對 ns 該用的通行碼（字串）；不該拿／查不到＝''。
 * 規則（spec §5.2，原 pickSecrets_ 的單一後端版，2026-10-12 拆出給 proxyAuthorize_ 共用）：
 *   有 <ns>.write → level=write 的碼；否則有 <ns>.read 或 <ns>.read.own → level=read 的碼；都沒有 → ''。
 */
function pickSecretFor_(perms, ns, byBackend) {
  byBackend = byBackend || readModuleSecrets_();
  if (typeof ns !== 'string' || !ns || !Object.prototype.hasOwnProperty.call(byBackend, ns)) return '';
  var levels = byBackend[ns];
  var wantLevel = null;
  if (hasPerm_(perms, ns + '.write')) {
    wantLevel = 'write';
  } else if (hasPerm_(perms, ns + '.read') || hasPerm_(perms, ns + '.read.own')) {
    wantLevel = 'read';
  }
  if (!wantLevel) return '';
  var secret = levels[wantLevel];
  if (secret === undefined || secret === null || secret === '') return '';
  // 2026-08-17 修（Eason 實際踩到「店長看稽核＝通行碼錯誤」）：
  // 試算表儲存格若是**純數字**的通行碼，getValues() 回來的是 number 不是 string。
  // 既有兩支後端都用嚴格比對（稽核 Code.gs resolveRole_ 的 `code === settings.viewerCode`、
  // 宿舍 Api.gs 的 requireAdmin），而它們那邊是 String(...) 過的——
  // number 123456 永遠不會等於 string '123456'，於是通行碼「明明填對了卻一直錯」。
  // 一律轉字串並去掉前後空白（貼上時很容易多一個空格，同樣是肉眼看不出來的錯）。
  return String(secret).trim();
}

/**
 * pickSecrets_(perms) → {backend_id: secret}
 * ⚠ 2026-10-12 起**沒有任何對外回應使用它**（login／me 不再下發通行碼，改由 Mac mini 代轉，
 *   見 proxyAuthorize_）。只留給測試驗「哪個身分該用哪一級碼」；不准再接回任何 handler 的回傳值。
 */
function pickSecrets_(perms) {
  var byBackend = readModuleSecrets_();
  var out = {};
  Object.keys(byBackend).forEach(function (backendId) {
    var s = pickSecretFor_(perms, backendId, byBackend);
    if (s) out[backendId] = s;
  });
  return out;
}

// ============================================================
// 3b. 稽核／宿舍代轉授權（2026-10-12，契約正本：~/dzy-minikit/apps/dzy-platform/PROXY.md 第 2 節）
// ============================================================

/**
 * 讀取類 action 白名單——**必須與前端 platform/dryrun.js 的 READ_ACTIONS 的 audit／dorm 一致**
 *（test/proxy-authorize.test.mjs 有比對）。沒列到的一律當寫入（要 <ns>.write）。
 */
var PROXY_READ_ACTIONS = {
  audit: ['getAll'],
  dorm: ['rooms', 'list', 'contract', 'handover']
};

/**
 * proxyAuthorize_(token, ns, action) — 只給 minikit 執行器在佇列內直接呼叫（kit/runner/proxy.js）。
 * ⚠ 不准加進 Code.gs 的 CODE_ALLOWED_ACTIONS／dispatchAction_（加了＝任何持 token 的人打 /api 就能拿回通行碼）。
 * ⚠ 純讀：不寫任何分頁（不更新 last_login、不寫 login_log）。
 *
 * 成功：{ ok:true, secret:'<非空字串>', filterNode:null|'<user.node>', isWrite:boolean }
 * 失敗：{ ok:false, code:'NO_TOKEN'|'BAD_TOKEN'|'FORBIDDEN'|'NO_SECRET'|'UNKNOWN_NS', error:'<中文，不含通行碼>' }
 */
function proxyAuthorize_(token, ns, action) {
  if (typeof token !== 'string' || !token) {
    return { ok: false, code: 'NO_TOKEN', error: '請先登入' };
  }
  // 1. 驗 token：與 handleMe_ 同一套（簽章、效期、每次重查 active 與 token_after、同仁認領閘門）
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, code: 'BAD_TOKEN', error: sess.error };

  // 7. ns 必須是 module_secrets 出現過的 backend_id
  var byBackend = readModuleSecrets_();
  if (typeof ns !== 'string' || !ns || !Object.prototype.hasOwnProperty.call(byBackend, ns)) {
    return { ok: false, code: 'UNKNOWN_NS', error: '不支援的系統' };
  }

  // 3. 讀／寫判斷：拿不準當寫入
  var readList = Object.prototype.hasOwnProperty.call(PROXY_READ_ACTIONS, ns) ? PROXY_READ_ACTIONS[ns] : [];
  var isWrite = !(typeof action === 'string' && readList.indexOf(action) !== -1);

  // 2／4. 授權
  var perms = sess.perms;
  var canWrite = hasPerm_(perms, ns + '.write');
  var canRead = hasPerm_(perms, ns + '.read');
  var canOwn = hasPerm_(perms, ns + '.read.own');
  if (isWrite ? !canWrite : !(canWrite || canRead || canOwn)) {
    return { ok: false, code: 'FORBIDDEN', error: '沒有權限' };
  }

  // 5. 通行碼
  var secret = pickSecretFor_(perms, ns, byBackend);
  if (!secret) return { ok: false, code: 'NO_SECRET', error: '這個系統尚未設定通行碼，請聯絡管理者' };

  // 6. 店長裁切：沒有 <ns>.read 但有 <ns>.read.own → 只給自己節點（.write 不豁免）；'' ＝沒節點→空列
  var filterNode = (!canRead && canOwn) ? String(sess.user.node || '') : null;

  return { ok: true, secret: secret, filterNode: filterNode, isWrite: isWrite };
}

// ============================================================
// 4. 登入失敗鎖定
//    狀態存 CacheService（非 ScriptProperties）：鎖定本質是「15 分鐘後自動失效」的暫時狀態，
//    CacheService.put(key, value, ttlSeconds) 內建 TTL，時間一到自動消失，不必另外寫清除邏輯；
//    ScriptProperties 沒有 TTL，得自己存時間戳、每次都手動判斷還要手動清，久了會累積一堆
//    過期但沒人清的 key。內部系統少量帳號，CacheService 的「盡力保存、非保證持久」特性可接受。
// ============================================================

function authLoginStateKey_(username) {
  // 帳號不分大小寫（2026-10-12）：dzy001／DZY001、boss／BOSS 共用同一個鎖定計數
  return 'auth_login_state:' + String(username).toLowerCase();
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

// ── 來源桶（2026-10-12，防跨帳號密碼噴灑）─────────────────────────
// 有 ipHash：同一來源 15 分鐘（固定窗）失敗 30 次 → 該來源鎖 15 分鐘，連正確密碼也先擋（不影響其他來源）。
// 沒 ipHash（Apps Script 拿不到 IP；minikit 執行器目前也沒往下傳）：全域桶，15 分鐘失敗 300 次後，
// 失敗訊息加一句「請稍後再試」，但**正確密碼照樣登入**——全域鎖會讓一個攻擊者把全公司鎖在門外。

function authIpLockKey_(ipHash) { return 'auth_ip_lock:' + ipHash; }

function authIpLocked_(ipHash) {
  if (!ipHash) return false;
  var until = Number(CacheService.getScriptCache().get(authIpLockKey_(ipHash)) || 0);
  return until > Math.floor(Date.now() / 1000);
}

/** 記一次失敗到來源桶；回 true＝全域桶已過門檻（失敗訊息要加「請稍後再試」） */
function recordSourceFailure_(ipHash) {
  var cache = CacheService.getScriptCache();
  var nowSec = Math.floor(Date.now() / 1000);
  if (ipHash) {
    var win = Math.floor(nowSec / AUTH_IP_WINDOW_SECONDS);
    var key = 'auth_ip_fail:' + ipHash + ':' + win;
    var n = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(n), AUTH_IP_WINDOW_SECONDS + 60);
    if (n >= AUTH_IP_FAIL_LIMIT) {
      cache.put(authIpLockKey_(ipHash), String(nowSec + AUTH_LOGIN_LOCK_SECONDS), AUTH_LOGIN_LOCK_SECONDS);
    }
    return false;
  }
  var gwin = Math.floor(nowSec / AUTH_GLOBAL_WINDOW_SECONDS);
  var gkey = 'auth_global_fail:' + gwin;
  var g = Number(cache.get(gkey) || 0) + 1;
  cache.put(gkey, String(g), AUTH_GLOBAL_WINDOW_SECONDS + 60);
  return g >= AUTH_GLOBAL_FAIL_LIMIT;
}

/** 失敗共用收尾：帳號計數＋來源計數＋login_log，回前端錯誤物件 */
function authFail_(username, state, ipHash, msg) {
  recordLoginFailure_(username, state);
  var slow = recordSourceFailure_(ipHash);
  writeLoginLog_(username, ipHash, AUTH_LOG_BAD_PASSWORD);
  return { ok: false, error: slow ? msg + AUTH_MSG_SLOW_DOWN_SUFFIX : msg };
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
  // 不分大小寫（2026-10-12）：人員管理建帳號防重複本來就不分大小寫，所以最多一列對得上
  var target = String(username).toLowerCase();
  var rows = readUsersRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][AUTH_USERS_COL.username]).trim().toLowerCase() === target) return { row: i + 2, values: rows[i] };
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

/**
 * 公式注入防護（2026-10-12）：字串開頭（含前導空白／tab）是 = + - @ 時前面加單引號，
 * 試算表會當純文字顯示，不會被當成公式執行。非字串原樣回傳。Users.gs／Staff.gs 也共用。
 */
function authSafeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[\s]*[=+\-@]/.test(v) ? "'" + v : v;
}

function writeLoginLog_(username, ipHash, result) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_LOG);
  if (!sheet) return;
  sheet.appendRow([formatTaipeiDatetime_(new Date()), username, ipHash || '', result].map(authSafeCell_));
  trimLoginLog_(sheet);
}

/**
 * login_log 上限（2026-10-12）：超過 AUTH_LOG_MAX_ROWS 列資料就一次刪掉最舊的，保留最新的。
 * Google 試算表有 deleteRows（一次刪一段）；minikit 假表只有 deleteRow，平常每次只多 1 列就刪 1 列，
 * 一次超出很多（第一次上線舊表很長）時改成「最新 N 列整塊搬到上面、再從尾端刪」，一樣只讀寫一次整塊。
 */
function trimLoginLog_(sheet) {
  var last = sheet.getLastRow();
  var excess = (last - 1) - AUTH_LOG_MAX_ROWS;
  if (excess <= 0) return;
  if (typeof sheet.deleteRows === 'function') {
    sheet.deleteRows(2, excess);
    return;
  }
  if (excess === 1) {
    sheet.deleteRow(2);
    return;
  }
  var width = Math.max(sheet.getLastColumn(), 4);
  var keep = sheet.getRange(2 + excess, 1, AUTH_LOG_MAX_ROWS, width).getValues();
  sheet.getRange(2, 1, AUTH_LOG_MAX_ROWS, width).setValues(keep);
  for (var r = last; r > 1 + AUTH_LOG_MAX_ROWS; r--) sheet.deleteRow(r); // 從尾端刪，假表每次 O(1)
}

// ============================================================
// 7. action handlers —— T1-5（Code.gs）之後會把 doPost 的 login/me 分派到這兩個函式
// ============================================================

/**
 * handleLogin_({username, password}, ipHash?) → {ok:true, data:{token,user,perms}} | {ok:false, error}
 * ipHash 由呼叫端（Code.gs）視能否取得 client IP 而定，取不到就不傳，這裡一律用空字串補上。
 */
function handleLogin_(payload, ipHash) {
  payload = payload || {};
  // 帳號先驗型別與長度（2026-10-12）：不是字串、trim 後空白或超過 64 字，一律回通用錯誤，
  // **不寫 cache、不寫 login_log**（超長帳號原本會被拿來當 cache key 與 log 內容灌爆）
  if (typeof payload.username !== 'string') return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  var username = payload.username.trim();
  if (!username || username.length > AUTH_USERNAME_MAX) return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  // DZY 員工編號：轉大寫只為了 login_log 好讀；比對與鎖定計數一律不分大小寫（findUserRow_／authLoginStateKey_）
  if (/^dzy[0-9]{3}$/i.test(username)) username = username.toUpperCase();
  var password = String(payload.password || '');
  ipHash = typeof ipHash === 'string' ? ipHash.slice(0, 64) : '';

  // 來源被鎖：直接擋（連正確密碼也一樣），不再寫 login_log，避免鎖住的來源繼續灌 log
  if (authIpLocked_(ipHash)) {
    return { ok: false, error: AUTH_MSG_LOCKED };
  }

  var state = getLoginState_(username);
  var nowSec = Math.floor(Date.now() / 1000);
  if (state.lockedUntil && state.lockedUntil > nowSec) {
    writeLoginLog_(username, ipHash, AUTH_LOG_LOCKED);
    return { ok: false, error: AUTH_MSG_LOCKED };
  }

  var found = findUserRow_(username);
  if (!found) {
    return authFail_(username, state, ipHash, AUTH_MSG_BAD_PASSWORD);
  }

  if (!isActiveValue_(found.values[AUTH_USERS_COL.active])) {
    writeLoginLog_(username, ipHash, AUTH_LOG_DISABLED);
    return { ok: false, error: AUTH_MSG_DISABLED };
  }

  var salt = found.values[AUTH_USERS_COL.salt];
  var storedHash = found.values[AUTH_USERS_COL.hash];
  if (String(storedHash || '') === '') {
    // 還沒認領的同仁編號：照樣計入鎖定（否則可以無限試出哪些編號還沒人認領）
    return authFail_(username, state, ipHash, AUTH_MSG_NOT_CLAIMED);
  }
  var computedHash = hashPassword_(password, salt);
  if (!authSafeEqual_(computedHash, String(storedHash))) {
    return authFail_(username, state, ipHash, AUTH_MSG_BAD_PASSWORD);
  }

  // 雜湊要跑好幾秒；這段期間若有人重設密碼／撤回認領／停用，用舊快照簽出的 token 會比 token_after 新而躲過撤銷
  //（GPT 上線前審第 1 條）。簽發前重讀一次，salt／hash／active 有變就當作失敗
  var recheck = findUserRow_(username);
  if (!recheck || recheck.row !== found.row ||
      String(recheck.values[AUTH_USERS_COL.salt]) !== String(salt) ||
      String(recheck.values[AUTH_USERS_COL.hash]) !== String(storedHash) ||
      !isActiveValue_(recheck.values[AUTH_USERS_COL.active])) {
    return { ok: false, error: AUTH_MSG_BAD_PASSWORD };
  }

  // 簽發一律用重讀後的 recheck.values（2026-10-12）：雜湊期間被改了角色／節點／姓名，要拿到新的，不是舊快照
  var user = rowToUser_(recheck.values);

  // 同仁認領待審（2026-10-12 Eason：主管審核通過才開通）：密碼對了才說原因，不先洩漏帳號狀態
  var gate = authStaffGate_(user);
  if (gate.block) {
    clearLoginState_(username);
    writeLoginLog_(username, ipHash, AUTH_LOG_DISABLED);
    return { ok: false, error: gate.block };
  }

  // 成功
  clearLoginState_(username);
  updateLastLogin_(recheck.row);
  writeLoginLog_(username, ipHash, AUTH_LOG_OK);

  var perms = authPermsWithGate_(user.role, gate);
  // 2026-10-12：預設不再下發 secrets（稽核／宿舍改由 Mac mini 代轉，見 proxyAuthorize_）；過渡期 LEGACY_SECRETS=1 才回
  // 剛登出（token_after＝現在）同一毫秒內再登入時，新 token 也要比 token_after 新才過得了嚴格大於
  var token = issueToken_(user, (Number(recheck.values[AUTH_USERS_COL.token_after]) || 0) + 1);

  var data = {
    token: token,
    user: { id: user.id, name: user.name, role: user.role, node: user.node },
    perms: perms
  };
  if (authLegacySecretsOn_()) data.secrets = pickSecrets_(perms);
  return { ok: true, data: data };
}

/**
 * 部署過渡旗標（2026-10-12 GPT 複審第 1 條）：ScriptProperties `LEGACY_SECRETS` 值為 '1' 時，
 * login／me 照舊回 secrets，讓還開著舊 JS（Pages 快取）的人在換版期間仍能用稽核／宿舍。
 * 預設（未設、或任何非 '1' 的值）＝不回。新前端完全不讀 secrets。
 * 大家重整完就把這個屬性刪掉，再換舊通行碼（部署順序見 dzy-admin SKILL.md／spec §6.3）。
 */
function authLegacySecretsOn_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('LEGACY_SECRETS') || '').trim() === '1';
  } catch (e) {
    return false;
  }
}

/**
 * authResolveSession_(token) → {ok:true, user, perms} | {ok:false, error}
 * handleMe_ 與 proxyAuthorize_ 共用的同一套驗證（純讀）：
 * 簽章／效期 → 每次重查 users 分頁 active（停用帳號即使 token 沒過期也拒絕，spec §5.2 第 4 點）
 * → token_after 撤銷 → 同仁認領閘門 → 角色權限＋衍生權限。
 */
function authResolveSession_(token) {
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
  // 撤銷檢查：token_after 有值時，簽發時間早於它的 token 一律無效（舊 token 沒有 i 視為 0）
  var tokenAfter = Number(found.values[AUTH_USERS_COL.token_after]) || 0;
  // 嚴格大於：撤銷那一毫秒簽出的舊 token 也要擋（測試實際撞到同一毫秒）
  if (tokenAfter && (Number(payload.i) || 0) <= tokenAfter) {
    return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  }

  var user = rowToUser_(found.values);
  // 認領待審的同仁：舊流程發過的 token 也一律擋（2026-10-12 上線轉換）
  var gate = authStaffGate_(user);
  if (gate.block) {
    return { ok: false, error: gate.block };
  }
  return { ok: true, user: user, perms: authPermsWithGate_(user.role, gate) };
}

/**
 * handleMe_(token) → {ok:true, data:{user,perms}} | {ok:false, error}
 * 2026-10-12 起預設不回 secrets（稽核／宿舍改由 Mac mini 代轉）；過渡旗標 LEGACY_SECRETS=1 時照舊回。
 */
function handleMe_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  var user = sess.user;
  var data = {
    user: { id: user.id, name: user.name, role: user.role, node: user.node },
    perms: sess.perms
  };
  if (authLegacySecretsOn_()) data.secrets = pickSecrets_(sess.perms);
  return { ok: true, data: data };
}

/** 讓這個帳號「現在以前」簽發的 token 全部失效（停用、撤回認領、重設／修改密碼時呼叫） */
function setTokenAfter_(rowNumber) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_USERS);
  var now = Date.now();
  sheet.getRange(rowNumber, AUTH_USERS_COL.token_after + 1).setValue(now);
  return now;
}

/**
 * 同仁閘門（2026-10-12）：只對 role＝staff 查 staff 分頁（Staff.gs stfLoginGate_）。
 * 回 {block: 訊息}＝不准登入／token 失效；{review:true}＝具單位主管審核資格。
 * 其他角色、或 Staff.gs 不在（舊測試沙盒）→ {}。
 */
function authStaffGate_(user) {
  if (!user || String(user.role) !== 'staff') return {};
  if (typeof stfLoginGate_ !== 'function') return {};
  return stfLoginGate_(user.id) || {};
}

/** 角色權限＋衍生權限 platform.review（只讓「待審核」分頁出現；審核 action 本身仍在後端重算資格） */
function authPermsWithGate_(role, gate) {
  var perms = getRolePerms_(role);
  if (gate && gate.review && perms.indexOf('platform.review') === -1 && perms.indexOf('*') === -1) {
    perms = perms.concat(['platform.review']);
  }
  return perms;
}

/**
 * handleLogout_(token)（2026-10-12 Eason：登出＝全部裝置一起登出）
 * 把這個帳號的 token_after 設成現在，所有裝置上已簽發的 token 一律失效（沿用改密碼的撤銷機制）。
 * users 是 11 欄：setTokenAfter_ 只寫 token_after 那一格，不整列回寫。
 * token 已失效／帳號已停用 → 回原錯誤（前端不管成功失敗都會清本機）。
 */
function handleLogout_(token) {
  var payload = verifyToken_(token);
  if (!payload) return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  var found = findUserById_(payload.u);
  if (!found) return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  var tokenAfter = Number(found.values[AUTH_USERS_COL.token_after]) || 0;
  if (tokenAfter && (Number(payload.i) || 0) <= tokenAfter) return { ok: false, error: AUTH_MSG_INVALID_TOKEN };
  setTokenAfter_(found.row);
  return { ok: true, data: {} };
}
