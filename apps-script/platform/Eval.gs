/**
 * Eval.gs — 績效評核（docs/eval/spec.md；契約 plan.md「共用契約」）
 * 舊站 mala-eval（只給新竹光復）搬進管理系統、四個「品牌」各一套題目與表：mzt、mala、yiwu、ck。
 *
 * 1. 常數與分頁　2. 小工具　3. 脈絡（evEnter_）與範圍（evScope_）　4. 題庫與表
 * 5. 同仁：evMe、evPeerSubmit、evSelfSubmit、evMyScores
 * 6. 主管：evNewbieList、evNewbieSubmit、evUnitResults、evPersonDetail、evSupSave
 * 7. 設定：evSetup、evBankSave、evTplSave、evWageSave、evGradeSave、evFinalize、evUnfinalize、evImportPreview、evImportCommit
 *
 * 規矩：
 * - 互評原始分數（誰給誰幾分）永遠不出現在任何回應；只回彙總（EvalCalc.gs evAggregate_）。
 * - 季度與填寫窗由後端判斷，不信前端。每筆送出存當下題目文字（labels），之後改題不會對錯題。
 * - 權限碼 platform.eval-manage／platform.eval-brand／platform.eval-all／platform.eval-admin（Perms.gs）；預設規則 EV_PERM_DEFAULT_RULES 由 evSetup 補進 perm_map。
 * - 依賴：Staff.gs（組織、同仁列）、ApprovalRoute.gs apvPerson_、Approvals.gs apvDirectory_、Auth.gs、Perms.gs、EvalCalc.gs。
 */

// ============================================================
// 1. 常數
// ============================================================

var EV_BRANDS = ['mzt', 'mala', 'yiwu', 'ck'];
var EV_SETS = ['pt_att', 'pt_perf', 'ft_att'];
var EV_NEWBIE_SINCE = '2026-11-20';   // 到職日早於這天不觸發新人考核（上線 2026-12-20 前一個月）

var EV_SH = {
  bank: 'ev_bank', tpl: 'ev_kpi_tpl', assign: 'ev_kpi_assign', wage: 'ev_wage', grade: 'ev_grade',
  peer: 'ev_peer', self: 'ev_self', msg: 'ev_msg', sup: 'ev_sup', newbie: 'ev_newbie', fin: 'ev_final', hist: 'ev_hist'
};
var EV_H = {
  bank: ['brand', 'set', 'ord', 'key', 'label', 'levels', 'active', 'updated_at', 'updated_by'],
  tpl: ['brand', 'title', 'ord', 'key', 'type', 'label', 'target', 'a', 'b', 'c', 'd', 'weight'],
  assign: ['emp_no', 'brand', 'title', 'updated_at', 'updated_by'],
  wage: ['brand', 'ord', 'range_text', 'wage'],
  grade: ['brand', 'grade', 'min_score', 'bonus_base'],
  peer: ['quarter', 'unit', 'rater', 'ratee', 'att', 'perf', 'labels', 'at'],
  self: ['quarter', 'unit', 'emp_no', 'att', 'perf', 'labels', 'at'],
  msg: ['quarter', 'from', 'kind', 'to', 'text', 'anon', 'at'],
  sup: ['quarter', 'ratee', 'kpi', 'tpl_title', 'adj_att', 'adj_perf', 'adj_reason', 'feedback', 'by', 'at'],
  newbie: ['emp_no', 'unit', 'hire_date', 'rater', 'att', 'perf', 'labels', 'at'],
  fin: ['quarter', 'unit', 'emp_no', 'kind', 'result', 'by', 'at'],
  hist: ['quarter', 'emp_no', 'kind', 'result', 'src', 'by', 'at']
};

// 權限預設規則：[ladder, dept, title, perm]（Q5 A：全依單位＋職稱；Eason 可在權限設定改）
var EV_PERM_DEFAULT_RULES = (function () {
  var out = [];
  var add = function (ladder, dept, titles, perms) {
    titles.forEach(function (t) { perms.forEach(function (p) { out.push([ladder, dept, t, p]); }); });
  };
  add('store', '', ['sm', 'am', 'fm'], ['platform.eval-manage']);
  add('store', '', ['rdd'], ['platform.eval-manage', 'platform.eval-brand']);
  add('office', '', ['osv', 'odir'], ['platform.eval-manage', 'platform.eval-brand']);
  add('hq', 'hr', ['*'], ['platform.eval-all']);
  add('hq', '', ['ceo', 'gm', 'chair'], ['platform.eval-all']);
  add('hq', 'hr', ['hm'], ['platform.eval-admin']);
  return out;
})();

// 等第與時薪預設（舊站值；evSetup 給四品牌各寫一份，之後各自改）
var EV_WAGE_DEFAULT = [['96 分以上', '340'], ['91～95 分', '300'], ['86～90 分', '280'], ['81～85 分', '230'],
  ['76～80 分', '220'], ['71～75 分', '210'], ['66～70 分', '205'], ['65 分以下', '法定時薪']];

// ============================================================
// 2. 小工具
// ============================================================

function evFail_(error, message) { return { ok: false, error: error, message: message || '' }; }
function evStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function evJson_(s, fb) { if (s === '' || s === null || s === undefined) return fb; try { return JSON.parse(s); } catch (e) { return fb; } }

