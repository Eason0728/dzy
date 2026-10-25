/**
 * 鼎兆元管理系統｜LINE 認身分（平台後端）— docs/line-auth/spec.md v1.1 第 3、3.2、4 節
 *
 * 同仁用 LINE 打卡綁定的帳號證明「我是這個人」，直接開通（仍待主管審核）或重設密碼。
 * 本檔只有兩類東西：
 *   1. 純函式 lineTrust_／lineFind_：可信綁定判斷與找人（不碰 Sheet，ctx 全由呼叫端傳入）
 *   2. 全域函式 lineAuthCheck_／lineAuthReset_／lineAuthClaim_：只給 Mac mini node 路由用 runGas 呼叫。
 *      ⚠ 這三支絕對不可進 Code.gs 的 CODE_ALLOWED_ACTIONS／dispatchAction_（test/line-auth.mock.test.mjs 有斷言）。
 *   3. 人資用的兩支 action（進分派表）：lineRevoke（停用某人的 LINE 開通／重設）、lineAuthLog（最近 5 筆 line_* 紀錄）
 *
 * ctx 形狀（由呼叫端傳入，函式不自己找時間與狀態）：
 *   { nowMs, kid, lastSyncOk: { 店代碼: 該店最後成功同步毫秒 }, live }
 *   live（只有 reset／claim 要）：{ 店代碼: {ok:true, emp_id, line_h, line_kid, line_bound_at, line_ok_at, active} | {ok:false} }，mini 在鎖外即時抓的名冊；缺＝sync_stale
 *   （lineTrust_ 另吃 ctx.revoked：{ 大寫員編: staff.line_revoked_at 毫秒 }，lineAuthCheck_ 等自己從 staff 分頁讀）
 *
 * ⚠ staff_log 只寫原因代碼，絕不寫 line_h、userId、姓名、手機、生日、地址、密碼。
 * ⚠ 回給 mini 的物件只含文件列出的欄位；沒有可信綁定的人，回應不帶姓名與員編（避免被冒綁的人洩漏他人資料）。
 */

var LINE_PROP_ON = 'LINE_AUTH_ON';
var LINE_DAY_MS = 24 * 3600 * 1000;
var LINE_TRUST_MIN_AGE_MS = 7 * LINE_DAY_MS;
var LINE_SYNC_MAX_AGE_MS = 26 * 3600 * 1000;
var LINE_NONCE_TTL_SEC = 600;
var LINE_NONCE_PREFIX = 'lan:';
var LINE_LOG_SHOW = 5;
var LINE_REVOKED_HEADER = 'line_revoked_at';
var LINE_H_RE = /^[0-9a-f]{64}$/;
var LINE_NONCE_RE = /^[A-Za-z0-9]{8,128}$/;

var LINE_MSG = {
  BUSY: '系統忙碌中，請稍後再試',
  OFF: 'LINE 開通與重設目前未開放',
  BAD_INPUT: '資料格式不對，請重新開啟頁面',
  NONCE: '這次驗證已失效，請回到 LINE 重新開啟頁面',
  SERVER: '系統忙碌中，請稍後再試',
  NOT_BOUND: '找不到你的 LINE 打卡綁定',
  NOT_TRUSTED: '你的 LINE 綁定還不能用來驗證身分',
  AMBIGUOUS: '這個 LINE 對到多位同仁，請找人資協助',
  BLOCKED: '你的帳號目前不能用 LINE 處理',
  NEED_REVIEW: '請改用原本的認領流程',
  WRONG_OP: '這個動作不適用你的帳號狀態'
};

// ============================================================
// 1. 純函式
// ============================================================

function lineStrictTrue_(v) { return v === true || v === 'TRUE'; }

/** 'yyyy-MM-ddTHH:mm:ss+08:00' → 毫秒；空白或不是時間 → NaN */
function lineMs_(s) {
  if (s instanceof Date) return s.getTime();
  var t = String(s === undefined || s === null ? '' : s).trim();
  if (!t) return NaN;
  return Date.parse(t);
}

/**
 * 一列綁定（staff_clock 列）可不可信。ctx：{ nowMs, kid, lastSyncOk, revoked }。
 * 回 { trusted, reason, days_left, need_line_punch, sync_stale }
 * reason：'' 可信；state／active／no_line_h／kid／bound／revoked（結構性不可信）；wait（還沒滿 7 天）；need_line_punch；sync_stale
 */
