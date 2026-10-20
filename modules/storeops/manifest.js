/**
 * modules/storeops/manifest.js — 門市營運（營運系統 mala-store-ops 嵌入，docs/approver/spec.md §2、§3 P5）
 * 營運系統是獨立系統（https://dzy-bulletin.github.io/dzy-store/，後端在 Mac mini），這裡只把它嵌進來並用入場券自動登入。
 * ns／backend 借用 platform（spec §4.1 backend＝ns）；requires platform.storeops＝後端衍生權限（StoreOps.gs storeOpsGate_，不寫進 roles；總開關 STORE_SSO_UNITS 空＝沒有），
 * 能進哪些店、有哪些功能由營運系統後端向管理系統查身分決定。
 */
'use strict';

export default {
  id: 'storeops',
  ns: 'platform',
  backend: 'platform',
  name: '門市營運',
  desc: '貨單、現金收支、調撥、排班',
  icon: 'storeops',
  dept: 'ops',
  requires: ['platform.storeops'],
  // 頁頂分頁＝營運系統送來的選單（platform/tabs.js）；views 只剩一個當進入權限的門
  dynamicTabs: true,
  views: [
    { id: 'main', name: '門市營運', requires: ['platform.storeops'] }
  ],
  entry: () => import('./index.js')
};