/** 台北日期 'YYYY-MM-DD'（測試可在 sandbox 覆寫 evToday_） */
function evToday_() {
  var d = new Date(Date.now() + 8 * 3600 * 1000);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
function evNowText_() { return new Date().toISOString(); }

/** 剛結束的上一季（1～3 月→去年 Q4；4～6→Q1…），與舊站 currentQuarter 相同 */
function evQuarterNow_(today) {
  var p = evYmd_(today);
  var q = Math.floor((p.m - 1) / 3);   // 0..3＝本季序
  return q === 0 ? (p.y - 1) + '-Q4' : p.y + '-Q' + q;
}
function evWindowOpen_(today) { var p = evYmd_(today); return (p.m - 1) % 3 === 0 && p.d <= 5; }
/** 本季（剛結束那季）在每季第一個月 10 號前不公布；其餘季度都可看 */
function evResultVisible_(quarter, today) {
  if (quarter !== evQuarterNow_(today)) return evQuarterCmp_(quarter, evQuarterNow_(today)) < 0;
  var p = evYmd_(today);
  return !((p.m - 1) % 3 === 0 && p.d < 10);
}
function evQuarterCmp_(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
function evValidQuarter_(q) { return /^\d{4}-Q[1-4]$/.test(evStr_(q)); }

function evRows_(key) {
  var h = EV_H[key];
  // 跳過整列空白（evRewrite_ 清掉的列；Mac mini 的假試算表 getLastRow 可能仍算到它們）
  return stfReadRows_(EV_SH[key], h.length).map(function (v, i) {
    if (v.every(function (x) { return x === '' || x === null || x === undefined; })) return null;
    var o = { _row: i + 2 };
    h.forEach(function (name, j) { o[name] = v[j]; });
    return o;
  }).filter(Boolean);
}
function evToRow_(key, o) { return EV_H[key].map(function (h) { var v = o[h]; return (v === undefined || v === null) ? '' : v; }); }
function evAppend_(key, objs) {
  if (!objs.length) return;
  stfAppendBlock_(EV_SH[key], objs.map(function (o) { return evToRow_(key, o); }), EV_H[key].length, true);
}
/** 刪掉符合條件的列後整張重寫（資料量小：一季一店幾十列）；keepFn 回 true 的留下 */
function evRewrite_(key, keepFn, extra) {
  var h = EV_H[key];
  var rows = evRows_(key).filter(keepFn).map(function (o) { return evToRow_(key, o); }).concat((extra || []).map(function (o) { return evToRow_(key, o); }));
  var sh = stfSheet_(EV_SH[key]);
  var last = sh.getLastRow();
  if (last >= 2) {
    var blank = [];
    for (var i = 0; i < last - 1; i++) { var r = []; for (var j = 0; j < h.length; j++) r.push(''); blank.push(r); }
    sh.getRange(2, 1, last - 1, h.length).setValues(blank);
  }
  if (rows.length) {
    var range = sh.getRange(2, 1, rows.length, h.length);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
}
function evWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return evFail_('busy', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}
function evReady_() {
  for (var k in EV_SH) if (!stfSheet_(EV_SH[k])) return false;
  return true;
}
function evNotInited_() { return evFail_('not_inited', '績效評核還沒初始化，請系統管理者先按「初始化績效評核」'); }

/** 星等陣列：長度 n、每格 1～5 整數 */
function evStarsOk_(arr, n) {
  if (!Array.isArray(arr) || arr.length !== n) return false;
  return arr.every(function (v) { return typeof v === 'number' && v % 1 === 0 && v >= 1 && v <= 5; });
}

// ============================================================
// 3. 脈絡與範圍
// ============================================================

/** 讀 staff 右側 hire_date（第 STF_COL_COUNT 欄，0-based） */
function evHireMap_() {
  var m = {};
  stfReadRows_(STF_SHEET, STF_COL_COUNT + 1).forEach(function (v) {
    var emp = stfNormEmp_(v[STF_COL.emp_no]);
    if (emp) m[emp] = evStr_(v[STF_COL_COUNT]).slice(0, 10);
  });
  return m;
}

/** 這個人是不是評核對象：開通、門市／央廚單位（品牌 mzt／mala／yiwu／ck、ladder store）、單位啟用 */
function evEvaluable_(p, org) {
  if (!p || !p.opened) return false;
  var u = org.unit[p.unit];
  return !!u && u.active !== false && EV_BRANDS.indexOf(p.brand) !== -1 && (p.ladder || 'store') === 'store';
}
function evKind_(p) { return p.title === 'pt' ? 'pt' : 'ft'; }

function evEnter_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return evFail_('unauthorized', sess.error);
  var d = apvDirectory_();
  var me = null;
  d.people.forEach(function (p) { if (p.uid !== '' && p.uid === String(sess.user.id)) me = p; });
  var c = {
    ok: true, user: sess.user, perms: sess.perms || [], org: d.org, people: d.people, byEmp: d.byEmp, me: me,
    isAdmin: String(sess.user.role) === 'admin', today: evToday_()
  };
  c.scope = evScope_(c);
  return c;
}

/**
 * 範圍：{all, units:{unit:true}, admin, canManage(p)}
 * platform.eval-all → 全部；platform.eval-brand → 同品牌單位；platform.eval-manage → 目前身分往上一層可審的人（stfReviewNeed_，S3 A）。
 */
function evScope_(c) {
  var has = function (p) { return c.isAdmin || hasPerm_(c.perms, p); };
  var s = { all: has('platform.eval-all'), units: {}, admin: has('platform.eval-admin'), manage: has('platform.eval-manage') };
  if (!s.all && hasPerm_(c.perms, 'platform.eval-brand') && c.me && c.me.brand) {
    Object.keys(c.org.unit).forEach(function (u) { if (c.org.unit[u].parent === c.me.brand) s.units[u] = true; });
  }
  var rscope = (s.manage && c.me) ? stfReviewScope_(c.me.values, c.org) : null;
  s.canManage = function (p) {
    if (!p || (c.me && p.emp === c.me.emp)) return false;
    if (c.isAdmin) return true;
    // 用目前身分判斷（stfCanReview_ 看的是認領送出的 p_* 欄，認領通過後會清空）；規則同同仁認領審核「往上一層」
    return !!rscope && stfScopeMeets_(rscope, stfReviewNeed_(c.org, p.unit, p.dept, p.title));
  };
  s.canView = function (p) {
    if (!p) return false;
    if (c.me && p.emp === c.me.emp) return false;   // 自己的成績走 evMyScores
    return s.all || !!s.units[p.unit] || s.canManage(p);
  };
  return s;
}

// ============================================================
// 4. 題庫與表
// ============================================================

function evBankOf_(brand) {
  var out = { pt_att: [], pt_perf: [], ft_att: [] };
  evRows_('bank').forEach(function (r) {
    if (evStr_(r.brand) !== brand || !out[evStr_(r.set)] || String(r.active).toUpperCase() === 'FALSE') return;
    out[evStr_(r.set)].push({ key: evStr_(r.key), ord: Number(r.ord) || 0, label: evStr_(r.label), levels: evJson_(r.levels, []) });
  });
  EV_SETS.forEach(function (s) { out[s].sort(function (a, b) { return a.ord - b.ord; }); });
  return out;
}
function evTplOf_(brand, title) {
  return evRows_('tpl').filter(function (r) { return evStr_(r.brand) === brand && evStr_(r.title) === title; })
    .map(function (r) {
      return { key: evStr_(r.key), ord: Number(r.ord) || 0, type: evStr_(r.type), label: evStr_(r.label), target: evStr_(r.target),
        a: evStr_(r.a), b: evStr_(r.b), c: evStr_(r.c), d: evStr_(r.d), weight: Number(r.weight) || 0 };
    }).sort(function (a, b) { return a.ord - b.ord; });
}
function evTplTitles_(brand) {
  var m = {};
  evRows_('tpl').forEach(function (r) { if (evStr_(r.brand) === brand) m[evStr_(r.title)] = true; });
  return Object.keys(m);
}
/** 這個正職用哪張範本：個別指定 > 本人職稱 > 'ft' */
function evTplFor_(p, supRow) {
  var titles = evTplTitles_(p.brand);
  var pick = '';
  if (supRow && evStr_(supRow.tpl_title) && titles.indexOf(evStr_(supRow.tpl_title)) !== -1) pick = evStr_(supRow.tpl_title);
  if (!pick) evRows_('assign').forEach(function (r) { if (stfNormEmp_(r.emp_no) === p.emp && titles.indexOf(evStr_(r.title)) !== -1) pick = evStr_(r.title); });
  if (!pick && titles.indexOf(p.title) !== -1) pick = p.title;
  if (!pick && titles.indexOf('ft') !== -1) pick = 'ft';
  return { title: pick, items: pick ? evTplOf_(p.brand, pick) : [] };
}
function evWageOf_(brand) {
  return evRows_('wage').filter(function (r) { return evStr_(r.brand) === brand; })
    .sort(function (a, b) { return Number(a.ord) - Number(b.ord); }).map(function (r) { return [evStr_(r.range_text), evStr_(r.wage)]; });
}
function evGradeOf_(brand) {
  var t = evRows_('grade').filter(function (r) { return evStr_(r.brand) === brand; })
    .map(function (r) { return { grade: evStr_(r.grade), min: Number(r.min_score), base: Number(r.bonus_base) }; });
  return t.length ? t.sort(function (a, b) { return b.min - a.min; }) : EV_GRADE_DEFAULT;
}
function evSetsFor_(kind) { return kind === 'pt' ? { att: 'pt_att', perf: 'pt_perf' } : { att: 'ft_att', perf: null }; }
function evLabels_(bank, kind) {
  var s = evSetsFor_(kind);
  return { att: bank[s.att].map(function (i) { return i.label; }), perf: s.perf ? bank[s.perf].map(function (i) { return i.label; }) : [] };
}

// ============================================================
// 5. 同仁
// ============================================================

/** 送出狀態與同店名單（填寫頁用）。非評核對象也回 ok（畫面顯示「你不在評核範圍」） */
function handleEvMe_(token) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  var q = evQuarterNow_(c.today);
  var me = c.me;
  var out = {
    today: c.today, quarter: q, windowOpen: evWindowOpen_(c.today), resultVisible: evResultVisible_(q, c.today),
    evaluable: !!(me && evEvaluable_(me, c.org)),
    perms: { manage: c.scope.manage, readBrand: !c.scope.all && Object.keys(c.scope.units).length > 0, read: c.scope.all, admin: c.scope.admin }
  };
  if (!out.evaluable) return { ok: true, data: out };
  var bank = evBankOf_(me.brand);
  out.me = { emp: me.emp, name: me.name, unit: me.unit, unitName: (c.org.unit[me.unit] || {}).name || me.unit, brand: me.brand, kind: evKind_(me) };
  out.bank = bank;
  out.bankReady = bank.pt_att.length > 0 && bank.pt_perf.length > 0 && bank.ft_att.length > 0;
  out.peers = c.people.filter(function (p) { return p.emp !== me.emp && p.unit === me.unit && evEvaluable_(p, c.org); })
    .map(function (p) { return { emp: p.emp, name: p.name, kind: evKind_(p) }; });
  out.peerDone = evRows_('peer').some(function (r) { return r.quarter === q && stfNormEmp_(r.rater) === me.emp; });
  out.selfDone = evRows_('self').some(function (r) { return r.quarter === q && stfNormEmp_(r.emp_no) === me.emp; });
  return { ok: true, data: out };
}

/** payload {ratings:[{ratee, att:[…], perf:[…]}]}：只收評完的人；一季一次 */
function handleEvPeerSubmit_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  var me = c.me;
  if (!me || !evEvaluable_(me, c.org)) return evFail_('forbidden', '你不在本季評核範圍');
  if (!evWindowOpen_(c.today)) return evFail_('window_closed', '現在不是填寫期間（每季第一個月 1～5 號）');
  var list = payload && payload.ratings;
  if (!Array.isArray(list) || !list.length) return evFail_('bad_request', '至少要完整評完一位同仁');
  var q = evQuarterNow_(c.today);
  var bank = evBankOf_(me.brand);
  var rows = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var p = c.byEmp[stfNormEmp_(r.ratee)];
    if (!p || p.emp === me.emp || p.unit !== me.unit || !evEvaluable_(p, c.org)) return evFail_('not_in_unit', '只能評同一家店的同仁');
    if (seen[p.emp]) return evFail_('bad_request', '同一位同仁重複出現');
    seen[p.emp] = true;
    var kind = evKind_(p), sets = evSetsFor_(kind);
    if (!evStarsOk_(r.att, bank[sets.att].length)) return evFail_('bad_request', p.name + ' 的態度題沒評完');
    if (sets.perf && !evStarsOk_(r.perf, bank[sets.perf].length)) return evFail_('bad_request', p.name + ' 的工作表現題沒評完');
    rows.push({ quarter: q, unit: me.unit, rater: me.emp, ratee: p.emp, att: JSON.stringify(r.att),
      perf: sets.perf ? JSON.stringify(r.perf) : '', labels: JSON.stringify(evLabels_(bank, kind)), at: evNowText_() });
  }
  return evWithLock_(function () {
    if (evRows_('peer').some(function (x) { return x.quarter === q && stfNormEmp_(x.rater) === me.emp; })) return evFail_('duplicate', '本季已送出過評鑑');
    evAppend_('peer', rows);
    return { ok: true, data: { quarter: q, count: rows.length } };
  });
}

