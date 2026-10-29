/**
 * Inspect.gs — 營運巡檢（2026-10-27，docs/inspection/spec.md）
 *
 * 舊站 mala-inspection（光復三店、一組通行碼、0 筆資料）搬進營運部門，全集團門市（墨竹亭／小辛辣／一悟）共用。
 * Eason 2026-10-27：1A 照現成搬、2A 與營運稽核並存、3A 依職稱分、4B 全集團、5A 舊網址退場。
 *
 * - 一次巡檢＝insp_records 一列（answers／summary 存 JSON）；題目與算分在前端（modules/inspection/questions.js、scoring.js），
 *   後端只存作答與送出當下算好的分數（題目改版不回頭改舊分數），bank_ver 記用哪一版題目。
 * - 照片沿用表單簽核的檔案庫（Mac mini apv-files，kind receipt）：前端先傳 /platform/svc/apv-file-put 拿檔號，
 *   送出時綁到 form_id 'INSP:<巡檢編號>'；誰看得到照片＝誰看得到這筆巡檢（Approvals.gs apvFileAccess_ 轉給 inspFileCanView_）。
 * - 範圍（後端判，前端只是顯示）：
 *     platform.insp-all   看全部門市
 *     platform.insp-brand 看自己品牌的門市（品牌辦公室的總監、區督導）
 *     platform.insp-own   看自己那家店（店長、區經理）
 *     platform.insp-do    可以巡檢（只能巡上面看得到的店）
 *     platform.insp-bank  題目設定（有 insp-all＝全部品牌；否則只有自己品牌）
 *   admin 全部可看可巡。
 * - 題目（2026-10-27 Eason：「小辛辣的題目使用預設，墨竹亭的題目先空白並開放可以自行新增題目」）：
 *   insp_bank 一品牌一列（forms JSON）；沒有列＝前端預設（小辛辣＝舊站原題、其他品牌空白）。
 *   每筆巡檢送出時連題目一起存（records.forms），題目改了舊報告照舊。
 * - 寫入自己上鎖（inspWithLock_），刻意不列 Code.gs MUTATING_ACTIONS（同 Eval.gs）。
 */

var INSP_SHEET = 'insp_records';
var INSP_H = ['id', 'unit', 'brand', 'date', 'inspector', 'inspector_name', 'submitted_at', 'bank_ver', 'summary', 'answers', 'files', 'state', 'void_by', 'void_at', 'forms'];
var INSP_BANK_SHEET = 'insp_bank';
var INSP_BANK_H = ['brand', 'ver', 'forms', 'updated_at', 'updated_by'];
// 四張表固定（id、名稱、算不算進營運總分）；分類與題目可編輯
var INSP_FORM_SHELLS = [
  { id: 'service', name: '服務', inOperational: true }, { id: 'environment', name: '環境', inOperational: true },
  { id: 'food', name: '菜色', inOperational: true }, { id: 'management', name: '經營評鑑', inOperational: false, standalone: true }];
var INSP_TYPES_BY_ROLE = { scored: ['score', 'critical', 'binary'], bonus: ['bonus', 'bonus_free'], penalty: ['penalty'] };
var INSP_BRANDS = ['mzt', 'mala', 'yiwu'];   // 有門市的三個品牌；中央工廠（ck）不巡
var INSP_ID_RE = /^INS-[0-9A-Z]{6,16}-[0-9A-Z]{4,8}$/;
var INSP_MAX_ANSWERS = 200000;
var INSP_MAX_ITEMS = 300;        // 一個品牌全部題目上限   // 作答 JSON 字元上限（全部四張表約 10KB）
var INSP_MAX_FILES = 60;
var INSP_LIST_MAX = 300;

