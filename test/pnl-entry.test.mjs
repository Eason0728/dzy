/**
 * 損益試算「填資料」純函式（modules/pnl/views/entry-lib.js）：類別分組、待補／選填／已填、分攤提示、附件檢查、附件 id 解析、尺寸縮放。
 */
import assert from 'node:assert/strict';
import {
  CATS, catOf, fmtInt, accountsByBlock, isFilled, isOptionalEmpty, sortOptionalLast, pendingGroups, categoryBlocks,
  sourceLabel, sourceSummary, showConfirmZero, validateAdd, splitHint, feeHint, fitSize, classifyFile, checkBase64,
  attachFileId, attachKind, ATTACH_MAX_BASE64
} from '../modules/pnl/views/entry-lib.js';
import { mountEntry } from '../modules/pnl/views/entry.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

const A = (acc_id, block, mode, extra) => Object.assign({ acc_id, block, mode, name: acc_id, active: true, sort: Number(acc_id.slice(1)), params: {} }, extra || {});
const ACCS = [
  A('A1', '食材', '手動'), A('A2', '食材', '手動'), A('A3', '包材', '連接器'), A('A4', '人事', '手動'), A('A5', '可控', '固定'),
  A('A6', '可控', '手動', { params: { optional: true } }), A('A7', '營業稅', '手動'), A('A8', '營收', '匯入'), A('A9', '食材', '手動', { active: false }),
  A('A10', '營業外收入', '手動')
];
const ENTRIES = [{ acc_id: 'A2', amount: 5, void: false }, { acc_id: 'A4', amount: 9, void: true }, { acc_id: 'A10', amount: 0, void: false }];
const PENDING = ['A1', 'A3', 'A4', 'A7', 'A8'];