function lineTrust_(row, ctx) {
  ctx = ctx || {};
  var now = Number(ctx.nowMs);
  var out = { trusted: false, reason: '', days_left: 0, need_line_punch: false, sync_stale: false };
  var no = function (reason) { out.reason = reason; return out; };
  if (!row || String(row.state === undefined || row.state === null ? '' : row.state).trim() !== 'confirmed') return no('state');
  if (!lineStrictTrue_(row.roster_active)) return no('active');
  var h = String(row.line_h === undefined || row.line_h === null ? '' : row.line_h).trim();
  if (!h) return no('no_line_h');
  var kid = String(ctx.kid === undefined || ctx.kid === null ? '' : ctx.kid).trim();
  if (!kid || String(row.line_kid === undefined || row.line_kid === null ? '' : row.line_kid).trim() !== kid) return no('kid');
  if (!isFinite(now)) return no('bad_ctx');
  var bound = lineMs_(row.line_bound_at);
  if (!isFinite(bound)) return no('bound');
  var emp = String(row.emp_no === undefined || row.emp_no === null ? '' : row.emp_no).trim().toUpperCase();
  var rv = ctx.revoked && emp ? Number(ctx.revoked[emp]) : NaN;
  if (isFinite(rv) && rv > 0 && !(bound > rv)) return no('revoked');

  var ageOk = now - bound >= LINE_TRUST_MIN_AGE_MS;
  var ok = lineMs_(row.line_ok_at);
  var punchOk = isFinite(ok) && ok > bound;
  var store = String(row.store_code === undefined || row.store_code === null ? '' : row.store_code).trim().toLowerCase();
  var last = ctx.lastSyncOk ? Number(ctx.lastSyncOk[store]) : NaN;
  var syncOk = isFinite(last) && now - last <= LINE_SYNC_MAX_AGE_MS;

  out.days_left = ageOk ? 0 : Math.ceil((bound + LINE_TRUST_MIN_AGE_MS - now) / LINE_DAY_MS);
  out.need_line_punch = !punchOk;
  out.sync_stale = !syncOk;
  if (!ageOk) return no('wait');
  if (!punchOk) return no('need_line_punch');
  if (!syncOk) return no('sync_stale');
  out.trusted = true;
  return out;
}

/**
 * 用 line_h 找人：只看 state＝confirmed 且 roster_active 嚴格 TRUE 的列（失效、已離職的舊列不計）。
 * emp_no 去重：恰 1 位＝hit（rows＝這位的符合列）、0＝not_bound、≥2＝ambiguous。
 */
function lineFind_(lineH, rows) {
  var h = String(lineH === undefined || lineH === null ? '' : lineH).trim().toLowerCase();
  var out = { status: 'not_bound', emp_no: '', rows: [] };
  if (!h) return out;
  var seen = {}, keys = [], hits = [];
  (rows || []).forEach(function (r) {
    if (!r) return;
    if (String(r.state === undefined || r.state === null ? '' : r.state).trim() !== 'confirmed') return;
    if (!lineStrictTrue_(r.roster_active)) return;
    if (String(r.line_h === undefined || r.line_h === null ? '' : r.line_h).trim().toLowerCase() !== h) return;
    var e = String(r.emp_no === undefined || r.emp_no === null ? '' : r.emp_no).trim().toUpperCase();
    if (!e) return;
    hits.push(r);
    if (!seen[e]) { seen[e] = 1; keys.push(e); }
  });
  if (keys.length === 1) return { status: 'hit', emp_no: keys[0], rows: hits };
  if (keys.length > 1) return { status: 'ambiguous', emp_no: '', rows: [] };
  return out;
}

/** 主店（開通用，比 storeHomeFn_ 嚴）：該 emp_no 恰好一筆 confirmed＋roster_active TRUE＋role home；否則 null */
function lineHomeRow_(empNo, rows) {
  var e = String(empNo).trim().toUpperCase();
  var hits = (rows || []).filter(function (r) {
    return r && String(r.emp_no).trim().toUpperCase() === e && String(r.state).trim() === 'confirmed' &&
      lineStrictTrue_(r.roster_active) && String(r.role).trim() === 'home';
  });
  return hits.length === 1 ? hits[0] : null;
}

