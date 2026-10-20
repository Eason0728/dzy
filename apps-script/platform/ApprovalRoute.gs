/**
 * 鼎兆元管理系統｜第三期表單簽核 — 路線與金額（純函式）
 * 正本規格：docs/approvals/spec.md（§14 設計審修正優先）＋ api.md ＋ plan.md「共用契約」。
 *
 * 本檔不讀、不寫任何試算表：所有輸入由 Approvals.gs 準備好再傳進來，方便單元測試。
 * 依賴 Staff.gs 的組織判斷（stfReviewNeed_／stfReviewScope_／stfScopeMeets_／STF_COL），只往上一層的既有規則重用，不改它們的行為。
 * ⚠ 本檔與 repo 任何地方都不得出現真實同仁資料（dzy 是 public repo）。
 */

var APV_ROLES = ['head', 'brand_dir', 'ceo', 'gm', 'chair'];   // 權限人代碼，由低到高（往上順序）
var APV_TYPES = ['purchase', 'expense', 'personnel'];
var APV_HANDLER_DEPT = { purchase: 'purchase', expense: 'fin', personnel: 'hr' };   // 承辦部門代碼（org 正本，spec §14.8）
// 單位自己的 brand_dir（沒有品牌辦公室的單位）：中央工廠＝研發總監 rdd（docs/org/spec.md 第 15 節）
var APV_UNIT_DIR_TITLE = { ck: 'rdd' };
var APV_ROLE_LABEL = { head: '單位主管', brand_dir: '營運主管（品牌總監／研發總監）', ceo: '執行長', gm: '總經理', chair: '董事長', direct: '直屬主管', self_sign: '本人簽名' };
var APV_AMOUNT_MAX = 10000000;
var APV_TABLE_MAX_ROWS = 20;
var APV_STUCK_MS = 72 * 60 * 60 * 1000;

// ============================================================
// 1. 金額（spec §14.6 唯一式子；modules/approvals-shared/amount.js 有逐字相同的一份，測試比對）
// ============================================================

/**
 * 算金額。purchase：每列 subtotal＝Math.round(qty×price)，amount＝Σsubtotal；expense：amount 本身；personnel：沒有金額。
 * 回 {ok:true, amount, subtotals} 或 {ok:false, error:'bad_amount'|'bad_request'}。
 */
function apvCalcAmount_(type, body) {
  var bad = { ok: false, error: 'bad_amount' };
  if (type === 'purchase') {
    var items = body && body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) return { ok: false, error: 'bad_request' };
    var total = 0;
    var subtotals = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') return { ok: false, error: 'bad_request' };
      var q = it.qty;
      var p = it.price;
      if (typeof q !== 'number' || typeof p !== 'number' || !isFinite(q) || !isFinite(p)) return bad;
      if (!(q > 0) || q > 9999 || Math.abs(q * 100 - Math.round(q * 100)) > 1e-7) return bad;
      if (!(p > 0) || p > 1000000 || Math.floor(p) !== p) return bad;
      var s = Math.round(q * p);
      subtotals.push(s);
      total += s;
    }
    if (!(total > 0) || total > 10000000) return bad;
    return { ok: true, amount: total, subtotals: subtotals };
  }
  if (type === 'expense') {
    var a = body && body.amount;
    if (typeof a !== 'number' || !isFinite(a) || Math.floor(a) !== a || a < 1 || a > 10000000) return bad;
    return { ok: true, amount: a, subtotals: [] };
  }
  return { ok: true, amount: null, subtotals: [] };
}

// ============================================================
// 2. 核決權限表（T1-1）
// ============================================================

function apvOpenMax_(m) { return m === null || m === undefined || m === ''; }

/** 金額落在哪一列：第一個 max 為空（以上全部）或 amount ≤ max 的列；表需先過 apvValidateTable_ */
function apvPickRow_(rows, amount) {
  if (!Array.isArray(rows) || typeof amount !== 'number' || !isFinite(amount)) return null;
  for (var i = 0; i < rows.length; i++) {
    if (apvOpenMax_(rows[i].max) || amount <= Number(rows[i].max)) return rows[i];
  }
  return null;
}

