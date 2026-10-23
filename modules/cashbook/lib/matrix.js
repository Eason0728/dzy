/**
 * modules/cashbook/lib/matrix.js — 匯出 Excel 的資料組裝（逐欄移植自現金帳 ~/mala-cashbook/js/export.js、js/calc.js）
 * 欄位、排序、合計列、檔名、欄寬、千分位全部與現金帳現行相同，會計拿到的檔不變。
 * 純函式：不碰 DOM；要寫成 xlsx 時由呼叫端把 XLSX 函式庫傳進 toWorkbook()，node 測試可直接驗 matrix。
 */
'use strict';

export const EXPORT_HEADERS = ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額',
  '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間'];
const VOID = '作廢';

function isLive(r) { return !!r && r.status !== VOID; }

/* 有統一發票：金額是含稅價，未稅＝金額÷1.05 四捨五入，稅額＝差額。
   沒發票（收據）：未稅＝金額、稅額 0。
   一律用「稅額＝金額−未稅」而不是各自四捨五入，未稅＋稅額才會恰好等於金額。（calc.js splitTax） */
export function splitTax(amount, hasInvoice) {
  const amt = Math.round(Number(amount) || 0);
  if (!hasInvoice) return { net: amt, tax: 0 };
  const net = Math.round(amt / 1.05);
  return { net, tax: amt - net };
}

/* 當月三個數字：支出、收入、淨額（收入−支出）。作廢的不算。（calc.js summarize） */
export function summarize(rows) {
  let expense = 0, income = 0, count = 0;
  (rows || []).filter(isLive).forEach((r) => {
    const amt = Number(r.amount) || 0;
    if (r.kind === '收入') income += amt; else expense += amt;
    count++;
  });
  return { expense, income, net: income - expense, count };
}

/* 匯出的資料列：一列一筆，欄位順序＝EXPORT_HEADERS，作廢的不出；依日期、支出先於收入、收據編號排序。
   金額三欄回數字型別（不是字串），Excel 才套得上千分位格式。（calc.js buildExportRows） */
export function buildExportRows(rows) {
  return (rows || []).filter(isLive).slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === '支出' ? -1 : 1;
    return (Number(a.seq) || 0) - (Number(b.seq) || 0);
  }).map((r) => [
    r.store || '', r.date || '', r.kind || '', r.subject || '', r.name || '',
    Number(r.net) || 0, Number(r.tax) || 0, Number(r.amount) || 0,
    r.hasInvoice ? '有' : '無', Number(r.seq) || 0,
    r.photo || '', r.author || '', r.createdAt || ''
  ]);
}

/* 資料後面空一列，再接三列合計，跟紙本的「總金額」對得上。（export.js buildMatrix） */
export function buildMatrix(rows) {
  const data = buildExportRows(rows);
  const sum = summarize(rows);
  const matrix = [EXPORT_HEADERS].concat(data);
  matrix.push([]);
  matrix.push(['支出合計', '', '', '', '', '', '', sum.expense]);
  matrix.push(['收入合計', '', '', '', '', '', '', sum.income]);
  matrix.push(['淨額', '', '', '', '', '', '', sum.net]);
  return matrix;
}

/** 檔名：現金收支_<店名>_<YYYY-MM>.xlsx（export.js baseName＋副檔名；本機測試後綴只在現金帳 local 模式，這裡沒有） */
export function fileName(storeName, month) {
  return '現金收支_' + (storeName || '') + '_' + month + '.xlsx';
}

// 未稅價／稅額／金額這三欄（含最後的合計）套千分位，會計對帳才看得快
export const MONEY_COLS = [5, 6, 7];
// 欄寬照欄位實際會裝的東西給，不然日期跟登記時間會擠成 ####
export const COL_WIDTHS = [10, 12, 8, 14, 22, 10, 8, 10, 6, 10, 28, 10, 20];
export const SHEET_NAME = '明細';

/** matrix → SheetJS workbook（XLSX＝函式庫物件；工作表名「明細」） */
export function toWorkbook(XLSX, matrix) {
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  for (let r = 1; r < matrix.length; r++) {
    MONEY_COLS.forEach((c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    });
  }
  ws['!cols'] = COL_WIDTHS.map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return wb;
}

/** 產 xlsx 位元組（ArrayBuffer／Uint8Array，視函式庫而定） */
export function toXlsxBytes(XLSX, rows) {
  return XLSX.write(toWorkbook(XLSX, buildMatrix(rows)), { bookType: 'xlsx', type: 'array' });
}
