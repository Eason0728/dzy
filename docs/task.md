# 鼎兆元餐飲集團｜管理系統 — 任務清單（task.md）

版本：v1 / 2026-08-14（第 4 份，與 plan.md 一起交付）
上三份：[requirements.md](./requirements.md) v3　｜　[spec.md](./spec.md) v2　｜　[plan.md](./plan.md) v1

**通用規矩（每個任務都適用）**
- 格式定義一律以 spec.md §4 為準，任務內不得自訂代號、欄名、回傳形狀
- 只准動任務列出的檔案；需要動清單外的檔＝停下回報，不動手
- 一律打測試資料，不碰正式列；測完清乾淨
- 沒有部署動作（不 push、不開 Pages、不發群組），只交本機可測版本
- 同一個錯誤修 2 次未解 → 停止，回報完整失敗軌跡

---

## Phase 0：前置與保全

### T0-1　備份兩份正式試算表
- 產出：兩份試算表副本（檔名帶 `-備份-20260814`）、`docs/backup-log.md` 記錄檔名／連結／列數／截圖
- 驗收：☐ 副本存在且可開啟　☐ backup-log.md 記下兩份的**列數**（完工後要比對）
- 註：這一步做完才准動任何其他事

### T0-2　建立專案骨架
- 產出：`~/dzy` git repo（private，不開 Pages）；依 spec §2 建目錄；`.gitignore`（含 `.clasp.json`、`*secret*`、`*.local.*`）；`index.html` 空殼（只有 `<div id="app">` 與 module script 標籤）
- 驗收：☐ `git status` 乾淨　☐ 本機 http server 開得起來且無 console 錯誤
- 約 60 行

### T0-3　建立平台試算表與 Apps Script
- 產出：試算表「鼎兆元管理系統｜帳號權限」四個分頁（`users`／`roles`／`module_secrets`／`login_log`，欄位逐字元照 spec §5.1）；獨立 Apps Script 專案；`apps-script/platform/Setup.gs` 建分頁與五筆預設角色列
- 驗收：☐ 四個分頁欄名與 spec §5.1 完全一致　☐ `roles` 五列（admin／manager／accountant／storelead／staff）權限碼與 spec §4.3 一致　☐ 日期欄位已鎖文字格式
- 約 120 行
- ⚠ 通行碼與密碼**手動填進試算表**，不寫進任何檔案

### T0-4　OAuth 授權（Eason 動手）
- 動作：Eason 在 Apps Script 編輯器手動執行一次 `setup()`，走完同意畫面
- 驗收：☐ web app 匿名 `POST` 回 JSON 而非 403
- 註：`clasp push`／`deploy` 都不會觸發同意畫面，只能人工做一次

---

## Phase 1：平台層地基

### T1-1　設計 token 與基礎樣式
- 動：`platform/css/tokens.css`、`base.css`、`components.css`
- 輸入：spec §8 的色票；手機優先，桌機 `@media (min-width:768px)`
- 輸出：CSS 變數唯一來源；卡片、按鈕、表單、導覽（底部列／側邊欄）的基礎樣式
- 驗收：☐ 375px 寬無橫向捲動　☐ 全專案搜尋 hex 色碼，只在 `tokens.css` 出現
- 約 180 行

### T1-2　共用格式工具 `fmt`
- 動：`platform/fmt.js`、`test/fmt.test.js`
- 輸出：`date(d)` → `YYYY-MM-DD`；`datetime(d)` → `YYYY-MM-DD HH:mm:ss`；`roc(d)` → `民國 YYY 年 M 月 D 日`；`esc(s)` HTML 轉義；`money(n)` → `1,234`
- 做法提示：可抄 `~/mala-audit/js/format.js` 與 `~/mala-dorm-contract/apps-script/Core.gs:109-123`
- 驗收：☐ `node test/fmt.test.js` 全過　☐ 含跨月、跨年、空值、`<script>` 注入五個邊界案例
- 約 120 行

