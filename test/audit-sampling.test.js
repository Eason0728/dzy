// node test/sampling.test.js —— 零依賴、直跑、失敗時 process.exit(1)
var Sampling = require('../modules/audit-shared/sampling.js');
var MockData = require('../modules/audit-shared/mock-data.js');

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

function assertTrue(cond, label) {
  if (!cond) {
    failures++;
    console.error('FAIL: ' + label);
  } else {
    console.log('PASS: ' + label);
  }
}

function uniqueNames(sample) {
  var seen = {};
  var dup = false;
  sample.forEach(function (it) {
    if (seen[it.name]) dup = true;
    seen[it.name] = true;
  });
  return !dup;
}

// ---- sxl-gf 品項庫 + 歷史明細（真實 mock 資料）----
var sxlItems = MockData.items.filter(function (it) { return it.store === 'sxl-gf'; });
var sxlDetails = MockData.details.filter(function (d) { return d.store === 'sxl-gf'; });

assertTrue(sxlItems.length > 20, 'sxl-gf 品項庫 > 20 項（實際 ' + sxlItems.length + '）');

// --- lastDrawnOf：手動加入品項（含品項庫沒有的自訂品項）查歷史標記 ---
var lastDrawnDetails = [
  { item: '鴨血', month: '2026-01' },
  { item: '鴨血', month: '2026-06' },
  { item: '自訂沒在庫裡的品項', month: '2026-03' }
];
assertEqual(Sampling.lastDrawnOf('鴨血', lastDrawnDetails), '2026-06', 'lastDrawnOf 取最近月份');
assertEqual(Sampling.lastDrawnOf('自訂沒在庫裡的品項', lastDrawnDetails), '2026-03',
  'lastDrawnOf 對品項庫沒有的自訂品項一樣查得到');
assertEqual(Sampling.lastDrawnOf('從沒出現過', lastDrawnDetails), null, 'lastDrawnOf 沒抽過回 null');

// --- drawSample：n=20，數量正確、不重複 ---
var sample20 = Sampling.drawSample(sxlItems, sxlDetails, 20);
assertEqual(sample20.length, 20, 'drawSample n=20 回傳 20 項');
assertTrue(uniqueNames(sample20), 'drawSample n=20 品項不重複');
sample20.forEach(function (it) {
  assertTrue(typeof it.name === 'string' && !!it.name, 'drawSample 每項有 name');
  // unit 允許是空字串：品項庫本來就有單位留空的項目（真實庫裡 58 項）。
  // 抽樣要原樣帶出來，畫面才標得出「(缺單位)」讓會計當場補；
  // 這裡若要求非空，抽到那種品項就會偶發失敗（2026-08-07 踩到）。
  assertTrue(typeof it.unit === 'string', 'drawSample 每項有 unit 欄位（可為空字串）');
});

// --- drawSample：n 不足時（大於品項庫全部）→ 全給、不重複 ---
var sampleAll = Sampling.drawSample(sxlItems, sxlDetails, 1000);
assertEqual(sampleAll.length, sxlItems.length, 'drawSample n 超過品項庫 → 全給（實際 ' + sampleAll.length + '）');
assertTrue(uniqueNames(sampleAll), 'drawSample 全給時不重複');

// --- lastDrawn 正確性：用全給結果找特定品項比對 ---
function findByName(sample, name) {
  return sample.filter(function (it) { return it.name === name; })[0];
}

// 肉燥：sxl-gf 唯一出現在 2026-07 異常明細 → lastDrawn='2026-07'
assertEqual(findByName(sampleAll, '肉燥').lastDrawn, '2026-07', '肉燥 lastDrawn=2026-07');

// 鴨血：只出現在 2026-01 異常明細 → lastDrawn='2026-01'
assertEqual(findByName(sampleAll, '鴨血').lastDrawn, '2026-01', '鴨血 lastDrawn=2026-01');

