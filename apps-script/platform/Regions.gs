/**
 * 鼎兆元管理系統｜平台後端 — 區域（督導負責區）
 * 正本規格：docs/regions/spec.md（v1.0）；背景 docs/org/spec.md §15、§15.1。
 *
 * 內容：
 *  1. 純函式 regionIndex_（區域索引；回傳形狀是對外契約，branch osv-att-view 依賴）、regionOfficeCovers_（審核限區）
 *  2. regionCtx_()：讀 Script Property REGIONS_ON＋regions 分頁，同一次請求內快取（dispatch_ 開頭 regionCtxReset_）
 *  3. 旗標（regionFlags_）、通訊錄「我的區域」（regionDirectory_，不受開關影響）
 *  4. actions：regionList／regionSave／regionCheck（platform.staff）、regionSwitch（只有 role admin）
 *
 * ver（樂觀鎖）：regions 分頁全部資料列（不含表頭）JSON 後取 SHA-256 前 12 bytes 的十六進位字串（regionVer_）。
 *   不用 Script Property 計數：有人直接改試算表也會讓 ver 變，不會蓋掉手改的內容。
 * ⚠ 本檔與 staff_log 不寫任何同仁姓名；假資料只出現在 test/。
 */

var REG_SHEET = 'regions';
var REG_HEADERS = ['code', 'name', 'brand', 'stores', 'supervisor', 'active', 'updated_at', 'updated_by'];
var REG_COL = {};
REG_HEADERS.forEach(function (h, i) { REG_COL[h] = i; });
var REG_PROP_ON = 'REGIONS_ON';
var REG_NAME_MAX = 12;
var REG_CODE_RE = /^r-[a-z0-9]+(-[a-z0-9]+)*$/;
// 限區的品牌辦公室職稱：區督導 osv；已停用的 oam 若還有人掛著，同 osv 處理（往拒絕方向）
var REG_LIMITED_TITLES = ['osv', 'oam'];
var REG_MSG = {
  NO_PERM: '沒有權限',
  ADMIN_ONLY: '只有系統管理者可以切換依區域審核',
  BAD_INPUT: '格式錯誤',
  CONFLICT: '區域設定剛被別人改過，請重新整理再改',
  NOT_FOUND: '找不到這個區域',
  NAME_REQUIRED: '請填區域名稱',
  NAME_TOO_LONG: '區域名稱最多 12 個字',
  NAME_DUP: '同一個品牌已經有同名的區域',
  BAD_BRAND: '品牌代碼不正確（只有設了品牌辦公室的品牌可以劃區）',
  BRAND_LOCKED: '區域建立後不能改品牌，請停用後另建',
  BAD_STORE: '門市不正確（必須是該品牌啟用中的門市，不含中央工廠）：',
  STORE_TAKEN: '這家門市已經在別的區域：',
  BAD_SUPERVISOR: '督導必須是在職、職稱區督導、且在該品牌的品牌辦公室'
};

// ============================================================
// 1. 純函式
// ============================================================

function regStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function regActive_(v) { return v === true || regStr_(v).toUpperCase() === 'TRUE'; }
function regSplit_(v) {
  var seen = {}, out = [];
  regStr_(v).split(',').forEach(function (x) { x = x.trim(); if (x && !seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}
function regRowVals_(r) { return r && r.values ? r.values : (r || []); }

/** 這個單位能不能劃進 brand 的區：active、ladder store、parent＝brand、不是 ck */
function regStoreOk_(org, unitCode, brand) {
  var u = org.unit[unitCode];
  return !!u && u.active && (u.ladder || 'store') === 'store' && u.parent === brand && unitCode !== 'ck';
}

/** 這位同仁（staff 列 values）能不能當 brand 的督導：active、職稱 osv（啟用）、單位＝該品牌的品牌辦公室（啟用） */
function regSupervisorOk_(org, values, brand) {
  if (!values) return false;
  if (regStr_(values[STF_COL.status]) !== 'active') return false;
  if (regStr_(values[STF_COL.title]) !== 'osv') return false;
  var t = org.title.osv;
  if (!t || !t.active) return false;
  var u = org.unit[regStr_(values[STF_COL.unit])];
  return !!u && u.active && u.ladder === 'office' && u.parent === brand;
}

/** staffRows（stfAllRows_ 的 {row, values} 或 values 陣列）→ {emp: values} */
function regStaffMap_(staffRows) {
  var map = {};
  (staffRows || []).forEach(function (r) {
    var v = regRowVals_(r);
    var emp = stfNormEmp_(v[STF_COL.emp_no]);
    if (emp && !map[emp]) map[emp] = v;
  });
  return map;
}

/**
 * 解析 regions 分頁的資料列 → [{code,name,brand,stores:[raw],supervisor,active,updated_at,updated_by,row}]（同 code 只取第一列；空 code 略過）
 */
function regParseRows_(rows) {
  var seen = {}, out = [];
  (rows || []).forEach(function (r, i) {
    var code = regStr_(r[REG_COL.code]);
    if (!code || seen[code]) return;
    seen[code] = true;
    out.push({
      code: code, name: regStr_(r[REG_COL.name]), brand: regStr_(r[REG_COL.brand]),
      stores: regSplit_(r[REG_COL.stores]), supervisor: stfNormEmp_(r[REG_COL.supervisor]),
      active: regActive_(r[REG_COL.active]),
      updated_at: regStr_(r[REG_COL.updated_at]), updated_by: regStr_(r[REG_COL.updated_by]), row: i + 2
    });
  });
  return out;
}

/**
 * 區域索引（規格第 3 節；**回傳形狀是對外契約**，osv-att-view 用 bySupervisor[emp] → byRegion[code].stores）：
 * { byStore:{unit→code}, byRegion:{code→{code,name,brand,stores:[],supervisorEmp}}, bySupervisor:{emp→[code…]} }
 * 只收 active 區域；stores 只留合格門市（regStoreOk_）；同一家店出現在兩個以上 active 區域 → 兩邊都不算（往拒絕方向，視同沒劃區）；
 * supervisor 不合格（離職、職稱不是 osv、別品牌辦公室…）→ ''。
 */
function regionIndex_(rows, org, staffRows) {
  var staff = regStaffMap_(staffRows);
  var regs = regParseRows_(rows).filter(function (g) { return g.active; });
  var count = {};
  regs.forEach(function (g) {
    g.stores.forEach(function (s) { if (regStoreOk_(org, s, g.brand)) count[s] = (count[s] || 0) + 1; });
  });
  var idx = { byStore: {}, byRegion: {}, bySupervisor: {} };
  regs.forEach(function (g) {
    var stores = g.stores.filter(function (s) { return regStoreOk_(org, s, g.brand) && count[s] === 1; });
    var sup = g.supervisor && regSupervisorOk_(org, staff[g.supervisor], g.brand) ? g.supervisor : '';
    idx.byRegion[g.code] = { code: g.code, name: g.name, brand: g.brand, stores: stores, supervisorEmp: sup };
    stores.forEach(function (s) { idx.byStore[s] = g.code; });
    if (sup) (idx.bySupervisor[sup] = idx.bySupervisor[sup] || []).push(g.code);
  });
  return idx;
}

/**
 * 品牌辦公室這位審核者能不能管這家店（規格第 5 節）。approver＝{emp, title}；rctx＝{on, idx}。
 * 開關關（或沒給 rctx）→ true；職稱 osv／oam → 只有該店所屬區的督導＝本人才 true；其他職稱（odir 等）→ true。
 */
function regionOfficeCovers_(approver, storeUnit, rctx) {
  if (!rctx || !rctx.on) return true;
  var title = regStr_(approver && approver.title);
  if (REG_LIMITED_TITLES.indexOf(title) === -1) return true;
  var emp = stfNormEmp_(approver && approver.emp);
  if (!emp) return false;
  var idx = rctx.idx || {};
  var code = (idx.byStore || {})[regStr_(storeUnit)];
  var reg = code ? (idx.byRegion || {})[code] : null;
  return !!reg && reg.supervisorEmp === emp;
}

/**
 * 這家店目前有沒有「有效督導」（規格第 0 節 Q4、第 5 節）：有劃進 active 區域、且該區 supervisorEmp 不是空（失效督導已在 regionIndex_ 清成 ''）。
 * 沒劃區、區沒督導、沒給索引 → false。純函式；給 StoreOps.gs attApproverOf_ 決定要不要放行同品牌總監核店長申請。
 */
function regionStoreHasSupervisor_(idx, unit) {
  if (!idx || !idx.byStore) return false;
  var code = idx.byStore[regStr_(unit)];
  var reg = code && idx.byRegion ? idx.byRegion[code] : null;
  return !!reg && regStr_(reg.supervisorEmp) !== '';
}

/** 這個品牌能不能劃區：品牌存在、且有啟用中的品牌辦公室（ladder office、parent＝該品牌）；ck、dzy 等沒有品牌辦公室 → false */
function regBrandOk_(org, brand) {
  if (!brand || !org.brand[brand]) return false;
  return org.list.unit.some(function (u) { return u.active && u.ladder === 'office' && u.parent === brand; });
}

/** 某督導負責的門市（排序去重；沒有＝[]） */
function regionStoresOf_(idx, emp) {
  var out = [];
  ((idx && idx.bySupervisor) ? idx.bySupervisor[stfNormEmp_(emp)] || [] : []).forEach(function (c) {
    (idx.byRegion[c] ? idx.byRegion[c].stores : []).forEach(function (s) { if (out.indexOf(s) === -1) out.push(s); });
  });
  return out.sort();
}

/** 可以劃區的門市（全部品牌或指定品牌；依 org order） */
function regAssignableStores_(org, brand) {
  return org.list.unit.filter(function (u) {
    return (!brand || u.parent === brand) && org.brand[u.parent] && regStoreOk_(org, u.code, u.parent);
  });
}

/**
 * 旗標（規格第 3 節「事後失效」）：
 *   region_no_supervisor：[{code,name,brand,reason:'empty'|'invalid'}]（active 區域）
 *   region_store_inactive：[{code,name,brand,stores:[unit]}]（active 區域裡被濾掉的店：停用或不合格）
 *   region_store_dup：[{code,name,brand,stores:[unit]}]（合格門市同時出現在兩個以上 active 區域，只有手改試算表才會；兩邊都不算）
 *   store_no_region：[{unit,unit_name,brand}]（active 門市沒劃進任何 active 區域）
 */
function regionFlags_(rows, org, idx) {
  var flags = { region_no_supervisor: [], region_store_inactive: [], region_store_dup: [], store_no_region: [] };
  regParseRows_(rows).forEach(function (g) {
    if (!g.active) return;
    var r = idx.byRegion[g.code];
    if (!r) return;
    if (!r.supervisorEmp) flags.region_no_supervisor.push({ code: g.code, name: g.name, brand: g.brand, reason: g.supervisor ? 'invalid' : 'empty' });
    var dropped = g.stores.filter(function (s) { return r.stores.indexOf(s) === -1; });
    // 合格卻被濾掉＝同店兩區（regionIndex_ 只會因為這個原因濾掉合格門市）
    var dup = dropped.filter(function (s) { return regStoreOk_(org, s, g.brand); });
    var inactive = dropped.filter(function (s) { return dup.indexOf(s) === -1; });
    if (inactive.length) flags.region_store_inactive.push({ code: g.code, name: g.name, brand: g.brand, stores: inactive });
    if (dup.length) flags.region_store_dup.push({ code: g.code, name: g.name, brand: g.brand, stores: dup });
  });
  regAssignableStores_(org).forEach(function (u) {
    if (!idx.byStore[u.code]) flags.store_no_region.push({ unit: u.code, unit_name: u.name, brand: u.parent });
  });
  return flags;
}

/** regions 分頁內容的版本字串（樂觀鎖用） */
function regionVer_(rows) {
  var norm = (rows || []).map(function (r) { return REG_HEADERS.map(function (h, i) { return regStr_(r[i]); }); });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'dzy-regions:' + JSON.stringify(norm));
  var hex = '';
  for (var i = 0; i < 12; i++) hex += ((digest[i] + 256) % 256 + 256).toString(16).slice(1);
  return hex;
}

/**
 * 通訊錄「我的區域」（規格第 4 節；不受 REGIONS_ON 影響；不改 stfManagerScope_）。
 * values＝本人 staff 列；osv → 他負責的區；odir → 全品牌 active 門市（不含 ck）依區分組，沒劃區的店放 {code:'',name:'未劃區'}；
 * 其他人 → []。people 只給 emp_no、姓名、職稱、手機（不給生日、地址）。
 */
function regionDirectory_(values, org, staffRows, idx) {
  if (!values || regStr_(values[STF_COL.status]) !== 'active') return [];
  var title = regStr_(values[STF_COL.title]);
  var unit = org.unit[regStr_(values[STF_COL.unit])];
  if (!unit || !unit.active || unit.ladder !== 'office') return [];
  var brand = unit.parent;
  var emp = stfNormEmp_(values[STF_COL.emp_no]);
  var people = function (storeCode) {
    return (staffRows || []).map(regRowVals_).filter(function (v) {
      return regStr_(v[STF_COL.status]) === 'active' && regStr_(v[STF_COL.unit]) === storeCode;
    }).map(function (v) {
      var t = regStr_(v[STF_COL.title]);
      return { emp_no: regStr_(v[STF_COL.emp_no]), name: regStr_(v[STF_COL.name]), title: t,
        title_name: org.title[t] ? org.title[t].name : '', phone: stfPhone_(v[STF_COL.phone]) };
    });
  };
  var storeObj = function (s) { return { unit: s, unit_name: org.unit[s] ? org.unit[s].name : '', people: people(s) }; };
  var order = function (s) { return org.unit[s] ? org.unit[s].order : 0; };
  var byOrder = function (a, b) { return order(a) - order(b); };
  var codes;
  if (title === 'osv') {
    codes = (idx.bySupervisor[emp] || []).filter(function (c) { return idx.byRegion[c] && idx.byRegion[c].brand === brand; });
  } else if (title === 'odir') {
    codes = Object.keys(idx.byRegion).filter(function (c) { return idx.byRegion[c].brand === brand; });
  } else {
    return [];
  }
  codes.sort();
  var out = codes.map(function (c) {
    var r = idx.byRegion[c];
    return { code: r.code, name: r.name, stores: r.stores.slice().sort(byOrder).map(storeObj) };
  });
  if (title === 'odir') {
    var rest = regAssignableStores_(org, brand).filter(function (u) { return !idx.byStore[u.code]; }).map(function (u) { return u.code; });
    if (rest.length) out.push({ code: '', name: '未劃區', stores: rest.map(storeObj) });
  }
  return out;
}

// ============================================================
// 2. 讀資料與請求內快取
// ============================================================

var REG_CTX_CACHE_ = null;
/** 每次請求開頭（Code.gs dispatch_）與寫入後呼叫；測試沙盒也可直接呼叫 */
function regionCtxReset_() { REG_CTX_CACHE_ = null; }

function regReadRows_() {
  return typeof stfReadRows_ === 'function' ? stfReadRows_(REG_SHEET, REG_HEADERS.length) : [];
}

function regionOn_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(REG_PROP_ON);
    return v !== null && v !== undefined && String(v) === '1';
  } catch (e) {
    return false;
  }
}

