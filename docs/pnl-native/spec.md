# 規格：損益試算原生化（spec.md）
版本：v1 / 2026-11-03（待 Eason 確認）　需求：`requirements.md` v1.1（Q1–Q6 全照建議）

## 0. 一句話架構
```
管理系統前端 modules/pnl（原生 views，不再 iframe）
   │ ctx.api.call('pnl', action, payload)      ← 跟現金收支同一條路
   ▼
Mac mini dzy-platform /platform/proxy（驗權限、帶操作人、外層包成 action=dzyProxy）
   │ PROXY_URL_PNL＝http://127.0.0.1:<埠>/pnl/api   ← 改成本機
   ▼
Mac mini 新 app「pnl」（dzy-minikit kit 執行器）
   ├ 損益 gas/*.js 原檔用 vm 載入（gasshim：試算表＝SQLite）
   ├ jobs.js：排程（06:00 月初草稿、06:30 每日更新）、所有對外連線（連接器、人事估算、通知匣）
   └ 附件：~/dzy-pnl-data/files/<store>/<YYYY-MM>/
外部推送（05:15 POS、貨單、費用請款、守門 health）→ Funnel https://<mini>/pnl/api（doPost 原樣）
```
**原則**：計算（`src/engine.js`→`gas/engine.js`）與資料規則一行不改；改的只有「Google 專屬服務」的接法與前端。

## 1. 後端：mini app `pnl`（repo `~/dzy-minikit` apps/pnl）
### 1.1 app.json
- `name: pnl`、`path: /pnl`、埠由 `kit/tools/install.js` 取下一個空號、`dataDir: ~/dzy-pnl-data`、`tz: Asia/Taipei`、`backupAt` 取空檔（避開 03:35／03:40／03:50）。
- `gasSource`：`~/mala-pnl-auto/gas/*.js`（不含 `.html`；`seed_s01.js` 要含，光復資料靠它）。
- `jobs: jobs.js`；`readActions`：dzyProxy 讀類與 health（mirror 階段用）。
- `props`：PNL_PUSH_KEY、PNL_PURCHASE_KEY、PNL_DZY_KEY、PNL_SALT、NOTIFY_INBOX_TOKEN（值由 Eason 從舊端指令碼屬性抄到 mini .env，Claude 不經手）。
- `mirror`：切換前的「只讀影子」階段用（見 §5），切換當天移除。

### 1.2 Google 專屬服務的替代（gasshim 沒有的）
| 服務 | 損益哪裡用 | 替代 |
|---|---|---|
| UrlFetchApp | 連接器（monthlyDraft.js:655）、人事估算（laborEstimate.js:230）、通知匣（monthlyDraft.js:278） | **兩段式**：gas 端新增 `pnlFetchPlan_(job)` 回「要打哪些網址＋內容」，jobs.js 用 Node fetch 打完，再 `pnlFetchApply_(job, results)` 寫回。gas 程式裡的 UrlFetchApp 呼叫改成走一個 `pnlHttp_()` 介面：Apps Script 上＝UrlFetchApp（舊端照常），mini 上＝讀 jobs.js 預先抓好的結果。 |
| ScriptApp（觸發器） | setup.js 的 ensureDailyRefreshTrigger_ 等 | mini 上一律 no-op（`PNL_RUNTIME=mini` 判斷）；排程改 jobs.js：每天 06:30 每日更新、每月 1 號 06:00 上月草稿；開機當天已過且沒跑 → 補跑。 |
| 長工作 | dailyRefresh_／monthlyDraft_ 原本 4.5 分鐘一次跑完 | kit 一次只跑一個請求、排隊超過 20 秒回 BUSY → **改成逐店逐步**：每一步一次 runGas（一家店的一件事），步與步之間讓出佇列。 |
| DriveApp | 附件上傳／讀取（apiWrite.js:740–870）、setup 建資料夾 | jobs.js 註冊本機路由寫檔；gas 端只記「附件ID」。附件網址格式由 `drive.google.com/file/d/` 改為 `pnlfile:<store>/<YYYY-MM>/<id>.<ext>`，舊資料兩種都認。上傳／讀取仍走 dzyProxy（uploadAttachment／getAttachment），檔案大小上限照舊。 |
| MailApp | 通知匣失敗退路 | 拿掉；通知匣三次寫不進去 → /health 黃燈＋log。 |
| HtmlService／doGet／onOpen 選單 | 舊網頁、試算表選單 | mini 上不提供網頁；選單 7 項改成 dzyProxy 的 admin 動作（§3.3）。 |
| onChange 觸發器 | 手改試算表時快取換代 | mini 上不會有人手改表，寫入即換代已足夠，不需要。 |
| 請求大小 | kit 上限 256 KB | 附件與匯入超過 → kit 增加 app.json `maxBodyBytes`（選填，預設不變＝其他 app 不受影響），pnl 設 4 MB，與代轉 `maxBodyBytes: 4194304` 一致。 |

