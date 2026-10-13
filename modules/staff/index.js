/**
 * modules/staff/index.js — 同仁名單模組本體（docs/personnel/spec.md §7.5）
 */
'use strict';

import { mountList } from './views/list.js';
import { mountImport } from './views/import.js';
import { mountClockmap } from './views/clockmap.js';
import { alertRows, staleSyncStores } from '../staff-shared/clock-lib.js';

const VIEW_MOUNTERS = { list: mountList, import: mountImport, clockmap: mountClockmap };

// 首頁 badge() 與 alerts() 同時跑，只共用「還在路上的那一次」staffList；回來就丟掉，
// 不留時間快取——留 3 秒快取時，後台剛匯入／確認完回首頁會看到舊數字（e2e ⑧ 抓到）
let inflight = null;
function loadList(ctx) {
  if (inflight) return inflight;
  inflight = ctx.api.call('staff', 'staffList', {}).finally(() => { inflight = null; });
  return inflight;
}

let currentEl = null;
let viewUnmount = null;

function renderView(el, ctx) {
  if (typeof viewUnmount === 'function') viewUnmount();
  viewUnmount = null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const r = (VIEW_MOUNTERS[ctx.viewId] || mountList)(el, ctx);
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
  async badge(ctx) {
    const a = await alertsOf(ctx);
    return Array.isArray(a) ? a.reduce((n, x) => n + x.count, 0) : null;
  },
  alerts(ctx) {
    return alertsOf(ctx);
  }
};

/** 首頁：待確認開通、資料變更待確認、忘記密碼被鎖住 */
async function alertsOf(ctx) {
  const [res, ca] = await Promise.all([loadList(ctx), ctx.api.call('staff', 'clockAlerts', {}).catch(() => null)]);
  if (!res || !res.ok) return null;
  const s = res.data.staff || [];
  const pending = s.filter((x) => x.status === 'pending').length;
  const change = s.filter((x) => x.status === 'active' && x.has_pending_change).length;
  const locked = s.filter((x) => x.reset_locked).length;
  const out = [];
  if (pending) out.push({ level: 'warn', text: `${pending} 位同仁待確認開通`, view: 'list', params: { f: 'todo' }, count: pending });
  if (change) out.push({ level: 'warn', text: `${change} 位同仁有資料變更待確認`, view: 'list', params: { f: 'todo' }, count: change });
  if (locked) out.push({ level: 'error', text: `${locked} 位同仁忘記密碼被鎖住`, view: 'list', params: { f: 'locked' }, count: locked });
  // 員工名單統一 D5：clockAlerts 每一類一列，點了到對應畫面（失敗待辦單的「重試」鈕在 打卡對照 → 待辦單）
  if (ca && ca.ok && ca.data) {
    alertRows(ca.data, { isHq: true, user: ctx.user }).forEach((r) => out.push({ level: r.level, text: r.text, view: r.view, params: r.params, count: r.count }));
    const stale = staleSyncStores(ca.data.last_sync, new Date());
    if (stale.length) out.push({ level: 'warn', text: `${stale.length} 家店的打卡名冊超過 26 小時沒同步（${stale.join('、')}）`, view: 'clockmap', params: { t: 'jobs' }, count: stale.length });
  }
  return out;
}
