# P4 影子期方案（p4-plan.md）
版本：v1 / 2026-11-03　依據：spec.md §5.1（含 GPT-07／08／09 修訂）、plan.md、task.md T19／T19b／T20

## 目標
Mac mini 上的損益 app 以「只讀備份（mirror）」模式跑約一週：每天 03:45 從舊端（Google 試算表）讀回整份資料，新舊逐項比對；同時在隔離副本上演練排程。**切換清單 5 項全過**才進 P5／P6。這一週會計照常用舊系統，什麼都不變。

## 切換清單（spec §5.1，缺一項或有任何差異都不准切換）
1. 8 月裁判八項差 0（mini 上）
2. 光復 2026-09、2026-10 八項差 0（新舊比對）
3. 所有啟用門市最近 3 個月，每日比對連續 3 天全同
4. 演練副本連續 3 天與舊端全同
5. 所有被明細引用的附件 sha256 全對（known-missing 要 Eason 逐筆核准）

## 要先做的程式（我在 MacBook 上做，P4-a）
| # | 做什麼 | repo |
|---|---|---|
| A1 | **合併 P0–P2**：mala-pnl-auto `pnl-native-p2` → main；dzy-minikit `pnl-p2` → main（含 kit 共用改動：上傳上限、MiniFiles、getLastRow，另外 5 支 mini app 要一起更新，測試已全綠）；push。合 main 後 `kit/bin/sync-gas.sh pnl` 正式同步。 | 兩個 |
| A2 | **附件鏡像**：kit `mirror.files` 目前只收英數欄名、裸檔案 ID；損益是「明細.附件URL」（中文欄名、完整雲端硬碟網址）。改 kit：欄名允許中文、加選填 `idPattern`（從網址取 ID）；損益 miniBridge 的 `__miniFile` 同步支援從網址取 ID。檔案先照 mirror 慣例存 `files/<ID>.<ext>`，切換時再轉成 pnlfile 版面（P5 手冊）。 | dzy-minikit、mala-pnl-auto |
| A3 | **比對工具** `apps/pnl/tools/compare.js`（C8）：在 mini 上跑，對每店每月分別問舊端（dzyProxy＋同一把金鑰）與 mini 本機的 getMonth，逐項比八大項＋待補清單，輸出 JSON lines＋摘要；結果寫 `$DATA/compare/YYYY-MM-DD.jsonl`。mirror 的 readActions 加 `dzyProxy`（mirror 模式每個請求都回滾，讀取安全；只對本機直連）。 | dzy-minikit |
| A4 | **演練副本** `apps/pnl/tools/rehearse.js`（T19b）：每天 mirror 完把資料庫複製到 `$DATA/staging/`，用正式 jobs.js 對副本跑一次當天每日更新（連接器只打唯讀端點、通知不送），再用 compare.js 比副本 vs 舊端當天 06:30 後的結果。 | dzy-minikit |
| A5 | launchd：03:45 mirror 由 kit 本來就排；比對 07:30、演練 07:00 各一支排程（或併進 jobs 的 mirror 後回呼），log 帶日期戳；結果進 `/pnl/health`（compare_diff 黃燈）。 | dzy-minikit |
| A6 | 守門與指揮台 patch（WATCH-PATCH.md 已產生）：加 `pnl-server` 格。 | mala-fortune |

**演練範圍的取捨（我替你先定，可改）**：spec 原本寫「把當天舊端收到的推送也重放進副本」。舊端沒有保存推送內容，要重放得改舊端記錄每筆推送（動正式系統）。我改成：演練只跑「每日更新＋連接器＋排隊」；三條推送（POS、貨單、費用請款）已有整合測試，切換當晚再各手動打一次冒煙。理由是不為了演練去改正式系統，要改回去跟我說。

## 要 Eason 做的（P4-b，依序；每步我會給可整段貼的指令）
1. **在 MacBook 推損益舊端搬家通道**（gas/miniBridge.js，原功能不變，只多一條唯讀匯出通道）：`clasp push` → `clasp redeploy <部署ID>`。自動模式會擋正式部署，所以要你本人貼指令，我逐行核對輸出。
2. **舊 Apps Script 加兩個指令碼屬性**：`MINI_EXPORT_KEY`（自己產生的長字串）、`MINI_APP=pnl`；附件鏡像另加 `MINI_FILE_COLUMNS`（值我給）。
3. **Mac mini 上照 apps/pnl/MIRROR.md 部署**（交辦給 mini 的 Claude）：拉程式、建資料夾、填 .env（MINI_EXPORT_KEY、舊端網址）、啟動、第一次讀回、Funnel 加 `/pnl` 路徑（你說可以才加）。另外 5 支 mini app 跟著更新 kit（`kit/bin/update-all.sh`），更新後逐支看健康燈。
4. 守門 patch：`clasp push`（schedule-watchdog）要你貼。
5. 之後每天看指揮台那一格；連續 3 天全綠、5 項清單全過，我就寫 P5 切換手冊給你排切換日。

## 風險與退路
- 影子期完全不碰舊系統的寫入；mini 上的 pnl 只讀，出事就停掉 mini 上的 pnl，舊系統照常。
- kit 共用改動影響另外 5 支 mini app：合併前全套測試綠；更新後若任何一支燈號異常，用 `kit/bin/update-all.sh` 的回退（回到前一版 commit）＋重啟。
- 舊端加 MiniBridge 的唯一行為差異：多一條需要金鑰的匯出通道；沒設 FROZEN 前其他功能一字不變（P0 審查已驗）。

## 時程（估）
- P4-a 程式：我這邊約 1 個晚上（含 Fable 階段關）。
- P4-b 部署：你約 30–45 分鐘（含 mini 交辦）。
- 影子期：部署後至少 3 天（清單第 3、4 項要連 3 天）。
