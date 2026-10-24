# 區域（督導負責區）規格 v0.1（2026-10-25，待 Eason 確認第 0 節）

> 起因：品牌辦公室的區督導各負責一個區域的門市，但管理系統沒有「區域」這一層，督導在單位通訊錄只看得到辦公室同事、看不到自己區的門市同仁；
> 考勤申請與店長認領審核則是「整個品牌的督導都能審」，不分區。
> 本檔是新功能規格，與 `docs/org/spec.md` 並列（org 那份管單位／職稱／部門，本檔只管區域）。文件不寫真名，例子一律用代稱。

## 0. 還要 Eason 確認的事（實作前）
| # | 問題 | 我的推薦（目前規格照這個寫） |
|---|---|---|
| Q1 | 總監（odir）在通訊錄看得到整個品牌的門市同仁嗎？ | **看得到全品牌**（他本來就能審全品牌，看不到人反而怪）。 |
| Q2 | 店長的「人事異動單」（離職／調職／調薪）直屬主管，也跟著改成只有該區督導（＋總監）？ | **跟著改**：它和認領審核用同一套「誰是上一層」判斷，分開反而要多一套規則。 |
| Q3 | 一位督導可以同時負責好幾區嗎？ | **可以**（例：督導請長假，暫時把他的區併給另一位）。一區仍只有一位督導。 |
| Q4 | 某區暫時沒有督導（離職、調走）時，那區的店長申請／認領給誰審？ | **只有該品牌總監和人資**，首頁對人資亮「某區沒有督導」提醒。 |

## 1. Eason 已拍板（2026-10-25 問卷）
1. **人資設定、一區一督導**：人資（platform.staff）或管理員在管理系統設定「區域名稱＋包含哪幾家門市＋負責督導」。一家店只屬於一個區域；每區只有一位督導。
2. **督導在區內＝看通訊錄＋審核**：看得到區內門市同仁的通訊錄（欄位與店長看自己店相同）；認領審核、考勤申請只收自己區。設離職、調店、改資料仍只有人資。
3. **審核全部改成該區**：沒劃進任何區域的門市，區督導**審不到**，只剩總監與人資（以及同店區經理，照舊）。所以上線切換前每家店都要先劃好區（見第 7 節切換檢查）。
4. **連帶套用**：首頁提醒只算自己區、營運稽核（含盤點抽查）只看自己區。
5. **這次不做**：公告專區發給某一區（佈告欄是另一套系統，另案）。

## 2. 名詞
- **區域**：同一品牌底下幾家門市的集合，掛一位**區督導**（職稱 osv、單位＝該品牌的品牌辦公室）。
- 只有**門市**（ladder store、單位 parent＝品牌、不含中央工廠 ck）可以劃區；品牌辦公室本身、總部、央廚不劃區。
- 「區督導」以下簡稱督導；「總監」＝品牌辦公室 odir。

## 3. 資料
新分頁 `regions`（平台試算表；setup 時自動建，只補不覆蓋，表頭不一致就停）：

| 欄 | 說明 |
|---|---|
| code | `r-` 開頭英數，系統產生（例 `r-mala-1`），建立後不改 |
| name | 顯示名稱，最多 12 字（例「中區」）；同品牌內不可重名 |
| brand | 品牌代碼（org 分頁 brand 列，例 mala） |
| stores | 門市單位代碼，逗號分隔（例 `mala-ms,mala-nc`） |
| supervisor | 督導的 emp_no（DZY###）；可空＝這區暫時沒有督導 |
| active | TRUE／FALSE（停用不刪） |
| updated_at／updated_by | 最後修改 |

**檢查（全部在後端，存檔時擋）**
- 每家門市最多出現在一個 active 區域；門市必須是 active、ladder store、parent＝該區 brand、不是 ck。
- supervisor 若有填：必須是 active 同仁、職稱 osv、單位＝**該品牌**的品牌辦公室。一位督導可以出現在多個區域（Q3）。
- 存檔要帶 `expected_ver`（樂觀鎖，同 apvThresholdSave 的做法），避免兩位人資同時改互蓋。
- 每次新增／修改／停用寫 `staff_log`（event `region_save`，detail 只寫代碼與欄位差異，不寫姓名）。

