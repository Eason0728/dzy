// node test/dd/home_shell_tabs.mjs —— 首頁殼：動態分頁清洗 sanitizeTabs／pickDynamicView 隨機模糊測試
// 預期值照 platform/tabs.js 檔頭寫明的規則獨立算（不信任實作）：
//   不是陣列或超過 20 個 → null；非物件項跳過；id 要符合 ^[a-z][a-z0-9-]{0,30}$ 且不重複；
//   name 去頭尾空白、連續空白縮成一個、截 12 字、空字串跳過；badge 正整數才收、上限 999、其他 0；err 只認 === true。
// 重現：E2E_SEED=<種子> node test/dd/home_shell_tabs.mjs

'use strict';
import { sanitizeTabs, pickDynamicView, TABS_MAX, TAB_ID_RE } from '../../platform/tabs.js';

const SEED = Number(process.env.E2E_SEED) || (Date.now() % 1000000007);
console.log('SEED=' + SEED);
let rs = SEED >>> 0;
function rnd() { rs |= 0; rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
let passed = 0, failed = 0;
const J = JSON.stringify;
function ok(c, label, extra) { if (c) { passed++; } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + J(extra) : '')); } }

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
function expected(list) {
  if (!Array.isArray(list) || list.length > 20) return null;
  const out = [], seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.id !== 'string' || !ID_RE.test(t.id) || seen.has(t.id)) continue;
    const name = typeof t.name === 'string' ? t.name.replace(/\s+/g, ' ').trim().slice(0, 12) : '';
    if (!name) continue;
    const n = Number(t.badge);
    const badge = Number.isInteger(n) && n > 0 ? Math.min(n, 999) : 0;
    seen.add(t.id);
    out.push({ id: t.id, name, badge, err: t.err === true });
  }
  return out;
}
const idPool = () => pick(['review', 'a', 'z9-x', 'a'.repeat(31), 'a'.repeat(32), 'A', '9x', '-x', '', 'ok_1', 'tab' + ri(0, 3), '__proto__', 'constructor', null, 12, {}]);
const namePool = () => pick(['待核對', '  空白  ', '很長的分頁名稱超過十二個字會被截掉喔', 'a\n\tb   c', '', '   ', 7, null, undefined, '正常']);
const badgePool = () => pick([0, 1, 5, 999, 1000, 10000, -3, 2.5, '7', '  8 ', 'x', null, undefined, NaN, Infinity, true, '1e3']);
const errPool = () => pick([true, false, 'true', 1, 0, null, undefined]);
function randItem() { const r = rnd(); if (r < 0.08) return pick([null, 1, 'str', undefined, [], true]); return { id: idPool(), name: namePool(), badge: badgePool(), err: errPool() }; }

for (let i = 0; i < 400; i++) {
  const n = ri(0, 23);
  const list = rnd() < 0.05 ? pick([null, undefined, {}, 'x', 5]) : Array.from({ length: n }, randItem);
  const exp = expected(list), got = sanitizeTabs(list);
  ok(J(got) === J(exp), `sanitizeTabs 第 ${i} 組（${Array.isArray(list) ? list.length + ' 項' : typeof list}）`, { list, exp, got });
}
ok(TABS_MAX === 20 && TAB_ID_RE.source === ID_RE.source, '常數 TABS_MAX=20、TAB_ID_RE 與規則一致');
// （postMessage 來的資料經 structured clone，沒有原型鏈；不另測 own property）
// pickDynamicView：網址合格 → 網址；否則已知第一個；否則 fallback
for (let i = 0; i < 100; i++) {
  const vid = pick(['review', 'A', '', null, 7, 'x-' + ri(0, 9), 'a'.repeat(40)]);
  const tabs = rnd() < 0.3 ? [] : [{ id: 'first' + ri(0, 9) }, { id: 'second' }];
  const fb = 'fb' + ri(0, 9);
  const exp = (typeof vid === 'string' && ID_RE.test(vid)) ? vid : (tabs.length ? tabs[0].id : fb);
  ok(pickDynamicView(vid, tabs, fb) === exp, `pickDynamicView(${J(vid)})`, { tabs, fb, got: pickDynamicView(vid, tabs, fb) });
}
console.log(`SEED=${SEED}｜共 ${passed + failed} 項檢查，通過 ${passed}，失敗 ${failed}`);
if (failed) process.exit(1);
