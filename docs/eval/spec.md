# 規格：績效評核模組（spec.md）

- 版本：v2 / 2026-10-24（Eason 答：S1 A、S2 B、S3 A）
- 依據：requirements.md v2（十題答案見 0.1）
- 同仁真名一律不進本檔（repo 公開）。

## 0. 要 Eason 回答的三題

| # | 題目 | 選項 | 推薦 |
|---|---|---|---|
| S1 | 墨竹亭、一悟、中央工廠的題目誰出 | A 我以小辛辣現有題目為底，各起草一套給該品牌總監／廚藝總監改／B 各品牌自己從零寫 | **A** |
| S2 | 上線時程 | A 2027 年 1 月（評 2026 第四季）光復先用新系統，其他店 4 月（評 2027 第一季）加入／B 2027 年 1 月全部一起 | **A** |
| S3 | 店長、廠長自己的 KPI 誰打 | A 往上一層（店長＝區經理或品牌辦公室區督導、總監；廠長＝廚藝總監），跟同仁認領審核同一套「誰管誰」／B 一律人資打 | **A** |

**Eason 答案（2026-10-24）**：S1 A（我起草三套題目給總監改）、**S2 B（2027-01-01～05 評 2026 第四季，三品牌＋央廚全部一起上線）**、S3 A（往上一層打 KPI）。

## 1. 架構

| 層 | 做法 | 前例 |
|---|---|---|
| 前端 | 新模組 `modules/eval/`（manifest `ns:'platform'`、`backend:'platform'`、`dept:'hr'`、`requires:['platform.login']`）。畫面直接寫在管理系統裡，**不用 iframe 嵌舊站** | 表單簽核 `modules/approvals` |
| 平台層 | 只加 `platform/registry.js` 一行 | spec §6.1 規矩 |
| 後端 | 平台後端新檔 `apps-script/platform/Eval.gs`（action）＋`EvalCalc.gs`（純函式計分）；正本在 Mac mini（minikit `apps/dzy-platform`），照 sync-gas 流程同步。**不 create-deployment、不動舊 Apps Script 計分邏輯** | 表單簽核 Approvals.gs |
| 資料 | mini 平台資料庫新分頁 `ev_*`（第 3 節） | apv_* |
| 舊站 | mala-eval 前端改「只能查詢」一季後換成「已搬家」頁；舊 Apps Script 與試算表不刪，只當歷史來源 | mala-audit 退場 |

新 .gs 要同時登記：Code.gs `CODE_ALLOWED_ACTIONS`＋`dispatchAction_`（寫入另列 `MUTATING_ACTIONS`）、minikit `app.json` 的 `gas`／`gasSource`／`readActions`、`platform/dryrun.js READ_ACTIONS.platform`。

### 1.1 計分只有一份
舊系統是瀏覽器算分。搬進來改成**後端算**：同仁看「我的成績」時，後端只回彙總後的每題平均，不回任何一位評分者的原始分數（防止從瀏覽器看出誰給幾分）。
- `EvalCalc.gs` 由舊 `js/scoring.js`、`js/newbie.js` 逐函式移植：`finalScore`、`capScore`、`ftAttitudeScale`、`kpiItemScore`／`kpiTotal`、`gradeFor`、`wageTierIndex`、`averageItems`、`dueDateOf`、`newbieStatus`。
- 前端顯示需要的少數純函式（例如即時小計）放 `modules/eval-shared/calc.js`，測試逐字比對與 `EvalCalc.gs` 一致（比照 `amount.js`／`apvCalcAmount_`）。
- 驗收：拿光復 2026 Q1～Q3 舊資料跑新後端，每人每季總分與舊網站一致（差 0）。

## 2. 身分與權限（Q4 A、Q5 A）

### 2.1 誰是誰
| 舊概念 | 新來源 |
|---|---|
| 帳號 | 管理系統 DZY 編號（staff `emp_no`），status＝active 才能填、才會出現在名單 |
| 角色 計時／正職 | 職稱 `pt`＝計時；其餘門市／央廚職稱（`ft` `sm` `am` `fm` `rdd`）＝正職 |
| 店別 | staff `unit`；品牌＝該單位在 org 的 `parent`（`mzt`／`mala`／`yiwu`／`ck`）。不信 staff.brand |
| 到職日 | staff `hire_date` |
| 店長 | 不再看職稱文字，改看第 2.2 節權限 |

