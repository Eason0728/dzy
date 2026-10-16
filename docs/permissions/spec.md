# 規格：個人帳號第二期｜依單位＋職稱給系統權限

- 版本：v1（2026-10-17）
- 狀態：等 Eason 確認
- 上游：`docs/permissions/requirements.md` v1（2026-10-17 確認）
- 優先序：本檔 > `docs/personnel/spec.md` > `docs/spec.md`（只在第二期涉及的範圍）

## 0. 一句話
同仁帳號（role `staff`）登入或開頁時，後端依「單位階梯＋職稱＋部門（主要＋兼任）」查**權限對照表**，加上**個別例外**，算出權限碼與**稽核看得到的店**；稽核代轉依這份店清單裁切。系統帳號（BOSS 等）完全照舊。

## 1. 現況（2026-10-17 讀碼）
| 項目 | 位置 | 現況 |
|---|---|---|
| 角色權限 | `Auth.gs getRolePerms_` :197-212 | 讀 roles 分頁；staff 角色＝`platform.self` |
| 衍生權限 | `Auth.gs authPermsWithGate_` :699-711 | role staff 才算：`platform.review`（審核者）、`platform.bulletin`（公告管理）；gate 來自 `Staff.gs stfLoginGate_` :822-833 |
| 回傳 | `handleLogin_` :600-609、`handleMe_` :667-677 | `{token, user:{id,name,role,node}, perms}`；me 每次開頁都重算 |
| 前端判斷 | `platform/auth.js can()` :305-315；`platform/shell.js` :191-201 | 精確比對、`*` 萬用、`platform.login` 恆真；模組 requires 任一符合即顯示 |
| 稽核代轉授權 | `Auth.gs proxyAuthorize_` :298-333 | `filterNode = (!canRead && canOwn) ? user.node : null`（單一店字串） |
| 裁切 | 前端 `platform/api.js filterOwnNode_` :123-164；mini `proxy-hook.js filterResponse` :30-39 | 依每列 `store` 欄等於 node；node 空字串＝全部清空 |
| 稽核店別代號 | `Users.gs USR_VALID_NODES` :24；稽核「門市」分頁（動態） | `sxl-gf`、`ck`、`mzt-gf`、`mzt-js`、`mzt-lzl`…；與組織單位代號不同（小辛辣光復＝單位 `mala-gf`） |
| staff 列 | `Staff.gs STF_HEADERS` :17-19、extra_depts :34-35 | 有 status、brand、unit、dept、title、extra_depts；查詢 `stfFindByUserId_` :450-454 |

## 2. 新權限碼
沿用 `docs/spec.md §4.2` 格式。第二期新增三個（其餘沿用）：

| 權限碼 | 意思 | 新／舊 |
|---|---|---|
| `audit.read` | 稽核總覽、報告、異常分析（全部店） | 舊 |
| `audit.read.brand` | 同上，**只限自己品牌的店** | **新** |
| `audit.read.own` | 稽核「我的門市」（只限自己店） | 舊 |
| `audit.write` | 填稽核單、門市管理 | 舊 |
| `dorm.read`／`dorm.write` | 宿舍清單／建約點交終止 | 舊 |
| `platform.staff` | 同仁名單（人資） | 舊 |
| `platform.users` | 人員管理（系統帳號） | 舊，**鎖** |
| `platform.permmap` | 改權限對照表 | **新**，**鎖** |
| `platform.permex` | 設個別例外 | **新**，**只給 role admin，不進對照表** |

- **鎖**＝只有 role `admin` 能在對照表裡新增或刪除含這個碼的規則（需求 3.1 第 1 件）。
- 對照表、例外**都不能**給 `*`、`platform.self`、`platform.login`、`platform.review`、`platform.bulletin`、`platform.permex`（後兩者另有來源，前兩者人人有）。可給的碼＝上表除 `platform.permex` 以外的 9 個，寫死成白名單 `PERM_GRANTABLE`。
- `audit.read.brand` 只在**同仁帳號**出現；系統帳號的角色不給它（roles 分頁不動）。

