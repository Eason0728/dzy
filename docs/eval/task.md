# 任務清單：績效評核模組（task.md）

- 版本：v1 / 2026-10-24（依 plan v1）。每項 100～200 行程式；驗收要貼「指令＋輸出」。
- 共用契約見 plan.md「共用契約」，不得自創格式。
- 工作資料夾：`~/dzy-wt-eval`（分支 `eval-req`，之後改 `feature/eval`）；commit 只 add 自己的檔；真名不進 repo。

## P0 題目草稿
| # | 任務 | 輸入 | 輸出 | 驗收 |
|---|---|---|---|---|
| T0-1 | 墨竹亭題目＋KPI 草稿 | 小辛辣四組題目、墨竹亭門市作業（向 Eason／skill mzt-* 查） | `docs/eval/drafts/mzt.md`＋Artifact 給總監改 | 三組題目各附 5 級說明；KPI 店長、正職兩張，各 70 分 |
| T0-2 | 一悟題目＋KPI 草稿 | 同上（一悟資料未確認，先問 Eason 給誰） | `drafts/yiwu.md` | 同上 |
| T0-3 | 央廚題目＋KPI 草稿 | 同上＋cf-production-schedule skill | `drafts/ck.md` | 廠長、正職兩張 KPI |

## P1 計分核心
| # | 任務 | 輸入 | 輸出 | 驗收 |
|---|---|---|---|---|
| T1-1 | 移植計分純函式 | 舊 `js/scoring.js` | `apps-script/platform/EvalCalc.gs` | 舊 scoring 測試案例全部移植到 `test/eval-calc.test.mjs` 全過 |
| T1-2 | 移植新人考核判斷 | 舊 `js/newbie.js` | 同上檔 `evDueDate_`、`evNewbieStatus_` | 舊 11 個案例全過；保險絲日期參數化 |
| T1-3 | 一人一季彙總 | T1-1 | `evAggregate_(peerRows, selfRow, sup, bank, tpl)` → `{items, att, perf, adj, total, grade, wageIdx}` | 用 3 組手算案例＋1 組光復匿名化實例比對 |
| T1-4 | 前端小計共用檔 | T1-1 | `modules/eval-shared/calc.js` | 測試逐字比對 .gs 對應函式 |

## P2 資料與權限
| # | 任務 | 輸出 | 驗收 |
|---|---|---|---|
| T2-1 | 分頁與初始化 | `Eval.gs evSetup_`（12 個 `ev_*`，只補不覆蓋）＋未初始化回 `not_inited` | mock 測試：連跑兩次不重複、表頭不一致會停 |
| T2-2 | 季度與填寫窗（後端判斷） | `evQuarterNow_`、`evWindowOpen_`、`evResultVisible_` | 1/1、1/5、1/6、1/9、1/10、12/31 邊界案例 |
| T2-3 | 權限碼 | Perms.gs 加 4 碼＋名稱＋預設規則 | `test/perms*.test` 全過；權限設定頁看得到 4 個新開關 |
| T2-4 | 範圍裁切 | `evScope_(session)` | 四種身分 × 三家店矩陣測試 |
| T2-5 | 同仁身分 | `evMe`：本人 emp_no、單位、品牌、pt/ft、今季、窗開否、已送否、權限 | 非 active／總部的人回對的狀態 |
| T2-6 | 登記 action | Code.gs 白名單／分派／MUTATING、dryrun.js、minikit app.json | `test/proxy-authorize.test.mjs` 等既有比對測試全過 |

## P3 同仁端
| # | 任務 | 輸出 | 驗收 |
|---|---|---|---|
| T3-1 | 模組骨架 | `modules/eval/manifest.js`（dept hr、6 views）、`index.js`；registry 一行 | `git diff --stat platform/` 只有 registry.js |
| T3-2 | 互評送出 | `evPeerSubmit`（後端驗窗、同單位、防重複、存 labels）＋`views/fill.js` | 跨店送出被擋；重送回 duplicate |
| T3-3 | 自評＋留言 | `evSelfSubmit`＋`views/self.js` | 匿名旗標存對；公司留言無發話者回傳 |
| T3-4 | 我的成績 | `evMyScores`（只回彙總）＋`views/mine.js` | 回應 JSON 搜不到任何評分者 emp_no |
| T3-5 | 草稿與等待鈕 | localStorage 草稿、按鈕秒數 | 重整還原；別人帳號看不到 |

## P4 主管端
| # | 任務 | 輸出 | 驗收 |
|---|---|---|---|
| T4-1 | 新人考核 | `evNewbieList`／`evNewbieSubmit`＋view | 只列自己可審核的人；一人一次 |
| T4-2 | 單位結果與填寫進度 | `evUnitResults`、`evProgress`＋view | 品牌總監看得到品牌各店、店長只看本店 |
| T4-3 | 個人明細與打分 | `evPersonDetail`、`evSupSave`（KPI、加減分、回饋） | 只能對往上一層（stfReviewNeed_）為真的人存 |
| T4-4 | 列印 PDF | 列印樣式＋檔名 | 無頭 Chrome 印出抬頭含品牌與店名 |

## P5 設定與搬家
| # | 任務 | 輸出 | 驗收 |
|---|---|---|---|
| T5-1 | 題庫／範本編輯 | `evBankGet/Save`、`evTplSave`＋view | 改題後舊送出仍顯示當時題目 |
| T5-2 | 時薪與等第表 | `evWageSave`、`evGradeSave` | 四品牌各自生效 |
| T5-3 | 定稿 | `evFinalize`／`evUnfinalize`、漂移提醒 | 定稿後改題不影響該季分數 |
| T5-4 | 匯入舊成績 | `evImportPreview/Commit`＋view（姓名比對只在瀏覽器） | 光復 Q1～Q3 匯入後與舊站總分差 0 |
| T5-5 | 舊站唯讀版 | mala-eval 前端：登入後只剩我的成績＋搬家提示 | 本機點過；1 月前不推 |
| T5-6 | 小辛辣題庫種子 | 舊站題庫原樣進 `ev_bank`／`ev_kpi_tpl`（儲備幹部→mala/ft） | 題目文字逐字相同 |

## P6 整合驗收
| # | 任務 | 驗收 |
|---|---|---|
| T6-1 | e2e：隨機資料兩階段（10/3 填、10/12 看），兩家店互看不到 | 全綠 |
| T6-2 | 本機整套（minikit runner＋devserver）給 Eason 點的版本 | Eason 點過 |
| T6-3 | 全部 node 測試＋既有 e2e 不退步 | 無 FAIL |

## P7 上線（交辦 mini＋Eason）
| # | 任務 | 驗收 |
|---|---|---|
| T7-1 | sync-gas → mini pull → 重啟 | 外網 `evMe` 回 not_inited |
| T7-2 | admin 初始化、推前端 | 人資部門出現績效評核 |
| T7-3 | 人資輸入四品牌題目與表 | 各品牌設定頁有題 |
| T7-4 | 12-20 試跑模式，各品牌一位店長點一輪 | 無寫入、無錯 |
| T7-5 | 落地清單八項 | progress.md 全勾 |
