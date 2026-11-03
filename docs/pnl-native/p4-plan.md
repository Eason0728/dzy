# P4 一次搬家方案（p4-plan.md）
版本：v2 / 2026-11-03（Eason 決定：**跳過影子期**——目前沒有人在用損益試算，改成「一次搬家＋全量比對＋事後觀察 3 天」）
依據：spec.md §5（已依本版修訂）、plan.md、task.md

## 為什麼可以跳過、代價怎麼補
| 影子期原本防的 | 跳過後的影響 | 補法 |
|---|---|---|
| 切換後會計當天打不開 | 目前沒人用，不受影響 | — |
| 排程、連接器在真資料上第一次跑 | 切換後第一個 06:30 才真的跑 | 切換當晚手動跑一次每日更新（全部門市），當場看結果 |
| 多天重複比對抓「某些日子才有」的差異 | 只有切換當晚一次全量比對 | 計算程式一行沒改＋裁判測試；舊端開停用模式前做最後一次全量比對（停用後舊端不再回答，觀察期改看 /pnl/health 與指揮台；B7 實作發現） |
| 退回簡單（停掉新的即可） | 要走退回手冊、把新資料寫回舊端 | P5 退回手冊先在測試資料演練一次 |
| 切換初期資料只在 mini | mini 出狀況時推送延後 | 推送端都會重送；切換日避開月底與 1–3 號 |

## 切換關卡（搬家當晚，缺一項或有任何差異就不切，直接解凍舊端）
1. 8 月裁判八項差 0（mini 上）
2. **全量比對**：所有門市 × 所有有資料的月份，新舊 getMonth 八大項＋待補清單完全相同
3. 所有被明細引用的附件逐檔抓到、sha256 對上（抓不到的要 Eason 逐筆核准，保留舊檔位置）
4. 手動跑一次每日更新（全部門市），連接器結果與舊端當天 06:30 一致、/pnl/health 綠（沒有 pnl_jobs_off）
5. 三條推送各手動打一次冒煙（POS `--mtd`、貨單、費用請款各一筆測試）回 ok

## 要先做的程式（我在 MacBook 上做）
| # | 做什麼 | repo |
|---|---|---|
| B1 | **合併 P0–P2**：mala-pnl-auto `pnl-native-p2` → main；dzy-minikit `pnl-p2` → main（kit 共用改動會連帶更新另外 5 支 mini app，測試已全綠）；push；`kit/bin/sync-gas.sh pnl` 正式同步。 | 兩個 |
| B2 | **app.json 改正式模式**：拿掉 mirror、readActions 照正式；`.env.example` 已備。 | dzy-minikit |
| B3 | **附件一次性搬遷工具** `apps/pnl/tools/migrate-files.js`：讀明細「附件URL」所有雲端硬碟網址 → 向舊端 `__miniFile` 逐檔要（size＋sha256 驗）→ 存成 `files/<store>/<YYYY-MM>/<新id>.<ext>` → 寫 `files/drive-map.jsonl` → 改寫明細欄為 `pnlfile:`（另存原值對照，回退用）。損益 miniBridge 的 `__miniFile` 要能從網址取 ID（`MINI_FILE_COLUMNS` 用「明細.附件URL」）。 | dzy-minikit、mala-pnl-auto |
| B4 | **全量比對工具** `apps/pnl/tools/compare.js`（C8）：mini 上跑，所有門市 × 月份，舊端（dzyProxy＋同一把金鑰）vs 新端，輸出 JSON lines＋摘要；觀察期每天跑一次（只比切換前月份）。 | dzy-minikit |
| B5 | **排程紀錄匯入**（C9）：搬家時把舊端當天已跑的每日更新寫成 `gas-import` done，mini 當晚不重跑；寫進搬遷步驟。 | dzy-minikit |
| B6 | **舊端停用模式** T21b（`PNL_DECOMMISSIONED=1`，含 google.script.run 路徑）＋ mala-fortune／schedule-watchdog 網址改讀設定（T22）＋舊網址「已搬家」頁（T23）。 | mala-pnl-auto、mala-fortune、mala-pnl.github.io |
| B7 | **P5 手冊** DEPLOY／CUTOVER／ROLLBACK（apps/pnl/），照現金帳手冊格式；退回在測試資料演練一次。 | dzy-minikit |

做完走 Fable 階段關；P6 上線前 Fable＋GPT 互盲審三塊（金額、排程推送、搬遷退回）。

## 要 Eason 做的（切換前後；每步我給可整段貼的指令並逐行核對）
1. MacBook 推損益舊端（含搬家通道與停用模式，兩者預設都不生效）：`clasp push` → `clasp redeploy`。
2. 舊 Apps Script 加指令碼屬性：`MINI_EXPORT_KEY`、`MINI_APP=pnl`、`MINI_FILE_COLUMNS`。
3. Mac mini 照 DEPLOY.md 安裝（交辦給 mini 的 Claude）：拉程式、建資料夾、填 .env、Funnel 加 `/pnl`（你說可以才加）、另外 5 支 app 跟著更新後逐支看燈。
4. 挑一個平日晚上（避開月底與 1–3 號）照 CUTOVER.md 切換，約 1 小時。
5. 觀察 3 天：每天看指揮台那一格與比對工具結果；有問題照 ROLLBACK.md 退回。

## 時程（估）
- B1–B7 程式＋審查：我這邊約 1–2 個晚上。
- 安裝：你約 30 分鐘；切換當晚約 1 小時；觀察 3 天。
