// node test/mobile-layout.test.mjs —— 手機 375 寬防橫向捲動的樣式釘子（真瀏覽器量測在 e2e：scrollWidth ≤ 375）
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'platform/css/components.css'), 'utf8');
const clock = fs.readFileSync(path.join(ROOT, 'modules/staff-shared/clock-ui.js'), 'utf8');
let failed = 0;
function ok(c, label) { if (c) console.log('PASS: ' + label); else { failed++; console.error('FAIL: ' + label); } }

const block = (sel) => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
ok(!/white-space:\s*nowrap/.test(block('.tag')), '.tag 不再 nowrap（長文字可換行，不撐出橫向捲動）');
ok(/flex-wrap:\s*wrap/.test(block('.btn-row')), '.btn-row 允許換行');
ok(/class="btn-row"[^>]*>\$\{clockButtonsHtml\(p, viewer\)\}/.test(clock), '同仁卡的打卡按鈕列用 .btn-row');
ok(/class="btn-row"[^>]*>\s*\$\{confirmed \? ''/.test(clock), '打卡對照卡的按鈕列用 .btn-row');
process.exit(failed ? 1 : 0);
