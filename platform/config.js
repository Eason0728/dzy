/**
 * platform/config.js — 三支後端的位址表（T1-7）
 *
 * 正本規格：docs/spec.md §4.8（送出與回傳格式）。
 *
 * 這三個網址是公開端點，不是機密，可以進 repo。
 * 通行碼／密碼永遠不准進這個檔或任何 repo 內的檔案。2026-10-12 起瀏覽器根本拿不到通行碼：
 * 稽核／宿舍一律打 <platform 主機>/platform/proxy（網址由 api.js 的 proxyUrl() 從 platform 推），
 * 由 Mac mini 代帶通行碼（spec §6.3；舊後端網址在 mini 的 .env PROXY_URL_AUDIT／PROXY_URL_DORM）。
 *
 * - platform：帳號權限後端（Mac mini dzy-minikit apps/dzy-platform）。
 * - audit：稽核系統既有後端網址。前端已不直接呼叫（走代轉），留著只為對照與 e2e 攔截。
 * - dorm：宿舍合約既有後端網址。前端殼不直接呼叫（走代轉）；sign.html 簽約頁（簽署人只有
 *   簽約 token、本來就不帶通行碼）仍直接打這支，所以不能刪。
 */

'use strict';

/**
 * 系統正式名稱 —— 顯示在畫面上的唯一正本。
 * 要改名字只改這裡。唯一的例外是 index.html 的 <title>（靜態 HTML 不能 import），
 * 改名時記得那一處要一起改。
 */
export const APP_NAME = '鼎兆元餐飲集團｜管理系統';

export const BACKENDS = {
  // 2026-10 起平台後端在公司 Mac mini（dzy-minikit apps/dzy-platform，Funnel /platform）。
  // 回退：還原這一行成舊 Apps Script /exec（git revert 合併 minikit-cutover 的 commit），見 ~/dzy-minikit/apps/dzy-platform/ROLLBACK.md
  platform: 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/platform/api',
  audit: 'https://script.google.com/macros/s/AKfycbz5l_aH_qypN6HK6UDT__5NLZDk4A2clyqeqvJzx5JrL9SBVeH5GyDYBCW3gv-CDy7fFQ/exec',
  dorm: 'https://script.google.com/macros/s/AKfycbyxyhJ35MWTjtvzKr54_9JzGfLZlclyqn2fYLWXgz0muTFzL_tu81nR1r3W332J1igm/exec'
};
