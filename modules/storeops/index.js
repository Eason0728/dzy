/**
 * modules/storeops/index.js — 門市營運：把營運系統整頁嵌進內容區（iframe），並自動登入。
 * 握手與 return 導回都在 embed.js（與 modules/attendance/embed.js 逐字相同）。
 */
'use strict';

import { createEmbed } from './embed.js';

export default createEmbed({
  title: '門市營運',
  query: '',
  allowReturn: true,
  tabs: true,   // 營運系統的選單（依人依店、帶待辦數字）畫在管理系統頁頂，2026-10-20
  tip: '用管理系統帳號自動登入；店長與有權限的同仁會看到對應功能'
});
