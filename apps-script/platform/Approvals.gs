/**
 * 鼎兆元管理系統｜第三期表單簽核 — 資料表、action handler、jobs 專用全域函式
 * 正本規格：docs/approvals/spec.md（§14 設計審修正優先）＋ api.md（每支 action 的形狀）＋ plan.md（共用契約）。
 *
 * 依賴：Auth.gs（authResolveSession_／hasPerm_／readUsersRows_）、Staff.gs（org／staff 讀寫小工具）、ApprovalRoute.gs（路線、金額）。
 * 規則：
 *  - 每支 handler 自己驗 token（authResolveSession_，每次重查 active）；寫入類 action 由 Code.gs 的 MUTATING_ACTIONS 統一拿全域鎖。
 *  - 改單的 action 必帶 rev（改步驟的另帶 step），不符一律 conflict（spec §14.2）。
 *  - 失敗統一 {ok:false, error:'<代碼>', message:'<中文>'}（api.md）。
 *  - 檔案（照片、簽名）不進資料表，apv_files 只記帳；jobs 專用全域函式（結尾 _ 且不在 Code.gs 分派表）見檔尾。
 * ⚠ 本檔與 repo 任何地方都不得出現真實同仁資料（dzy 是 public repo）；events 的 note 不寫個資。
 */

var APV_SHEET_FORMS = 'apv_forms';
var APV_SHEET_EVENTS = 'apv_events';
var APV_SHEET_FILES = 'apv_files';
var APV_SHEET_THR = 'apv_thresholds';
var APV_SHEET_THRLOG = 'apv_threshold_log';
var APV_SHEET_REVS = 'apv_revisions';

var APV_FORM_HEADERS = ['id', 'type', 'status', 'sender', 'unit', 'subject', 'amount', 'body_json', 'route_json', 'step', 'step_at',
  'handler_dept', 'created_at', 'updated_at', 'rev', 'client_id'];
var APV_EVENT_HEADERS = ['at', 'form_id', 'rev', 'actor', 'action', 'note', 'sha256'];
var APV_FILE_HEADERS = ['id', 'owner', 'form_id', 'path', 'bytes', 'sha256', 'created_at', 'kind', 'state', 'seq', 'rev', 'deleting_at'];
var APV_THR_HEADERS = ['form_type', 'seq', 'max_amount', 'store_role', 'hq_role', 'ver'];
var APV_THRLOG_HEADERS = ['at', 'actor', 'form_type', 'before_json', 'after_json'];
var APV_REV_HEADERS = ['form_id', 'rev', 'at', 'body_json', 'amount', 'files_json', 'route_json', 'thr_ver', 'sha256'];

var APV_THR_DEFAULT = [
  ['spend', 1, 5000, 'head', 'head', 1],
  ['spend', 2, 10000, 'brand_dir', 'head', 1],
  ['spend', 3, 30000, 'gm', 'gm', 1],
  ['spend', 4, '', 'chair', 'chair', 1]
];

var APV_CATEGORIES = ['repair', 'food', 'misc', 'transport', 'supplies', 'other'];
var APV_CATEGORY_NAME = { repair: '設備維修', food: '食材臨時採購', misc: '雜支', transport: '交通', supplies: '文具耗材', other: '其他' };
var APV_TYPE_NAME = { purchase: '請購', expense: '請款', personnel: '人事異動' };
var APV_FILE_LIMIT = { receipt: 180 * 1024, sign: 100 * 1024 };
var APV_FILE_DAILY_QUOTA = 60;
var APV_FILE_MAX_PER_FORM = 5;
var APV_FILE_ID_RE = /^F[0-9A-Z]{8,24}$/;
var APV_LIST_MAX = 200;
var APV_DIGEST_MAX = 1000;
var APV_NOTE_MAX = 200;
var APV_ACTIVE_STATUSES = ['signing', 'handling', 'exception'];

// ============================================================
// 1. 小工具
// ============================================================

function apvFail_(error, message) { return { ok: false, error: error, message: message || '' }; }
function apvForbidden_(message) { return apvFail_('forbidden', message || '沒有權限'); }
function apvNow_() { return Date.now(); }
function apvStr_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function apvNum_(v) { return (v === '' || v === undefined || v === null) ? null : Number(v); }

function apvCols_(headers) {
  var m = {};
  headers.forEach(function (h, i) { m[h] = i; });
  return m;
}

/** 台北時間（UTC+8）拆欄；不靠 Utilities／執行環境時區，好測 */
function apvTaipei_(ms) {
  var t = new Date(ms + 8 * 60 * 60 * 1000);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var y = t.getUTCFullYear();
  return { y: y, m: pad(t.getUTCMonth() + 1), d: pad(t.getUTCDate()), yy: pad(y % 100) };
}
function apvYmd6_(ms) { var t = apvTaipei_(ms); return t.yy + t.m + t.d; }
function apvYmd8_(ms) { var t = apvTaipei_(ms); return t.y + t.m + t.d; }
function apvMonth_(ms) { var t = apvTaipei_(ms); return t.y + '-' + t.m; }

function apvDateOk_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100) return false;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 文字欄：必須是字串，trim 後長度在 min..max；否則回 null */
function apvText_(v, min, max) {
  if (typeof v !== 'string') return null;
  var s = v.trim();
  if (s.length < min || s.length > max) return null;
  return s;
}

function apvSha256Hex_(text) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  var hex = '';
  for (var i = 0; i < d.length; i++) hex += ((d[i] + 256) % 256 + 256).toString(16).slice(1);
  return hex;
}

/** 這一版的證據雜湊（spec §14.1）：body_json＋amount＋files_json */
function apvRevHash_(bodyJson, amount, filesJson) {
  return apvSha256Hex_(bodyJson + '|' + (amount === null || amount === undefined ? '' : amount) + '|' + filesJson);
}

function apvParseJson_(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// ---- 試算表讀寫（沿用 Staff.gs 的純文字寫入，避免公式注入）----

function apvRows_(name, headers) {
  var cols = apvCols_(headers);
  return stfReadRows_(name, headers.length).map(function (v, i) {
    var o = {};
    Object.keys(cols).forEach(function (h) { o[h] = v[cols[h]]; });
    return { row: i + 2, o: o };
  });
}
function apvPutRow_(name, headers, rowNumber, o) {
  stfWriteRow_(name, rowNumber, headers.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; }), headers.length);
}
function apvAppendObj_(name, headers, o) {
  stfAppendRow_(name, headers.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; }), headers.length);
}

// ---- 單據 ----

function apvParseForm_(o) {
  var f = {};
  APV_FORM_HEADERS.forEach(function (h) { f[h] = o[h]; });
  f.id = apvStr_(f.id);
  f.type = apvStr_(f.type);
  f.status = apvStr_(f.status);
  f.sender = apvStr_(f.sender).toUpperCase();
  f.subject = apvStr_(f.subject).toUpperCase();
  f.unit = apvStr_(f.unit);
  f.handler_dept = apvStr_(f.handler_dept);
  f.client_id = apvStr_(f.client_id);
  f.amount = apvNum_(f.amount);
  f.step = apvNum_(f.step);
  f.step_at = Number(f.step_at) || 0;
  f.created_at = Number(f.created_at) || 0;
  f.updated_at = Number(f.updated_at) || 0;
  f.rev = Number(f.rev) || 1;
  f.route = apvParseJson_(f.route_json, { v: 1, steps: [] });
  return f;
}
function apvBodyOf_(f) { return apvParseJson_(f.body_json, {}); }

function apvReadForms_() {
  return apvRows_(APV_SHEET_FORMS, APV_FORM_HEADERS).map(function (r) { return { row: r.row, f: apvParseForm_(r.o) }; })
    .filter(function (r) { return r.f.id !== ''; });
}
function apvFindForm_(id) {
  var list = apvReadForms_();
  for (var i = 0; i < list.length; i++) if (list[i].f.id === id) return list[i];
  return null;
}
function apvSaveForm_(fr) {
  var f = fr.f;
  f.route_json = JSON.stringify(f.route);
  apvPutRow_(APV_SHEET_FORMS, APV_FORM_HEADERS, fr.row, f);
}

function apvAddEvent_(f, actor, action, note, sha, at) {
  apvAppendObj_(APV_SHEET_EVENTS, APV_EVENT_HEADERS, { at: at || apvNow_(), form_id: f.id, rev: f.rev, actor: actor, action: action, note: note || '', sha256: sha || '' });
}
function apvReadEvents_(formId) {
  var out = [];
  apvRows_(APV_SHEET_EVENTS, APV_EVENT_HEADERS).forEach(function (r) {
    if (!formId || apvStr_(r.o.form_id) === formId) {
      out.push({ at: Number(r.o.at) || 0, form_id: apvStr_(r.o.form_id), rev: Number(r.o.rev) || 0, actor: apvStr_(r.o.actor), action: apvStr_(r.o.action), note: apvStr_(r.o.note), sha256: apvStr_(r.o.sha256) });
    }
  });
  return out;
}
function apvReadRevisions_(formId) {
  return apvRows_(APV_SHEET_REVS, APV_REV_HEADERS).filter(function (r) { return apvStr_(r.o.form_id) === formId; })
    .map(function (r) { return { rev: Number(r.o.rev) || 0, at: Number(r.o.at) || 0, sha256: apvStr_(r.o.sha256) }; });
}
function apvCurrentSha_(f) {
  var revs = apvReadRevisions_(f.id);
  for (var i = 0; i < revs.length; i++) if (revs[i].rev === f.rev) return revs[i].sha256;
  return '';
}

