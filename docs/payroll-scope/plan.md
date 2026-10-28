# 薪酬管理依負責門市分權限 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 財務同仁進薪酬管理只看得到、只操作得到自己負責的門市；集團功能只有系統管理者能用。

**Architecture:** 平台代轉算出 `scope`（`'*'` 或薪資店代碼陣列）→ Mac mini 把它強制寫進請求 `body.scope` → 薪資後端 Payroll.gs 依 scope 擋請求、裁回應 → 薪資頁依 `master_get.scope` 調整畫面。負責門市存成個別例外 `payroll.store@<代碼>`。

**Tech Stack:** Google Apps Script（Payroll.gs、平台 .gs 在 Mac mini 執行器上跑）、Node.js（minikit runner、node 測試）、原生 JS ES module 前端、Playwright e2e（不在本案範圍內新增）。

**基底分支：** 三個 repo 都從 `payroll-staff-sync`（差異清單，Eason0728/dzy#52、mala-clock-in#11、dzy-minikit#38）開分支；那三個 PR 合併後改 rebase 到 main。

**Spec:** `docs/payroll-scope/spec.md`（需求 `docs/payroll-scope/requirements.md`）

## Global Constraints

- 薪資計算規則一行不動（payCalcOne 及所有計算函式）。
- body.scope 語意：沒有欄位＝不限制；`'*'`＝不限制；字串陣列＝只限那些門市；其他形狀＝`{ok:false, error:'scope_bad'}`。
- 違規回 `{ok:false, error:'scope_forbidden', detail:'<原因>'}`。
- 負責門市碼：`payroll.store@<代碼>`，regex `/^payroll\.store@([A-Z0-9]{2,12})$/`，只認 mode add，只有 role admin 能新增／撤銷。
- 管理系統頁頂「集團總覽」view requires `['payroll.admin']`。
- 公開 repo（dzy、mala-clock-in）：不寫真名、主機名、金鑰；測試用假代碼與假人。
- dzy 改後端只改 `apps-script/platform/*.gs`，同步到 minikit 用「只套自己改動」做法（不整包 sync-gas，除非比對後只差自己的檔）。
- Payroll.gs 部署：clasp push → version → redeploy 既有部署 ID，絕不 `clasp deploy`。
- 推 dzy main、mala-clock-in main、clasp 由 Eason 在 MacBook 執行；minikit 可直接推。

## Review Focus

1. **沒帶 store 的請求**：payStore('') 會變 SSLGF；只負責 CF 的人不帶 store → 必須被擋（Task 1 測試 `noStore`）。
2. **小寫或含空白的門市代碼**（`'cf'`、`' CF '`）：比對一律走 payStore 正規化後再比，不能因為大小寫繞過或誤擋（Task 1 測試 `caseNorm`）。
3. **scope 被序列化成字串**（`'["CF"]'` 或 `'*'` 以外的字串）：必須回 scope_bad，絕不能當成不限制（Task 1 `scopeShape`、Task 4 hook 測試）。
4. **localStorage `pay_store` 或 `?store=` 指到沒負責的門市**：頁面改用清單第一家，不發出會被擋的請求（Task 2 測試 `staleStore`）。
5. **系統管理者 `'*'` 的回應與改動前完全相同**（含 stores 的 clock_ss_id、所有門市）：Task 1 測試 `starIdentical` 拿 git 基準版比對。

---

### Task 1: 薪資後端 scope 守門與回應裁切（mala-clock-in）

工作目錄：`git -C ~/mala-clock-in worktree add ../mala-clock-in-wt-scope -b payroll-scope origin/payroll-staff-sync`（本機主資料夾在別的分支，不要在那裡改）。

**Files:**
- Modify: `apps-script/Payroll.gs`（`/* ═════ Handlers` 標記之後、`const PAYROLL_HANDLERS = {` 之前加 guard 函式；在 `PAYROLL_HANDLERS` 定義之後一行包裝）
- Test: `tests/payroll-scope.test.js`（新檔，沿用 `tests/input-store-isolation.test.js` 的 vm 載入 Code.gs＋Payroll.gs、假 payRead／payReplaceAll 做法）

