# 兼任店長在兼任的店新增同仁（2026-10-31）

## 起因
權限設定給了「兼任店長」（個別例外 `store.sm@<單位>`，docs/att-hr-acting），但「我的資料 → 我的單位」的新增同仁、離職登記被擋：
`StaffClock.gs clkActor_` 只看本人主要身分的店長資格（stfManagerScope_）與「可新增同仁」例外（staff.add@<主要單位>），不看兼任。

## Eason 決定（2026-10-30 確認頁，全照推薦）
- **1A 比照店長職級**：在兼任的店，新增職稱上限與離職登記的職級比較，用店長職級（本人更高就照本人）。
- **2A 門市切換**：管兩家以上（本身某店主管＋兼任、或兼任多家）時，「我的單位」上方出現門市切換；只管一家的人畫面不變。

## 範圍（跟店長一樣）
新增同仁、登記／撤銷離職、本店名單、打卡連結、打卡對照（待確認列看得到、可處理）、首頁打卡提醒、待辦單狀態。
改名、復職仍只有總部（clkNeedHq_）。權限設定不用多開：有效兼任＝`permActingUnitsOf_`（已含在職、試點、非本店等判斷），撤銷下一個請求就收回。

## 實作
- `clkActor_(token, payload)`：組 `units`＝[{unit, unit_name, rank, via: own|staff_add|acting}]；`scope`／`rank`＝payload.unit 在清單內就選它，否則第一家（主要身分優先）。
  管不到的 payload.unit **照舊忽略**（不擋，維持既有「夾帶單位一律忽略」行為與舊前端相容）。
- `clkCanManageUnit_` 看整個 units；離職職級用 `clkRankFor_(a, 該人單位)`；打卡對照／提醒用 `clkMyStoreCodes_(a)`（所有管得到的店）。
- `staffUnitList` 多回 `unit_name`、`units`（[{code,name}]）；前端 `modules/staff-shared/clock-ui.js mountTeam` 依 units 畫 `[data-role=unit-switch]`，新增帶目前門市 unit。
- 測試：`test/acting-unitstaff.mock.test.mjs`（37 項）、e2e ⑳ `e2e_t20_acting_switch.py`（埠 8850）。
