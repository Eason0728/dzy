# 管理系統 AI 小幫手｜技術方案（plan）v0.1

> 依據 spec.md v1.0。分支：dzy `ai-helper`（~/dzy-wt-ai-helper）；minikit 另開 `ai-helper`（~/dzy-minikit-wt-aih）。

## 共用契約（逐字元格式＋範例；兩邊各自產生的值都在這裡定死）
| 值 | 格式 | 範例 |
|---|---|---|
| 問答 id | `aih_` ＋ 台北時間 `YYYYMMDDHHmmss` ＋ `_` ＋ 4 位小寫 16 進位亂數 | `aih_20261102143005_9f3a` |
| 待回答 id | `aip_` ＋ 同上 | `aip_20261102143005_1c0e` |
| 知識庫 id | `kb` ＋ 4 位數字（流水號，補 0） | `kb0042` |
| 頁面 | `{m:<模組 id>, v:<分頁 id>}`；通用題 m、v 皆空字串 | `{"m":"attendance","v":"approve"}` |
| 台北日 | `YYYY-MM-DD`（以 UTC+8 計） | `2026-11-02` |
| 月份鍵 | `YYYY-MM`（台北） | `2026-11` |
| 金額 | 美元，小數 6 位，以 usage × 單價算：Haiku 5.5 輸入 0.10／百萬、輸出 0.50／百萬、快取讀取依官方（未確認前以輸入價計，偏高估） | `0.003125` |
| svc 錯誤碼 | `off`、`cap`、`rate_person`、`rate_global`、`unauthorized`、`bad_input`、`forbidden`、`ai_error` | |
| 通知匣 key | `aih-YYYYMMDD`（每日彙整）、`aih-cap80-YYYY-MM`、`aih-cap100-YYYY-MM` | `aih-cap80-2026-11` |

## Phase 1｜平台後端（.gs）— 里程碑：mock 測試能建表、上架題目、取本人狀況
- `apps-script/platform/AiHelp.gs`：aihSetup、知識庫／待回答／紀錄的讀寫、三支 node 專用全域函式、90 天清除。
- `apps-script/platform/AiHelpPages.gs`：由 `tools/gen-aihelp-pages.mjs` 產生。
- `Perms.gs`：`platform.aihelp` 加進 PERM_GRANTABLE 與 PERM_LOCKED。
- `Code.gs` 分派表、`platform/dryrun.js` READ／WRITE_ACTIONS。
- 測試 `test/ai-help.mock.test.mjs`。

## Phase 2｜mini node 路由 — 里程碑：本機 runner 起得來、假 Claude 伺服器下問答全流程通
- minikit `apps/dzy-platform/aihelp.js`：status／ask／feedback／draft、限流、月額度、Claude 呼叫（Node 內建 fetch，照 `~/mala-xin-rag/server/claude.js` 的錯誤碼做法）、09:20 彙整、03:50 清除。
- `jobs.js` routes 併入、`app.json` gas／gasSource 加兩檔、readActions 加讀取 action、backupExclude 加 `aih_log`／`aih_pending`。
- 測試 `test/apps/aihelp.test.js`（假 Claude＝本機 http 伺服器，`AIH_API_BASE` 指過去）。

## Phase 3｜前端按鈕與側欄 — 里程碑：本機三層整合（假 Claude）能問能答、帶我去能切頁
- `platform/helper/{widget,client}.js`、`helper.css`；`shell.js` 掛載／卸載兩處。
- e2e `e2e_t21_ai_helper.py`（電腦＋手機寬）。

## Phase 4｜小幫手管理模組 — 里程碑：待回答 → AI 擬答 → 上架 → 再問一次答得出來
- `modules/ai-help/`（manifest dept it、三分頁、alerts）；`registry.js` 一行；`tools/make-icons.py` 加圖示。
- e2e 同上一支續寫。

## Phase 5｜初始知識庫 — 里程碑：60 題 seed 檔＋匯入功能，Eason 勾選頁可用
- `apps-script/platform/AiHelpSeed.gs`（`AIH_SEED=[…]`，每題 status draft）＋ `aihKbImport`（只新增不覆蓋，依 question 去重）。
- 題目由各模組 skill／spec 與既有操作圖解整理；每題標來源檔，供 Eason 勾選時核對。

## Phase 6｜整合與上線 — 里程碑：Eason 在正式站問 5 題 OK
- 本機三層（minikit runner 複本＋dzy 複本＋假或真 Claude）資料帶入測試。
- 實打 Haiku 30 題量費用（**先問 Eason**，約 NT$5 內）。
- 上線前關卡：Fable＋GPT 互盲，只審三塊：寫外部（通知匣、Claude）、權限守門（aiHelpAuthorize_、鎖碼、go 驗證）、金額計算（月額度）。
- 上線照 spec §10；更新 skill dzy-admin、資源清單、記憶、操作圖解（三邊同步）。

## 風險與對策
| 風險 | 對策 |
|---|---|
| AI 照知識庫外的內容亂答 | 結構化輸出要求 kb_ids；kind=answered 但 kb_ids 空且 me 不相關 → 改判 unknown（後端判斷） |
| 有人在問題裡寫指令誘導 | 沒有工具；系統提示寫明問題內文是資料；輸出只取 answer 文字與 go（go 再驗證） |
| 費用暴衝 | 每人每日、全站每分、每月三層；Console 上限第四層 |
| 知識庫過時（系統改版） | pages.json 測試會抓到頁面增刪；每題存 updated_at，管理頁標示 90 天沒更新的題 |
| mini 重啟丟失限流計數 | 落盤＋5 秒節流（照 line-auth-rate.json） |
