# 管理系統 AI 小幫手｜規格（spec）v0.1 草稿

> 依據 requirements.md v1.0（1A 2A 3A 4A 5B 6A 7C 8A 9A 10A）。等 Eason 確認第 9 節四題後改 v1.0。
> 代號格式、回傳形狀照既有 spec §4 慣例；本檔是小幫手的契約正本。

## 1. 架構總覽
```
瀏覽器（dzy 前端）
  ├─ platform/helper/（新）：右下角按鈕＋對話側欄，每頁都有
  │     └─ POST <平台主機>/platform/svc/ai-help   {op, token, ...}
  └─ modules/ai-help（新模組「小幫手管理」，資訊部門）
        └─ ctx.api.call('platform', 'aih*', …)   一般平台 action

Mac mini dzy-platform
  ├─ apps/dzy-platform/aihelp.js（新，node）：驗身分→限流→組提示→呼叫 Claude→記錄
  │     ├─ gas('aiHelpAuthorize_', token)   驗 token＋取本人狀況（3A 範圍）
  │     ├─ gas('aihKbLive_')                取已上架知識庫
  │     └─ gas('aihLogAppend_', row)        寫問答紀錄
  └─ apps-script/platform/AiHelp.gs（新，.gs）：上面三支全域函式＋管理頁 action
外部：api.anthropic.com（claude-haiku-5-5）、通知匣
```
- .gs 不能連外（kit/gasshim/services.js:15 UrlFetchApp 不支援），所以 AI 呼叫一定在 node。
- 掛法照 `lineauth.js`：`createAiHelp({gas, cfg, dataDir, …})` 回 `routes: {'ai-help': handle}`，併進 `jobs.js:534` routes。
- **不用工具呼叫（tool use）**：B 需要的本人資料在呼叫 AI 前一次查好放進提示。AI 沒有任何能動手的工具 → 被同仁的問題誘導也做不了事。

## 2. 前端：浮動按鈕與對話側欄（平台層，Eason 1A 同意）
- 新資料夾 `platform/helper/`：`widget.js`（畫按鈕與側欄）、`client.js`（打 svc 路由）、`helper.css`。
- `shell.js` 只加兩件事：登入後 `mountHelper(shellEl, {getRoute, can, alerts})`；登出時 `unmountHelper()`。其他 platform 檔不動。
- `getRoute()` 回 `{m:<模組 id>, v:<分頁 id>}`（目前網址）；`alerts()` 回殼已算好的首頁提醒文字陣列（沒有就空陣列，不另打後端）。
- 開頁時打一次 `op:'status'`：回 `{on:false}` 或額度用完 → 按鈕不出現（或顯示「本月額度已用完」）。
- 側欄：輸入框（最多 300 字）、對話紀錄（只在記憶體，關掉頁面就沒了）、每則答案下 👍／👎、「帶我去」按鈕、底部小字「問答會記錄 90 天，用來改進小幫手」。
- 「帶我去」：只接受 `{m,v}`；前端先用 `isViewPermitted` 檢查，沒權限就不畫按鈕；按下只做 `location.hash = '#/'+m+'/'+v`。
- 手機（≤860px）：按鈕放在下排選單上方，側欄改全螢幕。
- 對話上下文：每次送最近 3 組問答（只有文字）。

## 3. svc 路由 `/platform/svc/ai-help`
請求一律 POST、text/plain JSON、body ≤ 8KB、Origin 只收 `https://dzy.mozhuting.com`（＋.env `AIH_DEV_ORIGINS`）。回 `{ok, data}` 或 `{ok:false, code, error}`。

| op | 誰能用 | 輸入 | 輸出 |
|---|---|---|---|
| status | 任何已登入 | token | `{on, left_today}` |
| ask | 任何已登入 | token, q, page{m,v}, alerts[], history[{q,a}]≤3 | `{id, kind:'answered'|'unknown', answer, go:[{m,v,label}], who}` |
| feedback | 本人 | token, id, good:true/false | `{}` |
| draft | `platform.aihelp` | token, pending_id | `{question, answer, who, m, v}`（AI 擬答，不上架） |

