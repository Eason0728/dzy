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

// 門檻（§6.4）：store 職級 rank≥3（店長）、hq 職級 rank≥2（部門主管）可看單位通訊錄
var STF_UNIT_VIEW_MIN_RANK = { store: 3, hq: 2 };

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
  UNIT_ONLY_MANAGER: '只有店長（總部為部門主管）以上可以看單位通訊錄',
  NEED_CURRENT_PW: '改手機要輸入目前的密碼',
  PW_TOO_LONG: '密碼最多 128 個字元',
  NAME_TOO_LONG: '姓名最多 30 個字',
  // 認領後主管審核（Eason 2026-10-12）
  CLAIM_PENDING: '這個名字已經送出開通申請，等單位主管審核通過就能用編號登入',
  LOGIN_PENDING: '帳號還在等主管審核',
  LOGIN_REJECTED: '帳號資料被退回，請找人資重新開通',
  NOT_REVIEWER: '只有單位主管可以審核',
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
  return sh.getRange(2, 1, last - 1, colCount).getValues();
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
  var rows = stfReadRows_(STF_SHEET_ORG, STF_ORG_HEADERS.length);
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
  return org;
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
  var t = org.title[v.title];
  if (!t || !t.active || t.parent !== (u.ladder || 'store')) return '請選擇這個單位適用的職稱';
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
      titles: pick('title', ['parent', 'rank'])
    }
  };
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
  var people = stfAllRows_().map(function (r) { return stfToObj_(r.values, org, false); }).filter(function (p) {
    return p.status === 'active' && p.unit === scope.unit && (!scope.sameDept || p.dept === scope.dept);
  }).map(function (p) {
    return { emp_no: p.emp_no, name: p.name, title: p.title, title_name: p.title_name, phone: p.phone };
  });
  return { ok: true, data: { unit_name: scope.unit_name, people: people } };
}

/**
 * 單位主管的範圍（§6.4 單位通訊錄與 §6.8 認領審核共用同一套判斷）：
 * status＝active、職級達門檻（store rank≥3 店長；hq rank≥2 部門主管）才回
 * {unit, unit_name, dept, sameDept}；總部單位且本人有部門時 sameDept＝true（只管同單位同部門）。
 * 不夠格回 null；總部單位有 active 部門但本人部門空白也回 null（不放大成全總部）。
 */
function stfManagerScope_(values, org) {
  if (stfStr_(values[STF_COL.status]) !== 'active') return null;
  var unitCode = stfStr_(values[STF_COL.unit]);
  var unit = org.unit[unitCode];
  var title = org.title[stfStr_(values[STF_COL.title])];
  var ladder = unit ? (unit.ladder || 'store') : 'store';
  if (!title || title.rank < (STF_UNIT_VIEW_MIN_RANK[ladder] || 99)) return null;
  var dept = stfStr_(values[STF_COL.dept]);
  // GPT 複審第 4 條（2026-10-12）：總部單位底下有 active 部門、本人部門卻空白 → 不具資格（往拒絕方向）。
  // 否則 sameDept＝false 會讓他看得到／審得到整個總部所有部門（通訊錄 myUnit 與認領審核共用這裡）。
  if (ladder === 'hq' && dept === '' && stfActiveDeptsOf_(org, unitCode).length) return null;
  return { unit: unitCode, unit_name: unit ? unit.name : '', dept: dept, sameDept: ladder === 'hq' && dept !== '' };
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
  return { review: !!stfManagerScope_(hit.values, stfReadOrg_()) };
}

/** 審核者：platform.staff（人資／admin）一律可審；否則要是單位主管（stfManagerScope_） */
function stfReviewer_(token) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  var org = stfReadOrg_();
  var isHr = hasPerm_(me.data.perms, 'platform.staff');
  var scope = null;
  if (hasPerm_(me.data.perms, 'platform.self')) {
    var hit = stfFindByUserId_(me.data.user.id);
    if (hit) scope = stfManagerScope_(hit.values, org);
  }
  if (!isHr && !scope) return { ok: false, error: STF_MSG.NOT_REVIEWER };
  return { ok: true, user: me.data.user, isHr: isHr, scope: scope, org: org };
}

