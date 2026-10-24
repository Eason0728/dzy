/**
 * platform/dryrun.js — 試跑模式（?dryrun=1）的共用判斷與提示（2026-10-12 安全修補）
 *
 * 試跑模式：讀取照常走真實後端，寫入一律攔下不送出。給「請人用正式資料試用」時用，
 * 避免「試按一下送出」變成一筆假資料寫進正式試算表。
 *
 * 本檔零依賴（api.js 與 auth.js 互相 import，共用邏輯放這裡才不會循環）。
 * 白名單原則：每個 backend 只列「確定是讀取」的 action；沒列到的一律當寫入擋
 * （往關的方向失敗）。新增讀取 action 時要來這裡補，否則試跑模式下會被擋。
 */

'use strict';

/** 每個 backend 的讀取 action 白名單（逐一對照 modules/*、platform/ 的呼叫點與後端 handler 確認）。 */
export const READ_ACTIONS = {
  platform: ['login', 'me', 'listUsers', 'listRoles', 'orgOptions', 'claimLookup',
    'myProfile', 'myUnit', 'staffList', 'unitPending',
    // 員工名單統一（2026-10-13）：單位名單、打卡對照清單、首頁提醒是純讀取
    // clockJobStatus 刻意不列：查 link 單會從快取取走並刪掉一次性金鑰（有副作用）；試跑時新增／取連結本來就被攔，前端不輪詢
    'staffUnitList', 'clockMapList', 'clockAlerts',
    // logout 不是資料寫入（只讓自己的登入失效），試跑模式也要真的登出（2026-10-12）
    'logout',
    // 公告專區換佈告欄入場券（2026-10-16）：只在快取放一張 60 秒的券，不寫任何資料；試跑時也要能自動登入佈告欄
    'ssoTicket',
    // 個人帳號第二期（2026-10-17）：權限設定的純讀取；permInit／permMapSave／permEx*／permStoreSave／permAuditSeen 不列（寫入，試跑會攔）
    'permMapGet', 'permExList', 'permStoreGet', 'myPerms', 'permAuditList', 'permWho',
    // 第三期表單簽核（2026-10-18）：純讀取；apvSubmit／apvResubmit／apvWithdraw／apvDecide／apvSign／apvHandle／apvReassign／apvVoid／apvThresholdSave 不列（寫入，試跑會攔）
    'apvThresholdGet', 'apvRoutePreview', 'apvMine', 'apvTodo', 'apvGet', 'apvList', 'apvExport', 'apvFileMeta'],
  audit: ['getAll'],
  dorm: ['rooms', 'list', 'contract', 'handover'],
  // 薪酬系統（2026-10-19）：必須與 Auth.gs PROXY_READ_ACTIONS.payroll 一致（test/proxy-authorize.test.mjs 比對）
  payroll: ['payroll_month', 'payroll_get', 'payroll_group', 'payroll_trend', 'payroll_inputs', 'payroll_punch',
    'payroll_master_get', 'payroll_store_get', 'payroll_leave_type_get', 'payroll_leave_event_get', 'payroll_leave_options',
    'payroll_attendance_export'],
  // 考勤管理首頁待辦（2026-10-24，營運系統 spec §17.5）：必須與 Auth.gs PROXY_READ_ACTIONS.attendance 一致；只回件數的純讀取
  attendance: ['attAlerts']
};

/**
 * audit／dorm 代轉的「寫入」action 白名單（必須與 apps-script/platform/Auth.gs PROXY_WRITE_ACTIONS 一致，
 * test/proxy-authorize.test.mjs 有比對）。新增前端寫入 action 時兩邊都要補，否則後端會拒絕。
 */
export const WRITE_ACTIONS = {
  audit: ['submitAudit', 'markRest', 'submitOpsAudit', 'addStore', 'setStoreStatus', 'renameStore'],
  dorm: ['create', 'terminate', 'handoverCreate', 'handoverSign'],
  payroll: ['payroll_calc', 'payroll_finalize', 'payroll_bootstrap', 'payroll_master_set', 'payroll_config_set', 'payroll_holiday_sync',
    'payroll_input_set', 'payroll_bonus_set', 'payroll_store_set', 'payroll_leave_type_set', 'payroll_leave_event_set']
};

export const DRYRUN_MESSAGE = '試跑模式，未寫入';

/** 網址帶 ?dryrun=1 就進入試跑模式。非瀏覽器環境（node 測試）預設不啟用，可用 __setDryRun 覆寫。 */
let override = null;
export function __setDryRun(v) { override = (v === true || v === false) ? v : null; }

export function isDryRun() {
  if (override !== null) return override;
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    return new URLSearchParams(window.location.search).get('dryrun') === '1';
  } catch {
    return false;
  }
}

/**
 * 這次呼叫是不是「讀取」。拿不準一律 false（當寫入擋）。
 * staffImport／staffReinstate 帶 preview:true 只回預覽、後端在寫入前就 return，視為讀取。
 */
export function isReadAction(backendId, action, payload) {
  const list = READ_ACTIONS[backendId];
  if (Array.isArray(list) && list.includes(action)) return true;
  if (backendId === 'platform' && action === 'staffImport'
    && payload && payload.preview === true) return true;
  // 切換組織先 dryrun:true 預覽（Staff.gs 在寫入前就 return）視為讀取；dryrun:false 與 orgRollback2026 仍攔
  if (backendId === 'platform' && action === 'orgUpgrade2026'
    && payload && payload.dryrun === true) return true;
  // 2026-10-20 職稱調整同一套：dryrun:true 預覽放行；dryrun:false 與 orgRollback202610 仍攔
  if (backendId === 'platform' && action === 'orgUpgrade202610'
    && payload && payload.dryrun === true) return true;
  // 2026-10-23 名稱調整同一套：dryrun:true 預覽放行；dryrun:false 與 orgRenameRollback202610 仍攔
  if (backendId === 'platform' && action === 'orgRename202610'
    && payload && payload.dryrun === true) return true;
  // 2026-10-23 新增品牌發展部同一套：dryrun:true 預覽放行；dryrun:false 與 orgAddBranddevRollback202610 仍攔
  if (backendId === 'platform' && action === 'orgAddBranddev202610'
    && payload && payload.dryrun === true) return true;
  // 復職先 preview（只回舊對照清單、後端在寫入前就 return）視為讀取
  if (backendId === 'platform' && action === 'staffReinstate'
    && payload && payload.preview === true) return true;
  return false;
}

let notifier = null;
/** shell 啟動時註冊（ui.toast）；沒註冊就只寫 console。 */
export function setDryRunNotifier(fn) { notifier = (typeof fn === 'function') ? fn : null; }

const SENSITIVE_KEY = /pass|secret|token|birthday|phone|addr|id_no/i;

/** 遞迴遮罩：鍵名含密碼、金鑰、憑證、生日、電話、地址、身分證者一律換成 '***'。回傳新物件，不改原值。 */
export function maskPayload(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '***';
  if (Array.isArray(value)) return value.map((v) => maskPayload(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '***' : maskPayload(value[k], depth + 1);
  }
  return out;
}

/** 只印 backendId 與 action；payload 不進主控台（參數保留是為了相容舊呼叫）。 */
export function notifyDryRun(backendId, action, _payload) {
  try { console.warn(`[${DRYRUN_MESSAGE}] ${backendId}/${action}`); } catch { /* ignore */ }
  if (notifier) { try { notifier(DRYRUN_MESSAGE); } catch { /* ignore */ } }
}
