/**
 * modules/schedule/index.js — 排班管理：嵌入營運系統「自動排班」單一功能（&only=schedule）。
 * 握手在 embed.js（與 modules/storeops/embed.js、modules/attendance/embed.js 逐字相同）。這個模組不處理 return 導回。
 */
'use strict';

import { createEmbed } from './embed.js';
import { unwrap, toAlerts, toBadge } from './alerts.js';

const embed = createEmbed({
  title: '排班管理',
  query: '&only=schedule',
  allowReturn: false,
  tabs: true,   // 自動排班的四個分頁畫在管理系統頁頂
  forceGo: ['self', 'approve', 'fixed', 'fixedstaff'],   // 總部／央廚排班分頁：在門市時頁頂沒有，一律送 go，由營運系統自動切店
  tip: '只顯示自動排班；只有本店店長、人資主管、管理員可以排班，其他主管只能查看'
});

// 首頁待辦與側邊欄數字（2026-10-24，hr-move-spec §5）：走代轉 ns schedule／action schedAlerts，只有店名與期別
async function fetchAlerts(ctx) {
  try { return unwrap(await ctx.api.call('schedule', 'schedAlerts')); } catch (e) { return null; }
}

export default {
  ...embed,
  async alerts(ctx) { return toAlerts(await fetchAlerts(ctx)); },
  async badge(ctx) { return toBadge(await fetchAlerts(ctx)); }
};
