/**
 * modules/staff/views/regions-alerts.js — 同仁名單首頁提醒的「區域」那幾列（docs/regions/spec.md 第 3 節旗標、§4.6 alerts）
 * 快取 10 分鐘（同一位使用者）：區域設定很少變，首頁每次回來不必重打 regionList；區域分頁存檔／切換後呼叫 clearRegionAlerts()。
 */
'use strict';

import { regionAlertRows } from './regions-model.js';

export const REGION_ALERT_TTL_MS = 10 * 60 * 1000;
let cache = null;   // {key, at, rows}

export function clearRegionAlerts() { cache = null; }

/** 沒有 platform.staff 或讀不到 → []（不影響其他提醒） */
export async function regionAlerts(ctx, now) {
  if (!ctx || typeof ctx.can !== 'function' || !ctx.can('platform.staff')) return [];
  const t = typeof now === 'number' ? now : Date.now();
  const key = (ctx.user && ctx.user.id) || '';
  if (cache && cache.key === key && t - cache.at < REGION_ALERT_TTL_MS) return cache.rows;
  let rows = [];
  try {
    const r = await ctx.api.call('staff', 'regionList', {});
    if (!r || !r.ok || r.dryrun) return [];
    rows = regionAlertRows(r.data);
  } catch (e) { return []; }
  cache = { key, at: t, rows };
  return rows;
}