/** 這一列是不是「這位審核者可以審的認領待審」（不含自己；主管只看填的單位／部門＝自己的） */
function stfCanReviewRow_(rv, values) {
  if (stfStr_(values[STF_COL.status]) !== 'pending') return false;
  if (stfStr_(values[STF_COL.user_id]) === String(rv.user.id)) return false;
  if (rv.isHr) return true;
  var s = rv.scope;
  if (!s || stfStr_(values[STF_COL.p_unit]) !== s.unit) return false;
  if (s.sameDept && stfStr_(values[STF_COL.p_dept]) !== s.dept) return false;
  return true;
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
  t.v[STF_COL.updated_at] = stfNowText_();
  stfWriteRow_(STF_SHEET, t.hit.row, t.v, STF_COL_COUNT);
  stfLog_(t.emp, 'confirm', t.rv.user.id, 'unit_review');
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
  // 上線第一次由後台打開名單時自動建分頁（只補不覆蓋，見 setupStaff），不必進 Apps Script 編輯器手動跑
  if (!stfSheetsReady_()) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return { ok: false, error: '系統忙碌中，請稍後再試' };
    try { setupStaff(); } finally { lock.releaseLock(); }
  }
  var org = stfReadOrg_();
  var list = stfAllRows_().map(function (r) { return stfToObj_(r.values, org, true); });
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
  return { ok: true, data: { staff: stfToObj_(t.v, stfReadOrg_(), true) } };
}

