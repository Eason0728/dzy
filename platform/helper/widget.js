/**
 * platform/helper/widget.js — AI 小幫手：每頁右下角「問小幫手」按鈕＋對話側欄（docs/ai-helper/spec.md §2、§12）
 *
 * 殼只做兩件事：登入後 mountHelper(shellEl, {getRoute, canGo})、登出時 unmountHelper()。
 * - 開頁打一次 status：on:false、任何錯誤（網路失敗、404＝Mac mini 還沒更新）→ 按鈕完全不出現；
 *   reason 'cap' → 按鈕出現，點開只寫「本月額度已用完」。
 * - 畫面上所有問題、答案、who、label 一律 textContent（§12.4）；不支援 Markdown；本檔不用 innerHTML。
 * - 「帶我去」：只收 {m,v}（字元白名單），canGo(m,v)＝殼的 isModulePermitted ∧ isViewPermitted，沒權限就不畫；
 *   按下只做 location.hash = '#/'+m+'/'+v。
 * - 每次 ask 帶 rid（client 產生）與 conv（同一個側欄開著期間不變；按「清除」或離開頁面才換）。對話只留在記憶體。
 * - 手機（≤860px）側欄全螢幕（CSS）；鍵盤可操作：按鈕與側欄內都是 button／textarea，Esc 關閉並把焦點還給按鈕。
 * 測試：createHelper(deps) 的 doc／client／getRoute／canGo／isMobile／setHash 皆可注入（用極簡假 DOM 跑）。
 */

'use strict';

import { getClient, newConvId, newRid, errorMessage } from './client.js';
import { isDryRun } from '../dryrun.js';

export const MAX_Q = 300;
export const NOTE_TEXT = '問題會送交外部 AI（Anthropic）處理，並在系統保存 90 天';
export const DRYRUN_TEXT = '試跑模式中，小幫手不能使用';
export const FALLBACK_TITLE = '小幫手暫時無法回答，這頁常見問題：';
export const FB_NOTED_TEXT = '謝謝，已通知管理人員';
export const FB_RECEIVED_TEXT = '已收到你的回饋';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** 帶我去的項目清洗：只收 {m,v} 字元白名單、label 純字串；最多 2 筆；沒權限的不收 */
export function cleanGo(list, canGo) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const g of list) {
    if (out.length >= 2) break;
    if (!g || typeof g !== 'object') continue;
    if (typeof g.m !== 'string' || typeof g.v !== 'string' || !ID_RE.test(g.m) || !ID_RE.test(g.v)) continue;
    let ok = false;
    try { ok = typeof canGo === 'function' && canGo(g.m, g.v) === true; } catch (e) { ok = false; }
    if (!ok) continue;
    const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 30) : '帶我去';
    out.push({ m: g.m, v: g.v, label });
  }
  return out;
}

