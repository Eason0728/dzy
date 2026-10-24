/**
 * 鼎兆元管理系統｜平台後端 — 同仁帳號與個人資料（個人帳號管理第一期）
 * 正本規格：docs/personnel/spec.md（v2）。章節號以下簡稱 §。
 *
 * 本檔依賴 Auth.gs（handleMe_／hashPassword_／issueToken_／getRolePerms_／
 * setTokenAfter_／writeLoginLog_）與 Users.gs（generateNextUserId_／usrFormatTaipeiDatetime_）。
 * 分頁名與欄序用 STF_ 前綴獨立宣告（同 Users.gs 的作法，避免跨檔撞名）。
 *
 * ⚠ 同仁姓名、生日、手機、地址只存在試算表；本檔與 repo 任何地方都不得出現真實資料（dzy 是 public repo）。
 * ⚠ staff_log 的 detail 欄只寫欄位名稱，絕不寫生日／手機／地址／密碼（§4.3）。
 */

var STF_SHEET = 'staff';
var STF_SHEET_ORG = 'org';
var STF_SHEET_LOG = 'staff_log';

var STF_HEADERS = ['emp_no', 'user_id', 'name', 'status', 'brand', 'unit', 'dept', 'title',
  'p_brand', 'p_unit', 'p_dept', 'p_title', 'birthday', 'phone', 'address', 'reject_reason',
  'reset_fail', 'reset_locked', 'claimed_at', 'confirmed_at', 'updated_at',
  'prev_status', 'reset_lock_until', 'reset_lock_count'];
var STF_COL = {};
STF_HEADERS.forEach(function (h, i) { STF_COL[h] = i; });
var STF_COL_COUNT = STF_HEADERS.length;

var STF_ORG_HEADERS = ['kind', 'code', 'name', 'parent', 'ladder', 'rank', 'order', 'active'];
var STF_LOG_HEADERS = ['at', 'emp_no', 'event', 'by', 'detail'];

var STF_STATUSES = ['unclaimed', 'pending', 'active', 'rejected', 'disabled'];
var STF_EMP_RE = /^DZY[0-9]{3}$/;
var STF_ORG_FIELDS = ['brand', 'unit', 'dept', 'title'];

// 兼任部門（組織改版 T2）：staff 分頁尾端第 27 欄 extra_depts（排在 StaffClock.gs CLK_STAFF_EXTRA 的 hire_date、last_day 之後；
// 不改 STF_HEADERS）。值＝部門代碼以半形逗號相連、無空白、依 org order 排序；特別代碼 ck＝兼任中央工廠。
var STF_EXTRA_DEPTS_HEADER = 'extra_depts';
var STF_EXTRA_DEPTS_COL_NO = STF_COL_COUNT + 3;   // 1-based 欄號
var STF_EXTRA_CK = 'ck';

// 門檻（§6.4）：store 職級 rank≥3（店長）、hq 職級 rank≥2（總監）可看單位通訊錄
// office（品牌辦公室，自己一套 ofs/oam/osv/odir 職稱）：rank≥2 區經理以上算品牌辦公室主管（規格第 13 節）
var STF_UNIT_VIEW_MIN_RANK = { store: 3, hq: 2, office: 2 };

// 單位限定職稱（Eason 2026-10-20，docs/org/spec.md 第 15 節）：
//   STF_UNIT_TITLES：列出的單位「只能」選這些職稱（中央工廠沒有店長、區經理，改設廠長 fm、廚藝總監 rdd）；
//   STF_TITLE_UNITS：這些職稱「只能」用在列出的單位（廠長、廚藝總監只在中央工廠）。
// 生效條件：某單位清單裡的專屬職稱（STF_TITLE_UNITS 的鍵）至少一個在 org 裡存在且啟用，該單位的限定才生效——
// 後端先上線、還沒按 orgUpgrade202610 之前，org 沒有 fm／rdd 列，中央工廠店長照舊有效（不會在切換前失去審核／權限）。
// 判斷一律走 stfTitleFitsUnit_／stfTitleUnitOk_（stfValidateOrg_、名單旗標、審核、考勤、Perms.gs permCompute_ 共用）；
// 前端由 orgOptions 的 unit_titles／title_units 拿同一份（org-fields.js titlesForUnit）。
var STF_UNIT_TITLES = { ck: ['pt', 'ft', 'fm', 'rdd'] };
var STF_TITLE_UNITS = { fm: ['ck'], rdd: ['ck'] };
// 「店長同等」的同店主管職稱：門市店長 sm、中央工廠廠長 fm（請購請款單位主管、考勤核定、營運系統管理單位都一樣）
var STF_STORE_HEAD_TITLES = ['sm', 'fm'];

// 忘記密碼（§6.6）
var STF_RESET_FAIL_LIMIT = 5;
var STF_RESET_TIMELOCK_SECONDS = 60 * 60;
var STF_RESET_TIMELOCK_MAX_PER_DAY = 3;

// 登入前限流（§6.1）
var STF_NAME_MISS_LIMIT = 5;
var STF_NAME_MISS_WINDOW = 10 * 60;
var STF_GLOBAL_LIMIT = 600;
var STF_GLOBAL_WINDOW = 10 * 60;

// 登入前欄位長度上限（2026-10-12）：超過一律在碰 cache／表之前就拒絕（原始字串長度，trim 前量）
var STF_MAX = { name: 30, emp_no: 16, phone: 20, birthday: 10, address: 100, org: 40, password: 128 };

var STF_MSG = {
  NO_PERM: '沒有權限',
  NOT_IN_ROSTER: '名單上找不到這個名字，請找後台',
  ALREADY_CLAIMED: '這個名字已經開通，請用編號登入',
  NAME_AMBIGUOUS: '名單上有同名的人，請找後台',
  CLAIM_MISMATCH: '姓名與編號對不上，請重新輸入全名',
  TOO_MANY: '操作太頻繁，請稍後再試',
  RESET_MISMATCH: '資料不符，請確認或找後台',
  RESET_TIMELOCK: '錯太多次，請 1 小時後再試，或找後台',
  RESET_LOCKED: '忘記密碼已鎖住，請找後台解鎖，或 24 小時後再試',
  NOT_FOUND: '找不到這位同仁',
  BAD_STATE: '目前的狀態不能做這個動作',
  NO_PENDING: '這位同仁沒有待確認的資料',
  REASON_REQUIRED: '請填寫退回原因',
  NAMES_REQUIRED: '請貼上至少一個姓名',
  FULL: '編號已經用到 DZY999，請聯絡系統維護者',
  UNIT_ONLY_MANAGER: '只有店長（總部為總監）以上可以看單位通訊錄',
  NEED_CURRENT_PW: '改手機要輸入目前的密碼',
  PW_TOO_LONG: '密碼最多 128 個字元',
  NAME_TOO_LONG: '姓名最多 30 個字',
  // 認領後主管審核（Eason 2026-10-12）
  CLAIM_PENDING: '這個名字已經送出開通申請，等單位主管審核通過就能用編號登入',
  LOGIN_PENDING: '帳號還在等主管審核',
  LOGIN_REJECTED: '帳號資料被退回，請找人資重新開通',
  NOT_REVIEWER: '只有單位主管可以審核',
  NO_EXTRA_PERM: '沒有權限修改兼任部門',
  NO_BULLETIN_PERM: '沒有權限設定公告管理',
  REVIEW_SELF: '不能審核自己',
  NOT_PENDING_REVIEW: '這位同仁不在等待審核',
  REASON_TOO_LONG: '退回原因最多 200 個字'
};
var STF_REASON_MAX = 200;
// 姓名開頭 = + - @ 會在試算表／打卡名冊變成公式：匯入、新增、改名一律擋（員工名單統一，上線前關 F2）
// （只在有 StaffClock.gs 的環境檢查：第一期單獨的測試仍驗證 users 姓名會加單引號防公式）
function stfBadNameStart_(n) { return typeof clkNameBadStart_ === 'function' && clkNameBadStart_(n); }
var STF_MSG_NAME_START = '姓名開頭不能是 = + - @ 這四個符號（會被試算表當成公式），請改寫或把符號放在後面';

// ============================================================
// 1. 共用小工具
// ============================================================

function stfNowSec_() { return Math.floor(Date.now() / 1000); }
function stfNowText_() { return usrFormatTaipeiDatetime_(new Date()); }
function stfStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

/** 試算表可能把手機存成數字（吃掉前導 0），比對前補回 10 碼（Fable 第 10 條） */
function stfPhone_(v) {
  if (typeof v === 'number') {
    var s = String(Math.round(v));
    while (s.length < 10) s = '0' + s;
    return s;
  }
  return stfStr_(v).replace(/[\s-]/g, '');
}

/** 試算表可能把生日轉成 Date 物件，比對前轉回台北時區 YYYY-MM-DD */
function stfDate_(v) {
  if (v && typeof v === 'object' && typeof v.getTime === 'function') {
    var t = new Date(v.getTime() + 8 * 60 * 60 * 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  return stfStr_(v);
}

function stfNormEmp_(v) { return stfStr_(v).toUpperCase(); }

// 公告管理權限（2026-10-17 Eason：同仁名單逐人勾選、人資與 admin 可設）：可管理電子佈告欄公告的同仁編號清單，
// 存在 Script Property BULLETIN_ADMINS（逗號分隔 DZY###）。不另開 staff 尾端欄位（尾端欄有組織升級／備份機制，改動面太大）。
// 有勾的人登入時衍生權限 platform.bulletin（Auth.gs authPermsWithGate_）；admin（'*'）本來就有。
var STF_PROP_BULLETIN = 'BULLETIN_ADMINS';
function stfBulletinAdmins_() {
  var raw = PropertiesService.getScriptProperties().getProperty(STF_PROP_BULLETIN) || '';
  return raw.split(',').map(function (x) { return stfNormEmp_(x); }).filter(function (x) { return STF_EMP_RE.test(x); });
}
/** 這個帳號（users id）對應的同仁列有勾「可管理公告」且未停用 → true（給非 staff 角色用；staff 角色走 stfLoginGate_） */
function stfBulletinGate_(userId) {
  if (!stfSheet_(STF_SHEET)) return false;
  var hit = stfFindByUserId_(userId);
  if (!hit || stfStr_(hit.values[STF_COL.status]) !== 'active') return false;   // 只有已開通（審查 #44-13）
  return stfBulletinAdmins_().indexOf(stfNormEmp_(hit.values[STF_COL.emp_no])) !== -1;
}
function stfSetBulletinAdmin_(emp, on) {
  var e = stfNormEmp_(emp), list = stfBulletinAdmins_().filter(function (x) { return x !== e; });
  if (on) list.push(e);
  list.sort();
  PropertiesService.getScriptProperties().setProperty(STF_PROP_BULLETIN, list.join(','));
}

/** 原始欄位長度超過上限 → true（非字串、非數字一律當超過；undefined／null 當空字串通過） */
function stfTooLong_(v, max) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return String(v).length > max;
  if (typeof v !== 'string') return true;
  return v.length > max;
}

function stfSheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

function stfReadRows_(name, colCount) {
  var sh = stfSheet_(name);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  // 依實際欄數讀（舊分頁可能比 colCount 少，例如只有 26 欄；越界在真 Apps Script 會丟 range invalid），缺的欄補空字串
  var have = typeof sh.getMaxColumns === 'function' ? Math.min(colCount, sh.getMaxColumns()) : colCount;
  if (have < 1) have = 1;
  var vals = sh.getRange(2, 1, last - 1, have).getValues();
  if (have < colCount) {
    vals = vals.map(function (r) { var o = r.slice(); while (o.length < colCount) o.push(''); return o; });
  }
  return vals;
}

/** 寫一整列前先把該列設成純文字，再 setValues（不用 appendRow，新列不一定繼承欄格式） */
function stfWriteRow_(name, rowNumber, values, colCount) {
  var sh = stfSheet_(name);
  var range = sh.getRange(rowNumber, 1, 1, colCount);
  range.setNumberFormat('@');
  var out = values.slice(0, colCount);
  while (out.length < colCount) out.push('');
  range.setValues([out]);
}

function stfAppendRow_(name, values, colCount) {
  var sh = stfSheet_(name);
  stfWriteRow_(name, sh.getLastRow() + 1, values, colCount);
}

/** 一次在表尾寫多列；asText＝先把那一塊設成純文字 */
function stfAppendBlock_(name, rows, colCount, asText) {
  if (!rows.length) return;
  var sh = stfSheet_(name);
  var range = sh.getRange(sh.getLastRow() + 1, 1, rows.length, colCount);
  if (asText) range.setNumberFormat('@');
  range.setValues(rows.map(function (r) {
    var out = r.slice(0, colCount);
    while (out.length < colCount) out.push('');
    return out;
  }));
}

function stfLog_(empNo, event, by, detail) {
  var sh = stfSheet_(STF_SHEET_LOG);
  if (!sh) return;
  stfAppendRow_(STF_SHEET_LOG, [stfNowText_(), empNo, event, by, detail || ''], STF_LOG_HEADERS.length);
}

// ============================================================
// 2. org（下拉選單正本，§4.2）
// ============================================================

function stfReadOrg_() {
  return stfBuildOrg_(stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length));
}

/** org 分頁的資料列（不含表頭，八欄）→ 查表物件；升級預覽用記憶體裡改過的列來建 */
function stfBuildOrg_(rows) {
  var org = { brand: {}, unit: {}, dept: {}, title: {}, list: { brand: [], unit: [], dept: [], title: [] } };
  rows.forEach(function (r) {
    var kind = stfStr_(r[0]);
    if (!org[kind] || kind === 'list') return;
    var item = {
      code: stfStr_(r[1]), name: stfStr_(r[2]), parent: stfStr_(r[3]), ladder: stfStr_(r[4]),
      rank: Number(r[5]) || 0, order: Number(r[6]) || 0,
      active: String(r[7]).trim().toUpperCase() !== 'FALSE'
    };
    if (!item.code) return;
    org[kind][item.code] = item;
    org.list[kind].push(item);
  });
  Object.keys(org.list).forEach(function (k) {
    org.list[k].sort(function (a, b) { return a.order - b.order; });
  });
  org.unitRules = stfUnitTitleRules_(function (c) { return !!org.title[c] && org.title[c].active; });
  return org;
}

/**
 * 生效中的單位限定職稱規則（見 STF_UNIT_TITLES）。titleActive(code)＝這個職稱在 org 裡存在且啟用。
 * 回 {unit_titles: {單位: [職稱…]}（只含已生效的單位）, title_units: {職稱: [單位…]}}。
 */
function stfUnitTitleRules_(titleActive) {
  var out = { unit_titles: {}, title_units: {} };
  Object.keys(STF_UNIT_TITLES).forEach(function (u) {
    var list = STF_UNIT_TITLES[u];
    if (list.some(function (t) { return !!STF_TITLE_UNITS[t] && titleActive(t); })) out.unit_titles[u] = list.slice();
  });
  Object.keys(STF_TITLE_UNITS).forEach(function (t) { out.title_units[t] = STF_TITLE_UNITS[t].slice(); });
  return out;
}

/** 單位限定這一關（不看階梯、啟用）：rules＝stfUnitTitleRules_ 的結果；沒有 rules＝不限定 */
function stfTitleUnitOk_(rules, titleCode, unitCode) {
  if (!rules) return true;
  var ul = rules.unit_titles && rules.unit_titles[unitCode];
  if (ul && ul.indexOf(titleCode) === -1) return false;
  var tl = rules.title_units && rules.title_units[titleCode];
  if (tl && tl.indexOf(unitCode) === -1) return false;
  return true;
}

/** 職稱能不能用在這個單位：職稱存在、啟用、屬於單位的職稱階梯、且符合單位限定（單位本身是否啟用由呼叫端判斷） */
function stfTitleFitsUnit_(org, titleCode, unitCode) {
  var u = org.unit[unitCode];
  var t = org.title[titleCode];
  if (!u || !t || !t.active) return false;
  if (t.parent !== (u.ladder || 'store')) return false;
  return stfTitleUnitOk_(org.unitRules, titleCode, unitCode);
}

function stfActiveDeptsOf_(org, unitCode) {
  return org.list.dept.filter(function (d) { return d.active && d.parent === unitCode; });
}

/** §6.5 組織四欄驗證。回 null＝通過，否則回白話錯誤 */
function stfValidateOrg_(org, v) {
  var b = org.brand[v.brand];
  if (!b || !b.active) return '請選擇品牌';
  var u = org.unit[v.unit];
  if (!u || !u.active || u.parent !== v.brand) return '請選擇這個品牌底下的單位';
  var depts = stfActiveDeptsOf_(org, v.unit);
  if (u.ladder === 'hq' && depts.length) {
    var d = org.dept[v.dept];
    if (!d || !d.active || d.parent !== v.unit) return '請選擇部門';
  } else if (v.dept) {
    return '這個單位不用選部門';
  }
  if (!stfTitleFitsUnit_(org, v.title, v.unit)) return '請選擇這個單位適用的職稱';
  return null;
}

/** §6.5 個資驗證。回 null＝通過 */
function stfValidateBirthday_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '生日格式要是 YYYY-MM-DD';
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '生日不是有效的日期';
  var nowY = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
  var age = nowY - y;
  if (age < 15 || age > 80) return '生日年份看起來不對，請再確認';
  return null;
}
function stfValidatePhone_(s) { return /^09[0-9]{8}$/.test(s) ? null : '手機要是 09 開頭的 10 碼數字'; }
function stfValidateAddress_(s) { return (s.length >= 5 && s.length <= 100) ? null : '居住地址請填 5～100 個字'; }
function stfValidatePassword_(pw, empNo) {
  if (pw.length < 8) return '密碼至少要 8 個字元';
  if (pw.length > STF_MAX.password) return STF_MSG.PW_TOO_LONG;
  if (pw.toUpperCase() === String(empNo).toUpperCase()) return '密碼不能跟編號一樣';
  return null;
}

function handleOrgOptions_() {
  var org = stfReadOrg_();
  var pick = function (kind, fields) {
    return org.list[kind].filter(function (x) { return x.active; }).map(function (x) {
      var o = { code: x.code, name: x.name };
      fields.forEach(function (f) { o[f] = x[f]; });
      return o;
    });
  };
  return {
    ok: true,
    data: {
      brands: pick('brand', []),
      units: pick('unit', ['parent', 'ladder']),
      depts: pick('dept', ['parent']),
      titles: pick('title', ['parent', 'rank']),
      // 單位限定職稱（第 15 節）：前端 org-fields.js titlesForUnit 依這兩份過濾職稱下拉
      unit_titles: org.unitRules.unit_titles,
      title_units: org.unitRules.title_units
    }
  };
}

// ============================================================
// 2b. 兼任部門 extra_depts（組織改版 T2）與名單旗標
// ============================================================

/** staff 第 27 欄狀態：'ok'＝表頭是 extra_depts；'missing'＝還沒有這欄（或欄數不夠）；'mismatch'＝那格有別的表頭；'nosheet' */
function stfExtraColState_() {
  var sh = stfSheet_(STF_SHEET);
  if (!sh) return 'nosheet';
  var cur;
  try { cur = String(sh.getRange(1, STF_EXTRA_DEPTS_COL_NO, 1, 1).getValues()[0][0]).trim(); } catch (e) { return 'missing'; }
  if (cur === STF_EXTRA_DEPTS_HEADER) return 'ok';
  return cur === '' ? 'missing' : 'mismatch';
}