/** 整張表檢查：至少一列、金額嚴格遞增且為正整數、只有最後一列 max 空、權限人代碼合法 */
function apvValidateTable_(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return { ok: false, error: '至少要有一列' };
  if (rows.length > APV_TABLE_MAX_ROWS) return { ok: false, error: '最多 ' + APV_TABLE_MAX_ROWS + ' 列' };
  var prev = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var n = i + 1;
    if (!r || typeof r !== 'object') return { ok: false, error: '第 ' + n + ' 列格式錯誤' };
    if (APV_ROLES.indexOf(r.store_role) === -1) return { ok: false, error: '第 ' + n + ' 列門市權限人代碼不合法' };
    if (APV_ROLES.indexOf(r.hq_role) === -1) return { ok: false, error: '第 ' + n + ' 列總部權限人代碼不合法' };
    var last = i === rows.length - 1;
    if (last) {
      if (!apvOpenMax_(r.max)) return { ok: false, error: '最後一列必須是「以上全部」（金額留空）' };
    } else {
      if (apvOpenMax_(r.max)) return { ok: false, error: '只有最後一列可以留空金額' };
      var m = r.max;
      if (typeof m !== 'number' || !isFinite(m) || Math.floor(m) !== m || m < 1 || m > 1000000000) return { ok: false, error: '第 ' + n + ' 列金額要是正整數' };
      if (m <= prev) return { ok: false, error: '第 ' + n + ' 列金額必須比上一列大' };
      prev = m;
    }
  }
  return { ok: true };
}

// ============================================================
// 3. 人員目錄（Approvals.gs 讀表後交進來；這裡只做形狀轉換與查詢）
// ============================================================

/** staff 列 → 目錄人員。opened＝status active、有 users 帳號且帳號沒停用（「已開通」） */
function apvPerson_(values, org, extraCodes, userActive) {
  var unit = String(values[STF_COL.unit] === undefined || values[STF_COL.unit] === null ? '' : values[STF_COL.unit]).trim();
  var title = String(values[STF_COL.title] === undefined || values[STF_COL.title] === null ? '' : values[STF_COL.title]).trim();
  var dept = String(values[STF_COL.dept] === undefined || values[STF_COL.dept] === null ? '' : values[STF_COL.dept]).trim();
  var u = org.unit[unit];
  var t = org.title[title];
  var status = String(values[STF_COL.status] || '').trim();
  var uid = String(values[STF_COL.user_id] === undefined || values[STF_COL.user_id] === null ? '' : values[STF_COL.user_id]).trim();
  return {
    emp: String(values[STF_COL.emp_no] || '').trim().toUpperCase(),
    name: String(values[STF_COL.name] || '').trim(),
    uid: uid,
    status: status,
    unit: unit,
    dept: dept,
    title: title,
    brand: u ? u.parent : '',
    ladder: u ? (u.ladder || 'store') : '',
    rank: t ? t.rank : 0,
    extra: extraCodes || [],
    opened: status === 'active' && uid !== '' && userActive !== false,
    values: values
  };
}

function apvFindPerson_(ctx, emp) {
  if (!emp) return null;
  var e = String(emp).toUpperCase();
  if (ctx.byEmp) return ctx.byEmp[e] || null;
  for (var i = 0; i < ctx.people.length; i++) if (ctx.people[i].emp === e) return ctx.people[i];
  return null;
}

function apvExcluded_(ctx, emp) { return !!ctx.exclude && ctx.exclude.indexOf(emp) !== -1; }

/** 承辦部門的人：主要部門或兼任部門是該部門、已開通 */
function apvIsHandler_(person, dept) {
  return !!person && person.opened && !!dept && (person.dept === dept || person.extra.indexOf(dept) !== -1);
}

// ============================================================
// 4. 找「誰能簽」（T1-2）
// ============================================================

