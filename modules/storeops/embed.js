/**
 * modules/storeops/embed.js — 門市營運／考勤管理共用的 iframe 嵌入與握手（契約 test/fixtures/dzy-store-contract-v2.json 的 postMessage 段）
 *
 * ⚠ 這份在 modules/storeops/ 與 modules/attendance/ 各留一份**逐字相同**的程式（模組不得 import 別的模組）。
 *    test/storeops-module.test.mjs 會逐字比對，改一邊一定要改另一邊。兩個模組各自的差異只在 index.js 傳進來的設定。
 *
 * 握手（照 modules/bulletin）：營運系統頁載好 → postMessage {type:'dzy-store-ready', v:1} 給這頁
 *   → 本模組只認 origin＝https://dzy-bulletin.github.io 且 source＝這個 iframe 本身
 *   → 向平台換一次性入場券 ssoTicket {aud:'store'}（60 秒）→ postMessage {type:'dzy-store-sso', v:1, ticket}（targetOrigin 寫死）。
 * 管理系統的登入 token 從不交給營運系統。卸載（切走模組、登出）時送 {type:'dzy-store-logout', v:1}。
 *
 * 從營運系統原網址來的「用管理系統帳號登入」：#/storeops?return=<網址>（allowReturn 的模組才處理）
 *   已登入 → 取券 → location.replace(return + '#sso=' + 券)；return 只允許營運系統網址（本機網址僅限管理系統跑在 localhost／127.0.0.1 時），其他一律忽略。
 */
'use strict';

export const STORE_ORIGIN = 'https://dzy-bulletin.github.io';
export const STORE_BASE = STORE_ORIGIN + '/dzy-store/';
const LOAD_TIMEOUT_MS = 15000;
const LOGOUT_FLUSH_MS = 150;
const TICKET_RE = /^[0-9a-f]{64}$/;

/** return 參數白名單。回傳可安全導向的網址字串（已去掉原有 # 片段），不合格回 null。 */
export function safeReturnUrl(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2000) return null;
  if (/[\u0000- \\]/.test(raw)) return null; // 空白、控制字元、反斜線（瀏覽器會把 \ 當 /）一律不收
  // 本機網址只在管理系統自己也跑在本機（localhost／127.0.0.1）時才收；正式網址一律只收營運系統網址
  const host = typeof location !== 'undefined' && location ? location.hostname : '';
  const devHost = host === 'localhost' || host === '127.0.0.1';
  const okPrefix = raw.startsWith(STORE_BASE) || (devHost && (raw.startsWith('http://localhost:') || raw.startsWith('http://127.0.0.1:')));
  if (!okPrefix) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.username || u.password) return null; // http://localhost:80@evil.com 這類
  const isStore = u.protocol === 'https:' && u.origin === STORE_ORIGIN && u.pathname.startsWith('/dzy-store/');
  const isLocal = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port !== '';
  if (!isStore && !isLocal) return null;
  u.hash = '';
  return u.href;
}

/**
 * @param {{title:string, query:string, allowReturn:boolean}} cfg
 *   query：接在 ?embed=dzy 後面的字串（例 '&only=duty'）
 */
export function createEmbed(cfg) {
  let state = null; // { el, ctx, frame, down, timer, returning }

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
    state.down = note('store-down', cfg.title + '暫時連不上，可按「在新分頁開啟」。');
  }

  async function fetchTicket(ctx) {
    try {
      const r = await ctx.api.call('storeops', 'ssoTicket', { aud: 'store' });
      if (r && r.ok && r.data && typeof r.data.ticket === 'string' && TICKET_RE.test(r.data.ticket)) return r.data.ticket;
    } catch (err) { /* 換不到券＝沒有 */ }
    return null;
  }

  async function onMessage(e) {
    if (!state || e.origin !== STORE_ORIGIN || !state.frame || e.source !== state.frame.contentWindow) return;
    const d = e.data;
    if (!d || d.type !== 'dzy-store-ready' || d.v !== 1) return;
    clearDown(); // 營運系統有回應＝連得上
    const frame = state.frame;
    const ticket = await fetchTicket(state.ctx);
    // 換券期間已卸載或 iframe 換了就不送
    if (!state || state.frame !== frame || !frame.contentWindow) return;
    if (!ticket) {
      if (!state.noTicket) state.noTicket = note('store-noticket', '取不到入場券，請重新整理，或按「在新分頁開啟」自行登入。');
      return;
    }
    frame.contentWindow.postMessage({ type: 'dzy-store-sso', v: 1, ticket }, STORE_ORIGIN);
  }

  function renderFrame() {
    const frame = document.createElement('iframe');
    frame.title = cfg.title;
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'store-frame');
    frame.addEventListener('error', () => showDown());
    state.frame = frame;
    state.el.appendChild(frame);
    state.timer = setTimeout(showDown, LOAD_TIMEOUT_MS); // 營運系統頁載好會送 ready；逾時沒收到就提示
    frame.src = STORE_BASE + '?embed=dzy' + cfg.query;
  }

  /** 處理 #/storeops?return=…：合格 → 取券導回去；不合格或取不到 → 回傳 false 讓呼叫端顯示正常模組。 */
  async function doReturn(ctx, url) {
    state.returning = true;
    const hold = note('store-returning', '正在帶您回營運系統…');
    const ticket = await fetchTicket(ctx);
    if (!state) return true;
    if (hold && hold.parentNode) hold.parentNode.removeChild(hold);
    state.returning = false;
    if (ticket) {
      window.location.replace(url + '#sso=' + ticket);
      return true;
    }
    return false;
  }

  async function enter(ctx) {
    const url = cfg.allowReturn && ctx.params ? safeReturnUrl(ctx.params.return) : null;
    if (url && !state.returning) {
      const done = await doReturn(ctx, url);
      if (done) return;
      if (state && !state.frame) renderFrame();
      return;
    }
    if (!state.frame && !state.returning) renderFrame();
  }

  return {
    mount(el, ctx) {
      const bar = document.createElement('div');
      bar.className = 'bulletin-bar';
      const tip = document.createElement('span');
      tip.textContent = cfg.tip || '';
      const open = document.createElement('a');
      // 與 iframe 同一組查詢參數，但不帶 embed=dzy（獨立分頁要自己登入）：考勤管理開 ?only=duty 版本
      open.href = STORE_BASE + (cfg.query ? '?' + cfg.query.replace(/^&/, '') : '');
      open.target = '_blank';
      open.rel = 'noopener';
      open.className = 'btn';
      open.textContent = '在新分頁開啟';
      bar.appendChild(tip);
      bar.appendChild(open);

      state = { el, ctx, frame: null, down: null, timer: null, returning: false, noTicket: null };
      window.addEventListener('message', onMessage);
      el.appendChild(bar);
      enter(ctx);
      return async function unmount() {
        window.removeEventListener('message', onMessage);
        clearDown();
        const frame = state && state.frame;
        state = null;
        if (frame && frame.contentWindow) {
          try { frame.contentWindow.postMessage({ type: 'dzy-store-logout', v: 1 }, STORE_ORIGIN); } catch (err) { /* iframe 已不在 */ }
          await new Promise((r) => setTimeout(r, LOGOUT_FLUSH_MS)); // 讓訊息在 iframe 被移除前送達
        }
        while (el.firstChild) el.removeChild(el.firstChild);
      };
    },
    onRoute(ctx) {
      if (!state) return;
      state.ctx = ctx;
      if (cfg.allowReturn && ctx.params && safeReturnUrl(ctx.params.return)) enter(ctx);
    }
  };
}