function stfSplitCodes_(str) {
  return stfStr_(str) === '' ? [] : stfStr_(str).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

/** {emp_no(大寫): 'it,training'}；欄位還沒建就回空物件 */
function stfReadExtraMap_() {
  var map = {};
  if (stfExtraColState_() !== 'ok') return map;
  var sh = stfSheet_(STF_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return map;
  var emps = sh.getRange(2, 1, last - 1, 1).getValues();
  var ex = sh.getRange(2, STF_EXTRA_DEPTS_COL_NO, last - 1, 1).getValues();
  for (var i = 0; i < emps.length; i++) map[stfNormEmp_(emps[i][0])] = stfStr_(ex[i][0]);
  return map;
}

function stfExtraDeptName_(org, code) {
  if (code === STF_EXTRA_CK) return '中央工廠';   // 兼任的是單位中央工廠；品牌欄 2026-10-23 起叫「研發部」，不跟著品牌名
  return org.dept[code] ? org.dept[code].name : code;
}

/**
 * 名單旗標明細（契約 plan.md，規格第 13 節）：回 [{flag, submitted}]。
 * 'unit_inactive'＝單位已停用（或單位代碼已不存在）、'title_ladder'＝職稱停用、不存在或不屬於該單位的職稱階梯、
 * 'dept_inactive'＝部門代碼不存在或已停用（主要部門與送出的部門都檢查）、
 * 'exec_misplaced'＝職稱 ceo／gm／chair 但單位不是 dzy-hq 或部門不是 mgmt（第 14 節；可與 title_ladder 同時出現）。
 * submitted＝true 表示問題出在「送出待審的資料」（p_unit／p_title）而不是目前身分。
 * 目前身分沒有單位（未認領）時只檢查送出資料；已停用帳號 → 空陣列。
 */
function stfFlagDetails_(o, org) {
  var out = [];
  if (o.status === 'disabled') return out;
  var seen = {};
  var add = function (flag, submitted) { var k = flag + '|' + (submitted ? 1 : 0); if (!seen[k]) { seen[k] = true; out.push({ flag: flag, submitted: submitted }); } };
  var check = function (unit, title, dept, submitted, execDept) {
    var u = org.unit[unit];
    if (!u || !u.active) add('unit_inactive', submitted);
    if (dept) { var d = org.dept[dept]; if (!d || !d.active) add('dept_inactive', submitted); }
    if (title && u) {
      if (!stfTitleFitsUnit_(org, title, unit)) add('title_ladder', submitted);
    }
    // 管理部（org 有啟用的 mgmt 列才判斷；切換組織之前不出，免得人資照建議改卻選不到管理部）
    var mg = org.dept[STF_MGMT_DEPT];
    if (mg && mg.active && title) {
      // 執行長以上應掛鼎兆元總部／管理部（只標記，不自動搬）
      if (STF_EXEC_TITLES.indexOf(title) !== -1 && (unit !== 'dzy-hq' || execDept !== STF_MGMT_DEPT)) add('exec_misplaced', submitted);
      // 管理部不設總監：hm 職稱需重選
      if (title === 'hm' && unit === 'dzy-hq' && execDept === STF_MGMT_DEPT) add('title_ladder', submitted);
    }
  };
  if (o.unit) check(o.unit, o.title, o.dept || '', false, o.dept || '');
  var pu = o.p_unit || '';
  var pt = o.p_title || '';
  var pd = o.p_dept || '';
  if (pu || pt || pd) {
    var eu = pu || o.unit;
    if (eu) check(eu, pt, pd, true, pd || (pu ? '' : (o.dept || '')));
  }
  return out;
}

function stfFlags_(o, org) {
  var seen = {};
  return stfFlagDetails_(o, org).map(function (x) { return x.flag; }).filter(function (f) { if (seen[f]) return false; seen[f] = true; return true; });
}

/** 把 extra_depts／extra_dept_names（及可選的 flags）補進 stfToObj_ 的結果 */
function stfDecorate_(o, extraMap, org, withFlags) {
  var codes = stfSplitCodes_(extraMap[stfNormEmp_(o.emp_no)]);
  o.extra_depts = codes;
  o.extra_dept_names = codes.map(function (c) { return stfExtraDeptName_(org, c); });
  o.bulletin_admin = stfBulletinAdmins_().indexOf(stfNormEmp_(o.emp_no)) !== -1;
  if (withFlags) o.flags = stfFlags_(o, org);
  return o;
}

/**
 * 驗證兼任部門陣列。回 {error} 或 {codes: 排序後的代碼陣列}。
 * 規則：陣列；每個是 dzy-hq 底下 active 的部門（或特別代碼 ck）；不得等於主要部門（主要單位是 ck 也不能再兼任 ck）；不得重複。
 */
function stfCleanExtraDepts_(org, list, mainUnit, mainDept, existing) {
  existing = existing || [];   // 這個人目前就有的兼任代碼：停用或已不存在也原樣放行；新加入的才要求啟用中
  if (!Array.isArray(list)) return { error: '兼任部門格式錯誤' };
  var seen = {};
  var codes = [];
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string') return { error: '兼任部門格式錯誤' };
    var c = list[i].trim();
    if (!c) return { error: '兼任部門格式錯誤' };
    if (seen[c]) return { error: '兼任部門不能重複' };
    seen[c] = true;
    if (c === STF_EXTRA_CK) {
      if (mainUnit === STF_EXTRA_CK) return { error: '主要單位已經是中央工廠，不用再兼任' };
    } else {
      var d = org.dept[c];
      if ((!d || !d.active || d.parent !== 'dzy-hq') && existing.indexOf(c) === -1) return { error: '兼任部門只能選鼎兆元總部底下啟用中的部門' };
      if (c === mainDept) return { error: '兼任部門不能和主要部門相同' };
    }
    codes.push(c);
  }
  var orderOf = function (c) { return c === STF_EXTRA_CK ? 1e9 : (org.dept[c] ? org.dept[c].order : 5e8); };
  codes.sort(function (a, b) { return orderOf(a) - orderOf(b) || (a < b ? -1 : 1); });
  return { codes: codes };
}

/** 寫入前確保第 27 欄存在。回 null＝可寫，否則回錯誤字串（表頭不符一律停） */
function stfEnsureExtraCol_() {
  var st = stfExtraColState_();
  if (st === 'ok') return null;
  if (st === 'mismatch') return '分頁「staff」第 ' + STF_EXTRA_DEPTS_COL_NO + ' 欄的表頭不是 extra_depts，停止寫入以免資料錯位';
  if (st === 'nosheet' || typeof clkEnsureStaffExtra_ !== 'function') return '分頁「staff」還沒有兼任部門欄，請先執行 setupStaff';
  try { clkEnsureStaffExtra_(SpreadsheetApp.getActive()); } catch (e) { return '分頁初始化失敗：' + (e && e.message ? e.message : e); }
  return stfExtraColState_() === 'ok' ? null : '分頁「staff」兼任部門欄補欄失敗';
}

/** 只寫那一格（不整列覆寫） */
function stfWriteExtraCell_(row, codes) {
  var r = stfSheet_(STF_SHEET).getRange(row, STF_EXTRA_DEPTS_COL_NO, 1, 1);
  r.setNumberFormat('@');
  r.setValue(codes.join(','));
}

/** 主要部門有變動（核准、後台改）→ 新的主要部門自動從兼任裡移除（規格 11 第 11 條） */
function stfPruneExtraDept_(row, empNo, newDept, newUnit) {
  var dropCk = newUnit === STF_EXTRA_CK;
  if ((!newDept && !dropCk) || stfExtraColState_() !== 'ok') return;
  var cur = stfSplitCodes_(stfReadExtraMap_()[stfNormEmp_(empNo)]);
  var next = cur.filter(function (c) { return !(newDept && c === newDept) && !(dropCk && c === STF_EXTRA_CK); });
  if (next.length === cur.length) return;
  stfWriteExtraCell_(row, next);
}

/** stfPruneExtraDept_ 的純計算版（不寫表）：主要部門／單位改成 newDept／newUnit 後，兼任代碼剩哪些 */
function stfExtraAfterPrune_(cur, newDept, newUnit) {
  var dropCk = newUnit === STF_EXTRA_CK;
  return cur.filter(function (c) { return !(newDept && c === newDept) && !(dropCk && c === STF_EXTRA_CK); });
}

/** 第二期：這位操作者是不是系統管理者（role admin；人資 platform.staff 不算） */
function stfActorIsAdmin_(user) { return !!user && String(user.role) === 'admin'; }
/** 第二期：目標列是不是操作者本人 */
function stfTargetIsSelf_(v, user) { return !!user && stfStr_(v[STF_COL.user_id]) === String(user.id); }
function stfSelfOrgErr_() {
  return { ok: false, error: typeof PERM_MSG_SELF_ORG === 'string' ? PERM_MSG_SELF_ORG : '不能修改自己的單位、部門或職稱', code: 'self_org_edit' };
}

// ============================================================
// 3. staff 列讀取
// ============================================================

function stfAllRows_() {
  return stfReadRows_(STF_SHEET, STF_COL_COUNT).map(function (v, i) { return { row: i + 2, values: v }; });
}
function stfFindByEmp_(empNo) {
  var target = stfNormEmp_(empNo);
  var rows = stfAllRows_();
  for (var i = 0; i < rows.length; i++) if (stfNormEmp_(rows[i].values[STF_COL.emp_no]) === target) return rows[i];
  return null;
}
function stfFindByUserId_(uid) {
  var rows = stfAllRows_();
  for (var i = 0; i < rows.length; i++) if (stfStr_(rows[i].values[STF_COL.user_id]) === String(uid)) return rows[i];
  return null;
}

/** staff 列 → 物件。includePrivate=false 時不含生日／地址；reset_* 欄永不外流 */
function stfToObj_(values, org, includePrivate) {
  var nm = function (kind, code) { return code && org[kind][code] ? org[kind][code].name : ''; };
  var o = {
    emp_no: stfStr_(values[STF_COL.emp_no]),
    name: stfStr_(values[STF_COL.name]),
    status: stfStr_(values[STF_COL.status]),
    phone: stfPhone_(values[STF_COL.phone])
  };
  STF_ORG_FIELDS.forEach(function (f) {
    o[f] = stfStr_(values[STF_COL[f]]);
    o[f + '_name'] = nm(f, o[f]);
    o['p_' + f] = stfStr_(values[STF_COL['p_' + f]]);
    o['p_' + f + '_name'] = nm(f, o['p_' + f]);
  });
  o.has_pending_change = STF_ORG_FIELDS.some(function (f) { return o['p_' + f] !== ''; });
  if (includePrivate) {
    o.birthday = stfDate_(values[STF_COL.birthday]);
    o.address = stfStr_(values[STF_COL.address]);
    o.reject_reason = stfStr_(values[STF_COL.reject_reason]);
    o.claimed_at = stfStr_(values[STF_COL.claimed_at]);
    o.confirmed_at = stfStr_(values[STF_COL.confirmed_at]);
    o.reset_locked = String(values[STF_COL.reset_locked]).toUpperCase() === 'TRUE' ||
      (Number(values[STF_COL.reset_lock_until]) || 0) > stfNowSec_();
  }
  return o;
}

// ============================================================
// 4. 登入前限流（§6.1）
// ============================================================

function stfCacheIncr_(key, ttl) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), ttl);
  return n;
}
function stfCacheGet_(key) { return Number(CacheService.getScriptCache().get(key) || 0); }

/**
 * 全域保險上限：只防腳本洪水。超過回 true（要擋）。
 * 三支各自一桶（有人刷 claimLookup 不會連忘記密碼一起癱瘓），用固定 10 分鐘窗（key 帶窗號，
 * 不會因為每次 put 重設 TTL 而把視窗無限延長），被擋的請求不再計數（Fable 上線前審第 4 條）。
 */
function stfGlobalFlood_(bucket) {
  var win = Math.floor(stfNowSec_() / STF_GLOBAL_WINDOW);
  var key = 'stf_g_' + bucket + '_' + win;
  if (stfCacheGet_(key) >= STF_GLOBAL_LIMIT) return true;
  stfCacheIncr_(key, STF_GLOBAL_WINDOW + 60);
  return false;
}

// ============================================================
// 5. 第一次使用（§6.1）
// ============================================================

function stfUnclaimedByName_(name) {
  return stfAllRows_().filter(function (r) {
    return stfStr_(r.values[STF_COL.name]) === name && stfStr_(r.values[STF_COL.status]) === 'unclaimed';
  });
}

function handleClaimLookup_(payload) {
  // 先擋格式不對的（不計入全域額度，GPT 第 9 條：空請求不該耗掉大家的額度）
  if (stfTooLong_(payload && payload.name, STF_MAX.name)) return { ok: false, error: '請輸入全名' };
  var name = stfStr_(payload && payload.name);
  if (!name || name.length > STF_MAX.name) return { ok: false, error: '請輸入全名' };
  if (stfGlobalFlood_('lookup')) return { ok: false, error: STF_MSG.TOO_MANY };
  var missKey = 'stf_miss_' + name;
  if (stfCacheGet_(missKey) >= STF_NAME_MISS_LIMIT) return { ok: false, error: STF_MSG.TOO_MANY };

  var hits = stfUnclaimedByName_(name);
  if (hits.length > 1) return { ok: false, error: STF_MSG.NAME_AMBIGUOUS };
  if (hits.length === 1) return { ok: true, data: { emp_no: stfStr_(hits[0].values[STF_COL.emp_no]) } };

  var byName = stfAllRows_().filter(function (r) { return stfStr_(r.values[STF_COL.name]) === name; });
  if (byName.length) {
    var allPending = byName.every(function (r) { return stfStr_(r.values[STF_COL.status]) === 'pending'; });
    return { ok: false, error: allPending ? STF_MSG.CLAIM_PENDING : STF_MSG.ALREADY_CLAIMED };
  }
  stfCacheIncr_(missKey, STF_NAME_MISS_WINDOW);
  return { ok: false, error: STF_MSG.NOT_IN_ROSTER };
}

/** 個資＋組織欄驗證（claimSubmit 與 saveMyProfile 共用）。回 {error} 或 {clean} */
function stfCleanProfile_(payload, org, needPrivate) {
  var v = {
    brand: stfStr_(payload.brand), unit: stfStr_(payload.unit), dept: stfStr_(payload.dept), title: stfStr_(payload.title),
    phone: stfPhone_(payload.phone), address: stfStr_(payload.address), birthday: stfStr_(payload.birthday)
  };
  var err = stfValidateOrg_(org, v) || stfValidatePhone_(v.phone) || stfValidateAddress_(v.address);
  if (!err && needPrivate) err = stfValidateBirthday_(v.birthday);
  return err ? { error: err } : { clean: v };
}

function handleClaimSubmit_(payload) {
  payload = payload || {};
  // 長度先擋（2026-10-12）：在碰全域額度 cache、讀名單之前
  if (stfTooLong_(payload.name, STF_MAX.name) || stfTooLong_(payload.emp_no, STF_MAX.emp_no)) {
    return { ok: false, error: STF_MSG.CLAIM_MISMATCH };
  }
  if (stfTooLong_(payload.password, STF_MAX.password)) return { ok: false, error: STF_MSG.PW_TOO_LONG };
  if (stfTooLong_(payload.phone, STF_MAX.phone)) return { ok: false, error: '手機要是 09 開頭的 10 碼數字' };
  if (stfTooLong_(payload.birthday, STF_MAX.birthday)) return { ok: false, error: '生日格式要是 YYYY-MM-DD' };
  if (stfTooLong_(payload.address, STF_MAX.address)) return { ok: false, error: '居住地址請填 5～100 個字' };
  if (STF_ORG_FIELDS.some(function (f) { return stfTooLong_(payload[f], STF_MAX.org); })) {
    return { ok: false, error: '請選擇品牌' };
  }
  var name = stfStr_(payload.name);
  var empNo = stfNormEmp_(payload.emp_no);
  if (!name || !STF_EMP_RE.test(empNo)) return { ok: false, error: STF_MSG.CLAIM_MISMATCH };
  if (stfGlobalFlood_('submit')) return { ok: false, error: STF_MSG.TOO_MANY };
  var password = payload.password === undefined || payload.password === null ? '' : String(payload.password);

  var hits = stfUnclaimedByName_(name);
  if (hits.length !== 1 || stfNormEmp_(hits[0].values[STF_COL.emp_no]) !== empNo) {
    return { ok: false, error: STF_MSG.CLAIM_MISMATCH };
  }
  var pwErr = stfValidatePassword_(password, empNo);
  if (pwErr) return { ok: false, error: pwErr };
  var org = stfReadOrg_();
  var res = stfCleanProfile_(payload, org, true);
  if (res.error) return { ok: false, error: res.error };
  var c = res.clean;

  var hit = hits[0];
  var userRow = findUsrRowById_(stfStr_(hit.values[STF_COL.user_id]));
  if (!userRow) return { ok: false, error: STF_MSG.NOT_FOUND };

  // 寫入順序：先 staff 再 users 密碼（Fable 上線前審第 7 條）。中途失敗時最多留下「staff 已 pending、
  // 還沒有密碼」——登不進去也不能再認領，後台「撤回認領」即可復原；反過來會留下能登入的半套帳號。
  // staff：組織四欄寫 p_*，個資寫正式欄
  var v = hit.values.slice();
  var now = stfNowText_();
  v[STF_COL.status] = 'pending';
  STF_ORG_FIELDS.forEach(function (f) { v[STF_COL['p_' + f]] = c[f]; });
  v[STF_COL.birthday] = c.birthday;
  v[STF_COL.phone] = c.phone;
  v[STF_COL.address] = c.address;
  v[STF_COL.reject_reason] = '';
  v[STF_COL.claimed_at] = now;
  v[STF_COL.updated_at] = now;
  stfWriteRow_(STF_SHEET, hit.row, v, STF_COL_COUNT);
  // users：設密碼（active 維持 TRUE）
  var salt = Utilities.getUuid();
  stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.salt + 1, 1, 2).setValues([[salt, hashPassword_(password, salt)]]);
  stfLog_(empNo, 'claim', 'self', '');

  // 2026-10-12 Eason：認領只是核對編號，送出後要等單位主管審核通過才開通——不回 token、不自動登入。
  // 回傳同時放頂層 pending 與 data.pending（平台 spec §4.8 形狀是 {ok,data}）
  return { ok: true, pending: true, data: { pending: true, emp_no: empNo } };
}

// ============================================================
// 6. 忘記密碼（§6.6）
// ============================================================

