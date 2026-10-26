/**
 * 調撥管理模組（2026-10-24）：轉接只收合格的呼叫、絕不轉送密碼欄位、回傳還原成會計頁認得的扁平形狀；manifest 合規。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCall, toPageResult, transferTarget, TRANSFER_ORIGIN, TRANSFER_PAGES, navMessage } from '../modules/transfer-fin/bridge.js';
import manifest from '../modules/transfer-fin/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('合格呼叫：刪掉 pin_master／token／operator／action，其餘照帶', () => {
  const c = parseCall({ type: 'dzy-transfer-call', v: 1, id: 'c1_x', action: 'buildMonthlyReport', payload: { ym: '2026-09', pin_master: 'X', token: 'T', operator: 'me', action: 'adminUpdate' } });
  assert.deepEqual(c, { id: 'c1_x', action: 'buildMonthlyReport', payload: { ym: '2026-09' } });
});
t('不合格一律忽略', () => {
  const base = { type: 'dzy-transfer-call', v: 1, id: 'c1', action: 'bootstrap', payload: {} };
  for (const bad of [null, 'x', { ...base, type: 'dzy-payroll-call' }, { ...base, v: 2 }, { ...base, id: '' }, { ...base, id: '<script>' },
    { ...base, action: '' }, { ...base, action: 'bootstrap;drop' }, { ...base, action: 'a b' }, { ...base, payload: [1] }, { ...base, payload: 'x' }]) {
    assert.equal(parseCall(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseCall({ ...base, payload: undefined }).payload, {});
});
t('成功：還原成調撥後端原本的 {ok:true,data}', () => {
  assert.deepEqual(toPageResult({ ok: true, data: { data: { nodes: [1] } } }), { ok: true, data: { nodes: [1] } });
  assert.deepEqual(toPageResult({ ok: true, data: { data: [1, 2] } }), { ok: true, data: [1, 2] });
  assert.deepEqual(toPageResult({ ok: true, data: {} }), { ok: true, data: null });
});
t('上游錯誤：保留 error 與 code', () => {
  assert.deepEqual(toPageResult({ ok: false, error: '密碼錯誤', data: { code: 'BAD_PIN' } }), { ok: false, error: '密碼錯誤', code: 'BAD_PIN' });
});
t('代轉層錯誤（沒權限、逾時）：只有 error', () => {
  assert.deepEqual(toPageResult({ ok: false, error: '沒有權限', status: 403 }), { ok: false, error: '沒有權限' });
  assert.equal(toPageResult(null).ok, false);
});
t('試跑模式攔下的寫入：回失敗，不當成功', () => {
  assert.deepEqual(toPageResult({ ok: true, dryrun: true, data: { dryRun: true, action: 'buildMonthlyReport' } }), { ok: false, error: '試跑模式，未寫入', code: 'DRYRUN' });
});
t('網址：正式＝eason0728.github.io/mala-transfer；本機＝8787', () => {
  assert.deepEqual(transferTarget('dzy.mozhuting.com'), { origin: TRANSFER_ORIGIN, url: 'https://eason0728.github.io/mala-transfer/report.html?embed=dzy' });
  assert.deepEqual(transferTarget('localhost'), { origin: 'http://localhost:8787', url: 'http://localhost:8787/report.html?embed=dzy' });
  assert.deepEqual(transferTarget('127.0.0.1'), { origin: 'http://127.0.0.1:8787', url: 'http://127.0.0.1:8787/report.html?embed=dzy' });
});
t('manifest：財務部門、只認 transfer.write、backend＝ns、圖示存在', () => {
  const r = validateManifest(manifest);
  assert.equal(r.ok !== false && !(r.errors && r.errors.length), true, JSON.stringify(r));
  assert.equal(manifest.id, 'transfer-fin');
  assert.equal(manifest.dept, 'fin');
  assert.equal(manifest.ns, 'transfer');
  assert.equal(manifest.backend, 'transfer');
  assert.deepEqual(manifest.requires, ['transfer.write']);
  assert.equal(manifest.keepAlive, 30 * 60 * 1000);
  assert.ok(fs.existsSync(new URL('../assets/icons/transfer.png', import.meta.url)), '選單圖示存在');
});
t('模組程式裡沒有任何密碼／後端網址樣子的字串', () => {
  for (const f of ['manifest.js', 'bridge.js', 'index.js']) {
    const src = fs.readFileSync(new URL('../modules/transfer-fin/' + f, import.meta.url), 'utf8');
    assert.ok(!/pin_master\s*[:=]\s*['"][^'"]/.test(src), f);
    assert.ok(!/AKfycb/.test(src), f + ' 不寫後端網址');
  }
});
t('分頁：manifest views＝TRANSFER_PAGES，全部只認 transfer.write', () => {
  assert.deepEqual(manifest.views.map((v) => [v.id, v.name]), TRANSFER_PAGES);
  assert.deepEqual(TRANSFER_PAGES.map((x) => x[0]), ['report', 'memory', 'overview']);
  for (const v of manifest.views) assert.deepEqual(v.requires, ['transfer.write']);
});
t('切換訊息：認得的分頁照送，其他一律回月報', () => {
  assert.deepEqual(navMessage('memory'), { type: 'dzy-transfer-nav', v: 1, p: 'memory' });
  for (const bad of [null, undefined, 'main', '', 'x;y', '__proto__']) assert.equal(navMessage(bad).p, 'report');
});

console.log('\n全部通過，共 ' + n + ' 項');
