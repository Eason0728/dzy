/**
 * modules/pnl/bridge.js — 損益網頁（iframe）與管理系統之間的轉接（純函式，node 測試直接 import）
 *
 * 損益網頁嵌入模式不拿任何金鑰、也拿不到管理系統的登入 token：它把 {type:'dzy-pnl-call', v:1, id, action, body}
 * postMessage 給父頁（targetOrigin 寫死管理系統網址），父頁（本模組）驗過來源後用 ctx.api.call('pnl', …) 走代轉，
 * 再把結果還原成損益網頁原本的 {ok, data}／{ok:false, error, message} 形狀，回 {type:'dzy-pnl-result', v:1, id, result}。
 * 損益那邊的對應程式：mala-pnl-auto gas/shell.html「dzy-embed」段。
 */
'use strict';

export const PNL_ORIGIN = 'https://mala-pnl.github.io';
// 本機開發：管理系統跑在 localhost 時，嵌損益網頁的本機版（mala-pnl-auto tools/dev-embed-server.js，預設 8912）
export const DEV_PNL_ORIGIN = 'http://localhost:8912';

/** 允許代轉的 action（必須與 platform/dryrun.js READ_ACTIONS.pnl＋WRITE_ACTIONS.pnl 一致，test 比對） */
export const PNL_ACTIONS = ['getMonth', 'getTrend', 'getTrendMulti', 'getSettings', 'exportEntries', 'getAttachment',
  'addEntry', 'voidEntry', 'importEntries', 'uploadAttachment', 'confirmZero', 'finalize', 'unlock', 'saveSettings', 'createDraft',
  'refreshConnectors', 'refreshFixed', 'loadGroupUnits'];

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** 目前環境下損益網頁的 origin 與網址 */
export function pnlTarget(hostname) {
  const dev = hostname === 'localhost' || hostname === '127.0.0.1';
  const origin = dev ? DEV_PNL_ORIGIN : PNL_ORIGIN;
  return { origin, url: origin + '/?embed=dzy' };
}

/** 驗證一則來自損益網頁的呼叫；不合格回 null（直接忽略，不回覆） */
export function parseCall(data) {
  if (!data || typeof data !== 'object' || data.type !== 'dzy-pnl-call' || data.v !== 1) return null;
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) return null;
  if (typeof data.action !== 'string' || PNL_ACTIONS.indexOf(data.action) === -1) return null;
  const body = data.body === undefined || data.body === null ? {} : data.body;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const payload = Object.assign({}, body);
  // 這幾個欄位只能由 mini／平台決定，瀏覽器送來的一律丟掉
  ['action', 'token', 'key', 'operator', 'level', 'inner'].forEach((k) => { delete payload[k]; });
  return { id: data.id, action: data.action, payload };
}

/**
 * ctx.api.call 的結果 → 損益網頁的形狀。
 * - 成功：損益後端回 {ok:true, data:{…}}，經 transformResponse_ 變成 {ok:true, data:{data:{…}}} → 取內層 data。
 * - 損益後端錯誤：{ok:false, error:'AUTH'|'FORBIDDEN'|…, data:{message}} → 原樣碼＋中文訊息。
 * - 代轉層錯誤（有 status）：401 當 AUTH，其他當 BUSY，訊息用平台的中文。
 * - 試跑模式攔下的寫入：當成 BAD_INPUT「試跑模式，未寫入」，不讓損益網頁以為寫成功。
 */
export function toPageResult(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: 'BUSY', message: '伺服器回應格式錯誤' };
  if (r.dryrun) return { ok: false, error: 'BAD_INPUT', message: '試跑模式，未寫入' };
  if (r.ok === true) {
    const d = r.data && typeof r.data === 'object' ? r.data.data : undefined;
    return { ok: true, data: d === undefined ? null : d };
  }
  const msg = String(r.error || '請求失敗');
  if (r.status !== undefined) return { ok: false, error: r.status === 401 ? 'AUTH' : 'BUSY', message: msg };
  const inner = r.data && typeof r.data === 'object' && typeof r.data.message === 'string' ? r.data.message : '';
  return { ok: false, error: /^[A-Z_]{2,20}$/.test(msg) ? msg : 'BUSY', message: inner || msg };
}

/** 頁頂分頁（id＝損益網頁 embedGo_ 認得的頁名；順序＝manifest.views） */
export const PNL_PAGES = [
  ['dashboard', '儀表板'], ['pending', '待補'], ['food', '食材'], ['labor', '人事'], ['controllable', '可控'],
  ['uncontrollable', '不可控'], ['revenue', '營業收入'], ['import', '匯入'], ['settings', '設定']
];

/** 管理系統換分頁 → 通知損益網頁切換；不認得的分頁一律回儀表板 */
export function navMessage(viewId) {
  const ok = PNL_PAGES.some((x) => x[0] === viewId);
  return { type: 'dzy-pnl-nav', v: 1, p: ok ? viewId : 'dashboard' };
}

/** 損益頁回報「我現在在哪一頁」（dzy-pnl-at）；不認得的回 null */
export function atPage(data) {
  if (!data || typeof data !== 'object' || data.type !== 'dzy-pnl-at' || data.v !== 1 || typeof data.p !== 'string') return null;
  return PNL_PAGES.some((x) => x[0] === data.p) ? data.p : null;
}

/** 本月（台北時間）'YYYY-MM' */
export function currentMonth(now) {
  const d = new Date((now === undefined ? Date.now() : now) + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** 首頁提醒：每家店本月待補項數 → [{level,text,view,params}]（0 項的店不列） */
export function buildAlerts(rows, month) {
  const m = Number(String(month).slice(5, 7));
  return rows
    .filter((x) => x && typeof x.count === 'number' && x.count > 0)
    .map((x) => ({ level: 'warn', text: `${x.name} ${m} 月損益還有 ${x.count} 項待補`, view: 'pending', params: { store: x.store_id } }));
}
