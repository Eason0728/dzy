# 任務清單：鼎兆元組織架構改版（task）

每個任務 100–200 行；完成條件都要附「跑過的指令＋輸出」。測試指令：
`cd ~/dzy-wt-org && for f in test/*.test.js test/*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`

## T1 組織預設值與 office 門檻（後端）
- 改 `Staff.gs` STF_DEFAULT_ORG（spec 第 2 節：ck 改名、mzt-hq／mala-hq 改名＋ladder office、新增 yiwu-hq、三店 active FALSE、新增 os／osv／obd 職稱；訓練部保留）、`STF_UNIT_VIEW_MIN_RANK` 加 `office: 2`。
- 改 `StaffClock.gs` CLK_DEFAULT_STORES hq 列加 `['yiwu','一悟燒肉品牌辦公室']`，ck 列名稱跟著改。
- 更新寫死舊值的測試（staff.mock、staff-clock.mock）。
- 驗收：□ 全部 node 測試綠　□ 新增斷言：office 單位職稱下拉只列 os/osv/obd、選 store 職稱回錯　□ office 單位 osv 有單位通訊錄、os 沒有

## T2 兼任部門（後端）
- staff 尾端補 `extra_depts` 欄（照 clkEnsureStaffExtra_ 模式，排在 last_day 之後）。
- list／me 回傳 extra_depts、extra_dept_names、flags（契約見 plan.md）。
- staffEdit 收 extra_depts：只 platform.staff；每個是 dzy-hq 底下 active 部門、不等於主要部門、不重複；存成排序後逗號字串。
- 驗收：□ 人資可設可清空　□ 非人資帶此欄被擋　□ 停用部門／主要部門／重複／不存在代碼各被擋　□ 欄位不存在時自動補、表頭不符時停

## T3 審核規則（後端，高風險）
- 新增 `stfReviewScope_`、`stfCanReview_`；`stfReviewer_`、`handleUnitPending_`、unitApprove／unitReject、`stfLoginGate_` 改用新規則。stfManagerScope_ 不動（通訊錄、打卡用）。
- 規則照 spec 第 4 節表格；職級高於審核者（同階梯）擋；自己擋；人資／admin 全可審。
- 驗收：□ spec 第 4 節每一列各一正一反　□ 營運部主管不能審門市、執行長不能審門市同仁　□ 部門主管不能審別部門　□ 區經理送出、店長審 → 擋　□ 執行長以上送出 → 只有人資　□ 品牌督導只能審自己品牌各店，不能審 ck　□ platform.review 衍生權限與新資格一致

## T4 升級／回退（後端，高風險）
- Code.gs 加 `orgUpgrade2026`、`orgRollback2026`（只 role admin，進寫入鎖）。
- 升級步驟照 spec 第 6 節；可重跑；備份已存在不覆蓋。回退＝備份整份蓋回 org。
- 驗收：□ 跑兩次第二次 org 無變更　□ 回退後 org 與升級前逐格相同　□ clock hq 列自訂值不動　□ 人資呼叫被擋　□ todo 清單三種 flag 各有測資

## T5 同仁名單前端
- `modules/staff/views/list.js`：改資料對話框多「兼任部門」勾選（只列 dzy-hq active 部門、排除主要部門）；名字旁 flags 標籤（單位已停用／職稱需重選／建議移到品牌辦公室）；「需處理」篩選；admin 看得到「切換組織」「退回組織」兩顆按鈕，按下用頁內確認框，完成後顯示報告。
- 驗收：□ 前端測試綠　□ 真瀏覽器（devserver＋mock）點過改資料、篩選、兩顆按鈕　□ 非 admin 看不到按鈕

## T6 我的資料前端
- `modules/me/views/profile.js` 顯示「兼任：資訊部、訓練部」（唯讀，沒有就不顯示）。
- 驗收：□ 有、無兼任兩種畫面截圖

## T7 整套與切換
- 全部 node 測試＋`./test/e2e/run_all.sh` exit 0＋佈告欄 `node test/staffdzy.test.js`。
- `cd ~/dzy-minikit && bash kit/bin/sync-gas.sh dzy-platform` → commit push → 交辦 mini 的 Claude pull＋重啟 → 外網確認新 action 存在（無 token 打 orgUpgrade2026 回未登入）→ 推前端 → Eason BOSS 按升級 → 驗。
