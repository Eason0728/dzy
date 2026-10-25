/**
 * 鼎兆元管理系統｜平台後端 — 員工名單統一（人員資料當正本，打卡對照與待辦單）
 * 正本規格：docs/personnel/master-data/spec.md（v2，衝突時以 §11 為準）；契約：docs/personnel/master-data/api.md。
 *
 * 架構一句話：後端實際跑在 Mac mini 的 Node 外殼，.gs 沒有 UrlFetchApp，所以本檔所有「打卡動作」
 * 都只寫 clock_outbox 待辦單；由另一支 Node 同步員（jobs.js）經 runGas 呼叫本檔「結尾是底線的內部函式」
 * 撿單與回填。內部函式不進 Code.gs 分派表（打 doPost 呼叫它們一律回 unknown action）。
 *
 * 依賴：Auth.gs（handleMe_／hasPerm_／setTokenAfter_／authSafeCell_／authSafeEqual_）、
 *       Users.gs（findUsrRowById_／findUsrRowByUsername_／generateNextUserId_／usrFormatTaipeiDatetime_）、
 *       Staff.gs（stf* 小工具與 STF_*）。**本檔頂層不引用別檔的全域變數**（Apps Script 檔案載入順序不保證），
 *       一律在函式裡才用。
 *
 * ⚠ dzy 是 public repo：本檔與測試不得出現真實姓名、網址、金鑰、試算表 ID。
 * ⚠ staff_log 的 detail 只寫欄位名稱／代碼／job_id，不寫姓名、手機、生日、地址。
 * ⚠ 打卡連結金鑰只進 CacheService（120 秒、取一次即刪），不進任何分頁、不進 Script Properties。
 */

var CLK_SHEET_STORES = 'clock_stores';
var CLK_SHEET_MAP = 'staff_clock';
var CLK_SHEET_OUTBOX = 'clock_outbox';

var CLK_STORES_HEADERS = ['store_code', 'store_name', 'unit_code', 'enabled', 'payroll_store'];
var CLK_NAME_MAX = 20;   // 會進打卡的姓名上限（與打卡端 svc_add／mgr_add_employee 一致）
var CLK_MAP_BASE = ['emp_no', 'store_code', 'emp_id', 'role', 'state', 'source', 'roster_active',
  'last_punch', 'confirmed_by', 'confirmed_at', 'updated_at'];
// LINE 認身分（docs/line-auth/spec.md §3）：每晚由 svc_roster 同步進來；舊分頁表頭缺這四欄時由 clkEnsureMapExtra_ 自動補
var CLK_MAP_LINE = ['line_h', 'line_kid', 'line_bound_at', 'line_ok_at'];
var CLK_MAP_HEADERS = CLK_MAP_BASE.concat(CLK_MAP_LINE);
var CLK_OUTBOX_HEADERS = ['job_id', 'kind', 'emp_no', 'store_code', 'emp_id', 'name', 'op_id', 'expect_json',
  'state', 'tries', 'next_at', 'lease_until', 'last_error', 'created_at', 'updated_at', 'done_at'];
var CLK_STAFF_EXTRA = ['hire_date', 'last_day', 'extra_depts', 'line_revoked_at'];   // extra_depts＝兼任部門（組織改版 T2，Staff.gs 讀寫）；line_revoked_at＝人資停用 LINE 開通／重設的時間（毫秒，LineAuth.gs 讀寫）；舊表缺尾端欄時自動補

// 預設六列：[store_code, store_name, [[品牌代碼, 單位名稱]…], payroll_store]；unit_code 由 STF_DEFAULT_ORG 依品牌＋單位名稱查（多個單位以逗號串起來），查不到的留空。
// payroll_store＝薪資模組自己的門市代碼（SSLGF＝打卡 Payroll.gs PAY_DEFAULT_STORE；CF／HQ／MZTJS／MZTLZL 見 mala-clock-in、mala-payroll skill 的薪酬門市表紀錄）；
// 墨竹亭光復 mztgf：文件記載「不在薪酬門市表」、無代碼證據，留空（空白時退回用 store_code 比對）
var CLK_DEFAULT_STORES = [
  ['gf', '小辛辣 新竹光復', [['mala', '新竹光復']], 'SSLGF'],
  ['mztjs', '墨竹亭 新竹金山', [['mzt', '新竹金山']], 'MZTJS'],
  ['mztgf', '墨竹亭 新竹光復', [['mzt', '新竹光復']], ''],
  ['mztlzl', '墨竹亭 台北六張犁', [['mzt', '台北六張犁']], 'MZTLZL'],
  // 總部：管理系統有四個總部／品牌辦公室單位（Eason 2026-10-14），打卡共用同一套總部打卡 → unit_code 逗號分隔四個
  ['hq', '鼎兆元 總部', [['dzy', '鼎兆元總部'], ['mzt', '墨竹亭品牌辦公室'], ['mala', '小辛辣品牌辦公室'], ['yiwu', '一悟燒肉品牌辦公室']], 'HQ'],
  ['cf', '中央廚房', [['ck', '中央工廠（央廚）']], 'CF']
];

var CLK_KINDS = ['add', 'deactivate', 'reactivate', 'link', 'build'];
var CLK_OPEN_STATES = ['pending', 'running'];
var CLK_LEASE_MINUTES = 5;
var CLK_RETRY_MINUTES = [1, 5, 30];   // 第 1、2、3 次失敗後等多久；之後每 6 小時
var CLK_RETRY_LATER_MINUTES = 360;
var CLK_ALERT_TRIES = 3;               // 第 3 次失敗起進 alerts
var CLK_LINK_TTL_SECONDS = 120;
var CLK_LEAVE_BACK_DAYS = 7;
var CLK_LEAVE_FWD_DAYS = 365;
var CLK_BASELINE_COUNT = 113;          // §4.3 前置檢查：DZY001～DZY113 都要在
// 打卡端回報的這些錯誤代碼是「重試也不會好」的，直接 failed、不排自動重試
var CLK_PERMANENT_ERRORS = ['unauthorized', 'bad_version', 'bad_input', 'duplicate_name', 'not_found', 'disabled', 'conflict'];

var CLK_PROP_MAP_STATE = 'CLOCK_MAP_STATE';        // 建對照結果：candidates／needs_hq／excluded
var CLK_PROP_SYNC_PREFIX = 'CLOCK_SYNC_';           // + store_code：每店同步結果（未對照、姓名不同、薪資姓名不同）
var CLK_PROP_TRANSFER_FAIL = 'CLOCK_TRANSFER_FAIL';  // 調店開 add 單失敗的 emp_no
var CLK_PROP_HOME_PIN = 'CLOCK_HOME_PIN';           // 總部指定主店（釘選）：{emp_no: store_code}
var CLK_PROP_TRANSFER_ASK = 'CLOCK_TRANSFER_ASK';   // 調店後待總部決定要不要停用舊店
var CLK_CACHE_LINK_PREFIX = 'clk_link_';
var CLK_PROP_SVC_KEY = 'BULLETIN_SVC_KEY';

var CLK_MSG = {
  NO_PERM: '沒有權限',
  NOT_FOUND: '找不到這位同仁',
  BAD_INPUT: '資料格式不對',
  NAME_REQUIRED: '請填姓名',
  NAME_TOO_LONG: '姓名最多 20 個字（打卡系統的限制）',
  NAME_CLASH_UNIT: '這個單位已經有同名的在職同仁，請在姓名後加註（例如「姓名-B」）區分',
  NAME_CLASH_UNCLAIMED: '名單上已有同名、還沒認領的人，請在姓名後加註（例如「姓名-B」）區分',
  PHONE: '手機要是 09 開頭的 10 碼數字',
  HIRE_DATE: '到職日格式要是 YYYY-MM-DD，且要是有效的日期',
  UNIT_REQUIRED: '請選擇單位',
  TITLE_ABOVE_SELF: '不能新增比自己職級高的職稱',
  FULL: '編號已經用到 DZY999，請聯絡系統維護者',
  EMP_CONFLICT: '編號已被使用，請稍後再試',
  SELF_LEAVE: '不能對自己登記離職',
  LEAVE_RANK: '不能對職級跟自己一樣或更高的同仁登記離職，請找總部',
  ALREADY_DISABLED: '這位同仁已經停用',
  LAST_DAY_FORMAT: '最後上班日格式要是 YYYY-MM-DD',
  LAST_DAY_PAST: '最後上班日最多只能往回補 7 天',
  LAST_DAY_FAR: '最後上班日太遠，請再確認',
  NO_LEAVE: '這位同仁沒有登記離職',
  LEAVE_PASSED: '最後上班日已經過了，不能撤銷；要復職請找總部',
  NOT_DISABLED: '這位同仁沒有停用，不需要復職',
  BUSY: '系統忙碌中，請稍後再試',
  NO_JOB: '找不到這張待辦單',
  NOT_RETRYABLE: '這張待辦單目前不能重試',
  NO_MAP: '這位同仁在這家店沒有生效的打卡對照',
  NO_CLOCK_STORE: '這個單位沒有對應的打卡',
  DUP_CONFIRMED: '這位同仁在這家店已經有生效的打卡編號，請先處理舊的',
  EMP_ID_TAKEN: '這個打卡編號已經確認給別人了',
  HOME_EXISTS: '這位同仁已經有主店，請先改成支援店',
  PRECHECK_BASELINE: '同仁名單還沒有 DZY001～DZY113，不能建立打卡對照',
  PRECHECK_DUP_NAME: '同仁名單有重複姓名還沒處理，不能建立打卡對照',
  PRECHECK_OUTBOX: '還有沒完成的待辦單，不能建立打卡對照',
  PRECHECK_NO_STORE: '沒有啟用的打卡店',
  NAME_SAME: '姓名沒有變',
  DEAD_STATE: '目前的狀態不能做這個動作',
  UNAUTHORIZED: '服務金鑰錯誤',
  NAME_START: '姓名開頭不能是 = + - @ 這四個符號（會被試算表當成公式），請改寫或加註在後面',
  JOB_OPEN: '這個打卡編號還有送出中的待辦單，請等它完成再改',
  EMPTY_ROSTER: '打卡端回了空名冊，但這家店已有生效對照——疑似打錯分頁或網址，不套用',
  SUPPORT_LINK_HQ: '支援店的打卡連結只給總部',
  ADD_HOME_LEFT: '這位同仁離職日已過，不能建打卡帳號',
  ADD_HOME_NO_UNIT: '這位同仁還沒有單位，請先用「改資料」設定單位',
  ADD_HOME_HAS_MAP: '這位同仁在主店已經有生效的打卡編號，不用再建；要改主店請到打卡對照處理',
  ADD_HOME_JOB_OPEN: '主店打卡帳號已經在建檔中，請等它完成'
};

// ============================================================
// 1. 小工具
// ============================================================

function clkErr_(code, message) { return { ok: false, error: message, code: code }; }
function clkPad_(n) { return (n < 10 ? '0' : '') + n; }

/** 把 now（Date／毫秒數／'yyyy-MM-dd HH:mm:ss' 或 'yyyy-MM-dd' 台北時間字串／未給）轉成 Date */
function clkDate_(now) {
  var d = null;
  if (now === undefined || now === null || now === '') return new Date();
  if (typeof now === 'number') d = new Date(now);
  else if (typeof now === 'string') {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(now.trim());
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 8 * 3600 * 1000);
  } else if (typeof now.getTime === 'function') d = new Date(now.getTime());
  if (!d || isNaN(d.getTime())) return new Date();
  return d;
}
function clkNowText_(d) { return usrFormatTaipeiDatetime_(d); }
function clkTodayOf_(d) { return clkNowText_(d).slice(0, 10); }
function clkAddMinutes_(d, min) { return new Date(d.getTime() + min * 60000); }
function clkAddDays_(ymd, n) {
  var p = ymd.split('-');
  var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return t.getUTCFullYear() + '-' + clkPad_(t.getUTCMonth() + 1) + '-' + clkPad_(t.getUTCDate());
}
function clkValidYmd_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  var y = +m[1], mo = +m[2], d = +m[3];
  var t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
/** 打卡編號以打卡名冊原字串為準（只去頭尾空白，不改大小寫；打卡端比對區分大小寫） */
function clkEid_(v) { return stfStr_(v); }
function clkCode_(v) { return stfStr_(v).toLowerCase(); }
/** 開頭是 = + - @ 的姓名會在試算表變公式：新增／改名／候選建立一律擋 */
function clkNameBadStart_(name) { return /^[=+\-@]/.test(String(name)); }
function clkNormName_(v) { return String(v === undefined || v === null ? '' : v).replace(/[\s　]+/g, ''); }
function clkTruthy_(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }
function clkBoolText_(b) { return b ? 'TRUE' : 'FALSE'; }
function clkJson_(s, dflt) { try { var o = JSON.parse(s); return (o && typeof o === 'object') ? o : dflt; } catch (e) { return dflt; } }

function clkGetState_(key, dflt) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? clkJson_(raw, dflt) : dflt;
}
function clkSetState_(key, obj) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(obj));
}

// ============================================================
// 2. 分頁讀寫
// ============================================================

function clkRows_(name, headers) {
  return stfReadRows_(name, headers.length).map(function (v, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, k) { o[h] = (v[k] === undefined || v[k] === null) ? '' : v[k]; });
    return o;
  });
}

function clkSave_(name, headers, o) {
  var vals = headers.map(function (h) { return o[h] === undefined ? '' : o[h]; });
  if (!o._row) o._row = stfSheet_(name).getLastRow() + 1;
  stfWriteRow_(name, o._row, vals, headers.length);
  return o;
}

function clkSheetsReady_() {
  return !!(stfSheet_(CLK_SHEET_STORES) && stfSheet_(CLK_SHEET_MAP) && stfSheet_(CLK_SHEET_OUTBOX));
}

/** 預設六列 clock_stores；unit_code 由 STF_DEFAULT_ORG 依「品牌＋單位名稱」對上，查不到留空 */
function clkDefaultStoreRows_() {
  return CLK_DEFAULT_STORES.map(function (s) {
    var units = [];
    s[2].forEach(function (pair) {
      STF_DEFAULT_ORG.forEach(function (r) {
        if (r[0] === 'unit' && r[3] === pair[0] && r[2] === pair[1] && units.indexOf(r[1]) === -1) units.push(r[1]);
      });
    });
    return [s[0], s[1], units.join(','), 'TRUE', s[3]];
  });
}

/**
 * 表頭尾端補欄共用：start＝起始欄號（1-based），want＝完整表頭。
 * 已填的部分必須是 want 的前綴、其後全空才補（minFilled＝已填欄數至少要幾欄，0＝全空也可）；其他內容丟錯停下，免得資料錯位。
 */
function clkFillTailHeaders_(sh, start, want, minFilled, label) {
  var cur = sh.getRange(1, start, 1, want.length).getValues()[0].map(function (v) { return String(v).trim(); });
  var k = 0;
  while (k < cur.length && cur[k] !== '') k++;
  var tailEmpty = cur.slice(k).every(function (v) { return v === ''; });
  var prefixOk = cur.slice(0, k).join('|') === want.slice(0, k).join('|');
  if (!prefixOk || !tailEmpty || (k > 0 && k < minFilled)) {
    throw new Error('分頁「' + label + '」右側的表頭與程式不一致，停止初始化以免資料錯位：' + cur.join(','));
  }
  if (k < want.length) sh.getRange(1, start + k, 1, want.length - k).setValues([want.slice(k)]);
}

/** staff 右側補 hire_date、last_day、extra_depts、line_revoked_at：空的或只缺尾端才補；已經一模一樣就略過；其他內容停下回錯 */
function clkEnsureStaffExtra_(ss) {
  var sh = ss.getSheetByName(STF_SHEET);
  if (!sh) return;
  var start = STF_COL_COUNT + 1;
  var need = STF_COL_COUNT + CLK_STAFF_EXTRA.length;
  if (typeof sh.getMaxColumns === 'function' && sh.getMaxColumns() < need && typeof sh.insertColumnsAfter === 'function') {
    sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  }
  clkFillTailHeaders_(sh, start, CLK_STAFF_EXTRA, 2, STF_SHEET);
}

/** staff_clock 尾端補 line_h、line_kid、line_bound_at、line_ok_at（前 11 欄必須是舊表頭才動；空表交給 stfEnsureSheet_） */
function clkEnsureMapExtra_(ss) {
  var sh = ss.getSheetByName(CLK_SHEET_MAP);
  if (!sh) return;
  var n = CLK_MAP_HEADERS.length;
  var base = sh.getRange(1, 1, 1, CLK_MAP_BASE.length).getValues()[0].map(function (v) { return String(v).trim(); });
  if (base.join('|') !== CLK_MAP_BASE.join('|')) return;   // 空表或不一致：交給 stfEnsureSheet_ 處理
  if (typeof sh.getMaxColumns === 'function' && sh.getMaxColumns() < n && typeof sh.insertColumnsAfter === 'function') {
    sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
  }
  clkFillTailHeaders_(sh, CLK_MAP_BASE.length + 1, CLK_MAP_LINE, 0, CLK_SHEET_MAP);
}

/** 由 setupStaff 呼叫（只補不覆蓋；表頭不一致丟錯停下） */
function clkEnsureStoresExtra_(ss) {
  var sh = ss.getSheetByName(CLK_SHEET_STORES);
  if (!sh) return;
  var n = CLK_STORES_HEADERS.length;
  var head = sh.getRange(1, 1, 1, 4).getValues()[0].map(function (v) { return String(v).trim(); });
  if (head.join('|') !== CLK_STORES_HEADERS.slice(0, 4).join('|')) return;   // 空表或不一致：交給 stfEnsureSheet_ 處理
  if (typeof sh.getMaxColumns === 'function' && sh.getMaxColumns() < n && typeof sh.insertColumnsAfter === 'function') {
    sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
  }
  if (String(sh.getRange(1, n, 1, 1).getValues()[0][0]).trim() !== '') return;
  sh.getRange(1, n, 1, 1).setValues([[CLK_STORES_HEADERS[n - 1]]]);
  CLK_DEFAULT_STORES.forEach(function (d) {   // 只補空白：舊表的光復列補 SSLGF
    if (!d[3]) return;
    var last = sh.getLastRow();
    for (var r = 2; r <= last; r++) {
      if (clkCode_(sh.getRange(r, 1, 1, 1).getValues()[0][0]) === d[0]) sh.getRange(r, n, 1, 1).setValues([[d[3]]]);
    }
  });
}