/** {on, idx}：on＝REGIONS_ON 恰好 '1'；idx 不論開關都建（通訊錄用）。分頁不存在＝空索引 */
function regionCtx_() {
  if (REG_CTX_CACHE_) return REG_CTX_CACHE_;
  var rows = regReadRows_();
  var idx = rows.length ? regionIndex_(rows, stfReadOrg_(), stfAllRows_()) : { byStore: {}, byRegion: {}, bySupervisor: {} };
  REG_CTX_CACHE_ = { on: regionOn_(), idx: idx };
  return REG_CTX_CACHE_;
}

// ============================================================
// 3. actions
// ============================================================

/**
 * 給其他功能用的區域索引（無參數，同一請求內快取；與 REGIONS_ON 開關無關）。
 * 回傳形狀＝regionIndex_（byStore／byRegion／bySupervisor），是 osv-att-view（督導看負責門市考勤）依賴的契約，改名或改形狀要先通知。
 */
function regionIndexLive_() { return regionCtx_().idx; }

function regFail_(error, code) { var o = { ok: false, error: error }; if (code) o.code = code; return o; }

function regRegionView_(g) {
  return { code: g.code, name: g.name, brand: g.brand, stores: g.stores.slice(), supervisor: g.supervisor,
    active: g.active, updated_at: g.updated_at, updated_by: g.updated_by };
}

