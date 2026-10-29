/**
 * 鼎兆元管理系統｜平台後端 — 對外入口（T1-5）
 * 對應 docs/spec.md §4.8 送出與回傳格式／§5.2 API actions。
 *
 * 這是整個系統唯一的後端進入點。doPost 白名單分派七個 action：
 * login／me／listUsers／saveUser／setActive／resetPassword／listRoles，未知 action 一律拒絕。
 * 不管內部任何一支 handler 是否拋錯，doPost 一律回 {ok,...}，絕不讓例外變成 500。
 *
 * 錯誤訊息規則（spec §5.2，2026-08-15 補）：doPost 在 catch 到「未預期例外」時，
 * 一律回前端通用訊息 CODE_MSG_INTERNAL_ERROR，細節只寫進伺服器端 console.error（Apps Script
 * 會送進 Stackdriver），避免例外訊息帶出分頁名、函式名等內部結構洩漏給前端。
 * 注意：handler 自己正常 return 的 {ok:false, error:'...'}（業務訊息，例如帳號或密碼錯誤、
 * 沒有權限）不是「被 catch 的例外」，dispatch_ 直接 return 那個物件，不會經過這個 catch，
 * 訊息原樣保留，不受這條規則影響。
 */

var CODE_ALLOWED_ACTIONS = ['login', 'me', 'listUsers', 'saveUser', 'setActive', 'resetPassword', 'listRoles', 'changePassword',
  // 個人帳號管理（2026-10-11，docs/personnel/spec.md §6）
  'orgOptions', 'claimLookup', 'claimSubmit', 'forgotReset', 'myProfile', 'saveMyProfile', 'myUnit',
  'staffList', 'staffImport', 'staffAdd', 'staffConfirm', 'staffReject', 'staffSetActive', 'staffUnclaim',
  'staffUnlockReset', 'staffEdit',
  // 2026-10-12：登出全部裝置、認領後主管審核（docs/personnel/spec.md §6.8／§6.9）
  'logout', 'unitPending', 'unitApprove', 'unitReject',
  // 2026-10-13：員工名單統一（StaffClock.gs，契約 docs/personnel/master-data/api.md）；內部函式（結尾底線）不在這裡
  'staffCreateByUnit', 'staffLeave', 'staffLeaveCancel', 'staffRename', 'staffReinstate', 'staffUnitList',
  'clockMapBuild', 'clockMapList', 'clockMapDecide', 'clockCandidateCreate', 'clockCandidateDismiss',
  'clockOutboxRetry', 'clockOutboxCancel', 'clockSetHome', 'clockOldHomeDecide', 'clockLink', 'clockJobStatus', 'clockAlerts', 'svcDirectory',
  // 2026-10-14：第 4 段，總部在主店補建打卡帳號（no_home_map 異常列）
  'clockAddHome',
  // 2026-10-14：組織架構改版一次性升級／回退（只有 role admin；Staff.gs 第 10 節）
  'orgUpgrade2026', 'orgRollback2026',
  // 2026-10-20：職稱調整（區經理移回門市、中央工廠廠長／廚藝總監）一次性升級／回退（只有 role admin；Staff.gs 第 11 節）
  'orgUpgrade202610', 'orgRollback202610',
  // 2026-10-23：名稱調整（加盟招商部→加盟部、總監→總監、廚藝總監→廚藝總監，只改 org 三格名稱；Staff.gs 第 12 節）
  'orgRename202610', 'orgRenameRollback202610',
  // 2026-10-23：鼎兆元總部新增品牌發展部 branddev 一次性新增／退回（只有 role admin；Staff.gs 第 13 節）
  'orgAddBranddev202610', 'orgAddBranddevRollback202610',
  'orgEnableMztMc202610', 'orgEnableMztMcRollback202610',
  // 2026-10-16：公告專區自動登入電子佈告欄（StaffClock.gs SSO 節）
  'ssoTicket', 'svcSsoRedeem',
  // 2026-10-17：個人帳號第二期，依單位＋職稱給權限（PermActions.gs）
  'permInit', 'permMapGet', 'permMapSave', 'permExList', 'permExSave', 'permExRevoke',
  'permStoreGet', 'permStoreSave', 'myPerms', 'permAuditList', 'permAuditSeen', 'permWho',
  // 2026-10-18：第三期表單簽核（Approvals.gs；契約 docs/approvals/api.md）。jobs 專用的全域函式（apvFile*_／apvDigest_ 等）刻意不在這裡
  'apvSetup', 'apvThresholdGet', 'apvThresholdSave', 'apvRoutePreview', 'apvMine', 'apvTodo', 'apvGet', 'apvList', 'apvExport', 'apvFileMeta',
  'apvSubmit', 'apvResubmit', 'apvWithdraw', 'apvDecide', 'apvSign', 'apvHandle', 'apvReassign', 'apvVoid',
  // 2026-10-18：門市營運系統（StoreOps.gs）；永遠不可列進 minikit readActions 與 dryrun READ_ACTIONS
  'svcStoreRedeem', 'svcStoreWho', 'svcStoreRoster',
  // 2026-10-28：值班主管本人的申請改由上層審（docs/req-upper）。attUpperGaps 是純讀取（人資主管／admin 才有內容），首頁提醒用
  'attUpperGaps',
  // 2026-10-28：薪酬管理「差異清單＋一鍵帶入」（StaffClock.gs 末節）。純讀取，要 payroll.write；寫入仍由薪酬頁走 payroll_master_set
  'payrollStaffRoster',
  // 2026-10-25：區域（督導負責區，Regions.gs；docs/regions/spec.md 第 9 節）。regionList／regionCheck 是讀取；regionSave／regionSwitch 寫入（上鎖）
  'regionList', 'regionSave', 'regionCheck', 'regionSwitch',
  // 2026-10-25：LINE 認身分的人資操作（LineAuth.gs；docs/line-auth/spec.md §3.2）。lineRevoke 寫入（上鎖）、lineAuthLog 讀取。
  // ⚠ 給 mini 路由用的 LINE 全域函式（LineAuth.gs 內結尾底線的那三支）刻意不在這裡，也不可加進來
  'lineRevoke', 'lineAuthLog',
  // 2026-10-24：貨單核對（PurchaseSso.gs）；永遠不可列進 minikit readActions 與 dryrun READ_ACTIONS
  'svcPurchaseRedeem', 'svcPurchaseWho',
  // 2026-10-26：績效評核（Eval.gs；docs/eval/plan.md）。寫入由 Eval.gs evWithLock_ 自己上鎖，刻意不列 MUTATING_ACTIONS（避免重複取鎖）
  'evSetup', 'evMe', 'evPeerSubmit', 'evSelfSubmit', 'evMyScores', 'evNewbieList', 'evNewbieSubmit', 'evUnitResults', 'evPersonDetail',
  'evSupSave', 'evBankGet', 'evBankSave', 'evTplSave', 'evWageSave', 'evGradeSave', 'evFinalize', 'evUnfinalize', 'evImportPreview', 'evImportCommit',
  // 2026-10-27：營運巡檢（Inspect.gs；docs/inspection/spec.md）。inspMe／inspList／inspGet 讀取；inspSetup／inspSubmit／inspVoid 寫入（inspWithLock_ 自己上鎖）
  'inspSetup', 'inspMe', 'inspList', 'inspGet', 'inspSubmit', 'inspVoid', 'inspBankGet', 'inspBankSave'];