評核對象＝品牌 `mzt`／`mala`／`yiwu`／`ck` 底下各門市與中央工廠的 active 同仁（Q2 B）。品牌辦公室、總部（`dzy`）的人不出現在互評名單，但可依權限看結果。

### 2.2 新權限碼（加進 Perms.gs `PERM_GRANTABLE`＋`PERM_NAMES`；預設規則加進 `PERM_DEFAULT_RULES`，Eason 可在「權限設定」改）
| 碼 | 能做什麼 | 預設給誰 |
|---|---|---|
| （無，人人可用） | 填互評、自評、留言、看自己成績 | 所有 active 門市／央廚同仁（`platform.login`） |
| `eval.manage.own` | 對「自己可審核的人」做新人考核、KPI 評分、± 調整、表現回饋；看這些人的結果 | 門市 `sm`、`am`；央廚 `fm`、`rdd`；品牌辦公室 `osv`、`odir` |
| `eval.read.brand` | 看同品牌各單位結果、填寫進度、印 PDF | 品牌辦公室 `osv`、`odir`；央廚 `rdd` |
| `eval.read` | 看全集團結果、填寫進度、印 PDF | 總部人資部全部；`ceo`、`gm`、`chair` |
| `eval.admin` | 定稿／解除定稿、改題庫、KPI 範本、時薪級距、等第獎金表、匯入舊成績 | 總部人資部 `hm`（總監） |

- 「可審核的人」直接用平台現成的 `stfCanReview_`（同仁認領審核那套往上一層）：店長評本店計時、正職；區經理評本店店長；品牌辦公室評店長；廠長評央廚同仁；廚藝總監評廠長（S3 A）。
- 不列進 `PERM_LOCKED`（Q5 A：全依職稱；分數連著獎金，所以 `eval.admin` 預設只給人資總監）。
- 範圍計算比照 `audit.read.*`：`eval.read`＝all；`eval.read.brand`＝同品牌單位陣列；`eval.manage.own`＝`stfCanReview_` 為真的人。後端每個讀取 action 都先裁切再回傳。

### 2.3 匿名
- 互評分數：任何人（含 `eval.read`）只看得到彙總平均與份數，看不到誰給誰幾分。後端寫入時記評分者，只用來防重複。
- 夥伴留言勾「匿名」：回給收件人時不帶發話者；不勾則帶姓名。
- 給公司的話：管理頁只顯示內容，永不帶發話者。
- 例外：`eval.admin` 也看不到；要查只能 Eason 在 mini 直接查資料庫（記在 skill）。

## 3. 資料（mini 平台資料庫，全部 `ev_` 開頭；`evSetup` 只補不覆蓋，沒建前所有 action 回 `not_inited`）

| 分頁 | 一列是什麼 | 主要欄位 |
|---|---|---|
| `ev_bank` | 一題 | brand, set（`pt_att` 計時態度／`pt_perf` 計時表現／`ft_att` 正職態度）, key, ord, label, levels（5 級說明 JSON）, max, active, updated_at, updated_by |
| `ev_kpi_tpl` | 一個 KPI 項目 | brand, title, ord, key, kind（skill／exec）, label, target, a, b, c, d, weight |
| `ev_kpi_assign` | 個別同仁改用別張範本 | emp_no, brand, title |
| `ev_wage` | 時薪級距一列 | brand, ord, range_text, min, max, wage |
| `ev_grade` | 等第一列 | brand, grade, min_score, bonus_base |
| `ev_peer` | 一位評分者對一位受評者一季的評分 | quarter, unit, rater, ratee, att（星等陣列）, perf, labels（送出當下題目快照）, at |
| `ev_self` | 自評 | quarter, unit, emp_no, att, perf, labels, at |
| `ev_msg` | 留言 | quarter, from, kind（self／peer／company）, to, text, anon, at |
| `ev_sup` | 主管對某人一季 | quarter, ratee, kpi（`{key:{sel,actual}}`）, adj_att, adj_perf, adj_reason, feedback, by, at |
| `ev_newbie` | 新人考核一筆 | emp_no, unit, hire_date, rater, att, perf, labels, at |
| `ev_final` | 定稿後每人一季 | quarter, unit, emp_no, items（每項最終分 JSON）, att, perf, adj, total, grade, by, at |
| `ev_hist` | 光復匯入的舊成績 | quarter, emp_no, items, total, src（`mala-eval`） |