// ---- 核決權限表 ----

function apvReadTable_() {
  if (!stfSheet_(APV_SHEET_THR)) return null;
  var rows = apvRows_(APV_SHEET_THR, APV_THR_HEADERS).filter(function (r) { return apvStr_(r.o.form_type) === 'spend'; });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return Number(a.o.seq) - Number(b.o.seq); });
  return {
    ver: Number(rows[0].o.ver) || 0,
    rows: rows.map(function (r) {
      return { seq: Number(r.o.seq), max: apvNum_(r.o.max_amount), store_role: apvStr_(r.o.store_role), hq_role: apvStr_(r.o.hq_role) };
    })
  };
}

// ---- 檔案帳 ----

function apvReadFiles_() {
  return apvRows_(APV_SHEET_FILES, APV_FILE_HEADERS).map(function (r) {
    var o = r.o;
    return { row: r.row, o: { id: apvStr_(o.id), owner: apvStr_(o.owner).toUpperCase(), form_id: apvStr_(o.form_id), path: apvStr_(o.path), bytes: Number(o.bytes) || 0,
      sha256: apvStr_(o.sha256), created_at: Number(o.created_at) || 0, kind: apvStr_(o.kind), state: apvStr_(o.state), seq: Number(o.seq) || 0, rev: apvNum_(o.rev), deleting_at: Number(o.deleting_at) || 0 } };
  }).filter(function (r) { return r.o.id !== ''; });
}
function apvSaveFile_(fr) { apvPutRow_(APV_SHEET_FILES, APV_FILE_HEADERS, fr.row, fr.o); }

/**
 * 綁定前檢查（spec §14.9）：擁有者＝本人、種類相符、狀態 uploaded（重送時允許「已綁在同一張單」的舊檔）。
 * 回 {ok:true, items} 或 {ok:false,...}；不寫入。
 */
function apvCheckFiles_(ids, owner, kind, formId) {
  var all = apvReadFiles_();
  var items = [];
  for (var i = 0; i < ids.length; i++) {
    var hit = null;
    for (var j = 0; j < all.length; j++) if (all[j].o.id === ids[i]) { hit = all[j]; break; }
    if (!hit) return apvFail_('file_invalid', '找不到檔案 ' + ids[i]);
    if (hit.o.owner !== owner) return apvFail_('file_invalid', '檔案不是你上傳的');
    if (hit.o.kind !== kind) return apvFail_('file_invalid', '檔案種類不符');
    var reusable = hit.o.state === 'bound' && formId !== '' && hit.o.form_id === formId;
    if (hit.o.state !== 'uploaded' && !reusable) return apvFail_('file_invalid', '檔案已使用或已失效');
    items.push(hit);
  }
  return { ok: true, items: items };
}
function apvBindFiles_(items, formId, rev) {
  items.forEach(function (fr) { fr.o.state = 'bound'; fr.o.form_id = formId; fr.o.rev = rev; apvSaveFile_(fr); });
}
function apvFilesOfForm_(allFiles, f) {
  return allFiles.filter(function (x) { return x.o.form_id === f.id && x.o.state === 'bound' && x.o.rev === f.rev; })
    .map(function (x) { return { id: x.o.id, kind: x.o.kind, bytes: x.o.bytes }; });
}

/** 檔案 id 陣列：去重、格式、數量。回陣列或 null */
function apvFileIds_(v, max) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || !APV_FILE_ID_RE.test(v[i])) return null;
    if (out.indexOf(v[i]) === -1) out.push(v[i]);
  }
  return out;
}

// ============================================================
// 2. 進場：驗身分＋讀組織／人員目錄
// ============================================================

/** 讀組織與人員目錄（沒有登入者也能用：摘要、對帳） */
function apvDirectory_() {
  var org = stfReadOrg_();
  var extra = stfReadExtraMap_();
  var uact = {};
  readUsersRows_().forEach(function (r) { uact[String(r[AUTH_USERS_COL.id])] = isActiveValue_(r[AUTH_USERS_COL.active]); });
  var people = stfAllRows_().map(function (r) {
    var emp = stfNormEmp_(r.values[STF_COL.emp_no]);
    return apvPerson_(r.values, org, stfSplitCodes_(extra[emp]), uact[stfStr_(r.values[STF_COL.user_id])] === true);
  });
  var byEmp = {};
  people.forEach(function (p) { byEmp[p.emp] = p; });
  return { org: org, people: people, byEmp: byEmp };
}

/**
 * 驗 token 並建好本次請求的脈絡。失敗回 {ok:false,...}；成功回
 * {ok:true, user, perms, isStaffPerm, isAdmin, org, people, byEmp, me, actor, now}（me＝本人的 staff 列，沒有就是 null）
 */
function apvEnter_(token) {
  var sess = authResolveSession_(token);
  if (!sess.ok) return apvFail_('unauthorized', sess.error);
  var d = apvDirectory_();
  var me = null;
  d.people.forEach(function (p) { if (p.uid !== '' && p.uid === String(sess.user.id)) me = p; });
  return {
    ok: true, user: sess.user, perms: sess.perms,
    isStaffPerm: hasPerm_(sess.perms, 'platform.staff'),
    isAdmin: String(sess.user.role) === 'admin',
    org: d.org, people: d.people, byEmp: d.byEmp, me: me,
    actor: me ? me.emp : String(sess.user.id),
    now: apvNow_()
  };
}

function apvName_(c, emp) {
  if (emp === 'system') return '系統';
  var p = c.byEmp[emp];
  return p ? p.name : emp;
}
function apvUnitName_(c, unit) { return c.org.unit[unit] ? c.org.unit[unit].name : unit; }

/** 路線計算用的脈絡：送件人（與人事單的對象）永遠不能簽自己的單 */
function apvRCtx_(c, f) {
  var ex = [f.sender];
  if (f.subject) ex.push(f.subject);
  return { org: c.org, people: c.people, byEmp: c.byEmp, exclude: ex };
}

/** signing 的單懶式重解（spec §14.5）：只在記憶體裡算，回 apvAdvance_ 結果；非 signing 回 null */
function apvEffOf_(c, f) {
  if (f.status !== 'signing') return null;
  return apvAdvance_(f.route, apvRCtx_(c, f));
}

function apvRoleLabel_(role) { return APV_ROLE_LABEL[role] || role; }

/** 把懶式重解結果寫回（寫 skip 事件、更新路線與指標）。只在鎖內的 action／jobs 呼叫 */
function apvPersistEff_(c, fr, eff, now) {
  var f = fr.f;
  eff.skips.forEach(function (s) {
    apvAddEvent_(f, 'system', 'skip', apvRoleLabel_(s.role) + (s.next ? ' 找不到合格的人，改找' + apvRoleLabel_(s.next) : ' 找不到合格的人，已無更高一級'), '', now);
  });
  f.route = eff.route;
  f.status = eff.status;
  f.step = eff.status === 'handling' ? null : eff.index;
  f.step_at = now;
  f.updated_at = now;
  apvSaveForm_(fr);
}
function apvEffChanged_(f, eff) {
  return !!eff && (eff.skips.length > 0 || eff.status !== f.status || (eff.status !== 'handling' && eff.index !== f.step));
}

// ============================================================
// 3. 看得到什麼、能做什麼（spec §14.7）
// ============================================================

function apvIsHandlerOf_(c, f) { return !!c.me && apvIsHandler_(c.me, f.handler_dept); }

/** 本人在這張單上有沒有「簽過」的紀錄（路線快照＋事件） */
function apvSignedBefore_(c, f, events) {
  if (!c.me) return false;
  var emp = c.me.emp;
  var steps = (f.route && f.route.steps) || [];
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].by === emp || steps[i].rej === emp) return true;
    if (steps[i].override && steps[i].override.to === emp) return true;
  }
  for (var j = 0; j < events.length; j++) {
    if (events[j].actor === emp && ['approve', 'reject', 'sign', 'handle'].indexOf(events[j].action) !== -1) return true;
  }
  return false;
}

function apvCanView_(c, f, eff, events) {
  if (c.isStaffPerm || c.isAdmin) return true;
  if (!c.me) return false;
  if (f.sender === c.me.emp) return true;
  if (apvIsHandlerOf_(c, f) && (f.status === 'handling' || f.status === 'done')) return true;
  if (eff && eff.candidates.some(function (p) { return p.emp === c.me.emp; })) return true;
  return apvSignedBefore_(c, f, events || []);
}

/**
 * 寫入類 action 專用：這個人是不是這張單「走過的關」的候選人（單已前進、他晚一步按核准時要拿到 conflict 而不是 not_found）。
 * signing 中看目前這關「之前」的關，以及目前這關被改派前的原候選人；單已不在簽核中（退回、撤回、承辦…）看路線上所有的關。
 * 候選人一律不看改派（override）：被改派掉的人晚一步按也拿到 conflict／forbidden，不是 not_found。
 */
