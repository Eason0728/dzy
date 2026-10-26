/**
 * modules/transfer-fin/bridge.js — 調撥會計頁（iframe）與管理系統之間的轉接（純函式，node 測試直接 import）
 *
 * 會計頁不拿任何密碼、也拿不到管理系統的登入 token：它把 {type:'dzy-transfer-call', v:1, id, action, payload}
 * postMessage 給父頁（targetOrigin 寫死管理系統網址），父頁（本模組）驗過來源後用 ctx.api.call('transfer', …) 走代轉，
 * 再把結果還原成會計頁原本 fetch 拿到的形狀 {ok:true,data}｜{ok:false,error,code?}，回傳 {type:'dzy-transfer-result', v:1, id, result}。
 */
'use strict';

export const TRANSFER_ORIGIN = 'https://eason0728.github.io';
export const TRANSFER_URL = TRANSFER_ORIGIN + '/mala-transfer/report.html?embed=dzy';
// 本機開發：管理系統跑在 localhost 時，嵌 mala-transfer 的本機伺服器（預設 8787）
// 本機開發：會計頁跟管理系統用同一個主機名（localhost 或 127.0.0.1），兩邊才認得彼此的 origin
export const DEV_TRANSFER_PORT = 8787;

const ACTION_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** 目前環境下會計頁的 origin 與網址 */
export function transferTarget(hostname) {
  const dev = hostname === 'localhost' || hostname === '127.0.0.1';
  const origin = dev ? 'http://' + hostname + ':' + DEV_TRANSFER_PORT : TRANSFER_ORIGIN;
  return { origin, url: origin + (dev ? '/report.html' : '/mala-transfer/report.html') + '?embed=dzy' };
}

/** 驗證一則來自會計頁的呼叫；不合格回 null（直接忽略，不回覆） */
export function parseCall(data) {
  if (!data || typeof data !== 'object' || data.type !== 'dzy-transfer-call' || data.v !== 1) return null;
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) return null;
  if (typeof data.action !== 'string' || !ACTION_RE.test(data.action)) return null;
  const raw = data.payload === undefined || data.payload === null ? {} : data.payload;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const payload = Object.assign({}, raw);
  delete payload.action;
  delete payload.pin_master;   // 會計密碼只在 mini 那邊帶
  delete payload.token;
  delete payload.operator;     // 操作人由平台依登入身分決定
  return { id: data.id, action: data.action, payload };
}

/** ctx.api.call 的結果 → 會計頁原本 fetch 拿到的調撥後端 JSON。
 *  調撥後端回 {ok:true,data:X}｜{ok:false,error,code}；殼的 transformResponse_ 會把整包（去掉 ok）塞進 data，
 *  所以成功時 X 在 r.data.data、失敗時 code 在 r.data.code。試跑模式攔下的寫入一律回失敗，畫面才不會當成成功。 */
export function toPageResult(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: '伺服器回應格式錯誤' };
  if (r.dryrun) return { ok: false, error: '試跑模式，未寫入', code: 'DRYRUN' };
  const d = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
  if (r.ok === true) return { ok: true, data: d.data === undefined ? null : d.data };
  const out = { ok: false, error: String(r.error || '請求失敗') };
  if (typeof d.code === 'string' && d.code) out.code = d.code;
  return out;
}

/** 會計頁的分頁（由管理系統的分頁列畫，會計頁自己的選單在嵌入時隱藏）。
 *  id＝會計頁分頁代碼；manifest.js 的 views 要跟這裡一致（測試比對）。 */
export const TRANSFER_PAGES = [
  ['report', '月報'], ['memory', '品項記憶'], ['overview', '卡關總覽']
];

/** 管理系統換分頁 → 通知會計頁切換的訊息；不認得的分頁一律回月報 */
export function navMessage(viewId) {
  const ok = TRANSFER_PAGES.some((x) => x[0] === viewId);
  return { type: 'dzy-transfer-nav', v: 1, p: ok ? viewId : 'report' };
}
