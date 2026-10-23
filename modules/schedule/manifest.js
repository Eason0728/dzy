/**
 * modules/schedule/manifest.js — 排班管理（營運系統自動排班 ?only=schedule，營運系統 docs/autoschedule/hr-move-spec.md §5）
 * 看得到的人＝考勤管理同一批（platform.att，2026-10-24 Eason）；能排、能鎖定由營運系統依 scheduleAdmin 決定，其他人唯讀。
 * ns／backend 暫用 platform；首頁提醒（alerts／badge，ns schedule）等出勤核定統一（duty-unify）併進 main 後再接。
 */
'use strict';

export default {
  id: 'schedule',
  ns: 'platform',
  backend: 'platform',
  name: '排班管理',
  desc: '四週變形排班、鎖定後送 LINE 班表',
  icon: 'schedule',
  keepAlive: 30 * 60 * 1000,   // 同考勤管理：切走後保留 30 分鐘不重載
  dept: 'hr',
  requires: ['platform.att'],
  // 頁頂分頁＝營運系統自動排班送來的四個分頁（班表／指定與需求／同仁／班別與設定；platform/tabs.js）
  dynamicTabs: true,
  views: [
    { id: 'main', name: '排班管理', requires: ['platform.att'] }
  ],
  entry: () => import('./index.js')
};
