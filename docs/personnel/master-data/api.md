# 契約：員工名單統一｜平台後端 API 與內部函式

版本：v1 / 2026-10-13（階段 2 實作完成時寫定；前端與同步員照本檔做，有出入以程式為準並回頭改本檔）
上游：`spec.md` v2（衝突時以 §11 為準）、`plan.md` 共用契約、`task.md` 階段 2。
實作：`apps-script/platform/StaffClock.gs`；測試：`test/staff-clock.mock.test.mjs`。
⚠ 本 repo 是 public：本檔不寫網址、金鑰、試算表 ID、真名。

## 0. 通則

### 0.1 對外 action（前端 / 佈告欄）
- 走既有入口：POST JSON `{action, token, payload}`（Content-Type `text/plain`）。`token` 是登入 token；`svcDirectory` 不用 token。
- 成功：`{ok:true, data:{…}}`。失敗：`{ok:false, error:<中文訊息，可直接顯示>, code:<代碼>}`。
  登入／token 本身的錯誤（過期、沒登入）沿用第一期格式：只有 `error`，沒有 `code`。
- 寫入類 action 在 Code.gs 的全域寫入鎖內執行（MUTATING_ACTIONS）；唯讀不上鎖。
- 時間字串一律台北時區：日期 `yyyy-MM-dd`、時間 `yyyy-MM-dd HH:mm:ss`。

### 0.2 內部函式（同步員經 runGas 呼叫）
- 名字結尾是底線，**不在** `CODE_ALLOWED_ACTIONS`；打 `/api` 呼叫它們（含去掉底線的名字）一律回 `{ok:false, error:'不支援的操作'}`（測試：B9）。
- 都是 `clk*`／`clock*_` 函式，自己拿 Script 鎖（拿不到 20 秒 → `{ok:false, code:'busy'}`），所以一支一支依序呼叫即可。
- 回傳形狀同對外：`{ok:true, data}`／`{ok:false, error, code}`。`now` 參數可傳 `Date`、毫秒數、`'yyyy-MM-dd HH:mm:ss'`（台北）；沒傳＝現在（測試與補跑用）。

### 0.3 權限
| 角色 | 判斷 |
|---|---|
| 總部 | 有 `platform.staff`（admin 的 `*` 也算） |
| 店長 | 同仁帳號（`platform.self`）、staff 狀態 active、**單位是門市（org ladder＝store）**、職級 rank≥3（店長以上）、且目標在**同一個單位**。總部單位（ladder＝hq）的部門主管、執行長等**不能走店長路徑**（沿用 Staff.gs `stfManagerScope_`，再擋一層 ladder） |
| 其他 | 一律 `no_perm` |
- 任何人都**不能對自己**登記離職；店長也不能撤銷自己的離職（避免推翻總部的決定）。
- 店長新增同仁時，職稱的職級不得高於自己（`no_perm`）。

### 0.4 錯誤代碼（`code`）
`no_perm` 沒權限｜`not_found` 找不到同仁｜`bad_input` 輸入格式不對｜`duplicate_name` 同名｜`emp_conflict` 取號撞到已存在的編號（整筆拒絕、什麼都沒寫）｜`full` 編號用到 DZY999｜`setup_failed` 分頁建立／表頭核對失敗（停下、不寫資料）｜`self_leave` 對自己登記離職｜`already_disabled` 已停用｜`not_disabled` 沒停用（復職用）｜`last_day_past` 超過可往回補的 7 天｜`last_day_far` 離職日太遠｜`no_leave` 沒登記離職｜`leave_passed` 最後上班日已過不能撤銷｜`no_job` 找不到／看不到待辦單｜`not_retryable` 這張單不能重試｜`no_map` 沒有生效的打卡對照｜`dup_confirmed` 同人同店已有生效編號｜`emp_id_taken` 該打卡編號已確認給別人｜`home_exists` 已有主店｜`dead_state` 目前狀態不能做｜`no_change` 沒變｜`unauthorized` 服務金鑰錯｜`precheck_baseline`／`precheck_dup_name`／`precheck_outbox`／`precheck_no_store` 建對照前置檢查沒過｜`not_allowed` 不符 7A 條件｜`conflict` 打卡編號衝突｜`busy` 拿不到鎖｜`disabled` 同仁已停用（clockLink 等需要在職的動作回）｜`use_reinstate` 這個人登記過離職（有 last_day），第一期「啟用」不能用，請改走 staffReinstate（見 §3.9）。

## 1. 資料（新增／變更的分頁）
表頭逐字如下（`setupStaff` 自動建立，只補不覆蓋；表頭不一致丟錯停下，action 回 `setup_failed`）。
- `staff` 最右邊補兩欄（第 25、26 欄）：`hire_date`（到職日）、`last_day`（最後上班日，有值＝已登記離職）。原 24 欄不動。
- `clock_stores`：`store_code, store_name, unit_code, enabled, payroll_store`。`payroll_store`＝薪資模組自己的門市代碼（打卡 Payroll.gs 的 `PAY_DEFAULT_STORE`＝`SSLGF` 只對得上光復；CF、HQ、MZTJS、MZTLZL 依 skill 薪酬門市表紀錄預填，mztgf 無證據留空待總部查；留空時退回用 store_code 比對）。舊 4 欄表由 setupStaff 補欄並把光復補成 SSLGF。預設六列（`enabled=TRUE`）：

