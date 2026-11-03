# 進度：損益試算原生化（管理系統 modules/pnl 不再 iframe 嵌 mala-pnl.github.io）
- 開案日：2026-11-03
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：④（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：無（P3 完成，下一步 P4 影子期，需 Eason 在 Mac mini 操作，另給交辦）

## Eason 決定（2026-11-03）
- 範圍：四頁（儀表板、填資料、匯入、設定）一次做完才切換，不新舊並存。
- 後端：資料與計算一起搬到 Mac mini（比照現金帳），不再沿用 Apps Script。
- 外觀：管理系統樣式，不帶三品牌主題。
- 過渡：不小修嵌入登入表單外露，等原生版。
- ② 探待補：posPush／purchasePush／expensePush／連接器／dailyRefresh／monthlyDraft／health 守門／試算表現有資料量與搬遷方式、mini 現有 app 架構（dzy-minikit）。

## ① 查（2026-11-03）
- 已存在：`~/dzy/modules/pnl`（iframe 嵌 `https://mala-pnl.github.io/?embed=dzy`，2026-10-26 @27 上線）；正本 `~/dzy/docs/pnl-fin/{requirements,spec}.md`（當時 Eason 選「比照薪酬嵌入」）。
- 起因：嵌入模式在第一筆 `getSettings` 回來前，損益頁預設畫面是自己的登入表單（`gas/shell.html` boot → renderShellDom → bootEmbed_），後端慢時露出最多 70 秒。2026-11-03 Eason 選「管理系統原生重做」。
- 記憶庫：mala-pnl-auto-project.md（門市自動損益系統）；skill：mala-pnl-auto、dzy-admin。
- 先例：`modules/cashbook` 為原生模組（views/、lib/、state.js）。

