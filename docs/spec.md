# 鼎兆元餐飲集團｜管理系統 — 規格（spec.md）

版本：v2 / 2026-08-14（已完成 Eason 確認。v2 異動：稽核拆成兩個模組＝首頁兩張卡片、店長隔離採「接受前端過濾」、平台後端立即建置、新增 `ns`／`backend` 兩個 manifest 欄位）
上一份：[requirements.md](./requirements.md) v3

---

## 1. 一張圖看懂

```
                     瀏覽器（eason0728.github.io/dzy/）
┌──────────────────────────────────────────────────────────────┐
│ 平台層 platform/                                              │
│   shell.js 開機・路由(#/模組/分頁)・導覽・掛載模組              │
│   auth.js  登入・session・can(權限碼)                          │
│   api.js   後端呼叫封裝＋回傳格式轉接                           │
│   ui.js    toast／loading／confirm／簽名板   ← 全系統唯一一份    │
│   fmt.js   日期／轉義／金額                  ← 全系統唯一一份    │
│   registry.js  ★模組清單（加模組唯一要改的檔）                  │
└───────────────┬──────────────────────────────────────────────┘
                │ ctx（身分・權限・api・ui・fmt・nav）
   ┌────────────┴────────────┬───────────────────────┐
   │ modules/audit/          │ modules/dorm/         │ (未來 modules/transfer/)
   │   manifest.js           │   manifest.js         │
   │   index.js  views/      │   index.js  views/    │
   └────────────┬────────────┴───────────┬───────────┘
                │                        │
┌───────────────┴────────┐ ┌─────────────┴──────────┐ ┌────────────────────┐
│ 稽核 Apps Script（不動）│ │ 宿舍 Apps Script（不動）│ │ 平台 Apps Script（新）│
│ 容器繫結稽核試算表      │ │ 獨立 script            │ │ 帳號・角色・權限      │
└────────────────────────┘ └────────────────────────┘ └────────────────────┘
```

殼外獨立頁：`sign.html`（員工簽約，token 免登入，不經平台層）。

## 2. 檔案結構

```
~/dzy/
├── index.html                  平台唯一入口
├── sign.html                   殼外：宿舍簽約頁（token）
├── platform/
│   ├── shell.js                開機、路由、導覽、掛載／卸載模組
│   ├── auth.js                 登入、session、can()
│   ├── api.js                  後端呼叫＋回傳轉接
│   ├── ui.js                   toast/loading/confirm/dialog/簽名板
│   ├── fmt.js                  date/datetime/roc/esc/money
│   ├── registry.js             ★ 模組清單
│   └── css/
│       ├── tokens.css          設計 token（唯一色票來源）
│       ├── base.css            排版基礎
│       └── components.css      共用元件樣式
├── modules/
│   ├── audit/  manifest.js  index.js  api.js  views/*.js  css/audit.css
│   └── dorm/   manifest.js  index.js  api.js  views/*.js  css/dorm.css
├── apps-script/platform/       新增：帳號權限後端（Code.gs / Auth.gs / Users.gs / Setup.gs）
├── assets/icons/*.svg
├── test/                       node 單元測試＋Playwright e2e
└── docs/                       requirements / spec / plan / task
```

## 3. 技術決策

