// node test/attendance-alerts.test.mjs —— 考勤管理首頁待辦 alerts()／badge()（2026-10-24，營運系統 spec §17.5）
// 含「真的走 platform/api.js 代轉轉接」的整合段：假 fetch 回營運系統 att-alerts 的標準信封，確認 ctx.api.call 實際吐出的形狀被正確處理。
'use strict';
import assert from 'node:assert/strict';

class MemoryStorage { constructor() { this._m = new Map(); } getItem(k) { return this._m.has(k) ? this._m.get(k) : null; } setItem(k, v) { this._m.set(k, String(v)); } removeItem(k) { this._m.delete(k); } clear() { this._m.clear(); } }
globalThis.localStorage = new MemoryStorage();

const { toAlerts, toBadge } = await import('../modules/attendance/alerts.js');
const mod = (await import('../modules/attendance/index.js')).default;
const manifest = (await import('../modules/attendance/manifest.js')).default;
const { call } = await import('../platform/api.js');

let n = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error('FAIL', name, e.message); process.exitCode = 1; }); }
const items3 = [{ kind: 'approve', count: 3 }, { kind: 'request', count: 2 }, { kind: 'device', count: 1 }];

await t('三項都有', () => assert.deepEqual(toAlerts({ items: items3, partial: false, pending: false }), [
  { level: 'warn', text: '本月還有 3 天沒核定', view: 'approve' },
  { level: 'warn', text: '2 筆加班請假申請待審', view: 'request' },
  { level: 'warn', text: '1 支新手機等核准', view: 'device' }]));
await t('零件數回空陣列', () => assert.deepEqual(toAlerts({ items: [{ kind: 'approve', count: 0 }], partial: false }), []));
await t('items 空', () => assert.deepEqual(toAlerts({ items: [] }), []));
await t('pending', () => assert.deepEqual(toAlerts({ items: [], pending: true }), [{ level: 'info', text: '出勤待辦統計中，稍後回首頁就會看到' }]));
await t('partial 加一列', () => {
  const r = toAlerts({ items: [items3[0]], partial: true });
  assert.deepEqual(r[r.length - 1], { level: 'warn', text: '部分門市暫時讀不到' });
  assert.equal(r.length, 2);
});
await t('形狀不對回 null', () => {
  assert.equal(toAlerts(null), null); assert.equal(toAlerts({ items: 'x' }), null); assert.equal(toAlerts(undefined), null);
  assert.equal(toBadge(null), null); assert.equal(toBadge({ items: 5 }), null);
});
await t('badge＝approve＋request', () => {
  assert.equal(toBadge({ items: items3 }), 5);
  assert.equal(toBadge({ items: [], pending: true }), null);
  assert.equal(toBadge({ items: [] }), 0);
});

// ---- 真的走 api.js：假 fetch 回上游信封 ----
const upstream = { ok: true, data: { items: items3, partial: false, asOf: '2026-10-24T08:00:00Z', pending: false } };
let sent = null;
function fakeFetch(body, status = 200) {
  globalThis.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { status, json: async () => body }; };
}
const ctx = { api: { call } };

await t('api.js 轉接後 alerts 正確（上游信封經 transformResponse_）', async () => {
  fakeFetch(upstream);
  const raw = await call('attendance', 'attAlerts');
  assert.equal(raw.ok, true);
  assert.equal(sent.body.ns, 'attendance'); assert.equal(sent.body.action, 'attAlerts');
  const a = await mod.alerts(ctx);
  assert.equal(a.length, 3); assert.equal(a[0].text, '本月還有 3 天沒核定'); assert.equal(a[2].view, 'device');
  assert.equal(await mod.badge(ctx), 5);
});
await t('pending 信封', async () => {
  fakeFetch({ ok: true, data: { items: [], partial: false, asOf: 'x', pending: true } });
  assert.deepEqual(await mod.alerts(ctx), [{ level: 'info', text: '出勤待辦統計中，稍後回首頁就會看到' }]);
  assert.equal(await mod.badge(ctx), null);
});
await t('上游 ok:false → null', async () => {
  fakeFetch({ ok: false, error: 'UPSTREAM', message: 'x' });
  assert.equal(await mod.alerts(ctx), null); assert.equal(await mod.badge(ctx), null);
});
await t('代轉 403／網路錯誤 → null', async () => {
  fakeFetch({}, 403);
  assert.equal(await mod.alerts(ctx), null);
  globalThis.fetch = async () => { throw new Error('boom'); };
  assert.equal(await mod.alerts(ctx), null); assert.equal(await mod.badge(ctx), null);
});
await t('manifest ns／backend＝attendance，requires 不變', () => {
  assert.equal(manifest.ns, 'attendance'); assert.equal(manifest.backend, 'attendance');
  assert.deepEqual(manifest.requires, ['platform.att']);
});
console.log(`attendance-alerts: ${n} passed`);
