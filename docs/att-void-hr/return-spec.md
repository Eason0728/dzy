# 人資退回給店長重核（spec v1.0，2026-11-13 Eason「紅燈全照推薦」：1A 2A 3A 4A 5A 6A）

## 規則
| # | 定案 |
|---|---|
| 1A | 誰能退回／取消：人資主管、admin（工時名單內），以及有「考勤作廢」att.void 的人資同仁（void_hours 內）；本人的不行 |
| 2A | 原核定保留（打卡端不動、薪資照舊），營運系統記一筆 open；店長重新送出核定（mgr_approve 成功）就 resolved |
| 3A | 店長在考勤管理「核定工時」上方看到「人資退回 N 筆」（理由、退回人），當天卡片姓名旁「人資退回」、卡片內有理由；不發 LINE |
| 4A | 理由必填（200 字內），店長看得到，同仁看不到（不送打卡、不進 LINE） |
| 5A | 薪資已鎖定的月份不能退回：營運系統向打卡端 payroll_leave_options 讀 `locked`（2026-11-13 Eason 鎖月 A，光復 @263 上線）；讀不到時照樣退回、標 lock_unknown（畫面提示「沒辦法確認薪資有沒有鎖定」） |
| 6A | 店長重核前，有權限的人可「取消退回」 |

## 實作（營運系統）
- 資料表 `duty_returns`（DB v36），模組 `server/hr-return.js`。
- 動作（`/m/duty/…`，proxy/duty.js `local: true`，不送打卡）：`hr_return_create {emp_id,date,reason,store?}`、`hr_return_cancel {id,store?}`、`hr_return_list`（全部門市可用）。寫入需 5 分鐘內驗證（同其他考勤寫入）。
- `mgr_day` 每位同仁多 `hr_return`（open 那筆）與 `return_ok`（這個人能不能退回：已核定、還沒退回、有權限）。
- 只能退回「已核定」的那天；同一人同一天同時只有一筆 open。
- 測試：`test/server/hr-return.test.js`、e2e `test/e2e/mod_hr_return.py`。
