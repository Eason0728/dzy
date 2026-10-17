/**
 * 一次性：建立第一個系統管理者帳號
 *
 * 雞生蛋問題：人員管理需要 platform.users 權限，但權限要有帳號才有——
 * 所以第一個帳號只能從編輯器手動生出來。
 *
 * 使用方式（Eason 操作，Claude 全程看不到密碼）：
 *   1. Apps Script 編輯器左側「專案設定」→「指令碼屬性」→ 新增
 *        BOOTSTRAP_USERNAME = 你要的帳號（例 eason）
 *        BOOTSTRAP_PASSWORD = 你要的密碼（至少 8 個字元）
 *   2. 回到編輯器，函式選 bootstrapAdmin，按執行
 *   3. 執行完它會**自動刪掉那兩個屬性**，密碼不會留在任何地方
 *
 * 這支函式刻意做成無參數（編輯器的下拉執行不會帶參數，帶參數的版本會收到 undefined），
 * 而且**只要 users 分頁已經有任何一列資料就拒絕執行**——它只能用來開第一個帳號，
 * 不會變成一支「隨時可以偷加管理員」的後門。之後要加人一律走系統裡的人員管理畫面。
 */
function bootstrapAdmin() {
  var props = PropertiesService.getScriptProperties();
  var username = String(props.getProperty('BOOTSTRAP_USERNAME') || '').trim();
  var password = String(props.getProperty('BOOTSTRAP_PASSWORD') || '');

  if (!username || !password) {
    Logger.log('❌ 請先到「專案設定 → 指令碼屬性」設好 BOOTSTRAP_USERNAME 與 BOOTSTRAP_PASSWORD');
    return;
  }
  if (password.length < 8) {
    Logger.log('❌ 密碼至少要 8 個字元，目前 ' + password.length + ' 個。請改掉指令碼屬性再執行一次');
    return;
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName('users');
  if (!sheet) {
    Logger.log('❌ 找不到 users 分頁，請先執行 setup()');
    return;
  }
  if (sheet.getLastRow() > 1) {
    Logger.log('❌ users 分頁已經有 ' + (sheet.getLastRow() - 1) + ' 筆帳號，這支只能用來開第一個帳號。');
    Logger.log('　 要再加人請登入系統走「人員管理」；忘記密碼請用人員管理的重設密碼。');
    return;
  }

  var salt = Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

  // 欄序照 Setup.gs 的 HEADERS.users：
  // id／username／name／role／node／salt／hash／active／created_at／last_login_at
  sheet.appendRow(['u001', username, '系統管理者', 'admin', '', salt, hash, 'TRUE', now, '']);

  props.deleteProperty('BOOTSTRAP_USERNAME');
  props.deleteProperty('BOOTSTRAP_PASSWORD');

  Logger.log('✅ 已建立第一個帳號：' + username + '（id u001，角色 admin）');
  Logger.log('　 指令碼屬性裡的帳號與密碼已刪除。');
  Logger.log('　 之後要加人請登入系統走「人員管理」，不要再用這支。');
}

/**
 * 救回管理員：忘了管理員密碼、或管理員帳號被停用／降級而進不去時，從編輯器（或 mini 的 run-fn）執行。
 *
 * 使用方式（Eason 操作，Claude 全程看不到密碼）：
 *   1. 指令碼屬性新增 BOOTSTRAP_USERNAME（users 分頁裡已存在的帳號）與 BOOTSTRAP_PASSWORD（至少 8 個字元）
 *   2. 執行 rescueAdmin
 *   3. 執行完自動刪掉那兩個屬性
 *
 * 只救既有帳號，找不到就停（不會新建，所以不是新增管理員的後門）。
 * 會做的事：啟用、role 改 admin、換新密碼（新 salt／hash）、token_after 設現在（舊 token 全部失效）、
 * 清掉該帳號各來源的登入失敗鎖定與「本人改密碼」的失敗計數。只寫該列需要的格，其餘欄位不動。
 * 刻意不進 Code.gs 分派表：網頁 API 叫不到，只能從編輯器或 run-fn 白名單執行。
 */
function rescueAdmin() {
  var props = PropertiesService.getScriptProperties();
  var username = String(props.getProperty('BOOTSTRAP_USERNAME') || '').trim();
  var password = String(props.getProperty('BOOTSTRAP_PASSWORD') || '');

  if (!username || !password) {
    Logger.log('❌ 請先到「專案設定 → 指令碼屬性」設好 BOOTSTRAP_USERNAME 與 BOOTSTRAP_PASSWORD');
    return;
  }
  if (password.length < 8) {
    Logger.log('❌ 密碼至少要 8 個字元，目前 ' + password.length + ' 個。請改掉指令碼屬性再執行一次');
    return;
  }
  var found = findUserRow_(username);
  if (!found) {
    Logger.log('❌ users 分頁找不到帳號「' + username + '」。這支只救既有帳號，不會新建；請確認帳號拼法（不分大小寫）');
    return;
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(AUTH_SHEET_USERS);
  var salt = Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  sheet.getRange(found.row, AUTH_USERS_COL.role + 1).setValue('admin');
  sheet.getRange(found.row, AUTH_USERS_COL.salt + 1, 1, 2).setValues([[salt, hash]]);
  sheet.getRange(found.row, AUTH_USERS_COL.active + 1).setValue('TRUE');
  setTokenAfter_(found.row);

  clearLoginState_(String(found.values[AUTH_USERS_COL.username]));
  CacheService.getScriptCache().remove('usr_selfpw:' + String(found.values[AUTH_USERS_COL.id]));

  props.deleteProperty('BOOTSTRAP_USERNAME');
  props.deleteProperty('BOOTSTRAP_PASSWORD');

  Logger.log('✅ 已救回帳號：' + String(found.values[AUTH_USERS_COL.username]) + '（角色 admin、已啟用、新密碼已生效、舊登入已失效）');
  Logger.log('　 指令碼屬性裡的帳號與密碼已刪除。');
}
