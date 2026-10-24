# 規格：個人帳號管理（第一期）

版本：v3 / 2026-10-12（v3＝Eason 2026-10-12 拍板：認領改主管審核、登出全部裝置、帳號不分大小寫，見 §0c）
（v2 / 2026-10-11）（v1 經 Fable 對抗性設計審 15 條，全部處理；GPT 設計審因 Codex 額度用完未跑）
上游：`docs/personnel/requirements.md`（2026-10-11 Eason 確認，六題照建議）
平台既有契約：`docs/spec.md`（以下稱「平台 spec」）。本文件只寫**新增與變動**；沒寫到的照平台 spec。

## 0. 定案摘要（requirements 第 7 節六題，Eason 2026-10-11「照建議」）
1. 央廚用門市職級。
2. 墨竹亭總部、小辛辣總部、鼎兆元總部用總部職級。
3. 總部單位多一個「部門」下拉；部門只掛鼎兆元總部（九個，見 §4.2），放 org 分頁、可隨時加，不必改程式。
4. 每人只填一個主要單位。
5. 沒到職日的 11 人這次不編；日後從下一號往後接，不插隊。
6. 只有暱稱的 9 人先用現有名字建檔，日後後台改姓名（編號不變）。

## 0b. 系統管理員帳號改名（Eason 2026-10-11）
- 系統管理員帳號的登入名稱由 `admin` 改為 `BOSS`；角色仍是 `admin`（全部權限）。改名在上線步驟由 Eason 於「人員管理」編輯該帳號完成（2026-10-12 起所有帳號不分大小寫，打 `boss` 也可以）。

## 0c. 2026-10-12 Eason 拍板三件事
1. **認領帳號改成「主管審核後才開通」**（Eason 原話：認領帳號只是為了核對編號是正確的，要等輸入完全部個人資訊後，送交各單位主管審核完畢，才可以開通帳號）。
   claimSubmit 不再回 token、不自動登入；status＝pending 的帳號登入一律拒絕（「帳號還在等主管審核」）；同單位主管（或人資）審核通過才能登入。見 §5、§6.1、§6.8。
2. **登出＝全部裝置一起登出**：新 action `logout`，把 token_after 設成現在。見 §6.9。
3. **帳號比對不分大小寫**（所有帳號，不只 DZY）：上一批後端安全修正把 findUserRow_ 與登入鎖定計數都改成不分大小寫（人員管理建帳號防重複本來就不分大小寫，保證最多一列對得上）。§0b、§3 原本「非 DZY 帳號原樣比對」作廢。

## 1. 架構與落點
- 全部在既有平台：前端 `~/dzy`（GitHub Pages），後端 `apps-script/platform`（同一支 Apps Script、同一個部署 ID，
  只 `create-version`＋`update-deployment`，**絕不 create-deployment**）。
- 同仁登入帳號放既有 `users` 分頁（沿用 login／me／token／鎖定機制），個人資料放新分頁 `staff`，以 `user_id` 對應。
- 新增兩個前端模組（registry 各加一行）＋兩個登入前畫面（平台層，屬登入流程，不是模組）：

| 名稱 | 類型 | 檔案 | 誰看得到 |
|---|---|---|---|
| 我的資料 | 模組 `me` | `modules/me/` | 有 `platform.self`（同仁） |
| 同仁名單 | 模組 `staff` | `modules/staff/` | 有 `platform.staff`（後台；admin 的 `*` 涵蓋） |
| 第一次使用 | 平台畫面 | `platform/views/claim.js` | 未登入 |
| 忘記密碼 | 平台畫面 | `platform/views/forgot.js` | 未登入 |

- 既有「人員管理」模組（users）不改行為；只在列表**排除** role＝`staff` 的列（同仁改在「同仁名單」管），避免 113 列擠進系統帳號清單。

