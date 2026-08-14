// fmt.js 單元測試 —— 涵蓋 docs/spec.md §4.7 定義的五個格式化函式。
// 純 node 執行，無第三方套件：node test/fmt.test.mjs

import assert from 'node:assert/strict';
import { date, datetime, roc, esc, money } from '../platform/fmt.js';

let passed = 0;
let failed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

// ── date() ──────────────────────────────────────────────
t('date: 一般日期', () => assert.equal(date('2026-08-14'), '2026-08-14'));
t('date: 跨月 1/31', () => assert.equal(date('2026-01-31'), '2026-01-31'));
t('date: 跨年 12/31', () => assert.equal(date('2025-12-31'), '2025-12-31'));
t('date: 跨年 1/1', () => assert.equal(date('2026-01-01'), '2026-01-01'));
t('date: 閏年 2/29（2024）', () => assert.equal(date('2024-02-29'), '2024-02-29'));
t('date: 非閏年 2/29 非法（2026）', () => assert.equal(date('2026-02-29'), ''));
t('date: null', () => assert.equal(date(null), ''));
t('date: undefined', () => assert.equal(date(undefined), ''));
t('date: 空字串', () => assert.equal(date(''), ''));
t('date: 非法字串', () => assert.equal(date('not-a-date'), ''));
t('date: 非法月份', () => assert.equal(date('2026-13-01'), ''));
t('date: Date 物件', () => assert.equal(date(new Date(Date.UTC(2026, 7, 14))), '2026-08-14'));
t('date: Invalid Date 物件', () => assert.equal(date(new Date('garbage')), ''));
t('date: Unix 毫秒', () => assert.equal(date(Date.UTC(2026, 7, 14, 12, 0, 0)), '2026-08-14'));
t('date: NaN 數字', () => assert.equal(date(NaN), ''));

// ── datetime() ──────────────────────────────────────────
t('datetime: 跨午夜換算台北時間', () => {
  // UTC 2026-01-31 23:00:00 → 台北（+8）2026-02-01 07:00:00
  const ms = Date.UTC(2026, 0, 31, 23, 0, 0);
  assert.equal(datetime(ms), '2026-02-01 07:00:00');
});
t('datetime: 跨年瞬間', () => {
  // UTC 2025-12-31 16:30:00 → 台北 2026-01-01 00:30:00
  const ms = Date.UTC(2025, 11, 31, 16, 30, 0);
  assert.equal(datetime(ms), '2026-01-01 00:30:00');
});
t('datetime: null', () => assert.equal(datetime(null), ''));
t('datetime: undefined', () => assert.equal(datetime(undefined), ''));
t('datetime: 空字串', () => assert.equal(datetime(''), ''));
t('datetime: 非法字串', () => assert.equal(datetime('abc'), ''));

