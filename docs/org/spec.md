# 規格：鼎兆元組織架構改版（spec）

- 日期：2026-10-14　狀態：已確認（Eason 2026-10-14：1A、2B、3B、4A；見第 10 節）
- 依據：requirements.md 第 3、7 節。程式行號以 2026-10-14 main（4d7270b）為準。

## 1. 架構總覽
不新增系統、不新增分頁。改動集中在平台後端 `apps-script/platform/Staff.gs`、`StaffClock.gs`、`Code.gs` 與前端 `org-fields.js`（兩份）、`modules/staff`、`modules/me`。
組織資料仍是 org 分頁（欄位 `kind,code,name,parent,ladder,rank,order,active`），**只改資料列與一個新的 ladder 值，不改欄位**。

## 2. 組織資料（org 分頁改成這樣）
| kind | code | name | parent | ladder | 變化 |
|---|---|---|---|---|---|
| brand | ck | 中央工廠 | | | 改名（原「央廚」） |
| unit | ck | 中央工廠（央廚） | ck | store | 改名；打卡、薪資代碼 CF 不動 |
| unit | mzt-hq | 墨竹亭品牌辦公室 | mzt | **office** | 改名＋改 ladder（代碼不變） |
| unit | mala-hq | 小辛辣品牌辦公室 | mala | **office** | 同上 |
| unit | yiwu-hq | 一悟燒肉品牌辦公室 | yiwu | **office** | **新增** |
| unit | mzt-wx／mzt-rg／mzt-mc | （原名） | mzt | store | active＝FALSE |
| dept | training | 訓練部 | dzy-hq | | 保留（第 10 個部門） |

- **代碼一律不改**（mzt-hq、mala-hq 沿用）→ 同仁資料、打卡對照、佈告欄對照都不用搬。
- 中央工廠＝單位 ck，不在 dzy-hq 底下另開「中央工廠」部門列（避免同一個部門出現在兩個地方）。組織圖上畫在總部底下、與其他 9 部門並列。
- 品牌辦公室 ladder＝`office`，**有自己的一套職稱**（Eason 3B），不選部門：

| kind | code | name | parent(ladder) | rank |
|---|---|---|---|---|
| title | os | 品牌專員 | office | 1 |
| title | osv | 品牌督導 | office | 2 |
| title | obd | 品牌總監 | office | 3 |

- 門市那套的「督導 sv」「品牌總監 bd」保留不動（已有人用就照用）；升級報告會列出「掛在門市、職稱是督導／品牌總監」的人，建議人資改派到品牌辦公室。

### 2.1 程式要認 `office`
- 職稱下拉與後端驗證本來就依 unit.ladder 篩職稱（org-fields.js:47-52、Staff.gs:209），office 職稱列存在後**自然生效，不用改**。
- `STF_UNIT_VIEW_MIN_RANK`（Staff.gs:33）加 `office: 2`（品牌督導以上算品牌辦公室主管，給單位通訊錄用）。
- 部門下拉只在 ladder＝hq 出現（org-fields.js:48），office 不出現，不用改。

## 3. 兼任部門
- staff 分頁尾端新增一欄 `extra_depts`（逗號分隔的部門代碼），照 `clkEnsureStaffExtra_` 的做法補在 hire_date、last_day 之後（StaffClock.gs:201-215）；**不改 STF_HEADERS**（改了會撞既有尾端欄）。
- 只有 `platform.staff`（人資）與 admin（BOSS）能寫：`staffEdit` 多收 `extra_depts`；驗證每個代碼是 dzy-hq 底下 active 的部門、不得等於主要部門、不得重複。
- 同仁「我的資料」唯讀顯示；認領畫面不出現。
- **不影響審核**（審核只看主要部門）。

## 4. 審核規則（Eason 2B：只有正上一層能審，再上面找人資）
新函式 `stfReviewScope_(reviewerRow, org)` 與 `stfCanReview_(scope, pendingRow, org)`。`stfManagerScope_` 保留給單位通訊錄與打卡端（只多認 office 門檻）。
被審的人看「送出的」單位／部門／職稱（p_unit、p_dept、p_title）。