**Interfaces:**
- Produces:
  - `payScopeOf_(body) -> null | '*' | string[] | 'BAD'`（null＝沒欄位；陣列元素經 payStore 正規化）
  - `payScopeGuard_(action: string, body: object) -> null | {ok:false, error, detail}`
  - `payScopeTrim_(action: string, body: object, res: object) -> object`
  - `payScopeWrap_(handlers: object) -> void`（就地把每個 handler 換成 guard → 原 handler → trim）
  - `PAY_SCOPE_ADMIN_ONLY = ['payroll_group','payroll_store_set','payroll_holiday_sync','payroll_get']`
  - `payroll_master_get` 回應多 `scope` 欄（`'*'` 或陣列）

- [ ] **Step 1: 寫失敗測試** `tests/payroll-scope.test.js`，至少這些案例（L＝`['CF']`）：
  - `crossStore`：代轉白名單 23 支（從 dzy `apps-script/platform/Auth.gs` 的 PROXY_READ/WRITE_ACTIONS.payroll 抄成常數；`payroll_store_get` 除外）帶 `store:'SSLGF', scope:L` → `error==='scope_forbidden'`；帶 `store:'CF'` → 不是 scope_forbidden。
  - `adminOnly`：PAY_SCOPE_ADMIN_ONLY 四支帶 `store:'CF', scope:L` → scope_forbidden。
  - `groupDefault`：`payroll_config_set {store:'', scope:L}`、`payroll_leave_type_set {store:'', scope:L}` → scope_forbidden。
  - `masterMove`：`payroll_master_set {store:'CF', scope:['CF'], master:[{emp_id:'X1', store:'SSLGF'}]}` → scope_forbidden；`scope:['CF','SSLGF']` → 放行。
  - `noStore`：`payroll_month {scope:L}`（無 store）→ scope_forbidden。
  - `caseNorm`：`{store:'cf', scope:L}` → 放行；`scope:['cf']` 對 `store:'CF'` → 放行。
  - `scopeShape`：`scope:'["CF"]'`、`scope:{}`、`scope:[1]`、`scope:'all'` → `error==='scope_bad'`。
  - `trim`：`payroll_master_get` 與 `payroll_month` 與 `payroll_store_get` 在 scope:L 時 `stores.every(s=>s.code==='CF')` 且 `stores.every(s=>!('clock_ss_id' in s))`；master_get 回 `scope` 深等於 `['CF']`。
  - `emptyScope`：`scope:[]` 時 `payroll_master_get` 回 `{ok:true, stores:[], master:[], scope:[]}`（config 為 `{}`）；`payroll_month` → scope_forbidden。
  - `starIdentical`：同一份假資料，`scope:'*'` 與沒有 scope 欄位，對 23 支讀寫的回應（除 master_get 多的 scope 欄外）JSON 完全相同；且 master_get 的 stores 含 clock_ss_id。

- [ ] **Step 2: 跑測試確認失敗** `node tests/payroll-scope.test.js` → 失敗（payScopeGuard_ 未定義）。

- [ ] **Step 3: 實作** 上面 Interfaces 的五個名字。規則照 spec §4.2／§4.3：先 `payScopeOf_`，`'BAD'`→scope_bad；null／'*'→放行不裁；陣列→`st = payStore(body.store)`，依 action 套表；`payroll_config_set`／`payroll_leave_type_set` 檢查 `String(body.store||'').trim()` 非空；`payroll_master_set` 逐列 `payStore(m.store || body.store)`。`payroll_master_get` 在空陣列時不呼叫原 handler，直接回空殼。trim 對陣列 scope 過濾 `stores` 並刪 clock_ss_id；master_get 一律加 `scope`（null 時填 `'*'`）。

