# 技術方案：損益試算原生化（plan.md）
版本：v1 / 2026-11-03　依據：requirements.md v1.1、spec.md v1（Eason 2026-11-03「規格 OK」）

## 里程碑
| Phase | 目標（做完可以展示什麼） | repo |
|---|---|---|
| P0 地基 | kit 支援每支 app 自訂上傳上限；mini 上建出空的 pnl app 骨架；舊端裝 MiniBridge 可匯出 | dzy-minikit、mala-pnl-auto |
| P1 離線可跑 | 損益 gas 在 kit 執行器上跑：8 月裁判差 0、dzyProxy 讀寫可用、登入類回 GONE、附件存本機 | mala-pnl-auto、dzy-minikit |
| P2 連網與排程 | 連接器、人事估算、通知匣改兩段式；每日更新／月初草稿逐店跑；使用者按「立即拉取」改排隊 | mala-pnl-auto、dzy-minikit |
| P3 原生前端 | 管理系統損益試算四頁原生版，對本機 mini app 全功能可用 | dzy |
| P4 影子期 | mini 以 mirror 模式上線，每天讀回舊資料＋新舊逐項比對，連 3 天全同 | dzy-minikit |
| P5 切換手冊 | CUTOVER／ROLLBACK／DEPLOY 三份手冊；回退在測試資料上演練一次 | dzy-minikit |
| P6 上線 | Fable＋GPT 互盲審三塊 → Eason 選晚上切換 → 舊入口退場 → 落地清單 | 全部 |

P1 與 P3 可平行（P3 先對假後端開發）；P4 要等 P1＋P2；P5 可與 P3 平行。

## 共用契約（逐字格式；兩個以上任務都會產生或讀的值）
### C1 執行環境旗標
- gas 端判斷函式 `pnlIsMini_()`（gas/runtime.js）：kit 沙盒標記 `__shim` 存在，**或** Script Property `PNL_RUNTIME`＝`mini`，兩者任一即為 mini（P1 實作：避免 .env 漏設時誤判成 Apps Script）。

### C2 對外連線兩段式
- gas 端所有對外連線改呼叫 `pnlHttp_(req)`，`req`＝`{ id: <string>, url: <string>, method: 'post', payload: <string JSON> }`。
  - Apps Script：直接 UrlFetchApp，回 `{ code: <number>, body: <string> }`。
  - mini：查 `PNL_HTTP_RESULTS_`（本次 runGas 由 jobs.js 傳入的物件，鍵＝`id`），有就回；沒有就把 `req` 推進 `PNL_HTTP_NEEDED_` 陣列並丟 `Error('PNL_NEED_FETCH')`。
- `id` 格式：`<kind>:<store_id>:<YYYY-MM>:<conn_name>`，kind ∈ `conn`｜`labor`｜`inbox`。例：`conn:S01:2026-10:現金帳`。通知匣：`inbox:-:-:<key>`。
- jobs.js 流程：`runGas(step, args, {results})` → 若回 `{ok:false, error:'PNL_NEED_FETCH', needed:[req…]}` → Node 逐一 fetch（逾時 45 秒）→ 帶著 results 重跑同一 step；同一 step 最多重跑 3 輪。
- gas 端每個 step 必須在「需要的連線都拿到結果」前不寫任何資料（丟錯前不寫，kit 會 rollback）。

### C3 逐步工作
- 排程 step 名與參數：`pnlStepDaily_(store_id, month)`、`pnlStepMonthly_(store_id, month)`；store 清單由 `pnlActiveStores_()` 取得。
- 每個 step 回 `{ok, store_id, month, status: 'done'|'partial'|'fail', detail}`；`detail` 不含金鑰、網址。

### C4 使用者觸發的連網動作
- mini 上 `refreshConnectors`、`createDraft`（含連接器）不直接連網：寫一筆工作到分頁 `工作佇列`（欄：job_id、種類、store_id、月份、狀態、建立者、建立時間、開始時間、租約到期、嘗試次數、完成時間、結果JSON），回 `{ok:true, data:{queued:true, job_id}}`。
- 狀態機（GPT-05）：`queued → running → done｜fail`。claim＝一次 runGas 內把 queued 改 running、寫租約到期（現在＋10 分鐘）、嘗試次數＋1；**結果寫入與改 done 在同一次 runGas**（kit 一請求一交易，同成同敗）。重啟時 running 且租約過期 → 改回 queued 重跑；因為 createDraft／connector 寫入本身有 MANUAL_EXISTS／同來源冪等，重跑不會重複入帳。嘗試 3 次仍失敗 → fail。
- 唯一鍵：同 `種類＋store_id＋月份` 已有 queued／running 的工作 → 回既有 job_id，不新增。
- jobs.js 的 `onApi` 收到這兩個 action 立刻撿單；前端每 3 秒用新 action `getJob {job_id}` 查狀態，最多 3 分鐘。
- `job_id` 格式：`J` + `yyyyMMddHHmmss`（台北）+ `-` + 4 位隨機小寫英數。例：`J20261103213005-k3x9`。