/** 督導候選人：在職、職稱 osv、單位是啟用中的品牌辦公室（只回 emp_no、姓名、單位、品牌） */
function regCandidates_(org, staffRows) {
  return (staffRows || []).map(regRowVals_).filter(function (v) {
    var u = org.unit[regStr_(v[STF_COL.unit])];
    return !!u && regSupervisorOk_(org, v, u.parent);
  }).map(function (v) {
    var u = org.unit[regStr_(v[STF_COL.unit])];
    return { emp_no: stfNormEmp_(v[STF_COL.emp_no]), name: regStr_(v[STF_COL.name]), unit: u.code, unit_name: u.name, brand: u.parent };
  });
}

function handleRegionList_(token) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  var org = stfReadOrg_();
  var staffRows = stfAllRows_();
  var rows = regReadRows_();
  var idx = regionIndex_(rows, org, staffRows);
  return { ok: true, data: {
    regions: regParseRows_(rows).map(regRegionView_),
    idx: idx,
    flags: regionFlags_(rows, org, idx),
    ver: regionVer_(rows),
    on: regionOn_(),
    candidates: regCandidates_(org, staffRows)
  } };
}

/** 一位督導看得到的門市集合（emp → [unit]），給 preview 比較 */
function regSupStores_(idx) {
  var out = {};
  Object.keys(idx.bySupervisor).forEach(function (emp) { out[emp] = regionStoresOf_(idx, emp); });
  return out;
}

