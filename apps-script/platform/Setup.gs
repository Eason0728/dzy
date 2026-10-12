/**
 * 鼎兆元管理系統｜平台後端 — 初始化（T0-3）
 * 對應 docs/spec.md §5.1。容器繫結於試算表「鼎兆元管理系統｜帳號權限」。
 *
 * 執行順序：Eason 在編輯器手動執行一次 setup() → 走完 OAuth 同意畫面 → 完成。
 * ⚠ 通行碼與密碼一律手動填進試算表，永遠不寫進本檔或任何 repo 內的檔案。
 */

const TAB_USERS = 'users';
const TAB_ROLES = 'roles';
const TAB_SECRETS = 'module_secrets';
const TAB_LOG = 'login_log';

/** 欄位順序即欄序，改這裡等於改契約——動之前先改 spec.md §5.1 */
const HEADERS = {
  users: ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
  roles: ['role', 'name_zh', 'perms'],
  module_secrets: ['backend_id', 'level', 'secret'],
  login_log: ['at', 'username', 'ip_hash', 'result']
};

/** 五個角色，權限碼照 spec.md §4.3。之後要調權限改這張表即可，不必動程式 */
const DEFAULT_ROLES = [
  ['admin', '系統管理者', '*'],
  ['manager', '部門主管', 'audit.read,dorm.read,dorm.write'],
  ['accountant', '會計', 'audit.read,audit.write'],
  ['storelead', '店長', 'audit.read.own'],
  ['staff', '員工', '']
];

/**
 * 既有系統的通行碼，secret 欄留空等 Eason 手動填。
 * audit 分 read／write 兩級（稽核後端本來就有主管碼與會計碼）；
 * dorm 後端只有一組後台碼，因此只有 write 一列。
 */
const DEFAULT_SECRETS = [
  ['audit', 'read', ''],
  ['audit', 'write', ''],
  ['dorm', 'write', '']
];

/** 要鎖成純文字的欄（1-based）。日期欄不鎖會被 Google 自動轉成 Date——稽核系統踩過這個雷 */
const TEXT_COLUMNS = {
  users: [9, 10],
  login_log: [1]
};

/** 主初始化：建四個分頁、寫表頭、填預設列、鎖文字格式、產 HMAC 金鑰 */
function setup() {
  const ss = SpreadsheetApp.getActive();

  // 試算表時區與腳本時區是「兩個」獨立設定，appsscript.json 只管得到後者。
  // 沒改這裡，日期欄會用美西時間算，台灣的凌晨會被記成前一天。
  if (ss.getSpreadsheetTimeZone() !== 'Asia/Taipei') {
    const before = ss.getSpreadsheetTimeZone();
    ss.setSpreadsheetTimeZone('Asia/Taipei');
    Logger.log('　 試算表時區：' + before + ' → Asia/Taipei');
  }

  ensureTab_(ss, TAB_USERS, HEADERS.users, []);
  ensureTab_(ss, TAB_ROLES, HEADERS.roles, DEFAULT_ROLES);
  ensureTab_(ss, TAB_SECRETS, HEADERS.module_secrets, DEFAULT_SECRETS);
  ensureTab_(ss, TAB_LOG, HEADERS.login_log, []);

  removeDefaultTab_(ss);
  ensureHmacSecret_();

  Logger.log('✅ 初始化完成：' + ss.getUrl());
  Logger.log('　 分頁：' + ss.getSheets().map(function (s) { return s.getName(); }).join('／'));
  Logger.log('　 下一步（人工）：到 ' + TAB_SECRETS + ' 分頁把三列的 secret 欄填上既有系統的通行碼');
}

/** 建立或補齊一個分頁：表頭、凍結、粗體、文字格式；只有在完全空的時候才寫預設列 */
function ensureTab_(ss, name, headers, defaultRows) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    Logger.log('新增分頁：' + name);
  }

  const cols = TEXT_COLUMNS[name] || [];
  cols.forEach(function (c) {
    sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
  });

  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);

  if (sh.getLastRow() <= 1 && defaultRows.length) {
    sh.getRange(2, 1, defaultRows.length, headers.length).setValues(
      defaultRows.map(function (r) { return padRow_(r, headers.length); })
    );
    Logger.log('　 寫入 ' + defaultRows.length + ' 筆預設列到 ' + name);
  }

  sh.autoResizeColumns(1, headers.length);
}

/** 補齊到指定欄數，避免 setValues 因長度不符報錯 */
function padRow_(row, len) {
  const out = row.slice(0, len);
  while (out.length < len) out.push('');
  return out;
}

/** 移除 clasp 建立試算表時附贈的空白「工作表1」 */
function removeDefaultTab_(ss) {
  const known = [TAB_USERS, TAB_ROLES, TAB_SECRETS, TAB_LOG];
  ss.getSheets().forEach(function (sh) {
    const name = sh.getName();
    if (known.indexOf(name) !== -1) return;
    if (sh.getLastRow() > 0 || sh.getLastColumn() > 0) {
      Logger.log('⚠ 分頁「' + name + '」不在預期清單內但有內容，保留不動');
      return;
    }
    ss.deleteSheet(sh);
    Logger.log('刪除空白分頁：' + name);
  });
}

/** token 簽章用的 HMAC 金鑰，存 Script Properties，永不進 repo、永不回傳前端 */
function ensureHmacSecret_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('HMAC_SECRET')) {
    Logger.log('　 HMAC 金鑰已存在，不覆蓋');
    return;
  }
  props.setProperty('HMAC_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('　 已產生新的 HMAC 金鑰');
}

/** 診斷：確認這支腳本掛在哪個帳號、哪份試算表下（授權後跑一次確認） */
function diagWhoAmI() {
  const ss = SpreadsheetApp.getActive();
  Logger.log('執行帳號：' + Session.getEffectiveUser().getEmail());
  Logger.log('試算表：' + ss.getName());
  Logger.log('試算表 ID：' + ss.getId());
  Logger.log('時區：' + ss.getSpreadsheetTimeZone());
  Logger.log('分頁：' + ss.getSheets().map(function (s) { return s.getName(); }).join('／'));
  const secrets = ss.getSheetByName(TAB_SECRETS);
  if (secrets && secrets.getLastRow() > 1) {
    const rows = secrets.getRange(2, 1, secrets.getLastRow() - 1, 3).getValues();
    rows.forEach(function (r) {
      Logger.log('通行碼 ' + r[0] + '/' + r[1] + '：' + (r[2] ? '已填' : '❌ 尚未填'));
    });
  }
}
