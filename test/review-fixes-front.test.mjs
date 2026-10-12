// node test/review-fixes-front.test.mjs —— 2026-10-12 GPT 上線前複審第 2、3 條（前端）
// 第 2 條：稽核草稿 key 加使用者前綴，A 登出後 B 看不到／載不到／刪不到 A 的草稿；舊格式（無前綴）一律不載入。
// 第 3 條：離線登出（後端 logout 沒送到）→ 暫存那一個 token 到 dzy.pendingLogout，下次開頁／登入前補送，成功才刪。
// ⚠ 全部假資料。

'use strict';

class FakeStorage {
  constructor() { this._data = new Map(); }
  getItem(k) { return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(String(k), String(v)); }
  removeItem(k) { this._data.delete(k); }
  key(i) { const keys = [...this._data.keys()]; return i >= 0 && i < keys.length ? keys[i] : null; }
  get length() { return this._data.size; }
  clear() { this._data.clear(); }
  keys() { return [...this._data.keys()]; }
}
globalThis.localStorage = new FakeStorage();

const Stock = await import('../modules/audit-stock/views/fill-submit.js');
const Ops = await import('../modules/audit-ops/views/fill-submit.js');
const Auth = await import('../platform/auth.js');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const LS = globalThis.localStorage;

// ============================================================
// 第 2 條 —— 月初盤點抽查（audit-stock）草稿
// ============================================================
{
  LS.clear();
  const items = [{ name: '假品項', unit: '包', book_qty: '3', recount_qty: '2', verdict: '異常', reason: '短少', note: '' }];
  Stock.saveDraft('u010', 'sxl-gf', '2026-09', Stock.MODE_FULL, items, {});
  ok(LS.keys().length === 1 && LS.keys()[0].indexOf('dzy.u.u010.draft_') === 0, '2s-1 草稿 key 帶使用者前綴', LS.keys());
  ok(Stock.loadDraft('u010', 'sxl-gf', '2026-09', Stock.MODE_FULL) !== null, '2s-2 本人讀得到自己的草稿');
  ok(Stock.loadDraft('u020', 'sxl-gf', '2026-09', Stock.MODE_FULL) === null, '2s-3 ★換人（B）讀不到 A 的草稿');
  ok(Stock.listDrafts('u020').length === 0, '2s-4 ★B 的草稿清單沒有 A 的');
  ok(Stock.listDrafts('u010').length === 1, '2s-5 A 的草稿清單有自己的');
  ok(Stock.latestDraftForStore('u020', 'sxl-gf') === null, '2s-6 ★B 不會被帶去續填 A 的草稿');
  const aKey = Stock.listDrafts('u010')[0].key;
  ok(Stock.readDraftByKey('u020', aKey) === null, '2s-7 ★B 拿 A 的 key 也讀不到');
  Stock.dropDraft('u020', aKey);
  ok(LS.getItem(aKey) !== null, '2s-8 ★B 拿 A 的 key 刪不掉');
  Stock.clearDraft('u020', 'sxl-gf', '2026-09');
  ok(LS.getItem(aKey) !== null, '2s-9 ★B 送出同店同月時不會清掉 A 的草稿');
  // 沒有 owner（ctx.user 缺 id）→ 一律不讀不寫
  Stock.saveDraft('', 'sxl-gf', '2026-10', Stock.MODE_FULL, items, {});
  ok(LS.length === 1 && Stock.loadDraft('', 'sxl-gf', '2026-09', Stock.MODE_FULL) === null && Stock.listDrafts('').length === 0, '2s-10 沒有 owner 不寫、不讀、不列');
  // 舊格式（無前綴）：不載入、不列出、不刪（與舊站 mala-audit 同 origin、同 key）
  LS.setItem('draft_sxl-gf_2026-08', JSON.stringify({ store: 'sxl-gf', month: '2026-08', items, vault: {} }));
  LS.setItem('draft_sxl-gf_2026-08_anomaly', JSON.stringify({ store: 'sxl-gf', month: '2026-08', items, vault: {} }));
  ok(Stock.listDrafts('u010').every((d) => d.key.indexOf('draft_') !== 0) && Stock.listDrafts('u010').length === 1, '2s-11 ★舊格式草稿不列出');
  ok(Stock.loadDraft('u010', 'sxl-gf', '2026-08', Stock.MODE_FULL) === null, '2s-12 ★舊格式草稿不載入');
  ok(Stock.readDraftByKey('u010', 'draft_sxl-gf_2026-08') === null, '2s-13 ★舊格式 key 直接讀也讀不到');
  Stock.dropDraft('u010', 'draft_sxl-gf_2026-08');
  ok(LS.getItem('draft_sxl-gf_2026-08') !== null, '2s-14 舊格式草稿不刪（舊站還在用）');
  Stock.clearDraft('u010', 'sxl-gf', '2026-09');
  ok(LS.getItem(aKey) === null, '2s-15 本人送出後清掉自己的草稿');
}

