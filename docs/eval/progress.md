# 進度：績效評核（管理系統模組，三品牌共用）
- 開案日：2026-10-24
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：⑤
- 等 Eason：12/31 晚上推舊站唯讀版前，先問他本機那筆「成績鎖定（先鎖 2026-Q3）」要不要一起推。

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
- 本機測試環境：scratchpad evstack（run-backend.sh 8848、run-web.sh 8849）；e2e 用 `test/e2e/eval_backend.mjs`＋`e2e_t16_eval.py`（主線已有兩支 ⑭）。
- 2026-10-26 已把 origin/main（93 筆：收支管理、排班、區域、LINE 認身分）併進分支 `eval-merge`（之後在這條分支做；`eval-req` 停用）。registry：績效評核排在薪酬管理後、收支管理前（cashbook 測試要求它最後一列）。
- Mac mini：minikit 分支 `eval-gas`（app.json 登記兩支 .gs＋7 支讀取 action；gas/ 檔要等 dzy main 合併後 sync-gas）。
- 舊站唯讀版：mala-eval 分支 `moved-readonly`（js/config.js MOVED_TO；已用假後端驗過只剩我的成績＋搬家說明），2027-01-01 前推。
- 三品牌題目草稿網頁（給總監）：https://claude.ai/artifact/2rrNcbDSDx5m77r9GenRsy（Eason 要用分享選單開權限給總監）。
- 還沒做：光復舊成績實際匯入與重算差 0（上線後人資在設定頁貼上舊試算表；要能讀舊試算表）、上線（T7）、帳號認領追蹤（11/15 起）。

## 上線紀錄（2026-10-27）
| 步驟 | 結果 |
|---|---|
| ① dzy 第一段（平台後端，選單未上） | Eason 推，main 61772d9..79b91db |
| ② ~/dzy 快轉＋sync-gas --i-know | 與準備的 gas 複本一字不差；minikit npm test 540 過、0 失敗 |
| ③ minikit main e438795＋mini 更新 dzy-platform | 外網打 evMe 回 unauthorized（新 action 已上線） |
| ④ dzy 第二段（選單上線） | main 79b91db..92d365c |
| ⑤ admin 按「初始化績效評核」 | Eason 回報初始化完成 |
| 上線前驗證 | node 全綠；e2e 19 支 18 過（⑪「過期那筆已過期」在原 main 也失敗，非本案）；Fable 品質審查 15 條修 12 條（spec §8） |

## 後續時程
| 日期 | 事項 | 誰 |
|---|---|---|
| 11/7 | 三套題目草稿交總監（已交：https://claude.ai/artifact/2rrNcbDSDx5m77r9GenRsy） | Claude→Eason |
| 11/15 起每週 | 各店帳號未認領人數追蹤，店長催；12/31 前要認領完 | Claude 列、店長催 |
| 12/15 | 總監把題目定稿，人資在「設定」輸入（每季第一個月 1～5 號不能改題） | 總監、人資 |
| 12/31 晚上 | 推舊站唯讀版（mala-eval 分支 moved-readonly）；推之前先問 Eason「成績鎖定」那筆要不要一起推 | Eason 在 MacBook 推 |
| 2027-01-01～05 | 全集團開放填寫 2026 第四季；10 號公布 | 全體同仁 |
| 2027-04 | 舊站換成「已搬家」頁 | Claude |
| 上線後 | 人資在「設定 → 匯入舊成績」貼光復舊試算表；載入小辛辣現行題目並核對 KPI 範本 | 人資 |

## 落地清單
- [x] 1 排程上線：不適用（沒有排程；季度與填寫窗由後端依日期判斷）
- [x] 2 掛進監看：不適用（沒有定時任務；平台後端已在 mini 健康燈號內）
- [x] 3 納入故障追蹤：不適用（沒有排程艦隊項目）
- [x] 4 登錄資源：沿用 dzy-platform（mini 埠 8799）；本模組無新網址、無新金鑰
- [x] 5 建 skill 並登錄路由：dzy-admin「績效評核」一節；mala-staff-eval 標示已搬家；routing-full／dispatch-rules 指向更新
- [x] 6 寫一則記憶：主庫 perf-eval-system-staff-eval.md 更新為「已搬進 dzy」
- [x] 7 進版控：dzy main 92d365c、minikit main e438795；本進度檔走 PR
- [x] 8 回報未完成與等待事項：見上方「後續時程」，已回報總控
