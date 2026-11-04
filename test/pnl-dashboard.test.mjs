/** 損益儀表板純函式（modules/pnl/views/dashboard-lib.js）：金額格式、較上月、斷線、估算標題、本月累計、圖幾何、品牌加總 */
import assert from 'node:assert/strict';
import * as L from '../modules/pnl/views/dashboard-lib.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const M = (k) => L.METRICS.find((m) => m.key === k);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

t('六列順序與標題', () => assert.deepEqual(L.METRICS.map((m) => m.title), ['營業額', '稅後淨利', '食材費用（食材＋包材）', '人事費用', '可控費用', '不可控費用']));
t('fmtInt：千分位、四捨五入、負數用−、非數字—', () => {
  assert.equal(fi(1234567.5), '1,234,568'); assert.equal(fi(-1234.4), '−1,234'); assert.equal(fi(0), '0'); assert.equal(fi(-0.2), '0'); assert.equal(fi(NaN), '—');
  function fi(x) { return L.fmtInt(x); }
});
t('fmtPct1', () => { assert.equal(L.fmtPct1(25, 100), '25.0%'); assert.equal(L.fmtPct1(1, 3), '33.3%'); assert.equal(L.fmtPct1(5, 0), '—'); });
t('metricValue：食材＝食材＋包材；淨利取 net_profit', () => {
  const row = { blocks: { 營收: 1000, 食材: 300, 包材: 20, 人事: 200 }, net_profit: 77 };
  assert.equal(L.metricValue(M('food'), row), 320); assert.equal(L.metricValue(M('net'), row), 77); assert.equal(L.metricValue(M('labor'), row), 200); assert.equal(L.metricValue(M('controllable'), row), 0);
});
t('deltaInfo：百分比／小基期／虧轉盈／>300%／持平／無上月', () => {
  assert.equal(L.deltaInfo(110, 100).text, '+10.0%'); assert.equal(L.deltaInfo(90, 100).text, '−'.length ? '-10.0%' : '');
  assert.equal(L.deltaInfo(500, 10).text, '+NT$ 490'); assert.equal(L.deltaInfo(50, -20).text, '由虧轉盈 +NT$ 70');
  assert.equal(L.deltaInfo(1000, 100).text, '+NT$ 900'); assert.equal(L.deltaInfo(5, 5).text, '持平'); assert.equal(L.deltaInfo(5, null).text, '—');
  assert.equal(L.deltaInfo(80, 100).arrow, '▼'); assert.equal(L.deltaInfo(120, 100).dir, 'up');
});
t('monthHasData：has_entries=false／狀態無＝沒資料；全部門市要有一家不是無', () => {
  assert.equal(L.monthHasData({ status: '草稿', has_entries: true }, false), true);
  assert.equal(L.monthHasData({ status: '草稿', has_entries: false }, false), false);
  assert.equal(L.monthHasData({ status: '無' }, false), false);
  assert.equal(L.monthHasData({ status: { a: '無', b: '草稿' } }, true), true);
  assert.equal(L.monthHasData({ status: { a: '無' } }, true), false);
});
t('monthIsEmpty／countPending', () => {
  assert.equal(L.monthIsEmpty({ status: '無' }, false), true); assert.equal(L.monthIsEmpty({ status: { a: '無', b: '無' } }, true), true); assert.equal(L.monthIsEmpty({ status: { a: '草稿' } }, true), false);
  assert.equal(L.countPending({ pending: [1, 2, 3] }, false), 3); assert.equal(L.countPending({ pending: { a: [1, 2], b: [3] } }, true), 3); assert.equal(L.countPending(null, false), 0);
});
t('本月累計至 M/D：取 POS自動 備註「；」前；手動上傳優先；日期取字串', () => {
  const mtd = { source: '匯入:POS自動', note: '本月累計至 9/15；來源 POS', created_at: '2026-09-15T05:15:00+08:00' };
  assert.equal(L.statusText({ status: '草稿', entries: [mtd] }), '狀態：草稿　本月累計至 9/15');
  assert.equal(L.statusText({ status: '草稿', entries: [mtd, { source: '匯入:T01', created_at: '2026-09-03T10:00:00+08:00' }] }), '狀態：草稿　POS 已由店長手動上傳（9/3），自動推送暫停');
  assert.equal(L.statusText({ status: '定稿', entries: [] }), '狀態：定稿'); assert.equal(L.statusText({ entries: [] }), '狀態：無');
  assert.equal(L.statusTextAll({ status: { a: '草稿', b: '定稿' } }, (s) => s.toUpperCase()), 'A：草稿　B：定稿');
});
t('估算：人事（估）、淨利（含估算）、費用科目落到其 block', () => {
  const r = { estimates: { A: 1 }, estimate_basis: { label: '近三月平均' }, block_estimates: { 食材: { label: '依營收比' } }, cost_estimate_basis: { X1: { label: '去年同月' } } };
  const b = L.estimatedBlocks(r, [{ acc_id: 'X1', block: '不可控', name: '房租' }]);
  assert.deepEqual(Object.keys(b).sort(), ['不可控', '人事', '食材']);
  assert.equal(L.metricTitle(M('labor'), b), '人事費用（估）'); assert.equal(L.metricTitle(M('net'), b), '稅後淨利（含估算）'); assert.equal(L.metricTitle(M('revenue'), b), '營業額'); assert.equal(L.metricTitle(M('controllable'), b), '可控費用');
  assert.deepEqual(L.estimateNotes(r, [{ acc_id: 'X1', name: '房租' }]), ['人事估算：近三月平均', '食材估算：依營收比', '費用估算：房租：去年同月']);
  assert.deepEqual(L.estimatedBlocks({ blocks: {} }, []), {}); assert.equal(L.metricTitle(M('net'), {}), '稅後淨利');
});
t('品牌清單固定順序；顏色逐店分配，第 9 家起重複並畫虛線', () => {
  assert.deepEqual(L.brandOptions([{ brand: '小辛辣' }, { brand: '鼎兆元' }, { brand: '新品牌' }, {}]), ['鼎兆元', '小辛辣', '新品牌']);
  const ids = Array.from({ length: 10 }, (_, i) => 's' + i); const c = L.assignSeriesColors(ids);
  assert.equal(c.s0.color, L.SERIES_PALETTE[0]); assert.equal(c.s8.color, L.SERIES_PALETTE[0]); assert.equal(c.s0.dash, ''); assert.equal(c.s8.dash, '6 4');
});
t('超過 6 條先畫 6 條；品牌篩選與無資料的店不入圖', () => {
  const stores = Array.from({ length: 8 }, (_, i) => ({ store_id: 's' + i, brand: i < 5 ? '小辛辣' : '墨竹亭' }));
  const multi = { months: ['2026-07'], stores: {} };
  stores.forEach((s, i) => { multi.stores[s.store_id] = [{ month: '2026-07', status: i === 7 ? '無' : '草稿', has_entries: i !== 7 }]; });
  const all = L.visibleStoreIds(multi, stores, '全部');
  assert.equal(all.length, 7); assert.deepEqual(L.visibleStoreIds(multi, stores, '墨竹亭'), ['s5', 's6']);
  assert.deepEqual(Object.keys(L.defaultHidden(all)), ['s6']);
});
t('品牌篩選加總：只加有資料的店', () => {
  const multi = { stores: { a: [{ month: 'm', status: '草稿', has_entries: true, blocks: { 營收: 100, 食材: 10 }, net_profit: 5, operating_profit: 6 }], b: [{ month: 'm', status: '無', blocks: { 營收: 999 }, net_profit: 9 }], c: [{ month: 'm', status: '定稿', has_entries: true, blocks: { 營收: 50 }, net_profit: 1, operating_profit: 2 }] } };
  const s = L.sumMultiAt(multi, ['a', 'b', 'c'], 0);
  assert.deepEqual(s.stores, ['a', 'c']); assert.equal(s.blocks['營收'], 150); assert.equal(s.net_profit, 6); assert.equal(s.operating_profit, 8);
});
t('刻度：含 0、整齊；軸標用萬', () => {
  const d = L.niceDomain([0, 95000]); assert.equal(d.min, 0); assert.ok(d.max >= 95000); assert.ok(d.ticks.includes(0));
  assert.equal(L.niceDomain([-50, 100]).min <= -50, true);
  assert.equal(L.fmtAxis(150000), '15萬'); assert.equal(L.fmtAxis(1500), '1,500'); assert.equal(L.fmtAxis(-20000), '−2萬'); assert.equal(L.fmtAxis(0), '0');
});
t('走勢：沒資料的月份斷線不畫 0；空心點以虛線接前一點；末點必畫點', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
  const pts = (arr) => arr.map((a) => (a === null ? { value: 0, has: false } : a === 'h' ? { value: 300, has: true, hollow: true } : { value: a, has: true }));
  const s = { id: 'x', name: 'X', color: '#111', dash: '', points: pts([100, 200, null, 150, 'h']) };
  const g = L.chartGeometry(months, [s], 600);
  const solid = g.lines.filter((l) => !l.dashed), dashed = g.lines.filter((l) => l.dashed);
  assert.equal(solid.length, 1, '1-2 月連一段；4 月孤立點沒有線'); assert.equal(dashed.length, 1, '4→5 月空心點虛線');
  assert.ok(!solid[0].d.includes('L', solid[0].d.indexOf('L') + 1), '只有兩個點');
  assert.ok(g.dots.some((d) => d.i === 3 && !d.hollow), '孤立點要畫'); assert.ok(g.dots.some((d) => d.i === 4 && d.hollow), '空心點');
  assert.ok(!g.dots.some((d) => d.i === 2), '沒資料的月份沒有點');
  const all0 = L.chartGeometry(months, [{ ...s, points: pts([null, null, null, null, null]) }], 600); assert.equal(all0.lines.length, 0);
});
t('chartSvg：用 CSS 變數、跳脫標題、無資料回空字串', () => {
  const months = ['2026-01', '2026-02'];
  const s = { id: 'x', name: 'X', color: '#2a78d6', dash: '', points: [{ value: 100, has: true }, { value: 200, has: true, hollow: true }] };
  const svg = L.chartSvg(esc, { title: '<b>營業額', months, series: [s], width: 400 });
  assert.ok(svg.startsWith('<svg') && svg.includes('var(--line)') && svg.includes('var(--muted)') && svg.includes('var(--card)'));
  assert.ok(!svg.includes('<b>') && svg.includes('&lt;b>')); assert.ok(svg.includes('stroke-dasharray="3 4"'));
  assert.equal(L.chartSvg(esc, { title: 't', months, series: [{ ...s, points: [{ value: 0, has: false }, { value: 0, has: false }] }], width: 400 }), '');
});
t('單店序列：選定月份用上方同一份數字、含估算畫空心；月中累計', () => {
  const trend = [{ month: '2026-10', status: '定稿', has_entries: true, blocks: { 人事: 100 } }, { month: '2026-11', status: '草稿', has_entries: true, blocks: { 人事: 120 } }];
  const s = L.buildStoreSeries(M('labor'), trend, { id: 'S01', name: '光復', color: '#111', month: '2026-11', headRow: { blocks: { 人事: 150 } }, estimated: true, nowMonth: '2026-11' })[0];
  assert.equal(s.points[1].value, 150); assert.equal(s.points[1].hollow, true); assert.equal(s.points[1].note, '含估算'); assert.equal(s.points[0].hollow, false);
  const s2 = L.buildStoreSeries(M('labor'), trend, { id: 'S01', name: '光復', color: '#111', month: '2026-10', headRow: null, estimated: false, nowMonth: '2026-11' })[0];
  assert.equal(s2.points[1].note, '月中累計'); assert.equal(s2.points[1].hollow, true);
});
t('提示框列：高到低、帶備註', () => {
  const r = L.tooltipRows([{ name: 'A', color: 'a', points: [{ value: 5, has: true }] }, { name: 'B', color: 'b', points: [{ value: 9, has: true, note: '月中累計' }] }, { name: 'C', color: 'c', points: [{ value: 1, has: false }] }], 0);
  assert.deepEqual(r.map((x) => x.name), ['B', 'A']); assert.equal(r[0].text, 'NT$ 9（月中累計）');
});
t('CSV：BOM＋CRLF、跳脫、injection、金額 2 位小數、檔名', () => {
  const csv = L.withBom(L.buildCsv([['a,b', 'x"y', '=1+1'.length ? L.textCell('=cmd') : ''], [L.numCell(-1.005), L.numCell(NaN)]]));
  assert.equal(csv.charCodeAt(0), 0xfeff); assert.equal(csv.slice(1), '"a,b","x""y",\'=cmd\r\n-1.01,');
  assert.equal(L.numCell(-0.001), '0.00'); assert.equal(L.numCell(1234.5), '1234.50');
  assert.equal(L.csvFilename('損益', 'a/b:c', '2026-08'), '損益_a_b_c_2026-08.csv'); assert.equal(L.csvFilename('明細', '全部', '2026-08'), '明細_全部_2026-08.csv');
});
t('損益表 CSV：表頭含「是否估算」、區塊小計、營業淨利／稅後淨利；估算科目與牽涉的小計標「是」', () => {
  const accounts = [{ acc_id: 'R1', block: '營收', name: '營業額', mode: 'sum', in_pnl: true, active: true, sort: 1 }, { acc_id: 'L1', block: '人事', name: '薪資', mode: 'sum', in_pnl: true, active: true, sort: 1 }, { acc_id: 'Z', block: '可控', name: '停用', in_pnl: true, active: false }];
  const result = { blocks: { 營收: 1000, 人事: 250 }, accounts: { R1: 1000, L1: 250 }, operating_profit: 750, net_profit: 700, estimates: { L1: 250 }, estimate_basis: { source: 'labor_clock' }, pending: [] };
  const rows = L.buildPnlCsvRows(accounts, result);
  assert.deepEqual(rows[0], ['區塊', 'acc_id', '科目', '取值方式', '金額', '佔營收%', '是否估算']);
  assert.equal(rows.length, 1 + 8 + 2 + 2);   // 8 區塊小計＋2 個啟用科目＋2 條淨利
  const find = (name) => rows.find((r) => r[2] === name);
  assert.deepEqual(find('薪資'), ['人事', 'L1', '薪資', 'sum', '250.00', '25.0%', '是']);
  assert.equal(find('營業額')[6], ''); assert.equal(rows.filter((r) => r[2] === '小計' && r[0] === '人事')[0][6], '是'); assert.equal(rows.filter((r) => r[2] === '小計' && r[0] === '營收')[0][6], '');
  assert.deepEqual(find('稅後淨利'), ['', '', '稅後淨利', '', '700.00', '70.0%', '是']); assert.ok(!rows.some((r) => r[2] === '停用'));
});
t('明細 CSV：欄位、認列金額、作廢、金額壞／分攤月數壞狀態、品牌欄', () => {
  const rows = L.buildEntriesCsvRows([
    { store_id: 'S01', month: '2026-08', acc_id: 'A', amount: 1200, split_months: 3, source: '手動', note: '=x', created_by: 'u', created_at: 't', void: false },
    { store_id: 'S01', month: '2026-08', acc_id: 'A', amount: 'abc', void: true },
    { store_id: 'S01', month: '2026-08', acc_id: 'A', amount: 10, split_months: 0 }
  ], { accountName: () => '科目A', storeName: () => '光復', storeBrand: () => '小辛辣' });
  assert.deepEqual(rows[0], ['門市', '月份', 'acc_id', '科目', '金額', '分攤月數', '認列金額', '來源', '備註', '建立者', '建立時間', '作廢', '狀態', '品牌']);
  assert.deepEqual(rows[1], ['光復', '2026-08', 'A', '科目A', '1200.00', '3', '400.00', '手動', "'=x", 'u', 't', '否', '', '小辛辣']);
  assert.equal(rows[2][4], ''); assert.equal(rows[2][11], '是'); assert.equal(rows[2][12], '金額格式錯'); assert.equal(rows[3][12], '分攤月數格式錯（已當 1）'); assert.equal(rows[3][6], '10.00');
});
console.log('\n' + n + ' 項通過');