## 2. 權限與角色（平台 spec §4.2／§4.3 的增補）
| 權限碼 | 意思 |
|---|---|
| `platform.self` | 看／改自己的個人資料；店長以上另可看自己單位通訊錄（見 §6.4） |
| `platform.staff` | 同仁名單後台：匯入、新增、確認、退回、停用、解鎖、改資料；也可審核任何單位的認領（§6.8 備援） |
| `platform.review` | **衍生權限，不要寫進 roles 分頁**（2026-10-12）：後端在 login／me 時依 staff 列自動加給「單位主管」（§6.4 同一套門檻），只用來讓「我的資料 → 待審核」分頁出現；審核 action 每次都在後端重算資格，不信任這個權限 |

- 同仁帳號一律 role＝`staff`（平台 spec 已保留此代號）；roles 分頁 `staff` 那列 perms 由空字串改為 `platform.self`。
- `node` 一律空字串（第一期不做店別權限；第二期依職稱對應時再定）。
- **第一期職稱不影響任何系統權限**（第二期才做），唯一例外是 §6.4 單位通訊錄。

## 3. 編號與帳號
- 編號格式（逐字元）：`^DZY[0-9]{3}$`，例 `DZY001`。存在 `users.username` 與 `staff.emp_no`，**一律大寫**。
- 登入時：handleLogin_ 把 trim 後符合 `/^dzy[0-9]{3}$/i` 的輸入轉大寫（只為了 login_log 好讀）。
  **2026-10-12 起所有帳號比對都不分大小寫**：findUserRow_ 與鎖定計數 key 一律轉小寫比（dzy001／DZY001、boss／BOSS 同一個帳號、同一個鎖定計數）。
- 編號只增不減：下一號＝現有最大號＋1（含停用者）。到 `DZY999` 後拒絕新增並提示（屆時再議四碼）。
- `users.id` 照平台既有規則 `u` 開頭流水號（由 Users.gs 既有產號函式產生），與編號無關。

## 4. 資料（Google 試算表，平台既有那本）
### 4.1 `staff` 分頁（新）
| 欄 | 名稱 | 說明 |
|---|---|---|
| A | emp_no | `DZY001`，唯一 |
| B | user_id | 對應 users.id |
| C | name | 全名（後台可改；第一次使用比對用） |
| D | status | `unclaimed`／`pending`／`active`／`rejected`／`disabled`（逐字元，只有這五種） |
| E | brand | 已確認的品牌代號（見 §4.2） |
| F | unit | 已確認的單位代號 |
| G | dept | 已確認的部門代號（非總部單位為空） |
| H | title | 已確認的職稱代號 |
| I | p_brand | 待確認的品牌（沒有待確認＝空） |
| J | p_unit | 待確認的單位 |
| K | p_dept | 待確認的部門 |
| L | p_title | 待確認的職稱 |
| M | birthday | `YYYY-MM-DD`（純文字格式，防 Google 自動轉日期） |
| N | phone | `09` 開頭 10 碼（純文字，防前導 0 被吃） |

**純文字保證（v2）**：每次寫 staff 列前，先對那一列 `setNumberFormat('@')` 再 `setValues`（不用 appendRow，新列不一定繼承欄格式）。
讀出比對前一律正規化：phone 若是數字 → 左補 0 到 10 碼；birthday 若是 Date 物件 → 用台北時區轉 `YYYY-MM-DD`。
| O | address | 文字 |
| P | reject_reason | 退回原因（重送時清空） |
| Q | reset_fail | 忘記密碼連續失敗次數（數字） |
| R | reset_locked | `TRUE`／空 |
| S | claimed_at | 台北時間 `YYYY-MM-DD HH:mm:ss` |
| T | confirmed_at | 同上 |
| U | updated_at | 同上 |
| V | prev_status | 停用前的狀態（disable 時寫入、enable 時讀回並清空） |
| W | reset_lock_until | 忘記密碼時間鎖到期（Unix 秒；空＝沒鎖） |
| X | reset_lock_count | 24 小時內被時間鎖的次數（達 3 次改成 reset_locked＝TRUE，要後台解） |

