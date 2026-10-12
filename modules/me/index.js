/**
 * modules/me/index.js — 我的資料模組本體（docs/personnel/spec.md §7.4）
 * 分頁分派做法同 modules/dorm/index.js：mount 一次，同模組換分頁走 onRoute。
 */
'use strict';

import { mountProfile } from './views/profile.js';
import { mountUnit } from './views/unit.js';

const VIEW_MOUNTERS = { profile: mountProfile, unit: mountUnit };
let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountProfile;
  const r = mounter(el, ctx);
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
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  /** 首頁「待辦與異常」：被退回（紅）、等後台確認（黃）；系統帳號沒有個人資料 → 空 */
  async alerts(ctx) {
    const res = await ctx.api.call('me', 'myProfile', {});
    if (!res || !res.ok) return null;
    const p = res.data || {};
    if (p.none) return [];
    if (p.status === 'rejected') return [{ level: 'error', text: `資料被退回：${p.reject_reason || '請重新確認'}`, view: 'profile' }];
    if (p.status === 'pending') return [{ level: 'warn', text: '資料已送出，等後台確認', view: 'profile' }];
    if (p.has_pending_change) return [{ level: 'info', text: '你改的品牌／單位／職稱等後台確認', view: 'profile' }];
    return [];
  }
};
