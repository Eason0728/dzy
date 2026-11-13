// 手機「待處理」核准：營運系統回「那天已經核定過」時照常算核准成功，並把提醒交給畫面（Eason 2026-11-13 紅燈 a2 選 A）
import test from 'node:test';
import assert from 'node:assert';
import { mobileHooks } from '../modules/attendance/mobile.js';

const ctxOf = (data) => ({ api: { call: async () => ({ ok: true, data: { ok: true, data } }) } });

test('核准回 warn：ok:true，帶 warn 與 message', async () => {
  const r = await mobileHooks.decide(ctxOf({ status: 'approved', warn: 'already_approved_day', message: '11/9 已經核定過，請重新核定一次，假別才會寫進薪資' }), 'MDGF|L1', 'approve');
  assert.deepStrictEqual(r, { ok: true, warn: 'already_approved_day', message: '11/9 已經核定過，請重新核定一次，假別才會寫進薪資' });
});
test('沒有 warn：跟原本一樣只回 ok:true', async () => {
  assert.deepStrictEqual(await mobileHooks.decide(ctxOf({ status: 'approved' }), 'MDGF|L1', 'approve'), { ok: true });
});
