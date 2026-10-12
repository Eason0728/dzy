// node test/staff-front.test.mjs —— 個人帳號管理前端的靜態檢查（docs/personnel/task.md B1–B6）
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, RESERVED_IDS } from '../platform/manifest-check.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('PASS: ' + l); } else { failed++; console.error('FAIL: ' + l); } };

// 1. 連動下拉兩份必須同一份程式（模組不能 import 平台內部，只能各留一份）
const body = (f) => {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return s.slice(s.indexOf('*/') + 2).replace(/import \{ esc \} from '[^']+';/, '');
};
ok(body('platform/views/org-fields.js') === body('modules/staff-shared/org-fields.js'), '連動下拉兩份程式逐字相同（去掉檔頭與 esc 匯入）');

// 2. 新模組 manifest 合格、圖示檔存在
for (const id of ['me', 'staff']) {
  const m = (await import(`../modules/${id}/manifest.js`)).default;
  ok(validateManifest(m).ok, `${id} manifest 驗證通過`);
  ok(m.backend === m.ns && m.ns === 'platform', `${id} ns＝backend＝platform`);
  ok(fs.existsSync(path.join(ROOT, 'assets/icons', m.icon + '.png')), `${id} 圖示檔存在`);
}
// 3. 保留字擋得住
ok(RESERVED_IDS.includes('claim') && RESERVED_IDS.includes('forgot'), 'claim／forgot 是保留字');
ok(!validateManifest({ id: 'claim', ns: 'platform', backend: 'platform', name: '測試', desc: '測試', icon: 'users', requires: ['platform.self'], views: [{ id: 'aa', name: '測試', requires: [] }], entry: () => null }).ok, '用保留字當模組 id 會被擋');
// 4. registry 有接上
const reg = fs.readFileSync(path.join(ROOT, 'platform/registry.js'), 'utf8');
ok(reg.includes("modules/me/manifest.js") && reg.includes("modules/staff/manifest.js"), 'registry 接上 me／staff');
// 5. 模組沒有 import 平台內部
for (const f of ['modules/me/index.js', 'modules/me/views/profile.js', 'modules/me/views/unit.js', 'modules/staff/index.js', 'modules/staff/views/list.js', 'modules/staff/views/import.js']) {
  ok(!/from '\.\.\/(\.\.\/)?(\.\.\/)?platform\//.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} 沒有 import platform/`);
}
console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