/**
 * 某一種權限人的成員。of＝組織脈絡人（請購請款＝送件人；人事＝對象同仁）。
 * head：門市＝同單位店長 sm（中央工廠＝廠長 fm；STF_STORE_HEAD_TITLES，區經理 am 不算）；總部＝同單位同主要部門 hm；品牌辦公室＝同辦公室區經理／區督導（rank 2）。
 * brand_dir：同品牌辦公室的總監 odir；中央工廠＝研發總監 rdd（APV_UNIT_DIR_TITLE）；總部沒有 → 空。ceo／gm／chair：全集團該職稱。
 * 預設要求「比 of 高」：同一個職稱階梯內，職級要大於 of（同級、較低一律不算）。opts.noRank＝改派用，不比職級。
 */
function apvRoleMembers_(role, of, ctx, opts) {
  var noRank = !!(opts && opts.noRank);
  var out = [];
  for (var i = 0; i < ctx.people.length; i++) {
    var p = ctx.people[i];
    if (!p.opened || apvExcluded_(ctx, p.emp)) continue;
    var hit = false;
    if (role === 'head') {
      if (of) {
        if (of.ladder === 'store') hit = p.unit === of.unit && STF_STORE_HEAD_TITLES.indexOf(p.title) !== -1;
        else if (of.ladder === 'hq') hit = of.dept !== '' && p.unit === of.unit && p.dept === of.dept && p.title === 'hm';
        else if (of.ladder === 'office') hit = p.unit === of.unit && p.ladder === 'office' && p.rank === 2;
      }
    } else if (role === 'brand_dir') {
      if (of && APV_UNIT_DIR_TITLE.hasOwnProperty(of.unit)) hit = p.unit === of.unit && p.title === APV_UNIT_DIR_TITLE[of.unit];
      else hit = !!of && of.brand !== '' && p.title === 'odir' && p.ladder === 'office' && p.brand === of.brand;
    } else if (role === 'ceo' || role === 'gm' || role === 'chair') {
      hit = p.title === role;
    }
    if (!hit) continue;
    if (!noRank && of && p.ladder === of.ladder && p.rank <= of.rank) continue;
    out.push(p);
  }
  return out;
}

/** 直屬主管：對 of 用 stfReviewNeed_ 算出需要的審核者種類，再用 stfScopeMeets_ 比對每個人（只往上一層，不改既有規則） */
function apvDirectMembers_(of, ctx) {
  if (!of || !of.unit) return [];
  var need = stfReviewNeed_(ctx.org, of.unit, of.dept, of.title);
  if (!need) return [];
  var out = [];
  for (var i = 0; i < ctx.people.length; i++) {
    var p = ctx.people[i];
    if (!p.opened || p.emp === of.emp || apvExcluded_(ctx, p.emp)) continue;
    if (stfScopeMeets_(stfReviewScope_(p.values, ctx.org), need)) out.push(p);
  }
  return out;
}

/** 某一關現在能簽的人（person 陣列）。有改派（override）→ 只有 override.to；自己（ctx.exclude）永遠不能簽 */
function apvCandidates_(step, ctx) {
  if (step.override && step.override.to) {
    var t = apvFindPerson_(ctx, step.override.to);
    return (t && t.opened && !apvExcluded_(ctx, t.emp)) ? [t] : [];
  }
  if (step.role === 'self_sign') {
    var s = apvFindPerson_(ctx, step.emp);
    return (s && s.opened) ? [s] : [];
  }
  var of = apvFindPerson_(ctx, step.of);
  if (step.role === 'direct') return apvDirectMembers_(of, ctx);
  return apvRoleMembers_(step.role, of, ctx, null);
}

/** 能簽的人的 DZY 編號陣列（plan.md 契約名） */
function apvResolveStep_(step, ctx) {
  return apvCandidates_(step, ctx).map(function (p) { return p.emp; });
}

function apvScope_(role, of, ctx) {
  if (!of) return '';
  if (role === 'head' || role === 'direct') return of.unit + (of.ladder === 'hq' && of.dept ? '/' + of.dept : '');
  if (role === 'brand_dir') {
    var list = (ctx.org && ctx.org.list && ctx.org.list.unit) || [];
    for (var i = 0; i < list.length; i++) if (list[i].ladder === 'office' && list[i].parent === of.brand) return list[i].code;
    return of.brand;
  }
  return role === 'self_sign' ? '' : 'dzy';
}

