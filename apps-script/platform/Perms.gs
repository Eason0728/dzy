/**
 * 個人帳號第二期：依單位＋職稱給權限（docs/permissions/spec.md v1.1，衝突以第 13 節為準）。
 * P1 後端計算：常數、四張表建表、permCompute_（純函式）、規則／例外驗證、讀表 helper。
 * 不接線（Auth.gs／Code.gs 是 P2）。所有代碼比對先 String()：Mac mini 的假試算表會把像數字的字串變數字。
 */

// ============================================================
// 1. 常數
// ============================================================

// 可給的權限碼白名單（順序即畫面順序）
var PERM_GRANTABLE = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap'];
// 鎖碼：只有 role admin 能在對照表新增／刪除含這些碼的規則
var PERM_LOCKED = ['platform.users', 'platform.permmap'];

var PERM_SHEET_MAP = 'perm_map';
var PERM_SHEET_EX = 'perm_ex';
var PERM_SHEET_STORE = 'perm_store_map';
var PERM_SHEET_AUDIT = 'perm_audit';

var PERM_MAP_HEADERS = ['rule_id', 'ladder', 'dept', 'title', 'perm', 'active', 'updated_at', 'updated_by'];
var PERM_EX_HEADERS = ['ex_id', 'emp_no', 'perm', 'mode', 'until', 'note', 'active', 'created_at', 'created_by', 'revoked_at', 'revoked_by'];
var PERM_STORE_HEADERS = ['unit', 'audit_store', 'updated_at', 'updated_by'];
var PERM_AUDIT_HEADERS = ['at', 'by', 'emp_no', 'added', 'removed', 'cause', 'seen'];

var PERM_LADDERS = ['store', 'office', 'hq'];

// 預設規則（spec §3.1）：[ladder, dept, title, perm]；寫入時依序編 R001…（共 19 條）
var PERM_DEFAULT_RULES = (function () {
  var out = [];
  var add = function (ladder, dept, title, perms) {
    perms.forEach(function (p) { out.push([ladder, dept, title, p]); });
  };
  add('store', '', 'sm', ['audit.read.own']);
  ['oam', 'osv', 'odir'].forEach(function (t) { add('office', '', t, ['audit.read.brand']); });
  add('hq', 'ops', '*', ['audit.read']);
  add('hq', 'mgmt', '*', ['audit.read', 'audit.write']);
  add('hq', 'fin', '*', ['audit.read', 'audit.write']);
  ['ceo', 'gm', 'chair'].forEach(function (t) { add('hq', '', t, ['audit.read', 'dorm.read']); });
  add('hq', 'hr', '*', ['platform.staff', 'dorm.read', 'dorm.write']);
  add('hq', 'hr', 'hm', ['platform.permmap']);
  return out;
})();

// 預設店別對照（spec §3.3）：[組織單位, 稽核店別]
var PERM_DEFAULT_STORES = [['mala-gf', 'sxl-gf'], ['ck', 'ck'], ['mzt-gf', 'mzt-gf'], ['mzt-js', 'mzt-js'], ['mzt-lzl', 'mzt-lzl']];

// ============================================================
// 2. 小工具
// ============================================================

function permStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

function permPad2_(n) { return (n < 10 ? '0' : '') + n; }

function permIsDate_(v) {
  return !!v && typeof v === 'object' && typeof v.getTime === 'function';
}

/** 台北現在時間文字 YYYY-MM-DD HH:mm:ss（不依賴其他 .gs） */
function permNowText_() {
  var t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + permPad2_(t.getUTCMonth() + 1) + '-' + permPad2_(t.getUTCDate()) + ' ' +
    permPad2_(t.getUTCHours()) + ':' + permPad2_(t.getUTCMinutes()) + ':' + permPad2_(t.getUTCSeconds());
}

/** 台北今天 YYYY-MM-DD（給呼叫端用；permCompute_ 本身不取時間） */
function permTodayTaipei_() { return permNowText_().slice(0, 10); }

