/** 損益設定頁純函式（modules/pnl/views/settings-lib.js）：驗證、差異、連接器 URL、使用者整表、CSV、結果文字 */
import assert from 'node:assert/strict';
import * as L from '../modules/pnl/views/settings-lib.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('nextId／shiftMonth', () => {
  assert.equal(L.nextId('S', ['S01', 'S09', 'X1'], 2), 'S10');
  assert.equal(L.nextId('A', [], 3), 'A001');
  assert.equal(L.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(L.shiftMonth('2026-11', -1), '2026-10');
});
t('computeDiff：新增／修改／刪除', () => {
  const d = L.computeDiff((r) => r.k, [{ k: 'a', v: 1 }, { k: 'b', v: 1 }], [{ k: 'a', v: 2 }, { k: 'c', v: 1 }], (r) => r.k);
  assert.deepEqual(d, { added: ['c'], removed: ['b'], changed: ['a'] });
});
t('科目驗證：公式語法、未知引用、循環、重複、參數', () => {
  const base = (o) => Object.assign({ acc_id: 'A001', block: '營收', name: 'x', mode: '手動', in_pnl: true, params: {}, sort: 1, active: true }, o);
  assert.deepEqual(L.validateAccounts([base()]), []);
  const f = (id, formula) => base({ acc_id: id, mode: '公式', params: { formula } });
  assert.ok(L.validateAccounts([f('A002', 'A001+')]).some((v) => v.code === 'FORMULA_SYNTAX'));
  assert.ok(L.validateAccounts([base(), f('A002', 'A001+A999')]).some((v) => v.code === 'UNKNOWN_REF'));
  const cyc = L.validateAccounts([f('A001', 'A002'), f('A002', 'A001')]);
  assert.ok(cyc.some((v) => v.code === 'CYCLE'));
  assert.ok(L.validateAccounts([base(), base()]).some((v) => v.code === 'DUP_ACC'));
  assert.ok(L.validateAccounts([base({ params: { sign: 2 } })]).some((v) => v.param === 'sign'));
  assert.ok(L.validateAccounts([base({ mode: '公式', params: {} })]).some((v) => v.param === 'formula'));
  assert.equal(L.validateAccounts([f('A002', '(A001*2)-3/1.5'), base()]).length, 0);
});
t('sanitize：非公式清 formula、非手動清 carry_from', () => {
  assert.deepEqual(L.sanitizeAccountParamsForMode('固定', { formula: 'x', carry_from: 'A1', sign: -1 }), { sign: -1 });
  assert.deepEqual(L.sanitizeAccountParamsForMode('手動', { carry_from: 'A1' }), { carry_from: 'A1' });
});
t('科目影響警告', () => {
  const b = [{ acc_id: 'A001', name: 'a', block: '營收', in_pnl: true, mode: '手動', active: true, params: {} }];
  assert.equal(L.accountImpactWarnings(b, [Object.assign({}, b[0], { name: 'z' })]).length, 0);
  assert.equal(L.accountImpactWarnings(b, [Object.assign({}, b[0], { block: '食材' })]).length, 1);
});
t('門市驗證：格式、重複、品牌三選一、舊自訂品牌不擋', () => {
  const ok = { store_id: 'S01', name: 'a', active: true, brand: '小辛辣', unit_type: '門市', brand_color: '' };
  assert.equal(L.validateStores([ok], [ok]), '');
  assert.match(L.validateStores([{ ...ok, store_id: 'X1' }], []), /Sxx/);
  assert.match(L.validateStores([ok, ok], []), /重複/);
  assert.match(L.validateStores([{ ...ok, brand: '亂寫' }], [ok]), /品牌須為/);
  assert.equal(L.validateStores([{ ...ok, brand: '舊字' }], [{ ...ok, brand: '舊字' }]), '');
  assert.match(L.validateStores([{ ...ok, unit_type: 'x' }], []), /類型/);
});
t('門市固定值：孤兒列與攤提必填起月', () => {
  const stores = [{ store_id: 'S01', active: true }, { store_id: 'S02', active: false }];
  const accs = [{ acc_id: 'A1', mode: '固定' }, { acc_id: 'A2', mode: '手動' }];
  const mk = (s, a, o) => Object.assign(L.newStoreAccount(s, a), o);
  const r = L.splitStoreAccounts([mk('S01', 'A1', { fixed_amount: 5 }), mk('S02', 'A1', { fixed_amount: 5 }), mk('S01', 'A2', { fixed_amount: 1 }), mk('S01', 'A1', {})], stores, accs);
  assert.equal(r.kept.length, 1); assert.equal(r.orphans.length, 2); assert.equal(r.error, '');
  assert.match(L.splitStoreAccounts([mk('S01', 'A1', { amort_months: 3 })], stores, accs).error, /起月/);
  const d = L.storeAccountsDiff([mk('S02', 'A1', { fixed_amount: 5 })], r.kept, r.orphans, stores);
  assert.ok(d.removed[0].includes('門市已停用'));
});
t('範本：驗證與對應鍵改名', () => {
  const tpl = { tpl_id: 'T01', name: 'n', header_row: 1, group_col: '', mapping: { a: 'A001' } };
  assert.equal(L.validateTemplates([tpl]), '');
  assert.match(L.validateTemplates([{ ...tpl, mapping: {} }]), /至少/);
  assert.match(L.validateTemplates([{ ...tpl, mapping: { a: '' } }]), /尚未選科目/);
  assert.match(L.validateTemplates([{ ...tpl, mapping: { '@ACC_ID': '@ACC_ID' } }]), /分組欄/);
  assert.equal(L.validateTemplates([{ ...tpl, group_col: 'C', mapping: { '@ACC_ID': '@ACC_ID' } }]), '');
  assert.equal(L.renameMappingKey({ a: 1, b: 2 }, 'a', 'b'), null);
  assert.deepEqual(Object.keys(L.renameMappingKey({ a: 1, b: 2 }, 'a', 'z')), ['z', 'b']);
  assert.deepEqual(Object.keys(L.addMappingKey({ '': 'x' })), ['', '新對應1']);
});
t('連接器 URL：https 或本機 http；金鑰沒改送 ***', () => {
  assert.ok(L.isValidConnectorUrl('https://script.google.com/macros/s/x/exec'));
  assert.ok(L.isValidConnectorUrl('http://127.0.0.1:8801/cashbook/api'));
  assert.ok(L.isValidConnectorUrl('http://localhost:8801/a'));
  assert.ok(!L.isValidConnectorUrl('Eason'));
  assert.ok(!L.isValidConnectorUrl('http://example.com/x'));
  assert.ok(!L.isValidConnectorUrl('https://localhost/x'));
  const rows = [{ name: 'c', type: 'cashbook', newUrl: '', key: '', mapping: { k: 'A1' }, store_id: 'S01', active: true }];
  assert.deepEqual(L.connectorPayload(rows)[0], { name: 'c', type: 'cashbook', url: '***', key: '***', mapping: { k: 'A1' }, store_id: 'S01', active: true });
  rows[0].newUrl = 'http://127.0.0.1:1234/x'; rows[0].key = 'K';
  assert.equal(L.connectorPayload(rows)[0].url, 'http://127.0.0.1:1234/x');
  assert.equal(L.connectorPayload(rows)[0].key, 'K');
});
t('連接器驗證：新連接器要金鑰與 URL、壞 URL 回 badIndex', () => {
  const r = { name: 'n', type: 'cashbook', newUrl: '', key: '' };
  assert.match(L.validateConnectors([r], {}).error, /金鑰/);
  assert.match(L.validateConnectors([{ ...r, key: 'k' }], {}).error, /URL/);
  assert.equal(L.validateConnectors([r], { n: true }).error, '');
  const bad = L.validateConnectors([{ ...r, newUrl: 'Eason' }], { n: true });
  assert.equal(bad.badIndex, 0);
  assert.equal(L.urlDomainOnly('https://u:p@a.b.c:8/x?y'), 'a.b.c:8');
});
t('對應列 ↔ mapping', () => {
  const r = { type: 'cashbook', mapping: { 'expense.食材': 'A1', 'x.y': 'A2' } };
  const rows = L.mapRowsFrom(r);
  assert.deepEqual(rows.map((m) => m.custom), [false, true]);
  assert.deepEqual(L.mappingFromRows([...rows, { key: '', value: 'A9' }]), r.mapping);
});
t('系統設定驗證', () => {
  assert.equal(L.validateSystem('n', '#AABBCC'), '');
  assert.match(L.validateSystem('', '#AABBCC'), /名稱/);
  assert.match(L.validateSystem('n', 'red'), /主色/);
});
t('使用者：只列管理系統帳號；整表送出時其他帳號原樣帶回', () => {
  const all = [{ name: '舊人', role: '填寫者', stores: ['S01'], must_change: true }, { name: '管理系統:DZY070', role: '檢視者', stores: ['ALL'] }, { name: '管理系統:DZY071', role: '管理者', stores: [] }];
  assert.deepEqual(L.shadowUsers(all).map((u) => u.name), ['管理系統:DZY070', '管理系統:DZY071']);
  const p = L.buildUsersPayload(all, [{ name: '管理系統:DZY070', role: '檢視者', stores: ['S01'] }]);
  assert.deepEqual(p, [{ name: '舊人', role: '填寫者', stores: ['S01'] }, { name: '管理系統:DZY070', role: '檢視者', stores: ['S01'] }, { name: '管理系統:DZY071', role: '管理者', stores: [] }]);
  assert.match(L.validateShadowUsers([{ name: 'x', role: '填寫者', stores: [] }]), /至少/);
  assert.equal(L.validateShadowUsers([{ name: 'x', role: '檢視者', stores: [] }]), '');
  assert.match(L.scopeNote('檢視者', ['S01'], ['S01', 'S02']), /看不到全部合計/);
  assert.match(L.scopeNote('填寫者', ['S01', 'S02'], ['S01', 'S02']), /全部門市/);
});
t('結果文字：草稿、固定值、連接器失敗', () => {
  assert.match(L.describeDraftResult({ store_id: 'S01', month: '2026-10', entriesAdded: 4 }), /草稿已建立（帶入 4 筆）/);
  assert.match(L.describeDraftResult({ store_id: 'S01', month: '2026-10', skipped: true, status: '定稿' }), /已定稿/);
  assert.equal(L.formatConnectorIssues({ connectorFailures: [{ connector: 'c1', code: 'NET' }] }), '待處理（1）：c1:NET');
  assert.match(L.formatRefreshFixedResult({ store_id: 'S01', month: '2026-10', updated: 1, added: 2, voided: 0, unchanged: 3 }), /更新 1、補寫 2/);
  assert.match(L.describeRefreshConnectors({ store_id: 'S01', month: '2026-10', succeededConnectors: ['a'], connectorFailures: [{ connector: 'b', code: 'X' }] }), /共 2 個連接器；成功：a；待處理/);
  assert.equal(L.jobProgressText({ status: 'queued' }, '建'), '建：排隊中…');
  assert.match(L.jobProgressText({ status: 'running' }), /執行中/);
});
t('維護：自我檢查、同步預覽文字', () => {
  const d = L.describeSelfCheck({ runtime: 'mini', sheets: { 門市: { exists: true, rowCount: 2 }, 明細: { exists: false } }, sheetChangeTriggerOk: false, scriptProperties: { PNL_SALT: true }, duplicateUserNames: ['a'] });
  assert.ok(d.warnings.some((w) => w.includes('明細')) && d.warnings.some((w) => w.includes('重複')));
  assert.ok(!d.warnings.some((w) => w.includes('onSheetChange')));
  assert.ok(L.describeSeedPreview({ adds: 1, updates: 2, full: true, finalizedMonths: 3 }).some((x) => x.includes('3 個已定稿')));
});
t('CSV：BOM／CRLF／跳脫／公式注入／金額壞值／檔名', () => {
  const rows = L.buildEntriesCsvRows([
    { store_id: 'S01', month: '2026-08', acc_id: 'A1', amount: 300, split_months: 3, source: '手動', note: '=cmd, "q"', created_by: 'u', created_at: 't', void: false },
    { store_id: 'S01', month: '2026-08', acc_id: 'A1', amount: 'abc', split_months: 0, void: true }
  ], { accountName: () => '食材', storeName: () => '光復', storeBrand: () => '小辛辣' });
  assert.equal(rows[0].length, 14);
  assert.deepEqual([rows[1][4], rows[1][5], rows[1][6]], ['300.00', '3', '100.00']);
  assert.equal(rows[1][8], "'=cmd, \"q\"");
  assert.equal(rows[2][4], ''); assert.equal(rows[2][12], '金額格式錯'); assert.equal(rows[2][11], '是');
  const csv = L.buildCsv(rows);
  assert.ok(csv.includes('\r\n') && csv.includes('"\'=cmd, ""q"""'));
  assert.equal(L.withBom('a').charCodeAt(0), 0xfeff);
  assert.equal(L.csvFilename('明細', 'a/b', '2026-08'), '明細_a_b_2026-08.csv');
  assert.equal(L.numCell(-0.001, 2), '0.00');
});
t('異動紀錄時間（台北）', () => {
  assert.equal(L.makeLogEntry('a', 'b', Date.UTC(2026, 10, 3, 16, 5, 6)).at, '2026-11-04 00:05:06');
});
console.log('settings: ' + n + ' passed');
