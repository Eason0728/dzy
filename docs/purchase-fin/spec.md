# 貨單核對搬進財務部門 — 規格（契約正本）

依 requirements.md（Eason 2026-10-24 確認）。三個 repo：dzy（前端模組＋平台後端 .gs）、dzy-minikit（app.json）、mala-purchase（貨單後端＋網頁）。

## 1. 流程

```
dzy 前端（已登入、有 platform.purchase）
  └ 模組 purchase：iframe 開 <貨單網頁>/review.html?embed=dzy
       貨單網頁沒有有效的嵌入 token → postMessage {type:'dzy-purchase-ready',v:1} 給 parent
  └ 模組收到（只認 origin＝貨單網頁 origin 且 source＝該 iframe）→ ctx.api.call('purchase','ssoTicket',{aud:'purchase'})
       → postMessage {type:'dzy-purchase-sso',v:1,ticket}（targetOrigin 寫死）
  貨單網頁 → POST <貨單後端>/sso {ticket}
  貨單後端 → POST 平台 svcPurchaseRedeem {svc_key, ticket, aud:'purchase'} → 身分 → 對到 users.dzy_sub → 發 session
```
登入 token 不離開管理系統；券 60 秒、一次性；服務金鑰只在兩台本機服務之間（瀏覽器拿不到）。

## 2. 平台後端（apps-script/platform）

- `Perms.gs`：`PERM_GRANTABLE` 加 `platform.purchase`（**不鎖碼**，Eason 2026-10-24）；`PERM_NAMES` 名稱「貨單核對」；`PERM_DEFAULT_RULES` 第 27 條 `hq／fin／*／platform.purchase`（新環境 permInit 寫入；正式環境由 Eason 在權限設定打開財務部門的開關）。
- `StaffClock.gs`：`SSO_AUDS` 加 `purchase`；`handleSsoTicket_` aud `purchase`：`hasPerm_(perms,'platform.purchase')` 否則 `no_perm`；sub＝`purchaseSubForUser_(user)`；rec `{sub, aud}`。
- 新檔 `PurchaseSso.gs`：
  - `purchaseSubForUser_(user)`：role staff 且 staff 列 active、DZY 編號相符 → `DZY###`；role 非 staff → `'U:'+id`；其他 ''（`no_emp`）。
  - `purchaseIdent_(sub)` → `{sub, active:false}` 或 `{sub, active:true, allowed, name, emp_no, token_after}`。
    allowed＝用跟 session 相同的 `authStaffGate_`＋`authPermsAndScope_` 算出來的 perms 有 `platform.purchase`（admin `*` 也算）。users 停用、staff 非 active、gate.block → active:false。
  - `handleSvcPurchaseRedeem_ {svc_key,ticket,aud}`：金鑰 Script Property `PURCHASE_SVC_KEY`；LockService 包住 cache get＋remove（先取出就作廢）；回 `purchaseIdent_(rec.sub)`。
  - `handleSvcPurchaseWho_ {svc_key,sub}`：回 `purchaseIdent_(sub)`。
  - 錯誤碼：`unauthorized`、`bad_aud`、`ticket_invalid`、`bad_input`、`busy`。
- `Code.gs`：白名單與分派加 `svcPurchaseRedeem`、`svcPurchaseWho`。**ssoTicket／svcPurchase* 永遠不可列進 minikit readActions 與 dryrun READ_ACTIONS 的服務動作**（重放＝券能用兩次）。
- minikit `apps/dzy-platform/app.json`：gas／gasSource 加 PurchaseSso.gs；props 加 `PURCHASE_SVC_KEY`。

## 3. dzy 前端模組 `modules/purchase/`

- manifest：`id:'purchase'`、`ns/backend:'platform'`、`name:'貨單核對'`、`dept:'fin'`、`icon:'purchase'`、`keepAlive:30 分`、`requires:['platform.purchase']`（財務部門預設有）、`dynamicTabs:true`、views 只有 `main`。
- `embed.js`：照 storeops 的 embed（訊息名 `dzy-purchase-*`）。貨單網頁位址：正式 `https://dzy-bulletin.github.io/dzy-purchase/`；管理系統跑在 localhost／127.0.0.1 時改用 `http://localhost:8795/`（本機測試用）。
- 頁頂分頁（Q4-A，九個）：貨單網頁送 `{type:'dzy-purchase-nav',v:1,items:[{id,label,badge}],cur}` → `ctx.tabs()`；點分頁送 `{type:'dzy-purchase-go',v:1,id}`；收到選單回 `{type:'dzy-purchase-tabs',v:1}`。卸載送 `{type:'dzy-purchase-logout',v:1}`。
- 首頁提醒（Q5-A）`alerts(ctx)`：取券 → `POST <貨單後端>/sso/counts {ticket}` → `[{level:'warn',text:'貨單待核對 N 張',view:'main',params:{tab:'review'}}, {…辨識失敗 N 張…}]`；N＝0 不顯示；失敗靜默回 []。

