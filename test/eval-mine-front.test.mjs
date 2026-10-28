// node test/eval-mine-front.test.mjs —— 績效「我的成績」前端：後端因評分人數不足不回逐題（attItems／perfItems＝null）時，
// 畫面要顯示說明、不能壞掉或顯示一排「—」（2026-10-28 夜間審查 #1）。假 DOM、假資料。
'use strict';

import assert from 'node:assert/strict';
import { mountMine } from '../modules/eval/views/mine.js';

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('PASS: ' + name); }

function fakeEl() {
  const box = { innerHTML: '' };
  const el = { innerHTML: '', querySelector: (s) => (s === '[data-role="detail"]' ? box : null) };
  return { el, box };
}
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctxWith = (data) => ({ fmt: { esc }, api: { call: async () => ({ ok: true, data }) } });
const flush = () => new Promise((r) => setTimeout(r, 0));
const base = (over) => Object.assign({ quarter: '2026-Q3', kind: 'pt', source: 'live', attitude: 18, performance: 42, adjAtt: 0, adjPerf: 0, subtotal: 60, total: 60,
  attLabels: ['準時', '禮貌'], perfLabels: ['出餐', '清潔'], attItems: [3.5, 2.5], perfItems: [4, 3], wageIdx: 2 }, over);

await t('人數不足（itemsHidden、逐題 null）→ 顯示說明、總分照常', async () => {
  const { el, box } = fakeEl();
  mountMine(el, ctxWith({ kind: 'pt', quarters: [base({ attItems: null, perfItems: null, peerAttItems: null, peerPerfItems: null, itemsHidden: true, selfAtt: [3, 3], selfPerf: [3, 3] })], messages: [], feedback: [], wageTiers: [], gradeTable: [] }));
  await flush();
  assert.match(box.innerHTML, /評分人數不足/, box.innerHTML.slice(0, 400));
  assert.ok(!/<td>準時<\/td>/.test(box.innerHTML), '不列逐題列');
  assert.ok(!/自評 vs 同事評/.test(box.innerHTML), '不出自評對照卡');
  assert.match(box.innerHTML, />60</, '總分照常');
});
await t('人數足夠 → 照常列逐題、沒有說明', async () => {
  const { el, box } = fakeEl();
  mountMine(el, ctxWith({ kind: 'pt', quarters: [base({})], messages: [], feedback: [], wageTiers: [], gradeTable: [] }));
  await flush();
  assert.match(box.innerHTML, /<td>準時<\/td>/);
  assert.ok(!/評分人數不足/.test(box.innerHTML));
});
await t('正職：人數不足 → 態度說明一行，KPI 照常', async () => {
  const { el, box } = fakeEl();
  mountMine(el, ctxWith({ kind: 'ft', quarters: [base({ kind: 'ft', attItems: null, perfItems: null, itemsHidden: true, grade: 'B', kpi: [{ label: '營業額', score: 40, weight: 70 }] })], messages: [], feedback: [], wageTiers: [], gradeTable: [] }));
  await flush();
  assert.match(box.innerHTML, /評分人數不足/);
  assert.match(box.innerHTML, /營業額/);
});
console.log(`\n通過 ${n}／${n}`);