function apvNewStep_(role, of, ctx) {
  return { role: role, scope: apvScope_(role, of, ctx), status: 'pending', of: of ? of.emp : '' };
}

/** 找不到人時，下一個更高的權限人；direct 找不到 → 從品牌總監往上；董事長之後沒有 */
function apvNextRole_(role) {
  if (role === 'direct') return 'brand_dir';
  var i = APV_ROLES.indexOf(role);
  return (i === -1 || i === APV_ROLES.length - 1) ? null : APV_ROLES[i + 1];
}

/** 對象同仁的組織鏈上，sender 是不是「直屬主管或更高」（spec §14.4）。不含對象本人 */
function apvChainAbove_(sender, subject, ctx) {
  if (!sender || !subject || !sender.opened || sender.emp === subject.emp) return false;
  if (subject.ladder === sender.ladder && sender.rank <= subject.rank) return false;
  if (sender.title === 'ceo' || sender.title === 'gm' || sender.title === 'chair') return true;
  if (sender.ladder === 'office' && sender.rank >= 2 && sender.brand !== '' && sender.brand === subject.brand) return true;
  // 同店主管（店長／廠長，及其上的區經理、研發總監；職級已在上面比過）
  if (sender.ladder === 'store' && sender.rank >= 3 && sender.unit !== '' && sender.unit === subject.unit) return true;
  if (sender.title === 'hm' && sender.unit === subject.unit && sender.dept !== '' && sender.dept === subject.dept) return true;
  var direct = apvDirectMembers_(subject, { org: ctx.org, people: ctx.people, byEmp: ctx.byEmp, exclude: [] });
  for (var i = 0; i < direct.length; i++) if (direct[i].emp === sender.emp) return true;
  return false;
}

/** 誰能送哪種人事單（spec §14.4）。isHr＝platform.staff／admin。回 true／false */
function apvCanSendPersonnel_(kind, sender, subject, ctx, isHr) {
  if (!sender || !subject) return false;
  if (kind === 'leave' && sender.emp === subject.emp) return true;
  if (isHr) return true;
  return apvChainAbove_(sender, subject, ctx);
}

// ============================================================
// 5. 建路線與往前走（T1-2）
// ============================================================

/**
 * 建路線快照（還沒找人）。input：{type, kind, amount, sender, subject, table:{ver,rows}, ctx, now, signedAtSubmit}
 * 請購／請款：只有一關（該列的權限人）。人事：見 spec §14.4 矩陣。回 {ok:true, route} 或 {ok:false, error}。
 */
function apvBuildRoute_(input) {
  var ctx = input.ctx;
  var sender = input.sender;
  var route = { v: 1, thr_ver: 0, row: null, steps: [], handler: APV_HANDLER_DEPT[input.type] || '' };
  if (input.type === 'purchase' || input.type === 'expense') {
    var table = input.table;
    if (!table || !table.rows || !table.rows.length) return { ok: false, error: 'not_inited' };
    var row = apvPickRow_(table.rows, input.amount);
    if (!row) return { ok: false, error: 'bad_amount' };
    var role = sender.ladder === 'hq' ? row.hq_role : row.store_role;   // 總部各部門用 hq_role，其餘（門市、央廚、品牌辦公室）用 store_role
    route.thr_ver = table.ver || 0;
    route.row = { seq: row.seq, max: apvOpenMax_(row.max) ? null : Number(row.max), role: role };
    route.steps.push(apvNewStep_(role, sender, ctx));
    return { ok: true, route: route };
  }
  if (input.type !== 'personnel') return { ok: false, error: 'bad_request' };
  var subject = input.subject;
  if (!subject) return { ok: false, error: 'bad_request' };
  if (input.kind === 'leave') {
    if (subject.opened) {
      var ss = { role: 'self_sign', scope: '', status: 'pending', of: subject.emp, emp: subject.emp };
      if (input.signedAtSubmit) { ss.status = 'done'; ss.by = subject.emp; ss.at = input.now || 0; }
      route.steps.push(ss);
    }
  }
  if (input.kind === 'leave' || input.kind === 'transfer') {
    // 直屬主管＝送件人本人（送件人是對象的直屬主管）→ 這關改成送件人的直屬主管
    var of = subject;
    var direct = apvDirectMembers_(subject, { org: ctx.org, people: ctx.people, byEmp: ctx.byEmp, exclude: [] });
    for (var i = 0; i < direct.length; i++) if (direct[i].emp === sender.emp) { of = sender; break; }
    route.steps.push(apvNewStep_('direct', of, ctx));
  } else if (input.kind === 'raise') {
    route.steps.push(apvNewStep_('gm', subject, ctx));   // 調薪一律總經理
  } else {
    return { ok: false, error: 'bad_request' };
  }
  return { ok: true, route: route };
}

