/**
 * modules/cashbook/state.js — 四個分頁共用的選擇（店別、月份）與店別清單快取。
 * 模組 unmount（保留 30 分鐘到期或登出）時 reset()，下次進來重新開始。
 */
'use strict';

import { defaultMonth } from './lib/util.js';

export const sel = { store: '', month: '' };
let storesCache = null;

export function reset() {
  sel.store = '';
  sel.month = '';
  storesCache = null;
}

/** 店別清單 [{code,name}]；失敗回 {ok:false,error}。換分頁不重讀（要看新店重進模組） */
export async function getStores(ctx, force) {
  if (storesCache && !force) return { ok: true, stores: storesCache };
  const r = await ctx.api.call('cashbook', 'adminStores', {});
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '' , raw: r };
  const list = Array.isArray(r.data && r.data.stores) ? r.data.stores.filter((s) => s && s.code) : [];
  storesCache = list;
  return { ok: true, stores: list };
}

/** 把網址參數／上次選的／清單第一家 合成目前店別；月份同理 */
export function settle(stores, params, now) {
  const want = (params && params.store) || sel.store;
  sel.store = stores.some((s) => s.code === want) ? want : (stores[0] ? stores[0].code : '');
  const m = (params && params.month) || sel.month || defaultMonth(now || new Date());
  sel.month = /^\d{4}-\d{2}$/.test(m) ? m : defaultMonth(now || new Date());
  return sel;
}
