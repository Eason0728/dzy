# 排班管理（指定門市）個別例外 — requirements／spec v1.0（2026-11-15 Eason 開工：1A 2A 3A 4A）

需求來源：Eason 2026-11-15「讓督導有排班管理的權限」→「個別例外新增一個排班管理選項，之後正職同仁會排班時候也可以使用」。
開工確認頁：`kickoff.html`（同資料夾；Artifact https://claude.ai/artifact/MrK41qbJnJgiiTnLw5JLXc ）。公開 repo：本檔不寫同仁真名。

## 0. 現況
| # | 事實 | 出處 |
|---|---|---|
| F1 | 能排門市班的人＝店長、廠長、區經理（STORE_SCHED_GATE_TITLES）、兼任店長、人資主管、管理員、品牌總監（odir，ident.sched_units） | StoreOps.gs storeSchedGate_、storeSchedDirector_ |
| F2 | 督導（osv）在 REGIONS_ON 開時只能唯讀看負責區域的門市班表 | StoreOps.gs storeSchedViewGate_；營運系統 person.js schedView |
| F3 | 營運系統認 ident.sched_units：該店在清單內＝scheduleAdmin（排班跟店長一樣），不算 isManager | mala-store-ops server/person.js schedUnit |
| F4 | 兼任店長 store.sm@ 也能排班，但連帶給考勤核定、請購第一關、新人開通等 | Perms.gs、AiHelpSeed 兼任店長題 |

## 1. 定案
- Q1 A：可以設在**任何一家門市**（不限本人主要單位；督導、正職都能用）。一家店一筆。
- Q2 A：**只限門市**。央廚（固定排班、廠長設）、總部與品牌辦公室（自填）不行（同 permActingUnitOk_）。
- Q3 A：admin＋人資主管能設（人資主管不能設給自己）。
- Q4 A：權限＝跟店長排班一樣（排班、自動排班、鎖定解鎖、送 LINE、看特休生日手機）；不能在排班頁新增同仁（addHire 仍擋，同總監）；不給考勤核定或其他店長權限。

## 2. 實作
- 權限碼 `sched.admin@<門市單位>`，畫面「排班管理（指定門市）」，清單顯示「排班管理（品牌 門市）」。只走個別例外、只能多給、不進 permCompute_ 的 perms。
- Perms.gs：permSchedAdminUnit_／permSchedAdminUnitOk_／permSchedAdminMap_（active、add、未過期、本人在職且主要身分有效、單位在試點；請求內快取，permActingReset_ 一起清）／permSchedAdminUnitsOf_；permValidateEx_、permName_；permSessionCompute_ 補 sources（「我的資料」顯示個別例外與到期日）。
- PermActions.gs：人資主管可設、可列；permExList 回 `sched_admin_units`（同兼任店長清單）；新增擋不在職、本來就是該店店長／廠長、同人同店生效中重複；撤銷同碼一起撤；寫權限異動紀錄。
- StoreOps.gs：ident `sched_units`＝總監 units ∪ 例外門市（試點內），排序去重；storeSchedGate_ 有例外＝platform.sched。
- 前端：modules/perms/lib.js（SCHED_ADMIN_*、schedAdminUnitOf／schedAdminCode、featureName）、views/ex.js（選項、門市下拉、說明）。
- **營運系統不改**（契約 sched_units 已存在）。

## 3. 不做
- 督導依區域自動拿排班（要做另開案）。
- 央廚、總部的排班例外。
- 排班頁「新增同仁」。

## 4. 決定紀錄（做的時候自己定的）
- （綠）本來就是該店店長／廠長的人設本店 → 擋「本來就能排班，不用設」（同兼任店長）。
- （綠）同人同店多筆生效（舊資料）→ 對照只留一筆、取最晚到期；撤銷一筆＝同碼一起撤。
- （黃）門市不在試點（STORE_SSO_UNITS）→ 存得進去但不生效（同兼任店長；ident 只放試點內）。
