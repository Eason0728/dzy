# 薪酬管理依負責門市分權限 — 規格 v0.1（待 Eason 確認）

> 依據：`requirements.md` v0.1（Eason 2026-10-28 確認，Q1 A・Q2 A・Q3 A）。
> 公開 repo：不寫真名、主機名、金鑰。
> 涉及三個 repo：dzy（平台＋模組）、dzy-minikit（Mac mini 代轉）、mala-clock-in（薪資後端 Payroll.gs＋薪資頁 payroll.html）。

## 0. 架構一句話

平台在代轉時算出「這個人負責哪些薪資門市」（`scope`），Mac mini 把它**強制寫進**送往薪資後端的請求（跟現在的 operator 同一招），
**薪資後端依 scope 擋請求、裁回應**；薪資頁依 scope 只顯示負責門市、藏起集團功能。

為什麼擋在薪資後端而不是 Mac mini：只有薪資後端知道每支回應的形狀（run／item／stores…），
在 Mac mini 逐支寫裁切器，回應一改就會漏資料或刪光資料（審查員第 4 點）。
薪資後端只認管理金鑰，而管理金鑰換新後只有 Mac mini 有（Q1 A），所以 scope 欄位只有平台能決定。

## 1. 負責門市怎麼存（dzy 平台）

- 沿用個別例外（`perm_ex` 分頁），新碼 **`payroll.store@<薪資店代碼>`**，一家一列。比照 `att.view@<單位>`：
  - 驗證 regex：`PERM_PAYROLL_STORE_RE = /^payroll\.store@([A-Z0-9]{2,12})$/`（Perms.gs，放在 PERM_ATT_VIEW_RE 旁）。
  - 只認 mode `add`；不進 PERM_GRANTABLE；`permCompute_` 對它比照 att.view@ 只走例外。
  - **只有 role admin 能新增／撤銷**：`permAcExAuth_` 現行規則已經如此（人資主管只能動 STORE_HR_GRANTABLE 三碼），補測試釘住。
  - 平台**不驗證代碼是否存在於薪資門市表**（平台讀不到那張表）；打錯的代碼不會對應到任何門市，無害。前端在勾選時提供正確清單（見 §5）。
- 進入權（D1）：不新增程式。上線時 Eason 在權限設定把「總部・財務部・全部職稱 → 薪酬管理」打開（payroll.write 是鎖碼，只有 admin 能開）。
  兼任財務部照 permCompute_ 既有規則。

## 2. 平台代轉（dzy `Auth.gs`）

- `proxyWithOperator_` 對 ns `payroll` 多回 **`scope`**：
  - role admin（或 perms 含 `*`）→ `'*'`
  - 其他 → perms 中所有 `payroll.store@X` 的 X 組成的陣列（排序去重，可為空陣列）
- 讀寫白名單不變（PROXY_READ_ACTIONS／PROXY_WRITE_ACTIONS.payroll＝dryrun.js，維持 proxy-authorize 測試比對）。
- `test/proxy-authorize.test.mjs` 新增：admin→'*'；財務同仁兩筆例外→兩碼；沒例外→[]；撤銷的例外不算；其他 ns 不帶 scope。

## 3. Mac mini 代轉（dzy-minikit）

- `kit/runner/proxy.js`：從授權結果取 `scope`，傳給 `hook.buildBody({..., scope})`（同 level／account 的做法，約 217–225 行；文件註解補一行）。
- `apps/dzy-platform/proxy-hook.js buildBody`：ns `payroll` 時 `delete body.scope`，再寫入 `body.scope = scope`；
  **scope 不是 `'*'` 也不是字串陣列 → throw**（fail closed，比照 operator 必填）。其他 ns 一律刪掉 body.scope 不帶。
- 測試：瀏覽器自帶 `scope:'*'` 會被覆寫；缺 scope 會被擋；cashbook 等其他 ns 不受影響。

## 4. 薪資後端（mala-clock-in `apps-script/Payroll.gs`）

在 payroll 路由分派前加一道 **`payScopeGuard_(action, body)`**，回應出口加 **`payScopeTrim_(action, body, res)`**。計算規則一行不動。

### 4.1 scope 的語意

| body.scope | 意思 |
|---|---|
| 沒有這個欄位 | 舊路（直接持管理金鑰，例如舊 `?k=` 連結或本機對帳腳本）→ 照現行行為，不限制 |
| `'*'` | 系統管理者 → 不限制 |
| 字串陣列 L | 只能碰 L 裡的門市；L 可為空 |
| 其他形狀 | 回 `{ok:false, error:'scope_bad'}` |

> 「沒有欄位＝不限制」是為了部署順序與本機工具；安全性靠換管理金鑰（§8 第 5 步）——換完之後只有 Mac mini 持有金鑰，而 Mac mini 一定會帶 scope。