// ============================================================
// 2. staff.line_revoked_at（尾端欄，毫秒）
// ============================================================

function lineRevokedColNo_() { return STF_COL_COUNT + CLK_STAFF_EXTRA.indexOf(LINE_REVOKED_HEADER) + 1; }

/** 'ok'／'missing'／'mismatch'／'nosheet' */
function lineRevokedColState_() {
  var sh = stfSheet_(STF_SHEET);
  if (!sh) return 'nosheet';
  var cur;
  try { cur = String(sh.getRange(1, lineRevokedColNo_(), 1, 1).getValues()[0][0]).trim(); } catch (e) { return 'missing'; }
  if (cur === LINE_REVOKED_HEADER) return 'ok';
  return cur === '' ? 'missing' : 'mismatch';
}

/** {大寫員編: 毫秒}；欄位還沒建就回空物件 */
function lineReadRevokedMap_() {
  var map = {};
  if (lineRevokedColState_() !== 'ok') return map;
  var sh = stfSheet_(STF_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return map;
  var emps = sh.getRange(2, 1, last - 1, 1).getValues();
  var vals = sh.getRange(2, lineRevokedColNo_(), last - 1, 1).getValues();
  for (var i = 0; i < emps.length; i++) {
    var n = Number(vals[i][0]);
    if (isFinite(n) && n > 0) map[stfNormEmp_(emps[i][0])] = n;
  }
  return map;
}

/**
 * fail-closed 版：欄位表頭找不到（缺／不符／分頁不在）或讀取丟錯 → 丟錯（呼叫端回 server_error），絕不當作「沒有撤銷」。
 * check／sources／reset／claim 一律用這支；handleLineAuthLog_（只是顯示）才用寬鬆版 lineReadRevokedMap_。
 */
function lineReadRevokedMapStrict_() {
  var st = lineRevokedColState_();
  if (st !== 'ok') throw new Error('staff.' + LINE_REVOKED_HEADER + ' 欄不可用：' + st);
  return lineReadRevokedMap_();
}

/** 寫 staff 該列的 line_revoked_at。回 null＝成功，否則錯誤字串（表頭不符一律停） */
function lineMarkRevoked_(row, ms) {
  var st = lineRevokedColState_();
  if (st === 'mismatch') return '分頁「staff」第 ' + lineRevokedColNo_() + ' 欄的表頭不是 ' + LINE_REVOKED_HEADER + '，停止寫入以免資料錯位';
  if (st === 'nosheet') return '分頁「staff」不存在';
  if (st === 'missing') {
    try { clkEnsureStaffExtra_(SpreadsheetApp.getActive()); } catch (e) { return '分頁初始化失敗：' + (e && e.message ? e.message : e); }
    if (lineRevokedColState_() !== 'ok') return '分頁「staff」LINE 停用欄補欄失敗';
  }
  stfSheet_(STF_SHEET).getRange(row, lineRevokedColNo_(), 1, 1).setValue(ms);
  return null;
}

/**
 * 停用同仁、撤回認領、退回認領時自動呼叫：失敗不擋原本的動作，但留兩道痕跡——
 * console，以及 staff_log 的 line_revoke_fail（lineAuthCheck_ 看到最近一筆撤銷紀錄是它，就把該同仁一律 blocked，直到人資手動 lineRevoke 成功）
 */
function lineAutoRevoke_(row) {
  var failed = false;
  try {
    var err = lineMarkRevoked_(row, Date.now());
    if (err) { failed = true; console.error('[lineAutoRevoke_] ' + err); }
  } catch (e) {
    failed = true;
    console.error('[lineAutoRevoke_] ' + (e && e.message ? e.message : e));
  }
  if (!failed) return;
  try {
    var emp = stfNormEmp_(stfSheet_(STF_SHEET).getRange(row, 1, 1, 1).getValues()[0][0]);
    stfLog_(emp, 'line_revoke_fail', 'system', '');
  } catch (e2) {
    console.error('[lineAutoRevoke_] log ' + (e2 && e2.message ? e2.message : e2));
  }
}

/** 該同仁最近一筆「撤銷類」紀錄是不是 line_revoke_fail（晚於最後一次 line_revoke）。讀不到 log 丟錯＝fail closed */
function lineRevokeFailed_(emp) {
  var rows = stfReadRows_(STF_SHEET_LOG, STF_LOG_HEADERS.length);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (stfNormEmp_(rows[i][1]) !== emp) continue;
    var ev = stfStr_(rows[i][2]);
    if (ev === 'line_revoke_fail') return true;
    if (ev === 'line_revoke') return false;
  }
  return false;
}