// 權限預設規則：[ladder, dept, title, perm]（Eason 3A；可在權限設定改）
var INSP_PERM_DEFAULT_RULES = (function () {
  var out = [];
  var add = function (ladder, dept, titles, perms) {
    titles.forEach(function (t) { perms.forEach(function (p) { out.push([ladder, dept, t, p]); }); });
  };
  add('hq', 'ops', ['*'], ['platform.insp-all', 'platform.insp-do']);        // 營運部：看全部、可巡
  add('hq', '', ['ceo', 'gm', 'chair'], ['platform.insp-all']);              // 執行長以上：看全部
  add('office', '', ['odir', 'osv'], ['platform.insp-brand', 'platform.insp-do']);   // 品牌總監、區督導：看自己品牌、可巡
  add('store', '', ['am'], ['platform.insp-own', 'platform.insp-do']);       // 區經理：只看自己店、可巡
  add('store', '', ['sm'], ['platform.insp-own']);                           // 店長：只看自己店的結果
  add('hq', 'ops', ['*'], ['platform.insp-bank']);                           // 營運部：全部品牌的題目設定
  add('office', '', ['odir'], ['platform.insp-bank']);                       // 品牌總監：自己品牌的題目設定
  return out;
})();

function inspFail_(error, message) { return { ok: false, error: error, message: message || '' }; }
function inspStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function inspJson_(s, fb) { if (s === '' || s === null || s === undefined) return fb; try { return JSON.parse(s); } catch (e) { return fb; } }
function inspNow_() { return new Date().toISOString(); }

function inspWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return inspFail_('busy', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}
function inspReady_() { return !!stfSheet_(INSP_SHEET) && !!stfSheet_(INSP_BANK_SHEET); }
function inspNotInited_() { return inspFail_('not_inited', '營運巡檢還沒初始化，請系統管理者先按「初始化營運巡檢」'); }

function inspRows_() {
  if (!inspReady_()) return [];
  return stfReadRows_(INSP_SHEET, INSP_H.length).map(function (v, i) {
    var o = { _row: i + 2 };
    INSP_H.forEach(function (h, j) { o[h] = v[j]; });
    o.id = inspStr_(o.id);
    return o;
  }).filter(function (o) { return o.id !== ''; });
}
function inspToRow_(o) { return INSP_H.map(function (h) { var v = o[h]; return (v === undefined || v === null) ? '' : v; }); }

// ============================================================
// 脈絡與範圍
// ============================================================

/** 可巡檢的門市：store 階梯、啟用、品牌是三個有門市的品牌 */
function inspStores_(org) {
  var out = [];
  (org.list && org.list.unit ? org.list.unit : Object.keys(org.unit)).forEach(function (u) {
    var code = typeof u === 'string' ? u : u.code;
    var d = org.unit[code];
    if (!d || d.active === false || (d.ladder || 'store') !== 'store' || INSP_BRANDS.indexOf(d.parent) === -1) return;
    out.push(code);
  });
  return out;
}

function inspScopeOf_(c) {
  var has = function (p) { return c.isAdmin || hasPerm_(c.perms, p); };
  var stores = inspStores_(c.org);
  var view = {};
  if (has('platform.insp-all')) stores.forEach(function (u) { view[u] = true; });
  if (hasPerm_(c.perms, 'platform.insp-brand') && c.me && c.me.brand) {
    stores.forEach(function (u) { if (c.org.unit[u].parent === c.me.brand) view[u] = true; });
  }
  if (hasPerm_(c.perms, 'platform.insp-own') && c.me && stores.indexOf(c.me.unit) !== -1) view[c.me.unit] = true;
  var canDo = has('platform.insp-do');
  var bankBrands = [];
  if (has('platform.insp-bank')) {
    var all = c.isAdmin || hasPerm_(c.perms, 'platform.insp-all');
    INSP_BRANDS.forEach(function (b) { if (all || (c.me && c.me.brand === b)) bankBrands.push(b); });
  }
  return {
    bankBrands: bankBrands,
    view: view,
    canDo: canDo,
    canVoid: has('platform.insp-all'),
    stores: stores.filter(function (u) { return view[u]; }),
    doStores: canDo ? stores.filter(function (u) { return view[u]; }) : []
  };
}

