// node test/schedule-alerts.test.mjs —— 排班管理首頁待辦 alerts()／badge()（2026-10-24，營運系統 hr-move-spec §5）
// 含「真的走 platform/api.js 代轉轉接」的整合段（同 attendance-alerts.test.mjs）。
'use strict';
import assert from 'node:assert/strict';

class MemoryStorage { constructor() { this._m = new Map(); } getItem(k) { return this._m.has(k) ? this._m.get(k) : null; } setItem(k, v) { this._m.set(k, String(v)); } removeItem(k) { this._m.delete(k); } clear() { this._m.clear(); } }
globalThis.localStorage = new MemoryStorage();

const { toAlerts, toBadge } = await import('../modules/schedule/alerts.js');
const mod = (await import('../modules/schedule/index.js')).default;
const manifest = (await import('../modules/schedule/manifest.js')).default;
const { call } = await import('../platform/api.js');

let n = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error('FAIL', name, e.message); process.exitCode = 1; }); }

await t('單店單期', () => assert.deepEqual(toAlerts({ items: [{ code: 'gf', name: '光復店', periods: ['T01'] }] }),
  [{ level: 'warn', text: '光復店 T01 班表還沒送到 LINE', view: 'board' }]));
await t('多期用頓號', () => assert.equal(toAlerts({ items: [{ code: 'gf', name: '光復店', periods: ['T01', 'T02'] }] })[0].text, '光復店 T01、T02 班表還沒送到 LINE'));
await t('多店各一列', () => {
  const r = toAlerts({ items: [{ code: 'gf', name: '光復店', periods: ['T01'] }, { code: 'mc', name: '美村店', periods: ['T01', 'T02'] }] });
  assert.equal(r.length, 2); assert.equal(r[1].text, '美村店 T01、T02 班表還沒送到 LINE'); assert.ok(r.every((x) => x.view === 'board'));
});
await t('零件數回空陣列', () => {
  assert.deepEqual(toAlerts({ items: [] }), []);
  assert.deepEqual(toAlerts({ items: [{ code: 'gf', name: '光復店', periods: [] }] }), []);
});
await t('形狀不對回 null', () => {
  assert.equal(toAlerts(null), null); assert.equal(toAlerts({ items: 'x' }), null); assert.equal(toBadge(null), null); assert.equal(toBadge({ items: 5 }), null);
});
await t('badge＝所有 periods 數加總', () => {
  assert.equal(toBadge({ items: [{ name: 'a', periods: ['T01', 'T02'] }, { name: 'b', periods: ['T01'] }] }), 3);
  assert.equal(toBadge({ items: [] }), 0);
});

const upstream = { ok: true, data: { items: [{ code: 'gf', name: '光復店', periods: ['T01', 'T02'] }, { code: 'mc', name: '美村店', periods: ['T01'] }], asOf: '2026-10-24T08:00:00Z' } };
let sent = null;
function fakeFetch(body, status = 200) {
  globalThis.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { status, json: async () => body }; };
}
const ctx = { api: { call } };

await t('api.js 轉接後 alerts／badge 正確', async () => {
  fakeFetch(upstream);
  const raw = await call('schedule', 'schedAlerts');
  assert.equal(raw.ok, true);
  assert.equal(sent.body.ns, 'schedule'); assert.equal(sent.body.action, 'schedAlerts');
  const a = await mod.alerts(ctx);
  assert.deepEqual(a.map((x) => x.text), ['光復店 T01、T02 班表還沒送到 LINE', '美村店 T01 班表還沒送到 LINE']);
  assert.equal(await mod.badge(ctx), 3);
});
await t('零件數信封 → 空陣列、badge 0', async () => {
  fakeFetch({ ok: true, data: { items: [], asOf: 'x' } });
  assert.deepEqual(await mod.alerts(ctx), []); assert.equal(await mod.badge(ctx), 0);
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
await t('manifest ns／backend＝schedule，requires 不變', () => {
  assert.equal(manifest.ns, 'schedule'); assert.equal(manifest.backend, 'schedule');
  assert.deepEqual(manifest.requires, ['platform.att']);
});
console.log(`schedule-alerts: ${n} passed`);
