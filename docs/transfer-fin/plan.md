# 實作計畫：調撥管理（spec v1.1）

2026-10-26。三個 repo 平行做，最後本機整套串起來點一輪。上線排在收支 → 貨單 → 損益之後；上 main 前先 rebase 到那三個已上線的版本。
本系列不做 Codex 審查（Eason 2026-10-24）。

## 工作區
| repo | 位置 | 分支 |
|---|---|---|
| dzy | `~/dzy-wt-transfer-fin` | transfer-fin-req |
| dzy-minikit | `~/dzy-minikit-wt-transfer` | transfer-proxy |
| mala-transfer（主專案無 git） | `~/mala-transfer-wt-fin`（2026-10-26 複本，本機 git 只當基準，不推） | — |

## 共同契約（三邊照這份）
- 母頁 origin：`https://dzy.mozhuting.com`（本機 `http://localhost:8777`）。子頁：`https://eason0728.github.io/mala-transfer/report.html?embed=dzy`（本機 `http://localhost:8787/report.html?embed=dzy`）。
- 訊息：子→母 `dzy-transfer-ready {v:1}`、`dzy-transfer-call {v:1,id,action,payload}`；母→子 `dzy-transfer-nav {v:1,p}`（p＝report｜memory｜overview）、`dzy-transfer-result {v:1,id,...}`。結果格式逐字照薪酬那一對（dzy `modules/payroll/bridge.js toPageResult` ↔ mala-clock-in `payroll.html` 嵌入端），名稱 payroll→transfer。
- 代轉：ns `transfer`；讀 `bootstrap/adminData/adminOverview/getDoc`；寫 `buildMonthlyReport/adminUpdate`（hook 只放行 op＝memoryEdit|memoryDelete）。
- 密碼：module_secrets `transfer/write`；hook 把 `pin_master`、`operator` 塞進上游 payload（前端夾帶的一律刪掉）。
- 逾時：mini 60 秒、前端 api.js 65 秒、子頁等 70 秒。
- 權限：`transfer.write`（可給、不鎖、標籤「調撥管理」、預設規則 hq/fin/*）。

## 步驟
1. dzy：模組＋registry＋api.js 兩行＋dryrun.js 兩列＋Auth.gs＋Perms.gs＋圖示＋單元測試。
2. minikit：app.json、proxy-hook、設定密碼工具、測試、.env.example、PROXY.md。
3. mala-transfer：Code.gs 會計操作紀錄（純新增）、report.html 嵌入模式＋卡關總覽分頁、mock 測試、verify-ui。
4. 整合：本機三層串起來（8787 ← 8798 ← 8777），e2e 一支，真瀏覽器點三個分頁＋下載＋背景保留。
5. 回報總控，附 Eason 試用方法。
