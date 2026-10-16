/**
 * modules/bulletin/index.js — 公告專區：把電子佈告欄整頁嵌進內容區（iframe），並自動登入。
 *
 * 分頁（2026-10-17）：
 *   board  電子佈告欄  → ?embed=dzy            （同仁本人登入，入場券 aud＝bulletin）
 *   manage 公告管理    → ?embed=dzy&view=posts （佈告欄管理憑證，入場券 aud＝bulletin-admin，要 platform.bulletin）
 *   new    新增公告    → ?embed=dzy&view=new   （同上）
 *
 * 自動登入（後端 StaffClock.gs SSO 節）：佈告欄頁載好 → postMessage {type:'dzyb-sso-ready'} 給這頁
 *   → 這頁依「目前分頁」決定 aud（不採信框內說要哪一種）向平台換一次性入場券（60 秒）→ postMessage {type:'dzy-sso', ticket} 回佈告欄。
 * 管理系統的登入 token 從不交給佈告欄；換不到券就送 ticket:null，佈告欄照舊選名字（管理分頁則顯示沒有權限）。
 * 兩邊都核對對方的 origin，且只理會這個 iframe 本身送來的訊息。
 */
'use strict';

const BULLETIN_ORIGIN = 'https://dzy-bulletin.github.io';
const VIEWS = {
  board: { src: '/?embed=dzy', aud: 'bulletin', tip: '同仁帳號會自動登入佈告欄；系統帳號或還沒對上同仁編號的，請選名字登入' },
  manage: { src: '/?embed=dzy&view=posts', aud: 'bulletin-admin', tip: '管理公告：上下架、置頂、看誰還沒簽名' },
  new: { src: '/?embed=dzy&view=new', aud: 'bulletin-admin', tip: '新增公告：可附 Word／PDF／Excel，同仁只能線上看' }
};

let state = null;   // { el, ctx, frame, tip, view, busy }

function render(viewId) {
  const v = VIEWS[viewId] || VIEWS.board;
  state.view = VIEWS[viewId] ? viewId : 'board';
  state.tip.textContent = v.tip;
  state.frame.src = BULLETIN_ORIGIN + v.src;
}

async function onMessage(e) {
  if (!state || e.origin !== BULLETIN_ORIGIN || e.source !== state.frame.contentWindow) return;
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

    state = { el, ctx, frame, tip, view: 'board', busy: false };
    window.addEventListener('message', onMessage);
    el.appendChild(bar);
    el.appendChild(frame);
    render(ctx.viewId);
    return function unmount() {
      window.removeEventListener('message', onMessage);
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
