# 技術方案：員工名單統一

依據：`spec.md` v1 定案。四個里程碑、八個階段；每階段結束有可驗收的東西。
⚠ dzy repo 是 public：不寫網址、金鑰、試算表 ID、真名。

## 共用契約（兩個以上任務都會產生的值，逐字元定義）
| 值 | 格式 | 範例 |
|---|---|---|
| store_code | 小寫，固定六個：`gf` `mztjs` `mztgf` `mztlzl` `hq` `cf`（`gf`＝小辛辣光復，其打卡 CONFIG code 是空字串，兩邊對照只在 clock_stores 與 LINE_HUB 設定處理） | `mztjs` |
| job_id | `J` + 台北時間 `yyyyMMddHHmmss` + `-` + 4 位小寫十六進位亂數 | `J20261014093015-a3f0` |
| op_id | `dzy:` + job_id（管理系統發的）；7A 由 LineHub 發：`hub:` + store_code + `:` + LINE userId 的 SHA-256 前 12 碼 + `:` + 台北日期 `yyyyMMdd` | `dzy:J20261014093015-a3f0`、`hub:mztjs:1a2b3c4d5e6f:20261014` |
| emp_no | `DZY` + 三位數字，大寫 | `DZY128` |
| 打卡 svc 請求 | POST JSON `{action, v:1, svc_key, ...}`，Content-Type `text/plain` | `{"action":"svc_add","v":1,"svc_key":"…","name":"…","op_id":"dzy:J…","created_by":"管理系統:DZY014"}` |
| 打卡 svc 回應 | 成功 `{ok:true, ...}`；失敗 `{ok:false, error:<代碼>, message:<中文>}`；代碼只用 `unauthorized` `bad_version` `bad_input` `busy` `duplicate_name` `not_found` `disabled` | `{"ok":false,"error":"duplicate_name","message":"本店已有在職同仁同名"}` |
| created_by（打卡名冊） | 管理系統建：`管理系統:` + 操作者 emp_no 或帳號；7A：`LINE 自動（首次支援）` | |
| 日期 | 一律台北時區字串 `yyyy-MM-dd`；時間 `yyyy-MM-dd HH:mm:ss` | |

## 里程碑
- **M1（階段 0–4 完成）**：本機 mock 環境裡，店長新增→假打卡後端建人→離職 00:10 連動→每日同步→首頁異常，整條跑通。
- **M2（階段 5）**：正式環境對照建完、店長確認完；此時只讀不寫打卡。
- **M3（階段 5 後半）**：正式開放店長新增與離職（寫打卡）。
- **M4（階段 6–7）**：7A 與佈告欄切換上線。之後兩週觀察→階段 8 退場舊按鈕。

## 階段 0：準備（不寫功能）
- 打卡：把六個部署副本中最新的 `程式碼.js` 與正本 `Code.gs` 對齊（以部署版為準，去掉試算表 ID／金鑰換回 `PASTE_` 佔位），commit。確認六店部署副本彼此相同（只差 CONFIG）。
- minikit：跟維護者確認 `app.json` 加選填 `jobs`；不同意→改走獨立 launchd 程式（同樣的 jobs.js，自己起 http 呼叫 127.0.0.1）。
- 開 GitHub issue（dzy repo）當階段關審查紀錄；issue 內不貼網址、金鑰、真名。

## 階段 1：打卡端 SvcStaff.gs（mala-clock-in repo）
- 新檔 `apps-script/SvcStaff.gs`：svc_roster／svc_add／svc_set_active／svc_link；金鑰比對、冪等（op 紀錄存新分頁 `svc_ops`：op_id, action, result_json, at）、鎖、依表頭寫入。
- `ensureRosterHeaders` 補 `src_store, src_emp_id`。
- Code.gs 分派表併入 `SVC_STAFF_HANDLERS`（三行）。
- node mock 測試（沿用 repo 既有 mock 方式）。
- 部署：六店逐一 push＋update-deployment；Eason 在六店編輯器設 `STAFF_SVC_KEY`。未設金鑰＝端點全拒，部署本身零影響。