// ============================================================
// 3. 內部：開關、鎖、nonce、重查
// ============================================================

function lineOn_() { return PropertiesService.getScriptProperties().getProperty(LINE_PROP_ON) === '1'; }

function lineErr_(code, message, extra) {
  var o = { ok: false, error: code, message: message };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

/** ScriptLock（同 clkWithLock_ 的 tryLock 20 秒寫法）；等不到回 busy。例外只記 console（不帶參數），回 server_error */
function lineWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return lineErr_('busy', LINE_MSG.BUSY);
  try {
    return fn();
  } catch (e) {
    console.error('[lineAuth] ' + (e && e.message ? e.message : e));
    return lineErr_('server_error', LINE_MSG.SERVER);
  } finally {
    lock.releaseLock();
  }
}

function lineCtx_(ctx) {
  ctx = ctx || {};
  var now = Number(ctx.nowMs);
  return {
    nowMs: isFinite(now) && ctx.nowMs !== null && ctx.nowMs !== '' ? now : Date.now(),
    kid: ctx.kid === undefined || ctx.kid === null ? '' : String(ctx.kid),
    lastSyncOk: ctx.lastSyncOk && typeof ctx.lastSyncOk === 'object' ? ctx.lastSyncOk : {},
    live: ctx.live && typeof ctx.live === 'object' ? ctx.live : undefined   // 缺＝reset／claim 一律 sync_stale（fail closed）
  };
}

function lineNonceIssue_(lineH, op, empNo) {
  var nonce = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  CacheService.getScriptCache().put(LINE_NONCE_PREFIX + nonce, JSON.stringify({ h: lineH, op: op, emp_no: empNo }), LINE_NONCE_TTL_SEC);
  return nonce;
}

/** 讀 nonce 記錄（不刪）。格式不對、不存在回 null；h／op 不符＝當場作廢並回 null */
function lineNonceGet_(nonce, lineH, op) {
  if (typeof nonce !== 'string' || !LINE_NONCE_RE.test(nonce)) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(LINE_NONCE_PREFIX + nonce);
  if (!raw) return null;
  var rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || rec.h !== lineH || rec.op !== op) { cache.remove(LINE_NONCE_PREFIX + nonce); return null; }
  return rec;
}
function lineNonceDrop_(nonce) { CacheService.getScriptCache().remove(LINE_NONCE_PREFIX + nonce); }

function lineLogFail_(empNo, code) {
  try { stfLog_(empNo || '', 'line_fail', 'line-self', code); } catch (e) { /* 紀錄失敗不影響回應 */ }
}

/**
 * 找人＋可信判斷（不上鎖、不發 nonce、不寫 log；check／sources／reset／claim 共用）。
 * 撤銷資料讀不到會丟錯（呼叫端轉 server_error）。
 * 回 { early, emp, trusted }：early＝not_bound／ambiguous／not_trusted 的 core；否則 trusted＝可信的 staff_clock 列（≥1）
 */
function lineTrustPhase_(lineH, c) {
  var maps = clkMaps_();
  var f = lineFind_(lineH, maps);
  if (f.status === 'not_bound') return { early: { mode: 'not_bound' }, maps: maps };
  if (f.status === 'ambiguous') return { early: { mode: 'ambiguous', code: 'ambiguous' }, maps: maps };
  var emp = f.emp_no;
  var tctx = { nowMs: c.nowMs, kid: c.kid, lastSyncOk: c.lastSyncOk, revoked: lineReadRevokedMapStrict_() };
  var results = f.rows.map(function (r) { return lineTrust_(r, tctx); });
  var trusted = f.rows.filter(function (r, i) { return results[i].trusted; });
  if (!trusted.length) {
    var rank = function (r) { return (r.reason === 'wait' || r.reason === 'need_line_punch') ? 0 : (r.reason === 'sync_stale' ? 1 : 2); };
    results.sort(function (a, b) { return rank(a) - rank(b) || a.days_left - b.days_left; });
    var best = results[0];
    var pub = (best.reason === 'wait' || best.reason === 'need_line_punch' || best.reason === 'sync_stale') ? best.reason : 'other';
    return { early: { mode: 'not_trusted', emp_no: emp, reason: pub, days_left: best.days_left, need_line_punch: best.need_line_punch,
      code: 'not_trusted_' + best.reason }, maps: maps };
  }
  return { early: null, emp: emp, trusted: trusted, maps: maps };
}

