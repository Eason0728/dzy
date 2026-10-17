# 技術方案：管理系統第三期表單簽核

版本：v1 / 2026-10-18。上游：requirements v1.1、spec v1.1（已確認）。

## 里程碑
| Phase | 目標 | 里程碑（做完能看到什麼） |
|---|---|---|
| P0 探 | 補兩個未確認 | 知道通用備份端收不收圖；通知匣 from 清單已加「表單簽核」 |
| P1 後端核心 | 路線＋表單狀態機＋權限表 | mock 測試：四個例子路線正確、退回再送、撤回、改派、權限正反向全綠 |
| P2 照片與排程 | jobs.js 照片路由、每日彙整、照片備份、孤兒清除 | 本機起 minikit 平台，curl 上傳／讀取照片、手動觸發 digest 看到組好的字 |
| P3 前端 | modules/approvals 六分頁＋首頁提醒 | 本機 devserver 用假後端從手機寬度走完「送 8,600 請款 → 總監核准 → 財務已處理」 |
| P4 整合關 | minikit 接線、e2e、上線前雙審 | e2e 全綠；Fable＋GPT 互盲審高風險三塊，問題全結 |
| P5 上線 | 先 mini、後前端 | BOSS 用 dryrun 走四例子；一張真的小額請款走完 |

P1 與 P2 的 jobs 部分、P3 可平行（P3 先對假後端做）；P4 必須等全部完成。

## 共用契約（平行任務都要產生的值，逐字元定義）
| 值 | 格式 | 範例 |
|---|---|---|
| 單號 | `APV-` + 台北日期 `YYMMDD` + `-` + 三位流水（當天從 001） | `APV-261018-001` |
| 照片檔號 | `F` + `Date.now().toString(36)` 大寫 + 4 碼大寫英數亂數 | `FMGXK2P1A7Q3Z` |
| 照片路徑 | `<dataDir>/apv-files/YYYY/MM/<檔號>.jpg` | `~/dzy-platform-data/apv-files/2026/10/FMGXK2P1A7Q3Z.jpg` |
| 表單種類 | `purchase`／`expense`／`personnel` | — |
| 狀態 | `signing`／`rejected`／`handling`／`done`／`withdrawn` | — |
| 權限人代碼 | `head`／`brand_dir`／`ceo`／`gm`／`chair`；往上順序就是這個順序 | — |
| 權限表 form_type | 固定 `spend` | — |
| 承辦部門 | `pur`／`fin`／`hr`（＝org 部門代碼，P1 第一步先 grep 確認實際代碼，不同就以 org 為準並回寫本表） | — |
| route_json | `{"v":1,"row":{"seq":2,"max":10000,"role":"brand_dir"},"steps":[{"role":"brand_dir","scope":"mala-hq"}],"handler":"fin"}`；人事單 steps 可多格，離職本人確認格 `{"role":"self_sign","emp":"DZY014"}` | — |
| 事件 action | `submit`／`approve`／`reject`／`skip`／`reassign`／`withdraw`／`sign`／`handle` | — |
| 金額 | 整數元，Number；請購＝Σ round(qty×price) | — |
| svc 路由名 | `apv-file-put`／`apv-file-get` | `POST /platform/svc/apv-file-put` |
| 通知匣 key | `apv-` + 台北 `YYYYMMDD` | `apv-20261019` |

## 分層與既有規矩（違反就停）
- `platform/` 只改 `registry.js` 一行（＋`dryrun.js READ_ACTIONS` 補讀取 action——這是既有慣例的資料清單，不算分層破壞；P4 用 `git diff --stat platform/` 確認只有這兩檔）。
- 新 .gs：`Approvals.gs`、`ApprovalRoute.gs`；minikit `app.json` 的 gas／gasSource 同長、readActions 補齊。
- jobs 用的全域函式（`apvFileAuthorize_` 等）**不准**進 Code.gs 分派表。
- 寫入 action 進 `MUTATING_ACTIONS`；改 users 不在本期範圍。
- 公開 repo：測試一律假名、假編號。提交前 `git branch --show-current`，只 add 自己的檔。

## 風險
| 風險 | 對策 |
|---|---|
| 128 人只 1 人開通，權限人找不到 → 全部堆到董事長／人資 | 上線前列出四類權限人開通狀況給 Eason；路線預覽讓送件人先看到 |
| 照片只有 mini 一份 | P0 先探備份端；收不了就 tar 本機另存並明講風險 |
| 整庫進記憶體 | 照片不進資料表；apv_events 一年估 1 萬列，可接受 |
| 前後端相依 | 部署照 spec §12：先 mini、外網確認，再推前端 |

## 驗證關卡
- 任務關：每個 task 的驗收指令跑過、貼輸出。
- 階段關：P1、P3 結束各開一個 GitHub issue 給 Fable 審（照 new-system skill）。
- 上線前關：Fable＋GPT 互盲，只審三塊：①金額比對與路線（ApprovalRoute.gs）②權限與看得到誰的單（Approvals.gs）③寫外部（照片磁碟、通知匣）。
- 整套關：用 spec §5.1 四例子＋邊界金額跑一支裁判腳本。
