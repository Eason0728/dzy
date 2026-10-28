// node test/attendance-alerts.test.mjs —— 考勤管理首頁待辦 alerts()／badge()（2026-10-24，營運系統 spec §17.5）
// 含「真的走 platform/api.js 代轉轉接」的整合段：假 fetch 回營運系統 att-alerts 的標準信封，確認 ctx.api.call 實際吐出的形狀被正確處理。
'use strict';
import assert from 'node:assert/strict';

class MemoryStorage { constructor() { this._m = new Map(); } getItem(k) { return this._m.has(k) ? this._m.get(k) : null; } setItem(k, v) { this._m.set(k, String(v)); } removeItem(k) { this._m.delete(k); } clear() { this._m.clear(); } }
globalThis.localStorage = new MemoryStorage();

const { toAlerts, toBadge, toGapAlert } = await import('../modules/attendance/alerts.js');
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

// ---- 值班主管本人的申請找不到上層（2026-10-28，docs/req-upper）：平台後端 attUpperGaps ----
function routedFetch(gaps) {
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    sent = { url, body: b };
    return { status: 200, json: async () => (b.action === 'attUpperGaps' ? gaps : upstream) };
  };
}
await t('toGapAlert：有項目→一列 warn，view=request；空或形狀不對→null', () => {
  assert.deepEqual(toGapAlert({ ok: true, data: { items: [{ emp: 'DZY001', name: '測試一', unit_name: 'X' }, { emp: 'DZY002', name: '測試二', unit_name: 'X' }] } }),
    { level: 'warn', text: '2 位值班主管的申請找不到上層，由人資主管審', view: 'request' });
  assert.equal(toGapAlert({ ok: true, data: { items: [] } }), null);
  assert.equal(toGapAlert({ ok: true, data: { items: [{ kind: 'approve', count: 3 }] } }), null);
  assert.equal(toGapAlert({ ok: false }), null); assert.equal(toGapAlert(null), null);
});
await t('toGapAlert：items＋unmapped 合併計數（只有 unmapped 也提醒）', () => {
  assert.equal(toGapAlert({ ok: true, data: { items: [{ emp: 'DZY001' }], unmapped: [{ store_code: 'gf', emp_id: 'GF1', reason: 'unmapped' }] } }).text, '2 位值班主管的申請找不到上層，由人資主管審');
  assert.equal(toGapAlert({ ok: true, data: { items: [], unmapped: [{ store_code: 'gf', emp_id: 'GF1', reason: 'unmapped' }] } }).text, '1 位值班主管的申請找不到上層，由人資主管審');
  assert.equal(toGapAlert({ ok: true, data: { items: [], unmapped: [] } }), null);
});
await t('alerts()：有 gap 時多一行；沒有／失敗時維持原樣', async () => {
  routedFetch({ ok: true, data: { items: [{ emp: 'DZY001', name: '測試一', unit_name: 'X' }] } });
  const a = await mod.alerts(ctx);
  assert.equal(a.length, 4);
  assert.deepEqual(a[3], { level: 'warn', text: '1 位值班主管的申請找不到上層，由人資主管審', view: 'request' });
  assert.equal(sent.body.action === 'attUpperGaps' || sent.body.ns === 'attendance', true);
  routedFetch({ ok: true, data: { items: [] } });
  assert.equal((await mod.alerts(ctx)).length, 3);
  routedFetch({ ok: false, error: 'no_perm' });
  assert.equal((await mod.alerts(ctx)).length, 3);
});
await t('pending 時不加 gap 行', async () => {
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    return { status: 200, json: async () => (b.action === 'attUpperGaps' ? { ok: true, data: { items: [{ emp: 'DZY001' }] } } : { ok: true, data: { items: [], pending: true } }) };
  };
  assert.deepEqual(await mod.alerts(ctx), [{ level: 'info', text: '出勤待辦統計中，稍後回首頁就會看到' }]);
});
await t('manifest ns／backend＝attendance，requires 不變', () => {
  assert.equal(manifest.ns, 'attendance'); assert.equal(manifest.backend, 'attendance');
  assert.deepEqual(manifest.requires, ['platform.att']);
});
console.log(`attendance-alerts: ${n} passed`);