| store_code | store_name | unit_code（依 org 預設單位對上，六個都查得到） |
|---|---|---|
| gf | 小辛辣 新竹光復 | mala-gf |
| mztjs | 墨竹亭 新竹金山 | mzt-js |
| mztgf | 墨竹亭 新竹光復 | mzt-gf |
| mztlzl | 墨竹亭 台北六張犁 | mzt-lzl |
| hq | 鼎兆元 總部 | dzy-hq |
| cf | 中央廚房 | ck |
  `unit_code` 空白＝這家店不綁單位（新增不會自動開打卡單）。一個單位只取第一個啟用的店。
- `staff_clock`：`emp_no, store_code, emp_id, role(home|support), state(suggested|confirmed|rejected), source(name_match|created|auto_support|roster_seen), roster_active(TRUE|FALSE|空), last_punch, confirmed_by, confirmed_at, updated_at`。唯一鍵 `store_code+emp_id`（store_code 小寫；emp_id **以打卡名冊的原字串為準，只 trim、不轉大小寫**，打卡端區分大小寫）。
- `clock_outbox`：`job_id, kind, emp_no, store_code, emp_id, name, op_id, expect_json, state(pending|running|done|failed|cancelled), tries, next_at, lease_until, last_error, created_at, updated_at, done_at`。
  - `kind`：`add`｜`deactivate`｜`reactivate`｜`link`｜**`build`**（本期新增：建立打卡對照的請求，無 emp_no／store_code）。
  - `job_id`＝`J`＋台北 `yyyyMMddHHmmss`＋`-`＋4 位小寫十六進位；`op_id`＝`dzy:`＋job_id。
  - `expect_json`（開單當下快照，JSON）：`{emp_no, store_code, map:"store_code:emp_id", state:"confirmed", staff:"active"|"disabled", name, by, uid, demote_old?, then?}`。`by`＝操作者 emp_no 或帳號（給 svc_add 的 `created_by=管理系統:<by>`）；`uid` 只用來限制誰拿得到連結金鑰。
- Script Properties（平台）：`BULLETIN_SVC_KEY`（佈告欄服務金鑰，必設才開放 svcDirectory）；`CLOCK_MAP_STATE`、`CLOCK_SYNC_<store_code>`、`CLOCK_TRANSFER_ASK`（內部狀態，只有姓名與編號，無金鑰）。
- CacheService：`clk_link_<job_id>`＝打卡連結金鑰，TTL 120 秒，取一次即刪。**金鑰不會出現在任何分頁、log、Script Properties。**

## 2. 對外 action

### 2.1 staffCreateByUnit — 店長／總部新增新人
- 權限：店長（自己單位）、總部（任一單位）。
- 輸入 `payload`：`{name, title, hire_date, phone, unit?, dept?}`
  - `name` 必填 **≤20 字**（會進打卡的姓名：staffCreateByUnit、clockCandidateCreate、staffRename 都是 20，與打卡端 svc_add 一致）；`title` 職稱代碼（org，如 `pt`）；`hire_date` `yyyy-MM-dd`（2000-01-01 ~ 今天+365）；`phone` 09 開頭 10 碼。
  - `unit`、`dept` **只有總部看**；店長夾帶的 `unit` 一律忽略（建在自己單位）。總部單位（有部門清單）時總部要給 `dept`。
- 動作（同一支呼叫內寫完）：users 帳號＋staff 列（`status=unclaimed`，組織四欄直接填正式欄）＋（單位有對應打卡時）一張 `add` 單＋staff_log（`add_by_unit`，只寫單位代碼與 job_id）。DZY 編號＝全表（staff＋users）最大號 +1，寫入前再檢查 staff／users 都沒有該號，撞到整筆拒絕 `emp_conflict`。
- 輸出：`{ok:true, data:{emp_no, job_id|null, unit, store_code|null}}`；單位沒對應打卡（例：美村）→ `job_id=null`。
- 錯誤：`no_perm`、`bad_input`（姓名／手機／到職日／職稱）、`duplicate_name`（同單位在職同名，或全名單有同名「未認領」者；訊息教加註）、`emp_conflict`、`full`、`setup_failed`。
- 前端：拿到 job_id 後每 3 秒呼叫 `clockJobStatus`，最多 60 秒。

### 2.2 staffLeave — 登記離職（也可改日期）
- 權限：店長（自己單位）、總部。不能對自己。
- 輸入：`{emp_no, last_day}`。`last_day` 店長：不可早於「今天 −7 天」（含第 7 天可以）；總部不擋往回。兩者都不收今天 +365 天以後。
- 輸出：`{emp_no, last_day, can_cancel}`（`can_cancel`＝`last_day >= 今天`）。
- 錯誤：`no_perm`、`not_found`、`self_leave`、`already_disabled`（已停用的不能登記）、`bad_input`、`last_day_past`、`last_day_far`。
- 只寫 `staff.last_day`，**不立刻停用**；過了這天的每日同步（`clockDailyApply_`）才停用。