// ============================================================
// 第 2 條 —— 營運稽核表（audit-ops）草稿
// ============================================================
{
  LS.clear();
  const entries = Ops.blankEntries();
  const firstId = Object.keys(entries)[0];
  entries[firstId] = { verdict: '未完成', track: true, note: 'A 寫的假說明' };
  Ops.saveDraft('u010', 'sxl-gf', '2026-09', 'A 會計', entries);
  ok(LS.keys().length === 1 && LS.keys()[0].indexOf('dzy.u.u010.ops_draft_') === 0, '2o-1 草稿 key 帶使用者前綴', LS.keys());
  const mine = Ops.loadEntriesFor('u010', 'sxl-gf', '2026-09', {});
  ok(mine.from === 'draft' && mine.auditor === 'A 會計', '2o-2 本人載得到自己的草稿');
  const other = Ops.loadEntriesFor('u020', 'sxl-gf', '2026-09', {});
  ok(other.from === 'new' && other.auditor === '' && JSON.stringify(other).indexOf('A 寫的假說明') === -1, '2o-3 ★B 載不到 A 的草稿（看到空白表）', other);
  ok(Ops.listDrafts('u020').length === 0 && Ops.listDrafts('u010').length === 1, '2o-4 ★B 的草稿清單沒有 A 的');
  const rk = Ops.listDrafts('u010')[0].record_key;
  Ops.clearDraft('u020', rk);
  ok(Ops.loadDraft('u010', rk) !== null, '2o-5 ★B 清不掉 A 的草稿');
  Ops.saveDraft('', 'sxl-gf', '2026-10', 'x', entries);
  ok(LS.length === 1 && Ops.listDrafts('').length === 0 && Ops.loadDraft('', rk) === null, '2o-6 沒有 owner 不寫、不讀、不列');
  LS.setItem('ops_draft_' + rk, JSON.stringify({ store: 'sxl-gf', month: '2026-09', auditor: '舊站', entries }));
  ok(Ops.listDrafts('u020').length === 0, '2o-7 ★舊格式草稿不列出');
  ok(Ops.loadEntriesFor('u020', 'sxl-gf', '2026-09', {}).from === 'new', '2o-8 ★舊格式草稿不載入');
  ok(LS.getItem('ops_draft_' + rk) !== null, '2o-9 舊格式草稿不刪（舊站還在用）');
  // 兩個模組的前綴不互相誤認
  ok(!Ops.ownerPrefix('u010').startsWith('draft_') && Stock.listDrafts('u010').length === 0, '2o-10 營運稽核草稿不會出現在盤點抽查的清單');
}

// ============================================================
// 第 3 條 —— 離線登出補送
// ============================================================
const PENDING = Auth.PENDING_LOGOUT_KEY;
async function loginAs(token) {
  Auth.__setTransport(async (req) => (req.action === 'login'
    ? { ok: true, data: { token, user: { id: 'u010', name: '假', role: 'accountant', node: '' }, perms: [] } }
    : { ok: true, data: {} }));
  const r = await Auth.login('acc1', 'fake-pw-0001');
  if (!r.ok) throw new Error('login 失敗');
}

