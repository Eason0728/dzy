# 損益系統搬進管理系統（財務部門）— spec v0.1

> 依據 requirements.md v1.0（含 Q1 改判）。公開 repo：不寫真名、試算表 ID、後端網址、金鑰。
> 三個 repo：dzy（本 repo）、dzy-minikit（Mac mini 平台後端與代轉）、mala-pnl-auto（損益 Apps Script＋網頁）。

## 1. 整體路徑

```
dzy 殼 modules/pnl（iframe 嵌損益網頁 ?embed=dzy）
  ⇅ postMessage  dzy-pnl-call / dzy-pnl-result / dzy-pnl-nav / dzy-pnl-ready
dzy 殼 ctx.api.call('pnl', action, payload) → POST <平台>/platform/proxy {token, ns:'pnl', action, payload}
  → mini proxyAuthorize_(token,'pnl',action)：驗身分、讀寫白名單、算等級、回 operator＋level
  → proxy-hook buildBody：{action:'dzyProxy', key:<module_secrets pnl/write>, operator, level, inner:action, payload}
  → 損益 Apps Script doPost → dzyProxy_（新檔）→ 影子帳號 → 既有 api() 原封不動處理
```

瀏覽器（含損益網頁）全程拿不到任何金鑰；損益網頁在嵌入模式下不存 token、不顯示登入。

## 2. 權限（dzy 平台）

| 權限碼 | 中文 | 對應損益角色 | 預設給誰 |
|---|---|---|---|
| `pnl.read` | 損益系統（看） | 檢視者 | 無；Eason 個別例外 |
| `pnl.write` | 損益系統（填） | 填寫者 | 財務部門（perm_map 身分預設開） |
| `pnl.admin` | 損益系統（管） | 管理者 | 無；Eason 個別例外（**鎖碼**：只有 admin 能給） |

- 三碼都進 `Perms.gs PERM_GRANTABLE`；`pnl.admin` 另進 `PERM_LOCKED`（定稿、解除定稿、設定能改連接器金鑰，比照 platform.users 等級）。`pnl.read`／`pnl.write` 不鎖（Q1 改判：財務部門自動有）。
- manifest `requires: ['pnl.read','pnl.write','pnl.admin']`；殼的 requires 是「任一符合即可」（platform/shell.js:196），view 的 requires 同。
- 等級＝三碼中最高者，由 `Auth.gs` 新函式 `proxyPnlLevel_(perms)` 算出（`admin`／`write`／`read`），只在 ns==='pnl' 時附在 proxyAuthorize_ 回傳。`proxyWithOperator_` 擴成 payroll 與 pnl 都附 operator。
- 讀寫白名單（`Auth.gs PROXY_READ_ACTIONS.pnl` ＝ `platform/dryrun.js READ_ACTIONS.pnl`，測試比對）：
  - 讀：getMonth、getTrend、getTrendMulti、getSettings、exportEntries、getAttachment
  - 寫：addEntry、voidEntry、importEntries、uploadAttachment、confirmZero、finalize、unlock、saveSettings、createDraft、refreshConnectors、refreshFixed、loadGroupUnits
  - **不代轉**：login、registerWithInvite、logout、changeMyPasscode、revokeSessions、createInvite、revokeInvite、listInvites（嵌入模式不用；舊入口過渡期照舊能用）。
  - 讀清單外要 `pnl.write` 以上（沿用 proxyAuthorize_ 既有規則）；「管」級動作（finalize、unlock、saveSettings、createDraft、refreshConnectors、refreshFixed、loadGroupUnits）由損益後端依角色擋（assertAdmin_ 等既有擋點），平台不重複判斷。
- 財務部門以外的人用個別例外開；perm_ex 不能帶參數，**可看門市**改在損益端設定（§4.3）。

## 3. Mac mini（dzy-minikit）