function handleForgotReset_(payload) {
  payload = payload || {};
  // 長度先擋（2026-10-12）：在碰全域額度 cache、讀名單之前
  if (stfTooLong_(payload.emp_no, STF_MAX.emp_no) || stfTooLong_(payload.birthday, STF_MAX.birthday) ||
      stfTooLong_(payload.phone, STF_MAX.phone)) {
    return { ok: false, error: STF_MSG.RESET_MISMATCH };
  }
  if (stfTooLong_(payload.new_password, STF_MAX.password)) return { ok: false, error: STF_MSG.PW_TOO_LONG };
  var empNo = stfNormEmp_(payload.emp_no);
  // 編號格式不對、生日手機不像樣的請求直接回「資料不符」，不計入全域額度（GPT 第 9 條）
  if (!STF_EMP_RE.test(empNo) || !/^\d{4}-\d{2}-\d{2}$/.test(stfStr_(payload.birthday)) ||
      !/^09[0-9]{8}$/.test(stfPhone_(payload.phone))) {
    return { ok: false, error: STF_MSG.RESET_MISMATCH };
  }
  // 新密碼規則先驗：它只看呼叫者自己的輸入，不洩漏任何資料。放在比對之後的話，
  // 「生日手機對了、密碼故意亂打」會回不同訊息又不留紀錄，變成無聲確認個資的探測器（Fable 上線前審第 2 條）
  var newPwFirst = payload.new_password === undefined || payload.new_password === null ? '' : String(payload.new_password);
  var pwErrFirst = stfValidatePassword_(newPwFirst, empNo);
  if (pwErrFirst) return { ok: false, error: pwErrFirst };
  if (stfGlobalFlood_('forgot')) return { ok: false, error: STF_MSG.TOO_MANY };
  var hit = STF_EMP_RE.test(empNo) ? stfFindByEmp_(empNo) : null;
  var status = hit ? stfStr_(hit.values[STF_COL.status]) : '';
  if (!hit || status === 'unclaimed' || status === 'disabled') return { ok: false, error: STF_MSG.RESET_MISMATCH };

  var v = hit.values.slice();
  var now = stfNowSec_();
  var lockedFlag = String(v[STF_COL.reset_locked]).toUpperCase() === 'TRUE';
  var lockUntil = Number(v[STF_COL.reset_lock_until]) || 0;
  if (lockedFlag && lockUntil > now) return { ok: false, error: STF_MSG.RESET_LOCKED };
  if (lockedFlag) {
    // 24 小時鎖自動到期（Fable 第 3 條＋GPT 第 6 條：純匿名失敗不能把人永久鎖死）
    v[STF_COL.reset_locked] = '';
    v[STF_COL.reset_lock_count] = 0;
  } else if (lockUntil > now) {
    return { ok: false, error: STF_MSG.RESET_TIMELOCK };
  }

  var newPw = payload.new_password === undefined || payload.new_password === null ? '' : String(payload.new_password);
  var match = stfDate_(v[STF_COL.birthday]) === stfStr_(payload.birthday) &&
    stfPhone_(v[STF_COL.phone]) === stfPhone_(payload.phone) && stfDate_(v[STF_COL.birthday]) !== '';

  if (!match) {
    var fails = (Number(v[STF_COL.reset_fail]) || 0) + 1;
    stfLog_(empNo, 'reset_fail', 'self', '');
    if (fails >= STF_RESET_FAIL_LIMIT) {
      // 24 小時視窗：上次時間鎖到期超過 24 小時就重新起算
      var lastUntil = Number(v[STF_COL.reset_lock_until]) || 0;
      var count = (lastUntil && now - lastUntil < 24 * 3600) ? (Number(v[STF_COL.reset_lock_count]) || 0) : 0;
      count += 1;
      v[STF_COL.reset_fail] = 0;
      v[STF_COL.reset_lock_until] = now + STF_RESET_TIMELOCK_SECONDS;
      v[STF_COL.reset_lock_count] = count;
      if (count >= STF_RESET_TIMELOCK_MAX_PER_DAY) {
        v[STF_COL.reset_locked] = 'TRUE';
        v[STF_COL.reset_lock_until] = now + 24 * 3600;
        stfLog_(empNo, 'reset_locked', 'self', '');
      } else {
        stfLog_(empNo, 'reset_timelock', 'self', '');
      }
    } else {
      v[STF_COL.reset_fail] = fails;
    }
    stfWriteRow_(STF_SHEET, hit.row, v, STF_COL_COUNT);
    return { ok: false, error: STF_MSG.RESET_MISMATCH };
  }

  var userRow = findUsrRowById_(stfStr_(v[STF_COL.user_id]));
  if (!userRow) return { ok: false, error: STF_MSG.RESET_MISMATCH };
  var salt = Utilities.getUuid();
  stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.salt + 1, 1, 2).setValues([[salt, hashPassword_(newPw, salt)]]);
  setTokenAfter_(userRow.row);
  clearLoginState_(empNo);

  v[STF_COL.reset_fail] = 0;
  v[STF_COL.reset_lock_until] = '';
  v[STF_COL.reset_lock_count] = 0;
  v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, hit.row, v, STF_COL_COUNT);
  stfLog_(empNo, 'reset_ok', 'self', '');
  writeLoginLog_(empNo, '', AUTH_LOG_OK);
  return { ok: true, data: {} };
}

// ============================================================
// 7. 同仁本人（§6.2／§6.4）
// ============================================================

function stfRequire_(token, perm) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  if (!hasPerm_(me.data.perms, perm)) return { ok: false, error: STF_MSG.NO_PERM };
  return { ok: true, user: me.data.user, perms: me.data.perms };
}

function stfMyProfileData_(hit, org) {
  var o = stfToObj_(hit.values, org, true);
  delete o.reset_locked; // reset_* 不給本人（§6.2）
  stfDecorate_(o, stfReadExtraMap_(), org, false);   // 兼任部門唯讀顯示（T2）
  return o;
}

function handleMyProfile_(token) {
  var auth = stfRequire_(token, 'platform.self');
  if (!auth.ok) return auth;
  var hit = stfFindByUserId_(auth.user.id);
  if (!hit) return { ok: true, data: { none: true } };
  return { ok: true, data: stfMyProfileData_(hit, stfReadOrg_()) };
}

function handleSaveMyProfile_(token, payload) {
  var auth = stfRequire_(token, 'platform.self');
  if (!auth.ok) return auth;
  var hit = stfFindByUserId_(auth.user.id); // 身分只認 token，payload 夾帶的 emp_no／user_id 一律忽略
  if (!hit) return { ok: false, error: STF_MSG.NOT_FOUND };
  var status = stfStr_(hit.values[STF_COL.status]);
  if (['pending', 'rejected', 'active'].indexOf(status) === -1) return { ok: false, error: STF_MSG.BAD_STATE };

  var org = stfReadOrg_();
  var res = stfCleanProfile_(payload || {}, org, false);
  if (res.error) return { ok: false, error: res.error };
  var c = res.clean;
  var v = hit.values.slice();
  var changed = [];

  // 改手機（忘記密碼的驗證欄）要帶目前密碼（2026-10-12）：否則偷到 token 的人可以先改手機、
  // 再走忘記密碼把帳號整個搶走。驗錯與 changePassword 共用同一組計數（usrVerifySelfPassword_）。
  // 生日本人不能改（只有後台 staffEdit 可改），所以這裡只看手機。
  if (stfPhone_(v[STF_COL.phone]) !== c.phone) {
    var pw = payload && payload.current_password;
    if (typeof pw !== 'string' || !pw) return { ok: false, error: STF_MSG.NEED_CURRENT_PW };
    if (pw.length > STF_MAX.password) return { ok: false, error: USR_MSG_OLD_PASSWORD_WRONG };
    var me = findUsrRowById_(auth.user.id);
    if (!me) return { ok: false, error: STF_MSG.NOT_FOUND };
    var verified = usrVerifySelfPassword_(auth.user.id, pw, me.values);
    if (!verified.ok) return verified;
  }

  if (status === 'active') {
    var differs = STF_ORG_FIELDS.some(function (f) { return stfStr_(v[STF_COL[f]]) !== c[f]; });
    STF_ORG_FIELDS.forEach(function (f) { v[STF_COL['p_' + f]] = differs ? c[f] : ''; });
    if (differs) changed.push('org');
  } else {
    STF_ORG_FIELDS.forEach(function (f) { v[STF_COL['p_' + f]] = c[f]; });
    changed.push('org');
  }
  if (stfPhone_(v[STF_COL.phone]) !== c.phone) changed.push('phone');
  if (stfStr_(v[STF_COL.address]) !== c.address) changed.push('address');
  v[STF_COL.phone] = c.phone;
  v[STF_COL.address] = c.address;
  var empNo = stfStr_(v[STF_COL.emp_no]);
  if (status === 'rejected') {
    v[STF_COL.status] = 'pending';
    v[STF_COL.reject_reason] = '';
  }
  v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, hit.row, v, STF_COL_COUNT);
  stfLog_(empNo, status === 'rejected' ? 'resubmit' : 'profile_edit', empNo, '改了：' + changed.join(','));
  return { ok: true, data: stfMyProfileData_({ values: v }, org) };
}

function handleMyUnit_(token) {
  var auth = stfRequire_(token, 'platform.self');
  if (!auth.ok) return auth;
  var hit = stfFindByUserId_(auth.user.id);
  var org = stfReadOrg_();
  var scope = hit ? stfManagerScope_(hit.values, org) : null;
  if (!scope) return { ok: false, error: STF_MSG.UNIT_ONLY_MANAGER };
  // 生日、地址（Eason 2026-10-25）：只給門市與央廚（store 階梯）的單位主管；品牌辦公室、總部照舊不給。
  // 審查（兩位 Fable）：單位要存在且啟用、職稱要啟用且是門市職稱才給——stfManagerScope_ 本身只比職級，
  // 通訊錄與打卡共用，不在這裡收緊它（舊行為照舊），只收緊這兩欄。
  var myUnit = org.unit[scope.unit];
  var myTitle = org.title[stfStr_(hit.values[STF_COL.title])];
  var priv = scope.ladder === 'store' && !!myUnit && myUnit.active !== false && (myUnit.ladder || 'store') === 'store' &&
    !!myTitle && myTitle.active !== false && myTitle.parent === 'store';
  var people = stfAllRows_().map(function (r) { return stfToObj_(r.values, org, priv); }).filter(function (p) {
    return p.status === 'active' && p.unit === scope.unit && (!scope.sameDept || p.dept === scope.dept);
  }).map(function (p) {
    var o = { emp_no: p.emp_no, name: p.name, title: p.title, title_name: p.title_name, phone: p.phone };
    if (priv) { o.birthday = p.birthday; o.address = p.address; }
    return o;
  });
  return { ok: true, data: { unit_name: scope.unit_name, private: priv, people: people } };
}

/**
 * 單位主管的範圍（§6.4 單位通訊錄與 §6.8 認領審核共用同一套判斷）：
 * status＝active、職級達門檻（store rank≥3 店長；hq rank≥2 總監）才回
 * {unit, unit_name, dept, ladder, sameDept}；總部單位且本人有部門時 sameDept＝true（只管同單位同部門）。
 * 不夠格回 null；總部單位有 active 部門但本人部門空白也回 null（不放大成全總部）。
 */
function stfManagerScope_(values, org) {
  if (stfStr_(values[STF_COL.status]) !== 'active') return null;
  var unitCode = stfStr_(values[STF_COL.unit]);
  var unit = org.unit[unitCode];
  var title = org.title[stfStr_(values[STF_COL.title])];
  var ladder = unit ? (unit.ladder || 'store') : 'store';
  if (!title || title.rank < (STF_UNIT_VIEW_MIN_RANK[ladder] || 99)) return null;
  // 單位限定職稱（第 15 節）：例如切換後還掛在中央工廠的店長 → 沒有主管範圍（要改成廠長）
  if (!stfTitleUnitOk_(org.unitRules, title.code, unitCode)) return null;
  var dept = stfStr_(values[STF_COL.dept]);
  // GPT 複審第 4 條（2026-10-12）：總部單位底下有 active 部門、本人部門卻空白 → 不具資格（往拒絕方向）。
  // 否則 sameDept＝false 會讓他看得到／審得到整個總部所有部門（通訊錄 myUnit 與認領審核共用這裡）。
  if (ladder === 'hq' && dept === '' && stfActiveDeptsOf_(org, unitCode).length) return null;
  return { unit: unitCode, unit_name: unit ? unit.name : '', dept: dept, ladder: ladder, sameDept: ladder === 'hq' && dept !== '' };
}

// ============================================================
// 7b. 認領後主管審核（§6.8，Eason 2026-10-12）
// ============================================================

/**
 * 登入／驗 token 時的同仁閘門（Auth.gs handleLogin_／handleMe_ 呼叫，只對 role＝staff）：
 * - status pending（認領送出、還沒審核）→ {block: '帳號還在等主管審核'}
 * - status rejected（舊流程被退回、從沒開通過）→ {block: 退回訊息}
 *   ※「已開通、改了組織欄待確認」是 status active＋p_* 有值，不是 pending，照常登入
 * - 其他 → {review: 是否具單位主管審核資格}（有資格時 Auth.gs 會加一個衍生權限 platform.review，
 *   只用來讓「我的資料 → 待審核」分頁出現；後端每支審核 action 仍會重算資格，不信任這個權限）
 * 沒有 staff 分頁或找不到列 → {}（照舊放行，系統帳號不受影響）
 */
function stfLoginGate_(userId) {
  if (!stfSheet_(STF_SHEET)) return {};
  var hit = stfFindByUserId_(userId);
  if (!hit) return {};
  var status = stfStr_(hit.values[STF_COL.status]);
  if (status === 'pending') return { block: STF_MSG.LOGIN_PENDING };
  if (status === 'rejected') return { block: STF_MSG.LOGIN_REJECTED };
  // 衍生權限 platform.review 的「審核者資格」部分：改用新規則（stfReviewScope_）。人資／admin 由 Auth.gs 另外補
  // bulletin＝公告管理權限（BULLETIN_ADMINS 有勾、且在職）→ Auth.gs 補 platform.bulletin
  var bulletin = status === 'active' && stfBulletinAdmins_().indexOf(stfNormEmp_(hit.values[STF_COL.emp_no])) !== -1;
  // att＝衍生權限 platform.att（StoreOps.gs storeAttGate_；Auth.gs authPermsWithGate_ 補上）
  var att = typeof storeAttGate_ === 'function' ? storeAttGate_(hit.values) : false;
  // storeops＝衍生權限 platform.storeops（StoreOps.gs storeOpsGate_；STORE_SSO_UNITS 空＝全關）
  var org = stfReadOrg_();
  var storeops = typeof storeOpsGate_ === 'function' ? storeOpsGate_(hit.values, org) : false;
  return { review: !!stfReviewScope_(hit.values, org), bulletin: bulletin, att: att, storeops: storeops };
}

/**
 * 審核者範圍（規格第 13 節；組織改版 T3）。回 null＝沒有審核資格；否則
 * {kinds, unit, unit_name, brand, dept, rank, titleLadder}。kinds 可能值：
 *   'store' 同店店長（門市 sm）　　'brand' 品牌辦公室區經理以上（rank≥2，帶 brand）
 *   'ops' 營運部主管（dzy-hq、主要部門 ops、總監）　'dept' 總監（帶 dept）
 *   'exec' 執行長以上（dzy-hq、hq 職級≥3）　　'ck' 中央工廠主管（單位 ck、rank≥3：廠長 fm、廚藝總監 rdd）
 *   門市 rank≥3（店長 sm、區經理 am，第 15 節）都是 'store'；能審誰再由 stfScopeMeets_ 的「同階梯職級要更高」決定。
 * 審核者本人必須 status active、單位 active、職稱 active 且屬於該單位的職稱階梯；未知 ladder 一律沒有資格。
 * 人資（platform.staff）與 admin 不在這裡判斷（stfReviewer_ 另外放行）。
 */
function stfReviewScope_(values, org) {
  if (stfStr_(values[STF_COL.status]) !== 'active') return null;
  var unitCode = stfStr_(values[STF_COL.unit]);
  var unit = org.unit[unitCode];
  var title = org.title[stfStr_(values[STF_COL.title])];
  if (!unit || !unit.active || !title || !title.active) return null;
  var ladder = unit.ladder || 'store';
  if (!stfTitleFitsUnit_(org, title.code, unitCode)) return null;
  var dept = stfStr_(values[STF_COL.dept]);
  var kinds = [];
  if (ladder === 'store') {
    if (title.rank >= (STF_UNIT_VIEW_MIN_RANK.store || 99)) kinds.push(unitCode === 'ck' ? 'ck' : 'store');
  } else if (ladder === 'office') {
    if (title.rank >= (STF_UNIT_VIEW_MIN_RANK.office || 99)) kinds.push('brand');
  } else if (ladder === 'hq') {
    if (unitCode === 'dzy-hq' && title.rank >= 3) {
      kinds.push('exec');
    } else if (title.rank === 2) {
      var d = org.dept[dept];
      // 管理部（第 14 節）不產生總監審核資格：只有執行長以上審管理部同仁
      if (d && d.active && d.parent === unitCode && dept !== STF_MGMT_DEPT) {
        kinds.push('dept');
        if (unitCode === 'dzy-hq' && dept === 'ops') kinds.push('ops');
      }
    }
  }
  if (!kinds.length) return null;
  return { kinds: kinds, unit: unitCode, unit_name: unit.name, brand: unit.parent, dept: dept, rank: title.rank, titleLadder: title.parent };
}

/** 被審的一個身分（單位、部門、職稱）需要哪一種審核者；回 null＝資料已不合規或沒有上一層 → 只有人資 */
/**
 * need＝{title, kind, unit?, brand?, dept?, alt?}；alt＝其他也可以的審核者種類（[{kind, unit?, brand?, dept?}]，任一符合即可；
 * 「同階梯職級要更高」對每一種都適用）。第 15 節（Eason 2026-10-20）：
 *   門市店長 sm → 該品牌辦公室，或同店職級更高的人（區經理 am）；門市區經理 am（rank 4）→ 該品牌辦公室
 *   中央工廠廠長 fm（rank 3；切換前的央廚店長同此）→ 中央工廠職級更高的人（廚藝總監 rdd）或執行長以上
 *   中央工廠廚藝總監 rdd（rank 4）→ 執行長以上
 */
function stfReviewNeed_(org, unitCode, dept, titleCode) {
  var u = org.unit[unitCode];
  var t = org.title[titleCode];
  if (!u || !u.active || !t || !t.active) return null;
  var ladder = u.ladder || 'store';
  if (!stfTitleFitsUnit_(org, titleCode, unitCode)) return null;
  var need = { title: t };
  if (ladder === 'office') { need.kind = 'ops'; return need; }
  if (ladder === 'store') {
    if (unitCode === 'ck') {
      need.unit = 'ck';
      if (t.rank >= 4) { need.kind = 'exec'; return need; }
      need.kind = 'ck';
      if (t.rank === 3) need.alt = [{ kind: 'exec' }];
      return need;
    }
    if (t.rank >= 3) {
      need.kind = 'brand'; need.brand = u.parent;
      if (t.rank === 3) need.alt = [{ kind: 'store', unit: unitCode }];
      return need;
    }
    need.kind = 'store'; need.unit = unitCode; return need;
  }
  if (ladder === 'hq') {
    if (t.rank >= 3) return null;                    // 執行長以上：只有人資
    if (t.rank === 2) { need.kind = 'exec'; return need; }   // 總監：執行長以上
    var d = org.dept[dept];
    if (!d || !d.active || d.parent !== unitCode) return null;
    if (dept === STF_MGMT_DEPT) { need.kind = 'exec'; return need; }   // 管理部同仁：執行長以上（不設總監）
    need.kind = 'dept'; need.dept = dept; return need;       // 部門同仁：同主要部門的總監
  }
  return null;
}

function stfScopeMeets_(scope, need) {
  if (!scope || !need) return false;
  // 同一個職稱階梯才比職級：被審的人職級跟審核者同級或更高 → 擋（不同階梯不比；第二期起職稱＝權限，不能核准同級或更高）
  if (scope.titleLadder === need.title.parent && scope.rank <= need.title.rank) return false;
  return [need].concat(need.alt || []).some(function (o) { return stfScopeMeetsKind_(scope, o); });
}
function stfScopeMeetsKind_(scope, o) {
  if (scope.kinds.indexOf(o.kind) === -1) return false;
  if ((o.kind === 'store' || o.kind === 'ck') && scope.unit !== o.unit) return false;
  if (o.kind === 'brand' && scope.brand !== o.brand) return false;
  if (o.kind === 'dept' && scope.dept !== o.dept) return false;
  return true;
}

/**
 * 這位審核者（scope）能不能審這一列待審（不含「自己」與 status 判斷）。
 * 被審的人看「送出的」p_unit／p_dept／p_title；若列上已有「目前身分」（unit 有值，例如店長建檔後退回認領保留的組織欄），
 * 兩個身分都要夠格才算（取嚴者）。首次認領沒有目前身分＝只看送出的。
 */
function stfCanReview_(scope, values, org) {
  if (!scope) return false;
  var submitted = stfReviewNeed_(org, stfStr_(values[STF_COL.p_unit]), stfStr_(values[STF_COL.p_dept]), stfStr_(values[STF_COL.p_title]));
  if (!stfScopeMeets_(scope, submitted)) return false;
  if (stfStr_(values[STF_COL.unit]) !== '') {
    var current = stfReviewNeed_(org, stfStr_(values[STF_COL.unit]), stfStr_(values[STF_COL.dept]), stfStr_(values[STF_COL.title]));
    if (!stfScopeMeets_(scope, current)) return false;
  }
  return true;
}

