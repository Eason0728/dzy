// node test/ops-format.test.js —— 營運稽核的純函式與檢查表本體
// 零依賴、直跑、失敗時 process.exit(1)。

'use strict';

var Format = require('../modules/audit-shared/format.js');
var Checklist = require('../modules/audit-shared/ops-checklist.js');

var failures = 0;

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

// ── 檢查表本體：19 項、四個群組、id 唯一 ─────────────────────────────

assertEqual(Checklist.total, 19, '檢查表共 19 項');

var groups = [];
Checklist.categories.forEach(function (c) {
  c.groups.forEach(function (g) { groups.push(c.cat + '/' + g.name + '=' + g.items.length); });
});
assertEqual(groups, [
  '營運管理/消防安全=7',
  '營運管理/營運=2',
  '品牌形象/環境清潔=6',
  '品牌形象/食安=4'
], '四個群組的項數與來源表一致');

var ids = {};
var dupe = null;
Checklist.flat.forEach(function (it) {
  if (ids[it.id]) dupe = it.id;
  ids[it.id] = true;
});
assertTrue(!dupe, 'id 不重複（重複的是 ' + dupe + '）');
assertEqual(Checklist.flat[0].id, 'c0g0i0', '第一項 id＝c0g0i0');
assertEqual(Checklist.flat[18].id, 'c1g1i3', '最後一項 id＝c1g1i3');
assertEqual(Checklist.byId('c1g1i3').text, '濾心日期是否定期更換', 'byId 取得最後一項全文');
assertEqual(Checklist.byId('沒這個'), null, 'byId 查無回 null');

// 攤平順序＝畫面順序：大類→群組→項目，不可被排序打亂
assertEqual(Checklist.flat.slice(0, 2).map(function (i) { return i.group; }),
  ['消防安全', '消防安全'], '攤平順序從消防安全開始');
assertEqual(Checklist.flat[7].group, '營運', '第 8 項進到「營運」群組');

// ── opsCounts ────────────────────────────────────────────────────────

function mk(verdict, track) { return { verdict: verdict, track: !!track }; }

var allPass = [];
for (var i = 0; i < 19; i++) allPass.push(mk('合格'));
var c1 = Format.opsCounts(allPass, 19);
assertEqual(c1.pass, 19, '全合格：合格數 19');
assertEqual(c1.fail, 0, '全合格：未完成 0');
assertEqual(c1.pending, 0, '全合格：未檢查 0');
assertEqual(c1.pass_rate, 100, '全合格：合格率 100');

var mixed = allPass.slice(0, 17).concat([mk('未完成', true), mk('未檢查')]);
var c2 = Format.opsCounts(mixed, 19);
assertEqual(c2.pass, 17, '17 合格 / 1 未完成 / 1 未檢查：合格數');
assertEqual(c2.fail, 1, '同上：未完成數');
assertEqual(c2.pending, 1, '同上：未檢查數');
assertEqual(c2.track, 1, '同上：追蹤數');
assertEqual(c2.pass_rate, 89, '同上：合格率 17/19＝89（四捨五入）');

// 一項都沒填 → 0%，不是 100%。分母固定＝細項總數，未檢查算在分母裡，
// 「還沒做完」不該長得像「全部合格」。
var c3 = Format.opsCounts([], 19);
assertEqual(c3.pending, 19, '完全沒填：未檢查 19');
assertEqual(c3.pass_rate, 0, '完全沒填：合格率 0（不是 100）');

// total 傳 0/undefined 時退回用清單長度，不會除以 0
var c4 = Format.opsCounts([mk('合格'), mk('未完成')], 0);
assertEqual(c4.total, 2, 'total 給 0 → 退回清單長度');
assertEqual(c4.pass_rate, 50, 'total 給 0 → 合格率仍算得出來');

// ── buildOpsSummary ──────────────────────────────────────────────────

var details = [
  { verdict: '合格', group: '消防安全', text: '一家店至少兩支滅火器', note: '' },
  { verdict: '未完成', group: '消防安全', text: '瓦斯桶是否固定（不傾斜）', note: '後門那桶沒鏈條' },
  { verdict: '未檢查', group: '營運', text: '文宣露出是否依規範執行', note: '' },
  { verdict: '未完成', group: '食安', text: '濾心日期是否定期更換', note: '' }
];
assertEqual(Format.buildOpsSummary(details),
  '1.消防安全－瓦斯桶是否固定（不傾斜）:後門那桶沒鏈條\n2.食安－濾心日期是否定期更換',
  'buildOpsSummary：只收未完成、重新編號、沒說明就不留孤零零的冒號');
assertEqual(Format.buildOpsSummary([]), '', 'buildOpsSummary：沒有未完成回空字串');
assertEqual(Format.buildOpsSummary([{ verdict: '合格', group: 'x', text: 'y' }]), '',
  'buildOpsSummary：全合格回空字串');

// 說明前後空白要修掉，不能讓「只打了空白」被當成有填
assertEqual(Format.buildOpsSummary([{ verdict: '未完成', group: '食安', text: 'A', note: '   ' }]),
  '1.食安－A', 'buildOpsSummary：只有空白的說明視同沒填');

// ── 收尾 ─────────────────────────────────────────────────────────────

if (failures) {
  console.error('\n' + failures + ' 項失敗');
  process.exit(1);
}
console.log('\n全部測試通過');