### 2.3 staffLeaveCancel — 撤銷離職
- 權限：同 staffLeave，另外不能撤銷自己的。
- 輸入：`{emp_no}`。條件：有登記、且 `last_day >= 今天`（當天結束前）。
- 輸出：`{emp_no}`。錯誤：`no_leave`、`leave_passed`（已過，走復職）、`already_disabled`、`self_leave`、`no_perm`、`not_found`。

### 2.4 staffRename — 改名（只有總部）
- 輸入：`{emp_no, name}`。同單位在職不得同名（`duplicate_name`）；沒變 `no_change`。
- 動作：改 staff 與 users 的姓名；對每個 confirmed 對照店，在該店同步狀態記一筆「打卡姓名不同」→ `clockAlerts.name_diff`；下一次該店 `clockRosterApply_` 用真正的名冊重算（打卡端改一致後消失）。排隊中的 `add` 單送出前會改用新姓名。
- 輸出：`{emp_no, name, clock_stores_to_fix:[store_code…]}`。

### 2.5 staffReinstate — 復職（只有總部）
- 輸入：`{emp_no, preview?:true, stores?:[store_code…]}`。人必須已停用（`not_disabled`）。
- `preview:true`：只回他過去 confirmed 的對照 `{emp_no, preview:true, maps:[{store_code, store_name, emp_id, role, roster_active}]}`，不改任何東西。
- 否則：staff 恢復（同 staffSetActive true）＋清 `last_day`＋勾選的每家店各發一張 `reactivate` 單。輸出 `{emp_no, job_ids:[…]}`。勾了沒有 confirmed 對照的店 → `no_map`（整筆不做）。
- 復職前離職連動發出、還沒送的 `deactivate` 單，送前重驗會被取消。

### 2.6 staffUnitList — 單位同仁名單（唯讀）
- 權限：店長（固定自己單位）、總部（可帶 `unit` 篩選，不帶＝全部）。
- 輸出：`{people:[{emp_no, name, status, unit, unit_name, title, title_name, hire_date, last_day, can_cancel_leave, is_self, name_diff, clocks:[{store_code, store_name, emp_id, role, roster_active(true|false|null)}], clock_total, clock_stopped, clock_job:{job_id,state,tries}|null}], unit}`。**不含手機、生日、地址。**
- `clock_total`＝confirmed 對照數；`clock_stopped`＝其中 `roster_active=FALSE` 的數量（畫面「打卡已停 n/m」）；`clock_job`＝尚未結束的 add 單（畫面「打卡建檔中…」）。
- `is_self`＝這一列是不是呼叫者本人（前端據此不顯示對自己的離職鈕）；`name_diff`＝打卡名冊姓名≠管理系統姓名（任一店）。
- 另外 `staffList`（總部既有 action）每位同仁多帶 `hire_date, last_day, clocks, clock_total, clock_stopped, clock_job, is_self, name_diff`（欄位同上）。

### 2.7 clockMapBuild — 總部按「建立打卡對照」
- 權限：總部。輸入：無。
- 前置檢查（不過就拒絕）：staff 有 DZY001～DZY113 全部（`precheck_baseline`）；沒有未停用的重複姓名（比對時去空白，`precheck_dup_name`）；`clock_outbox` 沒有 pending／running／failed 的單（`precheck_outbox`）；至少一家啟用的店（`precheck_no_store`）。
- 動作：寫一張 `build` 單。同步員撿到後拉六店 `svc_roster`，呼叫 `clockMapBuildApply_`，再 `clockOutboxDone_(job_id,{ok:true})`。
- 輸出：`{job_id}`。

### 2.8 clockMapList — 打卡對照清單
- 權限：店長、總部。
- 輸出：`{suggested:[{emp_no, name, unit, unit_name, store_code, store_name, emp_id, role, state, source, roster_active, last_punch}], confirmed:[同形狀], needs_hq:[…], candidates:[…], confirmed_count, built_at}`。
  - `confirmed`＝全部已生效對照（**只有總部有值**，店長是空陣列）；前端「全部對照」＝suggested＋confirmed。
  - `suggested`：店長只有「對照的 DZY 在自己單位」的 suggested 列；總部全部。
  - `needs_hq`、`candidates`、`built_at` **只有總部有值**（店長看到空陣列）。
  - `needs_hq[i]`：`{kind:'ambiguous'(同名多人)|'dup_in_store'(一人同店兩個編號)|'conflict'(同人同店已有生效編號)|'rejected'(對照被退回,需重指定)|'escalated'(店長按「不對」轉來), name, entries:[{store_code, emp_id}], options:[{emp_no, name, unit}]}`。
  - `candidates[i]`：`{key:"store_code:emp_id"（組內排序第一筆）, name, entries:[{store_code, emp_id}]}`（DZY 找不到的人，跨店已聚成一筆；**不建 staff**）。