| # | 決策 | 理由與代價 |
|---|---|---|
| S1 | **ES modules＋動態 `import()`** 載入模組 | 瀏覽器原生、零建置、真封裝（不靠全域變數）；加模組只改 `registry.js`。代價：本機測試必須跑 http server（不能 `file://`），沿用既有 `.command` 腳本即可。備案：若日後遇到相容問題，退回「動態建立 `<script>` ＋全域註冊」，`registry.js` 介面不變 |
| S2 | **Hash 路由** `#/<模組>/<分頁>` | GitHub Pages 是純靜態，hash 不需要 404 rewrite，重新整理不會 404。例：`#/audit/ops`、`#/dorm/list` |
| S3 | **平台代管既有系統的通行碼**（見 §6.3） | 既有兩支後端**一行都不用改**，完全滿足 §0 鐵規。使用者不再知道通行碼，離職只要停用帳號、不必換碼 |
| S4 | 所有後端呼叫用 `POST` ＋ `Content-Type: text/plain` | 沿用稽核既有做法，避開 CORS preflight（Apps Script 對 OPTIONS 回應不完整） |
| S5 | Session 用 **無狀態簽章 token**（HMAC-SHA256），有效期 7 天 | 後端不必存 session 表；停用帳號的即時性靠每次呼叫查一次 `active` 旗標補上 |
| S6 | 密碼用 **每帳號隨機 salt ＋ SHA-256 迭代 10,000 次** | Apps Script 沒有 bcrypt／PBKDF2；配合「帳號僅內部發放＋錯誤 5 次鎖 15 分鐘」對內部系統足夠。**明碼永不落地** |
| S7 | 舊 repo `mala-audit`／`mala-dorm` **永久保留、不轉址** | 已發出的簽約 token 連結指向舊網址，轉址風險不對稱。舊站是靜態頁、呼叫同一支後端，零維護成本 |

## 4. 共用契約（逐字元定義——這節是跨任務對帳的正本）

> 教訓來源：2026-07-18 mala-leadfinder 因為契約只寫語意、沒寫格式，兩個平行任務各自「符合契約」卻對不上。本節所有格式都給正規式＋範例。

### 4.1 模組代號 `moduleId`、命名空間 `ns`、後端代號 `backend`

三個代號都用同一個格式：`^[a-z][a-z0-9-]{1,19}$`

| 欄位 | 是什麼 | 本期實際值 |
|---|---|---|
| `moduleId` | 一張首頁卡片＝一個模組。同時是資料夾名與路由第一段，全系統唯一 | `audit-ops`、`audit-stock`、`dorm` |
| `ns` | 權限命名空間。**多個模組可共用同一個 ns** | `audit`（前兩個模組共用）、`dorm` |
| `backend` | 對應哪一支 Apps Script／哪一組通行碼 | `audit`（前兩個模組共用）、`dorm` |

> 為什麼要拆出 `ns` 與 `backend`：Eason 2026-08-14 指定稽核在首頁要顯示**兩張卡片**（營運稽核表、月初盤點抽查），
> 但它們共用同一支後端與同一組權限。若強制「權限碼前綴＝moduleId」，就會被迫把權限與通行碼複製兩份。

### 4.2 權限碼 `perm`

- 格式：`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$`（兩段或三段，點分隔）
- 第一段固定等於某個 `ns`，或平台自身的 `platform`
- 範例（本期全部權限碼，只有這些）：

| 權限碼 | 意思 |
|---|---|
| `audit.read` | 看稽核報表（全節點） |
| `audit.read.own` | 只看自己節點的稽核結果 |
| `audit.write` | 填稽核單、送出 |
| `dorm.read` | 看合約清單 |
| `dorm.write` | 建單、發連結、點交、終止 |
| `platform.users` | 人員管理 |

- 萬用字元：僅 `*` 一種，代表全部權限，只給 `admin` 角色。

### 4.3 角色 `role` 與角色→權限對照

- `role` 格式：`^[a-z]{3,12}$`
- 本期五個角色（存於平台試算表 `roles` 分頁，可改不必動程式）：

| role | 中文 | perms |
|---|---|---|
| `admin` | 系統管理者 | `*` |
| `manager` | 部門主管 | `audit.read`, `dorm.read`, `dorm.write` |
| `accountant` | 會計 | `audit.read`, `audit.write` |
| `storelead` | 店長 | `audit.read.own` |
| `staff` | 員工 | （不發帳號，保留代號） |

### 4.4 節點代號 `node`

沿用稽核既有代號，不得自創：

| node | 中文 |
|---|---|
| `sxl-gf` | 麻的小辛辣 光復店 |
| `ck` | 中央廚房 |
| `mzt-gf` | 墨竹亭 光復店 |
| `mzt-js` | 墨竹亭 金山店 |
| `mzt-lzl` | 墨竹亭 六張犁店 |
| `''`（空字串） | 不限節點（總部角色用） |

