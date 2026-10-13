# 規格：員工名單統一（人員資料當正本）

版本：v1 定案 / 2026-10-13（Eason「規格 OK」，§10 兩題照推薦）
上游：requirements.md v3（七題定案）
⚠ 本 repo 是 public：本檔不寫任何網址、金鑰、試算表 ID、真名。

## 0. 一句話架構
管理系統（Mac mini）記「誰是誰」與「他在哪幾家打卡」；要動打卡名冊時，先寫一張**待辦單**，
由 Mac mini 上的一支小程式（同步員）每分鐘撿單、呼叫各店打卡後端的新服務端點去做，做完回填結果。
打卡那邊只新增一支 `SvcStaff.gs`（服務端點）＋LINE 打卡「名冊上沒有你」那一段改成可自動建檔（7A）。
佈告欄改向管理系統要名單。

```
店長（管理系統網頁）
   │ 新增／離職
   ▼
平台後端 Staff.gs（mini，.gs）── 寫 staff、staff_clock、clock_outbox
   ▲                                   │ 每分鐘撿單（Node，能連外）
   │ 回填結果                           ▼
同步員 clock-sync.js（mini，Node）──HTTPS──► 各店打卡後端 SvcStaff.gs（svc_add／svc_set_active／svc_roster）
   │ 每天 00:10 拉六店名冊                          ▲
   ▼                                               │ 7A：第一次跨店
首頁待辦與異常                       光復 LineHub（LINE 打卡入口）── svc_add（auto_support）
佈告欄（mini）── 讀管理系統 svcDirectory ──► 同仁名單
```

## 1. 為什麼這樣切
| 事實（探到的） | 決定 |
|---|---|
| mini 上的 .gs 沒有 UrlFetchApp（gasshim UNSUPPORTED） | 連外交給 Node 的同步員，.gs 只寫待辦單 |
| gasshim 沒有觸發器；kit 只有備份計時器 | kit 加一個通用「app 自帶 jobs.js」掛勾（純新增，見 §6） |
| 各店打卡後端各有自己的鎖；跨專案開別店試算表拿不到那家的鎖 | 寫名冊一律打**那家店自己的後端**，取號與寫入在那家的鎖裡 |
| 打卡已有 SCHED_SVC_KEY 這種「給伺服器呼叫」的先例 | 照抄：每店指令碼屬性 `STAFF_SVC_KEY`，不拿管理金鑰給 mini |
| 薪資跨店時數本來就是會計手填 payroll_input | 7A 自動建檔**不影響薪資算法**，和今天主管手動加人效果一樣 |
| 打卡 repo 正本落後部署（缺新增鎖等 26 處） | 動打卡第一步：把部署版回寫成正本並 commit |

## 2. 資料（管理系統，新增；都在平台試算表＝mini SQLite）
### 2.1 staff 加兩欄（補在最右邊）
| 欄 | 意思 |
|---|---|
| hire_date | 到職日 YYYY-MM-DD（店長新增時必填；113 人舊資料留空） |
| last_day | 最後上班日；有值＝已登記離職，過了這天的 00:10 自動停用 |

### 2.2 新分頁 clock_stores（六列，總部可改）
`store_code, store_name, unit_code, enabled`
例：`mztjs, 墨竹亭 新竹金山, <金山單位代號>, TRUE`。單位沒有對應打卡（例：美村）＝新增時不建打卡。
各店後端網址與 STAFF_SVC_KEY 放 mini `.env`（`CLOCK_URL_<CODE>`、`CLOCK_KEY_<CODE>`），不進試算表。

### 2.3 新分頁 staff_clock（對照表，一人多列）
| 欄 | 值 |
|---|---|
| emp_no | DZY014 |
| store_code | mztjs |
| emp_id | MZTJS12 |
| role | home（主店）／support（支援店） |
| state | suggested（系統配的，未生效）／confirmed（生效）／rejected |
| source | name_match／created（管理系統建的）／auto_support（7A）／roster_seen |
| roster_active | 打卡名冊上是否在職（每日同步更新） |
| last_punch | 最近一次在那家打卡日（每日同步更新） |
| confirmed_by, confirmed_at, updated_at | |