## 3. 資料（三張新分頁，在 mini 的平台資料庫）
第一次打開「權限設定」或呼叫任何 perm* action 時自動建（`setupPerms_`：只補不覆蓋，表頭不一致就停，照 setupStaff 慣例）。

### 3.1 `perm_map`（權限對照表）
| 欄 | 型別 | 說明 |
|---|---|---|
| `rule_id` | 字串 | `R001` 起流水號 |
| `ladder` | `store`／`office`／`hq` | 單位階梯（門市含 ck、品牌辦公室、總部） |
| `dept` | 部門代碼或空 | 只有 hq 可填；空＝不限部門 |
| `title` | 職稱代碼或 `*` | `*`＝這個階梯的所有職稱 |
| `perm` | 權限碼 | 必須在 `PERM_GRANTABLE` |
| `active` | `TRUE`／`FALSE` | 刪除＝改 FALSE（留歷史） |
| `updated_at`／`updated_by` | 文字 | 台北時間、帳號 id |

**比對規則**：同仁符合一條規則 ⇔ 同仁單位的 ladder＝規則 ladder，且（規則 title＝`*` 或＝同仁 title），且（規則 dept 空，或規則 dept ∈ 同仁「主要部門＋extra_depts」）。符合的規則全部聯集。

**預設規則**（需求第 4 節權限表；setupPerms_ 只在 perm_map 是空表時寫入）：
| ladder | dept | title | perm |
|---|---|---|---|
| store | — | sm | audit.read.own |
| office | — | oam, osv, odir（三條） | audit.read.brand |
| hq | ops | * | audit.read |
| hq | mgmt | * | audit.read, audit.write |
| hq | fin | * | audit.read, audit.write |
| hq | — | ceo, gm, chair（各兩條） | audit.read, dorm.read |
| hq | hr | * | platform.staff, dorm.read, dorm.write, platform.permmap |

部門代碼取自 `Staff.gs` 預設 org :1353-1362（fin 財務、hr 人資、ops 營運、mgmt 管理）；**實作時再讀一次正式 orgOptions 核對，不一致就停下來問**。

### 3.2 `perm_ex`（個別例外）
| 欄 | 說明 |
|---|---|
| `ex_id` | `X001` 起 |
| `emp_no` | 同仁編號 DZY### |
| `perm` | 必須在 `PERM_GRANTABLE` |
| `mode` | `add`（多給）／`remove`（拿掉） |
| `until` | `YYYY-MM-DD` 或空（不到期）；**當天 23:59:59 台北時間後失效** |
| `note` | 原因（必填，1–50 字） |
| `active` | 撤銷＝FALSE |
| `created_at`／`created_by`／`revoked_at`／`revoked_by` | 紀錄 |

到期不需要排程：每次算權限時比對今天日期。

### 3.3 `perm_store_map`（組織單位 ↔ 稽核店別）
| 欄 | 說明 |
|---|---|
| `unit` | 組織單位代碼（例 `mala-gf`） |
| `audit_store` | 稽核店別代碼（例 `sxl-gf`）；一個單位對一家店 |
| `updated_at`／`updated_by` | 紀錄 |

預設寫入：`mala-gf→sxl-gf`、`ck→ck`、`mzt-gf→mzt-gf`、`mzt-js→mzt-js`、`mzt-lzl→mzt-lzl`。其他店（美村、南昌、一悟…）稽核還沒有就不寫；之後稽核「門市管理」新增店時，Eason 在權限設定畫面補對照。只有 role admin 能改。

### 3.4 紀錄
三張表每次寫入都在既有 `staff_log` 追加一列（action `perm_map_save`／`perm_ex_save`／`perm_ex_revoke`／`perm_store_save`，內容只放規則 id、改前改後的碼，不放個資）。

## 4. 權限計算（後端，單一函式）
新函式 `permCompute_(user)`，在 `authPermsWithGate_` 裡、role 為 staff 時呼叫：