### T1-3　共用 UI 元件 `ui`
- 動：`platform/ui.js`、`platform/css/components.css`（補樣式）
- 輸出：`toast(msg, type)`、`loading(on)`、`confirm(msg) → Promise<bool>`、`dialog({title, body, actions})`、`signaturePad(canvasEl) → {isEmpty, toDataURL, clear}`
- 做法提示：簽名板抄 `~/mala-dorm-contract/sign.html:188-223`，**這是全系統唯一一份**
- 驗收：☐ 手機觸控與桌機滑鼠都能簽　☐ `clear()` 後 `isEmpty()` 為 true　☐ toast 連開三個不重疊
- 約 200 行

### T1-4　平台後端：身分驗證
- 動：`apps-script/platform/Auth.gs`、`test/auth.mock.test.js`
- 輸出：`hashPassword(pw, salt)`（SHA-256 迭代 10,000 次）、`issueToken(user)`／`verifyToken(t)`（HMAC-SHA256，格式照 spec §5.3）、`login`／`me` 兩個 action、錯誤 5 次鎖 15 分鐘
- 驗收：☐ token 竄改任一字元即驗證失敗　☐ 過期 token 被拒　☐ 錯 5 次回鎖定訊息　☐ 回傳的 `secrets` 依 spec §5.2 只給最低一級
- 約 180 行
- ⚠ HMAC SECRET 存 Script Properties，不進 repo

### T1-5　平台後端：人員管理與路由
- 動：`apps-script/platform/Users.gs`、`Code.gs`
- 輸出：`listUsers`／`saveUser`／`setActive`／`resetPassword` 四個 action（都需 `platform.users`）；`Code.gs` 的 `doPost` 白名單分派、統一 `{ok,data}`／`{ok,error}` 回傳
- 驗收：☐ 沒有 `platform.users` 權限呼叫任一個 → 回 `{ok:false}`　☐ `listUsers` 回傳不含 `salt`／`hash`　☐ 未知 action 被拒
- 約 170 行

### T1-6　前端身分層 `auth`
- 動：`platform/auth.js`、`platform/views/login.js`、`test/perm.test.js`
- 輸出：登入畫面；token 存 localStorage（7 天）、`secrets` 只存記憶體；`restore()`／`logout()`；`can(perm)` 支援 `*` 與三段權限碼
- 驗收：☐ `node test/perm.test.js` 全過，含 `admin` 的 `*`、`audit.read.own` 不等於 `audit.read`、未知權限碼回 false　☐ 重新整理仍在登入狀態　☐ 登出後 localStorage 已清
- 約 160 行

### T1-7　後端呼叫層 `api`
- 動：`platform/api.js`、`test/api.mock.test.js`
- 輸出：`call(backend, action, payload)`；三支後端的位址表；回傳轉接成 `{ok,data}`／`{ok,error}`（spec §4.8）；**店長節點裁切在這一處做**（spec §7）
- 驗收：☐ 稽核既有回傳形狀被正確包成 `data`　☐ 宿舍既有形狀同樣　☐ 權限只有 `audit.read.own` 時，回傳的 records／details 只剩自己節點　☐ 網路錯誤回 `{ok:false,error}` 不拋例外
- 約 150 行

### T1-8　殼：路由、導覽、掛載
- 動：`platform/shell.js`
- 輸出：hash 路由 `#/<module>/<view>?<params>`（spec §4.9）；兩層導覽（手機底部列／桌機側邊欄＋模組內分頁）；`mount`／`unmount` 生命週期；首頁卡片＋非同步 `badge()`（逾時 5 秒視同無數字）
- 做法提示：模組內導覽可抄 `~/mala-audit/js/app.js:163-195`（事件委派綁一次，不要逐顆綁）
- 驗收：☐ 非法路由導回 `#/home` 並 toast　☐ 權限不足的分頁不出現　☐ 切模組時前一個模組的 `unmount` 有被呼叫　☐ 某個 `badge()` 拋錯時首頁其他卡片正常
- 約 200 行