## 4. 貨單後端（mala-purchase/server）

- `.env`：`DZY_PLATFORM_URL`（平台 /api 網址）、`DZY_PURCHASE_SVC_KEY`；任一沒設＝/sso 回 FORBIDDEN。`ACCT_LOGIN_UNTIL=YYYY-MM-DD`（台北時間該日結束後，會計密碼登入回 FORBIDDEN「會計請改從鼎兆元管理系統（財務部門 → 貨單核對）進入」；admin 不受影響；沒設＝不限）。`ALLOW_ORIGIN` 加管理系統網址（/sso/counts 從管理系統頁面直接呼叫）。
- 遷移：`users.dzy_sub TEXT UNIQUE`（可空）；`sessions` 加 `sub`、`verified_at`、`tried_at`、`token_after`。
- `POST /sso {ticket}`：兌換 → 找 `users.dzy_sub = sub`；沒有 → 自動建 `role accountant`、無品牌、不能用密碼登入、`must_change_password 0`、username `dzy-<sub>`；停用的帳號 → FORBIDDEN。發 session（12 小時）；回應形狀同 /login，另帶 `embed:true`。
- 每次請求：嵌入 session 的 `verified_at` 超過 5 分鐘 → `svcPurchaseWho`：active 且 allowed 且 token_after 沒變大 → 更新；否則刪 session → 401（「你在管理系統的權限已變更，請回管理系統重新進入」）。連不上 → 從 verified_at 起最多沿用 30 分鐘，之後 503。
- `POST /sso/counts {ticket}`：兌換＋對帳號（不自動建、不發 session）→ `{review, failed}`（會計＝自己全部品牌加總；admin＝全部）。
- 帳號頁（admin）：每個帳號多一欄「管理系統同仁編號」（DZY### 或 U:xx，可清空，唯一）；未指派品牌的會計清單看得出來。
- 沒有品牌的會計進核對頁 → 畫面「尚未指派品牌，請找 Eason」（Q2-A），API 照舊不給資料。

## 5. 貨單網頁（mala-purchase/web）嵌入模式 `?embed=dzy`

- 嵌入 token 存 `sessionStorage`（key 與一般登入分開），換頁（review／reports／admin.html 之間）沿用，`embed=dzy` 跟著連結帶。
- 沒 token → 不顯示登入框，送 ready、等 sso；兌換失敗 → 顯示後端錯誤訊息＋「回管理系統重新整理」。
- 嵌入時藏側欄、改密碼、登出；保留品牌切換（放主欄頂部）。
- 九個分頁（id／內容）：`review` 待核對（頁內小切換：待核對｜退回）、`confirmed` 已入帳、`failed` 辨識失敗、`alerts` 價格提醒、`price` 單價走勢、`cost` 食材成本、`daily` 每日進貨、`items` 品項廠商（頁內小切換：品項｜廠商｜損益對照）、`users` 帳號（admin；頁內小切換：帳號｜門市）。badge：review、failed 的筆數。
- 收到 `dzy-purchase-go` → 換到對應頁；`dzy-purchase-logout` → 清嵌入 token＋打 /logout。
- 只理會 `event.source === window.parent` 且 origin＝管理系統（正式 `https://dzy.mozhuting.com`；本機 `http://localhost:8777`）的訊息。

## 6. 部署順序

1. mini：平台後端（sync-gas PurchaseSso.gs 等）＋ `.env` 設 `GAS_PROP_PURCHASE_SVC_KEY`；貨單後端（遷移、`.env` DZY_PLATFORM_URL／DZY_PURCHASE_SVC_KEY／ALLOW_ORIGIN）。
2. dzy 前端 push（選單出現；只有 Eason 開權限的人看得到）。
3. 貨單網頁 push（嵌入模式生效）。
4. Eason 在「權限設定 → 財務部門」打開「貨單核對」；在貨單帳號頁填兩位會計的同仁編號。
5. 兩週後設 `ACCT_LOGIN_UNTIL`（或上線時就設好日期）。
