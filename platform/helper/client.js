/**
 * platform/helper/client.js — AI 小幫手前端的 svc 路由用戶端（docs/ai-helper/spec.md §3、§12.1、§12.2、§12.7、§12.8）
 *
 * 路由：BACKENDS.platform 的 …/api 換成 …/svc/ai-help（同 lineAuthUrl／api.js proxyUrl 的做法）。
 * 請求一律 POST、Content-Type: text/plain 的 JSON（免 CORS 預檢），token 由 auth.getToken() 取；
 * 回應 HTTP 200＋{ok:true,data} 或 {ok:false,code,error}（§12.8）。
 *
 * 規則：
 * - 前端自報的東西後端一律不信（§12.2）：ask 不送 alerts、不送 history，只送 q／page{m,v}／conv／rid。
 * - 每次 ask 帶 rid（crypto.randomUUID，失敗退回 Date.now＋亂數；後端 10 分鐘內同 uid＋rid 回放，§12.7）。
 * - 逾時 30 秒（後端 Claude 逾時 15 秒，§12.7）；網路失敗、逾時、非 JSON、HTTP 非 2xx 一律回 {ok:false,code:'network'|'timeout'}，絕不拋例外。
 * - unauthorized 只回「請重新登入」，這裡與 widget 都不會自動登出（登出是殼的事，代轉 401 才會觸發）。
 * - 回傳給畫面的 error 一律是中文訊息表裡的字（後端的 error 內文不直接顯示）。
 * 測試：createClient(deps) 的 fetch／getToken／url／timeoutMs／now／uuid 皆可注入。
 */

'use strict';

import { BACKENDS } from '../config.js';
import { getToken } from '../auth.js';

export const TIMEOUT_MS = 30000;

/** 錯誤碼 → 中文訊息（畫面只顯示這張表裡的字） */
export const ERROR_MESSAGES = {
  off: '小幫手目前沒有開放',
  cap: '本月額度已用完',
  rate_person: '你今天問得有點多了，明天再來問吧',
  rate_global: '現在問的人太多，請過一分鐘再試',
  unauthorized: '請重新登入',
  bad_input: '問題格式不對，請改短一點再問',
  forbidden: '你沒有這個功能的權限',
  ai_error: '小幫手暫時無法回答',
  network: '連不上小幫手，請稍後再試',
  timeout: '小幫手回應太久了，請稍後再試'
};
const FALLBACK_MESSAGE = '小幫手暫時無法回答';

/** 錯誤碼 → 中文訊息；不認識的碼一律回通用句（不顯示後端內文） */
export function errorMessage(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : FALLBACK_MESSAGE;
}

/** …/platform/api → …/platform/svc/ai-help；推不出來回 '' */
export function helperUrl(platformUrl) {
  const u = platformUrl === undefined ? (BACKENDS.platform || '') : String(platformUrl || '');
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/svc/ai-help') : '';
}

