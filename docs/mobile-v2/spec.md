# 手機版改版（2026-11-06）

Eason 2026-11-06 拍板：手機要「直觀、乾淨、明確知道自己要處理哪些事、分類有邏輯」。
討論頁：方案比較 https://claude.ai/artifact/B6UG826TGsecKGyVbQh5Jz 、分類比較 https://claude.ai/artifact/R73fMsc4AH5X1QLqo4LH1W 、
操作預覽 https://claude.ai/artifact/5ABvhcvCqDUrSt4Pjcx4Ng 。決定：照工作分、門市營運一起改、每頁右上角「?」、直接合併部署。

## 範圍

只改 ≤860px（手機）。電腦版側邊欄、首頁卡片、頁名列一行不動。

## 第一段（管理系統外框，本 PR）

| 層 | 內容 |
|---|---|
| 1 底部四格 | 首頁 `#/home`／功能 `#/apps`／待處理 `#/todo`／我 `#/account`（`.m-tabs`），「待處理」掛要緊＋待處理件數 |
| 2 殼頁面 | 首頁＝「你要處理的事」最多 6 件（要緊、待處理兩段）＋「還有 N 件 → 看全部」＋常用 6 格（最近開過的，本機依帳號 `dzy.u.<id>.m_recent`）；功能＝搜尋＋依 `WORK_GROUPS` 分組（人／店／錢／系統設定／公告與我），組名旁「N 件」；待處理＝全部提醒（要緊／待處理／提醒三段）；我＝個人卡＋`accountMenu` 模組的分頁（我的資料）＋修改密碼、問小幫手、重新整理、登出 |
| 3 功能頁 | 上方一行 `.m-bar`：‹（回最近一個殼頁面）、功能名稱、「?」；下面照舊是頁頂分頁 |
| 4 單筆 | 各模組自己的畫面（不動） |

- 資料：首頁與待處理共用 `alertCache`（各模組 `badge()`／`alerts()` 的結果，spec §4.6 不變）。沒有 alerts() 但 badge>0 的模組算一筆「N 件待處理」。
- 分類：manifest 選填 `work`（`platform/config.js WORK_GROUPS`）；選填 `accountMenu: true` 讓分頁列進「我」。**新模組要填 work**（`test/mobile-shell.test.mjs` 會擋）。
- 小幫手：手機收起右下角浮動鈕，「?」與「我 → 問小幫手」都是點那顆隱藏的鈕（`[data-role=aih-fab]`）打開，小幫手程式不動。
- 平台層改動（Eason 同意）：shell.js、config.js、manifest-check.js（新增欄位與保留字 apps／todo／account）、components.css。

## 第二段（2026-11-06 Eason「七點全部一起做」）

| 項目 | 做法 |
|---|---|
| 提醒依「已逾期／今天／這週」排 | `platform/todo.js`：alerts() 每項選填 `when`（overdue／today／week）或 `due`（YYYY-MM-DD，台北今天比）；都沒給：error＝今天、warn＝這週、info＝提醒。已給日期的：考勤（沒核定的天＝已逾期、申請與新手機＝今天）、績效評核（每季第一個月 5 號）、收支月結（每月 10 號） |
| 待處理三段 | 待我處理（可以直接核准的卡片＋全部提醒）／我送出的／已處理。模組選填 `mine(ctx)`、`decided(ctx)`、`quick(ctx)`＋`decide(ctx,id,decision,reason)`，殼只畫（`runModuleHook`）。表單簽核實作 mine（apvMine）；考勤實作四支（營運系統新 action，經代轉 ns attendance） |
| 清單直接核准 | 只開放加班請假申請（考勤）：核准一按就送、退回要寫原因；能不能核由營運系統照考勤管理同一套名單判斷 |
| 考勤新 action | 平台 Auth.gs／dryrun.js：讀 `reqMine`（任何有 DZY 編號的同仁，只看自己）、`reqDecided`、`reqPending`（要 platform.att）；寫 `reqDecide`（要 platform.att）。營運系統在 `/store/api/svc/att-alerts` 依 body.action 分派 |
| 沒有模組權限也看得到「我送出的」（2026-11-10 補） | manifest 選填 `openHooks: ['mine']`（`platform/manifest-check.js OPEN_HOOKS`，**只准 mine**；quick／decide／decided／alerts／badge 不准開）。殼的 `runModuleHook` 對沒有模組權限的人也跑這一支，列出來的項目不給連結（他進不去那個模組）。目前只有考勤管理宣告：一般同仁沒有 `platform.att`，原本「我送出的」永遠是空的。模組的 `mine()`：代轉 403 有兩種來源（沒有同仁編號，或考勤通行碼沒設定），前端分不出來，所以只有系統帳號（角色不是同仁、也不是系統管理者，一定沒有同仁編號）的 403 回空清單；同仁、系統管理者的 403 與其他失敗一律回 null（殼顯示「暫時讀不到」）。測試：`test/att-open-hook.test.mjs`、e2e ㉓ 第 ⑧ 段 |
| 「我」頁標題列 | 姓名＋職稱（小字）（2026-11-06 Eason） |
| 營運系統單獨開 | 手機底部三格（首頁／功能／我），營運系統 PR |

## 已知

- 「重新整理」只是重新載入頁面；GitHub Pages 有 10 分鐘快取，改版當下仍可能拿到舊檔。
- 大部分提醒沒有期限日，靠嚴重度推「今天／這週」；要更準就在該模組 alerts() 補 due。
- 表單簽核沒有「我簽過的」清單後端，所以「已處理」只有考勤。
