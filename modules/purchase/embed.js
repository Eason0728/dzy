/**
 * modules/purchase/embed.js — 貨單核對的 iframe 嵌入與握手（docs/purchase-fin/spec.md §1、§3、§5）
 *
 * 做法照 modules/storeops/embed.js（模組不得 import 別的模組，所以另寫一份；訊息名改 dzy-purchase-*，沒有 return 導回）：
 *   貨單網頁需要登入時 → postMessage {type:'dzy-purchase-ready', v:1}
 *   → 本模組只認 origin＝貨單網頁 origin 且 source＝這個 iframe
 *   → 向平台換一次性入場券 ssoTicket {aud:'purchase'}（60 秒）→ postMessage {type:'dzy-purchase-sso', v:1, ticket}（targetOrigin 寫死）。
 * 管理系統的登入 token 從不交給貨單系統。卸載（切走超過保留時間、登出）時送 {type:'dzy-purchase-logout', v:1}。
 *
 * 頁頂分頁：貨單網頁送 {type:'dzy-purchase-nav', v:1, items:[{id,label,badge}], cur} → ctx.tabs()；
 *   點頁頂分頁（onRoute）→ 送 {type:'dzy-purchase-go', v:1, id}；每次收到選單回 {type:'dzy-purchase-tabs', v:1}。
 *   第一次同步以網址為準：#/purchase/<分頁>，或首頁提醒帶來的 ?tab=<分頁>。
 *
 * 本機測試：管理系統跑在 localhost／127.0.0.1 時，貨單網頁改用 http://localhost:8795/（同 dev server 慣例）。
 */
'use strict';

const PROD_ORIGIN = 'https://dzy-bulletin.github.io';
const PROD_BASE = PROD_ORIGIN + '/dzy-purchase/';
const DEV_ORIGIN = 'http://localhost:8795';
const DEV_BASE = DEV_ORIGIN + '/';
const LOAD_TIMEOUT_MS = 15000;
const LOGOUT_FLUSH_MS = 150;
const TICKET_RE = /^[0-9a-f]{64}$/;
const NAV_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** 試跑模式（網址 ?dryrun=1）只擋管理系統自己的 API；嵌入的子系統照常寫入，所以 iframe 上方要明顯提示（2026-10-28 審查 #8）。
 *  行為（照常發入場券）不變。模組不 import platform/，直接看網址。 */
export const DRYRUN_EMBED_WARN = '試跑模式只保護管理系統本身；這個嵌入的子系統按送出會真的寫入，請勿送出';
function isDryRunPage() {
  try {
    return typeof location !== 'undefined' && !!location && new URLSearchParams(location.search || '').get('dryrun') === '1';
  } catch (e) {
    return false;
  }
}
function dryRunWarn() {
  const n = document.createElement('div');
  n.className = 'card';
  n.setAttribute('data-role', 'dryrun-embed-warn');
  n.setAttribute('role', 'alert');
  n.setAttribute('style', 'border-left:4px solid var(--warn);background:var(--warn-light);font-weight:700');
  n.textContent = DRYRUN_EMBED_WARN;
  return n;
}

/** 管理系統自己跑在本機時才用本機貨單網頁 */
export function isDevHost(host) {
  return host === 'localhost' || host === '127.0.0.1';
}
export function purchaseOrigin(host) { return isDevHost(host) ? DEV_ORIGIN : PROD_ORIGIN; }
export function purchaseBase(host) { return isDevHost(host) ? DEV_BASE : PROD_BASE; }
function curHost() { return typeof location !== 'undefined' && location ? location.hostname : ''; }

/** 貨單網頁送來的選單 → ctx.tabs 的格式；不合格回 null */
export function navTabs(d) {
  if (!d || d.type !== 'dzy-purchase-nav' || d.v !== 1 || !Array.isArray(d.items) || d.items.length > 20) return null;
  const tabs = d.items.filter((x) => x && typeof x.id === 'string' && NAV_ID_RE.test(x.id) && typeof x.label === 'string')
    .map((x) => ({ id: x.id, name: x.label, badge: Number(x.badge) || 0, err: x.err === true }));
  const cur = typeof d.cur === 'string' && tabs.some((t) => t.id === d.cur) ? d.cur : '';
  return { tabs, cur };
}

/** 第一次同步時想去的分頁：網址上的分頁 id 優先，其次首頁提醒帶的 ?tab= */
export function wantedTab(ctx, tabs) {
  const ids = tabs.map((t) => t.id);
  if (ctx && ctx.viewId && ids.includes(ctx.viewId)) return ctx.viewId;
  const p = ctx && ctx.params && typeof ctx.params.tab === 'string' ? ctx.params.tab : '';
  return ids.includes(p) ? p : '';
}