var CODE_MSG_BAD_REQUEST = '請求格式錯誤';
var CODE_MSG_UNKNOWN_ACTION = '不支援的操作';
var CODE_MSG_INTERNAL_ERROR = '系統忙碌中，請稍後再試';

function doPost(e) {
  var result;
  try {
    result = dispatch_(e);
  } catch (err) {
    logInternalError_(err);
    result = { ok: false, error: CODE_MSG_INTERNAL_ERROR };
  }
  return jsonOutput_(result);
}

/** 未預期例外只留在伺服器端記錄，絕不把 err.message 原文送給前端（會洩漏分頁名／函式名等內部結構） */
function logInternalError_(err) {
  var message = (err && err.message) ? err.message : String(err);
  var stack = (err && err.stack) ? err.stack : '';
  console.error('[doPost] unexpected error: ' + message + (stack ? '\n' + stack : ''));
}

function doGet(e) {
  // 健康檢查，不接受任何 action（e 完全不解析）
  return jsonOutput_({ ok: true, data: { service: 'dzy-platform' } });
}

/** 解析 body、白名單檢查、分派到對應 handler。任何格式問題都回一般物件，不拋例外往外丟 */
function dispatch_(e) {
  // 區域快取（Regions.gs）只活在同一次請求：每次進來先清（mini 常駐行程的全域變數會跨請求留著）
  if (typeof regionCtxReset_ === 'function') regionCtxReset_();
  var body = parseJsonBody_(e);
  if (body === null) {
    return { ok: false, error: CODE_MSG_BAD_REQUEST };
  }

  var action = body.action;
  if (typeof action !== 'string' || !action) {
    return { ok: false, error: CODE_MSG_BAD_REQUEST };
  }
  if (CODE_ALLOWED_ACTIONS.indexOf(action) === -1) {
    return { ok: false, error: CODE_MSG_UNKNOWN_ACTION };
  }

  var token = body.token;
  var payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
  var ipHash = codeIpHash_(e);

  // 會寫入試算表的動作要拿全域鎖：Apps Script 允許並發執行，
  // 兩個管理者同時建帳號會各自用 appendRow 前的列數推 id，撞出重複資料列。
  // 唯讀動作（login/me/listUsers/listRoles）不上鎖，登入速度不受影響。
  var MUTATING_ACTIONS = { saveUser: 1, setActive: 1, resetPassword: 1, changePassword: 1,
    claimSubmit: 1, forgotReset: 1, saveMyProfile: 1, staffImport: 1, staffAdd: 1, staffConfirm: 1,
    staffReject: 1, staffSetActive: 1, staffUnclaim: 1, staffUnlockReset: 1, staffEdit: 1,
    logout: 1, unitApprove: 1, unitReject: 1,
    staffCreateByUnit: 1, staffLeave: 1, staffLeaveCancel: 1, staffRename: 1, staffReinstate: 1,
    clockMapBuild: 1, clockMapDecide: 1, clockCandidateCreate: 1, clockCandidateDismiss: 1,
    clockOutboxRetry: 1, clockOutboxCancel: 1, clockSetHome: 1, clockOldHomeDecide: 1, clockLink: 1, clockAddHome: 1,
    orgUpgrade2026: 1, orgRollback2026: 1, orgUpgrade202610: 1, orgRollback202610: 1, orgRename202610: 1, orgRenameRollback202610: 1, orgAddBranddev202610: 1, orgAddBranddevRollback202610: 1, orgEnableMztMc202610: 1, orgEnableMztMcRollback202610: 1,
    permInit: 1, permMapSave: 1, permExSave: 1, permExRevoke: 1, permStoreSave: 1, permAuditSeen: 1,
    apvSetup: 1, apvThresholdSave: 1, apvSubmit: 1, apvResubmit: 1, apvWithdraw: 1, apvDecide: 1, apvSign: 1, apvHandle: 1, apvReassign: 1, apvVoid: 1,
    regionSave: 1, regionSwitch: 1, lineRevoke: 1 };
  if (MUTATING_ACTIONS[action]) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) {
      return { ok: false, error: CODE_MSG_INTERNAL_ERROR };
    }
    try {
      return dispatchAction_(action, token, payload, ipHash);
    } finally {
      lock.releaseLock();
    }
  }
  return dispatchAction_(action, token, payload, ipHash);
}

