/**
 * 門市營運系統 ↔ 管理系統｜管理系統這一側（2026-10-18；規格 mala-store-ops-approver docs/approver/spec.md §10、§12、§13）。
 * 契約唯一正本：test/fixtures/dzy-store-contract-v2.json（兩個 repo 各一份、逐字相同）。
 *
 * 內容：
 *  1. ssoTicket aud 'store' 的 sub 判斷（storeSubForUser_；StaffClock.gs handleSsoTicket_ 呼叫）
 *  2. svcStoreRedeem／svcStoreWho／svcStoreRoster（憑 Script Property STORE_SVC_KEY）
 *  3. 誰核誰：attNeedOf_／attApproverOf_（純函式）＋ storeAttPeople_
 *  4. 身分 ident 計算（storeIdent_）、試點開關 STORE_SSO_UNITS
 *  5. 衍生權限 platform.att／platform.storeops 的閘門（storeAttGate_／storeOpsGate_；Staff.gs stfLoginGate_ 呼叫）
 *  6. 人資主管判斷 stfIsHrHead_、perm_map 補預設規則 storeopsPermSeed_
 *
 * ⚠ ssoTicket／svcStoreRedeem／svcStoreWho／svcStoreRoster 永遠不可列進 minikit app.json 的 readActions，
 *    也不可列進 platform/dryrun.js 的 READ_ACTIONS（重放＝券能用兩次；審查 dzy-bulletin#42-6、approver spec §11-11）。
 * ⚠ 本檔不改 stfReviewNeed_；考勤的「誰核誰」是另一張表（spec §12），獨立實作。
 */

var STORE_PROP_SVC_KEY = 'STORE_SVC_KEY';
var STORE_PROP_PILOT = 'STORE_SSO_UNITS';
var STORE_SUB_STAFF_RE = /^DZY\d{3,}$/;
var STORE_SUB_ADMIN_RE = /^U:[A-Za-z0-9_-]{1,64}$/;
var STORE_UNIT_RE = /^[A-Za-z0-9_-]{1,40}$/;
var STORE_TICKET_RE = /^[0-9a-f]{64}$/;
var STORE_LOCK_WAIT_MS = 10000;

// 責任制職稱（spec §12）：不打卡、不列入任何人的可核名單；仍可以當核定人
var STORE_NO_ATT_TITLES = ['odir', 'hm', 'ceo', 'gm', 'chair'];
// 人資主管（不是 admin）可以設個別例外的兩個權限碼（spec §13.1）
var STORE_HR_GRANTABLE = ['store.void', 'att.extra'];
var STORE_PERM_VOID = 'store.void';
var STORE_PERM_ATT_EXTRA = 'att.extra';

var STORE_MSG = {
  UNAUTHORIZED: '服務金鑰錯誤或未設定',
  BAD_AUD: '不支援的系統',
  TICKET_INVALID: '入場券無效或已過期',
  NO_EMP: '這個帳號沒有同仁編號',
  BAD_INPUT: '格式錯誤',
  BUSY: '系統忙碌中，請稍後再試'
};

// ============================================================
// 1. 小工具
// ============================================================

/** 試點單位（Script Property STORE_SSO_UNITS，逗號分隔；空＝全關）→ 排序去重的陣列 */
function storePilotUnits_() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(STORE_PROP_PILOT) || ''; } catch (e) { raw = ''; }
  var seen = {}, out = [];
  String(raw).split(',').forEach(function (x) {
    x = String(x).trim();
    if (x && STORE_UNIT_RE.test(x) && !seen[x]) { seen[x] = true; out.push(x); }
  });
  return out.sort();
}

function storeUniqSorted_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
  return out.sort();
}

function storeDatePart_(v) {
  var s = stfDate_(v);
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s));
  return m ? m[1] : '';
}

function storeKeyOk_(payload) {
  var want = PropertiesService.getScriptProperties().getProperty(STORE_PROP_SVC_KEY);
  var got = payload && typeof payload.svc_key === 'string' ? payload.svc_key : '';
  return !!want && !!got && authSafeEqual_(got, want);
}