### T1-9　模組清單與 manifest 驗證器
- 動：`platform/registry.js`、`platform/manifest-check.js`、`test/manifest.test.js`
- 輸出：模組清單（只有這個檔要為了加模組而改）；manifest 欄位驗證（格式照 spec §4.1／4.5，不合格就在 console 明確報哪個欄位錯，不靜默略過）
- 驗收：☐ `node test/manifest.test.js` 全過　☐ 故意寫錯 `id` 格式會被抓出來並指名欄位
- 約 100 行

### T1-10　★分層驗證：假模組
- 動：新增 `modules/demo/manifest.js`、`modules/demo/index.js`；`platform/registry.js` 加一行
- 輸出：一個只顯示「這是示範模組」與固定 badge 數字 `3` 的模組
- 驗收（**這是 Phase 1 的核心驗收，過不了就要回頭改架構**）：
  ☐ 首頁出現第三張卡片且 badge 顯示 3
  ☐ 能點進去、能用模組內分頁、能返回
  ☐ `git diff` 顯示 `platform/` 底下**除了 `registry.js` 那一行以外零改動**
- 約 60 行

### T1-11　人員管理畫面
- 動：`platform/views/users.js`
- 輸出：使用者清單、新增／編輯（帳號、姓名、角色、所屬節點）、停用、重設密碼；僅 `platform.users` 可見
- 驗收：☐ 建一個店長帳號並指定節點 `sxl-gf`，用它登入後身分正確　☐ 停用後該帳號登入被拒　☐ 節點下拉只有 spec §4.4 的五個代號
- 約 180 行

---

## Phase 2：稽核兩模組搬入

### T2-1　稽核共用資料層
- 動：`modules/audit-shared/api.js`、`test/audit-shared.test.js`
- 輸出：`getAll(ctx)` 記憶體快取 TTL 60 秒、同時進來的呼叫合併成一次請求；`invalidate()`；送出類 action 的封裝
- 驗收：☐ 連續呼叫三次只發一次請求　☐ `invalidate()` 後下次重抓　☐ 兩個模組的 badge 同時跑只發一次請求
- 約 120 行

### T2-2　`audit-stock` manifest ＋ 模組本體 ＋ 總覽
- 動：`modules/audit-stock/manifest.js`、`index.js`、`views/overview.js`
- 做法提示：抄 `~/mala-audit/js/views/overview.js`（204 行），DOM 結構與 class 名原樣保留
- 驗收：☐ 首頁出現「月初盤點抽查」卡片　☐ 總覽數字與舊系統同月份完全一致（並列截圖比對）
- 約 200 行

### T2-3a　`audit-stock` 填寫：抽樣與品項清單
- 動：`modules/audit-stock/views/fill.js`（第一段）、沿用 `~/mala-audit/js/sampling.js`
- 來源：`~/mala-audit/js/views/audit.js`（1157 行）拆三段，這是第一段
- 驗收：☐ 既有 `node test/sampling.test.js` 不改斷言即通過　☐ 抽不滿 20 項時行為與舊版一致（顯示提示，不是報錯）
- 約 200 行

### T2-3b　`audit-stock` 填寫：金庫抽查與只填異常項模式
- 動：`modules/audit-stock/views/fill.js`（第二段）
- 驗收：☐ 零找金／零用金／小費比對欄位與舊版一致　☐「只填異常項」模式切換行為與舊版一致
- 約 200 行

### T2-3c　`audit-stock` 填寫：草稿與送出
- 動：`modules/audit-stock/views/fill.js`（第三段）
- 驗收：☐ 既有 `node test/gas-submit.test.js` 不改斷言即通過　☐ 缺單位會被擋下（沿用既有規則）　☐ 送出後呼叫 `invalidate()`
- 約 180 行