/**
 * 來源雜湊（2026-10-12）：Apps Script 拿不到 client IP，回空字串（login 改用全域桶）。
 * 執行環境若在事件物件放了 e.clientIp（字串；例如 minikit 執行器從 X-Forwarded-For 最後一段取出），
 * 就取 SHA-256 前 12 bytes 的十六進位（24 字，純英數字，不會觸發公式防護），原始 IP 不落地。
 */
function codeIpHash_(e) {
  var ip = e && typeof e.clientIp === 'string' ? e.clientIp.trim().slice(0, 64) : '';
  if (!ip) return '';
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'dzy-ip:' + ip);
  var hex = '';
  for (var i = 0; i < 12; i++) hex += ((digest[i] + 256) % 256 + 256).toString(16).slice(1);
  return hex;
}

function dispatchAction_(action, token, payload, ipHash) {
  switch (action) {
    case 'login':
      return handleLogin_(payload, ipHash);
    case 'me':
      return handleMe_(token);
    case 'listUsers':
      return handleListUsers_(token);
    case 'saveUser':
      return handleSaveUser_(token, payload);
    case 'setActive':
      return handleSetActive_(token, payload);
    case 'resetPassword':
      return handleResetPassword_(token, payload);
    case 'listRoles':
      return handleListRoles_(token);
    case 'changePassword':
      // 本人改自己的密碼，不需要 platform.users（見 Users.gs §5b 說明）
      return handleChangePassword_(token, payload);
    case 'orgOptions': return handleOrgOptions_();
    case 'claimLookup': return handleClaimLookup_(payload);
    case 'claimSubmit': return handleClaimSubmit_(payload);
    case 'forgotReset': return handleForgotReset_(payload);
    case 'myProfile': return handleMyProfile_(token);
    case 'saveMyProfile': return handleSaveMyProfile_(token, payload);
    case 'myUnit': return handleMyUnit_(token);
    case 'staffList': return handleStaffList_(token);
    case 'staffImport': return handleStaffImport_(token, payload);
    case 'staffAdd': return handleStaffAdd_(token, payload);
    case 'staffConfirm': return handleStaffConfirm_(token, payload);
    case 'staffReject': return handleStaffReject_(token, payload);
    case 'staffSetActive': return handleStaffSetActive_(token, payload);
    case 'staffUnclaim': return handleStaffUnclaim_(token, payload);
    case 'staffUnlockReset': return handleStaffUnlockReset_(token, payload);
    case 'staffEdit': return handleStaffEdit_(token, payload);
    case 'logout': return handleLogout_(token);
    case 'unitPending': return handleUnitPending_(token);
    case 'unitApprove': return handleUnitApprove_(token, payload);
    case 'unitReject': return handleUnitReject_(token, payload);
    case 'staffCreateByUnit': return handleStaffCreateByUnit_(token, payload);
    case 'staffLeave': return handleStaffLeave_(token, payload);
    case 'staffLeaveCancel': return handleStaffLeaveCancel_(token, payload);
    case 'staffRename': return handleStaffRename_(token, payload);
    case 'staffReinstate': return handleStaffReinstate_(token, payload);
    case 'staffUnitList': return handleStaffUnitList_(token, payload);
    case 'clockMapBuild': return handleClockMapBuild_(token);
    case 'clockMapList': return handleClockMapList_(token);
    case 'clockMapDecide': return handleClockMapDecide_(token, payload);
    case 'clockCandidateCreate': return handleClockCandidateCreate_(token, payload);
    case 'clockCandidateDismiss': return handleClockCandidateDismiss_(token, payload);
    case 'clockOutboxRetry': return handleClockOutboxRetry_(token, payload);
    case 'clockSetHome': return handleClockSetHome_(token, payload);
    case 'clockOutboxCancel': return handleClockOutboxCancel_(token, payload);
    case 'clockAddHome': return handleClockAddHome_(token, payload);
    case 'clockOldHomeDecide': return handleClockOldHomeDecide_(token, payload);
    case 'clockLink': return handleClockLink_(token, payload);
    case 'clockJobStatus': return handleClockJobStatus_(token, payload);
    case 'clockAlerts': return handleClockAlerts_(token);
    case 'svcDirectory': return handleSvcDirectory_(payload);
    case 'ssoTicket': return handleSsoTicket_(token, payload);
    case 'svcSsoRedeem': return handleSvcSsoRedeem_(payload);
    case 'orgUpgrade2026': return handleOrgUpgrade_(token, payload);
    case 'orgRollback2026': return handleOrgRollback_(token);
    case 'orgUpgrade202610': return handleOrgUpgrade202610_(token, payload);
    case 'orgRollback202610': return handleOrgRollback202610_(token);
    case 'orgRename202610': return handleOrgRename202610_(token, payload);
    case 'orgRenameRollback202610': return handleOrgRenameRollback202610_(token, payload);
    case 'orgAddBranddev202610': return handleOrgAddBranddev202610_(token, payload);
    case 'orgAddBranddevRollback202610': return handleOrgAddBranddevRollback202610_(token, payload);
    case 'orgEnableMztMc202610': return handleOrgEnableMztMc202610_(token, payload);
    case 'orgEnableMztMcRollback202610': return handleOrgEnableMztMcRollback202610_(token, payload);
    case 'permInit': return handlePermInit_(token);
    case 'permMapGet': return handlePermMapGet_(token);
    case 'permMapSave': return handlePermMapSave_(token, payload);
    case 'permExList': return handlePermExList_(token, payload);
    case 'permExSave': return handlePermExSave_(token, payload);
    case 'permExRevoke': return handlePermExRevoke_(token, payload);
    case 'permStoreGet': return handlePermStoreGet_(token);
    case 'permStoreSave': return handlePermStoreSave_(token, payload);
    case 'myPerms': return handleMyPerms_(token);
    case 'permAuditList': return handlePermAuditList_(token, payload);
    case 'permAuditSeen': return handlePermAuditSeen_(token, payload);
    case 'permWho': return handlePermWho_(token, payload);
    case 'apvThresholdGet': return handleApvThresholdGet_(token);
    case 'apvSetup': return handleApvSetup_(token);
    case 'apvThresholdSave': return handleApvThresholdSave_(token, payload);
    case 'apvRoutePreview': return handleApvRoutePreview_(token, payload);
    case 'apvMine': return handleApvMine_(token, payload);
    case 'apvTodo': return handleApvTodo_(token);
    case 'apvGet': return handleApvGet_(token, payload);
    case 'apvList': return handleApvList_(token, payload);
    case 'apvExport': return handleApvExport_(token, payload);
    case 'apvFileMeta': return handleApvFileMeta_(token, payload);
    case 'apvSubmit': return handleApvSubmit_(token, payload);
    case 'apvResubmit': return handleApvResubmit_(token, payload);
    case 'apvWithdraw': return handleApvWithdraw_(token, payload);
    case 'apvDecide': return handleApvDecide_(token, payload);
    case 'apvSign': return handleApvSign_(token, payload);
    case 'apvHandle': return handleApvHandle_(token, payload);
    case 'apvReassign': return handleApvReassign_(token, payload);
    case 'apvVoid': return handleApvVoid_(token, payload);
    case 'svcStoreRedeem': return handleSvcStoreRedeem_(payload);
    case 'svcStoreWho': return handleSvcStoreWho_(payload);
    case 'svcStoreRoster': return handleSvcStoreRoster_(payload);
    case 'attUpperGaps': return handleAttUpperGaps_(token);
    case 'payrollStaffRoster': return handlePayrollStaffRoster_(token, payload);
    case 'regionList': return handleRegionList_(token);
    case 'regionSave': return handleRegionSave_(token, payload);
    case 'regionCheck': return handleRegionCheck_(token);
    case 'regionSwitch': return handleRegionSwitch_(token, payload);
    case 'lineRevoke': return handleLineRevoke_(token, payload);
    case 'lineAuthLog': return handleLineAuthLog_(token, payload);
    case 'svcPurchaseRedeem': return handleSvcPurchaseRedeem_(payload);
    case 'svcPurchaseWho': return handleSvcPurchaseWho_(payload);
    case 'evSetup': return handleEvSetup_(token);
    case 'evMe': return handleEvMe_(token);
    case 'evPeerSubmit': return handleEvPeerSubmit_(token, payload);
    case 'evSelfSubmit': return handleEvSelfSubmit_(token, payload);
    case 'evMyScores': return handleEvMyScores_(token);
    case 'evNewbieList': return handleEvNewbieList_(token);
    case 'evNewbieSubmit': return handleEvNewbieSubmit_(token, payload);
    case 'evUnitResults': return handleEvUnitResults_(token, payload);
    case 'evPersonDetail': return handleEvPersonDetail_(token, payload);
    case 'evSupSave': return handleEvSupSave_(token, payload);
    case 'evBankGet': return handleEvBankGet_(token, payload);
    case 'evBankSave': return handleEvBankSave_(token, payload);
    case 'evTplSave': return handleEvTplSave_(token, payload);
    case 'evWageSave': return handleEvWageSave_(token, payload);
    case 'evGradeSave': return handleEvGradeSave_(token, payload);
    case 'evFinalize': return handleEvFinalize_(token, payload);
    case 'evUnfinalize': return handleEvUnfinalize_(token, payload);
    case 'evImportPreview': return handleEvImportPreview_(token, payload);
    case 'evImportCommit': return handleEvImportCommit_(token, payload);
    // 2026-10-27：營運巡檢（Inspect.gs；docs/inspection/spec.md）。寫入由 inspWithLock_ 自己上鎖，不列 MUTATING_ACTIONS
    case 'inspSetup': return handleInspSetup_(token);
    case 'inspMe': return handleInspMe_(token);
    case 'inspList': return handleInspList_(token, payload);
    case 'inspGet': return handleInspGet_(token, payload);
    case 'inspSubmit': return handleInspSubmit_(token, payload);
    case 'inspVoid': return handleInspVoid_(token, payload);
    case 'inspBankGet': return handleInspBankGet_(token, payload);
    case 'inspBankSave': return handleInspBankSave_(token, payload);
    default:
      // 理論上到不了這裡（上面白名單已擋），留著防呆
      return { ok: false, error: CODE_MSG_UNKNOWN_ACTION };
  }
}

/** 前端用 Content-Type: text/plain 送 JSON 字串（避開 CORS preflight）；body 不是合法 JSON 一律回 null */
function parseJsonBody_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') return null;
  var parsed;
  try {
    parsed = JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function jsonOutput_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
