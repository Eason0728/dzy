// node test/remit-front.test.mjs —— 匯款清單前端純函式＋manifest（2026-11-18，docs/remit/progress.md）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../modules/remit/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { money, monthsBack, bankText, visibleRows, totalOf, checkPaidDate, checkVendor, toCsv, csvCell, flatRow } from '../modules/remit/lib.js';
import { TYPES, TYPE_LABEL, REMIT_TYPES, ROLE_LABEL } from '../modules/approvals/lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } }

// manifest
const mv = validateManifest(manifest);
ok(mv && Array.isArray(mv.errors) && mv.errors.length === 0, 'manifest 驗證沒有錯誤（權限碼前綴＝ns platform）', mv);
ok(manifest.dept === 'fin' && manifest.work === 'money' && manifest.requires.join() === 'platform.remit' && manifest.views.map((v) => v.id).join() === 'list,vendors,accts', 'manifest：財務部門、錢、platform.remit、三個分頁');
ok(manifest.views.every((v) => v.requires.join() === 'platform.remit'), '三個分頁都只認 platform.remit');
ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'icons', 'remit.png')), '選單圖示 assets/icons/remit.png 存在');
const reg = fs.readFileSync(path.join(__dirname, '..', 'platform', 'registry.js'), 'utf8');
ok(/modules\/remit\/manifest\.js/.test(reg), 'registry 有匯款清單一列');

// 送單種類
ok(TYPES.map((t) => t.id).join() === 'advance,unitpay,personnel' && TYPES.map((t) => t.name).join() === '個人代墊,單位請款,人事異動', '送單三種：個人代墊、單位請款、人事異動');
ok(TYPE_LABEL.expense === '費用請款' && TYPE_LABEL.purchase === '請購', '舊單仍顯示費用請款／請購');
ok(REMIT_TYPES.join() === 'advance,unitpay' && ROLE_LABEL.fin_head === '財務部主管', '匯款種類與財務部主管名稱');

// 純函式
ok(money(18500) === '18,500' && money('x') === '—', 'money 千分位');
ok(monthsBack('2026-01', 3).join() === '2026-01,2025-12,2025-11', 'monthsBack 跨年');
ok(bankText({ self_pay: true }) === '同仁代墊' && bankText({ self_pay: false, bank: null }) === null, 'bankText：同仁代墊／沒帳戶');
ok(bankText({ bank: { bank_code: '004', bank_name: '臺灣銀行', branch: '', acct_name: '甲', acct_no: '0123' } }) === '004 臺灣銀行｜戶名 甲｜0123', 'bankText：沒分行不留空白');
const rows = [{ id: 'a', mine: true, accountants: [{}], amount: 100 }, { id: 'b', mine: false, accountants: [{}], amount: 50 }, { id: 'c', mine: false, accountants: [], amount: 7 }];
ok(visibleRows(rows, true).map((r) => r.id).join() === 'a,c' && visibleRows(rows, false).length === 3, '只看我負責：我的＋沒設定會計的');
ok(totalOf(rows) === 157, '合計');
ok(checkPaidDate('2026-11-18', '2026-11-18') === '' && checkPaidDate('2026-11-19', '2026-11-18') !== '' && checkPaidDate('', '2026-11-18') !== '', '匯款日：今天可、未來不行、空的不行');
const V = { name: '甲', bank_code: '004', bank_name: '臺銀', acct_name: '甲', acct_no: '012-345678' };
ok(checkVendor(V) === '', '廠商帳戶合法');
ok(checkVendor({ ...V, bank_code: '04' }) !== '' && checkVendor({ ...V, acct_no: '12345' }) !== '' && checkVendor({ ...V, acct_no: '1--2345678' }) !== '' && checkVendor({ ...V, acct_name: '' }) !== '', '廠商帳戶：代碼、帳號、戶名檢查');

// 前後端廠商規則一致：用後端同一組例子
const gs = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'platform', 'Approvals.gs'), 'utf8');
ok(gs.indexOf("digits.length < 6 || digits.length > 16 || /^-|-$|--/.test(no)") !== -1, '後端帳號規則與前端同一句（6～16 位、- 不能在頭尾或連續）');

// 匯出
ok(csvCell('=1+1') === "'=1+1" && csvCell('a,b') === '"a,b"', 'CSV 防公式注入、逗號加引號');
const f = flatRow({ id: 'APV-1', date: '2026-11-25', type_name: '單位請款', unit_name: '光復', payee: '廠商', desc: 'x', category: '雜支', amount: 10, state: 'pending', self_pay: false, bank: { bank_code: '004', bank_name: '臺銀', branch: '', acct_name: '廠商', acct_no: '0123' } });
ok(f.acct_no === '​0123' && f.state === '待出帳' && f.bank_code === '004', '匯出：帳號保留開頭 0、狀態中文');
const csv = toCsv([{ id: 'X', date: 'd', type_name: '個人代墊', unit_name: 'u', payee: 'p', desc: '', category: '', amount: 5, state: 'paid', self_pay: true, paid: { date: '2026-11-18' } }]);
ok(csv.charCodeAt(0) === 0xfeff && csv.split('\r\n').length === 2 && /同仁代墊/.test(csv) && /已匯款,2026-11-18,X$/.test(csv), '匯出 CSV：BOM、標題列＋資料列、同仁代墊、已匯款日', csv);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