規則：
- 唯一鍵＝`store_code+emp_id`（一個打卡編號只能對一個人）。
- 只有 `state=confirmed` 的列會被離職連動、佈告欄使用。
- 「可支援的店」＝ confirmed 的 support 列；**沒有人手動加**，來源只有：第一次建對照時已在多家名冊、7A 自動建檔。
- 每次改動寫 staff_log（誰、何時、哪列、前後值；不寫個資）。

### 2.4 新分頁 clock_outbox（待辦單）
`job_id, kind(add|deactivate|reactivate), emp_no, store_code, emp_id, name, op_id, state(pending|running|done|failed), tries, last_error, created_at, done_at`
- op_id 一張單一個，打卡端用它做冪等（同一張單重送不會建兩個人）。
- 失敗重試：1、5、30 分鐘、之後每 6 小時；第 3 次失敗起首頁顯示紅色待辦，可按「重試」。

## 3. 打卡端新增（每店同一份 SvcStaff.gs）
全部要 `svc_key`＝指令碼屬性 `STAFF_SVC_KEY`（未設＝全拒），固定時間比對；`v:1`。
| action | 輸入 | 做什麼 | 回傳 |
|---|---|---|---|
| svc_roster | — | 唯讀名冊＋每人最近打卡日 | `[{emp_id,name,active,created_at,removed_at,line_bound(布林),last_punch,src_store,src_emp_id}]`（不回 key、裝置、LINE id） |
| svc_add | name, op_id, created_by, src_store?, src_emp_id? | 在**本店鎖內**：op_id 已做過→回上次結果；同名在職→duplicate_name；取號（沿用 nextEmpId）；**依表頭定位**寫入（修掉舊 appendRow 位置寫入的風險）；記 src_* | `{ok, emp_id, key}` |
| svc_set_active | emp_id, active, op_id, by | 同 mgr_set_active 的寫法（active、removed_at、removed_by） | `{ok, emp_id, active}` |
| svc_link | emp_id | 只回該人打卡連結金鑰 | `{ok, key}` |

- 名冊右側補兩欄 `src_store, src_emp_id`（ensureRosterHeaders 只補不改）：7A 建的人記他從哪家來，管理系統不必猜姓名就能對上。
- 打卡連結金鑰**管理系統不存**：店長按「顯示打卡連結」→ 平台寫一張 kind=link 的待辦單 → 同步員打 svc_link → 金鑰放 CacheService 120 秒 → 前端 clockJobStatus 取到一次即刪。只給該單位店長與總部。（clock_outbox 的 kind 因此多一個 `link`，該列不寫金鑰。）
- 掛法：Code.gs 分派表後面併入 `SVC_STAFF_HANDLERS`（照 LIFF／LINE_HUB 的三行寫法）。回退＝刪那三行＋檔案。

## 4. 七個流程
### 4.1 店長新增新人（F2）
1. 店長（單位店長，store rank≥3）在「同仁名單」按新增：姓名、職稱、到職日、手機。單位＝自己的，不能選。
2. 平台後端：同單位在職同名→擋（訊息教他加註）；建 staff（status unclaimed、DZY 接號）；單位有對應打卡→寫一張 add 待辦單。
3. 畫面顯示「DZY128 已建立，打卡建檔中…」，每 3 秒問一次（最多 60 秒）；同步員做完→顯示打卡編號＋「顯示打卡連結」鈕＋LINE 綁定說明。
4. 60 秒還沒好→顯示「打卡還在建，稍後到同仁名單看」；失敗→首頁待辦「DZY128 打卡未建」。
5. svc_add 成功→ staff_clock 寫一列 home／created／confirmed。

### 4.2 離職（F3、第 2 題）
1. 店長（自己單位）或總部按「登記離職」，填最後上班日（可今天、可未來；不可早於今天 7 天以上）。
2. 存進 last_day；名單上顯示「10/31 離職」，可撤銷到當天結束前。
3. 每天 00:10 同步員：找出 last_day < 今天、仍在職的人 → staff 停用（沿用第一期 disable：寫 token_after、登出）＋每個 confirmed 對照各發一張 deactivate 單。
4. 打卡全部停掉後，該人狀態顯示「已離職（打卡已停 3/3）」。

