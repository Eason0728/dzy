// node test/api.mock.test.js —— 零依賴、直跑、失敗時 process.exit(1)
var Api = require('../modules/audit-shared/legacy-api.js');
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

function assertTrue(cond, label) {
  if (!cond) {
    failures++;
    console.error('FAIL: ' + label);
  } else {
    console.log('PASS: ' + label);
  }
}

function findRecord(records, store, month) {
  return records.filter(function (r) { return r.store === store && r.month === month; })[0];
}

async function main() {
  // --- auth：兩碼角色正確＋錯碼 ok:false ---
  var acc = await Api.auth('1234');
  assertEqual(acc.ok, true, 'auth 會計碼 ok');
  assertEqual(acc.role, 'accountant', 'auth 會計碼角色 accountant');

  // 不需通行碼（Eason 2026-08-01 指定）：任何碼、甚至空字串一律 accountant
  var view = await Api.auth('5678');
  assertEqual(view.ok, true, 'auth 任意碼 ok');
  assertEqual(view.role, 'accountant', 'auth 任意碼角色 accountant（不需通行碼）');

  var blank = await Api.auth('');
  assertEqual(blank.ok, true, 'auth 空字串 ok');
  assertEqual(blank.role, 'accountant', 'auth 空字串角色 accountant');

  // --- getAll 形狀 ---
  var all = await Api.getAll('1234');
  assertEqual(all.ok, true, 'getAll ok');
  assertTrue(!!all.config, 'getAll 含 config');
  assertTrue(Array.isArray(all.items), 'getAll 含 items 陣列');
  assertTrue(Array.isArray(all.records), 'getAll 含 records 陣列');
  assertTrue(Array.isArray(all.details), 'getAll 含 details 陣列');

  var blankAll = await Api.getAll('');
  assertEqual(blankAll.ok, true, 'getAll 空字串碼仍 ok:true（不需通行碼）');

  var storeCodes = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'];
  storeCodes.forEach(function (code) {
    var count = all.items.filter(function (it) { return it.store === code; }).length;
    assertTrue(count >= 30, 'getAll 品項庫 ' + code + ' >= 30（實際 ' + count + '）');
  });

  // records 涵蓋 1–7 月真實摘錄筆數
  assertEqual(findRecord(all.records, 'sxl-gf', '2026-01').correct_count, 16, 'sxl-gf 2026-01 correct_count=16');
  assertEqual(findRecord(all.records, 'sxl-gf', '2026-01').status, '已稽核', 'sxl-gf 2026-01 status=已稽核');
  assertEqual(all.records.filter(function (r) { return r.store === 'sxl-gf'; }).length, 7, 'sxl-gf 1-7月共7筆 record');
  assertEqual(findRecord(all.records, 'ck', '2026-04').status, '輪休', 'ck 2026-04 輪休');
  assertEqual(findRecord(all.records, 'mzt-js', '2026-07').correct_count, 17, 'mzt-js 2026-07 correct_count=17');
  assertEqual(findRecord(all.records, 'mzt-gf', '2026-03').correct_count, 16, 'mzt-gf 2026-03 correct_count=16');
  assertEqual(findRecord(all.records, 'mzt-lzl', '2026-06').correct_count, 17, 'mzt-lzl 2026-06 correct_count=17');
  assertEqual(findRecord(all.records, 'mzt-lzl', '2026-07'), undefined, 'mzt-lzl 2026-07 未記錄（無 record）');

  // --- submitAudit：新增 sxl-gf_2026-08 ---
  var newRecord = {
    record_key: Format.recordKey('sxl-gf', '2026-08'),
    store: 'sxl-gf',
    month: '2026-08',
    status: '已稽核',
    audit_date: '2026-08-05',
    sample_count: 20,
    correct_count: 20,
    correct_rate: 100,
    change_fund: '正確',
    petty_cash: '正確',
    tip_amount: 500,
    tip_match: '相符',
    anomaly_text: '',
    note: '',
    submitted_at: '2026-08-05T10:00:00+08:00'
  };
  var subRes = await Api.submitAudit('1234', newRecord, []);
  assertEqual(subRes.ok, true, 'submitAudit ok');
  assertEqual(subRes.record_key, 'sxl-gf_2026-08', 'submitAudit 回傳 record_key');

  var afterSubmit = await Api.getAll('1234');
  var found = findRecord(afterSubmit.records, 'sxl-gf', '2026-08');
  assertTrue(!!found, 'submitAudit 後 getAll 可見新紀錄');
  var countAfterFirst = afterSubmit.records.length;

  // 同 key 重送：records 總數不變、內容更新，details 舊列消失新列存在
  var newRecord2 = JSON.parse(JSON.stringify(newRecord));
  newRecord2.correct_count = 18;
  newRecord2.correct_rate = 90;
  var details2 = [{
    record_key: 'sxl-gf_2026-08', store: 'sxl-gf', month: '2026-08',
    item: '測試品項', unit: '包', book_qty: 5, recount_qty: 4,
    verdict: '異常', reason: '未分類', note: ''
  }];
  await Api.submitAudit('1234', newRecord2, details2);

  var afterSubmit2 = await Api.getAll('1234');
  assertEqual(afterSubmit2.records.length, countAfterFirst, 'submitAudit 同 key 重送 records 總數不變');
  var found2 = findRecord(afterSubmit2.records, 'sxl-gf', '2026-08');
  assertEqual(found2.correct_count, 18, 'submitAudit 同 key 重送內容更新');

  var detailsForKey = afterSubmit2.details.filter(function (d) { return d.record_key === 'sxl-gf_2026-08'; });
  assertEqual(detailsForKey.length, 1, 'details 舊列消失新列存在（僅剩新列 1 筆）');
  assertEqual(detailsForKey.length ? detailsForKey[0].item : null, '測試品項', 'details 新列內容正確');

  // 不需通行碼：不帶碼也能送出
  var subNoCode = await Api.submitAudit('', newRecord, []);
  assertEqual(subNoCode.ok, true, 'submitAudit 空字串碼成功（不需通行碼）');

  // --- markRest('ck','2026-08') ---
  var restRes = await Api.markRest('1234', 'ck', '2026-08');
  assertEqual(restRes.ok, true, 'markRest ok');

  var afterRest = await Api.getAll('1234');
  var ckAug = findRecord(afterRest.records, 'ck', '2026-08');
  assertTrue(!!ckAug, 'markRest 後 getAll 可見該筆');
  assertEqual(ckAug.status, '輪休', 'markRest 後 status=輪休');

  if (failures > 0) {
    console.error('\n' + failures + ' 項測試失敗');
    process.exit(1);
  } else {
    console.log('\n全部測試通過');
  }
}

main().catch(function (err) {
  console.error('測試執行錯誤: ' + (err && err.stack || err));
  process.exit(1);
});