- **題目快照 `labels`**：每筆送出都存當下題目文字，之後改題庫不會讓舊分數對錯題（舊系統只有新人考核有這個保護）。
- 季度、填寫窗：沿用舊規則（1／4／7／10 月 1～5 號填上一季；10 號後公布），**改由後端判斷**（舊系統只有前端擋）。
- 新人考核保險絲：`hire_date` 早於上線日的人不觸發（同舊系統 `NEWBIE_SINCE`）。
- 互評名單：填寫當下與本人同 `unit` 的 active 門市／央廚同仁，扣掉自己。

## 4. 畫面（左側「人資部門 → 績效評核」，頁頂分頁依權限出現）

| 分頁 | 誰看得到 | 內容（沿用舊站） |
|---|---|---|
| 填寫評鑑 | 所有人 | 同店名單卡片、星等＋五級說明（預設展開）、草稿自動存、送出確認、非開放期唯讀預覽 |
| 自評 | 所有人 | 同題目自評＋三種留言 |
| 我的成績 | 所有人 | 留言卡、各季小計、查詢季度、細項、正職等第表／計時時薪落點、新人考核卡 |
| 新人考核 | `eval.manage.own` | 待考核清單（滿月、逾期紅字）、填寫 |
| 單位結果 | `eval.manage.own`／`eval.read.brand`／`eval.read` | 選單位＋季度：總覽、填寫進度（誰還沒填）、點人看明細、KPI 評分、± 調整、回饋、列印 PDF |
| 設定 | `eval.admin` | 定稿本季、題庫（四品牌）、KPI 範本、時薪級距、等第獎金表、匯入舊成績 |

外觀用管理系統樣式；PDF 抬頭依品牌名＋店名＋季度，檔名「<店名>＿績效評核＿<年>年第<季>季」。日夜天空背景不搬。

## 5. 搬家
1. **題庫**：小辛辣＝舊站現行題庫原樣搬（四組＋店長、儲備幹部 KPI 範本；儲備幹部改掛 `mala/ft`）。墨竹亭、一悟、央廚依 S1。四品牌的時薪級距、等第獎金表先複製小辛辣的值，由人資改。
2. **舊成績（Q9 A）**：設定 → 匯入舊成績。人資從舊試算表匯出後貼上；系統依姓名比對光復同仁名單給出對照預覽（對不到、同名的標紅要人工選），確認後才寫 `ev_hist`。已定稿季用定稿值；匿名留言照原本匿名設定搬。真名只在瀏覽器與 mini，不進 repo。
3. **舊網址（Q8 A）**：新版上線當天，舊站前端改成登入後只剩「我的成績」、不能填；一季後換成「已搬家」頁。

## 6. 驗收
- 計分：光復舊資料重算差 0；`EvalCalc.gs` 與舊 `scoring.js` 同一組測試資料全過。
- 權限：四種身分（一般同仁、店長、品牌總監、人資）各登一次，只看得到該看的單位；互評原始分數在任何回應裡都找不到。
- 防重複、填寫窗：後端擋（直接打 action 也擋）。
- 分層：`git diff --stat platform/` 只有 registry.js 一行。
- e2e：比照舊站 `e2e/run.py` 的隨機資料＋按鈕全點法，加「兩家店互相看不到」。

## 7. 上線前提
- **全部門市與央廚同仁**須在 2026-12-31 前完成 DZY 帳號認領並審核通過（S2 B）；2026-11-15 起每週列各店未認領人數給 Eason（名單不進 repo）。
- 四品牌題目、KPI 範本、時薪級距、等第表須在 2026-12-15 前由各總監定稿並由人資輸入。
