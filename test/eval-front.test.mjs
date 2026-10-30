// node test/eval-front.test.mjs —— 績效評核前端：manifest 合格、分頁權限碼＝後端權限碼、registry 有掛、前端檔語法
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import manifest from '../modules/eval/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { READ_ACTIONS } from '../platform/dryrun.js';
import { errText } from '../modules/eval/lib.js';

let n = 0;
function t(name, fn) { fn(); n++; console.log('PASS: ' + name); }

t('manifest 通過平台驗證（權限碼前綴＝ns platform）', () => {
  const r = validateManifest(manifest);
  assert.ok(r.ok, JSON.stringify(r.errors || r));
});
t('人資部門、打平台後端', () => {
  assert.equal(manifest.dept, 'hr');
  assert.equal(manifest.ns, 'platform');
  assert.equal(manifest.backend, 'platform');
});
t('分頁用到的權限碼都在後端 PERM_GRANTABLE', () => {
  const perms = fs.readFileSync(new URL('../apps-script/platform/Perms.gs', import.meta.url), 'utf8');
  const codes = new Set(manifest.views.flatMap((v) => v.requires).filter((p) => p !== 'platform.login'));
  assert.deepEqual([...codes].sort(), ['platform.eval-admin', 'platform.eval-all', 'platform.eval-brand', 'platform.eval-manage']);
  for (const c of codes) assert.ok(perms.includes(`'${c}'`), c);
});
t('registry 掛了一行', () => {
  const reg = fs.readFileSync(new URL('../platform/registry.js', import.meta.url), 'utf8');
  assert.equal((reg.match(/modules\/eval\/manifest\.js/g) || []).length, 1);
});
t('畫面呼叫的讀取 action 都在試跑白名單', () => {
  const src = fs.readdirSync(new URL('../modules/eval/views/', import.meta.url)).map((f) => fs.readFileSync(new URL('../modules/eval/views/' + f, import.meta.url), 'utf8')).join('\n')
    + fs.readFileSync(new URL('../modules/eval/index.js', import.meta.url), 'utf8');
  const called = new Set([...src.matchAll(/'(ev[A-Z][A-Za-z]+)'/g)].map((m) => m[1]));
  const reads = ['evMe', 'evMyScores', 'evNewbieList', 'evUnitResults', 'evPersonDetail', 'evBankGet', 'evImportPreview'];
  for (const a of called) if (reads.includes(a)) assert.ok(READ_ACTIONS.platform.includes(a), a);
  assert.ok(called.size >= 15, '畫面至少用到 15 支 action：' + [...called].join(','));
});
t('★errText：平台 api.js 把 {error:code, message} 壓成 error＝code、message 落在 data → 要顯示人話（2026-10-29）', () => {
  assert.equal(errText({ ok: false, error: 'window_closed', data: { message: '現在不是填寫期間（每季第一個月 1～5 號）' } }), '現在不是填寫期間（每季第一個月 1～5 號）');
  assert.equal(errText({ ok: false, error: 'bad_request', data: { message: '同一位同仁重複出現' } }), '同一位同仁重複出現');
  assert.equal(errText({ ok: false, error: 'window_closed' }), '現在不是填寫期間（每季第一個月 1～5 號）', '沒 message 的已知碼 → 中文表');
  for (const c of ['bad_request', 'forbidden', 'duplicate', 'unauthorized', 'not_in_unit', 'not_inited', 'no_scope', 'finalized', 'busy']) assert.notEqual(errText({ ok: false, error: c }), c, '代碼要翻中文：' + c);
  assert.equal(errText({ ok: false, error: '已經是中文的代轉訊息' }), '已經是中文的代轉訊息');
  assert.equal(errText({ ok: false, message: '直接帶 message' }), '直接帶 message');
  assert.equal(errText(null), '連不上伺服器，請稍後再試');
  assert.equal(errText({ ok: false }), '發生錯誤');
});
console.log(`\n通過 ${n}／${n}`);