**事後失效（不擋，標旗標）**：督導離職／停用／調職稱／調到別的品牌、門市停用 → 那區照樣存在，但讀取時視同「沒有督導」或「少一家店」，
同仁名單「需處理」篩選與人資首頁提醒顯示 `region_no_supervisor`／`region_store_inactive`；門市沒劃區顯示 `store_no_region`（只在第 7 節開關打開後提醒）。

純函式 `regionIndex_(rows, org, staffRows)` → `{ byStore: {unit→regionCode}, byRegion: {code→{brand, stores[], supervisorEmp|''}}, bySupervisor: {emp→[code…]} }`，
已失效的督導在這裡就被清成 ''。其他地方一律只問這個索引，不自己讀 regions 分頁。

## 4. 督導看得到什麼（單位通訊錄）
- `handleMyUnit_` 回傳多一段 `regions: [{code, name, stores: [{unit, unit_name, people: [...] }]}]`：督導本人負責的區域、每家店的 active 同仁。
  people 欄位**與店長看自己店完全相同**（目前姓名、職稱、手機；unit-directory-fields 對話正在加生日、地址，合併後照它的欄位）。
- 原本的辦公室同事那段（`unit_name`／`people`）不變。
- 總監（Q1 推薦）：`regions` 改成全品牌所有門市（不分區、依店分組，區名有劃就顯示）。
- 前端 `modules/me/views/unit.js`：辦公室同事下面接「我的區域」，每家店一個可收合的區塊；人數多時預設收合。
- **不改 `stfManagerScope_`**：它還被打卡（StaffClock.gs 店長路徑）共用，區域另寫 `regionDirectoryScope_`，避免打卡權限被放大。

## 5. 審核改成只給該區
只改「品牌辦公室區督導」這一種審核者；總監、同店區經理、人資、admin 都不變。

| 被審的人／事 | 現在 | 改成 |
|---|---|---|
| 門市店長的認領審核（stfReviewNeed_ kind brand） | 該品牌辦公室 osv、odir；或同店區經理 | osv **只限負責該店的區**；odir、同店區經理照舊 |
| 門市區經理的認領審核 | 該品牌辦公室 osv、odir | osv 只限該區；odir 照舊 |
| 門市店長的加班／請假／忘刷（attApproverOf_ req，`head` 分支的辦公室路徑 `STORE_REQ_HEAD_BY_OFFICE`） | 品牌所有 osv；或同店區經理 | osv 只限該區；同店區經理照舊 |
| 門市區經理的加班／請假／忘刷（`brand_office` 分支，`STORE_REQ_AM_OFFICE_TITLES`） | 品牌所有 osv、odir | osv 只限該區；odir 照舊 |
| 店長的人事異動單直屬主管（ApprovalRoute.gs，走 stfReviewNeed_） | 品牌 osv、odir；或同店區經理 | 跟認領同一套（Q2 推薦） |
| 核定工時、品牌辦公室同仁、總部、央廚 | — | **不動**（督導審辦公室同仁走 kind ops／office，與區域無關） |

**做法**：在判斷「品牌辦公室這個人能不能管這家店」的地方加同一道檢查 `regionOfficeCovers_(approverEmp, approverTitle, storeUnit, ctx)`（ctx＝{on, idx}，由呼叫端讀開關與 regionIndex_ 後傳入，判斷函式維持純函式、node 好測）：
- 職稱 osv（以及已停用的 oam，有人還掛著時同 osv 處理＝限區，往拒絕方向）→ 只有 `idx.byStore[storeUnit]` 的督導＝本人才 true；店沒劃區或區沒督導 → false。
- odir → true（照舊全品牌）。
- 開關關著（第 7 節）→ 一律 true（＝現在的行為）。

