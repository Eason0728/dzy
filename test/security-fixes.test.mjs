// node test/security-fixes.test.mjs —— 2026-10-12 安全修補驗收
//   1. 稽核快取換人丟棄（audit-shared/api.js）；in-flight 回來時已換人不寫入
//   2. 試跑模式 ?dryrun=1 在 platform/api.js 中央攔寫入、放讀取；auth 的改密碼／認領／忘記密碼也攔
//   3. 店長裁切：陣列只要有任一列帶 store 就裁切，無 store 的列丟掉
// 全程假 fetch／假 transport，不打真實網路。
'use strict';

class MemoryStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}
globalThis.localStorage = new MemoryStorage();

import assert from 'node:assert/strict';
import { login, logout, __setTransport, changePassword, publicCall, claimSubmit } from '../platform/auth.js';
import { call } from '../platform/api.js';
import { __setDryRun, setDryRunNotifier } from '../platform/dryrun.js';
import { getAll, invalidate } from '../modules/audit-shared/api.js';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); }
}

const realNetworkCalls = [];
globalThis.fetch = async (url) => { realNetworkCalls.push(String(url)); throw new Error('GUARD'); };
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ url: String(url), body });
    return { json: async () => handler(body) };
  };
  return calls;
}
async function loginAs(session) {
  __setTransport(async (req) => req.action === 'login' ? { ok: true, data: session } : { ok: false, error: 'x' });
  const r = await login('u', 'pw');
  assert.ok(r.ok);
  __setTransport(null);
}
const storeLead = { token: 't', user: { id: 'U1', name: 'n', role: 'storelead', node: 'ck' }, perms: ['audit.read.own'], secrets: { audit: 'A' } };

// ---------- 1. 稽核快取換人 ----------
await t('1a 快取記住使用者：換人後丟棄舊快取、重新抓取', async () => {
  invalidate();
  let n = 0;
  const api = { call: async () => ({ ok: true, data: { owner: 'call' + (++n) } }) };
  const a = { user: { id: 'ACC' }, api };
  const b = { user: { id: 'STORE' }, api };
  const r1 = await getAll(a);
  const r2 = await getAll(a);
  assert.equal(r2.data.owner, 'call1', '同一人 TTL 內命中快取');
  assert.equal(n, 1);
  const r3 = await getAll(b);
  assert.equal(r3.data.owner, 'call2', '換人必須重抓，不得拿到前一人的快取');
  assert.equal(n, 2);
  assert.notEqual(r1, r3);
  const r4 = await getAll(a);
  assert.equal(n, 3, '換回去也不能用 B 的快取');
  assert.equal(r4.data.owner, 'call3');
});

await t('1b in-flight 回來時使用者已變：不寫入快取', async () => {
  invalidate();
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  const slowApi = { call: async () => { await gate; return { ok: true, data: { owner: 'A-data' } }; } };
  const fastApi = { call: async () => ({ ok: true, data: { owner: 'B-data', n: ++n } }) };
  const pA = getAll({ user: { id: 'A' }, api: slowApi });      // A 的請求還在飛
  const rB = await getAll({ user: { id: 'B' }, api: fastApi }); // 換成 B
  assert.equal(rB.data.owner, 'B-data');
  release();
  await pA;                                                      // A 的結果回來
  const rB2 = await getAll({ user: { id: 'B' }, api: fastApi });
  assert.equal(rB2.data.owner, 'B-data', 'A 的資料不得被寫進快取給 B');
});

await t('1c 沒有 ctx.user 的呼叫端（舊測試形狀）行為不變', async () => {
  invalidate();
  let n = 0;
  const ctx = { api: { call: async () => ({ ok: true, data: { n: ++n } }) } };
  await getAll(ctx); await getAll(ctx);
  assert.equal(n, 1);
});

// ---------- 2. dryrun 中央攔截 ----------
await t('2a dryrun：寫入 action 不送出、回 ok+dryrun，並通知', async () => {
  await loginAs(storeLead);
  const calls = mockFetch(() => ({ ok: true }));
  const msgs = []; setDryRunNotifier((m) => msgs.push(m));
  __setDryRun(true);
  try {
    const writes = [['audit', 'submitAudit'], ['audit', 'addStore'], ['audit', '未知動作'],
      ['dorm', 'create'], ['dorm', 'handoverSign'], ['dorm', 'terminate'], ['dorm', 'delete'],
      ['platform', 'saveUser'], ['platform', 'resetPassword'], ['platform', 'staffAdd'],
      ['platform', 'saveMyProfile'], ['platform', 'staffImport']];
    for (const [b, a] of writes) {
      const r = await call(b, a, { x: 1 });
      assert.equal(r.ok, true, `${b}/${a}`);
      assert.equal(r.dryrun, true, `${b}/${a}`);
    }
    assert.equal(calls.length, 0, '寫入類一次都不能送出');
    assert.equal(msgs.length, writes.length);
    assert.ok(msgs[0].includes('試跑模式'));
  } finally { __setDryRun(null); setDryRunNotifier(null); }
});