## ② 探結果（2026-11-03，只讀；三支 haiku Explore＋自查）
| 探什麼 | 指令 | 實際輸出 | 結論 | 對設計的影響 |
|---|---|---|---|---|
| mini 能否直接跑 GAS 程式 | `ls ~/dzy-minikit/kit/gasshim`；讀 services.js 開頭 | 有 gasshim：SpreadsheetApp（SQLite 版）、Lock、Cache、Properties、Utilities、ContentService、Session、Logger；**UrlFetchApp／DriveApp／MailApp／ScriptApp／HtmlService 一碰就丟 UNSUPPORTED** | 已有 5 支 app 用這條路搬（audit、dorm、dzy-platform、mztloss、transfer） | 損益可照 kit 搬：gas/*.js 原檔 vm 載入，不重寫計算；要補 UrlFetchApp（連接器、通知匣）、DriveApp（附件→本機檔）、觸發器→jobs.js；MailApp 只是退路可拿掉 |
| 損益後端入口 | 讀 gas/api.js | doPost：health、posPush、purchasePush、expensePush、dzyProxy、login、registerWithInvite＋26 支 token action | 原生版只走 dzyProxy＋機器推送；login／邀請碼／登出等可退場 | 帳號體系改由管理系統決定，影子帳號機制可簡化 |
| 觸發器 | setup.js:890-934、tableCache.js:219 | monthlyDraft_ 每月1號06:00、dailyRefresh_ 每日06:30、onChange 換代、onOpen 選單 | 選單 7 項（初始化、重設通行碼、自我檢查、載入光復、同步科目×2、套連接器）要有替代入口 | 選單功能移到設定頁或 mini 指令 |
| 對外呼叫 | monthlyDraft.js:248,655、laborEstimate.js:230 | 通知匣（網址寫死）、連接器 URL／金鑰存「連接器」分頁 | 連接器三個：現金帳（mini 8795）、調撥（mini transfer 8800）、薪資（GAS） | 搬上 mini 後現金帳／調撥可走本機 127.0.0.1 |
| 打進損益的上游 | grep AKfycbzRpEDK 等 | ①mala-fortune push_pnl_pos.py:63（網址寫死，每天 05:15＋1–3 號上月）②~/mala-purchase server/.env PNL_PUSH_URL ③dzy-platform .env PROXY_URL_PNL（代轉＋apv.js 每 15 分 expensePush）④守門 pnlMonthlyWatch PNL_HEALTH_URL 寫死（mala-fortune/tools/gas-watchdog 與 mala-gas/schedule-watchdog Code.js:576） | 切換時 4 處改網址，金鑰值不變 | 切換步驟要含這 4 處＋舊端 FROZEN |
| 管理系統前端呼叫路徑 | 讀 dzy/platform/api.js、modules/cashbook | ctx.api.call(ns, action) → platform /proxy → proxy-hook 帶操作人 → 上游 | 原生模組照 cashbook 寫法 | modules/pnl 改寫為 views/*，不再 iframe |
| 資料量 | Drive 連接器 get_file_metadata 光復試算表 | Requested entity was not found（連接器帳號無權限，表在 madesiaosinla） | **未確認** | 搬遷工具要先 dry-run 數列數；需 Eason 或 madesiaosinla 身分匯出 |
| 線上狀態 | curl health | active_stores 11、missing 10（2026-10 草稿缺 10 家） | S10–S30 啟用後 10 月沒有草稿 | 另回報 Eason，非本案 |
| 搬遷先例 | ~/mala-cashbook/server CUTOVER.md／ROLLBACK.md | 前置檢查→舊端 FROZEN=1→migrate dry-run→正式→改網址→實測→備份；回退＝READONLY＋rollback-export | 照抄流程 | 規格要寫凍結、搬遷、回退三份手冊 |

## ② 探（初步）
- 代轉已存在：`ctx.api.call('pnl', <action>)` → mini → GAS doPost dzyProxy（`modules/pnl/index.js` 的 alerts 已在用）。白名單 18 支 action 見 `modules/pnl/bridge.js` PNL_ACTIONS。
- 損益前端規模：shell 2215＋dashboard 1599＋entry 1059＋import 776＋importLogic 526＋settings 2701＋css 2314 行（計算 engine 在後端，前端不重算）。

## 合併 main 後待做（P1 起累積）
- dzy-minikit apps/pnl/gas/ 目前是從損益分支手動複製（清單已補 3 檔）；損益合 main＋push 後要正式跑一次 `kit/bin/sync-gas.sh pnl` 覆蓋。
- 附件目錄 `<dataDir>/files` 的備份（kit 每日備份只含 app.db）：**P2 未做**，移到 P5 部署手冊（照 apv-backup tar 做法）。
- 切換冒煙清單要加：`/pnl/health` 不得有 `pnl_jobs_off`（夜審 #1）、附件上限約 2.9MB（代轉 4MB）。
- 切換時 .env 要設 `PNL_JOBS_ON=1`、`NOTIFY_INBOX_URL`、`NOTIFY_INBOX_TOKEN`（jobs.js 用）；影子期不設。
- 已修（P1 審查）：gasshim getLastRow 尾端空白列、MiniFiles 回滾。
- P2 前：selfCheck 加 runtime 欄；getLastColumn 尾端空格（既有行為，評估）；MiniFiles.remove 不進回滾日誌（損益未用）；adminCreateLastMonthDraft 在 mini 上連接器失敗會每次堆一列 log（P2 兩段式後解決）；mala-pnl-auto 自己的 mock 測試清單補載入 runtime／attachLocal／adminMaint。

- P3 T13：dzy bridge.js PNL_ACTIONS／platform/dryrun.js／Auth.gs 白名單加 getJob 與五個 admin 維護動作（三處一致測試）。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-11-03 | 階段關 P3＋夜間全面審查 | T13–T18（dzy pnl-native-p3）＋全系統 | Fable 全面審查 15 條（高1 中6 低8）全修；Codex 額度用完，Eason 決定不等 | 1 | scratchpad night-review/fable-result.md |
| 2026-11-03 | 階段關 P2 | T08–T12（mala-pnl-auto pnl-native-p2、dzy-minikit pnl-p2） | 第 1 輪 2 阻斷（onApi 不觸發、待連線清單交錯）＋11 建議；第 2 輪可合併，#14–#17 收尾已改 | 2 | Eason0728/mala-pnl-auto#73 |
| 2026-11-03 | 階段關 P1 | T04–T07（mala-pnl-auto pnl-native-p1、dzy-minikit pnl-p1） | 第 1 輪 1 阻斷（app.json 漏 3 檔）＋判斷 4 點；第 2 輪可合併 | 2 | Eason0728/mala-pnl-auto#72 |
| 2026-11-03 | 階段關 P0 | T01–T03（dzy-minikit pnl-p0、mala-pnl-auto pnl-native-p0） | 第 1 輪 1 阻斷＋7 建議；第 2 輪可合併，#4 #7 收尾已修 | 2 | Eason0728/mala-pnl-auto#71 |
| 2026-11-03 | 設計審 | requirements／spec／plan／task v1 | GPT 15 條（全標高）：11 條確定成立已改文件；4 條交 Fable 複核：04 不成立、01／03 部分成立（補切換日限制與 FROZEN 錯誤碼）、15 現行行為（寫明） | 1 | scratchpad design-review/gpt-result.md；Fable 複核回報 |

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：
