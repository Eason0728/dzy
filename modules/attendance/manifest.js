/**
 * modules/attendance/manifest.js — 考勤管理（營運系統 ?only=duty，docs/approver/spec.md §10.4）
 * 選單只對「能核至少一人」或人資主管／管理員顯示：platform.att 是後端衍生權限（StoreOps.gs storeAttGate_），不寫進 roles。
 */
'use strict';

export default {
  id: 'attendance',
  ns: 'platform',
  backend: 'platform',
  name: '考勤管理',
  desc: '出勤核定、請假加班審核',
  icon: 'attendance',
  dept: 'hr',
  requires: ['platform.att'],
  views: [
    { id: 'main', name: '考勤管理', requires: ['platform.att'] }
  ],
  entry: () => import('./index.js')
};
