// 手機「待處理」一次填兩段（2026-11-18）：quickItem 帶 group、groupCard 組標題與兩段各一列、decideGroup 依序送兩次既有核准動作
import test from 'node:test';
import assert from 'node:assert';
import { quickItem, groupCard, mobileHooks } from '../modules/attendance/mobile.js';

const base = { store: 'MDGF', storeName: '墨竹亭金山', name: '林小美', kind: 'ot', label: '加班', date: '2026-11-15', reason: '假日來客多', hasAttach: false };
const seg1 = { ...base, id: 'O1', from: '11:00', to: '14:00', hours: 3, group: 'gAB12', seg: 1 };
const seg2 = { ...base, id: 'O2', from: '17:00', to: '21:00', hours: 4, group: 'gAB12', seg: 2 };

test('quickItem：兩張同一次送出的單 group 鍵一樣（店|組別|姓名|日期）；沒有 group／舊資料＝空字串，其餘欄位跟以前一樣', () => {
  const a = quickItem(seg1), b = quickItem(seg2);
  assert.equal(a.group, 'MDGF|gAB12|林小美|2026-11-15');
  assert.equal(a.group, b.group);
  assert.equal(a.id, 'MDGF|O1');
  assert.equal(a.text, '林小美 加班 3 小時');
  assert.equal(a.sub, '2026-11-15 11:00–14:00・墨竹亭金山');
  assert.equal(a.detail, '原因：假日來客多');
  const single = quickItem({ ...base, id: 'O9', from: '11:00', to: '12:00', hours: 1 });
  assert.equal(single.group, '');
  assert.equal(single.gSeg, 0);
  assert.equal(quickItem({ ...base, id: 'O9', group: '', seg: null }).group, '');
});

test('quickItem：同組但不同人／不同日／不同店 → 鍵不同（四個都一樣才併）', () => {
  const k = (x) => quickItem({ ...seg1, ...x }).group;
  assert.notEqual(k({}), k({ name: '王大明' }));
  assert.notEqual(k({}), k({ date: '2026-11-16' }));
  assert.notEqual(k({}), k({ store: 'MDJS' }));
});

test('groupCard：標題「姓名 加班兩段 共 7 小時」，兩段各一列，依第幾段排（打亂順序也對）', () => {
  const v = groupCard([quickItem(seg2), quickItem(seg1)]);
  assert.equal(v.text, '林小美 加班兩段 共 7 小時');
  assert.equal(v.sub, '2026-11-15・墨竹亭金山');
  assert.equal(v.detail, '原因：假日來客多');
  assert.deepEqual(v.segs, [
    { id: 'MDGF|O1', tag: '第 1 段', text: '11:00–14:00　3 小時' },
    { id: 'MDGF|O2', tag: '第 2 段', text: '17:00–21:00　4 小時' }
  ]);
});

test('groupCard：沒有 seg 就依開始時間排；小時數缺一張就不寫「共」；請假用假別名；有附證明提醒', () => {
  const a = quickItem({ ...seg2, seg: null, label: '病假', kind: 'leave', hasAttach: true }), b = quickItem({ ...seg1, seg: null, label: '病假', kind: 'leave', hours: undefined });
  const v = groupCard([a, b]);
  assert.equal(v.text, '林小美 病假兩段');
  assert.deepEqual(v.segs.map((x) => x.id), ['MDGF|O1', 'MDGF|O2']);
  assert.equal(v.segs[0].text, '11:00–14:00');
  assert.equal(v.detail, '原因：假日來客多　有附證明（到考勤管理看）');
});

const ctxOf = (log, failIds = []) => ({
  api: {
    call: async (ns, action, p) => {
      log.push({ ns, action, ...p });
      if (failIds.includes(p.id)) return { ok: true, data: { ok: true, data: { ok: false, error: '系統忙碌，請再按一次' } } };
      return { ok: true, data: { ok: true, data: { status: 'approved' } } };
    }
  }
});

test('decideGroup：兩張都成功 → 依序送兩次既有的 reqDecide（approve），不新增動作', async () => {
  const log = [];
  const r = await mobileHooks.decideGroup(ctxOf(log), ['MDGF|O1', 'MDGF|O2']);
  assert.deepEqual(r, { results: [{ id: 'MDGF|O1', ok: true }, { id: 'MDGF|O2', ok: true }] });
  assert.deepEqual(log, [
    { ns: 'attendance', action: 'reqDecide', store: 'MDGF', id: 'O1', decision: 'approve', reason: '' },
    { ns: 'attendance', action: 'reqDecide', store: 'MDGF', id: 'O2', decision: 'approve', reason: '' }
  ]);
});

test('decideGroup：第二張失敗 → 第一張成功照實回報，第二張帶原因（沒有退回第一張）', async () => {
  const log = [];
  const r = await mobileHooks.decideGroup(ctxOf(log, ['O2']), ['MDGF|O1', 'MDGF|O2']);
  assert.deepEqual(r.results, [{ id: 'MDGF|O1', ok: true }, { id: 'MDGF|O2', ok: false, error: '系統忙碌，請再按一次' }]);
  assert.equal(log.length, 2);
  assert.ok(log.every((x) => x.decision === 'approve'), '沒有任何退回');
});

test('decideGroup：第一張失敗 → 停，第二張不送', async () => {
  const log = [];
  const r = await mobileHooks.decideGroup(ctxOf(log, ['O1']), ['MDGF|O1', 'MDGF|O2']);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, false);
  assert.equal(log.length, 1, '後面的不送');
});

test('decideGroup：丟錯（斷線）當失敗；回應帶 warn 的那張照常算成功並帶提醒；壞的 id 不送', async () => {
  const boom = { api: { call: async () => { throw new Error('network'); } } };
  const r1 = await mobileHooks.decideGroup(boom, ['MDGF|O1', 'MDGF|O2']);
  assert.deepEqual(r1.results, [{ id: 'MDGF|O1', ok: false, error: '送出失敗，請稍後再試' }]);
  const warnCtx = { api: { call: async () => ({ ok: true, data: { ok: true, data: { status: 'approved', warn: 'already_approved_day', message: '11/15 已經核定過，請重新核定一次' } } }) } };
  const r2 = await mobileHooks.decideGroup(warnCtx, ['MDGF|O1', 'MDGF|O2']);
  assert.equal(r2.results.length, 2);
  assert.deepEqual(r2.results[0], { id: 'MDGF|O1', ok: true, warn: 'already_approved_day', message: '11/15 已經核定過，請重新核定一次' });
  const log = [];
  const r3 = await mobileHooks.decideGroup(ctxOf(log), ['bad-id']);
  assert.equal(r3.results[0].ok, false);
  assert.equal(log.length, 0);
});

test('decide（單張）行為沒變：approve／reject 送出同樣的欄位', async () => {
  const log = [];
  assert.deepEqual(await mobileHooks.decide(ctxOf(log), 'MDGF|R1', 'reject', '人力夠'), { ok: true });
  assert.deepEqual(log, [{ ns: 'attendance', action: 'reqDecide', store: 'MDGF', id: 'R1', decision: 'reject', reason: '人力夠' }]);
  assert.equal((await mobileHooks.decide(ctxOf([]), 'nobar', 'approve')).ok, false);
});
