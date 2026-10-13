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
    'logout'],
  audit: ['getAll'],
  dorm: ['rooms', 'list', 'contract', 'handover']
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
  // 復職先 preview（只回舊對照清單、後端在寫入前就 return）視為讀取
  if (backendId === 'platform' && action === 'staffReinstate'
    && payload && payload.preview === true) return true;
  return false;
}

let notifier = null;
/** shell 啟動時註冊（ui.toast）；沒註冊就只寫 console。 */
export function setDryRunNotifier(fn) { notifier = (typeof fn === 'function') ? fn : null; }

export function notifyDryRun(backendId, action, payload) {
  try { console.warn(`[${DRYRUN_MESSAGE}] ${backendId}/${action}`, payload); } catch { /* ignore */ }
  if (notifier) { try { notifier(DRYRUN_MESSAGE); } catch { /* ignore */ } }
}
