/**
 * 個人帳號第二期：權限設定的 action（docs/permissions/spec.md §6，衝突以第 13、13.1 節為準）。
 * 依賴 Perms.gs（常數、permCompute_、讀表）、Auth.gs（authResolveSession_／hasPerm_）、Staff.gs（org／staff 讀取、stfLog_）。
 * 規則：
 *  - 全部經 authResolveSession_；寫入由 Code.gs 的 MUTATING_ACTIONS 統一拿 LockService 全域鎖；時間一律台北。
 *  - 表未初始化：讀取回 {inited:false}、寫入回 not_inited；**不自動建表**（建表只有 permInit，admin 按「初始化」）。
 *  - 失敗統一 {ok:false, error:'<中文>', code:'<代碼>'}；staff_log 只寫規則 id／權限碼，不寫個資。
 *  - 這裡的 action 都不寫外部系統。
 */

var PERM_AC_MAX_OPS = 50;
var PERM_AC_AUDIT_PEOPLE_CAP = 150;
var PERM_AC_AUDIT_LIST_MAX = 500;
var PERM_AC_STORE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
var PERM_AC_LADDER_NAMES = { store: '門市', office: '品牌辦公室', hq: '總部' };

function permAcFail_(code, message) { return { ok: false, error: message, code: code }; }
function permAcNotInited_() { return permAcFail_('not_inited', '權限分頁還沒初始化，請系統管理者先按「初始化」'); }
function permAcNoPerm_() { return permAcFail_('no_perm', '沒有權限'); }
function permAcBad_(message) { return permAcFail_('bad_input', message || '輸入格式錯誤'); }

function permAcIsAdmin_(sess) { return !!sess && !!sess.user && String(sess.user.role) === 'admin'; }

/** 驗 token；admin 才放行 */
function permAcAdmin_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  if (!permAcIsAdmin_(sess)) return permAcNoPerm_();
  return sess;
}
/**
 * 個別例外專用：admin 放行所有碼；人資主管（stfIsHrHead_，且要有 platform.permmap，2026-10-29）只能動 STORE_HR_GRANTABLE 三碼（store.void、att.extra、platform.bulletin）與兼任店長 store.sm@<單位>，
 * 且不能對自己設。其他碼、其他人一律 no_perm。perm＝這次要動的權限碼（列表時傳空字串＝只驗身分）。
 * 回 session（附 hrOnly:true 表示非 admin）或錯誤物件。
 */
function permAcExAuth_(token, perm, targetEmp) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  if (permAcIsAdmin_(sess)) return sess;
  if (String(sess.user.role) !== 'staff' || typeof stfIsHrHead_ !== 'function') return permAcNoPerm_();
  var hit = stfFindByUserId_(sess.user.id);
  if (!hit || !stfIsHrHead_({ status: permStr_(hit.values[STF_COL.status]), dept: permStr_(hit.values[STF_COL.dept]), title: permStr_(hit.values[STF_COL.title]) })) return permAcNoPerm_();
  if (!hasPerm_(sess.perms, 'platform.permmap')) return permAcNoPerm_();   // 2026-10-29 與對照表（permAcMapAccess_）一致：人資主管也要有 platform.permmap 才能設個別例外
  if (perm !== '' && STORE_HR_GRANTABLE.indexOf(perm) === -1 && !permActingUnit_(perm)) return permAcNoPerm_();   // 2026-10-29 兼任店長 store.sm@<單位> 人資也能設
  if (targetEmp && permStr_(hit.values[STF_COL.emp_no]).toUpperCase() === permStr_(targetEmp).toUpperCase()) {
    return permAcFail_('perm_self', '不能對自己設定例外');
  }
  sess.hrOnly = true;
  return sess;
}

/** 驗 token；platform.permmap 或 admin 放行 */
function permAcMapAccess_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  if (!permAcIsAdmin_(sess) && !hasPerm_(sess.perms, 'platform.permmap')) return permAcNoPerm_();
  return sess;
}

function permAcPad_(n) { var s = String(n); while (s.length < 3) s = '0' + s; return s; }

/** 下一個流水號：prefix＋三位數（超過 999 自然延長）；掃全部列（含停用）取最大 */
function permAcNextId_(rows, prefix) {
  var re = new RegExp('^' + prefix + '(\\d+)$');
  var max = 0;
  rows.forEach(function (r) {
    var m = re.exec(permStr_(r[0]));
    if (m && +m[1] > max) max = +m[1];
  });
  return function () { max++; return prefix + permAcPad_(max); };
}