t('時區：不受 process.env.TZ 影響', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ms = Date.UTC(2026, 0, 31, 23, 0, 0); // 台北應為 2026-02-01 07:00:00
    assert.equal(date(ms), '2026-02-01');
    assert.equal(datetime(ms), '2026-02-01 07:00:00');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ── roc() ───────────────────────────────────────────────
t('roc: 一般日期不補零', () => assert.equal(roc('2026-08-04'), '民國 115 年 8 月 4 日'));
t('roc: 跨年 1/1', () => assert.equal(roc('2026-01-01'), '民國 115 年 1 月 1 日'));
t('roc: 跨月 1/31', () => assert.equal(roc('2026-01-31'), '民國 115 年 1 月 31 日'));
t('roc: 閏年 2/29', () => assert.equal(roc('2024-02-29'), '民國 113 年 2 月 29 日'));
t('roc: null', () => assert.equal(roc(null), ''));
t('roc: 空字串', () => assert.equal(roc(''), ''));
t('roc: 非法字串', () => assert.equal(roc('not-a-date'), ''));

// ── esc() ───────────────────────────────────────────────
t('esc: script 標籤與雙引號', () => {
  assert.equal(
    esc('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});
t('esc: 單引號', () => assert.equal(esc("O'Brien"), 'O&#39;Brien'));
t('esc: & 本身', () => assert.equal(esc('A & B'), 'A &amp; B'));
t('esc: 全部五個字元同時出現', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
t('esc: null 回空字串', () => assert.equal(esc(null), ''));
t('esc: undefined 回空字串', () => assert.equal(esc(undefined), ''));
t('esc: 一般文字不受影響', () => assert.equal(esc('王小明'), '王小明'));
t('esc: 數字輸入轉字串', () => assert.equal(esc(123), '123'));

// ── money() ─────────────────────────────────────────────
t('money: 基本千分位', () => assert.equal(money(1234567), '1,234,567'));
t('money: 負數', () => assert.equal(money(-1234), '-1,234'));
t('money: 0', () => assert.equal(money(0), '0'));
t('money: 三位數不加逗號', () => assert.equal(money(999), '999'));
t('money: 剛好四位數', () => assert.equal(money(1000), '1,000'));
t('money: 負數剛好三位數', () => assert.equal(money(-999), '-999'));
t('money: null', () => assert.equal(money(null), ''));
t('money: undefined', () => assert.equal(money(undefined), ''));
t('money: 空字串', () => assert.equal(money(''), ''));
t('money: 非數字字串', () => assert.equal(money('abc'), ''));
t('money: NaN', () => assert.equal(money(NaN), ''));

// ── 後端實際會吐出來的時間格式（2026-08-14 補）───────────
// 這一組是踩到後才補的：後端把 'YYYY-MM-DD HH:mm:ss' 寫進試算表，
// 前端 datetime() 卻回空字串，人員清單的建立時間／最後登入整欄空白。
// 原本 48 項全過卻沒抓到，因為測試從沒餵過這些輸入形狀——
// 「後端寫得出去、前端讀不回來」這種接縫漏洞，只有跨層的實測才看得到。
t('datetime: 後端格式 YYYY-MM-DD HH:mm:ss', () =>
  assert.equal(datetime('2026-08-01 09:00:00'), '2026-08-01 09:00:00'));
t('datetime: ISO 無時區標記', () =>
  assert.equal(datetime('2026-08-01T09:00:00'), '2026-08-01 09:00:00'));
t('datetime: 省略秒數', () =>
  assert.equal(datetime('2026-08-01 09:30'), '2026-08-01 09:30:00'));
t('datetime: 純日期是台北午夜、不是 08:00（時區偏移 bug 的反例）', () =>
  assert.equal(datetime('2026-08-01'), '2026-08-01 00:00:00'));
t('datetime: 帶 Z 的字串是真時間點，換算成台北', () =>
  assert.equal(datetime('2026-08-01T01:30:00Z'), '2026-08-01 09:30:00'));
t('date: 後端格式只取日期部分', () =>
  assert.equal(date('2026-08-01 09:00:00'), '2026-08-01'));
t('roc: 後端格式', () =>
  assert.equal(roc('2026-08-01 09:00:00'), '民國 115 年 8 月 1 日'));
t('datetime: 時數超過 23 視為非法', () =>
  assert.equal(datetime('2026-08-01 25:00:00'), ''));
t('datetime: 分鐘超過 59 視為非法', () =>
  assert.equal(datetime('2026-08-01 09:70:00'), ''));
t('date: 台北 00:30 仍算當天（跨午夜不偏日）', () =>
  assert.equal(date('2026-08-01 00:30:00'), '2026-08-01'));
t('date: 台北 23:30 仍算當天（跨午夜不偏日）', () =>
  assert.equal(date('2026-08-01 23:30:00'), '2026-08-01'));

// ── 收尾：印出結果 ──────────────────────────────────────
if (failed > 0) {
  console.error('\n失敗清單：');
  for (const { name, err } of failures) {
    console.error(`  x ${name}`);
    console.error(`    ${err.message}`);
  }
}
console.log(`\n通過 ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