// ============================================================
// 2. 人資主管與「誰核誰」（純函式）
// ============================================================

/** 人資主管＝人資部（主要部門 hr）且職稱部門主管（hm）、在職。p＝{status, dept, title}。不含兼任部門。 */
function stfIsHrHead_(p) {
  if (!p) return false;
  return stfStr_(p.status) === 'active' && stfStr_(p.dept) === 'hr' && stfStr_(p.title) === 'hm';
}

/** 單位與職稱都存在、啟用、且職稱屬於該單位的階梯 → 回 {unit, title, ladder}，否則 null */
function storeOrgOf_(p, org) {
  if (!p) return null;
  var u = org.unit[stfStr_(p.unit)];
  var t = org.title[stfStr_(p.title)];
  if (!u || !u.active || !t || !t.active) return null;
  var ladder = u.ladder || 'store';
  if (t.parent !== ladder) return null;
  return { unit: u, title: t, ladder: ladder };
}

/**
 * 被核者需要什麼樣的核定人（spec §12 表格）。回 null＝不考勤（責任制職稱、資料不合規）。
 * 回 {kind, unit?, dept?}：
 *   'self'   門市／央廚店長（自己核自己）　　'store' 門市／央廚計時、正職（同店店長）
 *   'office' 品牌辦公室行政／督導／區經理（同辦公室總監）
 *   'dept'   總部部門同仁（同主要部門的部門主管）　'mgmt' 管理部同仁（執行長以上）
 * target＝{unit, dept, title}。
 */
function attNeedOf_(target, org) {
  var o = storeOrgOf_(target, org);
  if (!o) return null;
  var title = stfStr_(target.title);
  if (STORE_NO_ATT_TITLES.indexOf(title) !== -1) return null;
  var unit = stfStr_(target.unit);
  if (o.ladder === 'store') {
    if (title === 'sm') return { kind: 'self', unit: unit };
    if (title === 'pt' || title === 'ft') return { kind: 'store', unit: unit };
    return null;
  }
  if (o.ladder === 'office') {
    if (title === 'ofs' || title === 'osv' || title === 'oam') return { kind: 'office', unit: unit };
    return null;
  }
  if (o.ladder === 'hq') {
    if (title !== 'hs') return null;
    var dept = stfStr_(target.dept);
    var d = org.dept[dept];
    if (!d || !d.active || d.parent !== unit) return null;
    if (dept === STF_MGMT_DEPT) return { kind: 'mgmt' };
    return { kind: 'dept', dept: dept };
  }
  return null;
}

/**
 * approver 能不能核 target（只算 §12 表格；人資主管、admin、att.extra 在 storeAttPeople_ 另外處理）。
 * approver／target＝{emp, status, unit, dept, title}。任何人都不能核自己，唯一例外是店長核自己（'self'）。
 */
function attApproverOf_(approver, target, org) {
  if (!approver || !target) return false;
  if (stfStr_(approver.status) !== 'active' || stfStr_(target.status) !== 'active') return false;
  var need = attNeedOf_(target, org);
  if (!need) return false;
  var ao = storeOrgOf_(approver, org);
  if (!ao) return false;
  var title = stfStr_(approver.title);
  var sameMan = stfStr_(approver.emp) !== '' && stfStr_(approver.emp) === stfStr_(target.emp);
  if (need.kind === 'self') return sameMan && title === 'sm' && ao.ladder === 'store';
  if (sameMan) return false;
  if (need.kind === 'store') return ao.ladder === 'store' && title === 'sm' && stfStr_(approver.unit) === need.unit;
  if (need.kind === 'office') return ao.ladder === 'office' && title === 'odir' && stfStr_(approver.unit) === need.unit;
  if (need.kind === 'dept') return ao.ladder === 'hq' && title === 'hm' && stfStr_(approver.dept) === need.dept;
  if (need.kind === 'mgmt') return ao.ladder === 'hq' && (title === 'ceo' || title === 'gm' || title === 'chair');
  return false;
}