/**
 * Sheet 的 Date 物件或字串 → 台北 YYYY-MM-DD；無效回 ''。
 * 字串接受 YYYY-MM-DD、YYYY/M/D（後面帶時間會忽略）；日期必須真實存在。
 */
function permNormDate_(v) {
  if (v === undefined || v === null) return '';
  if (permIsDate_(v)) {
    if (isNaN(v.getTime())) return '';
    if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
      return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    }
    var t = new Date(v.getTime() + 8 * 3600 * 1000);
    return t.getUTCFullYear() + '-' + permPad2_(t.getUTCMonth() + 1) + '-' + permPad2_(t.getUTCDate());
  }
  if (typeof v !== 'string') return '';
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T].*)?$/.exec(v.trim());
  if (!m) return '';
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + permPad2_(mo) + '-' + permPad2_(d);
}

function permIdx_(perm) { return PERM_GRANTABLE.indexOf(perm); }
function permIsGrantable_(perm) { return permIdx_(permStr_(perm)) !== -1; }
function permIsActive_(v) {
  if (v === true) return true;
  return permStr_(v).toUpperCase() === 'TRUE';
}

function permUniqSorted_(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
  return out.sort();
}

// ============================================================
// 3. 建表（admin 按「初始化」才建；只補不覆蓋）
// ============================================================

function permAuthRole_(auth) {
  if (!auth) return '';
  if (auth.role !== undefined) return permStr_(auth.role);
  if (auth.user && auth.user.role !== undefined) return permStr_(auth.user.role);
  return '';
}
function permAuthId_(auth) {
  if (!auth) return '';
  if (auth.id !== undefined) return permStr_(auth.id);
  if (auth.user && auth.user.id !== undefined) return permStr_(auth.user.id);
  return '';
}

/** 表頭檢查：回 '' ＝可用（不存在、空表頭、或一致）；否則回錯誤訊息 */
function permHeaderProblem_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) return '';
  var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(function (v) { return String(v).trim(); });
  var empty = cur.every(function (v) { return v === ''; });
  if (empty || cur.join('|') === headers.join('|')) return '';
  return '分頁「' + name + '」的表頭與程式不一致，停止初始化以免資料錯位：' + cur.join(',');
}

function permEnsureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  var created = false;
  if (!sh) { sh = ss.insertSheet(name); created = true; }
  var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var empty = cur.every(function (v) { return String(v).trim() === ''; });
  if (empty) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return { sheet: sh, created: created };
}

/**
 * 初始化四張權限分頁。只有 role admin。只補不覆蓋：表頭一致就不動；
 * perm_map 只有表頭（空表）才寫 19 條預設規則；perm_store_map 空表才寫 5 筆對照。
 * 任一分頁表頭不一致 → 一張都不建，回錯。
 * 回 { ok:true, created:[分頁名], rules_seeded:n, stores_seeded:n } 或 { ok:false, error, message }
 */
function permInit_(auth) {
  if (permAuthRole_(auth) !== 'admin') return { ok: false, error: 'no_perm', message: '只有系統管理者能初始化權限分頁' };
  var ss = SpreadsheetApp.getActive();
  var specs = [[PERM_SHEET_MAP, PERM_MAP_HEADERS], [PERM_SHEET_EX, PERM_EX_HEADERS], [PERM_SHEET_STORE, PERM_STORE_HEADERS], [PERM_SHEET_AUDIT, PERM_AUDIT_HEADERS]];
  for (var i = 0; i < specs.length; i++) {
    var prob = permHeaderProblem_(ss, specs[i][0], specs[i][1]);
    if (prob) return { ok: false, error: 'header_mismatch', message: prob };
  }
  var created = [];
  var sheets = {};
  specs.forEach(function (s) {
    var r = permEnsureSheet_(ss, s[0], s[1]);
    sheets[s[0]] = r.sheet;
    if (r.created) created.push(s[0]);
  });
  var now = permNowText_();
  var by = permAuthId_(auth) || 'system';
  var rulesSeeded = 0, storesSeeded = 0;

  var mapSh = sheets[PERM_SHEET_MAP];
  if (mapSh.getLastRow() <= 1) {
    var rows = PERM_DEFAULT_RULES.map(function (r, idx) {
      var n = idx + 1;
      return ['R' + (n < 10 ? '00' : n < 100 ? '0' : '') + n, r[0], r[1], r[2], r[3], 'TRUE', now, by];
    });
    mapSh.getRange(2, 1, rows.length, PERM_MAP_HEADERS.length).setValues(rows);
    rulesSeeded = rows.length;
  }
  var stSh = sheets[PERM_SHEET_STORE];
  if (stSh.getLastRow() <= 1) {
    var srows = PERM_DEFAULT_STORES.map(function (s) { return [s[0], s[1], now, by]; });
    stSh.getRange(2, 1, srows.length, PERM_STORE_HEADERS.length).setValues(srows);
    storesSeeded = srows.length;
  }
  return { ok: true, created: created, rules_seeded: rulesSeeded, stores_seeded: storesSeeded };
}

