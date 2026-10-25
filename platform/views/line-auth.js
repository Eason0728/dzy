/**
 * platform/views/line-auth.js — 用 LINE 開通／重設密碼（docs/line-auth/spec.md v1.1 第 0、6 節）
 *
 * 頁面：line.html（登入前、不進殼）。LIFF 小頁面：?m=claim|reset → liff.init → 未登入就 liff.login()
 * → liff.getIDToken() → POST /platform/svc/line-auth {op:'check', want, id_token} → 依 mode 畫畫面。
 * 後端（Mac mini lineauth.js 白名單）只回 ok/mode/error/message/name/emp_no/unit_name/title_options/title_names/
 * days_left/need_line_punch/nonce/reason；wrong_op 的 expected_mode 與 blocked 的 status 不會到前端，所以
 * wrong_op 的導向以「與使用者想做的相反」為準（有 expected_mode 就用它）。
 *
 * 安全規則：
 * - 所有畫面文字一律 textContent／value，不用 innerHTML（姓名、單位名來自後端，當資料不當 HTML）。
 * - 密碼只活在 submit handler 的區域變數，送出後不留副本、不進網址、不進 log。
 * - id token 不存任何地方，只活在 run 的區域變數。
 * 測試掛勾：createLineAuth(deps) 的 deps（doc／root／liff／fetch／liffId／search／url／nav）可注入；
 * 瀏覽器端 boot() 另讀 window.__LINE_AUTH_TEST__（同樣的欄位）。
 */

import { BACKENDS, LINE_LIFF_ID } from '../config.js';

export const LIFF_SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

/** 登入前原本的方式（index.html 的 hash 路由，見 login.js currentMode） */
export const FALLBACK_HREF = { claim: 'index.html#/claim', reset: 'index.html#/forgot' };

export const T = {
  preparing: '功能準備中',
  badLink: '連結不正確，請回管理系統登入頁，從「用 LINE 開通」或「用 LINE 重設密碼」按鈕重新開啟。',
  loading: '確認身分中…',
  title: { claim: '用 LINE 開通', reset: '用 LINE 重設密碼' },
  fallback: '改用原本的方式',
  claimSent: '已送出，等主管核准後就能登入',
  resetDone: '密碼已更新，其他裝置已登出',
  toLogin: '前往登入',
  notTrustedWait: (n) => `你的 LINE 綁定還要 ${n} 天才能用`,
  needLinePunch: '請先用 LINE 打一次卡，隔天就能用',
  notTrustedOther: '暫時無法確認，請改用原本的方式',
  notBound: '找不到你的 LINE 打卡綁定。請先用 LINE 打卡綁定，或改用原本的方式。',
  ambiguous: '這個 LINE 對到多位同仁，請找人資協助，或改用原本的方式。',
  blocked: '你的帳號目前不能用 LINE 處理（可能正在等主管審核或已停用），請找你的主管或人資。',
  needReviewClaim: '你的職務要走一般認領流程，主管審核',
  needReviewReset: '暫時無法用 LINE 處理，請改用原本的方式。',
  off: 'LINE 開通與重設目前未開放，請改用原本的方式。',
  wrongToClaim: '你的帳號還沒開通，請改用「用 LINE 開通」。',
  wrongToReset: '你的帳號已經開通，要重設密碼請改用「用 LINE 重設密碼」。',
  goClaim: '前往「用 LINE 開通」',
  goReset: '前往「用 LINE 重設密碼」',
  reopen: '請關閉後重新開啟',
  renewed: '已重新驗證，請再按一次送出',
  errors: {
    rate_limited: '操作太頻繁或今天的次數已用完，請稍後再試',
    busy: '系統忙碌，請稍後再試',
    line_unreachable: '暫時連不上 LINE，請稍後再試',
    forbidden_origin: '來源不被允許，請從管理系統登入頁的按鈕重新開啟',
    server_error: '系統忙碌，請稍後再試',
    network: '網路連線有問題，請檢查網路後再試',
    bad_input: '資料格式不對，請重新開啟頁面'
  }
};

/** LIFF 的 endpoint 對應到 LINE 路由：…/platform/api → …/platform/svc/line-auth（同 api.js proxyUrl() 的換路徑做法）；推不出來回 '' */
export function lineAuthUrl(platformUrl) {
  const u = platformUrl === undefined ? (BACKENDS.platform || '') : String(platformUrl || '');
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/svc/line-auth') : '';
}