/**
 * 這個人能核的人（尚未換成打卡帳號）。
 * me＝{emp, status, unit, dept, title}（admin 沒有同仁編號時 emp 為空）；flags＝{admin, hrHead, attExtra}；
 * people＝全部同仁物件陣列。回符合的 target 陣列。
 */
function storeAttTargets_(me, flags, people, org) {
  var out = [];
  people.forEach(function (t) {
    if (stfStr_(t.status) !== 'active') return;
    if (!attNeedOf_(t, org)) return;
    var notSelf = !(stfStr_(me.emp) && stfStr_(me.emp) === stfStr_(t.emp));
    var ok = false;
    // 店長核自己：本人是店長（title sm）且要考勤（上面 attNeedOf_ 已判定）時，admin／人資主管名單仍含自己
    if (flags.admin || flags.hrHead) ok = notSelf || stfStr_(me.title) === 'sm';
    else {
      ok = attApproverOf_(me, t, org);
      if (!ok && flags.attExtra && notSelf && stfStr_(me.unit) && stfStr_(me.unit) === stfStr_(t.unit)) ok = true;
    }
    if (ok) out.push(t);
  });
  return out;
}

// ============================================================
// 3. 讀資料（碰試算表）
// ============================================================

function storePeople_() {
  var extraMap = stfReadExtraMap_();
  return clkStaffAll_().map(function (s) {
    var v = s.values;
    return {
      emp: s.emp, name: stfStr_(v[STF_COL.name]), status: stfStr_(v[STF_COL.status]),
      unit: stfStr_(v[STF_COL.unit]), dept: stfStr_(v[STF_COL.dept]), title: stfStr_(v[STF_COL.title]),
      userId: stfStr_(v[STF_COL.user_id]), hire: s.hire, confirmedAt: storeDatePart_(v[STF_COL.confirmed_at]),
      values: v, extra: stfSplitCodes_(extraMap[s.emp])
    };
  });
}

/** 同仁最近一次在職起日：到職日、staff_log 最近一次 enable／reinstate（復職）取較晚者；都沒有就用開通日 */
function storeEpoch_(p, logBest) {
  var best = storeDatePart_(p.hire);
  var d = (logBest || storeEpochLogMap_())[p.emp];
  if (d && d > best) best = d;
  return best || p.confirmedAt || '';
}

/** staff_log 只讀一次：回 {同仁編號: 最近一次 enable／reinstate 的日期}（名冊整批算 epoch 用） */
function storeEpochLogMap_() {
  var map = {};
  stfReadRows_(STF_SHEET_LOG, STF_LOG_HEADERS.length).forEach(function (r) {
    var ev = stfStr_(r[2]);
    if (ev !== 'enable' && ev !== 'reinstate') return;
    var emp = stfNormEmp_(r[1]);
    var d = storeDatePart_(r[0]);
    if (emp && d && (!map[emp] || d > map[emp])) map[emp] = d;
  });
  return map;
}

/** 能核的人換成打卡帳號：staff_clock state=confirmed 且 roster_active 不是 FALSE；被核的人單位必須在試點內 */
function storeAttPeople_(targets, pilot) {
  if (!pilot.length || !targets.length) return [];
  var maps = clkSheetsReady_() ? clkMaps_() : [];
  var seen = {}, out = [];
  targets.forEach(function (t) {
    if (pilot.indexOf(t.unit) === -1) return;
    maps.forEach(function (m) {
      if (m.emp_no !== t.emp || m.state !== 'confirmed' || m.roster_active === 'FALSE') return;
      var k = m.store_code + '|' + m.emp_id;
      if (seen[k]) return;
      seen[k] = true;
      out.push({ clock: m.store_code, emp_id: m.emp_id, sub: t.emp, name: t.name });
    });
  });
  out.sort(function (a, b) {
    if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
    return a.emp_id < b.emp_id ? -1 : (a.emp_id > b.emp_id ? 1 : 0);
  });
  return out;
}

/** 某位同仁現在的第二期權限（不看 PERMS_ON 開關；perm 表沒建＝沒有規則） */
function storePermsOf_(p) {
  try {
    var ctx = permLoadCtx_(false);
    return permComputeRow_(ctx, p.values, p.extra).perms;
  } catch (e) {
    return [];
  }
}