function permAcStaffNameMap_() {
  var map = {};
  stfAllRows_().forEach(function (r) { map[permStr_(r.values[STF_COL.emp_no]).toUpperCase()] = permStr_(r.values[STF_COL.name]); });
  return map;
}

/** 用某個假設的 rules／exs，對一列 staff 算 permCompute_ 權限 */
function permAcPerms_(tables, org, today, values, extra, rules, exs) {
  var ctx = { org: org, rules: rules, exs: exs, storeMap: tables.storeMap, today: today };
  return permComputeRow_(ctx, values, extra).perms;
}

/**
 * 對所有 active 同仁，重算「假設前／後」的規則與例外，回有差異的人 [{emp_no, added, removed}]。
 * before／after = {rules, exs, storeMap?}
 */
function permAcAffected_(org, today, before, after) {
  var extraMap = stfReadExtraMap_();
  var out = [];
  stfAllRows_().forEach(function (r) {
    if (permStr_(r.values[STF_COL.status]) !== 'active') return;
    var emp = permStr_(r.values[STF_COL.emp_no]).toUpperCase();
    var extra = stfSplitCodes_(extraMap[emp]);
    var b = permComputeRow_({ org: org, rules: before.rules, exs: before.exs, storeMap: before.storeMap, today: today }, r.values, extra).perms;
    var a = permComputeRow_({ org: org, rules: after.rules, exs: after.exs, storeMap: after.storeMap, today: today }, r.values, extra).perms;
    var d = permDiff_(b, a);
    if (d) out.push({ emp_no: emp, added: d.added, removed: d.removed });
  });
  return out;
}

// ============================================================
// permInit（admin）
// ============================================================
function handlePermInit_(token) {
  var sess = permAcAdmin_(token);
  if (!sess.ok) return sess;
  var r = permInit_(sess.user);
  if (!r.ok) return permAcFail_(r.error, r.message);
  stfLog_('', 'perm_init', sess.user.id, 'created:' + r.created.join('|') + ' rules:' + r.rules_seeded + ' stores:' + r.stores_seeded);
  return { ok: true, data: r };
}

// ============================================================
// permMapGet／permMapSave（platform.permmap 或 admin）
// ============================================================

/**
 * 每個「身分鍵」命中幾位 active 同仁。鍵＝ladder|dept|title（dept 空＝不分部門，title '*'＝全部職稱）。
 * 命中規則同 permCompute_：組織一致（單位、職稱存在且啟用、職稱屬該單位階梯）、ladder 相同、
 * title 相同或目標為 *、目標 dept 空或屬於主要＋有效兼任部門（停用部門不算）。
 */
function permAcCounts_(permOrg, keys) {
  var extraMap = stfReadExtraMap_();
  var counts = {};
  keys.forEach(function (k) { counts[k] = 0; });
  var parsed = keys.map(function (k) { var a = k.split('|'); return { key: k, ladder: a[0], dept: a[1] || '', title: a[2] || '' }; });
  stfAllRows_().forEach(function (r) {
    var st = permStaffObj_(r.values, stfSplitCodes_(extraMap[permStr_(r.values[STF_COL.emp_no]).toUpperCase()]));
    if (permStr_(st.status).toLowerCase() !== 'active') return;
    var unit = permOrg.units[st.unit];
    if (!unit || unit.active === false) return;
    var ladder = permStr_(unit.ladder);
    var tdef = st.title && permOrg.titles[st.title];
    if (!tdef || tdef.active === false || permStr_(tdef.parent) !== ladder) return;
    // 單位限定職稱（與 permCompute_ 同一關）：例如切換後還掛中央工廠的店長不算人數
    if (permOrg.unitRules && typeof stfTitleUnitOk_ === 'function' && !stfTitleUnitOk_(permOrg.unitRules, st.title, st.unit)) return;
    var depts = {};
    [st.dept].concat(st.extra_depts || []).forEach(function (d) {
      d = permStr_(d);
      var def = d && permOrg.depts[d];
      if (def && def.active !== false) depts[d] = true;
    });
    parsed.forEach(function (k) {
      if (k.ladder !== ladder) return;
      if (k.title !== '*' && k.title !== st.title) return;
      if (k.dept !== '' && !depts[k.dept]) return;
      counts[k.key]++;
    });
  });
  return counts;
}

