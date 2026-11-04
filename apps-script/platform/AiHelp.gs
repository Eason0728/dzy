/**
 * AI 小幫手（平台後端，docs/ai-helper/spec.md v1.1，§12 優先於前文、§12.10 優先於 §12.9）。
 * Phase 1：資料表、管理頁 action、給 Mac mini node 路由用的全域函式。AI 呼叫在 node（.gs 不能連外）。
 *
 * 一、管理頁 action（Code.gs 白名單＋分派；一律要 platform.aihelp＝鎖碼，第一個月只有 role admin；aihSetup 只限 role admin）
 *    aihSetup、aihKbList、aihKbSave、aihKbImport、aihKbHist、aihPendingList、aihPendingSet、aihUsage、aihLogList、aihPauseSet
 *    回應形狀照 Eval.gs：成功 {ok:true,data}；失敗 {ok:false, error:'<代碼>', message:'<中文>'}（代碼：unauthorized／forbidden／bad_request／not_found／conflict／busy／not_inited）。
 * 二、node 專用全域函式（⚠ 8 支，不准進 Code.gs 的白名單與分派；測試比對 Code.gs 全文）：
 *    aiHelpAuthorize_(token)、aihKbVisible_(uid)、aihLogAppend_(row)、aihPendingAdd_(row)、aihFeedback_(uid, id, good)、aihPurge_(nowMs)、aihConvGet_(uid, conv)、aihDigest_(nowMs)
 *    回 {ok:true, …} 或 {ok:false, code, error}（沒有 data 這層，照 proxyAuthorize_ 的做法）。
 * 三、資料表（aihSetup 只補不覆蓋；表頭不符整個停、一張都不建）：aih_kb、aih_kb_hist（只追加）、aih_log、aih_pending。
 * 規矩：
 * - 試算表在 mini 上是假試算表，會把「像數字的字串」轉成數字：比對 id 一律 String()。
 * - 寫入一律包 aihWithLock_（LockService，同 Eval.gs evWithLock_）；寫列前先設純文字格式（stfWriteRow_／stfAppendBlock_）。
 * - 知識庫每次新增／修改／上架／下架／到期下架、暫停開關都寫 aih_kb_hist 一整列快照（誰、何時、做了什麼）。
 * - 依賴：Auth.gs、Staff.gs（stf*）、Perms.gs（permName_、permStaffAddUnitOf_、permActingUnitsOf_）、AiHelpPages.gs（AIH_PAGES）。
 */

// ============================================================
// 1. 常數
// ============================================================

var AIH_SH = { kb: 'aih_kb', hist: 'aih_kb_hist', log: 'aih_log', pending: 'aih_pending' };
var AIH_H = {
  kb: ['id', 'm', 'v', 'question', 'answer', 'who', 'go_m', 'go_v', 'status', 'source', 'verified_at', 'expires_at', 'updated_at', 'updated_by'],
  hist: ['hist_id', 'kb_id', 'action', 'snapshot', 'by', 'at'],
  // conv：對話 id（§12.2，後端取同 uid、同 conv 最近 3 組問答）；其餘照 spec §7
  log: ['id', 'ts', 'uid', 'conv', 'm', 'v', 'q', 'kind', 'answer', 'kb_ids', 'tok_in', 'tok_out', 'usd', 'feedback'],
  pending: ['id', 'log_id', 'ts', 'q', 'm', 'v', 'reason', 'status', 'kb_id']
};
var AIH_KB_STATUS = ['draft', 'live', 'off'];
var AIH_PENDING_STATUS = ['open', 'done', 'ignored'];
var AIH_PENDING_REASON = ['unknown', 'thumbs_down'];
var AIH_KB_VALID_DAYS = 180;            // §12.10-2：expires_at＝verified_at＋180 天
var AIH_RETAIN_DAYS = 90;               // §12.6：aih_log 與 aih_pending 的 q 保存 90 天
var AIH_PAUSE_PROP = 'AIH_PAUSED';      // Script Property，恰好 '1' 才算暫停（§12.8）
var AIH_MAX = { question: 200, answer: 1500, who: 100, source: 200, q: 1000, logAnswer: 2000 };
var AIH_ID_LOG_RE = /^aih_\d{14}_[0-9a-f]{4}$/;
var AIH_ID_PENDING_RE = /^aip_\d{14}_[0-9a-f]{4}$/;
var AIH_ID_CONV_RE = /^aic_\d{14}_[0-9a-f]{4}$/;
var AIH_ID_KB_RE = /^kb\d{4,}$/;
var AIH_SOURCE_ZH = { role: '系統角色', title: '職稱', dept: '部門', exception: '個別例外', implied: '因為能填稽核單', acting: '兼任店長' };

// ============================================================
// 2. 小工具
// ============================================================

function aihFail_(error, message) { return { ok: false, error: error, message: message || '' }; }
function aihStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
/** 現在（毫秒）。獨立成函式，測試可在 sandbox 覆寫 */
function aihNow_() { return Date.now(); }
function aihIso_(ms) { return new Date(ms === undefined ? aihNow_() : ms).toISOString(); }
function aihPad_(n) { return (n < 10 ? '0' : '') + n; }
/** 毫秒 → 台北日 'YYYY-MM-DD' */
function aihTaipeiDay_(ms) {
  var d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + aihPad_(d.getUTCMonth() + 1) + '-' + aihPad_(d.getUTCDate());
}
function aihTaipeiMonth_(ms) { return aihTaipeiDay_(ms).slice(0, 7); }
/** 日期值（Date 或 'YYYY-MM-DD'／'YYYY/M/D'）→ 'YYYY-MM-DD'；不存在的日期、壞格式回 '' */
function aihNormDate_(v) {
  if (v && typeof v === 'object' && typeof v.getTime === 'function') return isNaN(v.getTime()) ? '' : aihTaipeiDay_(v.getTime());
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(aihStr_(v));
  if (!m) return '';
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return y + '-' + aihPad_(mo) + '-' + aihPad_(d);
}
function aihAddDays_(ymd, n) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  var t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return t.getUTCFullYear() + '-' + aihPad_(t.getUTCMonth() + 1) + '-' + aihPad_(t.getUTCDate());
}
/** 時間戳 → 毫秒。數字、Date、ISO（含 Z／offset）、無時區的 'YYYY-MM-DD HH:mm:ss'（視為台北時間）；解析不了回 NaN */
function aihParseTs_(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.getTime === 'function') return v.getTime();
  var s = aihStr_(v);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return NaN;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s = s.replace(' ', 'T') + '+08:00';
  return Date.parse(s.replace(' ', 'T'));
}
function aihEnabledMsg_() { return 'AI 小幫手還沒初始化，請系統管理者先按「初始化小幫手」'; }
function aihNotInited_() { return aihFail_('not_inited', aihEnabledMsg_()); }
function aihReady_() {
  for (var k in AIH_SH) if (!stfSheet_(AIH_SH[k])) return false;
  return true;
}
function aihWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return aihFail_('busy', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}
function aihPaused_() {
  try { return String(PropertiesService.getScriptProperties().getProperty(AIH_PAUSE_PROP) || '') === '1'; } catch (e) { return false; }
}