### C5 附件
- 附件URL 新格式：`pnlfile:<store_id>/<YYYY-MM>/<file_id>.<ext>`，`file_id`＝Utilities.getUuid() 去掉 `-`，`ext` 由 MIME 決定（jpg、png、pdf、webp、heic）。例：`pnlfile:S01/2026-10/3f9a0c1e2b4d4e8f9a7b6c5d4e3f2a1b.jpg`。
- 實體路徑：`<dataDir>/files/<store_id>/<YYYY-MM>/<file_id>.<ext>`，權限 600。
- **P1 實作調整**：kit 新增 `MiniFiles` 同步檔案服務（app.json `files:{dir:'files'}`），上傳由 gas 端在同一次請求內直接寫檔（tmp→fsync→rename），不經 jobs.js；P1 審查後：執行器 commit／rollback 時一併提交／刪除本次請求寫的檔（MiniFiles 日誌），寫檔後丟例外不留孤兒檔；開機掃描保留作第二道防線（例如 Code.gs 自己接住錯誤回 ok:false 的情況）。
- 上傳順序（GPT-10，原設計）：jobs.js 先寫暫存檔 `<…>/.tmp-<file_id>` → 驗 sha256 → fsync → rename 成正式檔 → 才 runGas 寫明細（附件URL＋sha256）。runGas 失敗 → 刪正式檔。開機時掃描：沒有任何明細引用、且超過 1 小時的檔案移到 `files/.orphan/`（不刪，黃燈）；明細引用但檔案不存在 → 紅燈。
- 舊格式 `https://drive.google.com/file/d/<id>/…` 在 mini 上讀取時，由搬遷對照表 `files/drive-map.jsonl`（每列 `{drive_id, pnlfile}`）轉換；搬遷完成後明細欄位一律改寫成新格式，對照表保留供回退。

### C6 退場動作
- mini 上 `login`、`registerWithInvite`、`logout`、`changeMyPasscode`、`revokeSessions`、`createInvite`、`revokeInvite`、`listInvites`、`generatePasscode` 一律回 `{ok:false, error:'GONE'}`。

### C7 維護動作（取代試算表選單，只 pnl.admin，經 dzyProxy level=admin）
`adminSelfCheck`、`adminSyncSeed {full:boolean}`、`adminApplyS01Connectors`、`adminCreateLastMonthDraft`、`adminLoadStoreSeedS01`。三處白名單（gas `DZY_PROXY_ACTIONS_`、dzy `bridge.js PNL_ACTIONS`、dzy `platform/dryrun.js`）必須一致，測試比對。

### C9 排程紀錄（GPT-02）
- 分頁 `排程紀錄`（欄：run_key、種類、store_id、業務日期、狀態、開始時間、完成時間、來源）。`run_key`＝`<daily|monthly>:<store_id>:<YYYY-MM-DD>`，例 `daily:S01:2026-11-03`；`來源` ∈ `mini`｜`gas-import`。
- jobs.js 決定要不要跑（含開機補跑）只看這張表：該 run_key 狀態 done 就不跑。
- 切換時由搬遷工具依舊端 `PNL_DAILY_REFRESH_PROGRESS`／`PNL_MONTHLY_DRAFT_PROGRESS` 與當天日期，寫入 `來源=gas-import` 的 done 列。

### C8 比對工具輸出（影子期）
- `apps/pnl/tools/compare.js` 對每店每月輸出一行 JSON：`{store_id, month, same: true|false, diffs: [{field, old, new}]}`，field 為八大項名稱或 `pending`；最後一行 `{summary: {total, same, diff}}`。

## 風險與對策
| 風險 | 對策 |
|---|---|
| 計算結果與舊端不同（日期、數字型別、排序） | gasshim 已照真環境做型別轉換；P1 跑 judge、P4 影子比對連 3 天全同才切換 |
| 長工作卡住 kit 佇列（其他請求 BUSY） | C3 逐店 step，每 step 目標 < 5 秒 |
| 兩段式重跑造成重複寫入 | C2 規定拿到全部結果前不寫；冪等鍵沿用既有 client_id／MANUAL_EXISTS 規則 |
| 附件搬遷漏檔 | size＋sha256 逐檔比對、known-missing 清單、黃燈 |
| 切換後推送打到舊端 | 舊端 FROZEN 後推送回 MOVED（來源端視為暫時性、會重送），4 處網址列入冒煙檢查 |
| kit 改動影響其他 5 支 app | maxBodyBytes 選填、預設不變；kit 全套測試＋update-all 前先在一支 app 試 |
