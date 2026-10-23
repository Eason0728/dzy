/**
 * modules/cashbook/manifest.js — 收支管理（財務部門，2026-10-24；規格 docs/cashbook-fin/spec.md）
 * 會計端看全部門市的現金收支：查明細、作廢、月結鎖定、匯出 Excel、改會計科目。
 * 原生模組畫面（不嵌 iframe）：每次讀寫經平台代轉 /platform/proxy（ns cashbook），管理金鑰只放在 Mac mini 的 module_secrets
 *（cashbook/write），瀏覽器拿不到；操作人由平台依登入身分決定。權限碼 cashbook.write（不是鎖碼，財務部門預設有）。
 */
'use strict';

export default {
  id: 'cashbook',
  ns: 'cashbook',
  backend: 'cashbook',
  name: '收支管理',
  desc: '各店現金收支、月結鎖定、匯出、科目',
  icon: 'cashbook',
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（同薪酬管理；登出管理系統時一起卸載）
  dept: 'fin',
  requires: ['cashbook.write'],
  views: [
    { id: 'rows', name: '收支明細', requires: ['cashbook.write'] },
    { id: 'lock', name: '月結鎖定', requires: ['cashbook.write'] },
    { id: 'export', name: '匯出 Excel', requires: ['cashbook.write'] },
    { id: 'subjects', name: '會計科目', requires: ['cashbook.write'] }
  ],
  entry: () => import('./index.js')
};
