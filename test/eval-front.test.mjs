// node test/eval-front.test.mjs —— 績效評核前端：manifest 合格、分頁權限碼＝後端權限碼、registry 有掛、前端檔語法
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import manifest from '../modules/eval/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { READ_ACTIONS } from '../platform/dryrun.js';

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
console.log(`\n通過 ${n}／${n}`);
