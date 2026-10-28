# 共用契約：值班主管本人申請改由上層審（B 案，Eason 2026-10-28「照推薦」）

規格：同資料夾 req-upper-spec.md（§2–§6、§9 全照推薦：B 考勤管理；五種單全算；核准／退回／作廢都擋；跨店；正職兼值班跳過同店主管；舊待審單即時套用；找不到上層→人資主管＋首頁提醒）。
公開 repo 不准寫同仁真名（測試用「測試一」等）。

## C1 打卡端（mala-clock-in，worktree ~/wt-req-upper-clock，分支 req-upper）
- managers 分頁可選欄 `emp_id`（附在最後；setup/addManager 不必改；讀取用實際表頭）。
- 「值班主管」本店判斷 `reqLocalDutyMgrs_(ss)` → `{ emps: {emp_id:true}, warn: [{name, reason}] }`：
  managers 列 active=TRUE 且 allow_acting 不是 TRUE（營運系統專用列不是人）：
  1. 有 emp_id → 該 emp_id；
  2. 否則姓名去所有空白後比對 roster 在職（active=TRUE）同名：恰 1 → 該人；≥2 → 全部算，warn reason `same_name`；0 → warn reason `no_match`。
- 跨店名單：Script Property `REQ_UPPER_EMPS`（JSON 陣列 emp_id 字串；讀壞＝空陣列）。
- `reqIsUpper_(emp_id)` ＝ 本店判斷 ∪ REQ_UPPER_EMPS。
- 擋法（Requests.gs）：
  - `mgr_req_decide`（approve 與 reject）、`mgr_req_void`：目標申請 reqIsUpper_ 且主管列 allow_acting 不是 TRUE → `{ok:false, error:'upper_review', message:'這是值班主管本人的申請，請由上層主管在管理系統（人資部門 → 考勤管理 → 申請審核）審核'}`，不寫任何東西。allow_acting=TRUE（營運系統）照常放行（營運系統依管理系統名單把關）。
  - `mgr_req_decide_batch`：同條件 → skipped，reason `值班主管本人的申請，送上層審核`。
  - `mgr_req_pending`：每筆多 `upper: true|false`。
  - need_proof、撤銷等其他規則不變。
- `svc_roster`：每列多 `duty_mgr: true|false`（只用本店判斷，不含 REQ_UPPER_EMPS）；最上層多 `mgr_warn: [{name_len, reason}]`（**不回姓名**，只回字數與原因；給 mini 記 log）。
- 新 `svc_set_upper {svc_key, emp_ids:[...]}`（SVC_STAFF_HANDLERS）：去重、只收非空字串、上限 500；寫 Script Property REQ_UPPER_EMPS；回 `{ok:true, n}`。
- manager.html：upper 那筆標「送上層審核中」，核准／退回／作廢鈕 disabled，勾選框 `rq-pick-off` 不參加全選；改完跑 tools/build-store-pages.py，六份 manager*.html 都要有。
- mock（mock/requests_mock.py 等）同步：managers 支援 emp_id、pending 回 upper、decide 擋。

## C2 管理系統（dzy，worktree ~/wt-req-upper-dzy；minikit ~/wt-req-upper-minikit）
- staff_clock 分頁尾端新欄 `duty_mgr`（'TRUE'/'FALSE'；依實際表頭讀寫，舊表自動補表頭）；`clockRosterApply_` 依 svc_roster 列的 duty_mgr 寫入（欄位不存在＝FALSE）。
- 新全域函式 `clockUpperEmps_()`（**不進 Code.gs 分派表**；給 mini jobs 用）：找出「有任一 state=confirmed 且 roster_active!=='FALSE' 且 duty_mgr=TRUE 對照」的 DZY 同仁，回 `{ok:true, stores:{<store_code>:[emp_id…]}}`＝這些人在每一店所有 confirmed 對照的 emp_id；六店代碼都要有 key（沒有＝空陣列）。
- StoreOps.gs（只影響 mode 'req'）：
  - 人物件多 `duty_units`：該人 duty_mgr=TRUE 的對照所在打卡店 → clock_stores.unit_code 的單位清單。
  - target 是值班主管（duty_units 非空）時：need.kind 'unit'（計時／正職兼值班）改成同店長的鏈 `{kind:'head', unit, brand}`；**且 approver 的 duty_units 含 need.unit 的一律不算**（同店也拿主管鑰匙的人，含區經理）。支援帳號（打卡店≠原單位）照現有支援規則算核准人，同樣排除該打卡店單位的值班主管。
  - 人資主管、admin 照舊全可核。
- 找不到上層提醒：新讀取 action `attUpperGaps`（要 platform.att 且是人資主管或 admin，否則回空）→ `{items:[{emp, name, unit_name}]}`＝值班主管且依表找不到任何在職核准人（不計人資主管／admin）；加 dryrun.js READ_ACTIONS、minikit app.json readActions。`modules/attendance` alerts() 有項目時加一行 warn「N 位值班主管的申請找不到上層，由人資主管審」，view 指 request。
- minikit jobs.js：每日同步跑完六店 clockRosterApply_ 後，`gas('clockUpperEmps_')`，CLOCK_WRITE==='1' 時逐店 `svc(c,'svc_set_upper',{emp_ids})`；單店失敗只記 log／health 不擋其他店。minikit gas/ 只套自己改的 .gs（不要從 dzy main 整包 sync-gas），更新 SOURCE.sha256 那幾行。

## C3 營運系統（mala-store-ops，worktree ~/wt-req-upper-storeops）
- web/modules/duty/request.js：item.upper=true 時：能寫的人那列加標籤「值班主管本人」；唯讀的人顯示「送上層審核中」。其他不變（錯誤字句後端已轉）。
- server/proxy/duty.js：不用改權限（mgr_req_pending 欄位原樣轉）；確認 filter 不會吃掉 upper 欄。
