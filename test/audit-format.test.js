// node test/format.test.js —— 零依賴、直跑、失敗時 process.exit(1)
var Format = require('../modules/audit-shared/format.js');

var failures = 0;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  } else {
    console.log('PASS: ' + label);
  }
}

// --- recordKey ---
assertEqual(Format.recordKey('sxl-gf', '2026-08'), 'sxl-gf_2026-08', 'recordKey 範例');
assertEqual(Format.recordKey('mzt-js', '2026-08'), 'mzt-js_2026-08', 'recordKey mzt-js');

// --- monthLabel：12 個月全對照 ---
var monthCases = {
  '01': '一月', '02': '二月', '03': '三月', '04': '四月',
  '05': '五月', '06': '六月', '07': '七月', '08': '八月',
  '09': '九月', '10': '十月', '11': '十一月', '12': '十二月'
};
Object.keys(monthCases).forEach(function (mm) {
  assertEqual(Format.monthLabel('2026-' + mm), monthCases[mm], 'monthLabel 2026-' + mm);
});

// --- correctRate ---
assertEqual(Format.correctRate(19, 20), 95, 'correctRate(19,20)');
assertEqual(Format.correctRate(0, 20), 0, 'correctRate(0,20)');
assertEqual(Format.correctRate(20, 20), 100, 'correctRate(20,20)');

// --- anomalyOnlyCounts：只填異常項模式，分母固定 ---
var one = Format.anomalyOnlyCounts(1, 20);
assertEqual(one.sample_count, 20, 'anomalyOnlyCounts(1,20).sample_count');
assertEqual(one.correct_count, 19, 'anomalyOnlyCounts(1,20).correct_count');
assertEqual(one.correct_rate, 95, 'anomalyOnlyCounts(1,20).correct_rate＝95（Eason 指定的例子）');
assertEqual(Format.anomalyOnlyCounts(0, 20).correct_rate, 100, 'anomalyOnlyCounts(0,20)＝100%');
assertEqual(Format.anomalyOnlyCounts(3, 20).correct_rate, 85, 'anomalyOnlyCounts(3,20)＝85%');
assertEqual(Format.anomalyOnlyCounts(20, 20).correct_rate, 0, 'anomalyOnlyCounts(20,20)＝0%');
// 超過標準項數：correct_count 夾在 0，不產生負數（送出由前端另外擋）
assertEqual(Format.anomalyOnlyCounts(25, 20).correct_count, 0, 'anomalyOnlyCounts(25,20) 不出現負數');
// 沒給 sampleSize 時回退 20
assertEqual(Format.anomalyOnlyCounts(1).correct_rate, 95, 'anomalyOnlyCounts(1) 預設分母 20');

// --- buildAnomalyText：spec §5 範例逐字元比對 ---
var details = [
  { item: '鴨血', unit: '盒', book_qty: 27, recount_qty: 32, verdict: '異常' },
  { item: '米血', unit: '包', book_qty: 9, recount_qty: 8, verdict: '異常' }
];
var expectedText = '1.鴨血:盤點27盒，覆盤32盒\n2.米血:盤點9包，覆盤8包';
assertEqual(Format.buildAnomalyText(details), expectedText, 'buildAnomalyText 逐字元比對');

// 空陣列回空字串
assertEqual(Format.buildAnomalyText([]), '', 'buildAnomalyText 空陣列');

// 只取 verdict==='異常' 的項，依傳入順序編號（正確項略過、不佔序號）
var mixed = [
  { item: '牛肉片', unit: '公斤', book_qty: 26.5, recount_qty: 26.5, verdict: '正確' },
  { item: '鴨血', unit: '盒', book_qty: 27, recount_qty: 32, verdict: '異常' },
  { item: '感熱貼紙', unit: '捲', book_qty: 5, recount_qty: 15, verdict: '異常' }
];
var expectedMixed = '1.鴨血:盤點27盒，覆盤32盒\n2.感熱貼紙:盤點5捲，覆盤15捲';
assertEqual(Format.buildAnomalyText(mixed), expectedMixed, 'buildAnomalyText 混合正確/異常，僅異常編號');

// 結尾無多餘換行
assertEqual(/\n$/.test(Format.buildAnomalyText(details)), false, 'buildAnomalyText 結尾無多餘換行');

if (failures > 0) {
  console.error('\n' + failures + ' 項測試失敗');
  process.exit(1);
} else {
  console.log('\n全部測試通過');
}
