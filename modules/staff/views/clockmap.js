/**
 * modules/staff/views/clockmap.js — 打卡對照（總部；員工名單統一 D4，spec §4.3 第 4 點）
 * 建立對照、全部對照、需總部處理、候選新人（建立／排除）、舊主店處理、失敗待辦單重試。
 */
'use strict';

import { mountClockMap } from '../../staff-shared/clock-ui.js';

export function mountClockmap(el, ctx) {
  const viewer = { isHq: true, isLead: false, user: ctx.user };
  // 候選新人「建立」要用單位／職稱下拉，先拿 orgOptions；拿不到也不影響其他功能
  const env = { ctx, mod: 'staff', viewer, org: { brands: [], units: [], depts: [], titles: [] } };
  let stop = null;
  let alive = true;
  ctx.api.call('staff', 'orgOptions', {}).then((o) => { if (o && o.ok) env.org = o.data; }).finally(() => {
    if (alive) stop = mountClockMap(el, env);
  });
  return () => { alive = false; if (typeof stop === 'function') stop(); };
}
