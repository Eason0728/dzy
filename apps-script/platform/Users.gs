/**
 * 鼎兆元管理系統｜平台後端 — 人員管理（T1-5）
 * 對應 docs/spec.md §4.4 節點代號／§5.1 試算表欄位／§5.2 API actions（listUsers／saveUser／setActive／resetPassword／listRoles）。
 *
 * 本檔依賴 Auth.gs 已提供的 handleMe_ / verifyToken_ / hasPerm_ / getRolePerms_ / hashPassword_，
 * 直接呼叫即可（同一個 Apps Script 專案共用全域範疇，不需要 import）。
 * 不重新宣告 Auth.gs／Setup.gs 已有的頂層常數，避免撞名（見 Auth.gs 檔頭說明的教訓），
 * 因此本檔的分頁名稱／欄序常數獨立用 USR_ 前綴宣告一份，值與 Auth.gs 的 AUTH_USERS_COL 一致。
 *
 * ⚠ 密碼明碼、salt、hash 一律不得寫死在本檔或任何 repo 內的檔案，一律從試算表讀取／隨機產生。
 */

// ── 分頁名稱與欄序（值同 Auth.gs 的 AUTH_SHEET_USERS / AUTH_USERS_COL，見該檔說明）──────
var USR_SHEET_USERS = 'users';
var USR_SHEET_ROLES = 'roles';

var USR_COL = {
  id: 0, username: 1, name: 2, role: 3, node: 4,
  salt: 5, hash: 6, active: 7, created_at: 8, last_login_at: 9
};
var USR_COL_COUNT = 10;

// 節點代號（spec §4.4，不得自創）；空字串＝不限節點，另外判斷
var USR_VALID_NODES = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'];

// 錯誤訊息
var USR_MSG_NO_PERM = '沒有權限';
var USR_MSG_NOT_FOUND = '找不到使用者';
var USR_MSG_USERNAME_REQUIRED = '帳號不得為空';
var USR_MSG_NAME_REQUIRED = '姓名不得為空';
var USR_MSG_ROLE_REQUIRED = '角色不得為空';
var USR_MSG_ROLE_NOT_FOUND = '角色不存在';
var USR_MSG_NODE_INVALID = '節點代號不合法';
var USR_MSG_USERNAME_TAKEN = '帳號已存在';
var USR_MSG_ID_REQUIRED = 'id 不得為空';
var USR_MSG_ACTIVE_INVALID = 'active 格式錯誤';
var USR_MSG_PASSWORD_TOO_SHORT = '密碼至少需要 8 個字元';
var USR_MSG_OLD_PASSWORD_WRONG = '目前密碼不正確';
var USR_MSG_PASSWORD_SAME = '新密碼不能與目前密碼相同';
var USR_MSG_STAFF_ELSEWHERE = '同仁帳號請到同仁名單操作';
var USR_MSG_ADMIN_ONLY = '只有系統管理員能建立、修改或停用管理員帳號';
var USR_MSG_SELF_ROLE = '不能修改自己的角色';
var USR_MSG_SELF_DEACTIVATE = '不能停用自己的帳號';
var USR_MSG_LAST_ADMIN = '至少要保留一位啟用中的系統管理員';
var USR_MSG_SELF_USERNAME = '不能修改自己的帳號名稱';
var USR_MSG_USERNAME_TOO_LONG = '帳號最多 64 個字';
var USR_MSG_USERNAME_BAD_START = '帳號不能用 = + - @ 開頭';
// minikit 假試算表會把純數字字串轉成數字，存一次就登不進去（GPT 複審第 5 條，2026-10-12）
var USR_MSG_USERNAME_NEED_LETTER = '帳號至少要有一個英文字母';
var USR_MSG_NAME_TOO_LONG = '姓名最多 50 個字';
var USR_MSG_SELF_PW_LOCKED = '嘗試次數過多，請 15 分鐘後再試';

// 本人驗密碼（改密碼、改手機）錯誤計數：同一 user 15 分鐘內錯 5 次鎖 15 分鐘（2026-10-12）
var USR_SELF_PW_FAIL_LIMIT = 5;
var USR_SELF_PW_WINDOW_SECONDS = 15 * 60;
var USR_SELF_PW_LOCK_SECONDS = 15 * 60;