```
輸入：users 列（role staff）
1. staff 列 = stfFindByUserId_(user.id)；不是 active 狀態 → 回 { perms: 角色權限, scope: {audit: 'none'} }（現行 gate 已擋登入，這裡是第二道）
2. 單位 → ladder、brand；職稱；部門集合 = {主要 dept} ∪ extra_depts
3. P = 符合的 perm_map 規則的 perm 聯集
4. 例外：今天有效的 add 加入 P；有效的 remove 從 P 拿掉（remove 優先於 add）
5. P ∩= PERM_GRANTABLE
6. 稽核範圍 scope.audit：
   - P 有 audit.read 或 audit.write → 'all'
   - 否則 P 有 audit.read.brand → 同 brand 所有單位在 perm_store_map 的 audit_store 清單
   - 否則 P 有 audit.read.own → [自己單位對應的 audit_store]（沒有對照 → []）
   - 否則 'none'
7. 回 { perms: 角色權限 ∪ P ∪ 既有衍生（review／bulletin）, scope }
```
- 讀表一次請求內快取（同 settings 單次快取慣例），不跨請求快取——職稱一改，下次開頁就生效（需求 3.1 第 4 件）。
- `platform.permex`：role admin 的 `*` 本來就涵蓋，不另外發。

## 5. 稽核代轉裁切擴充
- `proxyAuthorize_` 回傳的 `filterNode` 型別擴成 **`null`｜字串｜字串陣列**：
  - 系統帳號：照舊（storelead 回 user.node 字串，其他 null）。
  - 同仁帳號：scope.audit＝`'all'`→null；陣列→陣列；`'none'`→403（沒權限）。
  - canRead 判斷加入 `audit.read.brand`：有它也算「能讀」，但要裁切。
- mini `proxy-hook.js filterResponse`、前端 `platform/api.js filterOwnNode_`：**兩邊一起改**成「字串＝那一家；陣列＝列的 store 在陣列裡；空陣列＝全部清空」。kit 的 `proxy.js` 不用改（它只判斷 filterNode 是否為 null）。
- `audit.write`（填單）只要 scope 是 all 才給；填單 action 本身不裁切（會計要能填每一家）。
- `test/proxy-authorize.test.mjs` 補：brand 陣列、空陣列、同仁無權限 403。

## 6. 新 action（Code.gs 白名單＋分派表；`proxyAuthorize_` 照舊**不進**分派表）
| action | 誰能呼叫 | 輸入 | 回傳 |
|---|---|---|---|
| `permMapGet` | platform.permmap 或 admin | `{}` | `{rules, grantable, locked, titles, depts}` |
| `permMapSave` | 同上 | `{add:[{ladder,dept,title,perm}], remove:[rule_id]}` | `{ok}`；含鎖碼且非 admin → `perm_locked` |
| `permExList` | admin | `{emp_no?}` | `{items}` |
| `permExSave` | admin | `{emp_no, perm, mode, until, note}` | `{ex_id}` |
| `permExRevoke` | admin | `{ex_id}` | `{ok}` |
| `permStoreGet`／`permStoreSave` | admin（讀：permmap 也可） | `{}`／`{unit, audit_store}` | 對照清單 |
| `myPerms` | 已登入 | `{}` | `{items:[{perm, name_zh, source:'title'|'dept'|'exception'|'role', rule_id?, ex_id?, until?}], audit_scope}` |

- 驗證都經 `authResolveSession_`；寫入都拿 LockService；台北時間。
- 試跑模式 `?dryrun=1`：`permMapGet`、`permExList`、`permStoreGet`、`myPerms` 列為讀；其餘寫入攔下（`platform/dryrun.js` 平台讀清單補上）。
- 新 action 都**不寫外部系統**，不用加進 mini `jobs.js TRIGGER_ACTIONS`。

