/**
 * modules/pnl/index.js — 損益系統：把損益網頁整頁嵌進內容區（iframe），呼叫一律由本模組代轉（見 bridge.js）。
 * 只理會「這個 iframe 本身」且 origin 正確的訊息；回覆時 targetOrigin 寫死損益網頁網址。
 */
'use strict';

import { pnlTarget, parseCall, toPageResult, navMessage, currentMonth, buildAlerts } from './bridge.js';

const LOAD_TIMEOUT_MS = 20000;
const ALERT_CACHE_MS = 10 * 60 * 1000;
let state = null;   // { el, ctx, frame, target, down, timer, ready }
let alertCache = null;   // { at, items, promise }

function clearDown() {
  if (!state) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.down && state.down.parentNode) state.down.parentNode.removeChild(state.down);
  state.down = null;
}

function sendNav() {
  if (!state || !state.ready || !state.frame.contentWindow) return;
  state.frame.contentWindow.postMessage(navMessage(state.ctx.viewId), state.target.origin);
}

function showDown() {
  if (!state || state.down) return;
  const n = document.createElement('div');
  n.className = 'card';
  n.setAttribute('data-role', 'pnl-down');
  n.textContent = '損益系統暫時連不上，請稍後重新整理。';
  state.el.insertBefore(n, state.frame);
  state.down = n;
}

async function onMessage(e) {
  if (!state || e.origin !== state.target.origin || e.source !== state.frame.contentWindow) return;
  const d = e.data;
  if (d && d.type === 'dzy-pnl-ready' && d.v === 1) { clearDown(); state.ready = true; sendNav(); return; }
  const call = parseCall(d);
  if (!call) return;
  const frame = state.frame, origin = state.target.origin, ctx = state.ctx;
  let r;
  try { r = await ctx.api.call('pnl', call.action, call.payload); } catch (err) { r = { ok: false, error: '網路連線失敗，請稍後再試', status: 0 }; }
  if (!state || state.frame !== frame || !frame.contentWindow) return;   // 已切走
  frame.contentWindow.postMessage({ type: 'dzy-pnl-result', v: 1, id: call.id, result: toPageResult(r) }, origin);
}

/** 讀各店本月待補項數；失敗回 null（首頁就不顯示，不報錯） */
async function loadPending(ctx) {
  const s = await ctx.api.call('pnl', 'getSettings', {});
  const stores = s && s.ok && s.data && s.data.data && Array.isArray(s.data.data.stores) ? s.data.data.stores : null;
  if (!stores) return null;
  const month = currentMonth();
  const rows = await Promise.all(stores.map(async (st) => {
    const r = await ctx.api.call('pnl', 'getMonth', { store_id: st.store_id, month });
    const p = r && r.ok && r.data && r.data.data && r.data.data.result ? r.data.data.result.pending : null;
    return { store_id: st.store_id, name: st.name || st.store_id, count: Array.isArray(p) ? p.length : 0 };
  }));
  return buildAlerts(rows, month);
}

export default {
  mount(el, ctx) {
    const target = pnlTarget(location.hostname);
    const bar = document.createElement('div');
    bar.className = 'bulletin-bar';
    bar.textContent = '損益數字只有財務部門與被開通「損益系統」權限的人看得到；所有修改都會記錄是誰做的。';
    const frame = document.createElement('iframe');
    frame.title = '損益系統';
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'pnl-frame');
    frame.addEventListener('error', () => showDown());
    state = { el, ctx, frame, target, down: null, timer: null, ready: false };
    window.addEventListener('message', onMessage);
    el.appendChild(bar);
    el.appendChild(frame);
    state.timer = setTimeout(showDown, LOAD_TIMEOUT_MS);
    frame.src = target.url;
    return function unmount() {
      window.removeEventListener('message', onMessage);
      clearDown();
      state = null;
      while (el.firstChild) el.removeChild(el.firstChild);
    };
  },
  onRoute(ctx) {
    if (!state) return;
    state.ctx = ctx;
    sendNav();
  },
  /** 首頁「待辦與異常」（Q7）：有「填」以上權限才算；結果快取 10 分鐘，Apps Script 慢時這次不顯示、下次就有 */
  async alerts(ctx) {
    if (!(ctx.can('pnl.write') || ctx.can('pnl.admin'))) return [];
    const now = Date.now();
    if (alertCache && alertCache.items && now - alertCache.at < ALERT_CACHE_MS) return alertCache.items;
    if (!alertCache || !alertCache.promise) {
      const entry = { at: 0, items: alertCache ? alertCache.items : null, promise: null };
      entry.promise = loadPending(ctx).then((items) => {
        entry.promise = null;
        if (items) { entry.items = items; entry.at = Date.now(); }
        return entry.items;
      }, () => { entry.promise = null; return entry.items; });
      alertCache = entry;
    }
    const items = await alertCache.promise;
    return items || [];
  }
};
