/**
 * modules/pnl/lib/load-xlsx.js — 進「匯入」頁選檔時才載入 SheetJS（full 版約 0.9 MB，含 codepage；要「讀」xls／xlsx／HTML 表格）。
 * 檔案在 modules/pnl/vendor/（與損益舊網站 gas/xlsxLib.html 同一份 0.20.3，授權見 vendor/README.md）；載入失敗回 Error('XLSX_MISSING')。
 * 不用 modules/cashbook/vendor 的 mini 版：它雖能 read，但沒有 codepage 表，讀舊 BIFF .xls／Big5 檔的中文可能亂碼。
 */
'use strict';

let pending = null;

export function loadXlsx() {
  if (typeof window !== 'undefined' && window.XLSX && window.XLSX.read && window.XLSX.CFB) return Promise.resolve(window.XLSX);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/xlsx.full.min.js', import.meta.url).href;
    s.async = true;
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX_MISSING')));
    s.onerror = () => reject(new Error('XLSX_MISSING'));
    document.head.appendChild(s);
  }).catch((e) => { pending = null; throw e; });
  return pending;
}