### 4.1b `users` 分頁加一欄（v2，Fable 第 1 條）
- 第 K 欄 `token_after`（Unix 毫秒，空＝不限）。token payload 加 `i`（簽發時間，Unix 毫秒；用秒的話同一秒內撤銷會漏，測試抓到）。驗證用嚴格大於 `i > token_after`；改密碼當下換發的新 token 以 `token_after+1` 簽發。
- 驗 token 的共用函式（handleMe_ 與所有需要 token 的新 action 都經過它）：簽章＋到期＋users.active＋`i >= token_after`；舊 token 沒有 `i` 視為 0（只要該帳號從沒設過 token_after 就照常通過，既有帳號不受影響）。
- 寫 token_after＝現在：staffUnclaim、forgotReset 成功、staffSetActive 停用、changePassword 成功（本人改密碼後，其他裝置上的舊登入一併失效）、
  **logout（2026-10-12，全部裝置登出）**、認領被退回（staffReject／unitReject 的 pending 分支）。登入簽發時以 `token_after+1` 為下限，剛登出同一毫秒再登入也不會被自己擋掉。
- 防的情境：冒用者認領拿到 7 天 token，後台撤回後真人重新認領，冒用者用舊 token 讀到真人個資。

### 4.2 `org` 分頁（新，下拉選單正本，改這張不必改程式）
| 欄 | 名稱 | 說明 |
|---|---|---|
| A | kind | `brand`／`unit`／`dept`／`title` |
| B | code | 代號，`^[a-z][a-z0-9-]{1,23}$` |
| C | name | 顯示名稱 |
| D | parent | unit→所屬 brand code；dept→所屬 unit code；title→所屬 ladder（`store`／`hq`） |
| E | ladder | 只有 unit 填：該單位用哪套職級 `store`／`hq` |
| F | rank | 只有 title 填：職級數字，越大越高 |
| G | order | 下拉顯示順序 |
| H | active | `TRUE`／`FALSE`（停用的選項不出現在下拉，但舊資料照常顯示名稱） |

預設內容（Setup 時寫入）：
- brand：`mzt` 墨竹亭、`mala` 麻的小辛辣、`yiwu` 一悟燒肉、`ck` 央廚、`dzy` 鼎兆元總部
- unit（parent／ladder）：mzt-js 新竹金山、mzt-gf 新竹光復、mzt-lzl 台北六張犁、mzt-wx 台中文心、mzt-rg 內湖瑞光、mzt-mc 台中美村、mzt-hq 墨竹亭總部(hq)；
  mala-gf 新竹光復、mala-hq 小辛辣總部(hq)；yiwu-js 新竹金山、yiwu-wx 竹北文興；ck 央廚(store)；dzy-hq 鼎兆元總部(hq)。其餘 ladder＝store。
- title store：pt 計時同仁(1)、ft 正職同仁(2)、sm 店長(3)、am 區經理(4)、sv 督導(5)、bd 品牌總監(6)
- title hq：hs 部門同仁(1)、hm 部門主管(2)、ceo 執行長(3)、gm 總經理(4)、chair 董事長(5)
- dept（Eason 2026-10-11，只掛鼎兆元總部 dzy-hq）：fin 財務部、hr 人資部、it 資訊部、eng 工程部、franchise 加盟招商部、purchase 採購部、ops 營運部、training 訓練部、marketing 行銷部。墨竹亭總部、小辛辣總部沒有部門，部門欄不顯示、不必填。

### 4.3 `staff_log` 分頁（新，只追加）
`at`（台北時間）、`emp_no`、`event`、`by`（同仁自助＝自己的 emp_no；後台＝操作者 users.id；登入前動作＝`self`）、`detail`。
event 逐字元：`import`、`add`、`claim`、`resubmit`、`profile_edit`、`confirm`、`reject`、`disable`、`enable`、`unclaim`、`reset_ok`、`reset_fail`、`reset_timelock`、`reset_locked`、`reset_unlock`、`admin_edit`。
**detail 不得寫生日、手機、地址、密碼**（只寫欄位名稱，例如「改了：phone,address」）。之後通知機器人讀這張。