| 被審的人 | 誰可以審（全部要 status active） |
|---|---|
| 門市同仁（三品牌各店） | 同單位職級≥店長；**該品牌辦公室**職級≥品牌督導 |
| 中央工廠（央廚）同仁 | 同單位職級≥店長（＝中央工廠主管） |
| 中央工廠主管（ck 職級≥店長） | 執行長以上 |
| 品牌辦公室同仁（任何職稱） | 營運部主管 |
| 總部部門同仁 | 同主要部門的部門主管 |
| 總部部門主管 | 執行長以上 |
| 執行長以上 | 只有人資 |
| 任何人 | 人資（platform.staff）、BOSS |

- 「營運部主管」＝單位 dzy-hq、主要部門 ops、職稱＝部門主管(hm)。「執行長以上」＝單位 dzy-hq、hq 職級≥執行長。
- **營運部主管、執行長不能審門市同仁**；部門主管不能審其他部門。
- 職級比審核者高→不能審：同一階梯才比較（例：區經理送出、店長審 → 擋，轉人資）。同級可以審。
- 不能審自己。
- 登入時「待審核」分頁（衍生權限 platform.review）：審核資格＝上表任一列的審核者身分（店長以上、品牌督導以上、營運部主管、部門主管、執行長以上），改用新規則判斷。

## 5. 停用門市與不合規資料
- org active＝FALSE 的單位：認領、改資料下拉不再出現（現有行為，Staff.gs:237）。
- 同仁名單：單位已停用的人，名字旁標「所屬門市已停用」；另加「需處理」篩選（含：單位停用、職稱不屬於該單位階梯）。
- 人資改資料時重選單位（現有行為，org-fields.js:43）。

## 6. 一次性升級（搬家）
新增 admin 專用 action `orgUpgrade2026`（只有 admin，人資也不行），**可重跑**：
1. 先把 org 分頁整份複製成 `org_bak_20261014`（已存在就不覆蓋）。
2. 照第 2 節改 org 列：改名、改 ladder、停用三店、補 yiwu-hq；已是目標值就跳過。
3. 補 staff 的 `extra_depts` 欄。
4. clock_stores 的 hq 列 unit_code 若恰好是 `dzy-hq,mzt-hq,mala-hq` → 補成 `dzy-hq,mzt-hq,mala-hq,yiwu-hq`（自訂過的不動）。
5. 補三個 office 職稱列（os／osv／obd）。
6. 回傳報告：改了哪幾列、需處理名單（單位停用的人；品牌辦公室裡職稱不屬於 office 的人；掛在門市、職稱是督導／品牌總監的人）——**只列，不自動改**。
- 回退：新增 `orgRollback2026`（admin）把 `org_bak_20261014` 整份蓋回；extra_depts 欄留著無害。
- 新安裝的預設值 `STF_DEFAULT_ORG`、`CLK_DEFAULT_STORES` 同步改成新樣子。

## 7. 下游
| 系統 | 處理 |
|---|---|
| 打卡（總部那套） | 第 6 節第 4 步補 yiwu-hq；其餘不動。打卡端 clkActor_ 只認 store 階梯，品牌辦公室主管在打卡端沒有店長權限＝與現在兩個品牌總部相同 |
| 電子佈告欄 | 不改：mzt-hq／mala-hq 代碼沒變，對照照舊；yiwu-hq 沒有對應組別＝與一悟各店相同（不動）。驗：跑佈告欄 `test/staffdzy.test.js` |
| 稽核／宿舍節點（Users.gs） | 不動 |
| Mac mini 同名 .gs | 照 dzy-admin 流程 `sync-gas.sh dzy-platform` |