### 1.3 登入與帳號（Q3）
- mini 上只開：`dzyProxy`、`posPush`、`purchasePush`、`expensePush`、`health`。`login`、`registerWithInvite`、token 類動作一律回 `GONE`。
- 影子帳號「管理系統:<帳號>」機制保留（計算可看門市要用），非此前綴的舊帳號在搬遷時標停用，Eason 本人那列也停（試算表選單已不存在）。
- 門市範圍（GPT-15，Fable 複核：現行即如此）：管理系統決定「角色」（read／write／admin），損益影子帳號的「可看門市」決定「哪些店」；所有讀寫都由損益端比對可看門市，附件由檔案路徑反查門市，不信任參數。影子帳號第一次建立時預設 ALL，要限縮由 pnl.admin 在設定頁改。原生版照此不變。

### 1.4 連接器
- 現金帳、調撥已在 mini：連接器網址改 `http://127.0.0.1:8795/cashbook/api`、`http://127.0.0.1:8800/transfer/api`（實際路徑以 ports.json 為準）。連接器網址驗證由「必須 https://」放寬為「https:// 或 http://127.0.0.1／localhost」。
- 薪資仍在 Apps Script，照舊用 https。

## 2. 前端：`~/dzy/modules/pnl` 原生改寫
- 結構比照 `modules/cashbook`：`index.js`（掛載、路由）、`state.js`、`views/{dashboard,entry,import,settings,common}.js`、`lib/`。manifest 九個分頁（儀表板、待補、食材、人事、可控、不可控、營業收入、匯入、設定）與權限 `pnl.read／write／admin` **不變**。
- 呼叫：全部 `ctx.api.call('pnl', action, payload)`；`bridge.js` 的 PNL_ACTIONS 白名單＋新的 admin 維護動作，與 `platform/dryrun.js`、mini proxy `inner` 白名單三處一致（測試比對）。
- 匯入：POS／範本 xlsx 在瀏覽器解析，沿用 `modules/cashbook/lib/load-xlsx.js` 載 SheetJS（版本與損益現用 0.20.3 一致）；`importLogic.html` 的解析規則搬成 `lib/import-logic.js`，加對照測試（同一份 POS 檔新舊解析結果逐列相同）。
- 走勢圖：照損益現有畫法（SVG 自繪，has_entries 斷線、估算空心虛線），改用管理系統色票；不引入圖表套件。
- 讀取中：一律管理系統的骨架／讀取中樣式；沒有任何登入表單。
- 拿掉：iframe、postMessage 橋、品牌主題、邀請碼與登入相關畫面。

## 3. 行為對照（不變的部分要有測試證明）
### 3.1 計算一致
- `node test/judge_202608.js`（8 月裁判，八項差 0）在 mini 執行器上跑一次。
- 影子階段（§5）每天比對：舊端與 mini 對同一店同一月 `getMonth` 的八大項＋待補清單完全相同；連續 3 天全部相同才可切換。

