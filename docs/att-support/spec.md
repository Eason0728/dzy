# 支援打卡誰來核（spec v1.0，2026-10-26 Eason 定案）

需求與題目原文：同資料夾 `requirements.md`。Eason 的答案：1A 2A 3A **4B** 5A 6A 7A。

## 1. 定案規則

- **支援帳號**：同仁的某個打卡帳號（staff_clock，state=confirmed、roster_active≠FALSE）所在打卡店的單位清單（`clkUnitsOf_(store)`）**不含**這位同仁的單位 → 這個帳號算「支援」（1A：不看 role 是 home 還是 support）。
  - 例外：打卡店代碼 `hq`（總部打卡）一律**不算**支援，照原規則（總部沒有店長）。
  - 推算／orphan 的同仁（storeEffectiveTarget_ inferred／orphan）照舊，不套本規則。
- **支援帳號的核定人**（工時 hours 與申請 req 都一樣，2A；總部同仁到門市也一樣，5A）：打卡店單位 S 的主管，**依序取第一個有人的那層**（3A）：
  1. S 是 store 階梯：同單位在職的店長 `sm`；S 是央廚 `ck`：在職廠長 `fm`。
  2. 沒有 → store：同單位在職區經理 `am`；ck：在職廚藝總監 `rdd`（掛 ck）。
  3. 沒有 → store：REGIONS_ON 開時，負責 S 那區的在職區督導 `osv`（regionOfficeCovers_）；開關關或沒劃區／沒督導 → 跳過。
  4. 沒有 → store：S 所屬品牌辦公室的在職總監 `odir`。
  - 人資主管、admin 一律可核（同現行，不含自己，hours 店長自己核自己的例外不適用於支援帳號）。
  - 任何人都不能核自己（本人是 S 的主管又在 S 有「支援」帳號＝不可能，仍防呆）。
  - att.extra（額外考勤核定）：照現行只看「被核者單位＝我的單位」，支援帳號改看「S＝我的單位」。
- **原單位主管唯讀（4B）**：依現行規則（以人為單位）本來能核這位同仁的人，對這位同仁的支援帳號改成**只看**（進 `att.view_people`），不進 people／req_people。
- **督導／總監只看**（REGIONS_ON='1' 的既有功能）：可看單位改以「打卡店單位」判斷（不是人所屬單位）：帳號的店單位在 attViewUnitsOf_ 清單內才列入 view_people。
- **非支援帳號**：完全照現行（attApproverOf_、storeAttViewTargets_）。
- **生效**：即時計算，上線當下所有未核的支援帳號紀錄都改給打卡店（6A），不另做資料搬移。
- **試點**：支援帳號是否列入，看打卡店單位 S 是否在試點 `STORE_SSO_UNITS` 內（不是看人所屬單位）。

## 2. 指定門市只看考勤（7A）

- 新個別例外功能碼：`att.view@<單位代碼>`，例 `att.view@mala-gf`。**只能用個別例外給**（對照表規則不收），只有 admin 能設（不進 STORE_HR_GRANTABLE；人資主管看不到）。
- 合法條件：單位代碼存在、active、store 階梯（含 ck）。
- 效果：ident 的 `att.view_people` 加入該單位的全部打卡帳號（打卡店單位＝該單位，且帳號主人需要核定工時、非本人），只看不核；同時讓這個人通過考勤管理入口（platform.att 衍生權限）。
- 顯示名稱：「只看考勤（<單位名稱>）」。權限設定 → 個別例外：功能選「指定門市只看考勤」後出現門市下拉選單。

## 3. 不變

營運系統收到的 ident 形狀（people／req_people／view_people 都是 `{clock, emp_id, sub, name}`）不變；薪資；打卡方式；誰能進考勤管理的既有條件（只多了 2. 的例外）。

## 4. 部署

dzy 後端（Mac mini）先，dzy 前端（權限設定的門市下拉）後。營運系統不用改；「支援」標示另案。

## 5. 追加（2026-10-26 Eason）

- 品牌辦公室同仁（區督導 osv、行政 ofs、區經理 oam）到門市打卡**不算支援**：照原規則由辦公室總監核，店長不核也不看（`storeAttIsSupport_` 第 4 參數 org）。