// ============================================================
// 0. 權限檢查（spec：token → verifyToken_ → 取角色 → getRolePerms_ → hasPerm_）
//    handleMe_ 已完整封裝這條鏈（含每次重查 active），直接借用最安全。
// ============================================================

/** requirePlatformUsers_(token) → {ok:true, user, perms} | {ok:false, error} */
function requirePlatformUsers_(token) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  if (!hasPerm_(me.data.perms, 'platform.users')) {
    return { ok: false, error: USR_MSG_NO_PERM };
  }
  return { ok: true, user: me.data.user, perms: me.data.perms };
}

/** 超級角色：role 為 admin，或 roles 分頁該角色的 perms 含 '*'（全部功能） */
function usrRoleIsSuper_(role) {
  role = String(role === undefined || role === null ? '' : role).trim();
  if (!role) return false;
  if (role === 'admin') return true;
  var perms = getRolePerms_(role);
  if (perms.indexOf('*') !== -1) return true;
  // 角色含 platform.users／platform.permmap（PERM_ROLE_SUPER）也視為高權限：只有 admin 能指派、能動該帳號
  if (typeof PERM_ROLE_SUPER !== 'undefined') {
    return PERM_ROLE_SUPER.some(function (c) { return perms.indexOf(c) !== -1; });
  }
  return false;
}

/** 操作者是不是 role admin（有 platform.users 的非 admin 不能動管理員／全權角色的帳號） */
// 「排除某帳號後」是否還有啟用中的 admin（停用或降級前檢查，避免鎖死整個系統）
function usrOtherActiveAdminExists_(excludeId) {
  var rows = readUsersRawRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][USR_COL.id]) === String(excludeId)) continue;
    if (String(rows[i][USR_COL.role]) !== 'admin') continue;
    if (String(rows[i][USR_COL.active]).toUpperCase() === 'TRUE') return true;
  }
  return false;
}

function usrActorIsAdmin_(auth) {
  return !!(auth && auth.user && String(auth.user.role) === 'admin');
}

// ============================================================
// 0b. 本人驗密碼的錯誤計數（2026-10-12；changePassword 與 Staff.gs 的 saveMyProfile 共用）
//     存 CacheService，key 用 user id（不是帳號，改名也不會歸零）。
// ============================================================

function usrSelfPwKey_(userId) { return 'usr_selfpw:' + String(userId); }

function usrSelfPwState_(userId) {
  var raw = CacheService.getScriptCache().get(usrSelfPwKey_(userId));
  if (!raw) return { count: 0, since: 0, lockedUntil: 0 };
  try {
    var p = JSON.parse(raw);
    return { count: Number(p.count) || 0, since: Number(p.since) || 0, lockedUntil: Number(p.lockedUntil) || 0 };
  } catch (e) {
    return { count: 0, since: 0, lockedUntil: 0 };
  }
}

/**
 * usrVerifySelfPassword_(userId, password, userValues) → {ok:true} | {ok:false, error}
 * 先看是否鎖住（鎖住就不算雜湊、不再計次）；驗錯計一次，驗對清掉計數。
 */
function usrVerifySelfPassword_(userId, password, userValues) {
  var nowSec = Math.floor(Date.now() / 1000);
  var st = usrSelfPwState_(userId);
  if (st.lockedUntil > nowSec) return { ok: false, error: USR_MSG_SELF_PW_LOCKED };
  var cache = CacheService.getScriptCache();
  // 常數時間比對（GPT 複審第 6 條；與 handleLogin_ 一致）
  var good = String(userValues[USR_COL.hash] || '') !== '' &&
    authSafeEqual_(hashPassword_(String(password), userValues[USR_COL.salt]), String(userValues[USR_COL.hash]));
  if (good) {
    cache.remove(usrSelfPwKey_(userId));
    return { ok: true };
  }
  if (!st.since || nowSec - st.since >= USR_SELF_PW_WINDOW_SECONDS) st = { count: 0, since: nowSec, lockedUntil: 0 };
  st.count += 1;
  if (st.count >= USR_SELF_PW_FAIL_LIMIT) st.lockedUntil = nowSec + USR_SELF_PW_LOCK_SECONDS;
  cache.put(usrSelfPwKey_(userId), JSON.stringify(st), USR_SELF_PW_WINDOW_SECONDS + USR_SELF_PW_LOCK_SECONDS);
  return { ok: false, error: USR_MSG_OLD_PASSWORD_WRONG };
}