接點（三處，都要補「被審的是哪家店」）：
1. 認領／人事異動：`Staff.gs stfReviewNeed_` 門市 rank≥3 分支（kind brand）把 `unit: unitCode` 帶進 need；`stfReviewScope_` 回傳多帶 `emp`、`title`（現在只有 kinds／unit／brand／rank…）；`stfScopeMeetsKind_` kind brand 時多問 regionOfficeCovers_。`stfScopeMeets_` 多收一個 ctx 參數，`stfCanReview_`、`ApprovalRoute.gs apvDirectMembers_` 跟著傳。
2. 考勤店長申請：`StoreOps.gs attApproverOf_` 的 `head` 分支辦公室那條（need 已有 unit）。
3. 考勤區經理申請：`attApproverOf_` 的 `brand_office` 分支；`attNeedOf_` 對 am 回的 `{kind:'brand_office'}` 目前**沒帶 unit**，要補 `unit: unit`。
- 不受影響：`ApprovalRoute.gs apvRoleMembers_` 的 head（辦公室 rank 2）只用在「送件人本身在品牌辦公室」的請購請款，不涉及門市，不改。
`stfReviewScope_` 仍只看職稱決定有沒有資格（督導就算目前沒有區，也保留「待審核」分頁，只是清單是空的；登入時的衍生權限 platform.review 不變）。

**已經送出、還沒審的單**：不搬資料。開關打開那一刻起，清單是即時算的——別區督導的清單裡就消失，該區督導（或總監）看得到。不會有單子沒人能審（總監與人資永遠在）。
例外：該品牌沒有在職總監、而那家店又沒劃區／區沒督導 → 只剩人資；第 7 節切換檢查會列出這種店。

## 6. 連帶：首頁提醒、營運稽核
**首頁提醒**：「我的資料 → 待審核」的數字（unitPending）與考勤管理的待審數字（attAlerts，營運系統用 ident 的 `att.req_people` 算）都是從第 5 節的名單算出來的，
**照第 5 節改完就自動只算自己區**，不另外寫。驗收要實測：督導 A 首頁只看到自己區店長的待審數。人資另加兩種提醒（第 3 節旗標），放在同仁名單模組的 alerts()。

**營運稽核／盤點抽查**：區督導目前靠 `audit.read.brand`（Perms.gs 預設規則第 39 行）看整個品牌的店。改成：
- `permCompute_` 的稽核範圍：有 `audit.read.brand` 且**職稱 osv** → 只回他負責區域的門市（`input.regionStores`，由呼叫端用 regionIndex_ 算好傳進去，permCompute_ 維持純函式）；沒有區域 → `[]`（空清單，畫面顯示「目前沒有負責的門市」）。
- odir 或其他人用 `audit.read.brand`（含個別例外）→ 照舊全品牌。
- 開關關著 → 照舊全品牌。
- 前端與 mini 的稽核裁切（filterAuditData_／proxy-hook filterResponse）已經吃陣列，**不用改**。權限設定頁的說明文字「稽核：自己品牌的店」改成「稽核：自己品牌的店（區督導只看自己區）」。

## 7. 開關與切換（避免上線瞬間督導全部審不到）
- Script Property `REGIONS_ON`，只有值恰好是 `'1'` 才算開（同 PERMS_ON 寫法）。**關著＝第 4 節通訊錄照樣生效**（純新增、沒有風險），第 5、6 節維持現在的全品牌行為。
- 區域設定頁上方放「切換檢查」（人資、admin 都看得到；只有 role admin 能按「開始依區域審核」）：
  1. 沒劃進任何區域的 active 門市（按品牌列）
  2. 沒有督導、或督導已失效的區域
  3. 品牌沒有在職總監、且有第 1、2 項的店（＝打開後店長申請只剩人資能審）
  4. 目前還沒審的店長／區經理申請與認領，打開後會從哪些督導的清單移走（只列人數與店名）
  第 1、2 項有任何一筆時，按鈕旁顯示紅字警告但**不擋**（Eason 可能刻意先開一個品牌）。
- 「停止依區域審核」＝刪掉屬性，立即回到全品牌；兩個動作都寫 staff_log（`regions_on`／`regions_off`）。
- 第 4 節通訊錄不受開關影響。