## 5. 狀態機
```
unclaimed --claim--> pending --confirm（人資 staffConfirm）／approve（單位主管 unitApprove）--> active
pending --reject（staffReject／unitReject，2026-10-12 起）--> unclaimed（清密碼、清個資、留 reject_reason，可重新認領）
（舊）rejected --resubmit--> pending：2026-10-12 起不會再產生 rejected，舊資料見 §8d
active --改品牌/單位/部門/職稱--> active（p_* 有值＝待確認變更）--confirm--> active（p_* 搬進正式欄）
                                                            --reject--> active（p_* 清空，填 reject_reason）
任何狀態 --disable--> disabled（prev_status＝原狀態）--enable--> prev_status（清空 prev_status）
pending／rejected／active --unclaim（後台，冒用時用）--> unclaimed（清密碼、清個資、保留編號與姓名）
```
- users.active：unclaimed＝TRUE 但 hash 空；pending／rejected／active＝TRUE；disabled＝FALSE。
- **登入閘門（2026-10-12）**：role＝staff 的帳號，status＝pending → 密碼對了也回「帳號還在等主管審核」；status＝rejected → 「帳號資料被退回，請找人資重新開通」。
  `me`（以及所有走 handleMe_ 的 action）同樣擋，舊流程發出去的 token 一併失效。
  **怎麼分「認領待審」與「已開通的待確認變更」**：前者是 status＝pending；後者是 status＝active 且 p_* 有值。兩者本來就是不同 status，沒改任何欄位意義。
- 登入時 hash 空 → 回「這個編號還沒開通，請按「第一次使用」」，**照樣計入鎖定次數**（不然可以無限試出哪些編號還沒人認領）。
- 首頁待辦（staff 模組 alerts）：pending 的人數＋active 有 p_* 的人數，各一列。

## 6. API（平台後端 doPost 新增 action；回傳形狀照平台 spec §4.8）
### 6.1 登入前（不需 token）
| action | payload | 成功回傳 | 規則 |
|---|---|---|---|
| `orgOptions` | — | `{brands,units,depts,titles}`（只含 active） | 下拉用 |
| `claimLookup` | `{name}` | `{emp_no}` | name trim 後**完全相等**、status＝unclaimed 才回。查不到回「名單上找不到這個名字，請找後台」；已認領回「這個名字已經開通，請用編號登入」。不回任何其他欄位 |
| `claimSubmit` | `{name, emp_no, password, brand, unit, dept, title, birthday, phone, address}` | `{ok:true, pending:true, data:{pending:true, emp_no}}`（**2026-10-12 起不回 token、不登入**） | name＋emp_no 必須對上同一列且仍是 unclaimed；欄位驗證見 §6.5；寫 hash、p_* 欄、個資，status→pending，log `claim`。名字已送出待審時 claimLookup 回「這個名字已經送出開通申請，等單位主管審核通過就能用編號登入」 |
| `forgotReset` | `{emp_no, birthday, phone, new_password}` | `{}` | 見 §6.6 |

登入前 action 防濫用（v2，Fable 第 4 條：Apps Script 拿不到來源 IP，全域小額度會讓上線當天 113 人同時認領被自己擋掉，也讓任何人能刷爆它癱瘓全公司）：
- 不做全域小額度。`claimLookup` 查無姓名時，對「該姓名」計數，同一姓名 10 分鐘內查無 5 次 → 該姓名 10 分鐘內一律回「操作太頻繁」。
- 全域保險上限：三支登入前 action 合計每 10 分鐘 600 次（只防腳本洪水，正常上線日用不到）。
- `claimSubmit` 必須 name＋emp_no 同時對上 unclaimed 列，本身不需額外限流。
- `forgotReset` 的防線見 §6.6。
- forgotReset 成功補寫一筆 login_log（result `ok`），讓日後通知機器人只讀一張表也不會漏。（claimSubmit 2026-10-12 起不登入，不再寫 login_log；認領事件看 staff_log `claim`。）