## 8. 部署順序（Eason：做好就切）
1. 後端（mini 同步＋重啟）：新程式對舊資料完全相容。
2. 推前端：新前端對舊資料也相容。
3. BOSS 帳號執行 `orgUpgrade2026`（後台「同仁名單」加一顆只有 admin 看得到的按鈕）→ 看報告。
4. 驗：認領下拉、同仁名單、各角色待審核。出事→`orgRollback2026`＋revert。
（office 職稱是資料列，舊前端也能正確列出，順序顛倒也不會壞；仍照這個順序做。）

## 9. 測試
- 更新：`test/staff.mock.test.mjs`（部門 10 個、審核 A 段）、`test/staff-clock.mock.test.mjs`（總部四單位）、`test/staff-front.test.mjs`（兩份 org-fields 一致）。
- 新增：審核規則表每一列各一正一反＋職級高於審核者＋自己＋停用單位；升級可重跑（跑兩次結果一樣）、回退後與備份逐格相同。
- 全部 node 測試＋e2e 八支；真瀏覽器點一次（dzy-admin 規矩）。

## 10. Eason 2026-10-14 規格確認
1. A：中央工廠＝單位 ck 改名，不另開部門列。
2. **B：只有正上一層能審**（第 4 節已改）。
3. **B：品牌辦公室另一套職稱**（第 2 節已改）。
4. A：升級／回退只有 BOSS（admin）能按。

## 11. 設計審修正（GPT 2026-10-14，原文 design-review-gpt.md；以本節為準，前文衝突處以此覆蓋）
| # | 採納 | 修法 |
|---|---|---|
| 1 | 部分 | 待審列若已有「目前身分」（匯入時帶入的 unit／title），審核者必須同時夠格審「目前」與「送出」兩個身分，取嚴者。首次認領沒有目前身分＝只看送出的 |
| 2 | 是 | 跨階梯限制：品牌辦公室審門市同仁時，只能核准門市職稱 pt／ft／sm／am；送出門市 sv／bd → 只有人資 |
| 3 | 是 | 審核者本身的單位、職稱必須 active，且職稱屬於該單位階梯；否則沒有審核資格 |
| 4 | 是 | 「待審核」分頁出現條件＝有審核者資格 **或** platform.staff **或** admin（前後端一致） |
| 5 | 待 Eason | 見下方「升級預覽」：切換前先看會受影響的人（Q：要不要自動對應職稱） |
| 6 | 是 | 升級／回退包在既有寫入鎖；org 列以 (kind, code) upsert，不會重複新增；每一步寫完驗後置條件，重跑從頭比對、已是目標值就跳過 |
| 7 | 是 | 升級同時備份 org 整份＋clock_stores 整份；回退兩份都還原；回退報告列出「切換後被改成新單位／新職稱、回退後會變孤兒」的人 |
| 8 | 是 | 備份分頁名帶時間：`org_bak_YYYYMMDDHHmm`、`clk_bak_YYYYMMDDHHmm`；Script Properties `ORG_UPGRADE_STATE`＝{backup 名、升級後 org 雜湊}。回退前比對雜湊，切換後 org 有人改過 → 拒絕整表覆蓋並列出差異 |
| 9 | 是 | 新增列完整八欄見下表 |
| 10 | 是 | clock_stores hq 列 unit_code 拆成集合，沒有 yiwu-hq 就加（保留自訂值與順序）；佈告欄 yiwu-hq＝不對應任何組別（與一悟各店相同，明文）；未知 ladder 一律當無主管權限 |
| 11 | 是 | extra_depts 只在後端以目前身分判斷 platform.staff；沒帶＝保留；只寫該格不整列覆寫；主要部門有任何變動（核准、後台改）時自動從兼任裡移除新的主要部門 |
| 12 | 是 | extra_depts 允許特別代碼 `ck`（顯示「中央工廠」），代表兼任中央工廠；不新增部門列 |