function clkSetup_(ss) {
  clkEnsureStoresExtra_(ss);
  clkEnsureMapExtra_(ss);
  stfEnsureSheet_(ss, CLK_SHEET_STORES, CLK_STORES_HEADERS, clkDefaultStoreRows_());
  stfEnsureSheet_(ss, CLK_SHEET_MAP, CLK_MAP_HEADERS, []);
  stfEnsureSheet_(ss, CLK_SHEET_OUTBOX, CLK_OUTBOX_HEADERS, []);
  clkEnsureStaffExtra_(ss);
  clkUpgradeHqUnits_(ss);
  var conflict = clkUnitConflict_();
  if (conflict) throw new Error('分頁「clock_stores」設定衝突，停止初始化：' + conflict);
  return { ok: true };
}

/**
 * 升級：舊預設 hq 列的 unit_code 只有 dzy-hq → 補成三個總部單位（dzy-hq,mzt-hq,mala-hq）。
 * 只動「恰好等於舊預設」的值；總部已自訂成別的值就不碰。
 */
function clkUpgradeHqUnits_(ss) {
  var sh = ss.getSheetByName(CLK_SHEET_STORES);
  if (!sh) return;
  var want = clkDefaultStoreRows_().filter(function (r) { return r[0] === 'hq'; })[0];
  if (!want || want[2].split(',').length < 2) return;   // org 預設查不到多個單位時不升級
  var last = sh.getLastRow();
  for (var r = 2; r <= last; r++) {
    var row = sh.getRange(r, 1, 1, 3).getValues()[0];
    if (clkCode_(row[0]) === 'hq' && stfStr_(row[2]) === 'dzy-hq') sh.getRange(r, 3, 1, 1).setValues([[want[2]]]);
  }
}

/** 三個新分頁＋staff 右側兩欄的表頭是否和程式一致；回 ''＝一致，否則回說明 */
function clkHeaderProblem_() {
  var checks = [[CLK_SHEET_STORES, CLK_STORES_HEADERS], [CLK_SHEET_MAP, CLK_MAP_HEADERS], [CLK_SHEET_OUTBOX, CLK_OUTBOX_HEADERS]];
  for (var i = 0; i < checks.length; i++) {
    var sh = stfSheet_(checks[i][0]);
    if (!sh) return '分頁「' + checks[i][0] + '」不存在';
    var cur = sh.getRange(1, 1, 1, checks[i][1].length).getValues()[0].map(function (v) { return String(v).trim(); });
    if (cur.join('|') !== checks[i][1].join('|')) return '分頁「' + checks[i][0] + '」的表頭與程式不一致：' + cur.join(',');
  }
  if (!clkStaffExtraReady_()) return '分頁「staff」右側缺 hire_date、last_day、extra_depts、line_revoked_at 表頭';
  return clkUnitConflict_() ? ('clock_stores 設定衝突：' + clkUnitConflict_()) : '';
}

/** 每支 action 開頭：分頁沒建就建；建完（或本來就有）再核對表頭，不一致就停下回錯，不寫任何資料 */
function clkReady_() {
  try {
    if (!stfSheetsReady_() || !clkSheetsReady_() || !clkStaffExtraReady_() || clkHeaderProblem_()) setupStaff();
    var problem = clkHeaderProblem_();
    if (problem) return clkErr_('setup_failed', '分頁初始化失敗：' + problem);
    return { ok: true };
  } catch (e) {
    return clkErr_('setup_failed', '分頁初始化失敗：' + (e && e.message ? e.message : e));
  }
}
function clkStaffExtraReady_() {
  var sh = stfSheet_(STF_SHEET);
  if (!sh) return false;
  try {
    var cur = sh.getRange(1, STF_COL_COUNT + 1, 1, CLK_STAFF_EXTRA.length).getValues()[0].map(function (v) { return String(v).trim(); });
    return cur.join('|') === CLK_STAFF_EXTRA.join('|');
  } catch (e) {
    return false;   // 欄數不夠（還沒擴欄）→ 交給 setupStaff 補
  }
}

// staff（含右側兩欄）
function clkStaffAll_() {
  return stfReadRows_(STF_SHEET, STF_COL_COUNT + CLK_STAFF_EXTRA.length).map(function (v, i) {
    return { row: i + 2, values: v, emp: stfNormEmp_(v[STF_COL.emp_no]), hire: stfDate_(v[STF_COL_COUNT]), last: stfDate_(v[STF_COL_COUNT + 1]) };
  });
}
function clkStaffByEmp_(empNo) {
  var t = stfNormEmp_(empNo);
  var all = clkStaffAll_();
  for (var i = 0; i < all.length; i++) if (all[i].emp === t) return all[i];
  return null;
}
function clkStaffUnit_(s) { return stfStr_(s.values[STF_COL.unit]); }
function clkStaffStatus_(s) { return stfStr_(s.values[STF_COL.status]); }
function clkStaffName_(s) { return stfStr_(s.values[STF_COL.name]); }
function clkSetStaffExtra_(row, hire, last) {
  var r = stfSheet_(STF_SHEET).getRange(row, STF_COL_COUNT + 1, 1, 2);   // 只寫 hire_date、last_day 兩格，不碰 extra_depts
  r.setNumberFormat('@');
  r.setValues([[hire, last]]);
}

// stores
function clkStores_() {
  return clkRows_(CLK_SHEET_STORES, CLK_STORES_HEADERS).filter(function (r) { return stfStr_(r.store_code) !== ''; }).map(function (r) {
    r.store_code = clkCode_(r.store_code);
    r.unit_code = stfStr_(r.unit_code);
    r.enabled = String(r.enabled).trim().toUpperCase() !== 'FALSE';
    return r;
  });
}
function clkStoreByCode_(code) {
  var c = clkCode_(code);
  var all = clkStores_();
  for (var i = 0; i < all.length; i++) if (all[i].store_code === c) return all[i];
  return null;
}
/** unit_code 欄可放多個單位（逗號分隔，如總部三單位共用 hq） */
function clkUnitsOf_(store) {
  return stfStr_(store && store.unit_code).split(',').map(function (u) { return stfStr_(u); }).filter(function (u) { return u; });
}
/** 單位 → 店：這個單位在某家啟用的店的 unit_code 清單裡就算 */
function clkStoreOfUnit_(unit) {
  if (!unit) return null;
  var all = clkStores_();
  for (var i = 0; i < all.length; i++) if (all[i].enabled && clkUnitsOf_(all[i]).indexOf(unit) !== -1) return all[i];
  return null;
}
/** 設定檢查：同一個單位不得出現在兩家店；回說明字串或 ''（停用的店也算，避免之後啟用才爆） */
function clkUnitConflict_() {
  var seen = {};
  var all = clkStores_();
  for (var i = 0; i < all.length; i++) {
    var us = clkUnitsOf_(all[i]);
    for (var k = 0; k < us.length; k++) {
      if (seen[us[k]] && seen[us[k]] !== all[i].store_code) return '單位「' + us[k] + '」同時出現在店 ' + seen[us[k]] + ' 與 ' + all[i].store_code + ' 的 unit_code';
      seen[us[k]] = all[i].store_code;
    }
  }
  return '';
}

// ---- 主店判斷（build、decide、每日同步、調店共用）----
/**
 * 這個人的主店。順序：
 * 1) DZY 單位對得到打卡店 → 用它（by:'unit'；單位有值的人以單位為準，不被打卡資料覆蓋）
 * 2) 總部指定主店（clockSetHome 釘選，且該店仍有未停用的 confirmed 對照）→ 釘選的店（by:'pin'）
 * 3) 單位空（第一期匯入、尚未認領）或對不到店 → 用打卡對照推斷（by:'infer'）：
 *    只在一家名冊在職（roster_active≠FALSE、對照未被退回）＝那家；多家＝last_punch 較近者；
 *    同日或都沒有 → 目前已是 home 的那家，再不然 store_code 字母序最前。
 *    ※ 平台目前只存每個對照的 last_punch（最近一次打卡日），沒有近 60 天次數／名冊建立日，所以用最近打卡日。
 * 回 {store, by}；推斷不出來 store＝''。
 */
function clkPins_() { return clkGetState_(CLK_PROP_HOME_PIN, {}); }

function clkHomeStoreFor_(s, maps) {
  var unit = clkStaffUnit_(s);
  var us = unit ? clkStoreOfUnit_(unit) : null;
  if (us) return { store: us.store_code, by: 'unit' };
  // 總部指定（釘選）：該店仍有未停用的 confirmed 對照才算數，停用／rejected 時自動失效（不刪表）
  var pin = clkPins_()[s.emp];
  if (pin && maps.some(function (m) { return m.emp_no === s.emp && m.store_code === pin && m.state === 'confirmed' && m.roster_active !== 'FALSE'; })) {
    return { store: pin, by: 'pin' };
  }
  var best = {};
  maps.forEach(function (m) {
    if (m.emp_no !== s.emp || m.state === 'rejected' || m.roster_active === 'FALSE') return;
    var cur = best[m.store_code] || { last: '', home: false };
    if ((m.last_punch || '') > cur.last) cur.last = m.last_punch || '';
    if (m.role === 'home') cur.home = true;
    best[m.store_code] = cur;
  });
  var keys = Object.keys(best);
  if (!keys.length) return { store: '', by: '' };
  keys.sort(function (x, y) {
    if (best[x].last !== best[y].last) return best[x].last > best[y].last ? -1 : 1;
    if (best[x].home !== best[y].home) return best[x].home ? -1 : 1;
    return x < y ? -1 : (x > y ? 1 : 0);
  });
  return { store: keys[0], by: 'infer' };
}

/**
 * 重算一個人各對照的 role（只改 role，不改 state、不發任何打卡單）。
 * 單位對得到店、且已有 confirmed home 的人不動（以單位／既有為準）；單位空的人 suggested 與 confirmed 都可改。
 * 回改了幾筆；有改寫 staff_log（role_recalc，只記店代碼與依據）。
 */
function clkRecomputeRoles_(empNo, d, why) {
  var s = clkStaffByEmp_(empNo);
  if (!s) return 0;
  var maps = clkMaps_();
  var mine = maps.filter(function (m) { return m.emp_no === s.emp && m.state !== 'rejected'; });
  if (!mine.length) return 0;
  var unitStore = clkStaffUnit_(s) ? clkStoreOfUnit_(clkStaffUnit_(s)) : null;
  if (unitStore && mine.some(function (m) { return m.state === 'confirmed' && m.role === 'home'; })) return 0;
  var h = clkHomeStoreFor_(s, maps);
  if (!h.store || !mine.some(function (m) { return m.store_code === h.store; })) return 0;
  var n = 0;
  mine.forEach(function (m) {
    var want = m.store_code === h.store ? 'home' : 'support';
    if (m.role !== want) { m.role = want; clkMapSave_(m, d); n++; }
  });
  if (n) stfLog_(s.emp, 'role_recalc', 'sync', (why || '') + ' ' + h.store + ' ' + h.by);
  return n;
}

// staff_clock
function clkMaps_() {
  return clkRows_(CLK_SHEET_MAP, CLK_MAP_HEADERS).map(function (m) {
    m.emp_no = stfNormEmp_(m.emp_no); m.store_code = clkCode_(m.store_code); m.emp_id = clkEid_(m.emp_id);
    m.role = stfStr_(m.role); m.state = stfStr_(m.state); m.source = stfStr_(m.source);
    m.roster_active = stfStr_(m.roster_active).toUpperCase();
    m.last_punch = stfDate_(m.last_punch);
    return m;
  });
}
function clkMapFind_(maps, store, empId) {
  for (var i = 0; i < maps.length; i++) if (maps[i].store_code === store && maps[i].emp_id === empId) return maps[i];
  return null;
}
function clkMapsOf_(maps, empNo) { return maps.filter(function (m) { return m.emp_no === empNo; }); }
function clkConfirmedOf_(maps, empNo) { return maps.filter(function (m) { return m.emp_no === empNo && m.state === 'confirmed'; }); }
function clkMapSave_(m, d) { m.updated_at = clkNowText_(d); return clkSave_(CLK_SHEET_MAP, CLK_MAP_HEADERS, m); }
function clkNewMap_(empNo, store, empId, role, state, source, rosterActive, by, d) {
  var now = clkNowText_(d);
  return clkSave_(CLK_SHEET_MAP, CLK_MAP_HEADERS, {
    emp_no: empNo, store_code: store, emp_id: empId, role: role, state: state, source: source,
    roster_active: rosterActive === '' ? '' : clkBoolText_(rosterActive), last_punch: '',
    confirmed_by: state === 'confirmed' ? by : '', confirmed_at: state === 'confirmed' ? now : '', updated_at: now
  });
}

// clock_outbox
function clkJobs_() {
  return clkRows_(CLK_SHEET_OUTBOX, CLK_OUTBOX_HEADERS).map(function (j) {
    j.tries = Number(j.tries) || 0;
    j.emp_no = stfNormEmp_(j.emp_no); j.store_code = clkCode_(j.store_code); j.emp_id = clkEid_(j.emp_id);
    return j;
  });
}
function clkJobSave_(j, d) { j.updated_at = clkNowText_(d); return clkSave_(CLK_SHEET_OUTBOX, CLK_OUTBOX_HEADERS, j); }
function clkJobById_(jobs, id) {
  for (var i = 0; i < jobs.length; i++) if (jobs[i].job_id === id) return jobs[i];
  return null;
}
function clkOpenJob_(jobs, kind, empNo, store, empId) {
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    if (j.kind === kind && j.emp_no === empNo && j.store_code === store && (!empId || j.emp_id === empId) &&
        CLK_OPEN_STATES.indexOf(j.state) !== -1) return j;
  }
  return null;
}

/** job_id＝J + 台北 yyyyMMddHHmmss + - + 4 位小寫十六進位亂數（共用契約）；op_id＝dzy: + job_id */
function clkNewJobId_(d, used) {
  var stamp = clkNowText_(d).replace(/[-: ]/g, '');
  for (var tries = 0; tries < 200; tries++) {
    var hex = '';
    for (var k = 0; k < 4; k++) hex += Math.floor(Math.random() * 16).toString(16);
    var id = 'J' + stamp + '-' + hex;
    if (!used[id]) { used[id] = true; return id; }
  }
  throw new Error('job_id 產生失敗');
}
function clkUsedIds_(jobs) { var u = {}; jobs.forEach(function (j) { u[j.job_id] = true; }); return u; }

/** 寫一張待辦單（狀態 pending、next_at＝現在）。fields：kind, emp_no, store_code, emp_id, name, expect（物件） */
function clkEnqueue_(fields, d, used) {
  var id = clkNewJobId_(d, used);
  var now = clkNowText_(d);
  var j = {
    job_id: id, kind: fields.kind, emp_no: fields.emp_no || '', store_code: fields.store_code || '', emp_id: fields.emp_id || '',
    name: fields.name ? authSafeCell_(fields.name) : '', op_id: 'dzy:' + id,
    expect_json: JSON.stringify(fields.expect || {}), state: 'pending', tries: 0, next_at: now, lease_until: '',
    last_error: '', created_at: now, updated_at: now, done_at: ''
  };
  return clkSave_(CLK_SHEET_OUTBOX, CLK_OUTBOX_HEADERS, j);
}

// ============================================================
// 3. 權限
// ============================================================

/**
 * 呼叫者身分：總部＝platform.staff；店長＝門市單位（org ladder＝store）、職級店長以上（rank≥3）、同單位——
 * 沿用 Staff.gs stfManagerScope_ 的判斷，再多擋一層「總部單位的總監不能走店長路徑」。
 */
function clkActor_(token) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  var org = stfReadOrg_();
  var self = stfFindByUserId_(me.data.user.id);
  var isHq = hasPerm_(me.data.perms, 'platform.staff');
  var scope = null, rank = 0;
  if (self && hasPerm_(me.data.perms, 'platform.self')) {
    var sc = stfManagerScope_(self.values, org);
    var unit = sc ? org.unit[sc.unit] : null;
    if (sc && (unit ? (unit.ladder || 'store') : 'store') === 'store') {
      scope = sc;
      var t = org.title[stfStr_(self.values[STF_COL.title])];
      rank = t ? t.rank : 0;
    }
  }
  return { ok: true, user: me.data.user, perms: me.data.perms, isHq: isHq, scope: scope, rank: rank, org: org,
    selfEmp: self ? stfNormEmp_(self.values[STF_COL.emp_no]) : '' };
}
function clkCanManageUnit_(a, unit) { return a.isHq || (!!a.scope && unit !== '' && a.scope.unit === unit); }
function clkActorLabel_(a) {
  if (a.selfEmp) return a.selfEmp;
  var u = findUsrRowById_(a.user.id);
  return u ? stfStr_(u.values[USR_COL.username]) : String(a.user.id);
}
/** 需要「總部或店長」；回 actor 或錯誤 */
function clkNeedActor_(token) {
  var a = clkActor_(token);
  if (!a.ok) return a;
  if (!a.isHq && !a.scope) return clkErr_('no_perm', CLK_MSG.NO_PERM);
  return a;
}
function clkNeedHq_(token) {
  var a = clkActor_(token);
  if (!a.ok) return a;
  if (!a.isHq) return clkErr_('no_perm', CLK_MSG.NO_PERM);
  return a;
}

// ============================================================
// 4. 停用／復職（沿用第一期 staffSetActive 的寫法）
// ============================================================

function clkDisableStaff_(s, by, detail, d) {
  var v = s.values.slice(0, STF_COL_COUNT);
  var status = stfStr_(v[STF_COL.status]);
  if (status === 'disabled') return clkErr_('already_disabled', CLK_MSG.ALREADY_DISABLED);
  // 平台帳號列遺失也要把 staff 標停用（店端停用單才驗得過、才發得出去）；回 warn 讓呼叫端記錄、進首頁異常
  var userRow = findUsrRowById_(stfStr_(v[STF_COL.user_id]));
  v[STF_COL.prev_status] = status;
  v[STF_COL.status] = 'disabled';
  v[STF_COL.updated_at] = clkNowText_(d);
  stfSetBulletinAdmin_(v[STF_COL.emp_no], false);   // 離職停用收回公告管理權限（審查 dzy-bulletin#44-10）
  if (userRow) {
    stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.active + 1).setValue('FALSE');
    setTokenAfter_(userRow.row);
  }
  stfWriteRow_(STF_SHEET, s.row, v, STF_COL_COUNT);
  if (typeof lineAutoRevoke_ === 'function') lineAutoRevoke_(s.row);   // 停用＝LINE 開通／重設也收回（LineAuth.gs；失敗不擋停用）
  stfLog_(s.emp, 'disable', by, detail || '');
  if (typeof permAuditDisabled_ === 'function') permAuditDisabled_(by, v);   // 離職停用收回的權限留一筆異動紀錄
  return userRow ? { ok: true } : { ok: true, warn: 'user_missing' };
}
function clkEnableStaff_(s, by, detail, d) {
  var v = s.values.slice(0, STF_COL_COUNT);
  if (stfStr_(v[STF_COL.status]) !== 'disabled') return clkErr_('not_disabled', CLK_MSG.NOT_DISABLED);
  var userRow = findUsrRowById_(stfStr_(v[STF_COL.user_id]));
  if (!userRow) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var prev = stfStr_(v[STF_COL.prev_status]);
  v[STF_COL.status] = STF_STATUSES.indexOf(prev) !== -1 && prev !== 'disabled' ? prev : 'pending';
  v[STF_COL.prev_status] = '';
  v[STF_COL.updated_at] = clkNowText_(d);
  stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.active + 1).setValue('TRUE');
  stfWriteRow_(STF_SHEET, s.row, v, STF_COL_COUNT);
  stfLog_(s.emp, 'enable', by, detail || '');
  if (typeof permAuditEnabled_ === 'function') permAuditEnabled_(by, v);   // 恢復的權限留一筆異動紀錄
  return { ok: true };
}