- `app.json proxy.backends.pnl = {urlEnv:'PROXY_URL_PNL', timeoutMs:60000}`；`.env.example` 加 `PROXY_URL_PNL=`（損益 Apps Script /exec）。
- `proxy-hook.js`：`SECRET_FIELD.pnl='key'`；buildBody pnl 分支：刪掉 payload 裡的 action／key／operator／level／inner，寫入 `{action:'dzyProxy', key, operator, level, inner:<原 action>, payload}`；沒有 operator 或 level 就拋錯（比照 payroll）。
- 金鑰：`module_secrets` 一列 `pnl/write`，工具 `set-pnl-secret.js`（照 set-payroll-secret.js，只印指紋，不備份）。同值由 Eason 貼進損益 Script Property `PNL_DZY_KEY`。
- 前端 `platform/api.js` 的 `PROXY_NS` 加 `pnl`、`PROXY_TIMEOUT_BY_NS.pnl=65000`。⚠ 這是 `platform/` 的檔：payroll 當時也改了這裡，屬「代轉清單」而非分層破壞，但仍違反「只改 registry.js 一行」字面規則 → **實作前先問 Eason 一次**（或查是否已有通用機制可免改）。

## 4. 損益 Apps Script（mala-pnl-auto，純新增為主）

### 4.1 新檔 `gas/dzyProxy.js`（函式一律 `_` 結尾，不進 publicSurface 白名單）
- `doPost` 加一個分支：`action==='dzyProxy'` → `apiDzyProxy_(req)`（既有檔唯一改動之一）。
- 驗金鑰：`PNL_DZY_KEY`，比照 `assertPosPushKey_`（HMAC＋timingSafeEqual_、未設一律 AUTH、10 分鐘 20 次鎖 10 分鐘，CacheService 鍵獨立）。
- `inner` 必須在本檔自己的白名單（＝§2 讀寫清單），否則 BAD_INPUT——第二道防線，mini 被改壞也進不來。
- `operator` 形如「姓名（DZY070）（管理系統）」；取出 `DZY\d{3}` 當影子帳號鍵，取不到 → BAD_INPUT。

### 4.2 影子帳號（讓既有 api() 一行不改）
- 使用者分頁新增／沿用一列：名稱＝`管理系統:DZY070`（固定前綴，`:` 讓一般註冊不可能撞名），角色＝level 對應（read→檢視者、write→填寫者、admin→管理者），**無通行碼雜湊**（login 必然失敗；實作時確認空雜湊的 login 路徑回 AUTH，並加測試）。
- 每次代轉：列不存在就建；角色不同就更新角色（只寫角色格）；**可看門市欄不覆蓋**。新建時可看門市＝留空（＝全部）。
- 然後用既有簽 token 函式為影子帳號簽一張短效 token（5 分鐘、只在記憶體），組 `{action:inner, token, ...payload}` 呼叫既有 `api(req)`。requireUser_、withLock_ 內的 freshUser、appendLog_、created_by 全部照舊運作，紀錄上的操作人＝`管理系統:DZY070`。
- 回應原樣回給 mini。

### 4.3 可看門市
- 「填」級預設全部門市（影子帳號新建時可看門市留空）。
- 要限定某人只看某幾家：損益管理者在既有「設定 → 使用者」改那個影子帳號的可看門市（既有畫面、既有規則）。不另做新畫面。
- ⚠ 既有規則「填寫者看不到全部合計」（userStoreScope_）。需求 §4 情境 3 只寫管理者看合計，填寫者看不到合計＝維持既有行為，不改。（若 Eason 之後要財務部的人也看合計，另議，屬商業邏輯改動。）

### 4.4 網頁嵌入模式（`gas/shell.html`＋`tools/build-pages.sh`）
- 網址帶 `?embed=dzy` 時：
  - build-pages.sh 注入的防嵌入腳本改成：embed=dzy 且 `location.ancestorOrigins[0]`（無則 document.referrer 的 origin）＝`https://dzy.mozhuting.com`（本機開發允許 `http://localhost:8777`）才不跳出；其他一律照舊跳出。
  - `callTransport_` 新增 dzy 傳輸：postMessage 給 parent `{type:'dzy-pnl-call',v:1,id,action,body}`（targetOrigin 寫死），等 `dzy-pnl-result`（只收 parent＋該 origin），逾時 70 秒。
  - 不顯示登入畫面、不存 token；角色與可看門市從第一次 `getSettings` 回應取得（既有回應若沒帶本人角色，新增欄位屬純新增）。
  - 藏自己的側欄與頂列，聽 `{type:'dzy-pnl-nav',v:1,p}` 呼叫既有 `selectTab(p)`；載入完成送 `dzy-pnl-ready`。