### 6.2 同仁（需 token＋`platform.self`）
| action | payload | 回傳 |
|---|---|---|
| `myProfile` | — | 自己的 staff 列（不含 reset_* 欄）＋各代號的顯示名稱 |
| `saveMyProfile` | `{brand,unit,dept,title,phone,address}` | 更新後的 myProfile |

- pending／rejected：四個組織欄直接寫 p_*（rejected 送出→pending，清 reject_reason，log `resubmit`）。
- active：組織欄與正式值不同才寫 p_*；手機／地址直接生效。log `profile_edit`。
- 生日與姓名本人不能改（payload 帶了也忽略）。
- **改手機要帶 `current_password`**（2026-10-12）：手機是忘記密碼的驗證欄，否則偷到 token 的人可以先改手機再走忘記密碼搶帳號。
  沒帶回「改手機要輸入目前的密碼」、錯了回「目前密碼不正確」、與 changePassword 合計錯 5 次回「嘗試次數過多，請 15 分鐘後再試」。前端在手機欄被改動時才出現「目前的密碼」欄。
- 身分只認 token（payload 夾帶 user_id／emp_no 一律忽略，同 changePassword 的防線）。
- 呼叫者沒有 staff 列（admin、會計等系統帳號；admin 的 `*` 會讓它看到「我的資料」）→ myProfile 回 `{none:true}`，me 模組顯示「這是系統帳號，沒有個人資料」；alerts 回空陣列（不顯示「暫時讀不到」）。

### 6.3 後台（需 token＋`platform.staff`）
| action | payload | 說明 |
|---|---|---|
| `staffList` | — | 全部 staff 列（含個資，不含 hash）。讀取不建表，匯入（staffImport 或 setupStaff）才建 |
| `staffImport` | `{names:[...], preview:true/false }` | 依陣列順序從下一號起建 users＋staff 列（status unclaimed）。只擋「與現有 **unclaimed** 列同名」或「陣列內重複」（同名者無法用姓名認領）→ 整批拒絕、一筆不寫；與已認領／停用的人同名允許（日後新人可能同名）。`preview:true` 只回將建立的編號對照、不寫入。回 `{created:[{emp_no,name}]}` |
| `staffAdd` | `{name}` | 單筆新增＝staffImport 一筆 |
| `staffConfirm` | `{emp_no}` | p_* 搬進正式欄並清空；status pending→active；log `confirm`。前端確認鈕旁固定提示「確認前請打電話給本人核對」（防冒用的人工核對點，Fable 第 14 條） |
| `staffReject` | `{emp_no, reason}` | reason 必填、200 字內；**pending → 同 unitReject（回 unclaimed、清密碼與個資、留原因，2026-10-12）**；active 有 p_* 則只清 p_*；log `reject` |
| `staffSetActive` | `{emp_no, active}` | 停用／啟用（同步 users.active）；log `disable`／`enable` |
| `staffUnclaim` | `{emp_no}` | 冒用處理，見 §5 |
| `staffUnlockReset` | `{emp_no}` | reset_fail＝0、reset_locked 空、reset_lock_until 空、reset_lock_count＝0；log `reset_unlock` |
| `staffEdit` | `{emp_no, name?, birthday?, brand?, unit?, dept?, title?, phone?, address?}` | 後台直接改正式欄；改 name 同步 users.name；log `admin_edit`（只記欄位名） |

### 6.4 單位通訊錄（需 token＋`platform.self`）
`myUnit` → 呼叫者 status＝active 且職級達門檻（store 職級 rank≥3 店長；hq 職級 rank≥2 部門主管）才回
同單位（總部單位且有部門時＝同單位同部門）、status＝active 的同仁：`emp_no,name,title,phone`；其他人回「只有店長以上可以看」。
~~**不回生日、地址。**~~ **2026-10-25 Eason 改：** 單位是門市或中央工廠（store 階梯）的主管（店長、區經理、廠長、廚藝總監）
另回 `birthday`（完整日期）、`address`，回應帶 `private:true`；品牌辦公室、總部單位的主管照舊不回（`private:false`）。
前端一人一張卡，空值顯示「—」。測試：org-upgrade.mock 第 18 節、me-unit-front、e2e t12 ⑤。
區經理以上第一期也只看自己單位（跨店範圍第二期定）。

