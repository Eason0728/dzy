// node test/unit-review-front.test.mjs —— 2026-10-12 三件事的前端驗收（docs/personnel/spec.md §6.8／§6.9／§7）
// ① 認領送出不登入（auth.claimSubmit 不存 token）② 登出先打後端 logout（逾時／失敗也清本機、dryrun 照送）
// ③ 我的資料：改手機要送 current_password、後端訊息原樣顯示；待審核分頁通過／退回；首頁提醒「有 N 位同仁等你審核」
// 沒有 jsdom：用「選擇器 → 假元素」的極簡 DOM（innerHTML 設定時從字串抓 value／hidden 初值）。全部假資料。
'use strict';

class MemoryStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const auth = await import('../platform/auth.js');
const { isReadAction, __setDryRun } = await import('../platform/dryrun.js');
const { esc } = await import('../platform/fmt.js');
const meManifest = (await import('../modules/me/manifest.js')).default;
const meIndex = (await import('../modules/me/index.js')).default;
const { mountProfile } = await import('../modules/me/views/profile.js');
const { mountReview } = await import('../modules/me/views/review.js');

let passed = 0;
let failed = 0;
const ok = (c, label, extra) => {
  if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
};
const flush = (n = 10) => new Promise((r) => { let k = n; (function s() { if (k-- <= 0) return r(); setImmediate(s); })(); });

// ── 極簡 DOM ────────────────────────────────────────────────
function attrRe(sel) {
  if (sel.startsWith('#')) return new RegExp(`<[^>]*\\bid="${sel.slice(1)}"[^>]*>`);
  const m = /^\[([\w-]+)="([^"]+)"\]$/.exec(sel);
  if (m) return new RegExp(`<[^>]*\\b${m[1]}="${m[2]}"[^>]*>`);
  return null;
}
class FakeNode {
  constructor(tag) { this.tag = tag || ''; this.value = ''; this.hidden = false; this.textContent = ''; this.disabled = false; this._ls = {}; this._html = ''; this._q = new Map(); this.attrs = {}; }
  set innerHTML(h) { this._html = String(h); this._q = new Map(); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
  removeEventListener(t, fn) { const a = this._ls[t] || []; const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1); }
  fire(t, ev) { for (const fn of (this._ls[t] || []).slice()) fn(Object.assign({ preventDefault() {}, target: this }, ev || {})); }
  focus() {}
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  closest(sel) { return this.getAttribute(sel.replace(/^\[|\]$/g, '')) !== null ? this : null; }
  querySelector(sel) {
    if (this._q.has(sel)) return this._q.get(sel);
    const re = attrRe(sel);
    const tag = re ? (re.exec(this._html) || [null])[0] : null;
    if (!tag) return null;
    const n = new FakeNode();
    const v = /\bvalue="([^"]*)"/.exec(tag);
    if (v) n.value = v[1].replace(/&amp;/g, '&');
    n.hidden = /\shidden[\s>]/.test(tag);
    this._q.set(sel, n);
    return n;
  }
}
globalThis.document = { createElement: () => new FakeNode('div') };