- 不帶 embed＝舊入口，行為完全不變（Q5 過渡兩週）。

### 4.5 舊入口退場（過渡兩週後，另一次部署）
- 舊網址 pages/index.html 換成「已搬家，請到管理系統 → 財務部門 → 損益系統」說明頁（嵌入模式那份改用另一個路徑，例如 `/embed.html`，或同檔依 embed 參數分流——實作時定）。
- 設定頁停發邀請碼、舊帳號（非 `管理系統:` 前綴、非 Eason 本人）停用。Eason 自己的舊帳號保留給試算表選單維護用。

## 5. dzy 模組 `modules/pnl`

- `manifest.js`：`id/ns/backend:'pnl'`、`name:'損益系統'`、`dept:'fin'`、`keepAlive:30*60*1000`、`requires` 見 §2、`views`＝9 個（dashboard 儀表板／pending 待補／food 食材／labor 人事／ctrl 可控／unctrl 不可控／revenue 營業收入／import 匯入／settings 設定；id 與損益 TABS 對照表放 bridge.js 並測試）。各 view 的 requires：dashboard＝任一碼；pending～import＝`pnl.write`；settings＝`pnl.admin`（殼依 view requires 藏分頁）。
- `bridge.js`：`PNL_ORIGIN`／`pnlTarget(hostname)`（本機指 mock）、`parseCall`（type、v、id、action 必須在白名單、丟掉 body 的 token／key／operator／level）、`toPageResult`、`navMessage`、`PNL_PAGES`。
- `index.js`：照 payroll（origin＋source 雙檢查、20 秒載入逾時、ready 後送 nav、onRoute 切分頁）。
- `alerts(ctx)`（Q7）：有 `pnl.write` 以上才跑；呼叫 getMonth（本月、可看的每家啟用門市；ALL 不算）取待補數，>0 回 `{level:'warn', text:'新竹光復 10 月損益還有 2 項待補', view:'pending', params:{store}}`。為了首頁不被 Apps Script 拖慢：結果在模組記憶體快取 10 分鐘，逾時或失敗就不顯示（不報錯）。
- `platform/registry.js` 一行，位置在調撥管理之後（Q8）。
- 選單圖示：`tools/make-icons.py` ICONS 加一列「pnl」→ 產 `assets/icons/pnl.png`。

## 6. 測試

- dzy：`test/pnl-module.test.mjs`（manifest、bridge 純函式、views 對照）、`proxy-authorize.test.mjs` 加 pnl 節（白名單兩邊一致、等級計算、operator）、`test/perms*` 三碼與鎖碼、e2e 新增一支（mock 代轉、點 9 個分頁、無權限看不到選單、看級只剩儀表板）。卡片數寫死的 e2e（t1／t2／t3／t4／t8）跟著改。
- minikit：`test/runner/proxy.test.js` 加 pnl 組（buildBody 覆寫、缺 operator 拋錯）。
- 損益：`test/dzyProxy.test.js`（金鑰錯／未設→AUTH、鎖定、inner 白名單、影子帳號新建與角色同步不覆蓋門市、影子帳號 login 必失敗、publicSurface 仍綠）、`node --test test/*.test.js test/ui/*.test.js`、`node test/judge_202608.js`、e2e `run.py`（嵌入模式另加一條）。
- 整合（本機）：minikit runner 跑平台複本（port 8798）＋損益 mock 後端（mock-gas.js 加 dzyProxy）＋dzy devserver 8777，Playwright 點過一輪截圖給 Eason。

## 7. 部署順序（每步先給 Eason 本機版）

1. 損益 Apps Script：push＋redeploy 既有部署（新入口，未設 `PNL_DZY_KEY` 前一律 AUTH＝對現況零影響）。
2. mini：同步平台後端（Auth.gs／Perms.gs）＋app.json／proxy-hook＋.env `PROXY_URL_PNL`＋set-pnl-secret；Eason 把同一把金鑰貼進損益 Script Property。從外網驗 `/platform/proxy` ns pnl getSettings。
3. 權限設定：財務部門身分開 `pnl.write`；Eason 給自己 `pnl.admin`。
4. dzy 前端 push main。
5. 損益網頁（嵌入模式）push mala-pnl.github.io。（**dzy 先、損益網頁後**，比照薪酬。）
6. 兩週後：舊入口退場（§4.5）。

