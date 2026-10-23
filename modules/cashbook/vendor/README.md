# 第三方函式庫

## xlsx.mini.min.js

SheetJS Community Edition 0.20.3（`xlsx.mini` 精簡版，276 KB），與現金帳 repo 的 `js/vendor/` 同一份檔。
來源：<https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js>
授權：Apache License 2.0（檔頭版權聲明必須保留）

只在使用者按「匯出 Excel」時才由 `lib/load-xlsx.js` 載入，只用 `utils.aoa_to_sheet`／`utils.encode_cell`／`utils.book_new`／`utils.book_append_sheet`／`write`。
只寫不讀、不解析任何外部檔案，所以 0.18.x 解析端的 prototype pollution CVE 不適用。
升級時：直接換檔、改上面版本號，跑 `node test/cashbook-module.test.mjs` 與 e2e cashbook。