function apvWasInRoute_(c, f, eff) {
  if (!c.me) return false;
  var steps = (f.route && f.route.steps) || [];
  var rc = apvRCtx_(c, f);
  var limit = eff ? eff.index + 1 : steps.length;
  for (var i = 0; i < steps.length && i < limit; i++) {
    var st = steps[i];
    if (i === limit - 1 && eff && !st.override) continue;   // 目前這關沒改派：候選人本來就看得到
    var plain = JSON.parse(JSON.stringify(st));
    delete plain.override;
    if (apvCandidates_(plain, rc).some(function (p) { return p.emp === c.me.emp; })) return true;
  }
  return false;
}

function apvHasDoneStep_(route) {
  return (route.steps || []).some(function (s) { return s.status === 'done' && s.role !== 'self_sign'; });
}

/** 前端按鈕用的旗標（伺服器算好；每支 action 仍各自重驗） */
function apvCan_(c, f, status, route, index, cands) {
  var meEmp = c.me ? c.me.emp : '';
  var inCands = !!meEmp && cands.some(function (p) { return p.emp === meEmp; });
  var step = (index !== null && index >= 0) ? route.steps[index] : null;
  var selfSign = !!step && step.role === 'self_sign';
  return {
    decide: status === 'signing' && inCands && !selfSign,
    sign: status === 'signing' && inCands && selfSign,
    resubmit: status === 'rejected' && f.sender === meEmp,
    withdraw: status === 'signing' && f.sender === meEmp && !apvHasDoneStep_(route),
    handle: status === 'handling' && apvIsHandlerOf_(c, f),
    reassign: (status === 'signing' || status === 'exception') && c.isStaffPerm,
    void: status !== 'done' && status !== 'voided' && (c.isStaffPerm || c.isAdmin)
  };
}

function apvIsStuck_(status, stepAt, now) {
  if (status === 'exception') return true;
  return (status === 'signing' || status === 'handling') && stepAt > 0 && now - stepAt >= APV_STUCK_MS;
}

/** api.md 的 Form。eff＝懶式重解結果（signing 才有）；opts.body／opts.candidates／files */
function apvFormView_(c, f, eff, allFiles, opts) {
  opts = opts || {};
  var route = eff ? eff.route : f.route;
  var status = eff ? eff.status : f.status;
  var index = eff ? (eff.status === 'handling' ? null : eff.index) : f.step;
  var cands = eff ? eff.candidates : [];
  var view = {
    id: f.id, type: f.type, status: status, rev: f.rev, step: index,
    sender: { emp: f.sender, name: apvName_(c, f.sender), unit_name: apvUnitName_(c, f.unit) },
    amount: f.amount,
    files: apvFilesOfForm_(allFiles, f),
    route: route,
    handler_dept: f.handler_dept,
    created_at: f.created_at, updated_at: f.updated_at,
    stuck: apvIsStuck_(status, f.step_at, c.now),
    can: apvCan_(c, f, status, route, index, cands)
  };
  if (f.subject) view.subject = { emp: f.subject, name: apvName_(c, f.subject) };
  if (opts.body) view.body = apvBodyOf_(f);
  if (opts.candidates) {
    view.route = JSON.parse(JSON.stringify(route));
    apvAttachCandidates_(view.route, apvRCtx_(c, f));
  }
  return view;
}

// ============================================================
// 4. 建表（手動在編輯器執行一次 setupApprovals，可重跑；只補不覆蓋）
// ============================================================

/** 舊表（11 欄、沒有 deleting_at）：表頭剛好是舊版才補第 12 欄表頭，資料不動；其他不一致照舊讓 stfEnsureSheet_ 停下 */
function apvMigrateFilesHeader_(ss) {
  var sh = ss.getSheetByName(APV_SHEET_FILES);
  if (!sh) return;
  var n = APV_FILE_HEADERS.length - 1;
  var cur = sh.getRange(1, 1, 1, APV_FILE_HEADERS.length).getValues()[0].map(function (v) { return String(v).trim(); });
  if (cur.slice(0, n).join('|') === APV_FILE_HEADERS.slice(0, n).join('|') && cur[n] === '') {
    sh.getRange(1, n + 1, 1, 1).setValues([[APV_FILE_HEADERS[n]]]);
  }
}

function setupApprovals() {
  var ss = SpreadsheetApp.getActive();
  var org = stfReadOrg_();
  ['purchase', 'fin', 'hr'].forEach(function (code) {
    if (!org.dept[code] || !org.dept[code].active) throw new Error('承辦部門「' + code + '」不在 org 或已停用，停止初始化');
  });
  stfEnsureSheet_(ss, APV_SHEET_FORMS, APV_FORM_HEADERS, []);
  stfEnsureSheet_(ss, APV_SHEET_EVENTS, APV_EVENT_HEADERS, []);
  apvMigrateFilesHeader_(ss);
  stfEnsureSheet_(ss, APV_SHEET_FILES, APV_FILE_HEADERS, []);
  stfEnsureSheet_(ss, APV_SHEET_THR, APV_THR_HEADERS, APV_THR_DEFAULT);
  stfEnsureSheet_(ss, APV_SHEET_THRLOG, APV_THRLOG_HEADERS, []);
  stfEnsureSheet_(ss, APV_SHEET_REVS, APV_REV_HEADERS, []);
  return { ok: true };
}

/** action apvSetup：只有 role admin；呼叫 setupApprovals（只補不覆蓋，重按無害）。讓上線時不必在 mini 下指令。 */
function handleApvSetup_(token) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!c.isAdmin) return apvForbidden_('只有系統管理者可以初始化');
  try { setupApprovals(); } catch (e) { return apvFail_('bad_request', String(e && e.message || e)); }
  return { ok: true, data: { inited: true } };
}

/** 沒建表 → 讀寫都回 not_inited（不自動建表；建表只有 setupApprovals） */
function apvReady_() {
  return !!(stfSheet_(APV_SHEET_FORMS) && stfSheet_(APV_SHEET_EVENTS) && stfSheet_(APV_SHEET_FILES) && stfSheet_(APV_SHEET_THR) && stfSheet_(APV_SHEET_REVS));
}
function apvNotInited_() { return apvFail_('not_inited', '表單簽核還沒初始化，請系統管理者先執行 setupApprovals'); }

// ============================================================
// 5. 核決權限表 get／save
// ============================================================

function apvThrRowView_(r) { return { seq: r.seq, max: r.max, store_role: r.store_role, hq_role: r.hq_role }; }

function handleApvThresholdGet_(token) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  if (!(c.me && c.me.opened) && !c.isAdmin && !c.isStaffPerm) return apvForbidden_();
  var t = apvReadTable_();
  if (!t) return apvNotInited_();
  return { ok: true, data: { ver: t.ver, rows: t.rows.map(apvThrRowView_) } };
}

function handleApvThresholdSave_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!c.isAdmin) return apvForbidden_('只有系統管理者可以修改核決權限');   // 只認 role admin（不是 '*' 權限）
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  if (typeof payload.expected_ver !== 'number' || !Array.isArray(payload.rows)) return apvFail_('bad_request', '缺少 expected_ver 或 rows');
  var cur = apvReadTable_();
  if (!cur) return apvNotInited_();
  var rows = [];
  for (var i = 0; i < payload.rows.length; i++) {
    var r = payload.rows[i];
    if (!r || typeof r !== 'object') return apvFail_('bad_request', '第 ' + (i + 1) + ' 列格式錯誤');
    rows.push({ seq: i + 1, max: apvOpenMax_(r.max) ? null : r.max, store_role: r.store_role, hq_role: r.hq_role });
  }
  var v = apvValidateTable_(rows);
  if (!v.ok) return apvFail_('bad_request', v.error);
  if (cur.ver !== payload.expected_ver) return apvFail_('conflict', '核決權限剛被別人改過，請重新整理再改');
  var ver = cur.ver + 1;
  var diff = [];
  var n = Math.max(cur.rows.length, rows.length);
  for (var k = 0; k < n; k++) {
    var before = cur.rows[k] ? apvThrRowView_(cur.rows[k]) : null;
    var after = rows[k] ? apvThrRowView_(rows[k]) : null;
    if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({ seq: k + 1, before: before, after: after });
  }
  var existing = apvRows_(APV_SHEET_THR, APV_THR_HEADERS);
  var sheetRows = existing.map(function (x) { return x.row; });
  var total = Math.max(n, sheetRows.length);
  for (var w = 0; w < total; w++) {
    var rowNo = w < sheetRows.length ? sheetRows[w] : stfSheet_(APV_SHEET_THR).getLastRow() + 1;
    if (w < rows.length) {
      apvPutRow_(APV_SHEET_THR, APV_THR_HEADERS, rowNo, { form_type: 'spend', seq: rows[w].seq, max_amount: rows[w].max === null ? '' : rows[w].max,
        store_role: rows[w].store_role, hq_role: rows[w].hq_role, ver: ver });
    } else {
      apvPutRow_(APV_SHEET_THR, APV_THR_HEADERS, rowNo, {});   // 刪掉的列清空（form_type 空＝不讀）
    }
  }
  if (stfSheet_(APV_SHEET_THRLOG)) {
    apvAppendObj_(APV_SHEET_THRLOG, APV_THRLOG_HEADERS, { at: c.now, actor: c.actor, form_type: 'spend',
      before_json: JSON.stringify(cur.rows.map(apvThrRowView_)), after_json: JSON.stringify(rows.map(apvThrRowView_)) });
  }
  return { ok: true, data: { ver: ver, diff: diff } };
}