- [ ] **Step 4: 跑新測試＋全部既有測試**
  Run: `for f in tests/*.test.js; do node "$f" >/dev/null || echo "FAIL $f"; done; node tests/payroll-scope.test.js`
  Expected: 沒有任何 FAIL 行。

- [ ] **Step 5: 破壞驗證** 暫時把 `payScopeWrap_(PAYROLL_HANDLERS)` 那行註解掉，跑 `node tests/payroll-scope.test.js` → 必須紅在 crossStore／adminOnly；復原後再全綠。

- [ ] **Step 6: Commit**
```bash
git add apps-script/Payroll.gs tests/payroll-scope.test.js
git commit -m "feat(payroll): 依 body.scope 擋門市、裁門市清單（管理系統負責門市權限）"
```

---

### Task 2: 薪資頁依 scope 調整畫面（mala-clock-in）

**Files:**
- Modify: `payroll.html`（boot() 讀 master_get 之後、renderStoreSel、syncHol 呼叫點、loadGroup 觸發點、#p-cfg 門市設定區與紅字同步鈕、#cfgOwn／#attOwn／#ptOwn／#coOwn／#ltOwn、錯誤顯示）
- Test: `tests/payroll-scope-front.test.js`（新檔，比照 `tests/dzy-embed.test.js` 從 payroll.html 抽函式實跑）

**Interfaces:**
- Consumes: Task 1 的 `master_get.scope`、`error:'scope_forbidden'`
- Produces（payroll.html 內的全域）：
  - `let SCOPE = '*'`（boot 後設為 master_get.scope；非嵌入模式恆為 `'*'`）
  - `scopeLimited() -> boolean`（EMBED 且 Array.isArray(SCOPE)）
  - `pickScopedStore(list: object[], wanted: string) -> string`（wanted 在 list 內就回 wanted，否則回 list[0].code，空清單回 ''）
  - `applyScopeUi() -> void`

- [ ] **Step 1: 寫失敗測試**：
  - `staleStore`：`pickScopedStore([{code:'CF'},{code:'MZTJS'}], 'SSLGF') === 'CF'`；`pickScopedStore([{code:'CF'}], 'CF') === 'CF'`；`pickScopedStore([], 'CF') === ''`。
  - `limitedFlag`：EMBED=true、SCOPE=['CF'] → `scopeLimited()===true`；SCOPE='*' → false；EMBED=false、SCOPE=['CF'] → false。
  - `noHolSync`：抽出 boot 中 syncHol 的呼叫條件，scopeLimited 時不呼叫（以字串檢查 `if (!scopeLimited()) syncHol(` 存在於 boot 內即可，並以 vm 實跑 boot 的假 post 計數驗證 `payroll_holiday_sync` 次數為 0）。
  - `emptyMsg`：SCOPE=[] 時 applyScopeUi 後頁面主內容含文字「尚未指派負責門市，請洽系統管理者」。
  - `ownLocked`：scopeLimited 時五個勾選框 `checked===true && disabled===true`。

- [ ] **Step 2: 跑測試確認失敗** `node tests/payroll-scope-front.test.js`。

- [ ] **Step 3: 實作**：boot 收到 master_get 後設 SCOPE；SCOPE 為空陣列 → 顯示「尚未指派負責門市，請洽系統管理者」並停止 boot 後續呼叫；STORE 用 pickScopedStore 決定並寫回 `pay_store`；scopeLimited 時：不呼叫 syncHol、不呼叫 loadGroup、藏 nav `data-p=group`、藏門市設定區與 #holSync、五個勾選框強制勾選＋disabled。post 收到 `scope_forbidden` 時顯示「這家門市不在你的負責範圍」。

- [ ] **Step 4: 跑全部測試** `for f in tests/*.test.js; do node "$f" >/dev/null || echo "FAIL $f"; done` → 沒有 FAIL。另跑 `node tests/page-handlers.test.js` 確認 on* 呼叫的函式都有定義。