/** 審核者：platform.staff（人資／admin）一律可審；否則要有審核者範圍（stfReviewScope_） */
function stfReviewer_(token) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  var org = stfReadOrg_();
  var isHr = hasPerm_(me.data.perms, 'platform.staff');
  var scope = null;
  if (hasPerm_(me.data.perms, 'platform.self')) {
    var hit = stfFindByUserId_(me.data.user.id);
    if (hit) scope = stfReviewScope_(hit.values, org);
  }
  if (!isHr && !scope) return { ok: false, error: STF_MSG.NOT_REVIEWER };
  return { ok: true, user: me.data.user, isHr: isHr, scope: scope, org: org };
}

/** 這一列是不是「這位審核者可以審的認領待審」（不能審自己；人資全可審；其他看 stfCanReview_） */
function stfCanReviewRow_(rv, values) {
  if (stfStr_(values[STF_COL.status]) !== 'pending') return false;
  if (stfStr_(values[STF_COL.user_id]) === String(rv.user.id)) return false;
  if (rv.isHr) return true;
  return stfCanReview_(rv.scope, values, rv.org);
}

function handleUnitPending_(token) {
  var rv = stfReviewer_(token);
  if (!rv.ok) return rv;
  var people = stfAllRows_().filter(function (r) { return stfCanReviewRow_(rv, r.values); }).map(function (r) {
    var o = stfToObj_(r.values, rv.org, true);
    // 主管要核對本人：填的單位／部門／職稱、生日、手機、地址都給
    return {
      emp_no: o.emp_no, name: o.name,
      brand: o.p_brand, brand_name: o.p_brand_name, unit: o.p_unit, unit_name: o.p_unit_name,
      dept: o.p_dept, dept_name: o.p_dept_name, title: o.p_title, title_name: o.p_title_name,
      birthday: o.birthday, phone: o.phone, address: o.address, claimed_at: o.claimed_at
    };
  });
  return { ok: true, data: { people: people, scope_name: rv.scope ? rv.scope.unit_name : '', all_units: rv.isHr } };
}

/** 審核單筆共用：資格、找列、不能審自己、狀態要是認領待審、範圍要對 */
function stfReviewTarget_(token, payload) {
  var rv = stfReviewer_(token);
  if (!rv.ok) return rv;
  var hit = stfFindByEmp_(payload && payload.emp_no);
  if (!hit) return { ok: false, error: STF_MSG.NOT_FOUND };
  if (stfStr_(hit.values[STF_COL.user_id]) === String(rv.user.id)) return { ok: false, error: STF_MSG.REVIEW_SELF };
  if (stfStr_(hit.values[STF_COL.status]) !== 'pending') return { ok: false, error: STF_MSG.NOT_PENDING_REVIEW };
  if (!stfCanReviewRow_(rv, hit.values)) return { ok: false, error: STF_MSG.NOT_REVIEWER };
  return { ok: true, rv: rv, hit: hit, v: hit.values.slice(), emp: stfNormEmp_(hit.values[STF_COL.emp_no]) };
}

function handleUnitApprove_(token, payload) {
  var t = stfReviewTarget_(token, payload);
  if (!t.ok) return t;
  var oldUnit = stfStr_(t.v[STF_COL.unit]);
  var err = stfApplyConfirm_(t.v, t.rv.org);
  if (err) return { ok: false, error: err };
  // 第二期：非 admin 核准後對方會拿到（或失去）platform.permmap → 擋
  var exBeforeU = stfSplitCodes_(stfReadExtraMap_()[t.emp]);
  var chkU = typeof permStaffChangeCheck_ === 'function'
    ? permStaffChangeCheck_(stfActorIsAdmin_(t.rv.user), t.hit.values, exBeforeU, t.v, stfExtraAfterPrune_(exBeforeU, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit]))) : null;
  if (chkU && chkU.block) return chkU.block;
  t.v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, t.hit.row, t.v, STF_COL_COUNT);
  stfPruneExtraDept_(t.hit.row, t.emp, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit]));
  stfLog_(t.emp, 'confirm', t.rv.user.id, 'unit_review');
  if (typeof permAuditStaffChange_ === 'function') permAuditStaffChange_(t.rv.user.id, t.emp, chkU, 'confirm');
  // 調店：確認後單位換了 → 新單位有打卡就開 add 單（StaffClock.gs；沒有那支檔案時略過）
  if (typeof clkAfterConfirm_ === 'function') clkAfterConfirm_(t.emp, oldUnit, stfStr_(t.v[STF_COL.unit]), t.rv.user.id);
  return { ok: true, data: { emp_no: t.emp } };
}

function handleUnitReject_(token, payload) {
  var reason = stfStr_(payload && payload.reason);
  if (!reason) return { ok: false, error: STF_MSG.REASON_REQUIRED };
  if (reason.length > STF_REASON_MAX) return { ok: false, error: STF_MSG.REASON_TOO_LONG };
  var t = stfReviewTarget_(token, payload);
  if (!t.ok) return t;
  var err = stfRejectClaim_(t.v, reason);
  if (err) return { ok: false, error: err };
  t.v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, t.hit.row, t.v, STF_COL_COUNT);
  stfLog_(t.emp, 'reject', t.rv.user.id, 'unit_review');
  return { ok: true, data: { emp_no: t.emp } };
}

/** 確認共用（staffConfirm／unitApprove）：p_* 搬正式欄、status active。回錯誤字串或 null。只改 v，不寫表 */
function stfApplyConfirm_(v, org) {
  var p = {};
  STF_ORG_FIELDS.forEach(function (f) { p[f] = stfStr_(v[STF_COL['p_' + f]]); });
  // 確認當下再驗一次（org 可能在送出後被停用）
  var err = stfValidateOrg_(org, p);
  if (err) return '待確認的資料已經不合規則（' + err + '），請退回讓同仁重填';
  STF_ORG_FIELDS.forEach(function (f) { v[STF_COL[f]] = p[f]; v[STF_COL['p_' + f]] = ''; });
  v[STF_COL.status] = 'active';
  v[STF_COL.reject_reason] = '';
  v[STF_COL.confirmed_at] = stfNowText_();
  return null;
}

/**
 * 退回認領共用（staffReject 的 pending 分支／unitReject）：效果＝撤回認領（staffUnclaim）＋留退回原因。
 * 清密碼、撤銷所有 token、清個資與 p_*，status 回 unclaimed，名字可以重新認領；reject_reason 保留給後台看
 *（重新認領送出時清空）。只改 v 與 users 那兩格＋token_after，staff 列由呼叫端寫。回錯誤字串或 null。
 */
function stfRejectClaim_(v, reason) {
  var userRow = findUsrRowById_(stfStr_(v[STF_COL.user_id]));
  if (!userRow) return STF_MSG.NOT_FOUND;
  stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.salt + 1, 1, 2).setValues([['', '']]);
  setTokenAfter_(userRow.row);
  stfClearClaim_(v);
  v[STF_COL.reject_reason] = authSafeCell_(reason);
  return null;
}

/** 認領資料全部清掉、回 unclaimed（staffUnclaim 與退回認領共用） */
function stfClearClaim_(v) {
  // 員工名單統一：店長新增的人（有到職日或已有生效的打卡對照）單位是店長建的，退回認領時保留組織四欄（StaffClock.gs）
  var keepOrg = typeof clkKeepOrgOnClear_ === 'function' && clkKeepOrgOnClear_(v);
  (keepOrg ? [] : ['brand', 'unit', 'dept', 'title']).forEach(function (f) { v[STF_COL[f]] = ''; });
  ['p_brand', 'p_unit', 'p_dept', 'p_title', 'birthday', 'phone', 'address',
    'reject_reason', 'claimed_at', 'confirmed_at', 'reset_locked', 'reset_lock_until', 'prev_status'].forEach(function (f) {
    v[STF_COL[f]] = '';
  });
  v[STF_COL.reset_fail] = 0;
  v[STF_COL.reset_lock_count] = 0;
  v[STF_COL.status] = 'unclaimed';
  // 撤回認領＝帳號回到沒人用：公告管理權限一併收回，免得下一個認領這個名字的人接手（審查 dzy-bulletin#44-12）
  stfSetBulletinAdmin_(v[STF_COL.emp_no], false);
}

// ============================================================
// 8. 後台（§6.3）
// ============================================================

/** 現有最大編號：staff 與 users 兩邊都掃（有人在人員管理手動建過 DZY 帳號也不會撞號，Fable 上線前審第 6 條） */
function stfMaxEmpNum_() {
  var max = 0;
  var take = function (v) {
    var m = /^DZY([0-9]{3})$/.exec(stfNormEmp_(v));
    if (m && +m[1] > max) max = +m[1];
  };
  stfAllRows_().forEach(function (r) { take(r.values[STF_COL.emp_no]); });
  readUsersRawRows_().forEach(function (r) { take(r[USR_COL.username]); });
  return max;
}
function stfEmpOf_(n) { var s = String(n); while (s.length < 3) s = '0' + s; return 'DZY' + s; }

function stfSheetsReady_() {
  return !!(stfSheet_(STF_SHEET) && stfSheet_(STF_SHEET_ORG) && stfSheet_(STF_SHEET_LOG));
}

function handleStaffList_(token) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  // 讀取不建表（READONLY／MIRROR 模式下也不該寫分頁）：表還沒建回空清單；
  // 第一次「匯入」（handleStaffImport_）或手動執行 setupStaff 才會建。
  if (!stfSheetsReady_()) return { ok: true, data: { staff: [] } };
  var org = stfReadOrg_();
  var extraMap = stfReadExtraMap_();
  var list = stfAllRows_().map(function (r) { return stfDecorate_(stfToObj_(r.values, org, true), extraMap, org, true); });
  // 員工名單統一（StaffClock.gs）：多帶 hire_date／last_day／打卡對照摘要；沒有那支檔案時照舊
  if (typeof clkDecorateStaffList_ === 'function') list = clkDecorateStaffList_(list, token);
  return { ok: true, data: { staff: list } };
}

function handleStaffImport_(token, payload) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  // 分頁沒建好就先建（GPT 第 4 條：不先建會留下 users 有、staff 沒有的孤兒帳號）。
  // 匯入本身已在 Code.gs 的寫入鎖裡，這裡直接呼叫
  if (!stfSheetsReady_()) setupStaff();
  var names = Array.isArray(payload && payload.names) ? payload.names.map(stfStr_).filter(function (n) { return n; }) : [];
  if (!names.length) return { ok: false, error: STF_MSG.NAMES_REQUIRED };
  var badStart = names.filter(function (n) { return stfBadNameStart_(n); });
  if (badStart.length) return { ok: false, error: STF_MSG_NAME_START };
  var tooLong = names.filter(function (n) { return n.length > STF_MAX.name; });
  if (tooLong.length) return { ok: false, error: STF_MSG.NAME_TOO_LONG + '：' + tooLong.map(function (n) { return n.slice(0, 10) + '…'; }).join('、') };

  var seen = {};
  var dupInList = [];
  names.forEach(function (n) { if (seen[n]) dupInList.push(n); seen[n] = true; });
  if (dupInList.length) return { ok: false, error: '名單裡有重複的名字：' + dupInList.join('、') };
  var clash = names.filter(function (n) { return stfUnclaimedByName_(n).length > 0; });
  if (clash.length) return { ok: false, error: '這些名字已經在名單上、還沒認領：' + clash.join('、') };

  var start = stfMaxEmpNum_() + 1;
  if (start + names.length - 1 > 999) return { ok: false, error: STF_MSG.FULL };
  var created = names.map(function (n, i) { return { emp_no: stfEmpOf_(start + i), name: n }; });
  var taken = created.filter(function (c) { return findUsrRowByUsername_(c.emp_no); });
  if (taken.length) return { ok: false, error: '這些編號已經有帳號：' + taken.map(function (c) { return c.emp_no; }).join('、') };
  if (payload.preview === true) return { ok: true, data: { created: created, preview: true } };

  // 一次寫完（113 筆逐列寫會頂到前端 45 秒逾時）：users、staff、staff_log 各一次 setValues
  var nowText = stfNowText_();
  var firstUid = Number(String(generateNextUserId_()).slice(1));
  var usersRows = [], staffRows = [], logRows = [];
  var event = payload.single ? 'add' : 'import';
  created.forEach(function (c, i) {
    var digits = String(firstUid + i);
    while (digits.length < 3) digits = '0' + digits;
    var uid = 'u' + digits;
    var u = [];
    u[USR_COL.id] = uid; u[USR_COL.username] = c.emp_no; u[USR_COL.name] = authSafeCell_(c.name); u[USR_COL.role] = 'staff';
    u[USR_COL.node] = ''; u[USR_COL.salt] = ''; u[USR_COL.hash] = ''; u[USR_COL.active] = 'TRUE';
    u[USR_COL.created_at] = nowText; u[USR_COL.last_login_at] = '';
    usersRows.push(u);
    var row = [];
    for (var k = 0; k < STF_COL_COUNT; k++) row.push('');
    row[STF_COL.emp_no] = c.emp_no; row[STF_COL.user_id] = uid; row[STF_COL.name] = c.name;
    row[STF_COL.status] = 'unclaimed'; row[STF_COL.reset_fail] = 0; row[STF_COL.reset_lock_count] = 0;
    row[STF_COL.updated_at] = nowText;
    staffRows.push(row);
    logRows.push([nowText, c.emp_no, event, auth.user.id, '']);
  });
  stfAppendBlock_(USR_SHEET_USERS, usersRows, USR_COL_COUNT, false);
  stfAppendBlock_(STF_SHEET, staffRows, STF_COL_COUNT, true);
  stfAppendBlock_(STF_SHEET_LOG, logRows, STF_LOG_HEADERS.length, true);
  return { ok: true, data: { created: created } };
}

function handleStaffAdd_(token, payload) {
  return handleStaffImport_(token, { names: [stfStr_(payload && payload.name)], single: true, preview: !!(payload && payload.preview) });
}

/** 後台單筆動作共用：驗權限＋找列 */
function stfAdminTarget_(token, payload) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  var hit = stfFindByEmp_(payload && payload.emp_no);
  if (!hit) return { ok: false, error: STF_MSG.NOT_FOUND };
  return { ok: true, auth: auth, hit: hit, v: hit.values.slice(), status: stfStr_(hit.values[STF_COL.status]), emp: stfNormEmp_(hit.values[STF_COL.emp_no]) };
}
function stfSave_(t, event, detail) {
  t.v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, t.hit.row, t.v, STF_COL_COUNT);
  stfLog_(t.emp, event, t.auth.user.id, detail || '');
  var orgS = stfReadOrg_();
  return { ok: true, data: { staff: stfDecorate_(stfToObj_(t.v, orgS, true), stfReadExtraMap_(), orgS, true) } };
}

function handleStaffConfirm_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  var hasP = STF_ORG_FIELDS.some(function (f) { return stfStr_(t.v[STF_COL['p_' + f]]) !== ''; });
  if (!(t.status === 'pending' || (t.status === 'active' && hasP))) return { ok: false, error: STF_MSG.NO_PENDING };
  var isAdminC = stfActorIsAdmin_(t.auth.user);
  // 第二期：非 admin 不能確認自己的組織欄變更（確認＝把待確認的單位／部門／職稱搬成正式值＝自己給自己改權限）
  if (!isAdminC && stfTargetIsSelf_(t.v, t.auth.user)) return stfSelfOrgErr_();
  var oldUnit = stfStr_(t.v[STF_COL.unit]);
  var err = stfApplyConfirm_(t.v, stfReadOrg_());
  if (err) return { ok: false, error: err };
  // 第二期：非 admin 確認後對方會拿到（或失去）platform.permmap → 擋（人資主管只有系統管理者能設）
  var exBeforeC = stfSplitCodes_(stfReadExtraMap_()[t.emp]);
  var chkC = typeof permStaffChangeCheck_ === 'function'
    ? permStaffChangeCheck_(isAdminC, t.hit.values, exBeforeC, t.v, stfExtraAfterPrune_(exBeforeC, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit]))) : null;
  if (chkC && chkC.block) return chkC.block;
  var saved = stfSave_(t, 'confirm', '');
  stfPruneExtraDept_(t.hit.row, t.emp, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit]));
  if (typeof permAuditStaffChange_ === 'function') permAuditStaffChange_(t.auth.user.id, t.emp, chkC, 'confirm');
  if (typeof clkAfterConfirm_ === 'function') clkAfterConfirm_(t.emp, oldUnit, stfStr_(t.v[STF_COL.unit]), t.auth.user.id);
  return saved;
}

function handleStaffReject_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  var reason = stfStr_(payload && payload.reason);
  if (!reason) return { ok: false, error: STF_MSG.REASON_REQUIRED };
  if (reason.length > STF_REASON_MAX) return { ok: false, error: STF_MSG.REASON_TOO_LONG };
  var hasP = STF_ORG_FIELDS.some(function (f) { return stfStr_(t.v[STF_COL['p_' + f]]) !== ''; });
  if (t.status === 'pending') {
    // 2026-10-12：認領待審被退回＝撤回認領＋留原因（同 unitReject），同仁重新認領即可；
    // 不再停在 rejected（rejected 登不進去，也不能再認領，會卡死）
    var rjErr = stfRejectClaim_(t.v, reason);
    if (rjErr) return { ok: false, error: rjErr };
    return stfSave_(t, 'reject', '');
  } else if (t.status === 'active' && hasP) {
    STF_ORG_FIELDS.forEach(function (f) { t.v[STF_COL['p_' + f]] = ''; });
  } else {
    return { ok: false, error: STF_MSG.NO_PENDING };
  }
  t.v[STF_COL.reject_reason] = authSafeCell_(reason);
  return stfSave_(t, 'reject', '');
}

function handleStaffSetActive_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  if (typeof (payload && payload.active) !== 'boolean') return { ok: false, error: 'active 格式錯誤' };
  // 2026-10-17 複驗：非 admin 不能停用自己的 staff 列（admin 照舊）
  if (payload.active === false && !stfActorIsAdmin_(t.auth.user) && stfTargetIsSelf_(t.v, t.auth.user)) return { ok: false, error: '不能停用自己' };
  var userRow = findUsrRowById_(stfStr_(t.v[STF_COL.user_id]));
  if (!userRow) return { ok: false, error: STF_MSG.NOT_FOUND };
  var usersSheet = stfSheet_(USR_SHEET_USERS);
  // 員工名單統一：登記過離職日的人用舊「啟用」會被隔天 00:10 又停用——擋下，請走復職（staffReinstate，會清離職日並恢復打卡）
  if (payload.active === true && typeof clkLeaveBlocksEnable_ === 'function') {
    var blocked = clkLeaveBlocksEnable_(t.emp);
    if (blocked) return { ok: false, error: blocked, code: 'use_reinstate' };
  }
  if (payload.active === false) {
    if (t.status === 'disabled') return { ok: false, error: STF_MSG.BAD_STATE };
    t.v[STF_COL.prev_status] = t.status;
    t.v[STF_COL.status] = 'disabled';
    stfSetBulletinAdmin_(t.emp, false);   // 停用收回公告管理權限（復職要重新勾；審查 #44-10）
    usersSheet.getRange(userRow.row, USR_COL.active + 1).setValue('FALSE');
    setTokenAfter_(userRow.row);
    var saved = stfSave_(t, 'disable', '');
    if (typeof permAuditDisabled_ === 'function') permAuditDisabled_(t.auth.user.id, t.v);   // 停用收回的權限留一筆異動紀錄
    // 員工名單統一：舊「停用」按鈕只停平台帳號——同時對他每個打卡對照發停用單（StaffClock.gs）
    if (typeof clkAfterDisable_ === 'function') clkAfterDisable_(t.emp, t.auth.user.id);
    return saved;
  }
  if (t.status !== 'disabled') return { ok: false, error: STF_MSG.BAD_STATE };
  var prev = stfStr_(t.v[STF_COL.prev_status]);
  t.v[STF_COL.status] = STF_STATUSES.indexOf(prev) !== -1 && prev !== 'disabled' ? prev : 'pending';
  t.v[STF_COL.prev_status] = '';
  usersSheet.getRange(userRow.row, USR_COL.active + 1).setValue('TRUE');
  var savedOn = stfSave_(t, 'enable', '');
  if (savedOn && savedOn.ok !== false && typeof permAuditEnabled_ === 'function') permAuditEnabled_(t.auth.user.id, t.v);   // 恢復的權限留一筆異動紀錄
  return savedOn;
}

