// node test/line-auth-front.test.mjs —— 用 LINE 重設密碼 前端（docs/line-auth/spec.md v1.2：R3 取消 LINE 開通）
// 沒有 jsdom：用極簡假 DOM（只實作 line-auth.js 用到的那幾個方法；innerHTML 一碰就丟錯，順便證明沒用到）。
// ⚠ 所有姓名、編號、token 都是假資料。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { LINE_LIFF_ID } = await import('../platform/config.js');
const LA = await import('../platform/views/line-auth.js');
const { createLineAuth, lineAuthUrl, lineLoginLinks, parseMode, validatePassword, T, MSG, FALLBACK_HREF } = LA;
const { LINE_LOG_TEXT } = await import('../modules/staff/views/list.js');

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const flush = (n = 30) => new Promise((r) => { let k = n; (function s() { if (k-- <= 0) return r(); setImmediate(s); })(); });

// ---------------- 假 DOM ----------------
class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.ls = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; this._text = ''; }
  set textContent(t) { this._text = String(t); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('innerHTML 不准用'); }
  get innerHTML() { throw new Error('innerHTML 不准用'); }
  addEventListener(t, fn) { (this.ls[t] = this.ls[t] || []).push(fn); }
  async fire(t) { for (const fn of (this.ls[t] || []).slice()) await fn({ preventDefault() {}, target: this }); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
  match(sel) {
    if (sel.startsWith('#')) return this.attrs.id === sel.slice(1);
    const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (m) return this.attrs[m[1]] === m[2];
    return this.tag === sel;
  }
  querySelector(sel) { return this.all((n) => n !== this && n.match(sel))[0] || null; }
  querySelectorAll(sel) { return this.all((n) => n !== this && n.match(sel)); }
}
const makeDoc = () => ({ createElement: (t) => new Node(t), head: new Node('head') });

// ---------------- 假 LIFF／假後端 ----------------
function setup(opts) {
  const o = Object.assign({ search: '?m=reset', liffId: '1234567890-AbCdEfGh', tokens: ['tok-1', 'tok-2'], responses: [], loggedIn: true }, opts || {});
  const doc = makeDoc();
  const root = new Node('div');
  const calls = [];
  const liff = {
    inits: [], logins: 0, tokenCalls: 0,
    async init(c) { this.inits.push(c); },
    isLoggedIn() { return o.loggedIn; },
    login() { this.logins++; },
    getIDToken() { const t = o.tokens[Math.min(this.tokenCalls, o.tokens.length - 1)]; this.tokenCalls++; return t; }
  };
  const queue = o.responses.slice();
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = queue.shift();
    if (r === 'throw') throw new Error('net');
    return { ok: true, status: 200, async json() { return r; } };
  };
  const app = createLineAuth({ doc, root, liff, fetch: fetchFn, liffId: o.liffId, search: o.search, url: 'https://mini.example/platform/svc/line-auth' });
  return { app, root, liff, calls, doc };
}
const text = (root) => root.textContent;
const byRole = (root, r) => root.querySelector(`[data-role="${r}"]`);
const screenOf = (root) => { const c = byRole(root, 'line-card'); return c ? c.getAttribute('data-screen') : null; };
const fill = (root, id, v) => { root.querySelector('#' + id).value = v; };
const pick = (root, title) => { root.all((n) => n.tag === 'input' && n.attrs.type === 'radio').forEach((n) => { n.checked = n.attrs.value === title; }); };

const RESET = { ok: true, mode: 'reset', name: '王小明', emp_no: 'DZY023', nonce: 'm'.repeat(64) };