// ============================================================
// 5. 新增（店長／總部）— staffCreateByUnit
// ============================================================

function clkPayloadTooLong_(payload, fields, max) {
  return fields.some(function (f) { return stfTooLong_(payload[f], max); });
}

/** 新增同仁共用的組織欄驗證；回 {error,code} 或 {unit,brand,dept,title} */
function clkResolveOrg_(a, payload) {
  var org = a.org;
  var unit = a.isHq ? stfStr_(payload.unit) : a.scope.unit;   // 店長：夾帶的 unit 一律忽略
  if (!unit) return clkErr_('bad_input', CLK_MSG.UNIT_REQUIRED);
  var u = org.unit[unit];
  if (!u || !u.active) return clkErr_('bad_input', '請選擇單位');
  var dept = a.isHq ? stfStr_(payload.dept) : '';
  var title = stfStr_(payload.title);
  var err = stfValidateOrg_(org, { brand: u.parent, unit: unit, dept: dept, title: title });
  if (err) return clkErr_('bad_input', err);
  if (!a.isHq && org.title[title].rank > a.rank) return clkErr_('no_perm', CLK_MSG.TITLE_ABOVE_SELF);
  return { ok: true, unit: unit, brand: u.parent, dept: dept, title: title };
}

/** 同單位在職同名、或全名單有同名未認領 → 回錯誤，否則 null */
function clkNameClash_(name, unit, exceptEmp) {
  var all = clkStaffAll_();
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    if (s.emp === exceptEmp || clkNormName_(clkStaffName_(s)) !== clkNormName_(name) || clkStaffStatus_(s) === 'disabled') continue;
    if (clkStaffUnit_(s) === unit) return clkErr_('duplicate_name', CLK_MSG.NAME_CLASH_UNIT);
    if (clkStaffStatus_(s) === 'unclaimed') return clkErr_('duplicate_name', CLK_MSG.NAME_CLASH_UNCLAIMED);
  }
  return null;
}

function clkNewStaffRows_(empNo, name, o, hire, phone, nowText) {
  var uid = generateNextUserId_();
  var u = [];
  u[USR_COL.id] = uid; u[USR_COL.username] = empNo; u[USR_COL.name] = authSafeCell_(name); u[USR_COL.role] = 'staff';
  u[USR_COL.node] = ''; u[USR_COL.salt] = ''; u[USR_COL.hash] = ''; u[USR_COL.active] = 'TRUE';
  u[USR_COL.created_at] = nowText; u[USR_COL.last_login_at] = '';
  var row = [];
  for (var k = 0; k < STF_COL_COUNT + CLK_STAFF_EXTRA.length; k++) row.push('');
  row[STF_COL.emp_no] = empNo; row[STF_COL.user_id] = uid; row[STF_COL.name] = name; row[STF_COL.status] = 'unclaimed';
  row[STF_COL.brand] = o.brand; row[STF_COL.unit] = o.unit; row[STF_COL.dept] = o.dept; row[STF_COL.title] = o.title;
  row[STF_COL.phone] = phone; row[STF_COL.reset_fail] = 0; row[STF_COL.reset_lock_count] = 0; row[STF_COL.updated_at] = nowText;
  row[STF_COL_COUNT] = hire; row[STF_COL_COUNT + 1] = '';
  return { user: u, staff: row };
}

function handleStaffCreateByUnit_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  payload = payload || {};
  if (stfTooLong_(payload.name, CLK_NAME_MAX)) return clkErr_('bad_input', CLK_MSG.NAME_TOO_LONG);
  if (clkPayloadTooLong_(payload, ['title', 'unit', 'dept'], STF_MAX.org)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  if (stfTooLong_(payload.phone, STF_MAX.phone) || stfTooLong_(payload.hire_date, STF_MAX.birthday)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  var ready = clkReady_();
  if (!ready.ok) return ready;

  var name = stfStr_(payload.name);
  if (!name) return clkErr_('bad_input', CLK_MSG.NAME_REQUIRED);
  if (name.length > CLK_NAME_MAX) return clkErr_('bad_input', CLK_MSG.NAME_TOO_LONG);
  if (clkNameBadStart_(name)) return clkErr_('bad_input', CLK_MSG.NAME_START);
  var o = clkResolveOrg_(a, payload);
  if (!o.ok) return o;
  var phone = stfPhone_(payload.phone);
  if (stfValidatePhone_(phone)) return clkErr_('bad_input', CLK_MSG.PHONE);
  var hire = stfStr_(payload.hire_date);
  var d = new Date();
  var today = clkTodayOf_(d);
  if (!clkValidYmd_(hire) || hire < '2000-01-01' || hire > clkAddDays_(today, CLK_LEAVE_FWD_DAYS)) return clkErr_('bad_input', CLK_MSG.HIRE_DATE);
  var clash = clkNameClash_(name, o.unit, '');
  if (clash) return clash;

  var n = stfMaxEmpNum_() + 1;
  if (n > 999) return clkErr_('full', CLK_MSG.FULL);
  var empNo = stfEmpOf_(n);
  // emp_no 唯一：staff、users 兩邊都不能已經有這個編號（同時也被寫入鎖保護）
  if (stfFindByEmp_(empNo) || findUsrRowByUsername_(empNo)) return clkErr_('emp_conflict', CLK_MSG.EMP_CONFLICT);

  var nowText = clkNowText_(d);
  var rows = clkNewStaffRows_(empNo, name, o, hire, phone, nowText);
  var lockBlock = typeof permNewRowBlock_ === 'function' ? permNewRowBlock_(stfActorIsAdmin_(a.user), rows.staff.slice(0, STF_COL_COUNT)) : null;
  if (lockBlock) return lockBlock;
  var store = clkStoreOfUnit_(o.unit);
  var by = clkActorLabel_(a);
  // 同一支呼叫內寫完：users → staff → 待辦單 → log
  stfAppendBlock_(USR_SHEET_USERS, [rows.user], USR_COL_COUNT, false);
  stfAppendBlock_(STF_SHEET, [rows.staff], STF_COL_COUNT + CLK_STAFF_EXTRA.length, true);
  var jobId = null;
  if (store) {
    var job = clkEnqueue_({ kind: 'add', emp_no: empNo, store_code: store.store_code, name: name,
      expect: { emp_no: empNo, store_code: store.store_code, name: name, by: by, uid: String(a.user.id) } }, d, clkUsedIds_(clkJobs_()));
    jobId = job.job_id;
  }
  stfLog_(empNo, 'add_by_unit', a.user.id, '單位 ' + o.unit + (jobId ? '；待辦單 ' + jobId : '；無打卡'));
  return { ok: true, data: { emp_no: empNo, job_id: jobId, unit: o.unit, store_code: store ? store.store_code : null } };
}

// ============================================================
// 6. 離職登記／撤銷 — staffLeave／staffLeaveCancel
// ============================================================

function clkLeaveTarget_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  payload = payload || {};
  if (stfTooLong_(payload.emp_no, STF_MAX.emp_no)) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  if (a.selfEmp && a.selfEmp === s.emp) return clkErr_('self_leave', CLK_MSG.SELF_LEAVE);
  if (!clkCanManageUnit_(a, clkStaffUnit_(s))) return clkErr_('no_perm', CLK_MSG.NO_PERM);
  // 2026-10-25 審查 A-02：店長只能對職級比自己低的人登記／撤銷離職（同級也擋，Eason 決定；離職會停帳號，比審核嚴）
  if (!a.isHq) {
    var tt = a.org.title[stfStr_(s.values[STF_COL.title])];
    if ((tt ? tt.rank : 0) >= a.rank) return clkErr_('no_perm', CLK_MSG.LEAVE_RANK);
  }
  return { ok: true, a: a, s: s, d: new Date() };
}

function handleStaffLeave_(token, payload) {
  var t = clkLeaveTarget_(token, payload);
  if (!t.ok) return t;
  if (clkStaffStatus_(t.s) === 'disabled') return clkErr_('already_disabled', CLK_MSG.ALREADY_DISABLED);
  var lastDay = stfStr_(payload.last_day);
  if (!clkValidYmd_(lastDay)) return clkErr_('bad_input', CLK_MSG.LAST_DAY_FORMAT);
  var today = clkTodayOf_(t.d);
  // 店長：最多往回補 7 天（含第 7 天）；總部不擋往回，但仍不收太遠的未來
  if (!t.a.isHq && lastDay < clkAddDays_(today, -CLK_LEAVE_BACK_DAYS)) return clkErr_('last_day_past', CLK_MSG.LAST_DAY_PAST);
  if (lastDay > clkAddDays_(today, CLK_LEAVE_FWD_DAYS)) return clkErr_('last_day_far', CLK_MSG.LAST_DAY_FAR);
  clkSetStaffExtra_(t.s.row, t.s.hire, lastDay);
  stfLog_(t.s.emp, 'leave_set', t.a.user.id, 'last_day');
  return { ok: true, data: { emp_no: t.s.emp, last_day: lastDay, can_cancel: lastDay >= today } };
}

function handleStaffLeaveCancel_(token, payload) {
  var t = clkLeaveTarget_(token, payload);
  if (!t.ok) return t;
  if (clkStaffStatus_(t.s) === 'disabled') return clkErr_('already_disabled', CLK_MSG.ALREADY_DISABLED);
  if (!t.s.last) return clkErr_('no_leave', CLK_MSG.NO_LEAVE);
  if (t.s.last < clkTodayOf_(t.d)) return clkErr_('leave_passed', CLK_MSG.LEAVE_PASSED);
  clkSetStaffExtra_(t.s.row, t.s.hire, '');
  stfLog_(t.s.emp, 'leave_cancel', t.a.user.id, 'last_day');
  return { ok: true, data: { emp_no: t.s.emp } };
}

// ============================================================
// 7. 改名、復職（spec §4.8）
// ============================================================

function handleStaffRename_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  if (stfTooLong_(payload.name, CLK_NAME_MAX)) return clkErr_('bad_input', CLK_MSG.NAME_TOO_LONG);
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var name = stfStr_(payload.name);
  if (!name) return clkErr_('bad_input', CLK_MSG.NAME_REQUIRED);
  if (clkNameBadStart_(name)) return clkErr_('bad_input', CLK_MSG.NAME_START);
  if (name === clkStaffName_(s)) return clkErr_('no_change', CLK_MSG.NAME_SAME);
  var clash = clkNameClash_(name, clkStaffUnit_(s), s.emp);
  if (clash) return clash;
  var d = new Date();
  var v = s.values.slice(0, STF_COL_COUNT);
  v[STF_COL.name] = name;
  v[STF_COL.updated_at] = clkNowText_(d);
  stfWriteRow_(STF_SHEET, s.row, v, STF_COL_COUNT);
  var userRow = findUsrRowById_(stfStr_(v[STF_COL.user_id]));
  if (userRow) stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.name + 1).setValue(authSafeCell_(name));
  // 已有對照的店：先標「打卡姓名不同」，下一次每日同步會用真正的名冊重算
  var pending = [];
  clkConfirmedOf_(clkMaps_(), s.emp).forEach(function (m) {
    var st = clkGetState_(CLK_PROP_SYNC_PREFIX + m.store_code, { at: '', unmapped: [], name_diff: [], payroll_diff: [] });
    if (!st.name_diff.some(function (x) { return x.emp_no === s.emp && x.emp_id === m.emp_id; })) {
      st.name_diff.push({ emp_no: s.emp, emp_id: m.emp_id });
      clkSetState_(CLK_PROP_SYNC_PREFIX + m.store_code, st);
    }
    pending.push(m.store_code);
  });
  stfLog_(s.emp, 'rename', a.user.id, 'name；打卡待改 ' + pending.length + ' 家');
  return { ok: true, data: { emp_no: s.emp, name: name, clock_stores_to_fix: pending } };
}

/**
 * 復職（總部）。preview:true → 只列出過去的對照讓總部勾；否則 stores＝要恢復打卡的店代碼陣列，
 * 同一支呼叫內：staff 恢復＋清 last_day＋每家發一張 reactivate 單。
 */
function handleStaffReinstate_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  if (clkStaffStatus_(s) !== 'disabled') return clkErr_('not_disabled', CLK_MSG.NOT_DISABLED);
  var maps = clkConfirmedOf_(clkMaps_(), s.emp);
  var past = maps.map(function (m) {
    var st = clkStoreByCode_(m.store_code);
    return { store_code: m.store_code, store_name: st ? st.store_name : '', emp_id: m.emp_id, role: m.role, roster_active: m.roster_active === 'TRUE' };
  });
  if (payload.preview === true) return { ok: true, data: { emp_no: s.emp, preview: true, maps: past } };

  var pick = Array.isArray(payload.stores) ? payload.stores.map(clkCode_) : [];
  var bad = pick.filter(function (c) { return !maps.some(function (m) { return m.store_code === c; }); });
  if (bad.length) return clkErr_('no_map', CLK_MSG.NO_MAP);
  var d = new Date();
  var res = clkEnableStaff_(s, a.user.id, 'reinstate', d);
  if (!res.ok) return res;
  clkSetStaffExtra_(s.row, s.hire, '');
  var jobs = clkJobs_();
  var used = clkUsedIds_(jobs);
  var made = [];
  maps.forEach(function (m) {
    if (pick.indexOf(m.store_code) === -1 || clkOpenJob_(jobs, 'reactivate', s.emp, m.store_code, m.emp_id)) return;
    var j = clkEnqueue_({ kind: 'reactivate', emp_no: s.emp, store_code: m.store_code, emp_id: m.emp_id,
      expect: { map: m.store_code + ':' + m.emp_id, emp_no: s.emp, state: 'confirmed', staff: 'active', by: clkActorLabel_(a), uid: String(a.user.id) } }, d, used);
    made.push(j.job_id);
  });
  stfLog_(s.emp, 'reinstate', a.user.id, '恢復打卡 ' + made.length + ' 家');
  return { ok: true, data: { emp_no: s.emp, job_ids: made } };
}

// ============================================================
// 8. 打卡對照：建立／列表／決定
// ============================================================

function clkOrgOfStaff_(s, org) {
  var u = org.unit[clkStaffUnit_(s)];
  return { unit: clkStaffUnit_(s), unit_name: u ? u.name : '' };
}

/** 總部按「建立打卡對照」：做前置檢查，通過就寫一張 kind=build 的待辦單，同步員撿到後拉六店名冊再呼叫 clockMapBuildApply_ */
function handleClockMapBuild_(token) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var all = clkStaffAll_();
  var have = {};
  all.forEach(function (s) { have[s.emp] = true; });
  for (var i = 1; i <= CLK_BASELINE_COUNT; i++) {
    if (!have[stfEmpOf_(i)]) return clkErr_('precheck_baseline', CLK_MSG.PRECHECK_BASELINE);
  }
  var seen = {}, dup = 0;
  all.forEach(function (s) {
    if (clkStaffStatus_(s) === 'disabled') return;
    var n = clkNormName_(clkStaffName_(s));
    if (n === '') return;
    if (seen[n]) dup++; seen[n] = true;
  });
  if (dup) return clkErr_('precheck_dup_name', CLK_MSG.PRECHECK_DUP_NAME);
  var jobs = clkJobs_();
  if (jobs.some(function (j) { return j.state === 'pending' || j.state === 'running' || j.state === 'failed'; })) {
    return clkErr_('precheck_outbox', CLK_MSG.PRECHECK_OUTBOX);
  }
  if (!clkStores_().some(function (s) { return s.enabled; })) return clkErr_('precheck_no_store', CLK_MSG.PRECHECK_NO_STORE);
  var d = new Date();
  var job = clkEnqueue_({ kind: 'build', expect: { by: clkActorLabel_(a), uid: String(a.user.id) } }, d, clkUsedIds_(jobs));
  stfLog_('', 'map_build', a.user.id, job.job_id);
  return { ok: true, data: { job_id: job.job_id } };
}

function clkMapRowView_(m, s, org, stores) {
  var st = stores[m.store_code];
  var o = s ? clkOrgOfStaff_(s, org) : { unit: '', unit_name: '' };
  return { emp_no: m.emp_no, name: s ? clkStaffName_(s) : '', unit: o.unit, unit_name: o.unit_name,
    store_code: m.store_code, store_name: st ? st.store_name : '', emp_id: m.emp_id, role: m.role, state: m.state,
    source: m.source, roster_active: m.roster_active === 'TRUE' ? true : (m.roster_active === 'FALSE' ? false : null),
    last_punch: m.last_punch, pinned: clkPins_()[m.emp_no] === m.store_code };
}
function clkStoreIndex_() { var o = {}; clkStores_().forEach(function (s) { o[s.store_code] = s; }); return o; }
function clkStaffIndex_() { var o = {}; clkStaffAll_().forEach(function (s) { o[s.emp] = s; }); return o; }

function handleClockMapList_(token) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  if (!clkSheetsReady_()) return { ok: true, data: { suggested: [], confirmed: [], needs_hq: [], candidates: [], confirmed_count: 0, built_at: '' } };
  var stores = clkStoreIndex_(), staff = clkStaffIndex_();
  var myStoreL = a.scope ? clkStoreOfUnit_(a.scope.unit) : null;
  var maps = clkMaps_();
  var suggested = maps.filter(function (m) {
    if (m.state !== 'suggested' || !m.emp_no) return false;
    // 店長：對照列的 store_code 屬於他單位對應的店就看得到（包含單位還是空的未認領者）
    return a.isHq || (!!myStoreL && m.store_code === myStoreL.store_code);
  }).map(function (m) { return clkMapRowView_(m, staff[m.emp_no], a.org, stores); });
  var data = { suggested: suggested, confirmed: [], needs_hq: [], candidates: [], confirmed_count: maps.filter(function (m) { return m.state === 'confirmed'; }).length, built_at: '' };
  if (a.isHq) {
    // 全部已生效對照（總部才有；店長看到空陣列）
    data.confirmed = maps.filter(function (m) { return m.state === 'confirmed' && m.emp_no; })
      .map(function (m) { return clkMapRowView_(m, staff[m.emp_no], a.org, stores); });
    var st = clkGetState_(CLK_PROP_MAP_STATE, { built_at: '', candidates: [], needs_hq: [], excluded: [] });
    data.built_at = st.built_at || '';
    data.candidates = st.candidates || [];
    data.needs_hq = (st.needs_hq || []).map(function (n) {
      var opts = (n.emp_nos || []).map(function (e) {
        var s = staff[e];
        return s ? { emp_no: e, name: clkStaffName_(s), unit: clkStaffUnit_(s) } : { emp_no: e, name: '', unit: '' };
      });
      return { kind: n.kind, name: n.name, entries: n.entries, options: opts };
    });
  }
  return { ok: true, data: data };
}

