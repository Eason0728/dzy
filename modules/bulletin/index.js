/**
 * modules/bulletin/index.js — 公告專區：把電子佈告欄整頁嵌進內容區（iframe），並幫同仁自動登入佈告欄。
 *
 * 自動登入（2026-10-16，後端 StaffClock.gs SSO 節）：
 *   佈告欄頁（?embed=dzy）載好 → postMessage {type:'dzyb-sso-ready'} 給這頁
 *   → 這頁向平台後端換一張一次性入場券（ssoTicket，60 秒）→ postMessage {type:'dzy-sso', ticket} 回佈告欄
 *   → 佈告欄的 Mac mini 伺服器拿券向平台兌換同仁編號、登入那位。
 * 管理系統的登入 token 從不交給佈告欄；換不到券（系統帳號、後端忙）就送 ticket:null，佈告欄照舊選名字。
 * 兩邊都核對對方的 origin，且只理會這個 iframe 本身送來的訊息。
 */
'use strict';

const BULLETIN_ORIGIN = 'https://dzy-bulletin.github.io';
const BULLETIN_URL = BULLETIN_ORIGIN + '/?embed=dzy';

export default {
  mount(el, ctx) {
    const bar = document.createElement('div');
    bar.className = 'bulletin-bar';
    const tip = document.createElement('span');
    tip.textContent = '同仁帳號會自動登入佈告欄；系統帳號或還沒對上同仁編號的，請選名字登入';
    const open = document.createElement('a');
    open.href = BULLETIN_ORIGIN + '/';
    open.target = '_blank';
    open.rel = 'noopener';
    open.className = 'btn';
    open.textContent = '在新分頁開啟';
    bar.appendChild(tip);
    bar.appendChild(open);

    const frame = document.createElement('iframe');
    frame.src = BULLETIN_URL;
    frame.title = '電子佈告欄';
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'bulletin-frame');

    let busy = false;
    async function onMessage(e) {
      if (e.origin !== BULLETIN_ORIGIN || e.source !== frame.contentWindow) return;
      if (!e.data || e.data.type !== 'dzyb-sso-ready' || busy) return;
      busy = true;
      let ticket = null;
      try {
        const r = await ctx.api.call('bulletin', 'ssoTicket', { aud: 'bulletin' });
        if (r && r.ok && r.data && typeof r.data.ticket === 'string') ticket = r.data.ticket;
      } catch (err) { ticket = null; }
      busy = false;
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'dzy-sso', ticket }, BULLETIN_ORIGIN);
    }
    window.addEventListener('message', onMessage);

    el.appendChild(bar);
    el.appendChild(frame);
    return function unmount() {
      window.removeEventListener('message', onMessage);
      while (el.firstChild) el.removeChild(el.firstChild);
    };
  },
  onRoute() {}
};