/** 試點內全部 store 階梯單位（含 ck） */
function storeStoreUnits_(org, pilot) {
  var out = [];
  org.list.unit.forEach(function (u) {
    if (u.active && (u.ladder || 'store') === 'store' && pilot.indexOf(u.code) !== -1) out.push(u.code);
  });
  return storeUniqSorted_(out);
}

// ============================================================
// 4. ident
// ============================================================

/**
 * 用 sub 算身分。回契約的 ident_active／ident_admin_no_emp，或 {sub, active:false}。
 * 停用、離職、查無、pending（任何 status 不是 active）、對應的登入帳號不存在或已停用 → inactive。
 */
function storeIdent_(sub) {
  sub = String(sub || '');
  var inactive = { sub: sub, active: false };
  var org = stfReadOrg_();
  var pilot = storePilotUnits_();
  var user = null, p = null, tokenAfter = 0;

  if (STORE_SUB_ADMIN_RE.test(sub)) {
    var f = findUserById_(sub.slice(2));
    if (!f || !isActiveValue_(f.values[AUTH_USERS_COL.active])) return inactive;
    user = rowToUser_(f.values);
    tokenAfter = Number(f.values[AUTH_USERS_COL.token_after]) || 0;
    if (String(user.role) !== 'admin') return inactive;
  } else if (STORE_SUB_STAFF_RE.test(sub)) {
    var all = storePeople_();
    for (var i = 0; i < all.length; i++) if (all[i].emp === sub) { p = all[i]; break; }
    if (!p || p.status !== 'active' || !p.userId) return inactive;
    var uf = findUserById_(p.userId);
    if (!uf || !isActiveValue_(uf.values[AUTH_USERS_COL.active])) return inactive;
    user = rowToUser_(uf.values);
    tokenAfter = Number(uf.values[AUTH_USERS_COL.token_after]) || 0;
    if (String(user.role) !== 'admin' && String(user.role) !== 'staff') return inactive;
  } else {
    return inactive;
  }

  var admin = String(user.role) === 'admin';
  var perms = p ? storePermsOf_(p) : [];
  var hrHead = p ? stfIsHrHead_(p) : false;
  var flags = { admin: admin, hrHead: hrHead, attExtra: perms.indexOf(STORE_PERM_ATT_EXTRA) !== -1 };
  var me = p || { emp: '', status: 'active', unit: '', dept: '', title: '' };
  var people = (p || admin) ? storePeople_() : [];
  var valid = p ? storeOrgOf_(p, org) : null;

  var managed = [], voidUnits = [];
  if (admin) {
    managed = storeStoreUnits_(org, pilot);
    voidUnits = managed.slice();
  } else {
    if (valid && p.title === 'sm' && valid.ladder === 'store' && pilot.indexOf(p.unit) !== -1) managed = [p.unit];
    if (valid && perms.indexOf(STORE_PERM_VOID) !== -1 && pilot.indexOf(p.unit) !== -1) voidUnits = [p.unit];
  }

  var targets = storeAttTargets_(me, flags, people, org);
  return {
    sub: sub, active: true,
    emp_no: p ? p.emp : '',
    name: p ? p.name : String(user.name || ''),
    admin: admin,
    hr_head: hrHead,
    unit: p ? p.unit : '',
    title: p ? p.title : '',
    epoch: p ? storeEpoch_(p) : '',
    token_after: tokenAfter,
    pilot_units: pilot,
    units_managed: storeUniqSorted_(managed),
    void_units: storeUniqSorted_(voidUnits),
    att: { people: storeAttPeople_(targets, pilot) }
  };
}

// ============================================================
// 5. ssoTicket aud 'store' 的 sub
// ============================================================

/**
 * 登入的帳號 → sub。在職同仁（有同仁編號、staff 列 active）→ DZY 編號；
 * role admin 沒有同仁編號 → 'U:'+users.id；其他 → ''（呼叫端回 no_emp）。
 */
