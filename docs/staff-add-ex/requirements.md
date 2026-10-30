# 指定同仁可新增同仁（限本店）— requirements／spec v1.0（2026-10-30 Eason 定案：1A 2B 3A 4A）

需求來源：Eason 2026-10-30「讓正職同仁也可以新增同仁跟負責考勤」，選「做個別例外」。
公開 repo：本檔不寫同仁真名。

## 0. 現況

| # | 事實 | 出處 |
|---|---|---|
| F1 | 「新增同仁」只有兩種人能按：總部（platform.staff）與單位主管（stfManagerScope_：store 階梯職級 ≥ 3＝店長、廠長以上）。沒有任何權限碼或例外能給正職 | StaffClock.gs clkActor_／clkNeedActor_、Staff.gs STF_UNIT_VIEW_MIN_RANK |
| F2 | 店長新增時單位固定是自己的店，職稱不能高於自己；送出後自動開打卡建檔單，約 1 分鐘建好打卡編號 | handleStaffCreateByUnit_、clkResolveOrg_ |
| F3 | clkNeedActor_ 這一關同時放行：新增、離職登記／撤銷、改名、復職、打卡連結、單位名單、待辦單狀態 | StaffClock.gs 第 5–9 節 |
| F4 | 打卡連結＝可以用那位同仁身分打卡的專屬連結（金鑰） | handleClockLink_ |
| F5 | 「我的單位」分頁要 platform.review（單位主管衍生權限），正職看不到 | modules/me/manifest.js |
| F6 | 考勤：已有個別例外「額外考勤核定」att.extra，人資主管／admin 可設，核同單位工時與申請（不核自己）——**本案不用做** | StoreOps.gs storeAttTargets_、PermActions.gs |
| F7 | 現成的帶單位個別例外：att.view@、store.sm@（兼任店長，不能設本店）、payroll.store@ | Perms.gs |

## 1. 要做的事

新個別例外功能碼 `staff.add@<單位代碼>`，畫面顯示「可新增同仁（<單位>）」。

### 1.1 設定（待確認 Q1、Q4）
- 寫在「權限設定 → 個別例外」，沿用到期日、原因、撤銷、權限異動紀錄；只能多給。
- 誰能設：**Q1**。
- 對象：在職、主要單位＝例外的單位、單位是門市或央廚（store 階梯）。
- 調店後：**Q4**。

### 1.2 拿到例外的人能做什麼（待確認 Q2、Q3）
- 「我的資料」多出「我的單位」分頁：看本店同仁名單（同店長版，不含手機、生日、地址）＋「新增同仁」按鈕。
- 新增時單位固定本店，可選職稱見 **Q3**；其餘流程與店長相同（同名擋、自動建打卡）。
- 範圍見 **Q2**。

### 1.3 不會改變的事
- 不會因此能審認領、核考勤、送人事單、看打卡對照、看首頁打卡異常。
- 店長、人資原本的新增流程不變。

## 2. 待 Eason 確認

| # | 問題 | 推薦 | 另一個選項 |
|---|---|---|---|
| Q1 | 誰能開這個例外 | **A** admin＋人資主管（同「額外考勤核定」） | B 只有 admin |
| Q2 | 能做哪些事 | **A** 只能新增；新增完當場拿打卡連結；之後 7 天內可再拿「自己新增的人」的打卡連結 | B 跟店長一樣：新增、登記離職、改名、復職、本店任何人的打卡連結 |
| Q3 | 能新增哪些職稱 | **A** 不高於自己（正職可加計時、正職） | B 只能加計時 |
| Q4 | 調店後 | **A** 自動失效（例外綁那家店，要重開） | B 跟著人走到新店 |

## 2b. 定案（2026-10-30）
- Q1 A：admin＋人資主管可設（人資主管不能設給自己）。
- Q2 B：跟店長一樣。**更正確認頁的說法**：店長本來就不能改名、復職（那兩支只給總部，clkNeedHq_），所以「跟店長一樣」實際＝
  新增本店同仁、登記／撤銷離職（只能對職級比自己低的人；正職＝只能對計時）、本店任何人的打卡連結（只限主店帳號）、
  「打卡對照」分頁（本店對照的確認／退回）、首頁本店打卡提醒、本店名單。
- Q3 A：不高於自己（沿用 clkResolveOrg_ 的職級檢查）。
- Q4 A：例外綁單位；只有「例外單位＝本人目前主要單位」才生效，調店自動失效（例外列不會被改，撤銷或到期照舊）。
- 仍然不給：待審核（認領審核）、考勤（另開 att.extra）、人事異動、稽核、績效評核。

## 3. 實作
- Perms.gs：`PERM_STAFF_ADD_PREFIX/RE`，不在 PERM_GRANTABLE、只走個別例外；permValidateEx_／permName_；Q1=A 時加進 PermActions.gs 人資主管可設清單。
- StaffClock.gs：clkActor_ 本人沒有主管範圍、但有有效 staff.add@<主要單位> → 給 scope（store 階梯）＋本人職級，flag `viaStaffAdd`。clkNeedActor_ 的入口全部照店長版走（Q2 B）。
- Staff.gs stfLoginGate_ 多 `unitstaff`；Auth.gs 補衍生權限 `platform.unitstaff`（不是 platform.review，避免開到待審核）。
- 前端：modules/me「我的單位」「打卡對照」requires 加 platform.unitstaff；viewerOf isLead 認兩者；首頁打卡提醒同；modules/perms 例外表單加「可新增同仁」＋門市下拉（admin、人資主管都有）。
- minikit：只套改動的 .gs（不從 dzy main 整包 sync-gas）。
- 測試：mock 測試（每個入口 addOnly 放行／擋下、調店失效、到期、撤銷即時）、e2e 一支（正職登入→新增→拿連結）。
