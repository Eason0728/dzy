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
 * - dorm：宿舍合約既有後端網址。前端殼不直接呼叫（走代轉）；簽約頁在舊站 mala-dorm（dzy 不再保留
 *   副本，2026-10-18）；舊站簽約頁（簽署人只有簽約 token）直接打這支，所以不能刪。
 */

'use strict';

/**
 * 系統正式名稱 —— 顯示在畫面上的唯一正本。
 * 要改名字只改這裡。唯一的例外是 index.html 的 <title>（靜態 HTML 不能 import），
 * 改名時記得那一處要一起改。
 */
export const APP_NAME = '鼎兆元餐飲集團｜管理系統';

/**
 * 左側選單的部門分組（2026-10-16 Eason：選單改成部門、十二個部門全列，沒功能的也顯示）。
 * 代碼＝org 分頁 dept 列（apps-script/platform/Staff.gs）；順序＝選單由上到下。
 * 選單名稱一律四個字（Eason 2026-10-16：加「部門」二字，加盟部門 2026-10-23 起也加「部門」），跟 org 分頁的部門全名分開。
 * rd 研發部門＝org 單位 ck 中央工廠（研發部＝中央工廠；廚藝總監＝研發部總監，docs/org/spec.md 第 16 節），目前沒有模組。
 * branddev 品牌發展＝org 部門 branddev 品牌發展部（2026-10-23 新增，第 17 節），一般總部部門，目前沒有模組。
 * 模組 manifest 填 dept 掛到該部門底下；沒填 dept（例如「我的資料」）排在首頁下面、不進部門。
 */
/**
 * 手機版「功能」頁的工作分類（2026-11-06 Eason：手機照工作分、電腦左側照部門分）。
 * 模組 manifest 填 work 掛到該類；沒填的排在最後「其他」。順序＝由上到下。
 */
export const WORK_GROUPS = [
  { id: 'people', name: '人：同仁、出勤、班表' },
  { id: 'store', name: '店：營運、檢查' },
  { id: 'money', name: '錢：單據、帳' },
  { id: 'system', name: '系統設定' },
  { id: 'self', name: '公告與我' }
];

export const DEPARTMENTS = [
  { id: 'ops', name: '營運部門' },
  { id: 'mgmt', name: '管理部門' },
  { id: 'hr', name: '人資部門' },
  { id: 'fin', name: '財務部門' },
  { id: 'purchase', name: '採購部門' },
  { id: 'eng', name: '工程部門' },
  { id: 'rd', name: '研發部門' },
  { id: 'training', name: '訓練部門' },
  { id: 'marketing', name: '行銷部門' },
  { id: 'branddev', name: '品牌發展' },
  { id: 'it', name: '資訊部門' },
  { id: 'franchise', name: '加盟部門' }
];

/**
 * LINE 開通／重設密碼的 LIFF app ID（docs/line-auth/spec.md §6）。空字串＝功能未開：
 * 登入頁不顯示「用 LINE 開通／用 LINE 重設密碼」兩顆按鈕，line.html 顯示「功能準備中」。
 * LIFF ID 是公開值（出現在 liff.line.me 網址），可以進 repo。Eason 在 LINE Developers 建好 LIFF app
 * （endpoint https://dzy.mozhuting.com/line.html）後把 ID 填進來。LINE 路由＝同主機 /platform/svc/line-auth，
 * 由 BACKENDS.platform 推導（platform/views/line-auth.js lineAuthUrl()），這裡不另存。
 */
export const LINE_LIFF_ID = '2011292256-Qs80XEBg';

export const BACKENDS = {
  // 2026-10 起平台後端在公司 Mac mini（dzy-minikit apps/dzy-platform，Funnel /platform）。
  // 回退：還原這一行成舊 Apps Script /exec（git revert 合併 minikit-cutover 的 commit），見 ~/dzy-minikit/apps/dzy-platform/ROLLBACK.md
  platform: 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/platform/api',
  audit: 'https://script.google.com/macros/s/AKfycbz5l_aH_qypN6HK6UDT__5NLZDk4A2clyqeqvJzx5JrL9SBVeH5GyDYBCW3gv-CDy7fFQ/exec',
  dorm: 'https://script.google.com/macros/s/AKfycbyxyhJ35MWTjtvzKr54_9JzGfLZlclyqn2fYLWXgz0muTFzL_tu81nR1r3W332J1igm/exec',
  // 電子佈告欄前端網址（公告專區 iframe 來源與 postMessage 核對用；不是 API 後端，shell 不會對它發請求）
  bulletin: 'https://dzy-bulletin.github.io'
};

/**
 * 首頁少等（2026-11-10）：總開關。false＝首頁行為與以前完全相同
 * （不併請求、不讀不寫 localStorage 的上次件數）。
 * 要先在正式網址自己試：網址加 ?homefast=1（記進 sessionStorage，關掉分頁就失效；?homefast=0 立刻關掉）。
 * 本機 8862 埠（試用埠）一律開。確認沒問題後 Eason 才會把這裡改成 true。
 */
export const HOME_FAST = false;

const HOME_FAST_KEY = 'dzy.homefast';   // sessionStorage：只存 '1'
const HOME_FAST_LOCAL_PORT = '8862';

/**
 * 現在這個頁面要不要走「首頁少等」。純函式，讀不到 location／storage 一律回 false（往關的方向失敗）。
 * @param {{hostname?:string,port?:string,search?:string}} [loc] 預設 window.location
 * @param {{getItem:Function,setItem:Function,removeItem:Function}|null} [storage] 預設 window.sessionStorage（測試可注入）
 */
export function homeFastAllowed(loc, storage) {
  if (HOME_FAST === true) return true;
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (!l) return false;
  const host = String(l.hostname || '');
  if ((host === 'localhost' || host === '127.0.0.1') && String(l.port || '') === HOME_FAST_LOCAL_PORT) return true;
  let ss = storage;
  if (ss === undefined) {
    try { ss = (typeof sessionStorage !== 'undefined') ? sessionStorage : null; } catch (e) { ss = null; }
  }
  const m = /(?:^|[?&])homefast=([^&#]*)/.exec(String(l.search || ''));
  if (m && m[1] === '1') {
    try { if (ss) ss.setItem(HOME_FAST_KEY, '1'); } catch (e) { /* 存不了就只認這一次的網址 */ }
    return true;
  }
  if (m && m[1] === '0') {
    try { if (ss) ss.removeItem(HOME_FAST_KEY); } catch (e) { /* 忽略 */ }
    return false;
  }
  try { return !!ss && ss.getItem(HOME_FAST_KEY) === '1'; } catch (e) { return false; }
}