// 讀寫（整列空白的列略過：aihRewrite_ 會把被刪的列清成空白）
function aihRows_(key) {
  var h = AIH_H[key];
  return stfReadRows_(AIH_SH[key], h.length).map(function (v, i) {
    if (v.every(function (x) { return x === '' || x === null || x === undefined; })) return null;
    var o = { _row: i + 2 };
    h.forEach(function (name, j) { o[name] = v[j]; });
    return o;
  }).filter(Boolean);
}
function aihToRow_(key, o) { return AIH_H[key].map(function (h) { var v = o[h]; return (v === undefined || v === null) ? '' : v; }); }
function aihAppend_(key, o) { stfAppendBlock_(AIH_SH[key], [aihToRow_(key, o)], AIH_H[key].length, true); }
function aihWriteAt_(key, rowNumber, o) { stfWriteRow_(AIH_SH[key], rowNumber, aihToRow_(key, o), AIH_H[key].length); }
/** 整張重寫資料列（同 Eval.gs evRewrite_：先清成空白再寫回）。objs＝要留下的列物件 */
function aihRewrite_(key, objs) {
  var h = AIH_H[key];
  var sh = stfSheet_(AIH_SH[key]);
  var last = sh.getLastRow();
  if (last >= 2) {
    var blank = [];
    for (var i = 0; i < last - 1; i++) { var r = []; for (var j = 0; j < h.length; j++) r.push(''); blank.push(r); }
    sh.getRange(2, 1, last - 1, h.length).setValues(blank);
  }
  if (objs.length) {
    var range = sh.getRange(2, 1, objs.length, h.length);
    range.setNumberFormat('@');
    range.setValues(objs.map(function (o) { return aihToRow_(key, o); }));
  }
  // 尾端空白列順手刪掉（真 Apps Script 有 deleteRows；假試算表沒有就留著，讀取時整列空白會被略過）
  if (typeof sh.deleteRows === 'function' && last - 1 > objs.length) sh.deleteRows(objs.length + 2, last - 1 - objs.length);
}

/** 知識庫列 → 對外物件（只含 AIH_H.kb 欄位，id 等一律字串） */
function aihKbObj_(r) {
  return {
    id: aihStr_(r.id), m: aihStr_(r.m), v: aihStr_(r.v), question: aihStr_(r.question), answer: aihStr_(r.answer), who: aihStr_(r.who),
    go_m: aihStr_(r.go_m), go_v: aihStr_(r.go_v), status: aihStr_(r.status), source: aihStr_(r.source),
    verified_at: aihNormDate_(r.verified_at), expires_at: aihNormDate_(r.expires_at), updated_at: aihStr_(r.updated_at), updated_by: aihStr_(r.updated_by)
  };
}

/** 追加一列 aih_kb_hist（快照＝完整知識庫物件；暫停開關存 {paused}）。呼叫端要已在鎖內 */
function aihHistAppend_(kbId, action, snapshot, by) {
  var rows = aihRows_('hist');
  var max = 0;
  rows.forEach(function (r) { var n = Number(String(r.hist_id).replace(/^kh/, '')); if (n > max) max = n; });
  var id = 'kh' + ('0000' + (max + 1)).slice(-4);
  if (max + 1 > 9999) id = 'kh' + (max + 1);
  aihAppend_('hist', { hist_id: id, kb_id: kbId, action: action, snapshot: JSON.stringify(snapshot), by: by, at: aihIso_() });
  return id;
}

// 頁面地圖
function aihPageList_() { return (typeof AIH_PAGES !== 'undefined' && Array.isArray(AIH_PAGES)) ? AIH_PAGES : []; }
function aihPageExists_(m, v) {
  return aihPageList_().some(function (p) { return p.m === m && (v === '' || p.v === v); });
}
/**
 * 某人（perms）看不看得到題目的頁面（§12.2）：m 空＝通用，人人可見；m 有、v 空＝該模組任一分頁看得到即可；
 * m、v 都有＝該分頁。模組層 requires_module 與分頁層 requires 都要過（任一碼即可；模組層空＝不通過、分頁層空＝通過，同殼 isModulePermitted ∧ isViewPermitted）；platform.login＝已登入本身，永遠成立。
 * 頁面不在地圖上（模組被拿掉）＝看不到（往關的方向失敗）。
 */
function aihPageVisible_(perms, m, v) {
  if (m === '') return true;
  var pages = aihPageList_().filter(function (p) { return p.m === m && (v === '' || p.v === v); });
  var any = function (reqs) {
    return reqs.some(function (c) { return c === 'platform.login' || hasPerm_(perms, c); });
  };
  // 模組層空陣列＝看不到（同殼 isModulePermitted 的 [].some）；分頁層空陣列＝通過（同 isViewPermitted）
  return pages.some(function (p) { return any(p.requires_module || []) && (!p.requires.length || any(p.requires)); });
}

// 進入點（管理 action 用）
function aihEnter_(token, adminOnly) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return aihFail_('unauthorized', sess.error);
  if (adminOnly) {
    if (String(sess.user.role) !== 'admin') return aihFail_('forbidden', '只有系統管理者可以初始化');
  } else if (!hasPerm_(sess.perms, 'platform.aihelp')) {
    return aihFail_('forbidden', '沒有權限');
  }
  return { ok: true, user: sess.user, by: aihStr_(sess.user.username) || aihStr_(sess.user.id) };
}

// ============================================================
// 3. aihSetup
// ============================================================