/** live 欄位 emp_id／line_h 的比對用正規化 */
function lineNormId_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); }

/**
 * 鎖內重查用：可信列至少一筆在 mini 即時抓的名冊（ctx.live[店代碼]）裡仍然成立——
 * ok:true、emp_id 相同、line_h 相同、line_bound_at 同一時刻、line_ok_at 非空、active 為真。
 * 回 '' ＝通過；'sync_stale'＝沒有任何可信列拿到即時資料（或 live 缺）；'live_mismatch'＝有即時資料但不一致
 */
function lineLiveCheck_(trusted, live) {
  if (!live || typeof live !== 'object') return 'sync_stale';
  var anyLive = false;
  for (var i = 0; i < trusted.length; i++) {
    var r = trusted[i];
    var L = live[String(r.store_code).trim().toLowerCase()] || live[r.store_code];
    if (!L || L.ok !== true) continue;
    anyLive = true;
    var lb = lineMs_(L.line_bound_at), rb = lineMs_(r.line_bound_at);
    var lok = L.line_ok_at === undefined || L.line_ok_at === null ? '' : String(L.line_ok_at).trim();
    if (lineNormId_(L.emp_id) === lineNormId_(r.emp_id) &&
        String(L.line_h === undefined || L.line_h === null ? '' : L.line_h).trim().toLowerCase() === String(r.line_h).trim().toLowerCase() &&
        isFinite(lb) && isFinite(rb) && lb === rb && lok !== '' && lineStrictTrue_(L.active)) return '';
  }
  return anyLive ? 'live_mismatch' : 'sync_stale';
}

/**
 * 查＋判斷。needLive＝reset／claim 的鎖內重查（要求 ctx.live 佐證）；check 不要求。
 * 回內部物件 { mode, emp_no, ... }；mode：not_bound／ambiguous／blocked／wrong_op／not_trusted／need_review／claim／reset。
 * 順序：找人 → 可信 → (live) → 撤銷失敗 → 帳號狀態。不可信的人拿不到任何帳號狀態（blocked／wrong_op／need_review 都在可信之後）。
 */
function lineCheckCore_(lineH, op, ctx, needLive) {
  var tp = lineTrustPhase_(lineH, ctx);
  if (tp.early) return tp.early;
  var maps = tp.maps, emp = tp.emp;
  if (needLive) {
    var lv = lineLiveCheck_(tp.trusted, ctx.live);
    if (lv) return { mode: 'not_trusted', emp_no: emp, reason: lv === 'sync_stale' ? 'sync_stale' : 'other', days_left: 0, need_line_punch: false, code: 'not_trusted_' + lv };
  }
  if (lineRevokeFailed_(emp)) return { mode: 'blocked', emp_no: emp, status: 'disabled', code: 'blocked_revoke_fail' };
  var hit = stfFindByEmp_(emp);
  if (!hit) return { mode: 'need_review', emp_no: emp, code: 'need_review_no_staff' };
  var status = stfStr_(hit.values[STF_COL.status]);
  if (status === 'disabled' || status === 'pending' || status === 'rejected') {
    return { mode: 'blocked', emp_no: emp, status: status, code: 'blocked_' + status };
  }
  var want = status === 'unclaimed' ? 'claim' : (status === 'active' ? 'reset' : '');
  if (!want) return { mode: 'need_review', emp_no: emp, code: 'need_review_status' };
  if (op !== want) return { mode: 'wrong_op', emp_no: emp, expected_mode: want, code: 'wrong_op' };

  var name = stfStr_(hit.values[STF_COL.name]);
  if (want === 'reset') return { mode: 'reset', emp_no: emp, name: name };
}