## 7. 前端
### 7.1 新模組 `modules/perms`（權限設定）
- manifest：`dept: 'it'`、`requires: ['platform.permmap']`（admin 用 `*` 也看得到）。registry 加一行，`platform/` 其他不動。
- 三個分頁：
  1. **對照表**（`platform.permmap`）：列＝9 個可給的功能（中文名），每列顯示目前給了哪些對象（chip：「人資部・全部職稱」「門市・店長」）；「新增對象」選階梯→（總部才有）部門→職稱；鎖住的兩列對非 admin 顯示灰色「只有系統管理者能改」。
  2. **個別例外**（admin）：搜尋同仁、選功能、多給／拿掉、到期日、原因；清單可撤銷，過期的灰掉。
  3. **店別對照**（admin）：組織單位 ↔ 稽核店別下拉。
- 首頁提醒 `alerts()`：有門市單位還沒對照稽核店 → 提醒一列（只給 admin）。

### 7.2 「我的資料」加一塊「我能用的功能」
`modules/me` 個人資料頁下方，呼叫 `myPerms`，列功能＋來源（「因為職稱：店長」「因為部門：人資部」「例外，到 10/31」）。

### 7.3 稽核兩個模組
manifest 只改 requires：模組＝`['audit.read','audit.read.brand','audit.read.own']`；總覽／報告／異常分析＝`['audit.read','audit.read.brand']`；填寫、門市管理＝`['audit.write']`；我的門市＝`['audit.read.own']`。資料已在代轉裁切，畫面不必另外過濾。

## 8. 鎖與防呆（後端強制，前端只是顯示）
1. 非 admin 送出含 `platform.users`／`platform.permmap` 的新增或刪除 → 整批拒絕 `perm_locked`。
2. 不在 `PERM_GRANTABLE` 的碼 → `bad_perm`。
3. ladder／title／dept 必須是 org 分頁啟用中的代碼，且 title 屬於該 ladder；dept 只有 hq 能填 → `bad_target`。
4. 不准刪到「沒有任何人有 platform.permmap 又沒有 admin」——admin 永遠在，所以只檢查規則合法，不擋。
5. 例外的 `until` 不能早於今天；`note` 必填。
6. 停用、離職、待審核的同仁：permCompute_ 第 1 步直接回空權限。
7. 角色 `staff` 以外的帳號完全不走 permCompute_。

## 9. 組織表職級初始值修正
`Staff.gs` 預設 org 與 `STF_UPGRADE_ADD`：`osv` rank 3→2、`odir` 4→3；`test/org-upgrade.mock.test.mjs` T1 跟著改。正式資料由 mini 另行修改（2026-10-17 交辦）。

## 10. 部署順序（前後端有相依）
1. ~/dzy main：後端（Auth.gs、新 Perms.gs、Code.gs）＋測試全綠。
2. `sync-gas.sh dzy-platform` → minikit 同步 `proxy-hook.js`（陣列裁切）→ mini pull＋重啟。此時舊前端照用：陣列只發給同仁帳號，而同仁帳號目前沒有稽核權限＝沒影響。
3. 從外網用測試同仁帳號打 `myPerms`、稽核 `getAll` 確認裁切。
4. push 前端（新模組＋manifest＋api.js）。挑晚上。
5. Eason 在權限設定畫面看一遍預設規則，店長、區督導、會計各實測一次；通知大家 Cmd+Shift+R。

## 11. 測試
- node：`test/perms.mock.test.mjs`（新）：比對規則、例外加減與到期（含當天 23:59／隔天 00:00）、remove 優先、白名單、鎖碼、非 active、ladder/title 不合、部門兼任、scope 三種、店別對照缺漏。
- `test/proxy-authorize.test.mjs` 補陣列裁切；前端 `filterOwnNode_` 與 mini `filterResponse` 用同一組案例比對（兩邊一致）。
- `test/users.mock.test.mjs loadPlatform` 沙盒：新服務若有用到要補假物件。
- e2e 新一支 `e2e_t11_perms.py`（mock 後端）：店長只見我的門市、區督導見總覽且只有自己品牌、人資改對照表、改鎖碼被擋、例外到期。
- 每格權限表真機實測一個帳號（上線第 5 步）。

## 12. 不做
同 requirements 第 6 節。另：系統帳號不改成吃對照表；不做權限變更通知；不做「看別人有什麼權限」的總表（之後要再加）。