### 2.9 clockMapDecide — 決定一筆對照
- 輸入：`{store_code, emp_id, decision:'confirm'|'reject', emp_no?, role?}`。
- 店長：只能決定「自己單位、state＝suggested」的列；不能帶不同的 `emp_no`、不能帶 `role`（`no_perm`）。`confirm`→confirmed；`reject`→rejected 並轉總部（`needs_hq` 的 `escalated`），輸出 `escalated:true`。
- 總部：可帶 `emp_no` 把任一打卡編號指給任一 DZY、可帶 `role`（home|support）、可改已 confirmed 的列。
- 檢查：同一個 DZY 在同一家只能有一個 confirmed（`dup_confirmed`）；一個人只能有一個主店（`home_exists`）；店長不能改已 confirmed 給別人的編號（`emp_id_taken`）。
- 輸出：`{emp_no, store_code, emp_id, role, state}`（reject：`{store_code, emp_id, state:'rejected', escalated}`）。每次寫 staff_log（`map_confirm`／`map_reject`，不寫姓名）。
- 錯誤：`no_perm`、`bad_input`、`dead_state`（店長遇到非 suggested）、`not_found`、`dup_confirmed`、`home_exists`、`emp_id_taken`。

### 2.10 clockCandidateCreate／clockCandidateDismiss — 候選新人（只有總部）
- Create 輸入：`{candidate_key, unit?, title, dept?, hire_date?}`（`unit` 不給＝第一筆 entry 那家店的 unit_code）。建 DZY（unclaimed，沒手機）＋該人各店對照一律 `confirmed／roster_seen`，單位對應的那家 `home`，其他 `support`；**不寫 add 單**。輸出 `{emp_no, unit}`。
- Dismiss 輸入：`{candidate_key}`。把這些打卡編號加入排除清單，之後重建對照不再出現。輸出 `{candidate_key}`。
- 錯誤：`no_perm`、`not_found`（找不到候選）、`bad_input`、`duplicate_name`、`full`。

### 2.11 clockOutboxRetry — 重試待辦單（只有總部）
- 輸入：`{job_id}`。只有 `state=failed`，或 `pending 且 tries≥3` 的單可重試；重試＝回 pending、`next_at`＝現在、`tries` 歸零。
- 輸出：`{job_id, state:'pending'}`。錯誤：`no_perm`、`no_job`、`not_retryable`。

### 2.11b clockOutboxCancel — 結案（只有總部）
- 輸入：`{job_id, reason?}`。只有 `failed`，或未完成（pending／running）且 `tries≥3` 的單可取消 → `cancelled`（記原因與 staff_log `outbox_cancel`），從首頁紅燈消失、不再擋 `clockMapBuild` 前置檢查。輸出 `{job_id, state:'cancelled'}`。錯誤：`no_perm`、`no_job`、`not_retryable`。
- `clockOutboxRetry` 的可重試條件同步放寬為：`failed`，或未完成且 `tries≥3`。

### 2.12 clockOldHomeDecide — 調店後舊主店要不要停用（只有總部）
- 輸入：`{emp_no, store_code, deactivate:boolean}`。待決定清單見 `clockAlerts.transfer_ask`。
- `deactivate:true`：發一張 `deactivate` 單（`expect.staff=active, then=reject`）；成功後該對照 `roster_active=FALSE`、`state=rejected`。`false`：保留（維持 support）。兩者都從待決定清單移除。
- 輸出：`{emp_no, store_code, job_id|null}`。錯誤：`no_perm`、`bad_input`、`not_found`（不在待決定清單）、`no_map`。

### 2.13 clockLink — 顯示打卡連結
- 權限：該同仁所在單位的店長、總部。輸入：`{emp_no, store_code?}`（不給＝主店）。需要有 confirmed 對照（`no_map`）且人沒停用。
- 動作：寫一張 `link` 單（不寫金鑰）。輸出：`{job_id}`。之後輪詢 `clockJobStatus` 取金鑰。

### 2.14 clockJobStatus — 查待辦單（輪詢）
- 權限：店長（單的 emp_no 在自己單位）、總部（含 build 單）。輸入：`{job_id}`。
- 輸出：`{job_id, kind, state, emp_no, store_code, emp_id, tries, last_error, link_key?, link_expired?}`。
  - add 完成：`state='done'`、`emp_id`＝打卡編號。
  - link 完成：**只有當初要連結的人**會拿到 `link_key`，從 CacheService 取一次即刪；之後再查回 `link_expired:true`（金鑰已取走或 120 秒到期）。別人（含總部）查狀態不會取走金鑰。
- 錯誤：`no_job`（不存在、或不在自己管轄）。