### 6.8 認領後主管審核（2026-10-12，需 token）
**誰能審**：
- 單位主管：自己 status＝active、職級達 §6.4 門檻（store rank≥3 店長；hq rank≥2 部門主管），審「填的單位（p_unit）＝自己的單位」的申請；
  總部單位且自己有部門時，還要「填的部門（p_dept）＝自己的部門」。判斷抽成共用函式 `stfManagerScope_`（§6.4 單位通訊錄也用它）。
- 有 `platform.staff` 的人（人資、admin）：任何單位都可審（單位還沒有主管帳號時的備援）。
- 不能審自己。只審 status＝pending（認領待審）；已開通同仁的組織欄變更（active＋p_*）仍只由人資在同仁名單確認。

| action | payload | 回傳／效果 |
|---|---|---|
| `unitPending` | — | `{people:[{emp_no,name,brand,unit,dept,title,*_name,birthday,phone,address,claimed_at}], scope_name, all_units}`（組織欄是他填的 p_* 值；主管要核對本人，個資給齊）。沒資格回「只有單位主管可以審核」。讀取，不上鎖，在 dryrun 白名單 |
| `unitApprove` | `{emp_no}` | 效果同 staffConfirm（p_* 搬正式欄、status active、可登入）；log `confirm`，by＝審核者 users.id，detail＝`unit_review` |
| `unitReject` | `{emp_no, reason}` | reason 必填、200 字內；效果＝撤回認領（清密碼、token_after、清個資與 p_*、status unclaimed）＋留 reject_reason（後台看得到，同仁看不到，請當面告訴他）；log `reject`，detail＝`unit_review`（原因不進 log） |

錯誤訊息（逐字）：「只有單位主管可以審核」「不能審核自己」「這位同仁不在等待審核」「請填寫退回原因」。

### 6.9 登出（2026-10-12，需 token）
`logout` → 把該帳號 users.token_after 設成現在（只寫第 11 欄那一格），所有裝置上的登入一起失效。token 已失效回原錯誤。
前端 `auth.logout()` 先送 logout（最多等 5 秒；失敗、斷網、逾時都照樣）再清本機，shell 等它回來才整頁重載。
dryrun 模式也真的送（登出不是資料寫入；`platform/dryrun.js` 白名單放行 logout）。

### 6.5 欄位驗證（前後端同一套，後端為準）
- password：8 字元以上；不得等於 emp_no（不分大小寫）。
- brand／unit／dept／title：必須是 org 中 active 的代號；unit.parent＝brand；title.parent＝unit.ladder；
  unit 是 hq 且該 unit 有 active dept 時 dept 必填且 dept.parent＝unit，否則 dept 必須空。
- birthday：`YYYY-MM-DD`，真實存在的日期，年齡 15～80 歲。
- phone：`^09[0-9]{8}$`（前端自動去掉空白與連字號）。
- address：trim 後 5～100 字。
- 錯誤一律回「哪一欄、怎麼改」的白話訊息。

### 6.6 忘記密碼（v2：改成時間鎖，Fable 第 11 條）
1. emp_no 轉大寫找 staff 列；不存在、unclaimed、disabled → 一律回「資料不符，請確認或找後台」（不透露哪一種）。
2. reset_locked＝TRUE → 回「忘記密碼已鎖住，請找後台解鎖」。reset_lock_until 未到 → 回「錯太多次，請 1 小時後再試，或找後台」。
3. birthday、phone 都相符 → 寫新 hash（新 salt）、token_after＝現在、清 reset_fail 與時間鎖、清該帳號登入鎖定，log `reset_ok`＋login_log。
4. 不符 → reset_fail+1、log `reset_fail`；達 5 → reset_fail 歸零、reset_lock_until＝現在+1 小時、reset_lock_count+1、log `reset_timelock`；
   24 小時內第 3 次時間鎖 → reset_locked＝TRUE、log `reset_locked`。回「資料不符」，**不回剩餘次數**。
