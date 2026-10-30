/**
 * modules/me/index.js — 我的資料模組本體（docs/personnel/spec.md §7.4）
 * 分頁分派做法同 modules/dorm/index.js：mount 一次，同模組換分頁走 onRoute。
 */
'use strict';

import { mountProfile } from './views/profile.js';
import { mountUnit } from './views/unit.js';
import { mountReview } from './views/review.js';
import { mountTeamView } from './views/team.js';
import { mountClockView } from './views/clock.js';
import { alertRows } from '../staff-shared/clock-lib.js';
import { viewerOf } from '../staff-shared/viewer.js';

const VIEW_MOUNTERS = { profile: mountProfile, unit: mountUnit, review: mountReview, team: mountTeamView, clock: mountClockView };
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
  /**
   * 首頁「待辦與異常」：
   * - 單位主管（platform.review）有人等審核 → 「有 N 位同仁等你審核」（黃）。人資／admin（platform.staff）
   *   不在這裡提醒——「同仁名單」模組已經有「N 位同仁待確認開通」，避免同一件事出現兩列。
   * - 自己的資料：被退回（紅）、等確認（黃）、改了組織欄等確認（藍）；系統帳號沒有個人資料 → 空。
   */
  async alerts(ctx) {
    const reviewer = ctx.can('platform.review') && !ctx.can('platform.staff');
    const [res, pend] = await Promise.all([
      ctx.api.call('me', 'myProfile', {}),
      reviewer ? ctx.api.call('me', 'unitPending', {}) : Promise.resolve(null)
    ]);
    if (!res || !res.ok) return null;
    const out = [];
    if (pend && pend.ok && pend.data && Array.isArray(pend.data.people) && pend.data.people.length) {
      out.push({ level: 'warn', text: `有 ${pend.data.people.length} 位同仁等你審核`, view: 'review' });
    }
    // 員工名單統一 D5：店長看自己單位的打卡提醒（總部的同類提醒由「同仁名單」模組負責，這裡不重複）
    if ((ctx.can('platform.review') || ctx.can('platform.unitstaff')) && !ctx.can('platform.staff')) {
      try {
        const ca = await ctx.api.call('me', 'clockAlerts', {});
        if (ca && ca.ok) alertRows(ca.data, viewerOf(ctx)).forEach((r) => out.push({ level: r.level, text: r.text, view: r.view, params: r.params }));
      } catch (e) { /* 算不出來就不顯示，不影響其他提醒 */ }
    }
    const p = res.data || {};
    if (p.none) return out;
    if (p.status === 'rejected') out.push({ level: 'error', text: `資料被退回：${p.reject_reason || '請重新確認'}`, view: 'profile' });
    else if (p.status === 'pending') out.push({ level: 'warn', text: '資料已送出，等後台確認', view: 'profile' });
    else if (p.has_pending_change) out.push({ level: 'info', text: '你改的品牌／單位／職稱等後台確認', view: 'profile' });
    return out;
  }
};
