# 技術方案：績效評核模組（plan.md）

- 版本：v1 / 2026-10-24（依 spec v2）
- 里程碑日期以 2027-01-01 開放填寫為終點倒推。
- 審查：本系列不做 Codex（GPT）審查（Eason 2026-10-24）；每階段驗收＝測試全綠＋真瀏覽器點一輪。

## 時程總覽
| 階段 | 做什麼 | 完成日 | 誰 |
|---|---|---|---|
| P0 題目草稿 | 墨竹亭、一悟、央廚三套題目＋KPI 範本草稿（S1 A） | 2026-11-07 給 Eason | Claude 起草 → 各總監改 → 12-15 定稿 |
| P1 計分核心 | `EvalCalc.gs` 移植舊 scoring／newbie，舊測試全數移植並全過 | 11-07 | Claude |
| P2 資料與權限 | `Eval.gs` 分頁、setup、季度與填寫窗、4 個權限碼、範圍裁切、匿名 | 11-14 | Claude |
| P3 同仁端 | 填寫評鑑、自評、我的成績 | 11-21 | Claude |
| P4 主管端 | 新人考核、單位結果、KPI／加減分／回饋、填寫進度、PDF | 11-28 | Claude |
| P5 設定與搬家 | 題庫／範本／時薪／等第編輯、定稿、匯入舊成績、舊站唯讀版 | 12-05 | Claude |
| P6 整合驗收 | 光復舊資料重算差 0、e2e、本機版給 Eason 點 | 12-10 | Claude → Eason |
| P7 上線 | mini 同步後端 → 推前端 → 人資輸入四品牌題目 → 12-20 用試跑模式點一輪 | 12-20 | mini 的 Claude＋Eason |
| 並行 | 帳號認領追蹤：11-15 起每週各店未認領人數 | 12-31 | Claude 列、店長催 |

## 共用契約（平行任務都要照這裡，逐字）
- 季度字串：`2026-Q4`（四位年＋`-Q`＋1 位數）。
- 品牌代碼：`mzt`、`mala`、`yiwu`、`ck`。
- 題組代碼：`pt_att`、`pt_perf`、`ft_att`。
- 計時／正職判定：`title === 'pt'` → `'pt'`，其餘 → `'ft'`。
- 星等陣列：依題目 `ord` 排序的整數陣列，1～5；未評＝`null`。
- KPI 評分：`{"<key>":{"sel":"A"|"B"|"C"|"D"|"完成"|"未完成","actual":"<文字>"}}`；範本項目 `type` 為 `技能`／`執行力`（沿用舊站值，搬資料不用轉換）。
- action 名稱一律 `ev` 開頭駝峰：`evSetup`、`evMe`、`evPeerSubmit`、`evSelfSubmit`、`evMyScores`、`evNewbieList`、`evNewbieSubmit`、`evUnitResults`、`evPersonDetail`、`evSupSave`、`evProgress`、`evFinalize`、`evUnfinalize`、`evBankGet`、`evBankSave`、`evTplSave`、`evWageSave`、`evGradeSave`、`evImportPreview`、`evImportCommit`。
  讀取 action（進 readActions／dryrun）：`evMe`、`evMyScores`、`evNewbieList`、`evUnitResults`、`evPersonDetail`、`evProgress`、`evBankGet`、`evImportPreview`。
- 錯誤形狀沿用平台 `{ok:false, code, msg}`；本模組新 code：`not_inited`、`window_closed`、`duplicate`、`not_in_unit`、`no_scope`、`finalized`。

## 各階段做法重點
- **P1**：舊 `tests/scoring.test.js`、`newbie.test.js` 全部改寫成平台 mock 測試（`test/eval-calc.test.mjs`）呼叫 .gs；另做 `modules/eval-shared/calc.js` 只放前端即時小計要的函式，測試逐字比對。
- **P2**：權限碼依 Perms.gs 現有做法加碼、加名稱、加預設規則；範圍函式 `evScope_(session)` 回 `{own:[emp_no…], units:[…]|'all', admin:bool}`。每個讀取 action 第一行就裁切。互評原始分數永不出現在任何回應（測試用 grep 回應 JSON 驗）。
- **P3／P4**：畫面從舊 `eval-page.js`／`admin-page.js` 改寫成模組 views，殼的樣式；草稿 key＝`dzy.u.<user id>.ev_draft_<peer|self>_<quarter>`（比照稽核草稿只認本人）。
- **P5**：匯入只在瀏覽器比對姓名，送到後端的是 emp_no＋分數；不在 repo 留任何真名。舊站唯讀版改 mala-eval repo（只改前端，舊 Apps Script 不動）。
- **P7 部署順序**：mini 後端先（新 action 對舊前端無影響）→ 外網確認 `evMe` 回 `not_inited` → admin 按初始化 → 推前端（main，請 Eason 在 MacBook 按）→ 舊站唯讀版 1 月 1 日 00:00 前推上。

## 風險
| 風險 | 後果 | 對策 |
|---|---|---|
| 同仁沒認領帳號（10-18 時 128 位只 1 位開通，現況未確認） | 1 月登不進來、互評名單缺人 | 11-15 起每週追；店長催；未認領者本季不補填（避免新舊兩份分數） |
| 三品牌題目 12-15 前沒定稿 | 該品牌 1 月沒題目可填 | 系統允許題庫空的品牌顯示「本季未開放」，其他品牌照常 |
| 第一次十家店同時上 | 問題一次爆 | 12-20 試跑模式各品牌找一位店長點一輪 |