5. 新密碼規則同 §6.5。
- 為什麼改：requirements 原寫「連錯 5 次就鎖、要後台解」，但編號是連號，任何人對 DZY001～113 各打 5 次就能把全公司忘記密碼鎖死。改成先鎖 1 小時、一天被鎖 3 次才要後台解。
- 已知風險（requirements 已告知 Eason）：知道生日＋手機的人可重設。緩解＝時間鎖、全程留紀錄、重設後其他裝置登入失效、通知機器人讀 `reset_ok` 通知本人（機器人另案）。

### 6.7 寫入鎖
所有會寫試算表的新 action（claimSubmit、forgotReset、saveMyProfile、staff* 寫入類、2026-10-12 的 logout／unitApprove／unitReject）加進 Code.gs 的 MUTATING_ACTIONS，走既有 LockService。unitPending 是讀取，不上鎖。

## 7. 前端
### 7.1 登入頁（`platform/views/login.js`）
帳號欄提示「DZY 編號」（2026-10-12 Eason：不顯示「系統帳號」字樣；BOSS 等系統帳號照常可登入）；表單下方加兩個連結：「第一次使用」「忘記密碼」→ 由 login.js 自己切畫面（同一個登入背景版型）。
用 hash `#/claim`、`#/forgot`：login.js 開機時讀 hash 決定顯示哪個畫面；shell 把 `claim`、`forgot` 列為保留字（不當模組 id、manifest-check 也擋這兩個 id）。認領成功後先清掉 hash 再呼叫 onSuccess，避免登入後 route() 把 `claim` 當模組找不到而跳「沒有權限」。

### 7.2 第一次使用（`platform/views/claim.js`）三步
1. 輸入全名 → `claimLookup`。
2. 顯示「你的編號是 DZY0xx」＋設密碼兩次＋個人資料表單（品牌→單位→部門→職稱連動）。
3. 送出 `claimSubmit` → **不登入**（2026-10-12），畫面顯示「已送出，等你的單位主管審核通過後就能登入」＋編號＋「回登入頁」（帶入編號）。
   審核通過前用這組密碼登入會看到「帳號還在等主管審核」。

### 7.3 忘記密碼（`platform/views/forgot.js`）
編號、生日、手機、新密碼兩次 → `forgotReset` → 成功回登入頁並帶入編號。

### 7.4 模組 `me`（我的資料）
- 分頁 `profile`：顯示狀態（待確認／已退回＋原因／已確認／有變更待確認）、正式值與待確認值並列、可編輯欄位。
- 分頁 `unit`：單位通訊錄（不夠職級時顯示說明，不報錯）。
- 分頁 `review`「待審核」（2026-10-12）：manifest requires `['platform.review','platform.staff']`（任一），沒資格的人看不到；
  列出 unitPending，每人一張卡（填的單位職稱、生日、手機、地址、送出時間）＋「通過」（對話框提醒先核對本人）／「退回」（ctx.ui.dialog 填原因，必填）。
- 「個人資料」改手機時出現「目前的密碼」欄，送 current_password；後端錯誤訊息原樣顯示。
- alerts：單位主管（有 platform.review、沒有 platform.staff）有人待審 → 一列黃「有 N 位同仁等你審核」導到 review；
  人資／admin 不在這裡重複提醒（同仁名單已有「N 位同仁待確認開通」）。rejected／pending 那兩列在新流程下登不進來，實際只剩「改的組織欄等確認」。

### 7.5 模組 `staff`（同仁名單，後台）
- 分頁 `list`：表格（編號、姓名、品牌、單位、職稱、狀態、待確認變更），搜尋、篩選；每列動作依狀態出現。
  個資欄預設收合，點「顯示個資」才展開（防旁人偷看螢幕）。
- 分頁 `import`：貼上姓名（一行一個，照順序）→ 預覽「將建立 DZY001～DZY113」→ 確認才送出。
- alerts：「N 位同仁待確認開通」「N 位同仁有資料變更待確認」。