// ============================================================
// 6. 送出、退回再送、撤回、預覽
// ============================================================

/**
 * 驗 body、算金額、挑出要綁的檔案。回
 * {ok:true, body, amount, subject, kind, fileGroups:[{ids, kind}]} 或 {ok:false,...}
 * existing＝再送時原本那張單（id 排除、subject 固定用它的）
 */
function apvNormalize_(c, type, rawBody, rawFiles, rawSubject, forms, existing) {
  var b = rawBody;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return apvFail_('bad_request', 'body 格式錯誤');
  var bad = function (field) { return apvFail_('bad_request', '欄位「' + field + '」格式錯誤或沒填'); };
  if (type === 'purchase') {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) return bad('items');
    var items = [];
    for (var i = 0; i < b.items.length; i++) {
      var it = b.items[i];
      if (!it || typeof it !== 'object') return bad('items');
      var nm = apvText_(it.name, 1, 60), un = apvText_(it.unit, 1, 10);
      if (nm === null) return bad('items.name');
      if (un === null) return bad('items.unit');
      items.push({ name: nm, qty: it.qty, unit: un, price: it.price });
    }
    var vendor = b.vendor === undefined || b.vendor === '' || b.vendor === null ? '' : apvText_(b.vendor, 0, 60);
    var purpose = apvText_(b.purpose, 1, 200);
    if (vendor === null) return bad('vendor');
    if (purpose === null) return bad('purpose');
    if (typeof b.need_date !== 'string' || !apvDateOk_(b.need_date)) return bad('need_date');
    var calc = apvCalcAmount_('purchase', { items: items });
    if (!calc.ok) return apvFail_(calc.error, calc.error === 'bad_amount' ? '金額不合法（數量、單價要是正數且在範圍內）' : 'items 格式錯誤');
    var pf = apvFileIds_(rawFiles, APV_FILE_MAX_PER_FORM);
    if (pf === null) return apvFail_('file_invalid', '照片最多 5 張，檔號格式要正確');
    return { ok: true, body: { items: items, vendor: vendor, purpose: purpose, need_date: b.need_date }, amount: calc.amount, subject: null, kind: '', fileGroups: [{ ids: pf, kind: 'receipt' }] };
  }
  if (type === 'expense') {
    if (typeof b.spend_date !== 'string' || !apvDateOk_(b.spend_date)) return bad('spend_date');
    if (APV_CATEGORIES.indexOf(b.category) === -1) return bad('category');
    var desc = apvText_(b.desc, 1, 200);
    if (desc === null) return bad('desc');
    if (b.payee !== 'self' && b.payee !== 'vendor') return bad('payee');
    var vname = '';
    if (b.payee === 'vendor') { vname = apvText_(b.vendor_name, 1, 60); if (vname === null) return bad('vendor_name'); }
    var ec = apvCalcAmount_('expense', { amount: b.amount });
    if (!ec.ok) return apvFail_(ec.error, '金額要是 1～10,000,000 的整數元');
    var purchaseId = '';
    if (b.purchase_id !== undefined && b.purchase_id !== null && b.purchase_id !== '') {
      purchaseId = apvText_(b.purchase_id, 1, 30);
      var ok = false;
      if (purchaseId !== null) {
        for (var j = 0; j < forms.length; j++) {
          var pf0 = forms[j].f;
          if (pf0.id === purchaseId && pf0.type === 'purchase' && pf0.status === 'done' && pf0.unit === c.me.unit) ok = true;
        }
      }
      if (!ok) return apvFail_('bad_request', '對應的請購單必須是自己單位已結案的請購單');
    }
    var ef = apvFileIds_(rawFiles, APV_FILE_MAX_PER_FORM);
    if (ef === null) return apvFail_('file_invalid', '收據最多 5 張，檔號格式要正確');
    if (ef.length < 1) return apvFail_('no_files', '請款單至少要附一張收據');
    var eb = { spend_date: b.spend_date, category: b.category, amount: ec.amount, desc: desc, payee: b.payee };
    if (vname) eb.vendor_name = vname;
    if (purchaseId) eb.purchase_id = purchaseId;
    return { ok: true, body: eb, amount: ec.amount, subject: null, kind: '', fileGroups: [{ ids: ef, kind: 'receipt' }] };
  }
  if (type === 'personnel') {
    var kind = b.kind;
    if (['leave', 'transfer', 'raise'].indexOf(kind) === -1) return bad('kind');
    // 前端「本人送離職」不帶 subject（前端不知道自己的 DZY 編號）→ 空的視為送件人本人
    var subj = apvFindPerson_(c, existing ? existing.subject : (apvStr_(rawSubject) ? rawSubject : c.me.emp));
    if (!subj || ['unclaimed', 'pending', 'active'].indexOf(subj.status) === -1) return apvFail_('bad_request', '找不到這位對象同仁');
    if (typeof b.effective !== 'string' || !apvDateOk_(b.effective)) return bad('effective');
    var reason = apvText_(b.reason, 1, 200);
    if (reason === null) return bad('reason');
    var fromO = b.from && typeof b.from === 'object' ? b.from : null;
    var toO = b.to && typeof b.to === 'object' ? b.to : {};
    if (!fromO) return bad('from');
    var cleanSide = function (s, isTo) {
      var o = {};
      ['unit', 'title'].forEach(function (k) {
        if (s[k] !== undefined && s[k] !== null && s[k] !== '') { var t = apvText_(s[k], 1, 40); if (t === null) o = null; else if (o) o[k] = t; }
      });
      if (o === null) return null;
      if (s.pay !== undefined && s.pay !== null && s.pay !== '') {
        if (typeof s.pay !== 'number' || !isFinite(s.pay) || s.pay < 0 || s.pay > 10000000) return null;
        o.pay = s.pay;
      }
      return o;
    };
    var from = cleanSide(fromO, false), to = cleanSide(toO, true);
    if (from === null) return bad('from');
    if (to === null) return bad('to');
    if (kind === 'raise' && typeof to.pay !== 'number') return bad('to.pay');
    if (kind === 'transfer') {
      var tu = to.unit && c.org.unit[to.unit];
      if (!tu || !tu.active) return apvFail_('bad_request', '調動後的單位必須是啟用中的單位');
    }
    var pb = { kind: kind, effective: b.effective, from: from, to: to, reason: reason };
    var groups = [];
    var self = c.me.emp === subj.emp;
    if (kind === 'leave') {
      if (self) {
        if (typeof b.sign_file !== 'string' || !APV_FILE_ID_RE.test(b.sign_file)) return apvFail_('file_invalid', '離職單本人要簽名');
        pb.sign_file = b.sign_file;
        groups.push({ ids: [b.sign_file], kind: 'sign' });
      } else if (subj.opened) {
        // 已開通的對象要本人線上簽名；帶了紙本照不默默忽略（照片會變孤兒、使用者以為已附）
        if (Array.isArray(b.paper_files) ? b.paper_files.length > 0 : (b.paper_files !== undefined && b.paper_files !== null)) return apvFail_('bad_request', '對象已開通帳號，請改用線上簽名');
      } else {
        var paper = apvFileIds_(b.paper_files, 2);
        if (paper === null || paper.length < 1) return apvFail_('file_invalid', '對象沒有開通帳號，請附 1～2 張紙本簽名照');
        pb.paper_files = paper;
        groups.push({ ids: paper, kind: 'receipt' });
      }
    }
    return { ok: true, body: pb, amount: null, subject: subj, kind: kind, fileGroups: groups };
  }
  return apvFail_('bad_request', 'type 不合法');
}

/** 路線＋懶式重解。回 {ok, route, eff} */
function apvRouteFor_(c, f, kind, amount, subject, table, signedAtSubmit) {
  var rctx = apvRCtx_(c, f);
  var built = apvBuildRoute_({ type: f.type, kind: kind, amount: amount, sender: c.byEmp[f.sender], subject: subject, table: table, ctx: rctx, now: c.now, signedAtSubmit: signedAtSubmit });
  if (!built.ok) return apvFail_(built.error, built.error === 'not_inited' ? '核決權限表還沒建立' : '路線建立失敗');
  return { ok: true, route: built.route, eff: apvAdvance_(built.route, rctx) };
}

function apvCheckGroups_(groups, owner, formId) {
  var allItems = [];
  var total = 0;
  for (var g = 0; g < groups.length; g++) {
    total += groups[g].ids.length;
    if (!groups[g].ids.length) continue;
    var chk = apvCheckFiles_(groups[g].ids, owner, groups[g].kind, formId);
    if (!chk.ok) return chk;
    allItems = allItems.concat(chk.items);
  }
  if (total > APV_FILE_MAX_PER_FORM) return apvFail_('file_invalid', '照片最多 5 張');
  return { ok: true, items: allItems };
}