### T2-4　`audit-stock` 報告與異常分析
- 動：`modules/audit-stock/views/report.js`、`views/analysis.js`
- 做法提示：抄 `~/mala-audit/js/views/report.js`（331 行）、`analysis.js`（214 行）
- 驗收：☐ 既有 `node test/format.test.js` 通過　☐ 合格率算出來與舊系統同月份一致
- 約 200 行

### T2-5　`audit-ops` 模組（營運稽核表）
- 動：`modules/audit-ops/manifest.js`、`index.js`、`views/overview.js`、`views/fill.js`、`views/report.js`
- 做法提示：抄 `~/mala-audit/js/views/ops.js`（457 行）、`opsoverview.js`、`opsreport.js`、`js/ops-checklist.js`
- 驗收：☐ 19 項四大類完整　☐ 既有 `node test/ops-format.test.js`、`gas-ops.test.js` 通過　☐「未完成必填說明」「稽核人員必填」兩條規則仍在（那是這張表存在的理由）
- 約 200 行 ×2 任務（拆成 T2-5a 總覽與報告／T2-5b 填寫）

### T2-6　店長視角「我的門市」
- 動：`modules/audit-stock/views/my.js`、`modules/audit-ops/views/my.js`
- 輸出：自己節點的合格率、被抓到的問題、未完成追蹤清單，唯讀，無任何送出按鈕
- 驗收：☐ 用店長帳號登入只看得到自己節點　☐ 手動改 hash 參數指定別店，畫面仍只有自己店　☐ 沒有任何可寫入的控制項
- 約 150 行

### T2-7　既有測試接上新結構
- 動：`test/` 底下八支既有測試的引入路徑
- 驗收：☐ 八支 node 測試全過，**斷言一行未改**　☐ 有任何斷言需要改才能過 → 停下回報（代表行為被改變）
- 約 80 行

### T2-8　`badge()` 實作
- 動：兩個模組的 `index.js`
- 輸出：`audit-ops` → 未完成追蹤項數；`audit-stock` → 本月尚未完成盤點的節點數。店長身分時只算自己節點
- 驗收：☐ 數字與各自模組內畫面顯示一致　☐ 後端掛掉時回 null 且首頁不壞
- 約 100 行

---

## Phase 3：宿舍合約模組搬入

### T3-1　`dorm` 資料層
- 動：`modules/dorm/api.js`、`modules/dorm/manifest.js`
- 輸出：包住既有 `doGet ?action=` 與 `doPost`；`API_URL` 全系統只剩這一處
- 驗收：☐ 全專案搜尋 `API_URL` 只有一處定義　☐ `rooms`／`list`／`contract` 三個讀取類 action 用測試資料呼叫成功
- 約 120 行

### T3-2　合約清單與終止
- 動：`modules/dorm/views/list.js`
- 做法提示：抄 `~/mala-dorm-contract/admin.html:62-122` 的清單段
- 驗收：☐ 清單欄位與舊後台一致　☐ 終止合約要二次確認（用 `ctx.ui.confirm`）　☐ 測試合約終止後狀態正確、事後清乾淨
- 約 180 行

### T3-3　建單與發連結
- 動：`modules/dorm/views/create.js`
- 驗收：☐ 建出的測試合約，`contracts` 分頁欄位與舊系統建的完全一致（並列比對）　☐ 產出的簽約連結能開啟　☐ 租金／押金依 `settings` 計算，數字與舊版一致
- 約 180 行

### T3-4　退宿點交
- 動：`modules/dorm/views/handover.js`
- 做法提示：抄 `~/mala-dorm-contract/handover.html:79-142`；簽名板改用 `ctx.ui.signaturePad`
- 驗收：☐ 設備檢查與賠償計算金額與舊版一致　☐ 簽名寫入成功　☐ PDF 仍正常產出到原雲端資料夾
- 約 200 行

### T3-5　`sign.html` 去重（殼外頁）
- 動：`~/dzy/sign.html`
- 輸出：流程邏輯一行不改，只把 `esc()`、簽名板、日期格式改成 `import` 平台的 `fmt.js`／`ui.js`
- 驗收：☐ 用同一份測試 token 完整簽一次，行為與舊版逐步一致　☐ 全專案 `esc(` 與簽名板初始化各只有一份定義　☐ **舊網址的 `sign.html` 未被更動**
- 約 150 行