/**
 * 決定一筆對照。payload：{store_code, emp_id, decision:'confirm'|'reject', emp_no?, role?}
 * - 店長：只能決定自己單位、state＝suggested 的列；confirm＝生效；reject＝標 rejected 並轉總部（needs_hq）。
 * - 總部：可指定 emp_no（把任一打卡編號指給任一 DZY）、可改已 confirmed 的列。
 */
function handleClockMapDecide_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var store = clkCode_(payload.store_code), eid = clkEid_(payload.emp_id), decision = stfStr_(payload.decision);
  if (!store || !eid || (decision !== 'confirm' && decision !== 'reject')) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  if (stfTooLong_(payload.emp_id, 32) || stfTooLong_(payload.store_code, 16)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  var st = clkStoreByCode_(store);
  if (!st) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  var maps = clkMaps_();
  var row = clkMapFind_(maps, store, eid);
  var d = new Date();
  var by = clkActorLabel_(a);
  var emp = row ? row.emp_no : '';

  // 這個打卡編號有送出中（running）的單時禁止改綁／退回：單送出的是舊對照，回填會蓋到新對照
  var targetEmp = (a.isHq && payload.emp_no !== undefined && payload.emp_no !== '') ? stfNormEmp_(payload.emp_no) : emp;
  // 不以對照列存在為前提（補償單沒有對照列）；lease 過期的 running 視同 pending，不擋
  if ((!row || decision === 'reject' || row.emp_no !== targetEmp) && clkInFlightFor_(store, eid, clkNowText_(d))) {
    return clkErr_('job_open', CLK_MSG.JOB_OPEN);
  }
  if (!a.isHq) {
    // 店長：必須是自己單位、suggested、而且不能改指給別人
    if (!row || row.state !== 'suggested') return clkErr_('dead_state', CLK_MSG.DEAD_STATE);
    // 店長只能決定「自己店」那家打卡帳號的對照（不看 DZY 單位：未認領的人單位是空的）
    var myStore = clkStoreOfUnit_(a.scope.unit);
    if (!myStore || row.store_code !== myStore.store_code) return clkErr_('no_perm', CLK_MSG.NO_PERM);
    if (payload.emp_no !== undefined && stfNormEmp_(payload.emp_no) !== row.emp_no) return clkErr_('no_perm', CLK_MSG.NO_PERM);
  } else if (payload.emp_no !== undefined && payload.emp_no !== '') {
    emp = stfNormEmp_(payload.emp_no);
  }

  if (decision === 'reject') {
    if (!row) return clkErr_('dead_state', CLK_MSG.DEAD_STATE);
    var wasOwner = row.emp_no;
    row.state = 'rejected'; row.confirmed_by = by; row.confirmed_at = clkNowText_(d);
    clkMapSave_(row, d);
    if (!a.isHq) {   // 店長按「不對」→ 轉總部
      var ms = clkGetState_(CLK_PROP_MAP_STATE, { built_at: '', candidates: [], needs_hq: [], excluded: [] });
      var who = clkStaffByEmp_(wasOwner);
      ms.needs_hq = (ms.needs_hq || []).filter(function (n) { return !(n.kind === 'escalated' && n.entries && n.entries[0] && n.entries[0].store_code === store && n.entries[0].emp_id === eid); });
      ms.needs_hq.push({ kind: 'escalated', name: who ? clkStaffName_(who) : '', entries: [{ store_code: store, emp_id: eid }], emp_nos: [wasOwner] });
      clkSetState_(CLK_PROP_MAP_STATE, ms);
    }
    stfLog_(wasOwner, 'map_reject', a.user.id, store + ':' + eid);
    return { ok: true, data: { store_code: store, emp_id: eid, state: 'rejected', escalated: !a.isHq } };
  }

  // confirm
  if (!emp) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  var target = clkStaffByEmp_(emp);
  if (!target) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  // 同人同店只一個 confirmed
  var clash = maps.filter(function (m) { return m.emp_no === emp && m.store_code === store && m.state === 'confirmed' && m.emp_id !== eid; });
  if (clash.length) return clkErr_('dup_confirmed', CLK_MSG.DUP_CONFIRMED);
  // 一個打卡編號只能對一個人：已經 confirmed 給別人的，不能被店長改；總部可以（記 log）
  if (row && row.state === 'confirmed' && row.emp_no !== emp && !a.isHq) return clkErr_('emp_id_taken', CLK_MSG.EMP_ID_TAKEN);
  var role = (a.isHq ? stfStr_(payload.role) : '') || (row && row.role) || '';
  if (['home', 'support'].indexOf(role) === -1 && role !== '') return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  if (!role) {
    var hs = clkHomeStoreFor_(target, maps);
    role = (hs.store === store) ? 'home' : 'support';
    // 預設推算的 home 不去搶已經生效的主店（只有總部明確指定 role 才會報 home_exists）
    if (role === 'home' && maps.some(function (m) { return m.emp_no === emp && m.state === 'confirmed' && m.role === 'home' && m.store_code !== store; })) role = 'support';
  }
  if (role === 'home' && maps.some(function (m) { return m.emp_no === emp && m.state === 'confirmed' && m.role === 'home' && m.store_code !== store; })) {
    return clkErr_('home_exists', CLK_MSG.HOME_EXISTS);
  }
  if (!row) {
    row = clkNewMap_(emp, store, eid, role, 'confirmed', 'name_match', '', by, d);
  } else {
    row.emp_no = emp; row.role = role; row.state = 'confirmed'; row.confirmed_by = by; row.confirmed_at = clkNowText_(d);
    clkMapSave_(row, d);
  }
  stfLog_(emp, 'map_confirm', a.user.id, store + ':' + eid + ' ' + role);
  return { ok: true, data: { emp_no: emp, store_code: store, emp_id: eid, role: role, state: 'confirmed' } };
}

/**
 * 總部指定主店（釘選）。payload：{emp_no, store_code}；store_code 空字串＝清除釘選。
 * 該人在該店必須有 confirmed 對照（bad_input）。立刻把那店 confirmed 對照設 home、其他 confirmed 設 support；
 * 不改 state、不發任何打卡單。釘選存 Script Property CLOCK_HOME_PIN；每日重算與 build／decide 都尊重它
 * （單位對得到店的人仍以單位為準；釘選的對照被停用或 rejected 時自動失效）。
 */
function handleClockSetHome_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var store = clkCode_(payload.store_code);
  var d = new Date();
  var pins = clkPins_();
  if (!store) {
    delete pins[s.emp];
    clkSetState_(CLK_PROP_HOME_PIN, pins);
    var n = clkRecomputeRoles_(s.emp, d, 'unpin');
    stfLog_(s.emp, 'home_pin', a.user.id, 'clear');
    return { ok: true, data: { emp_no: s.emp, store_code: '', pinned: false, role_changes: n } };
  }
  var maps = clkMaps_();
  if (!clkStoreByCode_(store) || !maps.some(function (m) { return m.emp_no === s.emp && m.store_code === store && m.state === 'confirmed'; })) {
    return clkErr_('bad_input', '這位同仁在這家店沒有生效的打卡對照，不能指定為主店');
  }
  pins[s.emp] = store;
  clkSetState_(CLK_PROP_HOME_PIN, pins);
  var changed = 0;
  maps.forEach(function (m) {
    if (m.emp_no !== s.emp || m.state !== 'confirmed') return;
    var want = m.store_code === store ? 'home' : 'support';
    if (m.role !== want) { m.role = want; clkMapSave_(m, d); changed++; }
  });
  stfLog_(s.emp, 'home_pin', a.user.id, store);
  return { ok: true, data: { emp_no: s.emp, store_code: store, pinned: true, role_changes: changed } };
}

/** 總部確認候選新人是真人 → 補 DZY（unclaimed）＋把他在各店的打卡編號全部 confirmed。payload：{candidate_key, unit, title, dept?, hire_date?} */
function handleClockCandidateCreate_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var ms = clkGetState_(CLK_PROP_MAP_STATE, { built_at: '', candidates: [], needs_hq: [], excluded: [] });
  var cand = null;
  (ms.candidates || []).forEach(function (c) { if (c.key === stfStr_(payload.candidate_key)) cand = c; });
  if (!cand) return clkErr_('not_found', '找不到這個候選新人');
  var unit = stfStr_(payload.unit);
  if (!unit && cand.entries[0]) {
    // 店 → 單位：該店只對一個單位才可預設；總部這種對到多個單位的店不得自動猜，要總部指定
    var s0 = clkStoreByCode_(cand.entries[0].store_code);
    var us0 = s0 ? clkUnitsOf_(s0) : [];
    if (us0.length > 1) return clkErr_('bad_input', '這家店對應多個單位（' + us0.join('、') + '），請指定單位');
    unit = us0[0] || '';
  }
  var o = clkResolveOrg_(a, { unit: unit, title: payload.title, dept: payload.dept });
  if (!o.ok) return o;
  var hire = stfStr_(payload.hire_date);
  if (hire && !clkValidYmd_(hire)) return clkErr_('bad_input', CLK_MSG.HIRE_DATE);
  var name = stfStr_(cand.name);
  if (name.length > CLK_NAME_MAX) return clkErr_('bad_input', CLK_MSG.NAME_TOO_LONG);
  if (clkNameBadStart_(name)) return clkErr_('bad_input', CLK_MSG.NAME_START);
  var clash = clkNameClash_(name, o.unit, '');
  if (clash) return clash;
  var nowC = clkNowText_(new Date());
  if (cand.entries.some(function (e) { return clkInFlightFor_(clkCode_(e.store_code), clkEid_(e.emp_id), nowC); })) return clkErr_('job_open', CLK_MSG.JOB_OPEN);
  var n = stfMaxEmpNum_() + 1;
  if (n > 999) return clkErr_('full', CLK_MSG.FULL);
  var empNo = stfEmpOf_(n);
  if (stfFindByEmp_(empNo) || findUsrRowByUsername_(empNo)) return clkErr_('emp_conflict', CLK_MSG.EMP_CONFLICT);
  var d = new Date();
  var rows = clkNewStaffRows_(empNo, name, o, hire, '', clkNowText_(d));
  stfAppendBlock_(USR_SHEET_USERS, [rows.user], USR_COL_COUNT, false);
  stfAppendBlock_(STF_SHEET, [rows.staff], STF_COL_COUNT + CLK_STAFF_EXTRA.length, true);
  var home = clkStoreOfUnit_(o.unit), homeDone = false, by = clkActorLabel_(a);
  cand.entries.forEach(function (e) {
    var role = (home && home.store_code === e.store_code && !homeDone) ? 'home' : 'support';
    if (role === 'home') homeDone = true;
    clkNewMap_(empNo, e.store_code, clkEid_(e.emp_id), role, 'confirmed', 'roster_seen', true, by, d);
  });
  ms.candidates = ms.candidates.filter(function (c) { return c.key !== cand.key; });
  clkSetState_(CLK_PROP_MAP_STATE, ms);
  stfLog_(empNo, 'add_from_candidate', a.user.id, '單位 ' + o.unit);
  return { ok: true, data: { emp_no: empNo, unit: o.unit } };
}

/** 總部排除候選新人（TEST、錯字）：之後重建對照不會再出現 */
function handleClockCandidateDismiss_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ms = clkGetState_(CLK_PROP_MAP_STATE, { built_at: '', candidates: [], needs_hq: [], excluded: [] });
  var cand = null;
  (ms.candidates || []).forEach(function (c) { if (c.key === stfStr_(payload.candidate_key)) cand = c; });
  if (!cand) return clkErr_('not_found', '找不到這個候選新人');
  ms.excluded = ms.excluded || [];
  cand.entries.forEach(function (e) { ms.excluded.push(e.store_code + ':' + clkEid_(e.emp_id)); });
  ms.candidates = ms.candidates.filter(function (c) { return c.key !== cand.key; });
  clkSetState_(CLK_PROP_MAP_STATE, ms);
  stfLog_('', 'candidate_dismiss', a.user.id, cand.key);
  return { ok: true, data: { candidate_key: cand.key } };
}

// ============================================================
// 9. 待辦單：重試、狀態、打卡連結
// ============================================================

function handleClockOutboxRetry_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var jobs = clkJobs_();
  var j = clkJobById_(jobs, stfStr_(payload && payload.job_id));
  if (!j) return clkErr_('no_job', CLK_MSG.NO_JOB);
  var stuck = clkJobStuck_(j, clkNowText_(new Date()));
  if (!stuck) return clkErr_('not_retryable', CLK_MSG.NOT_RETRYABLE);
  var d = new Date();
  j.state = 'pending'; j.tries = 0; j.next_at = clkNowText_(d); j.lease_until = ''; j.last_error = '';
  clkJobSave_(j, d);
  stfLog_(j.emp_no, 'outbox_retry', a.user.id, j.job_id);
  return { ok: true, data: { job_id: j.job_id, state: 'pending' } };
}

/**
 * 結案：永久失敗（或卡住）的單不會自己消失，總部確認不用做了就取消（failed → cancelled，記原因與 staff_log）。
 * 輸入 {job_id, reason?}。只有 failed，或未完成且 tries≥3 的單可取消。
 */
function handleClockOutboxCancel_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  var ready = clkReady_();
  if (!ready.ok) return ready;
  payload = payload || {};
  var j = clkJobById_(clkJobs_(), stfStr_(payload.job_id));
  if (!j) return clkErr_('no_job', CLK_MSG.NO_JOB);
  var stuck = clkJobStuck_(j, clkNowText_(new Date()));
  if (!stuck) return clkErr_('not_retryable', CLK_MSG.NOT_RETRYABLE);
  var reason = stfStr_(payload.reason).slice(0, 100);
  var d = new Date();
  j.state = 'cancelled'; j.lease_until = ''; j.next_at = ''; j.done_at = clkNowText_(d);
  j.last_error = authSafeCell_('總部取消' + (reason ? '：' + reason : '') + '（原錯誤 ' + stfStr_(j.last_error).slice(0, 80) + '）');
  clkJobSave_(j, d);
  stfLog_(j.emp_no, 'outbox_cancel', a.user.id, j.kind + ' ' + j.job_id);
  return { ok: true, data: { job_id: j.job_id, state: 'cancelled' } };
}

/**
 * 在主店建打卡帳號（2026-10-14，第 4 段；只有總部）：給 no_home_map 異常列用。
 * 輸入 {emp_no}。條件：在職（未停用、離職日未過）、有單位、單位對得到啟用的打卡店、那家沒有 confirmed 對照、
 * 沒有同店未完成的 add 單 → 開一張 add 單（role home；寫法同 staffCreateByUnit，另帶 demote_old：成功後別家舊主店改 support 並問總部）。
 * CLOCK_WRITE=0 時同步員不送，單停在 pending，畫面顯示「打卡建檔中」（同一般 add 單）。
 * 錯誤：no_perm、not_found、already_disabled、already_left、no_unit、no_clock_store、dup_confirmed、job_open、setup_failed。
 */
function handleClockAddHome_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  if (stfTooLong_(payload.emp_no, STF_MAX.emp_no)) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  var d = new Date();
  if (clkStaffStatus_(s) === 'disabled') return clkErr_('already_disabled', CLK_MSG.ALREADY_DISABLED);
  if (s.last && s.last < clkTodayOf_(d)) return clkErr_('already_left', CLK_MSG.ADD_HOME_LEFT);
  var unit = clkStaffUnit_(s);
  if (!unit) return clkErr_('no_unit', CLK_MSG.ADD_HOME_NO_UNIT);
  var store = clkStoreOfUnit_(unit);
  if (!store) return clkErr_('no_clock_store', CLK_MSG.NO_CLOCK_STORE);
  var here = clkConfirmedOf_(clkMaps_(), s.emp).filter(function (m) { return m.store_code === store.store_code; })[0];
  if (here) return clkErr_('dup_confirmed', CLK_MSG.ADD_HOME_HAS_MAP + '（' + store.store_code + ':' + here.emp_id + '）');
  var jobs = clkJobs_();
  var open = clkOpenJob_(jobs, 'add', s.emp, store.store_code, '');
  if (open) return clkErr_('job_open', CLK_MSG.ADD_HOME_JOB_OPEN + '（' + open.job_id + '）');
  var name = clkStaffName_(s);
  var job = clkEnqueue_({ kind: 'add', emp_no: s.emp, store_code: store.store_code, name: name,
    expect: { emp_no: s.emp, store_code: store.store_code, name: name, by: clkActorLabel_(a), uid: String(a.user.id), demote_old: true } }, d, clkUsedIds_(jobs));
  stfLog_(s.emp, 'add_home', a.user.id, '單位 ' + unit + '；待辦單 ' + job.job_id);
  return { ok: true, data: { emp_no: s.emp, job_id: job.job_id, store_code: store.store_code, state: job.state } };
}

/** 這個人（emp_no）的單位，呼叫者管不管得到；build 單只有總部 */
function clkCanSeeJob_(a, j) {
  if (a.isHq) return true;
  if (!j.emp_no) return false;
  var s = clkStaffByEmp_(j.emp_no);
  return !!s && clkCanManageUnit_(a, clkStaffUnit_(s));
}

/** 顯示打卡連結：寫一張 kind=link 單（不寫金鑰）。payload：{emp_no, store_code?}（預設主店） */
function handleClockLink_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var s = clkStaffByEmp_(payload.emp_no);
  if (!s) return clkErr_('not_found', CLK_MSG.NOT_FOUND);
  if (!clkCanManageUnit_(a, clkStaffUnit_(s))) return clkErr_('no_perm', CLK_MSG.NO_PERM);
  if (clkStaffStatus_(s) === 'disabled') return clkErr_('disabled', CLK_MSG.ALREADY_DISABLED);
  var confirmed = clkConfirmedOf_(clkMaps_(), s.emp);
  var want = clkCode_(payload.store_code);
  var m = null;
  confirmed.forEach(function (x) {
    if (want ? x.store_code === want : (x.role === 'home' && !m)) m = x;
  });
  if (!m) return clkErr_('no_map', CLK_MSG.NO_MAP);
  if (m.role !== 'home' && !a.isHq) return clkErr_('no_perm', CLK_MSG.SUPPORT_LINK_HQ);   // 支援店連結只給總部
  var d = new Date();
  var jobs = clkJobs_();
  var j = clkEnqueue_({ kind: 'link', emp_no: s.emp, store_code: m.store_code, emp_id: m.emp_id,
    expect: { map: m.store_code + ':' + m.emp_id, emp_no: s.emp, state: 'confirmed', staff: 'active', by: clkActorLabel_(a), uid: String(a.user.id) } }, d, clkUsedIds_(jobs));
  stfLog_(s.emp, 'clock_link', a.user.id, m.store_code);   // 只記有人要過連結，不記金鑰
  return { ok: true, data: { job_id: j.job_id } };
}

