/**
 * 損益系統模組（2026-10-24）：轉接只收白名單 action、絕不轉送金鑰／身分欄位、回傳還原成損益網頁的 {ok,data} 形狀；
 * manifest 合規、分頁與 bridge 一致、白名單與 dryrun／Auth.gs 一致、首頁提醒文字。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCall, toPageResult, pnlTarget, PNL_ORIGIN, PNL_PAGES, PNL_ACTIONS, navMessage, atPage, currentMonth, buildAlerts } from '../modules/pnl/bridge.js';
import manifest from '../modules/pnl/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { READ_ACTIONS, WRITE_ACTIONS } from '../platform/dryrun.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('合格呼叫：丟掉 action／token／key／operator／level／inner，其餘照帶', () => {
  const c = parseCall({ type: 'dzy-pnl-call', v: 1, id: 'c1_x', action: 'getMonth',
    body: { store_id: 'S01', month: '2026-10', client_id: 'abc', token: 'T', key: 'K', operator: 'X', level: 'admin', inner: 'saveSettings', action: 'finalize' } });
  assert.deepEqual(c, { id: 'c1_x', action: 'getMonth', payload: { store_id: 'S01', month: '2026-10', client_id: 'abc' } });
});
t('不合格一律忽略（含不在白名單的 login／createInvite／logout）', () => {
  const base = { type: 'dzy-pnl-call', v: 1, id: 'c1', action: 'getMonth', body: {} };
  for (const bad of [null, 'x', { ...base, type: 'dzy-payroll-call' }, { ...base, v: 2 }, { ...base, id: '' }, { ...base, id: '<x>' },
    { ...base, action: 'login' }, { ...base, action: 'createInvite' }, { ...base, action: 'logout' }, { ...base, action: 'changeMyPasscode' },
    { ...base, action: 'dzyProxy' }, { ...base, body: [1] }, { ...base, body: 'x' }]) {
    assert.equal(parseCall(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseCall({ ...base, body: undefined }).payload, {});
});
t('成功：取損益後端的內層 data', () => {
  assert.deepEqual(toPageResult({ ok: true, data: { data: { stores: [1] } } }), { ok: true, data: { stores: [1] } });
  assert.deepEqual(toPageResult({ ok: true, data: {} }), { ok: true, data: null });
});
t('損益後端錯誤：碼原樣、訊息用後端的中文', () => {
  assert.deepEqual(toPageResult({ ok: false, error: 'FORBIDDEN', data: { message: '沒有權限' } }), { ok: false, error: 'FORBIDDEN', message: '沒有權限' });
  assert.deepEqual(toPageResult({ ok: false, error: 'LOCKED' }), { ok: false, error: 'LOCKED', message: 'LOCKED' });
});
t('代轉層錯誤：401→AUTH、其他→BUSY；試跑攔下的寫入不當成功', () => {
  assert.deepEqual(toPageResult({ ok: false, error: '登入已過期', status: 401 }), { ok: false, error: 'AUTH', message: '登入已過期' });
  assert.deepEqual(toPageResult({ ok: false, error: '沒有權限', status: 403 }), { ok: false, error: 'BUSY', message: '沒有權限' });
  assert.deepEqual(toPageResult({ ok: false, error: '網路連線失敗' }), { ok: false, error: 'BUSY', message: '網路連線失敗' });
  assert.equal(toPageResult({ ok: true, dryrun: true, data: { dryRun: true } }).ok, false);
  assert.equal(toPageResult(null).ok, false);
});
t('網址：正式＝mala-pnl.github.io；本機＝8912', () => {
  assert.deepEqual(pnlTarget('dzy.mozhuting.com'), { origin: PNL_ORIGIN, url: 'https://mala-pnl.github.io/?embed=dzy' });
  assert.equal(pnlTarget('localhost').origin, 'http://localhost:8912');
  assert.equal(pnlTarget('127.0.0.1').origin, 'http://localhost:8912');
});
t('manifest：財務部門、backend＝ns、keepAlive 30 分鐘、驗證通過', () => {
  const r = validateManifest(manifest);
  assert.ok(r.ok !== false && !(r.errors && r.errors.length), JSON.stringify(r));
  assert.equal(manifest.dept, 'fin');
  assert.equal(manifest.ns, 'pnl');
  assert.equal(manifest.backend, 'pnl');
  assert.equal(manifest.name, '損益系統');
  assert.equal(manifest.keepAlive, 30 * 60 * 1000);
  assert.deepEqual(manifest.requires, ['pnl.read', 'pnl.write', 'pnl.admin']);
});
t('分頁：manifest.views 與 PNL_PAGES 一致；看級只剩儀表板、設定只給管', () => {
  assert.deepEqual(manifest.views.map((v) => [v.id, v.name]), PNL_PAGES);
  const canSee = (perm) => manifest.views.filter((v) => v.requires.includes(perm)).map((v) => v.id);
  assert.deepEqual(canSee('pnl.read'), ['dashboard']);
  assert.ok(!canSee('pnl.write').includes('settings'));
  assert.equal(canSee('pnl.admin').length, 9);
  assert.equal(navMessage('food').p, 'food');
  assert.equal(navMessage('nope').p, 'dashboard');
});
t('白名單：bridge PNL_ACTIONS ＝ dryrun 讀＋寫；Auth.gs 兩份清單與 dryrun 逐字一致', () => {
  assert.deepEqual(PNL_ACTIONS.slice().sort(), READ_ACTIONS.pnl.concat(WRITE_ACTIONS.pnl).sort());
  const gs = fs.readFileSync(new URL('../apps-script/platform/Auth.gs', import.meta.url), 'utf8');
  const grab = (name) => {
    const block = gs.slice(gs.indexOf('var ' + name + ' = {'));
    const m = block.match(/\n  pnl: (\[[\s\S]*?\])/);
    return JSON.parse(m[1].replace(/'/g, '"'));
  };
  assert.deepEqual(grab('PROXY_READ_ACTIONS'), READ_ACTIONS.pnl);
  assert.deepEqual(grab('PROXY_WRITE_ACTIONS'), WRITE_ACTIONS.pnl);
});
t('損益網頁那邊認得的頁名（embedGo_）＝PNL_PAGES：dashboard／import／settings＋待補 pending＋五類', () => {
  const ids = PNL_PAGES.map((x) => x[0]);
  assert.deepEqual(ids, ['dashboard', 'pending', 'food', 'labor', 'controllable', 'uncontrollable', 'revenue', 'import', 'settings']);
});
t('首頁提醒：只列有待補的店，文字含店名與月份', () => {
  assert.equal(currentMonth(Date.UTC(2026, 9, 31, 17, 0)), '2026-11');   // 台北 11/1 01:00
  assert.deepEqual(buildAlerts([{ store_id: 'S01', name: '新竹光復', count: 2 }, { store_id: 'S02', name: '台中美村', count: 0 }], '2026-10'),
    [{ level: 'warn', text: '新竹光復 10 月損益還有 2 項待補', view: 'pending', params: { store: 'S01' } }]);
});
t('損益頁回報所在頁：只認合格訊息與已知頁名', () => {
  assert.equal(atPage({ type: 'dzy-pnl-at', v: 1, p: 'labor' }), 'labor');
  for (const bad of [null, { type: 'dzy-pnl-at', v: 2, p: 'labor' }, { type: 'dzy-pnl-at', v: 1, p: 'evil' }, { type: 'x', v: 1, p: 'labor' }, { type: 'dzy-pnl-at', v: 1 }]) {
    assert.equal(atPage(bad), null, JSON.stringify(bad));
  }
});
console.log(`pnl-module：${n} 項全部通過`);
