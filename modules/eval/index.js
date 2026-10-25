/**
 * modules/eval/index.js — 績效評核模組本體（分頁分派做法同 modules/approvals/index.js）
 */
'use strict';

import { mountFill } from './views/fill.js';
import { mountSelf } from './views/self.js';
import { mountMine } from './views/mine.js';
import { mountNewbie } from './views/newbie.js';
import { mountResults } from './views/results.js';
import { mountSettings } from './views/settings.js';
import { addStyle } from './lib.js';

const VIEW_MOUNTERS = { fill: mountFill, self: mountSelf, mine: mountMine, newbie: mountNewbie, results: mountResults, settings: mountSettings };
let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  addStyle(el);
  const host = document.createElement('div');
  host.className = 'ev-wrap';
  el.appendChild(host);
  const mounter = VIEW_MOUNTERS[ctx.viewId] || mountFill;
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
  },
  /** 首頁提醒：填寫期間還沒送出互評／自評；店長有待考核新人 */
  async alerts(ctx) {
    const r = await ctx.api.call('eval', 'evMe', {});
    if (!r || !r.ok || !r.data) return null;
    const d = r.data;
    const out = [];
    if (d.evaluable && d.windowOpen && d.bankReady) {
      if (!d.peerDone) out.push({ level: 'warn', text: '本季績效互評還沒填（每季第一個月 1～5 號）', view: 'fill' });
      if (!d.selfDone) out.push({ level: 'warn', text: '本季自評還沒填', view: 'self' });
    }
    if (d.perms && d.perms.manage) {
      const n = await ctx.api.call('eval', 'evNewbieList', {});
      const due = n && n.ok ? (n.data.list || []).filter((x) => x.state === 'due') : [];
      if (due.length) out.push({ level: due.some((x) => x.late) ? 'error' : 'warn', text: `${due.length} 位新人到職滿一個月，待考核`, view: 'newbie' });
    }
    return out.length ? out : null;
  }
};
