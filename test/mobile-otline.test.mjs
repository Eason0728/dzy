// 手機「待處理」審單出勤試算一行（2026-11-25 營運系統 ot-review-hint 第 7 題 A、第 4 題第 24 句）：
// 營運系統 server/mobile-requests.js 只在加班單照核定規則試算「多了」時帶 otCheck {need, n, over}；這裡只多一行，核准照常。
// 沒有 otCheck（營運系統開關 DUTY_REQ_OT_CHECK 關著、相符、估不出來）＝卡片跟以前逐字相同。期望字句逐字照確認頁。
import test from 'node:test';
import assert from 'node:assert';
import { quickItem, groupCard, otLine } from '../modules/attendance/mobile.js';

const base = { store: 'MZGF', storeName: '墨竹亭光復', name: '測試甲', kind: 'ot', label: '加班', date: '2026-11-23', from: '20:00', to: '21:00', hours: 1, reason: '收店', hasAttach: false, id: 'R1' };
const L24 = '出勤試算：應有加班 0 小時，這張 1 小時（多 1 小時）';

test('第 24 句：11/23 案（應有 0、這張 1、多 1）原因下面另起一行', () => {
  const it = quickItem({ ...base, otCheck: { need: 0, n: 1, over: 1 } });
  assert.equal(otLine({ otCheck: { need: 0, n: 1, over: 1 } }), L24);
  assert.equal(it.detail, '原因：收店\n' + L24);
  assert.equal(quickItem({ ...base, reason: '', otCheck: { need: 0, n: 1, over: 1 } }).detail, L24);
  assert.equal(otLine({ otCheck: { need: 1.5, n: 2.25, over: 0.75 } }), '出勤試算：應有加班 1.5 小時，這張 2.25 小時（多 0.75 小時）');
});

test('沒有 otCheck／壞資料：卡片跟以前逐字相同（開關關著）', () => {
  const before = quickItem(base);
  assert.deepEqual(Object.keys(before).includes('gOt'), false);
  assert.equal(before.detail, '原因：收店');
  for (const bad of [null, {}, { need: 0, n: 1 }, { need: '0', n: 1, over: 1 }, 'x']) {
    assert.equal(otLine({ otCheck: bad }), '');
    assert.deepEqual(quickItem({ ...base, otCheck: bad }), before);
  }
});

test('一次送出兩段：組卡也只多一行', () => {
  const a = quickItem({ ...base, id: 'A', group: 'g1', seg: 1, otCheck: { need: 0, n: 2, over: 2 } });
  const b = quickItem({ ...base, id: 'B', group: 'g1', seg: 2, from: '21:00', to: '22:00', otCheck: { need: 0, n: 2, over: 2 } });
  assert.equal(groupCard([a, b]).detail, '原因：收店\n出勤試算：應有加班 0 小時，這張 2 小時（多 2 小時）');
  const c = quickItem({ ...base, id: 'A', group: 'g1', seg: 1 }), d = quickItem({ ...base, id: 'B', group: 'g1', seg: 2, from: '21:00', to: '22:00' });
  assert.equal(groupCard([c, d]).detail, '原因：收店');
});