/** 登入頁兩顆按鈕的資料：LIFF ID 空＝不顯示（回 []） */
export function lineLoginLinks(liffId) {
  const id = String(liffId === undefined ? LINE_LIFF_ID : liffId || '').trim();
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return [];
  return [
    { mode: 'claim', label: '用 LINE 開通', href: `https://liff.line.me/${id}?m=claim` },
    { mode: 'reset', label: '用 LINE 重設密碼', href: `https://liff.line.me/${id}?m=reset` }
  ];
}

/** 從網址讀 m：直接 ?m=，或 LIFF 轉址帶來的 liff.state（編碼過的 ?m=claim）。不合法回 '' */
export function parseMode(search) {
  const grab = (q) => {
    const m = /(?:^|[?&])m=([^&#]*)/.exec(q || '');
    return m ? decodeURIComponent(m[1]) : '';
  };
  let v = '';
  try {
    v = grab(search);
    if (v !== 'claim' && v !== 'reset') {
      const st = /(?:^|[?&])liff\.state=([^&#]*)/.exec(search || '');
      if (st) v = grab(decodeURIComponent(st[1]));
    }
  } catch (e) { v = ''; }
  return v === 'claim' || v === 'reset' ? v : '';
}

// ------------------------------------------------------------
// 欄位驗證——規則與文字抄自 apps-script/platform/Staff.gs（stfValidate*_）與 platform/views/claim.js；
// test/line-auth-front.test.mjs 會比對來源字串，兩邊改了這裡會紅。後端永遠會再驗一次。
// ------------------------------------------------------------
export const MSG = {
  pwShort: '密碼至少要 8 個字元',
  pwSame: '密碼不能跟編號一樣',
  pwMismatch: '兩次輸入的密碼不一樣',
  pwLong: '密碼最多 128 個字元',
  phone: '手機要是 09 開頭的 10 碼數字',
  birthdayFormat: '生日格式要是 YYYY-MM-DD',
  birthdayInvalid: '生日不是有效的日期',
  birthdayRange: '生日年份看起來不對，請再確認',
  address: '居住地址請填 5～100 個字',
  title: '請選擇職稱'
};

export function validateBirthday(s, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return MSG.birthdayFormat;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return MSG.birthdayInvalid;
  const nowY = new Date((nowMs === undefined ? Date.now() : nowMs) + 8 * 3600 * 1000).getUTCFullYear();
  const age = nowY - y;
  if (age < 15 || age > 80) return MSG.birthdayRange;
  return null;
}

export function validatePassword(pw, pw2, empNo) {
  if (pw.length < 8) return MSG.pwShort;
  if (pw.length > 128) return MSG.pwLong;
  if (String(pw).toUpperCase() === String(empNo || '').toUpperCase()) return MSG.pwSame;
  if (pw !== pw2) return MSG.pwMismatch;
  return null;
}

/** 開通表單檢查。回 { error } 或 { form }（手機已去掉空白與連字號） */
export function validateClaimForm(v, empNo, titleOptions, nowMs) {
  const title = String(v.title || '');
  if (!title || (titleOptions || []).indexOf(title) === -1) return { error: MSG.title };
  const phone = String(v.phone || '').replace(/[\s-]/g, '');
  if (!/^09[0-9]{8}$/.test(phone)) return { error: MSG.phone };
  const birthday = String(v.birthday || '');
  const bErr = validateBirthday(birthday, nowMs);
  if (bErr) return { error: bErr };
  const address = String(v.address || '').trim();
  if (address.length < 5 || address.length > 100) return { error: MSG.address };
  const pErr = validatePassword(String(v.pw || ''), String(v.pw2 || ''), empNo);
  if (pErr) return { error: pErr };
  return { form: { phone, birthday, address, title, new_password: String(v.pw) } };
}

// ------------------------------------------------------------
// 主程式
// ------------------------------------------------------------

/** 載入 LIFF SDK（已有 window.liff 就直接用）。回 liff 物件 */
function loadSdk(doc, win) {
  if (win && win.liff) return Promise.resolve(win.liff);
  return new Promise((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = LIFF_SDK_URL;
    s.async = true;
    s.onload = () => (win && win.liff ? resolve(win.liff) : reject(new Error('liff missing')));
    s.onerror = () => reject(new Error('liff load failed'));
    doc.head.appendChild(s);
  });
}

/**
 * @param {object} deps
 *   root（畫面容器）、doc（document）、win（window，放 liff 與 location 用）、liff（已載入的 SDK；沒給就載 CDN）、
 *   fetch、liffId、search（?m=… 那串）、url（line-auth 路由網址）、nav（導頁函式，預設 location.assign）
 */
export function createLineAuth(deps) {
  const doc = deps.doc;
  const root = deps.root;
  const win = deps.win || null;
  const doFetch = deps.fetch || (win && win.fetch ? win.fetch.bind(win) : null);
  const liffId = deps.liffId === undefined ? LINE_LIFF_ID : deps.liffId;
  const url = deps.url === undefined ? lineAuthUrl() : deps.url;
  const nav = deps.nav || ((href) => { if (win && win.location) win.location.assign(href); });

  let want = '';
  let liff = null;

  // ---------- DOM 小工具（只用 textContent／setAttribute，沒有 innerHTML） ----------
  function h(tag, attrs, text) {
    const e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function kids(parent, list) { list.filter(Boolean).forEach((c) => parent.appendChild(c)); return parent; }
  function screen(name, title, children) {
    const card = h('div', { class: 'card', 'data-role': 'line-card', 'data-screen': name });
    card.appendChild(h('h1', { class: 'card-title' }, title));
    kids(card, children);
    root.replaceChildren(card);
    return card;
  }
  const para = (text, role) => h('p', Object.assign({ class: 'pre-text' }, role ? { 'data-role': role } : {}), text);
  const errBox = () => { const b = h('div', { class: 'toast toast-danger', 'data-role': 'error' }); b.hidden = true; return b; };
  function showError(card, msg) {
    const b = card.querySelector('[data-role="error"]');
    if (!b) return;
    b.textContent = msg || '';
    b.hidden = !msg;
  }
  function linkBtn(role, label, href, primary) {
    return h('a', { class: 'btn ' + (primary ? 'btn-primary' : 'btn-secondary') + ' btn-block', 'data-role': role, href }, label);
  }
  const titleOf = (m) => T.title[m || want] || '用 LINE 認身分';
  const fallbackBtn = () => linkBtn('fallback', T.fallback, FALLBACK_HREF[want] || FALLBACK_HREF.claim, false);

  function showInfo(name, text, opts) {
    const o = opts || {};
    return screen(name, o.title || titleOf(), [para(text, 'message'), ...(o.extra || []), o.noFallback ? null : fallbackBtn()]);
  }
  function showLoading() { return screen('loading', titleOf(), [para(T.loading, 'message')]); }
  function showReopen() { return showInfo('reopen', T.reopen, { noFallback: true }); }

  // ---------- 網路 ----------
  /** POST 到 line-auth 路由。永遠回物件（網路／解析失敗＝{ok:false,error:'network'}） */
  async function post(body) {
    if (!doFetch || !url) return { ok: false, error: 'server_error' };
    try {
      const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
      const j = await res.json();
      return j && typeof j === 'object' ? j : { ok: false, error: 'server_error' };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  async function getToken() {
    try { return (liff.getIDToken && liff.getIDToken()) || ''; } catch (e) { return ''; }
  }

  // ---------- check 結果 → 畫面 ----------
  function errText(r) {
    if (r.error === 'bad_input' && r.message) return r.message;
    return T.errors[r.error] || (r.message ? String(r.message) : T.errors.server_error);
  }

  function renderMode(r, token) {
    const mode = r.mode || (r.ok === false ? r.error : '');
    if (r.ok === false && !['not_bound', 'not_trusted', 'ambiguous', 'blocked', 'need_review', 'off'].includes(r.error)) {
      if (r.error === 'invalid_token') return showReopen();
      return showInfo('error', errText(r));
    }
    switch (mode) {
      case 'claim': return renderClaim(r, token);
      case 'reset': return renderReset(r, token);
      case 'not_trusted': return renderNotTrusted(r);
      case 'not_bound': return showInfo('not_bound', T.notBound);
      case 'ambiguous': return showInfo('ambiguous', T.ambiguous);
      case 'blocked': return showInfo('blocked', T.blocked);
      case 'need_review': return showInfo('need_review', want === 'claim' ? T.needReviewClaim : T.needReviewReset);
      case 'off': return showInfo('off', T.off);
      case 'wrong_op': return renderWrongOp(r);
      default: return showInfo('error', T.errors.server_error);
    }
  }

  function renderNotTrusted(r) {
    let text = T.notTrustedOther;
    if (r.reason === 'wait') {
      const n = Number(r.days_left);
      text = T.notTrustedWait(Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1);
    } else if (r.reason === 'need_line_punch') text = T.needLinePunch;
    return showInfo('not_trusted', text);
  }

  function renderWrongOp(r) {
    const exp = r.expected_mode === 'claim' || r.expected_mode === 'reset' ? r.expected_mode : (want === 'claim' ? 'reset' : 'claim');
    const link = linkBtn('goto-' + exp, exp === 'claim' ? T.goClaim : T.goReset, 'line.html?m=' + exp, true);
    return showInfo('wrong_op', exp === 'claim' ? T.wrongToClaim : T.wrongToReset, { extra: [link], noFallback: true });
  }

  // ---------- 送出共用：token 過期重取一次、nonce 失效重新 check ----------
  async function submitOp(card, token, nonceRef, build) {
    let res = await post(build(token, nonceRef.nonce));
    if (res.ok === false && res.error === 'invalid_token') {
      const t2 = await getToken();
      if (!t2) return { fatal: true };
      res = await post(build(t2, nonceRef.nonce));
      if (res.ok === false && res.error === 'invalid_token') return { fatal: true };
      nonceRef.token = t2;
    }
    if (res.ok === false && res.error === 'bad_input' && res.reason === 'nonce') {
      const tk = nonceRef.token || token;
      const again = await post({ op: 'check', want, id_token: tk });
      if (again.ok === true && again.mode === want && again.nonce) {
        nonceRef.nonce = again.nonce;
        showError(card, T.renewed);
        return { renewed: true };
      }
      return { screen: again };
    }
    return { res };
  }

  // ---------- 開通 ----------
  function renderClaim(r, token) {
    const empNo = String(r.emp_no || '');
    const opts = Array.isArray(r.title_options) ? r.title_options.filter((x) => typeof x === 'string') : [];
    const names = r.title_names && typeof r.title_names === 'object' ? r.title_names : {};
    const nonceRef = { nonce: r.nonce, token };

    const radios = opts.map((t, i) => {
      const row = h('div', { class: 'checkbox-row' });
      const inp = h('input', { type: 'radio', name: 'line-title', id: 'line-title-' + i, value: t, 'data-role': 'title-' + t });
      row.appendChild(inp);
      row.appendChild(h('label', { class: 'field-label', for: 'line-title-' + i }, names[t] || t));
      return row;
    });
    const field = (id, label, type, extra) => {
      const f = h('div', { class: 'field' });
      f.appendChild(h('label', { class: 'field-label', for: id }, label));
      f.appendChild(h('input', Object.assign({ class: 'input', id, type }, extra || {})));
      return f;
    };
    const pair = (a, b) => kids(h('div', { class: 'form-grid-2' }), [a, b]);
    const titleField = h('div', { class: 'field', 'data-role': 'title-wrap' });
    titleField.appendChild(h('span', { class: 'field-label' }, '職稱'));
    kids(titleField, radios);
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit', 'data-role': 'submit' }, '送出審核');
    const form = h('form', { class: 'stack', 'data-role': 'form', novalidate: 'novalidate' });
    kids(form, [
      titleField,
      pair(field('line-birthday', '生日', 'date', { required: 'required' }), field('line-phone', '手機', 'tel', { inputmode: 'numeric', placeholder: '0912345678', required: 'required' })),
      field('line-address', '居住地址', 'text', { autocomplete: 'street-address', required: 'required' }),
      pair(field('line-pw', '設定密碼（8 碼以上）', 'password', { autocomplete: 'new-password', required: 'required' }),
        field('line-pw2', '再輸入一次', 'password', { autocomplete: 'new-password', required: 'required' })),
      h('p', { class: 'field-hint' }, '送出後要等你的單位主管審核，通過後才能用編號登入。'),
      submit
    ]);
    const who = `${r.name || ''}（${empNo}）・${r.unit_name || ''}`;
    const card = screen('claim', T.title.claim, [para(who, 'who'), errBox(), form, fallbackBtn()]);
    const q = (sel) => card.querySelector(sel);

    form.addEventListener('submit', async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const picked = radios.map((row) => row.querySelector('input')).find((i) => i.checked);
      const v = validateClaimForm({
        title: picked ? picked.value : '',
        phone: q('#line-phone').value, birthday: q('#line-birthday').value, address: q('#line-address').value,
        pw: q('#line-pw').value, pw2: q('#line-pw2').value
      }, empNo, opts);
      if (v.error) return showError(card, v.error);
      showError(card, '');
      submit.disabled = true;
      submit.textContent = '送出中，請稍候…';
      const out = await submitOp(card, token, nonceRef, (tk, nonce) => ({ op: 'claim', id_token: tk, nonce, form: v.form }));
      submit.disabled = false;
      submit.textContent = '送出審核';
      if (out.fatal) return showReopen();
      if (out.renewed) return undefined;
      if (out.screen) return renderMode(out.screen, token);
      const res = out.res;
      if (res.ok === true && res.mode === 'done') return showInfo('claim_done', T.claimSent, { title: '已送出', extra: [linkBtn('to-login', T.toLogin, 'index.html', true)], noFallback: true });
      if (res.ok === true) return renderMode(res, token);
      if (['not_bound', 'not_trusted', 'ambiguous', 'blocked', 'need_review', 'off'].includes(res.error)) return renderMode(res, token);
      return showError(card, errText(res));
    });
    return card;
  }

  // ---------- 重設 ----------
  function renderReset(r, token) {
    const empNo = String(r.emp_no || '');
    const nonceRef = { nonce: r.nonce, token };
    const f1 = h('div', { class: 'field' });
    f1.appendChild(h('label', { class: 'field-label', for: 'line-pw' }, '新密碼（8 碼以上）'));
    f1.appendChild(h('input', { class: 'input', id: 'line-pw', type: 'password', autocomplete: 'new-password', required: 'required' }));
    const f2 = h('div', { class: 'field' });
    f2.appendChild(h('label', { class: 'field-label', for: 'line-pw2' }, '再輸入一次'));
    f2.appendChild(h('input', { class: 'input', id: 'line-pw2', type: 'password', autocomplete: 'new-password', required: 'required' }));
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit', 'data-role': 'submit' }, '設定新密碼');
    const form = h('form', { class: 'stack', 'data-role': 'form', novalidate: 'novalidate' });
    kids(form, [kids(h('div', { class: 'form-grid-2' }), [f1, f2]), submit]);
    const card = screen('reset', T.title.reset, [para(`${r.name || ''}（${empNo}）`, 'who'), errBox(), form, fallbackBtn()]);

    form.addEventListener('submit', async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const pw = card.querySelector('#line-pw').value;
      const pw2 = card.querySelector('#line-pw2').value;
      const pErr = validatePassword(pw, pw2, empNo);
      if (pErr) return showError(card, pErr);
      showError(card, '');
      submit.disabled = true;
      submit.textContent = '送出中，請稍候…';
      const out = await submitOp(card, token, nonceRef, (tk, nonce) => ({ op: 'reset', id_token: tk, nonce, new_password: pw }));
      submit.disabled = false;
      submit.textContent = '設定新密碼';
      if (out.fatal) return showReopen();
      if (out.renewed) return undefined;
      if (out.screen) return renderMode(out.screen, token);
      const res = out.res;
      if (res.ok === true && res.mode === 'done') return showInfo('reset_done', T.resetDone, { title: '完成', extra: [linkBtn('to-login', T.toLogin, 'index.html', true)], noFallback: true });
      if (res.ok === true) return renderMode(res, token);
      if (['not_bound', 'not_trusted', 'ambiguous', 'blocked', 'need_review', 'off'].includes(res.error)) return renderMode(res, token);
      return showError(card, errText(res));
    });
    return card;
  }

  // ---------- 入口 ----------
  async function run() {
    want = parseMode(deps.search === undefined ? (win && win.location ? win.location.search : '') : deps.search);
    if (!String(liffId || '').trim()) return showInfo('preparing', T.preparing, { title: T.preparing, noFallback: true });
    if (!want) return showInfo('bad_link', T.badLink, { title: '用 LINE 認身分', extra: [linkBtn('to-login', T.toLogin, 'index.html', false)], noFallback: true });
    showLoading();
    try {
      liff = deps.liff || await loadSdk(doc, win);
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: win && win.location ? win.location.href : undefined });
        return undefined;   // 頁面會被導去 LINE 登入再回來
      }
    } catch (e) {
      return showInfo('liff_error', '無法連到 LINE，請確認是在 LINE 裡開啟，或稍後再試。');
    }
    const token = await getToken();
    if (!token) return showReopen();
    let r = await post({ op: 'check', want, id_token: token });
    if (r.ok === false && r.error === 'invalid_token') {
      const t2 = await getToken();
      r = t2 ? await post({ op: 'check', want, id_token: t2 }) : r;
      if (r.ok === false && r.error === 'invalid_token') return showReopen();
      return renderMode(r, t2);
    }
    return renderMode(r, token);
  }

  return { run, _: { get want() { return want; } } };
}

/** line.html 呼叫。瀏覽器端的測試掛勾：window.__LINE_AUTH_TEST__ = { liff, fetch, liffId, url, nav, search } */
export function boot() {
  const hook = (typeof window !== 'undefined' && window.__LINE_AUTH_TEST__) || {};
  const root = document.getElementById('line-app');
  const app = createLineAuth(Object.assign({ doc: document, win: window, root }, hook));
  return app.run();
}
