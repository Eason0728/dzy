/**
 * modules/audit-stock/index.js — 月初盤點抽查模組本體（T2-2）
 *
 * 正本規格：docs/spec.md §4.6（模組本體 mount/unmount/badge/onRoute）、§4.7（ctx，
 * 含 viewId／同一個 ctx 物件原地更新的規則）。
 *
 * 本模組五個分頁（overview／fill／report／analysis／my，見 manifest.js）共用同一次
 * mount()：殼只在「換模組」時呼叫 mount/unmount，同模組內切分頁改叫 onRoute(ctx)
 * （spec §4.6／shell.js route() 的實際行為），所以這裡用 ctx.viewId 分派到對應分頁的
 * mount 函式，並在 onRoute() 時換掉目前掛著的那個分頁。
 *
 * T2-2（overview）之後這次補上 fill（T2-3，稽核填寫）。report／analysis／my 是
 * 後續任務（T2-4、T2-6），屆時只需要在 VIEW_MOUNTERS 補一行對應項目，這支檔案的
 * 分派邏輯不必再動。尚未實作的分頁先顯示「尚未完成」提示，不讓畫面壞掉。
 *
 * badge() 固定回 null：真正的待辦數字等 T2-8 才做（任務指示明載）。
 */
'use strict';

import { mountOverview } from './views/overview.js';
import { mountFill } from './views/fill.js';

const VIEW_MOUNTERS = {
  overview: mountOverview,
  fill: mountFill
  // report / analysis / my：後續任務補上
};

let currentEl = null;
let currentViewUnmount = null;

function teardownCurrentView() {
  if (typeof currentViewUnmount === 'function') {
    try {
      currentViewUnmount();
    } catch (err) {
      console.error('[audit-stock] 分頁 unmount 失敗', err);
    }
  }
  currentViewUnmount = null;
}

function renderView(el, ctx) {
  teardownCurrentView();
  while (el.firstChild) el.removeChild(el.firstChild);

  const mounter = VIEW_MOUNTERS[ctx.viewId];
  if (!mounter) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = '此分頁尚未完成';
    card.appendChild(title);
    el.appendChild(card);
    return;
  }

  const maybeUnmount = mounter(el, ctx);
  currentViewUnmount = typeof maybeUnmount === 'function' ? maybeUnmount : null;
}

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      teardownCurrentView();
      currentEl = null;
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  badge(ctx) {
    return null;
  }
};