/**
 * 查待辦單狀態。kind=link 且已完成時，金鑰從 CacheService 取一次就刪（只給當初要連結的那個人）。
 * 輸出：{job_id, kind, state, emp_no, store_code, emp_id, tries, last_error, link_key?, link_expired?}
 */
function handleClockJobStatus_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  if (!clkSheetsReady_()) return clkErr_('no_job', CLK_MSG.NO_JOB);
  var j = clkJobById_(clkJobs_(), stfStr_(payload && payload.job_id));
  if (!j || !clkCanSeeJob_(a, j)) return clkErr_('no_job', CLK_MSG.NO_JOB);
  var out = { job_id: j.job_id, kind: j.kind, state: j.state, emp_no: j.emp_no, store_code: j.store_code,
    emp_id: j.emp_id, tries: j.tries, last_error: stfStr_(j.last_error) };
  if (j.kind === 'link' && j.state === 'done') {
    var ex = clkJson_(j.expect_json, {});
    if (String(ex.uid || '') === String(a.user.id)) {
      var cache = CacheService.getScriptCache();
      var key = cache.get(CLK_CACHE_LINK_PREFIX + j.job_id);
      if (key) { out.link_key = key; cache.remove(CLK_CACHE_LINK_PREFIX + j.job_id); } else { out.link_expired = true; }
    }
  }
  return { ok: true, data: out };
}

// ============================================================
// 10. 內部函式（給同步員經 runGas 呼叫；不進分派表）
// ============================================================

