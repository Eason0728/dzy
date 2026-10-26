/**
 * 門市營運系統 ↔ 管理系統｜管理系統這一側（2026-10-18；規格 mala-store-ops-approver docs/approver/spec.md §10、§12、§13）。
 * 契約唯一正本：test/fixtures/dzy-store-contract-v2.json（兩個 repo 各一份、逐字相同）。
 *
 * 內容：
 *  1. ssoTicket aud 'store' 的 sub 判斷（storeSubForUser_；StaffClock.gs handleSsoTicket_ 呼叫）
 *  2. svcStoreRedeem／svcStoreWho／svcStoreRoster（憑 Script Property STORE_SVC_KEY）
 *  3. 誰核誰：attNeedOf_／attApproverOf_（純函式，分核定工時 hours／申請 req 兩張表）＋ storeAttTargets_（以人為單位）
 *     ＋ 督導／總監「只看」名單：attViewUnitsOf_／storeAttViewTargets_（ident att.view_people；掛 REGIONS_ON，docs/att-view/spec.md）
 *     ＋ 支援打卡依「打卡帳號所在的店」算（storeAttLists_，2026-10-26 docs/att-support/spec.md）＋ 指定門市只看考勤 att.view@<單位>
 *  4. 身分 ident 計算（storeIdent_）、試點開關 STORE_SSO_UNITS
 *  5. 衍生權限 platform.att／platform.sched／platform.storeops 的閘門（storeAttGate_／storeSchedGate_／storeOpsGate_；Staff.gs stfLoginGate_ 呼叫）
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
// 門市／中央工廠的單位主管同等職稱（spec §12＋docs/org/spec.md 第 15 節）：店長 sm、廠長 fm、區經理 am、廚藝總監 rdd
//   用途：營運系統「管理單位」units_managed（本店同仁權限、整店功能）。誰核誰改看下面兩張表（Eason 2026-10-21）。
var STORE_ATT_HEAD_TITLES = ['sm', 'fm', 'am', 'rdd'];

// ── 誰核誰（Eason 2026-10-21，docs/org/spec.md 第 15.1 節）：分「核定工時 hours」與「加班單／請假單／忘刷單 req」兩張表 ──
// 核定工時：門市／中央工廠所有打卡的人（pt ft sm fm am rdd）都由本單位店長／廠長核；店長／廠長可核自己的工時
var STORE_HOURS_UNIT_HEAD_TITLES = ['sm', 'fm'];
// 申請：門市／中央工廠計時、正職 → 本單位店長／廠長（同上）
var STORE_REQ_UNIT_HEAD_TITLES = ['sm', 'fm'];
// 申請：店長／廠長本人的申請 → 同單位這些職稱（門市＝區經理 am；中央工廠＝廚藝總監 rdd，職稱只能掛在各自單位）
var STORE_REQ_HEAD_BY_UNIT = ['am', 'rdd'];
// 申請：門市店長本人的申請也可以由該品牌辦公室的這些職稱核（區督導 osv）
var STORE_REQ_HEAD_BY_OFFICE = ['osv'];
// 區域開關開、且這家店沒有有效督導（沒劃區或區沒督導）時，店長本人的申請另外放行同品牌辦公室的這些職稱（docs/regions/spec.md 第 0 節 Q4）
var STORE_REQ_HEAD_NO_SUP_OFFICE = ['odir'];
// 申請：區經理本人的申請 → 該品牌辦公室的這些職稱（預設區督導、總監；要改只改這裡）
var STORE_REQ_AM_OFFICE_TITLES = ['osv', 'odir'];
// 申請：廚藝總監本人的申請 → 總部這些職稱（預設執行長、總經理、董事長；要改只改這裡）
var STORE_REQ_RDD_HQ_TITLES = ['ceo', 'gm', 'chair'];
// 管理部同仁 → 執行長以上（兩張表相同）
var STORE_EXEC_TITLES = ['ceo', 'gm', 'chair'];
// 考勤管理選單（platform.att）：會核人的職稱＋責任制職稱（區督導 2026-10-21 起核品牌內店長的申請）
var STORE_ATT_GATE_TITLES = ['sm', 'fm', 'am', 'rdd', 'osv', 'odir', 'hm', 'ceo', 'gm', 'chair'];
// 排班管理選單（platform.sched，2026-10-24 Eason）：只給「能排班」的人＝店長同等職（店長、廠長、區經理）；人資主管另算，admin 是 '*'。
// 不含區督導／總監／執行長以上、廚藝總監，也不含 att.extra 例外。
var STORE_SCHED_GATE_TITLES = ['sm', 'fm', 'am'];
// 2026-10-25 起另加：ladder 為 hq（總部）或 office（品牌辦公室）單位的在職同仁，且有 hq 打卡對照（總部自填排班，docs/schedule-hq/spec.md §5）。
var STORE_SCHED_GATE_LADDERS = ['hq', 'office'];
// 總部排班的打卡店別
var STORE_SELF_CLOCK = 'hq';
// 人資主管（不是 admin）可以設個別例外的兩個權限碼（spec §13.1）
var STORE_HR_GRANTABLE = ['store.void', 'att.extra', 'platform.bulletin'];   // 2026-10-26 加公告管理（Eason：人資也能設）
var STORE_PERM_VOID = 'store.void';
var STORE_PERM_ATT_EXTRA = 'att.extra';

// ── 支援打卡誰來核（2026-10-26 Eason 定案，docs/att-support/spec.md §1）──
// 支援帳號：打卡帳號所在打卡店的單位清單（clkUnitsOf_）不含這位同仁的單位；總部打卡（hq）一律不算支援。
// 支援帳號的核定人（工時與申請都一樣）＝打卡店單位 S 的主管，依序取第一層有人的：
//   1. 同單位在職的店長／廠長（STORE_SUP_L1）　2. 同單位在職的區經理／廚藝總監（STORE_SUP_L2）
//   3. 門市（非 ck）：REGIONS_ON 開時負責 S 那區的在職區督導（STORE_SUP_L3_OFFICE）　4. 門市（非 ck）：S 品牌辦公室的在職總監（STORE_SUP_L4_OFFICE）
// 人資主管、admin 一律可核（不含自己）；原單位主管對支援帳號只看（att.view_people）。
var STORE_SUP_L1 = ['sm', 'fm'];
var STORE_SUP_L2 = ['am', 'rdd'];
var STORE_SUP_L3_OFFICE = ['osv'];
var STORE_SUP_L4_OFFICE = ['odir'];

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

/** 人資主管＝人資部（主要部門 hr）且職稱總監（hm）、在職。p＝{status, dept, title}。不含兼任部門。 */
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
  if (!stfTitleFitsUnit_(org, stfStr_(p.title), stfStr_(p.unit))) return null;   // 含單位限定職稱（中央工廠沒有店長）
  return { unit: u, title: t, ladder: ladder };
}