/** 前後索引的差異：[{emp_no, name, gained:[{unit,unit_name}], lost:[…]}]（依 emp_no 排序） */
function regPreviewDiff_(before, after, org, staffMap) {
  var a = regSupStores_(before), b = regSupStores_(after);
  var emps = Object.keys(a).concat(Object.keys(b)).filter(function (x, i, arr) { return arr.indexOf(x) === i; }).sort();
  var nm = function (s) { return { unit: s, unit_name: org.unit[s] ? org.unit[s].name : '' }; };
  var out = [];
  emps.forEach(function (emp) {
    var was = a[emp] || [], now = b[emp] || [];
    var gained = now.filter(function (s) { return was.indexOf(s) === -1; });
    var lost = was.filter(function (s) { return now.indexOf(s) === -1; });
    if (!gained.length && !lost.length) return;
    var v = staffMap[emp];
    out.push({ emp_no: emp, name: v ? regStr_(v[STF_COL.name]) : '', gained: gained.map(nm), lost: lost.map(nm) });
  });
  return out;
}

/** 新代碼 r-<brand>-<n>：n＝該品牌既有最大號＋1 */
function regNextCode_(regs, brand) {
  var max = 0;
  var re = new RegExp('^r-' + brand.replace(/[^a-z0-9]/g, '') + '-(\\d+)$');
  regs.forEach(function (g) { var m = re.exec(g.code); if (m && Number(m[1]) > max) max = Number(m[1]); });
  return 'r-' + brand + '-' + (max + 1);
}

