# 技術方案：個人帳號第二期｜依單位＋職稱給系統權限

- 版本：v1（2026-10-17）；依據 spec v1（已確認）
- 工作資料夾：`~/dzy-wt-perm`（branch `perm-phase2`，從 origin/main 開；~/dzy 常被別的對話佔用，不在那裡改）

## 里程碑
| Phase | 目標 | 完成判準 | 對外可見 |
|---|---|---|---|
| P1 後端計算 | `Perms.gs`：三張表、setupPerms_、permCompute_、白名單與鎖 | `test/perms.mock.test.mjs` 全綠；既有 23 支 node 測試全綠 | 否 |
| P2 後端接線 | authPermsWithGate_ 接 permCompute_；proxyAuthorize_ 陣列裁切；7 個新 action；org 初始值修正 | proxy-authorize、users、staff、org-upgrade 測試全綠＋新案例 | 否 |
| P3 mini 裁切 | minikit `proxy-hook.js` 陣列裁切＋與前端同組案例；sync-gas | minikit 測試全綠；sync-gas 成功 | 否（mini 尚未 pull） |
| P4 前端 | `modules/perms`、我的資料「我能用的功能」、稽核 manifest、api.js 陣列裁切、dryrun 讀清單 | node 前端測試＋e2e 全八支＋新 t11 全綠（看 exit code） | 否（未 push） |
| P5 階段關 | Fable＋GPT 互盲審高風險三塊（提權、裁切、部署相容）；issue 記錄 | 兩邊都挑到的修完；單邊的讀碼判斷 | 否 |
| P6 上線 | 照 spec §10 五步 | 店長／區督導／會計／人資真機各測一次 | 是 |

## 共用契約（逐字元）
- 規則 id：`R` + 三位數（`R001`）；例外 id：`X` + 三位數（`X001`）；超過 999 自然延長位數（`R1000`）。
- `ladder` 值：`store`｜`office`｜`hq`（＝org 分頁 unit 列第 5 欄 ladder 的值，ck 為 `store`）。
- `title`：org title 代碼或單一字元 `*`。`dept`：org dept 代碼或空字串 `''`。
- `until`：`YYYY-MM-DD`（例 `2026-10-31`）或 `''`；有效＝`今天台北日期 <= until`（字串比較）。
- 權限碼白名單 `PERM_GRANTABLE`（順序即畫面順序）：
  `['audit.read.own','audit.read.brand','audit.read','audit.write','dorm.read','dorm.write','platform.staff','platform.users','platform.permmap']`
- 鎖碼 `PERM_LOCKED`：`['platform.users','platform.permmap','audit.write','platform.staff']`（四碼，已由 spec 13.2 擴大取代原兩碼）。
- scope 形狀：`{ audit: 'all' | 'none' | ['sxl-gf', ...] }`（陣列已去重、依代碼排序）。
- `filterNode`（proxyAuthorize_ 回傳）：`null` | `'sxl-gf'` | `['sxl-gf','mzt-gf']`；`[]`＝全部裁空。
- 裁切函式語意（前端與 mini 逐字一致）：列物件有 `store` 欄且 `filterNode` 為字串 → 保留 `row.store === filterNode`；為陣列 → 保留 `filterNode.indexOf(row.store) !== -1`。

## 分層
- 平台層改動：`apps-script/platform/*`、`platform/api.js`、`platform/dryrun.js`、`platform/registry.js` 一行。這是平台功能（權限），不是加模組，允許改 platform/。
- 模組層：`modules/perms/`（新）、`modules/me/`（加一塊）、`modules/audit-stock`、`modules/audit-ops` 只改 manifest。

## 風險與對策
| 風險 | 對策 |
|---|---|
| 職稱→權限算錯造成越權 | permCompute_ 是純函式（輸入 staff 列＋三表，輸出 perms／scope），表格驅動測試；鎖碼後端強制 |
| 前端與 mini 裁切不一致 | 同一份案例 JSON 兩邊測 |
| mini 的假試算表把數字字串轉數字 | 所有代碼比對先 String() |
| sync-gas 要乾淨工作樹 | 在 ~/dzy-wt-perm 做，不碰 ~/dzy |
| 白天推前端 | 晚上推；先 mini 後前端 |