/** payload {att, perf, note, company, peers:[{to, msg, anon}]} */
function handleEvSelfSubmit_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  var me = c.me;
  if (!me || !evEvaluable_(me, c.org)) return evFail_('forbidden', '你不在本季評核範圍');
  if (!evWindowOpen_(c.today)) return evFail_('window_closed', '現在不是填寫期間（每季第一個月 1～5 號）');
  payload = payload || {};
  var q = evQuarterNow_(c.today);
  var bank = evBankOf_(me.brand), kind = evKind_(me), sets = evSetsFor_(kind);
  if (!evStarsOk_(payload.att, bank[sets.att].length)) return evFail_('bad_request', '態度題沒評完');
  if (sets.perf && !evStarsOk_(payload.perf, bank[sets.perf].length)) return evFail_('bad_request', '工作表現題沒評完');
  var now = evNowText_();
  var msgs = [];
  var clip = function (s) { return evStr_(s).slice(0, 1000); };
  if (clip(payload.note)) msgs.push({ quarter: q, from: me.emp, kind: 'self', to: me.emp, text: clip(payload.note), anon: '', at: now });
  if (clip(payload.company)) msgs.push({ quarter: q, from: me.emp, kind: 'company', to: me.unit, text: clip(payload.company), anon: 'TRUE', at: now });
  var peers = Array.isArray(payload.peers) ? payload.peers : [];
  for (var i = 0; i < peers.length; i++) {
    var m = peers[i] || {};
    if (!clip(m.msg)) continue;
    var to = c.byEmp[stfNormEmp_(m.to)];
    if (!to || to.unit !== me.unit || to.emp === me.emp || !evEvaluable_(to, c.org)) return evFail_('not_in_unit', '留言對象要是同一家店的同仁');
    msgs.push({ quarter: q, from: me.emp, kind: 'peer', to: to.emp, text: clip(m.msg), anon: m.anon === false ? 'FALSE' : 'TRUE', at: now });
  }
  return evWithLock_(function () {
    if (evRows_('self').some(function (x) { return x.quarter === q && stfNormEmp_(x.emp_no) === me.emp; })) return evFail_('duplicate', '本季已送出過自評');
    evAppend_('msg', msgs);   // 留言先寫、自評最後寫（自評列＝閘門，同舊站）
    evAppend_('self', [{ quarter: q, unit: me.unit, emp_no: me.emp, att: JSON.stringify(payload.att),
      perf: sets.perf ? JSON.stringify(payload.perf) : '', labels: JSON.stringify(evLabels_(bank, kind)), at: now }]);
    return { ok: true, data: { quarter: q } };
  });
}

