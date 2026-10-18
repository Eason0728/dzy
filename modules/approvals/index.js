/**
 * modules/approvals/index.js — 表單簽核模組本體（spec §7）
 * 分頁分派做法同 modules/me/index.js：mount 一次，同模組換分頁走 onRoute。
 */
'use strict';

import { mountSubmit } from './views/submit.js';
import { mountMine } from './views/mine.js';
import { mountSign } from './views/sign.js';
import { mountHandle } from './views/handle.js';
import { mountAll } from './views/all.js';
import { mountThr } from './views/thr.js';
import { buildAlerts } from './lib.js';

const VIEW_MOUNTERS = { submit: mountSubmit, mine: mountMine, sign: mountSign, handle: mountHandle, all: mountAll, thr: mountThr };
let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountSubmit;
  const r = mounter(el, ctx);
  viewUnmount = typeof r === 'function' ? r : null;
}

async function todo(ctx) {
  const r = await ctx.api.call('approvals', 'apvTodo', {});
  return r && r.ok ? (r.data || {}) : null;
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
  /** 卡片數字：待我簽＋待我辦 */
  async badge(ctx) {
    const d = await todo(ctx);
    if (!d) return null;
    const n = (Array.isArray(d.sign) ? d.sign.length : 0) + (Array.isArray(d.handle) ? d.handle.length : 0);
    return n > 0 ? n : null;
  },
  /** 首頁「待辦與異常」：待我簽 N、待我辦 N；卡關（≥72 小時）與找不到簽核人用紅色 */
  async alerts(ctx) {
    const d = await todo(ctx);
    return d ? buildAlerts(d) : null;
  }
};