### 11.1 新增 org 列完整八欄（kind, code, name, parent, ladder, rank, order, active）
```
['unit','yiwu-hq','一悟燒肉品牌辦公室','yiwu','office','',3,'TRUE']
['title','os','品牌專員','office','',1,1,'TRUE']
['title','osv','品牌督導','office','',2,2,'TRUE']
['title','obd','品牌總監','office','',3,3,'TRUE']
```
（職稱列的 parent＝ladder 名，與既有 title 列 `['title','pt','計時同仁','store','',1,1,'TRUE']` 同格式）
改動列：`['brand','ck','中央工廠',…]`、`['unit','ck','中央工廠（央廚）','ck','store',…]`、`['unit','mzt-hq','墨竹亭品牌辦公室','mzt','office',…]`、`['unit','mala-hq','小辛辣品牌辦公室','mala','office',…]`、`mzt-wx／mzt-rg／mzt-mc` active＝`FALSE`；其他欄維持原值。

### 11.2 升級預覽
`orgUpgrade2026` 加參數 `dryrun:true`：不寫任何東西，回傳同一份報告（會改哪些列、todo 名單）。BOSS 按「切換組織」時先顯示預覽，再按一次「確定切換」才寫入。

## 12. Eason 2026-10-14 職稱定案（覆蓋第 2 節 office 職稱、第 4 節與第 11 節第 2、5 條）
- **營運部（品牌辦公室＋各門市）共用一套職稱，由低到高：計時同仁 pt(1)、正職同仁 ft(2)、店長 sm(3)、區經理 am(4)、區督導 sv(5)、品牌總監 bd(6)。**
- 職稱列 sv 改名「區督導」。**不新增 os／osv／obd**（11.1 的三個 title 列作廢）。
- 品牌辦公室 ladder 仍是 `office`（審核規則要分辨），但**職稱階梯＝store**：程式加 `stfTitleLadder_(unit)`（office→store、空白→store），前端 org-fields.js 兩份同步（`titleLadder(unit)`）、後端 Staff.gs:209 改用它。
- `STF_UNIT_VIEW_MIN_RANK.office＝5`（區督導以上算品牌辦公室主管）。
- 審核表修正：門市同仁 → 同店 rank≥3，或該品牌辦公室 rank≥5；同階梯所以「職級比審核者高→擋」直接適用（區督導不能核准品牌總監），第 11 節第 2 條的跨階梯限制取消。
- 升級對應（設計審第 5 條，照推薦 A）：品牌辦公室（mzt-hq／mala-hq）同仁職稱是 hq 階梯的，自動對應 hs 部門同仁→ft 正職同仁、hm 部門主管→sv 區督導；其他 hq 職稱（ceo／gm／chair）不動、列入 todo。預覽要逐人列出「從→到」。回退時一併還原這些人的 title（升級前備份 staff 受影響列的 emp_no＋title）。

## 13. Eason 2026-10-14 職稱最終定案（覆蓋第 12 節與前文所有職稱相關內容）
**門市（三品牌各店＋中央工廠 ck）職稱 ladder＝store，只剩三級：**
| code | name | rank | active |
|---|---|---|---|
| pt | 計時同仁 | 1 | TRUE |
| ft | 正職同仁 | 2 | TRUE |
| sm | 店長 | 3 | TRUE |
| am／sv／bd | 區經理／督導／品牌總監 | 4／5／6 | **FALSE**（停用不刪，舊資料照顯示） |

**品牌辦公室（mzt-hq／mala-hq／yiwu-hq，ladder＝office）自己一套四級，title 列 parent＝office：**
```
['title','ofs','行政同仁','office','',1,1,'TRUE']
['title','oam','區經理','office','',2,2,'TRUE']
['title','osv','區督導','office','',3,3,'TRUE']
['title','odir','總監','office','',4,4,'TRUE']
```
- 第 12 節的 stfTitleLadder_（office→store 對應）**取消**：office 職稱是資料列，既有「依 unit.ladder 篩職稱」邏輯原生適用；org-fields.js 不用改。
- `STF_UNIT_VIEW_MIN_RANK.office＝2`（區經理以上算品牌辦公室主管）。