// ================= 設定與純函式 =================
ok(LINE_LIFF_ID === '', 'config.LINE_LIFF_ID 預設空字串（功能未開）');
ok(lineLoginLinks('').length === 0 && lineLoginLinks('  ').length === 0, 'LIFF ID 空：登入頁按鈕不顯示');
ok(lineLoginLinks().length === 0, '用 config 預設值（空）：不顯示');
{
  const l = lineLoginLinks('1234567890-AbCdEfGh');
  ok(l.length === 1 && l[0].href === 'https://liff.line.me/1234567890-AbCdEfGh?m=reset' && l[0].mode === 'reset', 'R3：有 LIFF ID 只有一顆連到 liff.line.me?m=reset（沒有 m=claim）', l);
  ok(l[0].label === '用 LINE 重設密碼' && !l.some((x) => /開通/.test(x.label)), '按鈕文字：只有「用 LINE 重設密碼」');
  ok(lineLoginLinks('abc"><script').length === 0, 'LIFF ID 含怪字元一律不顯示（不進 href）');
}
{
  const login = read('platform/views/login.js');
  ok(/lineLoginLinks/.test(login) && /data-role="line-links"/.test(login), 'login.js 接了 lineLoginLinks');
  ok(!/用 LINE 開通/.test(login) && !/m=claim/.test(login), 'login.js 沒有「用 LINE 開通」連結');
}
ok(lineAuthUrl('https://h.example/platform/api') === 'https://h.example/platform/svc/line-auth', 'LINE 路由從 BACKENDS.platform 推導');
ok(lineAuthUrl('https://script.google.com/macros/s/x/exec') === '', '推不出來＝空字串');
ok(parseMode('?m=claim') === 'claim' && parseMode('?m=reset') === 'reset' && parseMode('?m=x') === '' && parseMode('') === '', 'parseMode');
ok(parseMode('?liff.state=%3Fm%3Dreset') === 'reset', 'parseMode 讀 LIFF 轉址的 liff.state');
ok(FALLBACK_HREF.reset === 'index.html#/forgot', '原本方式的 hash 路由與登入頁一致');
{
  const login = read('platform/views/login.js');
  ok(login.includes("'#/claim'") || login.includes("startsWith('#/claim')"), 'login.js 真的有 #/claim 路由');
  ok(login.includes("startsWith('#/forgot')"), 'login.js 真的有 #/forgot 路由');
}

// ================= 驗證規則抄自後端／claim.js =================
{
  const staffGs = read('apps-script/platform/Staff.gs');
  const claimJs = read('platform/views/claim.js');
  for (const k of ['pwShort', 'pwSame', 'pwLong']) {
    ok(staffGs.includes(MSG[k]), `驗證訊息 ${k} 與 Staff.gs 相同：${MSG[k]}`);
  }
  ok(claimJs.includes(MSG.pwShort) && claimJs.includes(MSG.pwMismatch), '密碼訊息與 claim.js 相同');
}
{
    ok(validatePassword('abc', 'abc', 'DZY023') === MSG.pwShort && validatePassword('dzy023dzy', 'dzy023dzy', 'DZY023') === null && validatePassword('dzy02300', 'dzy02300', 'DZY023') === null, '密碼長度');
  ok(validatePassword('DZY023', 'DZY023', 'DZY023') === MSG.pwShort, '編號本身太短先擋長度');
  ok(validatePassword('abcdefgh', 'abcdefgx', 'DZY023') === MSG.pwMismatch, '兩次不一樣');
}

// ================= 準備中／壞連結 =================
{
  const s = setup({ liffId: '' });
  await s.app.run();
  ok(screenOf(s.root) === 'preparing' && text(s.root).includes('功能準備中'), 'LINE_LIFF_ID 空：line.html 顯示「功能準備中」');
  ok(s.liff.inits.length === 0 && s.calls.length === 0, '準備中：不 init LIFF、不打後端');
}
{
  const s = setup({ search: '?m=zzz' });
  await s.app.run();
  ok(screenOf(s.root) === 'bad_link' && s.calls.length === 0, '網址 m 不合法：說明畫面、不打後端');
}
{
  const s = setup({ loggedIn: false });
  await s.app.run();
  ok(s.liff.logins === 1 && s.calls.length === 0, '未登入 LINE：呼叫 liff.login()，不打後端');
}
{
  const s = setup({ responses: [RESET] });
  await s.app.run();
  ok(s.liff.inits[0].liffId === '1234567890-AbCdEfGh', 'liff.init 帶 LIFF ID');
  const c = s.calls[0];
  ok(c.url === 'https://mini.example/platform/svc/line-auth' && c.init.method === 'POST' && c.init.headers['Content-Type'] === 'text/plain', 'check：POST、text/plain', c.init.headers);
  ok(JSON.stringify(c.body) === JSON.stringify({ op: 'check', want: 'reset', id_token: 'tok-1' }), 'check body 形狀', c.body);
}

