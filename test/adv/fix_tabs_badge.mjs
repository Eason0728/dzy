// node test/adv/fix_tabs_badge.mjs —— 對抗驗證 ②「頁頂分頁 badge 只收數字」
// 四個 embed 的 navTabs 是第一層；殼層 platform/tabs.js sanitizeTabs 是第二層（ctx.tabs(list) 進來一律過它）。
// 攻擊：布林 true／字串 '3'／小數／負數／Infinity 分別餵兩層，兩層都該「只收數字」。
'use strict';
import { sanitizeTabs } from '../../platform/tabs.js';
import { navTabs as storeNav } from '../../modules/storeops/embed.js';
import { navTabs as attNav } from '../../modules/attendance/embed.js';
import { navTabs as schNav } from '../../modules/schedule/embed.js';
import { navTabs as purNav } from '../../modules/purchase/embed.js';

let failed = 0, passed = 0;
const J = JSON.stringify;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + J(extra) : '')); } }

const CASES = [
  [true, 0, '布林 true → 0（不是 1）'],
  [false, 0, '布林 false → 0'],
  ['3', 0, "字串 '3' → 0（只收 number；若營運系統改送字串會變 0，見疑慮）"],
  [3.9, 3, '小數 3.9 → 3'],
  [-2, 0, '負數 → 0'],
  [Infinity, 0, 'Infinity → 0'],
  [NaN, 0, 'NaN → 0'],
  [7, 7, '整數 7 → 7']
];

// 第一層：四個 embed
const EMBEDS = [['storeops', storeNav, 'dzy-store-nav'], ['attendance', attNav, 'dzy-store-nav'], ['schedule', schNav, 'dzy-store-nav'], ['purchase', purNav, 'dzy-purchase-nav']];
for (const [name, fn, type] of EMBEDS) {
  for (const [input, want, label] of CASES) {
    const r = fn({ type, v: 1, items: [{ id: 'a', label: 'A', badge: input }], cur: 'a' });
    ok(r && r.tabs[0] && r.tabs[0].badge === want, `${name} navTabs：${label}`, r);
  }
}

// 第二層：殼 sanitizeTabs（模組若直接 ctx.tabs() 把 iframe 資料丟進來，就只剩這層守）
for (const [input, want, label] of CASES) {
  const r = sanitizeTabs([{ id: 'a', name: 'A', badge: input }]);
  ok(r && r[0] && r[0].badge === want, `殼 sanitizeTabs：${label}`, r);
}

console.log(`fix_tabs_badge: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
