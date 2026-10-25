# 規格：排班管理｜總部自填排班＋央廚固定排班（2026-10-25 v0.1，待 Eason 確認 §0）

> 需求正本：`requirements.md`（2026-10-24 確認）。前案：門市排班搬到管理系統（營運系統 `docs/autoschedule/hr-move-spec.md`，10/25 上線）。
> 基準：營運系統 main 51e7116、dzy main ba50fec、minikit main af84e18、打卡 mala-clock-in 20d87de。

## 0. 要 Eason 決定的事（AskUserQuestion 一次問完）
| # | 題目 | 推薦 |
|---|---|---|
| Q1 | 總部同仁的休假規則（一般正職，非四週變形） | 每週（日～六）至少 1 天例假＋1 天休息日，不合就**不能送出**；換班間隔 12 小時、單日超過 12 小時也擋；每週超過 40 小時只提醒 |
| Q2 | 誰核准總部同仁的班表 | 直接用**考勤管理「核定他工時」的那位主管**（部門同仁→同部門總監；管理部→執行長以上；品牌辦公室同仁→該辦公室總監），兩邊永遠一致 |
| Q3 | 總監、執行長以上自己的班誰核准（考勤目前沒有人核他們工時） | **人資主管**核准 |
| Q4 | 央廚從哪個月開始改固定排法 | **12 月**（11 月 T01 已用門市排班排好、鎖定，不動） |
| Q5 | 央廚週末怎麼標 | **週六＝休息日、週日＝例假**；國定假日、補假＝國定假日假 |

## 1. 架構決定（照需求「資料跟門市班表放一起」）
- 三種方式共用營運系統的排班資料庫（`sch_*`），以「店」區分：門市＝各門市帳號；**總部＝服務帳號 `HQ`**（打卡店別 `hq`）；**央廚＝門市帳號 `CF`**（打卡店別 `cf`）。
- 新增每店排班方式 `sch_store_cfg.mode`：`store`（預設，門市排班）｜`self`（總部自填）｜`fixed`（央廚固定）。HQ 設 `self`、CF 設 `fixed`（Q4：CF 從 12 月起）。
- **月份是畫面與核准的單位；送 LINE 仍用四週一期**。打卡系統 `SchedPub.gs` 只收 28 天一期（`period ^T\d{2,}$`、`days===28`）且 LINE 依日期換算期別讀（`schedPubDaysFor_`），所以**打卡系統一行都不改**：某月核准後，重送與該月重疊的每個 T 期（payload 只放已核准的日子，其餘格子留空＝LINE 顯示「未排班」）。
- 考勤比對：`dayPlan` 依日期讀 `sch_days`；`self` 模式只回**已核准**的格子（草稿、待核准不顯示）。

## 2. 資料（營運系統 DB 版本＋1）
```sql
ALTER TABLE sch_store_cfg ADD COLUMN mode TEXT NOT NULL DEFAULT 'store';      -- store|self|fixed
ALTER TABLE sch_store_cfg ADD COLUMN mode_from TEXT;                          -- fixed/self 從哪一天起生效（YYYY-MM-DD），之前照 store
ALTER TABLE sch_staff ADD COLUMN fixed_shift TEXT;                            -- fixed：這個人平日上的班別 id
-- self：每人每月一份申請
CREATE TABLE sch_self_month (
  store TEXT NOT NULL, emp_id TEXT NOT NULL, month TEXT NOT NULL,             -- month＝YYYY-MM
  status TEXT NOT NULL,                                                       -- draft|submitted|approved|rejected
  version INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT, decided_at TEXT, decided_by TEXT, reject_reason TEXT,
  PRIMARY KEY (store, emp_id, month));
-- self：核准後同仁又改的「待核准變更」（核准前 LINE／考勤照舊版）
CREATE TABLE sch_self_pending (
  store TEXT NOT NULL, emp_id TEXT NOT NULL, date TEXT NOT NULL,
  day_type TEXT NOT NULL, shift_id TEXT, leave TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (store, emp_id, date));
```
- `sch_days` 仍是唯一的「生效班表」：self 的草稿也寫在 `sch_days`（`source='self'`），但讀 LINE／dayPlan 時依 `sch_self_month.status` 過濾；核准後才改的放 `sch_self_pending`，核准時搬進 `sch_days`。
- 備份：新表加進 `server/backup.js` 的表清單（測試擋漏備份那條會自動檢查 `sch_` 開頭）。

