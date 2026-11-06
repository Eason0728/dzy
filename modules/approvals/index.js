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
import { buildAlerts, TYPE_LABEL, STATUS } from './lib.js';

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
  },
  /** 手機「待處理 → 我送出的」（2026-11-06）：自己送的單，最近 20 張 */
  async mine(ctx) {
    const r = await ctx.api.call('approvals', 'apvMine', {});
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.forms)) return null;
    return r.data.forms.slice(0, 20).map(mineItem);
  }
};

const MINE_STATE = { signing: 'wait', handling: 'wait', exception: 'wait', done: 'ok', rejected: 'no', withdrawn: 'off', voided: 'off' };

/** 表單簽核一張單 → 殼的清單列（platform/shell.js cleanSegItem） */
export function mineItem(f) {
  const amount = typeof f.amount === 'number' && f.amount > 0 ? ` ${f.amount.toLocaleString('en-US')} 元` : '';
  const who = f.subject && f.subject.name ? `（${f.subject.name}）` : '';
  const note = f.status === 'rejected' && f.reject_note && f.reject_note.note ? `退回：${f.reject_note.note}` : '';
  return {
    text: `${TYPE_LABEL[f.type] || '表單'}${amount}${who}`,
    sub: [String(f.created_at || '').slice(0, 10), note].filter(Boolean).join('・'),
    state: MINE_STATE[f.status] || 'wait',
    stateText: (STATUS[f.status] && STATUS[f.status][0]) || '',
    view: 'mine'
  };
}
