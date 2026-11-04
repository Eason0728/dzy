/**
 * 損益匯入頁（T16）：lib/import-logic.js 與舊網站 gas/importLogic.html 的對照測試。
 * 用 vm 執行舊檔 <script> 內容，與新的 ES module 吃同一份假 POS 資料，逐函式比對輸出（JSON 相同）；
 * 另外用 SheetJS（vendor/xlsx.full.min.js）真的造 xlsx／HTML 表格，測 readWorkbookBuf（依內容判斷格式）。全部假資料。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as L from '../modules/pnl/lib/import-logic.js';

const require = createRequire(import.meta.url);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

// ---- 載入舊檔（vm）----
const html = fs.readFileSync(path.join(os.homedir(), 'mala-pnl-auto/gas/importLogic.html'), 'utf8');
const code = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const OLD = sandbox.ImportLogic;
const NEW = L.ImportLogic;
assert.ok(OLD && NEW);
const J = (x) => JSON.stringify(x === undefined ? '__undef__' : x);
const same = (fn, ...args) => assert.equal(J(NEW[fn](...args)), J(OLD[fn](...args)), fn + ' ' + J(args).slice(0, 200));

// ---- 假 POS 資料 ----
const HEADER = ['店別', '銷售單號', '桌位', '淨額', '結帳時間'];
const TPL = { tpl_id: 'T01', name: '光復 POS', header_row: 1, date_col: '結帳時間', amount_col: '淨額', group_col: '桌位',
  mapping: { UE: 'A002', UberEats: 'A002', Panda: 'A003', '-聯發科-': 'A004', ND: 'A005', '*': 'A001' } };
const day = (d, h = '12:00') => '2026-08-' + String(d).padStart(2, '0') + ' ' + h;
const rowsDay1 = [HEADER,
  ['小辛辣-新竹光復店', 1, 'UE', 279, day(1)],
  ['小辛辣-新竹光復店', 2, 'UberEats', 100, day(1)],
  ['小辛辣-新竹光復店', 3, '內用10', 175, day(1, '00:09')],
  ['小辛辣-新竹光復店', 4, '-聯發科-', '1,234', day(2)],
  ['小辛辣-新竹光復店', 5, 'Panda', ' 300 ', '2026/08/02 10:00'],
  ['小辛辣-新竹光復店', 6, 'ND', 250, new Date(2026, 7, 3, 0, 30)],
  [],                                          // 空列
  [null, null, null, null, null],              // 全 null
  ['小辛辣-新竹光復店', 7, 'UE', 'abc', day(3)],   // 壞金額
  ['小辛辣-新竹光復店', 8, 'UE', 50, '不是日期'],   // 怪日期
  ['小辛辣-新竹光復店', 9, 'UE', 60, '2026-07-31 23:59'], // 不在月份
  ['小辛辣-新竹光復店', 10, 'UE', 70, 46235.5],        // Excel 序號（2026-08-0x）
  ['小辛辣-新竹光復店', 11, '', 15, day(4)],          // 空分組→*
  ['小辛辣-新竹光復店', 12, 'ue', 15, day(4)],        // 小寫不等於 UE→*
  ['小辛辣-新竹光復店', 13, undefined, 0, day(5)],
  ['小辛辣-新竹光復店', 14, 'ND', 0.1, day(5)], ['小辛辣-新竹光復店', 15, 'ND', 0.2, day(5)],
  ['小辛辣-新竹光復店', 16, 'UE', new Date('invalid'), day(5)],
  ['小辛辣-新竹光復店', 17, 'UE', 10, new Date('invalid')]
];
const rowsDay2 = [HEADER, ['小辛辣-新竹光復店', 20, 'UE', 11, day(2)], ['小辛辣-新竹光復店', 21, 'Panda', 22, day(9)]];
const rowsOtherStore = [HEADER, ['小辛辣-台中美村店', 30, 'UE', 5, day(1)]];
const rowsBadHeader = [['店別', '銷售單號', '桌位', '金額', '時間'], ['x', 1, 'UE', 5, day(1)]];
const rowsHeaderRow3 = [['報表'], [], HEADER, ['小辛辣-新竹光復店', 1, 'UE', 5, day(1)]];
const files = [{ name: 'a.xls', rows2D: rowsDay1 }, { name: 'b.xls', rows2D: rowsDay2 }, { name: 'a.xls', rows2D: rowsDay1 },
  { name: 'c.xls', rows2D: rowsOtherStore }, { name: 'bad.xls', rows2D: rowsBadHeader }, { name: 'empty.xls', rows2D: [] }];

const DIRECT = { tpl_id: 'T02', header_row: 1, date_col: '', amount_col: '金額', group_col: '代號', mapping: { '@ACC_ID': '@ACC_ID' } };
const DHEAD = ['代號', '金額'];
const directRows = [DHEAD, ['a012', 100], [' Ａ０１３ ', '2,000.5'], ['A 014', 7], ['', 5], ['ZZZ', 1], ['A012', 'x'], [null, null], ['A012', 0.1], ['A012', 0.2]];
const accounts = [
  { acc_id: 'A012', name: '甲', active: true, mode: '匯入' }, { acc_id: 'A013', name: '乙', active: true, mode: '連接器' },
  { acc_id: 'A014', name: '丙', active: false, mode: '匯入' }, { acc_id: 'A015', name: '丁', active: true, mode: '固定' }
];

t('cellToDayStr：Date／序號／字串／壞值', () => {
  const vals = [new Date(2026, 7, 1, 0, 9), new Date(2026, 7, 31, 23, 59), new Date('invalid'), 46235.5, 46235, 0, NaN, Infinity, '2026-08-01 10:00', '2026/08/09', '2026-8-1', ' 2026-08-01', '', null, undefined, {}, true, [1]];
  vals.forEach((v) => same('cellToDayStr', v));
});
t('excelSerialToDate／monthOfDayStr／daysInMonth', () => {
  [0, 1, 25569, 46235.5, 60.5].forEach((v) => assert.equal(NEW.excelSerialToDate(v).getTime(), OLD.excelSerialToDate(v).getTime()));
  ['2026-08-01', null, ''].forEach((v) => same('monthOfDayStr', v));
  ['2026-02', '2028-02', '2026-12', '2026-08'].forEach((v) => same('daysInMonth', v));
});
t('matchAccId：完全相符／前綴／兜底／空分組欄／代號直入', () => {
  const tp = { group_col: 'g', mapping: { UE: 'A002', 'UE-*': 'A9', 'UE-X*': 'A8', '*': 'A001' } };
  ['UE', 'UE-1', 'UE-X1', ' UE ', '', null, undefined, 'zz', 12].forEach((v) => same('matchAccId', v, tp));
  same('matchAccId', 'x', { group_col: '', mapping: { '*': 'A1' } });
  same('matchAccId', 'x', { group_col: '', mapping: {} });
  same('matchAccId', 'x', { group_col: 'g', mapping: { UE: 'A2' } });
  ['a012', ' Ａ０１３ ', 'A 014', '', null, undefined, 5].forEach((v) => same('matchAccId', v, DIRECT));
});
t('colIndexOf／findMissingColumns／parseAmountCell', () => {
  same('colIndexOf', [' 淨額 ', null, 'x'], '淨額'); same('colIndexOf', HEADER, ''); same('colIndexOf', HEADER, '不存在');
  same('findMissingColumns', HEADER, TPL); same('findMissingColumns', rowsBadHeader[0], TPL);
  same('findMissingColumns', HEADER, Object.assign({}, TPL, { amount_col: '' }));
  [1, '1,234', ' 12 ', '', 'a', null, undefined, '1e3', NaN, {}].forEach((v) => same('parseAmountCell', v));
});
t('aggregateFile：每份假 POS 檔輸出相同（含略過／未對應／缺欄）', () => {
  [rowsDay1, rowsDay2, rowsOtherStore, rowsBadHeader, rowsHeaderRow3, [], null].forEach((r) => {
    same('aggregateFile', r, TPL, '2026-08');
    same('aggregateFile', r, Object.assign({}, TPL, { header_row: 3 }), '2026-08');
    same('aggregateFile', r, Object.assign({}, TPL, { date_col: '' }), '2026-08');
    same('aggregateFile', r, Object.assign({}, TPL, { group_col: '' }), '2026-09');
  });
  same('aggregateFile', directRows, DIRECT, '2026-08');
  const a = NEW.aggregateFile(rowsDay1, TPL, '2026-08');
  assert.equal(a.sums.A002, 279 + 100 + 70); 
  assert.equal(a.sums.A004, 1234); assert.equal(a.sums.A003, 300);
  assert.equal(a.skippedBadAmount, 3); assert.equal(a.skippedBadDate, 3);
});
t('aggregateFiles／detectDuplicateFiles／findStoreMismatch', () => {
  same('aggregateFiles', files, TPL, '2026-08');
  const ag = NEW.aggregateFiles(files, TPL, '2026-08');
  same('detectDuplicateFiles', ag.fileResults);
  const d = NEW.detectDuplicateFiles(ag.fileResults);
  assert.equal(d[2].nameConflict, true); assert.equal(d[1].dayOverlap, true);
  files.forEach((f) => { same('findStoreMismatch', f.rows2D, TPL, '新竹光復'); same('findStoreMismatch', f.rows2D, TPL, ''); same('findStoreMismatch', f.rows2D, TPL, '台中美村'); });
  same('aggregateFiles', [{ name: 'd.xlsx', rows2D: directRows }], DIRECT, '2026-08');
});
t('buildEntries／dateRangeOf／buildNote／validateDirectCodes', () => {
  const ag = NEW.aggregateFiles(files.slice(0, 2), TPL, '2026-08');
  const ago = OLD.aggregateFiles(files.slice(0, 2), TPL, '2026-08');
  assert.equal(J(NEW.buildEntries(ag, TPL)), J(OLD.buildEntries(ago, TPL)));
  assert.equal(J(NEW.dateRangeOf(ag.dayStrs)), J(OLD.dateRangeOf(ago.dayStrs)));
  assert.equal(NEW.buildNote(ag), OLD.buildNote(ago));
  assert.match(NEW.buildNote(ag), /^2 檔 \d+ 列 2026-08-01~2026-08-/);
  same('dateRangeOf', {});
  const dg = NEW.aggregateFiles([{ name: 'd.xlsx', rows2D: directRows }], DIRECT, '2026-08');
  const dgo = OLD.aggregateFiles([{ name: 'd.xlsx', rows2D: directRows }], DIRECT, '2026-08');
  assert.equal(J(NEW.buildEntries(dg, DIRECT)), J(OLD.buildEntries(dgo, DIRECT)));
  assert.equal(J(NEW.validateDirectCodes(dg, accounts)), J(OLD.validateDirectCodes(dgo, accounts)));
  assert.equal(J(NEW.validateDirectCodes(dg, null)), J(OLD.validateDirectCodes(dgo, null)));
  assert.ok(NEW.validateDirectCodes(dg, accounts).length >= 2);
});
t('findOtherSources：已有其他來源（連帶作廢黃卡）', () => {
  const existing = [
    { acc_id: 'A012', amount: 100, source: '手動', void: false }, { acc_id: 'A012', amount: '50.5', source: '連接器:x' },
    { acc_id: 'A012', amount: 9, source: '匯入:T02' }, { acc_id: 'A012', amount: 7, source: '手動', void: true },
    { acc_id: 'A013', amount: 1, source: '手動' }, { acc_id: 'A099', amount: 5, source: '手動' }, null, { acc_id: 'A012', amount: 'x', source: '手動' }
  ];
  const entries = [{ acc_id: 'A012' }, { acc_id: 'A013' }];
  const a = NEW.findOtherSources(existing, entries, 'T02');
  assert.equal(J(a), J(OLD.findOtherSources(existing, entries, 'T02')));
  assert.equal(a.length, 2); assert.equal(a[0].amount, 150.5);
  same('findOtherSources', null, null, 'T01');
});
t('formatAmount／normalizeAccIdCell／isAccIdDirect', () => {
  [0, 1234567, -1234.5, 0.004, -0.004, 1e9 + 0.126, NaN, '1', null].forEach((v) => same('formatAmount', v));
  ['a 012', ' Ａ０１２ ', null, undefined, 5, '　b\t1'].forEach((v) => same('normalizeAccIdCell', v));
  [DIRECT, TPL, null, { mapping: { '@ACC_ID': 'x' } }, { mapping: { '@ACC_ID': '@ACC_ID', a: 'b' } }].forEach((v) => same('isAccIdDirect', v));
});
t('looksLikeTextContent：zip／OLE／HTML／純文字', () => {
  const bufs = [Uint8Array.from([0x50, 0x4b, 3, 4, 0]), Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]), new TextEncoder().encode('<html><table>'), new TextEncoder().encode('a,b\n1,2'), new Uint8Array(0),
    Uint8Array.from([0x50, 0x4b, ...new TextEncoder().encode('<table>')])];
  bufs.forEach((b) => assert.equal(L.looksLikeTextContent(b.buffer), OLD.looksLikeTextContent(b.buffer)));
});

// ---- 讀檔（SheetJS 真的造檔）----
const X = (() => { const m = { exports: {} }; new Function('module', 'exports', fs.readFileSync(new URL('../modules/pnl/vendor/xlsx.full.min.js', import.meta.url), 'utf8'))(m, m.exports); return m.exports; })();
t('SheetJS vendor：版本 0.20.3、有 read', () => { assert.equal(X.version, '0.20.3'); assert.equal(typeof X.read, 'function'); });
t('readWorkbookBuf：副檔名 .xls 實際是 xlsx → 依內容讀；日期儲存格（含 00:09）不被讀成前一天', () => {
  const aoa = [HEADER, ['小辛辣-新竹光復店', 1, 'UE', 279, new Date(2026, 7, 1, 0, 9)], ['小辛辣-新竹光復店', 2, '內用1', 100, '2026-08-02 10:00']];
  const ws = X.utils.aoa_to_sheet(aoa, { cellDates: true }); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'S');
  const buf = X.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true });
  const ab = buf instanceof ArrayBuffer ? buf : Uint8Array.from(buf).buffer;
  const rows = L.sheetToRows2D(X, L.readWorkbookBuf(X, ab, TPL));
  const ag = L.aggregateFile(rows, TPL, '2026-08');
  assert.equal(ag.sums.A002, 279); assert.equal(ag.sums.A001, 100); assert.equal(ag.skippedBadDate, 0);
  assert.deepEqual(Object.keys(ag.dayStrs).sort(), ['2026-08-01', '2026-08-02']);
});
t('readWorkbookBuf：HTML 表格（薪資系統的 .xls）utf-8 → 讀得出表頭；壞檔不丟例外', () => {
  const h = '<html><head><meta charset="utf-8"></head><body><table><tr><th>店別</th><th>桌位</th><th>淨額</th><th>結帳時間</th></tr><tr><td>x</td><td>UE</td><td>42</td><td>2026-08-05 10:00</td></tr></table></body></html>';
  const ab = new TextEncoder().encode(h).buffer;
  const ag = L.aggregateFile(L.sheetToRows2D(X, L.readWorkbookBuf(X, ab, TPL)), TPL, '2026-08');
  assert.equal(ag.sums.A002, 42);
  const junk = Uint8Array.from([1, 2, 3, 4, 5]).buffer;
  assert.doesNotThrow(() => L.sheetToRows2D(X, L.readWorkbookBuf(X, junk, TPL)));
});
t('fmtInt', () => { assert.equal(L.fmtInt(1234567.4), '1,234,567'); assert.equal(L.fmtInt(-1234), '−1,234'); assert.equal(L.fmtInt(NaN), '—'); });

console.log('\n' + n + ' 項通過');
