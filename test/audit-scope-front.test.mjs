// node test/audit-scope-front.test.mjs —— 稽核兩模組的「店清單」改看 ctx.auditScope（後端 audit_scope）
// 情境：依職稱給權限的店長（role staff、node 空字串）後端已裁成只剩自己店，前端要認得 auditScope。
'use strict';
import assert from 'node:assert/strict';
import { invalidate, __setClock, resolveMyStores } from '../modules/audit-shared/api.js';
import stockIndex from '../modules/audit-stock/index.js';
import opsIndex from '../modules/audit-ops/index.js';

let passed = 0;
const failures = [];
async function at(name, fn) {
  try { invalidate(); __setClock(null); await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}

const STORES = [
  { code: 'sxl-gf', name: '光復' },
  { code: 'mala-mc', name: '美村' },
  { code: 'ck', name: '央廚' }
];
function mkCtx(userPatch, scope, records, opsRecords) {
  return {
    user: Object.assign({ id: 'u9', name: '店長', role: 'staff', node: '' }, userPatch),
    auditScope: scope,
    can: (p) => p === 'audit.read.own',
    api: { call: async () => ({ ok: true, data: { config: { stores: STORES }, records: records || [], details: [], ops_records: opsRecords || [], ops_details: [] } }) },
    ui: { loading() {}, toast() {} },
    fmt: {}
  };
}

await at('resolveMyStores：陣列 → 用陣列', async () => {
  assert.deepEqual(resolveMyStores(mkCtx({}, ['sxl-gf', 'mala-mc']), STORES), ['sxl-gf', 'mala-mc']);
});
await at('resolveMyStores：all → config 全部；其他 → node', async () => {
  assert.deepEqual(resolveMyStores(mkCtx({}, 'all'), STORES), ['sxl-gf', 'mala-mc', 'ck']);
  assert.deepEqual(resolveMyStores(mkCtx({ node: 'ck' }, null), STORES), ['ck']);
  assert.deepEqual(resolveMyStores(mkCtx({ node: '' }, null), STORES), []);
});
await at('盤點抽查 badge：staff 店長（node 空）有 auditScope 陣列 → 算得出待辦', async () => {
  assert.equal(await stockIndex.badge(mkCtx({}, ['sxl-gf'])), 1);
});
await at('盤點抽查 badge：多店 scope 各算一家', async () => {
  assert.equal(await stockIndex.badge(mkCtx({}, ['sxl-gf', 'mala-mc'])), 2);
});
await at('營運稽核 badge/alerts：staff 店長有 auditScope 陣列 → 不再回 null', async () => {
  const ctx = mkCtx({}, ['sxl-gf'], [], [{ store: 'sxl-gf', month: '2026-10', status: '已稽核', record_key: 'k1' }]);
  const alerts = await opsIndex.alerts(ctx);
  assert.notEqual(alerts, null);
});

if (failures.length) {
  for (const { name, err } of failures) console.error('x ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n  ') : err));
}
console.log(`通過 ${passed}/${passed + failures.length}`);
process.exit(failures.length ? 1 : 0);