### 3.2 自動化
| 項目 | 舊 | 新 |
|---|---|---|
| 每月草稿 | GAS 觸發器 1 號 06:00 | jobs.js 1 號 06:00，逐店 |
| 每日更新 | GAS 觸發器 06:30 | jobs.js 06:30，逐店；失敗店 30 分鐘後重試一次 |
| POS／LINE Pay 推送 | mala-fortune → GAS exec | mala-fortune → `https://<funnel>/pnl/api`（網址改讀 secret `PNL_PUSH_URL`，不再寫死） |
| 貨單推送 | mini purchase → GAS exec | `PNL_PUSH_URL=http://127.0.0.1:<埠>/pnl/api` |
| 費用請款推送 | dzy-platform apv.js → PROXY_URL_PNL | 同一個變數，改本機網址後自動跟上 |
| 守門健康檢查 | schedule-watchdog POST health → GAS | 改 Funnel 網址；確認守門「script.google.com 才檢查」的 skip 判斷改為兩種都檢查 |
| 通知匣 | GAS UrlFetch | jobs.js，key 規則不變（pnlsys:…） |
| 備份 | Google 試算表本身 | kit 每日 VACUUM 快照 14 份＋通用備份端（附件目錄另做 tar，比照 apv-backup） |

### 3.3 試算表選單 → 設定頁「維護」區（只有 pnl.admin）
自我檢查、同步科目範本、同步科目範本（完整，二次確認）、套用光復連接器對應、建立上月草稿、載入光復門市資料。初始化與重設通行碼不再需要（帳號由管理系統管）。

## 4. 資料搬遷
- 舊端 GAS 加 MiniBridge（`kit/gas/MiniBridge.gs`，與宿舍、稽核同一套）：`__miniExport` 匯出全部分頁、`__miniFile` 取附件檔。
- 步驟：`export.js --url <舊 exec>` → `import.js --dry-run` → `import.js` → `verify.js`（逐格比對）→ 附件依「明細.附件URL」欄逐檔抓、size＋sha256 對上才收 → 附件URL 改寫成 `pnlfile:` 格式（另存對照表，回退用）。
- Script Properties 中的狀態鍵（進度、估算快取、遷移旗標）：只搬 `PNL_MODE_MIGRATIONS_DONE`、`PNL_ESTIMATE_KEYS_BACKFILLED`、`PNL_STORE_BRAND_SEEDED`、`PNL_AUTO_FILL_S01`；快取類不搬（mini 第一次每日更新會重算）。
- 資料量未確認 → 第一次 export 就會知道列數；明細預估數千列，在 kit 能力內（宿舍、帳號後端都更大）。

## 5. 切換與回退
### 5.1 影子階段——**2026-11-03 Eason 決定跳過**
目前沒有人在用損益試算，改成「一次搬家＋全量比對＋事後觀察 3 天」。切換關卡與補法見 `p4-plan.md` v2（取代原影子期與 5 項切換清單、T19／T19b／T20 改為 B3／B4）。

### 5.2 切換（Q5：平日晚上約 1 小時，避開 05:15、06:30；事前通知會計與財務主管）
0. （GPT-02、06）刪除舊端全部觸發器（每日更新、月初草稿、onChange）、把光復試算表編輯權限收回到只剩擁有者；確認舊端當天 06:30 已跑完。
1. 舊端設 `FROZEN=1`（只剩讀取），最後一次 export → import → verify → 附件補抓；同時把舊端「今天已跑過的排程」寫進 mini 的排程紀錄（plan C9），mini 不會當晚補跑一次。
2. mini app 移除 mirror、開排程。
3. 改 4 處網址：mala-fortune secret `PNL_PUSH_URL`、purchase `.env`、dzy-platform `.env` `PROXY_URL_PNL`（重啟平台）、schedule-watchdog `PNL_HEALTH_URL`。
4. 管理系統前端 push（新 modules/pnl）。
5. 冒煙：/pnl/health 綠、管理系統打開損益試算三種權限各看一次、手動觸發一次每日更新、POS 推送 dry-run。
6. 舊入口退場（Q3）：mala-pnl.github.io 改「已搬到管理系統」頁、舊試算表改唯讀（Q1）、乾淨範本加停用說明（Q4）。