/** permMapGet 要算人數的鍵：每個階梯的職稱、總部每個啟用部門的「全部職稱」與每個總部職稱，再加現有規則的目標 */
function permAcCountKeys_(org, rules) {
  var seen = {};
  var out = [];
  var add = function (l, d, t) { var k = l + '|' + d + '|' + t; if (!seen[k]) { seen[k] = true; out.push(k); } };
  var titles = org.list.title.filter(function (x) { return x.active; });
  titles.forEach(function (t) { add(t.parent, '', t.code); });
  var depts = org.list.dept.filter(function (x) { return x.active; });
  depts.forEach(function (d) {
    add('hq', d.code, '*');
    titles.forEach(function (t) { if (t.parent === 'hq') add('hq', d.code, t.code); });
  });
  rules.forEach(function (r) { add(r.ladder, r.dept, r.title); });
  return out;
}

function handlePermMapGet_(token) {
  var sess = permAcMapAccess_(token);
  if (!sess.ok) return sess;
  var t = permLoadTables_();
  if (!t.inited) return { ok: true, data: { inited: false } };
  var org = stfReadOrg_();
  var counts = permAcCounts_(permOrgIndex_(), permAcCountKeys_(org, t.rules));
  return { ok: true, data: {
    inited: true,
    counts: counts,
    rules: t.rules.map(function (r) { return { rule_id: r.rule_id, ladder: r.ladder, dept: r.dept, title: r.title, perm: r.perm }; }),
    grantable: PERM_GRANTABLE.slice(),
    locked: PERM_LOCKED.slice(),
    names: PERM_GRANTABLE.reduce(function (m, p) { m[p] = permName_(p); return m; }, {}),
    ladders: PERM_LADDERS.map(function (l) { return { code: l, name: PERM_AC_LADDER_NAMES[l] || l }; }),
    titles: org.list.title.filter(function (x) { return x.active; }).map(function (x) { return { code: x.code, name: x.name, ladder: x.parent, rank: x.rank }; }),
    depts: org.list.dept.filter(function (x) { return x.active; }).map(function (x) { return { code: x.code, name: x.name, unit: x.parent }; }),
    is_admin: permAcIsAdmin_(sess)
  } };
}