// ============================================================
// 1. 共用：讀寫 users／roles 分頁
// ============================================================

function usrFormatTaipeiDatetime_(date) {
  var t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' +
    pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
}

function normalizeUsername_(u) {
  return String(u || '').trim().toLowerCase();
}

function readUsersRawRows_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), USR_COL_COUNT);
  return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
}

function findUsrRowByUsername_(username) {
  var rows = readUsersRawRows_();
  var target = normalizeUsername_(username);
  for (var i = 0; i < rows.length; i++) {
    if (normalizeUsername_(rows[i][USR_COL.username]) === target) {
      return { row: i + 2, values: rows[i] };
    }
  }
  return null;
}

function findUsrRowById_(id) {
  var rows = readUsersRawRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][USR_COL.id]) === String(id)) {
      return { row: i + 2, values: rows[i] };
    }
  }
  return null;
}

/** 掃現有 id（格式 ^u[0-9]{3,6}$）取最大值 +1，零填到至少 3 位數 */
function generateNextUserId_() {
  var rows = readUsersRawRows_();
  var max = 0;
  var re = /^u([0-9]{3,6})$/;
  rows.forEach(function (r) {
    var m = re.exec(String(r[USR_COL.id] || ''));
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  var digits = String(max + 1);
  while (digits.length < 3) digits = '0' + digits;
  return 'u' + digits;
}

function roleExists_(role) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_ROLES);
  if (!sheet) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var rows = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === role) return true;
  }
  return false;
}

function isValidNode_(node) {
  return node === '' || USR_VALID_NODES.indexOf(node) !== -1;
}

/** 把格子設成純文字（'@'）；minikit 假表／舊測試沙盒沒有 setNumberFormat 就略過（帳號另有「要有英文字母」把關） */
function usrSetTextFormat_(range) {
  if (range && typeof range.setNumberFormat === 'function') range.setNumberFormat('@');
}

function appendUsersRow_(rowValues) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.appendRow(rowValues);
}

function writeUsersRow_(rowNumber, rowValues) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  // 只寫前 10 欄：2026-10-11 users 多了第 11 欄 token_after，讀回來的列是 11 欄，
  // 原樣 setValues 到 10 欄的範圍會尺寸不符直接丟錯（Fable 上線前審第 1 條：人員管理編輯全壞）；
  // 截到 10 欄也剛好不會蓋掉 token_after
  var out = rowValues.slice(0, USR_COL_COUNT);
  while (out.length < USR_COL_COUNT) out.push('');
  sheet.getRange(rowNumber, 1, 1, USR_COL_COUNT).setValues([out]);
}

// ============================================================
// 2. listUsers（spec §5.2）—— 絕不含 salt／hash
// ============================================================

function handleListUsers_(token) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  // 同仁帳號（role＝staff）改在「同仁名單」管，這裡只列系統帳號（docs/personnel/spec.md §1）
  var rows = readUsersRawRows_().filter(function (r) { return String(r[USR_COL.role]) !== 'staff'; });
  var users = rows.map(function (r) {
    return {
      id: r[USR_COL.id],
      username: r[USR_COL.username],
      name: r[USR_COL.name],
      role: r[USR_COL.role],
      node: r[USR_COL.node],
      active: r[USR_COL.active],
      created_at: r[USR_COL.created_at],
      last_login_at: r[USR_COL.last_login_at]
    };
  });
  return { ok: true, data: { users: users } };
}

// ============================================================
// 3. saveUser（spec §5.2）—— 新增或修改，全部先驗證再寫
// ============================================================