/**
 * 新增／修改／停用一區。payload＝{region:{code?,name,brand,stores[],supervisor,active}, expected_ver, preview?}
 * 檢查（規格第 3 節）：名稱 1–12 字、同品牌 active 區不重名；品牌要有啟用中的品牌辦公室（建立後不能改）；門市合格（停用的區只檢查代碼存在且屬該品牌）；
 * active 區域一店一區；督導空或合格；expected_ver 要等於目前 ver。preview=true 只回差異不寫。
 */
function handleRegionSave_(token, payload) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  payload = payload || {};
  var src = payload.region;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return regFail_(REG_MSG.BAD_INPUT, 'bad_input');
  if (typeof payload.expected_ver !== 'string') return regFail_(REG_MSG.BAD_INPUT, 'bad_input');
  if (src.stores !== undefined && !Array.isArray(src.stores)) return regFail_(REG_MSG.BAD_INPUT, 'bad_input');
  var org = stfReadOrg_();
  var staffRows = stfAllRows_();
  var staffMap = regStaffMap_(staffRows);
  var rows = regReadRows_();
  var regs = regParseRows_(rows);

  var code = regStr_(src.code);
  var cur = null;
  if (code) {
    if (!REG_CODE_RE.test(code)) return regFail_(REG_MSG.BAD_INPUT, 'bad_input');
    cur = regs.filter(function (g) { return g.code === code; })[0] || null;
    if (!cur) return regFail_(REG_MSG.NOT_FOUND, 'not_found');
  }
  var name = regStr_(src.name);
  if (!name) return regFail_(REG_MSG.NAME_REQUIRED, 'bad_input');
  if (Array.from(name).length > REG_NAME_MAX) return regFail_(REG_MSG.NAME_TOO_LONG, 'bad_input');
  if (/^[=+\-@]/.test(name)) return regFail_(REG_MSG.BAD_INPUT, 'bad_input');   // 防試算表公式
  var brand = regStr_(src.brand);
  if (!brand || !/^[a-z0-9]+$/.test(brand) || !regBrandOk_(org, brand)) return regFail_(REG_MSG.BAD_BRAND, 'bad_input');
  if (cur && cur.brand !== brand) return regFail_(REG_MSG.BRAND_LOCKED, 'bad_input');
  var active = !(src.active === false || regStr_(src.active).toUpperCase() === 'FALSE');
  var stores = [];
  var badStores = [];
  (src.stores || []).forEach(function (s) {
    s = regStr_(s);
    if (!s || stores.indexOf(s) !== -1) return;
    var u = org.unit[s];
    var okStore = active ? regStoreOk_(org, s, brand) : (!!u && (u.ladder || 'store') === 'store' && u.parent === brand && s !== 'ck');
    if (!okStore) badStores.push(s);
    stores.push(s);
  });
  if (badStores.length) return regFail_(REG_MSG.BAD_STORE + badStores.join(','), 'bad_store');
  // 重名只比 active 的區（停用的區名稱可以重用）；存成停用的區也不擋
  if (active && regs.some(function (g) { return g.code !== code && g.active && g.brand === brand && g.name === name; })) return regFail_(REG_MSG.NAME_DUP, 'name_dup');
  if (active) {
    var taken = [];
    regs.forEach(function (g) {
      if (g.code === code || !g.active) return;
      g.stores.forEach(function (s) { if (stores.indexOf(s) !== -1 && taken.indexOf(s) === -1) taken.push(s); });
    });
    if (taken.length) return regFail_(REG_MSG.STORE_TAKEN + taken.join(','), 'store_taken');
  }
  var sup = stfNormEmp_(src.supervisor);
  if (sup && !regSupervisorOk_(org, staffMap[sup], brand)) return regFail_(REG_MSG.BAD_SUPERVISOR, 'bad_supervisor');
  if (payload.expected_ver !== regionVer_(rows)) return regFail_(REG_MSG.CONFLICT, 'conflict');

  var newCode = code || regNextCode_(regs, brand);
  var now = stfNowText_();
  var by = String(auth.user.id);
  var newRow = [newCode, name, brand, stores.join(','), sup, active ? 'TRUE' : 'FALSE', now, by];
  var afterRows = rows.map(function (r) { return r.slice(); });
  if (cur) afterRows[cur.row - 2] = newRow; else afterRows.push(newRow);
  var before = regionIndex_(rows, org, staffRows);
  var after = regionIndex_(afterRows, org, staffRows);
  var diff = regPreviewDiff_(before, after, org, staffMap);
  var view = regRegionView_(regParseRows_([newRow])[0]);
  if (payload.preview === true) return { ok: true, data: { preview: true, region: view, diff: diff } };

  // 寫入（呼叫端 Code.gs 已在 MUTATING_ACTIONS 用全域鎖包住，同其他 Staff.gs 寫入）
  stfEnsureSheet_(SpreadsheetApp.getActive(), REG_SHEET, REG_HEADERS, []);
  if (cur) stfWriteRow_(REG_SHEET, cur.row, newRow, REG_HEADERS.length);
  else stfAppendRow_(REG_SHEET, newRow, REG_HEADERS.length);
  stfLog_('', 'region_save', by, regLogDetail_(cur, view));
  regionCtxReset_();
  return { ok: true, data: { region: view, diff: diff, ver: regionVer_(regReadRows_()) } };
}