function handlePermMapSave_(token, payload) {
  var sess = permAcMapAccess_(token);
  if (!sess.ok) return sess;
  payload = payload || {};
  var add = payload.add === undefined ? [] : payload.add;
  var remove = payload.remove === undefined ? [] : payload.remove;
  if (!Array.isArray(add) || !Array.isArray(remove)) return permAcBad_();
  if (!add.length && !remove.length) return permAcBad_('沒有要改的項目');
  if (add.length > PERM_AC_MAX_OPS || remove.length > PERM_AC_MAX_OPS) return permAcBad_('一次最多改 ' + PERM_AC_MAX_OPS + ' 條');
  var tables = permLoadTables_();
  if (!tables.inited) return permAcNotInited_();

  var isAdmin = permAcIsAdmin_(sess);
  var org = permOrgIndex_();
  var today = permTodayTaipei_();

  // 1. 逐條驗證（任何一條不合法或鎖碼 → 整批拒絕）
  var newRules = [];
  var sameRule = function (a, b) { return a.ladder === b.ladder && a.dept === b.dept && a.title === b.title && a.perm === b.perm; };
  for (var i = 0; i < add.length; i++) {
    var a = add[i];
    if (!a || typeof a !== 'object' || Array.isArray(a)) return permAcBad_();
    var rule = { ladder: permStr_(a.ladder), dept: permStr_(a.dept), title: permStr_(a.title), perm: permStr_(a.perm) };
    var verr = permValidateRule_(rule, org, isAdmin);
    if (verr) return permAcFail_(verr.error, verr.message);
    var dup = tables.rules.some(function (x) { return sameRule(x, rule); }) || newRules.some(function (x) { return sameRule(x, rule); });
    if (dup) return permAcFail_('dup_rule', '這條規則已經存在');
    newRules.push(rule);
  }
  var removeSet = {};
  var removedRules = [];
  for (var j = 0; j < remove.length; j++) {
    var rid = remove[j];
    if (typeof rid !== 'string') return permAcBad_();
    rid = rid.trim();
    var hit = null;
    for (var k = 0; k < tables.rules.length; k++) if (tables.rules[k].rule_id === rid) hit = tables.rules[k];
    if (!hit) return permAcFail_('no_rule', '找不到這條規則：' + rid);
    if (!isAdmin && PERM_LOCKED.indexOf(hit.perm) !== -1) return permAcFail_('perm_locked', '只有系統管理者能改這個功能的對象');
    if (!removeSet[rid]) { removeSet[rid] = true; removedRules.push(hit); }
  }

  // 2. 假設改完後的規則集
  var mapT = permReadTable_(SpreadsheetApp.getActive(), PERM_SHEET_MAP, PERM_MAP_HEADERS);
  var nextId = permAcNextId_(mapT.rows, 'R');
  var addedIds = [];
  var addedObjs = newRules.map(function (r) {
    var id = nextId();
    addedIds.push(id);
    return { rule_id: id, ladder: r.ladder, dept: r.dept, title: r.title, perm: r.perm };
  });
  var rulesAfter = tables.rules.filter(function (r) { return !removeSet[r.rule_id]; }).concat(addedObjs);
  var extraMap = stfReadExtraMap_();

  // 3. 操作者本人重算前後不同 → 整批拒絕（admin 例外）
  if (!isAdmin) {
    var op = stfFindByUserId_(sess.user.id);
    if (op) {
      var opExtra = stfSplitCodes_(extraMap[permStr_(op.values[STF_COL.emp_no]).toUpperCase()]);
      var pb = permAcPerms_(tables, org, today, op.values, opExtra, tables.rules, tables.exs);
      var pa = permAcPerms_(tables, org, today, op.values, opExtra, rulesAfter, tables.exs);
      if (pb.join('|') !== pa.join('|')) return permAcFail_('perm_self', '這次修改會改變你自己的權限，請找系統管理員處理');
    }
  }

  // 4. 受影響同仁（寫入前先算）
  var affected = permAcAffected_(org, today,
    { rules: tables.rules, exs: tables.exs, storeMap: tables.storeMap },
    { rules: rulesAfter, exs: tables.exs, storeMap: tables.storeMap });

  // 4.5 預覽：驗證都過了，但不寫入，回實際會變的人
  if (payload.preview === true) {
    var pnames = permAcStaffNameMap_();
    return { ok: true, data: { preview: true, affected: affected.length, people: affected.map(function (p) {
      return { emp_no: p.emp_no, name: pnames[p.emp_no] || '', added: p.added, removed: p.removed };
    }) } };
  }

  // 5. 寫入
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(PERM_SHEET_MAP);
  var now = permNowText_();
  var by = permStr_(sess.user.id);
  mapT.rows.forEach(function (r, idx) {
    var id = permStr_(r[0]);
    if (removeSet[id] && permIsActive_(r[5])) {
      var rowNo = idx + 2;
      sh.getRange(rowNo, 6).setValue('FALSE');
      sh.getRange(rowNo, 7, 1, 2).setValues([[now, by]]);
    }
  });
  if (addedObjs.length) {
    var rows = addedObjs.map(function (r) { return [r.rule_id, r.ladder, r.dept, r.title, r.perm, 'TRUE', now, by]; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, PERM_MAP_HEADERS.length).setValues(rows);
  }
  stfLog_('', 'perm_map_save', by,
    addedObjs.map(function (r) { return '+' + r.rule_id + '(' + r.perm + ')'; }).concat(removedRules.map(function (r) { return '-' + r.rule_id + '(' + r.perm + ')'; })).join(';'));
  if (affected.length) {
    var detail = JSON.stringify({ rules_added: addedIds, rules_removed: removedRules.map(function (r) { return r.rule_id; }), affected: affected.length, people: affected.slice(0, PERM_AC_AUDIT_PEOPLE_CAP) });
    permAuditAppend_(by, '', detail, '', 'perm_map');
  }
  return { ok: true, data: { added: addedIds, removed: removedRules.map(function (r) { return r.rule_id; }), affected: affected.length } };
}

// ============================================================
// permWho（platform.permmap 或 admin）：查某位同仁現在能用什麼、是哪條規則給的
// ============================================================
function handlePermWho_(token, payload) {
  var sess = permAcMapAccess_(token);
  if (!sess.ok) return sess;
  var q = permStr_(payload && payload.q);
  if (!q) return permAcBad_('請輸入姓名或編號');
  if (q.length > 40) return permAcBad_();
  var ctx = permLoadCtx_(false);
  if (!ctx.inited) return permAcNotInited_();
  var org = stfReadOrg_();
  var extraMap = stfReadExtraMap_();
  var qUp = q.toUpperCase();
  var exact = [];
  var fuzzy = [];
  stfAllRows_().forEach(function (r) {
    if (permStr_(r.values[STF_COL.status]) !== 'active') return;
    var emp = permStr_(r.values[STF_COL.emp_no]).toUpperCase();
    var name = permStr_(r.values[STF_COL.name]);
    if (emp === qUp) exact.push(r);
    else if (name.indexOf(q) !== -1) fuzzy.push(r);
  });
  var hits = (exact.length ? exact : fuzzy).slice(0, 10);
  var items = hits.map(function (r) {
    var emp = permStr_(r.values[STF_COL.emp_no]).toUpperCase();
    var c = permComputeRow_(ctx, r.values, stfSplitCodes_(extraMap[emp]));
    var unit = org.unit[permStr_(r.values[STF_COL.unit])];
    var title = org.title[permStr_(r.values[STF_COL.title])];
    var dept = org.dept[permStr_(r.values[STF_COL.dept])];
    return {
      emp_no: emp, name: permStr_(r.values[STF_COL.name]),
      unit_name: unit ? unit.name : '', dept_name: dept ? dept.name : '', title_name: title ? title.name : '',
      perms: c.perms, sources: c.sources, audit_scope: c.auditScope
    };
  });
  return { ok: true, data: { items: items } };
}

// ============================================================
// permExList／permExSave／permExRevoke（admin）
// ============================================================
function handlePermExList_(token, payload) {
  var sess = permAcExAuth_(token, '', '');
  if (!sess.ok) return sess;
  var ss = SpreadsheetApp.getActive();
  var t = permLoadTables_();
  if (!t.inited) return { ok: true, data: { inited: false } };
  var want = permStr_(payload && payload.emp_no).toUpperCase();
  var today = permTodayTaipei_();
  var names = permAcStaffNameMap_();
  var items = [];
  permReadTable_(ss, PERM_SHEET_EX, PERM_EX_HEADERS).rows.forEach(function (r) {
    var emp = permStr_(r[1]).toUpperCase();
    if (want && emp !== want) return;
    if (sess.hrOnly && STORE_HR_GRANTABLE.indexOf(permStr_(r[2])) === -1 && !permActingUnit_(r[2])) return;   // 人資主管只看得到自己能管的三碼＋兼任店長
    var active = permIsActive_(r[6]);
    var until = permNormDate_(r[4]);
    items.push({
      ex_id: permStr_(r[0]), emp_no: emp, name: names[emp] || '', perm: permStr_(r[2]), mode: permStr_(r[3]).toLowerCase(),
      until: until, note: permStr_(r[5]), active: active,
      status: !active ? 'revoked' : ((permStr_(r[4]) !== '' && (until === '' ? false : until < today)) ? 'expired' : 'active'),
      created_at: permStr_(r[7]), created_by: permStr_(r[8]), revoked_at: permStr_(r[9]), revoked_by: permStr_(r[10])
    });
  });
  var data = { inited: true, items: items };
  // 2026-10-29：個別例外的功能下拉以這份為準（admin＝PERM_GRANTABLE 全部；人資主管＝STORE_HR_GRANTABLE），前端 modules/perms/lib.js 不再自己維護一份
  data.grantable = sess.hrOnly ? STORE_HR_GRANTABLE.slice() : PERM_GRANTABLE.slice();
  // 2026-10-26「指定門市只看考勤」（att.view@<單位>，只有 admin 能設）：admin 才多回可選的門市（active、store 階梯含 ck），名稱同 permAttViewLabel_
  if (!sess.hrOnly) data.att_view_units = permAcAttViewUnits_();
  data.acting_units = permAcActingUnits_();   // 2026-10-29 兼任店長：admin 與人資主管都有
  return { ok: true, data: data };
}

/** 可設「只看考勤」的單位：[{code, name}]（org 分頁順序；name 已含品牌，給下拉與清單顯示） */
function permAcAttViewUnits_() {
  var org = stfReadOrg_();
  var pidx = permOrgIndex_();
  return org.list.unit.filter(function (u) { return permAttViewUnitOk_(u.code, pidx); }).map(function (u) {
    return { code: u.code, name: permAttViewLabel_(u.code, org) };
  });
}

/** 可設「兼任店長」的門市：[{code, name}]（org 分頁順序；不含央廚） */
function permAcActingUnits_() {
  var org = stfReadOrg_();
  var pidx = permOrgIndex_();
  return org.list.unit.filter(function (u) { return permActingUnitOk_(u.code, pidx); }).map(function (u) {
    return { code: u.code, name: permAttViewLabel_(u.code, org) };
  });
}

/** perm_ex 一列是不是「emp 的 perm（兼任店長）且目前生效」（active、add、沒過期） */
function permAcSameActingLive_(r, emp, perm, today) {
  if (!permIsActive_(r[6]) || permStr_(r[1]).toUpperCase() !== emp || permStr_(r[2]) !== perm || permStr_(r[3]).toLowerCase() !== 'add') return false;
  if (permStr_(r[4]) === '') return true;
  var u = permNormDate_(r[4]);
  return !!u && u >= today;
}

function handlePermExSave_(token, payload) {
  payload = payload || {};
  var sess = permAcExAuth_(token, permStr_(payload.perm), permStr_(payload.emp_no));
  if (!sess.ok) return sess;
  var tables = permLoadTables_();
  if (!tables.inited) return permAcNotInited_();
  var emp = permStr_(payload.emp_no).toUpperCase();
  if (!STF_EMP_RE.test(emp)) return permAcBad_('同仁編號格式錯誤');
  var hit = stfFindByEmp_(emp);
  if (!hit) return permAcFail_('no_staff', '找不到這位同仁');
  var actU = permActingUnit_(payload.perm);
  if (actU && permStr_(hit.values[STF_COL.status]) !== 'active') return permAcFail_('bad_target', '兼任店長只能設給在職、已開通的同仁');
  if (actU && permStr_(hit.values[STF_COL.unit]) === actU) return permAcFail_('bad_target', '這位同仁本來就在這家店，不用設兼任店長');
  var today = permTodayTaipei_();
  var ex = { perm: permStr_(payload.perm), mode: permStr_(payload.mode), until: payload.until, note: typeof payload.note === 'string' ? payload.note : '' };
  var org = permOrgIndex_();   // 2026-10-26：att.view@<單位> 要驗單位
  var verr = permValidateEx_(ex, today, org);
  if (verr) return permAcFail_(verr.error, verr.message);
  var until = permNormDate_(payload.until);   // 驗證已通過：空＝不到期
  var ss = SpreadsheetApp.getActive();
  var exT = permReadTable_(ss, PERM_SHEET_EX, PERM_EX_HEADERS);
  // 兼任店長：同一人同一家店已有生效中的那筆 → 擋（避免撤銷一筆後另一筆還在；Codex 審查 3）
  if (actU && exT.rows.some(function (r) { return permAcSameActingLive_(r, emp, ex.perm, today); })) return permAcFail_('dup', '這位同仁已經是這家店的兼任店長（要改到期日請先撤銷原本那筆）');
  var exId = permAcNextId_(exT.rows, 'X')();
  var now = permNowText_();
  var by = permStr_(sess.user.id);
  var note = authSafeCell_(permStr_(payload.note));

  // 事前／事後權限（寫 perm_audit 用）
  var extra = stfSplitCodes_(stfReadExtraMap_()[emp]);
  var newEx = { ex_id: exId, emp_no: emp, perm: ex.perm, mode: ex.mode.toLowerCase(), until: until, note: permStr_(payload.note) };
  var pb = permAcPerms_(tables, org, today, hit.values, extra, tables.rules, tables.exs);
  var pa = permAcPerms_(tables, org, today, hit.values, extra, tables.rules, tables.exs.concat([newEx]));

  var sh = ss.getSheetByName(PERM_SHEET_EX);
  sh.getRange(sh.getLastRow() + 1, 1, 1, PERM_EX_HEADERS.length).setValues([[exId, emp, ex.perm, ex.mode, until, note, 'TRUE', now, by, '', '']]);
  stfLog_(emp, 'perm_ex_save', by, exId + ' ' + ex.mode + ' ' + ex.perm + (until ? ' until ' + until : ''));
  permActingReset_();
  if (actU) permAuditAppend_(by, emp, ex.perm, '', 'perm_ex');   // 兼任店長不在 perms 裡、下面的 diff 看不到，直接記（Codex 審查 6）
  var d = permDiff_(pb, pa);
  if (d) permAuditAppend_(by, emp, d.added.join(','), d.removed.join(','), 'perm_ex');
  return { ok: true, data: { ex_id: exId } };
}

function handlePermExRevoke_(token, payload) {
  var sess0 = permAcExAuth_(token, '', '');   // 先驗身分；碼與對象要讀到那筆例外才知道，下面再驗
  if (!sess0.ok) return sess0;
  var tables = permLoadTables_();
  if (!tables.inited) return permAcNotInited_();
  var id = permStr_(payload && payload.ex_id);
  if (!id) return permAcBad_();
  var ss = SpreadsheetApp.getActive();
  var exT = permReadTable_(ss, PERM_SHEET_EX, PERM_EX_HEADERS);
  var idx = -1;
  exT.rows.forEach(function (r, i) { if (permStr_(r[0]) === id) idx = i; });
  if (idx === -1) return permAcFail_('no_ex', '找不到這筆例外');
  var r = exT.rows[idx];
  var sess = sess0.hrOnly ? permAcExAuth_(token, permStr_(r[2]), permStr_(r[1])) : sess0;
  if (!sess.ok) return sess;
  if (!permIsActive_(r[6])) return permAcFail_('bad_state', '這筆例外已經撤銷了');
  var emp = permStr_(r[1]).toUpperCase();
  var today = permTodayTaipei_();
  var org = permOrgIndex_();
  var hit = stfFindByEmp_(emp);
  var d = null;
  if (hit) {
    var extra = stfSplitCodes_(stfReadExtraMap_()[emp]);
    var pb = permAcPerms_(tables, org, today, hit.values, extra, tables.rules, tables.exs);
    var pa = permAcPerms_(tables, org, today, hit.values, extra, tables.rules, tables.exs.filter(function (x) { return x.ex_id !== id; }));
    d = permDiff_(pb, pa);
  }
  var sh = ss.getSheetByName(PERM_SHEET_EX);
  var rowNo = idx + 2;
  var by = permStr_(sess.user.id);
  sh.getRange(rowNo, 7).setValue('FALSE');
  sh.getRange(rowNo, 10, 1, 2).setValues([[permNowText_(), by]]);
  stfLog_(emp, 'perm_ex_revoke', by, id + ' ' + permStr_(r[3]) + ' ' + permStr_(r[2]));
  if (permActingUnit_(r[2])) {
    // 兼任店長：同一人同一家店其他還生效的列一起停（舊資料可能重複；撤銷＝真的收回）
    exT.rows.forEach(function (o, j) {
      if (j === idx || !permIsActive_(o[6]) || permStr_(o[1]).toUpperCase() !== emp || permStr_(o[2]) !== permStr_(r[2])) return;
      sh.getRange(j + 2, 7).setValue('FALSE');
      sh.getRange(j + 2, 10, 1, 2).setValues([[permNowText_(), by]]);
      stfLog_(emp, 'perm_ex_revoke', by, permStr_(o[0]) + ' ' + permStr_(o[3]) + ' ' + permStr_(o[2]) + '（同碼一起撤銷）');
    });
    permAuditAppend_(by, emp, '', permStr_(r[2]), 'perm_ex');
  }
  permActingReset_();
  if (d) permAuditAppend_(by, emp, d.added.join(','), d.removed.join(','), 'perm_ex');
  return { ok: true, data: { ex_id: id } };
}

// ============================================================
// permStoreGet／permStoreSave
// ============================================================
function handlePermStoreGet_(token) {
  var sess = permAcMapAccess_(token);
  if (!sess.ok) return sess;
  var t = permLoadTables_();
  if (!t.inited) return { ok: true, data: { inited: false } };
  var org = stfReadOrg_();
  var items = Object.keys(t.storeMap).map(function (u) {
    return { unit: u, unit_name: org.unit[u] ? org.unit[u].name : '', audit_store: t.storeMap[u] };
  });
  var units = org.list.unit.filter(function (u) { return u.active; }).map(function (u) {
    return { code: u.code, name: u.name, brand: u.parent, ladder: u.ladder };
  });
  return { ok: true, data: { inited: true, items: items, units: units } };
}

function handlePermStoreSave_(token, payload) {
  var sess = permAcAdmin_(token);
  if (!sess.ok) return sess;
  payload = payload || {};
  var tables = permLoadTables_();
  if (!tables.inited) return permAcNotInited_();
  var unit = permStr_(payload.unit);
  var store = permStr_(payload.audit_store);
  var org = permOrgIndex_();
  var u = org.units[unit];
  if (!u || u.active === false) return permAcFail_('bad_target', '這個單位不存在或已停用');
  if (u.ladder !== 'store') return permAcFail_('bad_target', '只有門市單位能對照稽核店別');
  if (store !== '' && !PERM_AC_STORE_RE.test(store)) return permAcFail_('bad_store', '稽核店別代碼格式錯誤');
  if (store !== '') {
    var other = Object.keys(tables.storeMap).filter(function (k) { return k !== unit && tables.storeMap[k] === store; });
    if (other.length) return permAcFail_('dup_store', '這家稽核店已經對照給別的單位了');
  }
  var ss = SpreadsheetApp.getActive();
  var sT = permReadTable_(ss, PERM_SHEET_STORE, PERM_STORE_HEADERS);
  var sh = ss.getSheetByName(PERM_SHEET_STORE);
  var now = permNowText_();
  var by = permStr_(sess.user.id);
  var idx = -1;
  sT.rows.forEach(function (r, i) { if (permStr_(r[0]) === unit) idx = i; });
  var before = idx === -1 ? '' : permStr_(sT.rows[idx][1]);
  if (idx === -1) sh.getRange(sh.getLastRow() + 1, 1, 1, PERM_STORE_HEADERS.length).setValues([[unit, store, now, by]]);
  else sh.getRange(idx + 2, 2, 1, 3).setValues([[store, now, by]]);
  stfLog_('', 'perm_store_save', by, unit + ':' + before + '→' + store);
  return { ok: true, data: { unit: unit, audit_store: store } };
}

// ============================================================
// myPerms（任何已登入）
// ============================================================
function handleMyPerms_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return { ok: false, error: sess.error };
  if (!permEnabled_()) return { ok: true, data: { enabled: false } };
  var sources = sess.permSources;
  var scope = sess.auditScope;
  if (!sources) {
    // 系統帳號：全部來自角色
    sources = (sess.perms || []).map(function (p) { return { perm: p, source: 'role' }; });
    if (hasPerm_(sess.perms, 'audit.read') || hasPerm_(sess.perms, 'audit.write')) scope = 'all';
    else if (hasPerm_(sess.perms, 'audit.read.own')) scope = sess.user.node ? [String(sess.user.node)] : [];
    else scope = 'none';
  }
  var items = sources.map(function (s) {
    var o = { perm: s.perm, name_zh: permName_(s.perm), source: s.source };
    if (s.rule_id) o.rule_id = s.rule_id;
    if (s.ex_id) o.ex_id = s.ex_id;
    if (s.until) o.until = s.until;
    return o;
  });
  return { ok: true, data: { enabled: true, items: items, audit_scope: scope } };
}