/** 內部函式共用的寫入鎖（Code.gs 的寫入鎖只包對外 action；內部函式自己拿）。拿不到回 busy */
function clkWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return clkErr_('busy', CLK_MSG.BUSY);
  try {
    var ready = clkReady_();
    if (!ready.ok) return ready;
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 送出前重驗（expect_json）：回 null＝可送；字串＝取消原因 */
function clkJobInvalid_(j, maps, staffByEmp, d) {
  var ex = clkJson_(j.expect_json, {});
  if (j.kind === 'build') return null;
  if (ex.comp) {   // 補償停用單：只在這個打卡編號已被人合法對照（confirmed）時取消
    var cm = clkMapFind_(maps, j.store_code, j.emp_id);
    return (cm && cm.state === 'confirmed') ? '這個打卡編號已經有生效對照' : null;
  }
  // 已經試著送過的 add 單（tries>0，或 running 過期＝可能已送達）不取消：打卡端已有（或可能有）這個人，
  // 取消會留下平台沒對照、沒人會停的在職帳號。照送（svc_add 以 origin_op 冪等），之後由對帳／離職連動處理
  if (j.kind === 'add' && (Number(j.tries) > 0 || j.state === 'running')) return null;
  var s = staffByEmp[j.emp_no];
  if (!s) return '同仁已不存在';
  var status = clkStaffStatus_(s);
  var expectStaff = ex.staff || (j.kind === 'deactivate' ? 'disabled' : 'active');
  if (j.kind === 'add') {
    if (status === 'disabled' || (s.last && s.last < clkTodayOf_(d))) return '同仁已停用或已離職';
    var st = clkStoreByCode_(j.store_code);
    if (!st || !st.enabled) return '這家店已停用打卡';
    var have = clkConfirmedOf_(maps, j.emp_no).some(function (m) { return m.store_code === j.store_code && m.role === 'home'; });
    if (have) return '這家店已經有生效的主店對照';
    return null;
  }
  if ((expectStaff === 'disabled') !== (status === 'disabled')) return '同仁狀態已改變';
  var key = j.store_code + ':' + j.emp_id;
  if (ex.map && ex.map !== key) return '對照內容已改變';
  var m = clkMapFind_(maps, j.store_code, j.emp_id);
  if (!m || m.emp_no !== j.emp_no) return '對照已被更正';
  if (m.state !== (ex.state || 'confirmed')) return '對照已取消或改過';
  return null;
}

/**
 * 撿單。輸入 now（Date／毫秒／台北時間字串），limit 預設 10，kinds（選填）只撿這些 kind。
 * 撿 state＝pending 且 next_at≤now，或 state＝running 且 lease_until＜now；先重驗 expect_json，
 * 不通過的轉 cancelled（不回傳）；通過的轉 running、lease_until＝now+5 分鐘。
 * 回 {ok:true, data:{jobs:[{job_id,kind,emp_no,store_code,emp_id,name,op_id,tries,by}], cancelled:[job_id]}}
 */
function clockOutboxClaim_(now, limit, kinds) {
  return clkWithLock_(function () {
    var d = clkDate_(now), nowText = clkNowText_(d);
    var max = Math.max(1, Math.min(50, Number(limit) || 10));
    var jobs = clkJobs_();
    var maps = clkMaps_();
    var staff = clkStaffIndex_();
    var out = [], cancelled = [];
    for (var i = 0; i < jobs.length && out.length < max; i++) {
      var j = jobs[i];
      if (Array.isArray(kinds) && kinds.indexOf(j.kind) === -1) continue;   // 例：CLOCK_WRITE=0 時只收 ['link','build']
      var due = (j.state === 'pending' && stfStr_(j.next_at) <= nowText) ||
        (j.state === 'running' && stfStr_(j.lease_until) < nowText);
      if (!due) continue;
      var why = clkJobInvalid_(j, maps, staff, d);
      if (why) {
        j.state = 'cancelled'; j.last_error = why; j.lease_until = ''; j.done_at = nowText;
        clkJobSave_(j, d);
        cancelled.push(j.job_id);
        continue;
      }
      var sendName = j.name;
      if (j.kind === 'add') {   // 排隊期間改過名 → 用現在的姓名建；給打卡端的是原字串（待辦單格子裡的 authSafeCell_ 前導單引號不外送）
        var nm = clkStaffName_(staff[j.emp_no]);
        if (nm) { sendName = nm; if (nm !== j.name && authSafeCell_(nm) !== j.name) j.name = authSafeCell_(nm); }
        else sendName = clkUnquote_(j.name);
      }
      if (j.state === 'running') {   // 上一次撿走後 5 分鐘沒回填（同步員當掉）：算一次失敗，才到得了紅燈
        j.tries = (Number(j.tries) || 0) + 1;
        j.last_error = 'lease_expired';
      }
      j.state = 'running';
      j.lease_until = clkNowText_(clkAddMinutes_(d, CLK_LEASE_MINUTES));
      clkJobSave_(j, d);
      var ex = clkJson_(j.expect_json, {});
      out.push({ job_id: j.job_id, kind: j.kind, emp_no: j.emp_no, store_code: j.store_code, emp_id: j.emp_id,
        name: sendName, op_id: j.op_id, tries: j.tries, by: ex.by || '', comp: !!ex.comp });
    }
    return { ok: true, data: { jobs: out, cancelled: cancelled } };
  });
}

/** 去掉 authSafeCell_ 為防公式加的前導單引號（只在後面接 = + - @ 時） */
function clkUnquote_(v) { var t = String(v); return /^'[=+\-@]/.test(t) ? t.slice(1) : t; }

/** 這個人的姓名會進打卡名冊（有未被退回的對照，或單位有對應打卡）→ true */
function clkNameIntoClock_(empNo) {
  if (!clkSheetsReady_()) return false;
  var emp = stfNormEmp_(empNo);
  var s = clkStaffByEmp_(emp);
  if (s && clkStoreOfUnit_(clkStaffUnit_(s))) return true;
  return clkMapsOf_(clkMaps_(), emp).some(function (m) { return m.state !== 'rejected'; });
}

/** 這張單「送出中」：running 且 lease 還沒過期（過期＝同步員可能當掉，視同 pending，交給送前重驗） */
function clkJobInFlight_(j, nowText) { return j.state === 'running' && stfStr_(j.lease_until) >= nowText; }
/** 卡住、可由總部重試或取消：failed、未完成且 tries≥3、或 running 但 lease 已過期 */
function clkJobStuck_(j, nowText) {
  return j.state === 'failed' || (CLK_OPEN_STATES.indexOf(j.state) !== -1 && j.tries >= CLK_ALERT_TRIES) ||
    (j.state === 'running' && stfStr_(j.lease_until) < nowText);
}
/** 這個打卡編號有沒有送出中的 add／deactivate／reactivate 單（不看對照列存不存在） */
function clkInFlightFor_(store, eid, nowText) {
  return clkJobs_().some(function (j) {
    return j.store_code === store && j.emp_id === eid && ['add', 'deactivate', 'reactivate'].indexOf(j.kind) !== -1 && clkJobInFlight_(j, nowText);
  });
}

function clkRetryDelay_(tries) {
  return tries <= CLK_RETRY_MINUTES.length ? CLK_RETRY_MINUTES[tries - 1] : CLK_RETRY_LATER_MINUTES;
}

function clkPromoteHome_(maps, empNo, keepStore, d) {
  var old = [];
  maps.forEach(function (m) {
    if (m.emp_no === empNo && m.state === 'confirmed' && m.role === 'home' && m.store_code !== keepStore) {
      m.role = 'support'; clkMapSave_(m, d); old.push(m.store_code);
    }
  });
  return old;
}
function clkAddTransferAsk_(empNo, stores) {
  if (!stores.length) return;
  var ask = clkGetState_(CLK_PROP_TRANSFER_ASK, { items: [] });
  stores.forEach(function (s) {
    if (!ask.items.some(function (x) { return x.emp_no === empNo && x.store_code === s; })) ask.items.push({ emp_no: empNo, store_code: s });
  });
  clkSetState_(CLK_PROP_TRANSFER_ASK, ask);
}

/**
 * 回填結果。result：
 *   成功 {ok:true, emp_id?（add）, link_key?（link）}
 *   失敗 {ok:false, error:<打卡端代碼或 network/timeout>, message?, retry?:false}
 * add 成功 → staff_clock 寫 home／created／confirmed；deactivate/reactivate 成功 → roster_active 立刻改；
 * link 成功 → 金鑰只進 CacheService 120 秒。失敗 → 暫時性錯誤依 1/5/30 分、之後 6 小時排 next_at，
 * 永久性錯誤（duplicate_name 等）直接 failed。已經 done／cancelled 的單重複回填不改任何東西。
 */
function clockOutboxDone_(job_id, result, now) {
  return clkWithLock_(function () {
    var d = clkDate_(now), nowText = clkNowText_(d);
    var jobs = clkJobs_();
    var j = clkJobById_(jobs, stfStr_(job_id));
    if (!j) return clkErr_('no_job', CLK_MSG.NO_JOB);
    if (j.state === 'done' || j.state === 'cancelled') return { ok: true, data: { job_id: j.job_id, state: j.state, already: true } };
    result = (result && typeof result === 'object') ? result : {};
    var ex = clkJson_(j.expect_json, {});

    // G9：同步員回報店端實際狀態（actual_active）與目標不同＝這張單沒達成（店端另有人改過）——
    // 對照的 roster_active 照實寫，單轉 failed（conflict）進紅燈，不當成功
    if ((j.kind === 'deactivate' || j.kind === 'reactivate') && typeof result.actual_active === 'boolean') {
      var target = j.kind === 'reactivate';
      if (result.ok === true && result.actual_active === target) { /* 達成，走下面一般成功流程 */ }
      else if (result.actual_active !== target) {
        var cm = clkMapFind_(clkMaps_(), j.store_code, j.emp_id);
        if (cm && !ex.comp && cm.emp_no === j.emp_no) { cm.roster_active = clkBoolText_(result.actual_active); clkMapSave_(cm, d); }
        return clkFail_(j, 'conflict', '店端實際狀態與目標不同（actual_active=' + result.actual_active + '）', false, d);
      }
    }
    if (result.ok === true) {
      var maps = clkMaps_();
      if (j.kind === 'add') {
        var eid = clkEid_(result.emp_id);
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(eid)) return clkFail_(j, 'bad_input', '打卡端沒有回有效的打卡編號', false, d);
        var existing = clkMapFind_(maps, j.store_code, eid);
        if (existing && existing.emp_no !== j.emp_no) return clkFail_(j, 'conflict', '這個打卡編號已經對給別人', false, d);
        var other = maps.filter(function (m) { return m.emp_no === j.emp_no && m.store_code === j.store_code && m.state === 'confirmed' && m.emp_id !== eid; });
        if (other.length) return clkFail_(j, 'conflict', CLK_MSG.DUP_CONFIRMED, false, d);
        if (existing) {
          existing.role = 'home'; existing.state = 'confirmed'; existing.source = 'created'; existing.roster_active = clkBoolText_(result.active !== false);
          existing.confirmed_by = ex.by || '管理系統'; existing.confirmed_at = nowText; clkMapSave_(existing, d);
        } else {
          // 打卡端冪等命中已停用的列時會帶 active:false：照實寫，不假裝在職（alerts.home_stopped 會列出）
          clkNewMap_(j.emp_no, j.store_code, eid, 'home', 'confirmed', 'created', result.active !== false, ex.by || '管理系統', d);
        }
        j.emp_id = eid;
        // 排隊期間這個人已被停用（add 單照送了）：打卡端現在有個在職帳號，立刻補一張停用單，不等隔日對帳
        var gone = clkStaffByEmp_(j.emp_no);
        if (gone && (clkStaffStatus_(gone) === 'disabled' || (gone.last && gone.last < clkTodayOf_(d)))) {
          var allJobs = clkJobs_();
          if (!clkOpenJob_(allJobs, 'deactivate', j.emp_no, j.store_code, eid)) {
            clkEnqueue_({ kind: 'deactivate', emp_no: j.emp_no, store_code: j.store_code, emp_id: eid,
              expect: { map: j.store_code + ':' + eid, emp_no: j.emp_no, state: 'confirmed', staff: 'disabled', by: 'add-done' } }, d, clkUsedIds_(allJobs));
          }
        }
        if (ex.demote_old) clkAddTransferAsk_(j.emp_no, clkPromoteHome_(clkMaps_(), j.emp_no, j.store_code, d));
      } else if (j.kind === 'deactivate' || j.kind === 'reactivate') {
        var m = clkMapFind_(maps, j.store_code, j.emp_id);
        // 回填前比對 expect：送出期間這個打卡編號若被改綁給別人（或狀態變了），不拿舊單的結果去蓋新對照
        var same = m && (ex.comp ? m.state !== 'confirmed' : (m.emp_no === j.emp_no && m.state === (ex.state || 'confirmed')));
        if (same) {
          m.roster_active = j.kind === 'deactivate' ? 'FALSE' : 'TRUE';
          if (j.kind === 'deactivate' && ex.then === 'reject') { m.state = 'rejected'; }
          clkMapSave_(m, d);
        } else if (m) {
          stfLog_(j.emp_no, 'outbox_done_stale', 'sync', j.kind + ' ' + j.job_id);   // 下一次名冊同步會用真實狀態校正
        }
      } else if (j.kind === 'link') {
        var key = stfStr_(result.link_key);
        if (!key) return clkFail_(j, 'bad_input', '打卡端沒有回連結金鑰', false, d);
        CacheService.getScriptCache().put(CLK_CACHE_LINK_PREFIX + j.job_id, key, CLK_LINK_TTL_SECONDS);   // 唯一去處
      }
      j.state = 'done'; j.last_error = ''; j.lease_until = ''; j.done_at = nowText; j.next_at = '';
      clkJobSave_(j, d);
      stfLog_(j.emp_no, 'outbox_done', 'sync', j.kind + ' ' + j.job_id);
      return { ok: true, data: { job_id: j.job_id, state: 'done', emp_id: j.emp_id } };
    }

    var code = stfStr_(result.error) || 'error';
    var permanent = CLK_PERMANENT_ERRORS.indexOf(code) !== -1 || result.retry === false;
    return clkFail_(j, code, stfStr_(result.message), !permanent, d);
  });
}

function clkFail_(j, code, message, retryable, d) {
  var nowText = clkNowText_(d);
  j.tries = (Number(j.tries) || 0) + 1;
  j.last_error = authSafeCell_((code + (message ? '：' + message : '')).slice(0, 200));
  j.lease_until = '';
  if (retryable) {
    j.state = 'pending';
    j.next_at = clkNowText_(clkAddMinutes_(d, clkRetryDelay_(j.tries)));
  } else {
    j.state = 'failed';
    j.next_at = '';
  }
  j.done_at = '';
  clkJobSave_(j, d);
  stfLog_(j.emp_no, 'outbox_fail', 'sync', j.kind + ' ' + j.job_id + ' ' + code);
  return { ok: true, data: { job_id: j.job_id, state: j.state, tries: j.tries, next_at: j.next_at } };
}

// ---- 名冊同步 ----

/** 把 svc_roster 列的 LINE 四鍵寫進對照列 m（舊版名冊沒有這些鍵＝寫空字串）。回 true＝有變動 */
/** 時間值（Date 或字串）→ 毫秒；空或不是時間 → NaN（本檔自帶，舊測試沙盒不一定載入 LineAuth.gs） */
function clkLineMs_(x) {
  if (x instanceof Date) return x.getTime();
  var t = stfStr_(x);
  return t ? Date.parse(t) : NaN;
}

function clkApplyLineCols_(m, r) {
  var changed = false;
  CLK_MAP_LINE.forEach(function (k) {
    var v = stfStr_(r && r[k]);
    var cur = m[k];
    var same;
    if (k === 'line_bound_at' || k === 'line_ok_at') {
      // 試算表可能把時間字串轉成 Date：兩邊都轉毫秒比（同一時刻不重寫）；都不是時間才退回字串比對
      var a = clkLineMs_(cur), b = clkLineMs_(v);
      same = (isFinite(a) && isFinite(b)) ? a === b : stfStr_(cur) === v;
    } else {
      same = stfStr_(cur) === v;
    }
    if (!same) { m[k] = v; changed = true; }
  });
  return changed;
}

function clkSyncState_(store) { return clkGetState_(CLK_PROP_SYNC_PREFIX + store, { at: '', unmapped: [], name_diff: [], payroll_diff: [] }); }

/**
 * 每日／建對照共用：一家店的完整名冊（svc_roster 的陣列）套進 staff_clock。
 * rows：[{emp_id,name,active,created_at,removed_at,line_bound,last_punch,src_store,src_emp_id}]
 * payrollNames（選填，光復）：[{store,emp_id,name}]
 * 做的事：更新 roster_active／last_punch；名冊沒有的對照列 roster_active＝FALSE；
 * 新出現的在職列：有 src_* 且來源對照 confirmed → support／auto_support／confirmed；否則記入「打卡上有、沒對照」；
 * 首次支援的人被 B 店主管移除（名冊停用、DZY 仍在職）→ 對照標 rejected；
 * 重算「打卡姓名≠管理系統姓名」「薪資主檔姓名≠打卡名冊姓名」。
 */
function clockRosterApply_(store_code, rows, payrollNames, now) {
  return clkWithLock_(function () {
    var store = clkCode_(store_code);
    var st = clkStoreByCode_(store);
    if (!st) return clkErr_('bad_input', '不認得的店代碼');
    if (!Array.isArray(rows)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
    var d = clkDate_(now), nowText = clkNowText_(d);
    var maps = clkMaps_();
    // 空名冊而這家店已有生效對照 → 視為抓取失敗（分頁改名、網址指錯），不套用，否則整店對照會被標成停用
    if (rows.length === 0 && maps.some(function (x) { return x.store_code === store && x.state === 'confirmed'; })) {
      return clkErr_('empty_roster', CLK_MSG.EMPTY_ROSTER);
    }
    var jobsCache = null, usedIds = null;
    var staff = clkStaffIndex_();
    var inRoster = {};
    var summary = { updated: 0, created: 0, rejected: 0, unmapped: 0, name_diff: 0, payroll_diff: 0, conflicts: 0, compensated: 0 };
    var unmapped = [], nameDiff = [], by = 'roster-sync';
    var jobs = null;
    rows.forEach(function (r) {
      var eid = clkEid_(r && r.emp_id);
      if (!eid) return;
      inRoster[eid] = r;
      var active = clkTruthy_(r.active);
      var punch = stfDate_(r.last_punch || '');
      var m = clkMapFind_(maps, store, eid);
      if (m) {
        var s = staff[m.emp_no];
        var changed = false;
        var ra = clkBoolText_(active);
        if (m.roster_active !== ra) { m.roster_active = ra; changed = true; }
        if (punch && m.last_punch !== punch) { m.last_punch = punch; changed = true; }
        if (clkApplyLineCols_(m, r)) changed = true;
        // 首次支援被 B 店主管移除：DZY 仍在職 → rejected，之後不再自動加回
        if (!active && m.state === 'confirmed' && m.source === 'auto_support' && s && clkStaffStatus_(s) !== 'disabled' && !s.last) {
          m.state = 'rejected'; changed = true; summary.rejected++;
        }
        if (changed) { clkMapSave_(m, d); summary.updated++; }
        if (active && m.state === 'confirmed' && s && clkNormName_(clkStaffName_(s)) !== clkNormName_(r.name)) {
          nameDiff.push({ emp_no: m.emp_no, emp_id: eid });
        }
        return;
      }
      if (!active) return;
      // 新出現的在職列
      var srcStore = clkCode_(r.src_store), srcEid = clkEid_(r.src_emp_id);
      var src = (srcStore && srcEid) ? clkMapFind_(maps, srcStore, srcEid) : null;
      if (src && src.state === 'confirmed' && staff[src.emp_no]) {
        // 與 7A 同一套把關（clockAutoSupportCheck_）：不過 → 列為異常，並發補償停用單（店端多出來的在職帳號沒人管）
        var chk = clockAutoSupportCheck_({ store_code: store, src_store: srcStore, src_emp_id: srcEid });
        if (!chk.data.allowed) {
          summary.conflicts++;
          unmapped.push({ emp_id: eid, name: stfStr_(r.name) });
          if (!jobsCache) { jobsCache = clkJobs_(); usedIds = clkUsedIds_(jobsCache); }
          if (clkCompensateCore_(store, eid, 'roster_' + chk.data.reason, src.emp_no, d, jobsCache, usedIds)) summary.compensated++;
          return;
        }
        var nm = clkNewMap_(src.emp_no, store, eid, 'support', 'confirmed', 'auto_support', true, by, d);
        nm.last_punch = punch; clkApplyLineCols_(nm, r); clkSave_(CLK_SHEET_MAP, CLK_MAP_HEADERS, nm);
        maps.push(nm);
        summary.created++;
        return;
      }
      unmapped.push({ emp_id: eid, name: stfStr_(r.name) });
    });
    // 名冊完全沒有這個編號的對照列 → 視為不在職
    maps.forEach(function (m) {
      if (m.store_code === store && !inRoster[m.emp_id] && m.roster_active !== 'FALSE' && m.state !== 'rejected') {
        m.roster_active = 'FALSE'; clkMapSave_(m, d); summary.updated++;
      }
    });
    // 薪資主檔姓名一致檢查（B8b）
    var payrollDiff = [];
    (Array.isArray(payrollNames) ? payrollNames : []).forEach(function (p) {
      // 薪資模組的門市代碼（如 SSLGF）≠ 契約 store_code（gf）：用 clock_stores.payroll_store 對；該店沒填才退回比 store_code
      var want = stfStr_(st.payroll_store).toUpperCase() || store.toUpperCase();
      if (!p || stfStr_(p.store).toUpperCase() !== want) return;
      var r = inRoster[clkEid_(p.emp_id)];
      if (r && clkTruthy_(r.active) && clkNormName_(r.name) !== clkNormName_(p.name)) {
        payrollDiff.push({ emp_id: clkEid_(p.emp_id), roster_name: stfStr_(r.name), payroll_name: stfStr_(p.name) });
      }
    });
    clkSetState_(CLK_PROP_SYNC_PREFIX + store, { at: nowText, unmapped: unmapped, name_diff: nameDiff, payroll_diff: payrollDiff });
    summary.unmapped = unmapped.length; summary.name_diff = nameDiff.length; summary.payroll_diff = payrollDiff.length;
    return { ok: true, data: summary };
  });
}

// ---- 每日 ----

/**
 * 每日 00:10（同步員先 clockRosterApply_ 六店，再呼叫本函式）。today：'yyyy-MM-dd'（或 Date／毫秒）。
 * 1. last_day＜today 且還在職 → staff 停用（第一期 disable：token_after、登出）＋該人每個 confirmed 對照各一張 deactivate 單（同一支呼叫寫完）
 * 2. 對帳：DZY 已停用、但 confirmed 對照店名冊仍在職（roster_active＝TRUE）→ 自動補 deactivate 單（已有未完成單、或今天已完成就不重複）
 * 3. 回報異常：打卡單位在職者沒有 home 對照、也沒有有效待辦單
 * 跑兩次不重複發單。
 */
function clockDailyApply_(today) {
  return clkWithLock_(function () {
    var isYmd = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today);
    var d = isYmd ? new Date() : clkDate_(today);   // 只給日期時，時間戳用現在
    var todayText = isYmd ? today : clkTodayOf_(d);
    var jobs = clkJobs_();
    var used = clkUsedIds_(jobs);
    var maps = clkMaps_();
    var out = { today: todayText, disabled: [], disable_errors: [], jobs: [], reconcile_jobs: [], no_home_map: [] };

    var needDeactivate = function (empNo, expectExtra) {
      clkConfirmedOf_(maps, empNo).forEach(function (m) {
        if (clkOpenJob_(jobs, 'deactivate', empNo, m.store_code, m.emp_id)) return;
        var j = clkEnqueue_({ kind: 'deactivate', emp_no: empNo, store_code: m.store_code, emp_id: m.emp_id,
          expect: { map: m.store_code + ':' + m.emp_id, emp_no: empNo, state: 'confirmed', staff: 'disabled', by: 'daily' } }, d, used);
        jobs.push(j);
        expectExtra.push(j.job_id);
      });
    };

    // 1. 離職連動
    clkStaffAll_().forEach(function (s) {
      if (!s.last || s.last >= todayText || clkStaffStatus_(s) === 'disabled') return;
      var res = clkDisableStaff_(s, 'daily', 'last_day', d);
      if (!res.ok) {
        out.disable_errors.push({ emp_no: s.emp, code: res.code });
        stfLog_(s.emp, 'disable_failed', 'daily', res.code || '');   // 首頁 alerts.leave_overdue 也會列出，直到處理好
        return;
      }
      if (res.warn) {   // 平台帳號列遺失：staff 已標停用、店端停用單照發（不被本地失敗擋住），但留紀錄並進首頁異常
        out.disable_errors.push({ emp_no: s.emp, code: res.warn });
        stfLog_(s.emp, 'disable_failed', 'daily', res.warn);
      }
      out.disabled.push(s.emp);
      needDeactivate(s.emp, out.jobs);
    });

    // 2. 對帳
    var staff = clkStaffIndex_();
    maps = clkMaps_();
    maps.forEach(function (m) {
      var s = staff[m.emp_no];
      if (!s || clkStaffStatus_(s) !== 'disabled' || m.state !== 'confirmed' || m.roster_active !== 'TRUE') return;
      if (clkOpenJob_(jobs, 'deactivate', m.emp_no, m.store_code, m.emp_id)) return;
      var doneToday = jobs.some(function (j) {
        return j.kind === 'deactivate' && j.state === 'done' && j.emp_no === m.emp_no && j.store_code === m.store_code &&
          j.emp_id === m.emp_id && stfStr_(j.done_at).slice(0, 10) === todayText;
      });
      if (doneToday) return;
      var j = clkEnqueue_({ kind: 'deactivate', emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id,
        expect: { map: m.store_code + ':' + m.emp_id, emp_no: m.emp_no, state: 'confirmed', staff: 'disabled', by: 'daily' } }, d, used);
      jobs.push(j);
      out.reconcile_jobs.push(j.job_id);
    });

    // 2b. rejected 的首次支援對照（被店端移除過），打卡端帳號卻又變在職、人也還在職 → 發停用單（首頁另有 rejected_active 異常）
    out.rejected_jobs = [];
    maps = clkMaps_();
    maps.forEach(function (m) {
      var s = staff[m.emp_no];
      if (!s || m.state !== 'rejected' || m.source !== 'auto_support' || m.roster_active !== 'TRUE') return;
      if (clkStaffStatus_(s) === 'disabled' || (s.last && s.last < todayText)) return;
      if (clkOpenJob_(jobs, 'deactivate', m.emp_no, m.store_code, m.emp_id)) return;
      var doneToday = jobs.some(function (j) {
        return j.kind === 'deactivate' && j.state === 'done' && j.emp_no === m.emp_no && j.store_code === m.store_code &&
          j.emp_id === m.emp_id && stfStr_(j.done_at).slice(0, 10) === todayText;
      });
      if (doneToday) return;
      var j = clkEnqueue_({ kind: 'deactivate', emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id,
        expect: { map: m.store_code + ':' + m.emp_id, emp_no: m.emp_no, state: 'rejected', staff: 'active', by: 'daily' } }, d, used);
      jobs.push(j);
      out.rejected_jobs.push(j.job_id);
    });

    // 2c. 重算主店 role（單位空的人依打卡資料；只改 role，不改 state、不發單）
    out.role_changes = [];
    var seenEmp = {};
    clkMaps_().forEach(function (m) {
      if (!m.emp_no || seenEmp[m.emp_no] || m.state === 'rejected') return;
      seenEmp[m.emp_no] = true;
      var sx = staff[m.emp_no];
      if (!sx || clkStaffStatus_(sx) === 'disabled') return;
      if (clkRecomputeRoles_(m.emp_no, d, 'daily')) out.role_changes.push(m.emp_no);
    });

    // 3. 異常：在職者沒有 home 對照、也沒有有效待辦
    out.no_home_map = clkNoHomeMap_(clkStaffAll_(), clkMaps_(), jobs, todayText).map(function (s) { return s.emp; });
    return { ok: true, data: out };
  });
}

/** 打卡單位在職者沒有 home 對照（confirmed）、也沒有進行中的 add 單 */
function clkNoHomeMap_(staffAll, maps, jobs, todayText) {
  return staffAll.filter(function (s) {
    var status = clkStaffStatus_(s);
    if (status === 'disabled' || (s.last && s.last < todayText)) return false;
    var store = clkStoreOfUnit_(clkStaffUnit_(s));
    if (!store) return false;
    var hasHome = maps.some(function (m) { return m.emp_no === s.emp && m.store_code === store.store_code && m.state === 'confirmed' && m.role === 'home'; });
    if (hasHome) return false;
    return !jobs.some(function (j) { return j.kind === 'add' && j.emp_no === s.emp && j.store_code === store.store_code && CLK_OPEN_STATES.indexOf(j.state) !== -1; });
  });
}

// ---- 建對照 ----

/**
 * 第一次建對照（F1）：六店名冊 → 先跨店聚成「人」（同名去空白＋src_*），再拿每個人去比全部 DZY（不限單位）。
 * rostersByStore：{ gf:[roster row…], mztjs:[…], … }（只看 active）。
 * 唯一同名 → staff_clock suggested（home＝DZY 單位對應那家，其他 support）；
 * 同名多人、或一人同一家有兩個編號 → needs_hq；DZY 找不到 → candidates（不建 staff）。
 */
var CLK_SRC_AUTO_MAP = 'auto_support_map';
var CLK_AUTO_MAP_BY = '系統自動（已確認身分的跨店支援）';
function clockMapBuildApply_(rostersByStore, now) {
  return clkWithLock_(function () {
    var d = clkDate_(now), nowText = clkNowText_(d);
    var ms = clkGetState_(CLK_PROP_MAP_STATE, { built_at: '', candidates: [], needs_hq: [], excluded: [] });
    var excluded = {};
    (ms.excluded || []).forEach(function (k) { excluded[k] = true; });
    var maps = clkMaps_();
    var staffAll = clkStaffAll_();
    var entries = [], seen = {};
    Object.keys(rostersByStore || {}).forEach(function (code) {
      var store = clkStoreByCode_(code);
      if (!store) return;
      (rostersByStore[code] || []).forEach(function (r) {
        var eid = clkEid_(r && r.emp_id), name = stfStr_(r && r.name);
        if (!eid || !name || !clkTruthy_(r.active)) return;
        var key = store.store_code + ':' + eid;
        if (seen[key] || excluded[key]) return;
        seen[key] = true;
        entries.push({ store: store.store_code, eid: eid, name: name, key: key, norm: clkNormName_(name),
          src: (clkCode_(r.src_store) && clkEid_(r.src_emp_id)) ? clkCode_(r.src_store) + ':' + clkEid_(r.src_emp_id) : '',
          punch: stfDate_(r.last_punch || '') });
      });
    });
    // 聚人：union-find（同名去空白；src_* 指到的那一列）
    var parent = entries.map(function (e, i) { return i; });
    var find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    var union = function (a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    var byNorm = {}, byKey = {};
    entries.forEach(function (e, i) {
      byKey[e.key] = i;
      if (byNorm[e.norm] !== undefined) union(byNorm[e.norm], i); else byNorm[e.norm] = i;
    });
    entries.forEach(function (e, i) { if (e.src && byKey[e.src] !== undefined) union(byKey[e.src], i); });
    var groups = {};
    entries.forEach(function (e, i) { var r = find(i); (groups[r] = groups[r] || []).push(e); });

    var res = { suggested: 0, auto_confirmed: 0, kept: 0, candidates: 0, needs_hq: 0, role_changes: 0 };
    var candidates = [], needs = [];
    // 保留總部尚未處理的「店長轉來」項目（只要那一列現在仍是 rejected 且沒別的生效對照）
    (ms.needs_hq || []).forEach(function (n) {
      if (n.kind !== 'escalated') return;
      var e0 = n.entries && n.entries[0];
      var m0 = e0 ? clkMapFind_(maps, e0.store_code, clkEid_(e0.emp_id)) : null;
      if (m0 && m0.state === 'rejected') needs.push(n);
    });
    var staffByNorm = {}, deadByNorm = {}, todayB = clkTodayOf_(d);
    staffAll.forEach(function (s) {
      var n = clkNormName_(clkStaffName_(s));
      if (!n) return;
      // 名字比對只看還在職的人：已停用、或離職日已過的人不當候選（否則在職的新人會被對到舊人）
      var dead = clkStaffStatus_(s) === 'disabled' || (s.last && s.last < todayB);
      (dead ? deadByNorm : staffByNorm)[n] = (dead ? deadByNorm : staffByNorm)[n] || [];
      (dead ? deadByNorm : staffByNorm)[n].push(s);
    });
    var stores = {};
    Object.keys(groups).forEach(function (g) {
      var grp = groups[g].sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
      var name = grp[0].name;
      var view = grp.map(function (e) { return { store_code: e.store, emp_id: e.eid }; });
      var perStore = {}, dupStore = false;
      grp.forEach(function (e) { if (perStore[e.store]) dupStore = true; perStore[e.store] = true; });
      if (dupStore) { needs.push({ kind: 'dup_in_store', name: name, entries: view, emp_nos: (staffByNorm[grp[0].norm] || []).map(function (s) { return s.emp; }) }); return; }
      var cands = staffByNorm[grp[0].norm] || [];
      if (cands.length === 0 && (deadByNorm[grp[0].norm] || []).length) {   // 只對得到已離職的人：交總部，不當新人建、也不自動對照
        needs.push({ kind: 'disabled_match', name: name, entries: view, emp_nos: deadByNorm[grp[0].norm].map(function (s) { return s.emp; }) });
        return;
      }
      if (cands.length === 0) {
        if (grp.every(function (e) { return !!clkMapFind_(maps, e.store, e.eid); })) return;
        candidates.push({ key: grp[0].key, name: name, entries: view });
        return;
      }
      if (cands.length > 1) {
        needs.push({ kind: 'ambiguous', name: name, entries: view, emp_nos: cands.map(function (s) { return s.emp; }) });
        return;
      }
      var s = cands[0];
      grp.forEach(function (e) {
        var ex = clkMapFind_(maps, e.store, e.eid);
        if (ex) {
          if (ex.state === 'rejected') {
            if (!needs.some(function (n) { return n.kind === 'escalated' && n.entries[0].store_code === e.store && n.entries[0].emp_id === e.eid; })) {
              needs.push({ kind: 'rejected', name: name, entries: [{ store_code: e.store, emp_id: e.eid }], emp_nos: [s.emp] });
            }
          } else { res.kept++; }
          return;
        }
        var other = maps.filter(function (m) { return m.emp_no === s.emp && m.store_code === e.store && m.state === 'confirmed'; });
        if (other.length) {
          needs.push({ kind: 'conflict', name: name, entries: [{ store_code: e.store, emp_id: e.eid }], emp_nos: [s.emp] });
          return;
        }
        // 自動確認（Eason 2026-10-19）：身分已被人確認過的在職同仁，到「非主店」的名冊多一個編號 → 直接 confirmed／support。
        // 條件：唯一同名（含停用）、狀態 active／unclaimed、已有 confirmed 對照、這家不是主店。source 用 auto_support_map，
        // 不沿用 auto_support（那是 LINE 首次支援；被退回時 clockDailyApply_ 會對 auto_support 發停用單，這裡的帳號是本來就有的，不能停）。
        // 主店要把這一列算進去再判斷（單位空的人靠打卡推斷，新列若最近打卡就會變主店 → 不自動）
        var st = clkStaffStatus_(s), homeNow = clkHomeStoreFor_(s, maps.concat([{ emp_no: s.emp, store_code: e.store, emp_id: e.eid, role: 'support', state: 'suggested', roster_active: 'TRUE', last_punch: e.punch }])).store;
        var auto = (st === 'active' || st === 'unclaimed') && !(deadByNorm[grp[0].norm] || []).length &&
          maps.some(function (m) { return m.emp_no === s.emp && m.state === 'confirmed'; }) && !!homeNow && homeNow !== e.store;
        var row = clkNewMap_(s.emp, e.store, e.eid, 'support', auto ? 'confirmed' : 'suggested', auto ? CLK_SRC_AUTO_MAP : 'name_match', true, auto ? CLK_AUTO_MAP_BY : '', d);
        row.last_punch = e.punch; clkSave_(CLK_SHEET_MAP, CLK_MAP_HEADERS, row);
        maps.push(row);
        if (auto) { res.auto_confirmed++; stfLog_(s.emp, 'auto_support_map', 'sync', e.store + ':' + e.eid); } else res.suggested++;
      });
      // 主店依 clkHomeStoreFor_（DZY 單位優先，單位空用打卡資料推斷）；已存在的列也一起更新 role（重跑 build 也會校正）
      res.role_changes += clkRecomputeRoles_(s.emp, d, 'build');
    });
    res.candidates = candidates.length; res.needs_hq = needs.length;
    clkSetState_(CLK_PROP_MAP_STATE, { built_at: nowText, candidates: candidates, needs_hq: needs, excluded: ms.excluded || [] });
    return { ok: true, data: res };
  });
}

// ---- 補償停用 ----

/** 補償停用單（沒有生效對照的打卡帳號要被停掉）。回新單，或已有未完成的同一張，或 null（該編號已有生效對照＝合法，不補償） */
function clkCompensateCore_(store, eid, reason, empNo, d, jobs, used) {
  var cm = clkMapFind_(clkMaps_(), store, eid);
  if (cm && cm.state === 'confirmed') return null;
  for (var i = 0; i < jobs.length; i++) {
    var o = jobs[i];
    if (o.kind === 'deactivate' && o.store_code === store && o.emp_id === eid && CLK_OPEN_STATES.indexOf(o.state) !== -1 &&
        clkJson_(o.expect_json, {}).comp) return null;
  }
  var why = String(reason || 'compensate').replace(/[^A-Za-z0-9_:.\-]/g, '').slice(0, 60);
  var j = clkEnqueue_({ kind: 'deactivate', emp_no: empNo || '', store_code: store, emp_id: eid,
    expect: { comp: true, map: store + ':' + eid, reason: why, by: 'comp' } }, d, used);
  jobs.push(j);
  stfLog_(empNo || '', 'compensate', 'sync', store + ' ' + why + ' ' + j.job_id);
  return j;
}

/**
 * 給同步員：7A 在店端建好人（svc_add 成功）卻寫不進對照 → 立刻開一張補償停用單並進首頁紅燈（alerts.compensations）。
 * reason：短英數說明（如 record_failed）；emp_no 選填（知道是誰就帶）。
 * 回 {ok:true, data:{job_id, existing:boolean}}；該打卡編號已有生效（confirmed）對照 → {ok:false, code:'conflict'}。
 */
function clockCompensate_(store_code, emp_id, reason, emp_no, now) {
  return clkWithLock_(function () {
    var store = clkCode_(store_code), eid = clkEid_(emp_id);
    if (!clkStoreByCode_(store) || !/^[A-Za-z0-9_-]{1,32}$/.test(eid)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
    var d = clkDate_(now);
    var jobs = clkJobs_();
    var cm = clkMapFind_(clkMaps_(), store, eid);
    if (cm && cm.state === 'confirmed') return clkErr_('conflict', '這個打卡編號已經有生效對照，不補償');
    var before = jobs.length;
    var j = clkCompensateCore_(store, eid, reason, stfNormEmp_(emp_no), d, jobs, clkUsedIds_(jobs));
    if (j) return { ok: true, data: { job_id: j.job_id, existing: false } };
    var open = jobs.filter(function (o) { return o.kind === 'deactivate' && o.store_code === store && o.emp_id === eid && CLK_OPEN_STATES.indexOf(o.state) !== -1 && clkJson_(o.expect_json, {}).comp; })[0];
    return { ok: true, data: { job_id: open ? open.job_id : null, existing: true } };
  });
}

// ---- 7A ----

/**
 * 7A mini 把關（spec §4.4）。params：{store_code（B 店）, src_store, src_emp_id（他已綁那家）}
 * 全部成立才 allowed：來源對照 confirmed、對到的 DZY 在職且沒登記離職、B 店沒有指向他的 rejected／停用對照、B 店打卡啟用。
 * 回 {ok:true, data:{allowed:boolean, reason?, emp_no?, name?}}（唯讀，不鎖不寫）
 */
function clockAutoSupportCheck_(params) {
  var p = params || {};
  var b = clkCode_(p.store_code), src = clkCode_(p.src_store), sid = clkEid_(p.src_emp_id);
  var no = function (reason) { return { ok: true, data: { allowed: false, reason: reason } }; };
  if (!b || !src || !sid) return no('bad_input');
  if (!clkSheetsReady_()) return no('not_ready');
  var bs = clkStoreByCode_(b);
  if (!bs || !bs.enabled) return no('store_disabled');
  if (b === src) return no('same_store');
  var maps = clkMaps_();
  var sm = clkMapFind_(maps, src, sid);
  if (!sm || sm.state !== 'confirmed') return no('source_not_confirmed');
  if (sm.roster_active === 'FALSE') return no('source_stopped');   // 來源店名冊已停用：不能拿停用的帳號去別店建檔
  var s = clkStaffByEmp_(sm.emp_no);
  if (!s || clkStaffStatus_(s) === 'disabled') return no('staff_left');
  if (s.last) return no('leave_registered');
  var here = clkMapsOf_(maps, sm.emp_no).filter(function (m) { return m.store_code === b; });
  for (var i = 0; i < here.length; i++) {
    var m = here[i];
    if (m.state === 'rejected' || (m.state === 'confirmed' && m.roster_active === 'FALSE')) return no('removed_before');
    if (m.state === 'confirmed') return no('already_mapped');
    if (m.state === 'suggested') return no('suggested_exists');
  }
  return { ok: true, data: { allowed: true, emp_no: sm.emp_no, name: clkStaffName_(s), store_code: b } };
}

/**
 * 7A 建好之後寫對照（mini 用 B 店金鑰呼叫 svc_add 成功後）。params：{store_code, src_store, src_emp_id, emp_id}
 * 寫入前再把關一次（防止檢查到寫入之間狀態改變）；同一組重送冪等（同店同編號同人 → ok）。
 * 寫 staff_clock：support／auto_support／confirmed。
 */
function clockAutoSupportRecord_(params, now) {
  return clkWithLock_(function () {
    var p = params || {};
    var b = clkCode_(p.store_code), eid = clkEid_(p.emp_id);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(eid)) return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
    var d = clkDate_(now);
    var maps = clkMaps_();
    var existing = clkMapFind_(maps, b, eid);
    var sm = clkMapFind_(maps, clkCode_(p.src_store), clkEid_(p.src_emp_id));
    if (existing && sm && existing.emp_no === sm.emp_no && existing.source === 'auto_support' && existing.state === 'confirmed') {
      return { ok: true, data: { emp_no: existing.emp_no, store_code: b, emp_id: eid, already: true } };
    }
    var chk = clockAutoSupportCheck_(p);
    if (!chk.data.allowed) return clkErr_('not_allowed', '不符合自動支援條件：' + chk.data.reason);
    if (existing) return clkErr_('conflict', '這個打卡編號已經對給別人');
    clkNewMap_(chk.data.emp_no, b, eid, 'support', 'confirmed', 'auto_support', true, 'LINE 自動（首次支援）', d);
    stfLog_(chk.data.emp_no, 'auto_support', 'sync', b + ':' + eid);
    return { ok: true, data: { emp_no: chk.data.emp_no, store_code: b, emp_id: eid } };
  });
}

// ============================================================
// 11. 調店（Staff.gs 確認組織變更後的掛勾）、舊主店決定
// ============================================================

/**
 * staffConfirm／unitApprove 確認「改單位」後呼叫（已在寫入鎖內）。條件：舊單位不是空的、他已經有 confirmed 對照
 *（第一次認領把單位從空填成某單位不算調店）。
 * 新單位有打卡：他在那家已有 confirmed 對照 → 直接改成主店；否則開一張 add 單（成功時舊主店改 support 並問總部）。
 */
function clkAfterConfirm_(empNo, oldUnit, newUnit, byLabel) {
  try {
    if (!newUnit || oldUnit === newUnit || !clkSheetsReady_()) return null;
    var store = clkStoreOfUnit_(newUnit);
    if (!store) return null;
    var emp = stfNormEmp_(empNo);
    var maps = clkMaps_();
    if (!oldUnit) {
      // 認領後單位從空變有值（不是調店，不發單）：新單位的店已有這個人的對照 → 那筆改 home、其他改 support；
      // 沒有對照 → 不開 add 單，他會出現在 no_home_map 異常讓總部處理
      var atStore = maps.filter(function (m) { return m.emp_no === emp && m.state !== 'rejected' && m.store_code === store.store_code; });
      if (atStore.length) {
        var dd = new Date(), flips = 0;
        maps.forEach(function (m) {
          if (m.emp_no !== emp || m.state === 'rejected') return;
          var want = m.store_code === store.store_code ? 'home' : 'support';
          if (m.role !== want) { m.role = want; clkMapSave_(m, dd); flips++; }
        });
        if (flips) stfLog_(emp, 'role_recalc', 'system', 'claim ' + store.store_code + ' unit');
      }
      return { mode: 'claim' };
    }
    var mine = clkConfirmedOf_(maps, emp);
    if (!mine.length) return null;
    var d = new Date();
    var here = mine.filter(function (m) { return m.store_code === store.store_code; })[0];
    if (here) {
      if (here.role !== 'home') {
        here.role = 'home'; clkMapSave_(here, d);
        clkAddTransferAsk_(emp, clkPromoteHome_(clkMaps_(), emp, store.store_code, d));
      }
      return { mode: 'promote' };
    }
    var jobs = clkJobs_();
    if (clkOpenJob_(jobs, 'add', emp, store.store_code, '')) return null;
    var s = clkStaffByEmp_(emp);
    clkEnqueue_({ kind: 'add', emp_no: emp, store_code: store.store_code, name: s ? clkStaffName_(s) : '',
      expect: { emp_no: emp, store_code: store.store_code, name: s ? clkStaffName_(s) : '', by: byLabel || '', demote_old: true } }, d, clkUsedIds_(jobs));
    stfLog_(emp, 'transfer_add', 'system', '新單位 ' + newUnit);
    return { mode: 'add' };
  } catch (e) {
    console.error('[clkAfterConfirm_] ' + (e && e.message ? e.message : e));
    try {   // 不讓確認失敗，但留痕跡：staff_log 與 alerts.transfer_failed（直到他有主店對照或進行中的 add 單）
      stfLog_(stfNormEmp_(empNo), 'transfer_add_failed', 'system', '調店開單失敗');
      var tf = clkGetState_(CLK_PROP_TRANSFER_FAIL, { items: [] });
      if (tf.items.indexOf(stfNormEmp_(empNo)) === -1) tf.items.push(stfNormEmp_(empNo));
      clkSetState_(CLK_PROP_TRANSFER_FAIL, tf);
    } catch (e2) { console.error('[clkAfterConfirm_] 記錄失敗 ' + e2); }
    return { mode: 'failed', warning: 'transfer_add_failed' };
  }
}

/** 調店後舊主店：總部決定要不要停用。payload：{emp_no, store_code, deactivate:boolean} */
function handleClockOldHomeDecide_(token, payload) {
  var a = clkNeedHq_(token);
  if (!a.ok) return a;
  payload = payload || {};
  var ready = clkReady_();
  if (!ready.ok) return ready;
  var emp = stfNormEmp_(payload.emp_no), store = clkCode_(payload.store_code);
  if (typeof payload.deactivate !== 'boolean') return clkErr_('bad_input', CLK_MSG.BAD_INPUT);
  var ask = clkGetState_(CLK_PROP_TRANSFER_ASK, { items: [] });
  var hit = ask.items.filter(function (x) { return x.emp_no === emp && x.store_code === store; });
  if (!hit.length) return clkErr_('not_found', '沒有這筆待決定的舊主店');
  var d = new Date();
  var jobId = null;
  if (payload.deactivate) {
    var m = clkConfirmedOf_(clkMaps_(), emp).filter(function (x) { return x.store_code === store; })[0];
    if (!m) return clkErr_('no_map', CLK_MSG.NO_MAP);
    var jobs = clkJobs_();
    var j = clkOpenJob_(jobs, 'deactivate', emp, store, m.emp_id);
    if (!j) {
      j = clkEnqueue_({ kind: 'deactivate', emp_no: emp, store_code: store, emp_id: m.emp_id,
        expect: { map: store + ':' + m.emp_id, emp_no: emp, state: 'confirmed', staff: 'active', then: 'reject', by: clkActorLabel_(a), uid: String(a.user.id) } }, d, clkUsedIds_(jobs));
    }
    jobId = j.job_id;
  }
  ask.items = ask.items.filter(function (x) { return !(x.emp_no === emp && x.store_code === store); });
  clkSetState_(CLK_PROP_TRANSFER_ASK, ask);
  stfLog_(emp, 'old_home_decide', a.user.id, store + (payload.deactivate ? ' 停用' : ' 保留'));
  return { ok: true, data: { emp_no: emp, store_code: store, job_id: jobId } };
}

// ============================================================
// 12. 檢視：同仁名單加欄、單位名單、alerts、佈告欄名單
// ============================================================

/** 一位同仁的打卡摘要（名單與單位名單共用） */
function clkPersonClock_(empNo, maps, jobs, stores) {
  var mine = maps.filter(function (m) { return m.emp_no === empNo && m.state === 'confirmed'; });
  var open = null;
  jobs.forEach(function (j) { if (j.emp_no === empNo && j.kind === 'add' && j.state !== 'done' && j.state !== 'cancelled') open = j; });
  return {
    clocks: mine.map(function (m) {
      var st = stores[m.store_code];
      return { store_code: m.store_code, store_name: st ? st.store_name : '', emp_id: m.emp_id, role: m.role,
        roster_active: m.roster_active === 'TRUE' ? true : (m.roster_active === 'FALSE' ? false : null) };
    }),
    clock_total: mine.length,
    clock_stopped: mine.filter(function (m) { return m.roster_active === 'FALSE'; }).length,
    clock_job: open ? { job_id: open.job_id, state: open.state, tries: open.tries } : null
  };
}

/** clkNoHomeMap_ 結果轉成 {emp_no:true}（名單加欄用） */
function clkNoHomeSet_(staffAll, maps, jobs) {
  var o = {};
  clkNoHomeMap_(staffAll, maps, jobs, clkTodayOf_(new Date())).forEach(function (s) { o[s.emp] = true; });
  return o;
}

/** 打卡名冊姓名≠管理系統姓名的同仁（各店同步狀態 name_diff 合併）：{emp_no:true} */
function clkNameDiffEmps_() {
  var o = {};
  if (!clkSheetsReady_()) return o;
  clkStores_().forEach(function (st) {
    clkSyncState_(st.store_code).name_diff.forEach(function (n) { if (n.emp_no) o[n.emp_no] = true; });
  });
  return o;
}

/** handleStaffList_ 的掛勾：每位同仁多 hire_date、last_day、clocks… */
function clkDecorateStaffList_(list, token) {
  if (!clkSheetsReady_()) return list;
  var selfEmp = '';
  if (token) { var act = clkActor_(token); if (act.ok) selfEmp = act.selfEmp; }
  var nameDiff = clkNameDiffEmps_();
  var maps = clkMaps_(), jobs = clkJobs_(), stores = clkStoreIndex_(), extra = {};
  var all = clkStaffAll_();
  all.forEach(function (s) { extra[s.emp] = s; });
  var noHome = clkNoHomeSet_(all, maps, jobs);
  return list.map(function (p) {
    var s = extra[p.emp_no];
    var c = clkPersonClock_(p.emp_no, maps, jobs, stores);
    p.hire_date = s ? s.hire : ''; p.last_day = s ? s.last : '';
    p.clocks = c.clocks; p.clock_total = c.clock_total; p.clock_stopped = c.clock_stopped; p.clock_job = c.clock_job;
    p.is_self = !!selfEmp && p.emp_no === selfEmp;
    p.name_diff = !!nameDiff[p.emp_no];
    p.no_home = !!noHome[p.emp_no];   // 與 clockAlerts.no_home_map 同一套判斷（前端「沒有打卡編號」篩選用）
    return p;
  });
}

/**
 * 單位同仁名單（店長看自己單位；總部可帶 unit，不帶＝全部）。唯讀，不含手機／生日／地址。
 * 輸出每人：emp_no,name,status,unit,unit_name,title,title_name,hire_date,last_day,can_cancel_leave,clocks[],clock_total,clock_stopped,clock_job,is_self,name_diff
 */
function handleStaffUnitList_(token, payload) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  if (!stfSheetsReady_()) return { ok: true, data: { people: [] } };
  var unit = a.isHq ? stfStr_(payload && payload.unit) : a.scope.unit;
  var maps = clkSheetsReady_() ? clkMaps_() : [], jobs = clkSheetsReady_() ? clkJobs_() : [], stores = clkSheetsReady_() ? clkStoreIndex_() : {};
  var today = clkTodayOf_(new Date());
  var nameDiff = clkSheetsReady_() ? clkNameDiffEmps_() : {};
  var myStoreU = (!a.isHq && a.scope) ? clkStoreOfUnit_(a.scope.unit) : null;
  var staffAll = clkStaffAll_();
  var noHome = clkSheetsReady_() ? clkNoHomeSet_(staffAll, maps, jobs) : {};
  var people = staffAll.filter(function (s) {
    if (!unit || clkStaffUnit_(s) === unit) return true;
    // 店長：單位還是空的（未認領）、但在他那家店有對照的人也要看得到
    return !a.isHq && clkStaffUnit_(s) === '' && !!myStoreU && maps.some(function (m) { return m.emp_no === s.emp && m.store_code === myStoreU.store_code && m.state !== 'rejected'; });
  }).map(function (s) {
    var o = stfToObj_(s.values, a.org, false);
    var c = clkPersonClock_(s.emp, maps, jobs, stores);
    return { emp_no: s.emp, name: o.name, status: o.status, unit: o.unit, unit_name: o.unit_name, title: o.title, title_name: o.title_name,
      hire_date: s.hire, last_day: s.last, can_cancel_leave: !!s.last && s.last >= today && o.status !== 'disabled',
      clocks: c.clocks, clock_total: c.clock_total, clock_stopped: c.clock_stopped, clock_job: c.clock_job,
      is_self: !!a.selfEmp && s.emp === a.selfEmp, name_diff: !!nameDiff[s.emp], unit_empty: clkStaffUnit_(s) === '', no_home: !!noHome[s.emp] };
  });
  return { ok: true, data: { people: people, unit: unit } };
}

/**
 * 首頁「待辦與異常」資料。總部看全部；店長只看自己單位的人相關項目。
 * data：{ counts:{…}, outbox_failed[], unmapped[], left_but_active[], pending_confirm{count,items[]},
 *         no_home_map[], name_diff[], payroll_diff[], transfer_ask[], needs_hq_count, candidates_count, last_sync{store:at} }
 */
function handleClockAlerts_(token) {
  var a = clkNeedActor_(token);
  if (!a.ok) return a;
  var empty = { counts: {}, outbox_failed: [], unmapped: [], left_but_active: [], pending_confirm: { count: 0, items: [] }, no_home_map: [],
    name_diff: [], name_diff_items: [], no_home_map_items: [], payroll_diff: [], leave_overdue: [], home_stopped: [], transfer_failed: [], transfer_ask: [], needs_hq_count: 0, candidates_count: 0, last_sync: {} };
  if (!clkSheetsReady_()) return { ok: true, data: empty };
  var staff = clkStaffIndex_(), maps = clkMaps_(), jobs = clkJobs_(), stores = clkStores_();
  var today = clkTodayOf_(new Date());
  var mine = function (empNo) {
    if (a.isHq) return true;
    var s = staff[empNo];
    return !!s && clkStaffUnit_(s) === a.scope.unit;
  };
  var out = empty;
  out.outbox_failed = jobs.filter(function (j) {
    var bad = j.state === 'failed' || (CLK_OPEN_STATES.indexOf(j.state) !== -1 && j.tries >= CLK_ALERT_TRIES);
    return bad && (j.emp_no ? mine(j.emp_no) : a.isHq);
  }).map(function (j) { return { job_id: j.job_id, kind: j.kind, emp_no: j.emp_no, store_code: j.store_code, state: j.state, tries: j.tries, last_error: stfStr_(j.last_error) }; });
  out.left_but_active = maps.filter(function (m) {
    var s = staff[m.emp_no];
    return s && clkStaffStatus_(s) === 'disabled' && m.state === 'confirmed' && m.roster_active === 'TRUE' && mine(m.emp_no);
  }).map(function (m) { return { emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id }; });
  var myStoreA = a.scope ? clkStoreOfUnit_(a.scope.unit) : null;
  var sug = maps.filter(function (m) { return m.state === 'suggested' && m.emp_no && (a.isHq || (!!myStoreA && m.store_code === myStoreA.store_code)); });
  out.pending_confirm = { count: sug.length, items: sug.map(function (m) { return { emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id }; }) };
  var staffAll = clkStaffAll_();
  out.no_home_map = clkNoHomeMap_(staffAll, maps, jobs, today).filter(function (s) { return mine(s.emp); }).map(function (s) { return s.emp; });
  out.no_home_map_items = out.no_home_map.map(function (e) {
    var sp = staff[e], stc = sp ? clkStoreOfUnit_(clkStaffUnit_(sp)) : null;
    return { emp_no: e, name: sp ? clkStaffName_(sp) : '', store_code: stc ? stc.store_code : '' };
  });
  // 離職日已過、卻還沒停用（連動停用失敗，例如帳號列遺失）
  out.leave_overdue = staffAll.filter(function (s) { return s.last && s.last < today && clkStaffStatus_(s) !== 'disabled' && mine(s.emp); }).map(function (s) { return s.emp; });
  // DZY 在職、沒登記離職，但主店打卡被停（例如店長在打卡端用舊按鈕停用）
  out.home_stopped = maps.filter(function (m) {
    var s = staff[m.emp_no];
    return s && m.state === 'confirmed' && m.role === 'home' && m.roster_active === 'FALSE' && clkStaffStatus_(s) !== 'disabled' && !s.last && mine(m.emp_no);
  }).map(function (m) { return { emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id }; });
  out.transfer_failed = [];
  // 停用卻沒做乾淨（平台帳號列遺失、或帳號仍啟用）也算離職日已過未處理
  staffAll.forEach(function (s) {
    if (!s.last || s.last >= today || !mine(s.emp) || out.leave_overdue.indexOf(s.emp) !== -1) return;
    var ur = findUsrRowById_(stfStr_(s.values[STF_COL.user_id]));
    if (clkStaffStatus_(s) === 'disabled' && (!ur || String(ur.values[USR_COL.active]).toUpperCase() !== 'FALSE')) out.leave_overdue.push(s.emp);
  });
  // 對照被退回（rejected）、打卡端帳號卻是在職 → 併入 unmapped（reason:'rejected'）；
  // 離職者只有待確認（suggested）對照、打卡端還在職 → 併入 left_but_active（suggested:true）；
  // 補償停用單（沒有生效對照的打卡帳號要被停掉）→ 併入 outbox_failed（comp:true，未完成就先亮紅燈）。前端不必新增類別
  var rejectedActive = maps.filter(function (m) {
    return m.state === 'rejected' && m.roster_active === 'TRUE' && !!staff[m.emp_no] && clkStaffStatus_(staff[m.emp_no]) !== 'disabled' && mine(m.emp_no);
  });
  var leftSuggested = maps.filter(function (m) {
    var s = staff[m.emp_no];
    return s && m.state === 'suggested' && m.roster_active === 'TRUE' && (clkStaffStatus_(s) === 'disabled' || (s.last && s.last < today)) && mine(m.emp_no);
  });
  var compJobs = a.isHq ? jobs.filter(function (j) {
    return clkJson_(j.expect_json, {}).comp && ['pending', 'running', 'failed'].indexOf(j.state) !== -1;
  }) : [];
  if (a.isHq) {
    rejectedActive.forEach(function (m) { out.unmapped.push({ store_code: m.store_code, emp_id: m.emp_id, name: clkStaffName_(staff[m.emp_no]), reason: 'rejected', emp_no: m.emp_no }); });
  }
  leftSuggested.forEach(function (m) { out.left_but_active.push({ emp_no: m.emp_no, store_code: m.store_code, emp_id: m.emp_id, suggested: true }); });
  compJobs.forEach(function (j) {
    if (!out.outbox_failed.some(function (x) { return x.job_id === j.job_id; })) {
      out.outbox_failed.push({ job_id: j.job_id, kind: j.kind, emp_no: j.emp_no, store_code: j.store_code, state: j.state, tries: j.tries,
        last_error: stfStr_(j.last_error), comp: true, reason: clkJson_(j.expect_json, {}).reason || '' });
    }
  });
  stores.forEach(function (st) {
    var ss = clkSyncState_(st.store_code);
    if (ss.at) out.last_sync[st.store_code] = ss.at;
    if (a.isHq) {
      ss.unmapped.forEach(function (u) { out.unmapped.push({ store_code: st.store_code, emp_id: u.emp_id, name: u.name }); });
      ss.payroll_diff.forEach(function (p) { out.payroll_diff.push({ store_code: st.store_code, emp_id: p.emp_id, roster_name: p.roster_name, payroll_name: p.payroll_name }); });
    }
    ss.name_diff.forEach(function (n) {
      if (!mine(n.emp_no)) return;
      var sp = staff[n.emp_no], nm = sp ? clkStaffName_(sp) : '';
      out.name_diff.push({ emp_no: n.emp_no, name: nm, store_code: st.store_code, emp_id: n.emp_id });
      out.name_diff_items.push({ emp_no: n.emp_no, name: nm, store_code: st.store_code });
    });
  });
  if (a.isHq) {
    out.transfer_ask = clkGetState_(CLK_PROP_TRANSFER_ASK, { items: [] }).items.map(function (x) {
      var sp = staff[x.emp_no];
      return { emp_no: x.emp_no, name: sp ? clkStaffName_(sp) : '', store_code: x.store_code };
    });
    var noHome = {};
    out.no_home_map.forEach(function (e) { noHome[e] = true; });
    out.transfer_failed = (clkGetState_(CLK_PROP_TRANSFER_FAIL, { items: [] }).items || []).filter(function (e) { return noHome[e]; });
    var ms = clkGetState_(CLK_PROP_MAP_STATE, { candidates: [], needs_hq: [] });
    out.needs_hq_count = (ms.needs_hq || []).length;
    out.candidates_count = (ms.candidates || []).length;
  }
  out.counts = {
    outbox_failed: out.outbox_failed.length, unmapped: out.unmapped.length, left_but_active: out.left_but_active.length,
    pending_confirm: out.pending_confirm.count, no_home_map: out.no_home_map.length, leave_overdue: out.leave_overdue.length,
    home_stopped: out.home_stopped.length, transfer_failed: out.transfer_failed.length,
    rejected_active: rejectedActive.length, left_suggested: leftSuggested.length, compensations: compJobs.length, name_diff: out.name_diff.length,
    payroll_diff: out.payroll_diff.length, transfer_ask: out.transfer_ask.length, needs_hq: out.needs_hq_count, candidates: out.candidates_count
  };
  return { ok: true, data: out };
}

/**
 * 佈告欄名單（spec §4.6）。不靠登入 token：payload.svc_key 要等於 Script Property BULLETIN_SVC_KEY（未設＝全拒，常數時間比對）。
 * 回 data＝[{emp_no,name,unit,unit_name,title,active,clocks:[{store_code,emp_id,role}]}]（title＝職稱代碼，2026-10-25），只含 confirmed 對照，不含手機／生日／地址。
 */
function handleSvcDirectory_(payload) {
  var want = PropertiesService.getScriptProperties().getProperty(CLK_PROP_SVC_KEY);
  var got = payload && typeof payload.svc_key === 'string' ? payload.svc_key : '';
  if (!want || !got || !authSafeEqual_(got, want)) return clkErr_('unauthorized', CLK_MSG.UNAUTHORIZED);
  if (!stfSheetsReady_()) return { ok: true, data: [], total: 0, generated_at: clkNowText_(new Date()) };
  var org = stfReadOrg_();
  var maps = clkSheetsReady_() ? clkMaps_().filter(function (m) { return m.state === 'confirmed'; }) : [];
  var data = clkStaffAll_().map(function (s) {
    var unit = clkStaffUnit_(s);
    return {
      emp_no: s.emp, name: clkStaffName_(s), unit: unit, unit_name: org.unit[unit] ? org.unit[unit].name : '',
      title: stfStr_(s.values[STF_COL.title]),   // 職稱代碼（2026-10-25）：佈告欄依職稱決定總監級以上看得到全部品牌
      active: clkStaffStatus_(s) !== 'disabled',
      clocks: maps.filter(function (m) { return m.emp_no === s.emp; }).map(function (m) { return { store_code: m.store_code, emp_id: m.emp_id, role: m.role }; })
    };
  });
  return { ok: true, data: data, total: data.length, generated_at: clkNowText_(new Date()) };
}

// ============================================================
// SSO：公告專區自動登入電子佈告欄（2026-10-16）
// 流程：管理系統前端（已登入）→ ssoTicket 換一張一次性入場券（60 秒）→ postMessage 給嵌在 iframe 裡的佈告欄 →
// 佈告欄的 Mac mini 伺服器拿券＋BULLETIN_SVC_KEY 打 svcSsoRedeem → 回同仁編號（DZY###）→ 佈告欄依 staff.dzy 登入那位。
// 登入 token 本身永遠不離開管理系統；券只能換一次、只回編號、只給有服務金鑰的佈告欄伺服器換。
// ⚠ ssoTicket／svcSsoRedeem 永遠不可列進 minikit apps/dzy-platform/app.json 的 readActions（唯讀動作在鏡像／回退模式可能被重放＝券能用兩次；審查 dzy-bulletin#42-6）
// ============================================================
var SSO_TTL_SEC = 60;
var SSO_CACHE_PREFIX = 'sso_tkt:';
var SSO_AUDS = { bulletin: 1, 'bulletin-admin': 1, store: 1 };

/**
 * 換一張入場券。aud：
 *  - bulletin：同仁本人登入佈告欄。只發給 role staff＋DZY###；系統帳號回 no_emp，佈告欄照舊選名字。
 *  - bulletin-admin（2026-10-17）：管理系統「公告管理／新增公告」分頁用，換佈告欄的管理憑證。要有 platform.bulletin（同仁名單勾選）或 admin（'*'）。
 */
function handleSsoTicket_(token, payload) {
  var aud = payload && typeof payload.aud === 'string' ? payload.aud : '';
  if (!SSO_AUDS.hasOwnProperty(aud)) return clkErr_('bad_aud', '不支援的系統');
  var res = authResolveSession_(token);
  if (!res.ok) return res;
  var emp = String(res.user.username || '').toUpperCase();
  var rec;
  if (aud === 'store') {
    // 門市營運系統（StoreOps.gs）：sub＝DZY 編號；沒有同仁編號的 admin＝'U:'+users.id；其他回 no_emp
    var storeSub = storeSubForUser_(res.user);
    if (!storeSub) return clkErr_('no_emp', '這個帳號沒有同仁編號');
    rec = { sub: storeSub, aud: aud };
  } else if (aud === 'bulletin') {
    if (res.user.role !== 'staff' || !STF_EMP_RE.test(emp)) return clkErr_('no_emp', '這個帳號沒有同仁編號');
    rec = { emp: emp, aud: aud };
  } else {
    if (!hasPerm_(res.perms, 'platform.bulletin')) return clkErr_('no_perm', '沒有公告管理權限');
    // 系統帳號沒有 DZY 編號：emp 留空，用帳號 id 與名字給佈告欄記操作紀錄
    rec = { emp: STF_EMP_RE.test(emp) ? emp : '', aud: aud, admin: true, uid: String(res.user.id || ''), name: String(res.user.name || '') };
  }
  // 兩個隨機 UUID 雜湊成 64 位十六進位（不依賴 getUuid 的字串格式）
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + ':' + Utilities.getUuid());
  var ticket = digest.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  CacheService.getScriptCache().put(SSO_CACHE_PREFIX + ticket, JSON.stringify(rec), SSO_TTL_SEC);
  return { ok: true, data: { ticket: ticket, expires_in: SSO_TTL_SEC } };
}