### 2.15 clockAlerts — 首頁「待辦與異常」
- 權限：店長（只看自己單位的人相關項目）、總部（全部）。
- 輸出 `data`：
  - `outbox_failed:[{job_id,kind,emp_no,store_code,state,tries,last_error}]`：打卡未建／停用失敗（state=failed，或 pending 且 tries≥3）。
  - `unmapped:[{store_code,emp_id,name}]`：打卡上在職但沒對照（總部才有）。
  - `left_but_active:[{emp_no,store_code,emp_id}]`：DZY 已離職但某家打卡仍在職。
  - `pending_confirm:{count, items:[{emp_no,store_code,emp_id}]}`：待確認（suggested）對照。
  - `no_home_map:[emp_no]`：打卡單位在職者沒有 home 對照、也沒有進行中的 add 單。
  - `leave_overdue:[emp_no]`：離職日已過卻還沒停用（連動停用失敗，如帳號列遺失；同時寫 staff_log `disable_failed`）。
  - `home_stopped:[{emp_no,store_code,emp_id}]`：DZY 在職、沒登記離職，但主店 confirmed 對照 `roster_active=FALSE`（例如打卡端店長用舊按鈕停用）。
  - `transfer_failed:[emp_no]`：調店確認時開 add 單失敗（總部才有；他有主店或進行中的 add 單後消失；同時寫 staff_log `transfer_add_failed`）。
  - `name_diff:[{emp_no,store_code,emp_id}]`：打卡名冊姓名≠管理系統姓名（改名後）。
  - `payroll_diff:[{store_code,emp_id,roster_name,payroll_name}]`：薪資主檔姓名≠打卡名冊姓名，請會計改成一致（總部才有）。
  - `transfer_ask:[{emp_no,name,store_code}]`、`needs_hq_count`、`candidates_count`（總部才有）。
  - `last_sync:{store_code:'yyyy-MM-dd HH:mm:ss'}`：每店最後一次名冊同步時間（health 用）。
  - `counts`：以上各類的筆數物件。

### 2.16 svcDirectory — 佈告欄同仁名單
- 驗證：`payload.svc_key` 要等於 Script Property `BULLETIN_SVC_KEY`（常數時間比對；未設定＝全拒；不用登入 token）。錯誤：`unauthorized`。
- 輸出：`data:[{emp_no, name, unit(單位代碼), unit_name, active(status≠disabled), clocks:[{store_code, emp_id, role}]}]`。`clocks` **只含 confirmed 對照**；**不含手機、生日、地址**。

## 3. 內部函式（給同步員 jobs.js，經 runGas；不進分派表）

### 3.1 待辦單生命週期
```
pending ──claim──► running ──Done(ok)──► done
   ▲                  │  └─Done(fail,暫時性)─► pending(next_at 往後)
   │                  └─Done(fail,永久性)───► failed ──(總部 clockOutboxRetry)──► pending
   └─ lease 過期(5 分鐘)的 running 視為可再撿
pending/running ──claim 時重驗不過──► cancelled（不送）
```

### 3.2 clockOutboxClaim_(now, limit?, kinds?)
- 撿 `state=pending 且 next_at≤now`，或 `state=running 且 lease_until<now` 的單（最多 `limit`，預設 10、上限 50；`kinds` 選填，例 `['link','build']`，不在清單的 kind 不碰、保持 pending）。
- 先**重驗 expect_json**（見 3.3）；不通過 → `cancelled`（`last_error` 寫原因、`done_at`），不回傳。
- 通過 → `running`、`lease_until`＝now+5 分鐘。若這張單是 running 且 lease 已過期（上一次撿走後沒回填），重撿時 `tries+1`、`last_error='lease_expired'`，連續三次會進 `outbox_failed` 紅燈（不會無限重撿而無人知道）。
- 回給同步員的 `name`（add）一律是原字串；待辦單格子內為防公式而加的前導單引號不外送。`add` 單若排隊期間改過名，`name` 換成現在的姓名。
- 輸出：`{ok:true, data:{jobs:[{job_id, kind, emp_no, store_code, emp_id, name, op_id, tries, by}], cancelled:[job_id…]}}`。
- 同步員依 kind 打對應的打卡 svc：
  - `add`→`svc_add {name, op_id, created_by:'管理系統:'+by}`；`deactivate`→`svc_set_active {emp_id, active:false, op_id, by}`；`reactivate`→`svc_set_active {…active:true…}`；`link`→`svc_link {emp_id}`；`build`→對每個啟用的店 `svc_roster`，彙整成 `{store_code:[rows]}` 呼叫 `clockMapBuildApply_`。
  - `CLOCK_WRITE=0` 時 claim 傳 `kinds=['link','build']`：add／deactivate／reactivate 留 pending，不被撿、不會卡在 running。

### 3.3 送前重驗（expect_json）
| kind | 取消條件 |
|---|---|
| add | 同仁不存在／已停用／last_day 已過；店已停用；該人在此店已有 confirmed 主店對照 |
| deactivate／reactivate／link | 同仁不存在；`expect.staff` 與現況不符（deactivate 預設期望「已停用」，reactivate／link 預設「在職」）；`map` 與現在的 store_code:emp_id 不同；該對照列不存在、指向別人、或 state≠`expect.state`（預設 confirmed） |
| build | 不驗 |