function apvNextFormId_(forms, now) {
  var prefix = 'APV-' + apvYmd6_(now) + '-';
  var max = 0;
  forms.forEach(function (fr) {
    if (fr.f.id.indexOf(prefix) === 0) { var n = parseInt(fr.f.id.slice(prefix.length), 10); if (n > max) max = n; }
  });
  var s = String(max + 1);
  while (s.length < 3) s = '0' + s;
  return prefix + s;
}

/** 寫入一個新版本的共同流程（送出、再送共用）：寫單、事件、版本證據、綁檔 */
function apvWriteVersion_(c, fr, isNew, norm, eff, items, signedAtSubmit, note) {
  var f = fr.f;
  var bodyJson = JSON.stringify(norm.body);
  var filesJson = JSON.stringify(items.map(function (x) { return x.o.id; }));
  var sha = apvRevHash_(bodyJson, norm.amount, filesJson);
  f.body_json = bodyJson;
  f.amount = norm.amount;
  f.status = eff.status;
  f.step = eff.status === 'handling' ? null : eff.index;
  f.step_at = c.now;
  f.updated_at = c.now;
  f.route = eff.route;
  if (isNew) { apvAppendObj_(APV_SHEET_FORMS, APV_FORM_HEADERS, Object.assign({}, f, { route_json: JSON.stringify(f.route) })); }
  else { apvSaveForm_(fr); }
  apvAddEvent_(f, c.actor, 'submit', note, sha, c.now);
  if (signedAtSubmit) apvAddEvent_(f, c.actor, 'sign', '', sha, c.now);
  eff.skips.forEach(function (s) {
    apvAddEvent_(f, 'system', 'skip', apvRoleLabel_(s.role) + (s.next ? ' 找不到合格的人，改找' + apvRoleLabel_(s.next) : ' 找不到合格的人，已無更高一級'), '', c.now);
  });
  apvAppendObj_(APV_SHEET_REVS, APV_REV_HEADERS, { form_id: f.id, rev: f.rev, at: c.now, body_json: bodyJson, amount: norm.amount, files_json: filesJson,
    route_json: JSON.stringify(eff.route), thr_ver: eff.route.thr_ver || 0, sha256: sha });
  apvBindFiles_(items, f.id, f.rev);
}

function handleApvSubmit_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  if (!c.me || !c.me.opened) return apvForbidden_('只有已開通帳號的同仁可以送單');
  payload = payload || {};
  var clientId = apvStr_(payload.client_id);
  // 至少一個非數字字元：全數字會被試算表轉成數字，重送比對（字串 ===）會失準（審查 2026-10-28 #6）；前端 UUID 一定含 -
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId) || !/[^0-9]/.test(clientId)) return apvFail_('bad_request', '缺少 client_id');
  var type = payload.type;
  if (APV_TYPES.indexOf(type) === -1) return apvFail_('bad_request', 'type 不合法');
  var forms = apvReadForms_();
  for (var i = 0; i < forms.length; i++) {   // 重送：同一個人＋同一個 client_id 回原單
    if (forms[i].f.sender === c.me.emp && forms[i].f.client_id === clientId) {
      return { ok: true, data: { id: forms[i].f.id, status: forms[i].f.status, route: forms[i].f.route } };
    }
  }
  var norm = apvNormalize_(c, type, payload.body, payload.files, payload.subject, forms, null);
  if (!norm.ok) return norm;
  var f = { id: apvNextFormId_(forms, c.now), type: type, status: 'signing', sender: c.me.emp, unit: c.me.unit, subject: norm.subject ? norm.subject.emp : '',
    amount: norm.amount, body_json: '', route_json: '', step: 0, step_at: c.now, handler_dept: APV_HANDLER_DEPT[type], created_at: c.now, updated_at: c.now, rev: 1, client_id: clientId };
  if (type === 'personnel') {
    var rc = apvRCtx_(c, f);
    if (!apvCanSendPersonnel_(norm.kind, c.me, norm.subject, rc, c.isStaffPerm)) return apvForbidden_('你不能送這位同仁的這種人事異動單');
  }
  var signed = type === 'personnel' && norm.kind === 'leave' && norm.subject.emp === c.me.emp;
  var rt = apvRouteFor_(c, f, norm.kind, norm.amount, norm.subject, type === 'personnel' ? null : apvReadTable_(), signed);
  if (!rt.ok) return rt;
  var chk = apvCheckGroups_(norm.fileGroups, c.me.emp, '');
  if (!chk.ok) return chk;
  apvWriteVersion_(c, { row: 0, f: f }, true, norm, rt.eff, chk.items, signed, '');
  return { ok: true, data: { id: f.id, status: f.status, route: f.route } };
}

function handleApvResubmit_(token, payload) {
  // rejected 單的 step 是 null：前端也要送 null 才算相符（spec §14.2，同 apvDecide）
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f;
  payload = payload || {};
  if (!c.me || f.sender !== c.me.emp) return apvForbidden_('只有送件人可以修改再送');
  if (f.status !== 'rejected') return apvFail_('conflict', '這張單剛被別人處理過，請重新整理');
  var forms = apvReadForms_();
  var norm = apvNormalize_(c, f.type, payload.body, payload.files, f.subject, forms, f);
  if (!norm.ok) return norm;
  if (f.type === 'personnel' && !apvCanSendPersonnel_(norm.kind, c.me, norm.subject, apvRCtx_(c, f), c.isStaffPerm)) return apvForbidden_('你不能送這位同仁的這種人事異動單');
  f.unit = c.me.unit;
  f.rev = f.rev + 1;
  var signed = f.type === 'personnel' && norm.kind === 'leave' && norm.subject.emp === c.me.emp;
  var rt = apvRouteFor_(c, f, norm.kind, norm.amount, norm.subject, f.type === 'personnel' ? null : apvReadTable_(), signed);
  if (!rt.ok) return rt;
  var chk = apvCheckGroups_(norm.fileGroups, c.me.emp, f.id);
  if (!chk.ok) return chk;
  apvWriteVersion_(c, fr, false, norm, rt.eff, chk.items, signed, '修改再送');
  return { ok: true, data: { id: f.id, rev: f.rev, status: f.status, route: f.route } };
}

function handleApvWithdraw_(token, payload) {
  // 與 apvDecide 同一套開頭：先把懶式重解寫回，畫面看到的 step 就等於這裡比對的 step
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f;
  if (!c.me || f.sender !== c.me.emp) return apvForbidden_('只有送件人可以撤回');
  if (f.status !== 'signing') return apvFail_('conflict', '這張單剛被別人處理過，請重新整理');
  if (apvHasDoneStep_(f.route)) return apvFail_('conflict', '已經有人核准，不能撤回');
  f.status = 'withdrawn';
  f.step = null;
  f.step_at = c.now;
  f.updated_at = c.now;
  apvSaveForm_(fr);
  apvAddEvent_(f, c.actor, 'withdraw', '', '', c.now);
  return { ok: true, data: { status: 'withdrawn' } };
}

function handleApvRoutePreview_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  if (!c.me || !c.me.opened) return apvForbidden_('只有已開通帳號的同仁可以送單');
  payload = payload || {};
  var type = payload.type;
  if (APV_TYPES.indexOf(type) === -1) return apvFail_('bad_request', 'type 不合法');
  var f = { type: type, sender: c.me.emp, subject: '' };
  var amount = null, subject = null, kind = '', signed = false;
  if (type === 'purchase' || type === 'expense') {
    var calc = apvCalcAmount_('expense', { amount: payload.amount });
    if (!calc.ok) return apvFail_('bad_amount', '金額要是 1～10,000,000 的整數元');
    amount = calc.amount;
  } else {
    kind = payload.kind;
    subject = apvFindPerson_(c, apvStr_(payload.subject) ? payload.subject : c.me.emp);
    if (['leave', 'transfer', 'raise'].indexOf(kind) === -1 || !subject) return apvFail_('bad_request', '缺少 kind 或 subject');
    f.subject = subject.emp;
    if (!apvCanSendPersonnel_(kind, c.me, subject, apvRCtx_(c, f), c.isStaffPerm)) return apvForbidden_('你不能送這位同仁的這種人事異動單');
    signed = kind === 'leave' && subject.emp === c.me.emp;
  }
  var rt = apvRouteFor_(c, f, kind, amount, subject, type === 'personnel' ? null : apvReadTable_(), signed);
  if (!rt.ok) return rt;
  var route = JSON.parse(JSON.stringify(rt.eff.route));
  apvAttachCandidates_(route, apvRCtx_(c, f));
  return { ok: true, data: { steps: route.steps, handler: route.handler } };
}

// ============================================================
// 7. 簽核：核准／退回、本人簽名、承辦、改派、作廢
// ============================================================

/**
 * 改單 action 的共同開頭：驗身分、找單、（signing 的單）先把懶式重解寫回、確認看得到、比對 rev／step。
 * 回 {ok:true, c, fr, f, eff} 或失敗。needStep＝這支 action 要比對 step。
 */
