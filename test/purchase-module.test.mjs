// node test/purchase-module.test.mjs —— 貨單核對：manifest、握手只認正確 origin＋source、頁頂分頁、首頁張數（docs/purchase-fin/spec.md §3）
'use strict';
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ''; this.textContent = ''; this.listeners = {}; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(n, ref) { const i = this.children.indexOf(ref); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
}
const sent = [];
globalThis.document = {
  createElement: (t) => {
    const e = new El(t);
    if (t === 'iframe') e.contentWindow = { postMessage: (m, o) => sent.push({ m, o }) };
    return e;
  }
};
const winListeners = {};
globalThis.window = { addEventListener: (t, f) => { winListeners[t] = f; }, removeEventListener: (t) => { delete winListeners[t]; } };
globalThis.location = { hostname: 'dzy.mozhuting.com' };
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => (ms === 150 ? realSetTimeout(fn, 0) : 1);
globalThis.clearTimeout = () => {};

let failed = 0;
async function t(name, fn) { try { await fn(); console.log('PASS: ' + name); } catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); } }

const TICKET = 'b'.repeat(64);
const ORIGIN = 'https://dzy-bulletin.github.io';
const calls = [];
let ticketReply = { ok: true, data: { ticket: TICKET, expires_in: 60 } };
const navs = [], tabsSet = [];
const mkCtx = (viewId, params) => ({
  viewId: viewId || 'main', params: params || {},
  api: { call: async (ns, action, payload) => { calls.push({ ns, action, payload }); return ticketReply; } },
  tabs: (list) => { tabsSet.push(list); return true; },
  nav: (id) => navs.push(id)
});
const tick = () => new Promise((r) => setImmediate(r));

const manifest = (await import('../modules/purchase/manifest.js')).default;
const mod = (await import('../modules/purchase/index.js')).default;
const E = await import('../modules/purchase/embed.js');
const C = await import('../modules/purchase/counts.js');
const { validateManifest } = await import('../platform/manifest-check.js');

await t('manifest：財務部門、只認 platform.purchase、dynamicTabs、保留 30 分鐘', () => {
  assert.equal(manifest.id, 'purchase');
  assert.equal(manifest.dept, 'fin');
  assert.equal(manifest.ns, manifest.backend);
  assert.deepEqual(manifest.requires, ['platform.purchase']);
  assert.equal(manifest.views.length, 1);
  assert.deepEqual(manifest.views[0].requires, ['platform.purchase']);
  assert.equal(manifest.dynamicTabs, true);
  assert.equal(manifest.keepAlive, 30 * 60 * 1000);
});

await t('★平台的 manifest 驗證通過（權限碼命名空間要等於 ns 或 platform）', () => {
  const r = validateManifest(manifest);
  const errs = Array.isArray(r) ? r : (r && r.errors) || [];
  assert.deepEqual(errs, []);
});

await t('網址：正式用 github.io/dzy-purchase，管理系統在本機才用 localhost:8795', () => {
  assert.equal(E.purchaseBase('dzy.mozhuting.com'), ORIGIN + '/dzy-purchase/');
  assert.equal(E.purchaseOrigin('dzy.mozhuting.com'), ORIGIN);
  assert.equal(E.purchaseOrigin('localhost'), 'http://localhost:8795');
  assert.equal(E.purchaseOrigin('127.0.0.1'), 'http://localhost:8795');
  assert.equal(E.purchaseOrigin('localhost.evil.com'), ORIGIN);
  assert.equal(C.purchaseApi('dzy.mozhuting.com'), 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/purchase/api');
  assert.equal(C.purchaseApi('localhost'), 'http://localhost:8794/purchase/api');
});

const root = new El('div');
const unmount = mod.mount(root, mkCtx());
await tick();
const frame = root.all((n) => n.tagName === 'iframe')[0];
const ready = { type: 'dzy-purchase-ready', v: 1 };
const msg = (data, o) => winListeners.message(Object.assign({ origin: ORIGIN, source: frame.contentWindow, data }, o || {}));

await t('iframe 開 review.html?embed=dzy；「在新分頁開啟」不帶 embed', () => {
  assert.equal(frame.src, ORIGIN + '/dzy-purchase/review.html?embed=dzy');
  assert.equal(root.all((n) => n.tagName === 'a')[0].href, ORIGIN + '/dzy-purchase/review.html');
});
await t('★origin 不對、source 不對、type／v 不對的 ready 一律不理', async () => {
  await msg(ready, { origin: 'https://evil.example' });
  await msg(ready, { source: { postMessage() {} } });
  for (const d of [{ type: 'dzy-store-ready', v: 1 }, { type: 'dzy-purchase-ready', v: 2 }, null, 'dzy-purchase-ready']) await msg(d);
  assert.equal(calls.length, 0); assert.equal(sent.length, 0);
});
await t('正確 ready → 換券 {aud:purchase}，回 dzy-purchase-sso、targetOrigin 寫死', async () => {
  await msg(ready);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ns: 'purchase', action: 'ssoTicket', payload: { aud: 'purchase' } });
  assert.deepEqual(sent[0], { m: { type: 'dzy-purchase-sso', v: 1, ticket: TICKET }, o: ORIGIN });
});
await t('換不到券（沒權限）→ 不送券、畫面提示', async () => {
  ticketReply = { ok: false, code: 'no_perm' };
  sent.length = 0;
  await msg(ready);
  assert.equal(sent.length, 0);
  assert.ok(root.all((n) => n.attrs['data-role'] === 'purchase-noticket').length === 1);
  ticketReply = { ok: true, data: { ticket: TICKET, expires_in: 60 } };
});