**ask 流程**
1. `AIH_ON` 不是 `'1'` → `{code:'off'}`。
2. 限流（落盤 `~/dzy-platform-data/aih-rate.json`，照 line-auth-rate.json 寫法）：每人每天 20 題（台北日）、全站每分鐘 60 題；超過回 `rate_person`／`rate_global`。
3. 月額度：本月累計 ≥ `AIH_MONTH_CAP_USD`（預設 30）→ `{code:'cap'}`；第一次跨過 80% 與 100% 各送通知匣一次。
4. `gas('aiHelpAuthorize_', token)` → 失敗回 401。
5. 組提示（第 4 節）→ 呼叫 Claude（逾時 20 秒、不重試）。
6. 驗輸出：`go` 每筆的 m/v 必須在 `pages.json`（第 5 節），不在就刪掉。
7. `gas('aihLogAppend_', …)`（寫失敗不影響回答，記 health）。
8. 錯誤（逾時、網路、HTTP 錯、額度不足）→ 回 `{kind:'error', answer:'小幫手暫時無法回答，請稍後再試'}`，不計入每日題數。

## 4. 給 AI 的內容（只送這些）
- **固定段（可快取）**：規則＋全部已上架知識庫＋頁面地圖（pages.json 的中文名）。規則要點：只能根據知識庫與「你的帳號狀況」回答；沒寫到的回 `kind:'unknown'`，不准猜；用繁體中文白話；不要提系統代號；`who` 從知識庫「找誰」欄挑。
- **每題段**：目前頁面中文名、首頁提醒文字、本人狀況（第 6 節）、最近 3 組問答、問題。
- **不送**：姓名、員工編號、手機、生日、地址、token、任何金鑰。
- 輸出用結構化格式（`output_config.format` JSON schema）：`{kind, answer(≤600字), go[≤2], who, kb_ids[]}`。
- 模型 `claude-haiku-5-5`，`.env AIH_MODEL` 可覆寫；金鑰 `.env ANTHROPIC_API_KEY`（**另開一把**，Console 名 `dzy-aihelp-mini`，Console 花費上限設 30 美元）。

## 5. 頁面地圖 pages.json
- `tools/gen-aihelp-pages.mjs` 讀 `platform/registry.js` 各 manifest，產 `[{m, v, name, view_name, dept, requires[]}]`。
- 產物放 `apps-script/platform/AiHelpPages.gs`（`AIH_PAGES = [...]`），跟其他 .gs 一起 sync 到 mini——不必多一條同步管道。
- 測試比對：產物要等於現行 registry（加模組忘了重產 → 測試紅）。

## 6. 本人狀況 `aiHelpAuthorize_(token)`（全域函式，不進 Code.gs 分派表）
沿用 `authResolveSession_`。回：
```
{ ok:true,
  who:{ uid, role },                          // uid 只給 node 記錄用，不送 AI
  me:{ kind:'staff'|'system', status, unit_name, dept_name, title_name,
       extra_dept_names[], acting_unit_names[], staff_add_unit_names[] },
  perms:[{ name_zh, source_zh }] }           // 來自 handleMyPerms_ 的 items
```
- 系統帳號（非 staff）：`me` 只有 kind 與 role 的中文名。
- 不含：phone、生日、地址、p_* 待審欄位、打卡、班表、薪資。
- 測試要釘住：輸出的鍵只能是上面這些（白名單，多一個就紅）。

## 7. 資料表（平台試算表新分頁，`aihSetup` 建表，只補不覆蓋）
| 分頁 | 欄位 |
|---|---|
| `aih_kb` 知識庫 | id、m、v（可空＝通用）、question、answer、who（找誰）、go_m、go_v、status（draft／live／off）、updated_at、updated_by |
| `aih_log` 問答紀錄 | id、ts、uid、m、v、q、kind、answer、kb_ids、tok_in、tok_out、usd、feedback |
| `aih_pending` 待回答 | id、log_id、ts、q、m、v、reason（unknown／thumbs_down）、status（open／done／ignored）、kb_id |

