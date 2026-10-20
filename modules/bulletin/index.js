/**
 * modules/bulletin/index.js — 公告專區：把電子佈告欄整頁嵌進內容區（iframe），並自動登入。
 *
 * 分頁（2026-10-17）：
 *   board  公告        → ?embed=dzy            （同仁本人登入，入場券 aud＝bulletin）
 *   hist   歷史區      → 同一頁，不重新載入，只 postMessage {type:'dzy-bulletin-nav',v:1,p} 叫佈告欄切換（2026-10-20，見 nav.js）
 *   manage 公告管理    → ?embed=dzy&view=posts （佈告欄管理憑證，入場券 aud＝bulletin-admin，要 platform.bulletin）
 *   new    新增公告    → ?embed=dzy&view=new   （同上）
 *
 * 自動登入（後端 StaffClock.gs SSO 節）：佈告欄頁載好 → postMessage {type:'dzyb-sso-ready'} 給這頁
 *   → 這頁依「目前分頁」決定 aud（不採信框內說要哪一種）向平台換一次性入場券（60 秒）→ postMessage {type:'dzy-sso', ticket} 回佈告欄。
 * 管理系統的登入 token 從不交給佈告欄；換不到券就送 ticket:null，佈告欄照舊選名字（管理分頁則顯示沒有權限）。
 * 兩邊都核對對方的 origin，且只理會這個 iframe 本身送來的訊息。
 */
'use strict';

import { BACKENDS } from '../../platform/config.js';
import { isBoardTab, navMessage } from './nav.js';

const BULLETIN_ORIGIN = BACKENDS.bulletin;
const LOAD_TIMEOUT_MS = 15000;
const VIEWS = {
  board: { src: '/?embed=dzy', aud: 'bulletin', tip: '同仁帳號會自動登入佈告欄；系統帳號或還沒對上同仁編號的，請選名字登入' },
  hist: { src: '/?embed=dzy', aud: 'bulletin', tip: '已下架的舊公告，只供查閱、不用再簽名' },
  manage: { src: '/?embed=dzy&view=posts', aud: 'bulletin-admin', tip: '管理公告：上下架、置頂、看誰還沒簽名' },
  new: { src: '/?embed=dzy&view=new', aud: 'bulletin-admin', tip: '新增公告：可附 Word／PDF／Excel，同仁只能線上看' }
};

let state = null;   // { el, ctx, frame, tip, view, src, ready, busy, down, timer }

function clearDown() {
  if (!state) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.down && state.down.parentNode) state.down.parentNode.removeChild(state.down);
  state.down = null;
}

function showDown() {
  if (!state || state.down) return;
  const n = document.createElement('div');
  n.className = 'card';
  n.setAttribute('data-role', 'bulletin-down');
  n.textContent = '佈告欄暫時連不上，可按「在新分頁開啟」。';
  state.el.insertBefore(n, state.frame);
  state.down = n;
}

/** 叫佈告欄切到目前的公告／歷史區（只在公告、歷史區這兩個分頁；佈告欄舊版會忽略） */
function sendNav() {
  if (!state || !state.ready || !isBoardTab(state.view) || !state.frame.contentWindow) return;
  state.frame.contentWindow.postMessage(navMessage(state.view), BULLETIN_ORIGIN);
}

function render(viewId) {
  const v = VIEWS[viewId] || VIEWS.board;
  state.view = VIEWS[viewId] ? viewId : 'board';
  state.tip.textContent = v.tip;
  // 公告 ↔ 歷史區：同一頁，不重新載入（免得重新登入），送訊息切換就好
  if (state.src === v.src && state.ready) { sendNav(); return; }
  clearDown();
  state.src = v.src;
  state.ready = false;
  state.timer = setTimeout(showDown, LOAD_TIMEOUT_MS); // 佈告欄頁載好會送 dzyb-sso-ready；逾時沒收到就提示
  state.frame.src = BULLETIN_ORIGIN + v.src;
}

async function onMessage(e) {
  if (!state || e.origin !== BULLETIN_ORIGIN || e.source !== state.frame.contentWindow) return;
  if (e.data && e.data.type === 'dzyb-sso-ready') { clearDown(); state.ready = true; sendNav(); } // 佈告欄有回應＝連得上；先告訴它要停在哪個分頁
  if (!e.data || e.data.type !== 'dzyb-sso-ready' || state.busy) return;
  const frame = state.frame, aud = VIEWS[state.view].aud;
  state.busy = true;
  let ticket = null;
  try {
    const r = await state.ctx.api.call('bulletin', 'ssoTicket', { aud });
    if (r && r.ok && r.data && typeof r.data.ticket === 'string') ticket = r.data.ticket;
  } catch (err) { ticket = null; }
  if (state) state.busy = false;
  // 換券期間切了分頁（iframe 已換頁）就不送，免得把管理券送給一般頁或反過來
  if (state && state.frame === frame && VIEWS[state.view].aud === aud && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: 'dzy-sso', ticket }, BULLETIN_ORIGIN);
  }
}

export default {
  mount(el, ctx) {
    const bar = document.createElement('div');
    bar.className = 'bulletin-bar';
    const tip = document.createElement('span');
    const open = document.createElement('a');
    open.href = BULLETIN_ORIGIN + '/';
    open.target = '_blank';
    open.rel = 'noopener';
    open.className = 'btn';
    open.textContent = '在新分頁開啟';
    bar.appendChild(tip);
    bar.appendChild(open);

    const frame = document.createElement('iframe');
    frame.title = '電子佈告欄';
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'bulletin-frame');
    frame.addEventListener('error', () => showDown());

    state = { el, ctx, frame, tip, view: 'board', src: null, ready: false, busy: false, down: null, timer: null };
    window.addEventListener('message', onMessage);
    el.appendChild(bar);
    el.appendChild(frame);
    render(ctx.viewId);
    return function unmount() {
      window.removeEventListener('message', onMessage);
      clearDown();
      state = null;
      while (el.firstChild) el.removeChild(el.firstChild);
    };
  },
  onRoute(ctx) {
    if (!state) return;
    state.ctx = ctx;
    state.busy = false;
    render(ctx.viewId);
  }
};
