# 規格：調撥管理（會計專區搬進財務部門）

版本：v1.1 / 2026-10-24（Eason 已確認：Q6 api.js 兩行＋dryrun.js 讀寫各一列、Q7＝A 會計操作紀錄）
上游：`requirements.md` v0.2（Eason 2026-10-24 已答 Q1–Q5）。契約沿用 `~/dzy/docs/spec.md §4`，本檔不重抄。
公開 repo：本檔不寫密碼、金鑰、Web App 網址、試算表 ID、真名。

## 0. 探到、會改變設計的事
| 事實 | 證據 | 設計因此 |
|---|---|---|
| 會計頁所有後端呼叫只有一個出口 `post(action,payload)`，且已有 `window.__LOCAL_BACKEND__` 掛點 | mala-transfer `src/report.html:155-161` | 嵌入模式只換這一個函式，畫面程式不動 |
| 會計密碼只存在頁面變數 `PIN`，每次請求都帶 | `report.html:148,170` | 嵌入模式 `PIN` 留空、不顯示密碼閘；密碼由 mini 代轉時補上 |
| 會計密碼連錯計數是**全域一個 key**，5 次鎖 10 分鐘，鎖定期間連正確密碼也擋 | `Code.gs:1366-1376` | 代轉一律帶正確密碼不會累加；但換密碼時 mini 與試算表要在同一段停機內一起換（§7），否則全公司（含門市刪已簽收單）一起被鎖 |
| `adminOverview` 接受會計密碼（不計連錯） | `Code.gs:804-808,1256` | 卡關總覽分頁可直接走同一把密碼代轉，不用另開總部帳號 |
| 品項記憶改名／刪除、產月報**都不留紀錄** | `Code.gs:1643-1701,1411` | 調撥後端純新增「會計操作紀錄」（§5，Q7＝A） |
| 代轉新 ns 前端要改 `platform/api.js` 的 `PROXY_NS`／`PROXY_TIMEOUT_BY_NS`，以及 `platform/dryrun.js` 讀寫清單 | `api.js:50-51`、`dryrun.js:15,41` | 與「platform/ 只改 registry.js」衝突；薪酬當時也改了。四個財務模組一起請 Eason 決定（§9-Q6，損益對話代問） |
| 權限預設可依部門給（perm_map 規則 dept 欄）；`permInit_` 只在空表時寫種子 | `Perms.gs:32-41,157,206` | 種子加一列給新環境；正式環境由 Eason 在「權限設定 → 財務部門」打開開關（§6） |

## 1. 架構
```
會計瀏覽器 dzy.mozhuting.com
  └ modules/transfer-fin（殼的頁頂分頁：月報｜品項記憶｜卡關總覽）
      └ iframe：調撥系統 report.html?embed=dzy（GitHub Pages）
           ├ 子→母 dzy-transfer-ready / dzy-transfer-call {id,action,payload}
           └ 母→子 dzy-transfer-nav {p} / dzy-transfer-result {id,ok,data|error}
      ctx.api.call('transfer', action, payload)
        → POST /platform/proxy {token, ns:'transfer', action, payload}
Mac mini dzy-platform
  proxyAuthorize_：驗 token、要 transfer.write、白名單、回 operator
  proxy-hook buildBody：刪 payload 的 pin_master/token/operator，補 pin_master（module_secrets transfer/write）、補 operator；adminUpdate 只放行 op=memoryEdit|memoryDelete
    → 調撥 Apps Script /exec（正本，橋接版）
```
與薪酬管理同一形態；貨單核對走入場券，兩種並存（requirements §6）。

## 2. 前端模組 `modules/transfer-fin/`（dzy）
- `manifest.js`：`id:'transfer-fin'`、`ns:'transfer'`、`backend:'transfer'`、`name:'調撥管理'`、`dept:'fin'`、`icon:'transfer'`（tools/make-icons.py 加一列）、
  `keepAlive: 30*60*1000`、`requires:['transfer.write']`、
  `views:[{id:'report',name:'月報'},{id:'memory',name:'品項記憶'},{id:'overview',name:'卡關總覽'}]`（皆 requires transfer.write）。
- `bridge.js`（純函式，比照 payroll/bridge.js）：`TRANSFER_ORIGIN`（https://eason0728.github.io）、`transferTarget(hostname)`（localhost→`http://localhost:8787/report.html?embed=dzy`）、
  `parseCall(msg)`（驗 type/v/id/action 字串；**刪 payload 的 pin_master、token、operator、action**）、`toPageResult`、`TRANSFER_PAGES`（＝manifest views id，測試比對）、`navMessage(p)`。