### T3-6　`dorm` badge
- 動：`modules/dorm/index.js`
- 輸出：30 天內到期的合約數
- 驗收：☐ 數字與清單篩選結果一致
- 約 60 行

---

## Phase 4：整合驗收與上線

### T4-1　e2e 六支
- 動：`test/e2e/`
- 內容：①登入→首頁卡片正確 ②會計看不到宿舍 ③店長只看自己店 ④切模組不重載頁面 ⑤稽核既有八支 ⑥宿舍建單→簽約→點交全流程
- 驗收：☐ 全過（一次跑一支、間隔 20 秒；`Errno 48` 是 port 沒釋放不是測試失敗，要確認有輸出，不能只 grep「通過」）

### T4-2　分層回歸驗證
- 動作：再加一個假模組（模擬調撥），確認平台層零改動
- 驗收：☐ `git diff platform/` 只有 `registry.js` 一行

### T4-3　視覺收尾
- 動：`assets/icons/`、首頁卡片版面
- 註：圖示配色沿用既有慣例（小辛辣用干鍋 emblem、鼎兆元用墨竹亭竹葉，靠底色＋字色區分）
- 驗收：☐ 三個模組圖示不撞色　☐ 375px 與 1280px 兩種寬度截圖各一張給 Eason 過目

### T4-4　資料保全比對
- 驗收：☐ 兩份正式試算表列數與內容與 T0-1 備份一致　☐ 測試資料已全數清除（`cleanupTestContracts`／`cleanupE2E`）

### T4-5　上線
- 動作：repo 轉 public ＋ 開 Pages；建立正式帳號（會計 1、部門主管 n、店長 5）；確認舊網址仍正常
- ⚠ **轉 public 與開 Pages 前先問 Eason**（員工看得到）
- 驗收：☐ 新網址可登入　☐ 舊網址 `/mala-audit`、`/mala-dorm` 仍正常　☐ repo 內無任何通行碼或密碼

### T4-6　收尾寫回（上線當下就做，不延後）
- 動作：
  - 記憶庫寫一則專案記憶 ＋ `MEMORY.md` 加一行
  - `~/.claude/CLAUDE.md` 路由表加一列（關鍵詞 → skill）
  - `~/.claude/mala-ops/dispatch-rules.md` 第 2 節加一列（skill／模型／驗收條件／停損訊號）、第 5 節常用路徑加一列（repo、script id、部署 id、試算表 id）
  - 建立 `dzy-admin` skill（結尾附「收尾：自我改進」區塊）
- 驗收：☐ 四處都寫了　☐ 版本戳已更新
- 註：專案上線當下沒寫記憶，下一個 session 會把它當成不存在——這是 2026-07-31 踩過的雷

---

## 任務相依圖（可平行的放同一列）

```
T0-1 → T0-2 → T0-3 → T0-4(Eason)
                        ↓
        ┌───────────────┼───────────────┐
      T1-1            T1-2            T1-4
        │               ↓               ↓
        │             T1-3            T1-5
        └───────────────┴───────┬───────┘
                              T1-6 → T1-7 → T1-8 → T1-9 → T1-10★ → T1-11
                                                                      ↓
                                            ┌─────────────────────────┴──┐
                                          T2-1                         T3-1
                                            ↓                            ↓
                              T2-2 → T2-3a → T2-3b → T2-3c → T2-4    T3-2 → T3-3 → T3-4 → T3-5
                                            T2-5a／T2-5b（可平行）          T3-6
                                            T2-6 → T2-7 → T2-8
                                                        ↓
                                          T4-1 → T4-2 → T4-3 → T4-4 → T4-5 → T4-6
```

Phase 2 與 Phase 3 在 T1 完成後可平行推進（兩組人／兩個 subagent 互不相依）。