### 3.4 clockOutboxDone_(job_id, result, now?)
- `result` 成功：`{ok:true, emp_id?(add), link_key?(link)}`；失敗：`{ok:false, error:<打卡端代碼|network|timeout|…>, message?, retry?:false}`。
- 打卡編號（emp_id）以打卡名冊原字串為準：平台只去頭尾空白，**不改大小寫**（`E5`≠`e5`，和打卡端比對一致）。
- 已經 `done`／`cancelled` 的單重複回填 → 不改任何東西，回 `{ok:true, data:{job_id,state,already:true}}`（冪等）。
- 成功：
  - `add`：`emp_id` 須符合 `^[A-Za-z0-9_-]{1,32}$`（保留原字串，不轉大小寫）；寫 `staff_clock`＝`home／created／confirmed／roster_active=TRUE`（已有同鍵 suggested／rejected 列則改成 confirmed）。同鍵已對給別人、或該人此店已有別的 confirmed → 單轉 `failed`（`conflict`）。若 expect 有 `demote_old`（調店）：此人其他店的 home 改 support，並進 `transfer_ask`。
  - `deactivate`／`reactivate`：該對照 `roster_active` 立刻改 FALSE／TRUE（`expect.then=reject` 的另外把 state 標 rejected）。
  - `link`：`link_key` 只進 CacheService（`clk_link_<job_id>`、120 秒）；沒給金鑰 → `failed`。
  - 單轉 `done`、`done_at`、`next_at` 清空。
- 失敗：`tries+1`、`last_error` 記代碼與訊息（≤200 字）。
  - 永久性（`unauthorized, bad_version, bad_input, duplicate_name, not_found, disabled, conflict`，或 `retry:false`）→ `failed`，不自動重試。打卡端另會回 `unknown_action`／`bad_json`／`server_error`（該店 SvcStaff 沒部署、或打卡端例外），一律視為**暫時性**：走下面的重試排程（1／5／30 分鐘、之後每 6 小時）。
  - 其他 → 回 `pending`，`next_at`＝現在＋1／5／30 分鐘（第 1／2／3 次失敗）、之後每 6 小時。`tries≥3` 進 `clockAlerts.outbox_failed`。
- 輸出：`{ok:true, data:{job_id, state, tries?, next_at?, emp_id?}}`。

### 3.5 clockRosterApply_(store_code, rows, payrollNames?, now?)
- `rows`＝該店 `svc_roster` 完整名冊：`[{emp_id, name, active, created_at, removed_at, line_bound, last_punch, src_store, src_emp_id}]`；`payrollNames`（選填，光復）＝`[{store, emp_id, name}]`。
- 對照表有的列：更新 `roster_active`、`last_punch`；名冊完全沒有的編號 → `roster_active=FALSE`。
- 名冊在職、對照表沒有的新列：有 `src_store/src_emp_id` 且來源對照是 confirmed → 新增 `support／auto_support／confirmed`（同人同店已有 confirmed 時不加，列為沒對照）；否則列入該店「打卡上有、沒對照」。
- 首次支援（`source=auto_support`）的對照，名冊已停用、而 DZY 仍在職且沒登記離職 → 對照標 `rejected`（之後不會再被自動加回）。
- 重算該店三份狀態並整份取代：`unmapped`、`name_diff`（confirmed 且名冊姓名≠管理系統姓名；比對去空白）、`payroll_diff`（同店同 emp_id，名冊姓名≠薪資主檔姓名）；並記 `at`。
- 輸出：`{ok:true, data:{updated, created, rejected, unmapped, name_diff, payroll_diff, conflicts}}`（皆為筆數）。錯誤：`bad_input`（店代碼不認得、rows 不是陣列）。

### 3.6 clockDailyApply_(today)
- `today`：`'yyyy-MM-dd'`（或 Date／毫秒）。同步員流程：先對六店 `clockRosterApply_`，再呼叫本函式。
1. `last_day < today` 且還在職的人 → 停用（沿用第一期 disable：`prev_status`、users `active=FALSE`、`token_after`＝登出、staff_log）＋他每個 confirmed 對照各發一張 `deactivate` 單（已有未完成單的不重發）。全部在同一支呼叫內寫完。
2. 對帳：DZY 已停用、對照 confirmed 且 `roster_active=TRUE`、沒有未完成 deactivate 單、且今天（`done_at` 日期＝today）沒完成過 → 自動補一張 deactivate 單。
3. 異常 `no_home_map`：打卡單位在職者沒有 home 對照、也沒有進行中的 add 單。
- 跑兩次不重複發單。輸出：`{ok:true, data:{today, disabled:[emp_no], disable_errors:[{emp_no,code}], jobs:[job_id], reconcile_jobs:[job_id], no_home_map:[emp_no]}}`。
- 離職判斷是 `last_day < today`，晚跑不會漏（開機補跑照常呼叫）。