### 4.5 模組 manifest（每個模組必須 default export 這個物件）

```js
// modules/audit-stock/manifest.js
export default {
  id:      'audit-stock',              // 4.1 格式，全系統唯一
  ns:      'audit',                    // 權限命名空間（與 audit-ops 共用）
  backend: 'audit',                    // 用哪一支後端／哪一組通行碼
  name:    '月初盤點抽查',              // 顯示名，2–8 字
  desc:    '品項抽查 20 項＋金庫抽查',   // 卡片副標，一句話 ≤20 字
  icon:    'audit-stock',              // 對應 assets/icons/audit-stock.svg
  requires: ['audit.read', 'audit.read.own'],  // 任一符合即可進入本模組
  views: [                             // 模組內分頁；陣列第一個＝預設分頁
    { id: 'overview', name: '總覽',     requires: ['audit.read'] },
    { id: 'fill',     name: '稽核填寫', requires: ['audit.write'] },
    { id: 'report',   name: '報告',     requires: ['audit.read'] },
    { id: 'analysis', name: '異常分析', requires: ['audit.read'] },
    { id: 'my',       name: '我的門市', requires: ['audit.read.own'] }
  ],
  entry: () => import('./index.js')    // 動態載入模組本體
};
```

- `views[].id` 格式同 4.1；路由第二段就是它。
- 使用者看不到 `requires` 不符的分頁；模組本身 `requires` 全不符則首頁不顯示這張卡片。

**本期三個模組的 manifest 摘要：**

| moduleId | ns | backend | 卡片名 | 分頁 |
|---|---|---|---|---|
| `audit-ops` | `audit` | `audit` | 營運稽核表 | overview／fill／report／my |
| `audit-stock` | `audit` | `audit` | 月初盤點抽查 | overview／fill／report／analysis／my |
| `dorm` | `dorm` | `dorm` | 宿舍合約 | list／create／handover |

`audit-ops` 與 `audit-stock` 共用 `modules/audit-shared/api.js`（見 §6.4），
所以雖然是兩張卡片，`getAll` 只會被呼叫一次。

### 4.6 模組本體（`index.js` 必須 default export 這個物件）

```js
export default {
  mount(el, ctx)   { /* 畫進 el；回傳 unmount 函式或 undefined */ },
  unmount()        { /* 選填：清事件、清計時器 */ },
  badge(ctx)       { /* 選填：回 Promise<number|null>，首頁卡片的待辦數字 */ }
};
```

- `badge()` **必須由模組自己算**，平台層不得內建任何業務邏輯（這是分層成不成立的判準）。
- `badge()` 回 `null` 或拋錯 → 卡片不顯示數字，不得讓首頁壞掉。
- `badge()` 逾時上限 5 秒，逾時視同 `null`。

### 4.7 `ctx`（平台交給模組的唯一介面，模組不得碰 ctx 以外的平台內部）

```js
ctx = {
  user:   { id: 'u001', name: '王小明', role: 'storelead', node: 'sxl-gf' },
  can:    (perm) => boolean,                    // 例 ctx.can('audit.write')
  api:    { call(moduleId, action, payload) },  // 見 4.8
  ui:     { toast, loading, confirm, dialog, signaturePad },
  fmt:    { date, datetime, roc, esc, money },
  nav:    (viewId, params) => void,             // 模組內換分頁
  params: { }                                   // 由路由 query 帶入
}
```

`user.id` 格式：`^u[0-9]{3,6}$`，範例 `u001`。

### 4.8 後端呼叫與回傳（三支後端一律長這樣）

**送出**（`POST`，`Content-Type: text/plain`）：

```json
{"action":"getAll","token":"<平台 token>","payload":{"year":"2026"}}
```

**回傳**（平台 `api.js` 轉接後，模組看到的一定是這個形狀）：

```json
{"ok":true,"data":{ }}
{"ok":false,"error":"通行碼錯誤"}
```