await t('2a2 dryrun：主控台輸出與回傳都不帶明文 payload（密碼、電話等）', async () => {
  await loginAs(storeLead);
  mockFetch(() => ({ ok: true }));
  const logs = [];
  const orig = { warn: console.warn, log: console.log, info: console.info };
  const grab = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.warn = grab; console.log = grab; console.info = grab;
  __setDryRun(true);
  const cases = [
    ['saveUser', { id: 'U1', password: 'SECRET-PW-1' }, 'SECRET-PW-1'],
    ['resetPassword', { id: 'U1', newPassword: 'SECRET-PW-2' }, 'SECRET-PW-2'],
    ['staffEdit', { emp_no: 'E1', phone: '0900000111', address: 'ADDR-XYZ', birthday: '1990-01-01' }, '0900000111'],
  ];
  const results = [];
  try {
    for (const [a, p] of cases) results.push(await call('platform', a, p));
  } finally { console.warn = orig.warn; console.log = orig.log; console.info = orig.info; __setDryRun(null); }
  const all = logs.join('\n') + '\n' + JSON.stringify(results);
  for (const [, , secret] of cases) assert.ok(!all.includes(secret), '不該出現明文：' + secret);
  assert.ok(!all.includes('ADDR-XYZ') && !all.includes('1990-01-01'));
  assert.ok(logs.some((l) => l.includes('platform') && l.includes('saveUser')), '仍要印出 backendId 與 action');
  for (const r of results) { assert.equal(r.ok, true); assert.equal(r.dryrun, true); assert.equal(r.data.dryRun, true); }
});

await t('2a3 maskPayload：遞迴遮罩敏感鍵名', async () => {
  const { maskPayload } = await import('../platform/dryrun.js');
  const m = maskPayload({ a: 1, Password: 'x', nested: { token: 't', list: [{ phone: '09', ok: 1 }], id_no: 'A1' }, secret_key: 's' });
  assert.deepEqual(m, { a: 1, Password: '***', nested: { token: '***', list: [{ phone: '***', ok: 1 }], id_no: '***' }, secret_key: '***' });
});

await t('2b dryrun：讀取白名單照常送出（含 staffImport preview:true）', async () => {
  await loginAs(storeLead);
  const calls = mockFetch((b) => ({ ok: true, data: {}, contracts: [], rooms: [] }));
  __setDryRun(true);
  try {
    const reads = [['audit', 'getAll'], ['dorm', 'rooms'], ['dorm', 'list'], ['dorm', 'contract'], ['dorm', 'handover'],
      ['platform', 'me'], ['platform', 'listUsers'], ['platform', 'listRoles'], ['platform', 'orgOptions'],
      ['platform', 'myProfile'], ['platform', 'myUnit'], ['platform', 'staffList']];
    for (const [b, a] of reads) {
      const r = await call(b, a, {});
      assert.notEqual(r.dryrun, true, `${b}/${a} 不該被擋`);
    }
    assert.equal(calls.length, reads.length);
    const p = await call('platform', 'staffImport', { names: ['x'], preview: true });
    assert.notEqual(p.dryrun, true);
    assert.equal(calls.length, reads.length + 1);
  } finally { __setDryRun(null); }
});

await t('2c 非 dryrun：寫入照常送出（不影響正式行為）', async () => {
  await loginAs(storeLead);
  const calls = mockFetch(() => ({ ok: true }));
  const r = await call('dorm', 'create', { a: 1 });
  assert.equal(r.dryrun, undefined);
  assert.equal(calls.length, 1);
});

await t('2d dryrun：auth 的 changePassword／claimSubmit／forgotReset 不送出；claimLookup 放行', async () => {
  const sent = [];
  __setTransport(async (req) => { sent.push(req.action); return { ok: true, data: {} }; });
  __setDryRun(true);
  try {
    const c = await changePassword('old', 'newpassword1');
    assert.equal(c.ok, false); assert.equal(c.dryrun, true);
    const s = await claimSubmit({ name: 'x' });
    assert.equal(s.ok, false); assert.equal(s.dryrun, true);
    const f = await publicCall('forgotReset', { name: 'x' });
    assert.equal(f.ok, false); assert.equal(f.dryrun, true);
    assert.deepEqual(sent, []);
    await publicCall('claimLookup', { name: 'x' });
    await publicCall('orgOptions', {});
    assert.deepEqual(sent, ['claimLookup', 'orgOptions']);
  } finally { __setDryRun(null); __setTransport(null); }
});

// ---------- 3. 店長裁切 ----------
await t('3 混入一列沒有 store 的資料：仍裁切，只剩自己店的列', async () => {
  await loginAs(storeLead); // node = ck, 只有 audit.read.own
  mockFetch(() => ({
    ok: true,
    config: { stores: [{ code: 'ck' }, { code: 'sxl-gf' }] },
    records: [{ store: 'ck', v: 1 }, { store: 'sxl-gf', v: 2 }, { v: 3 }, null],
    items: [{ store: 'sxl-gf' }, { name: '無店別' }],
    details: []
  }));
  const r = await call('audit', 'getAll', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.records, [{ store: 'ck', v: 1 }]);
  assert.deepEqual(r.data.items, [], '只有別店與無 store 的列 → 全丟');
  assert.deepEqual(r.data.details, [], '空陣列照舊');
  assert.deepEqual(r.data.config.stores, [{ code: 'ck' }], 'config.stores 也依 code 裁（第二期白名單）');
});

await t('3b 全節點權限者不裁切（含無 store 的列照給）', async () => {
  await loginAs({ ...storeLead, user: { id: 'ACC', name: 'a', role: 'accountant', node: '' }, perms: ['audit.read'] });
  mockFetch(() => ({ ok: true, records: [{ store: 'ck' }, { v: 1 }] }));
  const r = await call('audit', 'getAll', {});
  assert.equal(r.data.records.length, 2);
});

__setTransport(async () => ({ ok: true, data: {} })); // logout() 會先呼叫後端（2026-10-12），用假 transport
await logout();
__setTransport(null);
assert.equal(realNetworkCalls.length, 0, '真實網路呼叫必須為 0');
console.log(`\n通過 ${passed}/${passed + failed}`);
if (failed) process.exit(1);