/**
 * 一人一季的完整結果（不含評分者身分）。定稿／匯入值優先。
 * 回 {quarter, kind, source:'live'|'final'|'hist', agg, attLabels, perfLabels, kpi:[…], selfAtt, selfPerf, peerAttItems, peerPerfItems}
 */
function evPersonQuarter_(c, p, q, cache) {
  var fin = cache.fin.filter(function (r) { return r.quarter === q && stfNormEmp_(r.emp_no) === p.emp; })[0];
  var hist = cache.hist.filter(function (r) { return r.quarter === q && stfNormEmp_(r.emp_no) === p.emp; })[0];
  if (fin || hist) {
    var src = fin || hist;
    var res = evJson_(src.result, {});
    return { quarter: q, kind: evStr_(src.kind) || evKind_(p), source: fin ? 'final' : 'hist', frozen: res };
  }
  var peers = cache.peer.filter(function (r) { return r.quarter === q && stfNormEmp_(r.ratee) === p.emp; });
  var self = cache.self.filter(function (r) { return r.quarter === q && stfNormEmp_(r.emp_no) === p.emp; })[0];
  var sup = cache.sup.filter(function (r) { return r.quarter === q && stfNormEmp_(r.ratee) === p.emp; })[0];
  if (!peers.length && !self && !sup) return null;
  var kind = evKind_(p);
  var lab = evJson_((self && self.labels) || (peers[0] && peers[0].labels), null) || evLabels_(evBankOf_(p.brand), kind);
  var attL = peers.map(function (r) { return evJson_(r.att, []); });
  var perfL = peers.map(function (r) { return evJson_(r.perf, []); });
  var selfAtt = self ? evJson_(self.att, []) : null, selfPerf = self ? evJson_(self.perf, []) : null;
  var tpl = kind === 'ft' ? evTplFor_(p, sup) : { title: '', items: [] };
  var kpiSel = sup ? evJson_(sup.kpi, {}) : {};
  var agg = evAggregate_({
    kind: kind,
    att: attL.concat(selfAtt ? [selfAtt] : []),
    perf: kind === 'pt' ? perfL.concat(selfPerf && selfPerf.length ? [selfPerf] : []) : [],
    kpiItems: tpl.items, kpiSel: kpiSel,
    adj: sup ? { att: sup.adj_att, perf: sup.adj_perf } : {},
    wageTiers: evWageOf_(p.brand), gradeTable: evGradeOf_(p.brand)
  });
  var peerAtt = evAverageItems_(attL.filter(function (s) { return s.length; }));
  return {
    quarter: q, kind: kind, source: 'live', agg: agg,
    attLabels: lab.att || [], perfLabels: lab.perf || [],
    kpiTitle: tpl.title,
    kpi: tpl.items.map(function (it) { var v = kpiSel[it.key] || {}; return { key: it.key, label: it.label, type: it.type, weight: it.weight, target: it.target, sel: v.sel || '', actual: v.actual || '', score: evKpiItemScore_(it, v.sel) }; }),
    selfAtt: selfAtt, selfPerf: selfPerf,
    peerAttItems: peerAtt && kind === 'ft' ? peerAtt.map(evFtAttitudeScale_) : peerAtt,
    peerPerfItems: evAverageItems_(perfL.filter(function (s) { return s.length; })),
    peerCount: peers.length
  };
}
/** 定稿用：live 結果壓成可存的 result */
function evFreeze_(r) {
  if (!r) return null;
  if (r.source !== 'live') return r.frozen;
  var a = r.agg;
  return { attitude: a.attitude, performance: a.performance, adjAtt: a.adjAtt, adjPerf: a.adjPerf, subtotal: a.subtotal, total: a.total,
    grade: a.grade, bonusBase: a.bonusBase, wageIdx: a.wageIdx, attItems: a.attItems, perfItems: a.perfItems,
    attLabels: r.attLabels, perfLabels: r.perfLabels, kpiTitle: r.kpiTitle, kpi: r.kpi, attCount: a.attCount, perfCount: a.perfCount };
}
function evCache_() {
  return { peer: evRows_('peer'), self: evRows_('self'), sup: evRows_('sup'), fin: evRows_('fin'), hist: evRows_('hist'), msg: evRows_('msg'), newbie: evRows_('newbie') };
}

