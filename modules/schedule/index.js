/**
 * modules/schedule/index.js — 排班管理：嵌入營運系統「自動排班」單一功能（&only=schedule）。
 * 握手在 embed.js（與 modules/storeops/embed.js、modules/attendance/embed.js 逐字相同）。這個模組不處理 return 導回。
 */
'use strict';

import { createEmbed } from './embed.js';

export default createEmbed({
  title: '排班管理',
  query: '&only=schedule',
  allowReturn: false,
  tabs: true,   // 自動排班的四個分頁畫在管理系統頁頂
  tip: '只顯示自動排班；只有本店店長、人資主管、管理員可以排班，其他主管只能查看'
});
