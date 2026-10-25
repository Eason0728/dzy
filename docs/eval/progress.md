# 進度：績效評核（管理系統模組，三品牌共用）
- 開案日：2026-10-24
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：④
- 等 Eason：無（2026-10-25 Eason 經總控確認「照時程開工」；推 main／交辦 mini 前要再經總控確認）

- 審查規則：2026-10-24 Eason 指示本系列搬家工作不做 Codex（GPT）審查；驗收照做（測試＋真瀏覽器點一輪）。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-24 | 需求確認 | requirements.md | Eason 答十題 | 1 | requirements 0.1 |
| 2026-10-24 | 規格確認 | spec.md | Eason 答 S1 A、S2 B、S3 A | 1 | spec v2 |
| 2026-10-25 | 方案確認 | plan.md／task.md | Eason：照時程開工（經總控） | 1 | 總控轉述原話「4A」 |
| 2026-10-26 | 任務關 P1 | EvalCalc.gs | 通過 | 1 | `node test/eval-calc.test.mjs` 81 passed |
| 2026-10-26 | 任務關 P2 | Eval.gs＋權限 | 通過 | 1 | `node test/eval-actions.mock.test.mjs` 87 passed；perms 兩支全過 |
| 2026-10-26 | 任務關 P3-P5 | modules/eval | 通過 | 1 | 本機假資料真瀏覽器點過：互評、草稿還原、自評、我的成績（手算態度 24／表現 55.5 吻合）、新人考核、KPI 即時合計 61、加減分回饋、設定存題、定稿、載入小辛辣題目、375px |

## ② 探：舊系統盤點證據（mala-eval repo，路徑相對於專案根目錄）
- 店名寫死：index.html:6、:17-21；admin-page.js:683-686（PDF 檔名）；daylight.js:5-6（新竹座標）
- 職稱寫死：Code.gs:251-253（店長判定）、:404-421（店長／儲備幹部 KPI 範本種子）
- 門市專屬題目：data/banks-2026Q1.json:61-178（計時表現 14 題）
- 一店一套：eval-page.js:255、:362、:1100、admin-page.js:126、:141（名單＝全部帳號）；Code.gs:179（單一通行碼）
- 計分正本：js/scoring.js（finalScore、capScore、ftAttitudeScale、kpiItemScore／kpiTotal、gradeFor、wageTierIndex）；js/newbie.js
- 後端 action：doGet config／adminData；doPost 14 種（Code.gs:657-687）。無 Mac mini 程式。

## 實作紀錄（2026-10-26）
- 分支 `eval-req`（~/dzy-wt-eval）。後端 `EvalCalc.gs`、`Eval.gs`；前端 `modules/eval/`（6 分頁）、`modules/eval-shared/calc.js`、`seed-mala.js`（舊站線上題庫 ver 19，無同仁資料）。
- 權限碼改名 `platform.eval-manage／eval-brand／eval-all／eval-admin`：平台 manifest 規定權限碼前綴＝模組 ns（platform）。
- `platform/` 動了兩個檔：registry.js 一行、dryrun.js 讀取白名單（新平台 action 必補，同表單簽核前例）。
- 主管範圍用目前身分判斷「往上一層」（stfReviewScope_＋stfScopeMeets_(stfReviewNeed_)），不用 stfCanReview_（它看認領送出欄，通過後清空）。
- 本機測試環境：scratchpad evstack（run-backend.sh 8848、run-web.sh 8849）；e2e 用 `test/e2e/eval_backend.mjs`＋`e2e_t14_eval.py`。
- 還沒做：mini 的 app.json（gas／gasSource／readActions 加 EvalCalc.gs、Eval.gs 與 7 支讀取 action）、光復舊成績實際匯入與重算差 0（要 Eason 匯出舊試算表）、舊站唯讀版（T5-5）、三套題目草稿網頁給總監（T0）。

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：