function handleEvMyScores_(token) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  var me = c.me;
  if (!me) return { ok: true, data: { quarters: [] } };
  var cache = evCache_();
  var qs = {};
  ['peer', 'self', 'sup', 'fin', 'hist'].forEach(function (k) {
    cache[k].forEach(function (r) {
      var who = stfNormEmp_(k === 'peer' || k === 'sup' ? r.ratee : r.emp_no);
      if (who === me.emp && evValidQuarter_(r.quarter)) qs[r.quarter] = true;
    });
  });
  var quarters = Object.keys(qs).sort().filter(function (q) { return evResultVisible_(q, c.today); })
    .map(function (q) {
      var r = evPersonQuarter_(c, me, q, cache);
      if (!r) return null;
      var f = evFreeze_(r);
      f.quarter = q; f.kind = r.kind; f.source = r.source;
      if (r.source === 'live') { f.selfAtt = r.selfAtt; f.selfPerf = r.selfPerf; f.peerAttItems = r.peerAttItems; f.peerPerfItems = r.peerPerfItems; }
      var sup = cache.sup.filter(function (x) { return x.quarter === q && stfNormEmp_(x.ratee) === me.emp; })[0];
      f.feedback = sup ? evStr_(sup.feedback) : '';
      return f;
    }).filter(Boolean);
  // 留言：夥伴給我（匿名不帶名字）、我寫給自己。給公司的話不回。三種留言不受 10 號閘門限制（同舊站）
  var nameOf = function (emp) { var p = c.byEmp[emp]; return p ? p.name : ''; };
  var msgs = cache.msg.filter(function (m) { return stfNormEmp_(m.to) === me.emp && (m.kind === 'peer' || (m.kind === 'self' && stfNormEmp_(m.from) === me.emp)); })
    .map(function (m) {
      var anon = String(m.anon).toUpperCase() !== 'FALSE';
      return { quarter: m.quarter, kind: m.kind, text: evStr_(m.text), from: m.kind === 'peer' && !anon ? nameOf(stfNormEmp_(m.from)) : '' };
    });
  var fb = cache.sup.filter(function (x) { return stfNormEmp_(x.ratee) === me.emp && evStr_(x.feedback); })
    .map(function (x) { return { quarter: x.quarter, text: evStr_(x.feedback) }; });
  var nb = cache.newbie.filter(function (r) { return stfNormEmp_(r.emp_no) === me.emp; })[0];
  return { ok: true, data: {
    kind: evKind_(me), brand: me.brand, quarters: quarters, messages: msgs, feedback: fb,
    wageTiers: evWageOf_(me.brand), gradeTable: evGradeOf_(me.brand),
    newbie: nb ? Object.assign({ at: evStr_(nb.at).slice(0, 10), labels: evJson_(nb.labels, {}) }, evNewbieScore_(evJson_(nb.att, []), evJson_(nb.perf, []))) : null
  } };
}

// ============================================================
// 6. 主管
// ============================================================

function handleEvNewbieList_(token) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  if (!c.scope.manage && !c.isAdmin) return evFail_('forbidden', '沒有權限');
  var hire = evHireMap_();
  var done = {};
  evRows_('newbie').forEach(function (r) { done[stfNormEmp_(r.emp_no)] = true; });
  var list = c.people.filter(function (p) { return evEvaluable_(p, c.org) && c.scope.canManage(p); })
    .map(function (p) {
      var s = evNewbieStatus_(hire[p.emp] || '', c.today, !!done[p.emp], EV_NEWBIE_SINCE);
      return { emp: p.emp, name: p.name, unit: p.unit, brand: p.brand, unitName: (c.org.unit[p.unit] || {}).name || p.unit, state: s.state, hire: s.hire || '', dueOn: s.dueOn || '', overdueDays: s.overdueDays || 0, daysLeft: s.daysLeft || 0, late: !!s.late };
    }).filter(function (x) { return x.state === 'due' || x.state === 'waiting'; })
    .sort(function (a, b) { return (b.state === 'due') - (a.state === 'due') || b.overdueDays - a.overdueDays; });
  var banks = {};
  list.forEach(function (x) { if (!banks[x.brand]) { var b = evBankOf_(x.brand); banks[x.brand] = { pt_att: b.pt_att, pt_perf: b.pt_perf }; } });
  return { ok: true, data: { list: list, banks: banks } };
}

/** payload {emp, att, perf}：計時題目（同舊站，正職新人也用計時那套）；一人一次 */
function handleEvNewbieSubmit_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  payload = payload || {};
  var p = c.byEmp[stfNormEmp_(payload.emp)];
  if (!p || !evEvaluable_(p, c.org) || !c.scope.canManage(p)) return evFail_('forbidden', '你不能考核這位同仁');
  var s = evNewbieStatus_(evHireMap_()[p.emp] || '', c.today, false, EV_NEWBIE_SINCE);
  if (s.state !== 'due') return evFail_('bad_request', '這位同仁目前不是待考核狀態');
  var bank = evBankOf_(p.brand);
  if (!evStarsOk_(payload.att, bank.pt_att.length) || !evStarsOk_(payload.perf, bank.pt_perf.length)) return evFail_('bad_request', '題目沒評完');
  return evWithLock_(function () {
    if (evRows_('newbie').some(function (r) { return stfNormEmp_(r.emp_no) === p.emp; })) return evFail_('duplicate', '這位同仁已考核過');
    evAppend_('newbie', [{ emp_no: p.emp, unit: p.unit, hire_date: s.hire, rater: c.me ? c.me.emp : String(c.user.id),
      att: JSON.stringify(payload.att), perf: JSON.stringify(payload.perf), labels: JSON.stringify(evLabels_(bank, 'pt')), at: evNowText_() }]);
    return { ok: true, data: evNewbieScore_(payload.att, payload.perf) };
  });
}

/** 看得到的單位清單＋某單位某季的總覽與填寫進度。payload {unit?, quarter?} */
function handleEvUnitResults_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  payload = payload || {};
  var visible = c.people.filter(function (p) { return evEvaluable_(p, c.org) && c.scope.canView(p); });
  var unitSet = {};
  visible.forEach(function (p) { unitSet[p.unit] = true; });
  if (c.scope.all || c.isAdmin) Object.keys(c.org.unit).forEach(function (u) { var x = c.org.unit[u]; if (x.active !== false && EV_BRANDS.indexOf(x.parent) !== -1 && (x.ladder || 'store') === 'store') unitSet[u] = true; });
  Object.keys(c.scope.units).forEach(function (u) { var x = c.org.unit[u]; if (x && x.active !== false && (x.ladder || 'store') === 'store') unitSet[u] = true; });
  var units = Object.keys(unitSet).map(function (u) { return { unit: u, name: c.org.unit[u].name, brand: c.org.unit[u].parent }; });
  if (!units.length) return evFail_('no_scope', '你沒有可以查看的單位');
  var unit = evStr_(payload.unit) || units[0].unit;
  if (!unitSet[unit]) return evFail_('forbidden', '你不能查看這個單位');
  var q = evValidQuarter_(payload.quarter) ? payload.quarter : evQuarterNow_(c.today);
  var cache = evCache_();
  var people = c.people.filter(function (p) { return p.unit === unit && evEvaluable_(p, c.org) && (c.scope.canView(p) || (c.me && p.emp === c.me.emp)); });
  var finalized = cache.fin.some(function (r) { return r.quarter === q && evStr_(r.unit) === unit; });
  var rows = people.map(function (p) {
    var self = c.me && p.emp === c.me.emp;
    var r = self ? null : evPersonQuarter_(c, p, q, cache);
    var f = r ? evFreeze_(r) : null;
    return {
      emp: p.emp, name: p.name, title: p.title, titleName: (c.org.title[p.title] || {}).name || p.title, kind: evKind_(p), isMe: !!self,
      canManage: !self && c.scope.canManage(p),
      peerDone: cache.peer.some(function (x) { return x.quarter === q && stfNormEmp_(x.rater) === p.emp; }),
      selfDone: cache.self.some(function (x) { return x.quarter === q && stfNormEmp_(x.emp_no) === p.emp; }),
      result: f ? { attitude: f.attitude, performance: f.performance, adjAtt: f.adjAtt, adjPerf: f.adjPerf, subtotal: f.subtotal, total: f.total, grade: f.grade, wageIdx: f.wageIdx, attCount: f.attCount, perfCount: f.perfCount, source: r.source } : null
    };
  });
  var company = (c.scope.all || c.isAdmin || c.scope.units[unit]) ? cache.msg.filter(function (m) { return m.kind === 'company' && m.quarter === q && evStr_(m.to) === unit; }).map(function (m) { return evStr_(m.text); }) : [];
  return { ok: true, data: { units: units, unit: unit, unitName: c.org.unit[unit].name, brand: c.org.unit[unit].parent, quarter: q, finalized: finalized,
    windowOpen: evWindowOpen_(c.today), rows: rows, company: company, wageTiers: evWageOf_(c.org.unit[unit].parent), gradeTable: evGradeOf_(c.org.unit[unit].parent), canFinalize: c.scope.admin } };
}