## 8. 個資與安全
- 姓名名單、個資**不進 repo**（dzy 是 public repo）：名單只經後台「匯入」頁貼上進試算表；測試一律假名。
- 回傳到前端的資料依 §6 各 action 限定欄位；`staffList` 只給 `platform.staff`。
- 試算表本身只有 Eason 帳號可開（沿用平台現況）。
- **平台層沒有 dryrun**（只有稽核模組自己有，Fable 第 2 條）。本案的演練方式＝匯入頁「預覽」（`preview:true`，後端不寫入），確認編號對照正確才按「建立」。

## 8b. 上線前關（Fable 2026-10-11）後的修正
1. users 有第 11 欄後 writeUsersRow_ 只寫前 10 欄（原本人員管理編輯會整個失敗）。
2. 忘記密碼先驗新密碼規則，再比對生日手機（原本可當無聲探測器）。
3. 全公司忘記密碼被鎖的風險：保留後台解鎖，首頁「同仁名單」會顯示被鎖人數。
4. 限流改三桶（查詢／認領／忘記密碼）、固定 10 分鐘窗、被擋不計數。
5. 系統帳號的 resetPassword、setActive 也寫 token_after。
6. 匯入編號同時避開 users 已存在的 DZY 帳號。
7. claimSubmit 先寫 staff 再寫密碼。
9. setupStaff 遇到表頭不一致直接停，不覆寫。
（第 8 條姓名可查是否在名單：規格已接受，不改。）

## 8c. 上線前關（GPT 2026-10-11，與 Fable 互盲）後的處理
- 修：①登入雜湊期間帳號被撤回仍簽 token → 簽發前重讀 salt／hash／active；④沒先開名單就匯入會留孤兒帳號 → 匯入前自動建分頁；
  ⑥（Fable 也挑到）忘記密碼第 3 次鎖改為 24 小時自動到期、後台可提早解；⑨格式不對的請求不計入全域額度；
  ⑫人員管理編輯只寫 B:E 四格，不再整列回寫蓋掉 last_login_at／密碼。
- 舊系統既有、非本案造成，另案：②有 platform.users 者可把自己改成 admin（目前只有 admin 有此權限）；⑤⑦登入鎖定計數非原子、可被他人鎖帳號 15 分鐘；⑪login_log 無上限成長。
- 規格已接受：③知道全名即可搶先認領（防線＝後台電話核對＋撤回認領）；⑧未登入訊息可分辨帳號狀態；⑩查名字的計數非原子。

## 8d. 2026-10-12 上線轉換（認領改主管審核）
- **會被擋的人**：上線當下 staff 分頁 status＝pending 的同仁（舊流程認領完就能登入）。上線後他們手上的登入（token）在下一次呼叫就失效，
  重新登入會看到「帳號還在等主管審核」，要等同單位主管或人資審核通過。status＝rejected 的同仁同樣登不進去（「帳號資料被退回，請找人資重新開通」），
  人資在同仁名單對他按「撤回認領」，他就能重新「第一次使用」。
- **不受影響**：status＝active（含有待確認變更的）、系統帳號（BOSS、會計等）。
- **上線前要做**：在同仁名單篩「待確認」，看有幾位；先由人資逐一「確認」（舊流程本來就是人資確認），或通知各店長上線後到「我的資料 → 待審核」審。
  單位還沒有已開通的店長／部門主管時，只有人資（platform.staff）能審。
- 部署照 dzy-admin skill：改 `apps-script/platform/*.gs` → 測試 → `sync-gas.sh dzy-platform` → mini 重啟；前端與後端要**同時**上（前端先上的話，認領後畫面停在「已送出」但舊後端其實發了 token——無害；後端先上的話，舊前端認領後會顯示「伺服器回應格式錯誤」但資料已送出）。

## 9. 不做（第一期）
職稱→系統權限、表單簽核、通知推播、匯出、改打卡／佈告欄／薪資名單、跨店主管範圍、四碼編號。
