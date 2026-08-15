/**
 * 鼎兆元管理系統｜平台後端 — 對外入口（T1-5）
 * 對應 docs/spec.md §4.8 送出與回傳格式／§5.2 API actions。
 *
 * 這是整個系統唯一的後端進入點。doPost 白名單分派七個 action：
 * login／me／listUsers／saveUser／setActive／resetPassword／listRoles，未知 action 一律拒絕。
 * 不管內部任何一支 handler 是否拋錯，doPost 一律回 {ok,...}，絕不讓例外變成 500。
 *
 * 錯誤訊息規則（spec §5.2，2026-08-15 補）：doPost 在 catch 到「未預期例外」時，
 * 一律回前端通用訊息 CODE_MSG_INTERNAL_ERROR，細節只寫進伺服器端 console.error（Apps Script
 * 會送進 Stackdriver），避免例外訊息帶出分頁名、函式名等內部結構洩漏給前端。
 * 注意：handler 自己正常 return 的 {ok:false, error:'...'}（業務訊息，例如帳號或密碼錯誤、
 * 沒有權限）不是「被 catch 的例外」，dispatch_ 直接 return 那個物件，不會經過這個 catch，
 * 訊息原樣保留，不受這條規則影響。
 */

var CODE_ALLOWED_ACTIONS = ['login', 'me', 'listUsers', 'saveUser', 'setActive', 'resetPassword', 'listRoles'];
var CODE_MSG_BAD_REQUEST = '請求格式錯誤';
var CODE_MSG_UNKNOWN_ACTION = '不支援的操作';
var CODE_MSG_INTERNAL_ERROR = '系統忙碌中，請稍後再試';

function doPost(e) {
  var result;
  try {
    result = dispatch_(e);
  } catch (err) {
    logInternalError_(err);
    result = { ok: false, error: CODE_MSG_INTERNAL_ERROR };
  }
  return jsonOutput_(result);
}

/** 未預期例外只留在伺服器端記錄，絕不把 err.message 原文送給前端（會洩漏分頁名／函式名等內部結構） */
function logInternalError_(err) {
  var message = (err && err.message) ? err.message : String(err);
  var stack = (err && err.stack) ? err.stack : '';
  console.error('[doPost] unexpected error: ' + message + (stack ? '\n' + stack : ''));
}

function doGet(e) {
  // 健康檢查，不接受任何 action（e 完全不解析）
  return jsonOutput_({ ok: true, data: { service: 'dzy-platform' } });
}

/** 解析 body、白名單檢查、分派到對應 handler。任何格式問題都回一般物件，不拋例外往外丟 */
function dispatch_(e) {
  var body = parseJsonBody_(e);
  if (body === null) {
    return { ok: false, error: CODE_MSG_BAD_REQUEST };
  }

  var action = body.action;
  if (typeof action !== 'string' || !action) {
    return { ok: false, error: CODE_MSG_BAD_REQUEST };
  }
  if (CODE_ALLOWED_ACTIONS.indexOf(action) === -1) {
    return { ok: false, error: CODE_MSG_UNKNOWN_ACTION };
  }

  var token = body.token;
  var payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  switch (action) {
    case 'login':
      return handleLogin_(payload);
    case 'me':
      return handleMe_(token);
    case 'listUsers':
      return handleListUsers_(token);
    case 'saveUser':
      return handleSaveUser_(token, payload);
    case 'setActive':
      return handleSetActive_(token, payload);
    case 'resetPassword':
      return handleResetPassword_(token, payload);
    case 'listRoles':
      return handleListRoles_(token);
    default:
      // 理論上到不了這裡（上面白名單已擋），留著防呆
      return { ok: false, error: CODE_MSG_UNKNOWN_ACTION };
  }
}

/** 前端用 Content-Type: text/plain 送 JSON 字串（避開 CORS preflight）；body 不是合法 JSON 一律回 null */
function parseJsonBody_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') return null;
  var parsed;
  try {
    parsed = JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function jsonOutput_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
