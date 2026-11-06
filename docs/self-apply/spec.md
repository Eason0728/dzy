# 新進同仁自行申請帳號 規格 v1.0（2026-11-06）

需求正本：`requirements.md`（Eason 1A 2A 3A 4B 5B，不做邀請碼）。Eason 2026-11-06：做完直接合併 PR 並部署。

## 1. 資料：新分頁 `staff_apply`

表頭（順序固定，`STF_APPLY_HEADERS`）：
`apply_id, status, created_at, name, phone, birthday, address, brand, unit, dept, title, salt, hash, reviewed_by, reviewed_at, emp_no, reject_reason, hire_date`

- `apply_id`＝`APL` + yyyymmddHHMMss + 4 碼亂數；status＝`pending｜approved｜rejected`。
- 密碼只存 salt＋hash（同 Auth.gs 的雜湊法）。核准時直接搬到 users 列，申請列的 salt／hash 清空。
- 退回時清空 salt／hash／birthday／address（保留姓名、手機、單位、原因供查進度）。
- 第一次需要時自動建（只補不覆蓋，表頭不一致就停，同 setupStaff 慣例）。讀取類 action 在分頁不存在時回空，不建表。
- 不過期（Q4 B）。

## 2. 登入前 action（不帶 token）

### `applySubmit {name, phone, birthday, address, brand, unit, dept, title, password}`
1. 長度、格式驗證完全沿用認領（`stfClaimWrite_` 用的驗證：姓名、手機 09+10 碼、生日、地址 5–100 字、密碼 ≥8、組織欄 `stfValidateOrg`／`stfTitleFitsUnit_`）。單位不限（Q5 B），但必須 active。
2. 全域限流 `stfGlobalFlood_('apply')`（格式錯不計）。
3. 擋：
   - 名冊有同名 `unclaimed` → `NAME_IN_ROSTER`「名單上已經有你的名字，請改用「第一次使用」認領」；
   - 同單位已有同名非停用同仁（`clkNameClash_` 的 a 條件）→ 「這個單位已經有同名同仁，請找主管」；
   - 已有同手機或同姓名＋同單位的 `pending` 申請 → 「你已經送出申請，等主管審核中」；
   - 全部 `pending` 申請數 ≥ 300 → 「目前申請太多，請稍後再試或找主管」。
4. 寫一列 pending，回 `{ok:true, data:{pending:true}}`（不回 apply_id、不回 token）。

### `applyStatus {name, phone}`
- 回最新一筆同姓名＋同手機的申請：`{status:'pending'}`／`{status:'approved', emp_no}`／`{status:'rejected', reason}`／`{status:'none'}`。
- 限流：全域桶 `applystatus`；同姓名查無 5 次／10 分鐘（沿用 `stf_miss_` 做法，key 換 `stf_amiss_`）。

## 3. 審核（登入後）

### 誰能審（Q2 A＋Q5 B，取聯集）
1. 人資（`platform.staff`）或 admin；
2. 「新增同仁」守門能管該單位、且職稱職級不高於自己的人（`clkActor_` 的 units＋`clkRankFor_`，含兼任店長、`staff.add@`）；
3. 該單位該職稱的認領審核者（`stfReviewNeed_(unit, dept, title)` 配 `stfReviewScope_`／`stfScopeMeets_`，帶 `regionCtx_()`）——品牌辦公室給總監、總部部門給部門總監、執行長以上給人資。

同一套判斷 `stfApplyCanReview_(actor, row, titleOverride)` 給清單、核准、退回共用。

### `unitPending` 擴充
回傳多 `applies: [{apply_id, name, phone, unit, unit_name, dept, title, title_name, created_at}]`（只列自己能審的 pending）。不回 birthday／address／salt／hash。

### `applyApprove {apply_id, title?, hire_date}`（寫入，進 MUTATING_ACTIONS）
1. 重讀該列，必須 pending；審核者必須過 `stfApplyCanReview_`（用改後職稱再驗一次）。
2. `title` 可改（Q3 A），要合單位（`stfTitleFitsUnit_`）；`hire_date` 必填，範圍同新增同仁（2000-01-01～今天+365）。
3. 再查一次姓名衝突（同 submit 第 3 點前兩條）。
4. 編號＝`stfMaxEmpNum_() + 1`；>999 回 full；staff／users 都不能已有。
5. `permNewRowBlock_`（非 admin 造出含鎖碼身分 → perm_admin_only）。
6. 寫 users 列（username＝編號、role staff、active、申請的 salt／hash）＋ staff 列（status active、org 正式欄、個資、claimed_at＝申請時間、confirmed_at＝現在、hire_date）＋ 打卡 add 單（同 `handleStaffCreateByUnit_` 的 `clkEnqueue_`，單位有門市打卡店才開）＋ staff_log `apply_approve`（只記編號、審核者，不寫個資）。
7. 申請列 status approved、emp_no、reviewed_by、reviewed_at，清 salt／hash。
8. 回 `{emp_no, name}`，前端顯示「已通過，編號 DZY###，請告訴同仁用這個編號和他設的密碼登入」（Q1 A）。