- [ ] **Step 5: 本機手測**：`MOCK_PORT=8911 python3 mock/mock_server.py` 開 `http://localhost:8911/payroll.html`（非嵌入）→ 畫面與改動前相同（門市設定、紅字同步都在）。

- [ ] **Step 6: Commit**
```bash
git add payroll.html tests/payroll-scope-front.test.js
git commit -m "feat(payroll.html): 嵌入時依負責門市只顯示該店、藏集團功能"
```

---

### Task 3: 平台負責門市碼與代轉 scope（dzy 後端）

工作目錄：`~/dzy-wt-payscope`（分支 payroll-scope）。

**Files:**
- Modify: `apps-script/platform/Perms.gs`（PERM_ATT_VIEW_RE 旁加 PERM_PAYROLL_STORE_RE；permCompute_ 例外處理比照 att.view@；permValidateEx_ 加分支）
- Modify: `apps-script/platform/PermActions.gs`（若 permAcExAuth_ 需補明確判斷；permExList 對 admin 回 `payroll_store_prefix` 不必——前端自取清單）
- Modify: `apps-script/platform/Auth.gs`（proxyWithOperator_ 對 ns payroll 加 `scope`）
- Test: `test/proxy-authorize.test.mjs`（第 13 節後加 13h～13l）、`test/perms.mock.test.mjs`（新節）

**Interfaces:**
- Produces:
  - `PERM_PAYROLL_STORE_RE = /^payroll\.store@([A-Z0-9]{2,12})$/`
  - `permPayrollStoresOf_(perms: string[]) -> string[]`（取出代碼，排序去重）
  - `proxyAuthorize_(token,'payroll',action).scope`：`'*'`（role admin 或 perms 含 `*`）或 `string[]`

- [ ] **Step 1: 寫失敗測試**：
  - perms.mock：admin 新增例外 `{emp_no:'DZY101', perm:'payroll.store@CF', mode:'add'}` → 成功；`payroll.store@cf`、`payroll.store@`、`payroll.store@A B` → 驗證錯誤；mode remove → 驗證錯誤；人資主管新增 `payroll.store@CF` → 被拒；該同仁 permCompute_ 結果含 `payroll.store@CF`；例外撤銷後不含；`until` 已過期不含。
  - proxy-authorize 13h：admin 打 payroll → `scope==='*'`；13i：財務同仁有 payroll.write＋兩筆例外 CF、MZTJS → `scope` 深等於 `['CF','MZTJS']`；13j：沒例外 → `[]`；13k：audit／cashbook 回傳沒有 scope 欄；13l：無 payroll.write 仍 FORBIDDEN（不因有 payroll.store@ 就放行）；13m：`payrollStaffRoster {store:'SSLGF'}` 對只負責 CF 的財務同仁回 scope_forbidden、`{store:'CF'}` 放行、admin 任何門市都放行（本測試寫在 `test/payroll-staff-roster.test.mjs`）。

- [ ] **Step 2: 跑測試確認失敗** `node test/proxy-authorize.test.mjs; node test/perms.mock.test.mjs`。

- [ ] **Step 3: 實作** Interfaces 列的名字與規則（spec §1、§2）。

