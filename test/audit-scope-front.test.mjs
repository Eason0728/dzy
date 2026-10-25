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

// 區督導沒負責任何區（後端 auditScope＝[]）：總覽／報告／異常分析顯示「目前沒有負責的門市」，不是空白清單
function fakeDoc() {
  const mk = (tag) => ({ tagName: tag, className: '', _text: '', children: [], attrs: {},
    get firstChild() { return this.children[0] || null; },
    set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    appendChild(c) { this.children.push(c); return c; }, removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  return { createElement: mk, createTextNode: (t) => ({ textContent: String(t), children: [] }) };
}
await at('sharedApi.noAssignedStores：只有 auditScope 是空陣列才算', async () => {
  const { noAssignedStores } = await import('../modules/audit-shared/api.js');
  assert.equal(typeof noAssignedStores, 'function');
  assert.equal(noAssignedStores({ auditScope: [] }), true);
  assert.equal(noAssignedStores({ auditScope: ['sxl-gf'] }), false);
  assert.equal(noAssignedStores({ auditScope: 'all' }), false);
  assert.equal(noAssignedStores({ auditScope: null }), false);
  assert.equal(noAssignedStores(null), false);
});
for (const [label, mod, views] of [['盤點抽查', stockIndex, ['overview', 'report', 'analysis']], ['營運稽核', opsIndex, ['overview', 'report']]]) {
  for (const v of views) {
    await at(`${label} ${v}：auditScope＝[] → 顯示「目前沒有負責的門市」`, async () => {
      const prev = globalThis.document;
      globalThis.document = fakeDoc();
      let calls = 0;
      try {
        const root = globalThis.document.createElement('div');
        const ctx = Object.assign(mkCtx({}, []), { viewId: v, params: {}, can: (p) => p === 'audit.read.brand' });
        ctx.api = { call: async () => { calls++; return { ok: true, data: { config: { stores: [] } } }; } };
        const un = mod.mount(root, ctx);
        assert.match(root.textContent, /目前沒有負責的門市/);
        assert.equal(calls, 0, '不用打後端');
        if (typeof un === 'function') un(); else if (mod.unmount) mod.unmount();
      } finally { globalThis.document = prev; }
    });
  }
}
if (failures.length) {
  for (const { name, err } of failures) console.error('x ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n  ') : err));
}
console.log(`通過 ${passed}/${passed + failures.length}`);
process.exit(failures.length ? 1 : 0);