// 王子麵：從未出現在歷史異常明細 → lastDrawn=null
assertEqual(findByName(sampleAll, '王子麵').lastDrawn, null, '王子麵 lastDrawn=null（沒抽過）');

// 多次驗證含歷史品項情境：反覆抽 n=20，只要抽到「肉燥」就必須是 2026-07
var flakyChecked = false;
for (var i = 0; i < 50; i++) {
  var s = Sampling.drawSample(sxlItems, sxlDetails, 20);
  var hit = findByName(s, '肉燥');
  if (hit) {
    flakyChecked = true;
    assertEqual(hit.lastDrawn, '2026-07', '重複抽樣第 ' + i + ' 次抽到肉燥時 lastDrawn=2026-07');
  }
}
assertTrue(flakyChecked, '50 次重複抽樣（n=20/37）至少抽到一次「肉燥」以驗證 lastDrawn');

// --- 純隨機、不排除抽過的品項：ck 店 1-3 月已抽過的品項仍可能被抽出 ---
// （不用斷言一定抽到，只斷言「有歷史記憶」不會被排除在候選池外，即品項庫本身未被過濾）
var ckItems = MockData.items.filter(function (it) { return it.store === 'ck'; });
var ckDetails = MockData.details.filter(function (d) { return d.store === 'ck'; });
var ckSampleAll = Sampling.drawSample(ckItems, ckDetails, 1000);
assertEqual(ckSampleAll.length, ckItems.length, 'ck 全給仍等於品項庫總數（歷史品項未被排除）');

// --- redrawOne：換一項不與現有重複 ---
var current5 = Sampling.drawSample(sxlItems, sxlDetails, 5);
var currentNames = current5.map(function (it) { return it.name; });
var replacement = Sampling.redrawOne(currentNames, sxlItems, sxlDetails);
assertTrue(!!replacement, 'redrawOne 有可換品項時回傳非 null');
assertTrue(currentNames.indexOf(replacement.name) === -1, 'redrawOne 換到的品項不在現有清單中');
assertTrue(typeof replacement.unit === 'string' && !!replacement.unit, 'redrawOne 回傳含 unit');

// --- redrawOne：窮盡（currentNames 涵蓋全部品項庫）→ 回 null ---
var allNames = sxlItems.map(function (it) { return it.name; });
var exhausted = Sampling.redrawOne(allNames, sxlItems, sxlDetails);
assertEqual(exhausted, null, 'redrawOne 窮盡時回 null');

// --- redrawOne：lastDrawn 也正確帶出（用單一目標品項驗證，audit.js 加入品項也靠這個技巧）---
var pickOnly肉燥 = Sampling.redrawOne([], [{ store: 'sxl-gf', name: '肉燥', unit: '包', active: true }], sxlDetails);
assertTrue(!!pickOnly肉燥, 'redrawOne 單一候選池可回傳該品項');
assertEqual(pickOnly肉燥.name, '肉燥', 'redrawOne 單一候選池回傳正確品項名');
assertEqual(pickOnly肉燥.lastDrawn, '2026-07', 'redrawOne 單一候選池也正確帶出 lastDrawn');

// --- drawSample：n=0 回空陣列 ---
assertEqual(Sampling.drawSample(sxlItems, sxlDetails, 0).length, 0, 'drawSample n=0 回空陣列');

// --- active=false 的品項不進候選池 ---
var withInactive = sxlItems.slice(0, 3).concat([{ store: 'sxl-gf', name: '停用品項', unit: '包', active: false }]);
var inactiveSample = Sampling.drawSample(withInactive, sxlDetails, 100);
assertTrue(
  inactiveSample.filter(function (it) { return it.name === '停用品項'; }).length === 0,
  'drawSample 排除 active=false 的品項'
);

if (failures > 0) {
  console.error('\n' + failures + ' 項測試失敗');
  process.exit(1);
} else {
  console.log('\n全部測試通過');
}
