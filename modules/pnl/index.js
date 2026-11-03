/**
 * modules/pnl/index.js — 損益試算（原生化 P3，2026-11-03；規格 ~/dzy/docs/pnl-native/spec.md §2）
 * 四頁原生畫面：儀表板、填資料（待補＋五類）、匯入、設定。每次讀寫經平台代轉（ns pnl）到 Mac mini 的損益後端；
 * 不再嵌 mala-pnl.github.io，也沒有任何登入表單。首頁提醒 alerts()：有「填」以上權限才算本月待補。
 */
'use strict';

import { mountDashboard } from './views/dashboard.js';
import { mountEntry } from './views/entry.js';
import { mountImport } from './views/import.js';
import { mountSettings } from './views/settings.js';
import { reset } from './state.js';
import { call } from './lib/api.js';
import { currentMonth, buildAlerts } from './bridge.js';

const ENTRY_VIEWS = ['pending', 'food', 'labor', 'controllable', 'uncontrollable', 'revenue'];
const ALERT_CACHE_MS = 10 * 60 * 1000;

let currentEl = null;
let viewUnmount = null;
let alertCache = null;   // { at, items, promise }

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const v = ctx.viewId;
  let r;
  if (ENTRY_VIEWS.indexOf(v) !== -1) r = mountEntry(el, ctx, v);
  else if (v === 'import') r = mountImport(el, ctx);
  else if (v === 'settings') r = mountSettings(el, ctx);
  else r = mountDashboard(el, ctx);
  viewUnmount = typeof r === 'function' ? r : null;
}

async function loadPending(ctx) {
  const s = await call(ctx, 'getSettings', {});
  const stores = s.ok && s.data && Array.isArray(s.data.stores) ? s.data.stores : null;
  if (!stores) return null;
  const month = currentMonth();
  const rows = await Promise.all(stores.map(async (st) => {
    const r = await call(ctx, 'getMonth', { store_id: st.store_id, month });
    const p = r.ok && r.data && r.data.result ? r.data.result.pending : null;
    return { store_id: st.store_id, name: st.name || st.store_id, count: Array.isArray(p) ? p.length : 0 };
  }));
  return buildAlerts(rows, month);
}

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      if (typeof viewUnmount === 'function') viewUnmount();
      viewUnmount = null;
      currentEl = null;
      reset();
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  /** 首頁「待辦與異常」：有「填」以上權限才算；結果快取 10 分鐘，後端慢時這次不顯示、下次就有 */
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