**審核（Eason 2B：只有正上一層）最終表：**
| 被審的人 | 誰可以審 |
|---|---|
| 門市計時／正職同仁 | 同店店長 |
| 門市店長 | 該品牌辦公室區經理以上（oam／osv／odir） |
| 中央工廠計時／正職 | 中央工廠店長（ck 的 sm） |
| 中央工廠店長 | 執行長以上 |
| 品牌辦公室任何人 | 營運部主管 |
| 總部部門同仁 | 同主要部門的部門主管 |
| 總部部門主管 | 執行長以上 |
| 執行長以上 | 只有人資 |
| 任何人 | 人資、BOSS |
- 不同階梯不比職級（上表已經保證審核者在上一層）；同階梯職級比審核者高→擋。
- 送出的職稱是停用職稱（am／sv／bd）→ 驗證就擋，不會進待審。

**升級對應：**
- 品牌辦公室同仁原 hq 職稱：hs 部門同仁→ofs 行政同仁、hm 部門主管→osv 區督導；ceo／gm／chair 不動、列 todo。
- 門市同仁職稱是 am／sv／bd → **不自動搬**，列 todo（flag `title_ladder`），預覽逐人列出，由人資改派到品牌辦公室。
- flags 只剩 `unit_inactive`、`title_ladder`（職稱停用或不屬於單位階梯）；`store_sv_bd` 取消。

## 14. 追加：管理部（Eason 2026-10-15，mgmt-confirm.html 三題全照推薦）
- 新增部門列：`['dept','mgmt','管理部','dzy-hq','','',10,'TRUE']`。總部部門＝人資、工程、加盟招商、資訊、行銷、財務、採購、營運、訓練、管理（10 個 dept 列）＋中央工廠（單位 ck）。升級（orgUpgrade2026）的目標列也要補這一列（照 G5 完整八欄 upsert）。
- 執行長、總經理、董事長（ceo／gm／chair）應掛「鼎兆元總部 dzy-hq／管理部 mgmt」。管理部其他人用「部門同仁 hs」。
- **審核（1A、2A）：**
  | 被審的人 | 誰可以審 |
  |---|---|
  | 管理部的部門同仁（hs） | 執行長以上（不設部門主管） |
  | 執行長以上 | 只有人資（不變） |
  - 管理部**不產生**部門主管審核資格：dzy-hq＋主要部門 mgmt＋職稱 hm 的人，不得審管理部同仁（也不得審其他部門）。
  - 其他部門的部門主管→執行長以上（不變）。
- **掛錯地方的執行長以上（3A）**：職稱是 ceo／gm／chair，但單位不是 dzy-hq 或主要部門不是 mgmt → 名單 flags 加 `exec_misplaced`、升級預覽 todo 列出（flag `exec_misplaced`），**不自動搬**；畫面標「建議改到鼎兆元總部／管理部」。若同時符合 title_ladder（例：掛品牌辦公室），兩個 flag 都列。
- **管理部不設部門主管（追加）：** 單位 dzy-hq＋主要部門 mgmt＋職稱 hm（含送出待審的 p_*）→ flags 加 `title_ladder`（職稱需重選），升級預覽 todo 也列；org 裡沒有啟用的 mgmt 部門列時（切換組織之前）不產生 `exec_misplaced`，也不產生此 `title_ladder`，切換後才出現。

