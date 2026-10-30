/**
 * modules/attendance/index.js — 考勤管理：嵌入營運系統「出勤核定」單一功能（&only=duty）。
 * 握手在 embed.js（與 modules/storeops/embed.js 逐字相同）。這個模組不處理 return 導回。
 */
'use strict';

import { createEmbed } from './embed.js';
import { unwrap, toAlerts, toBadge, toGapAlert, toHoursGapAlert } from './alerts.js';

const embed = createEmbed({
  title: '考勤管理',
  query: '&only=duty',
  allowReturn: false,
  tabs: true,   // 出勤核定的子分頁畫在管理系統頁頂、跟「考勤管理」同一列，2026-10-20
  tip: '只顯示出勤核定；可核定的人與考勤店由系統依組織決定'
});

// 首頁待辦與側邊欄數字（2026-10-24，營運系統 spec §17.5）：走代轉 ns attendance／action attAlerts，只有件數
async function fetchAlerts(ctx) {
  try { return unwrap(await ctx.api.call('attendance', 'attAlerts')); } catch (e) { return null; }
}

// 值班主管本人的申請找不到上層（2026-10-28，docs/req-upper）：平台後端 attUpperGaps，只有人資主管／管理員回得出內容；失敗當沒有
async function fetchGaps(ctx) {
  try {
    const r = await ctx.api.call('platform', 'attUpperGaps');
    return [toGapAlert(r), toHoursGapAlert(r)].filter(Boolean);   // 申請找不到上層＋工時沒人核（2026-10-30）
  } catch (e) { return []; }
}

export default {
  ...embed,
  async alerts(ctx) {
    const [data, gaps] = await Promise.all([fetchAlerts(ctx), fetchGaps(ctx)]);
    const out = toAlerts(data);
    if (out && gaps.length && !(data && data.pending === true)) gaps.forEach((g) => out.push(g));
    return out;
  },
  async badge(ctx) { return toBadge(await fetchAlerts(ctx)); }
};