export function createHelper(deps) {
  const doc = deps.doc;
  const client = deps.client;
  const getRoute = deps.getRoute || (() => ({ m: '', v: '' }));
  const canGo = deps.canGo || (() => false);
  const isMobile = deps.isMobile || (() => false);
  const setHash = deps.setHash || ((h) => { /* 瀏覽器端由 mountHelper 注入 */ });
  const newConv = deps.newConv || (() => newConvId());
  const newRidFn = deps.newRid || (() => newRid());
  const dryRun = deps.isDryRun || (() => false);   // 試跑模式：不送 ask／feedback／draft

  let host = null, fab = null, panel = null, logEl = null, quotaEl = null, input = null, sendBtn = null, counter = null;
  let attachTo = null;
  let destroyed = false;
  let isOpen = false;
  let busy = false;
  let capped = false;
  let conv = '';
  let left = null;

  function h(tag, attrs, text) {
    const e = doc.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach((k) => e.setAttribute(k, a[k]));
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  const scrollEnd = () => { try { logEl.scrollTop = logEl.scrollHeight; } catch (e) { /* ignore */ } };

  // ---------- 對話泡泡 ----------
  function addUser(text) {
    const b = h('div', { class: 'aih-msg aih-user', 'data-role': 'aih-msg', 'data-from': 'user' });
    b.appendChild(h('p', { class: 'aih-text' }, text));
    logEl.appendChild(b);
    scrollEnd();
  }

  function addNotice(text, role) {
    const b = h('div', { class: 'aih-msg aih-bot aih-err', 'data-role': role || 'aih-error', 'data-from': 'bot' });
    b.appendChild(h('p', { class: 'aih-text' }, text));
    logEl.appendChild(b);
    scrollEnd();
    return b;
  }

  function sendFeedback(id, good, row, upBtn, downBtn) {
    upBtn.disabled = true;
    downBtn.disabled = true;
    (good ? upBtn : downBtn).setAttribute('aria-pressed', 'true');
    const note = h('span', { class: 'aih-fb-note', 'data-role': 'aih-fb-note' }, '已送出');
    row.appendChild(note);
    Promise.resolve(client.feedback({ id, good })).then((r) => {
      if (!r || !r.ok) {
        note.textContent = '沒送出，請稍後再試';
        upBtn.disabled = false;
        downBtn.disabled = false;
        upBtn.setAttribute('aria-pressed', 'false');
        downBtn.setAttribute('aria-pressed', 'false');
      } else {
        // 只有後端說待回答真的寫成功（noted:true）才說「已通知管理人員」，否則只說收到
        note.textContent = (!good && r.data && r.data.noted === true) ? FB_NOTED_TEXT : FB_RECEIVED_TEXT;
      }
    }).catch(() => { note.textContent = '沒送出，請稍後再試'; upBtn.disabled = false; downBtn.disabled = false; });
  }

  function goTo(m, v) {
    setHash('#/' + m + '/' + v);
    if (isMobile()) close();   // 手機側欄是全螢幕，去別頁前要先讓出畫面
  }

  function addAnswer(data) {
    const b = h('div', { class: 'aih-msg aih-bot', 'data-role': 'aih-msg', 'data-from': 'bot' });
    const unknown = data.kind === 'unknown';
    if (unknown) b.setAttribute('data-kind', 'unknown');
    b.appendChild(h('p', { class: 'aih-text', 'data-role': 'aih-answer' }, typeof data.answer === 'string' ? data.answer : ''));
    if (typeof data.who === 'string' && data.who.trim()) {
      b.appendChild(h('p', { class: 'aih-who', 'data-role': 'aih-who' }, '可以問：' + data.who.trim().slice(0, 100)));
    }
    const gos = cleanGo(data.go, canGo);
    if (gos.length) {
      const row = h('div', { class: 'aih-gos' });
      gos.forEach((g) => {
        const btn = h('button', { type: 'button', class: 'aih-go', 'data-role': 'aih-go', 'data-m': g.m, 'data-v': g.v }, g.label);
        btn.addEventListener('click', () => goTo(g.m, g.v));
        row.appendChild(btn);
      });
      b.appendChild(row);
    }
    if (typeof data.id === 'string' && data.id) {
      const row = h('div', { class: 'aih-fb', 'data-role': 'aih-fb' });
      const up = h('button', { type: 'button', class: 'aih-fb-btn', 'data-act': 'up', 'aria-label': '有幫助', 'aria-pressed': 'false' }, '👍');
      const down = h('button', { type: 'button', class: 'aih-fb-btn', 'data-act': 'down', 'aria-label': '沒幫助', 'aria-pressed': 'false' }, '👎');
      up.addEventListener('click', () => sendFeedback(data.id, true, row, up, down));
      down.addEventListener('click', () => sendFeedback(data.id, false, row, up, down));
      row.appendChild(up);
      row.appendChild(down);
      b.appendChild(row);
    }
    logEl.appendChild(b);
    scrollEnd();
  }

  // ---------- 送出 ----------
  function updateQuota() {
    if (!quotaEl) return;
    quotaEl.textContent = (typeof left === 'number' && !capped) ? ('今天還可以問 ' + Math.max(0, left) + ' 題') : '';
  }

  function setCapped() {
    capped = true;
    input.disabled = true;
    sendBtn.disabled = true;
    input.hidden = true;
    sendBtn.hidden = true;
    counter.hidden = true;
    updateQuota();
  }

  /** 錯誤泡泡下面的「這頁常見問題」：題目是按鈕，點開看知識庫原文（純文字、不經 AI） */
  function addFallback(list) {
    const box = h('div', { class: 'aih-fallback', 'data-role': 'aih-fallback' });
    box.appendChild(h('p', { class: 'aih-text', 'data-role': 'aih-fallback-title' }, FALLBACK_TITLE));
    list.forEach((it) => {
      const btn = h('button', { type: 'button', class: 'aih-fq', 'data-role': 'aih-fq', 'aria-expanded': 'false' }, it.question);
      const ans = h('p', { class: 'aih-text aih-fa', 'data-role': 'aih-fa' }, it.answer);
      ans.hidden = true;
      btn.addEventListener('click', () => {
        ans.hidden = !ans.hidden;
        btn.setAttribute('aria-expanded', ans.hidden ? 'false' : 'true');
      });
      box.appendChild(btn);
      box.appendChild(ans);
    });
    logEl.appendChild(box);
    scrollEnd();
  }

  /** 送一題（新問題與「重試」共用）：rid、page 由呼叫端決定——重試沿用同一個 rid 與同一個頁面 */
  async function runAsk(q, page, rid) {
    busy = true;
    sendBtn.disabled = true;
    if (!conv) conv = newConv();
    const pending = h('div', { class: 'aih-msg aih-bot aih-pending', 'data-role': 'aih-pending' });
    pending.appendChild(h('p', { class: 'aih-text' }, '小幫手查詢中…'));
    logEl.appendChild(pending);
    scrollEnd();
    let r;
    try {
      r = await client.ask({ q, page, conv, rid });
    } catch (e) {
      r = { ok: false, code: 'network', error: errorMessage('network') };
    }
    if (destroyed) return;
    try { logEl.removeChild(pending); } catch (e) { /* ignore */ }
    if (r && r.ok && r.data) {
      if (typeof r.data.left_today === 'number') left = r.data.left_today;   // 以後端算的為準
      else if (typeof left === 'number') left -= 1;
      updateQuota();
      addAnswer(r.data);
    } else {
      const code = r && typeof r.code === 'string' ? r.code : 'ai_error';
      const notice = addNotice(errorMessage(code), 'aih-error');   // unauthorized＝「請重新登入」，不自動登出
      if (code === 'cap') setCapped();
      else if (code === 'network' || code === 'timeout') addRetry(notice, q, page, rid);
      else if (code === 'ai_error' && r && Array.isArray(r.fallback) && r.fallback.length) addFallback(r.fallback.slice(0, 3));
    }
    busy = false;
    if (!capped) { sendBtn.disabled = false; try { input.focus(); } catch (e) { /* ignore */ } }
  }

  /** 網路／逾時失敗：同一題給「重試」，沿用同一個 rid（後端 10 分鐘內同 uid＋rid 只算一次） */
  function addRetry(notice, q, page, rid) {
    const btn = h('button', { type: 'button', class: 'aih-retry', 'data-role': 'aih-retry' }, '重試');
    btn.addEventListener('click', () => {
      if (busy || capped || dryRun() || destroyed) return;
      try { logEl.removeChild(notice); } catch (e) { /* ignore */ }
      runAsk(q, page, rid);
    });
    notice.appendChild(btn);
  }

  async function send() {
    if (busy || capped || dryRun()) return;
    const q = String(input.value || '').trim();
    if (!q) return;
    if (q.length > MAX_Q) { addNotice(errorMessage('bad_input'), 'aih-error'); return; }
    if (!conv) conv = newConv();
    addUser(q);
    input.value = '';
    updateCounter();
    let page = { m: '', v: '' };
    try { page = getRoute() || page; } catch (e) { /* 取不到就當通用頁 */ }
    await runAsk(q, page, newRidFn());
  }

  function updateCounter() {
    counter.textContent = String(String(input.value || '').length) + '／' + MAX_Q;
  }

  function clearChat() {
    if (busy) return;
    while (logEl.firstChild) logEl.removeChild(logEl.firstChild);
    conv = '';
    greet();
  }

  function greet() {
    if (dryRun()) { addNotice(DRYRUN_TEXT, 'aih-dryrun'); return; }
    if (capped) { addNotice(errorMessage('cap'), 'aih-cap'); return; }
    const b = h('div', { class: 'aih-msg aih-bot', 'data-role': 'aih-hello', 'data-from': 'bot' });
    b.appendChild(h('p', { class: 'aih-text' }, '有問題直接問我，例如：「我為什麼看不到某個功能？」「請假要去哪裡申請？」'));
    logEl.appendChild(b);
  }

  // ---------- 開關 ----------
  function onDocKey(e) {
    if (e && (e.key === 'Escape' || e.key === 'Esc')) close();
  }

  /** 側欄每次打開都重打 status：更新剩餘題數；額度用完／被關掉就收起輸入框（失敗就維持畫面不動） */
  async function refreshStatus() {
    let r;
    try { r = await client.status(); } catch (e) { return; }
    if (destroyed || !r || !r.ok || !r.data || typeof r.data !== 'object') return;
    if (typeof r.data.left_today === 'number') left = r.data.left_today;
    if (r.data.reason === 'cap' && !capped) { setCapped(); addNotice(errorMessage('cap'), 'aih-cap'); }
    else if (r.data.on !== true && r.data.reason !== 'cap' && !capped) { setCapped(); addNotice(errorMessage('off'), 'aih-off'); }
    updateQuota();
  }

  function open() {
    if (isOpen || destroyed) return;
    isOpen = true;
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    doc.addEventListener('keydown', onDocKey);
    if (!conv && !capped) conv = newConv();   // 同一個側欄開著期間 conv 不變
    try { (capped ? panel.querySelector('[data-role="aih-close"]') : input).focus(); } catch (e) { /* ignore */ }
    if (!dryRun()) refreshStatus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('keydown', onDocKey);
    try { fab.focus(); } catch (e) { /* ignore */ }
  }

  // ---------- 建 DOM ----------
  function build() {
    host = h('div', { class: 'aih-root', 'data-role': 'aih-root' });
    fab = h('button', { type: 'button', class: 'aih-fab', 'data-role': 'aih-fab', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': '問小幫手', title: '問小幫手' }, '問小幫手');
    fab.addEventListener('click', () => { if (isOpen) close(); else open(); });

    panel = h('section', { class: 'aih-panel', 'data-role': 'aih-panel', role: 'dialog', 'aria-label': 'AI 小幫手' });
    panel.hidden = true;
    const head = h('div', { class: 'aih-head' });
    head.appendChild(h('div', { class: 'aih-title' }, '小幫手'));
    const clearBtn = h('button', { type: 'button', class: 'aih-hbtn', 'data-role': 'aih-clear' }, '清除對話');
    clearBtn.addEventListener('click', clearChat);
    const closeBtn = h('button', { type: 'button', class: 'aih-hbtn', 'data-role': 'aih-close', 'aria-label': '關閉小幫手' }, '關閉');
    closeBtn.addEventListener('click', close);
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);

    logEl = h('div', { class: 'aih-log', 'data-role': 'aih-log', 'aria-live': 'polite' });
    quotaEl = h('div', { class: 'aih-quota', 'data-role': 'aih-quota' });
    input = h('textarea', { class: 'aih-input', 'data-role': 'aih-input', maxlength: String(MAX_Q), rows: '2', placeholder: '輸入你的問題（最多 ' + MAX_Q + ' 字）', 'aria-label': '你的問題' });
    sendBtn = h('button', { type: 'button', class: 'aih-send', 'data-role': 'aih-send' }, '送出');
    counter = h('span', { class: 'aih-count', 'data-role': 'aih-count' }, '0／' + MAX_Q);
    input.addEventListener('input', updateCounter);
    input.addEventListener('keydown', (e) => {
      if (e && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { if (e.preventDefault) e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', send);
    const form = h('div', { class: 'aih-form' });
    form.appendChild(input);
    const row = h('div', { class: 'aih-form-row' });
    row.appendChild(counter);
    row.appendChild(sendBtn);
    form.appendChild(row);
    const note = h('p', { class: 'aih-note', 'data-role': 'aih-note' }, NOTE_TEXT);

    panel.appendChild(head);
    panel.appendChild(logEl);
    panel.appendChild(quotaEl);
    panel.appendChild(form);
    panel.appendChild(note);
    host.appendChild(fab);
    host.appendChild(panel);
    greet();
  }

  return {
    /** 打 status；按鈕只在「可用」或「額度用完」時才加進畫面。回 true＝按鈕出現 */
    async start(parent) {
      attachTo = parent;
      let r;
      try { r = await client.status(); } catch (e) { return false; }
      if (destroyed) return false;
      if (!r || !r.ok || !r.data || typeof r.data !== 'object') return false;   // 任何錯誤（含 404、網路失敗）→ 不出現
      const reasonCap = r.data.reason === 'cap';
      if (r.data.on !== true && !reasonCap) return false;
      capped = reasonCap;
      if (typeof r.data.left_today === 'number') left = r.data.left_today;
      build();
      if (dryRun()) { while (logEl.firstChild) logEl.removeChild(logEl.firstChild); setCapped(); greet(); }
      else if (capped) { while (logEl.firstChild) logEl.removeChild(logEl.firstChild); setCapped(); greet(); }
      updateQuota();
      attachTo.appendChild(host);
      return true;
    },
    open,
    close,
    destroy() {
      destroyed = true;
      if (isOpen) { isOpen = false; try { doc.removeEventListener('keydown', onDocKey); } catch (e) { /* ignore */ } }
      if (host && attachTo) { try { attachTo.removeChild(host); } catch (e) { /* ignore */ } }
      host = null;
    },
    get conv() { return conv; },
    get el() { return host; }
  };
}

// ============================================================
// 瀏覽器端：殼呼叫的兩個入口
// ============================================================

let current = null;
let cssAdded = false;

function addCss() {
  if (cssAdded || typeof document === 'undefined' || !document.head) return;
  cssAdded = true;
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./helper.css', import.meta.url).href;
    link.setAttribute('data-role', 'aih-css');
    document.head.appendChild(link);
  } catch (e) { /* 沒有樣式只是醜，不影響殼 */ }
}

/**
 * @param {HTMLElement} shellEl 殼的根容器（按鈕與側欄掛在它底下）
 * @param {{getRoute:()=>{m:string,v:string}, canGo:(m:string,v:string)=>boolean}} opts
 */
export function mountHelper(shellEl, opts) {
  unmountHelper();
  if (typeof document === 'undefined' || !shellEl) return Promise.resolve(false);
  const o = opts || {};
  addCss();
  const mq = (typeof window !== 'undefined' && typeof window.matchMedia === 'function') ? window.matchMedia('(max-width: 860px)') : null;
  const helper = createHelper({
    doc: document,
    client: getClient(),
    getRoute: o.getRoute,
    canGo: o.canGo,
    isMobile: () => !!(mq && mq.matches),
    isDryRun,
    setHash: (hash) => { window.location.hash = hash; }
  });
  current = helper;
  return helper.start(shellEl).catch(() => false);
}

export function unmountHelper() {
  if (current) { try { current.destroy(); } catch (e) { /* ignore */ } current = null; }
}