function handleStaffUnclaim_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  if (['pending', 'rejected', 'active'].indexOf(t.status) === -1) return { ok: false, error: STF_MSG.BAD_STATE };
  var userRow = findUsrRowById_(stfStr_(t.v[STF_COL.user_id]));
  if (!userRow) return { ok: false, error: STF_MSG.NOT_FOUND };
  stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.salt + 1, 1, 2).setValues([['', '']]);
  setTokenAfter_(userRow.row);
  stfClearClaim_(t.v);
  return stfSave_(t, 'unclaim', '');
}

function handleStaffUnlockReset_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  t.v[STF_COL.reset_fail] = 0;
  t.v[STF_COL.reset_locked] = '';
  t.v[STF_COL.reset_lock_until] = '';
  t.v[STF_COL.reset_lock_count] = 0;
  return stfSave_(t, 'reset_unlock', '');
}

function handleStaffEdit_(token, payload) {
  // 兼任部門只有 platform.staff（人資）與 admin 能寫（以 token 目前身分判斷，規格 11 第 11 條）
  if (payload && payload.extra_depts !== undefined) {
    var meX = handleMe_(token);
    if (!meX.ok) return meX;
    if (!hasPerm_(meX.data.perms, 'platform.staff')) return { ok: false, error: STF_MSG.NO_EXTRA_PERM };
  }
  // 公告管理權限同樣只有 platform.staff（人資）與 admin 能設
  if (payload && payload.bulletin_admin !== undefined) {
    if (typeof payload.bulletin_admin !== 'boolean') return { ok: false, error: '公告管理權限格式錯誤' };
    var meB = handleMe_(token);
    if (!meB.ok) return meB;
    if (!hasPerm_(meB.data.perms, 'platform.staff')) return { ok: false, error: STF_MSG.NO_BULLETIN_PERM };
  }
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  payload = payload || {};
  var changed = [];
  var org = stfReadOrg_();
  var oldUnitForClock = stfStr_(t.v[STF_COL.unit]);
  var isAdminE = stfActorIsAdmin_(t.auth.user);
  var selfBlockE = !isAdminE && stfTargetIsSelf_(t.v, t.auth.user);

  if (payload.name !== undefined) {
    var name = stfStr_(payload.name);
    if (!name) return { ok: false, error: '姓名不得為空' };
    if (name.length > STF_MAX.name) return { ok: false, error: STF_MSG.NAME_TOO_LONG };
    if (stfBadNameStart_(name)) return { ok: false, error: STF_MSG_NAME_START };
    // 這個人會進（或已在）打卡名冊時，姓名上限 20（打卡端 svc_add 的限制），否則之後的 add 單會被永久拒絕
    if (name.length > 20 && typeof clkNameIntoClock_ === 'function' && clkNameIntoClock_(t.emp)) {
      return { ok: false, error: '姓名最多 20 個字（這位同仁在打卡系統有對照或單位有打卡）' };
    }
    var clash = stfUnclaimedByName_(name).filter(function (r) { return r.row !== t.hit.row; });
    if (clash.length) return { ok: false, error: '名單上已有同名、還沒認領的人' };
    if (name !== stfStr_(t.v[STF_COL.name])) { t.v[STF_COL.name] = name; changed.push('name'); }
  }
  if (payload.birthday !== undefined) {
    var b = stfStr_(payload.birthday);
    var be = stfValidateBirthday_(b);
    if (be) return { ok: false, error: be };
    t.v[STF_COL.birthday] = b; changed.push('birthday');
  }
  if (payload.phone !== undefined) {
    var ph = stfPhone_(payload.phone);
    var pe = stfValidatePhone_(ph);
    if (pe) return { ok: false, error: pe };
    t.v[STF_COL.phone] = ph; changed.push('phone');
  }
  if (payload.address !== undefined) {
    var a = stfStr_(payload.address);
    var ae = stfValidateAddress_(a);
    if (ae) return { ok: false, error: ae };
    t.v[STF_COL.address] = a; changed.push('address');
  }
  var orgGiven = STF_ORG_FIELDS.some(function (f) { return payload[f] !== undefined; });
  if (orgGiven) {
    var o = {};
    STF_ORG_FIELDS.forEach(function (f) { o[f] = payload[f] !== undefined ? stfStr_(payload[f]) : stfStr_(t.v[STF_COL[f]]); });
    // 第二期：非 admin 不能改自己的單位／部門／職稱（個資欄照放）；先擋、再驗證，免得驗證訊息洩漏組織細節
    if (selfBlockE && STF_ORG_FIELDS.some(function (f) { return o[f] !== stfStr_(t.v[STF_COL[f]]); })) return stfSelfOrgErr_();
    var oe = stfValidateOrg_(org, o);
    if (oe) return { ok: false, error: oe };
    STF_ORG_FIELDS.forEach(function (f) { t.v[STF_COL[f]] = o[f]; });
    changed.push('org');
  }
  var extraNew = null;
  if (payload.extra_depts !== undefined) {
    var ex = stfCleanExtraDepts_(org, payload.extra_depts, stfStr_(t.v[STF_COL.unit]), stfStr_(t.v[STF_COL.dept]), stfSplitCodes_(stfReadExtraMap_()[t.emp]));
    if (ex.error) return { ok: false, error: ex.error };
    // 清單已用（可能剛改過的）新主要部門驗過；和現值不同才寫
    if (ex.codes.join(',') !== stfStr_(stfReadExtraMap_()[t.emp])) {
      if (selfBlockE) return stfSelfOrgErr_();
      var colErr = stfEnsureExtraCol_();
      if (colErr) return { ok: false, error: colErr };
      extraNew = ex.codes;
      changed.push('extra_depts');
    }
  }
  var bulletinNew = null;
  if (payload.bulletin_admin !== undefined && payload.bulletin_admin !== (stfBulletinAdmins_().indexOf(t.emp) !== -1)) {
    // 不能設定自己的（含人資幫自己開；審查 dzy-bulletin#44-3）
    if (stfStr_(t.v[STF_COL.user_id]) && stfStr_(t.v[STF_COL.user_id]) === String(t.auth.user.id)) return { ok: false, error: '不能設定自己的公告管理權限' };
    // 只能勾已開通的同仁：未認領／待審的列勾了，之後自己去認領就多一個有權限的帳號（審查 #44-12）
    if (payload.bulletin_admin && t.status !== 'active') return { ok: false, error: '只有已開通的同仁可以設定公告管理權限' };
    bulletinNew = payload.bulletin_admin;
    // 紀錄寫明開／關：權限清單存在 Script Property（不在試算表備份裡），staff_log 是可追溯、可重建的那份（審查 #44-4）
    changed.push('bulletin_admin=' + (bulletinNew ? '開' : '關'));
  }
  if (!changed.length) return { ok: false, error: '沒有要改的欄位' };
  // 第二期：改組織欄／兼任部門前後各算一次權限；非 admin 若讓對方拿到（失去）platform.permmap → 擋
  var chkE = null;
  if ((changed.indexOf('org') !== -1 || changed.indexOf('extra_depts') !== -1) && typeof permStaffChangeCheck_ === 'function') {
    var exBeforeE = stfSplitCodes_(stfReadExtraMap_()[t.emp]);
    var exAfterE = extraNew || (changed.indexOf('org') !== -1 ? stfExtraAfterPrune_(exBeforeE, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit])) : exBeforeE);
    chkE = permStaffChangeCheck_(isAdminE, t.hit.values, exBeforeE, t.v, exAfterE);
    if (chkE.block) return chkE.block;
  }
  if (bulletinNew !== null) stfSetBulletinAdmin_(t.emp, bulletinNew);
  if (changed.indexOf('name') !== -1) {
    var userRow = findUsrRowById_(stfStr_(t.v[STF_COL.user_id]));
    if (userRow) stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.name + 1).setValue(authSafeCell_(t.v[STF_COL.name]));
  }
  // 兼任部門那一格先寫（只寫該格）；org 變動時主要部門自動從兼任移除（沒帶 extra_depts 的情況）
  if (extraNew) stfWriteExtraCell_(t.hit.row, extraNew);
  else if (changed.indexOf('org') !== -1) stfPruneExtraDept_(t.hit.row, t.emp, stfStr_(t.v[STF_COL.dept]), stfStr_(t.v[STF_COL.unit]));
  var savedEdit = stfSave_(t, 'admin_edit', '改了：' + changed.join(','));
  if (chkE && typeof permAuditStaffChange_ === 'function') permAuditStaffChange_(t.auth.user.id, t.emp, chkE, 'staff_edit');
  // 有打卡對照的人改單位一律走調店流程（StaffClock.gs clkAfterConfirm_）：新單位有打卡就開 add 單、舊主店降支援
  if (changed.indexOf('org') !== -1 && typeof clkAfterConfirm_ === 'function') {
    clkAfterConfirm_(t.emp, oldUnitForClock, stfStr_(t.v[STF_COL.unit]), t.auth.user.id);
  }
  return savedEdit;
}

// ============================================================
// 9. 初始化（§4；手動在編輯器執行一次 setupStaff，可重跑）
// ============================================================

var STF_DEFAULT_ORG = [
  ['brand', 'mzt', '墨竹亭', '', '', '', 1, 'TRUE'],
  ['brand', 'mala', '麻的小辛辣', '', '', '', 2, 'TRUE'],
  ['brand', 'yiwu', '一悟燒肉', '', '', '', 3, 'TRUE'],
  ['brand', 'ck', '中央工廠', '', '', '', 4, 'TRUE'],   // 2026-10-23 起正式資料改叫「研發部」（名稱調整 STF_2610N_RENAMES）；種子沿用舊名，由名稱調整改
  ['brand', 'dzy', '鼎兆元總部', '', '', '', 5, 'TRUE'],
  ['unit', 'mzt-js', '新竹金山', 'mzt', 'store', '', 1, 'TRUE'],
  ['unit', 'mzt-gf', '新竹光復', 'mzt', 'store', '', 2, 'TRUE'],
  ['unit', 'mzt-lzl', '台北六張犁', 'mzt', 'store', '', 3, 'TRUE'],
  ['unit', 'mzt-wx', '台中文心', 'mzt', 'store', '', 4, 'FALSE'],
  ['unit', 'mzt-rg', '內湖瑞光', 'mzt', 'store', '', 5, 'FALSE'],
  ['unit', 'mzt-mc', '台中美村', 'mzt', 'store', '', 6, 'FALSE'],
  ['unit', 'mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office', '', 7, 'TRUE'],
  ['unit', 'mala-gf', '新竹光復', 'mala', 'store', '', 1, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣品牌辦公室', 'mala', 'office', '', 2, 'TRUE'],
  ['unit', 'yiwu-js', '新竹金山', 'yiwu', 'store', '', 1, 'TRUE'],
  ['unit', 'yiwu-wx', '竹北文興', 'yiwu', 'store', '', 2, 'TRUE'],
  ['unit', 'yiwu-hq', '一悟燒肉品牌辦公室', 'yiwu', 'office', '', 3, 'TRUE'],
  ['unit', 'ck', '中央工廠（央廚）', 'ck', 'store', '', 1, 'TRUE'],
  ['unit', 'dzy-hq', '鼎兆元總部', 'dzy', 'hq', '', 1, 'TRUE'],
  ['title', 'pt', '計時同仁', 'store', '', 1, 1, 'TRUE'],
  ['title', 'ft', '正職同仁', 'store', '', 2, 2, 'TRUE'],
  ['title', 'sm', '店長', 'store', '', 3, 3, 'TRUE'],
  ['title', 'am', '區經理', 'store', '', 4, 4, 'TRUE'],    // 2026-10-20 區經理移回門市（第 15 節）
  ['title', 'sv', '督導', 'store', '', 5, 5, 'FALSE'],
  ['title', 'bd', '品牌總監', 'store', '', 6, 6, 'FALSE'],
  ['title', 'fm', '廠長', 'store', '', 3, 7, 'TRUE'],      // 中央工廠專用（STF_TITLE_UNITS），店長同等
  ['title', 'rdd', '廚藝總監', 'store', '', 4, 8, 'TRUE'], // 中央工廠專用，廠長之上
  ['title', 'ofs', '行政同仁', 'office', '', 1, 1, 'TRUE'],
  ['title', 'oam', '區經理', 'office', '', 2, 2, 'FALSE'],  // 2026-10-20 停用（區經理移回門市）
  ['title', 'osv', '區督導', 'office', '', 2, 3, 'TRUE'],
  ['title', 'odir', '總監', 'office', '', 3, 4, 'TRUE'],
  ['title', 'hs', '部門同仁', 'hq', '', 1, 1, 'TRUE'],
  ['title', 'hm', '總監', 'hq', '', 2, 2, 'TRUE'],
  ['title', 'ceo', '執行長', 'hq', '', 3, 3, 'TRUE'],
  ['title', 'gm', '總經理', 'hq', '', 4, 4, 'TRUE'],
  ['title', 'chair', '董事長', 'hq', '', 5, 5, 'TRUE'],
  // 部門只掛在鼎兆元總部（Eason 2026-10-11）；墨竹亭總部、小辛辣總部沒有部門，同仁不必選
  ['dept', 'fin', '財務部', 'dzy-hq', '', '', 1, 'TRUE'],
  ['dept', 'hr', '人資部', 'dzy-hq', '', '', 2, 'TRUE'],
  ['dept', 'it', '資訊部', 'dzy-hq', '', '', 3, 'TRUE'],
  ['dept', 'eng', '工程部', 'dzy-hq', '', '', 4, 'TRUE'],
  ['dept', 'franchise', '加盟部', 'dzy-hq', '', '', 5, 'TRUE'],
  ['dept', 'purchase', '採購部', 'dzy-hq', '', '', 6, 'TRUE'],
  ['dept', 'ops', '營運部', 'dzy-hq', '', '', 7, 'TRUE'],
  ['dept', 'training', '訓練部', 'dzy-hq', '', '', 8, 'TRUE'],
  ['dept', 'marketing', '行銷部', 'dzy-hq', '', '', 9, 'TRUE'],
  ['dept', 'mgmt', '管理部', 'dzy-hq', '', '', 10, 'TRUE'],
  ['dept', 'branddev', '品牌發展部', 'dzy-hq', '', '', 11, 'TRUE']   // 2026-10-23 新增（第 17 節）；正式環境由 orgAddBranddev202610 補，與種子冪等
];

function stfEnsureSheet_(ss, name, headers, defaults) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  // 已有表頭就比對，不一樣直接停（Fable 上線前審第 9 條：無條件覆寫會讓資料與表頭錯位且沒有任何警告）
  var existing = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(function (v) { return String(v).trim(); });
  var empty = existing.every(function (v) { return v === ''; });
  if (!empty && existing.join('|') !== headers.join('|')) {
    throw new Error('分頁「' + name + '」的表頭與程式不一致，停止初始化以免資料錯位：' + existing.join(','));
  }
  if (empty) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (sh.getLastRow() <= 1 && defaults && defaults.length) {
    sh.getRange(2, 1, defaults.length, headers.length).setValues(defaults);
  }
  return sh;
}

/**
 * 只補不覆蓋：建三個分頁（已有就只寫表頭）、空的 org 才寫預設列、
 * roles.staff 的 perms **upsert** 成 platform.self（Fable 第 7 條：既有試算表 roles 早有 5 列，
 * Setup.gs 的 ensureTab_ 只在空表寫預設列，不能靠它）、users 補第 11 欄 token_after 表頭。
 */
function setupStaff() {
  var ss = SpreadsheetApp.getActive();
  stfEnsureSheet_(ss, STF_SHEET, STF_HEADERS, []);
  stfEnsureSheet_(ss, STF_SHEET_ORG, STF_ORG_HEADERS, STF_DEFAULT_ORG);
  stfEnsureSheet_(ss, STF_SHEET_LOG, STF_LOG_HEADERS, []);

  var roles = ss.getSheetByName(USR_SHEET_ROLES);
  var last = roles.getLastRow();
  var rows = last >= 2 ? roles.getRange(2, 1, last - 1, 3).getValues() : [];
  var found = false;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === 'staff') {
      roles.getRange(i + 2, 3).setValue('platform.self');
      found = true;
    }
  }
  if (!found) roles.getRange(last + 1, 1, 1, 3).setValues([['staff', '員工', 'platform.self']]);

  var users = ss.getSheetByName(USR_SHEET_USERS);
  users.getRange(1, AUTH_USERS_COL.token_after + 1).setValue('token_after');
  // 員工名單統一（StaffClock.gs）：clock_stores／staff_clock／clock_outbox 三分頁＋staff 右側 hire_date、last_day（只補不覆蓋）
  if (typeof clkSetup_ === 'function') clkSetup_(ss);
  return { ok: true };
}

// ============================================================
// 10. 組織改版一次性升級／回退（組織改版 T4；規格第 6、11、13 節；只有 role admin）
// ============================================================

var STF_PROP_ORG_UPGRADE = 'ORG_UPGRADE_STATE';
var STF_ORG_COL = { kind: 0, code: 1, name: 2, parent: 3, ladder: 4, rank: 5, order: 6, active: 7 };
// 管理部：總部部門代碼；執行長／總經理／董事長應掛 dzy-hq／管理部（規格第 14 節）
var STF_MGMT_DEPT = 'mgmt';
var STF_EXEC_TITLES = ['ceo', 'gm', 'chair'];
var STF_BRAND_OFFICES = ['mzt-hq', 'mala-hq', 'yiwu-hq'];
// 品牌辦公室同仁原 hq 職稱 → office 職稱（第 13 節）；ceo／gm／chair 不動、列 todo
var STF_OFFICE_TITLE_MAP = { hs: 'ofs', hm: 'osv' };

// 既有列只改指定欄位：[kind, code, 欄位, 目標值]
var STF_UPGRADE_SET = [
  ['brand', 'ck', 'name', '中央工廠'],
  ['unit', 'ck', 'name', '中央工廠（央廚）'],
  ['unit', 'mzt-hq', 'name', '墨竹亭品牌辦公室'], ['unit', 'mzt-hq', 'ladder', 'office'],
  ['unit', 'mala-hq', 'name', '小辛辣品牌辦公室'], ['unit', 'mala-hq', 'ladder', 'office'],
  ['unit', 'mzt-wx', 'active', 'FALSE'], ['unit', 'mzt-rg', 'active', 'FALSE'], ['unit', 'mzt-mc', 'active', 'FALSE'],
  ['title', 'am', 'active', 'FALSE'], ['title', 'sv', 'active', 'FALSE'], ['title', 'bd', 'active', 'FALSE']
];
// STF_UPGRADE_SET 的目標列若整列缺失，就以這裡的完整八欄補上（舊值取自升級前預設 org；已存在的列只依 STF_UPGRADE_SET 改指定欄位，不動其他欄）
var STF_UPGRADE_REQUIRED = [
  ['brand', 'ck', '中央工廠', '', '', '', 4, 'TRUE'],
  ['unit', 'ck', '中央工廠（央廚）', 'ck', 'store', '', 1, 'TRUE'],
  ['unit', 'mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office', '', 7, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣品牌辦公室', 'mala', 'office', '', 2, 'TRUE'],
  ['unit', 'mzt-wx', '台中文心', 'mzt', 'store', '', 4, 'FALSE'],
  ['unit', 'mzt-rg', '內湖瑞光', 'mzt', 'store', '', 5, 'FALSE'],
  ['unit', 'mzt-mc', '台中美村', 'mzt', 'store', '', 6, 'FALSE'],
  ['title', 'am', '區經理', 'store', '', 4, 4, 'FALSE'],
  ['title', 'sv', '督導', 'store', '', 5, 5, 'FALSE'],
  ['title', 'bd', '品牌總監', 'store', '', 6, 6, 'FALSE']
];
// (kind, code) upsert 的新列（完整八欄）；已存在就對齊 name／parent／ladder／rank／order／active
var STF_UPGRADE_ADD = [
  ['unit', 'yiwu-hq', '一悟燒肉品牌辦公室', 'yiwu', 'office', '', 3, 'TRUE'],
  ['title', 'ofs', '行政同仁', 'office', '', 1, 1, 'TRUE'],
  ['title', 'oam', '區經理', 'office', '', 2, 2, 'TRUE'],
  ['title', 'osv', '區督導', 'office', '', 2, 3, 'TRUE'],
  ['title', 'odir', '總監', 'office', '', 3, 4, 'TRUE'],
  ['dept', 'mgmt', '管理部', 'dzy-hq', '', '', 10, 'TRUE']
];
var STF_UPGRADE_ADD_FIELDS = ['name', 'parent', 'ladder', 'rank', 'order', 'active'];

function stfNormCell_(v, idx) {
  var t = (v === undefined || v === null) ? '' : String(v).trim();
  return idx === STF_ORG_COL.active ? t.toUpperCase() : t;
}

/** org 分頁現況（正規化成字串、略過空列）：[[8 欄]…] */
function stfOrgSnapshot_() {
  return stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length).map(function (r) {
    return r.map(function (v, i) { return stfNormCell_(v, i); });
  }).filter(function (r) { return r[0] !== '' || r[1] !== ''; });
}