const ORG = { brands: [{ code: 'mzt', name: '墨竹亭' }], units: [{ code: 'mzt-gf', name: '新竹光復', parent: 'mzt', ladder: 'store' }], depts: [], titles: [{ code: 'pt', name: '計時同仁', parent: 'store', rank: 1 }] };
const PROFILE = { emp_no: 'DZY001', name: '測試甲', status: 'active', brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', phone: '0911222333', address: '新竹市測試路一段1號', birthday: '1995-05-05', has_pending_change: false };

function makeCtx(handler, perms) {
  const calls = [];
  const toasts = [];
  const dialogs = [];
  let dialogAnswer = null;
  let dialogFill = null;
  const ctx = {
    calls, toasts, dialogs,
    answerDialog(v, fill) { dialogAnswer = v; dialogFill = fill || null; },
    can: (p) => (perms || []).includes(p) || (perms || []).includes('*'),
    fmt: { esc },
    api: { call: async (mod, action, payload) => { calls.push({ mod, action, payload }); return handler(action, payload); } },
    ui: {
      loading() {},
      toast(m, t) { toasts.push([m, t]); },
      async dialog(o) { dialogs.push(o); if (dialogFill) dialogFill(o.body); return dialogAnswer; }
    }
  };
  return ctx;
}

// ============================================================
// 1. auth.claimSubmit：送出成功不登入、不存 token
// ============================================================
{
  localStorage.clear();
  const sent = [];
  // 就算後端（舊版）還回 token，前端也不能自己登入
  auth.__setTransport(async (req) => { sent.push(req); return { ok: true, pending: true, data: { pending: true, token: 'should-not-store', user: { id: 'u9' } } }; });
  const r = await auth.claimSubmit({ name: '測試甲', emp_no: 'DZY001', password: 'fake-pw-1234' });
  ok(r.ok === true && r.pending === true, '1 claimSubmit 成功回 {ok, pending}', r);
  ok(auth.getUser() === null && localStorage.getItem('dzy.token') === null && auth.getToken() === '', '1 ★認領送出後沒有登入、沒存 token');
  auth.__setTransport(async () => ({ ok: false, error: '姓名與編號對不上，請重新輸入全名' }));
  ok((await auth.claimSubmit({})).error === '姓名與編號對不上，請重新輸入全名', '1 後端錯誤訊息原樣回給畫面');
  auth.__setTransport(null);
}

// ============================================================
// 2. auth.logout：先打後端 logout，再清本機；失敗／逾時／dryrun 都照樣
// ============================================================
async function loginFake(tokenStr) {
  auth.__setTransport(async () => ({ ok: true, data: { token: tokenStr, user: { id: 'u1', name: 'x', role: 'staff', node: '' }, perms: ['platform.self'], secrets: { audit: 'S' } } }));
  await auth.login('DZY001', 'pw');
}
{
  await loginFake('tok-A');
  const seen = [];
  let clearedWhenCalled = null;
  auth.__setTransport(async (req) => { seen.push(req); clearedWhenCalled = localStorage.getItem('dzy.token'); return { ok: true, data: {} }; });
  await auth.logout();
  ok(seen.length === 1 && seen[0].action === 'logout' && seen[0].token === 'tok-A', '2 ★登出先送 logout（帶目前的 token）', seen);
  ok(clearedWhenCalled === 'tok-A', '2 送出當下本機還沒清（先後端、再本機）');
  ok(auth.getUser() === null && localStorage.getItem('dzy.token') === null && typeof auth.getSecret === 'undefined', '2 回來後本機清乾淨');

  await loginFake('tok-B');
  auth.__setTransport(async () => { throw new Error('斷網'); });
  await auth.logout();
  ok(auth.getUser() === null && localStorage.getItem('dzy.token') === null, '2 後端失敗也照樣清本機');

  await loginFake('tok-C');
  auth.__setTransport(() => new Promise(() => {})); // 永遠不回
  const t0 = Date.now();
  await auth.logout();
  const dt = Date.now() - t0;
  ok(dt >= 4900 && dt < 6500 && localStorage.getItem('dzy.token') === null, '2 後端不回 → 5 秒逾時後照樣清本機（實測 ' + dt + 'ms）');

  await loginFake('tok-D');
  __setDryRun(true);
  const dry = [];
  auth.__setTransport(async (req) => { dry.push(req.action); return { ok: true, data: {} }; });
  await auth.logout();
  __setDryRun(null);
  ok(dry.join() === 'logout' && localStorage.getItem('dzy.token') === null, '2 ★試跑模式也真的登出（logout 不是資料寫入）');
  ok(isReadAction('platform', 'logout', {}) && isReadAction('platform', 'unitPending', {}), '2 dryrun 白名單放行 logout、unitPending');
  ok(!isReadAction('platform', 'unitApprove', {}) && !isReadAction('platform', 'unitReject', {}), '2 dryrun 擋 unitApprove／unitReject（寫入）');

  const sent2 = [];
  auth.__setTransport(async (req) => { sent2.push(req); return { ok: true }; });
  await auth.logout(); // 沒登入
  ok(sent2.length === 0, '2 沒有 token 時不打後端');
  auth.__setTransport(null);
}

// ============================================================
// 3. 我的資料：改手機要帶目前密碼
// ============================================================
async function mountProfileWith(saveResult) {
  const el = new FakeNode('div');
  const ctx = makeCtx((action) => {
    if (action === 'myProfile') return { ok: true, data: PROFILE };
    if (action === 'orgOptions') return { ok: true, data: ORG };
    if (action === 'saveMyProfile') return saveResult;
    return { ok: false, error: '?' };
  });
  mountProfile(el, ctx);
  await flush();
  return { el, ctx, saves: () => ctx.calls.filter((c) => c.action === 'saveMyProfile') };
}
{
  // 3a 只改地址：不帶密碼、密碼欄不出現
  let m = await mountProfileWith({ ok: true, data: PROFILE });
  ok(m.el.querySelector('[data-role="curpw-wrap"]').hidden === true, '3 一開始不顯示「目前的密碼」');
  m.el.querySelector('#me-address').value = '新竹市測試路二段2號';
  m.el.querySelector('[data-role="form"]').fire('submit');
  await flush();
  ok(m.saves().length === 1 && !('current_password' in m.saves()[0].payload), '3 只改地址 → 不送 current_password', m.saves());

  // 3b 改手機：密碼欄出現；沒填就不送出
  m = await mountProfileWith({ ok: true, data: PROFILE });
  const phone = m.el.querySelector('#me-phone');
  phone.value = '0999-888-777';
  phone.fire('input');
  ok(m.el.querySelector('[data-role="curpw-wrap"]').hidden === false, '3 ★改手機 → 出現「目前的密碼」欄');
  m.el.querySelector('[data-role="form"]').fire('submit');
  await flush();
  ok(m.saves().length === 0 && m.el.querySelector('[data-role="error"]').textContent === '改手機要輸入目前的密碼', '3 改手機沒填密碼 → 不送出、提示');
  m.el.querySelector('#me-curpw').value = 'my-current-pw';
  m.el.querySelector('[data-role="form"]').fire('submit');
  await flush();
  const p = m.saves()[0] && m.saves()[0].payload;
  ok(p && p.phone === '0999888777' && p.current_password === 'my-current-pw', '3 ★改手機送出帶 current_password（手機去連字號）', p);

  // 3c 後端錯誤訊息原樣顯示
  for (const msg of ['目前密碼不正確', '嘗試次數過多，請 15 分鐘後再試', '改手機要輸入目前的密碼']) {
    m = await mountProfileWith({ ok: false, error: msg });
    m.el.querySelector('#me-phone').value = '0999888777';
    m.el.querySelector('#me-curpw').value = 'wrong';
    m.el.querySelector('[data-role="form"]').fire('submit');
    await flush();
    const box = m.el.querySelector('[data-role="error"]');
    ok(box.hidden === false && box.textContent === msg, '3 後端訊息原樣顯示：' + msg);
  }
}

// ============================================================
// 4. 待審核分頁
// ============================================================
const PENDING = [{ emp_no: 'DZY007', name: '測試申請', brand_name: '墨竹亭', unit_name: '新竹光復', dept_name: '', title_name: '計時同仁', birthday: '1999-09-09', phone: '0911000222', address: '新竹市測試路9號', claimed_at: '2026-10-12 09:00:00' }];
function reviewCtx(results) {
  let list = PENDING.slice();
  return makeCtx((action, payload) => {
    if (action === 'unitPending') return { ok: true, data: { people: list, scope_name: '新竹光復', all_units: false } };
    if (results && results[action]) { const r = results[action]; if (r.ok) list = []; return r; }
    list = []; // 假後端：審完就從名單拿掉
    return { ok: true, data: { emp_no: payload.emp_no } };
  }, ['platform.self', 'platform.review']);
}
function clickAct(el, act, emp) {
  const btn = new FakeNode('button');
  btn.attrs = { 'data-act': act, 'data-emp': emp };
  el.fire('click', { target: btn });
}
{
  let el = new FakeNode('div');
  let ctx = reviewCtx();
  mountReview(el, ctx);
  await flush();
  ok(/1999-09-09/.test(el.innerHTML) && /0911000222/.test(el.innerHTML) && /新竹市測試路9號/.test(el.innerHTML) && /計時同仁/.test(el.innerHTML), '4 待審名單顯示生日、手機、地址、填的職稱');
  ctx.answerDialog(null);
  clickAct(el, 'approve', 'DZY007');
  await flush();
  ok(!ctx.calls.some((c) => c.action === 'unitApprove'), '4 通過對話框按取消 → 不送出');
  ctx.answerDialog('ok');
  clickAct(el, 'approve', 'DZY007');
  await flush();
  const ap = ctx.calls.find((c) => c.action === 'unitApprove');
  ok(ap && ap.payload.emp_no === 'DZY007' && ctx.toasts.some(([m, t]) => t === 'ok' && m.includes('可以登入')), '4 ★通過 → unitApprove {emp_no}，提示可以登入', ctx.calls);
  ok(ctx.calls.filter((c) => c.action === 'unitPending').length === 2 && /目前沒有等你審核的同仁/.test(el.innerHTML), '4 通過後重抓名單、清單變空');

  el = new FakeNode('div');
  ctx = reviewCtx();
  mountReview(el, ctx);
  await flush();
  ctx.answerDialog('ok', (body) => { body.querySelector('#rv-reason').value = '   '; });
  clickAct(el, 'reject', 'DZY007');
  await flush();
  ok(!ctx.calls.some((c) => c.action === 'unitReject') && ctx.toasts.some(([m]) => m === '請填寫退回原因'), '4 退回沒填原因 → 不送出');
  ctx.answerDialog('ok', (body) => { body.querySelector('#rv-reason').value = '職稱填錯'; });
  clickAct(el, 'reject', 'DZY007');
  await flush();
  const rj = ctx.calls.find((c) => c.action === 'unitReject');
  ok(rj && rj.payload.emp_no === 'DZY007' && rj.payload.reason === '職稱填錯', '4 ★退回 → unitReject {emp_no, reason}', rj);

  el = new FakeNode('div');
  ctx = reviewCtx({ unitApprove: { ok: false, error: '只有單位主管可以審核' } });
  mountReview(el, ctx);
  await flush();
  ctx.answerDialog('ok');
  clickAct(el, 'approve', 'DZY007');
  await flush();
  ok(ctx.toasts.some(([m, t]) => t === 'danger' && m === '只有單位主管可以審核'), '4 審核失敗顯示後端訊息');

  el = new FakeNode('div');
  ctx = makeCtx(() => ({ ok: false, error: '只有單位主管可以審核' }), ['platform.self']);
  mountReview(el, ctx);
  await flush();
  ok(/只有單位主管可以審核/.test(el.innerHTML) && ctx.toasts.length === 0, '4 沒資格硬打開 → 只顯示說明、不跳錯誤');
}

// ============================================================
// 5. manifest＋首頁提醒
// ============================================================
{
  const v = meManifest.views.find((x) => x.id === 'review');
  ok(v && v.requires.join() === 'platform.review,platform.staff', '5 待審核分頁只給 platform.review 或 platform.staff');
  const handler = (pending) => (action) => {
    if (action === 'myProfile') return { ok: true, data: PROFILE };
    if (action === 'unitPending') return { ok: true, data: { people: pending } };
    return { ok: false };
  };
  let ctx = makeCtx(handler([PENDING[0], PENDING[0]]), ['platform.self', 'platform.review']);
  let a = await meIndex.alerts(ctx);
  ok(Array.isArray(a) && a.length === 1 && a[0].text === '有 2 位同仁等你審核' && a[0].view === 'review' && a[0].level === 'warn', '5 ★主管首頁出現「有 2 位同仁等你審核」', a);
  ctx = makeCtx(handler([]), ['platform.self', 'platform.review']);
  ok((await meIndex.alerts(ctx)).length === 0, '5 沒人待審 → 不出現');
  ctx = makeCtx(handler([PENDING[0]]), ['platform.self']);
  a = await meIndex.alerts(ctx);
  ok(a.length === 0 && !ctx.calls.some((c) => c.action === 'unitPending'), '5 一般同仁不打 unitPending、不報錯');
  ctx = makeCtx(handler([PENDING[0]]), ['*']);
  a = await meIndex.alerts(ctx);
  ok(!ctx.calls.some((c) => c.action === 'unitPending'), '5 admin／人資不重複提醒（同仁名單已有）');
}

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