/** 一人一季明細（不含評分者身分）＋主管可編的欄位。payload {emp, quarter} */
function handleEvPersonDetail_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  payload = payload || {};
  var p = c.byEmp[stfNormEmp_(payload.emp)];
  if (!p || !c.scope.canView(p)) return evFail_('forbidden', '你不能查看這位同仁');
  var q = evValidQuarter_(payload.quarter) ? payload.quarter : evQuarterNow_(c.today);
  var cache = evCache_();
  var r = evPersonQuarter_(c, p, q, cache);
  var sup = cache.sup.filter(function (x) { return x.quarter === q && stfNormEmp_(x.ratee) === p.emp; })[0];
  var tpl = evKind_(p) === 'ft' ? evTplFor_(p, sup) : { title: '', items: [] };
  var nb = cache.newbie.filter(function (x) { return stfNormEmp_(x.emp_no) === p.emp; })[0];
  var f = r ? evFreeze_(r) : null;
  if (f && r.source === 'live') { f.selfAtt = r.selfAtt; f.selfPerf = r.selfPerf; f.peerAttItems = r.peerAttItems; f.peerPerfItems = r.peerPerfItems; f.peerCount = r.peerCount; }
  return { ok: true, data: {
    emp: p.emp, name: p.name, kind: evKind_(p), unit: p.unit, brand: p.brand, quarter: q,
    canManage: c.scope.canManage(p),
    finalized: cache.fin.some(function (x) { return x.quarter === q && evStr_(x.unit) === p.unit; }),
    result: f, source: r ? r.source : null,
    sup: { kpi: sup ? evJson_(sup.kpi, {}) : {}, adjAtt: sup ? Number(sup.adj_att) || 0 : 0, adjPerf: sup ? Number(sup.adj_perf) || 0 : 0, adjReason: sup ? evStr_(sup.adj_reason) : '', feedback: sup ? evStr_(sup.feedback) : '' },
    tpl: tpl, tplTitles: evTplTitles_(p.brand),
    newbie: nb ? Object.assign({ at: evStr_(nb.at).slice(0, 10), labels: evJson_(nb.labels, {}), att: evJson_(nb.att, []), perf: evJson_(nb.perf, []) }, evNewbieScore_(evJson_(nb.att, []), evJson_(nb.perf, []))) : null
  } };
}

/** payload {emp, quarter, kpi?, tpl_title?, adj_att?, adj_perf?, adj_reason?, feedback?}：只改有帶的欄位 */
function handleEvSupSave_(token, payload) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!evReady_()) return evNotInited_();
  payload = payload || {};
  var p = c.byEmp[stfNormEmp_(payload.emp)];
  if (!p || !evEvaluable_(p, c.org) || !c.scope.canManage(p)) return evFail_('forbidden', '你不能替這位同仁打分');
  var q = evValidQuarter_(payload.quarter) ? payload.quarter : evQuarterNow_(c.today);
  if (evQuarterCmp_(q, evQuarterNow_(c.today)) > 0) return evFail_('bad_request', '還沒到的季度不能打分');
  var num = function (v) { var n = Number(v); return (v === '' || v === null || v === undefined || isNaN(n) || Math.abs(n) > 100) ? null : n; };
  if ('adj_att' in payload && num(payload.adj_att) === null) return evFail_('bad_request', '態度調整要是 -100～100 的數字');
  if ('adj_perf' in payload && num(payload.adj_perf) === null) return evFail_('bad_request', '表現調整要是 -100～100 的數字');
  if ('kpi' in payload && (typeof payload.kpi !== 'object' || Array.isArray(payload.kpi) || !payload.kpi)) return evFail_('bad_request', 'KPI 格式錯誤');
  return evWithLock_(function () {
    if (evRows_('fin').some(function (x) { return x.quarter === q && evStr_(x.unit) === p.unit; })) return evFail_('finalized', '這一季已定稿，要改請人資先解除定稿');
    var cur = evRows_('sup').filter(function (x) { return x.quarter === q && stfNormEmp_(x.ratee) === p.emp; })[0] || {};
    var o = { quarter: q, ratee: p.emp, kpi: cur.kpi || '', tpl_title: cur.tpl_title || '', adj_att: cur.adj_att || 0, adj_perf: cur.adj_perf || 0,
      adj_reason: cur.adj_reason || '', feedback: cur.feedback || '', by: c.me ? c.me.emp : String(c.user.id), at: evNowText_() };
    if ('kpi' in payload) {
      var clean = {};
      Object.keys(payload.kpi).forEach(function (k) {
        var v = payload.kpi[k] || {};
        var sel = evStr_(v.sel);
        if (['A', 'B', 'C', 'D', '完成', '未完成', ''].indexOf(sel) === -1) return;
        clean[evStr_(k).slice(0, 40)] = { sel: sel, actual: evStr_(v.actual).slice(0, 200) };
      });
      o.kpi = JSON.stringify(clean);
    }
    if ('tpl_title' in payload) o.tpl_title = evStr_(payload.tpl_title).slice(0, 20);
    if ('adj_att' in payload) o.adj_att = num(payload.adj_att);
    if ('adj_perf' in payload) o.adj_perf = num(payload.adj_perf);
    if ('adj_reason' in payload) o.adj_reason = evStr_(payload.adj_reason).slice(0, 500);
    if ('feedback' in payload) o.feedback = evStr_(payload.feedback).slice(0, 2000);
    evRewrite_('sup', function (x) { return !(x.quarter === q && stfNormEmp_(x.ratee) === p.emp); }, [o]);
    return { ok: true, data: { saved: true } };
  });
}

