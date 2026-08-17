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

function appendUsersRow_(rowValues) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.appendRow(rowValues);
}

function writeUsersRow_(rowNumber, rowValues) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(rowNumber, 1, 1, USR_COL_COUNT).setValues([rowValues]);
}

// ============================================================
// 2. listUsers（spec §5.2）—— 絕不含 salt／hash
// ============================================================

function handleListUsers_(token) {
  var auth = requirePlatformUsers_(token);
  if (!auth.ok) return auth;

  var rows = readUsersRawRows_();
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
  if (!name) return { ok: false, error: USR_MSG_NAME_REQUIRED };
  if (!role) return { ok: false, error: USR_MSG_ROLE_REQUIRED };
  if (!roleExists_(role)) return { ok: false, error: USR_MSG_ROLE_NOT_FOUND };
  if (!isValidNode_(node)) return { ok: false, error: USR_MSG_NODE_INVALID };

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
    row[USR_COL.name] = name;
    row[USR_COL.role] = role;
    row[USR_COL.node] = node;
    row[USR_COL.salt] = salt;
    row[USR_COL.hash] = hash;
    row[USR_COL.active] = 'TRUE';
    row[USR_COL.created_at] = createdAt;
    row[USR_COL.last_login_at] = '';

    appendUsersRow_(row);
    return { ok: true, data: { id: newId } };
  }

  // 修改：不改密碼（帶了 password 也忽略），created_at 沿用既有值原樣寫回（不清空、不重產）
  var values = existingById.values.slice();
  values[USR_COL.username] = username;
  values[USR_COL.name] = name;
  values[USR_COL.role] = role;
  values[USR_COL.node] = node;
  // salt/hash/active/created_at/last_login_at 保留原值

  writeUsersRow_(existingById.row, values);
  return { ok: true, data: { id: values[USR_COL.id] } };
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

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.active + 1).setValue(payload.active ? 'TRUE' : 'FALSE');

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

  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(newPassword, newSalt);

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.salt + 1, 1, 2).setValues([[newSalt, newHash]]);

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
// 舊密碼錯誤的訊息刻意與登入失敗一致（不透露是哪個環節錯），也不動登入失敗鎖定計數
// （那是防猜帳號密碼的機制，本人改密碼打錯字不該把自己鎖在外面）。
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

  var currentSalt = found.values[USR_COL.salt];
  var currentHash = found.values[USR_COL.hash];
  if (hashPassword_(oldPassword, currentSalt) !== String(currentHash)) {
    return { ok: false, error: USR_MSG_OLD_PASSWORD_WRONG };
  }
  if (newPassword === oldPassword) {
    return { ok: false, error: USR_MSG_PASSWORD_SAME };
  }

  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(newPassword, newSalt);

  var sheet = SpreadsheetApp.getActive().getSheetByName(USR_SHEET_USERS);
  sheet.getRange(found.row, USR_COL.salt + 1, 1, 2).setValues([[newSalt, newHash]]);

  return { ok: true, data: {} };
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