/** staff_log detail：只寫區域代碼與欄位差異（門市、督導是代碼；名稱只寫「改了」不寫內容）；不寫任何姓名 */
function regLogDetail_(cur, view) {
  var parts = [view.code + (cur ? '' : ' new brand:' + view.brand)];
  var was = cur || { name: '', stores: [], supervisor: '', active: false };
  if (!cur || was.name !== view.name) parts.push('name');
  var plus = view.stores.filter(function (s) { return was.stores.indexOf(s) === -1; }).map(function (s) { return '+' + s; });
  var minus = was.stores.filter(function (s) { return view.stores.indexOf(s) === -1; }).map(function (s) { return '-' + s; });
  if (plus.length || minus.length) parts.push('stores:' + plus.concat(minus).join(';'));
  if (was.supervisor !== view.supervisor) parts.push('supervisor:' + (was.supervisor || '-') + '>' + (view.supervisor || '-'));
  if (!cur || was.active !== view.active) parts.push('active:' + (cur ? (was.active ? 'TRUE' : 'FALSE') + '>' : '') + (view.active ? 'TRUE' : 'FALSE'));
  return parts.join(' ');
}

/**
 * 切換檢查（規格第 7 節，讀）：
 *   stores_no_region：[{brand, brand_name, stores:[{unit,unit_name}]}]
 *   regions_no_supervisor：[{code,name,brand,reason}]
 *   no_director：[{brand, brand_name, stores:[{unit,unit_name}]}]（品牌沒有在職總監、且有第 1、2 項的店）
 *   pending_moves：[{unit, unit_name, count, supervisors:[emp_no]}]——還沒審的認領，打開後會從哪些督導清單移走（只列人數與店名）
 *   ※ 考勤申請（加班／請假／忘刷）的待審在門市營運系統，本平台查不到，att_pending_note 提醒到營運系統看。
 */