// ================= 沒帶 m 當 reset；m=claim 只顯示導回文字（R3） =================
{
  const s = setup({ search: '', responses: [RESET] });
  await s.app.run();
  ok(s.calls.length === 1 && s.calls[0].body.want === 'reset' && screenOf(s.root) === 'reset', '沒帶 m：當 reset');
}
{
  const s = setup({ search: '?m=claim', responses: [RESET] });
  await s.app.run();
  ok(screenOf(s.root) === 'claim_off' && text(s.root).includes('第一次使用請回登入頁按「第一次使用」'), '?m=claim：顯示「第一次使用請回登入頁按『第一次使用』」');
  const back = byRole(s.root, 'to-login');
  ok(back && back.attrs.href === 'index.html' && back.textContent === '返回登入頁', '附返回登入頁按鈕');
  ok(s.calls.length === 0 && s.liff.inits.length === 0 && !byRole(s.root, 'form'), '?m=claim：不 init LIFF、不呼叫後端、沒有表單');
}
{
  const s = setup({ search: '?liff.state=%3Fm%3Dclaim', responses: [] });
  await s.app.run();
  ok(screenOf(s.root) === 'claim_off' && s.calls.length === 0, 'LIFF 轉址帶 m=claim 也一樣只導回');
}
{
  const src = read('platform/views/line-auth.js');
  ok(!/renderClaim|validateClaimForm|op: 'claim'|line-title|'claim_done'/.test(src), 'line-auth.js 已移除開通表單程式碼');
}

// ================= nonce 失效：自動重新 check，請使用者再按一次 =================
// 重設：nonce 失效
{
  const NEW = Object.assign({}, RESET, { nonce: 'y'.repeat(64) });
  const s = setup({ search: '?m=reset', responses: [RESET, { ok: false, error: 'bad_input', message: 'x', reason: 'nonce' }, NEW, { ok: true, mode: 'done', op: 'reset' }] });
  await s.app.run();
  fill(s.root, 'line-pw', 'new-pw-12345'); fill(s.root, 'line-pw2', 'new-pw-12345');
  await byRole(s.root, 'form').fire('submit'); await flush();
  ok(byRole(s.root, 'error').textContent === T.renewed, '重設：nonce 失效也重新 check');
  await byRole(s.root, 'form').fire('submit'); await flush();
  ok(s.calls[3].body.nonce === NEW.nonce && s.calls[3].body.op === 'reset' && s.calls[3].body.new_password === 'new-pw-12345', '重設：新 nonce 重送', s.calls[3].body);
}

// ================= 重設 =================
{
  const s = setup({ search: '?m=reset', responses: [RESET, { ok: true, mode: 'done', op: 'reset' }] });
  await s.app.run();
  ok(screenOf(s.root) === 'reset' && byRole(s.root, 'who').textContent === '王小明（DZY023）', '重設畫面顯示姓名與編號');
  ok(s.calls[0].body.want === 'reset' && byRole(s.root, 'fallback').attrs.href === 'index.html#/forgot', '重設：want=reset、原本方式→忘記密碼頁');
  fill(s.root, 'line-pw', 'abc'); fill(s.root, 'line-pw2', 'abc');
  await byRole(s.root, 'form').fire('submit');
  ok(byRole(s.root, 'error').textContent === MSG.pwShort && s.calls.length === 1, '密碼太短：擋');
  fill(s.root, 'line-pw', 'new-pw-12345'); fill(s.root, 'line-pw2', 'new-pw-12345');
  await byRole(s.root, 'form').fire('submit'); await flush();
  const b = s.calls[1].body;
  ok(JSON.stringify(Object.keys(b).sort()) === JSON.stringify(['id_token', 'new_password', 'nonce', 'op']) && b.op === 'reset', 'reset body 形狀', b);
  ok(screenOf(s.root) === 'reset_done' && text(s.root).includes('密碼已更新，其他裝置已登出'), '成功：密碼已更新，其他裝置已登出');
  const go = byRole(s.root, 'to-login');
  ok(go && go.textContent === '前往登入' && go.attrs.href === 'index.html', '有「前往登入」按鈕');
}