/** 只補不覆蓋；任何一張表頭與程式不符＝整個停（一張都不建），避免資料錯位 */
function handleAihSetup_(token) {
  var c = aihEnter_(token, true);
  if (!c.ok) return c;
  return aihWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var keys = Object.keys(AIH_SH);
    for (var i = 0; i < keys.length; i++) {
      var sh = ss.getSheetByName(AIH_SH[keys[i]]);
      if (!sh) continue;
      var h = AIH_H[keys[i]];
      // 比整列（含預期欄數以外的欄）：多一欄、少一欄都停
      var width = Math.max(sh.getLastColumn(), h.length);
      var existing = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
      while (existing.length && existing[existing.length - 1] === '') existing.pop();
      if (existing.length && existing.join('|') !== h.join('|')) {
        return aihFail_('bad_request', '分頁「' + AIH_SH[keys[i]] + '」的表頭與程式不一致，停止初始化以免資料錯位');
      }
    }
    var created = [], existed = [];
    keys.forEach(function (k) {
      if (ss.getSheetByName(AIH_SH[k])) existed.push(AIH_SH[k]); else created.push(AIH_SH[k]);
      stfEnsureSheet_(ss, AIH_SH[k], AIH_H[k], []);
    });
    return { ok: true, data: { created: created, existed: existed } };
  });
}

// ============================================================
// 4. 知識庫
// ============================================================

/** payload {q?, status?} → {items:[kb 欄位], paused} */
function handleAihKbList_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var q = aihStr_(payload.q).toLowerCase();
  var st = aihStr_(payload.status);
  if (st && AIH_KB_STATUS.indexOf(st) === -1) return aihFail_('bad_request', '狀態不正確');
  var items = aihRows_('kb').map(aihKbObj_).filter(function (o) {
    if (st && o.status !== st) return false;
    if (q && (o.question + '\n' + o.answer + '\n' + o.who + '\n' + o.source).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  return { ok: true, data: { items: items, paused: aihPaused_() } };
}

function aihCleanText_(v, field, max, required) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') return { error: field + '格式錯誤' };
  var s = v.trim();
  if (required && !s) return { error: field + '不能空白' };
  if (s.length > max) return { error: field + '太長（最多 ' + max + ' 字）' };
  return { value: s };
}

/**
 * payload {id?, m?, v?, question, answer, who?, go_m?, go_v?, status?, source?, verified_at?, expires_at?, expected_updated_at?}
 * 新題（沒 id）自動編號 kb0001…，status 預設 draft；改題（有 id）沒給的欄位維持原值，expected_updated_at 給了就必須等於目前 updated_at，否則 conflict。
 * verified_at 預設今天、expires_at 預設 verified_at＋180 天。完全沒變＝不寫、不留 hist（changed:false）。
 * hist action：create／publish（改成 live）／unpublish（改成 off）／update。
 */
function handleAihKbSave_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var id = aihStr_(payload.id);
  if (id && !AIH_ID_KB_RE.test(id)) return aihFail_('bad_request', '題目編號格式錯誤');
  return aihWithLock_(function () {
    var rows = aihRows_('kb');
    var cur = null;
    if (id) {
      rows.forEach(function (r) { if (aihStr_(r.id) === id) cur = r; });
      if (!cur) return aihFail_('not_found', '找不到這一題');
      if (payload.expected_updated_at !== undefined && aihStr_(payload.expected_updated_at) !== aihStr_(cur.updated_at)) {
        return aihFail_('conflict', '這一題已經被別人改過，請重新整理再改');
      }
    }
    var base = cur ? aihKbObj_(cur) : { id: '', m: '', v: '', question: '', answer: '', who: '', go_m: '', go_v: '', status: 'draft', source: '', verified_at: '', expires_at: '', updated_at: '', updated_by: '' };
    var f = {};
    var spec = [['question', '問題', AIH_MAX.question, true], ['answer', '答案', AIH_MAX.answer, true], ['who', '找誰', AIH_MAX.who, false],
      ['source', '依據文件', AIH_MAX.source, false], ['m', '頁面（模組）', 40, false], ['v', '頁面（分頁）', 40, false], ['go_m', '帶我去（模組）', 40, false], ['go_v', '帶我去（分頁）', 40, false]];
    for (var i = 0; i < spec.length; i++) {
      var k = spec[i][0];
      if (payload[k] === undefined) { f[k] = base[k]; if (spec[i][3] && !f[k]) return aihFail_('bad_request', spec[i][1] + '不能空白'); continue; }
      var t = aihCleanText_(payload[k], spec[i][1], spec[i][2], spec[i][3]);
      if (t.error) return aihFail_('bad_request', t.error);
      f[k] = t.value;
    }
    if (f.v && !f.m) return aihFail_('bad_request', '有分頁就要有模組');
    if (f.m && !aihPageExists_(f.m, f.v)) return aihFail_('bad_request', '頁面不在頁面地圖上');
    if ((f.go_m || f.go_v) && !(f.go_m && f.go_v && aihPageExists_(f.go_m, f.go_v))) return aihFail_('bad_request', '「帶我去」的頁面不在頁面地圖上');
    var status = payload.status === undefined ? (base.status || 'draft') : aihStr_(payload.status);
    if (AIH_KB_STATUS.indexOf(status) === -1) return aihFail_('bad_request', '狀態不正確');
    var verified = payload.verified_at === undefined ? base.verified_at : aihStr_(payload.verified_at);
    if (payload.verified_at !== undefined && verified !== '' && !aihNormDate_(verified)) return aihFail_('bad_request', '確認日期格式錯誤');
    verified = verified ? aihNormDate_(verified) : aihTaipeiDay_(aihNow_());
    var expires = payload.expires_at === undefined ? base.expires_at : aihStr_(payload.expires_at);
    if (payload.expires_at !== undefined && expires !== '' && !aihNormDate_(expires)) return aihFail_('bad_request', '到期日期格式錯誤');
    // 到期日：沒有（新題或空值）補 verified＋180 天；重新確認（verified_at 變了）而沒另外給 expires_at 也順延 180 天
    if (payload.expires_at === undefined && payload.verified_at !== undefined && base.verified_at && verified !== base.verified_at) expires = '';
    expires = expires ? aihNormDate_(expires) : aihAddDays_(verified, AIH_KB_VALID_DAYS);
    // 到期日必須晚於確認日；上架（live）的題目還必須晚於台北今天（否則一上架就是過期，等於沒上架）
    if (expires <= verified) return aihFail_('bad_request', '到期日要晚於確認日');
    if (status === 'live' && expires <= aihTaipeiDay_(aihNow_())) return aihFail_('bad_request', '上架的題目，到期日要晚於今天');
    var next = { id: base.id, m: f.m, v: f.v, question: f.question, answer: f.answer, who: f.who, go_m: f.go_m, go_v: f.go_v, status: status,
      source: f.source, verified_at: verified, expires_at: expires, updated_at: base.updated_at, updated_by: base.updated_by };
    if (cur) {
      var same = AIH_H.kb.every(function (h) { return h === 'updated_at' || h === 'updated_by' || next[h] === base[h]; });
      if (same) return { ok: true, data: { id: id, updated_at: base.updated_at, changed: false } };
    } else {
      var max = 0;
      rows.forEach(function (r) { var n = Number(String(r.id).replace(/^kb/, '')); if (n > max) max = n; });
      next.id = 'kb' + ('0000' + (max + 1)).slice(-4);
      if (max + 1 > 9999) next.id = 'kb' + (max + 1);
    }
    var nowIso = aihIso_();
    if (cur && nowIso === base.updated_at) nowIso = aihIso_(aihNow_() + 1);   // 同一毫秒連改兩次：updated_at 一定要變，conflict 才抓得到
    next.updated_at = nowIso;
    next.updated_by = c.by;
    var action = !cur ? 'create' : (next.status !== base.status && next.status === 'live' ? 'publish' : (next.status !== base.status && next.status === 'off' ? 'unpublish' : 'update'));
    if (cur) aihWriteAt_('kb', cur._row, next); else aihAppend_('kb', next);
    aihHistAppend_(next.id, action, next, c.by);
    return { ok: true, data: { id: next.id, updated_at: next.updated_at, changed: true } };
  });
}