### 3.7 clockMapBuildApply_(rostersByStore, now?)
- 輸入：`{store_code:[roster rows]}`（只看 `active` 的列；店代碼不認得的略過）。
- 聚人：同名（去全形／半形空白）或 `src_*` 指到的列 → 同一人（跨店）。
- 每一組：
  - 同店有兩個以上編號 → `needs_hq` `dup_in_store`。
  - 比對**全部** DZY（含停用、不限單位）：0 個 → 候選新人（`candidates`，不建 staff；組內全部已有對照的略過）；多個 → `needs_hq` `ambiguous`；剛好 1 個 → 各店寫 `suggested／name_match`，`home`＝該 DZY 單位對應的店、其他 `support`（DZY 單位沒打卡＝全 support）。
  - 已存在的對照列不動（confirmed 保留；rejected → `needs_hq` `rejected`；此人此店已有別的 confirmed → `needs_hq` `conflict`）。
- `CLOCK_MAP_STATE` 整份重寫（`excluded` 保留、店長轉來未處理的 `escalated` 保留）。可重跑、不重複建列。
- 輸出：`{ok:true, data:{suggested, kept, candidates, needs_hq}}`（筆數）。

### 3.8 clockAutoSupportCheck_(params)／clockAutoSupportRecord_(params, now?)（7A，mini 把關）
- `params`：`{store_code(B 店), src_store, src_emp_id}`；Record 另需 `emp_id`（B 店 svc_add 回的編號）。
- Check（唯讀）→ `{ok:true, data:{allowed:boolean, reason?, emp_no?, name?, store_code?}}`。全部成立才 `allowed:true`：來源對照 confirmed、對到的 DZY 在職且 `last_day` 空白、B 店啟用且≠來源店、B 店沒有此人的 rejected／停用（`roster_active=FALSE`）對照、B 店沒有已生效或待確認對照。
  `reason`：`bad_input`｜`not_ready`｜`store_disabled`｜`same_store`｜`source_not_confirmed`｜`staff_left`｜`leave_registered`｜`removed_before`｜`already_mapped`｜`suggested_exists`。**mini 只有 allowed:true 才可以用 B 店金鑰呼叫 svc_add**（`created_by`＝`LINE 自動（首次支援）`、帶 src_*）。
- Record：同組再把關一次（防止檢查到寫入之間 DZY 被停用等）；寫 `support／auto_support／confirmed／roster_active=TRUE`、`confirmed_by=LINE 自動（首次支援）`。同一組重送冪等（回 `already:true`）。輸出 `{emp_no, store_code, emp_id}`。錯誤：`bad_input`、`not_allowed`（含 reason）、`conflict`（此編號已對給別人）。

## 3.9 第一期 staffSetActive(true) 的限制
有 `last_day` 的人（登記過離職）用舊「啟用」會被擋：`{ok:false, code:'use_reinstate', error:'…請用「復職」恢復…'}`，請走 `staffReinstate`（清 last_day＋恢復打卡）。沒有 last_day 的人（人資手動停用）舊啟用照常。

