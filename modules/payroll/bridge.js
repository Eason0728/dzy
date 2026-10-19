/**
 * modules/payroll/bridge.js — 薪酬頁（iframe）與管理系統之間的轉接（純函式，node 測試直接 import）
 *
 * 薪酬頁不拿任何金鑰、也拿不到管理系統的登入 token：它把 {type:'dzy-payroll-call', v:1, id, action, body}
 * postMessage 給父頁（targetOrigin 寫死管理系統網址），父頁（本模組）驗過來源後用 ctx.api.call('payroll', …) 走代轉，
 * 再把結果還原成薪酬頁原本認得的扁平形狀 {ok, …} 回傳 {type:'dzy-payroll-result', v:1, id, result}。
 */
'use strict';

export const PAYROLL_ORIGIN = 'https://eason0728.github.io';
export const PAYROLL_URL = PAYROLL_ORIGIN + '/mala-clock-in/payroll.html';
// 本機開發：管理系統跑在 localhost 時，嵌 mala-clock-in 的 mock 伺服器（mock/mock_server.py，預設 8911）
export const DEV_PAYROLL_ORIGIN = 'http://localhost:8911';

const ACTION_RE = /^payroll_[a-z_]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** 目前環境下薪酬頁的 origin 與網址 */
export function payrollTarget(hostname) {
  const dev = hostname === 'localhost' || hostname === '127.0.0.1';
  const origin = dev ? DEV_PAYROLL_ORIGIN : PAYROLL_ORIGIN;
  return { origin, url: origin + (dev ? '/payroll.html' : '/mala-clock-in/payroll.html') + '?embed=dzy' };
}

/** 驗證一則來自薪酬頁的呼叫；不合格回 null（直接忽略，不回覆） */
export function parseCall(data) {
  if (!data || typeof data !== 'object' || data.type !== 'dzy-payroll-call' || data.v !== 1) return null;
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) return null;
  if (typeof data.action !== 'string' || !ACTION_RE.test(data.action)) return null;
  const body = data.body === undefined || data.body === null ? {} : data.body;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const payload = Object.assign({}, body);
  delete payload.action;
  delete payload.admin_key;   // 金鑰只在 mini 那邊帶
  delete payload.token;
  return { id: data.id, action: data.action, payload };
}

/** ctx.api.call 的結果（{ok,data}／{ok:false,error,data?,status?}）→ 薪酬頁原本的扁平回應 */
export function toPageResult(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: 'bad_response', message: '伺服器回應格式錯誤' };
  const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
  if (r.ok === true) return Object.assign({}, data, { ok: true });
  const out = Object.assign({}, data, { ok: false, error: String(r.error || '請求失敗') });
  // 代轉層的錯誤（沒有權限、逾時、登入失效）薪酬頁原本不認得：補 message 讓它的 toast 顯示中文
  if (r.status || !('error' in data)) {
    if (typeof out.message !== 'string' || !out.message) out.message = out.error;
  }
  return out;
}
