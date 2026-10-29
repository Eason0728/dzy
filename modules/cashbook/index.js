/**
 * modules/cashbook/index.js — 收支管理模組本體（docs/cashbook-fin/spec.md §7）
 * 四個分頁都是原生畫面；首頁提醒 alerts()：每月 1–10 日，上個月還沒被會計鎖的店。
 */
'use strict';

import { mountRows } from './views/rows.js';
import { mountLock } from './views/lock.js';
import { mountExport } from './views/export.js';
import { mountSubjects } from './views/subjects.js';
import { reset } from './state.js';
import { alertMonth, monthNum, isLocked, storesToAlert } from './lib/util.js';

const VIEW_MOUNTERS = { rows: mountRows, lock: mountLock, export: mountExport, subjects: mountSubjects };

let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const r = (VIEW_MOUNTERS[ctx.viewId] || mountRows)(el, ctx);
  viewUnmount = typeof r === 'function' ? r : null;
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
  /** 每月 1–10 日：上個月還沒被會計鎖的店（沒有帳的店不算） */
  async alerts(ctx) {
    const month = alertMonth(new Date());
    if (!month) return [];
    const st = await ctx.api.call('cashbook', 'adminStores', {});
    if (!st || !st.ok) return null;
    const stores = Array.isArray(st.data && st.data.stores) ? st.data.stores : [];
    const locksByStore = {};
    const liveByStore = {};
    let unreadable = false;   // 某店鎖定或明細讀不到：不能斷言它「還沒月結」（2026-10-29 資料帶入測試），改列一行「暫時讀不到」
    await Promise.all(stores.map(async (s) => {
      const r = await ctx.api.call('cashbook', 'adminLocks', { store: s.code });
      if (!(r && r.ok && Array.isArray(r.data && r.data.locks))) { locksByStore[s.code] = null; unreadable = true; return; }
      locksByStore[s.code] = r.data.locks.filter(isLocked);
      // 已被會計鎖的不必再查有沒有帳；其餘才讀上個月明細，確認真的有帳可月結
      const acct = locksByStore[s.code].some((x) => x.month === month && x.lockedVia === 'acct');
      if (acct) return;
      const l = await ctx.api.call('cashbook', 'adminList', { store: s.code, month });
      if (l && l.ok && Array.isArray(l.data && l.data.rows)) liveByStore[s.code] = l.data.rows.some((x) => x && x.status !== '作廢');
      else { liveByStore[s.code] = null; unreadable = true; }
    }));
    const out = storesToAlert(stores, locksByStore, month, liveByStore)
      .map((s) => ({ level: 'warn', text: `${s.name || s.code} ${monthNum(month)} 月還沒月結`, view: 'lock', params: { store: s.code, month } }));
    if (unreadable) out.push({ level: 'note', text: '部分門市暫時讀不到，稍後再看' });
    return out;
  }
};