function handleRegionCheck_(token) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  var org = stfReadOrg_();
  var staffRows = stfAllRows_();
  var rows = regReadRows_();
  var idx = regionIndex_(rows, org, staffRows);
  var flags = regionFlags_(rows, org, idx);
  var nm = function (s) { return { unit: s, unit_name: org.unit[s] ? org.unit[s].name : '' }; };
  var group = function (units) {
    var by = {};
    units.forEach(function (s) { var b = org.unit[s] ? org.unit[s].parent : ''; (by[b] = by[b] || []).push(nm(s)); });
    return org.list.brand.filter(function (b) { return by[b.code]; }).map(function (b) { return { brand: b.code, brand_name: b.name, stores: by[b.code] }; });
  };
  var noRegion = flags.store_no_region.map(function (x) { return x.unit; });
  var noSupStores = [];
  flags.region_no_supervisor.forEach(function (r) { (idx.byRegion[r.code].stores || []).forEach(function (s) { noSupStores.push(s); }); });
  var hasDir = {};
  staffRows.forEach(function (r) {
    var v = r.values;
    var u = org.unit[regStr_(v[STF_COL.unit])];
    if (regStr_(v[STF_COL.status]) === 'active' && regStr_(v[STF_COL.title]) === 'odir' && u && u.active && u.ladder === 'office') hasDir[u.parent] = true;
  });
  var risky = noRegion.concat(noSupStores).filter(function (s, i, a) { return a.indexOf(s) === i && org.unit[s] && !hasDir[org.unit[s].parent]; });

  // 第 4 項：每位在職督導，認領待審（開關關 vs 開）會少掉哪些
  var off = { on: false, idx: idx }, on = { on: true, idx: idx };
  var moves = {};
  var reviewers = staffRows.filter(function (r) {
    return regStr_(r.values[STF_COL.status]) === 'active' && REG_LIMITED_TITLES.indexOf(regStr_(r.values[STF_COL.title])) !== -1;
  });
  staffRows.forEach(function (t) {
    if (regStr_(t.values[STF_COL.status]) !== 'pending') return;
    var unit = regStr_(t.values[STF_COL.p_unit]);
    reviewers.forEach(function (rv) {
      if (regStr_(rv.values[STF_COL.user_id]) !== '' && regStr_(rv.values[STF_COL.user_id]) === regStr_(t.values[STF_COL.user_id])) return;
      var scope = stfReviewScope_(rv.values, org);
      if (!scope) return;
      if (stfCanReview_(scope, t.values, org, off) && !stfCanReview_(scope, t.values, org, on)) {
        var m = moves[unit] = moves[unit] || { unit: unit, unit_name: org.unit[unit] ? org.unit[unit].name : '', count: 0, supervisors: [], _seen: {} };
        var key = stfNormEmp_(t.values[STF_COL.emp_no]);
        if (!m._seen[key]) { m._seen[key] = true; m.count++; }
        var se = stfNormEmp_(rv.values[STF_COL.emp_no]);
        if (m.supervisors.indexOf(se) === -1) m.supervisors.push(se);
      }
    });
  });
  var pending = Object.keys(moves).sort().map(function (k) { var m = moves[k]; delete m._seen; m.supervisors.sort(); return m; });
  return { ok: true, data: {
    on: regionOn_(),
    stores_no_region: group(noRegion),
    regions_no_supervisor: flags.region_no_supervisor,
    no_director: group(risky),
    pending_moves: pending,
    att_pending_note: '考勤申請的待審在門市營運系統，請到營運系統確認',
    warn: noRegion.length > 0 || flags.region_no_supervisor.length > 0
  } };
}

/** 開關（只有 role admin）：{on:true} 設 REGIONS_ON='1'；{on:false} 刪掉屬性。都寫 staff_log */
function handleRegionSwitch_(token, payload) {
  var me = handleMe_(token);
  if (!me.ok) return me;
  if (!stfActorIsAdmin_(me.data.user)) return regFail_(REG_MSG.ADMIN_ONLY, 'forbidden');
  payload = payload || {};
  if (payload.on !== true && payload.on !== false) return regFail_(REG_MSG.BAD_INPUT, 'bad_input');
  var props = PropertiesService.getScriptProperties();
  if (payload.on) props.setProperty(REG_PROP_ON, '1');
  else props.deleteProperty(REG_PROP_ON);
  stfLog_('', payload.on ? 'regions_on' : 'regions_off', String(me.data.user.id), '');
  regionCtxReset_();
  return { ok: true, data: { on: regionOn_() } };
}