/**
 * 匯入初始題庫（AiHelpSeed.gs 的 AIH_SEED）。權限同 aihKbSave（role admin 或 platform.aihelp）。
 * 規則：question（去前後空白、完全相同字串）已存在於 aih_kb（任何狀態）→ 略過；其餘一律以 status 'draft' 新增、自動編號、
 * verified_at 今天、expires_at＋180 天，並各寫一列 aih_kb_hist（action create、by＝呼叫者）。冪等：重複呼叫 added＝0。
 * 全部題目先驗證（欄位長度、頁面在 AIH_PAGES），任何一題不合格就整批不寫（bad_request）。回 {added, skipped}。
 */
function handleAihKbImport_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  if (typeof AIH_SEED === 'undefined' || !Array.isArray(AIH_SEED)) return aihFail_('bad_request', '找不到初始題庫');
  return aihWithLock_(function () {
    var rows = aihRows_('kb');
    var have = {};
    var max = 0;
    rows.forEach(function (r) {
      have[aihStr_(r.question)] = true;
      var n = Number(String(r.id).replace(/^kb/, ''));
      if (n > max) max = n;
    });
    var spec = [['question', '問題', AIH_MAX.question, true], ['answer', '答案', AIH_MAX.answer, true], ['who', '找誰', AIH_MAX.who, false],
      ['source', '依據文件', AIH_MAX.source, false], ['m', '頁面（模組）', 40, false], ['v', '頁面（分頁）', 40, false], ['go_m', '帶我去（模組）', 40, false], ['go_v', '帶我去（分頁）', 40, false]];
    var fresh = [];
    var skipped = 0;
    for (var i = 0; i < AIH_SEED.length; i++) {
      var f = {};
      for (var j = 0; j < spec.length; j++) {
        var t = aihCleanText_(AIH_SEED[i][spec[j][0]], spec[j][1], spec[j][2], spec[j][3]);
        if (t.error) return aihFail_('bad_request', '初始題庫第 ' + (i + 1) + ' 題：' + t.error);
        f[spec[j][0]] = t.value;
      }
      if (f.v && !f.m) return aihFail_('bad_request', '初始題庫第 ' + (i + 1) + ' 題：有分頁就要有模組');
      if (f.m && !aihPageExists_(f.m, f.v)) return aihFail_('bad_request', '初始題庫第 ' + (i + 1) + ' 題：頁面不在頁面地圖上');
      if ((f.go_m || f.go_v) && !(f.go_m && f.go_v && aihPageExists_(f.go_m, f.go_v))) return aihFail_('bad_request', '初始題庫第 ' + (i + 1) + ' 題：「帶我去」的頁面不在頁面地圖上');
      if (have[f.question]) { skipped++; continue; }
      have[f.question] = true;   // 題庫自己有重複的題目，後面的也略過
      fresh.push(f);
    }
    if (!fresh.length) return { ok: true, data: { added: 0, skipped: skipped } };
    var nowIso = aihIso_();
    var verified = aihTaipeiDay_(aihNow_());
    var expires = aihAddDays_(verified, AIH_KB_VALID_DAYS);
    var kbRows = [], histRows = [];
    var hmax = 0;
    aihRows_('hist').forEach(function (r) { var n = Number(String(r.hist_id).replace(/^kh/, '')); if (n > hmax) hmax = n; });
    fresh.forEach(function (f, k) {
      var id = 'kb' + ('0000' + (max + k + 1)).slice(-4);
      if (max + k + 1 > 9999) id = 'kb' + (max + k + 1);
      var o = { id: id, m: f.m, v: f.v, question: f.question, answer: f.answer, who: f.who, go_m: f.go_m, go_v: f.go_v, status: 'draft',
        source: f.source, verified_at: verified, expires_at: expires, updated_at: nowIso, updated_by: c.by };
      var hid = 'kh' + ('0000' + (hmax + k + 1)).slice(-4);
      if (hmax + k + 1 > 9999) hid = 'kh' + (hmax + k + 1);
      kbRows.push(aihToRow_('kb', o));
      histRows.push(aihToRow_('hist', { hist_id: hid, kb_id: id, action: 'create', snapshot: JSON.stringify(o), by: c.by, at: nowIso }));
    });
    stfAppendBlock_(AIH_SH.kb, kbRows, AIH_H.kb.length, true);
    stfAppendBlock_(AIH_SH.hist, histRows, AIH_H.hist.length, true);
    return { ok: true, data: { added: fresh.length, skipped: skipped } };
  });
}

/** payload {kb_id?, limit?} → {items:[{hist_id, kb_id, action, snapshot, by, at}]} 新的在前；沒給 kb_id＝全部（含暫停開關列） */
function handleAihKbHist_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var kb = aihStr_(payload.kb_id);
  var limit = Number(payload.limit) > 0 ? Math.min(Math.floor(Number(payload.limit)), 500) : 200;
  var items = aihRows_('hist').filter(function (r) { return !kb || aihStr_(r.kb_id) === kb; }).map(function (r) {
    var snap = null;
    try { snap = JSON.parse(aihStr_(r.snapshot)); } catch (e) { snap = null; }
    return { hist_id: aihStr_(r.hist_id), kb_id: aihStr_(r.kb_id), action: aihStr_(r.action), snapshot: snap, by: aihStr_(r.by), at: aihStr_(r.at) };
  });
  items.reverse();
  return { ok: true, data: { items: items.slice(0, limit) } };
}