// ============================================================
// 4. 權限計算（純函式）
// ============================================================

/**
 * input = { staff:{status,brand,unit,dept,title,extra_depts:[...],emp_no?},
 *           org:{units:{code:{ladder,parent}}, titles:{code:{parent,rank}}},
 *           rules:[{rule_id,ladder,dept,title,perm}], exs:[{ex_id,emp_no?,perm,mode,until}],
 *           storeMap:{unit:audit_store}, today:'YYYY-MM-DD' }
 * 回 { perms:[…], auditScope:'all'|'none'|[codes], sources:[{perm,source,rule_id?,ex_id?,until?}] }
 * rules／exs 預期已只含 active 的列；exs 若帶 emp_no 且 staff 也帶 emp_no，會再過濾一次。
 */
function permCompute_(input) {
  var empty = { perms: [], auditScope: 'none', sources: [] };
  if (!input || !input.staff) return empty;
  var staff = input.staff;
  if (permStr_(staff.status).toLowerCase() !== 'active') return empty;

  var org = input.org || {};
  var unit = org.units && org.units[permStr_(staff.unit)];
  var ladder = unit ? permStr_(unit.ladder) : '';
  var title = permStr_(staff.title);
  var brand = permStr_(staff.brand);
  var today = permStr_(input.today);

  var depts = {};
  if (permStr_(staff.dept)) depts[permStr_(staff.dept)] = true;
  (staff.extra_depts || []).forEach(function (d) { if (permStr_(d)) depts[permStr_(d)] = true; });

  // 3. 規則聯集
  var granted = {};   // perm -> [sources]
  var addSource = function (perm, src) {
    if (!granted[perm]) granted[perm] = [];
    granted[perm].push(src);
  };
  (input.rules || []).forEach(function (r) {
    if (!r) return;
    var perm = permStr_(r.perm);
    if (!permIsGrantable_(perm)) return;
    if (!ladder || permStr_(r.ladder) !== ladder) return;
    var rt = permStr_(r.title);
    if (rt !== '*' && rt !== title) return;
    var rd = permStr_(r.dept);
    if (rd !== '' && !depts[rd]) return;
    var src = { perm: perm, source: (rd !== '' && rt === '*') ? 'dept' : 'title' };
    if (permStr_(r.rule_id)) src.rule_id = permStr_(r.rule_id);
    addSource(perm, src);
  });

  // 4. 例外：add 加入；remove 優先
  var removes = {};
  var empNo = permStr_(staff.emp_no).toUpperCase();
  (input.exs || []).forEach(function (x) {
    if (!x) return;
    if (empNo && permStr_(x.emp_no) && permStr_(x.emp_no).toUpperCase() !== empNo) return;
    var perm = permStr_(x.perm);
    if (!permIsGrantable_(perm)) return;
    var mode = permStr_(x.mode).toLowerCase();
    var rawUntil = permStr_(x.until);
    var until = permNormDate_(x.until);
    var valid;
    if (rawUntil === '' ) valid = true;
    else if (until === '') valid = (mode === 'remove');   // 壞日期：add 不給（fail closed）、remove 照樣拿掉
    else valid = until >= today;
    if (!valid) return;
    if (mode === 'add') {
      var src = { perm: perm, source: 'exception' };
      if (permStr_(x.ex_id)) src.ex_id = permStr_(x.ex_id);
      if (until) src.until = until;
      addSource(perm, src);
    } else if (mode === 'remove') {
      removes[perm] = true;
    }
  });

  var perms = Object.keys(granted).filter(function (p) { return !removes[p]; });
  perms.sort(function (a, b) { return permIdx_(a) - permIdx_(b); });
  // 輸出陣列去重＋依代碼排序（契約：陣列已去重、排序）
  perms = permUniqSorted_(perms);

  var sources = [];
  perms.forEach(function (p) {
    var seen = {};
    granted[p].forEach(function (s) {
      var k = s.source + '|' + (s.rule_id || '') + '|' + (s.ex_id || '');
      if (seen[k]) return;
      seen[k] = true;
      sources.push(s);
    });
  });

  // 6. 稽核範圍
  var has = function (p) { return perms.indexOf(p) !== -1; };
  var scope = 'none';
  var storeMap = input.storeMap || {};
  if (has('audit.read') || has('audit.write')) {
    scope = 'all';
  } else if (has('audit.read.brand')) {
    var list = [];
    var units = org.units || {};
    Object.keys(units).forEach(function (code) {
      if (permStr_(units[code].parent) !== brand) return;
      var st = permStr_(storeMap[code]);
      if (st) list.push(st);
    });
    scope = permUniqSorted_(list);
  } else if (has('audit.read.own')) {
    var own = permStr_(storeMap[permStr_(staff.unit)]);
    scope = own ? [own] : [];
  }
  return { perms: perms, auditScope: scope, sources: sources };
}

