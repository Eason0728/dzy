/**
 * modules/audit-stock/manifest.js — 月初盤點抽查模組 manifest（T2-2）
 *
 * 正本規格：docs/spec.md §4.5（manifest 格式，本模組就是該節逐字元給出的例子）、
 * §4.1（代號與 ns／backend 約束）、§4.2（權限碼）。
 *
 * ns／backend 都是 'audit'：audit-stock（本模組）與 audit-ops（營運稽核表，後續任務）
 * 共用同一支稽核後端與同一組通行碼，也共用 modules/audit-shared/api.js 的快取（spec §6.4）。
 */
'use strict';

export default {
  id:      'audit-stock',              // 4.1 格式，全系統唯一
  ns:      'audit',                    // 權限命名空間（與 audit-ops 共用）
  backend: 'audit',                    // 用哪一支後端／哪一組通行碼
  name:    '月初盤點抽查',              // 顯示名，2–8 字
  desc:    '品項抽查 20 項＋金庫抽查',   // 卡片副標，一句話 ≤20 字
  icon:    'audit-stock',              // 對應 assets/icons/audit-stock.svg
  requires: ['audit.read', 'audit.read.own'],  // 任一符合即可進入本模組
  views: [                             // 模組內分頁；陣列第一個＝預設分頁
    { id: 'overview', name: '總覽',     requires: ['audit.read'] },
    { id: 'fill',     name: '稽核填寫', requires: ['audit.write'] },
    { id: 'report',   name: '報告',     requires: ['audit.read'] },
    { id: 'analysis', name: '異常分析', requires: ['audit.read'] },
    { id: 'my',       name: '我的門市', requires: ['audit.read.own'] }
  ],
  entry: () => import('./index.js')    // 動態載入模組本體
};
