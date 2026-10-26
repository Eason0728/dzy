# 收支管理（財務部門）— 規格 v0.2（2026-10-24 Eason 確認：S2 A・S3 A・S4 A）

> 依據：requirements.md（2026-10-24 Eason 確認：Q1 B・Q2 A・Q3 A・Q4 A（由 C 改回）・Q5 A・Q6 A）。
> 公開 repo：不寫真名、主機名、金鑰。確認前不寫程式。

## 0. 要 Eason 回答的（規格層才浮現的題目；原 S1「品牌沒科目時」因 Q4 改 A 已取消）

| # | 題目 | 選項 | 推薦 |
|---|---|---|---|
| S2 | 會計鎖了某月之後，店長還能不能自己解鎖 | A 不能，會計鎖的只有會計能解（店長自己鎖的照舊能自己解）／B 照舊，店長都能解 | **A** |
| S3 | 會計同仁現在掛在哪個部門 | A 財務部門（自動有權限）／B 不是（例如管理部），要你在權限設定個別加 | 事實題，請照實選 |
| S4 | platform/dryrun.js 試跑白名單准不准各加一列 | A 准（轉接型財務模組各一列，薪酬前例）／B 不准，試跑模式下打不開、測試另改 | **A** |

## 1. 範圍

**做**：管理系統新模組「收支管理」（左側 財務部門，第 2 個），四個頁頂分頁：收支明細、月結鎖定、匯出 Excel、會計科目。
**不做**：店長記帳畫面、損益連接器、稅額／冪等／作廢留痕等既有規則。

## 2. 架構決策

| 決策 | 內容 | 理由 |
|---|---|---|
| D1 模組做成管理系統原生畫面，不嵌 iframe | `modules/cashbook/` 自己畫四個分頁，直接 `ctx.api.call('cashbook', action, payload)` | 會計端畫面很小（選店選月的清單＋三個表單），iframe＋postMessage 轉接、分頁同步訊息、兩邊部署順序都省掉。與四模組約定的「走平台代轉、瀏覽器不拿金鑰」一致；只是不需要中間那層 iframe（薪酬是因為已有一整頁現成畫面才嵌） |
| D2 走平台代轉 ns `cashbook` | 瀏覽器 → 平台 `/platform/proxy` → Mac mini 本機現金帳伺服器 | 金鑰只存 mini `module_secrets`；停用帳號即收回 |
| D3 現金帳伺服器新增「管理代轉通道」 | 新金鑰 `ADMIN_SVC_KEY`（與門市營運的 `STORE_SVC_KEY` 分開），只放行管理動作 | 門市營運拿不到會計級權限；管理系統拿不到店長通道 |
| D4 匯出在瀏覽器產檔 | SheetJS mini 版從現金帳 repo 複製到 `modules/cashbook/vendor/`，按「匯出」時才載入；`buildMatrix` 移植成 ES module，格式逐欄與現金帳相同 | 現金帳 2026-09-09 已定案瀏覽器產檔（< 1 秒） |
| D5 收據照片直接顯示 | 照片網址本來就是公開隨機碼網址，清單點一筆展開時 `<img>` 縮圖＋點開原圖 | 不經代轉、不佔平台流量 |
| D6 科目維持一份共用 | 不分品牌（現狀） | Q4 A |

## 3. 權限

- 新權限碼 `cashbook.write`，中文「收支管理」。進 `PERM_GRANTABLE`。原定**不進** `PERM_LOCKED`（Q1 B）；**2026-10-25 改為進 `PERM_LOCKED`**（全資料審查 B-01：非 admin 的人資可用 permMapSave 把全集團現金帳整條職稱線開出去，與同等敏感的 `payroll.write` 不一致）。之後只有 role admin 能新增／刪除含此碼的規則、改變某人有無此碼；已開出去的權限不受影響。
- 預設：`PERM_DEFAULT_RULES` 加 `add('hq','fin','*',['cashbook.write'])`（新環境用）。**正式環境 perm_map 已初始化，改陣列不生效** → 上線步驟裡由 Eason 在「人資部門 → 權限設定」把財務部門各身分的「收支管理」打開（permMapSave，會先預覽名單）。
- 個別例外照舊可另外加人（S3 選 B 時就靠這個）。
- manifest：`id/ns/backend = 'cashbook'`、`dept: 'fin'`、`requires: ['cashbook.write']`、`keepAlive: 30*60*1000`、views＝`rows` 收支明細／`lock` 月結鎖定／`export` 匯出 Excel／`subjects` 會計科目（全部 requires cashbook.write）。
- registry.js 一行，位置在 purchase 之後、transfer 之前（四模組順序：貨單核對 → 收支管理 → 調撥管理 → 損益系統）；其他模組還沒進 registry 時就放在最後，誰後推誰 rebase。