const NAV = { type: 'dzy-purchase-nav', v: 1, cur: 'review', items: [
  { id: 'review', label: '待核對', badge: 3 }, { id: 'confirmed', label: '已入帳' }, { id: 'failed', label: '辨識失敗', badge: 1 },
  { id: 'alerts', label: '價格提醒' }, { id: 'price', label: '單價走勢' }, { id: 'cost', label: '食材成本' }, { id: 'daily', label: '每日進貨' },
  { id: 'items', label: '品項廠商' }, { id: 'users', label: '帳號' }] };

await t('選單 → 頁頂分頁（九個、帶數字），回 dzy-purchase-tabs', async () => {
  sent.length = 0;
  await msg(NAV);
  const last = tabsSet[tabsSet.length - 1];
  assert.equal(last.length, 9);
  assert.deepEqual(last[0], { id: 'review', name: '待核對', badge: 3, err: false });
  assert.deepEqual(sent[0], { m: { type: 'dzy-purchase-tabs', v: 1 }, o: ORIGIN });
  assert.deepEqual(navs, ['review']); // 網址跟著貨單網頁（main → review）
});
await t('點頁頂分頁 → dzy-purchase-go；格式不對的 id 不送', async () => {
  sent.length = 0;
  mod.onRoute(mkCtx('cost'));
  assert.deepEqual(sent[0], { m: { type: 'dzy-purchase-go', v: 1, id: 'cost' }, o: ORIGIN });
  sent.length = 0;
  mod.onRoute(mkCtx('Bad Id'));
  assert.equal(sent.length, 0);
});
await t('卸載 → 送 dzy-purchase-logout、清空畫面、不再收訊息', async () => {
  sent.length = 0;
  await unmount();
  assert.deepEqual(sent[0], { m: { type: 'dzy-purchase-logout', v: 1 }, o: ORIGIN });
  assert.equal(root.children.length, 0);
  assert.equal(winListeners.message, undefined);
});

await t('首頁提醒帶 ?tab=failed 進來 → 第一次同步送 go failed', async () => {
  const r2 = new El('div');
  sent.length = 0;
  const un2 = mod.mount(r2, mkCtx('main', { tab: 'failed' }));
  const f2 = r2.all((n) => n.tagName === 'iframe')[0];
  await winListeners.message({ origin: ORIGIN, source: f2.contentWindow, data: NAV });
  assert.ok(sent.some((s) => s.m.type === 'dzy-purchase-go' && s.m.id === 'failed'));
  await un2();
});

await t('navTabs：超過 20 個、壞 id 被濾掉', () => {
  assert.equal(E.navTabs({ type: 'dzy-purchase-nav', v: 1, items: new Array(21).fill({ id: 'a', label: 'x' }) }), null);
  const n = E.navTabs({ type: 'dzy-purchase-nav', v: 1, items: [{ id: 'ok', label: 'A' }, { id: '<x>', label: 'B' }, { id: 'y' }], cur: 'nope' });
  assert.deepEqual(n, { tabs: [{ id: 'ok', name: 'A', badge: 0, err: false }], cur: '' });
});

await t('countAlerts：0 張不列；待核對＝warn、辨識失敗＝error，點了帶 tab', () => {
  assert.deepEqual(C.countAlerts({ review: 0, failed: 0 }), []);
  assert.deepEqual(C.countAlerts({ review: 12, failed: 2 }), [
    { level: 'warn', text: '貨單待核對 12 張', view: 'main', params: { tab: 'review' } },
    { level: 'error', text: '貨單辨識失敗 2 張', view: 'main', params: { tab: 'failed' } }]);
});
await t('parseCounts：形狀不對回 null', () => {
  assert.deepEqual(C.parseCounts({ ok: true, data: { review: 1, failed: 0 } }), { review: 1, failed: 0 });
  for (const j of [null, { ok: false }, { ok: true, data: { review: -1, failed: 0 } }, { ok: true, data: { review: '3', failed: 0 } }]) assert.equal(C.parseCounts(j), null);
});
await t('getCounts：一張券打 /sso/counts，badge 與 alerts 共用一次', async () => {
  C._resetShared();
  calls.length = 0;
  const fetched = [];
  const deps = { host: 'dzy.mozhuting.com', fetch: async (url, opt) => { fetched.push({ url, body: JSON.parse(opt.body) }); return { json: async () => ({ ok: true, data: { review: 4, failed: 1 } }) }; } };
  const [a, b] = await Promise.all([C.getCounts(mkCtx(), deps), C.getCounts(mkCtx(), deps)]);
  assert.deepEqual(a, { review: 4, failed: 1 });
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.deepEqual(fetched, [{ url: 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/purchase/api/sso/counts', body: { ticket: TICKET } }]);
});
await t('getCounts：換不到券或後端掛掉 → null（不擋首頁）', async () => {
  C._resetShared();
  ticketReply = { ok: false, code: 'no_perm' };
  assert.equal(await C.getCounts(mkCtx(), { fetch: async () => { throw new Error('不該打'); } }), null);
  ticketReply = { ok: true, data: { ticket: TICKET, expires_in: 60 } };
  C._resetShared();
  assert.equal(await C.getCounts(mkCtx(), { fetch: async () => { throw new Error('down'); } }), null);
});

console.log(failed ? `FAIL ${failed}` : 'PASS 全部');
if (failed) process.exit(1);