// ================= token 過期 =================
const submitReset = async (root) => { fill(root, 'line-pw', 'new-pw-12345'); fill(root, 'line-pw2', 'new-pw-12345'); await byRole(root, 'form').fire('submit'); await flush(); };
{
  const s = setup({ responses: [RESET, { ok: false, error: 'invalid_token', message: 'x' }, { ok: true, mode: 'done', op: 'reset' }], tokens: ['old', 'fresh'] });
  await s.app.run();
  await submitReset(s.root);
  ok(s.liff.tokenCalls === 2 && s.calls[2].body.id_token === 'fresh' && screenOf(s.root) === 'reset_done', 'invalid_token：重新 getIDToken 一次再試，成功');
}
{
  const s = setup({ responses: [RESET, { ok: false, error: 'invalid_token' }, { ok: false, error: 'invalid_token' }], tokens: ['old', 'fresh'] });
  await s.app.run();
  await submitReset(s.root);
  ok(screenOf(s.root) === 'reopen' && text(s.root).includes('請關閉後重新開啟') && s.calls.length === 3, '仍 invalid_token：顯示「請關閉後重新開啟」，只重試一次');
}
{
  const s = setup({ responses: [{ ok: false, error: 'invalid_token' }, { ok: false, error: 'invalid_token' }], tokens: ['a', 'b'] });
  await s.app.run();
  ok(screenOf(s.root) === 'reopen' && s.calls.length === 2, 'check 階段 invalid_token：重取一次，仍失敗→請關閉後重新開啟');
}
{
  const s = setup({ responses: [{ ok: false, error: 'invalid_token' }, RESET], tokens: ['a', 'b'] });
  await s.app.run();
  ok(screenOf(s.root) === 'reset' && s.calls[1].body.id_token === 'b', 'check 階段 invalid_token：重取後成功');
}
{
  const s = setup({ responses: [], tokens: [''] });
  await s.app.run();
  ok(screenOf(s.root) === 'reopen' && s.calls.length === 0, '拿不到 id token：請關閉後重新開啟');
}