## 8. 待決（實作前要問 Eason 或先查清楚）

1. ~~platform/api.js PROXY_NS~~：Eason 2026-10-24 准「代轉模組各在 PROXY_NS／PROXY_TIMEOUT_BY_NS 加自己的名字」（照薪酬前例；收支、調撥同適用）。
2. ~~殼的 requires 語意~~：已查，任一即可（shell.js:196）。
3. 財務部門預設開 `pnl.write` 的做法要跟收支、調撥、貨單三個模組一致（同樣走 perm_map 身分預設）。
4. 附件上傳經代轉的大小上限（mini proxy body 上限、Apps Script 上限），超過要在前端先擋。

## 9. 實作後的差異（2026-10-24，以本節為準）

- **影子帳號鍵＝`account`**（平台 proxyAuthorize_ 回的登入帳號，mini 驗 `^[A-Za-z0-9_.-]{1,40}$`，損益轉大寫）——不從 operator 反解
  （Fable 審查必修 1：姓名／帳號可含全形括號注入，冒用別人的影子帳號）。operator 只寫進損益異動紀錄。
  帳號含中文或其他符號的系統帳號進不了損益（同仁編號 DZY### 與一般英數系統帳號都可以）。
- **設定頁對影子列**：只能改可看門市；不能新增、刪除、改角色、設通行碼（Fable 必修 2：刪了會以「全部門市」重建）。
  要收回某人 → 管理系統權限設定關掉。已離職同仁的影子列會留在使用者表（無法登入、不影響存檔）。
- **「管」級動作平台也擋**：`PROXY_PNL_ADMIN_ACTIONS`（finalize、unlock、saveSettings、createDraft、refreshConnectors、refreshFixed、loadGroupUnits）要 pnl.admin。
- **金鑰錯誤不鎖**：錯一次睡 200ms（全域鎖會被任何人觸發、讓全部同仁進不了）。
- **本機上層**：只有損益頁本身跑在 localhost 時才放行 `http://localhost:任意埠`；正式網址只認 `https://dzy.mozhuting.com`。
- **mini 本文上限**：`backends.pnl.maxBodyBytes=4MB`（照片）；其他 ns 解析後仍 256KB，但讀取階段先以 4MB 收（maxInflight 10 限制總量，Fable 判可接受）。
- **頁頂同步**：損益頁自己切頁（填資料頁的類別膠囊、「前往填資料」）會送 `dzy-pnl-at`，管理系統頁頂跟著換。
- **財務部門預設**：不改 perm_map 種子；上線時在權限設定對照表加一列（總部／財務部／全部職稱／填損益）。
- **已知限制**：
  - ~~「填」級看不到全部合計~~ → Eason 2026-10-24（總控轉，原話「2A」）選 A：填寫者可看門市勾「全部門市」＝也看得到全部合計（損益 userStoreScope_；只勾個別門市仍看不到）。
  - `pnl.admin`＝損益完整管理者（含替舊網址帳號重設通行碼、改角色）；`*` 角色（系統管理者）自動有。
  - 新增的 e2e 只改了既有支數；損益模組本身的 e2e 由本機整合測試（三台伺服器、四種身分）代替，見 §10。

## 10. 本機整合測試（2026-10-24 做過）

損益假後端（mala-pnl-auto tools/dev-embed-server.js，8912）＋ mini 平台複本（kit/runner/server.js，8798，假帳號）＋ 管理系統複本（devserver，8787，config 指 8798）。
四種身分：系統管理者（管）、會計角色加 pnl.write（填）、總監角色加 pnl.read（看）、店長（無）。結果：管＝九分頁含設定、可定稿；
填＝八分頁、確認為 0 寫入成功（記成影子帳號）、定稿被平台擋；看＝只有儀表板、可看全部合計；店長＝選單沒有、硬打網址回首頁。