/** 內部 → 回給 mini 的欄位（白名單）。沒有可信綁定的 mode 一律不帶姓名與員編 */
function lineCheckPublic_(core, nonce) {
  var o = { ok: true, mode: core.mode };
  if (core.mode === 'reset') {
    o.name = core.name; o.emp_no = core.emp_no; o.nonce = nonce;
  } else if (core.mode === 'not_trusted') {
    o.reason = core.reason; o.days_left = core.days_left; o.need_line_punch = core.need_line_punch;
  } else if (core.mode === 'wrong_op') {
    o.expected_mode = core.expected_mode;
  } else if (core.mode === 'blocked') {
    o.status = core.status;
  }
  return o;
}

/** reset／claim 重查失敗時的錯誤物件（mode 對應 plan.md 的錯誤代碼） */
function lineModeErr_(core) {
  var map = { not_bound: ['not_bound', LINE_MSG.NOT_BOUND], not_trusted: ['not_trusted', LINE_MSG.NOT_TRUSTED],
    ambiguous: ['ambiguous', LINE_MSG.AMBIGUOUS], blocked: ['blocked', LINE_MSG.BLOCKED],
    need_review: ['need_review', LINE_MSG.NEED_REVIEW], wrong_op: ['bad_input', LINE_MSG.WRONG_OP] };
  var m = map[core.mode] || ['server_error', LINE_MSG.SERVER];
  return lineErr_(m[0], m[1], { mode: core.mode });
}

function lineHArgOk_(lineH) { return typeof lineH === 'string' && LINE_H_RE.test(lineH); }

// ============================================================
// 4. 全域函式（只給 mini 路由）
// ============================================================

/** op：'claim'｜'reset'。回 { ok:true, mode, ... }（欄位見 lineCheckPublic_）或 { ok:false, error, message } */
function lineAuthCheck_(lineH, op, ctx) {
  if (!lineOn_() || op === 'claim') return { ok: true, mode: 'off' };   // R3：LINE 開通已取消，claim 一律 off（不發 nonce、不寫 log）
  if (!lineHArgOk_(lineH) || (op !== 'claim' && op !== 'reset')) return lineErr_('bad_input', LINE_MSG.BAD_INPUT);
  var c = lineCtx_(ctx);
  return lineWithLock_(function () {
    var core = lineCheckCore_(lineH, op, c);
    if (core.code) lineLogFail_(core.emp_no, core.code);
    var nonce = core.mode === 'reset' ? lineNonceIssue_(lineH, op, core.emp_no) : '';
    return lineCheckPublic_(core, nonce);
  });
}

/**
 * 給 mini 在鎖外先抓即時名冊用：回這個 line_h「可信」的 staff_clock 列（只列 store_code＋emp_id）。
 * 規則與 check 相同（找人、可信、撤銷）；不發 nonce、不寫 log、不上鎖。不可信／找不到／對到多人 → sources:[]。
 * 撤銷資料讀不到 → server_error（fail closed）。
 */
function lineAuthSources_(lineH, ctx) {
  if (!lineOn_()) return { ok: false, error: 'off' };
  if (!lineHArgOk_(lineH)) return lineErr_('bad_input', LINE_MSG.BAD_INPUT);
  var c = lineCtx_(ctx);
  try {
    var tp = lineTrustPhase_(lineH, c);
    if (tp.early) return { ok: true, sources: [] };
    return { ok: true, sources: tp.trusted.map(function (r) { return { store_code: r.store_code, emp_id: r.emp_id }; }) };
  } catch (e) {
    console.error('[lineAuthSources_] ' + (e && e.message ? e.message : e));
    return lineErr_('server_error', LINE_MSG.SERVER);
  }
}