// ============================================================
// 5. 待回答、用量、暫停開關
// ============================================================

function aihPendingObj_(r) {
  return { id: aihStr_(r.id), log_id: aihStr_(r.log_id), ts: aihStr_(r.ts), q: aihStr_(r.q), m: aihStr_(r.m), v: aihStr_(r.v), reason: aihStr_(r.reason), status: aihStr_(r.status), kb_id: aihStr_(r.kb_id) };
}

/** payload {status?} → {items:[…pending 欄位 + count], open_count}；count＝同一個問題（同頁、去空白不分大小寫）出現幾次 */
function handleAihPendingList_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var st = aihStr_(payload.status);
  if (st && AIH_PENDING_STATUS.indexOf(st) === -1) return aihFail_('bad_request', '狀態不正確');
  var all = aihRows_('pending').map(aihPendingObj_);
  var keyOf = function (o) { return o.m + '|' + o.v + '|' + o.q.toLowerCase().replace(/\s+/g, ''); };
  var counts = {};
  all.forEach(function (o) { if (o.q) counts[keyOf(o)] = (counts[keyOf(o)] || 0) + 1; });
  var items = all.filter(function (o) { return !st || o.status === st; }).map(function (o) { o.count = o.q ? counts[keyOf(o)] : 0; return o; });
  items.reverse();
  return { ok: true, data: { items: items, open_count: all.filter(function (o) { return o.status === 'open'; }).length } };
}

/** payload {id, status, kb_id?}：done 必須帶 kb_id（且該題要是 status live）；其他狀態會把 kb_id 清掉 */
function handleAihPendingSet_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var id = aihStr_(payload.id), st = aihStr_(payload.status), kbId = aihStr_(payload.kb_id);
  if (!id) return aihFail_('bad_request', '缺少待回答編號');
  if (AIH_PENDING_STATUS.indexOf(st) === -1) return aihFail_('bad_request', '狀態不正確');
  if (st === 'done' && !kbId) return aihFail_('bad_request', '標成已處理要帶上架的題目編號');
  return aihWithLock_(function () {
    var cur = null;
    aihRows_('pending').forEach(function (r) { if (aihStr_(r.id) === id) cur = r; });
    if (!cur) return aihFail_('not_found', '找不到這一筆待回答');
    if (st === 'done') {
      var kbRow = null;
      aihRows_('kb').forEach(function (r) { if (aihStr_(r.id) === kbId) kbRow = r; });
      if (!kbRow) return aihFail_('bad_request', '找不到這個題目編號');
      if (aihStr_(kbRow.status) !== 'live') return aihFail_('bad_request', '請先上架這一題，再標成已處理');
    }
    var o = aihPendingObj_(cur);
    o.status = st;
    o.kb_id = st === 'done' ? kbId : '';
    aihWriteAt_('pending', cur._row, o);
    return { ok: true, data: { id: id, status: st, kb_id: o.kb_id } };
  });
}

/**
 * payload {month:'YYYY-MM'}（台北；沒給＝本月）→ {month, count, answered_ratio, down_ratio, by_day:[{day,count}], paused}
 * 由 aih_log 統計（只算題數與比例）：費用 usd 不在這裡（§12.7：費用正本是 node 帳本，管理頁另打 svc op usage）；
 * answered_ratio＝kind=answered 的列 / count；down_ratio＝feedback=down 的列 / count（count 0 時兩者為 0）；比例四捨五入到小數 4 位。
 */
function handleAihUsage_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var month = aihStr_(payload.month) || aihTaipeiMonth_(aihNow_());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return aihFail_('bad_request', '月份格式錯誤');
  var count = 0, answered = 0, down = 0, byDay = {};
  aihRows_('log').forEach(function (r) {
    var ms = aihParseTs_(r.ts);
    if (isNaN(ms) || aihTaipeiMonth_(ms) !== month) return;
    count++;
    if (aihStr_(r.kind) === 'answered') answered++;
    if (aihStr_(r.feedback) === 'down') down++;
    var day = aihTaipeiDay_(ms);
    byDay[day] = (byDay[day] || 0) + 1;
  });
  var ratio = function (n) { return count ? Math.round(n / count * 10000) / 10000 : 0; };
  return { ok: true, data: {
    month: month, count: count, answered_ratio: ratio(answered), down_ratio: ratio(down),
    by_day: Object.keys(byDay).sort().map(function (d) { return { day: d, count: byDay[d] }; }), paused: aihPaused_()
  } };
}

/**
 * 問答紀錄清單（2026-11-05 Eason：用量頁看得到同仁問了什麼）。payload {month:'YYYY-MM'（台北；沒給＝本月）, limit?:1–200（預設 50）, before?:上一頁回的 next}
 * → {month, total, items:[{id, ts, m, v, q, kind, answer, kb_ids, feedback}], next}；新的排最前（ts 由新到舊，同時間再依 id 由大到小）。
 * 刻意不回 uid、conv、tok_in、tok_out、usd（誰問的、費用不在這裡）。q 是 node 寫 log 前已遮罩的文字（手機、身分證、email、DZY 編號、在職同仁姓名）。
 * answer 回 log 裡的全文（寫入時已截到 AIH_MAX.logAnswer），前端截短顯示、點開看全文。
 * next＝最後一筆的「毫秒:id」，沒有下一頁為空字串；before 格式不對 → bad_request。
 */
var AIH_LOG_LIST_LIMIT = { def: 50, max: 200 };
function handleAihLogList_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  payload = payload || {};
  var month = aihStr_(payload.month) || aihTaipeiMonth_(aihNow_());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return aihFail_('bad_request', '月份格式錯誤');
  var limit = payload.limit === undefined || payload.limit === null || payload.limit === '' ? AIH_LOG_LIST_LIMIT.def : Number(payload.limit);
  if (!(limit >= 1 && limit <= AIH_LOG_LIST_LIMIT.max && Math.floor(limit) === limit)) return aihFail_('bad_request', '筆數要在 1 到 ' + AIH_LOG_LIST_LIMIT.max + ' 之間');
  var before = aihStr_(payload.before), bMs = NaN, bId = '';
  if (before) {
    var mm = /^(\d{1,15}):(\S{1,64})$/.exec(before);
    if (!mm) return aihFail_('bad_request', '分頁位置格式錯誤');
    bMs = Number(mm[1]); bId = mm[2];
  }
  var rows = [];
  aihRows_('log').forEach(function (r) {
    var ms = aihParseTs_(r.ts);
    if (isNaN(ms) || aihTaipeiMonth_(ms) !== month) return;
    rows.push({ ms: ms, id: aihStr_(r.id), r: r });
  });
  var newer = function (a, b) { return a.ms !== b.ms ? a.ms > b.ms : a.id > b.id; };   // a 比 b 新
  rows.sort(function (a, b) { return newer(a, b) ? -1 : (newer(b, a) ? 1 : 0); });
  var total = rows.length;
  if (before) rows = rows.filter(function (x) { return newer({ ms: bMs, id: bId }, x); });
  var page = rows.slice(0, limit);
  var items = page.map(function (x) {
    var r = x.r;
    return { id: x.id, ts: aihIso_(x.ms), m: aihStr_(r.m), v: aihStr_(r.v), q: aihStr_(r.q), kind: aihStr_(r.kind),
      answer: aihStr_(r.answer), kb_ids: aihStr_(r.kb_ids), feedback: aihStr_(r.feedback) };
  });
  var last = page[page.length - 1];
  return { ok: true, data: { month: month, total: total, items: items, next: rows.length > limit && last ? last.ms + ':' + last.id : '' } };
}

