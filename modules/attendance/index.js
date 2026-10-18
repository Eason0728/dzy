/**
 * modules/attendance/index.js — 考勤管理：嵌入營運系統「出勤核定」單一功能（&only=duty）。
 * 握手在 embed.js（與 modules/storeops/embed.js 逐字相同）。這個模組不處理 return 導回。
 */
'use strict';

import { createEmbed } from './embed.js';

export default createEmbed({
  title: '考勤管理',
  query: '&only=duty',
  allowReturn: false,
  tip: '只顯示出勤核定；可核定的人與考勤店由系統依組織決定'
});
