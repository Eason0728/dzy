/**
 * 薪酬管理模組（2026-10-19）：轉接只收合格的呼叫、絕不轉送金鑰欄位、回傳還原成薪酬頁認得的扁平形狀；manifest 合規。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCall, toPageResult, payrollTarget, PAYROLL_ORIGIN, PAYROLL_PAGES, navMessage } from '../modules/payroll/bridge.js';
import manifest from '../modules/payroll/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('合格呼叫：刪掉 admin_key／token／action，其餘照帶', () => {
  const c = parseCall({ type: 'dzy-payroll-call', v: 1, id: 'c1_x', action: 'payroll_month', body: { store: 'CF', ym: '2026-09', admin_key: 'X', token: 'T', action: 'payroll_calc' } });
  assert.deepEqual(c, { id: 'c1_x', action: 'payroll_month', payload: { store: 'CF', ym: '2026-09' } });
});
t('不合格一律忽略', () => {
  const base = { type: 'dzy-payroll-call', v: 1, id: 'c1', action: 'payroll_month', body: {} };
  for (const bad of [null, 'x', { ...base, type: 'x' }, { ...base, v: 2 }, { ...base, id: '' }, { ...base, id: '<script>' },
    { ...base, action: 'login' }, { ...base, action: 'payroll_month;drop' }, { ...base, action: 'PAYROLL_MONTH' }, { ...base, body: [1] }, { ...base, body: 'x' }]) {
    assert.equal(parseCall(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseCall({ ...base, body: undefined }).payload, {});
});
t('成功：data 攤平＋ok:true', () => {
  assert.deepEqual(toPageResult({ ok: true, data: { master: [1], ok: false } }), { master: [1], ok: true });
});
t('上游錯誤：保留 error／message 與其他欄位', () => {
  assert.deepEqual(toPageResult({ ok: false, error: 'locked', data: { message: '本月已鎖定', ym: '2026-09' } }), { message: '本月已鎖定', ym: '2026-09', ok: false, error: 'locked' });
});
t('試跑模式（平台攔下寫入，回 ok:true＋dryrun）→ 薪酬頁收到失敗＋中文提示，不會以為存好了（2026-10-28 #7）', () => {
  assert.deepEqual(toPageResult({ ok: true, dryrun: true, data: { dryRun: true, action: 'payroll_save' } }), { ok: false, error: 'dryrun', message: '試跑模式，未寫入' });
});
t('代轉層錯誤（沒權限、逾時）：補 message 讓薪酬頁顯示', () => {
  assert.deepEqual(toPageResult({ ok: false, error: '沒有權限', status: 403 }), { ok: false, error: '沒有權限', message: '沒有權限' });
  assert.equal(toPageResult(null).ok, false);
});
t('網址：正式＝eason0728.github.io/mala-clock-in；本機＝mock 8911', () => {
  assert.deepEqual(payrollTarget('dzy.mozhuting.com'), { origin: PAYROLL_ORIGIN, url: 'https://eason0728.github.io/mala-clock-in/payroll.html?embed=dzy' });
  assert.equal(payrollTarget('localhost').origin, 'http://localhost:8911');
});
t('manifest：人資部門、只認 payroll.write、backend＝ns', () => {
  const r = validateManifest(manifest);
  assert.equal(r.ok !== false && !(r.errors && r.errors.length), true, JSON.stringify(r));
  assert.equal(manifest.dept, 'hr');
  assert.deepEqual(manifest.requires, ['payroll.write']);
  assert.ok(fs.existsSync(new URL('../assets/icons/payroll.png', import.meta.url)), '選單圖示存在');
});
t('模組程式裡沒有任何金鑰樣子的字串', () => {
  for (const f of ['manifest.js', 'bridge.js', 'index.js']) {
    const src = fs.readFileSync(new URL('../modules/payroll/' + f, import.meta.url), 'utf8');
    assert.ok(!/admin_key\s*[:=]\s*['"][^'"]/.test(src), f);
    assert.ok(!/AKfycb/.test(src), f + ' 不寫後端網址');
  }
});
t('分頁：manifest views＝PAYROLL_PAGES（順序、名稱），全部只認 payroll.write', () => {
  assert.deepEqual(manifest.views.map((v) => [v.id, v.name]), PAYROLL_PAGES);
  for (const v of manifest.views) assert.deepEqual(v.requires, ['payroll.write']);
});
t('切換訊息：認得的分頁照送，其他一律回儀表板', () => {
  assert.deepEqual(navMessage('att'), { type: 'dzy-payroll-nav', v: 1, p: 'att' });
  for (const bad of [null, undefined, 'main', '', 'x;y', '__proto__']) assert.equal(navMessage(bad).p, 'dash');
});
console.log('全部通過 ' + n);