/**
 * 暫停開關（§12.8）：payload {paused:boolean} → Script Property AIH_PAUSED（'1'＝暫停，'0'＝恢復）。
 * 稽核方式（自選）：每次「狀態有變」寫一列 aih_kb_hist（kb_id 空、action pause_on／pause_off、snapshot {paused}、by、at）＋ stfLog_ 一筆；沒變就不寫。
 */
function handleAihPauseSet_(token, payload) {
  var c = aihEnter_(token, false);
  if (!c.ok) return c;
  if (!aihReady_()) return aihNotInited_();
  if (!payload || typeof payload.paused !== 'boolean') return aihFail_('bad_request', '請指定暫停或恢復');
  return aihWithLock_(function () {
    var was = aihPaused_();
    if (was === payload.paused) return { ok: true, data: { paused: was, changed: false } };
    PropertiesService.getScriptProperties().setProperty(AIH_PAUSE_PROP, payload.paused ? '1' : '0');
    aihHistAppend_('', payload.paused ? 'pause_on' : 'pause_off', { paused: payload.paused }, c.by);
    stfLog_('', payload.paused ? 'aih_pause_on' : 'aih_pause_off', c.by, '');
    return { ok: true, data: { paused: payload.paused, changed: true } };
  });
}

// ============================================================
// 6. node 專用全域函式（⚠ 不准進 Code.gs；回 {ok,…}／{ok:false,code,error}，沒有 data 層）
// ============================================================

function aihNodeFail_(code, error) { return { ok: false, code: code, error: error || '' }; }
function aihNodeLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return aihNodeFail_('busy', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 角色中文名（roles 分頁第 2 欄）；查不到回空字串 */
function aihRoleNameZh_(role) {
  var sh = stfSheet_('roles');
  if (!sh || sh.getLastRow() < 2) return '';
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === String(role)) return aihStr_(rows[i][1]);
  return '';
}

/**
 * aiHelpAuthorize_(token)（spec §6、§12.10-3）。沿用 authResolveSession_（簽章、效期、停用帳號、token_after、認領閘門）。
 * 成功：{ ok:true,
 *   who:{ uid, role },                              // uid 只給 node 記錄用，不送 AI
 *   me:{ kind:'staff', status, unit_name, dept_name, title_name, extra_dept_names[], acting_unit_names[], staff_add_unit_names[] }
 *     | { kind:'system', role_name },               // 系統帳號（角色不是 staff）只有 kind 與角色中文名
 *   perms:[{ name_zh, source_zh }],                 // 來源同 myPerms；權限關閉時全部算「系統角色」
 *   can_manage:boolean }                            // ＝hasPerm_(perms,'platform.aihelp')，node 的 draft 用它判斷
 * 失敗：{ ok:false, code:'unauthorized', error }
 * ⚠ 輸出的鍵是白名單（測試釘住，多一個就紅）：絕不含 phone、生日、地址、p_* 待審欄位、emp_no、name、待我處理件數。
 */
function aiHelpAuthorize_(token) {
  if (typeof token !== 'string' || !token) return aihNodeFail_('unauthorized', '請先登入');
  var sess = authResolveSession_(token);
  if (!sess.ok) return aihNodeFail_('unauthorized', sess.error);
  var user = sess.user;
  var role = String(user.role);
  var me;
  if (role === 'staff') {
    me = { kind: 'staff', status: '', unit_name: '', dept_name: '', title_name: '', extra_dept_names: [], acting_unit_names: [], staff_add_unit_names: [] };
    var hit = typeof stfFindByUserId_ === 'function' ? stfFindByUserId_(user.id) : null;
    if (hit) {
      var org = stfReadOrg_();
      var o = stfToObj_(hit.values, org, false);
      stfDecorate_(o, stfReadExtraMap_(), org, false);
      me.status = aihStr_(o.status);
      me.unit_name = aihStr_(o.unit_name);
      me.dept_name = aihStr_(o.dept_name);
      me.title_name = aihStr_(o.title_name);
      me.extra_dept_names = (o.extra_dept_names || []).map(aihStr_).filter(Boolean);
      var unitName = function (code) { return org.unit[code] ? aihStr_(org.unit[code].name) : ''; };
      if (typeof permActingUnitsOf_ === 'function') me.acting_unit_names = permActingUnitsOf_(o.emp_no).map(unitName).filter(Boolean);
      if (typeof permStaffAddUnitOf_ === 'function') {
        var add = permStaffAddUnitOf_(hit.values);
        if (add) me.staff_add_unit_names = [unitName(add)].filter(Boolean);
      }
    }
  } else {
    me = { kind: 'system', role_name: aihRoleNameZh_(role) };
  }
  var sources = Array.isArray(sess.permSources) ? sess.permSources : (sess.perms || []).map(function (p) { return { perm: p, source: 'role' }; });
  var perms = sources.map(function (s) { return { name_zh: permName_(s.perm), source_zh: AIH_SOURCE_ZH[s.source] || '' }; });
  return { ok: true, who: { uid: String(user.id), role: role }, me: me, perms: perms, can_manage: hasPerm_(sess.perms, 'platform.aihelp') };
}

/** uid → 該帳號現在的完整權限碼；帳號不存在、停用、被閘門擋（待審核等）回 null */
function aihPermsOfUid_(uid) {
  var found = findUserById_(uid);
  if (!found || !isActiveValue_(found.values[AUTH_USERS_COL.active])) return null;
  var user = rowToUser_(found.values);
  var gate = authStaffGate_(user);
  if (gate.block) return null;
  return authPermsAndScope_(user, gate).perms || [];
}