function apvOpenForWrite_(token, payload, needStep) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  var fr = apvFindForm_(apvStr_(payload.id));
  if (!fr) return apvFail_('not_found', '找不到這張單');
  var f = fr.f;
  var eff = apvEffOf_(c, f);
  if (eff && apvEffChanged_(f, eff)) {
    apvPersistEff_(c, fr, eff, c.now);   // 權限人被停用等造成空缺：先寫 skip、往上
    eff = apvEffOf_(c, f);
  }
  // 順序：看不看得到（看不到＝跟不存在的單一樣 not_found，不洩漏單號、rev、step）→ rev／step（conflict）→ 動作權限（forbidden，由各 action 判斷）。
  // 「走過這張單的關」的人（同時按核准的第二位候選人）也算看得到，才拿得到 conflict（spec §14.2）
  var ev = apvReadEvents_(f.id);
  if (!apvCanView_(c, f, eff, ev) && !apvWasInRoute_(c, f, eff)) return apvFail_('not_found', '找不到這張單');
  if (payload.rev !== f.rev || (needStep && payload.step !== f.step)) return apvFail_('conflict', '這張單剛被別人處理過，請重新整理');
  return { ok: true, c: c, fr: fr, f: f, eff: eff };
}

/** 某一關標完成後往下走（只算、不寫）。回 apvAdvance_ 結果，由呼叫端先寫事件再 apvPersistEff_ */
function apvStepDone_(c, f, index, patch) {
  var route = JSON.parse(JSON.stringify(f.route));
  var st = route.steps[index];
  Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
  st.status = 'done';
  return apvAdvance_(route, apvRCtx_(c, f));
}

function handleApvDecide_(token, payload) {
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f, eff = o.eff;
  if (payload.decision !== 'approve' && payload.decision !== 'reject') return apvFail_('bad_request', 'decision 要是 approve 或 reject');
  if (f.status !== 'signing' || !eff) return apvFail_('conflict', '這張單目前不在簽核中');
  var step = f.route.steps[f.step];
  if (!step || step.role === 'self_sign') return apvForbidden_('這一關是本人簽名，請用簽名功能');
  if (!c.me || !eff.candidates.some(function (p) { return p.emp === c.me.emp; })) return apvForbidden_('你不是這一關的簽核人');
  var sha = apvCurrentSha_(f);
  if (payload.decision === 'reject') {
    var note = apvText_(payload.note, 1, APV_NOTE_MAX);
    if (note === null) return apvFail_('bad_request', '退回要寫原因（1～200 字）');
    f.route.steps[f.step].rej = c.me.emp;
    f.status = 'rejected';
    f.step = null;
    f.step_at = c.now;
    f.updated_at = c.now;
    apvSaveForm_(fr);
    apvAddEvent_(f, c.me.emp, 'reject', note, sha, c.now);
    return { ok: true, data: { status: 'rejected', step: null } };
  }
  var n = apvStr_(payload.note);
  var next = apvStepDone_(c, f, f.step, { by: c.me.emp, at: c.now });
  apvAddEvent_(f, c.me.emp, 'approve', n.slice(0, APV_NOTE_MAX), sha, c.now);
  apvPersistEff_(c, fr, next, c.now);
  return { ok: true, data: { status: f.status, step: f.step } };
}

function handleApvSign_(token, payload) {
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f, eff = o.eff;
  if (f.status !== 'signing' || !eff) return apvFail_('conflict', '這張單目前不在簽核中');
  var step = f.route.steps[f.step];
  if (!step || step.role !== 'self_sign') return apvFail_('conflict', '目前這一關不是本人簽名');
  if (!c.me || c.me.emp !== f.subject || c.me.emp !== step.emp || !eff.candidates.some(function (p) { return p.emp === c.me.emp; })) return apvForbidden_('只有離職本人可以簽名');
  if (typeof payload.sign_file !== 'string' || !APV_FILE_ID_RE.test(payload.sign_file)) return apvFail_('file_invalid', '請先上傳簽名檔');
  var chk = apvCheckFiles_([payload.sign_file], c.me.emp, 'sign', '');
  if (!chk.ok) return chk;
  var sha = apvCurrentSha_(f);
  var nextS = apvStepDone_(c, f, f.step, { by: c.me.emp, at: c.now, sign_file: payload.sign_file });
  apvAddEvent_(f, c.me.emp, 'sign', '', sha, c.now);
  apvPersistEff_(c, fr, nextS, c.now);
  apvBindFiles_(chk.items, f.id, f.rev);
  return { ok: true, data: { status: f.status, step: f.step } };
}

function handleApvHandle_(token, payload) {
  // handling 單的 step 是 null：前端也要送 null 才算相符（spec §14.2）
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f;
  if (payload.result !== 'done' && payload.result !== 'return') return apvFail_('bad_request', 'result 要是 done 或 return');
  if (f.status !== 'handling') return apvFail_('conflict', '這張單目前不在承辦中');
  if (!apvIsHandlerOf_(c, f)) return apvForbidden_('只有承辦部門的人可以處理');
  var note = apvStr_(payload.note);
  if (note.length > APV_NOTE_MAX) return apvFail_('bad_request', '備註最多 200 字');
  var sha = apvCurrentSha_(f);
  if (payload.result === 'return') {
    if (note === '') return apvFail_('bad_request', '退回要寫原因');
    f.status = 'rejected';
    f.step = null;
    f.step_at = c.now;
    f.updated_at = c.now;
    apvSaveForm_(fr);
    apvAddEvent_(f, c.me.emp, 'reject', '[承辦退回] ' + note, sha, c.now);
    return { ok: true, data: { status: 'rejected' } };
  }
  f.status = 'done';
  f.step = null;
  f.step_at = c.now;
  f.updated_at = c.now;
  apvSaveForm_(fr);
  apvAddEvent_(f, c.me.emp, 'handle', note, sha, c.now);
  return { ok: true, data: { status: 'done' } };
}

function handleApvReassign_(token, payload) {
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f;
  if (!c.isStaffPerm) return apvForbidden_('只有人資可以改派');
  if (f.status !== 'signing' && f.status !== 'exception') return apvFail_('conflict', '這張單目前不能改派');
  var reason = apvText_(payload.reason, 1, APV_NOTE_MAX);
  if (reason === null) return apvFail_('bad_request', '改派要寫原因');
  var to = apvStr_(payload.to).toUpperCase();
  var step = f.route.steps[f.step];
  if (!step || step.status === 'done') return apvFail_('conflict', '這一關已經完成');
  var rc = apvRCtx_(c, f);
  var allowed = apvReassignMembers_(f.route, f.step, f.status, rc);
  if (!allowed.some(function (p) { return p.emp === to; })) return apvFail_('bad_request', '改派對象必須是這一關（或更高一級）已開通的合格簽核人，且不能是送件人');
  step.status = 'pending';
  step.override = { to: to, by: c.actor, reason: reason, rev: f.rev, at: c.now };
  f.status = 'signing';
  f.step_at = c.now;
  f.updated_at = c.now;
  apvSaveForm_(fr);
  apvAddEvent_(f, c.actor, 'reassign', '改派給 ' + to + '：' + reason, '', c.now);
  return { ok: true, data: { status: 'signing', step: f.step } };
}

function handleApvVoid_(token, payload) {
  // 順序同其他改單 action：看得到→rev／step（conflict）→權限（forbidden）
  var o = apvOpenForWrite_(token, payload, true);
  if (!o.ok) return o;
  var c = o.c, fr = o.fr, f = o.f;
  if (!c.isStaffPerm && !c.isAdmin) return apvForbidden_('只有人資或系統管理者可以作廢');
  var reason = apvText_(payload.reason, 1, APV_NOTE_MAX);
  if (reason === null) return apvFail_('bad_request', '作廢要寫原因');
  if (f.status === 'done' || f.status === 'voided') return apvFail_('conflict', '這張單已結案或已作廢');
  f.status = 'voided';
  f.step = null;
  f.step_at = c.now;
  f.updated_at = c.now;
  apvSaveForm_(fr);
  apvAddEvent_(f, c.actor, 'void', reason, apvCurrentSha_(f), c.now);
  return { ok: true, data: { status: 'voided' } };
}

// ============================================================
// 8. 查詢：我的單、待辦、單張、列表、匯出、檔案資料
// ============================================================

function apvSortNewest_(list) { return list.sort(function (a, b) { return b.f.created_at - a.f.created_at; }); }

function apvListViews_(c, frs, cap) {
  var files = apvReadFiles_();
  return frs.slice(0, cap || APV_LIST_MAX).map(function (fr) { return apvFormView_(c, fr.f, apvEffOf_(c, fr.f), files, {}); });
}

function handleApvMine_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  if (!c.me) return { ok: true, data: { forms: [] } };
  payload = payload || {};
  var st = apvStr_(payload.status);
  var mine = apvSortNewest_(apvReadForms_().filter(function (fr) { return fr.f.sender === c.me.emp && (!st || fr.f.status === st); }));
  var views = apvListViews_(c, mine);
  // 2026-10-25 審查 A-11：被退回的單直接帶退回原因（該單最後一筆有 note 的 reject／handle 事件），
  // 前端不必再對每張退回單各打一次 apvGet。事件表只讀一次
  var rejected = {};
  views.forEach(function (v) { if (v && v.status === 'rejected') rejected[v.id] = true; });
  if (Object.keys(rejected).length) {
    var last = {};
    apvReadEvents_('').forEach(function (e) {
      if (rejected[e.form_id] && (e.action === 'reject' || e.action === 'handle') && e.note) last[e.form_id] = e;
    });
    views.forEach(function (v) {
      var e = v && last[v.id];
      if (e) v.reject_note = { note: e.note, by: apvName_(c, e.actor) };
    });
  }
  return { ok: true, data: { forms: views } };
}