/**
 * 往前走：從頭找第一個還沒完成的關，查現在能簽的人。
 * 空缺 → 該關標 skipped，往更高的下一個權限人（插在後面）；董事長之後也沒人 → exception（最後一關停在 skipped）。
 * 本人簽名關沒人（對象帳號被停用）→ exception，不往上。route 以傳值方式複製，不改傳入物件。
 * 回 {route, status:'signing'|'handling'|'exception', index, candidates:[person], skips:[{role,next}]}
 */
function apvAdvance_(route0, ctx) {
  var route = JSON.parse(JSON.stringify(route0));
  var steps = route.steps;
  var skips = [];
  var i = 0;
  for (var guard = 0; guard < 40; guard++) {
    while (i < steps.length && (steps[i].status === 'done' || steps[i].status === 'skipped')) i++;
    if (i >= steps.length) return { route: route, status: 'handling', index: -1, candidates: [], skips: skips };
    var step = steps[i];
    var cands = apvCandidates_(step, ctx);
    if (cands.length) return { route: route, status: 'signing', index: i, candidates: cands, skips: skips };
    step.status = 'skipped';
    if (step.role === 'self_sign') return { route: route, status: 'exception', index: i, candidates: [], skips: skips };
    var next = apvNextRole_(step.role);
    skips.push({ role: step.role, next: next });
    if (!next) return { route: route, status: 'exception', index: i, candidates: [], skips: skips };
    var of = apvFindPerson_(ctx, step.of);
    steps.splice(i + 1, 0, apvNewStep_(next, of, ctx));
    i++;
  }
  return { route: route, status: 'exception', index: Math.max(0, steps.length - 1), candidates: [], skips: skips };
}

/** 路線預覽/檢視用：對每一個還沒完成的關附上目前的候選人（不影響走到哪） */
function apvAttachCandidates_(route, ctx) {
  route.steps.forEach(function (st) {
    if (st.status === 'pending') st.candidates = apvCandidates_(st, ctx).map(function (p) { return { emp: p.emp, name: p.name }; });
  });
  return route;
}

/**
 * 改派的合格人選（spec §14.3）：該關 role 或更高的權限人（不比職級、排除送件人與對象）；
 * exception 時總經理、董事長一律可（董事長自己送單時由總經理接）。本人簽名關不能改派。
 */
function apvReassignMembers_(route, index, status, ctx) {
  var step = route.steps[index];
  if (!step || step.role === 'self_sign') return [];
  var of = apvFindPerson_(ctx, step.of);
  var roles = [];
  if (step.role === 'direct') {
    roles = ['direct'].concat(APV_ROLES.slice(1));
  } else {
    roles = APV_ROLES.slice(Math.max(0, APV_ROLES.indexOf(step.role)));
  }
  if (status === 'exception') {
    if (roles.indexOf('gm') === -1) roles.push('gm');
    if (roles.indexOf('chair') === -1) roles.push('chair');
  }
  var seen = {};
  var out = [];
  roles.forEach(function (r) {
    var list = r === 'direct' ? apvDirectMembers_(of, ctx) : apvRoleMembers_(r, of, ctx, { noRank: true });
    list.forEach(function (p) { if (!seen[p.emp]) { seen[p.emp] = 1; out.push(p); } });
  });
  return out;
}