function stfHashText_(text) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  var hex = '';
  for (var i = 0; i < d.length; i++) hex += ((d[i] + 256) % 256 + 256).toString(16).slice(1);
  return hex;
}
function stfOrgHash_() { return stfHashText_(JSON.stringify(stfOrgSnapshot_())); }

/** 備份分頁（含表頭列）的值 → 與 stfOrgSnapshot_ 同樣正規化後的列（用來判斷「org 已經等於備份」） */
function stfNormOrgRows_(vals) {
  return vals.slice(1).map(function (r) {
    return r.slice(0, STF_ORG_HEADERS.length).map(function (v, i) { return stfNormCell_(v, i); });
  }).filter(function (r) { return r[0] !== '' || r[1] !== ''; });
}

/** clock_stores 的值（含表頭列）→ 去頭尾空白、去掉列尾空格、略過空列 */
function stfNormClockRows_(vals) {
  return vals.map(function (r) {
    var o = r.map(function (v) { return (v === undefined || v === null) ? '' : String(v).trim(); });
    while (o.length && o[o.length - 1] === '') o.pop();
    return o;
  }).filter(function (r) { return r.length > 0; });
}
function stfClockSnapshot_() {
  var sh = stfSheet_('clock_stores');
  return sh ? stfNormClockRows_(stfSheetValues_(sh, 5)) : [];
}
function stfClockHash_() { return stfHashText_(JSON.stringify(stfClockSnapshot_())); }
function stfSameRows_(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** 備份分頁「遺失」＝不存在，或存在但被清空（沒有表頭列）。回遺失的分頁名陣列 */
function stfLostBackups_(state) {
  var lost = [];
  [state.org_bak, state.stf_bak, state.clk_bak].forEach(function (n) {
    if (!n) return;
    var sh = stfSheet_(n);
    if (!sh || sh.getLastRow() < 1 || String(sh.getRange(1, 1, 1, 1).getValues()[0][0]).trim() === '') lost.push(n);
  });
  return lost;
}
function stfGetUpgradeState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(STF_PROP_ORG_UPGRADE);
  if (!raw) return null;
  try { var o = JSON.parse(raw); return (o && typeof o === 'object' && o.org_bak) ? o : null; } catch (e) { return null; }
}
function stfSetUpgradeState_(o) {
  PropertiesService.getScriptProperties().setProperty(STF_PROP_ORG_UPGRADE, o ? JSON.stringify(o) : '');
}

/** 把整塊值寫進分頁（含表頭列），原本更長的部分補空白；回寫的列數 */
function stfPutBlock_(sh, rows, width) {
  var oldLast = sh.getLastRow();
  var n = Math.max(rows.length, oldLast);
  if (n === 0) return 0;
  var out = [];
  for (var i = 0; i < n; i++) {
    var r = i < rows.length ? rows[i].slice(0, width) : [];
    while (r.length < width) r.push('');
    out.push(r);
  }
  sh.getRange(1, 1, n, width).setValues(out);
  return rows.length;
}

/** 整張分頁的值（含表頭，至少 minWidth 欄） */
function stfSheetValues_(sh, minWidth) {
  var last = sh.getLastRow();
  if (last < 1) return [];
  var width = Math.max(minWidth || 1, typeof sh.getLastColumn === 'function' ? sh.getLastColumn() : 1);
  return sh.getRange(1, 1, last, width).getValues();
}

function stfCopyToNewSheet_(src, name, minWidth) {
  var ss = SpreadsheetApp.getActive();
  var vals = stfSheetValues_(src, minWidth);
  var dst = ss.getSheetByName(name) || ss.insertSheet(name);
  if (vals.length) stfPutBlock_(dst, vals, vals[0].length);
  return vals.length;
}

function stfStamp_() { return stfNowText_().replace(/\D/g, '').slice(0, 12); }

/** 一次決定備份／快照分頁名：同一個時間戳＋共用序號（撞名就 _2、_3…），建立任何備份前先呼叫；真 Apps Script 的 insertSheet 遇同名會丟錯 */
function stfPickBackupNames_(withClock) {
  var base = stfStamp_();
  for (var n = 1; n < 1000; n++) {
    var suf = n === 1 ? base : base + '_' + n;
    var names = { org_bak: 'org_bak_' + suf, clk_bak: withClock ? 'clk_bak_' + suf : '', clk_snap: withClock ? 'clk_upg_' + suf : '', stf_bak: 'stf_bak_' + suf, org_snap: 'org_upg_' + suf };
    var clash = Object.keys(names).some(function (k) { return names[k] && stfSheet_(names[k]); });
    if (!clash) return names;
  }
  throw new Error('備份分頁名稱無法決定');
}

/** 升級計畫（唯讀）：org 要改的格、新增的列、記憶體裡改完的 org 列、clock 狀態、職稱對應、todo */
function stfUpgradePlan_() {
  var rowsRaw = stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length);
  var work = rowsRaw.map(function (r) { return r.slice(); });
  var report = [];
  var cells = [];      // 要寫的格：{row(試算表列號), col(1-based), value}
  var addRows = [];
  var find = function (kind, code) {
    for (var i = 0; i < work.length; i++) {
      if (stfStr_(work[i][STF_ORG_COL.kind]) === kind && stfStr_(work[i][STF_ORG_COL.code]) === code) return i;
    }
    return -1;
  };
  var setCell = function (i, field, to) {
    var idx = STF_ORG_COL[field];
    var from = stfNormCell_(work[i][idx], idx);
    if (from === stfNormCell_(to, idx)) return;
    report.push({ code: stfStr_(work[i][STF_ORG_COL.code]), kind: stfStr_(work[i][STF_ORG_COL.kind]), field: field, from: from, to: String(to) });
    work[i][idx] = to;
    cells.push({ row: i + 2, col: idx + 1, value: to });
  };
  // 必要列缺失 → 先整列補上（完整八欄）；之後 SET 對補上的列沒有差異
  STF_UPGRADE_REQUIRED.forEach(function (row) {
    if (find(row[0], row[1]) === -1) {
      work.push(row.slice());
      addRows.push(row.slice());
      report.push({ code: row[1], kind: row[0], field: 'row', from: '', to: 'added' });
    }
  });
  // 已套用 2026-10-20 職稱調整（org 有廠長 fm 列）→ 區經理 am 的啟用、品牌辦公室區經理 oam 的停用以那次為準，這裡不再改回去（重跑不倒退）
  var post2610 = find('title', 'fm') !== -1;
  var keep2610 = function (kind, code, field) { return post2610 && kind === 'title' && field === 'active' && (code === 'am' || code === 'oam'); };
  STF_UPGRADE_SET.forEach(function (x) {
    var i = find(x[0], x[1]);
    if (i !== -1 && !keep2610(x[0], x[1], x[2])) setCell(i, x[2], x[3]);
  });
  STF_UPGRADE_ADD.forEach(function (row) {
    var i = find(row[0], row[1]);
    if (i === -1) {
      work.push(row.slice());
      addRows.push(row.slice());
      report.push({ code: row[1], kind: row[0], field: 'row', from: '', to: 'added' });
    } else {
      STF_UPGRADE_ADD_FIELDS.forEach(function (f) { if (!keep2610(row[0], row[1], f)) setCell(i, f, row[STF_ORG_COL[f]]); });
    }
  });
  var newOrg = stfBuildOrg_(work);

  // 打卡 clock_stores 的 hq 列：unit_code 當集合，沒有 yiwu-hq 就補（保留自訂值與順序）
  var clock = { status: 'custom', row: 0, value: '' };
  var csh = stfSheet_('clock_stores');
  if (csh && csh.getLastRow() >= 2) {
    var crows = csh.getRange(2, 1, csh.getLastRow() - 1, 3).getValues();
    for (var c = 0; c < crows.length; c++) {
      if (stfStr_(crows[c][0]).toLowerCase() !== 'hq') continue;
      var cur = stfStr_(crows[c][2]);
      if (cur === '') break;
      var set = cur.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      if (set.indexOf('yiwu-hq') !== -1) { clock = { status: 'skipped', row: c + 2, value: cur }; }
      else { clock = { status: 'updated', row: c + 2, value: set.concat(['yiwu-hq']).join(',') }; }
      break;
    }
  }

  // 同仁：職稱對應與 todo
  var titles = [];
  var todo = [];
  var rows = stfAllRows_();
  rows.forEach(function (r) {
    var emp = stfStr_(r.values[STF_COL.emp_no]);
    var name = stfStr_(r.values[STF_COL.name]);
    var unit = stfStr_(r.values[STF_COL.unit]);
    var title = stfStr_(r.values[STF_COL.title]);
    var status = stfStr_(r.values[STF_COL.status]);
    var effTitle = title;
    if (unit && STF_BRAND_OFFICES.indexOf(unit) !== -1 && STF_OFFICE_TITLE_MAP[title]) {
      effTitle = STF_OFFICE_TITLE_MAP[title];
      titles.push({ emp_no: emp, name: name, from: title, to: effTitle,
        from_name: newOrg.title[title] ? newOrg.title[title].name : title, to_name: newOrg.title[effTitle] ? newOrg.title[effTitle].name : effTitle, row: r.row });
    }
    var details = stfFlagDetails_({ unit: unit, title: effTitle, dept: stfStr_(r.values[STF_COL.dept]), status: status,
      p_unit: stfStr_(r.values[STF_COL.p_unit]), p_title: stfStr_(r.values[STF_COL.p_title]), p_dept: stfStr_(r.values[STF_COL.p_dept]) }, newOrg);
    details.forEach(function (f) {
      var uc = f.submitted && stfStr_(r.values[STF_COL.p_unit]) ? stfStr_(r.values[STF_COL.p_unit]) : unit;
      todo.push({ emp_no: emp, name: name, unit_name: newOrg.unit[uc] ? newOrg.unit[uc].name : uc, flag: f.flag, submitted: f.submitted });
    });
  });
  return { report: report, cells: cells, addRows: addRows, newOrg: newOrg, clock: clock, titles: titles, todo: todo };
}

/** 只有 role admin（人資也不行） */
function stfRequireAdmin_(token) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  if (String(me.data.user.role) !== 'admin') return { ok: false, error: STF_MSG.NO_PERM };
  return { ok: true, user: me.data.user };
}

function stfOrgSheetProblem_() {
  var sh = stfSheet_(STF_SHEET_ORG);
  if (!sh || !stfSheet_(STF_SHEET)) return '找不到 org 或 staff 分頁，請先執行 setupStaff';
  var head = sh.getRange(1, 1, 1, STF_ORG_HEADERS.length).getValues()[0].map(function (v) { return String(v).trim(); });
  if (head.join('|') !== STF_ORG_HEADERS.join('|')) return '分頁「org」的表頭與程式不一致，停止升級：' + head.join(',');
  return '';
}

function handleOrgUpgrade_(token, payload) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  var problem = stfOrgSheetProblem_();
  if (problem) return { ok: false, error: problem };
  var dry = !!(payload && payload.dryrun === true);
  var st0 = stfGetUpgradeState_();
  if (st0) {
    var lost = stfLostBackups_(st0);
    if (lost.length) return { ok: false, error: '已有升級紀錄，但備份分頁不見了或被清空：' + lost.join('、') + '。為避免之後回退沒有東西可還原，停止升級，請先處理（找回備份分頁，或確認要放棄回退能力）' };
  }
  var colState = stfExtraColState_();
  if (colState === 'mismatch') return { ok: false, error: '分頁「staff」第 ' + STF_EXTRA_DEPTS_COL_NO + ' 欄的表頭不是 extra_depts，停止升級以免資料錯位' };
  var plan = stfUpgradePlan_();
  var state = stfGetUpgradeState_();
  var backupExists = !!(state && stfSheet_(state.org_bak));
  var data = {
    dryrun: dry,
    backup: backupExists ? 'exists' : 'created',
    org: plan.report,
    clock: plan.clock.status,
    staffColumn: colState === 'ok' ? 'exists' : 'added',
    titles: plan.titles.map(function (t) { return { emp_no: t.emp_no, name: t.name, from: t.from, to: t.to, from_name: t.from_name, to_name: t.to_name }; }),
    todo: plan.todo
  };
  if (dry) return { ok: true, data: data };

  // ① 備份（已有備份不覆蓋）：org 整份、clock_stores 整份、受影響同仁的職稱
  if (!backupExists) {
    var nm = stfPickBackupNames_(!!stfSheet_('clock_stores'));
    state = { at: stfNowText_(), by: String(auth.user.id), org_bak: nm.org_bak, clk_bak: nm.clk_bak, stf_bak: nm.stf_bak, org_snap: nm.org_snap, clk_snap: nm.clk_snap, org_hash: '', clk_hash: '' };
    stfCopyToNewSheet_(stfSheet_(STF_SHEET_ORG), state.org_bak, STF_ORG_HEADERS.length);
    if (state.clk_bak) stfCopyToNewSheet_(stfSheet_('clock_stores'), state.clk_bak, 5);
    var sb = SpreadsheetApp.getActive().insertSheet(state.stf_bak);
    stfPutBlock_(sb, [['emp_no', 'title', 'to_title']], 3);
    stfSetUpgradeState_(state);
  }
  // 受影響同仁的原職稱：已在備份裡的不覆蓋（保留最早的原值），新出現的補在後面
  var bakSheet = stfSheet_(state.stf_bak) || SpreadsheetApp.getActive().insertSheet(state.stf_bak);
  var bakVals = stfSheetValues_(bakSheet, 3);
  if (!bakVals.length) bakVals = [['emp_no', 'title', 'to_title']];
  var have = {};
  bakVals.slice(1).forEach(function (r) { have[stfNormEmp_(r[0])] = true; });
  var added = plan.titles.filter(function (t) { return !have[stfNormEmp_(t.emp_no)]; });
  if (added.length) {
    added.forEach(function (t) { bakVals.push([t.emp_no, t.from, t.to]); });
    stfPutBlock_(bakSheet, bakVals, 3);
  }

  // ② staff 兼任部門欄
  if (colState !== 'ok') {
    var colErr = stfEnsureExtraCol_();
    if (colErr) return { ok: false, error: colErr };
  }
  // ③ org 列（只寫要改的格；新列一次寫完）
  var osh = stfSheet_(STF_SHEET_ORG);
  plan.cells.forEach(function (c) { osh.getRange(c.row, c.col, 1, 1).setValue(c.value); });
  if (plan.addRows.length) stfAppendBlock_(STF_SHEET_ORG, plan.addRows, STF_ORG_HEADERS.length, false);
  // ④ clock_stores hq 列
  if (plan.clock.status === 'updated') stfSheet_('clock_stores').getRange(plan.clock.row, 3, 1, 1).setValue(plan.clock.value);
  // ⑤ 同仁職稱
  plan.titles.forEach(function (t) {
    var cur = stfFindByEmp_(t.emp_no);
    if (!cur || stfStr_(cur.values[STF_COL.title]) !== t.from) return;
    stfSheet_(STF_SHEET).getRange(cur.row, STF_COL.title + 1, 1, 1).setValue(t.to);
    stfLog_(t.emp_no, 'org_upgrade', String(auth.user.id), 'title:' + t.from + '>' + t.to);
  });
  // ⑥ 後置條件：重新算一次計畫，org／clock／職稱都不該再有差異
  var after = stfUpgradePlan_();
  if (after.cells.length || after.addRows.length || after.clock.status === 'updated' || after.titles.length) {
    return { ok: false, error: '升級後驗證失敗（資料與目標不一致），請檢查後重跑；原始資料可用 orgRollback2026 還原' };
  }
  // ⑥b 新增的整列要和目標逐欄（完整八欄）一致
  var nowOrg = stfOrgSnapshot_();
  var rowsOk = plan.addRows.every(function (ar) {
    var want = ar.map(function (v, i) { return stfNormCell_(v, i); });
    return nowOrg.some(function (cr) { return cr.join('|') === want.join('|'); });
  });
  if (!rowsOk) return { ok: false, error: '升級後驗證失敗（新增列與目標不一致），請檢查後重跑；原始資料可用 orgRollback2026 還原' };
  // ⑦ 「升級後」雜湊與快照只在首次成功時建立；已有基準就不更新（重跑不得把切換後別人的修改洗進基準）
  if (!state.org_hash) {
    state.org_hash = stfOrgHash_();
    var snapSheet = stfSheet_(state.org_snap) || SpreadsheetApp.getActive().insertSheet(state.org_snap);
    stfPutBlock_(snapSheet, [STF_ORG_HEADERS].concat(stfOrgSnapshot_()), STF_ORG_HEADERS.length);
    // clock_stores 同一套：升級後雜湊＋快照（沒有 clock_stores 或沒備份就不管）
    if (state.clk_bak && state.clk_snap && stfSheet_('clock_stores')) {
      state.clk_hash = stfClockHash_();
      var csnap = stfSheet_(state.clk_snap) || SpreadsheetApp.getActive().insertSheet(state.clk_snap);
      var cvals = stfClockSnapshot_();
      var cw = cvals.reduce(function (m, r) { return Math.max(m, r.length); }, 5);
      stfPutBlock_(csnap, cvals, cw);
    }
    state.upgraded_at = stfNowText_();
    stfSetUpgradeState_(state);
  }
  return { ok: true, data: data };
}

/** 兩份「列」的差異：以第 0 欄為 key；欄位名由 heads 取（沒有就 colN） */
function stfDiffClockRows_(expectRows, curRows) {
  var diff = [];
  var index = function (rows) {
    var m = {}, seen = {};
    rows.forEach(function (r, i) { var k = r[0] || ('#' + i); seen[k] = (seen[k] || 0) + 1; m[seen[k] > 1 ? k + '~' + seen[k] : k] = r; });
    return m;
  };
  var em = index(expectRows), cm = index(curRows);
  var head = expectRows[0] || [];
  Object.keys(em).forEach(function (k) {
    var e = em[k], c = cm[k];
    if (!c) { diff.push({ key: k, field: 'row', expected: 'exists', actual: 'removed' }); return; }
    var n = Math.max(e.length, c.length);
    for (var i = 0; i < n; i++) {
      var ev = e[i] === undefined ? '' : e[i], cv = c[i] === undefined ? '' : c[i];
      if (ev !== cv) diff.push({ key: k, field: head[i] || ('col' + (i + 1)), expected: ev, actual: cv });
    }
  });
  Object.keys(cm).forEach(function (k) { if (!em[k]) diff.push({ key: k, field: 'row', expected: 'absent', actual: 'added' }); });
  return diff;
}

