/**
 * modules/payroll/manifest.js — 薪酬管理（2026-10-19）：把光復打卡 Apps Script 的薪資管理頁（mala-clock-in/payroll.html）嵌進人資部門。
 * 管理金鑰只放在 Mac mini 的 module_secrets（payroll/write），瀏覽器拿不到；每次讀寫都經平台代轉 /platform/proxy（ns payroll），
 * 由後端 proxyAuthorize_ 依 payroll.write（鎖碼，只有 admin 能開給人）放行，操作人也由平台依登入身分決定。
 */
'use strict';

export default {
  id: 'payroll',
  ns: 'payroll',
  backend: 'payroll',
  name: '薪酬計算',
  desc: '薪資結算、員工薪資主檔、出勤紀錄表',
  icon: 'payroll',
  work: 'people',              // 手機「功能」頁的工作分類（platform/config.js WORK_GROUPS）
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（2026-10-20 Eason；登出管理系統時一起卸載）
  dept: 'hr',
  requires: ['payroll.write'],
  // 分頁＝薪酬頁原本的側欄（2026-10-20 Eason：跟「薪酬管理」同一列）；要與 bridge.js PAYROLL_PAGES 一致（test/payroll-module.test.mjs 比對）
  views: [
    { id: 'dash', name: '儀表板', requires: ['payroll.write'] },
    { id: 'group', name: '集團總覽', requires: ['payroll.admin'] },   // 只有系統管理者（*）通過；財務同仁看不到（docs/payroll-scope/spec.md §7）
    { id: 'emp', name: '1 員工設定', requires: ['payroll.write'] },
    { id: 'cfg', name: '2 參數設定', requires: ['payroll.write'] },
    { id: 'punch', name: '3 打卡紀錄', requires: ['payroll.write'] },
    { id: 'att', name: '4 出勤資料', requires: ['payroll.write'] },
    { id: 'bonus', name: '5 獎金計算', requires: ['payroll.write'] },
    { id: 'run', name: '6 薪資計算', requires: ['payroll.write'] },
    { id: 'slip', name: '7 薪資單', requires: ['payroll.write'] },
    { id: 'export', name: '8 匯出', requires: ['payroll.write'] },
    { id: 'attexp', name: '出勤紀錄表', requires: ['payroll.write'] },
    { id: 'oplog', name: '操作紀錄', requires: ['payroll.write'] }   // 定案／解鎖／設定變更的紀錄（2026-11-04，唯讀；範圍由薪資後端依負責門市裁切）
  ],
  entry: () => import('./index.js')
};