### 4.3 第一次建對照（F1、第 5、6 題）
1. 總部按「建立打卡對照」→ 同步員拉六店 svc_roster。
2. 配對（只在 clock_stores 對應的單位裡比，去空白）：
   - 名冊在職者與 DZY 同名且唯一 → suggested
   - 同名多人、或一人對到兩個打卡編號在同一家 → 標「需總部處理」
   - 名冊在職者 DZY 找不到 → 第 6 題：建 DZY（unclaimed），對照標 suggested、source=name_match
   - 同一人出現在多家名冊 → 主店＝DZY 的單位那家，其他家 support
3. 店長在「我的資料 → 待審核」多一個分頁「打卡對照」，看自己單位的 suggested 一列列按「對」「不對」。按「不對」→ 轉總部。
4. 總部在「同仁名單 → 打卡對照」看全部、處理轉來的、可直接指定。
5. confirmed 才生效。

### 4.4 第一次跨店（7A，改光復 LineHub）
現況 not_bound 分支之前加一段，**全部條件成立才自動建**，否則走原本流程：
- 定位唯一命中 B 店；
- 這個 LINE 在 B 店沒綁、B 店名冊沒有同名在職者（有同名→原本「帶出名字請本人確認」流程不變）；
- 這個 LINE 在別家**恰好一家以上綁定且在職，且都是同一個姓名**；
- B 店名冊沒有 src 指向他的停用列（有→不自動恢復，回「請主管協助」，避免離職又被自動加回）。
動作：呼叫 B 店 svc_add（created_by=`LINE 自動（首次支援）`、src_store/src_emp_id＝他已綁那家）→ 綁 LINE → 照常打這張卡 → 回覆「已幫你加入 B 店名冊，第一次支援請跟 B 店值班主管說一聲」。
B 店值班核定頁：created_by 是「LINE 自動」的人，名字旁標「首次支援」到他第一張卡被核定為止。
管理系統：每日拉名冊看到 src_* 有值的新列→直接寫 support／auto_support／confirmed（不靠姓名）。
專屬打卡連結（?k=）不受影響、做不到 7A。

### 4.5 每日同步（00:10，F7＋支援店重算）
拉六店 svc_roster → 更新 staff_clock 的 roster_active、last_punch → 新出現的名冊列：有 src→自動對照；沒有→列為「打卡上有、沒對照」異常。
首頁「待辦與異常」（staff 模組 alerts）：
- 打卡未建／停用失敗的待辦單
- 打卡上在職但沒對照的人（含店長從值班核定舊按鈕新增的）
- DZY 已離職但某家打卡仍在職
- 待店長確認的對照數
連續 7 天零異常＝成功指標。

### 4.6 佈告欄改讀管理系統（F6）
- 平台新增唯讀 action `svcDirectory`（驗 `BULLETIN_SVC_KEY`，props 新增）：回 `[{emp_no,name,unit,active,clocks:[{store_code,emp_id,role}]}]`，只含 confirmed 對照、不含手機生日地址。
- 佈告欄 mini 伺服器同一台，直接打 `127.0.0.1:8799/platform/api`。
- 佈告欄 staff 表加欄 `dzy`；搬家一次：用既有 `src`（店:emp_id）經對照填 dzy。之後同步以 dzy 為鍵：新人新增、離職停用、改名同步；LINE 雜湊仍照舊從打卡名冊算（用對照找到同一人）。
- 移除「打卡同步」按鈕與 CLOCK_PRIMARY_ 判定表（主店＝role home）。S-xxx 保留不改（舊公告簽名紀錄靠它）。

### 4.7 值班核定的「新增同仁」退場（F5）
- 第一階段：按鈕改成說明「請到管理系統 → 同仁名單新增，當天就能打卡」＋網址。後端 mgr_add_employee 先保留（以防萬一），用了也會被每日同步抓成異常。
- 兩週後（跑順＝期間零「打卡上有、沒對照」異常）：後端 mgr_add_employee 回「已停用」。

