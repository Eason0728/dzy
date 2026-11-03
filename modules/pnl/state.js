/**
 * modules/pnl/state.js — 各分頁共用：目前選的門市／月份、getSettings 快取（帳號角色、可看門市、科目、範本、系統設定）
 * 模組 unmount（保留 30 分鐘到期或登出）時 reset()；設定頁存檔後呼叫 invalidateSettings() 讓下次重讀。
 */
'use strict';

import { call } from './lib/api.js';
import { currentMonth } from './bridge.js';

export const sel = { store: '', month: '' };
let settingsCache = null;

export function reset() { sel.store = ''; sel.month = ''; settingsCache = null; }
export function invalidateSettings() { settingsCache = null; }

/** getSettings（快取）；回 {ok, data}｜{ok:false,...}。data.me＝{name, role}；data.stores；data.can_see_all */
export async function getSettings(ctx, force) {
  if (settingsCache && !force) return { ok: true, data: settingsCache };
  const r = await call(ctx, 'getSettings', {});
  if (r.ok && r.data) settingsCache = r.data;
  return r;
}

/** 可選門市清單 [{store_id, name, brand}]；can_see_all 時最前面加 {store_id:'ALL', name:'全部門市'} */
export function storeOptions(settings, withAll) {
  const list = (settings && Array.isArray(settings.stores) ? settings.stores : []).filter((s) => s && s.store_id);
  return withAll && settings && settings.can_see_all ? [{ store_id: 'ALL', name: '全部門市', brand: '' }].concat(list) : list;
}

/** 合成目前門市／月份：網址參數 → 上次選的 → 清單第一家；月份預設本月（台北） */
export function settle(options, params, now) {
  const want = (params && params.store) || sel.store;
  sel.store = options.some((s) => s.store_id === want) ? want : (options[0] ? options[0].store_id : '');
  const m = (params && params.month) || sel.month || currentMonth(now);
  sel.month = /^\d{4}-\d{2}$/.test(m) ? m : currentMonth(now);
  return sel;
}

/** 角色（後端 me.role）：'管理者'｜'填寫者'｜'檢視者' */
export function roleOf(settings) { return (settings && settings.me && settings.me.role) || ''; }
export const isAdmin = (settings) => roleOf(settings) === '管理者';
export const canWrite = (settings) => ['管理者', '填寫者'].indexOf(roleOf(settings)) !== -1;
