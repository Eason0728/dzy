// node test/ai-help-front.test.mjs —— AI 小幫手前端（docs/ai-helper/spec.md §2、§12；task T3、T4）
// 沒有 jsdom：極簡假 DOM（innerHTML 一碰就丟錯，順便證明畫面文字全走 textContent）。⚠ 全部是假資料。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const flush = (n = 20) => new Promise((r) => { let k = n; (function s() { if (k-- <= 0) return r(); setImmediate(s); })(); });

const C = await import('../platform/helper/client.js');
const W = await import('../platform/helper/widget.js');
const { createClient, errorMessage, ERROR_MESSAGES, helperUrl, newRid, newConvId, CONV_RE } = C;

// ---------------- 假 DOM ----------------
class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.ls = {}; this.scrollTop = 0; this.scrollHeight = 0; this.parent = null; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i < 0) throw new Error('not a child'); this.children.splice(i, 1); c.parent = null; return c; }
  get firstChild() { return this.children[0] || null; }
  set textContent(t) { this._text = String(t); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('innerHTML 不准用'); }
  get innerHTML() { throw new Error('innerHTML 不准用'); }
  addEventListener(t, fn) { (this.ls[t] = this.ls[t] || []).push(fn); }
  removeEventListener(t, fn) { this.ls[t] = (this.ls[t] || []).filter((f) => f !== fn); }
  focus() { this.focused = true; Node.active = this; }
  async fire(t, ev) { for (const fn of (this.ls[t] || []).slice()) await fn(Object.assign({ preventDefault() {}, target: this }, ev || {})); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
  match(sel) {
    const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (m) return this.attrs[m[1]] === m[2];
    return this.tag === sel;
  }
  querySelector(sel) { return this.all((n) => n !== this && n.match(sel))[0] || null; }
  querySelectorAll(sel) { return this.all((n) => n !== this && n.match(sel)); }
}
const makeDoc = () => { const d = new Node('document'); d.createElement = (t) => new Node(t); return d; };
const byRole = (root, r) => root.querySelector(`[data-role="${r}"]`);
const allRole = (root, r) => root.querySelectorAll(`[data-role="${r}"]`);

// ---------------- 假後端（記每個請求） ----------------
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    return handler(body, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (j, extra) => Object.assign({ ok: true, status: 200, async json() { return j; } }, extra || {});
const URL_ = 'https://mini.example/platform/svc/ai-help';
const mkClient = (handler, o) => { const f = fakeFetch(handler); return { f, c: createClient(Object.assign({ fetch: f, getToken: () => 'tok-test', url: URL_ }, o || {})) }; };

// ================= client：網址、代號 =================
ok(helperUrl('https://h.example/platform/api') === 'https://h.example/platform/svc/ai-help', '網址：…/api 換成 …/svc/ai-help');
ok(helperUrl('https://script.google.com/macros/s/x/exec') === '', '推不出來＝空字串');
ok(helperUrl() === 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/platform/svc/ai-help', '預設用 BACKENDS.platform 推導');
{
  const id = newRid();
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), 'rid：有 crypto.randomUUID 就用它（UUID v4）', id);
  ok(newRid() !== newRid(), 'rid：每次不同');
  const fb = newRid({ crypto: { randomUUID() { throw new Error('no'); } }, now: () => 1760000000000, random: () => 0.5 });
  ok(/^r[0-9a-z]+-[0-9a-f]{8}$/.test(fb), 'rid：randomUUID 丟錯 → 退回 Date.now＋亂數', fb);
  const fb2 = newRid({ crypto: null, now: () => 1760000000000, random: () => 0.25 });
  ok(/^r[0-9a-z]+-[0-9a-f]{8}$/.test(fb2) && fb2 !== fb, 'rid：沒有 crypto 也有值', fb2);
}
{
  // 2026-11-02 09:05:07 台北＝01:05:07 UTC
  const ms = Date.UTC(2026, 10, 2, 1, 5, 7);
  const id = newConvId({ now: () => ms, random: () => 0.5 });
  ok(id === 'aic_20261102090507_8000', 'conv：aic_＋台北時間 YYYYMMDDHHmmss＋_＋4 位 hex', id);
  ok(CONV_RE.test(newConvId()) && CONV_RE.test(newConvId({ random: () => 0 })), 'conv：格式永遠合法（含亂數 0）', newConvId({ random: () => 0 }));
  const late = newConvId({ now: () => Date.UTC(2026, 11, 31, 20, 0, 0), random: () => 0.999999 });
  ok(late.startsWith('aic_20270101040000_') && CONV_RE.test(late), 'conv：台北跨日／跨年（UTC 12/31 20:00＝台北 1/1 04:00）', late);
}
{
  const src = read('apps-script/platform/AiHelp.gs');
  const m = /AIH_ID_CONV_RE = (\/.+\/);/.exec(src);
  ok(m && m[1] === String(CONV_RE), '前端 conv 格式與後端 AIH_ID_CONV_RE 相同', m && m[1]);
}