/** mode 只認 'req'，其他（含省略）一律當 'hours' */
function storeAttMode_(mode) { return mode === 'req' ? 'req' : 'hours'; }

/**
 * 被核者需要什麼樣的核定人（spec §12＋docs/org/spec.md 第 15.1 節）。回 null＝不考勤（責任制職稱、資料不合規）。
 * mode：'hours' 核定工時（預設）／'req' 加班單、請假單、忘刷單。target＝{unit, dept, title}。回 {kind, unit?, brand?, dept?}：
 *   'unit'         本單位店長／廠長（hours：門市／中央工廠所有打卡的人；req：計時、正職）
 *   'head'         req 店長／廠長本人：同單位區經理（中央工廠＝廚藝總監），門市另可由該品牌辦公室區督導
 *   'brand_office' req 區經理本人：該品牌辦公室區督導、總監
 *   'hq_exec'      req 廚藝總監本人：總部執行長、總經理、董事長
 *   'office'       品牌辦公室行政／督導（同辦公室總監）
 *   'dept'         總部部門同仁（同主要部門的總監）　'mgmt' 管理部同仁（執行長以上）
 */
function attNeedOf_(target, org, mode) {
  mode = storeAttMode_(mode);
  var o = storeOrgOf_(target, org);
  if (!o) return null;
  var title = stfStr_(target.title);
  if (STORE_NO_ATT_TITLES.indexOf(title) !== -1) return null;
  var unit = stfStr_(target.unit);
  if (o.ladder === 'store') {
    var clocks = title === 'pt' || title === 'ft' || STORE_ATT_HEAD_TITLES.indexOf(title) !== -1;
    if (!clocks) return null;
    if (mode === 'hours' || title === 'pt' || title === 'ft') return { kind: 'unit', unit: unit };
    if (STORE_REQ_UNIT_HEAD_TITLES.indexOf(title) !== -1) return { kind: 'head', unit: unit, brand: o.unit.parent };
    if (title === 'am') return { kind: 'brand_office', brand: o.unit.parent, unit: unit };   // unit：區域限區用
    if (title === 'rdd') return { kind: 'hq_exec' };
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
 * approver 能不能核 target（只算表格；人資主管、admin、att.extra 在 storeAttTargets_ 另外處理）。
 * approver／target＝{emp, status, unit, dept, title}；mode 同 attNeedOf_。
 * 任何人都不能核自己，唯一例外是核定工時的店長／廠長核自己（申請一律不能自己核）。
 * rctx＝區域 {on, idx}（選填，省略＝開關關）：品牌辦公室核門市店長／區經理申請時，區督導只限負責該店的區（docs/regions/spec.md 第 5 節）。
 *   head／brand_office 只在 req 模式出現，核定工時 hours 不受影響。
 *   Q4：開關開、且這家店沒有有效督導（Regions.gs regionStoreHasSupervisor_）→ head 另外放行同品牌總監（STORE_REQ_HEAD_NO_SUP_OFFICE）；
 *   開關關、或該店有有效督導 → 總監照舊不核店長。
 */
function attApproverOf_(approver, target, org, mode, rctx) {
  mode = storeAttMode_(mode);
  if (!approver || !target) return false;
  if (stfStr_(approver.status) !== 'active' || stfStr_(target.status) !== 'active') return false;
  var need = attNeedOf_(target, org, mode);
  if (!need) return false;
  var ao = storeOrgOf_(approver, org);
  if (!ao) return false;
  var title = stfStr_(approver.title);
  var aUnit = stfStr_(approver.unit);
  var sameMan = stfStr_(approver.emp) !== '' && stfStr_(approver.emp) === stfStr_(target.emp);
  var heads = mode === 'hours' ? STORE_HOURS_UNIT_HEAD_TITLES : STORE_REQ_UNIT_HEAD_TITLES;
  if (need.kind === 'unit') {
    if (sameMan && mode !== 'hours') return false;
    return ao.ladder === 'store' && heads.indexOf(title) !== -1 && aUnit === need.unit;
  }
  if (sameMan) return false;
  if (need.kind === 'head') {
    if (ao.ladder === 'store') return STORE_REQ_HEAD_BY_UNIT.indexOf(title) !== -1 && aUnit === need.unit;
    if (ao.ladder !== 'office' || ao.unit.parent !== need.brand) return false;
    if (STORE_REQ_HEAD_BY_OFFICE.indexOf(title) !== -1) return storeRegionCovers_(approver, title, need.unit, rctx);
    return STORE_REQ_HEAD_NO_SUP_OFFICE.indexOf(title) !== -1 && !!rctx && !!rctx.on &&
      !regionStoreHasSupervisor_(rctx.idx, need.unit);
  }
  if (need.kind === 'brand_office') return ao.ladder === 'office' && STORE_REQ_AM_OFFICE_TITLES.indexOf(title) !== -1 && ao.unit.parent === need.brand &&
    storeRegionCovers_(approver, title, need.unit, rctx);
  if (need.kind === 'hq_exec') return ao.ladder === 'hq' && STORE_REQ_RDD_HQ_TITLES.indexOf(title) !== -1;
  if (need.kind === 'office') return ao.ladder === 'office' && title === 'odir' && aUnit === need.unit;
  if (need.kind === 'dept') return ao.ladder === 'hq' && title === 'hm' && stfStr_(approver.dept) === need.dept;
  if (need.kind === 'mgmt') return ao.ladder === 'hq' && STORE_EXEC_TITLES.indexOf(title) !== -1;
  return false;
}

/** 區域限區（Regions.gs regionOfficeCovers_）；沒給 rctx 或開關關 → true */
function storeRegionCovers_(approver, title, unit, rctx) {
  if (!rctx || !rctx.on) return true;
  return regionOfficeCovers_({ emp: approver.emp, title: title }, unit, rctx);
}

/** 單位或職稱是空的、或代碼不存在／已停用 → true（正式資料不完整，才輪得到主店推算） */
function storeOrgIncomplete_(p, org) {
  var u = stfStr_(p.unit), t = stfStr_(p.title);
  if (!u || !t) return true;
  return !(org.unit[u] && org.unit[u].active && org.title[t] && org.title[t].active);
}

/**
 * 主店打卡推算（Eason 2026-10-18 選 A）：被核者單位或職稱不完整時，用主店打卡（home）對到的唯一一個 store 階梯單位，
 * 當作該單位 rank 1 的一般同仁。home(emp)＝{units: [單位代碼…]}（沒有主店打卡回 null）。
 * 回 {unit, title} 或 null（沒有主店、對到零個或多個單位、單位不是啟用的 store 階梯、org 沒有 rank 1 職稱）。
 */
function storeInferFromHome_(t, org, home) {
  if (!home) return null;
  var h = home(stfStr_(t.emp));
  if (!h || !h.units || h.units.length !== 1) return null;
  var u = org.unit[h.units[0]];
  if (!u || !u.active || (u.ladder || 'store') !== 'store') return null;
  var title = '';
  org.list.title.forEach(function (x) {
    if (!title && x.active && x.parent === 'store' && x.rank === 1) title = x.code;
  });
  return title ? { unit: u.code, title: title } : null;
}

/**
 * 把一位同仁變成「算名單用的被核者」。回 null＝不列入；
 * 否則回 {…同仁, pilotUnits, inferred, orphan}：正式資料完整 → 原樣（pilotUnits＝[unit]）；
 * 不完整且能推算 → unit／title 換成推算值、status 視為 active、inferred＝true；
 * 不完整又推算不出 → orphan＝true（只有人資主管與 admin 看得到，pilotUnits＝主店對到的全部單位）。
 * 只處理 active／unclaimed；責任制職稱（只在有填職稱時判斷）一律不列。
 */
function storeEffectiveTarget_(t0, org, home) {
  var st = stfStr_(t0.status);
  var e = {};
  Object.keys(t0).forEach(function (k) { e[k] = t0[k]; });
  if (!storeOrgIncomplete_(t0, org)) {
    if (st !== 'active') return null;
    e.pilotUnits = [stfStr_(t0.unit)];
    return e;
  }
  if (st !== 'active' && st !== 'unclaimed') return null;
  if (STORE_NO_ATT_TITLES.indexOf(stfStr_(t0.title)) !== -1) return null;
  var inf = storeInferFromHome_(t0, org, home);
  if (inf) {
    e.status = 'active'; e.unit = inf.unit; e.title = inf.title; e.dept = ''; e.inferred = true; e.pilotUnits = [inf.unit];
    return e;
  }
  var h = home ? home(stfStr_(t0.emp)) : null;
  e.orphan = true; e.pilotUnits = h && h.units ? h.units.slice() : [];
  return e;
}

/**
 * 這個人能核的人（尚未換成打卡帳號）。
 * me＝{emp, status, unit, dept, title}（admin 沒有同仁編號時 emp 為空）；flags＝{admin, hrHead, attExtra}；
 * people＝全部同仁物件陣列；home＝選填，emp → {units}（主店打卡推算用，見 storeInferFromHome_）；mode 同 attNeedOf_；rctx 同 attApproverOf_。回符合的 target 陣列。
 * 推算出來的人當作單位 rank 1 一般同仁；推算不出的 orphan 只有 admin／人資主管看得到。
 */
function storeAttTargets_(me, flags, people, org, home, mode, rctx) {
  mode = storeAttMode_(mode);
  var out = [];
  // admin／人資主管：全部要考勤的人、不含自己；核定工時的店長／廠長例外（含自己，同 attApproverOf_）；申請一律不含自己
  var selfOk = mode === 'hours' && STORE_HOURS_UNIT_HEAD_TITLES.indexOf(stfStr_(me.title)) !== -1;
  people.forEach(function (t0) {
    var t = storeEffectiveTarget_(t0, org, home);
    if (!t) return;
    if (!t.orphan && !attNeedOf_(t, org, mode)) return;
    var notSelf = !(stfStr_(me.emp) && stfStr_(me.emp) === stfStr_(t.emp));
    var ok = false;
    if (flags.admin || flags.hrHead) ok = notSelf || selfOk;
    else if (t.orphan) ok = false;
    else {
      ok = attApproverOf_(me, t, org, mode, rctx);
      if (!ok && flags.attExtra && notSelf && stfStr_(me.unit) && stfStr_(me.unit) === stfStr_(t.unit)) ok = true;
    }
    if (ok) out.push(t);
  });
  return out;
}

/** 「只看」可看的門市單位：org 裡存在且 active、ladder store、屬於督導／總監所在辦公室的品牌、不是央廚（osv 與 odir 共用） */
function storeViewUnitOk_(code, org, brand) {
  var u = code ? org.unit[code] : null;
  return !!(u && u.active && (u.ladder || 'store') === 'store' && brand && u.parent === brand && code !== STF_EXTRA_CK && brand !== STF_EXTRA_CK);
}

/**
 * 督導／總監「只看」考勤的門市單位代碼（純函式；docs/att-view/spec.md §2）。
 * osv（品牌辦公室區督導）→ regionIdx.bySupervisor[本人 emp] 各區的 stores 聯集（regionIdx 為 null／沒有本人＝[]）；
 * odir（品牌辦公室總監）→ 所屬品牌底下 active、ladder store、非 ck 的門市；其他職稱、非 active＝[]。回排序去重陣列。
 */
function attViewUnitsOf_(me, org, regionIdx) {
  if (!me || stfStr_(me.status) !== 'active') return [];
  var title = stfStr_(me.title);
  var o = storeOrgOf_(me, org);
  if (!o || o.ladder !== 'office') return [];
  var out = [];
  var brand = o.unit.parent;
  if (!brand || brand === STF_EXTRA_CK) return [];
  if (title === 'osv') {
    var codes = regionIdx && regionIdx.bySupervisor ? regionIdx.bySupervisor[stfStr_(me.emp)] : null;
    if (!codes || !codes.length) return [];
    codes.forEach(function (c) {
      var r = regionIdx.byRegion ? regionIdx.byRegion[c] : null;
      if (r && r.stores) r.stores.forEach(function (u) { if (storeViewUnitOk_(stfStr_(u), org, brand)) out.push(stfStr_(u)); });
    });
  } else if (title === 'odir') {
    org.list.unit.forEach(function (u) { if (storeViewUnitOk_(u.code, org, brand)) out.push(u.code); });
  } else {
    return [];
  }
  return storeUniqSorted_(out.filter(function (x) { return x; }));
}

/** 「只看」名單的被看者（尚未換成打卡帳號）：units 內、需要核定工時、非 orphan、非本人（與 storeAttTargets_ 分開，不把看混進核）。
 *  2026-10-26 起 ident 改走 storeAttLists_（同一套條件、只用在非支援帳號）；本函式留作測試對照舊算法（test 9j）。 */
function storeAttViewTargets_(me, people, org, home, units) {
  var out = [];
  if (!units || !units.length) return out;
  people.forEach(function (t0) {
    var t = storeEffectiveTarget_(t0, org, home);
    if (!t || t.orphan) return;
    if (!attNeedOf_(t, org, 'hours')) return;
    if (units.indexOf(stfStr_(t.unit)) === -1) return;
    if (stfStr_(me.emp) && stfStr_(me.emp) === stfStr_(t.emp)) return;
    out.push(t);
  });
  return out;
}

// ── 支援打卡：依「每一個打卡帳號所在的店」算名單（純函式，2026-10-26 docs/att-support/spec.md） ──

/** 兩個陣列有沒有交集 */
function storeAnyIn_(arr, set) {
  for (var i = 0; i < arr.length; i++) if (set.indexOf(arr[i]) !== -1) return true;
  return false;
}

/**
 * 這個打卡帳號算不算支援（spec §1）。t＝storeEffectiveTarget_ 的結果；units＝打卡店的 clkUnitsOf_。
 * 推算（inferred）／orphan 的人、總部打卡 hq、打卡店沒有填單位（或不在 clock_stores）、品牌辦公室同仁（給了 org 時）→ 不算（照舊）。
 */
function storeAttIsSupport_(t, storeCode, units, org) {
  if (!t || t.inferred || t.orphan) return false;
  if (storeCode === STORE_SELF_CLOCK) return false;
  // 2026-10-26 Eason：品牌辦公室同仁（區督導、行政、區經理 oam）到門市打卡不算支援，照原規則由辦公室總監核（不讓店長核督導）
  var tu = org && org.unit ? org.unit[stfStr_(t.unit)] : null;
  if (tu && tu.ladder === 'office') return false;
  if (!units || !units.length) return false;
  return units.indexOf(stfStr_(t.unit)) === -1;
}

/**
 * 全部打卡帳號（staff_clock state=confirmed、roster_active 不是 FALSE），依 people 順序、maps 順序：
 * [{t, m, units, support}]；t＝storeEffectiveTarget_（null 的人整個略過），units＝打卡店的單位清單（storeUnits[store_code]，沒有＝[]）。
 */
function storeAttAccounts_(people, org, home, maps, storeUnits) {
  var byEmp = {};
  (maps || []).forEach(function (m) {
    if (m.state !== 'confirmed' || m.roster_active === 'FALSE') return;
    (byEmp[m.emp_no] = byEmp[m.emp_no] || []).push(m);
  });
  var out = [];
  people.forEach(function (t0) {
    var t = storeEffectiveTarget_(t0, org, home);
    if (!t) return;
    (byEmp[t.emp] || []).forEach(function (m) {
      // 只認 org 裡 active 的 store 階梯單位（2026-10-26 Fable 審查 1：打錯或停用的 unit_code 當成沒填＝不算支援，免得沒有店端核定人、原主管又被降成只看）
      var units = ((storeUnits && storeUnits[m.store_code]) || []).filter(function (c) {
        var u = org.unit[c]; return !!(u && u.active && (u.ladder || 'store') === 'store');
      });
      out.push({ t: t, m: m, units: units, support: storeAttIsSupport_(t, m.store_code, units, org) });
    });
  });
  return out;
}

/**
 * 支援帳號的核定人（不含人資主管、admin、att.extra）：回 {emp: true}。units＝打卡店單位清單（只取 org 裡 active 的 store 階梯）。
 * 多單位的店：每一層把所有單位的人合起來看，取第一層有人的那層（不逐單位各自往上找）。
 * people 只認 status=active、單位職稱合法（storeOrgOf_）、有同仁編號的人；推算出來的人不當核定人。
 */
function storeSupportApprovers_(units, people, org, rctx) {
  var su = units.filter(function (c) { var u = org.unit[c]; return !!(u && u.active && (u.ladder || 'store') === 'store'); });
  var out = {};
  if (!su.length) return out;
  var cand = [];
  people.forEach(function (p) {
    if (stfStr_(p.status) !== 'active' || !stfStr_(p.emp)) return;
    var o = storeOrgOf_(p, org);
    if (o) cand.push({ emp: stfStr_(p.emp), title: stfStr_(p.title), unit: stfStr_(p.unit), ladder: o.ladder, brand: o.unit.parent });
  });
  var shops = su.filter(function (c) { return c !== STF_EXTRA_CK && org.unit[c].parent !== STF_EXTRA_CK; });   // 第 3、4 層只給門市（央廚沒有督導／總監這兩層）
  var layers = [
    function (c) { return c.ladder === 'store' && STORE_SUP_L1.indexOf(c.title) !== -1 && su.indexOf(c.unit) !== -1; },
    function (c) { return c.ladder === 'store' && STORE_SUP_L2.indexOf(c.title) !== -1 && su.indexOf(c.unit) !== -1; },
    function (c) {
      if (!rctx || !rctx.on || c.ladder !== 'office' || STORE_SUP_L3_OFFICE.indexOf(c.title) === -1) return false;
      return shops.some(function (u) { return org.unit[u].parent === c.brand && regionOfficeCovers_({ emp: c.emp, title: c.title }, u, rctx); });
    },
    function (c) {
      if (c.ladder !== 'office' || STORE_SUP_L4_OFFICE.indexOf(c.title) === -1) return false;
      return shops.some(function (u) { return org.unit[u].parent === c.brand; });
    }
  ];
  for (var i = 0; i < layers.length; i++) {
    var hit = cand.filter(layers[i]);
    if (hit.length) { hit.forEach(function (c) { out[c.emp] = true; }); return out; }
  }
  return out;
}

/** 打卡帳號 → 契約的一筆 {clock, emp_id, sub, name}；同一份名單以 clock|emp_id 去重，最後依 clock、emp_id 排序 */
function storeAttListAdd_(list, a) {
  var k = a.m.store_code + '|' + a.m.emp_id;
  if (list.seen[k]) return;
  list.seen[k] = true;
  list.rows.push({ clock: a.m.store_code, emp_id: a.m.emp_id, sub: a.t.emp, name: a.t.name });
}
function storeAttListOut_(list) {
  return list.rows.sort(function (a, b) {
    if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
    return a.emp_id < b.emp_id ? -1 : (a.emp_id > b.emp_id ? 1 : 0);
  });
}

/**
 * ident 的三份考勤名單（純函式；2026-10-26 起依「每一個打卡帳號所在的店」算，docs/att-support/spec.md）。
 * me／flags／people／org／home／rctx 同 storeAttTargets_；maps＝clkMaps_()；storeUnits＝{打卡店代碼: clkUnitsOf_}；pilot＝試點單位陣列。
 * opt＝{viewUnits: 督導／總監只看的單位（attViewUnitsOf_，呼叫端只在 REGIONS_ON 且非 admin／人資主管才給），
 *       exViewUnits: 指定門市只看考勤 att.view@<單位> 的單位（呼叫端只在非 admin／人資主管才給）, origView: 原單位主管只看支援帳號（預設 true）}。
 * 回 {people, req_people, view_people}，每份都是 {clock, emp_id, sub, name}、依 clock、emp_id 排序。
 *
 * 非支援帳號：完全照舊（人在 storeAttTargets_ 名單內、人所屬單位在試點 → 他所有非支援帳號；只看＝人所屬單位在 viewUnits）。
 * 支援帳號（storeAttIsSupport_）：試點看打卡店單位；核定＝storeSupportApprovers_ 那層、人資主管、admin、att.extra（打卡店單位＝我的單位）；
 *   任何人都不核自己的支援帳號；原本（以人為單位）能核這個人、但核不到這個帳號的人 → 只看；督導／總監只看看打卡店單位。
 * 指定門市只看（exViewUnits）：打卡店單位在清單內、且在試點的全部帳號（帳號主人要核工時、非 orphan、非本人）。
 */
function storeAttLists_(me, flags, people, org, home, maps, storeUnits, rctx, pilot, opt) {
  opt = opt || {};
  flags = flags || {};
  var L = { hours: { seen: {}, rows: [] }, req: { seen: {}, rows: [] }, view: { seen: {}, rows: [] } };
  var done = function () { return { people: storeAttListOut_(L.hours), req_people: storeAttListOut_(L.req), view_people: storeAttListOut_(L.view) }; };
  if (!pilot || !pilot.length) return done();
  var viewUnits = opt.viewUnits || [];
  var exViewUnits = opt.exViewUnits || [];
  var origView = opt.origView !== false;
  var empSet = function (arr) { var o = {}; arr.forEach(function (t) { o[t.emp] = true; }); return o; };
  var hrsT = empSet(storeAttTargets_(me, flags, people, org, home, 'hours', rctx));
  var reqT = empSet(storeAttTargets_(me, flags, people, org, home, 'req', rctx));
  var myEmp = stfStr_(me.emp), myUnit = stfStr_(me.unit);
  var apprCache = {};
  storeAttAccounts_(people, org, home, maps, storeUnits).forEach(function (a) {
    var t = a.t;
    var self = !!myEmp && myEmp === stfStr_(t.emp);
    var needH = !t.orphan && !!attNeedOf_(t, org, 'hours');
    var viewable = needH && !self;   // 只看名單的共同條件（同 storeAttViewTargets_）
    if (!a.support) {
      var pOk = storeAnyIn_(t.pilotUnits || [t.unit], pilot);
      if (pOk && hrsT[t.emp]) storeAttListAdd_(L.hours, a);
      if (pOk && reqT[t.emp]) storeAttListAdd_(L.req, a);
      if (pOk && viewable && viewUnits.indexOf(stfStr_(t.unit)) !== -1) storeAttListAdd_(L.view, a);
    } else if (storeAnyIn_(a.units, pilot) && !self) {
      var key = a.units.join(',');
      if (!apprCache[key]) apprCache[key] = storeSupportApprovers_(a.units, people, org, rctx);
      var appr = !!flags.admin || !!flags.hrHead || (!!myEmp && !!apprCache[key][myEmp]) ||
        (!!flags.attExtra && !!myUnit && a.units.indexOf(myUnit) !== -1);
      if (appr) {
        if (needH) storeAttListAdd_(L.hours, a);
        if (!t.orphan && attNeedOf_(t, org, 'req')) storeAttListAdd_(L.req, a);
      } else if (viewable && ((origView && (hrsT[t.emp] || reqT[t.emp])) || storeAnyIn_(a.units, viewUnits))) {
        storeAttListAdd_(L.view, a);
      }
    }
    // 指定門市只看考勤（att.view@<單位>）：打卡店單位＝該單位（且在試點），支援與否都算
    if (viewable && exViewUnits.length && !L.hours.seen[a.m.store_code + '|' + a.m.emp_id]) {
      var hitU = a.units.filter(function (u) { return exViewUnits.indexOf(u) !== -1 && pilot.indexOf(u) !== -1; });
      if (hitU.length) storeAttListAdd_(L.view, a);
    }
  });
  return done();
}

/** perms 裡的 att.view@<單位> → 合法單位（org 存在、active、store 階梯含 ck）排序去重；Perms.gs 沒載入＝[] */
function storeAttViewExUnits_(perms, org) {
  if (typeof permAttViewUnit_ !== 'function') return [];
  var out = [];
  (perms || []).forEach(function (c) {
    var u = permAttViewUnit_(c);
    var d = u ? org.unit[u] : null;
    if (d && d.active && (d.ladder || 'store') === 'store') out.push(u);
  });
  return storeUniqSorted_(out);
}

/** 打卡店代碼 → 單位清單（clock_stores 的 unit_code）；表沒建＝{} */
function storeClockUnits_() {
  var out = {};
  if (!clkSheetsReady_()) return out;
  clkStores_().forEach(function (st) { out[st.store_code] = clkUnitsOf_(st); });
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

/** 主店打卡對照：emp → {store, units}。取 staff_clock 中 state=confirmed、roster_active 不是 FALSE、role=home 的那一筆（多個不同店互相矛盾就當沒有）；units＝該店 clock_stores 的 unit_code（逗號多個都列） */
function storeHomeFn_() {
  if (!clkSheetsReady_()) return function () { return null; };
  var byStore = {};
  clkStores_().forEach(function (st) { byStore[st.store_code] = clkUnitsOf_(st); });
  var homes = {};
  clkMaps_().forEach(function (m) {
    if (m.state !== 'confirmed' || m.roster_active === 'FALSE' || m.role !== 'home') return;
    (homes[m.emp_no] = homes[m.emp_no] || {})[m.store_code] = true;
  });
  return function (emp) {
    var h = homes[emp];
    if (!h) return null;
    var codes = Object.keys(h);
    if (codes.length !== 1) return null;
    return { store: codes[0], units: byStore[codes[0]] || [] };
  };
}

/**
 * 總部排班身分（ident.self，2026-10-25 docs/schedule-hq/spec.md §3.1）：本人 staff_clock 中 state=confirmed、roster_active 不是 FALSE、
 * 打卡店別（store_code）＝'hq' 的對照；不論 role、不受試點限制。approval＝有人核他工時（attNeedOf_ 'hours' 不是 null）；
 * false（總監、執行長以上）→ 營運系統那邊送出就生效。admin 沒有同仁編號 → []。
 */
function storeSelfClocks_(p, org) {
  if (!p || !p.emp || !clkSheetsReady_()) return [];
  var approval = attNeedOf_(p, org, 'hours') !== null;
  var seen = {}, out = [];
  clkMaps_().forEach(function (m) {
    if (m.emp_no !== p.emp || m.state !== 'confirmed' || m.roster_active === 'FALSE' || m.store_code !== STORE_SELF_CLOCK) return;
    var k = m.store_code + '|' + m.emp_id;
    if (seen[k]) return;
    seen[k] = true;
    out.push({ clock: m.store_code, emp_id: m.emp_id, approval: approval });
  });
  out.sort(function (a, b) { return a.emp_id < b.emp_id ? -1 : (a.emp_id > b.emp_id ? 1 : 0); });
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
    if (valid && STORE_ATT_HEAD_TITLES.indexOf(p.title) !== -1 && valid.ladder === 'store' && pilot.indexOf(p.unit) !== -1) managed = [p.unit];
    if (valid && perms.indexOf(STORE_PERM_VOID) !== -1 && pilot.indexOf(p.unit) !== -1) voidUnits = [p.unit];
  }

  var home = storeHomeFn_();
  var rctx = typeof regionCtx_ === 'function' ? regionCtx_() : null;   // 區域：入口只讀一次
  var viewUnits = [];
  var viewOn = false;
  try { viewOn = PropertiesService.getScriptProperties().getProperty('REGIONS_ON') === '1'; } catch (e) { viewOn = false; }
  if (viewOn && p && !admin && !hrHead) {
    var vIdx = null;
    if (p.title === 'osv' && typeof regionIndexLive_ === 'function') {
      try { vIdx = regionIndexLive_(); } catch (e2) { vIdx = null; }
    }
    viewUnits = attViewUnitsOf_(me, org, vIdx);
  }
  // 2026-10-26 依打卡帳號所在的店算（支援打卡交給打卡店主管；docs/att-support/spec.md）＋ 指定門市只看考勤（att.view@<單位>）
  var lists = storeAttLists_(me, flags, people, org, home, clkSheetsReady_() ? clkMaps_() : [], storeClockUnits_(), rctx, pilot, {
    viewUnits: viewUnits,
    exViewUnits: (p && !admin && !hrHead) ? storeAttViewExUnits_(perms, org) : []
  });
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
    att: { people: lists.people, req_people: lists.req_people, view_people: lists.view_people },   // people＝核定工時；req_people＝加班單／請假單／忘刷單（2026-10-21）；view_people＝只看（督導／總監 REGIONS_ON='1'、原單位主管看支援帳號、att.view@<單位>；2026-10-25／26）
    self: storeSelfClocks_(p, org)   // 總部排班身分（2026-10-25）：只列 clock＝hq，不受試點限制
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
 * 否則：在職且（職稱 STORE_ATT_GATE_TITLES：sm／fm／am／rdd／osv／odir／hm／ceo／gm／chair、或人資主管、或有 att.extra、
 *   或有合法的 att.view@<單位>（2026-10-26 指定門市只看考勤））→ true。
 * admin 本來就是 '*'，不在這裡判斷。values＝staff 分頁一列。
 */
function storeAttGate_(values) {
  if (!storePilotUnits_().length) return false;
  if (!values || stfStr_(values[STF_COL.status]) !== 'active') return false;
  var p = { status: 'active', dept: stfStr_(values[STF_COL.dept]), title: stfStr_(values[STF_COL.title]) };
  if (STORE_ATT_GATE_TITLES.indexOf(p.title) !== -1) return true;
  if (stfIsHrHead_(p)) return true;
  var perms = storeRowPerms_(values);
  if (perms.indexOf(STORE_PERM_ATT_EXTRA) !== -1) return true;
  // 沒有 att.view@ 碼就不讀 org（Fable 審查 2：一般同仁每次登入都會走到這裡）
  if (!perms.some(function (c) { return String(c).indexOf('att.view@') === 0; })) return false;
  return storeAttViewExUnits_(perms, stfReadOrg_()).length > 0;
}

/**
 * 衍生權限 platform.sched（「排班管理」選單；不寫進 roles）。
 * 總開關（STORE_SSO_UNITS）空 → false。否則在職且（職稱 STORE_SCHED_GATE_TITLES：sm／fm／am、或人資主管、
 * 或所在單位階梯為 hq／office 的總部、品牌辦公室同仁，且本人有 confirmed、roster_active 不是 FALSE 的 hq 打卡對照）→ true。不含 att.extra。admin 是 '*'，不在這裡判斷。values＝staff 分頁一列。
 */
function storeSchedGate_(values) {
  if (!storePilotUnits_().length) return false;
  if (!values || stfStr_(values[STF_COL.status]) !== 'active') return false;
  var p = { status: 'active', dept: stfStr_(values[STF_COL.dept]), title: stfStr_(values[STF_COL.title]) };
  if (STORE_SCHED_GATE_TITLES.indexOf(p.title) !== -1) return true;
  if (stfIsHrHead_(p)) return true;
  if (storeSchedViewGate_(values)) return true;   // 督導／總監「只看」名單非空＝唯讀看班表（2026-10-25 Eason）
  var u = stfReadOrg_().unit[stfStr_(values[STF_COL.unit])];   // 總部／品牌辦公室同仁（單位階梯 hq／office）
  if (!(u && u.active && STORE_SCHED_GATE_LADDERS.indexOf(u.ladder || 'store') !== -1)) return false;
  return storeHasSelfClock_(stfNormEmp_(values[STF_COL.emp_no]));   // 還要有 hq 打卡對照（跟 ident.self／storeSelfClocks_ 同一套判斷），沒有對照的人營運系統沒有入口
}

/**
 * 督導／總監唯讀看班表的入口（2026-10-25 Eason：跟「只看考勤」同一批、只看門市）：
 * REGIONS_ON='1' 且職稱 osv／odir、只看名單（同 ident att.view_people 的算法）非空 → true。營運系統端依 att.view_people 給唯讀排班（scheduleAdmin 仍 false、看不到特休）。
 * 區域索引讀失敗＝督導沒有（不拖垮登入）；總監不靠索引。
 */
function storeSchedViewGate_(values) {
  var on = false;
  try { on = PropertiesService.getScriptProperties().getProperty('REGIONS_ON') === '1'; } catch (e) { on = false; }
  if (!on) return false;
  var title = stfStr_(values[STF_COL.title]);
  if (title !== 'osv' && title !== 'odir') return false;
  var me = { emp: stfNormEmp_(values[STF_COL.emp_no]), status: stfStr_(values[STF_COL.status]), unit: stfStr_(values[STF_COL.unit]), dept: stfStr_(values[STF_COL.dept]), title: title };
  var idx = null;
  if (title === 'osv') {
    if (typeof regionIndexLive_ !== 'function') return false;
    try { idx = regionIndexLive_(); } catch (e2) { return false; }
  }
  try {
    // 跟 ident 的 att.view_people 走同一條路（Fable QA 第 2 條）：區內要有需核工時、在試點、有打卡對照的同仁，營運系統才會給排班功能
    var org = stfReadOrg_();
    var units = attViewUnitsOf_(me, org, idx);
    if (!units.length) return false;
    // 2026-10-26 依打卡帳號所在的店（docs/att-support/spec.md）：只算督導／總監的區域只看（不含原單位主管只看、att.view@），旗標全空＝不算核定
    var rctx = null;
    try { rctx = typeof regionCtx_ === 'function' ? regionCtx_() : null; } catch (e4) { rctx = null; }
    return storeAttLists_(me, {}, storePeople_(), org, storeHomeFn_(), clkSheetsReady_() ? clkMaps_() : [], storeClockUnits_(), rctx, storePilotUnits_(),
      { viewUnits: units, origView: false }).view_people.length > 0;
  } catch (e3) { return false; }
}

/** 本人有沒有 confirmed、roster_active 不是 FALSE 的總部（STORE_SELF_CLOCK）打卡對照；表沒建或讀失敗＝沒有 */
function storeHasSelfClock_(emp) {
  if (!emp) return false;
  try {
    if (!clkSheetsReady_()) return false;
    return clkMaps_().some(function (m) {
      return m.emp_no === emp && m.state === 'confirmed' && m.roster_active !== 'FALSE' && m.store_code === STORE_SELF_CLOCK;
    });
  } catch (e) {
    return false;
  }
}

function storeHasAttExtra_(values) {
  return storeRowPerms_(values).indexOf(STORE_PERM_ATT_EXTRA) !== -1;
}

/** staff 一列現在的第二期權限（perm 表沒建或讀失敗＝[]） */
function storeRowPerms_(values) {
  try {
    var emp = stfNormEmp_(values[STF_COL.emp_no]);
    var ctx = permLoadCtx_(false);
    if (!ctx.inited) return [];
    return permComputeRow_(ctx, values, stfSplitCodes_(stfReadExtraMap_()[emp])).perms;
  } catch (e) {
    return [];
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
