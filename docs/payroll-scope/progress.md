# 薪酬依負責門市分權限 — 進度

> 規格 `spec.md`、實作計畫 `plan.md`、上線步驟 `release.md`。更新：2026-10-29（fix3＋跟上 main）。
> **目前狀態：程式與本機整合實測完成；分支已 push、PR 已開（dzy #54／#55、dzy-minikit #41、mala-clock-in #13），還沒合併、沒上線。** 上線由 Eason 依 `release.md` 執行。

## Task 狀態

| Task | 內容 | repo／分支 | commit | 狀態 |
|---|---|---|---|---|
| 1 | 薪資後端 scope 守門與回應裁切（`Payroll.gs`，94 項測試） | mala-clock-in `payroll-scope` | `1b89c09` | 完成（有備註：守門比對用 trim＋大寫，handler 仍用原字串；`scope:null` 視為 `scope_bad`） |
| 2 | 薪資頁依 scope 調整畫面（`payroll.html`） | mala-clock-in `payroll-scope` | `56df4d3` | 完成 |
| 3 | 平台負責門市碼 `payroll.store@`、代轉回傳 scope、差異清單套門市 | dzy `payroll-scope` | `269cb42` | 完成 |
| 4 | Mac mini 代轉強制帶 scope、gas 同步 | dzy-minikit `payroll-scope` | `8cb53b1` | 完成（有備註：mini 先於平台後端更新會讓薪酬代轉 400，所以順序是平台後端先） |
| 5 | 權限設定畫面「薪酬：負責門市」、集團總覽分頁只給 admin | dzy `payroll-scope` | `be2596a` | 完成 |
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

## 全分支 final review 修正（2026-10-29）

| 編號 | 問題 | 修法 | 位置 |
|---|---|---|---|
| C1 | 差異清單 `payrollStaffRoster` 的 `ids` 是全集團打卡對照，帶出別店同仁姓名、員編 | 非 admin 時 `payScopeIds_` 只留本打卡店（here）或薪資歸負責門市的完整資料，其餘清空 name／emp_no（保留 state／unit_name／pay_store／pay_none／store_code／here，差異清單判斷「該停用／待確認」只用這些；main 與 staff-sync-pending 的 staffDiff 都核對過） | dzy `StaffClock.gs`（114e4fc）；minikit gas 同步（6669002） |
| minor | spec §5「permExList 只對 admin 回」 | 人資主管本來就只拿得到 STORE_HR_GRANTABLE 三碼、其他人 no_perm；補迴歸測試鎖住看不到 `payroll.store@`（程式未改） | dzy `test/storeops.mock.test.mjs` 10p |
| I2 | 有範圍的人可用別店員工的 emp_id 寫工時／假別事件日／主檔（特休、假別統計以 emp_id 跨店讀工時） | `payScopeGuard_`：input_set／leave_event_set 每個 emp_id 要在負責門市主檔；master_set 新編號若出現在範圍外門市的主檔或工時就擋；回 `scope_forbidden`＋`detail:'emp_out_of_scope'`＋`emp_ids`。薪資頁有範圍時「儲存工時」只送本店主檔的人（工時表含只打卡未建主檔的編號，否則會被擋） | mala-clock-in `Payroll.gs`、`payroll.html`（5e1939e） |
| I3 | 守門比正規化後的店碼，handler 用原字串（`' cf '` 會寫成另一家） | 有範圍時 `body.store` 與 master 每列 store 先 trim＋大寫；`'*'`／沒欄位不動（starIdentical 仍過） | 同上 |
| minor | proxy-hook 接受 `['']`、`['  ']` | 元素須為非空、已 trim 字串，否則 throw | minikit `proxy-hook.js`（6669002） |
| minor | manifest 註解多一個逗號 | 刪掉 | dzy `modules/payroll/manifest.js`（3bcf432） |
| I1 | release.md 回退 1 沒寫「步驟 2／5 之後不安全」；檔頭說沒主機名但有網址 | 補警語；網址改 `$DZY_URL`／`$PAY_URL`（值見 dispatch-resources.md）；SHA 全部換新 | `release.md` |

dzy 分支為了讓第一段（平台後端）包含 C1，重排過（之後 fix2、fix3 又各重排一次）。現在的順序：`269cb42 → 114e4fc（C1）→ 3049ad4（fix2 後端）→ 6d3d526（fix3 後端，第一段終點）→ be2596a（前端）→ 538315b（文件）→ 3bcf432 → 156df84 → cd21355 → ac94b4e → 本檔 commit`；重排前的舊 sha 已不在分支上（內容相同、未推過）。
逐項證據：`.superpowers/sdd/plan/final-fix-report.md`。

## 第二輪審查修正 fix2（2026-10-29）

兩份獨立審查確認的問題，全部 TDD（先紅後綠）：