// ============================================================
// 5. 驗證
// ============================================================

function permErr_(code, message) { return { error: code, message: message }; }

/**
 * 規則驗證。rule={ladder,dept,title,perm}；org 為 permOrgIndex_() 的形狀（含 depts）；isAdmin 布林。
 * 回 null＝合法；否則 {error:'bad_perm'|'perm_locked'|'bad_target', message}
 */
function permValidateRule_(rule, org, isAdmin) {
  rule = rule || {};
  org = org || {};
  var perm = permStr_(rule.perm);
  if (!permIsGrantable_(perm)) return permErr_('bad_perm', '這個功能不能設定在對照表裡');
  if (!isAdmin && PERM_LOCKED.indexOf(perm) !== -1) return permErr_('perm_locked', '只有系統管理者能改這個功能的對象');
  var ladder = permStr_(rule.ladder);
  if (PERM_LADDERS.indexOf(ladder) === -1) return permErr_('bad_target', '單位階梯不正確');
  var title = permStr_(rule.title);
  if (title !== '*') {
    var t = org.titles && org.titles[title];
    if (!t || t.active === false || permStr_(t.parent) !== ladder) return permErr_('bad_target', '這個職稱不屬於所選的單位階梯，或已停用');
  }
  var dept = permStr_(rule.dept);
  if (dept !== '') {
    if (ladder !== 'hq') return permErr_('bad_target', '只有總部能指定部門');
    var d = org.depts && org.depts[dept];
    if (!d || d.active === false) return permErr_('bad_target', '這個部門不存在或已停用');
  }
  return null;
}

/**
 * 例外驗證。ex={perm,mode,until,note}；today 為台北 YYYY-MM-DD。
 * 回 null＝合法；否則 {error:'bad_perm'|'bad_mode'|'bad_until'|'bad_note', message}
 */
