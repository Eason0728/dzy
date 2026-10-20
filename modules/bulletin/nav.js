/**
 * modules/bulletin/nav.js — 佈告欄「📌 公告／🗂 歷史區」改由管理系統頁頂分頁列畫（2026-10-20 Eason：跟「公告專區」同一列）。
 * 純函式，node 測試直接 import。佈告欄嵌入時（?embed=dzy）隱藏自己的標題列與公告／歷史區切換，收到 nav 訊息照切。
 * 品牌子分頁（墨竹亭／小辛辣／央廚）留在佈告欄裡：看得到哪幾個依同仁單位而定、還帶未讀數字，管理系統的分頁列是固定的。
 */
'use strict';

/** 同一個 iframe 頁面（?embed=dzy）裡切換的分頁：管理系統分頁 id → 佈告欄 v.tab */
export const BOARD_TABS = [['board', '公告'], ['hist', '歷史區']];

export function isBoardTab(viewId) { return BOARD_TABS.some((x) => x[0] === viewId); }

/** 管理系統換分頁 → 通知佈告欄切換的訊息；不認得的一律回「公告」 */
export function navMessage(viewId) {
  return { type: 'dzy-bulletin-nav', v: 1, p: isBoardTab(viewId) ? viewId : 'board' };
}
