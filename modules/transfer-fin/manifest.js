/**
 * modules/transfer-fin/manifest.js — 調撥管理（2026-10-24）：把調撥系統的會計頁（mala-transfer/report.html）嵌進財務部門。
 * 會計密碼只放在 Mac mini 的 module_secrets（transfer/write），瀏覽器拿不到；每次讀寫都經平台代轉 /platform/proxy（ns transfer），
 * 由後端 proxyAuthorize_ 依 transfer.write 放行，操作人也由平台依登入身分決定。
 */
'use strict';

export default {
  id: 'transfer-fin',
  ns: 'transfer',
  backend: 'transfer',
  name: '調撥管理',
  desc: '調撥月報、品項記憶、卡關總覽',
  icon: 'transfer',
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（登出管理系統時一起卸載）
  dept: 'fin',
  requires: ['transfer.write'],
  // 分頁＝會計頁原本的分頁；要與 bridge.js TRANSFER_PAGES 一致（test/transfer-fin-module.test.mjs 比對）
  views: [
    { id: 'report', name: '月報', requires: ['transfer.write'] },
    { id: 'memory', name: '品項記憶', requires: ['transfer.write'] },
    { id: 'overview', name: '卡關總覽', requires: ['transfer.write'] }
  ],
  entry: () => import('./index.js')
};