## 3. 總部排班（mode=self）
### 3.1 身分（管理系統要補一個欄位）
- 營運系統要知道「登入的人在總部打卡是哪一號」才能讓他只改自己那列。管理系統 `StoreOps.gs storeIdent_` 新增 `self: [{clock, emp_id}]`＝本人 `staff_clock` 中 `state=confirmed`、`roster_active≠FALSE` 的對照（不論 role、不受試點限制，只列 clock `hq`）。契約 `test/fixtures/dzy-store-contract-v2.json` 兩邊同步加欄位（舊營運系統讀不到就當沒有）。
- 營運系統 `person.js`：
  - `storesFor`：`ident.self` 有 `hq` → 候選加 `HQ`。
  - `personAccess(HQ)`：服務帳號的上限從 `['duty']` 改成 `['duty','schedule']`；`schedule` 給「本人在 HQ 有 self 對照」或「能核 HQ 任何人工時（att.people 有 clock hq）」或人資主管、管理員。
  - 新欄位 `schedSelf`（本人在這店的 emp_id 清單）、`schedApprove`（能核准的 emp_id 清單＝att.people 中 clock＝該店者；Q3 的總監、執行長以上無人核 → 人資主管可核全部）。
### 3.2 期限與狀態
- 20 號 00:00 起可填「下個月」；當月也可以填（補填、改班）。
- 狀態：`draft`（可改）→ 送出 `submitted`（同仁不能改，可撤回回 draft）→ 主管 `approved` 或 `rejected`（附原因，回到同仁可改）。
- 已核准後同仁改某幾天 → 寫 `sch_self_pending`，該月出現「有 N 天變更等核准」；主管核准 → 搬進 `sch_days` 並重送 LINE；退回 → 刪掉 pending。
- 25 號 09:00 起，下個月還不是 submitted／approved 的人：管理系統首頁提醒本人「11 月班表還沒送出」、提醒主管「N 位同仁還沒送出」；主管首頁另有「N 位同仁的班表等你核准」。
### 3.3 檢查（Q1 推薦版）
- 以週日到週六為一週（跟門市同）：每週至少 1 天 `R`（例假）、1 天 `H`（休息日）→ 不合＝block（不能送出）。跨月的週合併前後月一起算（前月已核准的格子＋本月草稿）。
- 換班間隔 < 12 小時、單日 > 12 小時＝block；每週工時 > 40＝warn。國定假日自動預填國定假日假（可改成上班＝提醒雙倍薪資，同門市 C8 文字）。
- 實作：在 `rules.js` 加 `checkSelfMonth(ctx)`，重用既有工時計算（`hours.js`）、假日表、`MIN_GAP`；不改門市 `checkPeriod`。
### 3.4 送 LINE
- 核准（含變更核准）的那一刻：找出該月與哪些 T 期重疊，對每個 T 期 `enqueue('publish')`，payload 由 `payloadOfApproved(store, period)` 產生：只放 `approved` 月份的格子（其他日子 `{t:''}`）。HQ 的 `clockAlias`＝`hq`。
- 舊的 `sch_periods.locked` 對 self 不用（不鎖期）；`sch_publications` 照用（首頁「班表還沒送到 LINE」、健康檢查都自動涵蓋）。

## 4. 央廚排班（mode=fixed）
- 同仁設定「固定班別」（`sch_staff.fixed_shift`，廠長在同仁頁設）。
- **每月 20 號 06:00**（營運系統伺服器內的每日檢查，跟 `flush` 同一個計時器）自動產生下個月：平日＝`W`＋固定班別；週六＝`H`、週日＝`R`（Q5）；國定假日、補假（`holidays.json days`＋`gov.off`）＝`L`＋`國`。已存在的格子（廠長改過的、`source='manual'`）不覆蓋。沒設固定班別的人只排休假、平日留空並在畫面提醒。
- 廠長改例外：直接改格子＝立即生效（寫 `sch_days`，source manual），並自動重送該日所在的 T 期 LINE（延遲 1 分鐘合併多次修改再送）。不需要鎖定。
- 檢查：沿用門市規則中與固定排法相容的（換班間隔、單日上限、例假），只提醒不擋（廠長改例外要能存）。
- 起用日（Q4）：`mode_from=2026-12-01`。12/1 以前 CF 照門市排班。T02（11/29–12/26）跨越起用日：11/29–11/30 仍由門市模式管；若 T02 已用門市模式鎖定，固定排法產生 12 月時**只動 12/1 以後的格子**，並重送 T02。

