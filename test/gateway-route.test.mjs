// node test/gateway-route.test.mjs —— Cloudflare 櫃台切換（platform/route.js＋api.js 改道）
// 全程假 fetch／假 sessionStorage，不連外、不打正式後端。
'use strict';

class MemoryStorage {
  constructor() { this._map = new Map(); }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
  clear() { this._map.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

import { MINI_HOST_NEW, MINI_HOST_OLD, GATEWAY_ON, BACKENDS } from '../platform/config.js';
import { mainHost, markGatewayDown, gatewayDown, routeUrl, routeUrlForNs, GW_DOWN_KEY, GW_DOWN_MS, __setGatewayOn, __setNow, __resetRoute, __setProbe, __setLeaving, confirmGatewayDown } from '../platform/route.js';
import { login, logout, __setTransport } from '../platform/auth.js';
import { call, proxyUrl, __setHomeFast } from '../platform/api.js';
import { READ_ACTIONS } from '../platform/dryrun.js';
import { lineAuthUrl } from '../platform/views/line-auth.js';
import { helperUrl } from '../platform/helper/client.js';
import * as photo from '../modules/approvals/photo.js';
import { purchaseApi } from '../modules/purchase/counts.js';
import * as insp from '../modules/inspection/lib.js';
__setProbe(async () => false);   // 測試不連外：預設探測結果＝櫃台打不通

let passed = 0, failed = 0;
function ok(c, label, extra) {
  if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

const realCalls = [];
function arm() { globalThis.fetch = async (u) => { realCalls.push(String(u)); throw new TypeError('GUARD ' + u); }; }
arm();

const NEW_PLAT = MINI_HOST_NEW + '/platform/api', OLD_PLAT = MINI_HOST_OLD + '/platform/api';
const NEW_PROXY = MINI_HOST_NEW + '/platform/proxy', OLD_PROXY = MINI_HOST_OLD + '/platform/proxy';

/** 腳本化假 fetch：steps 依序給；每次呼叫記 url。step: 'neterr' | 'gw502' | 'proxy502' | {json, status} */
function script(steps) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const st = steps[Math.min(i++, steps.length - 1)];
    if (st === 'neterr') throw new TypeError('Failed to fetch');
    if (st === 'gw502') return mkRes(502, { ok: false, error: 'GATEWAY', detail: 'x' });
    if (st === 'html502') return { status: 502, clone() { return this; }, json: async () => { throw new Error('not json'); } };
    return mkRes(st.status || 200, st.json);
  };
  return calls;
}
function mkRes(status, json) { return { status, clone() { return mkRes(status, json); }, json: async () => json }; }

async function loginAs() {
  __setTransport(async (req) => (req.action === 'login' ? { ok: true, data: { token: 'tok-gw', user: { id: 'u1', name: '測試', role: 'staff', node: '' }, perms: ['*'] } } : { ok: false, error: 'x' }) );
  const r = await login('u', 'pw');
  __setTransport(null);
  if (!r.ok) throw new Error('login');
}
function fresh() { __resetRoute(); sessionStorage.clear(); __setHomeFast(false); arm(); }

await loginAs();

// 1. 主機選擇
{
  fresh();
  ok(GATEWAY_ON === true, '1: config GATEWAY_ON 預設 true');
  ok(mainHost() === MINI_HOST_NEW, '1: 預設用新主機');
  ok(MINI_HOST_NEW === 'https://dzy-gw.dingzhaoyuan888.workers.dev' && MINI_HOST_OLD === 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net', '1: 兩個主機值');
  ok(BACKENDS.platform === NEW_PLAT, '1: BACKENDS.platform 用新主機', BACKENDS.platform);
  ok(routeUrl(OLD_PLAT) === NEW_PLAT && routeUrl(NEW_PLAT) === NEW_PLAT, '1: routeUrl 兩個已知主機都換成目前主機');
  ok(routeUrl('http://localhost:8794/x') === 'http://localhost:8794/x', '1: 未知主機原樣');
  ok(routeUrlForNs(NEW_PROXY, 'payroll') === OLD_PROXY && routeUrlForNs(NEW_PROXY, 'audit') === NEW_PROXY, '1: payroll 強制舊主機、其他走預設');
}

// 2. 開關 false 全回舊
{
  fresh();
  __setGatewayOn(false);
  ok(mainHost() === MINI_HOST_OLD, '2: 開關 false → 舊主機');
  ok(proxyUrl('audit') === OLD_PROXY && proxyUrl() === OLD_PROXY, '2: proxyUrl 舊');
  ok(routeUrl(NEW_PLAT) === OLD_PLAT, '2: routeUrl 舊');
  ok(lineAuthUrl() === MINI_HOST_OLD + '/platform/svc/line-auth', '2: line-auth 舊');
  ok(helperUrl() === MINI_HOST_OLD + '/platform/svc/ai-help', '2: ai-help 舊');
  ok(photo.putUrl() === MINI_HOST_OLD + '/platform/svc/apv-file-put', '2: 簽核照片 舊');
  ok(purchaseApi('dzy.mozhuting.com') === MINI_HOST_OLD + '/purchase/api', '2: 貨單 舊');
  const calls = script([{ json: { ok: true, data: { staff: [] } } }]);
  await call('platform', 'staffList', {});
  ok(calls.length === 1 && calls[0].url === OLD_PLAT, '2: 實際 platform 呼叫打舊主機', calls.map((c) => c.url));
  __setGatewayOn(null);
}

// 3. 故障記號（sessionStorage、5 分鐘）
{
  fresh();
  let t = 1_000_000;
  __setNow(() => t);
  ok(gatewayDown() === false, '3: 起初無記號');
  markGatewayDown();
  ok(sessionStorage.getItem(GW_DOWN_KEY) === '1000000', '3: 記號存 sessionStorage');
  ok(gatewayDown() && mainHost() === MINI_HOST_OLD, '3: 有記號 → 舊主機');
  t += GW_DOWN_MS - 1;
  ok(gatewayDown() === true, '3: 5 分鐘內仍有效');
  t += 2;
  ok(gatewayDown() === false && mainHost() === MINI_HOST_NEW, '3: 超過 5 分鐘 → 回新主機');
  // sessionStorage 壞掉不拋例外
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() {} };
  const keep = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', { value: bad, configurable: true, writable: true });
  let threw = false;
  try { __resetRoute(); __setNow(() => 5); markGatewayDown(); ok(gatewayDown() === true, '3: sessionStorage 不可用 → 記憶體備援'); } catch (e) { threw = true; }
  ok(!threw, '3: sessionStorage 壞掉不拋例外');
  Object.defineProperty(globalThis, 'sessionStorage', { value: keep, configurable: true, writable: true });
  fresh();
}

// 4. 讀取：網路錯誤 → 設記號 + 舊主機重送一次
{
  fresh();
  const calls = script(['neterr', { json: { ok: true, data: { staff: [{ x: 1 }] } } }]);
  const r = await call('platform', 'staffList', {});
  ok(r.ok === true && r.data.staff.length === 1, '4: 讀取網路錯誤 → 重送成功');
  ok(calls.length === 2 && calls[0].url === NEW_PLAT && calls[1].url === OLD_PLAT, '4: 先新後舊，各一次', calls.map((c) => c.url));
  ok(gatewayDown(), '4: 設了故障記號');
  const c2 = script([{ json: { ok: true, data: {} } }]);
  await call('platform', 'staffList', {});
  ok(c2.length === 1 && c2[0].url === OLD_PLAT, '4: 之後的呼叫直接走舊主機');
}
{
  fresh();
  const calls = script(['gw502', { json: { ok: true, data: { staff: [] } } }]);
  const r = await call('platform', 'staffList', {});
  ok(r.ok === true && calls.length === 2 && calls[1].url === OLD_PLAT && gatewayDown(), '4b: 櫃台 502 GATEWAY 讀取 → 設記號並改舊主機重送');
}
{
  fresh();   // 重送也失敗：不無限重送
  const calls = script(['neterr']);
  const r = await call('platform', 'staffList', {});
  ok(r.ok === false && calls.length === 2, '4c: 兩邊都斷 → 只送兩次、回錯誤', calls.length);
}
{
  fresh();   // 代轉 ns 讀取
  const readAct = READ_ACTIONS.audit[0];
  const calls = script(['neterr', { json: { ok: true, data: { config: {} } } }]);
  const r = await call('audit', readAct, {});
  ok(calls.length === 2 && calls[0].url === NEW_PROXY && calls[1].url === OLD_PROXY, '4d: 代轉 ns 讀取同樣改道', calls.map((c) => c.url));
}

// 5. 寫入：不重送
{
  fresh();
  const calls = script(['neterr', { json: { ok: true, data: {} } }]);
  const r = await call('platform', 'staffCreateZZ', { a: 1 });
  ok(calls.length === 1 && r.ok === false, '5: 寫入網路錯誤 → 不重送，回錯誤', calls.length);
  ok(gatewayDown(), '5: 但設了記號');
  const c2 = script([{ json: { ok: true, data: {} } }]);
  await call('platform', 'staffCreateZZ', { a: 1 });
  ok(c2.length === 1 && c2[0].url === OLD_PLAT, '5: 下一次寫入走舊主機');
}
{
  fresh();
  const calls = script(['gw502']);
  const r = await call('audit', 'submitAuditZZ', {});
  ok(calls.length === 1 && r.ok === false && r.status === 502 && /舊系統暫時無法連線/.test(r.error), '5b: 代轉寫入收到 GATEWAY 502 → 不重送、沿用 502 訊息', r);
  ok(gatewayDown(), '5b: 設記號');
}

// 6. 不該設記號的情況
{
  fresh();
  script([{ status: 502, json: { ok: false, error: '舊系統' } }]);
  await call('audit', READ_ACTIONS.audit[0], {});
  ok(!gatewayDown(), '6: 一般 502（非 GATEWAY）不設記號');
  fresh();
  script([{ status: 500, json: { ok: false, error: 'x' } }]);
  await call('platform', 'staffList', {});
  ok(!gatewayDown(), '6: 500 不設記號');
  fresh();
  const calls = script([{ json: { ok: false, error: '沒有權限' } }]);
  await call('platform', 'staffList', {});
  ok(!gatewayDown() && calls.length === 1, '6: 業務錯誤不設記號、不重送');
  fresh();
  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const r = await call('platform', 'staffList', {});
  ok(!gatewayDown() && /逾時/.test(r.error), '6: 逾時（AbortError）不設記號');
  fresh();
  // 已在舊主機失敗：不再設記號、不重送
  markGatewayDown();
  const c2 = script(['neterr']);
  await call('platform', 'staffList', {});
  ok(c2.length === 1 && c2[0].url === OLD_PLAT, '6: 舊主機失敗不再重送');
}

// 7. payroll 一律舊主機
{
  fresh();
  const calls = script([{ json: { ok: true, data: {} } }]);
  await call('payroll', READ_ACTIONS.payroll[0], {});
  ok(calls.length === 1 && calls[0].url === OLD_PROXY, '7: payroll 讀取走舊主機（無故障記號）', calls[0] && calls[0].url);
  const c2 = script([{ json: { ok: true, data: {} } }]);
  await call('payroll', 'payroll_zz_write', {});
  ok(c2[0].url === OLD_PROXY, '7: payroll 寫入走舊主機');
  const c3 = script([{ json: { ok: true, data: {} } }]);
  await call('cashbook', READ_ACTIONS.cashbook[0], {});
  ok(c3[0].url === NEW_PROXY, '7: 其他代轉 ns 仍走新主機');
  ok(proxyUrl('payroll') === OLD_PROXY && proxyUrl('transfer') === NEW_PROXY, '7: proxyUrl(ns)');
  // payroll 網路錯誤（舊主機）不設故障記號
  script(['neterr']);
  await call('payroll', READ_ACTIONS.payroll[0], {});
  ok(!gatewayDown(), '7: payroll 在舊主機失敗不設新主機故障記號');
}

// 8. 各處推出來的網址
{
  fresh();
  ok(proxyUrl() === NEW_PROXY, '8: api proxyUrl');
  ok(lineAuthUrl() === MINI_HOST_NEW + '/platform/svc/line-auth', '8: line-auth');
  ok(lineAuthUrl('https://h.example/platform/api') === 'https://h.example/platform/svc/line-auth', '8: line-auth 傳入網址原樣');
  ok(helperUrl() === MINI_HOST_NEW + '/platform/svc/ai-help', '8: ai-help');
  ok(photo.putUrl() === MINI_HOST_NEW + '/platform/svc/apv-file-put' && photo.getUrl() === MINI_HOST_NEW + '/platform/svc/apv-file-get', '8: 簽核照片');
  ok(purchaseApi('dzy.mozhuting.com') === MINI_HOST_NEW + '/purchase/api', '8: 貨單 PROD');
  ok(purchaseApi('localhost') === 'http://localhost:8794/purchase/api', '8: 貨單 DEV 不動');
  const ic = script([{ json: { ok: false } }]);
  await insp.fetchPhoto('p-new');
  ok(ic.length === 1 && ic[0].url === MINI_HOST_NEW + '/platform/svc/apv-file-get', '8: 盤點抽查讀圖網址', ic.map((c) => c.url));
  markGatewayDown();
  ok(lineAuthUrl() === MINI_HOST_OLD + '/platform/svc/line-auth' && helperUrl().indexOf(MINI_HOST_OLD) === 0 && photo.getUrl().indexOf(MINI_HOST_OLD) === 0 && purchaseApi('x.com').indexOf(MINI_HOST_OLD) === 0 && proxyUrl('audit') === OLD_PROXY, '8: 有故障記號 → 各處都換舊主機');
  const ic2 = script([{ json: { ok: false } }]);
  await insp.fetchPhoto('p-old');
  ok(ic2[0].url === MINI_HOST_OLD + '/platform/svc/apv-file-get', '8: 盤點抽查有故障記號 → 舊主機');
  fresh();
}

// 9. 登入（auth.js）打新主機網路錯誤 → 設記號（不自動重送）
{
  fresh();
  const calls = script(['neterr']);
  const r = await login('u', 'pw');
  ok(r.ok === false && calls.length === 1 && calls[0].url === NEW_PLAT && gatewayDown(), '9: 登入網路錯誤 → 不重送、設記號');
  const c2 = script([{ json: { ok: false, error: 'x' } }]);
  await login('u', 'pw');
  ok(c2[0].url === OLD_PLAT, '9: 下一次登入走舊主機');
}

ok(realCalls.length === 0, '全程沒有未 mock 的網路請求', realCalls);
// 8. 網路錯誤要先確認（2026-11-10 正式站：重新整理中斷請求被誤判故障）
{
  __resetRoute(); __setProbe(async () => true);
  let downNow = await confirmGatewayDown();
  ok(downNow === false && gatewayDown() === false, '8: 探測打得通 → 不設故障記號');
  __setProbe(async () => false); __setLeaving(true);
  downNow = await confirmGatewayDown();
  ok(downNow === false && gatewayDown() === false, '8: 頁面正在離開 → 不設故障記號');
  __setLeaving(false);
  downNow = await confirmGatewayDown();
  ok(downNow === true && gatewayDown() === true, '8: 探測打不通 → 設故障記號');
  __resetRoute(); __setProbe(async () => false);
}
console.log(`\n${passed} 項通過，${failed} 項失敗`);
process.exit(failed ? 1 : 0);