## 3.10 上線前關修正（2026-10-13，Fable＋GPT 互盲；代號見 prelaunch-review.md）
- **F2＝G14**：staffCreateByUnit、staffRename、clockCandidateCreate 姓名開頭是 `= + - @` → `bad_input`（試算表會當公式）。
- **F4＝G11**：`clockRosterApply_` 對「有 src_* 的新列」改呼叫 `clockAutoSupportCheck_`（與 7A 同一套條件）；不過 → 該列進「打卡上有、沒對照」並**自動開補償停用單**（`summary.compensated`）。沒有 src_* 的新列只進異常（G4 查證：每日路徑完全不依姓名建對照，姓名比對只在手動的 clockMapBuildApply_，且只產生 suggested）。
- **F1＝G3**：`add` 單 `tries>0`，或 `running` 過期重撿，**送前不取消**（打卡端可能已建；origin_op 冪等）；add 成功時若該人已停用／已過離職日，立刻補一張停用單。新增內部函式 **`clockCompensate_(store_code, emp_id, reason, emp_no?, now?)`**：7A 在店端建好人（svc_add 成功）卻記錄失敗時由同步員呼叫，開 `deactivate` 補償單（`expect.comp=true`，只在該編號已有 confirmed 對照時送前取消）；同編號已有未完成補償單則回既有（`existing:true`）；編號已有生效對照回 `conflict`。補償單進 `clockAlerts.compensations`（紅燈）。claim 回傳多一個 `comp:boolean`。
- **G2**：該打卡編號有 `running`（送出中）的 add／deactivate／reactivate 單時，`clockMapDecide` 不能退回或改綁給別人（`job_open`）；`clockOutboxDone_` 回填 deactivate／reactivate 前比對對照仍是原人、原狀態，否則不改對照、記 staff_log `outbox_done_stale`（下次名冊同步校正）。pending 的單不擋（送前重驗會取消）。
- **G5**：`clockMapBuildApply_` 名字比對只看在職者（排除 disabled、last_day 已過）；只對得到已離職者 → `needs_hq` `disabled_match`（不建 suggested、不當新人）。
- **G6**：離職連動時平台帳號列遺失，staff 仍標停用、店端停用單照發；`disable_errors` 回 `user_missing`、staff_log `disable_failed`、`leave_overdue` 持續列出（停用後帳號沒停乾淨也算）。
- **G7**：第一期 `staffEdit` 改單位後，同樣走調店流程（`clkAfterConfirm_`：已有 confirmed 對照才處理）。
- **G8**：第一期 `staffSetActive(false)` 後立刻對每個 confirmed 對照（roster 未停用者）發 deactivate 單（`clkAfterDisable_`），不等隔日對帳。
- **G12**：`clockDailyApply_` 新增：`source=auto_support` 的 rejected 對照、打卡帳號又在職、人也在職 → 發 deactivate 單（`expect.state=rejected, staff=active`；回傳 `rejected_jobs`）。rejected 但打卡在職、離職者只有 suggested 對照而打卡仍在職，兩種都進首頁異常（見下方 alerts 說明）。
- **F3**：`clockAutoSupportCheck_` 新 reason `source_stopped`（來源對照 `roster_active=FALSE`）。
- **F5**：`clockRosterApply_` 收到空 `rows` 而該店已有 confirmed 對照 → `{ok:false, code:'empty_roster'}`，不套用。
- **F6**：`clockOutboxDone_` add 成功結果若帶 `active:false`，對照照實寫 `roster_active=FALSE`（進 `home_stopped`）。
- **F10**：`clockLink` 支援店（role=support）的連結只給總部，店長 → `no_perm`。
- **Fable 驗證補強**：(1) G2 的「送出中」只算 `running` 且 `lease_until` 未過期；lease 過期的 running 單視同 pending，不擋改綁／退回，且總部可重試或取消（`clockOutboxRetry`／`clockOutboxCancel` 的「卡住」條件含此情形）。(2) 送出中判斷不以對照列存在為前提：補償單 running 時，`clockMapDecide` confirm 與 `clockCandidateCreate` 都回 `job_open`。(3) 第一期 `staffImport`／`staffAdd`／`staffEdit` 改名同樣擋 `= + - @` 開頭（載入 StaffClock.gs 時）；`staffEdit` 改名對「單位有打卡或有未退回對照」的人上限 20（其餘維持 30，第一期匯入資料不受影響）。
- **G9 actual_active**：`clockOutboxDone_` 的 result 對 deactivate／reactivate 可帶 `actual_active:boolean`（同步員讀到店端實際在職狀態）。與目標不同（deactivate 目標 false、reactivate 目標 true；`ok:true` 或 `error:'conflict'` 皆然）→ 單轉 `failed`（`last_error` 以 `conflict` 開頭）、對照 `roster_active` 照實寫、進 `outbox_failed`。一致則照常成功。
- **G6 svcDirectory**：回**全部** staff（在職與停用都回，`active` 表狀態；沒有 confirmed 對照的人也在，`clocks` 只放 confirmed），回應多 `total`（筆數，＝`data.length`）與 `generated_at`（`yyyy-MM-dd HH:mm:ss`），佈告欄據此判斷名單完整。
- `clockAlerts` 沒有新增頂層類別（前端不必新增列）：rejected 但打卡在職 → 併入 `unmapped`（多 `reason:'rejected'`、`emp_no`，總部才有）；離職者只有 suggested 對照 → 併入 `left_but_active`（多 `suggested:true`）；補償停用單（未完成）→ 併入 `outbox_failed`（多 `comp:true`、`reason`，總部才有，未完成就亮）。`counts` 另有 `rejected_active`、`left_suggested`、`compensations` 筆數。

## 4. Hook（Staff.gs 內的小改動，沒有 StaffClock.gs 時自動略過）
- `setupStaff` 結尾呼叫 `clkSetup_`（建三分頁＋staff 右側欄）。
- `handleStaffList_` 呼叫 `clkDecorateStaffList_`。
- `staffConfirm`／`unitApprove` 確認組織變更後呼叫 `clkAfterConfirm_(emp_no, 舊單位, 新單位, 操作者)`：舊單位非空、他已有 confirmed 對照、新單位有打卡才處理——新單位已有他的 confirmed 對照＝直接升主店（舊主店降 support、進 `transfer_ask`）；沒有＝開一張 `add` 單（`demote_old`）。第一次認領把單位從空填成某單位**不算調店**。

## 5. 已知限制與取捨（給前端／同步員知道）
- 第一期退回認領／撤回認領（`stfClearClaim_`）原本會清掉組織四欄；已處理：有到職日（店長新增）或已有 confirmed 打卡對照的人，退回時保留 brand／unit／dept／title（`clkKeepOrgOnClear_`），p_* 與個資照清；一般同仁（113 人匯入）行為不變。
- `staffEdit`（第一期總部直接改姓名）不會產生「打卡姓名不同」提醒；改名請走 `staffRename`。
- 「已綁 LINE 的同一人」無法在建對照時用來聚人（`svc_roster` 只回 `line_bound` 布林，沒有 LINE 身分）；目前只用「同名去空白＋src_*」。
- 名冊姓名、候選新人姓名存在 Script Properties（`CLOCK_MAP_STATE`／`CLOCK_SYNC_*`），僅正式環境內部；量級約 50 人，遠小於單值上限。
- 店長新增的單位固定是自己的；若要新增到別的單位請總部操作。