## 階段 2：平台後端（~/dzy/apps-script/platform）
- 新檔 `StaffClock.gs`：clock_stores／staff_clock／clock_outbox 三分頁建立（併入 setupStaff，只補不覆蓋）；staff 補 hire_date、last_day 兩欄。
- 對外 action：`staffCreateByUnit`、`staffLeave`、`staffLeaveCancel`、`clockMapList`、`clockMapDecide`、`clockMapBuild`、`clockOutboxRetry`、`clockLink`、`clockJobStatus`、`svcDirectory`。
- 內部函式（只給 jobs.js 經 runGas 呼叫，**不進 Code.gs 分派表**）：`clockOutboxClaim_`、`clockOutboxDone_`、`clockRosterApply_`、`clockDailyApply_`、`clockLinkPrepare_`。
- staff 模組 alerts 的資料來源 action `clockAlerts`。
- 測試：沿用 `test/staff.mock.test.mjs` 沙盒，新寫 `test/staff-clock.mock.test.mjs`。

## 階段 3：同步員（~/dzy-minikit）
- kit：`app.json` 選填 `jobs`；啟動時 require，給 `{runGas, env, log, now}`；jobs 例外不影響主服務。
- `apps/dzy-platform/jobs.js`：每 60 秒撿單→打打卡→回填；每天 00:10 每日同步；開機補跑；`clockLink` 也走待辦單（kind=link，見 spec 補充）：jobs.js 撿到後打 svc_link，把金鑰暫存 CacheService 120 秒，前端用 clockJobStatus 取一次即清除。
- 測試：本機假打卡後端（node http）＋假 runGas。

## 階段 4：前端（~/dzy/modules/staff、modules/me）
- 同仁名單：新增鈕（店長只看到自己單位）、登記／撤銷離職、離職進度「打卡已停 n/m」、打卡編號欄、顯示打卡連結、待辦單紅燈與重試、打卡對照分頁（總部）。
- 我的資料 → 待審核：加「打卡對照」分頁（店長）。
- alerts：四類異常。
- e2e 第九支（全 mock）。

## 階段 5：正式上線（只讀 → 寫）
- 5a：mini 同步新後端（sync-gas.sh）＋jobs＋.env 六店網址金鑰；`CLOCK_WRITE=0`（同步員只做 svc_roster，不送 add／deactivate）。
- 5b：總部按「建立打卡對照」；店長確認；總部處理剩下的。驗收：44 位在職打卡同仁全部 confirmed 或明確排除。
- 5c：前端上線（先 mini 後前端，照 dzy-admin 規矩）。
- 5d：`CLOCK_WRITE=1`，開放新增與離職。值班核定的新增按鈕改說明（打卡前端小改）。
- 上線前關（5a 之前）：Fable＋GPT 互盲，審 SvcStaff、jobs.js、StaffClock.gs 的寫入路徑。

## 階段 6：7A（光復 LineHub）
- LineHub not_bound 前加 `lineHubAutoSupport_`；條件不成立回原流程。
- 值班核定頁「首次支援」標記（manager*.html 顯示 created_by）。
- 只部署光復（LineHub 只在光復）；B 店那邊靠階段 1 已上的 svc_add。
- 上線前關：Fable＋GPT 互盲審 7A。

## 階段 7：佈告欄切換（~/dzy-bulletin）
- server 端同步改讀 `svcDirectory`（127.0.0.1）；staff 加 `dzy` 欄；一次性搬家腳本用既有 src 經對照填 dzy。
- 拿掉打卡同步按鈕、CLOCK_PRIMARY_。
- 演練：spike/sample 真實名冊在本機跑搬家，零錯配才上。

## 階段 8：舊新增退場（M4 後兩週）
- 條件：兩週內「打卡上有、沒對照」異常為零。
- 六店 mgr_add_employee 回 `disabled`。

## 風險與對策
| 風險 | 對策 |
|---|---|
| 同步員重送造成打卡建兩個人 | op_id 冪等（svc_ops）；測試「同 op_id 送兩次只建一人」 |
| 兩邊同時取號（值班核定舊按鈕＋svc_add） | svc_add 與 mgr_add_employee 用同一把 ScriptLock、同一個 nextEmpId |
| 對照錯人 | suggested 不生效；7A 用 src_* 不用姓名；同名一律人工 |
| mini 時鐘或 00:10 沒跑 | 開機補跑；離職連動以「last_day < 今天」判斷，晚跑不漏 |
| 打卡端正本落後 | 階段 0 先對齊；之後每次部署前 diff 部署副本與正本產物 |
| 真名進 public repo | 測試一律假名；spike/ gitignore；commit 前 grep 名冊真名（spike/sample 抽出名單比對整個 repo） |
| svc_key 外流 | 只在 mini .env 與各店指令碼屬性；可單店換 |
| 7A 被濫用（定位造假） | 只限已在別家綁 LINE 且在職者；B 店主管核定時看得到「首次支援」可退回；每人每店只會建一次（op_id 含日期＋停用列不自動恢復） |