/** 佈告欄伺服器兌換入場券（服務金鑰同 svcDirectory）。一張券只能兌換一次；過期、換過、aud 不符都回 ticket_invalid。
 *  bulletin → {emp_no}；bulletin-admin → {admin:true, emp_no（系統帳號為空字串）, uid, name}。 */
function handleSvcSsoRedeem_(payload) {
  var want = PropertiesService.getScriptProperties().getProperty(CLK_PROP_SVC_KEY);
  var got = payload && typeof payload.svc_key === 'string' ? payload.svc_key : '';
  if (!want || !got || !authSafeEqual_(got, want)) return clkErr_('unauthorized', CLK_MSG.UNAUTHORIZED);
  var ticket = payload && typeof payload.ticket === 'string' ? payload.ticket : '';
  var aud = payload && typeof payload.aud === 'string' ? payload.aud : '';
  if (!/^[0-9a-f]{64}$/.test(ticket)) return clkErr_('ticket_invalid', '入場券無效');
  var cache = CacheService.getScriptCache(), key = SSO_CACHE_PREFIX + ticket;
  var raw = cache.get(key);
  cache.remove(key);
  var rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
  if (!rec || rec.aud !== aud) return clkErr_('ticket_invalid', '入場券無效或已過期');
  if (aud === 'bulletin') {
    if (!STF_EMP_RE.test(String(rec.emp || ''))) return clkErr_('ticket_invalid', '入場券無效或已過期');
    return { ok: true, data: { emp_no: rec.emp } };
  }
  if (rec.admin !== true) return clkErr_('ticket_invalid', '入場券無效或已過期');
  return { ok: true, data: { admin: true, emp_no: String(rec.emp || ''), uid: String(rec.uid || ''), name: String(rec.name || '') } };
}