function permValidateEx_(ex, today) {
  ex = ex || {};
  if (!permIsGrantable_(ex.perm)) return permErr_('bad_perm', '這個功能不能設成例外');
  var mode = permStr_(ex.mode);
  if (mode !== 'add' && mode !== 'remove') return permErr_('bad_mode', '請選擇多給或拿掉');
  var rawUntil = ex.until;
  if (!(rawUntil === undefined || rawUntil === null || permStr_(rawUntil) === '')) {
    var n = permNormDate_(rawUntil);
    if (!n || (typeof rawUntil === 'string' && permStr_(rawUntil) !== n)) return permErr_('bad_until', '到期日格式要是 YYYY-MM-DD');
    if (n < permStr_(today)) return permErr_('bad_until', '到期日不能早於今天');
  }
  var note = permStr_(ex.note);
  var len = Array.from(note).length;
  if (len < 1 || len > 50) return permErr_('bad_note', '原因必填，1 到 50 個字');
  return null;
}

// ============================================================
// 6. 讀表 helper（碰 SpreadsheetApp；不進 permCompute_）
// ============================================================

function permReadTable_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) return { missing: true, rows: [] };
  var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(function (v) { return String(v).trim(); });
  if (cur.join('|') !== headers.join('|')) return { missing: false, mismatch: true, rows: [] };
  var last = sh.getLastRow();
  if (last < 2) return { missing: false, rows: [] };
  return { missing: false, rows: sh.getRange(2, 1, last - 1, headers.length).getValues() };
}

/**
 * 讀 perm_map／perm_ex／perm_store_map（只取 active=TRUE）。
 * 表不存在或表頭不對 → {inited:false}（表頭不對另帶 error:'header_mismatch'）。
 * 成功 → {inited:true, rules:[…], exs:[…], storeMap:{unit:audit_store}}
 */
function permLoadTables_() {
  var ss = SpreadsheetApp.getActive();
  var m = permReadTable_(ss, PERM_SHEET_MAP, PERM_MAP_HEADERS);
  var x = permReadTable_(ss, PERM_SHEET_EX, PERM_EX_HEADERS);
  var s = permReadTable_(ss, PERM_SHEET_STORE, PERM_STORE_HEADERS);
  if (m.mismatch || x.mismatch || s.mismatch) return { inited: false, error: 'header_mismatch' };
  if (m.missing || x.missing || s.missing) return { inited: false };
  var rules = [];
  m.rows.forEach(function (r) {
    if (!permIsActive_(r[5])) return;
    rules.push({ rule_id: permStr_(r[0]), ladder: permStr_(r[1]), dept: permStr_(r[2]), title: permStr_(r[3]), perm: permStr_(r[4]) });
  });
  var exs = [];
  x.rows.forEach(function (r) {
    if (!permIsActive_(r[6])) return;
    exs.push({ ex_id: permStr_(r[0]), emp_no: permStr_(r[1]).toUpperCase(), perm: permStr_(r[2]), mode: permStr_(r[3]).toLowerCase(), until: permNormDate_(r[4]), note: permStr_(r[5]) });
  });
  var storeMap = {};
  s.rows.forEach(function (r) {
    var u = permStr_(r[0]);
    if (u) storeMap[u] = permStr_(r[1]);
  });
  return { inited: true, rules: rules, exs: exs, storeMap: storeMap };
}

/**
 * 從 org 分頁組出 permCompute_ 要的 org：{units:{code:{ladder,parent,active}}, titles:{code:{parent,rank,active}}, depts:{code:{parent,active}}}
 * （停用的也收進來，帶 active 旗標；驗證看旗標、計算只看 ladder／parent）
 */
function permOrgIndex_() {
  var out = { units: {}, titles: {}, depts: {} };
  var sh = SpreadsheetApp.getActive().getSheetByName('org');
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < 2) return out;
  var rows = sh.getRange(2, 1, last - 1, 8).getValues();
  rows.forEach(function (r) {
    var kind = permStr_(r[0]);
    var code = permStr_(r[1]);
    if (!code) return;
    var active = permStr_(r[7]).toUpperCase() !== 'FALSE';
    if (kind === 'unit') out.units[code] = { ladder: permStr_(r[4]), parent: permStr_(r[3]), active: active };
    else if (kind === 'title') out.titles[code] = { parent: permStr_(r[3]), rank: Number(r[5]) || 0, active: active };
    else if (kind === 'dept') out.depts[code] = { parent: permStr_(r[3]), active: active };
  });
  return out;
}
