/**
 * modules/pnl/bridge.js — 損益試算與損益後端之間的契約小工具（原生化 P3 起不再嵌 iframe，名稱沿用）
 *   PNL_ACTIONS：允許代轉的 action（必須與 platform/dryrun.js READ_ACTIONS.pnl＋WRITE_ACTIONS.pnl、
 *                Auth.gs PROXY_READ/WRITE_ACTIONS.pnl、損益後端 gas/dzyProxy.js DZY_PROXY_ACTIONS_ 一致，test 比對）
 *   toPageResult：ctx.api.call 的結果 → {ok, data}｜{ok:false, error, message}
 *   PNL_PAGES、currentMonth、buildAlerts：分頁表、本月、首頁提醒
 */
'use strict';

/** 允許代轉的 action（P2 起加 getJob 與五個維護動作，見 ~/dzy/docs/pnl-native/plan.md C4、C7） */
export const PNL_ACTIONS = ['getMonth', 'getTrend', 'getTrendMulti', 'getSettings', 'exportEntries', 'getAttachment',
  'addEntry', 'voidEntry', 'importEntries', 'uploadAttachment', 'confirmZero', 'finalize', 'unlock', 'saveSettings', 'createDraft',
  'refreshConnectors', 'refreshFixed', 'loadGroupUnits',
  'getJob', 'adminSelfCheck', 'adminSyncSeed', 'adminApplyS01Connectors', 'adminCreateLastMonthDraft', 'adminLoadStoreSeedS01'];

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