// ============================================================
// 7. 設定（platform.eval-admin）
// ============================================================

function evAdminEnter_(token) {
  var c = evEnter_(token);
  if (!c.ok) return c;
  if (!c.scope.admin) return evFail_('forbidden', '只有評核管理者（預設人資總監）可以操作');
  if (!evReady_()) return evNotInited_();
  return c;
}
function evBrandOk_(b) { return EV_BRANDS.indexOf(evStr_(b)) !== -1; }

/** 建 12 張 ev_ 分頁（只補不覆蓋）、四品牌時薪與等第預設、perm_map 補預設規則。只有 role admin */
function setupEval(auth) {
  var ss = SpreadsheetApp.getActive();
  var wage = [], grade = [];
  EV_BRANDS.forEach(function (b) {
    EV_WAGE_DEFAULT.forEach(function (w, i) { wage.push([b, i + 1, w[0], w[1]]); });
    EV_GRADE_DEFAULT.forEach(function (g) { grade.push([b, g.grade, g.min, g.base]); });
  });
  Object.keys(EV_SH).forEach(function (k) {
    stfEnsureSheet_(ss, EV_SH[k], EV_H[k], k === 'wage' ? wage : (k === 'grade' ? grade : []));
  });
  return { ok: true, permAdded: evPermSeed_(auth) };
}
/** 同 StoreOps.gs storeopsPermSeed_：只補 perm_map 還沒有的同一條規則；perm 表沒初始化就略過 */
function evPermSeed_(auth) {
  var ss = SpreadsheetApp.getActive();
  var t = permReadTable_(ss, PERM_SHEET_MAP, PERM_MAP_HEADERS);
  if (t.missing || t.mismatch) return [];
  var have = {};
  t.rows.forEach(function (r) { have[[permStr_(r[1]), permStr_(r[2]), permStr_(r[3]), permStr_(r[4])].join('|')] = true; });
  var next = permAcNextId_(t.rows, 'R');
  var now = permNowText_(), by = permAuthId_(auth) || 'system';
  var rows = [], ids = [];
  EV_PERM_DEFAULT_RULES.forEach(function (r) {
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
  return ids;
}
function handleEvSetup_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return evFail_('unauthorized', sess.error);
  if (String(sess.user.role) !== 'admin') return evFail_('forbidden', '只有系統管理者可以初始化');
  try { return { ok: true, data: setupEval(sess.user) }; } catch (e) { return evFail_('bad_request', String(e && e.message || e)); }
}

/** 題庫、範本、時薪、等第一次讀（設定頁）。payload {brand} */
function handleEvBankGet_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  var b = evStr_(payload && payload.brand);
  if (!evBrandOk_(b)) return evFail_('bad_request', '品牌代碼錯誤');
  var tpls = {};
  evTplTitles_(b).forEach(function (t) { tpls[t] = evTplOf_(b, t); });
  return { ok: true, data: { brand: b, bank: evBankOf_(b), tpls: tpls, wage: evWageOf_(b), grade: evGradeOf_(b) } };
}

/** payload {brand, set, items:[{key, label, levels:[5 句，5★→1★]}]}：整組取代 */
function handleEvBankSave_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var b = evStr_(payload.brand), set = evStr_(payload.set);
  if (!evBrandOk_(b) || EV_SETS.indexOf(set) === -1) return evFail_('bad_request', '品牌或題組代碼錯誤');
  var items = payload.items;
  if (!Array.isArray(items) || !items.length || items.length > 30) return evFail_('bad_request', '題目要 1～30 題');
  var keys = {}, rows = [], now = evNowText_(), by = c.me ? c.me.emp : String(c.user.id);
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var key = evStr_(it.key), label = evStr_(it.label);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || keys[key]) return evFail_('bad_request', '第 ' + (i + 1) + ' 題代碼錯誤或重複');
    if (!label || label.length > 100) return evFail_('bad_request', '第 ' + (i + 1) + ' 題題目空白或太長');
    if (!Array.isArray(it.levels) || it.levels.length !== 5 || it.levels.some(function (s) { return evStr_(s).length > 300; })) return evFail_('bad_request', '第 ' + (i + 1) + ' 題要有 5 級星等說明');
    keys[key] = true;
    rows.push({ brand: b, set: set, ord: i + 1, key: key, label: label, levels: JSON.stringify(it.levels.map(evStr_)), active: 'TRUE', updated_at: now, updated_by: by });
  }
  return evWithLock_(function () {
    evRewrite_('bank', function (r) { return !(evStr_(r.brand) === b && evStr_(r.set) === set); }, rows);
    return { ok: true, data: { count: rows.length } };
  });
}

/** payload {brand, title, items:[{key, type:'技能'|'執行力', label, target, a,b,c,d, weight}]}；items 空＝刪掉這張範本 */
function handleEvTplSave_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var b = evStr_(payload.brand), title = evStr_(payload.title);
  if (!evBrandOk_(b) || !/^[a-z]{1,10}$/.test(title)) return evFail_('bad_request', '品牌或職稱代碼錯誤');
  var items = Array.isArray(payload.items) ? payload.items : null;
  if (!items || items.length > 20) return evFail_('bad_request', '項目要 0～20 項');
  var keys = {}, rows = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var key = evStr_(it.key), type = evStr_(it.type), w = Number(it.weight);
    if (!/^[a-z0-9_]{1,40}$/.test(key) || keys[key]) return evFail_('bad_request', '第 ' + (i + 1) + ' 項代碼錯誤或重複');
    if (type !== '技能' && type !== '執行力') return evFail_('bad_request', '第 ' + (i + 1) + ' 項類型要是技能或執行力');
    if (isNaN(w) || w < 0 || w > 70) return evFail_('bad_request', '第 ' + (i + 1) + ' 項比重錯誤');
    keys[key] = true;
    rows.push({ brand: b, title: title, ord: i + 1, key: key, type: type, label: evStr_(it.label).slice(0, 200), target: evStr_(it.target).slice(0, 200),
      a: evStr_(it.a).slice(0, 200), b: evStr_(it.b).slice(0, 200), c: evStr_(it.c).slice(0, 200), d: evStr_(it.d).slice(0, 200), weight: w });
  }
  return evWithLock_(function () {
    evRewrite_('tpl', function (r) { return !(evStr_(r.brand) === b && evStr_(r.title) === title); }, rows);
    return { ok: true, data: { count: rows.length, total: rows.reduce(function (s, r) { return s + r.weight; }, 0) } };
  });
}

