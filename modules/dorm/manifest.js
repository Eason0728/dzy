/**
 * modules/dorm/manifest.js — 宿舍合約模組 manifest（T3-2）
 *
 * 正本規格：docs/spec.md §4.5（manifest 格式與本期三模組摘要表，dorm 那一列：
 * ns='dorm', backend='dorm', 分頁 list／create／handover）、§4.1（代號與 ns／backend
 * 約束——backend 必須等於 ns）、§4.2（權限碼：dorm.read／dorm.write）。
 *
 * 本模組共三個分頁，這裡三個都要列上（陣列第一個 list 是預設分頁）；create／handover
 * 由另一支平行任務實作，本任務（T3-2）只做 list 的畫面，另外兩個分頁在 index.js 用
 * 「此分頁尚未完成」佔位，不會讓殼崩潰（見 index.js 的 VIEW_MOUNTERS／renderView）。
 */
'use strict';

export default {
  id:      'dorm',                     // 4.1 格式，全系統唯一
  ns:      'dorm',                     // 權限命名空間
  backend: 'dorm',                     // 用哪一支後端／哪一組通行碼（須等於 ns）
  name:    '宿舍合約',                  // 顯示名，2–8 字
  desc:    '合約清單、建單與退宿點交',   // 卡片副標，一句話 ≤20 字
  icon:    'dorm',                     // 對應 assets/icons/dorm.svg
  requires: ['dorm.read', 'dorm.write'], // 任一符合即可進入本模組
  views: [                             // 模組內分頁；陣列第一個＝預設分頁
    { id: 'list',     name: '合約清單', requires: ['dorm.read'] },
    { id: 'create',   name: '建立合約', requires: ['dorm.write'] },   // 佔位（平行任務）
    { id: 'handover', name: '退宿點交', requires: ['dorm.write'] }    // 佔位（平行任務）
  ],
  entry: () => import('./index.js')    // 動態載入模組本體
};
