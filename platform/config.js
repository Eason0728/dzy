/**
 * platform/config.js — 三支後端的位址表（T1-7）
 *
 * 正本規格：docs/spec.md §4.8（送出與回傳格式）。
 *
 * 這三個網址是公開端點（Apps Script web app exec URL），不是機密，可以進 repo。
 * 通行碼／密碼永遠不准進這個檔或任何 repo 內的檔案——那些走 platform/auth.js 的
 * getSecret()（記憶體，不落地）。
 *
 * - platform：帳號權限後端（apps-script/platform/），2026-08-14 部署完成。
 * - audit：稽核系統既有後端（~/mala-audit/apps-script/Code.gs），不動、不改。
 * - dorm：宿舍合約既有後端（~/mala-dorm-contract/apps-script/Api.gs），不動、不改。
 */

'use strict';

/**
 * 系統正式名稱 —— 顯示在畫面上的唯一正本。
 * 要改名字只改這裡。唯一的例外是 index.html 的 <title>（靜態 HTML 不能 import），
 * 改名時記得那一處要一起改。
 */
export const APP_NAME = '鼎兆元餐飲集團｜管理系統';

export const BACKENDS = {
  platform: 'https://script.google.com/macros/s/AKfycbww4w5qrdEqFA1UwOxDeZQKzoVahqJPrRDJ9mVUqUSb9-BcWqoHYLyAPN5O35QjX4Rs/exec',
  audit: 'https://script.google.com/macros/s/AKfycbz5l_aH_qypN6HK6UDT__5NLZDk4A2clyqeqvJzx5JrL9SBVeH5GyDYBCW3gv-CDy7fFQ/exec',
  dorm: 'https://script.google.com/macros/s/AKfycbyxyhJ35MWTjtvzKr54_9JzGfLZlclyqn2fYLWXgz0muTFzL_tu81nR1r3W332J1igm/exec'
};
