// 手機「待處理」審單出勤試算一行（2026-11-25 營運系統 ot-review-hint 第 7 題 A、第 4 題第 24 句）：
// 營運系統 server/mobile-requests.js 只在加班單照核定規則試算「多了」時帶 otCheck {need, n, over}；這裡給卡片一個 ot 欄位，殼另外畫一列（.m-card-ot）。
// 沒有 otCheck（營運系統開關 DUTY_REQ_OT_CHECK 關著、相符、算不出來）＝卡片資料逐字不變、殼不畫那一列、全站樣式不動。只提示，核准照常。
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { quickItem, groupCard, otLine } from '../modules/attendance/mobile.js';

const base = { store: 'MZGF', storeName: '墨竹亭光復', name: '測試甲', kind: 'ot', label: '加班', date: '2026-11-23', from: '20:00', to: '21:00', hours: 1, reason: '收店', hasAttach: false, id: 'R1' };
const L24 = '出勤試算：應有加班 0 小時，這張 1 小時（多 1 小時）';

test('第 24 句：11/23 案（應有 0、這張 1、多 1）放在 ot 欄位，原本的說明不動', () => {
  const it = quickItem({ ...base, otCheck: { need: 0, n: 1, over: 1 } });
  assert.equal(otLine({ otCheck: { need: 0, n: 1, over: 1 } }), L24);
  assert.equal(it.ot, L24);
  assert.equal(it.detail, '原因：收店');
  assert.equal(otLine({ otCheck: { need: 1.5, n: 2.25, over: 0.75 } }), '出勤試算：應有加班 1.5 小時，這張 2.25 小時（多 0.75 小時）');
});

test('沒有 otCheck／壞資料：卡片資料跟以前逐字相同（沒有 ot 欄位）', () => {
  const before = quickItem(base);
  assert.equal('ot' in before, false);
  assert.equal('gOt' in before, false);
  assert.equal(before.detail, '原因：收店');
  for (const bad of [null, {}, { need: 0, n: 1 }, { need: '0', n: 1, over: 1 }, 'x']) {
    assert.equal(otLine({ otCheck: bad }), '');
    assert.deepEqual(quickItem({ ...base, otCheck: bad }), before);
  }
});

test('一次送出兩段：組卡也只多一個 ot；沒有就沒有', () => {
  const a = quickItem({ ...base, id: 'A', group: 'g1', seg: 1, otCheck: { need: 0, n: 2, over: 2 } });
  const b = quickItem({ ...base, id: 'B', group: 'g1', seg: 2, from: '21:00', to: '22:00', otCheck: { need: 0, n: 2, over: 2 } });
  const g = groupCard([a, b]);
  assert.equal(g.detail, '原因：收店');
  assert.equal(g.ot, '出勤試算：應有加班 0 小時，這張 2 小時（多 2 小時）');
  const c = quickItem({ ...base, id: 'A', group: 'g1', seg: 1 }), d = quickItem({ ...base, id: 'B', group: 'g1', seg: 2, from: '21:00', to: '22:00' });
  assert.equal('ot' in groupCard([c, d]), false);
});

test('樣式：全站 .m-card-d 跟改版前逐字相同（不加 white-space）；試算那一行用自己的 .m-card-ot；殼只在有 ot 時才畫那一列', () => {
  const css = readFileSync(new URL('../platform/css/components.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.m-card-d { font-size: var(--fs-sm); color: var(--ink); overflow-wrap: anywhere; }\n'));
  assert.equal((css.match(/\.m-card-d\b/g) || []).length, 1, '.m-card-d 只有原本那一條規則');
  assert.match(css, /\.m-card-ot \{[^}]*\}/);
  const shell = readFileSync(new URL('../platform/shell.js', import.meta.url), 'utf8');
  assert.equal((shell.match(/\? el\('div', \{ class: 'm-card-ot', 'data-role': 'quick-ot', text: (c|view)\.ot \}\) : null/g) || []).length, 2);
  assert.ok(shell.includes("...(typeof it.ot === 'string' && it.ot ? { ot: it.ot } : {}),"));
});
