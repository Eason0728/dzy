/**
 * 收支管理模組（2026-10-24）：manifest 合規、匯出矩陣對固定資料逐欄、檔名、xlsx 可解開、首頁提醒判斷、純函式。
 * ⚠ 全部是假資料（公開 repo）；若本機有現金帳 repo（~/mala-cashbook），另外逐欄比對它的 buildMatrix。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import manifest from '../modules/cashbook/manifest.js';
import cashbook from '../modules/cashbook/index.js';
import { validateManifest } from '../platform/manifest-check.js';
import { MODULES } from '../platform/registry.js';
import { READ_ACTIONS, WRITE_ACTIONS } from '../platform/dryrun.js';
import {
  EXPORT_HEADERS, splitTax, summarize, buildExportRows, buildMatrix, fileName, toWorkbook, toXlsxBytes, MONEY_COLS, COL_WIDTHS, SHEET_NAME
} from '../modules/cashbook/lib/matrix.js';
import {
  lastMonthOf, currentMonthOf, defaultMonth, alertMonth, monthOptions, monthNum, isLocked, lockKind, lockLabel,
  needsAcctLock, storesToAlert, errText, parseSubjects, validateSubjects, safeUrl
} from '../modules/cashbook/lib/util.js';

const require = createRequire(import.meta.url);
let n = 0;
const t = (name, fn) => { const r = fn(); n++; if (r && typeof r.then === 'function') return r.then(() => console.log('PASS ' + name)); console.log('PASS ' + name); };
const root = (p) => new URL('../' + p, import.meta.url);

// ---------- manifest ----------
t('manifest：財務部門、只認 cashbook.write、backend＝ns、四個分頁、保留 30 分鐘', () => {
  const r = validateManifest(manifest);
  assert.equal(r.ok !== false && !(r.errors && r.errors.length), true, JSON.stringify(r));
  assert.equal(manifest.id, 'cashbook');
  assert.equal(manifest.ns, 'cashbook');
  assert.equal(manifest.backend, 'cashbook');
  assert.equal(manifest.dept, 'fin');
  assert.equal(manifest.name, '收支管理');
  assert.deepEqual(manifest.requires, ['cashbook.write']);
  assert.equal(manifest.keepAlive, 30 * 60 * 1000);
  assert.deepEqual(manifest.views.map((v) => [v.id, v.name]), [['rows', '收支明細'], ['lock', '月結鎖定'], ['export', '匯出 Excel'], ['subjects', '會計科目']]);
  manifest.views.forEach((v) => assert.deepEqual(v.requires, ['cashbook.write']));
  assert.ok(fs.existsSync(root('assets/icons/cashbook.png')), '選單圖示存在');
  assert.ok(fs.existsSync(root('modules/cashbook/vendor/xlsx.mini.min.js')), 'SheetJS mini 在 vendor');
});
t('registry：收支管理在清單裡，排在貨單核對之後、損益系統之前（財務部門順序：貨單核對 → 收支管理 → 調撥管理 → 損益系統）', () => {
  assert.equal(MODULES.length >= 1, true);
  const src = fs.readFileSync(root('platform/registry.js'), 'utf8');
  const lines = src.split('\n').filter((l) => /load: \(\) => import\(/.test(l));
  const at = (id) => lines.findIndex((l) => new RegExp(id + '\\/manifest\\.js').test(l));
  assert.ok(at('cashbook') !== -1, '收支管理要在 registry');
  if (at('purchase') !== -1) assert.ok(at('purchase') < at('cashbook'), '貨單核對在收支管理之前');
  if (at('pnl') !== -1) assert.ok(at('cashbook') < at('pnl'), '收支管理在損益系統之前');
});
t('dryrun 白名單：讀四個、寫四個，兩邊不重疊', () => {
  assert.deepEqual(READ_ACTIONS.cashbook, ['adminStores', 'adminList', 'adminLocks', 'adminGet']);
  assert.deepEqual(WRITE_ACTIONS.cashbook, ['adminSave', 'adminVoid', 'adminLock', 'adminUnlock']);
});
t('platform/api.js 把 cashbook 列為代轉 ns', () => {
  const src = fs.readFileSync(root('platform/api.js'), 'utf8');
  assert.ok(/const PROXY_NS = \{[^}]*cashbook: true/.test(src));
});
t('模組程式裡沒有金鑰樣子的字串、也沒有後端網址、不碰 admin_key／adminKey／通行碼欄位', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(new URL('../modules/cashbook/', import.meta.url).pathname).filter((x) => /\.js$/.test(x) && !/vendor/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/AKfycb/.test(src), f + ' 不寫後端網址');
    assert.ok(!/adminKey|admin_key|newStorePass|newAdminPass|ADMIN_SVC_KEY/.test(src), f + ' 不碰金鑰／通行碼欄位');
  }
});

// ---------- matrix：固定資料逐欄 ----------
const ROWS = [
  { id: 'r3', store: '新竹光復', date: '2026-09-03', kind: '收入', subject: '其他收入', name: '廠商退款', net: 400, tax: 0, amount: 400, hasInvoice: false, seq: 1, photo: '', author: '店長', createdAt: '2026-09-03 10:00:00', status: '正常' },
  { id: 'r2', store: '新竹光復', date: '2026-09-03', kind: '支出', subject: '食材', name: '青菜', net: 952, tax: 48, amount: 1000, hasInvoice: true, seq: 2, photo: 'https://example.test/photo/a.jpg', author: '店長', createdAt: '2026-09-03 09:30:00', status: '正常' },
  { id: 'r1', store: '新竹光復', date: '2026-09-01', kind: '支出', subject: '雜支', name: '垃圾袋', net: 120, tax: 0, amount: 120, hasInvoice: false, seq: 1, photo: '', author: '店長', createdAt: '2026-09-01 08:00:00', status: '正常' },
  { id: 'r4', store: '新竹光復', date: '2026-09-02', kind: '支出', subject: '食材', name: '作廢的一筆', net: 999, tax: 0, amount: 999, hasInvoice: false, seq: 1, photo: '', author: '店長', createdAt: '2026-09-02 08:00:00', status: '作廢', voidReason: '重複', voidedBy: '會計甲（A）（管理系統）' },
  { id: 'r5', store: '新竹光復', date: '2026-09-03', kind: '支出', subject: '食材', name: '同日第一筆', net: 50, tax: 0, amount: 50, hasInvoice: false, seq: 1, photo: '', author: '店長', createdAt: '2026-09-03 07:00:00', status: '正常' }
];
const EXPECT = [
  ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間'],
  ['新竹光復', '2026-09-01', '支出', '雜支', '垃圾袋', 120, 0, 120, '無', 1, '', '店長', '2026-09-01 08:00:00'],
  ['新竹光復', '2026-09-03', '支出', '食材', '同日第一筆', 50, 0, 50, '無', 1, '', '店長', '2026-09-03 07:00:00'],
  ['新竹光復', '2026-09-03', '支出', '食材', '青菜', 952, 48, 1000, '有', 2, 'https://example.test/photo/a.jpg', '店長', '2026-09-03 09:30:00'],
  ['新竹光復', '2026-09-03', '收入', '其他收入', '廠商退款', 400, 0, 400, '無', 1, '', '店長', '2026-09-03 10:00:00'],
  [],
  ['支出合計', '', '', '', '', '', '', 1170],
  ['收入合計', '', '', '', '', '', '', 400],
  ['淨額', '', '', '', '', '', '', -770]
];
t('buildMatrix：表頭、排序（日期→支出先於收入→收據編號）、作廢不出、空一列、三列合計、金額為數字型別', () => {
  assert.deepEqual(buildMatrix(ROWS), EXPECT);
  assert.deepEqual(EXPORT_HEADERS, EXPECT[0]);
  buildExportRows(ROWS).forEach((r) => [5, 6, 7, 9].forEach((i) => assert.equal(typeof r[i], 'number')));
});
t('summarize：不含作廢', () => {
  assert.deepEqual(summarize(ROWS), { expense: 1170, income: 400, net: -770, count: 4 });
  assert.deepEqual(summarize([]), { expense: 0, income: 0, net: 0, count: 0 });
  assert.deepEqual(summarize(null), { expense: 0, income: 0, net: 0, count: 0 });
});
t('buildMatrix：沒資料只剩表頭＋空列＋三列 0', () => {
  assert.deepEqual(buildMatrix([]), [EXPORT_HEADERS, [], ['支出合計', '', '', '', '', '', '', 0], ['收入合計', '', '', '', '', '', '', 0], ['淨額', '', '', '', '', '', '', 0]]);
});
t('buildMatrix：欄位缺值的容錯（字串數字、缺欄）與現金帳相同', () => {
  const m = buildMatrix([{ date: '2026-09-05', kind: '支出', amount: '88', net: '84', tax: '4', seq: '3', hasInvoice: 1, status: '正常' }]);
  assert.deepEqual(m[1], ['', '2026-09-05', '支出', '', '', 84, 4, 88, '有', 3, '', '', '']);
});
t('splitTax：有發票含稅÷1.05 四捨五入、稅額＝差額；沒發票未稅＝金額', () => {
  assert.deepEqual(splitTax(1000, true), { net: 952, tax: 48 });
  assert.deepEqual(splitTax(105, true), { net: 100, tax: 5 });
  assert.deepEqual(splitTax(1, true), { net: 1, tax: 0 });
  assert.deepEqual(splitTax(999, false), { net: 999, tax: 0 });
  assert.deepEqual(splitTax('abc', true), { net: 0, tax: 0 });
  for (const a of [1, 7, 99, 100, 333, 1234, 99999]) { const s = splitTax(a, true); assert.equal(s.net + s.tax, a); }
});
t('檔名：現金收支_店名_月份.xlsx', () => {
  assert.equal(fileName('新竹光復', '2026-09'), '現金收支_新竹光復_2026-09.xlsx');
});

// ---------- xlsx：用 vendor 那一份產檔再解開 ----------
const XLSX = require(new URL('../modules/cashbook/vendor/xlsx.mini.min.js', import.meta.url).pathname);
t('toWorkbook／toXlsxBytes：工作表「明細」、千分位格式、欄寬；檔案可解開且內容＝矩陣', () => {
  const wb = toWorkbook(XLSX, buildMatrix(ROWS));
  assert.deepEqual(wb.SheetNames, [SHEET_NAME]);
  assert.equal(SHEET_NAME, '明細');
  const ws = wb.Sheets['明細'];
  assert.equal(ws['H4'].z, '#,##0');          // 1000
  assert.equal(ws['F4'].z, '#,##0');
  assert.equal(ws['H9'].z, '#,##0');          // 淨額
  assert.equal(ws['A1'].z, undefined);
  assert.deepEqual(MONEY_COLS, [5, 6, 7]);
  assert.deepEqual(ws['!cols'].map((c) => c.wch), COL_WIDTHS);
  const bytes = toXlsxBytes(XLSX, ROWS);
  assert.ok(bytes && bytes.byteLength > 1000);
  const buf = Buffer.from(bytes);
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'xlsx 是 zip');
  const back = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(back.SheetNames, ['明細']);
  const aoa = XLSX.utils.sheet_to_json(back.Sheets['明細'], { header: 1, defval: '' });
  assert.equal(aoa.length, 9);
  assert.deepEqual(aoa[0], EXPECT[0]);
  assert.deepEqual(aoa[3], EXPECT[3]);
  assert.deepEqual(aoa[5], ['', '', '', '', '', '', '', '', '', '', '', '', '']);
  assert.deepEqual(aoa[6].slice(0, 1).concat(aoa[6][7]), ['支出合計', 1170]);
  assert.equal(aoa[8][7], -770);
});
t('與現金帳現行 js/export.js buildMatrix 逐欄相同（本機有現金帳 repo 才比）', () => {
  const dir = path.join(os.homedir(), 'mala-cashbook', 'js');
  if (!fs.existsSync(path.join(dir, 'export.js'))) { console.log('  （略過：沒有 ~/mala-cashbook）'); return; }
  const sb = { window: {}, console };
  vm.createContext(sb);
  sb.self = sb; // calc.js 用 self／this 掛 Calc
  vm.runInContext(fs.readFileSync(path.join(dir, 'calc.js'), 'utf8'), sb);
  sb.window.Calc = sb.Calc || sb.window.Calc;
  sb.window.Config = { STORE: '新竹光復', MODE: 'cloud' };
  vm.runInContext(fs.readFileSync(path.join(dir, 'export.js'), 'utf8'), sb);
  const theirs = JSON.parse(JSON.stringify(sb.window.Exporter.buildMatrix(ROWS)));
  assert.deepEqual(JSON.parse(JSON.stringify(buildMatrix(ROWS))), theirs);
  const c = sb.window.Calc;
  for (const a of [0, 1, 105, 1000, 1234]) for (const inv of [true, false]) assert.deepEqual(JSON.parse(JSON.stringify(splitTax(a, inv))), JSON.parse(JSON.stringify(c.splitTax(a, inv))));
});

// ---------- 日期：全部以台北時間算 ----------
const at = (iso) => new Date(iso);
t('上個月／預設月份／提醒月份（含跨年、台北日界）', () => {
  assert.equal(lastMonthOf(at('2026-10-24T04:00:00Z')), '2026-09');
  assert.equal(lastMonthOf(at('2027-01-05T04:00:00Z')), '2026-12');
  assert.equal(currentMonthOf(at('2026-10-24T04:00:00Z')), '2026-10');
  // 每月 1–10 日預設上個月，11 日起當月
  assert.equal(defaultMonth(at('2026-10-01T00:00:00+08:00')), '2026-09');
  assert.equal(defaultMonth(at('2026-10-10T23:59:59+08:00')), '2026-09');
  assert.equal(defaultMonth(at('2026-10-11T00:00:00+08:00')), '2026-10');
  assert.equal(alertMonth(at('2026-10-10T23:59:59+08:00')), '2026-09');
  assert.equal(alertMonth(at('2026-10-11T00:00:00+08:00')), null);
  assert.equal(alertMonth(at('2026-01-01T00:00:00+08:00')), '2025-12');
  // UTC 還在 9/30 16:00 → 台北已經是 10/1
  assert.equal(alertMonth(at('2026-09-30T16:00:00Z')), '2026-09');
  assert.equal(alertMonth(at('2026-10-31T16:00:00Z')), '2026-10');   // 台北 11/1
});
t('monthOptions／monthNum', () => {
  assert.deepEqual(monthOptions(at('2026-02-15T04:00:00Z'), 4), ['2026-02', '2026-01', '2025-12', '2025-11']);
  assert.equal(monthOptions(at('2026-10-24T04:00:00Z'), 24).length, 24);
  assert.equal(monthNum('2026-09'), '9');
  assert.equal(monthNum('2026-12'), '12');
});

// ---------- 首頁提醒判斷 ----------
const LOCK = (month, via, by, status) => ({ month, status: status || '鎖定', lockedAt: '2026-10-02 09:00:00', lockedBy: by || '', lockedVia: via });
t('鎖定判斷：未鎖／店長鎖／會計鎖／舊資料', () => {
  assert.equal(lockKind(null), 'none');
  assert.equal(lockKind(LOCK('2026-09', 'acct', '甲')), 'acct');
  assert.equal(lockKind(LOCK('2026-09', 'store', '店長')), 'store');
  assert.equal(lockKind(LOCK('2026-09', '', '')), 'unknown');
  assert.equal(lockKind(LOCK('2026-09', 'acct', '甲', '解鎖')), 'none');
  assert.deepEqual([lockLabel(null), lockLabel(LOCK('m', 'acct')), lockLabel(LOCK('m', 'store')), lockLabel(LOCK('m', ''))], ['未鎖', '會計鎖定', '店長鎖定', '已鎖定']);
  assert.equal(isLocked(LOCK('m', 'acct')), true);
});
t('needsAcctLock：只有「會計鎖」才算月結完成（店長自己鎖不算）', () => {
  assert.equal(needsAcctLock([], '2026-09'), true);
  assert.equal(needsAcctLock([LOCK('2026-09', 'store', '店長')], '2026-09'), true);
  assert.equal(needsAcctLock([LOCK('2026-09', '', '')], '2026-09'), true);
  assert.equal(needsAcctLock([LOCK('2026-09', 'acct', '甲')], '2026-09'), false);
  assert.equal(needsAcctLock([LOCK('2026-08', 'acct', '甲')], '2026-09'), true);
  assert.equal(needsAcctLock(undefined, '2026-09'), true);
});
t('storesToAlert：沒被會計鎖的店要提醒；沒帳的店不提醒；查不到有沒有帳時照提醒', () => {
  const stores = [{ code: 'a', name: '新竹光復' }, { code: 'b', name: '台中美村' }, { code: 'c', name: '員林南昌' }, { code: 'd', name: '新店' }];
  const locks = { a: [LOCK('2026-09', 'acct', '甲')], b: [LOCK('2026-09', 'store', '店長')], c: [], d: [] };
  const live = { a: true, b: true, c: true, d: false };
  assert.deepEqual(storesToAlert(stores, locks, '2026-09', live).map((s) => s.code), ['b', 'c']);
  assert.deepEqual(storesToAlert(stores, locks, '2026-09', {}).map((s) => s.code), ['b', 'c', 'd']);
  assert.deepEqual(storesToAlert([], {}, '2026-09', {}), []);
  // 2026-10-29：讀取失敗（null）的店不能斷言「還沒月結」——明細讀不到或鎖定讀不到都不列
  assert.deepEqual(storesToAlert(stores, locks, '2026-09', { a: true, b: null, c: true, d: true }).map((s) => s.code), ['c', 'd']);
  assert.deepEqual(storesToAlert(stores, { a: locks.a, b: null, c: [], d: [] }, '2026-09', live).map((s) => s.code), ['c']);
});

// alerts()：用假 ctx 驗整條（含只在每月 1–10 日出提醒）
function fakeCtx(table) {
  const calls = [];
  return {
    calls,
    api: { call: async (ns, action, payload) => { calls.push([ns, action, payload]); return table(action, payload); } }
  };
}
const ST = { ok: true, data: { stores: [{ code: 'gf', name: '新竹光復' }, { code: 'mc', name: '台中美村' }] } };
await t('alerts()：1–10 日列出上個月沒被會計鎖的店；文字「新竹光復 9 月還沒月結」、點了到月結鎖定', async () => {
  const RealDate = Date;
  const fixed = new RealDate('2026-10-05T04:00:00Z').getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
  try {
    const ctx = fakeCtx((action, p) => {
      if (action === 'adminStores') return ST;
      if (action === 'adminLocks') return { ok: true, data: { store: p.store, locks: p.store === 'gf' ? [] : [LOCK('2026-09', 'acct', '甲')] } };
      if (action === 'adminList') return { ok: true, data: { rows: [{ status: '正常' }] } };
      return { ok: false, error: 'x' };
    });
    const out = await cashbook.alerts(ctx);
    assert.deepEqual(out, [{ level: 'warn', text: '新竹光復 9 月還沒月結', view: 'lock', params: { store: 'gf', month: '2026-09' } }]);
    assert.ok(!ctx.calls.some((c) => c[1] === 'adminList' && c[2].store === 'mc'), '已被會計鎖的店不必再讀明細');
    assert.ok(ctx.calls.every((c) => c[0] === 'cashbook' && ['adminStores', 'adminLocks', 'adminList'].includes(c[1])), '提醒只用讀取動作');

    const empty = fakeCtx((action, p) => action === 'adminStores' ? ST : action === 'adminLocks' ? { ok: true, data: { locks: [] } } : { ok: true, data: { rows: [{ status: '作廢' }] } });
    assert.deepEqual(await cashbook.alerts(empty), [], '上個月只有作廢或沒有帳的店不提醒');

    const bad = fakeCtx(() => ({ ok: false, error: '沒有權限' }));
    assert.equal(await cashbook.alerts(bad), null, '讀不到店別＝算不出來（殼不顯示）');

    // 2026-10-29：某店明細讀失敗 → 不列「還沒月結」，改列一行沒有 view 的「暫時讀不到」；其他店照常
    const partial = fakeCtx((action, p) => {
      if (action === 'adminStores') return ST;
      if (action === 'adminLocks') return { ok: true, data: { locks: [] } };
      return p.store === 'gf' ? { ok: false, error: 'timeout' } : { ok: true, data: { rows: [{ status: '正常' }] } };
    });
    assert.deepEqual(await cashbook.alerts(partial), [
      { level: 'warn', text: '台中美村 9 月還沒月結', view: 'lock', params: { store: 'mc', month: '2026-09' } },
      { level: 'info', text: '部分門市暫時讀不到，稍後再看' }
    ], '某店讀失敗：不斷言還沒月結，列「暫時讀不到」');
    const lockFail = fakeCtx((action, p) => action === 'adminStores' ? ST : action === 'adminLocks' ? (p.store === 'gf' ? { ok: false, error: 'x' } : { ok: true, data: { locks: [LOCK('2026-09', 'acct', '甲')] } }) : { ok: true, data: { rows: [{ status: '正常' }] } });
    assert.deepEqual(await cashbook.alerts(lockFail), [{ level: 'info', text: '部分門市暫時讀不到，稍後再看' }], '鎖定讀失敗也不斷言（level 用殼認得的 info，不是 note）');
  } finally { globalThis.Date = RealDate; }
});
await t('alerts()：11 日起不出提醒、也不打任何後端', async () => {
  const RealDate = Date;
  const fixed = new RealDate('2026-10-24T04:00:00Z').getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
  try {
    const ctx = fakeCtx(() => ST);
    assert.deepEqual(await cashbook.alerts(ctx), []);
    assert.equal(ctx.calls.length, 0);
  } finally { globalThis.Date = RealDate; }
});

// ---------- 其他純函式 ----------
t('errText：已知碼翻中文、代轉層中文原樣、空值給預設', () => {
  assert.equal(errText({ error: 'LOCKED' }), '這個月已經月結鎖定，不能這樣改');
  assert.equal(errText({ error: '沒有權限' }), '沒有權限');
  assert.equal(errText({ error: 'WHATEVER_NEW' }), 'WHATEVER_NEW');
  assert.equal(errText(null), '沒有成功，請再試一次');
});
t('科目：一行一個、去空行去重；1–100 個、30 字內', () => {
  assert.deepEqual(parseSubjects(' 食材 \r\n\n雜支\n食材\n  \n人事'), ['食材', '雜支', '人事']);
  assert.equal(validateSubjects(['a'], '支出科目'), null);
  assert.match(validateSubjects([], '支出科目'), /至少/);
  assert.match(validateSubjects(Array.from({ length: 101 }, (_, i) => 'k' + i), '收入科目'), /最多 100/);
  assert.match(validateSubjects(['x'.repeat(31)], '支出科目'), /超過 30 字/);
  assert.equal(validateSubjects(['x'.repeat(30)], '支出科目'), null);
});
t('safeUrl：只收 http(s)', () => {
  assert.equal(safeUrl('https://example.test/p.jpg'), 'https://example.test/p.jpg');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl(''), '');
});

console.log('\n全部通過，共 ' + n + ' 項');