// ================= client：錯誤碼對照 =================
{
  const codes = ['off', 'cap', 'rate_person', 'rate_global', 'unauthorized', 'bad_input', 'forbidden', 'ai_error'];
  for (const code of codes) {
    const { c } = mkClient(() => jsonRes({ ok: false, code, error: 'backend internal text should not show' }));
    const r = await c.ask({ q: 'x', page: { m: '', v: '' }, conv: 'aic_20261102090507_8000' });
    ok(r.ok === false && r.code === code && r.error === ERROR_MESSAGES[code] && /[一-鿿]/.test(r.error) && !/backend internal/.test(r.error), `錯誤碼 ${code} → 中文：${r.error}`);
  }
  ok(errorMessage('unauthorized') === '請重新登入', 'unauthorized＝「請重新登入」');
  ok(errorMessage('ai_error') === '小幫手暫時無法回答', 'ai_error＝「小幫手暫時無法回答」');
  ok(errorMessage('cap') === '本月額度已用完', 'cap＝「本月額度已用完」');
  ok(errorMessage('nonsense') === '小幫手暫時無法回答' && errorMessage('__proto__') === '小幫手暫時無法回答' && errorMessage(undefined) === '小幫手暫時無法回答', '不認識的碼（含 __proto__）→ 通用句');
  const noCode = mkClient(() => jsonRes({ ok: false, error: 'x' }));
  ok((await noCode.c.status()).code === 'ai_error', '失敗回應沒有 code → ai_error');
}

// ================= client：請求形狀 =================
{
  const { f, c } = mkClient((b) => jsonRes({ ok: true, data: { id: 'aih_x', kind: 'answered', answer: 'a', go: [], who: '' } }));
  await c.ask({ q: '怎麼改密碼', page: { m: 'me', v: 'profile' }, conv: 'aic_20261102090507_8000' });
  await c.ask({ q: '再問', page: { m: 'me', v: 'profile' }, conv: 'aic_20261102090507_8000' });
  const a = f.calls[0], b2 = f.calls[1];
  ok(a.url === URL_ && a.init.method === 'POST' && /^text\/plain/.test(a.init.headers['Content-Type']), 'POST、text/plain');
  ok(JSON.stringify(Object.keys(a.body).sort()) === JSON.stringify(['conv', 'op', 'page', 'q', 'rid', 'token']), 'ask 只送 op／token／q／page／conv／rid（不送 alerts、history）', Object.keys(a.body));
  ok(a.body.token === 'tok-test' && a.body.op === 'ask' && a.body.q === '怎麼改密碼' && a.body.page.m === 'me' && a.body.page.v === 'profile', 'token 取自 getToken、頁面帶 {m,v}');
  ok(a.body.rid && b2.body.rid && a.body.rid !== b2.body.rid, '每次 ask 的 rid 都不同');
  ok(a.body.conv === b2.body.conv && CONV_RE.test(a.body.conv), '同一 conv 原樣帶出');
  await c.ask({ q: 'x', page: { m: 'javascript:alert(1)', v: '<b>' }, conv: 'aic_20261102090507_8000' });
  ok(f.calls[2].body.page.m === '' && f.calls[2].body.page.v === '', '怪頁面字元被清成空（當通用頁）', f.calls[2].body.page);
  await c.feedback({ id: 'aih_1', good: false });
  ok(f.calls[3].body.op === 'feedback' && f.calls[3].body.good === false && f.calls[3].body.id === 'aih_1', 'feedback 形狀');
  await c.draft({ pendingId: 'aip_1' });
  ok(f.calls[4].body.op === 'draft' && f.calls[4].body.pending_id === 'aip_1', 'draft 形狀');
  await c.usage();
  ok(f.calls[5].body.op === 'usage' && !('q' in f.calls[5].body), 'usage 形狀');
}
{
  const { f, c } = mkClient(() => jsonRes({ ok: true, data: { on: true } }), { getToken: () => '' });
  const r = await c.status();
  ok(r.ok === false && r.code === 'unauthorized' && f.calls.length === 0, '沒有 token：不送請求、回 unauthorized');
}

// ================= client：失敗型態都不拋例外 =================
{
  const t1 = mkClient(() => { throw new Error('net'); });
  ok((await t1.c.status()).code === 'network', '網路失敗 → network（不拋）');
  const t2 = mkClient(() => jsonRes({}, { ok: false, status: 404 }));
  const r2 = await t2.c.status();
  ok(r2.ok === false && r2.code === 'network', '404（Mac mini 還沒更新）→ 失敗');
  const t3 = mkClient(() => ({ ok: true, status: 200, async json() { throw new Error('not json'); } }));
  ok((await t3.c.status()).code === 'network', '非 JSON → network');
  const t4 = mkClient(() => jsonRes(null));
  ok((await t4.c.status()).code === 'network', 'JSON 是 null → network');
  const t5 = mkClient(() => new Promise(() => {}), { timeoutMs: 30 });
  const t0 = Date.now();
  const r5 = await t5.c.ask({ q: 'x', page: {}, conv: '' });
  ok(r5.ok === false && r5.code === 'timeout' && Date.now() - t0 < 1000, '逾時 → timeout（測試用 30ms）', r5);
  ok(C.TIMEOUT_MS === 30000, '預設逾時 30 秒（§12.7）');
}
{
  const src = read('platform/helper/client.js') + read('platform/helper/widget.js');
  ok(!/logout|expireLocal|doLogout|setSessionExpiredHandler/.test(src), 'unauthorized 不自動登出：helper 程式裡沒有任何登出呼叫');
}