## 5. 權限
| 動作 | 店長（自己單位） | 總部 platform.staff | 其他 |
|---|---|---|---|
| 新增新人 | ✓ | ✓（任一單位） | ✗ |
| 登記／撤銷離職 | ✓ | ✓ | ✗ |
| 確認對照 | ✓（suggested） | ✓（全部、可指定、可改） | ✗ |
| 顯示打卡連結 | ✓ | ✓ | ✗ |
| 建立對照、重試待辦單 | ✗ | ✓ | ✗ |
權限碼沿用第一期：店長＝後端依職級衍生的 `platform.review`；總部＝`platform.staff`。不新增 roles 分頁的權限碼。

## 6. Mac mini 這邊要動的
- `apps/dzy-platform/jobs.js`（新，Node）：同步員。每 60 秒撿 pending 單；每天 00:10 跑 4.2 第 3 步＋4.5。透過 kit 給的 `runGas(fn, args)` 呼叫平台 .gs 的內部函式（`clockOutboxClaim_`、`clockOutboxDone_`、`clockDailyApply_`），自己用 fetch 打打卡後端。
- kit：`app.json` 新增選填欄位 `jobs`（檔名）；有就在啟動時 `require` 並給它 `{ runGas, env, log }`。純新增，別的 app 不受影響。（要跟 minikit 那邊的人確認，plan 第一步）
- .env：`CLOCK_URL_*`、`CLOCK_KEY_*`（六店）、`GAS_PROP_BULLETIN_SVC_KEY`；app.json props 加 `BULLETIN_SVC_KEY`。
- 新分頁會進每日外部備份（同既有 staff）；clock_outbox 不含個資以外的東西，staff_clock 只有編號與姓名不在內——都可備份。
- mini 停機：新增按不了（第 3 題接受）；停機前已寫的待辦單開機後自動接著做；00:10 沒跑到→開機後第一次撿單時補跑當天的每日同步。

## 7. 不改的東西（逐條在驗收時確認）
- 打卡：打卡、裝置、核定、薪資、出勤班表的程式一行不改；改動只有：新增 SvcStaff.gs、分派表三行、ensureRosterHeaders 多兩欄、LineHub not_bound 前一段（4.4）、值班核定頁的新增按鈕與「首次支援」標記。
- 薪資：不動。跨店時數照舊會計手填。
- 第一期：認領、登入、忘記密碼、審核流程不動。

## 8. 測試與驗收（給 ④ 用）
1. 打卡 SvcStaff：node mock 測 svc_add 冪等、同名擋、鎖內取號（兩個併發拿到不同號）、依表頭寫、未設金鑰全拒。
2. 平台：mock 測店長只能建自己單位、同名擋、待辦單狀態機、離職 00:10 連動、對照唯一鍵。
3. 同步員：假打卡後端（本機 http）跑完整 新增→離職→7A→每日同步。
4. 7A：LineHub mock 四個不成立條件各一支，確認走回原流程。
5. 佈告欄：用 spike/sample 的真實名冊（不進 repo）做搬家演練，S-xxx 每一筆都要對到同一個 dzy、零錯配。
6. 上線前關：Fable＋GPT 互盲，只審「寫外部系統」（SvcStaff、同步員、7A）。

## 9. 還不確定（寫進 plan 處理）
- 44 位打卡在職同仁與 113 人能對上幾位：未確認（管理系統名單在 mini，本機讀不到）；在 mini 上跑 4.3 時就會知道。
- kit 加 jobs 掛勾要 minikit 維護者同意；不同意的替代＝獨立 launchd 程式（同樣 Node，打 127.0.0.1）。
- 六張犁名冊目前是空的：照樣接，等它有人。

## 10. Eason 確認的兩題（2026-10-13 照推薦）
1. 離職日最多往回補幾天：7 天（推薦，§4.2）／不限。
2. 7A 遇到「在那家離職過」的人：不自動加回，請主管處理（推薦，§4.4）／自動恢復。