/**
 * aihKbVisible_(uid)（取代 aihKbLive_）→ { ok:true, paused, items:[{id,m,v,question,answer,who,go_m,go_v,updated_at}] }
 * 只回：status live、未過期（expires_at ≤ 今天、或沒填＝過期，fail-closed）、本人看得到其 m／v 頁面（aihPageVisible_）的題目。
 * 暫停中（AIH_PAUSED=1）→ paused:true、items 空（node 每次 ask 先查）。uid 不存在或帳號停用 → {ok:false, code:'unauthorized'}。
 */
function aihKbVisible_(uid) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  var perms = aihPermsOfUid_(uid);
  if (perms === null) return aihNodeFail_('unauthorized', '帳號不存在或已停用');
  if (aihPaused_()) return { ok: true, paused: true, items: [] };
  var today = aihTaipeiDay_(aihNow_());
  var items = aihRows_('kb').map(aihKbObj_).filter(function (o) {
    if (o.status !== 'live') return false;
    if (!o.expires_at || o.expires_at <= today) return false;   // 沒有到期日＝視為已過期（fail-closed）
    return aihPageVisible_(perms, o.m, o.v);
  }).map(function (o) {
    return { id: o.id, m: o.m, v: o.v, question: o.question, answer: o.answer, who: o.who, go_m: o.go_m, go_v: o.go_v, updated_at: o.updated_at };
  });
  return { ok: true, paused: false, items: items };
}

function aihIdsText_(v) {
  if (Array.isArray(v)) return v.map(aihStr_).filter(Boolean).join(',');
  return aihStr_(v);
}

/**
 * aihLogAppend_(row)：row {id, ts?, uid, conv?, m?, v?, q, kind, answer, kb_ids?, tok_in?, tok_out?, usd?}。
 * id 必須是 aih_YYYYMMDDHHmmss_xxxx；同 id 已存在＝冪等（回 dup:true、不再寫）。ts 預設現在（ISO UTC）。feedback 一律從空白開始。
 */
function aihLogAppend_(row) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  if (!row || typeof row !== 'object') return aihNodeFail_('bad_input', '缺少紀錄內容');
  var id = aihStr_(row.id), uid = aihStr_(row.uid), conv = aihStr_(row.conv), kind = aihStr_(row.kind);
  if (!AIH_ID_LOG_RE.test(id)) return aihNodeFail_('bad_input', '紀錄編號格式錯誤');
  if (!uid) return aihNodeFail_('bad_input', '缺少 uid');
  if (conv && !AIH_ID_CONV_RE.test(conv)) return aihNodeFail_('bad_input', '對話編號格式錯誤');
  if (kind !== 'answered' && kind !== 'unknown') return aihNodeFail_('bad_input', 'kind 只能是 answered 或 unknown');
  var ts = row.ts === undefined || row.ts === '' ? aihIso_() : aihStr_(row.ts);
  if (isNaN(aihParseTs_(ts))) return aihNodeFail_('bad_input', '時間格式錯誤');
  var num = function (v) { var n = Number(v); return isFinite(n) && n >= 0 ? n : 0; };
  return aihNodeLock_(function () {
    if (aihRows_('log').some(function (r) { return aihStr_(r.id) === id; })) return { ok: true, id: id, dup: true };
    aihAppend_('log', { id: id, ts: ts, uid: uid, conv: conv, m: aihStr_(row.m), v: aihStr_(row.v), q: aihStr_(row.q).slice(0, AIH_MAX.q), kind: kind,
      answer: aihStr_(row.answer).slice(0, AIH_MAX.logAnswer), kb_ids: aihIdsText_(row.kb_ids), tok_in: num(row.tok_in), tok_out: num(row.tok_out), usd: num(row.usd), feedback: '' });
    return { ok: true, id: id, dup: false };
  });
}

/**
 * aihPendingAdd_(row)：row {id, log_id?, ts?, q, m?, v?, reason}。id 必須是 aip_…；reason unknown／thumbs_down；status 一律 open。
 * 同 id＝冪等；同 log_id 同 reason 已有一筆、或同 log_id 已有「open」的待回答（不論 reason，例如 unknown 那筆還在清單上）＝回那筆（dup:true），避免連按 👎 灌水、同一題在清單上出現兩次。
 */
function aihPendingAdd_(row) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  if (!row || typeof row !== 'object') return aihNodeFail_('bad_input', '缺少內容');
  var id = aihStr_(row.id), logId = aihStr_(row.log_id), reason = aihStr_(row.reason), q = aihStr_(row.q);
  if (!AIH_ID_PENDING_RE.test(id)) return aihNodeFail_('bad_input', '待回答編號格式錯誤');
  if (logId && !AIH_ID_LOG_RE.test(logId)) return aihNodeFail_('bad_input', '紀錄編號格式錯誤');
  if (AIH_PENDING_REASON.indexOf(reason) === -1) return aihNodeFail_('bad_input', 'reason 只能是 unknown 或 thumbs_down');
  if (!q) return aihNodeFail_('bad_input', '缺少問題');
  var ts = row.ts === undefined || row.ts === '' ? aihIso_() : aihStr_(row.ts);
  if (isNaN(aihParseTs_(ts))) return aihNodeFail_('bad_input', '時間格式錯誤');
  return aihNodeLock_(function () {
    var dup = null;
    aihRows_('pending').forEach(function (r) {
      if (aihStr_(r.id) === id || (logId && aihStr_(r.log_id) === logId && (aihStr_(r.reason) === reason || aihStr_(r.status) === 'open'))) dup = r;
    });
    if (dup) return { ok: true, id: aihStr_(dup.id), dup: true };
    aihAppend_('pending', { id: id, log_id: logId, ts: ts, q: q.slice(0, AIH_MAX.q), m: aihStr_(row.m), v: aihStr_(row.v), reason: reason, status: 'open', kb_id: '' });
    return { ok: true, id: id, dup: false };
  });
}

/**
 * aihFeedback_(uid, id, good)：只能改「自己的」log 列（uid 要等於該列 uid）；feedback 寫 up／down，可覆寫。
 * 回 {ok:true, feedback, q, m, v, kind}：q 是 log 裡已遮罩的問題、m／v／kind 同該列；node 用它寫待回答（👎），不靠記憶體。
 */
