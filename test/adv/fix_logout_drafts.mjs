// node test/adv/fix_logout_drafts.mjs —— 對抗驗證 ⑭「登出清 dzy.u.<id>.apv_draft_*」
// 攻擊：前綴相近的 id（12 vs 123 vs 1）、別人的草稿、稽核草稿 draft_／ops_draft_、沒有 id、storage 會丟錯。
// 另外用 approvals lib 的 draftKey 直接對照：purge 用的前綴必須跟寫入端同一條字串，不然清不到。
'use strict';
import { purgeLogoutDrafts } from '../../platform/auth.js';
import { draftKey, saveDraft, loadDraft } from '../../modules/approvals/lib.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

function mem() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i]; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    keys() { return Array.from(m.keys()).sort(); }
  };
}

// 1. 前綴相近：清 12 不能動到 1、123、1234
{
  const s = mem();
  for (const id of ['1', '12', '123', '1234']) { saveDraft(s, id, 'purchase', { purpose: id }); saveDraft(s, id, 'expense', { purpose: id }); }
  const n = purgeLogoutDrafts(s, '12');
  ok(n === 2, 'id=12 清掉 2 筆', n);
  ok(loadDraft(s, '12', 'purchase') === null && loadDraft(s, '12', 'expense') === null, '12 的兩筆都沒了');
  ok(loadDraft(s, '1', 'purchase') && loadDraft(s, '123', 'purchase') && loadDraft(s, '1234', 'expense'), '1／123／1234 完整保留', s.keys());
}
// 2. 稽核草稿（draft_／ops_draft_）與其他 dzy.u.<id>.* 不動
{
  const s = mem();
  s.setItem('dzy.u.u-acct.draft_sxl-gf_2026-10', '{}');
  s.setItem('dzy.u.u-acct.ops_draft_sxl-gf_2026-10', '{}');
  s.setItem('dzy.u.u-acct.something_else', '{}');
  s.setItem('dzy.token', 't');
  saveDraft(s, 'u-acct', 'purchase', { a: 1 });
  const n = purgeLogoutDrafts(s, 'u-acct');
  ok(n === 1, '只清 apv_draft 一筆', n);
  ok(s.keys().length === 4 && s.getItem('dzy.u.u-acct.draft_sxl-gf_2026-10') && s.getItem('dzy.u.u-acct.ops_draft_sxl-gf_2026-10'), '稽核草稿／token／其他 key 都還在', s.keys());
}
// 3. 數字 id 與字串 id 同一條 key（ctx.user.id 可能是 number）
{
  const s = mem();
  saveDraft(s, 7, 'purchase', { a: 1 });
  ok(s.getItem(draftKey('7', 'purchase')) !== null, 'draftKey(7) === draftKey("7")');
  ok(purgeLogoutDrafts(s, 7) === 1 && s.keys().length === 0, '數字 id 也清得到');
}
// 4. 沒 id／storage 壞掉 → 0、不丟錯
{
  const s = mem(); saveDraft(s, 'x', 'purchase', { a: 1 });
  ok(purgeLogoutDrafts(s, '') === 0 && purgeLogoutDrafts(s, null) === 0 && purgeLogoutDrafts(null, 'x') === 0 && s.keys().length === 1, '沒 id／沒 storage 不清、不丟錯');
  const bad = { get length() { throw new Error('locked'); }, key() { return null; }, removeItem() {} };
  ok(purgeLogoutDrafts(bad, 'x') === 0, 'storage 丟錯 → 0');
}
// 5. 與 encodeURIComponent 無關：approvals 寫入端不編碼 id，purge 也不編碼 → id 含特殊字一致
{
  const s = mem();
  saveDraft(s, 'a b/c', 'purchase', { a: 1 });
  ok(purgeLogoutDrafts(s, 'a b/c') === 1, 'id 含空白／斜線：寫入端與 purge 同一條 key');
}

console.log(`fix_logout_drafts: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
