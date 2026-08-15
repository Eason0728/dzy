/**
 * modules/audit-ops/manifest.js — 營運稽核表模組 manifest（T2-5）
 *
 * 正本規格：docs/spec.md §4.5（manifest 格式與本期三個模組摘要表，audit-ops 那一列：
 * ns/backend='audit'、分頁 overview／fill／report／my）、§4.1（代號與 ns／backend 約束）、
 * §4.2（權限碼）。
 *
 * ns／backend 都是 'audit'：audit-ops（本模組）與 audit-stock（月初盤點抽查，T2-2/T2-3）
 * 共用同一支稽核後端與同一組通行碼，也共用 modules/audit-shared/api.js 的快取（spec §6.4），
 * 所以雖然首頁是兩張卡片，getAll 只會被呼叫一次——做法完全比照 audit-stock/manifest.js。
 *
 * `my`（我的門市）這次先只列在 views 裡（views[].id 格式同 4.1，路由第二段就是它），
 * 畫面本體留到 T2-6 才做；index.js 目前沒有替它掛 mounter，點進去會落到「此分頁尚未完成」
 * 的占位卡片（同 audit-stock 在 report/analysis/my 補齊前的做法），不會讓畫面崩潰。
 */
'use strict';

export default {
  id:      'audit-ops',                // 4.1 格式，全系統唯一
  ns:      'audit',                    // 權限命名空間（與 audit-stock 共用）
  backend: 'audit',                    // 用哪一支後端／哪一組通行碼
  name:    '營運稽核表',                // 顯示名，2–8 字
  desc:    '19 項檢查，合格率統計',      // 卡片副標，一句話 ≤20 字
  icon:    'audit-ops',                // 對應 assets/icons/audit-ops.svg
  requires: ['audit.read', 'audit.read.own'],  // 任一符合即可進入本模組
  views: [                             // 模組內分頁；陣列第一個＝預設分頁
    { id: 'overview', name: '總覽',     requires: ['audit.read'] },
    { id: 'fill',     name: '稽核填寫', requires: ['audit.write'] },
    { id: 'report',   name: '報告',     requires: ['audit.read'] },
    { id: 'my',       name: '我的門市', requires: ['audit.read.own'] }
  ],
  entry: () => import('./index.js')    // 動態載入模組本體
};
