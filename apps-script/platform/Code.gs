/**
 * 鼎兆元管理系統｜平台後端 — 對外入口（T1-5）
 * 對應 docs/spec.md §4.8 送出與回傳格式／§5.2 API actions。
 *
 * 這是整個系統唯一的後端進入點。doPost 白名單分派六個 action：
 * login／me／listUsers／saveUser／setActive／resetPassword，未知 action 一律拒絕。
 * 不管內部任何一支 handler 是否拋錯，doPost 一律回 {ok,...}，絕不讓例外變成 500。
 */

var CODE_ALLOWED_ACTIONS = ['login', 'me', 'listUsers', 'saveUser', 'setActive', 'resetPassword'];
var CODE_MSG_BAD_REQUEST = '請求格式錯誤';
var CODE_MSG_UNKNOWN_ACTION = '不支援的操作';

function doPost(e) {
  var result;
  try {
    result = dispatch_(e);
  } catch (err) {
    result = { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
  return jsonOutput_(result);
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
