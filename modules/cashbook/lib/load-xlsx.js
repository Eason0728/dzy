/**
 * modules/cashbook/lib/load-xlsx.js — 按「匯出」時才載入 SheetJS mini 版（276 KB，只用 aoa_to_sheet／book_append_sheet／write）。
 * 檔案在 modules/cashbook/vendor/（與現金帳 repo 同一份，授權見 vendor/README.md）；載入失敗回 Error('XLSX_MISSING')。
 */
'use strict';

let pending = null;

export function loadXlsx() {
  if (typeof window !== 'undefined' && window.XLSX) return Promise.resolve(window.XLSX);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/xlsx.mini.min.js', import.meta.url).href;
    s.async = true;
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX_MISSING')));
    s.onerror = () => reject(new Error('XLSX_MISSING'));
    document.head.appendChild(s);
  }).catch((e) => { pending = null; throw e; });
  return pending;
}