function handleApvTodo_(token) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  var files = apvReadFiles_();
  var sign = [], handle = [], exception = [];
  apvSortNewest_(apvReadForms_()).forEach(function (fr) {
    var f = fr.f;
    var eff = apvEffOf_(c, f);
    var status = eff ? eff.status : f.status;
    if (status === 'signing' && c.me && eff && eff.candidates.some(function (p) { return p.emp === c.me.emp; })) sign.push(apvFormView_(c, f, eff, files, {}));
    else if (status === 'handling' && apvIsHandlerOf_(c, f)) handle.push(apvFormView_(c, f, eff, files, {}));
    else if (status === 'exception' && (c.isStaffPerm || c.isAdmin)) exception.push(apvFormView_(c, f, eff, files, {}));
  });
  var data = { sign: sign.slice(0, APV_LIST_MAX), handle: handle.slice(0, APV_LIST_MAX) };
  if (c.isStaffPerm || c.isAdmin) data.exception = exception.slice(0, APV_LIST_MAX);
  return { ok: true, data: data };
}

function handleApvGet_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  var fr = apvFindForm_(apvStr_(payload.id));
  if (!fr) return apvFail_('not_found', '找不到這張單');
  var f = fr.f;
  var eff = apvEffOf_(c, f);
  var events = apvReadEvents_(f.id);
  if (!apvCanView_(c, f, eff, events)) return apvForbidden_();
  var view = apvFormView_(c, f, eff, apvReadFiles_(), { body: true, candidates: true });
  return { ok: true, data: {
    form: view,
    events: events.map(function (e) { return { at: e.at, rev: e.rev, actor: { emp: e.actor, name: apvName_(c, e.actor) }, action: e.action, note: e.note }; }),
    revisions: apvReadRevisions_(f.id)
  } };
}

function handleApvList_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  var meDepts = [];
  if (c.me && c.me.opened) {
    [c.me.dept].concat(c.me.extra).forEach(function (d) { if (d && meDepts.indexOf(d) === -1) meDepts.push(d); });
  }
  var all = c.isStaffPerm || c.isAdmin;
  var isHandler = ['purchase', 'fin', 'hr'].some(function (d) { return meDepts.indexOf(d) !== -1; });
  if (!all && !isHandler) return apvForbidden_();
  var month = apvStr_(payload.month), type = apvStr_(payload.type), status = apvStr_(payload.status);
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return apvFail_('bad_request', 'month 格式要是 YYYY-MM');
  var list = apvSortNewest_(apvReadForms_().filter(function (fr) {
    var f = fr.f;
    if (!all) {
      if (meDepts.indexOf(f.handler_dept) === -1 || (f.status !== 'handling' && f.status !== 'done')) return false;
    }
    if (month && apvMonth_(f.created_at) !== month) return false;
    if (type && f.type !== type) return false;
    if (status && f.status !== status) return false;
    return true;
  }));
  return { ok: true, data: { forms: apvListViews_(c, list) } };
}

function handleApvExport_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  var month = apvStr_(payload.month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return apvFail_('bad_request', 'month 格式要是 YYYY-MM');
  var isFin = !!c.me && apvIsHandler_(c.me, 'fin');
  if (!isFin && !c.isStaffPerm && !c.isAdmin) return apvForbidden_();
  var ev = apvReadEvents_('');
  var handleAt = {}, approvedAt = {};
  ev.forEach(function (e) {
    if (e.action === 'handle') handleAt[e.form_id + '#' + e.rev] = e;
    if (e.action === 'approve' || e.action === 'sign') {
      var k = e.form_id + '#' + e.rev;
      if (!approvedAt[k] || e.at > approvedAt[k]) approvedAt[k] = e.at;
    }
  });
  var rows = [];
  apvReadForms_().forEach(function (fr) {
    var f = fr.f;
    if (f.status !== 'done' || (f.type !== 'purchase' && f.type !== 'expense')) return;
    var h = handleAt[f.id + '#' + f.rev];
    if (!h || apvMonth_(h.at) !== month) return;
    var b = apvBodyOf_(f);
    rows.push({
      id: f.id, rev: f.rev, type: f.type, unit_name: apvUnitName_(c, f.unit), sender_name: apvName_(c, f.sender), amount: f.amount,
      category: f.type === 'expense' ? (APV_CATEGORY_NAME[b.category] || b.category) : undefined,
      vendor: f.type === 'expense' ? (b.vendor_name || '') : (b.vendor || ''),
      desc: f.type === 'expense' ? b.desc : b.purpose,
      created_at: f.created_at, approved_at: approvedAt[f.id + '#' + f.rev] || null, done_at: h.at, handle_note: h.note
    });
  });
  rows.sort(function (a, b) { return a.done_at - b.done_at; });
  return { ok: true, data: { rows: rows } };
}

function handleApvFileMeta_(token, payload) {
  var c = apvEnter_(token);
  if (!c.ok) return c;
  if (!apvReady_()) return apvNotInited_();
  payload = payload || {};
  var fid = apvStr_(payload.id);
  var hit = null;
  apvReadFiles_().forEach(function (x) { if (x.o.id === fid && (x.o.state === 'uploaded' || x.o.state === 'bound')) hit = x; });
  if (!hit) return apvFail_('not_found', '找不到檔案');
  var access = apvFileAccess_(c, hit);
  if (!access) return apvForbidden_();
  return { ok: true, data: { id: hit.o.id, kind: hit.o.kind, bytes: hit.o.bytes, form_id: hit.o.form_id } };
}

/** 這個人能不能看這個檔案：沒綁單＝只有擁有者（與 platform 管理者）；綁了單＝看得到那張單的人 */
function apvFileAccess_(c, fileRow) {
  if (!fileRow.o.form_id) return (!!c.me && c.me.emp === fileRow.o.owner) || c.isStaffPerm || c.isAdmin;
  // 2026-10-27 營運巡檢的照片（form_id 'INSP:<巡檢編號>'）：看得到那筆巡檢的人才看得到（Inspect.gs）
  if (fileRow.o.form_id.indexOf('INSP:') === 0) return typeof inspFileCanView_ === 'function' && inspFileCanView_(c, fileRow.o.form_id.slice(5));
  var fr = apvFindForm_(fileRow.o.form_id);
  if (!fr) return false;
  return apvCanView_(c, fr.f, apvEffOf_(c, fr.f), apvReadEvents_(fr.f.id));
}

// ============================================================
// 9. jobs 專用全域函式（jobs.js 經 runGas 呼叫；絕不進 Code.gs 分派表）
// ============================================================

function apvWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try { return fn(); } finally { lock.releaseLock(); }
}

/** token → {ok:true, emp}；沒開通、沒有同仁列、token 失效 → {ok:false, error} */
function apvFileAuthorize_(token) {
  var c = apvEnter_(token);
  if (!c.ok) return { ok: false, error: c.error };
  if (!c.me || !c.me.opened) return { ok: false, error: 'forbidden' };
  return { ok: true, emp: c.me.emp };
}

function apvFileNewId_(existing) {
  for (var tries = 0; tries < 20; tries++) {
    var s = 'F' + Date.now().toString(36).toUpperCase();
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    if (!existing[s]) return s;
  }
  return '';
}

/** 記帳：meta {kind, mime, bytes, sha256, ext}。回 {ok:true, id, path}（path 相對 apv-files，例 2026/10/F….jpg）；每人每天 60 張 */
function apvFileRegister_(emp, meta) {
  return apvWithLock_(function () {
    if (!apvReady_()) return apvNotInited_();
    var e = stfNormEmp_(emp);
    if (!STF_EMP_RE.test(e)) return apvFail_('bad_request', 'emp 格式錯誤');
    if (!meta || (meta.kind !== 'receipt' && meta.kind !== 'sign')) return apvFail_('file_invalid', 'kind 不合法');
    if (typeof meta.bytes !== 'number' || !isFinite(meta.bytes) || meta.bytes < 1 || Math.floor(meta.bytes) !== meta.bytes) return apvFail_('file_invalid', 'bytes 不合法');
    if (meta.bytes > APV_FILE_LIMIT[meta.kind]) return apvFail_('file_too_large', '檔案太大');
    if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) return apvFail_('file_invalid', 'sha256 不合法');
    var now = apvNow_();
    var files = apvReadFiles_();
    var today = apvYmd8_(now);
    var count = 0, maxSeq = 0, ids = {};
    files.forEach(function (x) {
      ids[x.o.id] = 1;
      if (x.o.seq > maxSeq) maxSeq = x.o.seq;
      if (x.o.owner === e && apvYmd8_(x.o.created_at) === today && x.o.state !== 'deleted') count++;   // 登記後 rename 失敗被作廢的不吃額度
    });
    if (count >= APV_FILE_DAILY_QUOTA) return apvFail_('quota', '今天上傳的張數已達上限');
    var id = apvFileNewId_(ids);
    if (!id) return apvFail_('busy', '請再試一次');
    var t = apvTaipei_(now);
    var ext = meta.ext === 'jpg' || meta.ext === 'png' ? meta.ext : (meta.kind === 'sign' ? 'png' : 'jpg');
    if ((meta.kind === 'sign') !== (ext === 'png')) return apvFail_('file_invalid', '副檔名與種類不符');
    var path = t.y + '/' + t.m + '/' + id + '.' + ext;   // 相對 apv-files 目錄（jobs 把 tmp 檔 rename 到這裡）
    apvAppendObj_(APV_SHEET_FILES, APV_FILE_HEADERS, { id: id, owner: e, form_id: '', path: path, bytes: meta.bytes, sha256: meta.sha256, created_at: now,
      kind: meta.kind, state: 'putting', seq: maxSeq + 1, rev: '' });   // putting＝登記了、檔還沒落地；jobs rename 成功後 apvFileCommit_ 才變 uploaded
    return { ok: true, id: id, path: path };
  });
}

