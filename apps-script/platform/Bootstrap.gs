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