/** @param {{title:string, tip?:string}} cfg */
export function createEmbed(cfg) {
  let state = null; // { el, ctx, frame, down, timer, noTicket, cur, synced, origin, base }

  function clearDown() {
    if (!state) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.down && state.down.parentNode) state.down.parentNode.removeChild(state.down);
    state.down = null;
  }

  function note(role, text) {
    if (!state) return null;
    const n = document.createElement('div');
    n.className = 'card';
    n.setAttribute('data-role', role);
    n.textContent = text;
    state.el.insertBefore(n, state.frame && state.frame.parentNode === state.el ? state.frame : null);
    return n;
  }

  function showDown() {
    if (!state || state.down) return;
    state.down = note('purchase-down', cfg.title + '暫時連不上，可按「在新分頁開啟」。');
  }

  async function fetchTicket(ctx) {
    try {
      const r = await ctx.api.call('purchase', 'ssoTicket', { aud: 'purchase' });
      if (r && r.ok && r.data && typeof r.data.ticket === 'string' && TICKET_RE.test(r.data.ticket)) return r.data.ticket;
    } catch (err) { /* 換不到券＝沒有 */ }
    return null;
  }

  function post(msg) {
    if (state && state.frame && state.frame.contentWindow) state.frame.contentWindow.postMessage(msg, state.origin);
  }

  async function onMessage(e) {
    if (!state || e.origin !== state.origin || !state.frame || e.source !== state.frame.contentWindow) return;
    const d = e.data;
    if (d && d.type === 'dzy-purchase-nav') { clearDown(); onNav(d); return; }
    if (!d || d.type !== 'dzy-purchase-ready' || d.v !== 1) return;
    clearDown(); // 貨單網頁有回應＝連得上
    const frame = state.frame;
    const ticket = await fetchTicket(state.ctx);
    if (!state || state.frame !== frame || !frame.contentWindow) return; // 換券期間已卸載或 iframe 換了就不送
    if (!ticket) {
      if (!state.noTicket) state.noTicket = note('purchase-noticket', '取不到入場券，請重新整理；如果一直這樣，可能是貨單核對的權限被收回了，請找 Eason。');
      return;
    }
    post({ type: 'dzy-purchase-sso', v: 1, ticket });
  }

  /** 貨單網頁換了頁或選單變了：更新頁頂分頁，網址跟著它（第一次以網址為準，重新整理不會跳回第一頁） */
  function onNav(d) {
    const n = navTabs(d);
    if (!n || !state || !state.ctx || typeof state.ctx.tabs !== 'function') return;
    if (!state.ctx.tabs(n.tabs)) return;
    post({ type: 'dzy-purchase-tabs', v: 1 });
    if (!state.synced && n.tabs.length) {
      state.synced = true;
      const want = wantedTab(state.ctx, n.tabs);
      if (want && want !== n.cur) { sendGo(want); return; }
    }
    if (!n.cur) return;
    state.cur = n.cur;
    if (n.cur !== state.ctx.viewId) state.ctx.nav(n.cur);
  }

  function sendGo(id) {
    if (!state || !NAV_ID_RE.test(id)) return;
    state.cur = id;
    post({ type: 'dzy-purchase-go', v: 1, id });
  }

  function renderFrame() {
    const frame = document.createElement('iframe');
    frame.title = cfg.title;
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'purchase-frame');
    frame.addEventListener('error', () => showDown());
    state.frame = frame;
    state.el.appendChild(frame);
    state.timer = setTimeout(showDown, LOAD_TIMEOUT_MS); // 貨單網頁載好會送 ready 或 nav；逾時沒收到就提示
    frame.src = state.base + 'review.html?embed=dzy';
  }

  return {
    mount(el, ctx) {
      const host = curHost();
      const bar = document.createElement('div');
      bar.className = 'bulletin-bar';
      const tip = document.createElement('span');
      tip.textContent = cfg.tip || '';
      const open = document.createElement('a');
      open.href = purchaseBase(host) + 'review.html'; // 獨立分頁不帶 embed=dzy（要自己登入；過渡期後只剩管理者能這樣登）
      open.target = '_blank';
      open.rel = 'noopener';
      open.className = 'btn';
      open.textContent = '在新分頁開啟';
      bar.appendChild(tip);
      bar.appendChild(open);

      state = { el, ctx, frame: null, down: null, timer: null, noTicket: null, cur: '', synced: false, origin: purchaseOrigin(host), base: purchaseBase(host) };
      window.addEventListener('message', onMessage);
      if (isDryRunPage()) el.appendChild(dryRunWarn());
      el.appendChild(bar);
      renderFrame();
      return async function unmount() {
        window.removeEventListener('message', onMessage);
        clearDown();
        const frame = state && state.frame;
        const origin = state && state.origin;
        state = null;
        if (frame && frame.contentWindow) {
          try { frame.contentWindow.postMessage({ type: 'dzy-purchase-logout', v: 1 }, origin); } catch (err) { /* iframe 已不在 */ }
          await new Promise((r) => setTimeout(r, LOGOUT_FLUSH_MS)); // 讓訊息在 iframe 被移除前送達
        }
        while (el.firstChild) el.removeChild(el.firstChild);
      };
    },
    onRoute(ctx) {
      if (!state) return;
      state.ctx = ctx;
      if (!state.synced) return;
      const id = ctx.viewId && ctx.viewId !== 'main' ? ctx.viewId : (ctx.params && typeof ctx.params.tab === 'string' ? ctx.params.tab : '');
      if (id && id !== state.cur) sendGo(id);
    }
  };
}