## 15. 職稱調整（Eason 2026-10-20；覆蓋第 13 節的門市／品牌辦公室職稱與審核表、第 4 節中央工廠列）
**職稱**
| code | name | ladder | rank | 適用單位 | 變化 |
|---|---|---|---|---|---|
| am | 區經理 | store | 4 | 門市（不含中央工廠） | **重新啟用**（從品牌辦公室移回門市） |
| oam | 區經理 | office | 2 | — | **停用**（不刪；目前沒人用，有人用就出「職稱需重選」） |
| fm | 廠長 | store | 3 | **只有中央工廠** | 新增，＝店長同等 |
| rdd | 研發總監 | store | 4 | **只有中央工廠** | 新增，廠長之上 |
- 中央工廠只能選 pt／ft／fm／rdd（不能選店長、區經理）；廠長、研發總監只能在中央工廠。
- 機制：`Staff.gs STF_UNIT_TITLES = { ck: ['pt','ft','fm','rdd'] }`、`STF_TITLE_UNITS = { fm: ['ck'], rdd: ['ck'] }`，判斷一律走 `stfTitleFitsUnit_`／`stfTitleUnitOk_`（驗證、名單旗標、審核、主管範圍、考勤、`permCompute_` 共用）；前端由 orgOptions 的 `unit_titles`／`title_units` 過濾（`org-fields.js titlesForUnit`，兩份同步；店長新增同仁的職稱下拉也用它）。
- **生效條件**：某單位清單裡的專屬職稱（fm／rdd）在 org 裡存在且啟用，限定才生效。後端先上線、還沒跑 orgUpgrade202610 前，中央工廠店長照舊有效。

**審核（只往上一層；同階梯職級要更高）**
| 被審的人 | 誰可以審 |
|---|---|
| 門市計時／正職 | 同店店長、同店區經理 |
| 門市店長 | 該品牌辦公室（osv／odir）**或同店區經理** |
| 門市區經理 | 該品牌辦公室（osv／odir） |
| 中央工廠計時／正職 | 中央工廠廠長、研發總監 |
| 中央工廠廠長 | 研發總監 **或** 執行長以上 |
| 中央工廠研發總監 | 執行長以上 |
（其他列同第 13、14 節。實作：`stfReviewNeed_` 回 `alt` 備選種類，`stfScopeMeets_` 任一符合即可。）

**表單簽核（請購請款）**：單位主管 head＝店長 sm／廠長 fm（`STF_STORE_HEAD_TITLES`），**區經理不進請購請款**；brand_dir＝品牌辦公室總監，中央工廠＝研發總監（`ApprovalRoute.gs APV_UNIT_DIR_TITLE`）。中央工廠預設門檻＝廠長 0–5,000 → 研發總監 5,001–10,000 → 總經理／董事長照門檻。人事單「直屬主管」照上面審核表。

**考勤（出勤核定，StoreOps.gs）**：區經理、廠長、研發總監＝店長同等（核同店計時正職與自己、要打卡、有考勤管理選單、營運系統管理單位）；研發總監另可核同單位職級較低的廠長。**判斷：區經理不核同店店長**（店長照舊自己核，要改再說）。

**權限預設**：am／fm／rdd 與店長同一套（audit.read.own、store.void；PERM_DEFAULT_RULES 第 21–26 條）。研發總監沒有另外加碼（spec 沒提，照店長）。

**正式環境切換**：admin 專用 `orgUpgrade202610`（`dryrun:true` 預覽）／`orgRollback202610`，同仁名單「職稱調整（10/20）」「退回職稱調整」兩顆鈕。
- 升級：am 啟用、oam 停用、補 fm／rdd 列；中央工廠的店長 title→fm、送出待審的 p_title（送出單位或目前單位是 ck）→fm；perm_map 把店長 sm 的**現行** active 規則複製給 am／fm／rdd（同一條已有就不補）；只寫那幾格，單位不變（不觸發調店、不寫打卡）。
- 備份：`org_bak2610_*`（org 整份）、`stf_bak2610_*`（emp_no／欄位／原值／新值）、快照 `org_upg2610_*`；狀態在 Script Property `ORG_UPGRADE_202610_STATE`（含補的規則編號）。
- 退回：org 切換後被改過、或受影響同仁那一格被改過 → 拒絕並列差異，什麼都不改；否則 org 蓋回、職稱還原、補的規則 active＝FALSE；切換後才設成 am／fm／rdd 的人列孤兒（只列不改）。
- 這次沒退回前 `orgRollback2026` 拒絕；`orgUpgrade2026` 重跑不會把 am／oam 改回去。