/** 請求代號：crypto.randomUUID，不能用（舊瀏覽器、非安全環境）就退回 Date.now＋亂數 */
export function newRid(deps) {
  const d = deps || {};
  try {
    const c = d.crypto === undefined ? (typeof globalThis !== 'undefined' ? globalThis.crypto : null) : d.crypto;
    if (c && typeof c.randomUUID === 'function') {
      const id = c.randomUUID();
      if (typeof id === 'string' && id) return id;
    }
  } catch (e) { /* 退回 */ }
  const now = typeof d.now === 'function' ? d.now() : Date.now();
  const rnd = (typeof d.random === 'function' ? d.random : Math.random)();
  return 'r' + now.toString(36) + '-' + Math.floor(rnd * 0xffffffff).toString(16).padStart(8, '0');
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** 對話代號：aic_＋台北時間 YYYYMMDDHHmmss＋_＋4 位 hex（同後端 AIH_ID_CONV_RE） */
export function newConvId(deps) {
  const d = deps || {};
  const ms = typeof d.now === 'function' ? d.now() : Date.now();
  const t = new Date(ms + 8 * 3600 * 1000);   // 台北＝UTC+8，用 UTC 欄位讀就是台北時間
  const stamp = String(t.getUTCFullYear()) + pad2(t.getUTCMonth() + 1) + pad2(t.getUTCDate()) + pad2(t.getUTCHours()) + pad2(t.getUTCMinutes()) + pad2(t.getUTCSeconds());
  const rnd = (typeof d.random === 'function' ? d.random : Math.random)();
  const hex = Math.floor(rnd * 0x10000).toString(16).padStart(4, '0').slice(-4);
  return 'aic_' + stamp + '_' + hex;
}

export const CONV_RE = /^aic_\d{14}_[0-9a-f]{4}$/;

/**
 * @param {{fetch?:Function, getToken?:Function, url?:string, timeoutMs?:number, now?:Function, random?:Function, crypto?:object}} [deps]
 */
export function createClient(deps) {
  const d = deps || {};
  const doFetch = d.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const tokenOf = d.getToken || getToken;
  const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS;
  const url = d.url === undefined ? helperUrl() : d.url;

  const fail = (code) => ({ ok: false, code, error: errorMessage(code) });

  /** 送一個 op；一律回 {ok:true,data} 或 {ok:false,code,error(中文)} */
  async function post(body) {
    if (!doFetch || !url) return fail('network');
    const token = String(tokenOf() || '');
    if (!token) return fail('unauthorized');
    let ctl = null;
    let timer = null;
    try {
      ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } resolve('timeout'); }, timeoutMs); });
      const req = (async () => {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify(Object.assign({}, body, { token })),
          signal: ctl ? ctl.signal : undefined
        });
        if (!res || res.ok === false) return fail('network');   // 404（Mac mini 還沒更新）、5xx 都算連不上
        let json = null;
        try { json = await res.json(); } catch (e) { return fail('network'); }
        if (!json || typeof json !== 'object') return fail('network');
        if (json.ok === true) return { ok: true, data: (json.data && typeof json.data === 'object') ? json.data : {} };
        return fail(typeof json.code === 'string' ? json.code : 'ai_error');
      })();
      const first = await Promise.race([req.catch(() => 'throw'), timeout]);
      if (first === 'timeout') return fail('timeout');
      if (first === 'throw') return fail('network');
      return first;
    } catch (e) {
      return fail('network');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const cleanPage = (page) => {
    const re = /^[a-z0-9_-]{0,40}$/i;
    const m = page && typeof page.m === 'string' && re.test(page.m) ? page.m : '';
    const v = m && page && typeof page.v === 'string' && re.test(page.v) ? page.v : '';
    return { m, v };
  };

  return {
    /** → {on, reason, left_today} */
    status() { return post({ op: 'status' }); },
    /** → {id, kind:'answered'|'unknown', answer, go:[{m,v,label}], who}；不送 alerts、history（§12.2） */
    ask({ q, page, conv }) {
      return post({ op: 'ask', q: String(q === undefined || q === null ? '' : q), page: cleanPage(page), conv: String(conv || ''), rid: newRid(d) });
    },
    /** 👍👎 */
    feedback({ id, good }) { return post({ op: 'feedback', id: String(id || ''), good: good === true }); },
    /** 管理頁「AI 擬答」（需要 platform.aihelp）→ {question, answer, who, m, v} */
    draft({ pendingId }) { return post({ op: 'draft', pending_id: String(pendingId || '') }); },
    /** 管理頁用量的金額（需要 platform.aihelp）→ {month, usd, cap_usd}（§12.11） */
    usage() { return post({ op: 'usage' }); }
  };
}

let shared = null;
/** 單例（widget 與管理模組共用同一個設定） */
export function getClient() {
  if (!shared) shared = createClient();
  return shared;
}