{
  LS.clear();
  ok(PENDING === 'dzy.pendingLogout', '3-0 key 名稱是 dzy.pendingLogout');

  // a. 後端成功 → 不留 pending
  await loginAs('TOK-A');
  Auth.__setTransport(async () => ({ ok: true, data: {} }));
  await Auth.logout();
  ok(LS.getItem(PENDING) === null && LS.getItem('dzy.token') === null, '3a 後端登出成功 → 不留 pending、本機 token 清掉');

  // b. 斷網（transport 回連線失敗）→ 存那一個 token
  await loginAs('TOK-B');
  Auth.__setTransport(async () => ({ ok: false, error: '連線失敗，請檢查網路' }));
  await Auth.logout();
  ok(LS.getItem(PENDING) === 'TOK-B' && LS.getItem('dzy.token') === null, '3b ★離線登出 → pending 存舊 token、本機仍清掉', LS.keys());
  ok(LS.keys().filter((k) => k !== PENDING).length === 0, '3b pending 之外沒有存其他東西');

  // c. transport 丟錯 → 也存
  LS.clear();
  await loginAs('TOK-C');
  Auth.__setTransport(async () => { throw new Error('boom'); });
  await Auth.logout();
  ok(LS.getItem(PENDING) === 'TOK-C', '3c transport 丟錯 → 存 pending');

  // d. 後端明確說 token 已失效 → 不存（再送也沒用）
  LS.clear();
  await loginAs('TOK-D');
  Auth.__setTransport(async () => ({ ok: false, error: '登入已失效，請重新登入' }));
  await Auth.logout();
  ok(LS.getItem(PENDING) === null, '3d 後端回「登入已失效」→ 不存 pending');

  // e. 開頁 restore：背景補送，失敗留著
  LS.clear();
  LS.setItem(PENDING, 'TOK-E');
  let sent = [];
  Auth.__setTransport(async (req) => { sent.push([req.action, req.token]); return { ok: false, error: '連線逾時，請稍後再試' }; });
  await Auth.restore();
  ok(await Auth.__lastFlush() === false && LS.getItem(PENDING) === 'TOK-E', '3e ★補送失敗 → pending 留著', sent);
  ok(sent.some(([a, t]) => a === 'logout' && t === 'TOK-E'), '3e 開頁有用舊 token 補送 logout', sent);

  // f. 再開頁，後端成功 → 刪掉
  sent = [];
  Auth.__setTransport(async (req) => { sent.push([req.action, req.token]); return { ok: true, data: {} }; });
  await Auth.restore();
  ok(await Auth.__lastFlush() === true && LS.getItem(PENDING) === null, '3f ★補送成功 → pending 刪掉', sent);

  // g. 登入前先補送（否則補送會把新 token 一起撤掉）
  LS.setItem(PENDING, 'TOK-G');
  const order = [];
  Auth.__setTransport(async (req) => {
    order.push(req.action + ':' + req.token);
    return req.action === 'login'
      ? { ok: true, data: { token: 'TOK-NEW', user: { id: 'u010', name: '假', role: 'accountant', node: '' }, perms: [] } }
      : { ok: true, data: {} };
  });
  await Auth.login('acc1', 'fake-pw-0001');
  ok(order.join() === 'logout:TOK-G,login:', '3g ★登入前先補送舊 token 的 logout', order);
  ok(LS.getItem(PENDING) === null && LS.getItem('dzy.token') === 'TOK-NEW', '3g 補送成功刪 pending、新 token 存好');

  // h. 後端逾時（5 秒）→ 存 pending
  Auth.__setTransport(() => new Promise(() => {}));
  const t0 = Date.now();
  await Auth.logout();
  ok(LS.getItem(PENDING) === 'TOK-NEW' && Date.now() - t0 < 7000, '3h 後端 5 秒沒回 → 存 pending、照樣清本機', Date.now() - t0);
  Auth.__setTransport(null);
}

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
