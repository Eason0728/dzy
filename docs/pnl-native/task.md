# 任務清單：損益試算原生化（task.md）
版本：v1 / 2026-11-03　依據：plan.md v1（契約 C1–C8）
每個任務 100–200 行程式（含測試另計），輸入、輸出、驗收可打勾。

## P0 地基
- **T01 kit 每支 app 自訂上傳上限**（dzy-minikit kit/runner/server.js、lib/config.js）
  - 輸入：app.json 選填 `maxBodyBytes`（整數，1 KB–8 MB）。輸出：/api、/proxy、/svc 的 body 上限照它；沒設＝256 KB。
  - 驗收：[ ] 沒設時行為與現在逐位元相同（既有 kit 測試全綠）　[ ] 設 4 MB 時 3 MB body 通過、5 MB 回 413　[ ] 非法值啟動時報錯不啟動
- **T02 mini app 骨架**（dzy-minikit apps/pnl）
  - 用 `kit/tools/install.js` 產 app.json（C1 props、gasSource、jobs、dataDir、backupAt）、空 jobs.js、README。
  - 驗收：[ ] ports.json 登記新埠與 /pnl　[ ] 本機 `node kit/runner/server.js apps/pnl` 啟動、/pnl/health 有回應　[ ] 不含任何金鑰值
- **T03 舊端 MiniBridge**（mala-pnl-auto gas/）
  - 照 `kit/gas/MiniBridge.gs` 加 `__miniExport`、`__miniFile`、`FROZEN`；publicSurface 白名單同步。
  - 驗收：[ ] publicSurface 測試綠　[ ] 沒有 MINI_EXPORT_KEY 一律 AUTH　[ ] FROZEN=1 時所有寫入回 FROZEN、讀取照常

## P1 離線可跑
- **T04 執行環境旗標與 GONE**（C1、C6）：`pnlIsMini_()`；mini 上觸發器相關函式 no-op；C6 清單回 GONE。
  - 驗收：[ ] Apps Script 模式下既有測試全綠　[ ] mini 模式下 C6 每個 action 回 GONE　[ ] ensureDailyRefreshTrigger_ 在 mini 不碰 ScriptApp
- **T05 附件改本機**（C5）：gas 端 uploadAttachment／getAttachment 在 mini 模式改走 jobs.js 檔案路由（runGas 只寫明細與檔案中繼資料，位元組由 jobs.js 寫檔）。
  - 驗收：[ ] 上傳→讀回 sha256 相同　[ ] 跨店／跨月路徑讀取回 NOT_FOUND　[ ] 舊 drive 格式透過 drive-map 讀得到
- **T06 kit 上跑裁判**：在 kit 執行器載入損益 gas，跑 `judge_202608` 等價流程。
  - 驗收：[ ] 八項每項差 0　[ ] dzyProxy getMonth／addEntry／voidEntry／finalize 經 /pnl/api 可用
- **T07 維護動作**（C7）：五個 admin 動作進 dzyProxy；三處白名單一致測試。
  - 驗收：[ ] 非 admin 呼叫回 FORBIDDEN　[ ] adminSyncSeed full 需 `confirm:true`　[ ] 白名單比對測試綠

## P2 連網與排程
- **T08 pnlHttp_ 兩段式**（C2）：三個呼叫點（monthlyDraft.js:278、:655、laborEstimate.js:230）改呼叫 pnlHttp_。
  - 驗收：[ ] Apps Script 模式行為不變（既有連接器測試全綠）　[ ] mini 模式缺結果時丟 PNL_NEED_FETCH 且未寫任何列　[ ] 帶結果重跑寫入與 Apps Script 模式相同
- **T09 逐步工作**（C3）：拆出 pnlStepDaily_、pnlStepMonthly_、pnlActiveStores_；原 dailyRefresh_／monthlyDraft_ 在 Apps Script 改呼叫這些 step（行為不變）。
  - 驗收：[ ] 每個 step 單店 < 5 秒（測試資料）　[ ] Apps Script 模式整體結果與改前相同（快照比對）
- **T10 jobs.js 排程與連線**：06:30 每日、1 號 06:00 月初、開機補跑、失敗店 30 分鐘重試一次、通知匣、/health 併入。
  - 驗收：[ ] 假時鐘測試：時間到才跑、已跑不重跑、錯過補跑　[ ] fetch 逾時 45 秒、log 不含網址與金鑰　[ ] 通知匣 key 照 pnlsys:…
- **T11 使用者觸發排隊**（C4）：工作佇列分頁、getJob、onApi 立刻撿單。
  - 驗收：[ ] refreshConnectors 回 job_id、3 秒內開始執行　[ ] getJob 只看得到自己可看門市的工作　[ ] 同店同月重複按只排一筆
- **T12 連接器網址放寬**：允許 http://127.0.0.1／localhost（僅 mini 模式）。
  - 驗收：[ ] Apps Script 模式仍只收 https　[ ] mini 模式收本機、拒其他 http

## P3 原生前端（dzy modules/pnl）
- **T13 模組骨架與狀態**：index.js、state.js、views/common.js；拿掉 iframe 與 bridge 的 postMessage；保留 alerts。
- **T14 儀表板 view**：六列 12 個月走勢 SVG、估算標示、待補數、全部門市＋品牌篩選。
- **T15 填資料 view**：待補總覽＋五類；新增、作廢、附件上傳／檢視、確認為 0。
- **T16 匯入 view**＋`lib/import-logic.js`：SheetJS 經 load-xlsx.js；對照測試同一 POS 檔新舊解析逐列相同。
- **T17 設定 view（一）**：門市、科目、門市科目、連接器、匯入範本。
- **T18 設定 view（二）**：建草稿／立即拉取（排隊＋輪詢）、重新帶入固定值、定稿／解除、異動紀錄、CSV 匯出、維護區。
  - P3 共同驗收：[ ] 三種權限看到的分頁與按鈕正確　[ ] 任何畫面不出現登入表單　[ ] 讀取中用管理系統樣式　[ ] e2e 隨機資料四頁每顆按鈕點過、clickmap 0 漏

## P4 影子期
- **T19 mirror 設定與附件抓取**：app.json mirror（含 files 欄 `明細.附件URL`）。
  - 驗收：[ ] mirror-now 讀回後列數與舊端一致　[ ] 附件 sha256 全對或列入 known-missing
- **T20 比對工具**（C8）：compare.js 舊端 getMonth vs mini getMonth。
  - 驗收：[ ] 人為改一筆金額能抓到 diff　[ ] summary 正確

## P5 手冊
- **T21 DEPLOY／CUTOVER／ROLLBACK**（apps/pnl/）：照現金帳手冊格式；含 4 處網址、FROZEN、附件對照表回寫。
  - 驗收：[ ] 回退在測試資料完整演練一次並留紀錄

## P6 上線
- **T22 外部網址改讀設定**：mala-fortune push_pnl_pos.py 讀 `PNL_PUSH_URL`；守門 PNL_HEALTH_URL 與 skip 判斷。
- **T23 舊入口退場頁**：mala-pnl.github.io 換「已搬到管理系統」頁。
- **T24 上線前審查**：Fable＋GPT 互盲，三塊（金額、排程推送、搬遷回退）。
- **T25 切換與落地清單**：照 CUTOVER；八項落地清單打勾。
