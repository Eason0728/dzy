/**
 * modules/ai-help/index.js — 小幫手管理模組本體（docs/ai-helper/spec.md §8、§12.11）
 * 三個分頁：待回答 pending／知識庫 kb／用量 usage。頁頂共用一排：運作狀態、「初始化小幫手」（只在 not_inited 且是系統管理者時出現）、
 * 「暫停／恢復小幫手」（aihPauseSet）、「匯入初始知識庫」（aihKbImport → {added, skipped}）。試跑模式（?dryrun=1）時三顆寫入鈕鎖住。
 * 首頁提醒 alerts()：「小幫手有 N 題待回答」。
 */
'use strict';

import { mountPending } from './views/pending.js';
import { mountKb } from './views/kb.js';
import { mountUsage } from './views/usage.js';
import { h, clear, addStyle, errText, busyBtn, lockIfDryrun } from './lib.js';

const VIEW_MOUNTERS = { pending: mountPending, kb: mountKb, usage: mountUsage };
let currentEl = null;
let viewUnmount = null;
let renderSeq = 0;

/** 頁頂：讀 aihUsage 看有沒有初始化／有沒有暫停，畫對應的按鈕 */
async function mountTop(topEl, ctx, seq, rerender) {
  const r = await ctx.api.call('platform', 'aihUsage', {});
  if (seq !== renderSeq) return;
  clear(topEl);
  const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
  if (r && r.error === 'not_inited') {
    topEl.appendChild(h('span', { class: 'aim-chip is-off', 'data-role': 'top-state' }, '還沒初始化'));
    if (isAdmin) {
      const b = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'setup' }, '初始化小幫手'));
      b.addEventListener('click', async () => {
        if (!(await ctx.ui.confirm('建立小幫手需要的資料表？重按不會蓋掉資料。'))) return;
        const done = busyBtn(b, '初始化中');
        const x = await ctx.api.call('platform', 'aihSetup', {});
        done(true);
        if (!x || !x.ok) { ctx.ui.toast('初始化失敗：' + errText(x), 'danger'); return; }
        if (x.dryrun) { ctx.ui.toast('試跑模式：沒有真的初始化', 'info'); return; }
        ctx.ui.toast('已初始化小幫手', 'ok');
        rerender();
      });
      topEl.appendChild(b);
    } else {
      topEl.appendChild(h('span', { class: 'aim-note' }, '請系統管理者登入後按「初始化小幫手」。'));
    }
    return;
  }
  if (!r || !r.ok) {
    topEl.appendChild(h('span', { class: 'aim-chip is-off' }, '狀態讀不到'));
    topEl.appendChild(h('span', { class: 'aim-note' }, errText(r)));
    return;
  }
  const paused = !!(r.data && r.data.paused);
  topEl.appendChild(h('span', { class: 'aim-chip' + (paused ? ' is-paused' : ''), 'data-role': 'top-state' }, paused ? '小幫手已暫停' : '小幫手運作中'));
  const pauseBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'pause' }, paused ? '恢復小幫手' : '暫停小幫手'));
  pauseBtn.addEventListener('click', async () => {
    const msg = paused ? '恢復小幫手？同仁就又能問問題了。' : '暫停小幫手？暫停後同仁問問題都會得到「暫時無法回答」，直到你恢復。';
    if (!(await ctx.ui.confirm(msg))) return;
    const done = busyBtn(pauseBtn, '處理中');
    const x = await ctx.api.call('platform', 'aihPauseSet', { paused: !paused });
    done(true);
    if (!x || !x.ok) { ctx.ui.toast('操作失敗：' + errText(x), 'danger'); return; }
    if (x.dryrun) { ctx.ui.toast('試跑模式：沒有真的' + (paused ? '恢復' : '暫停'), 'info'); return; }
    ctx.ui.toast(paused ? '已恢復小幫手' : '已暫停小幫手', 'ok');
    rerender();
  });
  topEl.appendChild(pauseBtn);
  const impBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'import' }, '匯入初始知識庫'));
  impBtn.addEventListener('click', async () => {
    if (!(await ctx.ui.confirm('匯入初始知識庫？匯進來的題目都是草稿，要到「知識庫」逐題上架；已經匯過的題目不會重複。'))) return;
    const done = busyBtn(impBtn, '匯入中');
    const x = await ctx.api.call('platform', 'aihKbImport', {});
    done(true);
    if (!x || !x.ok) { ctx.ui.toast('匯入失敗：' + errText(x), 'danger'); return; }
    if (x.dryrun) { ctx.ui.toast('試跑模式：沒有真的匯入', 'info'); return; }
    const d = x.data || {};
    ctx.ui.toast('匯入 ' + (d.added || 0) + ' 題，略過 ' + (d.skipped || 0) + ' 題（已存在）', 'ok');
    rerender();
  });
  topEl.appendChild(impBtn);
}

function renderView(el, ctx) {
  renderSeq += 1;
  const seq = renderSeq;
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  clear(el);
  addStyle(el);
  const wrap = h('div', { class: 'aim-wrap' });
  const top = h('div', { class: 'aim-top', 'data-role': 'ai-top' });
  const body = h('div', { 'data-role': 'ai-body' });
  wrap.appendChild(top); wrap.appendChild(body);
  el.appendChild(wrap);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountPending;
  const r = mounter(body, ctx, {});
  viewUnmount = typeof r === 'function' ? r : null;
  mountTop(top, ctx, seq, () => { if (currentEl) renderView(currentEl, ctx); });
}

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      renderSeq += 1;
      if (typeof viewUnmount === 'function') viewUnmount();
      viewUnmount = null;
      currentEl = null;
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  /** 首頁提醒：小幫手有 N 題待回答（讀不到＝算不出來；還沒初始化＝沒有提醒） */
  async alerts(ctx) {
    const r = await ctx.api.call('platform', 'aihPendingList', { status: 'open' });
    if (r && r.error === 'not_inited') return [];
    if (!r || !r.ok || !r.data) return null;
    const n = typeof r.data.open_count === 'number' ? r.data.open_count : (Array.isArray(r.data.items) ? r.data.items.length : 0);
    return n > 0 ? [{ level: 'warn', text: '小幫手有 ' + n + ' 題待回答', view: 'pending' }] : [];
  }
};
