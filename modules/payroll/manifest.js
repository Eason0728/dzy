/**
 * modules/payroll/manifest.js — 薪酬系統（2026-10-19）：把光復打卡 Apps Script 的薪資管理頁（mala-clock-in/payroll.html）嵌進人資部門。
 * 管理金鑰只放在 Mac mini 的 module_secrets（payroll/write），瀏覽器拿不到；每次讀寫都經平台代轉 /platform/proxy（ns payroll），
 * 由後端 proxyAuthorize_ 依 payroll.write（鎖碼，只有 admin 能開給人）放行，操作人也由平台依登入身分決定。
 */
'use strict';

export default {
  id: 'payroll',
  ns: 'payroll',
  backend: 'payroll',
  name: '薪酬系統',
  desc: '薪資結算、員工薪資主檔、出勤紀錄表',
  icon: 'payroll',
  dept: 'hr',
  requires: ['payroll.write'],
  views: [
    { id: 'main', name: '薪酬系統', requires: ['payroll.write'] }
  ],
  entry: () => import('./index.js')
};
