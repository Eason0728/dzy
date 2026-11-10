/**
 * platform/route.js — 連 Mac mini 的主機選擇（2026-11-10 Cloudflare 櫃台）
 *
 * 規則（所有從 BACKENDS.platform 推網址的地方都經 routeUrl()，不各自寫死）：
 * 1. 預設用新主機（MINI_HOST_NEW，Cloudflare 櫃台）。
 * 2. config.js GATEWAY_ON=false → 全部舊主機（MINI_HOST_OLD）。
 * 3. 「櫃台故障」記號（sessionStorage，5 分鐘內有效）存在 → 舊主機。記號由 api.js 在網路錯誤／櫃台 502 GATEWAY 時設。
 * 4. 代轉 ns payroll 一律舊主機（Cloudflare 每請求上限 100 秒，薪酬最久等 125 秒）。
 * 不是這兩個已知主機的網址（本機測試後端、測試注入的假主機）原樣放行。
 */

'use strict';

import { MINI_HOST_NEW, MINI_HOST_OLD, GATEWAY_ON } from './config.js';

export const GW_DOWN_KEY = 'dzy.gw.down';
export const GW_DOWN_MS = 5 * 60 * 1000;
/** 一律走舊路的代轉 ns（Cloudflare 100 秒上限） */
export const OLD_ONLY_NS = ['payroll'];

let memDown = 0;          // sessionStorage 不可用時的記憶體備援
// 頁面正在離開（重新整理、換頁）時瀏覽器會中斷還沒回來的請求，丟出跟斷網一樣的 TypeError：這時一律不判定櫃台故障（2026-11-10 正式站實測誤判）
let leaving = false;
try { addEventListener('pagehide', () => { leaving = true; }); addEventListener('beforeunload', () => { leaving = true; }); } catch (e) { /* node 測試沒有 window */ }
const realProbe = async () => {
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
    const r = await fetch(MINI_HOST_NEW + '/__gw/ping', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    return !!r && r.ok;
  } catch (e) { return false; }
};
let probe = realProbe;
let gatewayOnOverride = null;
let nowFn = () => Date.now();

/** 測試用：覆寫總開關（true／false），其他值還原成 config.js */
export function __setGatewayOn(v) { gatewayOnOverride = (v === true || v === false) ? v : null; }
/** 測試用：覆寫「櫃台還活著嗎」的探測（回 true＝活著） */
export function __setProbe(fn) { probe = (typeof fn === 'function') ? fn : realProbe; }
/** 測試用：模擬頁面正在離開 */
export function __setLeaving(v) { leaving = !!v; }
/** 測試用：覆寫時鐘 */
export function __setNow(fn) { nowFn = (typeof fn === 'function') ? fn : () => Date.now(); }
/** 測試用：清掉故障記號 */
export function __resetRoute() {
  memDown = 0; gatewayOnOverride = null; nowFn = () => Date.now(); leaving = false;
  try { sessionStorage.removeItem(GW_DOWN_KEY); } catch (e) { /* ignore */ }
}

function gatewayOn_() { return gatewayOnOverride === null ? GATEWAY_ON === true : gatewayOnOverride; }

/** 設「櫃台故障」記號（5 分鐘內有效） */
export function markGatewayDown() {
  const t = nowFn();
  memDown = t;
  try { sessionStorage.setItem(GW_DOWN_KEY, String(t)); } catch (e) { /* 沒有 sessionStorage 就只靠記憶體 */ }
}

/**
 * 網路錯誤後確認櫃台是不是真的壞了：頁面正在離開就不算；否則 2.5 秒內打一次 /__gw/ping，打不通才設記號。
 * 回 true＝確認故障（已設記號）。櫃台自己回的 502 GATEWAY 不用確認，直接 markGatewayDown。
 */
export async function confirmGatewayDown() {
  if (leaving) return false;
  const alive = await probe();
  if (alive || leaving) return false;
  markGatewayDown();
  return true;
}

/** 故障記號是否有效 */
export function gatewayDown() {
  let t = memDown;
  try {
    const v = Number(sessionStorage.getItem(GW_DOWN_KEY));
    if (Number.isFinite(v) && v > t) t = v;
  } catch (e) { /* ignore */ }
  return t > 0 && (nowFn() - t) < GW_DOWN_MS;
}

/** 目前主要主機：新或舊 */
export function mainHost() {
  if (!gatewayOn_()) return MINI_HOST_OLD;
  return gatewayDown() ? MINI_HOST_OLD : MINI_HOST_NEW;
}

/** 這個網址是不是打新主機（api.js 用來決定要不要設記號／改道） */
export function isNewHostUrl(url) {
  return typeof url === 'string' && url.indexOf(MINI_HOST_NEW) === 0;
}

function swapHost_(url, host) {
  if (typeof url !== 'string') return url;
  if (url.indexOf(MINI_HOST_NEW) === 0) return host + url.slice(MINI_HOST_NEW.length);
  if (url.indexOf(MINI_HOST_OLD) === 0) return host + url.slice(MINI_HOST_OLD.length);
  return url;
}

/** 依目前規則換主機（已知兩主機才換，其他網址原樣） */
export function routeUrl(url) { return swapHost_(url, mainHost()); }

/** 強制舊主機（payroll 用） */
export function oldUrl(url) { return swapHost_(url, MINI_HOST_OLD); }

/** 某代轉 ns 的網址：payroll 一律舊路，其餘照 routeUrl */
export function routeUrlForNs(url, ns) {
  return OLD_ONLY_NS.indexOf(ns) !== -1 ? oldUrl(url) : routeUrl(url);
}