- 稽核既有回傳 `{ok:true, config, items, records, ...}` → 轉接層包成 `{ok:true, data:{config, items, records, ...}}`
- 宿舍既有回傳 `{ok:true, contract_id, token, ...}` → 同樣包進 `data`
- 既有的 `{ok:false, error}` 原樣通過。
- **轉接只在平台 `api.js` 一處做**，模組內不得再判既有格式。

### 4.9 路由字串

- 格式：`#/<moduleId>/<viewId>?<key>=<value>&...`
- 範例：`#/audit/stock?node=sxl-gf&month=8`、`#/dorm/list`、`#/home`（首頁）
- 路由不合法、或權限不足 → 導回 `#/home` 並 toast「沒有權限」。

## 5. 平台後端（新增，`apps-script/platform/`）

### 5.1 試算表「鼎兆元管理系統｜帳號權限」

| 分頁 | 欄位（逐字元、順序即欄序） |
|---|---|
| `users` | `id`／`username`／`name`／`role`／`node`／`salt`／`hash`／`active`／`created_at`／`last_login_at` |
| `roles` | `role`／`name_zh`／`perms`（逗號分隔權限碼） |
| `module_secrets` | `backend_id`／`level`／`secret`（既有系統的通行碼，僅後端讀取） |
| `login_log` | `at`／`username`／`ip_hash`／`result`（`ok`／`bad_password`／`locked`／`disabled`） |

- `active`：`TRUE`／`FALSE`（大寫布林）
- `created_at`／`last_login_at`／`at`：`YYYY-MM-DD HH:mm:ss`（台北時間，欄位鎖文字格式）
- **`hash`、`salt`、`secret` 三欄永不出現在 repo、永不回傳給前端以外的用途**

### 5.2 API actions

| action | payload | 回傳 data | 需要權限 |
|---|---|---|---|
| `login` | `{username, password}` | `{token, user, perms, secrets}` | — |
| `me` | `{}`（token 在外層） | `{user, perms, secrets}` | 有效 token |
| `listUsers` | `{}` | `{users:[…]}`（不含 salt/hash） | `platform.users` |
| `saveUser` | `{id?, username, name, role, node}` | `{id}` | `platform.users` |
| `setActive` | `{id, active}` | `{}` | `platform.users` |
| `resetPassword` | `{id, newPassword}` | `{}` | `platform.users` |

- `secrets`：以 `backend_id` 為鍵，只回傳「這個使用者有權限的後端」的通行碼，例 `{"audit":"5678"}`。沒權限的後端不下發。
- **一律下發符合其權限的最低一級通行碼**：有 `<ns>.write` 才給 `level=write` 的碼，只有 `read`／`read.own` 一律給 `level=read` 的碼。
  實際效果：店長與部門主管拿到的是稽核的「主管唯讀碼」，就算拿去開舊網址也**只能看、不能填不能改**。
- 登入失敗 5 次 → 該 `username` 鎖 15 分鐘，回 `{"ok":false,"error":"嘗試次數過多，請 15 分鐘後再試"}`。

### 5.3 token 格式（逐字元）

`<base64url(payload)>.<base64url(hmac_sha256(payload, SECRET))>`

payload 為 JSON：`{"u":"u001","r":"storelead","n":"sxl-gf","e":1755264000}`（`e`＝到期 Unix 秒）
SECRET 存 Apps Script 的 Script Properties，**不進 repo**。

## 6. 三個關鍵機制

### 6.1 開機流程

1. `index.html` 只有一個 `<div id="app">` 與一支 `<script type="module" src="platform/shell.js">`
2. `shell.js` → `auth.restore()` 讀 localStorage token → 有效就 `me` 換取最新身分，無效就顯示登入頁
3. 登入後 `registry.js` 逐一 `import()` 各模組的 `manifest.js`（只載 manifest，很輕）
4. 依 `can(requires)` 過濾出「這個人能用的模組」→ 畫首頁卡片 → 各卡片非同步跑 `badge()`
5. 點卡片 → 路由變 `#/audit/ops` → `manifest.entry()` 才真正載入模組本體 → `mount(el, ctx)`

**加第三個模組要改的檔案：只有 `registry.js` 一行。** 這就是驗收條件那一條的實作依據。

### 6.2 導覽兩層