function storeSubForUser_(user) {
  if (!user) return '';
  var role = String(user.role);
  if (role !== 'staff' && role !== 'admin') return '';
  var emp = String(user.username || '').toUpperCase();
  if (STORE_SUB_STAFF_RE.test(emp)) {
    var hit = stfFindByUserId_(user.id);
    if (hit && stfStr_(hit.values[STF_COL.status]) === 'active' && stfNormEmp_(hit.values[STF_COL.emp_no]) === emp) return emp;
  }
  if (role === 'staff') return '';
  var id = String(user.id || '');
  return STORE_SUB_ADMIN_RE.test('U:' + id) ? 'U:' + id : '';
}

// ============================================================
// 6. 三支服務 action（金鑰 STORE_SVC_KEY）
// ============================================================

/** 營運系統伺服器兌換入場券。LockService 包住 get＋remove：同一張券只有一次成功。 */
function handleSvcStoreRedeem_(payload) {
  if (!storeKeyOk_(payload)) return clkErr_('unauthorized', STORE_MSG.UNAUTHORIZED);
  var aud = payload && typeof payload.aud === 'string' ? payload.aud : '';
  if (aud !== 'store') return clkErr_('bad_aud', STORE_MSG.BAD_AUD);
  var ticket = payload && typeof payload.ticket === 'string' ? payload.ticket : '';
  if (!STORE_TICKET_RE.test(ticket)) return clkErr_('ticket_invalid', STORE_MSG.TICKET_INVALID);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(STORE_LOCK_WAIT_MS)) return clkErr_('busy', STORE_MSG.BUSY);
  var raw;
  try {
    var cache = CacheService.getScriptCache(), key = SSO_CACHE_PREFIX + ticket;
    raw = cache.get(key);
    // 刻意先取出就作廢（安全優先）：就算後面驗 aud 失敗，這張券也不會留著被重用
    cache.remove(key);
  } finally {
    lock.releaseLock();
  }
  var rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
  if (!rec || rec.aud !== 'store' || typeof rec.sub !== 'string' || !(STORE_SUB_STAFF_RE.test(rec.sub) || STORE_SUB_ADMIN_RE.test(rec.sub))) {
    return clkErr_('ticket_invalid', STORE_MSG.TICKET_INVALID);
  }
  return { ok: true, data: storeIdent_(rec.sub) };
}

function handleSvcStoreWho_(payload) {
  if (!storeKeyOk_(payload)) return clkErr_('unauthorized', STORE_MSG.UNAUTHORIZED);
  var sub = payload && typeof payload.sub === 'string' ? payload.sub : '';
  if (!(STORE_SUB_STAFF_RE.test(sub) || STORE_SUB_ADMIN_RE.test(sub))) return clkErr_('bad_input', STORE_MSG.BAD_INPUT);
  return { ok: true, data: storeIdent_(sub) };
}

function handleSvcStoreRoster_(payload) {
  if (!storeKeyOk_(payload)) return clkErr_('unauthorized', STORE_MSG.UNAUTHORIZED);
  var unit = payload && typeof payload.unit === 'string' ? payload.unit : '';
  if (!STORE_UNIT_RE.test(unit)) return clkErr_('bad_input', STORE_MSG.BAD_INPUT);
  var list = storePeople_().filter(function (p) {
    return p.status === 'active' && p.unit === unit && STORE_SUB_STAFF_RE.test(p.emp);
  }).sort(function (a, b) { return a.emp < b.emp ? -1 : (a.emp > b.emp ? 1 : 0); });
  var logMap = list.length ? storeEpochLogMap_() : {};
  return { ok: true, data: { staff: list.map(function (p) {
    return { sub: p.emp, emp_no: p.emp, name: p.name, title: p.title, unit: p.unit, epoch: storeEpoch_(p, logMap) };
  }) } };
}

// ============================================================
// 7. 衍生權限 platform.att（給前端「考勤管理」選單；不寫進 roles）
// ============================================================

/**
 * 總開關（STORE_SSO_UNITS）空 → 一律 false（考勤管理選單不顯示）。
 * 否則：在職且（職稱 sm／odir／hm／ceo／gm／chair、或人資主管、或有 att.extra）→ true。
 * admin 本來就是 '*'，不在這裡判斷。values＝staff 分頁一列。
 */