// ================= not_trusted／其他 mode =================
const NT = (reason, extra) => Object.assign({ ok: true, mode: 'not_trusted', reason, need_line_punch: reason === 'need_line_punch' }, extra || {});
for (const [label, resp, want, expectText] of [
  ['not_trusted wait', NT('wait', { days_left: 3 }), 'reset', '你的 LINE 綁定還要 3 天才能用'],
  ['not_trusted need_line_punch', NT('need_line_punch'), 'reset', '請先用 LINE 打一次卡，隔天就能用'],
  ['not_trusted sync_stale', NT('sync_stale'), 'reset', '暫時無法確認，請改用原本的方式'],
  ['not_trusted other', NT('other'), 'reset', '暫時無法確認，請改用原本的方式'],
  ['not_bound', { ok: true, mode: 'not_bound' }, 'reset', '找不到你的 LINE 打卡綁定'],
  ['ambiguous', { ok: true, mode: 'ambiguous' }, 'reset', '這個 LINE 對到多位同仁'],
  ['blocked', { ok: true, mode: 'blocked' }, 'reset', '你的帳號目前不能用 LINE 處理'],
  ['need_review(reset)', { ok: true, mode: 'need_review' }, 'reset', '請改用原本的方式'],
  ['off(mode)', { ok: true, mode: 'off' }, 'reset', '目前未開放'],
  ['off(503)', { ok: false, error: 'off' }, 'reset', '目前未開放']
]) {
  const s = setup({ search: '?m=' + want, responses: [resp] });
  await s.app.run();
  const fb = byRole(s.root, 'fallback');
  ok(text(s.root).includes(expectText), `${label}：${expectText}`, text(s.root));
  ok(fb && fb.textContent === '改用原本的方式' && fb.attrs.href === FALLBACK_HREF[want], `${label}：附「改用原本的方式」→ ${FALLBACK_HREF[want]}`);
  ok(!byRole(s.root, 'form'), `${label}：沒有表單`);
}
{
  const s = setup({ responses: [NT('wait', { days_left: 0.2 })] });
  await s.app.run();
  ok(text(s.root).includes('還要 1 天'), 'days_left 小數無條件進位');
}
// wrong_op：同仁還沒開通 → 導回登入頁按「第一次使用」（R3）
for (const exp of [{ expected_mode: 'claim' }, {}]) {
  const s = setup({ search: '?m=reset', responses: [Object.assign({ ok: true, mode: 'wrong_op' }, exp)] });
  await s.app.run();
  const g = byRole(s.root, 'goto-login');
  ok(screenOf(s.root) === 'wrong_op' && g && g.attrs.href === 'index.html' && text(s.root).includes('你還沒開通帳號，請回登入頁按「第一次使用」') && !byRole(s.root, 'goto-claim'), 'wrong_op：顯示請回登入頁按「第一次使用」＋返回按鈕');
}
// 送出時重查失敗 → 對應畫面
{
  const s = setup({ responses: [RESET, { ok: false, error: 'not_trusted', message: 'x', mode: 'not_trusted' }] });
  await s.app.run();
  await submitReset(s.root);
  ok(screenOf(s.root) === 'not_trusted' && text(s.root).includes('暫時無法確認'), '送出時重查變 not_trusted：改畫說明');
}
// 各種錯誤碼（check 階段）
for (const [code, expectText] of [['rate_limited', '稍後再試'], ['busy', '系統忙碌'], ['forbidden_origin', '來源不被允許'], ['server_error', '系統忙碌'], ['network', '網路連線有問題']]) {
  const s = setup({ responses: [code === 'network' ? 'throw' : { ok: false, error: code, message: 'raw' }] });
  await s.app.run();
  ok(screenOf(s.root) === 'error' && text(s.root).includes(expectText), `錯誤碼 ${code} → ${expectText}`, text(s.root));
}

// ================= 不用 innerHTML 插資料 =================
{
  const evil = Object.assign({}, RESET, { name: '<img src=x onerror=alert(1)>' });
  const s = setup({ responses: [evil] });
  await s.app.run();   // 假 DOM 的 innerHTML 會丟錯；沒丟＝沒用
  ok(screenOf(s.root) === 'reset' && byRole(s.root, 'who').textContent.includes('<img src=x onerror=alert(1)>'), '姓名／單位名當純文字顯示（textContent）');
  ok(s.root.all((n) => n.tag === 'img' || n.tag === 'script').length === 0, '沒有被解析出 img／script 節點');
  const src = read('platform/views/line-auth.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), 'line-auth.js 原始碼（去註解後）沒有 innerHTML／outerHTML／insertAdjacentHTML');
}
{
  const html = read('line.html');
  ok(html.includes('platform/views/line-auth.js') && html.includes('platform/css/components.css') && !html.includes('LINE_LIFF_ID'), 'line.html 載入 line-auth.js 與同一組樣式表');
  ok(read('platform/views/line-auth.js').includes('https://static.line-scdn.net/liff/edge/2/sdk.js'), 'LIFF SDK 從 static.line-scdn.net 載入');
}

// ================= 同仁名單：LINE 紀錄類型中文 =================
ok(/開通/.test(LINE_LOG_TEXT.line_claim_ok) && /已停用/.test(LINE_LOG_TEXT.line_claim_ok) && LINE_LOG_TEXT.line_reset_ok === '用 LINE 重設密碼' && LINE_LOG_TEXT.line_revoke === '停用 LINE' && LINE_LOG_TEXT.line_fail === '失敗', '同仁名單 line_* 類型中文');
{
  const gs = read('apps-script/platform/LineAuth.gs') + read('apps-script/platform/Staff.gs');
  for (const k of Object.keys(LINE_LOG_TEXT).filter((x) => x !== 'line_claim_ok')) ok(gs.includes("'" + k + "'"), `後端真的會寫 ${k}`);
}

console.log(`\n${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