### 5.2b 切換空窗的推送（GPT-01、03，Fable 2026-11-03 複核）
- 貨單（mala-purchase pnl_outbox）與費用請款（apv.js）收到 FROZEN／BUSY 都會保留重送（指數退避），損益端以同來源整批比對／`[APV-…]` 冪等，不漏不重。舊端 FROZEN 回錯誤碼 `MOVED`（MiniBridge 既有行為；Fable P0 審查已核對三個來源都視為暫時性、會重送；絕不可改成 BAD_INPUT／LOCKED，那兩個在來源端是終態）。凍結期 `MINI_READ_ACTIONS` 只放 `health`，**不可放 dzyProxy**（閘門只看外層 action，放了 inner 寫入會穿過）；所以切換那一小時管理系統的損益頁會暫時讀不到，事前通知。
- POS／LINE Pay（push_pnl_pos.py）沒有 outbox，但每天推「當月累計」、損益端相同內容 no-op → 隔天自動補齊。**例外是月底最後一天**（隔天改推新月）→ 切換日不得排在每月最後一天與 1–3 號；切換完成後手動跑一次 `--mtd` 推送當冒煙。
- 連網在 Node 端做，不佔執行器佇列；佇列只跑 step 本身（< 5 秒），推送不會因為連接器等 45 秒而 BUSY。

### 5.3 回退（切換後發現問題）
1. （GPT-11）停 mini 排程、等在途工作做完（工作佇列無 running）→ 資料目錄放 READONLY → 同一時點取 DB 快照＋附件目錄快照。
2. `export.js --from-db` → 舊端 `rollback-push.js` 寫回。
3. 附件（GPT-12）：搬家時來自 Drive 的照對照表改回；**切換後才上傳的 pnlfile** 由回退工具逐檔上傳回 Drive「損益附件」資料夾、驗 sha256、改寫明細欄。
4. （GPT-13）恢復舊端：重建兩個觸發器、拿掉 FROZEN、解除舊端停用模式（§5.4）、試算表編輯權限恢復、mala-pnl.github.io 重新部署保存好的嵌入版 `pages/index.html`（切換前先存一份）。
5. 4 處網址改回 → dzy 前端 revert 到 iframe 版。
- 回退手冊在切換前用測試資料演練一次（成功標準）。

### 5.4 舊端停用模式（GPT-14）
- 切換完成後舊 GAS 設 `PNL_DECOMMISSIONED=1`：除了 MiniBridge（搬遷／回退專用金鑰）與 health 以外，所有 action（含 dzyProxy、各推送、使用者 API）一律回 `GONE`，同時換掉 `PNL_TOKEN_SECRET` 讓所有舊登入立即失效。回退時拿掉。

## 6. 測試
- mala-pnl-auto：既有 `node --test test/*.test.js test/ui/*.test.js`、judge；新增 `pnlHttp_` 兩種執行環境、逐步排程、附件 `pnlfile:` 格式、GONE 動作。
- dzy-minikit：kit `maxBodyBytes` 測試（預設不變）；pnl jobs.js 排程、補跑、重試、通知匣；執行器上跑 judge。
- dzy：模組白名單三處一致、各 view 對假後端的畫面測試；e2e（`test/e2e`）用隨機資料走完四頁每顆按鈕。
- 搬遷：verify 逐格、附件 sha256、影子比對連 3 天全同。

## 7. 審查
- 設計審：本規格確認後、開工前，GPT（codex-gpt.sh，唯讀）對抗性審查，高嚴重度拿不準的由 Fable 複核。
- 上線前：Fable＋GPT 互盲，只審三塊：金額計算一致性、排程與推送（外部系統寫入）、搬遷與回退。

## 8. 影響範圍（要改的 repo）
| repo | 改什麼 |
|---|---|
| mala-pnl-auto | pnlHttp_ 抽象、逐步工作、附件 pnlfile、mini 執行環境旗標、GONE、維護動作進 dzyProxy、MiniBridge |
| dzy-minikit | apps/pnl（app.json、jobs.js、文件三份）、kit maxBodyBytes |
| dzy | modules/pnl 原生改寫、dryrun.js、測試 |
| mala-fortune | push_pnl_pos.py 網址改讀 secret；守門 PNL_HEALTH_URL |
| mala-gas/schedule-watchdog | 同上守門（與 mala-fortune 正本同步） |
| mala-purchase | 只改 .env（mini 上） |
| mala-pnl.github.io | 換成「已搬家」頁 |
