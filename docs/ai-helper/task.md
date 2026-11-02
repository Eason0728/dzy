# 管理系統 AI 小幫手｜任務清單（task）v0.1

> 每個任務 100–200 行；輸入／輸出／驗收都要寫得出來。編號 T<phase>-<n>。

## Phase 1｜平台後端
- **T1-1 建表與知識庫讀寫**（AiHelp.gs 前半）
  輸入：admin token。輸出：`aihSetup` 建 `aih_kb`／`aih_log`／`aih_pending`（只補不覆蓋、表頭不符停）；`aihKbList {q?, status?}` → `{items:[…kb 欄位]}`；`aihKbSave {id?, …欄位, expected_updated_at?}` → `{id}`（新題自動編號、改題比對 updated_at 防覆蓋）。
  驗收：mock 測試建表兩次不重複；非 platform.aihelp 一律 forbidden；並發改同題第二筆回 conflict。
- **T1-2 待回答與用量**（AiHelp.gs 後半）
  `aihPendingList {status?}`、`aihPendingSet {id, status, kb_id?}`、`aihUsage {month}` → `{usd, count, answered_ratio, down_ratio, by_day[]}`。
  驗收：done 必須帶 kb_id；用量由 aih_log 加總，與手算一致。
- **T1-3 node 專用全域函式**
  `aiHelpAuthorize_(token)`（spec §6 形狀，鍵白名單）、`aihKbLive_()`（只回 live）、`aihLogAppend_(row)`、`aihPendingAdd_(row)`、`aihFeedback_(uid, id, good)`（只能改自己的 log）、`aihPurge_(nowMs)`（刪 90 天前 log、結案 pending 的 q 清空）。
  驗收：Code.gs 全文不出現這六個名字（測試比對）；staff／系統帳／停用帳號各一例；鍵多一個就紅。
- **T1-4 權限與分派**
  Perms.gs `platform.aihelp` 進 GRANTABLE＋LOCKED；Code.gs 分派 7 支 aih* action；dryrun.js READ（aihKbList、aihPendingList、aihUsage）／WRITE（其餘）；perms*.mock 測試數字更新。
  驗收：全部既有 node 測試綠；`git diff --stat platform/` 只有 dryrun.js。
- **T1-5 頁面地圖產生器**
  `tools/gen-aihelp-pages.mjs` → `AiHelpPages.gs`；測試：產物＝現行 registry。
  驗收：新增假模組不重產 → 測試紅。

## Phase 2｜mini node 路由
- **T2-1 骨架、Origin、限流、狀態落盤**
  `createAiHelp({gas,cfg,dataDir,now,fetch})`；op status；`aih-rate.json`（人／日、全站／分、月 usd、通知已送旗標）。
  驗收：錯 Origin 403；第 21 題 rate_person；重啟後計數還在。
- **T2-2 提示組裝與 Claude 呼叫**
  `buildPrompt({kb,pages,me,perms,page,alerts,history,q})`（純函式）；`callClaude()`：model、max_tokens 1024、output_config.format JSON schema、逾時 20 秒、錯誤碼對應 ai_error。
  驗收：提示字串不含姓名、編號、token（測試用假資料 grep）；固定段放在快取斷點前、每題段在後。
- **T2-3 ask／feedback／draft**
  ask 流程 spec §3 1–8；unknown 與 👎 寫 pending；draft 需 platform.aihelp（由 aiHelpAuthorize_ 回的 perms 判斷）。
  驗收：go 不在 pages 被刪；log 寫失敗仍回答案；ai_error 不扣題數；80%／100% 各通知一次。
- **T2-4 排程與接線**
  09:20 彙整（新 pending 數＋前 5 題＋本月花費，key aih-YYYYMMDD）、03:50 aihPurge_；jobs.js routes；app.json gas／gasSource／readActions／backupExclude；SOURCE.sha256；render-docs。
  驗收：minikit npm test 只剩既有 7 項環境失敗；runner 起來 `op:status` 回 on:false。

## Phase 3｜前端
- **T3-1 client.js**：網址由 `BACKENDS.platform` 換 `/svc/ai-help`；逾時 25 秒；錯誤碼 → 中文訊息表。
- **T3-2 widget.js＋helper.css**：按鈕、側欄、對話（記憶體）、👍👎、帶我去（isViewPermitted）、手機版、底部說明字、鍵盤可操作。
- **T3-3 shell.js 接線**：登入後 mount、登出 unmount（含 doLogout 路徑）；`getRoute`、`alerts` 提供。
  驗收：e2e t21 ①～④（出現／關閉不出現／問答／帶我去權限）；全部 e2e 綠；375／320 寬無橫向捲軸。

## Phase 4｜管理模組
- **T4-1 manifest＋index＋待回答分頁**（AI 擬答、上架、略過）
- **T4-2 知識庫分頁＋用量分頁＋alerts**
- **T4-3 registry、圖示、e2e 卡片數**（t1／t2／t3／t4／t8／t11 寫死數字）
  驗收：e2e t21 ⑤～⑦（👎 → 待回答 → 擬答 → 上架 → 再問答得出）。

## Phase 5｜初始知識庫
- **T5-1 寫 60 題**（分 6 批，每批 10 題，來源檔附註）：通用（登入、改密碼、LINE 重設、待審、首頁）、我的資料／通訊錄、公告、考勤申請與核定、排班、主管功能（同仁名單、兼任、權限設定、稽核、表單簽核）。
- **T5-2 aihKbImport＋管理頁「匯入初始知識庫」與勾選上架**
  驗收：重複匯入不重複；未勾的維持 draft、AI 拿不到。

## Phase 6｜整合與上線
- **T6-1 本機三層整合＋資料帶入測試**（skill data-drive-test 做法，假 Claude）
- **T6-2 實打 30 題量費用**（先問 Eason）
- **T6-3 上線前互盲審查**（Fable＋GPT，三塊）
- **T6-4 上線＋三邊同步**（skill、記憶、操作圖解；落地清單八項）
