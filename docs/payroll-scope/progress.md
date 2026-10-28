# 薪酬依負責門市分權限 — 進度

> 規格 `spec.md`、實作計畫 `plan.md`、上線步驟 `release.md`。更新：2026-10-29。
> **目前狀態：程式與本機整合實測完成，三個 repo 的分支都還沒 push、沒上線。** 上線由 Eason 依 `release.md` 執行。

## Task 狀態

| Task | 內容 | repo／分支 | commit | 狀態 |
|---|---|---|---|---|
| 1 | 薪資後端 scope 守門與回應裁切（`Payroll.gs`，94 項測試） | mala-clock-in `payroll-scope` | `3a7afa3` | 完成（有備註：守門比對用 trim＋大寫，handler 仍用原字串；`scope:null` 視為 `scope_bad`） |
| 2 | 薪資頁依 scope 調整畫面（`payroll.html`） | mala-clock-in `payroll-scope` | `a4b1e49` | 完成 |
| 3 | 平台負責門市碼 `payroll.store@`、代轉回傳 scope、差異清單套門市 | dzy `payroll-scope` | `269cb42` | 完成 |
| 4 | Mac mini 代轉強制帶 scope、gas 同步 | dzy-minikit `payroll-scope` | `8cb53b1` | 完成（有備註：mini 先於平台後端更新會讓薪酬代轉 400，所以順序是平台後端先） |
| 5 | 權限設定畫面「薪酬：負責門市」、集團總覽分頁只給 admin | dzy `payroll-scope` | `134a510` | 完成 |
| 6 | 本機三層整合實測＋上線交辦 | dzy `payroll-scope` | 本次 docs commit（`release.md`、`progress.md`） | 實測完成（下節）；上線交辦已寫 |

各 repo 基底：mala-clock-in 的 `payroll-staff-sync` 已併入 main（#11），分支與 main 乾淨合併；dzy 的 main 已含 #52、#53，分支與 main 乾淨合併；minikit 分支可快轉。dzy 合併後的 18 個平台 `.gs` 與 minikit `apps/dzy-platform/gas/` 逐檔相同（已驗）。

## 本機整合實測（2026-10-29）

做法：minikit 執行器跑 dzy-platform app 複本（gas＝minikit 分支的 18 檔，與 dzy 合併後一致；`.env` 只有代轉網址與 `PERMS_ON=1`）→ 上游是載入**真的** `Payroll.gs`（vm、記憶體假資料、假金鑰）的 HTTP 服務 → 前端用 dzy 複本（只改 `platform/config.js` 的後端位址）＋ mala-clock-in 分支的 `payroll.html`（原樣，用本機 localhost 嵌入）。全部假帳號（一個 admin、兩位財務同仁）、假門市資料；全部放在 session 暫存區，不在任何 repo。

證明了：

- 平台 `proxyAuthorize_` → mini 的 `proxy-hook` → 上游收到的 `body.scope` 正確：admin＝`'*'`（瀏覽器自帶 `scope:['ZZ']` 被覆寫）；負責 CF 的人＝`['CF']`；沒負責任何門市的人＝`[]`；瀏覽器自帶 `scope:'*'` 被覆寫。操作人與假管理金鑰都由 mini 帶入。
- 上游（真 `Payroll.gs`）：負責 CF 的人打 SSLGF 的 `payroll_month`→`scope_forbidden`、`payroll_group`→`scope_forbidden`，打 CF 照常；`payroll_master_get` 回應沒有 `clock_ss_id`、沒有 CF 以外的店碼，`scope` 欄位＝`['CF']`；沒指派的人 `master_get` 回空殼 `scope:[]`。
- 平台寫入路徑：admin 用真的 `permExSave` 新增 `payroll.store@CF` 被接受（Task 3 驗證）。
- 瀏覽器（Playwright，1280 寬）三種身分：
  - admin：8 家門市、頁頂有「集團總覽」、門市設定與紅字同步在。
  - 負責 CF 的財務同仁：頁頂沒有「集團總覽」、門市只有央廚、參數卡「只套用到目前門市」五個勾選都勾起且鎖住、門市設定與紅字同步看不到。
  - 沒指派門市的財務同仁：整頁只顯示「尚未指派負責門市，請洽系統管理者」。
  - 在財務同仁頁面（從薪資頁 iframe 內以 `postMessage` 送 `dzy-payroll-call`）送 `store:'SSLGF'` 的 `payroll_month`→ 回 `scope_forbidden`；送 `payroll_group`→ `scope_forbidden`。

沒做／沒證明：

- 沒打任何正式環境（正式權限資料只在 Mac mini；本機用假資料）。正式的 Apps Script 執行環境（`clasp` 部署後的行為、redeploy 延遲）要靠 `release.md` 步驟 1-D 的探針驗。
- 上游是 vm 載入的 `Payroll.gs` 加假資料：`payroll_calc`／`payroll_finalize` 等需要打卡試算表資料的動作沒有端到端跑（它們的守門測試在 mala-clock-in `tests/payroll-scope.test.js`，23 支白名單動作逐一）。
- 沒有逐項點過所有分頁的視覺（只截 admin／財務同仁的儀表板、參數設定與尚未指派畫面）。權限設定畫面的「薪酬：負責門市」選項由 Task 5 的前端測試與 e2e 覆蓋，這次沒有重截。

證據（逐項輸出與截圖清單）：`.superpowers/sdd/plan/task-6-report.md`（該目錄不進版控）。

## 還沒做

1. 三個 repo 推分支、開 PR、依序合併（`release.md` 步驟 0-B～4；推 main 與 clasp 要 Eason 自己按）。
2. 步驟 0-A：mini 列出現有薪酬個別例外（唯讀，交辦已寫）。
3. 步驟 5：Eason 在權限設定打開財務部規則、逐人指定負責門市、撤掉非財務部的例外。
4. 步驟 6：換光復管理金鑰（含 mala-fortune 的 `CLOCK_ADMIN_KEY_GF`、mini `set-payroll-secret.js`）。
5. 上線後逐項驗收（spec §9，已列在 `release.md` 步驟 5）。
6. 上線完成後更新 dzy-admin skill「薪酬管理」節與 mala-payroll skill（負責門市、`scope` 語意、換金鑰結果）。

## 已知取捨與待確認

- 「沒有 scope 欄位＝不限制」在步驟 6 換金鑰前仍是一個洞（spec §10）；步驟 6 不要拖。
- CF／HQ 後端各有自己的金鑰與 Payroll 部署，本案只處理光復那一把；換金鑰前要與 Claude 確認它們是否被別的路徑使用（`release.md` 步驟 6 開頭）。
- 人資主管的 `permExList` 可能回出其他人的 `payroll.store@` 例外列（Task 5 備註；後端不在本案修）。
- `payroll_master_set` 換店的既有行為（舊店列可能殘留）不在本案修（spec §10）。