function inspEnter_(token) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  c.perms = c.perms || [];
  c.scope = inspScopeOf_(c);
  return c;
}

function inspUnitInfo_(c, u) {
  var d = c.org.unit[u] || {};
  var b = c.org.brand[d.parent] || {};
  return { unit: u, name: d.name || u, brand: d.parent || '', brand_name: b.name || d.parent || '' };
}

/** 給 Approvals.gs apvFileAccess_ 用：看得到這筆巡檢的人才看得到它的照片 */
function inspFileCanView_(c, inspId) {
  if (!inspReady_()) return false;
  var hit = null;
  inspRows_().forEach(function (o) { if (o.id === inspId) hit = o; });
  if (!hit) return false;
  var s = inspScopeOf_(c);
  if (!s.view[inspStr_(hit.unit)]) return false;
  // 作廢後：與 inspGet／inspList include_void 同一條件——能看作廢報告的人（canVoid）才看得到照片（2026-10-29）
  if (inspStr_(hit.state) === 'void') return s.canVoid;
  return true;
}

function inspSummaryOut_(o) {
  var s = inspJson_(o.summary, {});
  return {
    operationalScore: typeof s.operationalScore === 'number' ? s.operationalScore : null,
    operationalGrade: inspStr_(s.operationalGrade),
    managementScore: typeof s.managementScore === 'number' ? s.managementScore : null,
    managementGrade: inspStr_(s.managementGrade),
    penaltyTotal: typeof s.penaltyTotal === 'number' ? s.penaltyTotal : 0,
    forms: Array.isArray(s.forms) ? s.forms.slice(0, 8) : [],
    defects: typeof s.defects === 'number' ? s.defects : 0
  };
}
function inspRecordOut_(c, o, full) {
  var info = inspUnitInfo_(c, inspStr_(o.unit));
  var files = inspJson_(o.files, []);
  var out = {
    id: o.id, unit: info.unit, unit_name: info.name, brand: info.brand, brand_name: info.brand_name,
    date: inspStr_(o.date), inspector: inspStr_(o.inspector), inspector_name: inspStr_(o.inspector_name),
    submitted_at: inspStr_(o.submitted_at), bank_ver: inspStr_(o.bank_ver),
    summary: inspSummaryOut_(o), photo_count: Array.isArray(files) ? files.length : 0,
    state: inspStr_(o.state) || 'active'
  };
  if (full) {
    out.forms = inspJson_(o.forms, null);
    out.answers = inspJson_(o.answers, {});
    out.files = Array.isArray(files) ? files : [];
  }
  return out;
}

// ============================================================
// actions
// ============================================================

/** 我能看哪些店、能不能巡 */
function handleInspMe_(token) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  var s = c.scope;
  return { ok: true, data: {
    ready: inspReady_(), is_admin: c.isAdmin, can_do: s.canDo && s.doStores.length > 0, can_void: s.canVoid,
    can_photo: !!(c.me && c.me.opened),
    me: c.me ? { emp: c.me.emp, name: c.me.name } : { emp: '', name: String(c.user.name || '') },
    stores: s.stores.map(function (u) { return inspUnitInfo_(c, u); }),
    do_units: s.doStores,
    bank_brands: s.bankBrands.map(function (b) { return { brand: b, brand_name: (c.org.brand[b] || {}).name || b }; })
  } };
}

/** 歷史清單。payload {unit?, month?:'YYYY-MM', include_void?} */
function handleInspList_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  payload = payload || {};
  var unit = inspStr_(payload.unit), month = inspStr_(payload.month);
  if (month && !/^\d{4}-\d{2}$/.test(month)) return inspFail_('bad_request', '月份格式錯誤');
  var showVoid = payload.include_void === true && c.scope.canVoid;
  var list = inspRows_().filter(function (o) {
    var u = inspStr_(o.unit);
    if (!c.scope.view[u]) return false;
    if (unit && u !== unit) return false;
    if (month && inspStr_(o.date).slice(0, 7) !== month) return false;
    if (!showVoid && inspStr_(o.state) === 'void') return false;
    return true;
  });
  list.sort(function (a, b) {
    var d = inspStr_(b.date).localeCompare(inspStr_(a.date));
    return d !== 0 ? d : inspStr_(b.submitted_at).localeCompare(inspStr_(a.submitted_at));
  });
  return { ok: true, data: { items: list.slice(0, INSP_LIST_MAX).map(function (o) { return inspRecordOut_(c, o, false); }), more: list.length > INSP_LIST_MAX } };
}

