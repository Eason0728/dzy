/**
 * modules/inspection/index.js — 營運巡檢模組本體（分頁分派做法同 modules/eval/index.js）
 */
'use strict';

import { mountList } from './views/list.js';
import { mountFill } from './views/fill.js';
import { mountBank } from './views/bank.js';
import { addStyle } from './lib.js';

const VIEW_MOUNTERS = { list: mountList, fill: mountFill, bank: mountBank };
let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  addStyle(el);
  const host = document.createElement('div');
  host.className = 'ip-wrap';
  el.appendChild(host);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountList;
  const r = mounter(host, ctx);
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
  }
};