### `applyReject {apply_id, reason}`（寫入）
原因必填（1–100 字），同一套審核判斷；status rejected、清個資與密碼。

## 4. 前端

- `platform/views/claim.js`：查無名字（NOT_IN_ROSTER）時多兩個按鈕「我是新進同仁，申請帳號」→ `#/apply`、「查申請進度」→ `#/apply-status`。
- 新畫面 `platform/views/apply.js`（申請單，組織欄用 `platform/views/org-fields.js`）、`apply-status.js`（姓名＋手機查）。路由比照 claim／forgot 掛在登入前路由。
- `modules/me/views/review.js`（待審核）：認領清單之外多一區「新進同仁申請」，每列：姓名、單位、職稱下拉（可改）、到職日（必填）、通過、退回（要原因）。通過後跳出編號。
- 首頁待審數字（若現有 badge 算認領數）把申請數加進去。

## 5. 同步清單（漏一個就壞）

- Code.gs 分派表：`applySubmit`、`applyStatus`（登入前白名單，比照 claimLookup／claimSubmit）、`applyApprove`、`applyReject`；後兩者進 MUTATING_ACTIONS。
- `platform/dryrun.js`：applyApprove／applyReject 不是讀取（試跑攔下）；applyStatus 比照 claimLookup 的處理。
- minikit：`apps/dzy-platform` gas 換 Staff.gs（＋有改到的 .gs）＋ SOURCE.sha256；`jobs.js TRIGGER_ACTIONS` 加 `applyApprove`（會開打卡單）＋ `test/apps/clock-sync.test.js` mustHave；readActions 照 claimLookup 有無比照。
- 小幫手題庫頁面對照：有改 manifest views 才要跑 `node tools/gen-aihelp-pages.mjs`。

## 6. 測試

- 新 `test/staff-apply.mock.test.mjs`：送出驗證與各種擋、限流、查進度、審核者聯集（店長／正職 staff.add@／兼任店長／總監／部門總監／人資／無關的人被拒）、職稱不得高於審核者、改職稱、到職日必填、核准產生正確編號（含停用者的號碼不回收）、users／staff／打卡單三處寫入、退回清個資、重複核准被擋。
- 既有 node 測試全綠；e2e run_all（t16 既有紅照舊）。
- 真瀏覽器本機點過：申請 → 查進度 → 店長通過 → 用新編號登入。

## 7. 實作差異（2026-11-06 實作時記錄）

1. **`applySubmit` 也進 MUTATING_ACTIONS**：第 5 節只列 approve／reject，但 submit 會建表、寫列，比照 `claimSubmit` 拿寫入鎖（避免兩人同時送出撞同一列）。
2. **申請姓名上限 20 字**（不是認領的 30 字）：核准後姓名會進打卡名冊，沿用店長新增同仁的 `CLK_NAME_MAX`；開頭 `= + - @` 一律擋。
3. **「可新增同仁」（staff.add@）的人照舊沒有「待審核」分頁**（既有決定與測試 `staff-master-front` 釘住「待審核不給 platform.unitstaff」）：
   他們能審的申請改放在「我的資料 → 我的單位」上方（`modules/me/views/applies.js` 的 `mountApplies`），首頁提醒連到「我的單位」。
   後端 `unitPending` 對他們回 `{people: [], applies: [...]}`（只在 staff_apply 分頁存在時；否則照舊回「只有單位主管可以審核」）。
4. **人資／admin 首頁不提醒申請數**（既有測試釘住「admin／人資不在首頁重複提醒」）；人資到「待審核」看得到全部申請。
5. **核准當下名冊已有同名未認領**：回給審核者的訊息改成「請退回這筆申請，請他改用第一次使用認領」（code 仍是 `name_in_roster`）。
6. **`claimLookup` 查無時多回 `code: 'not_in_roster'`**（訊息不變），登入頁據此顯示兩個入口。
7. **退回也記 staff_log**：`apply_reject`，emp_no 空白、detail 只寫 apply_id（不寫個資）。`reviewed_by` 與 staff_log 的 by 一樣寫審核者的 user id。
8. **審核者第 2 條（新增同仁守門）比照 `clkResolveOrg_`**：職級「不高於」＝同級可以（店長可通過申請店長的人）；區域限制只套在第 3 條（認領審核者），與新增同仁一致。
9. 前端職稱下拉列出該單位所有可用職稱（含比審核者高的），選太高由後端擋（`no_perm`）。
10. manifest views 沒改 → 不用跑 `gen-aihelp-pages`；minikit 只需換 `Staff.gs`、`Code.gs`（readActions 比照 claimLookup 加 `applyStatus`、TRIGGER_ACTIONS 加 `applyApprove`）。