/** 檔案已落地（jobs rename 成功後呼叫）：putting → uploaded。已是 uploaded 回 ok（重送無害）；其他狀態失敗 */
function apvFileCommit_(id) {
  return apvWithLock_(function () {
    if (!apvReady_()) return apvNotInited_();
    var fid = apvStr_(id);
    if (!APV_FILE_ID_RE.test(fid)) return apvFail_('file_invalid', '檔號格式錯誤');
    var hit = null;
    apvReadFiles_().forEach(function (x) { if (x.o.id === fid) hit = x; });
    if (!hit) return apvFail_('not_found', '找不到檔案');
    if (hit.o.state === 'uploaded') return { ok: true, id: fid };
    if (hit.o.state !== 'putting') return apvFail_('conflict', '檔案已失效');
    hit.o.state = 'uploaded';
    apvSaveFile_(hit);
    return { ok: true, id: fid };
  });
}

/** 檔案沒能落地（jobs rename 失敗後呼叫）：putting → deleted。只動 putting 的 */
function apvFileAbort_(id) {
  return apvWithLock_(function () {
    if (!apvReady_()) return apvNotInited_();
    var fid = apvStr_(id);
    if (!APV_FILE_ID_RE.test(fid)) return apvFail_('file_invalid', '檔號格式錯誤');
    var hit = null;
    apvReadFiles_().forEach(function (x) { if (x.o.id === fid) hit = x; });
    if (!hit) return apvFail_('not_found', '找不到檔案');
    if (hit.o.state === 'deleted') return { ok: true, id: fid };
    if (hit.o.state !== 'putting') return apvFail_('conflict', '檔案已落地或已使用，不能作廢');
    hit.o.state = 'deleted';
    apvSaveFile_(hit);
    return { ok: true, id: fid };
  });
}

/** 讀取授權：看得到那張單（或未綁單時是擁有者）才回 {ok:true, path, mime} */
function apvFileCanRead_(token, id) {
  var c = apvEnter_(token);
  if (!c.ok) return { ok: false, error: c.error };
  if (!apvReady_()) return { ok: false, error: 'not_inited' };
  var hit = null;
  apvReadFiles_().forEach(function (x) { if (x.o.id === String(id) && (x.o.state === 'uploaded' || x.o.state === 'bound')) hit = x; });
  if (!hit) return { ok: false, error: 'not_found' };
  if (!apvFileAccess_(c, hit)) return { ok: false, error: 'forbidden' };
  return { ok: true, path: hit.o.path, mime: hit.o.kind === 'sign' ? 'image/png' : 'image/jpeg' };
}

/**
 * 孤兒清除第一步：列 uploaded 超過 24 小時、putting 超過 1 小時（put 中途當機）的檔，
 * 以及 deleting 超過 1 小時的檔（jobs 刪檔後、回報前當機會卡住；刪檔對 ENOENT 視為成功，重列無害），並在鎖內改成／維持 deleting 且記 deleting_at。回 [{id, path}]
 */
function apvFileSweepList_() {
  var r = apvWithLock_(function () {
    if (!apvReady_()) return { ok: true, list: [] };
    var now = apvNow_();
    var list = [];
    apvReadFiles_().forEach(function (x) {
      if ((x.o.state === 'uploaded' && now - x.o.created_at > 24 * 60 * 60 * 1000) || (x.o.state === 'putting' && now - x.o.created_at > 60 * 60 * 1000) ||
          (x.o.state === 'deleting' && now - x.o.deleting_at > 60 * 60 * 1000)) {
        x.o.state = 'deleting';
        x.o.deleting_at = now;
        apvSaveFile_(x);
        list.push({ id: x.o.id, path: x.o.path });
      }
    });
    return { ok: true, list: list };
  });
  return r.ok ? r.list : [];
}

/** 孤兒清除第二步：jobs 刪完檔後回報。只收 deleting 的 */
function apvFileSweepDone_(ids) {
  return apvWithLock_(function () {
    if (!Array.isArray(ids)) return { ok: true, done: 0 };
    var done = 0;
    apvReadFiles_().forEach(function (x) {
      if (x.o.state === 'deleting' && ids.indexOf(x.o.id) !== -1) { x.o.state = 'deleted'; apvSaveFile_(x); done++; }
    });
    return { ok: true, done: done };
  });
}

/** 備份水位：seq 大於 afterSeq、還在的檔 */
function apvBackupList_(afterSeq) {
  var after = Number(afterSeq) || 0;
  if (!apvReady_()) return [];
  return apvReadFiles_().filter(function (x) { return x.o.seq > after && (x.o.state === 'uploaded' || x.o.state === 'bound'); })
    .sort(function (a, b) { return a.o.seq - b.o.seq; })
    .map(function (x) { return { seq: x.o.seq, id: x.o.id, path: x.o.path, sha256: x.o.sha256, form_id: x.o.form_id, rev: x.o.rev }; });
}

/** 每日彙整：卡關（signing／handling 超過 72 小時，exception 當天即算）。沒有就回 count 0。文字 ≤1000 字，超過寫「…另 N 張」 */
function apvDigest_() {
  if (!apvReady_()) return { count: 0, title: '', text: '' };
  var c = apvEnter_Anon_();
  var rows = [];
  apvReadForms_().forEach(function (fr) {
    var f = fr.f;
    if (APV_ACTIVE_STATUSES.indexOf(f.status) === -1) return;
    var eff = apvEffOf_(c, f);
    var status = eff ? eff.status : f.status;
    if (!apvIsStuck_(status, f.step_at, c.now)) return;
    var who;
    if (status === 'signing') {
      var step = eff.route.steps[eff.index];
      var names = eff.candidates.slice(0, 3).map(function (p) { return p.name; }).join('、');
      who = apvRoleLabel_(step.role) + (names ? '（' + names + (eff.candidates.length > 3 ? ' 等' : '') + '）' : '');
    } else if (status === 'handling') {
      who = '承辦：' + (c.org.dept[f.handler_dept] ? c.org.dept[f.handler_dept].name : f.handler_dept);
    } else {
      who = '無合格簽核人';
    }
    var days = Math.floor(Math.max(0, c.now - f.step_at) / 86400000);
    rows.push({ at: f.step_at, line: f.id + '｜' + (APV_TYPE_NAME[f.type] || f.type) + '｜' + who + '｜' + days + '天' });
  });
  if (!rows.length) return { count: 0, title: '', text: '' };
  rows.sort(function (a, b) { return a.at - b.at; });
  var lines = rows.map(function (r) { return r.line; });
  var text = lines.join('\n');
  if (text.length > APV_DIGEST_MAX) {
    var kept = [];
    var len = 0;
    for (var i = 0; i < lines.length; i++) {
      var left = lines.length - i;
      var tail = '\n…另 ' + left + ' 張';
      if (len + (kept.length ? 1 : 0) + lines[i].length + tail.length > APV_DIGEST_MAX) break;
      len += (kept.length ? 1 : 0) + lines[i].length;
      kept.push(lines[i]);
    }
    text = kept.join('\n') + '\n…另 ' + (lines.length - kept.length) + ' 張';
    if (text.length > APV_DIGEST_MAX) text = text.slice(0, APV_DIGEST_MAX);
  }
  return { count: rows.length, title: '表單簽核：' + rows.length + ' 張卡關', text: text };
}

/** 摘要／對帳沒有登入者：只有組織與人員目錄（沒有 me） */
function apvEnter_Anon_() {
  var d = apvDirectory_();
  return { org: d.org, people: d.people, byEmp: d.byEmp, me: null, isStaffPerm: false, isAdmin: false, actor: 'system', now: apvNow_() };
}

/** 對所有 signing 單做懶式重解並寫回（權限人被停用後沒人再打開的單）。回 {skipped} */
function apvReconcile_() {
  var r = apvWithLock_(function () {
    if (!apvReady_()) return { ok: true, skipped: 0 };
    var c = apvEnter_Anon_();
    var skipped = 0;
    apvReadForms_().forEach(function (fr) {
      var eff = apvEffOf_(c, fr.f);
      if (eff && apvEffChanged_(fr.f, eff)) {
        skipped += eff.skips.length;
        apvPersistEff_(c, fr, eff, c.now);
      }
    });
    return { ok: true, skipped: skipped };
  });
  return r.ok ? { skipped: r.skipped } : { skipped: 0, error: r.error };
}
