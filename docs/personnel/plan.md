# 技術方案：個人帳號管理（第一期）

依據：`spec.md` v1。三個階段，每階段結束有一個可驗收的里程碑。

## 階段 A：後端（里程碑：mock 沙盒裡整條「匯入→認領→確認→改資料→忘記密碼」跑通）
- Setup.gs 補三個分頁（staff／org／staff_log）＋org 預設內容＋roles 的 staff 列 perms；文字欄鎖純文字。
- 新檔 `Staff.gs`：org 讀取與驗證、staff 讀寫、狀態機、全部新 action handler。
- Auth.gs 只做兩處小改：DZY 帳號大寫正規化、hash 空時的專屬訊息。
- Code.gs：白名單＋MUTATING_ACTIONS＋分派。
- 測試：沿用 `test/users.mock.test.mjs` 的沙盒，新寫 `test/staff.mock.test.mjs`。

## 階段 B：前端（里程碑：本機 devserver＋e2e mock 下，同仁與後台兩種身分都點得通）
- 登入頁連結、claim／forgot 兩個平台畫面。
- `modules/me`、`modules/staff`（registry 各一行）。
- users 模組排除 role＝staff。
- e2e 第八支：認領→後台確認→同仁看到已確認；忘記密碼鎖定。

## 階段 C：上線（里程碑：正式網址可用、113 人建檔完成）
- clasp push → create-version → update-deployment（既有部署 ID）。
- 正式試算表跑一次 Setup 補分頁（只補不覆蓋既有分頁）。
- Eason 在後台「匯入」貼上 113 個名字（Claude 從名單網頁產出純文字給他貼，不經 repo）。
- 先按匯入頁「預覽」核對 DZY001／DZY113 對到的人，再按「建立」（平台沒有 dryrun）。
- 上線前關：Fable＋GPT 互盲審高風險三塊（本案＝身分驗證／忘記密碼、寫正式資料）。

## 風險與對策
| 風險 | 對策 |
|---|---|
| token 撤銷（token_after）改到既有驗證 | 舊 token 沒有 i、帳號沒設 token_after → 照常通過；既有 auth 測試全綠 |
| 改到 Auth.gs 影響既有帳號登入 | 只動 DZY 正規表示式分支；既有 login 測試全部要綠＋新增「admin 帳號大小寫行為不變」測試 |
| 冒用認領 | 後台確認才生效；staffUnclaim 可撤回；待確認者無任何系統權限 |
| 個資外流到 repo | 名單只經匯入頁；測試資料一律假名；**每次 commit 前用名單全部真名 grep 整個 repo（含 docs/、progress.md）**——2026-10-11 progress.md 就曾帶出一個真名 |
| Apps Script 並發 | 寫入類全進 MUTATING_ACTIONS |
| 試算表把生日／手機轉格式 | 寫入前對該列設純文字；比對前正規化（手機補 0、日期物件轉字串） |
