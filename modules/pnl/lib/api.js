/**
 * modules/pnl/lib/api.js — 損益後端呼叫（經平台代轉 ns pnl）：統一回 {ok, data}｜{ok:false, error, message}
 *   call(ctx, action, payload)：寫入動作自動帶 client_id（冪等；同一個操作重送不會重複寫入）
 *   waitJob(ctx, jobId, onTick)：mini 上建立草稿／立即拉取／建上月草稿改排隊（plan.md C4），每 3 秒查 getJob，最多 3 分鐘
 */
'use strict';

import { toPageResult } from '../bridge.js';

const WRITE_ACTIONS = ['addEntry', 'voidEntry', 'importEntries', 'uploadAttachment', 'confirmZero', 'finalize', 'unlock', 'saveSettings',
  'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits', 'adminSyncSeed', 'adminApplyS01Connectors', 'adminCreateLastMonthDraft', 'adminLoadStoreSeedS01'];

export function newClientId() {
  const a = new Uint8Array(12);
  globalThis.crypto.getRandomValues(a);
  return 'c' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 呼叫損益後端；網路／代轉錯誤也不丟例外，一律回 {ok:false,...} */
export async function call(ctx, action, payload) {
  const body = Object.assign({}, payload || {});
  if (WRITE_ACTIONS.indexOf(action) !== -1 && !body.client_id) body.client_id = newClientId();
  let r;
  try { r = await ctx.api.call('pnl', action, body); } catch (e) { r = { ok: false, error: '網路連線失敗' }; }
  return toPageResult(r);
}

/** 錯誤 → 給人看的一句話 */
export function errText(r) {
  if (!r) return '發生錯誤，請稍後再試';
  if (r.error === 'AUTH') return '登入已過期，請重新登入管理系統';
  if (r.error === 'FORBIDDEN') return '沒有權限做這件事';
  if (r.error === 'BUSY') return r.message && r.message !== 'BUSY' ? r.message : '系統忙碌中，請稍後再試';
  return r.message || r.error || '發生錯誤，請稍後再試';
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * 輪詢排隊工作直到 done／fail／逾時；回 {ok:true, job}｜{ok:false, error, message}
 * onTick(job)：每次查到狀態就呼叫（畫面顯示「排隊中／執行中」）。opts.intervalMs／timeoutMs 給測試縮短。
 */
export async function waitJob(ctx, jobId, onTick, opts) {
  const interval = (opts && opts.intervalMs) || 3000;
  const deadline = Date.now() + ((opts && opts.timeoutMs) || 3 * 60 * 1000);
  while (Date.now() < deadline) {
    const r = await call(ctx, 'getJob', { job_id: jobId });
    if (!r.ok) return r;
    if (onTick) onTick(r.data);
    if (r.data && (r.data.status === 'done' || r.data.status === 'fail')) return { ok: true, job: r.data };
    await sleep(interval);
  }
  return { ok: false, error: 'TIMEOUT', message: '還在處理中，稍後到設定頁看結果' };
}

/** 回應是排隊（mini）就等工作做完；不是（舊後端直接回結果）就原樣回。回 {ok, data, job?} */
export async function settleQueued(ctx, r, onTick, opts) {
  if (!r || !r.ok || !r.data || r.data.queued !== true || !r.data.job_id) return r;
  const w = await waitJob(ctx, r.data.job_id, onTick, opts);
  if (!w.ok) return w;
  if (w.job.status === 'fail') return { ok: false, error: (w.job.result && w.job.result.code) || 'FAIL', message: (w.job.result && w.job.result.message) || '處理失敗' };
  return { ok: true, data: Object.assign({}, w.job.result || {}, { store_id: w.job.store_id, month: w.job.month }), job: w.job };
}