/** 單筆（含作答與照片檔號）。payload {id} */
function handleInspGet_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  var id = inspStr_(payload && payload.id);
  var hit = null;
  inspRows_().forEach(function (o) { if (o.id === id) hit = o; });
  if (!hit || !c.scope.view[inspStr_(hit.unit)]) return inspFail_('not_found', '找不到這筆巡檢，或你沒有權限看');
  if (inspStr_(hit.state) === 'void' && !c.scope.canVoid) return inspFail_('not_found', '找不到這筆巡檢，或你沒有權限看');
  return { ok: true, data: inspRecordOut_(c, hit, true) };
}

function inspNum_(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null; }
function inspCleanSummary_(s) {
  s = s && typeof s === 'object' ? s : {};
  var forms = Array.isArray(s.forms) ? s.forms.slice(0, 8).map(function (f) {
    return { id: inspStr_(f && f.id).slice(0, 20), name: inspStr_(f && f.name).slice(0, 20), score: inspNum_(f && f.score) };
  }) : [];
  return {
    operationalScore: inspNum_(s.operationalScore), operationalGrade: inspStr_(s.operationalGrade).slice(0, 4),
    managementScore: inspNum_(s.managementScore), managementGrade: inspStr_(s.managementGrade).slice(0, 4),
    penaltyTotal: inspNum_(s.penaltyTotal) || 0, forms: forms,
    defects: typeof s.defects === 'number' && s.defects >= 0 ? Math.floor(s.defects) : 0
  };
}

/**
 * 送出一次巡檢。payload {id, unit, date, bank_ver, answers, summary, files:[檔號]}
 * id 由前端產生（INS-…），重送同一個 id＝回原本那筆（斷線重按不會變兩筆）。
 */
function handleInspSubmit_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  payload = payload || {};
  var id = inspStr_(payload.id).toUpperCase();
  var unit = inspStr_(payload.unit);
  var date = inspStr_(payload.date);
  if (!INSP_ID_RE.test(id)) return inspFail_('bad_request', '巡檢編號格式錯誤');
  if (!c.scope.canDo || c.scope.doStores.indexOf(unit) === -1) return inspFail_('forbidden', '你沒有巡檢這家店的權限');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return inspFail_('bad_request', '巡檢日期格式錯誤');
  var answers = payload.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return inspFail_('bad_request', '沒有作答內容');
  var answersJson = JSON.stringify(answers);
  if (answersJson.length > INSP_MAX_ANSWERS) return inspFail_('bad_request', '作答內容太長');
  var ids = Array.isArray(payload.files) ? payload.files.map(inspStr_).filter(Boolean) : [];
  var seen = {};
  ids = ids.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; });
  if (ids.length > INSP_MAX_FILES) return inspFail_('bad_request', '照片太多（最多 ' + INSP_MAX_FILES + ' 張）');
  if (ids.length && !(c.me && c.me.opened)) return inspFail_('forbidden', '系統帳號不能附照片');
  var fc = inspCleanForms_(payload.forms);
  if (!fc.ok) return fc;
  var summary = inspCleanSummary_(payload.summary);
  var bankVer = inspStr_(payload.bank_ver).slice(0, 40);

  return inspWithLock_(function () {
    var dup = null;
    inspRows_().forEach(function (o) { if (o.id === id) dup = o; });
    var actor = c.me ? c.me.emp : 'U:' + String(c.user.id);
    if (dup) {
      if (inspStr_(dup.inspector) !== actor) return inspFail_('conflict', '巡檢編號重複，請重新整理後再送一次');
      return { ok: true, data: { id: id, dup: true } };
    }
    var formId = 'INSP:' + id;
    var items = [];
    if (ids.length) {
      if (!apvReady_()) return inspFail_('not_inited', '照片庫（表單簽核）還沒初始化');
      var chk = apvCheckFiles_(ids, c.me.emp, 'receipt', formId);
      if (!chk.ok) return chk;
      items = chk.items;
    }
    var row = {
      id: id, unit: unit, brand: (c.org.unit[unit] || {}).parent || '', date: date,
      inspector: actor, inspector_name: c.me ? c.me.name : String(c.user.name || c.user.username || ''),
      submitted_at: inspNow_(), bank_ver: bankVer, summary: JSON.stringify(summary), answers: answersJson,
      files: JSON.stringify(ids), state: 'active', void_by: '', void_at: '', forms: JSON.stringify(fc.forms)
    };
    stfAppendBlock_(INSP_SHEET, [inspToRow_(row)], INSP_H.length, true);
    if (items.length) apvBindFiles_(items, formId, 0);
    return { ok: true, data: { id: id } };
  });
}