/** Staff.gs stfClearClaim_ 的掛勾：有到職日（店長新增才會有）或已有 confirmed 打卡對照 → 退回認領時保留品牌、單位、部門、職稱 */
function clkKeepOrgOnClear_(v) {
  if (!clkSheetsReady_()) return false;
  var empNo = stfNormEmp_(v[STF_COL.emp_no]);
  var s = clkStaffByEmp_(empNo);
  if (s && s.hire) return true;
  return clkMapsOf_(clkMaps_(), empNo).some(function (m) { return m.state === 'confirmed'; });
}

/** Staff.gs staffSetActive(true) 的掛勾：有 last_day 的人回提示文字（走復職），否則 null */
function clkLeaveBlocksEnable_(empNo) {
  if (!clkSheetsReady_()) return null;
  var s = clkStaffByEmp_(empNo);
  if (s && s.last) return '這位同仁登記過離職日（' + s.last + '），請用「復職」恢復，才會一併清掉離職日並恢復打卡';
  return null;
}

/** Staff.gs staffSetActive(false) 的掛勾：舊的「停用」按鈕只停平台帳號，這裡同時對他每個生效對照發停用單（不必等隔日對帳） */
function clkAfterDisable_(empNo, byLabel) {
  try {
    if (!clkSheetsReady_()) return null;
    var emp = stfNormEmp_(empNo), d = new Date();
    var jobs = clkJobs_(), used = clkUsedIds_(jobs), made = [];
    clkConfirmedOf_(clkMaps_(), emp).forEach(function (m) {
      if (m.roster_active === 'FALSE' || clkOpenJob_(jobs, 'deactivate', emp, m.store_code, m.emp_id)) return;
      var j = clkEnqueue_({ kind: 'deactivate', emp_no: emp, store_code: m.store_code, emp_id: m.emp_id,
        expect: { map: m.store_code + ':' + m.emp_id, emp_no: emp, state: 'confirmed', staff: 'disabled', by: String(byLabel || 'staffSetActive') } }, d, used);
      jobs.push(j); made.push(j.job_id);
    });
    return made;
  } catch (e) {
    console.error('[clkAfterDisable_] ' + (e && e.message ? e.message : e));
    try { stfLog_(stfNormEmp_(empNo), 'disable_jobs_failed', 'system', '停用單開單失敗'); } catch (e2) { /* 每日對帳會補 */ }
    return null;
  }
}