## 4. 代轉動作（平台與 mini）

| action | 讀/寫 | 參數 | 回傳 |
|---|---|---|---|
| `adminStores` | 讀 | — | `{stores:[{code,name}]}` |
| `adminList` | 讀 | `store, month` | `{store,name,month,rows,locked,lockedBy}`（rows 含作廢列、`voidedBy`） |
| `adminLocks` | 讀 | `store` | `{store, locks:[{month,status,lockedAt,lockedBy,lockedVia}]}`（月結鎖定分頁用；只列有紀錄的月份） |
| `adminGet` | 讀 | — | `{expenseSubjects, incomeSubjects}` |
| `adminSave` | 寫 | `expenseSubjects, incomeSubjects` | `{ok}`；**代轉通道不接受改通行碼欄位**（`newStorePass/newAdminPass` 一律 BAD_INPUT） |
| `adminVoid` | 寫 | `store, id, reason(1–200字)` | `{ok}`；月份已鎖 → LOCKED |
| `adminLock` | 寫 | `store, month` | `{ok}` |
| `adminUnlock` | 寫 | `store, month` | `{ok}` |

- 兩邊白名單一致：`Auth.gs PROXY_READ_ACTIONS / PROXY_WRITE_ACTIONS` ＝ `platform/dryrun.js READ_ACTIONS / WRITE_ACTIONS`（proxy-authorize 測試比對）。
- 操作人：`proxyWithOperator_` 擴到 `cashbook`；mini `proxy-hook.js buildBody` 對 cashbook 一律覆寫 `body.operator`（姓名（帳號）（管理系統）），前端帶的 operator 無效。
- mini：`proxy-hook.js SECRET_FIELD.cashbook = 'adminKey'`；`app.json proxy.backends.cashbook = {urlEnv:'PROXY_URL_CASHBOOK', timeoutMs:20000}`；`.env PROXY_URL_CASHBOOK=http://127.0.0.1:8795/cashbook/api`（人工）；`set-cashbook-secret.js`（複製 set-payroll-secret.js）寫 `module_secrets cashbook/write`；gas/ 副本同步。前端 `platform/api.js PROXY_NS` 加 cashbook。
- 店長通道（`STORE_SVC_KEY`）與這條互不相通。

## 5. 現金帳伺服器改動（~/mala-cashbook/server，全部純新增）

1. **管理代轉通道**：config `ADMIN_SVC_KEY`（未設＝關）。dispatch 新分支：body 帶 `adminKey` → `checkKey`（沿用失敗計數）→ 只放行上表 8 個動作；`operator` 必填（≤60 字）。舊管理通行碼路徑照舊。
2. **舊管理通行碼退場開關**：config `ADMIN_LOGIN_OFF=1` → 以管理通行碼呼叫 `admin*` 一律回 `MOVED_TO_DZY`（Q2：並行兩週後才開）。前端設定頁看到這個碼顯示「會計功能已搬到管理系統 → 財務部門 → 收支管理」。
3. **欄位**（ALTER TABLE ADD COLUMN，舊資料為空）：`rows.voided_by`、`locks.locked_by`、`locks.locked_via`（`store`／`acct`）。新表 `admin_log(at, operator, action, store, month, row_id, detail)`，只追加；解鎖、作廢、改科目都寫一列。
4. **S2＝A 時**：店長通道 `unlock` 遇到 `locked_via='acct'` 回 `LOCKED_BY_ACCT`（門市營運畫面顯示「這個月是會計鎖的，請找會計解鎖」）。店長自己鎖的照舊。
5. 測試：`node --test server/test/` 新增 admin-proxy.test.js（通道只放 8 動作、無 operator 拒絕、改通行碼拒絕、作廢/鎖/解鎖寫 admin_log、LOCKED_BY_ACCT）。

## 6. 門市營運改動（~/mala-store-ops，S2＝A 時才有）

收到 `LOCKED_BY_ACCT` 顯示「這個月是會計鎖的，請找會計解鎖」。其餘不動。

## 7. 管理系統前端（~/dzy/modules/cashbook）

