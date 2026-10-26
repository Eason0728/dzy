/**
 * modules/transfer-fin/index.js — 調撥管理：把調撥會計頁整頁嵌進內容區（iframe），呼叫一律由本模組代轉（見 bridge.js）。
 * 只理會「這個 iframe 本身」且 origin 正確的訊息；回覆時 targetOrigin 寫死會計頁網址。
 */
'use strict';

import { transferTarget, parseCall, toPageResult, navMessage } from './bridge.js';

const LOAD_TIMEOUT_MS = 20000;
let state = null;   // { el, ctx, frame, target, down, timer }

function clearDown() {
  if (!state) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.down && state.down.parentNode) state.down.parentNode.removeChild(state.down);
  state.down = null;
}

/** 告訴會計頁切到目前分頁（管理系統的分頁列＝會計頁的選單） */
function sendNav() {
  if (!state || !state.ready || !state.frame.contentWindow) return;
  state.frame.contentWindow.postMessage(navMessage(state.ctx.viewId), state.target.origin);
}

function showDown() {
  if (!state || state.down) return;
  const n = document.createElement('div');
  n.className = 'card';
  n.setAttribute('data-role', 'transfer-down');
  n.textContent = '調撥管理暫時連不上，請稍後重新整理。';
  state.el.insertBefore(n, state.frame);
  state.down = n;
}

async function onMessage(e) {
  if (!state || e.origin !== state.target.origin || e.source !== state.frame.contentWindow) return;
  const d = e.data;
  if (d && d.type === 'dzy-transfer-ready' && d.v === 1) { clearDown(); state.ready = true; sendNav(); return; }
  const call = parseCall(d);
  if (!call) return;
  const frame = state.frame, origin = state.target.origin, ctx = state.ctx;
  let r;
  try { r = await ctx.api.call('transfer', call.action, call.payload); } catch (err) { r = { ok: false, error: '網路連線失敗，請稍後再試', status: 0 }; }
  if (!state || state.frame !== frame || !frame.contentWindow) return;   // 已切走
  frame.contentWindow.postMessage({ type: 'dzy-transfer-result', v: 1, id: call.id, result: toPageResult(r) }, origin);
}

export default {
  mount(el, ctx) {
    const target = transferTarget(location.hostname);
    const bar = document.createElement('div');
    bar.className = 'bulletin-bar';
    bar.textContent = '調撥資料只有被開通「調撥管理」權限的人看得到；所有修改都會記錄是誰做的。';
    const frame = document.createElement('iframe');
    frame.title = '調撥管理';
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'transfer-frame');
    frame.addEventListener('error', () => showDown());
    state = { el, ctx, frame, target, down: null, timer: null, ready: false };
    window.addEventListener('message', onMessage);
    el.appendChild(bar);
    el.appendChild(frame);
    state.timer = setTimeout(showDown, LOAD_TIMEOUT_MS);
    frame.src = target.url;
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
    sendNav();
  }
};