function handleStaffConfirm_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  var hasP = STF_ORG_FIELDS.some(function (f) { return stfStr_(t.v[STF_COL['p_' + f]]) !== ''; });
  if (!(t.status === 'pending' || (t.status === 'active' && hasP))) return { ok: false, error: STF_MSG.NO_PENDING };
  var oldUnit = stfStr_(t.v[STF_COL.unit]);
  var err = stfApplyConfirm_(t.v, stfReadOrg_());
  if (err) return { ok: false, error: err };
  var saved = stfSave_(t, 'confirm', '');
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
    usersSheet.getRange(userRow.row, USR_COL.active + 1).setValue('FALSE');
    setTokenAfter_(userRow.row);
    var saved = stfSave_(t, 'disable', '');
    // 員工名單統一：舊「停用」按鈕只停平台帳號——同時對他每個打卡對照發停用單（StaffClock.gs）
    if (typeof clkAfterDisable_ === 'function') clkAfterDisable_(t.emp, t.auth.user.id);
    return saved;
  }
  if (t.status !== 'disabled') return { ok: false, error: STF_MSG.BAD_STATE };
  var prev = stfStr_(t.v[STF_COL.prev_status]);
  t.v[STF_COL.status] = STF_STATUSES.indexOf(prev) !== -1 && prev !== 'disabled' ? prev : 'pending';
  t.v[STF_COL.prev_status] = '';
  usersSheet.getRange(userRow.row, USR_COL.active + 1).setValue('TRUE');
  return stfSave_(t, 'enable', '');
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
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  payload = payload || {};
  var changed = [];
  var org = stfReadOrg_();
  var oldUnitForClock = stfStr_(t.v[STF_COL.unit]);

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
    var oe = stfValidateOrg_(org, o);
    if (oe) return { ok: false, error: oe };
    STF_ORG_FIELDS.forEach(function (f) { t.v[STF_COL[f]] = o[f]; });
    changed.push('org');
  }
  if (!changed.length) return { ok: false, error: '沒有要改的欄位' };
  if (changed.indexOf('name') !== -1) {
    var userRow = findUsrRowById_(stfStr_(t.v[STF_COL.user_id]));
    if (userRow) stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.name + 1).setValue(authSafeCell_(t.v[STF_COL.name]));
  }
  var savedEdit = stfSave_(t, 'admin_edit', '改了：' + changed.join(','));
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
  ['brand', 'ck', '央廚', '', '', '', 4, 'TRUE'],
  ['brand', 'dzy', '鼎兆元總部', '', '', '', 5, 'TRUE'],
  ['unit', 'mzt-js', '新竹金山', 'mzt', 'store', '', 1, 'TRUE'],
  ['unit', 'mzt-gf', '新竹光復', 'mzt', 'store', '', 2, 'TRUE'],
  ['unit', 'mzt-lzl', '台北六張犁', 'mzt', 'store', '', 3, 'TRUE'],
  ['unit', 'mzt-wx', '台中文心', 'mzt', 'store', '', 4, 'TRUE'],
  ['unit', 'mzt-rg', '內湖瑞光', 'mzt', 'store', '', 5, 'TRUE'],
  ['unit', 'mzt-mc', '台中美村', 'mzt', 'store', '', 6, 'TRUE'],
  ['unit', 'mzt-hq', '墨竹亭總部', 'mzt', 'hq', '', 7, 'TRUE'],
  ['unit', 'mala-gf', '新竹光復', 'mala', 'store', '', 1, 'TRUE'],
  ['unit', 'mala-hq', '小辛辣總部', 'mala', 'hq', '', 2, 'TRUE'],
  ['unit', 'yiwu-js', '新竹金山', 'yiwu', 'store', '', 1, 'TRUE'],
  ['unit', 'yiwu-wx', '竹北文興', 'yiwu', 'store', '', 2, 'TRUE'],
  ['unit', 'ck', '央廚', 'ck', 'store', '', 1, 'TRUE'],
  ['unit', 'dzy-hq', '鼎兆元總部', 'dzy', 'hq', '', 1, 'TRUE'],
  ['title', 'pt', '計時同仁', 'store', '', 1, 1, 'TRUE'],
  ['title', 'ft', '正職同仁', 'store', '', 2, 2, 'TRUE'],
  ['title', 'sm', '店長', 'store', '', 3, 3, 'TRUE'],
  ['title', 'am', '區經理', 'store', '', 4, 4, 'TRUE'],
  ['title', 'sv', '督導', 'store', '', 5, 5, 'TRUE'],
  ['title', 'bd', '品牌總監', 'store', '', 6, 6, 'TRUE'],
  ['title', 'hs', '部門同仁', 'hq', '', 1, 1, 'TRUE'],
  ['title', 'hm', '部門主管', 'hq', '', 2, 2, 'TRUE'],
  ['title', 'ceo', '執行長', 'hq', '', 3, 3, 'TRUE'],
  ['title', 'gm', '總經理', 'hq', '', 4, 4, 'TRUE'],
  ['title', 'chair', '董事長', 'hq', '', 5, 5, 'TRUE'],
  // 部門只掛在鼎兆元總部（Eason 2026-10-11）；墨竹亭總部、小辛辣總部沒有部門，同仁不必選
  ['dept', 'fin', '財務部', 'dzy-hq', '', '', 1, 'TRUE'],
  ['dept', 'hr', '人資部', 'dzy-hq', '', '', 2, 'TRUE'],
  ['dept', 'it', '資訊部', 'dzy-hq', '', '', 3, 'TRUE'],
  ['dept', 'eng', '工程部', 'dzy-hq', '', '', 4, 'TRUE'],
  ['dept', 'franchise', '加盟招商部', 'dzy-hq', '', '', 5, 'TRUE'],
  ['dept', 'purchase', '採購部', 'dzy-hq', '', '', 6, 'TRUE'],
  ['dept', 'ops', '營運部', 'dzy-hq', '', '', 7, 'TRUE'],
  ['dept', 'training', '訓練部', 'dzy-hq', '', '', 8, 'TRUE'],
  ['dept', 'marketing', '行銷部', 'dzy-hq', '', '', 9, 'TRUE']
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
