/**
 * modules/purchase/manifest.js — 貨單核對（財務部門；貨單辨識系統的會計端嵌入，docs/purchase-fin/spec.md §3）
 * 貨單辨識系統是獨立系統（網頁 https://dzy-bulletin.github.io/dzy-purchase/，後端在 Mac mini），這裡只把會計端嵌進來並用入場券自動登入。
 * ns／backend 借用 platform（入場券 ssoTicket 是平台 action）；requires platform.purchase＝財務部門預設有，Eason 可在權限設定個別加人（2026-10-24，不鎖碼）。
 * 會計管哪幾個品牌由貨單系統自己的帳號頁設定（Q2-A）。
 */
'use strict';

export default {
  id: 'purchase',
  ns: 'platform',
  backend: 'platform',
  name: '貨單核對',
  desc: '核對入帳廠商貨單、食材成本與單價報表',
  icon: 'purchase',
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（同薪酬管理；登出管理系統時一起卸載）
  dept: 'fin',
  requires: ['platform.purchase'],
  // 頁頂分頁＝貨單網頁送來的選單（platform/tabs.js；Q4-A 九個，帳號分頁只有貨單系統管理者看得到）；views 只剩一個當進入權限的門
  dynamicTabs: true,
  views: [
    { id: 'main', name: '貨單核對', requires: ['platform.purchase'] }
  ],
  entry: () => import('./index.js')
};
