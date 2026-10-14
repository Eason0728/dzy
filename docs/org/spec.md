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