| # | 問題 | 修法 | 位置 |
|---|---|---|---|
| 1 | 守門在 checkAdmin 之前跑：沒金鑰的人帶 scope 可拿 `scope_forbidden`／`emp_ids` 探員工編號 | `payScopeWrap_`：`body.scope` 有值且金鑰不對 → 先回 `unauthorized`（不讀任何薪資表） | mala-clock-in `Payroll.gs`（4dac1a1） |
| 2 | 差異清單 `here` 例外：共用打卡店、別店支援者的姓名員編看得到 | 只有 `pay_store ∈ L` 完整，其餘只回 `{state, pay_store, pay_none}`；`emp_ids` 陣列時只回這些＋本店名單編號；薪資頁送本店主檔 emp_ids、文字不再依賴 unit_name | dzy `StaffClock.gs`（第一段）、`bridge.js`（第二段）；mala-clock-in `payroll.html`（0df91af）；minikit gas 同步（1d08748） |
| 3 | 有範圍仍能「從打卡名冊建立」（整份名冊寫進主檔，不經員工檢查）；前端讀 `r.added.length`，永遠顯示沒有新增 | 有範圍 → `scope_forbidden`／`admin_only`，薪資頁藏按鈕；訊息改讀 `r.names`、`r.added` 是人數 | 同上 |
| 4 | `payroll_bonus_set` 可夾別店員工 | 納入 `emp_out_of_scope` 規則 | `Payroll.gs` |
| 5 | 打卡試算表開不起來的錯誤字串含 `clock_ss_id`，會被 Code.gs 當 detail 回傳 | 訊息只留門市＋「請找系統管理者檢查門市設定」，ID 寫 Logger | `Payroll.gs` |
| 6 | `tests/payroll-scope.test.js` 例外被當放行、放行只驗「不是 scope_forbidden」 | 例外＝失敗；放行要 `ok:true` 或指定業務錯誤（calc `no_holiday`、finalize `reason_required`） | 測試 |
| 7 | 權限設定 `active: x.active !== false` 把字串 `'false'` 當啟用 | 字串比對（不分大小寫、前後空白） | dzy `modules/perms/lib.js`（第二段） |
| 8–11 | release／spec 文件 | 回退 1／2 先歸零非 admin 薪酬權限（含唯讀驗證查詢）或關 mini 代轉；回退 6 不還原舊金鑰、停機窗寫明；驗收改「可見別店代碼、不可見別店人」；spec §10 補五項取捨、requirements D5 對齊；SHA 全部重算 | `release.md`、`spec.md`、`requirements.md` |

dzy 分支又重排一次：後端 fix 插在 `114e4fc` 之後成為新的第一段終點 `3049ad4`，前端與文件 commit 重放在它之上（sha 全變，未推過）。
逐項證據：`.superpowers/sdd/plan/fix2-report.md`。

## 第三輪小修 fix3（2026-10-29）

| # | 問題 | 修法 | 位置 |
|---|---|---|---|
| 1 | 差異清單非 admin 沒帶 `emp_ids` 時，仍回全集團每個打卡編號的 `{state, pay_store, pay_none}`，可列舉別店打卡編號與其薪資門市 | 非 admin 且 `emp_ids` 不是陣列 → `payScopeIds_` 之後把 `pay_store ∉ L` 的編號整筆刪掉；帶 `emp_ids` 照舊（薪資頁一律帶）；admin 不變。測試 13n-14～17（先紅後綠），13n-3／4／6／9 改成帶 emp_ids 驗三欄 | dzy `StaffClock.gs`（`6d3d526`，插在 `3049ad4` 之後成為第一段終點，前端／文件重放）；minikit gas 同步（`74383fa`） |
| 2 | release／progress 的 mala-clock-in sha 是 rebase 到 PR #12 之前的舊值 | 全部換新（`1b89c09`／`56df4d3`／`5e1939e`／`4dac1a1`／`0df91af`）；release 補「PR #12 必須先合併」；dzy 第二段 HEAD 改用 gh 顯示的 PR head（本檔在第二段裡，寫死會循環） | `release.md`、`progress.md` |

## 跟上 main（2026-10-29 晚）

dzy main（#56-#59 品牌辦公室由總監審、墨竹亭台中美村 mztmc）、minikit main（#45-#49）、mala-clock-in main（#14 MZTMC 等）當天都動了，minikit PR 因 `SOURCE.sha256` 衝突。處理方式一律是「在分支上加合併 commit」，不重排、不 force push：

| repo | 新 commit | 內容 |
|---|---|---|
| dzy 第一段 `payroll-scope-backend` | `a3a17f60005cad1a971623f776bd15e3775ca907` | `6d3d526` 合併 origin/main（自動合併無衝突）；全部 dzy 測試通過 |
| dzy 第二段 `payroll-scope` | 合併 `a3a17f6` 的 merge commit＋本檔 commit | 第二段含第一段為祖先；平台 .gs 與第一段逐檔相同 |
| dzy-minikit `payroll-scope` | `dbe9b2bf52eee38981f09ea742b5c1731ee57a88` | 合併 origin/main；18 個 gas 逐檔取自 `a3a17f6`，`SOURCE.sha256` 重算、render-docs 無變動、readActions 兩邊相同 |
| mala-clock-in `payroll-scope` | `dc57374ead0a04f1fff09a9614e4ef1955a2da0c` | 合併 origin/main（#14）；`Payroll.gs`／`payroll.html` 與 `0df91af` 相同 |

`release.md` 的第一段、minikit、mala-clock-in sha 已全部換新。

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
- ~~人資主管的 `permExList` 可能回出其他人的 `payroll.store@` 例外列~~：查證後本來就不會（只回 STORE_HR_GRANTABLE），已補測試（final review）。
- dzy `payroll-scope` 分支落後 main 的 `StoreOps.gs`（main 上「考勤名單列入未開通同仁」那筆），分支上與 minikit 差這一檔；合併進 main 後 18 檔相同（已用 merge-tree 驗）。
- `payroll_master_set` 換店的既有行為（舊店列可能殘留）不在本案修（spec §10）。
- 共用打卡表、紅字天數自動同步、授權紀律、空名單開頁、D5「看」的範圍：見 spec §10（fix2 補記）。