- `index.js`：比照 payroll——mount 建 iframe＋20 秒載入逾時；onMessage 第一行驗 `e.origin===target.origin && e.source===frame.contentWindow`；ready 後送 nav；onRoute 只送 nav；unmount 移監聽。
- `platform/registry.js` 加一行（排在 payroll 之後；財務部門內順序由 dept 群組＋registry 先後決定，四個模組依「貨單核對→收支管理→調撥管理→損益系統」的 registry 先後排，誰後推誰 rebase）。
- Q6 已定（Eason 2026-10-24，損益對話轉達）：`platform/api.js` PROXY_NS 加 `'transfer'`、PROXY_TIMEOUT_BY_NS `transfer: 65000`；`platform/dryrun.js` READ_ACTIONS／WRITE_ACTIONS 各加一列 transfer（收支對話 S4 准）。一模組一行，誰後推誰 rebase；**其他 platform/ 檔不動**。

## 3. 代轉白名單（Auth.gs ＝ dryrun.js，逐字相同）
| 類 | action | 說明 |
|---|---|---|
| 讀 | `bootstrap` | 節點、類別、差異原因（品項記憶需密碼才回，代轉帶了） |
| 讀 | `adminData` | 解鎖後的品項記憶等 |
| 讀 | `adminOverview` | 卡關總覽 |
| 讀 | `getDoc` | 卡關總覽點一張單看明細 |
| 寫 | `buildMonthlyReport` | 寫月報分頁（同月覆蓋） |
| 寫 | `adminUpdate` | **mini hook 再限 op**＝memoryEdit／memoryDelete；其他 op（wipeData、deleteConfig、reason*）一律拒絕 `OP_FORBIDDEN` |

- `proxyWithOperator_` 擴到 ns transfer（同 payroll 格式「姓名（帳號）（管理系統）」）。
- `pickSecrets_` 永不含 transfer（同 payroll）。
- 試跑模式：讀取照常（月報、品項記憶、卡關總覽看得到），buildMonthlyReport、adminUpdate 被攔。

## 4. 調撥會計頁 `report.html` 嵌入模式（mala-transfer，公開 repo）
- 判斷：網址帶 `?embed=dzy` 且 `window.parent!==window`。否則**完全照舊**（舊網址並行兩週）。
- `post()`：嵌入時改成 postMessage `dzy-transfer-call` 給 `https://dzy.mozhuting.com`（本機 `http://localhost:8777`），等對應 id 的 `dzy-transfer-result`，逾時 70 秒；只收 `e.origin` 為該母頁且 `e.source===window.parent`。
- 畫面：藏 header 與 `#gate`，直接進解鎖後狀態（呼叫 adminData 取資料）。三張卡依 nav 切換：report→`#rptCard`、memory→`#admCard`、overview→新 `#ovCard`。
- 卡關總覽：把門市版 `loadOverview／ovRow／ovNodeBlock／ovFeedRow／renderOverview`（index.html:1484-1581）與相依 `esc`、`money`、CSS 搬進 report.html；點一列改成用既有 `#pop` 彈窗顯示 `getDoc` 的唯讀明細（單號、狀態、調出→調入、品項、應撥／實收、異動紀錄），**不搬 openDoc**、不放任何動作鈕。逾期天數只顯示後端給的數字。
- 下載 Excel：沿用 Blob＋`<a download>`；e2e 要實測在 iframe 內下載得到（payroll 匯出同形態）。
- 嵌入時不顯示「洽詢 Eason」等密碼文案；build-web.js 既有密碼防呆照跑。
- Q2 過渡期滿：非嵌入模式改成「已搬家，請到管理系統 → 財務部門 → 調撥管理」說明頁（另一次 push）。

## 5. 調撥後端純新增：會計操作紀錄（Q7＝A，Eason 2026-10-24 確認）
- 新分頁「會計操作紀錄」：時間｜操作人｜動作（產月報／品項改名／品項刪除）｜內容（年月＋門市／舊名→新名）。HEADERS 只在新分頁，`ensureSheets_` 自動建，bump `SCHEMA_V`。
- `buildMonthlyReport`、`adminUpdate` memoryEdit／memoryDelete 在**成功之後**追加一列；`operator` 欄位沒帶（舊網址直接用）就記「會計專區」。
- 不寫進「異動紀錄」：那張是單據紀錄，卡關總覽的「今日異動」讀它，混進去會多出沒有單號的列。
- 部署走橋接流程（`~/mala-transfer-bridge`：cp Code.gs → paste-gate --verify → push → redeploy 既有部署 ID），五支 mock 測試＋新增守門測試。

