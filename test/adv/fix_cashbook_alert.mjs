// node test/adv/fix_cashbook_alert.mjs —— 對抗驗證 ⑨「收支提醒讀取失敗不斷言未月結」
// 攻擊 storesToAlert 的 null／undefined／false 三態：讀不到（null）不列、已被會計鎖（undefined，沒查明細）照原規則、沒帳（false）不列。
'use strict';
import { storesToAlert, needsAcctLock } from '../../modules/cashbook/lib/util.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const M = '2026-09';
const stores = [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }, { code: 'c', name: 'C' }, { code: 'd', name: 'D' }];
const acctLock = [{ month: M, status: '鎖定', lockedVia: 'acct' }];
const codes = (r) => r.map((s) => s.code).join(',');

// a 鎖定讀不到（null）、b 明細讀不到（null）、c 沒鎖有帳、d 已會計鎖
{
  const r = storesToAlert(stores, { a: null, b: [], c: [], d: acctLock }, M, { b: null, c: true });
  ok(codes(r) === 'c', 'null 兩種都不列；只剩 c', codes(r));
}
// 讀不到時不能倒過來列成「已鎖」或丟錯
{
  let threw = false;
  try { needsAcctLock(null, M); } catch (e) { threw = true; }
  ok(!threw, 'needsAcctLock(null) 不丟錯（storesToAlert 已先短路）');
}
// 舊語意沒變：沒帳（false）不列、沒查（undefined）但沒鎖 → 列
{
  const r = storesToAlert(stores, { a: [], b: [], c: [], d: [] }, M, { a: false, c: true });
  ok(codes(r) === 'b,c,d', 'false 不列；undefined 照原規則列', codes(r));
}
// 店不在 locksByStore（整個 map 沒它）→ undefined → 照原規則列（與 null 要分得開）
{
  const r = storesToAlert(stores, {}, M, {});
  ok(codes(r) === 'a,b,c,d', 'map 缺鍵（undefined）≠ null', codes(r));
}
ok(storesToAlert(null, null, M, null).length === 0 && storesToAlert(stores, null, M, null).length === 4, 'stores／maps 為 null 不炸');

console.log(`fix_cashbook_alert: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