// ================= widget =================
function mkHelper(o) {
  const opts = Object.assign({ handler: () => jsonRes({ ok: true, data: { on: true, reason: '', left_today: 20 } }), canGo: () => true }, o || {});
  const doc = makeDoc();
  const parent = new Node('div');
  const { f, c } = mkClient(opts.handler);
  const hashes = [];
  const hp = W.createHelper({ doc, client: c, getRoute: () => ({ m: 'me', v: 'profile' }), canGo: opts.canGo, isMobile: () => !!opts.mobile, isDryRun: () => !!opts.dryrun, setHash: (h) => hashes.push(h) });
  return { doc, parent, f, hp, hashes };
}
const statusOnly = (j) => (b) => (b.op === 'status' ? j : jsonRes({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'ok', go: [], who: '' } }));
const askHandler = (reply) => (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true, reason: '', left_today: 20 } }) : (b.op === 'ask' ? jsonRes(reply) : jsonRes({ ok: true, data: {} })));
const send = async (h, text) => { const inp = byRole(h.hp.el, 'aih-input'); inp.value = text; await byRole(h.hp.el, 'aih-send').fire('click'); await flush(); };

// ① status：on:false 與任何錯誤 → 按鈕不出現
{
  const cases = [
    ['on:false', () => jsonRes({ ok: true, data: { on: false, reason: 'off', left_today: 0 } })],
    ['網路失敗', () => { throw new Error('net'); }],
    ['404', () => jsonRes({}, { ok: false, status: 404 })],
    ['回 ok:false', () => jsonRes({ ok: false, code: 'unauthorized', error: 'x' })],
    ['回非 JSON', () => ({ ok: true, status: 200, async json() { throw new Error('x'); } })],
    ['回空 data', () => jsonRes({ ok: true })]
  ];
  for (const [name, handler] of cases) {
    const h = mkHelper({ handler });
    const shown = await h.hp.start(h.parent);
    ok(shown === false && h.parent.children.length === 0 && byRole(h.parent, 'aih-fab') === null, `status ${name} → 按鈕不出現、畫面沒有任何節點`);
  }
}
// ② status on → 按鈕出現；開頁只打一次 status
{
  const h = mkHelper();
  const shown = await h.hp.start(h.parent);
  const fab = byRole(h.parent, 'aih-fab');
  ok(shown === true && fab && fab.textContent === '問小幫手' && fab.tag === 'button', 'status on:true → 出現「問小幫手」按鈕（<button>，鍵盤可操作）');
  ok(h.f.calls.length === 1 && h.f.calls[0].body.op === 'status', '開頁只打一次 status');
  const panel = byRole(h.parent, 'aih-panel');
  ok(panel.hidden === true && panel.attrs.role === 'dialog' && fab.attrs['aria-expanded'] === 'false', '側欄預設收起、role=dialog、aria-expanded=false');
  ok(byRole(h.parent, 'aih-note').textContent === '問題會送交外部 AI（Anthropic）處理，並在系統保存 90 天', '底部說明字逐字');
  ok(byRole(h.parent, 'aih-quota').textContent === '今天還可以問 20 題', '顯示今天剩餘題數');
  ok(byRole(h.parent, 'aih-input').attrs.maxlength === '300', '輸入框最多 300 字');
  h.hp.destroy();
  ok(h.parent.children.length === 0, 'destroy（登出）→ 按鈕與側欄全部移除');
}
// ③ cap：按鈕出現、點開只寫額度用完
{
  const h = mkHelper({ handler: () => jsonRes({ ok: true, data: { on: false, reason: 'cap', left_today: 5 } }) });
  const shown = await h.hp.start(h.parent);
  ok(shown === true && byRole(h.parent, 'aih-fab'), 'reason cap → 按鈕仍出現');
  await byRole(h.parent, 'aih-fab').fire('click');
  const panel = byRole(h.parent, 'aih-panel');
  ok(panel.hidden === false && panel.textContent.includes('本月額度已用完'), '點開寫「本月額度已用完」');
  ok(byRole(h.parent, 'aih-input').hidden === true && byRole(h.parent, 'aih-send').hidden === true, '沒有輸入框與送出鈕');
  ok(!panel.textContent.includes('今天還可以問'), '額度用完不顯示剩餘題數');
  const cap2 = mkHelper({ handler: () => jsonRes({ ok: true, data: { on: true, reason: 'cap' } }) });
  ok(await cap2.hp.start(cap2.parent) === true && byRole(cap2.parent, 'aih-input').hidden === true, 'on:true＋reason cap 也一樣');
}
// ④ 問答、純文字、conv／rid
{
  const evil = '<img src=x onerror="alert(1)"> <script>alert(2)</script> javascript:alert(3)';
  const h = mkHelper({ handler: askHandler({ ok: true, data: { id: 'aih_20261102090507_ab12', kind: 'answered', answer: evil, go: [], who: evil } }) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '<img src=x onerror=alert(9)>問題');
  const msgs = allRole(h.parent, 'aih-msg');
  ok(msgs[0].textContent === '<img src=x onerror=alert(9)>問題', '使用者問題原樣當文字顯示');
  ok(byRole(h.parent, 'aih-answer').textContent === evil, '答案含 <img onerror>、<script>、javascript: 原樣當文字顯示');
  ok(byRole(h.parent, 'aih-who').textContent === '可以問：' + evil, 'who 也是純文字');
  ok(h.parent.all((n) => ['img', 'script', 'a', 'iframe'].includes(n.tag)).length === 0, '畫面上沒有任何 img／script／a／iframe 節點（沒有東西會執行）');
  ok(h.parent.all((n) => Object.keys(n.attrs).some((k) => /^on/.test(k))).length === 0, '沒有任何 on* 屬性');
  const ask1 = h.f.calls.find((x) => x.body.op === 'ask').body;
  ok(CONV_RE.test(ask1.conv) && ask1.q === '<img src=x onerror=alert(9)>問題' && ask1.page.m === 'me', 'ask 帶 conv（格式合法）與目前頁面');
  ok(!('alerts' in ask1) && !('history' in ask1), 'ask 不帶 alerts、history');
  await send(h, '第二題');
  const asks = h.f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(asks.length === 2 && asks[0].conv === asks[1].conv && asks[0].rid !== asks[1].rid, '同一側欄開著：conv 不變、rid 每次不同');
  ok(byRole(h.parent, 'aih-quota').textContent === '今天還可以問 18 題', '每問一題剩餘題數減一');
  // 關掉再開、conv 不變
  await byRole(h.parent, 'aih-close').fire('click');
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '第三題');
  const asks3 = h.f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(asks3[2].conv === asks[0].conv, '關掉再打開（同一頁面生命週期）conv 仍不變');
  await byRole(h.parent, 'aih-clear').fire('click');
  await send(h, '清除後');
  const asks4 = h.f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(CONV_RE.test(asks4[3].conv), '清除對話後 conv 重新產生且格式合法');
}
// ⑤ 輸入限制
{
  const h = mkHelper({ handler: askHandler({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'a', go: [], who: '' } }) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '   ');
  ok(h.f.calls.filter((x) => x.body.op === 'ask').length === 0, '空白問題不送');
  await send(h, 'x'.repeat(301));
  ok(h.f.calls.filter((x) => x.body.op === 'ask').length === 0 && byRole(h.parent, 'aih-error').textContent.includes('問題格式不對'), '超過 300 字不送、顯示 bad_input 訊息');
}
// ⑥ 錯誤顯示
for (const [code, text] of [['ai_error', '小幫手暫時無法回答'], ['unauthorized', '請重新登入'], ['rate_person', '今天問得有點多'], ['rate_global', '問的人太多'], ['off', '沒有開放']]) {
  const h = mkHelper({ handler: askHandler({ ok: false, code, error: 'raw' }) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  const e = byRole(h.parent, 'aih-error');
  ok(e && e.textContent.includes(text) && !e.textContent.includes('raw'), `ask 回 ${code} → 顯示「${text}」`);
  ok(byRole(h.parent, 'aih-send').disabled === false, `ask 回 ${code} → 送出鈕恢復可用`);
}
{
  const h = mkHelper({ handler: askHandler({ ok: false, code: 'cap', error: 'raw' }) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  ok(byRole(h.parent, 'aih-input').hidden === true, 'ask 回 cap → 輸入框收起、只剩額度用完訊息');
}
{
  const h = mkHelper({ handler: (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true } }) : (() => { throw new Error('net'); })()) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  ok(byRole(h.parent, 'aih-error').textContent.includes('連不上'), 'ask 網路失敗 → 「連不上小幫手」');
}
// ⑥b 網路／逾時失敗 → 「重試」沿用同一個 rid（B5）；新問題才換 rid
{
  let askN = 0;
  const h = mkHelper({ handler: (b) => {
    if (b.op === 'status') return jsonRes({ ok: true, data: { on: true, left_today: 20 } });
    askN += 1;
    if (askN === 1) throw new Error('net');
    return jsonRes({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: '答案', go: [], who: '' } });
  } });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '同一題');
  const retry = byRole(h.parent, 'aih-retry');
  ok(retry && retry.tag === 'button' && retry.textContent === '重試' && byRole(h.parent, 'aih-error').textContent.includes('連不上'), '網路失敗 → 錯誤泡泡裡有「重試」按鈕');
  await retry.fire('click');
  await flush();
  const asks = h.f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(asks.length === 2 && asks[0].rid === asks[1].rid && asks[0].q === asks[1].q && asks[0].conv === asks[1].conv, '重試沿用同一個 rid（同題、同 conv）', asks.map((a) => a.rid));
  ok(byRole(h.parent, 'aih-retry') === null && byRole(h.parent, 'aih-error') === null && byRole(h.parent, 'aih-answer').textContent === '答案', '重試成功：錯誤泡泡與重試鈕消失、顯示答案');
  ok(allRole(h.parent, 'aih-msg').filter((n) => n.attrs['data-from'] === 'user').length === 1, '重試不會多出一個使用者泡泡');
  await send(h, '新問題');
  const asks2 = h.f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(asks2.length === 3 && asks2[2].rid !== asks2[0].rid, '新問題產新 rid');
  ok(byRole(h.parent, 'aih-quota').textContent === '今天還可以問 18 題', '重試成功只扣一題');
}
{
  const C2 = await import('../platform/helper/client.js');
  const f = fakeFetch((b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true } }) : new Promise(() => {})));
  const doc = makeDoc(); const parent = new Node('div');
  const hp = W.createHelper({ doc, client: C2.createClient({ fetch: f, getToken: () => 't', url: URL_, timeoutMs: 30 }), getRoute: () => ({ m: 'me', v: 'profile' }), canGo: () => true });
  await hp.start(parent);
  await byRole(parent, 'aih-fab').fire('click');
  const inp = byRole(hp.el, 'aih-input'); inp.value = '慢題'; await byRole(hp.el, 'aih-send').fire('click'); await new Promise((r) => setTimeout(r, 120)); await flush();
  ok(byRole(parent, 'aih-retry') && byRole(parent, 'aih-error').textContent.includes('太久'), '逾時 → 也有「重試」');
  await byRole(parent, 'aih-retry').fire('click'); await new Promise((r) => setTimeout(r, 120)); await flush();
  const asks = f.calls.filter((x) => x.body.op === 'ask').map((x) => x.body);
  ok(asks.length === 2 && asks[0].rid === asks[1].rid, '逾時重試沿用同一個 rid（真 client）');
  const cc = mkClient(() => jsonRes({ ok: true, data: {} }));
  await cc.c.ask({ q: 'x', page: {}, conv: '', rid: 'fixed-rid-0001' });
  ok(cc.f.calls[0].body.rid === 'fixed-rid-0001', 'client.ask({rid}) 原樣帶出');
}
// ⑥c ai_error 備援：這頁常見問題（純文字、點開看原答案）
{
  const evil = '<img src=x onerror=alert(1)>';
  const fb = [{ id: 'kb0001', question: '怎麼改密碼' + evil, answer: '到「我的資料」按改密碼。\n' + evil }, { id: 'kb0002', question: '第二題', answer: '答二' }, { id: 'kb0003', question: '第三', answer: '答三' }, { id: 'kb0004', question: '第四（超過三題）', answer: 'x' }];
  const h = mkHelper({ handler: askHandler({ ok: false, code: 'ai_error', error: 'raw', fallback: fb }) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  ok(byRole(h.parent, 'aih-fallback-title').textContent === '小幫手暫時無法回答，這頁常見問題：', 'ai_error＋fallback → 「小幫手暫時無法回答，這頁常見問題：」');
  const qs = allRole(h.parent, 'aih-fq');
  ok(qs.length === 3 && qs[0].tag === 'button' && qs[0].textContent === '怎麼改密碼' + evil, '最多 3 題、題目是按鈕、純文字');
  const as = allRole(h.parent, 'aih-fa');
  ok(as.length === 3 && as.every((a) => a.hidden === true), '答案預設收起');
  await qs[0].fire('click');
  ok(as[0].hidden === false && as[0].textContent === '到「我的資料」按改密碼。\n' + evil && qs[0].attrs['aria-expanded'] === 'true', '點開看知識庫原文（純文字）');
  await qs[0].fire('click');
  ok(as[0].hidden === true, '再點收起');
  ok(h.parent.all((n) => ['img', 'script', 'a', 'iframe'].includes(n.tag)).length === 0, '備援區沒有任何會執行的節點');
  ok(byRole(h.parent, 'aih-send').disabled === false && byRole(h.parent, 'aih-retry') === null, 'ai_error 不給重試鈕（重試只給網路／逾時），送出鈕恢復');
  const none = mkHelper({ handler: askHandler({ ok: false, code: 'ai_error', error: 'raw' }) });
  await none.hp.start(none.parent);
  await byRole(none.parent, 'aih-fab').fire('click');
  await send(none, '問題');
  ok(byRole(none.parent, 'aih-fallback') === null && byRole(none.parent, 'aih-error').textContent.includes('小幫手暫時無法回答'), '沒有 fallback → 只顯示一般錯誤');
}
// ⑥d client：401 unauthorized 與 fallback 清洗（B6）
{
  const t401 = mkClient(() => jsonRes({ ok: false, code: 'unauthorized', error: 'x' }, { ok: false, status: 401 }));
  const r = await t401.c.status();
  ok(r.ok === false && r.code === 'unauthorized' && r.error === '請重新登入', 'HTTP 401＋{code:unauthorized} → unauthorized（請重新登入），不是「連不上」');
  const t500 = mkClient(() => jsonRes({ ok: false, code: 'forbidden' }, { ok: false, status: 502 }));
  ok((await t500.c.status()).code === 'forbidden', '非 2xx 但有明確 code 就照 code');
  const html = mkClient(() => ({ ok: false, status: 502, async json() { throw new Error('html'); } }));
  ok((await html.c.status()).code === 'network', '非 2xx 且不是 JSON → network');
  const ae = mkClient(() => jsonRes({ ok: false, code: 'ai_error', error: 'x', fallback: [{ id: 'kb1', question: 'Q', answer: 'A', extra: 1 }, { id: 5, question: '', answer: 'x' }, null, 'str', { question: 'Q2', answer: 'A2' }, { question: 'Q3', answer: 'A3' }, { question: 'Q4', answer: 'A4' }] }));
  const e = await ae.c.ask({ q: 'x', page: {}, conv: '' });
  ok(e.code === 'ai_error' && e.fallback.length === 3 && JSON.stringify(e.fallback[0]) === JSON.stringify({ id: 'kb1', question: 'Q', answer: 'A' }) && e.fallback[1].id === '', 'client：ai_error 的 fallback 清洗（只留 id／question／answer、最多 3 題、壞項丟掉）', e);
  const kbsrc = read('modules/ai-help/views/kb.js');
  ok(/it\.expires_at <= today\) return '　·　⚠ 已過期/.test(kbsrc) && !/it\.expires_at < today/.test(kbsrc), 'B8 管理頁：expires_at <= 今天 視為已過期（與後端 aihKbVisible_ 一致）');
}
// ⑥e R8：剩餘題數以後端為準；側欄每次打開都重打 status
{
  let statusLeft = 20, statusReason = '';
  const h = mkHelper({ handler: (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true, reason: statusReason, left_today: statusLeft } }) : jsonRes({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'a', go: [], who: '', left_today: 7 } })) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click'); await flush();
  await send(h, '問題');
  ok(byRole(h.parent, 'aih-quota').textContent === '今天還可以問 7 題', 'ask 成功回應帶 left_today → 用它更新剩餘題數（不是前端自己減一）');
  statusLeft = 3;
  await byRole(h.parent, 'aih-close').fire('click');
  const n0 = h.f.calls.filter((x) => x.body.op === 'status').length;
  await byRole(h.parent, 'aih-fab').fire('click'); await flush();
  ok(h.f.calls.filter((x) => x.body.op === 'status').length === n0 + 1 && byRole(h.parent, 'aih-quota').textContent === '今天還可以問 3 題', '側欄每次打開重打 status、剩餘題數跟著更新');
  statusReason = 'cap'; statusLeft = 0;
  await byRole(h.parent, 'aih-close').fire('click');
  await byRole(h.parent, 'aih-fab').fire('click'); await flush();
  ok(byRole(h.parent, 'aih-input').hidden === true && byRole(h.parent, 'aih-panel').textContent.includes('本月額度已用完'), '重開時 status 回 cap → 輸入框收起、顯示額度用完');
}
{
  let fail = false;
  const h = mkHelper({ handler: (b) => { if (b.op === 'status' && fail) throw new Error('net'); return jsonRes({ ok: true, data: { on: true, reason: '', left_today: 12 } }); } });
  await h.hp.start(h.parent);
  fail = true;
  await byRole(h.parent, 'aih-fab').fire('click'); await flush();
  ok(byRole(h.parent, 'aih-quota').textContent === '今天還可以問 12 題' && byRole(h.parent, 'aih-input').hidden === false, '重打 status 失敗 → 畫面維持原樣');
}
// ⑦ 帶我去
{
  ok(JSON.stringify(W.cleanGo([{ m: 'me', v: 'profile', label: '我的資料' }], () => true)) === JSON.stringify([{ m: 'me', v: 'profile', label: '我的資料' }]), 'cleanGo：合格項目保留');
  ok(W.cleanGo([{ m: 'me', v: 'profile' }], (m, v) => !(m === 'me' && v === 'profile')).length === 0, 'cleanGo：沒權限的不收');
  ok(W.cleanGo([{ m: 'javascript:alert(1)', v: 'x' }, { m: 'me', v: '../x' }, { m: 'me' }, { m: 1, v: 2 }, null, 'str', { m: 'me/', v: 'a' }], () => true).length === 0, 'cleanGo：字元不合格、缺欄位、非物件一律丟掉');
  ok(W.cleanGo([{ m: 'a', v: 'b' }, { m: 'c', v: 'd' }, { m: 'e', v: 'f' }], () => true).length === 2, 'cleanGo：最多 2 筆');
  ok(W.cleanGo([{ m: 'a', v: 'b', label: '<b>x</b>'.repeat(20) }], () => true)[0].label.length <= 30, 'cleanGo：label 截到 30 字');
  ok(W.cleanGo([{ m: 'a', v: 'b', label: '', extra: { x: 1 } }], () => true)[0].label === '帶我去' && !('extra' in W.cleanGo([{ m: 'a', v: 'b', extra: 1 }], () => true)[0]), 'cleanGo：label 空 → 「帶我去」；多餘欄位不帶');
  ok(W.cleanGo('x', () => true).length === 0 && W.cleanGo(undefined, () => true).length === 0, 'cleanGo：go 不是陣列');
  ok(W.cleanGo([{ m: 'a', v: 'b' }], () => { throw new Error('x'); }).length === 0 && W.cleanGo([{ m: 'a', v: 'b' }]).length === 0, 'cleanGo：canGo 丟錯或沒給 → 不收（往關的方向失敗）');

  const reply = { ok: true, data: { id: 'aih_1', kind: 'answered', answer: '到「我的資料」', go: [{ m: 'me', v: 'profile', label: '我的資料' }, { m: 'users', v: 'list', label: '人員管理' }], who: '' } };
  const h = mkHelper({ handler: askHandler(reply), canGo: (m, v) => m === 'me' && v === 'profile' });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '怎麼改資料');
  const gos = allRole(h.parent, 'aih-go');
  ok(gos.length === 1 && gos[0].textContent === '我的資料' && gos[0].tag === 'button', '只畫有權限的「帶我去」按鈕（沒權限那顆不畫）');
  await gos[0].fire('click');
  ok(h.hashes.length === 1 && h.hashes[0] === '#/me/profile', '按下只做 location.hash = #/m/v', h.hashes);
  ok(byRole(h.parent, 'aih-panel').hidden === false, '桌機：帶我去之後側欄還開著');
  const hm = mkHelper({ handler: askHandler(reply), canGo: () => true, mobile: true });
  await hm.hp.start(hm.parent);
  await byRole(hm.parent, 'aih-fab').fire('click');
  await send(hm, '怎麼改資料');
  await allRole(hm.parent, 'aih-go')[0].fire('click');
  ok(byRole(hm.parent, 'aih-panel').hidden === true, '手機：全螢幕側欄在帶我去之後自動收起');
}
// ⑧ 👍👎
{
  const h = mkHelper({ handler: (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true } }) : b.op === 'ask' ? jsonRes({ ok: true, data: { id: 'aih_20261102090507_ab12', kind: 'unknown', answer: '這題我還不會', go: [], who: '人資' } }) : jsonRes({ ok: true, data: {} })) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  const down = byRole(h.parent, 'aih-fb').querySelector('[data-act="down"]');
  await down.fire('click');
  await flush();
  const fb = h.f.calls.find((x) => x.body.op === 'feedback');
  ok(fb && fb.body.id === 'aih_20261102090507_ab12' && fb.body.good === false, '👎 → feedback{id, good:false}', fb && fb.body);
  const up = byRole(h.parent, 'aih-fb').querySelector('[data-act="up"]');
  ok(up.disabled === true && down.disabled === true, '按過之後兩顆都鎖住（不重複送）');
  ok(byRole(h.parent, 'aih-msg') && h.parent.querySelector('[data-kind="unknown"]'), 'unknown 答案有標記');
}
{
  const h = mkHelper({ handler: (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true } }) : b.op === 'ask' ? jsonRes({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'a', go: [], who: '' } }) : jsonRes({ ok: false, code: 'forbidden', error: 'x' })) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  const up = byRole(h.parent, 'aih-fb').querySelector('[data-act="up"]');
  await up.fire('click');
  await flush();
  ok(up.disabled === false && byRole(h.parent, 'aih-fb-note').textContent.includes('沒送出'), 'feedback 失敗 → 提示、按鈕恢復可再按');
}
// ⑧b 👎：只有 noted:true 才說「已通知管理人員」
for (const [noted, want] of [[true, '謝謝，已通知管理人員'], [false, '已收到你的回饋'], [undefined, '已收到你的回饋']]) {
  const h = mkHelper({ handler: (b) => (b.op === 'status' ? jsonRes({ ok: true, data: { on: true } }) : b.op === 'ask' ? jsonRes({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'a', go: [], who: '' } }) : jsonRes({ ok: true, data: noted === undefined ? {} : { noted } })) });
  await h.hp.start(h.parent);
  await byRole(h.parent, 'aih-fab').fire('click');
  await send(h, '問題');
  await byRole(h.parent, 'aih-fb').querySelector('[data-act="down"]').fire('click');
  await flush();
  ok(byRole(h.parent, 'aih-fb-note').textContent === want, `👎 回 noted=${noted} → 「${want}」`, byRole(h.parent, 'aih-fb-note').textContent);
}
// ⑨ 鍵盤
{
  const h = mkHelper();
  await h.hp.start(h.parent);
  const fab = byRole(h.parent, 'aih-fab');
  await fab.fire('click');
  ok(Node.active === byRole(h.parent, 'aih-input'), '開側欄：焦點進輸入框');
  await h.doc.fire('keydown', { key: 'Escape' });
  ok(byRole(h.parent, 'aih-panel').hidden === true && fab.attrs['aria-expanded'] === 'false', 'Esc 關閉側欄');
  ok(Node.active === fab, 'Esc 關閉後焦點還給按鈕');
  ok((h.doc.ls.keydown || []).length === 0, '關閉後移除 document keydown 監聽（不漏）');
  // Enter 送出、Shift+Enter 不送、輸入法組字中的 Enter 不送
  const hh = mkHelper({ handler: askHandler({ ok: true, data: { id: 'aih_1', kind: 'answered', answer: 'a', go: [], who: '' } }) });
  await hh.hp.start(hh.parent);
  await byRole(hh.parent, 'aih-fab').fire('click');
  const inp = byRole(hh.parent, 'aih-input');
  inp.value = '你好';
  await inp.fire('keydown', { key: 'Enter', shiftKey: true });
  await inp.fire('keydown', { key: 'Enter', isComposing: true });
  await flush();
  ok(hh.f.calls.filter((x) => x.body.op === 'ask').length === 0, 'Shift+Enter、組字中的 Enter 不送出');
  await inp.fire('keydown', { key: 'Enter' });
  await flush();
  ok(hh.f.calls.filter((x) => x.body.op === 'ask').length === 1, 'Enter 送出');
}
// ⑨b 試跑模式：按鈕出現、點開只寫說明、不送 ask／feedback／draft
{
  const h = mkHelper({ dryrun: true });
  ok(await h.hp.start(h.parent) === true && byRole(h.parent, 'aih-fab'), '試跑模式：按鈕照常出現');
  await byRole(h.parent, 'aih-fab').fire('click');
  const panel = byRole(h.parent, 'aih-panel');
  ok(panel.textContent.includes('試跑模式中，小幫手不能使用') && byRole(h.parent, 'aih-input').hidden === true && byRole(h.parent, 'aih-send').hidden === true, '試跑模式：點開只顯示「試跑模式中，小幫手不能使用」、沒有輸入框');
  await byRole(h.parent, 'aih-send').fire('click');
  ok(h.f.calls.every((x) => x.body.op === 'status'), '試跑模式：只打過 status，沒有 ask／feedback／draft', h.f.calls.map((x) => x.body.op));
  const dsrc = read('modules/ai-help/views/pending.js');
  ok(/lockIfDryrun\(h\('button', \{ type: 'button', class: 'btn btn-secondary', 'data-act': 'draft'/.test(dsrc), '管理頁「AI 擬答」鈕在試跑模式 disabled（lockIfDryrun）');
}
// ⑩ 登出時還在等 status／ask：不能把按鈕補畫出來
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = mkHelper({ handler: async () => { await gate; return jsonRes({ ok: true, data: { on: true } }); } });
  const p = h.hp.start(h.parent);
  h.hp.destroy();
  release();
  const shown = await p;
  ok(shown === false && h.parent.children.length === 0, '登出（destroy）時 status 還沒回來 → 回來後也不畫按鈕');
}

// ================= 殼接線（原始碼層級）、registry、manifest =================
{
  const shell = read('platform/shell.js');
  ok(/mountHelperSafe\(shellEl\)/.test(shell) && /unmountHelperSafe\(\);/.test(shell), 'shell.js：登入畫面骨架建好後 mountHelper、doLogout 時 unmountHelper');
  const doLogout = shell.slice(shell.indexOf('async function doLogout'), shell.indexOf('// 代轉回 401'));
  ok(doLogout.includes('unmountHelperSafe();') && doLogout.indexOf('unmountHelperSafe();') < doLogout.indexOf('await teardownCurrent'), 'doLogout：一開始就卸下小幫手（被踢登出也走這條）');
  ok(/function getRoute\(\)/.test(shell) && /function canGoTo\(m, v\)/.test(shell) && /isModulePermitted\(manifest\)/.test(shell.slice(shell.indexOf('function canGoTo'))), 'shell.js 提供 getRoute()、canGoTo（isModulePermitted ∧ isViewPermitted）');
  ok(/import\('\.\/helper\/widget\.js'\)/.test(shell) && /\.catch\(\(\) =>/.test(shell.slice(shell.indexOf('function mountHelperSafe'))), '動態載入、失敗吞掉：小幫手壞了不影響殼');
}
{
  for (const f of ['platform/helper/client.js', 'platform/helper/widget.js', 'platform/helper/helper.css', 'modules/ai-help/index.js', 'modules/ai-help/lib.js', 'modules/ai-help/editor.js', 'modules/ai-help/views/pending.js', 'modules/ai-help/views/kb.js', 'modules/ai-help/views/usage.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), `${f}：沒有 innerHTML 等會解析 HTML 的寫法（§12.4）`);
  }
}
{
  const { MODULES } = await import('../platform/registry.js');
  const mans = [];
  for (const e of MODULES) mans.push((await e.load()).default.id);
  ok(mans.indexOf('ai-help') >= 0 && mans.indexOf('ai-help') === mans.indexOf('cashbook') - 1, 'registry：ai-help 排在 cashbook 前一列', mans);
  const { validateManifest } = await import('../platform/manifest-check.js');
  const mf = (await import('../modules/ai-help/manifest.js')).default;
  const vm = validateManifest(mf);
  ok(vm.ok === true && vm.errors.length === 0, 'manifest 通過 validateManifest（注意：寫壞了模組會靜默不上架）', vm);
  ok(mf.dept === 'it' && mf.name === '小幫手管理' && mf.requires.join() === 'platform.aihelp' && mf.views.map((v) => v.id).join() === 'pending,kb,usage' && mf.views.every((v) => v.requires.join() === 'platform.aihelp'), 'manifest：dept it、名稱、三個分頁都要 platform.aihelp');
  ok(fs.existsSync(path.join(ROOT, 'assets/icons/ai-help.png')) && read('tools/make-icons.py').includes("'ai-help':"), '圖示 ai-help.png 與 make-icons.py 那一列都在');
  const { buildPages } = await import('../tools/gen-aihelp-pages.mjs');
  const pages = await buildPages();
  ok(pages.filter((p) => p.m === 'ai-help').map((p) => p.v).join() === 'pending,kb,usage', '頁面地圖有三個 ai-help 分頁', pages.filter((p) => p.m === 'ai-help').length);
}

// ================= 管理模組 alerts() =================
{
  const mod = (await import('../modules/ai-help/index.js')).default;
  const mk = (resp) => ({ api: { call: async (ns, action, payload) => { mk.last = [ns, action, payload]; return resp; } } });
  const r1 = await mod.alerts(mk({ ok: true, data: { items: [], open_count: 3 } }));
  ok(r1.length === 1 && r1[0].text === '小幫手有 3 題待回答' && r1[0].view === 'pending' && r1[0].level === 'warn', 'alerts：小幫手有 3 題待回答', r1);
  ok(mk.last[1] === 'aihPendingList' && mk.last[2].status === 'open', 'alerts 讀 aihPendingList{status:open}');
  ok((await mod.alerts(mk({ ok: true, data: { items: [], open_count: 0 } }))).length === 0, 'alerts：0 題不提醒');
  ok((await mod.alerts(mk({ ok: false, error: 'not_inited' }))).length === 0, 'alerts：還沒初始化不提醒');
  ok((await mod.alerts(mk({ ok: false, error: 'boom' }))) === null && (await mod.alerts(mk(null))) === null, 'alerts：讀不到＝null（殼顯示算不出來）');
}

console.log(`\n${passed} 項通過、${failed} 項失敗`);
process.exit(failed ? 1 : 0);