- 第一層（平台）：模組之間切換。手機＝底部列，桌機＝左側欄。
- 第二層（模組）：模組內分頁切換，由 `manifest.views` 動態產生——**這正是稽核 `js/app.js:163 renderNav()` 現在的做法，往上提一層而已**，既有邏輯可直接沿用。

### 6.3 平台代管通行碼（S3 的細節）

```
使用者輸入 帳號＋密碼
      ↓
平台後端驗證 → 回 {token, user, perms, secrets:{audit:"****"}}
      ↓
前端把 secrets 存在記憶體（不寫 localStorage）
      ↓
稽核模組呼叫既有後端時，自動帶上 secrets.audit 當通行碼
      ↓
既有稽核後端完全不知道有平台這回事，行為零改變
```

- `secrets` **只存記憶體**，重新整理就重取（靠 `me`）——不落地到 localStorage，降低外洩面。
- 既有後端的 `REQUIRE_PASSCODE` 開關維持 `true`，不動。

### 6.4 兩張稽核卡片、一次後端呼叫

`audit-ops` 與 `audit-stock` 是兩個獨立模組（首頁兩張卡片），但共用一支後端。
若各自呼叫 `getAll`，同一份資料會被抓兩次。解法是一個共用的資料提供者：

```
modules/audit-shared/api.js
  getAll(ctx) →  記憶體快取，TTL 60 秒，同時進來的呼叫合併成一次請求
  invalidate() → 任一模組送出稽核單後呼叫，讓下次重抓
```

- 兩個模組的 `index.js` 都 `import` 它；它是**模組層**的東西，平台層不認識它。
- 平台層對此零知情——這正是分層要成立的地方：模組之間要共用什麼，是模組自己的事。
- `badge()` 也走同一份快取，所以首頁兩張卡片的數字只花一次請求。

## 7. 店長只看自己節點（K6：已決定接受限制）

稽核後端 `getAll` 一次回全節點資料，且它不認識「節點權限」這件事。在**不動既有後端**的前提下（§0 鐵規）：

**做法**：平台 `api.js` 收到稽核回應後，若使用者權限只有 `audit.read.own`，**在轉接層就把非自己節點的資料裁掉**，
模組拿到的 `data` 本來就只有自己店。只有一處做過濾，模組與 view 不必知道這件事，不會漏網。

**已知且已接受的兩個限制**（Eason 2026-08-14 選定「接受，不做代理」，本節即為交付說明，不得省略）：

1. 這是前端過濾。會按 F12 開開發者工具、看得懂 JSON 的人，能在網路紀錄裡看到原始回應中的別店資料
   （合格率、逐項核定結果、異常說明、稽核日期與人員、盤點數量差異、金庫金額差異）。
2. 平台會把稽核通行碼下發到瀏覽器（§6.3），店長因此可拿該碼去開舊網址 `/mala-audit` 看到全部節點。
   **緩解**：店長與部門主管一律只拿到 `level=read` 的主管唯讀碼（§5.2），所以最壞情況是「看得到全部、但不能填不能改」。

**未來要真正擋住的路**：新增一支平台代理後端（前端 → 平台後端 → 稽核後端，由平台後端持碼並裁切），
店長那條路改走代理即可，前端介面不用改。列為未來升級路徑，本期不做。

> 對應調整：requirements.md §10 該條驗收條件的措辭收斂為
> 「改網址參數拿不到別店資料；devtools 層級不設防，已知並接受」。

## 8. 樣式系統

`platform/css/tokens.css` 是唯一色票來源，模組不得自訂顏色常數：

```css
:root{
  --brand:#c8402c;         /* 鼎兆元紅 */
  --ink:#1c1a19; --muted:#6f665f; --line:#e2dbd4;
  --bg:#f7f4f1; --card:#fff;
  --ok:#2f6b3a; --warn:#b8860b; --danger:#b3261e;
  --radius:10px; --gap:12px;
  --shadow:0 1px 3px rgba(0,0,0,.06);
}
```

