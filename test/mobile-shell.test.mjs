// node test/mobile-shell.test.mjs —— 手機版外框（2026-11-06）：每個模組都有工作分類、殼頁面 id 不被模組佔用、
// 電腦版不顯示手機元素。真瀏覽器的版面量測在 e2e ㉓（e2e_t23_mobile_shell.py）。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, RESERVED_IDS } from '../platform/manifest-check.js';
import { WORK_GROUPS } from '../platform/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function ok(c, label) { if (c) console.log('PASS: ' + label); else { failed++; console.error('FAIL: ' + label); } }

const dirs = fs.readdirSync(path.join(ROOT, 'modules')).filter((d) => fs.existsSync(path.join(ROOT, 'modules', d, 'manifest.js')));
const registry = fs.readFileSync(path.join(ROOT, 'platform/registry.js'), 'utf8');
const listed = dirs.filter((d) => registry.includes(`modules/${d}/manifest.js`));
ok(listed.length >= 20, `registry 列了 ${listed.length} 個模組`);

for (const d of listed) {
  const m = (await import(pathToFileURL(path.join(ROOT, 'modules', d, 'manifest.js')).href)).default;
  ok(WORK_GROUPS.some((g) => g.id === m.work), `${m.id}：work「${m.work}」是已知工作分類`);
  ok(validateManifest(m).errors.length === 0, `${m.id}：manifest 驗證無錯誤`);
  ok(!['apps', 'todo', 'account'].includes(m.id), `${m.id}：不佔用手機殼頁面代號`);
}

for (const id of ['apps', 'todo', 'account']) ok(RESERVED_IDS.includes(id), `${id} 是保留字`);
const bad = validateManifest({ id: 'xx', ns: 'xx', backend: 'xx', name: '測試模組', desc: '測試', icon: 'xx', requires: ['xx.read'], views: [{ id: 'a', name: '甲', requires: ['xx.read'] }], entry: () => null, work: 'nope' });
ok(bad.errors.some((e) => e.includes('work')), '未知的 work 會被擋');

const accountMods = [];
for (const d of listed) {
  const m = (await import(pathToFileURL(path.join(ROOT, 'modules', d, 'manifest.js')).href)).default;
  if (m.accountMenu) accountMods.push(m.id);
}
ok(accountMods.length === 1 && accountMods[0] === 'me', '只有「我的資料」列進手機「我」頁');

const css = fs.readFileSync(path.join(ROOT, 'platform/css/components.css'), 'utf8');
ok(/\.m-bar, \.m-tabs \{ display: none; \}/.test(css), '電腦版藏手機上方列與底部四格');
ok(/@media \(min-width: 861px\) \{\s*\.m-only \{ display: none !important; \}/.test(css), '電腦版藏手機首頁');
ok(/\.app-shell \.aih-fab \{ display: none !important; \}/.test(css), '手機版收起右下角小幫手鈕');

process.exit(failed ? 1 : 0);