## 5. 管理系統畫面（~/dzy，modules/schedule）
- 排班管理頁頂分頁改成**三個固定入口＋各自子分頁**：`門市排班`（現有 iframe，四個子分頁）／`總部排班`／`央廚排班`。三個都由營運系統畫面提供（`?embed=dzy&only=schedule&mode=store|self|fixed`），沿用 iframe＋入場券，不在管理系統另做原生畫面（資料在營運系統，畫面跟著走最少接縫）。
  - 平台 `dynamicTabs` 只有一排：頁頂顯示 `門市排班｜總部排班｜央廚排班`（`views` 改成三個固定 view：`store`／`self`／`fixed`，`dynamicTabs` 關掉），子分頁留在 iframe 裡。
  - 權限：選單 `platform.sched` 擴大＝店長同等職＋人資主管＋管理員＋**總部同仁**（`ladder hq` 或 `office` 的 active staff，Q 需求第 0 節第 1 題）＋廠長（已含在 sm/fm/am）。各分頁再由營運系統判斷能不能用（沒權限顯示「沒有權限」）。
- **營運系統畫面**（`web/modules/schedule/`）新增兩個入口：
  - `self.js`（總部排班）：上方月份切換＋狀態列（草稿／已送出／已核准／退回原因）；月曆每格點了選「班別／休息日／例假／特休／事假…／國定假日假」；按「送出」；主管看到「部屬」清單（每人一列狀態），點進去看月曆，按「核准」「退回」（必填原因）。
  - `fixed.js`（央廚排班）：月曆總表（人×日），只有廠長能改格子；同仁頁設固定班別；「重新產生下個月」按鈕（不覆蓋手改）。
- 首頁提醒（`modules/schedule/alerts.js`）多三種：`self_due`（本人下月未送出，25 號起）、`self_wait`（主管：N 位等核准）、`self_missing`（主管：N 位未送出，25 號起）；營運系統 `svc/sched-alerts` 回傳加 `self:{due:[month], wait:N, missing:N}`。

## 6. 跨系統契約變更
| 契約 | 變更 | 兩邊 |
|---|---|---|
| dzy→營運系統身分 `ident` | 加 `self:[{clock,emp_id}]` | dzy StoreOps.gs＋契約檔；營運系統 person.js、dzy.js 讀取（缺＝[]） |
| `svc/sched-alerts` 回傳 | 加 `self` 物件 | 營運系統＋dzy alerts.js（缺＝不顯示） |
| 嵌入網址 | `&mode=store|self|fixed` | 營運系統 config.js＋dzy modules/schedule |
| 打卡 SchedPub | **不變** | — |

## 7. 測試重點
- 規則：跨月週、國定假日預填、12 小時間隔跨月邊界。
- 狀態機：draft→submitted→approved／rejected、撤回、核准後變更、並發（version）。
- 權限：同仁只能改自己（emp_id 不在 `schedSelf` → 403）；主管只能核 `schedApprove`；人資主管核全部；門市店長看不到總部排班內容。
- 發布：核准後重疊 T 期都 enqueue、payload 只含已核准格、CF 自動產生不覆蓋手改、重送合併。
- 考勤：dayPlan 對 HQ 只回已核准格；HQ 個人登入的出勤核定會顯示「班表」那行（features 含 schedule）。
- e2e：總部同仁填→送出→主管核准→LINE 佇列有 publish；央廚 20 號產生→廠長改→重送。

## 8. 部署順序（草案）
1. 管理系統後端 .gs（ident.self）→ minikit 只套這次改動的 gas → mini 更新（舊營運系統讀不到 self 也不壞）。
2. 營運系統後端（mini）：DB 遷移、HQ mode=self、CF mode=fixed（mode_from 12/1）、svc 回傳加 self。
3. 營運系統網站：self／fixed 畫面。
4. 管理系統前端：排班管理三分頁、首頁新提醒、`platform.sched` 擴大到總部同仁。
5. 通知總部同仁與主管（文字給 Eason，由他決定發不發）。

## 9. 不做（同需求 §7）
看別人的班／換班互助、超時自動加班申請、央廚同仁看系統班表。