/** 作廢（打錯店、測試資料）。只有看全部的人（營運部、admin）。payload {id} */
function handleInspVoid_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  if (!c.scope.canVoid) return inspFail_('forbidden', '只有營運部可以作廢巡檢');
  var id = inspStr_(payload && payload.id);
  return inspWithLock_(function () {
    var hit = null;
    inspRows_().forEach(function (o) { if (o.id === id) hit = o; });
    if (!hit) return inspFail_('not_found', '找不到這筆巡檢');
    if (inspStr_(hit.state) === 'void') return { ok: true, data: { id: id } };
    hit.state = 'void';
    hit.void_by = c.me ? c.me.emp : 'U:' + String(c.user.id);
    hit.void_at = inspNow_();
    var sh = stfSheet_(INSP_SHEET);
    sh.getRange(hit._row, 1, 1, INSP_H.length).setValues([inspToRow_(hit)]);
    stfLog_('', 'insp_void', hit.void_by, id);
    return { ok: true, data: { id: id } };
  });
}

/** 建 insp_records 分頁（只補不覆蓋）＋ perm_map 補預設規則。只有 role admin */
function setupInspection(auth) {
  var ss = SpreadsheetApp.getActive();
  stfEnsureSheet_(ss, INSP_SHEET, INSP_H, []);
  stfEnsureSheet_(ss, INSP_BANK_SHEET, INSP_BANK_H, []);
  return { ok: true, permAdded: inspPermSeed_(auth) };
}
/** 同 Eval.gs evPermSeed_：只補 perm_map 還沒有的同一條規則；perm 表沒初始化就略過 */
function inspPermSeed_(auth) {
  var ss = SpreadsheetApp.getActive();
  var t = permReadTable_(ss, PERM_SHEET_MAP, PERM_MAP_HEADERS);
  if (t.missing || t.mismatch) return [];
  var have = {};
  t.rows.forEach(function (r) { have[[permStr_(r[1]), permStr_(r[2]), permStr_(r[3]), permStr_(r[4])].join('|')] = true; });
  var next = permAcNextId_(t.rows, 'R');
  var now = permNowText_(), by = permAuthId_(auth) || 'system';
  var rows = [], ids = [];
  INSP_PERM_DEFAULT_RULES.forEach(function (r) {
    if (have[r.join('|')]) return;
    var rid = next();
    ids.push(rid);
    rows.push([rid, r[0], r[1], r[2], r[3], 'TRUE', now, by]);
  });
  if (rows.length) {
    var sh = ss.getSheetByName(PERM_SHEET_MAP);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, PERM_MAP_HEADERS.length).setValues(rows);
    stfLog_('', 'perm_map_seed', by, ids.join(','));
  }
  return ids;
}
function handleInspSetup_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return inspFail_('unauthorized', sess.error);
  if (String(sess.user.role) !== 'admin') return inspFail_('forbidden', '只有系統管理者可以初始化');
  try { return { ok: true, data: setupInspection(sess.user) }; } catch (e) { return inspFail_('bad_request', String(e && e.message || e)); }
}

