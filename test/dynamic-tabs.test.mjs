/**
 * 動態分頁（2026-10-20）：platform/tabs.js 只收乾淨資料；門市營運 embed.js 的 navTabs 只認合格的選單訊息；manifest 合規。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeTabs, pickDynamicView, TABS_MAX } from '../platform/tabs.js';
import { navTabs } from '../modules/storeops/embed.js';
import storeops from '../modules/storeops/manifest.js';
import attendance from '../modules/attendance/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('sanitizeTabs：合格的照收，數字取整、上限 999、0 不顯示', () => {
  assert.deepEqual(sanitizeTabs([{ id: 'home', name: '首頁' }, { id: 'inventory', name: '庫存盤點', badge: 33 }, { id: 'duty', name: '出勤核定', badge: 5000, err: true }]),
    [{ id: 'home', name: '首頁', badge: 0, err: false }, { id: 'inventory', name: '庫存盤點', badge: 33, err: false }, { id: 'duty', name: '出勤核定', badge: 999, err: true }]);
});
t('sanitizeTabs：壞的項目丟掉、重複 id 只留第一個、名稱截 12 字', () => {
  const r = sanitizeTabs([null, 'x', { id: 'A', name: 'x' }, { id: 'a b', name: 'x' }, { id: '__proto__', name: 'x' }, { id: 'ok', name: '' },
    { id: 'ok', name: '一' }, { id: 'ok', name: '二' }, { id: 'long', name: '一二三四五六七八九十甲乙丙' }, { id: 'neg', name: '負', badge: -3 }, { id: 'f', name: '小數', badge: 2.5 }]);
  assert.deepEqual(r.map((x) => x.id), ['ok', 'long', 'neg', 'f']);
  assert.equal(r[0].name, '一');
  assert.equal(r[1].name.length, 12);
  assert.equal(r[2].badge, 0);
  assert.equal(r[3].badge, 0);
});
t('sanitizeTabs：不是陣列或太多 → null（殼不更新）', () => {
  assert.equal(sanitizeTabs('x'), null);
  assert.equal(sanitizeTabs(Array.from({ length: TABS_MAX + 1 }, (_, i) => ({ id: 'a' + i, name: 'x' }))), null);
  assert.deepEqual(sanitizeTabs([]), []);
});
t('pickDynamicView：網址合格優先 → 第一個分頁 → 預設', () => {
  assert.equal(pickDynamicView('duty', [{ id: 'home' }], 'main'), 'duty');
  assert.equal(pickDynamicView('Bad!', [{ id: 'home' }], 'main'), 'home');
  assert.equal(pickDynamicView(null, [], 'main'), 'main');
});
t('navTabs：只認 dzy-store-nav v1；cur 要在清單裡', () => {
  const d = { type: 'dzy-store-nav', v: 1, items: [{ id: 'home', label: '首頁' }, { id: 'inventory', label: '庫存盤點', badge: 33 }, { id: 'X', label: 'bad' }], cur: 'inventory' };
  assert.deepEqual(navTabs(d), { tabs: [{ id: 'home', name: '首頁', badge: 0, err: false }, { id: 'inventory', name: '庫存盤點', badge: 33, err: false }], cur: 'inventory' });
  assert.equal(navTabs({ ...d, cur: 'admin' }).cur, '');
  for (const bad of [null, { ...d, type: 'x' }, { ...d, v: 2 }, { ...d, items: 'x' }]) assert.equal(navTabs(bad), null);
});
t('manifest：門市營運、考勤管理都 dynamicTabs（考勤管理＝出勤核定子分頁，2026-10-20）；兩者都合規', () => {
  assert.equal(storeops.dynamicTabs, true);
  assert.equal(attendance.dynamicTabs, true);
  for (const m of [storeops, attendance]) { const r = validateManifest(m); assert.ok(r.ok !== false && !(r.errors && r.errors.length), JSON.stringify(r)); }
});
t('門市營運、考勤管理都開 tabs', () => {
  assert.match(fs.readFileSync(new URL('../modules/storeops/index.js', import.meta.url), 'utf8'), /tabs: true/);
  assert.match(fs.readFileSync(new URL('../modules/attendance/index.js', import.meta.url), 'utf8'), /tabs: true/);
});
console.log('全部通過 ' + n);
