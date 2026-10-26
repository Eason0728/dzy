/**
 * modules/purchase/counts.js — 首頁「待辦與異常」的貨單張數（Q5-A；docs/purchase-fin/spec.md §3）
 * 取一張入場券 → POST <貨單後端>/sso/counts {ticket} → {review, failed}（只看這個人管的品牌）。
 * badge() 與 alerts() 同一次首頁載入共用一個結果（10 秒內不重抓），免得一次首頁燒兩張券。
 * 任何失敗都回 null（首頁顯示「暫時讀不到」），不擋首頁。
 */
'use strict';

import { isDevHost } from './embed.js';

const PROD_API = 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/purchase/api';
const DEV_API = 'http://localhost:8794/purchase/api';
const SHARE_MS = 10000;
const FETCH_TIMEOUT_MS = 4500; // 首頁每組 5 秒逾時

export function purchaseApi(host) { return isDevHost(host) ? DEV_API : PROD_API; }

/** 後端回的張數 → 首頁提醒列；0 張不列（全部 0＝空陣列＝「沒有待辦」） */
export function countAlerts(c) {
  const out = [];
  if (c.review > 0) out.push({ level: 'warn', text: `貨單待核對 ${c.review} 張`, view: 'main', params: { tab: 'review' } });
  if (c.failed > 0) out.push({ level: 'error', text: `貨單辨識失敗 ${c.failed} 張`, view: 'main', params: { tab: 'failed' } });
  return out;
}

/** 後端回應 → {review, failed}；形狀不對回 null */
export function parseCounts(j) {
  if (!j || j.ok !== true || !j.data) return null;
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const review = n(j.data.review), failed = n(j.data.failed);
  return review === null || failed === null ? null : { review, failed };
}

let shared = null; // { at, p }

export function getCounts(ctx, deps) {
  const now = Date.now();
  if (shared && now - shared.at < SHARE_MS) return shared.p;
  const p = fetchCounts(ctx, deps).catch(() => null);
  shared = { at: now, p };
  return p;
}

async function fetchCounts(ctx, deps) {
  const doFetch = (deps && deps.fetch) || fetch;
  const host = (deps && deps.host) || (typeof location !== 'undefined' ? location.hostname : '');
  const r = await ctx.api.call('purchase', 'ssoTicket', { aud: 'purchase' });
  const ticket = r && r.ok && r.data ? r.data.ticket : '';
  if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await doFetch(purchaseApi(host) + '/sso/counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal: ctl ? ctl.signal : undefined
    });
    return parseCounts(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 測試用：清掉共用結果 */
export function _resetShared() { shared = null; }
