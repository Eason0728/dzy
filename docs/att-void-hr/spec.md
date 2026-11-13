# 考勤作廢 att.void（spec v1.0，2026-11-13 Eason 開工：1A 2A 3A 4A 5A 6A）

公開 repo：不寫同仁真名。確認頁：`kickoff.html`。

## 規則
- 新權限碼 `att.void`「考勤作廢」：只走個別例外（perm_ex），admin 與人資主管可設（人資主管不能設給自己），可設到期日、撤銷、有 perm_audit。
- 持有人（在職、身分有效、不是 admin／人資主管）：
  - 管理系統 ident 多 `att.void_hours`、`att.void_req`＝人資主管同一份工時／申請名單（全集團、不含自己）。一般三份名單（people／req_people／view_people）**不變**。
  - 衍生權限：多 `platform.att`（考勤管理選單）與 `platform.sched`（唯讀看門市班表）；`platform.storeops` 不因此改變。
  - 營運系統：兩份名單併進 viewKeys（讀，卡片唯讀）；作廢已核准申請——忘刷單看 void_hours、加班／請假／出差看 void_req；本人（ownSet＝三份名單裡的自己＋self＋own_clocks）不行；主管代開（proxy_by）照舊只有總監層級。核准、退回、批次、核定工時、名冊、manager_only 一律不行。
  - `dutyView.void`＝這家店能作廢的 emp_id；前端唯讀卡片依此顯示作廢鈕，逐張仍看伺服器 `void_ok`。
- admin／人資主管拿到 att.void：沒有效果（本來就能作廢）。

## 相容
- 營運系統 parseIdent：兩欄選填；空陣列不放；格式不合格整份身分不收（同 req_people）。舊版管理系統沒有＝沒有作廢權。
- 新管理系統＋舊營運系統：舊版 parseIdent 只留契約欄位，多的兩欄丟掉 → 等於沒開。上線順序不拘，建議先營運系統、後管理系統。

## 已知
- 手機「一頁核定」唯讀的人照舊顯示「N 人不在你的核定名單（唯讀），請到完整頁看」，作廢在完整頁。
- 唯讀班表：2026-11-13 Eason 第 6 題選 A「給唯讀班表」→ 持有人有 platform.sched，營運系統 schedView 不看職稱（作廢名單非空即給，scheduleAdmin 仍 false、看不到特休）。