// ============================================================
// 題目設定
// ============================================================

function inspIntIn_(v, lo, hi) { var n = Number(v); return (typeof v === 'number' || /^\d+$/.test(inspStr_(v))) && n % 1 === 0 && n >= lo && n <= hi ? n : null; }

/**
 * 檢查並清洗題目（送出巡檢時的快照、存題目都用這支）。回 {ok:true, forms} 或失敗。
 * 四張表固定；分類 role scored／bonus／penalty；評分分類權重（0～1）加總要 1（有評分分類時）；題目 n 依序重編。
 */
function inspCleanForms_(forms) {
  if (!Array.isArray(forms) || forms.length !== INSP_FORM_SHELLS.length) return inspFail_('bad_request', '題目格式錯誤（要有四張表）');
  var total = 0, catIds = {};
  var out = [];
  for (var fi = 0; fi < INSP_FORM_SHELLS.length; fi++) {
    var shell = INSP_FORM_SHELLS[fi];
    var f = forms[fi];
    if (!f || inspStr_(f.id) !== shell.id) return inspFail_('bad_request', '題目格式錯誤（表的順序不對）');
    var cats = Array.isArray(f.categories) ? f.categories : [];
    if (cats.length > 20) return inspFail_('bad_request', '「' + shell.name + '」分類太多');
    var oc = [], wsum = 0, nScored = 0;
    for (var ci = 0; ci < cats.length; ci++) {
      var c = cats[ci] || {};
      var role = inspStr_(c.role);
      if (!INSP_TYPES_BY_ROLE[role]) return inspFail_('bad_request', '「' + shell.name + '」分類種類錯誤');
      var cid = inspStr_(c.id);
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(cid) || catIds[shell.id + '.' + cid]) return inspFail_('bad_request', '「' + shell.name + '」分類代號錯誤或重複');
      catIds[shell.id + '.' + cid] = true;
      var name = inspStr_(c.name).slice(0, 30);
      if (!name) return inspFail_('bad_request', '「' + shell.name + '」有分類沒有名稱');
      var cat = { id: cid, name: name, role: role, items: [] };
      if (role === 'scored') {
        var w = Number(c.weight);
        if (!(w > 0 && w <= 1)) return inspFail_('bad_request', '「' + shell.name + '・' + name + '」權重要在 1%～100%');
        cat.weight = Math.round(w * 1000) / 1000;
        wsum += cat.weight; nScored++;
      }
      var items = Array.isArray(c.items) ? c.items : [];
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii] || {};
        var type = inspStr_(it.type);
        if (INSP_TYPES_BY_ROLE[role].indexOf(type) === -1) return inspFail_('bad_request', '「' + shell.name + '・' + name + '」題目種類錯誤');
        var text = inspStr_(it.text).slice(0, 300);
        if (!text) return inspFail_('bad_request', '「' + shell.name + '・' + name + '」有題目沒有內容');
        var o = { n: ii + 1, type: type, text: text };
        if (type === 'bonus' || type === 'bonus_free' || type === 'penalty') {
          o.points = inspIntIn_(it.points, 1, 20);
          if (o.points === null) return inspFail_('bad_request', '「' + text.slice(0, 12) + '」分數要在 1～20');
        }
        if (type === 'bonus_free') {
          o.max = inspIntIn_(it.max, 1, 10);
          if (o.max === null) return inspFail_('bad_request', '「' + text.slice(0, 12) + '」最多項數要在 1～10');
        }
        cat.items.push(o);
        total++;
      }
      oc.push(cat);
    }
    if (nScored && Math.abs(wsum - 1) > 0.011) return inspFail_('bad_request', '「' + shell.name + '」評分分類的權重加起來要 100%（目前 ' + Math.round(wsum * 100) + '%）');
    var of = { id: shell.id, name: shell.name, inOperational: shell.inOperational, heading: inspStr_(f.heading).slice(0, 60), categories: oc };
    if (shell.standalone) of.standalone = true;
    out.push(of);
  }
  if (total > INSP_MAX_ITEMS) return inspFail_('bad_request', '題目太多（最多 ' + INSP_MAX_ITEMS + ' 題）');
  return { ok: true, forms: out, total: total };
}

