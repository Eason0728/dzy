// 全資料審查 PR 3 的整理（2026-10-25）：manifest 檢查器認得 keepAlive／dynamicTabs、模組不再內嵌寫死的樣式、相片網址跳脫
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../platform/manifest-check.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c, label) => { assert.ok(c, label); n++; console.log('PASS: ' + label); };

// A-08
const base = { id: 'xx', ns: 'xx', backend: 'xx', name: '測試', desc: '測試', icon: 'x', requires: [], views: [{ id: 'a', name: 'A' }], entry: './x.js' };
const r = validateManifest(Object.assign({}, base, { keepAlive: 1800000, dynamicTabs: true }));
ok(!r.warnings.some((w) => /keepAlive|dynamicTabs/.test(w)), 'A-08 keepAlive／dynamicTabs 不再被當成未知欄位');
ok(validateManifest(Object.assign({}, base, { typoKey: 1 })).warnings.some((w) => /typoKey/.test(w)), 'A-08 真的打錯的欄位照樣警告');

// A-15：這幾支不再內嵌 style（改用 components.css 的 class）
const files = ['modules/staff-shared/clock-ui.js', 'modules/cashbook/views/rows.js', 'modules/perms/views/audit.js', 'modules/perms/views/ex.js'];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(!/style="(background:var\(--ok\)|max-width:160px|text-decoration:line-through|cursor:pointer|opacity)/.test(src) && !/#ddd/.test(src), 'A-15 ' + f + ' 沒有內嵌樣式／寫死色碼');
}
const css = fs.readFileSync(path.join(ROOT, 'platform/css/components.css'), 'utf8');
ok(['.btn-ok', '.is-dim', '.is-void', '.is-clickable', '.thumb'].every((c) => css.includes(c + ' {')), 'A-15 components.css 有對應的 class');

// B-03／A-10
const widgets = fs.readFileSync(path.join(ROOT, 'modules/approvals/widgets.js'), 'utf8');
ok(widgets.includes('src="${ctx.fmt.esc(it.previewUrl)}"'), 'B-03 相片預覽網址有跳脫');
const photo = fs.readFileSync(path.join(ROOT, 'modules/approvals/photo.js'), 'utf8');
ok(!photo.includes("localStorage.getItem('dzy.token')") && photo.includes("import { getToken } from '../../platform/auth.js'"), 'A-10 照片上傳跟平台拿 token，不自己讀 localStorage');

console.log(`通過 ${n}／${n}`);
