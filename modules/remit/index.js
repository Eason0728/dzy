/**
 * modules/remit/index.js — 匯款清單模組本體（docs/remit/progress.md）
 * 三個分頁：匯款清單 list、廠商帳戶 vendors、單位會計 accts。
 * 首頁：badge＝待出帳筆數；alerts＝我負責的單位有幾筆待出帳（過了希望付款日的標紅）、沒設定會計的單位有幾筆。
 */
'use strict';

import { mountList } from './views/list.js';
import { mountVendors } from './views/vendors.js';
import { mountAccts } from './views/accts.js';
import { ensureStyle } from './style.js';

const VIEW_MOUNTERS = { list: mountList, vendors: mountVendors, accts: mountAccts };

let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  ensureStyle();
  const r = (VIEW_MOUNTERS[ctx.viewId] || mountList)(el, ctx);
  viewUnmount = typeof r === 'function' ? r : null;
}

async function summary(ctx) {
  const r = await ctx.api.call('remit', 'apvRemitSummary', {});
  return r && r.ok && r.data ? r.data : null;
}

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      if (typeof viewUnmount === 'function') viewUnmount();
      viewUnmount = null;
      currentEl = null;
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  async badge(ctx) {
    const s = await summary(ctx);
    return s ? s.pending : null;
  },
  async alerts(ctx) {
    const s = await summary(ctx);
    if (!s) return null;
    const out = [];
    if (s.mine > 0) out.push({ level: s.overdue > 0 ? 'error' : 'warn', text: `${s.mine} 筆待你出帳${s.overdue > 0 ? `（${s.overdue} 筆已過希望付款日）` : ''}`, view: 'list', params: { mine: '1' }, when: s.overdue > 0 ? 'overdue' : 'today' });
    if (s.unassigned > 0) out.push({ level: 'info', text: `${s.unassigned} 筆待出帳的單位還沒設定會計`, view: 'accts', params: {} });
    if (!out.length && s.pending > 0) out.push({ level: 'info', text: `匯款清單有 ${s.pending} 筆待出帳`, view: 'list', params: {} });
    return out;
  }
};