function inspBankRows_() {
  if (!stfSheet_(INSP_BANK_SHEET)) return [];
  return stfReadRows_(INSP_BANK_SHEET, INSP_BANK_H.length).map(function (v, i) {
    var o = { _row: i + 2 };
    INSP_BANK_H.forEach(function (h, j) { o[h] = v[j]; });
    o.brand = inspStr_(o.brand);
    return o;
  }).filter(function (o) { return o.brand !== ''; });
}

/** 讀一個品牌的題目。payload {brand}。能巡檢、能看、能設定的人都能讀（填寫要用）。沒存過回 forms:null（前端用預設） */
function handleInspBankGet_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  var brand = inspStr_(payload && payload.brand);
  if (INSP_BRANDS.indexOf(brand) === -1) return inspFail_('bad_request', '品牌錯誤');
  var s = c.scope;
  var seesBrand = s.stores.some(function (u) { return (c.org.unit[u] || {}).parent === brand; });
  if (!seesBrand && s.bankBrands.indexOf(brand) === -1) return inspFail_('forbidden', '你沒有這個品牌的巡檢權限');
  var hit = null;
  inspBankRows_().forEach(function (o) { if (o.brand === brand) hit = o; });
  return { ok: true, data: { brand: brand, ver: hit ? inspStr_(hit.ver) : '', forms: hit ? inspJson_(hit.forms, null) : null,
    updated_at: hit ? inspStr_(hit.updated_at) : '', updated_by: hit ? inspStr_(hit.updated_by) : '' } };
}

/** 存一個品牌的題目。payload {brand, forms, expected_ver}（expected_ver 與目前不同＝別人剛改過，擋下） */
function handleInspBankSave_(token, payload) {
  var c = inspEnter_(token);
  if (!c.ok) return c;
  if (!inspReady_()) return inspNotInited_();
  payload = payload || {};
  var brand = inspStr_(payload.brand);
  if (INSP_BRANDS.indexOf(brand) === -1) return inspFail_('bad_request', '品牌錯誤');
  if (c.scope.bankBrands.indexOf(brand) === -1) return inspFail_('forbidden', '你沒有設定這個品牌題目的權限');
  var fc = inspCleanForms_(payload.forms);
  if (!fc.ok) return fc;
  return inspWithLock_(function () {
    var hit = null;
    inspBankRows_().forEach(function (o) { if (o.brand === brand) hit = o; });
    var cur = hit ? inspStr_(hit.ver) : '';
    if (inspStr_(payload.expected_ver) !== cur) return inspFail_('conflict', '題目剛被別人改過，請重新整理後再改');
    var n = cur ? (Number(cur.replace(/^\D+/, '')) || 0) + 1 : 1;
    var ver = brand + '-v' + n;
    var actor = c.me ? c.me.emp : 'U:' + String(c.user.id);
    var row = { brand: brand, ver: ver, forms: JSON.stringify(fc.forms), updated_at: inspNow_(), updated_by: actor };
    var vals = INSP_BANK_H.map(function (h) { return row[h]; });
    if (hit) stfSheet_(INSP_BANK_SHEET).getRange(hit._row, 1, 1, INSP_BANK_H.length).setValues([vals]);
    else stfAppendBlock_(INSP_BANK_SHEET, [vals], INSP_BANK_H.length, true);
    stfLog_('', 'insp_bank_save', actor, brand + ' ' + ver + ' ' + fc.total + '題');
    return { ok: true, data: { brand: brand, ver: ver, total: fc.total } };
  });
}