function handleSaveUser_(token, payload) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  payload = payload || {};
  var id = payload.id ? String(payload.id).trim() : '';
  var username = String(payload.username || '').trim();
  var name = String(payload.name || '').trim();
  var role = String(payload.role || '').trim();
  var node = (payload.node === undefined || payload.node === null) ? '' : String(payload.node).trim();
  var password = (payload.password === undefined || payload.password === null) ? '' : String(payload.password);
  var isInsert = !id;

  // ── 驗證（全部通過才寫）──────────────────────────────────
  if (!username) return { ok: false, error: USR_MSG_USERNAME_REQUIRED };
  if (username.length > 64) return { ok: false, error: USR_MSG_USERNAME_TOO_LONG };
  if (/^[=+\-@]/.test(username)) return { ok: false, error: USR_MSG_USERNAME_BAD_START };
  if (!/[A-Za-z]/.test(username)) return { ok: false, error: USR_MSG_USERNAME_NEED_LETTER };
  if (!name) return { ok: false, error: USR_MSG_NAME_REQUIRED };
  if (name.length > 50) return { ok: false, error: USR_MSG_NAME_TOO_LONG };
  if (!role) return { ok: false, error: USR_MSG_ROLE_REQUIRED };
  // 同仁帳號（role staff）只能經「同仁名單」建立／修改，否則 staff 分頁與 users 狀態會脫鉤（2026-10-12）
  if (role === 'staff') return { ok: false, error: USR_MSG_STAFF_ELSEWHERE };
  if (!roleExists_(role)) return { ok: false, error: USR_MSG_ROLE_NOT_FOUND };
  if (!isValidNode_(node)) return { ok: false, error: USR_MSG_NODE_INVALID };
  var actorIsAdmin = usrActorIsAdmin_(auth);
  // 非 admin 不能建立或把帳號改成管理員／全權角色
  // （改自己且角色不變，例如改顯示名稱，不算指派高權限）
  var selfRow = id ? findUsrRowById_(id) : null;
  var selfUnchanged = !!selfRow && String(selfRow.values[USR_COL.id]) === String(auth.user.id) && String(selfRow.values[USR_COL.role]) === role;
  if (!actorIsAdmin && !selfUnchanged && usrRoleIsSuper_(role)) return { ok: false, error: USR_MSG_ADMIN_ONLY };

  var existingByUsername = findUsrRowByUsername_(username);
  var existingById = null;

  if (isInsert) {
    if (existingByUsername) return { ok: false, error: USR_MSG_USERNAME_TAKEN };
    // 新增帳號密碼長度規則須與 resetPassword 一致（spec §5.2 2026-08-15 補）：
    // 沿用 resetPassword 已有的 USR_MSG_PASSWORD_TOO_SHORT，不另造訊息常數。
    if (password.length < 8) return { ok: false, error: USR_MSG_PASSWORD_TOO_SHORT };
  } else {
    existingById = findUsrRowById_(id);
    if (!existingById) return { ok: false, error: USR_MSG_NOT_FOUND };
    if (String(existingById.values[USR_COL.role]) === 'staff') return { ok: false, error: USR_MSG_STAFF_ELSEWHERE };
    var isSelfTarget = String(existingById.values[USR_COL.id]) === String(auth.user.id);
    // 任何人（含 admin）都不能改自己的角色；改自己帳號名稱也只有 admin 可以
    if (isSelfTarget && String(existingById.values[USR_COL.role]) !== role) return { ok: false, error: USR_MSG_SELF_ROLE };
    if (isSelfTarget && !actorIsAdmin && normalizeUsername_(existingById.values[USR_COL.username]) !== normalizeUsername_(username)) return { ok: false, error: USR_MSG_SELF_USERNAME };
    // 把最後一位啟用中的 admin 降級 → 拒絕
    if (String(existingById.values[USR_COL.role]) === 'admin' && role !== 'admin' && !usrOtherActiveAdminExists_(existingById.values[USR_COL.id])) return { ok: false, error: USR_MSG_LAST_ADMIN };
    if (!actorIsAdmin) {
      // 非 admin 不能改管理員／全權角色的帳號，也不能改自己的角色
      var isSelfRow = String(existingById.values[USR_COL.id]) === String(auth.user.id);
      if (isSelfRow && String(existingById.values[USR_COL.role]) !== role) return { ok: false, error: USR_MSG_SELF_ROLE };
      // 改自己且角色不變（例如改顯示名稱）不算動到別人的高權限帳號
      if (!isSelfRow && usrRoleIsSuper_(existingById.values[USR_COL.role])) return { ok: false, error: USR_MSG_ADMIN_ONLY };
    }
    if (existingByUsername && existingByUsername.row !== existingById.row) {
      return { ok: false, error: USR_MSG_USERNAME_TAKEN };
    }
  }

  // ── 寫入 ─────────────────────────────────────────────────
  if (isInsert) {
    var newId = generateNextUserId_();
    var salt = Utilities.getUuid();
    var hash = hashPassword_(password, salt);
    var createdAt = usrFormatTaipeiDatetime_(new Date());

    var row = [];
    row[USR_COL.id] = newId;
    row[USR_COL.username] = username;
    row[USR_COL.name] = authSafeCell_(name); // users 姓名欄不是純文字格式，防公式注入（2026-10-12）
    row[USR_COL.role] = role;
    row[USR_COL.node] = node;
    row[USR_COL.salt] = salt;
    row[USR_COL.hash] = hash;
    row[USR_COL.active] = 'TRUE';
    row[USR_COL.created_at] = createdAt;
    row[USR_COL.last_login_at] = '';

    var usersSheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
    usrSetTextFormat_(usersSheet.getRange(usersSheet.getLastRow() + 1, USR_COL.username + 1)); // 帳號欄純文字
    appendUsersRow_(row);
    return { ok: true, data: { id: newId } };
  }

  // 修改：只寫 username／name／role／node 這四格（B:E）。整列回寫會把同一時間別人登入寫進去的
  // last_login_at、改密碼寫進去的 salt／hash 蓋回舊值（GPT 上線前審第 12 條）
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  usrSetTextFormat_(sheet.getRange(existingById.row, USR_COL.username + 1)); // 帳號欄純文字（GPT 複審第 5 條）
  sheet.getRange(existingById.row, USR_COL.username + 1, 1, 4).setValues([[username, authSafeCell_(name), role, node]]);
  return { ok: true, data: { id: existingById.values[USR_COL.id] } };
}

