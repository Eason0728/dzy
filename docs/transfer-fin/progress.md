# 調撥管理（財務部門）進度

## 上線紀錄（2026-10-26）
| 步驟 | 內容 | 版本 |
|---|---|---|
| A | 調撥後端純新增「會計操作紀錄」分頁（橋接流程，部署 ID 不變） | Apps Script @34（回退＝redeploy @33） |
| B | dzy 第一段：平台後端代轉白名單、transfer.write、模組檔（未上選單） | main 2be3679 |
| C | minikit：代轉 ns transfer、set-proxy-secret.js、hook 可回 OP_FORBIDDEN；sync-gas dzy-platform＋transfer 備份 app | main f2a79b4 |
| D | mini 更新＋.env PROXY_URL_TRANSFER＋module_secrets transfer/write（Eason 在 mini 輸入，指紋 fec7bc32）；外網打 ns transfer 回 NO_TOKEN | — |
| E | dzy 第二段：選單登記（收支管理之後、損益系統之前） | main 61772d9 |
| F | 調撥會計頁嵌入模式（GitHub Pages） | mala-transfer web 6f89071 |
| G | Eason 在「權限設定 → 財務部門」打開「調撥管理」 | — |

本系列不做 Codex 審查（Eason 2026-10-24）；上線前 Fable 全面審查一輪，無高嚴重度，修 8 條。

## 待辦
- **約 2026-11-09（過渡兩週到期）**：
  1. 舊會計專區網址改成「已搬家，請到管理系統 → 財務部門 → 調撥管理」說明頁（mala-transfer `report.html` 非嵌入模式，另一次 push）。
  2. 換會計密碼：**新密碼要含英文字母**（代轉會把回應裡出現的密碼字串遮成 `***`，純數字可能誤遮日期或金額）。調撥試算表「設定」的 pin_master 與 mini `node apps/dzy-platform/set-proxy-secret.js transfer` **在同一段停機內一起換**；只換一邊＝代轉帶錯碼，5 次後全公司（含門市刪已簽收單）鎖 10 分鐘。新碼只給需要的人（門市刪已簽收單、總部總覽）。
- mini 的 transfer 只讀備份 app 要等**下次重啟**才會用新的 Code.gs（含會計操作紀錄分頁）；在那之前每晚讀回照常，只是本機副本少這張分頁。
- 列後續、未做：`platform/manifest-check.js` 不認得 `keepAlive`（主控台警告，薪酬／收支也有）；舊網址持有會計密碼者可在紀錄冒名（換密碼後消失）。
