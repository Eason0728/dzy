/**
 * Prefs.gs — 每人自己的偏好設定（2026-11-17 Eason：「我的資料 → 設定」每個功能的提醒開關；docs/alert-prefs/spec.md）
 *
 * 分頁 user_prefs：uid｜prefs_json｜updated_at（一個帳號一列，第一次存檔時自動建表）。
 * 目前只有一個鍵 alerts_off＝關掉提醒的模組 id 陣列（沒有這列＝全部開著）。
 * - myPrefsGet：任何已登入帳號（同仁、系統帳號都可），只讀自己的。純讀取。
 * - myPrefsSave：只寫自己的（身分只認 token，payload 夾帶 uid 一律忽略）；Code.gs MUTATING_ACTIONS 上鎖。
 * 不碰任何權限：關掉提醒只影響畫面，模組照樣點得進去。
 */
'use strict';

var PREF_SHEET = 'user_prefs';
var PREF_HEADERS = ['uid', 'prefs_json', 'updated_at'];
/** 模組 id 格式＝manifest-check 的 id 規則；上限避免塞爆儲存格 */
var PREF_MODULE_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
var PREF_MAX_OFF = 60;

/** 讀這個帳號那一列：{row, prefs} 或 null */
function prefFind_(uid) {
  var rows = stfReadRows_(PREF_SHEET, PREF_HEADERS.length);
  var key = String(uid);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === key) {
      var prefs = {};
      try { prefs = JSON.parse(String(rows[i][1] || '{}')) || {}; } catch (e) { prefs = {}; }
      if (typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
      return { row: i + 2, prefs: prefs, updated_at: String(rows[i][2] || '') };
    }
  }
  return null;
}

/** 清洗 alerts_off：只收合法模組 id 字串、去重、保持順序；格式錯回 null */
function prefCleanOff_(list) {
  if (!Array.isArray(list)) return null;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var id = list[i];
    if (typeof id !== 'string' || !PREF_MODULE_ID_RE.test(id)) return null;
    if (out.indexOf(id) === -1) out.push(id);
  }
  if (out.length > PREF_MAX_OFF) return null;
  return out;
}

function prefView_(found) {
  var off = found ? prefCleanOff_(found.prefs.alerts_off) : [];
  return { alerts_off: off || [], updated_at: found ? found.updated_at : '' };
}

function handleMyPrefsGet_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  return { ok: true, data: prefView_(prefFind_(sess.user.id)) };
}

function handleMyPrefsSave_(token, payload) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  var off = prefCleanOff_(payload && payload.alerts_off);
  if (off === null) return { ok: false, error: '設定格式不正確，請重新整理後再試' };
  var uid = String(sess.user.id);
  var found = prefFind_(uid);
  var prefs = found ? found.prefs : {};
  prefs.alerts_off = off;
  var now = stfNowText_();
  var row = [uid, JSON.stringify(prefs), now];
  stfEnsureSheet_(SpreadsheetApp.getActive(), PREF_SHEET, PREF_HEADERS, []);
  if (found) stfWriteRow_(PREF_SHEET, found.row, row, PREF_HEADERS.length);
  else stfAppendRow_(PREF_SHEET, row, PREF_HEADERS.length);
  return { ok: true, data: { alerts_off: off, updated_at: now } };
}