/** 目前 org 與「切換後快照」分頁的差異（以 kind|code 為 key）：[{kind, code, field, expected, actual}] */
function stfOrgDiffVsSnap_(snapName) {
  var diff = [];
  var snap = snapName ? stfSheet_(snapName) : null;
  var expectRows = snap ? stfSheetValues_(snap, STF_ORG_HEADERS.length).slice(1).map(function (r) { return r.slice(0, 8).map(function (v, i) { return stfNormCell_(v, i); }); }) : [];
  var key = function (r) { return r[0] + '|' + r[1]; };
  var curRows = stfOrgSnapshot_();
  var expMap = {}, curMap = {};
  expectRows.forEach(function (r) { expMap[key(r)] = r; });
  curRows.forEach(function (r) { curMap[key(r)] = r; });
  Object.keys(expMap).forEach(function (k) {
    var e = expMap[k], c = curMap[k];
    if (!c) { diff.push({ kind: e[0], code: e[1], field: 'row', expected: 'exists', actual: 'removed' }); return; }
    STF_ORG_HEADERS.forEach(function (f, i) { if (e[i] !== c[i]) diff.push({ kind: e[0], code: e[1], field: f, expected: e[i], actual: c[i] }); });
  });
  Object.keys(curMap).forEach(function (k) {
    if (!expMap[k]) diff.push({ kind: curMap[k][0], code: curMap[k][1], field: 'row', expected: 'absent', actual: 'added' });
  });
  return diff;
}

/**
 * 回退：org（和 clock_stores）整份蓋回備份。
 * - 寫入前先檢查 state 指向的備份分頁與正式分頁都在，缺一零寫入失敗、保留 state。
 * - 某一份「已等於備份」視為該步已完成（回退中斷後可重跑）；否則切換後被改過（與升級後雜湊不符）就拒絕並列出差異。
 */
function handleOrgRollback_(token) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  // 2026-10-20 職稱調整還沒退回 → 先退那一次（不然這次整表蓋回會把職稱調整一起抹掉、留下半套的同仁職稱與權限規則）
  if (stf2610GetState_()) return { ok: false, error: '已套用 2026-10-20 職稱調整（中央工廠廠長／廚藝總監、區經理移回門市），請先按「退回職稱調整」再退回組織' };
  var state = stfGetUpgradeState_();
  if (!state) return { ok: false, error: '找不到升級紀錄，沒有可退回的備份' };
  var bak = stfSheet_(state.org_bak);
  if (!bak) return { ok: false, error: '找不到備份 ' + state.org_bak };
  var osh = stfSheet_(STF_SHEET_ORG);
  if (!osh) return { ok: false, error: '找不到 org 分頁' };
  if (state.stf_bak && !stfSheet_(state.stf_bak)) return { ok: false, error: '找不到備份 ' + state.stf_bak + '（同仁職稱備份），為避免半套回退，什麼都沒有改' };
  var hasClock = !!state.clk_bak;
  if (hasClock && !stfSheet_(state.clk_bak)) return { ok: false, error: '找不到備份 ' + state.clk_bak + '（clock_stores 備份），為避免半套回退，什麼都沒有改' };
  if (hasClock && !stfSheet_('clock_stores')) return { ok: false, error: '找不到分頁 clock_stores，為避免半套回退，什麼都沒有改' };
  if (!stfSheet_(STF_SHEET)) return { ok: false, error: '找不到分頁 ' + STF_SHEET };
  var emptied = stfLostBackups_(state);
  if (emptied.length) return { ok: false, error: '備份分頁被清空了：' + emptied.join('、') + '，為避免半套回退，什麼都沒有改' };

  // ① 判斷各步狀態：已等於備份＝已完成；否則雜湊不符＝切換後被改過 → 拒絕
  var bakOrgRows = stfNormOrgRows_(stfSheetValues_(bak, STF_ORG_HEADERS.length));
  var orgDone = stfSameRows_(stfOrgSnapshot_(), bakOrgRows);
  var clockDone = false;
  if (hasClock) clockDone = stfSameRows_(stfClockSnapshot_(), stfNormClockRows_(stfSheetValues_(stfSheet_(state.clk_bak), 5)));
  var orgBad = !orgDone && !!state.org_hash && stfOrgHash_() !== state.org_hash;
  var clockBad = hasClock && !clockDone && !!state.clk_hash && stfClockHash_() !== state.clk_hash;
  if (orgBad || clockBad) {
    var out = {};
    if ((orgBad && !stfSheet_(state.org_snap)) || (clockBad && !(state.clk_snap && stfSheet_(state.clk_snap)))) {
      return { ok: false, error: '找不到切換後快照，無法比對差異；請先確認組織表沒被改過' };
    }
    if (orgBad) out.diff = stfOrgDiffVsSnap_(state.org_snap);
    if (clockBad) {
      var csnap = state.clk_snap ? stfSheet_(state.clk_snap) : null;
      out.clock_diff = stfDiffClockRows_(csnap ? stfNormClockRows_(stfSheetValues_(csnap, 5)) : [], stfClockSnapshot_());
    }
    return { ok: false, error: '切換後' + (orgBad ? '組織資料' : '') + (orgBad && clockBad ? '和' : '') + (clockBad ? '打卡店別對照（clock_stores）' : '') + '又被改過，為避免蓋掉新的修改，拒絕整表覆蓋；差異已列出', data: out };
  }

  // ② 先還原同仁職稱（只還原「目前仍是升級後職稱」的人；之後被改過的不動；重跑時已還原的不受影響）
  var titlesRestored = 0, titlesSkipped = [];
  var stfBak = stfSheet_(state.stf_bak);
  if (stfBak) {
    stfSheetValues_(stfBak, 3).slice(1).forEach(function (r) {
      var emp = stfStr_(r[0]);
      if (!emp) return;
      var cur = stfFindByEmp_(emp);
      if (!cur) return;
      var now = stfStr_(cur.values[STF_COL.title]);
      if (now === stfStr_(r[2])) {
        stfSheet_(STF_SHEET).getRange(cur.row, STF_COL.title + 1, 1, 1).setValue(stfStr_(r[1]));
        stfLog_(emp, 'org_rollback', String(auth.user.id), 'title:' + now + '>' + stfStr_(r[1]));
        titlesRestored++;
      } else if (now !== stfStr_(r[1])) {
        titlesSkipped.push(emp);
      }
    });
  }
  // ③ org 整份蓋回（已等於備份就略過）
  var bakVals = stfSheetValues_(bak, STF_ORG_HEADERS.length);
  var restored = orgDone ? bakVals.length - 1 : stfPutBlock_(osh, bakVals, STF_ORG_HEADERS.length) - 1;
  // ④ clock_stores 整份蓋回（已等於備份就略過）
  var clockRestored = false;
  if (hasClock) {
    if (!clockDone) {
      var cv = stfSheetValues_(stfSheet_(state.clk_bak), 5);
      stfPutBlock_(stfSheet_('clock_stores'), cv, cv.length ? cv[0].length : 5);
    }
    clockRestored = true;
  }
  // ⑤ 孤兒：回退後單位／職稱在 org 裡找不到（或已停用）的同仁，只列不改
  var org = stfReadOrg_();
  var orphans = [];
  stfAllRows_().forEach(function (r) {
    var unit = stfStr_(r.values[STF_COL.unit]);
    var title = stfStr_(r.values[STF_COL.title]);
    var dept = stfStr_(r.values[STF_COL.dept]);
    var pdept = stfStr_(r.values[STF_COL.p_dept]);
    if (stfStr_(r.values[STF_COL.status]) === 'disabled') return;
    if (!unit && !(pdept && !org.dept[pdept])) return;
    if ((unit && !org.unit[unit]) || (title && !org.title[title]) || (dept && !org.dept[dept]) || (pdept && !org.dept[pdept])) {
      orphans.push({ emp_no: stfStr_(r.values[STF_COL.emp_no]), name: stfStr_(r.values[STF_COL.name]), unit: unit, title: title, dept: dept });
    }
  });
  stfSetUpgradeState_(null);   // 備份分頁保留；下次升級重新備份
  return { ok: true, data: { restored: restored, clock_restored: clockRestored, titles_restored: titlesRestored, titles_skipped: titlesSkipped, orphans: orphans, backup: state.org_bak } };
}

// ============================================================
// 11. 2026-10-20 職稱調整一次性升級／回退（docs/org/spec.md 第 15 節；只有 role admin）
//   區經理 am 移回門市（啟用）、品牌辦公室區經理 oam 停用、新增中央工廠廠長 fm／廚藝總監 rdd、
//   中央工廠的店長（title／送出待審的 p_title）改廠長、perm_map 把店長 sm 的現行規則複製給 am／fm／rdd。
//   做法比照第 10 節：dryrun:true 預覽、備份分頁、切換後雜湊；回退時 org 或受影響同仁被改過就拒絕。
// ============================================================

var STF_PROP_ORG_2610 = 'ORG_UPGRADE_202610_STATE';
var STF_2610_TITLE_SET = [['am', 'active', 'TRUE'], ['oam', 'active', 'FALSE']];   // 既有職稱列只改這一格
var STF_2610_AM_ROW = ['title', 'am', '區經理', 'store', '', 4, 4, 'TRUE'];          // am 整列不見才補
var STF_2610_ADD = [
  ['title', 'fm', '廠長', 'store', '', 3, 7, 'TRUE'],
  ['title', 'rdd', '廚藝總監', 'store', '', 4, 8, 'TRUE']
];
var STF_2610_STAFF_MAP = { unit: 'ck', from: 'sm', to: 'fm' };   // 中央工廠的店長 → 廠長
var STF_2610_PERM_FROM = 'sm';
var STF_2610_PERM_TO = ['am', 'fm', 'rdd'];
var STF_2610_BAK_HEAD = ['emp_no', 'field', 'from', 'to'];

function stf2610GetState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(STF_PROP_ORG_2610);
  if (!raw) return null;
  try { var o = JSON.parse(raw); return (o && typeof o === 'object' && o.org_bak) ? o : null; } catch (e) { return null; }
}
function stf2610SetState_(o) {
  PropertiesService.getScriptProperties().setProperty(STF_PROP_ORG_2610, o ? JSON.stringify(o) : '');
}

/** 一次決定三個分頁名（同時間戳＋共用序號，撞名就 _2…） */
function stf2610PickNames_() {
  var base = stfStamp_();
  for (var n = 1; n < 1000; n++) {
    var suf = n === 1 ? base : base + '_' + n;
    var names = { org_bak: 'org_bak2610_' + suf, stf_bak: 'stf_bak2610_' + suf, org_snap: 'org_upg2610_' + suf };
    if (!Object.keys(names).some(function (k) { return stfSheet_(names[k]); })) return names;
  }
  throw new Error('備份分頁名稱無法決定');
}

/** perm_map 現況：{ok:false}＝沒初始化或表頭不對；{ok:true, rows} */
function stf2610PermTable_() {
  if (typeof permReadTable_ !== 'function') return { ok: false, status: 'not_inited' };
  var t = permReadTable_(SpreadsheetApp.getActive(), PERM_SHEET_MAP, PERM_MAP_HEADERS);
  if (t.missing) return { ok: false, status: 'not_inited' };
  if (t.mismatch) return { ok: false, status: 'header_mismatch' };
  return { ok: true, status: 'ok', rows: t.rows };
}

/** 某同仁物件（unit／title／p_*）的旗標集合 → 'flag|submitted' 字串陣列 */
function stf2610FlagKeys_(o, org) {
  return stfFlagDetails_(o, org).map(function (f) { return f.flag + '|' + (f.submitted ? 1 : 0); });
}

/** 升級計畫（唯讀）：org 要改的格／新增列、同仁職稱改動、perm_map 要補的規則、新出現與消失的名單旗標 */
function stf2610Plan_() {
  var work = stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length).map(function (r) { return r.slice(); });
  var curOrg = stfBuildOrg_(work.map(function (r) { return r.slice(); }));
  var report = [], cells = [], addRows = [];
  var find = function (kind, code) {
    for (var i = 0; i < work.length; i++) if (stfStr_(work[i][STF_ORG_COL.kind]) === kind && stfStr_(work[i][STF_ORG_COL.code]) === code) return i;
    return -1;
  };
  var setCell = function (i, field, to) {
    var idx = STF_ORG_COL[field];
    var from = stfNormCell_(work[i][idx], idx);
    if (from === stfNormCell_(to, idx)) return;
    report.push({ kind: stfStr_(work[i][STF_ORG_COL.kind]), code: stfStr_(work[i][STF_ORG_COL.code]), field: field, from: from, to: String(to) });
    work[i][idx] = to;
    cells.push({ row: i + 2, col: idx + 1, value: to });
  };
  var addRow = function (row) {
    work.push(row.slice());
    addRows.push(row.slice());
    report.push({ kind: row[0], code: row[1], field: 'row', from: '', to: 'added' });
  };
  if (find('title', 'am') === -1) addRow(STF_2610_AM_ROW);
  STF_2610_TITLE_SET.forEach(function (x) { var i = find('title', x[0]); if (i !== -1) setCell(i, x[1], x[2]); });
  STF_2610_ADD.forEach(function (row) {
    var i = find(row[0], row[1]);
    if (i === -1) addRow(row);
    else STF_UPGRADE_ADD_FIELDS.forEach(function (f) { setCell(i, f, row[STF_ORG_COL[f]]); });
  });
  var newOrg = stfBuildOrg_(work);

  // 同仁：中央工廠的店長 → 廠長（目前職稱；送出待審的職稱看「送出的單位，沒填就目前單位」）
  var M = STF_2610_STAFF_MAP;
  var staff = [], todo = [], resolved = [];
  var nm = function (o, code) { return o.title[code] ? o.title[code].name : code; };
  stfAllRows_().forEach(function (r) {
    var v = r.values;
    var emp = stfStr_(v[STF_COL.emp_no]), name = stfStr_(v[STF_COL.name]);
    var o = { status: stfStr_(v[STF_COL.status]), unit: stfStr_(v[STF_COL.unit]), title: stfStr_(v[STF_COL.title]), dept: stfStr_(v[STF_COL.dept]),
      p_unit: stfStr_(v[STF_COL.p_unit]), p_title: stfStr_(v[STF_COL.p_title]), p_dept: stfStr_(v[STF_COL.p_dept]) };
    var after = JSON.parse(JSON.stringify(o));
    if (o.unit === M.unit && o.title === M.from) {
      after.title = M.to;
      staff.push({ emp_no: emp, name: name, field: 'title', from: M.from, to: M.to, row: r.row });
    }
    if (o.p_title === M.from && (o.p_unit || o.unit) === M.unit) {
      after.p_title = M.to;
      staff.push({ emp_no: emp, name: name, field: 'p_title', from: M.from, to: M.to, row: r.row });
    }
    // 名單旗標前後比對：新出現的（例如還掛品牌辦公室區經理 oam 的人）列 todo，消失的（例如舊的門市區經理 am 變合規）列 resolved
    var b = stf2610FlagKeys_(o, curOrg), a = stf2610FlagKeys_(after, newOrg);
    var unitName = function (k) { var uc = k.split('|')[1] === '1' && o.p_unit ? o.p_unit : o.unit; return newOrg.unit[uc] ? newOrg.unit[uc].name : uc; };
    a.filter(function (k) { return b.indexOf(k) === -1; }).forEach(function (k) {
      todo.push({ emp_no: emp, name: name, unit_name: unitName(k), flag: k.split('|')[0], submitted: k.split('|')[1] === '1', title: k.split('|')[1] === '1' ? o.p_title : o.title });
    });
    b.filter(function (k) { return a.indexOf(k) === -1; }).forEach(function (k) {
      resolved.push({ emp_no: emp, name: name, unit_name: unitName(k), flag: k.split('|')[0], submitted: k.split('|')[1] === '1' });
    });
  });
  staff.forEach(function (x) { x.from_name = nm(curOrg, x.from); x.to_name = nm(newOrg, x.to); });

  // perm_map：店長 sm 的現行（active）規則複製給 am／fm／rdd（同一條已有 active 的就不補）
  var perm = { status: 'ok', add: [] };
  var pt = stf2610PermTable_();
  if (!pt.ok) {
    perm.status = pt.status;
  } else {
    var activeKey = {};
    var srcRules = [];
    pt.rows.forEach(function (r) {
      if (!permIsActive_(r[5])) return;
      var rule = { rule_id: permStr_(r[0]), ladder: permStr_(r[1]), dept: permStr_(r[2]), title: permStr_(r[3]), perm: permStr_(r[4]) };
      activeKey[[rule.ladder, rule.dept, rule.title, rule.perm].join('|')] = true;
      if (rule.ladder === 'store' && rule.title === STF_2610_PERM_FROM) srcRules.push(rule);
    });
    srcRules.forEach(function (src) {
      STF_2610_PERM_TO.forEach(function (t) {
        var k = ['store', src.dept, t, src.perm].join('|');
        if (activeKey[k]) return;
        activeKey[k] = true;
        perm.add.push({ ladder: 'store', dept: src.dept, title: t, perm: src.perm, from_rule: src.rule_id });
      });
    });
  }
  return { report: report, cells: cells, addRows: addRows, newOrg: newOrg, staff: staff, perm: perm, todo: todo, resolved: resolved };
}

function handleOrgUpgrade202610_(token, payload) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  var problem = stfOrgSheetProblem_();
  if (problem) return { ok: false, error: problem };
  var dry = !!(payload && payload.dryrun === true);
  var state = stf2610GetState_();
  if (state) {
    var lost = stfLostBackups_({ org_bak: state.org_bak, stf_bak: state.stf_bak });
    if (lost.length) return { ok: false, error: '已有職稱調整紀錄，但備份分頁不見了或被清空：' + lost.join('、') + '。為避免之後退回沒有東西可還原，停止升級，請先處理' };
  }
  var pt0 = stf2610PermTable_();
  if (pt0.status === 'header_mismatch') return { ok: false, error: '分頁「perm_map」的表頭與程式不一致，停止升級以免資料錯位' };
  var plan = stf2610Plan_();
  var backupExists = !!(state && stfSheet_(state.org_bak));
  var data = {
    dryrun: dry,
    backup: backupExists ? 'exists' : 'created',
    org: plan.report,
    staff: plan.staff.map(function (x) { return { emp_no: x.emp_no, name: x.name, field: x.field, from: x.from, to: x.to, from_name: x.from_name, to_name: x.to_name }; }),
    perm: { status: plan.perm.status, add: plan.perm.add.map(function (x) { return { ladder: x.ladder, dept: x.dept, title: x.title, perm: x.perm, from_rule: x.from_rule }; }) },
    todo: plan.todo,
    resolved: plan.resolved
  };
  if (dry) return { ok: true, data: data };

  var by = String(auth.user.id);
  // ① 備份（已有就不覆蓋）：org 整份；受影響同仁「欄位、原值、新值」
  if (!backupExists) {
    var nm = stf2610PickNames_();
    state = { at: stfNowText_(), by: by, org_bak: nm.org_bak, stf_bak: nm.stf_bak, org_snap: nm.org_snap, org_hash: '', perm_added: [] };
    stfCopyToNewSheet_(stfSheet_(STF_SHEET_ORG), state.org_bak, STF_ORG_HEADERS.length);
    stfPutBlock_(SpreadsheetApp.getActive().insertSheet(state.stf_bak), [STF_2610_BAK_HEAD], STF_2610_BAK_HEAD.length);
    stf2610SetState_(state);
  }
  var bakSheet = stfSheet_(state.stf_bak) || SpreadsheetApp.getActive().insertSheet(state.stf_bak);
  var bakVals = stfSheetValues_(bakSheet, STF_2610_BAK_HEAD.length);
  if (!bakVals.length) bakVals = [STF_2610_BAK_HEAD];
  var have = {};
  bakVals.slice(1).forEach(function (r) { have[stfNormEmp_(r[0]) + '|' + stfStr_(r[1])] = true; });
  var newBak = plan.staff.filter(function (x) { return !have[stfNormEmp_(x.emp_no) + '|' + x.field]; });
  if (newBak.length) {
    newBak.forEach(function (x) { bakVals.push([x.emp_no, x.field, x.from, x.to]); });
    stfPutBlock_(bakSheet, bakVals, STF_2610_BAK_HEAD.length);
  }
  // ② org 列（只寫要改的格；新列一次寫完）
  var osh = stfSheet_(STF_SHEET_ORG);
  plan.cells.forEach(function (c) { osh.getRange(c.row, c.col, 1, 1).setValue(c.value); });
  if (plan.addRows.length) stfAppendBlock_(STF_SHEET_ORG, plan.addRows, STF_ORG_HEADERS.length, false);
  // ③ 同仁職稱（只改「目前仍是原值」的格，只寫那一格；不碰打卡對照：單位沒變，clkAfterConfirm_ 不需要）
  plan.staff.forEach(function (x) {
    var cur = stfFindByEmp_(x.emp_no);
    if (!cur || stfStr_(cur.values[STF_COL[x.field]]) !== x.from) return;
    stfSheet_(STF_SHEET).getRange(cur.row, STF_COL[x.field] + 1, 1, 1).setValue(x.to);
    stfLog_(x.emp_no, 'org_upgrade_2610', by, x.field + ':' + x.from + '>' + x.to);
  });
  // ④ perm_map 補規則（流水號接最大號；記下編號給退回用）
  if (plan.perm.status === 'ok' && plan.perm.add.length) {
    var pt = stf2610PermTable_();
    var next = permAcNextId_(pt.rows, 'R');
    var now = permNowText_();
    var ids = [];
    var prow = plan.perm.add.map(function (x) { var id = next(); ids.push(id); return [id, x.ladder, x.dept, x.title, x.perm, 'TRUE', now, by]; });
    var psh = SpreadsheetApp.getActive().getSheetByName(PERM_SHEET_MAP);
    psh.getRange(psh.getLastRow() + 1, 1, prow.length, PERM_MAP_HEADERS.length).setValues(prow);
    stfLog_('', 'perm_map_seed', by, 'orgUpgrade202610:' + ids.join(','));
    state.perm_added = (state.perm_added || []).concat(ids);
    stf2610SetState_(state);
  }
  // ⑤ 後置條件：重算計畫，org／同仁／perm_map 都不該再有差異
  var after = stf2610Plan_();
  if (after.cells.length || after.addRows.length || after.staff.length || after.perm.add.length) {
    return { ok: false, error: '職稱調整後驗證失敗（資料與目標不一致），請檢查後重跑；原始資料可用 orgRollback202610 還原' };
  }
  // ⑥ 「升級後」雜湊與快照只在首次成功時建立（重跑不把之後別人的修改洗進基準）
  if (!state.org_hash) {
    state.org_hash = stfOrgHash_();
    var snapSheet = stfSheet_(state.org_snap) || SpreadsheetApp.getActive().insertSheet(state.org_snap);
    stfPutBlock_(snapSheet, [STF_ORG_HEADERS].concat(stfOrgSnapshot_()), STF_ORG_HEADERS.length);
    state.upgraded_at = stfNowText_();
    stf2610SetState_(state);
  }
  return { ok: true, data: data };
}