// ============================================================
// 4. setActive（spec §5.2）—— 寫入大寫字串 TRUE／FALSE
// ============================================================

function handleSetActive_(token, payload) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  payload = payload || {};
  var id = payload.id ? String(payload.id).trim() : '';
  if (!id) return { ok: false, error: USR_MSG_ID_REQUIRED };
  if (typeof payload.active !== 'boolean') return { ok: false, error: USR_MSG_ACTIVE_INVALID };

  var found = findUsrRowById_(id);
  if (!found) return { ok: false, error: USR_MSG_NOT_FOUND };
  // 同仁帳號停用／啟用要走 staffSetActive，才會同步 staff 分頁的狀態（2026-10-12）
  if (String(found.values[USR_COL.role]) === 'staff') return { ok: false, error: USR_MSG_STAFF_ELSEWHERE };
  if (!usrActorIsAdmin_(auth) && usrRoleIsSuper_(found.values[USR_COL.role])) return { ok: false, error: USR_MSG_ADMIN_ONLY };

  if (!payload.active) {
    if (String(found.values[USR_COL.id]) === String(auth.user.id)) return { ok: false, error: USR_MSG_SELF_DEACTIVATE };
    if (String(found.values[USR_COL.role]) === 'admin' && !usrOtherActiveAdminExists_(found.values[USR_COL.id])) return { ok: false, error: USR_MSG_LAST_ADMIN };
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.active + 1).setValue(payload.active ? 'TRUE' : 'FALSE');
  // 停用再啟用後，停用前簽的舊 token 不得復活（Fable 上線前審第 5 條）
  setTokenAfter_(found.row);

  return { ok: true, data: {} };
}

// ============================================================
// 5. resetPassword（spec §5.2）—— 新隨機 salt，hashPassword_ 重算
// ============================================================

