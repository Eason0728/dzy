# 第三方函式庫

## xlsx.full.min.js

SheetJS Community Edition 0.20.3（`xlsx.full.min.js`，含 codepage 表），與損益舊網站 `gas/xlsxLib.html` 內嵌的是同一份（只去掉 HTML 包裝）。
來源：<https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js>
授權：Apache License 2.0（檔頭版權聲明保留）。0.20.3 已修 CVE-2023-30533（prototype pollution）、CVE-2024-22363（ReDoS）。

只在「匯入」頁選檔時由 `lib/load-xlsx.js` 載入；用來**讀**使用者自己選的 POS／薪資匯出檔（`XLSX.read`、`utils.sheet_to_json`），檔案只在瀏覽器解析，不上傳原檔。
升級時：直接換檔、改上面版本號，跑 `node test/pnl-import.test.mjs` 與 e2e t22 pnl import。