function storeAttGate_(values) {
  if (!storePilotUnits_().length) return false;
  if (!values || stfStr_(values[STF_COL.status]) !== 'active') return false;
  var p = { status: 'active', dept: stfStr_(values[STF_COL.dept]), title: stfStr_(values[STF_COL.title]) };
  if (['sm', 'odir', 'hm', 'ceo', 'gm', 'chair'].indexOf(p.title) !== -1) return true;
  if (stfIsHrHead_(p)) return true;
  return storeHasAttExtra_(values);
}

function storeHasAttExtra_(values) {
  try {
    var emp = stfNormEmp_(values[STF_COL.emp_no]);
    var ctx = permLoadCtx_(false);
    if (!ctx.inited) return false;
    return permComputeRow_(ctx, values, stfSplitCodes_(stfReadExtraMap_()[emp])).perms.indexOf(STORE_PERM_ATT_EXTRA) !== -1;
  } catch (e) {
    return false;
  }
}

/**
 * 衍生權限 platform.storeops（「門市營運」選單；登入時的便宜判斷，不跑 storeIdent_ 的完整計算）。
 * 總開關空 → false。否則在職且：
 *   本人單位在試點清單內且是 store 階梯（門市、央廚 ck；單位／職稱有效且職稱屬該階梯）、
 *   或職稱是 odir／hm／ceo／gm／chair（這些人的名單由營運系統再依範圍算）、
 *   或有 att.extra。
 * admin 是 '*'，不在這裡判斷。org＝stfReadOrg_() 結果（可省略）。
 */
function storeOpsGate_(values, org) {
  var pilot = storePilotUnits_();
  if (!pilot.length) return false;
  if (!values || stfStr_(values[STF_COL.status]) !== 'active') return false;
  var p = { unit: stfStr_(values[STF_COL.unit]), title: stfStr_(values[STF_COL.title]) };
  if (STORE_NO_ATT_TITLES.indexOf(p.title) !== -1) return true;
  if (pilot.indexOf(p.unit) !== -1) {
    var o = storeOrgOf_(p, org || stfReadOrg_());
    if (o && o.ladder === 'store') return true;
  }
  return storeHasAttExtra_(values);
}

// ============================================================
// 8. perm_map 補預設規則（正式環境 perm_map 已初始化，新預設規則不會自動生效；用這支只補不覆蓋）
// ============================================================

/**
 * 補 PERM_DEFAULT_RULES 裡「perm_map 還沒有同一條（ladder、dept、title、perm 都相同，不論 active）」的規則，
 * 流水號接在最大號之後。已有的一律不動（含被人工停用的）。只有 role admin。回 {ok, added:[rule_id…]}。
 */
function storeopsPermSeed_(auth) {
  if (permAuthRole_(auth) !== 'admin') return { ok: false, error: 'no_perm', message: '只有系統管理者能補預設規則' };
  var ss = SpreadsheetApp.getActive();
  var t = permReadTable_(ss, PERM_SHEET_MAP, PERM_MAP_HEADERS);
  if (t.missing || t.mismatch) return { ok: false, error: 'not_inited', message: '權限分頁還沒初始化' };
  var have = {};
  t.rows.forEach(function (r) { have[[permStr_(r[1]), permStr_(r[2]), permStr_(r[3]), permStr_(r[4])].join('|')] = true; });
  var next = permAcNextId_(t.rows, 'R');
  var now = permNowText_(), by = permAuthId_(auth) || 'system';
  var rows = [], ids = [];
  PERM_DEFAULT_RULES.forEach(function (r) {
    if (have[r.join('|')]) return;
    var id = next();
    ids.push(id);
    rows.push([id, r[0], r[1], r[2], r[3], 'TRUE', now, by]);
  });
  if (rows.length) {
    var sh = ss.getSheetByName(PERM_SHEET_MAP);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, PERM_MAP_HEADERS.length).setValues(rows);
    stfLog_('', 'perm_map_seed', by, ids.join(','));
  }
  return { ok: true, added: ids };
}