function aihFeedback_(uid, id, good) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  if (typeof good !== 'boolean') return aihNodeFail_('bad_input', 'good 要是 true 或 false');
  var u = aihStr_(uid), i = aihStr_(id);
  if (!u || !AIH_ID_LOG_RE.test(i)) return aihNodeFail_('bad_input', '參數錯誤');
  return aihNodeLock_(function () {
    var cur = null;
    aihRows_('log').forEach(function (r) { if (aihStr_(r.id) === i) cur = r; });
    // 找不到與「不是你的」回同一個碼，不讓人探測別人的紀錄編號
    if (!cur || aihStr_(cur.uid) !== u) return aihNodeFail_('not_found', '找不到這筆紀錄');
    cur.feedback = good ? 'up' : 'down';
    aihWriteAt_('log', cur._row, cur);
    return { ok: true, feedback: cur.feedback, q: aihStr_(cur.q), m: aihStr_(cur.m), v: aihStr_(cur.v), kind: aihStr_(cur.kind) };
  });
}

/** aihConvGet_(uid, conv) → { ok:true, items:[{q, a}] }：同 uid、同 conv 最近 3 組（舊→新）。conv 格式不對或空＝空陣列 */
function aihConvGet_(uid, conv) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  var u = aihStr_(uid), c = aihStr_(conv);
  if (!u || !AIH_ID_CONV_RE.test(c)) return { ok: true, items: [] };
  var hit = aihRows_('log').filter(function (r) { return aihStr_(r.uid) === u && aihStr_(r.conv) === c; });
  hit.sort(function (a, b) { return (aihParseTs_(a.ts) || 0) - (aihParseTs_(b.ts) || 0) || a._row - b._row; });
  return { ok: true, items: hit.slice(-3).map(function (r) { return { q: aihStr_(r.q), a: aihStr_(r.answer) }; }) };
}

/**
 * aihStaffNames_()（node 專用，唯讀）→ { ok:true, names:[...] }：staff 分頁 status＝active 的同仁姓名。
 * 去前後空白、去重、只收長度 2～6 且不含空白的字串。node 用來把問題裡的完整姓名遮成 [同仁]（spec §12.12）。
 */
function aihStaffNames_() {
  try {
    var seen = {}, names = [];
    stfAllRows_().forEach(function (r) {
      if (aihStr_(r.values[STF_COL.status]) !== 'active') return;
      var n = aihStr_(r.values[STF_COL.name]);
      var len = Array.from(n).length;
      if (len < 2 || len > 6 || /\s/.test(n) || seen[n]) return;
      seen[n] = true; names.push(n);
    });
    return { ok: true, names: names };
  } catch (e) {
    return aihNodeFail_('staff_read_failed', '');
  }
}

/**
 * aihPurge_(nowMs)（node 每天 03:50 呼叫）→ { ok:true, log_deleted, pending_q_cleared, kb_expired }
 * 1. 刪 90 天前（ts < now−90 天）的 aih_log 列；ts 解析不了的列保留。
 * 2. 90 天前的 aih_pending（任何狀態）把 q 清成空白（列留著，保留 reason／狀態供統計）。
 * 3. 到期（expires_at ≤ 今天（台北日），或沒填）的 live 題目 status→off，並寫 aih_kb_hist（action expire、by 'system'）。
 */
function aihPurge_(nowMs) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : aihNow_();
  var cutoff = now - AIH_RETAIN_DAYS * 86400000;
  return aihNodeLock_(function () {
    var logs = aihRows_('log');
    var keep = logs.filter(function (r) { var ms = aihParseTs_(r.ts); return isNaN(ms) || ms >= cutoff; });
    var logDeleted = logs.length - keep.length;
    if (logDeleted) aihRewrite_('log', keep);

    var cleared = 0;
    aihRows_('pending').forEach(function (r) {
      var ms = aihParseTs_(r.ts);
      if (!isNaN(ms) && ms < cutoff && aihStr_(r.q) !== '') { r.q = ''; aihWriteAt_('pending', r._row, r); cleared++; }
    });

    var today = aihTaipeiDay_(now), expired = 0;
    aihRows_('kb').forEach(function (r) {
      var o = aihKbObj_(r);
      if (o.status !== 'live' || (o.expires_at && o.expires_at > today)) return;
      o.status = 'off';
      o.updated_at = aihIso_(now);
      o.updated_by = 'system';
      aihWriteAt_('kb', r._row, o);
      aihHistAppend_(o.id, 'expire', o, 'system');
      expired++;
    });
    return { ok: true, log_deleted: logDeleted, pending_q_cleared: cleared, kb_expired: expired };
  });
}

/**
 * aihDigest_(nowMs)（node 09:20 每日彙整用）→ { ok:true, new_pending, top:[{q,m,v,count}]≤5, expiring:[{id,question,expires_at}], paused }
 * new_pending＝過去 24 小時新增、現在仍 open 的待回答數；top＝open 且 q 未被清空者依同頁同 q 次數排序（同次數新的在前）；
 * expiring＝live 且到期日在 1～14 天後（台北日差）。q 存入時已由 node 遮罩。
 */
function aihDigest_(nowMs) {
  if (!aihReady_()) return aihNodeFail_('not_inited', aihEnabledMsg_());
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : aihNow_();
  var open = aihRows_('pending').map(aihPendingObj_).filter(function (o) { return o.status === 'open'; });
  var newCount = open.filter(function (o) { var ms = aihParseTs_(o.ts); return !isNaN(ms) && ms > now - 86400000 && ms <= now; }).length;
  var groups = {}, order = [];
  open.forEach(function (o) {
    if (!o.q) return;
    var k = o.m + '|' + o.v + '|' + o.q.toLowerCase().replace(/\s+/g, '');
    if (!groups[k]) { groups[k] = { q: o.q, m: o.m, v: o.v, count: 0, seq: 0 }; order.push(k); }
    groups[k].count++;
    groups[k].seq = Math.max(groups[k].seq, aihParseTs_(o.ts) || 0);
  });
  var top = order.map(function (k) { return groups[k]; }).sort(function (a, b) { return b.count - a.count || b.seq - a.seq; }).slice(0, 5)
    .map(function (g) { return { q: g.q, m: g.m, v: g.v, count: g.count }; });
  var today = aihTaipeiDay_(now);
  var dayNum = function (ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd); return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000; };
  var expiring = aihRows_('kb').map(aihKbObj_).filter(function (o) {
    if (o.status !== 'live' || !o.expires_at) return false;
    var d = dayNum(o.expires_at) - dayNum(today);
    return d > 0 && d <= 14;
  }).map(function (o) { return { id: o.id, question: o.question, expires_at: o.expires_at }; });
  return { ok: true, new_pending: newCount, top: top, expiring: expiring, paused: aihPaused_() };
}