### 4.2 L 為陣列時的請求規則（payScopeGuard_）

`st = payStore(body.store)`（空白→SSLGF，與現行一致）。違規一律回 `{ok:false, error:'scope_forbidden', detail:<原因>}`。

| action | 規則 |
|---|---|
| `payroll_group`、`payroll_store_set`、`payroll_holiday_sync` | 一律擋（集團功能，D5） |
| `payroll_get` | 一律擋（全集團結果；前端已無呼叫者） |
| `payroll_config_set` | `body.store` 原值必須非空（空白＝集團預設），且 `st ∈ L` |
| `payroll_leave_type_set` | `body.store` 原值必須非空（空白＝集團共用），且 `st ∈ L` |
| `payroll_master_set` | `st ∈ L`，且每一列的 `payStore(m.store || st) ∈ L`（Q3 A：換店要兩家都負責） |
| `payroll_store_get` | 放行，回應裁切（4.3） |
| 其餘白名單 action（讀 9 支、寫 7 支） | `st ∈ L` |
| 不在上表也不在代轉白名單的 action | 照現行（代轉白名單已先擋掉） |

L 為空陣列時，所有動作都會因 `st ∉ L` 被擋（除 `payroll_store_get` 回空清單、`payroll_master_get` 見 4.3）。

### 4.3 L 為陣列時的回應裁切（payScopeTrim_）

- `payroll_master_get`、`payroll_month`、`payroll_store_get`：`stores` 只留 `code ∈ L` 的列，且**刪掉 `clock_ss_id` 欄**。
  - `payroll_master_get` 在 L 為空時改成不擋，回 `{ok:true, stores:[], master:[], config:{}, scope:[]}`，讓薪資頁能顯示「尚未指派」（§6）。
- `payroll_master_get` 一律多回 **`scope`**（`'*'`／L／沒欄位時回 `'*'`），給薪資頁判斷要不要藏集團功能。
- 其他單店動作回應已依 `body.store` 過濾，不必裁。`payroll_leave_type_get` 的集團共用列照舊回（唯讀、計算顯示要用）。

### 4.4 測試（mala-clock-in `tests/payroll-scope.test.js`，沿用既有切片載入 Payroll.gs 的方式）

- 23 支白名單動作逐一：L=['CF'] 帶 store SSLGF → scope_forbidden；帶 CF → 照常。
- 4.2 的特殊列逐條（集團預設、集團假別、master 換店到 L 外、換店兩家都在 L 內放行）。
- 4.3 裁切：stores 只剩 L、沒有 clock_ss_id；L=[] 時 master_get 回空殼。
- 沒有 scope 欄位與 `'*'`：結果與改動前逐欄相同（拿 git 基準版跑同一份資料比對，照 skill 的 engine-diff 做法）。
- 破壞驗證：拿掉 guard 一行，至少要紅在「帶 L 外門市」那組。

## 5. 權限設定畫面（dzy `modules/perms/views/ex.js`）

- 個別例外新增時，權限下拉多一項「薪酬：負責門市」。選它後出現**門市下拉**，清單由前端用 `ctx.api.call('payroll', 'payroll_store_get', {})` 取得
  （只有 admin 會看到這個選項，admin 的 scope 是 '*'，拿得到完整門市表；顯示「名稱（代碼）」，停用的標「停用」）。
  取不到清單時允許手動輸入代碼（顯示「無法讀取薪資門市清單」）。
- 一次送一家（沿用單選元件與 permExSave），要負責多家就新增多筆——不做多選元件。
- 例外清單顯示成「薪酬負責門市：墨竹亭金山（MZTJS）」；`lib.js` 加 `PAYROLL_STORE_PREFIX`／`payrollStoreCode()`，比照 `attViewCode`。
- 人資主管看不到這個選項（permExList 只對 admin 回）。

## 6. 薪資頁（mala-clock-in `payroll.html`）

只在嵌入模式（`EMBED`）且 `master_get.scope` 是陣列時生效；舊 `?k=` 與 `'*'` 完全照舊。

- `scope` 為空陣列：整頁只顯示「尚未指派負責門市，請洽系統管理者」，不發其他呼叫。
- 門市選單：`STORE_LIST` 已由後端裁切；若 `pay_store`（localStorage）或 `?store=` 指到不在清單的門市，改用清單第一家並覆寫 `pay_store`。
- **不呼叫 `syncHol()`**（payroll_holiday_sync 會被擋；後端算薪時找不到紅字天數會自己同步，不受影響）。
- 參數設定（#p-cfg）：藏「門市設定」區（#storeTbl／#saveStoreBtn 那塊）與紅字天數卡的「同步」按鈕（紅字表照樣顯示）；
  四張參數卡的「只套用到目前門市」（#cfgOwn／#attOwn／#ptOwn／#coOwn）**強制勾選並鎖住**；假別 #ltOwn 同樣強制勾選鎖住。