function handleResetPassword_(token, payload) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  payload = payload || {};
  var id = payload.id ? String(payload.id).trim() : '';
  var newPassword = (payload.newPassword === undefined || payload.newPassword === null)
    ? '' : String(payload.newPassword);

  if (!id) return { ok: false, error: USR_MSG_ID_REQUIRED };
  if (newPassword.length < 8) return { ok: false, error: USR_MSG_PASSWORD_TOO_SHORT };

  var found = findUsrRowById_(id);
  if (!found) return { ok: false, error: USR_MSG_NOT_FOUND };
  // 同仁帳號：admin 直接設密碼會讓「還沒認領」的編號跳過認領就能登入（2026-10-12）
  if (String(found.values[USR_COL.role]) === 'staff') return { ok: false, error: USR_MSG_STAFF_ELSEWHERE };
  if (!usrActorIsAdmin_(auth) && usrRoleIsSuper_(found.values[USR_COL.role])) return { ok: false, error: USR_MSG_ADMIN_ONLY };

  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(newPassword, newSalt);

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.salt + 1, 1, 2).setValues([[newSalt, newHash]]);
  // admin 幫人重設密碼後，對方所有舊登入失效（Fable 上線前審第 5 條）
  setTokenAfter_(found.row);

  return { ok: true, data: {} };
}

// ============================================================
// 5b. changePassword（2026-08-17 新增，Eason 指定「同仁可自己改密碼」）
//
// 與 handleResetPassword_ 是**兩件不同的事**，刻意不共用：
//   - resetPassword：admin 幫別人重設，要 platform.users 權限，**不驗舊密碼**，指定 id。
//   - changePassword：本人改自己的，**任何登入者都可用**（不需要任何 perm），
//     **一定要驗舊密碼**，而且 id 一律取自 token（不收 payload 的 id）——
//     少了任何一條，就會變成「登入任何帳號即可改他人密碼」的提權漏洞。
//
// 舊密碼錯誤不動登入失敗鎖定計數（本人改密碼打錯字不該把自己鎖在登入門外），
// 但另有一組「本人驗密碼」計數（2026-10-12，usrVerifySelfPassword_）：同一 user 15 分鐘錯 5 次，
// 改密碼／改手機鎖 15 分鐘——否則偷到 token 的人可以無限次猜舊密碼。
// ============================================================

function handleChangePassword_(token, payload) {
  var me = handleMe_(token);          // 驗 token＋重查 active，與其他 action 同一條鏈
  if (!me.ok) return me;

  payload = payload || {};
  var oldPassword = (payload.oldPassword === undefined || payload.oldPassword === null)
    ? '' : String(payload.oldPassword);
  var newPassword = (payload.newPassword === undefined || payload.newPassword === null)
    ? '' : String(payload.newPassword);

  if (newPassword.length < 8) return { ok: false, error: USR_MSG_PASSWORD_TOO_SHORT };

  // id 只認 token 裡的身分：payload 就算夾帶 id 也一律忽略（見上方說明）
  var found = findUsrRowById_(me.data.user.id);
  if (!found) return { ok: false, error: USR_MSG_NOT_FOUND };

  var verified = usrVerifySelfPassword_(found.values[USR_COL.id], oldPassword, found.values);
  if (!verified.ok) return verified;
  if (newPassword === oldPassword) {
    return { ok: false, error: USR_MSG_PASSWORD_SAME };
  }

  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(newPassword, newSalt);

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.salt + 1, 1, 2).setValues([[newSalt, newHash]]);
  // 2026-10-11：改密碼後其他裝置上的舊登入一律失效（docs/personnel/spec.md §4.1b）；
  // 本次這台換發新 token，前端收到後替換，不必重新登入
  var revokedAt = setTokenAfter_(found.row);
  var fresh = findUserById_(me.data.user.id);
  return { ok: true, data: { token: issueToken_(rowToUser_(fresh.values), revokedAt + 1) } };
}

// ============================================================
// 6. listRoles（spec §5.2，2026-08-15 新增）—— 角色清單一律由 roles 分頁回傳，
//    不得在前端／人員管理模組硬編碼角色清單。perms 用 Auth.gs 已有的 getRolePerms_
//    展開成陣列（逗號分隔字串；'*' 展開成 ['*']），與 handleLogin_/handleMe_ 的邏輯保持同一份正本。
// ============================================================

function handleListRoles_(token) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_ROLES);
  if (!sheet) return { ok: true, data: { roles: [] } };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, data: { roles: [] } };

  var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // role, name_zh（perms 欄改用 getRolePerms_ 查）
  var roles = rows.map(function (r) {
    var role = String(r[0]);
    return { role: role, name_zh: r[1], perms: getRolePerms_(role) };
  });

  return { ok: true, data: { roles: roles } };
}