- [ ] **Step 4: 跑全部 node 測試**
  Run: `for f in test/*.test.js test/*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
  Expected: 沒有 FAIL（若有既有已知失敗，先在 main 上跑同一支確認是既有的）。

- [ ] **Step 5: Commit**（只含 apps-script 與後端測試，方便日後拆兩段推）
```bash
git add apps-script/platform/Perms.gs apps-script/platform/PermActions.gs apps-script/platform/Auth.gs test/proxy-authorize.test.mjs test/perms.mock.test.mjs
git commit -m "feat(platform): 薪酬負責門市個別例外 payroll.store@，代轉回傳 scope"
```

---

### Task 4: Mac mini 代轉傳遞 scope（dzy-minikit）

工作目錄：`git -C ~/dzy-minikit worktree add ../dzy-minikit-wt-scope -b payroll-scope origin/payroll-staff-sync`。

**Files:**
- Modify: `kit/runner/proxy.js`（取授權結果的 scope，傳給 buildBody；頂部文件註解補一行）
- Modify: `apps/dzy-platform/proxy-hook.js`（buildBody 解構 scope；ns payroll 覆寫 body.scope、形狀不合 throw；其他 ns 刪 body.scope）
- Modify: `apps/dzy-platform/gas/Perms.gs`、`gas/Auth.gs`、`gas/PermActions.gs`（只套 Task 3 的改動，`git diff` 從 dzy 分支 apply）＋`gas/SOURCE.sha256` 改那幾行＋`node kit/tools/render-docs.js dzy-platform`
- Test: `test/runner/proxy.test.js`（payroll 那段後加案例）

**Interfaces:**
- Consumes: Task 3 的 `scope`
- Produces: 送往薪資後端的 body 一定有 `scope`（`'*'` 或字串陣列）

- [ ] **Step 1: 寫失敗測試**：
  - `buildBody({ns:'payroll', action:'payroll_month', payload:{scope:'*', store:'CF'}, secret:'S', operator:'甲', scope:['CF']}).scope` 深等於 `['CF']`（瀏覽器自帶的被覆寫）。
  - scope 為 `undefined`、`'all'`、`[1]` → buildBody throw。
  - `buildBody({ns:'audit', ..., payload:{scope:'*'}, scope:'*'})` 結果沒有 scope 欄。
  - 整合段（現有 T-PAY 假上游）：授權回傳加 `scope:['CF']`，上游收到的 body.scope 深等於 `['CF']`。

- [ ] **Step 2: 跑測試確認失敗** `node --test test/runner/proxy.test.js`（照該檔現有執行方式）。

- [ ] **Step 3: 實作**（spec §3）。

- [ ] **Step 4: 跑全部測試** `npm test`；Expected：除既有環境失敗（mini 上固定 7 項；本機以 main 跑同一指令的結果為基準）外沒有新失敗。比對 gas：`cd apps/dzy-platform && shasum -a 256 -c gas/SOURCE.sha256` 全 OK，且 `cmp` 三個 .gs 與 `~/dzy-wt-payscope/apps-script/platform/` 相同。

- [ ] **Step 5: Commit**
```bash
git add kit/runner/proxy.js apps/dzy-platform/proxy-hook.js apps/dzy-platform/gas test/runner/proxy.test.js apps/dzy-platform/*.md
git commit -m "feat(proxy): 薪酬代轉強制帶 scope（負責門市）"
```

---

### Task 5: 權限設定畫面與集團總覽分頁（dzy 前端）

**Files:**
- Modify: `modules/perms/lib.js`（PAYROLL_STORE_PREFIX、payrollStoreCode、payrollStoreOf；例外顯示名稱）
- Modify: `modules/perms/views/ex.js`（權限下拉多「薪酬：負責門市」，選了顯示門市下拉，清單用 `ctx.api.call('payroll','payroll_store_get',{})`，失敗改手動輸入）
- Modify: `modules/payroll/manifest.js`（group view requires `['payroll.admin']`）
- Test: `test/perms-front.test.mjs`、`test/payroll-module.test.mjs`

**Interfaces:**
- Consumes: Task 3 的碼格式；Task 1 的 payroll_store_get 回應 `{ok, stores:[{code,name,active,...}]}`
- Produces: `payrollStoreCode(code: string) -> string`（`' cf '`→`'payroll.store@CF'`，不合格回 `''`）、`payrollStoreOf(perm: string) -> string`

- [ ] **Step 1: 寫失敗測試**：
  - perms-front：`payrollStoreCode('CF')==='payroll.store@CF'`、`payrollStoreCode(' mztjs ')==='payroll.store@MZTJS'`、`payrollStoreCode('A B')===''`、`payrollStoreCode('')===''`；`payrollStoreOf('payroll.store@CF')==='CF'`、`payrollStoreOf('att.view@ck')===''`。
  - payroll-module：`manifest.views.find(v=>v.id==='group').requires` 深等於 `['payroll.admin']`；其他 10 個 view 仍是 `['payroll.write']`；`validateManifest(manifest)` 沒有錯誤；views 的 id 順序仍等於 bridge.js PAYROLL_PAGES。

- [ ] **Step 2: 跑測試確認失敗**。

- [ ] **Step 3: 實作**（spec §5、§7）。「薪酬：負責門市」選項只在 permExList 回應顯示為 admin 時出現（比照 att_view_units 只對 admin 回的判斷方式）。

- [ ] **Step 4: 跑全部 node 測試與 e2e**
  Run: `for f in test/*.test.js test/*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done` → 無 FAIL；
  `lsof -nP -iTCP:8798` 無人佔用後 `./test/e2e/run_all.sh > /tmp/e2e.log 2>&1; echo exit=$?` → `exit=0` 且最後一行是「全部通過」。

- [ ] **Step 5: Commit**
```bash
git add modules/perms modules/payroll/manifest.js test/perms-front.test.mjs test/payroll-module.test.mjs
git commit -m "feat(perms,payroll): 權限設定可勾薪酬負責門市；集團總覽分頁只給系統管理者"
```

---

### Task 6: 本機三層整合實測＋上線交辦

**Files:**
- Create: `docs/payroll-scope/release.md`（上線步驟＝spec §8 展開成可貼的指令；mini 交辦、Eason 在 MacBook 要按的指令、探針、回退）
- Modify: `docs/payroll-scope/progress.md`（新檔，記錄每步狀態）

**Interfaces:**
- Consumes: Task 1～5 全部

- [ ] **Step 1: 起本機三層**（照 dzy-admin skill「薪酬管理 → 本機整套測」）：minikit runner 跑 app 複本（gas 換 Task 3 的 .gs、port 8798、.env `PROXY_URL_PAYROLL=http://127.0.0.1:8911/`、`GAS_PROP_PERMS_ON=1`）＋ mala-clock-in worktree `MOCK_PORT=8911 python3 mock/mock_server.py`（mock 要能吃 body.scope：確認 mock_server 走的是同一份 Payroll.gs 或補轉發）＋ dzy 複本 config 指 8798、devserver 8777。
- [ ] **Step 2: 實測三種身分並截圖**（Playwright，存 scratchpad）：admin → 8 家／集團總覽在；財務同仁勾 CF → 只有央廚、無集團總覽、參數勾選鎖住；財務同仁沒勾 → 「尚未指派」。在財務同仁頁面用 `window.postMessage` 送 `store:'SSLGF'` 的 payroll_month → 收到 scope_forbidden。
- [ ] **Step 3: 列出正式環境目前有 payroll.write 個別例外的人**（唯讀，permExList 或 perm_ex 分頁；只給 Eason 看代號＋單位，不進 repo）。
- [ ] **Step 4: 寫 release.md**：順序＝①Payroll.gs clasp（探針：管理金鑰帶 `scope:['ZZ']` 打 payroll_month 回 scope_forbidden）②dzy 只推 Task 3 commit → minikit gas 只套改動＋proxy 合併 → mini pull＋stop.sh／start.sh 重啟 dzy-platform（探針：不帶 token 打 /platform/api 的回應句子先 grep 確認）③dzy 前端推 main ④mala-clock-in 推 main（輪詢 `payroll.html?t=亂數` 含 `scopeLimited`）⑤Eason 權限設定三件事 ⑥換管理金鑰（照 mala-payroll skill 五處＋set-payroll-secret.js）；每步附回退。
- [ ] **Step 5: Commit**
```bash
git add docs/payroll-scope/release.md docs/payroll-scope/progress.md
git commit -m "docs(payroll-scope): 上線步驟與進度"
```