/**
 * 退回：org 整份蓋回備份、受影響同仁的 title／p_title 還原、這次補的 perm_map 規則停用（active＝FALSE，與 permMapSave 刪除同做法）。
 * 寫入前全部先檢查：org 切換後被改過（雜湊不符且不等於備份）、或任一受影響同仁那一格既不是新值也不是原值 → 拒絕，什麼都不改。
 */
function handleOrgRollback202610_(token) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  var state = stf2610GetState_();
  if (!state) return { ok: false, error: '找不到職稱調整紀錄，沒有可退回的備份' };
  var bak = stfSheet_(state.org_bak);
  var sbak = stfSheet_(state.stf_bak);
  if (!bak || !sbak) return { ok: false, error: '找不到備份 ' + (!bak ? state.org_bak : state.stf_bak) + '，為避免半套退回，什麼都沒有改' };
  var osh = stfSheet_(STF_SHEET_ORG);
  if (!osh || !stfSheet_(STF_SHEET)) return { ok: false, error: '找不到 org 或 staff 分頁' };
  var emptied = stfLostBackups_({ org_bak: state.org_bak, stf_bak: state.stf_bak });
  if (emptied.length) return { ok: false, error: '備份分頁被清空了：' + emptied.join('、') + '，為避免半套退回，什麼都沒有改' };

  // ① org：已等於備份＝已完成；否則雜湊不符＝切換後被改過 → 拒絕
  var bakOrgRows = stfNormOrgRows_(stfSheetValues_(bak, STF_ORG_HEADERS.length));
  var orgDone = stfSameRows_(stfOrgSnapshot_(), bakOrgRows);
  var orgBad = !orgDone && !!state.org_hash && stfOrgHash_() !== state.org_hash;
  // ② 同仁：每一格要嘛還是新值（要還原）、要嘛已是原值（已還原），其他＝被改過 → 拒絕
  var todoStaff = [], staffDiff = [];
  stfSheetValues_(sbak, STF_2610_BAK_HEAD.length).slice(1).forEach(function (r) {
    var emp = stfStr_(r[0]), field = stfStr_(r[1]);
    if (!emp || !STF_COL.hasOwnProperty(field)) return;
    var cur = stfFindByEmp_(emp);
    var now = cur ? stfStr_(cur.values[STF_COL[field]]) : '';
    if (cur && now === stfStr_(r[3])) todoStaff.push({ row: cur.row, emp: emp, field: field, from: now, to: stfStr_(r[2]) });
    else if (!cur || now !== stfStr_(r[2])) staffDiff.push({ emp_no: emp, field: field, expected: stfStr_(r[3]), actual: cur ? now : '（找不到這位同仁）' });
  });
  if (orgBad || staffDiff.length) {
    if (orgBad && !stfSheet_(state.org_snap)) return { ok: false, error: '找不到切換後快照，無法比對差異；請先確認組織表沒被改過' };
    var out = {};
    if (orgBad) out.diff = stfOrgDiffVsSnap_(state.org_snap);
    if (staffDiff.length) out.staff_diff = staffDiff;
    return { ok: false, error: '職稱調整後' + (orgBad ? '組織資料' : '') + (orgBad && staffDiff.length ? '和' : '') + (staffDiff.length ? '同仁職稱' : '') + '又被改過，為避免蓋掉新的修改，拒絕退回；差異已列出', data: out };
  }
  var by = String(auth.user.id);
  // ③ 同仁職稱還原（只寫那一格）
  todoStaff.forEach(function (x) {
    stfSheet_(STF_SHEET).getRange(x.row, STF_COL[x.field] + 1, 1, 1).setValue(x.to);
    stfLog_(x.emp, 'org_rollback_2610', by, x.field + ':' + x.from + '>' + x.to);
  });
  // ④ org 整份蓋回（已等於備份就略過）
  var bakVals = stfSheetValues_(bak, STF_ORG_HEADERS.length);
  var restored = orgDone ? bakVals.length - 1 : stfPutBlock_(osh, bakVals, STF_ORG_HEADERS.length) - 1;
  // ⑤ 這次補的 perm_map 規則停用（找不到或已停用的略過）
  var permOff = [];
  var ids = state.perm_added || [];
  if (ids.length) {
    var pt = stf2610PermTable_();
    if (pt.ok) {
      var psh = SpreadsheetApp.getActive().getSheetByName(PERM_SHEET_MAP);
      var now = permNowText_();
      pt.rows.forEach(function (r, i) {
        if (ids.indexOf(permStr_(r[0])) === -1 || !permIsActive_(r[5])) return;
        psh.getRange(i + 2, 6).setValue('FALSE');
        psh.getRange(i + 2, 7, 1, 2).setValues([[now, by]]);
        permOff.push(permStr_(r[0]));
      });
      if (permOff.length) stfLog_('', 'perm_map_save', by, 'orgRollback202610:' + permOff.map(function (x) { return '-' + x; }).join(';'));
    }
  }
  // ⑥ 退回後職稱不合規的人（切換後才被設成廠長／廚藝總監、或門市區經理）：只列不改
  var org = stfReadOrg_();
  var orphans = [];
  stfAllRows_().forEach(function (r) {
    var v = r.values;
    if (stfStr_(v[STF_COL.status]) === 'disabled') return;
    var t = stfStr_(v[STF_COL.title]), p = stfStr_(v[STF_COL.p_title]);
    var watch = ['am', 'fm', 'rdd'];
    if (watch.indexOf(t) === -1 && watch.indexOf(p) === -1) return;
    var fl = stfFlagDetails_({ status: stfStr_(v[STF_COL.status]), unit: stfStr_(v[STF_COL.unit]), title: t, dept: stfStr_(v[STF_COL.dept]),
      p_unit: stfStr_(v[STF_COL.p_unit]), p_title: p, p_dept: stfStr_(v[STF_COL.p_dept]) }, org);
    if (fl.some(function (f) { return f.flag === 'title_ladder'; })) {
      orphans.push({ emp_no: stfStr_(v[STF_COL.emp_no]), name: stfStr_(v[STF_COL.name]), unit: stfStr_(v[STF_COL.unit]), title: t, p_title: p });
    }
  });
  stf2610SetState_(null);   // 備份分頁保留
  return { ok: true, data: { restored: restored, staff_restored: todoStaff.length, perm_disabled: permOff, orphans: orphans, backup: state.org_bak } };
}

// ============================================================
// 12. 2026-10-23 名稱調整一次性改名／退回（docs/org/spec.md 第 16 節；只有 role admin）
//   只改 org 分頁四列的「名稱」那一格＋roles 分頁一列的中文名（顯示用；代碼、職級、審核、權限全都不動）：
//   加盟招商部 franchise → 加盟部、部門主管 hm → 總監、研發總監 rdd → 廚藝總監、品牌 中央工廠 ck → 研發部（單位名稱不動）、
//   系統角色 manager 部門主管 → 總監（roles 分頁 name_zh；2026-10-24 追加）。
//   不另建備份：舊名、新名就是下面的常數；每列「現在＝舊名才改、已是新名就略過、其他一律整批拒絕」，所以重跑安全、
//   退回只還原「現在還是新名」的格子（被人改成別的就拒絕）。
// ============================================================

var STF_2610N_RENAMES = [
  { kind: 'dept', code: 'franchise', from: '加盟招商部', to: '加盟部' },
  { kind: 'title', code: 'hm', from: '部門主管', to: '總監' },
  { kind: 'title', code: 'rdd', from: '研發總監', to: '廚藝總監' },
  { kind: 'brand', code: 'ck', from: '中央工廠', to: '研發部' },       // Eason 2026-10-23 追加：品牌欄改叫研發部，單位仍是「中央工廠（央廚）」
  { kind: 'role', sheet: 'roles', code: 'manager', from: '部門主管', to: '總監' }   // Eason 2026-10-24 追加：人員管理的系統角色 manager（roles 分頁 B 欄）
];

/** 計畫（唯讀）。dir＝'apply'（舊→新）或 'rollback'（新→舊）。回 { changes, skipped, bad }；bad 非空＝整批拒絕 */
function stf2610nPlan_(dir) {
  var rows = stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length);
  var roleRows = null;   // roles 分頁（A role、B name_zh），有 sheet: 'roles' 的項目才讀
  var changes = [], skipped = [], bad = [];
  STF_2610N_RENAMES.forEach(function (x) {
    var want = dir === 'apply' ? x.to : x.from;     // 做完之後的名稱
    var expect = dir === 'apply' ? x.from : x.to;   // 這次動手前應有的名稱
    var isRole = x.sheet === 'roles';
    if (isRole && !roleRows) roleRows = stfReadRows_(USR_SHEET_ROLES, 2);
    var src = isRole ? roleRows : rows, nameCol = isRole ? 1 : STF_ORG_COL.name;
    var idx = -1;
    for (var i = 0; i < src.length; i++) {
      if (isRole ? stfStr_(src[i][0]) === x.code : (stfStr_(src[i][STF_ORG_COL.kind]) === x.kind && stfStr_(src[i][STF_ORG_COL.code]) === x.code)) { idx = i; break; }
    }
    if (idx === -1 && isRole) { skipped.push({ kind: x.kind, code: x.code, name: '（沒有這個角色，不用改）' }); return; }   // 系統角色沒建就略過，不擋其他名稱
    if (idx === -1) { bad.push({ kind: x.kind, code: x.code, expected: expect, actual: '（找不到這一列）' }); return; }
    var cur = stfStr_(src[idx][nameCol]);
    if (cur === expect) changes.push({ kind: x.kind, code: x.code, from: cur, to: want, row: idx + 2, sheet: isRole ? USR_SHEET_ROLES : STF_SHEET_ORG, col: nameCol + 1 });
    else if (cur === want) skipped.push({ kind: x.kind, code: x.code, name: cur });
    else bad.push({ kind: x.kind, code: x.code, expected: expect, actual: cur });
  });
  return { changes: changes, skipped: skipped, bad: bad };
}

function stf2610nRun_(token, payload, dir) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  var problem = stfOrgSheetProblem_();
  if (problem) return { ok: false, error: problem };
  var dry = !!(payload && payload.dryrun === true);
  var plan = stf2610nPlan_(dir);
  var label = dir === 'apply' ? '名稱調整' : '退回名稱調整';
  if (plan.bad.length) {
    return { ok: false, error: label + '：下列名稱不是預期的值（可能被改過），為避免蓋掉別人的修改，整批拒絕、什麼都沒有改', data: { bad: plan.bad } };
  }
  var data = { dryrun: dry, changes: plan.changes.map(function (c) { return { kind: c.kind, code: c.code, from: c.from, to: c.to }; }), skipped: plan.skipped };
  if (dry) return { ok: true, data: data };
  var by = String(auth.user.id);
  plan.changes.forEach(function (c) {
    stfSheet_(c.sheet).getRange(c.row, c.col, 1, 1).setValue(c.to);   // 只寫名稱那一格（org 的 name、roles 的 name_zh）
    stfLog_('', dir === 'apply' ? 'org_rename_2610' : 'org_rename_2610_rollback', by, c.kind + ':' + c.code + ':' + c.from + '>' + c.to);
  });
  // 後置條件：重算同方向計畫，不該再有要改的格
  var after = stf2610nPlan_(dir);
  if (after.changes.length || after.bad.length) return { ok: false, error: label + '後驗證失敗（資料與目標不一致），請檢查 org 分頁後重跑' };
  return { ok: true, data: data };
}

function handleOrgRename202610_(token, payload) { return stf2610nRun_(token, payload, 'apply'); }
function handleOrgRenameRollback202610_(token, payload) { return stf2610nRun_(token, payload, 'rollback'); }

// ============================================================
// 13. 2026-10-23 新增品牌發展部一次性新增／退回（docs/org/spec.md 第 17 節；只有 role admin）
//   鼎兆元總部 dzy-hq 新增部門 branddev「品牌發展部」，order＝現有部門最大值＋1、啟用；像一般總部部門，沒有特例。
//   apply：沒有 branddev 列→新增；已有同名同父層且啟用→略過（冪等）；已有同名同父層但停用（退回造成）→重新啟用；
//          其他（名稱／父層不同）→整批拒絕並列出。
//   rollback：branddev 列設為停用（不刪列）；只有「沒有任何同仁」才行：dept／p_dept／extra_depts 任一含 branddev 就拒絕，
//             只列 emp_no（不列姓名）；沒有列或已停用→略過；名稱／父層不同→拒絕。
//   寫 staff_log（org_add_branddev_2610／org_add_branddev_2610_rollback）；不另建備份。
// ============================================================

var STF_2610B = { code: 'branddev', name: '品牌發展部', parent: 'dzy-hq' };

function stf2610bIsTrue_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase() === 'TRUE'; }

/** 計畫（唯讀）。回 { action: 'add'|'reactivate'|'deactivate'|'skip', row, order, bad, members } */
function stf2610bPlan_(dir) {
  var rows = stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length);
  var idx = -1, maxOrder = 0, i;
  for (i = 0; i < rows.length; i++) {
    if (stfStr_(rows[i][STF_ORG_COL.kind]) !== 'dept') continue;
    var od = Number(rows[i][STF_ORG_COL.order]);
    if (isFinite(od) && od > maxOrder) maxOrder = od;
    if (stfStr_(rows[i][STF_ORG_COL.code]) === STF_2610B.code && idx === -1) idx = i;
  }
  var plan = { action: 'skip', row: 0, order: maxOrder + 1, bad: [], members: [] };
  if (idx === -1) {
    if (dir === 'apply') plan.action = 'add';
    return plan;
  }
  var r = rows[idx];
  var name = stfStr_(r[STF_ORG_COL.name]), parent = stfStr_(r[STF_ORG_COL.parent]);
  var active = stf2610bIsTrue_(r[STF_ORG_COL.active]);
  plan.row = idx + 2;
  if (name !== STF_2610B.name || parent !== STF_2610B.parent) {
    plan.bad.push({ kind: 'dept', code: STF_2610B.code, expected: STF_2610B.name + '／' + STF_2610B.parent, actual: name + '／' + parent });
    return plan;
  }
  if (dir === 'apply') { plan.action = active ? 'skip' : 'reactivate'; return plan; }
  if (!active) return plan;   // rollback：已停用
  var extra = stfReadExtraMap_();
  stfAllRows_().forEach(function (x) {
    var v = x.values, emp = stfStr_(v[STF_COL.emp_no]);
    var hit = stfStr_(v[STF_COL.dept]) === STF_2610B.code || stfStr_(v[STF_COL.p_dept]) === STF_2610B.code
      || stfSplitCodes_(extra[stfNormEmp_(emp)]).indexOf(STF_2610B.code) !== -1;
    if (hit) plan.members.push(emp);
  });
  plan.action = 'deactivate';
  return plan;
}

function stf2610bRun_(token, payload, dir) {
  var auth = stfRequireAdmin_(token);
  if (!auth.ok) return auth;
  var problem = stfOrgSheetProblem_();
  if (problem) return { ok: false, error: problem };
  var dry = !!(payload && payload.dryrun === true);
  var plan = stf2610bPlan_(dir);
  var label = dir === 'apply' ? '新增品牌發展部' : '退回品牌發展部';
  if (plan.bad.length) {
    return { ok: false, error: label + '：組織表已有 branddev 但名稱或父層不是預期的值（可能被改過），為避免蓋掉別人的修改，什麼都沒有改', data: { bad: plan.bad } };
  }
  if (plan.members.length) {
    return { ok: false, error: label + '：還有同仁的部門（主要、送出待審或兼任）是品牌發展部，請先改掉他們的部門再退回', data: { members: plan.members } };
  }
  var data = { dryrun: dry, action: plan.action, dept: { code: STF_2610B.code, name: STF_2610B.name, parent: STF_2610B.parent, order: plan.order } };
  if (dry || plan.action === 'skip') return { ok: true, data: data };
  var by = String(auth.user.id);
  var osh = stfSheet_(STF_SHEET_ORG);
  if (plan.action === 'add') {
    osh.getRange(osh.getLastRow() + 1, 1, 1, STF_ORG_HEADERS.length)
      .setValues([['dept', STF_2610B.code, STF_2610B.name, STF_2610B.parent, '', '', plan.order, 'TRUE']]);
    stfLog_('', 'org_add_branddev_2610', by, 'dept:branddev:add:order=' + plan.order);
  } else {
    var on = plan.action === 'reactivate';
    osh.getRange(plan.row, STF_ORG_COL.active + 1, 1, 1).setValue(on ? 'TRUE' : 'FALSE');   // 只寫啟用那一格
    stfLog_('', on ? 'org_add_branddev_2610' : 'org_add_branddev_2610_rollback', by, 'dept:branddev:' + (on ? 'reactivate' : 'deactivate'));
  }
  // 後置條件：重算同方向計畫，不該再有要做的事
  var after = stf2610bPlan_(dir);
  if (after.action !== 'skip' || after.bad.length) return { ok: false, error: label + '後驗證失敗（資料與目標不一致），請檢查 org 分頁後重跑' };
  return { ok: true, data: data };
}

function handleOrgAddBranddev202610_(token, payload) { return stf2610bRun_(token, payload, 'apply'); }
function handleOrgAddBranddevRollback202610_(token, payload) { return stf2610bRun_(token, payload, 'rollback'); }
