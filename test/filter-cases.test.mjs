// 稽核裁切共用案例測試：讀 test/fixtures/filter-cases.json，驗 platform/api.js 的 __filterAuditData。
// 同一份 fixture 逐字複製到 ~/dzy-minikit 驗 proxy-hook.js filterResponse（兩邊語意必須一致）。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { __filterAuditData } from '../platform/api.js';

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/filter-cases.json', import.meta.url)), 'utf8'));
let fail = 0;
for (const c of fx.cases) {
  const data = JSON.parse(JSON.stringify(c.data));
  try {
    // filterNode 為 null＝不裁切（api.js 在 maybeFilterOwnNode_ 層決定要不要呼叫；null 案例直接驗「原樣」）
    const got = c.filterNode === null ? data : __filterAuditData(data, c.filterNode);
    assert.deepEqual(got, c.expect);
    console.log('PASS:', c.name);
  } catch (e) { fail++; console.log('FAIL:', c.name, '\n', e.message); }
}
if (fail) { console.log(`\n${fail} 項失敗（共 ${fx.cases.length} 項）`); process.exit(1); }
console.log(`\n全部測試通過，共 ${fx.cases.length} 項`);