- 色票取自宿舍合約現用值（已是鼎兆元紅），稽核既有 `css/base.css` 的變數名對照後統一。
- 手機優先：基礎樣式寫手機版，桌機用 `@media (min-width:768px)` 加側邊欄。
- 設計方向：留白、單一主色、清楚層級。不加裝飾性圖樣。

## 9. 測試策略

| 層級 | 測什麼 | 工具 |
|---|---|---|
| 單元 | `can()` 權限判斷、manifest 格式驗證、`fmt` 工具、token 簽章驗證 | node，`test/*.test.js` |
| 單元（既有） | 稽核既有八支測試（format／api.mock／sampling／gas-core／gas-submit／gas-import／ops-format／gas-ops） | 原樣沿用，一支都不能少 |
| 整合 | 平台後端六個 action 的 mock 測試 | node |
| e2e | ①登入→首頁卡片正確 ②會計看不到宿舍 ③店長只看自己店 ④切模組不重載頁面 ⑤稽核既有八支 e2e ⑥宿舍建單→簽約→點交全流程 | Playwright（一次跑一支、間隔 20 秒，port TIME_WAIT 會衝突） |

**動工前置作業（強制，對應 R8）**：兩份正式試算表各另存一份副本，檔名加日期，截圖存證。

## 10. 上線與過渡

| 階段 | 動作 |
|---|---|
| 開發期 | 全程本機；後端只打測試資料；不 push 到會被員工看到的網址 |
| 內測 | 新 repo 先設 private 或用未公開網址，Eason 一人測 |
| 上線 | 建立 `Eason0728/dzy` public repo＋Pages；發帳號給會計與五位店長 |
| 過渡 | 舊網址 `/mala-audit`、`/mala-dorm` 原封不動繼續跑，兩軌並行至少一個月 |
| 收斂 | 確認沒人走舊網址後，舊站首頁改成「已搬家」提示；**`sign.html` 永久保留** |

期間發現的 bug：改新系統為主，舊站只在「會影響正式資料」時才同步修。

## 11. 已知取捨（我先決定，覺得不對請否決）

| # | 我的決定 | 代價 |
|---|---|---|
| T1 | 稽核的兩個區塊（營運稽核／盤點抽查）是**兩個獨立模組＝首頁兩張卡片**（Eason 2026-08-14 指定） | 要多做一層 `modules/audit-shared/api.js` 共用快取，避免 `getAll` 被呼叫兩次（§6.4）；並為此在 manifest 拆出 `ns`／`backend` 兩個欄位（§4.1） |
| T2 | 宿舍簽約頁 `sign.html` 留在殼外、不進平台 | 它是給沒有帳號的員工開的；硬塞進殼要在殼裡開一個免登入的洞，得不償失 |
| T3 | 第一版不做「忘記密碼」自助流程 | 密碼由系統管理者重設。五個人的系統，做自助流程不划算 |
| T4 | 不做操作稽核軌跡（誰在什麼時候看了什麼） | 只記登入紀錄。要做全軌跡得改既有後端，違反 §0 |

## 12. 確認紀錄（Eason 2026-08-14）

| 問題 | 決定 |
|---|---|
| 平台代管通行碼（§6.3） | **同意**。既有兩支後端一行都不用改 |
| 店長隔離（§7） | **接受前端過濾的限制，不做代理後端**。限制內容已寫進 §7，屬交付說明的一部分 |
| 稽核卡片數（§11 T1） | **首頁兩張卡片**，因此拆成 `audit-ops`／`audit-stock` 兩個模組 |
| 新增雲端資源 | **現在建**：1 支 Apps Script ＋ 1 份 Google 試算表（帳號權限用） |

**規格確認狀態：已完成。** 下一份文件：`plan.md` ＋ `task.md`。

> 提醒：新建的 Apps Script 需要 Eason 在編輯器**手動執行一次函式完成 OAuth 授權**，
> 否則 web app 匿名存取會回 403「存取遭拒」——`clasp push`／`deploy` 都不會觸發同意畫面
> （教訓來源：dispatch-rules.md 第 5 節稽核系統那列）。這是 Phase 0 唯一需要 Eason 動手的事。
