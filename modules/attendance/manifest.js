/**
 * modules/attendance/manifest.js — 考勤管理（營運系統 ?only=duty，docs/approver/spec.md §10.4）
 * 選單只對「能核至少一人」或人資主管／管理員顯示：platform.att 是後端衍生權限（StoreOps.gs storeAttGate_），不寫進 roles。
 */
'use strict';

export default {
  id: 'attendance',
  ns: 'attendance',       // 首頁待辦走代轉通道 attendance（2026-10-24，營運系統 spec §17.5）；embed 換入場券仍依模組 id 走平台後端
  backend: 'attendance',
  name: '考勤管理',
  desc: '出勤核定、請假加班審核',
  icon: 'attendance',
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（2026-10-20 Eason；登出管理系統時一起卸載）
  dept: 'hr',
  requires: ['platform.att'],
  // 頁頂分頁＝營運系統出勤核定送來的子分頁（核定工時／申請審核…，依人依店、帶待審數字；platform/tabs.js）；views 只剩一個當進入權限的門（2026-10-20）
  dynamicTabs: true,
  views: [
    { id: 'main', name: '考勤管理', requires: ['platform.att'] }
  ],
  entry: () => import('./index.js')
};