t('export：mountEntry 是函式、五類對照舊網站', () => {
  assert.equal(typeof mountEntry, 'function');
  assert.deepEqual(CATS.map((c) => c.key), ['food', 'labor', 'controllable', 'uncontrollable', 'revenue']);
  assert.deepEqual(catOf('uncontrollable').blocks, ['不可控', '營業稅', '營業外收入']);
  assert.deepEqual(catOf('food').blocks, ['食材', '包材']);
  assert.equal(catOf('pending'), null);
});
t('停用科目不列、區塊內依 sort 排序', () => {
  assert.deepEqual(accountsByBlock(ACCS)['食材'].map((a) => a.acc_id), ['A1', 'A2']);
});
t('已填／選填判斷：固定公式算已填、待補不算已填、選填無明細不算待補', () => {
  const ps = { A1: true, A3: true, A4: true, A7: true, A8: true };
  const ls = { A2: true, A10: true };
  assert.equal(isFilled(ACCS[1], ps, ls), true);
  assert.equal(isFilled(ACCS[0], ps, ls), false);
  assert.equal(isFilled(ACCS[4], ps, ls), true);
  assert.equal(isOptionalEmpty(ACCS[5], ps, ls), true);
  assert.equal(isOptionalEmpty(ACCS[0], ps, ls), false);
  assert.deepEqual(sortOptionalLast([ACCS[5], ACCS[4]], ps, ls).map((a) => a.acc_id), ['A5', 'A6']);
});
t('待補總覽：依類別分組、不列已填／選填、總數正確；0 項', () => {
  const g = pendingGroups(ACCS, PENDING, ENTRIES);
  assert.deepEqual(g.groups.map((x) => [x.cat.key, x.accs.map((a) => a.acc_id)]),
    [['food', ['A1', 'A3']], ['labor', ['A4']], ['uncontrollable', ['A7']], ['revenue', ['A8']]]);
  assert.equal(g.total, 5);
  const none = pendingGroups(ACCS, [], ACCS.map((a) => ({ acc_id: a.acc_id, amount: 1, void: false })));
  assert.equal(none.total, 0);
  assert.deepEqual(none.groups, []);
});
t('類別完整資料：待補、已填、選填、固定全列；選填排最後', () => {
  const food = categoryBlocks(ACCS, PENDING, ENTRIES, 'food');
  assert.deepEqual(food.map((x) => [x.block, x.accs.map((a) => a.acc_id)]), [['食材', ['A1', 'A2']], ['包材', ['A3']]]);
  assert.deepEqual(categoryBlocks(ACCS, PENDING, ENTRIES, 'controllable')[0].accs.map((a) => a.acc_id), ['A5', 'A6']);
  assert.deepEqual(categoryBlocks(ACCS, PENDING, ENTRIES, 'uncontrollable').map((x) => x.block), ['營業稅', '營業外收入']);
  assert.deepEqual(categoryBlocks(ACCS, PENDING, ENTRIES, 'nope'), []);
});
t('來源標示與多來源加總', () => {
  assert.equal(sourceLabel('連接器:現金帳'), '現金帳（連接器）');
  assert.equal(sourceLabel('手動'), '手動');
  assert.equal(sourceSummary([{ source: '手動', amount: 1 }, { source: '手動', amount: 2 }]), '');
  assert.equal(sourceSummary([{ source: '連接器:現金帳', amount: 1300 }, { source: '連接器:薪資', amount: 500 }]), '來源：現金帳（連接器） NT$ 1,300＋薪資（連接器） NT$ 500');
});
t('確認為 0：只給待補的手動／連接器；連接器當月（含未來月）不給；月份列未建立不給；唯讀不給', () => {
  const man = A('A1', '食材', '手動'), con = A('A3', '包材', '連接器');
  assert.equal(showConfirmZero(man, true, true, true, '2026-08', '2026-11'), true);
  assert.equal(showConfirmZero(con, true, true, true, '2026-08', '2026-11'), true);
  assert.equal(showConfirmZero(con, true, true, true, '2026-11', '2026-11'), false);
  assert.equal(showConfirmZero(con, true, true, true, '2026-12', '2026-11'), false);
  assert.equal(showConfirmZero(man, true, true, false, '2026-08', '2026-11'), false);
  assert.equal(showConfirmZero(man, false, true, true, '2026-08', '2026-11'), false);
  assert.equal(showConfirmZero(man, true, false, true, '2026-08', '2026-11'), false);
  assert.equal(showConfirmZero(A('A8', '營收', '匯入'), true, true, true, '2026-08', '2026-11'), false);
});
t('新增驗證與分攤提示', () => {
  assert.deepEqual(validateAdd('1000', '2'), { ok: true, amount: 1000, split_months: 2 });
  assert.equal(validateAdd('', '1').ok, false);
  assert.equal(validateAdd('-1', '1').ok, false);
  assert.equal(validateAdd('10', '0').ok, false);
  assert.equal(validateAdd('10', 'x').ok, false);
  assert.equal(splitHint('1000', '4'), '本月認列＝金額÷月數＝NT$ 250');
  assert.equal(splitHint('1000', '1'), '');
  assert.equal(splitHint('', '3'), '');
  assert.equal(feeHint({ params: { fee: 15 } }), '填對帳單金額，手續費 NT$15 系統自動加');
  assert.equal(feeHint({ params: {} }), '');
});
t('金額格式', () => {
  assert.equal(fmtInt(1234567), '1,234,567');
  assert.equal(fmtInt(-1200), '−1,200');
  assert.equal(fmtInt(undefined), '—');
});
t('圖片縮放：長邊 1600px 以內、不放大', () => {
  assert.deepEqual(fitSize(4000, 2000, 1600), { w: 1600, h: 800 });
  assert.deepEqual(fitSize(1000, 3200, 1600), { w: 500, h: 1600 });
  assert.deepEqual(fitSize(800, 600, 1600), { w: 800, h: 600 });
});
t('選檔：HEIC 擋下、PDF 照傳、圖片壓縮、其他格式擋下', () => {
  assert.ok(classifyFile({ name: 'a.HEIC', type: '' }).error);
  assert.ok(classifyFile({ name: 'a.jpg', type: 'image/heic' }).error);
  assert.equal(classifyFile({ name: 'a.pdf', type: 'application/pdf' }).kind, 'pdf');
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }).kind, 'image');
  assert.equal(classifyFile({ name: 'a.png', type: '' }).kind, 'image');
  assert.ok(classifyFile({ name: 'a.docx', type: 'application/msword' }).error);
});
t('大小上限＝base64 3,900,000 字元（約 2.9MB）', () => {
  assert.equal(checkBase64('abc'), null);
  assert.equal(ATTACH_MAX_BASE64, 3900000);
  assert.equal(checkBase64('a'.repeat(ATTACH_MAX_BASE64)), null);
  assert.match(checkBase64('a'.repeat(ATTACH_MAX_BASE64 + 1)), /上限約 2\.9MB/);
  assert.ok(checkBase64(''));
});
t('附件 id：pnlfile 整串、drive 網址取 ID、其他 null', () => {
  assert.equal(attachFileId('pnlfile:S01/2026-08/abc.jpg'), 'pnlfile:S01/2026-08/abc.jpg');
  assert.equal(attachFileId('https://drive.google.com/file/d/1AbC_d-9/view?usp=drivesdk'), '1AbC_d-9');
  assert.equal(attachFileId('https://evil.example/x'), null);
  assert.equal(attachFileId(''), null);
  assert.equal(attachKind('image/jpeg'), 'image');
  assert.equal(attachKind('application/pdf'), 'pdf');
  assert.equal(attachKind('text/html'), 'none');
});

console.log('\n' + n + ' passed');
