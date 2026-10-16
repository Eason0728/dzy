/**
 * modules/perms/index.js — 權限設定模組本體（個人帳號第二期，docs/permissions/spec.md §7.1）
 * 分頁分派做法同 modules/me/index.js：mount 一次，同模組換分頁走 onRoute。
 */
'use strict';

import { mountMap } from './views/map.js';
import { mountEx } from './views/ex.js';
import { mountStores } from './views/stores.js';
import { mountAudit } from './views/audit.js';
import { computeAlerts } from './lib.js';

const VIEW_MOUNTERS = { map: mountMap, ex: mountEx, stores: mountStores, audit: mountAudit };
let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountMap;
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
  badge() {
    return null;
  },
  /** 首頁提醒：只給 admin（未讀權限異動、門市單位沒對照稽核店）。讀不到的就略過，不影響其他提醒。 */
  async alerts(ctx) {
    const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
    if (!isAdmin) return [];
    const ok = async (action) => {
      try {
        const r = await ctx.api.call('perms', action, {});
        return r && r.ok && !r.dryrun ? r.data : null;
      } catch (e) { return null; }
    };
    const [map, audit, stores] = await Promise.all([ok('permMapGet'), ok('permAuditList'), ok('permStoreGet')]);
    if (!map && !audit && !stores) return [];
    return computeAlerts({ isAdmin, map, audit, stores });
  }
};