// ============================================================
// permAuditList／permAuditSeen（admin）
// ============================================================
function handlePermAuditList_(token, payload) {
  var sess = permAcAdmin_(token);
  if (!sess.ok) return sess;
  var ss = SpreadsheetApp.getActive();
  var t = permReadTable_(ss, PERM_SHEET_AUDIT, PERM_AUDIT_HEADERS);
  if (t.missing || t.mismatch) return { ok: true, data: { inited: false } };
  payload = payload || {};
  var limit = Number(payload.limit) > 0 ? Math.min(Math.floor(Number(payload.limit)), PERM_AC_AUDIT_LIST_MAX) : 200;
  var unseenOnly = payload.unseen_only === true;
  var names = permAcStaffNameMap_();
  var unseen = 0;
  var items = [];
  t.rows.forEach(function (r, i) {
    var seen = permIsActive_(r[6]);
    if (!seen) unseen++;
    var emp = permStr_(r[2]).toUpperCase();
    var cause = permStr_(r[5]);
    var o = { row: i + 2, at: permStr_(r[0]), by: permStr_(r[1]), emp_no: emp, name: names[emp] || '', added: permStr_(r[3]), removed: permStr_(r[4]), cause: cause, seen: seen };
    if (cause === 'perm_map') {
      try { o.detail = JSON.parse(permStr_(r[3])); } catch (e) { o.detail = null; }
      if (o.detail && Array.isArray(o.detail.people)) {
        o.detail.people.forEach(function (p) { p.name = names[p.emp_no] || ''; });
      }
    }
    if (unseenOnly && seen) return;
    items.push(o);
  });
  items.reverse();
  return { ok: true, data: { inited: true, items: items.slice(0, limit), unseen: unseen } };
}

function handlePermAuditSeen_(token, payload) {
  var sess = permAcAdmin_(token);
  if (!sess.ok) return sess;
  var ss = SpreadsheetApp.getActive();
  var t = permReadTable_(ss, PERM_SHEET_AUDIT, PERM_AUDIT_HEADERS);
  if (t.missing || t.mismatch) return permAcNotInited_();
  payload = payload || {};
  var sh = ss.getSheetByName(PERM_SHEET_AUDIT);
  var targets = [];
  if (payload.all === true) {
    t.rows.forEach(function (r, i) { if (!permIsActive_(r[6])) targets.push(i + 2); });
  } else if (Array.isArray(payload.rows) && payload.rows.length && payload.rows.length <= PERM_AC_AUDIT_LIST_MAX) {
    for (var i = 0; i < payload.rows.length; i++) {
      var n = payload.rows[i];
      if (typeof n !== 'number' || n !== Math.floor(n) || n < 2 || n > t.rows.length + 1) return permAcBad_('列號不正確');
      if (targets.indexOf(n) === -1) targets.push(n);
    }
  } else {
    return permAcBad_();
  }
  targets.forEach(function (n) { sh.getRange(n, 7).setValue('TRUE'); });
  return { ok: true, data: { marked: targets.length } };
}