- 「集團總覽」：薪資頁內也藏 nav `data-p=group`，並且不呼叫 `loadGroup`（切店時現在會觸發）。
- 被後端回 `scope_forbidden` 時顯示「這家門市不在你的負責範圍」，不當成一般錯誤重試。

## 7. 管理系統頁頂分頁（dzy `modules/payroll/manifest.js`）

- `group`（集團總覽）那個 view 的 requires 改成 **`['payroll.admin']`**：這個碼沒有人會被給（不在 PERM_GRANTABLE、不在規則裡），
  只有 role admin 的 `*` 會通過 → 財務同仁的頁頂看不到「集團總覽」。其他 10 個 view 不變。
  （manifest-check 要求碼的前綴＝ns，`payroll.admin` 符合；test/payroll-module.test.mjs 補斷言。）
- views[0] 仍是 dash（requires payroll.write），進模組的權限不變。

## 8. 部署順序（任何時刻 Eason 都進得去、薪資頁都有選單）

1. **薪資後端**（Payroll.gs，clasp push → version → redeploy 既有部署 ID，絕不 deploy）。此時沒人帶 scope → 行為完全不變。
   探針：錯金鑰仍回 unauthorized；用管理金鑰帶 `scope:['ZZ']` 打 `payroll_month` → 回 scope_forbidden（證明新版生效）。
2. **平台後端＋Mac mini**：dzy 只推 apps-script 那個 commit → `sync-gas.sh dzy-platform --i-know`（先比對 minikit gas/ 與 dzy main，只差自己的檔才整包 sync）→ minikit（proxy.js、proxy-hook.js）合併 → mini pull＋重啟 dzy-platform。
   此後 admin 帶 `'*'`、其他人帶 L。**這一刻起，Eason 以外已開薪酬的人會變成「尚未指派」**（目前名單上線前先列給 Eason，Q2）。
3. **dzy 前端**（權限設定的門市選項、manifest 集團總覽改 requires）推 main。
4. **薪資頁**（payroll.html）推 mala-clock-in main（GitHub Pages）。2～4 之間薪資頁還是舊版：財務同仁看得到集團總覽分頁，但按下去後端回 scope_forbidden，不會外洩。
5. **Eason 在權限設定**：①打開「總部・財務部・全部職稱 → 薪酬管理」②逐人新增「薪酬：負責門市」③撤銷非財務部同仁的薪酬個別例外（Q2，名單由 Claude 先列）。
6. **換管理金鑰**（Q1 A），照 mala-payroll skill「換一把要同步改五個地方」＋第 6 處 mini `set-payroll-secret.js`。
   ⚠ 會連動 mala-fortune 的 `CLOCK_ADMIN_KEY_GF` secret（指揮台新進人員統計）。換完舊 `?k=` 連結失效。
7. 驗收：用一個財務同仁測試帳號（或 Eason 暫時以個別例外試）逐項檢查 §9。

推 main（dzy、mala-clock-in）與 clasp 會被 auto mode 擋，交給 Eason 在 MacBook 執行；minikit 可直接推。

## 9. 驗收清單

- [ ] 財務同仁只負責 CF：門市選單只有央廚；頁頂沒有集團總覽；參數卡「只套用到目前門市」鎖住勾選；門市設定與紅字同步看不到。
- [ ] 同一人用瀏覽器主控台送 `store:'SSLGF'` 的 payroll_month／payroll_master_set／payroll_calc → 全部 scope_forbidden。
- [ ] 送 `payroll_group`、`payroll_get`、`payroll_store_set`、`payroll_holiday_sync`、集團預設 config → 全部擋。
- [ ] 回應裡找不到 `clock_ss_id`、找不到 CF 以外的門市代碼。
- [ ] 財務同仁沒被指派任何門市 → 只看到「尚未指派」。
- [ ] 非財務部、沒有個別例外的同仁 → 左側沒有薪酬管理。
- [ ] Eason（admin）→ 與現在完全相同（8 家門市、集團總覽、門市設定、紅字同步）。
- [ ] 人資主管在權限設定看不到「薪酬：負責門市」選項。
- [ ] 換金鑰後舊 `?k=` 連結顯示「已搬進管理系統」或驗證失敗；指揮台新進人員統計照常。

## 10. 風險與已知取捨

- 薪資頁跟著 scope 改 UI，但**防線在後端**；頁面藏東西只是體驗，不是安全邊界。
- 「沒有 scope 欄位＝不限制」在第 6 步換金鑰前是一個洞（持舊金鑰者仍可看全部）——就是 Q1 要換金鑰的原因，第 6 步不能拖。
- `payroll_master_set` 換店的既有行為（舊店列可能殘留）不在本案修。
- 假別表「不勾＝集團共用」本來就沒作用（後端不讀 scope_own），本案只把勾選框鎖住，不修那個既有問題。