- 每天 03:50 刪 90 天前的 `aih_log`（`aih_pending` 結案後一併刪 q 原文）。
- 備份：`aih_kb` 照常備份；`aih_log`、`aih_pending` 是否排除備份見第 9 節第 4 題（推薦排除，比照 login_log：問題原文可能含同仁自己打的個資）。

## 8. 管理頁 `modules/ai-help`「小幫手管理」（資訊部門，requires `platform.aihelp`）
- 分頁：待回答 pending／知識庫 kb／用量 usage。
- 待回答：列 open 題目（問題、在哪頁、幾次）；「AI 擬答」→ svc `draft` → 帶入編輯框 → 「上架」＝寫 `aih_kb` live＋把 pending 標 done；「略過」＝ignored。
- 知識庫：搜尋、編輯、下架。
- 用量：本月花費／上限、每日題數、答得出來比例、👎 比例。
- 首頁提醒 `alerts()`：「小幫手有 N 題待回答」。
- 權限 `platform.aihelp`：新 PERM_GRANTABLE、**鎖碼**（只有 admin 能給）；Eason 是 admin 不用設。
- 平台 action（Code.gs 分派表＋dryrun.js）：讀 `aihKbList`、`aihPendingList`、`aihUsage`；寫 `aihKbSave`、`aihPendingSet`、`aihSetup`、`aihKbImport`。

## 9. 要 Eason 確認的四題
1. 知識庫放哪裡改？**推薦：放管理頁（試算表分頁）**，你直接在系統裡上架；另一個做法是放程式碼檔，每次改要我推版。
2. 每日彙整幾點進通知匣？**推薦：跟通知匣 10:00 那則一起**（09:20 送進去，10:00 一起彙整）。
3. 初始知識庫怎麼來？**推薦：我照「一般同仁會碰到的頁面」先寫約 60 題（登入、改密碼、首頁、我的資料、公告、打卡、考勤申請、排班、各主管功能），你在管理頁一次看過、勾選上架**；沒勾的不上。
4. 問答紀錄要不要進每日備份？**推薦：不進**（同仁可能在問題裡打個資，跟登入紀錄一樣不備份；90 天自動刪）。

## 10. 上線順序
1. mini：`AiHelp.gs`＋`AiHelpPages.gs`＋`aihelp.js` 上線，`AIH_ON` 不設（=關）。驗：`op:'status'` 回 on:false。
2. dzy 前端：按鈕程式上線（status 關 → 不出現）＋管理模組。
3. admin 按「初始化小幫手」（aihSetup）＋匯入初始知識庫 → Eason 勾選上架。
4. mini `.env` 寫 `ANTHROPIC_API_KEY`（Eason 在 mini 用 `read -rs`）、`AIH_ON=1` → 重啟。
5. Eason 自己問 5 題確認 → 通知大家。
- 緊急關：mini 刪 `AIH_ON` 那行重啟（按鈕下次開頁就消失）。

## 11. 測試
- `test/ai-help.mock.test.mjs`（沿用 staff.mock 的 SRC＋load＋vm）：aiHelpAuthorize_ 白名單、各身分輸出、鎖碼權限、pending／kb 寫入、90 天清除。
- minikit `test/apps/aihelp.test.js`：Origin、限流、月額度 80%／100%、go 驗證、Claude 逾時／錯誤、log 失敗不影響回答（Claude 用假伺服器，不打真的）。
- e2e `e2e_t21_ai_helper.py`：按鈕出現／關閉時不出現、問答、帶我去（有權限才有按鈕）、👎 進待回答、管理頁上架；手機寬。
- 上線前資料帶入測試：用初始知識庫＋30 題真實問法（Eason 確認題目）實打一次 Haiku，量每題字詞與費用（**會花錢，約 NT$5 內，先問 Eason**）。