## 6. 權限
- `Perms.gs`：`PERM_GRANTABLE` 加 `transfer.write`（**不列 PERM_LOCKED**，Q1＝B）、標籤「調撥管理」；`PERM_DEFAULT_RULES` 加 `add('hq','fin','*',['transfer.write'])`（新環境種子）。
- 正式環境：perm_map 已有資料、種子不會補 → 上線後由 Eason 在「權限設定 → 財務部門」打開「調撥管理」開關（儲存前會列出名單）。其他部門的人用「個別例外」加。
- 四個財務模組一致：perm_map 財務部門那列開 `<模組>.write`。

## 7. Mac mini（minikit `apps/dzy-platform`）
- `app.json` `proxy.backends.transfer = { urlEnv:'PROXY_URL_TRANSFER', timeoutMs: 60000 }`（月報 3–4 秒，Apps Script 偶發卡 12–60 秒）。
- `proxy-hook.js`：`SECRET_FIELD.transfer='pin_master'`；buildBody 對 transfer 先刪 payload 的 pin_master／token／operator 再補；adminUpdate 的 op 白名單；operator 必有。
- `module_secrets` 加 `transfer/write` 一列：把 `set-payroll-secret.js` 參數化成 `set-proxy-secret.js <ns>`（或另寫一支），沿用「停機中才寫、不印值、只印指紋」；調撥密碼是純數字，**不套薪酬的 ≥16 字規則**，但要比對 minikit 假試算表「像數字的字串轉數字」——讀出一律 `String()`。
- `.env` 加 `PROXY_URL_TRANSFER`（調撥 /exec）；`.env.example`、`PROXY.md` 補一節。
- ⚠ 代轉會把回應裡出現的密碼字串遮成 `***`（kit 既有保護）。本機試用時用純數字假密碼「2026」曾把日期遮掉、年月欄變空白（2026-10-26 實測）。所以**新會計密碼要含英文字母**，不要用日期、金額、單號裡可能出現的純數字。
- **換密碼程序（Q2 期滿）**：停 dzy-platform → 試算表「設定」改 pin_master → set-proxy-secret 寫新碼 → 啟動 → 管理系統實測月報 → 新碼交給需要的人（門市刪已簽收單、總部總覽）。順序顛倒或漏一邊＝代轉帶錯碼，5 次後全公司鎖 10 分鐘。

## 8. 測試
- dzy：`test/transfer-fin-module.test.mjs`（manifest 合規、parseCall 刪密碼欄、TRANSFER_PAGES＝views）；`test/proxy-authorize.test.mjs` 新增一節（讀寫清單 Auth.gs＝dryrun.js、transfer.write 可給且非鎖碼、無權限 FORBIDDEN、operator 格式、金鑰不外流）；e2e 新一支（mock 代轉：三個分頁切換、產月報、下載、背景保留）。
- 加預設規則會改到寫死的數字：`test/perms.mock`、`perms-actions.mock`、`storeops.mock` 的規則總數（2026-10-24 為 26）與財務同仁權限清單；四個財務模組各加一條，誰後 rebase 誰改數字（貨單核對對話提醒）。
- minikit：proxy.test.js 加 transfer（補密碼、刪前端夾帶的 pin_master、op 白名單拒 wipeData）。
- mala-transfer：五支 mock 測試；verify-ui.py 加嵌入模式區段（假母頁 postMessage）；§5 守門測試（成功才記、失敗不記、沒 operator 記「會計專區」）。
- 整套本機：mala-transfer `mock/server.js`（8787，/api 跑真 Code.gs）← minikit runner 複本（8798，`PROXY_URL_TRANSFER=http://127.0.0.1:8787/api`，module_secrets 填 mock 密碼）← dzy devserver 8777（config 指 8798）。⚠ e2e t10 也用 8798，跑 e2e 前先關。

## 8b. 部署順序（每步都不影響舊網址）
1. 調撥後端 §5（純新增，舊會計頁照用）。
2. mini：app.json／proxy-hook／.env／module_secrets → 重啟；外網驗 `/platform/proxy` ns transfer 對無 token 回 401。
3. 平台後端 Auth.gs／Perms.gs（sync-gas --i-know → mini pull → 重啟）。
4. dzy 前端 push main（**MacBook 上由 Eason 按**）。
5. 調撥 report.html 嵌入模式 push（web/ repo）。
6. Eason 打開「權限設定 → 財務部門 → 調撥管理」；會計實測月報、下載、品項記憶、卡關總覽；通知大家 Cmd+Shift+R。
7. 兩週後：舊網址改說明頁＋§7 換密碼。

## 9. Eason 決定紀錄
| # | 題目 | 選項 | 推薦 |
|---|---|---|---|
| Q6 | ✔ 已定：`platform/api.js` 兩行＋`platform/dryrun.js` 讀寫各一列＋registry.js 一行，其他 platform/ 檔不動 | — | — |
| Q7 | ✔ 已定：A，調撥後端純新增「會計操作紀錄」分頁 | — | — |