## 8. 設定畫面（人資部門 → 同仁名單 → 新分頁「區域」）
- 權限：看＝platform.staff；改＝platform.staff；開關＝role admin。
- 依品牌分三塊（墨竹亭、麻的小辛辣、一悟燒肉）。每區一張卡：區名、督導（下拉只列該品牌在職 osv）、門市（勾選，已被別區用的顯示「已在 ○○區」不能勾）。
- 卡片下方「尚未劃區的門市」一行，方便一眼看出漏了哪家。
- 存檔前 preview：列出這次會讓哪些督導多看到／少看到哪幾家店。
- 用 `?dryrun=1` 試用時存檔被攔下（新 action 進 `platform/dryrun.js` 的 WRITE；讀取 action 進 READ_ACTIONS）。

## 9. 後端 action（新增）
| action | 權限 | 說明 |
|---|---|---|
| `regionList` | platform.staff | 回所有區域＋索引＋旗標＋ver（讀；進 dryrun READ_ACTIONS、minikit app.json readActions） |
| `regionSave` | platform.staff | 新增／修改／停用一區；`{region, expected_ver, preview?}` |
| `regionCheck` | platform.staff | 第 7 節切換檢查（讀） |
| `regionSwitch` | role admin | `{on: true|false}` 開關 REGIONS_ON |
新 .gs 建議 `Regions.gs`（純函式 regionIndex_／regionOfficeCovers_ 放這裡，方便 node 測試），要列進 minikit `apps/dzy-platform/app.json` 的 gas／gasSource。
`regionSave`、`regionSwitch` 不寫外部系統，不用進 `jobs.js TRIGGER_ACTIONS`。

## 10. 會撞到的檔案（實作前看）
| 檔案 | 誰也在改 | 處理 |
|---|---|---|
| `apps-script/platform/Staff.gs handleMyUnit_` | unit-directory-fields 對話（加生日、地址） | **等它併進 main 後 rebase 再做第 4 節**；我們只在回傳加 `regions` 一段，人員欄位沿用它的 |
| `modules/me/views/unit.js` | 同上 | 同上 |
| `apps-script/platform/StoreOps.gs attApproverOf_` | 排班搬家（schedule-hr）會動 StoreOps 相關身分工具 | 只加一行判斷；動手前 `git log origin/main -- StoreOps.gs` 看有沒有新提交 |
| `apps-script/platform/Perms.gs permCompute_` | 財務四模組（pnl／purchase／transfer／cashbook）各加權限碼 | 只改稽核範圍那段；權限碼清單不動 |
| `modules/staff/`（新分頁） | 無已知 | — |
| `platform/dryrun.js`、`Auth.gs`（若新增代轉讀清單） | 財務模組都加過自己的名字 | 只追加 |

## 11. 測試與驗收
- node：`test/regions.test.mjs`（regionIndex_ 各種失效情況、存檔檢查、regionOfficeCovers_ 開關開／關）；
  `staff.mock`／`store-att*`／`perms*.mock` 補「兩區兩督導」案例：督導 A 審得到 A 區店長、審不到 B 區；總監兩區都審得到；沒劃區的店督導審不到、總監審得到；開關關時全部照舊。
- 稽核：A 區督導的 auditScope＝A 區門市；總監＝全品牌；開關關＝全品牌。
- 首頁：督導 A 的待審數只含 A 區（unitPending、attAlerts 各一案）。
- e2e：區域設定頁新增一區、勾店、選督導、存檔；督導登入看「我的區域」。加分頁會影響 e2e 裡寫死的分頁數，要跟著改。
- 上線前在真瀏覽器用假資料點一次（skill 坑：跨層接縫）。

## 12. 部署順序
1. 後端（REGIONS_ON 不設＝關）：`sync-gas.sh dzy-platform --i-know` → minikit app.json 加 Regions.gs → commit push → mini pull、照 `~/dzy-minikit/START.txt` 重啟。此時只多了通訊錄能力與設定 action，審核行為零改變。
2. 前端 push（設定頁、通訊錄「我的區域」）。
3. 人資在「區域」分頁劃好三個品牌的區與督導。
4. admin 看切換檢查 → 按「開始依區域審核」。
5. 各找一位督導、一位總監實測待審清單與稽核；有問題按「停止依區域審核」立即退回。

## 13. 不做／留給實作者
- 不做：公告依區發送、區域業績報表、督導改同仁資料、區域歷史（誰哪天管哪區）。
- 留給實作者：region code 產生規則細節、卡片排版、收合預設、staff_log detail 格式。