/** 用 check 發的 nonce 重設密碼。成功回 { ok:true, mode:'done', op:'reset' } */
function lineAuthReset_(lineH, nonce, newPw, ctx) {
  if (!lineOn_()) return lineErr_('off', LINE_MSG.OFF);
  if (!lineHArgOk_(lineH) || typeof nonce !== 'string') return lineErr_('bad_input', LINE_MSG.BAD_INPUT);
  if (typeof newPw !== 'string') return lineErr_('bad_input', LINE_MSG.BAD_INPUT);
  if (stfTooLong_(newPw, STF_MAX.password)) return lineErr_('bad_input', STF_MSG.PW_TOO_LONG);
  var c = lineCtx_(ctx);
  return lineWithLock_(function () {
    var rec = lineNonceGet_(nonce, lineH, 'reset');
    if (!rec) return lineErr_('bad_input', LINE_MSG.NONCE, { reason: 'nonce' });
    // 密碼規則只看輸入與員編，不洩漏任何資料：不符時 nonce 保留，讓同仁改完再送
    var pwErr = stfValidatePassword_(newPw, rec.emp_no);
    if (pwErr) return lineErr_('bad_input', pwErr);
    lineNonceDrop_(nonce);   // 從這裡起一律作廢（一次性）

    var core = lineCheckCore_(lineH, 'reset', c, true);
    if (core.mode !== 'reset' || core.emp_no !== rec.emp_no) {
      lineLogFail_(core.emp_no || rec.emp_no, core.code || 'recheck_mismatch');
      return lineModeErr_(core.mode === 'reset' ? { mode: 'wrong_op' } : core);
    }
    var emp = core.emp_no;
    var hit = stfFindByEmp_(emp);
    var userRow = hit ? findUsrRowById_(stfStr_(hit.values[STF_COL.user_id])) : null;
    if (!hit || !userRow) return lineErr_('server_error', LINE_MSG.SERVER);

    // 寫入順序偏安全：先讓舊登入失效，再換密碼，最後才清鎖與記 log。
    // 中途失敗最壞＝使用者被登出但密碼沒改（可重試），不會出現「密碼換了、舊 token 還有效」
    setTokenAfter_(userRow.row);
    var salt = Utilities.getUuid();
    stfSheet_(USR_SHEET_USERS).getRange(userRow.row, USR_COL.salt + 1, 1, 2).setValues([[salt, hashPassword_(newPw, salt)]]);
    clearLoginState_(emp);
    var v = hit.values.slice();
    v[STF_COL.reset_fail] = 0;
    v[STF_COL.reset_locked] = '';
    v[STF_COL.reset_lock_until] = '';
    v[STF_COL.reset_lock_count] = 0;
    v[STF_COL.updated_at] = stfNowText_();
    stfWriteRow_(STF_SHEET, hit.row, v, STF_COL_COUNT);
    stfLog_(emp, 'line_reset_ok', 'line-self', '');
    return { ok: true, mode: 'done', op: 'reset' };
  });
}

/** 已停用（spec v1.2 R3：取消 LINE 開通）。保留函式避免外部呼叫報錯，不執行任何寫入。 */
function lineAuthClaim_(lineH, nonce, form, ctx) {
  return { ok: false, error: 'off' };
}

// ============================================================
// 5. 人資 action（進 Code.gs 分派表）
// ============================================================

/** 人資停用這個人的 LINE 重設密碼：之後只有「在這個時間之後重新綁定」且再滿 7 天＋LINE 打卡才恢復 */
function handleLineRevoke_(token, payload) {
  var t = stfAdminTarget_(token, payload);
  if (!t.ok) return t;
  var ms = Date.now();
  var err = lineMarkRevoked_(t.hit.row, ms);
  if (err) return { ok: false, error: err };
  stfLog_(t.emp, 'line_revoke', t.auth.user.id, '');
  return { ok: true, data: { emp_no: t.emp, line_revoked_at: ms } };
}

/** 同仁最近 5 筆 line_* 紀錄（時間、類型）＋目前的停用時間；給同仁名單詳細頁 */
function handleLineAuthLog_(token, payload) {
  var auth = stfRequire_(token, 'platform.staff');
  if (!auth.ok) return auth;
  var emp = stfNormEmp_(payload && payload.emp_no);
  if (!STF_EMP_RE.test(emp)) return { ok: false, error: STF_MSG.NOT_FOUND };
  var rows = stfReadRows_(STF_SHEET_LOG, STF_LOG_HEADERS.length);
  var items = [];
  for (var i = rows.length - 1; i >= 0 && items.length < LINE_LOG_SHOW; i--) {
    var ev = stfStr_(rows[i][2]);
    if (stfNormEmp_(rows[i][1]) === emp && ev.indexOf('line_') === 0) items.push({ at: stfStr_(rows[i][0]), type: ev });
  }
  return { ok: true, data: { emp_no: emp, items: items, line_revoked_at: lineReadRevokedMap_()[emp] || 0 } };
}