- `manifest.js`、`index.js`（mount/unmount/onRoute/badge 無）、`views/rows.js`、`views/lock.js`、`views/export.js`、`views/subjects.js`、`lib/matrix.js`（移植 buildMatrix）、`lib/load-xlsx.js`（動態載入 vendor）、`vendor/xlsx.mini.min.js`。
- 收支明細：上方「店別」（adminStores：現金帳裡有帳的店都列）＋「月份」（預設上個月；每月 1–10 日預設上個月，其餘當月）→ adminList → 清單（日期、科目・項目、金額、發票、狀態）；合計列（支出、收入、淨額，不含作廢）；點一列展開：照片縮圖、登記時間、作廢鈕（已鎖或已作廢時不顯示）→ ctx.ui.dialog 填原因 → adminVoid。
- 月結鎖定：選店後列最近 12 個月，各月狀態（未鎖／店長鎖／會計鎖＋誰、何時）＋鎖定／解鎖鈕（解鎖要二次確認）。
- 匯出 Excel：選店＋月份 → 讀 adminList → 檔名與欄位與現金帳現行完全相同。
- 會計科目：支出、收入兩個清單編輯（一行一個，各 1–100 個、單一名稱 30 字內），全部店共用一份。
- 試跑模式 `?dryrun=1`：寫入四動作被攔。
- 首頁提醒 `alerts()`：上個月到 10 日還沒被會計鎖的店 → 一列提醒（「新竹光復 9 月還沒月結」）。

## 8. 上線順序（前後端有相依）

1. 現金帳伺服器（mini，`git pull --ff-only`＋kickstart）：新通道預設關，對現況零影響。
2. 門市營運伺服器（mini，S2＝A 時）：顯示會計鎖的中文訊息。
3. mini 設定（Eason 輸入金鑰，Claude 不經手）：現金帳 `.env ADMIN_SVC_KEY`、平台 `set-cashbook-secret.js`（同一把）、平台 `.env PROXY_URL_CASHBOOK`；平台同步新 .gs → 重啟。驗：`curl -XPOST http://127.0.0.1:8799/platform/proxy -d '{"ns":"cashbook","action":"adminStores"}'` → 401 NO_TOKEN。
4. 推管理系統前端（main）。
5. Eason 在權限設定打開財務部門「收支管理」；會計實測一輪（看明細、作廢一筆測試帳、鎖解鎖、匯出比對舊版 Excel、改一個科目）。
6. 兩週後：現金帳 `.env ADMIN_LOGIN_OFF=1` 重啟、換管理通行碼（Eason 在設定頁或 mini 自己做）。
本機可測版：minikit runner 跑平台複本（埠 8798）＋現金帳本機伺服器（`node server/index.js`，示範資料）＋ dzy devserver 8777，先給 Eason 本機網址測。

## 9. 驗收

- node：現金帳 `node --test server/test/` 全綠；dzy `test/*.test.*` 全綠（含 proxy-authorize 白名單比對、cashbook-module 新測試、matrix 與現金帳匯出逐欄比對）。
- e2e：新增 t-cashbook（mock 平台代轉）：四分頁點得到、作廢流程、鎖定後作廢鈕消失、匯出檔可解開且列數／合計正確、沒權限的人看不到選單。
- 分層：`git diff --stat platform/` 只有 registry.js、api.js（PROXY_NS／PROXY_TIMEOUT_BY_NS 各一行，Eason 2026-10-24 在損益對話准了）、dryrun.js（S4）。
- 真瀏覽器點一次（本機整套）。

## 10. 介面契約補充（實作依據）

- 現金帳管理通道請求本文：`{action, adminKey, operator, ...參數}`；回應沿用現有 `{ok:true,...}`／`{ok:false,error}`。錯誤碼新增 `MOVED_TO_DZY`、`LOCKED_BY_ACCT`、`FORBIDDEN`（通道不放行的動作）、`BAD_INPUT`（缺 operator、帶通行碼欄位）。
- `adminList.rows[]` 多 `voidedBy`；回應多 `lockedBy`、`lockedVia`。
- 店長通道 `lock` 寫 `locked_via='store'`、`locked_by='店長'`；`adminLock` 寫 `'acct'`＋operator。已鎖時再鎖：照現狀（冪等不報錯）。
- `adminUnlock` 刪除鎖定列並寫 admin_log；`adminVoid` 對已作廢列回 `BAD_INPUT`。
- 平台 operator 字串格式沿用薪酬：`姓名（帳號）（管理系統）`。