/** payload {brand, rows:[[區間文字, 時薪], …]} */
function handleEvWageSave_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var b = evStr_(payload.brand);
  if (!evBrandOk_(b) || !Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 20) return evFail_('bad_request', '時薪級距格式錯誤');
  var rows = payload.rows.map(function (r, i) { return { brand: b, ord: i + 1, range_text: evStr_(r && r[0]).slice(0, 40), wage: evStr_(r && r[1]).slice(0, 20) }; });
  if (rows.some(function (r) { return !r.range_text; })) return evFail_('bad_request', '每一列都要有分數區間');
  return evWithLock_(function () { evRewrite_('wage', function (r) { return evStr_(r.brand) !== b; }, rows); return { ok: true, data: { count: rows.length } }; });
}

/** payload {brand, rows:[{grade, min, base}]}：要有一列 min=0 */
function handleEvGradeSave_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var b = evStr_(payload.brand);
  if (!evBrandOk_(b) || !Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 10) return evFail_('bad_request', '等第表格式錯誤');
  var rows = [];
  for (var i = 0; i < payload.rows.length; i++) {
    var r = payload.rows[i] || {};
    var min = Number(r.min), base = Number(r.base);
    if (!evStr_(r.grade) || isNaN(min) || min < 0 || min > 100 || isNaN(base) || base < 0 || base > 10) return evFail_('bad_request', '第 ' + (i + 1) + ' 列格式錯誤');
    rows.push({ brand: b, grade: evStr_(r.grade).slice(0, 4), min_score: min, bonus_base: base });
  }
  if (!rows.some(function (r) { return r.min_score === 0; })) return evFail_('bad_request', '要有一列最低分是 0');
  return evWithLock_(function () { evRewrite_('grade', function (r) { return evStr_(r.brand) !== b; }, rows); return { ok: true, data: { count: rows.length } }; });
}

/** 定稿：payload {unit, quarter}。把該單位該季每人的即時結果凍結進 ev_final（重按＝重新定稿） */
function handleEvFinalize_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var unit = evStr_(payload.unit), q = evStr_(payload.quarter);
  if (!c.org.unit[unit] || !evValidQuarter_(q)) return evFail_('bad_request', '單位或季度錯誤');
  if (evQuarterCmp_(q, evQuarterNow_(c.today)) > 0) return evFail_('bad_request', '還沒到的季度不能定稿');
  return evWithLock_(function () {
    var cache = evCache_();
    cache.fin = cache.fin.filter(function (r) { return !(r.quarter === q && evStr_(r.unit) === unit); });   // 重新定稿：以即時值為準
    var now = evNowText_(), by = c.me ? c.me.emp : String(c.user.id);
    var rows = [], skipped = [];
    c.people.filter(function (p) { return p.unit === unit && evEvaluable_(p, c.org); }).forEach(function (p) {
      var r = evPersonQuarter_(c, p, q, cache);
      if (!r) return;
      if (r.source === 'live' && r.kind === 'ft' && r.agg.performance === null) { skipped.push(p.name); return; }   // 正職 KPI 沒評完不鎖（同舊站）
      rows.push({ quarter: q, unit: unit, emp_no: p.emp, kind: r.kind, result: JSON.stringify(evFreeze_(r)), by: by, at: now });
    });
    evRewrite_('fin', function (r) { return !(r.quarter === q && evStr_(r.unit) === unit); }, rows);
    return { ok: true, data: { count: rows.length, skipped: skipped } };
  });
}
function handleEvUnfinalize_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var unit = evStr_(payload.unit), q = evStr_(payload.quarter);
  if (!c.org.unit[unit] || !evValidQuarter_(q)) return evFail_('bad_request', '單位或季度錯誤');
  return evWithLock_(function () {
    evRewrite_('fin', function (r) { return !(r.quarter === q && evStr_(r.unit) === unit); });
    return { ok: true, data: { done: true } };
  });
}

/** 舊成績匯入第一步：瀏覽器送姓名清單＋單位，回同名同仁的編號（同名多人全列，由人選）。payload {unit, names:[…]} */
function handleEvImportPreview_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  payload = payload || {};
  var unit = evStr_(payload.unit);
  var names = Array.isArray(payload.names) ? payload.names.slice(0, 200).map(evStr_) : [];
  return { ok: true, data: { matches: names.map(function (n) {
    var hits = c.people.filter(function (p) { return p.name === n && evBrandOk_(p.brand); })
      .map(function (p) { return { emp: p.emp, unit: p.unit, unitName: (c.org.unit[p.unit] || {}).name || p.unit, sameUnit: p.unit === unit }; });
    return { name: n, hits: hits };
  }) } };
}
/** 第二步：payload {rows:[{quarter, emp, kind, result:{attitude, performance, adjAtt, adjPerf, total, attItems?, perfItems?, attLabels?, perfLabels?}}]}；同季同人取代 */
function handleEvImportCommit_(token, payload) {
  var c = evAdminEnter_(token);
  if (!c.ok) return c;
  var list = payload && payload.rows;
  if (!Array.isArray(list) || !list.length || list.length > 2000) return evFail_('bad_request', '沒有要匯入的資料');
  var rows = [], now = evNowText_(), by = c.me ? c.me.emp : String(c.user.id), keyset = {};
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var p = c.byEmp[stfNormEmp_(r.emp)];
    if (!p || !evValidQuarter_(r.quarter) || (r.kind !== 'pt' && r.kind !== 'ft') || !r.result || typeof r.result !== 'object') return evFail_('bad_request', '第 ' + (i + 1) + ' 筆格式錯誤');
    var res = r.result;
    var tot = Number(res.total);
    if (isNaN(tot) || tot < 0 || tot > 100) return evFail_('bad_request', '第 ' + (i + 1) + ' 筆總分錯誤');
    var g = evGradeFor_(tot, evGradeOf_(p.brand));
    var frozen = { attitude: res.attitude === null ? null : Number(res.attitude), performance: res.performance === null || res.performance === undefined ? null : Number(res.performance),
      adjAtt: Number(res.adjAtt) || 0, adjPerf: Number(res.adjPerf) || 0, total: tot, grade: g ? g.grade : null, bonusBase: g ? g.base : null,
      wageIdx: evWageTierIndex_(evWageOf_(p.brand), tot), attItems: res.attItems || null, perfItems: res.perfItems || null,
      attLabels: res.attLabels || [], perfLabels: res.perfLabels || [] };
    frozen.subtotal = frozen.attitude === null ? null : evRound1_(frozen.attitude + (frozen.performance || 0));
    keyset[r.quarter + '|' + p.emp] = true;
    rows.push({ quarter: r.quarter, emp_no: p.emp, kind: r.kind, result: JSON.stringify(frozen), src: 'mala-eval', by: by, at: now });
  }
  return evWithLock_(function () {
    evRewrite_('hist', function (x) { return !keyset[x.quarter + '|' + stfNormEmp_(x.emp_no)]; }, rows);
    return { ok: true, data: { count: rows.length } };
  });
}
